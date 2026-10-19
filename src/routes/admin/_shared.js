'use strict';
const sec = require('../../security');
const staff = sec.requireRole('admin', 'ops');
const adminOnly = sec.requireRole('admin');
const isAdmin = (req) => req.auth?.user.role === 'admin';
/** Removes fields ops may not see (sensitive notes, money) from student-like rows. */
function forRole(req, rows, hide = ['notes']) {
  if (isAdmin(req)) return rows;
  const strip = (r) => { const o = { ...r }; for (const k of hide) delete o[k]; return o; };
  return Array.isArray(rows) ? rows.map(strip) : rows && strip(rows);
}
module.exports = { staff, adminOnly, isAdmin, forRole };
