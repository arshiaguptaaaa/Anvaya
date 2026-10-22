'use strict';
// Every email goes through the durable queue: enqueue (inside the business transaction when given q),
// then try to deliver immediately. Failures are retried by the job worker and visible in Admin → System.
const jobs = require('./jobs');
const mailer = require('../mailer');

const db = require('../db');

// Delivery log: queued (in our queue) → sent (provider accepted) → delivered / bounced / complained (provider
// webhook) or failed (our send attempt failed; retried with backoff). Nothing is marked delivered without the
// provider saying so.
jobs.register('email.send', async ({ to, template, data }, job) => {
  try {
    const msg = mailer.render(template, data);
    const out = await mailer.send({ to, ...msg, attachments: data?.__attachments });
    if (job?.id) await db.run("update anvaya.email_log set status = 'sent', provider_id = $2, error = '', updated_at = now() where job_id = $1 and status in ('queued','failed')", [job.id, out?.id || null]);
    // Timeline messages record their real send result (also when a retry succeeds later).
    if (data && data.__entryId) await db.run("update anvaya.record_entries set email_status = 'delivered', email_error = '' where id = $1", [data.__entryId]);
    return out;
  } catch (e) {
    if (job?.id) await db.run("update anvaya.email_log set status = 'failed', error = $2, updated_at = now() where job_id = $1 and status <> 'delivered'", [job.id, String(e.message).slice(0, 300)]);
    throw e;
  }
});

/**
 * Queue an email. secret=true encrypts the payload at rest (used for links carrying tokens).
 * Returns { jobId, delivered, error } — delivered=false means it's queued for retry.
 */
async function sendEmail(to, template, data, { secret = false, q, dedupeKey, runAt, immediate = true } = {}) {
  const jobId = await jobs.enqueue('email.send', { to, template, data }, { secret, q, dedupeKey, runAt });
  if (jobId) {
    await (q || db).run(`insert into anvaya.email_log (job_id, to_email, template, booking_id) values ($1,$2,$3,$4) on conflict (job_id) do nothing`,
      [jobId, to, template, data?.__bookingId || null]);
  }
  if (!immediate || q || runAt || !jobId) return { jobId, delivered: false, queued: !!jobId };
  const r = await jobs.runNow(jobId);
  return { jobId, delivered: !!r.ok && !r.skipped, error: r.ok ? null : r.error };
}

module.exports = { sendEmail };
