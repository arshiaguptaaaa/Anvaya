# Moving Anvaya from Vercel to Hostinger (Business plan option)

> Chosen route is the **split setup** in [SPLIT-SETUP.md](SPLIT-SETUP.md) (Hostinger Single + Cloud Run). This file
> applies only if you later upgrade Hostinger to Business/Cloud and move the whole app there.

Supabase (database + private files), Resend (email) and Razorpay stay exactly as they are; only the web server moves.
**anvayacareers.in keeps pointing at Vercel until the Hostinger copy passes every check in step 5.**

## 0. What changed in the code
* `src/server.js` is a normal Node server. In production it applies pending database migrations before starting.
* The server serves `public/` itself (brochure, payment page, `/app`, `/assets`) and repeats Vercel's `?plan=500` redirect.
* Built-in scheduler: every 5 minutes it queues 24 h / 2 h session reminders, renewal reminders and retries, then sends
  due emails. A Hostinger cron job (step 4) hits `/api/cron/run` as a second trigger in case the app was asleep.
* Vercel keeps working unchanged, so you can switch back at any time.

## 1. Create the Node.js app (needs Business web hosting or any Cloud plan; Single/Premium can't run Node.js apps)
Websites → **Create Website** → **Web App** → **Upload .zip** (or **Import Git repository** once the GitHub repo exists).
* Upload `hostinger-upload.zip` (built from this folder; no secrets inside).
* Framework: **Other** (Express). Node version: **22.x**. Entry file: `src/server.js`. No output directory, no build script.
* Leave it on Hostinger's **temporary domain**. Do not attach anvayacareers.in yet. (Hostinger: a domain's existing
  website must be removed before a Node.js app can use it, and Node.js apps have no Stop button; removing one is permanent.)

## 2. Environment variables (hPanel → the app → Environment variables)
Type the values there yourself. Never paste them into chat.

| Name | Value / where to get it |
|---|---|
| `NODE_ENV` | `production` |
| `APP_BASE_URL` | Hostinger's temporary URL for testing (e.g. `https://xxxx.hostingersite.com`). Change to `https://anvayacareers.in` at cut-over |
| `APP_SECRET` | Vercel → anvaya → Settings → Environment Variables → `APP_SECRET` (copy the same value). If Vercel won't reveal it, generate a new 64-character random string |
| `CRON_SECRET` | Same source as above, or a new random string (also used in step 4) |
| `DATABASE_URL` | Supabase dashboard → project → **Connect** → *Transaction pooler* URI (port **6543**), with your database password filled in |
| `DATABASE_MIGRATION_URL` | Same URI but port **5432** (*Session pooler*) |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API keys → `service_role` (secret) |
| `RESEND_API_KEY` | Resend dashboard → API Keys → **Create API key** (sending access, domain anvayacareers.in) |
| `MAIL_FROM` | `Anvaya <connect@anvayacareers.in>` |
| `MAIL_REPLY_TO` | `arshiagupta0139@gmail.com` |
| `ADMIN_EMAIL` | `arshiagupta0139@gmail.com` (the admin already exists; no password variable is needed) |
| `GOOGLE_SHEET_WEBHOOK_URL` | Same value as on Vercel (the free-chat Apps Script URL) |
| `INVITE_TTL_HOURS` | `72` |
| `TRUST_PROXY` | `1` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Later, when you're ready for automatic payment verification (Razorpay Dashboard → Account & Settings → API Keys / Webhooks) |

While testing on the temporary URL, also set `EXTRA_ORIGINS=https://anvayacareers.in` so brochure leads still work.

## 3. Deploy and read the log
Deploy, then open the app's **logs**. Expect `= 0001…`, `= 0002…`, `= 0003…`, `+ 0004_remove_ai_settings.sql`,
then `Anvaya running on port …`. Any error here: copy the log text (it never contains secrets) and send it to Claude.

## 4. Cron job (hPanel → Advanced → Cron Jobs)
* Type: custom command. Interval: **every 5 minutes** (`*/5 * * * *`).
* Command (put your `CRON_SECRET` value where shown, and use the temporary URL until cut-over):
  `curl -fsS -H "Authorization: Bearer YOUR_CRON_SECRET" https://anvayacareers.in/api/cron/run > /dev/null`

## 5. Test on the temporary URL (Claude can run these once you share the URL)
1. Brochure loads unchanged; free-chat form reaches the admin CRM.
2. `/admin/login`: admin login, System page shows Email, Storage and Google Sheet connected.
3. Admin → System → **Send test email** arrives from connect@anvayacareers.in.
4. Synthetic mentor + student invites, login, upload, booking, manual payment → subscription (then purge test data).
5. Cron: the System page shows jobs running every 5 minutes.

## 6. Cut-over (only after step 5 passes)
1. hPanel → the app → **Connect domain** → `anvayacareers.in` (choose "use a domain I already own"; **do not transfer**,
   `.in` transfers aren't supported and aren't needed).
2. Change `APP_BASE_URL` to `https://anvayacareers.in`, remove `EXTRA_ORIGINS`, update the cron URL, redeploy.
3. GoDaddy → DNS: change **only** the `@` A record and the `www` CNAME to the values Hostinger shows.
   **Do not change nameservers.** The Resend records (DKIM/SPF/MX on `send`/`resend._domainkey`) must stay.
4. Wait for HTTPS to be issued on Hostinger, then re-run checks 1–3 on anvayacareers.in.

## 7. Rollback
Put the GoDaddy records back to today's Vercel values: `@` A → `216.198.79.1`, `www` CNAME → `af7e970bcbafc984.vercel-dns-017.com` (recorded 20 Oct 2026). Vercel is still deployed,
so the site is back within minutes. Keep the Vercel project until Hostinger has run cleanly for 2 weeks.
