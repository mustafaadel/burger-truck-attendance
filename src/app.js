// HTTP routes. Runs unchanged on Cloudflare Workers (src/worker.js) and Node (src/server.js).
import { Hono } from 'hono';
import qrcode from 'qrcode-generator';
import { ingest } from './sync.js';
import { buildReport, toCsv } from './report.js';
import { localParts, zonedToEpoch } from './time.js';
import { assetLinks } from './assetlinks.js';

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const token = () => btoa(String.fromCharCode(...randomBytes(24))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid misreading
const shortCode = () => Array.from(randomBytes(6), (b) => B32[b % B32.length]).join('');
const digest = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
const err = (c, status, error) => c.json({ error }, status);

/**
 * @param deps (c) => ({ db, adminPassword, tz })  – resolved per request (Workers pass env per request)
 * @param adminStatic Hono handler that serves files from public/admin
 */
export function createApp({ deps, adminStatic }) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const d = deps(c);
    c.set('db', d.db);
    c.set('tz', d.tz || 'Africa/Cairo');
    c.set('adminPassword', d.adminPassword);
    await next();
  });

  async function currentPoster(db) {
    const q = 'SELECT * FROM posters WHERE retired_at IS NULL ORDER BY id DESC LIMIT 1';
    let p = await db.get(q);
    if (!p) {
      await db.run('INSERT INTO posters (code, short_code, created_at) VALUES (?,?,?)', `BTA1.${token()}`, shortCode(), Date.now());
      p = await db.get(q);
    }
    return p;
  }

  app.get('/.well-known/assetlinks.json', (c) => c.json(assetLinks));

  // ---------- employee API (bearer token from the enrollment link) ----------
  async function employeeAuth(c, next) {
    const m = /^Bearer (.+)$/.exec(c.req.header('authorization') || '');
    const emp = m && await c.get('db').get('SELECT * FROM employees WHERE token = ?', m[1]);
    if (!emp) return err(c, 401, 'رابط غير معروف أو تم تغييره – اطلب رابطاً جديداً من المدير');
    if (!emp.active) return err(c, 403, 'الحساب موقوف');
    c.set('employee', emp);
    await next();
  }

  app.get('/api/me', employeeAuth, (c) => c.json({ name: c.get('employee').name, tz: c.get('tz') }));

  app.post('/api/punches', employeeAuth, async (c) => {
    const body = await c.req.json().catch(() => null);
    try { return c.json(await ingest(c.get('db'), c.get('employee'), body)); }
    catch (e) { return err(c, e.status || 500, e.message); }
  });

  // ---------- admin (HTTP basic auth) ----------
  async function adminAuth(c, next) {
    const want = c.get('adminPassword');
    if (!want) return c.text('ADMIN_PASSWORD is not set on the server', 503);
    const m = /^Basic (.+)$/.exec(c.req.header('authorization') || '');
    let pass = '';
    try { pass = m ? new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0))).split(':').slice(1).join(':') : ''; } catch {}
    if (m && await safeEqual(pass, want)) return next();
    c.header('WWW-Authenticate', 'Basic realm="Burger truck admin", charset="UTF-8"');
    return c.text('يجب تسجيل الدخول', 401);
  }
  app.use('/admin', adminAuth);
  app.use('/admin/*', adminAuth);
  app.use('/api/admin/*', adminAuth);
  app.get('/admin', (c) => c.redirect('/admin/'));

  const today = (c) => localParts(Date.now(), c.get('tz')).date;

  app.get('/api/admin/config', (c) => c.json({ tz: c.get('tz'), today: today(c) }));

  app.get('/api/admin/employees', async (c) => c.json(await c.get('db').all(`
    SELECT e.id, e.name, e.phone, e.active, e.token, e.created_at,
      (SELECT MAX(received_at) FROM punches p WHERE p.employee_id = e.id) AS last_sync
    FROM employees e ORDER BY e.active DESC, e.name`)));

  app.post('/api/admin/employees', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const name = String(b.name || '').trim();
    if (!name) return err(c, 400, 'الاسم مطلوب');
    const r = await c.get('db').run('INSERT INTO employees (name, phone, token, created_at) VALUES (?,?,?,?)',
      name, String(b.phone || '').trim() || null, token(), Date.now());
    return c.json({ id: r.lastId });
  });

  app.patch('/api/admin/employees/:id', async (c) => {
    const db = c.get('db');
    const b = await c.req.json().catch(() => ({}));
    const e = await db.get('SELECT * FROM employees WHERE id = ?', Number(c.req.param('id')));
    if (!e) return err(c, 404, 'not found');
    if (b.resetLink) await db.run('UPDATE employees SET token = ? WHERE id = ?', token(), e.id);
    if (typeof b.active === 'boolean') await db.run('UPDATE employees SET active = ? WHERE id = ?', b.active ? 1 : 0, e.id);
    if (typeof b.name === 'string' && b.name.trim()) await db.run('UPDATE employees SET name = ? WHERE id = ?', b.name.trim(), e.id);
    return c.json({ ok: true });
  });

  app.get('/api/admin/poster', async (c) => {
    const p = await currentPoster(c.get('db'));
    return c.json({ code: p.code, shortCode: p.short_code, createdAt: p.created_at });
  });

  app.post('/api/admin/poster/rotate', async (c) => {
    await c.get('db').run('UPDATE posters SET retired_at = ? WHERE retired_at IS NULL', Date.now());
    const p = await currentPoster(c.get('db'));
    return c.json({ code: p.code, shortCode: p.short_code });
  });

  app.get('/api/admin/qr.svg', (c) => {
    const data = c.req.query('data') || '';
    if (!data || data.length > 500) return c.body(null, 400);
    const qr = qrcode(0, 'M');
    qr.addData(data);
    qr.make();
    return c.body(qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true }), 200, { 'content-type': 'image/svg+xml' });
  });

  function reportParams(c) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const q = c.req.query();
    const from = re.test(q.from) ? q.from : today(c);
    const to = re.test(q.to) ? q.to : from;
    return { from, to, tz: c.get('tz'), employeeId: q.employee ? Number(q.employee) : null };
  }
  app.get('/api/admin/report', async (c) => c.json(await buildReport(c.get('db'), reportParams(c))));
  app.get('/api/admin/report.csv', async (c) => {
    const p = reportParams(c);
    return c.body(toCsv(await buildReport(c.get('db'), p)), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="attendance_${p.from}_${p.to}.csv"`,
    });
  });

  // Manual punch: corrections, or someone who signed the paper backup sheet.
  app.post('/api/admin/punches', async (c) => {
    const db = c.get('db');
    const { employeeId, type, localTime, note } = await c.req.json().catch(() => ({}));
    const emp = await db.get('SELECT id FROM employees WHERE id = ?', Number(employeeId));
    if (!emp || !['in', 'out'].includes(type)) return err(c, 400, 'الموظف والنوع مطلوبان');
    let t;
    try { t = zonedToEpoch(String(localTime), c.get('tz')); } catch (e) { return err(c, 400, e.message); }
    const id = crypto.randomUUID();
    await db.run(`INSERT INTO punches (id, employee_id, device_id, seq, type, device_time, received_at,
      qr_status, prev_hash, hash, flags, source, note) VALUES (?,?,?,0,?,?,?, 'manual', '', '', '[]', 'manual', ?)`,
      id, emp.id, `manual:${id}`, type, t, Date.now(), String(note || '').slice(0, 500) || null);
    return c.json({ id });
  });

  app.delete('/api/admin/punches/:id', async (c) => {
    // Only manual entries can be deleted; phone punches are evidence and stay.
    const r = await c.get('db').run("DELETE FROM punches WHERE id = ? AND source = 'manual'", c.req.param('id'));
    return c.json({ ok: !!r.changes }, r.changes ? 200 : 404);
  });

  app.get('/admin/*', adminStatic);
  return app;
}
