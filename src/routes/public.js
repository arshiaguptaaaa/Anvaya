'use strict';
// Public endpoints used by the brochure. Supabase is the source of truth for enquiries; the Google Sheet
// is a secondary copy written by a tracked background job (failures are visible and retryable in the CRM).
const express = require('express');
const db = require('../db');
const sec = require('../security');
const jobs = require('../lib/jobs');
const { HttpError, bad, v, wrap } = require('../lib/http');

const freechats = require('../lib/freechats');
/** A visit-source code from the page (?src=… / utm_source): lower-case letters, digits, - _ . : / only. */
const refCode = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9_.:/-]/g, '').slice(0, 60);
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
r.use(['/public/leads', '/public/checkout', '/public/checkout/verify', '/public/freechat/slots', '/public/ref-visit'], (req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins().includes(origin)) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
  if (req.method !== 'OPTIONS') return next();
  if (!origin || !allowedOrigins().includes(origin)) return res.status(403).end();
  res.set({ 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' }).status(204).end();
});

/** Open free-chat slots for the website form (times only, never the host's calendar details). */
const slotLimiter = sec.rateLimiter({ name: 'freechat-slots', windowMs: 10 * 60e3, max: 60, key: (req) => req.ip });
r.get('/public/freechat/slots', slotLimiter, wrap(async (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(await freechats.openSlots()); }));

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
  // Optional: a free-chat time picked from the host's open slots (an email is then needed for the Meet invite).
  const slot = b.slot ? v.date(b.slot, { label: 'Time' }) : null;
  const email = slot ? v.email(b.email) : (b.email ? v.email(b.email) : '');
  const dup = await db.one("select id from anvaya.leads where phone = $1 and name = $2 and created_at > now() - interval '10 minutes'", [phone, name]);
  if (dup && !slot) return res.status(201).json({ ok: true, id: dup.id });
  const { lead, chat } = await db.tx(async (t) => {
    const l = dup || await t.one(`insert into anvaya.leads (name, phone, email, situation, source, sheet_sync_status, follow_up_at, next_action, ref_source, ref_first)
      values ($1,$2,$3,$4,'Free 15-min chat (website)',$5, now() + interval '4 hours', 'Call / WhatsApp to set up the free chat', $6, $7) returning id`,
    [name, phone, email, situation, SHEET_URL() ? 'pending' : 'not_required', refCode(b.src), refCode(b.src_first)]);
    if (!dup) {
      await t.run("insert into anvaya.lead_activities (lead_id, kind, body) values ($1,'system','Enquiry received from the website free-chat form')", [l.id]);
      if (SHEET_URL()) await jobs.enqueue('leads.sheet_sync', { leadId: l.id }, { q: t, dedupeKey: `sheet:${l.id}`, maxAttempts: 8 });
    } else if (email) await t.run("update anvaya.leads set email = $2 where id = $1 and email = ''", [l.id, email]);
    const c = slot ? await freechats.request({ leadId: l.id, name, email, phone, situation, startsAt: slot }, t) : null;
    return { lead: l, chat: c };
  });
  if (chat) await freechats.notifyRequested(chat.id);
  res.status(201).json({ ok: true, id: lead.id, ...(chat ? { freechat: { status: 'requested', scheduled_at: chat.scheduled_at } } : {}) });
  jobs.kick();
}));

// ── Calendar invitation (.ics) for a confirmed session; the link is signed so it works without signing in ──
r.get('/public/ics/:id', wrap(async (req, res) => {
  const sessions = require('../lib/sessions');
  const bid = Number(req.params.id);
  const sig = String(req.query.sig || '');
  const good = sessions.icsSig(bid);
  if (!Number.isInteger(bid) || sig.length !== good.length || !require('node:crypto').timingSafeEqual(Buffer.from(sig), Buffer.from(good))) throw new HttpError(404, 'Not found.');
  const b = await sessions.load(bid);
  if (!b || !['scheduled', 'cancelled'].includes(b.status) || !b.meet_link) throw new HttpError(404, 'This session has no calendar invitation yet.');
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="anvaya-session.ics"', 'Cache-Control': 'no-store' });
  res.send(sessions.buildIcs(b, { cancelled: b.status === 'cancelled' }));
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

// ── Visit-source link clicks: one count per code per day, no personal data ──
const visitLimiter = sec.rateLimiter({ name: 'public-ref-visit', windowMs: 60 * 60e3, max: 60, key: (req) => req.ip });
r.post('/public/ref-visit', visitLimiter, wrap(async (req, res) => {
  const src = refCode(req.body?.src);
  if (src) await db.run(`insert into anvaya.ref_visits (day, source, visits) values ((now() at time zone 'Asia/Kolkata')::date, $1, 1)
    on conflict (day, source) do update set visits = ref_visits.visits + 1`, [src]);
  res.status(204).end();
}));

// ── Payment-page checkout enquiries (details submitted + checkout opened, before any payment) ──
const enquiries = require('../lib/enquiries');
const enquiryLimiter = sec.rateLimiter({ name: 'public-enquiry', windowMs: 60 * 60e3, max: 40, key: (req) => req.ip });
r.post('/public/checkout/enquiry', enquiryLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const key = v.str(b.plan_key, { max: 40 });
  const product = key ? await db.one('select * from anvaya.products where public_key = $1 and active', [key])
    : await db.one('select * from anvaya.products where name = $1 and public_key is not null and active', [v.str(b.plan, { max: 160 })]);
  if (!product) throw bad('That plan isn’t available.');
  const e = await enquiries.start({
    name: v.str(b.name, { max: 120, required: true, label: 'Name' }), email: v.email(b.email).toLowerCase(), phone: v.str(b.phone, { max: 40 }),
    product, refCode: v.str(b.ref_code, { max: 40 }).replace(/[^a-z0-9_-]/gi, ''), consent: b.consent === true, publicId: v.str(b.enquiry_id, { max: 40 }) || null,
    refSource: refCode(b.src), refFirst: refCode(b.src_first), entry: refCode(b.entry),
  });
  res.status(201).json({ id: e.public_id });
}));
r.post('/public/checkout/enquiry/:id/event', enquiryLimiter, wrap(async (req, res) => {
  const what = { closed: 'closed', browser_failed: 'browser_reported_failure' }[String(req.body?.event || '')];
  if (!what) throw bad('Unknown event.');
  await enquiries.event(String(req.params.id).slice(0, 40), what);
  res.status(204).end();
}));
r.get('/public/checkout/enquiry/:id/stop', wrap(async (req, res) => {
  const e = await enquiries.unsubscribe(String(req.params.id).slice(0, 40), String(req.query.t || ''));
  res.status(e ? 200 : 404).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anvaya</title>
    <body style="margin:0;background:#08111f;color:#f4ede0;font-family:Helvetica,Arial,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px">
    <div><div style="letter-spacing:.2em;color:#c9a84c">ANVAYA</div><p style="font-size:18px">${e ? 'Done. You won’t get any more checkout reminders from us.' : 'This link isn’t valid.'}</p></div></body>`);
}));

module.exports = r;
