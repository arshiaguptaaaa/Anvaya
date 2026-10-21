'use strict';
// Mentor API — every query is scoped to req.auth.mentor.id. IDs from the client are never trusted for ownership:
// another mentor's booking, student, group or case returns 404.
const express = require('express');
const db = require('../db');
const sec = require('../security');
const ledger = require('../lib/ledger');
const { MENTOR_STUDENTS } = require('../lib/documents');
const { markAttendance, roster } = require('./admin/learning');
const { HttpError, bad, v, id, wrap, fields, setClause } = require('../lib/http');

const r = express.Router();
r.use(sec.requireRole('mentor'));

async function mentorProfile(mid) {
  const m = await db.one(`select m.id, m.name, m.expertise, m.bio, m.session_price_paise, m.checkup_fee_paise, m.session_duration, m.session_details,
    m.meeting_link, m.phone, m.linkedin, m.timezone, m.status, m.profile_completed, m.accepts_paid_sessions, m.headline, m.years_experience, m.target_roles, m.buffer_minutes, u.email
    from anvaya.mentors m join anvaya.users u on u.id = m.user_id where m.id = $1`, [mid]);
  m.availability = await db.all('select weekday, start_time, end_time from anvaya.availability where mentor_id = $1 order by weekday, start_time', [mid]);
  return m;
}
const profileFields = fields({
  name: (x) => v.str(x, { max: 120, required: true, label: 'Name' }),
  expertise: (x) => v.str(x, { max: 300, required: true, label: 'Expertise' }),
  bio: (x) => v.str(x, { max: 3000, required: true, label: 'Bio' }),
  session_duration: (x) => v.int(x, { min: 15, max: 240, label: 'Session duration' }) ?? 45,
  session_details: (x) => v.str(x, { max: 2000, label: 'Session details' }),
  meeting_link: (x) => v.url(x, 'Meeting link'),
  phone: (x) => v.str(x, { max: 40, label: 'Phone' }),
  linkedin: (x) => v.url(x, 'LinkedIn URL'),
  timezone: (x) => v.str(x, { max: 60, label: 'Time zone' }) || 'Asia/Kolkata',
  headline: (x) => v.str(x, { max: 160, label: 'Headline' }),
  years_experience: (x) => v.int(x, { min: 0, max: 60, label: 'Years of experience' }),
  target_roles: (x) => v.str(x, { max: 300, label: 'Roles you prepare students for' }),
  buffer_minutes: (x) => v.int(x, { min: 0, max: 120, label: 'Buffer between sessions' }) ?? 0,
});
function parseAvailability(list) {
  if (!Array.isArray(list)) throw bad('Availability must be a list.');
  if (list.length > 50) throw bad('Too many availability slots.');
  return list.map((s) => {
    const weekday = v.int(s.weekday, { min: 0, max: 6, label: 'Day', required: true });
    const start = v.time(s.start_time), end = v.time(s.end_time);
    if (end <= start) throw bad('Each availability slot must end after it starts.');
    return { weekday, start, end };
  });
}
async function saveAvailability(t, mid, slots) {
  await t.run('delete from anvaya.availability where mentor_id = $1', [mid]);
  for (const s of slots) await t.run('insert into anvaya.availability (mentor_id, weekday, start_time, end_time) values ($1,$2,$3,$4)', [mid, s.weekday, s.start, s.end]);
}

// Onboarding is open to an invited mentor who has set a password but isn't active yet.
r.get('/me', wrap(async (req, res) => res.json(await mentorProfile(req.auth.mentor.id))));
r.post('/onboarding', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  const f = await profileFields(req.body || {}, { partial: false });
  for (const k of ['name', 'expertise', 'bio']) if (!f[k]) throw bad(`${k[0].toUpperCase() + k.slice(1)} is required.`);
  const slots = parseAvailability(req.body?.availability || []);
  if (!slots.length) throw bad('Please add at least one availability slot.');
  await db.tx(async (t) => {
    const keys = Object.keys(f);
    await t.run(`update anvaya.mentors set ${setClause(keys)}, profile_completed = true,
      status = case when status = 'deactivated' then status else 'active' end, updated_at = now() where id = $${keys.length + 1}`, [...keys.map((k) => f[k]), mid]);
    await t.run('update anvaya.users set name = $1 where id = $2', [f.name, req.auth.user.id]);
    await saveAvailability(t, mid, slots);
  });
  db.audit(req.auth.user.id, 'mentor_onboarded', `mentor:${mid}`);
  res.json({ ok: true, next: '/mentor' });
}));

r.use(sec.requireActiveMentor);

r.patch('/me', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  const f = await profileFields(req.body || {}, { partial: true }); // price, fees, email and status are admin-controlled
  const keys = Object.keys(f);
  if (keys.length) await db.run(`update anvaya.mentors set ${setClause(keys)}, updated_at = now() where id = $${keys.length + 1}`, [...keys.map((k) => f[k]), mid]);
  res.json(await mentorProfile(mid));
}));
r.put('/availability', wrap(async (req, res) => {
  const slots = parseAvailability(req.body?.availability);
  await db.tx((t) => saveAvailability(t, req.auth.mentor.id, slots));
  res.json((await mentorProfile(req.auth.mentor.id)).availability);
}));

const OWN_STUDENTS = `s.id in ${MENTOR_STUDENTS}`;
const studentPublicCols = 's.id, s.name, s.email, s.phone, s.stage, s.goals, s.plan, s.status, s.target_role, s.prep_level, s.linkedin, s.college_name'; // never admin notes

r.get('/overview', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  const n = async (sql) => (await db.one(sql, [mid])).n;
  const bal = await ledger.balance(mid);
  res.json({
    upcoming: await db.all(`select * from (
        select 'booking' as type, b.id, b.scheduled_at as starts_at, b.duration, b.service as title, b.meeting_link, s.name as student_name, b.kind
          from anvaya.bookings b join anvaya.students s on s.id = b.student_id where b.mentor_id = $1 and b.status in ('scheduled','requested') and b.scheduled_at >= now()
        union all
        select 'live', l.id, l.starts_at, extract(epoch from (l.ends_at - l.starts_at))::int / 60, l.title, l.meet_link, g.name, l.kind
          from anvaya.live_sessions l left join anvaya.mentor_groups g on g.id = l.group_id
          where (l.mentor_id = $1 or g.mentor_id = $1) and l.status = 'scheduled' and l.starts_at >= now()) x order by starts_at limit 8`, [mid]),
    stats: {
      students: await n(`select count(*) n from anvaya.students s where ${OWN_STUDENTS}`),
      upcoming: await n("select count(*) n from anvaya.bookings where mentor_id = $1 and status = 'scheduled' and scheduled_at >= now()"),
      completed: bal.completed_sessions,
      earned: bal.earned_sessions + bal.delivery_fees + bal.service_fees + bal.adjustments,
      payable: bal.payable,
      reviews: await n(`select count(*) n from anvaya.assignment_progress p join anvaya.students s on s.id = p.student_id where p.status = 'submitted' and ${OWN_STUDENTS}`)
        + await n("select count(*) n from anvaya.service_cases where coach_mentor_id = $1 and status in ('assigned','first_draft','coach_edit','revision')"),
    },
  });
}));

r.get('/bookings', wrap(async (req, res) => {
  res.json(await db.all(`select b.id, b.student_id, b.kind, b.service, b.scheduled_at, b.duration, b.status, b.mentor_fee_paise, b.meeting_link,
    b.session_notes, b.notes_visibility, b.intake_answers, b.service_id, b.completed_at, s.name as student_name,
    (select ms.intake_questions from anvaya.mentor_services ms where ms.id = b.service_id) as intake_questions,
    (select status from anvaya.attendance a where a.booking_id = b.id) as attendance
    from anvaya.bookings b join anvaya.students s on s.id = b.student_id where b.mentor_id = $1 and b.status <> 'pending_payment' order by b.scheduled_at desc`, [req.auth.mentor.id]));
}));
async function ownBooking(req) {
  const b = await db.one('select * from anvaya.bookings where id = $1 and mentor_id = $2', [id(req), req.auth.mentor.id]);
  if (!b) throw new HttpError(404, 'Booking not found.');
  return b;
}
r.patch('/bookings/:id', wrap(async (req, res) => {
  const b = await ownBooking(req);
  const notes = req.body?.session_notes !== undefined ? v.str(req.body.session_notes, { max: 10000, label: 'Session notes' }) : b.session_notes;
  // private = only this mentor · staff = mentor + Anvaya team · student = also shown to the student
  const vis = req.body?.notes_visibility !== undefined ? v.oneOf(req.body.notes_visibility, ['private', 'staff', 'student'], 'Who can see the notes') : b.notes_visibility;
  await db.run('update anvaya.bookings set session_notes = $1, notes_visibility = $2 where id = $3 and mentor_id = $4', [notes, vis, b.id, req.auth.mentor.id]);
  res.json({ ok: true });
}));

// ── Services (each new or edited service needs admin approval before students can book it) ──
const serviceFields = fields({
  title: (x) => v.str(x, { max: 120, required: true, label: 'Service name' }),
  description: (x) => v.str(x, { max: 2000, label: 'Description' }),
  duration_min: (x) => v.int(x, { min: 15, max: 240, required: true, label: 'Duration (minutes)' }),
  price_paise: (x) => v.paise(x, { required: true, label: 'Price' }),
  active: (x) => v.bool(x),
  intake_questions: (x) => {
    const list = Array.isArray(x) ? x.slice(0, 8) : [];
    return JSON.stringify(list.map((q, i) => ({ id: `q${i + 1}`, label: v.str(q?.label, { max: 200, required: true, label: 'Question' }), required: v.bool(q?.required) })));
  },
}, ['title', 'duration_min', 'price_paise']);
r.get('/services', wrap(async (req, res) => {
  res.json(await db.all('select * from anvaya.mentor_services where mentor_id = $1 order by active desc, id', [req.auth.mentor.id]));
}));
r.post('/services', wrap(async (req, res) => {
  const f = await serviceFields(req.body || {}, { partial: false });
  const row = await db.one(`insert into anvaya.mentor_services (mentor_id, title, description, duration_min, price_paise, intake_questions, active)
    values ($1,$2,$3,$4,$5,coalesce($6::jsonb,'[]'),coalesce($7, true)) returning id`,
  [req.auth.mentor.id, f.title, f.description || '', f.duration_min, f.price_paise, f.intake_questions ?? null, f.active ?? null]);
  db.audit(req.auth.user.id, 'mentor_service_submitted', `service:${row.id}`);
  res.status(201).json({ id: row.id, approval: 'pending' });
}));
r.patch('/services/:id', wrap(async (req, res) => {
  const s = await db.one('select * from anvaya.mentor_services where id = $1 and mentor_id = $2', [id(req), req.auth.mentor.id]);
  if (!s) throw new HttpError(404, 'Service not found.');
  const f = await serviceFields(req.body || {}, { partial: true });
  const keys = Object.keys(f);
  if (!keys.length) return res.json({ ok: true });
  const needsApproval = keys.some((k) => ['title', 'description', 'duration_min', 'price_paise', 'intake_questions'].includes(k));
  await db.run(`update anvaya.mentor_services set ${keys.map((k, i) => `${k} = $${i + 2}${k === 'intake_questions' ? '::jsonb' : ''}`).join(', ')},
      updated_at = now() ${needsApproval ? ", approval = 'pending', approved_by = null, approved_at = null" : ''} where id = $1`, [s.id, ...keys.map((k) => f[k])]);
  res.json({ ok: true, approval: needsApproval ? 'pending' : s.approval });
}));
r.get('/agenda', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  res.json(await db.all(`select * from (
      select 'booking' as type, b.id, b.service as title, b.scheduled_at as starts_at, b.ends_at, b.status, b.kind, s.name as student_name, b.intake_answers
        from anvaya.bookings b join anvaya.students s on s.id = b.student_id where b.mentor_id = $1 and b.status in ('scheduled','requested') and b.ends_at > now() - interval '1 hour'
      union all select 'live', l.id, l.title, l.starts_at, l.ends_at, l.status, l.kind, g.name, '{}'::jsonb
        from anvaya.live_sessions l left join anvaya.mentor_groups g on g.id = l.group_id where l.mentor_id = $1 and l.status = 'scheduled' and l.ends_at > now() - interval '1 hour'
    ) x where starts_at < now() + interval '14 days' order by starts_at`, [mid]));
}));
r.post('/bookings/:id/complete', wrap(async (req, res) => {
  const b = await ownBooking(req);
  if (b.status !== 'scheduled') throw bad(`This session is ${b.status.replace('_', ' ')}, so it can’t be marked completed.`);
  if (new Date(b.scheduled_at) > new Date(Date.now() + 15 * 60e3)) throw bad('You can mark a session completed once it has started.');
  const notes = req.body?.session_notes !== undefined ? v.str(req.body.session_notes, { max: 10000, label: 'Session notes' }) : b.session_notes;
  await db.tx(async (t) => {
    const u = await t.one(`update anvaya.bookings set status = 'completed', completed_at = now(), session_notes = $1
      where id = $2 and mentor_id = $3 and status = 'scheduled' returning *`, [notes, b.id, req.auth.mentor.id]);
    if (!u) throw bad('This session was already updated.');
    await ledger.recordSessionEarning(t, u, req.auth.user.id);
    await markAttendance(t, { bookingId: b.id, marks: [{ student_id: b.student_id, status: 'present' }], userId: req.auth.user.id });
  });
  res.json({ ok: true });
}));
r.post('/bookings/:id/no-show', wrap(async (req, res) => {
  const b = await ownBooking(req);
  if (b.status !== 'scheduled') throw bad('Only scheduled sessions can be marked as a no-show.');
  await db.tx(async (t) => {
    await t.run("update anvaya.bookings set status = 'no_show' where id = $1", [b.id]);
    await markAttendance(t, { bookingId: b.id, marks: [{ student_id: b.student_id, status: 'absent' }], userId: req.auth.user.id });
    await t.run("update anvaya.students set needs_followup = true, followup_reason = 'Missed a 1:1 session' where id = $1", [b.student_id]);
  });
  res.json({ ok: true });
}));

r.get('/students', wrap(async (req, res) => {
  res.json(await db.all(`select ${studentPublicCols},
    (select count(*) from anvaya.bookings b where b.student_id = s.id and b.mentor_id = $1) as sessions,
    (select min(scheduled_at) from anvaya.bookings b where b.student_id = s.id and b.mentor_id = $1 and b.status = 'scheduled' and b.scheduled_at >= now()) as next_session,
    (select g.name from anvaya.group_members gm join anvaya.mentor_groups g on g.id = gm.group_id where gm.student_id = s.id and gm.left_at is null and g.mentor_id = $1) as group_name
    from anvaya.students s where ${OWN_STUDENTS} order by s.name`, [req.auth.mentor.id]));
}));
r.get('/students/:id', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  const s = await db.one(`select ${studentPublicCols} from anvaya.students s where s.id = $2 and ${OWN_STUDENTS}`, [mid, id(req)]);
  if (!s) throw new HttpError(404, 'Student not found.');
  s.bookings = await db.all(`select id, kind, service, scheduled_at, status, session_notes from anvaya.bookings where student_id = $1 and mentor_id = $2 order by scheduled_at desc`, [s.id, mid]);
  s.documents = await db.all(`select d.id, d.kind, d.title, (select max(v.id) from anvaya.document_versions v where v.document_id = d.id and v.status = 'ready') as latest_version_id
    from anvaya.documents d where d.student_id = $1 and (d.kind in ('resume_upload','final','linkedin') or d.case_id in (select id from anvaya.service_cases where coach_mentor_id = $2))
    order by d.id desc`, [s.id, mid]);
  s.progress = await db.all(`select a.title, m.title as module_title, coalesce(p.status, 'not_started') as status from anvaya.enrollments e
    join anvaya.modules m on m.track_id = e.track_id join anvaya.assignments a on a.module_id = m.id
    left join anvaya.assignment_progress p on p.assignment_id = a.id and p.student_id = e.student_id
    where e.student_id = $1 and e.status = 'active' order by m.position, a.position`, [s.id]);
  res.json(s);
}));

// ── Groups & live sessions they run ──────────────────────────────────
r.get('/groups', wrap(async (req, res) => {
  const groups = await db.all(`select g.id, g.name, g.target_role, g.prep_level, g.capacity, g.meet_link, g.whatsapp_link, t.name as track_name
    from anvaya.mentor_groups g left join anvaya.tracks t on t.id = g.track_id where g.mentor_id = $1 and g.active order by g.name`, [req.auth.mentor.id]);
  for (const g of groups) g.members = await db.all(`select s.id, s.name from anvaya.group_members gm join anvaya.students s on s.id = gm.student_id
    where gm.group_id = $1 and gm.left_at is null order by s.name`, [g.id]);
  res.json(groups);
}));
async function ownLive(req) {
  const l = await db.one(`select l.* from anvaya.live_sessions l left join anvaya.mentor_groups g on g.id = l.group_id
    where l.id = $1 and (l.mentor_id = $2 or g.mentor_id = $2)`, [id(req), req.auth.mentor.id]);
  if (!l) throw new HttpError(404, 'Session not found.');
  return l;
}
r.get('/live-sessions', wrap(async (req, res) => {
  res.json(await db.all(`select l.id, l.kind, l.title, l.starts_at, l.ends_at, l.meet_link, l.status, g.name as group_name,
    (select count(*) from anvaya.attendance a where a.live_session_id = l.id) as marked
    from anvaya.live_sessions l left join anvaya.mentor_groups g on g.id = l.group_id
    where (l.mentor_id = $1 or g.mentor_id = $1) and l.starts_at > now() - interval '30 days' order by l.starts_at`, [req.auth.mentor.id]));
}));
r.get('/live-sessions/:id/roster', wrap(async (req, res) => {
  const l = await ownLive(req);
  const people = await roster(l);
  const marks = new Map((await db.all('select student_id, status from anvaya.attendance where live_session_id = $1', [l.id])).map((x) => [x.student_id, x.status]));
  res.json(people.map((p) => ({ id: p.id, name: p.name, status: marks.get(p.id) || null })));
}));
r.post('/live-sessions/:id/attendance', wrap(async (req, res) => {
  const l = await ownLive(req);
  const allowed = new Set((await roster(l)).map((p) => p.id));
  const marks = (Array.isArray(req.body?.marks) ? req.body.marks : []).filter((m) => allowed.has(Number(m.student_id)));
  await db.tx((t) => markAttendance(t, { liveId: l.id, marks, userId: req.auth.user.id }));
  res.json({ ok: true, marked: marks.length });
}));

// ── Review tasks: assignment submissions + coached service cases ─────
r.get('/reviews', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  res.json({
    submissions: await db.all(`select p.student_id, p.assignment_id, p.submission, p.submitted_at, s.name as student_name, a.title as assignment_title
      from anvaya.assignment_progress p join anvaya.students s on s.id = p.student_id join anvaya.assignments a on a.id = p.assignment_id
      where p.status = 'submitted' and ${OWN_STUDENTS} order by p.submitted_at`, [mid]),
    cases: await db.all(`select c.id, c.kind, c.status, c.due_at, s.name as student_name from anvaya.service_cases c join anvaya.students s on s.id = c.student_id
      where c.coach_mentor_id = $1 and c.status not in ('closed','cancelled') order by c.due_at nulls last`, [mid]),
  });
}));
r.post('/reviews/submission', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  const sid = v.id(req.body?.student_id, 'Student', { required: true }), aid = v.id(req.body?.assignment_id, 'Assignment', { required: true });
  if (!await db.one(`select 1 from anvaya.students s where s.id = $2 and ${OWN_STUDENTS}`, [mid, sid])) throw new HttpError(404, 'Not found.');
  const x = await db.run(`update anvaya.assignment_progress set status = $3, feedback = $4, reviewed_by = $5, reviewed_at = now(), updated_at = now()
    where student_id = $1 and assignment_id = $2 and status = 'submitted'`,
  [sid, aid, v.oneOf(req.body?.status || 'reviewed', ['reviewed', 'done', 'in_progress'], 'Status'), v.str(req.body?.feedback, { max: 3000 }), req.auth.user.id]);
  if (!x.rowCount) throw new HttpError(404, 'Submission not found.');
  res.json({ ok: true });
}));

// ── Earnings (ledger) ────────────────────────────────────────────────
r.get('/earnings', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  res.json({
    balance: await ledger.balance(mid),
    byMonth: await db.all(`select to_char(date_trunc('month', created_at at time zone 'Asia/Kolkata'), 'YYYY-MM') as month,
      count(*) filter (where kind = 'session_earning') as sessions, sum(amount_paise) filter (where kind <> 'payout') as amount_paise
      from anvaya.mentor_ledger where mentor_id = $1 group by 1 order by 1 desc`, [mid]),
    entries: await db.all(`select l.id, l.kind, l.amount_paise, l.note, l.created_at, s.name as student_name from anvaya.mentor_ledger l
      left join anvaya.bookings b on b.id = l.booking_id left join anvaya.students s on s.id = b.student_id where l.mentor_id = $1 order by l.created_at desc limit 200`, [mid]),
    payouts: await db.all('select amount_paise, method, reference, paid_at from anvaya.payouts where mentor_id = $1 order by paid_at desc', [mid]),
  });
}));

module.exports = r;
