// Sends free-chat enquiries to the Anvaya CRM in addition to the existing Google Sheet submission.
// It never blocks or alters the original form: the Google Apps Script post and the success message work as before.
(function () {
  var form = document.getElementById('chatForm');
  if (!form) return;
  form.addEventListener('submit', function () {
    try {
      var body = JSON.stringify({
        name: (form.elements.name && form.elements.name.value) || '',
        phone: (form.elements.phone && form.elements.phone.value) || '',
        situation: (form.elements.situation && form.elements.situation.value) || '',
      });
      fetch('/api/public/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true, credentials: 'omit' })
        .catch(function () { /* the Google Sheet copy still exists */ });
    } catch (e) { /* never interfere with the original form */ }
  }, true);
})();
