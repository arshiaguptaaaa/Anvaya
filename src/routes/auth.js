'use strict';
const express = require('express');
const db = require('../db');
const sec = require('../security');
const accounts = require('../lib/accounts');
const { HttpError, bad, wrap } = require('../lib/http');

const r = express.Router();

const loginLimiter = sec.rateLimiter({ name: 'login', windowMs: 15 * 60e3, max: 10, key: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase()}` });
const loginIpLimiter = sec.rateLimiter({ name: 'login-ip', windowMs: 15 * 60e3, max: 50, key: (req) => req.ip });
const linkLimiter = sec.rateLimiter({ name: 'invite', windowMs: 15 * 60e3, max: 30, key: (req) => req.ip });
const resendLimiter = sec.rateLimiter({ name: 'invite-resend', windowMs: 60 * 60e3, max: 5, key: (req) => req.ip });
const forgotLimiter = sec.rateLimiter({ name: 'forgot', windowMs: 60 * 60e3, max: 5, key: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase()}` });

r.post('/auth/login', loginIpLimiter, loginLimiter, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = await db.one('select * from anvaya.users where lower(email) = $1', [email]);
  const ok = sec.verifyPassword(password, user?.password_hash || sec.DUMMY_HASH) && !!user?.password_hash;
  if (!ok) { db.audit(user?.id, 'login_failed', email); return res.status(401).json({ error: 'Incorrect email or password.' }); }
  if (user.disabled_at) return res.status(403).json({ error: 'This account has been disabled. Please contact the Anvaya team.' });
  if (user.role === 'mentor') {
    const m = await db.one('select status from anvaya.mentors where user_id = $1', [user.id]);
    if (m.status === 'deactivated') return res.status(403).json({ error: 'Your mentor access has been deactivated. Please contact the Anvaya team.' });
  }
  await sec.createSession(res, user.id);
  db.audit(user.id, 'login');
  res.json({ ok: true, role: user.role, next: await accounts.landing(user.id) });
}));

r.post('/auth/logout', wrap(async (req, res) => { await sec.destroySession(req, res); res.json({ ok: true }); }));

r.get('/auth/me', (req, res) => {
  if (!req.auth) return res.status(401).json({ error: 'Not signed in.' });
  const { user, mentor, student, csrf } = req.auth;
  res.json({ user, csrf, mentor: mentor && { id: mentor.id, name: mentor.name, status: mentor.status },
    student: student && { id: student.id, name: student.name, intake_completed: !!student.intake_completed_at } });
});

r.post('/auth/change-password', wrap(async (req, res) => {
  if (!req.auth) return res.status(401).json({ error: 'Please sign in.' });
  const u = await db.one('select * from anvaya.users where id = $1', [req.auth.user.id]);
  if (!sec.verifyPassword(String(req.body?.current || ''), u.password_hash)) throw bad('Your current password is incorrect.');
  const problem = sec.passwordProblem(req.body?.next); if (problem) throw bad(problem);
  await db.run('update anvaya.users set password_hash = $1 where id = $2', [sec.hashPassword(req.body.next), u.id]);
  await sec.revokeAllSessions(u.id);
  await sec.createSession(res, u.id);
  db.audit(u.id, 'password_changed');
  res.json({ ok: true });
}));

// Forgot password: always the same answer, so it can't be used to discover accounts.
r.post('/auth/forgot', forgotLimiter, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const u = email && await db.one('select id, password_hash, disabled_at from anvaya.users where lower(email) = $1', [email]);
  if (u && u.password_hash && !u.disabled_at) await accounts.issue(u.id, 'password_reset').catch((e) => console.error('[reset]', e.message));
  res.json({ ok: true, message: 'If an account exists for that email, a reset link is on its way. It expires in 1 hour.' });
}));

// ── Single-use links (invite + reset) ────────────────────────────────
function describe(state, inv) {
  const out = { state, kind: inv?.kind };
  if (inv && state === 'valid') Object.assign(out, { name: inv.name, email: inv.email, expiresAt: inv.expires_at, role: inv.role });
  else if (inv) out.name = (inv.name || '').split(' ')[0];
  if (inv && (state === 'expired' || state === 'superseded')) out.email = accounts.maskEmail(inv.email);
  return out;
}

r.post('/invites/inspect', linkLimiter, wrap(async (req, res) => {
  const { state, inv } = await accounts.lookup(req.body?.token);
  res.json(describe(state, inv));
}));

r.post('/invites/accept', linkLimiter, wrap(async (req, res) => {
  const { state, inv } = await accounts.lookup(req.body?.token);
  if (state !== 'valid') return res.status(410).json({ error: 'This link can no longer be used.', state });
  const problem = sec.passwordProblem(req.body?.password); if (problem) throw bad(problem);
  if (req.body?.password !== req.body?.confirm) throw bad('The two passwords do not match.');
  const userId = await accounts.consume(inv, req.body.password);
  if (req.auth) await sec.destroySession(req, res);
  await sec.createSession(res, userId);
  db.audit(userId, `${inv.kind}_accepted`);
  res.json({ ok: true, next: await accounts.landing(userId) });
}));

r.post('/invites/request-new', resendLimiter, wrap(async (req, res) => {
  const { state, inv } = await accounts.lookup(req.body?.token);
  if (state === 'expired' || state === 'superseded') {
    // The fresh link only ever goes to the email on file — never to an address supplied by the requester.
    const out = await accounts.issue(inv.user_id, inv.kind, { isResend: true });
    if (!out.delivered) throw new HttpError(502, 'We couldn’t send the email just now. It will be retried automatically — please check again in a few minutes.');
    return res.json({ ok: true, message: `A fresh link has been sent to ${accounts.maskEmail(inv.email)}.` });
  }
  if (state === 'valid') return res.json({ ok: true, message: 'This link is still valid — you can use it now.' });
  if (state === 'used') return res.status(409).json({ error: 'This link was already used. Please sign in instead.', state });
  res.status(400).json({ error: 'We could not find that link. Please contact the Anvaya team.', state });
}));

module.exports = r;
