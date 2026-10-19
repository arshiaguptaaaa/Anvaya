'use strict';
// Document permissions. Every download goes through canAccess(); links are signed for 60 seconds.
const db = require('../db');

/** Students a mentor may see: assigned to them, booked with them, in their group, or in a case they coach. */
const MENTOR_STUDENTS = `(select s.id from anvaya.students s where s.mentor_id = $1
  union select b.student_id from anvaya.bookings b where b.mentor_id = $1 and b.status in ('requested','scheduled','completed','no_show')
  union select gm.student_id from anvaya.group_members gm join anvaya.mentor_groups g on g.id = gm.group_id where g.mentor_id = $1 and gm.left_at is null
  union select c.student_id from anvaya.service_cases c where c.coach_mentor_id = $1)`;

async function mentorCanSeeStudent(mentorId, studentId, q = db) {
  return !!(await q.one(`select 1 where $2::bigint in ${MENTOR_STUDENTS}`, [mentorId, studentId]));
}

async function canAccess(auth, doc) {
  if (!auth || !doc) return false;
  const role = auth.user.role;
  if (role === 'admin') return true;
  if (doc.kind === 'playbook') return false; // proprietary: admin + server-side AI only
  if (role === 'ops') return ['resume_upload', 'final'].includes(doc.kind);
  if (role === 'mentor') {
    const mid = auth.mentor?.id;
    if (doc.case_id) {
      const c = await db.one('select coach_mentor_id from anvaya.service_cases where id = $1', [doc.case_id]);
      if (c?.coach_mentor_id === mid) return true;
    }
    return !!doc.student_id && ['resume_upload', 'final', 'linkedin'].includes(doc.kind) && (await mentorCanSeeStudent(mid, doc.student_id));
  }
  if (role === 'student') {
    const sid = auth.student?.id;
    if (doc.kind === 'digital_product') {
      return !!(await db.one(`select 1 from anvaya.orders o join anvaya.products p on p.id = o.product_id
        where o.student_id = $1 and o.status = 'paid' and p.digital_document_id = $2`, [sid, doc.id]));
    }
    return doc.student_id === sid && (doc.kind === 'resume_upload' || doc.visible_to_student);
  }
  return false;
}

module.exports = { canAccess, mentorCanSeeStudent, MENTOR_STUDENTS };
