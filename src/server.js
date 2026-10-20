'use strict';
// Standalone server: local development and long-running hosts such as Hostinger. On Vercel, api/index.js serves the same app.
const fs = require('node:fs');
const path = require('node:path');
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE) && !process.env.SKIP_DOTENV) process.loadEnvFile(ENV_FILE);

const app = require('./app');
const mailer = require('./mailer');
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Anvaya running on port ${PORT}  (mail: ${mailer.mailMode()})`));

// Built-in scheduler for long-running hosts: queues 24h/2h session reminders, renewals and retries every 5 minutes,
// then drains the job queue. The host's cron job (GET /api/cron/run) is a second trigger in case the process was asleep.
const every = Number(process.env.SCHEDULER_MINUTES ?? (process.env.NODE_ENV === 'production' ? 5 : 0));
if (every > 0 && (process.env.DATABASE_URL || process.env.POSTGRES_URL)) {
  const { schedulePeriodic } = require('./lib/maintenance');
  const jobs = require('./lib/jobs');
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await schedulePeriodic(); await jobs.processDue({ limit: 40 }); } catch (e) { console.error('[scheduler]', e.message); } finally { running = false; }
  };
  setTimeout(tick, 15e3);
  setInterval(tick, every * 60e3).unref();
}
