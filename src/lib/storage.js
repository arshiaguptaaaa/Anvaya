'use strict';
// Private file storage. Production: Supabase Storage (private buckets, service key server-side only).
// Browsers upload directly to a short-lived signed upload URL and download via 60-second signed URLs,
// so files never pass through the Vercel function (4.5 MB body limit) and buckets are never public.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   → Supabase driver
//   STORAGE_DRIVER=memory                     → in-process store (tests / local dev only)
const crypto = require('node:crypto');

const BUCKET = process.env.STORAGE_BUCKET || 'anvaya-private';
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'text/plain', 'image/png', 'image/jpeg'];

const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const mode = base && svc ? 'supabase' : (process.env.STORAGE_DRIVER === 'memory' ? 'memory' : 'none');

// ── memory driver (tests/local) ──────────────────────────────────────
const mem = new Map();          // path → { buf, type }
const memTokens = new Map();    // token → { path, op, exp }
const memToken = (p, op, ttl) => { const t = crypto.randomBytes(24).toString('base64url'); memTokens.set(t, { path: p, op, exp: Date.now() + ttl * 1000 }); return t; };

async function sb(pathname, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(`${base}/storage/v1${pathname}`, {
    method, headers: { Authorization: `Bearer ${svc}`, apikey: svc, ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body && !(body instanceof Buffer) ? JSON.stringify(body) : body,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (!r.ok) { const e = new Error(`Storage error ${r.status}: ${(json && (json.message || json.error)) || text.slice(0, 200)}`); e.status = r.status; throw e; }
  return json;
}

let bucketReady = null;
function ensureBucket() {
  if (mode !== 'supabase') return Promise.resolve();
  if (!bucketReady) bucketReady = (async () => {
    try { await sb(`/bucket/${BUCKET}`); }
    catch (e) {
      if (e.status !== 404 && e.status !== 400) throw e;
      await sb('/bucket', { method: 'POST', body: { id: BUCKET, name: BUCKET, public: false, file_size_limit: MAX_BYTES, allowed_mime_types: ALLOWED } });
    }
  })().catch((e) => { bucketReady = null; throw e; });
  return bucketReady;
}

function assertConfigured() {
  if (mode === 'none') { const e = new Error('File storage is not configured yet (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).'); e.status = 503; throw e; }
}

/** Validates an upload request and returns { path, uploadUrl, method, fields }. */
async function createUpload({ prefix, filename, mimeType, size }) {
  assertConfigured();
  if (!ALLOWED.includes(mimeType)) { const e = new Error('Please upload a PDF, Word document, text file or image.'); e.status = 400; throw e; }
  if (!Number.isInteger(size) || size <= 0 || size > MAX_BYTES) { const e = new Error('Files must be smaller than 10 MB.'); e.status = 400; throw e; }
  const safe = String(filename || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
  const path = `${prefix}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safe}`;
  if (mode === 'memory') return { path, uploadUrl: `/api/_storage/upload/${memToken(path, 'put', 600)}`, method: 'PUT' };
  await ensureBucket();
  const r = await sb(`/object/upload/sign/${BUCKET}/${path}`, { method: 'POST', body: {} });
  return { path, uploadUrl: `${base}/storage/v1${r.url}`, method: 'PUT' };
}

/** Confirms the object exists after the browser upload; returns { size, mimeType }. */
async function stat(path) {
  assertConfigured();
  if (mode === 'memory') { const o = mem.get(path); return o ? { size: o.buf.length, mimeType: o.type } : null; }
  const i = path.lastIndexOf('/');
  const items = await sb(`/object/list/${BUCKET}`, { method: 'POST', body: { prefix: path.slice(0, i), search: path.slice(i + 1), limit: 5 } });
  const o = (items || []).find((x) => x.name === path.slice(i + 1));
  return o ? { size: Number(o.metadata?.size || 0), mimeType: o.metadata?.mimetype || '' } : null;
}

/** Short-lived download URL. Callers must authorize first. */
async function signedDownload(path, { ttl = 60, filename } = {}) {
  assertConfigured();
  if (mode === 'memory') return `/api/_storage/download/${memToken(path, 'get', ttl)}`;
  await ensureBucket();
  const r = await sb(`/object/sign/${BUCKET}/${path}`, { method: 'POST', body: { expiresIn: ttl } });
  const url = `${base}/storage/v1${r.signedURL || r.signedUrl}`;
  return filename ? `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(filename)}` : url;
}

async function putText(path, text, mimeType = 'text/plain') {
  assertConfigured();
  if (mode === 'memory') { mem.set(path, { buf: Buffer.from(text), type: mimeType }); return; }
  await ensureBucket();
  await sb(`/object/${BUCKET}/${path}`, { method: 'POST', body: Buffer.from(text), headers: { 'Content-Type': mimeType, 'x-upsert': 'true' } });
}

async function list(prefix = '', { limit = 1000, offset = 0 } = {}) {
  assertConfigured();
  if (mode === 'memory') return [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
  return sb(`/object/list/${BUCKET}`, { method: 'POST', body: { prefix, limit, offset } });
}
async function download(path) {
  assertConfigured();
  if (mode === 'memory') { const o = mem.get(path); if (!o) throw new Error('not found'); return o.buf; }
  const r = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, { headers: { Authorization: `Bearer ${svc}`, apikey: svc } });
  if (!r.ok) throw new Error(`download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Deletes objects (used by the test-data purge). */
async function remove(paths) {
  if (!paths.length || mode === 'none') return 0;
  if (mode === 'memory') { for (const k of paths) mem.delete(k); return paths.length; }
  const out = await sb(`/object/${BUCKET}`, { method: 'DELETE', body: { prefixes: paths } });
  return Array.isArray(out) ? out.length : 0;
}

/** Express handlers for the memory driver only (never mounted when Supabase is configured). */
function memoryRoutes(app, express) {
  if (mode !== 'memory') return;
  app.put('/api/_storage/upload/:token', express.raw({ type: '*/*', limit: MAX_BYTES }), (req, res) => {
    const t = memTokens.get(req.params.token);
    if (!t || t.op !== 'put' || t.exp < Date.now()) return res.status(403).json({ error: 'expired' });
    memTokens.delete(req.params.token);
    mem.set(t.path, { buf: Buffer.from(req.body || []), type: req.get('content-type') || 'application/octet-stream' });
    res.json({ ok: true });
  });
  app.get('/api/_storage/download/:token', (req, res) => {
    const t = memTokens.get(req.params.token);
    if (!t || t.op !== 'get' || t.exp < Date.now()) return res.status(403).json({ error: 'expired' });
    const o = mem.get(t.path);
    if (!o) return res.status(404).end();
    res.type(o.type).send(o.buf);
  });
}

module.exports = { createUpload, stat, signedDownload, putText, list, download, remove, memoryRoutes, mode: () => mode, BUCKET, ALLOWED, MAX_BYTES, origin: () => base };
