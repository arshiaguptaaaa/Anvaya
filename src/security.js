'use strict';
const crypto = require('node:crypto');
const db = require('./db');

const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);
const COOKIE_NAME = process.env.NODE_ENV === 'production' ? '__Host-anvaya_sid' : 'anvaya_sid';
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Passwords: scrypt with per-password salt ──────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [algo, N, r, p, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, actual);
}
// Used to burn equivalent time when the email is unknown (prevents user enumeration by timing).
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must include at least one letter and one number.';
  return null;
}

// ── Tokens ────────────────────────────────────────────────────────────
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── Sessions (opaque token in HttpOnly cookie; only its hash is stored) ─
async function createSession(res, userId) {
  const token = randomToken();
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600e3);
  await db.run('insert into anvaya.sessions (token_hash, user_id, csrf_token, expires_at) values ($1,$2,$3,$4)', [sha256(token), userId, csrf, expires]);
  await db.run('update anvaya.users set last_login_at = now() where id = $1', [userId]);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'strict', secure: IS_PROD, path: '/', expires });
  return csrf;
}

async function destroySession(req, res) {
  const token = req.cookies[COOKIE_NAME];
  if (token) await db.run('delete from anvaya.sessions where token_hash = $1', [sha256(token)]);
  res.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'strict', secure: IS_PROD });
}

/** q may be a transaction handle so this can run inside db.tx(). */
const revokeAllSessions = (userId, q = db) => q.run('delete from anvaya.sessions where user_id = $1', [userId]);

function parseCookies(req, _res, next) {
  req.cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed cookie */ } }
  }
  next();
}

/** Resolves req.auth = { user, mentor, csrf } from the session cookie, or null. */
async function loadSession(req, _res, next) {
  try {
    req.auth = null;
    const token = req.cookies[COOKIE_NAME];
    if (token && token.length < 100) {
      const row = await db.one(`select s.id as sid, s.csrf_token, s.expires_at, u.id, u.email, u.role, u.name, u.disabled_at
        from anvaya.sessions s join anvaya.users u on u.id = s.user_id where s.token_hash = $1`, [sha256(token)]);
      if (row && new Date(row.expires_at) > new Date() && !row.disabled_at) {
        const mentor = row.role === 'mentor' ? await db.one('select * from anvaya.mentors where user_id = $1', [row.id]) : null;
        const student = row.role === 'student' ? await db.one('select * from anvaya.students where user_id = $1', [row.id]) : null;
        // A deactivated mentor's session is dead even if the cookie lingers.
        if (!(mentor && mentor.status === 'deactivated') && !(row.role === 'student' && !student)) {
          req.auth = { user: { id: row.id, email: row.email, role: row.role, name: row.name }, mentor, student, csrf: row.csrf_token };
        }
      } else if (row) {
        await db.run('delete from anvaya.sessions where id = $1', [row.sid]);
      }
    }
    next();
  } catch (e) { next(e); }
}

// ── Guards (backend is the source of truth for permissions) ───────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Please sign in.' });
    if (!roles.includes(req.auth.user.role)) return res.status(403).json({ error: 'You do not have access to this area.' });
    next();
  };
}

/** Mentor must have finished onboarding (status active) to use the dashboard APIs. */
function requireActiveMentor(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Please sign in.' });
  if (req.auth.user.role !== 'mentor' || !req.auth.mentor) return res.status(403).json({ error: 'You do not have access to this area.' });
  if (req.auth.mentor.status !== 'active') return res.status(403).json({ error: 'Please complete your profile first.', onboarding: true });
  next();
}

/** CSRF: state-changing requests must echo the session's CSRF token in a header. */
function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.auth) return next(); // unauthenticated endpoints (login, invite accept) carry their own secret
  const sent = req.get('x-csrf-token') || '';
  const ok = sent.length === req.auth.csrf.length &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.auth.csrf));
  if (!ok) return res.status(403).json({ error: 'Security check failed. Refresh the page and try again.' });
  next();
}

// ── Rate limiting stored in Postgres, so it holds across serverless instances ─
function rateLimiter({ windowMs, max, key, name }) {
  return async (req, res, next) => {
    try {
      const k = `${name}:${sha256(key(req))}`;
      const row = await db.one(`insert into anvaya.rate_limits (key, window_start, count) values ($1, now(), 1)
        on conflict (key) do update set
          count = case when anvaya.rate_limits.window_start < now() - ($2 || ' milliseconds')::interval then 1 else anvaya.rate_limits.count + 1 end,
          window_start = case when anvaya.rate_limits.window_start < now() - ($2 || ' milliseconds')::interval then now() else anvaya.rate_limits.window_start end
        returning count, window_start`, [k, String(windowMs)]);
      if (row.count > max) {
        const retry = Math.max(1, Math.ceil((new Date(row.window_start).getTime() + windowMs - Date.now()) / 1000));
        res.set('Retry-After', String(retry));
        return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
      }
      next();
    } catch (e) { next(e); }
  };
}

module.exports = {
  hashPassword, verifyPassword, DUMMY_HASH, passwordProblem,
  randomToken, sha256,
  createSession, destroySession, revokeAllSessions, parseCookies, loadSession,
  requireRole, requireActiveMentor, csrfProtect, rateLimiter, COOKIE_NAME,
};
