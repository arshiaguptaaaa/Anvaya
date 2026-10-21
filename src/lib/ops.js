'use strict';
// Operations helpers shared by admin, student and automation code: the student timeline (internal notes,
// student-visible messages, system events) and tasks. A message's email status is only ever set from the
// real send result; "delivered" means Resend accepted it, never an assumption.
const db = require('../db');
const { sendEmail } = require('./email');
const { BASE_URL } = require('./accounts');

/** Adds a timeline entry. kind: internal_note | message | system. Returns the entry id. */
async function addEntry({ studentId = null, leadId = null, caseId = null, kind, body, userId = null, role = 'system' }, q = db) {
  const r = await q.one(`insert into anvaya.record_entries (student_id, lead_id, support_case_id, kind, body, author_user_id, author_role)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`, [studentId, leadId, caseId, kind, String(body).slice(0, 10000), userId, role]);
  return r.id;
}
const systemEvent = (studentId, body, q = db) => addEntry({ studentId, kind: 'system', body }, q);

/**
 * Posts a message the student can see (in their dashboard). With email=true it is also emailed through the
 * durable queue; the entry records queued → delivered/failed from the actual result.
 */
async function postMessage({ studentId, caseId = null, body, userId, role, fromName, email = false, subject = '' }) {
  const entryId = await addEntry({ studentId, caseId, kind: 'message', body, userId, role });
  if (!email) return { entryId, email: 'not_requested' };
  const s = await db.one('select email from anvaya.students where id = $1', [studentId]);
  if (!s?.email) {
    await db.run("update anvaya.record_entries set email_status = 'failed', email_error = 'No email address on file' where id = $1", [entryId]);
    return { entryId, email: 'failed' };
  }
  await db.run("update anvaya.record_entries set email_status = 'queued' where id = $1", [entryId]);
  const out = await sendEmail(s.email, 'staff_message', { body, subject, from: fromName, dashboardUrl: `${BASE_URL()}/student#messages`, __entryId: entryId });
  await db.run('update anvaya.record_entries set email_job_id = $2, email_status = $3, email_error = $4 where id = $1',
    [entryId, out.jobId, out.delivered ? 'delivered' : 'queued', out.delivered ? '' : String(out.error || '').slice(0, 300)]);
  return { entryId, email: out.delivered ? 'delivered' : 'queued' };
}

/** Creates a task; with dedupeKey it is created at most once (automation). Returns the id or null. */
async function createTask({ title, studentId = null, leadId = null, caseId = null, ownerUserId = null, dueAt = null, source = 'manual', dedupeKey = null, userId = null }, q = db) {
  const r = await q.one(`insert into anvaya.tasks (title, student_id, lead_id, support_case_id, owner_user_id, due_at, source, dedupe_key, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (dedupe_key) do nothing returning id`,
  [String(title).slice(0, 300), studentId, leadId, caseId, ownerUserId, dueAt, source, dedupeKey, userId]);
  return r?.id ?? null;
}

/** Cancels queued/failed reminder emails for a booking or live session whose time or status changed. */
async function cancelStaleReminders({ bookingId = null, liveId = null }, q = db) {
  const pattern = bookingId ? `remind:%:booking:${Number(bookingId)}:%` : `remind:%:live:${Number(liveId)}:%`;
  const r = await q.run(`update anvaya.jobs set status = 'cancelled', finished_at = now(), last_error = 'Session changed'
    where kind = 'email.send' and status in ('queued','failed') and dedupe_key like $1`, [pattern]);
  return r.rowCount;
}

/** Emails the student that a 1:1 session moved or was cancelled (once per change). */
async function notifyBookingChange(bookingId, { previousAt, cancelled = false, reason = '' }) {
  const b = await db.one('select b.*, s.email from anvaya.bookings b join anvaya.students s on s.id = b.student_id where b.id = $1', [bookingId]);
  if (!b?.email) return;
  await sendEmail(b.email, 'session_changed', { title: b.service || 'Mentor session', startsAt: b.scheduled_at, previousAt, cancelled, reason,
    dashboardUrl: `${BASE_URL()}/student#sessions` }, { immediate: false, dedupeKey: `changed:booking:${b.id}:${cancelled ? 'x' : new Date(b.scheduled_at).getTime()}` });
}

module.exports = { addEntry, systemEvent, postMessage, createTask, cancelStaleReminders, notifyBookingChange };
