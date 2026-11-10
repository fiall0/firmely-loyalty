const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { open } = require('../src/db');
const { createService } = require('../src/service');
const { createApp } = require('../src/app');
const { createGoogle } = require('../src/google');

function setup(fail = {}) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, body: opts.body && opts.headers['content-type'] === 'application/json' ? JSON.parse(opts.body) : opts.body });
    const reply = (status, json) => ({ status, ok: status < 300, json: async () => json });
    if (url.includes('oauth2')) return reply(200, { access_token: 'tok', expires_in: 3600 });
    if (url.endsWith('/loyaltyClass')) return reply(fail.class || 200, {});
    if (url.includes('/loyaltyObject/') && fail.object) return reply(fail.object, { error: { message: 'x' } });
    return reply(200, {});
  };
  const holder = {};
  const db = open();
  const svc = createService({ db, secret: 'test', hooks: { customerChanged: (p) => holder.g.hooks.customerChanged(p), notice: (p) => holder.g.hooks.notice(p) } });
  const g = createGoogle({ db, svc, fetchFn, config: { issuerId: '3388000000001', saEmail: 'sa@proj.iam.gserviceaccount.com', privateKey, publicUrl: 'https://x.test' } });
  holder.g = g;
  const { business: b } = svc.createBusiness({ slug: 'undercut', name: 'Undercut' });
  return { svc, b, g, calls, db };
}
const reg = (svc, b, n, phone) => svc.register(b, { name: n, phone, consent: true });
const tick = () => new Promise((r) => setTimeout(r, 30));
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

test('enlace de Google: JWT con el objeto del cliente y la clase creada por la API', async () => {
  const s = setup();
  const { customer, code } = reg(s.svc, s.b, 'Carlos M.', '8095550101');
  const url = await s.g.saveUrl(s.b, customer.id);
  assert.match(url, /^https:\/\/pay\.google\.com\/gp\/v\/save\//);
  const claims = decode(url.split('/save/')[1]);
  assert.equal(claims.iss, 'sa@proj.iam.gserviceaccount.com');
  assert.equal(claims.typ, 'savetowallet');
  const obj = claims.payload.loyaltyObjects[0];
  assert.equal(obj.id, `3388000000001.undercut-${customer.id}`);
  assert.equal(obj.classId, '3388000000001.undercut');
  assert.equal(obj.barcode.value, code);
  assert.equal(obj.loyaltyPoints.balance.string, '0 de 10');
  assert.equal(claims.payload.loyaltyClasses, undefined);
  const cls = s.calls.find((c) => c.url.endsWith('/loyaltyClass'));
  assert.equal(cls.body.programLogo.sourceUri.uri, 'https://x.test/api/undercut/logo.png');
  assert.equal(cls.body.hexBackgroundColor, '#000000');
});

test('si la API de clases falla, la clase viaja dentro del enlace', async () => {
  const s = setup({ class: 403 });
  const { customer } = reg(s.svc, s.b, 'Ana P.', '8095550102');
  const claims = decode((await s.g.saveUrl(s.b, customer.id)).split('/save/')[1]);
  assert.equal(claims.payload.loyaltyClasses[0].id, '3388000000001.undercut');
});

test('una visita actualiza el objeto y avisa; un aviso del admin llega a cada cliente', async () => {
  const s = setup();
  const { customer, code } = reg(s.svc, s.b, 'Carlos M.', '8095550101');
  s.svc.scan(s.b, code, 'caja');
  await tick();
  const patch = s.calls.find((c) => c.method === 'PATCH');
  assert.match(patch.url, /loyaltyObject\/3388000000001\.undercut-1$/);
  assert.equal(patch.body.loyaltyPoints.balance.string, '1 de 10');
  const msg = s.calls.find((c) => c.url.endsWith('/addMessage'));
  assert.equal(msg.body.message.messageType, 'TEXT_AND_NOTIFY');
  assert.match(msg.body.message.body, /Te faltan 9/);

  s.calls.length = 0;
  s.svc.sendNotice(s.b, { audience: 'all', message: 'Sábado 2x1' }, 'admin');
  await tick();
  const aviso = s.calls.find((c) => c.url.endsWith('/addMessage'));
  assert.equal(aviso.body.message.body, 'Sábado 2x1');
  const patch2 = s.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch2.body.textModulesData[1].body, 'Sábado 2x1');
});

test('un cliente sin pase de Android (404) no rompe nada', async () => {
  const s = setup({ object: 404 });
  const { code } = reg(s.svc, s.b, 'Luis G.', '8095550103');
  assert.doesNotThrow(() => s.svc.scan(s.b, code, 'caja'));
  await tick();
});

test('ruta pública redirige al enlace de Google y exige código válido', async () => {
  const s = setup();
  const { code } = reg(s.svc, s.b, 'Ana P.', '8095550104');
  const server = createApp(s.svc, { google: s.g }).listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/undercut/google-wallet`;
    let r = await fetch(`${url}?code=${encodeURIComponent(code)}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    r = await fetch(`${url}?code=undercut.1.falso`, { redirect: 'manual' });
    assert.equal(r.status, 400);
    r = await fetch(`http://127.0.0.1:${server.address().port}/r/undercut`);
    assert.match(await r.text(), /Agregar a Google Wallet/);
  } finally { server.close(); }
});
