// Textos compartidos por Apple Wallet y Google Wallet.
const { normalizeBrand } = require('./stamps');

/** Lo que cuenta la tarjeta: "visita" por defecto, o lo que defina el negocio (p. ej. "lavada"). */
function unitsOf(b) {
  const br = normalizeBrand(JSON.parse(b.brand_json || '{}'));
  return { one: br.unit || 'visita', many: br.units || 'visitas', long: br.unitsLong || br.units || 'visitas', custom: !!br.unit };
}

function statusText(b, c) {
  const u = unitsOf(b);
  const reward = b.reward.toLowerCase();
  if (c.visits >= b.visits_required) return `¡Tienes tu ${reward} disponible!`;
  if (c.visits === 0) return `Tu tarjeta está en 0 ${u.many}. ¡Te esperamos!`;
  const rem = b.visits_required - c.visits;
  if (u.custom) return `Llevas ${c.visits} de ${b.visits_required} ${u.many}. Te faltan ${rem} para tu ${reward}.`;
  return `Visita registrada: ${c.visits} de ${b.visits_required}. Te faltan ${rem} para tu ${reward}.`;
}
module.exports = { statusText, unitsOf };
