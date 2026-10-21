// Operations workspace screens for the admin console: Today, queues, Leads and Students tables (server-side
// filters, saved views, pagination, bulk assignment) and the unified student record. Real data only.
(function () {
  const { api, esc, dt, d, label, toast, confirmBox, onSubmit, statusPill, formModal, pageHead, inr } = A;

  const QUEUE_LABELS = {
    my_tasks: 'My tasks', unassigned: 'Unassigned', followups_due: 'Follow-ups due', awaiting_staff: 'Awaiting Anvaya', awaiting_student: 'Awaiting student',
    awaiting_mentor: 'Awaiting mentor', payment_exceptions: 'Payment exceptions', renewals: 'Renewals (14 days)',
    incomplete_onboarding: 'Incomplete onboarding', missed_sessions: 'Missed sessions', failed_jobs: 'Failed jobs',
  };
  const ALERT = ['followups_due', 'payment_exceptions', 'failed_jobs', 'missed_sessions'];
  const overdue = (iso) => iso && new Date(iso) < new Date();
  const due = (iso) => (iso ? `<span class="${overdue(iso) ? 'due' : 'muted'}">${esc(dt(iso))}</span>` : '<span class="muted">No date</span>');
  let staffCache = null;
  const staffUsers = async () => (staffCache ||= await api('/api/admin/staff-users'));
  const ownerOptions = async (blank = 'Unassigned') => [['', blank], ['me', 'Me'], ...(await staffUsers()).map((u) => [u.id, `${u.name} (${u.role})`])];
  const itemHref = (x) => (x.type === 'lead' ? `lead:${x.lead_id || x.id}` : x.type === 'job' ? '#system' : x.student_id ? `#student-${x.student_id}` : x.lead_id ? `lead:${x.lead_id}` : '#today');

  function bindItems(root, ctx) {
    root.addEventListener('click', (e) => {
      const a = e.target.closest('[data-go]'); if (!a) return;
      e.preventDefault();
      const go = a.dataset.go;
      if (go.startsWith('lead:')) ctx.leadDetail(Number(go.slice(5)));
      else location.hash = go.slice(1);
    });
  }
  const itemRow = (x) => `<li><a href="#" class="q-item" data-go="${esc(itemHref(x))}"><span><strong class="ivory">${esc(x.title)}</strong>
    <span class="sub-line">${esc(label(x.type))}${x.subtitle ? ` · ${esc(x.subtitle)}` : ''}</span></span><span class="when">${x.due_at ? due(x.due_at) : ''}</span></a></li>`;

  // ══ Today ══════════════════════════════════════════════════════════
  async function today(ctx) {
    const [q, t] = await Promise.all([api('/api/admin/queues'), api('/api/admin/today')]);
    ctx.main.innerHTML = pageHead('Workspace', 'Today', 'Your tasks, today’s sessions and the queues that need attention. Counts come from live records.')
      + `<div class="q-grid reveal mb-3">${Object.entries(QUEUE_LABELS).map(([k, l]) => `<a class="card q-card${q[k] && ALERT.includes(k) ? ' alert' : ''}" href="#queue-${k}">
        <span class="q-n">${q[k] ?? 0}${q[k] >= 200 ? '+' : ''}</span><span class="q-l">${esc(l)}</span></a>`).join('')}</div>
      <div class="grid-2 reveal"><div class="card"><div class="card-head"><h2 class="h2">My tasks <em>due</em></h2><button class="btn btn-ghost btn-sm" data-newtask>+ Task</button></div>
        <ul class="list small" id="t-tasks">${t.tasks.map((x) => `<li><label class="task"><input type="checkbox" data-done="${x.id}" aria-label="Mark done">
          <span><strong class="ivory">${esc(x.title)}</strong><span class="sub-line">${esc(x.subject_name || '')}${x.owner_user_id ? '' : ' · unassigned'}</span></span></label>
          <span class="when">${due(x.due_at)}${x.student_id ? ` <a href="#student-${x.student_id}" class="link-btn">Open</a>` : ''}</span></li>`).join('') || '<li class="muted">Nothing due. New tasks appear here when they’re assigned to you or unassigned.</li>'}</ul></div>
      <div class="card"><div class="card-head"><h2 class="h2">Sessions <em>today</em></h2><a class="link-btn" href="#calendar">Calendar</a></div>
        <ul class="list small">${t.sessions.map((s) => `<li><span><strong class="ivory">${esc(s.title)}</strong><span class="sub-line">${esc(s.student_name || '')}${s.mentor_name ? ` · ${esc(s.mentor_name)}` : ''} · ${esc(label(s.kind))}</span></span>
          <span class="when">${esc(A.time(s.starts_at))} ${s.student_id ? `<a class="link-btn" href="#student-${s.student_id}">Open</a>` : ''}</span></li>`).join('') || '<li class="muted">No sessions for the rest of today.</li>'}</ul>
        <p class="small muted pad">${t.leads_new_7d} new lead${t.leads_new_7d === 1 ? '' : 's'} in the last 7 days.</p></div></div>`;
    ctx.main.querySelectorAll('[data-done]').forEach((c) => c.addEventListener('change', async () => {
      try { await api(`/api/admin/tasks/${c.dataset.done}`, { method: 'PATCH', body: { status: 'done' } }); toast('Task done'); ctx.refresh(); } catch (e) { toast(e.message, true); c.checked = false; }
    }));
    ctx.main.querySelector('[data-newtask]').addEventListener('click', () => newTask(ctx));
  }

  async function newTask(ctx, { studentId = null, leadId = null } = {}) {
    const fields = [{ name: 'title', label: 'Task', required: true, span2: true }, { name: 'owner_user_id', label: 'Owner', type: 'select', options: await ownerOptions() },
      { name: 'due_at', label: 'Due', type: 'datetime' }];
    if (!studentId && !leadId) fields.unshift({ name: 'student_id', label: 'Student', type: 'select', options: [['', 'Choose…'], ...(await api('/api/admin/students-table?page_size=100')).rows.map((s) => [s.id, s.name])], required: true });
    await formModal({ eyebrow: 'New task', title: 'Add a <em>task</em>', fields, values: { owner_user_id: 'me' },
      onSave: (b) => api('/api/admin/tasks', { method: 'POST', body: { ...b, student_id: studentId || b.student_id || undefined, lead_id: leadId || undefined } }) });
    toast('Task added'); ctx.refresh();
  }

  // ══ Queue ══════════════════════════════════════════════════════════
  async function queue(ctx, name) {
    const items = await api(`/api/admin/queues/${encodeURIComponent(name)}`);
    ctx.main.innerHTML = pageHead('Queue', esc(QUEUE_LABELS[name] || label(name)), `${items.length}${items.length >= 200 ? '+' : ''} item${items.length === 1 ? '' : 's'}. Open one to work on it.`, '<a class="btn btn-ghost" href="#today">← Today</a>')
      + `<div class="card reveal"><ul class="list small">${items.map(itemRow).join('') || '<li class="muted">This queue is empty.</li>'}</ul></div>`;
    bindItems(ctx.main, ctx);
  }

  // ══ Server-side tables (Leads, Students) ═══════════════════════════
  async function table(ctx, scope) {
    const isLeads = scope === 'leads';
    const state = { q: '', status: '', owner: '', due: '', source: '', plan: '', page: 1, page_size: 25 };
    try { Object.assign(state, JSON.parse(sessionStorage.getItem(`anvaya.${scope}.filters`) || '{}'), { page: 1 }); } catch { /* storage off */ }
    const owners = await ownerOptions('Any owner');
    const statusOpts = isLeads ? [['', 'Any stage'], ['new', 'New'], ['contacted', 'Contacted'], ['qualified', 'Qualified'], ['converted', 'Converted'], ['lost', 'Lost']]
      : [['', 'Any status'], ['active', 'Active'], ['paused', 'Paused'], ['completed', 'Completed']];
    const sel = (name, opts) => `<select class="input" data-f="${name}" aria-label="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
    ctx.main.innerHTML = pageHead('CRM', isLeads ? 'Leads' : 'Students', isLeads ? 'Pipeline with owner, source, stage, next action and due date.' : 'Every student with owner, plan, next action and follow-up.',
      `<button class="btn btn-primary" data-new>+ Add ${isLeads ? 'lead' : 'student'}</button>`)
      + `<div class="card reveal"><div class="toolbar">
        <input class="input" type="search" data-f="q" placeholder="Search name, phone, email${isLeads ? '' : ', college'}…" aria-label="Search">
        ${sel('status', statusOpts)}${sel('owner', [['', 'Any owner'], ['me', 'Mine'], ['none', 'Unassigned'], ...owners.slice(2)])}
        ${sel('due', [['', 'Any follow-up'], ['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Due this week'], ['none', 'No follow-up set']])}
        ${isLeads ? '<input class="input" data-f="source" placeholder="Source" aria-label="Source">' : sel('plan', [['', 'Any plan'], ['active', 'Active plan'], ['none', 'No active plan']])}
        <select class="input" data-view aria-label="Saved views"><option value="">Saved views…</option></select>
        <button class="btn btn-ghost btn-sm" data-saveview>Save view</button></div>
        <div class="toolbar bulk" hidden><span class="small"><strong data-selcount>0</strong> selected</span>${sel('bulkowner', [['', 'Assign to…'], ...owners.slice(1).filter(([v]) => v !== ''), ['none', 'Unassigned']])}
          <button class="btn btn-primary btn-sm" data-bulk>Assign</button></div>
        <div class="table-wrap"><table><thead><tr><th><input type="checkbox" data-all aria-label="Select all on page"></th><th>${isLeads ? 'Lead' : 'Student'}</th>
          <th>${isLeads ? 'Source / stage' : 'Track / plan'}</th><th>Next action</th><th>Owner</th><th></th></tr></thead><tbody></tbody></table></div>
        <div class="toolbar pager"><span class="small muted" data-total></span><span class="row"><button class="btn btn-ghost btn-sm" data-prev>← Prev</button><button class="btn btn-ghost btn-sm" data-next>Next →</button></span></div></div>`;
    const root = ctx.main;
    const tbody = root.querySelector('tbody');
    const selected = new Set();
    for (const el of root.querySelectorAll('[data-f]')) if (state[el.dataset.f] != null) el.value = state[el.dataset.f];
    const loadViews = async () => {
      const vs = await api(`/api/admin/views?scope=${scope}`);
      const s = root.querySelector('[data-view]');
      s.innerHTML = `<option value="">Saved views…</option>${vs.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}`;
      s.onchange = () => { const v = vs.find((x) => String(x.id) === s.value); if (!v) return; Object.assign(state, { q: '', status: '', owner: '', due: '', source: '', plan: '' }, v.query, { page: 1 });
        for (const el of root.querySelectorAll('[data-f]')) if (state[el.dataset.f] != null) el.value = state[el.dataset.f]; draw(); };
    };
    async function draw() {
      try { sessionStorage.setItem(`anvaya.${scope}.filters`, JSON.stringify({ ...state, page: 1 })); } catch { /* storage off */ }
      const qs = new URLSearchParams(Object.entries(state).filter(([, v]) => v !== '' && v != null)).toString();
      const r = await api(`/api/admin/${scope}-table?${qs}`);
      selected.clear(); syncBulk();
      tbody.innerHTML = r.rows.map((x) => `<tr data-id="${x.id}"><td><input type="checkbox" data-sel="${x.id}" aria-label="Select ${esc(x.name)}"></td>
        <td class="strong"><a href="#" data-open="${x.id}">${esc(x.name)}</a><span class="sub-line">${esc(x.phone || x.email || '—')}${isLeads ? '' : x.college_name ? ` · ${esc(x.college_name)}` : ''}</span></td>
        <td>${isLeads ? `${esc(x.source || '—')}<span class="sub-line">${statusPill(x.status)}</span>` : `${esc(x.track_name || '—')}<span class="sub-line">${x.plan_name ? `${esc(x.plan_name)} · until ${esc(d(x.plan_until))}` : 'No active plan'}</span>`}</td>
        <td>${esc(x.next_action || '—')}<span class="sub-line">${due(x.follow_up_at)}${Number(x.open_tasks) ? ` · ${x.open_tasks} open task${x.open_tasks == 1 ? '' : 's'}` : ''}</span></td>
        <td>${esc(x.owner_name || '—')}</td><td class="actions"><button class="btn btn-ghost btn-sm" data-follow="${x.id}">Follow-up</button></td></tr>`).join('')
        || `<tr><td colspan="6"><div class="empty">No ${scope} match these filters.</div></td></tr>`;
      const from = r.total ? (r.page - 1) * r.page_size + 1 : 0;
      root.querySelector('[data-total]').textContent = `${from}–${Math.min(r.total, r.page * r.page_size)} of ${r.total}`;
      root.querySelector('[data-prev]').disabled = r.page <= 1;
      root.querySelector('[data-next]').disabled = r.page * r.page_size >= r.total;
      root.querySelector('[data-all]').checked = false;
    }
    const syncBulk = () => { root.querySelector('.bulk').hidden = !selected.size; root.querySelector('[data-selcount]').textContent = selected.size; };
    let timer;
    root.querySelectorAll('[data-f]').forEach((el) => el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => {
      clearTimeout(timer); timer = setTimeout(() => { state[el.dataset.f] = el.value; state.page = 1; draw().catch((e) => toast(e.message, true)); }, el.tagName === 'INPUT' ? 300 : 0);
    }));
    root.querySelector('[data-prev]').addEventListener('click', () => { state.page -= 1; draw(); });
    root.querySelector('[data-next]').addEventListener('click', () => { state.page += 1; draw(); });
    root.querySelector('[data-all]').addEventListener('change', (e) => { root.querySelectorAll('[data-sel]').forEach((c) => { c.checked = e.target.checked; c.checked ? selected.add(Number(c.dataset.sel)) : selected.delete(Number(c.dataset.sel)); }); syncBulk(); });
    tbody.addEventListener('change', (e) => { const c = e.target.closest('[data-sel]'); if (!c) return; c.checked ? selected.add(Number(c.dataset.sel)) : selected.delete(Number(c.dataset.sel)); syncBulk(); });
    root.querySelector('[data-bulk]').addEventListener('click', async () => {
      const owner = root.querySelector('[data-f="bulkowner"]').value;
      if (!owner) return toast('Choose who to assign them to.', true);
      if (!await confirmBox('Assign owner', `Assign ${selected.size} ${scope} to ${owner === 'none' ? 'nobody (unassign)' : root.querySelector('[data-f="bulkowner"]').selectedOptions[0].textContent}?`, { ok: 'Assign' })) return;
      const r = await api('/api/admin/bulk-assign', { method: 'POST', body: { scope, ids: [...selected], owner_user_id: owner === 'none' ? null : owner } });
      toast(`${r.updated} updated`); draw();
    });
    root.querySelector('[data-saveview]').addEventListener('click', async () => {
      await formModal({ eyebrow: 'Saved view', title: 'Save these <em>filters</em>', fields: [{ name: 'name', label: 'View name', required: true }],
        onSave: (b) => api('/api/admin/views', { method: 'POST', body: { scope, name: b.name, query: { q: state.q, status: state.status, owner: state.owner, due: state.due, source: state.source, plan: state.plan } } }) });
      toast('View saved'); loadViews();
    });
    tbody.addEventListener('click', async (e) => {
      const o = e.target.closest('[data-open]');
      if (o) { e.preventDefault(); if (isLeads) ctx.leadDetail(Number(o.dataset.open)); else location.hash = `student-${o.dataset.open}`; return; }
      const f = e.target.closest('[data-follow]');
      if (f) { await followUp(ctx, scope, Number(f.dataset.follow)); draw(); }
    });
    root.querySelector('[data-new]').addEventListener('click', async () => {
      if (isLeads) { await formModal({ eyebrow: 'New lead', title: 'Add a <em>lead</em>', fields: await ctx.leadFields(), values: { status: 'new', source: 'Manual' }, onSave: (b) => api('/api/admin/leads', { method: 'POST', body: b }) }); toast('Lead added'); draw(); }
      else { const r = await formModal({ eyebrow: 'New student', title: 'Add a <em>student</em>', fields: await ctx.studentFields(), values: { status: 'active' }, onSave: (b) => api('/api/admin/students', { method: 'POST', body: b }) }); toast('Student added'); location.hash = `student-${r.id}`; }
    });
    await Promise.all([draw(), loadViews()]);
  }

  async function followUp(ctx, scope, rowId, current = {}) {
    await formModal({ eyebrow: 'Follow-up', title: 'Owner &amp; <em>next action</em>', values: { ...current },
      fields: [{ name: 'owner_user_id', label: 'Owner', type: 'select', options: await ownerOptions() }, { name: 'follow_up_at', label: 'Follow up on', type: 'datetime' },
        { name: 'next_action', label: 'Next action', span2: true }],
      onSave: (b) => api(`/api/admin/followup/${scope}/${rowId}`, { method: 'PATCH', body: { owner_user_id: b.owner_user_id || null, next_action: b.next_action || '', follow_up_at: b.follow_up_at || null } }) });
    toast('Follow-up saved');
  }

  // ══ Unified student record ═════════════════════════════════════════
  const EMAIL = {
    delivered: '<span class="pill ok">Email delivered</span>', queued: '<span class="pill">Email queued · retrying</span>', failed: '<span class="pill bad">Email failed</span>',
    not_requested: '<span class="pill off">Dashboard only · not emailed</span>',
  };
  async function workspace(ctx, sid) {
    const w = await api(`/api/admin/students/${sid}/workspace`);
    const s = w.student, sub = w.subscription;
    const cases = w.cases;
    const ents = sub ? sub.entitlements.filter((e) => e.limit_count != null) : [];
    ctx.main.innerHTML = `<div class="ws-head reveal"><div><a class="link-btn" href="#students">← Students</a><h1 class="title">${esc(s.name)}</h1>
        <div class="row wrap">${statusPill(s.status)}${sub ? `<span class="pill ok">Plan ${esc(sub.effective_access)}</span>` : '<span class="pill off">No active plan</span>'}
          <span class="pill off">Owner: ${esc(s.owner_name || 'unassigned')}</span>${s.has_account ? '' : '<span class="pill bad">No portal account</span>'}</div></div>
        <div class="row wrap"><button class="btn btn-ghost btn-sm" data-followup>Owner &amp; follow-up</button><button class="btn btn-ghost btn-sm" data-edit>Edit profile</button>
          ${s.has_account ? '' : `<button class="btn btn-ghost btn-sm" data-invite>${s.account_email ? 'Resend invite' : 'Invite to portal'}</button>`}<button class="btn btn-ghost btn-sm" data-more>More details</button>
          <button class="btn btn-primary btn-sm" data-task>+ Task</button></div></div>
      <div class="ws reveal">
        <section class="ws-center card">
          <div class="composer"><div class="seg" role="tablist"><button class="on" data-kind="internal_note">Internal note</button><button data-kind="message">Message to student</button></div>
            <p class="small muted mt-1" data-hint>Internal notes are only visible to the Anvaya team, never to students or mentors.</p>
            <form novalidate><div class="form-error" hidden></div><textarea class="input" name="body" rows="3" required placeholder="Write an internal note…" aria-label="Text"></textarea>
              <div class="row wrap mt-1" data-msgopts hidden><label class="check small"><input type="checkbox" name="email" checked> <span>Also email it to ${esc(s.email || 'the student (no email on file)')}</span></label>
                <span class="small muted">WhatsApp isn’t connected; log WhatsApp chats as internal notes.</span></div>
              <div class="row wrap mt-1">${cases.length ? `<select class="input input-sm" name="support_case_id" aria-label="Support request"><option value="">Not about a support request</option>${cases.map((c) => `<option value="${c.id}">${esc(c.subject)} (${esc(label(c.status))})</option>`).join('')}</select>
                <select class="input input-sm" name="case_status" aria-label="Request status"><option value="">Keep request status</option><option value="awaiting_student">Awaiting student</option><option value="awaiting_mentor">Awaiting mentor</option><option value="awaiting_staff">Awaiting Anvaya</option><option value="resolved">Resolved</option></select>` : ''}
                <button class="btn btn-primary btn-sm" type="submit" data-submit>Save note</button></div></form></div>
          <ol class="timeline">${w.timeline.map((e) => `<li class="ev ${e.kind}"><div class="ev-meta"><strong>${esc(e.kind === 'system' ? 'System' : e.author_name || label(e.author_role))}</strong>
            ${e.kind === 'internal_note' ? '<span class="pill">Internal · team only</span>' : e.kind === 'message' ? `<span class="pill ok">Visible to student</span>${e.author_role === 'student' ? '' : EMAIL[e.email_status] || ''}` : ''}
            ${e.support_case_id ? `<span class="pill off">Request #${e.support_case_id}</span>` : ''}<span class="when">${esc(dt(e.created_at))}</span></div>
            <div class="ev-body">${esc(e.body)}${e.email_status === 'failed' && e.email_error ? `<span class="sub-line due">${esc(e.email_error)}</span>` : ''}</div></li>`).join('') || '<li class="muted small pad">No activity yet.</li>'}</ol>
        </section>
        <aside class="ws-side">
          <div class="card pad"><div class="section-label">Profile</div><dl class="kv">
            <dt>Email</dt><dd>${esc(s.email || '—')}</dd><dt>Phone</dt><dd>${esc(s.phone || '—')}</dd><dt>College</dt><dd>${esc(s.college_name || '—')}</dd>
            <dt>Target role</dt><dd>${esc(s.target_role || '—')}</dd><dt>Track</dt><dd>${esc(s.track_name || '—')}</dd><dt>Intake</dt><dd>${s.intake_completed_at ? esc(d(s.intake_completed_at)) : 'Not finished'}</dd></dl></div>
          <div class="card pad"><div class="section-label">Plan &amp; payments</div>
            ${sub ? `<p class="small"><strong class="ivory">${esc(sub.plan_name)}</strong> ${statusPill(sub.effective_access)}<span class="sub-line">Paid through ${esc(d(sub.paid_through))}</span></p>
              <dl class="kv">${ents.map((e) => `<dt>${esc(label(e.key))}</dt><dd>${Math.max(0, e.limit_count - (e.used || 0))} of ${e.limit_count} left</dd>`).join('')}</dl>
              <p class="small muted">Paid mentor sessions are separate and never use these.</p>` : '<p class="small muted">No active plan.</p>'}
            <ul class="list tight small">${w.payments.slice(0, 4).map((p) => `<li><span>${esc(p.description || 'Payment')}<span class="sub-line">${p.provider === 'razorpay' ? 'Verified by Razorpay' : 'Recorded manually'} · ${esc(d(p.paid_at))}</span></span>
              <span>${p.amount_paise != null ? esc(inr(p.amount_paise)) : ''} ${statusPill(p.status)}</span></li>`).join('') || '<li class="muted">No payments.</li>'}</ul></div>
          <div class="card pad"><div class="section-label">Mentor &amp; group</div><p class="small">${esc(w.group?.name || 'No group')}<span class="sub-line">${esc(w.group?.mentor_name || s.mentor_name || 'No mentor assigned')}</span></p></div>
          <div class="card pad"><div class="section-label">Next up</div>
            ${w.upcoming.length ? w.upcoming.slice(0, 3).map((b) => `<p class="small"><strong class="ivory">${esc(b.service)}</strong><span class="sub-line">${esc(dt(b.scheduled_at))} · ${esc(b.mentor_name || '')} · ${b.kind === 'checkup' ? 'Included check-up' : 'Paid session'} · ${esc(label(b.status))}</span></p>`).join('') : '<p class="small muted">No upcoming sessions.</p>'}
            <p class="small mt-1">Next action: <strong class="ivory">${esc(s.next_action || '—')}</strong><span class="sub-line">${due(s.follow_up_at)}</span></p>
            <div class="row wrap mt-1"><button class="btn btn-ghost btn-sm" data-ms="assessment">${s.assessment_completed_at ? '✓ Assessment' : 'Mark assessment done'}</button>
              <button class="btn btn-ghost btn-sm" data-ms="review">${s.progress_reviewed_at ? '✓ Progress review' : 'Mark progress review done'}</button></div></div>
          <div class="card pad"><div class="section-label">Open tasks</div><ul class="list tight small">${w.tasks.map((t) => `<li><label class="task"><input type="checkbox" data-done="${t.id}" aria-label="Mark done">
            <span>${esc(t.title)}<span class="sub-line">${esc(t.owner_name || 'Unassigned')} · ${due(t.due_at)}</span></span></label></li>`).join('') || '<li class="muted">No open tasks.</li>'}</ul></div>
          <div class="card pad"><div class="section-label">Support requests</div><ul class="list tight small">${cases.map((c) => `<li><span>${esc(c.subject)}<span class="sub-line">${esc(dt(c.updated_at))}</span></span>${statusPill(c.status)}</li>`).join('') || '<li class="muted">None.</li>'}</ul></div>
        </aside></div>`;
    const root = ctx.main;
    const form = root.querySelector('.composer form');
    let kind = 'internal_note';
    root.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
      kind = b.dataset.kind;
      root.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x === b));
      root.querySelector('.composer').classList.toggle('is-message', kind === 'message');
      root.querySelector('[data-msgopts]').hidden = kind !== 'message';
      root.querySelector('[data-hint]').textContent = kind === 'message' ? 'The student will see this in their dashboard. Delivery status is shown only after the email provider confirms it.' : 'Internal notes are only visible to the Anvaya team, never to students or mentors.';
      form.body.placeholder = kind === 'message' ? 'Write a message to the student…' : 'Write an internal note…';
      root.querySelector('[data-submit]').textContent = kind === 'message' ? 'Send message' : 'Save note';
    }));
    onSubmit(form, async (data) => {
      const r = await api(`/api/admin/students/${sid}/entries`, { method: 'POST', body: { kind, body: data.body, email: kind === 'message' && !!form.email?.checked,
        support_case_id: data.support_case_id || undefined, case_status: data.case_status || undefined } });
      toast(kind === 'internal_note' ? 'Note saved' : r.email === 'delivered' ? 'Message sent and emailed' : r.email === 'queued' ? 'Message saved; email queued for retry' : 'Message saved to the student’s dashboard');
      ctx.refresh();
    });
    root.querySelectorAll('[data-done]').forEach((c) => c.addEventListener('change', async () => { await api(`/api/admin/tasks/${c.dataset.done}`, { method: 'PATCH', body: { status: 'done' } }); toast('Task done'); ctx.refresh(); }));
    root.querySelectorAll('[data-ms]').forEach((b) => b.addEventListener('click', async () => {
      const isDone = b.textContent.startsWith('✓');
      await api(`/api/admin/students/${sid}/milestones`, { method: 'POST', body: { milestone: b.dataset.ms, done: !isDone } }); ctx.refresh();
    }));
    root.querySelector('[data-task]').addEventListener('click', () => newTask(ctx, { studentId: sid }));
    root.querySelector('[data-followup]').addEventListener('click', async () => { await followUp(ctx, 'students', sid, { owner_user_id: s.owner_user_id || '', next_action: s.next_action, follow_up_at: s.follow_up_at }); ctx.refresh(); });
    root.querySelector('[data-edit]').addEventListener('click', async () => {
      await formModal({ eyebrow: 'Edit student', title: esc(s.name), fields: await ctx.studentFields(), values: s, onSave: (b) => api(`/api/admin/students/${sid}`, { method: 'PATCH', body: b }) });
      toast('Saved'); ctx.refresh();
    });
    root.querySelector('[data-more]').addEventListener('click', () => ctx.studentDetail(sid));
    root.querySelector('[data-invite]')?.addEventListener('click', async (e) => {
      const email = s.email || prompt('Student’s email for their account:'); if (!email) return;
      e.target.disabled = true;
      try { const r = await api(`/api/admin/students/${sid}/invite`, { method: 'POST', body: { email } }); toast(r.delivered ? `Invite emailed to ${email}` : `Invite saved; email failed (${r.mailError})`, !r.delivered); ctx.refresh(); }
      catch (err) { toast(err.message, true); e.target.disabled = false; }
    });
  }

  // ══ Support inbox ══════════════════════════════════════════════════
  async function support(ctx) {
    const rows = await api('/api/admin/support');
    ctx.main.innerHTML = pageHead('Support', 'Support <em>requests</em>', 'Requests raised by students. Reply from the student’s record so the whole history stays together.')
      + `<div class="card reveal"><ul class="list small">${rows.map((c) => `<li><a href="#student-${c.student_id}" class="q-item"><span><strong class="ivory">${esc(c.subject)}</strong>
        <span class="sub-line">${esc(c.student_name)} · ${esc(label(c.category))} · ${esc(c.owner_name || 'unassigned')}</span></span><span class="when">${statusPill(c.status)} ${esc(dt(c.updated_at))}</span></a></li>`).join('') || '<li class="muted">No support requests yet.</li>'}</ul></div>`;
  }

  // ══ Mentor service approvals (admin) ═══════════════════════════════
  async function serviceApprovals(ctx) {
    const rows = await api('/api/admin/mentor-services');
    ctx.main.innerHTML = pageHead('Mentors', 'Service <em>approvals</em>', 'Mentors propose services; students can book them only after an admin approves the title, duration and price. Edits come back here.')
      + `<div class="card reveal"><ul class="list small">${rows.map((x) => `<li><span><strong class="ivory">${esc(x.title)}</strong> · ${esc(x.mentor_name)}
        <span class="sub-line">${x.duration_min} min${x.price_paise != null ? ` · ${esc(inr(x.price_paise))} (full fee to the mentor)` : ''}${x.active ? '' : ' · inactive'}${(x.intake_questions || []).length ? ` · ${(x.intake_questions || []).length} intake question(s)` : ''}</span>
        ${x.description ? `<span class="sub-line">${esc(x.description)}</span>` : ''}</span>
        <span class="row">${statusPill(x.approval)}${ctx.isAdmin && x.approval !== 'approved' ? `<button class="btn btn-primary btn-sm" data-dec="approve" data-sid="${x.id}">Approve</button>` : ''}
        ${ctx.isAdmin && x.approval !== 'rejected' ? `<button class="btn btn-ghost btn-sm" data-dec="reject" data-sid="${x.id}">Reject</button>` : ''}</span></li>`).join('') || '<li class="muted">No services submitted yet.</li>'}</ul></div>`;
    ctx.main.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/admin/mentor-services/${b.dataset.sid}/${b.dataset.dec}`, { method: 'POST', body: {} }); toast(b.dataset.dec === 'approve' ? 'Approved: students can book it' : 'Rejected'); ctx.refresh();
    }));
  }

  window.AnvayaOps = { today, queue, table, workspace, support, serviceApprovals, newTask };
})();
