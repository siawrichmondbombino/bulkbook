# Tests

These are checks for developers. They are not needed to run the shop.

| File | What it checks |
|---|---|
| `sql.test.cjs` | `database/schema.sql` on a real PostgreSQL: who can read or change what (owner, employee, stranger, anonymous), prices computed on the server, stock, borrowing, payments, reports, the 4-month clean-up, two sales racing for the last stock. |
| `worker.test.mjs` | `src/worker.js` with a pretend Clerk and a pretend Supabase: only the owner can create or delete logins, input checks, rollback, no secrets in responses. |
| `e2e.test.cjs` | The real `public/app.js` in a simulated browser (jsdom), talking to the real database rules through a small adapter. |

Run them all: `npm install` then `sh tests/run_all.sh` (needs a local PostgreSQL).

**What these tests cannot prove.** They use a local PostgreSQL with a stand-in for Supabase's login and roles. They do not talk to real Clerk, real Supabase (PostgREST) or a real browser. Follow the README checklist ("Check it works") on your live site.
