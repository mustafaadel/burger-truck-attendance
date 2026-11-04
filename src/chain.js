import { createHash } from 'node:crypto';

// Must stay byte-for-byte identical to canonical() in public/app.js.
export const GENESIS = 'GENESIS';

export function canonical(r) {
  return [
    r.seq, r.id, r.deviceId, r.type, r.deviceTime,
    r.qr ?? '', r.lat ?? '', r.lng ?? '', r.accuracy ?? '', r.prevHash,
  ].join('|');
}

export function hashRecord(r) {
  return createHash('sha256').update(canonical(r)).digest('hex');
}
