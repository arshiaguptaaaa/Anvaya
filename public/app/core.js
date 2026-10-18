// Shared helpers for the Anvaya dashboards (no framework; CSP-friendly — no inline scripts or styles).
(function () {
  let csrf = null;

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/invites')) {
      location.href = location.pathname.startsWith('/admin') ? '/admin/login' : '/mentor/login';
      throw new Error('Session expired');
    }
    if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  async function loadMe() {
    const me = await api('/api/auth/me');
    csrf = me.csrf;
    return me;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  // SQLite's datetime('now') gives "YYYY-MM-DD HH:MM:SS" in UTC; normalise to ISO before parsing.
  const parse = (s) => new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  const dt = (iso, opts = { dateStyle: 'medium', timeStyle: 'short' }) => (iso ? parse(iso).toLocaleString('en-IN', opts) : '—');
  const d = (iso) => dt(iso, { dateStyle: 'medium' });
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  /** ISO → value for <input type="datetime-local"> in the viewer's local time. */
  const toLocalInput = (iso) => { if (!iso) return ''; const x = new Date(iso); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

  /** Associates each .field label with its control (screen readers + click-to-focus). */
  let fieldSeq = 0;
  function labelFields(root) {
    root.querySelectorAll('.field').forEach((f) => {
      const lab = f.querySelector('label'); const ctl = f.querySelector('input, select, textarea');
      if (lab && ctl && !lab.htmlFor) { ctl.id = ctl.id || `fld-${++fieldSeq}`; lab.htmlFor = ctl.id; }
    });
  }
  new MutationObserver(() => labelFields(document)).observe(document.documentElement, { childList: true, subtree: true });

  function toast(msg, isErr = false) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.toggle('err', isErr); t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3800);
  }

  /** Opens a modal. `html` is trusted template markup (callers escape data). Returns { el, close }. */
  function modal(html, { onClose } = {}) {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="card card-gold modal" role="dialog" aria-modal="true"><button class="modal-x" aria-label="Close">&times;</button>${html}</div>`;
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
    const onKey = (e) => { if (e.key === 'Escape' && bg === [...document.querySelectorAll('.modal-bg')].pop()) close(); }; // topmost only
    bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('.modal-x') || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bg);
    labelFields(bg);
    const first = bg.querySelector('input, select, textarea');
    if (first) first.focus();
    return { el: bg, close };
  }

  function confirmBox(title, text, { danger = false, ok = 'Confirm' } = {}) {
    return new Promise((resolve) => {
      let answered = false;
      const m = modal(`<h2 class="h2">${esc(title)}</h2><p class="sub confirm-text">${esc(text)}</p>
        <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(ok)}</button></div>`, { onClose: () => { if (!answered) resolve(false); } });
      m.el.querySelector('[data-ok]').addEventListener('click', () => { answered = true; m.close(); resolve(true); });
    });
  }

  /** Reads a form into a plain object (empty strings kept, numbers left as strings for the server to validate). */
  const formData = (form) => Object.fromEntries(new FormData(form).entries());

  /** Wires a form submit with busy state + inline error display. */
  function onSubmit(form, handler) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      const errBox = form.querySelector('.form-error');
      if (errBox) errBox.hidden = true;
      const label = btn && btn.textContent;
      if (btn) { btn.disabled = true; btn.textContent = 'Please wait…'; }
      try { await handler(formData(form)); }
      catch (err) {
        if (errBox) { errBox.textContent = err.message; errBox.hidden = false; } else toast(err.message, true);
      } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
    });
  }

  function statusPill(status) {
    const map = {
      invite_pending: ['Invite pending', ''], active: ['Active', 'ok'], deactivated: ['Deactivated', 'off'],
      new: ['New', ''], contacted: ['Contacted', ''], qualified: ['Qualified', 'ok'], converted: ['Converted', 'ok'], lost: ['Lost', 'off'],
      scheduled: ['Scheduled', ''], completed: ['Completed', 'ok'], cancelled: ['Cancelled', 'off'], no_show: ['No-show', 'bad'],
      paid: ['Paid', 'ok'], pending: ['Pending', ''], refunded: ['Refunded', 'off'], failed: ['Failed', 'bad'],
      paused: ['Paused', 'off'],
    };
    const [label, cls] = map[status] || [status, ''];
    return `<span class="pill ${cls}">${esc(label)}</span>`;
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.href = location.pathname.startsWith('/admin') ? '/admin/login' : '/mentor/login'; }
  }

  /** Mobile sidebar toggle + tab routing via location.hash. */
  function shell(render) {
    const side = document.querySelector('.side');
    document.querySelector('.menu-btn')?.addEventListener('click', () => side.classList.toggle('open'));
    document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', logout));
    const go = () => {
      const tab = (location.hash || '#overview').slice(1);
      document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
      side.classList.remove('open');
      render(tab);
    };
    document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.tab; }));
    window.addEventListener('hashchange', go);
    go();
  }

  window.A = { api, loadMe, esc, inr, dt, d, DAYS, toLocalInput, toast, modal, confirmBox, formData, onSubmit, statusPill, shell, logout };
})();
