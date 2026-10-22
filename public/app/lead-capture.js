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
    var css = el('style');
    css.textContent = '.fc-wrap{margin-bottom:18px}.fc-sub{font-size:11px;color:var(--muted,#7a6e5e);letter-spacing:.04em;text-transform:none;margin-left:6px}'
      + '.fc-days,.fc-times{display:flex;gap:8px;overflow-x:auto;padding:2px 0 8px;scrollbar-width:thin}.fc-times{flex-wrap:wrap;overflow:visible}'
      + '.fc-chip{flex:none;border:1px solid rgba(201,168,76,.28);background:transparent;color:var(--ivory-2,#d9cdb8);border-radius:999px;padding:8px 14px;font:inherit;font-size:12.5px;cursor:pointer;transition:all .2s}'
      + '.fc-chip:hover{border-color:var(--gold,#c9a84c);color:var(--gold,#c9a84c)}.fc-chip.on{background:var(--gold,#c9a84c);border-color:var(--gold,#c9a84c);color:#08111f;font-weight:600}'
      + '.fc-note{font-size:12px;color:var(--muted,#7a6e5e);margin-top:4px}.fc-err{font-size:12.5px;color:#e28b7a;margin:-6px 0 12px}';
    document.head.appendChild(css);
    var wrap = el('div', 'chat-field fc-wrap');
    var lab = el('label', 'chat-label', 'Pick a time for your free chat'); lab.appendChild(el('span', 'fc-sub', 'IST · optional'));
    var days = el('div', 'fc-days'), times = el('div', 'fc-times'), note = el('p', 'fc-note', 'Not confirmed until we approve it. You’ll get the Google Meet link by email.');
    note.hidden = true;
    var byDay = {}; slots.forEach(function (s) { (byDay[dayKey(s)] = byDay[dayKey(s)] || []).push(s); });
    Object.keys(byDay).forEach(function (k, i) {
      var b = el('button', 'fc-chip', dayLabel(byDay[k][0])); b.type = 'button';
      b.addEventListener('click', function () { [].forEach.call(days.children, function (x) { x.classList.remove('on'); }); b.classList.add('on'); showTimes(byDay[k]); });
      days.appendChild(b);
      if (i === 0) setTimeout(function () { b.click(); }, 0);
    });
    function showTimes(list) {
      times.innerHTML = '';
      list.forEach(function (s) {
        var b = el('button', 'fc-chip' + (s === chosen ? ' on' : ''), timeLabel(s)); b.type = 'button';
        b.addEventListener('click', function () {
          var on = chosen !== s; chosen = on ? s : null;
          [].forEach.call(times.children, function (x) { x.classList.remove('on'); }); if (on) b.classList.add('on');
          sync();
        });
        times.appendChild(b);
      });
    }
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
    wrap.appendChild(lab); wrap.appendChild(days); wrap.appendChild(times); wrap.appendChild(note);
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
