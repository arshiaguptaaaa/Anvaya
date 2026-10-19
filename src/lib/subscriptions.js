'use strict';
// Subscriptions: access (what the student can use) is tracked separately from billing (what's been paid).
// paid_through → grace_until → expired. Entitlement limits come from plan_entitlements; nothing is unlimited
// unless the admin leaves a counted entitlement's limit empty on purpose (then it is "included", uncounted).
const db = require('../db');
const settings = require('./settings');

const IST_MS = 330 * 60e3; // India has no DST
const PERIOD_MONTHS = { month: 1, quarter: 3, half_year: 6, year: 12 };

function addPeriod(date, period) {
  const d = new Date(date);
  if (period === 'week') return new Date(d.getTime() + 7 * 86400e3);
  const m = PERIOD_MONTHS[period];
  if (!m) throw Object.assign(new Error('This product is not a recurring plan.'), { status: 400 });
  const out = new Date(d); out.setUTCMonth(out.getUTCMonth() + m);
  return out;
}

/** Effective access right now, regardless of when the nightly job last ran. */
function effectiveAccess(sub, now = new Date()) {
  if (!sub) return 'none';
  if (sub.access_status === 'paused') return 'paused';
  if (sub.access_status === 'cancelled' && sub.cancelled_at && new Date(sub.cancelled_at) <= now && !sub.cancel_at_period_end) return 'cancelled';
  if (now <= new Date(sub.paid_through)) return 'active';
  if (sub.cancel_at_period_end) return 'cancelled';
  if (sub.grace_until && now <= new Date(sub.grace_until)) return 'grace';
  return 'expired';
}
const hasAccess = (sub, now) => ['active', 'grace'].includes(effectiveAccess(sub, now));

/** Window [from, to) for counting an entitlement, in IST calendar terms. */
function window(per, sub, now = new Date()) {
  const ist = new Date(now.getTime() + IST_MS);
  if (per === 'week') {
    const dow = (ist.getUTCDay() + 6) % 7; // Monday = 0
    const start = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - dow) - IST_MS;
    return [new Date(start), new Date(start + 7 * 86400e3)];
  }
  if (per === 'month') {
    const start = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_MS;
    const end = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1) - IST_MS;
    return [new Date(start), new Date(end)];
  }
  if (per === 'billing_period') {
    const end = new Date(sub.paid_through);
    const start = sub.billing_period === 'week' ? new Date(end.getTime() - 7 * 86400e3) : addPeriodBack(end, sub.billing_period);
    return [start, end];
  }
  return [new Date(sub.started_at), new Date(8640000000000000)];
}
function addPeriodBack(date, period) { const d = new Date(date); d.setUTCMonth(d.getUTCMonth() - (PERIOD_MONTHS[period] || 0)); return d; }

/** The student's live subscriptions with plan + entitlements, best (active) first. */
async function forStudent(studentId, q = db) {
  const subs = await q.all(`select s.*, p.name as plan_name, p.billing_period, p.price_paise
    from anvaya.subscriptions s join anvaya.products p on p.id = s.product_id
    where s.student_id = $1 order by s.paid_through desc`, [studentId]);
  for (const s of subs) {
    s.effective_access = effectiveAccess(s);
    s.entitlements = await q.all('select key, limit_count, per_period, notes from anvaya.plan_entitlements where product_id = $1 order by key', [s.product_id]);
  }
  return subs;
}
async function activeFor(studentId, q = db) {
  return (await forStudent(studentId, q)).find((s) => hasAccess(s)) || null;
}

/** Usage of a counted entitlement within its current window. */
async function usage(studentId, sub, ent, q = db) {
  const [from, to] = window(ent.per_period, sub);
  if (ent.key === 'checkup_call') {
    const r = await q.one(`select count(*) n from anvaya.bookings b where b.kind = 'checkup' and b.student_id = $1
      and b.status in ('requested','pending_payment','scheduled','completed','no_show') and b.scheduled_at >= $2 and b.scheduled_at < $3`, [studentId, from, to]);
    return { used: r.n, limit: ent.limit_count, from, to };
  }
  return { used: null, limit: ent.limit_count, from, to };
}

/** Grant or extend a plan after a paid order (called inside the payment transaction). */
async function grantFromOrder(t, order, product) {
  const graceDays = Number(await settings.get('subscription_grace_days', t));
  const existing = await t.one(`select * from anvaya.subscriptions where student_id = $1 and product_id = $2
    and access_status in ('active','grace','paused') for update`, [order.student_id, product.id]);
  const now = new Date();
  if (existing) {
    const from = new Date(Math.max(now.getTime(), new Date(existing.paid_through).getTime()));
    const paidThrough = addPeriod(from, product.billing_period);
    await t.run(`update anvaya.subscriptions set paid_through = $1, grace_until = $2, access_status = 'active', billing_status = 'paid',
      cancel_at_period_end = false, last_order_id = $3, last_reminder_days = null, updated_at = now() where id = $4`,
    [paidThrough, new Date(paidThrough.getTime() + graceDays * 86400e3), order.id, existing.id]);
    return existing.id;
  }
  const paidThrough = addPeriod(now, product.billing_period);
  const r = await t.one(`insert into anvaya.subscriptions (student_id, product_id, access_status, billing_status, started_at, paid_through, grace_until, last_order_id)
    values ($1,$2,'active','paid',now(),$3,$4,$5) returning id`, [order.student_id, product.id, paidThrough, new Date(paidThrough.getTime() + graceDays * 86400e3), order.id]);
  return r.id;
}

module.exports = { addPeriod, effectiveAccess, hasAccess, window, forStudent, activeFor, usage, grantFromOrder, IST_MS };
