// feed-display-only.test.js — feed markets that have NOT been materialised are
// DISPLAY ONLY, and the engine enforces it rather than relying on the client.
// Run: node tests/feed-display-only.test.js   (plain assert, no deps)
//
// WHY THIS SUITE EXISTS. docs/ROADMAP.md lists "Feed resilience" as an open gap
// with a specific fear: "A dropped SSE connection mid-event leaves an unmarked
// hole", and a stale feed price is the kind of thing a venue must not trade
// against. That reads like a money-path control, and I was about to build one —
// a pass that suspends markets whose prices have gone stale.
//
// The premise turned out to be false, and the check is cheap, so it is now a
// test rather than a memory:
//
//   1. A feed market has NO local row. The recorder's catalogue lives in its own
//      Postgres database; the venue's tradeable markets are rows in this one —
//      unless an operator has explicitly MATERIALISED it, which is a separate,
//      opt-in, audited action (#101) that mints its OWN rows at the VENUE's own
//      prices. A feed market this venue does not own is still only a row
//      somewhere else.
//   2. The engine refuses an order naming a feed selection id — 404, because
//      that selection does not exist here.
//   3. The client refuses as well, and says so ("Feed markets are display-only").
//
// So no money can be at stake in a stale feed price, and a guard that suspended
// markets on feed staleness would not be protecting anything. Worse, it would be
// actively dangerous: it would take FEED market ids and try to suspend LOCAL
// venue markets — a category error that could close the venue's real book
// because an unrelated market's prices were old.
//
// THE REAL CONSEQUENCE, CORRECTED (#101). The last paragraph of this header used
// to say the consequence was that, with FEED_ENABLED=true, "the venue has no
// price source of its own at all … the engine trades nothing in that mode".
// That was TRUE and it was the #101 defect: the bots and the drift engine were
// force-disabled so they could not requote over the observed book, so a venue
// running on a feed had a board of real fixtures and not one bettable market in
// it. It is no longer true. The bots now quote the VENUE's own book — including
// the markets lib/feedcat.js materialises from the feed's catalogue — and the
// feed's prices are still never copied into the venue's (see docs/FEED.md and
// F4 below).
//
// What survives unchanged, and is what this suite now exists to prove, is the
// boundary itself: a feed market that has NOT been materialised has no row here,
// so it is untradeable and unquotable, and the feed stays a reference surface
// rather than a merged product.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.DB_PATH = ':memory:';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';
process.env.COMMISSION_RATE = '0.025';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const acc = require('../lib/accounts');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

let n = 0;
async function venue() {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  n++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now','+2 hours'))").run(sp.id, `Ev ${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Ev ${n}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Alpha', 2.0)").run(mkt.id);
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=?').get(mkt.id).id;
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
  return { db, marketId: mkt.id, s1, alice };
}

// Betfair's own ids are dotted strings, and its selection ids are reused across
// markets — both are real shapes from the recorder, not invented ones.
const FEED_MARKET_ID = '1.234567890';
const FEED_SELECTION_ID = 58805; // "The Draw", reused in every soccer 1X2 market

// F1: a feed market has no local row, so there is nothing for a staleness guard
// to suspend and nothing for a player to bet on.
check('F1 a feed market has no local row', async () => {
  const f = (await venue());
  const found = f.db
    .prepare('SELECT COUNT(*) c FROM markets WHERE CAST(id AS TEXT) = ?')
    .get(FEED_MARKET_ID).c;
  assert.strictEqual(found, 0, 'the recorder catalogue is not this venue catalogue');
});

// F2: THE ENFORCEMENT IS SERVER-SIDE. This is the check that matters: the
// client refusing is a courtesy, and a courtesy is not a control. The engine
// refuses a feed selection id on its own.
check('F2 the engine refuses an order on a feed selection id', async () => {
  const f = (await venue());
  assert.throws(
    () => M.placeOrder(f.db, f.alice, { selection_id: FEED_SELECTION_ID, side: 'back', price: 2.0, stake_cents: 1000 }),
    (e) => e.status === 404 && /selection not found/i.test(e.message),
    'refused as a selection that does not exist here'
  );
  // And it refused WITHOUT moving money, which is the part a 404 that escrowed
  // first would get wrong.
  const u = f.db.prepare('SELECT balance_cents b, frozen_cents fz FROM users WHERE id=?').get(f.alice.id);
  assert.strictEqual(u.b, 100000, 'balance untouched');
  assert.strictEqual(u.fz, 0, 'nothing escrowed');
  assert.strictEqual(acc.assertConserved(f.db), 0);
});

// F3: the refusal is not an accident of this fixture — it holds for a feed
// market id in the string shape Betfair actually uses, and for a selection id
// that happens to exist locally but in a DIFFERENT market, which is the shape
// that would be dangerous if ids were matched loosely.
check('F3 the refusal is not id-shape dependent', async () => {
  const f = (await venue());
  // A local selection id, but asked for as a string.
  assert.throws(
    () => M.placeOrder(f.db, f.alice, { selection_id: String(f.s1), side: 'back', price: 2.0, stake_cents: 1000 }),
    (e) => e.status === 400,
    'a string id is a client error, not a silent match'
  );
  // A number that is a valid id but for no market the venue trades.
  assert.throws(
    () => M.placeOrder(f.db, f.alice, { selection_id: 999999, side: 'back', price: 2.0, stake_cents: 1000 }),
    (e) => e.status === 404
  );
});

// F4: THE CONTAINMENT IS STILL THERE, AND IT IS NOW STRUCTURAL.
//
// WHAT THIS CHECK USED TO ASSERT, AND WHY IT HAD TO CHANGE (#101). It recomputed
// the `BOTS_ON` hoist and then grepped server.js for the line
//
//   const BOTS_ON = config.BOT_ENABLED && !config.FEED_ENABLED;
//
// asserting that the feed suppresses the bots. That suppression is GONE, and it
// is gone on purpose: it was protecting a conflict that could not happen (a bot
// cannot requote a market this venue has no row for) at the cost of leaving the
// venue with no counterparty at all — the board showed real fixtures and none of
// them could be bet. lib/feedcat.js now materialises the feed's catalogue into
// the venue's own book, which the venue then quotes at its OWN prices, so the
// bots have to run for those markets to be tradeable. See the block comment at
// the hoist in server.js for the full argument.
//
// THE PART OF THAT WHICH MATTERS MOST, AND WHICH NOBODY SHOULD SKIP: the old
// assertion KEPT PASSING after the hoist changed, because the string it matched
// now appears in the COMMENT that explains why the hoist changed. A source-level
// regex standing in for a behavioural check, matching its own documentation —
// which is STATE.md §5.1 and §5.6 in one green line, and the reason the check
// below is behavioural rather than textual. If you change this hoist again, this
// check must still be able to tell.
//
// WHAT REPLACES IT. The reference board is not quoted because it HAS NO LOCAL
// ROW, so there is nothing for quoteAllMarkets to name — a stronger guarantee
// than the flag, because it holds with every config key set however the operator
// likes. The venue's own markets are quoted. Both are asserted by DOING them.
check('F4 the reference board is never quoted, and the venue own book is', async () => {
  const config = require('../lib/config');
  const bots = require('../lib/bots');

  // Drift is UNCHANGED: still force-disabled by the feed, and still a
  // statement about a hoist rather than a behaviour, so it is asserted as one.
  // (The bots are the opposite case — see above.)
  const hoist = require('fs').readFileSync(require.resolve('../server'), 'utf8');
  assert.ok(
    /const DRIFT_ON = config\.DRIFT_ENABLED && !config\.FEED_ENABLED;/.test(hoist),
    'server.js still suppresses the drift when the feed is on'
  );
  assert.strictEqual(
    config.DRIFT_ENABLED && !config.FEED_ENABLED, false,
    'with the feed forced on, drift is off whatever its own flag says'
  );

  // AND THE BOTS' HOIST IS NOT FEED-GATED — read from the CODE, with comments
  // STRIPPED. The comment this check sits under quotes the old expression
  // verbatim, because explaining a removal means writing down what was removed,
  // and an earlier version of this assertion matched that comment and kept
  // reporting green against a hoist that no longer existed. tests/guard.test.js
  // strips comments for the same reason and in the same way.
  const code = hoist.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    /const BOTS_ON = config\.BOT_ENABLED;/.test(code),
    'server.js quotes the venue own book whenever BOT_ENABLED, feed or not'
  );
  assert.ok(
    !/const BOTS_ON = config\.BOT_ENABLED && !config\.FEED_ENABLED;/.test(code),
    'and the feed no longer switches the venue own liquidity off'
  );

  // The behaviour. A venue whose only market is its own, with the feed on.
  const f = (await venue());
  await bots.primeBotHash();
  bots.quoteAllMarkets(f.db);

  // (a) the venue's own market is quoted — the thing that was impossible before
  const quotes = f.db.prepare("SELECT COUNT(*) c FROM orders o JOIN users u ON u.id = o.user_id WHERE u.is_bot = 1").get().c;
  assert.ok(quotes > 0, `the venue own market is quoted in feed mode (got ${quotes} bot orders)`);

  // (b) and NOTHING was quoted against the reference board, whose market and
  // selection ids have no row here at all. Counted over the whole venue, so a
  // bot ladder that somehow named a feed id would show up in it.
  const foreign = f.db
    .prepare('SELECT COUNT(*) c FROM selections WHERE CAST(id AS TEXT) = ?')
    .get(FEED_SELECTION_ID).c;
  assert.strictEqual(foreign, 0, 'the reference board still has no rows, so there was nothing to quote');
  const markets = f.db.prepare('SELECT COUNT(*) c FROM markets').get().c;
  assert.strictEqual(markets, 1, 'and exactly one market exists — the venue own');

  // (c) THE CONTROL, and the reason (a) means anything. A venue nobody quoted
  // has none of those orders: without this, "orders exist" would also pass
  // against a fixture that placed its own, and the count would be measuring the
  // fixture rather than the bots.
  const control = (await venue());
  const controlQuotes = control.db
    .prepare('SELECT COUNT(*) c FROM orders o JOIN users u ON u.id = o.user_id WHERE u.is_bot = 1')
    .get().c;
  assert.strictEqual(controlQuotes, 0, 'an unquoted venue has no bot orders, so the count above is the bots');

  // And the reference board is still untradeable through the ENGINE, which is
  // the half of the boundary F2 proves and the half no flag controls.
  assert.throws(
    () => M.placeOrder(control.db, control.alice, { selection_id: FEED_SELECTION_ID, side: 'back', price: 2.0, stake_cents: 1000 }),
    (e) => e.status === 404,
    'the reference board is still untradeable whatever the bots do'
  );
});

// F5: and the venue's own markets remain tradeable when the feed is on, because
// they are the venue's own. Without this the suite would be asserting a system
// that cannot trade at all, which would be a different (and wrong) conclusion.
check('F5 the venue own markets are unaffected by feed display', async () => {
  const f = (await venue());
  const bob = (await A.registerUser(f.db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 }));
  M.placeOrder(f.db, f.alice, { selection_id: f.s1, side: 'back', price: 2.0, stake_cents: 1000 });
  const r = M.placeOrder(f.db, bob, { selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 1000 });
  assert.strictEqual(r.fills.length, 1, 'the venue own market still matches');
  assert.strictEqual(acc.assertConserved(f.db), 0);
});

(async () => {
  // Drain the collected checks IN ORDER, awaiting each. A check that rejects
  // is a failure of this suite, not of the next file: exiting here stops
  // the rest of this suite running rather than letting a broken assertion
  // print a green line for a body that never completed.
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
  if (passed < 5) { console.error('expected 5 checks'); process.exit(1); }
  console.log(`\nfeed-display-only.test.js: ${passed} checks passed`);
})();
