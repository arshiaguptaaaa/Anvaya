// Visit-source tracking for the public pages. A link like anvayacareers.in/?src=srcc-consulting-club (or the usual
// utm_source / utm_campaign) is remembered in this browser for 90 days — the first code and the latest one — and
// attached to free-chat requests and checkouts so the CRM can show which college, post or campaign they came from.
// A click is counted once per code per browser session. Nothing personal is stored or sent.
(function () {
  var KEY = 'anvaya.src', DAYS = 90, API = /(^|\.)anvayacareers\.in$/.test(location.hostname) && location.hostname.indexOf('app.') !== 0 ? 'https://app.anvayacareers.in' : '';
  var clean = function (x) { return String(x || '').toLowerCase().replace(/[^a-z0-9_.:/-]/g, '').slice(0, 60); };
  var read = function () { try { var v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && v.first && Date.now() - v.first.at < DAYS * 864e5 ? v : null; } catch (e) { return null; } };
  var write = function (v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* private mode */ } };
  var q = new URLSearchParams(location.search);
  var code = clean(q.get('src') || [q.get('utm_source'), q.get('utm_campaign')].filter(Boolean).join('/'));
  var saved = read();
  if (code) {
    var now = { code: code, at: Date.now() };
    write({ first: saved ? saved.first : now, last: now });
    var seen = ''; try { seen = sessionStorage.getItem('anvaya.src.seen') || ''; } catch (e) { /* ignore */ }
    if (seen !== code) {
      try { sessionStorage.setItem('anvaya.src.seen', code); } catch (e) { /* ignore */ }
      try { fetch(API + '/api/public/ref-visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', keepalive: true, body: JSON.stringify({ src: code }) }).catch(function () {}); } catch (e) { /* ignore */ }
    }
  } else if (!saved && document.referrer) {
    // No code: remember where they came from (e.g. ref:instagram.com) so it isn't simply "(no code)".
    try {
      var host = new URL(document.referrer).hostname.replace(/^www\.|^l\.|^lm\./, '');
      if (host && !/anvayacareers\.in$/.test(host)) { var r = { code: clean('ref:' + host), at: Date.now() }; write({ first: r, last: r }); }
    } catch (e) { /* bad referrer */ }
  }
  window.AnvayaSrc = { get: function () { var v = read(); return v ? { src: v.last.code, src_first: v.first.code } : { src: '', src_first: '' }; } };
})();
