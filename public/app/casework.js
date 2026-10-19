// Case workspace for resume/LinkedIn services — used by admins (QA + approval) and the assigned coach.
// Coaches write drafts from the source facts; delivery always needs a passing QA and an admin approval.
(function () {
  const { api, esc, dt, toast, modal, onSubmit, statusPill, openFile } = A;

  A.openCase = async function openCase(caseId, { isAdmin = false, onChange } = {}) {
    let ui;
    const reload = async () => { if (ui) ui.close(); await A.openCase(caseId, { isAdmin, onChange }); onChange && onChange(); };
    const w = await api(`/api/cases/${caseId}`);
    const c = w.case;
    const docs = w.documents || [];
    const latestEdit = docs.find((x) => ['coach_draft', 'linkedin'].includes(x.kind));
    const editable = w.can_edit && ['assigned', 'first_draft', 'coach_edit', 'revision'].includes(c.status);
    const reviewable = docs.filter((x) => ['coach_draft', 'linkedin'].includes(x.kind));

    ui = modal(`<div class="eyebrow">${esc(A.label(c.kind))} · Case #${c.id}</div>
      <div class="row-between mb-2"><h2 class="h2">${esc(w.student.name)}</h2>${statusPill(c.status)}</div>
      <div class="kv-inline mb-3"><span>Target <strong>${esc(w.student.target_role || '—')}</strong></span><span>Playbook <strong>${esc(w.playbook?.version_label || 'none active')}</strong></span>
        <span>Due <strong>${esc(c.due_at ? dt(c.due_at) : '—')}</strong></span><span>Revisions <strong>${c.revisions_used}/${c.revisions_allowed}</strong></span></div>
      ${c.source_facts !== undefined ? `
      <div class="section-label">Source facts <span class="muted small">(the only facts the draft may use)</span></div>
      <form id="facts" novalidate><div class="form-error" hidden></div>
        <textarea class="input mb-1" name="source_facts" rows="6" ${w.can_edit ? '' : 'disabled'}>${esc(c.source_facts)}</textarea>
        ${(w.student_resumes || []).map((r) => r.version_id ? `<button type="button" class="link-btn mr" data-open="${r.version_id}">Open uploaded resume: ${esc(r.title)}</button>` : '').join(' ')}
        ${w.can_edit ? '<div class="row mt-1"><button class="btn btn-ghost btn-sm" type="submit">Save facts</button></div>' : ''}</form>
      <div class="section-label mt-2">Coach edit</div>
      ${editable ? `<form id="draft" novalidate><div class="form-error" hidden></div>
        <textarea class="input mb-1" name="body_text" rows="12" placeholder="Write or paste the edited draft">${esc(latestEdit?.body_text || '')}</textarea>
        <div class="row"><button class="btn btn-ghost btn-sm" type="submit">Save new version</button>
        ${c.status === 'coach_edit' ? '<button class="btn btn-primary btn-sm" type="button" data-qa-submit>Send to QA</button>' : ''}</div></form>`
        : `${latestEdit ? `<button class="link-btn" data-open="${latestEdit.version_id}">View latest coach edit (v${latestEdit.version})</button>` : '<p class="muted small">No coach edit yet.</p>'}`}
      ${isAdmin && c.status === 'qa' ? `<div class="section-label mt-3">QA review</div>
        <form id="qa" novalidate><div class="form-error" hidden></div>
        <div class="field"><label class="label">Version reviewed</label><select class="input" name="document_version_id">${reviewable.map((x) => `<option value="${x.version_id}">${esc(x.title)} v${x.version} — ${esc(dt(x.version_at))}</option>`).join('')}</select></div>
        <div class="field"><label class="check"><input type="checkbox" name="no_invented_facts"> <span>No invented achievements, numbers or experience (checked against source facts)</span></label></div>
        <div class="field"><label class="check"><input type="checkbox" name="rubric_applied"> <span>Playbook rubric applied</span></label></div>
        <div class="field"><label class="check"><input type="checkbox" name="placeholders_resolved"> <span>All [ADD METRIC] placeholders resolved or removed</span></label></div>
        <div class="field"><label class="check"><input type="checkbox" name="formatting"> <span>Formatting, length and ATS-safety checked</span></label></div>
        <div class="field"><label class="label">Comments</label><textarea class="input" name="comments" rows="3"></textarea></div>
        <div class="row"><button class="btn btn-danger btn-sm" type="submit" name="verdict" value="changes_requested">Request changes</button>
        <button class="btn btn-primary btn-sm" type="submit" name="verdict" value="pass">Pass QA</button></div></form>
        ${w.qa[0]?.verdict === 'pass' ? '<div class="row mt-2"><button class="btn btn-primary" data-deliver>Approve &amp; deliver to student</button></div>' : ''}` : ''}` : '<p class="muted">You can see this case’s status only.</p>'}
      <div class="section-label mt-3">History</div>
      <ul class="list small">${w.events.map((e) => `<li><span>${esc(e.note || `${e.from_status || ''} → ${e.to_status || ''}`)}<span class="sub-line">${esc(e.user_name || 'System')}</span></span><span class="when">${esc(dt(e.created_at))}</span></li>`).join('')}</ul>
      ${w.qa.length ? `<div class="section-label mt-2">QA reviews</div>${w.qa.map((q) => `<div class="note-box mb-1"><div class="row-between">${statusPill(q.verdict)}<span class="small muted">${esc(q.reviewer || '')} · ${esc(dt(q.created_at))}</span></div>${q.comments ? `<p class="small mt-1">${esc(q.comments)}</p>` : ''}</div>`).join('')}` : ''}`, { wide: true });

    ui.el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openFile(b.dataset.open)));
    const facts = ui.el.querySelector('#facts');
    if (facts && w.can_edit) onSubmit(facts, async (d) => { await api(`/api/cases/${c.id}/source-facts`, { method: 'PUT', body: d }); toast('Source facts saved'); });
    const draft = ui.el.querySelector('#draft');
    if (draft) onSubmit(draft, async (d) => { await api(`/api/cases/${c.id}/drafts`, { method: 'POST', body: d }); toast('New version saved'); reload(); });
    ui.el.querySelector('[data-qa-submit]')?.addEventListener('click', async () => {
      try { await api(`/api/cases/${c.id}/submit-qa`, { method: 'POST', body: {} }); toast('Sent to QA'); reload(); } catch (e) { toast(e.message, true); }
    });
    const qa = ui.el.querySelector('#qa');
    if (qa) onSubmit(qa, async (_d, btn) => {
      const checklist = {}; ['no_invented_facts', 'rubric_applied', 'placeholders_resolved', 'formatting'].forEach((k) => { checklist[k] = qa.elements.namedItem(k).checked; });
      await api(`/api/admin/cases/${c.id}/qa`, { method: 'POST', body: { document_version_id: qa.document_version_id.value, verdict: btn.value, checklist, comments: qa.comments.value } });
      toast(btn.value === 'pass' ? 'QA passed' : 'Changes requested'); reload();
    });
    ui.el.querySelector('[data-deliver]')?.addEventListener('click', async () => {
      if (!await A.confirmBox('Deliver to the student?', 'The QA-passed version becomes visible in their dashboard and they get an email.', { ok: 'Approve & deliver' })) return;
      try { await api(`/api/admin/cases/${c.id}/deliver`, { method: 'POST', body: {} }); toast('Delivered'); reload(); } catch (e) { toast(e.message, true); }
    });
  };
})();
