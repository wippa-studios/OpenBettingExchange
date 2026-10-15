// apicontract.test.js — the promises docs/API.md makes to a third party (#67).
// Run: node tests/apicontract.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. "Open source Betfair" means a stranger's strategy runs
// against this without reading server.js. That only works if the contract is
// real, and a contract is only real if something fails when it stops being true.
// Before this file the answer was "nothing", which is why:
//   - a client could not tell what it was talking to,
//   - a client could only learn a rate limit by tripping it,
//   - a client had to pattern-match an English `error` string to react to a
//     refusal, which is how you get a strategy that breaks on a reword.
//
// THE ORDER OF THESE CHECKS IS LOAD-BEARING. The exhaustion test (V12) drives the
// 'read' bucket to its ceiling, and every unauthenticated request in this file
// shares that bucket because volumeKey falls back to the socket address. So it
// MUST run last. Moving it earlier silently turns every later check into a 429
// and the suite reports a cascade instead of one cause.
//
// All failures are reported; a harness that exits on the first one hides every
// later check behind it, and here the later checks are the ones that prove the
// header is on ERRORS too.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.DB_PATH = ':memory:';
process.env.DRIFT_ENABLED = 'false';
process.env.BOT_ENABLED = 'false';
// Small so V12 can reach the ceiling without issuing 600 requests. Every other
// check here uses a handful, so the ceiling is untouched until V12.
process.env.RATE_LIMIT_READ = '25';

const assert = require('assert');
const srv = require('../server');

let passed = 0;
let failed = 0;
const failures = [];

const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ok', name);
  } catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.log('  FAIL', name, '—', e.message);
  }
};

(async () => {
  const server = srv.app.listen(0, '127.0.0.1'); // loopback only
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const j = async (method, path, opts = {}) => {
    const headers = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin) headers.origin = opts.origin;
    const res = await fetch(base + path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json, headers: res.headers };
  };

  // ── V1: the version header on a successful /api response ────────────
  await check('V1  every /api success carries X-API-Version', async () => {
    const r = await j('GET', '/api/sports');
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
    assert.strictEqual(
      r.headers.get('x-api-version'),
      '1',
      `expected X-API-Version "1", got ${JSON.stringify(r.headers.get('x-api-version'))}`,
    );
  });

  // ── V2: and on an ERROR, which is when a client most needs to know ──
  //
  // The obvious implementation is a header set on the happy path only, because
  // that is where the middleware runs. This asserts the header survives the
  // central error handler — the path a client hits precisely when it is about to
  // break.
  await check('V2  an /api error still carries X-API-Version', async () => {
    const r = await j('GET', '/api/no-such-endpoint');
    assert.strictEqual(r.status, 404, `expected 404, got ${r.status}`);
    assert.strictEqual(
      r.headers.get('x-api-version'),
      '1',
      `error response lost the version header (got ${JSON.stringify(r.headers.get('x-api-version'))})`,
    );
  });

  // ── V3: and on a refusal produced by a MIDDLEWARE, not a handler ────
  //
  // V2 proves the central error handler preserves it. This proves the origin
  // guard does, which is a different code path: it answers before any route
  // handler exists. A contract asserted only on handler-thrown errors would pass
  // V2 and fail this.
  await check('V3  a middleware refusal carries X-API-Version too', async () => {
    const r = await j('POST', '/api/auth/login', { origin: 'http://evil.example', body: {} });
    assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
    assert.strictEqual(
      r.headers.get('x-api-version'),
      '1',
      `middleware refusal lost the version header (got ${JSON.stringify(r.headers.get('x-api-version'))})`,
    );
  });

  // ── V4: the version is not operator-settable ────────────────────────
  //
  // This is the one that is easy to get wrong and impossible to notice. If
  // API_VERSION were read from the environment, an operator could announce
  // version 2 while still serving version 1 and every client that trusted the
  // header would be wrong undetectably. Asserted against the loaded config, not
  // by inspecting the source for the absence of a read.
  await check('V4  API_VERSION is a constant, not deployment config', async () => {
    const config = require('../lib/config');
    assert.strictEqual(config.API_VERSION, '1', 'expected the served version to be 1');
    process.env.API_VERSION = '99';
    delete require.cache[require.resolve('../lib/config')];
    const reloaded = require('../lib/config');
    assert.strictEqual(
      reloaded.API_VERSION,
      '1',
      `API_VERSION=99 in the environment changed the announced version to ${reloaded.API_VERSION}`,
    );
    delete process.env.API_VERSION;
    delete require.cache[require.resolve('../lib/config')];
  });

  // ── V5: the budget headers are present on success ───────────────────
  await check('V5  a limited route reports its budget on SUCCESS', async () => {
    const r = await j('GET', '/api/sports');
    const limit = r.headers.get('x-ratelimit-limit');
    const remaining = r.headers.get('x-ratelimit-remaining');
    const reset = r.headers.get('x-ratelimit-reset');
    assert.ok(limit, 'X-RateLimit-Limit absent on a 200');
    assert.ok(remaining !== null, 'X-RateLimit-Remaining absent on a 200');
    assert.ok(reset !== null, 'X-RateLimit-Reset absent on a 200');
    assert.strictEqual(Number(limit), 25, `expected the configured ceiling, got ${limit}`);
    assert.ok(Number(remaining) >= 0, `remaining was negative: ${remaining}`);
    assert.ok(Number(remaining) < Number(limit), `remaining should have been spent down, got ${remaining}`);
    assert.ok(Number(reset) > 0 && Number(reset) <= 60, `reset out of range: ${reset}`);
  });

  // ── V6: `remaining` actually DECREMENTS. V5 alone is satisfiable by a
  //       constant header, which would be worse than no header at all: a
  //       client would pace against a number that never moves.
  await check('V6  X-RateLimit-Remaining decrements as calls are made', async () => {
    const first = Number((await j('GET', '/api/sports')).headers.get('x-ratelimit-remaining'));
    await j('GET', '/api/sports');
    const third = Number((await j('GET', '/api/sports')).headers.get('x-ratelimit-remaining'));
    assert.strictEqual(third, first - 2, `expected ${first - 2} remaining after 3 calls, got ${third}`);
  });

  // ── V7: the budget is reported on an ERROR too ──────────────────────
  //
  // Uses `/api/format/abc`, which IS behind `limit('read')` and answers 400.
  //
  // The obvious route for this — an unknown /api path — is a TRAP, and the first
  // draft of this check fell into it. The `app.use('/api', ...)` catch-all that
  // answers 404 carries no limiter at all, so it emits no budget headers, and
  // asserting they were there would have been asserting a promise the contract
  // does not make. A 404 for a path nobody limited is not a limited route that
  // failed; it is a route that does not exist.
  //
  // So this asserts the narrower true thing: on a route that IS limited, a
  // refusal still reports the budget, which proves the header is set on the way
  // IN rather than only on the way out of a success.
  await check('V7  a limited route reports its budget on a 400', async () => {
    const r = await j('GET', '/api/format/abc');
    assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
    assert.ok(
      r.headers.get('x-ratelimit-limit'),
      'X-RateLimit-Limit absent on a 400 from a limited route — set only on success',
    );
    assert.ok(r.headers.get('x-ratelimit-remaining') !== null, 'X-RateLimit-Remaining absent on a 400');
  });

  // ── V7b: and an UNLIMITED route emits NO budget headers ─────────────
  //
  // The negative half of V7, and it is the half that stops the obvious "fix".
  // The tempting response to "no headers on the 404" is to emit them anyway.
  // That would be worse: a route with no limiter has no ceiling, and announcing
  // `X-RateLimit-Limit: 0` tells a pacing client to back off against a limit
  // that does not exist. Absent means "not configured", which is a different
  // claim from "unlimited" and is what the docs say.
  await check('V7b an UNLIMITED route emits no X-RateLimit-* at all', async () => {
    const r = await j('GET', '/api/no-such-endpoint');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.headers.get('x-ratelimit-limit'), null, 'an unlimited route announced a limit');
    assert.strictEqual(r.headers.get('x-ratelimit-remaining'), null, 'an unlimited route announced a remaining count');
    assert.strictEqual(r.headers.get('x-ratelimit-reset'), null, 'an unlimited route announced a reset');
  });

  // ── V8: every error carries a machine-readable `code` ───────────────
  //
  // The point is that a client can branch on `code` and NOT on the `error`
  // prose. So each case asserts the code matches the STATUS, which is what lets
  // an unannotated route still be handled.
  const CODE_CASES = [
    ['404 on an unknown /api path', 'GET', '/api/no-such-endpoint', undefined, 404, 'not_found'],
    ['400 on a malformed id', 'GET', '/api/format/abc', undefined, 400, 'bad_request'],
    ['401 on a session-gated read', 'GET', '/api/auth/sessions', undefined, 401, 'unauthenticated'],
    ['403 on a foreign Origin', 'POST', '/api/auth/login', { origin: 'http://evil.example' }, 403, 'forbidden'],
  ];
  for (const [label, method, path, opts, wantStatus, wantCode] of CODE_CASES) {
    // eslint-disable-next-line no-await-in-loop
    await check(`V8  ${label} → code "${wantCode}"`, async () => {
      const r = await j(method, path, { body: method === 'POST' ? {} : undefined, ...(opts || {}) });
      assert.strictEqual(r.status, wantStatus, `expected ${wantStatus}, got ${r.status}`);
      assert.ok(r.json, `expected a JSON body, got ${JSON.stringify(r.json)}`);
      assert.strictEqual(
        r.json.code,
        wantCode,
        `expected code "${wantCode}", got ${JSON.stringify(r.json.code)} (body: ${JSON.stringify(r.json).slice(0, 160)})`,
      );
      assert.ok(r.json.error, 'expected the human `error` string to still be present');
    });
  }

  // ── V9: an explicit code is PROMOTED to the top level ───────────────
  //
  // `password_change_required` is set inside `details` by the route. Before
  // apiError existed, a client had to know that some codes live in `details` and
  // some do not, which is not a contract — it is a map. Promoting it is what
  // makes `code` mean one thing.
  //
  // Reached without fighting the first-run lock: the assertion is that the code
  // is promoted WHEN the route fires, proven structurally by calling the helper
  // the route calls. Driving the real lock needs a seeded demo account, which
  // api.test.js already owns; duplicating that fixture here would make this
  // check depend on seed state for no extra signal.
  await check('V9  a route-supplied details.code is promoted to top level', async () => {
    const res = {
      _status: null,
      _body: null,
      status(c) { this._status = c; return this; },
      json(b) { this._body = b; return this; },
    };
    // The exact shape the first-run-lock route hands over.
    srv.__apiErrorForTest(res, 403, 'Change your password before using the exchange', {
      code: 'password_change_required',
      username: 'someone',
    });
    assert.strictEqual(res._status, 403, 'status was not passed through');
    assert.strictEqual(res._status, 403);
    assert.strictEqual(
      res._body.code,
      'password_change_required',
      `explicit code was not promoted (got ${JSON.stringify(res._body)})`,
    );
    assert.ok(res._body.details, 'details should still be carried on a 4xx');
    assert.strictEqual(res._body.details.username, 'someone', 'details payload was dropped');
  });

  // ── V10: `details` is stripped from a 5xx ───────────────────────────
  //
  // The promotion must not become a leak channel.
  //
  // NOTE WHAT IS *NOT* ASSERTED, because the first draft got this wrong and the
  // correction is a real design decision rather than a detail. It does NOT
  // assert that a 5xx discards a route-supplied `code`. It keeps it.
  //
  // The leak channel is `details`, which is closed on every 5xx. A `code` is a
  // short machine token written by our own routes — `feed_unavailable`,
  // `internal_error` — so it carries no user data and stripping it would remove
  // the one field that lets a client tell a deliberate 503 from a genuine fault.
  // "Deliberate" is the point: both are 5xx, and the code is the only thing that
  // distinguishes them.
  await check('V10 a 5xx leaks no details, and still names itself', async () => {
    const res = {
      _status: null,
      _body: null,
      status(c) { this._status = c; return this; },
      json(b) { this._body = b; return this; },
    };
    // A route-supplied code on a 5xx: kept.
    srv.__apiErrorForTest(res, 503, 'Odds feed unavailable', { code: 'feed_unavailable', secret: 'do-not-leak' });
    assert.strictEqual(res._status, 503);
    assert.strictEqual(res._body.code, 'feed_unavailable', 'a deliberate 5xx lost the code that identifies it');
    assert.ok(!res._body.details, `details leaked on a 5xx: ${JSON.stringify(res._body)}`);
    assert.ok(!JSON.stringify(res._body).includes('do-not-leak'), 'the secret value reached the body');

    // No route-supplied code on a 5xx: derived from the status.
    const res2 = {
      _status: null,
      _body: null,
      status(c) { this._status = c; return this; },
      json(b) { this._body = b; return this; },
    };
    srv.__apiErrorForTest(res2, 500, 'Internal error', null);
    assert.strictEqual(res2._body.code, 'internal_error', `expected the derived code, got ${res2._body.code}`);
    assert.ok(!res2._body.details, 'details appeared on a 500 with none supplied');
  });

  // ── V11: `code` and `details` coexist without shadowing ─────────────
  await check('V11 extra fields do not displace code or error', async () => {
    const res = {
      _status: null,
      _body: null,
      status(c) { this._status = c; return this; },
      json(b) { this._body = b; return this; },
    };
    srv.__apiErrorForTest(res, 429, 'Too many requests', { code: 'rate_limited' }, {
      extra: { retry_after_seconds: 7 },
    });
    assert.strictEqual(res._body.code, 'rate_limited');
    assert.strictEqual(res._body.error, 'Too many requests');
    assert.strictEqual(res._body.retry_after_seconds, 7, 'the extra field was dropped');
    assert.strictEqual(Object.keys(res._body)[0], 'error', '`error` should be the first key');
    assert.strictEqual(Object.keys(res._body)[1], 'code', '`code` should be the second key');
  });

  // ── V12: exhaustion → 429 with code AND Retry-After. LAST, see header.
  await check('V12 the ceiling answers 429 + code "rate_limited" + Retry-After', async () => {
    let refused = null;
    for (let i = 0; i < 60 && !refused; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await j('GET', '/api/sports');
      if (r.status === 429) refused = r;
    }
    assert.ok(refused, 'the bucket never refused after 60 more requests with a ceiling of 25');
    assert.strictEqual(refused.json.code, 'rate_limited', `expected code "rate_limited", got ${JSON.stringify(refused.json)}`);
    const retryAfter = refused.headers.get('retry-after');
    assert.ok(retryAfter, 'no Retry-After on the 429');
    assert.ok(Number(retryAfter) > 0, `Retry-After was not a positive number: ${retryAfter}`);
    assert.strictEqual(refused.json.retry_after_seconds, Number(retryAfter), 'header and body disagreed');
    // The budget headers must still be truthful at the ceiling: a client pacing
    // off `remaining` needs 0 here, not a negative number it cannot act on.
    assert.strictEqual(refused.headers.get('x-ratelimit-remaining'), '0', 'remaining should read 0 at the ceiling');
  });

  server.close();
  console.log(`\napicontract: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  ${f.name}\n    ${f.message}`);
    process.exit(1);
  }
  console.log('apicontract: ALL GREEN');
})();
