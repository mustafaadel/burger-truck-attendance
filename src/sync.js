import { GENESIS, hashRecord } from './chain.js';

const MIN = 60_000;
const CLOCK_TOLERANCE = 5 * MIN;
const POSTER_GRACE = 60 * MIN;
const BAD_ACCURACY_M = 200;

export function matchPoster(qr, posters, deviceTime) {
  if (!qr) return 'missing';
  const q = String(qr).trim();
  const p = posters.find((x) => x.code === q || x.short_code === q.toUpperCase());
  if (!p) return 'invalid';
  // Claims a time before this poster was even printed -> phone clock was set back.
  if (deviceTime < p.created_at - POSTER_GRACE) return 'before_poster';
  if (p.retired_at && deviceTime > p.retired_at + POSTER_GRACE) return 'retired';
  return 'ok';
}

function validShape(r) {
  return r && typeof r === 'object'
    && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 64
    && typeof r.deviceId === 'string' && r.deviceId.length > 0 && r.deviceId.length <= 64
    && Number.isInteger(r.seq) && r.seq >= 1
    && (r.type === 'in' || r.type === 'out')
    && Number.isFinite(r.deviceTime)
    && (r.qr == null || (typeof r.qr === 'string' && r.qr.length <= 200))
    && (r.lat == null || Number.isFinite(r.lat))
    && (r.lng == null || Number.isFinite(r.lng))
    && (r.accuracy == null || Number.isFinite(r.accuracy))
    && typeof r.prevHash === 'string' && r.prevHash.length <= 128
    && typeof r.hash === 'string' && r.hash.length <= 128;
}

/**
 * Store punches uploaded by an employee's phone.
 * Nothing is ever silently dropped: suspicious records are stored with flags
 * so the owner can judge them.
 */
export function ingest(db, employee, body, now = Date.now()) {
  const records = Array.isArray(body?.records) ? body.records : null;
  if (!records) throw Object.assign(new Error('records must be an array'), { status: 400 });
  if (records.length > 500) throw Object.assign(new Error('too many records'), { status: 400 });

  const skew = Number.isFinite(body.deviceNow) ? body.deviceNow - now : null; // + means phone is ahead
  const posters = db.prepare('SELECT * FROM posters').all();
  const q = {
    byId: db.prepare('SELECT employee_id FROM punches WHERE id = ?'),
    bySeq: db.prepare('SELECT id, hash, device_time FROM punches WHERE employee_id = ? AND device_id = ? AND seq = ?'),
    otherDevice: db.prepare("SELECT 1 FROM punches WHERE employee_id = ? AND device_id <> ? AND source = 'app' LIMIT 1"),
    insert: db.prepare(`INSERT INTO punches
      (id, employee_id, device_id, seq, type, device_time, received_at, clock_skew_ms,
       lat, lng, accuracy, qr, qr_status, prev_hash, hash, flags, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'app')`),
  };

  const accepted = [];
  const rejected = [];
  const flagsById = {};
  const sorted = [...records].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0));

  db.exec('BEGIN');
  try {
    for (const r of sorted) {
      if (!validShape(r)) { rejected.push({ id: r?.id ?? null, reason: 'malformed' }); continue; }

      const existing = q.byId.get(r.id);
      if (existing) {
        if (existing.employee_id === employee.id) accepted.push(r.id); // re-upload, idempotent
        else rejected.push({ id: r.id, reason: 'id_conflict' });
        continue;
      }
      if (q.bySeq.get(employee.id, r.deviceId, r.seq)) {
        rejected.push({ id: r.id, reason: 'duplicate_seq' });
        continue;
      }

      const flags = [];
      if (hashRecord(r) !== r.hash) flags.push('hash_mismatch');

      if (r.seq === 1) {
        if (r.prevHash !== GENESIS) flags.push('chain_broken');
        if (q.otherDevice.get(employee.id, r.deviceId)) flags.push('new_device');
      } else {
        const prev = q.bySeq.get(employee.id, r.deviceId, r.seq - 1);
        if (!prev) flags.push('missing_previous');
        else {
          if (prev.hash !== r.prevHash) flags.push('chain_broken');
          if (r.deviceTime < prev.device_time) flags.push('clock_went_back');
        }
      }

      if (skew != null && Math.abs(skew) > CLOCK_TOLERANCE) flags.push('phone_clock_wrong');
      if (r.deviceTime > now + CLOCK_TOLERANCE) flags.push('future_time');

      const qrStatus = matchPoster(r.qr, posters, r.deviceTime);
      if (qrStatus !== 'ok') flags.push(`qr_${qrStatus}`);

      if (r.lat == null || r.lng == null) flags.push('no_gps');
      else if (r.accuracy != null && r.accuracy > BAD_ACCURACY_M) flags.push('gps_inaccurate');

      q.insert.run(
        r.id, employee.id, r.deviceId, r.seq, r.type, Math.round(r.deviceTime), now, skew,
        r.lat ?? null, r.lng ?? null, r.accuracy ?? null, r.qr ?? null, qrStatus,
        r.prevHash, r.hash, JSON.stringify(flags),
      );
      accepted.push(r.id);
      if (flags.length) flagsById[r.id] = flags;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { accepted, rejected, flags: flagsById, serverNow: now };
}
