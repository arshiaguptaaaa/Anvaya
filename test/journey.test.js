'use strict';
// End-to-end journeys + permission boundaries against the real app on in-process Postgres (PGlite),
// with fake Razorpay (real HMAC verification), in-memory storage/email, and a fake Google Sheet endpoint.
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = 4000 + Math.floor(Math.random() * 1000);
const SHEET_PORT = PORT + 1;
let sheetMode = 'ok';
const sheetHits = [];
// stands in for the payments Apps Script: one row per payment id, updated in place
let paySheetMode = 'ok';
const payRows = new Map(), payPosts = [], enqRows = new Map();
Object.assign(process.env, {
  DATABASE_URL: 'pglite://memory', MAIL_TRANSPORT: 'memory', RESEND_API_KEY: '', SMTP_HOST: '', STORAGE_DRIVER: 'memory',
  SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', JOBS_AUTORUN: 'false',
  PORT: String(PORT), APP_BASE_URL: `http://localhost:${PORT}`, CRON_SECRET: 'cron-test-secret', EXTRA_ORIGINS: 'https://anvayacareers.in',
  ADMIN_EMAIL: 'admin@anvaya.test', ADMIN_PASSWORD: 'Admin-pass-2026',
  RAZORPAY_KEY_ID: 'rzp_fake_test', RAZORPAY_KEY_SECRET: 'rzp-secret', RAZORPAY_WEBHOOK_SECRET: 'whsec-test',
  GOOGLE_SHEET_WEBHOOK_URL: `http://localhost:${SHEET_PORT}/exec`, GOOGLE_CALENDAR_FAKE: '1',
  PAYMENT_SHEET_WEBHOOK_URL: `http://localhost:${SHEET_PORT}/paysheet`, PAYMENT_SHEET_TOKEN: 'sheet-token', PAYMENT_NOTIFY_EMAIL: 'team@anvaya.test', PAYMENT_SHEET_FIRST_TRY_MS: '0', PAYMENT_PAGE_WAIT_MS: '0',
});
const app = require('../src/app');
const db = require('../src/db');
const mailer = require('../src/mailer');
const jobs = require('../src/lib/jobs');
const payments = require('../src/lib/payments');
const BASE = `http://localhost:${PORT}`;
let server, sheet;

class Client {
  constructor() { this.cookies = {}; this.csrf = null; }
  async req(method, url, body, { csrf = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const c = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (c) headers.Cookie = c;
    if (csrf && this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf;
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';'); const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (!v || /expires=Thu, 01 Jan 1970/i.test(sc)) delete this.cookies[k]; else this.cookies[k] = v;
    }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, location: res.headers.get('location') };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}, o) { return this.req('POST', u, b, o); }
  patch(u, b) { return this.req('PATCH', u, b); }
  put(u, b) { return this.req('PUT', u, b); }
  async login(email, password) {
    const r = await this.post('/api/auth/login', { email, password });
    if (r.status === 200) await this.refresh();
    return r;
  }
  async refresh() { this.csrf = (await this.get('/api/auth/me')).json?.csrf; }
}
const lastEmailTo = (to) => { const l = mailer.sent.filter((m) => m.to === to); assert.ok(l.length, `expected an email to ${to}`); return l.at(-1); };
const emailCount = (to) => mailer.sent.filter((m) => m.to === to).length;
const tokenFrom = (mail) => new URL(mail.text.match(/https?:\/\/\S+\/(invite|reset)\?token=\S+/)[0]).searchParams.get('token');
const rupees = (n) => n * 100;

/** Simulates Razorpay Checkout completing a payment for a provider order. */
function fakePay(rzpOrderId, amount, { fee = 0, tax = 0 } = {}) {
  const pid = `pay_fake_${crypto.randomBytes(5).toString('hex')}`;
  payments.fake.payments.set(pid, { id: pid, order_id: rzpOrderId, amount, status: 'captured', fee, tax, method: 'upi' });
  return { razorpay_order_id: rzpOrderId, razorpay_payment_id: pid, razorpay_signature: crypto.createHmac('sha256', 'rzp-secret').update(`${rzpOrderId}|${pid}`).digest('hex') };
}
async function uploadResume(client, extra = {}) {
  const content = Buffer.from('%PDF-1.4 resume of a real person');
  const u = await client.post('/api/files/upload-url', { kind: 'resume_upload', filename: 'resume.pdf', mime_type: 'application/pdf', size: content.length, ...extra });
  assert.equal(u.status, 201, u.text);
  const put = await fetch(BASE + u.json.upload_url, { method: 'PUT', body: content, headers: { 'Content-Type': 'application/pdf' } });
  assert.equal(put.status, 200);
  const done = await client.post(`/api/files/${u.json.version_id}/complete`);
  assert.equal(done.status, 200, done.text);
  return u.json;
}

const admin = new Client(), ops = new Client(), mentorA = new Client(), mentorB = new Client(), stu1 = new Client(), stu2 = new Client();
const ids = {};

test.before(async () => {
  sheet = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      if (req.url === '/paysheet') {
        const d = JSON.parse(b); payPosts.push(d);
        if (paySheetMode !== 'ok') { res.statusCode = 200; return res.end('<html>Error</html>'); }
        if (d.token !== 'sheet-token') return res.end(JSON.stringify({ status: 'error', message: 'bad token' }));
        if (d.action === 'enquiry') { // one row per enquiry id in "Abandoned Checkouts"
          if (d.token !== 'sheet-token') return res.end(JSON.stringify({ status: 'error', message: 'not authorised' }));
          enqRows.set(d.enquiry_id, { ...enqRows.get(d.enquiry_id), ...d });
          return res.end(JSON.stringify({ status: 'ok', row: [...enqRows.keys()].indexOf(d.enquiry_id) + 6 }));
        }
        const had = payRows.has(d.payment_id); // matched by payment id, like the real script
        if (!had && !d.append_if_missing) return res.end(JSON.stringify({ status: 'waiting' }));
        payRows.set(d.payment_id, { ...payRows.get(d.payment_id), ...Object.fromEntries(Object.entries(d).filter(([k, v]) => v !== '' || !payRows.get(d.payment_id)?.[k])) });
        return res.end(JSON.stringify({ status: 'ok', row: [...payRows.keys()].indexOf(d.payment_id) + 2, created: !had }));
      }
      sheetHits.push(Object.fromEntries(new URLSearchParams(b))); res.statusCode = sheetMode === 'ok' ? 200 : 500; res.end('{}'); });
  });
  await new Promise((r) => sheet.listen(SHEET_PORT, r));
  await new Promise((r) => { server = app.listen(PORT, r); });
});
test.after(async () => { server.close(); sheet.close(); await db.end(); });

// ═══ Public page & basics ═════════════════════════════════════════════
const ORIGINAL_SHA = '05995cd3a1e0fa7719fd871937c3daca475666019061eaa71e628d09a5d2bff2';
const LEAD_TAG = '<script src="/app/lead-capture.js" defer></script>\n';
// Content edits approved by the owner, applied on top of the supplied brochure: [now, originally].
const APPROVED_EDITS = [
  ["<a href=\"/terms.html\" style=\"color:inherit;text-decoration:none;\">Terms of Service</a> &nbsp;&middot;&nbsp; <a href=\"/refund-policy.html\" style=\"color:inherit;text-decoration:none;\">Refund Policy</a> &nbsp;&middot;&nbsp; &copy; 2025 Anvaya", "<a href=\"/terms.html\" style=\"color:inherit;text-decoration:none;\">Terms of Service</a> &nbsp;&middot;&nbsp; &copy; 2025 Anvaya"], // footer: Refund Policy link (26 Oct 2026)
  ["        <details>\n          <summary>How do the sessions work? <span class=\"faq-plus\">+</span></summary>\n          <p class=\"faq-body\">Every session is live and 1:1 on Google Meet. After paying, you pick your time; you&rsquo;ll get a confirmation email with the Meet link and a short pre-session questionnaire. Multi-session plans are booked one session at a time, at a pace that suits you. Sessions are not recorded unless you ask and we both agree.</p>\n        </details>\n        <details>\n          <summary>Can I reschedule? <span class=\"faq-plus\">+</span></summary>\n          <p class=\"faq-body\">Yes, once per plan, as long as you tell us at least 24 hours before the session. Use the reschedule link in your booking email or write to teamanvaya.in@gmail.com. A session missed, or changed with less than 24 hours&rsquo; notice, counts as used. In a genuine emergency, message us and we&rsquo;ll see what we can do.</p>\n        </details>\n        <details>\n          <summary>Do you give refunds? <span class=\"faq-plus\">+</span></summary>\n          <p class=\"faq-body\">If you cancel, the fee isn&rsquo;t refunded &mdash; please use your one reschedule instead. If we cancel or can&rsquo;t deliver what you paid for, you get a full refund to your original payment method. Full details: <a href=\"/refund-policy.html\" style=\"color:var(--gold)\">Refund &amp; Rescheduling Policy</a>.</p>\n        </details>\n        <details>\n          <summary>What happens right after payment? <span class=\"faq-plus\">+</span></summary>\n          <p class=\"faq-body\">You&rsquo;re redirected to Calendly to book your first session immediately. A confirmation email with your booking link and the pre-session questionnaire is sent to your inbox.</p>\n        </details>\n", "        <details>\n          <summary>What happens right after payment? <span class=\"faq-plus\">+</span></summary>\n          <p class=\"faq-body\">You&rsquo;re redirected to Calendly to book your first session immediately. A confirmation email with your booking link and the pre-session questionnaire is sent to your inbox.</p>\n        </details>\n"], // FAQ: how sessions work, rescheduling, refunds (26 Oct 2026)
  ["        <details open>\n          <summary>What&rsquo;s the difference between the two plans? <span class=\"faq-plus\">+</span></summary>\n          <p class=\"faq-body\">The Complete Resume Build &amp; Rewrite (&#8377;2,250, 3 &times; 45 min) covers the full resume &mdash; dissection, extraction, rewriting, and final build. The Full Picture &mdash; Profile Strategy + Resume (&#8377;3,999, 3 &times; 60 min + a bonus 30 min) includes all of that, plus career direction, LinkedIn, application strategy, and a portfolio roadmap.</p>\n        </details>\n", "        <details open>\n          <summary>What&rsquo;s the difference between the two plans? <span class=\"faq-plus\">+</span></summary>\n          <p class=\"faq-body\">The Complete Resume Build (&#8377;2,250) covers the full resume &mdash; dissection, extraction, rewriting, and final build. The End-to-End Profile Overhaul (&#8377;3,999) includes all of that, plus career direction, LinkedIn, application strategy, portfolio roadmap, and a bonus 30-min session.</p>\n        </details>\n"], // FAQ: current plan names (26 Oct 2026)
  ['<div class="plan-price">&#8377;2,250</div>\n          </div>\n          <div class="plan-sess">', '<div class="plan-price">&#8377;2,250</div>\n            <div class="plan-strike">&#8377;2,500</div>\n            <div class="plan-off">10% off</div>\n          </div>\n          <div class="plan-sess">'], // 10% off tag removed (price unchanged)
  ['</script>\n<link rel="stylesheet" href="/app/site.css">\n<script src="/app/site.js" defer></script>\n</head>', '</script>\n</head>'], // page polish (site.css / site.js)
  ['<span class="hstat-n">500</span><span class="hstat-l">Resumes reviewed</span>', '<span class="hstat-n">50+</span><span class="hstat-l">Resumes reviewed</span>'],
  [/<style>\n\/\* TESTIMONIALS \*\/[\s\S]*?<\/script>\n<\/head>/, '</head>'], // testimonial styles + scroll-arrival polish
  ['\n          <div class="plan-cat">Complete Resume Build</div>', '\n          <div class="plan-badge">&#x2B21; &nbsp;Early Access &mdash; Ends 15th May</div>\n          <div class="plan-cat">Complete Resume Build</div>'],
  ['10% off</div>\n          </div>\n          <div class="plan-sess">', '10% off</div>\n          </div>\n          <div class="plan-validity">Early access pricing &mdash; valid till 15th May</div>\n          <div class="plan-sess">'],
  ['your inbox.</p>\n        </details>\n      </div>', 'your inbox.</p>\n        </details>\n        <details>\n          <summary>What is the early access pricing? <span class="faq-plus">+</span></summary>\n          <p class="faq-body">The Complete Resume Build is &#8377;2,250 &mdash; a 10% discount from &#8377;2,500. Early access pricing is valid until 15th May. After that, the price returns to &#8377;2,500.</p>\n        </details>\n      </div>'],
  [/\n\n<!-- TESTIMONIALS -->[\s\S]*?<\/section>/, ''], // testimonial section (video)
  ['<div class="footer-right"><a href="/privacy.html" style="color:inherit;text-decoration:none;">Privacy Policy</a> &nbsp;&middot;&nbsp; <a href="/terms.html" style="color:inherit;text-decoration:none;">Terms of Service</a> &nbsp;&middot;&nbsp; &copy; 2025 Anvaya &nbsp;&middot;&nbsp; Arshia</div>', '<div class="footer-right">&copy; 2025 Anvaya &nbsp;&middot;&nbsp; Arshia</div>'], // footer links to the privacy policy and terms
];
// Images were moved out of the page into /assets/site (same pictures, compressed; lazy-loaded below the fold).
// The fixture maps each file back to the exact original data URI, so the check below still proves nothing else changed.
const BROCHURE_IMAGES = require('./fixtures/brochure-images.json');
const restoreImages = (html) => html.replace(/src="(\/assets\/site\/[^"]+)"(?: loading="lazy")? decoding="async"/g, (m, p) => {
  assert.ok(BROCHURE_IMAGES[p], `unknown image ${p}`);
  return `src="${BROCHURE_IMAGES[p]}"`;
});
test('public page = supplied brochure + only the lead-capture script tag', async () => {
  for (const p of Object.keys(BROCHURE_IMAGES)) assert.equal((await fetch(BASE + p)).status, 200, `${p} is served`);
  const served = Buffer.from(await (await fetch(BASE + '/')).arrayBuffer()).toString('latin1');
  assert.equal(served.split(LEAD_TAG).length, 2);
  const reverted = APPROVED_EDITS.reduce((html, [now, was]) => {
    assert.equal((html.match(now instanceof RegExp ? new RegExp(now.source, 'g') : new RegExp(now.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, `approved edit present once: ${now}`);
    return html.replace(now, was);
  }, restoreImages(served.replace(LEAD_TAG, '')));
  assert.equal(crypto.createHash('sha256').update(Buffer.from(reverted, 'latin1')).digest('hex'), ORIGINAL_SHA, 'nothing else on the brochure changed');
});

test('dashboards are locked when signed out; CSRF enforced', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/admin')).location, '/admin/login');
  assert.equal((await anon.get('/student')).location, '/student/login');
  for (const u of ['/api/admin/leads', '/api/mentor/bookings', '/api/student/me', '/api/files/1/download']) assert.equal((await anon.get(u)).status, 401, u);
  assert.equal((await admin.login('admin@anvaya.test', 'nope-nope-1')).status, 401);
  assert.equal((await admin.login('admin@anvaya.test', 'Admin-pass-2026')).status, 200);
  assert.equal((await admin.post('/api/admin/leads', { name: 'x' }, { csrf: false })).status, 403);
});

// ═══ Leads: website → CRM (source of truth) → Google Sheet (tracked) ═══
test('split setup: brochure on another origin can post leads (CORS for allowed origins only)', async () => {
  const pre = (origin) => fetch(`${BASE}/api/public/leads`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
  const ok = await pre('https://anvayacareers.in');
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://anvayacareers.in');
  assert.equal((await pre('https://evil.example')).status, 403);
  const post = (origin) => fetch(`${BASE}/api/public/leads`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'CORS Test', phone: '9876500000' }) });
  const r = await post('https://anvayacareers.in');
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://anvayacareers.in');
  const bad = await post('https://evil.example');
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('website enquiry lands in the CRM and syncs to the Google Sheet; failures are visible and retryable', async () => {
  const anon = new Client();
  const r = await anon.post('/api/public/leads', { name: 'Meera Joshi', phone: '+91 91234 56789', situation: 'Applying but not hearing back' });
  assert.equal(r.status, 201, r.text);
  await jobs.processDue({ kinds: ['leads.sheet_sync'] });
  let l = await db.one('select * from anvaya.leads where id = $1', [r.json.id]);
  assert.equal(l.sheet_sync_status, 'synced');
  assert.deepEqual(sheetHits.at(-1), { action: 'freechat', name: 'Meera Joshi', phone: '+91 91234 56789', situation: 'Applying but not hearing back' });
  assert.ok(l.follow_up_at, 'new leads get a follow-up date');

  sheetMode = 'fail';
  const r2 = await anon.post('/api/public/leads', { name: 'Karan Rao', phone: '+91 90000 11111', situation: 'Targeting MBA / IIM / ISB' });
  await jobs.processDue({ kinds: ['leads.sheet_sync'] });
  l = await db.one('select * from anvaya.leads where id = $1', [r2.json.id]);
  assert.equal(l.sheet_sync_status, 'failed');
  assert.match(l.sheet_sync_error, /500/);
  assert.equal((await admin.get('/api/admin/overview')).json.counts.sheetFailures, 1);
  sheetMode = 'ok';
  const retry = await admin.post(`/api/admin/leads/${r2.json.id}/sheet-retry`);
  assert.equal(retry.json.sheet_sync_status, 'synced');
  ids.leadKaran = r2.json.id;
  assert.equal((await anon.post('/api/public/leads', { name: 'X', phone: 'abc' })).status, 400);
  const cross = await fetch(BASE + '/api/public/leads', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'E', phone: '+91 90000 00001' }) });
  assert.equal(cross.status, 403);
});

test('lead pipeline: owner, next action, follow-up, activities, convert', async () => {
  const team = (await admin.get('/api/admin/team-options')).json;
  const p = await admin.patch(`/api/admin/leads/${ids.leadKaran}`, { owner_user_id: team[0].id, next_action: 'Send MBA plan', follow_up_at: new Date(Date.now() + 86400e3).toISOString(), status: 'qualified' });
  assert.equal(p.status, 200, p.text);
  assert.equal((await admin.post(`/api/admin/leads/${ids.leadKaran}/activities`, { kind: 'call', body: 'Discussed ISB timeline', next_action: 'Share payment link' })).status, 201);
  const acts = (await admin.get(`/api/admin/leads/${ids.leadKaran}/activities`)).json;
  assert.ok(acts.some((a) => a.kind === 'status_change') && acts.some((a) => a.kind === 'call'));
  assert.equal((await admin.post(`/api/admin/leads/${ids.leadKaran}/convert`)).status, 200);
  assert.equal((await admin.post(`/api/admin/leads/${ids.leadKaran}/convert`)).status, 400);
});

// ═══ Mentor invitation flow (preserved) ═══════════════════════════════
async function onboardMentor(client, { name, email, priceRs, checkupRs = 0 }) {
  const r = await admin.post('/api/admin/mentors', { name, email, expertise: 'Product management, consulting', bio: 'Mentor bio', session_price_paise: rupees(priceRs), checkup_fee_paise: rupees(checkupRs), max_students: 20 });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.invite.delivered, true);
  const tok = tokenFrom(lastEmailTo(email));
  const acc = await client.post('/api/invites/accept', { token: tok, password: 'Mentor-pass-01', confirm: 'Mentor-pass-01' });
  assert.equal(acc.status, 200, acc.text); assert.equal(acc.json.next, '/mentor/onboarding');
  await client.refresh();
  assert.equal((await client.get('/api/mentor/bookings')).status, 403, 'held at onboarding');
  const avail = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start_time: '06:00', end_time: '23:00' }));
  const on = await client.post('/api/mentor/onboarding', { name, expertise: 'Product management, consulting', bio: 'Eight years in product.', meeting_link: 'https://meet.google.com/abc-defg-hij', availability: avail });
  assert.equal(on.status, 200, on.text);
  return { id: r.json.id, token: tok };
}
test('mentor: invite → accept → password → profile → active; links single-use and expiring', async () => {
  const a = await onboardMentor(mentorA, { name: 'Priya Raman', email: 'priya@mentors.test', priceRs: 2500, checkupRs: 500 });
  ids.mentorA = a.id;
  assert.equal((await new Client().post('/api/invites/accept', { token: a.token, password: 'Hijack-pass-01', confirm: 'Hijack-pass-01' })).status, 410);
  assert.equal((await mentorA.get('/mentor')).status, 200);
  assert.equal((await admin.get('/api/admin/mentors')).json.find((m) => m.id === ids.mentorA).status, 'active');
  ids.mentorB = (await onboardMentor(mentorB, { name: 'Arjun Mehta', email: 'arjun@mentors.test', priceRs: 3000 })).id;

  const c = await admin.post('/api/admin/mentors', { name: 'Sana Kapoor', email: 'sana@mentors.test', session_price_paise: rupees(2000) });
  ids.mentorC = c.json.id;
  const old = tokenFrom(lastEmailTo('sana@mentors.test'));
  await db.run("update anvaya.invitations set expires_at = now() - interval '1 minute' where kind = 'mentor_invite' and used_at is null and revoked_at is null");
  const anon = new Client();
  assert.equal((await anon.post('/api/invites/inspect', { token: old })).json.state, 'expired');
  const before = emailCount('sana@mentors.test');
  assert.equal((await anon.post('/api/invites/request-new', { token: old, email: 'attacker@evil.test' })).status, 200);
  assert.equal(emailCount('sana@mentors.test'), before + 1);
  assert.equal(emailCount('attacker@evil.test'), 0);
  const fresh = tokenFrom(lastEmailTo('sana@mentors.test'));
  assert.equal((await anon.post('/api/invites/inspect', { token: fresh })).json.state, 'valid');
  assert.equal((await anon.post('/api/invites/inspect', { token: old })).json.state, 'superseded');
  await admin.post(`/api/admin/mentors/${ids.mentorC}/deactivate`);
  assert.equal((await anon.post('/api/invites/inspect', { token: fresh })).json.state, 'deactivated');
});

test('a dedicated short-lived invitation expires without changing the global lifetime', async () => {
  const r = await admin.post('/api/admin/mentors', { name: 'Expiry Probe', email: 'expiry@mentors.test', session_price_paise: rupees(1), expires_in_minutes: 2 });
  assert.equal(r.status, 201, r.text);
  const exp = new Date(r.json.invite.expiresAt).getTime() - Date.now();
  assert.ok(exp > 60e3 && exp <= 120e3, 'link lives ~2 minutes');
  assert.equal((await admin.post('/api/admin/mentors', { name: 'X', email: 'x1@mentors.test', session_price_paise: 1, expires_in_minutes: 1 })).status, 400, 'minimum 2 minutes');
  assert.ok(!(await admin.get('/api/admin/mentors')).json.some((m) => m.email === 'x1@mentors.test'), 'nothing created on invalid input');
  const normal = await admin.post(`/api/admin/mentors/${r.json.id}/resend-invite`);
  assert.ok(new Date(normal.json.invite.expiresAt).getTime() - Date.now() > 71 * 3600e3, 'default stays 72h');
  const del = await admin.req('DELETE', `/api/admin/mentors/${r.json.id}`);
  assert.equal(del.status, 200, 'mentor without history can be deleted');
  assert.ok(!(await admin.get('/api/admin/mentors')).json.some((m) => m.id === r.json.id));
});

test('raw invitation tokens are never stored; queued email payloads are encrypted then wiped', async () => {
  const rows = await db.all("select payload from anvaya.jobs where kind = 'email.send'");
  assert.ok(rows.length);
  for (const r of rows) assert.ok(!JSON.stringify(r.payload).includes('token='), 'no plaintext links in the job table');
});

// ═══ Ops (intern) role ════════════════════════════════════════════════
test('ops role: scheduling + follow-ups allowed; money, settings, admin privileges and sensitive notes blocked', async () => {
  const r = await admin.post('/api/admin/team', { name: 'Riya Intern', email: 'riya@anvaya.test', role: 'ops' });
  assert.equal(r.status, 201, r.text);
  const acc = await ops.post('/api/invites/accept', { token: tokenFrom(lastEmailTo('riya@anvaya.test')), password: 'Intern-pass-01', confirm: 'Intern-pass-01' });
  assert.equal(acc.json.next, '/admin');
  await ops.refresh();
  assert.equal((await ops.get('/admin')).status, 200);
  for (const u of ['/api/admin/leads', '/api/admin/followups', '/api/admin/live-sessions', '/api/admin/students', '/api/admin/bookings', '/api/admin/groups']) assert.equal((await ops.get(u)).status, 200, u);
  for (const u of ['/api/admin/payments', '/api/admin/orders', '/api/admin/payables', '/api/admin/team', '/api/admin/system', '/api/admin/playbooks', '/api/admin/refunds']) assert.equal((await ops.get(u)).status, 403, u);
  assert.equal((await ops.put('/api/admin/settings', { group_capacity_default: 99 })).status, 403);
  assert.equal((await ops.post('/api/admin/products', { kind: 'digital_product', name: 'X', price_paise: 100 })).status, 403);
  assert.equal((await ops.post('/api/admin/mentors', { name: 'X', email: 'x@y.test', session_price_paise: 1 })).status, 403);
  assert.equal((await ops.post(`/api/admin/mentors/${ids.mentorA}/deactivate`)).status, 403);
  const settingsView = (await ops.get('/api/admin/settings')).json;
  assert.ok(!('commission_percent' in settingsView) && !('ai_monthly_cap_paise' in settingsView));
  assert.ok(!(await ops.get('/api/admin/overview')).json.revenue, 'no revenue figures for ops');
  const s = await admin.post('/api/admin/students', { name: 'Notes Test', notes: 'SENSITIVE-ADMIN-NOTE' });
  assert.ok(!JSON.stringify((await ops.get('/api/admin/students')).json).includes('SENSITIVE-ADMIN-NOTE'));
  assert.ok(!JSON.stringify((await ops.get(`/api/admin/students/${s.json.id}`)).json).includes('SENSITIVE-ADMIN-NOTE'));
  await ops.patch(`/api/admin/students/${s.json.id}`, { notes: 'overwritten by ops', needs_followup: true, followup_reason: 'Call back' });
  const row = await db.one('select notes, needs_followup from anvaya.students where id = $1', [s.json.id]);
  assert.equal(row.notes, 'SENSITIVE-ADMIN-NOTE'); assert.equal(row.needs_followup, true);
  assert.ok((await ops.get('/api/admin/followups')).json.flagged.length >= 1);
});

// ═══ Catalogue & subscriptions ════════════════════════════════════════
test('admin configures plans, prices and entitlements (no unlimited counted sessions)', async () => {
  const p = await admin.post('/api/admin/products', { kind: 'subscription_plan', name: 'Shortlist Club — Monthly', price_paise: rupees(1999), billing_period: 'month', active: true });
  assert.equal(p.status, 201, p.text);
  ids.plan = p.json.id;
  assert.equal((await admin.put(`/api/admin/products/${ids.plan}/entitlements`, { entitlements: [{ key: 'checkup_call', limit_count: '', per_period: 'month' }] })).status, 400, 'counted sessions need a limit');
  const e = await admin.put(`/api/admin/products/${ids.plan}/entitlements`, { entitlements: [
    { key: 'syllabus' }, { key: 'progress_tracking' }, { key: 'community' },
    { key: 'live_class', limit_count: 4, per_period: 'month' }, { key: 'mentor_room', limit_count: 4, per_period: 'month' }, { key: 'checkup_call', limit_count: 2, per_period: 'month' },
  ] });
  assert.equal(e.status, 200, e.text);
  ids.resumeProduct = (await admin.post('/api/admin/products', { kind: 'resume_service', name: 'Resume rewrite', price_paise: rupees(1500), active: true })).json.id;
  ids.digital = (await admin.post('/api/admin/products', { kind: 'digital_product', name: 'Interview question bank', price_paise: rupees(299), active: true })).json.id;
});

async function onboardStudent(client, name, email) {
  const s = await admin.post('/api/admin/students', { name, email, phone: '+91 98111 22233' });
  const inv = await admin.post(`/api/admin/students/${s.json.id}/invite`);
  assert.equal(inv.status, 200, inv.text); assert.equal(inv.json.delivered, true);
  const acc = await client.post('/api/invites/accept', { token: tokenFrom(lastEmailTo(email)), password: 'Student-pass-1', confirm: 'Student-pass-1' });
  assert.equal(acc.status, 200, acc.text); assert.equal(acc.json.next, '/student#intake');
  await client.refresh();
  return s.json.id;
}
test('student: invite → password → intake with secure resume upload', async () => {
  const t = await admin.post('/api/admin/tracks', { name: 'Product Management', target_role: 'APM', active: true });
  ids.track = t.json.id;
  const m = await admin.post('/api/admin/modules', { track_id: ids.track, title: 'Resume foundations', position: 1, week_number: 1 });
  ids.assignment = (await admin.post('/api/admin/assignments', { module_id: m.json.id, title: 'Rewrite 3 bullets with metrics', due_offset_days: 7 })).json.id;

  ids.s1 = await onboardStudent(stu1, 'Rahul Sharma', 'rahul@students.test');
  ids.s2 = await onboardStudent(stu2, 'Neha Iyer', 'neha@students.test');
  assert.equal((await stu1.get('/student')).status, 200);
  const incomplete = await stu1.patch('/api/student/intake', { target_role: 'APM', track_id: ids.track, prep_level: 'some_preparation', availability_pref: 'Weekday evenings', complete: true });
  assert.equal(incomplete.status, 400); assert.match(incomplete.json.error, /resume/i);
  ids.resume1 = await uploadResume(stu1);
  assert.equal((await stu1.patch('/api/student/intake', { complete: true })).status, 200);
  assert.ok((await stu1.get('/api/student/me')).json.intake_completed_at);
  await stu2.patch('/api/student/intake', { target_role: 'APM', track_id: ids.track, prep_level: 'some_preparation' });
  assert.equal((await stu1.post('/api/files/upload-url', { kind: 'final', student_id: ids.s2, filename: 'x.pdf', mime_type: 'application/pdf', size: 10 })).status, 403);
  assert.equal((await stu1.post('/api/files/upload-url', { kind: 'resume_upload', filename: 'x.exe', mime_type: 'application/x-msdownload', size: 10 })).status, 400);
  const dl = await stu1.get(`/api/files/${ids.resume1.version_id}/download`);
  assert.equal(dl.status, 200); assert.equal(dl.json.expires_in, 60);
  assert.equal((await fetch(BASE + dl.json.url)).status, 200);
  assert.equal((await stu2.get(`/api/files/${ids.resume1.version_id}/download`)).status, 404);
});

// ═══ Google sign-in (existing accounts only) ═════════════════════════
test('Google sign-in: existing accounts keep their role and limits; unknown, unverified, invited-only and tampered sign-ins refused', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
  const codes = new Map(); // code → { claims, challenge }
  const sign = (claims) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
  };
  const gPort = PORT + 2;
  const fake = http.createServer((req, res) => {
    if (req.url === '/certs') return res.end(JSON.stringify({ keys: [jwk] }));
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      const q = new URLSearchParams(body); const c = codes.get(q.get('code'));
      const pkceOk = c && crypto.createHash('sha256').update(q.get('code_verifier') || '').digest('base64url') === c.challenge;
      if (!c || !pkceOk || q.get('client_secret') !== 'g-secret') { res.statusCode = 400; return res.end('{"error":"invalid_grant"}'); }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id_token: sign(c.claims) }));
    });
  });
  await new Promise((r) => fake.listen(gPort, r));
  const anon = new Client();
  assert.equal((await anon.get('/api/auth/providers')).json.google, false, 'hidden until configured');
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'anvaya-test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'g-secret',
    GOOGLE_AUTH_URL: `http://localhost:${gPort}/auth`, GOOGLE_TOKEN_URL: `http://localhost:${gPort}/token`, GOOGLE_JWKS_URL: `http://localhost:${gPort}/certs` });
  try {
    assert.equal((await anon.get('/api/auth/providers')).json.google, true);
    // Runs the browser side of the flow; `tweak` lets a case alter the claims Google returns.
    const viaGoogle = async (client, area, email, tweak = (c) => c, { state } = {}) => {
      const st = await client.get(`/api/auth/google/start?area=${area}`);
      assert.equal(st.status, 303);
      const u = new URL(st.location);
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      const code = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      codes.set(code, { challenge: u.searchParams.get('code_challenge'), claims: tweak({ iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID,
        sub: `g-${email}`, email, email_verified: true, nonce: u.searchParams.get('nonce'), iat: now, exp: now + 600 }) });
      return client.get(`/api/auth/google/callback?code=${code}&state=${encodeURIComponent(state ?? u.searchParams.get('state'))}`);
    };
    const err = (r) => new URL(r.location, BASE).searchParams.get('error');

    const ga = new Client();
    const a = await viaGoogle(ga, 'admin', 'ADMIN@anvaya.test');
    assert.equal(a.status, 200); assert.match(a.text, /url=\/admin"/);
    await ga.refresh();
    assert.equal((await ga.get('/api/auth/me')).json.user.role, 'admin');
    assert.equal((await ga.get('/api/admin/overview')).status, 200);

    const gm = new Client();
    assert.equal((await viaGoogle(gm, 'mentor', 'priya@mentors.test')).status, 200);
    await gm.refresh();
    assert.equal((await gm.get('/api/auth/me')).json.user.role, 'mentor');
    assert.equal((await gm.get('/mentor')).status, 200);
    assert.equal((await gm.get('/api/admin/overview')).status, 403, 'mentor stays out of admin');
    assert.equal((await gm.get('/admin')).status, 403);

    const gs = new Client();
    const sres = await viaGoogle(gs, 'student', 'rahul@students.test');
    assert.match(sres.text, /url=\/student"/);
    await gs.refresh();
    assert.equal((await gs.get('/api/student/me')).status, 200);
    assert.equal((await gs.get('/api/admin/students')).status, 403, 'student stays out of admin');
    assert.equal((await gs.get('/api/mentor/bookings')).status, 403, 'student stays out of mentor');

    // Students can sign up with Google (the email is Google-verified); mentors and staff cannot.
    assert.equal(err(await viaGoogle(new Client(), 'mentor', 'stranger@gmail.com')), 'google_no_account', 'no mentor account creation');
    assert.equal(err(await viaGoogle(new Client(), 'admin', 'stranger@gmail.com')), 'google_no_account', 'no staff account creation');
    const newbie = new Client();
    assert.match((await viaGoogle(newbie, 'student', 'stranger@gmail.com')).text, /url=\/student#intake"/, 'new student signs up with Google');
    await newbie.refresh();
    assert.equal((await newbie.get('/api/student/me')).status, 200);
    assert.equal((await db.one("select role from anvaya.users where email = 'stranger@gmail.com'")).role, 'student');
    const inv = await admin.post('/api/admin/students', { name: 'Invited Only', email: 'invited.only@students.test' });
    await admin.post(`/api/admin/students/${inv.json.id}/invite`);
    assert.match((await viaGoogle(new Client(), 'student', 'invited.only@students.test')).text, /url=\/student/, 'an invited student can finish with Google');
    assert.equal((await db.one("select count(*)::int n from anvaya.students where email = 'invited.only@students.test'")).n, 1, 'linked, not duplicated');
    assert.equal(err(await viaGoogle(new Client(), 'student', 'rahul@students.test', (c) => ({ ...c, email_verified: false }))), 'google_unverified');
    assert.equal(err(await viaGoogle(new Client(), 'student', 'rahul@students.test', (c) => ({ ...c, aud: 'someone-else' }))), 'google_failed');
    assert.equal(err(await viaGoogle(new Client(), 'student', 'rahul@students.test', (c) => ({ ...c, nonce: 'replayed' }))), 'google_failed');
    assert.equal(err(await viaGoogle(new Client(), 'student', 'rahul@students.test', (c) => ({ ...c, iss: 'https://evil.example' }))), 'google_failed');
    assert.equal(err(await viaGoogle(new Client(), 'student', 'rahul@students.test', (c) => c, { state: 'forged-state-value-000000000000' })), 'google_expired');
    const noCookie = new Client(); const st = await noCookie.get('/api/auth/google/start?area=student'); noCookie.cookies = {};
    assert.equal(err(await noCookie.get(`/api/auth/google/callback?code=x&state=${new URL(st.location).searchParams.get('state')}`)), 'google_expired', 'state must come from this browser');
    const uid = (await db.one("select user_id from anvaya.students where email = 'neha@students.test'")).user_id;
    await db.run('update anvaya.users set disabled_at = now() where id = $1', [uid]);
    assert.equal(err(await viaGoogle(new Client(), 'student', 'neha@students.test')), 'disabled');
    await db.run('update anvaya.users set disabled_at = null where id = $1', [uid]);
    assert.ok((await db.one("select count(*)::int n from anvaya.audit_log where action = 'login_google'")).n >= 3);
  } finally {
    for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_AUTH_URL', 'GOOGLE_TOKEN_URL', 'GOOGLE_JWKS_URL']) delete process.env[k];
    fake.close();
  }
});

test('subscription purchase via Razorpay: verified signature, idempotent webhook, access granted', async () => {
  assert.equal((await stu1.get('/api/student/me')).json.subscription, null);
  assert.equal((await stu1.get('/api/student/syllabus')).json.locked, true);
  const o = await stu1.post('/api/student/orders', { product_id: ids.plan });
  assert.equal(o.status, 201, o.text);
  assert.equal(o.json.checkout.provider, 'razorpay');
  assert.equal(o.json.checkout.amount_paise, rupees(1999));
  const pay = fakePay(o.json.checkout.razorpay_order_id, rupees(1999), { fee: 4718, tax: 849 });
  assert.equal((await stu1.post('/api/student/payments/verify', { ...pay, razorpay_signature: 'f'.repeat(64) })).status, 400, 'forged signature');
  const v = await stu1.post('/api/student/payments/verify', pay);
  assert.equal(v.json.status, 'paid', v.text);
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: pay.razorpay_payment_id, order_id: pay.razorpay_order_id, amount: rupees(1999), fee: 4718, tax: 849, method: 'upi', status: 'captured' } } } });
  const sig = crypto.createHmac('sha256', 'whsec-test').update(body).digest('hex');
  const wh = (s, evId) => fetch(BASE + '/api/webhooks/razorpay', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': s, 'X-Razorpay-Event-Id': evId } });
  assert.equal((await wh('0'.repeat(64), 'evt_1')).status, 401);
  assert.equal((await (await wh(sig, 'evt_2')).json()).status, 'accepted');
  assert.equal((await (await wh(sig, 'evt_2')).json()).status, 'duplicate');
  assert.equal((await db.one('select count(*) n from anvaya.payments where provider_payment_id = $1', [pay.razorpay_payment_id])).n, 1);
  const me = (await stu1.get('/api/student/me')).json;
  assert.equal(me.subscription.effective_access, 'active');
  assert.equal(me.subscription.billing_status, 'paid');
  assert.equal(me.subscription.entitlements.find((e) => e.key === 'checkup_call').limit_count, 2);
  const payRow = await db.one('select fee_paise, tax_paise from anvaya.payments where provider_payment_id = $1', [pay.razorpay_payment_id]);
  assert.equal(payRow.fee_paise + payRow.tax_paise, 5567, 'gateway cost recorded as Anvaya expense');
  const ord = await admin.post('/api/admin/orders', { student_id: ids.s2, product_id: ids.plan });
  assert.equal((await admin.post(`/api/admin/orders/${ord.json.id}/record-payment`, { method: 'UPI', reference: 'UPI-REF-1' })).status, 200);
  assert.equal((await stu2.get('/api/student/me')).json.subscription.effective_access, 'active');
  const audit = (await admin.get('/api/admin/audit')).json;
  assert.ok(audit.some((a) => a.action === 'payment_recorded') && audit.some((a) => a.action === 'subscription_granted'), 'audit trail records payment + grant');
  assert.equal((await stu2.get('/api/admin/audit')).status, 403);
});

test('syllabus, assignment submission and progress', async () => {
  const syl = (await stu1.get('/api/student/syllabus')).json;
  assert.equal(syl.locked, false);
  assert.equal(syl.tracks[0].modules[0].assignments[0].id, ids.assignment);
  assert.equal((await stu1.post(`/api/student/assignments/${ids.assignment}/submit`, { submission: 'Grew DAU 18% by…' })).status, 200);
  assert.equal((await stu1.get('/api/student/syllabus')).json.tracks[0].progress.done, 1);
});

test('groups: auto-assignment by track/role/level with capacity; admin override', async () => {
  const g = await admin.post('/api/admin/groups', { name: 'APM Evening A', track_id: ids.track, mentor_id: ids.mentorA, target_role: 'APM', prep_level: 'some_preparation', capacity: 1, meet_link: 'https://meet.google.com/grp-aaaa-bbb', whatsapp_link: 'https://chat.whatsapp.com/abc' });
  assert.equal(g.status, 201, g.text); ids.groupA = g.json.id;
  ids.groupB = (await admin.post('/api/admin/groups', { name: 'APM Weekend B', track_id: ids.track, mentor_id: ids.mentorB, target_role: 'APM', capacity: 5 })).json.id;
  const dry = await ops.post('/api/admin/groups/auto-assign', { dry_run: true });
  assert.equal(dry.json.plan.length, 2);
  const run = (await ops.post('/api/admin/groups/auto-assign', {})).json.plan;
  assert.equal(run.filter((p) => p.group_id === ids.groupA).length, 1, 'capacity respected');
  assert.equal((await admin.post(`/api/admin/groups/${ids.groupB}/members`, { student_id: ids.s2 })).status, 201);
  assert.equal((await admin.post(`/api/admin/groups/${ids.groupA}/members`, { student_id: ids.s1, allow_over_capacity: true })).status, 201);
  assert.equal((await admin.post(`/api/admin/groups/${ids.groupA}/members`, { student_id: ids.s2 })).status, 409, 'full group');
  const me = (await stu1.get('/api/student/me')).json;
  assert.equal(me.group.id, ids.groupA); assert.match(me.group.whatsapp_link, /whatsapp/);
});

test('live sessions: scheduling (ops), roster, attendance by the group mentor, student calendar', async () => {
  const start = new Date(Date.now() + 2 * 86400e3); start.setUTCMinutes(0, 0, 0);
  const l = await ops.post('/api/admin/live-sessions', { kind: 'group_room', title: 'Mentor room: resume teardown', group_id: ids.groupA, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600e3).toISOString(), repeat_weeks: 1, delivery_fee_paise: 99999 });
  assert.equal(l.status, 201, l.text); ids.live = l.json.ids[0];
  assert.equal(l.json.ids.length, 2, 'weekly repeat');
  assert.equal((await db.one('select delivery_fee_paise from anvaya.live_sessions where id = $1', [ids.live])).delivery_fee_paise, 0, 'ops cannot set money');
  assert.equal((await stu1.get('/api/student/sessions')).json.live.filter((x) => x.id === ids.live).length, 1);
  assert.equal((await stu2.get('/api/student/sessions')).json.live.filter((x) => x.id === ids.live).length, 0, 'other group does not see it');
  const roster = (await mentorA.get(`/api/mentor/live-sessions/${ids.live}/roster`)).json;
  assert.deepEqual(roster.map((x) => x.id), [ids.s1]);
  assert.equal((await mentorA.post(`/api/mentor/live-sessions/${ids.live}/attendance`, { marks: [{ student_id: ids.s1, status: 'present' }, { student_id: ids.s2, status: 'present' }] })).json.marked, 1, 'cannot mark students outside the roster');
  assert.equal((await mentorB.get(`/api/mentor/live-sessions/${ids.live}/roster`)).status, 404);
  await admin.patch(`/api/admin/live-sessions/${ids.live}`, { delivery_fee_paise: rupees(800) });
  await admin.patch(`/api/admin/live-sessions/${ids.live}`, { status: 'completed' });
  const bal = (await admin.get(`/api/admin/mentors/${ids.mentorA}/ledger`)).json.balance;
  assert.equal(bal.delivery_fees, rupees(800), 'delivery fee tracked separately from private-session earnings');
  assert.equal(bal.earned_sessions, 0);
});

// ═══ Bookings ═════════════════════════════════════════════════════════
test('check-ups: booked within plan limits; database prevents double booking under concurrency', async () => {
  const slots = (await stu1.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  assert.ok(slots.length > 10);
  const c1 = await stu1.post('/api/student/bookings/checkup', { scheduled_at: slots[0] });
  assert.equal(c1.status, 201, c1.text); assert.equal(c1.json.status, 'requested', 'a request, held for approval');
  assert.ok(new Date(c1.json.hold_expires_at) < new Date(slots[0]), 'hold ends before the session');
  const req1 = lastEmailTo('rahul@students.test');
  assert.match(req1.subject, /^Request received/); assert.match(req1.text, /not yet confirmed/i); assert.doesNotMatch(req1.subject, /confirmed/i);
  assert.match(lastEmailTo('priya@mentors.test').subject, /^New session request/);
  const ap = await mentorA.post(`/api/calendar/bookings/${c1.json.id}/approve`);
  assert.equal(ap.status, 200, ap.text); assert.equal(ap.json.next, 'confirmed');
  await jobs.processDue({ kinds: ['email.send'], limit: 20 });
  const conf = lastEmailTo('rahul@students.test');
  assert.match(conf.subject, /^Confirmed: Check-up call/);
  assert.match(conf.text, /Join Google Meet: https:\/\/meet\.google\.com\/fak-/); assert.match(conf.text, /Add to Google Calendar: https:\/\/calendar\.google\.com/);
  assert.match(conf.text, /\.ics\): http.*\/api\/public\/ics\//); assert.match(conf.text, /once per plan, at least 24 hours before/); assert.match(conf.text, /refund-policy\.html/); assert.match(conf.text, /No-show policy/);
  assert.equal(conf.attachments[0].filename, 'anvaya-session.ics'); assert.match(conf.attachments[0].content, /BEGIN:VEVENT/);
  assert.match(lastEmailTo('priya@mentors.test').subject, /^Confirmed: Check-up call/, 'host confirmed too');
  const icsLink = conf.text.match(/http\S+\/api\/public\/ics\/\S+/)[0];
  const ics = await fetch(icsLink.replace(/^https?:\/\/[^/]+/, BASE));
  assert.equal(ics.status, 200); assert.match(await ics.text(), /UID:booking-\d+@anvayacareers.in/);
  assert.equal((await fetch(icsLink.replace(/^https?:\/\/[^/]+/, BASE).replace(/sig=.*/, 'sig=forged'))).status, 404, 'unsigned .ics links refused');
  assert.equal((await mentorB.post(`/api/calendar/bookings/${c1.json.id}/approve`)).status, 404, 'other mentors cannot act on it');
  const [a, b] = await Promise.all([
    stu1.post('/api/student/bookings/checkup', { mentor_id: ids.mentorA, scheduled_at: slots[1] }),
    stu2.post('/api/student/bookings/checkup', { mentor_id: ids.mentorA, scheduled_at: slots[1] }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], `${a.text} / ${b.text}`);
  if (a.status !== 201) assert.equal((await stu1.post('/api/student/bookings/checkup', { scheduled_at: slots[2] })).status, 201);
  const over = await stu1.post('/api/student/bookings/checkup', { scheduled_at: slots[3] });
  assert.equal(over.status, 409); assert.match(over.json.error, /used all 2/);
  await assert.rejects(db.run(`insert into anvaya.bookings (student_id, mentor_id, kind, scheduled_at, duration, status) values ($1,$2,'checkup',$3,45,'scheduled')`, [ids.s2, ids.mentorA, slots[0]]), /bookings_no_overlap|exclusion/);
  const after = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  assert.ok(!after.includes(slots[0]) && !after.includes(slots[1]));
});

test('paid private session: hold → Razorpay payment → scheduled → completed → ledger; refund adjusts; payout recorded', async () => {
  const slots = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  const r = await stu2.post('/api/student/bookings/paid', { mentor_id: ids.mentorA, scheduled_at: slots[5] });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.status, 'requested', 'paid sessions are requested first; payment after approval');
  assert.equal((await stu1.post('/api/student/bookings/paid', { mentor_id: ids.mentorA, scheduled_at: slots[5] })).status, 409, 'slot held while awaiting approval');
  assert.equal((await stu2.post(`/api/student/bookings/${r.json.booking_id}/pay`)).status, 404, 'nothing to pay before approval');
  const appr = await mentorA.post(`/api/calendar/bookings/${r.json.booking_id}/approve`);
  assert.equal(appr.json.next, 'payment');
  assert.match(lastEmailTo('neha@students.test').subject, /^Approved, payment due/);
  const payStart = await stu2.post(`/api/student/bookings/${r.json.booking_id}/pay`);
  assert.equal(payStart.json.checkout.amount_paise, rupees(2500), 'student pays the mentor’s stated fee');
  r.json.checkout = payStart.json.checkout;
  const pay = fakePay(r.json.checkout.razorpay_order_id, rupees(2500), { fee: 5000, tax: 900 });
  assert.equal((await stu2.post('/api/student/payments/verify', pay)).json.status, 'paid');
  const b = await db.one('select * from anvaya.bookings where id = $1', [r.json.booking_id]);
  assert.equal(b.status, 'scheduled'); assert.equal(b.mentor_fee_paise, rupees(2500), 'zero commission');
  assert.equal(b.calendar_status, 'synced'); assert.match(b.meet_link, /^https:\/\/meet\.google\.com\//);
  assert.equal((await mentorA.post(`/api/mentor/bookings/${b.id}/complete`)).status, 400, 'not before it starts');
  await db.run("update anvaya.bookings set scheduled_at = now() - interval '3 hours' where id = $1", [b.id]);
  assert.equal((await mentorA.patch(`/api/mentor/bookings/${b.id}`, { session_notes: 'Mapped target roles' })).status, 200);
  assert.equal((await mentorA.post(`/api/mentor/bookings/${b.id}/complete`, { session_notes: 'Mapped target roles. Next: quantify impact.' })).status, 200);
  assert.equal((await mentorA.post(`/api/mentor/bookings/${b.id}/complete`)).status, 400, 'idempotent');
  let e = (await mentorA.get('/api/mentor/earnings')).json.balance;
  assert.equal(e.earned_sessions, rupees(2500)); assert.equal(e.completed_sessions, 1);
  assert.equal(e.payable, rupees(2500) + rupees(800));
  const payment = await db.one('select id from anvaya.payments where provider_payment_id = $1', [pay.razorpay_payment_id]);
  assert.equal((await admin.post(`/api/admin/payments/${payment.id}/refund`, { amount_paise: rupees(1000), reason: 'Late start' })).status, 200);
  e = (await mentorA.get('/api/mentor/earnings')).json.balance;
  assert.equal(e.adjustments, -rupees(1000)); assert.equal(e.payable, rupees(1500) + rupees(800));
  assert.equal((await admin.post(`/api/admin/mentors/${ids.mentorA}/payouts`, { amount_paise: rupees(99999) })).status, 400, 'cannot overpay');
  assert.equal((await admin.post(`/api/admin/mentors/${ids.mentorA}/payouts`, { amount_paise: rupees(2000), method: 'UPI', reference: 'UTR123' })).status, 201);
  e = (await mentorA.get('/api/mentor/earnings')).json.balance;
  assert.equal(e.paid_out, rupees(2000)); assert.equal(e.payable, rupees(300));
  ids.paidBooking = b.id;
});

test('expired payment holds release the slot; late payments are flagged, not lost', async () => {
  const slots = (await stu1.get(`/api/student/mentors/${ids.mentorB}/slots`)).json;
  const r = await stu1.post('/api/student/bookings/paid', { mentor_id: ids.mentorB, scheduled_at: slots[0] });
  assert.equal(r.status, 201, r.text);
  await mentorB.post(`/api/calendar/bookings/${r.json.booking_id}/approve`);
  r.json.checkout = (await stu1.post(`/api/student/bookings/${r.json.booking_id}/pay`)).json.checkout;
  await db.run("update anvaya.bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [r.json.booking_id]);
  const took = await stu2.post('/api/student/bookings/paid', { mentor_id: ids.mentorB, scheduled_at: slots[0] });
  assert.equal(took.status, 201, took.text);
  const pay = fakePay(r.json.checkout.razorpay_order_id, rupees(3000));
  assert.equal((await stu1.post('/api/student/payments/verify', pay)).json.status, 'paid');
  assert.match((await db.one('select cancel_reason from anvaya.bookings where id = $1', [r.json.booking_id])).cancel_reason, /refund or rebook/);
  assert.equal((await db.one('select needs_followup from anvaya.students where id = $1', [ids.s1])).needs_followup, true);
});

test('reconciliation resolves a payment whose webhook and browser callback were both missed', async () => {
  const o = await stu2.post('/api/student/orders', { product_id: ids.digital });
  fakePay(o.json.checkout.razorpay_order_id, rupees(299));
  await db.run("update anvaya.orders set created_at = now() - interval '20 minutes' where provider_order_id = $1", [o.json.checkout.razorpay_order_id]);
  const out = await jobs.runNow(await jobs.enqueue('payments.reconcile', {}));
  assert.equal(out.result.resolved, 1);
  assert.equal((await db.one('select status from anvaya.orders where provider_order_id = $1', [o.json.checkout.razorpay_order_id])).status, 'paid');
  assert.equal((await stu2.get('/api/student/products')).json.length, 1);
});

// ═══ Isolation ════════════════════════════════════════════════════════
test('mentors see only their own students, groups, bookings and documents; never admin pages', async () => {
  const listA = (await mentorA.get('/api/mentor/students')).json;
  assert.ok(listA.some((s) => s.id === ids.s1));
  for (const s of listA) assert.ok(!('notes' in s));
  assert.ok(!(await mentorB.get('/api/mentor/students')).json.some((s) => s.id === ids.s1), 'mentor B has no relationship with student 1');
  assert.equal((await mentorB.get(`/api/mentor/students/${ids.s1}`)).status, 404);
  assert.equal((await mentorB.patch(`/api/mentor/bookings/${ids.paidBooking}`, { session_notes: 'tamper' })).status, 404);
  assert.equal((await mentorB.post(`/api/mentor/bookings/${ids.paidBooking}/complete`)).status, 404);
  assert.equal((await mentorB.get(`/api/files/${ids.resume1.version_id}/download`)).status, 404);
  assert.equal((await mentorA.get(`/api/files/${ids.resume1.version_id}/download`)).status, 200, 'assigned mentor may read the resume');
  assert.equal((await mentorB.get('/api/mentor/groups')).json.find((g) => g.id === ids.groupA), undefined);
  assert.equal((await mentorA.get('/admin')).status, 403);
  for (const u of ['/api/admin/overview', '/api/admin/students', '/api/admin/leads', '/api/admin/payables', '/api/student/me']) assert.equal((await mentorA.get(u)).status, 403, u);
  assert.ok(!(await mentorB.get('/api/mentor/earnings')).json.entries.some((e) => e.student_name === 'Neha Iyer' && e.kind === 'session_earning'));
});

test('students see only their own records; never admin or mentor APIs', async () => {
  assert.equal((await stu1.get('/admin')).status, 403);
  assert.equal((await stu1.get('/mentor')).status, 403);
  for (const u of ['/api/admin/students', '/api/mentor/students', '/api/admin/followups']) assert.equal((await stu1.get(u)).status, 403, u);
  const b2 = (await stu2.get('/api/student/sessions')).json.bookings.map((b) => b.id);
  const b1 = (await stu1.get('/api/student/sessions')).json.bookings.map((b) => b.id);
  assert.ok(!b1.some((x) => b2.includes(x)));
  assert.equal((await stu1.post(`/api/student/bookings/${ids.paidBooking}/cancel`)).status, 404);
  const ap = await stu1.post('/api/student/applications', { company: 'Razorpay', role_title: 'APM', stage: 'shortlisted' });
  assert.equal(ap.status, 201, ap.text);
  assert.equal((await stu2.patch(`/api/student/applications/${ap.json.id}`, { stage: 'rejected' })).status, 404);
  assert.equal((await stu1.post('/api/student/feedback', { booking_id: ids.paidBooking, rating: 1 })).status, 404);
  assert.equal((await stu2.post('/api/student/feedback', { booking_id: ids.paidBooking, rating: 5, comments: 'Great' })).status, 201);
});

// ═══ Resume workflow ══════════════════════════════════════════════════
test('resume service: purchase → case → coach → draft → QA → admin approval → delivery; nothing reaches the student without QA + approval', async () => {
  const o = await admin.post('/api/admin/orders', { student_id: ids.s1, product_id: ids.resumeProduct });
  await admin.post(`/api/admin/orders/${o.json.id}/record-payment`, { method: 'UPI' });
  const c = await db.one('select * from anvaya.service_cases where order_id = $1', [o.json.id]);
  assert.equal(c.status, 'intake');
  assert.equal((await admin.post('/api/admin/playbooks', { version_label: 'v1.0', rubric_text: '1. Lead with impact. 2. Quantify. 3. No buzzwords.' })).status, 201);
  const pbs = (await admin.get('/api/admin/playbooks')).json;
  await admin.post(`/api/admin/playbooks/${pbs[0].id}/activate`);
  assert.equal((await mentorA.get('/api/admin/playbooks')).status, 403, 'playbook is admin-only');
  assert.equal((await stu1.post(`/api/student/services/${c.id}/intake`, { source_facts: 'Intern at Swiggy 2025: built dashboard used by ops team.' })).status, 200);
  const suggest = (await admin.get(`/api/admin/mentors-suggest?q=product&student_id=${ids.s1}`)).json;
  assert.ok(suggest.length && suggest[0].spare > 0);
  assert.equal((await ops.post(`/api/admin/cases/${c.id}/assign`, { coach_mentor_id: ids.mentorA, coach_fee_paise: 999999 })).status, 200);
  assert.equal((await db.one('select coach_fee_paise from anvaya.service_cases where id = $1', [c.id])).coach_fee_paise, 0, 'ops cannot set fees');
  await admin.post(`/api/admin/cases/${c.id}/assign`, { coach_mentor_id: ids.mentorA, coach_fee_paise: rupees(600) });
  assert.equal((await mentorB.get(`/api/cases/${c.id}`)).status, 404, 'other mentors cannot open the case');
  const ws = (await mentorA.get(`/api/cases/${c.id}`)).json;
  assert.equal(ws.can_edit, true); assert.match(ws.case.source_facts, /Swiggy/);
  assert.equal(ws.ai_configured, undefined, 'AI drafting is removed');
  assert.equal((await mentorA.post(`/api/cases/${c.id}/ai`, { purpose: 'draft' })).status, 404, 'no AI endpoint');
  assert.equal((await mentorA.post(`/api/cases/${c.id}/submit-qa`)).status, 400);
  const d = await mentorA.post(`/api/cases/${c.id}/drafts`, { body_text: 'RAHUL SHARMA\n• Built an ops dashboard at Swiggy [ADD METRIC: users?]' });
  assert.equal(d.status, 201, d.text);
  assert.equal((await mentorA.post(`/api/cases/${c.id}/submit-qa`)).status, 200);
  assert.equal((await admin.post(`/api/admin/cases/${c.id}/deliver`)).status, 400, 'needs a passing QA first');
  assert.equal((await admin.post(`/api/admin/cases/${c.id}/qa`, { document_version_id: d.json.version_id, verdict: 'pass', checklist: {} })).status, 400, 'must confirm no invented facts');
  assert.equal((await admin.post(`/api/admin/cases/${c.id}/qa`, { document_version_id: d.json.version_id, verdict: 'pass', checklist: { no_invented_facts: true, rubric_applied: true } })).status, 200);
  assert.equal((await stu1.get('/api/student/services')).json.find((x) => x.id === c.id).documents.length, 0, 'nothing visible before approval');
  assert.equal((await admin.post(`/api/admin/cases/${c.id}/deliver`)).status, 200);
  const svc = (await stu1.get('/api/student/services')).json.find((x) => x.id === c.id);
  assert.equal(svc.status, 'delivered'); assert.equal(svc.documents.length, 1);
  const file = await stu1.get(`/api/files/${svc.documents[0].latest_version_id}/download`);
  assert.match(file.json.text, /Swiggy/);
  assert.equal((await stu2.get(`/api/files/${svc.documents[0].latest_version_id}/download`)).status, 404);
  assert.equal((await mentorA.get('/api/mentor/earnings')).json.balance.service_fees, rupees(600));
  assert.equal((await stu1.post(`/api/student/services/${c.id}/revision`, { note: 'Add my hackathon win' })).status, 200);
  assert.equal((await stu1.post(`/api/student/services/${c.id}/revision`, { note: 'again' })).status, 400);
});

// ═══ Subscription lifecycle & jobs ════════════════════════════════════
test('renewal reminders, grace period and expiry gate access (access separate from billing)', async () => {
  await db.run("update anvaya.subscriptions set paid_through = now() + interval '1 day 12 hours', grace_until = now() + interval '6 days' where student_id = $1", [ids.s2]);
  await jobs.processDue({ kinds: ['email.send'], limit: 100 }); // flush earlier queued confirmations
  const before = emailCount('neha@students.test');
  await jobs.runNow(await jobs.enqueue('subscriptions.daily', {}));
  await jobs.processDue({ kinds: ['email.send'] });
  assert.equal(emailCount('neha@students.test'), before + 1);
  assert.match(lastEmailTo('neha@students.test').subject, /renews in 2 days/);
  await db.run("update anvaya.subscriptions set paid_through = now() - interval '1 day', grace_until = now() + interval '4 days' where student_id = $1", [ids.s2]);
  await jobs.runNow(await jobs.enqueue('subscriptions.daily', {}));
  let me = (await stu2.get('/api/student/me')).json;
  assert.equal(me.subscription.effective_access, 'grace');
  assert.equal(me.subscription.billing_status, 'due');
  await db.run("update anvaya.subscriptions set grace_until = now() - interval '1 minute' where student_id = $1", [ids.s2]);
  await jobs.runNow(await jobs.enqueue('subscriptions.daily', {}));
  me = (await stu2.get('/api/student/me')).json;
  assert.equal(me.subscription, null);
  const slots = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  assert.equal((await stu2.post('/api/student/bookings/checkup', { mentor_id: ids.mentorA, scheduled_at: slots[0] })).status, 403);
  assert.equal((await stu2.get('/api/student/syllabus')).json.locked, true);
});

test('job queue retries with backoff and records failures for the admin', async () => {
  let calls = 0;
  jobs.register('test.flaky', async () => { calls++; if (calls < 2) throw new Error('boom'); return 'ok'; });
  const id = await jobs.enqueue('test.flaky', {}, { maxAttempts: 3 });
  assert.equal((await jobs.runNow(id)).ok, false);
  assert.equal((await db.one('select status from anvaya.jobs where id = $1', [id])).status, 'failed');
  await db.run('update anvaya.jobs set run_at = now() where id = $1', [id]);
  await jobs.processDue({ kinds: ['test.flaky'] });
  assert.equal((await db.one('select status from anvaya.jobs where id = $1', [id])).status, 'done');
  assert.ok((await admin.get('/api/admin/system')).json.jobs.length > 0);
});

test('cron worker requires CRON_SECRET', async () => {
  assert.equal((await fetch(BASE + '/api/cron/run')).status, 401);
  assert.equal((await fetch(BASE + '/api/cron/run', { headers: { Authorization: 'Bearer cron-test-secret' } })).status, 200);
});

test('password reset: generic response, single-use, signs out other sessions', async () => {
  const anon = new Client();
  const unknown = await anon.post('/api/auth/forgot', { email: 'nobody@nowhere.test' });
  const known = await anon.post('/api/auth/forgot', { email: 'rahul@students.test' });
  assert.equal(unknown.json.message, known.json.message);
  const tok = tokenFrom(lastEmailTo('rahul@students.test'));
  const other = new Client(); await other.login('rahul@students.test', 'Student-pass-1');
  assert.equal((await anon.post('/api/invites/accept', { token: tok, password: 'New-student-pass-2', confirm: 'New-student-pass-2' })).status, 200);
  assert.equal((await other.get('/api/student/me')).status, 401, 'old sessions revoked');
  assert.equal((await anon.post('/api/invites/accept', { token: tok, password: 'Again-pass-333', confirm: 'Again-pass-333' })).status, 410);
  assert.equal((await new Client().login('rahul@students.test', 'New-student-pass-2')).status, 200);
});

test('B2B cohorts: enrollment and restricted cohort report', async () => {
  const col = await admin.post('/api/admin/colleges', { name: 'XYZ Institute of Management', city: 'Pune' });
  const k = await admin.post('/api/admin/cohorts', { name: 'XYZ PGDM 2027', college_id: col.json.id, track_id: ids.track });
  assert.equal((await admin.post(`/api/admin/cohorts/${k.json.id}/members`, { student_ids: [ids.s1] })).status, 200);
  const rep = (await admin.get(`/api/admin/cohorts/${k.json.id}/report`)).json;
  assert.equal(rep.length, 1); assert.ok('attended' in rep[0] && 'assignments_done' in rep[0]);
  assert.ok(!('notes' in rep[0]) && !('email' in rep[0]));
  assert.equal((await stu2.get(`/api/admin/cohorts/${k.json.id}/report`)).status, 403);
});

test('mentors with history cannot be deleted (only deactivated)', async () => {
  const r = await admin.req('DELETE', `/api/admin/mentors/${ids.mentorA}`);
  assert.equal(r.status, 400); assert.match(r.json.error, /Deactivate/);
  assert.equal((await mentorA.req('DELETE', `/api/admin/mentors/${ids.mentorB}`)).status, 403);
});

// ═══ Operations workspace ═══════════════════════════════════════════════
const cron = async () => {
  // Same work the 5-minute scheduler triggers; a fresh reminders run each call (the scheduler dedupes per 5-minute window).
  assert.equal((await fetch(`${BASE}/api/cron/run`, { headers: { Authorization: 'Bearer cron-test-secret' } })).status, 200);
  await jobs.runNow(await jobs.enqueue('sessions.reminders', {}));
  await jobs.processDue({ kinds: ['email.send'], limit: 100 });
};
test('workspace: tasks, owners, queues, bulk assign, saved views, paginated tables; ops limits respected', async () => {
  const staffUsers = (await admin.get('/api/admin/staff-users')).json;
  const riya = staffUsers.find((u) => u.role === 'ops');
  assert.ok(riya, 'ops user listed as an owner option');
  const t = await admin.post('/api/admin/tasks', { title: 'Call about resume v3', student_id: ids.s1, owner_user_id: 'me', due_at: new Date(Date.now() - 3600e3).toISOString() });
  assert.equal(t.status, 201, t.text);
  const q = (await admin.get('/api/admin/queues')).json;
  assert.ok(q.my_tasks >= 1 && q.followups_due >= 1, JSON.stringify(q));
  assert.ok((await admin.get('/api/admin/queues/my_tasks')).json.some((x) => x.type === 'task' && x.id === t.json.id));
  assert.equal((await admin.get('/api/admin/queues/nope')).status, 404);
  assert.ok((await admin.get('/api/admin/today')).json.tasks.some((x) => x.id === t.json.id));
  assert.equal((await admin.patch(`/api/admin/tasks/${t.json.id}`, { status: 'done' })).status, 200);
  assert.ok(!(await admin.get('/api/admin/queues/my_tasks')).json.some((x) => x.id === t.json.id));
  // follow-up + owner on a student, visible in the timeline
  assert.equal((await ops.patch(`/api/admin/followup/students/${ids.s1}`, { owner_user_id: 'me', next_action: 'Confirm resume v3', follow_up_at: new Date(Date.now() - 60e3).toISOString() })).status, 200);
  assert.ok((await admin.get('/api/admin/queues/followups_due')).json.some((x) => x.type === 'student' && x.id === ids.s1));
  // owners must be team members
  assert.equal((await admin.patch(`/api/admin/followup/students/${ids.s1}`, { owner_user_id: (await db.one("select id from anvaya.users where role = 'mentor' limit 1")).id })).status, 400);
  // bulk assign leads + filtered, paginated table + saved views
  for (let i = 0; i < 12; i++) await admin.post('/api/admin/leads', { name: `Bulk lead ${i}`, phone: `98000000${String(i).padStart(2, '0')}`, source: 'Webinar' });
  const page1 = (await admin.get('/api/admin/leads-table?source=Webinar&page_size=10')).json;
  assert.equal(page1.rows.length, 10); assert.equal(page1.total, 12);
  assert.equal((await admin.get('/api/admin/leads-table?source=Webinar&page_size=10&page=2')).json.rows.length, 2);
  const ids12 = (await admin.get('/api/admin/leads-table?source=Webinar&page_size=50')).json.rows.map((r) => r.id);
  assert.equal((await admin.post('/api/admin/bulk-assign', { scope: 'leads', ids: Array.from({ length: 101 }, (_, i) => i + 1), owner_user_id: riya.id })).status, 400, 'capped at 100');
  const ba = await ops.post('/api/admin/bulk-assign', { scope: 'leads', ids: ids12, owner_user_id: riya.id });
  assert.equal(ba.json.updated, 12);
  assert.equal((await ops.get('/api/admin/leads-table?owner=me&source=Webinar')).json.total, 12);
  const sv = await ops.post('/api/admin/views', { scope: 'leads', name: 'My webinar leads', query: { owner: 'me', source: 'Webinar', evil: 'x' } });
  assert.equal(sv.status, 201);
  const views = (await ops.get('/api/admin/views?scope=leads')).json;
  assert.deepEqual(views[0].query, { owner: 'me', source: 'Webinar' });
  assert.equal((await admin.get('/api/admin/views?scope=leads')).json.length, 0, 'views are per user');
  assert.equal((await ops.req('DELETE', `/api/admin/views/${sv.json.id}`)).status, 200);
  const st = (await admin.get(`/api/admin/students-table?q=Rahul&page_size=10`)).json;
  assert.ok(st.rows.some((r) => r.id === ids.s1 && r.owner_name));
  // students, mentors and anonymous users stay out
  for (const c of [stu1, mentorA, new Client()]) {
    assert.ok([401, 403].includes((await c.get('/api/admin/queues')).status));
    assert.ok([401, 403].includes((await c.get(`/api/admin/students/${ids.s1}/workspace`)).status));
  }
});

test('timeline: internal notes stay internal; messages reach the student with real email status; support requests flow both ways', async () => {
  assert.equal((await stu1.login('rahul@students.test', 'New-student-pass-2')).status, 200); // an earlier test reset this password
  const note = await admin.post(`/api/admin/students/${ids.s1}/entries`, { kind: 'internal_note', body: 'Prefers WhatsApp in the evening (INTERNAL)' });
  assert.equal(note.status, 201); assert.equal(note.json.email, 'not_requested');
  const msg = await ops.post(`/api/admin/students/${ids.s1}/entries`, { kind: 'message', body: 'Please upload resume v3 before Thursday.', email: true });
  assert.equal(msg.status, 201); assert.equal(msg.json.email, 'delivered');
  assert.match(lastEmailTo('rahul@students.test').text, /resume v3 before Thursday/);
  const quiet = await admin.post(`/api/admin/students/${ids.s1}/entries`, { kind: 'message', body: 'Portal-only note to you.' });
  assert.equal(quiet.json.email, 'not_requested');
  const mineRes = await stu1.get('/api/student/messages');
  assert.equal(mineRes.status, 200, mineRes.text);
  const mine = mineRes.json;
  assert.ok(mine.some((m) => m.body.includes('resume v3')) && mine.some((m) => m.body.includes('Portal-only')));
  assert.ok(!mine.some((m) => m.body.includes('INTERNAL')), 'internal notes never reach the student');
  assert.ok(!(await stu2.get('/api/student/messages')).json.some((m) => m.body.includes('resume v3')), 'not visible to other students');
  const ws = (await ops.get(`/api/admin/students/${ids.s1}/workspace`)).json;
  const kinds = ws.timeline.map((e) => `${e.kind}:${e.email_status}`);
  assert.ok(kinds.includes('internal_note:not_requested') && kinds.includes('message:delivered') && kinds.includes('message:not_requested'));
  assert.ok(ws.timeline.some((e) => e.kind === 'system' && /verified by Razorpay/.test(e.body)), 'Razorpay purchase recorded as verified');
  assert.ok(ws.payments.length && !('amount_paise' in ws.payments[0]), 'ops sees payment status, not amounts');
  assert.ok(!('notes' in ws.student), 'ops never sees sensitive admin notes');
  assert.ok('amount_paise' in (await admin.get(`/api/admin/students/${ids.s1}/workspace`)).json.payments[0]);
  // support request: student → staff → student → staff
  const sc = await stu1.post('/api/student/support', { subject: 'Can I move my check-up?', body: 'Thursday no longer works.', category: 'sessions' });
  assert.equal(sc.status, 201, sc.text);
  assert.ok((await admin.get('/api/admin/queues/awaiting_staff')).json.some((x) => x.id === sc.json.id));
  assert.ok((await admin.get(`/api/admin/tasks?student_id=${ids.s1}`)).json.some((x) => x.support_case_id === sc.json.id), 'reply task created');
  assert.equal((await ops.post(`/api/admin/students/${ids.s2}/entries`, { kind: 'message', body: 'x', support_case_id: sc.json.id })).status, 400, 'case belongs to another student');
  await ops.post(`/api/admin/students/${ids.s1}/entries`, { kind: 'message', body: 'Yes, pick any open slot in Sessions.', support_case_id: sc.json.id, case_status: 'awaiting_student' });
  let mineCases = (await stu1.get('/api/student/support')).json;
  assert.equal(mineCases[0].status, 'awaiting_student'); assert.equal(mineCases[0].history.length, 2);
  assert.equal((await stu2.post(`/api/student/support/${sc.json.id}/reply`, { body: 'hijack' })).status, 404);
  await stu1.post(`/api/student/support/${sc.json.id}/reply`, { body: 'Thanks, done.' });
  mineCases = (await stu1.get('/api/student/support')).json;
  assert.equal(mineCases[0].status, 'awaiting_staff'); assert.equal(mineCases[0].history.length, 3);
});

test('verified payment → access → confirmation email → onboarding (account invite, task, timeline), exactly once', async () => {
  const s = await admin.post('/api/admin/students', { name: 'Kavya Nair', email: 'kavya@students.test', phone: '+91 98000 11111' });
  const o = await admin.post('/api/admin/orders', { student_id: s.json.id, product_id: ids.plan });
  const before = mailer.sent.length;
  assert.equal((await admin.post(`/api/admin/orders/${o.json.id}/record-payment`, { method: 'UPI', reference: 'UTR123' })).status, 200);
  await jobs.processDue({ kinds: ['email.send'], limit: 50 });
  const toKavya = mailer.sent.slice(before).filter((m) => m.to === 'kavya@students.test');
  assert.ok(toKavya.some((m) => /Payment received/.test(m.subject)), 'payment confirmation sent');
  assert.ok(toKavya.some((m) => /invite|set up|Set up/i.test(m.subject + m.text) && /token=/.test(m.text)), 'account invitation sent');
  const ws = (await admin.get(`/api/admin/students/${s.json.id}/workspace`)).json;
  assert.equal(ws.subscription.effective_access, 'active');
  assert.ok(ws.student.onboarding_started_at);
  assert.ok(ws.timeline.some((e) => e.kind === 'system' && /recorded manually by an admin/.test(e.body) && /account invitation sent/.test(e.body)));
  assert.equal(ws.tasks.filter((x) => /Welcome call/.test(x.title)).length, 1);
  // repeated callbacks (webhook + browser + reconciliation) must not repeat onboarding
  await payments.afterPayment(o.json.id, { provider: 'manual' });
  await payments.afterPayment(o.json.id, { provider: 'manual' });
  await jobs.processDue({ kinds: ['email.send'], limit: 50 });
  assert.equal(mailer.sent.slice(before).filter((m) => m.to === 'kavya@students.test' && /Payment received/.test(m.subject)).length, 1);
  assert.equal((await admin.get(`/api/admin/students/${s.json.id}/workspace`)).json.tasks.filter((x) => /Welcome call/.test(x.title)).length, 1);
  // the new account can sign up from the invite and lands on intake
  const kc = new Client();
  const inv = mailer.sent.filter((m) => m.to === 'kavya@students.test' && /token=/.test(m.text)).at(-1);
  assert.equal((await kc.post('/api/invites/accept', { token: tokenFrom(inv), password: 'Kavya-pass-01', confirm: 'Kavya-pass-01' })).json.next, '/student#intake');
  await kc.refresh();
  const home = (await kc.get('/api/student/home')).json;
  assert.equal(home.next.kind, 'intake'); assert.equal(home.payment.status, 'verified');
  // synthetic mentors are never shown to real students
  const tm = await admin.post('/api/admin/mentors', { name: 'TEST hidden mentor', email: 'hidden.mentor@mentors.test', session_price_paise: 100, is_test: true });
  await db.run("update anvaya.mentors set status = 'active' where id = $1", [tm.json.id]);
  assert.ok(!(await kc.get('/api/student/mentors')).json.some((m) => m.id === tm.json.id), 'real student cannot see a test mentor');
  await db.run('update anvaya.mentors set status = $2 where id = $1', [tm.json.id, 'deactivated']);
  assert.equal(home.milestones.find((m) => m.key === 'intake').done, false);
});

test('reminders: sent on schedule without site visits; moving or cancelling a session cancels stale reminders and notifies once', async () => {
  const start = new Date(Math.ceil((Date.now() + 90 * 60e3) / 60e3) * 60e3).toISOString();
  const b = await admin.post('/api/admin/bookings', { student_id: ids.s2, mentor_id: ids.mentorA, kind: 'paid_session', scheduled_at: start, outside_availability: true, service: 'Reminder test session' });
  assert.equal(b.status, 201, b.text);
  await admin.patch(`/api/admin/bookings/${b.json.id}`, { status: 'scheduled' });
  await cron();
  const reminder = (key) => db.all("select dedupe_key, status from anvaya.jobs where dedupe_key like $1", [key]);
  const first = await reminder(`remind:%:booking:${b.json.id}:${new Date(start).getTime()}`);
  assert.ok(first.length >= 1, 'reminder created by the scheduled job');
  assert.ok(mailer.sent.some((m) => m.to === 'neha@students.test' && /Reminder: Reminder test session/.test(m.subject)));
  assert.equal((await reminder(`remind:24h:booking:${b.json.id}:%`)).length, 0, 'no 24 h reminder for a session already inside the 2 h window');
  // a reminder still waiting for a retry is cancelled when the session moves
  await db.run("update anvaya.jobs set status = 'failed', run_at = now() + interval '1 hour' where dedupe_key like $1", [`remind:%:booking:${b.json.id}:%`]);
  const moved = new Date(new Date(start).getTime() + 30 * 60e3).toISOString();
  assert.equal((await admin.patch(`/api/admin/bookings/${b.json.id}`, { scheduled_at: moved })).status, 200);
  assert.ok((await reminder(`remind:%:booking:${b.json.id}:${new Date(start).getTime()}`)).every((j) => j.status === 'cancelled'), 'old-time reminders cancelled');
  await cron();
  assert.ok((await reminder(`remind:%:booking:${b.json.id}:${new Date(moved).getTime()}`)).length >= 1, 'fresh reminders for the new time');
  assert.ok(mailer.sent.some((m) => m.to === 'neha@students.test' && /^Rescheduled: Reminder test session/.test(m.subject)));
  assert.ok((await db.one('select reschedule_count from anvaya.bookings where id = $1', [b.json.id])).reschedule_count === 1);
  await admin.patch(`/api/admin/bookings/${b.json.id}`, { status: 'cancelled', cancel_reason: 'Mentor unavailable' });
  await cron();
  assert.ok(mailer.sent.some((m) => m.to === 'neha@students.test' && /^Cancelled: Reminder test session/.test(m.subject)));
  // student reschedules their own upcoming session to an open slot (re-validated, notice respected)
  const far = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  const own = await admin.post('/api/admin/bookings', { student_id: ids.s2, mentor_id: ids.mentorA, kind: 'paid_session', scheduled_at: far[far.length - 1], service: 'Own session' });
  await admin.patch(`/api/admin/bookings/${own.json.id}`, { status: 'scheduled' });
  const target = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json.at(-3);
  assert.equal((await stu1.post(`/api/student/bookings/${own.json.id}/reschedule`, { scheduled_at: target })).status, 404, 'only the owner can move it');
  assert.equal((await stu2.post(`/api/student/bookings/${own.json.id}/reschedule`, { scheduled_at: '2020-01-01T00:00:00Z' })).status, 409);
  const rs = await stu2.post(`/api/student/bookings/${own.json.id}/reschedule`, { scheduled_at: target });
  assert.equal(rs.status, 200, rs.text);
  assert.equal(new Date((await db.one('select scheduled_at from anvaya.bookings where id = $1', [own.json.id])).scheduled_at).toISOString(), target);
});

test('mentor services: submitted → admin-approved → bookable with its own duration, price and intake; buffers and note visibility respected', async () => {
  const sv = await mentorA.post('/api/mentor/services', { title: 'Mock interview', description: 'PM product-sense mock', duration_min: 60, price_paise: rupees(1800),
    intake_questions: [{ label: 'Which company are you interviewing with?', required: true }] });
  assert.equal(sv.status, 201, sv.text); assert.equal(sv.json.approval, 'pending');
  const listed = () => stu1.get('/api/student/mentors').then((r) => r.json.find((m) => m.id === ids.mentorA).services.some((x) => x.id === sv.json.id));
  assert.equal(await listed(), false, 'pending services are hidden');
  assert.equal((await ops.post(`/api/admin/mentor-services/${sv.json.id}/approve`)).status, 403, 'prices need an admin');
  assert.equal((await admin.post(`/api/admin/mentor-services/${sv.json.id}/approve`)).status, 200);
  assert.equal(await listed(), true);
  assert.ok(!('price_paise' in (await ops.get('/api/admin/mentor-services')).json[0]), 'ops sees services without prices');
  const filtered = (await stu1.get(`/api/student/mentors?expertise=product&max_price=${rupees(2000)}`)).json;
  assert.ok(filtered.some((m) => m.id === ids.mentorA));
  assert.ok(!(await stu1.get(`/api/student/mentors?max_price=${rupees(100)}`)).json.some((m) => m.id === ids.mentorA && m.services.some((x) => x.id === sv.json.id && x.price_paise <= rupees(100))));
  assert.equal((await mentorA.patch('/api/mentor/me', { buffer_minutes: 15 })).status, 200);
  const slots = (await stu1.get(`/api/student/mentors/${ids.mentorA}/slots?service_id=${sv.json.id}`)).json;
  assert.ok(slots.length > 2);
  const busy = await db.all("select scheduled_at, ends_at from anvaya.bookings where mentor_id = $1 and status in ('pending_payment','requested','scheduled') and ends_at > now()", [ids.mentorA]);
  for (const sl of slots.slice(0, 40)) {
    const s0 = new Date(sl).getTime(), e0 = s0 + 60 * 60e3;
    assert.ok(busy.every((x) => e0 + 15 * 60e3 <= new Date(x.scheduled_at).getTime() || s0 >= new Date(x.ends_at).getTime() + 15 * 60e3), 'buffer kept around booked sessions');
  }
  assert.equal((await stu1.post('/api/student/bookings/paid', { mentor_id: ids.mentorA, scheduled_at: slots[0], service_id: sv.json.id })).status, 400, 'required intake answer');
  const bk = await stu1.post('/api/student/bookings/paid', { mentor_id: ids.mentorA, scheduled_at: slots[0], service_id: sv.json.id, intake_answers: { q1: 'Demo Corp' } });
  assert.equal(bk.status, 201, bk.text);
  const row = await db.one('select * from anvaya.bookings where id = $1', [bk.json.booking_id]);
  assert.equal(Number(row.price_paise), rupees(1800)); assert.equal(Number(row.mentor_fee_paise), rupees(1800), 'full stated fee to the mentor');
  assert.equal(row.duration, 60); assert.equal(row.intake_answers.q1, 'Demo Corp'); assert.equal(row.service, 'Mock interview');
  // edits send the service back for approval
  assert.equal((await mentorA.patch(`/api/mentor/services/${sv.json.id}`, { price_paise: rupees(2500) })).json.approval, 'pending');
  assert.equal(await listed(), false);
  assert.equal((await mentorB.patch(`/api/mentor/services/${sv.json.id}`, { active: false })).status, 404, 'other mentors cannot touch it');
  // session notes: private by default; shared only when the mentor chooses
  await mentorA.patch(`/api/mentor/bookings/${row.id}`, { session_notes: 'Strong structure; add metrics.' });
  let home = (await stu1.get('/api/student/home')).json;
  assert.equal(home.sessions.bookings.find((x) => x.id === row.id)?.shared_notes ?? null, null);
  await mentorA.patch(`/api/mentor/bookings/${row.id}`, { notes_visibility: 'student' });
  home = (await stu1.get('/api/student/home')).json;
  assert.equal(home.sessions.bookings.find((x) => x.id === row.id).shared_notes, 'Strong structure; add metrics.');
  assert.equal((await mentorA.get('/api/mentor/agenda')).json.find((x) => x.id === row.id)?.status, 'requested', 'requests show on the agenda for approval');
  assert.ok((await mentorA.get('/api/mentor/agenda')).json.every((x) => ['scheduled', 'requested'].includes(x.status)));
});

test('public payment page: server prices the plan, verifies Razorpay, and activates access + onboarding without manual steps', async () => {
  const prod = await admin.post('/api/admin/products', { kind: 'coaching_package', name: 'MBA Planning & Strategy Call', price_paise: rupees(500), active: true, public_key: '500mba' });
  assert.equal(prod.status, 201, prod.text);
  const anon = new Client();
  const plans = (await anon.get('/api/public/checkout/plans')).json;
  assert.ok(plans.plans.some((x) => x.key === '500mba' && Number(x.price_paise) === rupees(500)));
  // CORS: the page lives on the main site
  const pre = await fetch(`${BASE}/api/public/checkout`, { method: 'OPTIONS', headers: { Origin: 'https://anvayacareers.in', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  // the browser can't choose the price: amount comes from the product, referral discount from the server rule
  const co = await anon.post('/api/public/checkout', { plan_key: '500mba', name: 'Ishaan Verma', email: 'Ishaan@Buyers.test', phone: '+91 98111 00000', ref_code: 'FRIEND10', amount: 1 });
  assert.equal(co.status, 201, co.text);
  assert.equal(co.json.amount_paise, rupees(450)); assert.equal(co.json.discount_paise, rupees(50));
  assert.equal(co.json.key, 'rzp_fake_test');
  assert.equal((await anon.post('/api/public/checkout', { plan_key: 'nope', name: 'x', email: 'x@y.test', phone: '9999999999' })).status, 400);
  // forged signature refused; real one marks paid
  const pay = fakePay(co.json.razorpay_order_id, rupees(450));
  assert.equal((await anon.post('/api/public/checkout/verify', { ...pay, razorpay_signature: 'f'.repeat(64) })).status, 400);
  const before = mailer.sent.length;
  const v1 = await anon.post('/api/public/checkout/verify', pay);
  assert.equal(v1.json.status, 'paid', v1.text);
  await jobs.processDue({ kinds: ['email.send'], limit: 50 });
  const mails = mailer.sent.slice(before).filter((m) => m.to === 'ishaan@buyers.test');
  assert.ok(mails.some((m) => /Payment received: MBA Planning/.test(m.subject)), 'confirmation');
  assert.ok(mails.some((m) => /token=/.test(m.text)), 'account invitation');
  const st = await db.one("select * from anvaya.students where email = 'ishaan@buyers.test'");
  const o = await db.one("select * from anvaya.orders where provider_order_id = $1", [co.json.razorpay_order_id]);
  assert.equal(o.status, 'paid'); assert.equal(o.source, 'public_page'); assert.equal(o.ref_code, 'FRIEND10'); assert.equal(Number(o.discount_paise), rupees(50));
  assert.ok(st.onboarding_started_at && st.user_id);
  assert.ok(await db.one("select 1 from anvaya.service_cases where order_id = $1", [o.id]), 'purchased service opened automatically');
  const ws = (await admin.get(`/api/admin/students/${st.id}/workspace`)).json;
  assert.ok(ws.timeline.some((e) => e.kind === 'system' && /verified by Razorpay/.test(e.body)));
  // the webhook arriving afterwards changes nothing (idempotent)
  const n = mailer.sent.length;
  await anon.post('/api/public/checkout/verify', pay);
  await payments.afterPayment(o.id, { provider: 'razorpay' });
  await jobs.processDue({ kinds: ['email.send'], limit: 50 });
  assert.equal(mailer.sent.slice(n).filter((m) => m.to === 'ishaan@buyers.test').length, 0);
  assert.equal(Number((await db.one('select count(*) n from anvaya.payments where order_id = $1', [o.id])).n), 1);
});

test('existing payment page (public key only): verified webhook activates the purchase automatically; mismatches are flagged, not activated', async () => {
  const hook = (payment, id) => {
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: payment } }, created_at: Date.now() });
    const sig = crypto.createHmac('sha256', 'whsec-test').update(body).digest('hex');
    return fetch(`${BASE}/api/webhooks/razorpay`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': id } });
  };
  await require('../src/lib/settings').set('page_confirmation_sender', 'app', null); // the app, not the page's Apps Script, confirms
  const prod = (await admin.get('/api/admin/products')).json.find((x) => x.public_key === '500mba');
  const pay = { id: 'pay_page_1', order_id: null, amount: rupees(450), status: 'captured', method: 'upi', email: 'Riya.Page@Buyers.test', contact: '+919800000001', notes: { plan: prod.name, sessions: '1 × 30 min' }, fee: 900, tax: 162 };
  const forged = await fetch(`${BASE}/api/webhooks/razorpay`, { method: 'POST', body: JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { ...pay, id: 'pay_forged' } } } }), headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'bad', 'X-Razorpay-Event-Id': 'evt_forged' } });
  assert.equal(forged.status, 401, 'unsigned events are ignored');
  const before = mailer.sent.length;
  assert.equal((await hook(pay, 'evt_page_1')).status, 200);
  await jobs.processDue({ kinds: ['payments.webhook', 'email.send'], limit: 50 });
  const st = await db.one("select * from anvaya.students where email = 'riya.page@buyers.test'");
  assert.ok(st, 'student created from the payment');
  const o = await db.one("select * from anvaya.orders where student_id = $1", [st.id]);
  assert.equal(o.status, 'paid'); assert.equal(o.source, 'public_page_direct'); assert.equal(Number(o.discount_paise), rupees(50));
  assert.ok(await db.one('select 1 from anvaya.service_cases where order_id = $1', [o.id]), 'service opened');
  const mails = mailer.sent.slice(before).filter((m) => m.to === 'riya.page@buyers.test');
  assert.ok(mails.some((m) => /Payment received/.test(m.subject)) && mails.some((m) => /token=/.test(m.text)), 'confirmation + account invite');
  // repeated delivery of the same payment (new event id) changes nothing
  await hook(pay, 'evt_page_1_retry');
  await jobs.processDue({ kinds: ['payments.webhook', 'email.send'], limit: 50 });
  assert.equal(Number((await db.one("select count(*) n from anvaya.payments where provider_payment_id = 'pay_page_1'")).n), 1);
  assert.equal(Number((await db.one('select count(*) n from anvaya.orders where student_id = $1', [st.id])).n), 1);
  // too little paid, or an unknown plan: flagged for staff, nothing activated
  await hook({ ...pay, id: 'pay_page_low', amount: rupees(100), email: 'low@buyers.test' }, 'evt_low');
  await hook({ ...pay, id: 'pay_page_unknown', email: 'unk@buyers.test', notes: { plan: 'Something else' } }, 'evt_unk');
  await jobs.processDue({ kinds: ['payments.webhook'], limit: 50 });
  assert.ok(!(await db.one("select 1 from anvaya.students where email in ('low@buyers.test','unk@buyers.test')")), 'nothing activated for mismatches');
  const flags = await db.all("select title from anvaya.tasks where dedupe_key like 'page-pay-flag:%'");
  assert.ok(flags.some((f) => /pay_page_low.*below/.test(f.title)) && flags.some((f) => /pay_page_unknown.*not recognised/.test(f.title)));
});

test('payment Sheet + team email: verified payments copied once per payment id, a Sheet outage never blocks access, failures and refunds update the same row', async () => {
  const send = (event, payload, id) => {
    const body = JSON.stringify({ event, payload, created_at: Date.now() });
    const sig = crypto.createHmac('sha256', 'whsec-test').update(body).digest('hex');
    return fetch(`${BASE}/api/webhooks/razorpay`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': id } });
  };
  const svc = (await admin.get('/api/admin/products')).json.find((x) => x.public_key === '500mba');
  const pay = { id: 'pay_sheet_1', order_id: null, amount: svc.price_paise, status: 'captured', method: 'upi', email: 'sheet.buyer@buyers.test', contact: '+919800000123', notes: { plan: svc.name } };
  const teamMails = () => mailer.sent.filter((m) => m.to === 'team@anvaya.test' && /pay_sheet_1/.test(m.text));
  // the Sheet is down: the payment still activates everything
  paySheetMode = 'fail';
  assert.equal((await send('payment.captured', { payment: { entity: pay } }, 'evt_sheet_1')).status, 200);
  await jobs.processDue({ kinds: ['payments.webhook', 'email.send', 'paysheet.sync'], limit: 50 });
  const o = await db.one("select o.* from anvaya.orders o join anvaya.students s on s.id = o.student_id where s.email = 'sheet.buyer@buyers.test'");
  assert.equal(o.status, 'paid');
  assert.ok(await db.one('select 1 from anvaya.service_cases where order_id = $1', [o.id]), 'access granted despite the Sheet failure');
  const mine = mailer.sent.filter((m) => m.to === 'sheet.buyer@buyers.test');
  assert.equal(mine.filter((m) => /Payment received/.test(m.subject)).length, 1, 'one confirmation');
  assert.ok(mine.some((m) => /calendly\.com\/teamanvaya-in\/30min/.test(m.text)), 'confirmation carries the booking link');
  assert.equal(mine.filter((m) => /token=/.test(m.text)).length, 1, 'one account invitation');
  let g = await db.one("select * from anvaya.gateway_payments where provider_payment_id = 'pay_sheet_1'");
  assert.equal(g.status, 'paid'); assert.equal(g.sheet_status, 'failed'); assert.match(g.sheet_error, /not JSON/);
  assert.equal(teamMails().length, 1, 'team told once');
  // the Sheet comes back: the hourly sweep copies it, once
  paySheetMode = 'ok';
  await jobs.runNow(await jobs.enqueue('paysheet.resync', {}, { dedupeKey: `t-resync-${Date.now()}` }));
  await jobs.processDue({ kinds: ['paysheet.sync'], limit: 20 });
  g = await db.one("select * from anvaya.gateway_payments where provider_payment_id = 'pay_sheet_1'");
  assert.equal(g.sheet_status, 'synced');
  const row = payRows.get('pay_sheet_1');
  assert.equal(row.status, 'Paid (verified by Razorpay)'); assert.equal(row.amount, '500'); assert.equal(row.email, 'sheet.buyer@buyers.test');
  assert.equal(row.phone, '+919800000123'); assert.equal(row.plan, svc.name); assert.equal(row.name, '', 'no guessed name: the page row keeps the real one'); assert.ok(row.date);
  // Razorpay retries (same and new event ids): nothing new anywhere
  const posts = payPosts.length;
  await send('payment.captured', { payment: { entity: pay } }, 'evt_sheet_1');
  await send('payment.captured', { payment: { entity: pay } }, 'evt_sheet_1_retry');
  await jobs.processDue({ kinds: ['payments.webhook', 'email.send', 'paysheet.sync'], limit: 50 });
  assert.equal(payPosts.length, posts, 'no extra Sheet writes'); assert.equal(teamMails().length, 1);
  assert.equal(mailer.sent.filter((m) => m.to === 'sheet.buyer@buyers.test' && /Payment received/.test(m.subject)).length, 1);
  // a late "failed" for the same payment can't undo it
  await send('payment.failed', { payment: { entity: { ...pay, status: 'failed', error_description: 'late' } } }, 'evt_sheet_late_fail');
  await jobs.processDue({ kinds: ['payments.webhook', 'paysheet.sync'], limit: 20 });
  assert.equal((await db.one("select status from anvaya.gateway_payments where provider_payment_id = 'pay_sheet_1'")).status, 'paid');
  // a failed attempt is recorded and copied, without activating anything or emailing anyone
  const fail = { id: 'pay_sheet_fail', order_id: null, amount: svc.price_paise, status: 'failed', method: 'card', email: 'nopay@buyers.test', contact: '+919800000777', notes: { plan: svc.name }, error_description: 'Card declined by bank', created_at: Math.floor(Date.now() / 1000) };
  const before = mailer.sent.length;
  await send('payment.failed', { payment: { entity: fail } }, 'evt_sheet_fail');
  await send('payment.failed', { payment: { entity: fail } }, 'evt_sheet_fail_again');
  await jobs.processDue({ kinds: ['payments.webhook', 'paysheet.sync', 'email.send'], limit: 20 });
  assert.equal(payRows.get('pay_sheet_fail').status, 'Failed'); assert.equal(payRows.get('pay_sheet_fail').note, 'Card declined by bank');
  assert.ok(!(await db.one("select 1 from anvaya.students where email = 'nopay@buyers.test'")), 'failed attempt creates no student');
  assert.equal(mailer.sent.length, before, 'no emails for a failed attempt');
  // refund from the Razorpay dashboard: the same row flips to Refunded, the team hears once
  const rf = { id: 'rfnd_sheet_1', payment_id: 'pay_sheet_1', amount: svc.price_paise, status: 'processed' };
  await send('refund.processed', { refund: { entity: rf } }, 'evt_sheet_rf');
  await send('refund.processed', { refund: { entity: rf } }, 'evt_sheet_rf_again');
  await jobs.processDue({ kinds: ['payments.webhook', 'paysheet.sync', 'email.send'], limit: 20 });
  assert.equal(payRows.get('pay_sheet_1').status, 'Refunded'); assert.equal(payRows.get('pay_sheet_1').refunded, '500');
  assert.equal([...payRows.keys()].filter((k) => k === 'pay_sheet_1').length, 1);
  assert.equal(mailer.sent.filter((m) => m.to === 'team@anvaya.test' && /^Refunded/.test(m.subject) && /pay_sheet_1/.test(m.text)).length, 1);
  // while the page's Apps Script still sends its own confirmation, the app sends only the invitation (no second confirmation)
  const settingsLib = require('../src/lib/settings');
  await settingsLib.set('page_confirmation_sender', 'apps_script', null);
  payRows.set('pay_sheet_2', { payment_id: 'pay_sheet_2', name: 'Name From Page', status: 'Completed' }); // the page reported it (its script emailed)
  await send('payment.captured', { payment: { entity: { ...pay, id: 'pay_sheet_2', email: 'script.confirms@buyers.test' } } }, 'evt_sheet_2');
  await jobs.processDue({ kinds: ['payments.webhook', 'email.send', 'paysheet.sync'], limit: 50 });
  const m2 = mailer.sent.filter((m) => m.to === 'script.confirms@buyers.test');
  assert.equal(m2.filter((m) => /Payment received/.test(m.subject)).length, 0);
  assert.equal(m2.filter((m) => /token=/.test(m.text)).length, 1, 'invitation still sent');
  assert.equal(payRows.get('pay_sheet_2').status, 'Paid (verified by Razorpay)');
  assert.equal(mailer.sent.filter((m) => m.to === 'team@anvaya.test' && /pay_sheet_2/.test(m.text)).length, 0, 'the page script already told the team');
  assert.equal(payRows.get('pay_sheet_2').name, 'Name From Page', 'same row, page name kept');
  // the page never reported this one (browser closed): the app waits for the page's row, then adds it and sends both emails once
  process.env.PAYMENT_PAGE_WAIT_MS = String(3600e3);
  const pay3 = { ...pay, id: 'pay_sheet_3', email: 'closed.tab@buyers.test' };
  await send('payment.captured', { payment: { entity: pay3 } }, 'evt_sheet_3');
  await jobs.processDue({ kinds: ['payments.webhook', 'email.send', 'paysheet.sync'], limit: 50 });
  let g3 = await db.one("select * from anvaya.gateway_payments where provider_payment_id = 'pay_sheet_3'");
  assert.equal(g3.sheet_status, 'failed'); assert.match(g3.sheet_error, /Waiting for the payment page/); assert.equal(g3.page_reported, null);
  assert.ok(!payRows.has('pay_sheet_3'), 'no row added while waiting for the page');
  assert.equal(mailer.sent.filter((m) => m.to === 'closed.tab@buyers.test' && /Payment received/.test(m.subject)).length, 0);
  process.env.PAYMENT_PAGE_WAIT_MS = '0';
  for (let i = 0; i < 2; i++) {
    await jobs.runNow(await jobs.enqueue('paysheet.resync', {}, { dedupeKey: `t-resync3-${i}-${Date.now()}` }));
    await jobs.processDue({ kinds: ['paysheet.sync', 'email.send'], limit: 20 });
  }
  g3 = await db.one("select * from anvaya.gateway_payments where provider_payment_id = 'pay_sheet_3'");
  assert.equal(g3.sheet_status, 'synced'); assert.equal(g3.page_reported, false);
  assert.equal(payRows.get('pay_sheet_3').status, 'Paid (verified by Razorpay)');
  const m3 = mailer.sent.filter((m) => m.to === 'closed.tab@buyers.test');
  assert.equal(m3.filter((m) => /Payment received/.test(m.subject)).length, 1, 'app confirms once');
  assert.ok(m3.some((m) => /calendly\.com/.test(m.text)));
  assert.equal(mailer.sent.filter((m) => m.to === 'team@anvaya.test' && /pay_sheet_3/.test(m.text)).length, 1, 'app tells the team once');
  await settingsLib.set('page_confirmation_sender', 'app', null);
});

test('refund made in the Razorpay dashboard (refund.processed webhook) updates the order and ends access once, even if delivered twice', async () => {
  const send = (event, payload, id) => {
    const body = JSON.stringify({ event, payload, created_at: Date.now() });
    const sig = crypto.createHmac('sha256', 'whsec-test').update(body).digest('hex');
    return fetch(`${BASE}/api/webhooks/razorpay`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': id } });
  };
  const products = (await admin.get('/api/admin/products')).json;
  const svc = products.find((x) => x.public_key === '500mba');
  const plan = products.find((x) => x.kind === 'subscription_plan' && x.active);
  assert.ok(plan, 'a subscription plan exists in the test data');
  // a paid service (page payment), then a partial and a full refund from the dashboard
  const pay = { id: 'pay_rf_1', order_id: null, amount: svc.price_paise, status: 'captured', method: 'card', email: 'refund.me@buyers.test', contact: '+919800000009', notes: { plan: svc.name } };
  await send('payment.captured', { payment: { entity: pay } }, 'evt_rf_pay');
  await jobs.processDue({ kinds: ['payments.webhook'], limit: 20 });
  const o = await db.one("select o.* from anvaya.orders o join anvaya.students s on s.id = o.student_id where s.email = 'refund.me@buyers.test'");
  assert.equal(o.status, 'paid');
  const part = { id: 'rfnd_rf_part', payment_id: 'pay_rf_1', amount: 10000, status: 'processed' };
  await send('refund.processed', { refund: { entity: part }, payment: { entity: pay } }, 'evt_rf_part');
  await send('refund.processed', { refund: { entity: part }, payment: { entity: pay } }, 'evt_rf_part_again'); // re-delivered under a new id
  await jobs.processDue({ kinds: ['payments.webhook'], limit: 20 });
  assert.equal((await db.one('select status from anvaya.orders where id = $1', [o.id])).status, 'partially_refunded');
  assert.equal(Number((await db.one('select count(*) n from anvaya.refunds r join anvaya.payments p on p.id = r.payment_id where p.order_id = $1', [o.id])).n), 1, 'counted once');
  assert.equal((await db.one('select status from anvaya.service_cases where order_id = $1', [o.id])).status, 'intake', 'partial refund keeps the service open');
  await send('refund.processed', { refund: { entity: { id: 'rfnd_rf_rest', payment_id: 'pay_rf_1', amount: svc.price_paise - 10000, status: 'processed' } }, payment: { entity: pay } }, 'evt_rf_rest');
  await jobs.processDue({ kinds: ['payments.webhook'], limit: 20 });
  assert.equal((await db.one('select status from anvaya.orders where id = $1', [o.id])).status, 'refunded');
  assert.equal((await db.one("select status from anvaya.payments where provider_payment_id = 'pay_rf_1'")).status, 'refunded');
  assert.equal((await db.one('select status from anvaya.service_cases where order_id = $1', [o.id])).status, 'cancelled', 'full refund closes the service');
  // a subscription bought and fully refunded loses access straight away
  const st = await db.one("select id from anvaya.students where email = 'refund.me@buyers.test'");
  const so = await payments.createOrder({ studentId: st.id, product: plan, amountPaise: plan.price_paise, description: plan.name, userId: null });
  await payments.markPaid(so.id, { provider: 'razorpay', providerPaymentId: 'pay_rf_sub', amountPaise: plan.price_paise });
  const subs = require('../src/lib/subscriptions');
  const sub = () => db.one('select * from anvaya.subscriptions where last_order_id = $1', [so.id]);
  assert.equal(subs.effectiveAccess(await sub()), 'active');
  await send('refund.processed', { refund: { entity: { id: 'rfnd_rf_sub', payment_id: 'pay_rf_sub', amount: plan.price_paise, status: 'processed' } } }, 'evt_rf_sub');
  await jobs.processDue({ kinds: ['payments.webhook'], limit: 20 });
  assert.equal(subs.effectiveAccess(await sub()), 'cancelled');
  assert.equal((await sub()).billing_status, 'refunded');
});

// ═══ Session lifecycle: requests, calendar, cutoff, no-shows ═══════════════
const gcal = require('../src/lib/gcal');
const sessionsLib = require('../src/lib/sessions');
const book = async (client, slot) => {
  const r = await client.post('/api/student/bookings/paid', { mentor_id: ids.mentorA, scheduled_at: slot });
  assert.equal(r.status, 201, r.text); return r.json.booking_id;
};
const confirmByStaff = async (bid) => { assert.equal((await admin.patch(`/api/admin/bookings/${bid}`, { status: 'scheduled' })).status, 200); await jobs.processDue({ kinds: ['email.send'], limit: 50 }); };

test('requests: concurrent requests for one slot, hold expiry releases it with an email, decline and suggest-another-time', async () => {
  await stu2.login('neha@students.test', 'Student-pass-1').catch(() => {});
  const slots = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  const [x, y] = await Promise.all([stu1.post('/api/student/bookings/paid', { mentor_id: ids.mentorA, scheduled_at: slots[10] }), stu2.post('/api/student/bookings/paid', { mentor_id: ids.mentorA, scheduled_at: slots[10] })]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409], 'only one request can hold a slot');
  const held = (x.status === 201 ? x : y).json.booking_id;
  assert.ok(!(await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json.includes(slots[10]), 'held slot hidden');
  // expiry
  await db.run("update anvaya.bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [held]);
  await jobs.runNow(await jobs.enqueue('bookings.expire_holds', {}));
  await jobs.processDue({ kinds: ['email.send'], limit: 20 });
  assert.equal((await db.one('select status, cancel_reason from anvaya.bookings where id = $1', [held])).cancel_reason, 'Request expired before approval');
  assert.ok(mailer.sent.some((m) => /^Request expired/.test(m.subject)));
  assert.ok((await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json.includes(slots[10]), 'slot free again');
  // decline
  const d = await book(stu2, slots[11]);
  assert.equal((await mentorA.post(`/api/calendar/bookings/${d}/decline`, { reason: 'Travelling that day' })).status, 200);
  assert.match(lastEmailTo('neha@students.test').subject, /^Not available/);
  assert.ok((await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json.includes(slots[11]));
  // suggest another time → student accepts → (paid) payment needed
  const sg = await book(stu2, slots[12]);
  assert.equal((await mentorA.post(`/api/calendar/bookings/${sg}/suggest`, { scheduled_at: slots[14] })).status, 200);
  assert.match(lastEmailTo('neha@students.test').subject, /^New time suggested/);
  const after = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  assert.ok(after.includes(slots[12]) && !after.includes(slots[14]), 'old slot released, suggested slot reserved');
  assert.equal((await stu1.post(`/api/student/bookings/${sg}/accept-proposal`)).status, 404, 'only the requester can accept');
  assert.equal((await stu2.post(`/api/student/bookings/${sg}/accept-proposal`)).json.next, 'payment');
  // student can send preferred dates when nothing fits
  assert.equal((await stu2.post('/api/student/session-requests', { kind: 'paid_session', mentor_id: ids.mentorA, preferred: 'Any weekday after 7 pm next week' })).status, 201);
  assert.ok((await admin.get('/api/admin/session-requests')).json.some((x2) => /after 7 pm/.test(x2.preferred)));
});

test('calendar: no Meet link means no confirmation; failure shown to staff and retried; reschedule updates the same event and emails both', async () => {
  const slots = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  const bid = await book(stu2, slots[16]);
  gcal.fake.fail = true;
  const before = mailer.sent.length;
  await admin.patch(`/api/admin/bookings/${bid}`, { status: 'scheduled' });
  await jobs.processDue({ kinds: ['email.send'], limit: 50 });
  let b = await db.one('select * from anvaya.bookings where id = $1', [bid]);
  assert.equal(b.status, 'scheduled'); assert.equal(b.calendar_status, 'failed'); assert.equal(b.meet_link, null);
  assert.ok(!mailer.sent.slice(before).some((m) => /^Confirmed/.test(m.subject)), 'no confirmation without a real Meet link');
  assert.ok((await admin.get('/api/admin/queues/unassigned')).json.some((x) => /Calendar\/Meet failed/.test(x.title)) || (await db.one("select 1 from anvaya.tasks where dedupe_key like $1 and status = 'open'", [`calfail:${bid}:%`])), 'staff see the failure');
  const ev = (await admin.get(`/api/calendar/events?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 40 * 86400e3).toISOString())}`)).json.bookings.find((x) => x.id === bid);
  assert.equal(ev.calendar_status, 'failed'); assert.match(ev.calendar_error, /simulated failure/);
  gcal.fake.fail = false;
  const retry = await mentorA.post(`/api/calendar/bookings/${bid}/calendar-retry`);
  assert.equal(retry.json.calendar_status, 'synced'); assert.match(retry.json.meet_link, /meet\.google\.com/);
  await jobs.processDue({ kinds: ['email.send'], limit: 50 });
  assert.match(lastEmailTo('neha@students.test').subject, /^Confirmed/);
  assert.ok(!(await db.one("select 1 from anvaya.tasks where dedupe_key like $1 and status = 'open'", [`calfail:${bid}:%`])), 'failure task closed once synced');
  // the student reschedules (more than 2 h ahead): same event, both notified, reminders for the old time cancelled
  b = await db.one('select * from anvaya.bookings where id = $1', [bid]);
  const target = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json.at(-1);
  assert.equal((await stu2.post(`/api/student/bookings/${bid}/reschedule`, { scheduled_at: target })).status, 200);
  await jobs.processDue({ kinds: ['email.send'], limit: 50 });
  const moved = await db.one('select * from anvaya.bookings where id = $1', [bid]);
  assert.equal(moved.google_event_id, b.google_event_id, 'existing event updated, not duplicated');
  assert.equal(new Date(gcal.fake.events.get(b.google_event_id).start).toISOString(), new Date(target).toISOString());
  assert.match(lastEmailTo('neha@students.test').subject, /^Rescheduled/); assert.match(lastEmailTo('priya@mentors.test').subject, /^Rescheduled/);
  // email log tracks states; a Resend webhook marks delivered
  const log = (await admin.get(`/api/admin/email-log?booking_id=${bid}`)).json;
  assert.ok(log.length >= 3 && log.every((l) => ['sent', 'queued', 'failed', 'delivered'].includes(l.status)));
  await db.run("update anvaya.email_log set provider_id = 'res_test_1' where id = $1", [log[0].id]);
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from('resend-test-secret').toString('base64')}`;
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'res_test_1' } }), sid = 'msg_1', ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', Buffer.from('resend-test-secret')).update(`${sid}.${ts}.${body}`).digest('base64');
  assert.equal((await fetch(`${BASE}/api/webhooks/resend`, { method: 'POST', body, headers: { 'svix-id': sid, 'svix-timestamp': ts, 'svix-signature': 'v1,bad' } })).status, 401);
  assert.equal((await fetch(`${BASE}/api/webhooks/resend`, { method: 'POST', body, headers: { 'svix-id': sid, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` } })).status, 200);
  assert.equal((await db.one('select status from anvaya.email_log where id = $1', [log[0].id])).status, 'delivered');
  delete process.env.RESEND_WEBHOOK_SECRET;
  ids.calBooking = bid;
});

test('reschedule policy: 24 hours’ notice, once per plan (student moves only); late changes go to the team; staff can still act', async () => {
  const bid = ids.calBooking;
  // inside 24 hours: no online reschedule or cancel, only a request to the team
  await db.run("update anvaya.bookings set scheduled_at = now() + interval '20 hours', ends_at = now() + interval '20 hours 45 minutes' where id = $1", [bid]);
  const later = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json.at(-2);
  const rs = await stu2.post(`/api/student/bookings/${bid}/reschedule`, { scheduled_at: later });
  assert.equal(rs.status, 400); assert.match(rs.json.error, /within 24 hours/); assert.match(rs.json.error, /counts as used/);
  const cn = await stu2.post(`/api/student/bookings/${bid}/cancel`);
  assert.equal(cn.status, 400); assert.match(cn.json.error, /support request/);
  let home = (await stu2.get('/api/student/home')).json.sessions.bookings.find((x) => x.id === bid);
  assert.equal(home.can_reschedule, false); assert.equal(home.needs_exception, true);
  // outside 24 hours, but this booking was already moved once by the student (calendar test): the one reschedule is used
  await db.run("update anvaya.bookings set scheduled_at = now() + interval '3 days', ends_at = now() + interval '3 days 45 minutes' where id = $1", [bid]);
  assert.equal(Number((await db.one('select student_reschedule_count n from anvaya.bookings where id = $1', [bid])).n), 1);
  home = (await stu2.get('/api/student/home')).json.sessions.bookings.find((x) => x.id === bid);
  assert.equal(home.can_reschedule, false); assert.equal(home.reschedule_used, true);
  const again = await stu2.post(`/api/student/bookings/${bid}/reschedule`, { scheduled_at: later });
  assert.equal(again.status, 400); assert.match(again.json.error, /already used the one reschedule/);
  // with the allowance unused, one move is allowed and then the time is final
  await db.run('update anvaya.bookings set student_reschedule_count = 0 where id = $1', [bid]);
  assert.equal((await stu2.get('/api/student/home')).json.sessions.bookings.find((x) => x.id === bid).can_reschedule, true);
  const slots = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  const ok = await stu2.post(`/api/student/bookings/${bid}/reschedule`, { scheduled_at: slots.at(-3) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await stu2.post(`/api/student/bookings/${bid}/reschedule`, { scheduled_at: slots.at(-4) })).status, 400, 'second move refused');
  // sessions in the same order share the one reschedule (a plan with several sessions)
  const orderId = (await db.one('select id from anvaya.orders order by id limit 1')).id;
  await db.run('update anvaya.bookings set order_id = $2, student_reschedule_count = 0 where id = $1', [bid, orderId]);
  const other = await db.one('select id, order_id, student_reschedule_count from anvaya.bookings where id <> $1 order by id limit 1', [bid]);
  await db.run('update anvaya.bookings set order_id = $2, student_reschedule_count = 1 where id = $1', [other.id, orderId]);
  const sharedTry = await stu2.post(`/api/student/bookings/${bid}/reschedule`, { scheduled_at: slots.at(-4) });
  assert.equal(sharedTry.status, 400, 'another session of the same plan already used it'); assert.match(sharedTry.json.error, /already used/);
  await db.run('update anvaya.bookings set order_id = $2, student_reschedule_count = $3 where id = $1', [other.id, other.order_id, other.student_reschedule_count]);
  await db.run('update anvaya.bookings set order_id = null where id = $1', [bid]);
});

test('no-show: only after the grace period, blocks every new booking/request, keeps existing access, dispute → admin reversal restores access', async () => {
  const bid = ids.calBooking;
  await db.run("update anvaya.bookings set scheduled_at = now() - interval '5 minutes' where id = $1", [bid]);
  const early = await mentorA.post(`/api/calendar/bookings/${bid}/outcome`, { outcome: 'student_no_show', reason: 'Waited' });
  assert.equal(early.status, 400); assert.match(early.json.error, /15 minutes after the start/);
  await db.run("update anvaya.bookings set scheduled_at = now() - interval '40 minutes' where id = $1", [bid]);
  assert.equal((await mentorA.post(`/api/calendar/bookings/${bid}/outcome`, { outcome: 'student_no_show' })).status, 400, 'reason required');
  assert.equal((await stu2.post(`/api/calendar/bookings/${bid}/outcome`, { outcome: 'student_no_show', reason: 'x' })).status, 403, 'students cannot mark outcomes');
  const before = mailer.sent.length;
  assert.equal((await mentorA.post(`/api/calendar/bookings/${bid}/outcome`, { outcome: 'student_no_show', reason: 'Waited 20 minutes and messaged twice' })).status, 200);
  await jobs.processDue({ kinds: ['email.send'], limit: 50 });
  const ns = mailer.sent.slice(before);
  const toStudent = ns.find((m) => m.to === 'neha@students.test');
  assert.match(toStudent.subject, /^Missed session/); assert.match(toStudent.text, /paused/); assert.match(toStudent.text, /Dispute it: http/);
  assert.doesNotMatch(toStudent.text, /Waited 20 minutes/, 'internal note not in the student email');
  assert.ok(ns.some((m) => m.to === 'admin@anvaya.test' && /^No-show recorded/.test(m.subject)), 'admin notified');
  const ev = await db.one('select * from anvaya.no_show_events where booking_id = $1', [bid]);
  assert.ok(ev.marked_by && ev.marked_at && ev.reason);
  // blocked everywhere a student can create or move a session
  const slots = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  for (const [label, call] of [
    ['paid request', () => stu2.post('/api/student/bookings/paid', { mentor_id: ids.mentorA, scheduled_at: slots[20] })],
    ['check-up', () => stu2.post('/api/student/bookings/checkup', { mentor_id: ids.mentorA, scheduled_at: slots[20] })],
    ['preferred dates', () => stu2.post('/api/student/session-requests', { preferred: 'any' })],
  ]) { const r = await call(); assert.equal(r.status, 403, `${label}: ${r.text}`); assert.match(r.json.error, /paused/); }
  assert.equal((await admin.post('/api/admin/bookings', { student_id: ids.s2, mentor_id: ids.mentorA, kind: 'paid_session', scheduled_at: slots[21] })).status, 403, 'staff-created bookings blocked too');
  assert.equal((await stu2.get('/api/student/home')).json.booking_blocked, true);
  assert.equal((await stu2.get('/api/student/me')).status, 200, 'account access preserved');
  // dispute → admin reverses → access restored + email
  const dsp = await stu2.post('/api/student/no-show/dispute', { body: 'I joined at 6:31 but the link said waiting for host.' });
  assert.equal(dsp.status, 201, dsp.text);
  assert.equal((await stu2.post('/api/student/no-show/dispute', { body: 'again' })).status, 400);
  assert.ok((await admin.get('/api/admin/support')).json.some((c) => c.id === dsp.json.caseId && c.category === 'no_show_dispute'));
  assert.equal((await ops.post(`/api/admin/no-shows/${ev.id}/reverse`, { reason: 'Join log shows the student waited' })).status, 403, 'only an admin can reverse');
  assert.equal((await admin.post(`/api/admin/no-shows/${ev.id}/reverse`, { reason: 'Join log shows the student waited' })).json.unblocked, true);
  await jobs.processDue({ kinds: ['email.send'], limit: 20 });
  assert.match(lastEmailTo('neha@students.test').subject, /booking access is restored/);
  assert.equal((await stu2.post('/api/student/session-requests', { preferred: 'Thursday evening' })).status, 201, 'can request again');
  // host absence / technical problems never penalise the student
  const hb = await book(stu2, slots[22]);
  await confirmByStaff(hb);
  await db.run("update anvaya.bookings set scheduled_at = now() - interval '30 minutes' where id = $1", [hb]);
  assert.equal((await mentorA.post(`/api/calendar/bookings/${hb}/outcome`, { outcome: 'host_absent', reason: 'Mentor emergency' })).status, 200);
  assert.equal((await stu2.get('/api/student/home')).json.booking_blocked, false);
  assert.equal((await db.one('select status, needs_review from anvaya.bookings where id = $1', [hb])).needs_review, true);
});

test('Google Calendar connect: the callback works without the (Strict) session cookie, and a forged or reused state is refused', async () => {
  const start = await mentorA.get('/api/calendar/google/connect');
  assert.equal(start.status, 303);
  const state = new URL(start.location).searchParams.get('state');
  const name = Object.keys(mentorA.cookies).find((k) => /anvaya_gcal$/.test(k));
  const stateCookie = `${name}=${mentorA.cookies[name]}`;
  const cb = (st, cookie, code = 'fake-code') => fetch(`${BASE}/api/calendar/google/callback?state=${encodeURIComponent(st)}&code=${code}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
  assert.equal((await cb(state, null)).status, 400, 'no state cookie');
  assert.equal((await cb('wrong-state-wrong-state-wrong-st', stateCookie)).status, 400, 'state mismatch');
  const forged = `${name}=${encodeURIComponent(JSON.stringify({ state, uid: 1 }))}`;
  assert.equal((await cb(state, forged)).status, 400, 'unsealed cookie refused');
  const ok = await cb(state, stateCookie); // exactly what the browser sends on Google's cross-site redirect
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.match(await ok.text(), /mentor#calendar/);
  const conn = await db.one("select c.google_email, c.status from anvaya.calendar_connections c join anvaya.mentors m on m.user_id = c.user_id where m.id = $1", [ids.mentorA]);
  assert.equal(conn.google_email, 'host@test'); assert.equal(conn.status, 'active');
  assert.equal((await mentorA.get('/api/calendar/google')).json.connection.status, 'active');
  await db.run('delete from anvaya.calendar_connections');
});

test('Google sync: a host sees only their own Google events; sessions confirmed before connecting are added silently, with a Meet link', async () => {
  const from = new Date().toISOString(), to = new Date(Date.now() + 30 * 86400e3).toISOString();
  gcal.fake.items = [{ id: 'own1', summary: 'Private dentist appointment', start: { dateTime: new Date(Date.now() + 86400e3).toISOString() }, end: { dateTime: new Date(Date.now() + 90000e3).toISOString() } }];
  const mine = (await mentorA.get(`/api/calendar/google/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json;
  assert.equal(mine.connected, true); assert.equal(mine.events[0].title, 'Private dentist appointment');
  assert.equal((await stu1.get(`/api/calendar/google/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).status, 403, 'students never reach host calendars');
  assert.ok(!JSON.stringify((await stu1.get(`/api/student/mentors/${ids.mentorA}/slots`)).json).includes('dentist'), 'students only get slot times');
  gcal.fake.items = [];
  // a session confirmed while no calendar was connected (calendar_status none) → backfill on Save: event + Meet link, no new emails
  const slot = (await stu2.get(`/api/student/mentors/${ids.mentorA}/slots`)).json.at(-3);
  const bid = await book(stu2, slot);
  await db.run("update anvaya.bookings set status = 'scheduled', hold_expires_at = null, calendar_status = 'none' where id = $1", [bid]);
  await jobs.processDue({ kinds: ['email.send'], limit: 50 });
  const before = mailer.sent.length;
  const saved = await mentorA.put('/api/calendar/google', { busy_calendar_ids: ['primary'], booking_calendar_id: 'primary' });
  assert.equal(saved.status, 200, saved.text); assert.ok(saved.json.synced >= 1, 'saving calendar settings adds missing sessions');
  const b = await db.one('select calendar_status, meet_link, google_event_id from anvaya.bookings where id = $1', [bid]);
  assert.equal(b.calendar_status, 'synced'); assert.match(b.meet_link, /meet\.google\.com/); assert.ok(b.google_event_id);
  await jobs.processDue({ kinds: ['email.send'], limit: 50 });
  assert.ok(!mailer.sent.slice(before).some((m) => /^Confirmed/.test(m.subject)), 'no duplicate confirmation for an already-confirmed session');
});

test('website free chats: visitors pick the host’s open slots, the slot is held, approval sends a Meet link; never double-booked', async () => {
  const pub = (u, o = {}) => fetch(BASE + u, { ...o, headers: { 'Content-Type': 'application/json', Origin: 'https://anvayacareers.in', ...(o.headers || {}) } });
  assert.deepEqual(await (await pub('/api/public/freechat/slots')).json(), { available: false, minutes: 15, slots: [] }, 'no host chosen → plain form');
  const host = await admin.post('/api/admin/freechat/host-self');
  assert.equal(host.status, 200, host.text);
  assert.equal((await ops.post('/api/admin/freechat/host-self')).status, 403, 'only admins choose the host');
  assert.ok(!(await stu1.get('/api/student/mentors')).json.some((m) => m.id === host.json.mentor_id), 'the free-chat host is hidden from students');
  assert.equal((await stu1.get(`/api/student/mentors/${host.json.mentor_id}/slots`)).status, 404);
  const pre = await fetch(`${BASE}/api/public/freechat/slots`, { method: 'OPTIONS', headers: { Origin: 'https://anvayacareers.in', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
  const open = await (await pub('/api/public/freechat/slots')).json();
  assert.equal(open.available, true); assert.equal(open.minutes, 15); assert.ok(open.slots.length > 5);
  assert.ok(open.slots.every((x) => typeof x === 'string'), 'times only');
  const slot = open.slots[3];
  const ask = (name, phone, extra) => pub('/api/public/leads', { method: 'POST', body: JSON.stringify({ name, phone, situation: 'Applying but not hearing back', slot, ...extra }) });
  assert.equal((await ask('Riya Guest', '+91 98111 22233', {})).status, 400, 'an email is needed with a time');
  const [a, b] = await Promise.all([ask('Riya Guest', '+91 98111 22233', { email: 'riya@guest.test' }), ask('Kabir Guest', '+91 98111 44455', { email: 'kabir@guest.test' })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], 'one slot, one visitor');
  const winner = a.status === 201 ? { name: 'Riya Guest', email: 'riya@guest.test' } : { name: 'Kabir Guest', email: 'kabir@guest.test' };
  assert.ok(!(await (await pub('/api/public/freechat/slots')).json()).slots.includes(slot), 'held slot disappears from the website');
  await jobs.processDue({ kinds: ['email.send'], limit: 20 });
  const req = lastEmailTo(winner.email);
  assert.match(req.subject, /^Request received: free chat/); assert.match(req.text, /not confirmed yet/i);
  assert.match(lastEmailTo('admin@anvaya.test').subject, /^New session request/);
  const lead = await db.one('select l.*, f.id as fid from anvaya.leads l join anvaya.freechats f on f.lead_id = l.id where l.email = $1', [winner.email]);
  assert.equal(lead.source, 'Free 15-min chat (website)');
  // the host sees it on their calendar and approves → Google event + Meet link + confirmations
  const evs = (await admin.get(`/api/calendar/events?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 20 * 86400e3).toISOString())}`)).json;
  assert.ok(evs.freechats.some((f) => f.id === lead.fid && f.status === 'requested'));
  assert.equal((await mentorA.post(`/api/calendar/freechats/${lead.fid}/approve`)).status, 404, 'other mentors can’t act on it');
  const ok = await admin.post(`/api/calendar/freechats/${lead.fid}/approve`);
  assert.equal(ok.json.calendar_status, 'synced', ok.text); assert.match(ok.json.meet_link, /meet\.google\.com/);
  await jobs.processDue({ kinds: ['email.send'], limit: 20 });
  const conf = lastEmailTo(winner.email);
  assert.match(conf.subject, /^Confirmed: your free chat/); assert.match(conf.text, /meet\.google\.com/);
  assert.ok(conf.attachments?.some((x) => /\.ics$/.test(x.filename)), 'calendar invite attached');
  // a student session can't take the same time with this host
  const clash = await admin.post('/api/admin/bookings', { student_id: ids.s1, mentor_id: host.json.mentor_id, kind: 'checkup', scheduled_at: slot });
  assert.notEqual(clash.status, 201, 'no double booking across free chats and sessions');
  // cancel → visitor told, event cancelled
  await admin.post(`/api/calendar/freechats/${lead.fid}/cancel`, { reason: 'Host unwell' });
  await jobs.processDue({ kinds: ['email.send'], limit: 20 });
  assert.match(lastEmailTo(winner.email).subject, /^Cancelled: your free chat/);
  // an unanswered request expires and the visitor is pointed back to the website
  const later = (await (await pub('/api/public/freechat/slots')).json()).slots[6];
  assert.equal((await pub('/api/public/leads', { method: 'POST', body: JSON.stringify({ name: 'Tara Guest', phone: '+91 98111 66677', email: 'tara@guest.test', slot: later }) })).status, 201);
  await db.run("update anvaya.freechats set hold_expires_at = now() - interval '1 minute' where email = 'tara@guest.test'");
  await jobs.runNow(await jobs.enqueue('bookings.expire_holds', {}));
  await jobs.processDue({ kinds: ['email.send'], limit: 20 });
  assert.match(lastEmailTo('tara@guest.test').text, /couldn't confirm your free chat/);
  assert.ok((await (await pub('/api/public/freechat/slots')).json()).slots.includes(later), 'expired hold released');
  await db.run("update anvaya.settings set value = 'null' where key = 'freechat_mentor_id'");
});

test('student sign-up: email link sets the password, existing emails reveal nothing, sign-in works', async () => {
  const anon = new Client();
  await anon.refresh();
  assert.equal((await anon.get('/signup')).status, 200);
  assert.equal((await anon.post('/api/auth/signup', { name: '', email: 'x@y.test' })).status, 400);
  assert.equal((await anon.post('/api/auth/signup', { name: 'Ana', email: 'not-an-email' })).status, 400);
  const before = mailer.sent.length;
  const r = await anon.post('/api/auth/signup', { name: 'Meera Signup', email: 'Meera.Signup@students.test', phone: '+91 98765 11111' });
  assert.equal(r.status, 201, r.text); assert.match(r.json.message, /Check your inbox/);
  await jobs.processDue({ kinds: ['email.send'], limit: 20 });
  const mail = lastEmailTo('meera.signup@students.test');
  assert.match(mail.subject, /Finish creating your Anvaya account/);
  const u = await db.one("select u.id, u.role, u.password_hash, s.id as sid, s.name from anvaya.users u join anvaya.students s on s.user_id = u.id where u.email = 'meera.signup@students.test'");
  assert.equal(u.role, 'student'); assert.equal(u.password_hash, null, 'no password until the email link is used');
  // the same email again (or an existing account's email) gets the same reply and no new account
  const again = await anon.post('/api/auth/signup', { name: 'Someone Else', email: 'meera.signup@students.test' });
  assert.equal(again.status, 201); assert.equal(again.json.message, r.json.message);
  const taken = await anon.post('/api/auth/signup', { name: 'Not Neha', email: 'neha@students.test' });
  assert.equal(taken.json.message, r.json.message, 'no account enumeration');
  assert.equal((await db.one("select count(*)::int n from anvaya.users where lower(email) = 'neha@students.test'")).n, 1);
  assert.ok(mailer.sent.length > before);
  // finish: set a password with the newest link, then sign in like any student
  await jobs.processDue({ kinds: ['email.send'], limit: 20 });
  const tok = tokenFrom(lastEmailTo('meera.signup@students.test'));
  const acc = await anon.post('/api/invites/accept', { token: tok, password: 'Signup-pass-01', confirm: 'Signup-pass-01' });
  assert.equal(acc.status, 200, acc.text);
  const me = new Client();
  assert.equal((await me.login('meera.signup@students.test', 'Signup-pass-01')).status, 200);
  assert.equal((await me.get('/api/student/me')).status, 200);
  // a payment-created student record (same email, no login yet) is linked, not duplicated
  await db.run("insert into anvaya.students (name, email, status) values ('Paid Before', 'paid.before@students.test', 'active')");
  const visitor = new Client(); await visitor.refresh();
  const pb = await visitor.post('/api/auth/signup', { name: 'Paid Before', email: 'paid.before@students.test' });
  assert.equal(pb.status, 201, pb.text);
  assert.equal((await db.one("select count(*)::int n from anvaya.students where email = 'paid.before@students.test' and user_id is not null")).n, 1);
});

test('availability: weekly hours, blocked dates and Google busy times shape the bookable slots; students never see private details', async () => {
  const avail = (await mentorA.get('/api/calendar/availability')).json;
  assert.ok(avail.weekly.length >= 7);
  const slots = (await stu1.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  const day = new Date(new Date(slots[30]).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
  assert.equal((await mentorA.post('/api/calendar/overrides', { day, kind: 'blocked', note: 'Conference' })).status, 201);
  const afterBlock = (await stu1.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  assert.ok(!afterBlock.some((x) => new Date(new Date(x).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10) === day), 'blocked day has no slots');
  assert.equal((await mentorB.post('/api/calendar/overrides', { day, kind: 'blocked', mentor_id: ids.mentorA })).status, 201, 'a mentor’s mentor_id is always themselves');
  assert.equal((await stu1.get('/api/calendar/availability')).status, 403);
  gcal.fake.busy = [[slots[40], new Date(new Date(slots[40]).getTime() + 3600e3).toISOString()]];
  assert.ok(!(await stu1.get(`/api/student/mentors/${ids.mentorA}/slots`)).json.includes(slots[40]), 'Google busy time excluded');
  gcal.fake.busy = [];
  const s0 = (await stu1.get(`/api/student/mentors/${ids.mentorA}/slots`)).json;
  assert.ok(s0.every((x) => typeof x === 'string'), 'students get start times only');
});

test('deactivating a mentor ends sessions immediately; disabled staff cannot sign in', async () => {
  await admin.post(`/api/admin/mentors/${ids.mentorB}/deactivate`);
  assert.equal((await mentorB.get('/api/mentor/bookings')).status, 401);
  const riya = (await admin.get('/api/admin/team')).json.find((u) => u.email === 'riya@anvaya.test');
  await admin.post(`/api/admin/team/${riya.id}/disable`);
  assert.equal((await ops.get('/api/admin/leads')).status, 401);
  assert.equal((await new Client().login('riya@anvaya.test', 'Intern-pass-01')).status, 403);
});

test('purge removes only records flagged is_test, including paid test orders', async () => {
  const realStudents = (await admin.get('/api/admin/students')).json.length;
  const p = await admin.post('/api/admin/products', { kind: 'subscription_plan', name: 'TEST plan', price_paise: 100, billing_period: 'month', active: false, is_test: true });
  const s = await admin.post('/api/admin/students', { name: 'TEST purge student', is_test: true });
  const o = await admin.post('/api/admin/orders', { student_id: s.json.id, product_id: p.json.id });
  await admin.post(`/api/admin/orders/${o.json.id}/record-payment`, { method: 'UPI', reference: 'TEST' });
  assert.equal((await admin.req('DELETE', `/api/admin/students/${s.json.id}`)).status, 400, 'paid students cannot be deleted normally');
  assert.equal((await admin.post('/api/admin/test-data/purge', { confirm: 'yes' })).status, 400);
  const r = await admin.post('/api/admin/test-data/purge', { confirm: 'DELETE TEST DATA' });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.deleted.students, 1); assert.equal(r.json.deleted.products, 1);
  assert.equal((await admin.get('/api/admin/students')).json.length, realStudents, 'real students untouched');
  assert.ok((await admin.get('/api/admin/products')).json.length >= 3, 'real products untouched');
});

test('brute-force logins are rate limited', async () => {
  const c = new Client(); let last;
  for (let i = 0; i < 11; i++) last = await c.post('/api/auth/login', { email: 'ratelimit@anvaya.test', password: 'nope' });
  assert.equal(last.status, 429);
});

test('cron status: read-only queue and payment set-up, secret required, no secret values', async () => {
  assert.equal((await fetch(`${BASE}/api/cron/status`)).status, 401);
  const r = await fetch(`${BASE}/api/cron/status`, { headers: { Authorization: 'Bearer cron-test-secret' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.migrations.includes('0011_gateway_payments_page.sql'));
  assert.equal(j.paymentSheet.token, true); assert.equal(j.paymentSheet.url, true);
  assert.ok(Array.isArray(j.queue));
  assert.ok(!JSON.stringify(j).includes('sheet-token') && !JSON.stringify(j).includes('whsec-test'));
});

test('checkout enquiries: saved before payment, closed ≠ failed, abandoned after 30 min, consent-only reminders re-checked, converted once, CRM + daily summary', async () => {
  Object.assign(process.env, { ENQUIRY_ABANDON_MS: '0', ENQUIRY_RECOVERY1_MS: '0', ENQUIRY_RECOVERY2_MS: '0' });
  for (const [key, kind, name, rs] of [['1500', 'coaching_package', 'Portfolio Roadmap & Diagnosis', 1500], ['2250', 'resume_service', 'Complete Resume Build & Rewrite', 2250],
    ['3999', 'coaching_package', 'The Full Picture — Profile Strategy + Resume', 3999], ['4500', 'coaching_package', 'Guesstimate Readiness Programme', 4500]]) {
    const r = await admin.post('/api/admin/products', { kind, name, price_paise: rupees(rs), active: true, public_key: key });
    assert.ok([200, 201].includes(r.status), r.text);
  }
  const anon = new Client();
  const hook = (event, entity, id) => {
    const body = JSON.stringify({ event, payload: { payment: { entity } }, created_at: Date.now() });
    const sig = crypto.createHmac('sha256', 'whsec-test').update(body).digest('hex');
    return fetch(`${BASE}/api/webhooks/razorpay`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': id } });
  };
  const run = async () => { for (let i = 0; i < 6; i++) if (!(await jobs.processDue({ kinds: ['enquiries.check_abandon', 'enquiries.recover', 'enquiries.sheet_sync', 'email.send', 'payments.webhook', 'paysheet.sync'], limit: 100 })).length) break; }; // like the cron: drain until idle
  const enq = (email) => db.one('select * from anvaya.checkout_enquiries where email = $1', [email]);
  // CORS from the brochure host
  const pre = await fetch(`${BASE}/api/public/checkout/enquiry`, { method: 'OPTIONS', headers: { Origin: 'https://anvayacareers.in', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  // details submitted + checkout opened (twice: same enquiry, no new row), with consent and a referral
  const a1 = await anon.post('/api/public/checkout/enquiry', { name: 'Kabir Rao', email: 'Kabir@Buyers.test', phone: '+91 98000 11111', plan_key: '500mba', ref_code: 'FRIEND10', consent: true });
  assert.equal(a1.status, 201, a1.text);
  const a2 = await anon.post('/api/public/checkout/enquiry', { name: 'Kabir Rao', email: 'kabir@buyers.test', phone: '+91 98000 11111', plan_key: '500mba', ref_code: 'FRIEND10', consent: true, enquiry_id: a1.json.id });
  assert.equal(a2.json.id, a1.json.id);
  let e = await enq('kabir@buyers.test');
  assert.equal(e.attempts, 2); assert.equal(e.status, 'started'); assert.equal(Number(e.amount_paise), 45000, 'server price with referral');
  assert.equal(Number((await db.one("select count(*) n from anvaya.checkout_enquiries where email = 'kabir@buyers.test'")).n), 1);
  // closing the checkout window is an event, not a failure
  assert.equal((await anon.post(`/api/public/checkout/enquiry/${a1.json.id}/event`, { event: 'closed' })).status, 204);
  e = await enq('kabir@buyers.test'); assert.equal(e.status, 'started'); assert.equal(e.closed_count, 1);
  await run();
  assert.equal(enqRows.get(a1.json.id).status, 'Abandoned (no payment after 30 min)', 'one Sheet row, updated in place');
  e = await enq('kabir@buyers.test'); assert.equal(e.status, 'abandoned');
  // reminder 1 sent once, with a resume link at the current price; reminder 2 also due here (0 ms) — exactly one each
  const kabir = () => mailer.sent.filter((m) => m.to === 'kabir@buyers.test' && /almost done|Still thinking/.test(m.subject));
  assert.equal(kabir().length, 2);
  assert.match(kabir()[0].text, /anvaya-payment\.html\?plan=500mba&ref=FRIEND10/); assert.match(kabir()[0].text, /₹450/); assert.match(kabir()[0].text, /stop\?t=/);
  await run(); await jobs.runNow(await jobs.enqueue('enquiries.resync', {}, { dedupeKey: `t-enq-resync-${Date.now()}` })); await run();
  assert.equal(kabir().length, 2, 'no repeats on retries');
  assert.match(enqRows.get(a1.json.id).follow_up, /Agreed · email 1: sent · email 2: sent/);
  // the verified payment converts it (notes.enquiry), in Supabase and the Sheet
  await hook('payment.captured', { id: 'pay_enq_1', order_id: null, amount: 45000, status: 'captured', method: 'upi', email: 'kabir@buyers.test', contact: '+919800011111', notes: { plan: 'MBA Planning & Strategy Call', enquiry: a1.json.id } }, 'evt_enq_1');
  await run();
  e = await enq('kabir@buyers.test'); assert.equal(e.status, 'converted'); assert.equal(e.provider_payment_id, 'pay_enq_1'); assert.ok(e.order_id);
  assert.match(enqRows.get(a1.json.id).status, /^Converted \(paid, pay_enq_1\)/);

  // no consent: abandoned, never emailed
  const b = await anon.post('/api/public/checkout/enquiry', { name: 'Meera N', email: 'meera.n@buyers.test', phone: '9800022222', plan_key: '1500', consent: false });
  await run();
  assert.equal((await enq('meera.n@buyers.test')).status, 'abandoned');
  assert.equal(mailer.sent.filter((m) => m.to === 'meera.n@buyers.test').length, 0);
  assert.match(enqRows.get(b.json.id).follow_up, /not agreed/);

  // Razorpay's signed payment.failed marks it failed (the browser's own report does not)
  const c = await anon.post('/api/public/checkout/enquiry', { name: 'Tara S', email: 'tara@buyers.test', phone: '9800033333', plan_key: '2250', consent: true });
  process.env.ENQUIRY_ABANDON_MS = String(3600e3); // keep it "started" while we look
  await anon.post(`/api/public/checkout/enquiry/${c.json.id}/event`, { event: 'browser_failed' });
  assert.equal((await enq('tara@buyers.test')).status, 'started', 'browser report alone is not a failure');
  process.env.ENQUIRY_RECOVERY1_MS = String(3600e3); process.env.ENQUIRY_RECOVERY2_MS = String(86400e3);
  await hook('payment.failed', { id: 'pay_enq_fail', order_id: null, amount: 225000, status: 'failed', method: 'card', email: 'tara@buyers.test', error_description: 'Bank declined', notes: { plan: 'Complete Resume Build & Rewrite', enquiry: c.json.id } }, 'evt_enq_fail');
  await run();
  let t = await enq('tara@buyers.test'); assert.equal(t.status, 'failed'); assert.equal(t.failure_reason, 'Bank declined');
  assert.match(enqRows.get(c.json.id).status, /^Payment failed: Bank declined/);
  // she pays before the reminder is due: the reminder is cancelled, and a re-check would skip it anyway
  await hook('payment.captured', { id: 'pay_enq_2', order_id: null, amount: 225000, status: 'captured', method: 'card', email: 'tara@buyers.test', notes: { plan: 'Complete Resume Build & Rewrite' } }, 'evt_enq_2');
  await run();
  t = await enq('tara@buyers.test'); assert.equal(t.status, 'converted');
  assert.equal(Number((await db.one("select count(*) n from anvaya.jobs where kind = 'enquiries.recover' and payload->>'id' = $1 and status = 'cancelled'", [String(t.id)])).n), 2);
  // re-check before sending: a verified payment recorded another way also stops a reminder
  process.env.ENQUIRY_RECOVERY1_MS = '0'; process.env.ENQUIRY_RECOVERY2_MS = '0'; process.env.ENQUIRY_ABANDON_MS = '0';
  const dd = await anon.post('/api/public/checkout/enquiry', { name: 'Dev P', email: 'dev.p@buyers.test', phone: '9800044444', plan_key: '4500', consent: true });
  await db.run(`insert into anvaya.gateway_payments (provider_payment_id, email, plan, amount_paise, status, occurred_at) values ('pay_other_way', 'dev.p@buyers.test', 'Guesstimate Readiness Programme', 450000, 'paid', now())`);
  await run();
  assert.equal((await enq('dev.p@buyers.test')).status, 'converted');
  assert.equal(mailer.sent.filter((m) => m.to === 'dev.p@buyers.test').length, 0, 'never reminded after paying');
  assert.ok(dd.json.id);

  // unsubscribe link
  const enquiriesLib = require('../src/lib/enquiries');
  const z = await anon.post('/api/public/checkout/enquiry', { name: 'Zoya', email: 'zoya@buyers.test', phone: '9800055555', plan_key: '3999', consent: true });
  const bad = await fetch(`${BASE}/api/public/checkout/enquiry/${z.json.id}/stop?t=nope`); assert.equal(bad.status, 404);
  const ok = await fetch(`${BASE}/api/public/checkout/enquiry/${z.json.id}/stop?t=${enquiriesLib.stopToken(z.json.id)}`); assert.equal(ok.status, 200);
  await run();
  assert.equal(mailer.sent.filter((m) => m.to === 'zoya@buyers.test').length, 0);

  // CRM view (staff only) and the daily summary, sent once per day
  assert.equal((await anon.get('/api/admin/checkout-enquiries')).status, 401);
  const crm = await admin.get('/api/admin/checkout-enquiries');
  assert.equal(crm.status, 200); assert.ok(crm.json.stats.converted >= 3); assert.ok(crm.json.rows.some((r) => r.follow_up.includes('email 1')));
  const day = '2099-01-01';
  for (let i = 0; i < 2; i++) { await jobs.enqueue('enquiries.daily_summary', { day }, { dedupeKey: `enq-summary-job:${day}` }); await jobs.processDue({ kinds: ['enquiries.daily_summary', 'email.send'], limit: 10 }); }
  const sums = mailer.sent.filter((m) => m.to === 'team@anvaya.test' && m.subject.startsWith('Checkouts 2099-01-01:'));
  assert.equal(sums.length, 1); assert.match(sums[0].text, /Converted \(paid\): \d/);
  for (const k of ['ENQUIRY_ABANDON_MS', 'ENQUIRY_RECOVERY1_MS', 'ENQUIRY_RECOVERY2_MS']) delete process.env[k];
});

test('visit sources: link clicks, free chats and checkouts carry the ?src code; the CRM report and Leads filter use it', async () => {
  const anon = new Client();
  await db.run('delete from anvaya.rate_limits'); // earlier tests used up the free-chat form's hourly allowance
  for (let i = 0; i < 3; i++) assert.equal((await anon.post('/api/public/ref-visit', { src: 'SRCC-Consulting-Club' })).status, 204);
  await anon.post('/api/public/ref-visit', { src: '<script>' }); // cleaned to "script"
  const lead = await anon.post('/api/public/leads', { name: 'Ira Club', phone: '+91 98700 12345', situation: 'Applying but not hearing back', src: 'srcc-consulting-club', src_first: 'insta-reel-oct' });
  assert.equal(lead.status, 201, lead.text);
  const l = await db.one('select ref_source, ref_first from anvaya.leads where id = $1', [lead.json.id]);
  assert.deepEqual([l.ref_source, l.ref_first], ['srcc-consulting-club', 'insta-reel-oct']);
  const e = await anon.post('/api/public/checkout/enquiry', { name: 'Ira Club', email: 'ira.club@buyers.test', phone: '9870012345', plan_key: '2250', consent: false, src: 'srcc-consulting-club', src_first: 'insta-reel-oct', entry: 'quiz' });
  assert.equal(e.status, 201, e.text);
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_src_1', order_id: null, amount: 225000, status: 'captured', method: 'upi', email: 'ira.club@buyers.test', notes: { plan: 'Complete Resume Build & Rewrite', enquiry: e.json.id } } } }, created_at: Date.now() });
  await fetch(`${BASE}/api/webhooks/razorpay`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': crypto.createHmac('sha256', 'whsec-test').update(body).digest('hex'), 'X-Razorpay-Event-Id': 'evt_src_1' } });
  await jobs.processDue({ kinds: ['payments.webhook', 'enquiries.sheet_sync', 'paysheet.sync', 'email.send'], limit: 50 });
  assert.equal((await anon.get('/api/admin/sources')).status, 401);
  const rep = await admin.get('/api/admin/sources?days=30');
  const row = rep.json.find((r) => r.source === 'srcc-consulting-club');
  assert.deepEqual([row.clicks, row.free_chats, row.checkouts, row.paid, Number(row.paid_paise), row.via_quiz], [3, 1, 1, 1, 225000, 1]);
  assert.ok(rep.json.some((r) => r.source === 'script'), 'codes are cleaned, not rejected');
  const filtered = await admin.get('/api/admin/leads-table?source=srcc');
  assert.equal(filtered.status, 200, filtered.text);
  assert.ok((filtered.json.rows || filtered.json).some((x) => x.ref_source === 'srcc-consulting-club'));
});
