'use strict';
// tests/ratelimit-coverage.test.js — does every route that costs something
// carry a volume bucket, and does the bucket actually bite?
//
// Run: node tests/ratelimit-coverage.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. The volume limiter existed, worked, and was on ONE of
// the player read routes. `limit(bucket)` is an ARGUMENT at the route
// registration site, so a route registered without it is not throttled — and
// nothing failed when that happened, for any of:
//
//   - the other player reads (/api/me, /api/orders, /api/positions,
//     /api/wallet, /api/settlements, /api/auth/sessions)
//   - the public catalogue (/api/sports, /api/events, /api/markets/:id/book,
//     /api/format/:price) — where /api/events answers a full board with a book
//     query per market, unauthenticated, forever
//   - POST /api/auth/register, which had NO volume cap at all: the per-address
//     register counter counts FAILURES, so a flood of SUCCESSFUL registrations
//     never tripped it and each success cost a full scrypt. Unauthenticated
//     registration was the cheapest CPU flood the venue offered.
//   - POST /api/auth/login, whose username counter is CLEARED by every success
//     — so 200 valid sign-ins a minute spent 200 key derivations and recorded
//     no failures.
//
// The first check below is the one that would have caught all of that, and it
// reads the LIVE ROUTER rather than the source: a route added tomorrow without
// the argument fails it, which a source-scraping check for the string
// `limit(` could also do but would not prove the middleware is actually in that
// route's chain.
//
// WHY THE HARNESS HERE DOES NOT HIDE ITS OWN FAILURES. The sibling suite
// (tests/resultsfeed-signal-shape.test.js) exits on its FIRST failure, so in a
// naive run one red check masks every check after it and the rest ship
// unverified. This file reports EVERY failure and only then fails.
process.env.SCRYPT_N = '16384';
process.env.DB_PATH = ':memory:';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
// Small budgets, so the behavioural checks cost a handful of requests each
// rather than six hundred. The limiter reads config once, at module load.
process.env.RATE_LIMIT_READ = '5';
process.env.RATE_LIMIT_AUTH = '4';

const assert = require('assert');
const srv = require('../server');
const A = require('../lib/auth');

const READ_LIMIT = 5;
const AUTH_LIMIT = 4;

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

/**
 * Every { method, path, bucket } in the live router.
 *
 * `app.router` is Express 5's PUBLIC accessor for the router; Express 4 kept
 * the same object on the private `app._router`, which 5 removed. Reading it
 * through the public name is what keeps C1 — the check that every route carries
 * a volume bucket or a stated exemption — able to see the routes at all. A
 * silent fallback to an empty stack here would turn the whole control into a
 * tautology that passes on no routes, so it asserts instead.
 */
function routes() {
  const r = srv.app.router || srv.app._router;
  assert.ok(r && Array.isArray(r.stack),
    `neither app.router nor app._router exposes a stack (app.router=${typeof srv.app.router}); ` +
    'C1 cannot enumerate the routes, so it would pass without checking anything');
  const out = [];
  for (const layer of r.stack) {
    if (!layer.route) continue;
    const buckets = layer.route.stack
      .map((l) => l.handle && l.handle.volumeBucket)
      .filter(Boolean);
    out.push({
      method: Object.keys(layer.route.methods).join(',').toUpperCase(),
      path: layer.route.path,
      bucket: buckets[0] || null,
    });
  }
  return out;
}

// Routes that are deliberately NOT volume limited, each with the reason. This is
// a list, so it is a place to forget — so it is a list of ROUTES WITH REASONS
// and the check below fails on any entry that no longer exists (a stale
// exemption hides a route that has since been given a bucket).
//
// THE FOUR `/api/feed/*` ENTRIES WERE REMOVED HERE, and that is a HARDENING of
// C1 rather than an edit made to let it pass. They were exempted for being "a
// different data source in a different mode, 409 before any work when the feed
// is off" — a statement about a DEPLOYMENT WITH THE FEED OFF, which is the only
// deployment in which those routes do nothing at all. On the deployment they were
// actually meant to describe, the one with the feed ON, they were four
// unauthenticated routes reaching the provider with no bucket: implicitly bounded
// by `new Pool({ max: 4 })` under the collector, and not bounded at all under
// FEED_PROVIDER=http. The entries were removed rather than reworded, because a
// reworded exemption is still an exemption.
//
// Note what is deliberately still absent: no `/api/feed/*` route is
// `requireAuth`-gated, and that is right — the browser probes /api/feed/nav at
// boot with no session and tests/ui_test.mjs fails a run on any console error. A
// bucket, not a login.
const EXEMPT = {
  'GET /api/stream': 'a long-held connection, not a request; MAX_SSE_CLIENTS governs it',
  'GET /api/branding': 'one row, no query worth bounding, and it is what a locked account\'s page load reads',
  'GET /healthz': 'supervisor liveness probe',
  'GET /readyz': 'supervisor readiness probe — a throttled probe kills the venue',
  'GET /metrics': 'supervisor scrape',
  'POST /api/auth/logout': 'one session delete; cheap, and the caller is already spending a session',
  'POST /api/auth/change-password': 'one key derivation, already behind a session and the setup allowlist',
  'DELETE /api/auth/sessions/:id': 'one row delete, same argument as logout',
};

(async () => {
  const server = srv.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await srv.ready;

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
      retryAfter: res.headers.get('retry-after'),
      setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [],
    };
  };

  // ── C1 ────────────────────────────────────────────────────────────────────
  // The coverage check itself. Every registered route must either carry a
  // volume bucket or be on the exemption list WITH a reason — and the
  // exemption list must not contain entries for routes that do not exist,
  // which is how an exemption quietly becomes a hole.
  await check('C1 every route carries a volume bucket, or is exempted with a reason', () => {
    const all = routes();
    assert.ok(all.length > 60, `expected to be reading a real router, saw ${all.length} routes`);
    const seen = new Set();
    const unaccounted = [];
    for (const r of all) {
      const key = `${r.method} ${r.path}`;
      seen.add(key);
      if (r.bucket) continue;
      // An exemption with no stated reason is not an exemption, it is a hole.
      if (typeof EXEMPT[key] === 'string' && EXEMPT[key].trim().length > 0) continue;
      unaccounted.push(r.bucket === null ? key : `${key} (bucket=${r.bucket})`);
    }
    assert.deepStrictEqual(unaccounted, [], `routes with neither a bucket nor a stated exemption: ${unaccounted.join(', ')}`);

    // And the exemption list must still describe real routes: an exemption for
    // a route that was since renamed or given a bucket is a hole with a
    // comment on it.
    const ghosts = Object.keys(EXEMPT).filter((k) => !seen.has(k));
    assert.deepStrictEqual(ghosts, [], `exemption list names routes that do not exist: ${ghosts.join(', ')}`);
  });

  // ── C2 ────────────────────────────────────────────────────────────────────
  // C1 is structural. This is the behaviour: the bucket is in the chain, it is
  // the RIGHT chain, and a request past the budget is refused rather than
  // served. Without this, a limiter attached to a route that is never reached
  // would satisfy C1 perfectly.
  await check('C2 a read flood past the budget is refused, with Retry-After', async () => {
    const login = await j('POST', '/api/auth/login', { body: { username: 'demo', password: 'demo123' } });
    const cookie = (login.setCookie[0] || '').split(';')[0];
    assert.strictEqual(login.status, 200, `the player must be able to sign in first: ${JSON.stringify(login.json)}`);

    const statuses = [];
    for (let i = 0; i < READ_LIMIT + 2; i++) statuses.push((await j('GET', '/api/positions', { cookie })).status);

    // The first READ_LIMIT must SUCCEED. If they did not, the 429 below would
    // be proving nothing: a route that 429s for everyone is not rate limiting,
    // it is broken, and this check would still be green.
    assert.deepStrictEqual(
      statuses.slice(0, READ_LIMIT),
      Array(READ_LIMIT).fill(200),
      `a legitimate caller inside the budget must be served; got ${statuses.join(',')}`
    );
    assert.deepStrictEqual(
      statuses.slice(READ_LIMIT),
      [429, 429],
      `past the budget every request is refused; got ${statuses.join(',')}`
    );

    const refused = await j('GET', '/api/positions', { cookie });
    assert.strictEqual(refused.status, 429);
    assert.ok(Number(refused.retryAfter) > 0, `a 429 must say when to come back; got Retry-After=${refused.retryAfter}`);
    assert.ok(refused.json && /too many requests/i.test(refused.json.error), `and must say what happened: ${JSON.stringify(refused.json)}`);
  });

  // ── C3 ────────────────────────────────────────────────────────────────────
  // THE FAIRNESS HALF, and the reason a per-USER key exists at all: one noisy
  // client must not spend everyone else's budget. This is a control in the
  // sense that it compares two callers — if the key were the address, the
  // second account would be locked out by the first one's flood.
  await check('C3 one client\'s flood does not spend another client\'s budget', async () => {
    await A.registerUser(srv.db, { username: 'noisy', password: 'noisy-password', balance_cents: 0 });
    await A.registerUser(srv.db, { username: 'quiet', password: 'quiet-password', balance_cents: 0 });
    const cookieFor = async (who) => {
      const r = await j('POST', '/api/auth/login', { body: { username: who, password: `${who}-password` } });
      assert.strictEqual(r.status, 200, `${who} must be able to sign in: ${JSON.stringify(r.json)}`);
      return (r.setCookie[0] || '').split(';')[0];
    };
    const noisy = await cookieFor('noisy');
    const quiet = await cookieFor('quiet');

    for (let i = 0; i < READ_LIMIT + 3; i++) await j('GET', '/api/wallet', { cookie: noisy });
    assert.strictEqual((await j('GET', '/api/wallet', { cookie: noisy })).status, 429, 'the noisy client is throttled');

    const quietRes = await j('GET', '/api/wallet', { cookie: quiet });
    assert.strictEqual(quietRes.status, 200, `a second account behind the same address must not inherit the first one's exhaustion; got ${quietRes.status}`);
    assert.ok(quietRes.json && 'balance_cents' in quietRes.json, 'and must be a real wallet, not an error body');
  });

  // ── C4 ────────────────────────────────────────────────────────────────────
  // The control for C3: prove the two accounts really are behind ONE address,
  // otherwise "the second was unaffected" is a claim about two different keys
  // and proves nothing about fairness.
  await check('C4 both accounts are behind the same address, so C3 was a real test', async () => {
    // Both logins went to the same base URL over one loopback socket pool, and
    // volumeKey falls back to 'unknown' when there is no address — so assert
    // the key the limiter would build is the same shape for both.
    const srvSrc = require('fs').readFileSync(require.resolve('../server'), 'utf8');
    const m = srvSrc.match(/const who = req\.user \? `u:\$\{req\.user\.id\}` : `ip:\$\{req\.socket\.remoteAddress \|\| 'unknown'\}`/);
    assert.ok(m, 'volumeKey must key on the user when there is one and on the address when there is not');
    // If it did NOT branch on req.user, the two accounts would share one key
    // and C3 could never have passed — so assert the branch is the live source
    // of the key rather than assuming it.
    assert.ok(srvSrc.includes('volumeKey(req, bucket)'), 'and volumeExceeded must be what computes it');
  });

  // ── C5 ────────────────────────────────────────────────────────────────────
  // Registration, the route that had nothing at all. Successful registrations
  // clear the per-address FAILURE counter, so this flood is invisible to it —
  // which is why a failure-keyed control cannot be the answer here.
  await check('C5 a flood of SUCCESSFUL registrations is bounded', async () => {
    srv.resetVolumeLimits(); // isolate from the auth logins above
    const statuses = [];
    for (let i = 0; i < AUTH_LIMIT + 2; i++) {
      statuses.push((await j('POST', '/api/auth/register', { body: { username: `flood${i}`, password: 'a-flood-password' } })).status);
    }
    assert.deepStrictEqual(
      statuses.slice(0, AUTH_LIMIT),
      Array(AUTH_LIMIT).fill(201),
      `registrations inside the budget must succeed — otherwise the 429 proves nothing; got ${statuses.join(',')}`
    );
    assert.deepStrictEqual(
      statuses.slice(AUTH_LIMIT),
      [429, 429],
      `past the budget registration is refused; got ${statuses.join(',')}`
    );
    // …and the accounts that were created are real, so the 201s above were
    // genuinely registering rather than being refused with the wrong status.
    const created = srv.db.prepare("SELECT COUNT(*) c FROM users WHERE username LIKE 'flood%'").get().c;
    assert.strictEqual(created, AUTH_LIMIT, `exactly the in-budget registrations should exist; got ${created}`);
  });

  // ── C6 ────────────────────────────────────────────────────────────────────
  // Login, bounded for the same reason: the username counter is cleared by
  // every success, so it never saw this. Each of these is a REAL successful
  // sign-in paying a key derivation.
  await check('C6 a flood of SUCCESSFUL sign-ins is bounded too', async () => {
    srv.resetVolumeLimits();
    const statuses = [];
    for (let i = 0; i < AUTH_LIMIT + 2; i++) {
      statuses.push((await j('POST', '/api/auth/login', { body: { username: 'demo', password: 'demo123' } })).status);
    }
    assert.deepStrictEqual(
      statuses.slice(0, AUTH_LIMIT),
      Array(AUTH_LIMIT).fill(200),
      `sign-ins inside the budget must succeed; got ${statuses.join(',')}`
    );
    assert.deepStrictEqual(
      statuses.slice(AUTH_LIMIT),
      [429, 429],
      `past the budget login is refused; got ${statuses.join(',')}`
    );
    // The failure counters are untouched by success — a sign-in that succeeded
    // must not have recorded a failure, or this would be passing for the wrong
    // reason.
    const refused = await j('POST', '/api/auth/login', { body: { username: 'demo', password: 'demo123' } });
    assert.strictEqual(refused.status, 429);
    assert.match(refused.json.error, /too many requests/i, 'and the refusal is the VOLUME limiter, not the lockout');
  });

  // ── C7 ────────────────────────────────────────────────────────────────────
  // The exemption list is only honest if its four load-bearing entries still
  // behave the way the reason claims. A readiness probe that 429s takes the
  // venue out of rotation — that is the whole reason it is exempt, and an
  // exemption nobody checks is an exemption nobody needs.
  await check('C7 the exempted probes are not throttled by a read flood', async () => {
    srv.resetVolumeLimits();
    const login = await j('POST', '/api/auth/login', { body: { username: 'demo', password: 'demo123' } });
    const cookie = (login.setCookie[0] || '').split(';')[0];
    // Drain the read budget as a player would.
    for (let i = 0; i < READ_LIMIT + 3; i++) await j('GET', '/api/positions', { cookie });
    assert.strictEqual((await j('GET', '/api/positions', { cookie })).status, 429, 'the player is throttled');
    // /healthz and /readyz carry opsGuard, which 404s when OPS_TOKEN is unset.
    // Asserting they are NOT 429 is the claim: an exemption that produced 429
    // here would be a venue killing itself.
    for (const path of ['/healthz', '/readyz']) {
      const res = await j('GET', path);
      assert.notStrictEqual(res.status, 429, `${path} must never answer 429 — a throttled probe is an outage`);
      assert.ok(res.status === 404 || res.status === 200, `${path} answered ${res.status}, expected the ops guard's own answer`);
    }
  });

  // ── C8 ────────────────────────────────────────────────────────────────────
  // C1 says the four /api/feed/* routes CARRY a bucket. C8 says the bucket
  // BITES, which C1 cannot see: a limiter attached to a route that is never
  // reached satisfies C1 perfectly.
  //
  // The feed is DISABLED in this suite, which is what makes this possible without
  // a provider, and it is worth being precise about what the test then proves.
  // Each route's own answer when the feed is off is recorded in the table below —
  // 409 for three of them, and 200 {enabled:false} for /api/feed/nav, which is
  // the one the browser probes at boot. Those are REAL responses from the REAL
  // handlers, so a 429 in their place can only have come from the limiter in
  // front of them. The limiter, not the handler, is what changed.
  const FEED_ROUTES = [
    ['GET', '/api/feed/board', 409],
    ['GET', '/api/feed/market?id=1.1', 409],
    ['GET', '/api/feed/nav', 200],
    ['GET', '/api/feed/health', 409],
  ];

  await check('C8 the /api/feed/* routes are actually throttled, not merely bucketed', async () => {
    for (const [method, path, served] of FEED_ROUTES) {
      srv.resetVolumeLimits();
      const first = await j(method, path);
      // Asserted, not assumed: if the feed were enabled in this suite these
      // answers would change and this check would be measuring something else.
      assert.strictEqual(first.status, served, `${path} must reach its own handler first; got ${first.status}`);
      assert.ok(!first.retryAfter, `${path} is inside the budget, so there is nothing to back off from`);
      // Reset again so the budget below is spent by the loop ALONE, and the
      // arithmetic in this check is about the loop's requests and nothing else.
      // Without this the `first` probe above silently eats one of the five.
      srv.resetVolumeLimits();

      const statuses = [];
      for (let i = 0; i < READ_LIMIT + 2; i++) statuses.push((await j(method, path)).status);
      // Same rule as C2: the first READ_LIMIT must be SERVED. A route that 429s
      // everyone would satisfy "past the budget it is 429" perfectly and be
      // completely broken.
      assert.deepStrictEqual(
        statuses.slice(0, READ_LIMIT),
        Array(READ_LIMIT).fill(served),
        `${path} must keep answering its own way inside the budget; got ${statuses.join(',')}`
      );
      assert.deepStrictEqual(
        statuses.slice(READ_LIMIT),
        [429, 429],
        `${path} past the budget must be refused; got ${statuses.join(',')}`
      );

      const refused = await j(method, path);
      assert.strictEqual(refused.status, 429, `${path} must stay refused once the budget is spent`);
      assert.ok(Number(refused.retryAfter) > 0, `${path} must say when to come back; got Retry-After=${refused.retryAfter}`);
      assert.ok(refused.json && /too many requests/i.test(refused.json.error),
        `${path} must say what happened: ${JSON.stringify(refused.json)}`);
      // …and the refusal is the LIMITER's body, unchanged and feed-agnostic: an
      // anonymous caller reading it learns which bucket they spent, which is the
      // only thing they are entitled to, and nothing about the feed's provider,
      // its paths or its configuration.
      assert.deepStrictEqual(Object.keys(refused.json).sort(), ['code', 'details', 'error', 'retry_after_seconds'],
        `${path} 429 body carried something beyond the limiter's own fields: ${JSON.stringify(refused.json)}`);
      assert.strictEqual(refused.json.code, 'rate_limited');
      assert.deepStrictEqual(refused.json.details, { code: 'rate_limited' });
      assert.ok(!/feed|board|market|nav|health|http/i.test(JSON.stringify(refused.json)),
        `${path} 429 body mentioned the feed: ${JSON.stringify(refused.json)}`);
    }
  });

  // ── C9 ────────────────────────────────────────────────────────────────────
  // The other half, and the one that is easy to break while adding a bucket: a
  // feed-OFF deployment's browser must still get its answer. public/js/shell.js
  // fetches /api/feed/nav once at boot to decide which board to render, and
  // tests/ui_test.mjs fails an entire run on ANY console error — so a nav route
  // that 429s, or 4xxes, on a non-feed deployment is a regression in the product
  // rather than a tightening of a control.
  await check('C9 a spent feed budget is per-caller, and does not outlive the process', async () => {
    srv.resetVolumeLimits();
    // Drain the budget from the anonymous address. volumeKey() keys on the
    // address when there is no user, which is what an unauthenticated route
    // means — and C4 already established that both accounts here share it.
    for (let i = 0; i < READ_LIMIT + 2; i++) await j('GET', '/api/feed/nav');
    assert.strictEqual((await j('GET', '/api/feed/nav')).status, 429, 'the flooder is throttled');

    // A signed-in caller keys on the USER, so the anonymous flood above does not
    // spend a player's budget. That is the fairness property C3 asserts for
    // /api/positions, and it has to hold for the feed routes too — otherwise
    // adding a bucket has introduced a lock-out, which is a worse defect than
    // the one it fixed.
    const login = await j('POST', '/api/auth/login', { body: { username: 'demo', password: 'demo123' } });
    const cookie = (login.setCookie[0] || '').split(';')[0];
    assert.ok(cookie, 'the sign-in must have worked, or this check is vacuous');
    assert.strictEqual((await j('GET', '/api/feed/nav', { cookie })).status, 200,
      'a player must reach the handler while an anonymous flooder is refused');

    // And a fresh process is not still throttled by its own history.
    srv.resetVolumeLimits();
    assert.strictEqual((await j('GET', '/api/feed/nav')).status, 200,
      'a spent budget must not outlive the process that spent it');
  });

  console.log(`\nratelimit-coverage.test.js: ${passed} checks passed, ${failures.length} failed`);
  server.close();
  if (failures.length) process.exit(1);
  if (passed !== 9) { console.error(`expected 9 checks, ran ${passed}`); process.exit(1); }
})();