// Anvaya public page polish (see site.css): phone menu and folded plan inclusions.
(function () {
  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  // Visit-source tracking (?src= link codes) for the free-chat form and checkout.
  if (!window.AnvayaSrc && !document.querySelector('script[src*="src-track.js"]')) { var st = document.createElement('script'); st.src = '/app/src-track.js'; document.head.appendChild(st); }
  ready(function () {
    // Phone menu: the section links were hidden below 960px with no way to reach them.
    var nav = document.querySelector('nav'), links = nav && nav.querySelector('.nav-links'), cta = nav && nav.querySelector('.nav-cta');
    if (nav && links && cta && !nav.querySelector('.nav-burger')) {
      var right = document.createElement('div'); right.className = 'nav-right';
      cta.parentNode.insertBefore(right, cta);
      // Log in / Sign up live on the app host; the public site is a different host in production.
      var host = location.hostname, APP = /(^|\.)anvayacareers\.in$/.test(host) && host.indexOf('app.') !== 0 ? 'https://app.anvayacareers.in' : '';
      var login = document.createElement('a'); login.className = 'nav-login'; login.href = APP + '/student/login'; login.textContent = 'Log in';
      var signup = document.createElement('a'); signup.className = 'nav-signup'; signup.href = APP + '/signup'; signup.textContent = 'Sign up';
      right.appendChild(login); right.appendChild(signup); right.appendChild(cta);
      var burger = document.createElement('button');
      burger.type = 'button'; burger.className = 'nav-burger'; burger.setAttribute('aria-label', 'Menu'); burger.setAttribute('aria-expanded', 'false');
      burger.innerHTML = '<i></i><i></i><i></i>';
      right.appendChild(burger);
      var sheet = document.createElement('div'); sheet.className = 'nav-sheet'; sheet.id = 'nav-sheet';
      burger.setAttribute('aria-controls', 'nav-sheet');
      [].forEach.call(links.querySelectorAll('a'), function (a) { var c = a.cloneNode(true); c.removeAttribute('class'); sheet.appendChild(c); });
      var acct = document.createElement('div'); acct.className = 'nav-sheet-acct';
      acct.appendChild(login.cloneNode(true)); acct.appendChild(signup.cloneNode(true)); sheet.appendChild(acct);
      var book = cta.cloneNode(true); book.removeAttribute('class'); sheet.appendChild(book);
      document.body.appendChild(sheet);
      var set = function (open) { sheet.classList.toggle('open', open); burger.setAttribute('aria-expanded', String(open)); };
      burger.addEventListener('click', function () { set(!sheet.classList.contains('open')); });
      sheet.addEventListener('click', function (e) { if (e.target.closest('a')) set(false); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
      window.addEventListener('resize', function () { if (window.innerWidth > 960) set(false); });
    }
    // Plans: show the first four inclusions, with a toggle for the rest.
    [].forEach.call(document.querySelectorAll('.feature-cards'), function (list) {
      var n = list.children.length;
      if (n <= 5) return;
      list.classList.add('is-folded');
      var more = document.createElement('button');
      more.type = 'button'; more.className = 'feat-more';
      var label = function () { more.textContent = list.classList.contains('is-folded') ? 'See all ' + n + ' inclusions  +' : 'Show fewer  −'; };
      label();
      more.addEventListener('click', function () { list.classList.toggle('is-folded'); label(); });
      list.parentNode.insertBefore(more, list.nextSibling);
    });

    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var store = { get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

    // ── Free chat pop-up: the booking card moves into a dialog and back, so there's only ever one form. ──
    var card = document.querySelector('#chat .chat-form-wrap'), chatSec = document.getElementById('chat');
    if (card && chatSec) {
      var home = document.createComment('chat card');
      card.parentNode.insertBefore(home, card);
      var fab = document.createElement('button');
      fab.type = 'button'; fab.className = 'fc-fab'; fab.setAttribute('aria-haspopup', 'dialog');
      fab.innerHTML = '<span class="dot" aria-hidden="true"></span>Free 15-min chat';
      var tip = document.createElement('div'); tip.className = 'fc-tip'; tip.setAttribute('role', 'status');
      tip.innerHTML = '<strong>Not sure where to start?</strong>Pick a time for a free 15-minute chat on Google Meet. No sign-up.<br><button type="button" class="go">See open times →</button><button type="button" class="x" aria-label="Dismiss">×</button>';
      var modal = document.createElement('div'); modal.className = 'fc-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', 'Book a free 15-minute chat');
      modal.innerHTML = '<div class="fc-panel"><button type="button" class="fc-close" aria-label="Close">×</button><div class="fc-panel-head"><div class="eyebrow">Free 15-min chat</div><h3>Let’s find your <em>next step.</em></h3></div><div class="fc-slot"></div></div>';
      document.body.appendChild(tip); document.body.appendChild(fab); document.body.appendChild(modal);
      var slot = modal.querySelector('.fc-slot'), panel = modal.querySelector('.fc-panel'), placeholder = document.createElement('div');
      placeholder.className = 'fc-slot-note'; placeholder.textContent = 'The booking card is open in the pop-up.';
      var lastFocus = null, isOpen = false;
      var open = function () {
        if (isOpen) return; isOpen = true; lastFocus = document.activeElement;
        home.parentNode.insertBefore(placeholder, home); slot.appendChild(card);
        modal.classList.add('open'); document.body.classList.add('fc-lock'); hideTip(); fab.classList.remove('show');
        setTimeout(function () { var first = card.querySelector('.bk-day.on, .bk-day.av, input'); if (first) first.focus({ preventScroll: true }); }, 350);
      };
      var close = function () {
        if (!isOpen) return; isOpen = false;
        modal.classList.remove('open'); document.body.classList.remove('fc-lock');
        setTimeout(function () { if (!isOpen) { home.parentNode.insertBefore(card, home); placeholder.remove(); } }, 300);
        if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
        onScroll();
      };
      fab.addEventListener('click', open);
      modal.querySelector('.fc-close').addEventListener('click', close);
      modal.addEventListener('click', function (e) { if (!panel.contains(e.target)) close(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen) close(); });
      // every "Free chat" link opens the pop-up instead of scrolling to the bottom
      document.addEventListener('click', function (e) {
        var a = e.target.closest && e.target.closest('a[href="#chat"]');
        if (a && !e.defaultPrevented) { e.preventDefault(); open(); }
      });
      // a one-time nudge once the visitor has read a fair bit of the page
      var hideTip = function () { tip.classList.remove('show'); };
      tip.querySelector('.go').addEventListener('click', function () { store.set('anvaya.fctip', '1'); open(); });
      tip.querySelector('.x').addEventListener('click', function () { store.set('anvaya.fctip', '1'); hideTip(); });
      var tipTimer = null;
      var maybeTip = function () {
        if (tipTimer || store.get('anvaya.fctip') || isOpen) return;
        tipTimer = setTimeout(function () { if (!isOpen && fab.classList.contains('show')) { tip.classList.add('show'); store.set('anvaya.fctip', '1'); setTimeout(hideTip, 12000); } }, 1200);
      };
      // the button shows after the hero, and steps aside while the free-chat section itself is on screen
      var hero = document.querySelector('.hero');
      var onScroll = function () {
        if (isOpen) return;
        var past = window.scrollY > (hero ? hero.offsetHeight * 0.6 : 400);
        var r = chatSec.getBoundingClientRect(), inChat = r.top < window.innerHeight * 0.6 && r.bottom > window.innerHeight * 0.4;
        fab.classList.toggle('show', past && !inChat);
        if (inChat) hideTip();
        var depth = window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        if (depth > 0.28 && !inChat) maybeTip();
      };
      window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
    }

    // ── Plan finder: three questions → one recommended plan (or the free chat when they're only exploring) ──
    var plansWrap = document.querySelector('#plans .plans-wrap');
    if (plansWrap) {
      var PLANS = {
        '500mba': { name: 'MBA Planning & Strategy Call', price: '₹500 · 1 × 30 min', why: 'A focused call to map your MBA plan: target schools, how your profile reads today, and what to fix before you apply.' },
        '1500': { name: 'Portfolio Roadmap & Diagnosis', price: '₹1,500 · 1 × 60 min', why: 'An honest read of your profile and a clear roadmap: which roles fit you, what is missing, and the order to fix it in.' },
        '2250': { name: 'Complete Resume Build & Rewrite', price: '₹2,250 · 3 × 45 min', why: 'Your CV rebuilt line by line with you, so it gets shortlisted for the roles you are applying to now.' },
        '3999': { name: 'The Full Picture — Profile Strategy + Resume', price: '₹3,999 · 3 × 60 min + 30 min bonus', why: 'Direction first, then the CV to match: strategy, positioning and a rewritten resume in one programme.' },
        '4500': { name: 'Guesstimate Readiness Programme', price: '₹4,500 · 5 × 60 min', why: 'Five live sessions of guesstimates and case practice with feedback, built for consulting interviews.' },
      };
      var Q = [
        { k: 'stage', q: 'Where are you right now?', o: [['college', 'In college (UG or PG)'], ['working', 'Working'], ['mba', 'Planning an MBA']] },
        { k: 'goal', q: 'What do you need most?', o: [['cv', 'A CV that gets shortlisted'], ['direction', 'Clarity on which roles to aim for and how'], ['interview', 'To crack consulting interviews (guesstimates & cases)'], ['both', 'Both: direction and a new CV'], ['mba', 'A plan for my MBA applications']] },
        { k: 'when', q: 'When do you need it?', o: [['soon', 'In the next 4 weeks'], ['months', 'In 1–3 months'], ['exploring', 'Just exploring for now']] },
      ];
      var pick = function (a) {
        if (a.goal === 'mba' || (a.stage === 'mba' && a.goal !== 'interview')) return { plan: '500mba' };
        var main = { cv: '2250', direction: '1500', interview: '4500', both: '3999' }[a.goal] || '1500';
        if (a.when === 'exploring') return { chat: true, alt: a.goal === 'interview' ? '4500' : main === '2250' || main === '3999' ? '1500' : main };
        return { plan: main, alt: main === '3999' ? '1500' : null };
      };
      var refq = (new URLSearchParams(location.search).get('ref') || '').replace(/[^a-z0-9_-]/gi, '');
      var payUrl = function (key) { return 'anvaya-payment.html?plan=' + key + '&via=quiz' + (refq ? '&ref=' + encodeURIComponent(refq) : ''); };
      var cta = document.createElement('div'); cta.className = 'pf-cta';
      cta.innerHTML = '<p>Not sure which plan fits? <span>Three quick questions.</span></p><button type="button" class="pf-open" aria-haspopup="dialog">Find my plan</button>';
      plansWrap.parentNode.insertBefore(cta, plansWrap);
      var pm = document.createElement('div'); pm.className = 'fc-modal pf-modal'; pm.setAttribute('role', 'dialog'); pm.setAttribute('aria-modal', 'true'); pm.setAttribute('aria-label', 'Find the right plan');
      pm.innerHTML = '<div class="fc-panel"><button type="button" class="fc-close" aria-label="Close">×</button><div class="fc-panel-head"><div class="eyebrow">Plan finder</div><h3>Which plan is <em>right for me?</em></h3></div><div class="pf-body" aria-live="polite"></div></div>';
      document.body.appendChild(pm);
      var body = pm.querySelector('.pf-body'), answers = {}, step = 0, back = null;
      var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
      var draw = function () {
        if (step < Q.length) {
          var q = Q[step];
          body.innerHTML = '<div class="pf-step">Question ' + (step + 1) + ' of ' + Q.length + '</div><p class="pf-q">' + esc(q.q) + '</p><div class="pf-opts">'
            + q.o.map(function (o) { return '<button type="button" class="pf-opt" data-v="' + o[0] + '">' + esc(o[1]) + '</button>'; }).join('') + '</div>'
            + (step ? '<button type="button" class="pf-back">← Back</button>' : '');
          var first = body.querySelector('.pf-opt'); if (first) first.focus({ preventScroll: true });
          return;
        }
        var r = pick(answers), main = r.plan && PLANS[r.plan], alt = r.alt && PLANS[r.alt];
        body.innerHTML = '<div class="pf-result">' + (main
          ? '<div class="pf-step">Our suggestion</div><h4>' + esc(main.name) + '</h4><div class="pf-price">' + esc(main.price) + '</div><p class="pf-why">' + esc(main.why) + '</p>'
            + '<a class="pf-go" href="' + payUrl(r.plan) + '">Book this plan →</a>'
            + (alt ? '<a class="pf-alt" href="' + payUrl(r.alt) + '">Prefer to start smaller? ' + esc(alt.name) + ' (' + esc(alt.price.split(' · ')[0]) + ')</a>' : '')
          : '<div class="pf-step">Our suggestion</div><h4>Start with a free 15-minute chat</h4><p class="pf-why">Since you are still exploring, talk it through with us first. No payment and no sign-up. We will tell you honestly whether you need a paid plan at all.</p>'
            + '<a class="pf-go pf-chat" href="#chat">Book a free 15-min chat →</a>'
            + (alt ? '<a class="pf-alt" href="' + payUrl(r.alt) + '">Or, when you are ready: ' + esc(alt.name) + ' (' + esc(alt.price.split(' · ')[0]) + ')</a>' : ''))
          + (main ? '<a class="pf-alt pf-chat" href="#chat">Still unsure? Book a free 15-min chat</a>' : '') + '<button type="button" class="pf-back">← Change my answers</button></div>';
        var go = body.querySelector('.pf-go'); if (go) go.focus({ preventScroll: true });
      };
      var openPf = function () { back = document.activeElement; answers = {}; step = 0; draw(); pm.classList.add('open'); document.body.classList.add('fc-lock'); };
      var closePf = function () { pm.classList.remove('open'); document.body.classList.remove('fc-lock'); if (back && back.focus) back.focus({ preventScroll: true }); };
      cta.querySelector('.pf-open').addEventListener('click', openPf);
      pm.querySelector('.fc-close').addEventListener('click', closePf);
      pm.addEventListener('click', function (e) {
        if (!pm.querySelector('.fc-panel').contains(e.target)) return closePf();
        var opt = e.target.closest('.pf-opt'); if (opt) { answers[Q[step].k] = opt.dataset.v; step++; return draw(); }
        if (e.target.closest('.pf-back')) { step = step >= Q.length ? 0 : Math.max(0, step - 1); if (step === 0) answers = {}; return draw(); }
        if (e.target.closest('.pf-chat')) { closePf(); } // the page's own #chat handler opens the free-chat pop-up
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && pm.classList.contains('open')) closePf(); });
    }

    // ── Thin gold reading-progress line under the header ──
    var bar = document.createElement('div'); bar.className = 'scroll-progress'; document.body.appendChild(bar);
    var tick = false;
    window.addEventListener('scroll', function () {
      if (tick) return; tick = true;
      requestAnimationFrame(function () { tick = false; bar.style.transform = 'scaleX(' + Math.min(1, window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)) + ')'; });
    }, { passive: true });

    // ── Logo cards: tap to flip on phones (there is no hover there), and a gentle auto-flip while on screen ──
    var flips = [].slice.call(document.querySelectorAll('.flip-card'));
    flips.forEach(function (f) { f.addEventListener('click', function () { f.classList.toggle('flipped'); }); });
    if (flips.length && !calm && 'IntersectionObserver' in window) {
      var idx = 0, timer = null, paused = false, strip = flips[0].parentNode;
      strip.addEventListener('mouseenter', function () { paused = true; }); strip.addEventListener('mouseleave', function () { paused = false; });
      var step = function () {
        if (paused) return;
        flips.forEach(function (f) { f.classList.remove('flipped', 'auto'); });
        var f = flips[idx % flips.length]; f.classList.add('flipped', 'auto'); idx++;
      };
      new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting && !timer) { timer = setInterval(step, 2600); }
          else if (!e.isIntersecting && timer) { clearInterval(timer); timer = null; flips.forEach(function (f) { if (f.classList.contains('auto')) f.classList.remove('flipped', 'auto'); }); }
        });
      }, { threshold: 0.35 }).observe(strip);
    }

    if (calm) return;
    // ── Headline rises in word by word ──
    var h1 = document.querySelector('.hero h1');
    if (h1 && !h1.dataset.split) {
      h1.dataset.split = '1';
      var n = 0;
      (function walk(node) {
        [].slice.call(node.childNodes).forEach(function (c) {
          if (c.nodeType === 3) {
            var frag = document.createDocumentFragment();
            c.textContent.split(/(\s+)/).forEach(function (part) {
              if (!part) return;
              if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
              var w = document.createElement('span'); w.className = 'w'; w.style.setProperty('--i', n++); w.textContent = part; frag.appendChild(w);
            });
            node.replaceChild(frag, c);
          } else if (c.nodeType === 1) walk(c);
        });
      })(h1);
    }
    // ── Stats count up the first time they come into view (500, 100+) ──
    var nums = [].slice.call(document.querySelectorAll('.hstat-n')).filter(function (e) { return /^\d+\+?$/.test(e.textContent.trim()); });
    if (nums.length && 'IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (!e.isIntersecting) return; io.unobserve(e.target);
          var el = e.target, txt = el.textContent.trim(), end = parseInt(txt, 10), plus = /\+$/.test(txt), t0 = null;
          var frame = function (t) { if (!t0) t0 = t; var p = Math.min(1, (t - t0) / 1400), v = Math.round(end * (1 - Math.pow(1 - p, 3))); el.textContent = v + (plus ? '+' : ''); if (p < 1) requestAnimationFrame(frame); };
          el.textContent = '0' + (plus ? '+' : ''); requestAnimationFrame(frame);
        });
      }, { threshold: 0.6 });
      nums.forEach(function (e) { io.observe(e); });
    }
  });
})();
