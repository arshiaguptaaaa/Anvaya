// Free-chat enquiries → Anvaya CRM (source of truth). The server then copies each enquiry to the
// existing Google Sheet as a tracked background job. If the CRM can't be reached, the form falls back
// to its original direct Google Sheet submission so no enquiry is lost. The page's own behaviour
// (button text, success message) is unchanged.
(function () {
  var form = document.getElementById('chatForm');
  if (!form || !window.fetch) return;
  form.addEventListener('submit', function (e) {
    if (form.dataset.anvayaFallback === '1') return;           // native fallback submission
    e.preventDefault();                                        // the inline onsubmit handler still runs (UI unchanged)
    var data = {
      name: (form.elements.namedItem('name') || {}).value || '',
      phone: (form.elements.namedItem('phone') || {}).value || '',
      situation: (form.elements.namedItem('situation') || {}).value || '',
    };
    var fallback = function () {
      form.dataset.anvayaFallback = '1';
      try { HTMLFormElement.prototype.submit.call(form); } catch (err) { /* nothing else we can do */ }
    };
    fetch('/api/public/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), credentials: 'omit', keepalive: true })
      .then(function (r) { if (!r.ok) fallback(); })
      .catch(fallback);
  }, true);
})();
