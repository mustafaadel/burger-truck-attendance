// One-time setup + deploy to Cloudflare (free plan).
//   npm run deploy:setup     -> login, create database, set password, deploy
//   npm run deploy           -> later updates
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const NAME = 'burger-truck-attendance';
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
const sh = (args, opts = {}) => {
  console.log(`\n> wrangler ${args.join(' ')}`);
  const r = spawnSync('npx', ['wrangler', ...args], { stdio: opts.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0 && !opts.allowFail) { console.error('\nStopped: the command above failed.'); process.exit(1); }
  return r;
};

// 1. log in (opens the browser)
if (sh(['whoami'], { capture: true }).stdout?.includes('not authenticated')) sh(['login']);

// 2. create the database once, and write its id into wrangler.toml
let toml = readFileSync('wrangler.toml', 'utf8');
if (toml.includes(PLACEHOLDER)) {
  let id;
  const list = sh(['d1', 'list', '--json'], { capture: true, allowFail: true });
  try { id = JSON.parse(list.stdout).find((d) => d.name === NAME)?.uuid; } catch {}
  if (!id) {
    const out = sh(['d1', 'create', NAME], { capture: true }).stdout;
    console.log(out);
    id = /"?database_id"?\s*[=:]\s*"([0-9a-f-]{36})"/.exec(out)?.[1];
  }
  if (!id) { console.error('Could not read the database id. Copy it from above into wrangler.toml (database_id).'); process.exit(1); }
  toml = toml.replace(PLACEHOLDER, id);
  writeFileSync('wrangler.toml', toml);
  console.log(`\nDatabase id ${id} saved in wrangler.toml`);
}

// 3. create the tables
sh(['d1', 'migrations', 'apply', NAME, '--remote']);

// 4. deploy, then set the owner password
sh(['deploy']);
if (process.argv.includes('--setup')) {
  console.log('\nNow choose the OWNER password for the dashboard (typed text is hidden):');
  sh(['secret', 'put', 'ADMIN_PASSWORD']);
}
console.log('\nDone! Open the https://… address printed above, and add /admin/ for the owner dashboard.');
