const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DAY = 24 * 3600 * 1000;
const { normalizeBrand } = require('./stamps');

function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) throw new HttpError(400, 'bad_phone', 'Teléfono inválido: deben ser 10 dígitos.');
  return d;
}
const formatPhone = (d) => `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;

function cleanName(raw) {
  const n = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > 60) throw new HttpError(400, 'bad_name', 'El nombre debe tener entre 2 y 60 caracteres.');
  return n;
}

function createService({ db, secret, now = () => new Date(), hooks = {} }) {
  if (!secret) throw new Error('secret requerido');
  const iso = () => now().toISOString();
  const hook = (name, payload) => { if (typeof hooks[name] === 'function') hooks[name](payload); };

  // ---------- códigos del QR ----------
  const sign = (slug, id) =>
    crypto.createHmac('sha256', secret).update(`${slug}.${id}`).digest('base64url').slice(0, 16);
  const codeFor = (slug, id) => `${slug}.${id}.${sign(slug, id)}`;

  function parseCode(business, code) {
    const parts = String(code ?? '').split('.');
    if (parts.length !== 3) throw new HttpError(400, 'bad_code', 'Código no válido.');
    const [slug, idStr, sig] = parts;
    const expected = Buffer.from(sign(slug, idStr));
    const given = Buffer.from(sig);
    if (slug !== business.slug || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      throw new HttpError(400, 'bad_code', 'Código no válido.');
    }
    return Number(idStr);
  }

  /** Cliente a partir del código firmado del QR (sin efectos). */
  function customerFromCode(b, code) {
    return loadCustomer(b, parseCode(b, code));
  }

  // ---------- negocios y acceso ----------
  function createBusiness({ slug, name, reward, visitsRequired, minHoursBetweenVisits, maxNoticesPerMonth, brand }) {
    if (!/^[a-z0-9-]{2,40}$/.test(slug || '')) throw new HttpError(400, 'bad_slug', 'Slug inválido.');
    const keys = {
      staff: crypto.randomBytes(18).toString('base64url'),
      admin: crypto.randomBytes(18).toString('base64url'),
    };
    try {
      db.prepare(`INSERT INTO businesses
        (slug, name, reward, visits_required, min_hours_between_visits, max_notices_per_month,
         staff_key_hash, admin_key_hash, brand_json, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        slug, name, reward ?? 'Corte gratis', visitsRequired ?? 10, minHoursBetweenVisits ?? 4,
        maxNoticesPerMonth ?? 2, sha256(keys.staff), sha256(keys.admin),
        JSON.stringify(normalizeBrand(brand)), iso());
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'slug_taken', 'Ese slug ya existe.');
      throw e;
    }
    return { business: getBusiness(slug), keys };
  }

  function getBusiness(slug) {
    const b = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slug);
    if (!b) throw new HttpError(404, 'no_business', 'Negocio no encontrado.');
    return b;
  }

  const brandOf = (business) => normalizeBrand(JSON.parse(business.brand_json || '{}'));

  function roleFor(business, key) {
    if (!key) return null;
    const h = Buffer.from(sha256(String(key)));
    const eq = (hash) => crypto.timingSafeEqual(h, Buffer.from(hash));
    if (eq(business.admin_key_hash)) return 'admin';
    if (eq(business.staff_key_hash)) return 'staff';
    return null;
  }

  // ---------- clientes ----------
  function publicCustomer(b, c) {
    return {
      id: c.id,
      name: c.name,
      phone: formatPhone(c.phone_norm),
      visits: c.visits,
      required: b.visits_required,
      remaining: Math.max(0, b.visits_required - c.visits),
      rewardAvailable: c.visits >= b.visits_required,
      rewardsRedeemed: c.rewards_redeemed,
      lastVisitAt: c.last_visit_at,
    };
  }

  function loadCustomer(b, id) {
    const c = db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(id, b.id);
    if (!c) throw new HttpError(404, 'no_customer', 'Cliente no encontrado.');
    return c;
  }

  function logEvent(b, customerId, kind, detail, actor) {
    db.prepare('INSERT INTO events (business_id, customer_id, kind, detail, actor, created_at) VALUES (?,?,?,?,?,?)')
      .run(b.id, customerId, kind, detail ? JSON.stringify(detail) : null, actor ?? null, iso());
  }

  function register(b, { name, phone, consent }) {
    if (consent !== true) throw new HttpError(400, 'no_consent', 'Se requiere aceptar el uso de datos.');
    const cleanedName = cleanName(name);
    const norm = normalizePhone(phone);
    const existing = db.prepare('SELECT * FROM customers WHERE business_id = ? AND phone_norm = ?').get(b.id, norm);
    if (existing) {
      return { customer: publicCustomer(b, existing), code: codeFor(b.slug, existing.id), existing: true };
    }
    const info = db.prepare(`INSERT INTO customers (business_id, name, phone, phone_norm, consent_at, created_at)
      VALUES (?,?,?,?,?,?)`).run(b.id, cleanedName, formatPhone(norm), norm, iso(), iso());
    const c = loadCustomer(b, info.lastInsertRowid);
    logEvent(b, c.id, 'register', null, 'cliente');
    hook('customerChanged', { business: b, customer: publicCustomer(b, c), reason: 'register' });
    return { customer: publicCustomer(b, c), code: codeFor(b.slug, c.id), existing: false };
  }

  function listCustomers(b, q) {
    const term = String(q ?? '').trim();
    let rows;
    if (!term) {
      rows = db.prepare(`SELECT * FROM customers WHERE business_id = ?
        ORDER BY last_visit_at IS NULL, last_visit_at DESC, id DESC LIMIT 200`).all(b.id);
    } else {
      const digits = term.replace(/\D/g, '');
      rows = db.prepare(`SELECT * FROM customers WHERE business_id = ?
        AND (name LIKE ? ESCAPE '\\' ${digits ? 'OR phone_norm LIKE ?' : ''})
        ORDER BY last_visit_at IS NULL, last_visit_at DESC, id DESC LIMIT 200`)
        .all(...[b.id, `%${term.replace(/[\\%_]/g, '\\$&')}%`, ...(digits ? [`%${digits}%`] : [])]);
    }
    return rows.map((c) => publicCustomer(b, c));
  }

  function getCustomer(b, id) {
    const c = loadCustomer(b, id);
    const events = db.prepare(`SELECT kind, detail, actor, created_at FROM events
      WHERE customer_id = ? ORDER BY id DESC LIMIT 50`).all(c.id)
      .map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
    return { customer: publicCustomer(b, c), code: codeFor(b.slug, c.id), events };
  }

  // ---------- visitas ----------
  const scan = (b, code, actor) => db.transaction(() => {
    const c = loadCustomer(b, parseCode(b, code));
    if (c.visits >= b.visits_required) {
      return { status: 'free_available', customer: publicCustomer(b, c) };
    }
    if (c.last_visit_at) {
      const next = new Date(new Date(c.last_visit_at).getTime() + b.min_hours_between_visits * 3600 * 1000);
      if (now() < next) {
        return { status: 'too_soon', nextAllowedAt: next.toISOString(), customer: publicCustomer(b, c) };
      }
    }
    db.prepare('UPDATE customers SET visits = visits + 1, last_visit_at = ? WHERE id = ?').run(iso(), c.id);
    const updated = loadCustomer(b, c.id);
    logEvent(b, c.id, 'visit', { visits: updated.visits }, actor);
    const pub = publicCustomer(b, updated);
    hook('customerChanged', { business: b, customer: pub, reason: 'visit' });
    return { status: 'visit', rewardUnlocked: pub.rewardAvailable, customer: pub };
  })();

  const redeem = (b, code, actor) => db.transaction(() => {
    const c = loadCustomer(b, parseCode(b, code));
    if (c.visits < b.visits_required) {
      throw new HttpError(409, 'not_eligible', `Aún no completa ${b.visits_required} visitas.`);
    }
    db.prepare('UPDATE customers SET visits = 0, rewards_redeemed = rewards_redeemed + 1 WHERE id = ?').run(c.id);
    const updated = loadCustomer(b, c.id);
    logEvent(b, c.id, 'redeem', { reward: b.reward }, actor);
    const pub = publicCustomer(b, updated);
    hook('customerChanged', { business: b, customer: pub, reason: 'redeem' });
    return { status: 'redeemed', customer: pub };
  })();

  // ---------- panel admin ----------
  const updateCustomer = (b, id, patch, actor) => db.transaction(() => {
    const c = loadCustomer(b, id);
    const next = {};
    const before = {};
    if (patch.name !== undefined) next.name = cleanName(patch.name);
    if (patch.phone !== undefined) {
      const norm = normalizePhone(patch.phone);
      const clash = db.prepare('SELECT id FROM customers WHERE business_id = ? AND phone_norm = ? AND id != ?')
        .get(b.id, norm, c.id);
      if (clash) throw new HttpError(409, 'phone_taken', 'Ese teléfono ya pertenece a otro cliente.');
      next.phone_norm = norm;
      next.phone = formatPhone(norm);
    }
    if (patch.visits !== undefined) {
      const v = patch.visits;
      if (!Number.isInteger(v) || v < 0 || v > b.visits_required) {
        throw new HttpError(400, 'bad_visits', `Las visitas deben estar entre 0 y ${b.visits_required}.`);
      }
      next.visits = v;
    }
    const keys = Object.keys(next).filter((k) => k !== 'phone');
    if (!keys.length) throw new HttpError(400, 'empty_patch', 'No hay cambios para guardar.');
    for (const k of keys) before[k] = c[k];
    const changed = keys.filter((k) => next[k] !== c[k]);
    if (changed.length) {
      const sets = Object.keys(next).map((k) => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE customers SET ${sets} WHERE id = @id`).run({ ...next, id: c.id });
      const after = {};
      const prev = {};
      for (const k of changed) { prev[k] = c[k]; after[k] = next[k]; }
      logEvent(b, c.id, 'edit', { before: prev, after }, actor);
    }
    const updated = loadCustomer(b, c.id);
    const pub = publicCustomer(b, updated);
    if (changed.length) hook('customerChanged', { business: b, customer: pub, reason: 'edit' });
    return { customer: pub };
  })();

  const resetVisits = (b, id, actor) => db.transaction(() => {
    const c = loadCustomer(b, id);
    db.prepare('UPDATE customers SET visits = 0 WHERE id = ?').run(c.id);
    logEvent(b, c.id, 'reset', { before: c.visits }, actor);
    const pub = publicCustomer(b, loadCustomer(b, c.id));
    hook('customerChanged', { business: b, customer: pub, reason: 'reset' });
    return { customer: pub };
  })();

  // Borra al cliente y todo lo suyo (historial, avisos, registros de Apple). El pase que ya esté en su
  // teléfono deja de actualizarse y de funcionar en la caja. Queda un registro anónimo del borrado.
  const deleteCustomer = (b, id, actor) => db.transaction(() => {
    const c = loadCustomer(b, id);
    const pub = publicCustomer(b, c);
    for (const t of ['apple_registrations', 'notice_deliveries', 'pass_changes', 'events']) {
      db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(c.id);
    }
    db.prepare('DELETE FROM customers WHERE id = ?').run(c.id);
    logEvent(b, null, 'delete', { name: c.name }, actor);
    hook('customerChanged', { business: b, customer: pub, reason: 'delete' });
    return { deleted: true };
  })();

  function stats(b) {
    const since = new Date(now().getTime() - 7 * DAY).toISOString();
    return {
      customers: db.prepare('SELECT COUNT(*) n FROM customers WHERE business_id = ?').get(b.id).n,
      visitsThisWeek: db.prepare(`SELECT COUNT(*) n FROM events
        WHERE business_id = ? AND kind = 'visit' AND created_at >= ?`).get(b.id, since).n,
      rewardsRedeemed: db.prepare(`SELECT COALESCE(SUM(rewards_redeemed),0) n FROM customers
        WHERE business_id = ?`).get(b.id).n,
    };
  }

  // ---------- avisos ----------
  const AUDIENCES = ['all', 'inactive', 'near_reward'];

  function audience(b, kind, weeks) {
    if (!AUDIENCES.includes(kind)) throw new HttpError(400, 'bad_audience', 'Audiencia no válida.');
    if (kind === 'all') return db.prepare('SELECT * FROM customers WHERE business_id = ?').all(b.id);
    if (kind === 'inactive') {
      const w = weeks === undefined ? 5 : weeks;
      if (!Number.isInteger(w) || w < 1 || w > 52) throw new HttpError(400, 'bad_weeks', 'Semanas entre 1 y 52.');
      const cutoff = new Date(now().getTime() - w * 7 * DAY).toISOString();
      return db.prepare(`SELECT * FROM customers WHERE business_id = ?
        AND last_visit_at IS NOT NULL AND last_visit_at <= ?`).all(b.id, cutoff);
    }
    return db.prepare(`SELECT * FROM customers WHERE business_id = ?
      AND visits >= ? AND visits < ?`).all(b.id, b.visits_required - 2, b.visits_required);
  }

  const sendNotice = (b, { audience: kind, weeks, message, dryRun }, actor) => db.transaction(() => {
    const msg = String(message ?? '').trim();
    if (!dryRun && (msg.length < 1 || msg.length > 80)) {
      throw new HttpError(400, 'bad_message', 'El mensaje debe tener entre 1 y 80 caracteres.');
    }
    const monthAgo = new Date(now().getTime() - 30 * DAY).toISOString();
    const recipients = [];
    let skipped = 0;
    for (const c of audience(b, kind, weeks)) {
      const n = db.prepare('SELECT COUNT(*) n FROM notice_deliveries WHERE customer_id = ? AND created_at >= ?')
        .get(c.id, monthAgo).n;
      if (n >= b.max_notices_per_month) skipped += 1;
      else recipients.push(c);
    }
    if (dryRun) return { dryRun: true, sent: recipients.length, skippedCapped: skipped };
    const info = db.prepare(`INSERT INTO notices (business_id, audience, message, sent, skipped, actor, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(b.id, kind, msg, recipients.length, skipped, actor ?? null, iso());
    const ins = db.prepare('INSERT INTO notice_deliveries (notice_id, customer_id, created_at) VALUES (?,?,?)');
    for (const c of recipients) ins.run(info.lastInsertRowid, c.id, iso());
    logEvent(b, null, 'notice', { audience: kind, sent: recipients.length, skipped }, actor);
    hook('notice', { business: b, message: msg, customers: recipients.map((c) => publicCustomer(b, c)) });
    return { noticeId: Number(info.lastInsertRowid), sent: recipients.length, skippedCapped: skipped };
  })();

  return {
    createBusiness, getBusiness, roleFor, codeFor, brandOf, customerFromCode, publicCustomer,
    register, listCustomers, getCustomer, scan, redeem,
    updateCustomer, resetVisits, deleteCustomer, stats, sendNotice,
  };
}

module.exports = { createService, HttpError, normalizePhone };
