'use strict';
// Mentors: invitations, profile edits, deactivation, coach suggestions, ledger + payouts.
const express = require('express');
const db = require('../../db');
const sec = require('../../security');
const accounts = require('../../lib/accounts');
const ledger = require('../../lib/ledger');
const { HttpError, bad, v, id, wrap, setClause } = require('../../lib/http');
const { staff, adminOnly, isAdmin } = require('./_shared');

const r = express.Router();
/** Optional per-invitation lifetime in minutes (2 min – 7 days). Leaves the global INVITE_TTL_HOURS untouched. */
const linkMinutes = (body) => v.int(body?.expires_in_minutes, { min: 2, max: 7 * 24 * 60, label: 'Link lifetime (minutes)' });

const mentorSelect = `select m.*, u.email, (u.password_hash is not null) as has_password, u.last_login_at,
  (select count(*) from anvaya.students s where s.mentor_id = m.id and s.status = 'active') as student_count,
  (select count(*) from anvaya.group_members gm join anvaya.mentor_groups g on g.id = gm.group_id where g.mentor_id = m.id and gm.left_at is null) as group_student_count,
  (select count(*) from anvaya.bookings b where b.mentor_id = m.id and b.status = 'scheduled' and b.scheduled_at >= now()) as upcoming_count,
  (select count(*) from anvaya.service_cases c where c.coach_mentor_id = m.id and c.status not in ('delivered','closed','cancelled')) as open_cases,
  (select coalesce(sum(amount_paise),0) from anvaya.mentor_ledger l where l.mentor_id = m.id) as payable_paise,
  (select max(expires_at) from anvaya.invitations i where i.user_id = m.user_id and i.kind = 'mentor_invite' and i.used_at is null and i.revoked_at is null) as invite_expires_at
  from anvaya.mentors m join anvaya.users u on u.id = m.user_id`;
const hideMoney = (req, rows) => (isAdmin(req) ? rows : rows.map(({ payable_paise, ...x }) => x));

function mentorFields(body, { partial }) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;
  if (has('name')) out.name = v.str(body.name, { max: 120, required: true, label: 'Name' });
  if (has('expertise')) out.expertise = v.str(body.expertise, { max: 300, label: 'Expertise' });
  if (has('bio')) out.bio = v.str(body.bio, { max: 3000, label: 'Bio' });
  if (has('session_price_paise')) out.session_price_paise = v.paise(body.session_price_paise, { label: 'Session price', required: !partial }) ?? 0;
  if (body.checkup_fee_paise !== undefined) out.checkup_fee_paise = v.paise(body.checkup_fee_paise, { label: 'Check-up fee' }) ?? 0;
  if (body.session_duration !== undefined) out.session_duration = v.int(body.session_duration, { min: 15, max: 240, label: 'Session duration' }) ?? 45;
  if (body.session_details !== undefined) out.session_details = v.str(body.session_details, { max: 2000, label: 'Session details' });
  if (body.max_students !== undefined) out.max_students = v.int(body.max_students, { min: 0, max: 500, label: 'Capacity' }) ?? 12;
  if (body.accepts_paid_sessions !== undefined) out.accepts_paid_sessions = v.bool(body.accepts_paid_sessions);
  return out;
}

r.get('/mentors', staff, wrap(async (req, res) => {
  res.json(hideMoney(req, await db.all(`${mentorSelect} order by case m.status when 'active' then 0 when 'invite_pending' then 1 else 2 end, m.name`)));
}));
r.get('/mentors/:id', staff, wrap(async (req, res) => {
  const m = await db.one(`${mentorSelect} where m.id = $1`, [id(req)]);
  if (!m) throw new HttpError(404, 'Mentor not found.');
  m.availability = await db.all('select weekday, start_time, end_time from anvaya.availability where mentor_id = $1 order by weekday, start_time', [m.id]);
  res.json(hideMoney(req, [m])[0]);
}));

/** Coach suggestions: active mentors ranked by expertise match, then spare capacity. */
r.get('/mentors-suggest', staff, wrap(async (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  let words = q.split(/[^a-z0-9+#]+/).filter((w) => w.length > 2);
  if (req.query.student_id) {
    const s = await db.one('select target_role, goals, stage from anvaya.students where id = $1', [Number(req.query.student_id)]);
    if (s) words = words.concat(`${s.target_role} ${s.goals}`.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 2));
  }
  const rows = await db.all(`${mentorSelect} where m.status = 'active'`);
  const out = rows.map((m) => {
    const load = m.student_count + m.open_cases;
    const spare = Math.max(0, m.max_students - load);
    const text = `${m.expertise} ${m.bio}`.toLowerCase();
    const match = words.filter((w) => text.includes(w)).length;
    return { id: m.id, name: m.name, expertise: m.expertise, load, capacity: m.max_students, spare, match, score: match * 10 + Math.min(spare, 10) };
  }).filter((m) => m.spare > 0).sort((a, b) => b.score - a.score);
  res.json(out);
}));

r.post('/mentors', adminOnly, wrap(async (req, res) => {
  const f = mentorFields(req.body || {}, { partial: false });
  const email = v.email(req.body?.email);
  const mins = linkMinutes(req.body); // validate before anything is created
  if (await db.one('select 1 from anvaya.users where lower(email) = $1', [email])) throw new HttpError(409, 'An account with this email already exists.');
  const { mentorId, userId } = await db.tx(async (t) => {
    const u = await t.one("insert into anvaya.users (email, name, role) values ($1, $2, 'mentor') returning id", [email, f.name]);
    const keys = Object.keys(f);
    const m = await t.one(`insert into anvaya.mentors (user_id, ${keys.join(',')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) returning id`, [u.id, ...keys.map((k) => f[k])]);
    return { mentorId: m.id, userId: u.id };
  });
  db.audit(req.auth.user.id, 'mentor_created', `mentor:${mentorId}`);
  let invite = null, mailError = null;
  if (req.body?.send_invite !== false) {
    const out = await accounts.issue(userId, 'mentor_invite', { byUserId: req.auth.user.id, expiresInMinutes: mins });
    invite = { expiresAt: out.expiresAt, delivered: out.delivered };
    if (!out.delivered) mailError = out.error || 'Queued for retry';
  }
  res.status(201).json({ id: mentorId, invite, mailError });
}));

r.patch('/mentors/:id', adminOnly, wrap(async (req, res) => {
  const mid = id(req);
  const m = await db.one('select * from anvaya.mentors where id = $1', [mid]);
  if (!m) throw new HttpError(404, 'Mentor not found.');
  const f = mentorFields(req.body || {}, { partial: true });
  const email = req.body?.email !== undefined ? v.email(req.body.email) : null;
  await db.tx(async (t) => {
    if (email) {
      if (await t.one('select id from anvaya.users where lower(email) = $1 and id <> $2', [email, m.user_id])) throw new HttpError(409, 'Another account already uses this email.');
      await t.run('update anvaya.users set email = $1 where id = $2', [email, m.user_id]);
    }
    const keys = Object.keys(f);
    if (keys.length) await t.run(`update anvaya.mentors set ${setClause(keys)}, updated_at = now() where id = $${keys.length + 1}`, [...keys.map((k) => f[k]), mid]);
  });
  db.audit(req.auth.user.id, 'mentor_updated', `mentor:${mid}`);
  res.json(await db.one(`${mentorSelect} where m.id = $1`, [mid]));
}));

r.post('/mentors/:id/resend-invite', adminOnly, wrap(async (req, res) => {
  const mid = id(req);
  const m = await db.one('select m.*, u.password_hash from anvaya.mentors m join anvaya.users u on u.id = m.user_id where m.id = $1', [mid]);
  if (!m) throw new HttpError(404, 'Mentor not found.');
  if (m.status !== 'invite_pending') throw bad(m.status === 'active' ? 'This mentor is already active.' : 'Reactivate this mentor before sending an invitation.');
  if (m.password_hash) throw bad('This mentor has already accepted the invitation and is completing their profile. They can sign in at /mentor/login.');
  const out = await accounts.issue(m.user_id, 'mentor_invite', { isResend: true, byUserId: req.auth.user.id, expiresInMinutes: linkMinutes(req.body) });
  res.json({ ok: true, invite: { expiresAt: out.expiresAt, delivered: out.delivered }, mailError: out.delivered ? null : out.error });
}));

r.post('/mentors/:id/deactivate', adminOnly, wrap(async (req, res) => {
  const mid = id(req);
  const m = await db.one('select * from anvaya.mentors where id = $1', [mid]);
  if (!m) throw new HttpError(404, 'Mentor not found.');
  await db.tx(async (t) => {
    await t.run("update anvaya.mentors set status = 'deactivated', updated_at = now() where id = $1", [mid]);
    await t.run('update anvaya.invitations set revoked_at = now() where user_id = $1 and used_at is null and revoked_at is null', [m.user_id]);
    await sec.revokeAllSessions(m.user_id, t);
  });
  db.audit(req.auth.user.id, 'mentor_deactivated', `mentor:${mid}`);
  res.json({ ok: true });
}));
r.post('/mentors/:id/reactivate', adminOnly, wrap(async (req, res) => {
  const mid = id(req);
  const m = await db.one('select m.*, u.password_hash from anvaya.mentors m join anvaya.users u on u.id = m.user_id where m.id = $1', [mid]);
  if (!m) throw new HttpError(404, 'Mentor not found.');
  const status = m.password_hash && m.profile_completed ? 'active' : 'invite_pending';
  await db.run('update anvaya.mentors set status = $1, updated_at = now() where id = $2', [status, mid]);
  db.audit(req.auth.user.id, 'mentor_reactivated', `mentor:${mid}`);
  res.json({ ok: true, status });
}));

/** Permanently removes a mentor who has no history (no bookings, ledger, cases, groups or sessions). Otherwise: deactivate. */
r.delete('/mentors/:id', adminOnly, wrap(async (req, res) => {
  const mid = id(req);
  const m = await db.one('select * from anvaya.mentors where id = $1', [mid]);
  if (!m) throw new HttpError(404, 'Mentor not found.');
  const used = await db.one(`select
    (select count(*) from anvaya.bookings where mentor_id = $1) + (select count(*) from anvaya.mentor_ledger where mentor_id = $1) +
    (select count(*) from anvaya.service_cases where coach_mentor_id = $1) + (select count(*) from anvaya.mentor_groups where mentor_id = $1) +
    (select count(*) from anvaya.live_sessions where mentor_id = $1) + (select count(*) from anvaya.students where mentor_id = $1) +
    (select count(*) from anvaya.payouts where mentor_id = $1) as n`, [mid]);
  if (used.n) throw bad('This mentor has history (sessions, students, cases or money). Deactivate them instead.');
  await db.run('delete from anvaya.users where id = $1', [m.user_id]); // cascades: mentor, availability, invitations, sessions
  db.audit(req.auth.user.id, 'mentor_deleted', `mentor:${mid} ${m.name}`);
  res.json({ ok: true });
}));

// ── Ledger + payouts (admin) ─────────────────────────────────────────
r.get('/payables', adminOnly, wrap(async (_req, res) => {
  const mentors = await db.all("select id, name, status from anvaya.mentors order by name");
  const out = [];
  for (const m of mentors) out.push({ ...m, ...(await ledger.balance(m.id)) });
  res.json(out);
}));
r.get('/mentors/:id/ledger', adminOnly, wrap(async (req, res) => {
  const mid = id(req);
  res.json({
    balance: await ledger.balance(mid),
    entries: await db.all(`select l.*, s.name as student_name from anvaya.mentor_ledger l
      left join anvaya.bookings b on b.id = l.booking_id left join anvaya.students s on s.id = b.student_id
      where l.mentor_id = $1 order by l.created_at desc`, [mid]),
    payouts: await db.all('select * from anvaya.payouts where mentor_id = $1 order by paid_at desc', [mid]),
  });
}));
r.post('/mentors/:id/payouts', adminOnly, wrap(async (req, res) => {
  const mid = id(req);
  const amount = v.paise(req.body?.amount_paise, { label: 'Amount', required: true, min: 1 });
  const pid = await ledger.recordPayout(mid, {
    amount_paise: amount, method: v.str(req.body?.method, { max: 40 }) || 'UPI', reference: v.str(req.body?.reference, { max: 120 }), paid_at: v.date(req.body?.paid_at),
  }, req.auth.user.id);
  db.audit(req.auth.user.id, 'payout_recorded', `mentor:${mid} payout:${pid}`);
  res.status(201).json({ id: pid, balance: await ledger.balance(mid) });
}));
r.post('/mentors/:id/adjustments', adminOnly, wrap(async (req, res) => {
  const mid = id(req);
  const amount = v.int(req.body?.amount_paise, { min: -100_000_000_00, max: 100_000_000_00, label: 'Amount', required: true });
  if (!amount) throw bad('Amount can’t be zero.');
  const note = v.str(req.body?.note, { max: 300, required: true, label: 'Reason' });
  await db.run("insert into anvaya.mentor_ledger (mentor_id, kind, amount_paise, note, created_by) values ($1,'adjustment',$2,$3,$4)", [mid, amount, note, req.auth.user.id]);
  res.status(201).json({ balance: await ledger.balance(mid) });
}));

module.exports = r;
