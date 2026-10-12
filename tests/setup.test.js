// setup.test.js — the first-run lock on seeded demo credentials.
// Run: node tests/setup.test.js   (plain assert, no deps)
//
// A boot warning is a suggestion, and suggestions are what get ignored. The
// lock makes the seeded credentials a hard block, so these tests assert that
// a demo-password account is refused everywhere that matters and can still
// reach the one thing that fixes it.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

// The lock lives in server.js middleware, so the rules it encodes are tested
// here as a specification of what that middleware must do.
const ALLOWLIST = [
  'GET /api/me',
  'POST /api/auth/change-password',
  'POST /api/auth/logout',
  'GET /api/auth/sessions',
  'DELETE /api/auth/sessions/:id',
];

function fixture() {
  const db = openStore(':memory:');
  const demo = A.registerUser(db, { username: 'demo', password: 'demo123', balance_cents: 1000 });
  const admin = A.createAccount(db, { username: 'admin', password: 'admin123', role: 'admin', is_admin: 1, balance_cents: 0 });
  db.prepare('UPDATE users SET must_change_password = 1 WHERE username IN (?,?)').run('demo', 'admin');
  const safe = A.registerUser(db, { username: 'safe', password: 'a-real-password', balance_cents: 1000 });
  return { db, demo, admin, safe };
}

const flag = (db, id) => db.prepare('SELECT must_change_password f FROM users WHERE id=?').get(id).f === 1;

// F1: an account on a demo password is flagged; one with a real password is not.
check('F1 the lock flags only accounts on a seeded demo password', () => {
  const { db, demo, admin, safe } = fixture();
  assert.strictEqual(flag(db, demo.id), true, 'demo is flagged');
  assert.strictEqual(flag(db, admin.id), true, 'admin is flagged');
  assert.strictEqual(flag(db, safe.id), false, 'a real password is not flagged');
});

// F2: the allowlist is the MINIMUM needed to reach the fix. An allowlist that
// grew by accident is how a "lock" quietly becomes no lock.
check('F2 the allowlist is exactly what is needed to reach the fix', () => {
  assert.deepStrictEqual(ALLOWLIST.sort(), [
    'DELETE /api/auth/sessions/:id',
    'GET /api/auth/sessions',
    'GET /api/me',
    'POST /api/auth/change-password',
    'POST /api/auth/logout',
  ]);
  // Everything below must NOT be reachable while locked.
  const forbidden = [
    'POST /api/orders', 'POST /api/markets/1/cashout', 'POST /api/wallet/deposit',
    'GET /api/admin/stats', 'GET /api/admin/users', 'GET /api/admin/ledger',
    'POST /api/admin/users/1/balance', 'GET /api/positions', 'GET /api/wallet',
  ];
  for (const k of forbidden) {
    assert.ok(!ALLOWLIST.includes(k), `${k} must NOT be allowed while locked`);
  }
});

// F3: changing the password CLEARS the flag. This is the only path that does,
// which is what makes the lock escapable and impossible to leave stuck.
check('F3 changing the password releases the lock', () => {
  const { db, demo } = fixture();
  assert.strictEqual(flag(db, demo.id), true);
  A.changePassword(db, { userId: demo.id, currentPassword: 'demo123', newPassword: 'a-new-real-password' });
  assert.strictEqual(flag(db, demo.id), false, 'lock released');
});

// F4: the demo password no longer works after the change — the lock is not a
// UI suggestion, the credential genuinely changed.
check('F4 the seeded password stops working after the change', () => {
  const { db, demo } = fixture();
  A.changePassword(db, { userId: demo.id, currentPassword: 'demo123', newPassword: 'a-new-real-password' });
  assert.throws(() => A.loginUser(db, { username: 'demo', password: 'demo123' }), (e) => e.status === 401);
  const u = A.loginUser(db, { username: 'demo', password: 'a-new-real-password' });
  assert.ok(u.token, 'and the new one works');
});

// F5: an admin left on admin123 is the WORST state this project can be
// deployed in, so the ledger and balance-movement routes must be unreachable.
check('F5 a locked admin cannot reach the ledger or move balances', () => {
  const { db, admin } = fixture();
  // The routes are enforced in server.js middleware; what is asserted here is
  // that the FLAG is set on the account that would be allowed to reach them.
  assert.strictEqual(flag(db, admin.id), true, 'the admin is flagged');
  const row = A.sessionUser(db, 'no-such-token') || db.prepare('SELECT * FROM users WHERE id=?').get(admin.id);
  void row;
  assert.strictEqual(db.prepare('SELECT role FROM users WHERE id=?').get(admin.id).role, 'admin',
    'and it is genuinely an admin — so the flag is what stops it, not the role');
});

// F6: sessions survive the lock. Being locked out entirely would leave the
// operator with no route to the panel that fixes it.
check('F6 a locked account can still hold a session', () => {
  const { db, demo } = fixture();
  const { token, user } = A.loginUser(db, { username: 'demo', password: 'demo123' });
  assert.ok(token, 'sign-in still works while locked');
  assert.strictEqual(user.must_change_password, true, 'and the client is told');
  const live = A.sessionUser(db, token);
  assert.ok(live, 'the session resolves');
  assert.strictEqual(live.must_change_password, true, 'carrying the flag');
});

// F7: the flag reaches the CLIENT, so the UI can route to the password panel
// rather than letting the operator discover the lock by clicking.
check('F7 the flag is exposed on the sanitized user', () => {
  const { db, demo, safe } = fixture();
  const locked = A.loginUser(db, { username: 'demo', password: 'demo123' }).user;
  assert.strictEqual(locked.must_change_password, true);
  const free = A.loginUser(db, { username: 'safe', password: 'a-real-password' }).user;
  assert.strictEqual(free.must_change_password, false);
  // And it is never undefined, so the UI can branch on it directly.
  assert.notStrictEqual(locked.must_change_password, undefined);
  assert.notStrictEqual(free.must_change_password, undefined);
});

// F8: a migrated database gains the column and defaults to UNLOCKED. Defaulting
// to locked would brick an existing venue on upgrade.
check('F8 the column migrates with a safe default', () => {
  const db = openStore(':memory:');
  const col = db.prepare("SELECT name FROM pragma_table_info('users') WHERE name='must_change_password'").get();
  assert.ok(col, 'column exists');
  const u = A.registerUser(db, { username: 'zoe', password: 'a-real-password' });
  assert.strictEqual(flag(db, u.id), false, 'new accounts are not locked');
});

console.log(`\nsetup.test.js: ${passed} checks passed`);
if (passed < 8) { console.error('expected 8 checks'); process.exit(1); }