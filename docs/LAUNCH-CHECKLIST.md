# Anvaya launch checklist — verified state (20 Oct 2026)

Hosting today: **Vercel** (project `anvaya`) → https://anvayacareers.in. Database and files: **Supabase**. Email: **Resend**.
The site stays on Vercel until a Hostinger copy has passed the same checks below.

## 1. Live and verified in production
| Area | What was checked |
|---|---|
| Brochure site | Supplied page served unchanged (hash-checked) on anvayacareers.in |
| Free-chat form | Brochure → API → Supabase CRM → Google Sheet ("Untitled spreadsheet", tab *Free Chat Requests*). Numbers starting with "+" arrive blank in the sheet |
| Admin dashboard | Login, CRM, mentors, students, orders, payments, subscriptions, audit trail |
| Email | Resend, domain verified, sent from `Anvaya <connect@anvayacareers.in>`, Reply-To your Gmail. Invitation links last 72 h |
| Mentor journey | Real-email invite → expired/revoked/reused links rejected → accept → onboarding → dashboard; blocked from admin and other records |
| Student journey | Invite → password → login; private resume upload; syllabus, group, sessions |
| Manual payment → subscription | Admin records payment → subscription active → audit entries |
| Plan entitlements | Check-up limit (2 / month) enforced; double booking refused; booked slots removed |
| Expiry / grace / renewal / cancel | All behave correctly; access locks and unlocks |
| Student isolation | No access to admin, mentor or other students' bookings and files |
| Test-data purge | Synthetic rows removed; only the admin account remains |

## 2. Built and tested locally only (30 automated tests), not yet exercised in production
- Razorpay checkout from the dashboard, signature check, webhook, reconciliation, refunds (no keys configured, so it's off in production)
- Paid mentor sessions → mentor ledger → manual payouts
- Resume-service cases: coach draft → QA → admin approval → delivery
- Ops role permissions, password reset, B2B cohorts / colleges
- Renewal reminder and session reminder emails (24 h and 2 h before)

## 3. Committed, not deployed
- `cfd8669` purge also deletes synthetic files from storage
- `46cffe7` AI drafting removed (code, UI, settings, dependency; migration `0004` drops its settings)

## 4. Incomplete — launch blockers
1. **Automatic payment verification.** Needs Razorpay key ID, key secret and webhook secret, entered in the host's environment settings (never in chat). Until then, every dashboard payment is entered by hand.
2. **Standalone payment page** (`/anvaya-payment.html`): pays Razorpay directly from the browser. No server order or signature check, nothing saved to Supabase, and so no automatic subscription. Must be switched to the server checkout.
3. **Payment records in Google Sheets: not syncing.** The tracker tab *📋 Bookings* in `anvaya-booking-tracker` has 0 rows. Dashboard payments have no sheet sync.
4. **Timely reminders.** A scheduler must run every 5 minutes. Vercel Hobby allows only daily runs (Vercel Pro or a Hostinger cron job fixes this).
5. **Real plans and prices.** None are configured yet (Admin → Plans).
6. **Commercial hosting.** Vercel Hobby isn't for commercial use. Either upgrade to Pro or finish the Hostinger move.
7. **Backups.** Supabase Free has no backups and pauses after 7 idle days.
8. **GitHub repository.** Not created.
9. **Hostinger.** Not started.
