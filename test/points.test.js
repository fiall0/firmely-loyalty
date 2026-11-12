const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('../src/db');
const { createService } = require('../src/service');
const { createApp } = require('../src/app');

const KEY = 'llave-firmely-de-prueba';
function boot() {
  process.env.LOGOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'logos-'));
  const svc = createService({ db: open(), secret: 'test', hooks: {} });
  const server = createApp(svc, { firmelyKey: KEY }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const j = async (method, p, body, key) => {
    const res = await fetch(url + p, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-firmely-key': key } : {}), ...(p.startsWith('/api/') ? { 'x-api-key': body && body._k } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : null, res };
  };
  return { svc, server, url, j };
}
const REWARDS = [{ name: 'Postre gratis', cost: 80 }, { name: 'Bebida gratis', cost: 50 }, { name: 'Desayuno gratis', cost: 150 }];

test('crear negocio de puntos desde el panel, sumar por monto y canjear', async () => {
  const t = boot();
  try {
    const c = await t.j('POST', '/firmely/api/businesses', { name: 'Cafetería Santos', slug: 'cafeteria-santos', mode: 'points', points: { pesosPerPoint: 100, rewards: REWARDS } }, KEY);
    assert.equal(c.status, 201);
    assert.equal(c.body.business.mode, 'points');
    assert.deepEqual(c.body.business.points.rewards.map((r) => r.cost), [50, 80, 150]); // ordenados
    assert.equal(c.body.business.visitsRequired, 50);
    const staff = c.body.keys.staff;
    const api = (m, p, b) => t.j(m, `/api/cafeteria-santos${p}`, { ...(b || {}), _k: staff });
    const info = await t.j('GET', '/api/cafeteria-santos/info', null);
    assert.equal(info.body.mode, 'points');
    const reg = await t.j('POST', '/api/cafeteria-santos/register', { name: 'Ana Pérez', phone: '8095551234', consent: true });
    assert.equal(reg.status, 201);
    const code = reg.body.code;
    assert.equal(reg.body.customer.mode, 'points');
    // sin monto -> 400; monto chico -> too_small
    assert.equal((await api('POST', '/scan', { code })).status, 400);
    assert.equal((await api('POST', '/scan', { code, amount: 60 })).body.status, 'too_small');
    // RD$ 4,550 -> 45 puntos
    let s = await api('POST', '/scan', { code, amount: 4550 });
    assert.equal(s.body.status, 'visit'); assert.equal(s.body.added, 45); assert.equal(s.body.customer.points, 45);
    assert.equal(s.body.rewardUnlocked, false);
    // otra compra de RD$ 1,000 -> 55 pts, desbloquea bebida
    s = await api('POST', '/scan', { code, amount: 1000 });
    assert.equal(s.body.customer.points, 55); assert.equal(s.body.rewardUnlocked, true);
    assert.deepEqual(s.body.customer.rewards.filter((r) => r.affordable).map((r) => r.name), ['Bebida gratis']);
    // canje: sin premio -> 400, caro -> 409, bueno resta
    assert.equal((await api('POST', '/redeem', { code })).status, 400);
    const post = s.body.customer.rewards.find((r) => r.name === 'Postre gratis');
    assert.equal((await api('POST', '/redeem', { code, rewardId: post.id })).status, 409);
    const drink = s.body.customer.rewards.find((r) => r.name === 'Bebida gratis');
    const r = await api('POST', '/redeem', { code, rewardId: drink.id });
    assert.equal(r.body.customer.points, 5); assert.equal(r.body.customer.rewardsRedeemed, 1);
    // solo consulta
    assert.equal((await api('POST', '/scan', { code, amount: 0 })).body.status, 'lookup');
    // páginas e imagen
    const strip = await fetch(`${t.url}/api/cafeteria-santos/stamp/5.png?scale=2`);
    assert.equal(strip.status, 200); assert.equal(strip.headers.get('content-type'), 'image/png');
    assert.match(await (await fetch(`${t.url}/r/cafeteria-santos`)).text(), /1 punto por cada RD\$100/);
    assert.match(await (await fetch(`${t.url}/caja/cafeteria-santos`)).text(), /Monto de la compra/);
  } finally { t.server.close(); }
});

test('validaciones de puntos y cambio de tipo reinicia saldos', async () => {
  const t = boot();
  try {
    const bad = await t.j('POST', '/firmely/api/businesses', { name: 'Café X', slug: 'cafe-x', mode: 'points', points: { pesosPerPoint: 100, rewards: [] } }, KEY);
    assert.equal(bad.status, 400);
    assert.equal((await t.j('GET', '/firmely/api/businesses', null, KEY)).body.businesses.length, 0); // no deja basura
    const c = await t.j('POST', '/firmely/api/businesses', { name: 'Café Y', slug: 'cafe-y' }, KEY);
    assert.equal(c.body.business.mode, 'stamps');
    const p = await t.j('PATCH', '/firmely/api/businesses/cafe-y', { mode: 'points', points: { pesosPerPoint: 50, rewards: REWARDS } }, KEY);
    assert.equal(p.body.business.mode, 'points'); assert.equal(p.body.business.points.pesosPerPoint, 50);
    assert.equal((await t.j('PATCH', '/firmely/api/businesses/cafe-y', { points: { rewards: [{ name: 'x', cost: 0 }] } }, KEY)).status, 400);
    const back = await t.j('PATCH', '/firmely/api/businesses/cafe-y', { mode: 'stamps', visitsRequired: 8, reward: 'Café gratis' }, KEY);
    assert.equal(back.body.business.mode, 'stamps');
  } finally { t.server.close(); }
});
