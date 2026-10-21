'use strict';
// Express app shared by the standalone server (src/server.js: local dev, Hostinger) and Vercel (api/index.js).
const path = require('node:path');
const express = require('express');
const db = require('./db');
const sec = require('./security');
const jobs = require('./lib/jobs');
const storage = require('./lib/storage');
require('./lib/email');        // registers email.send
require('./lib/payments');     // registers payments.* jobs
require('./lib/maintenance');  // registers scheduled jobs

const IS_PROD = process.env.NODE_ENV === 'production';
if (IS_PROD && !process.env.APP_BASE_URL) throw new Error('APP_BASE_URL must be set in production (used to build links in emails).');
if (IS_PROD && !process.env.APP_SECRET) throw new Error('APP_SECRET must be set in production (encrypts queued email links).');

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
    await db.run("insert into anvaya.users (email, name, role, password_hash) values ($1, 'Admin', 'admin', $2) on conflict do nothing",
      [ADMIN_EMAIL.trim().toLowerCase(), sec.hashPassword(ADMIN_PASSWORD)]);
  })().catch((e) => { seeded = null; throw e; });
  return seeded;
}

const app = express();
app.disable('x-powered-by');
// Behind one reverse proxy in production (Vercel's edge, Hostinger's web server): trust exactly one hop for client IP + HTTPS.
app.set('trust proxy', process.env.TRUST_PROXY ? (Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY) : (process.env.VERCEL || IS_PROD ? 1 : false));
app.use(sec.parseCookies);

// Machine endpoints need the raw body (webhook signatures) and no session/CSRF.
app.use('/api', require('./routes/system'));

app.use(express.json({ limit: '200kb' }));
app.use(async (_req, _res, next) => { try { await seedAdmin(); next(); } catch (e) { next(e); } });
app.use(sec.loadSession);

// ── Security headers ──────────────────────────────────────────────────
function csp(withPayments) {
  const store = storage.origin();
  const rzp = withPayments ? ' https://*.razorpay.com' : '';
  return [
    "default-src 'self'", `script-src 'self'${rzp}`, "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", `img-src 'self' data:${rzp}`, `connect-src 'self'${store ? ` ${store}` : ''}${rzp}`,
    `frame-src${rzp || " 'none'"}`, "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join('; ');
}
app.use(['/api', '/admin', '/mentor', '/student', '/invite', '/reset', '/login'], (req, res, next) => {
  res.set({
    'Content-Security-Policy': csp(req.baseUrl === '/student' || req.path.startsWith('/student')), 'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  });
  if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
const CSRF_EXEMPT = (p) => ['/auth/login', '/auth/forgot', '/public/leads'].includes(p) || p.startsWith('/invites/') || p.startsWith('/_storage/');
app.use('/api', (req, res, next) => (CSRF_EXEMPT(req.path) ? next() : sec.csrfProtect(req, res, next)));
// Drain the job queue in the background after API responses (Vercel keeps the function alive via waitUntil).
app.use('/api', (_req, res, next) => { res.on('finish', () => jobs.kick()); next(); });

// ══ Pages (server-side gatekeeping; the APIs enforce permissions again) ══
const page = (res, name, status = 200) => res.status(status).sendFile(path.join(VIEWS, name));
const STAFF = ['admin', 'ops'];

app.get(['/login', '/admin/login', '/mentor/login', '/student/login'], (req, res) => {
  if (req.auth) {
    const role = req.auth.user.role;
    if (STAFF.includes(role)) return res.redirect('/admin');
    if (role === 'mentor') return res.redirect('/mentor');
    if (role === 'student') return res.redirect('/student');
  }
  page(res, 'login.html');
});
app.get(['/admin', '/admin/*'], (req, res) => {
  if (!req.auth) return res.redirect('/admin/login');
  if (!STAFF.includes(req.auth.user.role)) return page(res, 'forbidden.html', 403);
  page(res, 'admin.html');
});
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
app.get(['/student', '/student/*'], (req, res) => {
  if (!req.auth) return res.redirect('/student/login');
  if (req.auth.user.role !== 'student') return page(res, 'forbidden.html', 403);
  page(res, 'student.html');
});
app.get(['/invite', '/reset'], (_req, res) => page(res, 'invite.html'));

// ══ APIs ═══════════════════════════════════════════════════════════════
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/google'));
app.use('/api', require('./routes/public'));
app.use('/api', require('./routes/files'));
app.use('/api', require('./routes/cases'));
const admin = express.Router();
for (const m of ['core', 'crm', 'mentors', 'commerce', 'learning', 'services', 'workspace']) admin.use(require(`./routes/admin/${m}`));
app.use('/api/admin', admin);
app.use('/api/mentor', require('./routes/mentor'));
app.use('/api/student', require('./routes/student'));
storage.memoryRoutes(app, express);

// ── Standalone server only: public/ files (on Vercel the CDN serves public/ and vercel.json does the same) ─
if (!process.env.VERCEL) {
  // Split setup: the brochure and payment page live on the main site (PUBLIC_SITE_URL); this host only runs the app.
  const SITE = (process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
  if (SITE) app.get(['/', '/index.html', '/anvaya-payment.html'], (req, res) => res.redirect(302, SITE + req.originalUrl.replace(/^\/index\.html/, '/')));
  app.get('/anvaya-payment.html', (req, res, next) => (req.query.plan === '500' ? res.redirect(302, '/anvaya-payment.html?plan=500mba') : next()));
  app.use('/app', (_req, res, next) => { res.set({ 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' }); next(); });
  app.use(express.static(PUBLIC, { index: 'index.html', dotfiles: 'ignore', redirect: false }));
}

// ── Errors ────────────────────────────────────────────────────────────
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  const msg = status >= 500 && status !== 502 && status !== 503 ? 'Something went wrong on our side. Please try again.' : err.message;
  if (req.path.startsWith('/api')) return res.status(status).json({ error: msg, ...(err.extra || {}) });
  res.status(status).type('text').send(msg);
});

module.exports = app;
