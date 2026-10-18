(function () {
  const isAdmin = location.pathname.startsWith('/admin');
  document.getElementById('eyebrow').textContent = isAdmin ? 'Admin console' : 'Mentor portal';
  document.getElementById('heading').innerHTML = isAdmin ? 'Admin <em>sign in</em>' : 'Mentor <em>sign in</em>';
  document.getElementById('lede').textContent = isAdmin
    ? 'Manage students, leads, mentors, bookings and payments.'
    : 'Your sessions, students, notes and earnings — in one place.';
  document.getElementById('foot').innerHTML = isAdmin
    ? '<a href="/">&larr; Back to Anvaya</a>'
    : 'New mentor? Use the invitation link in your email. &middot; <a href="/">Back to Anvaya</a>';

  A.onSubmit(document.getElementById('loginForm'), async (data) => {
    const r = await A.api('/api/auth/login', { method: 'POST', body: data });
    location.href = r.next;
  });
})();
