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
const failures = [];
// Every check here is async (lib/auth.js derives password hashes off the event
// loop), and this harness used to call `fn()` WITHOUT awaiting it. So a
// `try/catch` around it caught nothing: a failing check reported "ok", the
// summary printed, and the rejection crashed the process afterwards with an
// unhandled error attributed to nothing. The suite still exited non-zero, so
// `npm test` went red — but the per-check line was a lie, and the summary
// counted checks that had not finished running.
//
// Checks are now COLLECTED and drained in order, which is what
// tests/risk.test.js and tests/admin.test.js already do. An eager runner is the
// other half of the same trap: it would report a passing check whose promise
// rejected later.
const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}

const GOOD = { appKey: 'TESTKEYnotreal12', username: 'test.bettfair-demo', password: 'not-a-real-password' };

async function venue() {
  const db = openStore(':memory:');
  const tenant = tenants.defaultTenant(db);
  const admin = (await auth.registerUser(db, { username: 'admin', password: 'pw-admin-1234', balance_cents: 0 }));
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
  return { db, tenant, admin };
}

// ── the cipher ───────────────────────────────────────────────────────────────

check('K1 a sealed envelope round-trips, and is version-tagged', async () => {
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

check('K2 the same plaintext seals differently every time (random IV)', async () => {
  const key = crypto.randomBytes(32);
  const seals = new Set(Array.from({ length: 50 }, () => FC.seal(key, 'same-secret')));
  assert.strictEqual(seals.size, 50, 'a fixed IV would make identical credentials comparable at rest');
});

check('K3 tampered ciphertext is REFUSED, not silently decrypted', async () => {
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

check('K4 the WRONG key is refused, and says so as an integrity failure', async () => {
  const env = FC.seal(crypto.randomBytes(32), 'secret');
  assert.throws(() => FC.open(crypto.randomBytes(32), env), (e) => /key may have changed/.test(e.message));
});

check('K5 an unrecognised envelope version is refused, not guessed at', async () => {
  const key = crypto.randomBytes(32);
  assert.throws(() => FC.open(key, 'v9:a:b:c'), (e) => /unrecognised format/.test(e.message));
  assert.throws(() => FC.open(key, 'not-an-envelope'), (e) => /unrecognised format/.test(e.message));
});

// ── refusing to store without a key ──────────────────────────────────────────

check('K6 with no encryption key, a credential is REFUSED and nothing is written', async () => {
  // The single most important behaviour here. The alternative — warn and store
  // plaintext — puts a Betfair password in a SQLite file beside player balances.
  const key = config.FEED_CREDENTIALS_KEY;
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/feedcreds')];
  const unconfigured = require('../lib/config');
  const savedKey = unconfigured.FEED_CREDENTIALS_KEY;
  unconfigured.FEED_CREDENTIALS_KEY = null;

  const { db, tenant, admin } = (await venue());
  const FC2 = require('../lib/feedcreds');
  try {
    assert.strictEqual(FC2.status(db, tenant.id).storage_available, false, 'status says storage is unavailable');
    assert.throws(
      () => FC2.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD }),
      (e) => e.status === 503 && /refused rather than stored in plaintext/.test(e.message)
    );
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM feed_credentials').get().c, 0, 'NOTHING was written');

    // #36. With no key configured, an UNKNOWN TENANT must still be a 404 and
    // not the 503. `requireKey()` used to run first, so the tenant lookup it
    // was supposed to precede never happened and this branch was unreachable —
    // while the sibling `clearCredentials` answered 404 for the same request.
    // Both halves of one API disagreed with each other.
    //
    // The order is also the contract: WHO you are asking about, before WHETHER
    // THE VENUE IS CONFIGURED to answer. An unknown tenant is a fact about the
    // request that holds regardless of configuration.
    assert.throws(
      () => FC2.setCredentials(db, { actor: admin, tenantId: 99999, ...GOOD }),
      (e) => e.status === 404 && /No such tenant/.test(e.message),
      'an unknown tenant is 404 even with no key configured — not masked by the 503'
    );
    // And the control: a KNOWN tenant with no key is still the 503, so the
    // check above cannot pass by refusing everything.
    assert.throws(
      () => FC2.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD }),
      (e) => e.status === 503,
      'a known tenant with no key is still the 503'
    );
  } finally {
    unconfigured.FEED_CREDENTIALS_KEY = savedKey;
    db.close();
  }
});

// #36, part 1: a deliberate 503 must actually REACH the client. `errorHandler`
// clamped every status >= 500 to 500 with a generic message, so this refusal —
// whose message contains the exact command that fixes it — arrived as
// `500 Internal error` and the remediation was logged and never delivered.
//
// The default must not move: a genuine FAULT still clamps and still says
// nothing. Both halves are asserted, because a fix that let every 5xx through
// would pass the first assertion and fail the second.
check('K6b a deliberate 503 reaches the client; a genuine fault still does not', async () => {
  const { errorHandler } = require('../server');
  const call = (err) => {
    let out = null;
    const res = {
      statusCode: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { out = { status: this.statusCode, body: b }; return this; },
    };
    errorHandler(err, { method: 'GET', path: '/x' }, res, () => {});
    return out;
  };

  // Opted in: status and message both survive.
  const deliberate = call(auth.serviceUnavailable('set FEED_CREDENTIALS_KEY (openssl rand -hex 32)'));
  assert.strictEqual(deliberate.status, 503, 'the deliberate 503 is not clamped');
  assert.match(deliberate.body.error, /FEED_CREDENTIALS_KEY/, 'and its remediation reaches the caller');

  // A plain httpError(503) is NOT opted in — the old call shape stays clamped,
  // so a module that does not know about this mechanism cannot leak by
  // accident.
  const plain = call(auth.httpError(503, 'something internal leaked'));
  assert.strictEqual(plain.status, 500, 'an un-marked 5xx is still clamped to 500');
  assert.strictEqual(plain.body.error, 'Internal error', 'and its message is still replaced');

  // A thrown fault carrying a path and a stack frame.
  const fault = call(Object.assign(new Error('SQLITE_ERROR at /home/venue/data/ob.db line 412'), { status: 500 }));
  assert.strictEqual(fault.status, 500);
  assert.strictEqual(fault.body.error, 'Internal error', 'a fault still leaks nothing');

  // And a 4xx is untouched by any of this.
  assert.strictEqual(call(auth.httpError(400, 'bad input')).status, 400);
  assert.strictEqual(call(auth.httpError(400, 'bad input')).body.error, 'bad input');
});

// ── what an API is allowed to return ─────────────────────────────────────────

check('K7 status() reveals WHICH fields exist and never their values', async () => {
  const { db, tenant, admin } = (await venue());
  const before = FC.status(db, tenant.id);
  assert.strictEqual(before.configured, false);

  FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
  const st = FC.status(db, tenant.id);
  const serialised = JSON.stringify(st);

  assert.strictEqual(st.configured, true);
  assert.strictEqual(st.app_key_set, true);
  assert.strictEqual(st.username_set, true);
  assert.strictEqual(st.password_set, true);

  for (const secret of [GOOD.appKey, GOOD.username, GOOD.password, 'TESTKEYno', 'not-a-real', 'bettfair-demo']) {
    assert.ok(!serialised.includes(secret), `status() leaked ${JSON.stringify(secret)}`);
  }
  // Not even a prefix of the app key: it is half of a credential pair.
  assert.ok(!('app_key' in st), 'no raw app_key field');
  assert.ok(!('password' in st), 'no raw password field');
  db.close();
});

check('K8 no exported function returns plaintext except forCollector()', async () => {
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

check('K9 stored credentials survive a REOPEN and decrypt correctly', async () => {
  // An in-memory database would not catch an envelope that only reads back in
  // the same process. This writes, closes, and reads from disk.
  const path = `/tmp/feedcreds-test-${process.pid}.db`;
  require('fs').rmSync(path, { force: true });
  let tenantId;
  try {
    const db = openStore(path);
    const t = tenants.defaultTenant(db);
    const admin = (await auth.registerUser(db, { username: 'admin', password: 'pw-admin-1234', balance_cents: 0 }));
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

check('K10 the raw database row does not contain the plaintext', async () => {
  // Belt and braces: even the column is ciphertext, so a `SELECT *` dump, a
  // backup file, or an over-broad admin query cannot leak it.
  const { db, tenant, admin } = (await venue());
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

check('K11 malformed credentials are refused with 400, not stored and failed later', async () => {
  const { db, tenant, admin } = (await venue());
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

check('K12 an unknown tenant is 404, and credentials are strictly per-tenant', async () => {
  const { db, tenant, admin } = (await venue());
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

check('K13 clearing removes the credential and says so', async () => {
  const { db, tenant, admin } = (await venue());
  FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
  const r = FC.clearCredentials(db, { actor: admin, tenantId: tenant.id });
  assert.strictEqual(r.cleared, true);
  assert.strictEqual(FC.status(db, tenant.id).configured, false);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM feed_credentials').get().c, 0);
  assert.throws(() => FC.clearCredentials(db, { actor: admin, tenantId: tenant.id }), (e) => e.status === 404);
  db.close();
});

// ── audit ────────────────────────────────────────────────────────────────────

check('K14 setting and clearing are AUDITED, and the trail holds no plaintext', async () => {
  // Removal is an event, not an absence: "who took the credential away" is the
  // first question asked after an incident.
  const { db, tenant, admin } = (await venue());
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

// K15 was `statusAll()` reports every tenant and leaks nothing. statusAll is
// GONE: a venue-wide feed inventory behind an `admin` role that carries no
// venue-wide meaning IS the disclosure half of #43. It told one operator that
// every other venue in the database had feed credentials, whether they were
// configured, and when they were last touched. The route stays and answers
// about the caller's own tenant.
check('K15 the venue-wide feed inventory is gone from the module surface', async () => {
  const exports = Object.keys(FC);
  assert.ok(!exports.includes('statusAll'), 'no statusAll() export');
  const src = Object.values(FC)
    .map((f) => f.toString())
    .join('\n');
  assert.ok(!/SELECT \* FROM tenants/.test(src), 'and nothing here enumerates tenants');
  // And the surviving status() still leaks nothing.
  const { db, tenant, admin } = (await venue());
  FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
  const serialised = JSON.stringify(FC.status(db, tenant.id));
  assert.ok(!serialised.includes(GOOD.password));
  assert.ok(!serialised.includes(GOOD.appKey));
  db.close();
});

// K16: THE TENANT BOUNDARY. `tenantId` used to be a plain parameter checked
// only for existence, and the route filled it from `:id` / `body.tenant_id` /
// `?tenant_id=`. requireAdmin checks only `role === 'admin'`, so any admin could
// overwrite, delete, enumerate or stop ANY tenant's Betfair credentials and
// collector — a cross-tenant write and a DoS on another venue's odds feed, with
// an audit row naming the attacker as the actor. No plaintext was reachable, so
// this is a write/disclosure failure, not credential exfiltration.
check('K16 an admin cannot touch another tenant feed credentials', async () => {
  const { db, tenant, admin } = (await venue());
  // A second venue, with its own admin and its own credentials.
  const other = db.prepare("INSERT INTO tenants (slug, name) VALUES ('other', 'Other')").run();
  const otherId = Number(other.lastInsertRowid);
  const otherAdmin = (await auth.registerUser(db, { username: 'otheradmin', password: 'pw-other-1234', balance_cents: 0 }));
  db.prepare("UPDATE users SET role='admin', tenant_id = ? WHERE id = ?").run(otherId, otherAdmin.id);
  // A row exists for the other tenant, written by its own admin.
  const stolen = { ...GOOD, username: 'other-venue-account', password: 'other-venue-password' };
  FC.setCredentials(db, { actor: otherAdmin, tenantId: otherId, ...stolen });

  // The default-tenant admin, naming the other tenant explicitly.
  const attacks = [
    () => FC.setCredentials(db, { actor: admin, tenantId: otherId, ...GOOD }),
    () => FC.clearCredentials(db, { actor: admin, tenantId: otherId }),
  ];
  for (const attack of attacks) {
    assert.throws(
      attack,
      (e) => e.status === 403,
      'a cross-tenant write is refused, not obeyed'
    );
  }
  // Nothing about the other tenant changed, and no audit row claims the
  // attacker did it.
  const row = db.prepare('SELECT * FROM feed_credentials WHERE tenant_id = ?').get(otherId);
  assert.strictEqual(FC.status(db, otherId).configured, true, 'the other tenant still has its credential');
  const env = FC.collectorEnv(db, otherId);
  assert.strictEqual(env.BETFAIR_USERNAME, stolen.username, 'and it is still THEIR account');
  assert.notStrictEqual(env.BETFAIR_USERNAME, GOOD.username, 'not the attacker\'s');
  const actors = db
    .prepare("SELECT actor_id FROM audit_log WHERE target = ?")
    .all(`tenant:${otherId}/feed_credentials`)
    .map((r) => r.actor_id);
  assert.ok(actors.every((a) => a === otherAdmin.id), 'no audit row attributes an action to the attacker');

  // And the attacker can still administer THEIR OWN tenant — the boundary is a
  // boundary, not a lockout.
  FC.setCredentials(db, { actor: admin, ...GOOD });
  assert.strictEqual(FC.status(db, tenant.id).configured, true, 'their own tenant still works');
  db.close();
});

// K17: the boundary is not enforced by the ROUTE. A caller that reaches this
// module directly — a job, a script, a future route — gets the same answer. An
// optional tenant scope is a scope someone will eventually forget to pass, and
// a forgotten scope on an admin route is a cross-tenant read.
check('K17 the tenant comes from the actor, not from the caller', async () => {
  const { db, tenant, admin } = (await venue());
  const other = db.prepare("INSERT INTO tenants (slug, name) VALUES ('other2', 'Other2')").run();
  const otherId = Number(other.lastInsertRowid);

  // No tenantId at all: it still lands on the actor's own tenant.
  FC.setCredentials(db, { actor: admin, ...GOOD });
  assert.strictEqual(FC.status(db, tenant.id).configured, true, 'the actor\'s tenant, with no hint supplied');
  // A matching tenantId is fine, so an existing caller is not broken.
  FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
  assert.strictEqual(FC.status(db, tenant.id).configured, true);
  // A mismatching one is refused rather than obeyed.
  assert.throws(() => FC.setCredentials(db, { actor: admin, tenantId: otherId, ...GOOD }), (e) => e.status === 403);
  assert.throws(() => FC.clearCredentials(db, { actor: admin, tenantId: otherId }), (e) => e.status === 403);
  // An unknown tenant is still a 404, which is the more accurate answer than a
  // 403 and does not confirm which ids exist to a caller probing them.
  assert.throws(() => FC.setCredentials(db, { actor: admin, tenantId: 99999, ...GOOD }), (e) => e.status === 404);
  db.close();
});

// K18: THE ENVELOPE IS BOUND TO ITS TENANT AND FIELD. GCM authenticates a
// ciphertext against a KEY and nothing else, so without associated data a row
// MOVED at the database level — by a restore, a migration, a bug, or anyone
// holding the database file, which is the threat model "encrypted at rest"
// actually claims — decrypted CLEANLY and was handed to the other tenant's
// collector as though that tenant had stored it.
//
// The route boundary cannot help here: it is not reachable over HTTP by
// definition. So the envelope names what it is, and any change fails the tag.
check('K18 a credential row MOVED to another tenant will not decrypt', async () => {
  const { db, tenant, admin } = (await venue());
  FC.setCredentials(db, { actor: admin, tenantId: tenant.id, ...GOOD });
  const moved = db.prepare("INSERT INTO tenants (slug, name) VALUES ('moved-to', 'Moved')").run();
  const movedId = Number(moved.lastInsertRowid);

  // The database-level attack: rewrite the primary key. No route, no API, no
  // role — just SQL, which is what a restore or a bug looks like.
  db.prepare('UPDATE feed_credentials SET tenant_id = ? WHERE tenant_id = ?').run(movedId, tenant.id);
  assert.throws(
    () => FC.collectorEnv(db, movedId),
    (e) => e.status === 500 && /could not be decrypted/.test(e.message),
    'the moved row is an integrity failure, not the new tenant\'s credential'
  );
  // And it did not hand over the secret either.
  let leaked = null;
  try { leaked = FC.collectorEnv(db, movedId); } catch { /* expected */ }
  assert.ok(!JSON.stringify(leaked).includes(GOOD.password), 'no plaintext escaped');

  // The same envelope bound to a different FIELD is also refused, so a
  // username cannot be replayed into the password column.
  const key = crypto.randomBytes(32);
  const sealed = FC.seal(key, 'a-betfair-password', FC.fieldAad(tenant.id, 'password'));
  assert.strictEqual(FC.open(key, sealed, FC.fieldAad(tenant.id, 'password')), 'a-betfair-password');
  assert.throws(() => FC.open(key, sealed, FC.fieldAad(tenant.id, 'username')), 'not under another field name');
  assert.throws(() => FC.open(key, sealed, FC.fieldAad(movedId, 'password')), 'nor another tenant');
  assert.throws(() => FC.open(key, sealed, 'feedcreds.v2|t=1|f=password'), 'nor another schema version');

  // The genuine article still round-trips: binding must not break the operator.
  db.prepare('UPDATE feed_credentials SET tenant_id = ? WHERE tenant_id = ?').run(tenant.id, movedId);
  const env = FC.collectorEnv(db, tenant.id);
  assert.strictEqual(env.BETFAIR_PASSWORD, GOOD.password, 'the real credential is unaffected');
  db.close();
});

(async () => {
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
  console.log(`\nfeedcreds.test.js: ${passed} checks passed`);
  if (passed < 18) { console.error('expected 18 checks'); process.exit(1); }
  if (failures.length) {
    console.error(`failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
})();