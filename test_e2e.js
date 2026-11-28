import http from 'node:http';
import fs from 'node:fs';

// Senha do painel dev: a mesma do servidor, lida de senha_dev.txt (fora do git)
const DEV_PASS = (() => {
  try {
    return fs.readFileSync(new URL('./senha_dev.txt', import.meta.url), 'utf-8')
      .split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
  } catch (e) {
    return '';
  }
})();
if (!DEV_PASS) {
  console.error("Crie senha_dev.txt (a mesma senha do servidor) antes de rodar os testes.");
  process.exit(1);
}
const PASS = DEV_PASS;
// Porta do servidor em teste (padrão 8080). Ex.: PORT=18081 node test_e2e.js
const PORT = Number(process.env.PORT) || 8080;

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch(e) {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

async function runTests() {
  console.log("=== INICIANDO TESTES END-TO-END DO TOTEM GLOBAL ===\n");
  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}`);
      failed++;
    }
  }

  // 1. Static Routes
  const rIndex = await request({ host: 'localhost', port: PORT, path: '/', method: 'GET' });
  assert(rIndex.status === 200 && rIndex.body.includes('global-broadcast-modal'), 'GET / (Totem Kiosk + Modal Aviso Global)');

  // Sem login, /dev, /admin e /dev.html entregam só a tela de senha (nada do painel)
  for (const p of ['/dev', '/admin', '/dev.html']) {
    const r = await request({ host: 'localhost', port: PORT, path: p, method: 'GET' });
    assert(r.status === 200 && r.body.includes('auth-modal') && !r.body.includes('dev-screens-list') && !r.body.includes('/api/control'),
      `GET ${p} sem login (só a tela de senha)`);
  }

  const rAgendar = await request({ host: 'localhost', port: PORT, path: '/agendar', method: 'GET' });
  assert(rAgendar.status === 200 && rAgendar.body.includes('slots-container'), 'GET /agendar (App Mobile Agendamento Quadra)');

  // 2. Auth Verification
  const rAuthWrong = await request({
    host: 'localhost', port: PORT, path: '/api/auth/verify', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { password: 'senha_errada_123' });
  assert(rAuthWrong.status === 401 && rAuthWrong.json.success === false, 'POST /api/auth/verify (Senha Incorreta Rejeitada)');

  const rAuthCorrect = await request({
    host: 'localhost', port: PORT, path: '/api/auth/verify', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { password: PASS });
  assert(rAuthCorrect.status === 200 && rAuthCorrect.json.success === true, 'POST /api/auth/verify (Senha Correta Aceita)');

  // O login grava o cookie que libera a página do painel
  const setCookie = [].concat(rAuthCorrect.headers['set-cookie'] || []).join(';');
  assert(/praca_dev=[0-9a-f]{64}/.test(setCookie) && /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Strict/i.test(setCookie),
    'Login grava o cookie do painel (HttpOnly, Secure, SameSite=Strict)');
  const devCookie = (setCookie.match(/praca_dev=[0-9a-f]{64}/) || [''])[0];

  const rDev = await request({ host: 'localhost', port: PORT, path: '/dev', method: 'GET', headers: { Cookie: devCookie } });
  assert(rDev.status === 200 && rDev.body.includes('auth-modal') && rDev.body.includes('dev-screens-list') && /no-store/.test(rDev.headers['cache-control'] || ''),
    'GET /dev com o cookie de sessão (Painel Dev + Telemetria, sem cache)');

  // O cookie só libera VER a página: comandos sem o token no Authorization continuam negados
  const rControlCookieOnly = await request({
    host: 'localhost', port: PORT, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: devCookie }
  }, { action: 'set_weather', value: 'night' });
  assert(rControlCookieOnly.status === 401, 'POST /api/control só com o cookie (Negado, exige o token)');

  // 3. Protected Control Endpoints
  const rControlNoAuth = await request({
    host: 'localhost', port: PORT, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { action: 'set_weather', weather: 'night' });
  assert(rControlNoAuth.status === 401, 'POST /api/control sem auth (Bloqueado com 401)');

  const rControlWeather = await request({
    host: 'localhost', port: PORT, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASS}` }
  }, { action: 'set_weather', weather: 'night' });
  assert(rControlWeather.status === 200 && rControlWeather.json.state.weather === 'night', 'POST /api/control (Alterar Clima Noite Yozakura)');

  const rControlPhase = await request({
    host: 'localhost', port: PORT, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASS}` }
  }, { action: 'set_phase', phase: 4 });
  assert(rControlPhase.status === 200 && rControlPhase.json.state.sakuraPhase === 4, 'POST /api/control (Alterar Fase Sakura para 4)');

  const rControlCourt = await request({
    host: 'localhost', port: PORT, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASS}` }
  }, { action: 'set_court', status: 'em_uso', remainingMinutes: 15, activity: 'Basquete 3x3' });
  assert(rControlCourt.status === 200 && rControlCourt.json.state.court.status === 'em_uso', 'POST /api/control (Status da Quadra: em_uso)');

  // 4. Global Broadcast Toast with duration
  const rBroadcast = await request({
    host: 'localhost', port: PORT, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASS}` }
  }, { action: 'toast', title: 'Manutenção Urgente', message: 'Setor leste interditado temporariamente.', duration: '30' });
  assert(rBroadcast.status === 200 && rBroadcast.json.success === true, 'POST /api/control (Aviso Global com Duração 30s)');

  // 5. Weekly Activities Management
  const newActivities = [
    { icon: 'zen', dayTime: 'SÁBADO • 08:00', title: 'Yoga & Meditação Matinal', desc: 'Deck dos Mestres' },
    { icon: 'organico', dayTime: 'SÁBADO • 09:30', title: 'Feirinha Agroecológica', desc: 'Alameda das Cerejeiras' },
    { icon: 'arte', dayTime: 'DOMINGO • 16:00', title: 'Oficina de Desenho Infantil', desc: 'Espaço Conecta Kids' }
  ];
  const rActivities = await request({
    host: 'localhost', port: PORT, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASS}` }
  }, { action: 'set_activities', activities: newActivities });
  assert(rActivities.status === 200 && rActivities.json.state.weeklyActivities.length === 3, 'POST /api/control (Gerenciador de Atividades Semanais)');

  // 6. Court Booking Persistence (/api/court/book)
  const rBook = await request({
    host: 'localhost', port: PORT, path: '/api/court/book', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { timeSlot: '20:00 às 21:00', sport: 'Basquete', bookedBy: 'Equipe Alpha Totem' });
  assert(rBook.status === 200 && rBook.json.success === true && rBook.json.booking.bookedBy === 'Equipe Alpha Totem', 'POST /api/court/book (Criar Reserva e Persistir)');

  const bookingId = rBook.json?.booking?.id;

  // 7. Court Schedule Listing
  const rSchedule = await request({ host: 'localhost', port: PORT, path: '/api/court/schedule', method: 'GET' });
  const hasBooking = rSchedule.json?.bookings?.some(b => b.id === bookingId);
  assert(rSchedule.status === 200 && hasBooking, 'GET /api/court/schedule (Reserva listada na grade da quadra)');

  // 8. Prevent Duplicate Booking
  const rBookDup = await request({
    host: 'localhost', port: PORT, path: '/api/court/book', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { timeSlot: '20:00 às 21:00', sport: 'Vôlei', bookedBy: 'Outro Usuário' });
  assert(rBookDup.status === 409 && rBookDup.json.success === false, 'POST /api/court/book (Prevenção de Horário Conflitante 409)');

  // 9. Cancel Booking via Dev Panel
  if (bookingId) {
    const rCancel = await request({
      host: 'localhost', port: PORT, path: '/api/control', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASS}` }
    }, { action: 'cancel_booking', id: bookingId });
    assert(rCancel.status === 200 && rCancel.json.success === true, 'POST /api/control (Cancelamento de Reserva pelo Dev)');
  }

  // 10. Check state.json on disk
  const statePath = fs.existsSync('state.json') ? 'state.json' : (fs.existsSync('../Servidor1/state.json') ? '../Servidor1/state.json' : 'state.json');
  const stateDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  assert(stateDisk.weeklyActivities && stateDisk.weeklyActivities.length === 3, 'state.json persistido corretamente no disco');

  // 11. Bloquear o painel (logout) apaga o cookie e encerra a sessão
  const rLogout = await request({
    host: 'localhost', port: PORT, path: '/api/auth/logout', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${rAuthCorrect.json.token}`, Cookie: devCookie }
  }, {});
  const clearCookie = [].concat(rLogout.headers['set-cookie'] || []).join(';');
  assert(rLogout.status === 200 && /praca_dev=;/.test(clearCookie) && /Max-Age=0/.test(clearCookie), 'POST /api/auth/logout (apaga o cookie do painel)');
  const rDevAfter = await request({ host: 'localhost', port: PORT, path: '/dev', method: 'GET', headers: { Cookie: devCookie } });
  assert(rDevAfter.status === 200 && !rDevAfter.body.includes('dev-screens-list'), 'GET /dev com o cookie antigo depois do logout (volta à tela de senha)');

  console.log(`\n=== RESULTADO: ${passed} PASSADOS, ${failed} FALHADOS ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error("Erro fatal nos testes:", err);
  process.exit(1);
});
