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

  // ── Home: what next, when, what's included, progress, who can help ──
  const MS_ICON = (m) => (m.done ? '✓ ' : '');
  async function home() {
    const [h, msgs] = await Promise.all([api('/api/student/home'), api('/api/student/messages')]);
    const sub = h.subscription;
    const pay = h.payment.status === 'verified' ? `<span class="pill ok">Payment verified${h.payment.provider === 'razorpay' ? ' · Razorpay' : ''}${h.payment.paid_at ? ` · ${esc(d(h.payment.paid_at))}` : ''}</span>`
      : h.payment.status === 'none' ? '<span class="pill off">No active plan</span>' : '<span class="pill">Payment recorded</span>';
    const sessions = [...h.sessions.bookings.map((b) => ({ ...b, t: b.scheduled_at, type: 'booking' })), ...h.sessions.live.map((l) => ({ ...l, t: l.starts_at, type: 'live', service: l.title }))]
      .sort((a, b) => new Date(a.t) - new Date(b.t)).slice(0, 5);
    const left = (e) => (e.limit_count == null ? 'Included' : `${Math.max(0, e.limit_count - (e.used || 0))} of ${e.limit_count} left`);
    const pct = h.progress.total ? Math.round((h.progress.done / h.progress.total) * 100) : 0;
    main.innerHTML = `<div class="page-head reveal"><div><div class="eyebrow">${esc(h.student.track_name || 'Your preparation')}</div><h1 class="title">Hi, <em>${esc(h.student.name.split(' ')[0])}</em></h1></div>
        <div class="row wrap">${pay}${sub ? `<span class="pill">${esc(sub.plan_name)} · until ${esc(d(sub.paid_through))}</span>` : ''}</div></div>
      ${blockedNotice(h)}
      <section class="next-card reveal mb-3"><div><div class="eyebrow">Your next step</div><h2 class="h2">${esc(h.next.title)}</h2>${h.next.detail ? `<p class="small">${esc(h.next.kind === 'session' ? dt(h.next.detail) : h.next.detail)}</p>` : ''}</div>
        <a class="btn btn-primary" href="${esc(h.next.href)}">${esc(h.next.cta)} →</a></section>
      <div class="section-label">Preparation <span class="muted small">${h.milestones.filter((m) => m.done).length} of ${h.milestones.length} · payment is shown separately above</span></div>
      <div class="ms-grid reveal mb-3">${h.milestones.map((m) => `<div class="ms ${m.done ? 'done' : ''}"><span>${MS_ICON(m)}${esc(m.label)}</span><span class="sub-line">${m.done ? (m.at ? esc(d(m.at)) : esc(m.detail || 'Done')) : esc(m.detail || 'Not yet')}</span></div>`).join('')}</div>
      <div class="home-grid">
        <div class="home-col">
          <div class="card reveal"><div class="card-head"><h2 class="h2">Upcoming <em>sessions</em></h2><a class="link-btn" href="#sessions">All sessions →</a></div>
            <ul class="list">${sessions.map((x) => `<li class="sess"><div><span class="strong">${esc(x.service)}</span><span class="sub-line">${esc(dt(x.t))}${x.mentor_name ? ` · ${esc(x.mentor_name)}` : ''}</span>
              <span class="pill ${x.type === 'live' ? 'off' : x.kind === 'checkup' ? '' : 'ok'}">${x.type === 'live' ? 'Group session · included' : x.kind === 'checkup' ? 'Included check-up' : 'Paid session'}</span>${x.type === 'live' ? '' : ` ${bookingState(x)}`}
              ${x.shared_notes ? `<span class="sub-line">Mentor notes: ${esc(x.shared_notes)}</span>` : ''}</div>
              <div class="row wrap">${x.type === 'live' ? (x.meet_link ? `<a class="btn btn-ghost btn-sm" href="${esc(x.meet_link)}" target="_blank" rel="noopener noreferrer">Join</a>` : '')
                : bookingActions(x)}</div></li>`).join('')
              || `<li class="muted small">Nothing booked yet.${sub ? ' <a href="#sessions">Book your check-up</a> or <a href="#mentors">find a mentor</a>.' : ''}</li>`}</ul>
            <p class="small muted pad">${esc(h.policy)}</p></div>
          <div class="card reveal"><div class="card-head"><h2 class="h2">Syllabus &amp; <em>progress</em></h2><a class="link-btn" href="#learn">Open syllabus →</a></div>
            <div class="pad"><div class="meter"><i data-pct="${pct}"></i></div><p class="small muted mt-1">${h.progress.total ? `${h.progress.done} of ${h.progress.total} assignments submitted (${pct}%)` : 'Your syllabus appears once you’re enrolled in a track.'}</p></div></div>
          <div class="card reveal"><div class="card-head"><h2 class="h2">Messages from <em>Anvaya</em></h2><a class="link-btn" href="#support">Support →</a></div>
            <ul class="list small">${msgs.filter((m) => m.author_role !== 'student').slice(0, 3).map((m) => `<li><span>${esc(m.body)}<span class="sub-line">${esc(m.author)} · ${esc(dt(m.created_at))}</span></span></li>`).join('') || '<li class="muted">No messages yet.</li>'}</ul></div>
        </div>
        <div class="home-col">
          <div class="card card-pad reveal"><div class="section-label">Your plan includes</div>
            ${sub ? `<ul class="list tight small">${sub.entitlements.map((e) => `<li><span>${esc(ENT_LABEL[e.key] || label(e.key))}</span><span class="strong">${esc(left(e))}</span></li>`).join('')}</ul>
              <p class="small muted mt-1">Valid until ${esc(d(sub.paid_through))}. Paid mentor sessions are separate and don’t use these.</p>`
              : '<p class="small muted mb-2">No active plan. Plans include the syllabus, live training, mentor rooms and check-ups.</p><a class="btn btn-primary btn-sm" href="#shop">See plans</a>'}</div>
          <div class="card card-pad reveal"><div class="section-label">Who can help</div>
            <ul class="list tight small">${h.group ? `<li><span><strong class="ivory">${esc(h.group.mentor_name || 'Mentor to be assigned')}</strong><span class="sub-line">Your group mentor · ${esc(h.group.name)}</span></span></li>` : '<li class="muted">You’ll be matched to a group and mentor after intake.</li>'}
              <li><span><strong class="ivory">Anvaya team</strong><span class="sub-line">Questions about sessions, plans or payments</span></span><a class="btn btn-ghost btn-sm" href="#support">Ask</a></li>
              ${h.group?.whatsapp_link ? `<li><span><strong class="ivory">Community</strong><span class="sub-line">Your group’s WhatsApp</span></span><a class="btn btn-ghost btn-sm" href="${esc(h.group.whatsapp_link)}" target="_blank" rel="noopener noreferrer">Open</a></li>` : ''}
              <li><span><strong class="ivory">Mentors</strong><span class="sub-line">Book a paid 1:1 with any mentor</span></span><a class="btn btn-ghost btn-sm" href="#mentors">Browse</a></li></ul></div>
          <div class="card card-pad reveal"><div class="section-label">Support requests</div>
            <ul class="list tight small">${h.support.map((c) => `<li><span>${esc(c.subject)}<span class="sub-line">${esc(dt(c.updated_at))}</span></span>${statusPill(c.status)}</li>`).join('') || '<li class="muted">None. <a href="#support">Raise a request</a> if you need help.</li>'}</ul></div>
        </div></div>`;
    main.querySelectorAll('[data-pct]').forEach((el) => { el.style.width = `${Number(el.dataset.pct)}%`; }); // CSSOM, allowed by the strict CSP
    bindSessionActions(main);
  }
  /** Where a 1:1 stands, in the student's words. */
  function bookingState(b) {
    if (b.status === 'requested') return b.has_proposal ? '<span class="pill">New time suggested</span>' : '<span class="pill">Requested · awaiting confirmation</span>';
    if (b.status === 'pending_payment') return '<span class="pill">Approved · pay to confirm</span>';
    if (b.status === 'scheduled') return b.meeting_link ? '<span class="pill ok">Confirmed</span>' : '<span class="pill ok">Confirmed · Meet link on its way</span>';
    return statusPill(b.status);
  }
  function bookingActions(b) {
    const upcoming = new Date(b.scheduled_at) > new Date();
    return [
      b.status === 'scheduled' && upcoming ? (b.can_join ? `<a class="btn btn-primary btn-sm" href="${esc(b.meeting_link)}" target="_blank" rel="noopener noreferrer">Join Meet</a>` : `<button class="btn btn-ghost btn-sm" disabled title="${b.meeting_link ? 'Opens 10 minutes before' : 'The Meet link arrives with your confirmation'}">Join</button>`) : '',
      b.status === 'pending_payment' ? `<button class="btn btn-primary btn-sm" data-pay="${b.id}">Pay to confirm</button>` : '',
      b.status === 'requested' && b.has_proposal ? `<button class="btn btn-primary btn-sm" data-accept="${b.id}">Accept new time</button>` : '',
      b.can_reschedule ? `<button class="btn btn-ghost btn-sm" data-move="${b.id}" data-m="${b.mentor_id}" data-svc="${b.service_id || ''}">Reschedule</button>` : '',
      b.can_cancel ? `<button class="btn btn-ghost btn-sm" data-cancel="${b.id}">${b.status === 'scheduled' ? 'Cancel' : 'Withdraw'}</button>` : '',
      b.reschedule_used && b.status === 'scheduled' && upcoming && !b.needs_exception ? '<span class="small muted" title="One reschedule per plan">Reschedule used</span>' : '',
      b.needs_exception ? `<button class="btn btn-ghost btn-sm" data-exception="${b.id}" title="Less than 24 hours away: changes need the Anvaya team">Request a change</button>` : '',
    ].join('');
  }
  function blockedNotice(x) {
    if (!x.booking_blocked) return '';
    const ns = x.no_show;
    return `<div class="notice bad reveal">New bookings are paused because a session was recorded as missed${ns ? ` (${esc(d(ns.marked_at))})` : ''}. Your plan, materials and existing sessions are unaffected.
      ${ns && !ns.disputed_at ? ' If this is wrong, <button class="link-btn" data-dispute>dispute it</button> and the team will review it.' : ' Your dispute is with the Anvaya team; we’ll email you once it’s reviewed.'}</div>`;
  }
  function disputeModal() {
    return A.formModal({ eyebrow: 'Missed session', title: 'Dispute this <em>no-show</em>', intro: '<p class="small muted mb-2">Tell us what happened (for example, you joined but the host didn’t, or the link didn’t work). An admin reviews it and emails you.</p>',
      fields: [{ name: 'body', label: 'What happened', type: 'textarea', required: true, span2: true, rows: 5 }], onSave: (body) => api('/api/student/no-show/dispute', { method: 'POST', body }) })
      .then(() => { toast('Dispute sent. We’ll email you after review.'); refresh(); });
  }
  function bindSessionActions(root) {
    root.querySelectorAll('[data-dispute]').forEach((b) => b.addEventListener('click', () => disputeModal().catch(() => {})));
    root.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
      try { const r = await api(`/api/student/bookings/${b.dataset.pay}/pay`, { method: 'POST' }); await pay(r.checkout, { onDone: refresh }); } catch (e) { toast(e.message, true); }
    }));
    root.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', async () => {
      try { const r = await api(`/api/student/bookings/${b.dataset.accept}/accept-proposal`, { method: 'POST' }); toast(r.next === 'payment' ? 'Accepted — pay to confirm the session' : 'Accepted — your confirmation email is on its way'); refresh(); } catch (e) { toast(e.message, true); }
    }));
    root.querySelectorAll('[data-exception]').forEach((b) => b.addEventListener('click', () => {
      A.formModal({ eyebrow: 'Less than 24 hours away', title: 'Request a <em>change</em>', intro: '<p class="small muted mb-2">Online changes close 24 hours before the start, and a late change normally counts the session as used (see our <a href="https://anvayacareers.in/refund-policy.html" target="_blank" rel="noopener">Refund &amp; Rescheduling Policy</a>). In a genuine emergency, tell the Anvaya team what happened and we’ll see what we can do.</p>',
        fields: [{ name: 'body', label: 'What do you need?', type: 'textarea', required: true, span2: true, rows: 4 }],
        onSave: (x) => api('/api/student/support', { method: 'POST', body: { subject: `Change request for session #${b.dataset.exception}`, category: 'reschedule_exception', body: x.body } }) })
        .then(() => toast('Sent to the Anvaya team')).catch(() => {});
    }));

    root.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
      const q = b.dataset.svc ? `?service_id=${b.dataset.svc}` : '';
      slotPicker(Number(b.dataset.m), 'Pick a <em>new time</em>', async (s) => {
        await api(`/api/student/bookings/${b.dataset.move}/reschedule`, { method: 'POST', body: { scheduled_at: s } }); toast('Moved. We’ve emailed the new time.'); refresh();
      }, q, { moving: true });
    }));
    root.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      if (!await confirmBox('Cancel this session?', 'Your host is told and the slot is released. Check-ups go back to your plan allowance. Paid sessions you cancel aren’t refunded under our policy; if you only need a different time, reschedule instead (once per plan, at least 24 hours before).', { danger: true, ok: 'Cancel session' })) return;
      const r = await api(`/api/student/bookings/${b.dataset.cancel}/cancel`, { method: 'POST', body: {} }); toast(r.refund || 'Cancelled'); refresh();
    }));
  }

  // ── Mentors: discovery → profile → service → slot → questions → payment → confirmation ──
  async function mentors() {
    const st = { expertise: '', role: '', max_price: '', available: '' };
    main.innerHTML = pageHead('Mentors', 'Find a <em>mentor</em>', 'Private 1:1 sessions are paid separately from your plan, and the full stated fee goes to the mentor.')
      + `<div class="card reveal mb-3"><div class="toolbar"><input class="input" data-f="expertise" placeholder="Expertise (e.g. product, consulting)" aria-label="Expertise">
        <input class="input" data-f="role" placeholder="Target role (e.g. APM)" aria-label="Target role">
        <select class="input" data-f="max_price" aria-label="Price"><option value="">Any price</option><option value="100000">Up to ₹1,000</option><option value="200000">Up to ₹2,000</option><option value="350000">Up to ₹3,500</option></select>
        <select class="input" data-f="available" aria-label="Availability"><option value="">Any availability</option><option value="week">Free this week</option></select></div></div>
      <div class="m-grid" id="mlist"><p class="sub">Loading…</p></div>`;
    const list = main.querySelector('#mlist');
    const draw = async () => {
      const qs = new URLSearchParams(Object.entries(st).filter(([, v]) => v)).toString();
      const ms = await api(`/api/student/mentors?${qs}`);
      list.innerHTML = ms.map((m) => `<div class="card m-card"><div class="row"><span class="avatar">${esc(m.name.split(' ').map((x) => x[0]).join('').slice(0, 2))}</span>
          <div><h3 class="h2">${esc(m.name)}</h3><p class="small muted">${esc(m.headline || m.expertise)}${m.years_experience != null ? ` · ${m.years_experience} yrs` : ''}</p></div></div>
          <p class="small mt-1">${esc((m.bio || '').slice(0, 180))}${(m.bio || '').length > 180 ? '…' : ''}</p>
          <ul class="list tight small">${m.services.map((x) => `<li><span>${esc(x.title)}<span class="sub-line">${x.duration_min} min</span></span><span class="strong">${inr(x.price_paise)}</span></li>`).join('') || '<li class="muted">No bookable services yet.</li>'}</ul>
          ${m.services.length ? `<button class="btn btn-primary btn-sm mt-1" data-profile="${m.id}">View &amp; book</button>` : ''}</div>`).join('')
        || '<div class="card card-pad"><p class="muted">No mentors match these filters yet.</p></div>';
      list.querySelectorAll('[data-profile]').forEach((b) => b.addEventListener('click', () => profile(ms.find((x) => x.id === Number(b.dataset.profile)))));
    };
    let timer;
    main.querySelectorAll('[data-f]').forEach((el) => el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => { clearTimeout(timer); timer = setTimeout(() => { st[el.dataset.f] = el.value; draw(); }, 300); }));
    await draw();
  }
  function profile(m) {
    const ui = modal(`<div class="eyebrow">Mentor</div><h2 class="h2 mb-1">${esc(m.name)}</h2><p class="small muted mb-2">${esc(m.headline || m.expertise)}${m.years_experience != null ? ` · ${m.years_experience} years’ experience` : ''}${m.target_roles ? ` · Prepares for ${esc(m.target_roles)}` : ''}</p>
      <p class="small mb-2 pre-line">${esc(m.bio || '')}</p><div class="section-label">1. Choose a service</div>
      <ul class="list tight">${m.services.map((x) => `<li><span><strong class="ivory">${esc(x.title)}</strong><span class="sub-line">${x.duration_min} min${x.description ? ` · ${esc(x.description)}` : ''}</span></span>
        <span class="row"><span class="strong">${inr(x.price_paise)}</span><button class="btn btn-primary btn-sm" data-svc="${x.id}">Choose</button></span></li>`).join('')}</ul>
      <p class="hint">Steps: service → time → a few questions → your mentor approves → payment → confirmation with the Google Meet link.</p>`, { wide: true });
    ui.el.querySelectorAll('[data-svc]').forEach((b) => b.addEventListener('click', () => {
      const svc = m.services.find((x) => x.id === Number(b.dataset.svc)); ui.close();
      slotPicker(m.id, `2. Pick a time · ${esc(svc.title)}`, async (slot) => {
        const answers = await intakeQuestions(svc);
        if (!answers) throw new Error('Booking not started.');
        const r = await api('/api/student/bookings/paid', { method: 'POST', body: { mentor_id: m.id, scheduled_at: slot, service_id: svc.id, intake_answers: answers } });
        requested(r.hold_expires_at, 'paid'); location.hash = 'sessions';
      }, `?service_id=${svc.id}`, { kind: 'paid_session', service_id: svc.id });
    }));
  }
  function intakeQuestions(svc) {
    const qs = Array.isArray(svc.intake_questions) ? svc.intake_questions : [];
    if (!qs.length) return Promise.resolve({});
    return new Promise((resolve) => {
      const ui = modal(`<div class="eyebrow">3. A few questions</div><h2 class="h2 mb-2">Help your mentor <em>prepare</em></h2><form novalidate><div class="form-error" hidden></div>
        ${qs.map((q) => `<div class="field"><label class="label">${esc(q.label)}${q.required ? ' *' : ''}</label><textarea class="input" name="${esc(q.id)}" rows="2"${q.required ? ' required' : ''}></textarea></div>`).join('')}
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Back</button><button class="btn btn-primary" type="submit">Send request</button></div></form>`, { onClose: () => resolve(null) });
      onSubmit(ui.el.querySelector('form'), async (d2) => { resolve(d2); ui.close(); });
    });
  }

  // ── Support & messages ───────────────────────────────────────────
  async function support() {
    const [cases, msgs] = await Promise.all([api('/api/student/support'), api('/api/student/messages')]);
    main.innerHTML = pageHead('Support', 'Help &amp; <em>messages</em>', 'Ask the Anvaya team anything about sessions, plans, payments or your mentor. Replies appear here.', '<button class="btn btn-primary" data-new>+ New request</button>')
      + `<div class="grid-2 reveal"><div class="card"><div class="card-head"><h2 class="h2">Your <em>requests</em></h2></div><ul class="list small">${cases.map((c) => `<li class="col"><div class="row-between"><strong class="ivory">${esc(c.subject)}</strong>${statusPill(c.status)}</div>
          <ol class="thread">${c.history.map((h2) => `<li><span class="sub-line">${esc(h2.author)} · ${esc(dt(h2.created_at))}</span>${esc(h2.body)}</li>`).join('')}</ol>
          ${c.status !== 'resolved' ? `<form data-reply="${c.id}" novalidate class="row wrap"><input class="input" name="body" placeholder="Reply…" required aria-label="Reply"><button class="btn btn-ghost btn-sm" type="submit">Send</button></form>` : ''}</li>`).join('') || '<li class="muted">No requests yet.</li>'}</ul></div>
        <div class="card"><div class="card-head"><h2 class="h2">Messages from <em>Anvaya</em></h2></div><ul class="list small">${msgs.filter((m) => !m.support_case_id && m.author_role !== 'student').map((m) => `<li><span>${esc(m.body)}<span class="sub-line">${esc(m.author)} · ${esc(dt(m.created_at))}</span></span></li>`).join('') || '<li class="muted">No messages yet.</li>'}</ul></div></div>`;
    main.querySelector('[data-new]').addEventListener('click', async () => {
      await formModal({ eyebrow: 'Support', title: 'New <em>request</em>', fields: [{ name: 'subject', label: 'Subject', required: true, span2: true },
        { name: 'category', label: 'Topic', type: 'select', options: [['general', 'General'], ['sessions', 'Sessions'], ['payments', 'Payments'], ['technical', 'Technical'], ['mentor', 'My mentor'], ['other', 'Other']] },
        { name: 'body', label: 'Message', type: 'textarea', required: true, span2: true }], onSave: (b) => api('/api/student/support', { method: 'POST', body: b }) });
      toast('Request sent. We usually reply within a working day.'); refresh();
    });
    main.querySelectorAll('[data-reply]').forEach((f) => onSubmit(f, async (b) => { await api(`/api/student/support/${f.dataset.reply}/reply`, { method: 'POST', body: b }); toast('Reply sent'); refresh(); }));
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
  function requested(holdUntil, kind) {
    modal(`<div class="eyebrow">Request sent</div><h2 class="h2 mb-2">Your slot is <em>held</em></h2>
      <p class="sub mb-2">This isn’t confirmed yet. Your mentor reviews it${holdUntil ? ` before ${esc(dt(holdUntil))} IST` : ''}${kind === 'paid' ? '; once approved you’ll be asked to pay' : ''}. Your confirmation email includes the Google Meet link and calendar invite.</p>
      <div class="modal-actions"><button class="btn btn-primary" data-close>OK</button></div>`);
  }
  function preferredModal(mentorId, extra = {}) {
    return A.formModal({ eyebrow: 'No time works?', title: 'Send your <em>preferred times</em>', intro: '<p class="small muted mb-2">The team will try to arrange a session and email you. Times in IST.</p>',
      fields: [{ name: 'preferred', label: 'Dates and times that suit you', type: 'textarea', required: true, span2: true, rows: 4, placeholder: 'e.g. Tue or Thu after 7 pm, or Saturday morning' }],
      onSave: (b) => api('/api/student/session-requests', { method: 'POST', body: { ...b, mentor_id: mentorId, kind: extra.kind || 'checkup', service_id: extra.service_id } }) })
      .then(() => toast('Sent. We’ll be in touch.')).catch(() => {});
  }
  async function slotPicker(mentorId, title, onPick, query = '', extra = {}) {
    const [slots, pol] = await Promise.all([api(`/api/student/mentors/${mentorId}/slots${query}`), api('/api/student/sessions').then((x) => x).catch(() => ({}))]);
    if (pol.booking_blocked && !extra.moving) { toast('New bookings are paused after a missed session. You can dispute it from your dashboard.', true); return; }
    let chosen = null;
    const byDay = {};
    for (const s of slots) (byDay[d(s)] ||= []).push(s);
    const ui = modal(`<div class="eyebrow">Choose a time (IST)</div><h2 class="h2 mb-2">${title}</h2>
      ${slots.length ? Object.entries(byDay).map(([day, list]) => `<div class="section-label">${esc(day)}</div><div class="slot-grid mb-2">${list.map((s) => `<button type="button" class="slot-btn" data-s="${s}">${esc(A.time(s))}</button>`).join('')}</div>`).join('') : '<p class="muted">No open slots in the booking window. Try another mentor or check back soon.</p>'}
      ${extra.moving ? '' : '<p class="small mb-2"><button type="button" class="link-btn" data-prefs>None of these work? Send your preferred times →</button></p>'}
      ${pol.policy ? `<p class="hint mb-2">${esc(pol.policy)}</p>` : ''}
      <div class="form-error" hidden></div><div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-go disabled>${extra.moving ? 'Move session' : 'Request this time'}</button></div>`, { wide: true });
    ui.el.querySelector('[data-prefs]')?.addEventListener('click', () => { ui.close(); preferredModal(mentorId, extra); });
    ui.el.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => { ui.el.querySelectorAll('.slot-btn').forEach((x) => x.classList.remove('on')); b.classList.add('on'); chosen = b.dataset.s; ui.el.querySelector('[data-go]').disabled = false; }));
    ui.el.querySelector('[data-go]').addEventListener('click', async (e) => {
      const label0 = e.target.textContent; e.target.disabled = true; e.target.textContent = 'Sending…';
      try { await onPick(chosen); ui.close(); } catch (err) { const box = ui.el.querySelector('.form-error'); box.textContent = err.message; box.hidden = false; e.target.disabled = false; e.target.textContent = label0; }
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
      { h: 'Status', render: (b) => bookingState(b) },
    ], rowActions: (b) => bookingActions(b) + (b.status === 'completed' ? btn('fb', 'Feedback') : ''), empty: 'No 1:1 sessions yet.' });
    const top = document.createElement('div'); top.innerHTML = blockedNotice(ses);
    const pol = document.createElement('p'); pol.className = 'small muted mb-3'; pol.textContent = ses.policy || '';
    main.append(top, lCard, bCard, pol);
    bindSessionActions(top);
    bindSessionActions(bCard);
    main.querySelector('[data-ck]')?.addEventListener('click', async () => {
      const mid = me.group?.mentor_id || me.mentor_id;
      if (!mid) return toast('Your mentor hasn’t been assigned yet. The Anvaya team will set this up soon.', true);
      await slotPicker(mid, `Check-up with ${esc(me.group?.mentor_name || me.mentor_name || 'your mentor')}`, async (s) => {
        const r = await api('/api/student/bookings/checkup', { method: 'POST', body: { mentor_id: mid, scheduled_at: s } }); requested(r.hold_expires_at, 'checkup'); refresh();
      }, '', { kind: 'checkup' });
    });
    main.querySelector('[data-paid]')?.addEventListener('click', () => { location.hash = 'mentors'; });
    onAct(bCard, {
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

  const views = { home, intake, learn, sessions, mentors, support, messages: support, services, shop, outcomes, feedback };
  let current = 'home';
  async function render(tab = current) {
    current = views[tab] ? tab : 'home';
    const fresh = main.cloneNode(false); main.replaceWith(fresh); main = fresh;
    main.innerHTML = '<p class="sub">Loading…</p>';
    try { await views[current](); } catch (e) { main.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  }
  A.shell(render, meAuth.student && !meAuth.student.intake_completed ? 'intake' : 'home');
})();
