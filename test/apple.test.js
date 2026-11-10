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

// Certificado autofirmado solo para pruebas (no es de Apple).
function testCerts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'applecert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=test'], { stdio: 'pipe' });
  return { dir, keyPath: key, certPath: cert, wwdrPath: cert };
}

async function setup() {
  const certs = testCerts();
  let t = new Date('2026-11-09T12:00:00Z').getTime();
  const pushes = [];
  const holder = {};
  const db = open();
  const svc = createService({
    db, secret: 'test', now: () => new Date(t),
    hooks: { customerChanged: (p) => holder.apple.hooks.customerChanged(p), notice: (p) => holder.apple.hooks.notice(p) },
  });
  const apple = createApple({
    db, svc, secret: 'test',
    config: { passTypeId: 'pass.com.test', teamId: 'TEAM123456', publicUrl: 'https://x.test', ...certs },
    push: async (tok) => { pushes.push(tok); return { ok: true, status: 200 }; },
  });
  holder.apple = apple;
  const { business: b, keys } = svc.createBusiness({ slug: 'undercut', name: 'Undercut' });
  const server = createApp(svc, { apple }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  return { svc, b, keys, apple, pushes, url, server, advance: (h) => { t += h * 3600 * 1000; }, certs };
}
const reg = (svc, b, n, phone) => svc.register(b, { name: n, phone, consent: true });

test('el .pkpass trae archivos, manifest correcto y firma válida', async () => {
  const s = await setup();
  try {
    const { customer, code } = reg(s.svc, s.b, 'Carlos M.', '8095550101');
    const buf = await s.apple.buildPass(s.b, customer.id);
    const files = unzipSync(new Uint8Array(buf));
    for (const f of ['pass.json', 'manifest.json', 'signature', 'icon.png', 'icon@2x.png', 'strip.png', 'strip@2x.png', 'strip@3x.png']) {
      assert.ok(files[f], `falta ${f}`);
    }
    const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString());
    for (const [name, hash] of Object.entries(manifest)) {
      assert.equal(crypto.createHash('sha1').update(files[name]).digest('hex'), hash, name);
    }
    const pass = JSON.parse(Buffer.from(files['pass.json']).toString());
    assert.equal(pass.passTypeIdentifier, 'pass.com.test');
    assert.equal(pass.teamIdentifier, 'TEAM123456');
    assert.equal(pass.serialNumber, `undercut-${customer.id}`);
    assert.equal(pass.barcodes[0].message, code);
    assert.equal(pass.storeCard.headerFields[0].value, '0 de 10');
    assert.equal(pass.backgroundColor, 'rgb(0, 0, 0)');
    // firma desprendida verificable
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
    fs.writeFileSync(path.join(d, 'sig'), files.signature);
    fs.writeFileSync(path.join(d, 'm'), files['manifest.json']);
    execFileSync('openssl', ['smime', '-verify', '-inform', 'DER', '-in', path.join(d, 'sig'), '-content', path.join(d, 'm'), '-noverify', '-out', path.join(d, 'out')], { stdio: 'pipe' });
  } finally { s.server.close(); }
});

test('servicio web: registro, cambios, descarga y baja de un dispositivo', async () => {
  const s = await setup();
  try {
    const { customer } = reg(s.svc, s.b, 'Carlos M.', '8095550101');
    const serial = `undercut-${customer.id}`;
    const auth = { authorization: `ApplePass ${s.apple.tokenFor(serial)}`, 'content-type': 'application/json' };
    const regUrl = `${s.url}/apple/v1/devices/dev1/registrations/pass.com.test`;

    let r = await fetch(`${regUrl}/${serial}`, { method: 'POST', headers: auth, body: JSON.stringify({ pushToken: 'tok1' }) });
    assert.equal(r.status, 201);
    r = await fetch(`${regUrl}/${serial}`, { method: 'POST', headers: auth, body: JSON.stringify({ pushToken: 'tok1' }) });
    assert.equal(r.status, 200);
    r = await fetch(`${regUrl}/${serial}`, { method: 'POST', headers: { ...auth, authorization: 'ApplePass malo' }, body: JSON.stringify({ pushToken: 'x' }) });
    assert.equal(r.status, 401);

    // Sin cambios todavía desde el registro: se piden los pases cambiados desde el inicio
    r = await fetch(regUrl);
    assert.equal(r.status, 204);

    // Una visita cambia el pase y manda push
    const code = s.svc.codeFor('undercut', customer.id);
    s.svc.scan(s.b, code, 'caja');
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(s.pushes, ['tok1']);
    r = await fetch(regUrl);
    assert.equal(r.status, 200);
    const list = await r.json();
    assert.deepEqual(list.serialNumbers, [serial]);
    r = await fetch(`${regUrl}?passesUpdatedSince=${list.lastUpdated}`);
    assert.equal(r.status, 204);

    // Descarga del pase actualizado
    r = await fetch(`${s.url}/apple/v1/passes/pass.com.test/${serial}`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/vnd.apple.pkpass');
    const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
    const pass = JSON.parse(Buffer.from(files['pass.json']).toString());
    assert.equal(pass.storeCard.headerFields[0].value, '1 de 10');
    assert.match(pass.storeCard.backFields[0].value, /Te faltan 9/);

    // Aviso del admin: cambia "Último aviso" y vuelve a mandar push
    s.pushes.length = 0;
    s.svc.sendNotice(s.b, { audience: 'all', message: 'Te extrañamos: pasa esta semana' }, 'admin');
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(s.pushes, ['tok1']);
    r = await fetch(`${s.url}/apple/v1/passes/pass.com.test/${serial}`, { headers: auth });
    const f2 = unzipSync(new Uint8Array(await r.arrayBuffer()));
    assert.equal(JSON.parse(Buffer.from(f2['pass.json']).toString()).storeCard.backFields[1].value, 'Te extrañamos: pasa esta semana');

    // Baja
    r = await fetch(`${regUrl}/${serial}`, { method: 'DELETE', headers: auth });
    assert.equal(r.status, 200);
    s.pushes.length = 0;
    s.advance(5);
    s.svc.scan(s.b, code, 'caja');
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(s.pushes, []);
  } finally { s.server.close(); }
});

test('descarga pública del pase exige un código firmado válido', async () => {
  const s = await setup();
  try {
    const { code } = reg(s.svc, s.b, 'Ana P.', '8095550102');
    let r = await fetch(`${s.url}/api/undercut/pass.pkpass?code=${encodeURIComponent(code)}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/vnd.apple.pkpass');
    r = await fetch(`${s.url}/api/undercut/pass.pkpass?code=undercut.1.falso`);
    assert.equal(r.status, 400);
  } finally { s.server.close(); }
});

test('si el negocio tiene logo, el pase lo incluye junto al nombre', async () => {
  const s = await setup();
  try {
    const { customer } = reg(s.svc, s.b, 'Carlos M.', '8095550101');
    const files = unzipSync(new Uint8Array(await s.apple.buildPass(s.b, customer.id)));
    for (const f of ['logo.png', 'logo@2x.png', 'logo@3x.png']) assert.ok(files[f], f);
    assert.equal(JSON.parse(Buffer.from(files['pass.json']).toString()).logoText, 'UNDERCUT');
  } finally { s.server.close(); }
});

test('páginas de registro y caja responden', async () => {
  const s = await setup();
  try {
    let r = await fetch(`${s.url}/r/undercut`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Agregar a Apple Wallet/);
    assert.match(html, /Undercut/);
    r = await fetch(`${s.url}/caja/undercut`);
    assert.equal(r.status, 200);
    r = await fetch(`${s.url}/r/noexiste`);
    assert.equal(r.status, 404);
  } finally { s.server.close(); }
});

test('panel de admin y logo público', async () => {
  const s = await setup();
  try {
    let r = await fetch(`${s.url}/admin/undercut`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Panel del negocio/);
    assert.doesNotMatch(html, /__NAME__|__SLUG__/);
    r = await fetch(`${s.url}/api/undercut/logo.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
  } finally { s.server.close(); }
});
