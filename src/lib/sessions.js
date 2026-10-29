'use strict';
// 1:1 session lifecycle on top of the booking engine:
//   requested (slot held, awaiting approval) → [awaiting payment] → confirmed (scheduled) → completed / no_show / cancelled
// A confirmation is emailed only after Google Calendar returns a real Meet link; calendar failures are shown to staff
// and retried. Reschedules/cancellations update the same calendar event, notify both parties and cancel stale reminders.
// A confirmed student no-show blocks new bookings/requests until an admin reverses it.
const crypto = require('node:crypto');
const db = require('../db');
const jobs = require('./jobs');
const gcal = require('./gcal');
const ops = require('./ops');
const settings = require('./settings');
const { sendEmail } = require('./email');
const { HttpError } = require('./http');

const BASE = () => (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const urls = {
  student: (hash = 'sessions') => `${BASE()}/student#${hash}`,
  mentor: () => `${BASE()}/mentor#calendar`,
  admin: (hash = 'calendar') => `${BASE()}/admin#${hash}`,
};
const dispMin = (b) => b.duration;

// ── Signed .ics links (work without signing in) ─────────────────────────
const icsSig = (id) => crypto.createHmac('sha256', process.env.APP_SECRET || 'dev-only').update(`ics:${id}`).digest('base64url').slice(0, 32);
const icsUrl = (id) => `${BASE()}/api/public/ics/${id}?sig=${icsSig(id)}`;
const fmtIcs = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const icsEsc = (s) => String(s || '').replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
function buildIcs(b, { cancelled = false } = {}) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Anvaya//Sessions//EN', `METHOD:${cancelled ? 'CANCEL' : 'REQUEST'}`, 'BEGIN:VEVENT',
    `UID:booking-${b.id}@anvayacareers.in`, `SEQUENCE:${b.reschedule_count || 0}`, `DTSTAMP:${fmtIcs(new Date())}`,
    `DTSTART:${fmtIcs(b.scheduled_at)}`, `DTEND:${fmtIcs(b.ends_at)}`, `SUMMARY:${icsEsc(`${b.service} · Anvaya`)}`,
    `DESCRIPTION:${icsEsc(`With ${b.mentor_name}. Join: ${b.meet_link || ''}\nManage: ${urls.student()}`)}`, `LOCATION:${icsEsc(b.meet_link || '')}`,
    'ORGANIZER;CN=Anvaya:mailto:connect@anvayacareers.in', `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}
const gcalUrl = (b) => `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: 'TEMPLATE', text: `${b.service} · Anvaya`,
  dates: `${fmtIcs(b.scheduled_at)}/${fmtIcs(b.ends_at)}`, details: `With ${b.mentor_name}. Join Google Meet: ${b.meet_link || ''}`, location: b.meet_link || '', ctz: 'Asia/Kolkata' })}`;

async function load(id, q = db) {
  return q.one(`select b.*, s.name as student_name, s.email as student_email, s.owner_user_id, m.name as mentor_name, m.user_id as mentor_user_id, mu.email as mentor_email
    from anvaya.bookings b join anvaya.students s on s.id = b.student_id left join anvaya.mentors m on m.id = b.mentor_id
    left join anvaya.users mu on mu.id = m.user_id where b.id = $1`, [id]);
}
const common = (b) => ({ title: b.service || 'Mentor session', startsAt: b.scheduled_at, duration: dispMin(b), mentorName: b.mentor_name || 'your mentor', studentName: b.student_name, __bookingId: b.id });

// ── Booking restriction (no-show) ───────────────────────────────────────
async function assertCanBook(studentId, q = db) {
  const s = await q.one('select booking_blocked_at from anvaya.students where id = $1', [studentId]);
  if (s?.booking_blocked_at) {
    throw new HttpError(403, 'New bookings and session requests are paused on your account after a missed session. You can dispute it from Support, and the Anvaya team will review it.');
  }
}

async function holdUntil(startsAt, q = db) {
  const hours = Number(await settings.get('booking_request_hold_hours', q)) || 24;
  return new Date(Math.min(Date.now() + hours * 3600e3, new Date(startsAt).getTime() - 30 * 60e3));
}

// ── Requests ────────────────────────────────────────────────────────────
async function notifyRequested(bookingId) {
  const b = await load(bookingId);
  if (!b || b.status !== 'requested') return;
  const k = new Date(b.scheduled_at).getTime();
  if (b.student_email) await sendEmail(b.student_email, 'session_requested', { ...common(b), holdUntil: b.hold_expires_at, dashboardUrl: urls.student() }, { immediate: false, dedupeKey: `requested:${b.id}:${k}` });
  if (b.mentor_email) await sendEmail(b.mentor_email, 'session_request_host', { ...common(b), holdUntil: b.hold_expires_at, reviewUrl: urls.mentor() }, { immediate: false, dedupeKey: `request-host:${b.id}:${k}` });
  await ops.createTask({ title: `Review session request: ${b.student_name} · ${b.service}`, studentId: b.student_id, ownerUserId: b.owner_user_id,
    dueAt: b.hold_expires_at, source: 'booking', dedupeKey: `review-request:${b.id}:${k}` });
  await jobs.processDue({ kinds: ['email.send'], limit: 5 }).catch(() => {});
}

/** Host/admin approves a requested booking: confirms it, or asks for payment first for a paid session. */
async function approve(bookingId, user) {
  const payments = require('./payments');
  const out = await db.tx(async (t) => {
    const b = await t.one('select * from anvaya.bookings where id = $1 for update', [bookingId]);
    if (!b) throw new HttpError(404, 'Booking not found.');
    if (b.status !== 'requested') throw new HttpError(400, `This booking is ${b.status.replace('_', ' ')}, not awaiting approval.`);
    const paid = b.order_id && await t.one("select 1 from anvaya.orders where id = $1 and status = 'paid'", [b.order_id]);
    if (b.kind === 'paid_session' && Number(b.price_paise) > 0 && !paid) {
      const hours = Number(await settings.get('booking_payment_hours', t)) || 24;
      const payBy = new Date(Math.min(Date.now() + hours * 3600e3, new Date(b.scheduled_at).getTime() - 2 * 3600e3));
      const order = b.order_id ? await t.one('select * from anvaya.orders where id = $1', [b.order_id])
        : await payments.createOrder({ studentId: b.student_id, product: null, amountPaise: Number(b.price_paise), description: `Private mentor session #${b.id}`, userId: user.id }, t);
      await t.run(`update anvaya.bookings set status = 'pending_payment', hold_expires_at = $2, approved_at = now(), approved_by = $3, order_id = $4 where id = $1`, [b.id, payBy, user.id, order.id]);
      return { next: 'payment', payBy, order };
    }
    await t.run(`update anvaya.bookings set status = 'scheduled', hold_expires_at = null, approved_at = now(), approved_by = $2, calendar_status = 'pending', calendar_error = '' where id = $1`, [b.id, user.id]);
    return { next: 'confirmed' };
  });
  await db.run("update anvaya.tasks set status = 'done', done_at = now(), done_by = $2 where dedupe_key like $1 and status = 'open'", [`review-request:${bookingId}:%`, user.id]);
  if (out.next === 'payment') {
    const b = await load(bookingId);
    const { inr } = require('../mailer');
    if (b.student_email) await sendEmail(b.student_email, 'session_payment_needed', { ...common(b), amount: inr(b.price_paise), payBy: out.payBy, dashboardUrl: urls.student() }, { dedupeKey: `payment-needed:${b.id}` });
  } else {
    await scheduleSync(bookingId, 'confirm');
  }
  db.audit(user.id, 'booking_approved', `booking:${bookingId} → ${out.next}`);
  return out;
}

async function decline(bookingId, user, reason = '') {
  const b = await db.tx(async (t) => {
    const x = await t.one('select * from anvaya.bookings where id = $1 for update', [bookingId]);
    if (!x) throw new HttpError(404, 'Booking not found.');
    if (x.status !== 'requested') throw new HttpError(400, 'Only requests awaiting approval can be declined.');
    await t.run("update anvaya.bookings set status = 'cancelled', cancelled_at = now(), cancel_reason = $2, hold_expires_at = null where id = $1", [x.id, `Declined${reason ? `: ${reason}` : ''}`]);
    await ops.cancelStaleReminders({ bookingId: x.id }, t);
    return x;
  });
  const full = await load(bookingId);
  if (full.student_email) await sendEmail(full.student_email, 'session_declined', { ...common(full), reason, dashboardUrl: urls.student() }, { dedupeKey: `declined:${b.id}` });
  await ops.systemEvent(b.student_id, `Session request “${b.service}” declined${reason ? `: ${reason}` : ''}.`);
  db.audit(user.id, 'booking_declined', `booking:${bookingId}`);
}

/** Host suggests another time: the booking moves to the new slot (old one released) and waits for the student. */
async function suggest(bookingId, user, startsAt) {
  const bookings = require('./bookings');
  const b0 = await db.one('select * from anvaya.bookings where id = $1', [bookingId]);
  if (!b0) throw new HttpError(404, 'Booking not found.');
  if (b0.status !== 'requested') throw new HttpError(400, 'You can suggest a new time only for a request awaiting approval.');
  const moved = await bookings.reschedule({ bookingId, startsAt, byUserId: user.id });
  await db.run('update anvaya.bookings set proposed_at = scheduled_at, proposed_by = $2, hold_expires_at = $3 where id = $1', [bookingId, user.id, await holdUntil(moved.scheduled_at)]);
  const b = await load(bookingId);
  if (b.student_email) await sendEmail(b.student_email, 'session_proposed', { ...common(b), previousAt: moved.previous_at, dashboardUrl: urls.student() }, { dedupeKey: `proposed:${b.id}:${new Date(b.scheduled_at).getTime()}` });
  db.audit(user.id, 'booking_time_suggested', `booking:${bookingId}`);
}
/** Student accepts a suggested time → the host already approved it, so it goes straight to payment/confirmation. */
async function acceptProposal(bookingId, studentId, user) {
  const b = await db.one('select * from anvaya.bookings where id = $1 and student_id = $2', [bookingId, studentId]);
  if (!b || b.status !== 'requested' || !b.proposed_by) throw new HttpError(404, 'No suggested time to accept.');
  await assertCanBook(studentId);
  return approve(bookingId, { id: b.proposed_by, viaStudent: user.id });
}

// ── Calendar sync → confirmation / reschedule emails ────────────────────
async function scheduleSync(bookingId, reason) {
  const b = await db.one('select scheduled_at from anvaya.bookings where id = $1', [bookingId]);
  const id = await jobs.enqueue('calendar.sync', { bookingId, reason }, { dedupeKey: `calsync:${bookingId}:${new Date(b.scheduled_at).getTime()}:${reason}`, maxAttempts: 8 });
  if (id) await jobs.runNow(id).catch(() => {});
}
async function hostConnection(b) {
  return (await gcal.connectionFor(b.mentor_user_id)) || (await gcal.connectionFor(Number(await settings.get('calendar_host_user_id')) || null));
}
jobs.register('calendar.sync', async ({ bookingId, reason }) => {
  const b = await load(bookingId);
  if (!b || b.status !== 'scheduled') return { skipped: 'not confirmed' };
  try {
    const conn = await hostConnection(b);
    if (!conn) throw new Error('No Google Calendar is connected for this host. Connect one in Calendar → Google Calendar, or set the Anvaya fallback host.');
    const ev = await gcal.upsertEvent(conn, {
      eventId: b.google_event_id, calendarId: b.google_calendar_id || conn.booking_calendar_id, requestId: `anvaya-${b.id}-${Date.now()}`,
      summary: `${b.service} · ${b.student_name} × ${b.mentor_name} (Anvaya)`,
      description: `Anvaya ${b.kind === 'checkup' ? 'check-up (included in plan)' : 'private session'}.\nStudent: ${b.student_name}\nMentor: ${b.mentor_name}\nManage: ${urls.student()}`,
      start: b.scheduled_at, end: b.ends_at, attendees: [b.student_email, b.mentor_email].filter(Boolean),
    });
    await db.run(`update anvaya.bookings set google_event_id = $2, google_calendar_id = $3, meet_link = $4, calendar_host_user_id = $5, calendar_status = 'synced', calendar_error = '' where id = $1`,
      [b.id, ev.eventId, ev.calendarId, ev.meetLink, conn.user_id]);
  } catch (e) {
    await db.run("update anvaya.bookings set calendar_status = 'failed', calendar_error = $2 where id = $1", [b.id, String(e.message).slice(0, 300)]);
    await ops.createTask({ title: `Calendar/Meet failed for ${b.student_name} · ${b.service}: ${String(e.message).slice(0, 120)}`, studentId: b.student_id,
      ownerUserId: b.owner_user_id, source: 'calendar', dedupeKey: `calfail:${b.id}:${new Date(b.scheduled_at).getTime()}` });
    throw e; // retried with backoff; no confirmation is sent without a real Meet link
  }
  await db.run("update anvaya.tasks set status = 'done', done_at = now() where dedupe_key like $1 and status = 'open'", [`calfail:${bookingId}:%`]);
  if (reason === 'backfill') return { synced: true, silent: true }; // confirmed before the calendar was connected: already emailed
  const s = await load(bookingId);
  const k = new Date(s.scheduled_at).getTime();
  const ics = [{ filename: 'anvaya-session.ics', content: buildIcs(s), contentType: 'text/calendar; method=REQUEST' }];
  const base = { ...common(s), meetLink: s.meet_link, gcalUrl: gcalUrl(s), icsUrl: icsUrl(s.id), rescheduleUrl: urls.student(), cancelUrl: urls.student(), __attachments: ics };
  if (reason === 'reschedule') {
    const prev = s.rescheduled_from;
    for (const [to, who] of [[s.student_email, 'student'], [s.mentor_email, 'host']]) {
      if (to) await sendEmail(to, 'session_changed', { ...base, previousAt: prev, forHost: who === 'host', dashboardUrl: who === 'host' ? urls.mentor() : urls.student() }, { dedupeKey: `changed:${s.id}:${k}:${who}` });
    }
  } else {
    if (s.student_email) await sendEmail(s.student_email, 'session_confirmed', { ...base, forHost: false }, { dedupeKey: `confirmed:${s.id}:${k}:student` });
    if (s.mentor_email) await sendEmail(s.mentor_email, 'session_confirmed', { ...base, forHost: true }, { dedupeKey: `confirmed:${s.id}:${k}:host` });
  }
  return { synced: true };
});
jobs.register('calendar.cancel', async ({ bookingId }) => {
  const b = await load(bookingId);
  if (!b?.google_event_id || !b.calendar_host_user_id) return { skipped: 'no event' };
  const conn = await gcal.connectionFor(b.calendar_host_user_id);
  if (!conn) throw new Error('Host Google Calendar is no longer connected; remove the event manually.');
  await gcal.cancelEvent(conn, { eventId: b.google_event_id, calendarId: b.google_calendar_id });
  await db.run("update anvaya.bookings set calendar_status = 'cancelled' where id = $1", [bookingId]);
  return { cancelled: true };
});

/**
 * After a host connects (or changes) Google Calendar: put every upcoming confirmed session they host into it.
 * Sessions confirmed before the connection get their event + Meet link silently (they were already emailed);
 * ones still waiting on a Meet link get the normal confirmation once it exists.
 */
async function backfillHost(userId) {
  const fallback = Number(await settings.get('calendar_host_user_id')) || null;
  const rows = await db.all(`select b.id, b.calendar_status from anvaya.bookings b join anvaya.mentors m on m.id = b.mentor_id
    where b.status = 'scheduled' and b.scheduled_at > now() and b.calendar_status <> 'synced'
      and (m.user_id = $1 or ($2::bigint = $1 and not exists (select 1 from anvaya.calendar_connections c where c.user_id = m.user_id and c.status = 'active')))
    order by b.scheduled_at limit 200`, [userId, fallback]);
  for (const r of rows) await scheduleSync(r.id, r.calendar_status === 'none' ? 'backfill' : 'confirm');
  return rows.length;
}

/** After a time change by anyone: update the calendar event + notify both (confirmed), or re-notify the host (request). */
async function afterReschedule(bookingId) {
  const b = await load(bookingId);
  if (!b) return;
  if (b.status === 'scheduled') return scheduleSync(bookingId, 'reschedule');
  if (b.status === 'requested') return notifyRequested(bookingId);
}

/** Cancels a booking (student or staff), releasing the slot, the calendar event and stale reminders, and notifies both. */
async function cancel(bookingId, { by, reason = '', asStudentId = null }) {
  const cutoff = Number(await settings.get('reschedule_cutoff_hours')) || 24;
  const b = await db.tx(async (t) => {
    const x = await t.one('select * from anvaya.bookings where id = $1 for update', [bookingId]);
    if (!x || (asStudentId && x.student_id !== asStudentId)) throw new HttpError(404, 'Booking not found.');
    if (!['scheduled', 'requested', 'pending_payment'].includes(x.status)) throw new HttpError(400, 'This booking can’t be cancelled.');
    if (asStudentId && x.status === 'scheduled' && new Date(x.scheduled_at).getTime() - Date.now() < cutoff * 3600e3) {
      throw new HttpError(400, `It’s within ${cutoff} hours of the session, so it can’t be cancelled online. Raise a support request and the Anvaya team will help.`);
    }
    await t.run("update anvaya.bookings set status = 'cancelled', cancelled_at = now(), cancel_reason = $2, hold_expires_at = null where id = $1", [x.id, reason || (asStudentId ? 'Cancelled by student' : 'Cancelled by Anvaya')]);
    await ops.cancelStaleReminders({ bookingId: x.id }, t);
    await ops.systemEvent(x.student_id, `“${x.service}” (${ops.ist(x.scheduled_at)}) cancelled${asStudentId ? ' by the student' : ''}.`, t);
    return x;
  });
  if (b.google_event_id) { const j = await jobs.enqueue('calendar.cancel', { bookingId }, { dedupeKey: `calcancel:${bookingId}`, maxAttempts: 6 }); if (j) await jobs.runNow(j).catch(() => {}); }
  const s = await load(bookingId);
  if (['scheduled', 'pending_payment', 'requested'].includes(b.status)) {
    for (const [to, who] of [[s.student_email, 'student'], [b.status !== 'pending_payment' ? s.mentor_email : null, 'host']]) {
      if (to) await sendEmail(to, 'session_changed', { ...common(s), previousAt: b.scheduled_at, cancelled: true, reason, forHost: who === 'host', dashboardUrl: who === 'host' ? urls.mentor() : urls.student() }, { dedupeKey: `cancelled:${s.id}:${who}` });
    }
  }
  return b;
}

/** Releases requests/payment holds that expired and tells the student. */
async function expireHolds() {
  const rows = await db.all(`update anvaya.bookings set status = 'cancelled', cancelled_at = now(),
      cancel_reason = case status when 'requested' then 'Request expired before approval' else 'Payment hold expired' end
    where status in ('requested','pending_payment') and hold_expires_at is not null and hold_expires_at < now() returning id, status, student_id`);
  for (const r of rows) {
    await ops.cancelStaleReminders({ bookingId: r.id });
    const b = await load(r.id);
    if (b.student_email && /Request expired/.test(b.cancel_reason)) await sendEmail(b.student_email, 'request_expired', { ...common(b), dashboardUrl: urls.student() }, { immediate: false, dedupeKey: `expired:${b.id}` });
  }
  return rows.length;
}
jobs.register('bookings.expire_holds', async () => ({ expired: await expireHolds(), freechats: await require('./freechats').expireHolds() }));

// ── Outcomes: attended / student no-show / host absent / technical issue ──
async function markOutcome(bookingId, user, { outcome, reason = '' }) {
  const { markAttendance } = require('../routes/admin/learning');
  const grace = Number(await settings.get('noshow_grace_minutes')) || 15;
  const res = await db.tx(async (t) => {
    const b = await t.one('select * from anvaya.bookings where id = $1 for update', [bookingId]);
    if (!b) throw new HttpError(404, 'Booking not found.');
    if (b.status !== 'scheduled') throw new HttpError(400, `This session is ${b.status.replace('_', ' ')}, so its outcome can’t be changed here.`);
    if (outcome === 'student_no_show') {
      if (Date.now() < new Date(b.scheduled_at).getTime() + grace * 60e3) throw new HttpError(400, `You can confirm a no-show ${grace} minutes after the start.`);
      if (!reason.trim()) throw new HttpError(400, 'Add a short note on what happened (e.g. waited 15 minutes, messaged the student).');
      await t.run("update anvaya.bookings set status = 'no_show', outcome = 'student_no_show' where id = $1", [b.id]);
      await markAttendance(t, { bookingId: b.id, marks: [{ student_id: b.student_id, status: 'absent' }], userId: user.id });
      const ev = await t.one('insert into anvaya.no_show_events (booking_id, student_id, marked_by, reason) values ($1,$2,$3,$4) returning id', [b.id, b.student_id, user.id, reason.trim()]);
      await t.run('update anvaya.students set booking_blocked_at = coalesce(booking_blocked_at, now()), booking_block_event_id = coalesce(booking_block_event_id, $2) where id = $1', [b.student_id, ev.id]);
      const upcoming = await t.all(`update anvaya.bookings set needs_review = true where student_id = $1 and status in ('scheduled','requested','pending_payment') and scheduled_at > now() returning id`, [b.student_id]);
      return { b, eventId: ev.id, upcoming: upcoming.length };
    }
    if (['host_absent', 'technical_issue'].includes(outcome)) {
      await t.run("update anvaya.bookings set status = 'cancelled', outcome = $2, cancelled_at = now(), cancel_reason = $3, needs_review = true where id = $1",
        [b.id, outcome, outcome === 'host_absent' ? 'Session didn’t go ahead: host unavailable' : 'Session didn’t go ahead: technical problem']);
      return { b };
    }
    throw new HttpError(400, 'Choose an outcome.');
  });
  const s = await load(bookingId);
  if (outcome === 'student_no_show') {
    if (s.student_email) await sendEmail(s.student_email, 'no_show_student', { ...common(s), disputeUrl: `${BASE()}/student#support` }, { dedupeKey: `noshow:${s.id}` });
    const admins = await db.all("select email from anvaya.users where role = 'admin' and disabled_at is null");
    const marker = await db.one("select coalesce(nullif(name,''), email) as n from anvaya.users where id = $1", [user.id]);
    for (const a of admins) await sendEmail(a.email, 'no_show_admin', { ...common(s), markedBy: marker?.n || 'Host', reason, upcoming: res.upcoming, adminUrl: urls.admin(`student-${s.student_id}`) }, { immediate: false, dedupeKey: `noshow-admin:${s.id}:${a.email}` });
    await ops.systemEvent(s.student_id, `No-show recorded for “${s.service}” (${ops.ist(s.scheduled_at)}) by ${marker?.n}. New bookings blocked. Reason: ${reason}`);
    if (res.upcoming) await ops.createTask({ title: `Review ${res.upcoming} upcoming booking(s) after no-show: ${s.student_name}`, studentId: s.student_id, ownerUserId: s.owner_user_id, source: 'no_show', dedupeKey: `noshow-review:${s.id}` });
  } else {
    if (s.student_email) await sendEmail(s.student_email, 'session_changed', { ...common(s), previousAt: s.scheduled_at, cancelled: true, reason: `${s.cancel_reason}. This doesn’t count against you; the Anvaya team will contact you to rebook.`, dashboardUrl: urls.student() }, { dedupeKey: `nohappen:${s.id}` });
    await ops.createTask({ title: `Rebook or refund: ${s.student_name} · ${s.service} (${outcome.replace('_', ' ')})`, studentId: s.student_id, ownerUserId: s.owner_user_id, source: 'booking', dedupeKey: `nohappen:${s.id}` });
    await ops.systemEvent(s.student_id, `${s.service} didn’t go ahead (${outcome.replace('_', ' ')}); no penalty.`);
  }
  db.audit(user.id, `booking_outcome_${outcome}`, `booking:${bookingId}`);
  return res;
}

async function dispute(studentId, user, text) {
  const ev = await db.one("select e.*, b.service from anvaya.no_show_events e join anvaya.bookings b on b.id = e.booking_id where e.student_id = $1 and e.status = 'active' order by e.id desc limit 1", [studentId]);
  if (!ev) throw new HttpError(404, 'There’s no active no-show record to dispute.');
  if (ev.dispute_case_id) throw new HttpError(400, 'You’ve already disputed this. The team will reply in Support.');
  const c = await db.one("insert into anvaya.support_cases (student_id, subject, category, created_by) values ($1,$2,'no_show_dispute',$3) returning id", [studentId, `No-show dispute: ${ev.service}`, user.id]);
  await ops.addEntry({ studentId, caseId: c.id, kind: 'message', body: text, userId: user.id, role: 'student' });
  await db.run('update anvaya.no_show_events set disputed_at = now(), dispute_case_id = $2 where id = $1', [ev.id, c.id]);
  await ops.createTask({ title: `No-show dispute to review: ${ev.service}`, studentId, caseId: c.id, source: 'no_show', dedupeKey: `dispute:${ev.id}` });
  return { caseId: c.id };
}

async function reverseNoShow(eventId, user, reason) {
  const ev = await db.tx(async (t) => {
    const e = await t.one('select * from anvaya.no_show_events where id = $1 for update', [eventId]);
    if (!e) throw new HttpError(404, 'No-show record not found.');
    if (e.status === 'reversed') throw new HttpError(400, 'Already reversed.');
    await t.run("update anvaya.no_show_events set status = 'reversed', reversed_by = $2, reversed_at = now(), reverse_reason = $3 where id = $1", [e.id, user.id, reason]);
    await t.run("update anvaya.bookings set status = 'cancelled', outcome = 'no_show_reversed', cancel_reason = 'No-show reversed by Anvaya' where id = $1 and status = 'no_show'", [e.booking_id]);
    const others = await t.one("select count(*)::int n from anvaya.no_show_events where student_id = $1 and status = 'active'", [e.student_id]);
    if (!others.n) await t.run('update anvaya.students set booking_blocked_at = null, booking_block_event_id = null where id = $1', [e.student_id]);
    if (e.dispute_case_id) await t.run("update anvaya.support_cases set status = 'resolved', resolved_at = now(), updated_at = now() where id = $1", [e.dispute_case_id]);
    return { ...e, unblocked: !others.n };
  });
  const b = await load(ev.booking_id);
  if (ev.unblocked && b?.student_email) await sendEmail(b.student_email, 'booking_restored', { ...common(b), dashboardUrl: urls.student() }, { dedupeKey: `restored:${eventId}` });
  await ops.systemEvent(ev.student_id, `No-show reversed by ${user.name || user.email}: ${reason}${ev.unblocked ? '. Booking access restored.' : ''}`);
  db.audit(user.id, 'no_show_reversed', `event:${eventId}`);
  return ev;
}

module.exports = {
  backfillHost, assertCanBook, holdUntil, notifyRequested, approve, decline, suggest, acceptProposal, scheduleSync, afterReschedule, cancel, expireHolds,
  markOutcome, dispute, reverseNoShow, buildIcs, icsSig, icsUrl, gcalUrl, load };
