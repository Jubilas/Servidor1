import http from 'node:http';
import fs from 'node:fs';

const PASS = 'PracaConecta#2026!Dev';

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
  const rIndex = await request({ host: 'localhost', port: 8080, path: '/', method: 'GET' });
  assert(rIndex.status === 200 && rIndex.body.includes('global-broadcast-modal'), 'GET / (Totem Kiosk + Modal Aviso Global)');

  const rDev = await request({ host: 'localhost', port: 8080, path: '/dev', method: 'GET' });
  assert(rDev.status === 200 && rDev.body.includes('auth-modal') && rDev.body.includes('dev-screens-list'), 'GET /dev (Painel Dev + Gate de Senha + Telemetria)');

  const rAgendar = await request({ host: 'localhost', port: 8080, path: '/agendar', method: 'GET' });
  assert(rAgendar.status === 200 && rAgendar.body.includes('slots-container'), 'GET /agendar (App Mobile Agendamento Quadra)');

  // 2. Auth Verification
  const rAuthWrong = await request({
    host: 'localhost', port: 8080, path: '/api/auth/verify', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { password: 'senha_errada_123' });
  assert(rAuthWrong.status === 401 && rAuthWrong.json.success === false, 'POST /api/auth/verify (Senha Incorreta Rejeitada)');

  const rAuthCorrect = await request({
    host: 'localhost', port: 8080, path: '/api/auth/verify', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { password: PASS });
  assert(rAuthCorrect.status === 200 && rAuthCorrect.json.success === true, 'POST /api/auth/verify (Senha Correta Aceita)');

  // 3. Protected Control Endpoints
  const rControlNoAuth = await request({
    host: 'localhost', port: 8080, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { action: 'set_weather', weather: 'night' });
  assert(rControlNoAuth.status === 401, 'POST /api/control sem auth (Bloqueado com 401)');

  const rControlWeather = await request({
    host: 'localhost', port: 8080, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASS}` }
  }, { action: 'set_weather', weather: 'night' });
  assert(rControlWeather.status === 200 && rControlWeather.json.state.weather === 'night', 'POST /api/control (Alterar Clima Noite Yozakura)');

  const rControlPhase = await request({
    host: 'localhost', port: 8080, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASS}` }
  }, { action: 'set_phase', phase: 4 });
  assert(rControlPhase.status === 200 && rControlPhase.json.state.sakuraPhase === 4, 'POST /api/control (Alterar Fase Sakura para 4)');

  const rControlCourt = await request({
    host: 'localhost', port: 8080, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASS}` }
  }, { action: 'set_court', status: 'em_uso', remainingMinutes: 15, activity: 'Basquete 3x3' });
  assert(rControlCourt.status === 200 && rControlCourt.json.state.court.status === 'em_uso', 'POST /api/control (Status da Quadra: em_uso)');

  // 4. Global Broadcast Toast with duration
  const rBroadcast = await request({
    host: 'localhost', port: 8080, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASS}` }
  }, { action: 'toast', title: 'Manutenção Urgente', message: 'Setor leste interditado temporariamente.', duration: '30' });
  assert(rBroadcast.status === 200 && rBroadcast.json.success === true, 'POST /api/control (Aviso Global com Duração 30s)');

  // 5. Weekly Activities Management
  const newActivities = [
    { icon: '🧘', dayTime: 'SÁBADO • 08:00', title: 'Yoga & Meditação Matinal', desc: 'Deck dos Mestres' },
    { icon: '🥕', dayTime: 'SÁBADO • 09:30', title: 'Feirinha Agroecológica', desc: 'Alameda das Cerejeiras' },
    { icon: '🎨', dayTime: 'DOMINGO • 16:00', title: 'Oficina de Desenho Infantil', desc: 'Espaço Conecta Kids' }
  ];
  const rActivities = await request({
    host: 'localhost', port: 8080, path: '/api/control', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASS}` }
  }, { action: 'set_activities', activities: newActivities });
  assert(rActivities.status === 200 && rActivities.json.state.weeklyActivities.length === 3, 'POST /api/control (Gerenciador de Atividades Semanais)');

  // 6. Court Booking Persistence (/api/court/book)
  const rBook = await request({
    host: 'localhost', port: 8080, path: '/api/court/book', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { timeSlot: '20:00 às 21:00', sport: 'Basquete', bookedBy: 'Equipe Alpha Totem' });
  assert(rBook.status === 200 && rBook.json.success === true && rBook.json.booking.bookedBy === 'Equipe Alpha Totem', 'POST /api/court/book (Criar Reserva e Persistir)');

  const bookingId = rBook.json?.booking?.id;

  // 7. Court Schedule Listing
  const rSchedule = await request({ host: 'localhost', port: 8080, path: '/api/court/schedule', method: 'GET' });
  const hasBooking = rSchedule.json?.bookings?.some(b => b.id === bookingId);
  assert(rSchedule.status === 200 && hasBooking, 'GET /api/court/schedule (Reserva listada na grade da quadra)');

  // 8. Prevent Duplicate Booking
  const rBookDup = await request({
    host: 'localhost', port: 8080, path: '/api/court/book', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { timeSlot: '20:00 às 21:00', sport: 'Vôlei', bookedBy: 'Outro Usuário' });
  assert(rBookDup.status === 409 && rBookDup.json.success === false, 'POST /api/court/book (Prevenção de Horário Conflitante 409)');

  // 9. Cancel Booking via Dev Panel
  if (bookingId) {
    const rCancel = await request({
      host: 'localhost', port: 8080, path: '/api/control', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASS}` }
    }, { action: 'cancel_booking', id: bookingId });
    assert(rCancel.status === 200 && rCancel.json.success === true, 'POST /api/control (Cancelamento de Reserva pelo Dev)');
  }

  // 10. Check state.json on disk
  const stateDisk = JSON.parse(fs.readFileSync('state.json', 'utf-8'));
  assert(stateDisk.weeklyActivities && stateDisk.weeklyActivities.length === 3, 'state.json persistido corretamente no disco');

  console.log(`\n=== RESULTADO: ${passed} PASSADOS, ${failed} FALHADOS ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error("Erro fatal nos testes:", err);
  process.exit(1);
});
