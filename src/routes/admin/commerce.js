'use strict';
// Catalogue (plans, prices, entitlements), orders, payments, refunds, subscriptions. Admin only.
const express = require('express');
const db = require('../../db');
const payments = require('../../lib/payments');
const subs = require('../../lib/subscriptions');
const { HttpError, bad, v, id, wrap, fields, insertSql, updateSql } = require('../../lib/http');
const { staff, adminOnly } = require('./_shared');

const r = express.Router();
const KINDS = ['subscription_plan', 'mentor_session', 'resume_service', 'linkedin_service', 'coaching_package', 'digital_product'];
const PERIODS = ['one_time', 'week', 'month', 'quarter', 'half_year', 'year'];
const ENT_KEYS = ['syllabus', 'live_class', 'mentor_room', 'checkup_call', 'progress_tracking', 'community', 'paid_session_discount'];

const productFields = fields({
  kind: (x) => v.oneOf(x, KINDS, 'Type'),
  name: (x) => v.str(x, { max: 120, required: true, label: 'Name' }),
  description: (x) => v.str(x, { max: 3000, label: 'Description' }),
  price_paise: (x) => v.paise(x, { label: 'Price', required: true }),
  billing_period: (x) => v.oneOf(x, PERIODS, 'Billing period'),
  active: (x) => v.bool(x),
  digital_document_id: (x) => v.id(x, 'Document'),
}, ['kind', 'name', 'price_paise']);

r.get('/products', staff, wrap(async (_req, res) => {
  const rows = await db.all('select * from anvaya.products order by active desc, kind, price_paise');
  for (const p of rows) p.entitlements = await db.all('select key, limit_count, per_period, notes from anvaya.plan_entitlements where product_id = $1 order by key', [p.id]);
  res.json(rows);
}));
r.post('/products', adminOnly, wrap(async (req, res) => {
  const f = await productFields(req.body || {}, { partial: false });
  if (f.kind === 'subscription_plan' && (!f.billing_period || f.billing_period === 'one_time')) throw bad('Subscription plans need a billing period.');
  if (f.kind !== 'subscription_plan') f.billing_period = 'one_time';
  const row = await db.one(...insertSql('products', f));
  db.audit(req.auth.user.id, 'product_created', `product:${row.id}`);
  res.status(201).json({ id: row.id });
}));
r.patch('/products/:id', adminOnly, wrap(async (req, res) => {
  const pid = id(req);
  const p = await db.one('select * from anvaya.products where id = $1', [pid]);
  if (!p) throw new HttpError(404, 'Product not found.');
  const f = await productFields(req.body || {}, { partial: true });
  if (f.kind && f.kind !== p.kind) throw bad('A product’s type can’t be changed; create a new product instead.');
  f.updated_at = new Date().toISOString();
  await db.run(...updateSql('products', f, pid));
  db.audit(req.auth.user.id, 'product_updated', `product:${pid} ${JSON.stringify(f)}`);
  res.json({ ok: true });
}));
/** Replaces a plan's entitlements. limit_count empty = included, uncounted (only for non-bookable keys). */
r.put('/products/:id/entitlements', adminOnly, wrap(async (req, res) => {
  const pid = id(req);
  const p = await db.one('select kind from anvaya.products where id = $1', [pid]);
  if (!p) throw new HttpError(404, 'Product not found.');
  if (p.kind !== 'subscription_plan') throw bad('Only subscription plans have entitlements.');
  const list = Array.isArray(req.body?.entitlements) ? req.body.entitlements : [];
  const clean = list.map((e) => {
    const key = v.oneOf(e.key, ENT_KEYS, 'Entitlement');
    const limit = v.int(e.limit_count, { min: 0, max: 1000, label: `${key} limit` });
    if (['checkup_call', 'live_class', 'mentor_room'].includes(key) && limit == null) throw bad(`Set a number for ${key.replace('_', ' ')} — counted sessions can’t be unlimited.`);
    return { key, limit, per: v.oneOf(e.per_period || 'month', ['week', 'month', 'billing_period', 'total'], 'Period'), notes: v.str(e.notes, { max: 200 }) };
  });
  await db.tx(async (t) => {
    await t.run('delete from anvaya.plan_entitlements where product_id = $1', [pid]);
    for (const e of clean) await t.run('insert into anvaya.plan_entitlements (product_id, key, limit_count, per_period, notes) values ($1,$2,$3,$4,$5)', [pid, e.key, e.limit, e.per, e.notes]);
  });
  res.json({ ok: true });
}));

// ── Orders & payments ────────────────────────────────────────────────
r.get('/orders', adminOnly, wrap(async (_req, res) => {
  res.json(await db.all(`select o.*, s.name as student_name, p.name as product_name, p.kind as product_kind,
    (select b.id from anvaya.bookings b where b.order_id = o.id) as booking_id
    from anvaya.orders o join anvaya.students s on s.id = o.student_id left join anvaya.products p on p.id = o.product_id order by o.id desc limit 500`));
}));
/** Manual order (e.g. UPI to the business account, or a college invoice). */
r.post('/orders', adminOnly, wrap(async (req, res) => {
  const sid = v.id(req.body?.student_id, 'Student', { required: true });
  if (!await db.one('select 1 from anvaya.students where id = $1', [sid])) throw bad('Student not found.');
  const pid = v.id(req.body?.product_id, 'Product', { required: true });
  const p = await db.one('select * from anvaya.products where id = $1', [pid]);
  if (!p) throw bad('Product not found.');
  const amount = req.body?.amount_paise != null && req.body.amount_paise !== '' ? v.paise(req.body.amount_paise, { label: 'Amount' }) : p.price_paise;
  const o = await db.one(`insert into anvaya.orders (student_id, product_id, description, amount_paise, provider, created_by)
    values ($1,$2,$3,$4,'manual',$5) returning id`, [sid, pid, p.name, amount, req.auth.user.id]);
  res.status(201).json({ id: o.id });
}));
r.post('/orders/:id/record-payment', adminOnly, wrap(async (req, res) => {
  const oid = id(req);
  const o = await db.one('select * from anvaya.orders where id = $1', [oid]);
  if (!o) throw new HttpError(404, 'Order not found.');
  if (o.status === 'paid') throw bad('This order is already paid.');
  const out = await payments.markPaid(oid, {
    provider: 'manual', amountPaise: v.paise(req.body?.amount_paise ?? o.amount_paise, { label: 'Amount', required: true }),
    feePaise: v.paise(req.body?.fee_paise, { label: 'Fee' }) ?? 0, method: v.str(req.body?.method, { max: 40 }) || 'UPI',
    reference: v.str(req.body?.reference, { max: 120 }), paidAt: v.date(req.body?.paid_at), userId: req.auth.user.id,
  });
  db.audit(req.auth.user.id, 'payment_recorded', `order:${oid}`);
  res.json({ ok: true, paymentId: out.paymentId });
}));
r.post('/orders/:id/cancel', adminOnly, wrap(async (req, res) => {
  await payments.markFailed(id(req), 'Cancelled by admin');
  await db.run("update anvaya.orders set status = 'cancelled' where id = $1 and status = 'failed'", [id(req)]);
  res.json({ ok: true });
}));
r.get('/payments', adminOnly, wrap(async (_req, res) => {
  res.json(await db.all(`select p.*, s.name as student_name, o.description as order_description,
    (select coalesce(sum(amount_paise),0) from anvaya.refunds rf where rf.payment_id = p.id and rf.status <> 'failed') as refunded_paise
    from anvaya.payments p join anvaya.students s on s.id = p.student_id left join anvaya.orders o on o.id = p.order_id order by p.id desc limit 500`));
}));
r.patch('/payments/:id', adminOnly, wrap(async (req, res) => {
  // Only bookkeeping fields; amounts of gateway payments come from the gateway.
  const f = await fields({
    fee_paise: (x) => v.paise(x, { label: 'Fee' }) ?? 0, tax_paise: (x) => v.paise(x, { label: 'Tax' }) ?? 0,
    reference: (x) => v.str(x, { max: 120 }), method: (x) => v.str(x, { max: 40 }),
  })(req.body || {}, { partial: true });
  if (Object.keys(f).length) await db.run(...updateSql('payments', f, id(req)));
  res.json({ ok: true });
}));
r.post('/payments/:id/refund', adminOnly, wrap(async (req, res) => {
  const rid = await payments.refund(id(req), {
    amountPaise: v.paise(req.body?.amount_paise, { label: 'Refund amount', required: true, min: 1 }),
    reason: v.str(req.body?.reason, { max: 300, required: true, label: 'Reason' }), cancelBooking: req.body?.cancel_booking !== false, userId: req.auth.user.id,
  });
  db.audit(req.auth.user.id, 'refund_recorded', `payment:${id(req)} refund:${rid}`);
  res.json({ ok: true, id: rid });
}));
r.get('/refunds', adminOnly, wrap(async (_req, res) => {
  res.json(await db.all(`select rf.*, s.name as student_name from anvaya.refunds rf join anvaya.payments p on p.id = rf.payment_id
    join anvaya.students s on s.id = p.student_id order by rf.id desc`));
}));

// ── Subscriptions ────────────────────────────────────────────────────
r.get('/subscriptions', staff, wrap(async (req, res) => {
  const rows = await db.all(`select x.*, s.name as student_name, p.name as plan_name, p.billing_period ${req.auth.user.role === 'admin' ? ', p.price_paise' : ''}
    from anvaya.subscriptions x join anvaya.students s on s.id = x.student_id join anvaya.products p on p.id = x.product_id order by x.paid_through desc`);
  for (const x of rows) x.effective_access = subs.effectiveAccess(x);
  res.json(rows);
}));
/** Admin actions: pause/resume, cancel at period end, cancel now, extend (comp), set paid_through. */
r.post('/subscriptions/:id/action', adminOnly, wrap(async (req, res) => {
  const sid = id(req);
  const x = await db.one('select x.*, p.billing_period from anvaya.subscriptions x join anvaya.products p on p.id = x.product_id where x.id = $1', [sid]);
  if (!x) throw new HttpError(404, 'Subscription not found.');
  const action = v.oneOf(req.body?.action, ['pause', 'resume', 'cancel_at_period_end', 'undo_cancel', 'cancel_now', 'extend', 'waive'], 'Action');
  const sql = {
    pause: "access_status = 'paused'",
    resume: "access_status = 'active'",
    cancel_at_period_end: 'cancel_at_period_end = true',
    undo_cancel: "cancel_at_period_end = false, access_status = case when access_status = 'cancelled' then 'active' else access_status end, cancelled_at = null",
    cancel_now: "access_status = 'cancelled', cancelled_at = now(), cancel_at_period_end = false",
    waive: "billing_status = 'waived'",
  }[action];
  if (action === 'extend') {
    const until = v.date(req.body?.paid_through, { required: true, label: 'Paid through' });
    const grace = Number((await db.one("select value from anvaya.settings where key = 'subscription_grace_days'"))?.value ?? 5);
    await db.run(`update anvaya.subscriptions set paid_through = $2, grace_until = $2::timestamptz + make_interval(days => $3), access_status = 'active', updated_at = now() where id = $1`, [sid, until, grace]);
  } else {
    await db.run(`update anvaya.subscriptions set ${sql}, updated_at = now() where id = $1`, [sid]);
  }
  db.audit(req.auth.user.id, `subscription_${action}`, `subscription:${sid}`);
  res.json({ ok: true });
}));

module.exports = r;
