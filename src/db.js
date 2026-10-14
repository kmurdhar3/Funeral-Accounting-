const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// Turso in production (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN), local SQLite file otherwise.
// The web client talks HTTP only, so serverless builds need no native SQLite binary.
const remote = Boolean(process.env.TURSO_DATABASE_URL);
const { createClient } = remote ? require('@libsql/client/web') : require('@libsql/client');

function localUrl() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return 'file:' + path.resolve(dataDir, 'funeral.db').replace(/\\/g, '/');
}
const client = createClient({
  url: remote ? process.env.TURSO_DATABASE_URL : localUrl(),
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const toObjects = rs => rs.rows.map(r => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
const db = {
  client,
  async all(sql, ...args) { return toObjects(await client.execute({ sql, args })); },
  async get(sql, ...args) { return (await db.all(sql, ...args))[0]; },
  async run(sql, ...args) {
    const rs = await client.execute({ sql, args });
    return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid) };
  },
  // Runs [sql, args] pairs atomically
  async batch(statements) {
    return client.batch(statements.map(([sql, args = []]) => ({ sql, args })), 'write');
  },
};

// All money is stored as integer cents. Months are 'YYYY-MM' strings.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
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
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    contributes     INTEGER NOT NULL DEFAULT 1    -- 0 = login-only account, never charged
  )`,
  `CREATE TABLE IF NOT EXISTS periods (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    start_month TEXT NOT NULL,
    end_month   TEXT NOT NULL,
    monthly_fee INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS levies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    month       TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount      INTEGER NOT NULL,
    paid_on     TEXT NOT NULL,
    method      TEXT,
    note        TEXT,
    recorded_by INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    spent_on    TEXT NOT NULL,
    description TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

const DEFAULT_SETTINGS = {
  org_name: 'Funeral Society',
  currency: 'R',
  black_months: '3',          // months in arrears that turn a member black
  suspend_balance: '-50000',  // balance (cents) at or below which a member turns black
  opening_bank_balance: '0',  // cents
};

async function init() {
  await db.batch(SCHEMA.map(sql => [sql]));
  // Migration for databases created before the contributes column existed
  const cols = (await db.all('PRAGMA table_info(users)')).map(c => c.name);
  if (!cols.includes('contributes')) {
    await db.run('ALTER TABLE users ADD COLUMN contributes INTEGER NOT NULL DEFAULT 1');
  }
  const defaults = { ...DEFAULT_SETTINGS, session_secret: crypto.randomBytes(32).toString('hex') };
  await db.batch(Object.entries(defaults).map(([k, v]) => ['INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, v]]));
}
const ready = init();

async function getSettings() {
  const rows = await db.all('SELECT key, value FROM settings');
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

async function setSetting(key, value) {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

module.exports = { db, ready, getSettings, setSetting };
