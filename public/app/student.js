// Student dashboard (mobile-first). Every API call is scoped server-side to the signed-in student.
(async function () {
  const { api, loadMe, esc, inr, dt, d, toast, modal, confirmBox, onSubmit, statusPill, tableCard, onAct, pageHead, stat, label, formModal } = A;
  let main = document.getElementById('main');
  const meAuth = await loadMe();
  document.getElementById('who').textContent = meAuth.user.email;
  const btn = (act, text, cls = 'btn-ghost') => `<button class="btn ${cls} btn-sm" data-act="${act}">${text}</button>`;
  const refresh = () => render(current);
  const ENT_LABEL = { syllabus: 'Structured syllabus & assignments', live_class: 'Weekly live online training', mentor_room: 'Small-group mentor rooms', checkup_call: 'Check-up calls',
    progress_tracking: 'Progress tracking', community: 'Shortlist Club community', paid_session_discount: 'Member pricing on private sessions' };
  const PER = { week: 'week', month: 'month', billing_period: 'billing period', total: 'in total' };

  // ── Payments (Razorpay Checkout, verified on the server) ─────────────
  let rzpLoaded = null;
  const loadRzp = () => rzpLoaded || (rzpLoaded = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.onload = res; s.onerror = () => { rzpLoaded = null; rej(new Error('Could not load the payment window. Check your connection.')); };
    document.head.appendChild(s);
  }));
  async function pay(checkout, { onDone } = {}) {
    if (checkout.provider !== 'razorpay') {
      modal(`<div class="eyebrow">Payment</div><h2 class="h2 mb-2">Request <em>received</em></h2><p class="sub mb-2">${esc(checkout.message)}</p><p class="small">Amount: <span class="strong">${inr(checkout.amount_paise)}</span> · Order #${checkout.order_id}</p>
        <div class="modal-actions"><button class="btn btn-primary" data-close>OK</button></div>`, { onClose: onDone });
      return;
    }
    await loadRzp();
    const rzp = new window.Razorpay({
      key: checkout.key, order_id: checkout.razorpay_order_id, amount: checkout.amount_paise, currency: 'INR', name: 'Anvaya', description: checkout.description,
      prefill: checkout.prefill, theme: { color: '#c9a84c' },
      handler: async (resp) => {
        try {
          const r = await api('/api/student/payments/verify', { method: 'POST', body: resp });
          toast(r.status === 'paid' ? 'Payment received — thank you!' : 'Payment is processing. This page will update shortly.');
        } catch (e) { toast(e.message, true); }
        onDone && onDone();
      },
      modal: { ondismiss: () => { toast('Payment not completed. Your slot is held for a few minutes.'); onDone && onDone(); } },
    });
    rzp.open();
  }

  // ── Home ─────────────────────────────────────────────────────────────
  async function home() {
    const [me, ses] = await Promise.all([api('/api/student/me'), api('/api/student/sessions')]);
    const sub = me.subscription;
    const upcoming = [...ses.live.filter((l) => new Date(l.ends_at) > new Date()).map((l) => ({ t: l.starts_at, title: l.title, sub: l.group_name || label(l.kind), link: l.meet_link })),
      ...ses.bookings.filter((b) => ['scheduled', 'requested', 'pending_payment'].includes(b.status) && new Date(b.scheduled_at) > new Date()).map((b) => ({ t: b.scheduled_at, title: b.service || label(b.kind), sub: `${b.mentor_name || ''} · ${A.label(b.status)}`, link: b.meeting_link }))]
      .sort((a, b) => new Date(a.t) - new Date(b.t)).slice(0, 6);
    main.innerHTML = pageHead('Your dashboard', `Hi, <em>${esc(me.name.split(' ')[0])}</em>`, 'Your plan, group and what’s coming up. All times in IST.')
      + (!me.intake_completed_at ? '<div class="notice reveal">Finish your profile and upload your resume so your mentor can prepare. <a href="#intake">Complete intake →</a></div>' : '')
      + `<div class="grid-2 reveal mb-3"><div class="card card-pad"><div class="section-label">Your plan</div>
        ${sub ? `<div class="row-between mb-1"><span class="h2">${esc(sub.plan_name)}</span>${statusPill(sub.effective_access)}</div>
          <p class="small muted mb-2">Paid through ${esc(d(sub.paid_through))}${sub.effective_access === 'grace' ? ` · access until ${esc(d(sub.grace_until))} — please renew` : ''}${sub.cancel_at_period_end ? ' · ends at period end' : ''}</p>
          <ul class="list small">${sub.entitlements.map((e) => `<li><span>${esc(ENT_LABEL[e.key] || label(e.key))}</span><span class="muted">${e.limit_count != null ? `${e.used != null ? `${e.used} of ` : ''}${e.limit_count} / ${PER[e.per_period]}` : 'Included'}</span></li>`).join('')}</ul>
          ${sub.effective_access === 'grace' ? '<a class="btn btn-primary btn-sm mt-2" href="#shop">Renew now</a>' : ''}`
        : '<p class="sub mb-2">You don’t have an active plan yet. Plans include the syllabus, weekly live training, mentor rooms, check-ups and the Shortlist Club.</p><a class="btn btn-primary btn-sm" href="#shop">See plans</a>'}</div>
      <div class="card card-pad"><div class="section-label">Your group</div>
        ${me.group ? `<p class="h2 mb-1">${esc(me.group.name)}</p><p class="small muted mb-2">Mentor: ${esc(me.group.mentor_name || 'To be assigned')}</p>
          <div class="row">${me.group.meet_link ? `<a class="btn btn-ghost btn-sm" href="${esc(me.group.meet_link)}" target="_blank" rel="noopener noreferrer">Mentor room (Meet)</a>` : ''}${me.group.whatsapp_link ? `<a class="btn btn-ghost btn-sm" href="${esc(me.group.whatsapp_link)}" target="_blank" rel="noopener noreferrer">Shortlist Club (WhatsApp)</a>` : ''}</div>`
        : `<p class="small muted">${sub ? 'You’ll be placed in a small group matched to your target role, level and availability soon.' : 'Groups are part of the subscription.'}</p>`}</div></div>
      <div class="card reveal"><div class="card-head"><h2 class="h2">Coming <em>up</em></h2><a class="link-btn" href="#sessions">All sessions →</a></div>
        ${upcoming.length ? `<ul class="list">${upcoming.map((u) => `<li><div><span class="strong">${esc(u.title)}</span><span class="sub-line muted small">${esc(u.sub)}</span></div><div class="row"><span class="when">${esc(dt(u.t))}</span>${u.link ? `<a class="btn btn-ghost btn-sm" href="${esc(u.link)}" target="_blank" rel="noopener noreferrer">Join</a>` : ''}</div></li>`).join('')}</ul>` : '<div class="empty">Nothing booked yet.</div>'}</div>`;
  }

  // ── Intake ───────────────────────────────────────────────────────────
  async function intake() {
    const [me, tracks] = await Promise.all([api('/api/student/me'), api('/api/student/tracks')]);
    const f = (o, v) => A.fieldHtml(o, v);
    main.innerHTML = pageHead('Intake', 'Your <em>profile</em>', 'Tell us where you are and where you’re headed. Your mentor sees this; your resume stays private to you, your mentor and the Anvaya team.')
      + (me.intake_completed_at ? '<div class="notice reveal">Intake complete — you can update it any time.</div>' : '') + `
      <div class="card card-pad reveal mb-3"><form id="ik" novalidate><div class="form-error" hidden></div><div class="form-grid">
        ${f({ name: 'name', label: 'Full name', required: true }, me.name)}${f({ name: 'phone', label: 'Phone (WhatsApp)', type: 'tel', required: true }, me.phone)}
        ${f({ name: 'college_name', label: 'College / current company' }, me.college_name)}${f({ name: 'graduation_year', label: 'Graduation year', type: 'number', min: 1980, max: 2040 }, me.graduation_year)}
        ${f({ name: 'stage', label: 'Where are you right now?', span2: true, placeholder: 'e.g. Final-year B.Tech, 2 years in sales, switching to product' }, me.stage)}
        ${f({ name: 'target_role', label: 'Target role', required: true, placeholder: 'e.g. Associate Product Manager' }, me.target_role)}
        ${f({ name: 'prep_level', label: 'Preparation level', type: 'select', options: [['', 'Choose…'], ['starting', 'Just starting'], ['some_preparation', 'Some preparation'], ['interview_ready', 'Interview-ready']] }, me.prep_level)}
        ${f({ name: 'track_id', label: 'Preparation track', type: 'select', required: true, options: [['', 'Choose…'], ...tracks.map((t) => [t.id, `${t.name}${t.target_role ? ` — ${t.target_role}` : ''}`])] }, me.track_id)}
        ${f({ name: 'availability_pref', label: 'When can you attend sessions?', placeholder: 'e.g. Weekday evenings, Sunday mornings' }, me.availability_pref)}
        ${f({ name: 'linkedin', label: 'LinkedIn URL', type: 'url', span2: true }, me.linkedin)}
        ${f({ name: 'goals', label: 'Goals for the next 3 months', type: 'textarea', span2: true }, me.goals)}
      </div>
      <div class="section-label mt-1">Resume</div>
      ${me.resumes.length ? `<ul class="list small mb-2">${me.resumes.map((r) => `<li><span>${esc(r.title)}<span class="sub-line">${esc(dt(r.created_at))}</span></span>${r.latest_version_id ? `<button type="button" class="btn btn-ghost btn-sm" data-open="${r.latest_version_id}">View</button>` : '<span class="muted small">Uploading…</span>'}</li>`).join('')}</ul>` : ''}
      <div class="field"><label class="label">Upload ${me.resumes.length ? 'an updated' : 'your'} resume (PDF or Word, up to 10 MB)</label><input class="input" type="file" id="resume" accept=".pdf,.doc,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"></div>
      <div class="row"><button class="btn btn-ghost" type="submit" value="save">Save</button><button class="btn btn-primary" type="submit" value="complete">${me.intake_completed_at ? 'Save &amp; confirm' : 'Finish intake'} &rarr;</button></div></form></div>`;
    main.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => A.openFile(b.dataset.open)));
    onSubmit(main.querySelector('#ik'), async (data, button) => {
      const file = main.querySelector('#resume').files[0];
      if (file) { await A.upload(file, { kind: 'resume_upload', title: file.name }); toast('Resume uploaded securely'); }
      await api('/api/student/intake', { method: 'PATCH', body: { ...data, complete: button.value === 'complete' } });
      toast(button.value === 'complete' ? 'Intake complete — thank you!' : 'Saved');
      refresh();
    });
  }

  // ── Syllabus ─────────────────────────────────────────────────────────
  async function learn() {
    const s = await api('/api/student/syllabus');
    if (s.locked) { main.innerHTML = pageHead('Syllabus', 'Your <em>syllabus</em>', '') + '<div class="card card-pad reveal"><p class="sub mb-2">The structured syllabus comes with a Shortlist Club plan (or your college cohort).</p><a class="btn btn-primary btn-sm" href="#shop">See plans</a></div>'; return; }
    if (!s.tracks.length) { main.innerHTML = pageHead('Syllabus', 'Your <em>syllabus</em>', '') + '<div class="card card-pad reveal"><p class="sub mb-2">Choose a preparation track in your profile to unlock its modules.</p><a class="btn btn-primary btn-sm" href="#intake">Choose a track</a></div>'; return; }
    main.innerHTML = pageHead('Syllabus', 'Your <em>syllabus</em>', 'Modules and assignments for your track. Submit work here — your mentor reviews it.');
    for (const t of s.tracks) {
      const pct = t.progress.total ? Math.round((t.progress.done / t.progress.total) * 100) : 0;
      const card = document.createElement('div');
      card.className = 'card card-pad reveal mb-3';
      card.innerHTML = `<div class="row-between mb-1"><h2 class="h2">${esc(t.name)}</h2><span class="muted small">${t.progress.done}/${t.progress.total} done</span></div><div class="bar mb-3"><span data-w="${pct}"></span></div>
        ${t.modules.map((m) => `<div class="section-label">${m.week_number ? `Week ${m.week_number} · ` : ''}${esc(m.title)}</div>${m.description ? `<p class="small muted mb-2">${esc(m.description)}</p>` : ''}
          <ul class="list mb-2">${m.assignments.map((a) => `<li><div><span class="strong">${esc(a.title)}</span><span class="sub-line muted small">${a.due_at ? `Due ${esc(d(a.due_at))}` : ''}${a.feedback ? ` · Feedback: ${esc(a.feedback)}` : ''}</span></div>
            <div class="row">${statusPill(a.status)}<button class="btn btn-ghost btn-sm" data-a="${a.id}">${['submitted', 'reviewed', 'done'].includes(a.status) ? 'View' : 'Open'}</button></div></li>`).join('') || '<li class="muted small">No assignments yet.</li>'}</ul>`).join('')}`;
      card.querySelectorAll('[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%`; });
      main.appendChild(card);
      card.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
        const a = t.modules.flatMap((m) => m.assignments).find((x) => x.id === Number(b.dataset.a));
        const ui = modal(`<div class="eyebrow">Assignment</div><h2 class="h2 mb-2">${esc(a.title)}</h2><div class="doc-text mb-2">${esc(a.instructions || 'No instructions.')}</div>
          ${a.feedback ? `<div class="notice">Feedback: ${esc(a.feedback)}</div>` : ''}
          <form novalidate><div class="form-error" hidden></div><div class="field"><label class="label">Your work (text or a link to a Google Doc)</label><textarea class="input" name="submission" rows="8">${esc(a.submission || '')}</textarea></div>
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" type="submit">Submit</button></div></form>`, { wide: true });
        onSubmit(ui.el.querySelector('form'), async (data) => { await api(`/api/student/assignments/${a.id}/submit`, { method: 'POST', body: data }); ui.close(); toast('Submitted'); refresh(); });
      }));
    }
  }

  // ── Sessions & booking ───────────────────────────────────────────────
  async function slotPicker(mentorId, title, onPick) {
    const slots = await api(`/api/student/mentors/${mentorId}/slots`);
    let chosen = null;
    const byDay = {};
    for (const s of slots) (byDay[d(s)] ||= []).push(s);
    const ui = modal(`<div class="eyebrow">Choose a time (IST)</div><h2 class="h2 mb-2">${title}</h2>
      ${slots.length ? Object.entries(byDay).map(([day, list]) => `<div class="section-label">${esc(day)}</div><div class="slot-grid mb-2">${list.map((s) => `<button type="button" class="slot-btn" data-s="${s}">${esc(A.time(s))}</button>`).join('')}</div>`).join('') : '<p class="muted">No open slots in the booking window. Try another mentor or check back soon.</p>'}
      <div class="form-error" hidden></div><div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-go disabled>Confirm</button></div>`, { wide: true });
    ui.el.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => { ui.el.querySelectorAll('.slot-btn').forEach((x) => x.classList.remove('on')); b.classList.add('on'); chosen = b.dataset.s; ui.el.querySelector('[data-go]').disabled = false; }));
    ui.el.querySelector('[data-go]').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Booking…';
      try { await onPick(chosen); ui.close(); } catch (err) { const box = ui.el.querySelector('.form-error'); box.textContent = err.message; box.hidden = false; e.target.disabled = false; e.target.textContent = 'Confirm'; }
    });
  }
  async function sessions() {
    const [ses, me, mentors] = await Promise.all([api('/api/student/sessions'), api('/api/student/me'), api('/api/student/mentors')]);
    const sub = me.subscription;
    const ck = sub?.entitlements.find((e) => e.key === 'checkup_call');
    main.innerHTML = pageHead('Sessions', 'Your <em>sessions</em>', 'Classes, mentor rooms and 1:1s. Times in IST.',
      `${ck ? `<button class="btn btn-ghost" data-ck>Book a check-up${ck.limit_count != null ? ` (${Math.max(0, ck.limit_count - (ck.used || 0))} left)` : ''}</button>` : ''}<button class="btn btn-primary" data-paid>Book a private session</button>`);
    const lCard = tableCard({ title: 'Classes &amp; mentor rooms', rows: ses.live, columns: [
      { h: 'When', render: (l) => `<span class="when">${esc(dt(l.starts_at))}</span>` }, { h: 'Session', cls: 'strong', render: (l) => `${esc(l.title)}<span class="sub-line">${esc(l.group_name || label(l.kind))}${l.mentor_name ? ` · ${esc(l.mentor_name)}` : ''}</span>` },
      { h: 'Status', render: (l) => (l.attendance ? statusPill(l.attendance) : statusPill(l.status)) },
    ], rowActions: (l) => (l.meet_link && new Date(l.ends_at) > new Date() ? `<a class="btn btn-ghost btn-sm" href="${esc(l.meet_link)}" target="_blank" rel="noopener noreferrer">Join</a>` : '') + (new Date(l.ends_at) < new Date() ? btn('fb-live', 'Feedback') : ''),
    empty: sub ? 'No classes scheduled yet.' : 'Live training and mentor rooms come with a plan.' });
    const bCard = tableCard({ title: '1:1 sessions', rows: ses.bookings, columns: [
      { h: 'When', render: (b) => `<span class="when">${esc(dt(b.scheduled_at))}</span><span class="sub-line">${b.duration} min</span>` },
      { h: 'Session', cls: 'strong', render: (b) => `${esc(b.service || label(b.kind))}<span class="sub-line">${esc(b.mentor_name || '')}${b.price_paise ? ` · ${inr(b.price_paise)}` : ''}</span>` },
      { h: 'Status', render: (b) => statusPill(b.status) },
    ], rowActions: (b) => (b.meeting_link && b.status === 'scheduled' ? `<a class="btn btn-ghost btn-sm" href="${esc(b.meeting_link)}" target="_blank" rel="noopener noreferrer">Join</a>` : '')
      + (['scheduled', 'requested', 'pending_payment'].includes(b.status) && new Date(b.scheduled_at) > new Date() ? btn('cancel', 'Cancel', 'btn-danger') : '')
      + (b.status === 'completed' ? btn('fb', 'Feedback') : ''), empty: 'No 1:1 sessions yet.' });
    main.append(lCard, bCard);
    main.querySelector('[data-ck]')?.addEventListener('click', async () => {
      const mid = me.group?.mentor_id || me.mentor_id;
      if (!mid) return toast('Your mentor hasn’t been assigned yet. The Anvaya team will set this up soon.', true);
      await slotPicker(mid, `Check-up with ${esc(me.group?.mentor_name || me.mentor_name || 'your mentor')}`, async (s) => {
        await api('/api/student/bookings/checkup', { method: 'POST', body: { mentor_id: mid, scheduled_at: s } }); toast('Check-up booked — confirmation emailed'); refresh();
      });
    });
    main.querySelector('[data-paid]').addEventListener('click', () => {
      const avail = mentors.filter((m) => m.accepts_paid_sessions);
      const ui = modal(`<div class="eyebrow">Private session</div><h2 class="h2 mb-2">Choose a <em>mentor</em></h2><p class="hint mb-2">Paid separately from your plan. The full fee goes to the mentor.</p>
        <div class="grid-2">${avail.map((m) => `<div class="card tile"><h3 class="h2">${esc(m.name)}</h3><p class="small muted">${esc(m.expertise)}</p><p class="price">${inr(m.session_price_paise)}</p><p class="small muted mb-2">${m.session_duration} min${m.session_details ? ` · ${esc(m.session_details)}` : ''}</p><button class="btn btn-primary btn-sm" data-m="${m.id}">See times</button></div>`).join('') || '<p class="muted">No mentors are taking private sessions right now.</p>'}</div>`, { wide: true });
      ui.el.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', async () => {
        const m = avail.find((x) => x.id === Number(b.dataset.m)); ui.close();
        await slotPicker(m.id, `${esc(m.name)} · ${inr(m.session_price_paise)}`, async (s) => {
          const r = await api('/api/student/bookings/paid', { method: 'POST', body: { mentor_id: m.id, scheduled_at: s } });
          await pay(r.checkout, { onDone: refresh });
        });
      }));
    });
    onAct(bCard, {
      cancel: async (i) => { if (!await confirmBox('Cancel this session?', 'Check-ups are returned to your plan allowance. For paid sessions, the team will contact you about a refund or a new time.', { danger: true, ok: 'Cancel session' })) return; const r = await api(`/api/student/bookings/${i}/cancel`, { method: 'POST', body: {} }); toast(r.refund || 'Cancelled'); refresh(); },
      fb: (i) => feedbackModal({ booking_id: i }),
    });
    onAct(lCard, { 'fb-live': (i) => feedbackModal({ live_session_id: i }) });
  }

  // ── Services (resume / LinkedIn / coaching + digital products) ───────
  async function services() {
    const [cases, products] = await Promise.all([api('/api/student/services'), api('/api/student/products')]);
    main.innerHTML = pageHead('Services', 'Your <em>services</em>', 'Resume and LinkedIn rewrites, coaching packages and digital products you’ve bought.');
    if (!cases.length && !products.length) main.innerHTML += '<div class="card card-pad reveal"><p class="sub mb-2">Nothing here yet.</p><a class="btn btn-primary btn-sm" href="#shop">Browse services</a></div>';
    for (const c of cases) {
      const card = document.createElement('div');
      card.className = 'card card-pad reveal mb-3';
      const steps = ['intake', 'assigned', 'first_draft', 'coach_edit', 'qa', 'delivered'];
      const at = Math.max(0, steps.indexOf(c.status === 'revision' ? 'coach_edit' : c.status === 'closed' ? 'delivered' : c.status));
      card.innerHTML = `<div class="row-between mb-1"><h2 class="h2">${esc(c.product_name || label(c.kind))}</h2>${statusPill(c.status)}</div>
        <p class="small muted mb-2">${c.coach_name ? `Coach: ${esc(c.coach_name)} · ` : ''}${c.due_at && c.status !== 'delivered' ? `Expected by ${esc(d(c.due_at))} · ` : ''}Revisions ${c.revisions_used}/${c.revisions_allowed}</p>
        <div class="chips mb-2">${['Intake', 'Coach assigned', 'First draft', 'Coach edit', 'Quality check', 'Delivered'].map((s, i) => `<span class="chip ${i <= at ? 'on' : ''}">${s}</span>`).join('')}</div>
        ${['intake', 'assigned'].includes(c.status) ? '<p class="small mb-1">Share the facts your coach should work from — roles, projects, numbers, tools, achievements. We only use what you tell us.</p><button class="btn btn-ghost btn-sm" data-facts>Add my details</button>' : ''}
        ${c.documents.map((x) => (x.latest_version_id ? `<button class="btn btn-primary btn-sm" data-open="${x.latest_version_id}">Download: ${esc(x.title)}</button> ` : '')).join('')}
        ${c.status === 'delivered' && c.revisions_used < c.revisions_allowed ? '<button class="btn btn-ghost btn-sm" data-rev>Request a revision</button>' : ''}
        ${c.status === 'delivered' ? '<button class="btn btn-ghost btn-sm" data-fb>Feedback</button>' : ''}`;
      main.appendChild(card);
      card.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => A.openFile(b.dataset.open)));
      card.querySelector('[data-facts]')?.addEventListener('click', async () => { await formModal({ eyebrow: 'Your details', title: 'What should your coach <em>work from?</em>', fields: [{ name: 'source_facts', label: 'Roles, projects, results (with numbers where you have them), tools, awards', type: 'textarea', span2: true, rows: 10 }], onSave: (b) => api(`/api/student/services/${c.id}/intake`, { method: 'POST', body: b }) }); toast('Sent to your coach'); });
      card.querySelector('[data-rev]')?.addEventListener('click', async () => { await formModal({ eyebrow: 'Revision', title: 'What should <em>change?</em>', fields: [{ name: 'note', label: 'Details', type: 'textarea', span2: true, required: true }], onSave: (b) => api(`/api/student/services/${c.id}/revision`, { method: 'POST', body: b }) }); toast('Revision requested'); refresh(); });
      card.querySelector('[data-fb]')?.addEventListener('click', () => feedbackModal({ case_id: c.id }));
    }
    if (products.length) {
      main.appendChild(tableCard({ title: 'Digital products', rows: products, columns: [{ h: 'Product', cls: 'strong', render: (p) => `${esc(p.name)}<span class="sub-line">${esc(p.description || '')}</span>` }],
        rowActions: (p) => (p.version_id ? `<button class="btn btn-primary btn-sm" data-act="dl" data-id="${p.version_id}">Download</button>` : '<span class="muted small">Being prepared</span>') }));
      onAct(main, { dl: (v) => A.openFile(v) });
    }
  }

  // ── Shop ─────────────────────────────────────────────────────────────
  async function shop() {
    const [cat, orders, me] = await Promise.all([api('/api/student/catalog'), api('/api/student/orders'), api('/api/student/me')]);
    const plans = cat.filter((p) => p.kind === 'subscription_plan');
    const others = cat.filter((p) => p.kind !== 'subscription_plan');
    const per = { week: 'week', month: 'month', quarter: '3 months', half_year: '6 months', year: 'year' };
    const tile = (p) => `<div class="card card-gold tile"><div class="eyebrow">${esc(label(p.kind))}</div><h3 class="h2">${esc(p.name)}</h3>
      <p class="price">${inr(p.price_paise)}${p.billing_period !== 'one_time' ? `<span class="muted small"> / ${esc(per[p.billing_period])}</span>` : ''}</p>
      ${p.description ? `<p class="small muted mb-2">${esc(p.description)}</p>` : ''}
      ${p.entitlements.length ? `<ul class="list small mb-2">${p.entitlements.map((e) => `<li><span>${esc(ENT_LABEL[e.key] || label(e.key))}</span><span class="muted">${e.limit_count != null ? `${e.limit_count} / ${PER[e.per_period]}` : '✓'}</span></li>`).join('')}</ul>` : ''}
      <button class="btn btn-primary btn-sm btn-block" data-buy="${p.id}">${p.kind === 'subscription_plan' && me.subscription?.product_id === p.id ? 'Renew' : 'Buy'}</button></div>`;
    main.innerHTML = pageHead('Plans &amp; services', 'Choose what <em>helps</em>', `Payments are processed securely${me.payments_provider === 'razorpay' ? ' by Razorpay' : '. The Anvaya team will share payment details'}.`)
      + (plans.length ? `<div class="section-label">Shortlist Club plans</div><div class="grid-3 reveal mb-3">${plans.map(tile).join('')}</div>` : '')
      + (others.length ? `<div class="section-label">Services &amp; products</div><div class="grid-3 reveal mb-3">${others.map(tile).join('')}</div>` : '')
      + (!cat.length ? '<div class="card empty">Plans will be published soon.</div>' : '');
    main.appendChild(tableCard({ title: 'Your orders', rows: orders, columns: [{ h: 'Order', cls: 'strong', render: (o) => `${esc(o.product_name || o.description)}<span class="sub-line">#${o.id} · ${esc(dt(o.created_at))}</span>` }, { h: 'Amount', render: (o) => inr(o.amount_paise) }, { h: 'Status', render: (o) => statusPill(o.status) }], empty: 'No orders yet.' }));
    main.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const r = await api('/api/student/orders', { method: 'POST', body: { product_id: Number(b.dataset.buy) } }); await pay(r.checkout, { onDone: refresh }); }
      catch (e) { toast(e.message, true); } finally { b.disabled = false; }
    }));
  }

  // ── Applications & outcomes ──────────────────────────────────────────
  const STAGES = [['applied', 'Applied'], ['shortlisted', 'Shortlisted'], ['interview', 'Interview'], ['offer', 'Offer'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn']];
  const appFields = [{ name: 'company', label: 'Company', required: true }, { name: 'role_title', label: 'Role' }, { name: 'stage', label: 'Stage', type: 'select', options: STAGES }, { name: 'applied_on', label: 'Applied on', type: 'date' }, { name: 'notes', label: 'Notes', type: 'textarea', span2: true }];
  async function outcomes() {
    const rows = await api('/api/student/applications');
    const count = (s) => rows.filter((r) => r.stage === s).length;
    main.innerHTML = pageHead('Outcomes', 'Your <em>applications</em>', 'Track applications, shortlists, interviews and offers. Your mentor sees your progress and celebrates every win.', '<button class="btn btn-primary" data-new>+ Add application</button>')
      + `<div class="stats reveal">${stat(rows.length, 'Applications')}${stat(count('shortlisted') + count('interview'), 'Shortlists &amp; interviews')}${stat(count('offer') + count('accepted'), 'Offers')}${stat(count('rejected'), 'Rejections (data, not defeat)')}</div>`;
    const card = tableCard({ rows, filter: { key: 'stage', options: STAGES }, columns: [
      { h: 'Company', cls: 'strong', render: (a) => `${esc(a.company)}<span class="sub-line">${esc(a.role_title)}</span>` }, { h: 'Stage', render: (a) => statusPill(a.stage) },
      { h: 'Updated', render: (a) => esc(d(a.updated_at)) },
    ], rowActions: () => btn('edit', 'Update') + btn('del', 'Remove', 'btn-danger'), empty: 'Add your first application to start tracking.' });
    main.appendChild(card);
    main.querySelector('[data-new]').addEventListener('click', async () => { await formModal({ eyebrow: 'Application', title: 'Add an <em>application</em>', fields: appFields, values: { stage: 'applied', applied_on: new Date().toISOString().slice(0, 10) }, onSave: (b) => api('/api/student/applications', { method: 'POST', body: b }) }); refresh(); });
    onAct(card, {
      edit: async (i) => { await formModal({ eyebrow: 'Application', title: esc(rows.find((r) => r.id === i).company), fields: appFields, values: rows.find((r) => r.id === i), onSave: (b) => api(`/api/student/applications/${i}`, { method: 'PATCH', body: b }) }); toast('Updated'); refresh(); },
      del: async (i) => { if (await confirmBox('Remove application?', 'This only removes it from your tracker.', { danger: true, ok: 'Remove' })) { await api(`/api/student/applications/${i}`, { method: 'DELETE' }); refresh(); } },
    });
  }

  // ── Feedback ─────────────────────────────────────────────────────────
  async function feedbackModal(ref = {}) {
    await formModal({ eyebrow: 'Feedback', title: 'How did it <em>go?</em>', fields: [
      { name: 'rating', label: 'Rating', type: 'select', options: [['5', '5 — Excellent'], ['4', '4 — Good'], ['3', '3 — Okay'], ['2', '2 — Poor'], ['1', '1 — Bad']] },
      { name: 'comments', label: 'Comments', type: 'textarea', span2: true }], submit: 'Send', onSave: (b) => api('/api/student/feedback', { method: 'POST', body: { ...b, ...ref } }) });
    toast('Thank you for the feedback');
  }
  async function feedback() {
    main.innerHTML = pageHead('Feedback', 'Tell us <em>anything</em>', 'What’s working, what isn’t, what you need. It goes straight to the Anvaya team.') + '<div class="card card-pad reveal"><form id="fb" novalidate><div class="form-error" hidden></div><div class="form-grid">'
      + A.fieldHtml({ name: 'rating', label: 'Overall', type: 'select', options: [['5', '5 — Excellent'], ['4', '4 — Good'], ['3', '3 — Okay'], ['2', '2 — Poor'], ['1', '1 — Bad']] })
      + A.fieldHtml({ name: 'comments', label: 'Your feedback', type: 'textarea', span2: true, rows: 6 }) + '</div><button class="btn btn-primary" type="submit">Send feedback</button></form></div>';
    onSubmit(main.querySelector('#fb'), async (data) => { await api('/api/student/feedback', { method: 'POST', body: data }); toast('Thank you!'); main.querySelector('#fb').reset(); });
  }

  const views = { home, intake, learn, sessions, services, shop, outcomes, feedback };
  let current = 'home';
  async function render(tab = current) {
    current = views[tab] ? tab : 'home';
    const fresh = main.cloneNode(false); main.replaceWith(fresh); main = fresh;
    main.innerHTML = '<p class="sub">Loading…</p>';
    try { await views[current](); } catch (e) { main.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  }
  A.shell(render, meAuth.student && !meAuth.student.intake_completed ? 'intake' : 'home');
})();
