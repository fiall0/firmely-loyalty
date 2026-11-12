// Ajustes por negocio (guardados como JSON): ubicaciones para avisos por cercanía, avisos automáticos
// y opciones activables (cumpleaños, referidos, días de visita doble).
const DEFAULTS = {
  timezone: 'America/Santo_Domingo',
  locations: [], // [{ name, lat, lng }] hasta 10 (límite de Apple Wallet)
  proximityText: '',
  auto: {
    inactive: { enabled: true, weeks: 5, message: '' },
    rewardWaiting: { enabled: true, days: 7, message: '' },
  },
  birthday: { enabled: false, bonusVisits: 1, message: '' },
  referral: { enabled: false, referrerBonus: 1, newBonus: 0 },
  doubleDays: { enabled: false, days: [], multiplier: 2 },
  // Tipo de tarjeta: 'stamps' (sellos por visita) o 'points' (puntos por consumo).
  mode: 'stamps',
  points: { pesosPerPoint: 100, rewards: [] }, // rewards: [{ id, name, cost }]
};

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const text = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function normalizeSettings(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULTS;
  const out = JSON.parse(JSON.stringify(d));
  if (typeof r.timezone === 'string' && validTimezone(r.timezone)) out.timezone = r.timezone;
  if (Array.isArray(r.locations)) {
    out.locations = r.locations.slice(0, 10).map((l) => ({
      name: text(l && l.name, 40), lat: Number(l && l.lat), lng: Number(l && l.lng),
    })).filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng) && Math.abs(l.lat) <= 90 && Math.abs(l.lng) <= 180
      && !(l.lat === 0 && l.lng === 0));
  }
  out.proximityText = text(r.proximityText);
  const a = r.auto || {};
  const ai = a.inactive || {}; const aw = a.rewardWaiting || {};
  out.auto.inactive = { enabled: bool(ai.enabled, d.auto.inactive.enabled), weeks: isInt(ai.weeks, 1, 52) ? ai.weeks : d.auto.inactive.weeks, message: text(ai.message) };
  out.auto.rewardWaiting = { enabled: bool(aw.enabled, d.auto.rewardWaiting.enabled), days: isInt(aw.days, 1, 90) ? aw.days : d.auto.rewardWaiting.days, message: text(aw.message) };
  const bd = r.birthday || {};
  out.birthday = { enabled: bool(bd.enabled, false), bonusVisits: isInt(bd.bonusVisits, 0, 3) ? bd.bonusVisits : 1, message: text(bd.message) };
  const rf = r.referral || {};
  out.referral = { enabled: bool(rf.enabled, false), referrerBonus: isInt(rf.referrerBonus, 0, 3) ? rf.referrerBonus : 1, newBonus: isInt(rf.newBonus, 0, 3) ? rf.newBonus : 0 };
  const dd = r.doubleDays || {};
  out.doubleDays = {
    enabled: bool(dd.enabled, false),
    days: Array.isArray(dd.days) ? [...new Set(dd.days.filter((x) => isInt(x, 0, 6)))].sort() : [],
    multiplier: isInt(dd.multiplier, 2, 3) ? dd.multiplier : 2,
  };
  out.mode = r.mode === 'points' ? 'points' : 'stamps';
  out.points = normalizePoints(r.points);
  if (out.mode === 'points') { // los bonos de cumpleaños y referidos se cuentan en visitas: no aplican a puntos
    out.birthday.enabled = false;
    out.referral.enabled = false;
  }
  return out;
}

/** Catálogo de premios por puntos: hasta 8, cada uno con id estable (r1, r2…) y costo entero. */
function normalizePoints(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const per = Number(p.pesosPerPoint);
  const rewards = [];
  const used = new Set();
  for (const x of Array.isArray(p.rewards) ? p.rewards.slice(0, 8) : []) {
    const name = text(x && x.name, 40);
    const cost = Number(x && x.cost);
    if (!name || !Number.isInteger(cost) || cost < 1 || cost > 100000) continue;
    let id = /^[a-z0-9]{1,8}$/.test(String(x.id || '')) && !used.has(x.id) ? x.id : null;
    for (let i = 1; !id; i++) if (!used.has(`r${i}`)) id = `r${i}`;
    used.add(id);
    rewards.push({ id, name, cost });
  }
  rewards.sort((a, b) => a.cost - b.cost);
  return { pesosPerPoint: Number.isInteger(per) && per >= 1 && per <= 100000 ? per : 100, rewards };
}

/** Día de la semana (0 = domingo), mes, día, año y hora en la zona horaria del negocio. */
function localParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { weekday: wd, year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24 };
}

/** Saca latitud y longitud de lo que el dueño pegue: "18.48, -69.93" o un enlace de Google Maps. */
function parseCoords(input) {
  const s = decodeURIComponent(String(input || '')).trim();
  const ok = (a, b) => {
    const lat = Number(a), lng = Number(b);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  };
  let m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(s); // pin exacto de un lugar
  if (m) return ok(m[1], m[2]);
  m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(s);
  if (m) return ok(m[1], m[2]);
  m = /[?&](?:q|ll|query|destination)=(-?\d+(?:\.\d+)?)[,+ ]\s*(-?\d+(?:\.\d+)?)/.exec(s);
  if (m) return ok(m[1], m[2]);
  m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(s);
  if (m) return ok(m[1], m[2]);
  return null;
}

/** MM-DD válido (acepta 29 de febrero) o null. */
function parseBirthday(v) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const mo = Number(m[1]), da = Number(m[2]);
  const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (!max || da < 1 || da > max) return null;
  return `${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}

module.exports = { DEFAULTS, normalizeSettings, normalizePoints, localParts, parseCoords, parseBirthday };
