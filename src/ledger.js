// Contribution calculations.
// 1. A payment marked for specific months (payment.months) pays those months' fees first.
// 2. Everything else (unmarked payments and any leftover) is allocated oldest-charge-first:
//    brought-forward owing, then each month's fee and levies in date order.
// 3. Whatever is still left covers future months in order ("paid ahead").

// All functions here are pure: they take the JSON document (see store.js) and return numbers.

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

function loadContext(doc, now = new Date()) {
  return {
    settings: doc.settings,
    periods: [...doc.periods].sort((a, b) => a.start_month.localeCompare(b.start_month)),
    levies: [...doc.levies].sort((a, b) => a.month.localeCompare(b.month) || a.id - b.id),
    current: currentMonth(now),
  };
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
    charges.push({ kind: 'opening', month: '0000-00', label: 'Brought forward', amount: member.opening_owing, paid: 0 });
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
    const c = { kind: 'fee', month: m, label: `Contribution ${monthLabel(m)}`, amount: fee, paid: 0 };
    (m <= current ? charges : futureFees).push(c);
  }
  for (const l of levies) {
    if (l.month <= current && l.month >= member.join_month) {
      charges.push({ kind: 'levy', month: l.month, label: l.name, amount: l.amount, levyId: l.id, paid: 0 });
    }
  }
  charges.sort((a, b) => a.month.localeCompare(b.month) || (a.kind === 'levy') - (b.kind === 'levy'));
  const feeByMonth = new Map([...charges, ...futureFees].filter(c => c.kind === 'fee').map(c => [c.month, c]));
  const apply = (c, available) => {
    const take = Math.max(0, Math.min(available, c.amount - c.paid));
    c.paid += take;
    return take;
  };

  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  let pool = openingCredit;
  for (const p of payments) {
    let left = p.amount;
    for (const m of [...(p.months || [])].sort()) {
      const c = feeByMonth.get(m);
      if (c) left -= apply(c, left);
    }
    pool += left;
  }
  for (const c of charges) pool -= apply(c, pool);
  for (const f of futureFees) pool -= apply(f, pool);
  const credit = pool; // left over even after the last future month
  for (const c of charges) c.outstanding = c.amount - c.paid;

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
  let monthsAhead = 0;
  for (const f of futureFees) {
    if (f.paid === f.amount) monthsAhead++;
    months[f.month] = {
      due: f.amount,
      paid: f.paid,
      state: f.paid === f.amount ? 'prepaid' : f.paid > 0 ? 'partial-ahead' : 'upcoming',
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
  } else if (balance < 0 || monthsBehind > 0) {
    // a month can be unpaid even with credit, when money was put towards later months
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

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const byDate = (a, b) => a.paid_on.localeCompare(b.paid_on) || a.id - b.id;

// Default: active paying members (what the dashboard shows). `all` = every account.
function computeAll(doc, { all = false } = {}) {
  const ctx = loadContext(doc);
  const members = doc.users.filter(u => all || (u.active && u.contributes)).sort(byName);
  const byUser = new Map();
  for (const p of [...doc.payments].sort(byDate)) {
    if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
    byUser.get(p.user_id).push(p);
  }
  return { ctx, rows: members.map(m => computeMember(m, byUser.get(m.id) || [], ctx)) };
}

function computeOne(doc, userId) {
  const ctx = loadContext(doc);
  const member = doc.users.find(u => u.id === userId);
  if (!member) return null;
  const payments = doc.payments.filter(p => p.user_id === userId).sort(byDate);
  return { ctx, row: computeMember(member, payments, ctx), payments };
}

function fundTotals(doc) {
  const paid = doc.payments.reduce((s, p) => s + p.amount, 0);
  const spent = doc.expenses.reduce((s, e) => s + e.amount, 0);
  return { paid, spent, bank: doc.settings.opening_bank_balance + paid - spent };
}

module.exports = {
  currentMonth, addMonths, monthRange, monthLabel,
  loadContext, computeAll, computeOne, fundTotals,
};
