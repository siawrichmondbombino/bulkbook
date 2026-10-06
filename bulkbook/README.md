# Bulkbook

Stock, sales, receipts and borrowers for a wholesale shop. One owner and any number of employees.
Works on phones and PCs (it can be added to a phone's home screen). No animation. Large, readable text.

- Sell by the **box or piece**, or by the **full or half bag**. The half-bag price is exactly half of the bag price.
- Every sale makes a **receipt** (goods, quantity, price, who served, customer).
- **Borrowers**: name and phone are required. A customer who still owes can buy again. Payments are confirmed by the employee who received them and go to the oldest receipt first.
- **Reports**: sales every day and every month, by person. Owner also sees profit and a customer analysis.
- **Old receipts**: receipts paid in full for more than 4 months are deleted automatically once a day. Monthly totals are kept.
- **Roles**: the owner can do everything and is the only one who creates or deletes employee logins and changes prices. Employees sell, add goods and stock, and confirm payments.

Colours: Deep Berry `#4A123F`, Vanilla Cloud `#FFF8DF`, orange `#FC6C26` (used only as a fill with Deep Berry text).

---

## 1. What is tested, and what is not

Read this before you trust the system with real money.

**Tested (149 automated checks, all passing)** with `sh tests/run_all.sh`:

| Group | Checks | What it proves |
|---|---|---|
| Database | 86 | Run on a real PostgreSQL 16: who can read or change what (owner, employee, stranger, anonymous); prices recomputed on the server so the browser cannot cheat; cost prices hidden from employees; stock; borrowing; payments; reports; the 4-month clean-up keeps totals and never deletes a receipt that still owes; two sales racing for the last stock cannot oversell. |
| Server (Worker) | 40 | With a pretend Clerk and Supabase: only the owner can create or delete logins (login name or email); input checks; a failed profile write removes the new Clerk login again; no secret is ever returned. |
| Whole app | 23 | The real `public/app.js` in a simulated browser against the real database rules: sell, customer search, borrow, pay back, add goods, owner and employee screens, settings, create and delete an employee, the clean-up, and a signed-in stranger sees nothing. |

Also checked by running them:
- The project installs from `package.json`; Wrangler 4.147.0 accepts `wrangler.jsonc` and bundles the Worker; the Worker runs in the real Cloudflare Workers runtime locally (config, static files, security headers, 401 for missing or bad login tokens, the daily trigger).
- `scripts/backup.sh` and `scripts/restore.sh`: a backup of a populated database was restored into a fresh one and came back **identical**, receipt numbering continued without duplicates, and a restore into a database that already has data is refused. (Testing found two bugs in the first restore script; both are fixed.)
- `scripts/check-live.mjs`: passes 20 of 20 against the real Worker runtime, and fails correctly against a deliberately leaky test server.

**NOT tested. These need your own accounts, so you must check them (section 7):**

- Real Clerk: the sign-in screen, creating a login with a password, the real login-token check succeeding. [Unverified]
- Real Supabase through its web API. [Unverified]
- A real phone or real browser: how it looks and feels, and printing a receipt. [Unverified]
- The tests used a stand-in for Supabase's roles and `auth.jwt()`, not Supabase itself.

---

## 2. How it fits together

```
 Phone / PC browser                                   Cloudflare Worker (your server)
 ┌─────────────────────────┐   /api/config            ┌───────────────────────────────┐
 │ index.html, app.js      │ ───────────────────────► │ serves the pages (/public)    │
 │ Clerk sign-in           │   /api/staff (owner)     │ creates / deletes employee    │
 │                         │ ───────────────────────► │   logins (needs secret keys)  │
 └───────────┬─────────────┘                          │ daily clean-up (cron)         │
             │ login token (Clerk)                    └───────────────┬───────────────┘
             ▼                                                        │ secret keys
 ┌───────────────────────────────────────────────────────────────────▼───────────────┐
 │ Supabase (PostgreSQL)   row-level security ON for every table                      │
 │ Browser can only READ. Every change goes through a function that checks who you    │
 │ are, recomputes prices and totals, and runs as one transaction.                    │
 └────────────────────────────────────────────────────────────────────────────────────┘
```

**Keys.** The browser only ever receives three PUBLIC values from `/api/config`: the Clerk publishable key, the Supabase URL and the Supabase publishable key. They are meant to be public; the database rules protect the data. The two SECRET keys (`CLERK_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) live only in the Worker as secrets. They are never in these files and never sent to the browser. (This was checked against the running Worker.)

**Who is who.** The role (owner or employee) is stored in the database table `profiles`, not in the login token. Only the server can write to it. A person who signs in to Clerk but has no profile gets "No access yet" and sees no data (tested).

---

## 3. Free hosting: facts and warnings

Facts below were checked against the services' own documentation in October 2026. Limits and prices change, so check each pricing page before you start.

| Service | What the documentation says | What it means for you |
|---|---|---|
| **Vercel (free "Hobby" plan)** | Meant for non-commercial personal use. | A wholesale shop is a business, so **do not use it**. This is why the project uses Cloudflare. |
| **Cloudflare Workers (free)** | Official limits page: 100,000 Worker requests a day, 10 ms CPU time per request, 50 outgoing calls per request, **5 cron triggers per account**. Static files are free and unlimited. The paid plan starts at $5 a month. | A shop is far below these limits (only `/api/*` runs the Worker; this project uses 1 cron trigger). **I found no sentence either allowing or forbidding business use on the free plan, and the free plan has no support commitment. Read Cloudflare's terms (cloudflare.com/terms) and decide.** If you want certainty, the paid plan is $5 a month. |
| **Supabase (free)** | Official docs: a free project **may be paused if it is not queried at least once every 7 days**, and **database backups are not available for download on the free plan**. 500 MB database. Paid Pro plan has nightly backups for up to 7 days. | A shop that opens every day will not be paused, but before a long closure open the app, or resume the project in the dashboard. **There is no automatic backup, so use `scripts/backup.sh` (section 8).** |
| **Clerk (free)** | One Clerk page says 50,000 monthly users, other pages still say 10,000; a shop needs a handful. Clerk's sign-in options page says some sign-in methods need a paid plan **for production** (all are free in development). | **I could not tell whether username and password sign-in is free in production.** Test in Clerk's development mode first. If usernames need a paid plan, use **email addresses as employee logins**: the app accepts either. [Unverified] |

---

## 4. Setup, step by step

You need a computer with Node.js 20 or newer, and free accounts at Cloudflare, Supabase and Clerk. Menu names in the dashboards change from time to time, so a name below may differ slightly on your screen.

### Step 1. Get the code and install
```
cd bulkbook
npm install
```

### Step 2. Supabase: create the database
1. Create a new Supabase project. Choose a strong database password and save it.
2. Open **SQL Editor, New query**. Paste the whole of `database/schema.sql` and **Run**. It must finish without errors. (Run it only once. To start again, delete the project's tables or make a new project.)
3. Optional: run `database/seed_sample_goods.sql` to get 6 sample goods.
4. Open **Project Settings, API** and copy: the **Project URL**, the **publishable key** (older projects call it the *anon* key), and the **service role key** (secret).

### Step 3. Clerk: create the login system
1. Create a Clerk application. In **User & authentication**, turn on **Password**, and turn on **Username** (or **Email address**, see section 3). Turn off the options you do not use.
2. Stop strangers from creating accounts: on Clerk's **Restrictions** page (newer dashboards call it **Access mode**) do not leave sign-up open to anyone. Choose restricted or invite-only. Even if someone creates an account anyway, the database gives them nothing because they have no profile (tested). The names of these settings change between Clerk versions. [Unverified wording]
3. Copy the **publishable key** (`pk_...`) and the **secret key** (`sk_...`) from **API keys**.
4. In **Users**, create the owner's user (login name or email, and a password). Copy the **user id** (starts with `user_`).

Clerk will refuse passwords shorter than 8 characters or found in hacked-password lists (stated in its SDK). The app shows Clerk's message to the owner.

### Step 4. Connect Clerk to Supabase
1. In the Clerk dashboard, open the **Supabase integration setup** page and activate it. It shows your **Clerk domain**. Copy it.
2. In the Supabase dashboard go to **Authentication, Sign In / Providers**, choose **Add provider**, choose **Clerk**, and paste the Clerk domain.

This is Clerk's current method (checked in Clerk's documentation). The older "JWT template" method is deprecated, so do not use it. The Supabase URL and key are under **Project Settings, Data API**.

### Step 5. Make the first owner
Open `database/first_owner.sql`, replace the placeholder with the owner's Clerk user id, full name and login name (or email), and run it in the Supabase SQL Editor. Without this row, no one can use the app.

### Step 6. Try it on your computer (optional but recommended)
```
cp .dev.vars.example .dev.vars        # then fill in the values
npm run dev                           # open http://localhost:8787
```
Use `APP_ORIGIN=http://localhost:8787` while testing.

### Step 7. Deploy
```
npx wrangler login
npx wrangler deploy
```
Wrangler prints your address, for example `https://bulkbook.YOUR-NAME.workers.dev`.

### Step 8. Add the secrets to the live Worker
Run each line and paste the value when asked. Values never go in files.
```
npx wrangler secret put CLERK_PUBLISHABLE_KEY
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put APP_ORIGIN        # your exact address, no trailing slash
```
`APP_ORIGIN` makes login tokens valid only for your site. If sign-in works but creating an employee says "Please sign in again", this value does not match your address exactly. You can leave it unset to skip the check.

If you use a newer Supabase **secret key** (`sb_secret_...`) instead of the older service role key, the server sends it in the `apikey` header only. I have not tested that with a real Supabase project, so test creating an employee once. [Unverified]

### Step 9. First use (as the owner)
1. Sign in. Open **Employees and shop**. Set the **shop name** (printed on receipts) and the **time zone** (decides when a day and a month start in reports). The default is UTC.
2. Add or edit goods. **Change prices** lets you enter the cost price, so profit can be shown.
3. Create employee logins. Write the password down and give it to the employee.
4. On each phone, open the site and choose "Add to home screen".

### Step 10. Daily clean-up
`wrangler.jsonc` schedules it for 03:00 UTC every day. After deploying, find the Worker in the Cloudflare dashboard (**Workers & Pages**, your Worker, **Triggers**) and confirm the cron trigger is listed. The owner can also press **Delete old receipts** on the Receipts screen at any time. The free plan allows 5 cron triggers per account and this project uses 1.

---

## 5. Rules built in

| Rule | How it works |
|---|---|
| Box goods | Owner or employee enters pieces in a box, the price of a piece, and the price of a full box. Sold as "Full box" or "Pieces". |
| Bag goods | One bag price. Sold as "Full bag" or "Half bag". Half = bag price ÷ 2, rounded to the cent. **Use bag prices with an even number of cents**, or two halves can differ from one bag by 1 cent. |
| Stock | Whole numbers only, kept in pieces (box goods) or half-bags (bag goods). A sale cannot take more than is in stock, even when two people sell at once. |
| Receipts | Number, date, shop name, goods, quantity, price, who served, customer, paid and balance. Printable. |
| Borrowers | Customer mode needs name and phone. The same phone is not added twice: numbers are compared by their **last 9 digits**, so `+233 24 555 0102` and `024 555 0102` match. This is a shortcut that suits local numbers. [Inference] |
| Owing and buying again | A customer who owes can buy again. The new sale adds to what they owe, and the screen warns about it. |
| Payments | Recorded under the employee who confirmed. Applied to the oldest unpaid receipt first. Cannot exceed what is owed. |
| Old receipts | Deleted when **paid in full** more than **4 months ago, counted from the day it was fully paid**. Receipts that still owe are never deleted. Before deleting, monthly totals and each customer's lifetime total are saved, so reports do not change. The 4 months can be changed in the database (`app_settings.retention_months`). |
| Prices | Only the owner changes the price of existing goods. Employees can add new goods with their prices. **This lets an employee set the price of a new item without approval.** Say so if you want an approval step. |
| Reports | Daily and monthly, by person. The owner sees everyone, profit and the customer analysis. An employee sees only their own sales, with no profit. |
| Employee logins | The owner enters a **login name or an email address** plus a password. Clerk accepts only passwords of 8+ characters that are not in hacked-password lists. |
| Cost price | Hidden from employees at the database level. Goods added by an employee show "Cost needed" to the owner until the owner enters it. |
| Employees' view of receipts | An employee sees their own receipts **and every receipt that belongs to a named customer** (needed to collect debts). Walk-in receipts of other employees stay hidden. |
| Deleting an employee | Their login is removed. Their name stays on old receipts. |

---

## 6. Limits you should know

- The Receipts screen shows the latest 300 receipts. Older ones are still in the database and in the reports.
- Needs an internet connection. There is no offline mode.
- Currency is shown as `GH₵`. To change it, edit the `CUR` line near the top of `public/app.js`.
- Passwords are checked by Clerk (for example against known leaked passwords). If Clerk refuses a password, the message is shown to the owner.
- The sign-in screen uses an internal part of Clerk's browser library (`__internal_ClerkUICtor`) exactly as Clerk's own quick-start shows. A future Clerk release could change this, so `app.js` pins `clerk-js@6` and `ui@1`. [Inference]
- The Supabase library is loaded from a public CDN (`@supabase/supabase-js@2`). For stricter control, pin an exact version in `public/app.js`.
- Everyone who can sign in can see all customers' names and phone numbers. That is needed to sell on credit.
- Cloudflare's free plan allows 10 ms of processor time per request. Creating an employee does a login check and two calls to other services, which should fit, but I have not measured it on the real service. If it ever fails with a CPU-time error, the $5 a month paid plan removes that limit. [Inference]

---

## 7. Check it works (do this on your live site)

0. **Run the automatic check:** `node scripts/check-live.mjs https://YOUR-SITE`. All lines must say PASS.
1. **Public values only.** Open the site, open the browser developer tools, and look at `/api/config`. It must show only three values. Search the page source for `sk_`. It must not be there.
2. **Owner sign-in.** Sign in as the owner. You should see Home with all menu items, including Employees and shop.
3. **Create an employee**, then sign in as that employee in another browser. They must not see Employees, must not see **Change prices**, and must not see profit or the Customers report.
4. **Stranger test.** Create a user in the Clerk dashboard without adding a profile, then sign in as them. They must see "No access yet".
5. **Sell and borrow.** Sell one box and one half bag to a new customer paying part. Check the receipt, the stock, and the amount owed. Then record a payment from the Who owes me screen.
6. **Wrong login.** Try a wrong password. Clerk should refuse it.
7. **Print.** Open a receipt and press Print.
8. **Phone.** Use it on a real phone. Check the text size and the bottom menu.
9. **Clean-up.** After a few months, or by changing dates in the test project, confirm old paid receipts disappear and monthly totals stay.

---

## 8. Backups (do this, the free plan has none)

Supabase's own documentation says database backups are not available for download on the free plan and suggests tools like `pg_dump`. This project includes a ready script.

**Make a backup** (on any computer with the PostgreSQL client tools installed):
1. In Supabase click **Connect** and copy the **Session pooler** connection string. Put your database password in it.
2. Run:
```
DATABASE_URL='postgresql://postgres.xxxx:PASSWORD@aws-0-xx.pooler.supabase.com:5432/postgres' sh scripts/backup.sh
```
It saves a dated file in a `backups` folder, checks that the file can be read back, and keeps the newest 30. **Do this every week, and copy the files to a USB drive or another computer.** The files contain customer names and phone numbers, so keep them private. The Session pooler is the one that works with `pg_dump`; the Transaction pooler does not. [Source: a third-party guide, not tested here]

**Restore** (for example after a mistake or a lost project):
1. Create a new Supabase project and run `database/schema.sql` in its SQL Editor.
2. Run:
```
DATABASE_URL='postgresql://...new project...' sh scripts/restore.sh backups/bulkbook-2026-10-04_120000.dump
```
It refuses to run if the database already has shop data. It restores the tables in a safe order and continues the receipt numbering.
3. Logins live in Clerk, not in the backup. If you also moved to a new Clerk project, run `database/first_owner.sql` for the new owner id.

Tested on a real PostgreSQL 16: a restored copy was identical to the original. I have not run it against a real Supabase project, so do one trial restore into a spare free project before you need it.

---

## 9. If something goes wrong

| Problem | Try |
|---|---|
| Page says "The app is not set up yet" | A secret from step 8 is missing. Run the `secret put` lines again. |
| "No access yet" for the owner | Step 5 was not done, or the Clerk user id in `profiles` is wrong. |
| Sign-in works but data does not load | The Clerk to Supabase link (step 4) is not active, or the Clerk domain is wrong. |
| "Please sign in again" when creating an employee | `APP_ORIGIN` does not match the address exactly (including `https://` and no trailing `/`). |
| Clerk refuses to create the login | The message from Clerk is shown. Common causes: password too weak or leaked, login name already used, username sign-in not turned on in Clerk (or not available on your plan: use an email address as the login). |
| Everything stopped after a quiet week | Supabase paused the free project. Resume it in the Supabase dashboard. |
| Day or month totals look off by a few hours | Set the correct time zone in Employees and shop. |

---

## 10. Files

```
bulkbook/
  public/            what the browser loads
    index.html       the home page
    styles.css       all styling (no animation)
    app.js           the whole app (Clerk + Supabase)
    manifest.json    lets phones install it like an app
    icon*.png/svg    app icons
    _headers         security headers for static files
  src/worker.js      the server: /api/config, /api/staff, daily clean-up
  database/
    schema.sql       tables, security rules, all server-side functions
    first_owner.sql  creates the first owner (edit, then run once)
    seed_sample_goods.sql   optional sample goods
  scripts/
    backup.sh        saves the shop's data to a file on your computer
    restore.sh       puts a backup into an empty database
    check-live.mjs   checks a deployed site for leaked keys and open doors
  tests/             automated tests (developers only)
  wrangler.jsonc     Cloudflare settings (no secrets)
  package.json       dependencies and commands
  .dev.vars.example  list of the secrets and public keys, with no real values
```
