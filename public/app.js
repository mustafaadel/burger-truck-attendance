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
const fmt = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

async function render() {
  const me = await kvGet('me');
  $('not-enrolled').hidden = !!me;
  $('home').hidden = !me;
  if (!me) return;
  $('who').textContent = me.name || '(name will appear after first sync)';

  const list = (await allPunches()).sort((a, b) => b.seq - a.seq);
  const last = list[0];
  $('state').textContent = last
    ? `Last: ${last.type === 'in' ? 'arrived' : 'left'} at ${fmt(last.deviceTime)}`
    : 'No punches yet.';

  const pending = list.filter((p) => p.status === 'pending').length;
  $('pending').hidden = !pending;
  $('pending').textContent = `${pending} punch${pending > 1 ? 'es' : ''} saved on this phone, waiting for internet to send.`;
  $('btn-sync').hidden = !pending;

  $('history').replaceChildren(...list.slice(0, 15).map((p) => {
    const li = document.createElement('li');
    const status = { pending: '⏳ saved, not sent yet', sent: '✓ sent', rejected: `⚠ rejected (${p.reason})` }[p.status];
    li.innerHTML = `<span class="t"></span><span class="s"></span>`;
    li.firstChild.textContent = `${p.type === 'in' ? '🟢 Arrived' : '🔴 Left'} · ${fmt(p.deviceTime)}`;
    li.lastChild.textContent = status + (p.flags?.length ? ' · needs review' : '');
    return li;
  }));
}

function renderNet() {
  $('net').textContent = navigator.onLine ? 'online' : 'offline – OK';
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
function scanQR() {
  return new Promise(async (resolve) => {
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
      const c = prompt('Type the 6-letter code printed under the QR on the truck poster:');
      if (c && c.trim()) finish(c.trim().toUpperCase());
    };
    sc.hidden = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      video.srcObject = stream;
      await video.play();
    } catch {
      toast('Camera not available – type the code instead.');
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
    toast('Getting location…', 20000);
    const loc = await locP;

    const chain = (await kvGet('chain')) || { seq: 0, lastHash: GENESIS };
    const r = {
      id: crypto.randomUUID(), deviceId: me.deviceId, seq: chain.seq + 1, type, deviceTime,
      qr, lat: loc?.lat ?? null, lng: loc?.lng ?? null, accuracy: loc?.accuracy ?? null,
      prevHash: chain.lastHash,
    };
    r.hash = await sha256(canonical(r));
    await commitPunch({ ...r, status: 'pending' }, { seq: r.seq, lastHash: r.hash });

    toast(`${type === 'in' ? 'Arrival' : 'Leaving'} saved at ${new Date(deviceTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${loc ? '' : ' (no location)'} ✓`);
    await render();
    sync();
  } catch (e) {
    toast('Could not save: ' + e.message, 6000);
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
      toast('Your setup link was reset. Ask your manager for a new one.', 8000);
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
    if (!res.ok) throw new Error(`server said ${res.status}`);
    const out = await res.json();
    const s = await store('punches', 'readwrite');
    for (const p of pending) {
      const rej = out.rejected.find((x) => x.id === p.id);
      if (out.accepted.includes(p.id)) s.put({ ...p, status: 'sent', flags: out.flags[p.id] || [] });
      else if (rej) s.put({ ...p, status: 'rejected', reason: rej.reason });
    }
    await new Promise((r) => (s.transaction.oncomplete = r));
    toast(`Sent ${out.accepted.length} punch${out.accepted.length === 1 ? '' : 'es'} ✓`);
  } catch {
    // no/flaky internet: keep everything, try again later
  } finally {
    syncing = false;
    render();
  }
}

// ---------- enrollment via link: https://host/#enroll=TOKEN ----------
async function enrollFromHash() {
  const m = /enroll=([\w-]+)/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', '/');
  const prev = await kvGet('me');
  const me = { token: m[1], name: null, deviceId: prev?.deviceId || crypto.randomUUID() };
  try {
    const r = await fetch('/api/me', { headers: { authorization: `Bearer ${me.token}` } });
    if (r.status === 401) { toast('This setup link is not valid anymore.', 6000); return; }
    if (r.ok) me.name = (await r.json()).name;
  } catch { /* offline: keep token, name comes later */ }
  await kvSet('me', me);
  try { await navigator.storage?.persist?.(); } catch {}
  toast(`Welcome${me.name ? ', ' + me.name : ''}! Add this page to your home screen.`, 6000);
}

// ---------- boot ----------
(async () => {
  if (!window.isSecureContext) toast('This app must be opened over https:// to work.', 10000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  $('btn-in').onclick = () => punch('in');
  $('btn-out').onclick = () => punch('out');
  $('btn-sync').onclick = () => (navigator.onLine ? sync() : toast('No internet right now. It will send automatically later.'));
  addEventListener('online', () => { renderNet(); sync(); });
  addEventListener('offline', renderNet);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
  setInterval(sync, 60_000);
  renderNet();
  await enrollFromHash();
  await render();
  sync();
})();
