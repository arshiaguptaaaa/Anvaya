'use strict';
require('./paysheet'); // registers the payment-sheet jobs
const enquiries = require('./enquiries');
// Scheduled maintenance jobs (run by Vercel Cron via /api/cron/run, and safe to run any number of times).
const db = require('../db');
const jobs = require('./jobs');
const settings = require('./settings');
const bookingsLib = require('./bookings');
const { sendEmail } = require('./email');

const BASE_URL = () => (process.env.APP_BASE_URL || '').replace(/\/$/, '');

/** Moves subscriptions through active → grace → expired / cancelled and sends renewal reminders. */
jobs.register('subscriptions.daily', async () => {
  await db.run(`update anvaya.subscriptions set access_status = 'cancelled', cancelled_at = coalesce(cancelled_at, paid_through), updated_at = now()
    where cancel_at_period_end and paid_through < now() and access_status in ('active','grace')`);
  await db.run(`update anvaya.subscriptions set access_status = 'grace', billing_status = case when billing_status = 'paid' then 'due' else billing_status end, updated_at = now()
    where access_status = 'active' and paid_through < now() and grace_until >= now()`);
  await db.run(`update anvaya.subscriptions set access_status = 'expired', billing_status = case when billing_status in ('paid','due') then 'overdue' else billing_status end, updated_at = now()
    where access_status in ('active','grace') and paid_through < now() and (grace_until is null or grace_until < now())`);
  const days = (await settings.get('renewal_reminder_days')).map(Number).sort((a, b) => b - a);
  let sent = 0;
  for (const d of [...days, 0]) {
    const due = await db.all(`select x.*, s.email, p.name as plan_name from anvaya.subscriptions x join anvaya.students s on s.id = x.student_id
      join anvaya.products p on p.id = x.product_id
      where not x.cancel_at_period_end and x.access_status in ('active','grace') and s.email <> ''
        and x.paid_through between now() + make_interval(days => $1) - interval '1 day' and now() + make_interval(days => $1)
        and (x.last_reminder_days is null or x.last_reminder_days > $1)`, [d]);
    for (const x of due) {
      await sendEmail(x.email, 'renewal_reminder', { daysLeft: d, planName: x.plan_name, paidThrough: x.paid_through, graceUntil: x.grace_until, dashboardUrl: `${BASE_URL()}/student#plan` },
        { immediate: false, dedupeKey: `renewal:${x.id}:${new Date(x.paid_through).toISOString().slice(0, 10)}:${d}` });
      await db.run('update anvaya.subscriptions set last_reminder_days = $2 where id = $1', [x.id, d]);
      sent++;
    }
  }
  return { reminders: sent };
});

/** Emails reminders for live sessions and 1:1 bookings starting in the next 24 hours (once each). */
/** Emails two reminders per session: ~24 hours before and ~2 hours before (each once, deduplicated).
 *  Timeliness depends on how often this runs: every 5 minutes on Vercel Pro cron; once a day on Hobby. */
jobs.register('sessions.reminders', async () => {
  let n = 0;
  const { roster } = require('../routes/admin/learning');
  // Windows don't overlap: the 24 h reminder covers 2–24 h ahead, the 2 h reminder 0–2 h, so a session booked
  // at short notice gets one reminder, not two.
  for (const [tag, hours, fromHours] of [['24h', 24, 2], ['2h', 2, 0]]) {
    const bookings = await db.all(`select b.id, b.scheduled_at, b.service, b.meet_link, s.email, s.id as sid, mu.email as mentor_email from anvaya.bookings b join anvaya.students s on s.id = b.student_id
      left join anvaya.mentors m on m.id = b.mentor_id left join anvaya.users mu on mu.id = m.user_id
      where b.status = 'scheduled' and b.scheduled_at > now() + make_interval(hours => $2) and b.scheduled_at <= now() + make_interval(hours => $1) and s.email <> ''`, [hours, fromHours]);
    for (const b of bookings) {
      for (const [to, who] of [[b.email, 'student'], [b.mentor_email, 'host']]) {
        if (!to) continue;
        const r = await jobs.enqueue('email.send', { to, template: 'session_reminder', data: { title: b.service || 'Mentor session', startsAt: b.scheduled_at, meetLink: b.meet_link,
          dashboardUrl: `${BASE_URL()}/${who === 'host' ? 'mentor' : 'student'}#sessions`, __bookingId: b.id } },
        { dedupeKey: `remind:${tag}:booking:${b.id}:${new Date(b.scheduled_at).getTime()}${who === 'host' ? ':host' : ''}` });
        if (r) { n++; await db.run('insert into anvaya.email_log (job_id, to_email, template, booking_id) values ($1,$2,$3,$4) on conflict (job_id) do nothing', [r, to, 'session_reminder', b.id]); }
      }
    }
    const chats = await db.all(`select f.id, f.scheduled_at, f.email, f.meet_link, mu.email as mentor_email from anvaya.freechats f join anvaya.mentors m on m.id = f.mentor_id
      left join anvaya.users mu on mu.id = m.user_id where f.status = 'scheduled' and f.meet_link is not null
      and f.scheduled_at > now() + make_interval(hours => $2) and f.scheduled_at <= now() + make_interval(hours => $1)`, [hours, fromHours]);
    for (const f of chats) {
      for (const [to, who] of [[f.email, 'guest'], [f.mentor_email, 'host']]) {
        if (!to) continue;
        const r = await jobs.enqueue('email.send', { to, template: 'session_reminder', data: { title: 'Free 15-min chat with Anvaya', startsAt: f.scheduled_at, meetLink: f.meet_link,
          dashboardUrl: who === 'host' ? `${BASE_URL()}/admin#calendar` : undefined } }, { dedupeKey: `remind:${tag}:freechat:${f.id}:${new Date(f.scheduled_at).getTime()}:${who}` });
        if (r) { n++; await db.run('insert into anvaya.email_log (job_id, to_email, template) values ($1,$2,$3) on conflict (job_id) do nothing', [r, to, 'session_reminder']); }
      }
    }
    const lives = await db.all(`select * from anvaya.live_sessions where status = 'scheduled' and starts_at > now() + make_interval(hours => $2) and starts_at <= now() + make_interval(hours => $1)`, [hours, fromHours]);
    for (const l of lives) {
      for (const p of (await roster(l)).filter((x) => x.email)) {
        const r = await jobs.enqueue('email.send', { to: p.email, template: 'session_reminder', data: { title: l.title, startsAt: l.starts_at, meetLink: l.meet_link, dashboardUrl: `${BASE_URL()}/student#sessions` } },
          { dedupeKey: `remind:${tag}:live:${l.id}:${new Date(l.starts_at).getTime()}:${p.id}` });
        if (r) n++;
      }
    }
  }
  return { queued: n };
});

jobs.register('bookings.release_holds', async () => ({ released: (await bookingsLib.releaseExpiredHolds()).rowCount }));
jobs.register('maintenance.cleanup', async () => {
  await db.run("delete from anvaya.sessions where expires_at < now()");
  await db.run("delete from anvaya.rate_limits where window_start < now() - interval '1 day'");
  await db.run("delete from anvaya.jobs where status = 'done' and finished_at < now() - interval '30 days'");
});

/** Enqueues the periodic jobs (dedupe per time bucket so overlapping crons don't double up). */
async function schedulePeriodic() {
  const hour = new Date().toISOString().slice(0, 13);
  const day = hour.slice(0, 10);
  await jobs.enqueue('bookings.expire_holds', {}, { dedupeKey: `expire:${hour}:${Math.floor(new Date().getMinutes() / 5)}` });
  await jobs.enqueue('sessions.reminders', {}, { dedupeKey: `reminders:${hour}:${Math.floor(new Date().getMinutes() / 5)}` });
  await jobs.enqueue('payments.reconcile', {}, { dedupeKey: `reconcile:${hour}` });
  await jobs.enqueue('paysheet.resync', {}, { dedupeKey: `paysheet-resync:${hour}` });
  await jobs.enqueue('enquiries.resync', {}, { dedupeKey: `enquiries-resync:${hour}` });
  await enquiries.scheduleDailySummary();
  await jobs.enqueue('subscriptions.daily', {}, { dedupeKey: `subs:${day}` });
  await jobs.enqueue('maintenance.cleanup', {}, { dedupeKey: `cleanup:${day}` });
}

module.exports = { schedulePeriodic };
