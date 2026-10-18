'use strict';
// One-off copy of records from the old local SQLite database (data/anvaya.db) into Supabase Postgres.
//   node scripts/migrate-sqlite-to-postgres.js            → dry run: prints what would be copied / skipped
//   node scripts/migrate-sqlite-to-postgres.js --apply    → copies into DATABASE_URL (never deletes anything)
// Test accounts and sample records are excluded (see isTest below). Existing rows in Postgres are left untouched;
// users whose email already exists in Postgres are skipped.
const fs = require('node:fs');
const path = require('node:path');
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const { DatabaseSync } = require('node:sqlite');
const db = require('../src/db');

const SRC = process.argv.find((a) => a.endsWith('.db')) || path.join(__dirname, '..', 'data', 'anvaya.db');
const APPLY = process.argv.includes('--apply');

const TEST_EMAIL = /@([a-z0-9-]+\.)*(test|local|example|invalid|localhost)$|@example\.(com|org|net)$/i;
const SAMPLE_PHONES = new Set(['+91 98765 43210', '+91 90000 00000']); // placeholder numbers used in the UI / during testing
const isTestPerson = (r) => TEST_EMAIL.test(r.email || '') || SAMPLE_PHONES.has((r.phone || '').trim());

(async () => {
  if (!fs.existsSync(SRC)) { console.log(`No SQLite database at ${SRC} — nothing to migrate.`); return; }
  const s = new DatabaseSync(SRC, { readOnly: true });
  const rows = (t) => s.prepare(`SELECT * FROM ${t}`).all();
  const users = rows('users'), mentors = rows('mentors'), students = rows('students'), leads = rows('leads');
  const bookings = rows('bookings'), payments = rows('payments'), availability = rows('availability');

  const userById = new Map(users.map((u) => [u.id, u]));
  const keepUser = new Set(users.filter((u) => !TEST_EMAIL.test(u.email)).map((u) => u.id));
  const keepMentor = new Set(mentors.filter((m) => keepUser.has(m.user_id)).map((m) => m.id));
  // A student is kept only if they look genuine AND aren't tied exclusively to excluded mentors.
  const keepStudent = new Set(students.filter((st) => !isTestPerson(st) && (st.mentor_id == null || keepMentor.has(st.mentor_id))).map((st) => st.id));
  const keepLead = leads.filter((l) => !isTestPerson(l) && (l.student_id == null || keepStudent.has(l.student_id)));
  const keepBooking = bookings.filter((b) => keepStudent.has(b.student_id) && (b.mentor_id == null || keepMentor.has(b.mentor_id)));
  const keepBookingIds = new Set(keepBooking.map((b) => b.id));
  const keepPayment = payments.filter((p) => keepStudent.has(p.student_id) && (p.booking_id == null || keepBookingIds.has(p.booking_id)));

  const report = (label, all, kept) => console.log(`${label.padEnd(12)} ${String(kept).padStart(4)} to copy, ${String(all - kept).padStart(4)} excluded as test/sample`);
  console.log(`Source: ${SRC}${APPLY ? '' : '  (dry run — pass --apply to write)'}`);
  report('users', users.length, keepUser.size);
  report('mentors', mentors.length, keepMentor.size);
  report('students', students.length, keepStudent.size);
  report('leads', leads.length, keepLead.length);
  report('bookings', bookings.length, keepBooking.length);
  report('payments', payments.length, keepPayment.length);
  const excluded = users.filter((u) => !keepUser.has(u.id)).map((u) => `${u.email} (${u.role})`);
  if (excluded.length) console.log('Excluded accounts:', excluded.join(', '));
  if (!APPLY) { await db.end(); return; }

  const ts = (x) => (x ? new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(x) ? x.replace(' ', 'T') + 'Z' : x) : null);
  await db.tx(async (t) => {
    const userMap = new Map(), mentorMap = new Map(), studentMap = new Map(), bookingMap = new Map();
    for (const id of keepUser) {
      const u = userById.get(id);
      const existing = await t.one('select id from anvaya.users where lower(email) = lower($1)', [u.email]);
      if (existing) { console.log(`skip existing user ${u.email}`); userMap.set(id, null); continue; }
      const r = await t.one('insert into anvaya.users (email, password_hash, role, created_at, last_login_at) values ($1,$2,$3,$4,$5) returning id',
        [u.email.toLowerCase(), u.password_hash, u.role, ts(u.created_at), ts(u.last_login_at)]);
      userMap.set(id, r.id);
    }
    for (const m of mentors.filter((x) => keepMentor.has(x.id) && userMap.get(x.user_id))) {
      const r = await t.one(`insert into anvaya.mentors (user_id, name, expertise, bio, session_price, session_duration, session_details, meeting_link,
        phone, linkedin, timezone, status, profile_completed, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [userMap.get(m.user_id), m.name, m.expertise, m.bio, m.session_price, m.session_duration, m.session_details, m.meeting_link,
        m.phone, m.linkedin, m.timezone, m.status, !!m.profile_completed, ts(m.created_at), ts(m.updated_at)]);
      mentorMap.set(m.id, r.id);
      for (const a of availability.filter((x) => x.mentor_id === m.id)) {
        await t.run('insert into anvaya.availability (mentor_id, weekday, start_time, end_time) values ($1,$2,$3,$4)', [r.id, a.weekday, a.start_time, a.end_time]);
      }
    }
    for (const st of students.filter((x) => keepStudent.has(x.id))) {
      const r = await t.one(`insert into anvaya.students (name, email, phone, stage, goals, plan, status, mentor_id, notes, created_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [st.name, st.email, st.phone, st.stage, st.goals, st.plan, st.status, mentorMap.get(st.mentor_id) ?? null, st.notes, ts(st.created_at)]);
      studentMap.set(st.id, r.id);
    }
    for (const l of keepLead) {
      await t.run(`insert into anvaya.leads (name, email, phone, situation, source, status, notes, student_id, created_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [l.name, l.email, l.phone, l.situation, l.source, l.status, l.notes, studentMap.get(l.student_id) ?? null, ts(l.created_at)]);
    }
    for (const b of keepBooking) {
      const r = await t.one(`insert into anvaya.bookings (student_id, mentor_id, service, scheduled_at, duration, status, price, mentor_fee, meeting_link,
        session_notes, completed_at, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [studentMap.get(b.student_id), mentorMap.get(b.mentor_id) ?? null, b.service, ts(b.scheduled_at), b.duration, b.status, b.price, b.mentor_fee,
        b.meeting_link, b.session_notes, ts(b.completed_at), ts(b.created_at)]);
      bookingMap.set(b.id, r.id);
    }
    for (const p of keepPayment) {
      await t.run(`insert into anvaya.payments (student_id, booking_id, amount, method, reference, status, paid_at, created_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8)`, [studentMap.get(p.student_id), bookingMap.get(p.booking_id) ?? null, p.amount, p.method, p.reference, p.status, ts(p.paid_at), ts(p.created_at)]);
    }
  });
  console.log('Migration complete.');
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
