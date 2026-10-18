(async function () {
  const { api, loadMe, esc, inr, dt, d, toast, modal, confirmBox, onSubmit, statusPill } = A;
  let main = document.getElementById('main');
  let current = 'overview';
  const me = await loadMe();
  document.getElementById('who').textContent = me.user.email;
  const head = (eyebrow, title, sub, actions = '') => `<div class="page-head reveal"><div><div class="eyebrow">${eyebrow}</div>
    <h1 class="title">${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="row">${actions}</div></div>`;
  const firstName = (me.mentor?.name || '').split(' ')[0];
  const sessionRow = (b) => `<li data-id="${b.id}"><div><span class="strong">${esc(b.student_name)}</span><span class="sub-line muted small">${esc(b.service || 'Session')} · ${b.duration} min</span></div>
    <div class="row"><span class="when">${esc(dt(b.scheduled_at))}</span>${b.meeting_link ? `<a class="btn btn-ghost btn-sm" href="${esc(b.meeting_link)}" target="_blank" rel="noopener noreferrer">Join</a>` : ''}<button class="btn btn-ghost btn-sm" data-open="${b.id}">Open</button></div></li>`;

  // ── Session detail: notes + mark completed ──────────────────────────
  async function openSession(bid, after) {
    const list = await api('/api/mentor/bookings');
    const b = list.find((x) => x.id === bid);
    if (!b) return toast('Session not found', true);
    const done = b.status !== 'scheduled';
    const ui = modal(`<div class="eyebrow">Session</div><div class="row-between mb-2"><h2 class="h2">${esc(b.student_name)}</h2>${statusPill(b.status)}</div>
      <dl class="kv mb-3"><dt>When</dt><dd>${esc(dt(b.scheduled_at))} · ${b.duration} min</dd><dt>Service</dt><dd>${esc(b.service || 'Session')}</dd>
        <dt>Your fee</dt><dd>${inr(b.mentor_fee)}</dd>${b.meeting_link ? `<dt>Meeting</dt><dd><a href="${esc(b.meeting_link)}" target="_blank" rel="noopener noreferrer">${esc(b.meeting_link)}</a></dd>` : ''}
        ${b.completed_at ? `<dt>Completed</dt><dd>${esc(dt(b.completed_at))}</dd>` : ''}</dl>
      <form novalidate><div class="form-error" hidden></div>
        <div class="field"><label class="label">Session notes</label><textarea class="input" name="session_notes" rows="7" placeholder="Key takeaways, action items, follow-ups…">${esc(b.session_notes)}</textarea>
        <p class="hint">Visible to you and the Anvaya team.</p></div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Close</button>
          <button type="submit" class="btn btn-ghost">Save notes</button>
          ${done ? '' : '<button type="button" class="btn btn-primary" data-complete>Mark completed</button>'}</div></form>`);
    const form = ui.el.querySelector('form');
    onSubmit(form, async (data) => { await api(`/api/mentor/bookings/${bid}`, { method: 'PATCH', body: data }); toast('Notes saved'); ui.close(); after && after(); });
    ui.el.querySelector('[data-complete]')?.addEventListener('click', async () => {
      if (!await confirmBox('Mark session completed?', 'Your fee for this session will be added to your earnings.', { ok: 'Mark completed' })) return;
      try {
        await api(`/api/mentor/bookings/${bid}/complete`, { method: 'POST', body: { session_notes: form.session_notes.value } });
        toast('Session marked completed'); ui.close(); after && after();
      } catch (e) { toast(e.message, true); }
    });
  }
  const bindOpen = (root, after) => root.addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openSession(Number(b.dataset.open), after); });

  // ── Views ───────────────────────────────────────────────────────────
  async function overview() {
    const o = await api('/api/mentor/overview');
    main.innerHTML = head('Mentor dashboard', `Welcome, <em>${esc(firstName)}</em>`, 'Your upcoming sessions, students and earnings.') + `
      <div class="stats reveal">
        <div class="card stat"><span class="stat-n">${o.stats.upcoming}</span><span class="stat-l">Upcoming sessions</span></div>
        <div class="card stat"><span class="stat-n">${o.stats.students}</span><span class="stat-l">Assigned students</span></div>
        <div class="card stat"><span class="stat-n">${o.stats.completed}</span><span class="stat-l">Sessions completed</span></div>
        <div class="card stat"><span class="stat-n">${inr(o.stats.earned)}</span><span class="stat-l">Earned · ${inr(o.stats.projected)} scheduled</span></div>
      </div>
      <div class="card reveal" id="up"><div class="card-head"><h2 class="h2">Upcoming <em>sessions</em></h2><a class="link-btn" href="#sessions">All sessions →</a></div>
        ${o.upcoming.length ? `<ul class="list">${o.upcoming.map(sessionRow).join('')}</ul>` : '<div class="empty">No upcoming sessions yet. The Anvaya team will book students into your availability.</div>'}</div>`;
    bindOpen(document.getElementById('up'), () => render());
  }

  async function sessions() {
    const rows = await api('/api/mentor/bookings');
    const now = new Date();
    const upcoming = rows.filter((b) => b.status === 'scheduled').sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    const past = rows.filter((b) => b.status !== 'scheduled');
    const table = (list, empty) => list.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Student</th><th>Fee</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((b) => `<tr><td><span class="when">${esc(dt(b.scheduled_at))}</span><span class="sub-line">${b.duration} min${b.status === 'scheduled' && new Date(b.scheduled_at) < now ? ' · awaiting completion' : ''}</span></td>
        <td class="strong">${esc(b.student_name)}<span class="sub-line">${esc(b.service || 'Session')}</span></td><td>${inr(b.mentor_fee)}</td>
        <td>${statusPill(b.status)}${b.session_notes ? '<span class="sub-line">Notes added</span>' : ''}</td>
        <td class="actions"><button class="btn btn-ghost btn-sm" data-open="${b.id}">${b.status === 'scheduled' ? 'Notes / complete' : 'View notes'}</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">${empty}</div>`;
    main.innerHTML = head('Bookings', 'Your <em>sessions</em>', 'Add notes after each session and mark it completed.') + `
      <div class="card reveal mb-3"><div class="card-head"><h2 class="h2">Scheduled</h2><span class="muted small">${upcoming.length}</span></div>${table(upcoming, 'Nothing scheduled.')}</div>
      <div class="card reveal"><div class="card-head"><h2 class="h2">Past &amp; completed</h2><span class="muted small">${past.length}</span></div>${table(past, 'No completed sessions yet.')}</div>`;
    bindOpen(main, () => render());
  }

  async function students() {
    const rows = await api('/api/mentor/students');
    main.innerHTML = head('Mentees', 'My <em>students</em>', 'Students assigned to you or booked with you.') + `<div class="card reveal">${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Student</th><th>Stage</th><th>Plan</th><th>Sessions</th><th>Next session</th><th></th></tr></thead><tbody>
      ${rows.map((s) => `<tr><td class="strong">${esc(s.name)}<span class="sub-line">${esc(s.email || s.phone || '')}</span></td><td>${esc(s.stage || '—')}</td><td>${esc(s.plan || '—')}</td>
        <td>${s.sessions}</td><td>${s.next_session ? `<span class="when">${esc(dt(s.next_session))}</span>` : '<span class="muted">—</span>'}</td>
        <td class="actions"><button class="btn btn-ghost btn-sm" data-student="${s.id}">View</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No students assigned yet.</div>'}</div>`;
    main.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-student]'); if (!b) return;
      const s = await api(`/api/mentor/students/${b.dataset.student}`);
      modal(`<div class="eyebrow">Student</div><div class="row-between mb-3"><h2 class="h2">${esc(s.name)}</h2>${statusPill(s.status)}</div>
        <dl class="kv mb-3"><dt>Email</dt><dd>${esc(s.email || '—')}</dd><dt>Phone</dt><dd>${esc(s.phone || '—')}</dd><dt>Stage</dt><dd>${esc(s.stage || '—')}</dd>
        <dt>Plan</dt><dd>${esc(s.plan || '—')}</dd><dt>Goals</dt><dd>${esc(s.goals || '—')}</dd></dl>
        <div class="section-label">Sessions with you</div>
        ${s.bookings.length ? s.bookings.map((x) => `<div class="mb-2"><div class="row-between mb-1"><span class="when">${esc(dt(x.scheduled_at))} · ${esc(x.service || 'Session')}</span>${statusPill(x.status)}</div>${x.session_notes ? `<div class="note-box">${esc(x.session_notes)}</div>` : ''}</div>`).join('') : '<p class="muted">No sessions yet.</p>'}`);
    });
  }

  async function earnings() {
    const [e, o] = await Promise.all([api('/api/mentor/earnings'), api('/api/mentor/overview')]);
    const label = (m) => new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    main.innerHTML = head('Earnings', 'Your <em>earnings</em>', 'Fees from completed sessions. Scheduled sessions count once you mark them completed.') + `
      <div class="stats reveal">
        <div class="card stat"><span class="stat-n">${inr(o.stats.earned)}</span><span class="stat-l">Total earned</span></div>
        <div class="card stat"><span class="stat-n">${inr(o.stats.projected)}</span><span class="stat-l">Scheduled (not yet earned)</span></div>
        <div class="card stat"><span class="stat-n">${o.stats.completed}</span><span class="stat-l">Completed sessions</span></div>
        <div class="card stat"><span class="stat-n">${inr(e.byMonth[0]?.amount || 0)}</span><span class="stat-l">${e.byMonth[0] ? esc(label(e.byMonth[0].month)) : 'This month'}</span></div>
      </div>
      <div class="grid-2 reveal">
        <div class="card"><div class="card-head"><h2 class="h2">By <em>month</em></h2></div>${e.byMonth.length ? `<ul class="list">${e.byMonth.map((m) => `<li><div><span class="strong">${esc(label(m.month))}</span><span class="sub-line muted small">${m.sessions} session${m.sessions === 1 ? '' : 's'}</span></div><span class="strong">${inr(m.amount)}</span></li>`).join('')}</ul>` : '<div class="empty">No earnings yet.</div>'}</div>
        <div class="card"><div class="card-head"><h2 class="h2">Completed <em>sessions</em></h2></div>${e.items.length ? `<ul class="list">${e.items.map((i) => `<li><div><span class="strong">${esc(i.student_name)}</span><span class="sub-line muted small">${esc(i.service || 'Session')} · ${esc(d(i.completed_at))}</span></div><span class="strong">${inr(i.mentor_fee)}</span></li>`).join('')}</ul>` : '<div class="empty">Nothing yet.</div>'}</div>
      </div>`;
  }

  async function availability() {
    const p = await api('/api/mentor/me');
    main.innerHTML = head('Schedule', 'Your <em>availability</em>', `Weekly slots in ${esc(p.timezone)}. The Anvaya team books sessions within these windows.`) + `
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
    main.innerHTML = head('Profile', 'Your <em>profile</em>', 'Your expertise, bio and session details.') + `
      <div class="card card-pad reveal mb-3"><form id="pf" novalidate><div class="form-error" hidden></div>
        <div class="section-label">About you</div><div class="form-grid">
          <div class="field"><label class="label">Full name</label><input class="input" name="name" value="${esc(p.name)}"></div>
          <div class="field"><label class="label">Email (managed by Anvaya)</label><input class="input" value="${esc(p.email)}" disabled></div>
          <div class="field"><label class="label">Phone</label><input class="input" name="phone" value="${esc(p.phone)}"></div>
          <div class="field"><label class="label">LinkedIn URL</label><input class="input" name="linkedin" value="${esc(p.linkedin)}"></div>
          <div class="field span-2"><label class="label">Expertise</label><input class="input" name="expertise" value="${esc(p.expertise)}"></div>
          <div class="field span-2"><label class="label">Bio</label><textarea class="input" name="bio" rows="5">${esc(p.bio)}</textarea></div>
        </div>
        <div class="section-label mt-1">Session details</div><div class="form-grid">
          <div class="field"><label class="label">Session length (minutes)</label><input class="input" type="number" min="15" max="240" step="5" name="session_duration" value="${esc(p.session_duration)}"></div>
          <div class="field"><label class="label">Session price (set by Anvaya)</label><input class="input" value="${inr(p.session_price)} per session" disabled></div>
          <div class="field span-2"><label class="label">Default meeting link</label><input class="input" name="meeting_link" value="${esc(p.meeting_link)}" placeholder="https://meet.google.com/…"></div>
          <div class="field span-2"><label class="label">What a session covers</label><textarea class="input" name="session_details" rows="3">${esc(p.session_details)}</textarea></div>
          <div class="field"><label class="label">Time zone</label><input class="input" name="timezone" value="${esc(p.timezone)}"></div>
        </div><button class="btn btn-primary" type="submit">Save profile</button></form></div>
      <div class="card card-pad reveal"><div class="section-label">Change password</div><form id="pw" novalidate><div class="form-error" hidden></div><div class="form-grid">
        <div class="field"><label class="label">Current password</label><input class="input" type="password" name="current" autocomplete="current-password"></div>
        <div class="field"><label class="label">New password</label><input class="input" type="password" name="next" autocomplete="new-password"></div>
      </div><button class="btn btn-ghost" type="submit">Update password</button></form></div>`;
    onSubmit(document.getElementById('pf'), async (data) => { await api('/api/mentor/me', { method: 'PATCH', body: data }); toast('Profile saved'); });
    onSubmit(document.getElementById('pw'), async (data) => { await api('/api/auth/change-password', { method: 'POST', body: data }); await loadMe(); toast('Password updated'); profile(); });
  }

  const views = { overview, sessions, students, earnings, availability, profile };
  async function render(tab = current) {
    current = tab;
    // Fresh <main> each render so delegated listeners don't stack up.
    const fresh = main.cloneNode(false); main.replaceWith(fresh); main = fresh;
    main.innerHTML = '<p class="sub">Loading…</p>';
    try { await (views[tab] || overview)(); } catch (e) { main.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  }
  A.shell(render);
})();
