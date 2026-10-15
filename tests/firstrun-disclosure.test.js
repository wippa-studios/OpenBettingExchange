'use strict';
// tests/firstrun-disclosure.test.js — what the first-run lock's 403 may say.
//
// Run: node tests/firstrun-disclosure.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. The lock's refusal carried a password:
//
//     seeded_password: req.user.username === 'admin' ? 'admin123' : 'demo123'
//
// which is a credential in an API response — the one thing this codebase does
// not otherwise do (lib/feedcreds carries an explicit property that no function
// there serves a plaintext credential to an HTTP caller, and a guard test
// asserts adding one would be deliberate). This file pins what the response MAY
// contain instead.
//
// THE STRONGEST FORM OF THE CHECK IS F5, and it is here rather than as a string
// match because a string match only proves the response stopped naming the two
// literals someone remembered to look for. F5 walks every string in the body and
// asks whether it AUTHENTICATES as the account, so the property being asserted
// is "the response contains nothing that is this account's password" — which
// survives someone publishing a new seed, renaming the field, or guessing from
// a different constant.
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

/** Every string reachable in a JSON body — keys as well as values. */
function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); stringsIn(v, out); }
  }
  return out;
}

const cookieOf = (res) => (res.setCookie[0] || '').split(';')[0];

// Flagged here rather than left to enforceFirstRunLock(), which runs inside
// main() — and main() only runs when server.js is the entry point, so a suite
// that `require`s it never flips the flag. What is under test here is the
// RESPONSE a locked account gets, so the fixture states the lock directly
// rather than depending on the boot path (which api.test.js covers).
function flag(username) {
  srv.db.prepare('UPDATE users SET must_change_password = 1 WHERE username = ?').run(username);
}

(async () => {
  const server = srv.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

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

  const cookieOf = (res) => (res.setCookie[0] || '').split(';')[0];

  await srv.ready;

  // A third account, flagged but NOT one of the two seeded names. The old line
  // answered `demo123` for it, on the strength of a ternary.
  const third = await A.registerUser(srv.db, { username: 'zoe', password: 'zoe-original-pw', balance_cents: 0 });
  flag('zoe');
  flag('admin');
  flag('demo');
  assert.strictEqual(third.must_change_password, false, 'a fresh registration is not locked — the flag is ours to set');

  // Locked sessions for all three, each obtained the only way an operator can:
  // by signing in with the password they already hold.
  const locked = {};
  for (const [who, password] of [['admin', 'admin123'], ['demo', 'demo123'], ['zoe', 'zoe-original-pw']]) {
    const login = await j('POST', '/api/auth/login', { body: { username: who, password } });
    assert.strictEqual(login.status, 200, `${who} must be able to sign in while locked: ${JSON.stringify(login.json)}`);
    locked[who] = { cookie: cookieOf(login), hash: srv.db.prepare('SELECT pass_hash FROM users WHERE username = ?').get(who).pass_hash };
  }

  // F1: a locked NON-seeded account is refused, and the refusal names no
  // password. This is the oracle: before the fix it carried `demo123` for any
  // username that was not literally "admin", whatever that account's own
  // password was.
  await check('F1 a locked non-seeded account\'s refusal carries no password', async () => {
    const res = await j('GET', '/api/wallet', { cookie: locked.zoe.cookie });
    assert.strictEqual(res.status, 403, 'the lock must be engaged');
    assert.ok(
      !stringsIn(res.json).some((s) => /123/.test(s)),
      `no field of the refusal may carry a seeded-looking value; body: ${JSON.stringify(res.json)}`
    );
    assert.ok(
      !('seeded_password' in (res.json.details || {})),
      `seeded_password must be gone; body: ${JSON.stringify(res.json)}`
    );
  });

  // F2: the same for the two seeded accounts, which are the only ones the old
  // line could name correctly.
  await check('F2 neither seeded account\'s refusal carries a password', async () => {
    for (const who of ['admin', 'demo']) {
      const res = await j('GET', '/api/wallet', { cookie: locked[who].cookie });
      assert.strictEqual(res.status, 403, `${who} must be refused`);
      const strings = stringsIn(res.json);
      assert.ok(
        !strings.some((s) => s === 'admin123' || s === 'demo123'),
        `${who}: the refusal must not name a demo password; body: ${JSON.stringify(res.json)}`
      );
    }
  });

  // F3: the refusal is still ACTIONABLE. Removing the credential must not have
  // removed the reason or the machine-readable code a client branches on — an
  // un-actionable 403 is a worse outcome than a disclosing one.
  await check('F3 the refusal still says why, to which account, and under which code', async () => {
    for (const who of ['admin', 'demo', 'zoe']) {
      const res = await j('GET', '/api/wallet', { cookie: locked[who].cookie });
      assert.match(res.json.error, /change your password/i, `${who}: the reason must survive`);
      assert.strictEqual(res.json.details.code, 'password_change_required', `${who}: the code a client branches on`);
      assert.strictEqual(res.json.details.username, who, `${who}: which account is locked`);
    }
  });

  // F4: THE CONTROL. Every other check here asserts the ABSENCE of a password,
  // and an absence is satisfied by a response that carries nothing at all — by
  // a 200, or by an empty body. So prove the lock is really engaged and really
  // producing this shape, or F1–F3 could be passing against a route that was
  // simply not refusing anyone.
  await check('F4 the lock is engaged: the refusal really is a 403 with this shape', async () => {
    const lockedRes = await j('GET', '/api/wallet', { cookie: locked.zoe.cookie });
    assert.strictEqual(lockedRes.status, 403, 'a locked account is refused');
    assert.ok(lockedRes.json && lockedRes.json.details, 'and the body is the lock, not an empty 403');
    // …and an unlocked account on the same route is NOT refused, which is what
    // makes the 403 above a fact about the lock rather than about the route.
    const fresh = await A.registerUser(srv.db, { username: 'unflagged', password: 'a-real-password', balance_cents: 0 });
    const login = await j('POST', '/api/auth/login', { body: { username: 'unflagged', password: 'a-real-password' } });
    const wallet = await j('GET', '/api/wallet', { cookie: cookieOf(login) });
    assert.strictEqual(wallet.status, 200, 'an unflagged account reaches the same route');
    assert.ok(fresh.id, 'and it is a real account, not a fixture that failed to create');
  });

  // F5: the general property, rather than the two literals someone remembered
  // to look for. Walk EVERY string in the refusal — keys included — and ask
  // whether it authenticates as the locked account. Before the fix this
  // returned true for `admin123` and `demo123`.
  await check('F5 no string anywhere in the refusal authenticates as the locked account', async () => {
    for (const who of ['admin', 'demo', 'zoe']) {
      const res = await j('GET', '/api/wallet', { cookie: locked[who].cookie });
      const strings = stringsIn(res.json);
      assert.ok(strings.length > 3, `${who}: expected to actually walk a body, found ${strings.length} strings`);
      for (const s of strings) {
        const verifies = await A.verifyPassword(s, locked[who].hash);
        assert.strictEqual(
          verifies,
          false,
          `${who}: the refusal contains "${s}", which IS this account's password`
        );
      }
    }
  });

  // F6: and the recovery path does not need the value. The client acts on
  // `must_change_password` from the LOGIN response and then changes the
  // password it just used. Nothing in that path consumes anything the refusal
  // used to disclose, which is the reason removing the field costs nothing.
  await check('F6 a locked operator can recover from the login response alone', async () => {
    const login = await j('POST', '/api/auth/login', { body: { username: 'zoe', password: 'zoe-original-pw' } });
    assert.strictEqual(login.json.user.must_change_password, true, 'the flag reaches the client at sign-in');
    const changed = await j('POST', '/api/auth/change-password', {
      cookie: cookieOf(login),
      body: { currentPassword: 'zoe-original-pw', newPassword: 'zoe-has-changed-this' },
    });
    assert.strictEqual(changed.status, 200, `recovery must work from the login response alone: ${JSON.stringify(changed.json)}`);
    // And the lock is released by the change, which is what makes the whole
    // thing escapable rather than merely escapable-in-theory.
    const after = await j('GET', '/api/wallet', { cookie: cookieOf(login) });
    assert.strictEqual(after.status, 200, 'and the account is usable afterwards');
  });

  console.log(`\nfirstrun-disclosure.test.js: ${passed} checks passed, ${failures.length} failed`);
  server.close();
  if (failures.length) process.exit(1);
  if (passed !== 6) { console.error(`expected 6 checks, ran ${passed}`); process.exit(1); }
})();