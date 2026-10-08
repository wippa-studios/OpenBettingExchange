'use strict';
// tests/feed_nav.test.js — the /api/feed/nav contract in BOTH feed modes.
//
// Split from tests/feed.test.js because lib/config.js is evaluated once at
// import: FEED_ENABLED cannot be flipped inside a single process, so "feed off"
// and "feed on" each need their own file. The npm script runs this with the
// feed enabled; run it directly with FEED_ENABLED=false to check the other mode.
//
// Why the contract matters: the browser probes /api/feed/nav once at boot to
// decide which board to render. If it answered 4xx with the feed OFF, every
// non-feed deployment would log a console error on load — and
// tests/ui_test.mjs fails the entire run on any console error. So:
//   feed off            -> 200 {enabled:false, sports:[]}   (no error logged)
//   feed on, db down    -> 503 {error}                      (a real outage)
//   feed on, db up      -> 200 {enabled:true,  sports:[...]}
//
// This suite runs against a reserved dead port (see package.json), so the
// enabled path here exercises the 503 branch against the real pool. The live
// 200-with-sports shape is NOT covered end to end anywhere — smoke.sh never
// enables the feed, and a live Postgres is not a test dependency (feed tests
// stay offline). What IS covered offline: the row-shaping (nestNav, pinned in
// tests/feed.test.js) and, via a stubbed fetchNav seam below, the
// enabled+healthy ROUTE contract — 200 {enabled:true, sports:[...]} carrying
// exactly the tree the real fetchNav produces. What remains uncovered is the
// NAV_SQL that feeds nestNav against a live recorder, which cannot run
// offline by construction.
process.env.DB_PATH = ':memory:';
process.env.DRIFT_ENABLED = 'false';
process.env.BOT_ENABLED = 'false';

const assert = require('assert');
const { findNavHandler, navCall } = require('./feed.test');

let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
};

const FEED_ON = process.env.FEED_ENABLED === 'true';

(async () => {
  console.log(`  (feed ${FEED_ON ? 'ENABLED' : 'disabled'} for this run)`);

  await check('a /api/feed/nav route is registered', () => {
    const srv = require('../server');
    assert.ok(findNavHandler(srv.app), 'handler found on the Express stack');
  });

  // The probe contract: with the feed OFF, nav must be a clean 200 so the
  // browser never logs an error on a non-feed deployment. With the feed ON it
  // queries Postgres through the real pool, so the dead port yields the 503
  // outage branch (also covered in tests/feed_outage.test.js). The healthy
  // branch is exercised through the fetchNav seam below.
  if (!FEED_ON) {
    await check('nav replies 200 with no explicit 4xx status when the feed is off', async () => {
      const { sent } = await navCall();
      assert.strictEqual(sent.code, null, 'no 4xx/5xx status was set');
      assert.ok(sent.body, 'a JSON body was sent');
      assert.strictEqual(sent.body.enabled, false);
      assert.deepStrictEqual(sent.body.sports, [], 'empty while disabled');
    });
  } else {
    await check('nav surfaces a 503 while the feed is enabled but unreachable', async () => {
      const { sent } = await navCall();
      // The suite runs against a reserved dead port, so this is the enabled-mode
      // behaviour. It must not degrade into a silent empty board.
      assert.strictEqual(sent.code, 503);
      assert.strictEqual(sent.body.error, 'Odds feed unavailable');
    });

    await check('the 503 body leaks no driver or host detail', async () => {
      const { sent } = await navCall();
      const body = JSON.stringify(sent.body);
      // Match the connection specifics, not the word "feed" (which legitimately
      // appears in the message "Odds feed unavailable").
      assert.ok(!/59999|ECONNREFUSED|postgres:\/\/|:feed@|nobody/i.test(body), `body was ${body}`);
      assert.deepStrictEqual(sent.body, { error: 'Odds feed unavailable' });
    });

    await check('enabled + healthy: nav answers 200 with the shaped sports tree', async () => {
      // Lib-level seam (house style: a simple stub, no mocks framework).
      // server.js holds the feed MODULE and calls FEED.fetchNav() at request
      // time, so swapping the property on the already-required module changes
      // what the route sees — without a live Postgres. The stubbed rows go
      // through the REAL nestNav, so the sports tree below is the production
      // shape, not a hand-written fixture.
      const feed = require('../lib/feed');
      const realFetchNav = feed.fetchNav;
      feed.fetchNav = async () =>
        feed.nestNav([
          {
            sport: 'Greyhound Racing', sport_id: '4339', country: 'AU',
            competition: 'Mount Gambier', event_id: '36162339',
            event_name: 'Mount Gambier (AUS) 8th Oct', event_time: '2026-10-08T01:00:00Z',
            market_id: '1.1', market_name: 'R1 305m N/G', market_type: 'WIN',
            market_time: '2026-10-08T01:47:00Z', in_play: false, market_status: 'OPEN',
            number_of_winners: 1,
          },
        ]);
      try {
        const { sent } = await navCall();
        assert.strictEqual(sent.code, null, 'no error status on the healthy path');
        assert.strictEqual(sent.body.enabled, true);
        const sports = sent.body.sports;
        assert.ok(Array.isArray(sports) && sports.length === 1, 'the tree arrived');
        const comp = sports[0].countries[0].competitions[0];
        assert.strictEqual(comp.competition, 'Mount Gambier');
        assert.strictEqual(comp.market_count, 1, 'shaped counts survive the route');
        assert.strictEqual(comp.meetings[0].races[0].market_id, '1.1');
      } finally {
        feed.fetchNav = realFetchNav; // never leak the stub into other checks
      }
    });
  }

  // A 503 is correct here and only here: the feed is configured but the
  // recorder's Postgres is unreachable. That is a genuine outage, not a
  // configuration state, so the browser SHOULD see an error. It needs its own
  // process because lib/config.js and the pg pool are built at import time —
  // see tests/feed_outage.test.js.
  console.log(`\nfeed_nav.test.js: ${passed} checks passed`);
})();
