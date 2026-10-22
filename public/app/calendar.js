// Inbuilt session calendar for admins/ops (any mentor) and mentors (themselves): month/week/day views of 1:1s and
// classes, weekly hours, blocked dates / extra hours, Google Calendar connection and the session actions
// (approve, decline, suggest another time, outcome / no-show, calendar retry). All times are IST.
(function () {
  const { api, esc, dt, time, DAYS, toast, modal, confirmBox, onSubmit, statusPill, label, pageHead } = A;
  const IST = 5.5 * 3600e3, DAY = 86400e3;
  const VIEW_START = 7, VIEW_END = 23; // hours shown on the week/day timeline
  const HOUR_PX = 44;
  // An IST calendar day is handled as 'YYYY-MM-DD'; ist(ms) gives its parts.
  const ist = (x) => { const t = new Date(new Date(x).getTime() + IST); return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), wd: t.getUTCDay(), min: t.getUTCHours() * 60 + t.getUTCMinutes(), key: t.toISOString().slice(0, 10) }; };
  const dayStart = (key) => new Date(`${key}T00:00:00+05:30`).getTime();
  const addDays = (key, n) => ist(dayStart(key) + n * DAY + 3600e3).key;
  const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
  const todayKey = () => ist(Date.now()).key;
  const monthName = (key) => new Date(dayStart(key) + 3600e3).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const shortDay = (key) => new Date(dayStart(key) + 3600e3).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

  // What each booking state means to a host, with the colour class used on the grid.
  function stateOf(b) {
    if (b.status === 'requested') return b.proposed ? ['New time suggested', 'ev-wait'] : ['Requested', 'ev-req'];
    if (b.status === 'pending_payment') return ['Approved · awaiting payment', 'ev-wait'];
    if (b.status === 'scheduled') return b.calendar_status === 'failed' ? ['Confirmed · Meet failed', 'ev-bad'] : ['Confirmed', 'ev-ok'];
    if (b.status === 'completed') return ['Completed', 'ev-done'];
    if (b.status === 'no_show') return ['No-show', 'ev-bad'];
    return [b.cancel_reason ? 'Cancelled' : 'Cancelled', 'ev-off'];
  }
  const graceMs = (min) => (min ?? 15) * 60e3;

  A.planner = async function (main, { staff = false, isAdmin = false, settings = {} } = {}) {
    const mentors = await api('/api/calendar/mentors');
    const st = {
      view: (() => { try { return localStorage.getItem('anvaya.cal.view') || 'week'; } catch { return 'week'; } })(),
      anchor: todayKey(),
      mentorId: staff ? '' : String(mentors[0]?.id || ''),
    };
    let avail = null, data = { bookings: [], live: [] };
    const grace = graceMs(settings.noshow_grace_minutes);

    main.innerHTML = pageHead(staff ? 'Delivery' : 'Schedule', 'Session <em>calendar</em>', 'Requests, confirmed sessions and classes in IST. Students only ever see the open slots, never your calendar details.',
      staff ? '<a class="btn btn-ghost" href="#calendar-list">List view</a>' : '') + `
      <div class="cal-toolbar card card-pad reveal">
        <div class="row"><button class="btn btn-ghost btn-sm" data-nav="today">Today</button><button class="btn btn-ghost btn-sm" data-nav="-1" aria-label="Previous">‹</button><button class="btn btn-ghost btn-sm" data-nav="1" aria-label="Next">›</button><strong class="cal-label ivory" id="calLabel"></strong></div>
        <div class="row">${staff ? `<select class="input input-sm" id="calMentor" aria-label="Mentor"><option value="">All mentors</option>${mentors.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>` : ''}
          <div class="seg" role="group" aria-label="View">${['month', 'week', 'day'].map((v) => `<button class="seg-b" data-view="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div></div>
      </div>
      <div class="cal-layout">
        <div class="card cal-main reveal" id="calGrid"></div>
        <aside class="cal-side">
          <div class="card card-pad reveal" id="calQueue"></div>
          <div class="card card-pad reveal" id="calHours"></div>
          <div class="card card-pad reveal" id="calGoogle"></div>
          ${isAdmin ? '<div class="card card-pad reveal" id="calNoShows"></div><div class="card card-pad reveal" id="calPrefs"></div>' : ''}
        </aside>
      </div>`;
    const $ = (s) => main.querySelector(s);

    function range() {
      if (st.view === 'day') return [st.anchor, addDays(st.anchor, 1)];
      if (st.view === 'week') { const wd = (ist(dayStart(st.anchor) + 3600e3).wd + 6) % 7; const s = addDays(st.anchor, -wd); return [s, addDays(s, 7)]; }
      const p = ist(dayStart(st.anchor) + 3600e3); const first = `${p.y}-${String(p.m + 1).padStart(2, '0')}-01`;
      const s = addDays(first, -((ist(dayStart(first) + 3600e3).wd + 6) % 7)); return [s, addDays(s, 42)];
    }
    async function load() {
      const [from, to] = range();
      const mq = st.mentorId ? `&mentor_id=${st.mentorId}` : '';
      [data, avail] = await Promise.all([
        api(`/api/calendar/events?from=${encodeURIComponent(new Date(dayStart(from)).toISOString())}&to=${encodeURIComponent(new Date(dayStart(to)).toISOString())}${mq}`),
        st.mentorId ? api(`/api/calendar/availability?mentor_id=${st.mentorId}`) : Promise.resolve(null),
      ]);
      draw(); queue(); hours();
    }
    const eventsOn = (key) => {
      const s = dayStart(key), e = s + DAY;
      const bs = data.bookings.filter((b) => { const t = new Date(b.scheduled_at).getTime(); return t >= s && t < e; }).map((b) => ({ type: 'b', at: b.scheduled_at, end: b.ends_at, b }));
      const ls = data.live.filter((l) => { const t = new Date(l.starts_at).getTime(); return t >= s && t < e; }).map((l) => ({ type: 'l', at: l.starts_at, end: l.ends_at, l }));
      return [...bs, ...ls].sort((x, y) => new Date(x.at) - new Date(y.at));
    };
    // Open windows for one day: weekly hours, minus whole-day/partial blocks, plus extra open hours.
    function windowsOn(key) {
      if (!avail) return { open: [], blocked: [], wholeDay: false };
      const wd = ist(dayStart(key) + 3600e3).wd;
      const ov = avail.overrides.filter((o) => o.day === key);
      const wholeDay = ov.some((o) => o.kind === 'blocked' && !o.start_time);
      const open = wholeDay ? [] : [...avail.weekly.filter((w) => w.weekday === wd), ...ov.filter((o) => o.kind === 'open')].map((w) => [toMin(w.start_time), toMin(w.end_time)]);
      const blocked = ov.filter((o) => o.kind === 'blocked' && o.start_time).map((o) => [toMin(o.start_time), toMin(o.end_time)]);
      return { open, blocked, wholeDay, ov };
    }
    const chip = (ev) => {
      if (ev.type === 'l') return `<button class="ev ev-live" data-live="${ev.l.id}"><span class="ev-t">${esc(time(ev.at))}</span> ${esc(ev.l.title)}</button>`;
      const [txt, cls] = stateOf(ev.b);
      return `<button class="ev ${cls}" data-bk="${ev.b.id}" title="${esc(txt)}"><span class="ev-t">${esc(time(ev.at))}</span> ${esc(ev.b.student_name)}${staff && !st.mentorId && ev.b.mentor_name ? ` · ${esc(ev.b.mentor_name.split(' ')[0])}` : ''}</button>`;
    };

    function draw() {
      document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === st.view));
      const [from] = range();
      const grid = $('#calGrid');
      if (st.view === 'month') {
        $('#calLabel').textContent = monthName(st.anchor);
        const curM = ist(dayStart(st.anchor) + 3600e3).m, today = todayKey();
        let html = `<div class="mgrid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="mhead">${d}</div>`).join('')}`;
        for (let i = 0; i < 42; i++) {
          const key = addDays(from, i), p = ist(dayStart(key) + 3600e3), evs = eventsOn(key), w = windowsOn(key);
          html += `<div class="mcell${p.m !== curM ? ' out' : ''}${key === today ? ' today' : ''}${w.wholeDay ? ' blocked' : ''}" data-day="${key}">
            <div class="mnum">${p.d}${w.wholeDay ? '<span class="mtag">Blocked</span>' : avail && w.open.length && key >= today ? '<span class="mdot" title="Open hours"></span>' : ''}</div>
            ${evs.slice(0, 3).map(chip).join('')}${evs.length > 3 ? `<span class="more">+${evs.length - 3} more</span>` : ''}</div>`;
        }
        grid.innerHTML = html + '</div>';
      } else {
        const days = st.view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(from, i)) : [st.anchor];
        $('#calLabel').textContent = st.view === 'week' ? `${shortDay(days[0])} – ${shortDay(days[6])}` : shortDay(st.anchor);
        const hoursCol = Array.from({ length: VIEW_END - VIEW_START }, (_, i) => `<div class="tl-h">${String(VIEW_START + i).padStart(2, '0')}:00</div>`).join('');
        const today = todayKey(), nowMin = ist(Date.now()).min;
        grid.innerHTML = `<div class="tl ${st.view === 'day' ? 'tl-day' : ''}"><div class="tl-head"><div></div>${days.map((k) => { const w = windowsOn(k); return `<button class="tl-dh${k === today ? ' today' : ''}" data-day="${k}">${esc(shortDay(k))}${w.wholeDay ? '<span class="mtag">Blocked</span>' : ''}</button>`; }).join('')}</div>
          <div class="tl-body"><div class="tl-hours">${hoursCol}</div>${days.map((k) => {
            const w = windowsOn(k);
            const pos = (a, b) => `data-top="${(Math.max(a, VIEW_START * 60) - VIEW_START * 60) / 60 * HOUR_PX}" data-h="${Math.max((Math.min(b, VIEW_END * 60) - Math.max(a, VIEW_START * 60)) / 60 * HOUR_PX, 14)}"`;
            return `<div class="tl-col${w.wholeDay ? ' blocked' : ''}" data-day="${k}">
              ${w.open.map(([a, b]) => `<div class="tl-open" ${pos(a, b)}></div>`).join('')}${w.blocked.map(([a, b]) => `<div class="tl-block" ${pos(a, b)}></div>`).join('')}
              ${k === today && nowMin > VIEW_START * 60 && nowMin < VIEW_END * 60 ? `<div class="tl-now" ${pos(nowMin, nowMin)}></div>` : ''}
              ${eventsOn(k).map((ev) => { const s = ist(ev.at).min, e = s + (new Date(ev.end) - new Date(ev.at)) / 60e3; return `<div class="tl-ev" ${pos(s, e)}>${chip(ev)}</div>`; }).join('')}</div>`;
          }).join('')}</div></div>`;
        // Inline style attributes are blocked by the CSP, so positions are applied through the CSSOM.
        grid.querySelectorAll('[data-top]').forEach((el) => { el.style.top = `${el.dataset.top}px`; el.style.height = `${el.dataset.h}px`; });
        grid.querySelector('.tl-hours').style.height = `${(VIEW_END - VIEW_START) * HOUR_PX}px`;
        grid.querySelectorAll('.tl-col').forEach((c) => { c.style.height = `${(VIEW_END - VIEW_START) * HOUR_PX}px`; });
      }
    }

    // ── Side panels ──
    function queue() {
      const now = Date.now();
      const need = data.bookings.filter((b) => (b.status === 'requested' && !b.proposed) || (b.status === 'scheduled' && b.calendar_status === 'failed')
        || (b.status === 'scheduled' && new Date(b.scheduled_at).getTime() + grace < now) || b.needs_review);
      $('#calQueue').innerHTML = `<div class="section-label">Needs action <span class="muted">(${need.length})</span></div>${need.length ? `<ul class="list small">${need.map((b) => {
        const why = b.status === 'requested' ? 'Approve or decline' : b.calendar_status === 'failed' ? 'Meet link failed — retry' : b.needs_review ? 'Review (student flagged)' : 'Record the outcome';
        return `<li><button class="link-btn ta-l" data-bk="${b.id}">${esc(b.student_name)}<span class="sub-line">${esc(dt(b.scheduled_at))} · ${esc(why)}</span></button></li>`;
      }).join('')}</ul>` : '<p class="small muted">Nothing waiting in this range.</p>'}`;
    }
    function hours() {
      const el = $('#calHours');
      if (!avail) { el.innerHTML = '<div class="section-label">Availability</div><p class="small muted">Choose a mentor above to see and edit their weekly hours and blocked dates.</p>'; return; }
      const upcoming = avail.overrides.filter((o) => o.day >= todayKey());
      el.innerHTML = `<div class="section-label">Weekly hours${staff ? ` · ${esc(avail.mentor.name)}` : ''}</div>${A.weekView(avail.weekly.map((w) => ({ ...w, weekday: Number(w.weekday) })))}
        <p class="small muted mt-1">${avail.mentor.session_duration} min sessions · ${avail.mentor.buffer_minutes} min buffer</p>
        <div class="row mt-1"><button class="btn btn-ghost btn-sm" data-edit-hours>Edit recurring hours</button><button class="btn btn-ghost btn-sm" data-ov="blocked">Block time</button><button class="btn btn-ghost btn-sm" data-ov="open">Add extra hours</button></div>
        <div class="section-label mt-2">Date changes</div>${upcoming.length ? `<ul class="list small">${upcoming.map((o) => `<li><span>${esc(shortDay(o.day))} · ${o.kind === 'blocked' ? (o.start_time ? `Blocked ${esc(o.start_time)}–${esc(o.end_time)}` : 'Whole day blocked') : `Extra ${esc(o.start_time)}–${esc(o.end_time)}`}${o.note ? `<span class="sub-line">${esc(o.note)}</span>` : ''}</span><button class="btn btn-ghost btn-sm" data-del-ov="${o.id}">Remove</button></li>`).join('')}</ul>` : '<p class="small muted">No blocked dates or extra hours.</p>'}`;
    }
    async function google() {
      const g = await api('/api/calendar/google');
      const el = $('#calGoogle');
      if (!g.available) { el.innerHTML = '<div class="section-label">Google Calendar</div><p class="small muted">Google Calendar isn’t set up on the server yet.</p>'; return; }
      if (!g.connection || g.connection.status !== 'active') {
        el.innerHTML = `<div class="section-label">Google Calendar</div>${g.connection ? `<p class="small due">${esc(g.connection.last_error || 'Connection needs attention.')}</p>` : ''}
          <p class="small muted mb-2">Connect to create Google Meet links for confirmed sessions and hide times you’re busy. Only free/busy is read; event details stay private.</p>
          <a class="btn btn-primary btn-sm" href="/api/calendar/google/connect">Connect Google Calendar</a>`;
        return;
      }
      const c = g.connection;
      el.innerHTML = `<div class="section-label">Google Calendar</div><p class="small"><span class="pill ok">Connected</span> ${esc(c.google_email)}</p>${c.last_error ? `<p class="small due">${esc(c.last_error)}</p>` : ''}
        <form novalidate class="mt-1"><div class="form-error" hidden></div><p class="label">Check these calendars for busy times</p>
          ${g.calendars.map((x) => `<label class="check small"><input type="checkbox" name="busy" value="${esc(x.id)}"${c.busy_calendar_ids.includes(x.id) ? ' checked' : ''}> ${esc(x.summary)}</label>`).join('')}
          <label class="label mt-1">Add confirmed sessions to</label><select class="input input-sm" name="booking">${g.calendars.filter((x) => x.canWrite !== false).map((x) => `<option value="${esc(x.id)}"${x.id === c.booking_calendar_id ? ' selected' : ''}>${esc(x.summary)}</option>`).join('')}</select>
          <div class="row mt-1"><button class="btn btn-ghost btn-sm" type="submit">Save</button><button class="btn btn-ghost btn-sm" type="button" data-gdis>Disconnect</button></div></form>`;
      const f = el.querySelector('form');
      onSubmit(f, async () => {
        await api('/api/calendar/google', { method: 'PUT', body: { busy_calendar_ids: [...f.querySelectorAll('[name=busy]:checked')].map((x) => x.value), booking_calendar_id: f.booking.value } });
        toast('Calendar settings saved'); load();
      });
      el.querySelector('[data-gdis]').addEventListener('click', async () => {
        if (!await confirmBox('Disconnect Google Calendar?', 'New confirmations can’t get a Meet link until a host calendar is connected again. Existing events stay in Google.', { danger: true, ok: 'Disconnect' })) return;
        await api('/api/calendar/google', { method: 'DELETE' }); toast('Disconnected'); google();
      });
    }
    async function noShows() {
      const rows = await api('/api/admin/no-shows');
      const el = $('#calNoShows');
      el.innerHTML = `<div class="section-label">No-show records</div>${rows.length ? `<ul class="list small">${rows.slice(0, 12).map((n) => `<li><span>${esc(n.student_name)} ${n.status === 'active' ? '<span class="pill bad">Active</span>' : '<span class="pill off">Reversed</span>'}${n.disputed_at ? ' <span class="pill">Disputed</span>' : ''}
        <span class="sub-line">${esc(dt(n.scheduled_at))} · by ${esc(n.marked_by_name || '—')} · ${esc(n.reason)}</span></span>${n.status === 'active' ? `<button class="btn btn-ghost btn-sm" data-rev="${n.id}">Reverse</button>` : ''}</li>`).join('')}</ul>` : '<p class="small muted">None recorded.</p>'}`;
      el.querySelectorAll('[data-rev]').forEach((b) => b.addEventListener('click', async () => {
        await A.formModal({ eyebrow: 'No-show', title: 'Reverse this <em>no-show</em>', intro: '<p class="small muted mb-2">The student’s booking access is restored (unless another active no-show remains) and they get a “booking access restored” email.</p>',
          fields: [{ name: 'reason', label: 'Reason (kept internal)', type: 'textarea', required: true, span2: true }], onSave: (body) => api(`/api/admin/no-shows/${b.dataset.rev}/reverse`, { method: 'POST', body }) });
        toast('Reversed'); noShows();
      }));
    }
    async function prefs() {
      const rows = (await api('/api/admin/session-requests')).filter((r) => r.status === 'open');
      const el = $('#calPrefs');
      el.innerHTML = `<div class="section-label">Preferred-date requests</div>${rows.length ? `<ul class="list small">${rows.map((r) => `<li><span>${esc(r.student_name)}<span class="sub-line">${esc(label(r.kind))}${r.mentor_name ? ` · ${esc(r.mentor_name)}` : ''} · ${esc(r.preferred)}</span></span>
        <span class="row"><button class="btn btn-ghost btn-sm" data-pr="${r.id}" data-s="scheduled">Scheduled</button><button class="btn btn-ghost btn-sm" data-pr="${r.id}" data-s="closed">Close</button></span></li>`).join('')}</ul>` : '<p class="small muted">No open requests.</p>'}`;
      el.querySelectorAll('[data-pr]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/admin/session-requests/${b.dataset.pr}`, { method: 'PATCH', body: { status: b.dataset.s } }); prefs(); }));
    }

    // ── Session actions ──
    async function bookingModal(bid) {
      const b = data.bookings.find((x) => x.id === bid); if (!b) return;
      const [stTxt] = stateOf(b);
      const now = Date.now(), start = new Date(b.scheduled_at).getTime(), afterGrace = now >= start + grace;
      const log = staff ? await api(`/api/admin/email-log?booking_id=${b.id}`).catch(() => []) : [];
      const answers = Object.entries(b.intake_answers || {}).filter(([, val]) => val);
      const ui = modal(`<div class="eyebrow">${esc(b.service || label(b.kind))}</div><div class="row-between mb-2"><h2 class="h2">${esc(b.student_name)}</h2><span class="pill">${esc(stTxt)}</span></div>
        <div class="kv-inline mb-2"><span>When <strong>${esc(dt(b.scheduled_at))} IST</strong></span><span>Until <strong>${esc(time(b.ends_at))}</strong></span>${staff ? `<span>Mentor <strong>${esc(b.mentor_name || '—')}</strong></span>` : ''}</div>
        ${b.status === 'requested' && b.hold_expires_at ? `<p class="small muted mb-2">Slot held until ${esc(dt(b.hold_expires_at))}; it’s released automatically if nobody responds.</p>` : ''}
        ${b.student_blocked ? '<p class="notice mb-2">This student’s new bookings are paused after a no-show. This session is kept but flagged for review.</p>' : ''}
        ${b.status === 'scheduled' ? `<p class="small mb-2">Calendar: ${b.calendar_status === 'synced' ? `<span class="pill ok">Synced</span> ${b.meet_link ? `<a href="${esc(b.meet_link)}" target="_blank" rel="noopener noreferrer">Join Meet</a>` : ''}` : b.calendar_status === 'failed' ? `<span class="pill bad">Failed</span> <span class="due">${esc(b.calendar_error)}</span> — no confirmation has gone out yet.` : '<span class="pill">Creating event…</span>'}</p>` : ''}
        ${answers.length ? `<div class="section-label">Student’s answers</div><dl class="kv mb-2">${answers.map(([k, val]) => `<dt>${esc(label(k))}</dt><dd>${esc(val)}</dd>`).join('')}</dl>` : ''}
        ${log.length ? `<div class="section-label">Emails</div><ul class="list small mb-2">${log.map((l) => `<li><span>${esc(label(l.template))}<span class="sub-line">${esc(l.to_email)} · ${esc(dt(l.created_at))}${l.error ? ` · ${esc(l.error)}` : ''}</span></span>${statusPill(l.status === 'sent' ? 'queued' : l.status === 'delivered' ? 'delivered' : l.status)}</li>`).join('')}</ul>` : ''}
        <div class="form-error" hidden></div>
        <div class="modal-actions" id="bkActs"><button type="button" class="btn btn-ghost" data-close>Close</button></div>`, { wide: true });
      const acts = ui.el.querySelector('#bkActs'), err = ui.el.querySelector('.form-error');
      const add = (text, cls, fn) => { const x = document.createElement('button'); x.type = 'button'; x.className = `btn ${cls}`; x.textContent = text; x.addEventListener('click', async () => {
        err.hidden = true; x.disabled = true;
        try { const done = await fn(); if (done !== false) { ui.close(); load(); } } catch (e) { err.textContent = e.message; err.hidden = false; } finally { if (x.isConnected) x.disabled = false; }
      }); acts.appendChild(x); };
      const post = (path, body) => api(`/api/calendar/bookings/${b.id}/${path}`, { method: 'POST', body });

      if (b.status === 'requested' && !b.proposed) {
        add('Decline', 'btn-danger', async () => { const r = await reasonPrompt('Decline this request?', 'The student is told the time isn’t available and the slot is released.', 'Message to the student (optional)', false); if (r === null) return false; await post('decline', { reason: r }); toast('Declined'); });
        add('Suggest another time', 'btn-ghost', async () => { const at = await slotPick(b); if (!at) return false; await post('suggest', { scheduled_at: at }); toast('New time sent to the student'); });
        add('Approve', 'btn-primary', async () => { const out = await post('approve'); toast(out.status === 'pending_payment' ? 'Approved — the student has been asked to pay' : 'Approved — confirmation goes out once the Meet link is ready'); });
      }
      if (b.status === 'requested' && b.proposed) add('Withdraw suggestion', 'btn-danger', async () => { await post('decline', { reason: 'The suggested time is no longer available.' }); toast('Withdrawn'); });
      if (b.status === 'scheduled' && b.calendar_status === 'failed') add('Retry calendar + Meet', 'btn-primary', async () => { const r = await post('calendar-retry'); toast(r.calendar_status === 'synced' ? 'Meet link created; confirmations sent' : `Still failing: ${r.calendar_error}`, r.calendar_status !== 'synced'); });
      if (b.status === 'scheduled' && start > now && staff) add('Cancel session', 'btn-danger', async () => { const r = await reasonPrompt('Cancel this session?', 'Both the student and the host are emailed, the calendar event is cancelled and reminders stop.', 'Reason (shared with the student)', false); if (r === null) return false; await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: r } }); toast('Cancelled'); });
      if (b.status === 'scheduled' && now >= start) {
        if (afterGrace) {
          add('Student no-show', 'btn-danger', async () => {
            const r = await reasonPrompt('Confirm the student didn’t attend?', 'Their new bookings are paused until an admin reviews it. Their account, materials and existing bookings stay. The reason is kept internal.', 'What happened (internal, required)', true);
            if (r === null) return false; await post('outcome', { outcome: 'student_no_show', reason: r }); toast('No-show recorded');
          });
        }
        add('Host couldn’t attend', 'btn-ghost', async () => { const r = await reasonPrompt('Host absent?', 'The session is cancelled without any penalty to the student, and a rebooking task is created.', 'Note (internal)', false); if (r === null) return false; await post('outcome', { outcome: 'host_absent', reason: r }); toast('Recorded — no penalty to the student'); });
        add('Technical issue', 'btn-ghost', async () => { const r = await reasonPrompt('Technical issue?', 'The session is cancelled without any penalty to the student, and a rebooking task is created.', 'Note (internal)', false); if (r === null) return false; await post('outcome', { outcome: 'technical_issue', reason: r }); toast('Recorded — no penalty to the student'); });
        add('Mark completed', 'btn-primary', async () => {
          if (staff) await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { status: 'completed' } });
          else await api(`/api/mentor/bookings/${b.id}/complete`, { method: 'POST', body: {} });
          toast('Completed');
        });
        if (!afterGrace) { const p = document.createElement('p'); p.className = 'small muted ta-l'; p.textContent = `A no-show can be recorded from ${time(new Date(start + grace).toISOString())}.`; acts.prepend(p); }
      }
    }
    function reasonPrompt(title, text, fieldLabel, required) {
      return new Promise((resolve) => {
        let val = null;
        const ui = modal(`<div class="eyebrow">Session</div><h2 class="h2 mb-1">${esc(title)}</h2><p class="small muted mb-2">${esc(text)}</p>
          <form novalidate><div class="form-error" hidden></div><div class="field"><label class="label">${esc(fieldLabel)}</label><textarea class="input" name="reason" rows="3" maxlength="500"${required ? ' required' : ''}></textarea></div>
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Back</button><button class="btn btn-primary" type="submit">Confirm</button></div></form>`, { onClose: () => resolve(val) });
        onSubmit(ui.el.querySelector('form'), async (d) => { if (required && !String(d.reason || '').trim()) throw new Error('Please add a reason.'); val = String(d.reason || '').trim(); ui.close(); });
      });
    }
    async function slotPick(b) {
      const slots = (await api(`/api/calendar/slots?mentor_id=${b.mentor_id}`)).filter((s) => new Date(s).getTime() !== new Date(b.scheduled_at).getTime());
      if (!slots.length) { toast('No open slots in the booking window. Add extra hours first.', true); return null; }
      const byDay = {}; slots.forEach((s) => { (byDay[ist(s).key] ||= []).push(s); });
      return new Promise((resolve) => {
        let val = null;
        const ui = modal(`<div class="eyebrow">Suggest another time</div><h2 class="h2 mb-2">Pick a <em>slot</em></h2><p class="small muted mb-2">The student gets an email to accept it. The old time is released and this one is held for them.</p>
          <div class="slot-pick">${Object.entries(byDay).map(([k, list]) => `<div class="mb-2"><div class="section-label">${esc(shortDay(k))}</div><div class="row">${list.map((s) => `<button type="button" class="btn btn-ghost btn-sm" data-at="${esc(s)}">${esc(time(s))}</button>`).join('')}</div></div>`).join('')}</div>
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Back</button></div>`, { onClose: () => resolve(val), wide: true });
        ui.el.querySelectorAll('[data-at]').forEach((x) => x.addEventListener('click', () => { val = x.dataset.at; ui.close(); }));
      });
    }

    async function overrideModal(kind) {
      const fields = [{ name: 'day', label: 'Date', type: 'date', required: true }, { name: 'start_time', label: kind === 'open' ? 'From' : 'From (leave empty to block the whole day)', type: 'time', required: kind === 'open' },
        { name: 'end_time', label: 'Until', type: 'time', required: kind === 'open' }, { name: 'note', label: 'Note (internal)', span2: true }];
      await A.formModal({ eyebrow: 'Availability', title: kind === 'open' ? 'Add extra <em>hours</em>' : 'Block <em>time</em>', fields, values: { day: st.view === 'month' ? todayKey() : st.anchor },
        onSave: (body) => api('/api/calendar/overrides', { method: 'POST', body: { ...body, kind, mentor_id: st.mentorId } }) });
      toast(kind === 'open' ? 'Extra hours added' : 'Time blocked'); load();
    }
    function hoursModal() {
      const ui = modal(`<div class="eyebrow">Availability</div><h2 class="h2 mb-2">Recurring <em>weekly hours</em></h2><p class="small muted mb-2">IST. Students can request slots inside these, minus booked sessions, buffers, blocked dates and Google busy times.</p>
        <form novalidate><div class="form-error" hidden></div><div class="slots" id="hSlots"></div><div class="row"><button type="button" class="btn btn-ghost btn-sm" id="hAdd">+ Add a time range</button></div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save hours</button></div></form>`, { wide: true });
      const read = A.availabilityEditor(ui.el.querySelector('#hSlots'), ui.el.querySelector('#hAdd'), avail.weekly.length ? avail.weekly : null);
      onSubmit(ui.el.querySelector('form'), async () => { await api('/api/calendar/availability', { method: 'PUT', body: { weekly: read(), mentor_id: st.mentorId } }); ui.close(); toast('Weekly hours saved'); load(); });
    }

    // ── Wiring ──
    main.addEventListener('click', (e) => {
      const t = e.target;
      const bk = t.closest('[data-bk]'); if (bk) { e.stopPropagation(); bookingModal(Number(bk.dataset.bk)).catch((er) => toast(er.message, true)); return; }
      const lv = t.closest('[data-live]'); if (lv) { const l = data.live.find((x) => x.id === Number(lv.dataset.live)); toast(`${l.title} · ${dt(l.starts_at)}${l.mentor_name ? ` · ${l.mentor_name}` : ''}`); return; }
      const nav = t.closest('[data-nav]');
      if (nav) {
        const n = nav.dataset.nav;
        if (n === 'today') st.anchor = todayKey();
        else if (st.view === 'month') { const p = ist(dayStart(st.anchor) + 3600e3); const m = new Date(Date.UTC(p.y, p.m + Number(n), 1)); st.anchor = m.toISOString().slice(0, 10); }
        else st.anchor = addDays(st.anchor, Number(n) * (st.view === 'week' ? 7 : 1));
        load().catch((er) => toast(er.message, true)); return;
      }
      const vw = t.closest('[data-view]'); if (vw) { st.view = vw.dataset.view; try { localStorage.setItem('anvaya.cal.view', st.view); } catch { /* ignore */ } load().catch((er) => toast(er.message, true)); return; }
      const day = t.closest('[data-day]'); if (day && (st.view !== 'day')) { st.anchor = day.dataset.day; st.view = 'day'; load().catch((er) => toast(er.message, true)); return; }
      if (t.closest('[data-edit-hours]')) return hoursModal();
      const ov = t.closest('[data-ov]'); if (ov) { overrideModal(ov.dataset.ov).catch(() => {}); return; }
      const del = t.closest('[data-del-ov]'); if (del) { api(`/api/calendar/overrides/${del.dataset.delOv}`, { method: 'DELETE' }).then(() => { toast('Removed'); load(); }).catch((er) => toast(er.message, true)); }
    });
    $('#calMentor')?.addEventListener('change', (e) => { st.mentorId = e.target.value; load().catch((er) => toast(er.message, true)); });

    await load();
    google().catch((e) => { $('#calGoogle').innerHTML = `<div class="section-label">Google Calendar</div><p class="small due">${esc(e.message)}</p>`; });
    if (isAdmin) { noShows().catch(() => {}); prefs().catch(() => {}); }
  };
})();
