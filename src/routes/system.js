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

module.exports = r;
