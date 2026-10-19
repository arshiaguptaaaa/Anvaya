'use strict';
// Resume / LinkedIn / coaching service cases, Resume Strategy Playbook versions and AI runs.
// Workflow: intake → assigned → first_draft → coach_edit → qa → delivered → revision → … → closed.
// Delivery requires a passing QA review of the exact version being delivered AND an admin approval.
const express = require('express');
const db = require('../../db');
const ledger = require('../../lib/ledger');
const { sendEmail } = require('../../lib/email');
const { HttpError, bad, v, id, wrap } = require('../../lib/http');
const { staff, adminOnly } = require('./_shared');

const r = express.Router();
const BASE_URL = () => (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const KIND_LABEL = { resume_rewrite: 'resume rewrite', linkedin_rewrite: 'LinkedIn rewrite', coaching_package: 'coaching package' };

// ── Playbook versions (admin only; proprietary) ──────────────────────
r.get('/playbooks', adminOnly, wrap(async (_req, res) => {
  res.json(await db.all(`select p.*, (select max(v.id) from anvaya.document_versions v where v.document_id = p.document_id and v.status = 'ready') as file_version_id,
    (select count(*) from anvaya.service_cases c where c.playbook_version_id = p.id) as case_count from anvaya.playbook_versions p order by p.id desc`));
}));
r.post('/playbooks', adminOnly, wrap(async (req, res) => {
  const label = v.str(req.body?.version_label, { max: 40, required: true, label: 'Version' });
  if (await db.one('select 1 from anvaya.playbook_versions where version_label = $1', [label])) throw new HttpError(409, 'That version label already exists. Versions are immutable — use a new label.');
  const row = await db.one(`insert into anvaya.playbook_versions (version_label, rubric_text, notes, document_id, created_by) values ($1,$2,$3,$4,$5) returning id`,
    [label, v.str(req.body?.rubric_text, { max: 50000, required: true, label: 'Rubric' }), v.str(req.body?.notes, { max: 2000 }), v.id(req.body?.document_id, 'Document'), req.auth.user.id]);
  res.status(201).json({ id: row.id });
}));
r.post('/playbooks/:id/activate', adminOnly, wrap(async (req, res) => {
  await db.tx(async (t) => {
    await t.run('update anvaya.playbook_versions set is_active = false where is_active');
    const x = await t.run('update anvaya.playbook_versions set is_active = true where id = $1', [id(req)]);
    if (!x.rowCount) throw new HttpError(404, 'Not found.');
  });
  res.json({ ok: true });
}));

// ── Cases (admin + ops overview) ─────────────────────────────────────
r.get('/cases', staff, wrap(async (_req, res) => {
  res.json(await db.all(`select c.id, c.kind, c.status, c.due_at, c.delivered_at, c.revisions_used, c.revisions_allowed, c.created_at,
    s.name as student_name, m.name as coach_name, p.name as product_name, pb.version_label as playbook_version,
    (select verdict from anvaya.qa_reviews q where q.case_id = c.id order by q.id desc limit 1) as last_qa
    from anvaya.service_cases c join anvaya.students s on s.id = c.student_id left join anvaya.mentors m on m.id = c.coach_mentor_id
    left join anvaya.products p on p.id = c.product_id left join anvaya.playbook_versions pb on pb.id = c.playbook_version_id
    order by case c.status when 'qa' then 0 when 'revision' then 1 when 'intake' then 2 when 'delivered' then 8 when 'closed' then 9 else 5 end, c.due_at nulls last`));
}));
r.post('/cases', adminOnly, wrap(async (req, res) => {
  const sid = v.id(req.body?.student_id, 'Student', { required: true });
  if (!await db.one('select 1 from anvaya.students where id = $1', [sid])) throw bad('Student not found.');
  const row = await db.one(`insert into anvaya.service_cases (student_id, kind, product_id, due_at, revisions_allowed, playbook_version_id)
    values ($1,$2,$3,$4,$5,(select id from anvaya.playbook_versions where is_active)) returning id`,
  [sid, v.oneOf(req.body?.kind || 'resume_rewrite', ['resume_rewrite', 'linkedin_rewrite', 'coaching_package'], 'Type'), v.id(req.body?.product_id, 'Product'),
    v.date(req.body?.due_at), v.int(req.body?.revisions_allowed, { min: 0, max: 10 }) ?? 1]);
  await db.run("insert into anvaya.case_events (case_id, user_id, to_status, note) values ($1,$2,'intake','Case opened manually')", [row.id, req.auth.user.id]);
  res.status(201).json({ id: row.id });
}));
r.post('/cases/:id/assign', staff, wrap(async (req, res) => {
  const cid = id(req);
  const c = await db.one('select * from anvaya.service_cases where id = $1', [cid]);
  if (!c) throw new HttpError(404, 'Case not found.');
  const coach = v.id(req.body?.coach_mentor_id, 'Coach', { required: true });
  if (!await db.one("select 1 from anvaya.mentors where id = $1 and status = 'active'", [coach])) throw bad('Coach must be an active mentor.');
  const fee = req.auth.user.role === 'admin' && req.body?.coach_fee_paise !== undefined ? v.paise(req.body.coach_fee_paise, { label: 'Coach fee' }) : null;
  await db.tx(async (t) => {
    await t.run(`update anvaya.service_cases set coach_mentor_id = $2, status = case when status = 'intake' then 'assigned' else status end,
      coach_fee_paise = coalesce($3, coach_fee_paise), due_at = coalesce($4, due_at), updated_at = now() where id = $1`, [cid, coach, fee, v.date(req.body?.due_at)]);
    await t.run("insert into anvaya.case_events (case_id, user_id, from_status, to_status, note) values ($1,$2,$3,$4,'Coach assigned')",
      [cid, req.auth.user.id, c.status, c.status === 'intake' ? 'assigned' : c.status]);
  });
  res.json({ ok: true });
}));
/** QA review (admin, or the user set as the case's QA reviewer). */
r.post('/cases/:id/qa', staff, wrap(async (req, res) => {
  const c = await db.one('select * from anvaya.service_cases where id = $1', [id(req)]);
  if (!c) throw new HttpError(404, 'Case not found.');
  if (req.auth.user.role !== 'admin' && c.qa_user_id !== req.auth.user.id) throw new HttpError(403, 'Only an admin or the assigned QA reviewer can review.');
  if (c.status !== 'qa') throw bad('This case isn’t waiting for QA.');
  const verId = v.id(req.body?.document_version_id, 'Version', { required: true });
  const ver = await db.one(`select v.id from anvaya.document_versions v join anvaya.documents d on d.id = v.document_id
    where v.id = $1 and d.case_id = $2 and d.kind in ('coach_draft','linkedin','final') and v.status = 'ready'`, [verId, c.id]);
  if (!ver) throw bad('Pick a coach-edited version from this case to review.');
  const verdict = v.oneOf(req.body?.verdict, ['pass', 'changes_requested'], 'Verdict');
  const checklist = typeof req.body?.checklist === 'object' && req.body.checklist ? req.body.checklist : {};
  if (verdict === 'pass' && !checklist.no_invented_facts) throw bad('Confirm “no invented facts or numbers” before passing QA.');
  await db.tx(async (t) => {
    await t.run('insert into anvaya.qa_reviews (case_id, document_version_id, reviewer_user_id, checklist, verdict, comments) values ($1,$2,$3,$4,$5,$6)',
      [c.id, verId, req.auth.user.id, JSON.stringify(checklist), verdict, v.str(req.body?.comments, { max: 5000 })]);
    if (verdict === 'changes_requested') {
      await t.run("update anvaya.service_cases set status = 'coach_edit', updated_at = now() where id = $1", [c.id]);
      await t.run("insert into anvaya.case_events (case_id, user_id, from_status, to_status, note) values ($1,$2,'qa','coach_edit','QA requested changes')", [c.id, req.auth.user.id]);
    }
  });
  res.json({ ok: true });
}));
/** Human approval → delivery. Only the exact version that passed QA can be delivered. */
r.post('/cases/:id/deliver', adminOnly, wrap(async (req, res) => {
  const c = await db.one('select c.*, s.email from anvaya.service_cases c join anvaya.students s on s.id = c.student_id where c.id = $1', [id(req)]);
  if (!c) throw new HttpError(404, 'Case not found.');
  if (c.status !== 'qa') throw bad('Only a case that has been through QA can be delivered.');
  const qa = await db.one("select * from anvaya.qa_reviews where case_id = $1 order by id desc limit 1", [c.id]);
  if (!qa || qa.verdict !== 'pass') throw bad('The latest QA review must pass before delivery.');
  const src = await db.one('select v.*, d.title from anvaya.document_versions v join anvaya.documents d on d.id = v.document_id where v.id = $1', [qa.document_version_id]);
  await db.tx(async (t) => {
    const title = `${KIND_LABEL[c.kind] ? KIND_LABEL[c.kind][0].toUpperCase() + KIND_LABEL[c.kind].slice(1) : 'Document'} — final${c.revisions_used ? ` (revision ${c.revisions_used})` : ''}`;
    const doc = await t.one(`insert into anvaya.documents (student_id, case_id, kind, title, visible_to_student, created_by) values ($1,$2,'final',$3,true,$4) returning id`,
      [c.student_id, c.id, title, req.auth.user.id]);
    await t.run(`insert into anvaya.document_versions (document_id, version, storage_path, mime_type, size_bytes, body_text, created_by)
      values ($1,1,$2,$3,$4,$5,$6)`, [doc.id, src.storage_path, src.mime_type, src.size_bytes, src.body_text, req.auth.user.id]);
    await t.run("update anvaya.service_cases set status = 'delivered', delivered_at = now(), approved_by = $2, approved_at = now(), updated_at = now() where id = $1", [c.id, req.auth.user.id]);
    await t.run("insert into anvaya.case_events (case_id, user_id, from_status, to_status, note) values ($1,$2,'qa','delivered',$3)", [c.id, req.auth.user.id, `Approved and delivered (QA review #${qa.id}, version #${src.id})`]);
    await ledger.recordServiceFee(t, c, req.auth.user.id);
  });
  if (c.email) await sendEmail(c.email, 'case_delivered', { serviceName: KIND_LABEL[c.kind] || 'document', dashboardUrl: `${BASE_URL()}/student#services` }, { dedupeKey: `delivered:${c.id}:${c.revisions_used}` });
  res.json({ ok: true });
}));
r.post('/cases/:id/close', adminOnly, wrap(async (req, res) => {
  await db.run("update anvaya.service_cases set status = 'closed', updated_at = now() where id = $1 and status in ('delivered','cancelled')", [id(req)]);
  res.json({ ok: true });
}));

module.exports = r;
