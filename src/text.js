// Textos compartidos por Apple Wallet y Google Wallet.
function statusText(b, c) {
  if (c.visits >= b.visits_required) return `¡Tienes tu ${b.reward.toLowerCase()} disponible!`;
  if (c.visits === 0) return 'Tu tarjeta está en 0 visitas. ¡Te esperamos!';
  return `Visita registrada: ${c.visits} de ${b.visits_required}. Te faltan ${b.visits_required - c.visits} para tu ${b.reward.toLowerCase()}.`;
}
module.exports = { statusText };
