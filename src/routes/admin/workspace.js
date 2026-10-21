'use strict';
// Operations workspace (admin + ops): Today, saved queues, tasks, owners and follow-ups, searchable lead and
// student tables with saved views and bulk assignment, and the unified student record (timeline with
// internal notes kept apart from student-visible messages). Money amounts and sensitive notes stay admin-only.
const express = require('express');
const db = require('../../db');
const ops = require('../../lib/ops');
const subs = require('../../lib/subscriptions');
const { HttpError, bad, v, id, wrap } = require('../../lib/http');
const { staff, isAdmin } = require('./_shared');

const r = express.Router();
const me = (req) => req.auth.user.id;
const ownerId = async (x) => {
  if (x === null || x === '' || x === undefined) return null;
  const uid = v.id(x, 'Owner');
  if (!await db.one("select 1 from anvaya.users where id = $1 and role in ('admin','ops') and disabled_at is null", [uid])) throw bad('Owners must be active team members.');
  return uid;
};
// IST day end: follow-ups "due" means due before midnight India time today.
const DUE_TODAY = "(date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day') at time zone 'Asia/Kolkata'";

r.get('/staff-users', staff, wrap(async (_req, res) => {
  res.json(await db.all("select id, coalesce(nullif(name,''), email) as name, role from anvaya.users where role in ('admin','ops') and disabled_at is null order by name"));
}));

// ── Queues ─────────────────────────────────────────────────────────────
const QUEUES = {
  my_tasks: (u) => [`select 'task' as type, t.id, t.student_id, t.lead_id, t.title, coalesce(s.name, l.name) as subtitle, t.due_at, null::text as status
      from anvaya.tasks t left join anvaya.students s on s.id = t.student_id left join anvaya.leads l on l.id = t.lead_id
      where t.status = 'open' and t.owner_user_id = $1 order by t.due_at nulls last, t.id`, [u]],
  unassigned: () => [`select * from (
      select 'lead' as type, l.id, null::bigint as student_id, l.id as lead_id, l.name as title, 'Lead · ' || l.status as subtitle, l.follow_up_at as due_at, l.status
        from anvaya.leads l where l.owner_user_id is null and l.status in ('new','contacted','qualified') and not l.is_test
      union all select 'student', s.id, s.id, null, s.name, 'Student · ' || s.status, s.follow_up_at, s.status
        from anvaya.students s where s.owner_user_id is null and s.status = 'active' and not s.is_test
      union all select 'task', t.id, t.student_id, t.lead_id, t.title, 'Task', t.due_at, t.status from anvaya.tasks t where t.status = 'open' and t.owner_user_id is null
    ) x order by due_at nulls last limit 200`, []],
  followups_due: () => [`select * from (
      select 'lead' as type, l.id, null::bigint as student_id, l.id as lead_id, l.name as title, coalesce(nullif(l.next_action,''), 'Follow up') as subtitle, l.follow_up_at as due_at, l.status
        from anvaya.leads l where l.follow_up_at < ${DUE_TODAY} and l.status in ('new','contacted','qualified')
      union all select 'student', s.id, s.id, null, s.name, coalesce(nullif(s.next_action,''), 'Follow up'), s.follow_up_at, s.status
        from anvaya.students s where s.follow_up_at < ${DUE_TODAY}
      union all select 'task', t.id, t.student_id, t.lead_id, t.title, 'Task', t.due_at, t.status from anvaya.tasks t where t.status = 'open' and t.due_at < ${DUE_TODAY}
    ) x order by due_at limit 200`, []],
  awaiting_student: () => [`select 'case' as type, c.id, c.student_id, null::bigint as lead_id, c.subject as title, s.name as subtitle, c.updated_at as due_at, c.status
      from anvaya.support_cases c join anvaya.students s on s.id = c.student_id where c.status = 'awaiting_student' order by c.updated_at`, []],
  awaiting_staff: () => [`select 'case' as type, c.id, c.student_id, null::bigint as lead_id, c.subject as title, s.name as subtitle, c.updated_at as due_at, c.status
      from anvaya.support_cases c join anvaya.students s on s.id = c.student_id where c.status = 'awaiting_staff' order by c.updated_at`, []],
  awaiting_mentor: () => [`select 'case' as type, c.id, c.student_id, null::bigint as lead_id, c.subject as title, s.name as subtitle, c.updated_at as due_at, c.status
      from anvaya.support_cases c join anvaya.students s on s.id = c.student_id where c.status = 'awaiting_mentor' order by c.updated_at`, []],
  payment_exceptions: () => [`select * from (
      select 'student' as type, s.id, s.id as student_id, null::bigint as lead_id, s.name as title, s.followup_reason as subtitle, null::timestamptz as due_at, 'needs_followup' as status
        from anvaya.students s where s.needs_followup and s.followup_reason ilike any (array['%paid%','%refund%','%payment%'])
      union all select 'student', o.student_id, o.student_id, null, s.name, 'Order #' || o.id || ' failed: ' || o.description, o.created_at, o.status
        from anvaya.orders o join anvaya.students s on s.id = o.student_id where o.status = 'failed' and o.created_at > now() - interval '30 days'
      union all select 'student', o.student_id, o.student_id, null, s.name, 'Order #' || o.id || ' awaiting payment > 24 h', o.created_at, o.status
        from anvaya.orders o join anvaya.students s on s.id = o.student_id where o.status = 'created' and o.created_at < now() - interval '24 hours' and o.created_at > now() - interval '30 days'
    ) x order by due_at nulls first limit 200`, []],
  renewals: () => [`select 'student' as type, s.id, s.id as student_id, null::bigint as lead_id, s.name as title, p.name || ' ends ' || to_char(x.paid_through at time zone 'Asia/Kolkata', 'DD Mon') as subtitle,
        x.paid_through as due_at, x.billing_status as status
      from anvaya.subscriptions x join anvaya.students s on s.id = x.student_id join anvaya.products p on p.id = x.product_id
      where x.access_status in ('active','grace') and not x.cancel_at_period_end and x.paid_through between now() - interval '5 days' and now() + interval '14 days' order by x.paid_through`, []],
  incomplete_onboarding: () => [`select 'student' as type, s.id, s.id as student_id, null::bigint as lead_id, s.name as title,
        case when s.user_id is null then 'No account yet' when u.password_hash is null then 'Invitation not accepted' else 'Intake not finished' end as subtitle, s.created_at as due_at, s.status
      from anvaya.students s left join anvaya.users u on u.id = s.user_id
      where s.status = 'active' and s.intake_completed_at is null and s.created_at < now() - interval '2 days' and not s.is_test
        and exists (select 1 from anvaya.subscriptions x where x.student_id = s.id and x.access_status in ('active','grace')) order by s.created_at`, []],
  missed_sessions: () => [`select 'student' as type, b.student_id as id, b.student_id, null::bigint as lead_id, s.name as title,
        b.service || ' · ' || case when b.status = 'no_show' then 'no-show' else 'not marked complete' end as subtitle, b.scheduled_at as due_at, b.status
      from anvaya.bookings b join anvaya.students s on s.id = b.student_id
      where (b.status = 'no_show' and b.scheduled_at > now() - interval '14 days') or (b.status = 'scheduled' and b.ends_at < now() - interval '2 hours')
      order by b.scheduled_at desc limit 200`, []],
  failed_jobs: () => [`select 'job' as type, j.id, null::bigint as student_id, null::bigint as lead_id, j.kind as title, left(coalesce(j.last_error,''), 140) as subtitle, j.created_at as due_at, j.status
      from anvaya.jobs j where j.status = 'dead' and j.created_at > now() - interval '14 days' order by j.created_at desc limit 100`, []],
};
r.get('/queues', staff, wrap(async (req, res) => {
  const out = {};
  for (const [k, fn] of Object.entries(QUEUES)) {
    const [sql, p] = fn(me(req));
    out[k] = Number((await db.one(`select count(*) n from (${sql}) q`, p)).n); // lists are capped at 200, so counts are too
  }
  res.json(out);
}));
r.get('/queues/:name', staff, wrap(async (req, res) => {
  const fn = QUEUES[req.params.name];
  if (!fn) throw new HttpError(404, 'Unknown queue.');
  const [sql, p] = fn(me(req));
  res.json(await db.all(sql, p));
}));

r.get('/today', staff, wrap(async (req, res) => {
  const tasks = await db.all(`select t.*, coalesce(s.name, l.name) as subject_name from anvaya.tasks t left join anvaya.students s on s.id = t.student_id
    left join anvaya.leads l on l.id = t.lead_id where t.status = 'open' and (t.owner_user_id = $1 or t.owner_user_id is null) and (t.due_at is null or t.due_at < ${DUE_TODAY})
    order by t.due_at nulls last limit 50`, [me(req)]);
  const sessions = await db.all(`select * from (
      select 'booking' as type, b.id, b.service as title, b.scheduled_at as starts_at, b.status, s.name as student_name, s.id as student_id, m.name as mentor_name, b.kind
        from anvaya.bookings b join anvaya.students s on s.id = b.student_id left join anvaya.mentors m on m.id = b.mentor_id
        where b.status in ('scheduled','requested') and b.scheduled_at between now() - interval '1 hour' and ${DUE_TODAY}
      union all select 'live', l.id, l.title, l.starts_at, l.status, g.name, null, m.name, l.kind
        from anvaya.live_sessions l left join anvaya.mentor_groups g on g.id = l.group_id left join anvaya.mentors m on m.id = l.mentor_id
        where l.status = 'scheduled' and l.starts_at between now() - interval '1 hour' and ${DUE_TODAY}
    ) x order by starts_at`);
  const leadsNew = Number((await db.one("select count(*) n from anvaya.leads where status = 'new' and created_at > now() - interval '7 days'")).n);
  res.json({ tasks, sessions, leads_new_7d: leadsNew });
}));

// ── Tasks ──────────────────────────────────────────────────────────────
r.get('/tasks', staff, wrap(async (req, res) => {
  const where = ["t.status = coalesce($1, t.status)"]; const p = [req.query.status || 'open'];
  if (req.query.owner === 'me') { p.push(me(req)); where.push(`t.owner_user_id = $${p.length}`); }
  if (req.query.owner === 'unassigned') where.push('t.owner_user_id is null');
  if (req.query.student_id) { p.push(v.id(req.query.student_id)); where.push(`t.student_id = $${p.length}`); }
  if (req.query.lead_id) { p.push(v.id(req.query.lead_id)); where.push(`t.lead_id = $${p.length}`); }
  res.json(await db.all(`select t.*, coalesce(nullif(u.name,''), u.email) as owner_name, coalesce(s.name, l.name) as subject_name
    from anvaya.tasks t left join anvaya.users u on u.id = t.owner_user_id left join anvaya.students s on s.id = t.student_id left join anvaya.leads l on l.id = t.lead_id
    where ${where.join(' and ')} order by t.due_at nulls last, t.id limit 300`, p));
}));
r.post('/tasks', staff, wrap(async (req, res) => {
  const b = req.body || {};
  const studentId = v.id(b.student_id, 'Student'), leadId = v.id(b.lead_id, 'Lead');
  if (!studentId && !leadId) throw bad('Link the task to a student or a lead.');
  const tid = await ops.createTask({ title: v.str(b.title, { max: 300, required: true, label: 'Task' }), studentId, leadId, caseId: v.id(b.support_case_id, 'Case'),
    ownerUserId: b.owner_user_id === 'me' ? me(req) : await ownerId(b.owner_user_id), dueAt: v.date(b.due_at), userId: me(req) });
  if (studentId) await ops.systemEvent(studentId, `Task added: ${b.title}`);
  db.audit(me(req), 'task_created', `task:${tid}`);
  res.status(201).json({ id: tid });
}));
r.patch('/tasks/:id', staff, wrap(async (req, res) => {
  const t = await db.one('select * from anvaya.tasks where id = $1', [id(req)]);
  if (!t) throw new HttpError(404, 'Task not found.');
  const b = req.body || {};
  const sets = [], p = [t.id];
  const set = (col, val) => { p.push(val); sets.push(`${col} = $${p.length}`); };
  if (b.title !== undefined) set('title', v.str(b.title, { max: 300, required: true, label: 'Task' }));
  if (b.due_at !== undefined) set('due_at', v.date(b.due_at));
  if (b.owner_user_id !== undefined) set('owner_user_id', b.owner_user_id === 'me' ? me(req) : await ownerId(b.owner_user_id));
  if (b.status !== undefined) {
    const st = v.oneOf(b.status, ['open', 'done', 'cancelled'], 'Status');
    set('status', st);
    if (st === 'done') { set('done_at', new Date().toISOString()); set('done_by', me(req)); }
  }
  if (sets.length) await db.run(`update anvaya.tasks set ${sets.join(', ')} where id = $1`, p);
  if (b.status === 'done' && t.student_id) await ops.systemEvent(t.student_id, `Task done: ${t.title}`);
  db.audit(me(req), 'task_updated', `task:${t.id} ${JSON.stringify(b).slice(0, 200)}`);
  res.json({ ok: true });
}));

// ── Owners / follow-ups / bulk assignment ──────────────────────────────
r.patch('/followup/:scope/:id', staff, wrap(async (req, res) => {
  const table = { leads: 'leads', students: 'students' }[req.params.scope];
  if (!table) throw new HttpError(404, 'Not found.');
  const rid = id(req);
  if (!await db.one(`select 1 from anvaya.${table} where id = $1`, [rid])) throw new HttpError(404, 'Not found.');
  const b = req.body || {}; const sets = [], p = [rid];
  const set = (col, val) => { p.push(val); sets.push(`${col} = $${p.length}`); };
  if (b.owner_user_id !== undefined) set('owner_user_id', b.owner_user_id === 'me' ? me(req) : await ownerId(b.owner_user_id));
  if (b.next_action !== undefined) set('next_action', v.str(b.next_action, { max: 300 }));
  if (b.follow_up_at !== undefined) set('follow_up_at', v.date(b.follow_up_at));
  if (!sets.length) throw bad('Nothing to update.');
  await db.run(`update anvaya.${table} set ${sets.join(', ')} where id = $1`, p);
  if (table === 'students') await ops.systemEvent(rid, `Follow-up updated: ${[b.next_action && `next action “${b.next_action}”`, b.follow_up_at && `due ${b.follow_up_at}`, b.owner_user_id !== undefined && 'owner changed'].filter(Boolean).join(', ')}`);
  if (table === 'leads') await db.run("insert into anvaya.lead_activities (lead_id, user_id, kind, body) values ($1,$2,'system',$3)", [rid, me(req), 'Owner / follow-up updated']);
  db.audit(me(req), `${table}_followup`, `${table}:${rid}`);
  res.json({ ok: true });
}));
r.post('/bulk-assign', staff, wrap(async (req, res) => {
  const table = { leads: 'leads', students: 'students', tasks: 'tasks' }[req.body?.scope];
  if (!table) throw bad('Choose leads, students or tasks.');
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map((x) => v.id(x, 'ID', { required: true }));
  if (!ids.length) throw bad('Select at least one row.');
  if (ids.length > 100) throw bad('Assign at most 100 rows at a time.');
  const owner = req.body.owner_user_id === 'me' ? me(req) : await ownerId(req.body.owner_user_id);
  const x = await db.run(`update anvaya.${table} set owner_user_id = $1 where id = any($2::bigint[])`, [owner, ids]);
  db.audit(me(req), 'bulk_assign', `${table} ${ids.length} → owner:${owner ?? 'none'}`);
  res.json({ ok: true, updated: x.rowCount });
}));

// ── Saved views ────────────────────────────────────────────────────────
const SCOPES = ['leads', 'students'];
r.get('/views', staff, wrap(async (req, res) => res.json(await db.all('select * from anvaya.saved_views where user_id = $1 and scope = $2 order by name',
  [me(req), v.oneOf(req.query.scope, SCOPES, 'Scope')]))));
r.post('/views', staff, wrap(async (req, res) => {
  const q = req.body?.query && typeof req.body.query === 'object' ? req.body.query : {};
  const clean = Object.fromEntries(Object.entries(q).filter(([k]) => ['q', 'status', 'owner', 'source', 'due', 'track', 'plan', 'sort'].includes(k)).map(([k, x]) => [k, String(x).slice(0, 100)]));
  const row = await db.one(`insert into anvaya.saved_views (user_id, scope, name, query) values ($1,$2,$3,$4)
    on conflict (user_id, scope, name) do update set query = excluded.query returning id`,
  [me(req), v.oneOf(req.body?.scope, SCOPES, 'Scope'), v.str(req.body?.name, { max: 60, required: true, label: 'Name' }), JSON.stringify(clean)]);
  res.status(201).json({ id: row.id });
}));
r.delete('/views/:id', staff, wrap(async (req, res) => {
  await db.run('delete from anvaya.saved_views where id = $1 and user_id = $2', [id(req), me(req)]);
  res.json({ ok: true });
}));

// ── Searchable tables with filters + pagination ────────────────────────
function paging(req) {
  const size = Math.min(100, Math.max(10, Number(req.query.page_size) || 25));
  const page = Math.max(1, Number(req.query.page) || 1);
  return { size, offset: (page - 1) * size, page };
}
function dueFilter(col, due) {
  return { overdue: `${col} < now()`, today: `${col} < ${DUE_TODAY}`, week: `${col} < now() + interval '7 days'`, none: `${col} is null` }[due] || null;
}
r.get('/leads-table', staff, wrap(async (req, res) => {
  const w = ['true'], p = [];
  const add = (sql, val) => { p.push(val); w.push(sql.replace('?', `$${p.length}`)); };
  if (req.query.q) add("(l.name ilike ? or l.phone ilike ? or coalesce(l.email,'') ilike ?)".replace(/\?/g, () => `$${p.length + 1}`), `%${String(req.query.q).slice(0, 80)}%`);
  if (req.query.status) add('l.status = ?', String(req.query.status));
  if (req.query.source) add('l.source ilike ?', `%${String(req.query.source).slice(0, 60)}%`);
  if (req.query.owner === 'me') add('l.owner_user_id = ?', me(req));
  else if (req.query.owner === 'none') w.push('l.owner_user_id is null');
  else if (req.query.owner) add('l.owner_user_id = ?', v.id(req.query.owner, 'Owner'));
  const d = dueFilter('l.follow_up_at', req.query.due); if (d) w.push(d);
  if (req.query.include_test !== '1') w.push('not l.is_test');
  const { size, offset, page } = paging(req);
  const where = w.join(' and ');
  const total = Number((await db.one(`select count(*) n from anvaya.leads l where ${where}`, p)).n);
  const rows = await db.all(`select l.id, l.name, l.phone, l.email, l.source, l.status, l.next_action, l.follow_up_at, l.created_at, l.owner_user_id,
      coalesce(nullif(u.name,''), u.email) as owner_name, (select count(*) from anvaya.tasks t where t.lead_id = l.id and t.status = 'open') as open_tasks
    from anvaya.leads l left join anvaya.users u on u.id = l.owner_user_id where ${where}
    order by ${req.query.sort === 'due' ? 'l.follow_up_at nulls last' : 'l.id desc'} limit ${size} offset ${offset}`, p);
  res.json({ rows, total, page, page_size: size });
}));
r.get('/students-table', staff, wrap(async (req, res) => {
  const w = ['true'], p = [];
  const add = (sql, val) => { p.push(val); w.push(sql.replace('?', `$${p.length}`)); };
  if (req.query.q) add("(s.name ilike ? or s.phone ilike ? or s.email ilike ? or s.college_name ilike ?)".replace(/\?/g, () => `$${p.length + 1}`), `%${String(req.query.q).slice(0, 80)}%`);
  if (req.query.status) add('s.status = ?', String(req.query.status));
  if (req.query.track) add('s.track_id = ?', v.id(req.query.track, 'Track'));
  if (req.query.owner === 'me') add('s.owner_user_id = ?', me(req));
  else if (req.query.owner === 'none') w.push('s.owner_user_id is null');
  else if (req.query.owner) add('s.owner_user_id = ?', v.id(req.query.owner, 'Owner'));
  if (req.query.plan === 'active') w.push("exists (select 1 from anvaya.subscriptions x where x.student_id = s.id and x.access_status in ('active','grace') and x.grace_until >= now())");
  if (req.query.plan === 'none') w.push("not exists (select 1 from anvaya.subscriptions x where x.student_id = s.id and x.access_status in ('active','grace') and x.grace_until >= now())");
  const d = dueFilter('s.follow_up_at', req.query.due); if (d) w.push(d);
  if (req.query.include_test !== '1') w.push('not s.is_test');
  const { size, offset, page } = paging(req);
  const where = w.join(' and ');
  const total = Number((await db.one(`select count(*) n from anvaya.students s where ${where}`, p)).n);
  const rows = await db.all(`select s.id, s.name, s.email, s.phone, s.status, s.college_name, s.target_role, s.next_action, s.follow_up_at, s.owner_user_id,
      s.intake_completed_at, t.name as track_name, coalesce(nullif(u.name,''), u.email) as owner_name,
      (select p.name || '|' || x.paid_through from anvaya.subscriptions x join anvaya.products p on p.id = x.product_id
        where x.student_id = s.id and x.access_status in ('active','grace') order by x.paid_through desc limit 1) as plan,
      (select count(*) from anvaya.tasks k where k.student_id = s.id and k.status = 'open') as open_tasks
    from anvaya.students s left join anvaya.tracks t on t.id = s.track_id left join anvaya.users u on u.id = s.owner_user_id
    where ${where} order by ${req.query.sort === 'due' ? 's.follow_up_at nulls last' : 's.id desc'} limit ${size} offset ${offset}`, p);
  for (const x of rows) { const [name, until] = (x.plan || '').split('|'); x.plan_name = name || null; x.plan_until = until || null; delete x.plan; }
  res.json({ rows, total, page, page_size: size });
}));

// ── Unified student record ─────────────────────────────────────────────
r.get('/students/:id/workspace', staff, wrap(async (req, res) => {
  const sid = id(req);
  const s = await db.one(`select s.*, t.name as track_name, coalesce(nullif(u.name,''), u.email) as owner_name, au.email as account_email,
      (au.password_hash is not null) as has_account, m.name as mentor_name
    from anvaya.students s left join anvaya.tracks t on t.id = s.track_id left join anvaya.users u on u.id = s.owner_user_id
    left join anvaya.users au on au.id = s.user_id left join anvaya.mentors m on m.id = s.mentor_id where s.id = $1`, [sid]);
  if (!s) throw new HttpError(404, 'Student not found.');
  if (!isAdmin(req)) delete s.notes; // sensitive admin notes
  const all = await subs.forStudent(sid);
  const active = all.find((x) => subs.hasAccess(x)) || null;
  if (active) {
    for (const e of active.entitlements) if (e.limit_count != null) Object.assign(e, await subs.usage(sid, active, e));
    if (!isAdmin(req)) delete active.price_paise;
  }
  const payments = await db.all(`select p.id, p.provider, p.method, p.status, p.paid_at, ${isAdmin(req) ? 'p.amount_paise, p.reference,' : ''} o.description
    from anvaya.payments p left join anvaya.orders o on o.id = p.order_id where p.student_id = $1 order by p.id desc limit 20`, [sid]);
  const group = await db.one(`select g.id, g.name, m.name as mentor_name from anvaya.group_members gm join anvaya.mentor_groups g on g.id = gm.group_id
    left join anvaya.mentors m on m.id = g.mentor_id where gm.student_id = $1 and gm.left_at is null`, [sid]);
  const upcoming = await db.all(`select b.id, b.kind, b.service, b.scheduled_at, b.status, m.name as mentor_name from anvaya.bookings b
    left join anvaya.mentors m on m.id = b.mentor_id where b.student_id = $1 and b.status in ('scheduled','requested','pending_payment') and b.ends_at > now() order by b.scheduled_at limit 5`, [sid]);
  const tasks = await db.all(`select t.*, coalesce(nullif(u.name,''), u.email) as owner_name from anvaya.tasks t left join anvaya.users u on u.id = t.owner_user_id
    where t.student_id = $1 and t.status = 'open' order by t.due_at nulls last`, [sid]);
  const cases = await db.all('select * from anvaya.support_cases where student_id = $1 order by status = \'resolved\', updated_at desc', [sid]);
  const timeline = await db.all(`select e.id, e.kind, e.body, e.author_role, e.created_at, e.support_case_id, coalesce(nullif(u.name,''), u.email) as author_name,
      case when e.email_status = 'queued' and j.status = 'dead' then 'failed' else e.email_status end as email_status, e.email_error
    from anvaya.record_entries e left join anvaya.users u on u.id = e.author_user_id left join anvaya.jobs j on j.id = e.email_job_id
    where e.student_id = $1 order by e.created_at desc, e.id desc limit 200`, [sid]);
  res.json({ student: s, subscription: active, past_subscriptions: all.filter((x) => x !== active).length, payments, group, upcoming, tasks, cases, timeline });
}));

/** Internal note (staff only) or message to the student (shown in their dashboard; optionally emailed). */
r.post('/students/:id/entries', staff, wrap(async (req, res) => {
  const sid = id(req);
  if (!await db.one('select 1 from anvaya.students where id = $1', [sid])) throw new HttpError(404, 'Student not found.');
  const kind = v.oneOf(req.body?.kind, ['internal_note', 'message'], 'Type');
  const body = v.str(req.body?.body, { max: 5000, required: true, label: 'Text' });
  const caseId = v.id(req.body?.support_case_id, 'Case');
  if (caseId && !await db.one('select 1 from anvaya.support_cases where id = $1 and student_id = $2', [caseId, sid])) throw bad('That request belongs to another student.');
  let out;
  if (kind === 'internal_note') out = { entryId: await ops.addEntry({ studentId: sid, caseId, kind, body, userId: me(req), role: req.auth.user.role }), email: 'not_requested' };
  else out = await ops.postMessage({ studentId: sid, caseId, body, userId: me(req), role: req.auth.user.role, fromName: req.auth.user.name || 'the Anvaya team', email: v.bool(req.body?.email), subject: v.str(req.body?.subject, { max: 120 }) });
  if (caseId && req.body?.case_status) {
    const st = v.oneOf(req.body.case_status, ['awaiting_staff', 'awaiting_student', 'awaiting_mentor', 'resolved'], 'Request status');
    await db.run("update anvaya.support_cases set status = $2, updated_at = now(), resolved_at = case when $2 = 'resolved' then now() else null end where id = $1", [caseId, st]);
  }
  db.audit(me(req), kind === 'message' ? 'student_message' : 'internal_note', `student:${sid} entry:${out.entryId}`);
  res.status(201).json({ id: out.entryId, email: out.email });
}));

r.get('/support', staff, wrap(async (req, res) => {
  res.json(await db.all(`select c.*, s.name as student_name, coalesce(nullif(u.name,''), u.email) as owner_name from anvaya.support_cases c
    join anvaya.students s on s.id = c.student_id left join anvaya.users u on u.id = c.owner_user_id
    where ($1::text is null or c.status = $1) order by c.status = 'resolved', c.updated_at desc limit 300`, [req.query.status || null]));
}));
r.patch('/support/:id', staff, wrap(async (req, res) => {
  const c = await db.one('select * from anvaya.support_cases where id = $1', [id(req)]);
  if (!c) throw new HttpError(404, 'Request not found.');
  const b = req.body || {};
  if (b.status) {
    const st = v.oneOf(b.status, ['awaiting_staff', 'awaiting_student', 'awaiting_mentor', 'resolved'], 'Status');
    await db.run("update anvaya.support_cases set status = $2, updated_at = now(), resolved_at = case when $2 = 'resolved' then now() else null end where id = $1", [c.id, st]);
    await ops.systemEvent(c.student_id, `Support request “${c.subject}” → ${st.replace('_', ' ')}`);
  }
  if (b.owner_user_id !== undefined) await db.run('update anvaya.support_cases set owner_user_id = $2, updated_at = now() where id = $1', [c.id, b.owner_user_id === 'me' ? me(req) : await ownerId(b.owner_user_id)]);
  res.json({ ok: true });
}));

// ── Mentor services: approval (prices are financial, so admin-only) ──
const { adminOnly } = require('./_shared');
r.get('/mentor-services', staff, wrap(async (req, res) => {
  const rows = await db.all(`select ms.*, m.name as mentor_name from anvaya.mentor_services ms join anvaya.mentors m on m.id = ms.mentor_id
    where ($1::text is null or ms.approval = $1) order by ms.approval = 'pending' desc, ms.updated_at desc`, [req.query.approval || null]);
  res.json(isAdmin(req) ? rows : rows.map(({ price_paise, ...x }) => x));
}));
r.post('/mentor-services/:id/:decision', adminOnly, wrap(async (req, res) => {
  const decision = v.oneOf(req.params.decision, ['approve', 'reject'], 'Decision');
  const x = await db.run(`update anvaya.mentor_services set approval = $2, approved_by = $3, approved_at = now() where id = $1`,
    [id(req), decision === 'approve' ? 'approved' : 'rejected', me(req)]);
  if (!x.rowCount) throw new HttpError(404, 'Service not found.');
  db.audit(me(req), `mentor_service_${decision}d`, `service:${id(req)}`);
  res.json({ ok: true });
}));

module.exports = r;
