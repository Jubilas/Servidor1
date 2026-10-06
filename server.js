import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import os from "node:os";
//#region server/server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8080;
var HOST = process.env.HOST || "0.0.0.0";
var PUBLIC_DIR = __dirname;
if (!fs.existsSync(path.join(PUBLIC_DIR, "index.html")) && fs.existsSync(path.join(__dirname, "..", "dist", "index.html"))) PUBLIC_DIR = path.join(__dirname, "..", "dist");
else if (fs.existsSync(path.join(__dirname, "dist", "index.html"))) PUBLIC_DIR = path.join(__dirname, "dist");
var MIME_TYPES = {
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
var COMPRESSIBLE_TYPES = /* @__PURE__ */ new Set([
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
		for (const net of iface) if (net.family === "IPv4" && !net.internal) addresses.push(net.address);
	}
	return addresses;
}
var server = http.createServer((req, res) => {
	const startTime = Date.now();
	const method = req.method || "GET";
	const rawUrl = req.url || "/";
	if (method !== "GET" && method !== "HEAD") {
		res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Method Not Allowed");
		return;
	}
	const pathname = decodeURIComponent(rawUrl.split("?")[0]);
	if (pathname === "/api/health" || pathname === "/healthz") {
		const payload = JSON.stringify({
			status: "ok",
			service: "praca-conecta-node-server",
			uptimeSeconds: Math.floor(process.uptime()),
			timestamp: (/* @__PURE__ */ new Date()).toISOString()
		});
		res.writeHead(200, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": Buffer.byteLength(payload),
			"Cache-Control": "no-cache"
		});
		res.end(payload);
		return;
	}
	let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
	if (safePath === "/" || safePath === "\\") safePath = "/index.html";
	let filePath = path.join(PUBLIC_DIR, safePath);
	if (!filePath.startsWith(PUBLIC_DIR)) {
		res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Forbidden");
		return;
	}
	fs.stat(filePath, (err, stats) => {
		let servePath = filePath;
		let isFallback = false;
		if (err || !stats.isFile()) {
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
				"X-Content-Type-Options": "nosniff",
				"X-Frame-Options": "SAMEORIGIN"
			};
			if (servePath.includes("/assets/") && !isFallback) headers["Cache-Control"] = "public, max-age=31536000, immutable";
			else headers["Cache-Control"] = "no-cache, must-revalidate";
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
				const logMsg = `[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] ${method} ${pathname} -> ${status} (${duration}ms)\n`;
				process.stdout.write(logMsg);
			});
		});
	});
});
server.listen(PORT, HOST, () => {
	const localIps = getNetworkAddresses();
	console.log("=".repeat(65));
	console.log("  NODE.JS PRODUCTION SERVER -- PRACA CONECTA");
	console.log("=".repeat(65));
	console.log(`  Runtime           : Node.js ${process.version}`);
	console.log(`  Public Directory  : ${PUBLIC_DIR}`);
	console.log(`  Port              : ${PORT}`);
	console.log("-".repeat(65));
	console.log("  LINKS DE ACESSO:");
	console.log(`  * Local (neste PC)   : http://localhost:${PORT}`);
	for (const ip of localIps) console.log(`  * Rede Local/Celular : http://${ip}:${PORT}`);
	console.log("-".repeat(65));
	console.log("  ACESSO REMOTO (FORA DE CASA):");
	console.log("  * Via Cloudflare Tunnel : cloudflared tunnel --url http://localhost:" + PORT);
	console.log("  * Via Ngrok             : ngrok http " + PORT);
	console.log("  * Via VPS / Docker      : http://<IP_DA_VPS>:" + PORT);
	console.log("=".repeat(65));
	console.log("  Pressione Ctrl + C para encerrar o servidor.\n");
});
var shutdown = () => {
	console.log("\n[OK] Encerrando servidor Node.js...");
	server.close(() => {
		console.log("[OK] Servidor finalizado.");
		process.exit(0);
	});
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
//#endregion
export {};
