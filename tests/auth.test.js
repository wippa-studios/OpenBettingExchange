// auth.test.js — scrypt hashing, registration, sessions (PLAN "Auth").
// Run: node tests/auth.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const crypto = require('node:crypto');
const config = require('../lib/config');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

function fresh() {
  return openStore(':memory:');
}

// A1: hash/verify roundtrip; wrong password fails; garbage stored hash fails safely.
check('A1 password hashing', () => {
  const db = fresh();
  const h = A.hashPassword('hunter22');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(A.verifyPassword('hunter22', h));
  assert.ok(!A.verifyPassword('hunter23', h));
  assert.ok(!A.verifyPassword('hunter22', 'garbage'));
  assert.ok(!A.verifyPassword('hunter22', 'md5$abc$def'));
  assert.ok(!A.verifyPassword('hunter22', 'scrypt$$'));
});

// A2: registration — sanitized user (no pass_hash), default balance; the
// balance_cents/is_bot options stay supported for in-repo callers (the
// engine test suites fund wallets; lib/bots.js marks the house bot).
check('A2 registration', () => {
  const db = fresh();
  const u = A.registerUser(db, { username: 'joel', password: 'secret1' });
  assert.strictEqual(u.username, 'joel');
  assert.strictEqual(u.balance_cents, 0);
  assert.strictEqual(u.is_admin, false);
  assert.strictEqual(u.pass_hash, undefined);
  const rich = A.registerUser(db, { username: 'rich', password: 'secret1', balance_cents: 50000 });
  assert.strictEqual(rich.balance_cents, 50000);
  assert.throws(() => A.registerUser(db, { username: 'joel', password: 'secret2' }), (e) => e.status === 409);
});

// A3: credential validation (400).
check('A3 validation', () => {
  const db = fresh();
  assert.throws(() => A.registerUser(db, { username: 'ab', password: 'secret1' }), (e) => e.status === 400);
  assert.throws(() => A.registerUser(db, { username: 'bad name!', password: 'secret1' }), (e) => e.status === 400);
  assert.throws(() => A.registerUser(db, { username: 'okname', password: '12345' }), (e) => e.status === 400);
  assert.throws(() => A.registerUser(db, { username: 'okname', password: '' }), (e) => e.status === 400);
});

// A4: login → token + user; wrong password and unknown user share ONE generic error.
check('A4 login', () => {
  const db = fresh();
  A.registerUser(db, { username: 'joel', password: 'secret1', balance_cents: 1000 });
  const { user, token } = A.loginUser(db, { username: 'joel', password: 'secret1' });
  assert.strictEqual(user.username, 'joel');
  assert.ok(/^[0-9a-f]{64}$/.test(token));
  let msgWrong = null;
  let msgUnknown = null;
  try { A.loginUser(db, { username: 'joel', password: 'wrongpw' }); } catch (e) { msgWrong = e.message; }
  try { A.loginUser(db, { username: 'ghost', password: 'wrongpw' }); } catch (e) { msgUnknown = e.message; }
  assert.strictEqual(msgWrong, 'Invalid username or password');
  assert.strictEqual(msgUnknown, msgWrong);
});

// A5: sessions — the token is stored as a SHA-256 digest, never plaintext;
// valid resolves, expired is dead, logout deletes by digest.
check('A5 sessions (tokens hashed at rest)', () => {
  const db = fresh();
  const u = A.registerUser(db, { username: 'joel', password: 'secret1' });
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
check('A6 bot login rejected', () => {
  const db = fresh();
  A.registerUser(db, { username: 'MarketMakers', password: 'botpw123', is_bot: 1 });
  assert.throws(() => A.loginUser(db, { username: 'MarketMakers', password: 'botpw123' }), (e) => e.status === 401);
});

// A7: the privileged factory is createAccount — the ONLY place an admin can
// be minted. registerUser refuses the is_admin flag outright, so no future
// caller of the public path can escalate itself.
check('A7 registerUser cannot mint admins; createAccount can', () => {
  const db = fresh();
  assert.throws(
    () => A.registerUser(db, { username: 'boss', password: 'secret1', is_admin: 1 }),
    (e) => e.status === 400
  );
  const admin = A.createAccount(db, { username: 'boss', password: 'secret1', is_admin: 1, balance_cents: 1000000 });
  assert.strictEqual(admin.is_admin, true);
  assert.strictEqual(admin.balance_cents, 1000000);
  assert.strictEqual(admin.pass_hash, undefined);
  // duplicate usernames are 409 through the factory too
  assert.throws(() => A.createAccount(db, { username: 'boss', password: 'secret1' }), (e) => e.status === 409);
  // the money boundary holds for privileged creation as well
  assert.throws(() => A.createAccount(db, { username: 'frac', password: 'secret1', balance_cents: 500.5 }), (e) => e.status === 400);
  assert.throws(() => A.createAccount(db, { username: 'neg', password: 'secret1', balance_cents: -1 }), (e) => e.status === 400);
});

// A8: bot accounts keep working through the public path (lib/bots.js marks
// the house counterparty with is_bot; the flag must survive the split).
check('A8 is_bot survives the register/create split', () => {
  const db = fresh();
  const bot = A.createAccount(db, { username: 'HouseBot', password: 'botpw123', is_bot: 1, balance_cents: 100 });
  assert.strictEqual(bot.is_bot, true);
  const viaRegister = A.registerUser(db, { username: 'HouseBot2', password: 'botpw123', is_bot: 1 });
  assert.strictEqual(viaRegister.is_bot, true);
});

// A9: login accepts EITHER identifier. The username is matched as typed; the
// email is matched lowercased, because that is how it is stored.
check('A9 login by username or email', () => {
  const db = fresh();
  A.registerUser(db, { username: 'joel', password: 'secret1', email: 'Joel@Example.COM' });
  assert.strictEqual(A.loginUser(db, { username: 'joel', password: 'secret1' }).user.id > 0, true);
  assert.ok(A.loginUser(db, { identifier: 'joel@example.com', password: 'secret1' }).token);
  assert.ok(A.loginUser(db, { email: 'JOEL@EXAMPLE.COM', password: 'secret1' }).token);
  // A wrong password on a KNOWN email still fails, and reveals nothing extra.
  assert.throws(() => A.loginUser(db, { identifier: 'joel@example.com', password: 'nope' }), (e) => e.status === 401);
});

// A10: an address identifies at most one account, and a malformed one is refused.
check('A10 email validation and uniqueness', () => {
  const db = fresh();
  A.registerUser(db, { username: 'first', password: 'secret1', email: 'dup@example.com' });
  // Case-different spelling is the SAME identity, not a second account.
  assert.throws(() => A.registerUser(db, { username: 'second', password: 'secret1', email: 'DUP@example.com' }), (e) => e.status === 409);
  for (const bad of ['notanemail', 'a@b', 'a b@c.com', '@nope.com']) {
    assert.throws(() => A.registerUser(db, { username: 'x' + Math.random().toString(36).slice(2, 7), password: 'secret1', email: bad }), (e) => e.status === 400, bad);
  }
  // Omitting email entirely stays legal — most accounts have no address.
  assert.strictEqual(A.registerUser(db, { username: 'noaddress', password: 'secret1' }).email, null);
});

// A11: a suspended account cannot log in, and the refusal does not leak
// before the password is checked (a wrong password on a suspended account
// must still read as an ordinary 401, not a 403 that confirms it exists).
check('A11 suspension blocks login without leaking', () => {
  const db = fresh();
  const u = A.registerUser(db, { username: 'suspended', password: 'secret1' });
  db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(u.id);

  assert.throws(() => A.loginUser(db, { username: 'suspended', password: 'wrong' }), (e) => e.status === 401);
  assert.throws(() => A.loginUser(db, { username: 'suspended', password: 'secret1' }), (e) => e.status === 403);
  // Restoring the account restores access.
  db.prepare("UPDATE users SET status='active' WHERE id=?").run(u.id);
  assert.ok(A.loginUser(db, { username: 'suspended', password: 'secret1' }).token);
});

// A12: changing a password requires the current one, and revokes every OTHER
// session while leaving the caller's alive.
check('A12 change password revokes other sessions', () => {
  const db = fresh();
  const u = A.registerUser(db, { username: 'joel', password: 'secret1' });
  const mine = A.createSession(db, u.id);
  const theirs = A.createSession(db, u.id);

  assert.throws(
    () => A.changePassword(db, { userId: u.id, currentPassword: 'wrong', newPassword: 'secret2', keepToken: mine }),
    (e) => e.status === 401
  );
  assert.throws(
    () => A.changePassword(db, { userId: u.id, currentPassword: 'secret1', newPassword: 'secret1', keepToken: mine }),
    (e) => e.status === 400
  );
  assert.throws(
    () => A.changePassword(db, { userId: u.id, currentPassword: 'secret1', newPassword: 'short', keepToken: mine }),
    (e) => e.status === 400
  );

  const r = A.changePassword(db, { userId: u.id, currentPassword: 'secret1', newPassword: 'secret2', keepToken: mine });
  assert.strictEqual(r.sessionsRevoked, 1);
  assert.ok(A.sessionUser(db, mine), 'the caller keeps working');
  assert.strictEqual(A.sessionUser(db, theirs), null, 'the other session is dead');
  assert.ok(A.loginUser(db, { username: 'joel', password: 'secret2' }).token);
  assert.throws(() => A.loginUser(db, { username: 'joel', password: 'secret1' }), (e) => e.status === 401);
});

// A13: sessions are listed without exposing tokens, and a session id from
// another account can never be revoked.
check('A13 session listing and scoped revocation', () => {
  const db = fresh();
  const me = A.registerUser(db, { username: 'myself', password: 'secret1' });
  const other = A.registerUser(db, { username: 'other', password: 'secret1' });
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
check('A14 registerUser cannot mint roles', () => {
  const db = fresh();
  assert.throws(
    () => A.registerUser(db, { username: 'boss', password: 'secret1', role: 'admin' }),
    (e) => e.status === 400
  );
  const viaRole = A.createAccount(db, { username: 'boss', password: 'secret1', role: 'admin' });
  assert.strictEqual(viaRole.role, 'admin');
  assert.strictEqual(viaRole.is_admin, true, 'legacy mirror agrees');
  const plain = A.registerUser(db, { username: 'joel', password: 'secret1' });
  assert.strictEqual(plain.role, 'user');
});

// A15: the stored hash records its OWN cost, so raising SCRYPT_N is a one-line
// change that invalidates nothing — legacy hashes keep verifying and migrate
// to the current cost the moment their owner next proves the password.
// This suite deliberately does NOT pin SCRYPT_N; it runs at the real default.
check('A15 hash records its cost; legacy rehashes on login', () => {
  const db = fresh();
  const u = A.registerUser(db, { username: 'joel', password: 'secret1' });
  const stored = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(u.id).pass_hash;

  assert.strictEqual(stored.split('$').length, 4, 'a new hash records N');
  assert.strictEqual(Number(stored.split('$')[1]), config.SCRYPT_N);
  assert.strictEqual(A.needsRehash(stored), false, 'a current hash needs no migration');
  assert.strictEqual(A.verifyPassword('secret1', stored), true);
  assert.strictEqual(A.verifyPassword('wrong', stored), false);

  // A legacy 3-part hash, built exactly as the previous version wrote it.
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync('secret1', salt, 64, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const legacy = `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(legacy, u.id);

  assert.strictEqual(A.verifyPassword('secret1', legacy), true, 'legacy still verifies');
  assert.strictEqual(A.needsRehash(legacy), true);

  // The next successful login migrates it in place.
  assert.ok(A.loginUser(db, { username: 'joel', password: 'secret1' }).token);
  const after = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(u.id).pass_hash;
  assert.notStrictEqual(after, legacy, 'the hash was rewritten');
  assert.strictEqual(after.split('$').length, 4);
  assert.strictEqual(Number(after.split('$')[1]), config.SCRYPT_N);
  assert.strictEqual(A.needsRehash(after), false);
  assert.strictEqual(A.verifyPassword('secret1', after), true, 'the same password still works');
  assert.strictEqual(A.verifyPassword('wrong', after), false);

  // A FAILED login must not migrate anything — the password was never proven.
  const salt2 = crypto.randomBytes(16);
  const h2 = crypto.scryptSync('secret1', salt2, 64, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const legacy2 = `scrypt$${salt2.toString('hex')}$${h2.toString('hex')}`;
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(legacy2, u.id);
  assert.throws(() => A.loginUser(db, { username: 'joel', password: 'wrong' }), (e) => e.status === 401);
  assert.strictEqual(db.prepare('SELECT pass_hash FROM users WHERE id=?').get(u.id).pass_hash, legacy2, 'untouched');
});

// A16: a malformed or hostile stored value must fail closed, never throw out of
// verifyPassword — it is called from the login path and from dummyVerify.
check('A16 malformed stored hashes fail closed', () => {
  for (const bad of ['', 'null', 'scrypt', 'scrypt$', 'scrypt$$', 'bcrypt$a$b$c',
                     'scrypt$notanumber$salt$hash', 'scrypt$1$salt$hash', 'scrypt$16384$zz$zz']) {
    assert.strictEqual(A.verifyPassword('secret1', bad), false, JSON.stringify(bad));
    assert.doesNotThrow(() => A.verifyPassword('secret1', bad));
  }
  // A well-formed hash of the WRONG length must not blow up timingSafeEqual.
  const salt = crypto.randomBytes(16);
  const short = crypto.scryptSync('secret1', salt, 32, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  assert.strictEqual(A.verifyPassword('secret1', `scrypt$16384$${salt.toString('hex')}$${short.toString('hex')}`), false);
});

console.log(`\nauth.test.js: ${passed} checks passed`);
