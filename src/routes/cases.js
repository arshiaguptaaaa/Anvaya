'use strict';
// Case workspace shared by admins and the assigned coach (a mentor). Ops can see status but not drafts.
const express = require('express');
const db = require('../db');
const ai = require('../lib/ai');
const { HttpError, bad, v, id, wrap } = require('../lib/http');

const r = express.Router();

/** Loads the case if the caller may work on it; returns { c, canEdit }. */
async function access(req) {
  if (!req.auth) throw new HttpError(401, 'Please sign in.');
  const c = await db.one('select * from anvaya.service_cases where id = $1', [id(req)]);
  const role = req.auth.user.role;
  if (c && role === 'admin') return { c, canEdit: true, full: true };
  if (c && role === 'mentor' && req.auth.mentor?.status === 'active' && c.coach_mentor_id === req.auth.mentor.id) return { c, canEdit: true, full: true };
  if (c && role === 'ops') return { c, canEdit: false, full: false };
  throw new HttpError(404, 'Case not found.');
}

r.get('/cases/:id', wrap(async (req, res) => {
  const { c, canEdit, full } = await access(req);
  const s = await db.one('select id, name, email, target_role, stage, goals, linkedin from anvaya.students where id = $1', [c.student_id]);
  const out = {
    case: { ...c, coach_fee_paise: req.auth.user.role === 'admin' ? c.coach_fee_paise : undefined }, student: s, can_edit: canEdit,
    events: await db.all(`select e.*, coalesce(nullif(u.name,''), u.email) as user_name from anvaya.case_events e left join anvaya.users u on u.id = e.user_id where e.case_id = $1 order by e.id desc`, [c.id]),
    playbook: c.playbook_version_id ? await db.one('select id, version_label from anvaya.playbook_versions where id = $1', [c.playbook_version_id]) : null,
    qa: await db.all('select q.*, coalesce(nullif(u.name,\'\'), u.email) as reviewer from anvaya.qa_reviews q left join anvaya.users u on u.id = q.reviewer_user_id where q.case_id = $1 order by q.id desc', [c.id]),
  };
  if (full) {
    out.documents = await db.all(`select d.id, d.kind, d.title, d.visible_to_student, d.created_at, v.id as version_id, v.version, v.body_text, v.storage_path is not null as has_file, v.mime_type, v.created_at as version_at
      from anvaya.documents d join anvaya.document_versions v on v.document_id = d.id and v.status = 'ready' where d.case_id = $1 order by v.id desc`, [c.id]);
    out.student_resumes = await db.all(`select d.id, d.title, (select max(v.id) from anvaya.document_versions v where v.document_id = d.id and v.status = 'ready') as version_id
      from anvaya.documents d where d.student_id = $1 and d.kind = 'resume_upload' order by d.id desc`, [c.student_id]);
    out.ai_runs = await db.all('select id, purpose, status, model, output_text, error, created_at, output_document_version_id from anvaya.ai_runs where case_id = $1 order by id desc', [c.id]);
    out.ai_configured = ai.configured();
  } else {
    out.case.source_facts = undefined;
  }
  res.json(out);
}));

r.put('/cases/:id/source-facts', wrap(async (req, res) => {
  const { c, canEdit } = await access(req);
  if (!canEdit) throw new HttpError(403, 'Only the coach or an admin can edit this case.');
  await db.run('update anvaya.service_cases set source_facts = $1, updated_at = now() where id = $2', [v.str(req.body?.source_facts, { max: 20000, label: 'Source facts' }), c.id]);
  res.json({ ok: true });
}));

r.post('/cases/:id/ai', wrap(async (req, res) => {
  const { c, canEdit } = await access(req);
  if (!canEdit) throw new HttpError(403, 'Only the coach or an admin can run AI on this case.');
  if (['delivered', 'closed', 'cancelled'].includes(c.status)) throw bad('This case is closed for drafting.');
  const runId = await ai.requestRun(c.id, v.oneOf(req.body?.purpose || 'gap_questions', ['gap_questions', 'draft'], 'Purpose'), req.auth.user.id);
  const run = await db.one('select id, status, error from anvaya.ai_runs where id = $1', [runId]);
  res.status(202).json(run);
}));

/** Saves a coach-edited text version (the AI draft is never edited in place). */
r.post('/cases/:id/drafts', wrap(async (req, res) => {
  const { c, canEdit } = await access(req);
  if (!canEdit) throw new HttpError(403, 'Only the coach or an admin can edit drafts.');
  if (!['assigned', 'first_draft', 'coach_edit', 'revision'].includes(c.status)) throw bad('Drafts can’t be edited while the case is in QA or delivered.');
  const body = v.str(req.body?.body_text, { max: 50000, required: true, label: 'Draft' });
  const kind = c.kind === 'linkedin_rewrite' ? 'linkedin' : 'coach_draft';
  const verId = await db.tx(async (t) => {
    let doc = await t.one('select id from anvaya.documents where case_id = $1 and kind = $2 order by id limit 1', [c.id, kind]);
    if (!doc) doc = await t.one('insert into anvaya.documents (student_id, case_id, kind, title, created_by) values ($1,$2,$3,$4,$5) returning id', [c.student_id, c.id, kind, 'Coach edit', req.auth.user.id]);
    const n = (await t.one('select coalesce(max(version),0)+1 as n from anvaya.document_versions where document_id = $1', [doc.id])).n;
    const ver = await t.one(`insert into anvaya.document_versions (document_id, version, body_text, mime_type, created_by) values ($1,$2,$3,'text/plain',$4) returning id`, [doc.id, n, body, req.auth.user.id]);
    if (c.status !== 'coach_edit') {
      await t.run("update anvaya.service_cases set status = 'coach_edit', updated_at = now() where id = $1", [c.id]);
      await t.run("insert into anvaya.case_events (case_id, user_id, from_status, to_status, note) values ($1,$2,$3,'coach_edit',$4)", [c.id, req.auth.user.id, c.status, `Coach edit v${n} saved`]);
    }
    return ver.id;
  });
  res.status(201).json({ version_id: verId });
}));

r.post('/cases/:id/submit-qa', wrap(async (req, res) => {
  const { c, canEdit } = await access(req);
  if (!canEdit) throw new HttpError(403, 'Only the coach or an admin can submit for QA.');
  if (c.status !== 'coach_edit') throw bad('Save a coach edit before sending to QA.');
  const has = await db.one(`select 1 from anvaya.documents d join anvaya.document_versions v on v.document_id = d.id
    where d.case_id = $1 and d.kind in ('coach_draft','linkedin') and v.status = 'ready'`, [c.id]);
  if (!has) throw bad('There is no coach-edited version to review.');
  await db.tx(async (t) => {
    await t.run("update anvaya.service_cases set status = 'qa', updated_at = now() where id = $1", [c.id]);
    await t.run("insert into anvaya.case_events (case_id, user_id, from_status, to_status, note) values ($1,$2,'coach_edit','qa',$3)", [c.id, req.auth.user.id, v.str(req.body?.note, { max: 2000 }) || 'Sent for QA']);
  });
  res.json({ ok: true });
}));

module.exports = r;
