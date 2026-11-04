const $ = (s, el = document) => el.querySelector(s);
const api = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { 'content-type': 'application/json', ...opts.headers } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const qrImg = (data) => `/api/admin/qr.svg?data=${encodeURIComponent(data)}`;
const FLAG_LABEL = {
  hash_mismatch: 'تم تعديله', chain_broken: 'تسجيلات محذوفة/معدلة', missing_previous: 'تسجيل سابق مفقود',
  clock_went_back: 'الساعة رجعت للخلف', phone_clock_wrong: 'ساعة الهاتف خطأ', future_time: 'وقت في المستقبل',
  new_device: 'هاتف جديد', qr_missing: 'بدون QR', qr_invalid: 'QR خطأ', qr_retired: 'ملصق قديم',
  qr_before_poster: 'الساعة مُرجعة', no_gps: 'بدون موقع', gps_inaccurate: 'موقع غير دقيق', far_from_others: 'بعيد عن العربة',
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
    <td>${d.lastOut ?? (d.stillOpen ? '<i>لم ينصرف بعد</i>' : '—')}</td>
    <td>${Math.floor(d.workedMinutes / 60)} س ${String(d.workedMinutes % 60).padStart(2, '0')} د</td>
    <td>${d.flagged ? `<span class="flag">${d.flagged} للمراجعة</span>` : '<span class="ok">✓</span>'}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">لم تصل تسجيلات لهذه التواريخ بعد.</td></tr>';

  $('#punches tbody').innerHTML = rep.punches.map((p) => `<tr>
    <td>${p.date}</td>
    <td>${p.time}${p.estimated ? `<br><span class="muted">الحقيقي ≈ ${esc(p.estimated)}</span>` : ''}</td>
    <td>${esc(p.name)}</td>
    <td class="${p.type}">${p.type === 'in' ? 'وصول' : 'انصراف'}</td>
    <td>${p.lat != null ? `<a target="_blank" rel="noopener" href="https://maps.google.com/?q=${p.lat},${p.lng}">خريطة</a> <span class="muted">±${Math.round(p.accuracy ?? 0)} م</span>` : (p.source === 'manual' ? '' : '—')}</td>
    <td>${p.source === 'manual' ? `<span class="muted">يدوي${p.note ? ': ' + esc(p.note) : ''}</span>` : flags(p.flags)}</td>
    <td>${p.source === 'manual' ? `<button data-del="${p.id}">حذف</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="7" class="muted">لا يوجد شيء بعد.</td></tr>';
}
$('#filters').onsubmit = (e) => { e.preventDefault(); loadReport(); };
$('#punches').onclick = async (e) => {
  const id = e.target.dataset?.del;
  if (id && confirm('حذف هذا التسجيل اليدوي؟')) { await api(`/api/admin/punches/${id}`, { method: 'DELETE' }); loadReport(); }
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
  sel.innerHTML = '<option value="">الكل</option>' + opts; sel.value = cur;
  $('#manual [name=employeeId]').innerHTML = opts;
  $('#emps tbody').innerHTML = employees.map((e) => `<tr>
    <td>${esc(e.name)}</td><td>${esc(e.phone)}</td>
    <td>${e.last_sync ? new Date(e.last_sync).toLocaleString('ar-EG') : '<span class="muted">أبداً</span>'}</td>
    <td>${e.active ? 'نشط' : '<span class="muted">موقوف</span>'}</td>
    <td><button data-act="link" data-id="${e.id}">رابط الإعداد / QR</button>
        <button data-act="reset" data-id="${e.id}">رابط جديد</button>
        <button data-act="toggle" data-id="${e.id}">${e.active ? 'إيقاف' : 'تفعيل'}</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">أضف أول موظف من الأعلى.</td></tr>';
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
    $('#dlg-body').innerHTML = `<h3>رابط إعداد ${esc(emp.name)}</h3>
      <p>يفتح <b>${esc(emp.name)}</b> التطبيق على هاتفه ويضغط «امسح كود الإعداد» ثم يمسح هذا الكود (يحتاج إنترنت مرة واحدة)، أو أرسل له الرابط. على الآيفون: بعد إضافة التطبيق إلى الشاشة الرئيسية يمسح الكود مرة أخرى من داخله. لا تشاركه مع أي شخص آخر.</p>
      <img src="${qrImg(link)}" alt="QR"><p class="link">${esc(link)}</p>`;
    $('#dlg').showModal();
  } else if (act === 'reset') {
    if (!confirm(`إنشاء رابط جديد لـ ${emp.name}؟ سيتوقف هاتفه الحالي عن إرسال التسجيلات حتى يفتح الرابط الجديد.`)) return;
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
  if (!confirm('استبدال الملصق؟ يجب طباعة الملصق الجديد ولصقه على العربة فوراً.')) return;
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
