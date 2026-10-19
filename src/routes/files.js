'use strict';
// Private files: browser uploads straight to a signed storage URL; downloads use 60-second signed URLs.
const express = require('express');
const db = require('../db');
const storage = require('../lib/storage');
const docs = require('../lib/documents');
const { HttpError, bad, v, id, wrap } = require('../lib/http');

const r = express.Router();
const signedIn = (req, res, next) => (req.auth ? next() : res.status(401).json({ error: 'Please sign in.' }));
const KINDS = ['resume_upload', 'source_facts', 'ai_draft', 'coach_draft', 'final', 'linkedin', 'digital_product', 'playbook', 'other'];

/** Decides what the caller may upload, returning { studentId, caseId, kind, visible }. */
async function authorizeUpload(req) {
  const role = req.auth.user.role;
  const kind = v.oneOf(req.body?.kind || 'resume_upload', KINDS, 'Document type');
  let studentId = v.id(req.body?.student_id, 'Student');
  const caseId = v.id(req.body?.case_id, 'Case');
  let visible = v.bool(req.body?.visible_to_student);
  if (role === 'student') {
    if (kind !== 'resume_upload') throw new HttpError(403, 'Students can upload resumes only.');
    if (!req.auth.student) throw new HttpError(403, 'No student profile.');
    return { studentId: req.auth.student.id, caseId: null, kind, visible: true };
  }
  if (['playbook', 'digital_product'].includes(kind) && role !== 'admin') throw new HttpError(403, 'Only an admin can upload this.');
  if (caseId) {
    const c = await db.one('select student_id, coach_mentor_id from anvaya.service_cases where id = $1', [caseId]);
    if (!c) throw bad('Case not found.');
    if (role === 'mentor' && c.coach_mentor_id !== req.auth.mentor?.id) throw new HttpError(403, 'You are not the coach on this case.');
    studentId = c.student_id;
    if (role === 'mentor') visible = false; // only an admin approval delivers to the student
  } else if (role === 'mentor') {
    throw new HttpError(403, 'Mentors can upload documents to their assigned cases only.');
  } else if (role === 'ops') {
    if (kind !== 'resume_upload') throw new HttpError(403, 'Operations can upload student resumes only.');
  }
  if (!['playbook', 'digital_product'].includes(kind) && !studentId) throw bad('Choose a student.');
  return { studentId: ['playbook', 'digital_product'].includes(kind) ? null : studentId, caseId, kind, visible };
}

r.post('/files/upload-url', signedIn, wrap(async (req, res) => {
  const a = await authorizeUpload(req);
  const filename = v.str(req.body?.filename, { max: 200, required: true, label: 'File name' });
  const mime = v.str(req.body?.mime_type, { max: 120, required: true, label: 'File type' });
  const size = v.int(req.body?.size, { min: 1, max: storage.MAX_BYTES, label: 'File size', required: true });
  const prefix = a.kind === 'playbook' ? 'playbook' : a.kind === 'digital_product' ? 'products' : `students/${a.studentId}`;
  const up = await storage.createUpload({ prefix, filename, mimeType: mime, size });
  const out = await db.tx(async (t) => {
    let docId = v.id(req.body?.document_id, 'Document');
    if (docId) {
      const d = await t.one('select * from anvaya.documents where id = $1 for update', [docId]);
      if (!d || d.kind !== a.kind || (d.student_id ?? null) !== (a.studentId ?? null)) throw bad('That document can’t take a new version here.');
    } else {
      docId = (await t.one(`insert into anvaya.documents (student_id, case_id, kind, title, visible_to_student, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
        [a.studentId, a.caseId, a.kind, v.str(req.body?.title, { max: 200 }) || filename, a.visible, req.auth.user.id])).id;
    }
    const ver = (await t.one('select coalesce(max(version),0)+1 as n from anvaya.document_versions where document_id = $1', [docId])).n;
    const dv = await t.one(`insert into anvaya.document_versions (document_id, version, storage_path, mime_type, size_bytes, status, created_by)
      values ($1,$2,$3,$4,$5,'uploading',$6) returning id`, [docId, ver, up.path, mime, size, req.auth.user.id]);
    return { document_id: docId, version_id: dv.id, version: ver };
  });
  res.status(201).json({ ...out, upload_url: up.uploadUrl, method: up.method });
}));

r.post('/files/:id/complete', signedIn, wrap(async (req, res) => {
  const ver = await db.one(`select v.*, d.created_by as doc_creator from anvaya.document_versions v join anvaya.documents d on d.id = v.document_id where v.id = $1`, [id(req)]);
  if (!ver || ver.created_by !== req.auth.user.id) throw new HttpError(404, 'Upload not found.');
  if (ver.status === 'ready') return res.json({ ok: true });
  const st = await storage.stat(ver.storage_path);
  if (!st || !st.size) throw bad('The upload didn’t finish. Please try again.');
  await db.run("update anvaya.document_versions set status = 'ready', size_bytes = $2 where id = $1", [ver.id, st.size]);
  res.json({ ok: true, size: st.size });
}));

r.get('/files/:id/download', signedIn, wrap(async (req, res) => {
  const ver = await db.one(`select v.*, d.kind, d.student_id, d.case_id, d.visible_to_student, d.title from anvaya.document_versions v
    join anvaya.documents d on d.id = v.document_id where v.id = $1 and v.status = 'ready'`, [id(req)]);
  if (!ver || !(await docs.canAccess(req.auth, { ...ver, id: ver.document_id }))) throw new HttpError(404, 'File not found.');
  if (!ver.storage_path) {
    // Text drafts are returned inline (they live in the database, not storage).
    return res.json({ text: ver.body_text || '', title: ver.title });
  }
  const url = await storage.signedDownload(ver.storage_path, { ttl: 60, filename: ver.title });
  db.audit(req.auth.user.id, 'file_download', `version:${ver.id}`);
  res.json({ url, expires_in: 60 });
}));

module.exports = r;
