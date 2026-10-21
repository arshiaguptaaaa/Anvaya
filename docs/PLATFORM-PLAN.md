# Anvaya platform upgrade: reference mapping and build plan (draft for approval)

Previews (DEMO DATA, not deployed): `docs/preview/admin-workspace.html`, `docs/preview/student-home.html`
(screenshots in `docs/preview/shots/`). Public brochure untouched.

## 1. What the references contribute (public pages only)
| Reference (public page) | Pattern worth adapting | Where it lands in Anvaya |
|---|---|---|
| MentorUnion home | Browse by domain/expertise; mentor card = photo, current role, years, skill tags; booking/reschedule policy written as plain Q&A | Mentor discovery filters + cards; booking policy text beside reschedule/cancel |
| Topmate (homepage) | Each service is its own card (format, duration, price); date strip → time slot → one "Confirm and pay"; confirmation with call link; reminders day-before + shortly-before | Mentor services list; booking flow service → slot → intake questions → payment → confirmation |
| Amber Student home | Few guided steps with a clear "booked" state; visible support channels | Student milestone tracker; booking status chips; Support card with response history |
| Zendesk agent-workspace page | Queues/views, one record with full history, customer context panel, macros, workload-aware assignment, unattended-item alerts | Admin workspace: left queues, centre timeline + composer, right context; health flags |
Not inspected: any private dashboard. Nothing copied: no testimonials, names, statistics, photos or branding.

## 2. Requirement → current state → work
Legend: ✅ exists today · 🟡 partial · ⬜ new

**Admin CRM**
- Leads with activities, convert to student ✅ · owner, stage pipeline, next action + due date 🟡 (follow_up_at exists; owner/stage/due need columns) · saved views, search, pagination, bulk assign ⬜
- Unified student record: profile, subscription, entitlements, payments, bookings, files ✅ (spread across pages) → single 3-pane workspace ⬜
- Tasks with owner/due/status ⬜ · Queues (My tasks, Unassigned, Follow-ups due, Awaiting student/mentor, Payment exceptions, Renewals) ⬜
- Support cases with internal notes vs student-visible messages and real delivery status ⬜ (WhatsApp: no integration → shown as "portal only")
- Ops/intern restrictions ✅ (money, settings, sensitive notes, account admin already blocked); extend to new screens

**Student**
- Next-action card, milestone tracker (intake ✅ · assessment ⬜ · group ✅ · training ✅ · check-up ✅ · progress review ⬜), payment shown separately
- Upcoming sessions with join ✅ / cancel ✅ / reschedule ⬜
- Subscription validity + remaining included bookings ✅ (API) → home cards ⬜
- Syllabus, assignments ✅ · resources/feedback 🟡
- Mentor discovery filters (expertise, target role, price, availability) 🟡 · profiles with approved photos ⬜ · multiple services per mentor ⬜ · intake questions in booking ⬜
- Support requests with status/history ⬜

**Mentor**
- Agenda, bookings, availability ✅ · booking buffers ⬜ · assigned students + prep context 🟡 · group sessions/attendance ✅ · follow-up actions ⬜
- Session notes with visibility control (private / shared with student / staff) ⬜
- Services & profile within admin approval ⬜ · earnings, adjustments, payable balance, payouts ✅ (zero commission kept; processing costs tracked separately ✅)

**Automation**
- Verified payment → order updated → access activated ✅ (code + tests, Razorpay not configured in production) · confirmation email + onboarding start on payment ⬜
- Reminders 24 h / 2 h ✅ (job) · independent of visits: Cloud Scheduler created but not firing → fix or Hostinger cron ⬜
- Cancel stale reminders when sessions change ⬜ (today a moved session can miss its new reminder)
- Flags: incomplete onboarding 🟡, missed sessions ⬜, overdue follow-ups ✅, failed jobs ✅ · retries + duplicate protection ✅

## 3. Build order (after approval)
1. Data: owners/stages/due dates on leads+students, tasks, support cases + messages (visibility + delivery status), mentor services, mentor photos (approval), session notes visibility, booking buffers, reschedule history. One additive migration; nothing dropped.
2. Admin: Today, Leads (pipeline + table, filters, saved views, pagination, bulk assign), Students table, unified student workspace.
3. Student home; then mentor discovery, profile, booking flow.
4. Mentor operations (agenda, buffers, notes visibility, services/profile requests, earnings).
5. Automation: payment confirmation + onboarding, stale-reminder cancellation, missed-session flags, scheduler fix.
6. Tests (permissions, desktop + mobile layouts), deploy to Cloud Run with merge-only settings, then the real payment-to-access journey in Razorpay **test mode**.

## 4. Blocked / needs a decision
- Razorpay test-mode keys + webhook secret (entered privately) to prove payment → access in production.
- Reminder scheduler not firing on Google's side; fallback is Hostinger cron (you paste the cron secret into hPanel).
- Mentor service prices and plan prices: not decided; screens show real values only.
- Mentor photos: need real, approved photos; until then initials.
- WhatsApp sending: no integration; messages are portal + email (Resend) only.
- `anvaya-payment.html` stays byte-for-byte unchanged unless you approve switching it to the server checkout.
