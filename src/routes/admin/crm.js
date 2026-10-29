'use strict';
// CRM: leads (pipeline, owner, next action, follow-ups, activities), students, portal invites, follow-up queue.
const express = require('express');
const db = require('../../db');
const jobs = require('../../lib/jobs');
const accounts = require('../../lib/accounts');
const subs = require('../../lib/subscriptions');
const { HttpError, bad, v, id, wrap, fields, insertSql, updateSql } = require('../../lib/http');
const { staff, adminOnly, isAdmin, forRole } = require('./_shared');

const r = express.Router();
const LEAD_STATUS = ['new', 'contacted', 'qualified', 'converted', 'lost'];

const staffRef = async (val) => {
  const n = v.id(val, 'Owner');
  if (n == null) return null;
  if (!await db.one("select 1 from anvaya.users where id = $1 and role in ('admin','ops') and disabled_at is null", [n])) throw bad('Owner must be an active team member.');
  return n;
};
const leadFields = fields({
  name: (x) => v.str(x, { max: 120, required: true, label: 'Name' }),
  email: (x) => v.email(x, { required: false }),
  phone: (x) => v.str(x, { max: 40, label: 'Phone' }),
  situation: (x) => v.str(x, { max: 200, label: 'Situation' }),
  source: (x) => v.str(x, { max: 80, label: 'Source' }) || 'Manual',
  status: (x) => v.oneOf(x, LEAD_STATUS, 'Status'),
  owner_user_id: staffRef,
  next_action: (x) => v.str(x, { max: 300, label: 'Next action' }),
  follow_up_at: (x) => v.date(x, { label: 'Follow-up date' }),
  notes: (x) => v.str(x, { max: 3000, label: 'Notes' }),
  is_test: (x) => v.bool(x),
}, ['name']);

r.get('/team-options', staff, wrap(async (_req, res) => {
  res.json(await db.all("select id, coalesce(nullif(name,''), email) as name, role from anvaya.users where role in ('admin','ops') and disabled_at is null order by name"));
}));

// Visit sources (?src= link codes): clicks → free chats → checkouts → paid, by the latest code before each action.
r.get('/sources', staff, wrap(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
  const since = new Date(Date.now() - days * 86400e3);
  res.json(await db.all(`with v as (select source, sum(visits)::int as clicks from anvaya.ref_visits where day >= $1::date group by 1),
      l as (select coalesce(nullif(ref_source, ''), '(no code)') as source, count(*)::int as free_chats from anvaya.leads where created_at >= $1 group by 1),
      e as (select coalesce(nullif(ref_source, ''), '(no code)') as source, count(*)::int as checkouts,
              count(*) filter (where status = 'converted')::int as paid, coalesce(sum(amount_paise) filter (where status = 'converted'), 0)::bigint as paid_paise,
              count(*) filter (where entry = 'quiz')::int as via_quiz
            from anvaya.checkout_enquiries where started_at >= $1 group by 1)
    select coalesce(v.source, l.source, e.source) as source, coalesce(v.clicks, 0) as clicks, coalesce(l.free_chats, 0) as free_chats,
      coalesce(e.checkouts, 0) as checkouts, coalesce(e.paid, 0) as paid, coalesce(e.paid_paise, 0) as paid_paise, coalesce(e.via_quiz, 0) as via_quiz
    from v full join l on l.source = v.source full join e on e.source = coalesce(v.source, l.source)
    order by paid desc, checkouts desc, free_chats desc, clicks desc`, [since]));
}));

// Payment-page checkout enquiries: started / failed / abandoned / converted, with reminder delivery status.
r.get('/checkout-enquiries', staff, wrap(async (_req, res) => {
  const enquiries = require('../../lib/enquiries');
  const rows = await db.all(`select e.*, s.name as student_name from anvaya.checkout_enquiries e left join anvaya.students s on s.id = e.student_id
    order by e.last_activity_at desc limit 500`);
  for (const e of rows) e.follow_up = await enquiries.followUp(e);
  const since = new Date(Date.now() - 30 * 86400e3);
  const stats = await db.one(`select count(*)::int as total, count(*) filter (where status = 'converted')::int as converted,
      count(*) filter (where status = 'abandoned')::int as abandoned, count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'started')::int as started,
      count(*) filter (where status = 'converted' and (abandoned_at is not null or failed_at is not null))::int as recovered
    from anvaya.checkout_enquiries where started_at >= $1`, [since]);
  res.json({ rows, stats });
}));

r.get('/leads', staff, wrap(async (_req, res) => {
  res.json(await db.all(`select l.*, coalesce(nullif(u.name,''), u.email) as owner_name,
    (select count(*) from anvaya.lead_activities a where a.lead_id = l.id) as activity_count
    from anvaya.leads l left join anvaya.users u on u.id = l.owner_user_id order by l.id desc`));
}));
r.post('/leads', staff, wrap(async (req, res) => {
  const f = await leadFields(req.body || {}, { partial: false });
  const row = await db.one(...insertSql('leads', f));
  await db.run("insert into anvaya.lead_activities (lead_id, user_id, kind, body) values ($1,$2,'system','Lead created')", [row.id, req.auth.user.id]);
  res.status(201).json({ id: row.id });
}));
r.patch('/leads/:id', staff, wrap(async (req, res) => {
  const lid = id(req);
  const before = await db.one('select * from anvaya.leads where id = $1', [lid]);
  if (!before) throw new HttpError(404, 'Lead not found.');
  const f = await leadFields(req.body || {}, { partial: true });
  if (Object.keys(f).length) await db.run(...updateSql('leads', f, lid));
  if (f.status && f.status !== before.status) {
    await db.run("insert into anvaya.lead_activities (lead_id, user_id, kind, body) values ($1,$2,'status_change',$3)", [lid, req.auth.user.id, `${before.status} → ${f.status}`]);
  }
  res.json({ ok: true });
}));
r.delete('/leads/:id', adminOnly, wrap(async (req, res) => {
  const x = await db.run('delete from anvaya.leads where id = $1', [id(req)]);
  if (!x.rowCount) throw new HttpError(404, 'Lead not found.');
  res.json({ ok: true });
}));
r.get('/leads/:id/activities', staff, wrap(async (req, res) => {
  res.json(await db.all(`select a.*, coalesce(nullif(u.name,''), u.email) as user_name from anvaya.lead_activities a
    left join anvaya.users u on u.id = a.user_id where a.lead_id = $1 order by a.created_at desc`, [id(req)]));
}));
r.post('/leads/:id/activities', staff, wrap(async (req, res) => {
  const lid = id(req);
  if (!await db.one('select 1 from anvaya.leads where id = $1', [lid])) throw new HttpError(404, 'Lead not found.');
  const kind = v.oneOf(req.body?.kind || 'note', ['note', 'call', 'whatsapp', 'email', 'meeting'], 'Type');
  const body = v.str(req.body?.body, { max: 3000, required: true, label: 'Note' });
  await db.tx(async (t) => {
    await t.run('insert into anvaya.lead_activities (lead_id, user_id, kind, body) values ($1,$2,$3,$4)', [lid, req.auth.user.id, kind, body]);
    const next = req.body?.next_action !== undefined ? v.str(req.body.next_action, { max: 300 }) : undefined;
    const fu = req.body?.follow_up_at !== undefined ? v.date(req.body.follow_up_at) : undefined;
    if (next !== undefined || fu !== undefined) {
      await t.run('update anvaya.leads set next_action = coalesce($2, next_action), follow_up_at = case when $4 then $3::timestamptz else follow_up_at end, status = case when status = \'new\' then \'contacted\' else status end where id = $1',
        [lid, next ?? null, fu ?? null, fu !== undefined]);
    } else await t.run("update anvaya.leads set status = 'contacted' where id = $1 and status = 'new'", [lid]);
  });
  res.status(201).json({ ok: true });
}));
r.post('/leads/:id/sheet-retry', staff, wrap(async (req, res) => {
  const lid = id(req);
  await db.run("update anvaya.leads set sheet_sync_status = 'pending' where id = $1 and sheet_sync_status in ('failed','pending')", [lid]);
  await db.run("delete from anvaya.jobs where dedupe_key = $1 and status in ('done','dead','failed')", [`sheet:${lid}`]);
  const jobId = await jobs.enqueue('leads.sheet_sync', { leadId: lid }, { dedupeKey: `sheet:${lid}`, maxAttempts: 8 });
  const out = await jobs.runNow(jobId);
  const l = await db.one('select sheet_sync_status, sheet_sync_error from anvaya.leads where id = $1', [lid]);
  res.json({ ok: out.ok, ...l });
}));
r.post('/leads/:id/convert', staff, wrap(async (req, res) => {
  const lid = id(req);
  const l = await db.one('select * from anvaya.leads where id = $1', [lid]);
  if (!l) throw new HttpError(404, 'Lead not found.');
  if (l.student_id) throw bad('This lead has already been converted.');
  const sid = await db.tx(async (t) => {
    const s = await t.one('insert into anvaya.students (name, email, phone, stage, notes) values ($1,$2,$3,$4,$5) returning id', [l.name, l.email, l.phone, l.situation, l.notes]);
    await t.run("update anvaya.leads set status = 'converted', student_id = $1 where id = $2", [s.id, lid]);
    await t.run("insert into anvaya.lead_activities (lead_id, user_id, kind, body) values ($1,$2,'status_change','Converted to student')", [lid, req.auth.user.id]);
    return s.id;
  });
  res.json({ ok: true, student_id: sid });
}));

// ── Students ─────────────────────────────────────────────────────────
const mentorRef = async (val) => {
  const n = v.id(val, 'Mentor');
  if (n == null) return null;
  const m = await db.one('select status from anvaya.mentors where id = $1', [n]);
  if (!m) throw bad('Mentor not found.');
  if (m.status !== 'active') throw bad('Only active mentors can be assigned.');
  return n;
};
const trackRef = async (val) => {
  const n = v.id(val, 'Track');
  if (n != null && !await db.one('select 1 from anvaya.tracks where id = $1', [n])) throw bad('Track not found.');
  return n;
};
const studentSpec = {
  name: (x) => v.str(x, { max: 120, required: true, label: 'Name' }),
  email: (x) => v.email(x, { required: false }),
  phone: (x) => v.str(x, { max: 40, label: 'Phone' }),
  stage: (x) => v.str(x, { max: 200, label: 'Stage' }),
  goals: (x) => v.str(x, { max: 2000, label: 'Goals' }),
  plan: (x) => v.str(x, { max: 120, label: 'Plan' }),
  status: (x) => v.oneOf(x, ['active', 'paused', 'completed'], 'Status'),
  mentor_id: mentorRef,
  target_role: (x) => v.str(x, { max: 120, label: 'Target role' }),
  prep_level: (x) => v.str(x, { max: 60, label: 'Preparation level' }),
  availability_pref: (x) => v.str(x, { max: 200, label: 'Availability' }),
  track_id: trackRef,
  college_name: (x) => v.str(x, { max: 160, label: 'College' }),
  needs_followup: (x) => v.bool(x),
  followup_reason: (x) => v.str(x, { max: 300, label: 'Follow-up reason' }),
  notes: (x) => v.str(x, { max: 3000, label: 'Notes' }),
  is_test: (x) => v.bool(x),
};
const studentFieldsFor = (req) => {
  const spec = { ...studentSpec };
  if (!isAdmin(req)) { delete spec.notes; delete spec.is_test; } // sensitive admin notes; test flag is admin-only
  return fields(spec, ['name']);
};

/** Choosing a track enrols the student in it (syllabus + track classes). */
const enroll = (sid, tid) => db.run(`insert into anvaya.enrollments (student_id, track_id) values ($1,$2)
  on conflict (student_id, track_id) do update set status = 'active'`, [sid, tid]);

r.get('/students', staff, wrap(async (req, res) => {
  const rows = await db.all(`select s.*, m.name as mentor_name, t.name as track_name, u.email as account_email,
    (u.password_hash is not null) as has_account,
    (select g.name from anvaya.group_members gm join anvaya.mentor_groups g on g.id = gm.group_id where gm.student_id = s.id and gm.left_at is null) as group_name,
    (select count(*) from anvaya.bookings b where b.student_id = s.id) as booking_count,
    (select max(paid_through) from anvaya.subscriptions x where x.student_id = s.id) as paid_through
    from anvaya.students s left join anvaya.mentors m on m.id = s.mentor_id left join anvaya.tracks t on t.id = s.track_id
    left join anvaya.users u on u.id = s.user_id order by s.id desc`);
  res.json(forRole(req, rows));
}));
r.get('/students/:id', staff, wrap(async (req, res) => {
  const sid = id(req);
  const s = await db.one(`select s.*, m.name as mentor_name, t.name as track_name, u.email as account_email, (u.password_hash is not null) as has_account
    from anvaya.students s left join anvaya.mentors m on m.id = s.mentor_id left join anvaya.tracks t on t.id = s.track_id
    left join anvaya.users u on u.id = s.user_id where s.id = $1`, [sid]);
  if (!s) throw new HttpError(404, 'Student not found.');
  s.subscriptions = (await subs.forStudent(sid)).map((x) => (isAdmin(req) ? x : { ...x, price_paise: undefined }));
  s.group = await db.one(`select g.id, g.name, gm.is_override from anvaya.group_members gm join anvaya.mentor_groups g on g.id = gm.group_id
    where gm.student_id = $1 and gm.left_at is null`, [sid]);
  s.bookings = await db.all(`select b.id, b.kind, b.service, b.scheduled_at, b.status, m.name as mentor_name ${isAdmin(req) ? ', b.price_paise' : ''}
    from anvaya.bookings b left join anvaya.mentors m on m.id = b.mentor_id where b.student_id = $1 order by b.scheduled_at desc limit 30`, [sid]);
  s.attendance = await db.all(`select a.status, a.marked_at, coalesce(l.title, b.service) as title from anvaya.attendance a
    left join anvaya.live_sessions l on l.id = a.live_session_id left join anvaya.bookings b on b.id = a.booking_id where a.student_id = $1 order by a.marked_at desc limit 20`, [sid]);
  s.cases = await db.all('select id, kind, status, due_at from anvaya.service_cases where student_id = $1 order by id desc', [sid]);
  s.applications = await db.all('select company, role_title, stage, updated_at from anvaya.applications where student_id = $1 order by updated_at desc', [sid]);
  s.documents = await db.all(`select d.id, d.kind, d.title, d.created_at, (select max(id) from anvaya.document_versions v where v.document_id = d.id and v.status = 'ready') as latest_version_id
    from anvaya.documents d where d.student_id = $1 and d.kind <> 'playbook' order by d.id desc`, [sid]);
  s.cohorts = await db.all('select c.id, c.name from anvaya.cohort_members cm join anvaya.cohorts c on c.id = cm.cohort_id where cm.student_id = $1', [sid]);
  res.json(forRole(req, s));
}));
r.post('/students', staff, wrap(async (req, res) => {
  const f = await studentFieldsFor(req)(req.body || {}, { partial: false });
  const row = await db.one(...insertSql('students', f));
  if (f.track_id) await enroll(row.id, f.track_id);
  res.status(201).json({ id: row.id });
}));
r.patch('/students/:id', staff, wrap(async (req, res) => {
  const sid = id(req);
  if (!await db.one('select 1 from anvaya.students where id = $1', [sid])) throw new HttpError(404, 'Student not found.');
  const f = await studentFieldsFor(req)(req.body || {}, { partial: true });
  if (Object.keys(f).length) await db.run(...updateSql('students', f, sid));
  if (f.track_id) await enroll(sid, f.track_id);
  res.json({ ok: true });
}));
r.delete('/students/:id', adminOnly, wrap(async (req, res) => {
  const sid = id(req);
  if (await db.one("select 1 from anvaya.orders where student_id = $1 and status in ('paid','partially_refunded')", [sid])) throw bad('This student has paid orders; mark them inactive instead of deleting.');
  const x = await db.run('delete from anvaya.students where id = $1', [sid]);
  if (!x.rowCount) throw new HttpError(404, 'Student not found.');
  res.json({ ok: true });
}));

/** Creates (or re-sends) the student's portal account invitation. */
r.post('/students/:id/invite', staff, wrap(async (req, res) => {
  const sid = id(req);
  const s = await db.one('select * from anvaya.students where id = $1', [sid]);
  if (!s) throw new HttpError(404, 'Student not found.');
  const email = v.email(req.body?.email || s.email);
  let userId = s.user_id;
  if (!userId) {
    const clash = await db.one('select id, role from anvaya.users where lower(email) = $1', [email]);
    if (clash) throw new HttpError(409, 'Another account already uses this email.');
    userId = await db.tx(async (t) => {
      const u = await t.one("insert into anvaya.users (email, name, role) values ($1,$2,'student') returning id", [email, s.name]);
      await t.run('update anvaya.students set user_id = $1, email = coalesce(nullif(email, \'\'), $2) where id = $3', [u.id, email, sid]);
      return u.id;
    });
  }
  const u = await db.one('select password_hash from anvaya.users where id = $1', [userId]);
  if (u.password_hash) throw bad('This student already has an active account. They can use “Forgot password” on the sign-in page.');
  const out = await accounts.issue(userId, 'student_invite', { isResend: !!s.user_id, byUserId: req.auth.user.id });
  res.json({ ok: true, delivered: out.delivered, mailError: out.error, expiresAt: out.expiresAt });
}));

// ── Follow-up queue (ops) ────────────────────────────────────────────
r.get('/followups', staff, wrap(async (_req, res) => {
  res.json({
    leads: await db.all(`select l.id, l.name, l.phone, l.status, l.next_action, l.follow_up_at, coalesce(nullif(u.name,''), u.email) as owner_name
      from anvaya.leads l left join anvaya.users u on u.id = l.owner_user_id
      where l.status not in ('converted','lost') and (l.follow_up_at is null or l.follow_up_at <= now() + interval '1 day') order by l.follow_up_at nulls first limit 100`),
    flagged: await db.all("select id, name, phone, followup_reason from anvaya.students where needs_followup order by name"),
    absences: await db.all(`select s.id, s.name, s.phone, count(*) as missed from anvaya.attendance a join anvaya.students s on s.id = a.student_id
      where a.status = 'absent' and a.marked_at > now() - interval '21 days' group by s.id having count(*) >= 2 order by missed desc`),
    overdueAssignments: await db.all(`select s.id, s.name, count(*) as overdue from anvaya.enrollments e
      join anvaya.students s on s.id = e.student_id join anvaya.modules mo on mo.track_id = e.track_id join anvaya.assignments a on a.module_id = mo.id
      left join anvaya.assignment_progress p on p.assignment_id = a.id and p.student_id = s.id
      where e.status = 'active' and a.due_offset_days is not null and e.started_at + make_interval(days => a.due_offset_days) < now()
        and coalesce(p.status, 'not_started') in ('not_started','in_progress') group by s.id order by overdue desc limit 100`),
    inGrace: await db.all(`select s.id, s.name, s.phone, x.paid_through, x.grace_until from anvaya.subscriptions x join anvaya.students s on s.id = x.student_id
      where x.paid_through < now() and x.grace_until >= now() order by x.grace_until`),
    intakePending: await db.all(`select s.id, s.name, s.phone from anvaya.students s join anvaya.users u on u.id = s.user_id
      where s.intake_completed_at is null and u.password_hash is not null order by s.id desc limit 50`),
  });
}));

module.exports = r;
