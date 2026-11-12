// Logos de los negocios. Los subidos desde el panel viven en LOGOS_DIR (el volumen, para que sobrevivan
// a los redeploys); los que vienen con el código (assets/logos) sirven de respaldo.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const repoDir = path.join(__dirname, '..', 'assets', 'logos');
const SLUG = /^[a-z0-9-]+$/;
const err = (status, code, message) => Object.assign(new Error(message), { status, code });

function find(slug) {
  if (!SLUG.test(slug || '')) return null;
  for (const d of [process.env.LOGOS_DIR, repoDir]) {
    if (!d) continue;
    const f = path.join(d, `${slug}.png`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** Guarda un logo recibido como data URL (png/jpeg/webp), lo deja cuadrado de 600 px sobre el color del negocio. */
async function saveFromDataUrl(slug, dataUrl, bg = '#000000') {
  const dir = process.env.LOGOS_DIR;
  if (!dir) throw err(500, 'no_logos_dir', 'LOGOS_DIR no configurado.');
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw err(400, 'bad_logo', 'El logo debe ser PNG, JPG o WEBP.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) throw err(400, 'logo_big', 'El logo pesa más de 3 MB.');
  let png;
  try {
    png = await sharp(buf).resize(600, 600, { fit: 'contain', background: bg }).flatten({ background: bg }).png().toBuffer();
  } catch {
    throw err(400, 'bad_logo', 'No se pudo leer la imagen.');
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.png`), png);
}

function remove(slug) {
  const dir = process.env.LOGOS_DIR;
  if (dir && SLUG.test(slug)) fs.rmSync(path.join(dir, `${slug}.png`), { force: true });
}

module.exports = { find, saveFromDataUrl, remove };
