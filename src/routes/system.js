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
r.get('/cron/run', wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  const sent = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!secret || sent.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(secret))) return res.status(401).json({ error: 'unauthorized' });
  await schedulePeriodic();
  const results = await jobs.processDue({ limit: 40 });
  res.json({ ran: results.length, failed: results.filter((x) => !x.ok).length });
}));

module.exports = r;
