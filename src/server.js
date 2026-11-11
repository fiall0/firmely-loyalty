const path = require('path');
const fs = require('fs');
const { open } = require('./db');
const { createService } = require('./service');
const { createApp } = require('./app');
const { createApple, configFromEnv } = require('./apple');
const { createGoogle, configFromEnv: googleConfig } = require('./google');

// En la nube los certificados llegan como variables (base64) y se guardan en archivos temporales.
(function materializeCerts() {
  const map = { APPLE_CERT_B64: ['APPLE_CERT_PATH', 'pass-cert.pem'], APPLE_KEY_B64: ['APPLE_KEY_PATH', 'pass-key.pem'], APPLE_WWDR_B64: ['APPLE_WWDR_PATH', 'wwdr.pem'] };
  const dir = path.join(require('os').tmpdir(), 'apple-certs');
  for (const [v, [pathVar, name]] of Object.entries(map)) {
    if (!process.env[v] || process.env[pathVar]) continue;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, name);
    fs.writeFileSync(f, Buffer.from(process.env[v], 'base64'), { mode: 0o600 });
    process.env[pathVar] = f;
  }
}());

const secret = process.env.CODE_SECRET;
if (!secret && process.env.NODE_ENV === 'production') {
  console.error('Falta CODE_SECRET (firma de los QR).');
  process.exit(1);
}
const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'loyalty.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = open(file);
// Aquí se conectarán los adaptadores de Apple y Google Wallet (etapas 3 y 4).
const hooks = {
  customerChanged: ({ business, customer, reason }) =>
    console.log(`[wallet] ${business.slug}: cliente ${customer.id} (${reason}) ${customer.visits}/${customer.required}`),
  notice: ({ business, message, customers }) =>
    console.log(`[wallet] ${business.slug}: aviso a ${customers.length} pases: "${message}"`),
};
const codeSecret = secret || 'dev-secret-cambiar';
// Apple Wallet se activa si están las variables APPLE_* (ver README). Los hooks se enlazan después de crear el servicio.
const appleCfg = configFromEnv();
const live = { ...hooks };
const svc = createService({ db, secret: codeSecret, hooks: {
  customerChanged: (p) => live.customerChanged(p),
  notice: (p) => live.notice(p),
} });
// SEED_BUSINESSES="undercut:Undercut,agape:Ágape|#24417D|#FFFFFF|cup|Café gratis" crea los negocios que falten
// (slug:Nombre[|colorFondo|colorTexto|icono(scissors/cup)|premio[|visitas]]) y muestra sus llaves una sola vez.
for (const item of (process.env.SEED_BUSINESSES || '').split(',').map((x) => x.trim()).filter(Boolean)) {
  const [head, bg, fg, icon, reward, visits] = item.split('|').map((x) => x.trim());
  const [slug, ...rest] = head.split(':');
  try {
    const { keys } = svc.createBusiness({
      slug: slug.trim(), name: rest.join(':').trim() || slug.trim(),
      reward: reward || undefined, visitsRequired: visits ? Number(visits) : undefined,
      brand: { bg, fg, icon },
    });
    console.log(`Negocio "${slug}" creado. Guarda estas llaves, no se vuelven a mostrar:`);
    console.log(`  caja  (x-api-key): ${keys.staff}`);
    console.log(`  admin (x-api-key): ${keys.admin}`);
  } catch (e) {
    if (e.code !== 'slug_taken') throw e;
  }
}
const adapters = [];
let apple = null;
if (appleCfg) {
  apple = createApple({ db, svc, secret: codeSecret, config: appleCfg });
  adapters.push(apple.hooks);
  console.log('Apple Wallet activo.');
}
let google = null;
const googleCfg = googleConfig();
if (googleCfg) {
  google = createGoogle({ db, svc, config: googleCfg });
  adapters.push(google.hooks);
  console.log('Google Wallet activo.');
}
live.customerChanged = (p) => { hooks.customerChanged(p); adapters.forEach((a) => a.customerChanged(p)); };
live.notice = (p) => { hooks.notice(p); adapters.forEach((a) => a.notice(p)); };
const port = Number(process.env.PORT || 3000);
createApp(svc, { apple, google }).listen(port, () => console.log(`Fidelidad escuchando en :${port}`));
