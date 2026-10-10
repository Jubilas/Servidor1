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
    nextSlot: "14:30 às 15:30 (Treino de Vôlei)"
  },
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
// HUB DE TRANSMISSÃO EM TEMPO REAL (SSE)
// ==========================================
const sseClients = new Set();

function broadcastEvent(eventType, data) {
  globalState.lastBroadcast = Date.now();
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function broadcastScreenCount() {
  broadcastEvent("screens_count", { activeScreens: sseClients.size });
}

// Heartbeat a cada 25 segundos para manter proxies/túneis ativos
setInterval(() => {
  for (const client of sseClients) {
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
        // Proteção contra payload excessivo (max 64KB)
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
      activeScreens: sseClients.size
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

    sseClients.add(res);
    broadcastScreenCount();

    // Envia estado inicial imediatamente no aperto de mão
    res.write(`event: init\ndata: ${JSON.stringify({ ...globalState, activeScreens: sseClients.size })}\n\n`);

    req.on("close", () => {
      sseClients.delete(res);
      broadcastScreenCount();
    });
    return;
  }

  // 4. ACIONAR SINO PÚBLICO (POST /api/bell)
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

  // 5. PAINEL DE CONTROLE / DEV ADMIN (POST /api/control)
  if (pathname === "/api/control" && method === "POST") {
    try {
      const body = await readRequestBody(req);
      const action = body.action;

      if (action === "set_weather") {
        if (["sun", "rain", "wind", "night"].includes(body.value)) {
          globalState.weather = body.value;
          saveState();
          broadcastEvent("weather_change", { weather: globalState.weather });
        }
      } else if (action === "set_phase") {
        const phase = Number(body.value);
        if ([1, 2, 3, 4].includes(phase)) {
          globalState.sakuraPhase = phase;
          saveState();
          broadcastEvent("phase_change", { sakuraPhase: phase });
        }
      } else if (action === "gust_wind") {
        broadcastEvent("wind_gust", { timestamp: Date.now() });
      } else if (action === "set_court") {
        globalState.court = {
          ...globalState.court,
          ...(body.court || {})
        };
        saveState();
        broadcastEvent("court_change", { court: globalState.court });
      } else if (action === "set_bell_enabled") {
        globalState.bell.enabled = Boolean(body.enabled);
        saveState();
        broadcastEvent("bell_config", { bell: globalState.bell });
      } else if (action === "ring_bell_admin") {
        // Toca sino forçado via painel admin (ignora cooldown)
        const now = Date.now();
        globalState.bell.lastRung = now;
        saveState();
        broadcastEvent("bell_ring", {
          lastRung: now,
          cooldownSeconds: globalState.bell.cooldownSeconds,
          source: "admin"
        });
      } else if (action === "send_toast") {
        if (body.message) {
          broadcastEvent("toast_broadcast", {
            message: String(body.message),
            title: body.title || "Aviso da Praça"
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
        state: { ...globalState, activeScreens: sseClients.size }
      }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 6. ROTEAMENTO DE ARQUIVOS ESTÁTICOS
  let cleanPath = pathname.replace(/^\/+/, "").replace(/\\/g, "/");

  // Mapeia rotas especiais
  if (cleanPath === "dev" || cleanPath === "dev/" || cleanPath === "admin" || cleanPath === "admin/") {
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
  for (const ip of localIps) {
    console.log(`  * Na Rede Local/Celular : http://${ip}:${PORT}/ (Totem) | /dev (Painel)`);
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
