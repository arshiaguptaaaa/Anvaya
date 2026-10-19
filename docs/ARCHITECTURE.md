# Anvaya platform — architecture, audit, schema plan, costs

## 1. Architecture

```
                         anvayacareers.in  (Vercel, GoDaddy DNS → Vercel)
                                   │
        ┌──────────────────────────┼─────────────────────────────────────┐
        │  Vercel CDN (static)     │  Vercel Function: api/index.js       │
        │  /            brochure   │  Express app (src/)                  │
        │  /app/*.js|css dashboards│   /api/auth   sessions, CSRF, reset  │
        │  /assets      logo       │   /api/admin  CRM (admin + ops role) │
        └──────────────────────────┤   /api/mentor own-records only       │
                                   │   /api/student own-records only      │
                                   │   /api/public lead intake            │
                                   │   /api/webhooks/razorpay (HMAC)      │
                                   │   /api/cron  job worker (CRON_SECRET)│
                                   └───────┬───────────┬──────────┬───────┘
                                           │           │          │
             Supabase (one project)        │           │          │      External (managed)
   ┌───────────────────────────────────────▼──┐  ┌─────▼──────┐   │   ┌─────────────────────────┐
   │ Postgres, schema "anvaya" (source of     │  │ Storage    │   ├──►│ Resend  (email, domain) │
   │ truth): users/roles, CRM, plans, orders, │  │ private    │   ├──►│ Razorpay (orders,       │
   │ subscriptions, tracks, groups, sessions, │  │ buckets,   │   │   │  webhooks, refunds)     │
   │ bookings (no-overlap constraint), cases, │  │ 60-second  │   ├──►│ AI provider (capped)    │
   │ documents, playbook, ai_runs, ledger,    │  │ signed URLs│   ├──►│ Google Sheet (secondary │
   │ payouts, webhook_events, jobs, audit     │  └────────────┘   │   │  lead copy, tracked)    │
   │ RLS on; app role has no BYPASSRLS        │                   │   │ Google Meet / WhatsApp  │
   └──────────────────────────────────────────┘                   │   │  (links only)           │
                                                                  └──►└─────────────────────────┘
   Durable job queue = anvaya.jobs table, drained after each request (waitUntil) and by Vercel Cron.
```

One deployable app, one database, one storage provider, no separate servers.
Connections:
- **Runtime:** `DATABASE_URL` points at the Supavisor transaction pooler (port 6543), connecting as the least-privilege role `anvaya_app`. The `pg` client sends unnamed statements only. It never uses named prepared statements, which transaction pooling can't support, and it attaches the pool to Vercel Fluid compute.
- **Migrations:** `DATABASE_MIGRATION_URL` uses the session pooler (port 5432) as `postgres`. Migrations run during `vercel-build`.

## 2. Audit of commit 8844b97

| Area | State |
| --- | --- |
| Public brochure | Served from CDN. It's the original file plus one `lead-capture.js` tag, and a test proves the rest is identical. |
| Auth | scrypt passwords, DB sessions (hashed tokens), CSRF header, rate limits stored in Postgres. **Missing:** password reset, ops/student/coordinator roles. |
| Mentor invitations | Complete: expiring, single-use, resend revokes old links, fresh link on expiry, deactivate/reactivate. |
| Admin CRM | Leads, students, mentors, bookings and payments, all basic CRUD. **Missing:** lead owner, next action, follow-up dates, activities, groups, cohorts, plans, subscriptions, syllabus, calendar, attendance, refunds, payouts. |
| Mentor dashboard | Sessions, notes, mark completed, students, earnings, availability, profile. Earnings come from bookings; there's no ledger. |
| Student dashboard | **None.** |
| Payments | Recorded by hand only. No gateway, webhooks or refunds. |
| Files | **None** (no storage). |
| Jobs and email | Sent inline (Resend/SMTP). There's no queue, no retries and no reminders. |
| Money | Stored in **whole rupees.** It needs to move to integer paise. |
| Double booking | **Not prevented.** |
| Google Sheet | The browser posts to it directly. If that post fails, nobody can tell. |
| Production | Vercel project `anvaya` is live on *.vercel.app. **DATABASE_URL isn't set**, so the dashboards return 503. Only `APP_BASE_URL` is set. |
| Domain | anvayacareers.in is attached to the **clockwise** project. DNS is at GoDaddy. |
| Tests | 21 passing on PGlite (in-process Postgres). |

## 3. Schema changes (incremental migrations)

`0002_platform.sql` covers everything below. Additive only, except converting money to paise.

- **Users and roles:** role ∈ admin, ops, mentor, student, coordinator. `students.user_id` links a student to a portal account. Intake fields: target role, level, availability, track and LinkedIn. Invitations generalized with `kind` (mentor_invite, student_invite, password_reset) and `user_id`.
- **Leads:** owner, next_action, follow_up_at, sheet_sync_status and sheet_sync_error. New `lead_activities` table.
- **Catalogue:** `products` (subscription plans, mentor sessions, resume and LinkedIn rewrites, coaching packages, digital products), each with a price in paise and a billing period. `plan_entitlements` (key, limit, per-period). `settings` for configurable defaults.
- **Commerce:** `orders`, payments (now in paise, with gateway fee and tax as an Anvaya expense), `refunds`, `webhook_events` (unique per provider and event). `subscriptions` track access_status separately from billing_status, with paid_through, grace_until, cancellation and reminder fields.
- **B2B:** `colleges`, `college_coordinators`, `cohorts`, `cohort_members`.
- **Learning:** `tracks`, `modules`, `assignments`, `enrollments`, `assignment_progress`.
- **Groups:** `mentor_groups` (capacity, Meet and WhatsApp links), `group_members` (with a manual override flag).
- **Sessions:** `live_sessions` (class, group room, check-up), `attendance`. Bookings gain kind (paid_session or checkup), order_id, ends_at, a pending_payment hold, and a **GiST exclusion constraint** that stops a mentor's live bookings from overlapping.
- **Services:** `service_cases` (intake → assigned → draft → coach edit → QA → delivered → revision → closed), `case_events`, `documents`, `document_versions`, `qa_reviews`, `playbook_versions`, `ai_runs`.
- **Outcomes:** `applications` (applied, shortlisted, interview, offer…), `feedback`.
- **Mentor money:** `mentor_ledger` (session earnings, delivery fees, refund adjustments, payouts) and `payouts`.
- **Operations:** `jobs` (durable queue with dedupe, retries and backoff) plus the existing `audit_log`.

## 4. Cost estimate (pilot, Oct 2026, about ₹88/USD; confirm on vendor pricing pages)

| Item | Plan | Monthly |
| --- | --- | --- |
| Vercel | **Pro** ($20). Hobby is personal/non-commercial and allows only daily cron. Your team is on Hobby today. | ≈ ₹1,760 |
| Supabase | **Pro** ($25). Free projects pause after 7 idle days and have no backups. Pro includes daily backups (7 days) and 100 GB storage. | ≈ ₹2,200 |
| Resend | Free: 3,000 emails/month, 100/day, 1 domain. Pro ($20) only if you exceed 100/day. | ₹0 |
| Razorpay | No fixed fee. About 2% + 18% GST per transaction, recorded per payment as Anvaya's expense. | variable |
| AI drafting | Hard monthly cap in settings (default ₹700). | ≤ ₹700 |
| Meet, WhatsApp, domain | Already owned or free | ₹0 |
| **Total** | | **≈ ₹3,960 fixed + ≤ ₹700 AI ≈ ₹4,660** |

If the 18% GST is charged on top of the Vercel and Supabase invoices, the fixed cost rises to about ₹4,670, or about ₹5,370 with AI. Lowering the AI cap to ₹300 keeps it under ₹5,000. The Pro upgrades are the only increases, and they're needed for commercial use, backups and reliable reminders.
