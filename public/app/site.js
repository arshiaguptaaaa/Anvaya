// Anvaya public page polish (see site.css): phone menu and folded plan inclusions.
(function () {
  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function () {
    // Phone menu: the section links were hidden below 960px with no way to reach them.
    var nav = document.querySelector('nav'), links = nav && nav.querySelector('.nav-links'), cta = nav && nav.querySelector('.nav-cta');
    if (nav && links && cta && !nav.querySelector('.nav-burger')) {
      var right = document.createElement('div'); right.className = 'nav-right';
      cta.parentNode.insertBefore(right, cta); right.appendChild(cta);
      var burger = document.createElement('button');
      burger.type = 'button'; burger.className = 'nav-burger'; burger.setAttribute('aria-label', 'Menu'); burger.setAttribute('aria-expanded', 'false');
      burger.innerHTML = '<i></i><i></i><i></i>';
      right.appendChild(burger);
      var sheet = document.createElement('div'); sheet.className = 'nav-sheet'; sheet.id = 'nav-sheet';
      burger.setAttribute('aria-controls', 'nav-sheet');
      [].forEach.call(links.querySelectorAll('a'), function (a) { var c = a.cloneNode(true); c.removeAttribute('class'); sheet.appendChild(c); });
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
  });
})();
