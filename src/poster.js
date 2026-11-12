// Cartel y QR de registro de cada negocio (PNG y SVG), con los colores y el logo de su marca.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const QRCode = require('qrcode');
const stamps = require('./stamps');
const { unitsOf } = require('./text');

const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FONT = "'Liberation Sans','DejaVu Sans',Arial,Helvetica,sans-serif";

/** Dibuja los módulos del QR como un solo <path> dentro de un cuadrado de `size` unidades. */
function qrPath(url) {
  const { modules } = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const n = modules.size;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (modules.get(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return { d, n };
}

/** QR suelto (negro sobre blanco, con margen de silencio) como SVG. */
function qrSvg(url, px = 1000) {
  const { d, n } = qrPath(url);
  const m = 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${-m} ${-m} ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges">` +
    `<rect x="${-m}" y="${-m}" width="${n + 2 * m}" height="${n + 2 * m}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
const qrPng = (url, px = 1000) => sharp(Buffer.from(qrSvg(url, px))).png().toBuffer();

async function logoBuffer(b, brand, logosDir) {
  const own = logosDir ? path.join(logosDir, `${b.slug}.png`) : null;
  const file = own && /^[a-z0-9-]+$/.test(b.slug) && fs.existsSync(own) ? own : require('./logos').find(b.slug);
  if (file) return sharp(file).resize(400, 400, { fit: 'cover' }).png().toBuffer();
  return stamps.icon(400, brand);
}

/** Cartel vertical (A4) listo para imprimir. `width` en píxeles (2480 = A4 a 300 ppp). */
async function posterPng(b, brand, url, { width = 2480, logosDir = null } = {}) {
  const W = 1240, H = 1754;
  const name = String(b.name).toUpperCase();
  const nameSize = Math.min(96, Math.floor(1000 / (name.length * 0.8)));
  const { d, n } = qrPath(url);
  const m = 4, qrPx = 640, pad = 50;
  const logo = (await logoBuffer(b, brand, logosDir)).toString('base64');
  const reward = String(b.reward || '').toLowerCase();
  const pcfg = require('./settings').normalizeSettings(JSON.parse(b.settings_json || '{}'));
  const line = pcfg.mode === 'points' ? `1 punto por cada RD$${pcfg.points.pesosPerPoint} de consumo` : `${b.visits_required} ${unitsOf(b).long} = ${reward}`;
  const lineSize = Math.min(60, Math.floor(1060 / (line.length * 0.56)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><clipPath id="c"><circle cx="${W / 2}" cy="270" r="150"/></clipPath></defs>
<rect width="${W}" height="${H}" fill="${brand.bg}"/>
<image href="data:image/png;base64,${logo}" x="${W / 2 - 150}" y="120" width="300" height="300" clip-path="url(#c)" preserveAspectRatio="xMidYMid slice"/>
<circle cx="${W / 2}" cy="270" r="157" fill="none" stroke="${brand.fg}" stroke-width="6"/>
<text x="${W / 2}" y="${520 + nameSize * 0.35}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${nameSize}" letter-spacing="10" fill="${brand.fg}">${xml(name)}</text>
<text x="${W / 2}" y="650" text-anchor="middle" font-family="${FONT}" font-size="52" fill="${brand.fg}">Tarjeta de fidelidad</text>
<text x="${W / 2}" y="735" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${lineSize}" fill="${brand.fg}">${xml(line)}</text>
<rect x="${W / 2 - qrPx / 2 - pad}" y="860" width="${qrPx + 2 * pad}" height="${qrPx + 2 * pad}" rx="36" fill="#fff" stroke="${brand.fg}" stroke-width="5"/>
<svg x="${W / 2 - qrPx / 2}" y="${860 + pad}" width="${qrPx}" height="${qrPx}" viewBox="${-m} ${-m} ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges"><path d="${d}" fill="#000"/></svg>
<text x="${W / 2}" y="1665" text-anchor="middle" font-family="${FONT}" font-size="42" fill="${brand.fg}">Escanea y agrega tu tarjeta a tu billetera digital</text>
</svg>`;
  return sharp(Buffer.from(svg), { density: (72 * width) / W }).resize(width).png().toBuffer();
}

module.exports = { qrSvg, qrPng, posterPng };
