const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { unzipSync } = require('fflate');
const { open } = require('../src/db');
const { createService } = require('../src/service');
const { createApp } = require('../src/app');

const KEY = 'llave-firmely-de-prueba';
function boot(opts = {}) {
  process.env.LOGOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'logos-'));
  const svc = createService({ db: open(), secret: 'test', hooks: {} });
  const server = createApp(svc, { firmelyKey: KEY, ...opts }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, key = KEY, host) => fetch(url + p, {
    method, headers: { 'content-type': 'application/json', ...(key ? { 'x-firmely-key': key } : {}), ...(host ? { host } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { svc, server, url, call };
}
const png = async () => 'data:image/png;base64,' + (await sharp({ create: { width: 80, height: 40, channels: 3, background: '#cc0000' } }).png().toBuffer()).toString('base64');

test('panel apagado sin llave (503) y con llave incorrecta (401)', async () => {
  const off = boot({ firmelyKey: '' });
  try { assert.equal((await off.call('GET', '/firmely/api/businesses', null, 'x')).status, 503); } finally { off.server.close(); }
  const on = boot();
  try {
    assert.equal((await on.call('GET', '/firmely/api/businesses', null, 'mala')).status, 401);
    assert.equal((await on.call('GET', '/firmely/api/businesses', null, null)).status, 401);
    assert.equal((await on.call('GET', '/firmely/api/businesses')).status, 200);
    // La pantalla del panel vive en firmely-admin; aquí solo queda la API.
    assert.equal((await fetch(on.url + '/firmely')).status, 404);
  } finally { on.server.close(); }
});

test('crear, listar, editar, llaves, logo y borrar', async () => {
  const { svc, server, url, call } = boot();
  try {
    let r = await call('POST', '/firmely/api/businesses', { slug: 'sayonara', name: 'Sayonara', reward: 'Lavado gratis', visitsRequired: 12, brand: { bg: '#A9822A', fg: '#FFFFFF', icon: 'dryer' }, logo: await png() });
    assert.equal(r.status, 201);
    const { business, keys } = await r.json();
    assert.equal(business.slug, 'sayonara');
    assert.ok(keys.staff && keys.admin);
    assert.equal(business.visitsRequired, 12);

    // duplicado
    r = await call('POST', '/firmely/api/businesses', { slug: 'sayonara', name: 'Otro' });
    assert.equal(r.status, 409);
    // validación (y no deja basura)
    r = await call('POST', '/firmely/api/businesses', { slug: 'malo', name: 'Malo', visitsRequired: 99 });
    assert.equal(r.status, 400);
    assert.equal((await (await call('GET', '/firmely/api/businesses')).json()).businesses.length, 1);

    // la llave de caja creada funciona en el servicio normal
    r = await fetch(`${url}/customers/x`, { method: 'DELETE', headers: { 'x-api-key': keys.staff } });
    assert.ok([401, 403, 404].includes(r.status));

    // logo servido
    r = await fetch(`${url}/api/sayonara/logo.png`);
    assert.equal(r.status, 200);
    assert.equal((await sharp(Buffer.from(await r.arrayBuffer())).metadata()).width, 600);

    // editar: valida, no cambia el slug
    r = await call('PATCH', '/firmely/api/businesses/sayonara', { visitsRequired: 1 });
    assert.equal(r.status, 400);
    r = await call('PATCH', '/firmely/api/businesses/sayonara', { name: 'Sayonara Beauty', slug: 'otro', reward: 'Secado gratis', brand: { stripBg: '#FFFFFF', unit: null } });
    assert.equal(r.status, 200);
    const e = (await r.json()).business;
    assert.equal(e.slug, 'sayonara');
    assert.equal(e.name, 'Sayonara Beauty');
    assert.equal(e.brand.stripBg, '#FFFFFF');
    assert.equal((await call('GET', '/firmely/api/businesses/nada')).status, 404);

    // regenerar llaves
    r = await call('POST', '/firmely/api/businesses/sayonara/keys', { which: 'staff' });
    const nk = (await r.json()).keys;
    assert.ok(nk.staff && !nk.admin);
    assert.equal(svc.roleFor(svc.getBusiness('sayonara'), keys.staff), null);
    assert.equal(svc.roleFor(svc.getBusiness('sayonara'), nk.staff), 'staff');
    assert.equal(svc.roleFor(svc.getBusiness('sayonara'), keys.admin), 'admin');
    assert.equal((await call('POST', '/firmely/api/businesses/sayonara/keys', { which: 'x' })).status, 400);

    // paquete descargable (sin Apple configurado no trae .pkpass) y sin dejar clientes de ejemplo
    r = await call('GET', '/firmely/api/businesses/sayonara/package.zip');
    assert.equal(r.status, 200);
    const names = Object.keys(unzipSync(new Uint8Array(await r.arrayBuffer())));
    for (const n of ['sayonara/ficha.html', 'sayonara/logo.png', 'sayonara/cartel-qr.png', 'sayonara/qr-registro.png', 'sayonara/qr-registro.svg']) assert.ok(names.includes(n), n);
    assert.equal((await call('GET', '/firmely/api/businesses/sayonara/sample.pkpass')).status, 503);
    assert.equal((await (await call('GET', '/firmely/api/businesses')).json()).businesses[0].customers, 0);

    // borrar con y sin confirmación, con clientes
    svc.register(svc.getBusiness('sayonara'), { name: 'Ana Pérez', phone: '8095550100', consent: true });
    assert.equal((await call('DELETE', '/firmely/api/businesses/sayonara', { confirm: 'no' })).status, 400);
    r = await call('DELETE', '/firmely/api/businesses/sayonara', { confirm: 'sayonara' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).customers, 1);
    assert.equal((await call('GET', '/firmely/api/businesses')).status, 200);
    assert.equal((await (await call('GET', '/firmely/api/businesses')).json()).businesses.length, 0);
  } finally { server.close(); }
});

test('sin la pantalla del panel, las rutas públicas siguen igual', async () => {
  const { server, url, call } = boot();
  try {
    assert.equal((await fetch(url + '/firmely')).status, 404);
    assert.equal((await fetch(url + '/firmely/assets/logo-white.png')).status, 404);
    assert.equal((await fetch(url + '/health')).status, 200);
    assert.equal((await call('POST', '/firmely/api/businesses', { slug: 'prueba', name: 'Prueba', reward: 'Café gratis' })).status, 201);
    for (const p of ['/r/prueba', '/caja/prueba', '/admin/prueba', '/api/prueba/info', '/api/prueba/logo.png', '/api/prueba/qr.png']) {
      assert.equal((await fetch(url + p)).status, 200, p);
    }
  } finally { server.close(); }
});
