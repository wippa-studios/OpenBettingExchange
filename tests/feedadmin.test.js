// tests/feedadmin.test.js — the admin feed credential + supervisor API,
// over real HTTP.
//
// Run: node tests/feedadmin.test.js
//
// The module-level tests (feedcreds, feedrunner) prove the storage and the
// supervisor work. This file proves the HTTP surface: that a non-admin cannot
// reach it, that the three fields the collector needs are the three fields it
// takes, and that nothing on any route — including the error responses — ever
// carries a credential back to the caller.

'use strict';

process.env.SCRYPT_N = process.env.SCRYPT_N || '16384';
process.env.DB_PATH = ':memory:';
process.env.DRIFT_ENABLED = 'false';
process.env.BOT_ENABLED = 'false';
process.env.FEED_CREDENTIALS_KEY = require('crypto').randomBytes(32).toString('hex');
// Pinned explicitly rather than inherited. lib/config.js loads the repo's .env
// and lets process.env win, so without this a developer whose .env has
// FEED_ENABLED=true would see A7 and A8 fail for a reason that has nothing to
// do with this code — and worse, FEED_ENABLED=true with no FEED_DATABASE_URL
// aborts at boot, so the whole suite would vanish.
process.env.FEED_ENABLED = 'false';
process.env.FEED_RUNNER_ENABLED = 'false';
process.env.FEED_DATABASE_URL = '';

const assert = require('assert');
const srv = require('../server');

let passed = 0;
const failures = [];
const check = async (name, fn) => {
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
};

const GOOD = { app_key: 'TESTKEYnotreal12', username: 'test.bettfair-demo', password: 'not-a-real-password' };
const TENANT = '/api/admin/feed';

async function main() {
  const server = srv.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const j = async (method, path, { body, cookie } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    let json = null;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text, setCookie };
  };
  const cookieOf = (r) => (r.setCookie.find((c) => c.startsWith('ob_session=')) || '').split(';')[0];

  // Three users: an admin, a player, and a second admin for the audit trail.
  const mk = async (username, role) => {
    const r = await j('POST', '/api/auth/register', { body: { username, password: 'pw-test-1234' } });
    assert.ok(r.status === 200 || r.status === 201, `register ${username} -> ${r.status} ${r.text.slice(0, 120)}`);
    const id = r.json.user.id;
    if (role) srv.db.prepare(`UPDATE users SET role='${role}' WHERE id=?`).run(id);
    return { id, cookie: cookieOf(r), username };
  };

  const admin = await mk('admin1', 'admin');
  const player = await mk('player1', null);

  // ── authorisation ──────────────────────────────────────────────────────────

  await check('A1 the credential routes are admin-only', async () => {
    for (const [method, path] of [
      ['GET', `${TENANT}/credentials`],
      ['GET', `${TENANT}/credentials/1`],
      ['PUT', `${TENANT}/credentials/1`],
      ['DELETE', `${TENANT}/credentials/1`],
      ['GET', `${TENANT}/runner/1`],
      ['POST', `${TENANT}/runner/start`],
      ['POST', `${TENANT}/runner/stop`],
    ]) {
      const anon = await j(method, path, { body: method === 'PUT' ? GOOD : undefined });
      assert.ok(anon.status === 401 || anon.status === 403, `${method} ${path} unauthenticated -> ${anon.status}, expected 401/403`);

      const asPlayer = await j(method, path, { cookie: player.cookie, body: method === 'PUT' ? GOOD : undefined });
      assert.ok(
        asPlayer.status === 401 || asPlayer.status === 403,
        `${method} ${path} as a player -> ${asPlayer.status}, expected 401/403 (a player must not read or set Betfair credentials)`
      );
    }
  });

  // ── status before anything is stored ───────────────────────────────────────

  await check('A2 status before storing says configured:false, and never a field value', async () => {
    const r = await j('GET', `${TENANT}/credentials/1`, { cookie: admin.cookie });
    assert.strictEqual(r.status, 200, r.text.slice(0, 120));
    assert.strictEqual(r.json.configured, false);
    assert.strictEqual(r.json.storage_available, true, 'the encryption key IS configured here');
    for (const secret of Object.values(GOOD)) {
      assert.ok(!r.text.includes(secret), `leaked ${secret}`);
    }
  });

  await check('A3 the list endpoint reports the caller\'s OWN tenant only, and no secrets', async () => {
    // It used to answer for EVERY tenant: each venue's configured flag, login
    // mode and created/updated timestamps. Behind an `admin` role that carries
    // no venue-wide meaning, that told one operator that every other venue in
    // the database had feed credentials, whether, and when they were touched.
    //
    // A second tenant exists HERE, so "exactly one" is a real assertion rather
    // than a tautology about a database that only has one venue in it. A13
    // then checks what that second tenant holds is still not disclosed.
    srv.db.prepare("INSERT INTO tenants (slug, name) VALUES ('listing-probe', 'Listing Probe')").run();
    const r = await j('GET', `${TENANT}/credentials`, { cookie: admin.cookie });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.tenants) && r.json.tenants.length >= 1);
    assert.strictEqual(r.json.tenants.length, 1, 'one tenant, and it is the caller\'s own');
    assert.strictEqual(
      r.json.tenants[0].tenant_id,
      srv.db.prepare('SELECT id FROM tenants WHERE slug = ?').get('default').id,
      'specifically the caller\'s'
    );
    for (const secret of Object.values(GOOD)) assert.ok(!r.text.includes(secret));
  });

  // ── storing ────────────────────────────────────────────────────────────────

  await check('A4 storing takes exactly app_key + username + password, and returns no secret', async () => {
    const r = await j('PUT', `${TENANT}/credentials/1`, { cookie: admin.cookie, body: GOOD });
    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    assert.strictEqual(r.json.configured, true);
    assert.strictEqual(r.json.app_key_set, true);
    assert.strictEqual(r.json.username_set, true);
    assert.strictEqual(r.json.password_set, true);
    // The response must not be a place a credential can be read back out of.
    for (const secret of Object.values(GOOD)) {
      assert.ok(!r.text.includes(secret), `PUT response leaked ${secret}`);
    }
    // And no field capable of holding one.
    for (const field of ['app_key', 'username', 'password']) {
      assert.ok(!(field in r.json), `response carries a raw ${field} field`);
    }
  });

  await check('A5 malformed input is 400 with a usable message, and stores nothing', async () => {
    const cases = [
      [{ ...GOOD, app_key: 'short' }, /16-character/],
      [{ ...GOOD, username: 'has space' }, /username/],
      [{ ...GOOD, password: '' }, /password is required/],
      [{ username: 'u', password: 'p' }, /app_key/],
    ];
    // Tenant 1, not 2: only the default tenant exists in this in-memory
    // database, and the tenant check runs BEFORE validation, so a nonexistent
    // tenant would answer 404 and this suite would prove nothing about
    // validation at all.
    for (const [body, pattern] of cases) {
      const r = await j('PUT', `${TENANT}/credentials/1`, { cookie: admin.cookie, body });
      assert.strictEqual(r.status, 400, `${JSON.stringify(body).slice(0, 60)} -> ${r.status} ${r.text.slice(0, 100)}`);
      assert.match(r.json.error, pattern, 'the message names the offending field');
      for (const secret of Object.values(GOOD)) assert.ok(!r.text.includes(secret));
    }
    // The credential stored by A4 must be intact: a rejected write must not
    // partially overwrite a good one.
    const st = await j('GET', `${TENANT}/credentials/1`, { cookie: admin.cookie });
    assert.strictEqual(st.json.configured, true, 'the earlier good credential survived');
    assert.strictEqual(st.json.app_key_set, true);
  });

  await check('A6 an unknown tenant is 404, not a silent success', async () => {
    const r = await j('PUT', `${TENANT}/credentials/99999`, { cookie: admin.cookie, body: GOOD });
    assert.strictEqual(r.status, 404, r.text.slice(0, 120));
  });

  // ── the supervisor, as the API exposes it ─────────────────────────────────

  await check('A7 runner health reports the SPECIFIC reason it will not start', async () => {
    // FEED_ENABLED is off in this suite, so this is the real refusal an
    // operator would hit, and it must be actionable rather than a bare false.
    const r = await j('GET', `${TENANT}/runner/1`, { cookie: admin.cookie });
    assert.strictEqual(r.status, 200, r.text.slice(0, 120));
    assert.ok(r.json && typeof r.json.ready === 'boolean',
      `expected a health body with a boolean ready, got: ${r.text.slice(0, 300)}`);
    assert.strictEqual(r.json.ready, false, 'not ready, because the feed is off');
    assert.match(r.json.reason, /FEED_ENABLED/, 'and it says WHICH condition is missing');
    assert.strictEqual(r.json.running, false);
    for (const secret of Object.values(GOOD)) assert.ok(!r.text.includes(secret));
  });

  await check('A8 start is 409 with the reason — not a 200 that renders as success', async () => {
    // The failure mode this prevents: a UI showing "started" while nothing runs.
    const r = await j('POST', `${TENANT}/runner/start`, { cookie: admin.cookie });
    assert.strictEqual(r.status, 409, r.text.slice(0, 160));
    assert.ok(r.json.error, 'carries an error message');
    assert.match(r.json.error, /FEED_ENABLED|FEED_RUNNER|FEED_DATABASE_URL|FEED_CREDENTIALS_KEY/);
  });

  await check('A9 stop on an idle supervisor is safe and says it was already stopped', async () => {
    const r = await j('POST', `${TENANT}/runner/stop`, { cookie: admin.cookie });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.stopped === true);
  });

  // ── deleting ───────────────────────────────────────────────────────────────

  await check('A10 deleting removes the credential, and reports that no collector was running', async () => {
    const r = await j('DELETE', `${TENANT}/credentials/1`, { cookie: admin.cookie });
    assert.strictEqual(r.status, 200, r.text.slice(0, 120));
    assert.strictEqual(r.json.cleared, true);
    assert.strictEqual(r.json.collector_stopped, false, 'none was supervised here');
    const st = await j('GET', `${TENANT}/credentials/1`, { cookie: admin.cookie });
    assert.strictEqual(st.json.configured, false);
    for (const secret of Object.values(GOOD)) assert.ok(!r.text.includes(secret));
  });

  await check('A11 deleting when nothing is stored is 404, not a silent success', async () => {
    const r = await j('DELETE', `${TENANT}/credentials/1`, { cookie: admin.cookie });
    assert.strictEqual(r.status, 404, r.text.slice(0, 120));
  });

  // ── audit ──────────────────────────────────────────────────────────────────

  await check('A12 every write and delete is audited, and the trail holds no secret', async () => {
    const rows = srv.db
      .prepare("SELECT * FROM audit_log WHERE target LIKE '%/feed_credentials' ORDER BY id")
      .all();
    assert.ok(rows.length >= 2, `expected set + delete in the audit log, got ${rows.length}`);
    const trail = JSON.stringify(rows);
    for (const secret of Object.values(GOOD)) {
      assert.ok(!trail.includes(secret), `the audit trail leaked ${secret}`);
    }
    assert.ok(trail.includes('[sealed]'), 'and records that sealed values were set');
    assert.ok(rows.every((r) => r.actor_id), 'each entry names who did it');
  });

  // ── the tenant boundary, over HTTP ─────────────────────────────────────────

  // A13 is the one that matters, and it is the shape of attack the issue
  // describes: any admin could name any tenant and overwrite, delete, enumerate
  // or stop that tenant's Betfair credentials and collector. No plaintext is
  // reachable, so this is a write / DoS / cross-tenant-disclosure failure rather
  // than credential exfiltration — a distinction worth keeping when triaging,
  // and worth a test that says which one it is.
  await check('A13 an admin cannot reach another tenant feed credentials', async () => {
    // A second venue in the same database, with its own admin and its own
    // stored credential. Both admins are `role='admin'` — the roles are
    // identical, which is exactly why the boundary cannot come from the role.
    const otherTenant = srv.db
      .prepare("INSERT INTO tenants (slug, name) VALUES ('other-venue', 'Other Venue')")
      .run();
    const otherId = Number(otherTenant.lastInsertRowid);
    const otherAdmin = await mk('otheradmin', 'admin');
    srv.db.prepare('UPDATE users SET tenant_id = ? WHERE id = ?').run(otherId, otherAdmin.id);
    const THEIR = { app_key: 'OTHERKEYnotreal1', username: 'other-venue-acct', password: 'other-venue-password' };
    const stored = await j('PUT', `${TENANT}/credentials`, { cookie: otherAdmin.cookie, body: THEIR });
    assert.strictEqual(stored.status, 200, stored.text.slice(0, 160));

    // The default-tenant admin, naming the other tenant every way the old
    // feedTenantId() read it: path, query and body.
    const attempts = [
      ['PUT', `${TENANT}/credentials/${otherId}`, GOOD, {}],
      ['PUT', `${TENANT}/credentials?tenant_id=${otherId}`, GOOD, {}],
      ['PUT', `${TENANT}/credentials`, { ...GOOD, tenant_id: otherId }, {}],
      ['DELETE', `${TENANT}/credentials/${otherId}`, undefined, {}],
      ['DELETE', `${TENANT}/credentials?tenant_id=${otherId}`, undefined, {}],
      ['GET', `${TENANT}/credentials/${otherId}`, undefined, {}],
    ];
    for (const [method, path, body] of attempts) {
      const r = await j(method, path, { cookie: admin.cookie, body });
      assert.notStrictEqual(r.status, 200, `${method} ${path} answered 200 for another tenant: ${r.text.slice(0, 120)}`);
      assert.ok(r.status === 403 || r.status === 404, `${method} ${path} -> ${r.status}, expected a refusal`);
      for (const secret of Object.values(GOOD)) assert.ok(!r.text.includes(secret));
    }

    // The other venue's credential is untouched — still its own account, not
    // the attacker's.
    const theirs = srv.db.prepare('SELECT username FROM feed_credentials WHERE tenant_id = ?').get(otherId);
    assert.ok(theirs, 'the other tenant still has a stored credential');
    const env = require('../lib/feedcreds').collectorEnv(srv.db, otherId);
    assert.strictEqual(env.BETFAIR_USERNAME, THEIR.username, "still THEIR account");
    assert.notStrictEqual(env.BETFAIR_USERNAME, GOOD.username, "not the attacker's");

    // And the list route does not disclose the other venue either. A3 already
    // created one tenant and A13 a second, so this database now holds three
    // and "exactly one" cannot pass by accident.
    const list = await j('GET', `${TENANT}/credentials`, { cookie: admin.cookie });
    assert.strictEqual(list.status, 200);
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) c FROM tenants').get().c, 3, 'three venues exist in this database');
    assert.strictEqual(list.json.tenants.length, 1, 'exactly one tenant — the caller\'s own');
    assert.strictEqual(list.json.tenants[0].tenant_id, srv.db.prepare('SELECT id FROM tenants WHERE slug = ?').get('default').id);

    // Finally: the boundary is a boundary, not a lockout. Each admin can still
    // do everything to their OWN tenant.
    const own = await j('GET', `${TENANT}/credentials/${otherId}`, { cookie: otherAdmin.cookie });
    assert.strictEqual(own.status, 200, 'the other admin reaches their own tenant');
    assert.strictEqual(own.json.configured, true);
  });

  server.close();
  require('../lib/feedrunner').stopAll();

  console.log(`\nfeedadmin.test.js: ${passed} checks passed`);
  if (failures.length) {
    console.error(`failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('feedadmin.test.js threw:', e);
  process.exit(1);
});