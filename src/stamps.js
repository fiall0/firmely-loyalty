// Dibuja las imágenes de sellos (0..N visitas) en PNG, con los colores de cada negocio.
// Apple: "strip" 375x123 (1x/2x/3x). Google: "hero" 1032x336.
const sharp = require('sharp');

const DEFAULT_BRAND = { bg: '#000000', fg: '#FFFFFF', icon: 'scissors' };
const KINDS = { strip: { w: 375, h: 123 }, hero: { w: 1032, h: 336 } };
const SCISSORS =
  '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/>' +
  '<circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>';
const CUP =
  '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M6 2v2"/>' +
  '<path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/>';
const DROP = '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>';
const DRYER =
  '<path d="M5.6 .7A4.7 4.7 0 0 0 5.6 10.1L16.9 8.2V2.4z"/><path d="M16.9 2.4L19.2 1.4V9.3L16.9 8.2"/>' +
  '<circle cx="4.9" cy="5.4" r="2.1"/><path d="M2.5 9.6L3.8 19.2H7.3V10.2"/><path d="M7.3 11.2h1.1v2.3H7.3"/>' +
  '<path d="M5.4 19.2c-.6 1.7.6 2.2 0 4.1"/><path d="M20.3 3.4q.8-.8 1.6 0t1.6 0"/><path d="M20.3 5.6q.8-.8 1.6 0t1.6 0"/><path d="M20.3 7.8q.8-.8 1.6 0t1.6 0"/>';
const POINTS_H = 176;
const STROKE = { dryer: 1.25 };
const ICONS = { scissors: SCISSORS, cup: CUP, drop: DROP, dryer: DRYER };
const HEX = /^#[0-9a-fA-F]{6}$/;

function normalizeBrand(brand = {}) {
  const out = { ...DEFAULT_BRAND };
  for (const k of ['bg', 'fg']) if (HEX.test(brand[k] || '')) out[k] = brand[k];
  if (ICONS[brand.icon]) out.icon = brand.icon;
  for (const k of ['stripBg', 'stamp', 'stampInk']) if (HEX.test(brand[k] || '')) out[k] = brand[k];
  // Nombre de lo que se cuenta (por defecto "visita"): unit/units en la tarjeta, unitsLong en cartel y registro.
  for (const k of ['unit', 'units', 'unitsLong']) {
    const v = String(brand[k] || '').trim().toLowerCase();
    if (v && v.length <= 30 && /^[a-záéíóúüñ ]+$/.test(v)) out[k] = v;
  }
  return out;
}

/** Mezcla dos colores #rrggbb (t = 0 devuelve a, 1 devuelve b). */
function mix(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

function esc(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function svg(kind, visits, total, brand, scale, caption) {
  const spec = KINDS[kind];
  if (!spec) throw new RangeError('Tipo de imagen no válido.');
  const { w, h } = spec;
  const n = Math.max(0, Math.min(total, Math.floor(visits)));
  const cols = Math.ceil(total / 2);
  const gapRatio = 0.22;
  const capH = caption ? 26 : 0; // franja inferior para el texto
  const areaH = h - capH;
  const d = Math.min((w * 0.8) / (cols + (cols - 1) * gapRatio), (areaH * 0.88) / (2 + gapRatio));
  const gap = d * gapRatio;
  const gridW = cols * d + (cols - 1) * gap;
  const gridH = 2 * d + gap;
  const x0 = (w - gridW) / 2;
  const y0 = (areaH - gridH) / 2 + (caption ? 2 : 0);
  const sc = brand.stamp || brand.fg;   // color de los sellos
  const si = brand.stampInk || brand.bg; // color del dibujo dentro del sello lleno
  const s = (d * 0.46) / 24;
  const isw = STROKE[brand.icon] || 2;
  const sw = Math.max(1.5, d * 0.04);
  let body = '';
  for (let i = 0; i < total; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const cx = x0 + c * (d + gap) + d / 2;
    const cy = y0 + r * (d + gap) + d / 2;
    const filled = i < n;
    body += filled
      ? `<circle cx="${cx}" cy="${cy}" r="${d / 2}" fill="${sc}"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${d / 2 - sw / 2}" fill="none" stroke="${sc}" stroke-opacity="0.55" stroke-width="${sw}"/>`;
    body += `<g transform="translate(${cx - 12 * s} ${cy - 12 * s}) scale(${s})" fill="none" stroke="${filled ? si : sc}" ` +
      `stroke-opacity="${filled ? 1 : 0.55}" stroke-width="${isw}" stroke-linecap="round" stroke-linejoin="round">${ICONS[brand.icon] || SCISSORS}</g>`;
  }
  if (caption) {
    const fs = Math.min(12.5, (w - 2 * x0) / (caption.length * 0.53));
    body += `<text x="${x0}" y="${h - 9}" font-family="Helvetica, Arial, DejaVu Sans, sans-serif" font-size="${fs.toFixed(2)}" ` +
      `fill="${sc}" fill-opacity="0.85">${esc(caption)}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="${kind === 'strip' ? (brand.stripBg || mix(brand.bg, brand.fg, 0.08)) : brand.bg}"/>${body}</svg>`;
}

const cache = new Map();

/** PNG de los sellos. Devuelve un Buffer. */
async function render(kind, visits, { total = 10, brand, scale = 1, caption = '' } = {}) {
  if (!Number.isInteger(visits) || visits < 0 || visits > total) throw new RangeError('Visitas fuera de rango.');
  if (![1, 2, 3].includes(scale)) throw new RangeError('Escala no válida.');
  const b = normalizeBrand(brand);
  const key = `${kind}|${visits}|${total}|${b.bg}|${b.fg}|${b.icon}|${b.stripBg}|${b.stamp}|${b.stampInk}|${scale}|${caption}`;
  if (cache.has(key)) return cache.get(key);
  const buf = await sharp(Buffer.from(svg(kind, visits, total, b, scale, caption))).png({ compressionLevel: 9 }).toBuffer();
  if (cache.size > 500) cache.clear();
  cache.set(key, buf);
  return buf;
}

/** Imagen de puntos: logo y nombre centrados arriba, saldo grande al centro y barra fina de avance. */
function pointsSvg(kind, points, goal, brand, scale, { name = '', logo = null } = {}) {
  const spec = KINDS[kind];
  if (!spec) throw new RangeError('Tipo de imagen no válido.');
  const w = kind === 'strip' ? 375 : spec.w;
  const h = kind === 'strip' ? POINTS_H : spec.h;
  const k = h / POINTS_H; // diseño base 375x176
  const sc = brand.stamp || brand.fg;
  const bg = kind === 'strip' ? (brand.stripBg || mix(brand.bg, brand.fg, 0.08)) : brand.bg;
  const font = 'font-family="Helvetica, Arial, DejaVu Sans, sans-serif"';
  const num = Number(points).toLocaleString('en-US');
  const pct = goal ? Math.max(0, Math.min(1, points / goal)) : 1;
  const nm = String(name).toUpperCase();
  const nameSize = Math.min(13 * k, (w * 0.8) / Math.max(6, nm.length * 0.66));
  const logoD = 84 * k;
  const barW = Math.min(w * 0.2, 72 * k), barH = Math.max(3, 3 * k);
  const head = (logo ? `<image href="data:image/png;base64,${logo.toString('base64')}" x="${(w - logoD) / 2}" y="${6 * k}" width="${logoD}" height="${logoD}"/>` : '') +
    (nm ? `<text x="${w / 2}" y="${(logo ? 108 : 40) * k}" text-anchor="middle" ${font} font-size="${nameSize.toFixed(2)}" font-weight="700" letter-spacing="1.5" fill="${brand.fg}">${esc(nm)}</text>` : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="${bg}"/>${head}` +
    `<text x="${w / 2}" y="${146 * k}" text-anchor="middle" ${font} font-size="${36 * k}" font-weight="700" fill="${sc}">${esc(num)}</text>` +
    `<text x="${w / 2}" y="${159 * k}" text-anchor="middle" ${font} font-size="${8.5 * k}" letter-spacing="2" fill="${sc}" fill-opacity="0.75">PUNTOS</text>` +
    `<rect x="${(w - barW) / 2}" y="${168 * k}" width="${barW}" height="${barH}" rx="${barH / 2}" fill="${sc}" fill-opacity="0.22"/>` +
    `<rect x="${(w - barW) / 2}" y="${168 * k}" width="${Math.max(barH, barW * pct)}" height="${barH}" rx="${barH / 2}" fill="${sc}"/></svg>`;
}

/** Logo redondo con aro del color del texto (para dibujarlo dentro de la imagen de puntos). */
async function circleLogo(file, px, fg) {
  const ring = Math.max(2, Math.round(px * 0.045));
  const inner = px - ring * 2;
  const circle = Buffer.from(`<svg width="${inner}" height="${inner}"><circle cx="${inner / 2}" cy="${inner / 2}" r="${inner / 2}"/></svg>`);
  const face = await sharp(file).resize(inner, inner, { fit: 'cover' }).composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer();
  const frame = Buffer.from(`<svg width="${px}" height="${px}"><circle cx="${px / 2}" cy="${px / 2}" r="${px / 2 - ring / 2}" fill="none" stroke="${fg}" stroke-width="${ring}" stroke-opacity="0.9"/></svg>`);
  return sharp({ create: { width: px, height: px, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: face, left: ring, top: ring }, { input: frame }]).png().toBuffer();
}

async function renderPoints(kind, points, { goal = 0, name = '', logo = null, brand, scale = 1 } = {}) {
  if (!Number.isInteger(points) || points < 0 || points > 1e9) throw new RangeError('Puntos fuera de rango.');
  if (![1, 2, 3].includes(scale)) throw new RangeError('Escala no válida.');
  const b = normalizeBrand(brand);
  const key = `pts|${kind}|${points}|${goal}|${name}|${logo ? logo.length : 0}|${b.bg}|${b.fg}|${b.stripBg}|${b.stamp}|${scale}`;
  if (cache.has(key)) return cache.get(key);
  const buf = await sharp(Buffer.from(pointsSvg(kind, points, goal, b, scale, { name, logo }))).png({ compressionLevel: 9 }).toBuffer();
  if (cache.size > 500) cache.clear();
  cache.set(key, buf);
  return buf;
}

async function applePointsFiles(points, opts = {}) {
  const [a, b, c] = await Promise.all([1, 2, 3].map((scale) => renderPoints('strip', points, { ...opts, scale })));
  return { 'strip.png': a, 'strip@2x.png': b, 'strip@3x.png': c };
}

/** Icono cuadrado (tijeras sobre el color del negocio). Apple pide icon.png 29/58/87 px. */
async function icon(size, brand) {
  const b = normalizeBrand(brand);
  const s = size / 24 * 0.6;
  const off = (size - 24 * s) / 2;
  const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${b.bg}"/>` +
    `<g transform="translate(${off} ${off}) scale(${s})" fill="none" stroke="${b.fg}" stroke-width="${STROKE[b.icon] || 2}" stroke-linecap="round" stroke-linejoin="round">${ICONS[b.icon] || SCISSORS}</g></svg>`;
  return sharp(Buffer.from(svgText)).png().toBuffer();
}

/** Archivos que Apple espera dentro del .pkpass. */
async function appleStripFiles(visits, opts = {}) {
  const [a, b, c] = await Promise.all([1, 2, 3].map((scale) => render('strip', visits, { ...opts, scale })));
  return { 'strip.png': a, 'strip@2x.png': b, 'strip@3x.png': c };
}

module.exports = { circleLogo, renderPoints, applePointsFiles, ICONS, STROKE, mix, icon, render, appleStripFiles, normalizeBrand, DEFAULT_BRAND, KINDS };
