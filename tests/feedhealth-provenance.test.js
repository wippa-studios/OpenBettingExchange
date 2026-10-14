'use strict';
// tests/feedhealth-provenance.test.js — WHO CLOCK does a health number belong to?
//
// Run: node tests/feedhealth-provenance.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. `/api/feed/health` publishes two age numbers that LOOK
// like they answer different questions and do not:
//
//   odds_age_seconds   when WE last polled      — `max(odds_captured_at)`
//   data_age_seconds   how old the DATA is      — claimed, in prose, to be
//                                                Betfair's `publish_time`
//
// Both were computed from `max(odds_captured_at)`. So on a live key
// `data_age_seconds` was numerically IDENTICAL to `odds_age_seconds`, and
// `delay_note` told the operator it was the provider's timestamp. It was not.
//
// This is the file's own stated principle, inverted. lib/feed.js's header
// argues at length that a freshness number measuring when WE polled "is a
// number that will be misread as freshness by anyone who glances at it — so it
// is never called data_age". Having chosen the name, it then filled it with our
// own poll time and attributed it to Betfair in prose. The two paths were also
// inconsistent in the honest direction: on a Delay key the field was a null WITH
// an explanation; on a live key it was a number with an explanation that was
// false, which is strictly worse — a null cannot be misread, a number will be.
//
// WHY THE HARNESS HERE DOES NOT HIDE ITS OWN FAILURES. The sibling suite
// (tests/resultsfeed-signal-shape.test.js) exits on its FIRST failure, so in a
// naive run one red check masks every check after it and the rest ship
// unverified. This file reports EVERY failure and only then fails — so "the file
// went red" is a statement about the whole file, not about whichever check
// happened to be registered first.
const assert = require('assert');
const { healthPayload, healthSql } = require('../lib/feed');

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

/**
 * A probe row in which the two clocks are DELIBERATELY far apart.
 *
 * The gap is the whole test. If both ages were read from the same column they
 * would be equal and any assertion about "which clock is this" would pass for
 * the wrong reason — an absurd-value check that bites nothing. A feed on a Live
 * key polls on a 5-minute cadence and Betfair's own publish_time is seconds old,
 * so a 100s poll against a 5000s publish is not a synthetic shape: it is a feed
 * that has been broken for an hour and says so.
 */
const ROW = {
  markets: 4321,
  markets_with_odds: 4100,
  resolved: 12,
  newest_book: ago(100),      // we polled 100 seconds ago
  oldest_book: ago(600),
  newest_publish: ago(5000),  // Betfair last published 5000 seconds ago
};

(async () => {
  // ── H1 ────────────────────────────────────────────────────────────────────
  await check('H1 a live key measures data_age_seconds from publish_time, not from our poll time', async () => {
    const h = healthPayload({
      row: ROW,
      delay: { is_delay: false, source: 'collector' },
      hasPrices: true,
      now: NOW,
    });
    // Our poll and Betfair's publish must not be the same instant here, or the
    // assertion below would be satisfied by any implementation.
    assert.notStrictEqual(ROW.newest_book, ROW.newest_publish, 'the two clocks must differ');

    assert.strictEqual(h.odds_age_seconds, 100, 'our poll age is still the poll age');
    assert.strictEqual(
      h.data_age_seconds,
      5000,
      `data_age_seconds must be Betfair's age of the data (5000s), not ours (100s); got ${h.data_age_seconds}`
    );
    assert.notStrictEqual(
      h.data_age_seconds,
      h.odds_age_seconds,
      'two names for one clock is the bug: they must now measure different things'
    );
  });

  // ── H2 ────────────────────────────────────────────────────────────────────
  await check('H2 a delay key publishes a null rather than a number, and says why', async () => {
    const h = healthPayload({
      row: ROW,
      delay: { is_delay: true, source: 'collector' },
      hasPrices: true,
      now: NOW,
    });
    assert.strictEqual(h.app_key_delay, true);
    // Not "a number that happens to be 100" — a number is what gets misread.
    assert.strictEqual(h.data_age_seconds, null, 'a Delay key cannot measure data age');
    assert.match(h.delay_note, /withholds publish_time/i, 'and the note must say that');
    assert.ok(
      !/measured from Betfair publish_time/i.test(h.delay_note),
      'the live-key sentence must not appear on a delay key'
    );
  });

  // ── H3 ────────────────────────────────────────────────────────────────────
  // The claim the issue actually makes: "a comment and a string literal drift
  // apart silently, because nothing fails when either is wrong." So check the
  // NOTE against the VALUE, in every branch, rather than checking either alone.
  await check('H3 the delay_note and data_age_seconds agree in all three branches', async () => {
    const branches = [
      ['delay key', { is_delay: true, source: 'collector' }],
      ['live key with publish_time', { is_delay: false, source: 'collector' }],
      // A live key whose books carry no publish_time is reachable: the column is
      // null per row, and `max()` over nulls is null. Before this was handled,
      // this branch produced a note promising a measurement it had not made.
      ['live key with no publish_time', { is_delay: false, source: 'collector' }],
    ];
    for (const [label, delay] of branches) {
      const row = label.includes('no publish_time') ? { ...ROW, newest_publish: null } : ROW;
      const h = healthPayload({ row, delay, hasPrices: true, now: NOW });
      const claimsPublish = /measured from Betfair publish_time/i.test(h.delay_note);
      if (claimsPublish) {
        // If the note claims it, the number must BE that — and must not be our
        // own poll time wearing the provider's name.
        assert.strictEqual(
          h.data_age_seconds,
          5000,
          `${label}: the note claims a publish_time measurement, so data_age_seconds must be 5000, got ${h.data_age_seconds}`
        );
        assert.notStrictEqual(
          h.data_age_seconds,
          h.odds_age_seconds,
          `${label}: a note attributing provenance must not be backed by our own poll time`
        );
      } else {
        assert.strictEqual(
          h.data_age_seconds,
          null,
          `${label}: with no claim of a measurement, data_age_seconds must be null, got ${h.data_age_seconds}`
        );
      }
      // A null must never be dressed as a measurement in either direction.
      assert.ok(
        typeof h.delay_note === 'string' && h.delay_note.length > 0,
        `${label}: a field nobody can explain is how this started`
      );
    }
  });

  // ── H4 ────────────────────────────────────────────────────────────────────
  await check('H4 an ASSUMED delay flag is published, not indistinguishable from a read one', async () => {
    // The probe selects `feed_run.payload`, which the collector's feed_run does
    // not have, so the query raises and the fallback `is_delay: true` is taken on
    // every call. `app_key_delay: true` therefore carries no information at all
    // unless the payload says WHERE it came from — and it did not.
    const assumed = healthPayload({
      row: ROW, delay: { is_delay: true, source: 'assumed' }, hasPrices: true, now: NOW,
    });
    const read = healthPayload({
      row: ROW, delay: { is_delay: true, source: 'collector' }, hasPrices: true, now: NOW,
    });
    assert.strictEqual(assumed.app_key_delay_source, 'assumed');
    assert.strictEqual(read.app_key_delay_source, 'collector');
    assert.notStrictEqual(
      assumed.app_key_delay_source,
      read.app_key_delay_source,
      'a flag that cannot be told from an assumed one tells an operator nothing'
    );
    assert.match(assumed.delay_note, /assumed/i, 'and the note must not imply it was read');
  });

  // ── H5 ────────────────────────────────────────────────────────────────────
  await check('H5 the probe actually selects the timestamp the payload now claims', async () => {
    // Without this, H1 could be satisfied by a fixture that never reaches SQL.
    assert.match(
      healthSql(2),
      /max\(publish_time\)\s+AS newest_publish/,
      'a priced probe must aggregate Betfair publish_time under the alias the payload reads'
    );
    // Feed 1 has no price columns at all, so the alias must still be PRESENT as
    // a typed null: healthPayload reads one row shape for both feeds, and a
    // missing key would be an `undefined` where a typed null is an answer.
    assert.match(
      healthSql(1),
      /NULL::timestamptz\s+AS newest_publish/,
      'a feed-1 probe must type the column null rather than omit it'
    );
    assert.ok(
      !/publish_time/.test(healthSql(1).replace(/AS newest_publish/, '')),
      'and must not name the underlying column v_feed1 does not have'
    );
    assert.match(healthSql(2), /max\(odds_captured_at\)/, 'the poll clock is still measured');
  });

  // ── H6 ────────────────────────────────────────────────────────────────────
  await check('H6 an unpriced feed still answers, and still cannot be stale', async () => {
    // Feed 1 has no odds columns at all, so the row is typed nulls. This must
    // not throw, and must not invent a data age.
    const h = healthPayload({
      row: { markets: 1234, markets_with_odds: 0, resolved: 210, newest_book: null, oldest_book: null, newest_publish: null },
      delay: { is_delay: true, source: 'assumed' },
      hasPrices: false,
      feed: 1,
      now: NOW,
    });
    assert.strictEqual(h.ok, true, 'nothing on feed 1 can go stale');
    assert.strictEqual(h.feed, 1);
    assert.strictEqual(h.priced, false);
    assert.strictEqual(h.markets, 1234);
    assert.strictEqual(h.odds_age_seconds, null);
    assert.strictEqual(h.data_age_seconds, null);
  });

  console.log(`\nfeedhealth-provenance.test.js: ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
  if (passed !== 6) { console.error(`expected 6 checks, ran ${passed}`); process.exit(1); }
})();