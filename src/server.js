// Plain Node entry point – for running on your own computer or any server.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { openNodeDb } from './db-node.js';

const port = Number(process.env.PORT || 3000);
const tz = process.env.TRUCK_TZ || 'Africa/Cairo';
let adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  adminPassword = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(9))));
  console.warn(`ADMIN_PASSWORD not set – using a temporary one for this run: ${adminPassword}`);
}

const db = openNodeDb(process.env.DB_FILE || 'attendance.db');
const root = path.relative(process.cwd(), fileURLToPath(new URL('../public', import.meta.url))) || '.';
const files = serveStatic({ root });

const app = createApp({ deps: () => ({ db, adminPassword, tz }), adminStatic: files });
app.use('/sw.js', async (c, next) => { await next(); c.header('Cache-Control', 'no-cache'); });
app.use('*', files);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Burger truck attendance running on http://localhost:${port}`);
  console.log(`Owner dashboard: http://localhost:${port}/admin/`);
});
