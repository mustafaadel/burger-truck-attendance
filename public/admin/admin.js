const $ = (s, el = document) => el.querySelector(s);
const api = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { 'content-type': 'application/json', ...opts.headers } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const qrImg = (data) => `/api/admin/qr.svg?data=${encodeURIComponent(data)}`;
const FLAG_LABEL = {
  hash_mismatch: 'edited', chain_broken: 'records missing/edited', missing_previous: 'earlier record missing',
  clock_went_back: 'clock moved back', phone_clock_wrong: 'phone clock wrong', future_time: 'future time',
  new_device: 'new phone', qr_missing: 'no QR', qr_invalid: 'wrong QR', qr_retired: 'old poster',
  qr_before_poster: 'clock set back', no_gps: 'no location', gps_inaccurate: 'weak location', far_from_others: 'far from truck',
};

let config, employees = [];

// ---------- tabs ----------
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== `tab-${b.dataset.tab}`));
}));

// ---------- attendance ----------
async function loadReport() {
  const f = new FormData($('#filters'));
  const qs = new URLSearchParams([...f].filter(([, v]) => v));
  $('#csv').href = `/api/admin/report.csv?${qs}`;
  const rep = await api(`/api/admin/report?${qs}`);
  const help = rep.flagHelp;
  const flags = (list) => list.length
    ? list.map((x) => `<span class="flag" title="${esc(help[x])}">${esc(FLAG_LABEL[x] || x)}</span>`).join('')
    : '<span class="ok">✓</span>';

  $('#days tbody').innerHTML = rep.days.map((d) => `<tr>
    <td>${d.date}</td><td>${esc(d.name)}</td><td>${d.firstIn ?? '—'}</td>
    <td>${d.lastOut ?? (d.stillOpen ? '<i>not yet</i>' : '—')}</td>
    <td>${Math.floor(d.workedMinutes / 60)}h ${String(d.workedMinutes % 60).padStart(2, '0')}m</td>
    <td>${d.flagged ? `<span class="flag">${d.flagged} to check</span>` : '<span class="ok">✓</span>'}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">No punches received for these dates yet.</td></tr>';

  $('#punches tbody').innerHTML = rep.punches.map((p) => `<tr>
    <td>${p.date}</td>
    <td>${p.time}${p.estimated ? `<br><span class="muted">real ≈ ${esc(p.estimated)}</span>` : ''}</td>
    <td>${esc(p.name)}</td>
    <td class="${p.type}">${p.type === 'in' ? 'Arrived' : 'Left'}</td>
    <td>${p.lat != null ? `<a target="_blank" rel="noopener" href="https://maps.google.com/?q=${p.lat},${p.lng}">map</a> <span class="muted">±${Math.round(p.accuracy ?? 0)}m</span>` : (p.source === 'manual' ? '' : '—')}</td>
    <td>${p.source === 'manual' ? `<span class="muted">by hand${p.note ? ': ' + esc(p.note) : ''}</span>` : flags(p.flags)}</td>
    <td>${p.source === 'manual' ? `<button data-del="${p.id}">Delete</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="7" class="muted">Nothing yet.</td></tr>';
}
$('#filters').onsubmit = (e) => { e.preventDefault(); loadReport(); };
$('#punches').onclick = async (e) => {
  const id = e.target.dataset?.del;
  if (id && confirm('Delete this hand-entered punch?')) { await api(`/api/admin/punches/${id}`, { method: 'DELETE' }); loadReport(); }
};
$('#manual').onsubmit = async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.employeeId = Number(body.employeeId);
  try { await api('/api/admin/punches', { method: 'POST', body: JSON.stringify(body) }); e.target.reset(); loadReport(); }
  catch (err) { alert(err.message); }
};

// ---------- employees ----------
async function loadEmployees() {
  employees = await api('/api/admin/employees');
  const opts = employees.filter((e) => e.active).map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  const sel = $('#filters [name=employee]'); const cur = sel.value;
  sel.innerHTML = '<option value="">Everyone</option>' + opts; sel.value = cur;
  $('#manual [name=employeeId]').innerHTML = opts;
  $('#emps tbody').innerHTML = employees.map((e) => `<tr>
    <td>${esc(e.name)}</td><td>${esc(e.phone)}</td>
    <td>${e.last_sync ? new Date(e.last_sync).toLocaleString() : '<span class="muted">never</span>'}</td>
    <td>${e.active ? 'active' : '<span class="muted">disabled</span>'}</td>
    <td><button data-act="link" data-id="${e.id}">Setup link / QR</button>
        <button data-act="reset" data-id="${e.id}">New link</button>
        <button data-act="toggle" data-id="${e.id}">${e.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">Add your first employee above.</td></tr>';
}
$('#add-emp').onsubmit = async (e) => {
  e.preventDefault();
  await api('/api/admin/employees', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
  e.target.reset(); loadEmployees();
};
$('#emps').onclick = async (e) => {
  const { act, id } = e.target.dataset; if (!act) return;
  const emp = employees.find((x) => x.id === Number(id));
  if (act === 'link') {
    const link = `${location.origin}/#enroll=${emp.token}`;
    $('#dlg-body').innerHTML = `<h3>${esc(emp.name)}'s setup link</h3>
      <p>Scan with <b>${esc(emp.name)}'s</b> phone camera (needs internet once), or send them the link. Don't share it with anyone else.</p>
      <img src="${qrImg(link)}" alt="QR"><p class="link">${esc(link)}</p>`;
    $('#dlg').showModal();
  } else if (act === 'reset') {
    if (!confirm(`Make a new link for ${emp.name}? Their current phone will stop sending punches until they open the new link.`)) return;
    await api(`/api/admin/employees/${id}`, { method: 'PATCH', body: JSON.stringify({ resetLink: true }) });
    loadEmployees();
  } else if (act === 'toggle') {
    await api(`/api/admin/employees/${id}`, { method: 'PATCH', body: JSON.stringify({ active: !emp.active }) });
    loadEmployees();
  }
};

// ---------- poster ----------
async function loadPoster() {
  const p = await api('/api/admin/poster');
  $('#poster-qr').src = qrImg(p.code);
  $('#poster-code').textContent = p.shortCode;
}
$('#rotate').onclick = async () => {
  if (!confirm('Replace the poster? You must print the new one and put it on the truck right away.')) return;
  await api('/api/admin/poster/rotate', { method: 'POST' });
  loadPoster();
};

// ---------- boot ----------
(async () => {
  config = await api('/api/admin/config');
  $('#tz').textContent = config.tz;
  $('#filters [name=from]').value = config.today;
  $('#filters [name=to]').value = config.today;
  await loadEmployees();
  await Promise.all([loadReport(), loadPoster()]);
})();
