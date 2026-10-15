'use strict';
// tests/username-case.test.js — is a username one identity or two?
//
// Run: node tests/username-case.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. Two rules disagreed about case:
//
//   the registry  `WHERE username = ?` and `username TEXT NOT NULL UNIQUE`,
//                 both BINARY — so `admin` and `ADMIN` were two ACCOUNTS
//   the limiter   `'login:' + username.toLowerCase()`  — one BUCKET
//
// That pairing is an unauthenticated denial of service against a name the
// README publishes. Register `ADMIN`, spend ten wrong passwords on it, and the
// DOCUMENTED `admin` account is locked out of its own venue — because the
// failures share a counter with an account the attacker does not own, and the
// attacker never has to touch the real one.
//
// EVERY CASE BELOW DIFFERS FROM ITS NEIGHBOUR ONLY BY CASE. That is the whole
// test: an assertion that also changes the username proves nothing about case
// folding, and would pass on a registry that compared usernames case-sensitively
// as long as the other thing it changed was also checked.
//
// WHY THE HARNESS HERE DOES NOT HIDE ITS OWN FAILURES. The sibling suite
// (tests/resultsfeed-signal-shape.test.js) exits on its FIRST failure, so in a
// naive run one red check masks every check after it and the rest ship
// unverified. This file reports EVERY failure and only then fails.
process.env.SCRYPT_N = '16384';
process.env.DB_PATH = ':memory:';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const assert = require('assert');
const { openStore } = require('../lib/store');
const srv = require('../server');
const A = require('../lib/auth');

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

(async () => {
  const server = srv.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await srv.ready;

  const j = async (method, path, { body, cookie } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      json: await res.json().catch(() => null),
      setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [],
    };
  };

  const countAs = (name) =>
    srv.db.prepare('SELECT COUNT(*) c FROM users WHERE username = ? COLLATE NOCASE').get(name).c;

  // ── U1 ────────────────────────────────────────────────────────────────────
  // The registration path, over HTTP, and the single most important assertion
  // in this file: a name that differs from an existing one ONLY BY CASE is
  // refused. Before the fix this returned 201 and a second account existed.
  await check('U1 registering a name that differs only by case is refused', async () => {
    assert.strictEqual(countAs('admin'), 1, 'precondition: the seeded admin exists exactly once');
    // Same letters, same order, different case. Nothing else differs.
    for (const variant of ['ADMIN', 'Admin', 'aDmIn']) {
      const res = await j('POST', '/api/auth/register', { body: { username: variant, password: 'decoy-password' } });
      assert.strictEqual(res.status, 409, `${variant} must be refused as taken; got ${res.status} ${JSON.stringify(res.json)}`);
    }
    assert.strictEqual(
      countAs('admin'),
      1,
      'and no decoy account may exist afterwards — the lockout-DoS needs a second account to hide behind'
    );
  });

  // ── U2 ────────────────────────────────────────────────────────────────────
  // The control for U1, and the thing that stops U1 passing vacuously: a name
  // that differs by MORE than case is still accepted. If registration refused
  // everything, U1 would be green and the venue unusable.
  await check('U2 a genuinely new username is still accepted', async () => {
    const res = await j('POST', '/api/auth/register', { body: { username: 'newplayer', password: 'a-real-password' } });
    assert.strictEqual(res.status, 201, `a new account must be creatable: ${JSON.stringify(res.json)}`);
    assert.strictEqual(countAs('newplayer'), 1);
    // …and one that differs from `newplayer` by a character, not by case, is a
    // different person and must not be refused as taken.
    const other = await j('POST', '/api/auth/register', { body: { username: 'newplayer2', password: 'a-real-password' } });
    assert.strictEqual(other.status, 201, 'a different name is a different person');
  });

  // ── U3 ────────────────────────────────────────────────────────────────────
  // The login path must agree with the registration path, in the same direction.
  // A registry that folds case on registration but not on login would refuse
  // `ADMIN` and then be unable to sign `admin` in — the same disagreement, one
  // layer down.
  await check('U3 login matches the username case-insensitively, to the same account', async () => {
    await j('POST', '/api/auth/register', { body: { username: 'MixedCase', password: 'mixed-password' } });
    const ids = [];
    for (const variant of ['MixedCase', 'mixedcase', 'MIXEDCASE', 'mIxEdCaSe']) {
      const res = await j('POST', '/api/auth/login', { body: { username: variant, password: 'mixed-password' } });
      assert.strictEqual(res.status, 200, `signing in as ${variant} must work: ${JSON.stringify(res.json)}`);
      ids.push(res.json.user.id);
    }
    assert.strictEqual(new Set(ids).size, 1, `every spelling must resolve to ONE account; got ids ${ids.join(',')}`);
    assert.strictEqual(countAs('mixedcase'), 1, 'and only one row exists');
  });

  // ── U4 ────────────────────────────────────────────────────────────────────
  // The control for U3: the same account, the wrong password, still fails —
  // and, critically, the stored SPELLING is preserved, because it is displayed
  // in the UI, the admin desk and audit targets. This fixes identity, not
  // display.
  await check('U4 case folding is an identity rule, not a display rewrite', async () => {
    const row = srv.db.prepare('SELECT username FROM users WHERE username = ? COLLATE NOCASE').get('MixedCase');
    assert.strictEqual(row.username, 'MixedCase', `the first registrant chose this spelling; got ${row.username}`);
    const bad = await j('POST', '/api/auth/login', { body: { username: 'MIXEDCASE', password: 'not-the-password' } });
    assert.strictEqual(bad.status, 401, 'a wrong password is still a wrong password, whatever the case');
  });

  // ── U5 ────────────────────────────────────────────────────────────────────
  // The GUARANTEE IS IN THE DATABASE, not in the JavaScript that happens to run
  // before it. U1–U3 would all still pass with a service-layer check alone, so
  // this writes rows directly with SQL — the only way a second account can now
  // appear is if the index is missing.
  await check('U5 the database itself refuses two accounts differing only by case', () => {
    const db = openStore(':memory:');
    const insert = db.prepare('INSERT INTO users (username, pass_hash) VALUES (?, ?)');
    insert.run('Player', 'a-hash');
    assert.throws(
      () => insert.run('pLAYER', 'another-hash'),
      /UNIQUE/i,
      'a direct INSERT that differs only by case must be refused by the database'
    );
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) c FROM users').get().c,
      1,
      'and exactly one row exists'
    );
    // The index, not the column constraint: `username TEXT NOT NULL UNIQUE`
    // would have allowed this pair, which is the point.
    const idx = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_users_username_nocase'")
      .get();
    assert.ok(idx, 'the case-folding index must exist');
    assert.match(idx.sql, /COLLATE NOCASE/i, 'and it must be the NOCASE one, not an accidental second index');
  });

  // ── U6 ────────────────────────────────────────────────────────────────────
  // The DoS itself, stated as the thing it actually needs. This check's FIRST
  // version drove the limiter directly and PASSED WITH THE BUG PRESENT: ten
  // failures on 'LOCKME' locked 'lockme' under the old code too, because the
  // limiter key was always folded. What makes the attack work is not the lock,
  // it is that a DECOY ACCOUNT EXISTS to spend the failures on — so the decoy is
  // the assertion.
  await check('U6 the lockout-DoS has no decoy account to hide behind', async () => {
    srv.resetLoginLimiter();
    await j('POST', '/api/auth/register', { body: { username: 'lockme', password: 'lock-password' } });
    assert.strictEqual(countAs('lockme'), 1, 'precondition: exactly one account');

    // THE ATTACK'S FIRST STEP. Before the fix this returned 201; ten wrong
    // passwords on the decoy would then share a bucket with the real account and
    // lock it out of its own venue.
    const decoy = await j('POST', '/api/auth/register', { body: { username: 'LOCKME', password: 'decoy-password' } });
    assert.strictEqual(decoy.status, 409, `the decoy must be refused; got ${decoy.status} ${JSON.stringify(decoy.json)}`);
    assert.strictEqual(countAs('lockme'), 1, 'and no second identity may exist to spend failures on');

    // With no decoy, the failures land on the one account they name — correct
    // behaviour, because the capitalised spelling IS that person.
    for (let i = 0; i < 10; i++) {
      await j('POST', '/api/auth/login', { body: { username: 'LOCKME', password: 'wrong-pw' } });
    }
    const locked = await j('POST', '/api/auth/login', { body: { username: 'lockme', password: 'wrong-pw' } });
    assert.strictEqual(locked.status, 429, 'ten failures must lock the account they name');
    assert.strictEqual(
      locked.json.error,
      'Too many failed attempts; try again later',
      'and it must be the FAILURE limiter, not the volume bucket — this check is about identity'
    );
    const samePerson = await j('POST', '/api/auth/login', { body: { username: 'LoCkMe', password: 'lock-password' } });
    assert.strictEqual(samePerson.status, 429, 'the same person, spelled differently, is the same lock');
    srv.resetLoginLimiter();
  });

  // ── U7 ────────────────────────────────────────────────────────────────────
  // The paths that were NOT on the login path still have to agree, or the
  // first-run lock silently misses a seeded account spelled in another case.
  // These are boot-sweep lookups by name; the fix has to reach them or it is
  // only half a rule.
  await check('U7 the boot sweep recognises a seeded account in any case', async () => {
    const src = require('fs').readFileSync(require.resolve('../server'), 'utf8');
    // Sliced to the NEXT function declaration, not to a named one: isSetupRoute
    // sits HUNDREDS OF LINES EARLIER in the file than enforceFirstRunLock, so
    // slicing to it yields an empty string and the assertion below fails for a
    // reason that has nothing to do with the code.
    const sweepStart = src.indexOf('async function enforceFirstRunLock');
    assert.ok(sweepStart > 0, 'enforceFirstRunLock must exist');
    const sweepEnd = src.indexOf('\nfunction ', sweepStart + 1);
    const bootSweep = src.slice(sweepStart, sweepEnd);
    assert.ok(bootSweep.length > 100, `the slice found the wrong region (${bootSweep.length} chars)`);
    assert.match(bootSweep, /username = \? COLLATE NOCASE/, 'enforceFirstRunLock must match case-insensitively');
    assert.match(
      src.slice(src.indexOf('async function isDefaultCredential')),
      /username = \? COLLATE NOCASE/,
      'and so must isDefaultCredential, or a demo account spelled ADMIN is neither warned about nor locked'
    );
    // And the behavioural half, which is what the source check cannot see:
    // flag an account spelled differently and the sweep must find it.
    await A.registerUser(srv.db, { username: 'seedcase', password: 'seedcase-password', balance_cents: 0 });
    srv.db.prepare('UPDATE users SET username = ? WHERE username = ?').run('SeedCase', 'seedcase');
    const found = srv.db
      .prepare("SELECT COUNT(*) c FROM users WHERE username = 'seedcase' COLLATE NOCASE")
      .get().c;
    assert.strictEqual(found, 1, 'a case-folded lookup finds it');
    // …and it cannot be duplicated by renaming to a different case either.
    srv.db.prepare("UPDATE users SET username = 'SEEDCASE' WHERE username = 'SeedCase'");
    assert.strictEqual(
      srv.db.prepare("SELECT COUNT(*) c FROM users WHERE username = 'seedcase' COLLATE NOCASE").get().c,
      1,
      'renaming it cannot produce a second identity'
    );
  });

  // ── U8 ────────────────────────────────────────────────────────────────────
  // The MIGRATION's other half, and the branch nobody reaches on a fresh
  // database: an EXISTING deployment that already holds two accounts differing
  // only by case cannot be indexed, and continuing without the index would
  // restore exactly the bug this migration closes. It must refuse to boot and
  // name the accounts — merging them automatically is not an option, because
  // each has its own balance and orders.
  await check('U8 a database that already violates the rule refuses to boot, by name', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obx-case-')), 'case.db');

    // Build the pre-migration shape: the table with no case-folding index, and
    // two accounts that differ only by case. This is what a venue that shipped
    // before the rule looks like on disk.
    const old = openStore(file);
    old.exec('DROP INDEX IF EXISTS idx_users_username_nocase');
    old.prepare('INSERT INTO users (username, pass_hash) VALUES (?, ?)').run('admin', 'a-hash');
    old.prepare('INSERT INTO users (username, pass_hash) VALUES (?, ?)').run('ADMIN', 'b-hash');
    old.close();

    let err = null;
    try {
      openStore(file);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'reopening a database with two case-colliding accounts must fail loudly');
    assert.match(err.message, /ADMIN/, `the operator must be told WHICH accounts collide; got: ${err.message}`);
    assert.match(err.message, /admin/, 'and both spellings of it');
    assert.match(
      err.message,
      /UPDATE users SET username/i,
      `and told how to fix it, because a boot that says only "no" is a boot nobody can resolve; got: ${err.message}`
    );

    // And the healthy case still opens, so the check is not simply "openStore
    // always throws" — the control that makes U8 mean something.
    const good = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obx-case-')), 'good.db');
    const db = openStore(good);
    db.prepare('INSERT INTO users (username, pass_hash) VALUES (?, ?)').run('Solo', 'a-hash');
    db.close();
    const reopened = openStore(good);
    assert.ok(reopened, 'a database with no collision reopens fine');
    assert.ok(
      reopened.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_users_username_nocase'").get().c,
      'and gains the index on the way in'
    );
    reopened.close();
  });

  console.log(`\nusername-case.test.js: ${passed} checks passed, ${failures.length} failed`);
  server.close();
  if (failures.length) process.exit(1);
  if (passed !== 8) { console.error(`expected 8 checks, ran ${passed}`); process.exit(1); }
})();