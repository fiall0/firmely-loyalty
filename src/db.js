const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  reward TEXT NOT NULL DEFAULT 'Corte gratis',
  visits_required INTEGER NOT NULL DEFAULT 10,
  min_hours_between_visits INTEGER NOT NULL DEFAULT 4,
  max_notices_per_month INTEGER NOT NULL DEFAULT 2,
  brand_json TEXT NOT NULL DEFAULT '{}',
  staff_key_hash TEXT NOT NULL,
  admin_key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  phone_norm TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  rewards_redeemed INTEGER NOT NULL DEFAULT 0,
  last_visit_at TEXT,
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (business_id, phone_norm)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  customer_id INTEGER REFERENCES customers(id),
  kind TEXT NOT NULL,
  detail TEXT,
  actor TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_customer ON events (customer_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events (business_id, kind, created_at);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  audience TEXT NOT NULL,
  message TEXT NOT NULL,
  sent INTEGER NOT NULL,
  skipped INTEGER NOT NULL,
  actor TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notice_deliveries (
  notice_id INTEGER NOT NULL REFERENCES notices(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_customer ON notice_deliveries (customer_id, created_at);

-- Etapa 3: Apple Wallet. pass_changes es el "reloj" de cambios de pases (seq creciente).
CREATE TABLE IF NOT EXISTS pass_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pass_changes_customer ON pass_changes (customer_id, seq);
CREATE TRIGGER IF NOT EXISTS trg_pass_customer_update
  AFTER UPDATE OF name, visits, rewards_redeemed ON customers
  BEGIN INSERT INTO pass_changes (customer_id) VALUES (NEW.id); END;
CREATE TRIGGER IF NOT EXISTS trg_pass_notice
  AFTER INSERT ON notice_deliveries
  BEGIN INSERT INTO pass_changes (customer_id) VALUES (NEW.customer_id); END;
CREATE TABLE IF NOT EXISTS apple_devices (
  device_id TEXT PRIMARY KEY,
  push_token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS apple_registrations (
  device_id TEXT NOT NULL REFERENCES apple_devices(device_id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  serial TEXT NOT NULL,
  PRIMARY KEY (device_id, serial)
);
CREATE INDEX IF NOT EXISTS idx_apple_reg_customer ON apple_registrations (customer_id);
`;

function open(file = ':memory:') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Migración para bases creadas antes de la etapa 2.
  const cols = db.prepare('PRAGMA table_info(businesses)').all().map((c) => c.name);
  if (!cols.includes('brand_json')) db.exec("ALTER TABLE businesses ADD COLUMN brand_json TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('settings_json')) db.exec("ALTER TABLE businesses ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
  const cc = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  if (!cc.includes('birthday')) db.exec('ALTER TABLE customers ADD COLUMN birthday TEXT');
  if (!cc.includes('referred_by')) db.exec('ALTER TABLE customers ADD COLUMN referred_by INTEGER');
  if (!cc.includes('referral_paid')) db.exec('ALTER TABLE customers ADD COLUMN referral_paid INTEGER NOT NULL DEFAULT 0');
  return db;
}

module.exports = { open };
