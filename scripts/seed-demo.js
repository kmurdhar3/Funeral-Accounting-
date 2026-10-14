// Fills an EMPTY database with demo data so you can try the portal.
// Admin login: admin / admin123 · Members: <firstname lowercase> / member123
const bcrypt = require('bcryptjs');
const { db, ready, setSetting } = require('../src/db');
const { currentMonth, addMonths } = require('../src/ledger');

(async () => {
  await ready;
  if ((await db.get('SELECT COUNT(*) AS c FROM users')).c > 0) {
    console.error('Database already has users; demo seed only runs on an empty database.');
    process.exit(1);
  }

  const cur = currentMonth();
  const year = cur.slice(0, 4);
  await setSetting('org_name', 'Demo Funeral Society');
  await setSetting('opening_bank_balance', 2500000);

  await db.run('INSERT INTO periods (name, start_month, end_month, monthly_fee) VALUES (?, ?, ?, ?)',
    `${year} contributions`, `${year}-01`, `${year}-12`, 10000);

  const memberHash = bcrypt.hashSync('member123', 10);
  await db.run(`INSERT INTO users (name, username, password_hash, role, join_month, contributes) VALUES ('Admin', 'admin', ?, 'admin', ?, 0)`,
    bcrypt.hashSync('admin123', 10), `${year}-01`);

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
  const monthsSoFar = Number(cur.slice(5));
  for (const [name, owing, paid, lump] of people) {
    const { lastInsertRowid: id } = await db.run(
      `INSERT INTO users (name, username, password_hash, role, join_month, opening_owing) VALUES (?, ?, ?, 'member', ?, ?)`,
      name, name.toLowerCase(), memberHash, `${year}-01`, owing);
    const n = paid === 'all' ? monthsSoFar : Math.max(0, monthsSoFar + paid);
    const pays = [];
    for (let i = 0; i < n; i++) pays.push([10000, `${addMonths(`${year}-01`, i)}-05`]);
    if (lump) pays.push([lump, `${cur}-02`]);
    await db.batch(pays.map(([amt, d]) => [`INSERT INTO payments (user_id, amount, paid_on, method, recorded_by) VALUES (?, ?, ?, 'Cash', 1)`, [id, amt, d]]));
  }
  await db.run('INSERT INTO levies (name, month, amount) VALUES (?, ?, ?)', 'Top-up: funeral support', addMonths(cur, -2), 10000);
  await db.run('INSERT INTO expenses (spent_on, description, amount) VALUES (?, ?, ?)', `${addMonths(cur, -2)}-15`, 'Funeral payout', 1000000);

  console.log('Demo data created. Log in as admin / admin123 (members: thabo / member123, etc).');
})();
