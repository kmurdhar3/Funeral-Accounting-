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
const { db, ready } = require('../src/db');

const SHEET_DATE = '2026-09-07';
const BANK_BALANCE = 27048579; // "BANK BALANCE 07/09/2026" R270 485.79, in cents
const importDir = path.join(__dirname, '..', 'data', 'import');
const rows = JSON.parse(fs.readFileSync(path.join(importDir, 'tshikovha-2026-09-07.json'), 'utf8'));

const titleCase = s => s.toLowerCase().replace(/(^|[\s/])\S/g, c => c.toUpperCase());
const usernameFor = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '.');
const newPassword = () => crypto.randomBytes(6).toString('base64url').slice(0, 8);

(async () => {
  await ready;
  const existing = new Set((await db.all('SELECT username FROM users')).map(u => u.username.toLowerCase()));
  const taken = rows.map(r => usernameFor(r.name)).filter(u => existing.has(u));
  if (taken.length) {
    console.error(`Already imported (usernames exist: ${taken.join(', ')}). Nothing changed.`);
    process.exit(1);
  }
  const hadPayments = (await db.get('SELECT COUNT(*) AS c FROM payments')).c > 0;
  const admin = await db.get(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`);

  const tx = await db.client.transaction('write');
  const exec = (sql, ...args) => tx.execute({ sql, args });
  try {
    if (!(await exec(`SELECT 1 FROM periods WHERE start_month <= '2026-12' AND end_month >= '2026-01'`)).rows.length) {
      await exec('INSERT INTO periods (name, start_month, end_month, monthly_fee) VALUES (?, ?, ?, ?)', '2026 Contribution', '2026-01', '2026-12', 10000);
    }
    if (!(await exec(`SELECT 1 FROM levies WHERE name = 'Top up Kelvin'`)).rows.length) {
      await exec('INSERT INTO levies (name, month, amount) VALUES (?, ?, ?)', 'Top up Kelvin', '2026-05', 10000);
    }

    const logins = [['name', 'username', 'password']];
    let total = 0;
    for (const r of rows) {
      const name = titleCase(r.name);
      const username = usernameFor(r.name);
      const password = newPassword();
      const owing = r.owing2025 ? -r.owing2025 : 0; // sheet shows owing as negative
      const ins = await exec(`INSERT INTO users (name, username, password_hash, role, join_month, opening_owing, contributes, notes)
                              VALUES (?, ?, ?, 'member', '2026-01', ?, 1, ?)`,
        name, username, bcrypt.hashSync(password, 10), owing, 'Imported from TSHIKOVHA financials 07/09/2026');
      if (r.total > 0) {
        await exec(`INSERT INTO payments (user_id, amount, paid_on, method, note, recorded_by) VALUES (?, ?, ?, 'Imported', ?, ?)`,
          Number(ins.lastInsertRowid), r.total, SHEET_DATE, '2026 contributions to date per TSHIKOVHA financials 07/09/2026', admin?.id ?? null);
      }
      total += r.total;
      logins.push([name, username, password]);
    }
    if (!hadPayments) {
      await exec(`UPDATE settings SET value = ? WHERE key = 'opening_bank_balance'`, String(BANK_BALANCE - total));
    }
    await tx.commit();

    const csv = path.join(importDir, 'member-logins.csv');
    fs.writeFileSync(csv, logins.map(l => l.join(',')).join('\n') + '\n');
    console.log(`Imported ${rows.length} members, R${(total / 100).toFixed(2)} in contributions.`);
    console.log(hadPayments
      ? 'Opening bank balance left unchanged (payments already existed).'
      : 'Opening bank balance set so the fund balance equals R270 485.79 as at 07/09/2026.');
    console.log(`Initial passwords: ${csv}`);
  } catch (e) {
    await tx.rollback();
    throw e;
  }
})();
