import { addDays, localParts } from './time.js';

const OUTLIER_METERS = 300;

export const FLAG_HELP = {
  hash_mismatch: 'Record content does not match its fingerprint – it was edited after being saved.',
  chain_broken: 'Record does not link to the previous one from this phone – records may have been deleted or edited.',
  missing_previous: 'An earlier record from this phone never arrived (deleted, or app data cleared).',
  clock_went_back: 'Time is earlier than the previous punch from this phone – the phone clock was moved back.',
  phone_clock_wrong: 'When the phone synced its clock was more than 5 minutes off. Shown time may be wrong; see "estimated".',
  future_time: 'Punch time is in the future.',
  new_device: 'First punch from a new phone / reinstalled app for this employee.',
  qr_missing: 'No poster QR code was scanned.',
  qr_invalid: 'The scanned code is not one of your posters.',
  qr_retired: 'Scanned an old poster that had already been replaced (maybe a photo of it).',
  qr_before_poster: 'Punch claims a time before the scanned poster was printed – phone clock was set back.',
  no_gps: 'Location was not available.',
  gps_inaccurate: 'Location was very imprecise (over 200 m).',
  far_from_others: 'Location is far (300 m+) from where everyone else punched that day.',
};

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function buildReport(db, { from, to, tz, employeeId }) {
  // widen the SQL window by a day either side; exact filtering happens on local date
  const lo = Date.parse(addDays(from, -1) + 'T00:00:00Z');
  const hi = Date.parse(addDays(to, 2) + 'T00:00:00Z');
  const rows = db.prepare(`
    SELECT p.*, e.name FROM punches p JOIN employees e ON e.id = p.employee_id
    WHERE p.device_time BETWEEN ? AND ? ${employeeId ? 'AND p.employee_id = ?' : ''}
    ORDER BY p.device_time`).all(...(employeeId ? [lo, hi, employeeId] : [lo, hi]));

  const punches = [];
  for (const r of rows) {
    const { date, time } = localParts(r.device_time, tz);
    if (date < from || date > to) continue;
    const flags = JSON.parse(r.flags);
    const est = flags.includes('phone_clock_wrong') && r.clock_skew_ms != null
      ? localParts(r.device_time - r.clock_skew_ms, tz) : null;
    punches.push({
      id: r.id, employeeId: r.employee_id, name: r.name, type: r.type, source: r.source,
      deviceTime: r.device_time, date, time,
      estimated: est ? `${est.date} ${est.time}` : null,
      receivedAt: r.received_at, lat: r.lat, lng: r.lng, accuracy: r.accuracy,
      qrStatus: r.qr_status, note: r.note, flags,
    });
  }

  // Location outliers: compare each punch to the median location of that day.
  const byDate = Map.groupBy(punches, (p) => p.date);
  for (const list of byDate.values()) {
    const good = list.filter((p) => p.lat != null && (p.accuracy ?? 0) <= 200 && p.source === 'app');
    if (good.length < 3) continue;
    const center = { lat: median(good.map((p) => p.lat)), lng: median(good.map((p) => p.lng)) };
    for (const p of good) if (haversine(center, p) > OUTLIER_METERS) p.flags.push('far_from_others');
  }

  // Daily summary per employee: pair IN -> OUT.
  const days = [];
  const groups = Map.groupBy(punches, (p) => `${p.date}|${p.employeeId}`);
  for (const list of groups.values()) {
    let open = null, worked = 0;
    for (const p of list) {
      if (p.type === 'in') { if (open == null) open = p.deviceTime; }
      else if (open != null) { worked += p.deviceTime - open; open = null; }
    }
    const ins = list.filter((p) => p.type === 'in');
    const outs = list.filter((p) => p.type === 'out');
    days.push({
      date: list[0].date, employeeId: list[0].employeeId, name: list[0].name,
      firstIn: ins[0]?.time ?? null, lastOut: outs.at(-1)?.time ?? null,
      workedMinutes: Math.round(worked / 60000), stillOpen: open != null,
      flagged: list.filter((p) => p.flags.length).length,
    });
  }
  days.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return { from, to, tz, punches, days, flagHelp: FLAG_HELP };
}

export function toCsv(report) {
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [['date', 'time', 'employee', 'type', 'estimated_real_time', 'lat', 'lng', 'accuracy_m', 'source', 'flags', 'note']];
  for (const p of report.punches) {
    lines.push([p.date, p.time, p.name, p.type, p.estimated, p.lat, p.lng, p.accuracy, p.source, p.flags.join(' '), p.note]);
  }
  lines.push([]);
  lines.push(['date', 'employee', 'first_in', 'last_out', 'worked_hours', 'still_open', 'flagged_punches']);
  for (const d of report.days) {
    lines.push([d.date, d.name, d.firstIn, d.lastOut, (d.workedMinutes / 60).toFixed(2), d.stillOpen, d.flagged]);
  }
  return lines.map((l) => l.map(esc).join(',')).join('\n') + '\n';
}
