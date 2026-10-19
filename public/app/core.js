// Shared helpers for the Anvaya dashboards (no framework; CSP-friendly — no inline scripts or styles).
// Times are always shown and entered in IST. Money travels as integer paise; forms take rupees.
(function () {
  let csrf = null;
  const IST_MS = 330 * 60e3;

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && !/^\/api\/(auth\/(login|forgot)|invites)/.test(path)) {
      const p = location.pathname;
      location.href = p.startsWith('/admin') ? '/admin/login' : p.startsWith('/mentor') ? '/mentor/login' : '/student/login';
      throw new Error('Session expired');
    }
    if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
    return data;
  }
  async function loadMe() { const me = await api('/api/auth/me'); csrf = me.csrf; return me; }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** Paise → "₹1,999" (or "₹1,999.50"). */
  const inr = (p) => '₹' + (Number(p || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const toPaise = (rupees) => (rupees === '' || rupees == null ? '' : Math.round(Number(rupees) * 100));
  const toRupees = (p) => (p == null || p === '' ? '' : Number(p) / 100);
  const parse = (s) => new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  const dt = (iso, opts = { dateStyle: 'medium', timeStyle: 'short' }) => (iso ? parse(iso).toLocaleString('en-IN', { ...opts, timeZone: 'Asia/Kolkata' }) : '—');
  const d = (iso) => dt(iso, { dateStyle: 'medium' });
  const time = (iso) => dt(iso, { timeStyle: 'short' });
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  /** ISO → value for <input type="datetime-local"> in IST. */
  const toLocalInput = (iso) => (iso ? new Date(parse(iso).getTime() + IST_MS).toISOString().slice(0, 16) : '');
  /** <input type="datetime-local"> value (IST wall clock) → ISO UTC. */
  const fromLocalInput = (v) => {
    if (!v) return '';
    const [date, t] = v.split('T'); const [y, m, dd] = date.split('-').map(Number); const [hh, mm] = t.split(':').map(Number);
    return new Date(Date.UTC(y, m - 1, dd, hh, mm) - IST_MS).toISOString();
  };
  const label = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

  function toast(msg, isErr = false) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.toggle('err', isErr); t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4200);
  }

  /** Associates each .field label with its control (screen readers + click-to-focus). */
  let fieldSeq = 0;
  function labelFields(root) {
    root.querySelectorAll('.field').forEach((f) => {
      const lab = f.querySelector('label'); const ctl = f.querySelector('input, select, textarea');
      if (lab && ctl && !lab.htmlFor && !lab.classList.contains('check')) { ctl.id = ctl.id || `fld-${++fieldSeq}`; lab.htmlFor = ctl.id; }
    });
  }
  new MutationObserver(() => labelFields(document)).observe(document.documentElement, { childList: true, subtree: true });

  /** Opens a modal. `html` is trusted template markup (callers escape data). Returns { el, close }. */
  function modal(html, { onClose, wide = false } = {}) {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="card card-gold modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true"><button class="modal-x" aria-label="Close">&times;</button>${html}</div>`;
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
    const onKey = (e) => { if (e.key === 'Escape' && bg === [...document.querySelectorAll('.modal-bg')].pop()) close(); };
    bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('.modal-x') || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bg);
    labelFields(bg);
    const first = bg.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea');
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

  const formData = (form) => Object.fromEntries(new FormData(form).entries());

  /** Wires a form submit with busy state + inline error display. */
  function onSubmit(form, handler) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.submitter || form.querySelector('[type="submit"]');
      const errBox = form.querySelector('.form-error');
      if (errBox) errBox.hidden = true;
      const text = btn && btn.textContent;
      if (btn) { btn.disabled = true; btn.textContent = 'Please wait…'; }
      try { await handler(formData(form), btn); }
      catch (err) {
        if (errBox) { errBox.textContent = err.message; errBox.hidden = false; errBox.scrollIntoView({ block: 'nearest' }); } else toast(err.message, true);
      } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = text; } }
    });
  }

  const PILL = {
    invite_pending: ['Invite pending', ''], active: ['Active', 'ok'], deactivated: ['Deactivated', 'off'],
    new: ['New', ''], contacted: ['Contacted', ''], qualified: ['Qualified', 'ok'], converted: ['Converted', 'ok'], lost: ['Lost', 'off'],
    scheduled: ['Scheduled', ''], requested: ['Awaiting payment', ''], pending_payment: ['Paying…', ''], completed: ['Completed', 'ok'], cancelled: ['Cancelled', 'off'], no_show: ['No-show', 'bad'],
    paid: ['Paid', 'ok'], pending: ['Pending', ''], refunded: ['Refunded', 'off'], partially_refunded: ['Part-refunded', 'off'], failed: ['Failed', 'bad'], created: ['Unpaid', ''],
    paused: ['Paused', 'off'], grace: ['Grace period', ''], expired: ['Expired', 'bad'], due: ['Due', ''], overdue: ['Overdue', 'bad'], waived: ['Waived', 'ok'],
    present: ['Present', 'ok'], late: ['Late', ''], absent: ['Absent', 'bad'], excused: ['Excused', 'off'],
    intake: ['Intake', ''], assigned: ['Assigned', ''], first_draft: ['First draft', ''], coach_edit: ['Coach edit', ''], qa: ['In QA', ''], delivered: ['Delivered', 'ok'], revision: ['Revision', ''], closed: ['Closed', 'off'],
    synced: ['Synced', 'ok'], not_required: ['—', 'off'], sent_by_browser: ['Browser', 'off'],
    applied: ['Applied', ''], shortlisted: ['Shortlisted', 'ok'], interview: ['Interview', 'ok'], offer: ['Offer', 'ok'], accepted: ['Accepted', 'ok'], rejected: ['Rejected', 'off'], withdrawn: ['Withdrawn', 'off'],
    not_started: ['Not started', 'off'], in_progress: ['In progress', ''], submitted: ['Submitted', ''], reviewed: ['Reviewed', 'ok'], done: ['Done', 'ok'],
    queued: ['Queued', ''], running: ['Running', ''], dead: ['Dead', 'bad'], succeeded: ['Done', 'ok'], blocked_by_cap: ['Over cap', 'bad'],
    pass: ['Pass', 'ok'], changes_requested: ['Changes', 'bad'],
  };
  function statusPill(status) {
    const [txt, cls] = PILL[status] || [label(status), ''];
    return `<span class="pill ${cls}">${esc(txt)}</span>`;
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.href = location.pathname.startsWith('/admin') ? '/admin/login' : location.pathname.startsWith('/mentor') ? '/mentor/login' : '/student/login'; }
  }

  /** Mobile sidebar toggle + tab routing via location.hash. */
  function shell(render, fallback = 'overview') {
    const side = document.querySelector('.side');
    document.querySelector('.menu-btn')?.addEventListener('click', () => side.classList.toggle('open'));
    document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', logout));
    const go = () => {
      const tab = (location.hash || `#${fallback}`).slice(1);
      document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
      side.classList.remove('open');
      render(tab);
    };
    document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => { if (location.hash === `#${b.dataset.tab}`) go(); else location.hash = b.dataset.tab; }));
    window.addEventListener('hashchange', go);
    go();
  }

  /** Uploads a file privately: signed upload URL → direct PUT → server confirms. */
  async function upload(file, meta) {
    const u = await api('/api/files/upload-url', { method: 'POST', body: { ...meta, filename: file.name, mime_type: file.type || 'application/octet-stream', size: file.size } });
    const put = await fetch(u.upload_url, { method: u.method || 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' } });
    if (!put.ok) throw new Error('Upload failed. Please try again.');
    await api(`/api/files/${u.version_id}/complete`, { method: 'POST' });
    return u;
  }
  /** Opens a private file via a 60-second link (or shows a text draft). */
  async function openFile(versionId) {
    try {
      const r = await api(`/api/files/${versionId}/download`);
      if (r.url) window.open(r.url, '_blank', 'noopener');
      else modal(`<div class="eyebrow">Document</div><h2 class="h2 mb-2">${esc(r.title || 'Draft')}</h2><pre class="doc-text">${esc(r.text)}</pre>`, { wide: true });
    } catch (e) { toast(e.message, true); }
  }

  // ── Declarative forms (used by every CRUD screen) ───────────────────
  /** field: { name, label, type, options:[[v,l]], span2, required, hint, placeholder, min, max, step }
   *  types: text|email|tel|url|number|money|textarea|select|datetime|date|checkbox|time */
  function fieldHtml(f, val) {
    const v = val ?? f.value ?? '';
    const common = `name="${esc(f.name)}"${f.required ? ' required' : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}${f.disabled ? ' disabled' : ''}`;
    let ctl;
    if (f.type === 'textarea') ctl = `<textarea class="input" ${common} rows="${f.rows || 4}">${esc(v)}</textarea>`;
    else if (f.type === 'select') ctl = `<select class="input" ${common}>${(f.options || []).map(([ov, ol]) => `<option value="${esc(ov)}"${String(v) === String(ov) ? ' selected' : ''}>${esc(ol)}</option>`).join('')}</select>`;
    else if (f.type === 'checkbox') return `<div class="field ${f.span2 ? 'span-2' : ''}"><label class="check"><input type="checkbox" name="${esc(f.name)}" value="true"${v === true || v === 'true' ? ' checked' : ''}> <span>${esc(f.label)}</span></label>${f.hint ? `<p class="hint">${esc(f.hint)}</p>` : ''}</div>`;
    else {
      const type = { money: 'number', datetime: 'datetime-local' }[f.type] || f.type || 'text';
      const shown = f.type === 'money' ? toRupees(v) : f.type === 'datetime' ? toLocalInput(v) : f.type === 'date' && v ? String(v).slice(0, 10) : v;
      const extra = f.type === 'money' ? ' min="0" step="0.01" inputmode="decimal"' : `${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}${f.step ? ` step="${f.step}"` : ''}`;
      ctl = `<input class="input" type="${type}" ${common} value="${esc(shown)}"${extra}>`;
    }
    const lab = f.type === 'money' ? `${f.label} (₹)` : f.type === 'datetime' ? `${f.label} (IST)` : f.label;
    return `<div class="field ${f.span2 ? 'span-2' : ''}"><label class="label">${esc(lab)}</label>${ctl}${f.hint ? `<p class="hint">${esc(f.hint)}</p>` : ''}</div>`;
  }
  /** Converts raw form values to API values per field type. */
  function collect(form, fields) {
    const out = {};
    for (const f of fields) {
      if (f.disabled || f.readOnly) continue;
      const el = form.elements.namedItem(f.name);
      if (!el) continue;
      let v = f.type === 'checkbox' ? el.checked : el.value;
      if (f.type === 'money') v = toPaise(v);
      else if (f.type === 'datetime') v = fromLocalInput(v);
      out[f.name] = v;
    }
    return out;
  }
  /** Opens a form modal; resolves after a successful save. */
  function formModal({ eyebrow = '', title, fields, values = {}, submit = 'Save', onSave, intro = '' }) {
    return new Promise((resolve) => {
      const ui = modal(`<div class="eyebrow">${esc(eyebrow)}</div><h2 class="h2 mb-2">${title}</h2>${intro}
        <form novalidate><div class="form-error" hidden></div><div class="form-grid">${fields.map((f) => fieldHtml(f, values[f.name])).join('')}</div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">${esc(submit)}</button></div></form>`);
      const form = ui.el.querySelector('form');
      onSubmit(form, async () => { const r = await onSave(collect(form, fields), form); ui.close(); resolve(r); });
    });
  }

  /** A searchable, filterable table card. columns: [{ h, render(row), cls }] */
  function tableCard({ rows, columns, search, filter, empty = 'Nothing here yet.', rowActions, title }) {
    const wrap = document.createElement('div');
    wrap.className = 'card reveal mb-3';
    wrap.innerHTML = `${title ? `<div class="card-head"><h2 class="h2">${title}</h2></div>` : ''}${search || filter ? `<div class="toolbar">
        ${search ? '<input class="input" type="search" placeholder="Search…" aria-label="Search">' : ''}
        ${filter ? `<select class="input" aria-label="Filter"><option value="">All</option>${filter.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>` : ''}
        <span class="muted small" data-n></span></div>` : ''}
      <div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th>${c.h}</th>`).join('')}${rowActions ? '<th></th>' : ''}</tr></thead><tbody></tbody></table></div>`;
    const tbody = wrap.querySelector('tbody');
    const q = wrap.querySelector('input[type=search]');
    const f = wrap.querySelector('select');
    const n = wrap.querySelector('[data-n]');
    const draw = () => {
      const term = (q?.value || '').trim().toLowerCase();
      const list = rows.filter((r) => (!term || search(r).toLowerCase().includes(term)) && (!f || !f.value || String(filter.value ? filter.value(r) : r[filter.key]) === f.value));
      if (n) n.textContent = `${list.length} of ${rows.length}`;
      tbody.innerHTML = list.length
        ? list.map((r) => `<tr data-id="${esc(r.id ?? '')}">${columns.map((c) => `<td class="${c.cls || ''}" data-h="${esc(String(c.h).replace(/<[^>]+>/g, ''))}">${c.render(r)}</td>`).join('')}${rowActions ? `<td class="actions">${rowActions(r)}</td>` : ''}</tr>`).join('')
        : `<tr><td colspan="${columns.length + 1}"><div class="empty">${empty}</div></td></tr>`;
    };
    q?.addEventListener('input', draw); f?.addEventListener('change', draw);
    draw();
    return wrap;
  }
  /** Delegated row-action clicks: data-act="name" on buttons inside rows (or data-id on the button). */
  function onAct(root, handlers) {
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b || !root.contains(b)) return;
      const rowId = b.dataset.id || b.closest('tr')?.dataset.id;
      const fn = handlers[b.dataset.act];
      if (fn) Promise.resolve(fn(isNaN(Number(rowId)) ? rowId : Number(rowId), b)).catch((err) => toast(err.message, true));
    });
  }
  const pageHead = (eyebrow, title, sub, actions = '') => `<div class="page-head reveal"><div><div class="eyebrow">${eyebrow}</div>
    <h1 class="title">${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="row">${actions}</div></div>`;
  const stat = (n, l) => `<div class="card stat"><span class="stat-n">${n}</span><span class="stat-l">${l}</span></div>`;
  const opt = (rows, valKey = 'id', labelKey = 'name', blank) => [...(blank ? [['', blank]] : []), ...rows.map((r) => [r[valKey], typeof labelKey === 'function' ? labelKey(r) : r[labelKey]])];

  window.A = { api, loadMe, esc, inr, toPaise, toRupees, dt, d, time, DAYS, toLocalInput, fromLocalInput, label, toast, modal, confirmBox, formData, onSubmit, statusPill,
    shell, logout, upload, openFile, fieldHtml, collect, formModal, tableCard, onAct, pageHead, stat, opt };
})();
