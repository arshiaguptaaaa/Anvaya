// Weekly availability slot editor, shared by onboarding and the mentor dashboard.
(function () {
  const { DAYS, esc } = A;
  function slotRow(s = { weekday: 1, start_time: '18:00', end_time: '20:00' }) {
    const row = document.createElement('div');
    row.className = 'slot';
    row.innerHTML = `
      <select class="input" aria-label="Day">${DAYS.map((d, i) => `<option value="${i}"${i === Number(s.weekday) ? ' selected' : ''}>${d}</option>`).join('')}</select>
      <input class="input" type="time" aria-label="Start" value="${esc(s.start_time)}">
      <input class="input" type="time" aria-label="End" value="${esc(s.end_time)}">
      <button type="button" class="slot-x" aria-label="Remove slot">&times;</button>`;
    row.querySelector('.slot-x').addEventListener('click', () => row.remove());
    return row;
  }
  A.availabilityEditor = function (container, addBtn, initial) {
    (initial && initial.length ? initial : [{ weekday: 1, start_time: '18:00', end_time: '20:00' }, { weekday: 6, start_time: '10:00', end_time: '13:00' }])
      .forEach((s) => container.appendChild(slotRow(s)));
    addBtn.addEventListener('click', () => container.appendChild(slotRow()));
    return () => [...container.querySelectorAll('.slot')].map((r) => {
      const [day, start, end] = r.querySelectorAll('select, input');
      return { weekday: Number(day.value), start_time: start.value, end_time: end.value };
    });
  };
  A.weekView = function (slots) {
    return `<div class="week">${DAYS.map((d, i) => {
      const today = slots.filter((s) => s.weekday === i);
      return `<div class="day"><div class="day-n">${d.slice(0, 3)}</div><div class="day-t">${today.length ? today.map((s) => `${esc(s.start_time)}–${esc(s.end_time)}`).join('<br>') : '<span class="muted">—</span>'}</div></div>`;
    }).join('')}</div>`;
  };
})();
