'use strict';
// Every email goes through the durable queue: enqueue (inside the business transaction when given q),
// then try to deliver immediately. Failures are retried by the job worker and visible in Admin → System.
const jobs = require('./jobs');
const mailer = require('../mailer');

jobs.register('email.send', async ({ to, template, data }) => {
  const msg = mailer.render(template, data);
  return mailer.send({ to, ...msg });
});

/**
 * Queue an email. secret=true encrypts the payload at rest (used for links carrying tokens).
 * Returns { jobId, delivered, error } — delivered=false means it's queued for retry.
 */
async function sendEmail(to, template, data, { secret = false, q, dedupeKey, runAt, immediate = true } = {}) {
  const jobId = await jobs.enqueue('email.send', { to, template, data }, { secret, q, dedupeKey, runAt });
  if (!immediate || q || runAt) return { jobId, delivered: false, queued: true };
  const r = await jobs.runNow(jobId);
  return { jobId, delivered: !!r.ok && !r.skipped, error: r.ok ? null : r.error };
}

module.exports = { sendEmail };
