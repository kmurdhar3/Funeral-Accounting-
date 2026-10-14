// Contribution calculations. Payments are allocated oldest-charge-first (FIFO):
// brought-forward owing, then each month's fee and levies in date order.
// Whatever is left over is credit that covers future months ("paid ahead").

const { db, getSettings } = require('./db');

function currentMonth(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return currentMonth(d);
}

function monthRange(from, to) {
  const out = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(ym, long = false) {
  const [y, m] = ym.split('-').map(Number);
  const name = long
    ? new Date(y, m - 1, 1).toLocaleString('en', { month: 'long' })
    : MONTHS[m - 1];
  return `${name} ${y}`;
}

async function loadContext(now = new Date()) {
  const [settings, periods, levies] = await Promise.all([
    getSettings(),
    db.all('SELECT * FROM periods ORDER BY start_month'),
    db.all('SELECT * FROM levies ORDER BY month, id'),
  ]);
  return { settings, periods, levies, current: currentMonth(now) };
}

// Monthly fee for a member in a given month, or null when nothing is due that month.
function feeFor(member, month, periods) {
  if (month < member.join_month) return null;
  const p = periods.find(p => p.start_month <= month && month <= p.end_month);
  if (!p) return null;
  return member.fee_override ?? p.monthly_fee;
}

function computeMember(member, payments, ctx) {
  const { current, settings } = ctx;
  // Login-only accounts are never charged
  const periods = member.contributes ? ctx.periods : [];
  const levies = member.contributes ? ctx.levies : [];

  const charges = [];
  let openingCredit = 0;
  if (!member.contributes) {
    // nothing brought forward
  } else if (member.opening_owing > 0) {
    charges.push({ kind: 'opening', month: '0000-00', label: 'Brought forward', amount: member.opening_owing });
  } else if (member.opening_owing < 0) {
    openingCredit = -member.opening_owing;
  }

  const allMonths = periods.length
    ? monthRange(periods[0].start_month, periods.reduce((a, p) => (p.end_month > a ? p.end_month : a), periods[0].end_month))
    : [];
  const futureFees = [];
  for (const m of allMonths) {
    const fee = feeFor(member, m, periods);
    if (fee == null || fee === 0) continue;
    if (m <= current) charges.push({ kind: 'fee', month: m, label: `Contribution ${monthLabel(m)}`, amount: fee });
    else futureFees.push({ kind: 'fee', month: m, amount: fee });
  }
  for (const l of levies) {
    if (l.month <= current && l.month >= member.join_month) {
      charges.push({ kind: 'levy', month: l.month, label: l.name, amount: l.amount, levyId: l.id });
    }
  }
  charges.sort((a, b) => a.month.localeCompare(b.month) || (a.kind === 'levy') - (b.kind === 'levy'));

  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  let pool = totalPaid + openingCredit;
  for (const c of charges) {
    c.paid = Math.max(0, Math.min(pool, c.amount));
    pool -= c.paid;
    c.outstanding = c.amount - c.paid;
  }
  const credit = pool; // left over after everything due so far

  // Month grid: state of each month's fee
  const months = {};
  for (const c of charges) {
    if (c.kind !== 'fee') continue;
    months[c.month] = {
      due: c.amount,
      paid: c.paid,
      state: c.outstanding === 0 ? 'paid' : c.paid > 0 ? 'partial' : 'unpaid',
    };
  }
  let ahead = credit;
  let monthsAhead = 0;
  for (const f of futureFees) {
    const paid = Math.max(0, Math.min(ahead, f.amount));
    ahead -= paid;
    if (paid === f.amount) monthsAhead++;
    months[f.month] = {
      due: f.amount,
      paid,
      state: paid === f.amount ? 'prepaid' : paid > 0 ? 'partial-ahead' : 'upcoming',
    };
  }

  const totalDue = charges.reduce((s, c) => s + c.amount, 0);
  const balance = totalPaid + openingCredit - totalDue; // negative = owing
  const monthsBehind = charges.filter(c => c.kind === 'fee' && c.outstanding > 0).length;
  const unpaidLevies = charges.filter(c => c.kind === 'levy' && c.outstanding > 0);

  let status;
  if (!member.contributes) {
    status = { code: 'none', label: 'Not a paying member' };
  } else if (balance <= settings.suspend_balance || monthsBehind >= settings.black_months) {
    status = { code: 'black', label: 'Seriously in arrears' };
  } else if (balance < 0) {
    status = { code: 'red', label: 'Owing' };
  } else {
    status = { code: 'green', label: monthsAhead > 0 ? `Paid ahead (${monthsAhead} mo)` : 'Up to date' };
  }

  return {
    member, charges, months, totalPaid, totalDue, balance, credit,
    monthsBehind, monthsAhead, unpaidLevies, status,
    lastPayment: payments.length ? payments.reduce((a, p) => (p.paid_on > a.paid_on ? p : a)) : null,
  };
}

// Default: active paying members (what the dashboard shows). `all` = every account.
async function computeAll({ all = false } = {}) {
  const [ctx, members, payments] = await Promise.all([
    loadContext(),
    db.all(`SELECT * FROM users ${all ? '' : 'WHERE active = 1 AND contributes = 1'} ORDER BY name COLLATE NOCASE`),
    db.all('SELECT * FROM payments ORDER BY paid_on'),
  ]);
  const byUser = new Map();
  for (const p of payments) {
    if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
    byUser.get(p.user_id).push(p);
  }
  return { ctx, rows: members.map(m => computeMember(m, byUser.get(m.id) || [], ctx)) };
}

async function computeOne(userId) {
  const [ctx, member, payments] = await Promise.all([
    loadContext(),
    db.get('SELECT * FROM users WHERE id = ?', userId),
    db.all('SELECT * FROM payments WHERE user_id = ? ORDER BY paid_on, id', userId),
  ]);
  if (!member) return null;
  return { ctx, row: computeMember(member, payments, ctx), payments };
}

async function fundTotals(ctx) {
  const paid = (await db.get('SELECT COALESCE(SUM(amount),0) AS t FROM payments')).t;
  const spent = (await db.get('SELECT COALESCE(SUM(amount),0) AS t FROM expenses')).t;
  return { paid, spent, bank: ctx.settings.opening_bank_balance + paid - spent };
}

module.exports = {
  currentMonth, addMonths, monthRange, monthLabel,
  loadContext, computeAll, computeOne, fundTotals,
};
