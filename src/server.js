const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { db, ready, getSettings, setSetting } = require('./db');
const ledger = require('./ledger');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Express 4 does not catch rejected promises; route them to the error handler.
const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The session key lives in the database, so the cookie middleware is built once it is loaded.
let sessionMiddleware;
app.use(a(async (req, res, next) => {
  await ready;
  if (!sessionMiddleware) {
    const { session_secret } = await getSettings();
    sessionMiddleware = cookieSession({
      name: 'fa_session',
      keys: [session_secret],
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      httpOnly: true,
    });
  }
  sessionMiddleware(req, res, next);
}));

// ---------- helpers ----------
const toCents = v => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
const isMonth = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(v || '');
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const userCount = async () => (await db.get('SELECT COUNT(*) AS c FROM users')).c;

function flash(req, type, msg) { req.session.flash = { type, msg }; }

app.use(a(async (req, res, next) => {
  const settings = await getSettings();
  const cur = settings.currency;
  res.locals.settings = settings;
  res.locals.money = cents => {
    const [whole, frac] = (Math.abs(cents) / 100).toFixed(2).split('.');
    const s = `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${frac}`;
    return `${cents < 0 ? '-' : ''}${cur}${s}`;
  };
  res.locals.cents2input = cents => (cents == null ? '' : (cents / 100).toFixed(2));
  res.locals.monthLabel = ledger.monthLabel;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  res.locals.path = req.path;
  res.locals.me = null;
  if (req.session.uid) {
    const me = await db.get('SELECT id, name, username, role, active FROM users WHERE id = ?', req.session.uid);
    if (me && me.active) res.locals.me = me;
    else req.session = null;
  }
  req.me = res.locals.me;
  next();
}));

const requireLogin = a(async (req, res, next) => {
  if (await userCount() === 0) return res.redirect('/setup');
  if (!req.me) return res.redirect('/login');
  next();
});
const requireAdmin = (req, res, next) => {
  if (!req.me) return res.redirect('/login');
  if (req.me.role !== 'admin') return res.status(403).render('error', { title: 'Not allowed', message: 'Only administrators can do that.' });
  next();
};

// ---------- setup & auth ----------
app.get('/setup', a(async (req, res) => {
  if (await userCount() > 0) return res.redirect('/login');
  res.render('setup', { title: 'First-time setup' });
}));

app.post('/setup', a(async (req, res) => {
  if (await userCount() > 0) return res.redirect('/login');
  const { org_name, currency, name, username, password } = req.body;
  if (!name || !username || !password || password.length < 6) {
    flash(req, 'error', 'Name, username and a password of at least 6 characters are required.');
    return res.redirect('/setup');
  }
  if (org_name) await setSetting('org_name', org_name.trim());
  if (currency) await setSetting('currency', currency.trim());
  const info = await db.run(
    `INSERT INTO users (name, username, password_hash, role, join_month, contributes) VALUES (?, ?, ?, 'admin', ?, ?)`,
    name.trim(), username.trim(), bcrypt.hashSync(password, 10), ledger.currentMonth(), req.body.contributes ? 1 : 0);
  req.session.uid = info.lastInsertRowid;
  flash(req, 'ok', 'Admin account created. Next: create a collection period under Periods & Fees.');
  res.redirect('/admin/periods');
}));

app.get('/login', a(async (req, res) => {
  if (await userCount() === 0) return res.redirect('/setup');
  if (req.me) return res.redirect('/');
  res.render('login', { title: 'Sign in' });
}));

app.post('/login', a(async (req, res) => {
  const { username, password } = req.body;
  const u = await db.get('SELECT * FROM users WHERE username = ?', (username || '').trim());
  if (!u || !u.active || !bcrypt.compareSync(password || '', u.password_hash)) {
    flash(req, 'error', 'Incorrect username or password.');
    return res.redirect('/login');
  }
  req.session.uid = u.id;
  res.redirect('/');
}));

app.post('/logout', (req, res) => { req.session = null; res.redirect('/login'); });

app.get('/account/password', requireLogin, (req, res) => res.render('password', { title: 'Change password' }));
app.post('/account/password', requireLogin, a(async (req, res) => {
  const { current, password, confirm } = req.body;
  const u = await db.get('SELECT * FROM users WHERE id = ?', req.me.id);
  if (!bcrypt.compareSync(current || '', u.password_hash)) flash(req, 'error', 'Current password is wrong.');
  else if (!password || password.length < 6) flash(req, 'error', 'New password must be at least 6 characters.');
  else if (password !== confirm) flash(req, 'error', 'Passwords do not match.');
  else {
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 10), u.id);
    flash(req, 'ok', 'Password changed.');
    return res.redirect('/');
  }
  res.redirect('/account/password');
}));

// ---------- dashboard ----------
app.get('/', requireLogin, a(async (req, res) => {
  const { ctx, rows } = await ledger.computeAll();
  const cur = ctx.current;
  const prev = ledger.addMonths(cur, -1);

  // Which period to show in the grid
  let period = ctx.periods.find(p => String(p.id) === req.query.period)
    || ctx.periods.find(p => p.start_month <= cur && cur <= p.end_month)
    || ctx.periods[ctx.periods.length - 1];
  const gridMonths = period ? ledger.monthRange(period.start_month, period.end_month) : [];

  const isPaid = s => s === 'paid' || s === 'prepaid';
  const curRows = rows.filter(r => r.months[cur]);
  const prevRows = rows.filter(r => r.months[prev]);
  const stats = {
    members: rows.length,
    paidCurrent: curRows.filter(r => isPaid(r.months[cur].state)).length,
    unpaidCurrent: curRows.filter(r => !isPaid(r.months[cur].state)).length,
    unpaidPrev: prevRows.filter(r => !isPaid(r.months[prev].state)).length,
    green: rows.filter(r => r.status.code === 'green').length,
    red: rows.filter(r => r.status.code === 'red').length,
    black: rows.filter(r => r.status.code === 'black').length,
    outstanding: rows.reduce((s, r) => s + Math.min(0, r.balance), 0),
    credit: rows.reduce((s, r) => s + Math.max(0, r.balance), 0),
    collectedCurrent: (await db.get(`SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE substr(paid_on,1,7) = ?`, cur)).t,
  };
  const fund = await ledger.fundTotals(ctx);

  const filter = ['green', 'red', 'black'].includes(req.query.status) ? req.query.status : null;
  const order = { black: 0, red: 1, green: 2 };
  const list = rows
    .filter(r => !filter || r.status.code === filter)
    .sort((x, y) => req.query.sort === 'status'
      ? order[x.status.code] - order[y.status.code] || x.balance - y.balance
      : x.member.name.localeCompare(y.member.name));

  res.render('dashboard', {
    title: 'Dashboard', rows: list, stats, fund, cur, prev, period,
    periods: ctx.periods, gridMonths, filter, sort: req.query.sort || 'name',
  });
}));

// ---------- members (visible to everyone logged in) ----------
app.get('/members/:id', requireLogin, a(async (req, res) => {
  const data = await ledger.computeOne(Number(req.params.id));
  if (!data || (!data.row.member.active && req.me.role !== 'admin')) {
    return res.status(404).render('error', { title: 'Not found', message: 'Member not found.' });
  }
  const { ctx, row, payments } = data;
  const allMonths = Object.keys(row.months).sort();
  res.render('member', { title: row.member.name, row, payments, ctx, allMonths });
}));

// ---------- admin: members ----------
function memberFromBody(b) {
  const fee = String(b.fee_override || '').trim();
  return {
    name: (b.name || '').trim(),
    username: (b.username || '').trim(),
    phone: (b.phone || '').trim() || null,
    email: (b.email || '').trim() || null,
    role: b.role === 'admin' ? 'admin' : 'member',
    join_month: b.join_month,
    opening_owing: toCents(b.opening_owing || 0),
    fee_override: fee === '' ? null : toCents(fee),
    active: b.active === '0' ? 0 : 1,
    contributes: b.contributes === '0' ? 0 : 1,
    notes: (b.notes || '').trim() || null,
  };
}
function validateMember(m) {
  if (!m.name || !m.username) return 'Name and username are required.';
  if (!isMonth(m.join_month)) return 'Join month is required.';
  if (Number.isNaN(m.opening_owing)) return 'Opening balance must be a number.';
  if (m.fee_override !== null && (Number.isNaN(m.fee_override) || m.fee_override < 0)) return 'Custom fee must be a positive number.';
  return null;
}

app.get('/admin/members', requireAdmin, a(async (req, res) => {
  const { rows } = await ledger.computeAll({ all: true });
  res.render('admin-members', { title: 'Manage members', rows });
}));

app.get('/admin/members/new', requireAdmin, (req, res) => {
  res.render('member-form', { title: 'Add member', m: { join_month: ledger.currentMonth(), role: 'member', active: 1, contributes: 1, opening_owing: 0 }, isNew: true });
});

app.post('/admin/members', requireAdmin, a(async (req, res) => {
  const m = memberFromBody(req.body);
  const err = validateMember(m) || (!req.body.password || req.body.password.length < 6 ? 'Password must be at least 6 characters.' : null);
  if (err) return res.render('member-form', { title: 'Add member', m: { ...m, opening_owing: m.opening_owing || 0 }, isNew: true, error: err });
  try {
    await db.run(`INSERT INTO users (name, username, password_hash, role, phone, email, join_month, opening_owing, fee_override, active, contributes, notes)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.name, m.username, bcrypt.hashSync(req.body.password, 10), m.role, m.phone, m.email, m.join_month, m.opening_owing, m.fee_override, m.active, m.contributes, m.notes);
  } catch (e) {
    return res.render('member-form', { title: 'Add member', m, isNew: true, error: 'That username is already taken.' });
  }
  flash(req, 'ok', `${m.name} added.`);
  res.redirect('/admin/members');
}));

app.get('/admin/members/:id/edit', requireAdmin, a(async (req, res) => {
  const m = await db.get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!m) return res.redirect('/admin/members');
  res.render('member-form', { title: `Edit ${m.name}`, m, isNew: false });
}));

app.post('/admin/members/:id', requireAdmin, a(async (req, res) => {
  const id = Number(req.params.id);
  const m = memberFromBody(req.body);
  m.id = id;
  let err = validateMember(m);
  if (!err && id === req.me.id && (m.role !== 'admin' || !m.active)) err = 'You cannot remove your own admin access or deactivate yourself.';
  if (!err && req.body.password && req.body.password.length < 6) err = 'New password must be at least 6 characters.';
  if (err) return res.render('member-form', { title: 'Edit member', m, isNew: false, error: err });
  try {
    await db.run(`UPDATE users SET name=?, username=?, role=?, phone=?, email=?, join_month=?, opening_owing=?, fee_override=?, active=?, contributes=?, notes=? WHERE id=?`,
      m.name, m.username, m.role, m.phone, m.email, m.join_month, m.opening_owing, m.fee_override, m.active, m.contributes, m.notes, id);
  } catch (e) {
    return res.render('member-form', { title: 'Edit member', m, isNew: false, error: 'That username is already taken.' });
  }
  if (req.body.password) {
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(req.body.password, 10), id);
  }
  flash(req, 'ok', `${m.name} updated.`);
  res.redirect(`/members/${id}`);
}));

// ---------- admin: payments ----------
app.get('/admin/payments', requireAdmin, a(async (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : null;
  const [members, payments] = await Promise.all([
    db.all('SELECT id, name FROM users WHERE active = 1 AND contributes = 1 ORDER BY name COLLATE NOCASE'),
    db.all(`
      SELECT p.*, u.name AS member_name, r.name AS recorder
      FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN users r ON r.id = p.recorded_by
      ${month ? 'WHERE substr(p.paid_on,1,7) = ?' : ''}
      ORDER BY p.paid_on DESC, p.id DESC LIMIT 300`, ...(month ? [month] : [])),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  res.render('admin-payments', { title: 'Payments', members, payments, today, month, preselect: Number(req.query.member) || null });
}));

app.post('/admin/payments', requireAdmin, a(async (req, res) => {
  const amount = toCents(req.body.amount);
  const userId = Number(req.body.user_id);
  if (!userId || !(amount > 0) || !isDate(req.body.paid_on)) {
    flash(req, 'error', 'Choose a member, a positive amount and a date.');
    return res.redirect('/admin/payments');
  }
  await db.run('INSERT INTO payments (user_id, amount, paid_on, method, note, recorded_by) VALUES (?, ?, ?, ?, ?, ?)',
    userId, amount, req.body.paid_on, (req.body.method || '').trim() || null, (req.body.note || '').trim() || null, req.me.id);
  const name = (await db.get('SELECT name FROM users WHERE id = ?', userId))?.name;
  flash(req, 'ok', `Recorded ${res.locals.money(amount)} from ${name}.`);
  res.redirect(req.body.back === 'member' ? `/members/${userId}` : '/admin/payments');
}));

app.post('/admin/payments/:id/delete', requireAdmin, a(async (req, res) => {
  await db.run('DELETE FROM payments WHERE id = ?', Number(req.params.id));
  flash(req, 'ok', 'Payment removed.');
  res.redirect(req.get('Referer') || '/admin/payments');
}));

// ---------- admin: periods ----------
app.get('/admin/periods', requireAdmin, a(async (req, res) => {
  const periods = await db.all('SELECT * FROM periods ORDER BY start_month');
  const edit = periods.find(p => String(p.id) === req.query.edit) || null;
  res.render('admin-periods', { title: 'Periods & fees', periods, edit });
}));

async function savePeriod(req, res, id) {
  const { name, start_month, end_month } = req.body;
  const fee = toCents(req.body.monthly_fee);
  let err = null;
  if (!name || !isMonth(start_month) || !isMonth(end_month)) err = 'Name, start month and end month are required.';
  else if (end_month < start_month) err = 'End month must be after start month.';
  else if (!(fee >= 0)) err = 'Monthly fee must be a number.';
  else {
    const clash = await db.get('SELECT name FROM periods WHERE id != ? AND NOT (end_month < ? OR start_month > ?)',
      id || 0, start_month, end_month);
    if (clash) err = `Overlaps with period "${clash.name}". Periods cannot overlap.`;
  }
  if (err) { flash(req, 'error', err); return res.redirect('/admin/periods' + (id ? `?edit=${id}` : '')); }
  if (id) await db.run('UPDATE periods SET name=?, start_month=?, end_month=?, monthly_fee=? WHERE id=?', name.trim(), start_month, end_month, fee, id);
  else await db.run('INSERT INTO periods (name, start_month, end_month, monthly_fee) VALUES (?, ?, ?, ?)', name.trim(), start_month, end_month, fee);
  flash(req, 'ok', 'Period saved.');
  res.redirect('/admin/periods');
}
app.post('/admin/periods', requireAdmin, a((req, res) => savePeriod(req, res, null)));
app.post('/admin/periods/:id', requireAdmin, a((req, res) => savePeriod(req, res, Number(req.params.id))));
app.post('/admin/periods/:id/delete', requireAdmin, a(async (req, res) => {
  await db.run('DELETE FROM periods WHERE id = ?', Number(req.params.id));
  flash(req, 'ok', 'Period deleted.');
  res.redirect('/admin/periods');
}));

// ---------- admin: levies (top-ups) ----------
app.get('/admin/levies', requireAdmin, a(async (req, res) => {
  const levies = await db.all('SELECT * FROM levies ORDER BY month DESC, id DESC');
  res.render('admin-levies', { title: 'Top-ups & levies', levies, current: ledger.currentMonth() });
}));
app.post('/admin/levies', requireAdmin, a(async (req, res) => {
  const amount = toCents(req.body.amount);
  if (!req.body.name || !isMonth(req.body.month) || !(amount > 0)) {
    flash(req, 'error', 'Name, month and a positive amount are required.');
  } else {
    await db.run('INSERT INTO levies (name, month, amount) VALUES (?, ?, ?)', req.body.name.trim(), req.body.month, amount);
    flash(req, 'ok', 'Top-up added. It is charged to every active member who had joined by that month.');
  }
  res.redirect('/admin/levies');
}));
app.post('/admin/levies/:id/delete', requireAdmin, a(async (req, res) => {
  await db.run('DELETE FROM levies WHERE id = ?', Number(req.params.id));
  flash(req, 'ok', 'Top-up deleted.');
  res.redirect('/admin/levies');
}));

// ---------- admin: expenses / withdrawals ----------
app.get('/admin/expenses', requireAdmin, a(async (req, res) => {
  const expenses = await db.all('SELECT * FROM expenses ORDER BY spent_on DESC, id DESC');
  const fund = await ledger.fundTotals({ settings: res.locals.settings });
  res.render('admin-expenses', { title: 'Withdrawals & expenses', expenses, fund, today: new Date().toISOString().slice(0, 10) });
}));
app.post('/admin/expenses', requireAdmin, a(async (req, res) => {
  const amount = toCents(req.body.amount);
  if (!req.body.description || !isDate(req.body.spent_on) || !(amount > 0)) {
    flash(req, 'error', 'Date, description and a positive amount are required.');
  } else {
    await db.run('INSERT INTO expenses (spent_on, description, amount) VALUES (?, ?, ?)', req.body.spent_on, req.body.description.trim(), amount);
    flash(req, 'ok', 'Withdrawal recorded.');
  }
  res.redirect('/admin/expenses');
}));
app.post('/admin/expenses/:id/delete', requireAdmin, a(async (req, res) => {
  await db.run('DELETE FROM expenses WHERE id = ?', Number(req.params.id));
  flash(req, 'ok', 'Withdrawal deleted.');
  res.redirect('/admin/expenses');
}));

// ---------- admin: settings ----------
app.get('/admin/settings', requireAdmin, (req, res) => res.render('admin-settings', { title: 'Settings' }));
app.post('/admin/settings', requireAdmin, a(async (req, res) => {
  const b = req.body;
  const months = parseInt(b.black_months, 10);
  const suspend = toCents(b.suspend_balance);
  const bank = toCents(b.opening_bank_balance || 0);
  if (!b.org_name || !b.currency || !(months >= 1) || Number.isNaN(suspend) || Number.isNaN(bank)) {
    flash(req, 'error', 'Please fill in every field with valid values.');
    return res.redirect('/admin/settings');
  }
  await setSetting('org_name', b.org_name.trim());
  await setSetting('currency', b.currency.trim());
  await setSetting('black_months', months);
  await setSetting('suspend_balance', -Math.abs(suspend));
  await setSetting('opening_bank_balance', bank);
  flash(req, 'ok', 'Settings saved.');
  res.redirect('/admin/settings');
}));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.locals.settings ||= { org_name: 'Funeral Society' };
  res.locals.me ||= null;
  res.locals.flash ||= null;
  res.locals.path ||= req.path;
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong.' });
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Funeral Accounting running on http://localhost:${PORT}`));
}
