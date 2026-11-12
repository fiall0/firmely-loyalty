// Textos compartidos por Apple Wallet y Google Wallet.
const { normalizeBrand } = require('./stamps');
const { normalizeSettings } = require('./settings');

const settingsOf = (b) => normalizeSettings(JSON.parse(b.settings_json || '{}'));
/** Siguiente premio por puntos (o null si ya alcanzó todos) y texto corto para tarjetas. */
function pointsInfo(b, c) {
  const cfg = settingsOf(b);
  if (cfg.mode !== 'points') return null;
  const rewards = cfg.points.rewards;
  const next = rewards.find((r) => r.cost > c.visits) || null;
  const top = rewards.filter((r) => r.cost <= c.visits).pop() || null;
  const label = next ? `${next.cost - c.visits} pts para ${next.name}` : (top ? `¡Ya puedes canjear: ${top.name}!` : 'Acumula puntos con tus compras');
  return { cfg, rewards, next, top, label };
}

/** Lo que cuenta la tarjeta: "visita" por defecto, o lo que defina el negocio (p. ej. "lavada"). */
function unitsOf(b) {
  const br = normalizeBrand(JSON.parse(b.brand_json || '{}'));
  return { one: br.unit || 'visita', many: br.units || 'visitas', long: br.unitsLong || br.units || 'visitas', custom: !!br.unit };
}

function statusText(b, c) {
  const pi = pointsInfo(b, c);
  if (pi) {
    if (c.visits === 0) return `Tu tarjeta está en 0 puntos. Ganas 1 punto por cada RD$${pi.cfg.points.pesosPerPoint} de consumo.`;
    return `Tienes ${c.visits} puntos. ${pi.next ? `Te faltan ${pi.next.cost - c.visits} para ${pi.next.name}.` : '¡Ya alcanzas todos los premios!'}${pi.top ? ` Puedes canjear: ${pi.top.name}.` : ''}`;
  }
  const u = unitsOf(b);
  const reward = b.reward.toLowerCase();
  if (c.visits >= b.visits_required) return `¡Tienes tu ${reward} disponible!`;
  if (c.visits === 0) return `Tu tarjeta está en 0 ${u.many}. ¡Te esperamos!`;
  const rem = b.visits_required - c.visits;
  if (u.custom) return `Llevas ${c.visits} de ${b.visits_required} ${u.many}. Te faltan ${rem} para tu ${reward}.`;
  return `Visita registrada: ${c.visits} de ${b.visits_required}. Te faltan ${rem} para tu ${reward}.`;
}
module.exports = { statusText, unitsOf, pointsInfo };
