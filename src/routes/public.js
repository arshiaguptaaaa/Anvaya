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

const leadLimiter = sec.rateLimiter({ name: 'lead', windowMs: 60 * 60e3, max: 10, key: (req) => req.ip });
r.post('/public/leads', leadLimiter, wrap(async (req, res) => {
  const origin = req.get('origin');
  const allowed = [BASE_URL(), ...(process.env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)];
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

module.exports = r;
