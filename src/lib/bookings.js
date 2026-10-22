'use strict';
// 1:1 bookings (paid private sessions and included check-ups).
// Double booking is impossible at the database level (GiST exclusion constraint bookings_no_overlap on
// mentor + time range for live statuses); creation also runs in a transaction that releases expired
// holds first and re-validates the slot against the mentor's availability.
const db = require('../db');
const gcal = require('./gcal');
const settings = require('./settings');
const subs = require('./subscriptions');
const { HttpError } = require('./http');

const IST_MS = subs.IST_MS;
const LIVE = "('pending_payment','requested','scheduled')";

/** Releases payment holds that expired (slot becomes free again). */
async function releaseExpiredHolds(q = db, mentorId = null) {
  return q.run(`update anvaya.bookings set status = 'cancelled', cancelled_at = now(),
      cancel_reason = case status when 'requested' then 'Request expired before approval' else 'Payment hold expired' end
    where status in ('pending_payment','requested') and hold_expires_at is not null and hold_expires_at < now() ${mentorId ? 'and mentor_id = $1' : ''}`, mentorId ? [mentorId] : []);
}

/** Bookable slot start times (ISO) for a mentor over the booking window, in IST availability terms. */
async function slots(mentorId, { days, q = db, durationMin = null, excludeBookingId = null } = {}) {
  const m = await q.one("select id, user_id, session_duration, buffer_minutes, status from anvaya.mentors where id = $1", [mentorId]);
  if (!m || m.status !== 'active') return [];
  const [avail, cfg] = await Promise.all([
    q.all('select weekday, start_time, end_time from anvaya.availability where mentor_id = $1', [mentorId]),
    settings.all(q),
  ]);
  const windowDays = days || Number(cfg.booking_window_days);
  const notice = Number(cfg.booking_min_notice_hours) * 3600e3;
  const now = Date.now();
  const busy = await q.all(`select scheduled_at as s, ends_at as e from anvaya.bookings where mentor_id = $1 and status in ${LIVE}
      and (status = 'scheduled' or hold_expires_at is null or hold_expires_at > now()) and ends_at > now() and id <> coalesce($2::bigint, -1)
    union all select starts_at, ends_at from anvaya.live_sessions where mentor_id = $1 and status = 'scheduled' and ends_at > now()`, [mentorId, excludeBookingId]);
  // The mentor's buffer keeps a gap before and after every existing session.
  const buf = (m.buffer_minutes || 0) * 60e3;
  const busyR = busy.map((b) => [new Date(b.s).getTime() - buf, new Date(b.e).getTime() + buf]);
  // Busy times from the mentor's selected Google calendars (times only, never event details).
  const conn = m.user_id && await gcal.connectionFor(m.user_id, q).catch(() => null);
  if (conn) {
    try { for (const [s, e] of await gcal.busy(conn, now, now + (Number(days || cfg.booking_window_days) + 1) * 86400e3)) busyR.push([s - buf, e + buf]); }
    catch (e) { console.error('[slots] Google busy unavailable for mentor', mentorId, e.message); }
  }
  // Date overrides: whole-day or partial blocks, and extra open hours on specific dates (IST dates).
  const overrides = await q.all("select to_char(day, 'YYYY-MM-DD') as day, start_time, end_time, kind from anvaya.availability_overrides where mentor_id = $1 and day >= (now() at time zone 'Asia/Kolkata')::date - 1", [mentorId]);
  const dur = (durationMin || m.session_duration) * 60e3;
  const step = dur + buf; // back-to-back slots, separated by the mentor's buffer
  const out = [];
  const todayIst = new Date(now + IST_MS);
  for (let d = 0; d <= windowDays; d++) {
    const dayStartUtc = Date.UTC(todayIst.getUTCFullYear(), todayIst.getUTCMonth(), todayIst.getUTCDate() + d) - IST_MS;
    const weekday = new Date(dayStartUtc + IST_MS).getUTCDay();
    const dayKey = new Date(dayStartUtc + IST_MS).toISOString().slice(0, 10);
    const todays = overrides.filter((o) => o.day === dayKey);
    if (todays.some((o) => o.kind === 'blocked' && !o.start_time)) continue; // whole day blocked
    const at = (hm) => { const [h, mi] = hm.split(':').map(Number); return dayStartUtc + (h * 60 + mi) * 60e3; };
    const dayBlocks = todays.filter((o) => o.kind === 'blocked' && o.start_time).map((o) => [at(o.start_time), at(o.end_time)]);
    const windows = [...avail.filter((x) => x.weekday === weekday), ...todays.filter((o) => o.kind === 'open' && o.start_time)];
    for (const a of windows) {
      const [sh, sm] = a.start_time.split(':').map(Number);
      const [eh, em] = a.end_time.split(':').map(Number);
      const winEnd = dayStartUtc + (eh * 60 + em) * 60e3;
      for (let t = dayStartUtc + (sh * 60 + sm) * 60e3; t + dur <= winEnd; t += step) {
        if (t < now + notice) continue;
        if (busyR.some(([s, e]) => t < e && t + dur > s)) continue;
        if (dayBlocks.some(([s, e]) => t < e && t + dur > s)) continue;
        out.push(new Date(t).toISOString());
      }
    }
  }
  return [...new Set(out)].sort();
}

function isSlot(list, iso) { return list.includes(new Date(iso).toISOString()); }

/**
 * Creates a booking atomically. kind: 'paid_session' | 'checkup'.
 * Paid sessions start as 'pending_payment' (Razorpay hold) or 'requested' (manual payment), check-ups as 'scheduled'.
 */
async function create({ studentId, mentorId, startsAt, kind, service, serviceId = null, intakeAnswers = {}, userId, order = null, paymentMode = 'razorpay', allowOutsideAvailability = false, asRequest = false }) {
  const sessions = require('./sessions');
  try {
    return await db.tx(async (t) => {
      await t.one('select id from anvaya.students where id = $1 for update', [studentId]); // serialize this student's entitlement checks
      await sessions.assertCanBook(studentId, t); // a confirmed no-show blocks every new booking or request
      await releaseExpiredHolds(t, mentorId);
      const m = await t.one('select * from anvaya.mentors where id = $1', [mentorId]);
      if (!m || m.status !== 'active') throw new HttpError(400, 'This mentor is not available for booking.');
      let svc = null;
      if (serviceId) {
        svc = await t.one("select * from anvaya.mentor_services where id = $1 and mentor_id = $2 and active and approval = 'approved'", [serviceId, mentorId]);
        if (!svc) throw new HttpError(400, 'That service isn’t available.');
        intakeAnswers = checkIntake(svc.intake_questions, intakeAnswers);
      }
      const duration = svc ? svc.duration_min : m.session_duration;
      if (!allowOutsideAvailability && !isSlot(await slots(mentorId, { q: t, durationMin: duration }), startsAt)) throw new HttpError(409, 'That time is no longer available. Please pick another slot.');
      let subscriptionId = null, price = 0, fee = 0, status = 'scheduled', hold = null;
      if (kind === 'checkup') {
        const sub = await subs.activeFor(studentId, t);
        if (!sub) throw new HttpError(403, 'Check-ups are included with an active plan.');
        const ent = sub.entitlements.find((e) => e.key === 'checkup_call');
        if (!ent) throw new HttpError(403, 'Your plan doesn’t include check-up calls.');
        if (ent.limit_count != null) {
          const u = await subs.usage(studentId, sub, ent, t);
          if (u.used >= ent.limit_count) throw new HttpError(409, `You’ve used all ${ent.limit_count} check-up call${ent.limit_count === 1 ? '' : 's'} for this ${ent.per_period === 'billing_period' ? 'billing period' : ent.per_period}.`);
        }
        subscriptionId = sub.id; fee = m.checkup_fee_paise;
      } else {
        if (!m.accepts_paid_sessions) throw new HttpError(400, 'This mentor isn’t taking paid sessions right now.');
        price = svc ? Number(svc.price_paise) : m.session_price_paise; fee = price; // zero commission: full stated fee to the mentor
        status = paymentMode === 'razorpay' ? 'pending_payment' : 'requested';
        if (status === 'pending_payment') hold = new Date(Date.now() + Number(await settings.get('booking_hold_minutes', t)) * 60e3);
      }
      // Student-initiated: always a request awaiting the host's approval, with the slot held until it expires.
      if (asRequest) { status = 'requested'; hold = await sessions.holdUntil(startsAt, t); }
      const b = await t.one(`insert into anvaya.bookings (student_id, mentor_id, kind, service, scheduled_at, duration, status, price_paise, mentor_fee_paise,
          meeting_link, subscription_id, order_id, hold_expires_at, created_by, service_id, intake_answers, requested_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, case when $7 = 'requested' then now() end) returning *`,
      [studentId, mentorId, kind, svc?.title || service || (kind === 'checkup' ? 'Check-up call' : 'Private mentor session'), new Date(startsAt).toISOString(), duration,
        status, price, fee, m.meeting_link, subscriptionId, order?.id ?? null, hold, userId, svc?.id ?? null, JSON.stringify(intakeAnswers || {})]);
      await t.run('update anvaya.students set mentor_id = coalesce(mentor_id, $1) where id = $2', [mentorId, studentId]);
      return b;
    });
  } catch (e) {
    if (e.code === '23P01' || /bookings_no_overlap|conflicting key value violates exclusion/.test(e.message)) throw new HttpError(409, 'That time was just booked by someone else. Please pick another slot.');
    throw e;
  }
}

/** Validates booking intake answers against a service's questions ([{id, label, required}]). */
function checkIntake(questions, answers) {
  const out = {};
  for (const qn of Array.isArray(questions) ? questions : []) {
    const a = String(answers?.[qn.id] ?? '').trim().slice(0, 2000);
    if (qn.required && !a) throw new HttpError(400, `Please answer: ${qn.label}`);
    if (a) out[qn.id] = a;
  }
  return out;
}

/**
 * Moves a scheduled booking to a new start time. The slot is re-validated (ignoring this booking), the
 * exclusion constraint still prevents double booking, and queued reminders for the old time are cancelled.
 */
async function reschedule({ bookingId, startsAt, byUserId, studentId = null, allowOutsideAvailability = false }) {
  const ops = require('./ops');
  try {
    return await db.tx(async (t) => {
      const b = await t.one('select * from anvaya.bookings where id = $1 for update', [bookingId]);
      if (!b || (studentId && b.student_id !== studentId)) throw new HttpError(404, 'Booking not found.');
      if (!['scheduled', 'requested'].includes(b.status)) throw new HttpError(400, 'Only upcoming sessions can be moved.');
      const iso = new Date(startsAt).toISOString();
      if (iso === new Date(b.scheduled_at).toISOString()) throw new HttpError(400, 'That is already the session time.');
      if (studentId) {
        const cutoff = Number(await settings.get('reschedule_cutoff_hours', t)) || 2;
        if (new Date(b.scheduled_at).getTime() - Date.now() < cutoff * 3600e3) throw new HttpError(400, `It’s within ${cutoff} hours of the session, so it can’t be rescheduled online. Raise a support request and the Anvaya team can make an exception.`);
        await require('./sessions').assertCanBook(b.student_id, t);
      }
      if (!allowOutsideAvailability && !isSlot(await slots(b.mentor_id, { q: t, durationMin: b.duration, excludeBookingId: b.id }), iso)) {
        throw new HttpError(409, 'That time is no longer available. Please pick another slot.');
      }
      await t.run(`update anvaya.bookings set scheduled_at = $2, rescheduled_from = $3, reschedule_count = reschedule_count + 1 where id = $1`, [b.id, iso, b.scheduled_at]);
      await ops.cancelStaleReminders({ bookingId: b.id }, t);
      await ops.systemEvent(b.student_id, `Session “${b.service}” moved from ${ops.ist(b.scheduled_at)} to ${ops.ist(iso)}.`, t);
      await t.run("insert into anvaya.audit_log (user_id, action, detail) values ($1, 'booking_rescheduled', $2)", [byUserId, `booking:${b.id} from:${new Date(b.scheduled_at).toISOString()} to:${iso}`]);
      return { ...b, previous_at: b.scheduled_at, scheduled_at: iso };
    });
  } catch (e) {
    if (e.code === '23P01' || /bookings_no_overlap|conflicting key value violates exclusion/.test(e.message)) throw new HttpError(409, 'That time was just booked by someone else. Please pick another slot.');
    throw e;
  }
}

module.exports = { slots, create, reschedule, checkIntake, releaseExpiredHolds, LIVE };
