'use strict';
// Admin core: overview, settings, team (admin/ops users), system health, reports.
const express = require('express');
const db = require('../../db');
const sec = require('../../security');
const settings = require('../../lib/settings');
const accounts = require('../../lib/accounts');
const jobs = require('../../lib/jobs');
const mailer = require('../../mailer');
const storage = require('../../lib/storage');
const payments = require('../../lib/payments');
const { sendEmail } = require('../../lib/email');
const { HttpError, bad, v, id, wrap } = require('../../lib/http');
const { staff, adminOnly, isAdmin } = require('./_shared');

const r = express.Router();
const n = async (sql, p = []) => (await db.one(sql, p)).n;

r.get('/overview', staff, wrap(async (req, res) => {
  const out = {
    role: req.auth.user.role,
    counts: {
      leadsNew: await n("select count(*) n from anvaya.leads where status = 'new'"),
      followupsDue: await n("select count(*) n from anvaya.leads where status not in ('converted','lost') and follow_up_at <= now()"),
      students: await n("select count(*) n from anvaya.students where status = 'active'"),
      activeSubscribers: await n("select count(distinct student_id) n from anvaya.subscriptions where paid_through >= now() or grace_until >= now()"),
      mentorsActive: await n("select count(*) n from anvaya.mentors where status = 'active'"),
      mentorsPending: await n("select count(*) n from anvaya.mentors where status = 'invite_pending'"),
      upcoming: await n("select count(*) n from anvaya.bookings where status in ('scheduled','requested') and scheduled_at >= now()"),
      liveThisWeek: await n("select count(*) n from anvaya.live_sessions where status = 'scheduled' and starts_at between now() and now() + interval '7 days'"),
      studentsNeedingFollowup: await n('select count(*) n from anvaya.students where needs_followup'),
      casesOpen: await n("select count(*) n from anvaya.service_cases where status not in ('delivered','closed','cancelled')"),
      sheetFailures: await n("select count(*) n from anvaya.leads where sheet_sync_status = 'failed'"),
    },
    upcoming: await db.all(`select x.* from (
        select 'booking' as type, b.id, b.scheduled_at as starts_at, b.service as title, s.name as who, m.name as mentor
          from anvaya.bookings b join anvaya.students s on s.id = b.student_id left join anvaya.mentors m on m.id = b.mentor_id
          where b.status in ('scheduled','requested') and b.scheduled_at >= now()
        union all
        select 'live', l.id, l.starts_at, l.title, coalesce(g.name, ''), m.name
          from anvaya.live_sessions l left join anvaya.mentor_groups g on g.id = l.group_id left join anvaya.mentors m on m.id = l.mentor_id
          where l.status = 'scheduled' and l.starts_at >= now()) x order by x.starts_at limit 8`),
    recentLeads: await db.all('select id, name, situation, status, follow_up_at, created_at from anvaya.leads order by id desc limit 6'),
  };
  if (isAdmin(req)) {
    out.revenue = {
      paid: await n("select coalesce(sum(amount_paise),0) n from anvaya.payments where status in ('paid','refunded')"),
      refunded: await n("select coalesce(sum(amount_paise),0) n from anvaya.refunds where status = 'processed'"),
      gatewayCosts: await n('select coalesce(sum(fee_paise + tax_paise),0) n from anvaya.payments'),
      mentorPayable: await n('select coalesce(sum(amount_paise),0) n from anvaya.mentor_ledger'),
    };
  }
  res.json(out);
}));

// ── Settings ─────────────────────────────────────────────────────────
r.get('/settings', staff, wrap(async (req, res) => {
  const all = await settings.all();
  if (!isAdmin(req)) for (const k of settings.FINANCIAL) delete all[k];
  res.json(all);
}));
r.put('/settings', adminOnly, wrap(async (req, res) => {
  const body = req.body || {};
  for (const [k, val] of Object.entries(body)) {
    if (!(k in settings.DEFAULTS)) throw bad(`Unknown setting ${k}.`);
    if (k === 'calendar_host_user_id') {
      const uid = val === '' || val == null ? null : Number(val);
      if (uid !== null && !await db.one("select 1 from anvaya.users where id = $1 and role in ('admin','ops') and disabled_at is null", [uid])) throw bad('Choose an active admin or ops user.');
      await settings.set(k, uid, req.auth.user.id); continue;
    }
    if (k === 'renewal_reminder_days') {
      if (!Array.isArray(val) || !val.every((x) => Number.isInteger(x) && x >= 0 && x <= 60)) throw bad('Renewal reminder days must be a list of whole numbers.');
    } else if (!Number.isInteger(Number(val)) || Number(val) < 0) throw bad(`${k} must be a whole number.`);
    await settings.set(k, k === 'renewal_reminder_days' ? val : Number(val), req.auth.user.id);
  }
  db.audit(req.auth.user.id, 'settings_updated', Object.keys(body).join(','));
  res.json(await settings.all());
}));

// ── Team (admin + ops accounts) ──────────────────────────────────────
r.get('/team', adminOnly, wrap(async (_req, res) => {
  res.json(await db.all(`select id, email, name, role, (password_hash is not null) as has_password, disabled_at, last_login_at, created_at
    from anvaya.users where role in ('admin','ops') order by role, email`));
}));
r.post('/team', adminOnly, wrap(async (req, res) => {
  const email = v.email(req.body?.email);
  const name = v.str(req.body?.name, { max: 120, required: true, label: 'Name' });
  const role = v.oneOf(req.body?.role || 'ops', ['ops', 'admin'], 'Role');
  if (await db.one('select 1 from anvaya.users where lower(email) = $1', [email])) throw new HttpError(409, 'An account with this email already exists.');
  const u = await db.one('insert into anvaya.users (email, name, role) values ($1,$2,$3) returning id', [email, name, role]);
  const out = await accounts.issue(u.id, 'staff_invite', { byUserId: req.auth.user.id });
  db.audit(req.auth.user.id, 'staff_created', `user:${u.id} role:${role}`);
  res.status(201).json({ id: u.id, delivered: out.delivered, mailError: out.error });
}));
r.post('/team/:id/resend', adminOnly, wrap(async (req, res) => {
  const u = await db.one("select * from anvaya.users where id = $1 and role in ('admin','ops')", [id(req)]);
  if (!u) throw new HttpError(404, 'Not found.');
  const out = await accounts.issue(u.id, u.password_hash ? 'password_reset' : 'staff_invite', { isResend: true, byUserId: req.auth.user.id });
  res.json({ ok: true, delivered: out.delivered, mailError: out.error });
}));
r.post('/team/:id/disable', adminOnly, wrap(async (req, res) => {
  const uid = id(req);
  if (uid === req.auth.user.id) throw bad('You can’t disable your own account.');
  const u = await db.one("update anvaya.users set disabled_at = now() where id = $1 and role in ('admin','ops') returning id", [uid]);
  if (!u) throw new HttpError(404, 'Not found.');
  await sec.revokeAllSessions(uid);
  db.audit(req.auth.user.id, 'staff_disabled', `user:${uid}`);
  res.json({ ok: true });
}));
r.post('/team/:id/enable', adminOnly, wrap(async (req, res) => {
  await db.run("update anvaya.users set disabled_at = null where id = $1 and role in ('admin','ops')", [id(req)]);
  res.json({ ok: true });
}));

// ── System health (admin) ────────────────────────────────────────────
r.get('/system', adminOnly, wrap(async (_req, res) => {
  let domains = null, domainError = null;
  try { domains = await mailer.resendDomains(); } catch (e) { domainError = e.message; }
  res.json({
    mail: { mode: mailer.mailMode(), from: mailer.from(), domains, domainError },
    storage: { mode: storage.mode(), bucket: storage.BUCKET },
    payments: { configured: payments.configured(), webhookSecret: !!process.env.RAZORPAY_WEBHOOK_SECRET },
    sheet: { configured: !!process.env.GOOGLE_SHEET_WEBHOOK_URL, failed: await n("select count(*) n from anvaya.leads where sheet_sync_status = 'failed'"), pending: await n("select count(*) n from anvaya.leads where sheet_sync_status = 'pending'") },
    cron: { secret: !!process.env.CRON_SECRET },
    jobs: await db.all(`select kind, status, count(*) n, max(last_error) as last_error from anvaya.jobs
      where created_at > now() - interval '14 days' group by kind, status order by kind, status`),
    failedJobs: await db.all(`select id, kind, status, attempts, last_error, run_at, created_at from anvaya.jobs
      where status in ('failed','dead') order by created_at desc limit 25`),
    webhooks: await db.all(`select id, provider, event_type, status, signature_valid, error, received_at from anvaya.webhook_events order by id desc limit 15`),
  });
}));
r.post('/system/jobs/:id/retry', adminOnly, wrap(async (req, res) => {
  await db.run("update anvaya.jobs set status = 'queued', run_at = now(), max_attempts = greatest(max_attempts, attempts + 3) where id = $1 and status in ('failed','dead')", [id(req)]);
  const out = await jobs.runNow(id(req));
  res.json(out);
}));
r.post('/system/email-domain', adminOnly, wrap(async (_req, res) => {
  const from = mailer.from();
  const domain = (from.match(/@([^>\s]+)/) || [])[1];
  if (!domain) throw bad('MAIL_FROM must contain an email address on your domain.');
  res.json(await mailer.resendSetupDomain(domain));
}));
r.post('/system/run-jobs', adminOnly, wrap(async (_req, res) => {
  await require('../../lib/maintenance').schedulePeriodic(); // same as the cron: reminders, renewals, holds, reconciliation
  res.json(await jobs.processDue({ limit: 40 }));
}));
/** Deletes ONLY records flagged is_test (and everything that hangs off them). Requires an explicit confirmation phrase. */
r.post('/test-data/purge', adminOnly, wrap(async (req, res) => {
  if (req.body?.confirm !== 'DELETE TEST DATA') throw bad('Type DELETE TEST DATA to confirm.');
  let paths = [];
  const out = await db.tx(async (t) => {
    const n = {};
    paths = (await t.all(`select v.storage_path from anvaya.document_versions v join anvaya.documents d on d.id = v.document_id
      where v.storage_path is not null and d.student_id in (select id from anvaya.students where is_test)`)).map((x) => x.storage_path);
    const del = async (k, sql, p = []) => { n[k] = (await t.run(sql, p)).rowCount; };
    const TS = 'select id from anvaya.students where is_test';
    const TM = 'select id from anvaya.mentors where is_test';
    await del('refunds', `delete from anvaya.refunds where payment_id in (select id from anvaya.payments where student_id in (${TS}))`);
    await del('payments', `delete from anvaya.payments where student_id in (${TS})`);
    await del('subscriptions', `delete from anvaya.subscriptions where student_id in (${TS}) or product_id in (select id from anvaya.products where is_test)`);
    await del('mentor_ledger', `delete from anvaya.mentor_ledger where mentor_id in (${TM}) or booking_id in (select id from anvaya.bookings where student_id in (${TS}))`);
    await del('payouts', `delete from anvaya.payouts where mentor_id in (${TM})`);
    await del('bookings', `delete from anvaya.bookings where student_id in (${TS}) or mentor_id in (${TM})`);
    await del('service_cases', `delete from anvaya.service_cases where student_id in (${TS})`);
    await del('orders', `delete from anvaya.orders where student_id in (${TS})`);
    await del('live_sessions', 'delete from anvaya.live_sessions where is_test');
    await del('groups', 'delete from anvaya.mentor_groups where is_test');
    const studentUsers = (await t.all(`select user_id from anvaya.students where is_test and user_id is not null`)).map((x) => x.user_id);
    await del('students', 'delete from anvaya.students where is_test');
    const mentorUsers = (await t.all('select user_id from anvaya.mentors where is_test')).map((x) => x.user_id);
    await del('mentor_users', 'delete from anvaya.users where id = any($1::bigint[])', [mentorUsers]); // cascades mentor, availability, invitations, sessions
    await del('student_users', "delete from anvaya.users where id = any($1::bigint[]) and role = 'student'", [studentUsers]);
    await del('products', 'delete from anvaya.products where is_test');
    await del('tracks', 'delete from anvaya.tracks where is_test');
    await del('cohorts', 'delete from anvaya.cohorts where is_test');
    await del('colleges', 'delete from anvaya.colleges where is_test');
    await del('leads', 'delete from anvaya.leads where is_test');
    return n;
  });
  // Storage objects go after the rows commit, so a storage failure never leaves rows pointing at deleted files.
  try { out.storage_objects = await storage.remove(paths); } catch (e) { out.storage_error = e.message; }
  db.audit(req.auth.user.id, 'test_data_purged', JSON.stringify(out));
  res.json({ ok: true, deleted: out });
}));

/** Audit trail (admin): who did what, when. */
r.get('/audit', adminOnly, wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(await db.all(`select a.id, a.action, a.detail, a.created_at, coalesce(nullif(u.name,''), u.email) as user_name, u.role
    from anvaya.audit_log a left join anvaya.users u on u.id = a.user_id order by a.id desc limit $1`, [limit]));
}));
r.post('/system/test-email', adminOnly, wrap(async (req, res) => {
  const to = v.email(req.body?.to || req.auth.user.email);
  const out = await sendEmail(to, 'test', { from: mailer.from() });
  if (!out.delivered) throw new HttpError(502, `Email failed: ${out.error}`);
  res.json({ ok: true, to });
}));

// Local development only: read emails captured by MAIL_TRANSPORT=memory (never available in production).
r.get('/dev/outbox', adminOnly, (req, res) => {
  if (process.env.NODE_ENV === 'production' || mailer.mailMode() !== 'memory') return res.status(404).json({ error: 'Not found.' });
  res.json(mailer.sent.slice(-30).reverse().map((m) => ({ to: m.to, subject: m.subject, text: m.text, sentAt: m.sentAt })));
});

// ── Reports ──────────────────────────────────────────────────────────
r.get('/reports', staff, wrap(async (req, res) => {
  const engagement = {
    attendance30d: await db.one(`select count(*) filter (where status in ('present','late')) as attended, count(*) as marked
      from anvaya.attendance where marked_at > now() - interval '30 days'`),
    assignmentsDone30d: await n("select count(*) n from anvaya.assignment_progress where status in ('submitted','reviewed','done') and updated_at > now() - interval '30 days'"),
    activeLearners30d: await n("select count(distinct student_id) n from anvaya.assignment_progress where updated_at > now() - interval '30 days'"),
    feedbackAvg: await db.one("select round(avg(rating)::numeric, 2) as avg, count(*) as n from anvaya.feedback where created_at > now() - interval '90 days'"),
  };
  const outcomes = await db.all("select stage, count(*) n, count(distinct student_id) students from anvaya.applications group by stage order by stage");
  const out = { engagement, outcomes };
  if (isAdmin(req)) {
    out.renewals = {
      dueIn14d: await n("select count(*) n from anvaya.subscriptions where paid_through between now() and now() + interval '14 days' and not cancel_at_period_end"),
      inGrace: await n("select count(*) n from anvaya.subscriptions where paid_through < now() and grace_until >= now()"),
      expired30d: await n("select count(*) n from anvaya.subscriptions where grace_until between now() - interval '30 days' and now()"),
      renewedLast90d: await n("select count(*) n from anvaya.orders o join anvaya.products p on p.id = o.product_id where p.kind = 'subscription_plan' and o.status = 'paid' and o.paid_at > now() - interval '90 days' and exists (select 1 from anvaya.orders o2 where o2.student_id = o.student_id and o2.product_id = o.product_id and o2.status = 'paid' and o2.paid_at < o.paid_at)"),
    };
    out.revenueByMonth = await db.all(`select to_char(date_trunc('month', paid_at at time zone 'Asia/Kolkata'), 'YYYY-MM') as month,
      sum(amount_paise) as gross_paise, sum(fee_paise + tax_paise) as gateway_paise, count(*) as payments
      from anvaya.payments where status in ('paid','refunded') and paid_at is not null group by 1 order by 1 desc limit 12`);
  }
  res.json(out);
}));

module.exports = r;
