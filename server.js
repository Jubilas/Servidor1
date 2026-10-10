import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = __dirname;
const STATE_FILE = path.join(PUBLIC_DIR, "state.json");
const DEV_PASSWORD_FILE = "C:\\Users\\goiab\\Desktop\\senha_painel_dev.txt";
const DEFAULT_DEV_PASSWORD = "PracaConecta#2026!Dev";

// ==========================================
// AUTENTICAÇÃO DO PAINEL DEV (/dev)
// ==========================================
function getDevPassword() {
  try {
    if (fs.existsSync(DEV_PASSWORD_FILE)) {
      const content = fs.readFileSync(DEV_PASSWORD_FILE, "utf-8");
      const match = content.match(/Senha:\s*([^\r\n]+)/);
      if (match && match[1].trim()) {
        return match[1].trim();
      }
    }
  } catch (err) {
    console.error("[AUTH] Erro ao ler senha do arquivo na Área de Trabalho:", err.message);
  }
  return DEFAULT_DEV_PASSWORD;
}

function validateAuth(req, body) {
  const expected = getDevPassword();
  const authHeader = req.headers["authorization"] || "";
  let token = "";
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  }
  if (!token && body && body.password) {
    token = String(body.password).trim();
  }
  return Boolean(token && token === expected);
}

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
      icon: "🧘",
      dayTime: "SÁBADO • 08:00",
      title: "Yoga & Meditação Matinal",
      desc: "Deck dos Mestres. Traga seu tapete de yoga.",
      tagColor: "sakura"
    },
    {
      id: "act-2",
      icon: "🥕",
      dayTime: "SÁBADO • 09:30",
      title: "Feirinha Agroecológica",
      desc: "Alameda das Cerejeiras. Frutas e hortaliças orgânicas.",
      tagColor: "emerald"
    },
    {
      id: "act-3",
      icon: "🏀",
      dayTime: "DOMINGO • 15:30",
      title: "Clínica Aberta de Basquete",
      desc: "Quadra Poliesportiva. Todas as idades.",
      tagColor: "cyan"
    }
  ],
  bell: {
    enabled: true,
    cooldownSeconds: 20,
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
        bell: { ...DEFAULT_STATE.bell, ...(data.bell || {}) }
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

// ==========================================
// HUB DE TRANSMISSÃO EM TEMPO REAL (SSE) & TELEMETRIA
// ==========================================
const sseClients = new Map(); // res -> { id, name, type, ip, connectedAt }

function getActiveScreensList() {
  const now = Date.now();
  return Array.from(sseClients.values()).map(c => ({
    id: c.id,
    name: c.name,
    type: c.type,
    ip: c.ip,
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
        reject(new Error("Payload Too Large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
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
  const pathname = decodeURIComponent(rawUrl.split("?")[0]);

  // Headers globais de CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

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
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const parsedUrl = new URL(rawUrl, `http://${req.headers.host || "localhost"}`);
    let screenId = parsedUrl.searchParams.get("screenId");
    let screenType = parsedUrl.searchParams.get("screenType") || "totem";
    let screenName = parsedUrl.searchParams.get("screenName") || "";

    if (!screenId) {
      const randNum = Math.floor(1000 + Math.random() * 9000);
      screenId = screenType === "dev" ? `Dev Admin #${randNum}` : `Totem #${randNum}`;
    }
    if (!screenName) {
      screenName = screenId;
    }

    const clientIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1").replace(/^::ffff:/, '');
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
    try {
      const body = await readRequestBody(req);
      const isAuthValid = validateAuth(req, body);
      if (!isAuthValid) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ success: false, error: "Senha incorreta do Painel Dev." }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ success: true, message: "Autenticação realizada com sucesso." }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    }
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
    try {
      const body = await readRequestBody(req);
      const rawSlot = body.slot || body.timeSlot;
      const rawName = body.name || body.bookedBy;
      const rawSport = body.sport;

      if (!rawSlot || !rawName || !rawSport) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Horário, nome do responsável e modalidade são obrigatórios." }));
        return;
      }

      const trimmedSlot = String(rawSlot).trim();
      const cleanSlot = trimmedSlot.split(" ")[0]; // "16:00" if "16:00 às 17:00"
      const trimmedName = String(rawName).trim().slice(0, 50);
      const trimmedSport = String(rawSport).trim().slice(0, 40);

      // Verifica se o horário já está reservado
      const alreadyBooked = globalState.courtBookings.some(b => 
        b.slot === cleanSlot || b.slot === trimmedSlot || b.timeLabel === trimmedSlot
      );
      if (alreadyBooked) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ success: false, error: `O horário ${trimmedSlot} já está reservado por outra pessoa.` }));
        return;
      }

      const hourMatch = cleanSlot.match(/^(\d{1,2}):\d{2}/);
      const hour = hourMatch ? parseInt(hourMatch[1]) : 0;
      const nextHourStr = `${String(hour + 1).padStart(2, "0")}:00`;
      const timeLabel = trimmedSlot.includes("às") ? trimmedSlot : `${cleanSlot} às ${nextHourStr}`;

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
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
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
    try {
      const body = await readRequestBody(req);

      // Validação de senha obrigatória para todos os comandos dev
      if (!validateAuth(req, body)) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          error: "Acesso não autorizado ao painel dev. Senha incorreta ou ausente."
        }));
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
        const courtData = body.court || {
          status: body.status,
          remainingMinutes: body.remainingMinutes,
          activity: body.activity,
          nextSlot: body.nextSlot
        };
        globalState.court = {
          ...globalState.court,
          ...courtData
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
        if (body.message) {
          const duration = body.duration !== undefined ? body.duration : 30;
          broadcastEvent("toast_broadcast", {
            id: Date.now(),
            message: String(body.message),
            title: body.title || "Aviso da Praça",
            duration: duration
          });
        }
      } else if (action === "set_activities") {
        if (Array.isArray(body.activities)) {
          globalState.weeklyActivities = body.activities;
          saveState();
          broadcastEvent("activities_change", { activities: globalState.weeklyActivities });
        }
      } else if (action === "cancel_booking") {
        const bookingId = body.id || body.bookingId;
        const slot = body.slot;
        if (bookingId || slot) {
          globalState.courtBookings = globalState.courtBookings.filter(b => b.id !== bookingId && b.slot !== slot);
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

  const filePath = path.join(PUBLIC_DIR, cleanPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    let servePath = filePath;
    let isFallback = false;

    if (err || !stats.isFile()) {
      // Fallback para index.html se for navegação SPA
      servePath = path.join(PUBLIC_DIR, "index.html");
      isFallback = true;
    }

    fs.stat(servePath, (statErr, finalStats) => {
      if (statErr || !finalStats.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }

      const contentType = MIME_TYPES[path.extname(servePath).toLowerCase()] || "application/octet-stream";
      const headers = {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff"
      };

      if (servePath.includes("/assets/") && !isFallback) {
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
      if (isCompressible && typeof acceptEncoding === "string" && acceptEncoding.includes("gzip")) {
        headers["Content-Encoding"] = "gzip";
        res.writeHead(200, headers);
        const gzip = zlib.createGzip({ level: 6 });
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
          const logMsg = `[${new Date().toLocaleTimeString()}] ${method} ${pathname} -> ${status} (${duration}ms)\n`;
          process.stdout.write(logMsg);
        }
      });
    });
  });
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
