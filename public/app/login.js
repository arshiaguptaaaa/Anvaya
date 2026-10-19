(function () {
  const p = location.pathname;
  const area = p.startsWith('/admin') ? 'admin' : p.startsWith('/mentor') ? 'mentor' : 'student';
  const copy = {
    admin: ['Team console', 'Team <em>sign in</em>', 'For the Anvaya team: CRM, scheduling, students, mentors and payments.'],
    mentor: ['Mentor portal', 'Mentor <em>sign in</em>', 'Your sessions, students, review tasks and earnings — in one place.'],
    student: ['Student dashboard', 'Welcome <em>back</em>', 'Your plan, syllabus, sessions and services.'],
  }[area];
  document.getElementById('eyebrow').textContent = copy[0];
  document.getElementById('heading').innerHTML = copy[1];
  document.getElementById('lede').textContent = copy[2];
  document.getElementById('foot').innerHTML = area === 'admin' ? '<a href="/">&larr; Back to Anvaya</a>'
    : 'New here? Use the link in your welcome email. &middot; <a href="/">Back to Anvaya</a>';

  A.onSubmit(document.getElementById('loginForm'), async (data) => {
    const r = await A.api('/api/auth/login', { method: 'POST', body: data });
    location.href = r.next;
  });
  document.getElementById('forgot').addEventListener('click', () => {
    const ui = A.modal(`<div class="eyebrow">Password reset</div><h2 class="h2 mb-2">Forgot your <em>password?</em></h2>
      <p class="sub mb-3">Enter your account email and we’ll send a reset link (valid for 1 hour).</p>
      <form novalidate><div class="form-error" hidden></div><div class="field"><label class="label">Email</label><input class="input" name="email" type="email" required autocomplete="username"
      value="${A.esc(document.getElementById('email').value)}"></div><div id="msg"></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" type="submit">Send reset link</button></div></form>`);
    A.onSubmit(ui.el.querySelector('form'), async (d, btn) => {
      const r = await A.api('/api/auth/forgot', { method: 'POST', body: d });
      ui.el.querySelector('#msg').innerHTML = `<div class="form-ok">${A.esc(r.message)}</div>`;
      btn.remove();
    });
  });
})();
