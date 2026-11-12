// Panel general de Firmely: gestiona los negocios (clientes) y, dentro de cada uno, sus servicios.
// Se protege con FIRMELY_ADMIN_KEY (variable de entorno); sin ella el panel queda desactivado.
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const { HttpError } = require('./service');
const { zipSync, strToU8 } = require('fflate');
const logos = require('./logos');
const poster = require('./poster');
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const asHttp = (e) => (e && e.status && !(e instanceof HttpError) ? new HttpError(e.status, e.code || 'error', e.message) : e);

function createFirmelyRouter(svc, { key, loyaltyUrl = '', apple = null } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '5mb' }));
  const want = key ? sha(key) : null;

  r.use((req, _res, next) => {
    if (!want) return next(new HttpError(503, 'panel_off', 'El panel no está activado: falta FIRMELY_ADMIN_KEY.'));
    if (!crypto.timingSafeEqual(sha(req.get('x-firmely-key') || ''), want)) return next(new HttpError(401, 'unauthorized', 'Llave incorrecta.'));
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch((e) => next(asHttp(e)));
  const item = (slug) => svc.listBusinesses().find((x) => x.slug === slug);

  r.get('/config', (_req, res) => res.json({ loyaltyUrl }));
  r.get('/businesses', (_req, res) => res.json({ businesses: svc.listBusinesses() }));

  r.post('/businesses', wrap(async (req, res) => {
    const { slug, name, reward, visitsRequired, minHoursBetweenVisits, maxNoticesPerMonth, brand, logo } = req.body || {};
    const n = String(name || '').trim();
    if (n.length < 2 || n.length > 40) throw new HttpError(400, 'bad_name', 'El nombre debe tener entre 2 y 40 caracteres.');
    const { business, keys } = svc.createBusiness({ slug, name: n, reward, visitsRequired, minHoursBetweenVisits, maxNoticesPerMonth, brand });
    try {
      // createBusiness no valida rangos finos: updateBusiness sí.
      svc.updateBusiness(business.slug, { reward, visitsRequired, minHoursBetweenVisits, maxNoticesPerMonth });
      if (logo) await logos.saveFromDataUrl(business.slug, logo, svc.brandOf(business).bg);
    } catch (e) {
      svc.deleteBusiness(business.slug, 'firmely');
      logos.remove(business.slug);
      throw e;
    }
    res.status(201).json({ business: item(business.slug), keys });
  }));

  r.get('/businesses/:slug', (req, res) => {
    svc.getBusiness(req.params.slug);
    res.json({ business: item(req.params.slug) });
  });

  r.patch('/businesses/:slug', wrap(async (req, res) => {
    const { logo, ...patch } = req.body || {};
    const business = svc.updateBusiness(req.params.slug, patch);
    if (logo) await logos.saveFromDataUrl(business.slug, logo, business.brand.bg);
    res.json({ business: item(business.slug) });
  }));

  r.post('/businesses/:slug/keys', (req, res) => res.json(svc.regenerateKeys(req.params.slug, (req.body || {}).which)));

  r.delete('/businesses/:slug', (req, res) => {
    if ((req.body || {}).confirm !== req.params.slug) throw new HttpError(400, 'confirm', 'Escribe el slug del negocio para confirmar.');
    const out = svc.deleteBusiness(req.params.slug, 'firmely');
    logos.remove(req.params.slug);
    res.json(out);
  });

  const baseOf = (req) => (loyaltyUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const samplePass = (slug) => {
    if (!apple) throw new HttpError(503, 'apple_off', 'Apple Wallet no está configurado en este servidor.');
    return svc.withSampleCustomer(slug, (id, b) => apple.buildPass(b, id));
  };

  r.get('/businesses/:slug/sample.pkpass', wrap(async (req, res) => {
    const buf = await samplePass(req.params.slug);
    res.set({ 'content-type': 'application/vnd.apple.pkpass', 'content-disposition': `attachment; filename="${req.params.slug}-ejemplo.pkpass"` }).send(buf);
  }));

  r.get('/businesses/:slug/package.zip', wrap(async (req, res) => {
    const b = svc.getBusiness(req.params.slug);
    const brand = svc.brandOf(b);
    const base = baseOf(req);
    const reg = `${base}/r/${b.slug}`;
    const urls = { registro: reg, caja: `${base}/caja/${b.slug}`, panel: `${base}/admin/${b.slug}` };
    const files = {};
    const add = (name, data) => { files[`${b.slug}/${name}`] = data instanceof Uint8Array ? data : strToU8(data); };
    const logoPath = logos.find(b.slug);
    if (logoPath) add('logo.png', new Uint8Array(fs.readFileSync(logoPath)));
    add('cartel-qr.png', new Uint8Array(await poster.posterPng(b, brand, reg, { width: 1200 })));
    add('qr-registro.png', new Uint8Array(await poster.qrPng(reg, 1200)));
    add('qr-registro.svg', poster.qrSvg(reg, 1200));
    try { add('tarjeta-ejemplo.pkpass', new Uint8Array(await samplePass(b.slug))); } catch (e) { if (!(e instanceof HttpError)) throw e; }
    const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
    const link = (u) => `<a href="${esc(u)}">${esc(u)}</a>`;
    add('ficha.html', `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Ficha · ${esc(b.name)}</title>
<style>body{font:15px/1.5 'DM Sans',Arial,sans-serif;color:#0F1C2E;max-width:760px;margin:40px auto;padding:0 20px}h1{font-family:'DM Serif Display',Georgia,serif;font-weight:400;font-size:34px;margin:0}
.bar{background:#1E3F6F;color:#fff;padding:22px 26px;border-radius:14px;margin-bottom:24px}.bar small{letter-spacing:.16em;text-transform:uppercase;opacity:.6;font-size:11px}
table{width:100%;border-collapse:collapse;margin:8px 0 26px}th{text-align:left;width:34%;color:#5A6A7E;font-weight:500;padding:9px 12px;border-bottom:1px solid #E1E7F0;vertical-align:top}td{padding:9px 12px;border-bottom:1px solid #E1E7F0;word-break:break-all}
h2{font-size:15px;letter-spacing:.1em;text-transform:uppercase;color:#1F5A9B;margin:26px 0 0}.sw{display:inline-block;width:14px;height:14px;border-radius:50%;border:1px solid #ccc;vertical-align:-2px;margin-right:6px}</style></head><body>
<div class="bar"><small>Firmely · Tarjeta de fidelidad</small><h1>${esc(b.name)}</h1></div>
<h2>Enlaces</h2><table>${row('Registro (clientes)', link(urls.registro))}${row('Caja (escáner)', link(urls.caja))}${row('Panel del negocio', link(urls.panel))}</table>
<h2>Reglas</h2><table>${row('Identificador', esc(b.slug))}${row('Premio', esc(b.reward))}${row('Visitas para ganarlo', b.visits_required)}${row('Horas mínimas entre visitas', b.min_hours_between_visits)}${row('Avisos máximos por mes', b.max_notices_per_month)}</table>
<h2>Diseño</h2><table>${row('Fondo', `<span class="sw" style="background:${esc(brand.bg)}"></span>${esc(brand.bg)}`)}${row('Texto', `<span class="sw" style="background:${esc(brand.fg)}"></span>${esc(brand.fg)}`)}${row('Ícono de sellos', esc(brand.icon))}${row('Unidad', esc([brand.unit, brand.units, brand.unitsLong].filter(Boolean).join(' / ') || 'visita / visitas'))}</table>
<h2>Llaves</h2><p>Las llaves de caja y admin no se guardan en claro, por eso no vienen en este archivo. Si se perdieron, regenéralas desde el panel de Firmely.</p>
<p style="color:#5A6A7E;font-size:13px">Generado el ${new Date().toISOString().slice(0, 10)} · Edward Fiallo · Firmely</p></body></html>`);
    res.set({ 'content-type': 'application/zip', 'content-disposition': `attachment; filename="Firmely-${b.slug}.zip"` }).send(Buffer.from(zipSync(files)));
  }));

  return r;
}

module.exports = { createFirmelyRouter };
