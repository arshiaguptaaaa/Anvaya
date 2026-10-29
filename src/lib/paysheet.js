'use strict';
// Verified Razorpay payments → the existing Google Sheet (via its Apps Script) + a notification to the team.
//   PAYMENT_SHEET_WEBHOOK_URL  the Apps Script web app the payment page already uses (Bookings tab)
//   PAYMENT_SHEET_TOKEN        shared secret the script checks before it trusts a "verified" row
//   PAYMENT_NOTIFY_EMAIL       who hears about payments and refunds (default teamanvaya.in@gmail.com)
// Only verified sources call this (signed webhook, verified checkout callback, reconciliation, admin refunds).
// Supabase (anvaya.gateway_payments) is the record; the Sheet is a copy keyed by payment id, so a retried
// notification updates the same row instead of adding one. A Sheet failure never blocks access: the payment is
// already committed, the sync job retries with backoff, and an hourly sweep picks up anything still unsynced.
const db = require('../db');
const jobs = require('./jobs');
const { sendEmail } = require('./email');

const SHEET_URL = () => process.env.PAYMENT_SHEET_WEBHOOK_URL || '';
const SHEET_TOKEN = () => process.env.PAYMENT_SHEET_TOKEN || '';
const TEAM = () => process.env.PAYMENT_NOTIFY_EMAIL || 'teamanvaya.in@gmail.com';
const RANK = "array_position(array['failed','paid','partially_refunded','refunded'], %s)";
const PAGE_WAIT_MS = () => Number(process.env.PAYMENT_PAGE_WAIT_MS ?? 30 * 60e3); // how long to wait for the page's own row
const FIRST_TRY_MS = Number(process.env.PAYMENT_SHEET_FIRST_TRY_MS ?? 60e3);
const state = (g) => `${g.status}:${g.refunded_paise}`;
const rs = (p) => (Number(p || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const LABEL = { paid: 'Paid (verified by Razorpay)', failed: 'Failed', refunded: 'Refunded', partially_refunded: 'Partially refunded' };

/** Insert or update one payment's record. A status never moves backwards (a late "failed" can't undo a payment). */
async function upsert(g) {
  const row = await db.one(`insert into anvaya.gateway_payments (provider_payment_id, provider_order_id, payment_id, order_id, student_id, name, email, phone, plan,
      amount_paise, refunded_paise, method, status, error_reason, occurred_at, page_payment)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,coalesce($15, now()),$16)
    on conflict (provider_payment_id) do update set
      provider_order_id = coalesce(excluded.provider_order_id, gateway_payments.provider_order_id),
      payment_id = coalesce(excluded.payment_id, gateway_payments.payment_id),
      order_id = coalesce(excluded.order_id, gateway_payments.order_id),
      student_id = coalesce(excluded.student_id, gateway_payments.student_id),
      name = coalesce(nullif(excluded.name, ''), gateway_payments.name),
      email = coalesce(nullif(excluded.email, ''), gateway_payments.email),
      phone = coalesce(nullif(excluded.phone, ''), gateway_payments.phone),
      plan = coalesce(nullif(excluded.plan, ''), gateway_payments.plan),
      amount_paise = greatest(excluded.amount_paise, gateway_payments.amount_paise),
      refunded_paise = greatest(excluded.refunded_paise, gateway_payments.refunded_paise),
      method = coalesce(nullif(excluded.method, ''), gateway_payments.method),
      status = case when ${RANK.replace('%s', 'excluded.status')} >= ${RANK.replace('%s', 'gateway_payments.status')} then excluded.status else gateway_payments.status end,
      error_reason = case when excluded.status = 'failed' then excluded.error_reason else gateway_payments.error_reason end,
      occurred_at = case when gateway_payments.status = 'failed' and excluded.status <> 'failed' then excluded.occurred_at else gateway_payments.occurred_at end,
      page_payment = gateway_payments.page_payment or excluded.page_payment,
      updated_at = now()
    returning *`,
  [g.provider_payment_id, g.provider_order_id || null, g.payment_id || null, g.order_id || null, g.student_id || null, g.name || '', String(g.email || '').toLowerCase(),
    g.phone || '', g.plan || '', g.amount_paise || 0, g.refunded_paise || 0, g.method || '', g.status, g.error_reason || '', g.occurred_at || null, !!g.page_payment]);
  if (row.sheet_synced_state !== state(row) && row.sheet_status === 'synced') await db.run("update anvaya.gateway_payments set sheet_status = 'pending' where provider_payment_id = $1", [row.provider_payment_id]);
  // A page payment's first sync starts a minute later, by when the page has normally reported it (see paysheet.sync).
  const runAt = row.page_payment && row.status === 'paid' && row.page_reported === null ? new Date(Date.now() + FIRST_TRY_MS) : null;
  await jobs.enqueue('paysheet.sync', { id: row.provider_payment_id }, { dedupeKey: `paysheet:${row.provider_payment_id}:${state(row)}`, maxAttempts: 9, runAt });
  // Page payments: the page's script emails the team itself; the sync job emails only if the page never reported it.
  if (row.status !== 'failed' && !(row.status === 'paid' && row.page_payment && await scriptEmails())) await teamEmail(row);
  await jobs.processDue({ limit: 2, kinds: ['paysheet.sync'] }).catch(() => []);
  return row;
}

/** Records (or refreshes) a gateway payment from our own payment row: paid, partially refunded or refunded. */
async function fromPayment(paymentId) {
  const p = await db.one(`select p.*, o.provider_order_id, o.description, o.source, pr.name as product_name, s.name as student_name, s.email, s.phone,
      (select coalesce(sum(amount_paise),0) from anvaya.refunds r where r.payment_id = p.id and r.status <> 'failed') as refunded
    from anvaya.payments p left join anvaya.orders o on o.id = p.order_id left join anvaya.products pr on pr.id = o.product_id
    join anvaya.students s on s.id = p.student_id where p.id = $1`, [paymentId]);
  if (!p || p.provider !== 'razorpay' || !p.provider_payment_id) return null;
  const refunded = Number(p.refunded);
  return upsert({ provider_payment_id: p.provider_payment_id, provider_order_id: p.provider_order_id, payment_id: p.id, order_id: p.order_id, student_id: p.student_id,
    name: p.student_name, email: p.email, phone: p.phone, plan: p.product_name || p.description, amount_paise: p.amount_paise, refunded_paise: refunded, method: p.method,
    status: refunded >= p.amount_paise ? 'refunded' : refunded > 0 ? 'partially_refunded' : 'paid', occurred_at: p.paid_at, page_payment: p.source === 'public_page_direct' });
}
const fromOrder = async (orderId) => {
  const p = await db.one("select id from anvaya.payments where order_id = $1 and provider = 'razorpay' order by id limit 1", [orderId]);
  return p ? fromPayment(p.id) : null;
};

/** A failed attempt Razorpay reported (payment.failed). Nothing is activated; it's recorded and copied to the Sheet. */
async function fromFailedAttempt(pay) {
  const email = String(pay.email || '').trim().toLowerCase();
  const st = email ? await db.one('select id, name, phone from anvaya.students where lower(email) = $1 order by id limit 1', [email]) : null;
  return upsert({ provider_payment_id: pay.id, provider_order_id: pay.order_id, student_id: st?.id, name: pay.notes?.name || st?.name || '', email,
    phone: String(pay.contact || st?.phone || ''), plan: pay.notes?.plan || pay.description || '', amount_paise: pay.amount, method: pay.method,
    status: 'failed', error_reason: String(pay.error_description || pay.error_reason || 'Payment failed').slice(0, 300),
    occurred_at: pay.created_at ? new Date(pay.created_at * 1000).toISOString() : null });
}

const scriptEmails = async () => (await require('./settings').get('page_confirmation_sender')) !== 'app';
const teamEmail = (row) => sendEmail(TEAM(), 'team_payment', { kind: row.status, name: row.name, email: row.email, phone: row.phone, plan: row.plan, amountPaise: row.amount_paise,
  refundedPaise: row.refunded_paise, paymentId: row.provider_payment_id, at: row.occurred_at }, { dedupeKey: `team-pay:${row.provider_payment_id}:${state(row)}` })
  .catch((e) => console.error('[paysheet] team email', e.message));

const ist = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

jobs.register('paysheet.sync', async ({ id }) => {
  const g = await db.one('select * from anvaya.gateway_payments where provider_payment_id = $1', [id]);
  if (!g || (g.sheet_status === 'synced' && g.sheet_synced_state === state(g))) return { skipped: true };
  if (!SHEET_URL() || !SHEET_TOKEN()) {
    await db.run("update anvaya.gateway_payments set sheet_status = 'not_configured', sheet_error = 'PAYMENT_SHEET_WEBHOOK_URL / PAYMENT_SHEET_TOKEN not set' where provider_payment_id = $1", [id]);
    return { skipped: true };
  }
  try {
    const body = {
      action: 'verified_payment', token: SHEET_TOKEN(), payment_id: g.provider_payment_id, order_id: g.provider_order_id || '',
      // a page payment carries no name (Razorpay doesn't keep the prefill), so the app's fallback is the email's first part: send blank and the Sheet keeps the page's name
      name: g.name && g.name !== g.email.split('@')[0] ? g.name : '', email: g.email, phone: g.phone,
      plan: g.plan, amount: rs(g.amount_paise), refunded: rs(g.refunded_paise), status: g.status === 'partially_refunded' ? `Partially refunded (₹${rs(g.refunded_paise)})` : LABEL[g.status],
      status_code: g.status, date: ist(g.occurred_at), method: g.method, note: g.status === 'failed' ? g.error_reason : '',
      // Duplicate rows are prevented by payment id: the script updates the row with this id. For a page payment it
      // first waits (we retry) for the page's own row, and adds one itself only once the page has clearly not reported it.
      append_if_missing: !(g.page_payment && g.status === 'paid' && g.page_reported === null && Date.now() - new Date(g.occurred_at) < PAGE_WAIT_MS()),
    };
    const resp = await fetch(SHEET_URL(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const text = await resp.text();
    let out = null; try { out = JSON.parse(text); } catch { /* Apps Script error pages are HTML */ }
    if (out?.status === 'waiting') throw new Error('Waiting for the payment page’s own row in the Sheet (matched by payment id)');
    if (!resp.ok || out?.status !== 'ok') throw new Error(`Google Sheet: ${out?.message || `HTTP ${resp.status}${out ? '' : ', not JSON'}`}`);
    if (g.page_payment && g.status === 'paid' && g.page_reported === null) {
      const reported = out.created === false;
      await db.run('update anvaya.gateway_payments set page_reported = $2 where provider_payment_id = $1 and page_reported is null', [id, reported]);
      // the page never reported this payment, so its script sent nothing: the app confirms to the customer and tells the team
      if (!reported && await scriptEmails()) {
        if (g.order_id) await require('./payments').confirmPagePayment(g.order_id);
        await teamEmail(g);
      }
    }
    // Only mark synced if nothing changed while we were sending; otherwise the newer state's job follows.
    await db.run(`update anvaya.gateway_payments set sheet_status = 'synced', sheet_error = '', sheet_synced_at = now(), sheet_synced_state = $2
      where provider_payment_id = $1 and status || ':' || refunded_paise = $2`, [id, state(g)]);
    return { row: out.row ?? null };
  } catch (e) {
    await db.run("update anvaya.gateway_payments set sheet_status = 'failed', sheet_error = $2 where provider_payment_id = $1", [id, String(e.message).slice(0, 300)]);
    throw e; // retried with backoff
  }
});

// Hourly safety net: anything not yet copied (Sheet down for longer than the retries, or configured later).
jobs.register('paysheet.resync', async () => {
  const rows = await db.all("select provider_payment_id, status, refunded_paise from anvaya.gateway_payments where sheet_status <> 'synced' or sheet_synced_state <> status || ':' || refunded_paise order by updated_at limit 100");
  const bucket = new Date().toISOString().slice(0, 13);
  for (const g of rows) await jobs.enqueue('paysheet.sync', { id: g.provider_payment_id }, { dedupeKey: `paysheet:${g.provider_payment_id}:${state(g)}:${bucket}`, maxAttempts: 3 });
  return { queued: rows.length };
});

module.exports = { fromPayment, fromOrder, fromFailedAttempt, upsert };
