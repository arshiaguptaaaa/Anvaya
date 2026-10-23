'use strict';
// Single-use, expiring account links: mentor invitations, student invitations and password resets.
// Only the SHA-256 of each token is stored; the raw token lives in the (encrypted) email job until sent.
const db = require('../db');
const sec = require('../security');
const { sendEmail } = require('./email');

const BASE_URL = () => (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const INVITE_TTL = Number(process.env.INVITE_TTL_HOURS || 72);
const TTL_HOURS = { mentor_invite: INVITE_TTL, student_invite: INVITE_TTL, staff_invite: INVITE_TTL, password_reset: 1 };
const PATH = { mentor_invite: '/invite', student_invite: '/invite', staff_invite: '/invite', password_reset: '/reset' };

/** Issues a new link (revoking older unused ones of the same kind) and emails it. */
/** expiresInMinutes: optional per-link lifetime (admin-chosen, e.g. for a dedicated expiry test); default is the kind's TTL. */
async function issue(userId, kind, { isResend = false, byUserId = null, expiresInMinutes = null, data = {} } = {}) {
  const u = await db.one(`select u.*, m.id as mentor_id, coalesce(m.name, s.name, u.name) as display_name
    from anvaya.users u left join anvaya.mentors m on m.user_id = u.id left join anvaya.students s on s.user_id = u.id where u.id = $1`, [userId]);
  if (!u) throw Object.assign(new Error('Account not found.'), { status: 404 });
  const token = sec.randomToken(32);
  const expiresAt = new Date(Date.now() + (expiresInMinutes ? expiresInMinutes * 60e3 : TTL_HOURS[kind] * 3600e3));
  const url = `${BASE_URL()}${PATH[kind]}?token=${encodeURIComponent(token)}`;
  const jobId = await db.tx(async (t) => {
    await t.run(`update anvaya.invitations set revoked_at = now() where user_id = $1 and kind = $2 and used_at is null and revoked_at is null`, [userId, kind]);
    await t.run(`insert into anvaya.invitations (mentor_id, user_id, kind, token_hash, expires_at) values ($1,$2,$3,$4,$5)`,
      [kind === 'mentor_invite' ? u.mentor_id : null, userId, kind, sec.sha256(token), expiresAt]);
    const { jobId: id } = await sendEmail(u.email, kind, { name: u.display_name || 'there', url, expiresAt: expiresAt.toISOString(), isResend, ...data }, { secret: true, q: t });
    return id;
  });
  db.audit(byUserId, `${kind}_${isResend ? 'resent' : 'sent'}`, `user:${userId}`);
  const jobs = require('./jobs');
  const r = await jobs.runNow(jobId);
  return { expiresAt, delivered: !!r.ok && !r.skipped, error: r.ok ? null : r.error };
}

async function lookup(token, kinds) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return { state: 'invalid' };
  const inv = await db.one(`select i.*, u.email, u.role, u.password_hash, u.disabled_at, coalesce(m.name, s.name, u.name) as name, m.status as mentor_status
    from anvaya.invitations i join anvaya.users u on u.id = i.user_id
    left join anvaya.mentors m on m.user_id = u.id left join anvaya.students s on s.user_id = u.id
    where i.token_hash = $1`, [sec.sha256(token)]);
  if (!inv || (kinds && !kinds.includes(inv.kind))) return { state: 'invalid' };
  let state = 'valid';
  if (inv.mentor_status === 'deactivated' || inv.disabled_at) state = 'deactivated';
  else if (inv.used_at || (inv.kind !== 'password_reset' && inv.password_hash)) state = 'used';
  else if (inv.revoked_at) state = 'superseded';
  else if (new Date(inv.expires_at) <= new Date()) state = 'expired';
  return { state, inv };
}

/** Atomically consumes a valid link and sets the password. Returns the user id. */
async function consume(inv, password) {
  const hash = sec.hashPassword(password);
  await db.tx(async (t) => {
    const r = await t.run(`update anvaya.invitations set used_at = now()
      where id = $1 and used_at is null and revoked_at is null and expires_at > now()`, [inv.id]);
    if (r.rowCount !== 1) throw Object.assign(new Error('This link can no longer be used.'), { status: 410 });
    await t.run('update anvaya.users set password_hash = $1 where id = $2', [hash, inv.user_id]);
    await t.run('update anvaya.invitations set revoked_at = now() where user_id = $1 and id <> $2 and used_at is null and revoked_at is null', [inv.user_id, inv.id]);
    if (inv.kind === 'password_reset') await sec.revokeAllSessions(inv.user_id, t);
  });
  return inv.user_id;
}

const maskEmail = (e) => e.replace(/^(.)(.*)(.@.*)$/, (_, a, b, c) => a + '•'.repeat(Math.min(b.length, 6)) + c);

/** Where a freshly signed-in user should land. */
async function landing(userId) {
  const u = await db.one('select role from anvaya.users where id = $1', [userId]);
  if (u.role === 'admin' || u.role === 'ops') return '/admin';
  if (u.role === 'mentor') {
    const m = await db.one('select status from anvaya.mentors where user_id = $1', [userId]);
    return m.status === 'active' ? '/mentor' : '/mentor/onboarding';
  }
  if (u.role === 'student') {
    const s = await db.one('select intake_completed_at from anvaya.students where user_id = $1', [userId]);
    return s?.intake_completed_at ? '/student' : '/student#intake';
  }
  return '/';
}

module.exports = { issue, lookup, consume, maskEmail, landing, BASE_URL };
