// auth.test.js — scrypt hashing, registration, sessions (PLAN "Auth").
// Run: node tests/auth.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
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

console.log(`\nauth.test.js: ${passed} checks passed`);
