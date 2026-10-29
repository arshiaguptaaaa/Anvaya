// Free-chat enquiries → Anvaya CRM (source of truth). The server then copies each enquiry to the
// existing Google Sheet as a tracked background job. If the CRM can't be reached, the form falls back
// to its original direct Google Sheet submission so no enquiry is lost.
// When the free-chat host has open slots, the form becomes a 3-step booking card, Calendly-style:
//   1. pick a time (two-week date strip → times)  2. your details  3. done.
// Visitors never sign up; the request is held until the host approves it and emails the Google Meet link.
// "No time works?" keeps the original plain enquiry (name + number, we call you back).
(function () {
  var form = document.getElementById('chatForm');
  if (!form || !window.fetch) return;
  // The public site and the app live on different hosts in production; the app answers CORS for the site.
  var host = location.hostname;
  var API = /(^|\.)anvayacareers\.in$/.test(host) && host.indexOf('app.') !== 0 ? 'https://app.anvayacareers.in' : '';
  var chosen = null, ui = null;

  var IST = { timeZone: 'Asia/Kolkata' };
  var dayKey = function (iso) { return new Date(iso).toLocaleDateString('en-CA', IST); };
  var fmt = function (iso, o) { return new Date(iso).toLocaleString('en-IN', Object.assign({}, o, IST)); };
  var dayLabel = function (iso) { return fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' }); };
  var timeLabel = function (iso) { return fmt(iso, { hour: 'numeric', minute: '2-digit' }); };
  var el = function (tag, cls, text) { var x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  var btnEl = function (cls, text) { var b = el('button', cls, text); b.type = 'button'; return b; };

  var CSS = '.bk [hidden],.bk[hidden]{display:none!important}.bk{--g:var(--gold,#c9a84c);--g2:var(--gold-2,#e8c97a);--iv:var(--ivory,#f4ede0);--iv2:var(--ivory-2,#d9cdb8);--mu:#9a8d78}'
    + '.bk-steps{display:flex;gap:18px;margin:0 0 18px;font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--mu)}.bk-steps span{display:flex;align-items:center;gap:8px}'
    + '.bk-steps i{font-style:normal;width:20px;height:20px;border-radius:50%;border:1px solid rgba(201,168,76,.35);display:grid;place-items:center;font-size:10px;letter-spacing:0}'
    + '.bk-steps .on{color:var(--iv)}.bk-steps .on i{background:var(--g);border-color:var(--g);color:#08111f;font-weight:700}.bk-steps .ok i{background:rgba(201,168,76,.18);color:var(--g2)}'
    + '.bk-pane{animation:bkIn .35s ease both}@keyframes bkIn{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}'
    + '.bk-mon{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}.bk-mon b{font-family:"Cormorant Garamond",serif;font-weight:400;font-size:1.3rem;color:var(--iv)}.bk-mon span{font-size:11.5px;color:var(--mu)}'
    + '.bk-days{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}'
    + '.bk-day{border:1px solid transparent;background:transparent;border-radius:10px;padding:7px 0 8px;font:inherit;color:rgba(217,205,184,.25);cursor:default;display:flex;flex-direction:column;align-items:center;gap:2px}'
    + '.bk-day small{font-size:9.5px;letter-spacing:.12em}.bk-day b{font-size:15px;font-weight:500}'
    + '.bk-day.av{color:var(--g2);background:rgba(201,168,76,.09);border-color:rgba(201,168,76,.22);cursor:pointer}.bk-day.av:hover{border-color:var(--g)}'
    + '.bk-day.on{background:var(--g);border-color:var(--g);color:#08111f}.bk-day.on small{color:#08111f}'
    + '.bk-dayh{font-size:13.5px;color:var(--iv);margin:18px 0 10px}.bk-times{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}'
    + '.bk-t{border:1px solid rgba(201,168,76,.45);background:transparent;color:var(--g2);border-radius:9px;padding:11px 4px;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;transition:all .15s}'
    + '.bk-t:hover{background:rgba(201,168,76,.1);border-color:var(--g)}'
    + '.bk-meta{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11.5px;color:var(--mu);margin-top:14px}'
    + '.bk-alt{display:block;margin-top:16px;background:none;border:0;padding:0;font:inherit;font-size:12.5px;color:var(--mu);text-decoration:underline;text-underline-offset:3px;cursor:pointer}.bk-alt:hover{color:var(--g2)}'
    + '.bk-chip{display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid rgba(201,168,76,.3);background:rgba(201,168,76,.08);border-radius:10px;padding:12px 14px;margin-bottom:18px}'
    + '.bk-chip b{display:block;color:var(--iv);font-weight:500;font-size:14px}.bk-chip span{font-size:11.5px;color:var(--mu)}.bk-chip button{background:none;border:0;color:var(--g);font:inherit;font-size:12.5px;cursor:pointer;text-decoration:underline}'
    + '.bk-err{font-size:12.5px;color:#e28b7a;margin:-4px 0 12px}'
    + '.bk-done{text-align:center;padding:12px 4px}.bk-done .ck{width:56px;height:56px;border-radius:50%;margin:0 auto 14px;display:grid;place-items:center;background:rgba(201,168,76,.14);color:var(--g2);font-size:24px;animation:bkPop .5s cubic-bezier(.2,1.4,.4,1) both}'
    + '@keyframes bkPop{from{transform:scale(.4);opacity:0}to{transform:none;opacity:1}}'
    + '.bk-done h3{font-family:"Cormorant Garamond",serif;font-weight:400;font-size:1.6rem;color:var(--iv);margin-bottom:6px}.bk-done .when{color:var(--g2);font-size:15px;margin-bottom:12px}.bk-done p{font-size:13px;color:var(--mu);line-height:1.7}'
    + '@media (max-width:420px){.bk-days{gap:4px}.bk-day b{font-size:14px}.bk-times{grid-template-columns:repeat(2,1fr)}}';

  function build(data) {
    var slots = data.slots || [];
    if (!data.available || !slots.length) return;
    if (!document.getElementById('bk-style')) { var s = el('style'); s.id = 'bk-style'; s.textContent = CSS; document.head.appendChild(s); }
    form.classList.add('bk');
    var btn = document.getElementById('chatSubmitBtn'), btnText = btn ? btn.textContent : '';
    var fields = [].slice.call(form.querySelectorAll('.chat-field'));
    // Step header
    var steps = el('div', 'bk-steps'), s1 = el('span'), s2 = el('span');
    s1.appendChild(el('i', '', '1')); s1.appendChild(document.createTextNode('Pick a time'));
    s2.appendChild(el('i', '', '2')); s2.appendChild(document.createTextNode('Your details'));
    steps.appendChild(s1); steps.appendChild(s2);
    form.insertBefore(steps, form.firstChild);

    // Step 1: two-week strip from today, bookable days highlighted, first one pre-selected.
    var byDay = {}; slots.forEach(function (x) { (byDay[dayKey(x)] = byDay[dayKey(x)] || []).push(x); });
    var pane1 = el('div', 'bk-pane'), mon = el('div', 'bk-mon'), monName = el('b'), days = el('div', 'bk-days');
    var dayh = el('p', 'bk-dayh'), times = el('div', 'bk-times'), meta = el('div', 'bk-meta');
    ['Google Meet', '15 min', 'Free', 'Times in IST'].forEach(function (t, i) { meta.appendChild(el('span', '', (i ? '· ' : '') + t)); });
    mon.appendChild(monName); mon.appendChild(el('span', '', 'Next two weeks'));
    var start = new Date(); var first = null;
    for (var i = 0; i < 14; i++) {
      var d = new Date(start.getTime() + i * 864e5), k = dayKey(d.toISOString()), av = !!byDay[k];
      var b = btnEl('bk-day' + (av ? ' av' : ''));
      b.appendChild(el('small', '', fmt(d, { weekday: 'short' }).toUpperCase())); b.appendChild(el('b', '', fmt(d, { day: 'numeric' })));
      b.disabled = !av; b.dataset.k = k;
      b.setAttribute('aria-label', fmt(d, { weekday: 'long', day: 'numeric', month: 'long' }) + (av ? '' : ', no times'));
      if (av) { b.addEventListener('click', function () { pickDay(this.dataset.k); }); if (!first) first = k; }
      days.appendChild(b);
    }
    var alt = btnEl('bk-alt', 'No time works? Just leave your number and we’ll call you →');
    pane1.appendChild(mon); pane1.appendChild(days); pane1.appendChild(dayh); pane1.appendChild(times); pane1.appendChild(meta); pane1.appendChild(alt);
    form.insertBefore(pane1, steps.nextSibling);
    function pickDay(k) {
      [].forEach.call(days.children, function (x) { x.classList.toggle('on', x.dataset.k === k); });
      monName.textContent = fmt(byDay[k][0], { month: 'long', year: 'numeric' });
      dayh.textContent = fmt(byDay[k][0], { weekday: 'long', day: 'numeric', month: 'long' });
      times.innerHTML = '';
      byDay[k].forEach(function (x) { var t = btnEl('bk-t', timeLabel(x)); t.addEventListener('click', function () { chosen = x; show(2); }); times.appendChild(t); });
    }
    if (!first) return; // only past-day slots (shouldn't happen): keep the plain form
    pickDay(first);

    // Step 2: the original fields + email, with the chosen time on top.
    var chip = el('div', 'bk-chip'), chipTxt = el('div'), chipWhen = el('b'), change = btnEl('', 'Change');
    chipTxt.appendChild(chipWhen); chipTxt.appendChild(el('span', '', 'Free 15-min chat · Google Meet · not confirmed until we approve it'));
    chip.appendChild(chipTxt); chip.appendChild(change);
    var emailField = el('div', 'chat-field'), lab = el('label', 'chat-label', 'Email (for the Google Meet invite)'); lab.htmlFor = 'chat-email';
    var email = el('input', 'chat-input'); email.type = 'email'; email.id = 'chat-email'; email.name = 'email'; email.placeholder = 'you@example.com'; email.autocomplete = 'email';
    emailField.appendChild(lab); emailField.appendChild(email);
    var err = el('p', 'bk-err'); err.hidden = true;
    form.insertBefore(chip, fields[0] || btn);
    form.insertBefore(emailField, btn); form.insertBefore(err, btn);
    change.addEventListener('click', function () { show(1); });
    alt.addEventListener('click', function () { chosen = null; show(2); });

    function show(step) {
      var two = step === 2;
      pane1.hidden = two;
      fields.forEach(function (f) { f.hidden = !two; f.classList.toggle('bk-pane', two); });
      chip.hidden = !two || !chosen; emailField.hidden = !two || !chosen; email.required = !!(two && chosen); err.hidden = true;
      if (btn) { btn.hidden = !two; btn.textContent = chosen ? 'Request this time →' : btnText; }
      s1.className = two ? 'ok' : 'on'; s2.className = two ? 'on' : '';
      if (two && chosen) chipWhen.textContent = fmt(chosen, { weekday: 'long', day: 'numeric', month: 'long' }) + ' · ' + timeLabel(chosen) + ' IST';
      if (two) { var n = form.elements.namedItem('name'); if (n && !n.value) setTimeout(function () { try { n.focus({ preventScroll: true }); } catch (e) { n.focus(); } }, 50); }
    }
    show(1);
    ui = { email: email, err: err, btn: btn, btnText: btnText, show: show, pickDay: pickDay, remove: function () { [steps, pane1, chip, emailField, err].forEach(function (x) { x.remove(); }); fields.forEach(function (f) { f.hidden = false; }); if (btn) { btn.hidden = false; btn.textContent = btnText; } form.classList.remove('bk'); } };
  }
  function load(again) {
    return fetch(API + '/api/public/freechat/slots', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      if (again && ui) { ui.remove(); ui = null; chosen = null; }
      build(d);
    }).catch(function () { /* no picker: the plain enquiry form still works */ });
  }
  load(false);

  function done(at, mail) {
    var box = document.getElementById('chatSuccess');
    if (!box) return;
    box.innerHTML = '';
    var w = el('div', 'bk bk-done'); w.appendChild(el('div', 'ck', '✓'));
    w.appendChild(el('h3', '', 'Request sent'));
    w.appendChild(el('div', 'when', fmt(at, { weekday: 'long', day: 'numeric', month: 'long' }) + ' · ' + timeLabel(at) + ' IST'));
    w.appendChild(el('p', '', 'It isn’t confirmed yet. We’ll email the Google Meet link and calendar invite to ' + mail + ' once it is, usually within a few hours.'));
    box.appendChild(w);
    form.style.display = 'none'; box.classList.add('show');
  }

  form.addEventListener('submit', function (e) {
    if (form.dataset.anvayaFallback === '1') return;           // native fallback submission
    e.preventDefault();
    var val = function (n) { return (form.elements.namedItem(n) || {}).value || ''; };
    var data = { name: val('name'), phone: val('phone'), situation: val('situation') };
    if (window.AnvayaSrc) { var srcs = window.AnvayaSrc.get(); data.src = srcs.src; data.src_first = srcs.src_first; } // which link/college they came from
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
    var at = chosen;
    data.slot = at; data.email = ui.email.value.trim();
    ui.btn.disabled = true; ui.btn.textContent = 'Sending…';
    fetch(API + '/api/public/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), credentials: 'omit' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (res) {
        ui.btn.disabled = false; ui.btn.textContent = 'Request this time →';
        if (res.ok) return done(at, data.email);
        ui.err.textContent = (res.body && res.body.error) || 'Something went wrong. Please try again.'; ui.err.hidden = false;
        if (res.status === 409) {
          // Taken meanwhile: reload the times, keep what they typed, and send them back to step 1.
          var keep = { name: data.name, phone: data.phone, situation: data.situation, email: data.email, msg: ui.err.textContent };
          load(true).then(function () {
            if (!ui) return;
            ['name', 'phone', 'situation'].forEach(function (n) { var f = form.elements.namedItem(n); if (f) f.value = keep[n]; });
            ui.email.value = keep.email; ui.show(1);
            ui.err.textContent = keep.msg; ui.err.hidden = false;
          });
        }
      })
      .catch(function () { ui.btn.disabled = false; ui.btn.textContent = 'Request this time →'; ui.err.textContent = 'Couldn’t reach Anvaya. Check your connection and try again.'; ui.err.hidden = false; });
  }, true);
})();
