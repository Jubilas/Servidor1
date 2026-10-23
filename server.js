import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = __dirname;
const STATE_FILE = path.join(PUBLIC_DIR, "state.json");
// Senha do painel dev: fica no arquivo senha_dev.txt, ao lado do server.js
// (ignorado pelo git). Para trocar a senha: edite o arquivo e reinicie o
// servidor (ex.: pm2 restart). Sem o arquivo, o painel /dev fica bloqueado.
const DEV_PASSWORD_FILE = path.join(PUBLIC_DIR, "senha_dev.txt");

// ==========================================
// AUTENTICAÇÃO DO PAINEL DEV (/dev)
// ==========================================
function loadDevPassword() {
  try {
    // Usa a primeira linha não vazia do arquivo como senha
    const firstLine = fs.readFileSync(DEV_PASSWORD_FILE, "utf-8")
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line.length > 0);
    return firstLine || "";
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[AUTH] Não foi possível ler senha_dev.txt:", err.message);
    }
    return "";
  }
}

// Lida uma vez na inicialização: alterou o arquivo, reinicie o servidor
const DEV_PASSWORD = loadDevPassword();

// Comparação em tempo constante (o tempo de resposta não revela partes da senha)
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkPassword(candidate) {
  const expected = DEV_PASSWORD;
  if (!expected || !candidate) return false; // painel bloqueado ou senha ausente
  return safeEqual(String(candidate).trim(), expected);
}

function getBearerToken(req) {
  const authHeader = req.headers["authorization"] || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
}

// Sessões do painel dev: depois do login o navegador guarda só um token
// aleatório que expira (não a senha). Ficam em memória: reiniciar o
// servidor desconecta todo mundo.
const DEV_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEV_SESSION_MAX = 50;
const devSessions = new Map(); // token -> expiresAt

function createDevSession() {
  if (devSessions.size >= DEV_SESSION_MAX) {
    // Descarta a sessão mais antiga (Map mantém a ordem de inserção)
    devSessions.delete(devSessions.keys().next().value);
  }
  const token = crypto.randomBytes(32).toString("hex");
  devSessions.set(token, Date.now() + DEV_SESSION_TTL_MS);
  return token;
}

function isValidDevSession(token) {
  const expiresAt = token ? devSessions.get(token) : undefined;
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    devSessions.delete(token);
    return false;
  }
  return true;
}

// Aceita um token de sessão ou a própria senha (scripts e testes)
function validateAuth(req, body) {
  const bearer = getBearerToken(req);
  if (isValidDevSession(bearer)) return true;
  return checkPassword(bearer || (body && body.password));
}

// ==========================================
// SEGURANÇA: IP DO CLIENTE, RATE LIMIT E SANITIZAÇÃO
// ==========================================
// Atrás do Cloudflare Tunnel o IP real vem em CF-Connecting-IP. Só confiamos
// nesse cabeçalho quando a conexão vem do próprio servidor (o cloudflared):
// quem acessa direto pela rede local poderia inventá-lo a cada tentativa e
// escapar do limite de senhas. Sem o túnel usamos o IP do socket.
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function getClientIp(req) {
  const socketIp = req.socket.remoteAddress || "desconhecido";
  const cfIp = req.headers["cf-connecting-ip"];
  const fromTunnel = LOOPBACK_ADDRESSES.has(socketIp);
  const ip = (fromTunnel && typeof cfIp === "string" && cfIp) || socketIp;
  return ip.replace(/^::ffff:/, "");
}

// Contadores em memória por chave (ex.: "book:1.2.3.4"), em janela fixa
const rateBuckets = new Map(); // key -> { count, resetAt }

function hitRateLimit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count > limit;
}

function isRateLimited(key, limit) {
  const bucket = rateBuckets.get(key);
  return Boolean(bucket && bucket.resetAt > Date.now() && bucket.count >= limit);
}

function retryAfterSeconds(key) {
  const bucket = rateBuckets.get(key);
  return bucket ? Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000)) : 60;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
  for (const [token, expiresAt] of devSessions) {
    if (expiresAt <= now) devSessions.delete(token);
  }
}, 60000).unref();

// Senha errada: 5 tentativas a cada 15 minutos por IP
const AUTH_MAX_FAILURES = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
// Agendamento público: 5 reservas a cada 10 minutos por IP
const BOOK_MAX_PER_WINDOW = 5;
const BOOK_WINDOW_MS = 10 * 60 * 1000;
// Conexões SSE simultâneas
const SSE_MAX_PER_IP = 20;
const SSE_MAX_TOTAL = 300;
// Quadra funciona das 07:00 às 22:00 (último horário reservável: 21:00)
const COURT_FIRST_HOUR = 7;
const COURT_LAST_HOUR = 21;
const SCREEN_TYPES = new Set(["totem", "mobile", "dev"]);
const COURT_STATUSES = new Set(["livre", "em_uso", "manutencao"]);
// Intervalo mínimo entre dois toques do sino público
const BELL_COOLDOWN_SECONDS = 40;

// Texto livre vindo de fora: remove caracteres de controle e < > (impede HTML),
// junta espaços e limita o tamanho. As páginas também escapam ao renderizar.
function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Data e hora no fuso da praça (o servidor Ubuntu pode estar em UTC)
const COURT_TIME_ZONE = "America/Sao_Paulo";
const courtClockFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: COURT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23"
});

function getCourtClock() {
  const parts = Object.fromEntries(courtClockFormat.formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

// Aceita "16:00" ou "16:00 às 17:00"; devolve a hora cheia (7..21) ou null
function parseCourtHour(rawSlot) {
  const match = String(rawSlot ?? "").trim().match(/^(\d{1,2}):00\b/);
  if (!match) return null;
  const hour = Number(match[1]);
  return hour >= COURT_FIRST_HOUR && hour <= COURT_LAST_HOUR ? hour : null;
}

function sendJson(res, status, data, extraHeaders = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-cache",
    ...extraHeaders
  });
  res.end(payload);
}

// Bloqueia o IP depois de várias senhas erradas (força bruta)
function authLockedResponse(res, ip) {
  const key = `auth-fail:${ip}`;
  if (!isRateLimited(key, AUTH_MAX_FAILURES)) return false;
  const wait = retryAfterSeconds(key);
  sendJson(res, 429, {
    success: false,
    error: `Muitas tentativas de senha. Tente novamente em ${Math.ceil(wait / 60)} minuto(s).`
  }, { "Retry-After": String(wait) });
  return true;
}

function registerAuthFailure(ip) {
  hitRateLimit(`auth-fail:${ip}`, AUTH_MAX_FAILURES, AUTH_WINDOW_MS);
  console.warn(`[AUTH] Senha incorreta vinda de ${ip}`);
}

// Arquivos que o site pode servir. Todo o resto (senha_dev.txt, .git/,
// server.js, state.json, testes...) responde 404.
const PUBLIC_FILES = new Set([
  "index.html",
  "agendar.html",
  "dev.html",
  "studio.html",
  "favicon.svg",
  "icons.svg",
  "logo.jpg",
  "praca_antiga.jpg"
]);
const PUBLIC_ASSET_PATTERN = /^assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:jpg|jpeg|png|webp|gif|svg|ico|css|js|woff2?|ttf|otf)$/;

function isPublicFile(cleanPath) {
  return PUBLIC_FILES.has(cleanPath) || PUBLIC_ASSET_PATTERN.test(cleanPath);
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    // Bibliotecas (Tailwind, three.js, qrcode) ficam em assets/: nada de scripts de terceiros
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join("; ")
};

// ==========================================
// ESTADO GLOBAL COMPARTILHADO DA PRAÇA
// ==========================================
const DEFAULT_STATE = {
  weather: "sun", // "sun" | "rain" | "wind" | "night"
  sakuraPhase: 3, // 1 (Dormência), 2 (Botões), 3 (Florada Plena), 4 (Folhagem)
  windStrength: 1.0,
  court: {
    status: "em_uso", // "livre" | "em_uso" | "manutencao"
    activity: "Basquete 3x3 Juvenil",
    remainingMinutes: 22,
    nextSlot: "15:00 às 16:00 (Treino de Vôlei)"
  },
  courtBookings: [
    {
      id: "book-1",
      slot: "15:00",
      timeLabel: "15:00 às 16:00",
      name: "Turma do Vôlei",
      sport: "Vôlei",
      createdAt: 1791607000000
    },
    {
      id: "book-2",
      slot: "18:00",
      timeLabel: "18:00 às 19:00",
      name: "Amigos do Basquete",
      sport: "Basquete",
      createdAt: 1791607500000
    },
    {
      id: "book-3",
      slot: "19:00",
      timeLabel: "19:00 às 20:00",
      name: "Liga Noturna Futsal",
      sport: "Futsal",
      createdAt: 1791607800000
    }
  ],
  weeklyActivities: [
    {
      id: "act-1",
      icon: "zen",
      dayTime: "SÁBADO • 08:00",
      title: "Yoga & Meditação Matinal",
      desc: "Deck dos Mestres. Traga seu tapete de yoga.",
      tagColor: "sakura"
    },
    {
      id: "act-2",
      icon: "organico",
      dayTime: "SÁBADO • 09:30",
      title: "Feirinha Agroecológica",
      desc: "Alameda das Cerejeiras. Frutas e hortaliças orgânicas.",
      tagColor: "emerald"
    },
    {
      id: "act-3",
      icon: "esporte",
      dayTime: "DOMINGO • 15:30",
      title: "Clínica Aberta de Basquete",
      desc: "Quadra Poliesportiva. Todas as idades.",
      tagColor: "cyan"
    }
  ],
  // Dia (fuso da praça) a que as reservas pertencem
  bookingsDate: getCourtClock().date,
  bell: {
    enabled: true,
    cooldownSeconds: BELL_COOLDOWN_SECONDS,
    lastRung: 0
  },
  lastBroadcast: Date.now()
};

let globalState = { ...DEFAULT_STATE };

// Carrega estado persistido do disco se existir
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      globalState = {
        ...DEFAULT_STATE,
        ...data,
        court: { ...DEFAULT_STATE.court, ...(data.court || {}) },
        courtBookings: Array.isArray(data.courtBookings) ? data.courtBookings : DEFAULT_STATE.courtBookings,
        weeklyActivities: Array.isArray(data.weeklyActivities) ? data.weeklyActivities : DEFAULT_STATE.weeklyActivities,
        // O intervalo do sino vem sempre do código (ignora o valor salvo)
        bell: { ...DEFAULT_STATE.bell, ...(data.bell || {}), cooldownSeconds: BELL_COOLDOWN_SECONDS }
      };
      console.log("[STATE] Estado global carregado com sucesso de state.json");
    }
  } catch (err) {
    console.error("[STATE] Erro ao carregar state.json, usando padrão:", err.message);
  }
}

// Salva estado atualizado no disco
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(globalState, null, 2), "utf-8");
  } catch (err) {
    console.error("[STATE] Erro ao salvar state.json:", err.message);
  }
}

loadState();

// As reservas valem só para o dia: na virada a grade volta a ficar livre,
// então reservas falsas ou esquecidas não bloqueiam a quadra para sempre.
function resetBookingsIfNewDay() {
  const { date } = getCourtClock();
  if (globalState.bookingsDate === date) return;
  const hadBookings = globalState.courtBookings.length > 0;
  globalState.courtBookings = [];
  globalState.bookingsDate = date;
  saveState();
  console.log(`[STATE] Novo dia (${date}): reservas da quadra zeradas`);
  if (hadBookings) {
    broadcastEvent("court_booking_update", { bookings: [], court: globalState.court });
  }
}

// ==========================================
// HUB DE TRANSMISSÃO EM TEMPO REAL (SSE) & TELEMETRIA
// ==========================================
const sseClients = new Map(); // res -> { id, name, type, ip, connectedAt }

// O IP fica só no servidor (limite de conexões); a lista pública não o expõe
function getActiveScreensList() {
  const now = Date.now();
  return Array.from(sseClients.values()).map(c => ({
    id: c.id,
    name: c.name,
    type: c.type,
    connectedAt: c.connectedAt,
    onlineSeconds: Math.floor((now - c.connectedAt) / 1000)
  }));
}

function broadcastEvent(eventType, data) {
  globalState.lastBroadcast = Date.now();
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients.keys()) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function broadcastScreenCount() {
  const screens = getActiveScreensList();
  broadcastEvent("screens_count", {
    activeScreens: screens.length,
    screens: screens
  });
}

// Heartbeat a cada 25 segundos para manter proxies/túneis ativos
setInterval(() => {
  for (const client of sseClients.keys()) {
    try {
      client.write(": keepalive\n\n");
    } catch {
      sseClients.delete(client);
    }
  }
}, 25000);

// Confere a virada do dia na inicialização e a cada minuto (avisa as telas)
resetBookingsIfNewDay();
setInterval(resetBookingsIfNewDay, 60000).unref();

// ==========================================
// MIME TYPES & COMPRESSÃO
// ==========================================
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

const COMPRESSIBLE_TYPES = new Set([
  "text/html; charset=utf-8",
  "text/css; charset=utf-8",
  "application/javascript; charset=utf-8",
  "application/json; charset=utf-8",
  "image/svg+xml",
  "text/plain; charset=utf-8",
  "application/xml; charset=utf-8"
]);

function getNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const net of iface) {
      if (net.family === "IPv4" && !net.internal) addresses.push(net.address);
    }
  }
  return addresses;
}

// Helper para ler corpo de requisições POST em JSON
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 64) {
        req.destroy();
        reject(new Error("Requisição grande demais."));
      }
    });
    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new Error("JSON inválido."));
      }
    });
    req.on("error", reject);
  });
}

// ==========================================
// SERVIDOR HTTP & ROTAS
// ==========================================
const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const method = req.method || "GET";
  const rawUrl = req.url || "/";
  const clientIp = getClientIp(req);

  // Cabeçalhos de segurança em todas as respostas. Sem CORS: as páginas são
  // servidas pelo mesmo domínio, então outros sites não podem chamar a API.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }

  let pathname;
  try {
    pathname = decodeURIComponent(rawUrl.split("?")[0]);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  if (pathname.startsWith("/api/")) {
    resetBookingsIfNewDay();
  }

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. ENDPOINT DE SAÚDE
  if (pathname === "/api/health" || pathname === "/healthz") {
    const payload = JSON.stringify({
      status: "ok",
      service: "praca-conecta-realtime-server",
      uptimeSeconds: Math.floor(process.uptime()),
      activeScreens: sseClients.size,
      timestamp: new Date().toISOString()
    });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-cache"
    });
    res.end(payload);
    return;
  }

  // 2. ENDPOINT DE ESTADO GLOBAL (GET /api/state)
  if (pathname === "/api/state") {
    const payload = JSON.stringify({
      ...globalState,
      activeScreens: sseClients.size,
      screens: getActiveScreensList()
    });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-cache"
    });
    res.end(payload);
    return;
  }

  // 3. STREAMING EM TEMPO REAL (GET /api/events) - Server-Sent Events
  if (pathname === "/api/events") {
    // Limita conexões abertas por IP e no total (evita esgotar o servidor)
    let connectionsFromIp = 0;
    for (const c of sseClients.values()) {
      if (c.ip === clientIp) connectionsFromIp++;
    }
    if (connectionsFromIp >= SSE_MAX_PER_IP || sseClients.size >= SSE_MAX_TOTAL) {
      sendJson(res, 429, { error: "Muitas conexões abertas. Tente novamente mais tarde." }, { "Retry-After": "30" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const parsedUrl = new URL(rawUrl, "http://localhost");
    const requestedType = parsedUrl.searchParams.get("screenType");
    const screenType = SCREEN_TYPES.has(requestedType) ? requestedType : "totem";
    let screenId = cleanText(parsedUrl.searchParams.get("screenId"), 40);
    let screenName = cleanText(parsedUrl.searchParams.get("screenName"), 40);

    if (!screenId) {
      const randNum = Math.floor(1000 + Math.random() * 9000);
      screenId = screenType === "dev" ? `Dev Admin #${randNum}` : `Totem #${randNum}`;
    }
    if (!screenName) {
      screenName = screenId;
    }

    const clientMeta = {
      id: screenId,
      name: screenName,
      type: screenType,
      ip: clientIp,
      connectedAt: Date.now()
    };

    sseClients.set(res, clientMeta);
    broadcastScreenCount();

    // Envia estado inicial imediatamente no aperto de mão
    res.write(`event: init\ndata: ${JSON.stringify({ ...globalState, activeScreens: sseClients.size, screens: getActiveScreensList() })}\n\n`);

    req.on("close", () => {
      sseClients.delete(res);
      broadcastScreenCount();
    });
    return;
  }

  // 4. VERIFICAÇÃO DE SENHA DO DEV ADMIN (POST /api/auth/verify)
  if (pathname === "/api/auth/verify" && method === "POST") {
    if (authLockedResponse(res, clientIp)) return;
    try {
      const body = await readRequestBody(req);

      // Login com senha: devolve um token de sessão novo
      if (body.password) {
        if (!checkPassword(body.password)) {
          registerAuthFailure(clientIp);
          sendJson(res, 401, { success: false, error: "Senha incorreta do Painel Dev." });
          return;
        }
        sendJson(res, 200, {
          success: true,
          message: "Autenticação realizada com sucesso.",
          token: createDevSession(),
          expiresInSeconds: DEV_SESSION_TTL_MS / 1000
        });
        return;
      }

      // Sem senha: só confere se o token de sessão ainda vale
      if (!isValidDevSession(getBearerToken(req))) {
        registerAuthFailure(clientIp);
        sendJson(res, 401, { success: false, error: "Sessão expirada. Digite a senha novamente." });
        return;
      }
      sendJson(res, 200, { success: true, message: "Sessão válida." });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // Encerra a sessão do painel dev (botão de bloquear)
  if (pathname === "/api/auth/logout" && method === "POST") {
    devSessions.delete(getBearerToken(req));
    sendJson(res, 200, { success: true });
    return;
  }

  // 5. AGENDAMENTO DA QUADRA (GET /api/court/schedule & POST /api/court/book)
  if (pathname === "/api/court/schedule" && method === "GET") {
    const payload = JSON.stringify({
      court: globalState.court,
      bookings: globalState.courtBookings
    });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-cache"
    });
    res.end(payload);
    return;
  }

  if (pathname === "/api/court/book" && method === "POST") {
    const bookKey = `book:${clientIp}`;
    if (isRateLimited(bookKey, BOOK_MAX_PER_WINDOW)) {
      const wait = retryAfterSeconds(bookKey);
      sendJson(res, 429, {
        success: false,
        error: `Muitas reservas seguidas. Tente novamente em ${Math.ceil(wait / 60)} minuto(s).`
      }, { "Retry-After": String(wait) });
      return;
    }
    try {
      const body = await readRequestBody(req);
      const hour = parseCourtHour(body.slot || body.timeSlot);
      const trimmedName = cleanText(body.name || body.bookedBy, 50);
      const trimmedSport = cleanText(body.sport, 40);

      if (hour === null) {
        sendJson(res, 400, {
          error: `Horário inválido. Escolha uma hora cheia entre ${COURT_FIRST_HOUR}:00 e ${COURT_LAST_HOUR}:00.`
        });
        return;
      }
      if (hour < getCourtClock().hour) {
        sendJson(res, 400, { error: "Esse horário já passou. Escolha um horário a partir de agora." });
        return;
      }
      if (!trimmedName || !trimmedSport) {
        sendJson(res, 400, { error: "Horário, nome do responsável e modalidade são obrigatórios." });
        return;
      }

      const cleanSlot = `${String(hour).padStart(2, "0")}:00`;
      const timeLabel = `${cleanSlot} às ${String(hour + 1).padStart(2, "0")}:00`;

      // Verifica se o horário já está reservado
      const alreadyBooked = globalState.courtBookings.some(b =>
        b.slot === cleanSlot || b.timeLabel === timeLabel
      );
      if (alreadyBooked) {
        sendJson(res, 409, { success: false, error: `O horário ${timeLabel} já está reservado por outra pessoa.` });
        return;
      }

      hitRateLimit(bookKey, BOOK_MAX_PER_WINDOW, BOOK_WINDOW_MS);

      const newBooking = {
        id: "book-" + Date.now(),
        slot: cleanSlot,
        timeLabel: timeLabel,
        name: trimmedName,
        sport: trimmedSport,
        bookedBy: trimmedName,
        timeSlot: timeLabel,
        createdAt: Date.now()
      };

      globalState.courtBookings.push(newBooking);
      globalState.courtBookings.sort((a, b) => a.slot.localeCompare(b.slot));
      saveState();

      // Sincroniza em tempo real com todos os totens e telas abertas
      broadcastEvent("court_booking_update", {
        bookings: globalState.courtBookings,
        newBooking: newBooking,
        court: globalState.court
      });

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        success: true,
        message: `Horário ${newBooking.timeLabel} agendado com sucesso!`,
        booking: newBooking,
        bookings: globalState.courtBookings
      }));
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // 6. ACIONAR SINO PÚBLICO (POST /api/bell)
  if (pathname === "/api/bell" && method === "POST") {
    try {
      const now = Date.now();
      if (!globalState.bell.enabled) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Sino temporariamente desativado pela administração." }));
        return;
      }

      const elapsedSeconds = (now - (globalState.bell.lastRung || 0)) / 1000;
      if (elapsedSeconds < globalState.bell.cooldownSeconds) {
        const remaining = Math.ceil(globalState.bell.cooldownSeconds - elapsedSeconds);
        res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          error: "Aguarde o cooldown.",
          remainingSeconds: remaining
        }));
        return;
      }

      globalState.bell.lastRung = now;
      saveState();

      // Dispara o som em todas as telas conectadas no mundo!
      broadcastEvent("bell_ring", {
        lastRung: now,
        cooldownSeconds: globalState.bell.cooldownSeconds,
        source: "public"
      });

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        success: true,
        message: "Sino tocado na praça!",
        lastRung: now,
        cooldownSeconds: globalState.bell.cooldownSeconds
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 7. PAINEL DE CONTROLE / DEV ADMIN (POST /api/control) — PROTEGIDO COM SENHA
  if (pathname === "/api/control" && method === "POST") {
    if (authLockedResponse(res, clientIp)) return;
    try {
      const body = await readRequestBody(req);

      // Validação de senha obrigatória para todos os comandos dev
      if (!validateAuth(req, body)) {
        registerAuthFailure(clientIp);
        sendJson(res, 401, {
          error: "Acesso não autorizado ao painel dev. Senha incorreta ou ausente."
        });
        return;
      }

      const action = body.action;

      if (action === "set_weather") {
        const val = body.value || body.weather;
        if (["sun", "rain", "wind", "night"].includes(val)) {
          globalState.weather = val;
          saveState();
          broadcastEvent("weather_change", { weather: globalState.weather });
        }
      } else if (action === "set_phase") {
        const phase = Number(body.value || body.phase);
        if ([1, 2, 3, 4].includes(phase)) {
          globalState.sakuraPhase = phase;
          saveState();
          broadcastEvent("phase_change", { sakuraPhase: phase });
        }
      } else if (action === "gust_wind") {
        broadcastEvent("wind_gust", { timestamp: Date.now() });
      } else if (action === "set_court") {
        const courtData = (body.court && typeof body.court === "object") ? body.court : body;
        // Só aceita os campos conhecidos, já validados
        const current = globalState.court;
        globalState.court = {
          status: COURT_STATUSES.has(courtData.status) ? courtData.status : current.status,
          remainingMinutes: courtData.remainingMinutes !== undefined
            ? clampNumber(courtData.remainingMinutes, 0, 600, current.remainingMinutes)
            : current.remainingMinutes,
          activity: courtData.activity !== undefined ? cleanText(courtData.activity, 60) : current.activity,
          nextSlot: courtData.nextSlot !== undefined ? cleanText(courtData.nextSlot, 80) : current.nextSlot
        };
        saveState();
        broadcastEvent("court_change", { court: globalState.court });
      } else if (action === "set_bell_enabled") {
        globalState.bell.enabled = Boolean(body.enabled);
        saveState();
        broadcastEvent("bell_config", { bell: globalState.bell });
      } else if (action === "ring_bell_admin") {
        const now = Date.now();
        globalState.bell.lastRung = now;
        saveState();
        broadcastEvent("bell_ring", {
          lastRung: now,
          cooldownSeconds: globalState.bell.cooldownSeconds,
          source: "admin"
        });
      } else if (action === "send_toast" || action === "toast") {
        const message = cleanText(body.message, 300);
        if (message) {
          broadcastEvent("toast_broadcast", {
            id: Date.now(),
            message: message,
            title: cleanText(body.title, 80) || "Aviso da Praça",
            duration: clampNumber(body.duration, 1, 3600, 30)
          });
        }
      } else if (action === "set_activities") {
        if (Array.isArray(body.activities)) {
          globalState.weeklyActivities = body.activities.slice(0, 30).map((rawAct, idx) => {
            const act = rawAct && typeof rawAct === "object" ? rawAct : {};
            let icon = String(act.icon || 'geral').trim();
            if (icon === '\u{1F9D8}') icon = 'zen';
            else if (icon === '\u{1F955}') icon = 'organico';
            else if (icon === '\u{1F3C0}' || icon === '\u{26BD}' || icon === '\u{1F3D0}' || icon === '\u{1F3BE}') icon = 'esporte';
            else if (icon === '\u{1F3A8}') icon = 'arte';
            return {
              id: cleanText(act.id, 40) || `act-${Date.now()}-${idx}`,
              icon: cleanText(icon, 20).replace(/[^a-z0-9_-]/gi, "") || "geral",
              dayTime: cleanText(act.dayTime, 40),
              title: cleanText(act.title, 80),
              desc: cleanText(act.desc, 200),
              tagColor: cleanText(act.tagColor, 20).replace(/[^a-z0-9_-]/gi, "") || "sakura"
            };
          });
          saveState();
          broadcastEvent("activities_change", { activities: globalState.weeklyActivities });
        }
      } else if (action === "cancel_booking") {
        const bookingId = body.id || body.bookingId;
        const slot = body.slot;
        if (bookingId || slot) {
          globalState.courtBookings = globalState.courtBookings.filter(b => {
            if (bookingId && b.id === bookingId) return false;
            if (slot && (b.slot === slot || b.timeLabel === slot)) return false;
            return true;
          });
          saveState();
          broadcastEvent("court_booking_update", {
            bookings: globalState.courtBookings,
            court: globalState.court
          });
        }
      } else {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Ação desconhecida." }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        success: true,
        state: { ...globalState, activeScreens: sseClients.size, screens: getActiveScreensList() }
      }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 8. ROTEAMENTO DE ARQUIVOS ESTÁTICOS
  let cleanPath = pathname.replace(/^\/+/, "").replace(/\\/g, "/");

  // Mapeia rotas especiais
  if (cleanPath === "agendar" || cleanPath === "agendar/" || cleanPath === "agendar.html") {
    cleanPath = "agendar.html";
  } else if (cleanPath === "dev" || cleanPath === "dev/" || cleanPath === "admin" || cleanPath === "admin/") {
    cleanPath = "dev.html";
  } else if (!cleanPath || cleanPath === "" || cleanPath === "/") {
    cleanPath = "index.html";
  }

  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, HEAD" });
    res.end("Method Not Allowed");
    return;
  }

  let servePath;
  let isFallback = false;
  if (isPublicFile(cleanPath)) {
    servePath = path.join(PUBLIC_DIR, cleanPath);
  } else if (!path.posix.basename(cleanPath).includes(".") && !cleanPath.split("/").some(seg => seg.startsWith("."))) {
    // Rota sem extensão (navegação SPA): devolve o index.html
    servePath = path.join(PUBLIC_DIR, "index.html");
    isFallback = true;
  } else {
    // Qualquer arquivo fora da lista pública (senha, .git, código, estado...)
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
    return;
  }

  {

    fs.stat(servePath, (statErr, finalStats) => {
      if (statErr || !finalStats.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }

      const contentType = MIME_TYPES[path.extname(servePath).toLowerCase()] || "application/octet-stream";
      const headers = {
        "Content-Type": contentType
      };

      if (cleanPath.startsWith("assets/") && !isFallback) {
        headers["Cache-Control"] = "public, max-age=31536000, immutable";
      } else {
        headers["Cache-Control"] = "no-cache, must-revalidate";
      }

      const acceptEncoding = req.headers["accept-encoding"] || "";
      const isCompressible = COMPRESSIBLE_TYPES.has(contentType) && finalStats.size > 1024;

      if (method === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return;
      }

      const rawStream = fs.createReadStream(servePath);
      rawStream.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      });
      res.on("close", () => {
        rawStream.destroy();
      });

      if (isCompressible && typeof acceptEncoding === "string" && acceptEncoding.includes("gzip")) {
        headers["Content-Encoding"] = "gzip";
        res.writeHead(200, headers);
        const gzip = zlib.createGzip({ level: 6 });
        gzip.on("error", () => {});
        rawStream.pipe(gzip).pipe(res);
      } else {
        headers["Content-Length"] = finalStats.size;
        res.writeHead(200, headers);
        rawStream.pipe(res);
      }

      res.on("finish", () => {
        const duration = Date.now() - startTime;
        const status = res.statusCode;
        if (pathname !== "/api/events") {
          const logMsg = `[${new Date().toLocaleTimeString()}] ${method} ${cleanText(pathname, 200)} -> ${status} (${duration}ms)\n`;
          process.stdout.write(logMsg);
        }
      });
    });
  }
});

process.on("uncaughtException", (err) => {
  console.error("[SERVER] Uncaught exception:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[SERVER] Unhandled rejection:", reason);
});

server.listen(PORT, HOST, () => {
  const localIps = getNetworkAddresses();
  console.log("=".repeat(65));
  console.log("  PRAÇA CONECTA -- SERVIDOR NODE.JS REALTIME & TOTEM");
  console.log("=".repeat(65));
  console.log(`  Runtime           : Node.js ${process.version}`);
  console.log(`  Diretório Público : ${PUBLIC_DIR}`);
  console.log(`  Porta             : ${PORT}`);
  console.log("-".repeat(65));
  console.log("  LINKS DE ACESSO:");
  console.log(`  * Totem Público      : http://localhost:${PORT}/`);
  console.log(`  * Painel Dev Studio  : http://localhost:${PORT}/dev`);
  console.log(`  * Agendamento Mobile : http://localhost:${PORT}/agendar`);
  for (const ip of localIps) {
    console.log(`  * Na Rede Local/Celular : http://${ip}:${PORT}/ (Totem) | /dev (Painel) | /agendar`);
  }
  console.log("-".repeat(65));
  if (DEV_PASSWORD) {
    console.log("  Painel Dev        : ATIVO (senha lida de senha_dev.txt)");
  } else {
    console.log(`  Painel Dev        : BLOQUEADO -- crie ${DEV_PASSWORD_FILE} com a senha`);
  }
  console.log("-".repeat(65));
  console.log("  Pressione Ctrl + C para encerrar o servidor.\n");
});

const shutdown = () => {
  console.log("\n[OK] Encerrando servidor Node.js...");
  server.close(() => {
    console.log("[OK] Servidor finalizado.");
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export {};
