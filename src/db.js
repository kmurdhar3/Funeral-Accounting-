const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'funeral.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

// All money is stored as integer cents. Months are 'YYYY-MM' strings.
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  phone           TEXT,
  email           TEXT,
  join_month      TEXT NOT NULL,
  opening_owing   INTEGER NOT NULL DEFAULT 0,   -- owing brought forward (+) or credit (-)
  fee_override    INTEGER,                      -- per-member monthly fee; NULL = period fee
  active          INTEGER NOT NULL DEFAULT 1,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS periods (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  start_month TEXT NOT NULL,
  end_month   TEXT NOT NULL,
  monthly_fee INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS levies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  month       TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,
  paid_on     TEXT NOT NULL,
  method      TEXT,
  note        TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spent_on    TEXT NOT NULL,
  description TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migrations for databases created by earlier versions
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('contributes')) {
  // 0 = login-only account (e.g. an admin who is not a paying member)
  db.exec('ALTER TABLE users ADD COLUMN contributes INTEGER NOT NULL DEFAULT 1');
}

const DEFAULT_SETTINGS = {
  org_name: 'Funeral Society',
  currency: 'R',
  black_months: '3',          // months in arrears that turn a member black
  suspend_balance: '-50000',  // balance (cents) at or below which a member turns black
  opening_bank_balance: '0',  // cents
};

for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  .run('session_secret', crypto.randomBytes(32).toString('hex'));

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    org_name: s.org_name,
    currency: s.currency,
    black_months: parseInt(s.black_months, 10),
    suspend_balance: parseInt(s.suspend_balance, 10),
    opening_bank_balance: parseInt(s.opening_bank_balance, 10),
    session_secret: s.session_secret,
  };
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

module.exports = { db, getSettings, setSetting };
