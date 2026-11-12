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
const { normalizeSettings, localParts, parseBirthday } = require('./settings');
const { unitsOf } = require('./text');

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

  // ---------- ajustes, referidos ----------
  const getSettings = (b) => normalizeSettings(JSON.parse(b.settings_json || '{}'));
  const refCodeFor = (slug, id) =>
    `${id}.${crypto.createHmac('sha256', secret).update(`ref.${slug}.${id}`).digest('base64url').slice(0, 8)}`;
  function parseRef(b, ref) {
    const m = /^(\d{1,9})\.([A-Za-z0-9_-]{8})$/.exec(String(ref ?? ''));
    if (!m) return null;
    const expected = Buffer.from(refCodeFor(b.slug, m[1]));
    const given = Buffer.from(String(ref));
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    return Number(m[1]);
  }

  function register(b, { name, phone, consent, birthday, ref }) {
    if (consent !== true) throw new HttpError(400, 'no_consent', 'Se requiere aceptar el uso de datos.');
    const cleanedName = cleanName(name);
    const norm = normalizePhone(phone);
    const cfg = getSettings(b);
    const extra = cfg.referral.enabled ? { referralCode: undefined } : {};
    const existing = db.prepare('SELECT * FROM customers WHERE business_id = ? AND phone_norm = ?').get(b.id, norm);
    if (existing) {
      if (cfg.referral.enabled) extra.referralCode = refCodeFor(b.slug, existing.id);
      return { customer: publicCustomer(b, existing), code: codeFor(b.slug, existing.id), existing: true, ...extra };
    }
    let bday = null;
    if (cfg.birthday.enabled && birthday) {
      bday = parseBirthday(birthday);
      if (!bday) throw new HttpError(400, 'bad_birthday', 'Cumpleaños no válido.');
    }
    let referredBy = null;
    if (cfg.referral.enabled && ref) {
      const rid = parseRef(b, ref);
      if (rid && db.prepare('SELECT 1 FROM customers WHERE id = ? AND business_id = ?').get(rid, b.id)) referredBy = rid;
    }
    const info = db.prepare(`INSERT INTO customers (business_id, name, phone, phone_norm, birthday, referred_by, consent_at, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(b.id, cleanedName, formatPhone(norm), norm, bday, referredBy, iso(), iso());
    const c = loadCustomer(b, info.lastInsertRowid);
    logEvent(b, c.id, 'register', referredBy ? { referredBy } : null, 'cliente');
    hook('customerChanged', { business: b, customer: publicCustomer(b, c), reason: 'register' });
    if (cfg.referral.enabled) extra.referralCode = refCodeFor(b.slug, c.id);
    return { customer: publicCustomer(b, c), code: codeFor(b.slug, c.id), existing: false, ...extra };
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
    const cfg = getSettings(b);
    const today = localParts(now(), cfg.timezone);
    const double = cfg.doubleDays.enabled && cfg.doubleDays.days.includes(today.weekday);
    let add = double ? cfg.doubleDays.multiplier : 1;
    const firstVisit = !c.last_visit_at;
    const paysReferral = firstVisit && c.referred_by && !c.referral_paid && cfg.referral.enabled;
    if (paysReferral) add += cfg.referral.newBonus;
    const newVisits = Math.min(b.visits_required, c.visits + add);
    db.prepare('UPDATE customers SET visits = ?, last_visit_at = ?, referral_paid = referral_paid OR ? WHERE id = ?')
      .run(newVisits, iso(), paysReferral ? 1 : 0, c.id);
    const updated = loadCustomer(b, c.id);
    logEvent(b, c.id, 'visit', { visits: updated.visits, added: updated.visits - c.visits, double }, actor);
    const pub = publicCustomer(b, updated);
    hook('customerChanged', { business: b, customer: pub, reason: 'visit' });
    if (paysReferral && cfg.referral.referrerBonus > 0) {
      const ref = db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(c.referred_by, b.id);
      if (ref) {
        const rv = Math.min(b.visits_required, ref.visits + cfg.referral.referrerBonus);
        if (rv !== ref.visits) {
          db.prepare('UPDATE customers SET visits = ? WHERE id = ?').run(rv, ref.id);
          logEvent(b, ref.id, 'referral_reward', { friend: c.name, added: rv - ref.visits }, 'sistema');
          const after = loadCustomer(b, ref.id);
          hook('customerChanged', { business: b, customer: publicCustomer(b, after), reason: 'edit' });
          deliver(b, [after], `¡Tu amigo ${c.name.split(' ')[0]} ya visitó ${b.name}! Ganaste ${rv - ref.visits} ${rv - ref.visits === 1 ? unitsOf(b).one : unitsOf(b).many}.`, 'auto_referral', 'sistema');
        }
      }
    }
    return { status: 'visit', rewardUnlocked: pub.rewardAvailable, added: updated.visits - c.visits, doubleDay: double, customer: pub };
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

  /** Crea un cliente de ejemplo SIN avisar a Apple/Google, corre fn(customerId) y lo borra. */
  async function withSampleCustomer(slug, fn) {
    const b = getBusiness(slug);
    const norm = `ejemplo${crypto.randomBytes(4).toString('hex')}`;
    const half = Math.floor(b.visits_required / 2);
    const id = db.prepare(`INSERT INTO customers (business_id, name, phone, phone_norm, visits, consent_at, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(b.id, 'Cliente Ejemplo', '(809) 555-0100', norm, half, iso(), iso()).lastInsertRowid;
    try { return await fn(Number(id), b); } finally {
      for (const t of ['apple_registrations', 'notice_deliveries', 'pass_changes', 'events']) db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
  }

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

  // ---------- avisos del sistema (automáticos, cumpleaños, referidos) ----------
  function deliver(b, customers, msg, audience, actor, { capped = false } = {}) {
    const text = String(msg).slice(0, 80);
    const monthAgo = new Date(now().getTime() - 30 * DAY).toISOString();
    const recipients = [];
    let skipped = 0;
    for (const c of customers) {
      if (capped) {
        const n = db.prepare('SELECT COUNT(*) n FROM notice_deliveries WHERE customer_id = ? AND created_at >= ?').get(c.id, monthAgo).n;
        if (n >= b.max_notices_per_month) { skipped += 1; continue; }
      }
      recipients.push(c);
    }
    if (!recipients.length) return { sent: 0, skipped };
    const info = db.prepare(`INSERT INTO notices (business_id, audience, message, sent, skipped, actor, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(b.id, audience, text, recipients.length, skipped, actor ?? null, iso());
    const ins = db.prepare('INSERT INTO notice_deliveries (notice_id, customer_id, created_at) VALUES (?,?,?)');
    for (const c of recipients) ins.run(info.lastInsertRowid, c.id, iso());
    logEvent(b, null, 'notice', { audience, sent: recipients.length, skipped }, actor);
    hook('notice', { business: b, message: text, customers: recipients.map((c) => publicCustomer(b, c)) });
    return { sent: recipients.length, skipped };
  }

  const DAYS_ES = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
  const joinEs = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} y ${a[a.length - 1]}`);

  /** Textos extra que se muestran en el pase (reverso): referidos, visitas dobles y cumpleaños. */
  function extraInfo(b, row, base) {
    const cfg = getSettings(b);
    const u = unitsOf(b);
    const out = [];
    if (cfg.referral.enabled) {
      const n = cfg.referral.referrerBonus;
      out.push({ key: 'invita', label: 'Invita a un amigo',
        text: `Comparte tu enlace: ${String(base).replace(/\/+$/, '')}/r/${b.slug}?ref=${refCodeFor(b.slug, row.id)}` +
          (n > 0 ? ` Cuando tu amigo haga su primera ${u.one}, ganas ${n} ${n === 1 ? u.one : u.many}.` : '') });
    }
    if (cfg.doubleDays.enabled && cfg.doubleDays.days.length) {
      out.push({ key: 'doble', label: 'Días especiales',
        text: `Los ${joinEs(cfg.doubleDays.days.map((d) => DAYS_ES[d]))}, cada ${u.one} cuenta ${cfg.doubleDays.multiplier === 3 ? 'triple' : 'doble'}.` });
    }
    if (cfg.birthday.enabled && cfg.birthday.bonusVisits > 0 && row.birthday) {
      out.push({ key: 'cumple', label: 'Regalo de cumpleaños',
        text: `El día de tu cumpleaños te regalamos ${cfg.birthday.bonusVisits} ${cfg.birthday.bonusVisits === 1 ? u.one : u.many}.` });
    }
    return out;
  }

  /** Ubicaciones para que el teléfono muestre la tarjeta al pasar cerca del local. */
  function proximity(b) {
    const cfg = getSettings(b);
    return {
      locations: cfg.locations.map((l) => ({ latitude: l.lat, longitude: l.lng })),
      text: cfg.proximityText || `¡Estás cerca de ${b.name}! Muestra tu tarjeta.`,
    };
  }

  /** Que los pases ya instalados se vuelvan a descargar con la información nueva. */
  function refreshPasses(b) {
    db.prepare('INSERT INTO pass_changes (customer_id) SELECT id FROM customers WHERE business_id = ?').run(b.id);
    for (const c of db.prepare('SELECT * FROM customers WHERE business_id = ?').all(b.id)) {
      hook('customerChanged', { business: b, customer: publicCustomer(b, c), reason: 'edit' });
    }
  }

  function updateSettings(b, patch = {}, actor) {
    const cur = getSettings(b);
    const allowed = ['timezone', 'locations', 'proximityText', 'auto', 'birthday', 'referral', 'doubleDays'];
    const clean = {};
    for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
    if (!Object.keys(clean).length) throw new HttpError(400, 'empty_patch', 'No hay cambios para guardar.');
    const next = normalizeSettings({ ...cur, ...clean });
    db.prepare('UPDATE businesses SET settings_json = ? WHERE id = ?').run(JSON.stringify(next), b.id);
    logEvent(b, null, 'settings', { changed: Object.keys(clean) }, actor);
    const onPass = ['locations', 'proximityText', 'referral', 'doubleDays', 'birthday']
      .some((k) => clean[k] !== undefined && JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
    if (onPass) refreshPasses(getBusiness(b.slug));
    return next;
  }

  // ---------- métricas ----------
  function metrics(b) {
    const cfg = getSettings(b);
    const nowMs = now().getTime();
    const ago = (d) => new Date(nowMs - d * DAY).toISOString();
    const one = (sql, ...a) => db.prepare(sql).get(b.id, ...a);
    const customers = one('SELECT COUNT(*) n FROM customers WHERE business_id = ?').n;
    const visitTimes = db.prepare("SELECT created_at t FROM events WHERE business_id = ? AND kind = 'visit' AND created_at >= ?")
      .all(b.id, ago(56)).map((r) => new Date(r.t));
    const weekly = Array(8).fill(0);
    const byWeekday = Array(7).fill(0);
    for (const t of visitTimes) {
      const w = Math.floor((nowMs - t.getTime()) / (7 * DAY));
      if (w >= 0 && w < 8) weekly[7 - w] += 1;
      byWeekday[localParts(t, cfg.timezone).weekday] += 1;
    }
    const weekEnds = Array.from({ length: 8 }, (_, i) => new Date(nowMs - (7 - i) * 7 * DAY).toISOString());
    const visits7 = weekly[7];
    const visits30 = one("SELECT COUNT(*) n FROM events WHERE business_id = ? AND kind = 'visit' AND created_at >= ?", ago(30)).n;
    const withVisit = one("SELECT COUNT(DISTINCT customer_id) n FROM events WHERE business_id = ? AND kind = 'visit'").n;
    const returning = one(`SELECT COUNT(*) n FROM (SELECT customer_id FROM events WHERE business_id = ? AND kind = 'visit'
      GROUP BY customer_id HAVING COUNT(*) >= 2)`).n;
    const req = b.visits_required;
    return {
      customers,
      newCustomers7: one('SELECT COUNT(*) n FROM customers WHERE business_id = ? AND created_at >= ?', ago(7)).n,
      newCustomers30: one('SELECT COUNT(*) n FROM customers WHERE business_id = ? AND created_at >= ?', ago(30)).n,
      visits7, visits30,
      activeCustomers30: one("SELECT COUNT(DISTINCT customer_id) n FROM events WHERE business_id = ? AND kind = 'visit' AND created_at >= ?", ago(30)).n,
      returningRate: withVisit ? Math.round((returning / withVisit) * 100) : 0,
      rewardsRedeemed: one('SELECT COALESCE(SUM(rewards_redeemed),0) n FROM customers WHERE business_id = ?').n,
      rewardsRedeemed30: one("SELECT COUNT(*) n FROM events WHERE business_id = ? AND kind = 'redeem' AND created_at >= ?", ago(30)).n,
      rewardsWaiting: one('SELECT COUNT(*) n FROM customers WHERE business_id = ? AND visits >= ?', req).n,
      nearReward: one('SELECT COUNT(*) n FROM customers WHERE business_id = ? AND visits >= ? AND visits < ?', req - 2, req).n,
      atRisk: one('SELECT COUNT(*) n FROM customers WHERE business_id = ? AND last_visit_at IS NOT NULL AND last_visit_at <= ?', ago(35)).n,
      noticesSent30: one('SELECT COALESCE(SUM(sent),0) n FROM notices WHERE business_id = ? AND created_at >= ?', ago(30)).n,
      referralsRewarded: one("SELECT COUNT(*) n FROM events WHERE business_id = ? AND kind = 'referral_reward'").n,
      birthdayGifts30: one("SELECT COUNT(*) n FROM events WHERE business_id = ? AND kind = 'birthday' AND created_at >= ?", ago(30)).n,
      weekly, weekEnds, byWeekday, timezone: cfg.timezone,
      top: db.prepare(`SELECT c.name, COUNT(*) visits FROM events e JOIN customers c ON c.id = e.customer_id
        WHERE e.business_id = ? AND e.kind = 'visit' GROUP BY c.id ORDER BY visits DESC, c.id LIMIT 5`).all(b.id),
    };
  }

  // ---------- automatismos (se ejecutan cada hora; solo de 9:00 a 20:00 hora del negocio) ----------
  function runAutomations({ force = false } = {}) {
    const summary = [];
    for (const b of db.prepare('SELECT * FROM businesses').all()) {
      const cfg = getSettings(b);
      const t = localParts(now(), cfg.timezone);
      if (!force && (t.hour < 9 || t.hour >= 20)) continue;
      const nowMs = now().getTime();
      const u = unitsOf(b);
      const r = { slug: b.slug, inactive: 0, rewardWaiting: 0, birthday: 0 };
      const alreadySent = (customerId, audience, sinceIso) => !!db.prepare(`SELECT 1 FROM notice_deliveries d JOIN notices n ON n.id = d.notice_id
        WHERE d.customer_id = ? AND n.audience = ? AND d.created_at >= ?`).get(customerId, audience, sinceIso);

      const ai = cfg.auto.inactive;
      if (ai.enabled) {
        const cutoff = new Date(nowMs - ai.weeks * 7 * DAY).toISOString();
        const rows = db.prepare(`SELECT * FROM customers WHERE business_id = ? AND last_visit_at IS NOT NULL
          AND last_visit_at <= ? AND visits < ?`).all(b.id, cutoff, b.visits_required)
          .filter((c) => !alreadySent(c.id, 'auto_inactive', cutoff));
        r.inactive = deliver(b, rows, ai.message || `¡Te extrañamos en ${b.name}! Tu tarjeta te espera.`, 'auto_inactive', 'sistema', { capped: true }).sent;
      }
      const aw = cfg.auto.rewardWaiting;
      if (aw.enabled) {
        const cutoff = new Date(nowMs - aw.days * DAY).toISOString();
        const since = new Date(nowMs - 30 * DAY).toISOString();
        const rows = db.prepare(`SELECT * FROM customers WHERE business_id = ? AND visits >= ?
          AND (last_visit_at IS NULL OR last_visit_at <= ?)`).all(b.id, b.visits_required, cutoff)
          .filter((c) => !alreadySent(c.id, 'auto_reward', since));
        r.rewardWaiting = deliver(b, rows, aw.message || `Tu ${b.reward.toLowerCase()} te espera en ${b.name}. ¡Pasa a canjearlo!`, 'auto_reward', 'sistema', { capped: true }).sent;
      }
      if (cfg.birthday.enabled) {
        const md = (m, d) => `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const days = [md(t.month, t.day)];
        const leap = (t.year % 4 === 0 && t.year % 100 !== 0) || t.year % 400 === 0;
        if (t.month === 2 && t.day === 28 && !leap) days.push('02-29');
        const rows = db.prepare(`SELECT * FROM customers WHERE business_id = ? AND birthday IN (${days.map(() => '?').join(',')})`)
          .all(b.id, ...days)
          .filter((c) => !db.prepare("SELECT 1 FROM events WHERE customer_id = ? AND kind = 'birthday' AND detail LIKE ?").get(c.id, `%"year":${t.year}%`));
        const bonus = cfg.birthday.bonusVisits;
        const done = [];
        for (const c of rows) {
          const nv = Math.min(b.visits_required, c.visits + bonus);
          if (nv !== c.visits) db.prepare('UPDATE customers SET visits = ? WHERE id = ?').run(nv, c.id);
          logEvent(b, c.id, 'birthday', { year: t.year, bonus: nv - c.visits }, 'sistema');
          const fresh = loadCustomer(b, c.id);
          hook('customerChanged', { business: b, customer: publicCustomer(b, fresh), reason: 'edit' });
          done.push(fresh);
        }
        const msg = cfg.birthday.message || `¡Feliz cumpleaños de parte de ${b.name}!` + (bonus ? ` Te regalamos ${bonus} ${bonus === 1 ? u.one : u.many}.` : '');
        if (done.length) deliver(b, done, msg, 'auto_birthday', 'sistema');
        r.birthday = done.length;
      }
      summary.push(r);
    }
    return summary;
  }

  // ---------- panel Firmely: gestión de negocios ----------
  const publicBusiness = (b) => ({
    slug: b.slug, name: b.name, reward: b.reward, visitsRequired: b.visits_required,
    minHoursBetweenVisits: b.min_hours_between_visits, maxNoticesPerMonth: b.max_notices_per_month,
    brand: brandOf(b), createdAt: b.created_at, ...stats(b),
  });
  const listBusinesses = () => db.prepare('SELECT * FROM businesses ORDER BY created_at DESC, id DESC').all().map(publicBusiness);

  function updateBusiness(slug, patch = {}) {
    const b = getBusiness(slug);
    const int = (v, lo, hi, msg) => {
      if (!Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, 'bad_value', msg);
      return v;
    };
    const next = { name: b.name, reward: b.reward, visits: b.visits_required, minHours: b.min_hours_between_visits, maxNotices: b.max_notices_per_month };
    if (patch.name !== undefined) {
      next.name = String(patch.name).trim();
      if (next.name.length < 2 || next.name.length > 40) throw new HttpError(400, 'bad_name', 'El nombre debe tener entre 2 y 40 caracteres.');
    }
    if (patch.reward !== undefined) {
      next.reward = String(patch.reward).trim();
      if (next.reward.length < 2 || next.reward.length > 60) throw new HttpError(400, 'bad_reward', 'El premio debe tener entre 2 y 60 caracteres.');
    }
    if (patch.visitsRequired !== undefined) next.visits = int(patch.visitsRequired, 2, 24, 'Las visitas deben estar entre 2 y 24.');
    if (patch.minHoursBetweenVisits !== undefined) next.minHours = int(patch.minHoursBetweenVisits, 0, 720, 'Horas entre visitas: 0 a 720.');
    if (patch.maxNoticesPerMonth !== undefined) next.maxNotices = int(patch.maxNoticesPerMonth, 0, 20, 'Avisos por mes: 0 a 20.');
    const brand = { ...brandOf(b) };
    for (const [k, v] of Object.entries(patch.brand || {})) {
      if (v === null || v === '') delete brand[k]; else brand[k] = v;
    }
    const brandJson = JSON.stringify(normalizeBrand(brand));
    const cosmetic = brandJson !== b.brand_json || next.reward !== b.reward || next.visits !== b.visits_required || next.name !== b.name;
    db.prepare(`UPDATE businesses SET name = ?, reward = ?, visits_required = ?, min_hours_between_visits = ?,
      max_notices_per_month = ?, brand_json = ? WHERE id = ?`)
      .run(next.name, next.reward, next.visits, next.minHours, next.maxNotices, brandJson, b.id);
    if (next.visits < b.visits_required) db.prepare('UPDATE customers SET visits = MIN(visits, ?) WHERE business_id = ?').run(next.visits, b.id);
    const fresh = getBusiness(slug);
    if (cosmetic) refreshPasses(fresh); // los pases ya instalados se refrescan con el nuevo diseño
    return publicBusiness(fresh);
  }

  function regenerateKeys(slug, which) {
    const b = getBusiness(slug);
    if (!['staff', 'admin', 'both'].includes(which)) throw new HttpError(400, 'bad_which', 'Indica staff, admin o both.');
    const keys = {};
    for (const role of ['staff', 'admin']) {
      if (which !== role && which !== 'both') continue;
      keys[role] = crypto.randomBytes(18).toString('base64url');
      db.prepare(`UPDATE businesses SET ${role}_key_hash = ? WHERE id = ?`).run(sha256(keys[role]), b.id);
    }
    return { keys };
  }

  function deleteBusiness(slug, actor) {
    const b = getBusiness(slug);
    const ids = db.prepare('SELECT id FROM customers WHERE business_id = ?').all(b.id);
    for (const { id } of ids) deleteCustomer(b, id, actor); // reutiliza los hooks (Google marca el pase como inactivo)
    db.transaction(() => {
      for (const t of ['notices', 'events']) db.prepare(`DELETE FROM ${t} WHERE business_id = ?`).run(b.id);
      db.prepare('DELETE FROM businesses WHERE id = ?').run(b.id);
    })();
    return { deleted: true, customers: ids.length };
  }

  return {
    listBusinesses, updateBusiness, regenerateKeys, deleteBusiness,
    getSettings, updateSettings, metrics, runAutomations, extraInfo, proximity, refCodeFor,
    createBusiness, getBusiness, roleFor, codeFor, brandOf, customerFromCode, publicCustomer,
    register, listCustomers, getCustomer, scan, redeem,
    updateCustomer, resetVisits, deleteCustomer, stats, sendNotice, withSampleCustomer,
  };
}

module.exports = { createService, HttpError, normalizePhone };
