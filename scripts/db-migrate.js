'use strict';
// Applies supabase/migrations/*.sql to DATABASE_URL in order, once each (tracked in anvaya_migrations).
//   npm run db:migrate
const fs = require('node:fs');
const path = require('node:path');
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const { Client } = require('pg');

(async () => {
  // Migrations need a session-mode connection (port 5432): DDL + multi-statement scripts in one transaction.
  // Prefer the Supavisor pooler in *session* mode (same host, port 5432): it is reachable over IPv4, unlike
  // Supabase's direct db.<ref>.supabase.co host (IPv6-only on the Free plan).
  const pooled = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  const url = process.env.DATABASE_MIGRATION_URL || (pooled && pooled.replace(':6543/', ':5432/')) || process.env.POSTGRES_URL_NON_POOLING;
  if (!url || !url.startsWith('postgres')) {
    if (process.argv.includes('--if-configured')) { console.log('[migrate] No database configured for this build — skipping.'); return; }
    throw new Error('Set DATABASE_MIGRATION_URL (session pooler, port 5432) to your Supabase Postgres connection string.');
  }
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production' && !process.env.ALLOW_PREVIEW_MIGRATIONS) {
    console.log(`[migrate] ${process.env.VERCEL_ENV} build — skipping (production data is migrated only by production builds).`); return;
  }
  const { cleanPgUrl, sslFor } = require('../src/lib/pgssl');
  const conn = cleanPgUrl(url);
  const c = new Client({ connectionString: conn, ssl: sslFor(conn) }); // verified TLS
  await c.connect();
  await c.query('select pg_advisory_lock(728374619)'); // one migrator at a time; released when the connection closes
  await c.query('create table if not exists public.anvaya_migrations (name text primary key, applied_at timestamptz not null default now())');
  await c.query('alter table public.anvaya_migrations enable row level security');
  await c.query('revoke all on public.anvaya_migrations from anon, authenticated');
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if ((await c.query('select 1 from public.anvaya_migrations where name = $1', [f])).rowCount) { console.log(`= ${f}`); continue; }
    await c.query('begin');
    try {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('insert into public.anvaya_migrations (name) values ($1)', [f]);
      await c.query('commit');
      console.log(`+ ${f}`);
    } catch (e) { await c.query('rollback'); throw new Error(`${f}: ${e.message}`); }
  }
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
