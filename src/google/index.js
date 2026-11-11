// Google Wallet: clase y objeto de lealtad, enlace "Agregar a Google Wallet" (JWT firmado) y avisos por la API.
const crypto = require('crypto');
const { HttpError } = require('../service');
const { statusText } = require('../text');

const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
const b64u = (x) => Buffer.from(x).toString('base64url');

function signJwt(claims, privateKey) {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(claims));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function createGoogle({ db, svc, config, fetchFn = fetch, now = () => Date.now() }) {
  const { issuerId, saEmail, privateKey, publicUrl } = config;
  if (!issuerId || !saEmail || !privateKey || !publicUrl) throw new Error('Google Wallet: configuración incompleta');
  const base = publicUrl.replace(/\/+$/, '');
  const classId = (b) => `${issuerId}.${b.slug}`;
  const objectId = (b, customerId) => `${issuerId}.${b.slug}-${customerId}`;
  const text = (value) => ({ defaultValue: { language: 'es', value } });

  // ---------- token de acceso (cuenta de servicio) ----------
  let token = null;
  let tokenExp = 0;
  async function accessToken() {
    if (token && now() < tokenExp - 60000) return token;
    const iat = Math.floor(now() / 1000);
    const assertion = signJwt({ iss: saEmail, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }, privateKey);
    const r = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Google token ${r.status}: ${j.error_description || j.error || ''}`);
    token = j.access_token;
    tokenExp = now() + (j.expires_in || 3600) * 1000;
    return token;
  }
  async function call(method, path, body) {
    const r = await fetchFn(`${API}${path}`, {
      method, headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, json: j };
  }

  // ---------- clase (una por negocio) y objeto (uno por cliente) ----------
  function classBody(b) {
    const brand = svc.brandOf(b);
    return {
      id: classId(b),
      issuerName: b.name,
      programName: b.name,
      reviewStatus: 'UNDER_REVIEW',
      hexBackgroundColor: brand.bg,
      programLogo: { sourceUri: { uri: `${base}/api/${b.slug}/logo.png` }, contentDescription: text(`Logo de ${b.name}`) },
      multipleDevicesAndHoldersAllowedStatus: 'MULTIPLE_HOLDERS',
    };
  }
  function lastNotice(customerId) {
    const row = db.prepare(`SELECT n.message FROM notice_deliveries d JOIN notices n ON n.id = d.notice_id
      WHERE d.customer_id = ? ORDER BY d.rowid DESC LIMIT 1`).get(customerId);
    return row ? row.message : null;
  }
  function objectBody(b, row) {
    return {
      id: objectId(b, row.id),
      classId: classId(b),
      state: 'ACTIVE',
      accountId: `${b.slug}-${row.id}`,
      accountName: row.name,
      barcode: { type: 'QR_CODE', value: svc.codeFor(b.slug, row.id) },
      loyaltyPoints: { label: 'Visitas', balance: { string: `${row.visits} de ${b.visits_required}` } },
      secondaryLoyaltyPoints: { label: 'Recompensa', balance: { string: b.reward } },
      heroImage: {
        sourceUri: { uri: `${base}/api/${b.slug}/stamp/${Math.min(row.visits, b.visits_required)}.png?kind=hero&r=${row.visits}` },
        contentDescription: text(`${row.visits} de ${b.visits_required} visitas`),
      },
      textModulesData: [
        { id: 'status', header: 'Estado', body: statusText(b, row) },
        { id: 'aviso', header: 'Último aviso', body: lastNotice(row.id) || 'Sin avisos' },
      ],
    };
  }
  const loadRow = (b, id) => db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(id, b.id);

  const ensured = new Set();
  async function ensureClass(b) {
    if (ensured.has(b.slug)) return;
    const body = classBody(b);
    let r = await call('POST', '/loyaltyClass', body);
    if (r.status === 409) r = await call('PATCH', `/loyaltyClass/${encodeURIComponent(body.id)}`, body);
    if (!r.ok) throw new Error(`Google clase ${r.status}: ${r.json.error?.message || ''}`);
    ensured.add(b.slug);
  }

  /** Enlace "Agregar a Google Wallet" para un cliente. */
  async function saveUrl(b, customerId) {
    const row = loadRow(b, customerId);
    if (!row) throw new HttpError(404, 'no_customer', 'Cliente no encontrado.');
    const payload = { loyaltyObjects: [objectBody(b, row)] };
    try { await ensureClass(b); } catch (e) {
      console.error('[google]', e.message);
      payload.loyaltyClasses = [classBody(b)]; // respaldo: la clase viaja dentro del enlace
    }
    const claims = { iss: saEmail, aud: 'google', typ: 'savetowallet', iat: Math.floor(now() / 1000), origins: [], payload };
    return `https://pay.google.com/gp/v/save/${signJwt(claims, privateKey)}`;
  }

  // ---------- actualizaciones ----------
  async function patchObject(b, customerId) {
    const row = loadRow(b, customerId);
    if (!row) return;
    const body = objectBody(b, row);
    const r = await call('PATCH', `/loyaltyObject/${encodeURIComponent(body.id)}`, body);
    if (!r.ok && r.status !== 404) console.error(`[google] actualizar ${r.status}: ${r.json.error?.message || ''}`);
  }
  async function message(b, customerId, header, bodyText) {
    const r = await call('POST', `/loyaltyObject/${encodeURIComponent(objectId(b, customerId))}/addMessage`,
      { message: { header, body: bodyText, messageType: 'TEXT_AND_NOTIFY' } });
    if (!r.ok && r.status !== 404) console.error(`[google] aviso ${r.status}: ${r.json.error?.message || ''}`);
  }

  const swallow = (p) => p.catch((e) => console.error('[google]', e.message));
  const hooks = {
    customerChanged: ({ business, customer, reason }) => reason === 'register' ? undefined : swallow((async () => {
      if (reason === 'delete') { // el cliente ya no existe: el pase se marca inactivo en su Wallet
        await call('PATCH', `/loyaltyObject/${encodeURIComponent(objectId(business, customer.id))}`, { state: 'INACTIVE' });
        return;
      }
      await patchObject(business, customer.id);
      if (reason === 'visit' || reason === 'redeem') {
        const row = loadRow(business, customer.id);
        await message(business, customer.id, business.name, statusText(business, row));
      }
    })()),
    notice: ({ business, message: msg, customers }) => swallow((async () => {
      for (let i = 0; i < customers.length; i += 5) {
        await Promise.all(customers.slice(i, i + 5).map(async (c) => {
          await patchObject(business, c.id);
          await message(business, c.id, business.name, msg);
        }));
      }
    })()),
  };

  return { saveUrl, hooks, classBody, objectBody, objectId, classId };
}

/** Configuración desde variables de entorno; null si Google Wallet no está configurado. */
function configFromEnv(env = process.env) {
  if (!env.GOOGLE_ISSUER_ID) return null;
  const raw = env.GOOGLE_SA_JSON || (env.GOOGLE_SA_JSON_B64 ? Buffer.from(env.GOOGLE_SA_JSON_B64, 'base64').toString() : '');
  const publicUrl = env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');
  let sa = null;
  try { sa = JSON.parse(raw); } catch { /* se avisa abajo */ }
  if (!sa || !sa.client_email || !sa.private_key || !publicUrl) {
    console.warn('Google Wallet desactivado: faltan GOOGLE_SA_JSON (cuenta de servicio) o PUBLIC_URL.');
    return null;
  }
  return { issuerId: env.GOOGLE_ISSUER_ID, saEmail: sa.client_email, privateKey: sa.private_key, publicUrl };
}

module.exports = { createGoogle, configFromEnv, signJwt };
