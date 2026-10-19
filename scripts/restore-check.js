'use strict';
// Restores a backup folder into a throwaway in-process Postgres (PGlite) built from the same migrations,
// then verifies every table's row count and every file's checksum. Proves the backup is restorable.
//   node scripts/restore-check.js backups/<timestamp>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATABASE_URL = 'pglite://memory';
process.env.SKIP_DOTENV = '1';
const db = require('../src/db');

(async () => {
  const dir = path.resolve(process.argv[2] || '');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const order = ['users', 'tracks', 'colleges', 'mentors', 'availability', 'cohorts', 'students', 'invitations', 'sessions', 'college_coordinators', 'cohort_members',
    'enrollments', 'modules', 'assignments', 'assignment_progress', 'leads', 'lead_activities', 'documents', 'document_versions', 'playbook_versions', 'products',
    'plan_entitlements', 'orders', 'payments', 'refunds', 'subscriptions', 'mentor_groups', 'group_members', 'live_sessions', 'bookings', 'attendance', 'service_cases',
    'case_events', 'qa_reviews', 'ai_runs', 'applications', 'feedback', 'payouts', 'mentor_ledger', 'webhook_events', 'jobs', 'settings', 'audit_log', 'rate_limits'];
  const tables = [...order.filter((t) => t in manifest.tables), ...Object.keys(manifest.tables).filter((t) => !order.includes(t))];
  const problems = [];
  await db.tx(async (t) => {
    await t.run("set session_replication_role = replica"); // load in any order; FKs re-checked below
    for (const name of tables) {
      const rows = JSON.parse(fs.readFileSync(path.join(dir, 'tables', `${name}.json`), 'utf8'));
      await t.run(`delete from anvaya.${name}`);
      for (const r of rows) {
        const keys = Object.keys(r);
        const vals = keys.map((k) => (r[k] !== null && typeof r[k] === 'object' && !(r[k] instanceof Date) ? JSON.stringify(r[k]) : r[k]));
        await t.run(`insert into anvaya.${name} (${keys.join(',')}) overriding system value values (${keys.map((_, i) => `$${i + 1}`).join(',')})`, vals);
      }
    }
    await t.run("set session_replication_role = origin");
    // Move identity sequences past the restored ids so new rows don't collide.
    for (const name of tables) {
      const hasId = await t.one("select 1 from information_schema.columns where table_schema = 'anvaya' and table_name = $1 and column_name = 'id'", [name]);
      if (!hasId) continue;
      const seq = await t.one(`select pg_get_serial_sequence('anvaya.${name}', 'id') as s`);
      if (seq?.s) await t.run(`select setval('${seq.s}', greatest(coalesce((select max(id) from anvaya.${name}), 0), 1))`);
    }
  });
  for (const name of tables) {
    const n = (await db.one(`select count(*) n from anvaya.${name}`)).n;
    if (n !== manifest.tables[name]) problems.push(`${name}: expected ${manifest.tables[name]}, restored ${n}`);
  }
  // Referential integrity after restore.
  const orphans = await db.one(`select
    (select count(*) from anvaya.bookings b where not exists (select 1 from anvaya.students s where s.id = b.student_id)) +
    (select count(*) from anvaya.mentors m where not exists (select 1 from anvaya.users u where u.id = m.user_id)) +
    (select count(*) from anvaya.payments p where not exists (select 1 from anvaya.students s where s.id = p.student_id)) as n`);
  if (orphans.n) problems.push(`${orphans.n} orphaned rows`);
  for (const f of manifest.files) {
    const buf = fs.readFileSync(path.join(dir, 'files', f.path));
    if (crypto.createHash('sha256').update(buf).digest('hex') !== f.sha256) problems.push(`file checksum mismatch: ${f.path}`);
  }
  console.log(problems.length ? `RESTORE CHECK FAILED:\n  ${problems.join('\n  ')}` : `Restore check passed: ${tables.length} tables, ${Object.values(manifest.tables).reduce((a, b) => a + b, 0)} rows, ${manifest.files.length} files verified.`);
  await db.end();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
