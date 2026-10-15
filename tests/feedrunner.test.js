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

const GOOD = { appKey: 'TESTKEYnotreal12', username: 'test.bettfair-demo', password: 'not-a-real-password' };

const db = openStore(':memory:');
FRUN.setDb(db);
const tenant = tenants.defaultTenant(db);
const admin = (await auth.registerUser(db, { username: 'admin', password: 'pw-admin-1234', balance_cents: 0 }));
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

await check('R1 readiness names the SPECIFIC missing condition, never just false', async () => {
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

await check('R2 with no stored credential, start() refuses and explains — it does not launch a doomed child', async () => {
  const r = FRUN.start(tenant.id);
  assert.strictEqual(r.started, false);
  assert.match(r.reason, /no Betfair credentials stored/);
  assert.strictEqual(FRUN.health(tenant.id).running, false, 'and nothing was spawned');
});

// ── redaction ────────────────────────────────────────────────────────────────

await check('R3 redact removes every known secret and leaves ordinary text intact', async () => {
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

// The floor this replaces skipped every secret under four characters, and
// USERNAME_RE accepts three. So a three-character username reached the log ring
// verbatim. These checks are the reason that cannot come back.
await check('R3a a SHORT secret is redacted where it stands alone', () => {
  // `BETFAIR_USERNAME` may legitimately be three characters.
  assert.strictEqual(FRUN.redact('login as abc ok', ['abc']), 'login as [redacted] ok',
    'a 3-character username was not redacted at all — it reached health().recent_log');
  assert.strictEqual(FRUN.redact('{"username":"xyz"}', ['xyz']), '{"username":"[redacted]"}',
    'a short username in collector output survived');
});

await check('R3b a short secret does not garble a longer word containing it', () => {
  // The reason the old floor existed, and the reason it was not needed.
  assert.strictEqual(FRUN.redact('table scan', ['ab']), 'table scan',
    '"table" was mangled into "t[redacted]le" — the exact garbling the floor was added to prevent');
  assert.strictEqual(FRUN.redact('market_id=1 st-1 table', ['ab']), 'market_id=1 st-1 table');
  // …but a real standalone occurrence is still caught, including next to a
  // hyphen or underscore, which USERNAME_RE permits inside a username.
  assert.strictEqual(FRUN.redact('user=ab, next', ['ab']), 'user=[redacted], next');
  assert.strictEqual(FRUN.redact('path /ab/ end', ['ab']), 'path /[redacted]/ end');
});

await check('R3c a secret containing regex metacharacters is a LITERAL', () => {
  // A password of `a.b` must not behave like the pattern "a, any char, b".
  assert.strictEqual(FRUN.redact('secret=a.b here', ['a.b']), 'secret=[redacted] here');
  assert.strictEqual(FRUN.redact('secret=axb here', ['a.b']), 'secret=axb here',
    'the pattern matched something it should not have — the value was treated as a regex');
});

// ── backoff ──────────────────────────────────────────────────────────────────

await check('R4 backoff grows and is capped, so a bad credential cannot hammer Betfair', async () => {
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

await check('R7 health() returns no credential at all — not via status, not via env', async () => {
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

// ── the two lifecycle failures that share one root cause ──────────────────────
// `state.child` was used as a statement about whether a collector was RUNNING.
// It is a statement about whether a HANDLE exists, and those come apart in two
// places: a spawn that failed (no process, handle kept forever) and a stop that
// has not finished yet (process dying, handle still held). Both made the
// operator's view of the feed wrong in opposite directions.

// R10: A MISSING BINARY DOES NOT WEDGE THE RUNNER. The module's own message
// calls ENOENT "the most common cause by far" — a typo in FEED_COLLECTOR_CMD, a
// missing venv, a PATH difference between the operator's shell and the service
// user — and it is the one failure that used to leave the venue permanently,
// silently broken while reporting green.
//
// Node emits 'error' and 'close' but NOT 'exit' when the spawn itself fails, so
// the only code that cleared `state.child` never ran. The supervisor kept a
// ChildProcess for a process that did not exist: health() said running with
// pid undefined, supervisor 'running', every later start() answered
// already_running, and stop() killed nothing while health() still said running.
await check('R10 a missing collector binary leaves the runner usable', async () => {
  const missing = path.join(os.tmpdir(), `no-such-collector-${process.pid}.sh`);
  fs.rmSync(missing, { force: true });
  const savedCmd = config.FEED_COLLECTOR_CMD;
  config.FEED_COLLECTOR_CMD = missing;
  try {
    const r = FRUN.start(tenant.id);
    assert.strictEqual(r.started, true, r.reason);
    assert.strictEqual(r.pid, undefined, 'a failed spawn has no pid — synchronously, before any event fires');

    const h0 = FRUN.health(tenant.id);
    assert.strictEqual(h0.running, false, 'health does not report a collector that never existed');
    assert.strictEqual(h0.pid, null, 'and reports a null pid, never undefined');
    assert.notStrictEqual(h0.supervisor, 'running', 'supervisor is not "running"');

    // The wedge: every later start() used to answer already_running and do
    // nothing, forever.
    const again = FRUN.start(tenant.id);
    assert.notStrictEqual(again.already_running, true, 'a second start is not refused as "already running"');

    // The operator's message arrives on the async 'error' event.
    await until(() => FRUN.health(tenant.id).last_start_error, 'the launch failure to be reported');
    assert.match(String(FRUN.health(tenant.id).last_start_error), /not installed or not on PATH|ENOENT|spawn/);

    // And stop() must not leave it claiming to be running either.
    FRUN.stop(tenant.id);
    assert.strictEqual(FRUN.health(tenant.id).running, false, 'still not running after stop()');
    // No respawn storm: the absence of an 'exit' event is DESIRABLE, so assert
    // the failure was not scheduled into a retry loop.
    const before = FRUN.health(tenant.id).consecutive_failures;
    await new Promise((res) => setTimeout(res, 600));
    assert.strictEqual(FRUN.health(tenant.id).consecutive_failures, before, 'a missing binary is not retried in a loop');
  } finally {
    FRUN.stopAll();
    config.FEED_COLLECTOR_CMD = savedCmd;
  }
});

// R11: THE CREDENTIAL-ROTATION PATH COMES BACK. This is the exact two-call
// sequence the PUT /api/admin/feed/credentials route used to make.
//
// kill('SIGTERM') is asynchronous, so `state.child` was still set on the next
// line: start() hit the already_running guard and spawned nothing, and then the
// old child's exit handler saw stopping===true and returned early instead of
// rescheduling. Saving rotated Betfair credentials — routine, expected
// maintenance — permanently stopped the venue's odds feed, with no error, no log
// line, and a response asserting collector_restarted: true.
await check('R11 a credential rotation restarts the collector instead of stopping it', async () => {
  const savedCmd = config.FEED_COLLECTOR_CMD;
  config.FEED_COLLECTOR_CMD = FAKE;
  try {
    FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
    FRUN.stop(tenant.id);
    await until(() => !FRUN.health(tenant.id).running, 'the old collector to be gone');
    FRUN.start(tenant.id);
    await until(() => FRUN.health(tenant.id).running, 'a collector to be running');
    const firstPid = FRUN.health(tenant.id).pid;
    assert.ok(firstPid > 0, 'a real process is running');

    // The restart. A live child is still terminating when this returns, so the
    // response must say "pending" rather than claim a restart that has not
    // happened yet.
    const r = FRUN.restart(tenant.id, { actor: admin });
    assert.strictEqual(r.pending, true, 'the launch is pending the old process exiting');
    assert.strictEqual(r.restarted, false, 'and is NOT reported as already done');

    // Wait for the pending restart to RESOLVE into a different pid — not merely
    // for `running`, which is still true while the old process drains. That
    // distinction is the whole bug: the old route waited on nothing at all and
    // reported success.
    await until(
      () => {
        const h = FRUN.health(tenant.id);
        return h.running && !h.restart_pending && h.pid !== firstPid ? h : null;
      },
      'the collector to come back as a NEW process'
    );
    const after = FRUN.health(tenant.id);
    assert.ok(after.pid && after.pid !== firstPid, 'a NEW process is running, not the old one');
    assert.strictEqual(after.supervisor, 'running');
    assert.strictEqual(after.restart_pending, false, 'and nothing is pending');

    // The old process is really gone, not merely unreported.
    let alive = true;
    try {
      process.kill(firstPid, 0);
    } catch (e) {
      alive = false;
    }
    assert.strictEqual(alive, false, 'the replaced collector is really gone');
  } finally {
    FRUN.stop(tenant.id);
    await FRUN.stopAll();
    config.FEED_COLLECTOR_CMD = savedCmd;
  }
});

// R12: RESTART WITH NOTHING RUNNING IS A PLAIN START. The rotation path when
// no collector is supervised must not report a pending restart that never
// resolves, and must not invent a process.
await check('R12 restarting a stopped runner starts it immediately', async () => {
  const savedCmd = config.FEED_COLLECTOR_CMD;
  config.FEED_COLLECTOR_CMD = FAKE;
  try {
    FRUN.stop(tenant.id);
    await until(() => !FRUN.health(tenant.id).running, 'the runner to be stopped');
    const r = FRUN.restart(tenant.id, { actor: admin });
    assert.strictEqual(r.pending, false, 'nothing was terminating, so nothing is pending');
    assert.strictEqual(r.restarted, true, 'and the launch happened synchronously');
    await until(() => FRUN.health(tenant.id).running, 'the collector to be running');
  } finally {
    FRUN.stop(tenant.id);
    await FRUN.stopAll();
    config.FEED_COLLECTOR_CMD = savedCmd;
  }
});

// R13: SHUTDOWN ACTUALLY STOPS THE COLLECTOR, AND ESCALATES. stopAll existed
// and had ZERO callers: the server registered no SIGTERM/SIGINT handler, so the
// default action killed the process, `server.on('close')` never fired, and the
// old `betfeed collect` survived every restart — still holding a Betfair
// session, still spending market-data weight, and competing with the new
// collector for the same account. The new process reported supervisor: 'idle'
// while a zombie ran on.
//
// stopAll is unit-tested against a live child here; the WIRING is asserted by
// tests/shutdown.test.js, which sends a real signal to a real process. Both,
// because the function being tested is precisely what hid the missing caller.
await check('R13 stopAll() stops every collector and escalates to SIGKILL', async () => {
  const savedCmd = config.FEED_COLLECTOR_CMD;
  config.FEED_COLLECTOR_CMD = FAKE;
  try {
    FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
    FRUN.start(tenant.id);
    await until(() => FRUN.health(tenant.id).running, 'a collector to be running');
    const pid = FRUN.health(tenant.id).pid;
    assert.ok(pid > 0);

    const r = await FRUN.stopAll();
    assert.strictEqual(r.stopped, 1, 'it reported stopping one process');
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      alive = false;
    }
    assert.strictEqual(alive, false, 'and the collector is really gone');

    // Escalation: a collector that IGNORES SIGTERM must not hang the shutdown.
    // `trap '' TERM` in a shell script is exactly that — a third-party Python
    // collector that never installed a handler behaves the same way.
    const stubborn = path.join(os.tmpdir(), `stubborn-collector-${process.pid}.sh`);
    fs.writeFileSync(stubborn, '#!/bin/bash\ntrap "" TERM\nwhile true; do sleep 0.2; done\n', { mode: 0o755 });
    config.FEED_COLLECTOR_CMD = stubborn;
    FRUN.start(tenant.id);
    await until(() => FRUN.health(tenant.id).running, 'the stubborn collector to be running');
    const stubbornPid = FRUN.health(tenant.id).pid;
    const esc = await FRUN.stopAll({ killAfterMs: 300 });
    assert.strictEqual(esc.escalated, 1, 'a SIGTERM-ignoring child is SIGKILLed');
    let stubbornAlive = true;
    try {
      process.kill(stubbornPid, 0);
    } catch {
      stubbornAlive = false;
    }
    assert.strictEqual(stubbornAlive, false, 'and is gone afterwards');
    fs.rmSync(stubborn, { force: true });
  } finally {
    await FRUN.stopAll();
    config.FEED_COLLECTOR_CMD = savedCmd;
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
if (failures.length) {
  console.error(`failed: ${failures.join(', ')}`);
  process.exitCode = 1;
}
}

main().catch((e) => {
  console.error('feedrunner.test.js threw:', e);
  process.exit(1);
});