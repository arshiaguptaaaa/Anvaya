'use strict';
// Email delivery. Credentials are read from the server environment only — never sent to the browser.
// Providers, in order of preference:
//   RESEND_API_KEY            → Resend HTTP API (needs a verified sending domain for arbitrary recipients)
//   SMTP_HOST (+ USER / PASS) → any SMTP server (e.g. Gmail with an app password, Zoho, Brevo)
//   MAIL_TRANSPORT=memory     → kept in memory (automated tests only)
// With none configured, sending fails loudly instead of silently dropping invitations.
const nodemailer = require('nodemailer');

const FROM = process.env.MAIL_FROM || 'Anvaya <no-reply@anvaya.local>';
const sent = []; // memory transport (tests)

let mode = 'none';
let transport = null;
if (process.env.RESEND_API_KEY) mode = 'resend';
else if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  mode = 'smtp';
} else if (process.env.MAIL_TRANSPORT === 'memory') mode = 'memory';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Branded HTML wrapper in the Anvaya navy / gold / ivory palette (email-safe inline styles). */
function layout({ heading, bodyHtml, ctaUrl, ctaLabel, footnote }) {
  return `<!doctype html><html><body style="margin:0;background:#08111f;padding:32px 12px;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#0d1b2e;border:1px solid rgba(201,168,76,.22);border-radius:14px;">
<tr><td style="height:2px;background:linear-gradient(90deg,transparent,#c9a84c,transparent);border-radius:14px 14px 0 0;"></td></tr>
<tr><td style="padding:36px 40px 8px;">
  <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;letter-spacing:.2em;color:#f4ede0;text-transform:uppercase;">Anvaya</div>
  <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:11px;letter-spacing:.2em;color:#c9a84c;text-transform:uppercase;margin-top:4px;">Where Purpose Meets Path</div>
</td></tr>
<tr><td style="padding:24px 40px 8px;">
  <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:300;font-size:30px;line-height:1.15;color:#f4ede0;margin:0 0 16px;">${heading}</h1>
  <div style="font-size:15px;line-height:1.8;color:#d9cdb8;">${bodyHtml}</div>
</td></tr>
${ctaUrl ? `<tr><td style="padding:20px 40px 8px;">
  <a href="${esc(ctaUrl)}" style="display:inline-block;background:#c9a84c;color:#08111f;font-size:11px;letter-spacing:.2em;text-transform:uppercase;font-weight:700;padding:16px 32px;border-radius:4px;text-decoration:none;">${esc(ctaLabel)}</a>
  <p style="font-size:12px;color:#7a6e5e;line-height:1.7;margin:18px 0 0;">Or paste this link into your browser:<br><span style="color:#d9cdb8;word-break:break-all;">${esc(ctaUrl)}</span></p>
</td></tr>` : ''}
<tr><td style="padding:24px 40px 36px;font-size:12px;color:#7a6e5e;line-height:1.7;border-top:1px solid rgba(201,168,76,.18);">${footnote || ''}</td></tr>
</table></td></tr></table></body></html>`;
}

async function send({ to, subject, html, text }) {
  const msg = { from: FROM, to, subject, html, text };
  if (mode === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Email provider rejected the message: ${body.message || r.status}`);
    return { mode, id: body.id };
  }
  if (mode === 'smtp') {
    const info = await transport.sendMail(msg);
    return { mode, id: info.messageId };
  }
  if (mode === 'memory') { sent.push({ ...msg, sentAt: new Date().toISOString() }); return { mode }; }
  throw new Error('No email provider is configured (set RESEND_API_KEY or SMTP_HOST on the server).');
}

function sendMentorInvite({ to, name, url, expiresAt, isResend }) {
  const when = new Date(expiresAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  const subject = isResend ? 'Your new Anvaya mentor invitation link' : 'You’re invited to mentor with Anvaya';
  const html = layout({
    heading: `Welcome to Anvaya, <em style="color:#e8c97a;">${esc(name)}</em>`,
    bodyHtml: `<p style="margin:0 0 12px;">You’ve been invited to join Anvaya as a mentor. Accept the invitation to create your password, complete your profile and add your availability — your mentor dashboard opens as soon as you’re done.</p>`,
    ctaUrl: url, ctaLabel: 'Accept invitation',
    footnote: `This link is unique to you, works once, and expires on <strong style="color:#d9cdb8;">${esc(when)} IST</strong>. If it expires, open it anyway and you can request a fresh link. If you weren’t expecting this email, you can ignore it.`,
  });
  const text = `Hi ${name},\n\nYou've been invited to mentor with Anvaya.\nAccept your invitation: ${url}\n\nThis link works once and expires on ${when} IST.\n`;
  return send({ to, subject, html, text });
}

module.exports = { send, sendMentorInvite, mailMode: () => mode, sent };
