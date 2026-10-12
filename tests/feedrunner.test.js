// tests/feedrunner.test.js — the feed collector supervisor.
//
// Run: node tests/feedrunner.test.js
//
// The tests that matter here are the ones that try to make the supervisor leak.
// A supervisor that holds decrypted Betfair credentials and passes them to a
// child process has two obvious ways to leak them — into its own health
// response, and into captured child output — and both are checked directly
// rather than inferred.

'use strict';
process.env.SCRYPT_N = process.env.SCRYPT_N || '16384';

const crypto = require('crypto');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A real encryption key and a real command, so the supervisor is exercised for
// what it will do in production rather than against a stub.
process.env.FEED_CREDENTIALS_KEY = crypto.randomBytes(32).toString('hex');
process.env.FEED_ENABLED = 'true';
process.env.FEED_RUNNER_ENABLED = 'true';
process.env.FEED_DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/feed';
// A test double for `betfeed collect`: a shell script. It deliberately PRINTS
// the credentials it is given, which is the single most useful thing for
// proving that redaction is real rather than aspirational.
const FAKE = path.join(os.tmpdir(), `fake-collector-${process.pid}.sh`);
fs.writeFileSync(
  FAKE,
  `#!/bin/bash
echo "collector starting with key=$BETFAIR_APP_KEY user=$BETFAIR_USERNAME"
echo "warning: auth failed for $BETFAIR_USERNAME using $BETFAIR_PASSWORD" >&2
echo "wrote 9456 books to $DATABASE_URL"
while true; do sleep 0.2; done
`,
  { mode: 0o755 }
);
process.env.FEED_COLLECTOR_CMD = `${FAKE}`;

const { openStore } = require('../lib/store');
const auth = require('../lib/auth');
const tenants = require('../lib/tenants');
const config = require('../lib/config');
const FC = require('../lib/feedcreds');
const FRUN = require('../lib/feedrunner');

// Node cannot decide the module format when `require` and top-level `await`
// both appear, so the body lives in an async main rather than at the top level.
async function main() {
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

const GOOD = { appKey: 'eldno0TOrTIbJozT', username: 'JSIrwin', password: 'Skullman2540' };

const db = openStore(':memory:');
FRUN.setDb(db);
const tenant = tenants.defaultTenant(db);
const admin = auth.registerUser(db, { username: 'admin', password: 'pw-admin-1234', balance_cents: 0 });
db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);

/** Poll until `fn()` is truthy, so tests never assert on a race. */
async function until(fn, what, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

// ── readiness ────────────────────────────────────────────────────────────────

await check('R1 readiness names the SPECIFIC missing condition, never just false', () => {
  const cases = [
    [{ FEED_ENABLED: false, FEED_RUNNER_ENABLED: true, FEED_DATABASE_URL: 'postgresql://a:b@h/x', FEED_CREDENTIALS_KEY: 'k' }, /FEED_ENABLED/],
    [{ FEED_ENABLED: true, FEED_RUNNER_ENABLED: false, FEED_DATABASE_URL: 'postgresql://a:b@h/x', FEED_CREDENTIALS_KEY: 'k' }, /FEED_RUNNER_ENABLED/],
    [{ FEED_ENABLED: true, FEED_RUNNER_ENABLED: true, FEED_DATABASE_URL: '', FEED_CREDENTIALS_KEY: 'k' }, /FEED_DATABASE_URL/],
    [{ FEED_ENABLED: true, FEED_RUNNER_ENABLED: true, FEED_DATABASE_URL: 'postgresql://a:b@h/x', FEED_CREDENTIALS_KEY: null }, /FEED_CREDENTIALS_KEY/],
  ];
  for (const [over, pattern] of cases) {
    const saved = { ...config };
    Object.assign(config, over);
    try {
      const r = FRUN.readiness();
      assert.strictEqual(r.ready, false, `${JSON.stringify(over)} should not be ready`);
      assert.match(r.reason, pattern, `reason for ${JSON.stringify(over)} should match ${pattern}`);
      assert.ok(r.reason.length > 20, 'and be an explanation, not a code');
    } finally {
      for (const k of Object.keys(saved)) config[k] = saved[k];
    }
  }
  // Everything present: ready.
  Object.assign(config, {
    FEED_ENABLED: true,
    FEED_RUNNER_ENABLED: true,
    FEED_DATABASE_URL: 'postgresql://a:b@h/x',
    FEED_CREDENTIALS_KEY: Buffer.alloc(32),
  });
  assert.strictEqual(FRUN.readiness().ready, true);
  config.FEED_CREDENTIALS_KEY = Buffer.from(process.env.FEED_CREDENTIALS_KEY, 'hex');
});

await check('R2 with no stored credential, start() refuses and explains — it does not launch a doomed child', () => {
  const r = FRUN.start(tenant.id);
  assert.strictEqual(r.started, false);
  assert.match(r.reason, /no Betfair credentials stored/);
  assert.strictEqual(FRUN.health(tenant.id).running, false, 'and nothing was spawned');
});

// ── redaction ────────────────────────────────────────────────────────────────

await check('R3 redact removes every known secret and leaves ordinary text intact', () => {
  const secrets = [GOOD.appKey, GOOD.username, GOOD.password];
  const line = `auth failed for ${GOOD.username} using ${GOOD.password} (key ${GOOD.appKey})`;
  const out = FRUN.redact(line, secrets);
  for (const s of secrets) assert.ok(!out.includes(s), `leaked ${s}`);
  assert.strictEqual(out.split('[redacted]').length - 1, 3, 'all three replaced');
  // Prices, market ids and ids must survive untouched — a redaction scheme
  // that garbles output gets switched off by the operator who needs it.
  const benign = 'wrote 9456 books to postgresql://u:p@db/x for market 1.234567890';
  assert.strictEqual(FRUN.redact(benign, secrets), benign);
  // A secret too short to match safely must not be used as a substring rule:
  // replacing "a" everywhere would destroy the log.
  assert.strictEqual(FRUN.redact('abc', ['a']), 'abc');
});

// ── backoff ──────────────────────────────────────────────────────────────────

await check('R4 backoff grows and is capped, so a bad credential cannot hammer Betfair', () => {
  const state = { consecutiveFailures: 0 };
  const at = (n) => {
    state.consecutiveFailures = n;
    return FRUN.backoffMs(state);
  };
  const first = at(0);
  assert.ok(at(1) > first, 'grows after the first failure');
  assert.ok(at(5) > at(1), 'keeps growing');
  assert.strictEqual(at(99), 300_000, 'and is capped');
  // The whole point: a wrong password must not produce a request per second.
  assert.ok(first >= 5_000, `first retry no sooner than 5s (got ${first}ms)`);
});

// ── the real thing: spawn, redact, stop ──────────────────────────────────────

await check('R5 a supervised collector starts, runs, and reports a live pid', async () => {
  FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
  const r = FRUN.start(tenant.id);
  assert.strictEqual(r.started, true, r.reason);
  assert.ok(r.pid > 0, 'has a pid');
  await until(() => FRUN.health(tenant.id).running, 'the child to be running');
  const h = FRUN.health(tenant.id);
  assert.strictEqual(h.supervisor, 'running');
  assert.ok(h.pid, 'health reports the pid');
  assert.ok(h.started_at, 'and when it started');
  // Starting twice must not spawn a second collector writing the same rows.
  const again = FRUN.start(tenant.id);
  assert.strictEqual(again.already_running, true, 'a second start is a no-op');
});

await check('R6 child output that ECHOES THE PASSWORD is redacted before storage', async () => {
  // The test double prints the real credentials to stdout and stderr on every
  // start. If redaction is not applied on the write path, this is where it
  // shows — in health(), which an operator reads and copies into a ticket.
  await until(
    () => FRUN.health(tenant.id).recent_log.some((l) => /wrote \d+ books/.test(l.line)),
    'the child output to arrive'
  );
  const h = FRUN.health(tenant.id);
  const log = JSON.stringify(h.recent_log);

  assert.ok(!log.includes(GOOD.password), 'the PASSWORD is not in the captured log');
  assert.ok(!log.includes(GOOD.appKey), 'the APP KEY is not in the captured log');
  assert.ok(!log.includes(GOOD.username), 'the USERNAME is not in the captured log');
  assert.ok(log.includes('[redacted]'), 'and it was replaced, not dropped');
  // Prove the real output actually arrived — a test that passes because the
  // output never came would pass just as happily.
  assert.ok(log.includes('wrote 9456 books'), 'the child really did produce output');
  assert.ok(log.includes('started'), 'the start line is recorded');
});

await check('R7 health() returns no credential at all — not via status, not via env', () => {
  const h = FRUN.health(tenant.id);
  const serialised = JSON.stringify(h);
  for (const s of [GOOD.appKey, GOOD.username, GOOD.password]) {
    assert.ok(!serialised.includes(s), `health() leaked ${s}`);
  }
  // The nested credential status is the same shape the API returns: booleans.
  assert.strictEqual(h.configured.password_set, true);
  assert.ok(!('password' in h.configured), 'no raw password field in the nested status');
  assert.ok(!('BETFAIR_PASSWORD' in h), 'and no environment echoed back');
  assert.ok(!('env' in h) && !('command' in h), 'no env or argv blob');
});

await check('R8 stop() ends the child and does NOT restart it', async () => {
  const r = FRUN.stop(tenant.id);
  assert.strictEqual(r.stopped, true);
  await until(() => !FRUN.health(tenant.id).running, 'the child to exit');
  // Give the supervisor ample opportunity to misbehave: a restart timer would
  // have fired by now if one were pending.
  await new Promise((res) => setTimeout(res, 1200));
  const h = FRUN.health(tenant.id);
  assert.strictEqual(h.running, false, 'still stopped after waiting');
  assert.strictEqual(h.supervisor, 'stopped');
  assert.ok(h.last_exit, 'the exit was recorded');
  assert.strictEqual(h.last_exit.by_request, true, 'and attributed to the operator, not a crash');
  assert.strictEqual(h.last_exit.signal, 'SIGTERM', 'terminated by signal, as asked');
  // A dead pid makes process.kill THROW ESRCH — the throw is the proof.
  let alive = true;
  try {
    process.kill(r.pid, 0);
  } catch (e) {
    alive = false;
    assert.strictEqual(e.code, 'ESRCH', `expected ESRCH, got ${e.code}`);
  }
  assert.strictEqual(alive, false, 'the process is really gone, not merely unreported');
});

// ── crash and restart ────────────────────────────────────────────────────────

await check('R9 a collector that dies is restarted, and the crash is recorded', async () => {
  // A collector that exits immediately is the normal failure mode for a wrong
  // password. The supervisor must notice and retry — otherwise the feed is
  // silently dead from the venue's point of view, which is the worst outcome.
  const crashy = path.join(os.tmpdir(), `crashy-collector-${process.pid}.sh`);
  fs.writeFileSync(crashy, '#!/bin/bash\necho "auth failed"\nexit 3\n', { mode: 0o755 });
  const savedCmd = config.FEED_COLLECTOR_CMD;
  config.FEED_COLLECTOR_CMD = crashy;
  try {
    FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
    FRUN.start(tenant.id);
    // Supervisor state persists between checks, so R8's SIGTERM exit is still
    // sitting in last_exit. Wait for a CRASH specifically — by_request false —
    // rather than for any exit at all, which returned R8's record immediately.
    await until(
      () => {
        const e = FRUN.health(tenant.id).last_exit;
        return e && e.by_request === false ? e : null;
      },
      'a crash (not an operator stop) to be recorded'
    );
    const h = FRUN.health(tenant.id);
    assert.strictEqual(h.last_exit.code, 3, 'the exit code is recorded');
    assert.strictEqual(h.last_exit.by_request, false, 'and it is not attributed to the operator');
    assert.strictEqual(h.consecutive_failures, 1, 'failure count incremented');
    assert.ok(
      /retrying in/.test(JSON.stringify(h.recent_log)),
      'and the operator is told a retry is scheduled'
    );
    FRUN.stop(tenant.id);
    if (FRUN.health(tenant.id).running) FRUN.stop(tenant.id);
  } finally {
    FRUN.stopAll();
    config.FEED_COLLECTOR_CMD = savedCmd;
    fs.rmSync(crashy, { force: true });
  }
});

// ── teardown ─────────────────────────────────────────────────────────────────

FRUN.stopAll();
db.close();
fs.rmSync(FAKE, { force: true });

console.log(`\nfeedrunner.test.js: ${passed} checks passed`);
if (failures.length) {
  console.error(`failed: ${failures.join(', ')}`);
  process.exitCode = 1;
}
}

main().catch((e) => {
  console.error('feedrunner.test.js threw:', e);
  process.exit(1);
});