// Copies the local database (data/funeral.db) into the Turso database named by
// TURSO_DATABASE_URL / TURSO_AUTH_TOKEN. Refuses if Turso already has users.
//   node --env-file=.env scripts/copy-to-turso.js
const path = require('path');
const { createClient } = require('@libsql/client');

if (!process.env.TURSO_DATABASE_URL) {
  console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (e.g. in .env) first.');
  process.exit(1);
}
const { db: dest, ready } = require('../src/db'); // creates the schema in Turso

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const src = createClient({ url: 'file:' + path.resolve(dataDir, 'funeral.db').replace(/\\/g, '/') });

const TABLES = ['settings', 'users', 'periods', 'levies', 'payments', 'expenses'];

(async () => {
  await ready;
  if ((await dest.get('SELECT COUNT(*) AS c FROM users')).c > 0) {
    console.error('Turso database already has users. Nothing copied.');
    process.exit(1);
  }
  const statements = [];
  for (const table of TABLES) {
    const rs = await src.execute(`SELECT * FROM ${table}`);
    const cols = rs.columns;
    for (const row of rs.rows) {
      statements.push([
        `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map((_, i) => row[i]),
      ]);
    }
    console.log(`${table}: ${rs.rows.length} rows`);
  }
  await dest.batch(statements);
  console.log('Copied to Turso.');
})().catch(e => { console.error(e); process.exit(1); });
