// Apple Wallet: genera el .pkpass, atiende el servicio web que el iPhone consulta y avisa por APNs.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http2 = require('http2');
const { execFileSync } = require('child_process');
const express = require('express');
const { zipSync } = require('fflate');
const sharp = require('sharp');
const stamps = require('../stamps');
const { HttpError } = require('../service');

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Firma desprendida PKCS#7 (DER) del manifest, como pide Apple. */
function signManifest(manifest, { certPath, keyPath, wwdrPath, keyPassword }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkpass-'));
  try {
    const inFile = path.join(dir, 'manifest.json');
    const outFile = path.join(dir, 'signature');
    fs.writeFileSync(inFile, manifest);
    const args = ['smime', '-binary', '-sign', '-md', 'sha256', '-signer', certPath, '-inkey', keyPath,
      '-certfile', wwdrPath, '-in', inFile, '-out', outFile, '-outform', 'DER'];
    if (keyPassword) args.push('-passin', 'env:PASS_KEY_PASSWORD');
    execFileSync('openssl', args, { env: { ...process.env, PASS_KEY_PASSWORD: keyPassword || '' }, stdio: 'pipe' });
    return fs.readFileSync(outFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Envía el "push vacío" que hace que el iPhone vuelva a pedir el pase. */
function apnsPush({ certPath, keyPath, passTypeId, host = 'https://api.push.apple.com' }) {
  const cert = fs.readFileSync(certPath);
  const key = fs.readFileSync(keyPath);
  return (pushToken) => new Promise((resolve) => {
    const client = http2.connect(host, { cert, key });
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { client.close(); } catch { /* ya cerrado */ } resolve(r); } };
    client.on('error', (e) => finish({ ok: false, status: 0, reason: e.message }));
    const req = client.request({ ':method': 'POST', ':path': `/3/device/${pushToken}`, 'apns-topic': passTypeId, 'apns-push-type': 'background' });
    let status = 0;
    let body = '';
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (d) => { body += d; });
    req.on('end', () => finish({ ok: status === 200, status, reason: body }));
    req.on('error', (e) => finish({ ok: false, status: 0, reason: e.message }));
    req.setTimeout(10000, () => { req.close(); finish({ ok: false, status: 0, reason: 'timeout' }); });
    req.end('{}');
  });
}

function createApple({ db, svc, secret, config, push }) {
  const { passTypeId, teamId, publicUrl } = config;
  if (!passTypeId || !teamId || !publicUrl) throw new Error('Apple Wallet: faltan passTypeId, teamId o publicUrl');
  const base = publicUrl.replace(/\/+$/, '');
  const sender = push || apnsPush({ certPath: config.certPath, keyPath: config.keyPath, passTypeId });

  const serialFor = (slug, id) => `${slug}-${id}`;
  const parseSerial = (serial) => {
    const i = String(serial).lastIndexOf('-');
    if (i < 1) return null;
    const id = Number(serial.slice(i + 1));
    return Number.isInteger(id) ? { slug: serial.slice(0, i), id } : null;
  };
  const tokenFor = (serial) => crypto.createHmac('sha256', secret).update(`apple.${serial}`).digest('hex');

  function statusText(b, c) {
    if (c.visits >= b.visits_required) return `¡Tienes tu ${b.reward.toLowerCase()} disponible!`;
    if (c.visits === 0) return 'Tu tarjeta está en 0 visitas. ¡Te esperamos!';
    return `Visita registrada: ${c.visits} de ${b.visits_required}. Te faltan ${b.visits_required - c.visits} para tu ${b.reward.toLowerCase()}.`;
  }

  function captionText(b, c) {
    const rem = b.visits_required - c.visits;
    if (rem <= 0) return `¡Tu ${b.reward.toLowerCase()} está listo!`;
    if (c.visits === 0) return `Junta ${b.visits_required} visitas y tu ${b.reward.toLowerCase()} es gratis`;
    return `Te faltan ${rem} ${rem === 1 ? 'visita' : 'visitas'} para tu ${b.reward.toLowerCase()}`;
  }

  function lastNotice(customerId) {
    const row = db.prepare(`SELECT n.message FROM notice_deliveries d JOIN notices n ON n.id = d.notice_id
      WHERE d.customer_id = ? ORDER BY d.rowid DESC LIMIT 1`).get(customerId);
    return row ? row.message : null;
  }

  // Logo opcional por negocio: <logosDir>/<slug>.png (cuadrado o ancho, fondo del color de la marca).
  const logosDir = config.logosDir || path.join(__dirname, '..', '..', 'assets', 'logos');
  const logoFileFor = (slug) => {
    if (!/^[a-z0-9-]+$/.test(slug)) return null;
    const f = path.join(logosDir, `${slug}.png`);
    return fs.existsSync(f) ? f : null;
  };

  function passJson(b, row) {
    const brand = svc.brandOf(b);
    const serial = serialFor(b.slug, row.id);
    const required = b.visits_required;
    return {
      formatVersion: 1,
      passTypeIdentifier: passTypeId,
      teamIdentifier: teamId,
      serialNumber: serial,
      organizationName: b.name,
      description: `Tarjeta de fidelidad de ${b.name}`,
      logoText: b.name.toUpperCase(),
      backgroundColor: rgb(brand.bg),
      foregroundColor: rgb(brand.fg),
      labelColor: rgb(brand.fg),
      webServiceURL: `${base}/apple`,
      authenticationToken: tokenFor(serial),
      barcodes: [{ format: 'PKBarcodeFormatQR', message: svc.codeFor(b.slug, row.id), messageEncoding: 'iso-8859-1' }],
      storeCard: {
        headerFields: [{ key: 'visits', label: 'VISITAS', value: `${row.visits} de ${required}` }],
        secondaryFields: [
          { key: 'reward', label: 'RECOMPENSA', value: b.reward },
          { key: 'member', label: 'MIEMBRO', value: row.name, textAlignment: 'PKTextAlignmentRight' },
        ],
        backFields: [
          { key: 'status', label: 'Estado', value: statusText(b, row), changeMessage: '%@' },
          { key: 'aviso', label: 'Último aviso', value: lastNotice(row.id) || 'Sin avisos', changeMessage: '%@' },
          { key: 'member_id', label: 'ID de miembro', value: String(row.id).padStart(6, '0') },
          { key: 'terms', label: 'Cómo funciona',
            value: `Muestra este código en caja en cada visita. A las ${required} visitas ganas: ${b.reward}.` },
        ],
      },
    };
  }

  /** Construye y firma el .pkpass de un cliente. */
  async function buildPass(b, customerId) {
    const row = db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(customerId, b.id);
    if (!row) throw new HttpError(404, 'no_customer', 'Cliente no encontrado.');
    const brand = svc.brandOf(b);
    const files = {
      'pass.json': Buffer.from(JSON.stringify(passJson(b, row))),
      ...(await stamps.appleStripFiles(Math.min(row.visits, b.visits_required), { total: b.visits_required, brand, caption: captionText(b, row) })),
    };
    const logoFile = logoFileFor(b.slug);
    if (logoFile) {
      const bg = { r: 0, g: 0, b: 0, alpha: 0 };
      const resize = async (px) => {
        const ring = Math.max(1, Math.round(px * 0.045));
        const inner = px - ring * 2;
        const circle = Buffer.from(`<svg width="${inner}" height="${inner}"><circle cx="${inner / 2}" cy="${inner / 2}" r="${inner / 2}"/></svg>`);
        const face = await sharp(logoFile).resize(inner, inner, { fit: 'cover' }).composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer();
        const frame = Buffer.from(`<svg width="${px}" height="${px}"><circle cx="${px / 2}" cy="${px / 2}" r="${px / 2 - ring / 2}" fill="none" stroke="${brand.fg}" stroke-width="${ring}" stroke-opacity="0.9"/></svg>`);
        return sharp({ create: { width: px, height: px, channels: 4, background: bg } })
          .composite([{ input: face, left: ring, top: ring }, { input: frame }]).png().toBuffer();
      };
      // Apple: logo de hasta 160x50 pt (1x/2x/3x); icono 29/58/87.
      // El lienzo mide 50 pt de alto; el logo ocupa 40 y va abajo, así queda separado del borde de arriba.
      const padTop = async (px) => {
        const face = await resize(Math.round(px * 0.8));
        return sharp({ create: { width: px, height: px, channels: 4, background: bg } })
          .composite([{ input: face, left: Math.round(px * 0.1), top: Math.round(px * 0.2) }]).png().toBuffer();
      };
      files['logo.png'] = await padTop(50);
      files['logo@2x.png'] = await padTop(100);
      files['logo@3x.png'] = await padTop(150);
      files['icon.png'] = await resize(29);
      files['icon@2x.png'] = await resize(58);
      files['icon@3x.png'] = await resize(87);
    } else {
      files['icon.png'] = await stamps.icon(29, brand);
      files['icon@2x.png'] = await stamps.icon(58, brand);
      files['icon@3x.png'] = await stamps.icon(87, brand);
    }
    const manifest = {};
    for (const [name, buf] of Object.entries(files)) manifest[name] = sha1(buf);
    const manifestBuf = Buffer.from(JSON.stringify(manifest));
    files['manifest.json'] = manifestBuf;
    files.signature = signManifest(manifestBuf, config);
    const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new Uint8Array(v)])), { level: 0 });
    return Buffer.from(zipped);
  }

  // ---------- avisos push ----------
  async function pushCustomers(customerIds) {
    if (!customerIds.length) return { pushed: 0, failed: 0 };
    const marks = customerIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT DISTINCT d.device_id, d.push_token FROM apple_registrations r
      JOIN apple_devices d ON d.device_id = r.device_id WHERE r.customer_id IN (${marks})`).all(...customerIds);
    let pushed = 0;
    let failed = 0;
    for (const row of rows) {
      const res = await sender(row.push_token);
      if (res.ok) pushed += 1;
      else {
        failed += 1;
        // 410: el teléfono ya no tiene el pase. Se olvida el dispositivo.
        if (res.status === 410) db.prepare('DELETE FROM apple_devices WHERE device_id = ?').run(row.device_id);
        else console.error(`[apple] push falló (${res.status}): ${res.reason}`);
      }
    }
    return { pushed, failed };
  }

  // ---------- servicio web de Apple ----------
  const router = express.Router();
  const auth = (req, _res, next) => {
    const serial = req.params.serial;
    const given = Buffer.from((req.get('authorization') || '').replace(/^ApplePass\s+/i, ''));
    const expected = Buffer.from(tokenFor(serial));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return next(new HttpError(401, 'unauthorized', 'No autorizado.'));
    }
    next();
  };
  const withPassType = (req, _res, next) =>
    req.params.pt === passTypeId ? next() : next(new HttpError(404, 'not_found', 'Tipo de pase desconocido.'));

  router.post('/v1/devices/:dev/registrations/:pt/:serial', withPassType, auth, (req, res) => {
    const parsed = parseSerial(req.params.serial);
    const token = String((req.body || {}).pushToken || '');
    if (!parsed || !token) throw new HttpError(400, 'bad_request', 'Solicitud no válida.');
    const b = svc.getBusiness(parsed.slug);
    const c = db.prepare('SELECT id FROM customers WHERE id = ? AND business_id = ?').get(parsed.id, b.id);
    if (!c) throw new HttpError(404, 'no_customer', 'Cliente no encontrado.');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO apple_devices (device_id, push_token, updated_at) VALUES (?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET push_token = excluded.push_token, updated_at = excluded.updated_at`)
      .run(req.params.dev, token, now);
    const info = db.prepare('INSERT OR IGNORE INTO apple_registrations (device_id, customer_id, serial) VALUES (?,?,?)')
      .run(req.params.dev, c.id, req.params.serial);
    res.sendStatus(info.changes ? 201 : 200);
  });

  router.delete('/v1/devices/:dev/registrations/:pt/:serial', withPassType, auth, (req, res) => {
    db.prepare('DELETE FROM apple_registrations WHERE device_id = ? AND serial = ?').run(req.params.dev, req.params.serial);
    db.prepare(`DELETE FROM apple_devices WHERE device_id = ?
      AND NOT EXISTS (SELECT 1 FROM apple_registrations WHERE device_id = ?)`).run(req.params.dev, req.params.dev);
    res.sendStatus(200);
  });

  router.get('/v1/devices/:dev/registrations/:pt', withPassType, (req, res) => {
    const since = Number(req.query.passesUpdatedSince || 0) || 0;
    const rows = db.prepare(`SELECT r.serial, MAX(p.seq) seq FROM apple_registrations r
      JOIN pass_changes p ON p.customer_id = r.customer_id
      WHERE r.device_id = ? AND p.seq > ? GROUP BY r.serial`).all(req.params.dev, since);
    if (!rows.length) return res.sendStatus(204);
    res.json({ serialNumbers: rows.map((r) => r.serial), lastUpdated: String(Math.max(...rows.map((r) => r.seq))) });
  });

  router.get('/v1/passes/:pt/:serial', withPassType, auth, async (req, res, next) => {
    try {
      const parsed = parseSerial(req.params.serial);
      if (!parsed) throw new HttpError(404, 'not_found', 'Pase no encontrado.');
      const b = svc.getBusiness(parsed.slug);
      const buf = await buildPass(b, parsed.id);
      res.set({ 'content-type': 'application/vnd.apple.pkpass', 'last-modified': new Date().toUTCString() }).send(buf);
    } catch (e) { next(e); }
  });

  router.post('/v1/log', (req, res) => {
    const logs = Array.isArray((req.body || {}).logs) ? req.body.logs : [];
    for (const l of logs.slice(0, 20)) console.log(`[apple log] ${String(l).slice(0, 300)}`);
    res.sendStatus(200);
  });

  // Conecta con los hooks del servicio.
  const hooks = {
    customerChanged: ({ customer }) => { pushCustomers([customer.id]).catch((e) => console.error('[apple]', e)); },
    notice: ({ customers }) => { pushCustomers(customers.map((c) => c.id)).catch((e) => console.error('[apple]', e)); },
  };

  return { router, buildPass, pushCustomers, hooks, serialFor, tokenFor };
}

/** Lee la configuración desde variables de entorno; null si Apple no está configurado. */
function configFromEnv(env = process.env) {
  if (!env.APPLE_PASS_TYPE_ID) return null;
  // Railway define RAILWAY_PUBLIC_DOMAIN cuando el servicio tiene dirección pública.
  const publicUrl = env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');
  const need = ['APPLE_TEAM_ID', 'APPLE_CERT_PATH', 'APPLE_KEY_PATH', 'APPLE_WWDR_PATH'];
  const missing = need.filter((k) => !env[k]);
  if (!publicUrl) missing.push('PUBLIC_URL');
  if (missing.length) {
    console.warn(`Apple Wallet desactivado: faltan ${missing.join(', ')}.`);
    return null;
  }
  return {
    passTypeId: env.APPLE_PASS_TYPE_ID, teamId: env.APPLE_TEAM_ID, publicUrl,
    certPath: env.APPLE_CERT_PATH, keyPath: env.APPLE_KEY_PATH, wwdrPath: env.APPLE_WWDR_PATH,
    keyPassword: env.APPLE_KEY_PASSWORD,
  };
}

module.exports = { createApple, configFromEnv, signManifest };
