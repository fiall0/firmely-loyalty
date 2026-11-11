const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createService } = require('../src/service');
const { statusText, unitsOf } = require('../src/text');
const poster = require('../src/poster');

test('unidad personalizada (lavadas): textos, 12 sellos y cartel', async () => {
  const svc = createService({ db: open(), secret: 'test' });
  const { business: b } = svc.createBusiness({
    slug: 'sbc', name: 'Sayonara Beauty Center', reward: 'Lavado y secado gratis', visitsRequired: 12,
    brand: { bg: '#FFFDF8', fg: '#A9822A', icon: 'drop', unit: 'lavada', units: 'lavadas', unitsLong: 'lavadas de cabello' },
  });
  assert.deepEqual(unitsOf(b), { one: 'lavada', many: 'lavadas', long: 'lavadas de cabello', custom: true });
  assert.equal(statusText(b, { visits: 0 }), 'Tu tarjeta está en 0 lavadas. ¡Te esperamos!');
  assert.equal(statusText(b, { visits: 5 }), 'Llevas 5 de 12 lavadas. Te faltan 7 para tu lavado y secado gratis.');
  assert.equal(statusText(b, { visits: 12 }), '¡Tienes tu lavado y secado gratis disponible!');
  const png = await poster.posterPng(b, svc.brandOf(b), 'https://x.test/r/sbc', { width: 620 });
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  // Un negocio sin unidad sigue diciendo "visitas"
  const { business: u } = svc.createBusiness({ slug: 'u2', name: 'U2', reward: 'Corte gratis' });
  assert.equal(statusText(u, { visits: 3 }), 'Visita registrada: 3 de 10. Te faltan 7 para tu corte gratis.');
});
