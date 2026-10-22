'use strict';
// Configurable defaults stored in anvaya.settings. Financial keys are admin-only.
const db = require('../db');

const FINANCIAL = new Set(['commission_percent']);
const DEFAULTS = {
  group_capacity_default: 8, subscription_grace_days: 5, renewal_reminder_days: [7, 2], booking_hold_minutes: 15,
  booking_min_notice_hours: 12, booking_window_days: 21, commission_percent: 0,
  booking_request_hold_hours: 24,   // how long a requested slot is held while awaiting approval
  booking_payment_hours: 24,        // after approval, time allowed to pay for a paid session
  reschedule_cutoff_hours: 2,       // students can reschedule/cancel online until this many hours before start
  noshow_grace_minutes: 15,         // the host can confirm a no-show only this long after the start
  calendar_host_user_id: null,      // fallback Google account that hosts events when the mentor isn't connected
};

async function all(q = db) {
  const rows = await q.all('select key, value from anvaya.settings');
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}
async function get(key, q = db) {
  const r = await q.one('select value from anvaya.settings where key = $1', [key]);
  return r ? r.value : DEFAULTS[key];
}
async function set(key, value, userId, q = db) {
  if (!(key in DEFAULTS)) throw Object.assign(new Error(`Unknown setting ${key}`), { status: 400 });
  await q.run(`insert into anvaya.settings (key, value, updated_by, updated_at) values ($1, $2, $3, now())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`, [key, JSON.stringify(value), userId]);
}
module.exports = { all, get, set, FINANCIAL, DEFAULTS };
