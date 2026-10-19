# Production setup — exact steps

Live: **https://anvayacareers.in** (Vercel project `anvaya`; `www` → apex 308). DNS is at **GoDaddy**.
Never paste keys or passwords into chat. Enter each value in **Vercel → anvaya → Settings → Environment Variables**,
environment **Production** only (so preview deployments can never touch production data), then **Deployments → ⋯ → Redeploy**.

Already set by Claude: `APP_BASE_URL`, `APP_SECRET`, `CRON_SECRET`, `NODE_ENV`, `INVITE_TTL_HOURS`, `ADMIN_EMAIL`,
`ADMIN_PASSWORD`, `GOOGLE_SHEET_WEBHOOK_URL`, `MAIL_FROM`, `MAIL_REPLY_TO`, `EXTRA_ORIGINS`.

## 1. Supabase (database + private files) — blocks everything else
1. supabase.com/dashboard → **New project** → region **Mumbai (ap-south-1)** → plan **Pro** (daily backups, no auto-pause).
2. Copy these into Vercel:

| Variable | Where in Supabase |
| --- | --- |
| `DATABASE_URL` | Project → **Connect** → *Transaction pooler* (port **6543**) URI, with your DB password |
| `DATABASE_MIGRATION_URL` | Project → **Connect** → *Session pooler* (port **5432**) URI |
| `SUPABASE_URL` | Project Settings → **Data API** → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → **API Keys** → `service_role` secret |

3. Redeploy. The build runs `supabase/migrations/*.sql` automatically (production builds only) and creates the private bucket on first upload.
4. Sign in at https://anvayacareers.in/admin/login with `ADMIN_EMAIL` and the password in `anvaya/.admin-credentials` (local file, not in Git). Change it with **Change password** (bottom of the sidebar), then delete that file.

*Optional hardening (recommended before real students):* in Supabase **SQL editor** run
`alter role anvaya_app with login password '<a long random password>';` then change `DATABASE_URL` to use user
`anvaya_app.<project-ref>` with that password. The app then runs without table ownership and without BYPASSRLS.

*Alternative:* Vercel → anvaya → **Storage → Create → Supabase** provisions a project and sets `POSTGRES_URL`,
`POSTGRES_URL_NON_POOLING`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` automatically (the app accepts these names).

## 2. Branded email (Resend, sender `hello@anvayacareers.in`)
1. resend.com → API Keys → create a **Sending access** key → Vercel `RESEND_API_KEY` → redeploy.
2. https://anvayacareers.in/admin → **System** → **Set up / verify email domain**. This registers `anvayacareers.in` in Resend (region Tokyo, closest to India) and shows the exact records.
3. GoDaddy → My Products → anvayacareers.in → **DNS** → Add each record shown. They will look like this — copy the DKIM value exactly from the System page:

| Type | Name (GoDaddy “Name”) | Value | Priority |
| --- | --- | --- | --- |
| MX | `send` | `feedback-smtp.ap-northeast-1.amazonses.com` | 10 |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | — |
| TXT | `resend._domainkey` | `p=MIGfMA0…` *(unique to your domain — from the System page)* | — |
| TXT | `_dmarc` | `v=DMARC1; p=none;` | — |

   Don’t change the existing `A @` (Vercel) or `www` records.
4. Press **Set up / verify email domain** again until it shows *verified*, then **Send test email**.
5. Replies go to `MAIL_REPLY_TO` (`hello@anvayacareers.in`). That address needs a mailbox or forwarding (Zoho Mail free plan or GoDaddy forwarding), or change `MAIL_REPLY_TO` to an inbox you read.

## 3. Payments (Razorpay)
Razorpay Dashboard (complete KYC) → **Account & Settings → API Keys** → generate:
`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`. Then **Webhooks → Add**: URL `https://anvayacareers.in/api/webhooks/razorpay`,
events `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, choose a secret → `RAZORPAY_WEBHOOK_SECRET`.
Test with Test-mode keys first (`rzp_test_…`), then swap to Live keys. Until configured, students’ purchases become
“awaiting payment” requests and you record UPI/bank payments in **Payments → Record payment**.

## 4. AI drafting (later; capped)
console.anthropic.com → API keys → `ANTHROPIC_API_KEY`, plus `AI_PROVIDER=anthropic` (optional `AI_MODEL`, default
`claude-opus-5-5`). Monthly cap and run limit live in **Admin → Settings**.

## 5. GitHub + Vercel plan
* Create an **empty private** repo `arshiaguptaaaa/anvaya` (github.com/new — no README). Claude pushes over SSH and connects it to Vercel.
* Vercel → Settings → **Billing → Upgrade to Pro** (Hobby is non-commercial and allows only a daily cron). After upgrading,
  change `vercel.json` cron to `*/5 * * * *` so reminders and payment reconciliation run every 5 minutes (today: once a day,
  plus after every API request).

## 6. Backups
Supabase Pro keeps 7 days of daily database backups but **not files**. Weekly, on a trusted machine with the Supabase
variables in `.env`: `npm run backup` → copy `backups/<date>` to private storage → `npm run backup:verify backups/<date>`
(restores into a throwaway Postgres and checks every table count and file checksum).
