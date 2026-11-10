// Crea el negocio de ejemplo (Undercut) y muestra sus llaves UNA sola vez.
const path = require('path');
const fs = require('fs');
const { open } = require('./db');
const { createService, HttpError } = require('./service');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'loyalty.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const svc = createService({ db: open(file), secret: process.env.CODE_SECRET || 'dev-secret-cambiar' });

try {
  const { keys } = svc.createBusiness({ slug: 'undercut', name: 'Undercut' });
  console.log('Negocio "undercut" creado.');
  console.log('Llave de caja  (x-api-key):', keys.staff);
  console.log('Llave de admin (x-api-key):', keys.admin);
} catch (e) {
  if (e instanceof HttpError && e.code === 'slug_taken') console.log('El negocio "undercut" ya existe.');
  else throw e;
}
