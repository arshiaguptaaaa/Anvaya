'use strict';
// Postgres data layer (Supabase in production). All tables live in the "anvaya" schema.
//   DATABASE_URL=postgres://…            → node-postgres pool (Supabase pooler, port 6543)
//   DATABASE_URL=pglite://memory          → in-process Postgres (tests)
//   DATABASE_URL=pglite://data/pg         → in-process Postgres persisted to a folder (local dev only)
const fs = require('node:fs');
const path = require('node:path');

// DATABASE_URL (preferred) or POSTGRES_URL (set automatically by the Supabase ↔ Vercel integration).
const RAW_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
/** Strips libpq-only query params (sslmode, supa, pgbouncer) — TLS is configured explicitly below. */
const cleanPgUrl = (u) => {
  if (!/^postgres/.test(u)) return u;
  const x = new URL(u);
  for (const k of ['sslmode', 'supa', 'pgbouncer', 'sslrootcert']) x.searchParams.delete(k);
  return x.toString();
};
const URL_ = cleanPgUrl(RAW_URL);
let driver;

if (URL_.startsWith('pglite://')) {
  let pg;
  const ready = (async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
    const loc = URL_.slice('pglite://'.length);
    const opts = { parsers: { 20: Number, 1700: Number }, extensions: { btree_gist } };
    pg = loc === 'memory' ? new PGlite(opts) : new PGlite(path.resolve(__dirname, '..', loc), opts);
    // Stand-ins for Supabase's built-in roles so the migrations' GRANT/REVOKEs run unchanged.
    await pg.exec("do $$ begin create role anon; exception when duplicate_object then null; end $$; do $$ begin create role authenticated; exception when duplicate_object then null; end $$;");
    await pg.exec('create table if not exists public.anvaya_migrations (name text primary key, applied_at timestamptz not null default now())');
    const dir = path.join(__dirname, '..', 'supabase', 'migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      if ((await pg.query('select 1 from public.anvaya_migrations where name = $1', [f])).rows.length) continue;
      await pg.transaction(async (t) => {
        await t.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
        await t.query('insert into public.anvaya_migrations (name) values ($1)', [f]);
      });
    }
  })();
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; }; // PGlite is single-connection
  driver = {
    query: async (text, params) => { await ready; return serial(() => pg.query(text, params)); },
    tx: async (fn) => { await ready; return serial(() => pg.transaction((t) => fn({ query: (text, params) => t.query(text, params) }))); },
    end: async () => { await ready; await pg.close(); },
  };
} else if (URL_) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, Number);   // bigint ids / counts → numbers (all well below 2^53)
  types.setTypeParser(1700, Number); // numeric sums → numbers
  const pool = new Pool({
    connectionString: URL_,
    max: Number(process.env.PG_POOL_MAX || 3),            // small: each serverless instance has its own pool
    idleTimeoutMillis: 10_000,
    ssl: /localhost|127\.0\.0\.1/.test(URL_) ? false : { rejectUnauthorized: false },
    // Supavisor transaction mode (port 6543) can't hold named prepared statements across transactions.
    // node-postgres only creates named statements when a query passes `name`, which this codebase never does.
  });
  // On Vercel Fluid compute, release idle pooled clients before the instance is suspended.
  if (process.env.VERCEL) { try { require('@vercel/functions').attachDatabasePool(pool); } catch { /* older runtime */ } }
  driver = {
    query: (text, params) => pool.query(text, params),
    tx: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        const r = await fn({ query: (text, params) => c.query(text, params) });
        await c.query('commit');
        return r;
      } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
    },
    end: () => pool.end(),
  };
} else {
  driver = null;
}

function need() { if (!driver) throw new Error('DATABASE_URL is not set.'); return driver; }

/** Rows for a query. Tables are referenced schema-qualified (anvaya.x) so this works under any search_path. */
const all = async (text, params = []) => (await need().query(text, params)).rows;
const one = async (text, params = []) => (await need().query(text, params)).rows[0];
const run = async (text, params = []) => { const r = await need().query(text, params); return { rowCount: r.rowCount ?? r.affectedRows ?? 0, rows: r.rows }; };
/** Transaction: fn receives { all, one, run } bound to a single connection. */
const tx = (fn) => need().tx(async (c) => fn({
  all: async (t, p = []) => (await c.query(t, p)).rows,
  one: async (t, p = []) => (await c.query(t, p)).rows[0],
  run: async (t, p = []) => { const r = await c.query(t, p); return { rowCount: r.rowCount ?? r.affectedRows ?? 0, rows: r.rows }; },
}));
const audit = (userId, action, detail = '') =>
  run('insert into anvaya.audit_log (user_id, action, detail) values ($1,$2,$3)', [userId ?? null, action, String(detail)]).catch(() => {});

module.exports = { cleanPgUrl, all, one, run, tx, audit, end: () => driver && driver.end(), configured: () => !!driver };
