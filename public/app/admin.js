// Admin + operations dashboard. The server enforces every permission; the UI just hides what a role can't use.
(async function () {
  const { api, loadMe, esc, inr, dt, d, toast, modal, confirmBox, onSubmit, statusPill, formModal, tableCard, onAct, pageHead, stat, opt, label } = A;
  let main = document.getElementById('main');
  const me = await loadMe();
  const isAdmin = me.user.role === 'admin';
  document.getElementById('who').textContent = me.user.email;
  document.getElementById('who-role').textContent = isAdmin ? 'Admin' : 'Operations';
  if (!isAdmin) document.querySelectorAll('[data-role="admin"]').forEach((el) => el.remove());
  const pwLink = document.createElement('button');
  pwLink.className = 'link-btn mb-1'; pwLink.textContent = 'Change password';
  pwLink.addEventListener('click', async () => {
    await formModal({ eyebrow: 'Security', title: 'Change <em>password</em>', fields: [{ name: 'current', label: 'Current password', type: 'password', required: true }, { name: 'next', label: 'New password (10+ characters, letters and numbers)', type: 'password', required: true }],
      onSave: (b) => api('/api/auth/change-password', { method: 'POST', body: b }) });
    await loadMe(); toast('Password updated — other devices were signed out');
  });
  document.querySelector('.side-foot [data-logout]').before(pwLink);

  const cache = {};
  const get = async (k, url) => (cache[k] = await api(url));
  const refresh = () => render(current);
  const setCount = (id, n) => { const el = document.getElementById(`c-${id}`); if (el) { el.textContent = n; el.hidden = !n; } };
  const btn = (act, text, cls = 'btn-ghost') => `<button class="btn ${cls} btn-sm" data-act="${act}">${text}</button>`;
  const mentorOpts = async (blank = 'Unassigned') => opt((cache.mentors || await get('mentors', '/api/admin/mentors')).filter((m) => m.status === 'active'), 'id', 'name', blank);
  const studentOpts = async () => opt(cache.students || await get('students', '/api/admin/students'), 'id', (s) => `${s.name}${s.email ? ` (${s.email})` : ''}`);
  const trackOpts = async (blank = '—') => opt(cache.tracks || await get('tracks', '/api/admin/tracks'), 'id', 'name', blank);

  // ══ Overview ════════════════════════════════════════════════════════
  async function overview() {
    const o = await api('/api/admin/overview');
    setCount('leads', o.counts.leadsNew); setCount('followups', o.counts.followupsDue + o.counts.studentsNeedingFollowup);
    setCount('mentors', o.counts.mentorsPending); setCount('services', o.counts.casesOpen); setCount('system', o.counts.sheetFailures);
    main.innerHTML = pageHead(isAdmin ? 'Admin console' : 'Operations', 'Good to see you', 'Today at a glance.') + `
      <div class="stats reveal">${stat(o.counts.leadsNew, 'New leads')}${stat(o.counts.followupsDue, 'Follow-ups due')}${stat(o.counts.activeSubscribers, 'Active subscribers')}${stat(o.counts.liveThisWeek, 'Classes & rooms this week')}</div>
      <div class="stats reveal">${stat(o.counts.upcoming, 'Upcoming 1:1 sessions')}${stat(o.counts.studentsNeedingFollowup, 'Students to follow up')}${stat(o.counts.casesOpen, 'Open resume cases')}${stat(`${o.counts.mentorsActive}<span class="muted small"> / ${o.counts.mentorsPending} pending</span>`, 'Mentors')}</div>
      ${o.revenue ? `<div class="stats reveal">${stat(inr(o.revenue.paid), 'Collected')}${stat(inr(o.revenue.refunded), 'Refunded')}${stat(inr(o.revenue.gatewayCosts), 'Gateway costs (Anvaya)')}${stat(inr(o.revenue.mentorPayable), 'Owed to mentors')}</div>` : ''}
      ${o.counts.sheetFailures ? `<div class="notice bad reveal">${o.counts.sheetFailures} enquiry(ies) didn’t reach the Google Sheet. They are safe in the CRM — open <a href="#leads">Leads</a> and press “Retry sheet”.</div>` : ''}
      <div class="grid-2 reveal">
        <div class="card"><div class="card-head"><h2 class="h2">Coming <em>up</em></h2><a class="link-btn" href="#calendar">Calendar →</a></div>
          ${o.upcoming.length ? `<ul class="list">${o.upcoming.map((x) => `<li><div><span class="strong">${esc(x.title || 'Session')}</span><span class="sub-line muted small">${esc(x.who || '')}${x.mentor ? ` · ${esc(x.mentor)}` : ''}</span></div><span class="when">${esc(dt(x.starts_at))}</span></li>`).join('')}</ul>` : '<div class="empty">Nothing scheduled.</div>'}</div>
        <div class="card"><div class="card-head"><h2 class="h2">Recent <em>leads</em></h2><a class="link-btn" href="#leads">All leads →</a></div>
          ${o.recentLeads.length ? `<ul class="list">${o.recentLeads.map((l) => `<li><div><span class="strong">${esc(l.name)}</span><span class="sub-line muted small">${esc(l.situation || '—')}</span></div>${statusPill(l.status)}</li>`).join('')}</ul>` : '<div class="empty">No leads yet.</div>'}</div>
      </div>`;
  }

  // ══ Follow-ups (ops queue) ══════════════════════════════════════════
  async function followups() {
    const f = await api('/api/admin/followups');
    const sec = (title, rows, cols, empty) => tableCard({ title, rows, columns: cols, empty });
    main.innerHTML = pageHead('Operations', 'Follow-<em>ups</em>', 'Everything that needs a call, a WhatsApp or a nudge today.');
    main.append(
      sec('Leads due (today + overdue)', f.leads.map((x) => ({ ...x, id: x.id })), [
        { h: 'Lead', cls: 'strong', render: (l) => `${esc(l.name)}<span class="sub-line">${esc(l.phone || '')}</span>` },
        { h: 'Next action', render: (l) => esc(l.next_action || '—') },
        { h: 'Due', render: (l) => `<span class="when">${esc(l.follow_up_at ? dt(l.follow_up_at) : 'Not set')}</span>` },
        { h: 'Owner', render: (l) => esc(l.owner_name || 'Unassigned') },
      ], 'No lead follow-ups due.'),
      sec('Flagged students', f.flagged, [{ h: 'Student', cls: 'strong', render: (s) => `${esc(s.name)}<span class="sub-line">${esc(s.phone || '')}</span>` }, { h: 'Why', render: (s) => esc(s.followup_reason || '—') }], 'Nobody flagged.'),
      sec('Missed 2+ sessions (21 days)', f.absences, [{ h: 'Student', cls: 'strong', render: (s) => esc(s.name) }, { h: 'Missed', render: (s) => s.missed }], 'No repeated absences.'),
      sec('Overdue assignments', f.overdueAssignments, [{ h: 'Student', cls: 'strong', render: (s) => esc(s.name) }, { h: 'Overdue', render: (s) => s.overdue }], 'Nothing overdue.'),
      sec('In grace period (renewal due)', f.inGrace, [{ h: 'Student', cls: 'strong', render: (s) => `${esc(s.name)}<span class="sub-line">${esc(s.phone || '')}</span>` }, { h: 'Paid through', render: (s) => esc(d(s.paid_through)) }, { h: 'Access ends', render: (s) => esc(d(s.grace_until)) }], 'No one in grace.'),
      sec('Account opened, intake not finished', f.intakePending, [{ h: 'Student', cls: 'strong', render: (s) => `${esc(s.name)}<span class="sub-line">${esc(s.phone || '')}</span>` }], 'All intakes complete.'),
    );
    main.querySelectorAll('tbody tr[data-id]').forEach((tr) => { if (tr.closest('.card').querySelector('h2')?.textContent.startsWith('Leads')) tr.addEventListener('click', () => leadDetail(Number(tr.dataset.id))); });
  }

  // ══ Leads ═══════════════════════════════════════════════════════════
  const LEAD_STATUS = [['new', 'New'], ['contacted', 'Contacted'], ['qualified', 'Qualified'], ['converted', 'Converted'], ['lost', 'Lost']];
  const SITUATIONS = ['Student / Fresher — building first resume', 'Working professional — want a stronger resume', 'Applying but not hearing back',
    'Targeting MBA / IIM / ISB', 'Career switch — need repositioning', 'Not sure — just want to understand my options'];
  async function leadFields() {
    const team = cache.team || await get('team', '/api/admin/team-options');
    return [
      { name: 'name', label: 'Name', required: true }, { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'email', label: 'Email', type: 'email' }, { name: 'source', label: 'Source' },
      { name: 'situation', label: 'Situation', type: 'select', options: [['', '—'], ...SITUATIONS.map((s) => [s, s])], span2: true },
      { name: 'status', label: 'Stage', type: 'select', options: LEAD_STATUS }, { name: 'owner_user_id', label: 'Owner', type: 'select', options: opt(team, 'id', 'name', 'Unassigned') },
      { name: 'next_action', label: 'Next action', span2: true }, { name: 'follow_up_at', label: 'Follow up on', type: 'datetime' },
      { name: 'notes', label: 'Notes', type: 'textarea', span2: true },
    ];
  }
  async function leadDetail(lid) {
    const l = (cache.leads || await get('leads', '/api/admin/leads')).find((x) => x.id === lid);
    const acts = await api(`/api/admin/leads/${lid}/activities`);
    const ui = modal(`<div class="eyebrow">Lead</div><div class="row-between mb-2"><h2 class="h2">${esc(l.name)}</h2>${statusPill(l.status)}</div>
      <div class="kv-inline mb-2"><span>Phone <strong>${esc(l.phone || '—')}</strong></span><span>Owner <strong>${esc(l.owner_name || '—')}</strong></span><span>Follow up <strong>${esc(l.follow_up_at ? dt(l.follow_up_at) : '—')}</strong></span><span>Sheet ${statusPill(l.sheet_sync_status)}</span></div>
      <p class="small mb-2"><span class="muted">Next action:</span> ${esc(l.next_action || '—')}</p>
      <form novalidate><div class="form-error" hidden></div><div class="form-grid">
        <div class="field"><label class="label">Log</label><select class="input" name="kind"><option value="call">Call</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="meeting">Meeting</option><option value="note">Note</option></select></div>
        <div class="field"><label class="label">Next follow-up (IST)</label><input class="input" type="datetime-local" name="follow_up_at"></div>
        <div class="field span-2"><label class="label">What happened</label><textarea class="input" name="body" rows="2" required></textarea></div>
        <div class="field span-2"><label class="label">Next action</label><input class="input" name="next_action" value="${esc(l.next_action)}"></div>
      </div><div class="row"><button class="btn btn-primary btn-sm" type="submit">Log activity</button></div></form>
      <div class="section-label mt-2">Timeline</div>
      <ul class="list small">${acts.map((a) => `<li><span>${statusPill(a.kind)} ${esc(a.body)}<span class="sub-line">${esc(a.user_name || 'System')}</span></span><span class="when">${esc(dt(a.created_at))}</span></li>`).join('') || '<li class="muted">No activity yet.</li>'}</ul>`, { wide: true });
    onSubmit(ui.el.querySelector('form'), async (data) => {
      await api(`/api/admin/leads/${lid}/activities`, { method: 'POST', body: { ...data, follow_up_at: data.follow_up_at ? A.fromLocalInput(data.follow_up_at) : undefined } });
      toast('Logged'); ui.close(); refresh();
    });
  }
  async function leads() {
    const rows = await get('leads', '/api/admin/leads');
    main.innerHTML = pageHead('CRM', 'Leads', 'Website enquiries land here automatically. Every lead needs an owner, a next action and a follow-up date.', '<button class="btn btn-primary" data-new>+ Add lead</button>');
    const now = Date.now();
    const card = tableCard({
      rows, search: (l) => `${l.name} ${l.phone} ${l.email} ${l.situation} ${l.next_action} ${l.owner_name || ''}`, filter: { key: 'status', options: LEAD_STATUS },
      columns: [
        { h: 'Lead', cls: 'strong', render: (l) => `${esc(l.name)}<span class="sub-line">${esc(l.phone || l.email || '—')}</span>` },
        { h: 'Situation', render: (l) => `${esc(l.situation || '—')}<span class="sub-line">${esc(l.source)} · ${esc(d(l.created_at))}</span>` },
        { h: 'Next action', render: (l) => `${esc(l.next_action || '—')}<span class="sub-line ${l.follow_up_at && new Date(l.follow_up_at) < now ? 'due' : ''}">${l.follow_up_at ? esc(dt(l.follow_up_at)) : 'No follow-up set'}</span>` },
        { h: 'Owner', render: (l) => esc(l.owner_name || '—') },
        { h: 'Stage', render: (l) => statusPill(l.status) + (l.sheet_sync_status === 'failed' ? `<span class="sub-line due">Sheet sync failed</span>` : '') },
      ],
      rowActions: (l) => btn('open', 'Open') + btn('edit', 'Edit') + (l.sheet_sync_status === 'failed' || l.sheet_sync_status === 'pending' ? btn('sheet', 'Retry sheet') : '') + (l.student_id ? '' : btn('convert', 'Convert')) + (isAdmin ? btn('del', 'Delete', 'btn-danger') : ''),
    });
    main.appendChild(card);
    main.querySelector('[data-new]').addEventListener('click', async () => {
      await formModal({ eyebrow: 'New lead', title: 'Add a <em>lead</em>', fields: await leadFields(), values: { status: 'new', source: 'Manual' }, onSave: (b) => api('/api/admin/leads', { method: 'POST', body: b }) });
      toast('Lead added'); refresh();
    });
    onAct(card, {
      open: leadDetail,
      edit: async (i) => { const l = rows.find((r) => r.id === i); await formModal({ eyebrow: 'Edit lead', title: esc(l.name), fields: await leadFields(), values: l, onSave: (b) => api(`/api/admin/leads/${i}`, { method: 'PATCH', body: b }) }); toast('Saved'); refresh(); },
      sheet: async (i) => { const r = await api(`/api/admin/leads/${i}/sheet-retry`, { method: 'POST', body: {} }); toast(r.sheet_sync_status === 'synced' ? 'Copied to the Google Sheet' : `Still failing: ${r.sheet_sync_error}`, r.sheet_sync_status !== 'synced'); refresh(); },
      convert: async (i) => { await api(`/api/admin/leads/${i}/convert`, { method: 'POST', body: {} }); toast('Converted to a student'); refresh(); },
      del: async (i) => { if (await confirmBox('Delete lead?', 'This cannot be undone.', { danger: true, ok: 'Delete' })) { await api(`/api/admin/leads/${i}`, { method: 'DELETE' }); refresh(); } },
    });
  }

  // ══ Students ════════════════════════════════════════════════════════
  async function studentFields() {
    return [
      { name: 'name', label: 'Name', required: true }, { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'email', label: 'Email', type: 'email' }, { name: 'college_name', label: 'College / company' },
      { name: 'target_role', label: 'Target role' }, { name: 'prep_level', label: 'Preparation level', type: 'select', options: [['', '—'], ['starting', 'Just starting'], ['some_preparation', 'Some preparation'], ['interview_ready', 'Interview-ready']] },
      { name: 'track_id', label: 'Track', type: 'select', options: await trackOpts() }, { name: 'availability_pref', label: 'Availability' },
      { name: 'mentor_id', label: 'Primary mentor', type: 'select', options: await mentorOpts() }, { name: 'status', label: 'Status', type: 'select', options: [['active', 'Active'], ['paused', 'Paused'], ['completed', 'Completed']] },
      { name: 'goals', label: 'Goals (visible to their mentor)', type: 'textarea', span2: true },
      { name: 'needs_followup', label: 'Needs follow-up', type: 'checkbox' }, { name: 'followup_reason', label: 'Follow-up reason' },
      ...(isAdmin ? [{ name: 'notes', label: 'Private admin notes', type: 'textarea', span2: true, hint: 'Never shown to mentors, operations or the student.' }] : []),
    ];
  }
  async function studentDetail(sid) {
    const s = await api(`/api/admin/students/${sid}`);
    const sub = s.subscriptions.find((x) => ['active', 'grace'].includes(x.effective_access));
    const ui = modal(`<div class="eyebrow">Student</div><div class="row-between mb-2"><h2 class="h2">${esc(s.name)}</h2>${statusPill(s.status)}</div>
      <div class="kv-inline mb-3"><span>Email <strong>${esc(s.email || '—')}</strong></span><span>Phone <strong>${esc(s.phone || '—')}</strong></span><span>Track <strong>${esc(s.track_name || '—')}</strong></span>
        <span>Group <strong>${esc(s.group?.name || '—')}</strong></span><span>Account <strong>${s.has_account ? 'Active' : s.account_email ? 'Invited' : 'None'}</strong></span><span>Intake <strong>${s.intake_completed_at ? 'Done' : 'Pending'}</strong></span></div>
      <div class="row mb-3">${s.has_account ? '' : `<button class="btn btn-primary btn-sm" data-invite>${s.account_email ? 'Resend portal invite' : 'Invite to student portal'}</button>`}
        <button class="btn btn-ghost btn-sm" data-edit>Edit</button></div>
      <div class="grid-2"><div><div class="section-label">Plan</div>${sub ? `<p class="small">${esc(sub.plan_name)} ${statusPill(sub.effective_access)}<span class="sub-line">Paid through ${esc(d(sub.paid_through))}</span></p>` : '<p class="small muted">No active plan.</p>'}
        <div class="section-label mt-2">Goals</div><p class="small">${esc(s.goals || '—')}</p>
        ${isAdmin && s.notes ? `<div class="section-label mt-2">Private notes</div><div class="note-box">${esc(s.notes)}</div>` : ''}
        <div class="section-label mt-2">Documents</div>${s.documents.map((x) => x.latest_version_id ? `<button class="link-btn" data-open="${x.latest_version_id}">${esc(label(x.kind))}: ${esc(x.title)}</button><br>` : '').join('') || '<p class="small muted">None.</p>'}</div>
      <div><div class="section-label">Sessions</div><ul class="list small">${s.bookings.slice(0, 8).map((b) => `<li><span>${esc(b.service || label(b.kind))}<span class="sub-line">${esc(b.mentor_name || '')}</span></span><span>${statusPill(b.status)}<span class="sub-line when">${esc(dt(b.scheduled_at))}</span></span></li>`).join('') || '<li class="muted">None.</li>'}</ul>
        <div class="section-label mt-2">Attendance</div><ul class="list small">${s.attendance.slice(0, 6).map((a) => `<li><span>${esc(a.title || '')}</span>${statusPill(a.status)}</li>`).join('') || '<li class="muted">None.</li>'}</ul>
        <div class="section-label mt-2">Applications</div><ul class="list small">${s.applications.map((a) => `<li><span>${esc(a.company)} · ${esc(a.role_title)}</span>${statusPill(a.stage)}</li>`).join('') || '<li class="muted">None reported.</li>'}</ul></div></div>`, { wide: true });
    ui.el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => A.openFile(b.dataset.open)));
    ui.el.querySelector('[data-invite]')?.addEventListener('click', async (e) => {
      const email = s.email || prompt('Student’s email for their account:');
      if (!email) return;
      e.target.disabled = true;
      try { const r = await api(`/api/admin/students/${sid}/invite`, { method: 'POST', body: { email } }); toast(r.delivered ? `Invite emailed to ${email}` : `Invite queued (email failed: ${r.mailError})`, !r.delivered); ui.close(); refresh(); }
      catch (err) { toast(err.message, true); e.target.disabled = false; }
    });
    ui.el.querySelector('[data-edit]').addEventListener('click', async () => {
      ui.close();
      await formModal({ eyebrow: 'Edit student', title: esc(s.name), fields: await studentFields(), values: s, onSave: (b) => api(`/api/admin/students/${sid}`, { method: 'PATCH', body: b }) });
      toast('Saved'); refresh();
    });
  }
  async function students() {
    const rows = await get('students', '/api/admin/students');
    main.innerHTML = pageHead('CRM', 'Students', 'Profiles, plans, groups and portal accounts.', '<button class="btn btn-primary" data-new>+ Add student</button>');
    const card = tableCard({
      rows, search: (s) => `${s.name} ${s.email} ${s.phone} ${s.target_role} ${s.track_name || ''} ${s.group_name || ''}`, filter: { key: 'status', options: [['active', 'Active'], ['paused', 'Paused'], ['completed', 'Completed']] },
      columns: [
        { h: 'Student', cls: 'strong', render: (s) => `${esc(s.name)}${s.needs_followup ? ' <span class="pill bad">Follow up</span>' : ''}<span class="sub-line">${esc(s.email || s.phone || '—')}</span>` },
        { h: 'Track / group', render: (s) => `${esc(s.track_name || '—')}<span class="sub-line">${esc(s.group_name || 'No group')}</span>` },
        { h: 'Plan', render: (s) => (s.paid_through ? `Paid through<span class="sub-line">${esc(d(s.paid_through))}</span>` : '<span class="muted">—</span>') },
        { h: 'Portal', render: (s) => (s.has_account ? statusPill('active') : s.account_email ? statusPill('invite_pending') : '<span class="muted">Not invited</span>') + (s.intake_completed_at ? '<span class="sub-line">Intake done</span>' : '') },
      ],
      rowActions: () => btn('open', 'Open') + (isAdmin ? btn('del', 'Delete', 'btn-danger') : ''),
    });
    main.appendChild(card);
    main.querySelector('[data-new]').addEventListener('click', async () => {
      const r = await formModal({ eyebrow: 'New student', title: 'Add a <em>student</em>', fields: await studentFields(), values: { status: 'active' }, onSave: (b) => api('/api/admin/students', { method: 'POST', body: b }) });
      toast('Student added'); await refresh(); studentDetail(r.id);
    });
    onAct(card, {
      open: studentDetail,
      del: async (i) => { if (await confirmBox('Delete student?', 'Deletes their bookings and records too. Students with paid orders can’t be deleted — mark them inactive instead.', { danger: true, ok: 'Delete' })) { await api(`/api/admin/students/${i}`, { method: 'DELETE' }); refresh(); } },
    });
  }

  // ══ Mentors ═════════════════════════════════════════════════════════
  const mentorFields = (isNew) => [
    { name: 'name', label: 'Full name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'expertise', label: 'Expertise', span2: true, placeholder: 'e.g. Product management, MBA admissions' },
    { name: 'bio', label: 'Bio', type: 'textarea', span2: true },
    { name: 'session_price_paise', label: 'Private session fee', type: 'money', required: true, hint: 'Zero commission: the student pays this and the full amount is owed to the mentor.' },
    { name: 'session_duration', label: 'Session length (min)', type: 'number', min: 15, max: 240, step: 5 },
    { name: 'checkup_fee_paise', label: 'Fee per included check-up', type: 'money', hint: 'Paid by Anvaya; tracked separately.' },
    { name: 'max_students', label: 'Capacity (students + open cases)', type: 'number', min: 0, max: 500 },
    { name: 'accepts_paid_sessions', label: 'Accepts paid private sessions', type: 'checkbox' },
    ...(isNew ? [] : []),
  ];
  async function mentorDetail(mid) {
    const m = await api(`/api/admin/mentors/${mid}`);
    modal(`<div class="eyebrow">Mentor</div><div class="row-between mb-3"><h2 class="h2">${esc(m.name)}</h2>${statusPill(m.status)}</div>
      <dl class="kv mb-3"><dt>Email</dt><dd>${esc(m.email)}</dd><dt>Expertise</dt><dd>${esc(m.expertise || '—')}</dd><dt>Bio</dt><dd>${esc(m.bio || '—')}</dd>
        <dt>Session</dt><dd>${inr(m.session_price_paise)} · ${m.session_duration} min</dd><dt>Load</dt><dd>${m.student_count} students · ${m.open_cases} open cases · capacity ${m.max_students}</dd>
        <dt>Meeting link</dt><dd>${esc(m.meeting_link || '—')}</dd><dt>Last sign-in</dt><dd>${esc(m.last_login_at ? dt(m.last_login_at) : '—')}</dd>
        ${isAdmin ? `<dt>Payable</dt><dd>${inr(m.payable_paise)}</dd>` : ''}</dl>
      <div class="section-label">Weekly availability (IST)</div>${A.weekView(m.availability)}`, { wide: true });
  }
  async function mentors() {
    const rows = await get('mentors', '/api/admin/mentors');
    setCount('mentors', rows.filter((m) => m.status === 'invite_pending').length);
    main.innerHTML = pageHead('CRM', 'Mentors', 'Invite mentors, manage access, and see load and capacity.', isAdmin ? '<button class="btn btn-primary" data-new>+ Add mentor</button>' : '');
    const card = tableCard({
      rows, search: (m) => `${m.name} ${m.email} ${m.expertise}`, filter: { key: 'status', options: [['invite_pending', 'Invite pending'], ['active', 'Active'], ['deactivated', 'Deactivated']] },
      columns: [
        { h: 'Mentor', cls: 'strong', render: (m) => `${esc(m.name)}<span class="sub-line">${esc(m.email)}</span>` },
        { h: 'Expertise', render: (m) => esc(m.expertise || '—') },
        { h: 'Fee', render: (m) => `${inr(m.session_price_paise)}<span class="sub-line">${m.session_duration} min</span>` },
        { h: 'Load', render: (m) => `${m.student_count + m.open_cases} / ${m.max_students}<span class="sub-line">${m.upcoming_count} upcoming</span>` },
        { h: 'Status', render: (m) => statusPill(m.status) + (m.status === 'invite_pending' ? `<span class="sub-line">${m.has_password ? 'Accepted · completing profile' : m.invite_expires_at ? (new Date(m.invite_expires_at) < new Date() ? 'Link expired' : `Link expires ${esc(d(m.invite_expires_at))}`) : 'No active link'}</span>` : '') },
      ],
      rowActions: (m) => btn('view', 'View') + (isAdmin ? btn('edit', 'Edit') + (m.status === 'invite_pending' && !m.has_password ? btn('resend', 'Resend invite') : '')
        + (m.status === 'deactivated' ? btn('reactivate', 'Reactivate') : btn('deactivate', 'Deactivate', 'btn-danger')) : ''),
    });
    main.appendChild(card);
    main.querySelector('[data-new]')?.addEventListener('click', async () => {
      const r = await formModal({ eyebrow: 'Add mentor', title: 'Invite a <em>new mentor</em>', fields: mentorFields(true), values: { session_duration: 45, max_students: 12, accepts_paid_sessions: true }, submit: 'Add & send invitation',
        intro: '<p class="hint mb-2">They’ll get an email with a unique, single-use link that expires in 72 hours.</p>', onSave: (b) => api('/api/admin/mentors', { method: 'POST', body: b }) });
      toast(r.mailError ? `Mentor added, but the email didn’t send yet (${r.mailError}). It will retry automatically.` : 'Invitation sent', !!r.mailError); refresh();
    });
    const byId = (i) => rows.find((r) => r.id === i);
    onAct(card, {
      view: mentorDetail,
      edit: async (i) => { await formModal({ eyebrow: 'Edit mentor', title: esc(byId(i).name), fields: mentorFields(false), values: byId(i), onSave: (b) => api(`/api/admin/mentors/${i}`, { method: 'PATCH', body: b }) }); toast('Saved'); refresh(); },
      resend: async (i) => { const r = await api(`/api/admin/mentors/${i}/resend-invite`, { method: 'POST', body: {} }); toast(r.invite.delivered ? 'New invitation sent; the old link no longer works' : `Queued — email failed: ${r.mailError}`, !r.invite.delivered); refresh(); },
      deactivate: async (i) => { if (await confirmBox('Deactivate mentor?', `${byId(i).name} is signed out immediately and can’t sign in. Pending links stop working. Records are kept.`, { danger: true, ok: 'Deactivate' })) { await api(`/api/admin/mentors/${i}/deactivate`, { method: 'POST', body: {} }); toast('Deactivated'); refresh(); } },
      reactivate: async (i) => { const r = await api(`/api/admin/mentors/${i}/reactivate`, { method: 'POST', body: {} }); toast(r.status === 'active' ? 'Reactivated' : 'Back to Invite pending — resend the invitation'); refresh(); },
    });
  }

  // ══ Groups ══════════════════════════════════════════════════════════
  async function groupFields() {
    return [
      { name: 'name', label: 'Group name', required: true }, { name: 'track_id', label: 'Track', type: 'select', options: await trackOpts() },
      { name: 'mentor_id', label: 'Mentor', type: 'select', options: await mentorOpts() }, { name: 'capacity', label: 'Capacity', type: 'number', min: 1, max: 100, hint: 'Leave empty for the default in Settings.' },
      { name: 'target_role', label: 'Target role' }, { name: 'prep_level', label: 'Preparation level', type: 'select', options: [['', 'Any'], ['starting', 'Just starting'], ['some_preparation', 'Some preparation'], ['interview_ready', 'Interview-ready']] },
      { name: 'availability', label: 'Meets (e.g. “Weekday evenings”)' }, { name: 'cohort_id', label: 'College cohort (optional)', type: 'select', options: opt(cache.cohorts || await get('cohorts', '/api/admin/cohorts'), 'id', 'name', '—') },
      { name: 'meet_link', label: 'Google Meet link', type: 'url', span2: true }, { name: 'whatsapp_link', label: 'WhatsApp community link', type: 'url', span2: true },
      { name: 'active', label: 'Active', type: 'checkbox' },
    ];
  }
  async function groups() {
    const rows = await get('groups', '/api/admin/groups');
    main.innerHTML = pageHead('Delivery', 'Mentor <em>groups</em>', 'Small groups by track, target role, level and availability. Auto-assign fills free seats; you can always override.',
      '<button class="btn btn-ghost" data-auto>Auto-assign subscribers</button><button class="btn btn-primary" data-new>+ New group</button>');
    const card = tableCard({
      rows, search: (g) => `${g.name} ${g.track_name || ''} ${g.mentor_name || ''}`,
      columns: [
        { h: 'Group', cls: 'strong', render: (g) => `${esc(g.name)}${g.active ? '' : ' <span class="pill off">Inactive</span>'}<span class="sub-line">${esc(g.track_name || 'Any track')} · ${esc(g.target_role || 'Any role')}</span>` },
        { h: 'Mentor', render: (g) => esc(g.mentor_name || 'Unassigned') },
        { h: 'Seats', render: (g) => `${g.member_count} / ${g.capacity}<div class="bar mt-1"><span style-w="${Math.min(100, Math.round((g.member_count / g.capacity) * 100))}"></span></div>` },
        { h: 'Level · time', render: (g) => `${esc(label(g.prep_level) || 'Any')}<span class="sub-line">${esc(g.availability || '—')}</span>` },
      ],
      rowActions: () => btn('members', 'Members') + btn('edit', 'Edit'),
    });
    main.appendChild(card);
    card.querySelectorAll('[style-w]').forEach((el) => { el.style.width = `${el.getAttribute('style-w')}%`; });
    main.querySelector('[data-new]').addEventListener('click', async () => { await formModal({ eyebrow: 'New group', title: 'Create a <em>group</em>', fields: await groupFields(), values: { active: true }, onSave: (b) => api('/api/admin/groups', { method: 'POST', body: b }) }); toast('Group created'); refresh(); });
    main.querySelector('[data-auto]').addEventListener('click', async () => {
      const dry = await api('/api/admin/groups/auto-assign', { method: 'POST', body: { dry_run: true } });
      const ui = modal(`<div class="eyebrow">Auto-assign</div><h2 class="h2 mb-2">Proposed <em>assignments</em></h2>
        ${dry.plan.length ? `<ul class="list small">${dry.plan.map((p) => `<li><span class="strong">${esc(p.student)}</span><span>${p.group ? esc(p.group) : `<span class="muted">${esc(p.reason)}</span>`}</span></li>`).join('')}</ul>` : '<p class="muted">Every active subscriber already has a group.</p>'}
        <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button>${dry.plan.some((p) => p.group_id) ? '<button class="btn btn-primary" data-go>Apply</button>' : ''}</div>`);
      ui.el.querySelector('[data-go]')?.addEventListener('click', async () => { await api('/api/admin/groups/auto-assign', { method: 'POST', body: {} }); ui.close(); toast('Assigned'); refresh(); });
    });
    onAct(card, {
      edit: async (i) => { await formModal({ eyebrow: 'Edit group', title: esc(rows.find((g) => g.id === i).name), fields: await groupFields(), values: rows.find((g) => g.id === i), onSave: (b) => api(`/api/admin/groups/${i}`, { method: 'PATCH', body: b }) }); toast('Saved'); refresh(); },
      members: async (i) => {
        const g = rows.find((x) => x.id === i);
        const mem = await api(`/api/admin/groups/${i}/members`);
        const ui = modal(`<div class="eyebrow">Group members</div><h2 class="h2 mb-2">${esc(g.name)} <span class="muted small">${mem.length}/${g.capacity}</span></h2>
          <ul class="list">${mem.map((m) => `<li><span class="strong">${esc(m.name)}${m.is_override ? ' <span class="pill">Override</span>' : ''}<span class="sub-line">${esc(m.target_role || '')} · ${esc(label(m.prep_level) || '')} · ${esc(m.availability_pref || '')}</span></span><button class="btn btn-danger btn-sm" data-rm="${m.student_id}">Remove</button></li>`).join('') || '<li class="muted">No members.</li>'}</ul>
          <form novalidate class="mt-2"><div class="form-error" hidden></div><div class="form-grid"><div class="field span-2"><label class="label">Add / move a student here</label><select class="input" name="student_id">${(await studentOpts()).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
          <div class="field"><label class="check"><input type="checkbox" name="allow_over_capacity" value="true"> <span>Allow over capacity</span></label></div></div>
          <div class="row"><button class="btn btn-primary btn-sm" type="submit">Assign (override)</button></div></form>`, { wide: true });
        ui.el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/admin/groups/${i}/members/${b.dataset.rm}`, { method: 'DELETE' }); ui.close(); toast('Removed'); refresh(); }));
        onSubmit(ui.el.querySelector('form'), async (dta) => { await api(`/api/admin/groups/${i}/members`, { method: 'POST', body: { student_id: dta.student_id, allow_over_capacity: dta.allow_over_capacity === 'true' } }); ui.close(); toast('Assigned'); refresh(); });
      },
    });
  }

  // ══ Calendar: live classes / rooms + 1:1 bookings ═══════════════════
  async function attendanceModal(liveId, title) {
    const roster = await api(`/api/admin/live-sessions/${liveId}/roster`);
    const ui = modal(`<div class="eyebrow">Attendance</div><h2 class="h2 mb-2">${esc(title)}</h2>
      <form novalidate><div class="form-error" hidden></div><ul class="list">${roster.map((p) => `<li><span class="strong">${esc(p.name)}</span><select class="input" name="s-${p.id}">${['', 'present', 'late', 'absent', 'excused'].map((s) => `<option value="${s}"${p.status === s ? ' selected' : ''}>${s ? label(s) : '—'}</option>`).join('')}</select></li>`).join('') || '<li class="muted">No one on the roster.</li>'}</ul>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" type="submit">Save attendance</button></div></form>`);
    onSubmit(ui.el.querySelector('form'), async (dta) => {
      const marks = Object.entries(dta).filter(([, v]) => v).map(([k, v]) => ({ student_id: Number(k.slice(2)), status: v }));
      await api(`/api/admin/live-sessions/${liveId}/attendance`, { method: 'POST', body: { marks } }); ui.close(); toast('Attendance saved'); refresh();
    });
  }
  async function liveFields(isNew) {
    return [
      { name: 'kind', label: 'Type', type: 'select', options: [['live_class', 'Weekly live class'], ['group_room', 'Small-group mentor room']] },
      { name: 'title', label: 'Title', required: true },
      { name: 'starts_at', label: 'Starts', type: 'datetime', required: true }, { name: 'ends_at', label: 'Ends', type: 'datetime', required: true },
      { name: 'group_id', label: 'Group (for mentor rooms)', type: 'select', options: opt(cache.groups || await get('groups', '/api/admin/groups'), 'id', 'name', '—') },
      { name: 'track_id', label: 'Track (for classes)', type: 'select', options: await trackOpts('All subscribers') },
      { name: 'mentor_id', label: 'Mentor / host', type: 'select', options: await mentorOpts('From group / none') },
      { name: 'cohort_id', label: 'College cohort (optional)', type: 'select', options: opt(cache.cohorts || await get('cohorts', '/api/admin/cohorts'), 'id', 'name', '—') },
      { name: 'meet_link', label: 'Google Meet link', type: 'url', span2: true },
      ...(isNew ? [{ name: 'repeat_weeks', label: 'Repeat weekly for (weeks)', type: 'number', min: 0, max: 26 }] : [{ name: 'status', label: 'Status', type: 'select', options: [['scheduled', 'Scheduled'], ['completed', 'Completed'], ['cancelled', 'Cancelled']] }]),
      ...(isAdmin ? [{ name: 'delivery_fee_paise', label: 'Delivery fee to mentor', type: 'money', hint: 'Anvaya’s cost for running this session; separate from private-session earnings.' }] : []),
      { name: 'notes', label: 'Notes', type: 'textarea', span2: true },
    ];
  }
  async function calendar() {
    const [lives, bookings] = await Promise.all([api('/api/admin/live-sessions'), get('bookings', '/api/admin/bookings')]);
    main.innerHTML = pageHead('Delivery', 'Session <em>list</em>', '<a href="#calendar">← Back to the calendar</a> · All times in IST. Live classes and mentor rooms run on Google Meet; 1:1 bookings come from students or are added here.',
      '<button class="btn btn-ghost" data-book>+ 1:1 booking</button><button class="btn btn-primary" data-new>+ Class / room</button>');
    const now = Date.now();
    const liveCard = tableCard({
      title: 'Classes &amp; mentor rooms', rows: lives, search: (l) => `${l.title} ${l.group_name || ''} ${l.mentor_name || ''}`,
      filter: { key: 'status', options: [['scheduled', 'Scheduled'], ['completed', 'Completed'], ['cancelled', 'Cancelled']] },
      columns: [
        { h: 'When (IST)', render: (l) => `<span class="when">${esc(dt(l.starts_at))}</span><span class="sub-line">until ${esc(A.time(l.ends_at))}</span>` },
        { h: 'Session', cls: 'strong', render: (l) => `${esc(l.title)}<span class="sub-line">${esc(label(l.kind))} · ${esc(l.group_name || l.cohort_name || l.track_name || 'All subscribers')}</span>` },
        { h: 'Host', render: (l) => esc(l.mentor_name || '—') },
        { h: 'Status', render: (l) => statusPill(l.status) + (new Date(l.starts_at) < now && l.status === 'scheduled' ? `<span class="sub-line">${l.marked} marked</span>` : '') },
      ],
      rowActions: (l) => btn('att', 'Attendance') + (l.status === 'scheduled' ? btn('remind', 'Remind') + btn('done', 'Complete') : '') + btn('edit', 'Edit'),
    });
    const bookCard = tableCard({
      title: '1:1 sessions', rows: bookings, search: (b) => `${b.student_name} ${b.mentor_name || ''} ${b.service}`,
      filter: { key: 'status', options: [['requested', 'Requested'], ['pending_payment', 'Awaiting payment'], ['scheduled', 'Confirmed'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['no_show', 'No-show']] },
      columns: [
        { h: 'When (IST)', render: (b) => `<span class="when">${esc(dt(b.scheduled_at))}</span><span class="sub-line">${b.duration} min</span>` },
        { h: 'Student', cls: 'strong', render: (b) => `${esc(b.student_name)}<span class="sub-line">${esc(b.service || label(b.kind))}</span>` },
        { h: 'Mentor', render: (b) => esc(b.mentor_name || '—') + (isAdmin && b.price_paise ? `<span class="sub-line">${inr(b.price_paise)}</span>` : '') },
        { h: 'Status', render: (b) => statusPill(b.status) + (b.attendance ? `<span class="sub-line">${esc(label(b.attendance))}</span>` : '') + (b.cancel_reason ? `<span class="sub-line due">${esc(b.cancel_reason)}</span>` : '') },
      ],
      rowActions: (b) => (['scheduled', 'requested'].includes(b.status) ? btn('bdone', 'Completed') + btn('noshow', 'No-show') + btn('bedit', 'Reschedule') + btn('bcancel', 'Cancel', 'btn-danger') : '') + (b.session_notes ? btn('bnotes', 'Notes') : ''),
    });
    main.append(liveCard, bookCard);
    main.querySelector('[data-new]').addEventListener('click', async () => {
      const r = await formModal({ eyebrow: 'Calendar', title: 'Schedule a <em>session</em>', fields: await liveFields(true), values: { kind: 'live_class', repeat_weeks: 0 }, onSave: (b) => api('/api/admin/live-sessions', { method: 'POST', body: b }) });
      toast(`${r.ids.length} session(s) scheduled`); refresh();
    });
    main.querySelector('[data-book]').addEventListener('click', async () => {
      const r = await formModal({ eyebrow: 'Calendar', title: 'Book a <em>1:1</em>', fields: [
        { name: 'student_id', label: 'Student', type: 'select', options: await studentOpts(), span2: true },
        { name: 'mentor_id', label: 'Mentor', type: 'select', options: await mentorOpts('—') },
        { name: 'kind', label: 'Type', type: 'select', options: [['checkup', 'Included check-up (uses plan)'], ['paid_session', 'Private session (record payment separately)']] },
        { name: 'scheduled_at', label: 'Starts', type: 'datetime', required: true }, { name: 'service', label: 'Title' },
        { name: 'outside_availability', label: 'Allow outside the mentor’s availability', type: 'checkbox' },
      ], onSave: (b) => api('/api/admin/bookings', { method: 'POST', body: b }) });
      toast(`Booked (${label(r.status)})`); refresh();
    });
    onAct(liveCard, {
      att: (i) => attendanceModal(i, lives.find((l) => l.id === i).title),
      remind: async (i) => { const r = await api(`/api/admin/live-sessions/${i}/remind`, { method: 'POST', body: {} }); toast(`Reminder queued for ${r.queued} student(s)`); },
      done: async (i) => { await api(`/api/admin/live-sessions/${i}`, { method: 'PATCH', body: { status: 'completed' } }); toast('Marked completed'); refresh(); },
      edit: async (i) => { await formModal({ eyebrow: 'Edit session', title: esc(lives.find((l) => l.id === i).title), fields: await liveFields(false), values: lives.find((l) => l.id === i), onSave: (b) => api(`/api/admin/live-sessions/${i}`, { method: 'PATCH', body: b }) }); toast('Saved'); refresh(); },
    });
    const setBooking = (i, body) => api(`/api/admin/bookings/${i}`, { method: 'PATCH', body }).then(() => { toast('Updated'); refresh(); });
    onAct(bookCard, {
      bdone: (i) => setBooking(i, { status: 'completed' }),
      noshow: (i) => setBooking(i, { status: 'no_show' }),
      bcancel: async (i) => { if (await confirmBox('Cancel this session?', 'The slot is released. Refunds for paid sessions are handled in Payments.', { danger: true, ok: 'Cancel session' })) setBooking(i, { status: 'cancelled', cancel_reason: 'Cancelled by Anvaya' }); },
      bedit: async (i) => { const b = bookings.find((x) => x.id === i); await formModal({ eyebrow: 'Reschedule', title: esc(b.student_name), fields: [{ name: 'scheduled_at', label: 'New time', type: 'datetime', required: true }, { name: 'meeting_link', label: 'Meet link', type: 'url', span2: true }], values: b, onSave: (body) => api(`/api/admin/bookings/${i}`, { method: 'PATCH', body }) }); toast('Rescheduled'); refresh(); },
      bnotes: (i) => { const b = bookings.find((x) => x.id === i); modal(`<div class="eyebrow">Session notes</div><h2 class="h2 mb-2">${esc(b.student_name)}</h2><div class="note-box">${esc(b.session_notes)}</div>`); },
    });
  }

  // ══ Syllabus ════════════════════════════════════════════════════════
  async function syllabus() {
    const [tracks, modules, assignments, subs] = await Promise.all([get('tracks', '/api/admin/tracks'), api('/api/admin/modules'), api('/api/admin/assignments'), api('/api/admin/submissions')]);
    main.innerHTML = pageHead('Delivery', 'Syllabus', 'Tracks → modules → assignments. Students on a plan with the syllabus entitlement see their enrolled tracks.',
      isAdmin ? '<button class="btn btn-ghost" data-nt>+ Track</button><button class="btn btn-ghost" data-nm>+ Module</button><button class="btn btn-primary" data-na>+ Assignment</button>' : '');
    const subCard = tableCard({ title: `Submissions to review <span class="muted small">${subs.length}</span>`, rows: subs.map((s) => ({ ...s, id: `${s.student_id}-${s.assignment_id}` })),
      columns: [{ h: 'Student', cls: 'strong', render: (s) => esc(s.student_name) }, { h: 'Assignment', render: (s) => `${esc(s.assignment_title)}<span class="sub-line">${esc(s.module_title)}</span>` }, { h: 'Submitted', render: (s) => esc(dt(s.submitted_at)) }],
      rowActions: () => btn('review', 'Review'), empty: 'Nothing waiting for review.' });
    const tCard = tableCard({ title: 'Tracks', rows: tracks, columns: [{ h: 'Track', cls: 'strong', render: (t) => `${esc(t.name)}${t.active ? '' : ' <span class="pill off">Inactive</span>'}<span class="sub-line">${esc(t.target_role || '')}</span>` }, { h: 'Modules', render: (t) => t.module_count }, { h: 'Enrolled', render: (t) => t.enrolled }], rowActions: isAdmin ? () => btn('edit', 'Edit') : null });
    const mCard = tableCard({ title: 'Modules', rows: modules, search: (m) => `${m.title} ${m.track_name}`, columns: [{ h: 'Module', cls: 'strong', render: (m) => `${esc(m.title)}<span class="sub-line">${esc(m.track_name)}${m.week_number ? ` · week ${m.week_number}` : ''}</span>` }, { h: 'Assignments', render: (m) => m.assignment_count }], rowActions: isAdmin ? () => btn('edit', 'Edit') + btn('del', 'Delete', 'btn-danger') : null });
    const aCard = tableCard({ title: 'Assignments', rows: assignments, search: (a) => `${a.title} ${a.module_title} ${a.track_name}`, columns: [{ h: 'Assignment', cls: 'strong', render: (a) => `${esc(a.title)}<span class="sub-line">${esc(a.track_name)} · ${esc(a.module_title)}</span>` }, { h: 'Due', render: (a) => (a.due_offset_days != null ? `Day ${a.due_offset_days}` : '—') }], rowActions: isAdmin ? () => btn('edit', 'Edit') + btn('del', 'Delete', 'btn-danger') : null });
    main.append(subCard, tCard, mCard, aCard);
    const tf = [{ name: 'name', label: 'Name', required: true }, { name: 'target_role', label: 'Target role' }, { name: 'description', label: 'Description', type: 'textarea', span2: true }, { name: 'active', label: 'Active', type: 'checkbox' }];
    const mf = async () => [{ name: 'track_id', label: 'Track', type: 'select', options: await trackOpts('—') }, { name: 'title', label: 'Title', required: true }, { name: 'position', label: 'Order', type: 'number', min: 0 }, { name: 'week_number', label: 'Week', type: 'number', min: 0 }, { name: 'description', label: 'Description', type: 'textarea', span2: true }];
    const af = [{ name: 'module_id', label: 'Module', type: 'select', options: opt(modules, 'id', (m) => `${m.track_name} — ${m.title}`) }, { name: 'title', label: 'Title', required: true }, { name: 'position', label: 'Order', type: 'number', min: 0 }, { name: 'due_offset_days', label: 'Due (days after enrolment)', type: 'number', min: 0 }, { name: 'instructions', label: 'Instructions', type: 'textarea', span2: true, rows: 6 }];
    const save = (url, method, fields, values, title) => formModal({ eyebrow: 'Syllabus', title, fields, values, onSave: (b) => api(url, { method, body: b }) }).then(() => { toast('Saved'); refresh(); });
    main.querySelector('[data-nt]')?.addEventListener('click', () => save('/api/admin/tracks', 'POST', tf, { active: true }, 'New <em>track</em>'));
    main.querySelector('[data-nm]')?.addEventListener('click', async () => save('/api/admin/modules', 'POST', await mf(), {}, 'New <em>module</em>'));
    main.querySelector('[data-na]')?.addEventListener('click', () => save('/api/admin/assignments', 'POST', af, {}, 'New <em>assignment</em>'));
    onAct(tCard, { edit: (i) => save(`/api/admin/tracks/${i}`, 'PATCH', tf, tracks.find((t) => t.id === i), 'Edit <em>track</em>') });
    onAct(mCard, { edit: async (i) => save(`/api/admin/modules/${i}`, 'PATCH', await mf(), modules.find((t) => t.id === i), 'Edit <em>module</em>'), del: async (i) => { if (await confirmBox('Delete module?', 'Its assignments and progress go too.', { danger: true, ok: 'Delete' })) { await api(`/api/admin/modules/${i}`, { method: 'DELETE' }); refresh(); } } });
    onAct(aCard, { edit: (i) => save(`/api/admin/assignments/${i}`, 'PATCH', af, assignments.find((t) => t.id === i), 'Edit <em>assignment</em>'), del: async (i) => { if (await confirmBox('Delete assignment?', 'Student progress on it is removed.', { danger: true, ok: 'Delete' })) { await api(`/api/admin/assignments/${i}`, { method: 'DELETE' }); refresh(); } } });
    onAct(subCard, { review: async (key) => {
      const s = subs.find((x) => `${x.student_id}-${x.assignment_id}` === key);
      await formModal({ eyebrow: 'Review', title: `${esc(s.student_name)} — ${esc(s.assignment_title)}`, intro: `<div class="doc-text mb-2">${esc(s.submission)}</div>`,
        fields: [{ name: 'status', label: 'Result', type: 'select', options: [['reviewed', 'Reviewed'], ['done', 'Done'], ['in_progress', 'Needs another pass']] }, { name: 'feedback', label: 'Feedback to the student', type: 'textarea', span2: true }],
        onSave: (b) => api('/api/admin/submissions/review', { method: 'POST', body: { ...b, student_id: s.student_id, assignment_id: s.assignment_id } }) });
      toast('Reviewed'); refresh();
    } });
  }

  // ══ Resume services ═════════════════════════════════════════════════
  async function services() {
    const rows = await api('/api/admin/cases');
    setCount('services', rows.filter((c) => !['delivered', 'closed', 'cancelled'].includes(c.status)).length);
    main.innerHTML = pageHead('Delivery', 'Resume <em>services</em>', 'Intake → coach → draft → coach edit → QA → your approval → delivery → revision. Nothing reaches a student without QA and your approval.',
      isAdmin ? '<button class="btn btn-ghost" data-pb>Playbook</button><button class="btn btn-primary" data-new>+ Open case</button>' : '');
    const card = tableCard({
      rows, search: (c) => `${c.student_name} ${c.coach_name || ''} ${c.kind}`, filter: { key: 'status', options: ['intake', 'assigned', 'first_draft', 'coach_edit', 'qa', 'delivered', 'revision', 'closed'].map((s) => [s, label(s)]) },
      columns: [
        { h: 'Student', cls: 'strong', render: (c) => `${esc(c.student_name)}<span class="sub-line">${esc(label(c.kind))}${c.product_name ? ` · ${esc(c.product_name)}` : ''}</span>` },
        { h: 'Coach', render: (c) => esc(c.coach_name || 'Unassigned') },
        { h: 'Due', render: (c) => `<span class="${c.due_at && new Date(c.due_at) < new Date() && !['delivered', 'closed'].includes(c.status) ? 'due' : ''}">${esc(c.due_at ? d(c.due_at) : '—')}</span>` },
        { h: 'Status', render: (c) => statusPill(c.status) + (c.last_qa ? `<span class="sub-line">Last QA: ${esc(label(c.last_qa))}</span>` : '') + `<span class="sub-line">Playbook ${esc(c.playbook_version || '—')}</span>` },
      ],
      rowActions: (c) => btn('assign', c.coach_name ? 'Reassign' : 'Assign coach') + (isAdmin ? btn('open', 'Open') : '') + (isAdmin && c.status === 'delivered' ? btn('close', 'Close') : ''),
    });
    main.appendChild(card);
    main.querySelector('[data-new]')?.addEventListener('click', async () => {
      await formModal({ eyebrow: 'New case', title: 'Open a <em>case</em>', fields: [
        { name: 'student_id', label: 'Student', type: 'select', options: await studentOpts(), span2: true },
        { name: 'kind', label: 'Service', type: 'select', options: [['resume_rewrite', 'Resume rewrite'], ['linkedin_rewrite', 'LinkedIn rewrite'], ['coaching_package', 'Coaching package']] },
        { name: 'due_at', label: 'Due', type: 'datetime' }, { name: 'revisions_allowed', label: 'Revisions included', type: 'number', min: 0, max: 10 },
      ], values: { revisions_allowed: 1 }, onSave: (b) => api('/api/admin/cases', { method: 'POST', body: b }) });
      toast('Case opened'); refresh();
    });
    main.querySelector('[data-pb]')?.addEventListener('click', playbookModal);
    onAct(card, {
      open: (i) => A.openCase(i, { isAdmin, onChange: refresh }),
      close: async (i) => { await api(`/api/admin/cases/${i}/close`, { method: 'POST', body: {} }); refresh(); },
      assign: async (i) => {
        const c = rows.find((x) => x.id === i);
        const sugg = await api(`/api/admin/mentors-suggest?q=${encodeURIComponent(c.kind.replace('_', ' '))}`);
        await formModal({ eyebrow: 'Coach assignment', title: esc(c.student_name),
          intro: `<p class="hint mb-2">Ranked by expertise match, then spare capacity.</p>`,
          fields: [
            { name: 'coach_mentor_id', label: 'Coach', type: 'select', options: sugg.map((m) => [m.id, `${m.name} — ${m.spare} free of ${m.capacity}${m.match ? ' · expertise match' : ''}`]), span2: true },
            { name: 'due_at', label: 'Due', type: 'datetime' },
            ...(isAdmin ? [{ name: 'coach_fee_paise', label: 'Coach fee for this case', type: 'money' }] : []),
          ], onSave: (b) => api(`/api/admin/cases/${i}/assign`, { method: 'POST', body: b }) });
        toast('Coach assigned'); refresh();
      },
    });
  }
  async function playbookModal() {
    const pbs = await api('/api/admin/playbooks');
    const ui = modal(`<div class="eyebrow">Resume Strategy Playbook</div><h2 class="h2 mb-2">Playbook <em>versions</em></h2>
      <p class="hint mb-2">Versions are immutable. The active version is the drafting rubric for new cases; each case records which version it used.</p>
      <ul class="list">${pbs.map((p) => `<li><span class="strong">${esc(p.version_label)} ${p.is_active ? '<span class="pill ok">Active</span>' : ''}<span class="sub-line">${p.case_count} cases · ${esc(d(p.created_at))}</span></span>
        <span class="row">${p.file_version_id ? `<button class="btn btn-ghost btn-sm" data-open="${p.file_version_id}">File</button>` : ''}${p.is_active ? '' : `<button class="btn btn-ghost btn-sm" data-activate="${p.id}">Activate</button>`}</span></li>`).join('') || '<li class="muted">No versions yet.</li>'}</ul>
      <form novalidate class="mt-2"><div class="form-error" hidden></div><div class="section-label">New version</div><div class="form-grid">
        <div class="field"><label class="label">Version label</label><input class="input" name="version_label" placeholder="v1.1" required></div>
        <div class="field"><label class="label">Playbook file (optional, private)</label><input class="input" type="file" name="file" accept=".pdf,.doc,.docx,.txt"></div>
        <div class="field span-2"><label class="label">Drafting rubric (used by coaches and QA)</label><textarea class="input" name="rubric_text" rows="8" required></textarea></div>
        <div class="field span-2"><label class="label">Change notes</label><input class="input" name="notes"></div></div>
        <div class="row"><button class="btn btn-primary btn-sm" type="submit">Save version</button></div></form>`, { wide: true });
    ui.el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => A.openFile(b.dataset.open)));
    ui.el.querySelectorAll('[data-activate]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/admin/playbooks/${b.dataset.activate}/activate`, { method: 'POST', body: {} }); ui.close(); toast('Activated'); playbookModal(); }));
    onSubmit(ui.el.querySelector('form'), async (dta) => {
      const f = ui.el.querySelector('input[type=file]').files[0];
      let document_id = null;
      if (f) document_id = (await A.upload(f, { kind: 'playbook', title: `Playbook ${dta.version_label}` })).document_id;
      await api('/api/admin/playbooks', { method: 'POST', body: { version_label: dta.version_label, rubric_text: dta.rubric_text, notes: dta.notes, document_id } });
      ui.close(); toast('Playbook version saved'); playbookModal();
    });
  }

  // ══ Subscriptions ═══════════════════════════════════════════════════
  async function subscriptions() {
    const rows = await api('/api/admin/subscriptions');
    main.innerHTML = pageHead('Members', 'Subscriptions', 'Access (what the student can use) is separate from billing (what has been paid). Grace periods keep access while a renewal is sorted.');
    const card = tableCard({
      rows, search: (x) => `${x.student_name} ${x.plan_name}`, filter: { value: (x) => x.effective_access, options: [['active', 'Active'], ['grace', 'Grace'], ['paused', 'Paused'], ['cancelled', 'Cancelled'], ['expired', 'Expired']] },
      columns: [
        { h: 'Student', cls: 'strong', render: (x) => `${esc(x.student_name)}<span class="sub-line">${esc(x.plan_name)}${x.price_paise != null ? ` · ${inr(x.price_paise)}/${esc(x.billing_period)}` : ''}</span>` },
        { h: 'Access', render: (x) => statusPill(x.effective_access) + (x.cancel_at_period_end ? '<span class="sub-line">Cancels at period end</span>' : '') },
        { h: 'Billing', render: (x) => statusPill(x.billing_status) },
        { h: 'Paid through', render: (x) => `${esc(d(x.paid_through))}<span class="sub-line">Grace until ${esc(x.grace_until ? d(x.grace_until) : '—')}</span>` },
      ],
      rowActions: isAdmin ? (x) => btn('act', 'Manage') : null,
    });
    main.appendChild(card);
    onAct(card, { act: async (i) => {
      const x = rows.find((r) => r.id === i);
      await formModal({ eyebrow: 'Subscription', title: `${esc(x.student_name)} — ${esc(x.plan_name)}`, fields: [
        { name: 'action', label: 'Action', type: 'select', options: [['extend', 'Set paid-through date (complimentary / offline payment)'], ['pause', 'Pause access'], ['resume', 'Resume access'], ['cancel_at_period_end', 'Cancel at period end'], ['undo_cancel', 'Undo cancellation'], ['cancel_now', 'Cancel now'], ['waive', 'Mark billing waived']], span2: true },
        { name: 'paid_through', label: 'Paid through (for “set date”)', type: 'datetime', span2: true },
      ], values: { paid_through: x.paid_through }, submit: 'Apply', onSave: (b) => api(`/api/admin/subscriptions/${i}/action`, { method: 'POST', body: b }) });
      toast('Updated'); refresh();
    } });
  }

  // ══ Catalogue (admin) ═══════════════════════════════════════════════
  const KIND_OPTS = [['subscription_plan', 'Subscription plan'], ['resume_service', 'Resume rewrite'], ['linkedin_service', 'LinkedIn rewrite'], ['coaching_package', 'Coaching package'], ['digital_product', 'Digital product']];
  const ENT = [['syllabus', 'Structured syllabus & assignments', false], ['progress_tracking', 'Progress tracking', false], ['community', 'Shortlist Club community', false],
    ['live_class', 'Live online classes', true], ['mentor_room', 'Small-group mentor rooms', true], ['checkup_call', '1:1 check-up calls', true], ['paid_session_discount', 'Discount on paid sessions (notes)', false]];
  async function catalog() {
    const rows = await api('/api/admin/products');
    main.innerHTML = pageHead('Admin', 'Plans &amp; <em>products</em>', 'Prices, billing periods and what each plan includes. Counted sessions always need a number — nothing is unlimited.', '<button class="btn btn-primary" data-new>+ Product</button>');
    const card = tableCard({
      rows, filter: { key: 'kind', options: KIND_OPTS },
      columns: [
        { h: 'Product', cls: 'strong', render: (p) => `${esc(p.name)}${p.active ? '' : ' <span class="pill off">Hidden</span>'}<span class="sub-line">${esc(label(p.kind))}</span>` },
        { h: 'Price', render: (p) => `${inr(p.price_paise)}<span class="sub-line">${p.billing_period === 'one_time' ? 'One-time' : `per ${esc(label(p.billing_period))}`}</span>` },
        { h: 'Includes', render: (p) => `<div class="chips">${p.entitlements.map((e) => `<span class="chip on">${esc(label(e.key))}${e.limit_count != null ? ` · ${e.limit_count}/${esc(e.per_period.replace('_', ' '))}` : ''}</span>`).join('') || '<span class="muted small">—</span>'}</div>` },
      ],
      rowActions: (p) => btn('edit', 'Edit') + (p.kind === 'subscription_plan' ? btn('ent', 'Entitlements') : '') + (p.kind === 'digital_product' ? btn('file', 'Upload file') : ''),
    });
    main.appendChild(card);
    const pf = (isNew) => [
      ...(isNew ? [{ name: 'kind', label: 'Type', type: 'select', options: KIND_OPTS }] : []),
      { name: 'name', label: 'Name', required: true }, { name: 'price_paise', label: 'Price', type: 'money', required: true },
      { name: 'billing_period', label: 'Billing period (plans)', type: 'select', options: [['one_time', 'One-time'], ['week', 'Weekly'], ['month', 'Monthly'], ['quarter', 'Quarterly'], ['half_year', 'Every 6 months'], ['year', 'Yearly']] },
      { name: 'description', label: 'Description', type: 'textarea', span2: true }, { name: 'active', label: 'Visible to students', type: 'checkbox' },
    ];
    main.querySelector('[data-new]').addEventListener('click', async () => { await formModal({ eyebrow: 'New product', title: 'Add a <em>product</em>', fields: pf(true), values: { active: true, billing_period: 'month' }, onSave: (b) => api('/api/admin/products', { method: 'POST', body: b }) }); toast('Saved'); refresh(); });
    onAct(card, {
      edit: async (i) => { await formModal({ eyebrow: 'Edit product', title: esc(rows.find((p) => p.id === i).name), fields: pf(false), values: rows.find((p) => p.id === i), onSave: (b) => api(`/api/admin/products/${i}`, { method: 'PATCH', body: b }) }); toast('Saved'); refresh(); },
      file: (i) => {
        const inp = document.createElement('input'); inp.type = 'file';
        inp.onchange = async () => { try { const u = await A.upload(inp.files[0], { kind: 'digital_product', title: rows.find((p) => p.id === i).name }); await api(`/api/admin/products/${i}`, { method: 'PATCH', body: { digital_document_id: u.document_id } }); toast('File attached'); } catch (e) { toast(e.message, true); } };
        inp.click();
      },
      ent: async (i) => {
        const p = rows.find((x) => x.id === i);
        const cur = Object.fromEntries(p.entitlements.map((e) => [e.key, e]));
        const ui = modal(`<div class="eyebrow">Entitlements</div><h2 class="h2 mb-2">${esc(p.name)}</h2>
          <form novalidate><div class="form-error" hidden></div><table><thead><tr><th>Included</th><th>Benefit</th><th>Limit</th><th>Per</th></tr></thead><tbody>
          ${ENT.map(([k, l, counted]) => `<tr><td><input type="checkbox" name="on-${k}"${cur[k] ? ' checked' : ''}></td><td>${esc(l)}</td>
            <td><input class="input" type="number" min="0" max="1000" name="lim-${k}" value="${cur[k]?.limit_count ?? ''}" ${counted ? 'placeholder="required"' : 'placeholder="—"'}></td>
            <td><select class="input" name="per-${k}">${[['week', 'week'], ['month', 'month'], ['billing_period', 'billing period'], ['total', 'total']].map(([v, l2]) => `<option value="${v}"${(cur[k]?.per_period || 'month') === v ? ' selected' : ''}>${l2}</option>`).join('')}</select></td></tr>`).join('')}
          </tbody></table><p class="hint mt-1">Check-up limits are enforced when students book. Class/room limits guide scheduling.</p>
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div></form>`, { wide: true });
        onSubmit(ui.el.querySelector('form'), async (dta) => {
          const entitlements = ENT.filter(([k]) => dta[`on-${k}`]).map(([k]) => ({ key: k, limit_count: dta[`lim-${k}`], per_period: dta[`per-${k}`] }));
          await api(`/api/admin/products/${i}/entitlements`, { method: 'PUT', body: { entitlements } }); ui.close(); toast('Entitlements saved'); refresh();
        });
      },
    });
  }

  // ══ Payments (admin) ════════════════════════════════════════════════
  async function payments() {
    const [orders, pays, refunds] = await Promise.all([api('/api/admin/orders'), api('/api/admin/payments'), api('/api/admin/refunds')]);
    const gross = pays.filter((p) => ['paid', 'refunded'].includes(p.status)).reduce((a, p) => a + p.amount_paise, 0);
    const fees = pays.reduce((a, p) => a + p.fee_paise + p.tax_paise, 0);
    main.innerHTML = pageHead('Admin', 'Payments', 'Orders, payments, refunds and gateway costs (Anvaya’s expense).', '<button class="btn btn-primary" data-new>+ Manual order</button>')
      + `<div class="stats reveal">${stat(inr(gross), 'Collected')}${stat(inr(refunds.reduce((a, r) => a + r.amount_paise, 0)), 'Refunded')}${stat(inr(fees), 'Gateway fees + GST')}${stat(orders.filter((o) => o.status === 'created').length, 'Unpaid orders')}</div>`;
    const oCard = tableCard({ title: 'Orders', rows: orders, search: (o) => `${o.student_name} ${o.description} ${o.product_name || ''}`, filter: { key: 'status', options: [['created', 'Unpaid'], ['paid', 'Paid'], ['failed', 'Failed'], ['cancelled', 'Cancelled'], ['refunded', 'Refunded'], ['partially_refunded', 'Part-refunded']] },
      columns: [{ h: 'Order', cls: 'strong', render: (o) => `#${o.id} ${esc(o.student_name)}<span class="sub-line">${esc(o.product_name || o.description)}</span>` }, { h: 'Amount', render: (o) => `${inr(o.amount_paise)}<span class="sub-line">${esc(o.provider)}</span>` }, { h: 'Created', render: (o) => esc(dt(o.created_at)) }, { h: 'Status', render: (o) => statusPill(o.status) }],
      rowActions: (o) => (o.status === 'created' ? btn('record', 'Record payment') + btn('cancel', 'Cancel', 'btn-danger') : '') });
    const pCard = tableCard({ title: 'Payments', rows: pays, search: (p) => `${p.student_name} ${p.reference} ${p.provider_payment_id || ''}`,
      columns: [{ h: 'Student', cls: 'strong', render: (p) => `${esc(p.student_name)}<span class="sub-line">${esc(p.order_description || '')}</span>` }, { h: 'Amount', render: (p) => `${inr(p.amount_paise)}${p.refunded_paise ? `<span class="sub-line">−${inr(p.refunded_paise)} refunded</span>` : ''}` },
        { h: 'Method', render: (p) => `${esc(p.method)}<span class="sub-line mono">${esc(p.provider_payment_id || p.reference || '')}</span>` }, { h: 'Gateway cost', render: (p) => inr(p.fee_paise + p.tax_paise) }, { h: 'Paid', render: (p) => `${esc(dt(p.paid_at || p.created_at))}<span class="sub-line">${statusPill(p.status)}</span>` }],
      rowActions: (p) => (p.amount_paise - p.refunded_paise > 0 ? btn('refund', 'Refund', 'btn-danger') : '') + btn('fees', 'Fees') });
    main.append(oCard, pCard);
    main.querySelector('[data-new]').addEventListener('click', async () => {
      const products = await api('/api/admin/products');
      await formModal({ eyebrow: 'Manual order', title: 'Create an <em>order</em>', intro: '<p class="hint mb-2">For UPI / bank transfers / college invoices. Record the payment once received — that grants the plan or opens the service case.</p>',
        fields: [{ name: 'student_id', label: 'Student', type: 'select', options: await studentOpts(), span2: true }, { name: 'product_id', label: 'Product', type: 'select', options: opt(products.filter((p) => p.active), 'id', (p) => `${p.name} — ${inr(p.price_paise)}`), span2: true }, { name: 'amount_paise', label: 'Amount (blank = list price)', type: 'money' }],
        onSave: (b) => api('/api/admin/orders', { method: 'POST', body: b }) });
      toast('Order created'); refresh();
    });
    onAct(oCard, {
      record: async (i) => { const o = orders.find((x) => x.id === i); await formModal({ eyebrow: 'Record payment', title: `Order #${i} — ${inr(o.amount_paise)}`, fields: [{ name: 'amount_paise', label: 'Amount received', type: 'money' }, { name: 'method', label: 'Method' }, { name: 'reference', label: 'Reference / UTR' }, { name: 'paid_at', label: 'Received on', type: 'datetime' }, { name: 'fee_paise', label: 'Fees deducted (if any)', type: 'money' }], values: { amount_paise: o.amount_paise, method: 'UPI', paid_at: new Date().toISOString() }, onSave: (b) => api(`/api/admin/orders/${i}/record-payment`, { method: 'POST', body: b }) }); toast('Payment recorded'); refresh(); },
      cancel: async (i) => { if (await confirmBox('Cancel order?', 'Any held booking is released.', { danger: true, ok: 'Cancel order' })) { await api(`/api/admin/orders/${i}/cancel`, { method: 'POST', body: {} }); refresh(); } },
    });
    onAct(pCard, {
      refund: async (i) => { const p = pays.find((x) => x.id === i); await formModal({ eyebrow: 'Refund', title: `${esc(p.student_name)} — up to ${inr(p.amount_paise - p.refunded_paise)}`, intro: p.provider === 'razorpay' ? '<p class="hint mb-2">Sent to Razorpay immediately. If the session was already completed, the mentor’s ledger is adjusted.</p>' : '<p class="hint mb-2">Records a refund you made outside the gateway.</p>', fields: [{ name: 'amount_paise', label: 'Refund amount', type: 'money', required: true }, { name: 'reason', label: 'Reason', required: true }, { name: 'cancel_booking', label: 'Cancel the linked booking if not yet held', type: 'checkbox' }], values: { amount_paise: p.amount_paise - p.refunded_paise, cancel_booking: true }, onSave: (b) => api(`/api/admin/payments/${i}/refund`, { method: 'POST', body: b }) }); toast('Refund recorded'); refresh(); },
      fees: async (i) => { const p = pays.find((x) => x.id === i); await formModal({ eyebrow: 'Gateway cost', title: esc(p.student_name), fields: [{ name: 'fee_paise', label: 'Gateway fee', type: 'money' }, { name: 'tax_paise', label: 'GST on fee', type: 'money' }], values: p, onSave: (b) => api(`/api/admin/payments/${i}`, { method: 'PATCH', body: b }) }); toast('Saved'); refresh(); },
    });
  }

  // ══ Mentor payables (admin) ═════════════════════════════════════════
  async function payables() {
    const rows = await api('/api/admin/payables');
    main.innerHTML = pageHead('Admin', 'Mentor <em>payables</em>', 'Private-session earnings (zero commission), delivery fees for classes/rooms/check-ups, coach fees, refund adjustments and manual payouts.');
    const card = tableCard({ rows, columns: [
      { h: 'Mentor', cls: 'strong', render: (m) => `${esc(m.name)}<span class="sub-line">${esc(label(m.status))}</span>` },
      { h: 'Private sessions', render: (m) => `${inr(m.earned_sessions)}<span class="sub-line">${m.completed_sessions} completed</span>` },
      { h: 'Delivery + coach fees', render: (m) => inr(m.delivery_fees + m.service_fees) },
      { h: 'Adjustments', render: (m) => inr(m.adjustments) }, { h: 'Paid out', render: (m) => inr(m.paid_out) },
      { h: 'Payable now', render: (m) => `<span class="strong">${inr(m.payable)}</span>` },
    ], rowActions: (m) => btn('ledger', 'Ledger') + (m.payable > 0 ? btn('pay', 'Record payout', 'btn-primary') : '') + btn('adj', 'Adjust') });
    main.appendChild(card);
    onAct(card, {
      ledger: async (i) => {
        const l = await api(`/api/admin/mentors/${i}/ledger`);
        modal(`<div class="eyebrow">Ledger</div><h2 class="h2 mb-2">${esc(rows.find((m) => m.id === i).name)} — payable ${inr(l.balance.payable)}</h2>
          <div class="table-wrap"><table><thead><tr><th>Date</th><th>Entry</th><th>Amount</th></tr></thead><tbody>${l.entries.map((e) => `<tr><td>${esc(d(e.created_at))}</td><td>${esc(label(e.kind))}<span class="sub-line">${esc(e.note)}${e.student_name ? ` · ${esc(e.student_name)}` : ''}</span></td><td class="${e.amount_paise < 0 ? 'due' : 'strong'}">${inr(e.amount_paise)}</td></tr>`).join('')}</tbody></table></div>`, { wide: true });
      },
      pay: async (i) => { const m = rows.find((x) => x.id === i); await formModal({ eyebrow: 'Manual payout', title: `${esc(m.name)} — payable ${inr(m.payable)}`, intro: '<p class="hint mb-2">Record a payout you’ve already made (no money moves from here).</p>', fields: [{ name: 'amount_paise', label: 'Amount paid', type: 'money', required: true }, { name: 'method', label: 'Method' }, { name: 'reference', label: 'UTR / reference' }, { name: 'paid_at', label: 'Paid on', type: 'datetime' }], values: { amount_paise: m.payable, method: 'UPI', paid_at: new Date().toISOString() }, onSave: (b) => api(`/api/admin/mentors/${i}/payouts`, { method: 'POST', body: b }) }); toast('Payout recorded'); refresh(); },
      adj: async (i) => { await formModal({ eyebrow: 'Adjustment', title: esc(rows.find((x) => x.id === i).name), fields: [{ name: 'amount_rupees', label: 'Amount in ₹ (negative to deduct)', type: 'number', step: '0.01', required: true }, { name: 'note', label: 'Reason', required: true, span2: true }], onSave: (b) => api(`/api/admin/mentors/${i}/adjustments`, { method: 'POST', body: { amount_paise: Math.round(Number(b.amount_rupees) * 100), note: b.note } }) }); toast('Adjusted'); refresh(); },
    });
  }

  // ══ Colleges & cohorts ══════════════════════════════════════════════
  async function cohorts() {
    const [cols, cohs] = await Promise.all([api('/api/admin/colleges'), get('cohorts', '/api/admin/cohorts')]);
    main.innerHTML = pageHead('B2B', 'Colleges &amp; <em>cohorts</em>', 'Batch enrolment and cohort reporting. (The college coordinator portal comes after the pilot.)',
      isAdmin ? '<button class="btn btn-ghost" data-col>+ College</button><button class="btn btn-primary" data-coh>+ Cohort</button>' : '');
    const kCard = tableCard({ title: 'Cohorts', rows: cohs, columns: [
      { h: 'Cohort', cls: 'strong', render: (k) => `${esc(k.name)}<span class="sub-line">${esc(k.college_name || 'Direct')}</span>` }, { h: 'Track', render: (k) => esc(k.track_name || '—') },
      { h: 'Dates', render: (k) => `${esc(k.starts_on || '—')} → ${esc(k.ends_on || '—')}` }, { h: 'Members', render: (k) => k.member_count }],
      rowActions: () => btn('report', 'Report') + (isAdmin ? btn('add', 'Add students') : '') });
    const cCard = tableCard({ title: 'Colleges', rows: cols, columns: [{ h: 'College', cls: 'strong', render: (c) => `${esc(c.name)}<span class="sub-line">${esc(c.city)}</span>` }, { h: 'Cohorts', render: (c) => c.cohort_count }] });
    main.append(kCard, cCard);
    main.querySelector('[data-col]')?.addEventListener('click', async () => { await formModal({ eyebrow: 'College', title: 'Add a <em>college</em>', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'city', label: 'City' }, { name: 'notes', label: 'Placement cell contact / notes', type: 'textarea', span2: true }], onSave: (b) => api('/api/admin/colleges', { method: 'POST', body: b }) }); refresh(); });
    main.querySelector('[data-coh]')?.addEventListener('click', async () => { await formModal({ eyebrow: 'Cohort', title: 'Add a <em>cohort</em>', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'college_id', label: 'College', type: 'select', options: opt(cols, 'id', 'name', 'None (direct)') }, { name: 'track_id', label: 'Assigned syllabus track', type: 'select', options: await trackOpts() }, { name: 'starts_on', label: 'Starts', type: 'date' }, { name: 'ends_on', label: 'Ends', type: 'date' }], onSave: (b) => api('/api/admin/cohorts', { method: 'POST', body: b }) }); refresh(); });
    onAct(kCard, {
      report: async (i) => { const r = await api(`/api/admin/cohorts/${i}/report`); modal(`<div class="eyebrow">Cohort report</div><h2 class="h2 mb-2">${esc(cohs.find((k) => k.id === i).name)}</h2><div class="table-wrap"><table><thead><tr><th>Student</th><th>Attendance</th><th>Assignments</th><th>Positive outcomes</th></tr></thead><tbody>${r.map((s) => `<tr><td class="strong">${esc(s.name)}</td><td>${s.attended}/${s.marked}</td><td>${s.assignments_done}</td><td>${s.positive_outcomes}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No members.</td></tr>'}</tbody></table></div>`, { wide: true }); },
      add: async (i) => {
        const ss = cache.students || await get('students', '/api/admin/students');
        const ui = modal(`<div class="eyebrow">Batch enrolment</div><h2 class="h2 mb-2">Add students</h2><form novalidate><div class="form-error" hidden></div><div class="slot-grid">${ss.map((s) => `<label class="check"><input type="checkbox" name="s" value="${s.id}"> <span>${esc(s.name)}</span></label>`).join('')}</div><div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Enrol</button></div></form>`, { wide: true });
        onSubmit(ui.el.querySelector('form'), async () => { const student_ids = [...ui.el.querySelectorAll('input[name=s]:checked')].map((x) => Number(x.value)); const r = await api(`/api/admin/cohorts/${i}/members`, { method: 'POST', body: { student_ids } }); ui.close(); toast(`${r.added} enrolled`); refresh(); });
      },
    });
  }

  // ══ Reports ═════════════════════════════════════════════════════════
  async function reports() {
    const r = await api('/api/admin/reports');
    const e = r.engagement;
    const rate = e.attendance30d.marked ? Math.round((e.attendance30d.attended / e.attendance30d.marked) * 100) : 0;
    main.innerHTML = pageHead('Insights', 'Reports', 'Engagement, renewals and outcomes.') + `
      <div class="stats reveal">${stat(`${rate}%`, 'Attendance (30 days)')}${stat(e.activeLearners30d, 'Active learners (30 days)')}${stat(e.assignmentsDone30d, 'Assignments submitted (30 days)')}${stat(e.feedbackAvg.avg ?? '—', `Avg feedback (${e.feedbackAvg.n})`)}</div>
      ${r.renewals ? `<div class="stats reveal">${stat(r.renewals.dueIn14d, 'Renewals due (14 days)')}${stat(r.renewals.inGrace, 'In grace')}${stat(r.renewals.expired30d, 'Expired (30 days)')}${stat(r.renewals.renewedLast90d, 'Renewed (90 days)')}</div>` : ''}
      <div class="grid-2 reveal"><div class="card"><div class="card-head"><h2 class="h2">Outcomes</h2></div><ul class="list">${r.outcomes.map((o) => `<li><span>${statusPill(o.stage)}</span><span class="strong">${o.n} <span class="muted small">(${o.students} students)</span></span></li>`).join('') || '<li class="muted">No applications reported yet.</li>'}</ul></div>
      ${r.revenueByMonth ? `<div class="card"><div class="card-head"><h2 class="h2">Revenue by month</h2></div><ul class="list">${r.revenueByMonth.map((m) => `<li><span>${esc(m.month)}<span class="sub-line muted small">${m.payments} payments · gateway ${inr(m.gateway_paise)}</span></span><span class="strong">${inr(m.gross_paise)}</span></li>`).join('') || '<li class="muted">No payments yet.</li>'}</ul></div>` : ''}</div>`;
  }

  // ══ Team, settings, system (admin) ══════════════════════════════════
  async function team() {
    const rows = await api('/api/admin/team');
    main.innerHTML = pageHead('Admin', 'Team', 'Admins have full access. Operations (interns) handle scheduling, reminders, attendance and follow-ups — no financial settings, payments, sensitive notes or admin privileges.', '<button class="btn btn-primary" data-new>+ Add team member</button>');
    const card = tableCard({ rows, columns: [
      { h: 'Person', cls: 'strong', render: (u) => `${esc(u.name || u.email)}<span class="sub-line">${esc(u.email)}</span>` }, { h: 'Role', render: (u) => esc(u.role === 'ops' ? 'Operations' : 'Admin') },
      { h: 'Status', render: (u) => (u.disabled_at ? statusPill('deactivated') : u.has_password ? statusPill('active') : statusPill('invite_pending')) }, { h: 'Last sign-in', render: (u) => esc(u.last_login_at ? dt(u.last_login_at) : '—') },
    ], rowActions: (u) => (u.id === me.user.id ? '' : (u.disabled_at ? btn('enable', 'Enable') : btn('resend', u.has_password ? 'Send reset link' : 'Resend invite') + btn('disable', 'Disable', 'btn-danger'))) });
    main.appendChild(card);
    main.querySelector('[data-new]').addEventListener('click', async () => { await formModal({ eyebrow: 'Team', title: 'Add a <em>team member</em>', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'role', label: 'Role', type: 'select', options: [['ops', 'Operations (intern)'], ['admin', 'Admin']] }], submit: 'Add & send invite', onSave: (b) => api('/api/admin/team', { method: 'POST', body: b }) }); toast('Invite sent'); refresh(); });
    onAct(card, {
      resend: async (i) => { const r = await api(`/api/admin/team/${i}/resend`, { method: 'POST', body: {} }); toast(r.delivered ? 'Email sent' : `Queued: ${r.mailError}`, !r.delivered); },
      disable: async (i) => { if (await confirmBox('Disable account?', 'They’re signed out immediately.', { danger: true, ok: 'Disable' })) { await api(`/api/admin/team/${i}/disable`, { method: 'POST', body: {} }); refresh(); } },
      enable: async (i) => { await api(`/api/admin/team/${i}/enable`, { method: 'POST', body: {} }); refresh(); },
    });
  }
  async function settingsPage() {
    const [s, team] = await Promise.all([api('/api/admin/settings'), api('/api/admin/team')]);
    main.innerHTML = pageHead('Admin', 'Settings', 'Configurable defaults. Nothing here is hard-coded elsewhere.') + `<div class="card card-pad reveal"><form novalidate><div class="form-error" hidden></div><div class="form-grid">
      ${A.fieldHtml({ name: 'group_capacity_default', label: 'Default group capacity', type: 'number', min: 1 }, s.group_capacity_default)}
      ${A.fieldHtml({ name: 'subscription_grace_days', label: 'Grace period after paid-through (days)', type: 'number', min: 0 }, s.subscription_grace_days)}
      ${A.fieldHtml({ name: 'renewal_reminder_days', label: 'Renewal reminders (days before, comma-separated)' }, (s.renewal_reminder_days || []).join(', '))}
      ${A.fieldHtml({ name: 'booking_hold_minutes', label: 'Payment hold on a slot (minutes)', type: 'number', min: 1 }, s.booking_hold_minutes)}
      ${A.fieldHtml({ name: 'booking_min_notice_hours', label: 'Minimum booking notice (hours)', type: 'number', min: 0 }, s.booking_min_notice_hours)}
      ${A.fieldHtml({ name: 'booking_window_days', label: 'How far ahead students can book (days)', type: 'number', min: 1 }, s.booking_window_days)}
      ${A.fieldHtml({ name: 'booking_request_hold_hours', label: 'Hold a requested slot while awaiting approval (hours)', type: 'number', min: 1 }, s.booking_request_hold_hours)}
      ${A.fieldHtml({ name: 'booking_payment_hours', label: 'Time to pay after approval (hours)', type: 'number', min: 1 }, s.booking_payment_hours)}
      ${A.fieldHtml({ name: 'reschedule_cutoff_hours', label: 'Self-service reschedule/cancel until (hours before start)', type: 'number', min: 0 }, s.reschedule_cutoff_hours)}
      ${A.fieldHtml({ name: 'noshow_grace_minutes', label: 'No-show can be confirmed after (minutes past start)', type: 'number', min: 0 }, s.noshow_grace_minutes)}
      ${A.fieldHtml({ name: 'calendar_host_user_id', label: 'Fallback Google Calendar host', type: 'select', options: [['', 'None — only connected mentors'], ...team.map((u) => [u.id, `${u.name || u.email} (${u.role})`])], hint: 'Hosts the event + Meet link when the mentor hasn’t connected Google Calendar. That person must connect it on the Calendar page.' }, s.calendar_host_user_id ?? '')}
      ${A.fieldHtml({ name: 'commission_percent', label: 'Commission on private sessions (%)', type: 'number', min: 0, hint: 'Currently 0 — the full fee is owed to the mentor.', disabled: true }, s.commission_percent)}
      </div><button class="btn btn-primary" type="submit">Save settings</button></form></div>`;
    onSubmit(main.querySelector('form'), async (dta) => {
      const body = { ...dta, renewal_reminder_days: String(dta.renewal_reminder_days).split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x)) };
      await api('/api/admin/settings', { method: 'PUT', body }); toast('Settings saved');
    });
  }
  async function system() {
    const s = await api('/api/admin/system');
    const ok = (b) => (b ? '<span class="pill ok">Connected</span>' : '<span class="pill bad">Not configured</span>');
    main.innerHTML = pageHead('Admin', 'System <em>health</em>', 'Integrations, background jobs and payment webhooks.', '<button class="btn btn-ghost" data-run>Run due jobs now</button><button class="btn btn-ghost" data-dom>Set up / verify email domain</button><button class="btn btn-ghost" data-test>Send test email</button>') + `
      <div class="grid-2 reveal mb-3"><div class="card card-pad"><dl class="kv">
        <dt>Email</dt><dd>${ok(s.mail.mode !== 'none')} ${esc(s.mail.mode)} · from ${esc(s.mail.from)}</dd>
        <dt>File storage</dt><dd>${ok(s.storage.mode === 'supabase')} ${esc(s.storage.mode)} · bucket ${esc(s.storage.bucket)}</dd>
        <dt>Payments</dt><dd>${ok(s.payments.configured)} Razorpay · webhook secret ${s.payments.webhookSecret ? 'set' : 'missing'}</dd>
        <dt>Google Sheet</dt><dd>${ok(s.sheet.configured)} ${s.sheet.failed} failed · ${s.sheet.pending} pending</dd>
        <dt>Cron</dt><dd>${ok(s.cron.secret)}</dd></dl></div>
      <div class="card card-pad"><div class="section-label">Email domain (Resend)</div>${s.mail.domainError ? `<p class="due small">${esc(s.mail.domainError)}</p>` : ''}
        ${(s.mail.domains || []).map((dm) => `<p class="strong">${esc(dm.name)} ${statusPill(dm.status === 'verified' ? 'active' : 'pending')}</p><div class="table-wrap"><table><thead><tr><th>Type</th><th>Name</th><th>Value</th><th></th></tr></thead><tbody>${dm.records.map((r) => `<tr><td>${esc(r.type)}${r.priority != null ? ` (${r.priority})` : ''}</td><td class="mono">${esc(r.name)}</td><td class="mono">${esc(r.value)}</td><td>${statusPill(r.status === 'verified' ? 'active' : 'pending')}</td></tr>`).join('')}</tbody></table></div>`).join('') || '<p class="muted small">No Resend domain found (or Resend not configured).</p>'}</div></div>`;
    const jobsCard = tableCard({ title: 'Failed jobs', rows: s.failedJobs, columns: [{ h: 'Job', cls: 'strong', render: (j) => `${esc(j.kind)}<span class="sub-line">#${j.id} · ${j.attempts} attempts</span>` }, { h: 'Error', render: (j) => `<span class="small">${esc(j.last_error || '')}</span>` }, { h: 'Status', render: (j) => statusPill(j.status) }], rowActions: () => btn('retry', 'Retry'), empty: 'No failed jobs.' });
    const whCard = tableCard({ title: 'Recent payment webhooks', rows: s.webhooks, columns: [{ h: 'Event', cls: 'strong', render: (w) => `${esc(w.event_type)}<span class="sub-line">${esc(dt(w.received_at))}</span>` }, { h: 'Signature', render: (w) => (w.signature_valid ? statusPill('pass') : statusPill('failed')) }, { h: 'Status', render: (w) => statusPill(w.status) + (w.error ? `<span class="sub-line due">${esc(w.error)}</span>` : '') }], empty: 'No webhooks received yet.' });
    const audit = await api('/api/admin/audit?limit=60');
    const auditCard = tableCard({ title: 'Audit trail (latest 60)', rows: audit, search: (a) => `${a.action} ${a.detail} ${a.user_name || ''}`,
      columns: [{ h: 'When', render: (a) => esc(dt(a.created_at)) }, { h: 'Who', render: (a) => esc(a.user_name || 'System') }, { h: 'Action', cls: 'strong', render: (a) => `${esc(label(a.action))}<span class="sub-line mono">${esc(a.detail)}</span>` }], empty: 'No activity yet.' });
    main.append(jobsCard, whCard, auditCard);
    onAct(jobsCard, { retry: async (i) => { const r = await api(`/api/admin/system/jobs/${i}/retry`, { method: 'POST', body: {} }); toast(r.ok ? 'Succeeded' : `Still failing: ${r.error}`, !r.ok); refresh(); } });
    main.querySelector('[data-run]').addEventListener('click', async () => { const r = await api('/api/admin/system/run-jobs', { method: 'POST', body: {} }); toast(`${r.length} job(s) run`); refresh(); });
    main.querySelector('[data-dom]').addEventListener('click', async () => { try { await api('/api/admin/system/email-domain', { method: 'POST', body: {} }); toast('Domain registered with Resend — add the DNS records shown, then press this again to verify'); refresh(); } catch (e) { toast(e.message, true); } });
    main.querySelector('[data-test]').addEventListener('click', async () => { try { const r = await api('/api/admin/system/test-email', { method: 'POST', body: {} }); toast(`Test email sent to ${r.to}`); } catch (e) { toast(e.message, true); } });
  }

  // ── Router ───────────────────────────────────────────────────────────
  const O = window.AnvayaOps;
  const ctx = () => ({ main, refresh, leadDetail, leadFields, studentFields, studentDetail, isAdmin });
  const views = { today: () => O.today(ctx()), overview, followups, leads: () => O.table(ctx(), 'leads'), students: () => O.table(ctx(), 'students'), support: () => O.support(ctx()),
    'mentor-services': () => O.serviceApprovals(ctx()), 'leads-classic': leads, 'students-classic': students,
    mentors, groups, calendar: async () => A.planner(main, { staff: true, isAdmin, settings: await api('/api/admin/settings') }), 'calendar-list': calendar, syllabus, services, subscriptions, catalog, payments, payables, cohorts, reports, team, settings: settingsPage, system };
  let current = 'today';
  async function render(tab = current) {
    // Deep links: #student-123 (unified record), #queue-followups_due (a saved queue)
    const m = /^(student|queue)-(.+)$/.exec(tab);
    if (m) {
      current = tab;
      const fresh = main.cloneNode(false); main.replaceWith(fresh); main = fresh;
      main.innerHTML = '<p class="sub">Loading…</p>';
      try { await (m[1] === 'student' ? O.workspace(ctx(), Number(m[2])) : O.queue(ctx(), m[2])); } catch (e) { main.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
      return;
    }
    current = views[tab] ? tab : 'today';
    const fresh = main.cloneNode(false); main.replaceWith(fresh); main = fresh;
    main.innerHTML = '<p class="sub">Loading…</p>';
    try { await views[current](); } catch (e) { main.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  }
  A.shell(render, 'today');
  api('/api/admin/overview').then((o) => { setCount('leads', o.counts.leadsNew); setCount('followups', o.counts.followupsDue + o.counts.studentsNeedingFollowup); setCount('mentors', o.counts.mentorsPending); setCount('services', o.counts.casesOpen); setCount('system', o.counts.sheetFailures); }).catch(() => {});
})();
