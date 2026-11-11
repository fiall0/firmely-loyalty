const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createService } = require('../src/service');
const { createApp } = require('../src/app');

test('eliminar cliente: borra sus datos, avisa a los hooks y permite volver a registrar el teléfono', async () => {
  const db = open();
  const events = [];
  const svc = createService({ db, secret: 'test', hooks: { customerChanged: (p) => events.push(p.reason) } });
  const { business: b, keys } = svc.createBusiness({ slug: 'agape', name: 'Ágape' });
  const { customer } = svc.register(b, { name: 'Ana', phone: '8095550100', consent: true });
  const other = svc.register(b, { name: 'Luis', phone: '8095550101', consent: true }).customer;
  const server = createApp(svc, {}).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/agape`;
  try {
    let r = await fetch(`${url}/customers/${customer.id}`, { method: 'DELETE', headers: { 'x-api-key': keys.staff } });
    assert.equal(r.status, 401, 'la caja no puede eliminar');
    r = await fetch(`${url}/customers/${customer.id}`, { method: 'DELETE', headers: { 'x-api-key': keys.admin } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { deleted: true });
    assert.ok(events.includes('delete'));
    assert.throws(() => svc.getCustomer(b, customer.id), /no encontrado/i);
    assert.equal(svc.stats(b).customers, 1);
    assert.equal(svc.getCustomer(b, other.id).customer.name, 'Luis');
    r = await fetch(`${url}/customers/${customer.id}`, { method: 'DELETE', headers: { 'x-api-key': keys.admin } });
    assert.equal(r.status, 404);
    svc.register(b, { name: 'Ana otra vez', phone: '8095550100', consent: true });
    assert.equal(svc.stats(b).customers, 2);
  } finally { server.close(); }
});
