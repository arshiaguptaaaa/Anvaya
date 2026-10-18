'use strict';
// Express app shared by local dev (src/server.js) and Vercel (api/index.js).
const path = require('node:path');
const express = require('express');
const db = require('./db');
const sec = require('./security');
const mailer = require('./mailer');

const IS_PROD = process.env.NODE_ENV === 'production';
const INVITE_TTL_HOURS = Number(process.env.INVITE_TTL_HOURS || 72);
const BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
if (IS_PROD && !process.env.APP_BASE_URL) throw new Error('APP_BASE_URL must be set in production (used to build invitation links).');

const VIEWS = path.join(__dirname, 'views');
const PUBLIC = path.join(__dirname, '..', 'public');

// ── Seed the first admin from env once (only if no admin exists yet) ──
let seeded = null;
function seedAdmin() {
  if (!seeded) seeded = (async () => {
    const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
    if (await db.one("select 1 from anvaya.users where role = 'admin'")) return;
    const problem = sec.passwordProblem(ADMIN_PASSWORD);
    if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
    await db.run("insert into anvaya.users (email, password_hash, role) values ($1, $2, 'admin') on conflict do nothing",
      [ADMIN_EMAIL.trim().toLowerCase(), sec.hashPassword(ADMIN_PASSWORD)]);
  })().catch((e) => { seeded = null; throw e; });
  return seeded;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || (process.env.VERCEL ? 1 : false));
app.use(express.json({ limit: '100kb' }));
app.use(sec.parseCookies);
app.use(async (_req, _res, next) => { try { await seedAdmin(); next(); } catch (e) { next(e); } });
app.use(sec.loadSession);

// ── Validation helpers ────────────────────────────────────────────────
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const v = {
  str(val, { max = 500, required = false, label = 'Field' } = {}) {
    const s = val == null ? '' : String(val).trim();
    if (required && !s) throw bad(`${label} is required.`);
    if (s.length > max) throw bad(`${label} is too long (max ${max} characters).`);
    return s;
  },
  email(val, { required = true } = {}) {
    const s = v.str(val, { max: 254, required, label: 'Email' }).toLowerCase();
    if (s && !EMAIL_RE.test(s)) throw bad('Please enter a valid email address.');
    return s;
  },
  int(val, { min = 0, max = 10_000_000, label = 'Value', required = false } = {}) {
    if (val === '' || val == null) { if (required) throw bad(`${label} is required.`); return null; }
    const n = Number(val);
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be a whole number between ${min} and ${max}.`);
    return n;
  },
  oneOf(val, list, label = 'Value') {
    if (!list.includes(val)) throw bad(`${label} must be one of: ${list.join(', ')}.`);
    return val;
  },
  date(val, { required = false, label = 'Date' } = {}) {
    if (!val) { if (required) throw bad(`${label} is required.`); return null; }
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) throw bad(`${label} is not a valid date.`);
    return d.toISOString();
  },
  url(val, label = 'Link') {
    const s = v.str(val, { max: 500, label });
    if (s && !/^https:\/\/[^\s]+$/i.test(s)) throw bad(`${label} must start with https://`);
    return s;
  },
  time(val) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(val))) throw bad('Times must be in HH:MM format.');
    return String(val);
  },
};
const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'Not found.'); return n; };
const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
const setClause = (keys, start = 1) => keys.map((k, i) => `${k} = $${i + start}`).join(', ');

// ── Security headers ──────────────────────────────────────────────────
const APP_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');
function appHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': APP_CSP, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  });
  if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}
app.use(['/api', '/admin', '/mentor', '/invite'], appHeaders);
// Login, invitation and public-lead endpoints carry their own checks, so they skip the session CSRF check.
const CSRF_EXEMPT = (p) => p === '/auth/login' || p.startsWith('/invites/') || p === '/public/leads';
app.use('/api', (req, res, next) => (CSRF_EXEMPT(req.path) ? next() : sec.csrfProtect(req, res, next)));

// ══════════════════════════════════════════════════════════════════════
// Pages (server-side gatekeeping; the APIs enforce permissions again)
// ══════════════════════════════════════════════════════════════════════
const page = (res, name, status = 200) => res.status(status).sendFile(path.join(VIEWS, name));

app.get('/admin/login', (req, res) => (req.auth?.user.role === 'admin' ? res.redirect('/admin') : page(res, 'login.html')));
app.get(['/admin', '/admin/*'], (req, res) => {
  if (!req.auth) return res.redirect('/admin/login');
  if (req.auth.user.role !== 'admin') return page(res, 'forbidden.html', 403);
  page(res, 'admin.html');
});
app.get('/mentor/login', (req, res) => (req.auth?.user.role === 'mentor' ? res.redirect('/mentor') : page(res, 'login.html')));
app.get('/mentor/onboarding', (req, res) => {
  if (!req.auth) return res.redirect('/mentor/login');
  if (req.auth.user.role !== 'mentor') return page(res, 'forbidden.html', 403);
  if (req.auth.mentor.status === 'active') return res.redirect('/mentor');
  page(res, 'onboarding.html');
});
app.get(['/mentor', '/mentor/*'], (req, res) => {
  if (!req.auth) return res.redirect('/mentor/login');
  if (req.auth.user.role !== 'mentor') return page(res, 'forbidden.html', 403);
  if (req.auth.mentor.status !== 'active') return res.redirect('/mentor/onboarding');
  page(res, 'mentor.html');
});
app.get('/invite', (_req, res) => page(res, 'invite.html'));

// ══════════════════════════════════════════════════════════════════════
// Auth
// ══════════════════════════════════════════════════════════════════════
const loginLimiter = sec.rateLimiter({ name: 'login', windowMs: 15 * 60e3, max: 10, key: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase()}` });
const loginIpLimiter = sec.rateLimiter({ name: 'login-ip', windowMs: 15 * 60e3, max: 50, key: (req) => req.ip });

app.post('/api/auth/login', loginIpLimiter, loginLimiter, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = await db.one('select * from anvaya.users where lower(email) = $1', [email]);
  const ok = sec.verifyPassword(password, user?.password_hash || sec.DUMMY_HASH) && !!user?.password_hash;
  if (!ok) { db.audit(user?.id, 'login_failed', email); return res.status(401).json({ error: 'Incorrect email or password.' }); }
  let next = '/admin';
  if (user.role === 'mentor') {
    const m = await db.one('select status from anvaya.mentors where user_id = $1', [user.id]);
    if (m.status === 'deactivated') return res.status(403).json({ error: 'Your mentor access has been deactivated. Please contact the Anvaya team.' });
    next = m.status === 'active' ? '/mentor' : '/mentor/onboarding';
  }
  await sec.createSession(res, user.id);
  db.audit(user.id, 'login');
  res.json({ ok: true, role: user.role, next });
}));

app.post('/api/auth/logout', wrap(async (req, res) => { await sec.destroySession(req, res); res.json({ ok: true }); }));

app.get('/api/auth/me', (req, res) => {
  if (!req.auth) return res.status(401).json({ error: 'Not signed in.' });
  const { user, mentor, csrf } = req.auth;
  res.json({ user, csrf, mentor: mentor && { id: mentor.id, name: mentor.name, status: mentor.status } });
});

app.post('/api/auth/change-password', wrap(async (req, res) => {
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

// ══════════════════════════════════════════════════════════════════════
// Invitations
// ══════════════════════════════════════════════════════════════════════
async function issueInvite(mentorId, { isResend = false, byUserId = null } = {}) {
  const m = await db.one('select m.*, u.email from anvaya.mentors m join anvaya.users u on u.id = m.user_id where m.id = $1', [mentorId]);
  const token = sec.randomToken(32);
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600e3);
  await db.tx(async (t) => {
    // Only the newest link is ever valid.
    await t.run('update anvaya.invitations set revoked_at = now() where mentor_id = $1 and used_at is null and revoked_at is null', [mentorId]);
    await t.run('insert into anvaya.invitations (mentor_id, token_hash, expires_at) values ($1,$2,$3)', [mentorId, sec.sha256(token), expiresAt]);
  });
  db.audit(byUserId, isResend ? 'invite_resent' : 'invite_sent', `mentor:${mentorId}`);
  const url = `${BASE_URL}/invite?token=${encodeURIComponent(token)}`;
  const delivery = await mailer.sendMentorInvite({ to: m.email, name: m.name, url, expiresAt: expiresAt.toISOString(), isResend });
  return { expiresAt, delivery: { mode: delivery.mode } }; // don't expose provider ids to the browser
}

async function lookupInvite(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return { state: 'invalid' };
  const inv = await db.one(`select i.*, m.name, m.status as mentor_status, m.user_id, u.email, u.password_hash
    from anvaya.invitations i join anvaya.mentors m on m.id = i.mentor_id join anvaya.users u on u.id = m.user_id
    where i.token_hash = $1`, [sec.sha256(token)]);
  if (!inv) return { state: 'invalid' };
  let state = 'valid';
  if (inv.mentor_status === 'deactivated') state = 'deactivated';
  else if (inv.used_at || inv.password_hash) state = 'used';
  else if (inv.revoked_at) state = 'superseded';
  else if (new Date(inv.expires_at) <= new Date()) state = 'expired';
  return { state, inv };
}
const maskEmail = (e) => e.replace(/^(.)(.*)(.@.*)$/, (_, a, b, c) => a + '•'.repeat(Math.min(b.length, 6)) + c);

const inviteLimiter = sec.rateLimiter({ name: 'invite', windowMs: 15 * 60e3, max: 30, key: (req) => req.ip });
const resendLimiter = sec.rateLimiter({ name: 'invite-resend', windowMs: 60 * 60e3, max: 5, key: (req) => req.ip });

app.post('/api/invites/inspect', inviteLimiter, wrap(async (req, res) => {
  const { state, inv } = await lookupInvite(req.body?.token);
  const out = { state };
  if (inv && state === 'valid') Object.assign(out, { name: inv.name, email: inv.email, expiresAt: inv.expires_at });
  if (inv && state !== 'valid') out.name = inv.name.split(' ')[0];
  if (inv && (state === 'expired' || state === 'superseded')) out.email = maskEmail(inv.email);
  res.json(out);
}));

app.post('/api/invites/accept', inviteLimiter, wrap(async (req, res) => {
  const { state, inv } = await lookupInvite(req.body?.token);
  if (state !== 'valid') return res.status(410).json({ error: 'This invitation link can no longer be used.', state });
  const problem = sec.passwordProblem(req.body?.password); if (problem) throw bad(problem);
  if (req.body?.password !== req.body?.confirm) throw bad('The two passwords do not match.');
  const hash = sec.hashPassword(req.body.password);
  await db.tx(async (t) => {
    // Atomic single-use claim: only one request can flip used_at.
    const r = await t.run(`update anvaya.invitations set used_at = now()
      where id = $1 and used_at is null and revoked_at is null and expires_at > now()`, [inv.id]);
    if (r.rowCount !== 1) throw new HttpError(410, 'This invitation link can no longer be used.');
    await t.run('update anvaya.users set password_hash = $1 where id = $2', [hash, inv.user_id]);
    await t.run('update anvaya.invitations set revoked_at = now() where mentor_id = $1 and id <> $2 and used_at is null and revoked_at is null', [inv.mentor_id, inv.id]);
  });
  if (req.auth) await sec.destroySession(req, res);
  await sec.createSession(res, inv.user_id);
  db.audit(inv.user_id, 'invite_accepted', `mentor:${inv.mentor_id}`);
  res.json({ ok: true, next: '/mentor/onboarding' });
}));

app.post('/api/invites/request-new', resendLimiter, wrap(async (req, res) => {
  const { state, inv } = await lookupInvite(req.body?.token);
  if (state === 'expired' || state === 'superseded') {
    // The fresh link only ever goes to the email address on file — never to an address supplied by the requester.
    await issueInvite(inv.mentor_id, { isResend: true });
    return res.json({ ok: true, message: `A fresh invitation link has been sent to ${maskEmail(inv.email)}.` });
  }
  if (state === 'valid') return res.json({ ok: true, message: 'This link is still valid — you can accept it now.' });
  if (state === 'used') return res.status(409).json({ error: 'This invitation was already accepted. Please sign in instead.', state });
  res.status(400).json({ error: 'We could not find that invitation. Please contact the Anvaya team.', state });
}));

// ══════════════════════════════════════════════════════════════════════
// Public: free-chat enquiries from the brochure → CRM leads
// ══════════════════════════════════════════════════════════════════════
const leadLimiter = sec.rateLimiter({ name: 'lead', windowMs: 60 * 60e3, max: 10, key: (req) => req.ip });
app.post('/api/public/leads', leadLimiter, wrap(async (req, res) => {
  // Same-origin only: the brochure posts here from its own page.
  const origin = req.get('origin');
  if (origin && origin !== BASE_URL && !(!IS_PROD && /^http:\/\/localhost(:\d+)?$/.test(origin))) throw new HttpError(403, 'Forbidden.');
  const b = req.body || {};
  if (b.website) return res.status(201).json({ ok: true }); // honeypot: silently drop bots
  const name = v.str(b.name, { max: 120, required: true, label: 'Name' });
  const phone = v.str(b.phone, { max: 40, required: true, label: 'Phone' });
  if (!/^[+\d][\d\s()-]{6,}$/.test(phone)) throw bad('Please enter a valid phone number.');
  const situation = v.str(b.situation, { max: 200, label: 'Situation' });
  // Skip exact duplicates submitted within 10 minutes (double clicks / retries).
  const dup = await db.one("select id from anvaya.leads where phone = $1 and name = $2 and created_at > now() - interval '10 minutes'", [phone, name]);
  if (!dup) await db.run("insert into anvaya.leads (name, phone, situation, source) values ($1,$2,$3,'Free 15-min chat (website)')", [name, phone, situation]);
  res.status(201).json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════════════
// Admin API — every route below requires role=admin
// ══════════════════════════════════════════════════════════════════════
const admin = express.Router();
admin.use(sec.requireRole('admin'));

admin.get('/overview', wrap(async (_req, res) => {
  const n = async (sql) => (await db.one(sql)).n;
  res.json({
    counts: {
      leadsNew: await n("select count(*) n from anvaya.leads where status = 'new'"),
      leads: await n('select count(*) n from anvaya.leads'),
      students: await n("select count(*) n from anvaya.students where status = 'active'"),
      mentorsActive: await n("select count(*) n from anvaya.mentors where status = 'active'"),
      mentorsPending: await n("select count(*) n from anvaya.mentors where status = 'invite_pending'"),
      upcoming: await n("select count(*) n from anvaya.bookings where status = 'scheduled' and scheduled_at >= now()"),
    },
    revenue: {
      paid: await n("select coalesce(sum(amount),0) n from anvaya.payments where status = 'paid'"),
      pending: await n("select coalesce(sum(amount),0) n from anvaya.payments where status = 'pending'"),
      mentorPayable: await n("select coalesce(sum(mentor_fee),0) n from anvaya.bookings where status = 'completed'"),
    },
    upcoming: await db.all(`select b.id, b.scheduled_at, b.service, s.name as student, m.name as mentor
      from anvaya.bookings b join anvaya.students s on s.id = b.student_id left join anvaya.mentors m on m.id = b.mentor_id
      where b.status = 'scheduled' and b.scheduled_at >= now() order by b.scheduled_at limit 8`),
    recentLeads: await db.all('select id, name, situation, status, created_at from anvaya.leads order by id desc limit 6'),
    mail: mailer.mailMode(),
  });
}));

// ── Mentors ───────────────────────────────────────────────────────────
const mentorSelect = `select m.*, u.email, (u.password_hash is not null) as has_password, u.last_login_at,
  (select count(*) from anvaya.students s where s.mentor_id = m.id) as student_count,
  (select count(*) from anvaya.bookings b where b.mentor_id = m.id and b.status = 'scheduled') as upcoming_count,
  (select coalesce(sum(mentor_fee),0) from anvaya.bookings b where b.mentor_id = m.id and b.status = 'completed') as earned,
  (select max(expires_at) from anvaya.invitations i where i.mentor_id = m.id and i.used_at is null and i.revoked_at is null) as invite_expires_at
  from anvaya.mentors m join anvaya.users u on u.id = m.user_id`;

function mentorFields(body, { partial }) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;
  if (has('name')) out.name = v.str(body.name, { max: 120, required: true, label: 'Name' });
  if (has('expertise')) out.expertise = v.str(body.expertise, { max: 300, label: 'Expertise' });
  if (has('bio')) out.bio = v.str(body.bio, { max: 3000, label: 'Bio' });
  if (has('session_price')) out.session_price = v.int(body.session_price, { max: 1_000_000, label: 'Session price', required: !partial }) ?? 0;
  if (body.session_duration !== undefined) out.session_duration = v.int(body.session_duration, { min: 15, max: 240, label: 'Session duration' }) ?? 45;
  if (body.session_details !== undefined) out.session_details = v.str(body.session_details, { max: 2000, label: 'Session details' });
  return out;
}

admin.get('/mentors', wrap(async (_req, res) => {
  res.json(await db.all(`${mentorSelect} order by case m.status when 'active' then 0 when 'invite_pending' then 1 else 2 end, m.name`));
}));
admin.get('/mentors/:id', wrap(async (req, res) => {
  const m = await db.one(`${mentorSelect} where m.id = $1`, [id(req)]);
  if (!m) throw new HttpError(404, 'Mentor not found.');
  m.availability = await db.all('select weekday, start_time, end_time from anvaya.availability where mentor_id = $1 order by weekday, start_time', [m.id]);
  res.json(m);
}));

admin.post('/mentors', wrap(async (req, res) => {
  const f = mentorFields(req.body || {}, { partial: false });
  const email = v.email(req.body?.email);
  if (await db.one('select 1 from anvaya.users where lower(email) = $1', [email])) throw new HttpError(409, 'An account with this email already exists.');
  const mentorId = await db.tx(async (t) => {
    const u = await t.one("insert into anvaya.users (email, role) values ($1, 'mentor') returning id", [email]);
    return (await t.one(`insert into anvaya.mentors (user_id, name, expertise, bio, session_price, session_duration, session_details)
      values ($1,$2,$3,$4,$5,$6,$7) returning id`, [u.id, f.name, f.expertise, f.bio, f.session_price, f.session_duration ?? 45, f.session_details ?? ''])).id;
  });
  db.audit(req.auth.user.id, 'mentor_created', `mentor:${mentorId}`);
  let invite = null, mailError = null;
  if (req.body?.send_invite !== false) {
    try { invite = await issueInvite(mentorId, { byUserId: req.auth.user.id }); }
    catch (e) { mailError = e.message; console.error('[mail] invite failed:', e.message); }
  }
  res.status(201).json({ id: mentorId, invite, mailError });
}));

admin.patch('/mentors/:id', wrap(async (req, res) => {
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

admin.post('/mentors/:id/resend-invite', wrap(async (req, res) => {
  const mid = id(req);
  const m = await db.one('select m.*, u.password_hash from anvaya.mentors m join anvaya.users u on u.id = m.user_id where m.id = $1', [mid]);
  if (!m) throw new HttpError(404, 'Mentor not found.');
  if (m.status !== 'invite_pending') throw bad(m.status === 'active' ? 'This mentor is already active.' : 'Reactivate this mentor before sending an invitation.');
  if (m.password_hash) throw bad('This mentor has already accepted the invitation and is completing their profile. They can sign in at /mentor/login.');
  const invite = await issueInvite(mid, { isResend: true, byUserId: req.auth.user.id });
  res.json({ ok: true, invite });
}));

admin.post('/mentors/:id/deactivate', wrap(async (req, res) => {
  const mid = id(req);
  const m = await db.one('select * from anvaya.mentors where id = $1', [mid]);
  if (!m) throw new HttpError(404, 'Mentor not found.');
  await db.tx(async (t) => {
    await t.run("update anvaya.mentors set status = 'deactivated', updated_at = now() where id = $1", [mid]);
    await t.run('update anvaya.invitations set revoked_at = now() where mentor_id = $1 and used_at is null and revoked_at is null', [mid]);
    await sec.revokeAllSessions(m.user_id, t); // signs them out everywhere, immediately
  });
  db.audit(req.auth.user.id, 'mentor_deactivated', `mentor:${mid}`);
  res.json({ ok: true });
}));

admin.post('/mentors/:id/reactivate', wrap(async (req, res) => {
  const mid = id(req);
  const m = await db.one('select m.*, u.password_hash from anvaya.mentors m join anvaya.users u on u.id = m.user_id where m.id = $1', [mid]);
  if (!m) throw new HttpError(404, 'Mentor not found.');
  const status = m.password_hash && m.profile_completed ? 'active' : 'invite_pending';
  await db.run('update anvaya.mentors set status = $1, updated_at = now() where id = $2', [status, mid]);
  db.audit(req.auth.user.id, 'mentor_reactivated', `mentor:${mid}`);
  res.json({ ok: true, status });
}));

// ── Generic CRM resources (leads, students, bookings, payments) ──────
function crmResource(router, name, { table, list, parse, after }) {
  router.get(`/${name}`, wrap(async (_req, res) => res.json(await db.all(list))));
  router.post(`/${name}`, wrap(async (req, res) => {
    const f = await parse(req.body || {}, { partial: false });
    const keys = Object.keys(f);
    const r = await db.one(`insert into anvaya.${table} (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, keys.map((k) => f[k]));
    await after?.(r.id, f);
    db.audit(req.auth.user.id, `${name}_created`, `${table}:${r.id}`);
    res.status(201).json({ id: r.id });
  }));
  router.patch(`/${name}/:id`, wrap(async (req, res) => {
    const rid = id(req);
    if (!await db.one(`select 1 from anvaya.${table} where id = $1`, [rid])) throw new HttpError(404, 'Not found.');
    const f = await parse(req.body || {}, { partial: true });
    const keys = Object.keys(f);
    if (keys.length) await db.run(`update anvaya.${table} set ${setClause(keys)} where id = $${keys.length + 1}`, [...keys.map((k) => f[k]), rid]);
    await after?.(rid, f);
    db.audit(req.auth.user.id, `${name}_updated`, `${table}:${rid}`);
    res.json({ ok: true });
  }));
  router.delete(`/${name}/:id`, wrap(async (req, res) => {
    const rid = id(req);
    const r = await db.run(`delete from anvaya.${table} where id = $1`, [rid]);
    if (!r.rowCount) throw new HttpError(404, 'Not found.');
    db.audit(req.auth.user.id, `${name}_deleted`, `${table}:${rid}`);
    res.json({ ok: true });
  }));
}
/** Builds an async field parser: spec maps field → (value) => cleaned. Missing fields are skipped on PATCH. */
const fields = (spec, required = []) => async (body, { partial }) => {
  const out = {};
  for (const [k, fn] of Object.entries(spec)) {
    if (body[k] === undefined) { if (!partial && required.includes(k)) out[k] = await fn(undefined); continue; }
    out[k] = await fn(body[k]);
  }
  return out;
};
const mentorRef = async (val) => {
  const n = v.int(val, { min: 1, label: 'Mentor' });
  if (n == null) return null;
  const m = await db.one('select status from anvaya.mentors where id = $1', [n]);
  if (!m) throw bad('Mentor not found.');
  if (m.status !== 'active') throw bad('Only active mentors can be assigned.');
  return n;
};
const studentRef = async (val) => {
  const n = v.int(val, { min: 1, label: 'Student', required: true });
  if (!await db.one('select 1 from anvaya.students where id = $1', [n])) throw bad('Student not found.');
  return n;
};

crmResource(admin, 'leads', {
  table: 'leads',
  list: 'select * from anvaya.leads order by id desc',
  parse: fields({
    name: (x) => v.str(x, { max: 120, required: true, label: 'Name' }),
    email: (x) => v.email(x, { required: false }),
    phone: (x) => v.str(x, { max: 40, label: 'Phone' }),
    situation: (x) => v.str(x, { max: 200, label: 'Situation' }),
    source: (x) => v.str(x, { max: 80, label: 'Source' }) || 'Free 15-min chat',
    status: (x) => v.oneOf(x, ['new', 'contacted', 'qualified', 'converted', 'lost'], 'Status'),
    notes: (x) => v.str(x, { max: 3000, label: 'Notes' }),
  }, ['name']),
});
admin.post('/leads/:id/convert', wrap(async (req, res) => {
  const lid = id(req);
  const l = await db.one('select * from anvaya.leads where id = $1', [lid]);
  if (!l) throw new HttpError(404, 'Lead not found.');
  if (l.student_id) throw bad('This lead has already been converted.');
  const sid = await db.tx(async (t) => {
    const s = await t.one('insert into anvaya.students (name, email, phone, stage, notes) values ($1,$2,$3,$4,$5) returning id', [l.name, l.email, l.phone, l.situation, l.notes]);
    await t.run("update anvaya.leads set status = 'converted', student_id = $1 where id = $2", [s.id, lid]);
    return s.id;
  });
  db.audit(req.auth.user.id, 'lead_converted', `lead:${lid} → student:${sid}`);
  res.json({ ok: true, student_id: sid });
}));

crmResource(admin, 'students', {
  table: 'students',
  list: `select s.*, m.name as mentor_name,
    (select count(*) from anvaya.bookings b where b.student_id = s.id) as booking_count,
    (select coalesce(sum(amount),0) from anvaya.payments p where p.student_id = s.id and p.status = 'paid') as paid_total
    from anvaya.students s left join anvaya.mentors m on m.id = s.mentor_id order by s.id desc`,
  parse: fields({
    name: (x) => v.str(x, { max: 120, required: true, label: 'Name' }),
    email: (x) => v.email(x, { required: false }),
    phone: (x) => v.str(x, { max: 40, label: 'Phone' }),
    stage: (x) => v.str(x, { max: 200, label: 'Stage' }),
    goals: (x) => v.str(x, { max: 2000, label: 'Goals' }),
    plan: (x) => v.str(x, { max: 120, label: 'Plan' }),
    status: (x) => v.oneOf(x, ['active', 'paused', 'completed'], 'Status'),
    mentor_id: mentorRef,
    notes: (x) => v.str(x, { max: 3000, label: 'Notes' }),
  }, ['name']),
});

const bookingFields = fields({
  student_id: studentRef,
  mentor_id: mentorRef,
  service: (x) => v.str(x, { max: 120, label: 'Service' }),
  scheduled_at: (x) => v.date(x, { required: true, label: 'Date & time' }),
  duration: (x) => v.int(x, { min: 15, max: 240, label: 'Duration' }) ?? 45,
  status: (x) => v.oneOf(x, ['scheduled', 'completed', 'cancelled', 'no_show'], 'Status'),
  price: (x) => v.int(x, { label: 'Price' }) ?? 0,
  mentor_fee: (x) => v.int(x, { label: 'Mentor fee' }),
  meeting_link: (x) => v.url(x, 'Meeting link'),
}, ['student_id', 'scheduled_at']);
crmResource(admin, 'bookings', {
  table: 'bookings',
  list: `select b.*, s.name as student_name, m.name as mentor_name from anvaya.bookings b
    join anvaya.students s on s.id = b.student_id left join anvaya.mentors m on m.id = b.mentor_id order by b.scheduled_at desc`,
  parse: async (body, opts) => {
    const f = await bookingFields(body, opts);
    // Default the mentor fee to the mentor's session price when not given.
    if (!opts.partial && f.mentor_id && f.mentor_fee == null) {
      f.mentor_fee = (await db.one('select session_price from anvaya.mentors where id = $1', [f.mentor_id])).session_price;
    }
    if (f.mentor_fee == null) delete f.mentor_fee;
    if (f.status === 'completed') f.completed_at = new Date().toISOString();
    return f;
  },
  after: async (bid) => {
    // Booking a student with a mentor assigns them, if the student has no mentor yet.
    const b = await db.one('select student_id, mentor_id from anvaya.bookings where id = $1', [bid]);
    if (b?.mentor_id) await db.run('update anvaya.students set mentor_id = $1 where id = $2 and mentor_id is null', [b.mentor_id, b.student_id]);
  },
});

crmResource(admin, 'payments', {
  table: 'payments',
  list: `select p.*, s.name as student_name, b.service as booking_service from anvaya.payments p
    join anvaya.students s on s.id = p.student_id left join anvaya.bookings b on b.id = p.booking_id order by p.id desc`,
  parse: fields({
    student_id: studentRef,
    booking_id: async (x) => {
      const n = v.int(x, { min: 1, label: 'Booking' });
      if (n != null && !await db.one('select 1 from anvaya.bookings where id = $1', [n])) throw bad('Booking not found.');
      return n;
    },
    amount: (x) => v.int(x, { min: 0, label: 'Amount', required: true }),
    method: (x) => v.str(x, { max: 40, label: 'Method' }) || 'UPI',
    reference: (x) => v.str(x, { max: 120, label: 'Reference' }),
    status: (x) => v.oneOf(x, ['pending', 'paid', 'refunded', 'failed'], 'Status'),
    paid_at: (x) => v.date(x, { label: 'Paid on' }),
  }, ['student_id', 'amount']),
});

app.use('/api/admin', admin);

// ══════════════════════════════════════════════════════════════════════
// Mentor API — always scoped to req.auth.mentor.id; never trusts an ID from the client for ownership
// ══════════════════════════════════════════════════════════════════════
const mentorApi = express.Router();
mentorApi.use(sec.requireRole('mentor'));

async function mentorProfile(mid) {
  const m = await db.one(`select m.id, m.name, m.expertise, m.bio, m.session_price, m.session_duration, m.session_details,
    m.meeting_link, m.phone, m.linkedin, m.timezone, m.status, m.profile_completed, u.email
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
mentorApi.get('/me', wrap(async (req, res) => res.json(await mentorProfile(req.auth.mentor.id))));
mentorApi.post('/onboarding', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  const f = await profileFields(req.body || {}, { partial: false });
  for (const k of ['name', 'expertise', 'bio']) if (!f[k]) throw bad(`${k[0].toUpperCase() + k.slice(1)} is required.`);
  const slots = parseAvailability(req.body?.availability || []);
  if (!slots.length) throw bad('Please add at least one availability slot.');
  await db.tx(async (t) => {
    const keys = Object.keys(f);
    await t.run(`update anvaya.mentors set ${setClause(keys)}, profile_completed = true,
      status = case when status = 'deactivated' then status else 'active' end, updated_at = now() where id = $${keys.length + 1}`,
    [...keys.map((k) => f[k]), mid]);
    await saveAvailability(t, mid, slots);
  });
  db.audit(req.auth.user.id, 'mentor_onboarded', `mentor:${mid}`);
  res.json({ ok: true, next: '/mentor' });
}));

// Everything else needs an active mentor.
mentorApi.use(sec.requireActiveMentor);

mentorApi.patch('/me', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  const f = await profileFields(req.body || {}, { partial: true }); // session_price, email and status are admin-controlled
  const keys = Object.keys(f);
  if (keys.length) await db.run(`update anvaya.mentors set ${setClause(keys)}, updated_at = now() where id = $${keys.length + 1}`, [...keys.map((k) => f[k]), mid]);
  db.audit(req.auth.user.id, 'mentor_profile_updated', `mentor:${mid}`);
  res.json(await mentorProfile(mid));
}));
mentorApi.put('/availability', wrap(async (req, res) => {
  const slots = parseAvailability(req.body?.availability);
  await db.tx((t) => saveAvailability(t, req.auth.mentor.id, slots));
  res.json((await mentorProfile(req.auth.mentor.id)).availability);
}));

// $1 is always the signed-in mentor's id.
const OWN_STUDENTS = '(s.mentor_id = $1 or s.id in (select student_id from anvaya.bookings where mentor_id = $1))';
const studentPublicCols = 's.id, s.name, s.email, s.phone, s.stage, s.goals, s.plan, s.status'; // admin notes are never exposed

mentorApi.get('/overview', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  const n = async (sql) => (await db.one(sql, [mid])).n;
  res.json({
    upcoming: await db.all(`select b.id, b.scheduled_at, b.duration, b.service, b.meeting_link, s.name as student_name
      from anvaya.bookings b join anvaya.students s on s.id = b.student_id
      where b.mentor_id = $1 and b.status = 'scheduled' and b.scheduled_at >= now() order by b.scheduled_at limit 6`, [mid]),
    stats: {
      students: await n(`select count(*) n from anvaya.students s where ${OWN_STUDENTS}`),
      upcoming: await n("select count(*) n from anvaya.bookings where mentor_id = $1 and status = 'scheduled' and scheduled_at >= now()"),
      completed: await n("select count(*) n from anvaya.bookings where mentor_id = $1 and status = 'completed'"),
      earned: await n("select coalesce(sum(mentor_fee),0) n from anvaya.bookings where mentor_id = $1 and status = 'completed'"),
      projected: await n("select coalesce(sum(mentor_fee),0) n from anvaya.bookings where mentor_id = $1 and status = 'scheduled'"),
    },
  });
}));

mentorApi.get('/bookings', wrap(async (req, res) => {
  res.json(await db.all(`select b.id, b.student_id, b.service, b.scheduled_at, b.duration, b.status, b.mentor_fee, b.meeting_link,
    b.session_notes, b.completed_at, s.name as student_name
    from anvaya.bookings b join anvaya.students s on s.id = b.student_id where b.mentor_id = $1 order by b.scheduled_at desc`, [req.auth.mentor.id]));
}));

/** Loads a booking only if it belongs to the signed-in mentor; otherwise 404 (no existence leak). */
async function ownBooking(req) {
  const b = await db.one('select * from anvaya.bookings where id = $1 and mentor_id = $2', [id(req), req.auth.mentor.id]);
  if (!b) throw new HttpError(404, 'Booking not found.');
  return b;
}
mentorApi.patch('/bookings/:id', wrap(async (req, res) => {
  const b = await ownBooking(req);
  const notes = v.str(req.body?.session_notes, { max: 10000, label: 'Session notes' });
  await db.run('update anvaya.bookings set session_notes = $1 where id = $2 and mentor_id = $3', [notes, b.id, req.auth.mentor.id]);
  db.audit(req.auth.user.id, 'session_notes_saved', `booking:${b.id}`);
  res.json({ ok: true });
}));
mentorApi.post('/bookings/:id/complete', wrap(async (req, res) => {
  const b = await ownBooking(req);
  if (b.status !== 'scheduled') throw bad(`This session is already ${b.status.replace('_', ' ')}.`);
  const notes = req.body?.session_notes !== undefined ? v.str(req.body.session_notes, { max: 10000, label: 'Session notes' }) : b.session_notes;
  await db.run("update anvaya.bookings set status = 'completed', completed_at = now(), session_notes = $1 where id = $2 and mentor_id = $3 and status = 'scheduled'",
    [notes, b.id, req.auth.mentor.id]);
  db.audit(req.auth.user.id, 'session_completed', `booking:${b.id}`);
  res.json({ ok: true });
}));

mentorApi.get('/students', wrap(async (req, res) => {
  res.json(await db.all(`select ${studentPublicCols},
    (select count(*) from anvaya.bookings b where b.student_id = s.id and b.mentor_id = $1) as sessions,
    (select min(scheduled_at) from anvaya.bookings b where b.student_id = s.id and b.mentor_id = $1 and b.status = 'scheduled' and b.scheduled_at >= now()) as next_session
    from anvaya.students s where ${OWN_STUDENTS} order by s.name`, [req.auth.mentor.id]));
}));
mentorApi.get('/students/:id', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  const s = await db.one(`select ${studentPublicCols} from anvaya.students s where s.id = $2 and ${OWN_STUDENTS}`, [mid, id(req)]);
  if (!s) throw new HttpError(404, 'Student not found.');
  s.bookings = await db.all(`select id, service, scheduled_at, status, session_notes from anvaya.bookings
    where student_id = $1 and mentor_id = $2 order by scheduled_at desc`, [s.id, mid]);
  res.json(s);
}));

mentorApi.get('/earnings', wrap(async (req, res) => {
  const mid = req.auth.mentor.id;
  res.json({
    byMonth: await db.all(`select to_char(month, 'YYYY-MM') as month, sessions, amount from anvaya.mentor_earnings
      where mentor_id = $1 order by month desc`, [mid]),
    items: await db.all(`select b.id, b.service, b.completed_at, b.mentor_fee, s.name as student_name from anvaya.bookings b
      join anvaya.students s on s.id = b.student_id where b.mentor_id = $1 and b.status = 'completed' order by b.completed_at desc`, [mid]),
  });
}));

app.use('/api/mentor', mentorApi);

// ── Local dev only: static files + public page (Vercel serves public/ directly) ─
if (!process.env.VERCEL) {
  app.use('/app', express.static(path.join(PUBLIC, 'app'), { index: false }));
  app.use('/assets', express.static(path.join(PUBLIC, 'assets')));
  app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
}

// ── Errors ────────────────────────────────────────────────────────────
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  const msg = status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message;
  if (req.path.startsWith('/api')) return res.status(status).json({ error: msg });
  res.status(status).type('text').send(msg);
});

module.exports = app;
