# Funeral Accounting Portal

A web portal for a funeral society. The admin sets the monthly fee and adds members, then records payments. Every member can sign in and see the shared dashboard, which shows who has paid and who is behind.

## Run it

Requires Node.js 20 or newer. On Windows PowerShell, use `npm.cmd` instead of `npm` if scripts are blocked.

```bash
npm install
npm start
```

Open http://localhost:3000. The first visit asks you to create the admin account.

All data is kept in one JSON file, `data/funeral.json`. Every save also writes a copy to `data/backups/<date>.json`, so you have one backup per day.

To try it with sample data instead, point it at a separate folder:

```bash
DATA_DIR=./demo-data npm run seed:demo
DATA_DIR=./demo-data npm start
```

The demo admin login is `admin` / `admin123`. Demo members use their lowercase first name with `member123`.

## Deploy to Vercel

Vercel can't change files in a deployed app, so on Vercel the same JSON document is stored in **Vercel Blob**, Vercel's own file storage. The file is private and read and written by the app only. The app switches to Blob automatically when `BLOB_READ_WRITE_TOKEN` is set. Daily backups go to `funeral/backups/<date>.json` in the same store.

1. Import this GitHub repo at https://vercel.com/new.
2. In the project, open **Storage → Create → Blob** and connect it to the project. This sets `BLOB_READ_WRITE_TOKEN`. Then redeploy.
3. Upload your existing data once:
   ```bash
   vercel env pull .env
   npm run upload-to-blob
   ```
   If you skip this step, the site starts empty and the first visitor is asked to create an admin.

If two admins save at the same moment, the second save reloads the latest data and applies its change again, so neither change is lost.

## How it works

| Admin sets up | Where |
|---|---|
| Collection period: months covered (a full year or part of one) and the fee per month | Periods & fees |
| Members: login, join month, custom fee, amount brought forward | Members |
| Payments received, including lump sums | Payments, or on a member's page |
| Top-ups and levies: a one-off amount charged to every member for a month | Top-ups |
| Withdrawals: funeral payouts, bank fees | Withdrawals |
| Society name, currency symbol, arrears rules, opening bank balance | Settings |

**Payment allocation.** A payment pays off the oldest amount owing first: brought-forward, then each month's fee and top-ups in date order. Anything left over covers future months. For example, with a 100 monthly fee, a lump sum of 500 paid in a fully paid-up month covers the next 5 months.

**Status colours**
- 🟢 **Green**: balance is 0 or in credit (up to date or paid ahead).
- 🔴 **Red**: owing something, but fewer months than the black threshold.
- ⚫ **Black**: *N* or more monthly fees unpaid (default 3), or a balance at or below the suspension limit (default −500). Both values can be changed in Settings.

The current month counts as due from the 1st of the month.

**Visibility.** Only admins can see the dashboard and every member's details and status. A member who signs in sees only their own account: their status, balance, months paid and payment history. Only admins can change anything. An account can be marked "login only" (not charged), for an admin who doesn't pay contributions.
