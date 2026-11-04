// Employee clock-in app. Everything is saved on the phone first (IndexedDB),
// then uploaded whenever there is internet.

const GENESIS = 'GENESIS';
const $ = (id) => document.getElementById(id);

// ---------- tiny IndexedDB wrapper ----------
let dbp;
function idb() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('clockin', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('kv');
      r.result.createObjectStore('punches', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const store = async (name, mode = 'readonly') => (await idb()).transaction(name, mode).objectStore(name);
const kvGet = async (k) => wrap((await store('kv')).get(k));
const kvSet = async (k, v) => wrap((await store('kv', 'readwrite')).put(v, k));
const allPunches = async () => wrap((await store('punches')).getAll());

async function commitPunch(record, chain) {
  // punch + chain head in ONE transaction so they can never disagree
  const tx = (await idb()).transaction(['kv', 'punches'], 'readwrite');
  tx.objectStore('punches').put(record);
  tx.objectStore('kv').put(chain, 'chain');
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}

// ---------- tamper-evident chain (must match src/chain.js) ----------
function canonical(r) {
  return [r.seq, r.id, r.deviceId, r.type, r.deviceTime,
    r.qr ?? '', r.lat ?? '', r.lng ?? '', r.accuracy ?? '', r.prevHash].join('|');
}
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- UI helpers ----------
function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), ms);
}
const LOCALE = 'ar-EG';
const fmt = (ms) => new Date(ms).toLocaleString(LOCALE, { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

async function render() {
  const me = await kvGet('me');
  $('not-enrolled').hidden = !!me;
  $('home').hidden = !me;
  if (!me) return;
  $('who').textContent = me.name || '(سيظهر الاسم بعد أول إرسال)';

  const list = (await allPunches()).sort((a, b) => b.seq - a.seq);
  const last = list[0];
  $('state').textContent = last
    ? `آخر تسجيل: ${last.type === 'in' ? 'وصول' : 'انصراف'} – ${fmt(last.deviceTime)}`
    : 'لا توجد تسجيلات بعد.';

  const pending = list.filter((p) => p.status === 'pending').length;
  $('pending').hidden = !pending;
  $('pending').textContent = `${pending === 1 ? 'تسجيل واحد محفوظ' : `${pending} تسجيلات محفوظة`} على هذا الهاتف، في انتظار الإنترنت للإرسال.`;
  $('btn-sync').hidden = !pending;

  $('history').replaceChildren(...list.slice(0, 15).map((p) => {
    const li = document.createElement('li');
    const status = { pending: '⏳ محفوظ، لم يُرسل بعد', sent: '✓ تم الإرسال', rejected: `⚠ مرفوض (${p.reason})` }[p.status];
    li.innerHTML = `<span class="t"></span><span class="s"></span>`;
    li.firstChild.textContent = `${p.type === 'in' ? '🟢 وصول' : '🔴 انصراف'} · ${fmt(p.deviceTime)}`;
    li.lastChild.textContent = status + (p.flags?.length ? ' · يحتاج مراجعة' : '');
    return li;
  }));
}

function renderNet() {
  $('net').textContent = navigator.onLine ? 'متصل' : 'بدون إنترنت – عادي';
}

// ---------- location ----------
function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}

// ---------- QR scanner ----------
const POSTER_SCAN = {
  message: 'وجّه الكاميرا إلى ملصق QR على العربة',
  manualLabel: 'اكتب الكود بدلاً من ذلك',
  manualPrompt: 'اكتب الكود المكوّن من 6 حروف المطبوع تحت الـ QR على ملصق العربة:',
  upper: true,
};
const SETUP_SCAN = {
  message: 'وجّه الكاميرا إلى كود الإعداد الذي أعطاه لك المدير',
  manualLabel: 'لصق الرابط بدلاً من ذلك',
  manualPrompt: 'الصق رابط الإعداد هنا:',
  upper: false,
};

function scanQR(opts = POSTER_SCAN) {
  return new Promise(async (resolve) => {
    $('scan-msg').textContent = opts.message;
    $('btn-manual').textContent = opts.manualLabel;
    const sc = $('scanner'), video = $('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stream, done = false;
    const finish = (val) => {
      if (done) return; done = true;
      stream?.getTracks().forEach((t) => t.stop());
      sc.hidden = true; resolve(val);
    };
    $('btn-cancel').onclick = () => finish(undefined);
    $('btn-manual').onclick = () => {
      const c = prompt(opts.manualPrompt);
      if (c && c.trim()) finish(opts.upper ? c.trim().toUpperCase() : c.trim());
    };
    sc.hidden = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      video.srcObject = stream;
      await video.play();
    } catch {
      toast(`الكاميرا غير متاحة – ${opts.manualLabel}.`);
      return;
    }
    const tick = () => {
      if (done) return;
      if (video.readyState >= 2 && window.jsQR) {
        const w = (canvas.width = Math.min(video.videoWidth, 640));
        const h = (canvas.height = Math.round(video.videoHeight * (w / video.videoWidth)));
        ctx.drawImage(video, 0, 0, w, h);
        const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        if (code?.data) return finish(code.data);
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

// ---------- punching ----------
let busy = false;
async function punch(type) {
  if (busy) return;
  const me = await kvGet('me');
  if (!me) return;
  busy = true;
  $('btn-in').disabled = $('btn-out').disabled = true;
  try {
    const locP = getLocation();         // start GPS while the camera is open
    const qr = await scanQR();
    if (qr === undefined) return;      // cancelled
    const deviceTime = Date.now();     // the moment they scanned the poster
    toast('جارٍ تحديد الموقع…', 20000);
    const loc = await locP;

    const chain = (await kvGet('chain')) || { seq: 0, lastHash: GENESIS };
    const r = {
      id: crypto.randomUUID(), deviceId: me.deviceId, seq: chain.seq + 1, type, deviceTime,
      qr, lat: loc?.lat ?? null, lng: loc?.lng ?? null, accuracy: loc?.accuracy ?? null,
      prevHash: chain.lastHash,
    };
    r.hash = await sha256(canonical(r));
    await commitPunch({ ...r, status: 'pending' }, { seq: r.seq, lastHash: r.hash });

    toast(`تم حفظ ${type === 'in' ? 'الوصول' : 'الانصراف'} الساعة ${new Date(deviceTime).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}${loc ? '' : ' (بدون موقع)'} ✓`);
    await render();
    sync();
  } catch (e) {
    toast('تعذّر الحفظ: ' + e.message, 6000);
  } finally {
    busy = false;
    $('btn-in').disabled = $('btn-out').disabled = false;
  }
}

// ---------- upload ----------
let syncing = false;
async function sync() {
  if (syncing || !navigator.onLine) return;
  const me = await kvGet('me');
  if (!me) return;
  syncing = true;
  try {
    // refresh name, and make sure the link is still valid
    const meRes = await fetch('/api/me', { headers: { authorization: `Bearer ${me.token}` } });
    if (meRes.ok) {
      const { name } = await meRes.json();
      if (name !== me.name) await kvSet('me', { ...me, name });
    } else if (meRes.status === 401) {
      toast('تم تغيير رابط الإعداد الخاص بك. اطلب رابطاً جديداً من المدير.', 8000);
      return;
    }

    const pending = (await allPunches()).filter((p) => p.status === 'pending').sort((a, b) => a.seq - b.seq);
    if (!pending.length) return;
    const records = pending.map(({ status, reason, flags, ...r }) => r);
    const res = await fetch('/api/punches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
      body: JSON.stringify({ deviceNow: Date.now(), records }),
    });
    if (!res.ok) throw new Error(`خطأ من الخادم ${res.status}`);
    const out = await res.json();
    const s = await store('punches', 'readwrite');
    for (const p of pending) {
      const rej = out.rejected.find((x) => x.id === p.id);
      if (out.accepted.includes(p.id)) s.put({ ...p, status: 'sent', flags: out.flags[p.id] || [] });
      else if (rej) s.put({ ...p, status: 'rejected', reason: rej.reason });
    }
    await new Promise((r) => (s.transaction.oncomplete = r));
    toast(`تم إرسال ${out.accepted.length} ${out.accepted.length === 1 ? 'تسجيل' : 'تسجيلات'} ✓`);
  } catch {
    // no/flaky internet: keep everything, try again later
  } finally {
    syncing = false;
    render();
  }
}

// ---------- enrollment: link https://host/#enroll=TOKEN, or scanning that link's QR inside the app ----------
// Each browser (and on iPhone, the home-screen app) has its own storage, so each one is set up separately.
const enrollToken = (text) => /enroll=([\w-]+)/.exec(text || '')?.[1];

async function enroll(token) {
  const prev = await kvGet('me');
  const me = { token, name: null, deviceId: prev?.deviceId || crypto.randomUUID() };
  try {
    const r = await fetch('/api/me', { headers: { authorization: `Bearer ${me.token}` } });
    if (r.status === 401) { toast('رابط الإعداد هذا لم يعد صالحاً. اطلب كوداً جديداً من المدير.', 6000); return; }
    if (r.ok) me.name = (await r.json()).name;
  } catch { /* offline: keep token, name comes later */ }
  await kvSet('me', me);
  try { await navigator.storage?.persist?.(); } catch {}
  toast(`أهلاً بك${me.name ? ' يا ' + me.name : ''}! أضف هذه الصفحة إلى الشاشة الرئيسية.`, 6000);
}

async function enrollFromHash() {
  const token = enrollToken(location.hash);
  if (!token) return;
  history.replaceState(null, '', '/');
  await enroll(token);
}

async function enrollByScan() {
  const text = await scanQR(SETUP_SCAN);
  if (text === undefined) return;
  const token = enrollToken(text);
  if (!token) { toast('هذا ليس كود إعداد. اطلب كود الإعداد الخاص بك من المدير.', 6000); return; }
  await enroll(token);
  await render();
  sync();
}

// ---------- boot ----------
(async () => {
  if (!window.isSecureContext) toast('يجب فتح التطبيق عبر https:// ليعمل.', 10000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  $('btn-enroll').onclick = enrollByScan;
  $('btn-in').onclick = () => punch('in');
  $('btn-out').onclick = () => punch('out');
  $('btn-sync').onclick = () => (navigator.onLine ? sync() : toast('لا يوجد إنترنت الآن. سيتم الإرسال تلقائياً لاحقاً.'));
  addEventListener('online', () => { renderNet(); sync(); });
  addEventListener('offline', renderNet);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
  setInterval(sync, 60_000);
  renderNet();
  await enrollFromHash();
  await render();
  sync();
})();
