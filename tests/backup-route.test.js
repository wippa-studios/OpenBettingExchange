// backup-route.test.js — POST /api/admin/backup cannot be told where to write.
//
// Run: node tests/backup-route.test.js   (plain assert, no deps)
//
// #24. The route read `dir` from the request body and lib/ops.js mkdirSync's
// whatever it is handed before VACUUM INTO writes there. Anyone who could
// reach the route therefore had a write primitive over the filesystem, and the
// obvious target was `public/` — which server.js serves unauthenticated via
// express.static. A snapshot dropped there is a complete copy of the players'
// funds database, published to anyone who can fetch a URL.
//
// The suite spawns a REAL server (the route reads OPS_TOKEN and BACKUP_DIR at
// module load, so neither can be set from a test afterwards) and drives it over
// HTTP, because the bug was in the ROUTE's wiring rather than in lib/ops.js —
// lib/ops.js writing wherever it is told is correct and still used by the
// scheduled job with config.BACKUP_DIR.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.DRIFT_ENABLED = 'false';
process.env.BOT_ENABLED = 'false';
process.env.ADMIN_PASSWORD = 'backup-route-admin-pw';

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-backup-'));
const BACKUP_DIR = path.join(TMP, 'snapshots');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OPS_TOKEN = 'backup-route-ops-token';

let passed = 0;
const run = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ok', name);
  } catch (e) {
    console.log('  FAIL', name, '—', (e && e.message) || e);
    process.exitCode = 1;
  }
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

(async () => {
  // The port is resolved BEFORE the spawn: lib/config.js refuses PORT=0, so the
  // child has to be started with a real one.
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_PATH: path.join(TMP, 'backup.db'),
      PORT: String(port),
      OPS_TOKEN,
      BACKUP_DIR,
      BACKUP_RETENTION: '3',
      // No scheduled backup: this suite takes its own, and a timer writing into
      // TMP on its own schedule would make the file-count assertions racy.
      BACKUP_INTERVAL_MS: '0',
      RECONCILE_INTERVAL_MS: '0',
      MAINTENANCE_INTERVAL_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(String(d)));
  server.stderr.on('data', (d) => serverLog.push(String(d)));

  const cleanup = () => {
    server.kill('SIGKILL');
    fs.rmSync(TMP, { recursive: true, force: true });
  };
  process.on('exit', cleanup);

  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/sports`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const signIn = async () => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'backup-route-admin-pw' }),
    });
    const set = (login.headers.getSetCookie() || []).find((c) => c.startsWith('ob_session='));
    assert.ok(set, 'the admin can sign in');
    return set.split(';')[0];
  };

  // ── B1: the destination is not taken from the body ───────────────────────
  await run('B1 a `dir` in the body cannot move the snapshot', async () => {
    const cookie = await signIn();

    // A directory INSIDE public/ — the directory express.static serves with no
    // authentication at all.
    const evil = path.join(PUBLIC_DIR, 'snapshots-should-never-exist');
    assert.ok(
      evil.startsWith(PUBLIC_DIR + path.sep),
      'the requested destination really is under public/'
    );

    const before = fs.readdirSync(PUBLIC_DIR);
    const res = await fetch(`${base}/api/admin/backup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'x-ops-token': OPS_TOKEN,
      },
      body: JSON.stringify({ dir: evil, reason: 'redirect attempt' }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200, `the backup itself still runs (${JSON.stringify(body)})`);

    // The written path is the configured one, never the requested one.
    assert.ok(
      path.resolve(body.path).startsWith(path.resolve(BACKUP_DIR) + path.sep),
      `snapshot landed in BACKUP_DIR, got ${body.path}`
    );
    assert.ok(!path.resolve(body.path).startsWith(path.resolve(PUBLIC_DIR)), 'and not under public/');

    // Nothing was created under public/ at all.
    assert.deepStrictEqual(fs.readdirSync(PUBLIC_DIR), before, 'public/ is untouched');
    assert.ok(!fs.existsSync(evil), 'the requested directory was never created');
  });

  // ── B2: retention is clamped ─────────────────────────────────────────────
  await run('B2 retention in the body is clamped, not obeyed', async () => {
    const cookie = await signIn();
    const take = async (payload) => {
      const r = await fetch(`${base}/api/admin/backup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'x-ops-token': OPS_TOKEN },
        body: JSON.stringify(payload),
      });
      return { status: r.status, json: await r.json() };
    };

    // retention: 0 switched pruning OFF outright — snapshots accumulate until
    // the disk fills. Clamped to 1, so at most one survives.
    for (let i = 0; i < 4; i++) await take({ retention: 0 });
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db'));
    assert.strictEqual(files.length, 1, `retention 0 is clamped to 1, got ${files.length} snapshot(s)`);

    // A negative retention must not reach prune() and keep everything either.
    for (let i = 0; i < 3; i++) await take({ retention: -5 });
    const files2 = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db'));
    assert.strictEqual(files2.length, 1, 'and a negative retention is clamped too');

    // The configured retention still governs when nothing is sent.
    for (let i = 0; i < 5; i++) await take({});
    const files3 = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db'));
    assert.strictEqual(files3.length, 3, `the configured BACKUP_RETENTION of 3 applies, got ${files3.length}`);
  });

  console.log(`\nbackup-route.test.js: ${passed} checks passed`);
  // The house convention: a suite that silently ran FEWER checks than it
  // should have is one whose body stopped executing, not one that passed.
  // Two checks here is not a strong number, so it is pinned.
  if (passed < 2) {
    console.error('expected 2 checks');
    process.exitCode = 1;
  }
  cleanup();
})().catch((e) => {
  console.log('  FAIL suite threw —', (e && e.message) || e);
  process.exitCode = 1;
});