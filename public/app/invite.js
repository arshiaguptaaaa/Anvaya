(function () {
  const { api, esc, dt, onSubmit } = A;
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  // Keep the secret out of the address bar / history once we've read it.
  if (token) history.replaceState(null, '', '/invite');
  const view = document.getElementById('view');

  function render(html) { view.innerHTML = html; }

  function renderValid(info) {
    render(`
      <div class="steps">
        <div class="step on">1 &middot; Accept invitation</div>
        <div class="step">2 &middot; Create password</div>
        <div class="step">3 &middot; Profile &amp; availability</div>
      </div>
      <div class="eyebrow">Mentor invitation</div>
      <h1 class="title">Welcome, <em>${esc(info.name.split(' ')[0])}</em></h1>
      <p class="sub mb-3">You’ve been invited to mentor with Anvaya. Accept below and create a password for <span class="strong">${esc(info.email)}</span>.</p>
      <form id="acceptForm" novalidate>
        <div class="form-error" hidden></div>
        <div class="field"><label class="label" for="password">Create password</label>
          <input class="input" id="password" name="password" type="password" autocomplete="new-password" required minlength="10">
          <p class="hint">At least 10 characters, with a letter and a number.</p></div>
        <div class="field"><label class="label" for="confirm">Confirm password</label>
          <input class="input" id="confirm" name="confirm" type="password" autocomplete="new-password" required></div>
        <button class="btn btn-primary btn-block mt-1" type="submit">Accept invitation &amp; continue &rarr;</button>
      </form>
      <p class="auth-foot">This link works once and expires ${esc(dt(info.expiresAt))}.</p>`);
    document.querySelector('.steps .step').classList.add('on');
    const form = document.getElementById('acceptForm');
    form.password.addEventListener('focus', () => {
      const s = document.querySelectorAll('.steps .step');
      s[0].className = 'step done'; s[1].className = 'step on';
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
      expired: ['This invitation has <em>expired</em>', `For your security, invitation links only work for a limited time. Request a fresh link and we’ll email it to ${esc(info.email || 'the address on file')}.`, true],
      superseded: ['A newer link was <em>sent</em>', `This link was replaced by a more recent invitation. Use the latest email, or request a fresh link to ${esc(info.email || 'the address on file')}.`, true],
      used: ['Invitation already <em>accepted</em>', 'This link has already been used to set up an account. Sign in with your email and password.', false],
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
      ${info.state === 'used' ? '<a class="btn btn-primary btn-block" href="/mentor/login">Go to mentor sign in &rarr;</a>' : ''}
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
