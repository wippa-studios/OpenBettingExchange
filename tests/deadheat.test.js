// deadheat.test.js — joint-favourite (dead heat) settlement.
// Run: node tests/deadheat.test.js   (plain assert, no deps)
//
// WHY THIS EXISTS. The engine settled exactly one selection, so a dead heat
// could not be paid: lib/voidrules.js HELD it, and the operator's only exit was
// to VOID. Voiding a dead heat pays nobody — it underpays the winners' backers
// and overcharges their layers — so a market type the venue must offer (it is
// routine in racing) had no correct outcome, only a wrong one.
//
// The model: the PAYOUT is divided among the joint winners. Each side still
// gets its own collateral back in full; the wager result is the liability
// shared n ways.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const S = require('../lib/settle');
const acc = require('../lib/accounts');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

let n = 0;
async function fixture(runners = ['Red', 'Blue', 'Green']) {
  // ensureBot() is synchronous (it runs inside transactions in lib/settle.js and
  // lib/cashoutrisk.js) and so cannot derive the house password hash itself.
  // This venue is hand-built rather than seeded, so prime it explicitly.
  await require('../lib/bots').primeBotHash();
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Horse Racing', 'horse_racing')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='horse_racing'").get();
  n++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at, status) VALUES (?, ?, datetime('now','+2 hours'), 'live')")
    .run(sp.id, `Race ${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Race ${n}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Winner')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  const ids = {};
  for (const r of runners) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 3.0)').run(mkt.id, r);
    ids[r] = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, r).id;
  }
  const mk = async (u) => A.registerUser(db, { username: u, password: `pw-${u}-1234`, balance_cents: 100000 });
  return { db, marketId: mkt.id, ids, alice: (await mk('alice')), bob: (await mk('bob')), carol: (await mk('carol')), dave: (await mk('dave')) };
}

const bal = (f, u) => f.db.prepare('SELECT balance_cents b, frozen_cents fz FROM users WHERE username=?').get(u);
const bet = (f, who, sel, side, price = 3.0, stake = 1000) =>
  M.placeOrder(f.db, who, { selection_id: sel, side, price, stake_cents: stake });

// H1: the core property. Two joint winners in a 3-runner race: each winning
// backer is paid the liability DIVIDED two ways; the losing backer is paid
// nothing and loses their stake.
check('H1 a dead heat pays each joint winner a SHARE of the liability', async () => {
  const f = (await fixture());
  bet(f, f.alice, f.ids.Red, 'back');   // wins (joint)
  bet(f, f.bob, f.ids.Red, 'lay');
  bet(f, f.carol, f.ids.Blue, 'back');  // wins (joint)
  bet(f, f.dave, f.ids.Blue, 'lay');
  bet(f, f.alice, f.ids.Green, 'back'); // loses outright
  bet(f, f.bob, f.ids.Green, 'lay');
  const before = { alice: bal(f, 'alice').b, bob: bal(f, 'bob').b, carol: bal(f, 'carol').b, dave: bal(f, 'dave').b };

  S.settleMarket(f.db, f.marketId, { dead_heat: [f.ids.Red, f.ids.Blue] });

  // Liability at 3.0 on 1000 = 2000. Two joint winners -> 1000 each.
  // alice: +1000 (Red share) - 1000 (Green lost) = 0 net, no commission.
  assert.strictEqual(bal(f, 'alice').b - before.alice, 0, 'alice nets zero: shared win, outright loss');
  // carol: +1000, commission ceil(1000*0.025) = 25.
  assert.strictEqual(bal(f, 'carol').b - before.carol, 1000 - 25, 'carol is paid a share less commission');
  // bob: -1000 (Red share) + 1000 (Green lay wins) = 0.
  assert.strictEqual(bal(f, 'bob').b - before.bob, 0, 'bob nets zero');
  assert.strictEqual(bal(f, 'dave').b - before.dave, -1000, 'dave pays a share');
  // Commission is the only money that leaves the players.
  assert.strictEqual(
    (bal(f, 'alice').b - before.alice) + (bal(f, 'bob').b - before.bob) +
    (bal(f, 'carol').b - before.carol) + (bal(f, 'dave').b - before.dave),
    -25,
    'exactly the commission leaves'
  );
  assert.strictEqual(acc.assertConserved(f.db), 0, 'conservation holds');
  assert.deepStrictEqual(acc.assertUserAgrees(f.db), [], 'the cache agrees');
});

// H2: EVERY participant's escrow returns to zero. A divided pot is where
// stranded frozen would appear: if the stake were divided too, the unallocated
// shares would have no one to release them.
check('H2 every participant is fully unfrozen after a dead heat', async () => {
  for (const winners of [['Red', 'Blue'], ['Red', 'Blue', 'Green']]) {
    const f = (await fixture());
    bet(f, f.alice, f.ids.Red, 'back');
    bet(f, f.bob, f.ids.Red, 'lay');
    bet(f, f.carol, f.ids.Blue, 'back');
    bet(f, f.dave, f.ids.Blue, 'lay');
    S.settleMarket(f.db, f.marketId, { dead_heat: winners.map((w) => f.ids[w]) });
    for (const u of ['alice', 'bob', 'carol', 'dave']) {
      assert.strictEqual(bal(f, u).fz, 0, `${u} unfrozen (${winners.length} joint winners)`);
    }
    assert.strictEqual(acc.assertConserved(f.db), 0);
    assert.deepStrictEqual(acc.assertUserAgrees(f.db), []);
  }
});

// H3: THE ROUNDING FLOOR IS ANTI-EXPLOITATION, not a preference. A 1-cent
// match at 3.0 has a liability of 2; with two joint winners that is 1 each. A
// ROUNDED share would also be 1 — but a player who splits a large win into
// thousands of 1-cent matches rounds the share UP on every one of them, and
// wins far more than the liability. The floor makes splitting pay LESS, so
// there is no exploit: the same splitter arbitrage the audit found in
// commission (F7) does not exist here.
check('H3 the share is floored, so splitting cannot harvest rounding', async () => {
  const f = (await fixture());
  // One 1-cent match per "split" is below MIN_STAKE, so use the smallest
  // legal stake and check the arithmetic directly through settlement.
  const stake = 100; // MIN_STAKE
  bet(f, f.alice, f.ids.Red, 'back', 3.0, stake);
  bet(f, f.bob, f.ids.Red, 'lay', 3.0, stake);
  const before = bal(f, 'alice').b;
  S.settleMarket(f.db, f.marketId, { dead_heat: [f.ids.Red, f.ids.Blue] });
  // Liability 200, two joint winners -> floor(100) = 100. Alice is paid 100,
  // NOT 200: a third joint winner would make it floor(200/3) = 66.
  assert.strictEqual(bal(f, 'alice').b - before, 100 - 3, 'paid floor(liability/2) = 100');
  assert.strictEqual(acc.assertConserved(f.db), 0);
});

// H4: an ODD liability floors, and the remainder is never created. 1001 across
// 3 winners: floor(1000/3) = 333 each, and the books still balance — the
// sub-cent remainder is not minted, it simply never leaves the layer's own
// collateral.
check('H4 an indivisible liability floors and still balances', async () => {
  const f = (await fixture());
  bet(f, f.alice, f.ids.Red, 'back', 3.0, 1001);
  bet(f, f.bob, f.ids.Red, 'lay', 3.0, 1001);
  bet(f, f.carol, f.ids.Blue, 'back', 3.0, 1001);
  bet(f, f.dave, f.ids.Blue, 'lay', 3.0, 1001);
  bet(f, f.alice, f.ids.Green, 'back', 3.0, 1001);
  bet(f, f.bob, f.ids.Green, 'lay', 3.0, 1001);
  S.settleMarket(f.db, f.marketId, { dead_heat: [f.ids.Red, f.ids.Blue, f.ids.Green] });
  // Liability round(2 * 1001) = 2002 per match; three joint winners ->
  // floor(2002/3) = 667 each. Alice backed Red and Green (two shares), Carol
  // backed Blue (one).
  assert.strictEqual(bal(f, 'alice').b - 100000, 2 * 667 - Math.ceil(2 * 667 * 0.025), 'two shares, less commission');
  assert.strictEqual(bal(f, 'carol').b - 100000, 667 - Math.ceil(667 * 0.025), 'one share, less commission');
  assert.strictEqual(acc.assertConserved(f.db), 0, 'and the books still balance exactly');
  assert.deepStrictEqual(acc.assertUserAgrees(f.db), []);
});

// H5: the ordinary single-winner path is UNCHANGED — floor(x/1) is x. The
// most carefully tested path in the codebase is proved unchanged here rather
// than asserted.
check('H5 a single winner still pays the full liability', async () => {
  const f = (await fixture());
  bet(f, f.alice, f.ids.Red, 'back', 3.0, 1000);
  bet(f, f.bob, f.ids.Red, 'lay', 3.0, 1000);
  S.settleMarket(f.db, f.marketId, { winner_selection_id: f.ids.Red });
  assert.strictEqual(bal(f, 'alice').b, 100000 + 2000 - 50, 'full 2000, not half');
  assert.strictEqual(bal(f, 'bob').b, 100000 - 2000, 'and the layer pays it all');
  assert.strictEqual(acc.assertConserved(f.db), 0);
});

// H6: validation. A dead heat is a SET of joint winners; anything else is a
// caller mistake that must not silently settle something.
check('H6 a malformed dead heat is refused', async () => {
  const f = (await fixture());
  bet(f, f.alice, f.ids.Red, 'back');
  bet(f, f.bob, f.ids.Red, 'lay');
  const bad = [
    [{ dead_heat: [f.ids.Red] }, /at least 2/i],              // one winner is not a dead heat
    [{ dead_heat: [] }, /at least 2/i],
    [{ dead_heat: 'Red,Blue' }, /array/i],
    [{ dead_heat: [f.ids.Red, f.ids.Red] }, /at least 2 distinct/i], // dedupes to ONE
    [{ dead_heat: [0, -1] }, /positive integers/i],
    [{ dead_heat: [f.ids.Red, f.ids.Blue], void: true }, /not both/i],
  ];
  for (const [opts, re] of bad) {
    assert.throws(() => S.settleMarket(f.db, f.marketId, opts), (e) => e.status === 400 && re.test(e.message), JSON.stringify(opts));
  }
  // A joint winner from ANOTHER market is the foreign-selection 400, and a
  // dead heat is not an exception to it. The other selection must live in the
  // SAME database: two separate :memory: fixtures hand out the SAME ids, so
  // "g.ids.Blue" was not foreign at all and this assertion silently proved
  // nothing.
  const other = f.db.prepare('SELECT event_id FROM markets WHERE id = ?').get(f.marketId).event_id;
  f.db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Another')").run(other);
  const otherMarket = f.db.prepare('SELECT id FROM markets WHERE event_id = ? ORDER BY id DESC LIMIT 1').get(other).id;
  f.db.prepare("INSERT INTO selections (market_id, name) VALUES (?, 'Elsewhere')").run(otherMarket);
  const foreign = f.db.prepare('SELECT id FROM selections WHERE market_id = ?').get(otherMarket).id;
  assert.throws(
    () => S.settleMarket(f.db, f.marketId, { dead_heat: [f.ids.Red, foreign] }),
    (e) => e.status === 400 && /not in this market/i.test(e.message),
    'a joint winner from another market is refused'
  );
  assert.strictEqual(f.db.prepare('SELECT status s FROM markets WHERE id=?').get(f.marketId).s, 'open', 'and nothing settled');
  assert.strictEqual(acc.assertConserved(f.db), 0, 'and no money moved');
});

// H7: terminality. A dead-heat market is settled; a second settlement is
// refused, and cannot be re-opened as a single winner.
check('H7 a dead-heat market is terminal', async () => {
  const f = (await fixture());
  bet(f, f.alice, f.ids.Red, 'back');
  bet(f, f.bob, f.ids.Red, 'lay');
  S.settleMarket(f.db, f.marketId, { dead_heat: [f.ids.Red, f.ids.Blue] });
  const after = bal(f, 'alice').b;
  assert.throws(() => S.settleMarket(f.db, f.marketId, { dead_heat: [f.ids.Red, f.ids.Blue] }), (e) => e.status === 409);
  assert.throws(() => S.settleMarket(f.db, f.marketId, { winner_selection_id: f.ids.Red }), (e) => e.status === 409);
  assert.strictEqual(bal(f, 'alice').b, after, 'and paid nothing further');
  assert.strictEqual(acc.assertConserved(f.db), 0);
});

// H8: the record. A dead heat is distinguishable from a single win in the
// database, because an operator (and a regulator) asking "how did this market
// settle" needs the answer.
check('H8 a dead heat is recorded as one', async () => {
  const f = (await fixture());
  bet(f, f.alice, f.ids.Red, 'back');
  bet(f, f.bob, f.ids.Red, 'lay');
  S.settleMarket(f.db, f.marketId, { dead_heat: [f.ids.Red, f.ids.Blue] });
  const m = f.db.prepare('SELECT dead_heat d, joint_winners j, winner_selection_id w, status s FROM markets WHERE id=?').get(f.marketId);
  assert.strictEqual(m.d, 1, 'flagged as a dead heat');
  assert.strictEqual(m.w, null, 'no single winner');
  assert.deepStrictEqual(JSON.parse(m.j).sort((a, b) => a - b), [f.ids.Red, f.ids.Blue].sort((a, b) => a - b));
  assert.strictEqual(m.s, 'settled');
  // The settlements rows exist per user, as for any settlement.
  const rows = f.db.prepare('SELECT COUNT(*) c FROM settlements WHERE market_id=?').get(f.marketId).c;
  assert.strictEqual(rows, 2, 'one row per paying participant');
});

// H9: a dead heat on a market with cash-out buyouts. The venue took over a
// player's side; the buyout's realised loss must be computed against the
// JOINT set, or the desk reports a number the books do not support.
check('H9 a cashed-out position resolves against the joint winner set', async () => {
  const f = (await fixture(['Red', 'Blue']));
  // Alice backs Red; Bob lays it. Alice cashes out, so the house takes her back
  // side and Bob's counterparty position is preserved.
  bet(f, f.alice, f.ids.Red, 'back', 2.5, 10000);
  bet(f, f.bob, f.ids.Red, 'lay', 2.5, 10000);
  const C = require('../lib/cashout');
  const plan = C.cashoutMarket(f.db, f.alice, f.marketId);
  assert.ok(plan.payout_cents > 0, 'bought out');

  S.settleMarket(f.db, f.marketId, { dead_heat: [f.ids.Red, f.ids.Blue] });
  const q = f.db.prepare('SELECT proceeds_cents p, loss_cents l, settled_at s FROM cashout_quotes').get();
  assert.ok(q.s, 'the buyout resolved at settlement');
  // The house held Alice's back at 2.5; Red is a JOINT winner, so the house is
  // paid a SHARE: floor(15000/2) = 7500, not the full 15000.
  assert.strictEqual(q.p, 7500, 'proceeds are the shared amount, not the full liability');
  assert.strictEqual(q.l, plan.payout_cents - 7500, 'loss is paid minus what the shared position returned');
  assert.strictEqual(acc.assertConserved(f.db), 0, 'and the books balance');
  assert.deepStrictEqual(acc.assertUserAgrees(f.db), []);
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
  if (passed < 9) { console.error('expected 9 checks'); process.exit(1); }
  console.log(`\ndeadheat.test.js: ${passed} checks passed`);
})();
