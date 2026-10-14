const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Readable } = require('stream');
const multer = require('multer');
const store = require('./store');
const ledger = require('./ledger');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Express 4 does not catch rejected promises; route them to the error handler.
const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The session key is stored with the data, so the cookie middleware is built on first use.
let sessionMiddleware;
app.use(a(async (req, res, next) => {
  if (!sessionMiddleware) {
    sessionMiddleware = cookieSession({
      name: 'fa_session',
      keys: [await store.sessionSecret()],
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
const sameName = (x, y) => String(x).toLowerCase() === String(y).toLowerCase();
const findUser = (doc, id) => doc.users.find(u => u.id === Number(id));

function flash(req, type, msg) { req.session.flash = { type, msg }; }

// Months a member can pay for, with what is left to pay and whether a request is already waiting.
function monthOptions(doc, row) {
  const pending = new Set(doc.requests
    .filter(r => r.user_id === row.member.id && r.status === 'pending')
    .flatMap(r => r.months));
  return Object.keys(row.months).sort().map(m => ({
    m, ...row.months[m], remaining: row.months[m].due - row.months[m].paid, pending: pending.has(m),
  }));
}
// Selected months from a form (one value or many), limited to months the member is charged for
function monthsFromBody(body, options) {
  const allowed = new Set(options.map(o => o.m));
  const raw = [].concat(body.months || []);
  return [...new Set(raw.filter(m => isMonth(m) && allowed.has(m)))].sort();
}
const RECEIPT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf' };
// Vercel rejects request bodies over 4.5 MB; the browser shrinks photos before upload
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

// Load the data once per request
app.use(a(async (req, res, next) => {
  const doc = await store.read();
  req.doc = doc;
  const cur = doc.settings.currency;
  res.locals.settings = doc.settings;
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
    const me = findUser(doc, req.session.uid);
    if (me && me.active) res.locals.me = { id: me.id, name: me.name, username: me.username, role: me.role };
    else req.session = null;
  }
  req.me = res.locals.me;
  res.locals.pendingCount = req.me?.role === 'admin' ? doc.requests.filter(r => r.status === 'pending').length : 0;
  next();
}));

const requireLogin = (req, res, next) => {
  if (req.doc.users.length === 0) return res.redirect('/setup');
  if (!req.me) return res.redirect('/login');
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.me) return res.redirect('/login');
  if (req.me.role !== 'admin') return res.status(403).render('error', { title: 'Not allowed', message: 'Only administrators can do that.' });
  next();
};

// ---------- setup & auth ----------
app.get('/setup', (req, res) => {
  if (req.doc.users.length > 0) return res.redirect('/login');
  res.render('setup', { title: 'First-time setup' });
});

app.post('/setup', a(async (req, res) => {
  const { org_name, currency, name, username, password } = req.body;
  if (!name || !username || !password || password.length < 6) {
    flash(req, 'error', 'Name, username and a password of at least 6 characters are required.');
    return res.redirect('/setup');
  }
  const hash = bcrypt.hashSync(password, 10);
  const result = await store.update(doc => {
    if (doc.users.length > 0) return { error: 'exists' };
    if (org_name) doc.settings.org_name = org_name.trim();
    if (currency) doc.settings.currency = currency.trim();
    return store.insert(doc, 'users', {
      name: name.trim(), username: username.trim(), password_hash: hash, role: 'admin',
      phone: null, email: null, join_month: ledger.currentMonth(), opening_owing: 0, fee_override: null,
      active: 1, contributes: req.body.contributes ? 1 : 0, notes: null,
    });
  });
  if (result.error) return res.redirect('/login');
  req.session.uid = result.id;
  flash(req, 'ok', 'Admin account created. Next: create a collection period under Periods & Fees.');
  res.redirect('/admin/periods');
}));

app.get('/login', (req, res) => {
  if (req.doc.users.length === 0) return res.redirect('/setup');
  if (req.me) return res.redirect('/');
  res.render('login', { title: 'Sign in' });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const u = req.doc.users.find(x => sameName(x.username, (username || '').trim()));
  if (!u || !u.active || !bcrypt.compareSync(password || '', u.password_hash)) {
    flash(req, 'error', 'Incorrect username or password.');
    return res.redirect('/login');
  }
  req.session.uid = u.id;
  res.redirect('/');
});

app.post('/logout', (req, res) => { req.session = null; res.redirect('/login'); });

app.get('/account/password', requireLogin, (req, res) => res.render('password', { title: 'Change password' }));
app.post('/account/password', requireLogin, a(async (req, res) => {
  const { current, password, confirm } = req.body;
  const u = findUser(req.doc, req.me.id);
  if (!bcrypt.compareSync(current || '', u.password_hash)) flash(req, 'error', 'Current password is wrong.');
  else if (!password || password.length < 6) flash(req, 'error', 'New password must be at least 6 characters.');
  else if (password !== confirm) flash(req, 'error', 'Passwords do not match.');
  else {
    const hash = bcrypt.hashSync(password, 10);
    await store.update(doc => { findUser(doc, req.me.id).password_hash = hash; });
    flash(req, 'ok', 'Password changed.');
    return res.redirect('/');
  }
  res.redirect('/account/password');
}));

// ---------- dashboard ----------
app.get('/', requireLogin, (req, res) => {
  // Members only ever see their own account; the dashboard of everyone is admin-only
  if (req.me.role !== 'admin') return res.redirect(`/members/${req.me.id}`);
  const { ctx, rows } = ledger.computeAll(req.doc);
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
    collectedCurrent: req.doc.payments.filter(p => p.paid_on.slice(0, 7) === cur).reduce((s, p) => s + p.amount, 0),
  };
  const fund = ledger.fundTotals(req.doc);

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
});

// ---------- member pages: admins see anyone, members only themselves ----------
app.get('/members/:id', requireLogin, (req, res) => {
  if (req.me.role !== 'admin' && Number(req.params.id) !== req.me.id) {
    return res.status(403).render('error', { title: 'Not allowed', message: 'You can only view your own account.' });
  }
  const data = ledger.computeOne(req.doc, Number(req.params.id));
  if (!data || (!data.row.member.active && req.me.role !== 'admin')) {
    return res.status(404).render('error', { title: 'Not found', message: 'Member not found.' });
  }
  const { ctx, row, payments } = data;
  const allMonths = Object.keys(row.months).sort();
  const options = monthOptions(req.doc, row);
  const cur = options.find(o => o.m === ctx.current);
  const preselect = cur && cur.remaining > 0 && !cur.pending ? [cur.m] : [];
  const requests = req.doc.requests.filter(r => r.user_id === row.member.id).sort((x, y) => y.id - x.id);
  res.render('member', { title: row.member.name, row, payments, ctx, allMonths, options, preselect, requests });
});

// ---------- payment requests: members submit, admins review ----------
app.post('/requests', requireLogin, (req, res, next) => {
  upload.single('receipt')(req, res, err => {
    if (err) {
      flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'The receipt is too large (max 4 MB). Try a smaller photo or PDF.' : 'The receipt could not be uploaded.');
      return res.redirect(`/members/${req.me.id}`);
    }
    next();
  });
}, a(async (req, res) => {
  const back = `/members/${req.me.id}`;
  const data = ledger.computeOne(req.doc, req.me.id);
  if (!data?.row.member.contributes) { flash(req, 'error', 'Your account is not charged contributions.'); return res.redirect(back); }
  const options = monthOptions(req.doc, data.row);
  const months = monthsFromBody(req.body, options);
  const amount = toCents(req.body.amount);
  const file = req.file;
  let err = null;
  if (!months.length) err = 'Select at least one month.';
  else if (months.some(m => options.find(o => o.m === m).pending)) err = 'One of those months already has a request waiting for approval.';
  else if (!(amount > 0)) err = 'Enter the amount you paid.';
  else if (!isDate(req.body.paid_on)) err = 'Enter the date you paid.';
  else if (!file) err = 'Attach the receipt (photo or PDF).';
  else if (!RECEIPT_TYPES[file.mimetype]) err = 'The receipt must be a photo (JPG, PNG, WEBP, HEIC) or a PDF.';
  if (err) { flash(req, 'error', err); return res.redirect(back); }

  const key = `receipts/${crypto.randomBytes(12).toString('hex')}.${RECEIPT_TYPES[file.mimetype]}`;
  await store.putFile(key, file.buffer, file.mimetype);
  await store.update(doc => {
    store.insert(doc, 'requests', {
      user_id: req.me.id, months, amount, paid_on: req.body.paid_on,
      method: (req.body.method || '').trim() || null, note: (req.body.note || '').trim() || null,
      receipt: { key, type: file.mimetype, name: file.originalname.slice(0, 120), size: file.size },
      status: 'pending', reviewed_by: null, reviewed_at: null, admin_note: null, payment_id: null,
    });
  });
  flash(req, 'ok', 'Payment submitted. The admin will review your receipt and approve it.');
  res.redirect(back);
}));

// Receipt files: only the member who sent it and admins can open them
app.get('/requests/:id/receipt', requireLogin, a(async (req, res) => {
  const r = req.doc.requests.find(x => x.id === Number(req.params.id));
  if (!r || (req.me.role !== 'admin' && r.user_id !== req.me.id)) {
    return res.status(404).render('error', { title: 'Not found', message: 'Receipt not found.' });
  }
  const stream = await store.getFile(r.receipt.key);
  if (!stream) return res.status(404).render('error', { title: 'Not found', message: 'Receipt file is missing.' });
  res.set({
    'Content-Type': r.receipt.type,
    'Content-Disposition': `inline; filename="receipt-${r.id}.${r.receipt.key.split('.').pop()}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  Readable.fromWeb(stream).pipe(res);
}));

app.get('/admin/requests', requireAdmin, (req, res) => {
  const doc = req.doc;
  const show = ['pending', 'approved', 'rejected', 'all'].includes(req.query.show) ? req.query.show : 'pending';
  const names = new Map(doc.users.map(u => [u.id, u.name]));
  const list = doc.requests
    .filter(r => show === 'all' || r.status === show)
    .sort((x, y) => (show === 'pending' ? x.id - y.id : y.id - x.id))
    .map(r => {
      const row = ledger.computeOne(doc, r.user_id)?.row;
      return { ...r, member_name: names.get(r.user_id), reviewer: names.get(r.reviewed_by), row, options: row ? monthOptions(doc, row) : [] };
    });
  const counts = Object.fromEntries(['pending', 'approved', 'rejected'].map(k => [k, doc.requests.filter(r => r.status === k).length]));
  res.render('admin-requests', { title: 'Payment requests', list, show, counts });
});

app.post('/admin/requests/:id/approve', requireAdmin, a(async (req, res) => {
  const id = Number(req.params.id);
  const r0 = req.doc.requests.find(x => x.id === id);
  const data = r0 && ledger.computeOne(req.doc, r0.user_id);
  if (!data) { flash(req, 'error', 'Request not found.'); return res.redirect('/admin/requests'); }
  const months = monthsFromBody(req.body, monthOptions(req.doc, data.row));
  const amount = toCents(req.body.amount);
  const paid_on = isDate(req.body.paid_on) ? req.body.paid_on : r0.paid_on;
  if (!(amount > 0)) { flash(req, 'error', 'Amount must be positive.'); return res.redirect('/admin/requests'); }
  const result = await store.update(doc => {
    const r = doc.requests.find(x => x.id === id);
    if (!r || r.status !== 'pending') return { error: 'That request was already reviewed.' };
    const payment = store.insert(doc, 'payments', {
      user_id: r.user_id, amount, paid_on, months, method: r.method,
      note: r.note, recorded_by: req.me.id, request_id: r.id,
    });
    Object.assign(r, {
      status: 'approved', months, amount, paid_on, payment_id: payment.id,
      reviewed_by: req.me.id, reviewed_at: store.now(), admin_note: (req.body.admin_note || '').trim() || null,
    });
  });
  if (result?.error) flash(req, 'error', result.error);
  else flash(req, 'ok', `Approved ${res.locals.money(amount)} from ${data.row.member.name}.`);
  res.redirect('/admin/requests');
}));

app.post('/admin/requests/:id/reject', requireAdmin, a(async (req, res) => {
  const id = Number(req.params.id);
  const reason = (req.body.admin_note || '').trim();
  if (!reason) { flash(req, 'error', 'Give a reason so the member knows what to fix.'); return res.redirect('/admin/requests'); }
  const result = await store.update(doc => {
    const r = doc.requests.find(x => x.id === id);
    if (!r || r.status !== 'pending') return { error: 'That request was already reviewed.' };
    Object.assign(r, { status: 'rejected', reviewed_by: req.me.id, reviewed_at: store.now(), admin_note: reason });
  });
  flash(req, result?.error ? 'error' : 'ok', result?.error || 'Request rejected. The member can see your reason.');
  res.redirect('/admin/requests');
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
const TAKEN = 'That username is already taken.';

app.get('/admin/members', requireAdmin, (req, res) => {
  const { rows } = ledger.computeAll(req.doc, { all: true });
  res.render('admin-members', { title: 'Manage members', rows });
});

app.get('/admin/members/new', requireAdmin, (req, res) => {
  res.render('member-form', { title: 'Add member', m: { join_month: ledger.currentMonth(), role: 'member', active: 1, contributes: 1, opening_owing: 0 }, isNew: true });
});

app.post('/admin/members', requireAdmin, a(async (req, res) => {
  const m = memberFromBody(req.body);
  const err = validateMember(m) || (!req.body.password || req.body.password.length < 6 ? 'Password must be at least 6 characters.' : null);
  if (err) return res.render('member-form', { title: 'Add member', m: { ...m, opening_owing: m.opening_owing || 0 }, isNew: true, error: err });
  const hash = bcrypt.hashSync(req.body.password, 10);
  const result = await store.update(doc => {
    if (doc.users.some(u => sameName(u.username, m.username))) return { error: TAKEN };
    store.insert(doc, 'users', { ...m, password_hash: hash });
  });
  if (result?.error) return res.render('member-form', { title: 'Add member', m, isNew: true, error: result.error });
  flash(req, 'ok', `${m.name} added.`);
  res.redirect('/admin/members');
}));

app.get('/admin/members/:id/edit', requireAdmin, (req, res) => {
  const m = findUser(req.doc, req.params.id);
  if (!m) return res.redirect('/admin/members');
  res.render('member-form', { title: `Edit ${m.name}`, m, isNew: false });
});

app.post('/admin/members/:id', requireAdmin, a(async (req, res) => {
  const id = Number(req.params.id);
  const m = memberFromBody(req.body);
  m.id = id;
  let err = validateMember(m);
  if (!err && id === req.me.id && (m.role !== 'admin' || !m.active)) err = 'You cannot remove your own admin access or deactivate yourself.';
  if (!err && req.body.password && req.body.password.length < 6) err = 'New password must be at least 6 characters.';
  if (err) return res.render('member-form', { title: 'Edit member', m, isNew: false, error: err });
  const hash = req.body.password ? bcrypt.hashSync(req.body.password, 10) : null;
  const result = await store.update(doc => {
    const u = findUser(doc, id);
    if (!u) return { error: 'Member not found.' };
    if (doc.users.some(x => x.id !== id && sameName(x.username, m.username))) return { error: TAKEN };
    Object.assign(u, m);
    if (hash) u.password_hash = hash;
  });
  if (result?.error) return res.render('member-form', { title: 'Edit member', m, isNew: false, error: result.error });
  flash(req, 'ok', `${m.name} updated.`);
  res.redirect(`/members/${id}`);
}));

// ---------- admin: payments ----------
app.get('/admin/payments', requireAdmin, (req, res) => {
  const doc = req.doc;
  const month = isMonth(req.query.month) ? req.query.month : null;
  const names = new Map(doc.users.map(u => [u.id, u.name]));
  const members = doc.users.filter(u => u.active && u.contributes)
    .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
  const payments = doc.payments
    .filter(p => !month || p.paid_on.slice(0, 7) === month)
    .sort((x, y) => y.paid_on.localeCompare(x.paid_on) || y.id - x.id)
    .slice(0, 300)
    .map(p => ({ ...p, member_name: names.get(p.user_id), recorder: names.get(p.recorded_by) }));
  const today = new Date().toISOString().slice(0, 10);
  res.render('admin-payments', { title: 'Payments', members, payments, today, month, preselect: Number(req.query.member) || null });
});

app.post('/admin/payments', requireAdmin, a(async (req, res) => {
  const amount = toCents(req.body.amount);
  const userId = Number(req.body.user_id);
  const member = findUser(req.doc, userId);
  if (!member || !(amount > 0) || !isDate(req.body.paid_on)) {
    flash(req, 'error', 'Choose a member, a positive amount and a date.');
    return res.redirect('/admin/payments');
  }
  const months = monthsFromBody(req.body, monthOptions(req.doc, ledger.computeOne(req.doc, userId).row));
  await store.update(doc => {
    store.insert(doc, 'payments', {
      user_id: userId, amount, paid_on: req.body.paid_on, months,
      method: (req.body.method || '').trim() || null, note: (req.body.note || '').trim() || null, recorded_by: req.me.id,
    });
  });
  flash(req, 'ok', `Recorded ${res.locals.money(amount)} from ${member.name}.`);
  res.redirect(req.body.back === 'member' ? `/members/${userId}` : '/admin/payments');
}));

// Removes one row from a table by id
const deleteRow = (table, message, redirect) => a(async (req, res) => {
  const id = Number(req.params.id);
  await store.update(doc => { doc[table] = doc[table].filter(r => r.id !== id); });
  flash(req, 'ok', message);
  res.redirect(redirect(req));
});

// Deleting a payment that came from a request puts the request back in the queue
app.post('/admin/payments/:id/delete', requireAdmin, a(async (req, res) => {
  const id = Number(req.params.id);
  const reopened = await store.update(doc => {
    const p = doc.payments.find(x => x.id === id);
    doc.payments = doc.payments.filter(x => x.id !== id);
    const r = p?.request_id && doc.requests.find(x => x.id === p.request_id);
    if (r) Object.assign(r, { status: 'pending', payment_id: null, reviewed_by: null, reviewed_at: null });
    return Boolean(r);
  });
  flash(req, 'ok', reopened ? 'Payment removed. Its request is back in Requests for review.' : 'Payment removed.');
  res.redirect(req.get('Referer') || '/admin/payments');
}));

// ---------- admin: periods ----------
app.get('/admin/periods', requireAdmin, (req, res) => {
  const periods = ledger.loadContext(req.doc).periods;
  const edit = periods.find(p => String(p.id) === req.query.edit) || null;
  res.render('admin-periods', { title: 'Periods & fees', periods, edit });
});

async function savePeriod(req, res, id) {
  const { name, start_month, end_month } = req.body;
  const fee = toCents(req.body.monthly_fee);
  let err = null;
  if (!name || !isMonth(start_month) || !isMonth(end_month)) err = 'Name, start month and end month are required.';
  else if (end_month < start_month) err = 'End month must be after start month.';
  else if (!(fee >= 0)) err = 'Monthly fee must be a number.';
  if (!err) {
    const result = await store.update(doc => {
      const clash = doc.periods.find(p => p.id !== id && !(p.end_month < start_month || p.start_month > end_month));
      if (clash) return { error: `Overlaps with period "${clash.name}". Periods cannot overlap.` };
      const row = { name: name.trim(), start_month, end_month, monthly_fee: fee };
      if (id) Object.assign(doc.periods.find(p => p.id === id) || {}, row);
      else store.insert(doc, 'periods', row);
    });
    err = result?.error;
  }
  if (err) { flash(req, 'error', err); return res.redirect('/admin/periods' + (id ? `?edit=${id}` : '')); }
  flash(req, 'ok', 'Period saved.');
  res.redirect('/admin/periods');
}
app.post('/admin/periods', requireAdmin, a((req, res) => savePeriod(req, res, null)));
app.post('/admin/periods/:id', requireAdmin, a((req, res) => savePeriod(req, res, Number(req.params.id))));
app.post('/admin/periods/:id/delete', requireAdmin, deleteRow('periods', 'Period deleted.', () => '/admin/periods'));

// ---------- admin: levies (top-ups) ----------
app.get('/admin/levies', requireAdmin, (req, res) => {
  const levies = [...req.doc.levies].sort((x, y) => y.month.localeCompare(x.month) || y.id - x.id);
  res.render('admin-levies', { title: 'Top-ups & levies', levies, current: ledger.currentMonth() });
});
app.post('/admin/levies', requireAdmin, a(async (req, res) => {
  const amount = toCents(req.body.amount);
  if (!req.body.name || !isMonth(req.body.month) || !(amount > 0)) {
    flash(req, 'error', 'Name, month and a positive amount are required.');
  } else {
    await store.update(doc => { store.insert(doc, 'levies', { name: req.body.name.trim(), month: req.body.month, amount }); });
    flash(req, 'ok', 'Top-up added. It is charged to every active member who had joined by that month.');
  }
  res.redirect('/admin/levies');
}));
app.post('/admin/levies/:id/delete', requireAdmin, deleteRow('levies', 'Top-up deleted.', () => '/admin/levies'));

// ---------- admin: expenses / withdrawals ----------
app.get('/admin/expenses', requireAdmin, (req, res) => {
  const expenses = [...req.doc.expenses].sort((x, y) => y.spent_on.localeCompare(x.spent_on) || y.id - x.id);
  const fund = ledger.fundTotals(req.doc);
  res.render('admin-expenses', { title: 'Withdrawals & expenses', expenses, fund, today: new Date().toISOString().slice(0, 10) });
});
app.post('/admin/expenses', requireAdmin, a(async (req, res) => {
  const amount = toCents(req.body.amount);
  if (!req.body.description || !isDate(req.body.spent_on) || !(amount > 0)) {
    flash(req, 'error', 'Date, description and a positive amount are required.');
  } else {
    await store.update(doc => { store.insert(doc, 'expenses', { spent_on: req.body.spent_on, description: req.body.description.trim(), amount }); });
    flash(req, 'ok', 'Withdrawal recorded.');
  }
  res.redirect('/admin/expenses');
}));
app.post('/admin/expenses/:id/delete', requireAdmin, deleteRow('expenses', 'Withdrawal deleted.', () => '/admin/expenses'));

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
  await store.update(doc => {
    Object.assign(doc.settings, {
      org_name: b.org_name.trim(), currency: b.currency.trim(), black_months: months,
      suspend_balance: -Math.abs(suspend), opening_bank_balance: bank,
    });
  });
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
  const message = /Vercel Blob is not connected/.test(err.message) ? err.message : 'Something went wrong.';
  res.status(500).render('error', { title: 'Error', message });
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Funeral Accounting running on http://localhost:${PORT} (data: ${store.backendName})`));
}
