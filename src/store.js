// All data lives in ONE JSON document:
//   - locally:   data/funeral.json  (plus data/backups/YYYY-MM-DD.json)
//   - on Vercel: private Vercel Blob "funeral/data.json" (plus funeral/backups/YYYY-MM-DD.json),
//                used whenever BLOB_READ_WRITE_TOKEN is set.
//
// read()        -> the current document
// update(fn)    -> loads the latest document, lets fn change it, saves it.
//                  If someone else saved in between, it reloads and runs fn again.
//                  If fn returns { error }, nothing is saved.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  org_name: 'Funeral Society',
  currency: 'R',
  black_months: 3,            // months in arrears that turn a member black
  suspend_balance: -50000,    // balance (cents) at or below which a member turns black
  opening_bank_balance: 0,    // cents
};
const TABLES = ['users', 'periods', 'levies', 'payments', 'expenses'];

function normalize(doc) {
  doc = doc || {};
  doc.settings = { ...DEFAULT_SETTINGS, ...(doc.settings || {}) };
  doc.seq = doc.seq || {};
  for (const t of TABLES) {
    doc[t] = doc[t] || [];
    doc.seq[t] = Math.max(doc.seq[t] || 0, ...doc[t].map(r => r.id), 0);
  }
  return doc;
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const today = () => new Date().toISOString().slice(0, 10);

// ---------- local file backend ----------
function fileBackend() {
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const file = path.join(dir, 'funeral.json');
  return {
    name: `file ${file}`,
    async load() {
      try {
        const text = await fs.promises.readFile(file, 'utf8');
        return { doc: JSON.parse(text), etag: null };
      } catch (e) {
        if (e.code === 'ENOENT') return { doc: null, etag: null };
        throw e;
      }
    },
    async save(doc) {
      await fs.promises.mkdir(path.join(dir, 'backups'), { recursive: true });
      const text = JSON.stringify(doc, null, 1);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, text);
      await fs.promises.rename(tmp, file); // atomic replace: a crash never leaves half a file
      await fs.promises.writeFile(path.join(dir, 'backups', `${today()}.json`), text);
    },
  };
}

// ---------- Vercel Blob backend ----------
function blobBackend() {
  const { get, put, BlobPreconditionFailedError } = require('@vercel/blob');
  const KEY = 'funeral/data.json';
  const opts = { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false };
  return {
    name: `Vercel Blob ${KEY}`,
    Conflict: BlobPreconditionFailedError,
    async load() {
      const res = await get(KEY, { access: 'private', useCache: false });
      if (!res || res.statusCode !== 200) return { doc: null, etag: null };
      const text = await new Response(res.stream).text();
      // get() can return a weak ETag (W/"…") that put()'s ifMatch never matches; use the strong form
      return { doc: JSON.parse(text), etag: res.blob.etag.replace(/^W\//, '') };
    },
    async save(doc, etag) {
      const text = JSON.stringify(doc);
      await put(KEY, text, { ...opts, cacheControlMaxAge: 60, ...(etag ? { ifMatch: etag } : {}) });
      await put(`funeral/backups/${today()}.json`, text, { ...opts, cacheControlMaxAge: 60 });
    },
  };
}

// Vercel's disk is read-only, so a deployment without Blob storage cannot save anything.
function missingBlobBackend() {
  const fail = async () => {
    throw new Error('Vercel Blob is not connected: add a Blob store under the project\'s Storage tab, then redeploy.');
  };
  return { name: 'none (Vercel Blob not connected)', load: fail, save: fail };
}

const backend = process.env.BLOB_READ_WRITE_TOKEN ? blobBackend()
  : process.env.VERCEL ? missingBlobBackend()
  : fileBackend();

// One local writer at a time; Blob writes are protected by the ETag check instead.
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

async function read() {
  const { doc } = await backend.load();
  return normalize(doc);
}

async function update(fn) {
  return serial(async () => {
    for (let attempt = 1; ; attempt++) {
      const { doc: raw, etag } = await backend.load();
      const doc = normalize(raw);
      const result = await fn(doc);
      if (result && result.error) return result;
      doc.updated_at = now();
      try {
        await backend.save(doc, etag);
        return result;
      } catch (e) {
        if (backend.Conflict && e instanceof backend.Conflict && attempt < 5) continue;
        throw e;
      }
    }
  });
}

function insert(doc, table, row) {
  const id = ++doc.seq[table];
  const rec = { id, ...row, created_at: now() };
  doc[table].push(rec);
  return rec;
}

const sessionSecret = async () => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = (await read()).settings.session_secret;
  if (!s) {
    s = await update(doc => {
      doc.settings.session_secret ||= crypto.randomBytes(32).toString('hex');
      return doc.settings.session_secret;
    });
  }
  return s;
};

module.exports = { read, update, insert, normalize, sessionSecret, backendName: backend.name, now };
