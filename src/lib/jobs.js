'use strict';
// Durable job queue on Postgres (anvaya.jobs). Jobs are claimed with SKIP LOCKED, retried with
// exponential backoff, and marked dead after max_attempts. Drained:
//   • inline right after enqueue when the caller wants immediate feedback (runNow),
//   • after responses via waitUntil (Vercel) — see kick(),
//   • by Vercel Cron → /api/cron/run.
// Secrets in payloads (e.g. invitation links) are encrypted with APP_SECRET and wiped on success.
const crypto = require('node:crypto');
const db = require('../db');

const handlers = new Map();
const register = (kind, fn) => handlers.set(kind, fn);

function key() {
  const s = process.env.APP_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-insecure-app-secret');
  if (!s) throw new Error('APP_SECRET is not set.');
  return crypto.createHash('sha256').update(s).digest();
}
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { enc: Buffer.concat([iv, c.getAuthTag(), data]).toString('base64') };
}
function unseal(p) {
  if (!p || !p.enc) return p;
  const buf = Buffer.from(p.enc, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}

/** Enqueue a job. q may be a transaction handle so the job commits with the business change. */
async function enqueue(kind, payload = {}, { runAt = null, dedupeKey = null, secret = false, maxAttempts = 5, q = db } = {}) {
  const row = await q.one(`insert into anvaya.jobs (kind, payload, run_at, dedupe_key, max_attempts)
    values ($1, $2, coalesce($3, now()), $4, $5) on conflict (dedupe_key) do nothing returning id`,
  [kind, JSON.stringify(secret ? seal(payload) : payload), runAt, dedupeKey, maxAttempts]);
  return row ? row.id : null;
}

const backoffSeconds = (attempt) => Math.min(3600, 30 * 2 ** (attempt - 1));

async function execute(job) {
  const fn = handlers.get(job.kind);
  try {
    if (!fn) throw new Error(`No handler for job kind "${job.kind}"`);
    const result = await fn(unseal(job.payload), job);
    await db.run(`update anvaya.jobs set status = 'done', finished_at = now(), locked_until = null, last_error = null,
      payload = case when payload ? 'enc' then '{}'::jsonb else payload end where id = $1`, [job.id]);
    return { ok: true, result };
  } catch (e) {
    const dead = job.attempts >= job.max_attempts;
    await db.run(`update anvaya.jobs set status = $2, last_error = $3, locked_until = null,
      run_at = now() + ($4 || ' seconds')::interval, finished_at = case when $2 = 'dead' then now() else null end where id = $1`,
    [job.id, dead ? 'dead' : 'failed', String(e.message || e).slice(0, 1000), String(backoffSeconds(job.attempts))]);
    if (dead) console.error(`[jobs] ${job.kind} #${job.id} dead after ${job.attempts} attempts: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** Claims and runs one specific job now (used right after enqueue for immediate feedback). */
async function runNow(jobId) {
  if (!jobId) return { ok: true, skipped: true };
  const job = await db.one(`update anvaya.jobs set status = 'running', attempts = attempts + 1, locked_until = now() + interval '2 minutes'
    where id = $1 and status in ('queued','failed') returning *`, [jobId]);
  if (!job) return { ok: true, skipped: true };
  return execute(job);
}

/** Claims due jobs (including ones whose worker died) and runs them sequentially. */
async function processDue({ limit = 10, kinds = null } = {}) {
  const jobs = await db.all(`update anvaya.jobs set status = 'running', attempts = attempts + 1, locked_until = now() + interval '2 minutes'
    where id in (
      select id from anvaya.jobs
      where ((status in ('queued','failed') and run_at <= now()) or (status = 'running' and locked_until < now()))
        and ($2::text[] is null or kind = any($2::text[]))
      order by run_at limit $1 for update skip locked)
    returning *`, [limit, kinds]);
  const results = [];
  for (const j of jobs) results.push({ id: j.id, kind: j.kind, ...(await execute(j)) });
  return results;
}

/** Best-effort background drain after a response (Vercel waitUntil keeps the function alive). */
let lastKick = 0;
function kick() {
  if (process.env.JOBS_AUTORUN === 'false') return;
  if (Date.now() - lastKick < 20_000) return;
  lastKick = Date.now();
  const p = processDue({ limit: 5 }).catch((e) => console.error('[jobs] kick failed:', e.message));
  try { require('@vercel/functions').waitUntil(p); } catch { /* local dev: promise just runs */ }
}

module.exports = { register, enqueue, runNow, processDue, kick, seal, unseal };
