// Uploads data/funeral.json to the project's Vercel Blob store, so the deployed site
// starts with your existing members. Needs BLOB_READ_WRITE_TOKEN (vercel env pull .env).
//   node --env-file=.env scripts/upload-to-blob.js           (refuses if Blob already has data)
//   node --env-file=.env scripts/upload-to-blob.js --force   (replace what is in Blob)
const fs = require('fs');
const path = require('path');
const { get, put } = require('@vercel/blob');

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('BLOB_READ_WRITE_TOKEN is not set. Run: vercel env pull .env');
  process.exit(1);
}
const file = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'funeral.json');
const KEY = 'funeral/data.json';

(async () => {
  const text = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(text);
  const existing = await get(KEY, { access: 'private', useCache: false });
  if (existing && existing.statusCode === 200 && !process.argv.includes('--force')) {
    console.error('Vercel Blob already has data. Re-run with --force to replace it.');
    process.exit(1);
  }
  await put(KEY, text, { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 60 });
  console.log(`Uploaded ${doc.users.length} users and ${doc.payments.length} payments to Vercel Blob.`);
})().catch(e => { console.error(e.message); process.exit(1); });
