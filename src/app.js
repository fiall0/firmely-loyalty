const express = require('express');
const { HttpError } = require('./service');
const stamps = require('./stamps');
const pages = require('./pages');

function createApp(svc, { apple, google } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // detrás del proxy HTTPS de la nube, req.ip es la IP real
  app.use(express.json({ limit: '10kb' }));

  if (apple) app.use('/apple', apple.router);

  // Páginas del cliente y de caja
  app.get('/r/:slug', (req, res) => res.type('html').send(pages.registro(svc.getBusiness(req.params.slug), { apple: !!apple, google: !!google })));
  app.get('/admin/:slug', (req, res) => res.type('html').send(pages.admin(svc.getBusiness(req.params.slug))));
  app.get('/caja/:slug', (req, res) => res.type('html').send(pages.caja(svc.getBusiness(req.params.slug))));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Límite simple para el registro público: 20 por hora por IP.
  const hits = new Map();
  const registerLimit = (req, _res, next) => {
    const hour = Math.floor(Date.now() / 3600000);
    const key = `${req.ip}:${hour}`;
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (hits.size > 5000) for (const k of hits.keys()) if (!k.endsWith(`:${hour}`)) hits.delete(k);
    if (n > 20) return next(new HttpError(429, 'rate_limited', 'Demasiados intentos, prueba más tarde.'));
    next();
  };

  const r = express.Router({ mergeParams: true });
  app.use('/api/:slug', r);

  r.use((req, _res, next) => {
    req.biz = svc.getBusiness(req.params.slug);
    req.role = svc.roleFor(req.biz, req.get('x-api-key'));
    const actor = (req.get('x-actor') || req.role || 'cliente').toString().slice(0, 40);
    req.actor = actor;
    next();
  });

  const need = (...roles) => (req, _res, next) =>
    roles.includes(req.role) ? next() : next(new HttpError(401, 'unauthorized', 'Acceso no autorizado.'));

  // Público
  r.get('/info', (req, res) => {
    const b = req.biz;
    res.json({ name: b.name, reward: b.reward, visitsRequired: b.visits_required,
      minHoursBetweenVisits: b.min_hours_between_visits, maxNoticesPerMonth: b.max_notices_per_month });
  });
  r.post('/register', registerLimit, (req, res) => {
    const out = svc.register(req.biz, req.body || {});
    res.status(out.existing ? 200 : 201).json(out);
  });

  // Imágenes de sellos (públicas: Google Wallet las descarga desde una URL)
  r.get('/stamp/:file', async (req, res, next) => {
    try {
      const m = /^(\d{1,2})(?:\.png)?$/.exec(req.params.file);
      const kind = req.query.kind === 'hero' ? 'hero' : 'strip';
      const scale = kind === 'hero' ? 1 : Number(req.query.scale || 1);
      const visits = m ? Number(m[1]) : NaN;
      if (!m || visits > req.biz.visits_required || ![1, 2, 3].includes(scale)) {
        throw new HttpError(400, 'bad_stamp', 'Imagen no válida.');
      }
      const png = await stamps.render(kind, visits, {
        total: req.biz.visits_required, brand: svc.brandOf(req.biz), scale,
      });
      res.set({ 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }).send(png);
    } catch (e) { next(e); }
  });

  // Descarga del pase de Apple (botón "Agregar a Apple Wallet"); el código firmado identifica al cliente.
  r.get('/pass.pkpass', async (req, res, next) => {
    try {
      if (!apple) throw new HttpError(503, 'apple_off', 'Apple Wallet no está configurado.');
      const c = svc.customerFromCode(req.biz, req.query.code);
      const buf = await apple.buildPass(req.biz, c.id);
      res.set({ 'content-type': 'application/vnd.apple.pkpass', 'content-disposition': 'attachment; filename="tarjeta.pkpass"' }).send(buf);
    } catch (e) { next(e); }
  });

  // Logo público del negocio (assets/logos/<slug>.png); si no hay, un ícono generado con sus colores.
  r.get('/logo.png', async (req, res, next) => {
    try {
      const file = require('path').join(__dirname, '..', 'assets', 'logos', `${req.biz.slug}.png`);
      res.set('cache-control', 'public, max-age=3600').type('png');
      if (/^[a-z0-9-]+$/.test(req.biz.slug) && require('fs').existsSync(file)) return res.sendFile(file);
      res.send(await stamps.icon(256, svc.brandOf(req.biz)));
    } catch (e) { next(e); }
  });

  // Enlace "Agregar a Google Wallet": redirige al enlace firmado.
  r.get('/google-wallet', async (req, res, next) => {
    try {
      if (!google) throw new HttpError(503, 'google_off', 'Google Wallet no está configurado.');
      const c = svc.customerFromCode(req.biz, req.query.code);
      res.redirect(302, await google.saveUrl(req.biz, c.id));
    } catch (e) { next(e); }
  });

  // Caja (staff o admin)
  r.post('/scan', need('staff', 'admin'), (req, res) =>
    res.json(svc.scan(req.biz, (req.body || {}).code, req.actor)));
  r.post('/redeem', need('staff', 'admin'), (req, res) =>
    res.json(svc.redeem(req.biz, (req.body || {}).code, req.actor)));

  // Panel (solo admin)
  r.get('/stats', need('admin'), (req, res) => res.json(svc.stats(req.biz)));
  r.get('/customers', need('admin'), (req, res) =>
    res.json({ customers: svc.listCustomers(req.biz, req.query.q) }));
  r.get('/customers/:id', need('admin'), (req, res) =>
    res.json(svc.getCustomer(req.biz, Number(req.params.id))));
  r.patch('/customers/:id', need('admin'), (req, res) =>
    res.json(svc.updateCustomer(req.biz, Number(req.params.id), req.body || {}, req.actor)));
  r.post('/customers/:id/reset', need('admin'), (req, res) =>
    res.json(svc.resetVisits(req.biz, Number(req.params.id), req.actor)));
  r.post('/notices', need('admin'), (req, res) =>
    res.json(svc.sendNotice(req.biz, req.body || {}, req.actor)));

  app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'Ruta no encontrada.')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'JSON inválido.' });
    console.error(err);
    res.status(500).json({ error: 'internal', message: 'Error interno.' });
  });
  return app;
}

module.exports = { createApp };
