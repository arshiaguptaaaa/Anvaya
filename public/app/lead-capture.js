// Free-chat enquiries → Anvaya CRM (source of truth). The server then copies each enquiry to the
// existing Google Sheet as a tracked background job. If the CRM can't be reached, the form falls back
// to its original direct Google Sheet submission so no enquiry is lost.
// When the free-chat host has open slots, the form also offers them: the visitor picks a time (IST) and
// leaves an email for the Google Meet invite; the request is held until the host approves it.
(function () {
  var form = document.getElementById('chatForm');
  if (!form || !window.fetch) return;
  // The public site and the app live on different hosts in production; the app answers CORS for the site.
  var host = location.hostname;
  var API = /(^|\.)anvayacareers\.in$/.test(host) && host.indexOf('app.') !== 0 ? 'https://app.anvayacareers.in' : '';
  var chosen = null, slots = [];

  var IST = { timeZone: 'Asia/Kolkata' };
  var dayKey = function (iso) { return new Date(iso).toLocaleDateString('en-CA', IST); };
  var dayLabel = function (iso) { return new Date(iso).toLocaleDateString('en-IN', Object.assign({ weekday: 'short', day: 'numeric', month: 'short' }, IST)); };
  var timeLabel = function (iso) { return new Date(iso).toLocaleTimeString('en-IN', Object.assign({ hour: 'numeric', minute: '2-digit' }, IST)); };
  var el = function (tag, cls, text) { var x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };

  function picker(data) {
    slots = data.slots || [];
    if (!data.available || !slots.length) return;
    if (!document.getElementById('fc-style')) {
      var css = el('style'); css.id = 'fc-style';
      css.textContent = '.fc-wrap{margin-bottom:18px}.fc-sub{font-size:11px;color:var(--muted,#7a6e5e);letter-spacing:.04em;text-transform:none;margin-left:6px}'
        + '.fc-cal{border:1px solid rgba(201,168,76,.22);border-radius:12px;padding:16px 16px 14px;background:rgba(8,17,31,.35)}'
        + '.fc-mh{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.fc-mt{font-family:"Cormorant Garamond",serif;font-size:1.25rem;color:var(--ivory,#f4ede0)}'
        + '.fc-nav{width:32px;height:32px;border-radius:50%;border:0;background:rgba(201,168,76,.1);color:var(--gold,#c9a84c);font-size:18px;cursor:pointer}.fc-nav:disabled{opacity:.25;cursor:default;background:transparent}'
        + '.fc-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;text-align:center}.fc-wd{font-size:10px;letter-spacing:.12em;color:var(--muted,#7a6e5e);padding:4px 0}'
        + '.fc-d{aspect-ratio:1;max-width:44px;width:100%;margin:0 auto;border-radius:50%;border:0;background:transparent;color:rgba(217,205,184,.28);font:inherit;font-size:13px;cursor:default;position:relative}'
        + '.fc-d.av{background:rgba(201,168,76,.13);color:var(--gold-2,#e8c97a);font-weight:600;cursor:pointer}.fc-d.av:hover{background:rgba(201,168,76,.26)}'
        + '.fc-d.on{background:var(--gold,#c9a84c);color:#08111f}.fc-d.td::after{content:"";position:absolute;left:50%;bottom:5px;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:currentColor}'
        + '.fc-dayh{font-size:13.5px;color:var(--ivory,#f4ede0);margin:16px 0 10px}.fc-times{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}'
        + '.fc-t{border:1px solid rgba(201,168,76,.45);background:transparent;color:var(--gold-2,#e8c97a);border-radius:8px;padding:10px 6px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s}'
        + '.fc-t:hover{border-color:var(--gold,#c9a84c);background:rgba(201,168,76,.08)}.fc-t.on{background:var(--gold,#c9a84c);border-color:var(--gold,#c9a84c);color:#08111f}'
        + '.fc-tz{font-size:11.5px;color:var(--muted,#7a6e5e);margin-top:12px}.fc-note{font-size:12px;color:var(--muted,#7a6e5e);margin-top:8px}.fc-err{font-size:12.5px;color:#e28b7a;margin:-6px 0 12px}';
      document.head.appendChild(css);
    }
    var wrap = el('div', 'chat-field fc-wrap');
    var lab = el('label', 'chat-label', 'Pick a date & time'); lab.appendChild(el('span', 'fc-sub', 'optional'));
    var cal = el('div', 'fc-cal'), note = el('p', 'fc-note', 'Not confirmed until we approve it. You’ll get the Google Meet link by email.');
    note.hidden = true;
    // Calendly-style: a month grid where bookable dates are highlighted; picking a date lists its times.
    var byDay = {}; slots.forEach(function (s) { (byDay[dayKey(s)] = byDay[dayKey(s)] || []).push(s); });
    var keys = Object.keys(byDay).sort(), today = dayKey(new Date().toISOString());
    var ym = function (k) { return k.slice(0, 7); };
    var month = ym(keys[0]), selDay = null;
    var mh = el('div', 'fc-mh'), prev = el('button', 'fc-nav', '‹'), title = el('span', 'fc-mt'), next = el('button', 'fc-nav', '›');
    prev.type = next.type = 'button'; prev.setAttribute('aria-label', 'Previous month'); next.setAttribute('aria-label', 'Next month');
    mh.appendChild(prev); mh.appendChild(title); mh.appendChild(next);
    var grid = el('div', 'fc-grid'), dayh = el('p', 'fc-dayh'), times = el('div', 'fc-times'), tz = el('p', 'fc-tz', '🌐 India Standard Time (IST) · 15-minute Google Meet');
    dayh.hidden = true;
    cal.appendChild(mh); cal.appendChild(grid); cal.appendChild(dayh); cal.appendChild(times); cal.appendChild(tz);
    var shiftMonth = function (m, n) { var d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
    function drawMonth() {
      var y = +month.slice(0, 4), m = +month.slice(5, 7) - 1;
      title.textContent = new Date(Date.UTC(y, m, 15)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      prev.disabled = month <= ym(keys[0]); next.disabled = month >= ym(keys[keys.length - 1]);
      grid.innerHTML = '';
      ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].forEach(function (w) { grid.appendChild(el('span', 'fc-wd', w)); });
      var first = new Date(Date.UTC(y, m, 1)).getUTCDay(), count = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      for (var i = 0; i < first; i++) grid.appendChild(el('span'));
      for (var d = 1; d <= count; d++) {
        var k = month + '-' + String(d).padStart(2, '0');
        var b = el('button', 'fc-d' + (byDay[k] ? ' av' : '') + (k === selDay ? ' on' : '') + (k === today ? ' td' : ''), String(d));
        b.type = 'button'; b.disabled = !byDay[k];
        b.setAttribute('aria-label', dayLabel(k + 'T12:00:00+05:30') + (byDay[k] ? ', available' : ', unavailable'));
        if (byDay[k]) b.addEventListener('click', (function (key) { return function () { selDay = key; drawMonth(); showTimes(byDay[key]); }; })(k));
        grid.appendChild(b);
      }
    }
    prev.addEventListener('click', function () { month = shiftMonth(month, -1); drawMonth(); });
    next.addEventListener('click', function () { month = shiftMonth(month, 1); drawMonth(); });
    function showTimes(list) {
      dayh.hidden = false;
      dayh.textContent = new Date(list[0]).toLocaleDateString('en-IN', Object.assign({ weekday: 'long', day: 'numeric', month: 'long' }, IST));
      times.innerHTML = '';
      list.forEach(function (s) {
        var b = el('button', 'fc-t' + (s === chosen ? ' on' : ''), timeLabel(s)); b.type = 'button';
        b.addEventListener('click', function () {
          var on = chosen !== s; chosen = on ? s : null;
          [].forEach.call(times.children, function (x) { x.classList.remove('on'); }); if (on) b.classList.add('on');
          sync();
        });
        times.appendChild(b);
      });
    }
    drawMonth();
    var emailField = el('div', 'chat-field');
    emailField.hidden = true;
    var el2 = el('label', 'chat-label', 'Email (for the Google Meet invite)'); el2.htmlFor = 'chat-email';
    var email = el('input', 'chat-input'); email.type = 'email'; email.id = 'chat-email'; email.name = 'email'; email.placeholder = 'you@example.com'; email.autocomplete = 'email';
    emailField.appendChild(el2); emailField.appendChild(email);
    var err = el('p', 'fc-err'); err.hidden = true;
    var btn = document.getElementById('chatSubmitBtn'), btnText = btn ? btn.textContent : '';
    function sync() {
      emailField.hidden = !chosen; email.required = !!chosen; note.hidden = !chosen; err.hidden = true;
      if (btn) btn.textContent = chosen ? 'Request ' + dayLabel(chosen) + ', ' + timeLabel(chosen) + ' →' : btnText;
    }
    wrap.appendChild(lab); wrap.appendChild(cal); wrap.appendChild(note);
    form.insertBefore(wrap, btn); form.insertBefore(emailField, btn); form.insertBefore(err, btn);
    form._anvayaSlot = { email: email, err: err, btn: btn, reset: function () { chosen = null; sync(); }, refresh: function () { return load(true); }, wrap: wrap, emailField: emailField };
  }
  function load(again) {
    return fetch(API + '/api/public/freechat/slots', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      if (again && form._anvayaSlot) { form._anvayaSlot.wrap.remove(); form._anvayaSlot.emailField.remove(); form._anvayaSlot.err.remove(); chosen = null; }
      picker(d);
    }).catch(function () { /* no picker: the plain enquiry form still works */ });
  }
  load(false);

  form.addEventListener('submit', function (e) {
    if (form.dataset.anvayaFallback === '1') return;           // native fallback submission
    e.preventDefault();
    var val = function (n) { return (form.elements.namedItem(n) || {}).value || ''; };
    var data = { name: val('name'), phone: val('phone'), situation: val('situation') };
    var fallback = function () {
      form.dataset.anvayaFallback = '1';
      try { HTMLFormElement.prototype.submit.call(form); } catch (err) { /* nothing else we can do */ }
    };
    if (!chosen) {
      // Plain enquiry: the page's own handler shows its usual "we'll be in touch" message.
      fetch(API + '/api/public/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), credentials: 'omit', keepalive: true })
        .then(function (r) { if (!r.ok) fallback(); })
        .catch(fallback);
      return;
    }
    // A time was picked: wait for the server, because the slot may have just been taken.
    e.stopImmediatePropagation();
    var ui = form._anvayaSlot, at = chosen;
    data.slot = at; data.email = ui.email.value.trim();
    ui.btn.disabled = true; ui.btn.textContent = 'Sending…';
    fetch(API + '/api/public/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), credentials: 'omit' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (res) {
        ui.btn.disabled = false;
        if (!res.ok) {
          ui.err.textContent = (res.body && res.body.error) || 'Something went wrong. Please try again.'; ui.err.hidden = false;
          ui.btn.textContent = 'Request my free chat →';
          if (res.status === 409) ui.refresh();
          return;
        }
        var done = document.getElementById('chatSuccess');
        if (done) {
          var ps = done.querySelectorAll('p');
          if (ps[0]) ps[0].textContent = 'Requested for ' + dayLabel(at) + ', ' + timeLabel(at) + ' IST.';
          if (ps[1]) ps[1].textContent = 'Not confirmed yet. We’ll email the Google Meet link to ' + data.email + ' once it is.';
          form.style.display = 'none'; done.classList.add('show');
        }
      })
      .catch(function () { ui.btn.disabled = false; ui.btn.textContent = 'Request my free chat →'; ui.err.textContent = 'Couldn’t reach Anvaya. Check your connection and try again.'; ui.err.hidden = false; });
  }, true);
})();
