'use strict';
// Syllabus (tracks → modules → assignments), colleges/cohorts, enrollments, mentor groups (auto + override),
// session calendar (live classes / mentor rooms), attendance, 1:1 bookings, assignment review.
const express = require('express');
const db = require('../../db');
const ledger = require('../../lib/ledger');
const bookingsLib = require('../../lib/bookings');
const subs = require('../../lib/subscriptions');
const settings = require('../../lib/settings');
const { sendEmail } = require('../../lib/email');
const jobs = require('../../lib/jobs');
const { HttpError, bad, v, id, wrap, fields, insertSql, updateSql } = require('../../lib/http');
const { staff, adminOnly, isAdmin } = require('./_shared');

const r = express.Router();
const BASE_URL = () => (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const ref = (table, label) => async (val) => {
  const n = v.id(val, label);
  if (n != null && !await db.one(`select 1 from anvaya.${table} where id = $1`, [n])) throw bad(`${label} not found.`);
  return n;
};
const activeMentorRef = async (val) => {
  const n = v.id(val, 'Mentor');
  if (n == null) return null;
  const m = await db.one('select status from anvaya.mentors where id = $1', [n]);
  if (!m || m.status !== 'active') throw bad('Only active mentors can be assigned.');
  return n;
};

/** Generic list/create/update/delete with per-operation roles. */
function resource(name, { table, list, spec, required = [], write = adminOnly, del = adminOnly, before }) {
  const parse = fields(spec, required);
  r.get(`/${name}`, staff, wrap(async (req, res) => res.json(await db.all(list(req), list.params ? list.params(req) : []))));
  r.post(`/${name}`, write, wrap(async (req, res) => {
    const f = await parse(req.body || {}, { partial: false });
    if (before) await before(f, req);
    const row = await db.one(...insertSql(table, f));
    res.status(201).json({ id: row.id });
  }));
  r.patch(`/${name}/:id`, write, wrap(async (req, res) => {
    const rid = id(req);
    if (!await db.one(`select 1 from anvaya.${table} where id = $1`, [rid])) throw new HttpError(404, 'Not found.');
    const f = await parse(req.body || {}, { partial: true });
    if (before) await before(f, req, rid);
    if (Object.keys(f).length) await db.run(...updateSql(table, f, rid));
    res.json({ ok: true });
  }));
  r.delete(`/${name}/:id`, del, wrap(async (req, res) => {
    const x = await db.run(`delete from anvaya.${table} where id = $1`, [id(req)]);
    if (!x.rowCount) throw new HttpError(404, 'Not found.');
    res.json({ ok: true });
  }));
}

resource('tracks', {
  table: 'tracks', list: () => `select t.*, (select count(*) from anvaya.modules m where m.track_id = t.id) as module_count,
    (select count(*) from anvaya.enrollments e where e.track_id = t.id and e.status = 'active') as enrolled from anvaya.tracks t order by t.name`,
  spec: { name: (x) => v.str(x, { max: 120, required: true, label: 'Name' }), target_role: (x) => v.str(x, { max: 120 }), description: (x) => v.str(x, { max: 3000 }), active: (x) => v.bool(x), is_test: (x) => v.bool(x) },
  required: ['name'],
});
resource('modules', {
  table: 'modules', list: () => `select m.*, t.name as track_name, (select count(*) from anvaya.assignments a where a.module_id = m.id) as assignment_count
    from anvaya.modules m join anvaya.tracks t on t.id = m.track_id order by t.name, m.position, m.id`,
  spec: { track_id: ref('tracks', 'Track'), title: (x) => v.str(x, { max: 200, required: true, label: 'Title' }), description: (x) => v.str(x, { max: 5000 }),
    position: (x) => v.int(x, { min: 0, max: 1000 }) ?? 0, week_number: (x) => v.int(x, { min: 0, max: 200 }) },
  required: ['track_id', 'title'],
});
resource('assignments', {
  table: 'assignments', list: () => `select a.*, m.title as module_title, t.name as track_name from anvaya.assignments a
    join anvaya.modules m on m.id = a.module_id join anvaya.tracks t on t.id = m.track_id order by t.name, m.position, a.position, a.id`,
  spec: { module_id: ref('modules', 'Module'), title: (x) => v.str(x, { max: 200, required: true, label: 'Title' }), instructions: (x) => v.str(x, { max: 5000 }),
    position: (x) => v.int(x, { min: 0, max: 1000 }) ?? 0, due_offset_days: (x) => v.int(x, { min: 0, max: 365 }) },
  required: ['module_id', 'title'],
});
resource('colleges', {
  table: 'colleges', list: () => `select c.*, (select count(*) from anvaya.cohorts k where k.college_id = c.id) as cohort_count from anvaya.colleges c order by c.name`,
  spec: { name: (x) => v.str(x, { max: 200, required: true, label: 'Name' }), city: (x) => v.str(x, { max: 80 }), notes: (x) => v.str(x, { max: 2000 }) },
  required: ['name'],
});
resource('cohorts', {
  table: 'cohorts', list: () => `select k.*, c.name as college_name, t.name as track_name, (select count(*) from anvaya.cohort_members cm where cm.cohort_id = k.id) as member_count
    from anvaya.cohorts k left join anvaya.colleges c on c.id = k.college_id left join anvaya.tracks t on t.id = k.track_id order by k.id desc`,
  spec: { name: (x) => v.str(x, { max: 200, required: true, label: 'Name' }), college_id: ref('colleges', 'College'), track_id: ref('tracks', 'Track'),
    starts_on: (x) => v.day(x), ends_on: (x) => v.day(x) },
  required: ['name'],
});
r.post('/cohorts/:id/members', adminOnly, wrap(async (req, res) => {
  const cid = id(req);
  const k = await db.one('select * from anvaya.cohorts where id = $1', [cid]);
  if (!k) throw new HttpError(404, 'Cohort not found.');
  const ids = (Array.isArray(req.body?.student_ids) ? req.body.student_ids : []).map((x) => v.id(x, 'Student', { required: true }));
  await db.tx(async (t) => {
    for (const sid of ids) {
      await t.run('insert into anvaya.cohort_members (cohort_id, student_id) values ($1,$2) on conflict do nothing', [cid, sid]);
      if (k.track_id) await t.run('insert into anvaya.enrollments (student_id, track_id, cohort_id) values ($1,$2,$3) on conflict (student_id, track_id) do update set cohort_id = excluded.cohort_id', [sid, k.track_id, cid]);
    }
  });
  res.json({ ok: true, added: ids.length });
}));
r.get('/cohorts/:id/report', staff, wrap(async (req, res) => {
  const cid = id(req);
  res.json(await db.all(`select s.id, s.name,
      (select count(*) filter (where a.status in ('present','late')) from anvaya.attendance a where a.student_id = s.id) as attended,
      (select count(*) from anvaya.attendance a where a.student_id = s.id) as marked,
      (select count(*) from anvaya.assignment_progress p where p.student_id = s.id and p.status in ('submitted','reviewed','done')) as assignments_done,
      (select count(*) from anvaya.applications ap where ap.student_id = s.id and ap.stage in ('shortlisted','interview','offer','accepted')) as positive_outcomes
    from anvaya.cohort_members cm join anvaya.students s on s.id = cm.student_id where cm.cohort_id = $1 order by s.name`, [cid]));
}));
r.post('/enrollments', staff, wrap(async (req, res) => {
  const sid = v.id(req.body?.student_id, 'Student', { required: true });
  const tid = v.id(req.body?.track_id, 'Track', { required: true });
  await db.run(`insert into anvaya.enrollments (student_id, track_id) values ($1,$2) on conflict (student_id, track_id) do update set status = 'active'`, [sid, tid]);
  await db.run('update anvaya.students set track_id = coalesce(track_id, $2) where id = $1', [sid, tid]);
  res.status(201).json({ ok: true });
}));

// ── Mentor groups ────────────────────────────────────────────────────
resource('groups', {
  table: 'mentor_groups', list: () => `select g.*, t.name as track_name, m.name as mentor_name, k.name as cohort_name,
    (select count(*) from anvaya.group_members gm where gm.group_id = g.id and gm.left_at is null) as member_count
    from anvaya.mentor_groups g left join anvaya.tracks t on t.id = g.track_id left join anvaya.mentors m on m.id = g.mentor_id
    left join anvaya.cohorts k on k.id = g.cohort_id order by g.active desc, g.name`,
  spec: { name: (x) => v.str(x, { max: 120, required: true, label: 'Name' }), track_id: ref('tracks', 'Track'), cohort_id: ref('cohorts', 'Cohort'), mentor_id: activeMentorRef,
    target_role: (x) => v.str(x, { max: 120 }), prep_level: (x) => v.str(x, { max: 60 }), availability: (x) => v.str(x, { max: 120 }),
    capacity: (x) => v.int(x, { min: 1, max: 100, label: 'Capacity' }), meet_link: (x) => v.url(x, 'Meet link'), whatsapp_link: (x) => v.url(x, 'WhatsApp link'), active: (x) => v.bool(x), is_test: (x) => v.bool(x) },
  required: ['name'], write: staff,
  before: async (f, _req, rid) => { if (!rid && f.capacity == null) f.capacity = Number(await settings.get('group_capacity_default')); },
});
r.get('/groups/:id/members', staff, wrap(async (req, res) => {
  res.json(await db.all(`select gm.id, gm.is_override, gm.joined_at, s.id as student_id, s.name, s.target_role, s.prep_level, s.availability_pref
    from anvaya.group_members gm join anvaya.students s on s.id = gm.student_id where gm.group_id = $1 and gm.left_at is null order by s.name`, [id(req)]));
}));
/** Manual assignment (admin/ops override): moves the student out of any current group. */
r.post('/groups/:id/members', staff, wrap(async (req, res) => {
  const gid = id(req);
  const sid = v.id(req.body?.student_id, 'Student', { required: true });
  await db.tx(async (t) => {
    const g = await t.one('select * from anvaya.mentor_groups where id = $1 for update', [gid]);
    if (!g) throw new HttpError(404, 'Group not found.');
    const count = (await t.one('select count(*) n from anvaya.group_members where group_id = $1 and left_at is null', [gid])).n;
    if (count >= g.capacity && !v.bool(req.body?.allow_over_capacity)) throw new HttpError(409, `This group is full (${g.capacity}). Increase its capacity or tick “allow over capacity”.`);
    await t.run('update anvaya.group_members set left_at = now() where student_id = $1 and left_at is null', [sid]);
    await t.run('insert into anvaya.group_members (group_id, student_id, is_override, assigned_by) values ($1,$2,true,$3)', [gid, sid, req.auth.user.id]);
  });
  res.status(201).json({ ok: true });
}));
r.delete('/groups/:id/members/:sid', staff, wrap(async (req, res) => {
  await db.run('update anvaya.group_members set left_at = now() where group_id = $1 and student_id = $2 and left_at is null', [id(req), id(req, 'sid')]);
  res.json({ ok: true });
}));
/** Auto-grouping: subscribers without a group are matched on track, target role, prep level and availability,
 *  only into groups with spare capacity. Manual overrides are never moved. */
r.post('/groups/auto-assign', staff, wrap(async (req, res) => {
  const dry = v.bool(req.body?.dry_run);
  const groups = await db.all(`select g.*, (select count(*) from anvaya.group_members gm where gm.group_id = g.id and gm.left_at is null) as members
    from anvaya.mentor_groups g where g.active`);
  const students = await db.all(`select s.* from anvaya.students s where s.status = 'active'
    and not exists (select 1 from anvaya.group_members gm where gm.student_id = s.id and gm.left_at is null)
    and exists (select 1 from anvaya.subscriptions x where x.student_id = s.id and (x.paid_through >= now() or x.grace_until >= now()) and x.access_status not in ('paused','cancelled'))`);
  const norm = (s) => String(s || '').toLowerCase().trim();
  const plan = [];
  for (const s of students) {
    let best = null;
    for (const g of groups) {
      if (g.members >= g.capacity) continue;
      if (g.track_id && s.track_id && g.track_id !== s.track_id) continue;
      let score = 0;
      if (g.track_id && g.track_id === s.track_id) score += 8;
      if (norm(g.target_role) && norm(g.target_role) === norm(s.target_role)) score += 4;
      if (norm(g.prep_level) && norm(g.prep_level) === norm(s.prep_level)) score += 3;
      if (norm(g.availability) && norm(s.availability_pref).includes(norm(g.availability))) score += 2;
      score -= g.members / Math.max(1, g.capacity); // prefer emptier groups on ties
      if (!best || score > best.score) best = { g, score };
    }
    if (best && best.score > 0) { plan.push({ student_id: s.id, student: s.name, group_id: best.g.id, group: best.g.name }); best.g.members++; }
    else plan.push({ student_id: s.id, student: s.name, group_id: null, group: null, reason: 'No matching group with space' });
  }
  if (!dry) {
    for (const p of plan.filter((x) => x.group_id)) {
      await db.run(`insert into anvaya.group_members (group_id, student_id, is_override, assigned_by) select $1,$2,false,$3
        where not exists (select 1 from anvaya.group_members where student_id = $2 and left_at is null)`, [p.group_id, p.student_id, req.auth.user.id]);
    }
  }
  res.json({ dry_run: dry, plan });
}));

// ── Session calendar ─────────────────────────────────────────────────
const liveSpec = {
  kind: (x) => v.oneOf(x, ['live_class', 'group_room'], 'Type'),
  title: (x) => v.str(x, { max: 200, required: true, label: 'Title' }),
  track_id: ref('tracks', 'Track'), group_id: ref('mentor_groups', 'Group'), cohort_id: ref('cohorts', 'Cohort'), mentor_id: activeMentorRef,
  starts_at: (x) => v.date(x, { required: true, label: 'Start' }), ends_at: (x) => v.date(x, { required: true, label: 'End' }),
  meet_link: (x) => v.url(x, 'Meet link'), status: (x) => v.oneOf(x, ['scheduled', 'completed', 'cancelled'], 'Status'),
  delivery_fee_paise: (x) => v.paise(x, { label: 'Delivery fee' }) ?? 0, notes: (x) => v.str(x, { max: 3000 }),
  is_test: (x) => v.bool(x),
};
r.get('/live-sessions', staff, wrap(async (req, res) => {
  const rows = await db.all(`select l.*, g.name as group_name, t.name as track_name, m.name as mentor_name, k.name as cohort_name,
    (select count(*) from anvaya.attendance a where a.live_session_id = l.id) as marked
    from anvaya.live_sessions l left join anvaya.mentor_groups g on g.id = l.group_id left join anvaya.tracks t on t.id = l.track_id
    left join anvaya.mentors m on m.id = l.mentor_id left join anvaya.cohorts k on k.id = l.cohort_id
    where l.starts_at > now() - interval '60 days' order by l.starts_at`);
  res.json(isAdmin(req) ? rows : rows.map(({ delivery_fee_paise, ...x }) => x));
}));
async function saveLive(req, rid) {
  const spec = { ...liveSpec };
  if (!isAdmin(req)) { delete spec.delivery_fee_paise; delete spec.is_test; } // money + test flag are admin-only
  const f = await fields(spec, rid ? [] : ['kind', 'title', 'starts_at', 'ends_at'])(req.body || {}, { partial: !!rid });
  if (f.starts_at && f.ends_at && f.ends_at <= f.starts_at) throw bad('The session must end after it starts.');
  if (!rid && !f.meet_link && f.group_id) f.meet_link = (await db.one('select meet_link from anvaya.mentor_groups where id = $1', [f.group_id]))?.meet_link || '';
  if (!rid && !f.mentor_id && f.group_id) f.mentor_id = (await db.one('select mentor_id from anvaya.mentor_groups where id = $1', [f.group_id]))?.mentor_id ?? null;
  return f;
}
r.post('/live-sessions', staff, wrap(async (req, res) => {
  const f = await saveLive(req);
  f.created_by = req.auth.user.id;
  const repeat = v.int(req.body?.repeat_weeks, { min: 0, max: 26 }) || 0;
  const ids = [];
  for (let w = 0; w <= repeat; w++) {
    const shift = w * 7 * 86400e3;
    const row = await db.one(...insertSql('live_sessions', { ...f, starts_at: new Date(new Date(f.starts_at).getTime() + shift).toISOString(), ends_at: new Date(new Date(f.ends_at).getTime() + shift).toISOString() }));
    ids.push(row.id);
  }
  res.status(201).json({ ids });
}));
r.patch('/live-sessions/:id', staff, wrap(async (req, res) => {
  const rid = id(req);
  const before = await db.one('select * from anvaya.live_sessions where id = $1', [rid]);
  if (!before) throw new HttpError(404, 'Session not found.');
  const f = await saveLive(req, rid);
  await db.tx(async (t) => {
    if (Object.keys(f).length) await t.run(...updateSql('live_sessions', f, rid));
    if (f.status === 'completed' && before.status !== 'completed') {
      await ledger.recordDeliveryFee(t, await t.one('select * from anvaya.live_sessions where id = $1', [rid]), req.auth.user.id);
    }
  });
  res.json({ ok: true });
}));
r.delete('/live-sessions/:id', adminOnly, wrap(async (req, res) => {
  await db.run('delete from anvaya.live_sessions where id = $1', [id(req)]);
  res.json({ ok: true });
}));

/** Who is expected at a live session: group members, else track enrollees with access, else cohort members. */
async function roster(live, q = db) {
  if (live.group_id) return q.all(`select s.id, s.name, s.email from anvaya.group_members gm join anvaya.students s on s.id = gm.student_id where gm.group_id = $1 and gm.left_at is null order by s.name`, [live.group_id]);
  if (live.cohort_id) return q.all(`select s.id, s.name, s.email from anvaya.cohort_members cm join anvaya.students s on s.id = cm.student_id where cm.cohort_id = $1 order by s.name`, [live.cohort_id]);
  if (live.track_id) return q.all(`select s.id, s.name, s.email from anvaya.enrollments e join anvaya.students s on s.id = e.student_id
    where e.track_id = $1 and e.status = 'active' and exists (select 1 from anvaya.subscriptions x where x.student_id = s.id and (x.paid_through >= now() or x.grace_until >= now())) order by s.name`, [live.track_id]);
  return q.all(`select s.id, s.name, s.email from anvaya.students s where exists (select 1 from anvaya.subscriptions x where x.student_id = s.id and (x.paid_through >= now() or x.grace_until >= now())) order by s.name`);
}
r.get('/live-sessions/:id/roster', staff, wrap(async (req, res) => {
  const live = await db.one('select * from anvaya.live_sessions where id = $1', [id(req)]);
  if (!live) throw new HttpError(404, 'Session not found.');
  const people = await roster(live);
  const marks = await db.all('select student_id, status from anvaya.attendance where live_session_id = $1', [live.id]);
  const m = new Map(marks.map((x) => [x.student_id, x.status]));
  res.json(people.map((p) => ({ id: p.id, name: p.name, status: m.get(p.id) || null })));
}));
async function markAttendance(t, { liveId, bookingId, marks, userId }) {
  for (const mk of marks) {
    const sid = v.id(mk.student_id, 'Student', { required: true });
    const st = v.oneOf(mk.status, ['present', 'late', 'absent', 'excused'], 'Attendance');
    if (liveId) await t.run(`insert into anvaya.attendance (live_session_id, student_id, status, marked_by) values ($1,$2,$3,$4)
      on conflict (live_session_id, student_id) where live_session_id is not null do update set status = excluded.status, marked_by = excluded.marked_by, marked_at = now()`, [liveId, sid, st, userId]);
    else await t.run(`insert into anvaya.attendance (booking_id, student_id, status, marked_by) values ($1,$2,$3,$4)
      on conflict (booking_id, student_id) where booking_id is not null do update set status = excluded.status, marked_by = excluded.marked_by, marked_at = now()`, [bookingId, sid, st, userId]);
  }
}
r.post('/live-sessions/:id/attendance', staff, wrap(async (req, res) => {
  const live = await db.one('select * from anvaya.live_sessions where id = $1', [id(req)]);
  if (!live) throw new HttpError(404, 'Session not found.');
  const marks = Array.isArray(req.body?.marks) ? req.body.marks : [];
  await db.tx((t) => markAttendance(t, { liveId: live.id, marks, userId: req.auth.user.id }));
  res.json({ ok: true, marked: marks.length });
}));
r.post('/live-sessions/:id/remind', staff, wrap(async (req, res) => {
  const live = await db.one('select * from anvaya.live_sessions where id = $1', [id(req)]);
  if (!live) throw new HttpError(404, 'Session not found.');
  let n = 0;
  for (const p of (await roster(live)).filter((x) => x.email)) {
    await sendEmail(p.email, 'session_reminder', { title: live.title, startsAt: live.starts_at, meetLink: live.meet_link, dashboardUrl: `${BASE_URL()}/student#sessions` },
      { immediate: false, dedupeKey: `remind-manual:${live.id}:${p.id}:${new Date().toISOString().slice(0, 13)}` });
    n++;
  }
  jobs.kick();
  res.json({ ok: true, queued: n });
}));

// ── 1:1 bookings ─────────────────────────────────────────────────────
r.get('/bookings', staff, wrap(async (req, res) => {
  const rows = await db.all(`select b.*, s.name as student_name, m.name as mentor_name,
    (select status from anvaya.attendance a where a.booking_id = b.id and a.student_id = b.student_id) as attendance
    from anvaya.bookings b join anvaya.students s on s.id = b.student_id left join anvaya.mentors m on m.id = b.mentor_id
    order by b.scheduled_at desc limit 500`);
  res.json(isAdmin(req) ? rows : rows.map(({ price_paise, mentor_fee_paise, ...x }) => x));
}));
r.get('/mentors/:id/slots', staff, wrap(async (req, res) => res.json(await bookingsLib.slots(id(req)))));
/** Staff-created booking: check-up (uses the student's plan) or a complimentary/manual-pay private session. */
r.post('/bookings', staff, wrap(async (req, res) => {
  const kind = v.oneOf(req.body?.kind || 'checkup', ['checkup', 'paid_session'], 'Type');
  const b = await bookingsLib.create({
    studentId: v.id(req.body?.student_id, 'Student', { required: true }), mentorId: v.id(req.body?.mentor_id, 'Mentor', { required: true }),
    startsAt: v.date(req.body?.scheduled_at, { required: true, label: 'Date & time' }), kind, service: v.str(req.body?.service, { max: 120 }),
    userId: req.auth.user.id, paymentMode: 'manual', allowOutsideAvailability: v.bool(req.body?.outside_availability),
  });
  res.status(201).json({ id: b.id, status: b.status });
}));
r.patch('/bookings/:id', staff, wrap(async (req, res) => {
  const bid = id(req);
  const b = await db.one('select * from anvaya.bookings where id = $1', [bid]);
  if (!b) throw new HttpError(404, 'Booking not found.');
  const spec = {
    scheduled_at: (x) => v.date(x, { required: true }), meeting_link: (x) => v.url(x, 'Meeting link'), service: (x) => v.str(x, { max: 120 }),
    status: (x) => v.oneOf(x, ['requested', 'scheduled', 'completed', 'cancelled', 'no_show'], 'Status'),
    cancel_reason: (x) => v.str(x, { max: 300 }),
  };
  if (isAdmin(req)) { spec.price_paise = (x) => v.paise(x, { label: 'Price' }) ?? 0; spec.mentor_fee_paise = (x) => v.paise(x, { label: 'Mentor fee' }) ?? 0; }
  const f = await fields(spec)(req.body || {}, { partial: true });
  if (f.status === 'cancelled') f.cancelled_at = new Date().toISOString();
  if (f.status === 'completed' && b.status !== 'completed') f.completed_at = new Date().toISOString();
  try {
    await db.tx(async (t) => {
      if (Object.keys(f).length) await t.run(...updateSql('bookings', f, bid));
      if (f.status === 'completed' && b.status !== 'completed') await ledger.recordSessionEarning(t, await t.one('select * from anvaya.bookings where id = $1', [bid]), req.auth.user.id);
      if (f.status === 'completed' || f.status === 'no_show') await markAttendance(t, { bookingId: bid, marks: [{ student_id: b.student_id, status: f.status === 'completed' ? 'present' : 'absent' }], userId: req.auth.user.id });
    });
  } catch (e) {
    if (/bookings_no_overlap|exclusion/.test(e.message)) throw new HttpError(409, 'The mentor already has a session at that time.');
    throw e;
  }
  res.json({ ok: true });
}));

// ── Assignment review ────────────────────────────────────────────────
r.get('/submissions', staff, wrap(async (_req, res) => {
  res.json(await db.all(`select p.*, s.name as student_name, a.title as assignment_title, m.title as module_title from anvaya.assignment_progress p
    join anvaya.students s on s.id = p.student_id join anvaya.assignments a on a.id = p.assignment_id join anvaya.modules m on m.id = a.module_id
    where p.status = 'submitted' order by p.submitted_at limit 200`));
}));
r.post('/submissions/review', staff, wrap(async (req, res) => {
  const sid = v.id(req.body?.student_id, 'Student', { required: true }), aid = v.id(req.body?.assignment_id, 'Assignment', { required: true });
  await db.run(`update anvaya.assignment_progress set status = $3, feedback = $4, reviewed_by = $5, reviewed_at = now(), updated_at = now()
    where student_id = $1 and assignment_id = $2`, [sid, aid, v.oneOf(req.body?.status || 'reviewed', ['reviewed', 'done', 'in_progress'], 'Status'), v.str(req.body?.feedback, { max: 3000 }), req.auth.user.id]);
  res.json({ ok: true });
}));

module.exports = Object.assign(r, { roster, markAttendance });
