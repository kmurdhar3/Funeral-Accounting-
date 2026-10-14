// Fills an EMPTY database with demo data so you can try the portal.
// Admin login: admin / admin123 · Members: <firstname lowercase> / member123
const bcrypt = require('bcryptjs');
const { db, setSetting } = require('../src/db');
const { currentMonth, addMonths } = require('../src/ledger');

if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) {
  console.error('Database already has users; demo seed only runs on an empty database.');
  process.exit(1);
}

const cur = currentMonth();
const year = cur.slice(0, 4);
setSetting('org_name', 'Demo Funeral Society');
setSetting('opening_bank_balance', 2500000);

db.prepare('INSERT INTO periods (name, start_month, end_month, monthly_fee) VALUES (?, ?, ?, ?)')
  .run(`${year} contributions`, `${year}-01`, `${year}-12`, 10000);

const adminHash = bcrypt.hashSync('admin123', 10);
const memberHash = bcrypt.hashSync('member123', 10);
db.prepare(`INSERT INTO users (name, username, password_hash, role, join_month, contributes) VALUES ('Admin', 'admin', ?, 'admin', ?, 0)`)
  .run(adminHash, `${year}-01`);

// [name, opening owing (cents), months paid so far (x fee), extra lump sum]
const people = [
  ['Thabo', 0, 'all', 50000],     // fully paid + R500 lump sum -> green, paid ahead
  ['Anita', 0, 'all', 10000],      // up to date incl. top-up -> green
  ['Sipho', 0, -1, 0],             // missed current month -> red
  ['Priya', 20000, -2, 0],         // owes 2 months + brought forward -> red/black
  ['Lerato', 0, -4, 0],            // 4 months behind -> black
  ['Ravi', 30000, -1, 0],
  ['Naledi', 0, 'all', 20000],
  ['Kevin', 0, -3, 0],             // 3 months behind -> black
];
const insUser = db.prepare(`INSERT INTO users (name, username, password_hash, role, join_month, opening_owing) VALUES (?, ?, ?, 'member', ?, ?)`);
const insPay = db.prepare(`INSERT INTO payments (user_id, amount, paid_on, method, recorded_by) VALUES (?, ?, ?, 'Cash', 1)`);
const monthsSoFar = Number(cur.slice(5));
for (const [name, owing, paid, lump] of people) {
  const id = Number(insUser.run(name, name.toLowerCase(), memberHash, `${year}-01`, owing).lastInsertRowid);
  const n = paid === 'all' ? monthsSoFar : Math.max(0, monthsSoFar + paid);
  for (let i = 0; i < n; i++) insPay.run(id, 10000, `${addMonths(`${year}-01`, i)}-05`);
  if (lump) insPay.run(id, lump, `${cur}-02`);
}
db.prepare('INSERT INTO levies (name, month, amount) VALUES (?, ?, ?)').run('Top-up: funeral support', addMonths(cur, -2), 10000);
db.prepare('INSERT INTO expenses (spent_on, description, amount) VALUES (?, ?, ?)').run(`${addMonths(cur, -2)}-15`, 'Funeral payout', 1000000);

console.log('Demo data created. Log in as admin / admin123 (members: thabo / member123, etc).');
