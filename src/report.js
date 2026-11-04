import { addDays, localParts } from './time.js';

const OUTLIER_METERS = 300;

export const FLAG_HELP = {
  hash_mismatch: 'محتوى التسجيل لا يطابق بصمته – تم تعديله بعد الحفظ.',
  chain_broken: 'التسجيل لا يرتبط بالتسجيل السابق من نفس الهاتف – ربما تم حذف أو تعديل تسجيلات.',
  missing_previous: 'تسجيل سابق من هذا الهاتف لم يصل أبداً (محذوف، أو تم مسح بيانات التطبيق).',
  clock_went_back: 'الوقت أقدم من التسجيل السابق من نفس الهاتف – تم إرجاع ساعة الهاتف.',
  phone_clock_wrong: 'عند الإرسال كانت ساعة الهاتف مختلفة بأكثر من 5 دقائق. الوقت المعروض قد يكون خطأ؛ انظر "الحقيقي".',
  future_time: 'وقت التسجيل في المستقبل.',
  new_device: 'أول تسجيل من هاتف جديد / تطبيق أعيد تثبيته لهذا الموظف.',
  qr_missing: 'لم يتم مسح كود الملصق.',
  qr_invalid: 'الكود الممسوح ليس من ملصقاتك.',
  qr_retired: 'تم مسح ملصق قديم تم استبداله (ربما صورة له).',
  qr_before_poster: 'وقت التسجيل قبل طباعة الملصق الممسوح – تم إرجاع ساعة الهاتف.',
  no_gps: 'الموقع لم يكن متاحاً.',
  gps_inaccurate: 'الموقع غير دقيق جداً (أكثر من 200 م).',
  far_from_others: 'الموقع بعيد (أكثر من 300 م) عن مكان تسجيل باقي الموظفين في نفس اليوم.',
};

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export async function buildReport(db, { from, to, tz, employeeId }) {
  // widen the SQL window by a day either side; exact filtering happens on local date
  const lo = Date.parse(addDays(from, -1) + 'T00:00:00Z');
  const hi = Date.parse(addDays(to, 2) + 'T00:00:00Z');
  const rows = await db.all(`
    SELECT p.*, e.name FROM punches p JOIN employees e ON e.id = p.employee_id
    WHERE p.device_time BETWEEN ? AND ? ${employeeId ? 'AND p.employee_id = ?' : ''}
    ORDER BY p.device_time`, ...(employeeId ? [lo, hi, employeeId] : [lo, hi]));

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
  const typeAr = { in: 'وصول', out: 'انصراف' };
  const lines = [['التاريخ', 'الوقت', 'الموظف', 'النوع', 'الوقت الحقيقي المقدر', 'خط العرض', 'خط الطول', 'الدقة (م)', 'المصدر', 'ملاحظات المراجعة', 'ملاحظة']];
  for (const p of report.punches) {
    lines.push([p.date, p.time, p.name, typeAr[p.type], p.estimated, p.lat, p.lng, p.accuracy, p.source === 'manual' ? 'يدوي' : 'التطبيق', p.flags.map((f) => FLAG_HELP[f] || f).join(' | '), p.note]);
  }
  lines.push([]);
  lines.push(['التاريخ', 'الموظف', 'أول وصول', 'آخر انصراف', 'ساعات العمل', 'لم ينصرف', 'تسجيلات للمراجعة']);
  for (const d of report.days) {
    lines.push([d.date, d.name, d.firstIn, d.lastOut, (d.workedMinutes / 60).toFixed(2), d.stillOpen ? 'نعم' : 'لا', d.flagged]);
  }
  // BOM so Excel opens Arabic text correctly
  return '\uFEFF' + lines.map((l) => l.map(esc).join(',')).join('\n') + '\n';
}
