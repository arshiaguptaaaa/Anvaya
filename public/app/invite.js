(function () {
  const { api, esc, dt, onSubmit } = A;
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  const isReset = location.pathname === '/reset';
  // Keep the secret out of the address bar / history once we've read it.
  if (token) history.replaceState(null, '', location.pathname);
  const view = document.getElementById('view');

  function render(html) { view.innerHTML = html; }

  const KIND = {
    mentor_invite: { eyebrow: 'Mentor invitation', lede: 'You’ve been invited to mentor with Anvaya. Accept below and create a password for', steps: ['Accept invitation', 'Create password', 'Profile &amp; availability'], cta: 'Accept invitation &amp; continue &rarr;' },
    student_invite: { eyebrow: 'Student account', lede: 'Your Anvaya student dashboard is ready. Create a password for', steps: ['Open your account', 'Create password', 'Complete intake'], cta: 'Create password &amp; continue &rarr;' },
    staff_invite: { eyebrow: 'Anvaya team', lede: 'You’ve been added to the Anvaya team. Create a password for', steps: ['Accept', 'Create password', 'Open dashboard'], cta: 'Create password &amp; continue &rarr;' },
    password_reset: { eyebrow: 'Password reset', lede: 'Choose a new password for', steps: null, cta: 'Save new password &rarr;' },
  };
  function renderValid(info) {
    const k = KIND[info.kind] || KIND.mentor_invite;
    render(`
      ${k.steps ? `<div class="steps">${k.steps.map((s, i) => `<div class="step${i === 0 ? ' on' : ''}">${i + 1} &middot; ${s}</div>`).join('')}</div>` : ''}
      <div class="eyebrow">${k.eyebrow}</div>
      <h1 class="title">${info.kind === 'password_reset' ? 'New <em>password</em>' : `Welcome, <em>${esc(info.name.split(' ')[0])}</em>`}</h1>
      <p class="sub mb-3">${k.lede} <span class="strong">${esc(info.email)}</span>.</p>
      <form id="acceptForm" novalidate>
        <div class="form-error" hidden></div>
        <div class="field"><label class="label" for="password">Create password</label>
          <input class="input" id="password" name="password" type="password" autocomplete="new-password" required minlength="10">
          <p class="hint">At least 10 characters, with a letter and a number.</p></div>
        <div class="field"><label class="label" for="confirm">Confirm password</label>
          <input class="input" id="confirm" name="confirm" type="password" autocomplete="new-password" required></div>
        <button class="btn btn-primary btn-block mt-1" type="submit">${k.cta}</button>
      </form>
      <p class="auth-foot">This link works once and expires ${esc(dt(info.expiresAt))}.</p>`);
    const form = document.getElementById('acceptForm');
    form.password.addEventListener('focus', () => {
      const s = document.querySelectorAll('.steps .step');
      if (s.length) { s[0].className = 'step done'; s[1].className = 'step on'; }
    }, { once: true });
    onSubmit(form, async (data) => {
      try {
        const r = await api('/api/invites/accept', { method: 'POST', body: { token, ...data } });
        location.href = r.next;
      } catch (e) {
        if (e.status === 410) return renderState({ state: e.data?.state || 'used' });
        throw e;
      }
    });
  }

  function renderState(info) {
    const first = info.name ? `, ${esc(info.name)}` : '';
    const copy = {
      expired: [isReset ? 'This reset link has <em>expired</em>' : 'This invitation has <em>expired</em>', `For your security, invitation links only work for a limited time. Request a fresh link and we’ll email it to ${esc(info.email || 'the address on file')}.`, true],
      superseded: ['A newer link was <em>sent</em>', `This link was replaced by a more recent invitation. Use the latest email, or request a fresh link to ${esc(info.email || 'the address on file')}.`, true],
      used: [isReset ? 'Link already <em>used</em>' : 'Invitation already <em>accepted</em>', isReset ? 'This reset link has already been used. Request a new one from the sign-in page.' : 'This link has already been used to set up an account. Sign in with your email and password.', false],
      deactivated: ['Invitation <em>unavailable</em>', 'This invitation is no longer active. Please contact the Anvaya team if you think this is a mistake.', false],
      invalid: ['Link not <em>recognised</em>', 'We couldn’t find this invitation. Check that you opened the full link from your email, or contact the Anvaya team.', false],
    }[info.state] || ['Something went <em>wrong</em>', 'Please try again.', false];
    render(`
      <div class="state-icon">&#10022;</div>
      <div class="eyebrow">Mentor invitation${first}</div>
      <h1 class="title">${copy[0]}</h1>
      <p class="sub mb-3">${copy[1]}</p>
      <div id="msg"></div>
      ${copy[2] ? '<button class="btn btn-primary btn-block" id="fresh">Email me a fresh link &rarr;</button>' : ''}
      ${info.state === 'used' ? '<a class="btn btn-primary btn-block" href="/login">Go to sign in &rarr;</a>' : ''}
      <p class="auth-foot"><a href="/">Back to Anvaya</a></p>`);
    const btn = document.getElementById('fresh');
    if (btn) btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Sending…';
      const msg = document.getElementById('msg');
      try {
        const r = await api('/api/invites/request-new', { method: 'POST', body: { token } });
        msg.innerHTML = `<div class="form-ok">${esc(r.message)} The new link replaces this one.</div>`;
        btn.remove();
      } catch (e) {
        msg.innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
        btn.disabled = false; btn.textContent = 'Email me a fresh link →';
      }
    });
  }

  (async () => {
    if (!token) return renderState({ state: 'invalid' });
    try {
      const info = await api('/api/invites/inspect', { method: 'POST', body: { token } });
      info.state === 'valid' ? renderValid(info) : renderState(info);
    } catch (e) { render(`<div class="form-error">${esc(e.message)}</div>`); }
  })();
})();
