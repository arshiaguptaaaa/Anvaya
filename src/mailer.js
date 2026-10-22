'use strict';
// Email delivery. Credentials are read from the server environment only — never sent to the browser.
// Providers, in order of preference:
//   RESEND_API_KEY            → Resend HTTP API (branded sender on your verified domain)
//   SMTP_HOST (+ USER / PASS) → any SMTP server
//   MAIL_TRANSPORT=memory     → kept in memory (automated tests / local dev only)
// With none configured, sending fails loudly (the job is retried and shows as failed in the admin).
const nodemailer = require('nodemailer');

const FROM = process.env.MAIL_FROM || 'Anvaya <no-reply@anvaya.local>';
const REPLY_TO = process.env.MAIL_REPLY_TO || '';
const sent = []; // memory transport

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

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ist = (iso, opts = { dateStyle: 'medium', timeStyle: 'short' }) => new Date(iso).toLocaleString('en-IN', { ...opts, timeZone: 'Asia/Kolkata' }) + (opts.timeStyle ? ' IST' : '');
const inr = (p) => '₹' + (Number(p || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

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
<tr><td style="padding:24px 40px 36px;font-size:12px;color:#7a6e5e;line-height:1.7;border-top:1px solid rgba(201,168,76,.18);">${footnote || 'Anvaya · Where Purpose Meets Path'}</td></tr>
</table></td></tr></table></body></html>`;
}

const em = (s) => `<em style="color:#e8c97a;">${s}</em>`;
const strong = (s) => `<strong style="color:#f4ede0;">${s}</strong>`;

const POLICY_TEXT = 'Rescheduling and cancellation: you can reschedule or cancel online up to 2 hours before the start. Inside 2 hours, message the Anvaya team for an exception. No-show policy: if you miss a confirmed session without notice, the host may record a no-show after the start, which pauses new bookings until the Anvaya team reviews it. You can dispute it from your dashboard.';
const POLICY_HTML = `<strong style="color:#d9cdb8;">Rescheduling:</strong> reschedule or cancel online up to 2 hours before the start; inside 2 hours, message the Anvaya team for an exception.<br><strong style="color:#d9cdb8;">No-show policy:</strong> if you miss a confirmed session without notice, the host may record a no-show, which pauses new bookings until it's reviewed. You can dispute it from your dashboard.`;
const sessionRows = (d) => `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#d9cdb8;">
  <tr><td style="padding:2px 14px 2px 0;color:#7a6e5e;">Date</td><td>${esc(ist(d.startsAt, { dateStyle: 'full' }))}</td></tr>
  <tr><td style="padding:2px 14px 2px 0;color:#7a6e5e;">Time</td><td>${esc(new Date(d.startsAt).toLocaleString('en-IN', { timeStyle: 'short', timeZone: 'Asia/Kolkata' }))} IST (Asia/Kolkata, GMT+5:30)</td></tr>
  <tr><td style="padding:2px 14px 2px 0;color:#7a6e5e;">Duration</td><td>${esc(d.duration)} minutes</td></tr>
  <tr><td style="padding:2px 14px 2px 0;color:#7a6e5e;">Mentor</td><td>${esc(d.mentorName)}</td></tr></table>`;

/** Template name → { subject, html, text }. Data is untrusted and always escaped. */
const templates = {
  mentor_invite: (d) => ({
    subject: d.isResend ? 'Your new Anvaya mentor invitation link' : 'You’re invited to mentor with Anvaya',
    html: layout({
      heading: `Welcome to Anvaya, ${em(esc(d.name))}`,
      bodyHtml: '<p style="margin:0 0 12px;">You’ve been invited to join Anvaya as a mentor. Accept the invitation to create your password, complete your profile and add your availability — your mentor dashboard opens as soon as you’re done.</p>',
      ctaUrl: d.url, ctaLabel: 'Accept invitation',
      footnote: `This link is unique to you, works once, and expires on ${strong(esc(ist(d.expiresAt)))}. If it expires, open it anyway to request a fresh link. If you weren’t expecting this email, you can ignore it.`,
    }),
    text: `Hi ${d.name},\n\nYou've been invited to mentor with Anvaya.\nAccept your invitation: ${d.url}\n\nThis link works once and expires on ${ist(d.expiresAt)}.\n`,
  }),
  student_invite: (d) => ({
    subject: d.isResend ? 'Your new Anvaya sign-up link' : 'Your Anvaya student account is ready',
    html: layout({
      heading: `Welcome, ${em(esc(d.name))}`,
      bodyHtml: '<p style="margin:0 0 12px;">Your Anvaya student dashboard is ready. Set your password, complete your intake and upload your resume — then you’ll see your plan, syllabus, group and upcoming sessions.</p>',
      ctaUrl: d.url, ctaLabel: 'Set up my account',
      footnote: `This link works once and expires on ${strong(esc(ist(d.expiresAt)))}. If it expires, open it anyway to request a fresh link.`,
    }),
    text: `Hi ${d.name},\n\nYour Anvaya student account is ready: ${d.url}\nThis link works once and expires on ${ist(d.expiresAt)}.\n`,
  }),
  staff_invite: (d) => ({
    subject: d.isResend ? 'Your new Anvaya team sign-up link' : 'You’ve been added to the Anvaya team',
    html: layout({
      heading: `Welcome to the team, ${em(esc(d.name))}`,
      bodyHtml: '<p style="margin:0 0 12px;">You’ve been given access to the Anvaya operations dashboard. Set your password to get started.</p>',
      ctaUrl: d.url, ctaLabel: 'Set my password',
      footnote: `This link works once and expires on ${strong(esc(ist(d.expiresAt)))}.`,
    }),
    text: `Hi ${d.name},\n\nYou've been added to the Anvaya team: ${d.url}\nThis link works once and expires on ${ist(d.expiresAt)}.\n`,
  }),
  password_reset: (d) => ({
    subject: 'Reset your Anvaya password',
    html: layout({
      heading: `Reset your ${em('password')}`,
      bodyHtml: '<p style="margin:0 0 12px;">Someone (hopefully you) asked to reset the password for your Anvaya account. Use the button below to choose a new one.</p>',
      ctaUrl: d.url, ctaLabel: 'Choose a new password',
      footnote: `This link works once and expires on ${strong(esc(ist(d.expiresAt)))}. If you didn’t ask for this, ignore this email — your password won’t change.`,
    }),
    text: `Reset your Anvaya password: ${d.url}\nThis link works once and expires on ${ist(d.expiresAt)}. If you didn't ask for this, ignore this email.\n`,
  }),
  booking_confirmed: (d) => ({
    subject: `Confirmed: ${d.service} on ${ist(d.startsAt, { dateStyle: 'medium' })}`,
    html: layout({
      heading: `Your session is ${em('confirmed')}`,
      bodyHtml: `<p style="margin:0 0 12px;">${strong(esc(d.service))} with ${esc(d.mentorName)}<br>${esc(ist(d.startsAt))} · ${esc(d.duration)} min</p>${d.meetLink ? `<p style="margin:0;">Join: <a style="color:#c9a84c;" href="${esc(d.meetLink)}">${esc(d.meetLink)}</a></p>` : ''}`,
      ctaUrl: d.dashboardUrl, ctaLabel: 'Open dashboard',
    }),
    text: `Confirmed: ${d.service} with ${d.mentorName} on ${ist(d.startsAt)} (${d.duration} min). ${d.meetLink || ''}\n`,
  }),
  staff_message: (d) => ({
    subject: d.subject ? `Anvaya: ${d.subject}` : 'A message from the Anvaya team',
    html: layout({
      heading: `A message from ${em('Anvaya')}`,
      bodyHtml: `<p style="margin:0 0 12px;white-space:pre-line;">${esc(d.body)}</p><p style="margin:0;color:#7a6e5e;font-size:13px;">From ${esc(d.from || 'the Anvaya team')}. Reply in your dashboard so the whole team can see it.</p>`,
      ctaUrl: d.dashboardUrl, ctaLabel: 'Open dashboard',
    }),
    text: `${d.body}\n\nFrom ${d.from || 'the Anvaya team'}. Reply in your dashboard: ${d.dashboardUrl}\n`,
  }),
  payment_confirmed: (d) => ({
    subject: `Payment received: ${d.item}`,
    html: layout({
      heading: `You’re ${em('all set')}`,
      bodyHtml: `<p style="margin:0 0 12px;">We’ve received your payment for ${strong(esc(d.item))}${d.validTill ? `. Your access runs until ${strong(esc(ist(d.validTill, { dateStyle: 'medium' })))}` : ''}.</p>${d.setupUrl ? `<p style="margin:0 0 12px;">Next: set up your account and complete a short intake so we can match you to a group and mentor.</p>` : `<p style="margin:0 0 12px;">Next: ${esc(d.nextStep || 'open your dashboard to see what’s included.')}</p>`}`,
      ctaUrl: d.setupUrl || d.dashboardUrl, ctaLabel: d.setupUrl ? 'Set up your account' : 'Open dashboard',
    }),
    text: `Payment received for ${d.item}.${d.validTill ? ` Access until ${ist(d.validTill, { dateStyle: 'medium' })}.` : ''} ${d.setupUrl ? `Set up your account: ${d.setupUrl}` : `Open your dashboard: ${d.dashboardUrl}`}\n`,
  }),
  session_changed: (d) => ({
    subject: d.cancelled ? `Cancelled: ${d.title} · ${ist(d.previousAt)}` : `Rescheduled: ${d.title} → ${ist(d.startsAt)}`,
    html: layout({
      heading: d.cancelled ? `Session ${em('cancelled')}` : `Session ${em('rescheduled')}`,
      bodyHtml: d.cancelled
        ? `<p style="margin:0;">${strong(esc(d.title))}${d.forHost && d.studentName ? ` with ${esc(d.studentName)}` : ''} on ${esc(ist(d.previousAt))} has been cancelled.${d.reason ? ` ${esc(d.reason)}` : ''}</p>`
        : `<p style="margin:0 0 12px;">${strong(esc(d.title))}${d.forHost && d.studentName ? ` with ${esc(d.studentName)}` : ''} has moved from ${esc(ist(d.previousAt))} to:</p>${sessionRows(d)}${d.meetLink ? `<p style="margin:12px 0 0;">Google Meet: <a style="color:#c9a84c;" href="${esc(d.meetLink)}">${esc(d.meetLink)}</a>${d.icsUrl ? ` &nbsp;·&nbsp; <a style="color:#c9a84c;" href="${esc(d.icsUrl)}">Updated calendar invite (.ics)</a>` : ''}</p>` : ''}`,
      ctaUrl: d.dashboardUrl, ctaLabel: 'Open dashboard', footnote: d.cancelled ? undefined : POLICY_HTML,
    }),
    text: d.cancelled ? `Cancelled: ${d.title} on ${ist(d.previousAt)}. ${d.reason || ''}\n` : `Rescheduled: ${d.title} now ${ist(d.startsAt)} (was ${ist(d.previousAt)}). ${d.meetLink ? `Meet: ${d.meetLink}` : ''}\n`,
  }),
  // ── Session lifecycle (times always shown in IST with the timezone) ──
  session_requested: (d) => ({
    subject: `Request received: ${d.title} on ${ist(d.startsAt, { dateStyle: 'medium' })}`,
    html: layout({
      heading: `Request ${em('received')}`,
      bodyHtml: `<p style="margin:0 0 12px;">We've received your request for ${strong(esc(d.title))} with ${esc(d.mentorName)}.</p>${sessionRows(d)}
        <p style="margin:12px 0 0;">${strong('This is not confirmed yet.')} Your preferred slot is held until ${esc(ist(d.holdUntil))} while ${esc(d.mentorName)} reviews it. You'll get a confirmation with the Google Meet link once it's approved.</p>`,
      ctaUrl: d.dashboardUrl, ctaLabel: 'View request', footnote: POLICY_HTML,
    }),
    text: `Request received (not yet confirmed): ${d.title} with ${d.mentorName}, ${ist(d.startsAt)}, ${d.duration} min. Slot held until ${ist(d.holdUntil)} while it is reviewed. ${d.dashboardUrl}\n\n${POLICY_TEXT}\n`,
  }),
  session_request_host: (d) => ({
    subject: `New session request: ${d.studentName} · ${ist(d.startsAt)}`,
    html: layout({
      heading: `New ${em('request')}`,
      bodyHtml: `<p style="margin:0 0 12px;">${strong(esc(d.studentName))} requested ${strong(esc(d.title))}.</p>${sessionRows(d)}<p style="margin:12px 0 0;">The slot is held until ${esc(ist(d.holdUntil))}. Approve, decline or suggest another time.</p>`,
      ctaUrl: d.reviewUrl, ctaLabel: 'Review request',
    }),
    text: `New request from ${d.studentName}: ${d.title}, ${ist(d.startsAt)}, ${d.duration} min. Held until ${ist(d.holdUntil)}. Review: ${d.reviewUrl}\n`,
  }),
  session_declined: (d) => ({
    subject: `Not available: ${d.title} on ${ist(d.startsAt, { dateStyle: 'medium' })}`,
    html: layout({ heading: `Slot ${em('not available')}`, bodyHtml: `<p style="margin:0 0 12px;">${esc(d.mentorName)} can't take ${strong(esc(d.title))} at ${esc(ist(d.startsAt))}.${d.reason ? ` ${esc(d.reason)}` : ''}</p><p style="margin:0;">The slot has been released. Pick another time, or send us your preferred dates.</p>`,
      ctaUrl: d.dashboardUrl, ctaLabel: 'Choose another time' }),
    text: `${d.mentorName} can't take ${d.title} at ${ist(d.startsAt)}. ${d.reason || ''} Choose another time: ${d.dashboardUrl}\n`,
  }),
  session_proposed: (d) => ({
    subject: `New time suggested: ${d.title}`,
    html: layout({ heading: `A new time is ${em('suggested')}`, bodyHtml: `<p style="margin:0 0 12px;">${esc(d.mentorName)} can't do ${esc(ist(d.previousAt))} and suggests ${strong(esc(ist(d.startsAt)))} for ${strong(esc(d.title))}.</p><p style="margin:0;">Accept it in your dashboard and we'll confirm with a Google Meet link. ${strong('Not confirmed until you accept.')}</p>`,
      ctaUrl: d.dashboardUrl, ctaLabel: 'Review suggested time' }),
    text: `${d.mentorName} suggests ${ist(d.startsAt)} instead of ${ist(d.previousAt)} for ${d.title}. Accept in your dashboard: ${d.dashboardUrl}\n`,
  }),
  session_payment_needed: (d) => ({
    subject: `Approved, payment due: ${d.title} on ${ist(d.startsAt, { dateStyle: 'medium' })}`,
    html: layout({ heading: `Approved, ${em('complete payment')}`, bodyHtml: `<p style="margin:0 0 12px;">${esc(d.mentorName)} approved ${strong(esc(d.title))}.</p>${sessionRows(d)}<p style="margin:12px 0 0;">Pay ${strong(esc(d.amount))} by ${esc(ist(d.payBy))} to confirm. You'll receive the Google Meet link after payment.</p>`,
      ctaUrl: d.dashboardUrl, ctaLabel: 'Pay and confirm', footnote: POLICY_HTML }),
    text: `Approved: ${d.title}, ${ist(d.startsAt)}. Pay ${d.amount} by ${ist(d.payBy)} to confirm: ${d.dashboardUrl}\n`,
  }),
  session_confirmed: (d) => ({
    subject: `Confirmed: ${d.title} · ${ist(d.startsAt)}`,
    html: layout({
      heading: `Your session is ${em('confirmed')}`,
      bodyHtml: `<p style="margin:0 0 12px;">${d.forHost ? `${strong(esc(d.studentName))} · ` : ''}${strong(esc(d.title))} with ${esc(d.mentorName)}</p>${sessionRows(d)}
        <p style="margin:16px 0 0;"><a href="${esc(d.meetLink)}" style="display:inline-block;background:#c9a84c;color:#08111f;font-size:11px;letter-spacing:.2em;text-transform:uppercase;font-weight:700;padding:14px 26px;border-radius:4px;text-decoration:none;">Join Google Meet</a></p>
        <p style="margin:10px 0 0;font-size:13px;color:#d9cdb8;">${esc(d.meetLink)}</p>
        <p style="margin:16px 0 0;font-size:13px;"><a style="color:#c9a84c;" href="${esc(d.gcalUrl)}">Add to Google Calendar</a>${d.icsUrl ? ` &nbsp;·&nbsp; <a style="color:#c9a84c;" href="${esc(d.icsUrl)}">Download calendar invite (.ics)</a>` : ''}</p>
        ${d.forHost ? '' : `<p style="margin:10px 0 0;font-size:13px;"><a style="color:#c9a84c;" href="${esc(d.rescheduleUrl)}">Reschedule</a> &nbsp;·&nbsp; <a style="color:#c9a84c;" href="${esc(d.cancelUrl)}">Cancel</a></p>`}`,
      footnote: POLICY_HTML,
    }),
    text: `Confirmed: ${d.title} with ${d.mentorName}\n${ist(d.startsAt)} (Asia/Kolkata), ${d.duration} min\nJoin Google Meet: ${d.meetLink}\nAdd to Google Calendar: ${d.gcalUrl}\n${d.icsUrl ? `Calendar invite (.ics): ${d.icsUrl}\n` : ''}${d.forHost ? '' : `Reschedule: ${d.rescheduleUrl}\nCancel: ${d.cancelUrl}\n`}\n${POLICY_TEXT}\n`,
  }),
  // ── Free chats booked from the website (the visitor has no account, so no dashboard links) ──
  freechat_requested: (d) => ({
    subject: `Request received: free chat on ${ist(d.startsAt)}`,
    html: layout({
      heading: `Request ${em('received')}`,
      bodyHtml: `<p style="margin:0 0 12px;">Hi ${esc(d.name)}, thanks for picking a time for your ${strong('free 15-minute chat')} with Anvaya.</p>${sessionRows(d)}
        <p style="margin:12px 0 0;">${strong('This is not confirmed yet.')} We're holding the slot for you and will confirm it shortly. Your confirmation email will include the Google Meet link and a calendar invite.</p>`,
      footnote: 'Need a different time? Just reply to this email or message us on WhatsApp.',
    }),
    text: `Hi ${d.name}, we've received your free chat request for ${ist(d.startsAt)} (${d.duration} min). This is not confirmed yet; we'll email you the Google Meet link once it is.\n`,
  }),
  freechat_confirmed: (d) => ({
    subject: `Confirmed: your free chat · ${ist(d.startsAt)}`,
    html: layout({
      heading: `Your free chat is ${em('confirmed')}`,
      bodyHtml: `<p style="margin:0 0 12px;">Hi ${esc(d.name)}, see you soon.</p>${sessionRows(d)}
        <p style="margin:16px 0 0;"><a href="${esc(d.meetLink)}" style="display:inline-block;background:#c9a84c;color:#08111f;font-size:11px;letter-spacing:.2em;text-transform:uppercase;font-weight:700;padding:14px 26px;border-radius:4px;text-decoration:none;">Join Google Meet</a></p>
        <p style="margin:10px 0 0;font-size:13px;color:#d9cdb8;">${esc(d.meetLink)}</p>
        <p style="margin:16px 0 0;font-size:13px;"><a style="color:#c9a84c;" href="${esc(d.gcalUrl)}">Add to Google Calendar</a> · the calendar invite is attached.</p>`,
      footnote: 'Need to change or cancel? Reply to this email or message us on WhatsApp.',
    }),
    text: `Confirmed: your free chat with Anvaya\n${ist(d.startsAt)} (Asia/Kolkata), ${d.duration} min\nJoin Google Meet: ${d.meetLink}\nAdd to Google Calendar: ${d.gcalUrl}\nNeed to change it? Reply to this email.\n`,
  }),
  freechat_declined: (d) => ({
    subject: d.expired ? 'About your free chat request' : d.cancelled ? `Cancelled: your free chat on ${ist(d.startsAt, { dateStyle: 'medium' })}` : `That time isn't available: free chat on ${ist(d.startsAt, { dateStyle: 'medium' })}`,
    html: layout({
      heading: d.cancelled ? `Free chat ${em('cancelled')}` : `Let's find ${em('another time')}`,
      bodyHtml: `<p style="margin:0 0 12px;">Hi ${esc(d.name)}, ${d.expired ? `we couldn't confirm your free chat for ${esc(ist(d.startsAt))} in time, so the slot was released.` : d.cancelled ? `your free chat on ${esc(ist(d.startsAt))} has been cancelled.` : `we can't make ${esc(ist(d.startsAt))} work.`}${d.reason ? ` ${esc(d.reason)}` : ''}</p>
        <p style="margin:0;">Pick another time on our website, or just reply to this email and we'll set it up with you.</p>`,
      ctaUrl: d.chatUrl, ctaLabel: 'Pick another time',
    }),
    text: `Hi ${d.name}, ${d.expired ? `we couldn't confirm your free chat for ${ist(d.startsAt)} in time.` : d.cancelled ? `your free chat on ${ist(d.startsAt)} has been cancelled.` : `we can't make ${ist(d.startsAt)} work.`} ${d.reason || ''} Pick another time: ${d.chatUrl}\n`,
  }),
  request_expired: (d) => ({
    subject: `Request expired: ${d.title}`,
    html: layout({ heading: `Request ${em('expired')}`, bodyHtml: `<p style="margin:0;">Your request for ${strong(esc(d.title))} at ${esc(ist(d.startsAt))} wasn't approved in time, so the slot has been released. Please choose another time.</p>`, ctaUrl: d.dashboardUrl, ctaLabel: 'Choose another time' }),
    text: `Your request for ${d.title} at ${ist(d.startsAt)} expired and the slot was released. Choose another time: ${d.dashboardUrl}\n`,
  }),
  no_show_student: (d) => ({
    subject: `Missed session: ${d.title} · ${ist(d.startsAt, { dateStyle: 'medium' })}`,
    html: layout({
      heading: `We missed you at your ${em('session')}`,
      bodyHtml: `<p style="margin:0 0 12px;">${esc(d.mentorName)} recorded that you didn't join ${strong(esc(d.title))}.</p>${sessionRows(d)}
        <p style="margin:12px 0 0;">Under Anvaya's no-show policy, ${strong('new bookings and session requests are paused')} on your account until this is reviewed. Your account, purchased materials and any sessions already confirmed are not affected.</p>
        <p style="margin:12px 0 0;">If this isn't right (for example, you joined but couldn't get in), tell us and we'll review it.</p>`,
      ctaUrl: d.disputeUrl, ctaLabel: 'Dispute this',
    }),
    text: `${d.mentorName} recorded that you didn't join ${d.title} at ${ist(d.startsAt)}. New bookings are paused until this is reviewed. Your account, materials and confirmed sessions are unaffected. Dispute it: ${d.disputeUrl}\n`,
  }),
  no_show_admin: (d) => ({
    subject: `No-show recorded: ${d.studentName} · ${d.title}`,
    html: layout({ heading: `No-show ${em('recorded')}`, bodyHtml: `<p style="margin:0 0 12px;">${strong(esc(d.markedBy))} marked ${strong(esc(d.studentName))} as a no-show for ${esc(d.title)} at ${esc(ist(d.startsAt))}.</p><p style="margin:0 0 12px;">Reason: ${esc(d.reason)}</p><p style="margin:0;">Their new bookings are blocked. ${d.upcoming ? `${d.upcoming} upcoming booking(s) are flagged for your review.` : ''}</p>`,
      ctaUrl: d.adminUrl, ctaLabel: 'Review in admin' }),
    text: `${d.markedBy} marked ${d.studentName} as a no-show for ${d.title} at ${ist(d.startsAt)}. Reason: ${d.reason}. Review: ${d.adminUrl}\n`,
  }),
  booking_restored: (d) => ({
    subject: 'Your Anvaya booking access is restored',
    html: layout({ heading: `Booking access ${em('restored')}`, bodyHtml: `<p style="margin:0;">We've reviewed the missed-session record for ${esc(d.title)} on ${esc(ist(d.startsAt, { dateStyle: 'medium' }))} and reversed it. You can book and request sessions again.</p>`, ctaUrl: d.dashboardUrl, ctaLabel: 'Book a session' }),
    text: `We reversed the missed-session record for ${d.title}. You can book sessions again: ${d.dashboardUrl}\n`,
  }),
  session_reminder: (d) => ({
    subject: `Reminder: ${d.title} — ${ist(d.startsAt)}`,
    html: layout({
      heading: `Coming up ${em('soon')}`,
      bodyHtml: `<p style="margin:0 0 12px;">${strong(esc(d.title))}<br>${esc(ist(d.startsAt))}</p>${d.meetLink ? `<p style="margin:0;">Join: <a style="color:#c9a84c;" href="${esc(d.meetLink)}">${esc(d.meetLink)}</a></p>` : ''}`,
      ctaUrl: d.dashboardUrl, ctaLabel: 'Open dashboard',
    }),
    text: `Reminder: ${d.title} at ${ist(d.startsAt)}. ${d.meetLink || ''}\n`,
  }),
  renewal_reminder: (d) => ({
    subject: d.daysLeft > 0 ? `Your Anvaya plan renews in ${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'}` : 'Your Anvaya plan has ended',
    html: layout({
      heading: d.daysLeft > 0 ? `Time to ${em('renew')}` : `Your plan has ${em('ended')}`,
      bodyHtml: `<p style="margin:0 0 12px;">${esc(d.planName)} is paid through ${strong(esc(ist(d.paidThrough, { dateStyle: 'medium' })))}.${d.graceUntil ? ` Access continues until ${esc(ist(d.graceUntil, { dateStyle: 'medium' }))} while you renew.` : ''}</p>`,
      ctaUrl: d.dashboardUrl, ctaLabel: 'Renew my plan',
    }),
    text: `${d.planName} is paid through ${ist(d.paidThrough, { dateStyle: 'medium' })}. Renew: ${d.dashboardUrl}\n`,
  }),
  case_delivered: (d) => ({
    subject: `Your ${d.serviceName} is ready`,
    html: layout({
      heading: `Your document is ${em('ready')}`,
      bodyHtml: `<p style="margin:0 0 12px;">Your ${esc(d.serviceName)} has been reviewed and approved by the Anvaya team. Download it from your dashboard — you can request a revision there too.</p>`,
      ctaUrl: d.dashboardUrl, ctaLabel: 'View in dashboard',
    }),
    text: `Your ${d.serviceName} is ready: ${d.dashboardUrl}\n`,
  }),
  test: (d) => ({
    subject: 'Anvaya email test',
    html: layout({ heading: `Email is ${em('working')}`, bodyHtml: `<p style="margin:0;">Sent from ${esc(d.from)} at ${esc(ist(new Date().toISOString()))}.</p>` }),
    text: `Anvaya email test from ${d.from}.\n`,
  }),
};

async function send({ to, subject, html, text, attachments }) {
  if (mode === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text, ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
        ...(attachments?.length ? { attachments: attachments.map((x) => ({ filename: x.filename, content: Buffer.from(x.content).toString('base64'), content_type: x.contentType })) } : {}) }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Email provider rejected the message: ${body.message || r.status}`);
    return { mode, id: body.id };
  }
  if (mode === 'smtp') {
    const info = await transport.sendMail({ from: FROM, to, subject, html, text, ...(REPLY_TO ? { replyTo: REPLY_TO } : {}), ...(attachments?.length ? { attachments } : {}) });
    return { mode, id: info.messageId };
  }
  if (mode === 'memory') { sent.push({ from: FROM, to, subject, html, text, attachments: attachments || [], sentAt: new Date().toISOString() }); return { mode, id: `mem_${sent.length}` }; }
  throw new Error('No email provider is configured (set RESEND_API_KEY and MAIL_FROM on the server).');
}

function render(template, data) {
  const t = templates[template];
  if (!t) throw new Error(`Unknown email template "${template}"`);
  return t(data);
}

/** Resend domain status + the DNS records it requires (admin → Settings). Never exposes the key. */
async function resendDomains() {
  if (mode !== 'resend') return null;
  const h = { Authorization: `Bearer ${process.env.RESEND_API_KEY}` };
  const r = await fetch('https://api.resend.com/domains', { headers: h });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || `Resend error ${r.status}`);
  const out = [];
  for (const d of body.data || []) {
    const det = await fetch(`https://api.resend.com/domains/${d.id}`, { headers: h }).then((x) => x.json()).catch(() => ({}));
    out.push({ id: d.id, name: d.name, status: d.status, region: d.region,
      records: (det.records || []).map((x) => ({ record: x.record, type: x.type, name: x.name, value: x.value, priority: x.priority, status: x.status })) });
  }
  return out;
}

/** Registers the sending domain with Resend (if missing) and asks it to verify the DNS records. */
async function resendSetupDomain(name, region = 'ap-northeast-1') {
  if (mode !== 'resend') throw Object.assign(new Error('Set RESEND_API_KEY first.'), { status: 400 });
  const h = { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  const list = await fetch('https://api.resend.com/domains', { headers: h }).then((r) => r.json());
  let dom = (list.data || []).find((x) => x.name === name);
  if (!dom) {
    const r = await fetch('https://api.resend.com/domains', { method: 'POST', headers: h, body: JSON.stringify({ name, region }) });
    dom = await r.json();
    if (!r.ok) throw Object.assign(new Error(dom.message || `Resend error ${r.status}`), { status: 502 });
  }
  await fetch(`https://api.resend.com/domains/${dom.id}/verify`, { method: 'POST', headers: h }).catch(() => {});
  return resendDomains();
}

module.exports = { POLICY_TEXT, send, render, mailMode: () => mode, from: () => FROM, sent, resendDomains, resendSetupDomain, ist, inr, esc };
