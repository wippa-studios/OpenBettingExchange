'use strict';
// tests/resultsfeed-pollset.test.js — the poll set is bounded WITHOUT losing a
// market.
//
// Run: node tests/resultsfeed-pollset.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. #39 replaced pendingMarkets()' unsatisfiable predicate
// (which required `events.status = 'completed'` — a state production cannot
// reach) with off-time, so it became a LIVE query for the first time. It has no
// LIMIT, so on a long-running venue whose results feed has quietly stopped
// working, every market that goes off stays in the set forever: the list grows
// and every poll POSTs a larger body to a provider that is not helping.
//
// THE NAIVE FIX IS A TRUNCATION, AND A TRUNCATION IS MONEY. `LIMIT`ing the set
// drops markets silently. A dropped market is never asked about, never settled,
// and never reported — the exact failure the whole results path exists to
// prevent, introduced by the fix for "the list grows". The issue's suggested
// direction (oldest-off markets last) would strand precisely the markets that
// have waited longest, which are the ones most likely to hold a player's money.
//
// So there is no cap on the set, and the bound is on the WIRE instead: the
// request is issued in batches, every market is asked about across all of them,
// and a growing backlog is published and logged so "the feed is fine and nothing
// has finished" is distinguishable from "the feed is fine and 400 markets are
// stuck".
//
// WHY THE HARNESS REPORTS EVERY FAILURE. The sibling suite
// (resultsfeed-signal-shape.test.js) exits on its first failure, so one red
// check hides every check after it. This file accumulates failures and exits
// non-zero at the end, so a red run is a statement about the whole file.
const assert = require('assert');

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';

const { openStore } = require('../lib/store');
const RF = require('../lib/resultsfeed');
const R = require('../lib/results');

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

const URL = 'https://results.example/v1/outcomes';

/** A pending row shaped exactly as results.pendingMarkets emits one. */
const pendingRow = (i) => ({
  id: 1000 + i,
  market_name: `Market ${i}`,
  event_id: 500 + i,
  event_name: `Event ${i}`,
  selection_ids: `${2000 + i}-1,${2000 + i}-2`,
  selection_names: 'Alpha | Beta',
});

/**
 * A transport that records every request body it is asked to send.
 *
 * `reply(n)` is called with the 1-based request number, so a test can fail one
 * specific batch rather than the whole poll.
 */
function recorder(reply = () => ({})) {
  const bodies = [];
  const fetchImpl = async (target, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const payload = reply(bodies.length);
    if (payload instanceof Error) throw payload;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { bodies, fetchImpl };
}

/** Every market id the venue was actually asked about, across every request. */
const askedIds = (bodies) => bodies.flatMap((b) => (b.markets || []).map((m) => m.id));

(async () => {
  // ── P1 ────────────────────────────────────────────────────────────────────
  await check('P1 a poll larger than one batch asks about EVERY pending market', async () => {
    const pending = Array.from({ length: 7 }, (_, i) => pendingRow(i));
    const { bodies, fetchImpl } = recorder();
    RF.resetState();
    const f = RF.createFetcher({ url: URL, fetchImpl, pendingFn: () => pending, batchSize: 2 });

    await f(null);

    // The bound: no single request may carry more than a batch's worth.
    for (const b of bodies) {
      assert.ok(
        b.markets.length <= 2,
        `a request carried ${b.markets.length} markets, more than the batch size of 2`
      );
    }
    assert.strictEqual(bodies.length, 4, 'seven markets at two per request is four requests');

    // And THE POINT: batching is a bound on the wire, not a drop. The union of
    // what we asked about must be the whole set. This is the assertion that
    // fails if anyone "fixes" the growth by adding a LIMIT instead.
    const asked = new Set(askedIds(bodies));
    assert.strictEqual(asked.size, pending.length, 'no market may be asked about twice');
    for (const m of pending) {
      assert.ok(asked.has(m.id), `market ${m.id} was never asked about — it would never settle`);
    }
    // The count must not be satisfied by an absurd value: every id is the one we
    // put in, not merely "some seven ids".
    assert.deepStrictEqual([...asked].sort((a, b) => a - b), pending.map((m) => m.id).sort((a, b) => a - b));
  });

  // ── P1b ───────────────────────────────────────────────────────────────────
  await check('P1b a batch size that is not a usable positive integer is replaced, not obeyed', async () => {
    // Zero slices nothing and would ask about zero markets for ever; Infinity
    // produces no batches at all and returns a SUCCESSFUL poll that asked about
    // nothing. Both lose the whole set silently, which is the one failure mode
    // this module is not allowed to have.
    for (const bad of [0, -1, Infinity, NaN, 'lots', null]) {
      const pending = Array.from({ length: 5 }, (_, i) => pendingRow(i));
      const { bodies, fetchImpl } = recorder();
      RF.resetState();
      const f = RF.createFetcher({ url: URL, fetchImpl, pendingFn: () => pending, batchSize: bad });
      await Promise.race([
        f(null),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`batchSize ${bad} never returned`)), 2000)),
      ]);
      assert.deepStrictEqual(
        new Set(askedIds(bodies)),
        new Set(pending.map((m) => m.id)),
        `batchSize ${JSON.stringify(bad)} lost markets — it must fall back to the default`
      );
      assert.ok(bodies.length >= 1, `batchSize ${JSON.stringify(bad)} sent no request at all`);
    }
  });

  // ── P2 ────────────────────────────────────────────────────────────────────
  await check('P2 the backlog is published, and a growing one says so in the log', async () => {
    RF.resetState();
    const small = Array.from({ length: 2 }, (_, i) => pendingRow(i));
    const big = Array.from({ length: 9 }, (_, i) => pendingRow(i));

    const first = recorder();
    const f1 = RF.createFetcher({ url: URL, fetchImpl: first.fetchImpl, pendingFn: () => small, batchSize: 2 });
    await f1(null);
    assert.strictEqual(RF.health().pending_last_poll, 2, 'the venue must publish how much it asked about');

    // Same transport, a bigger set. The counter is what separates "the feed is
    // fine and nothing has finished" from "the feed is fine and 400 markets are
    // stuck" — which is the only signal that distinguishes them.
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    let poll;
    try {
      const second = recorder();
      poll = RF.createFetcher({ url: URL, fetchImpl: second.fetchImpl, pendingFn: () => big, batchSize: 2 });
      await poll(null);
    } finally {
      console.warn = realWarn;
    }

    const h = RF.health();
    assert.strictEqual(h.pending_last_poll, 9);
    assert.strictEqual(h.pending_peak, 9, 'a high-water mark is what makes growth visible between polls');
    assert.ok(
      warned.some((l) => /9/.test(l)),
      `a backlog that grew must be announced in the log; got ${JSON.stringify(warned)}`
    );

    // And a poll that does NOT grow the backlog must not re-announce it, or the
    // log fills with a line per cycle and stops being read.
    const again = recorder();
    const quiet = RF.createFetcher({ url: URL, fetchImpl: again.fetchImpl, pendingFn: () => big.slice(0, 3), batchSize: 2 });
    const quietLog = [];
    console.warn = (...a) => quietLog.push(a.join(' '));
    try {
      await quiet(null);
    } finally {
      console.warn = realWarn;
    }
    assert.strictEqual(quietLog.length, 0, 'a SHRINKING backlog is good news and must be silent');
  });

  // ── P3 ────────────────────────────────────────────────────────────────────
  await check('P3 a failed batch keeps the earlier batches outcomes AND raises the alarm', async () => {
    const pending = Array.from({ length: 4 }, (_, i) => pendingRow(i));
    // Batches are [1,2] then [3,4]. Answer the first; 503 the second.
    const { bodies, fetchImpl } = recorder((n) => {
      if (n === 2) return new Error('provider is down');
      return { [pending[0].id]: { status: 'completed', winners: [1] } };
    });
    RF.resetState();
    const f = RF.createFetcher({ url: URL, fetchImpl, pendingFn: () => pending, batchSize: 2 });

    const outcomes = await f(null);

    assert.strictEqual(bodies.length, 2, 'both batches were attempted');
    // Discarding everything on a partial failure is how money that was already
    // in hand gets thrown away: these outcomes are real and must survive.
    assert.deepStrictEqual(
      Object.keys(outcomes),
      [String(pending[0].id)],
      'the first batch answered — throwing its outcomes away settles nothing'
    );
    const h = RF.health();
    assert.strictEqual(h.consecutive_failures, 1, 'a failed poll is a failed poll');
    assert.strictEqual(h.status, 'failing', 'and must not read as a working feed');
    assert.ok(h.last_error, 'with a reason recorded');
  });

  // ── P4 ────────────────────────────────────────────────────────────────────
  await check('P4 the real pendingMarkets query is never truncated on the way to the wire', async () => {
    // End to end through the actual query, because the growth this fixes comes
    // from that query, not from a fixture. Seven genuinely off, open, non-held
    // markets — and every one of them must still reach the provider.
    const db = openStore(':memory:');
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football','football')").run();
    const sp = db.prepare('SELECT id FROM sports WHERE slug=?').get('football');
    const marketIds = [];
    for (let i = 0; i < 7; i++) {
      db.prepare("INSERT INTO events (sport_id, name, starts_at, status) VALUES (?, ?, datetime('now','-2 hours'), 'live')")
        .run(sp.id, `E${i}`);
      const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`E${i}`);
      db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
      const mk = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
      db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mk.id, 'Alpha');
      marketIds.push(mk.id);
    }

    const pending = R.pendingMarkets(db);
    assert.strictEqual(pending.length, 7, 'all seven off markets are pending — there is no cap');

    const { bodies, fetchImpl } = recorder();
    RF.resetState();
    const f = RF.createFetcher({ url: URL, fetchImpl, pendingFn: () => pending, batchSize: 3 });
    await f(db);

    const asked = new Set(askedIds(bodies));
    assert.strictEqual(bodies.length, 3, 'seven markets at three per request is three requests');
    for (const id of marketIds) {
      assert.ok(asked.has(id), `market ${id} never reached the provider — it would never settle`);
    }
    db.close();
  });

  console.log(`\nresultsfeed-pollset.test.js: ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
  if (passed !== 5) { console.error(`expected 5 checks, ran ${passed}`); process.exit(1); }
})();