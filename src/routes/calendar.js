'use strict';
// Inbuilt calendar for hosts (admins/ops see every mentor; a mentor sees only their own): Google Calendar connection,
// weekly hours, date overrides (open/blocked), a bookings feed with clear statuses, and session actions
// (approve, decline, suggest another time, outcome / no-show, calendar retry). Students never reach these routes.
const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const sec = require('../security');
const gcal = require('../lib/gcal');
const sessions = require('../lib/sessions');
const bookingsLib = require('../lib/bookings');
const { HttpError, bad, v, id, wrap } = require('../lib/http');

const r = express.Router();
const IS_PROD = process.env.NODE_ENV === 'production';
const STATE_COOKIE = IS_PROD ? '__Host-anvaya_gcal' : 'anvaya_gcal';
const isStaff = (req) => ['admin', 'ops'].includes(req.auth?.user.role);
const isAdmin = (req) => req.auth?.user.role === 'admin';
r.use((req, res, next) => {
  if (req.path === '/google/callback') return next(); // validated by the state cookie below
  if (!req.auth) return res.status(401).json({ error: 'Please sign in.' });
  if (isStaff(req)) return next();
  if (req.auth.user.role === 'mentor' && req.auth.mentor?.status === 'active') return next();
  return res.status(403).json({ error: 'You do not have access to this area.' });
});

/** Which mentor a request acts on: staff may pass mentor_id; a mentor is always themselves. */
async function mentorScope(req, { required = true } = {}) {
  if (!isStaff(req)) return req.auth.mentor.id;
  const mid = v.id(req.query.mentor_id ?? req.body?.mentor_id, 'Mentor');
  if (!mid && required) throw bad('Choose a mentor.');
  if (mid && !await db.one('select 1 from anvaya.mentors where id = $1', [mid])) throw new HttpError(404, 'Mentor not found.');
  return mid || null;
}
async function ownBooking(req) {
  const b = await db.one('select * from anvaya.bookings where id = $1', [id(req)]);
  if (!b || (!isStaff(req) && b.mentor_id !== req.auth.mentor.id)) throw new HttpError(404, 'Booking not found.');
  return b;
}

// ── Google Calendar connection ──────────────────────────────────────────
r.get('/google', wrap(async (req, res) => {
  const conn = await db.one('select id, google_email, busy_calendar_ids, booking_calendar_id, status, last_error, connected_at from anvaya.calendar_connections where user_id = $1', [req.auth.user.id]);
  let calendars = [];
  if (conn?.status === 'active') { try { calendars = await gcal.listCalendars(await gcal.connectionFor(req.auth.user.id)); } catch (e) { conn.last_error = e.message; } }
  res.json({ available: gcal.configured(), connection: conn || null, calendars });
}));
r.get('/google/connect', (req, res) => {
  if (!gcal.configured()) return res.redirect(303, `/${isStaff(req) ? 'admin' : 'mentor'}#calendar`);
  const state = sec.randomToken(24);
  res.cookie(STATE_COOKIE, JSON.stringify({ state, uid: req.auth.user.id }), { httpOnly: true, secure: IS_PROD, sameSite: 'lax', path: '/', maxAge: 10 * 60e3 });
  res.redirect(303, gcal.authUrl(state));
});
r.get('/google/callback', wrap(async (req, res) => {
  let saved = null; try { saved = JSON.parse(req.cookies[STATE_COOKIE] || 'null'); } catch { /* ignore */ }
  res.clearCookie(STATE_COOKIE, { path: '/', secure: IS_PROD, sameSite: 'lax', httpOnly: true });
  const st = String(req.query.state || '');
  if (!saved?.state || st.length !== saved.state.length || !crypto.timingSafeEqual(Buffer.from(st), Buffer.from(saved.state)) || !req.auth || req.auth.user.id !== saved.uid) {
    return res.status(400).type('text').send('This Google Calendar connection link expired or was opened in another browser. Please try again from the calendar page.');
  }
  const back = `/${isStaff(req) ? 'admin' : 'mentor'}#calendar`;
  if (req.query.error) return res.type('html').send(`<meta http-equiv="refresh" content="0;url=${back}">`);
  try {
    const out = await gcal.exchangeCode(String(req.query.code || ''));
    await gcal.saveConnection(req.auth.user.id, out);
    db.audit(req.auth.user.id, 'google_calendar_connected', out.email);
  } catch (e) {
    return res.status(400).type('text').send(`Google Calendar couldn't be connected: ${e.message}`);
  }
  res.type('html').send(`<meta http-equiv="refresh" content="0;url=${back}"><p>Connected. <a href="${back}">Continue</a></p>`);
}));
r.put('/google', wrap(async (req, res) => {
  const conn = await gcal.connectionFor(req.auth.user.id);
  if (!conn) throw new HttpError(404, 'Connect Google Calendar first.');
  const cals = await gcal.listCalendars(conn);
  const ids = new Set(cals.map((c) => c.id));
  const busy = (Array.isArray(req.body?.busy_calendar_ids) ? req.body.busy_calendar_ids : []).map(String).filter((x) => ids.has(x)).slice(0, 20);
  const booking = String(req.body?.booking_calendar_id || conn.booking_calendar_id);
  if (!ids.has(booking) || cals.find((c) => c.id === booking)?.canWrite === false) throw bad('Choose a calendar you can add events to.');
  await db.run('update anvaya.calendar_connections set busy_calendar_ids = $2, booking_calendar_id = $3, updated_at = now() where id = $1', [conn.id, busy.length ? busy : ['primary'], booking]);
  res.json({ ok: true });
}));
r.delete('/google', wrap(async (req, res) => {
  await db.run('delete from anvaya.calendar_connections where user_id = $1', [req.auth.user.id]);
  db.audit(req.auth.user.id, 'google_calendar_disconnected', '');
  res.json({ ok: true });
}));

// ── Availability: weekly hours + date overrides ─────────────────────────
r.get('/mentors', wrap(async (req, res) => {
  if (!isStaff(req)) return res.json(await db.all('select id, name from anvaya.mentors where id = $1', [req.auth.mentor.id]));
  res.json(await db.all("select id, name from anvaya.mentors where status = 'active' order by name"));
}));
r.get('/availability', wrap(async (req, res) => {
  const mid = await mentorScope(req);
  res.json({
    weekly: await db.all('select weekday, start_time, end_time from anvaya.availability where mentor_id = $1 order by weekday, start_time', [mid]),
    overrides: await db.all("select id, to_char(day, 'YYYY-MM-DD') as day, start_time, end_time, kind, note from anvaya.availability_overrides where mentor_id = $1 and day >= current_date - 1 order by day, start_time nulls first", [mid]),
    mentor: await db.one('select id, name, buffer_minutes, session_duration from anvaya.mentors where id = $1', [mid]),
  });
}));
r.put('/availability', wrap(async (req, res) => {
  const mid = await mentorScope(req);
  const list = Array.isArray(req.body?.weekly) ? req.body.weekly : [];
  if (list.length > 50) throw bad('Too many time ranges.');
  const rows = list.map((s) => {
    const weekday = v.int(s.weekday, { min: 0, max: 6, label: 'Day', required: true });
    const start = v.time(s.start_time), end = v.time(s.end_time);
    if (end <= start) throw bad('Each range must end after it starts.');
    return { weekday, start, end };
  });
  await db.tx(async (t) => {
    await t.run('delete from anvaya.availability where mentor_id = $1', [mid]);
    for (const x of rows) await t.run('insert into anvaya.availability (mentor_id, weekday, start_time, end_time) values ($1,$2,$3,$4)', [mid, x.weekday, x.start, x.end]);
  });
  db.audit(req.auth.user.id, 'availability_updated', `mentor:${mid}`);
  res.json({ ok: true });
}));
r.post('/overrides', wrap(async (req, res) => {
  const mid = await mentorScope(req);
  const day = v.str(req.body?.day, { max: 10, required: true, label: 'Date' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw bad('Date must be YYYY-MM-DD.');
  const kind = v.oneOf(req.body?.kind, ['open', 'blocked'], 'Type');
  const start = req.body?.start_time ? v.time(req.body.start_time) : null, end = req.body?.end_time ? v.time(req.body.end_time) : null;
  if ((start && !end) || (!start && end)) throw bad('Give both a start and an end time, or neither to block the whole day.');
  if (start && end <= start) throw bad('The end must be after the start.');
  if (kind === 'open' && !start) throw bad('Extra open hours need a start and end time.');
  const row = await db.one(`insert into anvaya.availability_overrides (mentor_id, day, start_time, end_time, kind, note, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [mid, day, start, end, kind, v.str(req.body?.note, { max: 200 }), req.auth.user.id]);
  res.status(201).json({ id: row.id });
}));
r.delete('/overrides/:id', wrap(async (req, res) => {
  const o = await db.one('select * from anvaya.availability_overrides where id = $1', [id(req)]);
  if (!o || (!isStaff(req) && o.mentor_id !== req.auth.mentor.id)) throw new HttpError(404, 'Not found.');
  await db.run('delete from anvaya.availability_overrides where id = $1', [o.id]);
  res.json({ ok: true });
}));
r.get('/slots', wrap(async (req, res) => res.json(await bookingsLib.slots(await mentorScope(req)))));

// ── Calendar feed ───────────────────────────────────────────────────────
r.get('/events', wrap(async (req, res) => {
  const from = v.date(req.query.from, { required: true, label: 'From' }), to = v.date(req.query.to, { required: true, label: 'To' });
  if (new Date(to) - new Date(from) > 62 * 86400e3) throw bad('Ask for at most two months at a time.');
  const mid = await mentorScope(req, { required: false });
  const bookings = await db.all(`select b.id, b.kind, b.service, b.scheduled_at, b.ends_at, b.status, b.hold_expires_at, b.proposed_by is not null as proposed, b.calendar_status, b.calendar_error,
      b.meet_link, b.outcome, b.needs_review, b.intake_answers, b.rescheduled_from, s.id as student_id, s.name as student_name, s.booking_blocked_at is not null as student_blocked, m.id as mentor_id, m.name as mentor_name
    from anvaya.bookings b join anvaya.students s on s.id = b.student_id left join anvaya.mentors m on m.id = b.mentor_id
    where b.scheduled_at < $2 and b.ends_at > $1 and ($3::bigint is null or b.mentor_id = $3) and not (b.status = 'cancelled' and b.cancelled_at < now() - interval '30 days')
    order by b.scheduled_at`, [from, to, mid]);
  const live = await db.all(`select l.id, l.title, l.starts_at, l.ends_at, l.status, m.name as mentor_name from anvaya.live_sessions l left join anvaya.mentors m on m.id = l.mentor_id
    where l.starts_at < $2 and l.ends_at > $1 and ($3::bigint is null or l.mentor_id = $3) and l.status <> 'cancelled'`, [from, to, mid]);
  res.json({ bookings, live });
}));

// ── Session actions ─────────────────────────────────────────────────────
r.post('/bookings/:id/approve', wrap(async (req, res) => { await ownBooking(req); res.json(await sessions.approve(id(req), req.auth.user)); }));
r.post('/bookings/:id/decline', wrap(async (req, res) => { await ownBooking(req); await sessions.decline(id(req), req.auth.user, v.str(req.body?.reason, { max: 300 })); res.json({ ok: true }); }));
r.post('/bookings/:id/suggest', wrap(async (req, res) => {
  await ownBooking(req);
  await sessions.suggest(id(req), req.auth.user, v.date(req.body?.scheduled_at, { required: true, label: 'Suggested time' }));
  res.json({ ok: true });
}));
r.post('/bookings/:id/outcome', wrap(async (req, res) => {
  await ownBooking(req);
  res.json(await sessions.markOutcome(id(req), req.auth.user, { outcome: v.oneOf(req.body?.outcome, ['student_no_show', 'host_absent', 'technical_issue'], 'Outcome'), reason: v.str(req.body?.reason, { max: 500 }) }));
}));
r.post('/bookings/:id/calendar-retry', wrap(async (req, res) => {
  const b = await ownBooking(req);
  if (b.status !== 'scheduled') throw bad('Only confirmed sessions have calendar events.');
  await db.run("update anvaya.bookings set calendar_status = 'pending', calendar_error = '' where id = $1", [b.id]);
  const jobs = require('../lib/jobs');
  const jid = await jobs.enqueue('calendar.sync', { bookingId: b.id, reason: b.google_event_id ? 'reschedule' : 'confirm' }, { dedupeKey: `calretry:${b.id}:${Date.now()}`, maxAttempts: 8 });
  const out = await jobs.runNow(jid);
  const after = await db.one('select calendar_status, calendar_error, meet_link from anvaya.bookings where id = $1', [b.id]);
  res.json({ ok: out.ok, ...after });
}));

module.exports = r;
module.exports.isAdmin = isAdmin;
