'use strict';
// End-to-end journey + permission tests. Runs the real server against a throwaway database and email outbox.
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = 4000 + Math.floor(Math.random() * 1000);
Object.assign(process.env, {
  DATABASE_URL: 'pglite://memory', MAIL_TRANSPORT: 'memory', RESEND_API_KEY: '', SMTP_HOST: '',
  PORT: String(PORT), APP_BASE_URL: `http://localhost:${PORT}`,
  ADMIN_EMAIL: 'admin@anvaya.test', ADMIN_PASSWORD: 'Admin-pass-2026',
});
const app = require('../src/app');
const db = require('../src/db');
const mailer = require('../src/mailer');
const BASE = `http://localhost:${PORT}`;
let server;

/** Minimal browser-like client: keeps cookies and the CSRF token. */
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
    return { status: res.status, json, text, location: res.headers.get('location'), headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}, o) { return this.req('POST', u, b, o); }
  patch(u, b) { return this.req('PATCH', u, b); }
  put(u, b) { return this.req('PUT', u, b); }
  async login(email, password) {
    const r = await this.post('/api/auth/login', { email, password });
    if (r.status === 200) this.csrf = (await this.get('/api/auth/me')).json.csrf;
    return r;
  }
  async refreshCsrf() { this.csrf = (await this.get('/api/auth/me')).json.csrf; }
}

function lastEmailTo(to) {
  const list = mailer.sent.filter((m) => m.to === to);
  assert.ok(list.length, `expected an email to ${to}`);
  return list.at(-1);
}
const emailCount = (to) => mailer.sent.filter((m) => m.to.includes(to)).length;
const tokenFrom = (mail) => new URL(mail.text.match(/https?:\/\/\S+\/invite\?token=\S+/)[0]).searchParams.get('token');

const admin = new Client();
const mentorA = new Client();
const mentorB = new Client();
const ids = {};

test.before(() => new Promise((r) => { server = app.listen(PORT, r); }));
test.after(async () => { server.close(); await db.end(); });

// SHA-256 of the supplied anvaya-brochure (15).html.
const ORIGINAL_SHA = '05995cd3a1e0fa7719fd871937c3daca475666019061eaa71e628d09a5d2bff2';
const LEAD_TAG = '<script src="/app/lead-capture.js" defer></script>\n';

test('public page is the supplied brochure plus only the lead-capture script tag', async () => {
  const res = await fetch(BASE + '/');
  const served = Buffer.from(await res.arrayBuffer()).toString('latin1');
  assert.equal(res.status, 200);
  assert.equal(served.split(LEAD_TAG).length, 2, 'exactly one injected line');
  const restored = Buffer.from(served.replace(LEAD_TAG, ''), 'latin1');
  assert.equal(crypto.createHash('sha256').update(restored).digest('hex'), ORIGINAL_SHA);
});

test('admin area is locked when signed out', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/admin')).location, '/admin/login');
  assert.equal((await anon.get('/api/admin/mentors')).status, 401);
  assert.equal((await anon.get('/api/mentor/bookings')).status, 401);
});

test('admin login rejects a wrong password and accepts the right one', async () => {
  assert.equal((await admin.login('admin@anvaya.test', 'wrong-password-1')).status, 401);
  const r = await admin.login('admin@anvaya.test', 'Admin-pass-2026');
  assert.equal(r.status, 200); assert.equal(r.json.next, '/admin');
  assert.match(Object.keys(admin.cookies).join(), /anvaya_sid/);
  assert.equal((await admin.get('/admin')).status, 200);
});

test('state-changing requests without the CSRF token are refused', async () => {
  const r = await admin.post('/api/admin/leads', { name: 'X' }, { csrf: false });
  assert.equal(r.status, 403);
});

test('admin adds a mentor → invitation email with a unique link is sent', async () => {
  const r = await admin.post('/api/admin/mentors', {
    name: 'Priya Raman', email: 'priya@mentors.test', expertise: 'Product management', bio: 'Ex-PM at a unicorn.', session_price: 2500,
  });
  assert.equal(r.status, 201, r.text);
  ids.mentorA = r.json.id;
  const mail = lastEmailTo('priya@mentors.test');
  assert.match(mail.subject, /invited/i);
  ids.tokenA = tokenFrom(mail);
  assert.ok(ids.tokenA.length >= 40);
  const stored = await db.one('select token_hash from anvaya.invitations where mentor_id = $1', [ids.mentorA]);
  assert.notEqual(stored.token_hash, ids.tokenA, 'raw token must not be stored');
  const list = (await admin.get('/api/admin/mentors')).json;
  assert.equal(list.find((m) => m.id === ids.mentorA).status, 'invite_pending');
  // duplicate email
  assert.equal((await admin.post('/api/admin/mentors', { name: 'Dup', email: 'PRIYA@mentors.test', session_price: 1 })).status, 409);
});

test('mentor opens the link, accepts and sets a password (single use)', async () => {
  const insp = await mentorA.post('/api/invites/inspect', { token: ids.tokenA });
  assert.equal(insp.json.state, 'valid'); assert.equal(insp.json.email, 'priya@mentors.test');
  const weak = await mentorA.post('/api/invites/accept', { token: ids.tokenA, password: 'short', confirm: 'short' });
  assert.equal(weak.status, 400);
  const mismatch = await mentorA.post('/api/invites/accept', { token: ids.tokenA, password: 'Mentor-pass-01', confirm: 'Mentor-pass-02' });
  assert.equal(mismatch.status, 400);
  const ok = await mentorA.post('/api/invites/accept', { token: ids.tokenA, password: 'Mentor-pass-01', confirm: 'Mentor-pass-01' });
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.next, '/mentor/onboarding');
  await mentorA.refreshCsrf();
  // Reuse is refused, even from a different browser.
  const again = await new Client().post('/api/invites/accept', { token: ids.tokenA, password: 'Hijack-pass-01', confirm: 'Hijack-pass-01' });
  assert.equal(again.status, 410);
  assert.equal((await new Client().post('/api/invites/inspect', { token: ids.tokenA })).json.state, 'used');
});

test('before completing the profile the mentor is held at onboarding', async () => {
  assert.equal((await mentorA.get('/mentor')).location, '/mentor/onboarding');
  const r = await mentorA.get('/api/mentor/bookings');
  assert.equal(r.status, 403); assert.equal(r.json.onboarding, true);
  const admins = (await admin.get('/api/admin/mentors')).json;
  assert.equal(admins.find((m) => m.id === ids.mentorA).status, 'invite_pending');
});

test('completing profile + availability activates the mentor and opens the dashboard', async () => {
  const profile = { name: 'Priya Raman', expertise: 'Product management, PM interviews', bio: 'Eight years in product.', session_duration: 60, meeting_link: 'https://meet.google.com/abc-defg-hij', timezone: 'Asia/Kolkata' };
  assert.equal((await mentorA.post('/api/mentor/onboarding', { ...profile, availability: [] })).status, 400, 'availability required');
  assert.equal((await mentorA.post('/api/mentor/onboarding', { ...profile, availability: [{ weekday: 1, start_time: '19:00', end_time: '18:00' }] })).status, 400, 'end after start');
  const r = await mentorA.post('/api/mentor/onboarding', { ...profile, availability: [{ weekday: 1, start_time: '18:00', end_time: '20:00' }, { weekday: 6, start_time: '10:00', end_time: '13:00' }] });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.next, '/mentor');
  const list = (await admin.get('/api/admin/mentors')).json;
  assert.equal(list.find((m) => m.id === ids.mentorA).status, 'active');
  assert.equal((await mentorA.get('/mentor')).status, 200);
  assert.equal((await mentorA.get('/api/mentor/me')).json.availability.length, 2);
});

test('mentor can sign in later with email + password', async () => {
  const c = new Client();
  const r = await c.login('priya@mentors.test', 'Mentor-pass-01');
  assert.equal(r.status, 200); assert.equal(r.json.next, '/mentor');
});

test('mentors cannot reach admin pages or admin APIs', async () => {
  const page = await mentorA.get('/admin');
  assert.equal(page.status, 403);
  assert.doesNotMatch(page.text, /admin\.js/);
  for (const u of ['/api/admin/overview', '/api/admin/mentors', '/api/admin/students', '/api/admin/leads', '/api/admin/bookings', '/api/admin/payments']) {
    assert.equal((await mentorA.get(u)).status, 403, u);
  }
  assert.equal((await mentorA.post('/api/admin/mentors', { name: 'Evil', email: 'evil@x.test', session_price: 1 })).status, 403);
  assert.equal((await mentorA.post(`/api/admin/mentors/${ids.mentorA}/reactivate`)).status, 403);
  // Admin cannot use mentor APIs either (role separation).
  assert.equal((await admin.get('/api/mentor/bookings')).status, 403);
});

test('second mentor onboards; admin sets up students, bookings, payments', async () => {
  const r = await admin.post('/api/admin/mentors', { name: 'Arjun Mehta', email: 'arjun@mentors.test', expertise: 'MBA admissions', bio: 'IIM-A alum.', session_price: 3000 });
  ids.mentorB = r.json.id;
  const tok = tokenFrom(lastEmailTo('arjun@mentors.test'));
  await mentorB.post('/api/invites/accept', { token: tok, password: 'Arjun-pass-01', confirm: 'Arjun-pass-01' });
  await mentorB.refreshCsrf();
  assert.equal((await mentorB.post('/api/mentor/onboarding', { name: 'Arjun Mehta', expertise: 'MBA', bio: 'IIM-A', availability: [{ weekday: 3, start_time: '09:00', end_time: '11:00' }] })).status, 200);

  const sA = await admin.post('/api/admin/students', { name: 'Rahul Sharma', email: 'rahul@s.test', stage: 'Fresher', goals: 'Land a PM internship', notes: 'ADMIN-ONLY-SECRET', mentor_id: ids.mentorA });
  const sB = await admin.post('/api/admin/students', { name: 'Neha Iyer', email: 'neha@s.test', stage: 'MBA aspirant', mentor_id: ids.mentorB });
  ids.studentA = sA.json.id; ids.studentB = sB.json.id;
  const soon = new Date(Date.now() + 2 * 86400e3).toISOString();
  const bA = await admin.post('/api/admin/bookings', { student_id: ids.studentA, mentor_id: ids.mentorA, service: 'Resume Review', scheduled_at: soon, price: 1500 });
  const bB = await admin.post('/api/admin/bookings', { student_id: ids.studentB, mentor_id: ids.mentorB, service: 'MBA Profile Review', scheduled_at: soon, price: 4500 });
  assert.equal(bA.status, 201, bA.text);
  ids.bookingA = bA.json.id; ids.bookingB = bB.json.id;
  assert.equal((await db.one('select mentor_fee from anvaya.bookings where id = $1', [ids.bookingA])).mentor_fee, 2500, 'fee defaults to mentor price');
  assert.equal((await admin.post('/api/admin/payments', { student_id: ids.studentA, booking_id: ids.bookingA, amount: 1500, method: 'UPI', reference: 'UPI123', status: 'paid' })).status, 201);
  const lead = await admin.post('/api/admin/leads', { name: 'Karan', phone: '+91 90000 00000', situation: 'Targeting MBA / IIM / ISB' });
  const conv = await admin.post(`/api/admin/leads/${lead.json.id}/convert`);
  assert.equal(conv.status, 200);
  assert.equal((await admin.get('/api/admin/overview')).json.revenue.paid, 1500);
});

test('each mentor only sees their own students, bookings and records', async () => {
  const bookingsA = (await mentorA.get('/api/mentor/bookings')).json;
  assert.deepEqual(bookingsA.map((b) => b.id), [ids.bookingA]);
  const studentsA = (await mentorA.get('/api/mentor/students')).json;
  assert.deepEqual(studentsA.map((s) => s.id), [ids.studentA]);
  assert.ok(!JSON.stringify(studentsA).includes('ADMIN-ONLY-SECRET'), 'admin notes must not leak to mentors');
  assert.ok(!('price' in bookingsA[0]), 'student price is not exposed to mentors');

  // Direct access to the other mentor's records → 404 (no existence leak)
  assert.equal((await mentorA.get(`/api/mentor/students/${ids.studentB}`)).status, 404);
  assert.equal((await mentorA.patch(`/api/mentor/bookings/${ids.bookingB}`, { session_notes: 'tampered' })).status, 404);
  assert.equal((await mentorA.post(`/api/mentor/bookings/${ids.bookingB}/complete`)).status, 404);
  const bB = await db.one('select session_notes, status from anvaya.bookings where id = $1', [ids.bookingB]);
  assert.equal(bB.status, 'scheduled');
  assert.equal(bB.session_notes, '');
  // and the reverse
  assert.equal((await mentorB.get(`/api/mentor/students/${ids.studentA}`)).status, 404);
  assert.deepEqual((await mentorB.get('/api/mentor/bookings')).json.map((b) => b.id), [ids.bookingB]);
});

test('mentor adds session notes and marks the session completed → earnings update', async () => {
  assert.equal((await mentorA.patch(`/api/mentor/bookings/${ids.bookingA}`, { session_notes: 'Reworked summary section.' })).status, 200);
  const done = await mentorA.post(`/api/mentor/bookings/${ids.bookingA}/complete`, { session_notes: 'Reworked summary. Next: quantify impact.' });
  assert.equal(done.status, 200);
  assert.equal((await mentorA.post(`/api/mentor/bookings/${ids.bookingA}/complete`)).status, 400, 'cannot complete twice');
  const o = (await mentorA.get('/api/mentor/overview')).json;
  assert.equal(o.stats.earned, 2500); assert.equal(o.stats.completed, 1);
  const e = (await mentorA.get('/api/mentor/earnings')).json;
  assert.equal(e.items[0].mentor_fee, 2500);
  assert.equal((await mentorB.get('/api/mentor/overview')).json.stats.earned, 0);
  const s = (await mentorA.get(`/api/mentor/students/${ids.studentA}`)).json;
  assert.match(s.bookings[0].session_notes, /quantify impact/);
});

test('mentor edits profile/availability but cannot change price, email or status', async () => {
  const r = await mentorA.patch('/api/mentor/me', { bio: 'Updated bio', session_price: 99999, status: 'active', email: 'x@y.z', session_details: '60-min deep dive' });
  assert.equal(r.status, 200);
  assert.equal(r.json.bio, 'Updated bio'); assert.equal(r.json.session_price, 2500); assert.equal(r.json.email, 'priya@mentors.test');
  const av = await mentorA.put('/api/mentor/availability', { availability: [{ weekday: 2, start_time: '07:00', end_time: '08:30' }] });
  assert.equal(av.status, 200); assert.equal(av.json.length, 1);
});

test('admin edits a mentor profile', async () => {
  const r = await admin.patch(`/api/admin/mentors/${ids.mentorB}`, { session_price: 3500, expertise: 'MBA admissions, ISB essays' });
  assert.equal(r.status, 200); assert.equal(r.json.session_price, 3500);
});

test('expired invitation offers a fresh link, sent only to the address on file', async () => {
  const r = await admin.post('/api/admin/mentors', { name: 'Sana Kapoor', email: 'sana@mentors.test', expertise: 'Consulting', bio: '', session_price: 2000 });
  ids.mentorC = r.json.id;
  const oldTok = tokenFrom(lastEmailTo('sana@mentors.test'));
  await db.run("update anvaya.invitations set expires_at = '2000-01-01T00:00:00Z' where mentor_id = $1", [ids.mentorC]);
  const c = new Client();
  const insp = await c.post('/api/invites/inspect', { token: oldTok });
  assert.equal(insp.json.state, 'expired');
  assert.equal(insp.json.email, 's••a@mentors.test');
  assert.equal((await c.post('/api/invites/accept', { token: oldTok, password: 'Sana-pass-0001', confirm: 'Sana-pass-0001' })).status, 410);
  const before = emailCount('sana@mentors.test');
  const fresh = await c.post('/api/invites/request-new', { token: oldTok, email: 'attacker@evil.test' });
  assert.equal(fresh.status, 200, fresh.text);
  assert.equal(emailCount('sana@mentors.test'), before + 1);
  assert.equal(emailCount('attacker'), 0);
  const newTok = tokenFrom(lastEmailTo('sana@mentors.test'));
  assert.notEqual(newTok, oldTok);
  assert.equal((await c.post('/api/invites/inspect', { token: newTok })).json.state, 'valid');
  assert.equal((await c.post('/api/invites/inspect', { token: oldTok })).json.state, 'superseded');
  ids.tokenC = newTok;
});

test('admin resend invalidates the previous link', async () => {
  const r = await admin.post(`/api/admin/mentors/${ids.mentorC}/resend-invite`);
  assert.equal(r.status, 200);
  const newest = tokenFrom(lastEmailTo('sana@mentors.test'));
  assert.equal((await new Client().post('/api/invites/inspect', { token: ids.tokenC })).json.state, 'superseded');
  assert.equal((await new Client().post('/api/invites/inspect', { token: newest })).json.state, 'valid');
  ids.tokenC = newest;
  assert.equal((await admin.post(`/api/admin/mentors/${ids.mentorA}/resend-invite`)).status, 400, 'no resend for active mentors');
});

test('deactivating a mentor kills their session, login and pending links', async () => {
  assert.equal((await admin.post(`/api/admin/mentors/${ids.mentorA}/deactivate`)).status, 200);
  assert.equal((await mentorA.get('/api/mentor/bookings')).status, 401);
  assert.equal((await mentorA.get('/mentor')).location, '/mentor/login');
  const relog = await new Client().login('priya@mentors.test', 'Mentor-pass-01');
  assert.equal(relog.status, 403); assert.match(relog.json.error, /deactivated/i);
  assert.equal((await admin.get('/api/admin/mentors')).json.find((m) => m.id === ids.mentorA).status, 'deactivated');
  // Deactivated mentors can't be booked
  assert.equal((await admin.post('/api/admin/bookings', { student_id: ids.studentA, mentor_id: ids.mentorA, scheduled_at: new Date().toISOString() })).status, 400);

  await admin.post(`/api/admin/mentors/${ids.mentorC}/deactivate`);
  assert.equal((await new Client().post('/api/invites/inspect', { token: ids.tokenC })).json.state, 'deactivated');

  const re = await admin.post(`/api/admin/mentors/${ids.mentorA}/reactivate`);
  assert.equal(re.json.status, 'active');
  assert.equal((await new Client().login('priya@mentors.test', 'Mentor-pass-01')).status, 200);
});

test('free-chat form submissions land in the admin CRM as leads', async () => {
  const anon = new Client();
  const r = await anon.post('/api/public/leads', { name: 'Meera Joshi', phone: '+91 91234 56789', situation: 'Applying but not hearing back' });
  assert.equal(r.status, 201, r.text);
  await anon.post('/api/public/leads', { name: 'Meera Joshi', phone: '+91 91234 56789', situation: 'Applying but not hearing back' });
  const leads = (await admin.get('/api/admin/leads')).json.filter((l) => l.name === 'Meera Joshi');
  assert.equal(leads.length, 1, 'duplicate submissions are collapsed');
  assert.equal(leads[0].status, 'new');
  assert.equal((await anon.post('/api/public/leads', { name: 'X', phone: 'abc' })).status, 400);
  assert.equal((await anon.post('/api/public/leads', { name: 'Bot', phone: '+91 90000 00000', website: 'spam' })).status, 201);
  assert.ok(!(await admin.get('/api/admin/leads')).json.some((l) => l.name === 'Bot'), 'honeypot submissions are dropped');
  const cross = await fetch(BASE + '/api/public/leads', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'Evil', phone: '+91 90000 00001' }) });
  assert.equal(cross.status, 403);
  // mentors can't see leads
  assert.equal((await mentorA.get('/api/admin/leads')).status, 401);
});

test('logout ends the session', async () => {
  await mentorB.post('/api/auth/logout');
  assert.equal((await mentorB.get('/api/mentor/bookings')).status, 401);
});

test('invalid tokens and brute-force logins are handled', async () => {
  assert.equal((await new Client().post('/api/invites/inspect', { token: 'x'.repeat(43) })).json.state, 'invalid');
  const c = new Client();
  let last;
  for (let i = 0; i < 11; i++) last = await c.post('/api/auth/login', { email: 'ratelimit@anvaya.test', password: 'nope' });
  assert.equal(last.status, 429);
});
