// selfcross.test.js — the one deliberate weakening of the self-match guard (#75).
// Run: node tests/selfcross.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. The self-match guard stopped a user trading against
// themselves: no user may manufacture volume or P&L that no real counterparty
// produced. A user's AUTOMATED order crossing that same user's MANUAL order is
// now permitted, because with the house excluded from filling automated orders
// (#67) and only one real player on the venue, that is the only liquidity there
// is. Every automated order would otherwise rest forever.
//
// That is a real weakening and it is implemented as an explicit exception rather
// than by loosening the comparison, so the file exists to pin the EXACT width of
// what was given up:
//
//   PERMITTED   one side automated, both belong to this user
//   BLOCKED     two manual orders of one user      — unchanged
//   BLOCKED     two automated orders of one user   — still self-matching
//   BLOCKED     different users                    — ordinary crossing
//
// S4 and S5 are as important as S1. A test suite that only proves the new
// behaviour works would pass just as happily against a guard that had been
// deleted outright.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.FAUCET_MAX_CENTS = '100000';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');

let passed = 0;
// Every failure is reported. A harness that exits on the first one hides every
// later check behind it, and the later checks here are the ones that prove the
// exception is NARROW.
const failures = [];
const check = (name, fn) => { failures.push([name, fn]); };

let evCounter = 0;

async function fresh() {
  const db = openStore(':memory:');
  const mk = async (name, bal) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: bal });
  return {
    db,
    users: {
      alice: await mk('alice', 100000),
      bob: await mk('bob', 100000),
    },
  };
}

function mkMarket(db, name) {
  let sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  if (!sport) {
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
    sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  }
  evCounter++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now', '+2 hours'))")
    .run(sport.id, `SelfCross ${evCounter}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`SelfCross ${evCounter}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id);
  db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(mkt.id, name, 2.0);
  const sel = db.prepare('SELECT id FROM selections WHERE market_id = ? AND name = ?').get(mkt.id, name);
  return { selection_id: sel.id, market_id: mkt.id };
}

const orderRow = (db, id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const matchesFor = (db, orderId) =>
  db.prepare(
    'SELECT * FROM matches WHERE back_order_id = ? OR lay_order_id = ?'
  ).all(orderId, orderId);

// Mark an order as placed by automation. #76 owns the rule table, which does not
// exist yet, so the test writes the marker the guard actually reads rather than
// inventing a rule engine to produce it. What is under test here is the GUARD,
// not the rule that would set this column.
function markAutomated(db, orderId, ruleId = 9001) {
  db.prepare('UPDATE orders SET rule_id = ? WHERE id = ?').run(ruleId, orderId);
}

// ── S1 ─ the permitted case ─────────────────────────────────────────────────
check('S1 an automated order crosses the same user\'s manual order, and it is RECORDED', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');

  // Alice's bot backs. Her own manual order then lays against it.
  const bot = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'back', price: 2.0, stake_cents: 1000 }).order;
  markAutomated(db, bot.id);

  const manual = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });

  assert.strictEqual(manual.fills.length, 1, 'the permitted crossing did not happen');
  assert.strictEqual(manual.order.matched_cents, 1000, 'the manual order did not fill');

  // The crossing must be marked, or the weakening is invisible.
  const ms = matchesFor(db, bot.id);
  assert.strictEqual(ms.length, 1, `expected one match row, got ${ms.length}`);
  assert.strictEqual(ms[0].self_crossed, 1,
    'the match row does not record that this fill came from the player\'s OWN liquidity');
});

// ── S2 ─ the guard itself ────────────────────────────────────────────────────
check('S2 two MANUAL orders of one user are still blocked — the guard is intact', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');

  M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'back', price: 2.0, stake_cents: 1000 });
  const manual = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });

  assert.strictEqual(manual.fills.length, 0,
    'two manual orders of the same user matched — the ORIGINAL guard is gone');
  assert.strictEqual(manual.order.matched_cents, 0);
  assert.strictEqual(matchesFor(db, manual.order.id).length, 0, 'a match row was written anyway');
});

// ── S3 / S5 ─ NOW BEHAVIOURAL (#76) ─────────────────────────────────────────
//
// These two were pinned STRUCTURALLY — as regexes over lib/match.js's source —
// because an order could not be automated AND be the taker. `rule_id` was set by
// the engine when a rule fired, never by the request, so a test could only mark
// an order automated after `placeOrder` returned: by which time it had already
// matched. #75 said so explicitly and deferred the conversion to #76.
//
// #76 moved `rule_id` onto the INSERT, so an order is marked automated at the
// instant it starts matching, and both are driven here through the real rule
// engine — a real rule, a real price crossing, a real taker. The structural
// assertions are DELETED, not kept alongside: a source-level check that survives
// the thing it stood in for reads as coverage forever while checking nothing.
//
// Both drive an automated TAKER against a same-user resting order, which is the
// half #75 could not reach. They go through lib/userrules.js rather than
// marking a row by hand, so they also prove the engine — not a test fixture —
// is what puts rule_id on the order.

const RULES = require('../lib/userrules');

// Move the selection's price and evaluate the rules watching it. The same call
// lib/drift.js makes on every price move, so the tests exercise the real
// trigger path rather than calling into the engine's internals.
function stepPrice(db, selectionId, price) {
  db.prepare('UPDATE selections SET fair_price = ? WHERE id = ?').run(price, selectionId);
  return RULES.evaluateSelection(db, selectionId, price);
}

// S3 ─ bot vs bot, same user: BLOCKED.
// The far larger hole. Two automated orders of one user matching each other
// would let a player manufacture volume out of nothing but their own rule set,
// which is exactly what the guard exists to stop, and it would be invisible:
// each order looks like it found a counterparty.
check('S3 the exception is EXCLUSIVE: two automated orders of one user stay blocked', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');

  // Alice gets TWO rules on the same runner, on opposite sides of 2.00. When the
  // price rises her lay rule fires and RESTS; when it falls her back rule fires
  // and TAKES it. Both orders are automated and both are Alice's.
  const layRule = RULES.createRule(db, users.alice, {
    selection_id: mkt.selection_id, op: 'above', threshold: 2.0, side: 'lay', stake_cents: 1000,
  });
  const backRule = RULES.createRule(db, users.alice, {
    selection_id: mkt.selection_id, op: 'below', threshold: 2.0, side: 'back', stake_cents: 1000,
  });

  const up = stepPrice(db, mkt.selection_id, 2.02);
  assert.strictEqual(up.placed, 1, 'the lay rule fired and rested an order');
  const resting = db.prepare('SELECT * FROM orders WHERE rule_id = ?').get(layRule.id);
  assert.ok(resting, 'the resting order is attributed to its rule');
  assert.strictEqual(resting.matched_cents, 0, 'nothing to take yet — the book is empty');

  // Now the back rule fires AS THE TAKER, at the resting lay's price. Both sides
  // automated, same user: this must NOT match.
  const down = stepPrice(db, mkt.selection_id, 1.98);
  assert.strictEqual(down.placed, 1, 'the back rule fired');
  const taker = db.prepare('SELECT * FROM orders WHERE rule_id = ?').get(backRule.id);
  assert.ok(taker && taker.rule_id !== null, 'the TAKER is automated — this is the case #75 could not reach');

  assert.strictEqual(taker.matched_cents, 0, "two automated orders of one user MATCHED — the guard is inclusive");
  assert.strictEqual(resting.matched_cents, 0, 'and the resting order was filled');
  assert.strictEqual(matchesFor(db, taker.id).length, 0, 'a match row was written anyway');
  assert.strictEqual(matchesFor(db, resting.id).length, 0);
  // And no P&L was manufactured. The reason the guard exists: a user trading
  // against themselves can settle a position no counterparty ever produced. A
  // blocked crossing must leave nothing to settle — no match row means no
  // exposure, and this asserts it at the table a win would actually be paid from.
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) c FROM settlements WHERE user_id = ?').get(users.alice.id).c,
    0,
    'a settlement exists for a crossing that never happened'
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) c FROM price_history WHERE selection_id = ?').get(mkt.selection_id).c,
    0,
    'and the trade tape recorded a fill — the blocking is total, not partial'
  );
});

// S5 ─ bot as TAKER, manual as resting: PERMITTED. The mirror of S1.
check('S5 the exception applies whichever side is automated — the bot is the TAKER', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');

  // Alice's own MANUAL back rests, waiting to be taken.
  M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'back', price: 2.0, stake_cents: 1000 });

  // Her rule lays once the price rises above 2.00, so the rule's order is the
  // TAKER this time — the direction S1 does not cover.
  const rule = RULES.createRule(db, users.alice, {
    selection_id: mkt.selection_id, op: 'above', threshold: 2.0, side: 'lay', stake_cents: 1000,
  });
  const up = stepPrice(db, mkt.selection_id, 2.02);
  assert.strictEqual(up.placed, 1, 'the rule fired');

  const taker = db.prepare('SELECT * FROM orders WHERE rule_id = ?').get(rule.id);
  assert.strictEqual(taker.matched_cents, 1000, 'the automated TAKER did not cross the same user\'s manual order');
  assert.strictEqual(taker.status, 'fully_matched');
  const ms = matchesFor(db, taker.id);
  assert.strictEqual(ms.length, 1);
  assert.strictEqual(ms[0].self_crossed, 1, 'the crossing is recorded in the mirror direction too');

  // Symmetry is a property of the CODE, so assert the same rule against the same
  // shape going the other way as well: a rule that BACKS takes a manual LAY.
  const { db: db2, users: u2 } = await fresh();
  const m2 = mkMarket(db2, 'Away');
  M.placeOrder(db2, u2.alice, { selection_id: m2.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });
  const backRule = RULES.createRule(db2, u2.alice, {
    selection_id: m2.selection_id, op: 'below', threshold: 2.0, side: 'back', stake_cents: 1000,
  });
  const down = stepPrice(db2, m2.selection_id, 1.98);
  assert.strictEqual(down.placed, 1);
  const backTaker = db2.prepare('SELECT * FROM orders WHERE rule_id = ?').get(backRule.id);
  assert.strictEqual(backTaker.matched_cents, 1000, 'the mirror direction does not work either');
  assert.strictEqual(matchesFor(db2, backTaker.id)[0].self_crossed, 1);

  // The marker still bridges ONE user only. A third party's order crosses a
  // same-user pair normally and is NOT marked self-crossed.
  const { db: db3, users: u3 } = await fresh();
  const m3 = mkMarket(db3, 'Draw');
  const bobBack = M.placeOrder(db3, u3.bob, { selection_id: m3.selection_id, side: 'back', price: 2.0, stake_cents: 1000 }).order;
  markAutomated(db3, bobBack.id);
  const alice = M.placeOrder(db3, u3.alice, { selection_id: m3.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });
  assert.strictEqual(alice.fills.length, 1, 'an ordinary crossing must still work');
  assert.strictEqual(matchesFor(db3, bobBack.id)[0].self_crossed, 0,
    'a fill against a DIFFERENT user was marked self-crossed');
});

// ── S6b ─ the audit record ───────────────────────────────────────────────────
check('S7 a self-crossed fill is in the audit log, naming the rule that caused it', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');

  const bot = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'back', price: 2.0, stake_cents: 1000 }).order;
  markAutomated(db, bot.id, 4242);
  M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });

  const rows = db.prepare("SELECT * FROM audit_log WHERE action = 'trade.self_crossed'").all();
  assert.strictEqual(rows.length, 1, `expected exactly one audit row, got ${rows.length}`);
  assert.strictEqual(rows[0].actor_id, users.alice.id, 'the actor is not the player whose liquidity crossed');
  const after = JSON.parse(rows[0].after || '{}');
  assert.strictEqual(after.rule_id, 4242,
    'the audit row does not name the rule — after that rule is deleted the fill is untraceable');
  assert.strictEqual(after.resting_order_id, bot.id);
});

check('S8 an ORDINARY crossing writes NO self_crossed audit row', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');
  M.placeOrder(db, users.bob, { selection_id: mkt.selection_id, side: 'back', price: 2.0, stake_cents: 1000 });
  M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });
  const n = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'trade.self_crossed'").get().c;
  assert.strictEqual(n, 0, 'an ordinary fill was audited as self-crossed — the log becomes useless');
});

// ── S6 ─ the marker is the whole decision ────────────────────────────────────
check('S6 clearing rule_id restores the original guard exactly', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');

  const bot = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'back', price: 2.0, stake_cents: 1000 }).order;
  markAutomated(db, bot.id);
  const manual = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });
  assert.strictEqual(manual.fills.length, 1, 'S1 must have worked first — this check is meaningless otherwise');

  // A SECOND market, same users, but the resting order is no longer automated.
  const mkt2 = mkMarket(db, 'Away');
  const plain = M.placeOrder(db, users.alice, { selection_id: mkt2.selection_id, side: 'back', price: 2.0, stake_cents: 1000 }).order;
  assert.strictEqual(orderRow(db, plain.id).rule_id, null, 'rule_id must default to NULL = manual');
  const blocked = M.placeOrder(db, users.alice, { selection_id: mkt2.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });
  assert.strictEqual(blocked.fills.length, 0, 'an order with rule_id NULL must be blocked exactly as before');
});

(async () => {
  for (const [name, fn] of failures) {
    try {
      await fn();
      passed++;
      console.log('  ok  ', name);
    } catch (e) {
      console.log(`  FAIL ${name}\n         ${e && e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\nselfcross.test.js: ${passed} of ${failures.length} checks passed`);
  if (passed < failures.length) process.exit(1);
})();