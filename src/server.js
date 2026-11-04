import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const tz = process.env.TRUCK_TZ || 'Africa/Cairo';
let adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  adminPassword = randomBytes(9).toString('base64url');
  console.warn(`ADMIN_PASSWORD not set – using a temporary one for this run: ${adminPassword}`);
}

const db = openDb(process.env.DB_FILE || 'attendance.db');
createApp(db, { adminPassword, tz }).listen(port, () => {
  console.log(`Burger truck attendance running on http://localhost:${port}`);
  console.log(`Owner dashboard: http://localhost:${port}/admin/  (user: anything, password: ADMIN_PASSWORD)`);
});
