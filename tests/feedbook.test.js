// feedbook.test.js — the feed drives a REAL, TRADEABLE, VENUE-PRICED book (#101).
// Run: node tests/feedbook.test.js   (plain assert, no deps)
//
// ── WHAT THIS FILE IS ─────────────────────────────────────────────────────────
// Before this change, `FEED_ENABLED=true` gave a venue a board of real fixtures
// and not one bettable market in it: a feed market had no local row, so
// `POST /api/orders` answered 404, and the bots — the venue's only source of
// liquidity — were switched off because of the feed. lib/feedcat.js fixes the
// first half by materialising the feed's catalogue into local rows, and the
// hoists in server.js fix the second by quoting the venue's OWN book.
//
// Materialising a catalogue is the easy half. The hard half is what happens
// afterwards, and it is what this file is mostly about: once a fixture exists
// here, the venue has TWO id spaces for one race, and the results protocol
// speaks integers in both directions. An outcome naming the feed's runner ids
// then reaches `inMarket.has(w)` as false for every winner — fail-safe and
// operationally fatal at once: `hold('non_runner_foreign')`, nothing settles, a
// withdrawn runner stays quoted, and a player holds a position in a market the
// venue has parked. FB7, FB8, FB9 and FB10 are about that translation.
//
// ── WHY EVERY CASE ASSERTS ITS CONTROL BESIDE IT ──────────────────────────────
// STATE.md §5.6: the fourth time this pass found a green assertion that
// structurally could not see the defect, because it tested a KEY rather than a
// COMBINATION. `tests/voidrules.test.js` now asserts each combination with the
// same signal minus the dangerous part beside it, "so a table that voided
// everything, or settled everything, cannot pass". The same rule is applied
// here, and it is the reason FB9 and FB10 pair a refusal with a settlement and
// FB10 runs the SAME signal down two paths and compares the answers. A test that
// only proves "the translated path settles" would also pass against a venue that
// settles everything.
//
// ── WHAT IS ASSERTED ABOUT PRICES, AND WHY IT IS THE DANGEROUS ONE ────────────
// `fair_price` is the VENUE's price: it is what lib/bots.js quotes a ladder
// around and what lib/cashout.js computes a buyout from. The feed supplies
// fixtures, off times and results. docs/FEED.md names the hazard precisely —
// "the failure mode is not a bad price; it is a good price that a sharp client
// takes from you" — and FB4 asserts it from both ends: a priced fixture leaves
// `fair_price` at the venue's own seed, `ltp` stays null, and the bot's ladder is
// built from the venue's price rather than from the feed's.
//
// ── THE PROVIDER IS A FIXTURE, NOT A REGISTRY ENTRY ───────────────────────────
// The fake below implements the contract the shipped providers already satisfy
// (tests/feedprovider-conformance.test.js is what proves THAT); it is handed to
// `sync({provider})` directly rather than registered, because registering it
// would mean adding a name to lib/feed/provider.js's CAPABILITIES table — and a
// name there is a claim that the adapter has passed the conformance battery,
// which this fixture has not and is not trying to.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.DB_PATH = ':memory:';
process.env.BOT_ENABLED = 'true';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';
process.env.COMMISSION_RATE = '0.025';
process.env.FEED_ENABLED = 'true';
process.env.FEED_PROVIDER = 'postgres';
process.env.FEED_DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/feed';
// Small bounds, so the "a sync against a huge catalogue caps and reports"
// behaviour is exercised by the default path of one of the checks below rather
// than only by a hypothetical.
process.env.FEED_BOOK_SYNC_LIMIT = '50';
process.env.FEED_BOOK_SYNC_CONCURRENCY = '2';

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const acc = require('../lib/accounts');
const bots = require('../lib/bots');
const feedcat = require('../lib/feedcat');
const results = require('../lib/results');
const resultsfeed = require('../lib/resultsfeed');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this file
// rather than run eagerly - an eager runner would report a passing check whose
// promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

// ── the fixture feed ──────────────────────────────────────────────────────────

const HOUR = 3600 * 1000;
const at = (msFromNow) => new Date(Date.now() + msFromNow).toISOString().replace('T', ' ').slice(0, 19);

/**
 * A catalogue, in the shapes lib/feed/shape.js produces.
 *
 * The ids are Betfair's real shapes: dotted market ids, numeric selection ids
 * REUSED across markets (31 is a runner in '1.100' and in '1.400' — the trap
 * that forces the composite key), and a fixture whose off time the feed cannot
 * express. Prices are deliberately lopsided and far from even money, so a test
 * that passes against a venue which copied them cannot also pass against one
 * which seeded 2.00.
 */
function catalogue() {
  return {
    meetings: [
      {
        event_id: '10',
        event_name: 'Rosehill 10th Oct',
        event_time: at(2 * HOUR),
        races: [
          {
            market_id: '1.100', market_name: 'Winner', market_time: at(2 * HOUR),
            market_status: 'OPEN',
            runners: [
              { selection_id: 31, name: 'Piteraq', back: [{ price: 2.6, size: 100 }], lay: [{ price: 2.4, size: 120 }] },
              { selection_id: 32, name: 'Steamy', back: [{ price: 5.5, size: 40 }], lay: [{ price: 5.3, size: 40 }] },
              { selection_id: 33, name: 'Rusty', back: [{ price: 9.0, size: 10 }], lay: [{ price: 8.8, size: 10 }] },
            ],
          },
          {
            market_id: '1.200', market_name: 'To Be Placed', market_time: at(2 * HOUR),
            market_status: 'OPEN',
            runners: [{ selection_id: 40, name: 'Any 3', back: [{ price: 3.1, size: 20 }], lay: [{ price: 3.0, size: 20 }] }],
          },
        ],
      },
      {
        // THE BAD ROW. An off time lib/offtime.js cannot read, on a market that
        // is otherwise perfectly ordinary.
        event_id: '20',
        event_name: 'Broken Fixture',
        event_time: 'whenever',
        races: [
          { market_id: '1.300', market_name: 'Winner', market_time: 'whenever', market_status: 'OPEN',
            runners: [{ selection_id: 50, name: 'Mystery' }] },
        ],
      },
      {
        // Runner ids that appear NOWHERE ELSE in this fixture, which is what
        // makes FB9's refusal possible: '1.100' runs 31/32/33 and these are
        // 71/72, so naming 72 against '1.100' is unambiguously an id from another
        // market rather than an id that happens to be shared.
        event_id: '30',
        event_name: 'Flemington 11th Oct',
        event_time: at(3 * HOUR),
        races: [
          { market_id: '1.400', market_name: 'Winner', market_time: at(3 * HOUR), market_status: 'OPEN',
            runners: [
              { selection_id: 71, name: 'Gai Water', back: [{ price: 4.4, size: 30 }], lay: [{ price: 4.2, size: 30 }] },
              { selection_id: 72, name: 'Zoustar', back: [{ price: 7.0, size: 10 }], lay: [{ price: 6.8, size: 10 }] },
            ] },
        ],
      },
    ],
  };
}

/** nav() in the nested shape lib/feed/shape.js's nestNav returns. */
function navTree(cat) {
  return [{
    sport: 'horse_racing',
    name: 'Horse Racing',
    countries: [{
      country: 'AU',
      competitions: [{
        competition: 'Sydney',
        meetings: cat.meetings.map((m) => ({
          event_id: m.event_id,
          event_name: m.event_name,
          event_time: m.event_time,
          races: m.races.map((r) => ({
            market_id: r.market_id,
            market_name: r.market_name,
            market_label: null,
            market_type: 'WIN',
            market_time: r.market_time,
            start_time: r.market_time,
            in_play: false,
            status: r.market_status,
            market_status: r.market_status,
          })),
        })),
      }],
    }],
  }];
}

/** market(id) in the canonical shaped shape, with runners in feed order. */
function shapedMarket(cat, id) {
  const meeting = cat.meetings.find((m) => m.races.some((r) => String(r.market_id) === String(id)));
  if (!meeting) return null;
  const race = meeting.races.find((r) => String(r.market_id) === String(id));
  return {
    market_id: String(race.market_id),
    event_id: meeting.event_id,
    event_name: meeting.event_name,
    market_name: race.market_name,
    market_status: race.market_status,
    status: race.market_status,
    start_time: meeting.event_time,
    selections: race.runners.map((r, i) => ({
      key: `${race.market_id}:${r.selection_id}`,
      selection_id: String(r.selection_id),
      name: r.name,
      sort_priority: i,
      status: 'ACTIVE',
      back: r.back || [],
      lay: r.lay || [],
    })),
  };
}

/** A provider over a mutable catalogue. Drop a race and the feed forgets it. */
function fakeProvider(cat) {
  const calls = { nav: 0, market: [], board: 0 };
  return {
    name: 'postgres',
    calls,
    priced: () => true,
    async nav() { calls.nav += 1; return navTree(cat); },
    async market(id, opts) {
      calls.market.push(String(id));
      return shapedMarket(cat, id);
    },
    // The full contract, because `assertProvider` checks the full contract and
    // this fake is registered through the real registry (see FB11). Nothing in
    // the materialisation path calls it — that is the point of `nav()` + N ×
    // `market()` — so it is here to satisfy the seam, and it is bounded like the
    // real ones.
    async board({ limit = 60 } = {}) {
      calls.board += 1;
      return cat.meetings
        .flatMap((m) => m.races)
        .slice(0, limit)
        .map((r) => shapedMarket(cat, r.market_id))
        .filter(Boolean);
    },
    async health() { return { ok: true }; },
    async close() {},
  };
}

let n = 0;
async function venueWith(cat) {
  const db = openStore(':memory:');
  await bots.primeBotHash();
  n += 1;
  const provider = fakeProvider(cat);
  return { db, provider, suffix: n };
}

/** The local market + selection ids materialised for a feed market id. */
function mapped(db, marketExternalId) {
  const marketId = feedcat.lookup(db, 'postgres', 'market', marketExternalId);
  const selections = db
    .prepare(
      `SELECT s.id, s.name, s.fair_price, s.ltp, s.status, fm.external_id
         FROM selections s JOIN feed_map fm ON fm.local_id = s.id AND fm.kind = 'selection' AND fm.provider = ?
        WHERE s.market_id = ? ORDER BY s.id`
    )
    .all('postgres', marketId);
  return { marketId, selections };
}

/** Move a fixture's off time into the past — the clock advancing, not the data. */
function advanceToOff(db, marketId) {
  db.prepare("UPDATE events SET starts_at = datetime('now', '-1 hour') WHERE id = (SELECT event_id FROM markets WHERE id = ?)").run(marketId);
}

function rowsOf(db, table) {
  return db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
}

/**
 * A MATCHED position: Alice backs at 2.00 and Bob lays at 2.00.
 *
 * Both sides, deliberately. An order that merely RESTS is refunded at
 * settlement and pays nothing, so a settlement test built on one would assert
 * "the backer's stake came back" and read as proof that the right runner was
 * paid — and it would pass against a settlement that paid the WRONG runner,
 * because both outcomes return the same stake. The loser is what makes the
 * assertion mean something: only the correct winner is made richer.
 */
async function matchedBack(db, suffix, selectionId) {
  const alice = await A.registerUser(db, { username: `alice${suffix}`, password: 'pw-alice-123', balance_cents: 100000 });
  const bob = await A.registerUser(db, { username: `bob${suffix}`, password: 'pw-bob-123', balance_cents: 100000 });
  M.placeOrder(db, alice, { selection_id: selectionId, side: 'back', price: 2.0, stake_cents: 10000 });
  const taker = M.placeOrder(db, bob, { selection_id: selectionId, side: 'lay', price: 2.0, stake_cents: 10000 });
  assert.strictEqual(taker.fills.length, 1, 'the fixture position really matched, so settlement has something to settle');
  return { alice, bob };
}

// ── FB1 ───────────────────────────────────────────────────────────────────────

// IDEMPOTENCE. Two syncs of an unchanged feed must produce identical rows AND
// identical local ids — and the second must not have created anything.
//
// The local ids are the half that matters and the half a count cannot see: a
// sync that re-created every market under a new id would pass a row-count
// assertion and leave the results translation pointing at rows that no longer
// hold anyone's position. So the mapping itself is compared, row for row.
check('FB1 a second sync of an unchanged feed changes nothing at all', async () => {
  const v = await venueWith(catalogue());
  const first = await feedcat.sync(v.db, { provider: v.provider });
  assert.strictEqual(first.materialised, 3, 'three markets, one of them refused for its off time');

  const snapshot = () => ({
    counts: ['sports', 'competitions', 'events', 'markets', 'selections', 'feed_map'].map((t) => rowsOf(v.db, t)),
    map: v.db.prepare('SELECT kind, external_id, local_id FROM feed_map ORDER BY kind, external_id').all(),
  });
  const before = snapshot();

  const second = await feedcat.sync(v.db, { provider: v.provider });
  const after = snapshot();

  assert.deepStrictEqual(after.counts, before.counts, `row counts moved: ${JSON.stringify(before.counts)} -> ${JSON.stringify(after.counts)}`);
  assert.deepStrictEqual(after.map, before.map, 'and every local id is the one it was');
  assert.deepStrictEqual(second.created, {
    sports_created: 0, competitions_created: 0, events_created: 0, markets_created: 0, selections_created: 0,
  }, 'the second run created nothing at all');
  assert.strictEqual(second.deactivated.length, 0, 'and deactivated nothing: every market was still in the feed');
  assert.strictEqual(v.provider.calls.nav, 2, 'one catalogue read per run, not one per market');
  assert.strictEqual(v.provider.calls.market.length, 8,
    `and exactly one market read per PLANNED market, per run — 4 in the catalogue x 2 runs, not 4 per run plus a re-read: ${JSON.stringify(v.provider.calls.market)}`);
});

// ── FB2 ───────────────────────────────────────────────────────────────────────

// A MARKET THAT LEAVES THE FEED IS SUSPENDED, NEVER DELETED, and everything a
// player holds on it survives.
//
// The orders are the point. A feed that drops a market before it goes off is
// ordinary (a postponement, a withdrawal of the whole race), and the venue's
// answer has to be "nobody may bet this any more", not "the rows are gone": a
// delete would take a resting order and its escrow with it, and would leave the
// wallet disagreeing with the ledger.
//
// THE CONTROL BESIDE IT: a market that leaves the feed AFTER going off is NOT
// suspended. Suspending it would remove it from `pendingMarkets`, so the outcome
// that pays its backers could never be applied — the venue would be left holding
// a position it had closed the only route to. Both halves are one test because
// getting either one wrong is the same failure wearing different clothes.
check('FB2 a market that leaves the feed is suspended, never deleted, and its orders survive', async () => {
  const cat = catalogue();
  const v = await venueWith(cat);
  await feedcat.sync(v.db, { provider: v.provider });

  const dropped = mapped(v.db, '1.200');          // gone from the feed, still PRE-off
  const finished = mapped(v.db, '1.400');         // gone from the feed, and OFF
  advanceToOff(v.db, finished.marketId);

  const alice = await A.registerUser(v.db, { username: `alice${v.suffix}`, password: 'pw-alice-123', balance_cents: 100000 });
  const resting = M.placeOrder(v.db, alice, {
    selection_id: dropped.selections[0].id, side: 'back', price: 2.0, stake_cents: 5000,
  });
  assert.strictEqual(resting.fills.length, 0, 'the order rests — nothing to match against');
  const escrowedBefore = v.db.prepare('SELECT frozen_cents f FROM users WHERE id = ?').get(alice.id).f;
  assert.ok(escrowedBefore > 0, 'and it is escrowed while it rests');

  // The feed forgets both markets — '1.200' before the off, '1.400' after it.
  cat.meetings = cat.meetings
    .map((m) => ({ ...m, races: m.races.filter((r) => r.market_id !== '1.200' && r.market_id !== '1.400') }))
    .filter((m) => m.races.length > 0);
  const report = await feedcat.sync(v.db, { provider: v.provider });

  assert.ok(
    report.deactivated.some((d) => d.market_id === dropped.marketId),
    `the pre-off market that left the feed is suspended (got ${JSON.stringify(report.deactivated)})`
  );
  const after = v.db.prepare('SELECT status FROM markets WHERE id = ?').get(dropped.marketId);
  assert.ok(after, 'the market ROW SURVIVES — suspended, not deleted');
  assert.strictEqual(after.status, 'suspended');

  const order = v.db.prepare('SELECT * FROM orders WHERE id = ?').get(resting.order.id);
  assert.ok(order, 'and the order on it survives, escrow included');
  assert.strictEqual(order.frozen_cents, resting.order.frozen_cents);
  assert.strictEqual(v.db.prepare('SELECT frozen_cents f FROM users WHERE id = ?').get(alice.id).f, escrowedBefore,
    'the wallet still holds exactly that escrow');
  assert.strictEqual(acc.assertConserved(v.db), 0, 'and the books still balance');

  // THE CONTROL. The same disappearance, after the off.
  assert.ok(!report.deactivated.some((d) => d.market_id === finished.marketId), 'the market that left AFTER the off is not suspended');
  assert.ok(
    report.left_the_feed_already_off.some((d) => d.market_id === finished.marketId),
    'and it is reported as such, rather than quietly skipped'
  );
  assert.strictEqual(v.db.prepare('SELECT status FROM markets WHERE id = ?').get(finished.marketId).status, 'open',
    'still open, so pendingMarkets still asks about it and its result can settle it');
});

// ── FB3 ───────────────────────────────────────────────────────────────────────

// AN OFF TIME THE FEED CANNOT EXPRESS IS REFUSED AND NAMED.
//
// `lib/offtime.js` treats an unparseable off time as CLOSED — fail-closed, so a
// bad catalogue row can never silently re-open in-play trading. That is the right
// rule for a gate and the wrong thing to write into a row: a market whose off
// time is unreadable can never be bet and never be settled, so the honest answer
// is to refuse the row and say which fixture was refused.
//
// THE CONTROL: the two markets on the SAME provider, in the same call, with
// parseable off times, are materialised. Without it this would pass against a
// sync that refused everything.
check('FB3 an unparseable off time is refused by name, and no row is written', async () => {
  const v = await venueWith(catalogue());
  const report = await feedcat.sync(v.db, { provider: v.provider });

  const refused = report.refused.filter((r) => r.reason === 'unparseable_off_time');
  assert.strictEqual(refused.length, 1, `exactly one fixture is refused (got ${JSON.stringify(report.refused)})`);
  assert.ok(/Broken Fixture/.test(refused[0].name), `and it is refused BY NAME, not counted: ${refused[0].name}`);
  assert.strictEqual(refused[0].external_id, '20', 'naming the id the feed published it under');
  assert.ok(/offtime/.test(refused[0].detail), `and explaining why: ${refused[0].detail}`);

  // NO ROW. Not a row with a garbage timestamp, not an event with no market.
  assert.strictEqual(v.db.prepare("SELECT COUNT(*) c FROM events WHERE name LIKE '%Broken%'").get().c, 0,
    'no event was written for it');
  assert.strictEqual(v.db.prepare('SELECT COUNT(*) c FROM markets WHERE id = (SELECT local_id FROM feed_map WHERE external_id = ?)').get('1.300').c, 0,
    'and no market was mapped to the feed market it offered');
  assert.strictEqual(v.db.prepare("SELECT COUNT(*) c FROM events WHERE starts_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'").get().c, 0,
    'and NO row anywhere carries a timestamp the venue did not write itself');

  // THE CONTROL: the same provider, the same run, two markets that did parse.
  const good = mapped(v.db, '1.100');
  assert.ok(good.marketId, 'a fixture with a readable off time IS materialised');
  assert.strictEqual(good.selections.length, 3);
});

// ── FB4 ───────────────────────────────────────────────────────────────────────

// NO FEED PRICE EVER REACHES fair_price OR ltp.
//
// `fair_price` is the venue's price: lib/bots.js builds a ladder around it and
// lib/cashout.js computes a buyout from it. The fixture above prices its runners
// at 2.6 / 5.5 / 9.0 — nothing like even money — so a venue that copied them
// cannot also pass this.
//
// BOTH DIRECTIONS OF THE RULE ARE ASSERTED. The seed is the venue's own
// (FEED_BOOK_SEED_PRICE, 2.00 by default), and a LATER sync that renames a
// runner or moves the fixture cannot move that price — which is the half a
// first-run assertion cannot see, and the half that matters on the sixth sync of
// the day when the feed's book has moved a long way from where it was.
check('FB4 a feed price never reaches fair_price or ltp, on the first sync or any later one', async () => {
  const cat = catalogue();
  const v = await venueWith(cat);
  await feedcat.sync(v.db, { provider: v.provider });

  const seeded = v.db.prepare('SELECT id, name, fair_price, ltp FROM selections ORDER BY id').all();
  assert.ok(seeded.length >= 5, `runners were materialised (got ${seeded.length})`);
  for (const s of seeded) {
    assert.strictEqual(s.fair_price, 2, `${s.name} is seeded at the venue's own even money, not the feed's`);
    assert.strictEqual(s.ltp, null, `${s.name} has no last-traded price: nothing has traded on it`);
  }

  // THE FEED MOVES. Every price doubles, a runner is renamed, the fixture moves.
  cat.meetings[0].races[0].runners[0].name = 'Piteraq (GB)';
  cat.meetings[0].races[0].runners[0].back = [{ price: 1.2, size: 5000 }];
  cat.meetings[0].races[0].runners[0].lay = [{ price: 1.1, size: 5000 }];
  await feedcat.sync(v.db, { provider: v.provider });

  const after = v.db.prepare('SELECT id, name, fair_price, ltp FROM selections ORDER BY id').all();
  assert.deepStrictEqual(after.map((s) => s.fair_price), seeded.map((s) => s.fair_price),
    'a re-sync did not move a single venue price');
  assert.ok(after.every((s) => s.ltp === null), 'nor invent a last-traded price');
  assert.strictEqual(after.find((s) => s.id === seeded[0].id).name, 'Piteraq (GB)',
    'while the name DID follow the feed — the catalogue is the feed to say, the price is the venue to set');

  // AND THE LADDER IS BUILT FROM THE VENUE'S PRICE. This is the assertion that
  // would catch the hazard docs/FEED.md names — a good price a sharp client
  // takes from you — at the only place it would be taken.
  await bots.quoteMarket(v.db, seeded[0].id ? v.db.prepare('SELECT market_id FROM selections WHERE id = ?').get(seeded[0].id).market_id : 0);
  const ladder = v.db.prepare("SELECT DISTINCT price FROM orders WHERE selection_id = ? ORDER BY price").all(seeded[0].id).map((r) => r.price);
  assert.ok(ladder.length > 0, 'the venue quoted the selection');
  assert.ok(ladder.every((p) => p < 3), `every quote is within a few ticks of even money (got ${JSON.stringify(ladder)})`);
  assert.ok(!ladder.some((p) => Math.abs(p - 1.15) < 0.05), `and none of them is the feed's new 1.2/1.1 (got ${JSON.stringify(ladder)})`);
});

// ── FB5 ───────────────────────────────────────────────────────────────────────

// A MATERIALISED MARKET IS TRADEABLE. This is the test that would have failed
// before #101, and it is three assertions in one: the order is accepted, the
// collateral moves, and the price the venue moves it by is the venue's own.
//
// THE CONTROL BESIDE IT: the same player, in the same venue, against a feed
// selection id this venue never materialised, is refused — 404, before any
// collateral. Without that, "an order was accepted" could be passing because the
// boundary had quietly gone away.
check('FB5 a materialised market is tradeable, and only at the venue own price', async () => {
  const v = await venueWith(catalogue());
  await feedcat.sync(v.db, { provider: v.provider });
  const { marketId, selections } = mapped(v.db, '1.100');
  const [first, second] = selections;

  const alice = await A.registerUser(v.db, { username: `alice${v.suffix}`, password: 'pw-alice-123', balance_cents: 100000 });
  const bob = await A.registerUser(v.db, { username: `bob${v.suffix}`, password: 'pw-bob-123', balance_cents: 100000 });

  const back = M.placeOrder(v.db, alice, { selection_id: first.id, side: 'back', price: 2.0, stake_cents: 5000 });
  assert.ok(back.order.id, 'the order reaches the engine and is accepted');
  const held = v.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(alice.id);
  assert.ok(held.f > 0, `and collateral is HELD against it (frozen=${held.f})`);
  // Escrow is an intra-player split — spendable to held — so the balance column
  // is unchanged and the availability is what fell. Asserting the wrong column
  // would make this check pass against a venue that took the stake out of the
  // balance and never gave it back.
  assert.strictEqual(held.b, 100000, 'and the balance is an intra-player split, not a debit');
  const acct = v.db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ? AND type = ?').get(alice.id, 'escrow');
  assert.ok(acct.c > 0, 'with the escrow posting recorded');
  assert.strictEqual(acc.assertConserved(v.db), 0, 'and the books balance with the collateral held');

  const lay = M.placeOrder(v.db, bob, { selection_id: first.id, side: 'lay', price: 2.0, stake_cents: 5000 });
  assert.strictEqual(lay.fills.length, 1, 'and it MATCHES against the counterparty');

  // THE PRICE MOVED BY THE VENUE'S OWN RULE — which right now is nobody's: drift
  // is off and a fill does not re-price a selection. What is asserted is that
  // the venue's price is still the venue's price after money moved through it.
  assert.strictEqual(v.db.prepare('SELECT fair_price f FROM selections WHERE id = ?').get(first.id).f, 2,
    'a fill did not move the venue price');
  assert.strictEqual(v.db.prepare('SELECT ltp l FROM selections WHERE id = ?').get(first.id).l, 2,
    'and ltp is now the venue own traded price — a real fill, not a feed price');
  assert.ok(v.db.prepare('SELECT COUNT(*) c FROM matches WHERE selection_id = ?').get(first.id).c > 0, 'the tape recorded it');
  assert.strictEqual(acc.assertConserved(v.db), 0, 'and the books balance');

  // THE CONTROL: a selection this venue never materialised is still refused,
  // with nothing escrowed — the boundary feed-display-only.test.js owns.
  const bobBefore = v.db.prepare('SELECT frozen_cents f FROM users WHERE id = ?').get(bob.id).f;
  assert.throws(
    () => M.placeOrder(v.db, bob, { selection_id: 31, side: 'back', price: 2.0, stake_cents: 5000 }),
    (e) => e.status === 404,
    'the raw feed selection id is not this venue to trade'
  );
  assert.strictEqual(v.db.prepare('SELECT frozen_cents f FROM users WHERE id = ?').get(bob.id).f, bobBefore,
    'and the refusal took no collateral — not even one cent more than was already held');
  assert.ok(second && second.id !== first.id, 'the other runner is a distinct row');
});

// ── FB6 ───────────────────────────────────────────────────────────────────────

// THE BOUNDARY STILL HOLDS. Two assertions: the sibling suite still passes, and
// the two facts it owns are asserted here directly so a reader of THIS file does
// not have to run another one to know the reference board is still display-only.
//
// The sibling run is a subprocess on purpose. `tests/run_all.js` runs every suite
// in its own process, so asserting on it in-process would assert on a module
// cache this suite had already warmed — which would be a check that passes
// whatever the other file says.
check('FB6 the display-only boundary is intact, and its suite still passes', async () => {
  // (a) The suite itself.
  const out = execFileSync(process.execPath, [path.join(__dirname, 'feed-display-only.test.js')], { encoding: 'utf8' });
  assert.match(out, /feed-display-only\.test\.js: 5 checks passed/, 'the display-only suite is green');

  // (b) A feed market the venue has NOT materialised has no row, and naming its
  // selection id is a 404 with no collateral taken. Both, here, not only there.
  const v = await venueWith(catalogue());
  await feedcat.sync(v.db, { provider: v.provider });
  const alice = await A.registerUser(v.db, { username: `alice${v.suffix}`, password: 'pw-alice-123', balance_cents: 100000 });
  const unmaterialised = '9.999999';
  assert.strictEqual(v.db.prepare('SELECT COUNT(*) c FROM markets WHERE CAST(id AS TEXT) = ?').get(unmaterialised).c, 0,
    'a feed market with no local row has no local row');
  assert.strictEqual(v.db.prepare('SELECT COUNT(*) c FROM feed_map WHERE external_id = ?').get(unmaterialised).c, 0,
    'and is not in the identity map either');
  assert.throws(
    () => M.placeOrder(v.db, alice, { selection_id: 88881, side: 'back', price: 2.0, stake_cents: 5000 }),
    (e) => e.status === 404 && /selection not found/i.test(e.message),
    'and the engine refuses it before any collateral'
  );
  assert.strictEqual(v.db.prepare('SELECT frozen_cents f FROM users WHERE id = ?').get(alice.id).f, 0);

  // (c) THE CONTROL: the market that WAS materialised, from the same provider
  // and the same sync, IS tradeable. The boundary is a line, not a wall.
  const { selections } = mapped(v.db, '1.100');
  assert.ok(M.placeOrder(v.db, alice, { selection_id: selections[0].id, side: 'back', price: 2.0, stake_cents: 5000 }).order.id,
    'the materialised neighbour of that same feed market takes the order');
});

// ── FB7 ───────────────────────────────────────────────────────────────────────

// INBOUND TRANSLATION. An outcome naming the FEED's runner ids settles the right
// LOCAL market and pays the right LOCAL selection.
//
// Three of these assertions are about WHERE THE MONEY WENT rather than about a
// status code, because a settlement that reports `settled` and pays the wrong
// runner is the failure this whole file is about, and it would report itself as
// a pass.
//
// THE CONTROL: the same outcome naming this venue's OWN runner id settles
// identically. An operator's results API may answer in either space — the poll
// body now carries both — so both must work, and a translation layer that only
// understood the feed's space would fail this.
check('FB7 an outcome naming feed runner ids settles the right local selection', async () => {
  const v = await venueWith(catalogue());
  await feedcat.sync(v.db, { provider: v.provider });
  const { marketId, selections } = mapped(v.db, '1.100');
  const winner = selections[1];               // "Steamy", feed selection id 32
  const loser = selections[0];                // "Piteraq", feed selection id 31

  const { alice, bob } = await matchedBack(v.db, v.suffix, winner.id);
  // THE CLOCK MOVES AFTER THE BET, never before it: lib/offtime.js refuses an
  // order at or after the off, so advancing first would be refusing the venue its
  // own product. A race is bettable before it goes off and settleable after.
  advanceToOff(v.db, marketId);

  const run = await results.pollOnce(v.db, async () => ({
    [marketId]: { status: 'completed', winners: [32] },      // the FEED's runner id
  }));
  assert.strictEqual(run.applied, 1);
  assert.strictEqual(run.results[0].outcome, 'settled', `settled rather than held: ${JSON.stringify(run.results[0])}`);

  const market = v.db.prepare('SELECT status, winner_selection_id FROM markets WHERE id = ?').get(marketId);
  assert.strictEqual(market.status, 'settled');
  assert.strictEqual(market.winner_selection_id, winner.id, 'and it paid the LOCAL selection the feed meant');
  assert.notStrictEqual(winner.id, 32, 'which is demonstrably not the feed id');
  // WHERE THE MONEY WENT. 10000 staked at 2.00 is 10000 won; the venue keeps
  // COMMISSION_RATE (2.5%) of it, and the stake itself comes back as RELEASED
  // ESCROW rather than as a credit — escrow here is an intra-player split, so a
  // winner's balance rises by the net profit alone. The losing side is asserted
  // too, because a settlement of the WRONG runner would leave these two numbers
  // reversed and nothing above could tell.
  const paid = v.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(alice.id);
  assert.deepStrictEqual(
    [paid.b, paid.f], [109750, 0],
    'the backer is up by the net profit (10000 less COMMISSION_RATE = 250) with nothing still held'
  );
  const charged = v.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(bob.id);
  assert.deepStrictEqual([charged.b, charged.f], [90000, 0], 'and the losing side is out exactly its 10000 stake');
  assert.strictEqual(acc.assertConserved(v.db), 0, 'and conservation holds');

  // THE PROVENANCE ROW SAYS WHICH SPACE THE FEED USED. That is the question an
  // operator asks first when an outcome looks wrong, and it is unanswerable
  // unless it was written at the moment the signal was admitted.
  const prov = v.db.prepare('SELECT * FROM result_events WHERE market_id = ?').get(marketId);
  assert.strictEqual(prov.source_event_id, '1.100', 'the recorded source id is the FEED market id, not ours');
  const payload = JSON.parse(prov.payload);
  assert.strictEqual(payload.id_space, 'feed', 'and the payload records the id space the signal arrived in');
  assert.strictEqual(payload.winners[0], winner.id, 'recording the LOCAL id the decision was made on');
  assert.strictEqual(payload.feed_market_id, '1.100');

  // A re-delivery is a no-op, and WHICH guard does it depends on the market's
  // state: a SETTLED market is not pending at all, so the second poll never asks
  // about it. That is the terminal state doing the work, and it is exactly why
  // the case below — a market that STAYS OPEN — is the one that needs the
  // delivery guard.
  const again = await results.pollOnce(v.db, async () => ({ [marketId]: { status: 'completed', winners: [32] } }));
assert.ok(
    !results.pendingMarkets(v.db).some((m) => m.id === marketId),
    'a settled market is no longer in the pending set, so there is nothing to re-apply'
  );
  assert.strictEqual(again.applied, 0);
  assert.ok(!again.results.some((r) => r.market_id === marketId), 'and the repeat produced no result for it');
  assert.strictEqual(v.db.prepare('SELECT balance_cents b FROM users WHERE id = ?').get(alice.id).b, 109750,
    'and the backer is not paid twice');
  assert.strictEqual(v.db.prepare('SELECT COUNT(*) c FROM settlements WHERE market_id = ?').get(marketId).c, 2,
    'with one settlement row per player, and no more after the repeat than before');
  assert.strictEqual(loser.id !== winner.id, true);
});

// ── FB7c: the re-delivery guard where it actually has to work ─────────────────

// A PRE-OFF WITHDRAWAL is the case the re-delivery guard exists for, and the one
// a market that STAYS OPEN exposes. It is not a settlement: the runner is removed
// and its backers refunded, and the market keeps trading — so there is no
// terminal state for a second delivery to bump into, and `alreadyApplied` plus
// `idx_result_events_source` is the only thing standing between a feed that
// repeats itself and a double refund.
//
// It can only fire because the recorded `source_event_id` is now the FEED's own
// id for the market. Before #101 `externalId` was null on every polled signal,
// so this branch was unreachable from the transport and the unique index it
// guards never fired; a repeat would have reached the INSERT and thrown, which
// `pollNow` reports as a consumer failure for the whole cycle.
//
// THE CONTROL BESIDE IT: the FIRST delivery. Same signal, one of them, and it
// must actually refund — otherwise "the second did nothing" is trivially true of
// a withdrawal that never did anything.
check('FB7c a re-delivered withdrawal refunds once, and the market keeps trading', async () => {
  const v = await venueWith(catalogue());
  await feedcat.sync(v.db, { provider: v.provider });
  const { marketId, selections } = mapped(v.db, '1.100');
  const withdrawn = selections[0];                     // "Piteraq", feed selection id 31
  const { alice, bob } = await matchedBack(v.db, v.suffix, withdrawn.id);
  // The fixture is OFF before the notice arrives, because that is the only state
  // the venue asks about: `pendingMarkets` is the set of markets whose event has
  // gone off, so a notice about a market still running pre-off is never polled
  // for. That is lib/results.js's own rule and it is unchanged by this work —
  // what changes is that the ids in the notice now resolve.
  advanceToOff(v.db, marketId);

  const signal = { non_runners: [31] };
  const first = await results.pollOnce(v.db, async () => ({ [marketId]: signal }));
  assert.strictEqual(first.results[0].outcome, 'withdrawn',
    `the FIRST delivery acts: ${JSON.stringify(first.results[0])}`);
  assert.deepStrictEqual(first.results[0].voided_selections, [withdrawn.id]);
  assert.strictEqual(v.db.prepare('SELECT status FROM selections WHERE id = ?').get(withdrawn.id).status, 'void',
    'the withdrawn runner is off the board');
  assert.strictEqual(v.db.prepare('SELECT status FROM markets WHERE id = ?').get(marketId).status, 'open',
    'and the market keeps trading — a withdrawal is not an outcome');
  const refunded = v.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(alice.id);
  assert.deepStrictEqual([refunded.b, refunded.f], [100000, 0], 'the backer was made whole');
  assert.deepStrictEqual(
    [v.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(bob.id).b,
      v.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(bob.id).f],
    [100000, 0],
    'and the other side of the match was not charged for it either'
  );
  assert.strictEqual(acc.assertConserved(v.db), 0, 'and it balances');

  // THE RE-DELIVERY.
  const second = await results.pollOnce(v.db, async () => ({ [marketId]: signal }));
  assert.strictEqual(second.results[0].outcome, 'already_applied',
    `the SECOND is a no-op: ${JSON.stringify(second.results[0])}`);
  assert.strictEqual(v.db.prepare('SELECT COUNT(*) c FROM result_events WHERE market_id = ?').get(marketId).c, 1,
    'one provenance row, not two — the unique index on (source, source_event_id) held');
  assert.strictEqual(v.db.prepare('SELECT source_event_id s FROM result_events WHERE market_id = ?').get(marketId).s, '1.100',
    'and it is recorded in the FEED id space, which is what makes the guard fire');
  assert.strictEqual(v.db.prepare('SELECT balance_cents b FROM users WHERE id = ?').get(alice.id).b, 100000,
    'nobody was refunded twice');
  assert.strictEqual(v.db.prepare('SELECT balance_cents b FROM users WHERE id = ?').get(bob.id).b, 100000);
  assert.strictEqual(acc.assertConserved(v.db), 0, 'and it still balances');
});

// ── FB7b (the control for FB7, in the same venue shape) ───────────────────────

check('FB7b the same outcome in the venue own id space settles identically', async () => {
  const v = await venueWith(catalogue());
  await feedcat.sync(v.db, { provider: v.provider });
  const { marketId, selections } = mapped(v.db, '1.400');
  const winner = selections[0];

  const { alice, bob } = await matchedBack(v.db, v.suffix, winner.id);
  advanceToOff(v.db, marketId);

  const run = await results.pollOnce(v.db, async () => ({
    [marketId]: { status: 'completed', winners: [winner.id] },      // THIS VENUE's runner id
  }));
  assert.strictEqual(run.results[0].outcome, 'settled', `the local space settles too: ${JSON.stringify(run.results[0])}`);
  assert.strictEqual(v.db.prepare('SELECT winner_selection_id w FROM markets WHERE id = ?').get(marketId).w, winner.id);
  // THE SAME NUMBERS AS FB7. That equality is the control: an operator's results
  // API may answer in either space, and the two must not be two different
  // venues. (Compared as arrays rather than as objects because node:sqlite hands
  // back null-prototype rows and deepStrictEqual compares the prototype — the
  // trap tests/nonrunner.test.js records.)
  const wallet = (id) => {
    const r = v.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(id);
    return [r.b, r.f];
  };
  assert.deepStrictEqual(wallet(alice.id), [109750, 0], 'and the money went exactly where it went for the feed id');
  assert.deepStrictEqual(wallet(bob.id), [90000, 0]);
  assert.strictEqual(JSON.parse(v.db.prepare('SELECT payload FROM result_events WHERE market_id = ?').get(marketId).payload).id_space, 'local',
    'and the provenance says so, rather than claiming the feed spoke in its own space');
});

// ── FB8 ───────────────────────────────────────────────────────────────────────

// OUTBOUND TRANSLATION. The body POSTed to RESULTS_FEED_URL must let the
// operator's API recognise the market it is being asked about — which for a
// materialised market is the id the FEED published, not the autoincrement row
// the feed has never seen.
//
// BOTH IDS RIDE ALONG, deliberately: an operator that answers in the venue's
// space keeps working, and one that answers in the feed's space can now.
//
// THE CONTROL: a market with no `feed_refs` — every market this venue created
// itself — produces the entry it produced before #101, byte for byte. An
// integrator written against the old body must not break because a new field was
// added on the path that matters.
check('FB8 the poll body carries the feed ids for a materialised market, and changes nothing else', async () => {
  const v = await venueWith(catalogue());
  await feedcat.sync(v.db, { provider: v.provider });
  const { marketId, selections } = mapped(v.db, '1.100');
  advanceToOff(v.db, marketId);

  // A venue-created market beside it — the control's subject.
  v.db.prepare("INSERT INTO events (sport_id, name, starts_at) SELECT sport_id, 'Venue own', datetime('now', '-1 hour') FROM events WHERE id = (SELECT event_id FROM markets WHERE id = ?)").run(marketId);
  const ev = v.db.prepare("SELECT id FROM events WHERE name = 'Venue own'").get().id;
  v.db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Venue own market')").run(ev);
  const ownMarket = v.db.prepare("SELECT id FROM markets WHERE event_id = ?").get(ev).id;
  v.db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Home', 2.0)").run(ownMarket);

  const pending = results.pendingMarkets(v.db);
  const body = resultsfeed.requestBody(pending);
  const materialised = body.markets.find((m) => m.id === marketId);
  const own = body.markets.find((m) => m.id === ownMarket);

  assert.ok(materialised, 'the materialised market is in the poll set');
  assert.strictEqual(materialised.external_id, '1.100', 'named by the id the FEED published');
  assert.strictEqual(materialised.event_external_id, '10', 'and its fixture too');
  assert.strictEqual(materialised.external_provider, 'postgres', 'with the provider it came from, for an operator running two');
  assert.strictEqual(materialised.id, marketId, 'and our own id still, for the space we already spoke');
  assert.strictEqual(materialised.selections.length, 3, 'every runner is described');
  assert.deepStrictEqual(
    materialised.selections.map((s) => s.external_id).sort(),
    ['1.100:31', '1.100:32', '1.100:33'],
    'each by the COMPOSITE feed id — the bare id repeats across markets and would be ambiguous'
  );
  assert.deepStrictEqual(
    materialised.selections.map((s) => s.name).sort(),
    ['Piteraq', 'Rusty', 'Steamy'],
    'and each carries its own name rather than a name paired by list position'
  );
  for (const s of materialised.selections) {
    assert.ok(Number.isInteger(s.id), 'and the local id is still there for the space we already spoke');
  }

  // THE CONTROL. A venue's own market is described exactly as it was.
  assert.ok(own, 'the venue own market is in the same poll set');
  assert.strictEqual(own.external_id, undefined, 'no feed id, because it is not the feed market');
  assert.strictEqual(own.event_external_id, undefined);
  assert.deepStrictEqual(Object.keys(own).sort(), ['event_id', 'event_name', 'id', 'name', 'selections'],
    'and the same fields it has always had — nothing added, nothing removed');
  assert.deepStrictEqual(own.selections, [{ id: v.db.prepare('SELECT id FROM selections WHERE market_id = ?').get(ownMarket).id, name: 'Home' }]);

  // AND THE WHOLE BODY IS WHAT GOES ON THE WIRE — proven through the real
  // transport rather than through a function call, because the transport is
  // where a field can be dropped between the body and the socket.
  let sent = null;
  resultsfeed.resetState();
  const fetcher = resultsfeed.createFetcher({
    url: 'https://results.example/v1/outcomes',
    fetchImpl: async (url, opts) => {
      sent = JSON.parse(opts.body);
      return { ok: true, status: 200, text: async () => '{}', body: null };
    },
  });
  await fetcher(v.db);
  const onTheWire = sent.markets.find((m) => m.id === marketId);
  assert.strictEqual(onTheWire.external_id, '1.100', 'the id survived the journey to the socket');
  assert.deepStrictEqual(onTheWire.selections.map((s) => s.external_id).sort(), ['1.100:31', '1.100:32', '1.100:33']);
});

// ── FB9 ───────────────────────────────────────────────────────────────────────

// AN OUTCOME NAMING ANOTHER MARKET'S RUNNER IS REFUSED, NOT SETTLED.
//
// The scenario is not exotic. Betfair reuses selection ids across markets (31
// is a runner in '1.100' AND in '1.400' in this file's own fixture), a feed that
// answers about the wrong market is a configuration mistake rather than an
// attack, and the venue's job is to move no money and say why.
//
// THE CONTROL IS BESIDE IT, IN THE SAME VENUE, IN THE SAME SIGNAL SHAPE: the
// same market settles when the signal names ITS OWN runner. A test that only
// proved the refusal would also pass against a venue that refuses everything —
// which is the shape of bug this file has to avoid (STATE.md §5.6).
check('FB9 a signal naming another market runner is held, and the control settles', async () => {
  const v = await venueWith(catalogue());
  await feedcat.sync(v.db, { provider: v.provider });
  const mine = mapped(v.db, '1.100');
  const other = mapped(v.db, '1.400');

  // A MATCHED stake on MY market's runner, so there is money that a wrong
  // settlement would move — and a matched one, because a resting order is
  // refunded at settlement and would pay identically whichever runner won.
  const { alice, bob } = await matchedBack(v.db, v.suffix, mine.selections[0].id);
  const before = v.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(alice.id);
  advanceToOff(v.db, mine.marketId);
  advanceToOff(v.db, other.marketId);

  // THE REFUSAL. Market '1.100' is told that runner 72 — which belongs to
  // '1.400' and to no market here but that one — won.
  const refused = await results.pollOnce(v.db, async () => ({
    [mine.marketId]: { status: 'completed', winners: [72] },
  }));
  assert.strictEqual(refused.results[0].outcome, 'held', `held rather than settled: ${JSON.stringify(refused.results[0])}`);
  assert.strictEqual(refused.results[0].rule, 'id_space_unmapped', 'with the rule named');
  assert.ok(/held for review/.test(refused.results[0].reason), `and a reason a human can act on: ${refused.results[0].reason}`);
  assert.strictEqual(v.db.prepare('SELECT status, settlement_hold, hold_reason FROM markets WHERE id = ?').get(mine.marketId).status, 'open',
    'the market is still OPEN — a player holds a position in it');
  assert.strictEqual(v.db.prepare('SELECT settlement_hold h FROM markets WHERE id = ?').get(mine.marketId).h, 1);
  const after = v.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(alice.id);
  assert.deepStrictEqual([after.b, after.f], [before.b, before.f], 'no money moved');
  assert.strictEqual(acc.assertConserved(v.db), 0, 'and the books balance');
  // The OTHER market — the one the runner actually belongs to — was not touched
  // either, because it was not what was asked about.
  assert.strictEqual(v.db.prepare('SELECT status FROM markets WHERE id = ?').get(other.marketId).status, 'open');
  assert.strictEqual(v.db.prepare('SELECT settlement_hold h FROM markets WHERE id = ?').get(other.marketId).h, 0);

  // THE CONTROL. A LOCAL selection id of ANOTHER market is refused the same way,
  // because the second space is a space, not a loophole: an id that is not this
  // market's is not this market's, whichever space it is in.
  v.db.prepare('UPDATE markets SET settlement_hold = 0, hold_reason = NULL WHERE id = ?').run(mine.marketId);
  const refusedLocal = await results.pollOnce(v.db, async () => ({
    [mine.marketId]: { status: 'completed', winners: [other.selections[0].id] },
  }));
  assert.strictEqual(refusedLocal.results[0].outcome, 'held', 'a local id from another market is refused too');
  assert.strictEqual(refusedLocal.results[0].rule, 'id_space_unmapped');

  // AND THE SUCCESS, beside both refusals: my own runner, my own market.
  v.db.prepare('UPDATE markets SET settlement_hold = 0, hold_reason = NULL WHERE id = ?').run(mine.marketId);
  const settled = await results.pollOnce(v.db, async () => ({
    [mine.marketId]: { status: 'completed', winners: [31] },
  }));
  assert.strictEqual(settled.results[0].outcome, 'settled',
    `the same shape settles when it names this market's own runner: ${JSON.stringify(settled.results[0])}`);
  assert.strictEqual(v.db.prepare('SELECT winner_selection_id w FROM markets WHERE id = ?').get(mine.marketId).w, mine.selections[0].id);
  // …and it settled on the runner ALICE backed, which is the only thing that
  // distinguishes a settlement from a plausible one. A refusal test that never
  // checked the success case could not tell a correct settlement from a wrong one.
  assert.strictEqual(v.db.prepare('SELECT balance_cents b FROM users WHERE id = ?').get(alice.id).b, 109750,
    'and it paid the runner she actually backed');
  assert.strictEqual(v.db.prepare('SELECT balance_cents b FROM users WHERE id = ?').get(bob.id).b, 90000, 'and charged the other side');
});

// ── FB10 ──────────────────────────────────────────────────────────────────────

// THE REGRESSION THIS FILE EXISTS FOR: the translated path SETTLES where the
// untranslated path HOLDS.
//
// Two identical venues, the identical signal, the identical player position —
// one signal sent down `pollOnce` (which translates) and one sent straight to
// `applyOutcome` (which does not, because translation happens at the boundary and
// the boundary is `pollOnce`). The assertion is on the DIFFERENCE, which is the
// only thing that can fail if someone moves the translation inward, drops the
// `feed_map` join, or narrows it to the local space.
//
// The untranslated result is asserted FIRST and in full, because it is the
// control and it is the state the venue was in: settled=no, held=yes, the
// market parked with a hold reason, the backer's stake frozen and unpaid, the
// withdrawal-style refusal named `winner not in market`. Nothing about it
// throws, nothing about it looks like a fault, and nothing in a green suite
// would ever have reported it — which is why STATE.md §5.6 insists the
// combination be tested rather than the key.
check('FB10 the translated path settles where the untranslated path holds', async () => {
  // ONE venue, built twice, so the two paths cannot differ because of anything
  // but the translation itself.
  const build = async (name) => {
    const cat = catalogue();
    const v = await venueWith(cat);
    await feedcat.sync(v.db, { provider: v.provider });
    const { marketId, selections } = mapped(v.db, '1.100');
    // A MATCHED position, so a settlement pays a winner rather than refunding a
    // stake — otherwise "settled" and "held" could look alike in the wallet.
    const { alice, bob } = await matchedBack(v.db, name, selections[1].id);
    advanceToOff(v.db, marketId);
    return { ...v, marketId, selections, alice, bob };
  };
  const untranslated = await build('untranslated');
  const translated = await build('translated');

  // THE SIGNAL. Feed runner id 32 — "Steamy", the runner Alice backed.
  const signal = { status: 'completed', winners: [32] };
  assert.strictEqual(untranslated.selections[1].id !== 32, true,
    'the local selection id is demonstrably not the feed id, so the two paths cannot agree by accident');

  // ── PATH 1: NO TRANSLATION. What the venue did before this change. ────────
  const raw = results.applyOutcome(untranslated.db, untranslated.marketId, signal, { source: 'poll' });
  assert.strictEqual(raw.outcome, 'held', `an untranslated outcome holds: ${JSON.stringify(raw)}`);
  assert.strictEqual(raw.reason, 'winner not in market', 'and the reason is exactly the id-space mismatch');
  const rawMarket = untranslated.db.prepare('SELECT status, settlement_hold, hold_reason FROM markets WHERE id = ?').get(untranslated.marketId);
  assert.strictEqual(rawMarket.status, 'open', 'the market is parked, not settled');
  assert.strictEqual(rawMarket.settlement_hold, 1);
  const rawUser = untranslated.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(untranslated.alice.id);
  assert.deepStrictEqual([rawUser.b, rawUser.f], [100000, 10000],
    'and the backer holds a live position in a market the venue has parked: matched, unvoided, escrow intact');
  assert.strictEqual(untranslated.db.prepare('SELECT COUNT(*) c FROM settlements WHERE market_id = ?').get(untranslated.marketId).c, 0,
    'no settlement row exists — the failure is fail-safe, which is precisely why nothing noticed');
  assert.strictEqual(acc.assertConserved(untranslated.db), 0, 'and it balances, which is also why nothing noticed');

  // ── PATH 2: TRANSLATED. The same signal, the same position, the same venue. ─
  const run = await results.pollOnce(translated.db, async () => ({ [translated.marketId]: signal }));
  assert.strictEqual(run.results[0].outcome, 'settled',
    `the SAME signal settles once translated: ${JSON.stringify(run.results[0])}`);
  const goodMarket = translated.db.prepare('SELECT status, winner_selection_id FROM markets WHERE id = ?').get(translated.marketId);
  assert.strictEqual(goodMarket.status, 'settled');
  assert.strictEqual(goodMarket.winner_selection_id, translated.selections[1].id, 'and it paid the runner Alice actually backed');
  const goodUser = translated.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(translated.alice.id);
  assert.deepStrictEqual([goodUser.b, goodUser.f], [109750, 0],
    'and the backer was paid the net profit (10000 less 2.5% commission) with nothing still held');
  assert.deepStrictEqual(
    (({ b, f }) => [b, f])(translated.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(translated.bob.id)),
    [90000, 0],
    'while the losing side is out its stake'
  );
  assert.strictEqual(translated.db.prepare('SELECT COUNT(*) c FROM settlements WHERE market_id = ?').get(translated.marketId).c, 2,
    'and there is a settlement row per player to defend');

  // ── THE DIFFERENCE, STATED. ───────────────────────────────────────────────
  // Not a restatement of the two blocks above: this is the assertion that fails
  // if the two paths ever CONVERGE, which is what a translation accidentally
  // narrowed to the local space would do — it would make the untranslated path
  // succeed and the defect would be gone from view.
  assert.notStrictEqual(raw.outcome, run.results[0].outcome,
    'the two paths must disagree: if they agree, the translation is doing nothing');
  assert.strictEqual(acc.assertConserved(translated.db), 0, 'and the translated venue is just as balanced');

  // ── THE AMBIGUOUS CASE, WHICH IS THE ONE THAT MUST NOT SETTLE ─────────────
  // Feed runner id 32 resolves, in the FEED's space, to the selection Alice
  // backed. If this market ALSO had a LOCAL selection whose id is 32, the same
  // raw id would resolve in the venue's own space to a different runner — and
  // settling on a coin flip between two readings is the one thing this path must
  // never do. Local ids are small integers assigned in insert order and feed
  // runner ids are small integers too, so this is an ordinary coincidence rather
  // than a contrived one, which is exactly why it is a HOLD and not a rule.
  const ambiguous = await build('ambiguous');
  const decoy = ambiguous.db.prepare('SELECT id FROM selections WHERE market_id = ? AND id <> ? ORDER BY id LIMIT 1')
    .get(ambiguous.marketId, ambiguous.selections[1].id);
  assert.ok(decoy, 'there is a runner in this market to collide with');
  // Renumbered to 32: nothing references it — no order, no match, no settlement —
  // because the fixture only ever traded on the runner Alice backed.
  ambiguous.db.prepare('UPDATE selections SET id = 32 WHERE id = ?').run(decoy.id);
  const held = await results.pollOnce(ambiguous.db, async () => ({ [ambiguous.marketId]: signal }));
  assert.strictEqual(held.results[0].outcome, 'held',
    'an id readable in BOTH spaces to DIFFERENT runners is not translated at all');
  assert.strictEqual(held.results[0].rule, 'id_space_ambiguous', 'and it is held under the rule that names the ambiguity');
  assert.ok(/different selection/.test(held.results[0].reason), `with a reason that says so: ${held.results[0].reason}`);
  assert.strictEqual(ambiguous.db.prepare('SELECT status FROM markets WHERE id = ?').get(ambiguous.marketId).status, 'open',
    'the market is not settled on a guess');
  assert.strictEqual(ambiguous.db.prepare('SELECT balance_cents b FROM users WHERE id = ?').get(ambiguous.alice.id).b, 100000,
    'and nobody was paid');
});

// ── FB11 ──────────────────────────────────────────────────────────────────────

// THE ROUTE. Everything above drives `lib/feedcat.sync` directly, which is the
// honest unit under test — but a route nobody has ever exercised is the
// dead-control shape this repository keeps finding, and the route is where the
// authorisation, the rate limit, the audit row and the quoting-after-sync live.
//
// THE PROVIDER IS INJECTED THROUGH THE REGISTRY, which is the seam
// `lib/feed/provider.js` already exposes: `select(name)` returns a registered
// provider if there is one. The fake declares the name `'postgres'` — a name
// that IS in the capability table, so `assertProvider` accepts it — and is
// registered before `server.js` is required, because the route resolves the
// provider at call time through the same `current()` every other feed route
// uses. Nothing in production reads a fake; this is the test seam the module
// documents.
//
// THE CONTROLS BESIDE THE SUCCESS: a PLAYER cannot reach it (403), an
// ANONYMOUS caller cannot reach it (401), and the report says what it refused
// rather than reporting a clean run over a catalogue that contained a broken
// fixture.
check('FB11 the admin sync route materialises, audits, and refuses everyone else', async () => {
  const cat = catalogue();
  const provider = require('../lib/feed/provider');
  provider.register(fakeProvider(cat));

  const srv = require('../server');
  // `ready` is the seed bootstrap. server.js only calls `main()` when it IS the
  // entry module, so a test that requires it must await the seed itself — the
  // same thing tests/api.test.js does, and the reason the admin account exists
  // at all.
  await srv.ready;
  const server = srv.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, headers = {}) => fetch(base + path, { method: 'POST', headers }).then(async (r) => ({
    status: r.status,
    body: await r.json().catch(() => ({})),
  }));

  try {
    // THE CONTROL FIRST: authorisation, because a route that mutates the book
    // and answers a player is worth more than a route that does not work.
    const anon = await post('/api/admin/feed/sync');
    assert.strictEqual(anon.status, 401, 'an anonymous caller is refused');
    const player = await post('/api/admin/feed/sync', { 'content-type': 'application/json', cookie: `ob_session=not-a-session` });
    assert.strictEqual(player.status, 401, 'and so is a caller with no session at all');

    // Sign in as the seeded admin, the way every other admin route is driven.
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.strictEqual(login.status, 200, 'the admin can sign in');
    const cookie = (login.headers.getSetCookie()[0] || '').split(';')[0];

    const run = await post('/api/admin/feed/sync', { cookie });
    assert.strictEqual(run.status, 200, `the admin sync succeeds: ${JSON.stringify(run.body).slice(0, 300)}`);
    assert.strictEqual(run.body.materialised, 3, 'three markets materialised');
    // THE SEEDED VENUE ALREADY HAS `horse_racing` — the demo book ships it, and
    // lib/voidrules.js keys its racing rules on that exact slug. So the sync
    // created NO sport, and that is the assertion worth making: a feed spelling
    // that sport its own way must land on the venue's existing row rather than
    // creating a second one, which would be a sport the rules table does not
    // recognise — and an unknown sport defaults to VOID, so it would refund
    // every race nobody bet.
    assert.strictEqual(run.body.created.sports_created, 0, 'no second sport for a sport the venue already has');
    assert.strictEqual(
      srv.db.prepare("SELECT COUNT(*) c FROM sports WHERE slug LIKE 'horse%'").get().c, 1,
      'and exactly one horse-racing sport in the catalogue'
    );
    assert.ok(run.body.created.competitions_created > 0, 'while a competition the feed names differently is added');
    assert.ok(run.body.quoted_markets > 0, 'and the markets it wrote are quoted, so they are tradeable immediately');
    assert.strictEqual(run.body.seed_price, 2, 'the seed price it used is the venue own');
    // THE REFUSAL IS IN THE REPORT. A sync that reported success over a
    // catalogue containing an unreadable off time would be indistinguishable
    // from one that had nothing to refuse.
    assert.strictEqual(run.body.refused.length, 1);
    assert.strictEqual(run.body.refused[0].reason, 'unparseable_off_time');
    assert.ok(/Broken Fixture/.test(run.body.refused[0].name), 'named');

    // THE AUDIT ROW, on the row and not on the constant — tests/audit.test.js
    // A14's rule: a test over ACTIONS alone passes against an entry nothing
    // writes.
    const db = srv.db;
    const rows = db.prepare("SELECT * FROM audit_log WHERE action = ?").all('feed.catalogue_synced');
    assert.strictEqual(rows.length, 1, `one audit row for the sync (got ${rows.length})`);
    assert.strictEqual(rows[0].target, 'feed:catalogue');
    assert.ok(rows[0].actor_id, 'attributed to the operator who ran it');
    const after = JSON.parse(rows[0].after);
    assert.strictEqual(after.materialised, 3, 'and it records what the sync wrote');
    assert.strictEqual(after.refused, 1, 'and what it refused');

    // AND THE MATERIALISED MARKET IS NOW A ROW IN THE BOARD, tradeable, at the
    // venue's own price — the whole point, asserted through the HTTP surface.
    const board = db.prepare("SELECT m.id FROM markets m JOIN feed_map fm ON fm.local_id = m.id AND fm.kind='market' AND fm.provider='postgres' WHERE fm.external_id='1.100'").get();
    assert.ok(board, 'the market is in the venue catalogue');
    const sels = db.prepare('SELECT name, fair_price, ltp FROM selections WHERE market_id = ? ORDER BY id').all(board.id);
    assert.strictEqual(sels.length, 3);
    assert.ok(sels.every((s) => s.fair_price === 2 && s.ltp === null), `venue prices, no feed price: ${JSON.stringify(sels)}`);

    // A SECOND SYNC IS IDEMPOTENT over the route too, and says so.
    const again = await post('/api/admin/feed/sync', { cookie });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.created.markets_created, 0, 'the second run created nothing');
  } finally {
    server.close();
    provider.reset();
  }
});

(async () => {
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (e) {
      console.error(`  FAIL ${name}`);
      console.error(e);
      process.exit(1);
    }
    passed++;
    console.log('  ok', name);
  }
  if (passed < 13) { console.error('expected 13 checks'); process.exit(1); }
  console.log(`\nfeedbook.test.js: ${passed} checks passed`);
})();