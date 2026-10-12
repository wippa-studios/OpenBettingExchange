// tests/feedcreds.test.js — the encrypted Betfair credential store.
//
// Run: node tests/feedcreds.test.js
//
// These are the most sensitive tests in the suite: the module under test holds
// a real Betfair account password. What is asserted is therefore mostly about
// what must NOT happen — nothing readable, nothing logged, nothing returned by
// an API — because those are the failures that are invisible until an incident.

'use strict';
process.env.SCRYPT_N = process.env.SCRYPT_N || '16384';

const crypto = require('crypto');
const assert = require('assert');

const KEY = crypto.randomBytes(32).toString('hex');
process.env.FEED_CREDENTIALS_KEY = KEY;

const { openStore } = require('../lib/store');
const auth = require('../lib/auth');
const tenants = require('../lib/tenants');
const config = require('../lib/config');
const FC = require('../lib/feedcreds');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok', name);
  } catch (e) {
    console.error('  FAIL', name);
    console.error('       ', e.message);
    process.exitCode = 1;
  }
}

const GOOD = { appKey: 'eldno0TOrTIbJozT', username: 'JSIrwin', password: 'Skullman2540' };

function venue() {
  const db = openStore(':memory:');
  const tenant = tenants.defaultTenant(db);
  const admin = auth.registerUser(db, { username: 'admin', password: 'pw-admin-1234', balance_cents: 0 });
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
  return { db, tenant, admin };
}

// ── the cipher ───────────────────────────────────────────────────────────────

check('K1 a sealed envelope round-trips, and is version-tagged', () => {
  const key = crypto.randomBytes(32);
  for (const value of ['', 'a', 'hunter2', 'pässwörd-ü-漢字', 'x'.repeat(4096)]) {
    const env = FC.seal(key, value);
    // The ciphertext segment is [^:]* not [^:]+ : sealing '' legitimately
    // produces an empty ciphertext, and the envelope must still parse. The API
    // layer refuses an empty password separately (K11); the cipher itself is
    // not in the business of deciding what a valid secret looks like.
    assert.match(env, /^v1:[^:]+:[^:]+:[^:]*$/, `envelope shape for ${JSON.stringify(value.slice(0, 12))}`);
    assert.strictEqual(FC.open(key, env), value, `round-trip for ${JSON.stringify(value.slice(0, 12))}`);
  }
});

check('K2 the same plaintext seals differently every time (random IV)', () => {
  const key = crypto.randomBytes(32);
  const seals = new Set(Array.from({ length: 50 }, () => FC.seal(key, 'same-secret')));
  assert.strictEqual(seals.size, 50, 'a fixed IV would make identical credentials comparable at rest');
});

check('K3 tampered ciphertext is REFUSED, not silently decrypted', () => {
  // GCM's whole point. A database edit that changes a credential must fail
  // loudly; returning plausible garbage would let a modified password be
  // presented as the real one.
  const key = crypto.randomBytes(32);
  const env = FC.seal(key, 'the-real-password');
  const parts = env.split(':');
  const ct = Buffer.from(parts[3], 'base64');
  ct[0] ^= 0xff;
  parts[3] = ct.toString('base64');
  assert.throws(() => FC.open(key, parts.join(':')), (e) => e.status === 500);
});

check('K4 the WRONG key is refused, and says so as an integrity failure', () => {
  const env = FC.seal(crypto.randomBytes(32), 'secret');
  assert.throws(() => FC.open(crypto.randomBytes(32), env), (e) => /key may have changed/.test(e.message));
});

check('K5 an unrecognised envelope version is refused, not guessed at', () => {
  const key = crypto.randomBytes(32);
  assert.throws(() => FC.open(key, 'v9:a:b:c'), (e) => /unrecognised format/.test(e.message));
  assert.throws(() => FC.open(key, 'not-an-envelope'), (e) => /unrecognised format/.test(e.message));
});

// ── refusing to store without a key ──────────────────────────────────────────

check('K6 with no encryption key, a credential is REFUSED and nothing is written', () => {
  // The single most important behaviour here. The alternative — warn and store
  // plaintext — puts a Betfair password in a SQLite file beside player balances.
  const key = config.FEED_CREDENTIALS_KEY;
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/feedcreds')];
  const unconfigured = require('../lib/config');
  const savedKey = unconfigured.FEED_CREDENTIALS_KEY;
  unconfigured.FEED_CREDENTIALS_KEY = null;

  const { db, tenant, admin } = venue();
  const FC2 = require('../lib/feedcreds');
  try {
    assert.strictEqual(FC2.status(db, tenant.id).storage_available, false, 'status says storage is unavailable');
    assert.throws(
      () => FC2.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD }),
      (e) => e.status === 503 && /refused rather than stored in plaintext/.test(e.message)
    );
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM feed_credentials').get().c, 0, 'NOTHING was written');
  } finally {
    unconfigured.FEED_CREDENTIALS_KEY = savedKey;
    db.close();
  }
});

// ── what an API is allowed to return ─────────────────────────────────────────

check('K7 status() reveals WHICH fields exist and never their values', () => {
  const { db, tenant, admin } = venue();
  const before = FC.status(db, tenant.id);
  assert.strictEqual(before.configured, false);

  FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
  const st = FC.status(db, tenant.id);
  const serialised = JSON.stringify(st);

  assert.strictEqual(st.configured, true);
  assert.strictEqual(st.app_key_set, true);
  assert.strictEqual(st.username_set, true);
  assert.strictEqual(st.password_set, true);

  for (const secret of [GOOD.appKey, GOOD.username, GOOD.password, 'eldno0', 'Skullman', 'JSIrwin']) {
    assert.ok(!serialised.includes(secret), `status() leaked ${JSON.stringify(secret)}`);
  }
  // Not even a prefix of the app key: it is half of a credential pair.
  assert.ok(!('app_key' in st), 'no raw app_key field');
  assert.ok(!('password' in st), 'no raw password field');
  db.close();
});

check('K8 no exported function returns plaintext except forCollector()', () => {
  // The module's shape is the control. A future "reveal the password" route
  // would have to call forCollector or add an export; this makes adding one a
  // deliberate act rather than a convenience.
  const exports = Object.keys(FC);
  const plaintextCapable = new Set(['open', 'forCollector', 'collectorEnv']);
  for (const name of exports) {
    const src = FC[name].toString();
    const returnsOpen = /return\s+open\(/.test(src) || /\bopen\(key/.test(src);
    if (returnsOpen) assert.ok(plaintextCapable.has(name), `${name}() returns plaintext and must be deliberate`);
  }
  assert.ok(!exports.includes('reveal'), 'no reveal() export');
  assert.ok(!exports.includes('getPassword'), 'no getPassword() export');
});

// ── round trip through storage ───────────────────────────────────────────────

check('K9 stored credentials survive a REOPEN and decrypt correctly', () => {
  // An in-memory database would not catch an envelope that only reads back in
  // the same process. This writes, closes, and reads from disk.
  const path = `/tmp/feedcreds-test-${process.pid}.db`;
  require('fs').rmSync(path, { force: true });
  let tenantId;
  try {
    const db = openStore(path);
    const t = tenants.defaultTenant(db);
    const admin = auth.registerUser(db, { username: 'admin', password: 'pw-admin-1234', balance_cents: 0 });
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
    FC.setCredentials(db, { actor: admin, tenantId: t.id, ...GOOD });
    tenantId = t.id;
    db.close();

    const again = openStore(path);
    const env = FC.collectorEnv(again, tenantId);
    assert.ok(env, 'credentials still present after reopen');
    assert.strictEqual(env.BETFAIR_APP_KEY, GOOD.appKey);
    assert.strictEqual(env.BETFAIR_USERNAME, GOOD.username);
    assert.strictEqual(env.BETFAIR_PASSWORD, GOOD.password);
    assert.strictEqual(env.BETFAIR_LOGIN_MODE, 'password');
    again.close();
  } finally {
    require('fs').rmSync(path, { force: true });
  }
});

check('K10 the raw database row does not contain the plaintext', () => {
  // Belt and braces: even the column is ciphertext, so a `SELECT *` dump, a
  // backup file, or an over-broad admin query cannot leak it.
  const { db, tenant, admin } = venue();
  FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
  const row = db.prepare('SELECT * FROM feed_credentials WHERE tenant_id = ?').get(tenant.id);
  const serialised = JSON.stringify(row);
  assert.ok(!serialised.includes(GOOD.password), 'the password is not in the row');
  assert.ok(!serialised.includes(GOOD.appKey), 'the app key is not in the row');
  assert.ok(!serialised.includes(GOOD.username), 'the username is not in the row');
  assert.match(row.password, /^v1:/, 'and it is an envelope');
  db.close();
});

// ── input validation ─────────────────────────────────────────────────────────

check('K11 malformed credentials are refused with 400, not stored and failed later', () => {
  const { db, tenant, admin } = venue();
  const cases = [
    [{ ...GOOD, appKey: 'too-short' }, /16-character/],
    [{ ...GOOD, appKey: '' }, /16-character/],
    [{ ...GOOD, appKey: 'has spaces in it!!' }, /16-character/],
    [{ ...GOOD, username: 'has space' }, /username looks wrong/],
    [{ ...GOOD, username: 'x' }, /username looks wrong/],
    [{ ...GOOD, password: '' }, /password is required/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(
      () => FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...input }),
      (e) => e.status === 400 && pattern.test(e.message),
      `should refuse ${JSON.stringify(input).slice(0, 70)}`
    );
  }
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM feed_credentials').get().c, 0, 'nothing stored');
  db.close();
});

check('K12 an unknown tenant is 404, and credentials are strictly per-tenant', () => {
  const { db, tenant, admin } = venue();
  assert.throws(
    () => FC.setCredentials(db, { actor: admin, tenantId: 99999, ...GOOD }),
    (e) => e.status === 404,
    'an unknown tenant is refused'
  );
  FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });

  // A second tenant must see nothing of the first one's credential. Two venues
  // sharing one Betfair login would share one rate limit and one blast radius.
  const other = db.prepare("INSERT INTO tenants (slug, name) VALUES ('other', 'Other')").run();
  const otherId = Number(other.lastInsertRowid);
  assert.strictEqual(FC.status(db, tenant.id).configured, true, 'the owning tenant is configured');
  assert.strictEqual(FC.status(db, otherId).configured, false, "another tenant's feed is NOT configured");
  assert.strictEqual(FC.collectorEnv(db, otherId), null, 'and has no credential to hand the collector');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM feed_credentials').get().c, 1, 'exactly one row');
  db.close();
});

// ── clearing ─────────────────────────────────────────────────────────────────

check('K13 clearing removes the credential and says so', () => {
  const { db, tenant, admin } = venue();
  FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
  const r = FC.clearCredentials(db, { actor: admin, tenantId: tenant.id });
  assert.strictEqual(r.cleared, true);
  assert.strictEqual(FC.status(db, tenant.id).configured, false);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM feed_credentials').get().c, 0);
  assert.throws(() => FC.clearCredentials(db, { actor: admin, tenantId: tenant.id }), (e) => e.status === 404);
  db.close();
});

// ── audit ────────────────────────────────────────────────────────────────────

check('K14 setting and clearing are AUDITED, and the trail holds no plaintext', () => {
  // Removal is an event, not an absence: "who took the credential away" is the
  // first question asked after an incident.
  const { db, tenant, admin } = venue();
  FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
  FC.clearCredentials(db, { actor: admin, tenantId: tenant.id });
  const rows = db
    .prepare("SELECT * FROM audit_log WHERE target LIKE 'tenant:%/feed_credentials' ORDER BY id")
    .all();
  assert.ok(rows.length >= 2, `expected set + clear in the audit log, got ${rows.length}`);
  const trail = JSON.stringify(rows);
  assert.ok(!trail.includes(GOOD.password), 'the audit trail holds no password');
  assert.ok(!trail.includes(GOOD.appKey), 'the audit trail holds no app key');
  assert.ok(trail.includes('[sealed]'), 'it records that sealed values were set');
  db.close();
});

check('K15 statusAll() reports every tenant and leaks nothing', () => {
  const { db, tenant, admin } = venue();
  FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
  const all = FC.statusAll(db);
  assert.ok(Array.isArray(all) && all.length >= 1);
  const serialised = JSON.stringify(all);
  assert.ok(!serialised.includes(GOOD.password));
  assert.ok(!serialised.includes(GOOD.appKey));
  db.close();
});

console.log(`\nfeedcreds.test.js: ${passed} checks passed`);
if (passed < 15) { console.error('expected 15 checks'); process.exit(1); }