'use strict';
// tests/feedboot-line.test.js — what the venue says about the odds feed when it
// is not ok: the boot line, and GET /api/feed/health.
//
// Run: node tests/feedboot-line.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. `main()` printed the feed's health at boot from inside a
// `.then()` on a live Postgres probe. Nothing offline can call it: `health()`
// needs a connection string, `main()` needs a listening socket, and the line is
// built from whatever the probe returned. So a line that was wrong in two
// independent ways shipped with nothing that could fail:
//
//   h.age_seconds  health() returns `odds_age_seconds`. Both reads were
//                  `undefined`, so the ternary ALWAYS took the "unknown"
//                  branch — on a feed the server had just queried successfully.
//   h.stale        health() returns no such field, so "(STALE)" could never
//                  be printed.
//
// AND the branch that mattered most never ran at all. `healthPayload` sets
// `ok: !!newest && age < FEED_STALE_SECONDS` and sets NO `error` field, so a
// STALE feed arrived as `{ok:false}` with `h.error === undefined` and the line
// printed `[feed] unreachable: undefined`. The condition the line exists to
// report was reported as an unreachable feed, with no message at all.
//
// ── WHY THE HTTP ROUTE IS IN THIS FILE (#85) ───────────────────────────────
// The correction above was applied to the boot line ONLY. `GET /api/feed/health`
// was the same reader of the same payload, elsewhere in the same file, and it was
// missed: it logged `(h.error || h.detail) || '(no detail)'` — two fields
// `healthPayload` never sets, so it printed `(no detail)` on every stale feed —
// and answered a fixed `503 {ok:false, error:'Odds feed unavailable'}` for a
// stale feed and an unreachable one alike. The boot line could tell them apart,
// had a test proving it, and the twin still could not.
//
// That is the defect worth preventing: not one wrong line, but ONE rule copied to
// two sites with a test on one of them. So the rule now lives once
// (`classifyHealth`, in lib/feed.js next to the payload it reads) and the checks
// below drive BOTH readers with the same fixtures — the boot line directly, the
// route over its registered handler. Re-introducing a second copy of the
// discriminator, on either site, fails here rather than at 3am.
//
// So the line is a PURE function (`feedBootStatus`) fed here by the REAL
// `healthPayload`, which means the fixture cannot drift from what the server
// actually receives: if health() stops returning a field, this file changes
// with it.
//
// WHY THE HARNESS HERE DOES NOT HIDE ITS OWN FAILURES. The sibling suite
// (tests/resultsfeed-signal-shape.test.js) exits on its FIRST failure, so in a
// naive run one red check masks every check after it and the rest ship
// unverified. This file reports EVERY failure and only then fails — so "the file
// went red" is a statement about the whole file, not about whichever check
// happened to be registered first.
process.env.DB_PATH = ':memory:';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.SCRYPT_N = '16384';
// The HTTP route answers 409 before it looks at the feed at all, so without this
// the route checks below would measure the disabled branch and pass while the
// bug they exist for stayed unfixed. lib/config.js reads it at import, so it is
// pinned here — above the `require('../server')` below — and nowhere later.
process.env.FEED_ENABLED = 'true';
// Required by lib/config.js whenever FEED_ENABLED is set, and deliberately a URL
// nothing listens on (port 59999 is reserved). It is never dialled: the route
// checks below replace the probe, so this only has to satisfy config validation.
process.env.FEED_DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:59999/nope';
// Pinned so `healthPayload`'s own `ok` is deterministic: it compares the frame
// age against THIS value, and the fixtures below are stated in seconds.
process.env.FEED_STALE_SECONDS = '300';

const assert = require('assert');
const { healthPayload } = require('../lib/feed');
const { feedBootStatus } = require('../server');

const STALE_SECONDS = 300;
const NOW = Date.parse('2026-10-15T00:00:00.000Z');
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

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

/** A priced feed that polled `seconds` ago, exactly as health() would report it. */
function priced(seconds) {
  return healthPayload({
    row: {
      markets: 9976,
      markets_with_odds: 4100,
      resolved: 12,
      newest_book: ago(seconds),
      oldest_book: ago(seconds + 600),
      newest_publish: ago(seconds + 5000),
    },
    delay: { is_delay: false, source: 'collector' },
    hasPrices: true,
    feed: 2,
    now: NOW,
  });
}

/** A priced feed the collector has never captured an odds frame for. */
function neverPolled() {
  return healthPayload({
    row: { markets: 9976, markets_with_odds: 0, resolved: 12, newest_book: null, oldest_book: null, newest_publish: null },
    delay: { is_delay: true, source: 'assumed' },
    hasPrices: true,
    feed: 2,
    now: NOW,
  });
}

/**
 * Invoke the REGISTERED /api/feed/health handler with a stub `res` and a stubbed
 * probe; returns what it sent and what it logged.
 *
 * The handler is pulled off the Express stack rather than driven over a socket,
 * the way tests/feed.test.js calls the nav route: what regressed was the BODY the
 * route builds, not the middleware around it, and binding a port to look at one
 * JSON body is a flake waiting to happen.
 *
 * `health` is swapped because the probe needs a live recorder database and the
 * condition under test is decided by the payload, not by the database — which is
 * also what makes this offline: the fixtures above ARE what the server receives.
 * Restored in a `finally`, and a `next` is supplied so a route that passes an
 * error down is RECORDED and reported rather than surfacing as an unhandled
 * rejection with the check's name missing.
 */
async function healthCall(probe) {
  const srv = require('../server');
  const feed = require('../lib/feed');
  const router = srv.app.router || srv.app._router;
  assert.ok(
    router && Array.isArray(router.stack),
    `neither app.router nor app._router exposes a stack (app.router=${typeof srv.app.router}); ` +
    'the Express introspection this helper relies on has changed again'
  );
  const layer = router.stack.find((l) => l.route && l.route.path === '/api/feed/health');
  assert.ok(layer, 'no /api/feed/health route is registered — the checks below would be measuring nothing');
  const stack = layer.route.stack || [];
  const handler = stack[stack.length - 1] && stack[stack.length - 1].handle;
  assert.strictEqual(typeof handler, 'function', 'the /api/feed/health route has no handler function');

  const originalProbe = feed.health;
  const originalError = console.error;
  const logs = [];
  let thrown = null;
  feed.health = probe;
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  const sent = { code: null, body: null };
  const res = {
    status(c) { sent.code = c; return this; },
    // Express's own res.json() sends 200 when no status was set, so the stub does
    // too — otherwise a healthy route reads as "answered nothing" and a check
    // about the success path fails for a reason that has nothing to do with it.
    json(b) { if (sent.code === null) sent.code = 200; sent.body = b; return this; },
  };
  try {
    await handler({}, res, (e) => { thrown = e; });
  } finally {
    feed.health = originalProbe;
    console.error = originalError;
  }
  assert.strictEqual(thrown, null, `the route passed an error down instead of answering: ${thrown && thrown.message}`);
  assert.ok(sent.body, 'the route sent no body at all');
  return { code: sent.code, body: sent.body, logs };
}

(async () => {
  // ── F1 ────────────────────────────────────────────────────────────────────
  // The field-name bug, stated as "the number the payload carries must appear in
  // the line". If the line reads any other property this is "unknown", and the
  // check fails on the rendered text rather than on a flag the implementation
  // could satisfy by setting.
  await check('F1 a healthy feed\'s line carries the frame age health() actually returned', () => {
    const h = priced(100);
    // Precondition: the payload really does carry the age, under THIS name.
    assert.strictEqual(h.odds_age_seconds, 100, 'fixture drift: expected a 100s-old frame');
    const { message, level } = feedBootStatus(h, STALE_SECONDS);
    assert.ok(
      message.includes('100s old'),
      `the line must carry the age health() returned; got: ${message}`
    );
    assert.ok(
      !/unknown/i.test(message),
      `a feed we just queried cannot have an unknown frame age; got: ${message}`
    );
    assert.ok(!/\(STALE\)/.test(message), `100s is inside the 300s threshold; got: ${message}`);
    assert.strictEqual(level, 'log', 'a healthy feed is not a warning');
  });

  // ── F2 ────────────────────────────────────────────────────────────────────
  // The condition the whole line exists for. This is the one that could not be
  // printed before: it did not arrive on the `ok` branch, and the else branch
  // could only print `unreachable: ${h.error}` — and a stale payload has no
  // `error`.
  await check('F2 a stale feed is reported as STALE, not as unreachable with no message', () => {
    const h = priced(5000); // well past the 300s threshold
    assert.strictEqual(h.ok, false, 'fixture drift: a 5000s-old frame must not be ok');
    assert.strictEqual(h.error, undefined, 'fixture drift: healthPayload sets no error field');
    const { message, level } = feedBootStatus(h, STALE_SECONDS);
    assert.ok(
      /\(STALE\)/.test(message),
      `a stale feed must be labelled STALE; got: ${message}`
    );
    assert.ok(
      message.includes('5000s old'),
      `and must still report the age it measured; got: ${message}`
    );
    assert.ok(
      !/unreachable/.test(message),
      `stale is not unreachable, and "unreachable" with no reason is the bug; got: ${message}`
    );
    assert.notStrictEqual(level, 'log', 'a stale feed must not be logged as fine');
  });

  // ── F3 ────────────────────────────────────────────────────────────────────
  // Stale with NO age at all: the collector has never captured an odds frame.
  // `age` is null and the old ternary printed "unknown" here — which reads as a
  // missing measurement rather than the missing data it actually is.
  await check('F3 a priced feed with no odds frame says so, and is flagged', () => {
    const h = healthPayload({
      row: { markets: 9976, markets_with_odds: 0, resolved: 0, newest_book: null, oldest_book: null, newest_publish: null },
      delay: { is_delay: true, source: 'assumed' },
      hasPrices: true,
      feed: 2,
      now: NOW,
    });
    assert.strictEqual(h.ok, false, 'fixture drift: a feed with no frame must not be ok');
    assert.strictEqual(h.odds_age_seconds, null);
    const { message } = feedBootStatus(h, STALE_SECONDS);
    assert.ok(
      !/unknown/i.test(message),
      `"unknown" claims a measurement is missing; no frame was ever recorded; got: ${message}`
    );
    assert.ok(
      /\(STALE\)/.test(message),
      `a priced feed with no frame is not healthy; got: ${message}`
    );
  });

  // ── F4 ────────────────────────────────────────────────────────────────────
  // Feed 1 has no odds columns at all. `ok` is always true there BY DESIGN, so
  // the `ok` branch is taken and there is no frame to report — the one case
  // where "no frame age" is the correct, complete answer rather than a defect.
  await check('F4 an unpriced feed says it carries no prices rather than reporting an unknown age', () => {
    const h = healthPayload({
      row: { markets: 1234, markets_with_odds: 0, resolved: 210, newest_book: null, oldest_book: null, newest_publish: null },
      delay: { is_delay: true, source: 'assumed' },
      hasPrices: false,
      feed: 1,
      now: NOW,
    });
    assert.strictEqual(h.ok, true, 'fixture drift: feed 1 is ok by design');
    const { message, level } = feedBootStatus(h, STALE_SECONDS);
    assert.ok(
      /feed 1/.test(message) && /no prices/i.test(message),
      `a feed with no price columns must say so; got: ${message}`
    );
    assert.ok(!/unknown/i.test(message), `and must not claim an unknown frame age; got: ${message}`);
    assert.notStrictEqual(level, 'warn', 'nothing on feed 1 can go stale');
  });

  // ── F5 ────────────────────────────────────────────────────────────────────
  // The genuine unreachable case, which is the ONE payload that carries `error`
  // — health() returns it only when the probe itself threw. If this branch ever
  // collapses into the stale branch, the operator loses the distinction between
  // "could not ask" and "asked, and it is out of date".
  await check('F5 a probe that could not run is still reported as unreachable, with the reason', () => {
    const h = { ok: false, error: 'Odds feed unavailable' };
    const { message, level } = feedBootStatus(h, STALE_SECONDS);
    assert.ok(/unreachable/.test(message), `got: ${message}`);
    assert.ok(message.includes('Odds feed unavailable'), `the reason must survive; got: ${message}`);
    assert.ok(!/\(STALE\)/.test(message), `we never learned an age, so STALE is a claim we cannot make; got: ${message}`);
    assert.strictEqual(level, 'error');
  });

  // ── F6 ────────────────────────────────────────────────────────────────────
  // The line must depend only on fields health() RETURNS. Before the fix it
  // read `age_seconds` and `stale`; a payload carrying exactly those two fields
  // and none of the real ones produced a fully-populated, confident, wrong
  // line. Asserting the absence of that coupling means re-introducing it fails
  // here even if some other check is edited to tolerate it.
  await check('F6 the line ignores field names health() does not return', () => {
    const real = priced(100);
    const impostor = { ...real, age_seconds: 100, stale: true };
    delete impostor.odds_age_seconds;
    // The impostor claims a healthy, 100s-old frame using the two names the old
    // line read. Before the fix this rendered "newest frame 100s old (STALE)" —
    // a fully confident line built entirely from fields health() never returns.
    const line = feedBootStatus(impostor, STALE_SECONDS);
    assert.ok(
      !/100s old/.test(line.message),
      `a payload carrying no odds_age_seconds must not report an age; got: ${line.message}`
    );
    assert.ok(
      !/\(STALE\)/.test(line.message),
      `and must not claim staleness from a field health() does not return; got: ${line.message}`
    );
    // And the real payload must render identically whether or not the
    // non-existent fields are attached, which is the whole point.
    const withJunk = feedBootStatus({ ...real, age_seconds: 1, stale: false }, STALE_SECONDS);
    assert.strictEqual(
      withJunk.message,
      feedBootStatus(real, STALE_SECONDS).message,
      'fields health() does not return must not change the line'
    );
  });

  // ── F7 ────────────────────────────────────────────────────────────────────
  // The threshold is the operator's, not a constant baked into the line. A
  // frame health() calls fine must still be flagged when the operator has
  // configured a window tighter than health() assumed — otherwise the line
  // reports a fixed threshold nobody chose.
  //
  // The other half is the direction that matters. A caller's window may only
  // make the verdict MORE severe, never less: health() already said the feed is
  // not usable, and a loose threshold must not be able to talk it out of that
  // and print a healthy line.
  await check('F7 the operator\'s threshold tightens the verdict and can never soften it', () => {
    const h = priced(100);
    assert.strictEqual(h.ok, true, 'fixture drift: 100s is inside the 300s default');
    assert.ok(
      !/\(STALE\)/.test(feedBootStatus(h, 300).message),
      '100s inside a 300s window is not stale'
    );
    assert.ok(
      /\(STALE\)/.test(feedBootStatus(h, 50).message),
      'but the same frame is stale against a 50s window — the threshold is the operator\'s'
    );

    // Now the direction that must not move: health()'s own not-ok verdict.
    const bad = priced(5000);
    assert.strictEqual(bad.ok, false, 'fixture drift: 5000s is past the 300s default');
    assert.ok(
      /\(STALE\)/.test(feedBootStatus(bad, 6000).message),
      'a feed health() called unhealthy must stay flagged under a looser window'
    );
  });

  // ── F8 ────────────────────────────────────────────────────────────────────
  // "Same class, nearby" from the issue: a comment in server.js says the
  // readiness reason is useless without knowing "which of five conditions is
  // missing". lib/feedrunner.js's readiness() refuses on FOUR. A comment
  // asserting a count with nothing that fails when the count is wrong is the
  // same failure mode as the line above it, so it is checked mechanically.
  await check('F8 the comment\'s condition count matches the code it describes', () => {
    const src = require('fs').readFileSync(require.resolve('../server.js'), 'utf8');
    const m = src.match(/which of (\w+) conditions is missing/);
    assert.ok(m, 'the comment this check pins should still be there; if it was reworded, reword the check too');
    // The comment spells the number out in words, and `Number('five')` is NaN —
    // which would make this check pass or fail for a reason unrelated to the
    // code. Map it, and refuse a word that is not in the map.
    const WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const claim = WORDS[m[1].toLowerCase()];
    assert.ok(claim, `cannot read "${m[1]}" as a number; extend WORDS or reword the comment`);
    const frun = require('fs').readFileSync(require.resolve('../lib/feedrunner.js'), 'utf8');
    // readiness() only: slice to the next top-level function, so a refusal
    // branch anywhere else in the module cannot inflate the count.
    const start = frun.indexOf('function readiness()');
    assert.ok(start > 0, 'feedrunner.readiness() was not found — the check is measuring nothing');
    const body = frun.slice(start, frun.indexOf('\nfunction ', start + 1));
    // `ready: false` rather than `return { ready: false`: one refusal returns a
    // multi-line object, and matching the opening brace would silently count
    // three of four.
    const refusals = (body.match(/ready: false/g) || []).length;
    assert.ok(refusals > 1, `expected several refusal branches, found ${refusals} — the check is not measuring anything`);
    assert.strictEqual(
      claim,
      refusals,
      `the comment says ${claim} conditions; feedrunner readiness() refuses on ${refusals}`
    );
  });

  // ── R1: the two conditions answer DIFFERENT bodies ───────────────────────
  // The wire-level half of #85. Before the fix both of these payloads were
  // discarded and replaced with one fixed `503 {ok:false, error:'Odds feed
  // unavailable'}`, so a client could not tell a collector that had stopped
  // polling from a database that was down — and neither could an operator reading
  // the response.
  await check('R1 a stale feed and an unreachable feed are not the same answer', async () => {
    const stale = priced(5000);
    const dead = { ok: false, error: 'Odds feed unavailable' }; // health()'s shape when the probe itself threw
    // Pre-state: the two payloads really are as far apart as the rule says, and
    // the age the client needs is computed on the stale one. Without these the
    // rest of the check could pass on a fixture that no longer means "stale".
    assert.strictEqual(stale.ok, false, 'fixture drift: a 5000s-old frame must not be ok');
    assert.strictEqual(stale.error, undefined, 'fixture drift: healthPayload sets no error field');
    assert.strictEqual(stale.odds_age_seconds, 5000, 'fixture drift: expected a 5000s-old frame');
    assert.ok(dead.error, 'fixture drift: health() reports an unreachable probe with an error');

    const a = await healthCall(async () => stale);
    const b = await healthCall(async () => dead);
    assert.strictEqual(a.code, 503, `a stale feed is still a 503; got ${a.code} ${JSON.stringify(a.body)}`);
    assert.strictEqual(b.code, 503, `an unreachable feed is still a 503; got ${b.code} ${JSON.stringify(b.body)}`);
    assert.notStrictEqual(
      JSON.stringify(a.body),
      JSON.stringify(b.body),
      'a stale feed and an unreachable feed must not be byte-identical: the polling loop and the database are different pages of the same runbook (#85)'
    );
    assert.strictEqual(a.body.code, 'feed_stale', 'a stale feed needs its own code to branch on');
    assert.strictEqual(a.body.odds_age_seconds, 5000, 'the age is the diagnostic the 503 used to discard');
    assert.strictEqual(a.body.stale_after_seconds, STALE_SECONDS, 'an age with no window it broke is not a verdict');
    assert.strictEqual(b.body.code, 'feed_unavailable', 'unreachable keeps the code the other feed routes use');
    assert.strictEqual(b.body.odds_age_seconds, null, 'nothing measured is null — never zero, which reads as a fresh frame');
  });

  // ── R2: the log line, which exists to name the condition ─────────────────
  await check('R2 the failure log names the condition instead of printing "(no detail)"', async () => {
    const h = priced(5000);
    // Pre-state, and the whole reason the old line was useless: healthPayload sets
    // NEITHER `error` nor `detail`, so `h.error || h.detail` was undefined on
    // every stale feed and the line printed `(no detail)` every time.
    assert.strictEqual(h.error, undefined, 'fixture drift: healthPayload sets no error field');
    assert.strictEqual(h.detail, undefined, 'fixture drift: healthPayload sets no detail field');
    assert.strictEqual(h.odds_age_seconds, 5000, 'fixture drift: expected a 5000s-old frame');

    const { logs } = await healthCall(async () => h);
    const line = logs.join('\n');
    assert.ok(logs.length > 0, 'the route refused to serve and said nothing about why');
    assert.ok(!line.includes('(no detail)'), `the log must not fall back to "(no detail)"; got: ${line}`);
    assert.ok(/\bstale\b/i.test(line), `the log must name the condition it is reporting; got: ${line}`);
    assert.ok(line.includes('5000'), `and carry the age that identifies it; got: ${line}`);
    assert.ok(line.includes(String(STALE_SECONDS)), `and the window that age broke; got: ${line}`);
  });

  // ── R3: the two readers, pinned against each other ──────────────────────
  // THE defect class, not the defect. One payload, two readers, one rule: if
  // either site is corrected alone, or a second copy of the discriminator is
  // introduced on either, the two disagree about the same feed and this fails.
  // Checked per condition rather than in a loop so a regression says WHICH feed.
  const TWINS = [
    { label: 'a stale feed', h: priced(5000), status: 503, code: 'feed_stale', stale: true, level: 'warn' },
    { label: 'an unreachable feed', h: { ok: false, error: 'Odds feed unavailable' }, status: 503, code: 'feed_unavailable', stale: false, level: 'error' },
    { label: 'a feed with no odds frame ever recorded', h: neverPolled(), status: 503, code: 'feed_stale', stale: true, level: 'warn' },
    { label: 'a fresh feed', h: priced(100), status: 200, code: null, stale: false, level: 'log' },
  ];
  for (const t of TWINS) {
    // eslint-disable-next-line no-await-in-loop
    await check(`R3 the route and the boot line reach ONE verdict — ${t.label}`, async () => {
      const boot = feedBootStatus(t.h, STALE_SECONDS);
      const r = await healthCall(async () => t.h);
      assert.strictEqual(boot.level, t.level, `boot line level: ${boot.message}`);
      assert.strictEqual(
        /\(STALE\)/.test(boot.message), t.stale,
        `boot line staleness: ${boot.message}`
      );
      assert.strictEqual(r.code, t.status, `expected ${t.status}, got ${r.code} ${JSON.stringify(r.body)}`);
      if (t.code === null) {
        // The healthy path is unchanged: still the WHOLE payload. The fields the
        // 503 now publishes were never removed from the 200.
        assert.strictEqual(r.body.odds_age_seconds, 100, 'the healthy payload lost its age');
        assert.ok(!r.body.code, 'a healthy feed must not carry an error code');
        return;
      }
      assert.strictEqual(r.body.code, t.code, `expected code ${t.code}, got ${JSON.stringify(r.body)}`);
      // The twin assertion proper: what one reader says, the other must not contradict.
      assert.strictEqual(
        r.body.code === 'feed_stale', /\(STALE\)/.test(boot.message),
        `the route answered "${r.body.code}" while the boot line said "${boot.message}" — one payload, two conditions`
      );
    });
  }

  // ── R4: the two error PATHS, one response ────────────────────────────────
  // health() catches its own driver errors and answers `{ok:false, error}`, so
  // the route's `catch` is the defensive branch — it is what runs if that ever
  // changes. It must still be the same response: to a client, "the probe threw"
  // and "the probe answered unreachable" are one event.
  await check('R4 a probe that THREW and a probe that answered not-ok are one response', async () => {
    const threw = await healthCall(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 nobody@collector');
    });
    const answered = await healthCall(async () => ({ ok: false, error: 'Odds feed unavailable' }));
    assert.strictEqual(threw.code, 503, `expected a 503 from a throwing probe, got ${threw.code}`);
    assert.deepStrictEqual(
      threw.body, answered.body,
      'the thrown path and the answered path must be shaped by one shaper, or they will drift'
    );
    assert.strictEqual(threw.body.code, 'feed_unavailable');
    assert.ok(
      !/ECONNREFUSED|10\.0\.0\.5|nobody@|postgres:\/\//i.test(JSON.stringify(threw.body)),
      `driver detail reached a body a client can read: ${JSON.stringify(threw.body)}`
    );
  });

  // ── R5: the error shaper, on the body this fix changed ───────────────────
  await check('R5 the stale 503 keeps the apiError() contract — error, code, then the diagnostics', async () => {
    const r = await healthCall(async () => priced(5000));
    assert.strictEqual(r.code, 503);
    assert.deepStrictEqual(
      Object.keys(r.body).slice(0, 2), ['error', 'code'],
      `the well-known keys must stay in a predictable position in every body; got ${Object.keys(r.body).join(', ')}`
    );
    assert.ok(typeof r.body.error === 'string' && r.body.error.length > 0, 'the human string must still be there');
    assert.strictEqual(r.body.ok, false, 'a refusal body must still say ok:false');
    assert.ok(!('details' in r.body), `details is stripped from a 5xx; got ${JSON.stringify(r.body)}`);
  });

  // ── R6: the reference, which is the contract ─────────────────────────────
  // Noted in passing by #85: the success payload was documented with `ok` in it,
  // where it can only ever be true — this route serves a 200 only when `ok` is
  // truthy. A client told `ok` is part of the success shape will branch on it and
  // learn nothing, and the one place its value means anything is the 503, which
  // documents it separately.
  await check('R6 the documented success payload names only real fields, and not the one that is always true', () => {
    const doc = require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'API.md'), 'utf8');
    // The ROUTE row, not the first line that mentions the path: the error-code
    // table also names this route, and matching the first mention found the
    // `feed_stale` row and reported a payload it never claimed to document.
    const row = doc.split('\n').find((l) => /^\|\s*`GET \/api\/feed\/health`/.test(l));
    assert.ok(row, 'docs/API.md no longer has a route-table row for GET /api/feed/health — reword this check, do not delete it');
    const list = row.match(/`\s*200\s*\{([^}]*)\}`/);
    assert.ok(list, `could not read the documented success payload out of: ${row}`);
    const fields = list[1].split(',').map((s) => s.trim()).filter(Boolean);
    assert.ok(fields.length > 3, `the row no longer lists a payload to check; got ${JSON.stringify(fields)}`);
    assert.ok(
      !fields.includes('ok'),
      `the success payload must not document \`ok\`: on a 200 it is always true, so it promises a branch that cannot fire (got ${JSON.stringify(fields)})`
    );
    const real = priced(10);
    const unknown = fields.filter((f) => !(f in real));
    assert.deepStrictEqual(
      unknown, [],
      `docs/API.md promises fields healthPayload does not return: ${unknown.join(', ')} (it returns ${Object.keys(real).join(', ')})`
    );
  });

  console.log(`\nfeedboot-line.test.js: ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
  if (passed !== 17) { console.error(`expected 17 checks, ran ${passed}`); process.exit(1); }
})();