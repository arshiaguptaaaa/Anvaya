'use strict';
// Payment-page checkout enquiries (anvaya.checkout_enquiries), from "details submitted, checkout opened" to paid.
//   started    the visitor submitted name/email/phone and opened Razorpay checkout
//   failed     Razorpay reported a failed payment (signed webhook) — closing the window is never a failure
//   abandoned  30 minutes after the last checkout activity with no verified payment
//   converted  a verified payment for this enquiry (notes.enquiry) or the same email + plan since it started
// With the visitor's consent: one recovery email 1 hour after the last activity and a final one after 24 hours,
// each sent once, re-checked against verified payments (and Razorpay itself when keys are set) right before sending.
// Each enquiry is one row in the Sheet's "Abandoned Checkouts" tab, updated in place by enquiry id.
const crypto = require('node:crypto');
const db = require('../db');
const jobs = require('./jobs');
const { sendEmail } = require('./email');

const ABANDON_MS = () => Number(process.env.ENQUIRY_ABANDON_MS ?? 30 * 60e3);
const RECOVERY_MS = () => [Number(process.env.ENQUIRY_RECOVERY1_MS ?? 60 * 60e3), Number(process.env.ENQUIRY_RECOVERY2_MS ?? 24 * 3600e3)];
const SITE = () => (process.env.PUBLIC_SITE_URL || 'https://anvayacareers.in').replace(/\/$/, '');
const BASE_URL = () => (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const TEAM = () => process.env.PAYMENT_NOTIFY_EMAIL || 'teamanvaya.in@gmail.com';
const REF_PCT = 0.10, REF_CAP_PAISE = 15000; // the payment page's referral rule
const LABEL = { started: 'Checkout started', failed: 'Payment failed', abandoned: 'Abandoned (no payment after 30 min)', converted: 'Converted (paid)' };

const priceFor = (product, ref) => Number(product.price_paise) - (ref ? Math.min(Math.round(Number(product.price_paise) * REF_PCT / 100) * 100, REF_CAP_PAISE) : 0);
const stopToken = (publicId) => crypto.createHmac('sha256', process.env.APP_SECRET || 'dev-secret').update(`enquiry-stop:${publicId}`).digest('base64url').slice(0, 32);
const state = (e) => [e.status, e.consent && !e.unsubscribed_at ? 'c' : '', e.recovery1_job_id || '', e.recovery2_job_id || '', e.closed_count, e.provider_payment_id || ''].join(':');

/** Details submitted + checkout opened. Reuses the open enquiry for this email + plan, so retries never add rows. */
async function start({ name, email, phone, product, refCode = '', consent = false, publicId = null, refSource = '', refFirst = '', entry = '' }) {
  const amount = priceFor(product, refCode);
  const e = await db.tx(async (t) => {
    let row = publicId ? await t.one("select * from anvaya.checkout_enquiries where public_id = $1 and status <> 'converted' for update", [publicId]) : null;
    if (row && (row.email !== email || row.plan_key !== product.public_key)) row = null; // different person or plan: its own enquiry
    if (!row) row = await t.one("select * from anvaya.checkout_enquiries where lower(email) = $1 and plan_key = $2 and status <> 'converted' for update", [email, product.public_key]);
    if (row) {
      return t.one(`update anvaya.checkout_enquiries set name = $2, phone = $3, amount_paise = $4, ref_code = $5,
          consent = $6, consent_at = case when $6 and not consent then now() else consent_at end,
          ref_source = coalesce(nullif($7, ''), ref_source), ref_first = case when ref_first = '' then $8 else ref_first end, entry = coalesce(nullif($9, ''), entry),
          status = case when status = 'abandoned' then 'started' else status end, attempts = attempts + 1, last_event = 'checkout_started',
          last_activity_at = now(), updated_at = now() where id = $1 returning *`, [row.id, name, phone, amount, refCode, !!consent, refSource, refFirst, entry]);
    }
    return t.one(`insert into anvaya.checkout_enquiries (public_id, name, email, phone, plan_key, plan_name, amount_paise, ref_code, consent, consent_at, ref_source, ref_first, entry)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9, case when $9 then now() end, $10, $11, $12) returning *`,
    [`enq_${crypto.randomBytes(12).toString('base64url')}`, name, email, phone, product.public_key, product.name, amount, refCode, !!consent, refSource, refFirst || refSource, entry]);
  });
  await jobs.enqueue('enquiries.check_abandon', { id: e.id }, { dedupeKey: `enq-abandon:${e.id}:${e.attempts}`, runAt: new Date(Date.now() + ABANDON_MS()) });
  await queueSheet(e);
  return e;
}

/** Checkout window closed, or the browser saw a failure (unverified): recorded as an event only. */
async function event(publicId, what) {
  const e = await db.one(`update anvaya.checkout_enquiries set closed_count = closed_count + case when $2 = 'closed' then 1 else 0 end,
      last_event = $2, last_activity_at = now(), updated_at = now() where public_id = $1 and status <> 'converted' returning *`, [publicId, what]);
  if (e) await queueSheet(e);
  return e;
}

/** Razorpay's signed payment.failed for a page payment. */
async function failedFromPayment(pay) {
  const e = await find(pay);
  if (!e || e.status === 'converted') return null;
  const row = await db.one(`update anvaya.checkout_enquiries set status = 'failed', failed_at = now(), last_event = 'payment_failed',
      failure_reason = $2, updated_at = now() where id = $1 and status <> 'converted' returning *`, [e.id, String(pay.error_description || pay.error_reason || 'Payment failed').slice(0, 200)]);
  if (row) { await queueSheet(row); await scheduleRecovery(row); }
  return row;
}

/** A verified payment: converts the matching enquiry and cancels any recovery email not yet sent. */
async function convert({ publicId = null, email, planName, providerPaymentId = null, orderId = null, studentId = null }) {
  const e = await find({ notes: { enquiry: publicId, plan: planName }, email });
  if (!e || e.status === 'converted') return e;
  const row = await db.one(`update anvaya.checkout_enquiries set status = 'converted', converted_at = now(), last_event = 'payment_verified',
      provider_payment_id = coalesce($2, provider_payment_id), order_id = coalesce($3, order_id), student_id = coalesce($4, student_id), updated_at = now()
    where id = $1 and status <> 'converted' returning *`, [e.id, providerPaymentId, orderId, studentId]);
  if (!row) return e;
  await db.run("update anvaya.jobs set status = 'cancelled', finished_at = now(), last_error = 'Enquiry converted' where dedupe_key in ($1, $2) and status in ('queued','failed')",
    [`enq-mail:${row.id}:1`, `enq-mail:${row.id}:2`]);
  await db.run("update anvaya.jobs set status = 'cancelled', finished_at = now(), last_error = 'Enquiry converted' where kind = 'enquiries.recover' and payload->>'id' = $1 and status in ('queued','failed')", [String(row.id)]);
  await queueSheet(row);
  return row;
}
const convertForOrder = async (orderId) => {
  const o = await db.one(`select o.id, o.student_id, s.email, p.name as plan, p.public_key, (select provider_payment_id from anvaya.payments where order_id = o.id order by id limit 1) as pid
    from anvaya.orders o join anvaya.students s on s.id = o.student_id left join anvaya.products p on p.id = o.product_id where o.id = $1 and o.status = 'paid'`, [orderId]);
  if (!o || !o.public_key || !o.email) return null;
  return convert({ email: o.email, planName: o.plan, providerPaymentId: o.pid, orderId: o.id, studentId: o.student_id });
};

/** The open enquiry a payment belongs to: by the id the page put in notes, else the same email + plan. */
async function find(pay) {
  const id = pay.notes?.enquiry;
  if (id) { const e = await db.one('select * from anvaya.checkout_enquiries where public_id = $1', [String(id)]); if (e) return e; }
  const email = String(pay.email || '').trim().toLowerCase();
  if (!email || !pay.notes?.plan) return null;
  return db.one(`select * from anvaya.checkout_enquiries where lower(email) = $1 and plan_name = $2 order by (status = 'converted'), id desc limit 1`, [email, String(pay.notes.plan)]);
}

async function scheduleRecovery(e) {
  if (!e.consent || e.unsubscribed_at || e.status === 'converted') return;
  const base = new Date(e.last_activity_at).getTime();
  const [one, two] = RECOVERY_MS();
  await jobs.enqueue('enquiries.recover', { id: e.id, step: 1 }, { dedupeKey: `enq-recover:${e.id}:1`, runAt: new Date(Math.max(Date.now(), base + one)) });
  await jobs.enqueue('enquiries.recover', { id: e.id, step: 2 }, { dedupeKey: `enq-recover:${e.id}:2`, runAt: new Date(Math.max(Date.now(), base + two)) });
}

jobs.register('enquiries.check_abandon', async ({ id }) => {
  const e = await db.one('select * from anvaya.checkout_enquiries where id = $1', [id]);
  if (!e || e.status !== 'started') return { skipped: e?.status };
  if (await paidSince(e)) return { converted: true };
  const due = new Date(e.last_activity_at).getTime() + ABANDON_MS();
  if (Date.now() < due) { // more activity since (another attempt): check again later
    await jobs.enqueue('enquiries.check_abandon', { id }, { dedupeKey: `enq-abandon:${id}:${e.attempts}:${due}`, runAt: new Date(due) });
    return { later: true };
  }
  const row = await db.one(`update anvaya.checkout_enquiries set status = 'abandoned', abandoned_at = now(), updated_at = now() where id = $1 and status = 'started' returning *`, [id]);
  if (row) { await queueSheet(row); await scheduleRecovery(row); }
  return { abandoned: !!row };
});

/** True (and converts the enquiry) if a verified payment for it exists — recorded here, or found at Razorpay. */
async function paidSince(e) {
  const since = new Date(new Date(e.started_at).getTime() - 5 * 60e3);
  const local = await db.one(`select provider_payment_id, order_id, student_id from anvaya.gateway_payments
    where lower(email) = lower($1) and plan = $2 and status <> 'failed' and occurred_at >= $3 order by occurred_at limit 1`, [e.email, e.plan_name, since]);
  if (local) { await convert({ publicId: e.public_id, email: e.email, planName: e.plan_name, providerPaymentId: local.provider_payment_id, orderId: local.order_id, studentId: local.student_id }); return true; }
  const payments = require('./payments');
  if (!payments.configured()) return false;
  try { // a payment whose notification never arrived: record it now (this also activates the purchase)
    const r = await payments.rzp('GET', `/payments?from=${Math.floor(since.getTime() / 1000)}&count=100`);
    const hit = (r.items || []).find((p) => p.status === 'captured' && (p.notes?.enquiry === e.public_id || (String(p.email || '').toLowerCase() === e.email.toLowerCase() && p.notes?.plan === e.plan_name)));
    if (!hit) return false;
    await payments.recordPagePayment(hit);
    await convert({ publicId: e.public_id, email: e.email, planName: e.plan_name, providerPaymentId: hit.id });
    return true;
  } catch (err) {
    throw Object.assign(new Error(`Couldn’t check Razorpay before emailing: ${err.message}`), { status: 502 }); // retried; never email on doubt
  }
}

jobs.register('enquiries.recover', async ({ id, step }) => {
  const e = await db.one('select * from anvaya.checkout_enquiries where id = $1', [id]);
  if (!e || !['abandoned', 'failed'].includes(e.status) || !e.consent || e.unsubscribed_at) return { skipped: e?.status || 'missing' };
  if (await paidSince(e)) return { skipped: 'paid' };
  const product = await db.one('select * from anvaya.products where public_key = $1 and active', [e.plan_key]);
  const price = product ? priceFor(product, e.ref_code) : null;
  const resumeUrl = `${SITE()}/anvaya-payment.html?${new URLSearchParams({ ...(product ? { plan: e.plan_key } : {}), ...(e.ref_code ? { ref: e.ref_code } : {}) })}`;
  const r = await sendEmail(e.email, 'checkout_recovery', {
    step, name: (e.name || '').split(' ')[0] || 'there', plan: product?.name || e.plan_name, pricePaise: price, available: !!product, failed: e.status === 'failed',
    resumeUrl, chatUrl: `${SITE()}/#chat`, stopUrl: `${BASE_URL()}/api/public/checkout/enquiry/${e.public_id}/stop?t=${stopToken(e.public_id)}`,
  }, { dedupeKey: `enq-mail:${e.id}:${step}` });
  if (r.jobId) {
    const row = await db.one(`update anvaya.checkout_enquiries set recovery${step === 1 ? 1 : 2}_job_id = $2, updated_at = now() where id = $1 returning *`, [e.id, r.jobId]);
    await queueSheet(row);
  }
  return { sent: r.delivered, queued: !r.delivered };
});

async function unsubscribe(publicId, token) {
  const want = stopToken(publicId);
  if (typeof token !== 'string' || token.length !== want.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(want))) return null;
  const e = await db.one("update anvaya.checkout_enquiries set unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now() where public_id = $1 returning *", [publicId]);
  if (e) {
    await db.run("update anvaya.jobs set status = 'cancelled', finished_at = now(), last_error = 'Unsubscribed' where kind = 'enquiries.recover' and payload->>'id' = $1 and status in ('queued','failed')", [String(e.id)]);
    await queueSheet(e);
  }
  return e;
}

/** Recovery email progress in words, from the real delivery log (queued / sent / delivered / bounced / failed / cancelled). */
async function followUp(e) {
  if (!e.consent) return 'No follow-up (not agreed)';
  const parts = [];
  for (const [n, jid] of [[1, e.recovery1_job_id], [2, e.recovery2_job_id]]) {
    if (!jid) { parts.push(`email ${n}: ${e.status === 'converted' || e.unsubscribed_at ? 'cancelled' : 'not yet due'}`); continue; }
    const l = await db.one('select l.status, j.status as job from anvaya.email_log l left join anvaya.jobs j on j.id = l.job_id where l.job_id = $1', [jid]);
    parts.push(`email ${n}: ${l?.job === 'cancelled' ? 'cancelled' : l?.status || 'queued'}`);
  }
  return (e.unsubscribed_at ? 'Unsubscribed · ' : 'Agreed · ') + parts.join(' · ');
}

// ── Sheet copy: one row per enquiry in "Abandoned Checkouts", updated in place ──
async function queueSheet(e) {
  await jobs.enqueue('enquiries.sheet_sync', { id: e.id }, { dedupeKey: `enq-sheet:${e.id}:${state(e)}`, maxAttempts: 8 });
  await jobs.processDue({ limit: 2, kinds: ['enquiries.sheet_sync'] }).catch(() => []);
}
const ist = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '');

jobs.register('enquiries.sheet_sync', async ({ id }) => {
  const e = await db.one('select * from anvaya.checkout_enquiries where id = $1', [id]);
  if (!e) return { skipped: true };
  const url = process.env.PAYMENT_SHEET_WEBHOOK_URL, token = process.env.PAYMENT_SHEET_TOKEN;
  if (!url || !token) { await db.run("update anvaya.checkout_enquiries set sheet_status = 'not_configured' where id = $1", [id]); return { skipped: true }; }
  const st = state(e);
  if (e.sheet_status === 'synced' && e.sheet_synced_state === st) return { skipped: true };
  const statusText = e.status === 'failed' ? `Payment failed: ${e.failure_reason}` : e.status === 'converted' ? `Converted (paid${e.provider_payment_id ? `, ${e.provider_payment_id}` : ''})` : LABEL[e.status];
  const body = { action: 'enquiry', token, enquiry_id: e.public_id, date: ist(e.started_at), name: e.name, email: e.email, phone: e.phone, plan: e.plan_name,
    amount: (Number(e.amount_paise) / 100).toLocaleString('en-IN'), status: statusText, follow_up: await followUp(e),
    updated: `${ist(new Date())} · ${e.attempts} attempt${e.attempts === 1 ? '' : 's'}${e.closed_count ? `, closed ${e.closed_count}×` : ''}` };
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'follow', signal: AbortSignal.timeout(20000) });
    let out = null; try { out = JSON.parse(await resp.text()); } catch { /* HTML error page */ }
    if (!resp.ok || out?.status !== 'ok') throw new Error(`Google Sheet: ${out?.message || `HTTP ${resp.status}`}`);
    await db.run("update anvaya.checkout_enquiries set sheet_status = 'synced', sheet_error = '', sheet_synced_state = $2 where id = $1", [id, st]);
    return { row: out.row ?? null };
  } catch (err) {
    await db.run("update anvaya.checkout_enquiries set sheet_status = 'failed', sheet_error = $2 where id = $1", [id, String(err.message).slice(0, 300)]);
    throw err;
  }
});

// Hourly: re-copy anything the Sheet missed; refresh rows whose email delivery status changed.
jobs.register('enquiries.resync', async () => {
  const rows = await db.all(`select * from anvaya.checkout_enquiries where sheet_status <> 'synced' or (updated_at > now() - interval '2 days' and (recovery1_job_id is not null or recovery2_job_id is not null)) order by id limit 200`);
  const bucket = new Date().toISOString().slice(0, 13);
  for (const e of rows) await jobs.enqueue('enquiries.sheet_sync', { id: e.id }, { dedupeKey: `enq-sheet:${e.id}:${state(e)}:${bucket}:${await followUp(e)}`, maxAttempts: 3 });
  return { queued: rows.length };
});

// ── Daily summary to the team (once per IST day, from 09:00 IST) ──
jobs.register('enquiries.daily_summary', async ({ day }) => {
  const since = new Date(Date.now() - 24 * 3600e3);
  const counts = await db.one(`select count(*) filter (where started_at >= $1)::int as started,
      count(*) filter (where status = 'failed' and failed_at >= $1)::int as failed,
      count(*) filter (where status = 'abandoned' and abandoned_at >= $1)::int as abandoned,
      count(*) filter (where status = 'converted' and converted_at >= $1)::int as converted,
      count(*) filter (where status in ('failed','abandoned'))::int as open_total from anvaya.checkout_enquiries`, [since]);
  const recovered = await db.one(`select count(*)::int as n from anvaya.checkout_enquiries where status = 'converted' and converted_at >= $1 and (abandoned_at is not null or failed_at is not null)`, [since]);
  const emails = await db.one(`select count(*)::int as n from anvaya.email_log where template = 'checkout_recovery' and status in ('sent','delivered') and created_at >= $1`, [since]);
  const open = await db.all(`select name, email, phone, plan_name, amount_paise, status, consent, last_activity_at from anvaya.checkout_enquiries
    where status in ('failed','abandoned') and last_activity_at >= now() - interval '3 days' order by last_activity_at desc limit 25`);
  const conv = await db.all(`select name, email, plan_name, amount_paise, converted_at from anvaya.checkout_enquiries where status = 'converted' and converted_at >= $1 order by converted_at desc limit 25`, [since]);
  return sendEmail(TEAM(), 'team_checkout_summary', { day, ...counts, recovered: recovered.n, recoveryEmails: emails.n, open, conv, crmUrl: `${BASE_URL()}/admin#checkouts` },
    { dedupeKey: `enq-summary:${day}` });
});
async function scheduleDailySummary(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60e3);
  if (ist.getUTCHours() < 9) return;
  const day = ist.toISOString().slice(0, 10);
  await jobs.enqueue('enquiries.daily_summary', { day }, { dedupeKey: `enq-summary-job:${day}` });
}

module.exports = { start, event, failedFromPayment, convert, convertForOrder, unsubscribe, scheduleDailySummary, priceFor, stopToken, followUp, LABEL };
