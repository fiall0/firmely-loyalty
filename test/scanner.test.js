const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createService } = require('../src/service');
const { createApp } = require('../src/app');

test('escáner: páginas de caja y admin lo cargan y el servidor entrega los scripts', async () => {
  const db = open();
  const svc = createService({ db, secret: 'test' });
  svc.createBusiness({ slug: 'agape', name: 'Ágape', reward: 'Café gratis', brand: { bg: '#24417D', fg: '#FFFFFF', icon: 'cup' } });
  const server = createApp(svc, {}).listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ['/vendor/scanner.js', '/vendor/jsqr.js']) {
      const r = await fetch(url + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /javascript/);
    }
    const caja = await (await fetch(`${url}/caja/agape`)).text();
    assert.match(caja, /vendor\/scanner\.js/);
    assert.match(caja, /Escanear QR/);
    assert.match(caja, /--bg:#24417D/);
    const admin = await (await fetch(`${url}/admin/agape`)).text();
    assert.match(admin, /vendor\/scanner\.js/);
    assert.match(admin, /id="scanBtn"/);
    assert.match(admin, /--bg:#24417D/);
  } finally { server.close(); }
});
