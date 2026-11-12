// Panel general de Firmely: gestiona los negocios (clientes) y, dentro de cada uno, sus servicios.
// Se protege con FIRMELY_ADMIN_KEY (variable de entorno); sin ella el panel queda desactivado.
const crypto = require('crypto');
const express = require('express');
const { HttpError } = require('./service');
const logos = require('./logos');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const asHttp = (e) => (e && e.status && !(e instanceof HttpError) ? new HttpError(e.status, e.code || 'error', e.message) : e);

function createFirmelyRouter(svc, { key, loyaltyUrl = '' } = {}) {
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

  return r;
}

module.exports = { createFirmelyRouter };
