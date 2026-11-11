const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const jsQR = require('jsqr');
const { open } = require('../src/db');
const { createService } = require('../src/service');
const { createApp } = require('../src/app');

async function decode(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
}

test('cartel y QR de registro: se descargan y el QR lleva al registro del negocio', async () => {
  const svc = createService({ db: open(), secret: 'test' });
  svc.createBusiness({ slug: 'agape', name: 'Ágape', reward: 'Café gratis', brand: { bg: '#24417D', fg: '#FFFFFF', icon: 'cup' } });
  const server = createApp(svc, {}).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/api/agape/qr.png`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /image\/png/);
    assert.equal(await decode(Buffer.from(await r.arrayBuffer())), `${base}/r/agape`);

    r = await fetch(`${base}/api/agape/poster.png?w=1240&download=1`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /cartel-agape\.png/);
    const poster = Buffer.from(await r.arrayBuffer());
    assert.equal((await sharp(poster).metadata()).width, 1240);
    assert.equal(await decode(poster), `${base}/r/agape`);

    r = await fetch(`${base}/api/agape/qr.svg`);
    assert.match(r.headers.get('content-type'), /svg/);
    assert.match(await r.text(), /<svg/);

    assert.equal((await fetch(`${base}/api/noexiste/poster.png`)).status, 404);
    assert.match(await (await fetch(`${base}/admin/agape`)).text(), /data-tab="cartel"/);
  } finally { server.close(); }
});
