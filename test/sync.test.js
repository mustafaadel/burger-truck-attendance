import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { openNodeDb } from '../src/db-node.js';
import { GENESIS, canonical } from '../src/chain.js';
import { ingest } from '../src/sync.js';
import { buildReport } from '../src/report.js';
import { zonedToEpoch } from '../src/time.js';

const TZ = 'Africa/Cairo';

const hashRecord = (r) => createHash('sha256').update(canonical(r)).digest('hex');
const count = (db) => db.raw.prepare('SELECT COUNT(*) n FROM punches').get().n;

function setup() {
  const db = openNodeDb(':memory:');
  db.raw.prepare("INSERT INTO employees (name, token, created_at) VALUES ('Ali', 'tok-ali', 0), ('Mona', 'tok-mona', 0), ('Omar', 'tok-omar', 0)").run();
  db.raw.prepare("INSERT INTO posters (code, short_code, created_at) VALUES ('BTA1.poster', 'ABC234', ?)").run(Date.parse('2026-01-01'));
  const emp = (id) => db.raw.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  return { db, emp };
}

/** simulates the phone app building its chain */
function phone(deviceId = randomUUID()) {
  let seq = 0, last = GENESIS;
  return (type, deviceTime, extra = {}) => {
    const r = { id: randomUUID(), deviceId, seq: ++seq, type, deviceTime, qr: 'BTA1.poster', lat: 30.0444, lng: 31.2357, accuracy: 12, prevHash: last, ...extra };
    r.hash = hashRecord(r);
    last = r.hash;
    return r;
  };
}

const at = (s) => zonedToEpoch(s, TZ);

test('clean offline punches synced later are accepted without flags', async () => {
  const { db, emp } = setup();
  const p = phone();
  const recs = [p('in', at('2026-11-04T09:00')), p('out', at('2026-11-04T17:30'))];
  const now = at('2026-11-05T08:00'); // synced the next morning
  const out = await ingest(db, emp(1), { deviceNow: now, records: recs }, now);
  assert.deepEqual(out.accepted, recs.map((r) => r.id));
  assert.deepEqual(out.flags, {});

  const rep = await buildReport(db, { from: '2026-11-04', to: '2026-11-04', tz: TZ });
  assert.equal(rep.days.length, 1);
  assert.equal(rep.days[0].firstIn, '09:00');
  assert.equal(rep.days[0].lastOut, '17:30');
  assert.equal(rep.days[0].workedMinutes, 510);
});

test('re-uploading the same records is idempotent', async () => {
  const { db, emp } = setup();
  const p = phone();
  const recs = [p('in', at('2026-11-04T09:00'))];
  const now = at('2026-11-04T09:05');
  await ingest(db, emp(1), { deviceNow: now, records: recs }, now);
  const again = await ingest(db, emp(1), { deviceNow: now, records: recs }, now);
  assert.deepEqual(again.accepted, [recs[0].id]);
  assert.equal(count(db), 1);
});

test('edited time is detected by the hash', async () => {
  const { db, emp } = setup();
  const p = phone();
  const r = p('in', at('2026-11-04T10:15'));
  r.deviceTime = at('2026-11-04T08:55'); // employee "fixes" their late arrival
  const now = at('2026-11-04T18:00');
  const out = await ingest(db, emp(1), { deviceNow: now, records: [r] }, now);
  assert.ok(out.flags[r.id].includes('hash_mismatch'));
});

test('deleting a record from the phone is detected as a gap', async () => {
  const { db, emp } = setup();
  const p = phone();
  const a = p('in', at('2026-11-04T09:00'));
  p('out', at('2026-11-04T11:00')); // deleted, never uploaded
  const c = p('in', at('2026-11-04T13:00'));
  const now = at('2026-11-04T18:00');
  const out = await ingest(db, emp(1), { deviceNow: now, records: [a, c] }, now);
  assert.ok(out.flags[c.id].includes('missing_previous'));
});

test('phone clock set back is flagged and the real time estimated', async () => {
  const { db, emp } = setup();
  const p = phone();
  const skew = -75 * 60_000; // phone 75 minutes behind
  const realArrival = at('2026-11-04T10:15');
  const r = p('in', realArrival + skew);
  const now = at('2026-11-04T12:00');
  const out = await ingest(db, emp(1), { deviceNow: now + skew, records: [r] }, now);
  assert.ok(out.flags[r.id].includes('phone_clock_wrong'));
  const rep = await buildReport(db, { from: '2026-11-04', to: '2026-11-04', tz: TZ });
  assert.equal(rep.punches[0].time, '09:00');
  assert.equal(rep.punches[0].estimated, '2026-11-04 10:15');
});

test('clock moved backwards between punches is flagged', async () => {
  const { db, emp } = setup();
  const p = phone();
  const a = p('in', at('2026-11-04T10:00'));
  const b = p('out', at('2026-11-04T09:00'));
  const now = at('2026-11-04T09:30');
  const out = await ingest(db, emp(1), { deviceNow: now, records: [a, b] }, now);
  assert.ok(out.flags[b.id].includes('clock_went_back'));
});

test('wrong, missing, typed and retired poster codes', async () => {
  const { db, emp } = setup();
  const p = phone();
  const now = at('2026-11-04T18:00');
  const typed = p('in', at('2026-11-04T09:00'), { qr: 'abc234' });
  const wrong = p('out', at('2026-11-04T10:00'), { qr: 'https://example.com' });
  const none = p('in', at('2026-11-04T11:00'), { qr: null });
  const out = await ingest(db, emp(1), { deviceNow: now, records: [typed, wrong, none] }, now);
  assert.equal(out.flags[typed.id], undefined);
  assert.ok(out.flags[wrong.id].includes('qr_invalid'));
  assert.ok(out.flags[none.id].includes('qr_missing'));

  db.raw.prepare('UPDATE posters SET retired_at = ?').run(at('2026-11-04T12:00'));
  const old = p('out', at('2026-11-04T17:00'));
  const out2 = await ingest(db, emp(1), { deviceNow: now, records: [old] }, now);
  assert.ok(out2.flags[old.id].includes('qr_retired'));
});

test('punch dated before the poster existed is flagged', async () => {
  const { db, emp } = setup();
  const r = phone()('in', Date.parse('2025-06-01'));
  const now = at('2026-11-04T18:00');
  const out = await ingest(db, emp(1), { deviceNow: now, records: [r] }, now);
  assert.ok(out.flags[r.id].includes('qr_before_poster'));
});

test('a punch far from where everyone else was is flagged', async () => {
  const { db, emp } = setup();
  const now = at('2026-11-04T18:00');
  await ingest(db, emp(1), { deviceNow: now, records: [phone()('in', at('2026-11-04T09:00'))] }, now);
  await ingest(db, emp(2), { deviceNow: now, records: [phone()('in', at('2026-11-04T09:05'), { lat: 30.0446 })] }, now);
  const home = phone()('in', at('2026-11-04T09:10'), { lat: 30.10, lng: 31.30 }); // ~9 km away
  await ingest(db, emp(3), { deviceNow: now, records: [home] }, now);
  const rep = await buildReport(db, { from: '2026-11-04', to: '2026-11-04', tz: TZ });
  const flagged = rep.punches.filter((x) => x.flags.includes('far_from_others')).map((x) => x.name);
  assert.deepEqual(flagged, ['Omar']);
});

test('another employee cannot overwrite someone else\'s record id', async () => {
  const { db, emp } = setup();
  const r = phone()('in', at('2026-11-04T09:00'));
  const now = at('2026-11-04T09:01');
  await ingest(db, emp(1), { deviceNow: now, records: [r] }, now);
  const out = await ingest(db, emp(2), { deviceNow: now, records: [r] }, now);
  assert.deepEqual(out.rejected, [{ id: r.id, reason: 'id_conflict' }]);
});

test('malformed records are rejected, not stored', async () => {
  const { db, emp } = setup();
  const out = await ingest(db, emp(1), { records: [{ id: 'x', type: 'lunch' }] });
  assert.equal(out.rejected[0].reason, 'malformed');
  assert.equal(count(db), 0);
});

test('a whole offline backlog in one upload links up correctly', async () => {
  const { db, emp } = setup();
  const p = phone();
  const recs = [];
  for (let d = 1; d <= 5; d++) {
    recs.push(p('in', at(`2026-11-0${d}T09:00`)), p('out', at(`2026-11-0${d}T17:00`)));
  }
  const now = at('2026-11-06T08:00');
  const out = await ingest(db, emp(1), { deviceNow: now, records: recs.reverse() }, now); // order shouldn't matter
  assert.equal(out.accepted.length, 10);
  assert.deepEqual(out.flags, {});
  const rep = await buildReport(db, { from: '2026-11-01', to: '2026-11-05', tz: TZ });
  assert.equal(rep.days.length, 5);
  assert.ok(rep.days.every((d) => d.workedMinutes === 480));
});
