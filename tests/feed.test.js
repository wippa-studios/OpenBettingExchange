'use strict';
// tests/feed.test.js — board-shaping rules for the Postgres odds feed.
//
// The row-grouping is pure, so these need no database and no `pg`: they assert
// the behaviour that actually breaks a ladder UI — side ordering, the delta
// carry-forward case, and stale detection.
const assert = require('assert');
const { groupRows, ageSeconds, boardSql, healthSql, navSql, feedView } = require('../lib/feed');
const NAV_SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'feed.js'), 'utf8');

// Pull the registered /api/feed/nav handler off the Express stack so it can be
// called without binding a port.
// Shared with tests/feed_nav.test.js and tests/feed_outage.test.js.
//
// `app.router` is Express 5's PUBLIC accessor for the router (Express 4 kept
// the same object on the private `app._router`, which 5 removed). Both are read
// here so the helper names the change rather than silently finding an empty
// stack — the caller's `assert.ok(handler, ...)` then reports "not registered"
// instead of failing somewhere inside this function.
function routerStack(app) {
  const r = app.router || app._router;
  assert.ok(r && Array.isArray(r.stack),
    `neither app.router nor app._router exposes a stack (app.router=${typeof app.router}); ` +
    'the Express introspection this helper relies on has changed again');
  return r.stack;
}

function findNavHandler(app) {
  for (const layer of routerStack(app)) {
    if (layer.route && layer.route.path === '/api/feed/nav') {
      const handlers = layer.route.stack || [];
      const last = handlers[handlers.length - 1];
      return last && last.handle;
    }
  }
  return null;
}

// Invoke the nav handler with a stub res and return what it sent.
async function navCall() {
  const srv = require('../server');
  const handler = findNavHandler(srv.app);
  assert.ok(handler, 'a /api/feed/nav handler is registered');
  const sent = { code: null, body: null };
  const res = {
    status(c) { sent.code = c; return this; },
    json(b) { sent.body = b; return this; },
  };
  await handler({}, res);
  return { sent, handler };
}

module.exports = { findNavHandler, navCall };

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

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const FRAME = iso(60_000); // the market's newest frame, 1 minute old

// ONE ROW PER SELECTION, as v_feed2 returns it, with that selection's ladders
// already extracted into an `odds` JSONB object by the view.
//
// This used to be one row per (runner, side) carrying scalar price/size, which
// the previous implementation needed because Betfair's Stream API sends only
// the runners that CHANGED in a cycle. The collector polls a whole market book
// at a time and writes the complete ladder, so there are no partial books left
// to reconcile — hence one row, both ladders, nothing to carry forward.
const row = (over = {}) => ({
  market_id: '1.100',
  market_name: 'Match Odds',
  fixture_id: '10',
  event_name: 'Arsenal v Chelsea',
  market_status: 'OPEN',
  inplay: false,
  odds_captured_at: FRAME,
  selection_id: 1,
  runner_name: 'Arsenal',
  sort_priority: 1,
  odds: { back: [{ price: 2.4, size: 100 }], lay: [{ price: 2.5, size: 100 }] },
  ...over,
});

/** A ladder of levels: `lv(2.4)` -> {price: 2.4, size: 100}. */
const lv = (price, size = 100) => ({ price, size });
/** An `odds` object from explicit ladders, so a test can order them wrongly. */
const odds = (back = [], lay = []) => ({ back, lay });

// Only self-run when executed directly. tests/feed_nav.test.js imports this
// file to reuse findNavHandler/navCall, and must not re-run these checks.
if (require.main === module) (async () => {
  await check('a single priced runner yields one market with both ladders', async () => {
    const out = groupRows([
      row({ odds: odds([lv(2.4)], [lv(2.5)]) }),
    ]);
    assert.strictEqual(out.length, 1, 'one market');
    assert.strictEqual(out[0].selections.length, 1, 'one runner');
    const s = out[0].selections[0];
    assert.strictEqual(s.back.length, 1);
    assert.strictEqual(s.lay.length, 1);
  });

  await check('back ladder is highest-first (best price to back)', async () => {
    // Deliberately unsorted: Betfair does not return a ladder in order, and the
    // top of the back ladder is the best price to back.
    const out = groupRows([row({ odds: odds([lv(2.4), lv(2.6), lv(2.5)]) })]);
    assert.deepStrictEqual(out[0].selections[0].back.map((l) => l.price), [2.6, 2.5, 2.4]);
  });

  await check('lay ladder is lowest-first (best price to lay)', async () => {
    const out = groupRows([row({ odds: odds([], [lv(2.9), lv(2.7), lv(2.8)]) })]);
    assert.deepStrictEqual(out[0].selections[0].lay.map((l) => l.price), [2.7, 2.8, 2.9]);
  });

  await check('size converts from pounds to integer cents', async () => {
    const out = groupRows([row({ odds: odds([lv(2.4, 123.45)]) })]);
    assert.strictEqual(out[0].selections[0].back[0].size_cents, 12345);
  });

  await check('two markets stay separate', async () => {
    const out = groupRows([
      row({ market_id: '1.100', selection_id: 1 }),
      row({ market_id: '1.200', selection_id: 2 }),
    ]);
    assert.strictEqual(out.length, 2);
  });

  await check('multiple runners in one market are kept', async () => {
    const out = groupRows([
      row({ selection_id: 1, odds: odds([lv(2.4)]) }),
      row({ selection_id: 2, runner_name: 'Chelsea', sort_priority: 2, odds: odds([lv(3.1)]) }),
    ]);
    assert.strictEqual(out[0].selections.length, 2);
    // A string, not a number: Postgres BIGINT arrives from `pg` as a string, and
    // a runner id beyond Number.MAX_SAFE_INTEGER must not be rounded.
    assert.deepStrictEqual(out[0].selections.map((s) => s.selection_id), ['1', '2']);
  });

  // ── WHAT REPLACED THE DELTA CARRY-FORWARD ──────────────────────────────────
  // Three tests used to cover the Stream API's partial frames: a price carried
  // from an earlier cycle and flagged `carried`. That case cannot occur any
  // more — the collector writes a COMPLETE ladder per market, so every level in
  // a ladder came from the same poll — and `carried` was never read by the UI
  // in any case.
  //
  // These three cover the real cases now: a market the odds job has not reached,
  // a selection with genuinely no price, and a whole market from feed 1, which
  // has no price column at all.
  await check('no level is ever flagged carried, because a poll is never partial', async () => {
    const out = groupRows([row({ odds: odds([lv(2.4)]) })]);
    assert.strictEqual(out[0].selections[0].back[0].carried, undefined);
  });

  await check('a runner with no odds at all still renders, with empty ladders', async () => {
    // A market inside the fixtures scope that the odds job has not reached yet.
    const out = groupRows([row({ odds: null, odds_captured_at: null })]);
    assert.strictEqual(out[0].selections.length, 1, 'runner survives');
    assert.strictEqual(out[0].selections[0].back.length, 0);
    assert.strictEqual(out[0].selections[0].lay.length, 0);
    assert.strictEqual(out[0].poll_age_seconds, null, 'and its age is honestly null, not zero');
  });

  await check('a whole market priced as unpriced (feed 1) renders with empty ladders', async () => {
    // feed 1 has no odds column, so `priced: false` is passed and nothing is
    // invented. The market must still appear — a fixture list is the point of
    // feed 1 — but with no prices, and marked stale so it cannot be mistaken
    // for a live board.
    const out = groupRows([row({ odds: undefined, odds_captured_at: undefined })], { priced: false });
    assert.strictEqual(out.length, 1, 'the fixture is still listed');
    assert.strictEqual(out[0].selections.length, 1);
    assert.strictEqual(out[0].selections[0].back.length, 0);
    assert.strictEqual(out[0].selections[0].lay.length, 0);
    assert.strictEqual(out[0].poll_age_seconds, null);
  });

  await check('a null price never becomes a zero-price level', async () => {
    const out = groupRows([row({ odds: odds([{ price: null, size: 10 }]) })]);
    assert.strictEqual(out[0].selections[0].back.length, 0);
  });

  // ── Postgres boundary: unusable levels are skipped, never rendered ──
  // The ladder arrives as JSONB from Betfair, and it CAN carry a non-finite
  // number: an infinite-size 1.01 lay — Betfair's "infinite" marker — is a real
  // response, and the collector stores it as null precisely so it never reaches
  // here as `Infinity`. It has anyway, in tests and in a future SDK. A bad price
  // flowing on corrupts ladder sorts and the book-percentage sums, so the level
  // is dropped at the boundary instead.
  await check('a NaN or infinite price level is skipped, not rendered', async () => {
    const out = groupRows([
      row({ odds: odds([lv(NaN), lv(2.4)], [lv(Infinity)]) }),
    ]);
    const s = out[0].selections[0];
    assert.strictEqual(s.back.length, 1, 'only the finite BACK level survives');
    assert.strictEqual(s.back[0].price, 2.4);
    assert.strictEqual(s.lay.length, 0, "Betfair's infinite LAY level is gone");
  });

  await check('a negative or sub-1 price level is skipped (boundary: price >= 1)', async () => {
    const out = groupRows([row({ odds: odds([lv(-2)], [lv(0.5)]) })]);
    assert.strictEqual(out[0].selections[0].back.length, 0, 'negative price skipped');
    assert.strictEqual(out[0].selections[0].lay.length, 0, 'sub-1 price skipped');
  });

  await check('a negative or absent size is skipped; a null size is a real zero', async () => {
    const bad = groupRows([row({ odds: odds([lv(2.4, -5)], [lv(2.5, NaN)]) })]);
    assert.strictEqual(bad[0].selections[0].back.length, 0, 'negative size skipped');
    assert.strictEqual(bad[0].selections[0].lay.length, 0, 'NaN size skipped');
    // Betfair really does send size = NULL for a price with no size behind it;
    // that stays a (zero-cents) level rather than vanishing.
    const zero = groupRows([row({ odds: odds([lv(2.4, null)]) })]);
    assert.strictEqual(zero[0].selections[0].back.length, 1, 'null size is a level');
    assert.strictEqual(zero[0].selections[0].back[0].size_cents, 0, 'at zero cents');
  });

  await check('a duplicated level is shown once, not as a repeated price cell', async () => {
    // Betfair can emit the same (price, size) twice across a resumption. The UI
    // has no way to render a duplicate cell, and a doubled level also doubles
    // its contribution to the book percentage.
    const out = groupRows([row({ odds: odds([lv(2.4, 100), lv(2.4, 100), lv(2.6, 50)]) })]);
    assert.deepStrictEqual(
      out[0].selections[0].back.map((l) => [l.price, l.size_cents]),
      [[2.6, 5000], [2.4, 10000]],
      'the duplicate is gone and the order is right'
    );
  });

  await check('a runner whose only level is unusable still renders, with empty ladders', async () => {
    const out = groupRows([
      row({ selection_id: 1, runner_name: 'Arsenal', odds: odds([lv(NaN)]) }),
      row({ selection_id: 2, runner_name: 'Chelsea', sort_priority: 2, odds: odds([lv(2.4)]) }),
    ]);
    assert.strictEqual(out[0].selections.length, 2, 'both runners survive');
    assert.strictEqual(out[0].selections.find((s) => String(s.selection_id) === '1').back.length, 0);
    assert.strictEqual(out[0].selections.find((s) => String(s.selection_id) === '2').back.length, 1);
  });

  await check('runners with no name still render (null mid-backfill)', async () => {
    const out = groupRows([row({ runner_name: null })]);
    assert.strictEqual(out[0].selections.length, 1);
    assert.strictEqual(out[0].selections[0].name, null);
  });

  // The omission that made the whole board render empty: PRICE_COLUMNS listed
  // odds_captured_at, price_age_seconds, publish_time, inplay and bet_delay —
  // and not `odds`, the per-selection ladder the board is built from. Nothing
  // threw. `health()` counts `odds IS NOT NULL` in its OWN query, so it
  // cheerfully reported 9,456 markets with odds while every one of the sixty
  // markets on the board rendered with empty ladders.
  //
  // An offline suite cannot join Postgres to catch it, so this pins the column
  // list itself — which is the part that actually broke.
  await check('the priced board query selects the ladder column, not just its metadata', async () => {
    const sql = boardSql(2, false);
    assert.match(sql, /\bv\.odds\s*,/, 'v.odds is selected on feed 2');
    assert.match(sql, /\bv\.odds_captured_at\b/, 'and the book timestamp beside it');
    assert.match(sql, /v_feed2/, 'from the priced view');
  });

  await check('the unpriced board query selects no price column at all', async () => {
    const sql = boardSql(1, false);
    assert.ok(!/\bv\.odds\b/.test(sql), 'feed 1 must not ask for a column that does not exist there');
    assert.ok(!/odds_captured_at/.test(sql));
    assert.match(sql, /v_feed1/, 'and it reads the unpriced view');
  });

  // THE ASSERTION THAT COULD HAVE FAILED. The check above regexes the generated
  // string for a forbidden column NAME and never parses it — which is why a
  // dangling comma in the wrong place sailed through it, and why a feed-1
  // deployment could not load a board at all while the suite was green.
  //
  // Feed 1 has no price block, so the column list is assembled with nothing
  // appended after it. That is the one shape where a comma-suffixed base list
  // leaves a `,` immediately before FROM — a Postgres SYNTAX error, not a
  // semantic one, so no database and no assertion about columns could ever see
  // it. This asserts TERMINATION of the select list instead: the character
  // before FROM/WHERE/ORDER BY must be a column name, not a comma.
  await check('the board column list is syntactically terminated on BOTH feeds', async () => {
    for (const feed of [1, 2]) {
      for (const single of [false, true]) {
        const sql = boardSql(feed, single);
        const label = `feed ${feed}${single ? ' single' : ' board'}`;
        // A comma immediately before a clause keyword is the exact defect.
        assert.ok(!/,\s*FROM\b/i.test(sql), `${label}: dangling comma before FROM`);
        assert.ok(!/,\s*WHERE\b/i.test(sql), `${label}: dangling comma before WHERE`);
        assert.ok(!/,\s*ORDER\s+BY\b/i.test(sql), `${label}: dangling comma before ORDER BY`);
        assert.ok(!/,\s*JOIN\b/i.test(sql), `${label}: dangling comma before JOIN`);
        // Belt and braces: split the outer select list on commas and require
        // every segment to be a non-empty column expression. This catches a
        // leading or doubled comma that no keyword rule above would match.
        const outer = sql.slice(sql.lastIndexOf('SELECT ') + 'SELECT '.length);
        const fromAt = outer.search(/\bFROM\b/i);
        assert.ok(fromAt > 0, `${label}: the outer select has a FROM`);
        const segments = outer.slice(0, fromAt).split(',').map((s) => s.trim());
        assert.ok(segments.length > 0, `${label}: has columns`);
        for (const seg of segments) {
          assert.ok(seg.length > 0, `${label}: empty segment in the column list`);
          assert.match(seg, /^[A-Za-z_][\w.]*$/, `${label}: "${seg}" is not a bare column reference`);
        }
      }
    }
  });

  // The other half of #59: a feed-1 deployment was probed against v_feed2, so
  // health could not detect its own board being dead. A health probe that
  // cannot fail for half the supported configurations is not a probe.
  await check('the health probe reads the CONFIGURED view, not a hardcoded one', async () => {
    assert.match(healthSql(1), /FROM\s+v_feed1\b/, 'a feed-1 probe reads v_feed1');
    assert.ok(!/v_feed2/.test(healthSql(1)), 'and never the priced view it cannot use');
    assert.match(healthSql(2), /FROM\s+v_feed2\b/, 'a feed-2 probe reads v_feed2');
    // v_feed1 has no odds columns at all — a property of the schema, not a
    // filter — so the feed-1 probe must not name them or it cannot run.
    assert.ok(!/\bodds\b/.test(healthSql(1)), 'the feed-1 probe names no odds column');
    assert.ok(!/odds_captured_at/.test(healthSql(1)), 'and no book timestamp');
    // Feed 2 still measures staleness, which is the only thing `ok` means there.
    assert.match(healthSql(2), /max\(odds_captured_at\)/, 'feed 2 still measures the newest book');
  });

  // #69: the same class one function away, and the reason this second check
  // exists at all. NAV_SQL was a module constant interpolating `feedView(2)`,
  // so a FEED_NUMBER=1 deployment built its whole navigation rail from the
  // priced view it never reads. It degraded quietly rather than erroring — which
  // is why #59 fixed the health probe and missed this one.
  await check('the nav query reads the CONFIGURED view, not a hardcoded one', async () => {
    assert.match(navSql(1), /FROM\s+v_feed1\b/, 'a feed-1 nav reads v_feed1');
    assert.ok(!/v_feed2/.test(navSql(1)), 'and never the priced view');
    assert.match(navSql(2), /FROM\s+v_feed2\b/, 'a feed-2 nav reads v_feed2');
    // The shape must be otherwise untouched, or the guard below would be
    // satisfiable by a query that returns nothing at all.
    for (const sql of [navSql(1), navSql(2)]) {
      assert.match(sql, /AS sport_slug|WHERE v\.market_status IN/, 'the query still selects and filters');
      assert.ok(!/\$\{/.test(sql), 'and interpolates nothing at runtime');
    }
  });

  // A third hardcoding site cannot appear. Two were found once already and one
  // survived the fix for the other, which is the whole argument for checking
  // the SOURCE rather than only the behaviour: a new query could hardcode the
  // view and no test above would notice until a feed-1 operator reported a rail
  // built from the wrong fixtures.
  await check('no query in lib/feed.js hardcodes a feed number', async () => {
    // Comments are stripped, so the note above the view accessor — which
    // necessarily discusses the two numbers — is not read as a hardcoded call.
    const code = NAV_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hardcoded = [...code.matchAll(/feedView\(\s*\d\s*\)/g)].map((m) => m[0]);
    assert.deepStrictEqual(hardcoded, [], `feedView() called with a literal feed number: ${hardcoded.join(', ')}`);
  });

  // ...and with no argument it reads the CONFIGURED view, which is what
  // fetchNav() actually calls. Without this the two assertions above would only
  // show that the function CAN take an argument, not that the live path uses the
  // configuration.
  await check('navSql with no argument follows FEED_NUMBER', async () => {
    const config = require('../lib/config');
    const configured = feedView(); // the same defaulting fetchNav relies on
    assert.strictEqual(configured, feedView(config.FEED_NUMBER), 'the default resolves to the configured feed');
    assert.match(navSql(), new RegExp(`FROM\\s+${configured}\\b`), `navSql() reads ${configured}`);
    assert.strictEqual(feedView(1), 'v_feed1');
    assert.strictEqual(feedView(2), 'v_feed2');
  });

  await check('a board query with no limit clause cannot return one selection', async () => {
    // The single-market read once carried LIMIT 1. The view is one row per
    // SELECTION, so that returned one runner of a twenty-runner market and the
    // ladder rendered with a single line.
    const single = boardSql(2, true);
    assert.ok(!/LIMIT/i.test(single), 'the single-market read is not limited');
    assert.match(single, /WHERE v\.market_id = \$1/);
    const board = boardSql(2, false);
    assert.match(board, /LIMIT \$1/, 'the board read is');
  });

  await check('the board cap counts markets, not selection rows', async () => {
    // Same class of error as the LIMIT above: a plain LIMIT on the outer select
    // caps rows, and a Correct Score market is 31 rows, so "limit 5" returned
    // one market. The market list is chosen in a CTE first.
    const sql = boardSql(2, false);
    assert.match(sql, /WITH chosen AS/, 'markets are chosen before the join');
    assert.match(sql, /GROUP BY v\.market_id/, 'deduplicated by market');
    assert.match(sql, /JOIN chosen c ON c\.market_id = v\.market_id/);
  });

  await check('a board query starts with WITH, not FROM', async () => {
    // Postgres reports a misplaced WITH as "syntax error at or near WITH",
    // which says nothing about the cause.
    const sql = boardSql(2, false).trim();
    assert.match(sql, /^WITH chosen AS \(/, 'the CTE leads the statement');
  });

  await check('ageSeconds measures seconds since publish', async () => {
    assert.strictEqual(ageSeconds(iso(0)), 0);
    assert.strictEqual(ageSeconds(iso(90_000)), 90);
  });

  await check('ageSeconds is null when publish_time is missing', async () => {
    assert.strictEqual(ageSeconds(null), null);
  });

  await check('market status is normalised to upper case', async () => {
    const out = groupRows([row({ market_status: 'CLOSED' })]);
    assert.strictEqual(out[0].status, 'CLOSED');
  });

  // ── runner ordering ────────────────────────────────────────────────────
  // Betfair returns runners unordered and the stream carries no sort_priority,
  // so the leading number in the name is the only usable key. A racing ladder
  // read out of order looks broken to anyone who knows the sport.
  await check('runners sort by the number in their name, not arrival order', async () => {
    const out = groupRows([
      row({ selection_id: 1, runner_name: '2. Landing Gear' }),
      row({ selection_id: 2, runner_name: '8. Scrap' }),
      row({ selection_id: 3, runner_name: '4. Artfull' }),
      row({ selection_id: 4, runner_name: '1. Devil Wings' }),
      row({ selection_id: 5, runner_name: '3. Quiet Question' }),
    ]);
    assert.deepStrictEqual(
      out[0].selections.map((s) => s.name),
      ['1. Devil Wings', '2. Landing Gear', '3. Quiet Question', '4. Artfull', '8. Scrap']
    );
  });

  await check('runners without a number keep a stable alphabetical order', async () => {
    const out = groupRows([
      row({ selection_id: 1, runner_name: 'Zebra' }),
      row({ selection_id: 2, runner_name: 'Apple' }),
    ]);
    assert.deepStrictEqual(out[0].selections.map((s) => s.name), ['Apple', 'Zebra']);
  });

  await check('numbered runners sort before unnumbered ones', async () => {
    const out = groupRows([
      row({ selection_id: 1, runner_name: 'Aardvark' }),
      row({ selection_id: 2, runner_name: '7. Seventh' }),
    ]);
    assert.deepStrictEqual(out[0].selections.map((s) => s.name), ['7. Seventh', 'Aardvark']);
  });

  await check('ordering is per-market, not global', async () => {
    const out = groupRows([
      row({ market_id: '1.100', selection_id: 1, runner_name: '5. Five' }),
      row({ market_id: '1.200', selection_id: 2, runner_name: '1. One' }),
      row({ market_id: '1.100', selection_id: 3, runner_name: '2. Two' }),
    ]);
    assert.deepStrictEqual(out.find((m) => m.market_id === '1.100').selections.map((s) => s.name), ['2. Two', '5. Five']);
    assert.deepStrictEqual(out.find((m) => m.market_id === '1.200').selections.map((s) => s.name), ['1. One']);
  });

  // ── runner order for markets whose names carry no number ────────────────
  // Catalogue names are bare for some races ("Piteraq", not "1. Piteraq") and
  // for every non-racing sport. Without sort_priority these sort alphabetically,
  // which puts "Away" before "Home" and reads as a broken ladder.
  await check('sort_priority orders unnumbered runners', async () => {
    const out = groupRows([
      row({ selection_id: 3, runner_name: 'The Draw', sort_priority: 3 }),
      row({ selection_id: 1, runner_name: 'Home FC', sort_priority: 1 }),
      row({ selection_id: 2, runner_name: 'Away FC', sort_priority: 2 }),
    ]);
    assert.deepStrictEqual(
      out[0].selections.map((s) => s.name),
      ['Home FC', 'Away FC', 'The Draw'],
      'Betfair order, not alphabetical'
    );
  });

  await check('sort_priority is carried onto each selection', async () => {
    const out = groupRows([row({ selection_id: 1, runner_name: 'Home FC', sort_priority: 7 })]);
    assert.strictEqual(out[0].selections[0].sort_priority, 7);
  });

  await check('a numeric name prefix still wins when sort_priority is absent', async () => {
    // The stream path never has sort_priority, so the "1. Blue and Gold" prefix
    // remains the fallback signal for it.
    const out = groupRows([
      row({ selection_id: 1, runner_name: '5. Five', sort_priority: null }),
      row({ selection_id: 2, runner_name: '2. Two', sort_priority: null }),
    ]);
    assert.deepStrictEqual(out[0].selections.map((s) => s.name), ['2. Two', '5. Five']);
  });

  // ── nav tree fallbacks ────────────────────────────────────────────────
  // An event the name backfill has not reached yet has no venue and no
  // competition. The tree must still render a clickable node: a bare "—" is a
  // stray, and using the event name would nest a meeting inside itself.
  await check('a trackless event gets a real node name, never a dash', async () => {
    const { nestNav } = require('../lib/feed');
    const out = nestNav([
      {
        sport: 'Greyhound Racing', sport_id: '4339', country: 'AU',
        competition: null, event_id: '1', event_name: null, event_time: null,
        market_id: '1.1', market_name: 'R1 305m N/G', market_type: 'WIN',
        market_time: '2026-10-08T01:47:00Z', in_play: false, market_status: 'OPEN',
      },
    ]);
    const comp = out[0].countries[0].competitions[0];
    assert.notStrictEqual(comp.competition, '—', 'never a bare em-dash');
    assert.ok(comp.competition && comp.competition.trim().length > 0, 'has a label');
    assert.ok(!/^[\u2014-]$/.test(comp.competition), 'not a placeholder glyph');
    const meeting = comp.meetings[0];
    assert.notStrictEqual(meeting.event_name, '—');
    assert.ok(meeting.races.length === 1, 'the race is still reachable');
  });

  await check('a trackless event is distinct from a named one', async () => {
    const { nestNav } = require('../lib/feed');
    const out = nestNav([
      { sport: 'S', sport_id: '7', country: 'AU', competition: 'Rosehill',
        event_id: '1', event_name: 'Rosehill 8th Oct', event_time: null,
        market_id: '1.1', market_name: 'R1', market_type: 'WIN',
        market_time: null, in_play: false, market_status: 'OPEN' },
      { sport: 'S', sport_id: '7', country: 'AU', competition: null,
        event_id: '2', event_name: null, event_time: null,
        market_id: '1.2', market_name: 'R2', market_type: 'WIN',
        market_time: null, in_play: false, market_status: 'OPEN' },
    ]);
    const comps = out[0].countries[0].competitions;
    assert.strictEqual(comps.length, 2, 'two sibling track nodes, not merged');
    assert.notStrictEqual(comps[0].competition, comps[1].competition);
  });

  // ── racing parity: horse racing must shape like greyhound racing ────────
  // Both are racing codes in Betfair's taxonomy (7 and 4339) and both are
  // browsed the same way: country, then track, then meeting, then a race per
  // start time. The tree renderer has no sport-specific branch, so this is the
  // guard that keeps one from needing one — if a racing sport ever comes back
  // with a different shape, the ladder and the nav disagree.
  const racingRow = (over) => Object.assign({
    sport: 'Greyhound Racing', sport_id: '4339', country: 'AU',
    competition: 'Mount Gambier', event_id: '36162339',
    event_name: 'Mount Gambier (AUS) 8th Oct', event_time: '2026-10-08T01:00:00Z',
    market_id: '1.1', market_name: 'R1 305m N/G', market_type: 'WIN',
    market_time: '2026-10-08T01:47:00Z', in_play: false, market_status: 'OPEN',
  }, over);

  // The shape a renderer depends on, compared between two racing sports.
  const shape = (sport) => {
    const walk = (nodes, path) => {
      const out = [path];
      for (const n of nodes || []) {
        const label = n.races ? n.races.length : null;
        out.push(`${path}/${label}`);
        out.push(...walk(n.competitions, `${path}.competitions`));
        out.push(...walk(n.meetings, `${path}.meetings`));
      }
      return out;
    };
    const s = sport;
    return [
      ...walk(s.countries, 'countries'),
      ...walk(s.countries.map((c) => c.competitions), 'competitions'),
      ...walk(s.countries.flatMap((c) => c.competitions.map((k) => k.meetings)), 'meetings'),
    ].join('|');
  };

  await check('horse racing nests exactly like greyhound racing', async () => {
    const { nestNav } = require('../lib/feed');
    const grey = nestNav([
      racingRow({}),
      racingRow({ market_id: '1.2', market_name: 'R2 305m Mdn', market_time: '2026-10-08T02:10:00Z' }),
    ]);
    const horse = nestNav([
      racingRow({
        sport: 'Horse Racing', sport_id: '7', competition: 'Rosehill',
        event_id: '36162469', event_name: 'Rosehill (AUS) 10th Oct',
        market_id: '1.9', market_name: 'R1 1200m Mdn', market_time: '2026-10-09T23:30:00Z',
      }),
      racingRow({
        sport: 'Horse Racing', sport_id: '7', competition: 'Rosehill',
        event_id: '36162469', event_name: 'Rosehill (AUS) 10th Oct',
        market_id: '1.10', market_name: 'R2 1400m Hcap', market_time: '2026-10-10T00:05:00Z',
      }),
    ]);
    assert.strictEqual(shape(horse[0]), shape(grey[0]),
      'same nesting depth and same child counts for both racing sports');
  });

  await check('every racing race carries the fields the ladder header needs', async () => {
    const { nestNav } = require('../lib/feed');
    const out = nestNav([
      racingRow({ sport: 'Horse Racing', sport_id: '7', competition: 'Eagle Farm' }),
    ]);
    const race = out[0].countries[0].competitions[0].meetings[0].races[0];
    for (const field of ['market_id', 'market_name', 'market_type', 'market_time']) {
      assert.ok(race[field] !== undefined && race[field] !== null,
        `race.${field} is present (got ${JSON.stringify(race[field])})`);
    }
    assert.ok(!isNaN(new Date(race.market_time).getTime()), 'market_time parses for the header clock');
  });

  await check('a race belongs to exactly one meeting when ids collide', async () => {
    // Betfair reuses market ids across sports; keying meetings by event_id
    // alone would merge two meetings into one node.
    const { nestNav } = require('../lib/feed');
    const out = nestNav([
      racingRow({ sport: 'Greyhound Racing', sport_id: '4339' }),
      racingRow({ sport: 'Horse Racing', sport_id: '7', event_id: '999' }),
    ]);
    assert.strictEqual(out.length, 2, 'two sports');
    assert.strictEqual(out[0].countries[0].competitions[0].meetings.length, 1);
    assert.strictEqual(out[1].countries[0].competitions[0].meetings.length, 1);
  });

  // ── market labels: telling Betfair's identically-named markets apart ────
  // Racing PLACE markets are all called "To Be Placed". What differs is how many
  // runners win, so a meeting can hold eleven of them under one label — every
  // one a separate market a bettor can price.
  const { marketLabel } = require('../lib/feed');

  await check('a multi-winner place market says how many', async () => {
    assert.strictEqual(marketLabel('To Be Placed', 3), 'To Be Placed — any 3 to be placed');
    assert.strictEqual(marketLabel('To Be Placed', 2), 'To Be Placed — any 2 to be placed');
  });

  await check('a single-winner market keeps its plain name', async () => {
    // "R1 300m Mdn" is already unambiguous, so the label must not gain words.
    assert.strictEqual(marketLabel('R1 300m Mdn', 1), 'R1 300m Mdn');
    assert.strictEqual(marketLabel('Match Odds', 1), 'Match Odds');
  });

  await check('an unknown winner count leaves the name alone', async () => {
    for (const v of [null, undefined, 0, NaN, 'x']) {
      assert.strictEqual(marketLabel('R2 484m Rest', v), 'R2 484m Rest',
        `winner count ${String(v)} must not invent a label`);
    }
  });

  await check('two winners in a meeting with different counts stay distinct', async () => {
    // The real failure this guards: two markets both named "To Be Placed"
    // rendering as indistinguishable leaves.
    const labels = new Set([marketLabel('To Be Placed', 2), marketLabel('To Be Placed', 3)]);
    assert.strictEqual(labels.size, 2, 'any-2 and any-3 are distinguishable');
  });

  // ── book percentages (the Back all / Lay all header figures) ───────────
  // Betfair sums the implied probability of the best price on each side. 100%
  // is a fair book; above that is overround. A one-sided market cannot be
  // summed meaningfully, so the figure is null rather than a misleading number.
  const { bookPercentages } = require('../lib/feed');
  const ladder = (back, lay) => ({
    back: back === null ? [] : [{ price: back }],
    lay: lay === null ? [] : [{ price: lay }],
  });

  await check('book percentages sum 1/price across every runner', async () => {
    // A fair two-way book over 2 runners: both sides exactly 2.00 -> 100%.
    const p = bookPercentages([ladder(2, 2), ladder(2, 2)]);
    assert.strictEqual(p.back_pct, 100);
    assert.strictEqual(p.lay_pct, 100);
  });

  await check('book percentages round to one decimal', async () => {
    // 1/3 + 1/3 = 66.666...% -> 66.7
    const p = bookPercentages([ladder(3, 3), ladder(3, 3)]);
    assert.strictEqual(p.back_pct, 66.7);
  });

  await check('a one-sided market reports null, not a inflated figure', async () => {
    // Ten runners at 1.02 with no lays: summing only the back side would read
    // ~980%, which looks like an absurd book. null is the honest answer.
    const runners = Array.from({ length: 10 }, () => ladder(1.02, null));
    const p = bookPercentages(runners);
    assert.strictEqual(p.back_pct, null);
    assert.strictEqual(p.lay_pct, null);
    assert.strictEqual(p.back_runners, 10);
    assert.strictEqual(p.lay_runners, 0);
  });

  await check('book percentages count the runners that do have a price', async () => {
    // A partially two-sided market: no percentage, but the counts still report
    // what the feed actually carried.
    const p = bookPercentages([ladder(2, null), ladder(null, 2), ladder(4, 4)]);
    assert.strictEqual(p.back_runners, 2);
    assert.strictEqual(p.lay_runners, 2);
    assert.strictEqual(p.back_pct, null, 'an incomplete book has no percentage');
  });

  await check('an empty market has no percentage rather than NaN', async () => {
    const p = bookPercentages([]);
    assert.strictEqual(p.back_pct, null);
    assert.strictEqual(p.lay_pct, null);
  });

  // NOTE: the /api/feed/nav contract is asserted in tests/feed_nav.test.js.
  // lib/config.js is evaluated once at import, so FEED_ENABLED cannot be varied
  // inside one process — it needs its own file. That file's feed-enabled run
  // points FEED_DATABASE_URL at 127.0.0.1:59999, a port nothing listens on.
  // The dead-port trick only works because the address is LOOPBACK: a closed
  // loopback port REJECTS (ECONNREFUSED, immediately) rather than DROPping the
  // packet the way a firewalled remote host would, so the outage path resolves
  // in milliseconds instead of hanging the suite until connectionTimeout-
  // Millis. "Offline" here also means "fast".

  console.log(`\nfeed.test.js: ${passed} checks passed`);
})();
