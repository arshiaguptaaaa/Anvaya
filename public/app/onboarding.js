(async function () {
  const { api, loadMe, inr, onSubmit } = A;
  document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', A.logout));
  await loadMe();
  const me = await api('/api/mentor/me');
  const form = document.getElementById('onbForm');
  for (const k of ['name', 'phone', 'expertise', 'bio', 'linkedin', 'session_duration', 'meeting_link', 'session_details', 'timezone']) {
    if (me[k] != null && me[k] !== '') form[k].value = me[k];
  }
  document.getElementById('session_price').value = `${inr(me.session_price)} per session`;
  const readSlots = A.availabilityEditor(document.getElementById('slots'), document.getElementById('addSlot'), me.availability);
  onSubmit(form, async (data) => {
    const r = await api('/api/mentor/onboarding', { method: 'POST', body: { ...data, availability: readSlots() } });
    location.href = r.next;
  });
})();
