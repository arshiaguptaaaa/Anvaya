// Mentor dashboard — only the signed-in mentor's own students, groups, sessions, review tasks and ledger.
(async function () {
  const { api, loadMe, esc, inr, dt, d, toast, modal, confirmBox, onSubmit, statusPill, tableCard, onAct, pageHead, stat, label } = A;
  let main = document.getElementById('main');
  const me = await loadMe();
  document.getElementById('who').textContent = me.user.email;
  const firstName = (me.mentor?.name || '').split(' ')[0];
  const btn = (act, text, cls = 'btn-ghost') => `<button class="btn ${cls} btn-sm" data-act="${act}">${text}</button>`;
  const refresh = () => render(current);

  async function sessionModal(b) {
    const done = b.status !== 'scheduled' || new Date(b.scheduled_at) > Date.now();
    const ui = modal(`<div class="eyebrow">${esc(label(b.kind))}</div><div class="row-between mb-2"><h2 class="h2">${esc(b.student_name)}</h2>${statusPill(b.status)}</div>
      <div class="kv-inline mb-3"><span>When <strong>${esc(dt(b.scheduled_at))} IST</strong></span><span>Length <strong>${b.duration} min</strong></span>
        <span>${b.kind === 'checkup' ? 'Check-up fee' : 'Your fee'} <strong>${inr(b.mentor_fee_paise)}</strong></span>${b.meeting_link ? `<span><a href="${esc(b.meeting_link)}" target="_blank" rel="noopener noreferrer">Join on Meet</a></span>` : ''}</div>
      <form novalidate><div class="form-error" hidden></div>
        ${Object.keys(b.intake_answers || {}).length ? `<div class="section-label">Student’s answers</div><dl class="kv mb-2">${(b.intake_questions || []).filter((q) => b.intake_answers[q.id]).map((q) => `<dt>${esc(q.label)}</dt><dd>${esc(b.intake_answers[q.id])}</dd>`).join('')}</dl>` : ''}
        <div class="field"><label class="label">Session notes</label><textarea class="input" name="session_notes" rows="7" placeholder="Takeaways, action items, follow-ups…">${esc(b.session_notes)}</textarea></div>
        <div class="field"><label class="label">Who can see these notes</label><select class="input" name="notes_visibility">
          ${[['private', 'Only me'], ['staff', 'Me and the Anvaya team'], ['student', 'Me, the Anvaya team and the student']].map(([v, l]) => `<option value="${v}"${(b.notes_visibility || 'private') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <p class="hint">Notes stay private unless you choose to share them.</p></div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Close</button><button type="submit" class="btn btn-ghost">Save notes</button>
          ${done ? '' : '<button type="button" class="btn btn-danger" data-noshow>No-show</button><button type="button" class="btn btn-primary" data-complete>Mark completed</button>'}</div></form>`);
    const form = ui.el.querySelector('form');
    onSubmit(form, async (data) => { await api(`/api/mentor/bookings/${b.id}`, { method: 'PATCH', body: data }); toast('Notes saved'); ui.close(); refresh(); });
    ui.el.querySelector('[data-complete]')?.addEventListener('click', async () => {
      if (!await confirmBox('Mark completed?', 'Attendance is recorded and the fee is added to your ledger.', { ok: 'Mark completed' })) return;
      try { await api(`/api/mentor/bookings/${b.id}`, { method: 'PATCH', body: { notes_visibility: form.notes_visibility.value } }); await api(`/api/mentor/bookings/${b.id}/complete`, { method: 'POST', body: { session_notes: form.session_notes.value } }); toast('Completed'); ui.close(); refresh(); } catch (e) { toast(e.message, true); }
    });
    ui.el.querySelector('[data-noshow]')?.addEventListener('click', async () => {
      const reason = prompt('What happened? (kept internal; required)');
      if (!reason || !reason.trim()) return;
      try { await api(`/api/calendar/bookings/${b.id}/outcome`, { method: 'POST', body: { outcome: 'student_no_show', reason } }); toast('No-show recorded'); ui.close(); refresh(); } catch (e) { toast(e.message, true); }
    });
  }
  async function attendanceModal(l) {
    const roster = await api(`/api/mentor/live-sessions/${l.id}/roster`);
    const ui = modal(`<div class="eyebrow">Attendance</div><h2 class="h2 mb-2">${esc(l.title)}</h2><p class="small muted mb-2">${esc(dt(l.starts_at))} IST</p>
      <form novalidate><div class="form-error" hidden></div><ul class="list">${roster.map((p) => `<li><span class="strong">${esc(p.name)}</span><select class="input" name="s-${p.id}">${['', 'present', 'late', 'absent', 'excused'].map((s) => `<option value="${s}"${p.status === s ? ' selected' : ''}>${s ? label(s) : '—'}</option>`).join('')}</select></li>`).join('') || '<li class="muted">No one on the roster.</li>'}</ul>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" type="submit">Save attendance</button></div></form>`);
    onSubmit(ui.el.querySelector('form'), async (dta) => {
      const marks = Object.entries(dta).filter(([, v]) => v).map(([k, v]) => ({ student_id: Number(k.slice(2)), status: v }));
      await api(`/api/mentor/live-sessions/${l.id}/attendance`, { method: 'POST', body: { marks } }); ui.close(); toast('Attendance saved'); refresh();
    });
  }

  async function overview() {
    const o = await api('/api/mentor/overview');
    main.innerHTML = pageHead('Mentor dashboard', `Welcome, <em>${esc(firstName)}</em>`, 'Your sessions, students, review tasks and earnings. Times in IST.') + `
      <div class="stats reveal">${stat(o.stats.upcoming, 'Upcoming 1:1s')}${stat(o.stats.students, 'Your students')}${stat(o.stats.reviews, 'Review tasks')}${stat(inr(o.stats.payable), 'Payable to you')}</div>
      <div class="card reveal"><div class="card-head"><h2 class="h2">Coming <em>up</em></h2><a class="link-btn" href="#sessions">All sessions →</a></div>
        ${o.upcoming.length ? `<ul class="list">${o.upcoming.map((x) => `<li><div><span class="strong">${esc(x.title || 'Session')}</span><span class="sub-line muted small">${esc(x.student_name || '')} · ${esc(label(x.kind))} · ${x.duration} min</span></div>
          <div class="row"><span class="when">${esc(dt(x.starts_at))}</span>${x.meeting_link ? `<a class="btn btn-ghost btn-sm" href="${esc(x.meeting_link)}" target="_blank" rel="noopener noreferrer">Join</a>` : ''}</div></li>`).join('')}</ul>` : '<div class="empty">Nothing scheduled yet. The Anvaya team books students into your availability.</div>'}</div>`;
  }

  async function sessions() {
    const [rows, lives] = await Promise.all([api('/api/mentor/bookings'), api('/api/mentor/live-sessions')]);
    main.innerHTML = pageHead('Delivery', 'Your <em>sessions</em>', 'Add notes after each session, mark attendance and completion. Approve requests and record outcomes on the <a href="#calendar">Calendar</a>.');
    const now = Date.now();
    const bCard = tableCard({ title: '1:1 sessions', rows, filter: { key: 'status', options: [['requested', 'Requested'], ['pending_payment', 'Awaiting payment'], ['scheduled', 'Confirmed'], ['completed', 'Completed'], ['no_show', 'No-show'], ['cancelled', 'Cancelled']] },
      columns: [
        { h: 'When (IST)', render: (b) => `<span class="when">${esc(dt(b.scheduled_at))}</span><span class="sub-line">${b.duration} min${b.status === 'scheduled' && new Date(b.scheduled_at) < now ? ' · awaiting completion' : ''}</span>` },
        { h: 'Student', cls: 'strong', render: (b) => `${esc(b.student_name)}<span class="sub-line">${esc(b.service || label(b.kind))}</span>` },
        { h: 'Fee', render: (b) => inr(b.mentor_fee_paise) },
        { h: 'Status', render: (b) => statusPill(b.status) + (b.session_notes ? '<span class="sub-line">Notes added</span>' : '') },
      ], rowActions: (b) => btn('open', b.status === 'scheduled' ? 'Notes / complete' : 'Notes') });
    const lCard = tableCard({ title: 'Classes &amp; mentor rooms you host', rows: lives,
      columns: [{ h: 'When (IST)', render: (l) => `<span class="when">${esc(dt(l.starts_at))}</span>` }, { h: 'Session', cls: 'strong', render: (l) => `${esc(l.title)}<span class="sub-line">${esc(l.group_name || label(l.kind))}</span>` }, { h: 'Status', render: (l) => statusPill(l.status) + `<span class="sub-line">${l.marked} marked</span>` }],
      rowActions: (l) => (l.meet_link ? `<a class="btn btn-ghost btn-sm" href="${esc(l.meet_link)}" target="_blank" rel="noopener noreferrer">Join</a>` : '') + btn('att', 'Attendance'), empty: 'No group sessions assigned to you.' });
    main.append(bCard, lCard);
    onAct(bCard, { open: (i) => sessionModal(rows.find((b) => b.id === i)) });
    onAct(lCard, { att: (i) => attendanceModal(lives.find((l) => l.id === i)) });
  }

  async function students() {
    const rows = await api('/api/mentor/students');
    main.innerHTML = pageHead('Mentees', 'My <em>students</em>', 'Students assigned to you, booked with you, in your groups or in cases you coach.');
    const card = tableCard({ rows, search: (s) => `${s.name} ${s.target_role} ${s.group_name || ''}`, columns: [
      { h: 'Student', cls: 'strong', render: (s) => `${esc(s.name)}<span class="sub-line">${esc(s.email || s.phone || '')}</span>` },
      { h: 'Target', render: (s) => `${esc(s.target_role || '—')}<span class="sub-line">${esc(label(s.prep_level) || '')}</span>` },
      { h: 'Group', render: (s) => esc(s.group_name || '—') }, { h: 'Sessions', render: (s) => `${s.sessions}${s.next_session ? `<span class="sub-line when">Next ${esc(dt(s.next_session))}</span>` : ''}` },
    ], rowActions: () => btn('view', 'View'), empty: 'No students yet.' });
    main.appendChild(card);
    onAct(card, { view: async (i) => {
      const s = await api(`/api/mentor/students/${i}`);
      const ui = modal(`<div class="eyebrow">Student</div><div class="row-between mb-3"><h2 class="h2">${esc(s.name)}</h2>${statusPill(s.status)}</div>
        <dl class="kv mb-3"><dt>Email</dt><dd>${esc(s.email || '—')}</dd><dt>Phone</dt><dd>${esc(s.phone || '—')}</dd><dt>Target role</dt><dd>${esc(s.target_role || '—')}</dd>
        <dt>College</dt><dd>${esc(s.college_name || '—')}</dd><dt>Goals</dt><dd>${esc(s.goals || '—')}</dd>${s.linkedin ? `<dt>LinkedIn</dt><dd><a href="${esc(s.linkedin)}" target="_blank" rel="noopener noreferrer">${esc(s.linkedin)}</a></dd>` : ''}</dl>
        <div class="section-label">Documents</div>${s.documents.map((x) => x.latest_version_id ? `<button class="link-btn" data-open="${x.latest_version_id}">${esc(label(x.kind))}: ${esc(x.title)}</button><br>` : '').join('') || '<p class="small muted">None shared with you.</p>'}
        <div class="section-label mt-2">Progress</div><ul class="list small">${s.progress.map((p) => `<li><span>${esc(p.title)}<span class="sub-line">${esc(p.module_title)}</span></span>${statusPill(p.status)}</li>`).join('') || '<li class="muted">Not enrolled in a track.</li>'}</ul>
        <div class="section-label mt-2">Sessions with you</div>${s.bookings.map((x) => `<div class="mb-2"><div class="row-between mb-1"><span class="when">${esc(dt(x.scheduled_at))} · ${esc(x.service || label(x.kind))}</span>${statusPill(x.status)}</div>${x.session_notes ? `<div class="note-box">${esc(x.session_notes)}</div>` : ''}</div>`).join('') || '<p class="muted small">None yet.</p>'}`, { wide: true });
      ui.el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => A.openFile(b.dataset.open)));
    } });
  }

  async function groups() {
    const gs = await api('/api/mentor/groups');
    main.innerHTML = pageHead('Delivery', 'Your <em>groups</em>', 'Small-group mentor rooms you lead.') + (gs.length ? `<div class="grid-2 reveal">${gs.map((g) => `<div class="card card-pad"><div class="row-between mb-1"><h2 class="h2">${esc(g.name)}</h2><span class="muted small">${g.members.length}/${g.capacity}</span></div>
      <p class="small muted mb-2">${esc(g.track_name || 'Any track')} · ${esc(g.target_role || 'Any role')} · ${esc(label(g.prep_level) || 'Any level')}</p>
      <div class="row mb-2">${g.meet_link ? `<a class="btn btn-ghost btn-sm" href="${esc(g.meet_link)}" target="_blank" rel="noopener noreferrer">Meet room</a>` : ''}${g.whatsapp_link ? `<a class="btn btn-ghost btn-sm" href="${esc(g.whatsapp_link)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : ''}</div>
      <ul class="list small">${g.members.map((m) => `<li>${esc(m.name)}</li>`).join('') || '<li class="muted">No members yet.</li>'}</ul></div>`).join('')}</div>` : '<div class="card empty">You don’t lead any groups yet.</div>');
  }

  async function reviews() {
    const r = await api('/api/mentor/reviews');
    main.innerHTML = pageHead('Reviews', 'Review <em>tasks</em>', 'Assignment submissions from your students and resume cases you coach.');
    const sCard = tableCard({ title: 'Assignment submissions', rows: r.submissions.map((x) => ({ ...x, id: `${x.student_id}-${x.assignment_id}` })),
      columns: [{ h: 'Student', cls: 'strong', render: (x) => esc(x.student_name) }, { h: 'Assignment', render: (x) => esc(x.assignment_title) }, { h: 'Submitted', render: (x) => esc(dt(x.submitted_at)) }],
      rowActions: () => btn('review', 'Review'), empty: 'Nothing to review.' });
    const cCard = tableCard({ title: 'Resume / LinkedIn cases', rows: r.cases,
      columns: [{ h: 'Student', cls: 'strong', render: (c) => `${esc(c.student_name)}<span class="sub-line">${esc(label(c.kind))}</span>` }, { h: 'Due', render: (c) => esc(c.due_at ? dt(c.due_at) : '—') }, { h: 'Status', render: (c) => statusPill(c.status) }],
      rowActions: () => btn('open', 'Open case'), empty: 'No cases assigned to you.' });
    main.append(sCard, cCard);
    onAct(sCard, { review: async (key) => {
      const x = r.submissions.find((s) => `${s.student_id}-${s.assignment_id}` === key);
      await A.formModal({ eyebrow: 'Review', title: `${esc(x.student_name)} — ${esc(x.assignment_title)}`, intro: `<div class="doc-text mb-2">${esc(x.submission)}</div>`,
        fields: [{ name: 'status', label: 'Result', type: 'select', options: [['reviewed', 'Reviewed'], ['done', 'Done'], ['in_progress', 'Needs another pass']] }, { name: 'feedback', label: 'Feedback', type: 'textarea', span2: true }],
        onSave: (b) => api('/api/mentor/reviews/submission', { method: 'POST', body: { ...b, student_id: x.student_id, assignment_id: x.assignment_id } }) });
      toast('Reviewed'); refresh();
    } });
    onAct(cCard, { open: (i) => A.openCase(i, { onChange: refresh }) });
  }

  async function earnings() {
    const e = await api('/api/mentor/earnings');
    const b = e.balance;
    main.innerHTML = pageHead('Earnings', 'Your <em>ledger</em>', 'Anvaya takes no commission on private sessions: the full fee is yours. Payouts are recorded by the Anvaya team.') + `
      <div class="stats reveal">${stat(inr(b.earned_sessions), `Private sessions (${b.completed_sessions})`)}${stat(inr(b.delivery_fees + b.service_fees), 'Classes, rooms, check-ups &amp; coaching')}${stat(inr(b.paid_out), 'Paid out')}${stat(inr(b.payable), 'Payable now')}</div>
      ${b.adjustments ? `<div class="notice">Refund / cancellation adjustments: ${inr(b.adjustments)}</div>` : ''}`;
    main.appendChild(tableCard({ title: 'Ledger', rows: e.entries, columns: [
      { h: 'Date', render: (x) => esc(d(x.created_at)) }, { h: 'Entry', cls: 'strong', render: (x) => `${esc(label(x.kind))}<span class="sub-line">${esc(x.note)}${x.student_name ? ` · ${esc(x.student_name)}` : ''}</span>` },
      { h: 'Amount', render: (x) => `<span class="${x.amount_paise < 0 ? 'due' : 'strong'}">${inr(x.amount_paise)}</span>` },
    ], empty: 'No entries yet.' }));
    main.appendChild(tableCard({ title: 'Payouts', rows: e.payouts, columns: [{ h: 'Paid on', render: (p) => esc(d(p.paid_at)) }, { h: 'Amount', cls: 'strong', render: (p) => inr(p.amount_paise) }, { h: 'Method', render: (p) => `${esc(p.method)}<span class="sub-line">${esc(p.reference)}</span>` }], empty: 'No payouts yet.' }));
  }

  async function availability() {
    const p = await api('/api/mentor/me');
    main.innerHTML = pageHead('Schedule', 'Your <em>availability</em>', 'Weekly windows in IST. Students book check-ups and paid sessions inside these, in slots of your session length.') + `
      <div class="card card-pad reveal mb-3"><div class="section-label">This week at a glance</div><div id="wk">${A.weekView(p.availability)}</div></div>
      <div class="card card-pad reveal"><div class="section-label">Edit slots</div><form id="av" novalidate><div class="form-error" hidden></div>
        <div class="slots" id="slots"></div><div class="row"><button type="button" class="btn btn-ghost btn-sm" id="addSlot">+ Add a time slot</button>
        <button class="btn btn-primary" type="submit">Save availability</button></div></form></div>`;
    const read = A.availabilityEditor(document.getElementById('slots'), document.getElementById('addSlot'), p.availability);
    onSubmit(document.getElementById('av'), async () => {
      const slots = await api('/api/mentor/availability', { method: 'PUT', body: { availability: read() } });
      document.getElementById('wk').innerHTML = A.weekView(slots); toast('Availability saved');
    });
  }

  async function profile() {
    const p = await api('/api/mentor/me');
    main.innerHTML = pageHead('Profile', 'Your <em>profile</em>', 'Expertise, bio and session details. Fees are set by Anvaya.') + `
      <div class="card card-pad reveal mb-3"><form id="pf" novalidate><div class="form-error" hidden></div>
        <div class="section-label">About you</div><div class="form-grid">
          ${A.fieldHtml({ name: 'name', label: 'Full name' }, p.name)}${A.fieldHtml({ name: 'email_ro', label: 'Email (managed by Anvaya)', disabled: true }, p.email)}
          ${A.fieldHtml({ name: 'phone', label: 'Phone' }, p.phone)}${A.fieldHtml({ name: 'linkedin', label: 'LinkedIn URL', type: 'url' }, p.linkedin)}
          ${A.fieldHtml({ name: 'headline', label: 'Headline', span2: true, placeholder: 'e.g. Senior PM · consumer apps' }, p.headline)}
          ${A.fieldHtml({ name: 'years_experience', label: 'Years of experience', type: 'number', min: 0, max: 60 }, p.years_experience)}${A.fieldHtml({ name: 'target_roles', label: 'Roles you prepare students for', placeholder: 'e.g. APM, Product Analyst' }, p.target_roles)}
          ${A.fieldHtml({ name: 'expertise', label: 'Expertise', span2: true }, p.expertise)}${A.fieldHtml({ name: 'bio', label: 'Bio', type: 'textarea', span2: true, rows: 5 }, p.bio)}
        </div>
        <div class="section-label mt-1">Session details</div><div class="form-grid">
          ${A.fieldHtml({ name: 'session_duration', label: 'Session length (minutes)', type: 'number', min: 15, max: 240, step: 5 }, p.session_duration)}
          ${A.fieldHtml({ name: 'buffer_minutes', label: 'Buffer between sessions (minutes)', type: 'number', min: 0, max: 120, step: 5, hint: 'Kept free before and after every booking.' }, p.buffer_minutes)}
          ${A.fieldHtml({ name: 'fee_ro', label: 'Private session fee (set by Anvaya)', disabled: true }, `${inr(p.session_price_paise)} per session`)}
          ${A.fieldHtml({ name: 'meeting_link', label: 'Default meeting link', type: 'url', span2: true, placeholder: 'https://meet.google.com/…' }, p.meeting_link)}
          ${A.fieldHtml({ name: 'session_details', label: 'What a session covers', type: 'textarea', span2: true, rows: 3 }, p.session_details)}
        </div><button class="btn btn-primary" type="submit">Save profile</button></form></div>
      <div class="card card-pad reveal"><div class="section-label">Change password</div><form id="pw" novalidate><div class="form-error" hidden></div><div class="form-grid">
        ${A.fieldHtml({ name: 'current', label: 'Current password', type: 'password' })}${A.fieldHtml({ name: 'next', label: 'New password', type: 'password' })}
      </div><button class="btn btn-ghost" type="submit">Update password</button></form></div>`;
    onSubmit(document.getElementById('pf'), async (data) => { delete data.email_ro; delete data.fee_ro; await api('/api/mentor/me', { method: 'PATCH', body: data }); toast('Profile saved'); });
    onSubmit(document.getElementById('pw'), async (data) => { await api('/api/auth/change-password', { method: 'POST', body: data }); await loadMe(); toast('Password updated'); refresh(); });
  }

  // ── Services (each new or edited service is reviewed by Anvaya before students can book it) ──
  const qText = (qs) => (qs || []).map((q) => `${q.required ? '* ' : ''}${q.label}`).join('\n');
  const qParse = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).map((l) => ({ label: l.replace(/^\*\s*/, ''), required: l.startsWith('*') }));
  async function services() {
    const rows = await api('/api/mentor/services');
    main.innerHTML = pageHead('Services', 'Your <em>services</em>', 'What students can book with you. The full stated price is paid to you; Anvaya’s processing costs are tracked separately. New services and changes go live after Anvaya approves them.', '<button class="btn btn-primary" data-new>+ Add service</button>')
      + `<div class="card reveal"><ul class="list">${rows.map((x) => `<li><span><strong class="ivory">${esc(x.title)}</strong><span class="sub-line">${x.duration_min} min · ${inr(x.price_paise)}${x.active ? '' : ' · hidden'}${(x.intake_questions || []).length ? ` · ${x.intake_questions.length} question(s)` : ''}</span></span>
        <span class="row">${statusPill(x.approval === 'approved' ? 'active' : x.approval)}<button class="btn btn-ghost btn-sm" data-edit="${x.id}">Edit</button></span></li>`).join('') || '<li class="muted">No services yet. Add one so students can book you.</li>'}</ul></div>`;
    const fieldsFor = () => [{ name: 'title', label: 'Service name', required: true, span2: true }, { name: 'duration_min', label: 'Length (minutes)', type: 'number', min: 15, max: 240, step: 5, required: true },
      { name: 'price_paise', label: 'Price', type: 'money', required: true }, { name: 'description', label: 'What the student gets', type: 'textarea', span2: true },
      { name: 'questions', label: 'Questions before booking (one per line; start with * if required)', type: 'textarea', span2: true }, { name: 'active', label: 'Show to students once approved', type: 'checkbox' }];
    const save = (sid) => async (b) => { const body = { ...b, intake_questions: qParse(b.questions) }; delete body.questions;
      return api(sid ? `/api/mentor/services/${sid}` : '/api/mentor/services', { method: sid ? 'PATCH' : 'POST', body }); };
    main.querySelector('[data-new]').addEventListener('click', async () => { await A.formModal({ eyebrow: 'New service', title: 'Add a <em>service</em>', fields: fieldsFor(), values: { duration_min: 45, active: true }, onSave: save(null) }); toast('Sent to Anvaya for approval'); refresh(); });
    main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
      const x = rows.find((r) => r.id === Number(b.dataset.edit));
      await A.formModal({ eyebrow: 'Edit service', title: esc(x.title), fields: fieldsFor(), values: { ...x, questions: qText(x.intake_questions) }, onSave: save(x.id) });
      toast('Saved. Changes to name, length, price or questions need approval again.'); refresh();
    }));
  }

  const calendar = () => A.planner(main, { staff: false });
  const views = { overview, sessions, students, groups, reviews, earnings, availability, profile, services, calendar };
  let current = 'overview';
  async function render(tab = current) {
    current = views[tab] ? tab : 'overview';
    const fresh = main.cloneNode(false); main.replaceWith(fresh); main = fresh;
    main.innerHTML = '<p class="sub">Loading…</p>';
    try { await views[current](); } catch (e) { main.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  }
  A.shell(render);
  api('/api/mentor/overview').then((o) => { const el = document.getElementById('c-reviews'); if (el) { el.textContent = o.stats.reviews; el.hidden = !o.stats.reviews; } }).catch(() => {});
})();
