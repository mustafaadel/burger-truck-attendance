import express from 'express';
import QRCode from 'qrcode';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ingest } from './sync.js';
import { buildReport, toCsv } from './report.js';
import { localParts, zonedToEpoch } from './time.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, '..', 'public');
const require = createRequire(import.meta.url);
const jsQRPath = require.resolve('jsqr/dist/jsQR.js');

const token = () => randomBytes(24).toString('base64url');
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid misreading
const shortCode = () => Array.from(randomBytes(6), (b) => B32[b % B32.length]).join('');
const sha = (s) => createHash('sha256').update(s).digest();

export function createApp(db, { adminPassword, tz = 'Africa/Cairo' }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const today = () => localParts(Date.now(), tz).date;

  function currentPoster() {
    let p = db.prepare('SELECT * FROM posters WHERE retired_at IS NULL ORDER BY id DESC LIMIT 1').get();
    if (!p) {
      db.prepare('INSERT INTO posters (code, short_code, created_at) VALUES (?,?,?)')
        .run(`BTA1.${token()}`, shortCode(), Date.now());
      p = db.prepare('SELECT * FROM posters WHERE retired_at IS NULL ORDER BY id DESC LIMIT 1').get();
    }
    return p;
  }

  // ---------- employee API (bearer token from the enrollment link) ----------
  function employeeAuth(req, res, next) {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    const emp = m && db.prepare('SELECT * FROM employees WHERE token = ?').get(m[1]);
    if (!emp) return res.status(401).json({ error: 'unknown or reset link – ask your manager for a new one' });
    if (!emp.active) return res.status(403).json({ error: 'account disabled' });
    req.employee = emp;
    next();
  }

  app.get('/api/me', employeeAuth, (req, res) => res.json({ name: req.employee.name, tz }));

  app.post('/api/punches', employeeAuth, (req, res) => {
    try { res.json(ingest(db, req.employee, req.body)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ---------- admin (HTTP basic auth) ----------
  const want = sha(adminPassword);
  function adminAuth(req, res, next) {
    const m = /^Basic (.+)$/.exec(req.get('authorization') || '');
    const pass = m ? Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':') : '';
    if (m && timingSafeEqual(sha(pass), want)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Burger truck admin"').status(401).send('Login required');
  }
  app.use(['/admin', '/api/admin'], adminAuth);
  app.use('/admin', express.static(path.join(publicDir, 'admin')));

  app.get('/api/admin/config', (req, res) => res.json({ tz, today: today() }));

  app.get('/api/admin/employees', (req, res) => {
    res.json(db.prepare(`SELECT e.id, e.name, e.phone, e.active, e.token, e.created_at,
      (SELECT MAX(received_at) FROM punches p WHERE p.employee_id = e.id) AS last_sync
      FROM employees e ORDER BY e.active DESC, e.name`).all());
  });

  app.post('/api/admin/employees', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = db.prepare('INSERT INTO employees (name, phone, token, created_at) VALUES (?,?,?,?)')
      .run(name, String(req.body?.phone || '').trim() || null, token(), Date.now());
    res.json({ id: Number(r.lastInsertRowid) });
  });

  app.patch('/api/admin/employees/:id', (req, res) => {
    const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    if (req.body?.resetLink) db.prepare('UPDATE employees SET token = ? WHERE id = ?').run(token(), e.id);
    if (typeof req.body?.active === 'boolean') db.prepare('UPDATE employees SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, e.id);
    if (typeof req.body?.name === 'string' && req.body.name.trim()) db.prepare('UPDATE employees SET name = ? WHERE id = ?').run(req.body.name.trim(), e.id);
    res.json({ ok: true });
  });

  app.get('/api/admin/poster', (req, res) => {
    const p = currentPoster();
    res.json({ code: p.code, shortCode: p.short_code, createdAt: p.created_at });
  });

  app.post('/api/admin/poster/rotate', (req, res) => {
    db.prepare('UPDATE posters SET retired_at = ? WHERE retired_at IS NULL').run(Date.now());
    const p = currentPoster();
    res.json({ code: p.code, shortCode: p.short_code });
  });

  app.get('/api/admin/qr.svg', async (req, res) => {
    const data = String(req.query.data || '');
    if (!data || data.length > 500) return res.status(400).end();
    res.type('image/svg+xml').send(await QRCode.toString(data, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
  });

  function reportParams(req) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const from = re.test(req.query.from) ? req.query.from : today();
    const to = re.test(req.query.to) ? req.query.to : from;
    const employeeId = req.query.employee ? Number(req.query.employee) : null;
    return { from, to, tz, employeeId };
  }
  app.get('/api/admin/report', (req, res) => res.json(buildReport(db, reportParams(req))));
  app.get('/api/admin/report.csv', (req, res) => {
    const p = reportParams(req);
    res.type('text/csv').attachment(`attendance_${p.from}_${p.to}.csv`).send(toCsv(buildReport(db, p)));
  });

  // Manual punch: corrections, or someone who signed the paper backup sheet.
  app.post('/api/admin/punches', (req, res) => {
    const { employeeId, type, localTime, note } = req.body || {};
    const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(employeeId);
    if (!emp || !['in', 'out'].includes(type)) return res.status(400).json({ error: 'employee and type required' });
    let t;
    try { t = zonedToEpoch(String(localTime), tz); } catch (e) { return res.status(400).json({ error: e.message }); }
    const id = randomUUID();
    db.prepare(`INSERT INTO punches (id, employee_id, device_id, seq, type, device_time, received_at,
      qr_status, prev_hash, hash, flags, source, note) VALUES (?,?,?,0,?,?,?, 'manual', '', '', '[]', 'manual', ?)`)
      .run(id, emp.id, `manual:${id}`, type, t, Date.now(), String(note || '').slice(0, 500) || null);
    res.json({ id });
  });

  app.delete('/api/admin/punches/:id', (req, res) => {
    // Only manual entries can be deleted; phone punches are evidence and stay.
    const r = db.prepare("DELETE FROM punches WHERE id = ? AND source = 'manual'").run(req.params.id);
    res.status(r.changes ? 200 : 404).json({ ok: !!r.changes });
  });

  // ---------- employee PWA ----------
  app.get('/vendor/jsQR.js', (req, res) => res.sendFile(jsQRPath));
  app.get('/sw.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(publicDir, 'sw.js')); });
  app.use(express.static(publicDir, { index: 'index.html' }));

  return app;
}
