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
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

let evCounter = 0;
function fresh() {
  const db = openStore(':memory:');
  const mk = (name) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: 100000 });
  return { db, users: { alice: mk('alice'), bob: mk('bob'), carol: mk('carol'), dave: mk('dave') } };
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
check('C1 quoting does not execute', () => {
  const { db, users } = fresh();
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
check('C2 no position is refused', () => {
  const { db, users } = fresh();
  const market_id = inTheMoney(db, users);
  assert.strictEqual(C.cashoutQuote(db, users.carol, market_id), null, 'carol holds nothing');
  assert.throws(() => C.cashoutMarket(db, users.carol, market_id), /unavailable/);
  assert.deepStrictEqual(balances(db, users.carol.id), { b: 100000, f: 0 });
});

// C3: a SETTLED market cannot be cashed out — the position is already gone,
// and paying again would be a double-settlement.
check('C3 a settled market is refused', () => {
  const { db, users } = fresh();
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
check('C4 a refused buyout is atomic and leaves the position intact', () => {
  const { db, users } = fresh();
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
check('C5 cash-out can be disabled', () => {
  const { db, users } = fresh();
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
check('C6 a mixed back/lay position across runners is now supported', () => {
  const { db, users } = fresh();
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
check('C7 the house account is not given a cash-out quote', () => {
  const { db, users } = fresh();
  const market_id = inTheMoney(db, users);
  const bots = require('../lib/bots');
  const bot = bots.ensureBot(db);
  // Give the house a position against a player.
  M.placeOrder(db, bot, { selection_id: 1, side: 'lay', price: 3.5, stake_cents: 10000 });
  M.placeOrder(db, users.dave, { selection_id: 1, side: 'back', price: 3.5, stake_cents: 10000 });
  const plan = C.cashoutQuote(db, bot, market_id);
  assert.ok(plan === null || plan.mode === 'buyout', 'house is refused or not quoted');
  assert.strictEqual(plan, null, 'and in fact refused outright');
});

console.log(`\ncashout.test.js: ${passed} checks passed`);
if (passed < 7) { console.error('expected 7 checks'); process.exit(1); }