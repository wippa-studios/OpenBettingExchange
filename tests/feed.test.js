'use strict';
// tests/feed.test.js — board-shaping rules for the Postgres odds feed.
//
// The row-grouping is pure, so these need no database and no `pg`: they assert
// the behaviour that actually breaks a ladder UI — side ordering, the delta
// carry-forward case, and stale detection.
const assert = require('assert');
const { groupRows, ageSeconds } = require('../lib/feed');

// Pull the registered /api/feed/nav handler off the Express stack so it can be
// called without binding a port. Express 4 stores routes in app._router.stack.
// Shared with tests/feed_nav.test.js.
function findNavHandler(app) {
  const stack = (app._router && app._router.stack) || [];
  for (const layer of stack) {
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

// One row per (runner, side), as BOARD_SQL returns it.
const row = (over = {}) => ({
  market_id: '1.100',
  market_name: 'Match Odds',
  event_id: '10',
  event_name: 'Arsenal v Chelsea',
  market_status: 'OPEN',
  in_play: false,
  frame_at: FRAME,
  selection_id: 1,
  runner_name: 'Arsenal',
  sort_priority: 1,
  side: 'BACK',
  price: 2.4,
  size: 100,
  price_at: FRAME,
  ...over,
});

// Only self-run when executed directly. tests/feed_nav.test.js imports this
// file to reuse findNavHandler/navCall, and must not re-run these checks.
if (require.main === module) (async () => {
  await check('a single priced runner yields one market with both ladders', () => {
    const out = groupRows([
      row({ side: 'BACK', price: 2.4 }),
      row({ side: 'LAY', price: 2.5 }),
    ]);
    assert.strictEqual(out.length, 1, 'one market');
    assert.strictEqual(out[0].selections.length, 1, 'one runner');
    const s = out[0].selections[0];
    assert.strictEqual(s.back.length, 1);
    assert.strictEqual(s.lay.length, 1);
  });

  await check('back ladder is highest-first (best price to back)', () => {
    const out = groupRows([
      row({ side: 'BACK', price: 2.4 }),
      row({ side: 'BACK', price: 2.6 }),
      row({ side: 'BACK', price: 2.5 }),
    ]);
    assert.deepStrictEqual(out[0].selections[0].back.map((l) => l.price), [2.6, 2.5, 2.4]);
  });

  await check('lay ladder is lowest-first (best price to lay)', () => {
    const out = groupRows([
      row({ side: 'LAY', price: 2.9 }),
      row({ side: 'LAY', price: 2.7 }),
      row({ side: 'LAY', price: 2.8 }),
    ]);
    assert.deepStrictEqual(out[0].selections[0].lay.map((l) => l.price), [2.7, 2.8, 2.9]);
  });

  await check('size converts from pounds to integer cents', () => {
    const out = groupRows([row({ side: 'BACK', price: 2.4, size: 123.45 })]);
    assert.strictEqual(out[0].selections[0].back[0].size_cents, 12345);
  });

  await check('two markets stay separate', () => {
    const out = groupRows([
      row({ market_id: '1.100', selection_id: 1 }),
      row({ market_id: '1.200', selection_id: 2 }),
    ]);
    assert.strictEqual(out.length, 2);
  });

  await check('multiple runners in one market are kept', () => {
    const out = groupRows([
      row({ selection_id: 1, side: 'BACK', price: 2.4 }),
      row({ selection_id: 2, side: 'BACK', price: 3.1 }),
    ]);
    assert.strictEqual(out[0].selections.length, 2);
    assert.deepStrictEqual(out[0].selections.map((s) => s.selection_id), [1, 2]);
  });

  // THE DELTA CASE. An unchanged runner has no row in the newest frame, so the
  // query returns its price from an earlier cycle. It must still appear, and be
  // marked so the UI can show it as not-live.
  await check('a price from an earlier frame is kept and marked carried', () => {
    const out = groupRows([
      row({ side: 'BACK', price: 2.4, price_at: iso(240_000) }), // 4 min old
    ]);
    const back = out[0].selections[0].back;
    assert.strictEqual(back.length, 1, 'runner does not blink out');
    assert.strictEqual(back[0].price, 2.4);
    assert.strictEqual(back[0].carried, true, 'marked as not-live');
  });

  await check('a price from the current frame is NOT marked carried', () => {
    const out = groupRows([row({ side: 'BACK', price: 2.4, price_at: FRAME })]);
    assert.strictEqual(out[0].selections[0].back[0].carried, undefined);
  });

  await check('carryForward off: an older-frame price is hidden', () => {
    const out = groupRows([row({ side: 'BACK', price: 2.4, price_at: iso(240_000) })], {
      carryForward: false,
    });
    assert.strictEqual(out[0].selections[0].back.length, 0);
  });

  await check('a runner with no price at all still renders, with empty ladders', () => {
    const out = groupRows([row({ side: null, price: null, price_at: null })]);
    assert.strictEqual(out[0].selections.length, 1, 'runner survives');
    assert.strictEqual(out[0].selections[0].back.length, 0);
    assert.strictEqual(out[0].selections[0].lay.length, 0);
  });

  await check('a null price never becomes a zero-price level', () => {
    const out = groupRows([row({ side: 'BACK', price: null, price_at: null })]);
    assert.strictEqual(out[0].selections[0].back.length, 0);
  });

  // ── Postgres boundary: unusable price rows are skipped, never rendered ──
  // The recorder's REAL columns can carry NaN or negatives from a wedged
  // capture cycle; a bad price flowing on corrupts ladder sorts and the
  // book-percentage sums. The row is dropped at the boundary instead.
  await check('a NaN or infinite price row is skipped, not rendered as a level', () => {
    const out = groupRows([
      row({ side: 'BACK', price: NaN }),
      row({ side: 'LAY', price: Infinity }),
      row({ side: 'BACK', price: 2.4 }),
    ]);
    const s = out[0].selections[0];
    assert.strictEqual(s.back.length, 1, 'only the finite BACK level survives');
    assert.strictEqual(s.back[0].price, 2.4);
    assert.strictEqual(s.lay.length, 0, 'the infinite LAY row is gone');
  });

  await check('a negative or sub-1 price row is skipped (boundary: price >= 1)', () => {
    const out = groupRows([
      row({ side: 'BACK', price: -2 }),
      row({ side: 'LAY', price: 0.5 }),
    ]);
    assert.strictEqual(out[0].selections[0].back.length, 0, 'negative price skipped');
    assert.strictEqual(out[0].selections[0].lay.length, 0, 'sub-1 price skipped');
  });

  await check('a negative or absent size is skipped; a null size is a real zero', () => {
    const bad = groupRows([
      row({ side: 'BACK', size: -5 }),
      row({ side: 'LAY', size: NaN }),
    ]);
    assert.strictEqual(bad[0].selections[0].back.length, 0, 'negative size skipped');
    assert.strictEqual(bad[0].selections[0].lay.length, 0, 'NaN size skipped');
    // Betfair really does send size = NULL for a price with no size behind
    // it; that stays a (zero-cents) level rather than vanishing.
    const zero = groupRows([row({ side: 'BACK', size: null })]);
    assert.strictEqual(zero[0].selections[0].back.length, 1, 'null size is a level');
    assert.strictEqual(zero[0].selections[0].back[0].size_cents, 0, 'at zero cents');
  });

  await check('a runner whose only rows are unusable still renders, with empty ladders', () => {
    const out = groupRows([
      row({ selection_id: 1, side: 'BACK', price: NaN }),
      row({ selection_id: 2, side: 'BACK', price: 2.4 }),
    ]);
    assert.strictEqual(out[0].selections.length, 2, 'both runners survive');
    assert.strictEqual(out[0].selections.find((s) => s.selection_id === 1).back.length, 0);
    assert.strictEqual(out[0].selections.find((s) => s.selection_id === 2).back.length, 1);
  });

  await check('runners with no name still render (null mid-backfill)', () => {
    const out = groupRows([row({ runner_name: null })]);
    assert.strictEqual(out[0].selections.length, 1);
    assert.strictEqual(out[0].selections[0].name, null);
  });

  await check('ageSeconds measures seconds since publish', () => {
    assert.strictEqual(ageSeconds(iso(0)), 0);
    assert.strictEqual(ageSeconds(iso(90_000)), 90);
  });

  await check('ageSeconds is null when publish_time is missing', () => {
    assert.strictEqual(ageSeconds(null), null);
  });

  await check('market status is normalised to upper case', () => {
    const out = groupRows([row({ market_status: 'CLOSED' })]);
    assert.strictEqual(out[0].status, 'CLOSED');
  });

  // ── runner ordering ────────────────────────────────────────────────────
  // Betfair returns runners unordered and the stream carries no sort_priority,
  // so the leading number in the name is the only usable key. A racing ladder
  // read out of order looks broken to anyone who knows the sport.
  await check('runners sort by the number in their name, not arrival order', () => {
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

  await check('runners without a number keep a stable alphabetical order', () => {
    const out = groupRows([
      row({ selection_id: 1, runner_name: 'Zebra' }),
      row({ selection_id: 2, runner_name: 'Apple' }),
    ]);
    assert.deepStrictEqual(out[0].selections.map((s) => s.name), ['Apple', 'Zebra']);
  });

  await check('numbered runners sort before unnumbered ones', () => {
    const out = groupRows([
      row({ selection_id: 1, runner_name: 'Aardvark' }),
      row({ selection_id: 2, runner_name: '7. Seventh' }),
    ]);
    assert.deepStrictEqual(out[0].selections.map((s) => s.name), ['7. Seventh', 'Aardvark']);
  });

  await check('ordering is per-market, not global', () => {
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
  await check('sort_priority orders unnumbered runners', () => {
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

  await check('sort_priority is carried onto each selection', () => {
    const out = groupRows([row({ selection_id: 1, runner_name: 'Home FC', sort_priority: 7 })]);
    assert.strictEqual(out[0].selections[0].sort_priority, 7);
  });

  await check('a numeric name prefix still wins when sort_priority is absent', () => {
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
  await check('a trackless event gets a real node name, never a dash', () => {
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

  await check('a trackless event is distinct from a named one', () => {
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

  await check('horse racing nests exactly like greyhound racing', () => {
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

  await check('every racing race carries the fields the ladder header needs', () => {
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

  await check('a race belongs to exactly one meeting when ids collide', () => {
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

  await check('a multi-winner place market says how many', () => {
    assert.strictEqual(marketLabel('To Be Placed', 3), 'To Be Placed — any 3 to be placed');
    assert.strictEqual(marketLabel('To Be Placed', 2), 'To Be Placed — any 2 to be placed');
  });

  await check('a single-winner market keeps its plain name', () => {
    // "R1 300m Mdn" is already unambiguous, so the label must not gain words.
    assert.strictEqual(marketLabel('R1 300m Mdn', 1), 'R1 300m Mdn');
    assert.strictEqual(marketLabel('Match Odds', 1), 'Match Odds');
  });

  await check('an unknown winner count leaves the name alone', () => {
    for (const v of [null, undefined, 0, NaN, 'x']) {
      assert.strictEqual(marketLabel('R2 484m Rest', v), 'R2 484m Rest',
        `winner count ${String(v)} must not invent a label`);
    }
  });

  await check('two winners in a meeting with different counts stay distinct', () => {
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

  await check('book percentages sum 1/price across every runner', () => {
    // A fair two-way book over 2 runners: both sides exactly 2.00 -> 100%.
    const p = bookPercentages([ladder(2, 2), ladder(2, 2)]);
    assert.strictEqual(p.back_pct, 100);
    assert.strictEqual(p.lay_pct, 100);
  });

  await check('book percentages round to one decimal', () => {
    // 1/3 + 1/3 = 66.666...% -> 66.7
    const p = bookPercentages([ladder(3, 3), ladder(3, 3)]);
    assert.strictEqual(p.back_pct, 66.7);
  });

  await check('a one-sided market reports null, not a inflated figure', () => {
    // Ten runners at 1.02 with no lays: summing only the back side would read
    // ~980%, which looks like an absurd book. null is the honest answer.
    const runners = Array.from({ length: 10 }, () => ladder(1.02, null));
    const p = bookPercentages(runners);
    assert.strictEqual(p.back_pct, null);
    assert.strictEqual(p.lay_pct, null);
    assert.strictEqual(p.back_runners, 10);
    assert.strictEqual(p.lay_runners, 0);
  });

  await check('book percentages count the runners that do have a price', () => {
    // A partially two-sided market: no percentage, but the counts still report
    // what the feed actually carried.
    const p = bookPercentages([ladder(2, null), ladder(null, 2), ladder(4, 4)]);
    assert.strictEqual(p.back_runners, 2);
    assert.strictEqual(p.lay_runners, 2);
    assert.strictEqual(p.back_pct, null, 'an incomplete book has no percentage');
  });

  await check('an empty market has no percentage rather than NaN', () => {
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
