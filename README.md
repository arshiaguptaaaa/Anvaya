# Anvaya — career preparation platform

Live at **https://anvayacareers.in**. One Vercel app + Supabase (Postgres + private storage) + Resend + Razorpay.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (architecture, audit, schema, costs) and [docs/SETUP.md](docs/SETUP.md) (exact production setup).

| Area | URL | Roles |
| --- | --- | --- |
| Public brochure | `/` | everyone (original page + one lead-capture script tag) |
| Admin & CRM | `/admin` | `admin` (everything), `ops` (scheduling, reminders, attendance, follow-ups) |
| Mentor dashboard | `/mentor` | `mentor` (own students, groups, sessions, reviews, ledger) |
| Student dashboard | `/student` | `student` (own plan, syllabus, sessions, services, outcomes) |
| Links | `/invite`, `/reset` | single-use, expiring account links |

Tests: `npm test` (27 end-to-end journeys + permission checks on in-process Postgres).
Local dev: `.env` with `DATABASE_URL=pglite://data/pg`, `MAIL_TRANSPORT=memory`, `STORAGE_DRIVER=memory`, then `npm start`.

---


The public brochure (`public/index.html`) is served **byte-for-byte unchanged** (same SHA-256 as the supplied `anvaya-brochure (15).html`). Everything new lives on separate routes and uses the same navy / gold / ivory tokens, Cormorant Garamond + DM Sans, grid background and noise overlay.

| URL | Who | What |
| --- | --- | --- |
| `/` | Everyone | The original Anvaya page, untouched |
| `/admin/login`, `/admin` | Admin | CRM: overview, leads, students, mentors, bookings, payments, account |
| `/invite?token=…` | Invited mentor | Accept invitation → create password (or request a fresh link if expired) |
| `/mentor/onboarding` | Invited mentor | Complete profile, session details and weekly availability → becomes **Active** |
| `/mentor/login`, `/mentor` | Mentor | Overview, sessions (notes + mark completed), students, earnings, availability, profile |

## Run it

Requires Node 24.

```bash
npm install
cp .env.example .env      # for local dev set DATABASE_URL=pglite://data/pg and MAIL_TRANSPORT=memory
npm start                 # http://localhost:3000 (or PORT)
npm test                  # full journey + permission tests on in-process Postgres (PGlite)
```

### Production (Vercel + Supabase)

- `public/` is served by Vercel's CDN (brochure, dashboard CSS/JS, logo). `api/index.js` runs the Express app as a serverless function for `/api/*`, `/admin*`, `/mentor*` and `/invite` (see `vercel.json`).
- All persistent records (users, mentors, availability, invitations, sessions, students, leads, bookings + session notes, payments, audit log, rate limits) live in Supabase Postgres in the `anvaya` schema. Earnings are derived from completed bookings (`anvaya.mentor_earnings` view).
- Schema: `supabase/migrations/0001_anvaya_init.sql`. Apply with `DATABASE_URL=… npm run db:migrate` (or paste it into the Supabase SQL editor).
- Import from the old SQLite file: `npm run db:import-sqlite` (dry run) then `npm run db:import-sqlite -- --apply`. Test accounts (`.test`, `.local`, `example.*` emails) and sample records are excluded, and nothing is deleted.
- Row Level Security is enabled on every table with no policies, and the `anon` / `authenticated` roles have no grants, so Supabase's public API keys can't read anything. Only the server, using `DATABASE_URL`, can.

Create or reset an admin at any time: `npm run create-admin -- you@example.com` (prompts for the password).

## Mentor lifecycle

1. Admin adds name, email, expertise, bio, session price → status **Invite pending**, email sent.
2. The email carries a unique 256-bit token link. Only its SHA-256 hash is stored. Default lifetime 72h (`INVITE_TTL_HOURS`).
3. The link is **single-use** (claimed atomically in a transaction). Resending or requesting a fresh link revokes every earlier link.
4. Expired/replaced links show a "Email me a fresh link" button. The new link always goes to the address on file — never to an address supplied by the requester.
5. After setting a password the mentor is held at onboarding until profile + at least one availability slot are saved; then status becomes **Active** and `/mentor` opens.
6. **Deactivate** signs the mentor out everywhere immediately, blocks login and kills pending links. Records are kept; **Reactivate** restores access.

## Security model

- Passwords: scrypt (N=16384) with per-user salt; min 10 chars incl. a letter and a number.
- Sessions: random opaque token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` in production); only the hash is stored; 12h TTL; revoked on deactivate / password change.
- CSRF: per-session token required in `X-CSRF-Token` on every state-changing API call.
- Rate limits on login (per IP+email and per IP), invitation lookup and fresh-link requests.
- Permissions are enforced server-side: `/api/admin/*` requires `role=admin`; `/api/mentor/*` requires `role=mentor` **and** every query is scoped to the signed-in mentor's id. Another mentor's booking/student returns 404. Admin-only student notes and student pricing are never sent to mentors. Mentors can't change their own price, email or status.
- Dashboard pages send a strict CSP (no inline scripts/styles), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`; the invite token is removed from the address bar after load.
- SMTP credentials and other secrets live only in `.env` on the server.

## What you need to connect

| Service | Env vars | Status |
| --- | --- | --- |
| Supabase Postgres | `DATABASE_URL` (transaction pooler, port 6543) | Required. |
| Email | `RESEND_API_KEY` **or** `SMTP_*`, plus `MAIL_FROM` | Required in production. Without a provider, invitations fail with a clear error (no silent outbox). |
| Public URL | `APP_BASE_URL` | Required in production; used to build invitation links. |
| HTTPS + hosting | `NODE_ENV=production`, `TRUST_PROXY=1` if behind a proxy | Any Node host with a persistent disk for `data/` (Render/Railway/Fly volume, a VPS…). |

## Notes

- Free-chat enquiries: the brochure gets exactly one added line, `<script src="/app/lead-capture.js" defer>`, before `</body>`. It sends a copy of each submission to `/api/public/leads`, so it appears as a **New** lead in the CRM. The original Google Apps Script post, its success message and everything else on the page stay as supplied. `npm test` checks that removing that one line gives back the exact original file.
- The brochure links to `anvaya-payment.html`, which wasn't part of the supplied files, so those links return 404 here just as they would next to the original file.
- Payments are recorded manually (no payment gateway).
- Reset local data: stop the server and delete `data/`.
- Rate limits are stored in Postgres, so they hold across serverless instances.
