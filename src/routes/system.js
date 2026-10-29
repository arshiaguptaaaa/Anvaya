'use strict';
// Machine endpoints: Razorpay webhooks (HMAC-verified, deduplicated) and the cron job worker.
const express = require('express');
const crypto = require('node:crypto');
const payments = require('../lib/payments');
const jobs = require('../lib/jobs');
const { schedulePeriodic } = require('../lib/maintenance');
const { wrap } = require('../lib/http');

const r = express.Router();

r.post('/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const out = await payments.handleWebhook(raw, { 'x-razorpay-signature': req.get('x-razorpay-signature'), 'x-razorpay-event-id': req.get('x-razorpay-event-id') });
  res.status(out.http).json({ status: out.status });
}));

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
// Resend delivery events (Svix-signed). Updates the email log to delivered / bounced / complained.
r.post('/webhooks/resend', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET || '';
  if (!secret) return res.status(503).json({ error: 'not configured' });
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const id = req.get('svix-id') || '', ts = req.get('svix-timestamp') || '', sigs = req.get('svix-signature') || '';
  if (!id || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.status(401).json({ error: 'stale' });
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  const ok = sigs.split(' ').some((x) => { const v = x.split(',')[1] || ''; return v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)); });
  if (!ok) return res.status(401).json({ error: 'invalid signature' });
  let ev; try { ev = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad json' }); }
  const status = { 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained' }[ev.type];
  const emailId = ev.data?.email_id;
  if (status && emailId) {
    await require('../db').run('update anvaya.email_log set status = $2, error = $3, updated_at = now() where provider_id = $1', [emailId, status, status === 'bounced' ? String(ev.data?.bounce?.message || 'Bounced').slice(0, 300) : '']);
  }
  res.json({ ok: true });
}));

r.get('/cron/run', wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  const sent = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!secret || sent.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(secret))) return res.status(401).json({ error: 'unauthorized' });
  await schedulePeriodic();
  // Keep draining while work is due (e.g. reminder emails queued by the reminders job in this same run).
  const results = [];
  for (let pass = 0; pass < 4; pass++) {
    const batch = await jobs.processDue({ limit: 40 });
    results.push(...batch);
    if (!batch.length) break;
  }
  res.json({ ran: results.length, failed: results.filter((x) => !x.ok).length });
}));

// Read-only health of the background queue and payment set-up (same secret as /cron/run). Never returns secret values.
r.get('/cron/status', wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  const sent = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!secret || sent.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(secret))) return res.status(401).json({ error: 'unauthorized' });
  const db = require('../db');
  const settings = require('../lib/settings');
  const payments = require('../lib/payments');
  res.json({
    migrations: (await db.all("select name from public.anvaya_migrations order by name").catch(() => [])).map((x) => x.name),
    queue: await db.all(`select kind, status, count(*)::int as n, max(last_error) filter (where status in ('failed','dead')) as last_error
      from anvaya.jobs where status <> 'done' or finished_at > now() - interval '1 day' group by kind, status order by kind, status`),
    lastFinishedAt: (await db.one("select max(finished_at) as t from anvaya.jobs where status = 'done'"))?.t || null,
    payments: { razorpayApiKeys: payments.configured(), keyMode: (process.env.RAZORPAY_KEY_ID || '').replace(/^(rzp_[a-z]+)_.*$/, '$1'),
      // read-only call proving the keys authenticate (lists one order; creates and charges nothing)
      razorpayAuth: payments.configured() ? await payments.rzp('GET', '/orders?count=1').then(() => 'ok').catch((e) => e.message) : 'not configured',
      dashboardCheckout: payments.checkoutConfig().provider, reconcileEvery: 'hourly (payments.reconcile) + before each reminder',
      webhookSecret: !!process.env.RAZORPAY_WEBHOOK_SECRET,
      recentWebhooks: await db.all("select event_type, signature_valid, status, received_at from anvaya.webhook_events order by id desc limit 5").catch(() => []) },
    paymentSheet: { url: !!process.env.PAYMENT_SHEET_WEBHOOK_URL, token: !!process.env.PAYMENT_SHEET_TOKEN,
      notifyEmail: process.env.PAYMENT_NOTIFY_EMAIL || 'teamanvaya.in@gmail.com', pageConfirmationSender: await settings.get('page_confirmation_sender'),
      rows: await db.all('select status, sheet_status, page_reported, count(*)::int as n from anvaya.gateway_payments group by 1,2,3') },
    mail: require('../mailer').mailMode(),
    checkoutEnquiries: await db.all('select status, consent, sheet_status, count(*)::int as n from anvaya.checkout_enquiries group by 1,2,3').catch(() => []),
  });
}));

module.exports = r;
