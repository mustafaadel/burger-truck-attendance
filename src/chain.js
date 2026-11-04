// Must stay byte-for-byte identical to canonical() in public/app.js.
export const GENESIS = 'GENESIS';

export function canonical(r) {
  return [
    r.seq, r.id, r.deviceId, r.type, r.deviceTime,
    r.qr ?? '', r.lat ?? '', r.lng ?? '', r.accuracy ?? '', r.prevHash,
  ].join('|');
}

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const hashRecord = (r) => sha256Hex(canonical(r));
