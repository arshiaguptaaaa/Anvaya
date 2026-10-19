'use strict';
// Request helpers shared by every router: errors, validation, async wrapper, field parsers.

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = (msg) => new HttpError(400, msg);
const notFound = (what = 'Not found.') => new HttpError(404, what);
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const v = {
  str(val, { max = 500, required = false, label = 'Field' } = {}) {
    const s = val == null ? '' : String(val).trim();
    if (required && !s) throw bad(`${label} is required.`);
    if (s.length > max) throw bad(`${label} is too long (max ${max} characters).`);
    return s;
  },
  email(val, { required = true } = {}) {
    const s = v.str(val, { max: 254, required, label: 'Email' }).toLowerCase();
    if (s && !EMAIL_RE.test(s)) throw bad('Please enter a valid email address.');
    return s;
  },
  int(val, { min = 0, max = 10_000_000, label = 'Value', required = false } = {}) {
    if (val === '' || val == null) { if (required) throw bad(`${label} is required.`); return null; }
    const n = Number(val);
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be a whole number between ${min} and ${max}.`);
    return n;
  },
  /** Money arrives from the API in integer paise. */
  paise(val, { label = 'Amount', required = false, min = 0 } = {}) {
    return v.int(val, { min, max: 100_000_000_00, label, required });
  },
  bool(val) { return val === true || val === 'true' || val === 'on' || val === 1 || val === '1'; },
  oneOf(val, list, label = 'Value') {
    if (!list.includes(val)) throw bad(`${label} must be one of: ${list.join(', ')}.`);
    return val;
  },
  date(val, { required = false, label = 'Date' } = {}) {
    if (!val) { if (required) throw bad(`${label} is required.`); return null; }
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) throw bad(`${label} is not a valid date.`);
    return d.toISOString();
  },
  day(val, { required = false, label = 'Date' } = {}) {
    if (!val) { if (required) throw bad(`${label} is required.`); return null; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(val))) throw bad(`${label} must be YYYY-MM-DD.`);
    return String(val);
  },
  url(val, label = 'Link') {
    const s = v.str(val, { max: 500, label });
    if (s && !/^https:\/\/[^\s]+$/i.test(s)) throw bad(`${label} must start with https://`);
    return s;
  },
  time(val) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(val))) throw bad('Times must be in HH:MM format.');
    return String(val);
  },
  id(val, label = 'ID', { required = false } = {}) { return v.int(val, { min: 1, max: Number.MAX_SAFE_INTEGER, label, required }); },
};

const id = (req, key = 'id') => {
  const n = Number(req.params[key]);
  if (!Number.isInteger(n) || n < 1) throw notFound();
  return n;
};
const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
const setClause = (keys, start = 1) => keys.map((k, i) => `${k} = $${i + start}`).join(', ');

/** Async field parser: spec maps field → (value, body) => cleaned. Missing fields are skipped on PATCH. */
const fields = (spec, required = []) => async (body, { partial }) => {
  const out = {};
  for (const [k, fn] of Object.entries(spec)) {
    if (body[k] === undefined) { if (!partial && required.includes(k)) out[k] = await fn(undefined, body); continue; }
    out[k] = await fn(body[k], body);
  }
  return out;
};

/** Builds INSERT … RETURNING id from a cleaned object. */
const insertSql = (table, obj) => {
  const keys = Object.keys(obj);
  return [`insert into anvaya.${table} (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, keys.map((k) => obj[k])];
};
const updateSql = (table, obj, idVal, extraWhere = '') => {
  const keys = Object.keys(obj);
  return [`update anvaya.${table} set ${setClause(keys)} where id = $${keys.length + 1} ${extraWhere}`, [...keys.map((k) => obj[k]), idVal]];
};

module.exports = { HttpError, bad, notFound, v, id, wrap, setClause, fields, insertSql, updateSql, EMAIL_RE };
