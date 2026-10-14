// Fills an EMPTY data store with demo data so you can try the portal.
// Admin login: admin / admin123 · Members: <firstname lowercase> / member123
const bcrypt = require('bcryptjs');
const store = require('../src/store');
const { currentMonth, addMonths } = require('../src/ledger');

(async () => {
  const cur = currentMonth();
  const year = cur.slice(0, 4);
  const adminHash = bcrypt.hashSync('admin123', 10);
  const memberHash = bcrypt.hashSync('member123', 10);

  const result = await store.update(doc => {
    if (doc.users.length > 0) return { error: 'Data already has users; demo seed only runs on an empty store.' };
    doc.settings.org_name = 'Demo Funeral Society';
    doc.settings.opening_bank_balance = 2500000;
    store.insert(doc, 'periods', { name: `${year} contributions`, start_month: `${year}-01`, end_month: `${year}-12`, monthly_fee: 10000 });

    const base = { phone: null, email: null, join_month: `${year}-01`, fee_override: null, active: 1, notes: null };
    const admin = store.insert(doc, 'users', { ...base, name: 'Admin', username: 'admin', password_hash: adminHash, role: 'admin', opening_owing: 0, contributes: 0 });

    // [name, opening owing (cents), months paid so far (x fee), extra lump sum]
    const people = [
      ['Thabo', 0, 'all', 50000],     // fully paid + R500 lump sum -> green, paid ahead
      ['Anita', 0, 'all', 10000],      // up to date incl. top-up -> green
      ['Sipho', 0, -1, 0],             // missed current month -> red
      ['Priya', 20000, -2, 0],         // owes 2 months + brought forward -> black
      ['Lerato', 0, -4, 0],            // 4 months behind -> black
      ['Ravi', 30000, -1, 0],
      ['Naledi', 0, 'all', 20000],
      ['Kevin', 0, -3, 0],             // 3 months behind -> black
    ];
    const monthsSoFar = Number(cur.slice(5));
    for (const [name, owing, paid, lump] of people) {
      const u = store.insert(doc, 'users', { ...base, name, username: name.toLowerCase(), password_hash: memberHash, role: 'member', opening_owing: owing, contributes: 1 });
      const n = paid === 'all' ? monthsSoFar : Math.max(0, monthsSoFar + paid);
      const pay = (amount, paid_on) => store.insert(doc, 'payments', { user_id: u.id, amount, paid_on, method: 'Cash', note: null, recorded_by: admin.id });
      for (let i = 0; i < n; i++) pay(10000, `${addMonths(`${year}-01`, i)}-05`);
      if (lump) pay(lump, `${cur}-02`);
    }
    store.insert(doc, 'levies', { name: 'Top-up: funeral support', month: addMonths(cur, -2), amount: 10000 });
    store.insert(doc, 'expenses', { spent_on: `${addMonths(cur, -2)}-15`, description: 'Funeral payout', amount: 1000000 });
  });
  if (result?.error) { console.error(result.error); process.exit(1); }
  console.log('Demo data created. Log in as admin / admin123 (members: thabo / member123, etc).');
})();
