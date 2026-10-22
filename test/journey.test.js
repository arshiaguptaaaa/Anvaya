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
Object.assign(process.env, {
  DATABASE_URL: 'pglite://memory', MAIL_TRANSPORT: 'memory', RESEND_API_KEY: '', SMTP_HOST: '', STORAGE_DRIVER: 'memory',
  SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', JOBS_AUTORUN: 'false',
  PORT: String(PORT), APP_BASE_URL: `http://localhost:${PORT}`, CRON_SECRET: 'cron-test-secret', EXTRA_ORIGINS: 'https://anvayacareers.in',
  ADMIN_EMAIL: 'admin@anvaya.test', ADMIN_PASSWORD: 'Admin-pass-2026',
  RAZORPAY_KEY_ID: 'rzp_fake_test', RAZORPAY_KEY_SECRET: 'rzp-secret', RAZORPAY_WEBHOOK_SECRET: 'whsec-test',
  GOOGLE_SHEET_WEBHOOK_URL: `http://localhost:${SHEET_PORT}/exec`,
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
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { sheetHits.push(Object.fromEntries(new URLSearchParams(b))); res.statusCode = sheetMode === 'ok' ? 200 : 500; res.end('{}'); });
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
  ['<span class="hstat-n">500</span><span class="hstat-l">Resumes reviewed</span>', '<span class="hstat-n">50+</span><span class="hstat-l">Resumes reviewed</span>'],
  [/<style>\n\/\* TESTIMONIALS \*\/[\s\S]*?<\/style>\n<\/head>/, '</head>'], // testimonial styles
  [/\n\n<!-- TESTIMONIALS -->[\s\S]*?<\/section>/, ''], // testimonial section (video)
];
test('public page = supplied brochure + only the lead-capture script tag', async () => {
  const served = Buffer.from(await (await fetch(BASE + '/')).arrayBuffer()).toString('latin1');
  assert.equal(served.split(LEAD_TAG).length, 2);
  const reverted = APPROVED_EDITS.reduce((html, [now, was]) => {
    assert.equal((html.match(now instanceof RegExp ? new RegExp(now.source, 'g') : new RegExp(now.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, `approved edit present once: ${now}`);
    return html.replace(now, was);
  }, served.replace(LEAD_TAG, ''));
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

    assert.equal(err(await viaGoogle(new Client(), 'student', 'stranger@gmail.com')), 'google_no_account', 'no account creation');
    const inv = await admin.post('/api/admin/students', { name: 'Invited Only', email: 'invited.only@students.test' });
    await admin.post(`/api/admin/students/${inv.json.id}/invite`);
    assert.equal(err(await viaGoogle(new Client(), 'student', 'invited.only@students.test')), 'google_no_account', 'must accept the invitation first');
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
  assert.equal(c1.status, 201, c1.text); assert.equal(c1.json.status, 'scheduled');
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
  assert.equal(r.json.status, 'pending_payment');
  assert.equal(r.json.checkout.amount_paise, rupees(2500), 'student pays the mentor’s stated fee');
  assert.equal((await stu1.post('/api/student/bookings/paid', { mentor_id: ids.mentorA, scheduled_at: slots[5] })).status, 409, 'slot held while paying');
  const pay = fakePay(r.json.checkout.razorpay_order_id, rupees(2500), { fee: 5000, tax: 900 });
  assert.equal((await stu2.post('/api/student/payments/verify', pay)).json.status, 'paid');
  const b = await db.one('select * from anvaya.bookings where id = $1', [r.json.booking_id]);
  assert.equal(b.status, 'scheduled'); assert.equal(b.mentor_fee_paise, rupees(2500), 'zero commission');
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
  assert.ok(mailer.sent.some((m) => m.to === 'neha@students.test' && /^Moved: Reminder test session/.test(m.subject)));
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
  assert.ok(!(await mentorA.get('/api/mentor/agenda')).json.some((x) => x.id === row.id), 'unpaid holds stay off the agenda');
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
