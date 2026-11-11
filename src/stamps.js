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
const ICONS = { scissors: SCISSORS, cup: CUP };
const HEX = /^#[0-9a-fA-F]{6}$/;

function normalizeBrand(brand = {}) {
  const out = { ...DEFAULT_BRAND };
  for (const k of ['bg', 'fg']) if (HEX.test(brand[k] || '')) out[k] = brand[k];
  if (ICONS[brand.icon]) out.icon = brand.icon;
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
  const s = (d * 0.42) / 24;
  const sw = Math.max(1.5, d * 0.04);
  let body = '';
  for (let i = 0; i < total; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const cx = x0 + c * (d + gap) + d / 2;
    const cy = y0 + r * (d + gap) + d / 2;
    const filled = i < n;
    body += filled
      ? `<circle cx="${cx}" cy="${cy}" r="${d / 2}" fill="${brand.fg}"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${d / 2 - sw / 2}" fill="none" stroke="${brand.fg}" stroke-opacity="0.55" stroke-width="${sw}"/>`;
    body += `<g transform="translate(${cx - 12 * s} ${cy - 12 * s}) scale(${s})" fill="none" stroke="${filled ? brand.bg : brand.fg}" ` +
      `stroke-opacity="${filled ? 1 : 0.55}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[brand.icon] || SCISSORS}</g>`;
  }
  if (caption) {
    body += `<text x="${x0}" y="${h - 9}" font-family="Helvetica, Arial, DejaVu Sans, sans-serif" font-size="12.5" ` +
      `fill="${brand.fg}" fill-opacity="0.85">${esc(caption)}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="${kind === 'strip' ? mix(brand.bg, brand.fg, 0.08) : brand.bg}"/>${body}</svg>`;
}

const cache = new Map();

/** PNG de los sellos. Devuelve un Buffer. */
async function render(kind, visits, { total = 10, brand, scale = 1, caption = '' } = {}) {
  if (!Number.isInteger(visits) || visits < 0 || visits > total) throw new RangeError('Visitas fuera de rango.');
  if (![1, 2, 3].includes(scale)) throw new RangeError('Escala no válida.');
  const b = normalizeBrand(brand);
  const key = `${kind}|${visits}|${total}|${b.bg}|${b.fg}|${b.icon}|${scale}|${caption}`;
  if (cache.has(key)) return cache.get(key);
  const buf = await sharp(Buffer.from(svg(kind, visits, total, b, scale, caption))).png({ compressionLevel: 9 }).toBuffer();
  if (cache.size > 500) cache.clear();
  cache.set(key, buf);
  return buf;
}

/** Icono cuadrado (tijeras sobre el color del negocio). Apple pide icon.png 29/58/87 px. */
async function icon(size, brand) {
  const b = normalizeBrand(brand);
  const s = size / 24 * 0.6;
  const off = (size - 24 * s) / 2;
  const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${b.bg}"/>` +
    `<g transform="translate(${off} ${off}) scale(${s})" fill="none" stroke="${b.fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[b.icon] || SCISSORS}</g></svg>`;
  return sharp(Buffer.from(svgText)).png().toBuffer();
}

/** Archivos que Apple espera dentro del .pkpass. */
async function appleStripFiles(visits, opts = {}) {
  const [a, b, c] = await Promise.all([1, 2, 3].map((scale) => render('strip', visits, { ...opts, scale })));
  return { 'strip.png': a, 'strip@2x.png': b, 'strip@3x.png': c };
}

module.exports = { mix, icon, render, appleStripFiles, normalizeBrand, DEFAULT_BRAND, KINDS };
