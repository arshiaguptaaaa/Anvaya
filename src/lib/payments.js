'use strict';
// Payments: Razorpay Orders + Checkout, verified server-side, plus admin-recorded manual payments.
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET  (server env only; key id is also sent to Checkout)
// Every money change is idempotent: payments are unique per provider payment id, webhook events are
// stored once per (provider, event id), and fulfilment runs inside the same transaction as "order paid".
const crypto = require('node:crypto');
const db = require('../db');
const jobs = require('./jobs');
const { sendEmail } = require('./email');
const subs = require('./subscriptions');
const ledger = require('./ledger');
const paysheet = require('./paysheet');
const enquiries = require('./enquiries');

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const FAKE = KEY_ID.startsWith('rzp_fake');   // automated tests only: no network
const configured = () => !!(KEY_ID && KEY_SECRET);
const BASE_URL = () => (process.env.APP_BASE_URL || '').replace(/\/$/, '');

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ── Razorpay REST (or the in-process fake) ───────────────────────────
const fake = { orders: new Map(), payments: new Map(), seq: 0 };
async function rzp(method, pathname, body) {
  if (FAKE) return fakeRzp(method, pathname, body);
  const r = await fetch(`https://api.razorpay.com/v1${pathname}`, {
    method, headers: { Authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64'), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Razorpay: ${j.error?.description || r.status}`), { status: 502 });
  return j;
}
function fakeRzp(method, p, body) {
  if (method === 'POST' && p === '/orders') { const o = { id: `order_fake_${++fake.seq}`, amount: body.amount, currency: body.currency, status: 'created' }; fake.orders.set(o.id, o); return o; }
  if (method === 'GET' && p.startsWith('/payments?')) return { items: [...fake.payments.values()] };
  let m = p.match(/^\/orders\/([^/]+)\/payments$/);
  if (m) return { items: [...fake.payments.values()].filter((x) => x.order_id === m[1]) };
  m = p.match(/^\/payments\/([^/]+)\/refund$/);
  if (m) return { id: `rfnd_fake_${++fake.seq}`, payment_id: m[1], amount: body.amount, status: 'processed' };
  throw new Error(`fake razorpay: ${method} ${p}`);
}

const checkoutConfig = () => (configured() ? { provider: 'razorpay', keyId: KEY_ID } : { provider: 'manual' });

/** Creates a local order (and the Razorpay order when configured). q: optional transaction. */
async function createOrder({ studentId, product, amountPaise, description, userId }, q = db) {
  const o = await q.one(`insert into anvaya.orders (student_id, product_id, description, amount_paise, provider, created_by)
    values ($1,$2,$3,$4,$5,$6) returning *`, [studentId, product?.id ?? null, description, amountPaise, configured() ? 'razorpay' : 'manual', userId]);
  if (configured() && amountPaise > 0) {
    const r = await rzp('POST', '/orders', { amount: amountPaise, currency: 'INR', receipt: `anvaya-${o.id}`, notes: { anvaya_order_id: String(o.id), student_id: String(studentId) } });
    await q.run('update anvaya.orders set provider_order_id = $1 where id = $2', [r.id, o.id]);
    o.provider_order_id = r.id;
  }
  return o;
}

function verifyCheckoutSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!configured()) return false;
  return safeEq(hmac(KEY_SECRET, `${razorpay_order_id}|${razorpay_payment_id}`), String(razorpay_signature || ''));
}
function verifyWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) return false;
  return safeEq(hmac(WEBHOOK_SECRET, rawBody), String(signature || ''));
}

/** Idempotently records a successful payment and fulfils the order. */
async function markPaid(orderId, { provider, providerPaymentId = null, amountPaise, feePaise = 0, taxPaise = 0, method = '', reference = '', paidAt = null, userId = null }) {
  const out = await db.tx(async (t) => {
    const order = await t.one('select * from anvaya.orders where id = $1 for update', [orderId]);
    if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
    if (providerPaymentId) {
      const dup = await t.one('select id from anvaya.payments where provider = $1 and provider_payment_id = $2', [provider, providerPaymentId]);
      if (dup) return { order, duplicate: true };
    }
    if (amountPaise < order.amount_paise) throw Object.assign(new Error('Payment amount is less than the order amount.'), { status: 400 });
    const pay = await t.one(`insert into anvaya.payments (student_id, order_id, amount_paise, method, reference, status, paid_at, provider, provider_payment_id, fee_paise, tax_paise)
      values ($1,$2,$3,$4,$5,'paid',coalesce($6, now()),$7,$8,$9,$10) returning id`,
    [order.student_id, order.id, amountPaise, method || provider, reference, paidAt, provider, providerPaymentId, feePaise, taxPaise]);
    if (order.status === 'paid') return { order, paymentId: pay.id, alreadyPaid: true };
    await t.run("update anvaya.orders set status = 'paid', paid_at = now(), resolved_at = now() where id = $1", [order.id]);
    const notices = await fulfil(t, order, userId);
    notices.push(() => afterPayment(order.id, { provider }));
    return { order, paymentId: pay.id, notices };
  });
  for (const n of out.notices || []) await n();
  return out;
}

/**
 * After a payment is recorded (verified by Razorpay, or entered by an admin for UPI/bank transfers):
 * confirmation email, account invitation or intake prompt, timeline event and a welcome task.
 * Every step is duplicate-protected per order, so webhook + browser callback + reconciliation can't repeat it.
 */
async function afterPayment(orderId, { provider }) {
  try {
    const ops = require('./ops');
    const accounts = require('./accounts');
    const o = await db.one(`select o.*, p.kind as product_kind, p.name as product_name, s.name as student_name, s.email, s.user_id, s.owner_user_id,
        s.intake_completed_at from anvaya.orders o left join anvaya.products p on p.id = o.product_id join anvaya.students s on s.id = o.student_id where o.id = $1`, [orderId]);
    if (!o || o.status !== 'paid') return;
    if (provider === 'razorpay') await paysheet.fromOrder(o.id).catch((e) => console.error('[paysheet]', orderId, e.message));
    if (provider === 'razorpay') await enquiries.convertForOrder(o.id).catch((e) => console.error('[enquiry]', orderId, e.message));
    const first = await db.one(`insert into anvaya.tasks (title, student_id, owner_user_id, due_at, source, dedupe_key)
      values ($1,$2,$3, now() + interval '1 day', 'payment', $4) on conflict (dedupe_key) do nothing returning id`,
    [`Welcome call: ${o.product_name || o.description}`, o.student_id, o.owner_user_id, `onboard:order:${o.id}`]);
    if (!first) return; // already handled for this order
    const sub = o.product_kind === 'subscription_plan' ? await db.one('select paid_through from anvaya.subscriptions where last_order_id = $1', [o.id]) : null;
    let next = 'open your dashboard to see what’s included.', invited = false;
    {
      await db.run('update anvaya.students set onboarding_started_at = coalesce(onboarding_started_at, now()) where id = $1', [o.student_id]);
      if (!o.user_id && o.email) {
        const clash = await db.one('select id from anvaya.users where lower(email) = lower($1)', [o.email]);
        if (!clash) {
          const uid = await db.tx(async (t) => {
            const u = await t.one("insert into anvaya.users (email, name, role) values (lower($1), $2, 'student') returning id", [o.email, o.student_name]);
            await t.run('update anvaya.students set user_id = $1 where id = $2', [u.id, o.student_id]);
            return u.id;
          });
          const r = await accounts.issue(uid, 'student_invite');
          invited = true;
          next = r.delivered ? 'check your inbox for a separate email to set up your account, then complete a short intake.' : 'we’ll send your account set-up link shortly.';
        } else {
          await ops.createTask({ title: 'Payment received but email belongs to another account: fix before onboarding', studentId: o.student_id, ownerUserId: o.owner_user_id, source: 'payment', dedupeKey: `onboard-clash:order:${o.id}` });
        }
      } else if (!o.intake_completed_at && o.product_kind === 'subscription_plan') {
        next = 'complete your intake so we can match you to a group and mentor.';
      }
    }
    let emailNote = 'no email on file';
    const scriptSends = o.source === 'public_page_direct' && (await require('./settings').get('page_confirmation_sender')) !== 'app';
    if (scriptSends) emailNote = 'confirmation email sent by the payment page’s Apps Script';
    else if (o.email) {
      const bookingUrl = /^public_page/.test(o.source || '') ? ((await require('./settings').get('page_booking_links')) || {})[o.product_name] || null : null;
      const r = await sendEmail(o.email, 'payment_confirmed', { item: o.product_name || o.description, validTill: sub?.paid_through || null, nextStep: next, bookingUrl,
        dashboardUrl: `${BASE_URL()}/student` }, { dedupeKey: `paid:order:${o.id}` });
      emailNote = r.delivered ? 'confirmation email delivered' : 'confirmation email queued for retry';
    }
    const how = provider === 'razorpay' ? 'verified by Razorpay' : 'recorded manually by an admin';
    await ops.systemEvent(o.student_id, `Payment ${how} for ${o.product_name || o.description}${sub ? `; access active until ${ops.ist(sub.paid_through)}` : ''}; ${emailNote}${invited ? '; account invitation sent' : ''}.`);
  } catch (e) {
    console.error('[after-payment]', orderId, e.message); // never undo a recorded payment; the welcome task shows it needs a look
  }
}

/**
 * A payment-page purchase the page itself never reported (the browser closed before its success step), so the page's
 * Apps Script sent no confirmation. Sends the app's confirmation instead, once per order (same key as afterPayment).
 */
async function confirmPagePayment(orderId) {
  const o = await db.one(`select o.*, p.name as product_name, s.email, u.password_hash is null as needs_setup from anvaya.orders o
    left join anvaya.products p on p.id = o.product_id join anvaya.students s on s.id = o.student_id left join anvaya.users u on u.id = s.user_id
    where o.id = $1 and o.status in ('paid','partially_refunded')`, [orderId]);
  if (!o || !o.email) return null;
  const bookingUrl = ((await require('./settings').get('page_booking_links')) || {})[o.product_name] || null;
  const r = await sendEmail(o.email, 'payment_confirmed', { item: o.product_name || o.description, nextStep: o.needs_setup
    ? 'check your inbox for a separate email to set up your account, then complete a short intake.' : 'open your dashboard to see what’s included.',
  bookingUrl, dashboardUrl: `${BASE_URL()}/student` }, { dedupeKey: `paid:order:${o.id}` });
  await require('./ops').systemEvent(o.student_id, `Payment page didn’t report this payment, so the app sent the confirmation email${r.delivered ? '' : ' (queued for retry)'}.`);
  return r;
}

/** Applies what was bought. Returns post-commit callbacks (emails). */
async function fulfil(t, order, userId) {
  const notices = [];
  const product = order.product_id ? await t.one('select * from anvaya.products where id = $1', [order.product_id]) : null;
  const booking = await t.one('select * from anvaya.bookings where order_id = $1 for update', [order.id]);
  if (booking) {
    if (booking.status === 'pending_payment' || booking.status === 'cancelled') {
      try {
        await t.run("savepoint reclaim");
        await t.run("update anvaya.bookings set status = 'scheduled', hold_expires_at = null, cancelled_at = null, cancel_reason = '' where id = $1", [booking.id]);
        await t.run("release savepoint reclaim");
        notices.push(() => notifyBookingConfirmed(booking.id));
      } catch (e) {
        await t.run("rollback to savepoint reclaim");
        // Slot was taken after the hold expired: keep the money recorded, flag for refund or rebooking.
        await t.run("update anvaya.bookings set cancel_reason = 'Paid after hold expired; slot taken — refund or rebook' where id = $1", [booking.id]);
        await t.run("update anvaya.students set needs_followup = true, followup_reason = 'Paid booking lost its slot — refund or rebook' where id = $1", [order.student_id]);
      }
    }
  } else if (product?.kind === 'subscription_plan') {
    const subId = await subs.grantFromOrder(t, order, product);
    await t.run("insert into anvaya.audit_log (user_id, action, detail) values ($1, 'subscription_granted', $2)", [userId, `subscription:${subId} order:${order.id} student:${order.student_id} plan:${product.id}`]);
  } else if (product && ['resume_service', 'linkedin_service', 'coaching_package'].includes(product.kind)) {
    const kind = { resume_service: 'resume_rewrite', linkedin_service: 'linkedin_rewrite', coaching_package: 'coaching_package' }[product.kind];
    const exists = await t.one('select id from anvaya.service_cases where order_id = $1', [order.id]);
    if (!exists) {
      const c = await t.one(`insert into anvaya.service_cases (student_id, product_id, order_id, kind, status, playbook_version_id, due_at)
        values ($1,$2,$3,$4,'intake',(select id from anvaya.playbook_versions where is_active), now() + interval '5 days') returning id`, [order.student_id, product.id, order.id, kind]);
      await t.run("insert into anvaya.case_events (case_id, user_id, to_status, note) values ($1,$2,'intake','Created from paid order')", [c.id, userId]);
    }
  }
  return notices;
}

async function notifyBookingConfirmed(bookingId) {
  // Confirmation goes out only once Google Calendar returns a real Meet link (see sessions.scheduleSync).
  await db.run("update anvaya.bookings set calendar_status = 'pending', calendar_error = '' where id = $1 and status = 'scheduled'", [bookingId]);
  await require('./sessions').scheduleSync(bookingId, 'confirm');
}

async function markFailed(orderId, reason = 'Payment failed') {
  await db.tx(async (t) => {
    const o = await t.one("update anvaya.orders set status = 'failed', resolved_at = now() where id = $1 and status = 'created' returning id", [orderId]);
    if (o) await t.run(`update anvaya.bookings set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where order_id = $1 and status = 'pending_payment'`, [orderId, reason]);
  });
}

/** Refund (gateway refund when the payment came through Razorpay; otherwise records a manual refund). */
async function refund(paymentId, { amountPaise, reason = '', cancelBooking = true, userId }) {
  const pay = await db.one('select * from anvaya.payments where id = $1', [paymentId]);
  if (!pay) throw Object.assign(new Error('Payment not found.'), { status: 404 });
  const refunded = (await db.one("select coalesce(sum(amount_paise),0) n from anvaya.refunds where payment_id = $1 and status <> 'failed'", [paymentId])).n;
  if (amountPaise > pay.amount_paise - refunded) throw Object.assign(new Error('Refund is more than the remaining paid amount.'), { status: 400 });
  let providerRefundId = null;
  if (pay.provider === 'razorpay') {
    if (!configured()) throw Object.assign(new Error('Razorpay is not configured, so this refund can’t be sent to the gateway.'), { status: 503 });
    const r = await rzp('POST', `/payments/${pay.provider_payment_id}/refund`, { amount: amountPaise, notes: { reason } });
    providerRefundId = r.id;
  }
  const id = await applyRefund(paymentId, { amountPaise, reason, providerRefundId, cancelBooking, userId });
  await paysheet.fromPayment(paymentId).catch((e) => console.error('[paysheet] refund', paymentId, e.message));
  return id;
}

/**
 * Records a refund once (per gateway refund id) and updates what it affects: payment and order status, the booking,
 * and access. A full refund ends what was bought (subscription access, an open service case); a partial refund keeps
 * access and leaves the decision to staff. Used by admin refunds and by Razorpay's refund.processed webhook
 * (refunds made from the Razorpay dashboard), whichever arrives first.
 */
async function applyRefund(paymentId, { amountPaise, reason = '', providerRefundId = null, cancelBooking = true, userId = null }) {
  return db.tx(async (t) => {
    const pay = await t.one('select * from anvaya.payments where id = $1 for update', [paymentId]);
    const ref = await t.one(`insert into anvaya.refunds (payment_id, amount_paise, reason, status, provider_refund_id, created_by)
      values ($1,$2,$3,'processed',$4,$5) on conflict (provider_refund_id) do nothing returning id`, [paymentId, amountPaise, reason, providerRefundId, userId]);
    if (!ref) return (await t.one('select id from anvaya.refunds where provider_refund_id = $1', [providerRefundId]))?.id; // already applied
    const total = (await t.one("select coalesce(sum(amount_paise),0) n from anvaya.refunds where payment_id = $1 and status <> 'failed'", [paymentId])).n;
    const full = total >= pay.amount_paise;
    await t.run("update anvaya.payments set status = case when $2::bigint >= amount_paise then 'refunded' else status end where id = $1", [paymentId, total]);
    if (pay.order_id) {
      await t.run(`update anvaya.orders set status = case when $2::bigint >= amount_paise then 'refunded' else 'partially_refunded' end where id = $1`, [pay.order_id, total]);
      const b = await t.one('select * from anvaya.bookings where order_id = $1', [pay.order_id]);
      if (b) {
        if (b.status === 'completed') await ledger.recordRefundAdjustment(t, b.id, amountPaise, userId, `Refund: ${reason || 'student refund'}`);
        else if (cancelBooking && ['scheduled', 'pending_payment', 'requested'].includes(b.status)) {
          await t.run("update anvaya.bookings set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1", [b.id, `Refunded: ${reason}`]);
        }
      }
      if (full) {
        await t.run(`update anvaya.subscriptions set billing_status = 'refunded', access_status = 'cancelled', cancelled_at = now(), cancel_at_period_end = false,
          updated_at = now() where last_order_id = $1`, [pay.order_id]);
        const cases = await t.all(`update anvaya.service_cases set status = 'cancelled' where order_id = $1 and status not in ('delivered','closed','cancelled') returning id, status`, [pay.order_id]);
        for (const c of cases) await t.run("insert into anvaya.case_events (case_id, user_id, to_status, note) values ($1,$2,'cancelled','Order fully refunded')", [c.id, userId]);
      }
      await t.run("insert into anvaya.audit_log (user_id, action, detail) values ($1, 'refund_applied', $2)",
        [userId, `payment:${paymentId} order:${pay.order_id} refund:${providerRefundId || ref.id} amount:${amountPaise} total:${total}${full ? ' full' : ' partial'}`]);
    }
    return ref.id;
  });
}

/** Webhook → stored once → processed. Returns { status }. */
async function handleWebhook(rawBody, headers) {
  const signatureValid = verifyWebhookSignature(rawBody, headers['x-razorpay-signature']);
  let payload; try { payload = JSON.parse(rawBody); } catch { return { http: 400, status: 'bad_json' }; }
  const eventId = headers['x-razorpay-event-id'] || `${payload.event}:${payload.payload?.payment?.entity?.id || payload.payload?.refund?.entity?.id || payload.created_at}`;
  const row = await db.one(`insert into anvaya.webhook_events (provider, event_id, event_type, payload, signature_valid, status)
    values ('razorpay', $1, $2, $3, $4, $5) on conflict (provider, event_id) do nothing returning id`,
  [eventId, payload.event || '', JSON.stringify(payload), signatureValid, signatureValid ? 'received' : 'ignored']);
  if (!signatureValid) return { http: 401, status: 'invalid_signature' };
  if (!row) return { http: 200, status: 'duplicate' };
  await jobs.enqueue('payments.webhook', { webhookEventId: row.id }, { dedupeKey: `webhook:${row.id}` });
  const r = await jobs.processDue({ limit: 3, kinds: ['payments.webhook'] }).catch(() => []);
  return { http: 200, status: 'accepted', processed: r.length };
}

jobs.register('payments.webhook', async ({ webhookEventId }) => {
  const ev = await db.one('select * from anvaya.webhook_events where id = $1', [webhookEventId]);
  if (!ev || ev.status === 'processed') return;
  try {
    const p = ev.payload;
    const pay = p.payload?.payment?.entity;
    if ((p.event === 'payment.captured' || p.event === 'order.paid') && pay?.id) {
      const order = pay.order_id && await db.one("select * from anvaya.orders where provider = 'razorpay' and provider_order_id = $1", [pay.order_id]);
      if (order) await markPaid(order.id, { provider: 'razorpay', providerPaymentId: pay.id, amountPaise: pay.amount, feePaise: pay.fee || 0, taxPaise: pay.tax || 0, method: pay.method || '' });
      else if (p.event === 'payment.captured') await recordPagePayment(pay);
    } else if (p.event === 'payment.failed' && pay?.id) {
      const order = pay.order_id && await db.one("select id from anvaya.orders where provider = 'razorpay' and provider_order_id = $1", [pay.order_id]);
      if (order) await markFailed(order.id, pay.error_description || 'Payment failed');
      await paysheet.fromFailedAttempt(pay);
      await enquiries.failedFromPayment(pay); // only Razorpay's signed event marks an enquiry failed
    } else if (p.event === 'refund.processed') {
      const rf = p.payload?.refund?.entity;
      const payment = rf && await db.one("select id from anvaya.payments where provider = 'razorpay' and provider_payment_id = $1", [rf.payment_id]);
      if (payment) {
        await applyRefund(payment.id, { amountPaise: rf.amount, reason: 'Refunded in Razorpay', providerRefundId: rf.id });
        await paysheet.fromPayment(payment.id);
      }
    }
    await db.run("update anvaya.webhook_events set status = 'processed', processed_at = now(), error = null where id = $1", [ev.id]);
  } catch (e) {
    await db.run("update anvaya.webhook_events set status = 'failed', error = $2 where id = $1", [ev.id, e.message]);
    throw e;
  }
});

/**
 * A captured payment made directly on the public payment page (browser Checkout with only the public key, no
 * server order). Trusted because the webhook signature was verified with RAZORPAY_WEBHOOK_SECRET. The plan comes
 * from the payment's notes.plan (the page sets it), and the captured amount must cover that plan's price minus at
 * most the page's referral discount (10%, capped at ₹150). Anything that doesn't match is flagged for staff and
 * nothing is activated.
 */
async function recordPagePayment(pay) {
  if (await db.one("select 1 from anvaya.payments where provider = 'razorpay' and provider_payment_id = $1", [pay.id])) return;
  const ops = require('./ops');
  const email = String(pay.email || '').trim().toLowerCase();
  const planName = String(pay.notes?.plan || '').trim();
  const product = planName && await db.one('select * from anvaya.products where name = $1 and public_key is not null and active', [planName]);
  const rs = (x) => `₹${(Number(x) / 100).toLocaleString('en-IN')}`;
  const flag = async (why) => {
    await ops.createTask({ title: `Check Razorpay payment ${pay.id} (${rs(pay.amount)}, ${email || 'no email'}): ${why}`, source: 'payment', dedupeKey: `page-pay-flag:${pay.id}` });
    console.error('[page-payment]', pay.id, why);
  };
  if (!product) return flag(`plan “${planName || 'missing'}” not recognised`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return flag('no valid email on the payment');
  const minAllowed = Number(product.price_paise) - Math.min(Math.round(Number(product.price_paise) * 0.10 / 100) * 100, 15000);
  if (Number(pay.amount) < minAllowed) return flag(`amount below ${product.name} price`);
  const order = await db.tx(async (t) => {
    let st = await t.one('select id from anvaya.students where lower(email) = $1 order by id limit 1', [email]);
    if (!st) st = await t.one(`insert into anvaya.students (name, email, phone, status) values ($1,$2,$3,'active') returning id`, [pay.notes?.name || email.split('@')[0], email, String(pay.contact || '')]);
    return t.one(`insert into anvaya.orders (student_id, product_id, description, amount_paise, provider, provider_order_id, source, discount_paise)
      values ($1,$2,$3,$4,'razorpay',$5,'public_page_direct',$6) returning id`,
    [st.id, product.id, product.name, pay.amount, pay.order_id || null, Math.max(0, Number(product.price_paise) - Number(pay.amount))]);
  });
  await markPaid(order.id, { provider: 'razorpay', providerPaymentId: pay.id, amountPaise: pay.amount, feePaise: pay.fee || 0, taxPaise: pay.tax || 0, method: pay.method || '' });
  await enquiries.convert({ publicId: pay.notes?.enquiry || null, email, planName: product.name, providerPaymentId: pay.id, orderId: order.id }).catch((e) => console.error('[enquiry]', pay.id, e.message));
}

/** Reconciles orders whose outcome we never heard about (missed webhook, closed tab). */
jobs.register('payments.reconcile', async () => {
  const stale = await db.all(`select * from anvaya.orders where status = 'created' and provider = 'razorpay' and provider_order_id is not null
    and created_at < now() - interval '15 minutes' order by created_at limit 50`);
  let resolved = 0;
  for (const o of stale) {
    const r = await rzp('GET', `/orders/${o.provider_order_id}/payments`);
    const captured = (r.items || []).find((x) => x.status === 'captured');
    if (captured) { await markPaid(o.id, { provider: 'razorpay', providerPaymentId: captured.id, amountPaise: captured.amount, feePaise: captured.fee || 0, taxPaise: captured.tax || 0, method: captured.method }); resolved++; }
    else if (new Date(o.created_at) < new Date(Date.now() - 24 * 3600e3)) { await markFailed(o.id, 'No payment received within 24 hours'); resolved++; }
  }
  return { checked: stale.length, resolved };
});

module.exports = { afterPayment, applyRefund, confirmPagePayment, recordPagePayment, configured, checkoutConfig, createOrder, verifyCheckoutSignature, verifyWebhookSignature, markPaid, markFailed, refund, handleWebhook, notifyBookingConfirmed, fake, hmac, rzp };
