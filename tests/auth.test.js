// auth.test.js — scrypt hashing, registration, sessions (PLAN "Auth").
// Run: node tests/auth.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const crypto = require('node:crypto');
const config = require('../lib/config');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

function fresh() {
  return openStore(':memory:');
}

// A1: hash/verify roundtrip; wrong password fails; garbage stored hash fails safely.
check('A1 password hashing', async () => {
  const db = fresh();
  const h = (await A.hashPassword('hunter22'));
  assert.ok(h.startsWith('scrypt$'));
  assert.ok((await A.verifyPassword('hunter22', h)));
  assert.ok(!(await A.verifyPassword('hunter23', h)));
  assert.ok(!(await A.verifyPassword('hunter22', 'garbage')));
  assert.ok(!(await A.verifyPassword('hunter22', 'md5$abc$def')));
  assert.ok(!(await A.verifyPassword('hunter22', 'scrypt$$')));
});

// A2: registration — sanitized user (no pass_hash), default balance; the
// balance_cents/is_bot options stay supported for in-repo callers (the
// engine test suites fund wallets; lib/bots.js marks the house bot).
check('A2 registration', async () => {
  const db = fresh();
  const u = (await A.registerUser(db, { username: 'joel', password: 'secret1' }));
  assert.strictEqual(u.username, 'joel');
  assert.strictEqual(u.balance_cents, 0);
  assert.strictEqual(u.is_admin, false);
  assert.strictEqual(u.pass_hash, undefined);
  const rich = (await A.registerUser(db, { username: 'rich', password: 'secret1', balance_cents: 50000 }));
  assert.strictEqual(rich.balance_cents, 50000);
  await assert.rejects(A.registerUser(db, { username: 'joel', password: 'secret2' }), (e) => e.status === 409);
});

// A3: credential validation (400).
check('A3 validation', async () => {
  const db = fresh();
  await assert.rejects(A.registerUser(db, { username: 'ab', password: 'secret1' }), (e) => e.status === 400);
  await assert.rejects(A.registerUser(db, { username: 'bad name!', password: 'secret1' }), (e) => e.status === 400);
  await assert.rejects(A.registerUser(db, { username: 'okname', password: '12345' }), (e) => e.status === 400);
  await assert.rejects(A.registerUser(db, { username: 'okname', password: '' }), (e) => e.status === 400);
});

// A4: login → token + user; wrong password and unknown user share ONE generic error.
check('A4 login', async () => {
  const db = fresh();
  await A.registerUser(db, { username: 'joel', password: 'secret1', balance_cents: 1000 });
  const { user, token } = (await A.loginUser(db, { username: 'joel', password: 'secret1' }));
  assert.strictEqual(user.username, 'joel');
  assert.ok(/^[0-9a-f]{64}$/.test(token));
  let msgWrong = null;
  let msgUnknown = null;
  try { (await A.loginUser(db, { username: 'joel', password: 'wrongpw' })); } catch (e) { msgWrong = e.message; }
  try { (await A.loginUser(db, { username: 'ghost', password: 'wrongpw' })); } catch (e) { msgUnknown = e.message; }
  assert.strictEqual(msgWrong, 'Invalid username or password');
  assert.strictEqual(msgUnknown, msgWrong);
});

// A5: sessions — the token is stored as a SHA-256 digest, never plaintext;
// valid resolves, expired is dead, logout deletes by digest.
check('A5 sessions (tokens hashed at rest)', async () => {
  const db = fresh();
  const u = (await A.registerUser(db, { username: 'joel', password: 'secret1' }));
  const token = A.createSession(db, u.id);
  assert.strictEqual(A.sessionUser(db, token).username, 'joel');
  // at rest: the sessions table holds the digest, not the token
  const stored = db.prepare('SELECT token FROM sessions').all().map((r) => r.token);
  assert.strictEqual(stored.length, 1);
  assert.notStrictEqual(stored[0], token);
  assert.strictEqual(stored[0], A.hashToken(token));
  // an expired session (insert a DIGEST with a past expiry directly)
  const dead = A.hashToken('dead-token');
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '-1 day'))").run(dead, u.id);
  assert.strictEqual(A.sessionUser(db, 'dead-token'), null);
  // logout deletes by digest
  A.destroySession(db, token);
  assert.strictEqual(A.sessionUser(db, token), null);
  assert.strictEqual(A.sessionUser(db, null), null);
  // a plaintext token from an OLD database version matches nothing — the
  // one-time invalidation is the documented cost of hashing at rest
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('legacy-plaintext', ?, datetime('now', '+1 day'))").run(u.id);
  assert.strictEqual(A.sessionUser(db, 'legacy-plaintext'), null);
});

// A6: bots can never log in (they hold random passwords; explicit guard too).
check('A6 bot login rejected', async () => {
  const db = fresh();
  await A.registerUser(db, { username: 'MarketMakers', password: 'botpw123', is_bot: 1 });
  await assert.rejects(A.loginUser(db, { username: 'MarketMakers', password: 'botpw123' }), (e) => e.status === 401);
});

// A7: the privileged factory is createAccount — the ONLY place an admin can
// be minted. registerUser refuses the is_admin flag outright, so no future
// caller of the public path can escalate itself.
check('A7 registerUser cannot mint admins; createAccount can', async () => {
  const db = fresh();
  await assert.rejects(A.registerUser(db, { username: 'boss', password: 'secret1', is_admin: 1 }),
    (e) => e.status === 400
  );
  const admin = (await A.createAccount(db, { username: 'boss', password: 'secret1', is_admin: 1, balance_cents: 1000000 }));
  assert.strictEqual(admin.is_admin, true);
  assert.strictEqual(admin.balance_cents, 1000000);
  assert.strictEqual(admin.pass_hash, undefined);
  // duplicate usernames are 409 through the factory too
  await assert.rejects(A.createAccount(db, { username: 'boss', password: 'secret1' }), (e) => e.status === 409);
  // the money boundary holds for privileged creation as well
  await assert.rejects(A.createAccount(db, { username: 'frac', password: 'secret1', balance_cents: 500.5 }), (e) => e.status === 400);
  await assert.rejects(A.createAccount(db, { username: 'neg', password: 'secret1', balance_cents: -1 }), (e) => e.status === 400);
});

// A8: bot accounts keep working through the public path (lib/bots.js marks
// the house counterparty with is_bot; the flag must survive the split).
check('A8 is_bot survives the register/create split', async () => {
  const db = fresh();
  const bot = (await A.createAccount(db, { username: 'HouseBot', password: 'botpw123', is_bot: 1, balance_cents: 100 }));
  assert.strictEqual(bot.is_bot, true);
  const viaRegister = (await A.registerUser(db, { username: 'HouseBot2', password: 'botpw123', is_bot: 1 }));
  assert.strictEqual(viaRegister.is_bot, true);
});

// A9: login accepts EITHER identifier. The username is matched as typed; the
// email is matched lowercased, because that is how it is stored.
check('A9 login by username or email', async () => {
  const db = fresh();
  await A.registerUser(db, { username: 'joel', password: 'secret1', email: 'Joel@Example.COM' });
  assert.strictEqual((await A.loginUser(db, { username: 'joel', password: 'secret1' })).user.id > 0, true);
  assert.ok((await A.loginUser(db, { identifier: 'joel@example.com', password: 'secret1' })).token);
  assert.ok((await A.loginUser(db, { email: 'JOEL@EXAMPLE.COM', password: 'secret1' })).token);
  // A wrong password on a KNOWN email still fails, and reveals nothing extra.
  await assert.rejects(A.loginUser(db, { identifier: 'joel@example.com', password: 'nope' }), (e) => e.status === 401);
});

// A10: an address identifies at most one account, and a malformed one is refused.
check('A10 email validation and uniqueness', async () => {
  const db = fresh();
  await A.registerUser(db, { username: 'first', password: 'secret1', email: 'dup@example.com' });
  // Case-different spelling is the SAME identity, not a second account.
  await assert.rejects(A.registerUser(db, { username: 'second', password: 'secret1', email: 'DUP@example.com' }), (e) => e.status === 409);
  for (const bad of ['notanemail', 'a@b', 'a b@c.com', '@nope.com']) {
    await assert.rejects(A.registerUser(db, { username: 'x' + Math.random().toString(36).slice(2, 7), password: 'secret1', email: bad }), (e) => e.status === 400, bad);
  }
  // Omitting email entirely stays legal — most accounts have no address.
  assert.strictEqual((await A.registerUser(db, { username: 'noaddress', password: 'secret1' })).email, null);
});

// A11: a suspended account cannot log in, and the refusal does not leak
// before the password is checked (a wrong password on a suspended account
// must still read as an ordinary 401, not a 403 that confirms it exists).
check('A11 suspension blocks login without leaking', async () => {
  const db = fresh();
  const u = (await A.registerUser(db, { username: 'suspended', password: 'secret1' }));
  db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(u.id);

  await assert.rejects(A.loginUser(db, { username: 'suspended', password: 'wrong' }), (e) => e.status === 401);
  await assert.rejects(A.loginUser(db, { username: 'suspended', password: 'secret1' }), (e) => e.status === 403);
  // Restoring the account restores access.
  db.prepare("UPDATE users SET status='active' WHERE id=?").run(u.id);
  assert.ok((await A.loginUser(db, { username: 'suspended', password: 'secret1' })).token);
});

// A12: changing a password requires the current one, and revokes every OTHER
// session while leaving the caller's alive.
check('A12 change password revokes other sessions', async () => {
  const db = fresh();
  const u = (await A.registerUser(db, { username: 'joel', password: 'secret1' }));
  const mine = A.createSession(db, u.id);
  const theirs = A.createSession(db, u.id);

  await assert.rejects(A.changePassword(db, { userId: u.id, currentPassword: 'wrong', newPassword: 'secret2', keepToken: mine }),
    (e) => e.status === 401
  );
  await assert.rejects(A.changePassword(db, { userId: u.id, currentPassword: 'secret1', newPassword: 'secret1', keepToken: mine }),
    (e) => e.status === 400
  );
  await assert.rejects(A.changePassword(db, { userId: u.id, currentPassword: 'secret1', newPassword: 'short', keepToken: mine }),
    (e) => e.status === 400
  );

  const r = (await A.changePassword(db, { userId: u.id, currentPassword: 'secret1', newPassword: 'secret2', keepToken: mine }));
  assert.strictEqual(r.sessionsRevoked, 1);
  assert.ok(A.sessionUser(db, mine), 'the caller keeps working');
  assert.strictEqual(A.sessionUser(db, theirs), null, 'the other session is dead');
  assert.ok((await A.loginUser(db, { username: 'joel', password: 'secret2' })).token);
  await assert.rejects(A.loginUser(db, { username: 'joel', password: 'secret1' }), (e) => e.status === 401);
});

// A13: sessions are listed without exposing tokens, and a session id from
// another account can never be revoked.
check('A13 session listing and scoped revocation', async () => {
  const db = fresh();
  const me = (await A.registerUser(db, { username: 'myself', password: 'secret1' }));
  const other = (await A.registerUser(db, { username: 'other', password: 'secret1' }));
  const mine = A.createSession(db, me.id);
  A.createSession(db, me.id);
  const theirs = A.createSession(db, other.id);

  const list = A.listSessions(db, me.id, mine);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list.filter((s) => s.current).length, 1, 'exactly one is current');
  for (const s of list) assert.ok(!('token' in s), 'no token is ever returned');

  // The other account's session id must not be revocable through this account.
  const foreignId = A.listSessions(db, other.id, theirs)[0].id;
  assert.throws(() => A.revokeSession(db, me.id, foreignId), (e) => e.status === 404);
  assert.ok(A.sessionUser(db, theirs), 'and the foreign session still works');

  assert.throws(() => A.revokeSession(db, me.id, 'deadbeefdead'), (e) => e.status === 404);
  assert.strictEqual(A.revokeSession(db, me.id, list.find((s) => !s.current).id).revoked, true);
});

// A14: role is authoritative and is granted ONLY by the internal factory —
// registerUser refuses it exactly as it refuses is_admin.
check('A14 registerUser cannot mint roles', async () => {
  const db = fresh();
  await assert.rejects(A.registerUser(db, { username: 'boss', password: 'secret1', role: 'admin' }),
    (e) => e.status === 400
  );
  const viaRole = (await A.createAccount(db, { username: 'boss', password: 'secret1', role: 'admin' }));
  assert.strictEqual(viaRole.role, 'admin');
  assert.strictEqual(viaRole.is_admin, true, 'legacy mirror agrees');
  const plain = (await A.registerUser(db, { username: 'joel', password: 'secret1' }));
  assert.strictEqual(plain.role, 'user');
});

// A15: the stored hash records its OWN cost, so raising SCRYPT_N is a one-line
// change that invalidates nothing — legacy hashes keep verifying and migrate
// to the current cost the moment their owner next proves the password.
// This suite deliberately does NOT pin SCRYPT_N; it runs at the real default.
check('A15 hash records its cost; legacy rehashes on login', async () => {
  const db = fresh();
  const u = (await A.registerUser(db, { username: 'joel', password: 'secret1' }));
  const stored = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(u.id).pass_hash;

  assert.strictEqual(stored.split('$').length, 4, 'a new hash records N');
  assert.strictEqual(Number(stored.split('$')[1]), config.SCRYPT_N);
  assert.strictEqual(A.needsRehash(stored), false, 'a current hash needs no migration');
  assert.strictEqual((await A.verifyPassword('secret1', stored)), true);
  assert.strictEqual((await A.verifyPassword('wrong', stored)), false);

  // A legacy 3-part hash, built exactly as the previous version wrote it.
  //
  // A 3-part hash carries no N, so lib/auth.js verifies it at its own
  // LEGACY_SCRYPT_N constant (16384). It MUST therefore be constructed at that
  // exact cost or verification fails — the first attempt here built it at 1024
  // to dodge the ambient SCRYPT_N and got 'legacy still verifies' === false,
  // which looks like a security failure and is really a fixture mistake.
  //
  // The rehash assertion below is therefore only meaningful when the configured
  // SCRYPT_N exceeds 16384. The default is 65536, but a local .env may set
  // SCRYPT_N=16384 for fast logins (the demo .env does), and then a legacy hash
  // is genuinely NOT due for a rehash — so the check is stated as a
  // consequence of the configured cost rather than asserted unconditionally.
  const LEGACY_N = 16384;
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync('secret1', salt, 64, { N: LEGACY_N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const legacy = `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(legacy, u.id);

  assert.strictEqual((await A.verifyPassword('secret1', legacy)), true, 'legacy still verifies at its own cost');
  assert.strictEqual((await A.verifyPassword('wrong', legacy)), false, 'and still rejects a wrong password');
  assert.strictEqual(
    A.needsRehash(legacy),
    config.SCRYPT_N > LEGACY_N,
    `a hash at the legacy cost needs a rehash exactly when SCRYPT_N (${config.SCRYPT_N}) exceeds it`
  );

  // The next successful login migrates it in place — but ONLY when there is a
  // cost gap to close. At SCRYPT_N === LEGACY_N the hash is already current, so
  // "it was rewritten" is not a property of the system; asserting it made this
  // test depend on the ambient cost rather than on the behaviour. The migration
  // path is what matters, so it is exercised whenever a gap exists and the
  // security-relevant invariant (a failed login migrates nothing) is asserted
  // unconditionally below either way.
  const willMigrate = config.SCRYPT_N > LEGACY_N;
  assert.ok((await A.loginUser(db, { username: 'joel', password: 'secret1' })).token);
  const after = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(u.id).pass_hash;
  if (willMigrate) {
    assert.notStrictEqual(after, legacy, 'the hash was rewritten');
    assert.strictEqual(after.split('$').length, 4);
    assert.strictEqual(Number(after.split('$')[1]), config.SCRYPT_N);
  }
  assert.strictEqual(A.needsRehash(after), false, 'after a successful login no rehash is pending');
  assert.strictEqual((await A.verifyPassword('secret1', after)), true, 'the same password still works');
  assert.strictEqual((await A.verifyPassword('wrong', after)), false);

  // A FAILED login must not migrate anything — the password was never proven.
  const salt2 = crypto.randomBytes(16);
  const h2 = crypto.scryptSync('secret1', salt2, 64, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const legacy2 = `scrypt$${salt2.toString('hex')}$${h2.toString('hex')}`;
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(legacy2, u.id);
  await assert.rejects(A.loginUser(db, { username: 'joel', password: 'wrong' }), (e) => e.status === 401);
  assert.strictEqual(db.prepare('SELECT pass_hash FROM users WHERE id=?').get(u.id).pass_hash, legacy2, 'untouched');
});

// A16: a malformed or hostile stored value must fail closed, never throw out of
// verifyPassword — it is called from the login path and from dummyVerify.
check('A16 malformed stored hashes fail closed', async () => {
  for (const bad of ['', 'null', 'scrypt', 'scrypt$', 'scrypt$$', 'bcrypt$a$b$c',
                     'scrypt$notanumber$salt$hash', 'scrypt$1$salt$hash', 'scrypt$16384$zz$zz']) {
    assert.strictEqual((await A.verifyPassword('secret1', bad)), false, JSON.stringify(bad));
    assert.doesNotThrow(() => A.verifyPassword('secret1', bad));
  }
  // A well-formed hash of the WRONG length must not blow up timingSafeEqual.
  const salt = crypto.randomBytes(16);
  const short = crypto.scryptSync('secret1', salt, 32, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  assert.strictEqual((await A.verifyPassword('secret1', `scrypt$16384$${salt.toString('hex')}$${short.toString('hex')}`)), false);
});

// #1: key derivation must NOT run on the event loop.
//
// The assertion is a SPOY, not a timer. Timing thresholds are flaky and a
// flaky test is a test that gets deleted; this one is deterministic: the
// synchronous scrypt entry point is replaced with a trap for the duration of
// the check, so ANY reintroduced scryptSync on this path throws immediately
// and by name, wherever in lib/auth.js it happens to be called.
//
// Measured motivation: with scryptSync, one login froze the whole process for
// ~42ms (N=16384) — measured worst gap between consecutive timers running
// alongside it. With crypto.scrypt the same login measures a 3ms worst gap,
// and eight concurrent logins measure 5ms against a live HTTP server.
check('A17 key derivation runs off the event loop, not on it', async () => {
  const db = fresh();
  const realSync = crypto.scryptSync;
  let trapped = null;
  crypto.scryptSync = (...args) => {
    trapped = args;
    throw new Error('scryptSync called on the auth path — the event loop was blocked');
  };
  try {
    await A.registerUser(db, { username: 'spied', password: 'secret1' });
    await A.loginUser(db, { username: 'spied', password: 'secret1' });
    await A.changePassword(db, { userId: 1, currentPassword: 'secret1', newPassword: 'secret2' });
    assert.strictEqual(trapped, null, 'scryptSync was never reached');
  } finally {
    crypto.scryptSync = realSync;
  }

  // The spy only proves the SYNC entry point is unused. Prove the derivation
  // really still happens, and at the documented cost, by checking the stored
  // hash carries SCRYPT_N rather than a hard-coded constant.
  const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(1);
  const parsed = A.parseStored(row.pass_hash);
  assert.ok(parsed, 'a scrypt hash was written');
  assert.strictEqual(parsed.N, config.SCRYPT_N, `at SCRYPT_N (${config.SCRYPT_N})`);
  assert.ok(await A.verifyPassword('secret2', row.pass_hash), 'and it verifies');
});

// #1: and the loop genuinely keeps running while a login is in flight.
check('A18 a login does not stall other work on the event loop', async () => {
  const db = fresh();
  await A.registerUser(db, { username: 'busy', password: 'secret1' });

  // A self-rescheduling timer. The worst gap between consecutive firings IS
  // the stall the login caused. The threshold is deliberately far above the
  // measured 2-5ms and far below the ~42ms scryptSync cost, so it tolerates a
  // loaded CI box without ever admitting a return to the blocking form.
  let worst = 0;
  let last = Date.now();
  let stop = false;
  (function tick() {
    const n = Date.now();
    if (n - last > worst) worst = n - last;
    last = n;
    if (!stop) setTimeout(tick, 0);
  })();

  await A.loginUser(db, { username: 'busy', password: 'secret1' });
  await new Promise((r) => setTimeout(r, 30));
  stop = true;

  assert.ok(worst < 20, `worst event-loop stall was ${worst}ms (scryptSync would be ~42ms)`);
});

// A19 (#29): a session id is a PREFIX, and the old query treated it as a LIKE
// PATTERN. In SQLite `_` matches any single character and `%` any sequence, so
// an endpoint whose entire job is "revoke ONE session" revoked EVERY session
// the account had — and answered {revoked: true}, because changes > 0.
//
// The assertion that matters is the session COUNT afterwards, not the return
// value: a test that only checks the reply is satisfied by both behaviours,
// because the buggy one also reports success. Before this check nothing
// covered it at all.
check('A19 a wildcard or empty session id revokes nothing at all', async () => {
  const db = fresh();
  const me = (await A.registerUser(db, { username: 'myself', password: 'secret1' }));
  const other = (await A.registerUser(db, { username: 'other', password: 'secret1' }));
  const a = A.createSession(db, me.id);
  A.createSession(db, me.id);
  A.createSession(db, me.id);
  const theirs = A.createSession(db, other.id);
  const liveSessions = (id) => A.listSessions(db, id, null).length;
  assert.strictEqual(liveSessions(me.id), 3, 'three sessions to protect');

  // Each of these matched EVERY row under LIKE. Under the fix they match none.
  for (const wildcard of ['_', '%', '_%', '', null, undefined, 0, false, '____________']) {
    assert.throws(
      () => A.revokeSession(db, me.id, wildcard),
      (e) => e.status === 400 || e.status === 404,
      `${JSON.stringify(wildcard)} is refused`
    );
    assert.strictEqual(liveSessions(me.id), 3, `${JSON.stringify(wildcard)} revoked NO session`);
  }
  assert.ok(A.sessionUser(db, a), 'and the real token still works');
  assert.ok(A.sessionUser(db, theirs), "another account's session is untouched too");

  // The control: a REAL id still revokes exactly one, and only that one.
  const victim = A.listSessions(db, me.id, null).find((s) => s.id !== A.hashToken(a).slice(0, 12));
  assert.strictEqual(A.revokeSession(db, me.id, victim.id).revoked, true);
  assert.strictEqual(liveSessions(me.id), 2, 'exactly one, not all');
  assert.strictEqual(liveSessions(other.id), 1, "the other account is untouched");
});

(async () => {
  // Drain the collected checks IN ORDER, awaiting each. A check that rejects
  // is a failure of this suite, not of the next file: exiting here stops
  // the rest of this suite running rather than letting a broken assertion
  // print a green line for a body that never completed.
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (e) {
      console.error(`  FAIL ${name}`);
      console.error(e);
      process.exit(1);
    }
    passed++;
    console.log('  ok', name);
  }
  console.log(`\nauth.test.js: ${passed} checks passed`);
})();
