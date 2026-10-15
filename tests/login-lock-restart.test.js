'use strict';
// tests/login-lock-restart.test.js — does the credential lockout survive a
// restart?
//
// Run: node tests/login-lock-restart.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS, AND WHY IT SPAWNS A PROCESS. The lockout counters were
// a module-level Map, so they were gone the moment the process was. Every test
// that exercises a lock inside ONE process cannot see that, and several that
// claim to cover it do not: two Maps are both empty, so "the counter resets on
// success" passes identically whether or not the state outlives the process.
// The only way to test a restart is to RESTART, so this suite runs a CHILD node
// process against the SAME DATABASE FILE and asks it a question the parent
// cannot answer for itself.
//
// THE DECISION BEING PINNED: a restart PRESERVES the lock and the failure count.
// Not an accident of the implementation — the alternative is defensible on
// paper, and if it is ever reversed this file is what must change with it.
//
// WHY THE HARNESS HERE DOES NOT HIDE ITS OWN FAILURES. The sibling suite
// (tests/resultsfeed-signal-shape.test.js) exits on its FIRST failure, so in a
// naive run one red check masks every check after it and the rest ship
// unverified. This file reports EVERY failure and only then fails.
process.env.SCRYPT_N = '16384';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
// A file, not :memory:. The whole point is a SECOND PROCESS opening the same
// bytes, and an in-memory database dies with the process that made it — which
// would make the central check pass for the wrong reason.
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `obx-lock-restart-${process.pid}.db`);

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DB_PATH = process.env.DB_PATH;
const ROOT = path.resolve(__dirname, '..');

let passed = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push([name, e]);
    console.error(`  FAIL ${name}\n       ${e && e.message}`);
  }
};

// What the child reports back. It is a SEPARATE PROCESS answering from the file
// alone, so nothing the parent holds in memory can reach it.
const CHILD = `
const path = ${JSON.stringify(path.join(ROOT, 'server.js'))};
process.env.DB_PATH = ${JSON.stringify(DB_PATH)};
process.env.SCRYPT_N = '16384';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
const srv = require(path);
const db = require(path.replace(/server\\.js$/, 'lib/store.js')).openStore(process.env.DB_PATH);
// Tolerant of the table being absent, which is exactly the state a run against
// the OLD implementation produces. Without this the child dies with a SQL error
// and every check reports "the child produced no report" — true, and useless:
// it hides WHICH behaviour broke behind one failure.
const hasTable = () => db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='login_attempts'").get().c > 0;
const row = (k) => (hasTable()
  ? db.prepare('SELECT fails, locked_until FROM login_attempts WHERE key = ?').get(k) || null
  : null);

// NOTE ON THE INDICES. With \`node -e SCRIPT a b\`, process.argv[1] is 'a' — there
// is no script path, because there is no script file. Reading argv[2] and argv[3]
// here silently made every check look at the wrong key, and the failure it
// produced ("the lock row must exist") reads exactly like an implementation bug.
// Guarded, so a miscount is loud.
const target = process.argv[1];
const password = process.argv[2];
const mode = process.argv[3] || 'full';
if (!target || !password) {
  console.error('child: missing target/password; argv=' + JSON.stringify(process.argv));
  process.exit(3);
}

(async () => {
  await srv.ready;
  const app = srv.app.listen(0, '127.0.0.1');
  await new Promise((r) => app.on('listening', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  const post = async (p, b) => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    });
    return { status: res.status, json: await res.json().catch(() => null), retry: res.headers.get('retry-after') };
  };

  const before = row('login:' + target);
  let good = null;
  // 'wrong-only' exists because the two requests INTERFERE and that is the
  // behaviour under test: a correct-password attempt SUCCEEDS and deletes the
  // row, so a mode that also asked for a correct password could not report the
  // state after a single wrong one.
  if (mode !== 'wrong-only') good = await post('/api/auth/login', { username: target, password });
  const afterGood = row('login:' + target);

  const bad = await post('/api/auth/login', { username: target, password: 'definitely-not-it' });
  const after = row('login:' + target);
  // Measured in the child, against the child's own clock, because that is the
  // clock the window was computed from.
  const windowMs = after ? after.locked_until - Date.now() : null;

  const untouched = await post('/api/auth/login', { username: 'never-attacked', password: 'whatever-x' });
  const untouchedRow = row('login:never-attacked');

  console.log(JSON.stringify({
    target, mode, before, good, afterGood, bad, after, windowMs, untouched, untouchedRow,
  }));
  app.close();
  process.exit(0);
})();
`;

function runChild(target, password, mode = 'full') {
  const run = spawnSync(process.execPath, ['-e', CHILD, target, password, mode], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
  const line = String(run.stdout || '').split('\n').filter((l) => l.trim().startsWith('{')).pop();
  if (!line) {
    throw new Error(`the child produced no report (status ${run.status}): ${String(run.stderr || '').slice(0, 400)}`);
  }
  return JSON.parse(line);
}

// Read a stored counter WITHOUT assuming the table exists.
//
// This exists so the suite can REPORT per-check results when the implementation
// is the old in-memory one. The first version read login_attempts in a
// top-level precondition, and with the table absent that threw before a single
// check ran — a red suite that says nothing about which behaviour broke, which
// is the same masking failure as a suite that exits on its first failure.
function storedAttempt(db, key) {
  const has = db
    .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='login_attempts'")
    .get().c;
  if (!has) return null;
  return db.prepare('SELECT fails, locked_until FROM login_attempts WHERE key = ?').get(key) || null;
}

function lapseWindow(db, key) {
  if (!storedAttempt(db, key)) return false;
  db.prepare('UPDATE login_attempts SET locked_until = 1 WHERE key = ?').run(key);
  return true;
}

(async () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch { /* not created yet */ }
  }

  const srv = require('../server');
  await srv.ready;

  // A listener on a real port, so the parent can lock an account the way an
  // attacker would: over HTTP, not by calling the internals.
  const server = srv.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body, cookie) => {
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null), retry: res.headers.get('retry-after') };
  };

  // Register an account whose password is known to both processes.
  const registered = await post('/api/auth/register', { username: 'victim', password: 'victim-password' });
  assert.strictEqual(registered.status, 201, `the fixture account must exist: ${JSON.stringify(registered.json)}`);

  // Ten failures: the lock arms.
  for (let i = 0; i < 10; i++) await post('/api/auth/login', { username: 'victim', password: 'wrong-password' });
  const armed = await post('/api/auth/login', { username: 'victim', password: 'wrong-password' });
  assert.strictEqual(armed.status, 429, `precondition: the lock must be armed in this process; got ${armed.status}`);
  assert.strictEqual(armed.json.error, 'Too many failed attempts; try again later');
  // NOT asserted here on purpose — see storedAttempt(). L1 asserts it, so a run
  // against the old implementation reports which checks broke instead of
  // throwing before any of them ran.
  const beforeRestart = storedAttempt(srv.db, 'login:victim');

  let child = null;

  // ── L1 ────────────────────────────────────────────────────────────────────
  // THE CENTRAL CHECK. A process that never saw a single failure refuses the
  // account anyway, because the lock was already in the file when it started.
  await check('L1 the lock survives the restart: a fresh process refuses the account', async () => {
    child = runChild('victim', 'victim-password');
    assert.ok(beforeRestart, 'the counter must be STORED, not merely held in memory — that is the whole change');
    assert.ok(child.before, `the lock row must exist on disk before the child reads it; got ${JSON.stringify(child.before)}`);
    assert.strictEqual(
      child.before.fails,
      10,
      `the failure COUNT must have survived too, not just the deadline; got ${child.before.fails}`
    );
    // The correct password, from a process that has no idea it is locked.
    assert.strictEqual(
      child.good.status,
      429,
      `a restarted venue must still refuse a locked account; got ${child.good.status} ${JSON.stringify(child.good.json)}`
    );
    assert.strictEqual(
      child.good.json.error,
      'Too many failed attempts; try again later',
      'and for the lockout reason, not some generic throttle'
    );
    assert.ok(Number(child.good.retry) > 0, `and must say when the window ends; got ${child.good.retry}`);
  });

  // ── L2 ────────────────────────────────────────────────────────────────────
  // The control, and the one that stops L1 being satisfied by "the child refuses
  // everything". An account nobody has attacked signs in normally in the child.
  await check('L2 the restarted process is not refusing everyone', async () => {
    assert.ok(child, 'L1 must have run');
    assert.strictEqual(
      child.untouched.status,
      401,
      `an account with no history must reach the password check, not the limiter; got ${child.untouched.status}`
    );
    assert.strictEqual(
      child.untouched.json.error,
      'Invalid username or password',
      'and be told the ordinary thing — the lock is scoped to the account it names'
    );
    // It DOES record the strike, and it is not armed — a control that asserted
    // "no row at all" here would be asserting that the child records nothing,
    // which is not the property and would be a different bug if it were true.
    assert.ok(child.untouchedRow, 'a failed attempt on an untouched key is still recorded');
    assert.strictEqual(
      child.untouchedRow.locked_until,
      0,
      'but one strike must not be a lock — the threshold is ten'
    );
    assert.strictEqual(child.untouchedRow.fails, 1);
  });

  // ── L3 ────────────────────────────────────────────────────────────────────
  // ESCALATION SURVIVES, which is the part a lock that merely persisted a
  // deadline would get wrong. This check's first version drove the count up
  // while the account was still locked and asserted eleven strikes — and got
  // ten, correctly: a locked key answers 429 WITHOUT reaching the password
  // check, so it cannot record a strike. The escalation happens after the
  // window lapses, and what it proves is that the COUNT came across the
  // restart: the child must add a strike to TEN, not start again at one.
  await check('L3 the escalation survives: the child adds a strike to ten, not to one', async () => {
    assert.ok(child, 'L1 must have run');
    assert.ok(lapseWindow(srv.db, 'login:victim'), 'precondition: a stored window to lapse');
    const c = runChild('victim', 'victim-password', 'wrong-only');
    assert.strictEqual(
      c.before.fails,
      10,
      `the failure COUNT must have survived the restart; the child saw ${c.before.fails}`
    );
    assert.strictEqual(
      c.after.fails,
      11,
      `the next strike must be the ELEVENTH, not the first; got ${c.after.fails}`
    );
    // …and the window doubles from 30s to 60s, which is what the eleventh
    // strike buys. Measured against the child's own clock. The specific wrong
    // answer — a fresh counter writing the 30s base — is excluded explicitly,
    // so this cannot pass by landing near both.
    assert.ok(
      c.windowMs > 45_000 && c.windowMs <= 65_000,
      `the 11th strike must double the window to 60s; the child measured ${c.windowMs}ms`
    );
  });

  // ── L4 ────────────────────────────────────────────────────────────────────
  // "Persists forever" is not the property being asserted. Once the window has
  // lapsed the owner signs in normally and the STORED ROW IS DELETED, from a
  // restarted process, with no database edit — so a venue that locked an
  // operator out by accident is still recoverable.
  await check('L4 the owner can still clear it: a success deletes the stored row', async () => {
    assert.ok(child, 'L1 must have run');
    assert.ok(lapseWindow(srv.db, 'login:victim'), 'precondition: a stored window to lapse');
    const c = runChild('victim', 'victim-password');
    // Prove the row was there before the clear, or "the row is gone" could mean
    // "there was never a row" — which is what this check asserted the first
    // time it ran, and it passed against a child that had locked the wrong key.
    assert.ok(c.before, `precondition: a stored row must exist; got ${JSON.stringify(c.before)}`);
    assert.strictEqual(
      c.good.status,
      200,
      `once the window has passed the owner must be able to sign in; got ${c.good.status} ${JSON.stringify(c.good.json)}`
    );
    assert.strictEqual(
      c.afterGood,
      null,
      `and the success must have DELETED the stored row, not decremented it; left ${JSON.stringify(c.afterGood)}`
    );
    // …and the account really works afterwards.
    const fresh = await post('/api/auth/login', { username: 'victim', password: 'victim-password' });
    assert.strictEqual(fresh.status, 200, `and still signs in from THIS process afterwards; got ${fresh.status}`);
  });

  // ── L5 ────────────────────────────────────────────────────────────────────
  // The per-SOURCE counter moved too — it is the CPU brake, and it was the same
  // Map. The parent arms it, the child must still be refusing.
  await check('L5 the per-source CPU brake survives the restart as well', async () => {
    srv.resetLoginLimiter();
    // 30 failures on one source is RL_IP_MAX_FAILURES, the IP threshold.
    for (let i = 0; i < 31; i++) await post('/api/auth/login', { username: `flood_${i}`, password: 'wrong-pw' });
    const ipKeys = storedAttempt(srv.db, 'login-ip:127.0.0.1');
    assert.ok(ipKeys, 'the per-source key must be stored as a row, like every other counter');
    // A child on the same loopback address must find the address already
    // throttled, even though it has recorded no failures of its own.
    const c = runChild('someone-else', 'some-password');
    assert.strictEqual(
      c.untouched.status,
      429,
      `a restarted process must still be bounded by the per-source brake; got ${c.untouched.status}`
    );
    assert.strictEqual(
      c.untouched.json.error,
      'Too many failed attempts; try again later',
      'and with the failure-counter message, not a generic throttle'
    );
    srv.resetLoginLimiter();
  });

  console.log(`\nlogin-lock-restart.test.js: ${passed} checks passed, ${failures.length} failed`);
  server.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
  if (failures.length) process.exit(1);
  if (passed !== 5) { console.error(`expected 5 checks, ran ${passed}`); process.exit(1); }
})();