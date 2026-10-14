# Funeral Accounting Portal

A web portal for a funeral society. The admin sets the monthly fee and adds members, then records payments. Every member can sign in and see the shared dashboard, which shows who has paid and who is behind.

## Run it

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite`).

```bash
npm install
npm start
```

Open http://localhost:3000. The first visit asks you to create the admin account. Data is stored in `data/funeral.db`. Back up that file.

To try it with sample data instead, point it at a separate folder:

```bash
DATA_DIR=./demo-data npm run seed:demo
DATA_DIR=./demo-data npm start
```

The demo admin login is `admin` / `admin123`. Demo members use their lowercase first name with `member123`.

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

**Visibility.** Every signed-in user can see the dashboard and every member's profile and payment history. Only admins can change anything. An account can be marked "login only" (not charged), for an admin who doesn't pay contributions.
