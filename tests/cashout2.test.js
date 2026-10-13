// cashout2.test.js — multi-runner cash-out (venue buyout model).
// Run: node tests/cashout2.test.js   (plain assert, no deps)
//
// v1 hedged against the BOOK and could not generalise past one selection —
// lib/cashout.js derives why: hedging N runners against a fair book is
// provably value-destroying, so the `v1 scope` guard was a correct refusal
// rather than an unfinished feature. The model here is the one exchanges
// actually use: the VENUE prices the position from its own fair probabilities
// and buys it.
//
// The properties that matter: the quote is derived from payouts that AGREE
// with lib/settle.js, and the buyout can never be settled twice.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';
process.env.CASHOUT_MARGIN_BPS = '200';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('./../lib/match');
const settle = require('../lib/settle');
const cashout = require('../lib/cashout');
const acc = require('../lib/accounts');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

let n = 0;
async function fixture(selections = [['Alpha', 2.0], ['Beta', 2.0]]) {
  // ensureBot() is synchronous (it runs inside transactions in lib/settle.js and
  // lib/cashoutrisk.js) and so cannot derive the house password hash itself.
  // This venue is hand-built rather than seeded, so prime it explicitly.
  await require('../lib/bots').primeBotHash();
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  n++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now','+2 hours'))").run(sport.id, `Ev ${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Ev ${n}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  const ids = {};
  for (const [nm, fair] of selections) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(mkt.id, nm, fair);
    ids[nm] = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, nm).id;
  }
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 1000000 }));
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 1000000 }));
  return { db, alice, bob, marketId: mkt.id, ids };
}

const wallet = (db, id) => db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id=?').get(id);

// C1: the quote is a VALUATION over outcomes, and it works for more than one
// selection — which is the whole point of the change.
check('C1 a multi-selection position is quotable', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture());
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 1.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 1.5, stake_cents: 10000 });
  M.placeOrder(db, alice, { selection_id: ids.Beta, side: 'back', price: 3.0, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Beta, side: 'lay', price: 3.0, stake_cents: 10000 });

  const plan = cashout.cashoutQuote(db, alice, marketId);
  assert.ok(plan, 'a plan exists');
  assert.strictEqual(plan.selection_count, 2, 'covers BOTH selections');
  assert.strictEqual(plan.mode, 'buyout');
  assert.strictEqual(plan.legs, 2);
  assert.ok(plan.value_cents > 0, 'position is worth something');
  // Alice backed Alpha at 1.5 (fair 2.0) and Beta at 3.0 (fair 2.0): one
  // leg ahead of fair, one behind. 50/50 fair prices.
  // Payout if Alpha wins: +5000 (A) -10000 (B) = -5000
  // Payout if Beta  wins: -10000 (A) +20000 (B) = +10000
  // Fair value = 0.5*(-5000) + 0.5*(10000) = 2500
  assert.strictEqual(plan.fair_value_cents, 2500, 'hand-computed fair value');
  assert.strictEqual(plan.value_cents, Math.floor(2500 * 0.98), 'quoted at 2% margin');
});

// C2: OVERROUND IS REMOVED. A book summing to more than 100% must not pay the
// player the difference — that would be a free 5% handed out by a pricing bug.
check('C2 an overround book does not pay out the overround', async () => {
  // Two selections both at 1.9 -> implied probs sum to 1/1.9*2 = 1.0526.
  const { db, alice, bob, marketId, ids } = (await fixture([['Alpha', 1.9], ['Beta', 1.9]]));
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 1.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 1.5, stake_cents: 10000 });
  const plan = cashout.cashoutQuote(db, alice, marketId);
  // Payout Alpha wins = +5000; Beta wins = -10000. Normalised probs are
  // 0.5/0.5, so fair value = 0.5*5000 + 0.5*(-10000) = -2500 -> underwater,
  // and an underwater position is refused rather than bought out at a loss.
  assert.strictEqual(plan, null, 'underwater position gets no quote');
});

// C3: an underwater position is refused. Paying a player to take on risk they
// did not want is how a venue hands out free money.
check('C3 an underwater position is not bought out', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture());
  // Fair is 2.0, so backing at 1.2 buys a selection WORTH 2.0 at 1.2 — that is
  // backwards. (Backing at 3.0 would be the opposite: paying 3.0 for something
  // worth 2.0, which is in the money and correctly quotable.)
  // Payout Alpha wins = +(1.2-1)*10000 = +2000; Beta wins = -10000
  // fair = 0.5*2000 + 0.5*(-10000) = -4000 -> underwater.
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 1.2, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 1.2, stake_cents: 10000 });
  assert.strictEqual(cashout.cashoutQuote(db, alice, marketId), null);
  assert.throws(() => cashout.cashoutMarket(db, alice, marketId), /unavailable/);
  assert.strictEqual(acc.assertConserved(db), 0);
});

// C4: an unpriced selection makes the valuation untrustworthy, so no quote.
// Treating an unpriceable runner as "certain not to win" would produce a
// payout that ignores a real outcome.
check('C4 an unpriced selection suppresses the quote', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture());
  db.prepare('UPDATE selections SET fair_price = NULL WHERE id = ?').run(ids.Beta);
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 1.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 1.5, stake_cents: 10000 });
  assert.strictEqual(cashout.cashoutQuote(db, alice, marketId), null, 'declines rather than guessing');
});

// C5: THE VALUATION MUST AGREE WITH SETTLEMENT. payoutsFor() is a second
// implementation of the settlement arithmetic; a one-cent disagreement would
// mean the quoted cash-out differs from the settlement the player was
// avoiding — exactly the drift an exchange cannot afford.
check('C5 quoted payouts match what settlement would actually pay', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture());
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 1.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 1.5, stake_cents: 10000 });

  const bets = M.myMatchedBets(db, alice.id, marketId);
  const payouts = cashout.payoutsFor(bets, [ids.Alpha, ids.Beta]);

  for (const selName of ['Alpha', 'Beta']) {
    const selId = ids[selName];
    const quote = payouts.find((p) => p.selection_id === selId).payout_cents;
    // Settle a FRESH identical market and read the real settlement P&L.
    const f2 = (await fixture());
    M.placeOrder(f2.db, f2.alice, { selection_id: f2.ids.Alpha, side: 'back', price: 1.5, stake_cents: 10000 });
    M.placeOrder(f2.db, f2.bob, { selection_id: f2.ids.Alpha, side: 'lay', price: 1.5, stake_cents: 10000 });
    settle.settleMarket(f2.db, f2.marketId, { winner_selection_id: selId });
    const real = f2.db.prepare("SELECT pnl_cents p FROM settlements WHERE user_id=?").get(f2.alice.id).p;
    assert.strictEqual(quote, real, `${selName} payout agrees with settlement`);
  }
});

// C6: the buyout releases the player's collateral and pays the quote. The
// stake comes back — a cash-out sells the POSITION, it does not confiscate it.
check('C6 executing a buyout returns the stake AND pays the quote', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture());
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 2.5, stake_cents: 10000 });
  const plan = cashout.cashoutQuote(db, alice, marketId);
  const before = wallet(db, alice.id);
  assert.strictEqual(before.f, 10000, 'collateral is frozen before');

  const res = cashout.cashoutMarket(db, alice, marketId);
  const after = wallet(db, alice.id);
  assert.strictEqual(res.value_cents, plan.value_cents, 'paid what was quoted');
  assert.strictEqual(after.f, 0, 'collateral released');
  assert.strictEqual(after.b, before.b + plan.value_cents, 'balance up by exactly the quote');
  assert.strictEqual(acc.assertConserved(db), 0, 'books still balance');
  assert.deepStrictEqual(acc.assertUserAgrees(db), []);
});

// C7: THE ONE THAT MATTERS MOST. A settled market must NOT pay the position a
// second time. Skipping the cashout marker is a double-settlement, which is
// not a rounding error.
check('C7 a cashed-out position is NOT settled again', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture());
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 2.5, stake_cents: 10000 });
  const plan = cashout.cashoutQuote(db, alice, marketId);
  cashout.cashoutMarket(db, alice, marketId);
  const afterBuyout = wallet(db, alice.id);

  // Now settle the market anyway, as a results feed would.
  settle.settleMarket(db, marketId, { winner_selection_id: ids.Alpha });
  const afterSettle = wallet(db, alice.id);
  assert.strictEqual(afterSettle.b, afterBuyout.b, 'Alice is NOT paid twice');
  assert.strictEqual(afterSettle.f, 0);
  assert.strictEqual(acc.assertConserved(db), 0);
  void plan;
});

// C8: the counterparty still settles normally. Cashing out one side must not
// rob the other side of the match — they are owed the pot either way.
check('C8 the counterparty is unaffected by the player cashing out', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture());
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 2.5, stake_cents: 10000 });
  const bobBefore = wallet(db, bob.id);
  cashout.cashoutMarket(db, alice, marketId);
  const bobAfterBuyout = wallet(db, bob.id);
  assert.strictEqual(bobAfterBuyout.f, bobBefore.f, 'his collateral is untouched');

  settle.settleMarket(db, marketId, { winner_selection_id: ids.Alpha });
  const bobFinal = wallet(db, bob.id);
  assert.strictEqual(bobFinal.f, 0, 'and he is settled normally: collateral released');
  assert.ok(bobFinal.b < bobAfterBuyout.b, 'and pays out, since his lay lost');
  assert.strictEqual(acc.assertConserved(db), 0);
});

// C9: resting orders in the market are cancelled so they cannot be matched
// into a position the player no longer holds.
check('C9 resting orders in the market are cancelled by the buyout', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture([['Alpha', 2.0], ['Beta', 2.0], ['Gamma', 2.0]]));
  // Three runners at fair 2.0 means each is worth 1/3. Backing at 2.5 would be
  // UNDERWATER here (EV = 1/3*1.5s - 2/3*s < 0), so this prices at 3.5:
  // payouts +75000 / -30000 / -30000 -> mean +5000.
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 3.5, stake_cents: 30000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 3.5, stake_cents: 30000 });
  M.placeOrder(db, alice, { selection_id: ids.Gamma, side: 'back', price: 3.5, stake_cents: 5000 });
  assert.strictEqual(M.openOrdersFor(db, alice.id).length, 1, 'a resting order exists');

  cashout.cashoutMarket(db, alice, marketId);
  assert.strictEqual(M.openOrdersFor(db, alice.id).length, 0, 'cancelled');
  assert.strictEqual(wallet(db, alice.id).f, 0, 'and its escrow released');
  assert.strictEqual(acc.assertConserved(db), 0);
});

// C10: the books stay whole through the whole flow, including a void after a
// buyout (the case where a double-payment is most likely).
check('C10 books balance through buyout then void', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture());
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 2.5, stake_cents: 10000 });
  cashout.cashoutMarket(db, alice, marketId);
  assert.strictEqual(acc.assertConserved(db), 0);
  settle.settleMarket(db, marketId, { void: true });
  assert.strictEqual(acc.assertConserved(db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(db), []);
  // A void refunds Bob fully — he was never cashed out.
  assert.strictEqual(wallet(db, bob.id).f, 0);
});

// C11: cashing out twice is refused, not double-paid.
check('C11 a second cash-out of the same position is refused', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture());
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 2.5, stake_cents: 10000 });
  cashout.cashoutMarket(db, alice, marketId);
  const after = wallet(db, alice.id);
  assert.throws(() => cashout.cashoutMarket(db, alice, marketId), /unavailable/);
  assert.deepStrictEqual(wallet(db, alice.id), after, 'nothing moved');
  assert.strictEqual(acc.assertConserved(db), 0);
});

// C12: a player with no position gets no quote, and neither does the house.
//
// The house half of this check was literally `void config;` — a placeholder
// where the assertion should have been, so "neither does the house" was a claim
// the file made about itself and never tested. The same failure mode as C7 in
// cashout.test.js: to assert that a guard fired, every OTHER reason for the same
// outcome has to be excluded, or the assertion is satisfied by whichever branch
// happens to run first.
check('C12 no position, or the house, gets no quote', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture());
  // Alice backs Alpha at 2.5 against a fair 2.0 -> PROFITABLE (+15000 /
  // -10000 -> +2500). She is the control.
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 2.5, stake_cents: 10000 });
  const carol = (await A.registerUser(db, { username: 'carol', password: 'pw-carol-123', balance_cents: 100000 }));
  assert.strictEqual(cashout.cashoutQuote(db, carol, marketId), null, 'no position');

  // The house LAYS Alpha at 1.5 against the same fair 2.0 -> also PROFITABLE
  // (-5000 / +10000 -> +2500). Its 1.5 lay does not sweep Alice's resting 2.5
  // back (a lay takes backs at P <= Q), so the two positions coexist.
  const bot = require('../lib/bots').ensureBot(db);
  M.placeOrder(db, bot, { selection_id: ids.Alpha, side: 'lay', price: 1.5, stake_cents: 10000 });
  M.placeOrder(db, carol, { selection_id: ids.Alpha, side: 'back', price: 1.5, stake_cents: 10000 });

  // EXCLUSION 1 — a profitable player in this market IS quoted.
  assert.ok(cashout.cashoutQuote(db, alice, marketId),
    'a profitable player IS quoted, so the refusal below is not a blanket decline');

  // EXCLUSION 2 — the HOUSE'S OWN position is worth money, so the pricing gate
  // (`if (!(priced > 0)) return null`, which runs BEFORE the is_bot gate)
  // cannot be what refused it.
  const houseBets = M.myMatchedBets(db, bot.id, marketId);
  assert.strictEqual(houseBets.length, 1, 'the house really does hold a position here');
  const probs = cashout.fairProbsFor(db, marketId);
  const houseFair = cashout.payoutsFor(houseBets, [ids.Alpha, ids.Beta])
    .reduce((acc, p) => acc + probs.get(p.selection_id) * p.payout_cents, 0);
  assert.ok(houseFair > 0, `the house's own position is worth ${houseFair}, so the pricing gate cannot fire`);

  assert.strictEqual(cashout.cashoutQuote(db, bot, marketId), null,
    'the house is refused by the is_bot guard specifically');
});

// C13: THE LAY SIDE OF THE SAME FLOW. C8 cashes out the BACK player, and for
// months that was the only branch tested — which masked a one-token bug found
// by the second outside review: the replacement match paired the house with
// the PLAYER'S OWN dead order and dropped the counterparty entirely, so a
// lay-side cash-out stranded the backer's escrow against a dead match and the
// market's settlement then failed outright ("releasing more than frozen") —
// a bricked market, no repair path, on the second-most-natural trade on the
// board. This test mirrors C8 with the sides swapped, and asserts settlement
// completes with the counterparty paid EXACTLY.
check('C13 the LAY side cashes out and the BACK counterparty is preserved exactly', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture());
  // Bob LAYS a profitable price (1.5), so his position is quotable: laying at
  // 2.5 in a 2.0/2.0 book is value-destroying and correctly gets no quote.
  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 1.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 1.5, stake_cents: 10000 });

  const r = cashout.cashoutMarket(db, bob, marketId);
  assert.ok(r.payout_cents > 0, 'bob is bought out of his profitable lay');
  assert.strictEqual(wallet(db, alice.id).f, 10000, 'alice collateral is still held');
  // The counterparty must STILL BE IN A LIVE MATCH: the replacement pairs the
  // house with HER back order, not with bob's dead lay. This was the bug —
  // the back slot held the player's own order id.
  const live = db
    .prepare(
      `SELECT bo.user_id AS back_user, lo.user_id AS lay_user
         FROM matches mt JOIN orders bo ON bo.id = mt.back_order_id
         JOIN orders lo ON lo.id = mt.lay_order_id
        WHERE mt.market_id = ? AND mt.cashout = 0`
    )
    .all(marketId);
  assert.strictEqual(live.length, 1, 'exactly one live replacement match');
  assert.strictEqual(live[0].back_user, alice.id, 'alice is in it, as the back');
  assert.notStrictEqual(live[0].lay_user, bob.id, 'bob\'s dead order is NOT in it');

  // And the market must settle, paying alice her exact due. Before the fix
  // this threw "releasing more than frozen" and left the market un-settleable.
  settle.settleMarket(db, marketId, { winner_selection_id: ids.Alpha });
  const aliceFinal = wallet(db, alice.id);
  assert.strictEqual(aliceFinal.f, 0, 'her collateral is released');
  // Back 10000 @ 1.5 wins 5000; commission 2.5% of 5000 = 125. The fixture
  // funds 1000000, so her final balance is 1000000 + 5000 - 125.
  assert.strictEqual(aliceFinal.b, 1000000 + 5000 - 125, 'she is paid exactly');
  // Bob keeps his buyout and is NOT settled again.
  assert.strictEqual(wallet(db, bob.id).b, 1000000 + r.payout_cents, 'bob is not re-settled');
  assert.strictEqual(acc.assertConserved(db), 0, 'and the books still balance');
});

// ── #15: a SUSPENDED selection must decline the quote, not vanish from it ──
//
// The outcome universe was `WHERE status = 'open'` and the priceable set was
// also open-only. A selection that was not open therefore appeared in NEITHER:
// it produced no payout row, was never counted by the `unpriced` gate, and its
// probability mass was silently renormalised onto the remaining runners. The
// venue then quoted as though an outcome it cannot price did not exist.
//
// Reproduces the reviewer's numbers exactly: alice lays Gamma @1.5 (fair 2.0)
// in a 3-runner market, then Gamma is suspended. The quote RISES, because the
// outcome alice is exposed to is priced as impossible.
check('C14 a suspended selection the player holds DECLINES the quote', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture([
    ['Alpha', 2.0], ['Beta', 2.0], ['Gamma', 2.0],
  ]));

  // Alice LAYS Gamma (so she wins when Gamma loses) and backs Alpha.
  M.placeOrder(db, alice, { selection_id: ids.Gamma, side: 'lay', price: 1.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Gamma, side: 'back', price: 1.5, stake_cents: 10000 });

  // Control: with every runner open, the quote is offered. Without this the
  // check below would pass for the wrong reason (a venue that never quotes).
  const open = cashout.cashoutQuote(db, alice, marketId);
  assert.ok(open, 'with every runner open the position IS quotable');
  const openFair = open.fair_value_cents;

  // Now suspend the very runner Alice is exposed to.
  db.prepare("UPDATE selections SET status = 'suspended' WHERE id = ?").run(ids.Gamma);

  const suspended = cashout.cashoutQuote(db, alice, marketId);
  // The reviewer's measured figures: fair 5000 -> quoted 4900 with Gamma open;
  // 10000 -> 9800 with it suspended. Roughly DOUBLE, because the -5000
  // outcome was treated as impossible.
  if (suspended) {
    assert.ok(
      suspended.fair_value_cents > openFair * 1.5,
      `a suspended runner must not be priced as impossible (open ${openFair} vs suspended ${suspended.fair_value_cents})`
    );
  }
  assert.strictEqual(
    suspended,
    null,
    `the venue declines rather than quoting without an outcome it cannot price (it quoted ${JSON.stringify(suspended)})`
  );

  // The suspended runner is exactly the "unpriced" case the gate was written
  // for — restoring it makes the quote come back, so the decline is about the
  // status and not about something else being broken.
  db.prepare("UPDATE selections SET status = 'open' WHERE id = ?").run(ids.Gamma);
  assert.ok(cashout.cashoutQuote(db, alice, marketId), 'and it is quoted again once restored');
});

// ── #19: a fully cashed-out market must LEAVE the positions view ───────────
//
// myMatchedBets filters `mt.cashout = 0` and says why. The enclosing market
// list in positionsFor did not, so the market row was still produced while its
// legs came back empty — /api/positions listed a market with no legs and no
// quote after the player deliberately closed the position.
//
// The double cash-out itself was already prevented, but by a second query
// rather than by this one, so the protection was incidental.
check('C15 a fully cashed-out market drops out of the positions view', async () => {
  const { db, alice, bob, marketId, ids } = (await fixture());

  M.placeOrder(db, alice, { selection_id: ids.Alpha, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: ids.Alpha, side: 'lay', price: 2.5, stake_cents: 10000 });

  // Control: the position is visible BEFORE the cash-out.
  const before = M.positionsFor(db, alice.id);
  assert.ok(
    before.some((m) => m.market_id === marketId),
    'the open position is listed'
  );

  cashout.cashoutMarket(db, alice, marketId);

  const after = M.positionsFor(db, alice.id);
  const stillThere = after.find((m) => m.market_id === marketId);
  assert.strictEqual(
    stillThere,
    undefined,
    `the closed market is gone from the positions view (still listed as ${JSON.stringify(stillThere)})`
  );

  // The counterparty, whose position was NOT bought off, still has theirs.
  const bobSees = M.positionsFor(db, bob.id);
  assert.ok(
    bobSees.some((m) => m.market_id === marketId),
    "the counterparty's position is untouched"
  );
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
  if (passed < 15) { console.error("expected 15 checks"); process.exit(1); }
  console.log(`\ncashout2.test.js: ${passed} checks passed`);
})();
