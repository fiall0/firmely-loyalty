const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createService } = require('../src/service');
const { createApp } = require('../src/app');

function setup() {
  let t = new Date('2026-11-09T12:00:00Z').getTime();
  const clock = { now: () => new Date(t), advance: (h) => { t += h * 3600 * 1000; } };
  const calls = [];
  const svc = createService({
    db: open(), secret: 'test', now: clock.now,
    hooks: { customerChanged: (p) => calls.push(['c', p.reason, p.customer.visits]), notice: (p) => calls.push(['n', p.customers.length]) },
  });
  const { business: b, keys } = svc.createBusiness({ slug: 'undercut', name: 'Undercut' });
  return { svc, b, keys, clock, calls };
}
const reg = (svc, b, n, phone) => svc.register(b, { name: n, phone, consent: true });

test('registro: normaliza teléfono, exige consentimiento y no duplica', () => {
  const { svc, b } = setup();
  const a = reg(svc, b, 'Carlos M.', '(809) 555-0101');
  assert.equal(a.customer.phone, '809 555 0101');
  assert.equal(a.existing, false);
  const again = reg(svc, b, 'Otro nombre', '1-809-555-0101');
  assert.equal(again.existing, true);
  assert.equal(again.customer.id, a.customer.id);
  assert.throws(() => svc.register(b, { name: 'X Y', phone: '8095550101', consent: false }), /datos/);
  assert.throws(() => reg(svc, b, 'Ana', '123'), /Teléfono/);
});

test('escaneo suma visita, bloquea repetidos y desbloquea el premio en la 10', () => {
  const { svc, b, clock } = setup();
  const { code } = reg(svc, b, 'Carlos M.', '8095550101');
  let r = svc.scan(b, code, 'caja');
  assert.equal(r.status, 'visit');
  assert.equal(r.customer.visits, 1);
  r = svc.scan(b, code, 'caja');
  assert.equal(r.status, 'too_soon');
  assert.equal(r.customer.visits, 1);
  for (let i = 2; i <= 10; i++) { clock.advance(5); r = svc.scan(b, code, 'caja'); }
  assert.equal(r.customer.visits, 10);
  assert.equal(r.rewardUnlocked, true);
  clock.advance(5);
  assert.equal(svc.scan(b, code, 'caja').status, 'free_available');
});

test('canje: solo con 10 visitas, reinicia y cuenta el corte gratis', () => {
  const { svc, b, clock } = setup();
  const { code, customer } = reg(svc, b, 'Luis G.', '8295550102');
  assert.throws(() => svc.redeem(b, code, 'caja'), /Aún no/);
  for (let i = 0; i < 10; i++) { svc.scan(b, code, 'caja'); clock.advance(5); }
  const out = svc.redeem(b, code, 'caja');
  assert.equal(out.customer.visits, 0);
  assert.equal(out.customer.rewardsRedeemed, 1);
  assert.equal(svc.getCustomer(b, customer.id).events[0].kind, 'redeem');
});

test('QR alterado o de otro negocio se rechaza', () => {
  const { svc, b } = setup();
  const { code } = reg(svc, b, 'Carlos M.', '8095550101');
  const bad = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
  assert.throws(() => svc.scan(b, bad, 'caja'), /Código/);
  assert.throws(() => svc.scan(b, 'undercut.999.xxxx', 'caja'), /Código/);
  const other = svc.createBusiness({ slug: 'otra', name: 'Otra' }).business;
  assert.throws(() => svc.scan(other, code, 'caja'), /Código/);
});

test('admin: buscar, editar, validar y reiniciar con bitácora', () => {
  const { svc, b, calls } = setup();
  const c1 = reg(svc, b, 'Carlos M.', '8095550101').customer;
  const c2 = reg(svc, b, 'Luis G.', '8295550102').customer;
  assert.equal(svc.listCustomers(b, 'carl').length, 1);
  assert.equal(svc.listCustomers(b, '555 0102')[0].id, c2.id);
  assert.equal(svc.listCustomers(b, 'zzz').length, 0);
  assert.equal(svc.listCustomers(b, '').length, 2);

  const up = svc.updateCustomer(b, c1.id, { name: 'Carlos Méndez', phone: '8495550199', visits: 7 }, 'admin');
  assert.equal(up.customer.name, 'Carlos Méndez');
  assert.equal(up.customer.phone, '849 555 0199');
  assert.equal(up.customer.visits, 7);
  assert.throws(() => svc.updateCustomer(b, c1.id, { phone: '8295550102' }, 'admin'), /otro cliente/);
  assert.throws(() => svc.updateCustomer(b, c1.id, { visits: 11 }, 'admin'), /entre 0 y 10/);
  assert.throws(() => svc.updateCustomer(b, c1.id, { visits: 2.5 }, 'admin'), /entre 0 y 10/);
  assert.throws(() => svc.updateCustomer(b, c1.id, {}, 'admin'), /cambios/);

  const rs = svc.resetVisits(b, c1.id, 'admin');
  assert.equal(rs.customer.visits, 0);
  const kinds = svc.getCustomer(b, c1.id).events.map((e) => e.kind);
  assert.deepEqual(kinds.slice(0, 2), ['reset', 'edit']);
  assert.ok(calls.some((c) => c[1] === 'reset'));
});

test('avisos: audiencias, conteo previo y tope mensual', () => {
  const { svc, b, clock, calls } = setup();
  const a = reg(svc, b, 'Carlos M.', '8095550101');
  const l = reg(svc, b, 'Luis G.', '8295550102');
  reg(svc, b, 'Andrés R.', '8495550103');
  svc.scan(b, a.code, 'caja');                       // Carlos: 1 visita, hoy
  svc.updateCustomer(b, l.customer.id, { visits: 8 }, 'admin');
  svc.scan(b, l.code, 'caja');                       // Luis: 9 visitas, hoy

  assert.equal(svc.sendNotice(b, { audience: 'all', dryRun: true }).sent, 3);
  assert.equal(svc.sendNotice(b, { audience: 'near_reward', dryRun: true }).sent, 1);
  assert.equal(svc.sendNotice(b, { audience: 'inactive', dryRun: true }).sent, 0);
  clock.advance(24 * 7 * 6);                         // pasan 6 semanas
  assert.equal(svc.sendNotice(b, { audience: 'inactive', weeks: 5, dryRun: true }).sent, 2);

  assert.throws(() => svc.sendNotice(b, { audience: 'all', message: '' }, 'admin'), /mensaje/);
  assert.throws(() => svc.sendNotice(b, { audience: 'all', message: 'x'.repeat(81) }, 'admin'), /mensaje/);
  assert.throws(() => svc.sendNotice(b, { audience: 'nadie', message: 'hola' }, 'admin'), /Audiencia/);

  assert.equal(svc.sendNotice(b, { audience: 'all', message: 'Aviso 1' }, 'admin').sent, 3);
  assert.equal(svc.sendNotice(b, { audience: 'all', message: 'Aviso 2' }, 'admin').sent, 3);
  const third = svc.sendNotice(b, { audience: 'all', message: 'Aviso 3' }, 'admin');
  assert.equal(third.sent, 0);
  assert.equal(third.skippedCapped, 3);
  assert.deepEqual(calls.filter((c) => c[0] === 'n').map((c) => c[1]), [3, 3, 0]);
  clock.advance(24 * 31);                            // pasa el mes: se libera el tope
  assert.equal(svc.sendNotice(b, { audience: 'all', message: 'Aviso 4' }, 'admin').sent, 3);
});

test('HTTP: permisos por rol y flujo completo', async () => {
  const { svc, keys } = setup();
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/undercut`;
  const call = async (path, { method = 'GET', key, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    const reg1 = await call('/register', { method: 'POST', body: { name: 'Carlos M.', phone: '8095550101', consent: true } });
    assert.equal(reg1.status, 201);
    const code = reg1.json.code;
    assert.equal((await call('/scan', { method: 'POST', body: { code } })).status, 401);
    assert.equal((await call('/scan', { method: 'POST', key: 'mala', body: { code } })).status, 401);
    const scan = await call('/scan', { method: 'POST', key: keys.staff, body: { code } });
    assert.equal(scan.status, 200);
    assert.equal(scan.json.customer.visits, 1);
    assert.equal((await call('/customers', { key: keys.staff })).status, 401);
    const list = await call('/customers?q=carlos', { key: keys.admin });
    assert.equal(list.json.customers.length, 1);
    const id = list.json.customers[0].id;
    const patch = await call(`/customers/${id}`, { method: 'PATCH', key: keys.admin, body: { visits: 99 } });
    assert.equal(patch.status, 400);
    assert.equal((await call(`/customers/${id}/reset`, { method: 'POST', key: keys.admin })).json.customer.visits, 0);
    assert.equal((await call('/stats', { key: keys.admin })).json.customers, 1);
    assert.equal((await call('/info')).json.name, 'Undercut');
    assert.equal((await fetch(base.replace('undercut', 'nadie') + '/info')).status, 404);
  } finally {
    server.close();
  }
});

test('sellos: PNG con el tamaño correcto y colores de marca', async () => {
  const sharp = require('sharp');
  const stamps = require('../src/stamps');
  const strip = await stamps.render('strip', 7, { scale: 2 });
  const m = await sharp(strip).metadata();
  assert.equal(m.format, 'png');
  assert.deepEqual([m.width, m.height], [750, 246]);
  const hero = await stamps.render('hero', 0);
  assert.deepEqual([(await sharp(hero).metadata()).width, (await sharp(hero).metadata()).height], [1032, 336]);
  const files = await stamps.appleStripFiles(3);
  assert.deepEqual(Object.keys(files), ['strip.png', 'strip@2x.png', 'strip@3x.png']);
  assert.equal((await sharp(files['strip@3x.png']).metadata()).width, 1125);
  // La franja es el color de la marca aclarado un 8% hacia el color del texto; un color inválido cae al predeterminado.
  const red = await sharp(await stamps.render('strip', 0, { brand: { bg: '#FF0000', fg: '#FFFFFF' } })).raw().toBuffer();
  assert.deepEqual([red[0], red[1], red[2]], [255, 20, 20]);
  const bad = await sharp(await stamps.render('strip', 0, { brand: { bg: 'rojo' } })).raw().toBuffer();
  assert.deepEqual([bad[0], bad[1], bad[2]], [20, 20, 20]);
  await assert.rejects(() => stamps.render('strip', 11), /fuera de rango/);
});

test('HTTP: ruta pública de sellos', async () => {
  const { svc } = setup();
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/undercut`;
  try {
    const ok = await fetch(`${base}/stamp/7.png?scale=2`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.ok((await ok.arrayBuffer()).byteLength > 500);
    assert.equal((await fetch(`${base}/stamp/11.png`)).status, 400);
    assert.equal((await fetch(`${base}/stamp/abc`)).status, 400);
    assert.equal((await fetch(`${base}/stamp/3?kind=hero`)).status, 200);
    assert.equal((await fetch(`${base}/stamp/3?scale=9`)).status, 400);
  } finally { server.close(); }
});
