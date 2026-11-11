const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { unzipSync } = require('fflate');
const { open } = require('../src/db');
const { createService } = require('../src/service');
const { createApp } = require('../src/app');
const { createApple } = require('../src/apple');
const { createGoogle } = require('../src/google');
const { parseCoords, parseBirthday } = require('../src/settings');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// Martes 10 de noviembre de 2026, mediodía en Santo Domingo (UTC-4).
const TUE_NOON = new Date('2026-11-10T16:00:00Z').getTime();

function setup(extra = {}) {
  let t = TUE_NOON;
  const notices = [];
  const changes = [];
  const db = open();
  const svc = createService({
    db, secret: 'test', now: () => new Date(t),
    hooks: { notice: (p) => notices.push(p), customerChanged: (p) => changes.push(p.reason) },
  });
  const { business: b, keys } = svc.createBusiness({ slug: 'undercut', name: 'Undercut', visitsRequired: 5, minHoursBetweenVisits: 0, ...extra });
  const fresh = () => svc.getBusiness('undercut');
  return { svc, b: () => fresh(), keys, notices, changes, db, advance: (ms) => { t += ms; }, at: (ms) => { t = ms; } };
}
const reg = (svc, b, name, phone, more = {}) => svc.register(b(), { name, phone, consent: true, ...more });

test('parseCoords entiende coordenadas y enlaces de Google Maps; parseBirthday valida', () => {
  assert.deepEqual(parseCoords('18.4861, -69.9312'), { lat: 18.4861, lng: -69.9312 });
  assert.deepEqual(parseCoords('https://www.google.com/maps/place/X/@18.47,-69.91,17z/data=!3d18.4712!4d-69.9123'), { lat: 18.4712, lng: -69.9123 });
  assert.deepEqual(parseCoords('https://maps.google.com/?q=18.5,-69.9'), { lat: 18.5, lng: -69.9 });
  assert.equal(parseCoords('no es un lugar'), null);
  assert.equal(parseCoords('95.1, 10.2'), null, 'latitud fuera de rango');
  assert.equal(parseBirthday('2-29'), '02-29');
  assert.equal(parseBirthday('4-31'), null);
  assert.equal(parseBirthday('13-1'), null);
});

test('métricas: visitas por semana, retorno y cosas por hacer', () => {
  const s = setup();
  const a = reg(s.svc, s.b, 'Ana', '8095550101').customer;
  const l = reg(s.svc, s.b, 'Luis', '8095550102').customer;
  const code = (id) => s.svc.codeFor('undercut', id);
  s.svc.scan(s.b(), code(a.id), 'caja');
  s.advance(8 * DAY);
  s.svc.scan(s.b(), code(a.id), 'caja');
  s.svc.scan(s.b(), code(l.id), 'caja');
  s.advance(DAY);
  for (let i = 0; i < 3; i++) s.svc.scan(s.b(), code(a.id), 'caja'); // llega a 5 = premio esperando
  const m = s.svc.metrics(s.b());
  assert.equal(m.customers, 2);
  assert.equal(m.weekly.length, 8);
  assert.equal(m.weekly[7], 5, 'visitas de la semana actual');
  assert.equal(m.weekly[6], 1, 'visita de la semana pasada');
  assert.equal(m.visits30, 6);
  assert.equal(m.returningRate, 50, 'solo Ana volvió');
  assert.equal(m.rewardsWaiting, 1);
  assert.equal(m.top[0].name, 'Ana');
  assert.equal(m.byWeekday.reduce((x, y) => x + y, 0), 6);
});

test('ajustes por API: solo admin, valida y descarta coordenadas malas; geocode', async () => {
  const s = setup();
  const server = createApp(s.svc, {}).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/undercut`;
  const call = (p, o = {}, key = s.keys.admin) => fetch(url + p, { ...o, headers: { 'content-type': 'application/json', 'x-api-key': key } });
  try {
    assert.equal((await call('/settings', {}, s.keys.staff)).status, 401);
    assert.equal((await call('/metrics', {}, s.keys.staff)).status, 401);
    let r = await call('/settings', { method: 'PATCH', body: JSON.stringify({}) });
    assert.equal(r.status, 400);
    r = await call('/settings', { method: 'PATCH', body: JSON.stringify({
      locations: [{ name: 'Piantini', lat: 18.4861, lng: -69.9312 }, { name: 'Malo', lat: 500, lng: 1 }],
      referral: { enabled: true, referrerBonus: 2 }, doubleDays: { enabled: true, days: [2, 2, 9], multiplier: 3 },
    }) });
    assert.equal(r.status, 200);
    const { settings } = await r.json();
    assert.equal(settings.locations.length, 1);
    assert.deepEqual(settings.doubleDays, { enabled: true, days: [2], multiplier: 3 });
    assert.equal(settings.referral.referrerBonus, 2);
    assert.equal(settings.birthday.enabled, false, 'las opciones vienen apagadas');
    r = await call('/geocode', { method: 'POST', body: JSON.stringify({ text: '18.5, -69.9' }) });
    assert.deepEqual(await r.json(), { lat: 18.5, lng: -69.9 });
    r = await call('/geocode', { method: 'POST', body: JSON.stringify({ text: 'hola' }) });
    assert.equal(r.status, 400);
    r = await call('/geocode', { method: 'POST', body: JSON.stringify({ text: 'https://evil.example.com/x' }) });
    assert.equal(r.status, 400, 'solo enlaces de Google');
    assert.equal((await (await call('/metrics')).json()).customers, 0);
  } finally { server.close(); }
});

test('visita doble: el martes suma 2, otro día suma 1, y nunca pasa de la meta', () => {
  const s = setup();
  s.svc.updateSettings(s.b(), { doubleDays: { enabled: true, days: [2], multiplier: 2 } }, 'admin');
  const c = reg(s.svc, s.b, 'Ana', '8095550101').customer;
  const code = s.svc.codeFor('undercut', c.id);
  let r = s.svc.scan(s.b(), code, 'caja');
  assert.equal(r.customer.visits, 2); assert.equal(r.added, 2); assert.equal(r.doubleDay, true);
  s.advance(DAY); // miércoles
  r = s.svc.scan(s.b(), code, 'caja');
  assert.equal(r.customer.visits, 3); assert.equal(r.added, 1); assert.equal(r.doubleDay, false);
  s.advance(6 * DAY); // martes otra vez: 3 + 2 = 5
  r = s.svc.scan(s.b(), code, 'caja');
  assert.equal(r.customer.visits, 5); assert.equal(r.rewardUnlocked, true);
  s.svc.redeem(s.b(), code, 'caja');
  s.advance(7 * DAY);
  s.svc.scan(s.b(), code, 'caja'); s.advance(7 * DAY); s.svc.scan(s.b(), code, 'caja'); s.advance(7 * DAY);
  r = s.svc.scan(s.b(), code, 'caja');
  assert.equal(r.customer.visits, 5, 'tope en la meta');
  s.svc.updateSettings(s.b(), { doubleDays: { enabled: false, days: [2], multiplier: 2 } }, 'admin');
  assert.equal(s.svc.getSettings(s.b()).doubleDays.enabled, false);
});

test('referidos: se paga al amigo hacer su primera visita, una sola vez; enlace falso o apagado no cuenta', () => {
  const s = setup();
  const ana = reg(s.svc, s.b, 'Ana', '8095550101');
  assert.equal(ana.referralCode, undefined, 'apagado: no hay código');
  s.svc.updateSettings(s.b(), { referral: { enabled: true, referrerBonus: 1, newBonus: 1 } }, 'admin');
  const a2 = reg(s.svc, s.b, 'Ana', '8095550101');
  assert.match(a2.referralCode, /^\d+\.[\w-]{8}$/);
  const forged = reg(s.svc, s.b, 'Falso', '8095550103', { ref: `${ana.customer.id}.AAAAAAAA` });
  assert.equal(s.db.prepare('SELECT referred_by FROM customers WHERE id = ?').get(forged.customer.id).referred_by, null);
  const bea = reg(s.svc, s.b, 'Beatriz Gómez', '8095550102', { ref: a2.referralCode });
  assert.equal(s.svc.getCustomer(s.b(), ana.customer.id).customer.visits, 0, 'aún no visita en caja');
  const r = s.svc.scan(s.b(), bea.code, 'caja');
  assert.equal(r.customer.visits, 2, '1 visita + 1 de bienvenida');
  assert.equal(s.svc.getCustomer(s.b(), ana.customer.id).customer.visits, 1, 'quien invitó gana 1');
  assert.ok(s.notices.some((n) => /Beatriz/.test(n.message) && n.customers[0].id === ana.customer.id), 'se le avisa a quien invitó');
  s.advance(DAY); s.svc.scan(s.b(), bea.code, 'caja');
  assert.equal(s.svc.getCustomer(s.b(), ana.customer.id).customer.visits, 1, 'no se paga dos veces');
});

test('cumpleaños: solo si está activo, se pide al registrar y el regalo se da una vez al año', () => {
  const s = setup();
  const off = reg(s.svc, s.b, 'Sin', '8095550100', { birthday: '11-10' });
  assert.equal(s.db.prepare('SELECT birthday FROM customers WHERE id = ?').get(off.customer.id).birthday, null);
  s.svc.updateSettings(s.b(), { birthday: { enabled: true, bonusVisits: 2 } }, 'admin');
  assert.throws(() => reg(s.svc, s.b, 'Mala', '8095550104', { birthday: '2-31' }), /Cumpleaños/);
  const ana = reg(s.svc, s.b, 'Ana', '8095550101', { birthday: '11-10' }).customer; // hoy es 10 de noviembre
  reg(s.svc, s.b, 'Luis', '8095550102', { birthday: '5-1' });
  let res = s.svc.runAutomations({ force: true });
  assert.equal(res[0].birthday, 1);
  assert.equal(s.svc.getCustomer(s.b(), ana.id).customer.visits, 2);
  assert.ok(s.notices.some((n) => /cumpleaños/.test(n.message)));
  res = s.svc.runAutomations({ force: true });
  assert.equal(res[0].birthday, 0, 'no se repite el mismo día');
  assert.equal(s.svc.getCustomer(s.b(), ana.id).customer.visits, 2);
});

test('avisos automáticos: sin venir, premio esperando, una vez, con tope y solo en horario', () => {
  const s = setup({ maxNoticesPerMonth: 5 });
  const ana = reg(s.svc, s.b, 'Ana', '8095550101').customer;
  const luis = reg(s.svc, s.b, 'Luis', '8095550102').customer;
  s.svc.scan(s.b(), s.svc.codeFor('undercut', ana.id), 'caja');
  for (let i = 0; i < 5; i++) { s.svc.scan(s.b(), s.svc.codeFor('undercut', luis.id), 'caja'); s.advance(HOUR); }
  s.advance(8 * DAY); // Luis tiene el premio esperando hace más de 7 días
  let res = s.svc.runAutomations({ force: true });
  assert.equal(res[0].inactive, 0);
  assert.equal(res[0].rewardWaiting, 1);
  s.advance(28 * DAY); // Ana lleva más de 5 semanas sin venir (y aún no pasan 30 días del aviso del premio)
  res = s.svc.runAutomations({ force: true });
  assert.equal(res[0].inactive, 1);
  assert.equal(res[0].rewardWaiting, 0, 'no repite el aviso del premio en 30 días');
  res = s.svc.runAutomations({ force: true });
  assert.equal(res[0].inactive, 0, 'no repite');
  const before = s.notices.length;
  s.at(new Date('2026-12-30T07:00:00Z').getTime()); // 3 a.m. en Santo Domingo
  assert.deepEqual(s.svc.runAutomations(), [], 'fuera de horario no envía');
  assert.equal(s.notices.length, before);
  s.svc.updateSettings(s.b(), { auto: { inactive: { enabled: false }, rewardWaiting: { enabled: false } } }, 'admin');
  assert.equal(s.svc.getSettings(s.b()).auto.inactive.enabled, false);
});

function certs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'applecert-'));
  const keyPath = path.join(dir, 'key.pem'); const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=test'], { stdio: 'pipe' });
  return { keyPath, certPath, wwdrPath: certPath };
}

test('cercanía y extras llegan a los pases de Apple y Google', async () => {
  const holder = {};
  const db = open();
  const svc = createService({ db, secret: 'test', hooks: { customerChanged: (p) => holder.apple.hooks.customerChanged(p), notice: () => {} } });
  const apple = createApple({ db, svc, secret: 'test', config: { passTypeId: 'pass.com.test', teamId: 'TEAM123456', publicUrl: 'https://x.test', ...certs() }, push: async () => ({ ok: true, status: 200 }) });
  holder.apple = apple;
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const google = createGoogle({ db, svc, fetchFn: async () => ({ status: 200, ok: true, json: async () => ({}) }), config: { issuerId: '3388000000001', saEmail: 'sa@p.iam.gserviceaccount.com', privateKey, publicUrl: 'https://x.test' } });
  const { business } = svc.createBusiness({ slug: 'undercut', name: 'Undercut' });
  const c = svc.register(business, { name: 'Ana', phone: '8095550101', consent: true }).customer;
  const passOf = async () => JSON.parse(Buffer.from(unzipSync(new Uint8Array(await apple.buildPass(svc.getBusiness('undercut'), c.id)))['pass.json']).toString());
  let p = await passOf();
  assert.equal(p.locations, undefined, 'sin locales no hay ubicaciones');
  assert.equal(p.storeCard.backFields.some((f) => f.key === 'invita'), false);
  svc.updateSettings(svc.getBusiness('undercut'), {
    locations: [{ name: 'Piantini', lat: 18.4861, lng: -69.9312 }], proximityText: '¡Pasa por tu corte!',
    referral: { enabled: true, referrerBonus: 1 }, doubleDays: { enabled: true, days: [2, 4], multiplier: 2 },
  }, 'admin');
  p = await passOf();
  assert.deepEqual(p.locations, [{ latitude: 18.4861, longitude: -69.9312, relevantText: '¡Pasa por tu corte!' }]);
  const inv = p.storeCard.backFields.find((f) => f.key === 'invita');
  assert.match(inv.value, /https:\/\/x\.test\/r\/undercut\?ref=\d+\.[\w-]{8}/);
  assert.match(p.storeCard.backFields.find((f) => f.key === 'doble').value, /martes y jueves/);
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id);
  const g = google.objectBody(svc.getBusiness('undercut'), row);
  assert.deepEqual(g.locations, [{ latitude: 18.4861, longitude: -69.9312 }]);
  assert.ok(g.textModulesData.some((m) => m.id === 'invita'));
  assert.ok(db.prepare('SELECT COUNT(*) n FROM pass_changes').get().n >= 1, 'se avisa a los pases instalados');
});

test('la página de registro pide cumpleaños y muestra el enlace de invitar solo si están activos', async () => {
  const s = setup();
  const server = createApp(s.svc, {}).listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    let html = await (await fetch(`${url}/r/undercut`)).text();
    assert.ok(!html.includes('id="bd"') && !html.includes('id="share"'));
    s.svc.updateSettings(s.b(), { birthday: { enabled: true }, referral: { enabled: true } }, 'admin');
    html = await (await fetch(`${url}/r/undercut`)).text();
    assert.ok(html.includes('id="bd"') && html.includes('id="bm"') && html.includes('id="share"'));
    const r = await fetch(`${url}/api/undercut/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ana', phone: '8095550101', consent: true, birthday: '3-9' }) });
    const j = await r.json();
    assert.equal(r.status, 201); assert.ok(j.referralCode);
  } finally { server.close(); }
});
