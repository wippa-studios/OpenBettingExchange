// cashout.test.js — cash-out contract under the BUYOUT model.
// Run: node tests/cashout.test.js   (plain assert, no deps)
//
// This file used to cover the v1 MARKET-HEDGE model, where a position was
// closed by placing the opposite side at top of book. That model is gone, and
// lib/cashout.js derives why: hedging N runners against a fair book is
// provably value-destroying (the best achievable net is negative for any
// price dispersion), so "generalise the v1 hedge" was a dead end and the
// `v1 scope` guard was a correct refusal rather than unfinished work.
//
// The venue now QUOTES the buyout from its own fair probabilities. The
// valuation maths and the multi-runner behaviour are in cashout2.test.js;
// what remains here is the contract around it — what is refused, what is
// atomic, and what a quote must never do.
process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const C = require('../lib/cashout');
const settle = require('../lib/settle');
const config = require('../lib/config');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

let evCounter = 0;
async function fresh() {
  // ensureBot() is synchronous (it runs inside transactions in lib/settle.js and
  // lib/cashoutrisk.js) and so cannot derive the house password hash itself.
  // This venue is hand-built rather than seeded, so prime it explicitly.
  await require('../lib/bots').primeBotHash();
  const db = openStore(':memory:');
  const mk = async (name) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: 100000 });
  return { db, users: { alice: (await mk('alice')), bob: (await mk('bob')), carol: (await mk('carol')), dave: (await mk('dave')) } };
}

function mkMarket(db, selections) {
  let sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  if (!sport) {
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
    sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  }
  evCounter++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now', '+2 hours'))").run(sport.id, `Test Event ${evCounter}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Test Event ${evCounter}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id = ? ORDER BY id DESC').get(ev.id);
  const ids = [];
  for (const [name, fair] of selections) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(mkt.id, name, fair);
    ids.push(db.prepare('SELECT id FROM selections WHERE market_id = ? AND name = ?').get(mkt.id, name).id);
  }
  return { market_id: mkt.id, s1: ids[0], s2: ids[1] };
}

const balances = (db, id) => {
  const r = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(id);
  return { b: r.b, f: r.f };
};

// A matched two-runner position where the player is in the money, so a quote
// exists. Alice backs Alpha at 2.5 against a fair 2.0.
function inTheMoney(db, users) {
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.0]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.5, stake_cents: 10000 });
  return market_id;
}

// C1: a quote is a QUOTE. It must not move money, place orders, or change a
// single balance. A "peek" that executed would be catastrophic on a UI that
// re-quotes on every render.
check('C1 quoting does not execute', async () => {
  const { db, users } = (await fresh());
  const market_id = inTheMoney(db, users);
  const before = balances(db, users.alice.id);
  const ordersBefore = db.prepare('SELECT COUNT(*) c FROM orders').get().c;

  const q = C.cashoutQuote(db, users.alice, market_id);
  assert.ok(q, 'a quote exists');
  assert.ok(q.value_cents > 0);
  assert.deepStrictEqual(balances(db, users.alice.id), before, 'no money moved');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders').get().c, ordersBefore, 'no orders placed');
});

// C2: no position, no quote and a refused execution.
check('C2 no position is refused', async () => {
  const { db, users } = (await fresh());
  const market_id = inTheMoney(db, users);
  assert.strictEqual(C.cashoutQuote(db, users.carol, market_id), null, 'carol holds nothing');
  assert.throws(() => C.cashoutMarket(db, users.carol, market_id), /unavailable/);
  assert.deepStrictEqual(balances(db, users.carol.id), { b: 100000, f: 0 });
});

// C3: a SETTLED market cannot be cashed out — the position is already gone,
// and paying again would be a double-settlement.
check('C3 a settled market is refused', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.0]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.5, stake_cents: 10000 });
  settle.settleMarket(db, market_id, { winner_selection_id: s1 });
  const after = balances(db, users.alice.id);
  assert.strictEqual(C.cashoutQuote(db, users.alice, market_id), null);
  assert.throws(() => C.cashoutMarket(db, users.alice, market_id), /unavailable/);
  assert.deepStrictEqual(balances(db, users.alice.id), after, 'nothing moved');
});

// C4: atomicity. A refused buyout must leave the position intact and every
// balance exactly where it was — the player must still be able to try again
// once whatever blocked it is resolved.
check('C4 a refused buyout is atomic and leaves the position intact', async () => {
  const { db, users } = (await fresh());
  const market_id = inTheMoney(db, users);
  const before = balances(db, users.alice.id);
  assert.throws(() => C.cashoutMarket(db, users.carol, market_id), /unavailable/);

  assert.deepStrictEqual(balances(db, users.alice.id), before, 'the other player is untouched');
  assert.strictEqual(M.myMatchedBets(db, users.alice.id, market_id).length, 1, 'position survives');
  // And Alice can still cash out afterwards.
  assert.ok(C.cashoutMarket(db, users.alice, market_id).value_cents > 0);
});

// C5: CASHING OUT IS SWITCHABLE. An operator who does not want to offer it
// must be able to turn it off without a code change.
check('C5 cash-out can be disabled', async () => {
  const { db, users } = (await fresh());
  const market_id = inTheMoney(db, users);
  assert.ok(C.cashoutQuote(db, users.alice, market_id), 'enabled by default');

  const prev = config.CASHOUT_ENABLED;
  config.CASHOUT_ENABLED = false;
  try {
    assert.strictEqual(C.cashoutQuote(db, users.alice, market_id), null, 'no quote when disabled');
  } finally {
    config.CASHOUT_ENABLED = prev;
  }
  assert.ok(C.cashoutQuote(db, users.alice, market_id), 'and it comes back');
});

// C6: MIXED positions are now SUPPORTED, not refused. The v1 suite asserted
// this was refused; that assertion is the thing this change reverses, so it
// is pinned explicitly rather than quietly dropped.
check('C6 a mixed back/lay position across runners is now supported', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.0]]);
  // Mixed sides across runners, and deliberately PRICED so the position is
  // worth something: back Alpha at 2.5 (favourable against fair 2.0) and lay
  // Beta at 1.5 (unfavourable). Payouts +10000 / 0 -> mean +5000.
  // (A perfectly hedged mixed position values ZERO and is correctly refused;
  // that is C1 of cashout2.test.js.)
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, users.alice, { selection_id: s2, side: 'lay', price: 1.5, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s2, side: 'back', price: 1.5, stake_cents: 10000 });
  const plan = C.cashoutQuote(db, users.alice, market_id);
  assert.ok(plan, 'v1 refused this; the buyout model values it');
  assert.strictEqual(plan.selection_count, 2);
});

// C7: the house cannot cash itself out. The venue quoting to itself would be
// a self-dealing loop.
//
// THIS TEST USED TO PASS WITHOUT TOUCHING THE GUARD.
//
// It laid the bot at 3.5 against a fair 2.0, which is UNDERWATER: payouts
// -25000 / +10000, so priced = 0.5*(-25000) + 0.5*(10000) = -7500. lib/cashout.js
// fires `if (!(priced > 0)) return null` BEFORE `if (me.is_bot) return null`, so
// the null was produced by the pricing gate and the is_bot line was never
// executed. Delete that line outright and this check stayed green.
//
// The second problem was the first assertion, `plan === null || plan.mode ===
// 'buyout'`: every plan object carries mode 'buyout', so that expression is
// true for EVERY possible return value. It was decoration.
//
// A test asserting a guard fired must exclude every OTHER reason for the same
// outcome. Both exclusions are below.
// C8: `transferred_cents` and `frozen_release_cents` are the SAME figure, and
// that is a fact about the money rather than a naming coincidence — the
// collateral the player releases per leg is the escrow the house takes on per
// leg (#20).
//
// They were equal before this assertion existed too, so this does NOT prove the
// duplication is gone; tests/guard.test.js G13 does that, by counting the
// accumulations. What this pins is the DRIFT risk: if a future edit changes one
// of them, the response would report two figures that disagree, and a client
// reading the pair as independent quantities would be wrong.
//
// The independent figure — what the HOUSE actually holds afterwards — is read
// from the ledger rather than from the response, so this is not the response
// agreeing with itself.
check('C8 transferred_cents and frozen_release_cents are one figure, not two', async () => {
  const { db, users } = (await fresh());
  const bots = require('../lib/bots');
  await bots.primeBotHash();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.0]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.5, stake_cents: 10000 });

  const before = balances(db, users.alice.id);
  const r = C.cashoutMarket(db, users.alice, market_id);
  assert.ok(r.value_cents > 0, `a quote was paid out (${JSON.stringify(r)})`);
  assert.ok(r.frozen_release_cents > 0, 'collateral was released');

  assert.strictEqual(
    r.transferred_cents,
    r.frozen_release_cents,
    'the two documented figures are one number, not a pair that can drift apart'
  );

  // The figure is not arbitrary: it is what the player's escrow fell by.
  assert.strictEqual(
    r.frozen_release_cents,
    before.f - balances(db, users.alice.id).f,
    'and it equals the escrow actually released from the player'
  );
  // …and what the house took on, read from the house's own ledger rather than
  // from the response being checked.
  const house = bots.ensureBot(db);
  const houseEscrow = db.prepare('SELECT frozen_cents f FROM users WHERE id = ?').get(house.id).f;
  assert.strictEqual(
    r.transferred_cents,
    houseEscrow,
    'and it equals the escrow the house actually holds against the replacement matches'
  );
});

check('C7 the house account is not given a cash-out quote', async () => {
  const { db, users } = (await fresh());
  const bots = require('../lib/bots');
  await bots.primeBotHash(); // ensureBot() is synchronous and cannot hash for itself
  const bot = bots.ensureBot(db);
  const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.0]]);

  // Alice backs Alpha at 2.5 against a fair 2.0: PROFITABLE (payouts +15000 /
  // -10000 -> +2500). She is the control that the pricing gate is not simply
  // closed for this market.
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.5, stake_cents: 10000 });

  // The house LAYS Alpha at 1.5 against the same fair 2.0: also PROFITABLE
  // (payouts -5000 / +10000 -> +2500). Note the direction — it is the mirror of
  // Alice's trade and is profitable for exactly the opposite reason.
  M.placeOrder(db, bot, { selection_id: s1, side: 'lay', price: 1.5, stake_cents: 10000 });
  M.placeOrder(db, users.dave, { selection_id: s1, side: 'back', price: 1.5, stake_cents: 10000 });

  // EXCLUSION 1 — the human in the same market with a profitable position IS
  // quoted. Without this the null below could be the venue declining everyone.
  assert.ok(C.cashoutQuote(db, users.alice, market_id),
    'a profitable player IS quoted, so the gate below is what refuses the house');

  // EXCLUSION 2 — the HOUSE'S OWN position is worth money, so `priced <= 0`
  // cannot be the branch that produced its null. Computed with the module's own
  // exported helpers, so this states the fixture's premise rather than
  // restating the assertion under test.
  const houseBets = M.myMatchedBets(db, bot.id, market_id);
  assert.strictEqual(houseBets.length, 1, 'the house really does hold a position here');
  const probs = C.fairProbsFor(db, market_id);
  const houseFair = C.payoutsFor(houseBets, [s1, s2])
    .reduce((acc, p) => acc + probs.get(p.selection_id) * p.payout_cents, 0);
  assert.ok(houseFair > 0, `the house's own position is worth ${houseFair}, so the pricing gate cannot fire`);

  // Every other null path is now excluded: CASHOUT_ENABLED is on (C5), the
  // market is open and unheld, the house holds a position, every selection is
  // priced, and the quote clears MIN_STAKE_CENTS at fair 2500. `is_bot` is the
  // only remaining reason for a null — remove it and this assertion is red.
  assert.strictEqual(C.cashoutQuote(db, bot, market_id), null,
    'the house is refused by the is_bot guard specifically');
});

// #16: the "fundable NOW" check this function used to promise in a comment did
// not exist. availableOf() was never called, and the check as described could
// NOT have worked: a buyout payout posts `house_float -> player_funds`, so it
// never debits the bot's users.balance_cents. This pins the behaviour the model
// actually has — the quote is NOT gated on the house's balance — so that the
// claim cannot be reinstated by accident and so a future reader who adds such a
// gate sees exactly what it would do.
check('C9 the quote is not gated on any house balance', async () => {
  const { db, users } = (await fresh());
  const bots = require('../lib/bots');
  await bots.primeBotHash();
  const bot = bots.ensureBot(db);
  const market_id = inTheMoney(db, users);

  // The control: a quote exists at all on this position.
  const before = C.cashoutQuote(db, users.alice, market_id);
  assert.ok(before, 'the position is quotable');

  // Take the house to ZERO. It cannot fund a cent — not the payout, not the
  // legs — so any affordability test written against its balance refuses here.
  // The house also has no open liability in this fixture, so available is 0 and
  // not merely negative.
  db.prepare('UPDATE users SET balance_cents = 0, frozen_cents = 0 WHERE id = ?').run(bot.id);
  const broke = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(bot.id);
  assert.strictEqual(broke.b - broke.f, 0, 'the house has nothing available');

  const after = C.cashoutQuote(db, users.alice, market_id);
  assert.ok(after, 'a quote with a house that cannot fund ANY of it — there is no balance gate');
  assert.strictEqual(after.value_cents, before.value_cents, 'and it is the same quote');
  db.close();
});

// #16, the other half. The venue's ability to fund the LEGS it inherits is a
// real balance and IS enforced — but at execution, not at quote time, and
// atomically. This pins that, because "execution is currently safe by accident
// rather than by design" is the whole of what was wrong with the comment: an
// accident that is now a test.
check('C10 a house that cannot fund the legs refuses the buyout and writes nothing', async () => {
  const { db, users } = (await fresh());
  const bots = require('../lib/bots');
  await bots.primeBotHash();
  const bot = bots.ensureBot(db);
  const market_id = inTheMoney(db, users);

  const alice0 = balances(db, users.alice.id);
  const bob0 = balances(db, users.bob.id);
  const matches0 = db.prepare('SELECT COUNT(*) c FROM matches').get().c;
  const tx0 = db.prepare('SELECT COUNT(*) c FROM transactions').get().c;

  // The quote is offered — C9 shows why — and execution is where the house
  // fails. ledger.escrow refuses when available funds cannot cover the legs it
  // is inheriting.
  db.prepare('UPDATE users SET balance_cents = 0, frozen_cents = 0 WHERE id = ?').run(bot.id);
  assert.throws(
    () => C.cashoutMarket(db, users.alice, market_id),
    (e) => e.status === 400 && /Insufficient available balance/.test(e.message),
    'the buyout is refused rather than half-closed'
  );

  // ATOMIC. Nothing at all was written: the position is intact and tradeable,
  // no match was flagged, no settlement row exists, no money moved.
  assert.deepStrictEqual(balances(db, users.alice.id), alice0, 'the player is untouched');
  assert.deepStrictEqual(balances(db, users.bob.id), bob0, 'and so is the counterparty');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM matches').get().c, matches0, 'no takeover match was left behind');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, tx0, 'and no ledger row');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM settlements').get().c, 0, 'and no settlement');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM cashout_quotes').get().c, 0, 'and no executed-buyout record');
  // The quote is still there afterwards: the refusal rolled back, it did not
  // consume the position.
  assert.ok(C.cashoutQuote(db, users.alice, market_id), 'the position survives the refusal');
  db.close();
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
  if (passed < 10) { console.error("expected 10 checks"); process.exit(1); }
  console.log(`\ncashout.test.js: ${passed} checks passed`);
})();
