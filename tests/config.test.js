// config.test.js — env validation, loopback-only binding, path resolution.
// Run: node tests/config.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const path = require('path');
const { loadConfig } = require('../lib/config');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };
const load = (over) => loadConfig('/nonexistent/.env', over);

// C1: defaults.
check('C1 defaults', () => {
  const c = load();
  assert.strictEqual(c.PORT, 7777);
  assert.strictEqual(c.HOST, '127.0.0.1');
  assert.strictEqual(c.COMMISSION_RATE, 0.025);
  assert.strictEqual(c.MIN_STAKE_CENTS, 100);
  assert.strictEqual(c.MAX_STAKE_CENTS, 100000);
  assert.strictEqual(c.DRIFT_ENABLED, true);
});

// C2: loopback-only binding — a routable interface must abort the launch.
check('C2 loopback-only HOST', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.strictEqual(load({ HOST: host }).HOST, host);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
    assert.throws(() => load({ HOST: host }), /HOST must be a loopback address/);
  }
  // An empty HOST is not an exposure: it falls back to the loopback default.
  assert.strictEqual(load({ HOST: '' }).HOST, '127.0.0.1');
  assert.strictEqual(load({ HOST: '   ' }).HOST, '127.0.0.1');
});

// C3: numeric ranges abort with a clear message instead of failing later.
check('C3 numeric validation', () => {
  assert.throws(() => load({ PORT: 'abc' }), /PORT must be an integer/);
  assert.throws(() => load({ PORT: 0 }), /PORT must be an integer/);
  assert.throws(() => load({ PORT: 70000 }), /PORT must be an integer/);
  assert.throws(() => load({ COMMISSION_RATE: 0.5 }), /COMMISSION_RATE/);
  assert.throws(() => load({ COMMISSION_RATE: -0.1 }), /COMMISSION_RATE/);
  assert.throws(() => load({ MIN_STAKE_CENTS: 500, MAX_STAKE_CENTS: 100 }), /MAX_STAKE_CENTS/);
  assert.throws(() => load({ SESSION_TTL_DAYS: 0 }), /SESSION_TTL_DAYS/);
  assert.throws(() => load({ DRIFT_INTERVAL_MS: 10 }), /DRIFT_INTERVAL_MS/);
});

// C3b: SCRYPT_N is bounded BELOW for a reason — scrypt's cost is exponential in
// N, so SCRYPT_N=2 would make every password trivially crackable while still
// looking correctly formatted. The floor is the cost the pre-2.4 hashes used,
// so any value at or above it is a strict improvement over what is stored.
check('C3b SCRYPT_N floor and default', () => {
  assert.strictEqual(load({}).SCRYPT_N, 65536, 'OWASP floor is the default');
  assert.strictEqual(load({ SCRYPT_N: 16384 }).SCRYPT_N, 16384);
  assert.strictEqual(load({ SCRYPT_N: 262144 }).SCRYPT_N, 262144);
  for (const bad of [2, 1024, 16383, 1048577, 'abc', 1.5, -65536]) {
    assert.throws(() => load({ SCRYPT_N: bad }), /SCRYPT_N/, String(bad));
  }
});

// C4: booleans accept only real booleans / 'true' / 'false'.
check('C4 boolean validation', () => {
  assert.strictEqual(load({ DRIFT_ENABLED: 'false' }).DRIFT_ENABLED, false);
  assert.strictEqual(load({ BOT_ENABLED: 'true' }).BOT_ENABLED, true);
  assert.strictEqual(load({ BOT_ENABLED: false }).BOT_ENABLED, false);
  assert.throws(() => load({ DRIFT_ENABLED: 'yes' }), /DRIFT_ENABLED/);
  assert.throws(() => load({ BOT_ENABLED: 1 }), /BOT_ENABLED/);
});

// C5: DB_PATH resolves against the project root; ':memory:' stays special.
check('C5 DB_PATH resolution', () => {
  assert.ok(load({ DB_PATH: ':memory:' }).DB_PATH === ':memory:');
  const c = load({ DB_PATH: 'data/x.db' });
  // Derived from THIS repository's own location rather than a hardcoded folder
  // name. The assertion used to be `endsWith('/OpenBettingExchange/data/x.db')`,
  // which passes only because CI happens to check out into a directory of that
  // name — so it failed for anyone who cloned the project under a different one,
  // and passed for the wrong reason in the place it mattered most.
  const repoRoot = path.resolve(__dirname, '..');
  assert.strictEqual(c.DB_PATH, path.join(repoRoot, 'data', 'x.db'), c.DB_PATH);
  const abs = load({ DB_PATH: '/tmp/abs.db' });
  assert.strictEqual(abs.DB_PATH, '/tmp/abs.db');
});

// C6: seeded-credential overrides pass through verbatim — no trimming, no
// charset policy (a password is whatever the operator says it is);
// unset or empty → null, meaning "use the seeded demo defaults".
check('C6 ADMIN_PASSWORD / DEMO_PASSWORD passthrough', () => {
  assert.strictEqual(load().ADMIN_PASSWORD, null);
  assert.strictEqual(load().DEMO_PASSWORD, null);
  assert.strictEqual(load({ ADMIN_PASSWORD: 'hunter2' }).ADMIN_PASSWORD, 'hunter2');
  assert.strictEqual(load({ DEMO_PASSWORD: ' demo pw ' }).DEMO_PASSWORD, ' demo pw ');
  assert.strictEqual(load({ ADMIN_PASSWORD: '' }).ADMIN_PASSWORD, null);
  assert.strictEqual(load({ DEMO_PASSWORD: 'x', ADMIN_PASSWORD: 'y' }).DEMO_PASSWORD, 'x');
  // values from a .env file arrive as strings; keep non-strings stringified
  assert.strictEqual(load({ ADMIN_PASSWORD: 12345 }).ADMIN_PASSWORD, '12345');
  assert.strictEqual(load({ ADMIN_PASSWORD: null }).ADMIN_PASSWORD, null);
});

console.log(`\nconfig.test.js: ${passed} checks passed`);
