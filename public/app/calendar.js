// Inbuilt session calendar for admins/ops (any mentor) and mentors (themselves), laid out like Google Calendar:
// mini-month + "My calendars" on the left, a day/week/month grid with the host's own Google events, Anvaya sessions,
// classes, open hours and blocked time. Click or drag on future time to block it. All times are IST.
(function () {
  const { api, esc, dt, time, toast, modal, confirmBox, onSubmit, statusPill, label, pageHead } = A;
  const IST = 5.5 * 3600e3, DAY = 86400e3, HOUR_PX = 48, SNAP = 15;
  const ist = (x) => { const t = new Date(new Date(x).getTime() + IST); return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), wd: t.getUTCDay(), min: t.getUTCHours() * 60 + t.getUTCMinutes(), key: t.toISOString().slice(0, 10) }; };
  const dayStart = (key) => new Date(`${key}T00:00:00+05:30`).getTime();
  const addDays = (key, n) => ist(dayStart(key) + n * DAY + 3600e3).key;
  const wdOf = (key) => ist(dayStart(key) + 3600e3).wd;
  const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const ampm = (min, short = false) => { const h = Math.floor(min / 60) % 24, m = min % 60; const s = `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}`; return short ? `${s}${h < 12 ? 'am' : 'pm'}` : `${s} ${h < 12 ? 'AM' : 'PM'}`; };
  const todayKey = () => ist(Date.now()).key;
  const fmt = (key, o) => new Date(dayStart(key) + 3600e3).toLocaleString('en-IN', { ...o, timeZone: 'Asia/Kolkata' });
  const store = { get(k, d) { try { const v = localStorage.getItem(`anvaya.cal.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(`anvaya.cal.${k}`, JSON.stringify(v)); } catch { /* private mode */ } } };

  // Anvaya session states → how they read and look on the grid (solid = confirmed, outlined = tentative).
  function stateOf(b) {
    if (b.status === 'requested') return b.proposed ? ['New time suggested', 'tent'] : ['Requested', 'tent'];
    if (b.status === 'pending_payment') return ['Approved · awaiting payment', 'tent'];
    if (b.status === 'scheduled') return b.calendar_status === 'failed' ? ['Confirmed · Meet failed', 'fail'] : ['Confirmed', 'ok'];
    if (b.status === 'completed') return ['Completed', 'done'];
    if (b.status === 'no_show') return ['No-show', 'fail'];
    return ['Cancelled', 'off'];
  }
  const LAYERS = [['sessions', 'Anvaya sessions', '#c9a84c'], ['classes', 'Classes & mentor rooms', '#8e24aa'], ['blocked', 'Blocked time', '#d9534f'], ['open', 'Open hours', '#33b679']];

  A.planner = async function (main, { staff = false, isAdmin = false, settings = {} } = {}) {
    const mentors = await api('/api/calendar/mentors');
    const st = {
      view: store.get('view', 'week'), anchor: todayKey(), mini: todayKey(),
      mentorId: staff ? String(store.get('mentor', '') || '') : String(mentors[0]?.id || ''),
      layers: store.get('layers', { sessions: true, classes: true, blocked: true, open: true, cancelled: false }),
      gcals: store.get('gcals', null), // null = the calendars chosen in Google settings
    };
    if (staff && st.mentorId && !mentors.some((m) => String(m.id) === st.mentorId)) st.mentorId = '';
    let avail = null, data = { bookings: [], live: [] }, g = { connected: false, calendars: [], events: [], shown: [] }, gInfo = null;
    const grace = (settings.noshow_grace_minutes ?? 15) * 60e3;

    main.innerHTML = `<div class="gc reveal">
      <div class="gc-top">
        <div class="gc-title"><span class="gc-logo">${new Date(Date.now() + IST).getUTCDate()}</span><span>Calendar</span></div>
        <button class="gc-pill" data-nav="today">Today</button>
        <button class="gc-ico" data-nav="-1" aria-label="Previous">‹</button><button class="gc-ico" data-nav="1" aria-label="Next">›</button>
        <h1 class="gc-period" id="gcPeriod"></h1>
        <div class="gc-top-r">
          ${staff ? `<select class="gc-select" id="gcMentor" aria-label="Mentor"><option value="">All mentors</option>${mentors.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>` : ''}
          <select class="gc-select" id="gcView" aria-label="View"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select>
          ${staff ? '<a class="gc-pill" href="#calendar-list" title="All sessions as a list">List</a>' : ''}
          <button class="gc-ico gc-menu" data-toggle-side aria-label="Show sidebar">☰</button>
        </div>
      </div>
      <div class="gc-body">
        <aside class="gc-side" id="gcSide">
          <button class="gc-create" data-block-new><span>＋</span> Block time</button>
          <div id="gcMini" class="gc-mini"></div>
          <div id="gcQueue"></div>
          <div class="gc-sec"><div class="gc-sec-h">My calendars</div><div id="gcLayers"></div></div>
          <div class="gc-sec" id="gcGoogle"></div>
          <div class="gc-sec"><div class="gc-sec-h">Availability</div><div id="gcHours"></div></div>
          ${isAdmin ? '<div class="gc-sec" id="gcNoShows"></div><div class="gc-sec" id="gcPrefs"></div>' : ''}
        </aside>
        <section class="gc-main" id="gcMain"></section>
      </div></div>`;
    const $ = (s) => main.querySelector(s);
    $('#gcView').value = st.view;
    if ($('#gcMentor')) $('#gcMentor').value = st.mentorId;

    function range() {
      if (st.view === 'day') return [st.anchor, addDays(st.anchor, 1)];
      if (st.view === 'week') { const s = addDays(st.anchor, -wdOf(st.anchor)); return [s, addDays(s, 7)]; }
      const p = ist(dayStart(st.anchor) + 3600e3), first = `${p.y}-${String(p.m + 1).padStart(2, '0')}-01`;
      const s = addDays(first, -wdOf(first)); return [s, addDays(s, 42)];
    }
    const iso = (key) => new Date(dayStart(key)).toISOString();
    async function load() {
      const [from, to] = range();
      const mq = st.mentorId ? `&mentor_id=${st.mentorId}` : '';
      const gq = st.gcals ? `&calendars=${encodeURIComponent(st.gcals.join(','))}` : '';
      const [d, a, ge] = await Promise.all([
        api(`/api/calendar/events?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}${mq}`),
        st.mentorId ? api(`/api/calendar/availability?mentor_id=${st.mentorId}`) : Promise.resolve(null),
        api(`/api/calendar/google/events?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}${gq}`).catch((e) => ({ connected: true, error: e.message, calendars: [], events: [], shown: [] })),
      ]);
      data = d; avail = a; g = ge;
      drawAll();
    }
    function drawAll() { draw(); mini(); queue(); layers(); hours(); }

    // ── What sits on a day ──
    function windowsOn(key) {
      if (!avail) return { open: [], blocks: [], wholeDay: null };
      const ov = avail.overrides.filter((o) => o.day === key);
      const wholeDay = ov.find((o) => o.kind === 'blocked' && !o.start_time) || null;
      const open = wholeDay ? [] : [...avail.weekly.filter((w) => Number(w.weekday) === wdOf(key)), ...ov.filter((o) => o.kind === 'open')].map((w) => [toMin(w.start_time), toMin(w.end_time)]);
      return { open, blocks: ov.filter((o) => o.kind === 'blocked' && o.start_time), wholeDay, extra: ov.filter((o) => o.kind === 'open') };
    }
    const colorOf = (calId) => (g.calendars.find((c) => c.id === calId) || {}).color || '#039be5';
    function itemsOn(key) {
      const s = dayStart(key), e = s + DAY, out = [], inDay = (a, b) => new Date(a).getTime() < e && new Date(b).getTime() > s;
      if (st.layers.sessions) for (const b of data.bookings) {
        if (b.status === 'cancelled' && !st.layers.cancelled) continue;
        const t = new Date(b.scheduled_at).getTime(); if (t < s || t >= e) continue;
        const [txt, cls] = stateOf(b);
        out.push({ kind: 'b', id: b.id, title: `${b.student_name}${staff && !st.mentorId && b.mentor_name ? ` × ${b.mentor_name.split(' ')[0]}` : ''}`, sub: b.service || label(b.kind), state: txt, cls, start: b.scheduled_at, end: b.ends_at, color: '#c9a84c' });
      }
      if (st.layers.classes) for (const l of data.live) { const t = new Date(l.starts_at).getTime(); if (t >= s && t < e) out.push({ kind: 'l', id: l.id, title: l.title, sub: l.mentor_name || 'Class', cls: 'ok', start: l.starts_at, end: l.ends_at, color: '#8e24aa' }); }
      const w = windowsOn(key);
      if (st.layers.blocked) for (const o of w.blocks) out.push({ kind: 'o', id: o.id, title: o.note || 'Blocked', sub: 'Not bookable', cls: 'block', start: new Date(dayStart(key) + toMin(o.start_time) * 60e3).toISOString(), end: new Date(dayStart(key) + toMin(o.end_time) * 60e3).toISOString(), color: '#d9534f' });
      for (const ev of g.events || []) {
        if (ev.allDay) continue;
        if (inDay(ev.start, ev.end)) out.push({ kind: 'g', id: ev.id, title: ev.title, sub: ev.location, cls: 'ok', start: ev.start, end: ev.end, color: colorOf(ev.calendarId), ev });
      }
      return out.sort((a, b) => new Date(a.start) - new Date(b.start));
    }
    function allDayOn(key) {
      const out = [], w = windowsOn(key);
      if (st.layers.blocked && w.wholeDay) out.push({ kind: 'o', id: w.wholeDay.id, title: w.wholeDay.note ? `Blocked · ${w.wholeDay.note}` : 'Blocked all day', cls: 'block', color: '#d9534f' });
      for (const ev of g.events || []) {
        if (!ev.allDay) continue;
        if (key >= ev.start.slice(0, 10) && key < ev.end.slice(0, 10)) out.push({ kind: 'g', id: ev.id, title: ev.title, cls: 'ok', color: colorOf(ev.calendarId), ev });
      }
      return out;
    }
    // Overlapping events share the column like Google: lanes within each cluster.
    function lanes(items) {
      const placed = []; let cluster = [], clusterEnd = 0;
      const flush = () => { const cols = []; for (const it of cluster) { let c = cols.findIndex((end) => end <= it.s); if (c < 0) { c = cols.length; cols.push(0); } cols[c] = it.e; it.col = c; } cluster.forEach((it) => { it.cols = cols.length; }); placed.push(...cluster); cluster = []; };
      for (const it of items) { if (cluster.length && it.s >= clusterEnd) flush(); cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e); }
      if (cluster.length) flush();
      return placed;
    }
    const chipAttrs = (it) => `data-k="${it.kind}" data-id="${esc(String(it.id))}"`;

    function draw() {
      const [from] = range(), today = todayKey(), now = Date.now();
      const pEl = $('#gcPeriod'), grid = $('#gcMain');
      if (st.view === 'month') {
        pEl.textContent = fmt(st.anchor, { month: 'long', year: 'numeric' });
        const curM = ist(dayStart(st.anchor) + 3600e3).m;
        let html = `<div class="gm">${['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((x) => `<div class="gm-h">${x}</div>`).join('')}`;
        for (let i = 0; i < 42; i++) {
          const key = addDays(from, i), p = ist(dayStart(key) + 3600e3), items = itemsOn(key), ad = allDayOn(key), w = windowsOn(key);
          const all = [...ad.map((x) => ({ ...x, allDay: true })), ...items];
          html += `<div class="gm-c${p.m !== curM ? ' out' : ''}${key < today ? ' past' : ''}${w.wholeDay ? ' blocked' : ''}" data-cell="${key}">
            <button class="gm-n${key === today ? ' today' : ''}" data-goto="${key}">${p.d === 1 ? fmt(key, { day: 'numeric', month: 'short' }) : p.d}</button>
            ${all.slice(0, 4).map((it) => it.allDay ? `<button class="gm-e solid ${it.cls}" ${chipAttrs(it)} data-c="${esc(it.color)}">${esc(it.title)}</button>`
              : `<button class="gm-e ${it.cls}" ${chipAttrs(it)} data-c="${esc(it.color)}"><i></i><span class="t">${esc(ampm(ist(it.start).min, true))}</span> ${esc(it.title)}</button>`).join('')}
            ${all.length > 4 ? `<button class="gm-more" data-goto="${key}">${all.length - 4} more</button>` : ''}</div>`;
        }
        grid.innerHTML = `${html}</div>`;
      } else {
        const days = st.view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(from, i)) : [st.anchor];
        pEl.textContent = st.view === 'day' ? fmt(st.anchor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
          : (ist(dayStart(days[0]) + 3600e3).m === ist(dayStart(days[6]) + 3600e3).m ? fmt(days[0], { month: 'long', year: 'numeric' }) : `${fmt(days[0], { month: 'short' })} – ${fmt(days[6], { month: 'short', year: 'numeric' })}`);
        const nowMin = ist(now).min;
        grid.innerHTML = `<div class="gw ${st.view === 'day' ? 'gw-day' : ''}">
          <div class="gw-head"><div class="gw-tz">GMT+05:30</div>${days.map((k) => `<div class="gw-dh${k === today ? ' today' : ''}${k < today ? ' past' : ''}"><span class="gw-dw">${esc(fmt(k, { weekday: 'short' }).toUpperCase())}</span><button class="gw-dn" data-goto="${k}">${ist(dayStart(k) + 3600e3).d}</button></div>`).join('')}</div>
          <div class="gw-allday"><div class="gw-tz"></div>${days.map((k) => `<div class="gw-ad${k >= today ? ' can' : ''}" data-allday="${k}">${allDayOn(k).map((it) => `<button class="gw-chip ${it.cls}" ${chipAttrs(it)} data-c="${esc(it.color)}">${esc(it.title)}</button>`).join('')}</div>`).join('')}</div>
          <div class="gw-scroll" id="gwScroll"><div class="gw-grid">
            <div class="gw-hours">${Array.from({ length: 24 }, (_, h) => `<div class="gw-h"><span>${h ? ampm(h * 60) : ''}</span></div>`).join('')}</div>
            ${days.map((k) => {
              const w = windowsOn(k), placed = lanes(itemsOn(k).map((it) => { const s = Math.max(0, Math.round((new Date(it.start).getTime() - dayStart(k)) / 60e3)); const e = Math.min(1440, Math.max(s + 15, Math.round((new Date(it.end).getTime() - dayStart(k)) / 60e3))); return { ...it, s, e }; }));
              return `<div class="gw-col${k < today ? ' past' : ''}${w.wholeDay && st.layers.blocked ? ' blocked' : ''}" data-col="${k}">
                ${st.layers.open ? w.open.map(([a, b]) => `<div class="gw-open" data-top="${a}" data-len="${b - a}"></div>`).join('') : ''}
                ${placed.map((it) => `<button class="gw-ev ${it.cls}${new Date(it.end).getTime() < now ? ' was' : ''}" ${chipAttrs(it)} data-c="${esc(it.color)}" data-top="${it.s}" data-len="${it.e - it.s}" data-col-i="${it.col}" data-cols="${it.cols}">
                  <span class="gw-et">${esc(it.title)}</span><span class="gw-es">${esc(`${ampm(it.s, true)} – ${ampm(it.e, true)}`)}${it.sub ? ` · ${esc(it.sub)}` : ''}</span></button>`).join('')}
                ${k === today ? `<div class="gw-now" data-top="${nowMin}" data-len="0"><i></i></div>` : ''}</div>`;
            }).join('')}</div></div></div>`;
        // The CSP forbids inline style attributes; geometry and colours are applied through the CSSOM.
        grid.querySelectorAll('[data-top]').forEach((el) => { el.style.top = `${el.dataset.top / 60 * HOUR_PX}px`; if (el.dataset.len !== '0') el.style.height = `${Math.max(el.dataset.len / 60 * HOUR_PX - 2, 18)}px`; });
        grid.querySelectorAll('[data-cols]').forEach((el) => { const n = Number(el.dataset.cols), i = Number(el.dataset.colI); el.style.left = `${(i / n) * 100}%`; el.style.width = `calc(${100 / n}% - 4px)`; });
        const sc = grid.querySelector('#gwScroll');
        sc.scrollTop = (days.includes(today) ? Math.max(0, nowMin / 60 - 2) : 8) * HOUR_PX;
        bindDrag(grid);
      }
      grid.querySelectorAll('[data-c]').forEach((el) => el.style.setProperty('--c', el.dataset.c));
    }

    // ── Sidebar ──
    function mini() {
      const p = ist(dayStart(st.mini) + 3600e3), first = `${p.y}-${String(p.m + 1).padStart(2, '0')}-01`, start = addDays(first, -wdOf(first));
      const [rs, re] = range(), today = todayKey();
      let cells = '';
      for (let i = 0; i < 42; i++) { const k = addDays(start, i), q = ist(dayStart(k) + 3600e3); cells += `<button class="gn-d${q.m !== p.m ? ' out' : ''}${k === today ? ' today' : ''}${st.view !== 'month' && k >= rs && k < re ? ' sel' : ''}" data-goto="${k}">${q.d}</button>`; }
      $('#gcMini').innerHTML = `<div class="gn-h"><span>${esc(fmt(first, { month: 'long', year: 'numeric' }))}</span><span><button class="gc-ico sm" data-mini="-1" aria-label="Previous month">‹</button><button class="gc-ico sm" data-mini="1" aria-label="Next month">›</button></span></div>
        <div class="gn-g">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => `<span class="gn-w">${x}</span>`).join('')}${cells}</div>`;
    }
    function queue() {
      const now = Date.now();
      const need = data.bookings.filter((b) => (b.status === 'requested' && !b.proposed) || (b.status === 'scheduled' && b.calendar_status === 'failed') || (b.status === 'scheduled' && new Date(b.scheduled_at).getTime() + grace < now) || b.needs_review);
      $('#gcQueue').innerHTML = need.length ? `<div class="gc-sec"><div class="gc-sec-h">Needs action <span class="gc-badge">${need.length}</span></div>${need.slice(0, 6).map((b) => {
        const why = b.status === 'requested' ? 'Approve or decline' : b.calendar_status === 'failed' ? 'Meet link failed · retry' : b.needs_review ? 'Review' : 'Record the outcome';
        return `<button class="gc-task" data-k="b" data-id="${b.id}"><strong>${esc(b.student_name)}</strong><span>${esc(dt(b.scheduled_at))} · ${esc(why)}</span></button>`;
      }).join('')}</div>` : '';
    }
    function layers() {
      $('#gcLayers').innerHTML = LAYERS.map(([k, l, c]) => `<label class="gc-cb"><input type="checkbox" data-layer="${k}"${st.layers[k] ? ' checked' : ''} data-c="${c}"><span>${l}</span></label>`).join('')
        + `<label class="gc-cb"><input type="checkbox" data-layer="cancelled"${st.layers.cancelled ? ' checked' : ''} data-c="#7a6e5e"><span>Show cancelled</span></label>`
        + (g.connected && g.calendars.length ? `<div class="gc-sub-h gc-sub-row"><span>Your Google Calendar</span>${g.calendars.length > 1 ? `<button class="gc-link" data-gall="${g.calendars.every((c) => (g.shown || []).includes(c.id)) ? 'none' : 'all'}">${g.calendars.every((c) => (g.shown || []).includes(c.id)) ? 'Clear' : 'Select all'}</button>` : ''}</div>${g.calendars.map((c) => `<label class="gc-cb"><input type="checkbox" data-gcal="${esc(c.id)}"${(g.shown || []).includes(c.id) ? ' checked' : ''} data-c="${esc(c.color)}"><span>${esc(c.summary)}</span></label>`).join('')}` : '')
        + (g.error ? `<p class="gc-err">${esc(g.error)}</p>` : '');
      $('#gcLayers').querySelectorAll('[data-c]').forEach((el) => el.style.setProperty('--c', el.dataset.c));
    }
    function hours() {
      const el = $('#gcHours');
      if (!avail) { el.innerHTML = `<p class="gc-note">${staff ? 'Choose a mentor at the top to see and change their hours.' : ''}</p>`; return; }
      const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const byDay = DAYS.map((d, i) => [d, avail.weekly.filter((w) => Number(w.weekday) === i)]).filter(([, l]) => l.length);
      el.innerHTML = `${staff ? `<p class="gc-note strong">${esc(avail.mentor.name)}</p>` : ''}
        <ul class="gc-hours">${byDay.map(([d, l]) => `<li><span>${d}</span><span>${l.map((w) => `${ampm(toMin(w.start_time), true)}–${ampm(toMin(w.end_time), true)}`).join(', ')}</span></li>`).join('') || '<li class="gc-note">No weekly hours yet.</li>'}</ul>
        <p class="gc-note">${avail.mentor.session_duration} min sessions · ${avail.mentor.buffer_minutes} min buffer</p>
        <div class="gc-row"><button class="gc-link" data-edit-hours>Edit weekly hours</button><button class="gc-link" data-extra>Add extra hours</button></div>`;
    }
    async function google() {
      gInfo = await api('/api/calendar/google');
      const el = $('#gcGoogle');
      if (!gInfo.available) { el.innerHTML = '<div class="gc-sec-h">Google Calendar</div><p class="gc-note">Not set up on the server yet.</p>'; return; }
      const c = gInfo.connection;
      if (!c || c.status !== 'active') {
        el.innerHTML = `<div class="gc-connect"><strong>Connect Google Calendar</strong><span>See your Google events here, keep busy times off-limits for students, and give every confirmed session a Google Meet link.</span>
          ${c ? `<span class="gc-err">${esc(c.last_error || 'The connection needs attention.')}</span>` : ''}<a class="btn btn-primary btn-sm" href="/api/calendar/google/connect">Connect</a></div>`;
        return;
      }
      el.innerHTML = `<div class="gc-sec-h">Google Calendar</div><p class="gc-note"><span class="gc-dot ok"></span>Connected as <strong>${esc(c.google_email)}</strong></p>${c.last_error ? `<p class="gc-err">${esc(c.last_error)}</p>` : ''}
        <div class="gc-row"><button class="gc-link" data-gset>Calendar settings</button><a class="gc-link" href="/api/calendar/google/connect">Switch account</a><button class="gc-link" data-gdis>Disconnect</button></div>`;
    }
    function googleSettings() {
      const c = gInfo.connection, cals = gInfo.calendars;
      const ui = modal(`<div class="eyebrow">Google Calendar</div><h2 class="h2 mb-1">Calendar <em>settings</em></h2><p class="small muted mb-2">Connected as ${esc(c.google_email)}.</p>
        <form novalidate><div class="form-error" hidden></div>
          <div class="row-between"><div class="section-label">Busy times from these calendars block student bookings</div>${cals.length > 1 ? '<button type="button" class="gc-link" data-busy-all>Select all</button>' : ''}</div>
          ${cals.map((x) => `<label class="check small"><input type="checkbox" name="busy" value="${esc(x.id)}"${c.busy_calendar_ids.includes(x.id) ? ' checked' : ''}> ${esc(x.summary)}</label>`).join('')}
          <div class="section-label mt-2">Add confirmed sessions (with Meet links) to</div>
          <select class="input" name="booking">${cals.filter((x) => x.canWrite !== false).map((x) => `<option value="${esc(x.id)}"${x.id === c.booking_calendar_id ? ' selected' : ''}>${esc(x.summary)}</option>`).join('')}</select>
          <p class="hint">Saving also adds any upcoming confirmed sessions that aren’t in Google yet.</p>
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div></form>`);
      const f = ui.el.querySelector('form');
      const allBtn = ui.el.querySelector('[data-busy-all]');
      const syncAll = () => { if (allBtn) allBtn.textContent = [...f.querySelectorAll('[name=busy]')].every((x) => x.checked) ? 'Clear' : 'Select all'; };
      allBtn?.addEventListener('click', () => { const on = allBtn.textContent === 'Select all'; f.querySelectorAll('[name=busy]').forEach((x) => { x.checked = on; }); syncAll(); });
      f.addEventListener('change', syncAll); syncAll();
      onSubmit(f, async () => {
        const r = await api('/api/calendar/google', { method: 'PUT', body: { busy_calendar_ids: [...f.querySelectorAll('[name=busy]:checked')].map((x) => x.value), booking_calendar_id: f.booking.value } });
        ui.close(); toast(r.synced ? `Saved · adding ${r.synced} session(s) to Google` : 'Saved'); google(); load();
      });
    }
    async function noShows() {
      const rows = await api('/api/admin/no-shows'), active = rows.filter((n) => n.status === 'active');
      const el = $('#gcNoShows');
      el.innerHTML = `<div class="gc-sec-h">No-shows ${active.length ? `<span class="gc-badge bad">${active.length}</span>` : ''}</div>${rows.slice(0, 8).map((n) => `<div class="gc-task static"><strong>${esc(n.student_name)} ${n.status === 'active' ? (n.disputed_at ? '· disputed' : '') : '· reversed'}</strong>
        <span>${esc(dt(n.scheduled_at))} · by ${esc(n.marked_by_name || '—')} · ${esc(n.reason)}</span>${n.status === 'active' ? `<button class="gc-link" data-rev="${n.id}">Reverse</button>` : ''}</div>`).join('') || '<p class="gc-note">None recorded.</p>'}`;
      el.querySelectorAll('[data-rev]').forEach((b) => b.addEventListener('click', async () => {
        await A.formModal({ eyebrow: 'No-show', title: 'Reverse this <em>no-show</em>', intro: '<p class="small muted mb-2">Booking access is restored (unless another active no-show remains) and the student gets a “booking access restored” email.</p>',
          fields: [{ name: 'reason', label: 'Reason (kept internal)', type: 'textarea', required: true, span2: true }], onSave: (body) => api(`/api/admin/no-shows/${b.dataset.rev}/reverse`, { method: 'POST', body }) });
        toast('Reversed'); noShows();
      }));
    }
    async function prefs() {
      const rows = (await api('/api/admin/session-requests')).filter((r) => r.status === 'open');
      const el = $('#gcPrefs');
      el.innerHTML = `<div class="gc-sec-h">Preferred times ${rows.length ? `<span class="gc-badge">${rows.length}</span>` : ''}</div>${rows.map((r) => `<div class="gc-task static"><strong>${esc(r.student_name)}</strong><span>${esc(label(r.kind))}${r.mentor_name ? ` · ${esc(r.mentor_name)}` : ''} · ${esc(r.preferred)}</span>
        <span class="gc-row"><button class="gc-link" data-pr="${r.id}" data-s="scheduled">Scheduled</button><button class="gc-link" data-pr="${r.id}" data-s="closed">Close</button></span></div>`).join('') || '<p class="gc-note">No open requests.</p>'}`;
      el.querySelectorAll('[data-pr]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/admin/session-requests/${b.dataset.pr}`, { method: 'PATCH', body: { status: b.dataset.s } }); prefs(); }));
    }

    // ── Click or drag on future time to block it ──
    let drag = null;
    function bindDrag(grid) {
      grid.querySelectorAll('.gw-col').forEach((col) => {
        col.addEventListener('pointerdown', (e) => {
          if (e.button !== 0 || e.target.closest('.gw-ev')) return;
          const key = col.dataset.col, r = col.getBoundingClientRect();
          const at = (y) => Math.max(0, Math.min(1440, Math.round(((y - r.top) / HOUR_PX * 60) / SNAP) * SNAP));
          const s = at(e.clientY);
          if (dayStart(key) + (s + SNAP) * 60e3 < Date.now()) return toast('That time has passed.', true);
          const ghost = document.createElement('div'); ghost.className = 'gw-ghost'; col.appendChild(ghost);
          drag = { key, s, e: s + 60, ghost, at, moved: false };
          const paint = () => { const a = Math.min(drag.s, drag.e), b = Math.max(drag.s, drag.e); ghost.style.top = `${a / 60 * HOUR_PX}px`; ghost.style.height = `${(b - a) / 60 * HOUR_PX}px`; ghost.textContent = `${ampm(a, true)} – ${ampm(b, true)}`; };
          paint();
          col.setPointerCapture(e.pointerId);
          const move = (ev) => { const m = at(ev.clientY); if (Math.abs(m - drag.s) >= SNAP) { drag.moved = true; drag.e = m === drag.s ? drag.s + SNAP : m; paint(); } };
          const up = () => {
            col.removeEventListener('pointermove', move); col.removeEventListener('pointerup', up); col.removeEventListener('pointercancel', up);
            const a = Math.min(drag.s, drag.e), b = Math.max(drag.s, drag.e), d = drag; drag = null;
            blockModal({ day: d.key, start: a, end: b }).finally(() => ghost.remove());
          };
          col.addEventListener('pointermove', move); col.addEventListener('pointerup', up); col.addEventListener('pointercancel', up);
        });
      });
    }
    function blockModal({ day = st.view === 'month' || st.anchor < todayKey() ? todayKey() : st.anchor, start = null, end = null, wholeDay = false } = {}) {
      return new Promise((resolve) => {
        const opts = staff ? `<div class="field"><label class="label">Mentor</label><select class="input" name="mentor_id">${mentors.map((m) => `<option value="${m.id}"${String(m.id) === st.mentorId ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>` : '';
        const ui = modal(`<div class="eyebrow">Availability</div><h2 class="h2 mb-2">${start != null ? `${esc(fmt(day, { weekday: 'short', day: 'numeric', month: 'short' }))} · ${ampm(start, true)} – ${ampm(end, true)}` : 'Block <em>time</em>'}</h2>
          <form novalidate><div class="form-error" hidden></div>${opts}
            <div class="form-grid">
              <div class="field"><label class="label">Date</label><input class="input" type="date" name="day" value="${esc(day)}" min="${todayKey()}" required></div>
              <div class="field"><label class="check"><input type="checkbox" name="whole"${wholeDay || start == null ? ' checked' : ''}> <span>Whole day</span></label></div>
              <div class="field" data-times><label class="label">From</label><input class="input" type="time" name="start_time" step="900" value="${start != null ? hhmm(start) : '18:00'}"></div>
              <div class="field" data-times><label class="label">Until</label><input class="input" type="time" name="end_time" step="900" value="${end != null ? hhmm(Math.min(end, 1439)) : '20:00'}"></div>
              <div class="field span-2"><label class="label">Note (only staff and the host see this)</label><input class="input" name="note" maxlength="200" placeholder="e.g. Travelling, conference, personal"></div>
            </div>
            <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="button" class="btn btn-ghost" data-open-instead>Make bookable instead</button><button class="btn btn-primary" type="submit">Block</button></div></form>`, { onClose: () => resolve() });
        const f = ui.el.querySelector('form');
        const sync = () => ui.el.querySelectorAll('[data-times]').forEach((x) => { x.hidden = f.whole.checked; });
        f.whole.addEventListener('change', sync); sync();
        const save = async (kind) => {
          const mid = staff ? f.mentor_id.value : st.mentorId;
          if (!mid) throw new Error('Choose a mentor.');
          if (kind === 'open' && f.whole.checked) throw new Error('Untick “Whole day” and choose the hours to open.');
          await api('/api/calendar/overrides', { method: 'POST', body: { mentor_id: mid, day: f.day.value, kind, note: f.note.value, ...(f.whole.checked ? {} : { start_time: f.start_time.value, end_time: f.end_time.value }) } });
          if (staff && st.mentorId !== mid) { st.mentorId = mid; if ($('#gcMentor')) $('#gcMentor').value = mid; store.set('mentor', mid); }
          ui.close(); toast(kind === 'open' ? 'Extra bookable hours added' : 'Blocked. Students can’t book this time.'); load();
        };
        onSubmit(f, () => save('blocked'));
        ui.el.querySelector('[data-open-instead]').addEventListener('click', () => save('open').catch((e) => { const x = f.querySelector('.form-error'); x.textContent = e.message; x.hidden = false; }));
      });
    }

    // ── Event details ──
    function itemPopover(kind, idv) {
      if (kind === 'b') return bookingModal(Number(idv));
      if (kind === 'l') { const l = data.live.find((x) => x.id === Number(idv)); return modal(`<div class="eyebrow">Class / mentor room</div><h2 class="h2 mb-1">${esc(l.title)}</h2><p class="small muted mb-2">${esc(dt(l.starts_at))} – ${esc(time(l.ends_at))} IST${l.mentor_name ? ` · ${esc(l.mentor_name)}` : ''}</p>${staff ? '<a class="btn btn-ghost btn-sm" href="#calendar-list">Manage in list view</a>' : ''}`); }
      if (kind === 'g') {
        const ev = g.events.find((x) => x.id === idv), cal = g.calendars.find((c) => c.id === ev.calendarId);
        const when = ev.allDay ? fmt(ev.start.slice(0, 10), { weekday: 'long', day: 'numeric', month: 'long' }) : `${dt(ev.start)} – ${time(ev.end)} IST`;
        const ui = modal(`<div class="gc-pop"><span class="gc-sq" data-c="${esc(cal?.color || '#039be5')}"></span><div><h2 class="h2">${esc(ev.title)}</h2><p class="small muted">${esc(when)}</p>
          ${ev.location ? `<p class="small mt-1">${esc(ev.location)}</p>` : ''}<p class="small muted mt-1">${esc(cal?.summary || 'Google Calendar')} · only you can see this</p>
          ${ev.link ? `<a class="btn btn-ghost btn-sm mt-2" href="${esc(ev.link)}" target="_blank" rel="noopener noreferrer">Open in Google Calendar</a>` : ''}</div></div>`);
        ui.el.querySelectorAll('[data-c]').forEach((el) => el.style.setProperty('--c', el.dataset.c));
        return ui;
      }
      if (kind === 'o') {
        const o = avail.overrides.find((x) => x.id === Number(idv));
        const ui = modal(`<div class="eyebrow">Blocked time</div><h2 class="h2 mb-1">${esc(o.note || 'Blocked')}</h2><p class="small muted mb-2">${esc(fmt(o.day, { weekday: 'long', day: 'numeric', month: 'long' }))} · ${o.start_time ? `${ampm(toMin(o.start_time), true)} – ${ampm(toMin(o.end_time), true)}` : 'All day'}</p>
          <p class="small mb-2">Students can’t book this time.</p><div class="modal-actions"><button class="btn btn-ghost" data-close>Close</button><button class="btn btn-danger" data-rm>Unblock</button></div>`);
        ui.el.querySelector('[data-rm]').addEventListener('click', async () => { await api(`/api/calendar/overrides/${o.id}`, { method: 'DELETE' }); ui.close(); toast('Unblocked'); load(); });
      }
      return null;
    }
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
        ${b.status === 'scheduled' ? `<p class="small mb-2">Google Calendar: ${b.calendar_status === 'synced' ? `<span class="pill ok">Added</span> ${b.meet_link ? `<a href="${esc(b.meet_link)}" target="_blank" rel="noopener noreferrer">Join Meet</a>` : ''}` : b.calendar_status === 'failed' ? `<span class="pill bad">Failed</span> <span class="due">${esc(b.calendar_error)}</span> — no confirmation has gone out yet.` : b.calendar_status === 'none' ? '<span class="pill">Not in Google yet</span> — connect Google Calendar to add it.' : '<span class="pill">Adding…</span>'}</p>` : ''}
        ${answers.length ? `<div class="section-label">Student’s answers</div><dl class="kv mb-2">${answers.map(([k, val]) => `<dt>${esc(label(k))}</dt><dd>${esc(val)}</dd>`).join('')}</dl>` : ''}
        ${log.length ? `<div class="section-label">Emails</div><ul class="list small mb-2">${log.map((l) => `<li><span>${esc(label(l.template))}<span class="sub-line">${esc(l.to_email)} · ${esc(dt(l.created_at))}${l.error ? ` · ${esc(l.error)}` : ''}</span></span>${statusPill(l.status === 'sent' ? 'queued' : l.status)}</li>`).join('')}</ul>` : ''}
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
      if (b.status === 'scheduled' && ['failed', 'none'].includes(b.calendar_status)) add(b.calendar_status === 'none' ? 'Add to Google + Meet' : 'Retry calendar + Meet', 'btn-primary', async () => { const r = await post('calendar-retry'); toast(r.calendar_status === 'synced' ? 'Added to Google Calendar with a Meet link' : `Still failing: ${r.calendar_error}`, r.calendar_status !== 'synced'); });
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
          <div class="slot-pick">${Object.entries(byDay).map(([k, list]) => `<div class="mb-2"><div class="section-label">${esc(fmt(k, { weekday: 'short', day: 'numeric', month: 'short' }))}</div><div class="row">${list.map((s) => `<button type="button" class="btn btn-ghost btn-sm" data-at="${esc(s)}">${esc(time(s))}</button>`).join('')}</div></div>`).join('')}</div>
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Back</button></div>`, { onClose: () => resolve(val), wide: true });
        ui.el.querySelectorAll('[data-at]').forEach((x) => x.addEventListener('click', () => { val = x.dataset.at; ui.close(); }));
      });
    }
    function hoursModal() {
      const ui = modal(`<div class="eyebrow">Availability</div><h2 class="h2 mb-2">Weekly <em>hours</em></h2><p class="small muted mb-2">IST. Students can request slots inside these, minus booked sessions, buffers, blocked time and Google busy times.</p>
        <form novalidate><div class="form-error" hidden></div><div class="slots" id="hSlots"></div><div class="row"><button type="button" class="btn btn-ghost btn-sm" id="hAdd">+ Add a time range</button></div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save hours</button></div></form>`, { wide: true });
      const read = A.availabilityEditor(ui.el.querySelector('#hSlots'), ui.el.querySelector('#hAdd'), avail.weekly.length ? avail.weekly : null);
      onSubmit(ui.el.querySelector('form'), async () => { await api('/api/calendar/availability', { method: 'PUT', body: { weekly: read(), mentor_id: st.mentorId } }); ui.close(); toast('Weekly hours saved'); load(); });
    }

    // ── Wiring ──
    const run = (p) => Promise.resolve(p).catch((er) => toast(er.message, true));
    main.addEventListener('click', (e) => {
      const t = e.target;
      const it = t.closest('[data-k]'); if (it) { e.stopPropagation(); run(itemPopover(it.dataset.k, it.dataset.id)); return; }
      const go = t.closest('[data-goto]');
      if (go) { st.anchor = go.dataset.goto; st.mini = st.anchor; if (st.view === 'month' || go.classList.contains('gm-more') || go.classList.contains('gw-dn')) st.view = 'day'; $('#gcView').value = st.view; store.set('view', st.view); run(load()); return; }
      const nav = t.closest('[data-nav]');
      if (nav) {
        const n = nav.dataset.nav;
        if (n === 'today') st.anchor = todayKey();
        else if (st.view === 'month') { const p = ist(dayStart(st.anchor) + 3600e3); st.anchor = new Date(Date.UTC(p.y, p.m + Number(n), 1)).toISOString().slice(0, 10); }
        else st.anchor = addDays(st.anchor, Number(n) * (st.view === 'week' ? 7 : 1));
        st.mini = st.anchor; run(load()); return;
      }
      const mn = t.closest('[data-mini]'); if (mn) { const p = ist(dayStart(st.mini) + 3600e3); st.mini = new Date(Date.UTC(p.y, p.m + Number(mn.dataset.mini), 1)).toISOString().slice(0, 10); mini(); return; }
      const ad = t.closest('[data-allday]'); if (ad && ad.classList.contains('can')) { run(blockModal({ day: ad.dataset.allday, wholeDay: true })); return; }
      const cell = t.closest('[data-cell]'); if (cell && cell.dataset.cell >= todayKey()) { run(blockModal({ day: cell.dataset.cell, wholeDay: true })); return; }
      if (t.closest('[data-block-new]')) return run(blockModal());
      if (t.closest('[data-edit-hours]')) return hoursModal();
      if (t.closest('[data-extra]')) return run(blockModal({ start: 18 * 60, end: 20 * 60 }));
      const ga = t.closest('[data-gall]');
      if (ga) { st.gcals = ga.dataset.gall === 'all' ? g.calendars.map((c) => c.id) : [g.calendars.find((c) => c.primary)?.id || g.calendars[0].id]; store.set('gcals', st.gcals); run(load()); return; }
      if (t.closest('[data-gset]')) return googleSettings();
      if (t.closest('[data-gdis]')) {
        run(confirmBox('Disconnect Google Calendar?', 'Your Google events disappear from this view and new confirmations can’t get a Meet link until a host calendar is connected again. Existing events stay in Google.', { danger: true, ok: 'Disconnect' })
          .then(async (ok) => { if (!ok) return; await api('/api/calendar/google', { method: 'DELETE' }); toast('Disconnected'); await google(); await load(); }));
        return;
      }
      if (t.closest('[data-toggle-side]')) $('#gcSide').classList.toggle('open');
    });
    main.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'gcView') { st.view = t.value; store.set('view', st.view); run(load()); }
      if (t.id === 'gcMentor') { st.mentorId = t.value; store.set('mentor', st.mentorId); run(load()); }
      if (t.dataset.layer) { st.layers[t.dataset.layer] = t.checked; store.set('layers', st.layers); draw(); }
      if (t.dataset.gcal) { st.gcals = [...main.querySelectorAll('[data-gcal]:checked')].map((x) => x.dataset.gcal); store.set('gcals', st.gcals); run(load()); }
    });

    await load();
    run(google());
    if (isAdmin) { run(noShows()); run(prefs()); }
  };
})();
