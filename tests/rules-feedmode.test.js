// rules-feedmode.test.js — a player's rules, on a venue with the LICENSED FEED ON.
// Run: node tests/rules-feedmode.test.js   (plain assert, no deps, offline)
//
// ── WHAT THIS FILE IS, AND WHY IT EXISTS SEPARATELY ─────────────────────────
//
// `tests/userrules.test.js` is the suite for lib/userrules.js and it has always
// been green. It was green in the configuration where the feature does not work,
// because it called `evaluateSelection` DIRECTLY — bypassing the only thing that
// decided whether the feature ran at all. #87:
//
//   lib/userrules.js:316  evaluateSelection(db, selectionId, price)
//     ↑ the ONLY production caller in the repo was
//   lib/drift.js:59       userrules.evaluateSelection(db, sel.id, next)
//     ↑ which only RUNS when
//   server.js             DRIFT_ON = config.DRIFT_ENABLED && !config.FEED_ENABLED
//
// So: turn the feed on and user rules stop firing. No order is placed, nothing is
// thrown, nothing is logged, and the `user_rules` row still reads
// `status='live', armed=1` forever. The feature looks armed and does nothing —
// on the configuration a licensed venue actually runs, which is the one this
// suite pins.
//
// THAT IS A GATE, AND THE OLD SUITE HAD NO CONTROL FOR IT. This file is its
// control, and the control is the configuration itself: `FEED_ENABLED=true` here,
// `FEED_ENABLED=false` there, and F1 asserts that the drift gate really is shut
// in THIS process — so a rule firing below cannot be explained by drift.
//
// ── WHY IT IS ITS OWN FILE, AND WHY IT PINS ITS OWN ENV ─────────────────────
// lib/config.js is evaluated at import, so FEED_ENABLED cannot be flipped inside
// a process that has already loaded the server — the same constraint
// `tests/feed_nav.test.js` exists for. tests/run_all.js can hand a suite
// environment through SUITE_ENV, and `tests/feedbook.test.js` instead pins its
// own in the preamble; both are the same decision. This one pins its own, so the
// file is runnable on its own with a bare `node tests/rules-feedmode.test.js`
// and cannot be silently run in the wrong mode by a runner that forgot an entry.
//
// ── EVERY CASE ASSERTS ITS CONTROL BESIDE IT (STATE.md §5.6) ─────────────────
// The fourth time this pass found a green assertion that structurally could not
// see a defect, because it tested a KEY rather than a COMBINATION. Here the
// combination is "a rule" AND "a configuration in which the drift engine is
// deliberately not running", so:
//
//   F2  a real crossing fires the rule  ⟷  a manual order at the same price IS
//       filled by the house, so "the house did not take it" is not vacuous
//   F3  the same trade that does NOT cross the threshold places nothing
//   F4  no price event at all places nothing  — "not on a tick"
//   F6  self-exclusion still bites on this path, and the control is that the very
//       same trade with the account in good standing places an order
//
// A file that only proved "rules fire" would pass against a venue that placed an
// order on every trade, and against one that fired on a timer.
'use strict';

// ── THE CONFIGURATION UNDER TEST. Set BEFORE any require. ───────────────────
process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';
process.env.FAUCET_MAX_CENTS = '1000000';
process.env.DB_PATH = ':memory:';
// The desk is ON, because the venue's own liquidity on a materialised market IS
// the bots' ladder (lib/feedcat.js + the BOTS_ON hoist). A feed-mode venue whose
// only counterparty is a disabled desk would have no trades at all, and the checks
// below would be measuring an empty book.
process.env.BOT_ENABLED = 'true';
// LEFT DELIBERATELY ON. The point of F1 is that the drift engine is configured
// to run and is deliberately not started because the feed is on — so a rule firing
// later in this file cannot be attributed to it. Setting DRIFT_ENABLED=false
// instead would make the whole file prove nothing: the engine would be off for
// two independent reasons and the assertion could not tell them apart.
process.env.DRIFT_ENABLED = 'true';
process.env.FEED_ENABLED = 'true';
process.env.FEED_PROVIDER = 'postgres';
// Never dialled — nothing in this file touches the recorder. It satisfies
// lib/config.js's refusal to launch with FEED_ENABLED and no URL, which is the
// point: a venue that cannot boot with the feed half-configured is not a venue
// this test should be able to stand in for.
process.env.FEED_DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:59999/offline';

const assert = require('assert');
const config = require('../lib/config');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const L = require('../lib/limits');
const R = require('../lib/userrules');
const bots = require('../lib/bots');
const drift = require('../lib/drift');

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

let evCounter = 0;

/**
 * One market, ONE selection, at an exact ladder price, with the desk quoting.
 *
 * `bots.requoteSelection` around fair 2.00 is what produces the venue's own
 * book, and the numbers the checks below depend on are therefore fixed by
 * lib/bots.js's `quoteSpread` three ticks either side of fair, read off
 * lib/odds.js's ladder — which is not uniform, and pretending it was is how a
 * fixture ends up asserting a price the engine never produced:
 *
 *   lay levels   2.02, 2.04, 2.06     (the ladder above even money steps by 0.02)
 *   back levels  1.99, 1.98, 1.97     (below it, by 0.01)
 *
 * Which is why the trades asserted here are at 1.97 and 2.06 and not at the
 * price the order was sent with: `sweepAndFill` walks resting orders
 * `ORDER BY price ASC` for a lay taker and `price DESC` for a back taker, and
 * the RESTING side's price is the match price. Asserting a number the engine
 * actually produced is the whole discipline this repository keeps asking for.
 */
async function fresh({ balance_cents = 5_000_000 } = {}) {
  const db = openStore(':memory:');
  const mk = (name) => A.registerUser(db, { username: name, password: 'secret1', balance_cents });
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const users = { alice: await mk('alice'), bob: await mk('bob') };
  evCounter++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1, ?, datetime('now', '+2 hours'))")
    .run(`FeedMode ${evCounter}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`FeedMode ${evCounter}`);
  db.prepare('INSERT INTO markets (event_id, name) VALUES (?, ?)').run(ev.id, 'Match Odds');
  const market = db.prepare('SELECT id FROM markets WHERE event_id = ? ORDER BY id DESC').get(ev.id);
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Home', 2.00)").run(market.id);
  const sel = db.prepare('SELECT * FROM selections WHERE market_id = ? ORDER BY id DESC').get(market.id);
  return { db, users, sel, marketId: market.id };
}

/** The desk quoting this selection — the venue's own liquidity, on its own book. */
async function quote(db, sel) {
  await bots.primeBotHash();
  bots.requoteSelection(db, sel.id);
  const open = db
    .prepare("SELECT COUNT(*) c FROM orders o JOIN users u ON u.id = o.user_id WHERE u.is_bot = 1 AND o.selection_id = ? AND o.status = 'open'")
    .get(sel.id).c;
  assert.ok(open > 0, 'the house must really be quoting, or nothing below is measuring anything');
  return open;
}

const ruleRow = (db, id) => db.prepare('SELECT * FROM user_rules WHERE id = ?').get(id);
const orderOfRule = (db, id) => db.prepare('SELECT * FROM orders WHERE rule_id = ? ORDER BY id').get(id);
const matchesFor = (db, orderId) =>
  db.prepare('SELECT * FROM matches WHERE back_order_id = ? OR lay_order_id = ?').all(orderId, orderId);

(async () => {
  // ── F1 ────────────────────────────────────────────────────────────────────
  // THE CONTROL FOR THE WHOLE FILE. Without it, every check below could be
  // satisfied by the drift engine after all — which is exactly how
  // tests/userrules.test.js stayed green for a release while the feature was
  // dead in this configuration.
  await check('F1 the drift gate is SHUT in this process, and the engine still works', async () => {
    const srv = require('../server');
    await srv.ready;

    assert.strictEqual(config.FEED_ENABLED, true, 'fixture drift: this suite is only meaningful with the feed ON');
    assert.strictEqual(config.DRIFT_ENABLED, true, 'fixture drift: drift is configured ON, so the gate is the feed and not the flag');
    // Read from the COMPOSITION ROOT, not re-derived from config: a test that
    // recomputed `DRIFT_ENABLED && !FEED_ENABLED` would be reading its own
    // arithmetic and would pass against a gate that had been changed.
    assert.strictEqual(
      srv.engineSwitches.DRIFT_ON, false,
      'DRIFT_ON is true here, so a rule firing below would be explained by drift and would prove nothing'
    );

    // THE CONTROL'S OTHER HALF: the price walk is not broken, so what the rest
    // of this file rules out is the WALK RUNNING here, not the walk being
    // incapable of running at all. Proved by driving `drift.tick` directly and
    // watching the rule OBSERVE the new price.
    //
    // ON AN OBSERVATION, NOT ON A FIRE, and the reason is worth recording. The
    // walk is a random walk with a step size that changes across even money
    // (0.01 below it, 0.02 above) and a reflective floor at 1.02, so the return
    // time to any given level is unbounded: measured here, a `below 2.00` rule
    // fired on tick 1 on most runs and on tick 185 on one in twenty, and an
    // `above 2.00` rule failed to return at all within 20 ticks on two runs in
    // five. A 400-tick budget is a coin that eventually lands wrong, and a check
    // that fails intermittently trains people to re-run it — `tests/userrules.test.js`
    // V31 carries exactly that shape with a 400-tick budget, and it is left
    // alone rather than copied.
    //
    // `last_price_cents` is the right thing to assert: `evaluateSelection` writes
    // it on EVERY observation, armed or disarmed, so a change from the price the
    // rule was created at proves the walk reached the rules engine without
    // depending on where a coin landed. That the walk can also make a rule FIRE
    // is F2's job, driven deterministically by a real crossing.
    const { db, users, sel } = await fresh();
    await quote(db, sel);
    const rule = R.createRule(db, users.alice, {
      selection_id: sel.id, op: 'below', threshold: 2.0, side: 'back', stake_cents: 1000,
    });
    assert.strictEqual(ruleRow(db, rule.id).last_price_cents, 200, 'fixture drift: the rule is created observing the seed price');

    let ticks = 0;
    while (ruleRow(db, rule.id).last_price_cents === 200 && ticks < 20) {
      drift.tick(db, null);
      ticks++;
    }
    const observed = ruleRow(db, rule.id).last_price_cents;
    assert.notStrictEqual(observed, 200, `the price walk did not reach the rules engine in ${ticks} ticks`);
    assert.strictEqual(
      db.prepare('SELECT fair_price FROM selections WHERE id = ?').get(sel.id).fair_price,
      require('../lib/odds').centsToPrice(observed),
      'the rule observed a price the walk did not produce'
    );
  });

  // ── F2 ────────────────────────────────────────────────────────────────────
  // THE HEADLINE. A real crossing, on a venue where drift is not running, fires
  // the rule. Against the pre-fix code this placed nothing at all: `evaluateSelection`
  // had one production caller and it was inside the engine this suite has
  // switched off.
  await check('F2 with the feed ON, a REAL CROSSING fires the rule and the house does not fill it', async () => {
    const { db, users, sel } = await fresh();
    await quote(db, sel);

    const rule = R.createRule(db, users.alice, {
      selection_id: sel.id, op: 'below', threshold: 2.0, side: 'back', stake_cents: 1000,
    });
    assert.strictEqual(rule.armed, 1, 'fixture drift: 2.00 is not strictly below 2.00, so the rule is armed');

    // Alice lays into the desk's cheapest back. That is an ordinary hand-placed
    // order — the same call POST /api/orders makes — and the crossing it causes
    // is the venue's own price moving.
    const taker = M.placeOrder(db, users.alice, { selection_id: sel.id, side: 'lay', price: 1.98, stake_cents: 1000 });
    assert.strictEqual(taker.fills.length, 1, 'the desk should have been taken');
    assert.strictEqual(taker.fills[0].price, 1.97, 'the RESTING price is the match price, and 1.97 is the desk\'s cheapest back at fair 2.00');
    assert.strictEqual(sel_traded(db, sel.id), 1.97, 'the venue recorded what it traded at');

    const after = ruleRow(db, rule.id);
    assert.strictEqual(after.fire_count, 1, 'the crossing did not fire the rule');
    assert.strictEqual(after.armed, 0, 'one-shot per crossing: it must be disarmed');
    assert.strictEqual(after.last_price_cents, 197, 'the rule observed the traded price, in integer ladder cents');
    assert.strictEqual(after.refusal_count, 0, 'and nothing refused it');

    const order = orderOfRule(db, rule.id);
    assert.ok(order, 'no order was attributed to the rule');
    assert.strictEqual(order.user_id, users.alice.id);
    // PRICED BY THE THRESHOLD RULE, not by the observation: back at 2.00 is
    // max(1.94, 2.00). A rule that took the gap would be a materially different
    // bet from the one that was asked for (lib/userrules.js's orderPriceCents).
    assert.strictEqual(order.price, 2.00, 'the order must be placed at the threshold, not at the traded price');
    assert.strictEqual(order.stake_cents, 1000);
    // AND THE HOUSE DID NOT FILL IT (#67). Asserted with the desk demonstrably
    // quoting, and with the control below proving the desk is taking MANUAL
    // orders at the same price — otherwise "the house did not take it" would be
    // true of any venue including one where the house cannot trade at all.
    assert.strictEqual(order.matched_cents, 0, 'the house filled a rule order');
    assert.strictEqual(order.status, 'open');
    assert.strictEqual(matchesFor(db, order.id).length, 0, 'a match row was written for a crossing the guard blocked');
    assert.strictEqual(order.frozen_cents, 1000, 'the resting remainder is escrowed — so the checks above are not vacuous');

    // THE CONTROL, BESIDE IT: the desk IS trading. A manual back at 2.00 takes
    // the desk's highest lay on an identical venue, so the refusal above is the
    // no-house-participation rule and not an empty book.
    const ctl = await fresh();
    await quote(ctl.db, ctl.sel);
    const manual = M.placeOrder(ctl.db, ctl.users.alice, { selection_id: ctl.sel.id, side: 'back', price: 2.00, stake_cents: 1000 });
    assert.strictEqual(manual.fills.length, 1, 'the house must still take a MANUAL order, or this check is measuring a dead desk');
  });

  // ── F3 ────────────────────────────────────────────────────────────────────
  // THE CONTROL FOR F2, and the pair is the point. A real crossing on the same
  // venue, at a price that does NOT cross the threshold, must place nothing. If
  // the hook fired on "something traded" rather than on "the price crossed",
  // this check fails — and a hook that fires on any trade would be exactly the
  // defect #77's deferred continuous semantics would introduce.
  await check('F3 the control: a real crossing on the WRONG side of the threshold places nothing', async () => {
    const { db, users, sel } = await fresh();
    await quote(db, sel);

    const rule = R.createRule(db, users.alice, {
      selection_id: sel.id, op: 'below', threshold: 2.0, side: 'back', stake_cents: 1000,
    });
    // Alice backs into the desk's best lay. Same venue, same desk, a real
    // crossing — and 2.06 is not below 2.00.
    const taker = M.placeOrder(db, users.alice, { selection_id: sel.id, side: 'back', price: 2.00, stake_cents: 1000 });
    assert.strictEqual(taker.fills.length, 1, 'the trade did happen — the control is a real price movement, not a quiet book');
    assert.strictEqual(sel_traded(db, sel.id), 2.06, 'the desk\'s best lay is 2.06 and the resting price is the match price');

    const after = ruleRow(db, rule.id);
    assert.strictEqual(after.fire_count, 0, 'a trade on the wrong side of the threshold fired the rule');
    assert.strictEqual(after.status, 'live');
    assert.strictEqual(after.armed, 1, 'the rule must still be armed and waiting — it observed, and declined');
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders WHERE rule_id IS NOT NULL').get().c, 0, 'an order was placed anyway');
  });

  // ── F4 ────────────────────────────────────────────────────────────────────
  // "NOT ON A TICK", asserted rather than asserted-in-prose (V32's decision,
  // restated in the configuration the old suite never ran in). With the desk
  // quoting and no crossing, the venue's price has not moved — the ladder is
  // identical every time it is read — and a rule on it must sit still. A periodic
  // re-scan of armed rules would place orders on observations the venue never
  // made.
  await check('F4 with the feed ON and NO price event, the rule sits still — still live, still armed', async () => {
    const { db, users, sel } = await fresh();
    await quote(db, sel);
    const rule = R.createRule(db, users.alice, {
      selection_id: sel.id, op: 'below', threshold: 2.0, side: 'back', stake_cents: 1000,
    });

    // The desk requotes — which cancels and replaces its own ladder. That is the
    // most tempting place to hang a hook ("the book changed!"), and it is not a
    // price movement: the venue's price is identical before and after.
    bots.requoteSelection(db, sel.id);
    bots.requoteSelection(db, sel.id);

    const after = ruleRow(db, rule.id);
    assert.strictEqual(after.fire_count, 0, 'a rule fired with no price event');
    assert.strictEqual(after.status, 'live', 'waiting, not broken');
    assert.strictEqual(after.armed, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders WHERE rule_id IS NOT NULL').get().c, 0, 'no order, no order');
    assert.strictEqual(db.prepare('SELECT ltp FROM selections WHERE id = ?').get(sel.id).ltp, null, 'nothing traded');
  });

  // ── F5 ────────────────────────────────────────────────────────────────────
  // ATTRIBUTION END TO END (#81), and the re-entry guard.
  //
  // The rule fires, its order RESTS (the house may not fill it, #67), the desk's
  // ladder is withdrawn, and the player's OWN manual liquidity fills it — the
  // one crossing the engine permits an automated order to take. Every downstream
  // record has to name the rule, and `fire_count` has to be exactly 1 even
  // though that fill itself moved the traded price and came back through this
  // same hook.
  await check('F5 a filled rule order is attributable everywhere, and ONE price event fired it ONCE', async () => {
    const { db, users, sel } = await fresh();
    await quote(db, sel);
    const rule = R.createRule(db, users.alice, {
      selection_id: sel.id, op: 'below', threshold: 2.0, side: 'back', stake_cents: 1000,
    });

    M.placeOrder(db, users.alice, { selection_id: sel.id, side: 'lay', price: 1.98, stake_cents: 1000 });
    const order = orderOfRule(db, rule.id);
    assert.ok(order && order.status === 'open', 'the rule fired and its order rested');
    assert.strictEqual(order.matched_cents, 0, 'the house took it');

    // The desk withdraws, so the ONLY liquidity left is the player's own. This is
    // `bots.withdrawAll`, the real operator control, not a hand-written delete.
    const withdrawn = bots.withdrawAll(db, { actor: { id: users.alice.id }, reason: 'feedmode suite: clear the desk' });
    assert.ok(withdrawn.cancelled_orders > 0, 'the desk really did withdraw, or the fill below proves nothing');

    // Alice's own manual lay takes her rule's resting back: the #75 exception,
    // exactly one automated side, both hers.
    const taker = M.placeOrder(db, users.alice, { selection_id: sel.id, side: 'lay', price: 2.00, stake_cents: 1000 });
    assert.strictEqual(taker.fills.length, 1, "the same player's own manual liquidity did not fill her rule");

    const filled = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    assert.strictEqual(filled.matched_cents, 1000);
    assert.strictEqual(filled.status, 'fully_matched');
    assert.strictEqual(filled.rule_id, rule.id, 'the fill is attributable to its rule');

    const ms = matchesFor(db, order.id);
    assert.strictEqual(ms.length, 1, 'the crossing is on the tape');
    assert.strictEqual(ms[0].self_crossed, 1, 'a fill from the player\'s OWN liquidity is marked as such');

    const audited = db.prepare("SELECT * FROM audit_log WHERE action = 'trade.self_crossed' ORDER BY id DESC").get();
    assert.ok(audited, 'no self-crossed audit row — and "where did this fill come from" is then unanswerable');
    const after = JSON.parse(audited.after || '{}');
    assert.strictEqual(after.rule_id, rule.id, 'the audit row does not name the rule');

    assert.ok(
      db.prepare('SELECT COUNT(*) c FROM price_history WHERE selection_id = ?').get(sel.id).c >= 2,
      'the trade tape does not carry both prices'
    );
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) c FROM settlements WHERE user_id = ?').get(users.alice.id).c, 0,
      'a settlement exists for a market that has not finished'
    );

    // ── THE RE-ENTRY GUARD, ASSERTED RATHER THAN DESCRIBED ──────────────────
    // The fill above moved `selections.ltp` and therefore came back through the
    // very hook that fired the rule. A crossing whose own order retriggers it
    // would place a second order, and then a third, for one price event.
    assert.strictEqual(
      ruleRow(db, rule.id).fire_count, 1,
      'one price event evaluated the rule more than once — the order the crossing placed moved the price again'
    );
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) c FROM orders WHERE rule_id = ?').get(rule.id).c, 1,
      'the rule placed more than one order for one crossing'
    );
  });

  // ── F6 ────────────────────────────────────────────────────────────────────
  // THE NEW HOOK MUST NOT BE A WAY ROUND A GATE (#80). Every limit in
  // lib/limits.js is per USER and is enforced inside the same `placeOrder` a
  // click takes, so the trade-driven hook cannot weaken one — but "cannot" is a
  // claim, and this is the claim's control: the IDENTICAL crossing on an
  // identical venue, by an account in good standing, places an order; with the
  // account self-excluded, it places none and the rule is killed on the spot.
  await check('F6 self-exclusion still bites on the trade-driven hook, and the same trade without it places an order', async () => {
    // The crossing is made by BOB in both runs, and deliberately so. An excluded
    // account cannot place a hand order either, so letting ALICE cause the trade
    // would have measured nothing but `assertTradeable` refusing her click.
    //
    // The control, first and beside it: the crossing works.
    const okRun = await fresh();
    await quote(okRun.db, okRun.sel);
    const live = R.createRule(okRun.db, okRun.users.alice, {
      selection_id: okRun.sel.id, op: 'below', threshold: 2.0, side: 'back', stake_cents: 1000,
    });
    M.placeOrder(okRun.db, okRun.users.bob, { selection_id: okRun.sel.id, side: 'lay', price: 1.98, stake_cents: 1000 });
    assert.strictEqual(sel_traded(okRun.db, okRun.sel.id), 1.97, 'the control trade did not happen');
    assert.strictEqual(ruleRow(okRun.db, live.id).fire_count, 1, 'the control trade must place an order');

    // Now the same thing with the account excluded.
    const { db, users, sel } = await fresh();
    await quote(db, sel);
    const rule = R.createRule(db, users.alice, {
      selection_id: sel.id, op: 'below', threshold: 2.0, side: 'back', stake_cents: 1000,
    });
    L.exclude(db, { actor: { id: users.bob.id }, userId: users.alice.id, reason: 'feedmode suite' });

    const killed = ruleRow(db, rule.id);
    assert.strictEqual(killed.status, 'killed', 'self-exclusion must kill a live rule on the spot');
    assert.strictEqual(killed.killed_reason, 'self-excluded');

    M.placeOrder(db, users.bob, { selection_id: sel.id, side: 'lay', price: 1.98, stake_cents: 1000 });
    assert.strictEqual(sel_traded(db, sel.id), 1.97, 'the identical trade did not happen in the excluded run');
    assert.strictEqual(ruleRow(db, rule.id).fire_count, 0, 'a rule fired for a self-excluded account');
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders WHERE rule_id IS NOT NULL').get().c, 0, 'and placed something');
  });

  console.log(`\nrules-feedmode.test.js: ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    for (const [name, e] of failures) console.error(`       ${name}: ${e && e.message}`);
    process.exit(1);
  }
  if (passed !== 6) {
    console.error(`expected 6 checks, ran ${passed} — a check that cannot fail is worse than no check`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

/** What the venue last traded at for this selection, or null. */
function sel_traded(db, selectionId) {
  const row = db.prepare('SELECT ltp FROM selections WHERE id = ?').get(selectionId);
  return row ? row.ltp : null;
}