const express = require('express');
const { HttpError } = require('./service');
const stamps = require('./stamps');
const poster = require('./poster');
const pages = require('./pages');
const { parseCoords } = require('./settings');

function createApp(svc, { apple, google } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // detrás del proxy HTTPS de la nube, req.ip es la IP real
  app.use(express.json({ limit: '10kb' }));

  if (apple) app.use('/apple', apple.router);

  // Páginas del cliente y de caja
  app.get('/r/:slug', (req, res) => res.type('html').send((() => { const b = svc.getBusiness(req.params.slug); return pages.registro(b, { apple: !!apple, google: !!google }, svc.brandOf(b), svc.getSettings(b)); })()));
  app.get('/admin/:slug', (req, res) => res.type('html').send((() => { const b = svc.getBusiness(req.params.slug); return pages.admin(b, svc.brandOf(b)); })()));
  app.get('/caja/:slug', (req, res) => res.type('html').send((() => { const b = svc.getBusiness(req.params.slug); return pages.caja(b, svc.brandOf(b)); })()));

  app.get('/vendor/scanner.js', (_req, res) => res.sendFile(require('path').join(__dirname, 'scanner.js')));
  app.get('/vendor/jsqr.js', (_req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));
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

  // Cartel y QR de registro para imprimir (públicos: solo contienen el enlace de registro).
  const registerUrl = (req) => `${req.protocol}://${req.get('host')}/r/${req.biz.slug}`;
  const sendFile = (res, req, type, buf, name) => {
    res.set('cache-control', 'no-cache').type(type);
    if (req.query.download) res.set('content-disposition', `attachment; filename="${name}"`);
    res.send(buf);
  };
  r.get('/poster.png', async (req, res, next) => {
    try {
      const w = Math.min(2480, Math.max(300, Number(req.query.w) || 2480));
      sendFile(res, req, 'png', await poster.posterPng(req.biz, svc.brandOf(req.biz), registerUrl(req), { width: w }), `cartel-${req.biz.slug}.png`);
    } catch (e) { next(e); }
  });
  r.get('/qr.png', async (req, res, next) => {
    try { sendFile(res, req, 'png', await poster.qrPng(registerUrl(req), 1200), `qr-${req.biz.slug}.png`); } catch (e) { next(e); }
  });
  r.get('/qr.svg', (req, res, next) => {
    try { sendFile(res, req, 'image/svg+xml', poster.qrSvg(registerUrl(req), 1200), `qr-${req.biz.slug}.svg`); } catch (e) { next(e); }
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
  r.delete('/customers/:id', need('admin'), (req, res) =>
    res.json(svc.deleteCustomer(req.biz, Number(req.params.id), req.actor)));
  r.get('/metrics', need('admin'), (req, res) => res.json(svc.metrics(req.biz)));
  r.get('/settings', need('admin'), (req, res) => res.json({ settings: svc.getSettings(req.biz) }));
  r.patch('/settings', need('admin'), (req, res) =>
    res.json({ settings: svc.updateSettings(req.biz, req.body || {}, req.actor) }));
  // Convierte lo que el dueño pegue (coordenadas o enlace de Google Maps, incluso acortado) en latitud y longitud.
  r.post('/geocode', need('admin'), async (req, res, next) => {
    try {
      const text = String((req.body || {}).text || '').trim().slice(0, 500);
      let found = parseCoords(text);
      if (!found && /^https?:\/\//i.test(text)) {
        const u = new URL(text);
        if (!/(^|\.)(goo\.gl|g\.co|google\.com|google\.com\.do)$/.test(u.hostname)) {
          throw new HttpError(400, 'bad_link', 'Pega un enlace de Google Maps.');
        }
        const resp = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'Mozilla/5.0' } });
        found = parseCoords(resp.url) || parseCoords((await resp.text()).slice(0, 300000));
      }
      if (!found) throw new HttpError(400, 'no_coords', 'No encontré la ubicación. Pega las coordenadas (ej. 18.4861, -69.9312) o un enlace completo de Google Maps.');
      res.json(found);
    } catch (e) { next(e instanceof HttpError ? e : new HttpError(400, 'bad_link', 'No pude leer ese enlace.')); }
  });
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
