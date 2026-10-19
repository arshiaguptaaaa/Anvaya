'use strict';
// TLS settings for Postgres connections, always with certificate verification.
// Supabase hosts (*.supabase.com / *.supabase.co, incl. the Supavisor pooler) are signed by Supabase's own
// root CA, bundled here (public certificate, valid to 2031). Other hosts use the system trust store.
const fs = require('node:fs');
const path = require('node:path');

const SUPABASE_CA = fs.readFileSync(path.join(__dirname, '..', 'certs', 'supabase-prod-ca-2021.crt'), 'utf8');

/** Returns the `ssl` option for node-postgres for a connection string. */
function sslFor(url) {
  const host = new URL(url).hostname;
  if (/^(localhost|127\.0\.0\.1|::1)$/.test(host)) return false;
  if (/\.supabase\.(com|co)$/.test(host)) return { ca: SUPABASE_CA, rejectUnauthorized: true, servername: host };
  return { rejectUnauthorized: true };
}

/** Strips libpq-only query params (sslmode, supa, pgbouncer…) — TLS is configured via sslFor(). */
function cleanPgUrl(u) {
  if (!/^postgres/.test(u)) return u;
  const x = new URL(u);
  for (const k of ['sslmode', 'supa', 'pgbouncer', 'sslrootcert', 'sslcert', 'sslkey']) x.searchParams.delete(k);
  return x.toString();
}

module.exports = { sslFor, cleanPgUrl };
