'use strict';
// tests/feedboot-line.test.js — the boot line about the odds feed.
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

  console.log(`\nfeedboot-line.test.js: ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
  if (passed !== 8) { console.error(`expected 8 checks, ran ${passed}`); process.exit(1); }
})();