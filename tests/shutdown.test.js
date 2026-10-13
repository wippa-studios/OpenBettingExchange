// tests/shutdown.test.js — SIGTERM must stop the feed collector.
//
// Run: node tests/shutdown.test.js
//
// WHY THIS FILE EXISTS, AND WHY IT SPAWNS A REAL PROCESS.
//
// `stopAll()` was implemented, correct, and had ZERO CALLERS. The server
// registered only unhandledRejection and uncaughtException, so a SIGTERM took
// the default action and terminated the process immediately: `server.close()`
// never ran, so neither did the `server.on('close')` handlers, and never did
// `stopAll()`. The collector is a child with no parent-death signal, so every
// deploy, crash and Ctrl-C left the previous `betfeed collect` running — still
// holding a Betfair session, still spending market-data weight, now competing
// with the new collector for the same account — while the new process reported
// `supervisor: 'idle'`.
//
// The function was unit-tested and the WIRING was not. That is the whole gap:
// a unit test proves stopAll works, which says nothing about whether anything
// calls it. So this test boots the real server as a real child process, starts
// a real supervised collector through the real admin API, sends a real SIGTERM,
// and asserts the collector is really dead afterwards. A test that could not
// have failed before the fix would be no use at all.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAMP = process.pid;

// A scratch directory unique to this run, removed at the end. Nothing is written
// inside the repo.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `obe-shutdown-${STAMP}-`));
const DB = path.join(TMP, 'venue.db');
const PIDFILE = path.join(TMP, 'collector.pid');

// The collector double. It records its OWN pid — not the pid the supervisor
// reports, which is the thing under test — and then does what a real collector
// does: nothing, forever, holding a Betfair session we cannot see.
const FAKE = path.join(TMP, 'fake-collector.sh');
fs.writeFileSync(
  FAKE,
  `#!/bin/bash
echo $$ > ${PIDFILE}
echo "collector up"
trap "" TERM
while true; do sleep 0.2; done
`,
  { mode: 0o755 }
);

/** An unused loopback port. Never 7777 — a live instance runs there. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/** Is this pid still a live process? */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok', name);
  } catch (e) {
    failures.push(name);
    console.error('  FAIL', name);
    console.error('       ', e.message);
    process.exitCode = 1;
  }
}

async function main() {
  const port = await freePort();

  console.log('  … booting a real server (isolated DB, loopback, unused port)');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_PATH: DB,
      PORT: String(port),
      HOST: '127.0.0.1',
      SCRYPT_N: '16384',
      // The feed must be ENABLED or the runner refuses to start, and readiness()
      // names that as the reason — which is a correct refusal, not a bug.
      FEED_ENABLED: 'true',
      FEED_RUNNER_ENABLED: 'true',
      FEED_DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:59999/offline',
      FEED_CREDENTIALS_KEY: crypto.randomBytes(32).toString('hex'),
      FEED_COLLECTOR_CMD: FAKE,
      // The poll loop would add noise and latency to a boot that only needs the
      // credential and supervisor surfaces.
      RESULTS_FEED_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (b) => { serverLog += b.toString(); });
  child.stderr.on('data', (b) => { serverLog += b.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const j = async (method, p, { body, cookie } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + p, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json, setCookie };
  };
  const cookieOf = (r) => (r.setCookie.find((c) => c.startsWith('ob_session=')) || '').split(';')[0];

  let collectorPid = null;
  const cleanup = () => {
    try { process.kill(collectorPid, 'SIGKILL'); } catch { /* already gone */ }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(TMP, { recursive: true, force: true });
  };

  try {
    await until(async () => {
      const r = await fetch(base + '/api/branding').catch(() => null);
      return r && r.ok;
    }, 'the server to accept requests');

    // Sign in as the seeded admin and store a credential for our own tenant.
    // The first-run lock makes a seeded admin change its password before any
    // other route is reachable, so do that first — it is part of how a fresh
    // deployment is actually operated, and skipping it would test a state no
    // operator ever sees.
    const login = await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    assert.strictEqual(login.status, 200, `admin login failed: ${JSON.stringify(login.json)}`);
    let cookie = cookieOf(login);
    assert.ok(cookie, 'and returned a session');

    const changed = await j('POST', '/api/auth/change-password', {
      cookie,
      body: { currentPassword: 'admin123', newPassword: 'shutdown-test-pw-1' },
    });
    assert.strictEqual(changed.status, 200, `the first-run password change failed: ${JSON.stringify(changed.json)}`);
    const relogin = await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'shutdown-test-pw-1' } });
    assert.strictEqual(relogin.status, 200, `re-login failed: ${JSON.stringify(relogin.json)}`);
    cookie = cookieOf(relogin);

    const put = await j('PUT', '/api/admin/feed/credentials', {
      cookie,
      body: { app_key: 'TESTKEYnotreal12', username: 'test.bettfair-demo', password: 'not-a-real-password' },
    });
    assert.strictEqual(put.status, 200, `storing credentials failed: ${JSON.stringify(put.json)}`);
    assert.strictEqual(put.json.configured, true, 'and they were stored');

    const started = await j('POST', '/api/admin/feed/runner/start', { cookie, body: {} });
    assert.strictEqual(started.status, 200, `starting the collector failed: ${JSON.stringify(started.json)}`);

    // Wait for the DOUBLE to record its own pid: that is the process we must
    // prove is dead, not the one the supervisor says it started.
    await until(() => fs.existsSync(PIDFILE), 'the collector process to start');
    collectorPid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
    assert.ok(collectorPid > 1, `the collector recorded a real pid (got ${collectorPid})`);

    const health = await j('GET', '/api/admin/feed/runner', { cookie });
    assert.strictEqual(health.json.running, true, 'the supervisor agrees it is running');
    assert.strictEqual(health.json.pid, collectorPid, 'and agrees on which pid');

    // ── the test ────────────────────────────────────────────────────────────
    await check('S1 SIGTERM exits the server AND leaves no collector behind', async () => {
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      child.kill('SIGTERM');
      const r = await Promise.race([exited, sleep(15000).then(() => null)]);
      assert.ok(r, `the server did not exit within 15s. Log:\n${serverLog}`);

      // THE POINT, and asserted FIRST so it is the assertion that fires when
      // the wiring is missing. The collector is a separate process with no
      // parent-death signal: nothing about the parent exiting implies anything
      // about it. Before this fix the server died on the default SIGTERM
      // action and left the collector running — still holding a Betfair
      // session, still spending market-data weight, now competing with the new
      // collector for the same account.
      await until(() => !isAlive(collectorPid), 'the orphaned collector to disappear');
      assert.strictEqual(isAlive(collectorPid), false, 'no `betfeed collect` survived the restart');

      // And it DRAINED rather than being killed, so the shutdown PATH ran.
      assert.match(serverLog, /\[shutdown\] SIGTERM/, 'the shutdown path ran');
      assert.match(serverLog, /collector stopped/, 'and reported stopping the collector');
      assert.strictEqual(r.signal, null, `it exited on its own rather than being signalled (${r.signal})`);
      assert.strictEqual(r.code, 0, 'and exited cleanly');
    });

    // Reap the zombie if the assertion above threw before the process died.
    if (isAlive(collectorPid)) {
      console.error('  ! reaping the collector this test failed to kill');
    }
    collectorPid = null;
  } finally {
    cleanup();
  }

  console.log(`\nshutdown.test.js: ${passed} checks passed`);
  if (failures.length) {
    console.error(`failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('shutdown.test.js threw:', e);
  process.exit(1);
});
