(async function () {
  const { api, loadMe, esc, inr, dt, d, toLocalInput, toast, modal, confirmBox, onSubmit, statusPill } = A;
  const main = document.getElementById('main');
  const me = await loadMe();
  document.getElementById('who').textContent = me.user.email;

  let cache = {};
  const load = async (name) => (cache[name] = await api(`/api/admin/${name}`));
  const head = (eyebrow, title, sub, actions = '') => `<div class="page-head reveal"><div><div class="eyebrow">${eyebrow}</div>
    <h1 class="title">${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="row">${actions}</div></div>`;
  const opt = (value, label, sel) => `<option value="${esc(value)}"${String(sel ?? '') === String(value) ? ' selected' : ''}>${esc(label)}</option>`;
  const opts = (list, sel) => list.map(([v, l]) => opt(v, l, sel)).join('');

  async function refreshCounts() {
    try {
      const o = await api('/api/admin/overview');
      const set = (id, n) => { const el = document.getElementById(id); el.textContent = n; el.hidden = !n; };
      set('c-leads', o.counts.leadsNew); set('c-mentors', o.counts.mentorsPending);
      return o;
    } catch { return null; }
  }

  /** A searchable, filterable table card. columns: [{ h, render(row) }] */
  function tableCard({ rows, columns, search, filter, empty, rowActions }) {
    const wrap = document.createElement('div');
    wrap.className = 'card reveal';
    wrap.innerHTML = `<div class="toolbar">
        <input class="input" type="search" placeholder="Search…" aria-label="Search">
        ${filter ? `<select class="input" aria-label="Filter"><option value="">All statuses</option>${opts(filter.options)}</select>` : ''}
        <span class="muted small" data-n></span></div>
      <div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th>${c.h}</th>`).join('')}${rowActions ? '<th></th>' : ''}</tr></thead><tbody></tbody></table></div>`;
    const tbody = wrap.querySelector('tbody');
    const q = wrap.querySelector('input[type=search]');
    const f = wrap.querySelector('select');
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      const list = rows.filter((r) => (!term || search(r).toLowerCase().includes(term)) && (!f || !f.value || r[filter.key] === f.value));
      wrap.querySelector('[data-n]').textContent = `${list.length} of ${rows.length}`;
      tbody.innerHTML = list.length
        ? list.map((r) => `<tr data-id="${r.id}">${columns.map((c) => `<td class="${c.cls || ''}">${c.render(r)}</td>`).join('')}${rowActions ? `<td class="actions">${rowActions(r)}</td>` : ''}</tr>`).join('')
        : `<tr><td colspan="${columns.length + 1}"><div class="empty">${empty}</div></td></tr>`;
    };
    q.addEventListener('input', draw); f && f.addEventListener('change', draw);
    draw();
    return wrap;
  }
  /** Delegated row-action clicks: data-act="name" on buttons. */
  function onAct(root, handlers) {
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const rowId = Number(b.closest('tr')?.dataset.id || b.dataset.id);
      handlers[b.dataset.act]?.(rowId, b);
    });
  }

  // ══ Overview ═══════════════════════════════════════════════════════
  async function overview() {
    const o = await refreshCounts();
    main.innerHTML = head('Admin console', 'Good to see you, <em>Anvaya</em>', 'A snapshot of leads, students, mentors and revenue.') + `
      <div class="stats reveal">
        <div class="card stat"><span class="stat-n">${o.counts.leadsNew}</span><span class="stat-l">New leads</span></div>
        <div class="card stat"><span class="stat-n">${o.counts.students}</span><span class="stat-l">Active students</span></div>
        <div class="card stat"><span class="stat-n">${o.counts.mentorsActive}</span><span class="stat-l">Active mentors &middot; ${o.counts.mentorsPending} pending</span></div>
        <div class="card stat"><span class="stat-n">${o.counts.upcoming}</span><span class="stat-l">Upcoming sessions</span></div>
      </div>
      <div class="stats reveal">
        <div class="card stat"><span class="stat-n">${inr(o.revenue.paid)}</span><span class="stat-l">Revenue collected</span></div>
        <div class="card stat"><span class="stat-n">${inr(o.revenue.pending)}</span><span class="stat-l">Payments pending</span></div>
        <div class="card stat"><span class="stat-n">${inr(o.revenue.mentorPayable)}</span><span class="stat-l">Mentor earnings (completed)</span></div>
        <div class="card stat"><span class="stat-n">${o.counts.leads}</span><span class="stat-l">Total leads</span></div>
      </div>
      <div class="grid-2 reveal">
        <div class="card"><div class="card-head"><h2 class="h2">Upcoming <em>sessions</em></h2><a class="link-btn" href="#bookings">All bookings →</a></div>
          ${o.upcoming.length ? `<ul class="list">${o.upcoming.map((b) => `<li><div><span class="strong">${esc(b.student)}</span><span class="sub-line muted small">${esc(b.service || 'Session')} · ${esc(b.mentor || 'Unassigned')}</span></div><span class="when">${esc(dt(b.scheduled_at))}</span></li>`).join('')}</ul>` : '<div class="empty">No upcoming sessions.</div>'}</div>
        <div class="card"><div class="card-head"><h2 class="h2">Recent <em>leads</em></h2><a class="link-btn" href="#leads">All leads →</a></div>
          ${o.recentLeads.length ? `<ul class="list">${o.recentLeads.map((l) => `<li><div><span class="strong">${esc(l.name)}</span><span class="sub-line muted small">${esc(l.situation || '—')}</span></div>${statusPill(l.status)}</li>`).join('')}</ul>` : '<div class="empty">No leads yet.</div>'}</div>
      </div>
      ${o.mail === 'outbox' ? '<p class="hint mt-3">Email is in local outbox mode (no SMTP configured) — invitation emails are saved to <code>data/outbox/</code>.</p>' : ''}`;
  }

  // ══ Mentors ════════════════════════════════════════════════════════
  function mentorForm(m = {}) {
    const isNew = !m.id;
    const ui = modal(`
      <div class="eyebrow">${isNew ? 'Add mentor' : 'Edit mentor'}</div>
      <h2 class="h2 mb-3">${isNew ? 'Invite a <em>new mentor</em>' : esc(m.name)}</h2>
      <form novalidate><div class="form-error" hidden></div>
        <div class="form-grid">
          <div class="field"><label class="label">Full name</label><input class="input" name="name" value="${esc(m.name)}" required></div>
          <div class="field"><label class="label">Email</label><input class="input" name="email" type="email" value="${esc(m.email)}" required></div>
          <div class="field span-2"><label class="label">Expertise</label><input class="input" name="expertise" value="${esc(m.expertise)}" placeholder="e.g. Product management, MBA admissions"></div>
          <div class="field span-2"><label class="label">Bio</label><textarea class="input" name="bio" rows="4">${esc(m.bio)}</textarea></div>
          <div class="field"><label class="label">Session price (₹)</label><input class="input" name="session_price" type="number" min="0" step="50" value="${esc(m.session_price ?? '')}" required></div>
          <div class="field"><label class="label">Session length (min)</label><input class="input" name="session_duration" type="number" min="15" max="240" step="5" value="${esc(m.session_duration ?? 45)}"></div>
        </div>
        ${isNew ? '<p class="hint mb-2">An invitation email with a unique, single-use link will be sent to this address.</p>' : ''}
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">${isNew ? 'Add &amp; send invitation' : 'Save changes'}</button></div>
      </form>`);
    onSubmit(ui.el.querySelector('form'), async (data) => {
      if (isNew) {
        const r = await api('/api/admin/mentors', { method: 'POST', body: data });
        toast(r.mailError ? `Mentor added, but the email failed: ${r.mailError}` : `Invitation sent to ${data.email}`, !!r.mailError);
      } else {
        await api(`/api/admin/mentors/${m.id}`, { method: 'PATCH', body: data });
        toast('Mentor updated');
      }
      ui.close(); mentors();
    });
  }

  async function mentorDetail(mid) {
    const m = await api(`/api/admin/mentors/${mid}`);
    modal(`<div class="eyebrow">Mentor profile</div><div class="row-between mb-3"><h2 class="h2">${esc(m.name)}</h2>${statusPill(m.status)}</div>
      <dl class="kv mb-3">
        <dt>Email</dt><dd>${esc(m.email)}</dd><dt>Expertise</dt><dd>${esc(m.expertise || '—')}</dd>
        <dt>Bio</dt><dd>${esc(m.bio || '—')}</dd><dt>Session</dt><dd>${inr(m.session_price)} · ${m.session_duration} min</dd>
        <dt>Covers</dt><dd>${esc(m.session_details || '—')}</dd><dt>Meeting link</dt><dd>${esc(m.meeting_link || '—')}</dd>
        <dt>Phone</dt><dd>${esc(m.phone || '—')}</dd><dt>LinkedIn</dt><dd>${esc(m.linkedin || '—')}</dd>
        <dt>Students</dt><dd>${m.student_count}</dd><dt>Earned</dt><dd>${inr(m.earned)}</dd>
        <dt>Last sign-in</dt><dd>${m.last_login_at ? esc(dt(m.last_login_at)) : '—'}</dd>
      </dl>
      <div class="section-label">Availability (${esc(m.timezone)})</div>${A.weekView ? A.weekView(m.availability) : (m.availability.length ? m.availability.map((s) => `${A.DAYS[s.weekday]} ${s.start_time}–${s.end_time}`).join('<br>') : '<p class="muted">Not set yet.</p>')}`);
  }

  async function mentors() {
    const rows = await load('mentors'); refreshCounts();
    main.innerHTML = head('CRM', 'Mentors', 'Invite mentors, edit their profiles and manage access.', '<button class="btn btn-primary" data-new>+ Add mentor</button>');
    const statusLine = (m) => {
      if (m.status === 'invite_pending') {
        if (m.has_password) return '<span class="sub-line">Accepted · completing profile</span>';
        if (!m.invite_expires_at) return '<span class="sub-line">No active link</span>';
        return new Date(m.invite_expires_at) < new Date() ? '<span class="sub-line">Link expired</span>' : `<span class="sub-line">Link expires ${esc(d(m.invite_expires_at))}</span>`;
      }
      return '';
    };
    const card = tableCard({
      rows, empty: 'No mentors yet. Add one to send their invitation.',
      search: (m) => `${m.name} ${m.email} ${m.expertise}`,
      filter: { key: 'status', options: [['invite_pending', 'Invite pending'], ['active', 'Active'], ['deactivated', 'Deactivated']] },
      columns: [
        { h: 'Mentor', cls: 'strong', render: (m) => `${esc(m.name)}<span class="sub-line">${esc(m.email)}</span>` },
        { h: 'Expertise', render: (m) => esc(m.expertise || '—') },
        { h: 'Price', render: (m) => `${inr(m.session_price)}<span class="sub-line">${m.session_duration} min</span>` },
        { h: 'Students', render: (m) => `${m.student_count}<span class="sub-line">${m.upcoming_count} upcoming</span>` },
        { h: 'Status', render: (m) => statusPill(m.status) + statusLine(m) },
      ],
      rowActions: (m) => `<button class="btn btn-ghost btn-sm" data-act="view">View</button><button class="btn btn-ghost btn-sm" data-act="edit">Edit</button>` +
        (m.status === 'invite_pending' && !m.has_password ? '<button class="btn btn-ghost btn-sm" data-act="resend">Resend invite</button>' : '') +
        (m.status === 'deactivated' ? '<button class="btn btn-ghost btn-sm" data-act="reactivate">Reactivate</button>' : '<button class="btn btn-danger btn-sm" data-act="deactivate">Deactivate</button>'),
    });
    main.appendChild(card);
    main.querySelector('[data-new]').addEventListener('click', () => mentorForm());
    const byId = (i) => rows.find((r) => r.id === i);
    onAct(card, {
      view: mentorDetail,
      edit: (i) => mentorForm(byId(i)),
      resend: async (i, b) => {
        b.disabled = true;
        try { await api(`/api/admin/mentors/${i}/resend-invite`, { method: 'POST' }); toast(`New invitation sent to ${byId(i).email}`); mentors(); }
        catch (e) { toast(e.message, true); b.disabled = false; }
      },
      deactivate: async (i) => {
        if (!await confirmBox('Deactivate mentor?', `${byId(i).name} will be signed out immediately and won’t be able to sign in. Pending invitation links stop working. Their records are kept.`, { danger: true, ok: 'Deactivate' })) return;
        try { await api(`/api/admin/mentors/${i}/deactivate`, { method: 'POST' }); toast('Mentor deactivated'); mentors(); } catch (e) { toast(e.message, true); }
      },
      reactivate: async (i) => {
        try {
          const r = await api(`/api/admin/mentors/${i}/reactivate`, { method: 'POST' });
          toast(r.status === 'active' ? 'Mentor reactivated' : 'Mentor restored to Invite pending — resend their invitation'); mentors();
        } catch (e) { toast(e.message, true); }
      },
    });
  }

  // ══ Leads ══════════════════════════════════════════════════════════
  const LEAD_STATUS = [['new', 'New'], ['contacted', 'Contacted'], ['qualified', 'Qualified'], ['converted', 'Converted'], ['lost', 'Lost']];
  const SITUATIONS = ['Student / Fresher — building first resume', 'Working professional — want a stronger resume', 'Applying but not hearing back',
    'Targeting MBA / IIM / ISB', 'Career switch — need repositioning', 'Not sure — just want to understand my options'];
  function leadForm(l = {}) {
    const ui = modal(`<div class="eyebrow">${l.id ? 'Edit lead' : 'New lead'}</div><h2 class="h2 mb-3">${l.id ? esc(l.name) : 'Add a <em>lead</em>'}</h2>
      <form novalidate><div class="form-error" hidden></div><div class="form-grid">
        <div class="field"><label class="label">Name</label><input class="input" name="name" value="${esc(l.name)}" required></div>
        <div class="field"><label class="label">Phone</label><input class="input" name="phone" value="${esc(l.phone)}" placeholder="+91 98765 43210"></div>
        <div class="field"><label class="label">Email</label><input class="input" name="email" type="email" value="${esc(l.email)}"></div>
        <div class="field"><label class="label">Source</label><input class="input" name="source" value="${esc(l.source || 'Free 15-min chat')}"></div>
        <div class="field span-2"><label class="label">Where are they right now?</label><select class="input" name="situation"><option value="">Select situation</option>${SITUATIONS.map((s) => opt(s, s, l.situation)).join('')}</select></div>
        <div class="field"><label class="label">Status</label><select class="input" name="status">${opts(LEAD_STATUS, l.status || 'new')}</select></div>
        <div class="field span-2"><label class="label">Notes</label><textarea class="input" name="notes">${esc(l.notes)}</textarea></div>
      </div><div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save lead</button></div></form>`);
    onSubmit(ui.el.querySelector('form'), async (data) => {
      await api(l.id ? `/api/admin/leads/${l.id}` : '/api/admin/leads', { method: l.id ? 'PATCH' : 'POST', body: data });
      toast('Lead saved'); ui.close(); leads();
    });
  }
  async function leads() {
    const rows = await load('leads'); refreshCounts();
    main.innerHTML = head('CRM', 'Leads', 'Free-chat requests and enquiries. Convert a lead to create a student record.', '<button class="btn btn-primary" data-new>+ Add lead</button>');
    const card = tableCard({
      rows, empty: 'No leads yet.', search: (l) => `${l.name} ${l.phone} ${l.email} ${l.situation} ${l.notes}`,
      filter: { key: 'status', options: LEAD_STATUS },
      columns: [
        { h: 'Lead', cls: 'strong', render: (l) => `${esc(l.name)}<span class="sub-line">${esc(l.phone || l.email || '—')}</span>` },
        { h: 'Situation', render: (l) => esc(l.situation || '—') },
        { h: 'Source', render: (l) => `${esc(l.source)}<span class="sub-line">${esc(d(l.created_at))}</span>` },
        { h: 'Status', render: (l) => statusPill(l.status) },
      ],
      rowActions: (l) => `<button class="btn btn-ghost btn-sm" data-act="edit">Edit</button>${l.student_id ? '' : '<button class="btn btn-ghost btn-sm" data-act="convert">Convert</button>'}<button class="btn btn-danger btn-sm" data-act="del">Delete</button>`,
    });
    main.appendChild(card);
    main.querySelector('[data-new]').addEventListener('click', () => leadForm());
    onAct(card, {
      edit: (i) => leadForm(rows.find((r) => r.id === i)),
      convert: async (i) => { try { await api(`/api/admin/leads/${i}/convert`, { method: 'POST' }); toast('Converted to student'); leads(); } catch (e) { toast(e.message, true); } },
      del: async (i) => { if (await confirmBox('Delete lead?', 'This cannot be undone.', { danger: true, ok: 'Delete' })) { await api(`/api/admin/leads/${i}`, { method: 'DELETE' }); toast('Lead deleted'); leads(); } },
    });
  }

  // ══ Students ═══════════════════════════════════════════════════════
  const STUDENT_STATUS = [['active', 'Active'], ['paused', 'Paused'], ['completed', 'Completed']];
  async function activeMentorOpts(sel) {
    const ms = cache.mentors || await load('mentors');
    return '<option value="">Unassigned</option>' + ms.filter((m) => m.status === 'active' || m.id === Number(sel)).map((m) => opt(m.id, m.name + (m.status !== 'active' ? ' (inactive)' : ''), sel)).join('');
  }
  async function studentForm(s = {}) {
    const mOpts = await activeMentorOpts(s.mentor_id);
    const ui = modal(`<div class="eyebrow">${s.id ? 'Edit student' : 'New student'}</div><h2 class="h2 mb-3">${s.id ? esc(s.name) : 'Add a <em>student</em>'}</h2>
      <form novalidate><div class="form-error" hidden></div><div class="form-grid">
        <div class="field"><label class="label">Name</label><input class="input" name="name" value="${esc(s.name)}" required></div>
        <div class="field"><label class="label">Phone</label><input class="input" name="phone" value="${esc(s.phone)}"></div>
        <div class="field"><label class="label">Email</label><input class="input" name="email" type="email" value="${esc(s.email)}"></div>
        <div class="field"><label class="label">Plan</label><input class="input" name="plan" value="${esc(s.plan)}" placeholder="e.g. Career Clarity Session"></div>
        <div class="field"><label class="label">Stage</label><input class="input" name="stage" value="${esc(s.stage)}"></div>
        <div class="field"><label class="label">Status</label><select class="input" name="status">${opts(STUDENT_STATUS, s.status || 'active')}</select></div>
        <div class="field span-2"><label class="label">Assigned mentor</label><select class="input" name="mentor_id">${mOpts}</select></div>
        <div class="field span-2"><label class="label">Goals (visible to their mentor)</label><textarea class="input" name="goals">${esc(s.goals)}</textarea></div>
        <div class="field span-2"><label class="label">Internal notes (admin only)</label><textarea class="input" name="notes">${esc(s.notes)}</textarea></div>
      </div><div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save student</button></div></form>`);
    onSubmit(ui.el.querySelector('form'), async (data) => {
      await api(s.id ? `/api/admin/students/${s.id}` : '/api/admin/students', { method: s.id ? 'PATCH' : 'POST', body: data });
      toast('Student saved'); ui.close(); students();
    });
  }
  async function students() {
    const [rows] = await Promise.all([load('students'), load('mentors')]);
    main.innerHTML = head('CRM', 'Students', 'Everyone you’re working with, their mentor and payments.', '<button class="btn btn-primary" data-new>+ Add student</button>');
    const card = tableCard({
      rows, empty: 'No students yet.', search: (s) => `${s.name} ${s.email} ${s.phone} ${s.plan} ${s.mentor_name || ''}`,
      filter: { key: 'status', options: STUDENT_STATUS },
      columns: [
        { h: 'Student', cls: 'strong', render: (s) => `${esc(s.name)}<span class="sub-line">${esc(s.email || s.phone || '—')}</span>` },
        { h: 'Plan', render: (s) => `${esc(s.plan || '—')}<span class="sub-line">${esc(s.stage || '')}</span>` },
        { h: 'Mentor', render: (s) => esc(s.mentor_name || 'Unassigned') },
        { h: 'Sessions', render: (s) => `${s.booking_count}<span class="sub-line">${inr(s.paid_total)} paid</span>` },
        { h: 'Status', render: (s) => statusPill(s.status) },
      ],
      rowActions: () => '<button class="btn btn-ghost btn-sm" data-act="edit">Edit</button><button class="btn btn-danger btn-sm" data-act="del">Delete</button>',
    });
    main.appendChild(card);
    main.querySelector('[data-new]').addEventListener('click', () => studentForm());
    onAct(card, {
      edit: (i) => studentForm(rows.find((r) => r.id === i)),
      del: async (i) => { if (await confirmBox('Delete student?', 'Their bookings and payments will be deleted too. This cannot be undone.', { danger: true, ok: 'Delete' })) { await api(`/api/admin/students/${i}`, { method: 'DELETE' }); toast('Student deleted'); students(); } },
    });
  }

  // ══ Bookings ═══════════════════════════════════════════════════════
  const BOOKING_STATUS = [['scheduled', 'Scheduled'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['no_show', 'No-show']];
  const SERVICES = ['Career Clarity Session', 'Resume Review', 'Interview Prep', 'MBA Profile Review', 'Free 15-min chat', 'Mentorship session'];
  async function bookingForm(b = {}) {
    const studs = cache.students || await load('students');
    const mOpts = await activeMentorOpts(b.mentor_id);
    if (!studs.length) return toast('Add a student first.', true);
    const ui = modal(`<div class="eyebrow">${b.id ? 'Edit booking' : 'New booking'}</div><h2 class="h2 mb-3">${b.id ? 'Update <em>session</em>' : 'Book a <em>session</em>'}</h2>
      <form novalidate><div class="form-error" hidden></div><div class="form-grid">
        <div class="field"><label class="label">Student</label><select class="input" name="student_id">${studs.map((s) => opt(s.id, s.name, b.student_id)).join('')}</select></div>
        <div class="field"><label class="label">Mentor</label><select class="input" name="mentor_id">${mOpts}</select></div>
        <div class="field"><label class="label">Service</label><input class="input" name="service" list="svc" value="${esc(b.service)}"><datalist id="svc">${SERVICES.map((s) => `<option value="${esc(s)}">`).join('')}</datalist></div>
        <div class="field"><label class="label">Date &amp; time</label><input class="input" type="datetime-local" name="scheduled_at" value="${esc(toLocalInput(b.scheduled_at))}" required></div>
        <div class="field"><label class="label">Duration (min)</label><input class="input" type="number" name="duration" min="15" max="240" step="5" value="${esc(b.duration ?? 45)}"></div>
        <div class="field"><label class="label">Status</label><select class="input" name="status">${opts(BOOKING_STATUS, b.status || 'scheduled')}</select></div>
        <div class="field"><label class="label">Student price (₹)</label><input class="input" type="number" name="price" min="0" value="${esc(b.price ?? '')}"></div>
        <div class="field"><label class="label">Mentor fee (₹)</label><input class="input" type="number" name="mentor_fee" min="0" value="${esc(b.mentor_fee ?? '')}" placeholder="Defaults to mentor’s price"></div>
        <div class="field span-2"><label class="label">Meeting link</label><input class="input" name="meeting_link" value="${esc(b.meeting_link)}" placeholder="https://meet.google.com/…"></div>
      </div><div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save booking</button></div></form>`);
    // Default the mentor to the student's assigned mentor.
    const form = ui.el.querySelector('form');
    const syncMentor = () => {
      const s = studs.find((x) => x.id === Number(form.student_id.value));
      if (s?.mentor_id && [...form.mentor_id.options].some((o) => o.value === String(s.mentor_id))) form.mentor_id.value = s.mentor_id;
    };
    form.student_id.addEventListener('change', syncMentor);
    if (!b.id) syncMentor();
    onSubmit(form, async (data) => {
      if (data.scheduled_at) data.scheduled_at = new Date(data.scheduled_at).toISOString();
      if (b.id && data.mentor_fee === '') delete data.mentor_fee;
      await api(b.id ? `/api/admin/bookings/${b.id}` : '/api/admin/bookings', { method: b.id ? 'PATCH' : 'POST', body: data });
      toast('Booking saved'); ui.close(); bookings();
    });
  }
  async function bookings() {
    const [rows] = await Promise.all([load('bookings'), load('students'), load('mentors')]);
    main.innerHTML = head('CRM', 'Bookings', 'Every scheduled, completed and cancelled session.', '<button class="btn btn-primary" data-new>+ New booking</button>');
    const card = tableCard({
      rows, empty: 'No bookings yet.', search: (b) => `${b.student_name} ${b.mentor_name || ''} ${b.service}`,
      filter: { key: 'status', options: BOOKING_STATUS },
      columns: [
        { h: 'When', render: (b) => `<span class="when">${esc(dt(b.scheduled_at))}</span><span class="sub-line">${b.duration} min</span>` },
        { h: 'Student', cls: 'strong', render: (b) => `${esc(b.student_name)}<span class="sub-line">${esc(b.service || 'Session')}</span>` },
        { h: 'Mentor', render: (b) => esc(b.mentor_name || 'Unassigned') },
        { h: 'Price / fee', render: (b) => `${inr(b.price)}<span class="sub-line">Mentor ${inr(b.mentor_fee)}</span>` },
        { h: 'Status', render: (b) => statusPill(b.status) + (b.session_notes ? '<span class="sub-line">Notes added</span>' : '') },
      ],
      rowActions: () => '<button class="btn btn-ghost btn-sm" data-act="notes">Notes</button><button class="btn btn-ghost btn-sm" data-act="edit">Edit</button><button class="btn btn-danger btn-sm" data-act="del">Delete</button>',
    });
    main.appendChild(card);
    main.querySelector('[data-new]').addEventListener('click', () => bookingForm());
    onAct(card, {
      notes: (i) => { const b = rows.find((r) => r.id === i); modal(`<div class="eyebrow">Session notes</div><h2 class="h2 mb-2">${esc(b.student_name)} · ${esc(b.service || 'Session')}</h2><p class="muted small mb-2">${esc(dt(b.scheduled_at))} · ${esc(b.mentor_name || 'Unassigned')}</p><div class="note-box">${esc(b.session_notes || 'No notes yet.')}</div>`); },
      edit: (i) => bookingForm(rows.find((r) => r.id === i)),
      del: async (i) => { if (await confirmBox('Delete booking?', 'This cannot be undone.', { danger: true, ok: 'Delete' })) { await api(`/api/admin/bookings/${i}`, { method: 'DELETE' }); toast('Booking deleted'); bookings(); } },
    });
  }

  // ══ Payments ═══════════════════════════════════════════════════════
  const PAY_STATUS = [['paid', 'Paid'], ['pending', 'Pending'], ['refunded', 'Refunded'], ['failed', 'Failed']];
  async function paymentForm(p = {}) {
    const studs = cache.students || await load('students');
    const books = cache.bookings || await load('bookings');
    if (!studs.length) return toast('Add a student first.', true);
    const ui = modal(`<div class="eyebrow">${p.id ? 'Edit payment' : 'Record payment'}</div><h2 class="h2 mb-3">${p.id ? 'Update <em>payment</em>' : 'Record a <em>payment</em>'}</h2>
      <form novalidate><div class="form-error" hidden></div><div class="form-grid">
        <div class="field"><label class="label">Student</label><select class="input" name="student_id">${studs.map((s) => opt(s.id, s.name, p.student_id)).join('')}</select></div>
        <div class="field"><label class="label">Booking (optional)</label><select class="input" name="booking_id"><option value="">—</option>${books.map((b) => opt(b.id, `${b.student_name} · ${b.service || 'Session'} · ${d(b.scheduled_at)}`, p.booking_id)).join('')}</select></div>
        <div class="field"><label class="label">Amount (₹)</label><input class="input" type="number" name="amount" min="0" value="${esc(p.amount ?? '')}" required></div>
        <div class="field"><label class="label">Method</label><input class="input" name="method" list="pm" value="${esc(p.method || 'UPI')}"><datalist id="pm"><option value="UPI"><option value="Card"><option value="Bank transfer"><option value="Cash"></datalist></div>
        <div class="field"><label class="label">Reference / transaction ID</label><input class="input" name="reference" value="${esc(p.reference)}"></div>
        <div class="field"><label class="label">Status</label><select class="input" name="status">${opts(PAY_STATUS, p.status || 'paid')}</select></div>
        <div class="field"><label class="label">Paid on</label><input class="input" type="datetime-local" name="paid_at" value="${esc(toLocalInput(p.paid_at || (p.id ? '' : new Date().toISOString())))}"></div>
      </div><div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save payment</button></div></form>`);
    onSubmit(ui.el.querySelector('form'), async (data) => {
      data.paid_at = data.paid_at ? new Date(data.paid_at).toISOString() : '';
      await api(p.id ? `/api/admin/payments/${p.id}` : '/api/admin/payments', { method: p.id ? 'PATCH' : 'POST', body: data });
      toast('Payment saved'); ui.close(); payments();
    });
  }
  async function payments() {
    const [rows] = await Promise.all([load('payments'), load('students'), load('bookings')]);
    const total = rows.filter((p) => p.status === 'paid').reduce((a, p) => a + p.amount, 0);
    main.innerHTML = head('CRM', 'Payments', `${inr(total)} collected across ${rows.filter((p) => p.status === 'paid').length} payments.`, '<button class="btn btn-primary" data-new>+ Record payment</button>');
    const card = tableCard({
      rows, empty: 'No payments recorded yet.', search: (p) => `${p.student_name} ${p.reference} ${p.method} ${p.booking_service || ''}`,
      filter: { key: 'status', options: PAY_STATUS },
      columns: [
        { h: 'Student', cls: 'strong', render: (p) => `${esc(p.student_name)}<span class="sub-line">${esc(p.booking_service || '—')}</span>` },
        { h: 'Amount', render: (p) => `<span class="strong">${inr(p.amount)}</span>` },
        { h: 'Method', render: (p) => `${esc(p.method)}<span class="sub-line">${esc(p.reference || '')}</span>` },
        { h: 'Date', render: (p) => esc(d(p.paid_at || p.created_at)) },
        { h: 'Status', render: (p) => statusPill(p.status) },
      ],
      rowActions: () => '<button class="btn btn-ghost btn-sm" data-act="edit">Edit</button><button class="btn btn-danger btn-sm" data-act="del">Delete</button>',
    });
    main.appendChild(card);
    main.querySelector('[data-new]').addEventListener('click', () => paymentForm());
    onAct(card, {
      edit: (i) => paymentForm(rows.find((r) => r.id === i)),
      del: async (i) => { if (await confirmBox('Delete payment?', 'This cannot be undone.', { danger: true, ok: 'Delete' })) { await api(`/api/admin/payments/${i}`, { method: 'DELETE' }); toast('Payment deleted'); payments(); } },
    });
  }

  // ══ Account ════════════════════════════════════════════════════════
  function account() {
    main.innerHTML = head('Security', 'Your <em>account</em>', `Signed in as ${esc(me.user.email)}.`) + `
      <div class="card card-pad reveal"><h2 class="h2 mb-2">Change password</h2>
      <form id="pw" novalidate><div class="form-error" hidden></div><div class="form-grid">
        <div class="field span-2"><label class="label">Current password</label><input class="input" type="password" name="current" autocomplete="current-password"></div>
        <div class="field"><label class="label">New password</label><input class="input" type="password" name="next" autocomplete="new-password"></div>
      </div><p class="hint mb-2">At least 10 characters with a letter and a number. Other devices will be signed out.</p>
      <button class="btn btn-primary" type="submit">Update password</button></form></div>`;
    onSubmit(document.getElementById('pw'), async (data) => {
      await api('/api/auth/change-password', { method: 'POST', body: data });
      await loadMe(); toast('Password updated'); account();
    });
  }

  const views = { overview, mentors, leads, students, bookings, payments, account };
  A.shell(async (tab) => {
    main.innerHTML = '<p class="sub">Loading…</p>';
    try { await (views[tab] || overview)(); } catch (e) { main.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  });
})();
