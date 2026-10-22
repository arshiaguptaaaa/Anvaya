'use strict';
// Google Calendar for hosts (admins/mentors): OAuth connection (offline refresh token, sealed with APP_SECRET),
// free/busy from the calendars they select, and events with a real Google Meet link on their booking calendar.
// GOOGLE_CALENDAR_FAKE=1 swaps in an in-memory calendar for the automated tests only.
const db = require('../db');
const jobs = require('./jobs');

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const FAKE = () => process.env.GOOGLE_CALENDAR_FAKE === '1';
const configured = () => FAKE() || !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const redirectUri = () => `${(process.env.APP_BASE_URL || '').replace(/\/$/, '')}/api/calendar/google/callback`;

// ── in-memory fake (tests) ──
const fake = { events: new Map(), busy: [], fail: false, disconnected: false, seq: 0 };

function authUrl(state) {
  const q = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return `${AUTH_URL}?${q}`;
}

async function exchangeCode(code) {
  if (FAKE()) { if (code !== 'fake-code') throw new Error('invalid_grant'); return { refreshToken: 'fake-refresh', email: 'host@test' }; }
  const r = await fetch(TOKEN_URL, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(), grant_type: 'authorization_code' }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || !b.refresh_token) throw new Error(b.error_description || b.error || 'Google did not return calendar access. Please try again and allow calendar access.');
  const who = JSON.parse(Buffer.from(String(b.id_token || '').split('.')[1] || 'e30', 'base64url').toString() || '{}');
  return { refreshToken: b.refresh_token, email: String(who.email || '').toLowerCase() };
}

const tokenCache = new Map(); // user_id → { token, exp }
async function accessToken(conn) {
  const c = tokenCache.get(conn.user_id);
  if (c && c.exp > Date.now() + 60e3) return c.token;
  const refresh = jobs.unseal(conn.refresh_token).token;
  const r = await fetch(TOKEN_URL, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refresh, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = b.error === 'invalid_grant' ? 'Google access was revoked or expired. Reconnect Google Calendar.' : `Google token error: ${b.error || r.status}`;
    await db.run("update anvaya.calendar_connections set status = $2, last_error = $3, updated_at = now() where id = $1", [conn.id, b.error === 'invalid_grant' ? 'revoked' : 'error', msg]);
    throw new Error(msg);
  }
  tokenCache.set(conn.user_id, { token: b.access_token, exp: Date.now() + (b.expires_in || 3600) * 1000 });
  return b.access_token;
}

async function api(conn, method, path, body) {
  const r = await fetch(API + path, { method, signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${await accessToken(conn)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return {};
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Calendar: ${b.error?.message || r.status}`);
  return b;
}

async function saveConnection(userId, { refreshToken, email }) {
  await db.run(`insert into anvaya.calendar_connections (user_id, google_email, refresh_token) values ($1,$2,$3)
    on conflict (user_id) do update set google_email = excluded.google_email, refresh_token = excluded.refresh_token, status = 'active', last_error = '', updated_at = now()`,
  [userId, email, JSON.stringify(jobs.seal({ token: refreshToken }))]);
  tokenCache.delete(userId);
}
async function connectionFor(userId, q = db) {
  if (!userId) return null;
  const row = await q.one("select * from anvaya.calendar_connections where user_id = $1 and status = 'active'", [userId]);
  // Tests: every host counts as connected unless a test switches it off.
  if (!row && FAKE() && !fake.disconnected) return { id: 0, user_id: userId, google_email: 'host@test', busy_calendar_ids: ['primary'], booking_calendar_id: 'primary' };
  return row;
}

async function listCalendars(conn) {
  if (FAKE()) return [{ id: 'primary', summary: 'Primary (test)', primary: true }];
  const b = await api(conn, 'GET', '/users/me/calendarList?minAccessRole=reader');
  return (b.items || []).map((c) => ({ id: c.id, summary: c.summaryOverride || c.summary, primary: !!c.primary, canWrite: ['owner', 'writer'].includes(c.accessRole) }));
}

const busyCache = new Map(); // conn.id → { at, from, to, ranges }
/** Busy ranges [startMs, endMs] from the host's selected calendars (private details are never read or exposed). */
async function busy(conn, from, to) {
  if (FAKE()) return fake.busy.map(([s, e]) => [new Date(s).getTime(), new Date(e).getTime()]);
  const c = busyCache.get(conn.id);
  if (c && Date.now() - c.at < 3 * 60e3 && c.from <= from && c.to >= to) return c.ranges;
  const b = await api(conn, 'POST', '/freeBusy', { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: conn.busy_calendar_ids.map((id) => ({ id })) });
  const ranges = Object.values(b.calendars || {}).flatMap((x) => x.busy || []).map((x) => [new Date(x.start).getTime(), new Date(x.end).getTime()]);
  busyCache.set(conn.id, { at: Date.now(), from, to, ranges });
  return ranges;
}

/** Creates (or updates) the booking's event with a Google Meet link. Returns { eventId, calendarId, meetLink }. */
async function upsertEvent(conn, { eventId, calendarId, requestId, summary, description, start, end, attendees }) {
  if (FAKE()) {
    if (fake.fail) throw new Error('Google Calendar: simulated failure');
    const id = eventId || `evt_fake_${++fake.seq}`;
    const prev = fake.events.get(id);
    const meet = prev?.meetLink || `https://meet.google.com/fak-${String(fake.seq).padStart(4, '0')}-tst`;
    fake.events.set(id, { id, summary, start, end, attendees, meetLink: meet, status: 'confirmed' });
    return { eventId: id, calendarId: calendarId || 'primary', meetLink: meet };
  }
  const cal = encodeURIComponent(calendarId || conn.booking_calendar_id || 'primary');
  const body = { summary, description, start: { dateTime: new Date(start).toISOString(), timeZone: 'Asia/Kolkata' }, end: { dateTime: new Date(end).toISOString(), timeZone: 'Asia/Kolkata' },
    attendees: attendees.map((email) => ({ email })), guestsCanModify: false, reminders: { useDefault: true } };
  let ev;
  if (eventId) ev = await api(conn, 'PATCH', `/calendars/${cal}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=none`, body);
  else ev = await api(conn, 'POST', `/calendars/${cal}/events?conferenceDataVersion=1&sendUpdates=none`, { ...body, conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } });
  const meet = ev.hangoutLink || (ev.conferenceData?.entryPoints || []).find((p) => p.entryPointType === 'video')?.uri;
  if (!meet) throw new Error('Google created the event but no Meet link yet');
  return { eventId: ev.id, calendarId: decodeURIComponent(cal), meetLink: meet };
}

async function cancelEvent(conn, { eventId, calendarId }) {
  if (!eventId) return;
  if (FAKE()) { const e = fake.events.get(eventId); if (e) e.status = 'cancelled'; return; }
  await api(conn, 'DELETE', `/calendars/${encodeURIComponent(calendarId || 'primary')}/events/${encodeURIComponent(eventId)}?sendUpdates=none`).catch((e) => {
    if (!/404|410|deleted/i.test(e.message)) throw e;
  });
}

module.exports = { SCOPES, configured, authUrl, exchangeCode, saveConnection, connectionFor, listCalendars, busy, upsertEvent, cancelEvent, redirectUri, fake, FAKE };
