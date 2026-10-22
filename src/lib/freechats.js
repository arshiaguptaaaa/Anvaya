'use strict';
// Free 15-minute chats booked from the public website. The visitor (a lead, no account) picks one of the free-chat
// host's open slots → the slot is held while the host approves it in the calendar → a Google Calendar event with a
// Meet link is created → the visitor and host get the confirmation and reminders. Free chats share the host's
// availability with student sessions (bookings.slots counts both), so nothing can be double-booked.
const db = require('../db');
const jobs = require('./jobs');
const gcal = require('./gcal');
const ops = require('./ops');
const settings = require('./settings');
const bookings = require('./bookings');
const { sendEmail } = require('./email');
const { HttpError } = require('./http');

const BASE = () => (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const SITE = () => (process.env.PUBLIC_SITE_URL || 'https://anvayacareers.in').replace(/\/$/, '');
const TITLE = 'Free 15-min chat';
const fmtIcs = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** The free-chat host (a mentor profile, possibly unlisted), or null when free chats aren't bookable online. */
async function host(q = db) {
  const id = Number(await settings.get('freechat_mentor_id', q)) || null;
  if (!id) return null;
  const m = await q.one('select id, user_id, name, status from anvaya.mentors where id = $1', [id]);
  return m && m.status === 'active' ? m : null;
}
const minutes = async (q = db) => Number(await settings.get('freechat_minutes', q)) || 15;
const WINDOW_DAYS = 14;

async function openSlots() {
  const h = await host();
  if (!h) return { available: false, minutes: 15, slots: [] };
  const min = await minutes();
  return { available: true, minutes: min, slots: await bookings.slots(h.id, { durationMin: min, days: WINDOW_DAYS }) };
}

/** Holds the slot for a visitor (inside the caller's transaction, so the lead and the request commit together). */
async function request({ leadId, name, email, phone, situation, startsAt }, t) {
  const h = await host(t);
  if (!h) throw new HttpError(409, 'Free chats can’t be booked online right now. Send the form without a time and we’ll call you.');
  await t.one('select id from anvaya.mentors where id = $1 for update', [h.id]); // serialises with student bookings for this host
  const min = await minutes(t);
  const at = new Date(startsAt).getTime();
  const free = await bookings.slots(h.id, { q: t, durationMin: min, days: WINDOW_DAYS });
  if (!free.some((s) => new Date(s).getTime() === at)) throw new HttpError(409, 'That time was just taken. Please pick another slot.');
  const hours = Number(await settings.get('booking_request_hold_hours', t)) || 24;
  const hold = new Date(Math.min(Date.now() + hours * 3600e3, at - 30 * 60e3));
  return t.one(`insert into anvaya.freechats (lead_id, mentor_id, name, email, phone, situation, scheduled_at, ends_at, hold_expires_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`, [leadId, h.id, name, email, phone, situation, new Date(at), new Date(at + min * 60e3), hold]);
}

async function load(id, q = db) {
  return q.one(`select f.*, m.name as mentor_name, m.user_id as mentor_user_id, mu.email as mentor_email, mu.role as mentor_role, l.owner_user_id
    from anvaya.freechats f join anvaya.mentors m on m.id = f.mentor_id left join anvaya.users mu on mu.id = m.user_id
    left join anvaya.leads l on l.id = f.lead_id where f.id = $1`, [id]);
}
const duration = (f) => Math.round((new Date(f.ends_at) - new Date(f.scheduled_at)) / 60e3);
const reviewUrl = (f) => `${BASE()}/${f.mentor_role === 'mentor' ? 'mentor' : 'admin'}#calendar`;
const leadNote = (f, body) => (f.lead_id ? db.run("insert into anvaya.lead_activities (lead_id, kind, body) values ($1,'system',$2)", [f.lead_id, body]) : null);
const common = (f) => ({ title: TITLE, startsAt: f.scheduled_at, duration: duration(f), mentorName: f.mentor_name, studentName: f.name, name: f.name.split(' ')[0] });

async function notifyRequested(id) {
  const f = await load(id);
  const k = new Date(f.scheduled_at).getTime();
  await sendEmail(f.email, 'freechat_requested', { ...common(f), holdUntil: f.hold_expires_at }, { immediate: false, dedupeKey: `fc-requested:${f.id}:${k}` });
  if (f.mentor_email) await sendEmail(f.mentor_email, 'session_request_host', { ...common(f), studentName: `${f.name} (free chat · ${f.phone})`, holdUntil: f.hold_expires_at, reviewUrl: reviewUrl(f) }, { immediate: false, dedupeKey: `fc-request-host:${f.id}:${k}` });
  await ops.createTask({ title: `Approve free chat: ${f.name} · ${ops.ist(f.scheduled_at)}`, leadId: f.lead_id, ownerUserId: f.owner_user_id, dueAt: f.hold_expires_at, source: 'booking', dedupeKey: `fc-review:${f.id}` });
  await leadNote(f, `Picked a free-chat slot: ${ops.ist(f.scheduled_at)} (awaiting approval)`);
  if (f.lead_id) await db.run("update anvaya.leads set follow_up_at = $2, next_action = 'Approve the free chat they booked' where id = $1", [f.lead_id, f.hold_expires_at]);
  await jobs.processDue({ kinds: ['email.send'], limit: 5 }).catch(() => {});
}

async function setStatus(id, from, to, extra = '', params = []) {
  const r = await db.one(`update anvaya.freechats set status = $3${extra} where id = $1 and status = any($2::text[]) returning *`, [id, from, to, ...params]);
  if (!r) throw new HttpError(400, 'This free chat has already changed. Refresh the calendar.');
  return r;
}
const closeTasks = (id, userId = null) => db.run("update anvaya.tasks set status = 'done', done_at = now(), done_by = $2 where dedupe_key like $1 and status = 'open'", [`fc-%:${id}%`, userId]);

async function approve(id, user) {
  await setStatus(id, ['requested'], 'scheduled', ", hold_expires_at = null, approved_at = now(), approved_by = $4, calendar_status = 'pending', calendar_error = ''", [user.id]);
  await closeTasks(id, user.id);
  await sync(id);
  db.audit(user.id, 'freechat_approved', `freechat:${id}`);
  return load(id);
}
async function sync(id) {
  const j = await jobs.enqueue('freechat.sync', { id }, { dedupeKey: `fcsync:${id}:${Date.now()}`, maxAttempts: 8 });
  if (j) await jobs.runNow(j).catch(() => {});
}
jobs.register('freechat.sync', async ({ id }) => {
  const f = await load(id);
  if (!f || f.status !== 'scheduled') return { skipped: 'not confirmed' };
  try {
    const conn = (await gcal.connectionFor(f.mentor_user_id)) || (await gcal.connectionFor(Number(await settings.get('calendar_host_user_id')) || null));
    if (!conn) throw new Error('No Google Calendar is connected for the free-chat host. Connect one in Calendar → Google Calendar.');
    const ev = await gcal.upsertEvent(conn, {
      eventId: f.google_event_id, calendarId: f.google_calendar_id || conn.booking_calendar_id, requestId: `anvaya-fc${f.id}-${Date.now()}`,
      summary: `${TITLE} · ${f.name} (Anvaya)`, description: `Free chat booked on anvayacareers.in.\nName: ${f.name}\nPhone: ${f.phone}\nSituation: ${f.situation || '—'}`,
      start: f.scheduled_at, end: f.ends_at, attendees: [f.email, f.mentor_email].filter(Boolean),
    });
    await db.run(`update anvaya.freechats set google_event_id = $2, google_calendar_id = $3, meet_link = $4, calendar_host_user_id = $5, calendar_status = 'synced', calendar_error = '' where id = $1`,
      [f.id, ev.eventId, ev.calendarId, ev.meetLink, conn.user_id]);
  } catch (e) {
    await db.run("update anvaya.freechats set calendar_status = 'failed', calendar_error = $2 where id = $1", [f.id, String(e.message).slice(0, 300)]);
    await ops.createTask({ title: `Free chat Meet link failed for ${f.name}: ${String(e.message).slice(0, 120)}`, leadId: f.lead_id, ownerUserId: f.owner_user_id, source: 'calendar', dedupeKey: `fc-calfail:${f.id}` });
    throw e; // retried with backoff; no confirmation goes out without a real Meet link
  }
  await db.run("update anvaya.tasks set status = 'done', done_at = now() where dedupe_key = $1 and status = 'open'", [`fc-calfail:${id}`]);
  const s = await load(id);
  const k = new Date(s.scheduled_at).getTime();
  const gcalUrl = `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: 'TEMPLATE', text: `${TITLE} · Anvaya`, dates: `${fmtIcs(s.scheduled_at)}/${fmtIcs(s.ends_at)}`, details: `Join Google Meet: ${s.meet_link}`, location: s.meet_link, ctz: 'Asia/Kolkata' })}`;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Anvaya//Free chat//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:freechat-${s.id}@anvayacareers.in`, `DTSTAMP:${fmtIcs(new Date())}`,
    `DTSTART:${fmtIcs(s.scheduled_at)}`, `DTEND:${fmtIcs(s.ends_at)}`, `SUMMARY:${TITLE} · Anvaya`, `DESCRIPTION:Join Google Meet: ${s.meet_link}`, `LOCATION:${s.meet_link}`,
    'ORGANIZER;CN=Anvaya:mailto:connect@anvayacareers.in', 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const att = [{ filename: 'anvaya-free-chat.ics', content: ics, contentType: 'text/calendar; method=REQUEST' }];
  await sendEmail(s.email, 'freechat_confirmed', { ...common(s), meetLink: s.meet_link, gcalUrl, __attachments: att }, { dedupeKey: `fc-confirmed:${s.id}:${k}` });
  if (s.mentor_email) await sendEmail(s.mentor_email, 'session_confirmed', { ...common(s), studentName: `${s.name} (${s.phone})`, meetLink: s.meet_link, gcalUrl, icsUrl: null, forHost: true, __attachments: att }, { dedupeKey: `fc-confirmed:${s.id}:${k}:host` });
  await leadNote(s, `Free chat confirmed for ${ops.ist(s.scheduled_at)} · Meet link sent`);
  if (s.lead_id) await db.run("update anvaya.leads set follow_up_at = $2, next_action = 'Free chat booked' where id = $1", [s.lead_id, s.scheduled_at]);
  return { synced: true };
});
jobs.register('freechat.cancel', async ({ id }) => {
  const f = await load(id);
  if (!f?.google_event_id || !f.calendar_host_user_id) return { skipped: 'no event' };
  const conn = await gcal.connectionFor(f.calendar_host_user_id);
  if (!conn) throw new Error('Host Google Calendar is no longer connected; remove the event manually.');
  await gcal.cancelEvent(conn, { eventId: f.google_event_id, calendarId: f.google_calendar_id });
  await db.run("update anvaya.freechats set calendar_status = 'cancelled' where id = $1", [id]);
  return { cancelled: true };
});

/** Declines a request or cancels a confirmed chat; the visitor is told and pointed back to the website. */
async function cancel(id, user, reason = '') {
  const before = await load(id);
  if (!before) throw new HttpError(404, 'Free chat not found.');
  const declined = before.status === 'requested';
  await setStatus(id, ['requested', 'scheduled'], 'cancelled', ", cancelled_at = now(), hold_expires_at = null, cancel_reason = $4", [reason || (declined ? 'Declined' : 'Cancelled by Anvaya')]);
  await closeTasks(id, user?.id);
  if (before.google_event_id) { const j = await jobs.enqueue('freechat.cancel', { id }, { dedupeKey: `fccancel:${id}`, maxAttempts: 6 }); if (j) await jobs.runNow(j).catch(() => {}); }
  const f = await load(id);
  await sendEmail(f.email, 'freechat_declined', { ...common(f), reason, cancelled: !declined, chatUrl: `${SITE()}/#chat` }, { dedupeKey: `fc-declined:${f.id}` });
  if (!declined && f.mentor_email) await sendEmail(f.mentor_email, 'session_changed', { ...common(f), cancelled: true, previousAt: f.scheduled_at, reason, forHost: true, dashboardUrl: reviewUrl(f) }, { dedupeKey: `fc-cancel-host:${f.id}` });
  await leadNote(f, `Free chat ${declined ? 'declined' : 'cancelled'}${reason ? `: ${reason}` : ''}`);
  if (user) db.audit(user.id, declined ? 'freechat_declined' : 'freechat_cancelled', `freechat:${id}`);
}
async function outcome(id, user, status) {
  const f = await setStatus(id, ['scheduled'], status);
  await leadNote(f, status === 'completed' ? 'Free chat completed' : 'Didn’t join the free chat');
  db.audit(user.id, `freechat_${status}`, `freechat:${id}`);
}

async function expireHolds() {
  const rows = await db.all(`update anvaya.freechats set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Request expired before approval'
    where status = 'requested' and hold_expires_at < now() returning id`);
  for (const r of rows) {
    const f = await load(r.id);
    await closeTasks(f.id);
    await sendEmail(f.email, 'freechat_declined', { ...common(f), expired: true, chatUrl: `${SITE()}/#chat` }, { immediate: false, dedupeKey: `fc-expired:${f.id}` });
    await leadNote(f, 'Free-chat request expired before approval — follow up by phone');
  }
  return rows.length;
}

module.exports = { host, minutes, openSlots, request, load, notifyRequested, approve, sync, cancel, outcome, expireHolds, TITLE };
