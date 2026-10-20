# Split setup: Hostinger Single + Google Cloud Run

| Piece | Where | Address |
|---|---|---|
| Brochure, payment page | Hostinger **Single** plan (static files) | https://anvayacareers.in |
| Dashboards, APIs, emails, reminders | **Google Cloud Run** (free tier at current traffic) | https://app.anvayacareers.in |
| Database, private files | Supabase (unchanged) | |
| Email, payments | Resend, Razorpay (unchanged) | |
| 1-minute reminder/email trigger | Hostinger **Cron Job** → `app.anvayacareers.in/api/cron/run` | |

The order below keeps the current Vercel site live until the end. Steps 1–4 add `app.anvayacareers.in`
without touching the main site. Type every secret into the provider's own settings page; never paste one into chat.

Files (built from this folder, with no secrets inside):
* `anvaya-cloudrun.zip`: the app for Cloud Run
* `hostinger-site.zip`: the static site for Hostinger (rebuild with `node scripts/build-hostinger-site.js`)

## 1. Google Cloud account (you, privately)
1. https://console.cloud.google.com → sign in (teamanvaya.in@gmail.com is a good choice) → accept terms.
2. Create project **anvaya**. Billing → link a card (needed even for the free tier).
3. Billing → **Budgets & alerts** → budget ₹500/month with email alerts at 50 % and 100 %.
Stop and tell Claude if Google asks for any paid plan or commitment.

## 2. Deploy the app (Cloud Shell in the browser, nothing to install)
Open Cloud Shell (the `>_` icon, top right) → ⋮ → **Upload** → `anvaya-cloudrun.zip`. Then run:
```
unzip -o anvaya-cloudrun.zip -d anvaya && cd anvaya
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
gcloud run deploy anvaya --source . --region us-east1 --allow-unauthenticated \
  --min-instances 0 --max-instances 2 --memory 512Mi --cpu 1 --timeout 60 \
  --set-env-vars '^@^NODE_ENV=production@TRUST_PROXY=1@INVITE_TTL_HOURS=72@PG_POOL_MAX=5@MAIL_FROM=Anvaya <connect@anvayacareers.in>@MAIL_REPLY_TO=arshiagupta0139@gmail.com@ADMIN_EMAIL=arshiagupta0139@gmail.com@PUBLIC_SITE_URL=https://anvayacareers.in@EXTRA_ORIGINS=https://anvayacareers.in,https://www.anvayacareers.in@APP_BASE_URL=https://app.anvayacareers.in'
```
(`^@^` makes `@` the separator, because some values contain commas.) `us-east1` sits next to the Supabase database (US East), is in the free tier and supports custom domains.
The first deploy fails at start-up until step 3 adds the secrets. That's expected.

## 3. Secrets (Cloud Run console)
Cloud Run → **anvaya** → **Edit & deploy new revision** → **Variables & secrets** → add:

| Name | Where to get the value |
|---|---|
| `APP_SECRET` | Vercel → anvaya → Settings → Environment Variables (same value), or a new 64-character random string |
| `CRON_SECRET` | Same place, or a new random string (also used in step 6) |
| `DATABASE_URL` | Supabase → **Connect** → *Transaction pooler* URI (port 6543) with your DB password |
| `DATABASE_MIGRATION_URL` | Same, *Session pooler* (port 5432) |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API keys → `service_role` |
| `RESEND_API_KEY` | Resend → API Keys → Create (sending access, anvayacareers.in) |
| `GOOGLE_SHEET_WEBHOOK_URL` | Same value as on Vercel |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | Later (automatic payment verification) |

Deploy. Logs should show `= 0001…0003`, `+ 0004_remove_ai_settings.sql`, `Anvaya running on port 8080`.
Then open the `https://anvaya-….run.app/admin/login` URL Cloud Run shows and send it to Claude for checks.

## 4. Custom domain app.anvayacareers.in (doesn't affect the live site)
1. Cloud Run → **Manage custom domains** → **Add mapping** → service `anvaya` → `app.anvayacareers.in`.
2. If asked, verify anvayacareers.in in Google Search Console (adds one **TXT** record at GoDaddy).
3. GoDaddy → DNS → add **CNAME** `app` → `ghs.googlehosted.com`. Leave every other record alone.
4. Wait for the certificate (15 min to a few hours). Then Claude re-runs the production journeys on app.anvayacareers.in.

## 5. Hostinger static site (Single plan)
1. hPanel → Websites → the site currently named theanvaya.co.in → **Change domain** to `anvayacareers.in`
   (or add website → "use an existing domain" → anvayacareers.in; **don't transfer**, `.in` can't be transferred and doesn't need to be).
2. Files → **File Manager** → `public_html` → upload `hostinger-site.zip` → **Extract** (it includes a hidden `.htaccess`).
3. Use Hostinger's **preview link** to check the brochure, the payment page and the free-chat form.

## 6. Cron job (Hostinger → Advanced → Cron Jobs, the Single plan allows 2)
Custom command, **every minute** (or every 5 minutes if 1 minute isn't offered):
```
curl -fsS -m 50 -H "Authorization: Bearer YOUR_CRON_SECRET" https://app.anvayacareers.in/api/cron/run > /dev/null
```
This sends queued emails, the 24 h / 2 h session reminders and renewal reminders, and keeps the app warm.

## 7. Switch the main site (only after steps 1–6 pass)
GoDaddy → DNS → change **only** `@` A and `www` CNAME to the values Hostinger shows. **Don't change nameservers.**
Resend (`send`, `resend._domainkey`) and `app` records stay. Wait for Hostinger's SSL, then Claude re-tests.

## Rollback
* Main site: `@` A → `216.198.79.1`, `www` CNAME → `af7e970bcbafc984.vercel-dns-017.com` (Vercel, recorded 20 Oct 2026).
* Dashboards: Vercel still serves `/admin`, `/mentor` and `/student` on its own URL; email links would need `APP_BASE_URL` changed back.
Keep the Vercel project until the split setup has run cleanly for 2 weeks.
