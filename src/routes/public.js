'use strict';
// Public endpoints used by the brochure. Supabase is the source of truth for enquiries; the Google Sheet
// is a secondary copy written by a tracked background job (failures are visible and retryable in the CRM).
const express = require('express');
const db = require('../db');
const sec = require('../security');
const jobs = require('../lib/jobs');
const { HttpError, bad, v, wrap } = require('../lib/http');

const r = express.Router();
const SHEET_URL = () => process.env.GOOGLE_SHEET_WEBHOOK_URL || '';
const BASE_URL = () => (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const IS_PROD = process.env.NODE_ENV === 'production';

jobs.register('leads.sheet_sync', async ({ leadId }) => {
  const l = await db.one('select * from anvaya.leads where id = $1', [leadId]);
  if (!l || l.sheet_sync_status === 'synced') return;
  if (!SHEET_URL()) { await db.run("update anvaya.leads set sheet_sync_status = 'not_required' where id = $1", [leadId]); return; }
  try {
    // Same fields the brochure's own form sends to the Apps Script.
    const body = new URLSearchParams({ action: 'freechat', name: l.name, phone: l.phone, situation: l.situation });
    const resp = await fetch(SHEET_URL(), { method: 'POST', body, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`Google Sheet returned HTTP ${resp.status}`);
    await db.run("update anvaya.leads set sheet_sync_status = 'synced', sheet_sync_error = '', sheet_synced_at = now() where id = $1", [leadId]);
  } catch (e) {
    await db.run("update anvaya.leads set sheet_sync_status = 'failed', sheet_sync_error = $2 where id = $1", [leadId, String(e.message).slice(0, 300)]);
    throw e; // retried with backoff by the job worker
  }
});

const allowedOrigins = () => [BASE_URL(), ...(process.env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)];
// The brochure may live on another origin (split setup: anvayacareers.in → app.anvayacareers.in), so this one
// endpoint answers CORS for the configured origins only. No cookies are involved (credentials: 'omit').
r.use(['/public/leads', '/public/checkout', '/public/checkout/verify'], (req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins().includes(origin)) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
  if (req.method !== 'OPTIONS') return next();
  if (!origin || !allowedOrigins().includes(origin)) return res.status(403).end();
  res.set({ 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' }).status(204).end();
});

const leadLimiter = sec.rateLimiter({ name: 'lead', windowMs: 60 * 60e3, max: 10, key: (req) => req.ip });
r.post('/public/leads', leadLimiter, wrap(async (req, res) => {
  const origin = req.get('origin');
  const allowed = allowedOrigins();
  if (origin && !allowed.includes(origin) && !(!IS_PROD && /^http:\/\/localhost(:\d+)?$/.test(origin))) throw new HttpError(403, 'Forbidden.');
  const b = req.body || {};
  if (b.website) return res.status(201).json({ ok: true }); // honeypot
  const name = v.str(b.name, { max: 120, required: true, label: 'Name' });
  const phone = v.str(b.phone, { max: 40, required: true, label: 'Phone' });
  if (!/^[+\d][\d\s()-]{6,}$/.test(phone)) throw bad('Please enter a valid phone number.');
  const situation = v.str(b.situation, { max: 200, label: 'Situation' });
  const dup = await db.one("select id from anvaya.leads where phone = $1 and name = $2 and created_at > now() - interval '10 minutes'", [phone, name]);
  if (dup) return res.status(201).json({ ok: true, id: dup.id });
  const lead = await db.tx(async (t) => {
    const l = await t.one(`insert into anvaya.leads (name, phone, situation, source, sheet_sync_status, follow_up_at, next_action)
      values ($1,$2,$3,'Free 15-min chat (website)',$4, now() + interval '4 hours', 'Call / WhatsApp to set up the free chat') returning id`,
    [name, phone, situation, SHEET_URL() ? 'pending' : 'not_required']);
    await t.run("insert into anvaya.lead_activities (lead_id, kind, body) values ($1,'system','Enquiry received from the website free-chat form')", [l.id]);
    if (SHEET_URL()) await jobs.enqueue('leads.sheet_sync', { leadId: l.id }, { q: t, dedupeKey: `sheet:${l.id}`, maxAttempts: 8 });
    return l;
  });
  res.status(201).json({ ok: true, id: lead.id });
  jobs.kick();
}));

// ── Public payment page → server checkout ──────────────────────────────
// The page sends only the plan key and the buyer's details. Price and referral discount are decided here,
// Razorpay's signature is verified here (and again by the webhook), and fulfilment, the confirmation email,
// the account invitation and onboarding all run automatically once the payment is verified.
const payments = require('../lib/payments');
const REF_PCT = 0.10, REF_CAP_PAISE = 15000; // 10% off, capped at ₹150 (same rule the page shows)
const checkoutLimiter = sec.rateLimiter({ name: 'public-checkout', windowMs: 60 * 60e3, max: 30, key: (req) => req.ip });
r.get('/public/checkout/plans', wrap(async (_req, res) => {
  res.json({ configured: payments.configured(), plans: await db.all(`select public_key as key, name, price_paise from anvaya.products
    where public_key is not null and active order by price_paise`) });
}));
r.post('/public/checkout', checkoutLimiter, wrap(async (req, res) => {
  if (!payments.configured()) throw new HttpError(503, 'Online payment isn’t available right now. Please message the Anvaya team.');
  const b = req.body || {};
  const p = await db.one('select * from anvaya.products where public_key = $1 and active', [v.str(b.plan_key, { max: 40, required: true, label: 'Plan' })]);
  if (!p) throw bad('That plan isn’t available.');
  const name = v.str(b.name, { max: 120, required: true, label: 'Name' });
  const email = v.email(b.email);
  const phone = v.str(b.phone, { max: 40, required: true, label: 'Phone' });
  if (!/^[+\d][\d\s()-]{6,}$/.test(phone)) throw bad('Please enter a valid phone number.');
  const ref = v.str(b.ref_code, { max: 40 }).replace(/[^a-z0-9_-]/gi, '');
  const discount = ref ? Math.min(Math.round(Number(p.price_paise) * REF_PCT / 100) * 100, REF_CAP_PAISE) : 0;
  const amount = Number(p.price_paise) - discount;
  // Find or create the student by email (never by phone alone); link to an existing lead with the same phone.
  const student = await db.tx(async (t) => {
    let s = await t.one('select id from anvaya.students where lower(email) = lower($1) order by id limit 1', [email]);
    if (!s) {
      s = await t.one(`insert into anvaya.students (name, email, phone, status) values ($1, lower($2), $3, 'active') returning id`, [name, email, phone]);
      await t.run("update anvaya.leads set student_id = $1, status = 'converted' where student_id is null and phone = $2 and status <> 'lost'", [s.id, phone]);
    }
    return s;
  });
  const reuse = await db.one(`select * from anvaya.orders where student_id = $1 and product_id = $2 and status = 'created' and amount_paise = $3
    and provider = 'razorpay' and source = 'public_page' and created_at > now() - interval '30 minutes' order by id desc limit 1`, [student.id, p.id, amount]);
  const order = reuse || await payments.createOrder({ studentId: student.id, product: p, amountPaise: amount, description: p.name, userId: null });
  if (!reuse) await db.run("update anvaya.orders set ref_code = $2, discount_paise = $3, source = 'public_page' where id = $1", [order.id, ref, discount]);
  res.status(201).json({ key: payments.checkoutConfig().keyId, razorpay_order_id: order.provider_order_id, amount_paise: amount, discount_paise: discount, currency: 'INR', plan: p.name });
}));
r.post('/public/checkout/verify', checkoutLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const order = await db.one("select * from anvaya.orders where provider = 'razorpay' and provider_order_id = $1 and source = 'public_page'", [String(b.razorpay_order_id || '')]);
  if (!order) throw new HttpError(404, 'Order not found.');
  if (!payments.verifyCheckoutSignature(b)) throw new HttpError(400, 'Payment verification failed. If money was deducted, it will be reconciled automatically.');
  const pays = await payments.rzp('GET', `/orders/${order.provider_order_id}/payments`);
  const pay = (pays.items || []).find((x) => x.id === b.razorpay_payment_id && x.status === 'captured');
  if (!pay) return res.json({ ok: true, status: 'processing' }); // the webhook / reconciliation finishes it
  await payments.markPaid(order.id, { provider: 'razorpay', providerPaymentId: pay.id, amountPaise: pay.amount, feePaise: pay.fee || 0, taxPaise: pay.tax || 0, method: pay.method });
  res.json({ ok: true, status: 'paid' });
}));

module.exports = r;
