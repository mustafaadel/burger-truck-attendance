// Cloudflare Workers entry point. Static files in public/ are served by Workers Assets;
// /api/* and /admin/* run through this Worker first (see wrangler.toml).
import { createApp } from './app.js';
import { d1Db } from './db-d1.js';

export default createApp({
  deps: (c) => ({ db: d1Db(c.env.DB), adminPassword: c.env.ADMIN_PASSWORD, tz: c.env.TRUCK_TZ }),
  adminStatic: (c) => c.env.ASSETS.fetch(c.req.raw),
});
