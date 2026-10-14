// One-off: converts the old SQLite database (data/funeral.db) into data/funeral.json.
// Refuses to overwrite an existing funeral.json.
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');
const { normalize } = require('../src/store');

const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const out = path.join(dir, 'funeral.json');
if (fs.existsSync(out)) {
  console.error(`${out} already exists. Nothing changed.`);
  process.exit(1);
}
const db = createClient({ url: 'file:' + path.resolve(dir, 'funeral.db').replace(/\\/g, '/') });
const rows = async sql => {
  const rs = await db.execute(sql);
  return rs.rows.map(r => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
};

(async () => {
  const settings = Object.fromEntries((await rows('SELECT key, value FROM settings')).map(r => [r.key, r.value]));
  for (const k of ['black_months', 'suspend_balance', 'opening_bank_balance']) settings[k] = Number(settings[k]);
  const doc = normalize({
    settings,
    users: await rows('SELECT * FROM users ORDER BY id'),
    periods: await rows('SELECT * FROM periods ORDER BY id'),
    levies: await rows('SELECT * FROM levies ORDER BY id'),
    payments: await rows('SELECT * FROM payments ORDER BY id'),
    expenses: await rows('SELECT * FROM expenses ORDER BY id'),
  });
  fs.writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`Wrote ${out}: ${doc.users.length} users, ${doc.payments.length} payments, ${doc.periods.length} periods, ${doc.levies.length} levies, ${doc.expenses.length} expenses.`);
})();
