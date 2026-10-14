// One-off import of the members in "TSHIKOVHA FINANCIALS AUGUST-SEPTEMBER 2026 Final Account settlement 260907.pdf".
// Source rows were extracted to data/import/tshikovha-2026-09-07.json.
//
// Each member's "TOTAL INDIVIDUAL CONTRIBUTION" becomes one opening payment dated 07/09/2026,
// "OWING 2025" becomes the brought-forward amount, and "TOP UP KELVIN" becomes a R100 levy
// (May 2026, matching its column position). Login passwords are generated and written to
// data/import/member-logins.csv for the admin to hand out.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('../src/store');

const SHEET_DATE = '2026-09-07';
const BANK_BALANCE = 27048579; // "BANK BALANCE 07/09/2026" R270 485.79, in cents
const importDir = path.join(__dirname, '..', 'data', 'import');
const rows = JSON.parse(fs.readFileSync(path.join(importDir, 'tshikovha-2026-09-07.json'), 'utf8'));

const titleCase = s => s.toLowerCase().replace(/(^|[\s/])\S/g, c => c.toUpperCase());
const usernameFor = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '.');
const newPassword = () => crypto.randomBytes(6).toString('base64url').slice(0, 8);

(async () => {
  // Hash outside update(): update() may re-run its function if another save happens meanwhile
  const prepared = rows.map(r => {
    const password = newPassword();
    return { r, name: titleCase(r.name), username: usernameFor(r.name), password, hash: bcrypt.hashSync(password, 10) };
  });

  const result = await store.update(doc => {
    const existing = new Set(doc.users.map(u => u.username.toLowerCase()));
    const taken = prepared.map(p => p.username).filter(u => existing.has(u));
    if (taken.length) return { error: `Already imported (usernames exist: ${taken.join(', ')}). Nothing changed.` };
    const hadPayments = doc.payments.length > 0;
    const admin = doc.users.find(u => u.role === 'admin');

    if (!doc.periods.some(p => p.start_month <= '2026-12' && p.end_month >= '2026-01')) {
      store.insert(doc, 'periods', { name: '2026 Contribution', start_month: '2026-01', end_month: '2026-12', monthly_fee: 10000 });
    }
    if (!doc.levies.some(l => l.name === 'Top up Kelvin')) {
      store.insert(doc, 'levies', { name: 'Top up Kelvin', month: '2026-05', amount: 10000 });
    }
    let total = 0;
    for (const { r, name, username, hash } of prepared) {
      const u = store.insert(doc, 'users', {
        name, username, password_hash: hash, role: 'member', phone: null, email: null, join_month: '2026-01',
        opening_owing: r.owing2025 ? -r.owing2025 : 0, // sheet shows owing as negative
        fee_override: null, active: 1, contributes: 1, notes: 'Imported from TSHIKOVHA financials 07/09/2026',
      });
      if (r.total > 0) {
        store.insert(doc, 'payments', {
          user_id: u.id, amount: r.total, paid_on: SHEET_DATE, method: 'Imported',
          note: '2026 contributions to date per TSHIKOVHA financials 07/09/2026', recorded_by: admin?.id ?? null,
        });
      }
      total += r.total;
    }
    if (!hadPayments) doc.settings.opening_bank_balance = BANK_BALANCE - total;
    return { total, hadPayments };
  });
  if (result.error) { console.error(result.error); process.exit(1); }

  const csv = path.join(importDir, 'member-logins.csv');
  const logins = [['name', 'username', 'password'], ...prepared.map(p => [p.name, p.username, p.password])];
  fs.writeFileSync(csv, logins.map(l => l.join(',')).join('\n') + '\n');
  console.log(`Imported ${rows.length} members, R${(result.total / 100).toFixed(2)} in contributions.`);
  console.log(result.hadPayments
    ? 'Opening bank balance left unchanged (payments already existed).'
    : 'Opening bank balance set so the fund balance equals R270 485.79 as at 07/09/2026.');
  console.log(`Initial passwords: ${csv}`);
})();
