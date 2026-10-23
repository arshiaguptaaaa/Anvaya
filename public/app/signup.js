// Student sign-up: name + email → a link to set a password (or Google, which verifies the email itself).
(function () {
  fetch('/api/auth/providers', { credentials: 'same-origin' }).then((r) => r.json()).then((p) => { if (p.google) document.getElementById('googleBox').hidden = false; }).catch(() => {});
  const form = document.getElementById('signupForm');
  A.onSubmit(form, async (data) => {
    const r = await A.api('/api/auth/signup', { method: 'POST', body: data });
    form.hidden = true;
    const done = document.getElementById('done');
    done.textContent = r.message; done.hidden = false;
  });
})();
