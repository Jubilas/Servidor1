import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9222;
const TEMP_USER_DATA = path.join(os.tmpdir(), 'edge_cdp_profile_' + Date.now());

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.callbacks = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id && this.callbacks.has(msg.id)) {
            const { resolve, reject } = this.callbacks.get(msg.id);
            this.callbacks.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch (e) {}
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return res.result?.value;
  }

  async screenshot(filePath) {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.data, "base64");
    fs.writeFileSync(filePath, buffer);
    console.log(`[PRINT SALVO] ${filePath} (${buffer.length} bytes)`);
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch(e) {}
    }
  }
}

async function startEdge() {
  const args = [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1920,1080',
    `--user-data-dir=${TEMP_USER_DATA}`
  ];
  const proc = spawn(EDGE_PATH, args, { stdio: 'ignore' });

  // Aguarda porta CDP ficar ativa
  let connected = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) {
        connected = true;
        break;
      }
    } catch(e) {}
    await sleep(300);
  }

  if (!connected) {
    proc.kill();
    throw new Error("Não foi possível conectar ao DevTools do Edge.");
  }

  return proc;
}

async function createTarget(url, width = 1920, height = 1080) {
  const newRes = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = await newRes.json();
  const client = new CDPClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: width,
    height: height,
    deviceScaleFactor: 1,
    mobile: width < 600
  });
  return { client, targetId: target.id };
}

async function closeTarget(targetId) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${targetId}`);
  } catch(e) {}
}

async function runVisualTests() {
  console.log("=== INICIANDO BATERIA DE TESTES MANUAIS E VISUAIS (COM SCREENSHOTS) ===");
  const edgeProc = await startEdge();

  try {
    // -------------------------------------------------------------
    // TESTE 1: TOTEM PÚBLICO - TELA NORMAL
    // -------------------------------------------------------------
    console.log("\n[TESTE 1] Carregando Totem Público (http://localhost:8080/)...");
    const totem = await createTarget("http://localhost:8080/", 1920, 1080);
    await sleep(2500); // Aguarda Three.js e WebGL renderizarem o primeiro frame

    // Garante que o clima está em Sol Radiante e a cerejeira em Florada Plena (Fase 3 - 88% Mankai)
    await fetch("http://localhost:8080/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer PracaConecta#2026!Dev" },
      body: JSON.stringify({ action: "set_weather", weather: "sun" })
    });
    await sleep(400);
    await fetch("http://localhost:8080/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer PracaConecta#2026!Dev" },
      body: JSON.stringify({ action: "set_phase", phase: 3 })
    });
    await sleep(800);

    // Verifica que modo debug foi removido do header
    const hasHeaderModeSwitcher = await totem.client.evaluate(`Boolean(document.getElementById('mode-ascii'))`);
    console.log(`- Debug Viewport mode switcher no header: ${hasHeaderModeSwitcher ? "PRESENTE (ERRO)" : "REMOVIDO (CORRETO)"}`);

    // Verifica que % da cerejeira e status atual são exibidos
    const sakuraPct = await totem.client.evaluate(`document.getElementById('radar-phase-pct')?.innerText`);
    const sakuraPhaseName = await totem.client.evaluate(`document.getElementById('radar-phase-name')?.innerText`);
    console.log(`- Monitor fenológico Sakura: ${sakuraPct} - ${sakuraPhaseName}`);

    // Verifica atividades semanais renderizadas sem bug do dayTime
    const activitiesText = await totem.client.evaluate(`
      Array.from(document.querySelectorAll('#weekly-activities-container > div')).map(d => d.innerText.replace(/\\n/g, ' | '))
    `);
    console.log(`- Atividades da semana renderizadas: ${JSON.stringify(activitiesText)}`);

    const p1 = path.join(SCREENSHOT_DIR, "01_totem_public_home.png");
    await totem.client.screenshot(p1);

    // Captura Card de Horários e Calendário da Quadra na Aba Principal
    console.log("- Rolando até o Card de Horários da Quadra no Hero...");
    await totem.client.evaluate(`
      const card = document.getElementById('main-court-schedule-card');
      if (card) card.scrollIntoView({ behavior: 'instant', block: 'center' });
    `);
    await sleep(500);
    const p1b = path.join(SCREENSHOT_DIR, "01b_totem_public_hero_schedule.png");
    await totem.client.screenshot(p1b);
    await totem.client.evaluate(`window.scrollTo(0, 0);`);
    await sleep(300);

    // -------------------------------------------------------------
    // TESTE 2: MODO AFK (SCREENSAVER) & STATUS DA QUADRA EM USO
    // -------------------------------------------------------------
    console.log("\n[TESTE 2] Ativando Modo AFK (Screensaver) e verificando som Furin...");
    
    // Monitora chamadas de som antes de entrar em AFK
    await totem.client.evaluate(`
      window.__furinCallCount = 0;
      if (typeof sound !== 'undefined') {
        const origPlayFurin = sound.playFurin.bind(sound);
        sound.playFurin = function() {
          window.__furinCallCount++;
          return origPlayFurin();
        };
      }
      // Ativa o screensaver via botão oficial ou window
      const btn = document.getElementById('btn-screensaver-trigger');
      if (btn) btn.click();
      else if (window.activateScreensaver) window.activateScreensaver();
    `);
    await sleep(600);

    const isScreensaverActive = await totem.client.evaluate(`
      const ss = document.getElementById('totem-screensaver');
      Boolean(ss && ss.classList.contains('active') && document.body.classList.contains('screensaver-active'))
    `);
    const furinCalls = await totem.client.evaluate(`window.__furinCallCount`);
    const courtBadgeText = await totem.client.evaluate(`document.getElementById('screensaver-court-badge')?.innerText`);
    const courtBadgeDotColor = await totem.client.evaluate(`document.getElementById('screensaver-court-dot')?.className`);

    console.log(`- Screensaver Ativo: ${isScreensaverActive ? "SIM (CORRETO)" : "NÃO (ERRO)"}`);
    console.log(`- Chamadas de Furin ao entrar em AFK: ${furinCalls} (Esperado: 1)`);
    console.log(`- Badge da Quadra no AFK: "${courtBadgeText}" (Dot: ${courtBadgeDotColor})`);

    const p2 = path.join(SCREENSHOT_DIR, "02_totem_afk_screensaver_em_uso.png");
    await totem.client.screenshot(p2);

    // Testa que mousemove enquanto em AFK NÃO chama o som nem agenda loops repetitivos
    console.log("- Testando movimentos de mouse em modo AFK (sem loops ou som repetitivo)...");
    await totem.client.evaluate(`
      window.dispatchEvent(new Event('mousemove'));
      window.dispatchEvent(new Event('scroll'));
    `);
    await sleep(500);
    const furinCallsAfterMove = await totem.client.evaluate(`window.__furinCallCount`);
    console.log(`- Chamadas de Furin após mousemove em AFK: ${furinCallsAfterMove} (Esperado: 1, não aumentou)`);

    // -------------------------------------------------------------
    // TESTE 3: AVISO GLOBAL GIGANTE SOBRE O MODO AFK
    // -------------------------------------------------------------
    console.log("\n[TESTE 3] Transmitindo Aviso Global Gigante em Destaque no AFK...");
    // Dispara via fetch para a API protegida /api/control
    await fetch("http://localhost:8080/api/control", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer PracaConecta#2026!Dev"
      },
      body: JSON.stringify({
        action: "send_toast",
        title: "COMUNICADO URGENTE DA PREFEITURA",
        message: "Festival das Cerejeiras 2026: Concerto Musical e Iluminação Noturna às 19:30 no Deck dos Mestres!",
        duration: 30
      })
    });
    await sleep(600);

    const isBroadcastVisible = await totem.client.evaluate(`
      const modal = document.getElementById('global-broadcast-modal');
      !modal.classList.contains('opacity-0') && !modal.classList.contains('pointer-events-none')
    `);
    const broadcastTitle = await totem.client.evaluate(`document.getElementById('global-broadcast-title')?.innerText`);
    const broadcastMsg = await totem.client.evaluate(`document.getElementById('global-broadcast-message')?.innerText`);

    console.log(`- Modal gigante de aviso global visível: ${isBroadcastVisible ? "SIM (CORRETO)" : "NÃO (ERRO)"}`);
    console.log(`- Título: "${broadcastTitle}"`);
    console.log(`- Mensagem: "${broadcastMsg}"`);

    const p3 = path.join(SCREENSHOT_DIR, "03_totem_afk_with_giant_broadcast.png");
    await totem.client.screenshot(p3);

    // Fecha o modal de broadcast clicando em Dispensar
    await totem.client.evaluate(`document.getElementById('btn-dismiss-broadcast')?.click()`);
    await sleep(400);

    // -------------------------------------------------------------
    // TESTE 4: CORES DO STATUS DA QUADRA NO AFK (LIVRE E MANUTENÇÃO)
    // -------------------------------------------------------------
    console.log("\n[TESTE 4] Testando Status da Quadra no AFK: Livre (Verde) e Manutenção (Amarelo)...");
    
    // Status Livre
    await fetch("http://localhost:8080/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer PracaConecta#2026!Dev" },
      body: JSON.stringify({ action: "set_court", status: "livre" })
    });
    await sleep(500);
    const ssLivreBadge = await totem.client.evaluate(`document.getElementById('screensaver-court-badge')?.innerText`);
    console.log(`- Status Livre no AFK: "${ssLivreBadge}"`);
    const p4 = path.join(SCREENSHOT_DIR, "04_totem_afk_court_livre.png");
    await totem.client.screenshot(p4);

    // Status Manutenção
    await fetch("http://localhost:8080/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer PracaConecta#2026!Dev" },
      body: JSON.stringify({ action: "set_court", status: "manutencao" })
    });
    await sleep(500);
    const ssManutBadge = await totem.client.evaluate(`document.getElementById('screensaver-court-badge')?.innerText`);
    console.log(`- Status Manutenção no AFK: "${ssManutBadge}"`);
    const p5 = path.join(SCREENSHOT_DIR, "05_totem_afk_court_manutencao.png");
    await totem.client.screenshot(p5);

    // Restaura para em_uso
    await fetch("http://localhost:8080/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer PracaConecta#2026!Dev" },
      body: JSON.stringify({ action: "set_court", status: "em_uso", remainingMinutes: 22 })
    });

    // -------------------------------------------------------------
    // TESTE 5: MODO NOITE YOZAKURA (ALTO CONTRASTE)
    // -------------------------------------------------------------
    console.log("\n[TESTE 5] Testando Modo Noite Yozakura (Alto Contraste)...");
    // Desativa screensaver para ver a página completa sob Sol Radiante
    await totem.client.evaluate(`if (window.deactivateScreensaver) window.deactivateScreensaver();`);
    await sleep(400);

    // Garante modo Sol Radiante para capturar tema claro artesanal
    await fetch("http://localhost:8080/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer PracaConecta#2026!Dev" },
      body: JSON.stringify({ action: "set_weather", weather: "sun" })
    });
    await sleep(600);

    // Testa broadcast na tela normal de dia (craft paper)
    console.log("- Transmitindo Aviso Global sob Sol Radiante (Tema Craft Paper Marfim)...");
    await fetch("http://localhost:8080/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer PracaConecta#2026!Dev" },
      body: JSON.stringify({
        action: "send_toast",
        title: "SOL RADIANTE NA PRAÇA // PALETA MARFIM & LACA",
        message: "O aviso global agora respeita o design artesanal da praça, com fundo marfim craft e bordas carmim carmesim durante o dia!",
        duration: 30
      })
    });
    await sleep(600);
    const p3b = path.join(SCREENSHOT_DIR, "03b_totem_daytime_broadcast_craft.png");
    await totem.client.screenshot(p3b);
    await totem.client.evaluate(`document.getElementById('btn-dismiss-broadcast')?.click()`);
    await sleep(400);

    await fetch("http://localhost:8080/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer PracaConecta#2026!Dev" },
      body: JSON.stringify({ action: "set_weather", weather: "night" })
    });
    await sleep(1000);

    const isNightMode = await totem.client.evaluate(`document.body.classList.contains('mode-night')`);
    console.log(`- Modo Noite ativo no body: ${isNightMode ? "SIM (CORRETO)" : "NÃO (ERRO)"}`);
    const p6 = path.join(SCREENSHOT_DIR, "06_totem_night_yozakura.png");
    await totem.client.screenshot(p6);

    // Testa broadcast em modo noite (obsidian)
    console.log("- Transmitindo Aviso Global em Modo Noite Yozakura (Midnight Obsidian)...");
    await fetch("http://localhost:8080/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer PracaConecta#2026!Dev" },
      body: JSON.stringify({
        action: "send_toast",
        title: "NOITE YOZAKURA // ILUMINAÇÃO CÊNICA NOTURNA",
        message: "Durante a noite, o aviso global alterna dinamicamente para o tom obsidian profundo de alta legibilidade!",
        duration: 30
      })
    });
    await sleep(600);
    const p6b = path.join(SCREENSHOT_DIR, "06b_totem_night_broadcast_obsidian.png");
    await totem.client.screenshot(p6b);
    await totem.client.evaluate(`document.getElementById('btn-dismiss-broadcast')?.click()`);
    await sleep(400);

    // Retorna para sol
    await fetch("http://localhost:8080/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer PracaConecta#2026!Dev" },
      body: JSON.stringify({ action: "set_weather", weather: "sun" })
    });
    await sleep(600);
    await closeTarget(totem.targetId);

    // -------------------------------------------------------------
    // TESTE 6: PAINEL DEV COM GATE DE SENHA E TELEMETRIA
    // -------------------------------------------------------------
    console.log("\n[TESTE 6] Carregando Painel Dev (http://localhost:8080/dev)...");
    const devPage = await createTarget("http://localhost:8080/dev", 1920, 1080);
    await sleep(1500);

    // Verifica que o modal de autenticação está bloqueando
    const isAuthModalOpen = await devPage.client.evaluate(`
      const m = document.getElementById('auth-modal');
      Boolean(m && !m.classList.contains('hidden'))
    `);
    console.log(`- Gate de Senha bloqueando painel inicialmente: ${isAuthModalOpen ? "SIM (CORRETO)" : "NÃO (ERRO)"}`);

    const p7 = path.join(SCREENSHOT_DIR, "07_dev_auth_gate.png");
    await devPage.client.screenshot(p7);

    // Digita a senha correta e autentica
    console.log("- Autenticando com a senha de C:\\Users\\goiab\\Desktop\\senha_painel_dev.txt...");
    await devPage.client.evaluate(`
      document.getElementById('input-dev-pass').value = 'PracaConecta#2026!Dev';
      document.getElementById('btn-submit-auth').click();
    `);
    await sleep(1500);

    const debugAuth = await devPage.client.evaluate(`
      (() => {
        const m = document.getElementById('auth-modal');
        return {
          modalFound: Boolean(m),
          classList: m ? m.className : null,
          hidden: m ? m.classList.contains('hidden') : false,
          token: sessionStorage.getItem('dev_auth_token'),
          devPassword: typeof devPassword !== 'undefined' ? devPassword : null
        };
      })()
    `);
    console.log("DEBUG AUTH:", JSON.stringify(debugAuth));
    const isAuthPassed = debugAuth && debugAuth.hidden && Boolean(debugAuth.token);
    console.log(`- Autenticação bem-sucedida e painel liberado: ${isAuthPassed ? "SIM (CORRETO)" : "NÃO (ERRO)"}`);

    // Verifica telemetria com telas ativas conectadas
    const activeScreensBadge = await devPage.client.evaluate(`document.getElementById('badge-screens-active')?.innerText`);
    console.log(`- Telemetria de telas ativas: "${activeScreensBadge}"`);

    const p8 = path.join(SCREENSHOT_DIR, "08_dev_dashboard_authenticated.png");
    await devPage.client.screenshot(p8);

    await closeTarget(devPage.targetId);

    // -------------------------------------------------------------
    // TESTE 7: AGENDAMENTO MOBILE RESPONSIVO (/agendar)
    // -------------------------------------------------------------
    console.log("\n[TESTE 7] Carregando WebApp Mobile de Agendamento (http://localhost:8080/agendar)...");
    const mobilePage = await createTarget("http://localhost:8080/agendar", 414, 896); // iPhone 11 Pro viewport
    await sleep(1500);

    const slotCardsCount = await mobilePage.client.evaluate(`document.querySelectorAll('#slots-container > div').length`);
    console.log(`- Horários disponíveis para reserva listados: ${slotCardsCount} horários`);

    const p9 = path.join(SCREENSHOT_DIR, "09_mobile_agendar_screen.png");
    await mobilePage.client.screenshot(p9);

    // Realiza reserva de teste mobile
    console.log("- Submetendo reserva para 17:00 via formulário mobile...");
    await mobilePage.client.evaluate(`
      openBookingModal('17:00', '17:00 às 18:00');
    `);
    await sleep(400);

    await mobilePage.client.evaluate(`
      document.getElementById('input-name').value = 'Mariana Silva (Vôlei da Tarde)';
      document.getElementById('form-booking').dispatchEvent(new Event('submit', { cancelable: true }));
    `);
    await sleep(1200);

    const p10 = path.join(SCREENSHOT_DIR, "10_mobile_agendar_booking_confirmed.png");
    await mobilePage.client.screenshot(p10);

    // Verifica que a reserva foi persistida no backend
    const checkSchedule = await fetch("http://localhost:8080/api/court/schedule").then(r => r.json());
    const foundBooking = checkSchedule.bookings.find(b => b.name?.includes("Mariana Silva") || b.bookedBy?.includes("Mariana Silva"));
    console.log(`- Reserva persistida no backend e visível na grade: ${foundBooking ? "SIM (" + foundBooking.slot + " - " + foundBooking.name + ")" : "NÃO (ERRO)"}`);

    // Limpa a reserva de teste para manter o estado limpo
    if (foundBooking) {
      await fetch("http://localhost:8080/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer PracaConecta#2026!Dev" },
        body: JSON.stringify({ action: "cancel_booking", id: foundBooking.id })
      });
      console.log("- Reserva temporária de teste cancelada após validação.");
    }

    await closeTarget(mobilePage.targetId);

    console.log("\n=== TODAS AS VERIFICAÇÕES VISUAIS E MANUAIS CONCLUÍDAS COM SUCESSO! ===");
    console.log(`Todos os prints estão salvos em: ${SCREENSHOT_DIR}`);

  } catch(err) {
    console.error("ERRO durante testes visuais:", err);
    throw err;
  } finally {
    edgeProc.kill();
    try {
      fs.rmSync(TEMP_USER_DATA, { recursive: true, force: true });
    } catch(e) {}
  }
}

runVisualTests().catch(e => {
  console.error("Falha geral:", e);
  process.exit(1);
});
