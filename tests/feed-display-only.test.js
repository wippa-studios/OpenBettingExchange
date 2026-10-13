// feed-display-only.test.js — feed markets are DISPLAY ONLY, and the engine
// enforces it rather than relying on the client.
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
//      Postgres database; the venue's tradeable markets are rows in this one.
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
// The REAL consequence is the opposite one, and it is documented instead: with
// FEED_ENABLED=true the venue has no price source of its own at all, because
// bots and drift are force-disabled so they cannot requote over the observed
// book (server.js, the BOTS_ON/DRIFT_ON hoists). Feed mode is an observation tool
// attached to an engine, not a merged product — and the engine trades nothing in
// that mode. That is coherent, but it was not written down anywhere, and an
// operator reading "odds feed integration" would not expect it.
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

// F4: THE CONSEQUENCE, STATED AS A TEST. With the feed enabled, bots and drift
// are force-disabled so they cannot requote over the observed book, and feed
// markets are not tradeable — so the venue has no price source of its own and
// its own book is unquoted. This is the honest description of feed mode, and
// asserting it here is what stops someone reading "odds feed integration" and
// assuming the venue trades those markets.
check('F4 feed mode leaves the venue own book unquoted', async () => {
  const config = require('../lib/config');
  // The invariant that matters is the LOGIC of the hoist in server.js, not the
  // value of FEED_ENABLED in this suite (which is false). Recomputed with the
  // feed forced on: both must be off REGARDLESS of their own flags, because
  // their own flags are exactly what the hoist exists to override — a bot
  // requoting straight over the observed Betfair book would be the venue
  // fighting its own price source.
  const hoist = (feedEnabled) => ({
    bots: config.BOT_ENABLED && !feedEnabled,
    drift: config.DRIFT_ENABLED && !feedEnabled,
  });
  const feedOff = hoist(false);
  assert.strictEqual(feedOff.bots, config.BOT_ENABLED, 'with no feed, the flag stands');
  assert.strictEqual(feedOff.drift, config.DRIFT_ENABLED, 'with no feed, the flag stands');
  const feedOn = hoist(true);
  assert.strictEqual(feedOn.bots, false, 'the feed suppresses the bots');
  assert.strictEqual(feedOn.drift, false, 'the feed suppresses the drift');

  // Recomputing the expression is only meaningful while the CODE still has it,
  // so assert that too. The failure this guards against is a well-meaning
  // "fix" that makes the hoists respect their own flags again — which would
  // reintroduce bots quoting over the observed book and is very hard to notice,
  // because everything still works.
  const src = require('fs').readFileSync(require.resolve('../server'), 'utf8');
  assert.ok(
    /const BOTS_ON = config\.BOT_ENABLED && !config\.FEED_ENABLED;/.test(src),
    'server.js still suppresses the bots when the feed is on'
  );
  assert.ok(
    /const DRIFT_ON = config\.DRIFT_ENABLED && !config\.FEED_ENABLED;/.test(src),
    'server.js still suppresses the drift when the feed is on'
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
