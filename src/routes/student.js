'use strict';
// Student API — every query is scoped to req.auth.student.id.
const express = require('express');
const db = require('../db');
const sec = require('../security');
const subs = require('../lib/subscriptions');
const bookingsLib = require('../lib/bookings');
const payments = require('../lib/payments');
const settings = require('../lib/settings');
const { HttpError, bad, v, id, wrap, fields, updateSql } = require('../lib/http');

const r = express.Router();
r.use(sec.requireRole('student'));
const me = (req) => req.auth.student.id;

const intakeFields = fields({
  name: (x) => v.str(x, { max: 120, required: true, label: 'Name' }),
  phone: (x) => v.str(x, { max: 40, label: 'Phone' }),
  college_name: (x) => v.str(x, { max: 160, label: 'College / company' }),
  graduation_year: (x) => v.int(x, { min: 1980, max: 2040, label: 'Graduation year' }),
  stage: (x) => v.str(x, { max: 200, label: 'Where you are now' }),
  target_role: (x) => v.str(x, { max: 120, label: 'Target role' }),
  prep_level: (x) => v.oneOf(x, ['', 'starting', 'some_preparation', 'interview_ready'], 'Preparation level'),
  availability_pref: (x) => v.str(x, { max: 200, label: 'Availability' }),
  goals: (x) => v.str(x, { max: 2000, label: 'Goals' }),
  linkedin: (x) => v.url(x, 'LinkedIn URL'),
  track_id: async (x) => {
    const n = v.id(x, 'Track');
    if (n != null && !await db.one('select 1 from anvaya.tracks where id = $1 and active', [n])) throw bad('Track not found.');
    return n;
  },
});

/** Dashboard summary. */
r.get('/me', wrap(async (req, res) => {
  const sid = me(req);
  const s = await db.one(`select s.id, s.name, s.email, s.phone, s.stage, s.goals, s.target_role, s.prep_level, s.availability_pref, s.linkedin,
    s.college_name, s.graduation_year, s.track_id, s.intake_completed_at, t.name as track_name, m.name as mentor_name, m.id as mentor_id
    from anvaya.students s left join anvaya.tracks t on t.id = s.track_id left join anvaya.mentors m on m.id = s.mentor_id where s.id = $1`, [sid]);
  const all = await subs.forStudent(sid);
  const active = all.find((x) => subs.hasAccess(x)) || null;
  if (active) for (const e of active.entitlements) if (e.limit_count != null) Object.assign(e, await subs.usage(sid, active, e));
  s.subscription = active;
  s.past_subscriptions = all.filter((x) => x !== active).map((x) => ({ id: x.id, plan_name: x.plan_name, paid_through: x.paid_through, effective_access: x.effective_access }));
  s.group = active ? await db.one(`select g.id, g.name, g.meet_link, g.whatsapp_link, m.name as mentor_name, m.id as mentor_id from anvaya.group_members gm
    join anvaya.mentor_groups g on g.id = gm.group_id left join anvaya.mentors m on m.id = g.mentor_id where gm.student_id = $1 and gm.left_at is null`, [sid]) : null;
  s.resumes = await db.all(`select d.id, d.title, d.created_at, (select max(v.id) from anvaya.document_versions v where v.document_id = d.id and v.status = 'ready') as latest_version_id
    from anvaya.documents d where d.student_id = $1 and d.kind = 'resume_upload' order by d.id desc`, [sid]);
  s.payments_provider = payments.checkoutConfig().provider;
  res.json(s);
}));

r.get('/tracks', wrap(async (_req, res) => res.json(await db.all('select id, name, target_role, description from anvaya.tracks where active order by name'))));

r.patch('/intake', wrap(async (req, res) => {
  const sid = me(req);
  const f = await intakeFields(req.body || {}, { partial: true });
  if (f.prep_level === '') delete f.prep_level;
  const complete = v.bool(req.body?.complete);
  await db.tx(async (t) => {
    if (Object.keys(f).length) await t.run(...updateSql('students', f, sid));
    if (f.track_id) await t.run(`insert into anvaya.enrollments (student_id, track_id) values ($1,$2) on conflict (student_id, track_id) do update set status = 'active'`, [sid, f.track_id]);
  });
  // Saved fields stay saved even if the intake isn't complete yet.
  if (complete) {
    const s = await db.one('select name, phone, target_role, track_id from anvaya.students where id = $1', [sid]);
    const missing = ['name', 'phone', 'target_role', 'track_id'].filter((k) => !s[k]);
    if (missing.length) throw bad(`Please fill in: ${missing.map((k) => ({ track_id: 'preparation track', target_role: 'target role' }[k] || k)).join(', ')}.`);
    const resume = await db.one("select 1 from anvaya.documents d join anvaya.document_versions v on v.document_id = d.id where d.student_id = $1 and d.kind = 'resume_upload' and v.status = 'ready'", [sid]);
    if (!resume) throw bad('Please upload your resume to finish your intake.');
    await db.run('update anvaya.students set intake_completed_at = coalesce(intake_completed_at, now()) where id = $1', [sid]);
  }
  res.json({ ok: true });
}));

// ── Syllabus & progress ──────────────────────────────────────────────
async function canSeeSyllabus(sid) {
  const sub = await subs.activeFor(sid);
  if (sub && sub.entitlements.some((e) => e.key === 'syllabus')) return true;
  return !!(await db.one('select 1 from anvaya.enrollments where student_id = $1 and cohort_id is not null and status = \'active\'', [sid]));
}
r.get('/syllabus', wrap(async (req, res) => {
  const sid = me(req);
  if (!await canSeeSyllabus(sid)) return res.json({ locked: true, tracks: [] });
  const tracks = await db.all(`select t.id, t.name, t.description, e.started_at from anvaya.enrollments e join anvaya.tracks t on t.id = e.track_id
    where e.student_id = $1 and e.status = 'active' order by t.name`, [sid]);
  for (const t of tracks) {
    t.modules = await db.all('select id, title, description, week_number, position from anvaya.modules where track_id = $1 order by position, id', [t.id]);
    for (const m of t.modules) {
      m.assignments = await db.all(`select a.id, a.title, a.instructions, a.due_offset_days,
        case when a.due_offset_days is null then null else $3::timestamptz + make_interval(days => a.due_offset_days) end as due_at,
        coalesce(p.status, 'not_started') as status, p.submission, p.feedback, p.submitted_at
        from anvaya.assignments a left join anvaya.assignment_progress p on p.assignment_id = a.id and p.student_id = $1
        where a.module_id = $2 order by a.position, a.id`, [sid, m.id, t.started_at]);
    }
    const all = t.modules.flatMap((m) => m.assignments);
    t.progress = { total: all.length, done: all.filter((a) => ['submitted', 'reviewed', 'done'].includes(a.status)).length };
  }
  res.json({ locked: false, tracks });
}));
r.post('/assignments/:id/submit', wrap(async (req, res) => {
  const sid = me(req), aid = id(req);
  const ok = await db.one(`select 1 from anvaya.assignments a join anvaya.modules m on m.id = a.module_id
    join anvaya.enrollments e on e.track_id = m.track_id and e.student_id = $1 and e.status = 'active' where a.id = $2`, [sid, aid]);
  if (!ok || !await canSeeSyllabus(sid)) throw new HttpError(404, 'Assignment not found.');
  const submission = v.str(req.body?.submission, { max: 10000, required: true, label: 'Your work' });
  await db.run(`insert into anvaya.assignment_progress (student_id, assignment_id, status, submission, submitted_at, updated_at)
    values ($1,$2,'submitted',$3,now(),now()) on conflict (student_id, assignment_id)
    do update set status = 'submitted', submission = excluded.submission, submitted_at = now(), updated_at = now()`, [sid, aid, submission]);
  res.json({ ok: true });
}));

// ── Sessions ─────────────────────────────────────────────────────────
r.get('/sessions', wrap(async (req, res) => {
  const sid = me(req);
  const sub = await subs.activeFor(sid);
  const live = sub ? await db.all(`select l.id, l.kind, l.title, l.starts_at, l.ends_at, l.meet_link, l.status, g.name as group_name, m.name as mentor_name,
      (select a.status from anvaya.attendance a where a.live_session_id = l.id and a.student_id = $1) as attendance
    from anvaya.live_sessions l left join anvaya.mentor_groups g on g.id = l.group_id left join anvaya.mentors m on m.id = l.mentor_id
    where l.status <> 'cancelled' and l.ends_at > now() - interval '14 days' and (
      l.group_id in (select group_id from anvaya.group_members where student_id = $1 and left_at is null)
      or (l.group_id is null and l.cohort_id in (select cohort_id from anvaya.cohort_members where student_id = $1))
      or (l.group_id is null and l.cohort_id is null and (l.track_id is null or l.track_id in (select track_id from anvaya.enrollments where student_id = $1 and status = 'active'))))
    order by l.starts_at`, [sid]) : [];
  const bookings = await db.all(`select b.id, b.kind, b.service, b.scheduled_at, b.duration, b.status, b.meeting_link, b.price_paise, b.order_id, b.hold_expires_at, m.name as mentor_name
    from anvaya.bookings b left join anvaya.mentors m on m.id = b.mentor_id where b.student_id = $1 and b.status <> 'cancelled' order by b.scheduled_at desc`, [sid]);
  res.json({ live, bookings, has_access: !!sub });
}));
r.get('/mentors', wrap(async (_req, res) => {
  res.json(await db.all(`select id, name, expertise, bio, session_details, session_duration, session_price_paise, accepts_paid_sessions
    from anvaya.mentors where status = 'active' order by name`));
}));
r.get('/mentors/:id/slots', wrap(async (req, res) => res.json(await bookingsLib.slots(id(req)))));

r.post('/bookings/checkup', wrap(async (req, res) => {
  const sid = me(req);
  let mentorId = v.id(req.body?.mentor_id, 'Mentor');
  if (!mentorId) {
    const g = await db.one(`select g.mentor_id from anvaya.group_members gm join anvaya.mentor_groups g on g.id = gm.group_id where gm.student_id = $1 and gm.left_at is null`, [sid]);
    mentorId = g?.mentor_id || req.auth.student.mentor_id;
  }
  if (!mentorId) throw bad('Choose a mentor for your check-up.');
  const b = await bookingsLib.create({ studentId: sid, mentorId, startsAt: v.date(req.body?.scheduled_at, { required: true, label: 'Time' }), kind: 'checkup', userId: req.auth.user.id });
  payments.notifyBookingConfirmed(b.id).catch(() => {});
  res.status(201).json({ id: b.id, status: b.status });
}));

r.post('/bookings/paid', wrap(async (req, res) => {
  const sid = me(req);
  const mode = payments.configured() ? 'razorpay' : 'manual';
  const b = await bookingsLib.create({ studentId: sid, mentorId: v.id(req.body?.mentor_id, 'Mentor', { required: true }),
    startsAt: v.date(req.body?.scheduled_at, { required: true, label: 'Time' }), kind: 'paid_session', userId: req.auth.user.id, paymentMode: mode });
  let order;
  try {
    order = await payments.createOrder({ studentId: sid, product: null, amountPaise: b.price_paise, description: `Private mentor session #${b.id}`, userId: req.auth.user.id });
    await db.run('update anvaya.bookings set order_id = $1 where id = $2', [order.id, b.id]);
  } catch (e) {
    await db.run("update anvaya.bookings set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Payment could not be started' where id = $1", [b.id]);
    throw e;
  }
  res.status(201).json({ booking_id: b.id, status: b.status, hold_expires_at: b.hold_expires_at, checkout: await checkoutFor(req, order) });
}));

r.post('/bookings/:id/cancel', wrap(async (req, res) => {
  const b = await db.one('select * from anvaya.bookings where id = $1 and student_id = $2', [id(req), me(req)]);
  if (!b) throw new HttpError(404, 'Booking not found.');
  if (!['scheduled', 'requested', 'pending_payment'].includes(b.status)) throw bad('This booking can’t be cancelled.');
  const notice = Number(await settings.get('booking_min_notice_hours')) * 3600e3;
  if (b.status === 'scheduled' && new Date(b.scheduled_at).getTime() - Date.now() < notice) throw bad('It’s too close to the session to cancel online. Please message the Anvaya team.');
  await db.run("update anvaya.bookings set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Cancelled by student' where id = $1", [b.id]);
  if (b.kind === 'paid_session' && b.status === 'scheduled') {
    await db.run("update anvaya.students set needs_followup = true, followup_reason = 'Cancelled a paid session — refund or rebook' where id = $1", [b.student_id]);
  }
  res.json({ ok: true, refund: b.kind === 'paid_session' && b.status === 'scheduled' ? 'The Anvaya team will contact you about a refund or a new time.' : null });
}));

// ── Purchases ────────────────────────────────────────────────────────
async function checkoutFor(req, order) {
  const cfg = payments.checkoutConfig();
  if (cfg.provider !== 'razorpay') return { provider: 'manual', order_id: order.id, amount_paise: order.amount_paise, message: 'Your request is saved. The Anvaya team will share payment details and confirm once paid.' };
  const s = await db.one('select name, email, phone from anvaya.students where id = $1', [me(req)]);
  return { provider: 'razorpay', key: cfg.keyId, order_id: order.id, razorpay_order_id: order.provider_order_id, amount_paise: order.amount_paise,
    currency: 'INR', name: 'Anvaya', description: order.description, prefill: { name: s.name, email: s.email, contact: s.phone } };
}
r.get('/catalog', wrap(async (_req, res) => {
  const rows = await db.all("select id, kind, name, description, price_paise, billing_period from anvaya.products where active and kind <> 'mentor_session' order by kind, price_paise");
  for (const p of rows) p.entitlements = await db.all('select key, limit_count, per_period from anvaya.plan_entitlements where product_id = $1 order by key', [p.id]);
  res.json(rows);
}));
r.post('/orders', wrap(async (req, res) => {
  const p = await db.one("select * from anvaya.products where id = $1 and active and kind <> 'mentor_session'", [v.id(req.body?.product_id, 'Product', { required: true })]);
  if (!p) throw bad('That product isn’t available.');
  const open = await db.one("select * from anvaya.orders where student_id = $1 and product_id = $2 and status = 'created' and created_at > now() - interval '30 minutes'", [me(req), p.id]);
  const order = open || await payments.createOrder({ studentId: me(req), product: p, amountPaise: p.price_paise, description: p.name, userId: req.auth.user.id });
  res.status(201).json({ checkout: await checkoutFor(req, order) });
}));
/** Razorpay Checkout success handler → verify signature server-side → mark paid (idempotent with the webhook). */
r.post('/payments/verify', wrap(async (req, res) => {
  const b = req.body || {};
  const order = await db.one("select * from anvaya.orders where provider = 'razorpay' and provider_order_id = $1 and student_id = $2", [String(b.razorpay_order_id || ''), me(req)]);
  if (!order) throw new HttpError(404, 'Order not found.');
  if (!payments.verifyCheckoutSignature(b)) throw new HttpError(400, 'Payment verification failed. If money was deducted, it will be reconciled automatically.');
  // Amount/fee come from the gateway via the webhook or reconciliation; here we trust only the verified ids.
  const pays = await payments.rzp('GET', `/orders/${order.provider_order_id}/payments`);
  const p = (pays.items || []).find((x) => x.id === b.razorpay_payment_id && x.status === 'captured');
  if (!p) return res.json({ ok: true, status: 'processing' });
  await payments.markPaid(order.id, { provider: 'razorpay', providerPaymentId: p.id, amountPaise: p.amount, feePaise: p.fee || 0, taxPaise: p.tax || 0, method: p.method });
  res.json({ ok: true, status: 'paid' });
}));
r.get('/orders', wrap(async (req, res) => {
  res.json(await db.all(`select o.id, o.description, o.amount_paise, o.status, o.created_at, o.paid_at, p.kind as product_kind, p.name as product_name
    from anvaya.orders o left join anvaya.products p on p.id = o.product_id where o.student_id = $1 order by o.id desc`, [me(req)]));
}));
r.get('/products', wrap(async (req, res) => {
  res.json(await db.all(`select p.id, p.name, p.description, p.kind,
      (select max(v.id) from anvaya.document_versions v where v.document_id = p.digital_document_id and v.status = 'ready') as version_id
    from anvaya.products p where p.kind = 'digital_product' and exists (select 1 from anvaya.orders o where o.product_id = p.id and o.student_id = $1 and o.status = 'paid')`, [me(req)]));
}));

// ── Services (resume / LinkedIn / coaching) ──────────────────────────
r.get('/services', wrap(async (req, res) => {
  const cases = await db.all(`select c.id, c.kind, c.status, c.due_at, c.delivered_at, c.revisions_allowed, c.revisions_used, p.name as product_name, m.name as coach_name
    from anvaya.service_cases c left join anvaya.products p on p.id = c.product_id left join anvaya.mentors m on m.id = c.coach_mentor_id
    where c.student_id = $1 order by c.id desc`, [me(req)]);
  for (const c of cases) {
    c.documents = await db.all(`select d.id, d.title, d.kind, (select max(v.id) from anvaya.document_versions v where v.document_id = d.id and v.status = 'ready') as latest_version_id
      from anvaya.documents d where d.case_id = $1 and d.visible_to_student order by d.id desc`, [c.id]);
  }
  res.json(cases);
}));
r.post('/services/:id/intake', wrap(async (req, res) => {
  const c = await db.one("select * from anvaya.service_cases where id = $1 and student_id = $2", [id(req), me(req)]);
  if (!c) throw new HttpError(404, 'Not found.');
  if (!['intake', 'assigned'].includes(c.status)) throw bad('Your intake is already with your coach. Use “Request revision” after delivery.');
  await db.run('update anvaya.service_cases set source_facts = $1, updated_at = now() where id = $2', [v.str(req.body?.source_facts, { max: 20000, required: true, label: 'Your details' }), c.id]);
  res.json({ ok: true });
}));
r.post('/services/:id/revision', wrap(async (req, res) => {
  const c = await db.one("select * from anvaya.service_cases where id = $1 and student_id = $2", [id(req), me(req)]);
  if (!c) throw new HttpError(404, 'Not found.');
  if (c.status !== 'delivered') throw bad('You can request a revision after delivery.');
  if (c.revisions_used >= c.revisions_allowed) throw bad('You’ve used the revisions included with this service.');
  const note = v.str(req.body?.note, { max: 3000, required: true, label: 'What should change' });
  await db.tx(async (t) => {
    await t.run("update anvaya.service_cases set status = 'revision', revisions_used = revisions_used + 1, updated_at = now() where id = $1", [c.id]);
    await t.run("insert into anvaya.case_events (case_id, user_id, from_status, to_status, note) values ($1,$2,'delivered','revision',$3)", [c.id, req.auth.user.id, note]);
  });
  res.json({ ok: true });
}));

// ── Outcomes & feedback ──────────────────────────────────────────────
const appFields = fields({
  company: (x) => v.str(x, { max: 160, required: true, label: 'Company' }),
  role_title: (x) => v.str(x, { max: 160, label: 'Role' }),
  stage: (x) => v.oneOf(x, ['applied', 'shortlisted', 'interview', 'offer', 'rejected', 'withdrawn', 'accepted'], 'Stage'),
  applied_on: (x) => v.day(x, { label: 'Applied on' }),
  notes: (x) => v.str(x, { max: 2000 }),
}, ['company']);
r.get('/applications', wrap(async (req, res) => res.json(await db.all('select * from anvaya.applications where student_id = $1 order by updated_at desc', [me(req)]))));
r.post('/applications', wrap(async (req, res) => {
  const f = await appFields(req.body || {}, { partial: false });
  const keys = Object.keys(f);
  const row = await db.one(`insert into anvaya.applications (student_id, ${keys.join(',')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) returning id`, [me(req), ...keys.map((k) => f[k])]);
  res.status(201).json({ id: row.id });
}));
r.patch('/applications/:id', wrap(async (req, res) => {
  const f = await appFields(req.body || {}, { partial: true });
  f.updated_at = new Date().toISOString();
  const [sql, params] = updateSql('applications', f, id(req), `and student_id = $${Object.keys(f).length + 2}`);
  const x = await db.run(sql, [...params, me(req)]);
  if (!x.rowCount) throw new HttpError(404, 'Not found.');
  res.json({ ok: true });
}));
r.delete('/applications/:id', wrap(async (req, res) => {
  const x = await db.run('delete from anvaya.applications where id = $1 and student_id = $2', [id(req), me(req)]);
  if (!x.rowCount) throw new HttpError(404, 'Not found.');
  res.json({ ok: true });
}));
r.post('/feedback', wrap(async (req, res) => {
  const sid = me(req);
  const bookingId = v.id(req.body?.booking_id, 'Session');
  const liveId = v.id(req.body?.live_session_id, 'Session');
  const caseId = v.id(req.body?.case_id, 'Service');
  if (bookingId && !await db.one('select 1 from anvaya.bookings where id = $1 and student_id = $2', [bookingId, sid])) throw new HttpError(404, 'Not found.');
  if (caseId && !await db.one('select 1 from anvaya.service_cases where id = $1 and student_id = $2', [caseId, sid])) throw new HttpError(404, 'Not found.');
  await db.run('insert into anvaya.feedback (student_id, booking_id, live_session_id, case_id, rating, comments) values ($1,$2,$3,$4,$5,$6)',
    [sid, bookingId, liveId, caseId, v.int(req.body?.rating, { min: 1, max: 5, label: 'Rating' }), v.str(req.body?.comments, { max: 3000 })]);
  res.status(201).json({ ok: true });
}));

module.exports = r;
