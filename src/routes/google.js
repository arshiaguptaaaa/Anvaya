'use strict';
// "Continue with Google" for EXISTING, already-activated accounts only (admin, ops, mentor, student, coordinator).
// Google proves the email; the account, its role and every access rule still come from Anvaya's own database,
// exactly as with a password sign-in. Nobody can create an account, skip an invitation or change a role this way.
// OpenID Connect authorization-code flow with PKCE, state and nonce; the ID token's signature is checked
// against Google's published keys. Hidden unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const sec = require('../security');
const accounts = require('../lib/accounts');
const { wrap } = require('../lib/http');

const r = express.Router();
const IS_PROD = process.env.NODE_ENV === 'production';
const STATE_COOKIE = IS_PROD ? '__Host-anvaya_oauth' : 'anvaya_oauth';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
// Endpoints are overridable only so the automated tests can stand in for Google.
const AUTH_URL = () => process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const JWKS_URL = () => process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const baseUrl = () => (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const redirectUri = () => `${baseUrl()}/api/auth/google/callback`;
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const AREAS = { admin: '/admin/login', mentor: '/mentor/login', student: '/student/login' };

const startLimiter = sec.rateLimiter({ name: 'google-start', windowMs: 15 * 60e3, max: 30, key: (req) => req.ip });
const callbackLimiter = sec.rateLimiter({ name: 'google-cb', windowMs: 15 * 60e3, max: 30, key: (req) => req.ip });

r.get('/auth/providers', (_req, res) => res.json({ google: configured() }));

r.get('/auth/google/start', startLimiter, (req, res) => {
  const area = AREAS[req.query.area] ? req.query.area : 'student';
  if (!configured()) return res.redirect(303, `${AREAS[area]}?error=google_unavailable`);
  const state = sec.randomToken(24), nonce = sec.randomToken(24), verifier = sec.randomToken(48);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  // Lax (not Strict): the browser must send it back on Google's top-level redirect to our callback.
  res.cookie(STATE_COOKIE, JSON.stringify({ state, nonce, verifier, area }),
    { httpOnly: true, secure: IS_PROD, sameSite: 'lax', path: '/', maxAge: 10 * 60e3 });
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope: 'openid email',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
  res.redirect(303, `${AUTH_URL()}?${q}`);
});

let jwksCache = { at: 0, keys: [] };
async function googleKey(kid) {
  if (Date.now() - jwksCache.at > 3600e3 || !jwksCache.keys.some((k) => k.kid === kid)) {
    const resp = await fetch(JWKS_URL(), { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`Google keys HTTP ${resp.status}`);
    jwksCache = { at: Date.now(), keys: (await resp.json()).keys || [] };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error('Unknown Google signing key');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/** Verifies an ID token (RS256) and returns its claims, or throws. */
async function verifyIdToken(idToken, nonce) {
  const [h, p, s] = String(idToken || '').split('.');
  if (!h || !p || !s) throw new Error('Malformed ID token');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), await googleKey(header.kid), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('Bad token signature');
  const c = JSON.parse(Buffer.from(p, 'base64url'));
  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.includes(c.iss)) throw new Error('Wrong issuer');
  if (c.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error('Wrong audience');
  if (!(c.exp > now - 60) || !(c.iat < now + 300)) throw new Error('Token expired');
  if (!c.nonce || c.nonce !== nonce) throw new Error('Nonce mismatch');
  return c;
}

const back = (res, area, code) => res.redirect(303, `${AREAS[area] || AREAS.student}?error=${code}`);

r.get('/auth/google/callback', callbackLimiter, wrap(async (req, res) => {
  let saved = null;
  try { saved = JSON.parse(req.cookies[STATE_COOKIE] || 'null'); } catch { /* ignore */ }
  res.clearCookie(STATE_COOKIE, { path: '/', secure: IS_PROD, sameSite: 'lax', httpOnly: true });
  const area = saved?.area;
  if (!configured()) return back(res, area, 'google_unavailable');
  if (req.query.error) return back(res, area, 'google_cancelled');
  const st = String(req.query.state || '');
  if (!saved || !saved.state || st.length !== saved.state.length || !crypto.timingSafeEqual(Buffer.from(st), Buffer.from(saved.state))) {
    return back(res, area, 'google_expired');
  }
  let claims;
  try {
    const tok = await fetch(TOKEN_URL(), {
      method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(req.query.code || ''), client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(), grant_type: 'authorization_code', code_verifier: saved.verifier }),
    });
    const body = await tok.json().catch(() => ({}));
    if (!tok.ok || !body.id_token) throw new Error(`token exchange failed (${tok.status})`);
    claims = await verifyIdToken(body.id_token, saved.nonce);
  } catch (e) {
    console.error('[google] sign-in failed:', e.message);
    return back(res, area, 'google_failed');
  }
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || claims.email_verified !== true) return back(res, area, 'google_unverified');
  const user = await db.one('select * from anvaya.users where lower(email) = $1', [email]);
  // Existing, activated accounts only: an invited account must accept its invitation first.
  if (!user || !user.password_hash) { db.audit(user?.id || null, 'login_google_refused', email); return back(res, area, 'google_no_account'); }
  if (user.disabled_at) return back(res, area, 'disabled');
  if (user.role === 'mentor') {
    const m = await db.one('select status from anvaya.mentors where user_id = $1', [user.id]);
    if (!m || m.status === 'deactivated') return back(res, area, 'disabled');
  }
  await sec.createSession(res, user.id);
  db.audit(user.id, 'login_google');
  // The session cookie is SameSite=Strict, so it isn't sent on a redirect that started at Google. A same-site
  // navigation from this page (meta refresh) carries it. No inline script, so the strict CSP still holds.
  const next = await accounts.landing(user.id);
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${next}"><title>Signing in…</title><p style="font-family:sans-serif">Signing you in… <a href="${next}">Continue</a></p>`);
}));

module.exports = r;
module.exports.verifyIdToken = verifyIdToken;
