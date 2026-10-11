// ledger2.test.js — double-entry invariants (Phase 3).
// Run: node tests/ledger2.test.js   (plain assert, no deps)
//
// These are the properties that turn "we log money movements" into "we can
// prove to an auditor that players' funds are segregated and intact". They
// are asserted over REAL scenarios driven through the real engine, not by
// posting entries directly — a conservation test that posts its own balanced
// legs proves nothing about whether the ledger produces them.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const acc = require('../lib/accounts');
const L = require('../lib/ledger');
const M = require('../lib/match');
const settle = require('../lib/settle');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

let n = 0;
function fixture() {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  n++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now','+2 hours'))").run(sport.id, `Ev ${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Ev ${n}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  const sels = [];
  for (const nm of ['Alpha', 'Beta']) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, nm);
    sels.push(db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, nm).id);
  }
  const alice = A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 });
  const bob = A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 });
  return { db, alice, bob, marketId: mkt.id, s1: sels[0], s2: sels[1] };
}

const conserved = (db) => acc.assertConserved(db);
const agree = (db) => acc.assertUserAgrees(db);
const venueBal = (db, kind) => acc.balanceOf(db, acc.accountId(db, kind, null));

// D1: an opening balance is fully traceable to the external clearing account.
// Money did not appear from nowhere — it came from outside the venue.
check('D1 opening balance is sourced from gateway_clearing', () => {
  const { db, alice } = fixture();
  // Both fixture accounts are opened at 100000, so clearing is out by both.
  assert.strictEqual(venueBal(db, 'gateway_clearing'), -200000);
  assert.strictEqual(acc.userBalance(db, alice.id, 'player_funds'), 100000);
  assert.strictEqual(conserved(db), 0);
});

// D2: THE headline invariant. Total debits equal total credits — through a
// whole match and settlement, driven by the real engine.
check('D2 global conservation survives a full match and settlement', () => {
  const { db, alice, bob, marketId, s1 } = fixture();
  M.placeOrder(db, bob, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 20000 });
  M.placeOrder(db, alice, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 20000 });
  assert.strictEqual(conserved(db), 0, 'after matching');
  settle.settleMarket(db, marketId, { winner_selection_id: s1 });
  assert.strictEqual(conserved(db), 0, 'after settlement');
  assert.deepStrictEqual(agree(db), [], 'cache agrees with postings');
});

// D3: the cache is a cache, and the test says so. If these two ever drift,
// every number on screen is a lie even though the ledger is right.
check('D3 materialised balances always equal the postings', () => {
  const { db, alice, bob, marketId, s1 } = fixture();
  L.deposit(db, alice.id, 5000, 100000);
  L.escrow(db, alice.id, 1500, {});
  L.release(db, alice.id, 500, {});
  assert.deepStrictEqual(agree(db), []);
  // Round-trip: escrow, match, settle — the cache must still track exactly.
  M.placeOrder(db, bob, { selection_id: s1, side: 'back', price: 3.0, stake_cents: 10000 });
  M.placeOrder(db, alice, { selection_id: s1, side: 'lay', price: 3.0, stake_cents: 10000 });
  settle.settleMarket(db, marketId, { winner_selection_id: s1 });
  assert.deepStrictEqual(agree(db), []);
});

// D4: ESCROW IS A REAL ACCOUNT, not a memo. Money a player has committed is
// visible in a liability account, which is what segregation means.
check('D4 escrow is a real per-user liability account', () => {
  const { db, alice } = fixture();
  assert.strictEqual(acc.userBalance(db, alice.id, 'player_escrow'), 0);
  L.escrow(db, alice.id, 4000, {});
  assert.strictEqual(acc.userBalance(db, alice.id, 'player_escrow'), 4000);
  assert.strictEqual(db.prepare('SELECT frozen_cents f FROM users WHERE id=?').get(alice.id).f, 4000);
  L.release(db, alice.id, 4000, {});
  assert.strictEqual(acc.userBalance(db, alice.id, 'player_escrow'), 0);
  // Total is unchanged by the escrow/release round trip — it is a SPLIT.
  assert.strictEqual(acc.userBalance(db, alice.id, 'player_funds'), 100000);
  assert.strictEqual(conserved(db), 0);
});

// D5: operator revenue is a QUERY, not an inference. This is the thing
// single-entry could never give you.
check('D5 commission is queryable as revenue', () => {
  const { db, alice, bob, marketId, s1 } = fixture();
  // Bob backs 20000 @ 2.0 and wins: his net winnings are 20000, commission
  // 2.5% = 500.
  M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 20000 });
  M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 20000 });
  settle.settleMarket(db, marketId, { winner_selection_id: s1 });
  const revenue = venueBal(db, 'operator_commission');
  assert.ok(revenue > 0, 'venue earned commission');
  assert.strictEqual(revenue, acc.balanceOf(db, acc.accountId(db, 'operator_commission', null)));
  // And it matches the commission rows on the players' ledgers exactly.
  const fromTxs = db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM transactions WHERE type='commission'").get().s;
  assert.strictEqual(revenue, fromTxs, 'revenue account equals the commission charged');
  assert.strictEqual(conserved(db), 0);
});

// D6: players' money is SEGREGATED and provably so. The venue's own float is
// negative (it holds the pot) and the two together are zero.
check('D6 fund segregation is a query, not a promise', () => {
  const { db, alice, bob, marketId, s1 } = fixture();
  M.placeOrder(db, bob, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 20000 });
  M.placeOrder(db, alice, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 20000 });
  const seg = acc.segregation(db);
  assert.strictEqual(seg.net, 0, 'players + venue is exactly zero');
  assert.strictEqual(seg.player_cents, 200000, 'both players hold their full funds');
  assert.strictEqual(seg.venue_cents, -200000);
  settle.settleMarket(db, marketId, { winner_selection_id: s1 });
  assert.strictEqual(acc.segregation(db).net, 0, 'still zero after settlement');
});

// D7: an UNBALANCED posting set is refused at the only place postings are
// written, so it cannot be committed anywhere in the codebase.
check('D7 unbalanced postings are refused', () => {
  const { db, alice } = fixture();
  const txId = Number(db.prepare("INSERT INTO transactions (user_id,type,amount_cents,balance_after,frozen_after) VALUES (?,'deposit',1,1,0)").run(alice.id).lastInsertRowid);
  assert.throws(
    () => acc.post(db, {
      transaction_id: txId,
      legs: [
        { account_id: acc.accountId(db, 'player_funds', alice.id), direction: 'credit', amount_cents: 500 },
        { account_id: acc.accountId(db, 'house_float', null), direction: 'credit', amount_cents: 200 },
      ],
    }),
    /Unbalanced postings/
  );
  assert.strictEqual(conserved(db), 0, 'nothing partial was written');
});

// D8: a negative amount is impossible — direction carries the sign. This
// closes the "which side of the entry is negative?" ambiguity.
check('D8 postings reject negative amounts and unknown directions', () => {
  const { db, alice } = fixture();
  const txId = Number(db.prepare("INSERT INTO transactions (user_id,type,amount_cents,balance_after,frozen_after) VALUES (?,'deposit',1,1,0)").run(alice.id).lastInsertRowid);
  const funds = acc.accountId(db, 'player_funds', alice.id);
  const house = acc.accountId(db, 'house_float', null);
  assert.throws(() => acc.post(db, { transaction_id: txId, legs: [
    { account_id: funds, direction: 'credit', amount_cents: -100 },
    { account_id: house, direction: 'debit', amount_cents: -100 },
  ] }), /non-negative/);
  assert.throws(() => acc.post(db, { transaction_id: txId, legs: [
    { account_id: funds, direction: 'left', amount_cents: 100 },
    { account_id: house, direction: 'right', amount_cents: 100 },
  ] }), /debit\|credit/);
});

// D9: a player account with NO owner would be money belonging to nobody —
// exactly the ambiguity segregation exists to remove. Refused both ways.
check('D9 account kinds and owners cannot be mismatched', () => {
  const { db, alice } = fixture();
  assert.throws(() => acc.accountId(db, 'player_funds', null), /requires a user/);
  assert.throws(() => acc.accountId(db, 'house_float', alice.id), /must not have a user/);
  assert.throws(() => acc.accountId(db, 'not_a_kind', null), /Unknown account kind/);
});

// D10: the DATABASE enforces the player/venue split, not just the service
// layer. A direct INSERT cannot create an unowned player_funds row.
check('D10 the schema itself refuses an unowned player account', () => {
  const { db } = fixture();
  assert.throws(() => db.prepare("INSERT INTO accounts (kind, user_id) VALUES ('player_funds', NULL)").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("INSERT INTO accounts (kind, user_id) VALUES ('house_float', 1)").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("INSERT INTO accounts (kind, user_id) VALUES ('made_up', NULL)").run(), /CHECK constraint failed/);
});

// D11: a VOID returns every cent and must leave the books whole. Void is the
// path where a conservation bug would be hardest to spot and most expensive.
check('D11 a void refunds fully and conserves', () => {
  const { db, alice, bob, marketId, s1 } = fixture();
  M.placeOrder(db, bob, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 20000 });
  M.placeOrder(db, alice, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 20000 });
  settle.settleMarket(db, marketId, { void: true });
  assert.strictEqual(acc.userBalance(db, alice.id, 'player_funds'), 100000, 'fully refunded');
  assert.strictEqual(acc.userBalance(db, alice.id, 'player_escrow'), 0, 'no escrow left');
  assert.strictEqual(acc.userBalance(db, bob.id, 'player_funds'), 100000);
  assert.strictEqual(venueBal(db, 'operator_commission'), 0, 'no revenue on a void');
  assert.strictEqual(conserved(db), 0);
  assert.deepStrictEqual(agree(db), []);
});

// D12: the ESCROW INVARIANT, restated in double-entry terms. Across a
// property sweep of prices and stakes, no sequence ever creates money.
check('D12 escrow invariant holds across a price x stake sweep', () => {
  let worst = 0;
  for (const price of [1.5, 2.0, 3.0, 5.0]) {
    for (const stake of [1000, 7777, 50000]) {
      const { db, alice, bob, marketId, s1 } = fixture();
      M.placeOrder(db, bob, { selection_id: s1, side: 'back', price, stake_cents: stake });
      // The LAY side escrows (price-1)*stake, so at price 5 a 50000 lay needs
      // 200000 — more than the account holds. Cap it so the sweep is about
      // conservation across a range of FILLED sizes, including partial fills,
      // rather than about who can afford to lay.
      const layStake = Math.min(stake, 20000);
      M.placeOrder(db, alice, { selection_id: s1, side: 'lay', price, stake_cents: layStake });
      const before = acc.segregation(db).player_cents;
      settle.settleMarket(db, marketId, { winner_selection_id: s1 });
      const after = acc.segregation(db).player_cents;
      // Players' total may legitimately move by the realised P&L, but the
      // books must always close to exactly zero.
      worst = Math.max(worst, Math.abs(acc.assertConserved(db)), Math.abs(acc.segregation(db).net));
      assert.strictEqual(acc.assertConserved(db), 0, `conserved at ${price}/${stake}`);
      assert.deepStrictEqual(acc.assertUserAgrees(db), [], `cache agrees at ${price}/${stake}`);
      assert.ok(before > 0 && after > 0, 'players always hold a positive net position');
    }
  }
  assert.strictEqual(worst, 0);
});

// D13: a bot — the house counterparty — participates in the same ledger and
// may legitimately go negative there. The house is not a special case that
// escapes double-entry.
check('D13 the house counterparty posts like any other account', () => {
  const { db, alice, marketId, s1 } = fixture();
  const bot = A.registerUser(db, { username: 'MarketMakers', password: 'bot-account-password-never-usable', is_bot: 1, balance_cents: 10000000 });
  // The house LAYs s1 and the player BACKs it, then s1 wins — the backer wins,
  // so the house is on the losing side. (Whoever initiates is irrelevant.)
  M.placeOrder(db, bot, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 30000 });
  M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 30000 });
  settle.settleMarket(db, marketId, { winner_selection_id: s1 });
  assert.ok(acc.userBalance(db, bot.id, 'player_funds') < 10000000, 'house absorbed the loss');
  assert.strictEqual(conserved(db), 0);
  assert.deepStrictEqual(agree(db), []);
});

// D14: an operator adjustment is venue money, so it posts against house_float
// rather than pretending to be a player payment.
check('D14 operator adjustment posts against the house float', () => {
  const { db, alice } = fixture();
  const floatBefore = venueBal(db, 'house_float');
  const clearingBefore = venueBal(db, 'gateway_clearing');
  L.adjust(db, alice.id, 2500);
  assert.strictEqual(venueBal(db, 'house_float'), floatBefore - 2500, 'house funded it');
  assert.strictEqual(venueBal(db, 'gateway_clearing'), clearingBefore, 'NOT an external payment');
  L.adjust(db, alice.id, -500);
  assert.strictEqual(conserved(db), 0);
  assert.deepStrictEqual(agree(db), []);
});

// D15: zero-amount legs are dropped, not rejected. A settlement with no
// commission is normal, and making callers pre-filter is how a future caller
// forgets.
check('D15 zero-value transfers post nothing but do not fail', () => {
  const { db, alice } = fixture();
  const n0 = db.prepare('SELECT COUNT(*) c FROM entries').get().c;
  const txId = Number(db.prepare("INSERT INTO transactions (user_id,type,amount_cents,balance_after,frozen_after) VALUES (?,'deposit',0,1,0)").run(alice.id).lastInsertRowid);
  const r = acc.postTransfer(db, {
    transaction_id: txId,
    from: acc.accountId(db, 'player_funds', alice.id),
    to: acc.accountId(db, 'house_float', null),
    deltaCents: 0,
  });
  assert.strictEqual(r.posted, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM entries').get().c, n0, 'no rows written');
});

console.log(`\nledger2.test.js: ${passed} checks passed`);
if (passed < 15) { console.error('expected 15 checks'); process.exit(1); }