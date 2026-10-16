// deductions.test.js — the DECLARED DEDUCTION on bets surviving a late scratching.
//
// Run: node tests/deductions.test.js   (plain assert, no deps)
//
// ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────────
//
// A race goes off with a runner scratched. The venue does the half it has always
// done and gets it right: the scratch is voided, its backers refunded at the match
// price, its resting orders cancelled, and every other runner carries on trading
// (lib/results.js `applyWithdrawal`, lib/settle.js `voidSelection`).
//
// The other half of the same published rule is a DEDUCTION on the runners that
// SURVIVED. WA rule 4A, betr's Scale of Deductions v1.1, and the GRV greyhound
// Deduction Schedule all require one, scaled by the withdrawn runner's odds. A
// venue that refunds and stops OVERPAYS the backers of every surviving runner by
// the deduction it never applies — on every race with a late scratching, which on
// an Australian racing launch is most of them.
//
// CONSERVATION CANNOT SEE THAT DEFECT, and this file never leans on it to prove a
// fix. The money goes to a real bettor in a real account in every version of it;
// the books balance throughout. So every assertion below is about WHO WAS PAID HOW
// MUCH, and `assertConserved` appears only as the secondary claim that the money
// that moved is still posted through the double-entry layer.
//
// ── WHY THE VENUE DOES NOT COMPUTE A DEDUCTION ───────────────────────────────
//
// Because it must not. The scale is published per racing authority and per
// jurisdiction, it is versioned, and the STEWARDS declare it in a particular race —
// WA 4A says explicitly that where the withdrawn runner is shorter than the table
// covers, the stewards may declare all wagers void and re-open the race. A venue
// that guesses is inventing a racing rule. So the signal may CARRY a declaration,
// the venue applies what is declared, records what it applied, and refuses to
// invent one. Search this file for a scale table; there is none, and that absence
// is the feature.
//
// ── WHY EVERY CASE ASSERTS ITS CONTROL BESIDE IT ─────────────────────────────
//
// STATE.md §5.6 records the fourth time this project found a green assertion that
// structurally could not see its defect. The failure shape here is specific: a
// suite that only checks "the winner got less" passes against a venue that simply
// pays every winner nothing, and against a venue that refunds everything. So each
// check below pairs its case with the control that a wrong implementation fails —
// the identical race with no declaration, the identical declaration attached to the
// wrong runner, the identical market with the winner at a different price. A
// deduction feature that cannot show what it changed has not been tested.
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
const R = require('../lib/results');
const S = require('../lib/settle');
const D = require('../lib/deductions');
const acc = require('../lib/accounts');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event loop),
// so they are COLLECTED and drained in order at the bottom of this file rather than
// run eagerly - an eager runner would report a passing check whose promise later
// rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

let n = 0;
//
// A racing venue, built to be READABLE rather than realistic: three runners, two
// players, and a fair_price per runner that the test chooses.
//
// `prices` matters and is not decoration. The deduction is scaled by the ODDS OF
// THE SURVIVING RUNNERS (WA 4A), and the odds come from `fair_price` — the price
// on offer for a runner — while the payout comes from the MATCH price. They are
// deliberately different columns: a backer who got 3.0 has a 3.0 dividend whatever
// the model says the runner is worth, and the published deduction is expressed
// against the runner, not against the fill. A fixture that set them equal would
// hide that separation instead of testing it.
async function venue(sport = 'horse_racing', { prices = { Red: 3, Blue: 3, Green: 3 }, payout_shape = null } = {}) {
  await require('../lib/bots').primeBotHash();
  const db = openStore(':memory:');
  db.prepare('INSERT INTO sports (name, slug) VALUES (?, ?)').run(sport, sport);
  const sp = db.prepare('SELECT id FROM sports WHERE slug=?').get(sport);
  n++;
  db.prepare("INSERT INTO events (sport_id,name,starts_at,status) VALUES (?, ?, datetime('now','+2 hours'), 'live')")
    .run(sp.id, `Race ${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name=?').get(`Race ${n}`);
  if (payout_shape) {
    db.prepare('INSERT INTO markets (event_id,name,payout_shape) VALUES (?, ?, ?)').run(ev.id, 'To Be Placed', payout_shape);
  } else {
    db.prepare('INSERT INTO markets (event_id,name) VALUES (?, ?)').run(ev.id, 'Winner');
  }
  const m = db.prepare('SELECT * FROM markets WHERE event_id=? ORDER BY id DESC').get(ev.id);
  const ids = {};
  for (const nm of ['Red', 'Blue', 'Green']) {
    const p = prices[nm];
    if (p === null) {
      db.prepare('INSERT INTO selections (market_id,name) VALUES (?, ?)').run(m.id, nm);
    } else {
      db.prepare('INSERT INTO selections (market_id,name,fair_price) VALUES (?, ?, ?)').run(m.id, nm, p);
    }
    ids[nm] = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(m.id, nm).id;
  }
  const mk = async (u) => A.registerUser(db, { username: u, password: `pw-${u}-1234`, balance_cents: 100000 });
  return { db, m, ids, a: await mk('alice'), b: await mk('bob'), c: await mk('carol'), d: await mk('dave') };
}

// A plain object, not the row: node:sqlite returns null-prototype objects and
// deepStrictEqual compares prototypes, so asserting a row against a literal fails
// on the prototype rather than on the numbers.
const wallet = (v, who) => {
  const r = v.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE username=?').get(who);
  return { b: r.b, f: r.f };
};
const sel = (v, name) => v.db.prepare('SELECT status FROM selections WHERE id=?').get(v.ids[name]);
const backs = (v, who, name, stake = 10000, price = 3.0) =>
  M.placeOrder(v.db, v[who], { selection_id: v.ids[name], side: 'back', price, stake_cents: stake });
const lays = (v, who, name, stake = 10000, price = 3.0) =>
  M.placeOrder(v.db, v[who], { selection_id: v.ids[name], side: 'lay', price, stake_cents: stake });
// A matched leg: one back, one lay, both sides' escrow genuinely committed. Every
// check asserts this pre-state, so a run where the code did nothing fails rather
// than passing vacuously.
const leg = (v, name, stake = 10000, price = 3.0) => {
  backs(v, 'a', name, stake, price);
  lays(v, 'b', name, stake, price);
};
const allFunds = (v) => {
  const r = v.db.prepare('SELECT SUM(balance_cents) t, SUM(frozen_cents) f FROM users').get();
  return { t: r.t, f: r.f };
};
const provenance = (v) => v.db.prepare('SELECT * FROM result_events WHERE market_id=? ORDER BY id').all(v.m.id);
// The DECLARED shape, in the unit the published schedules use. betr prints whole
// percentages; this is that form.
const pct = (selectionId, value, extra = {}) => ({ selection_id: selectionId, unit: 'percent', value, ...extra });

// ── D1: THE CASE, AND WHAT IT CHANGES ────────────────────────────────────────
// Red is scratched, Blue wins. alice's matched stake on Blue is 10000 at 3.0, so
// the liability is 20000 and the full dividend is 20000.
//
//   no declaration   alice 119500  (+20000 - 500 commission)  bob 80000
//   declared 20%     alice 115600  (+16000 - 400 commission)  bob 84000
//
// The 4000 is taken off the WINNINGS, not the stake: alice's stake still comes back
// whole and only her profit is charged, which is what "applied to the amount
// payable to the holder" means in all three schedules.
check('D1 a declared deduction is taken off the winning backer, through the posting layer', async () => {
  const v = await venue();
  leg(v, 'Blue');
  leg(v, 'Red'); // something on the scratch to refund, so both halves of the rule run

  // PRE-STATE. A run where nothing happened must fail below.
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 20000 }, "alice has Blue and Red at risk");
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 100000, f: 40000 }, 'bob carries both liabilities');
  const fundsBefore = allFunds(v);
  assert.notStrictEqual(fundsBefore.f, 0);

  const r = R.applyOutcome(v.db, v.m.id, {
    status: 'completed',
    winners: [v.ids.Blue],
    non_runners: [v.ids.Red],
    // 20% declared against the withdrawn runner, by the stewards, for the win shape.
    deductions: [pct(v.ids.Red, 20, { declared_by: 'stewards, race 4' })],
  });

  assert.strictEqual(r.outcome, 'settled', 'the race still settles on the runner that ran');
  assert.strictEqual(r.rule, 'non_runner');

  // THE NUMBER THAT IS THE POINT. 20000 dividend, 20% off = 16000 paid, and
  // commission on the REDUCED figure (ceil(16000 * 0.025) = 400).
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 115600, f: 0 }, 'the winner is paid 20% less than the liability');
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 84000, f: 0 }, 'and the layer is paid the difference');

  // IT WENT THROUGH THE POSTING LAYER, NOT A HAND-WRITTEN BALANCE EDIT. Three
  // independent pieces of evidence, because "the balance moved" would also be true
  // of an UPDATE:
  //   - the wallet transaction the ledger writes for a settlement carries the
  //     POST-deduction figure, so the player's own history is honest;
  //   - the `settlements` row records the post-deduction pnl, so the per-market
  //     report and the commission base are not the pre-deduction number;
  //   - the double-entry `entries` exist and the cache still agrees with them.
  const tx = v.db.prepare("SELECT amount_cents a, balance_after b FROM transactions WHERE user_id=? AND type='settle' AND market_id=?")
    .get(v.a.id, v.m.id);
  assert.strictEqual(tx.a, 16000, 'the wallet ledger shows the reduced dividend');
  assert.strictEqual(tx.b, 115600, 'and the balance it was written against');
  const st = v.db.prepare('SELECT pnl_cents p, credit_cents c, commission_cents f FROM settlements WHERE user_id=? AND market_id=?')
    .get(v.a.id, v.m.id);
  assert.deepStrictEqual({ p: st.p, c: st.c, f: st.f }, { p: 16000, c: 26000, f: 400 },
    'the settlement row is the post-deduction figure, which is what makes the report right');
  assert.strictEqual(
    v.db.prepare("SELECT COUNT(*) n FROM entries e JOIN transactions t ON t.id=e.transaction_id WHERE t.user_id=? AND t.type='settle'").get(v.a.id).n,
    4, 'escrow back to funds, and the result against the book — two balanced postings'
  );

  // THE SCRATCH IS STILL REFUNDED. Requirement six: the non-runner void is not
  // touched by any of this. alice had 10000 on Red and gets every cent of it back.
  assert.strictEqual(sel(v, 'Red').status, 'void', 'the withdrawn runner is still off the board');
  assert.ok(kindsOf(v, 'a').includes('refund'), 'and alice has a refund row for it');

  // CONSERVATION, SECONDARY. Not the assertion — it cannot see this defect at all —
  // but the claim that the money moved through the layer is worth something only if
  // the layer balances.
  assert.strictEqual(acc.assertConserved(v.db), 0, 'the ledger still balances');
  assert.deepStrictEqual(acc.assertUserAgrees(v.db), [], 'the balance cache agrees with the postings');

  // THE CONTROL, BESIDE IT. The identical race with NO declaration. If this also
  // paid 115600 then nothing in the case above proved a deduction happened; if it
  // paid less than 115600 then the deduction was applied by accident. Exactly
  // 119500, and the absence is on the record — which is D3's subject, asserted here
  // too because a control that is only asserted in another check is not a control.
  const c = await venue();
  leg(c, 'Blue');
  leg(c, 'Red');
  const plain = R.applyOutcome(c.db, c.m.id, { status: 'completed', winners: [c.ids.Blue], non_runners: [c.ids.Red] });
  assert.strictEqual(plain.outcome, 'settled');
  assert.deepStrictEqual(wallet(c, 'alice'), { b: 119500, f: 0 },
    'without a declaration the same winner is paid the full liability, less commission');
  assert.strictEqual(plain.deductions, null, 'and nothing is reported as applied');
  const plainRow = provenance(c)[0];
  assert.strictEqual(plainRow.deduction_state, 'undeclared', 'the absence is recorded');
  assert.strictEqual(acc.assertConserved(c.db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(c.db), []);
  c.db.close();
  v.db.close();
});

function kindsOf(v, key) {
  return v.db.prepare('SELECT type FROM transactions WHERE user_id=? ORDER BY id').all(v[key].id).map((r) => r.type);
}

// ── D2: THE LAY SIDE, WHICH IS NOT OPTIONAL ───────────────────────────────────
// The deduction is taken out of a payment that was ALREADY going from the layer to
// the backer, so it lands on the layer. Taking it off the backer alone would be
// money from nowhere; paying it to the house would be the venue taxing a published
// deduction it was told to apply. The layer keeps the difference: their collateral
// still comes back in full, and they are charged the reduced dividend.
//
// This is asserted rather than assumed because the alternative — deducting from the
// backer only — conserves too, so conservation cannot choose between them. Only the
// two balances can.
check('D2 the deduction reduces the LAYER\'s loss as well as the backer\'s win', async () => {
  const v = await venue();
  leg(v, 'Blue');
  leg(v, 'Red');

  R.applyOutcome(v.db, v.m.id, {
    status: 'completed', winners: [v.ids.Blue], non_runners: [v.ids.Red],
    deductions: [pct(v.ids.Red, 20)],
  });

  assert.deepStrictEqual(wallet(v, 'alice'), { b: 115600, f: 0 }, 'the backer is charged 20% of the winnings');
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 84000, f: 0 }, 'the layer pays 16000, not 20000');
  // The collateral is untouched on both sides: only the RESULT moved. A deduction
  // that also shaved the stake would be charging a bettor who won, which is not a
  // deduction in any of the three schedules.
  assert.strictEqual(v.db.prepare('SELECT SUM(frozen_cents) f FROM users').get().f, 0, 'every stake came back whole');
  // Conservation holds PER MATCH, not merely per market: the two sides are moved by
  // the same number, which is the only reason this works without a balancing entry.
  const sum = v.db.prepare('SELECT SUM(balance_cents) t FROM users').get().t;
  assert.strictEqual(sum, 400000 - 400, 'only commission left the players, across all four accounts');
  assert.strictEqual(acc.assertConserved(v.db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(v.db), []);

  // THE CONTROL. Same race, same stake, no declaration: the layer pays the whole
  // liability. Without this a venue that simply paid nobody would pass D2.
  const c = await venue();
  leg(c, 'Blue');
  leg(c, 'Red');
  R.applyOutcome(c.db, c.m.id, { status: 'completed', winners: [c.ids.Blue], non_runners: [c.ids.Red] });
  assert.deepStrictEqual(wallet(c, 'bob'), { b: 80000, f: 0 }, 'without a declaration the layer pays the full 20000');
  assert.deepStrictEqual(wallet(c, 'alice'), { b: 119500, f: 0 });
  c.db.close();
  v.db.close();
});

// ── D3: THE FINDING, NOT A SILENT FULL REFUND ────────────────────────────────
// A withdrawal with no declared deduction is not refused — refusing would strand a
// finished race with every bettor's money in it — but it is COUNTED, and the count
// is a query rather than a promise. This is the pattern lib/datasources.js uses for
// an outcome that names no licensed source, and it is the only reason an operator
// can learn what the venue overpaid.
check('D3 a withdrawal with NO declared deduction settles, and the absence is counted', async () => {
  const v = await venue();
  leg(v, 'Blue');
  leg(v, 'Red');

  // PRE-STATE of the count: nothing has been counted yet, and the counters exist.
  assert.strictEqual(D.undeclaredCount(v.db), 0, 'no races have been counted yet');
  assert.strictEqual(D.declaredCount(v.db), 0);
  assert.strictEqual(D.rejectedCount(v.db), 0);

  const r = R.applyOutcome(v.db, v.m.id, { status: 'completed', winners: [v.ids.Blue], non_runners: [v.ids.Red] });

  assert.strictEqual(r.outcome, 'settled', 'refusing would strand the market — it still settles');
  assert.strictEqual(D.undeclaredCount(v.db), 1, 'and the absence is COUNTED');
  assert.strictEqual(D.declaredCount(v.db), 0);
  assert.strictEqual(D.rejectedCount(v.db), 0);

  const row = provenance(v)[0];
  assert.strictEqual(row.deduction_state, 'undeclared', 'the state is on the provenance row, not just in a counter');
  assert.strictEqual(row.deductions_json, JSON.stringify({ state: 'undeclared', rejects: [] }));
  assert.strictEqual(JSON.parse(row.payload).deductions.state, 'undeclared',
    'and beside winners and non_runners, so one row explains the whole outcome');
  assert.strictEqual(row.decision, 'settle', 'the absence did not change the decision');

  // THE OVERVIEW IS THE SCREEN. Three visibly different numbers, which is the whole
  // point: an operator can tell "nobody said" from "somebody said something
  // unusable" without reading a row.
  const ov = D.overview(v.db);
  assert.deepStrictEqual(ov.counts, {
    withdrawal_settlements: 1, declared: 0, undeclared: 1, rejected: 0,
    applied_without_odds_scale: 0, recorded_before_the_off: 0,
  });

  // THE CONTROL BESIDE IT, and it is the half that matters most: a race with NO
  // withdrawal at all must NOT be counted as undeclared. Without this the headline
  // number would be "every race this venue has ever settled" and the whole finding
  // would be unreadable.
  const c = await venue('horse_racing');
  leg(c, 'Blue');
  R.applyOutcome(c.db, c.m.id, { status: 'completed', winners: [c.ids.Blue] });
  assert.strictEqual(D.undeclaredCount(c.db), 0, 'an ordinary finish raises no deduction question');
  assert.strictEqual(provenance(c)[0].deduction_state, null, 'and writes NULL rather than a false finding');
  assert.strictEqual(D.overview(c.db).counts.withdrawal_settlements, 0);

  // ...and a race that is HELD for the place reason must not be counted either: it
  // paid nobody, so it overpaid nobody, and a count that included it would be
  // putting a number in front of an operator that does not correspond to a cent.
  const p = await venue('horse_racing', { payout_shape: 'place' });
  leg(p, 'Blue');
  leg(p, 'Red');
  const held = R.applyOutcome(p.db, p.m.id, { status: 'completed', winners: [p.ids.Blue], non_runners: [p.ids.Red] });
  assert.strictEqual(held.outcome, 'held');
  assert.strictEqual(D.undeclaredCount(p.db), 0, 'a market the venue refused to settle is not an overpayment');
  p.db.close(); c.db.close(); v.db.close();
});

// ── D4: A MALFORMED OR OUT-OF-RANGE DECLARATION IS REFUSED AND NAMED ──────────
// The failure this exists to prevent: a bad figure that silently becomes "no
// deduction", which is a FULL PAYOUT nobody authorised, on a race the stewards
// charged a winner for.
check('D4 a malformed, negative or out-of-range deduction is refused and named', async () => {
  // Each case builds its OWN declaration from the venue, because the runner id is
  // part of what makes one of them invalid and part of what makes the others
  // valid. A table of literal objects with a placeholder id would have tested the
  // id check seven times and nothing else.
  const cases = [
    ['a negative deduction', (v) => [pct(v.ids.Red, -5)], D.R.VALUE_NEGATIVE, /negative/],
    ['a deduction over 100%', (v) => [pct(v.ids.Red, 150)], D.R.OUT_OF_RANGE, /outside the range/],
    ['a deduction with no unit at all', (v) => [{ selection_id: v.ids.Red, value: 20 }], D.R.UNIT_MISSING, /declares a deduction with no unit/],
    ['an unrecognised unit', (v) => [{ selection_id: v.ids.Red, unit: 'cents', value: 20 }], D.R.UNIT_UNKNOWN, /must be one of/],
    ['a quoted figure', (v) => [{ selection_id: v.ids.Red, unit: 'percent', value: '20' }], D.R.VALUE_NOT_A_NUMBER, /must be a number/],
    ['a figure past the unit range', (v) => [{ selection_id: v.ids.Red, unit: 'percent', value: 100.5 }], D.R.OUT_OF_RANGE, /outside the range/],
    ['a percent figure read as a fraction', (v) => [{ selection_id: v.ids.Red, unit: 'fraction', value: 20 }], D.R.OUT_OF_RANGE, /outside the range/],
    ['a coerced runner id', (v) => [{ selection_id: true, unit: 'percent', value: 20 }], D.R.SELECTION_ID_INVALID, /positive integer/],
    ['an unknown payout scope', (v) => [{ selection_id: v.ids.Red, unit: 'percent', value: 20, scope: 'eachway' }], D.R.SCOPE_UNKNOWN, /scope must be one of/],
    ['a good declaration beside a bad one', (v) => [pct(v.ids.Red, 20), pct(v.ids.Red, -5)], D.R.VALUE_NEGATIVE, /negative/],
    ['a deduction that is not a list', () => 20, D.R.NOT_A_LIST, /list of declarations/],
  ];
  for (const [what, build, code, message] of cases) {
    const v = await venue();
    leg(v, 'Blue');
    leg(v, 'Red');
    const before = allFunds(v);
    const r = R.applyOutcome(v.db, v.m.id, {
      status: 'completed',
      winners: [v.ids.Blue],
      non_runners: [v.ids.Red],
      deductions: build(v),
    });

    assert.strictEqual(r.outcome, 'held', `${what}: held, not settled at a payout nobody authorised`);
    assert.strictEqual(r.rule, 'deduction_invalid', `${what}: the rule names the cause`);
    assert.match(r.reason, message, `${what}: the reason says what is wrong`);
    if (code) assert.strictEqual(r.deduction.rejects.some((x) => x.code === code), true, `${what}: a machine-readable code`);

    // NOT SETTLED AT FULL PAYOUT. The single most expensive thing this module could
    // get wrong, so it is asserted directly rather than inferred from the hold: no
    // winner was paid, no escrow was released, the scratch was not even voided, and
    // the market is parked for a human.
    assert.deepStrictEqual(allFunds(v), before, `${what}: no money moved`);
    assert.strictEqual(sel(v, 'Blue').status, 'open', `${what}: the winner was not settled`);
    assert.strictEqual(sel(v, 'Red').status, 'open', `${what}: and the scratch was not voided either`);
    const m = v.db.prepare('SELECT status, settlement_hold h FROM markets WHERE id=?').get(v.m.id);
    assert.deepStrictEqual({ s: m.status, h: m.h }, { s: 'open', h: 1 }, `${what}: held for review`);
    assert.strictEqual(v.db.prepare('SELECT COUNT(*) n FROM settlements WHERE market_id=?').get(v.m.id).n, 0,
      `${what}: no settlement row`);

    // IT IS COUNTED AND READABLE, so the finding is a queue an operator works
    // through rather than a row somebody has to go and find.
    assert.strictEqual(D.rejectedCount(v.db), 1, `${what}: counted as rejected`);
    assert.strictEqual(D.declaredCount(v.db), 0);
    assert.strictEqual(D.undeclaredCount(v.db), 0, `${what}: and NOT counted as merely undeclared — the three answers stay different`);
    const rej = D.rejectedDeclarations(v.db);
    assert.strictEqual(rej.length, 1);
    assert.ok(JSON.parse(rej[0].deductions).rejects.length > 0, `${what}: the rejected figure is on the row`);
    assert.strictEqual(acc.assertConserved(v.db), 0);
    assert.deepStrictEqual(acc.assertUserAgrees(v.db), []);
    v.db.close();
  }

  // THE CONTROL. 100% exactly is IN range and is applied — so this is not a suite
  // that refuses anything with a big number in it. And the far boundary of the other
  // unit is in range too: `fraction: 1` is 100%, and `fraction: 1.2` is not.
  const ok = await venue();
  leg(ok, 'Blue');
  leg(ok, 'Red');
  const applied = R.applyOutcome(ok.db, ok.m.id, {
    status: 'completed', winners: [ok.ids.Blue], non_runners: [ok.ids.Red],
    deductions: [pct(ok.ids.Red, 100)],
  });
  assert.strictEqual(applied.outcome, 'settled', '100% is in range: it is the extreme a published table reaches');
  assert.strictEqual(D.declaredCount(ok.db), 1);
  assert.strictEqual(D.rejectedCount(ok.db), 0);
  // And the fraction unit is the same figure read the other way, which is the point
  // of the unit being declared rather than inferred.
  const frac = await venue();
  leg(frac, 'Blue');
  leg(frac, 'Red');
  R.applyOutcome(frac.db, frac.m.id, {
    status: 'completed', winners: [frac.ids.Blue], non_runners: [frac.ids.Red],
    deductions: [{ selection_id: frac.ids.Red, unit: 'fraction', value: 0.2 }],
  });
  assert.deepStrictEqual(wallet(frac, 'alice'), { b: 115600, f: 0 },
    'fraction 0.2 and percent 20 are the same 20%, and neither is guessed at');
  assert.strictEqual(D.declaredCount(frac.db), 1);
  // ...and the CONTROL on the ambiguity itself: the same two figures in the WRONG
  // units are refused, which is the whole reason the unit is required.
  assert.strictEqual(D.parse({ deductions: [{ selection_id: 1, unit: 'fraction', value: 20 }] }).state, D.REJECTED,
    '20 read as a fraction is out of range, not quietly 20%');
  assert.strictEqual(D.parse({ deductions: [{ selection_id: 1, unit: 'percent', value: 0.2 }] }).state, D.DECLARED,
    'and 0.2 read as a percent is a real 0.2%, which is in range and is applied as said');
  frac.db.close(); ok.db.close();
});

// ── D5: RE-DELIVERY APPLIES IT ONCE ───────────────────────────────────────────
// Two shapes, because a completed race leans on its terminal `settled` state and a
// pre-off withdrawal cannot — the market stays OPEN, so a re-delivered notice
// reaches the posting path again with the escrow already spent. `alreadyApplied` and
// the unique index on (source, source_event_id) are what stand between a repeating
// feed and a double deduction.
check('D5 a re-delivered withdrawal applies its deduction once', async () => {
  // (a) THE HARD SHAPE: a pre-off withdrawal, delivered twice, same event id.
  const v = await venue();
  leg(v, 'Red');
  const sig = () => ({
    non_runners: [v.ids.Red],
    deductions: [pct(v.ids.Red, 20, { declared_by: 'stewards' })],
  });
  const first = R.applyOutcome(v.db, v.m.id, sig(), { source: 'webhook', externalId: 'ded-1' });
  assert.strictEqual(first.outcome, 'withdrawn', 'the notice removes the runner and leaves the market open');
  assert.strictEqual(first.deduction.state, 'declared', 'and the declaration is on the result');
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 0 }, 'the scratch is refunded once');
  const after = allFunds(v);
  const rows = provenance(v).length;

  const again = R.applyOutcome(v.db, v.m.id, sig(), { source: 'webhook', externalId: 'ded-1' });
  assert.strictEqual(again.outcome, 'already_applied', 'the second delivery is recognised, not re-applied');
  assert.deepStrictEqual(allFunds(v), after, 'no money moved');
  assert.strictEqual(provenance(v).length, rows, 'no second provenance row');
  assert.strictEqual(D.overview(v.db).counts.recorded_before_the_off, 1, 'and one recorded declaration, not two');

  // A FRESH id for the same already-void runner is still a no-op on the money. The
  // declaration on it is recorded as a new fact (the feed really did say it again)
  // but nothing is refunded twice — the legs are gone.
  const third = R.applyOutcome(v.db, v.m.id, sig(), { source: 'webhook', externalId: 'ded-2' });
  assert.strictEqual(third.outcome, 'withdrawn');
  assert.deepStrictEqual(third.voided_selections, [], 'nothing left to remove');
  assert.deepStrictEqual(allFunds(v), after, 'and still no money moved');
  assert.strictEqual(acc.assertConserved(v.db), 0);

  // (b) THE SETTLEMENT SHAPE: a completed race with a deduction, delivered twice.
  const s = await venue();
  leg(s, 'Blue');
  leg(s, 'Red');
  const settle = () => ({
    status: 'completed', winners: [s.ids.Blue], non_runners: [s.ids.Red],
    deductions: [pct(s.ids.Red, 20)],
  });
  const settled = R.applyOutcome(s.db, s.m.id, settle(), { source: 'poll', externalId: 'res-1' });
  assert.strictEqual(settled.outcome, 'settled');
  assert.deepStrictEqual(wallet(s, 'alice'), { b: 115600, f: 0 }, 'one deduction, once');
  const settledAfter = allFunds(s);
  const twice = R.applyOutcome(s.db, s.m.id, settle(), { source: 'poll', externalId: 'res-1' });
  assert.strictEqual(twice.outcome, 'already_settled', 'a settled market is terminal');
  assert.deepStrictEqual(allFunds(s), settledAfter, 'and the second delivery moved nothing');
  assert.strictEqual(provenance(s).length, 1, 'one provenance row');
  assert.strictEqual(
    v.db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='settle'").get().n, 0,
    'and no second settle transaction anywhere'
  );
  assert.strictEqual(acc.assertConserved(s.db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(s.db), []);
  s.db.close(); v.db.close();
});

// ── D6: TWO RUNNERS WITHDRAWN AT ONCE ────────────────────────────────────────
// A real racing case, and the honest answer about what is supported: the venue
// SUMS the declared deductions onto the winner and does NOT re-base the odds after
// each scratching. Re-basing IS the scale — it is what "the scale is published per
// jurisdiction" means — so an operator whose jurisdiction re-bases declares the
// composed figure as one declaration, and this suite says so in its own assertions
// rather than leaving it in a comment.
check('D6 two runners withdrawn at once: both refunded, both deductions composed', async () => {
  const v = await venue();
  leg(v, 'Green'); // the winner
  leg(v, 'Red');   // scratched
  leg(v, 'Blue');  // scratched
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 30000 }, 'three legs at risk before anything happens');

  const r = R.applyOutcome(v.db, v.m.id, {
    status: 'completed',
    winners: [v.ids.Green],
    non_runners: [v.ids.Red, v.ids.Blue],
    // 10% against Red and 5% against Blue: 15% composed, because both claims are
    // charges on the runner that survived.
    deductions: [pct(v.ids.Red, 10, { declared_by: 'stewards' }), pct(v.ids.Blue, 5, { declared_by: 'stewards' })],
  });
  assert.strictEqual(r.outcome, 'settled');
  assert.deepStrictEqual(r.voided_selections.sort(), [v.ids.Red, v.ids.Blue].sort(), 'both scratches are removed');

  // 20000 dividend less 15% (3000) = 17000 paid; commission ceil(17000*0.025)=425.
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 116575, f: 0 }, 'the winner is charged the COMPOSED deduction');
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 83000, f: 0 }, 'and the layer keeps the rest');
  // The composition is on the record, both halves of it, so an operator can see the
  // venue added them up rather than picking one.
  const applied = JSON.parse(provenance(v)[0].deductions_json).applied;
  assert.strictEqual(applied.length, 1, 'one winning runner, so one applied figure');
  assert.strictEqual(applied[0].declared_bp, 1500, '10% + 5% = 1500 basis points');
  assert.strictEqual(applied[0].composed_from.length, 2, 'and both declarations are named');
  assert.deepStrictEqual(
    applied[0].composed_from.map((d) => [d.pct_bp, d.declared_by]),
    [[1000, 'stewards'], [500, 'stewards']],
    'each with its own figure and its own declarer'
  );
  assert.strictEqual(acc.assertConserved(v.db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(v.db), []);

  // THE CONTROL BESIDE IT. The same winner, the same stake, ONE runner withdrawn
  // and ONE declaration of 10%. If this came to the same figure as D6 above, the
  // composition would be a coincidence rather than a sum.
  const c = await venue();
  leg(c, 'Green');
  leg(c, 'Red');
  R.applyOutcome(c.db, c.m.id, {
    status: 'completed', winners: [c.ids.Green], non_runners: [c.ids.Red],
    deductions: [pct(c.ids.Red, 10)],
  });
  assert.deepStrictEqual(wallet(c, 'alice'), { b: 117550, f: 0 },
    'a single 10% declaration charges 2000, not the 3000 two declarations compose to');
  assert.strictEqual(JSON.parse(provenance(c)[0].deductions_json).applied[0].declared_bp, 1000);

  // ...and the stated limitation, asserted rather than documented: a declaration
  // that exceeds the whole dividend is capped and the cap is ON THE ROW, so the
  // composition an operator asked for and the composition they got are both
  // readable.
  const k = await venue();
  leg(k, 'Green');
  leg(k, 'Red');
  leg(k, 'Blue');
  R.applyOutcome(k.db, k.m.id, {
    status: 'completed', winners: [k.ids.Green], non_runners: [k.ids.Red, k.ids.Blue],
    deductions: [pct(k.ids.Red, 80), pct(k.ids.Blue, 80)],
  });
  const capped = JSON.parse(provenance(k)[0].deductions_json).applied[0];
  assert.strictEqual(capped.declared_bp, 10000, '160% composed');
  assert.strictEqual(capped.applied_bp, 10000, 'applied at the ceiling, which is the whole dividend');
  assert.strictEqual(capped.clamped, true, 'and the clamp is recorded rather than silent');
  assert.deepStrictEqual(wallet(k, 'alice'), { b: 100000, f: 0 }, 'nothing paid on the win beyond the stake returned');
  assert.strictEqual(acc.assertConserved(k.db), 0);
  k.db.close(); c.db.close(); v.db.close();
});

// ── D7: A DEDUCTION LARGER THAN THE PAYOUT IS CLAMPED, NOT REFUSED ───────────
// WA 4A scales the declared figure by the odds against each surviving runner, so a
// long-priced winner can come out above 100%. Two questions have to be answered and
// only one of them is a refusal: what happens to the payout (clamped) and what
// happens to the market (settled, because a hold here would park a race whose
// winner is known and whose losing backers have all lost).
check('D7 a deduction that would exceed the payout is CLAMPED to it, and recorded', async () => {
  const v = await venue('horse_racing', { prices: { Red: 5, Blue: 2, Green: 6 } });
  leg(v, 'Green');
  leg(v, 'Red');
  // Red (5.0) is scratched; Blue at 2.0 is the shortest survivor and is the
  // reference; Green at 6.0 wins. A declared 60% scales to 60% x 6/2 = 180%.
  const r = R.applyOutcome(v.db, v.m.id, {
    status: 'completed', winners: [v.ids.Green], non_runners: [v.ids.Red],
    deductions: [pct(v.ids.Red, 60)],
  });
  assert.strictEqual(r.outcome, 'settled', 'NOT held: the race finished and a hold would park it for nobody');
  const applied = r.deductions.applied[0];
  assert.strictEqual(applied.declared_bp, 6000, '60% was declared');
  assert.strictEqual(applied.reference_price, 2, 'against the shortest surviving price');
  assert.strictEqual(applied.winner_price, 6, 'on a runner three times as long');
  assert.strictEqual(applied.applied_bp, 10000, '180% is clamped to the whole dividend');
  assert.strictEqual(applied.clamped, true, 'and the clamp is on the provenance row');

  // THE CLAMP, VISIBLY. The backer gets their stake back and NOTHING else: the
  // dividend is gone but the stake is not, so nobody is charged for winning and
  // nobody's collateral is eaten. This is the arithmetic that answers "which, and
  // why" — a clamp at the payout, because a payout below zero would charge a
  // bettor who won and let a layer collect more than they staked.
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 0 }, 'stake whole, dividend gone');
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 100000, f: 0 }, 'and the layer owes nothing on the reduced dividend');
  assert.ok(!kindsOf(v, 'a').includes('commission'), 'no commission on a payout of zero');
  assert.strictEqual(acc.assertConserved(v.db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(v.db), []);

  // THE CONTROL BESIDE IT: the SAME market with a declared 20% is NOT clamped and
  // the backer is paid. Without this, "clamped" would be indistinguishable from
  // "everything is refused" and from "nothing is ever paid".
  const c = await venue('horse_racing', { prices: { Red: 5, Blue: 2, Green: 6 } });
  leg(c, 'Green');
  leg(c, 'Red');
  const ok = R.applyOutcome(c.db, c.m.id, {
    status: 'completed', winners: [c.ids.Green], non_runners: [c.ids.Red],
    deductions: [pct(c.ids.Red, 20)],
  });
  assert.strictEqual(ok.outcome, 'settled');
  const okApplied = ok.deductions.applied[0];
  assert.strictEqual(okApplied.applied_bp, 6000, '20% x 6/2 = 60%, in range and unclamped');
  assert.strictEqual(okApplied.clamped, false);
  // 20000 less 60% = 8000 paid; commission ceil(8000 * 0.025) = 200.
  assert.deepStrictEqual(wallet(c, 'alice'), { b: 107800, f: 0 }, 'and the backer is paid the reduced dividend');
  c.db.close();
  v.db.close();
});

// ── D8: THE SCALE IS PROPORTIONAL TO THE ODDS, AND SAID SO WHEN IT CANNOT BE ──
// WA 4A applies the deduction to each remaining runner PROPORTIONAL TO THE ODDS
// AGAINST THAT RUNNER. Two runners surviving at the same price means both are the
// reference; one of them shorter than the other means the shorter one pays the
// declared figure and the longer one pays proportionally more.
//
// The fallback matters as much as the scale. A venue that has never run the drift
// tick has NULL prices, and a reference cannot be computed from nothing — so the
// declared figure is applied UNSCALED and that is COUNTED, because "we applied the
// flat figure because we had no prices" is an answer an operator needs and not one
// this module gets to decide quietly.
check('D8 the deduction scales with the odds of the runner that won, and says when it could not', async () => {
  // (a) The winner IS the reference: the declared figure applies exactly.
  const a = await venue('horse_racing', { prices: { Red: 5, Blue: 2, Green: 2 } });
  leg(a, 'Green');
  leg(a, 'Red');
  const ra = R.applyOutcome(a.db, a.m.id, {
    status: 'completed', winners: [a.ids.Green], non_runners: [a.ids.Red],
    deductions: [pct(a.ids.Red, 10)],
  });
  assert.strictEqual(ra.deductions.applied[0].winner_price, 2);
  assert.strictEqual(ra.deductions.applied[0].reference_price, 2, 'a joint-shortest survivor is its own reference');
  assert.strictEqual(ra.deductions.applied[0].applied_bp, 1000, 'so 10% is 10%');
  assert.deepStrictEqual(wallet(a, 'alice'), { b: 117550, f: 0 }, '20000 less 2000 = 18000, less 450 commission');

  // THE CONTROL BESIDE IT: the SAME declared 10%, the same stake, the same match
  // price, and a winner three times longer. If this came to the same payout, the
  // scale is not being applied at all.
  const b = await venue('horse_racing', { prices: { Red: 5, Blue: 2, Green: 6 } });
  leg(b, 'Green');
  leg(b, 'Red');
  const rb = R.applyOutcome(b.db, b.m.id, {
    status: 'completed', winners: [b.ids.Green], non_runners: [b.ids.Red],
    deductions: [pct(b.ids.Red, 10)],
  });
  assert.strictEqual(rb.deductions.applied[0].applied_bp, 3000, 'a runner 3x the reference pays 3x the deduction');
  assert.strictEqual(rb.deductions.applied[0].scaled, true);
  // 20000 less 6000 = 14000, less 350 commission.
  assert.deepStrictEqual(wallet(b, 'alice'), { b: 113650, f: 0 }, 'and is paid correspondingly less');
  assert.ok(wallet(b, 'alice').b < wallet(a, 'alice').b, 'the longer the winner, the smaller the dividend');

  // (b) NO PRICES AT ALL: the declared figure applies flat, and says so.
  const c = await venue('horse_racing', { prices: { Red: null, Blue: null, Green: null } });
  leg(c, 'Green');
  leg(c, 'Red');
  const rc = R.applyOutcome(c.db, c.m.id, {
    status: 'completed', winners: [c.ids.Green], non_runners: [c.ids.Red],
    deductions: [pct(c.ids.Red, 10)],
  });
  assert.strictEqual(rc.outcome, 'settled', 'a venue with no prices still applies the declared figure');
  const flat = rc.deductions.applied[0];
  assert.strictEqual(flat.scaled, false, 'and records that it could not scale it');
  assert.strictEqual(flat.reference_price, null, 'null rather than 0: "no price" is not "a price of zero"');
  assert.strictEqual(flat.applied_bp, 1000, 'the declared figure, unscaled');
  assert.deepStrictEqual(wallet(c, 'alice'), { b: 117550, f: 0 }, 'identical to the reference-priced case, which is the point');
  assert.strictEqual(D.overview(c.db).counts.applied_without_odds_scale, 1, 'and it is COUNTED, not merely noted');

  // THE CONTROL on the counter: a market that DID have prices reports zero unscaled
  // applications, so the counter measures something rather than always reading 1.
  assert.strictEqual(D.overview(a.db).counts.applied_without_odds_scale, 0, 'a priced market reports none');
  assert.strictEqual(D.overview(a.db).counts.declared, 1);

  for (const x of [a, b, c]) assert.strictEqual(acc.assertConserved(x.db), 0);
  a.db.close(); b.db.close(); c.db.close();
});

// ── D9: A DECLARATION FOR A RUNNER NOBODY WITHDREW IS REFUSED ────────────────
// A well-formed 27% aimed at a runner this outcome did not withdraw is not a
// malformed figure — it is a different question, and it is the question a feed is
// most likely to get wrong when it has one market's response shaped like another's.
// Applying it would take money out of a race where nothing was scratched.
check('D9 a deduction attached to the wrong race, or to no race, is refused and named', async () => {
  // (a) A withdrawal happened, but the deduction names a runner that did not.
  const v = await venue();
  leg(v, 'Blue');
  leg(v, 'Red');
  const before = allFunds(v);
  const r = R.applyOutcome(v.db, v.m.id, {
    status: 'completed', winners: [v.ids.Blue], non_runners: [v.ids.Red],
    deductions: [pct(v.ids.Green, 20)],
  });
  assert.strictEqual(r.outcome, 'held', 'not applied to a race where nothing was scratched');
  assert.strictEqual(r.deduction.rejects[0].code, D.R.NOT_FOR_A_WITHDRAWN_RUNNER);
  assert.match(r.reason, /did not withdraw/);
  assert.deepStrictEqual(allFunds(v), before, 'no money moved');
  assert.strictEqual(D.rejectedCount(v.db), 1);
  v.db.close();

  // (b) No withdrawal at all, so the deduction has nothing to attach to. Held under
  // its own rule rather than allowed to float through as an unrecognised signal,
  // because a hold whose reason says only "unrecognised" sends an operator looking
  // in the wrong place entirely.
  const c = await venue();
  leg(c, 'Blue');
  const beforeC = allFunds(c);
  const orphan = R.applyOutcome(c.db, c.m.id, {
    status: 'completed', winners: [c.ids.Blue],
    deductions: [pct(c.ids.Red, 20)],
  });
  assert.strictEqual(orphan.outcome, 'held');
  assert.strictEqual(orphan.rule, 'deduction_without_withdrawal');
  assert.match(orphan.reason, /withdrew no runner/);
  assert.match(orphan.reason, /nothing to attach to/);
  assert.strictEqual(orphan.deduction.rejects[0].code, D.R.WITHOUT_WITHDRAWAL, 'a named code, not just a message');
  assert.strictEqual(orphan.deduction.rejects[0].declarations.length, 1, 'and the refused figure is preserved');
  assert.deepStrictEqual(allFunds(c), beforeC, 'and the ordinary race settles nothing');
  assert.strictEqual(c.db.prepare('SELECT status FROM markets WHERE id=?').get(c.m.id).status, 'open');
  assert.strictEqual(D.undeclaredCount(c.db), 0, 'and is not counted as an undeclared withdrawal');
  assert.strictEqual(D.rejectedCount(c.db), 1);
  c.db.close();

  // THE CONTROL: the identical declaration, correctly attached, settles. Without
  // this, a check that refused everything would pass all of D9.
  const g = await venue();
  leg(g, 'Blue');
  leg(g, 'Red');
  const good = R.applyOutcome(g.db, g.m.id, {
    status: 'completed', winners: [g.ids.Blue], non_runners: [g.ids.Red],
    deductions: [pct(g.ids.Red, 20)],
  });
  assert.strictEqual(good.outcome, 'settled');
  assert.deepStrictEqual(wallet(g, 'alice'), { b: 115600, f: 0 });
  assert.strictEqual(D.rejectedCount(g.db), 0);
  g.db.close();
});

// ── D10: THE PLACE INTERACTION, STATED RATHER THAN GUESSED ────────────────────
// Most Australian racing bets are place or each-way. `markets.payout_shape` lets an
// operator declare a market a place market and this engine HOLDS it rather than
// computing a distribution it cannot. So on a racing launch the held path is the
// COMMON path, and a deduction feature that only works on win markets is barely a
// feature. Two things follow, and both are asserted here.
check('D10 a place market and a place-scoped deduction are refused, loudly, and nothing is priced', async () => {
  // (a) A PLACE-SCOPED deduction on a WIN market is refused as not applicable.
  // Published schedules carry separate win, place and each-way columns, so the
  // figures are not interchangeable — and dropping the figure silently would leave
  // the venue paying full with a steward-declared charge unread.
  const v = await venue();
  leg(v, 'Blue');
  leg(v, 'Red');
  const before = allFunds(v);
  const r = R.applyOutcome(v.db, v.m.id, {
    status: 'completed', winners: [v.ids.Blue], non_runners: [v.ids.Red],
    deductions: [{ selection_id: v.ids.Red, unit: 'percent', value: 45, scope: 'place' }],
  });
  assert.strictEqual(r.outcome, 'held', 'a place figure is not a win figure');
  assert.strictEqual(r.deduction.rejects[0].code, D.R.SCOPE_NOT_APPLICABLE);
  assert.match(r.reason, /separate win, place and each-way tables/);
  assert.deepStrictEqual(allFunds(v), before, 'nothing priced at all');
  v.db.close();

  // (b) A PLACE MARKET with a withdrawal is held by the engine's own single payout
  // shape, whatever the deduction says — and the hold is the PLACE one, because two
  // refusals for one market would give an operator two rows to reconcile for one
  // outcome.
  const p = await venue('horse_racing', { payout_shape: 'place' });
  leg(p, 'Blue');
  leg(p, 'Red');
  const beforeP = allFunds(p);
  const held = R.applyOutcome(p.db, p.m.id, {
    status: 'completed', winners: [p.ids.Blue], non_runners: [p.ids.Red],
    deductions: [pct(p.ids.Red, 20)],
  });
  assert.strictEqual(held.outcome, 'held');
  assert.match(held.reason, /place market cannot be settled with a withdrawal/);
  assert.deepStrictEqual(allFunds(p), beforeP, 'and no place payout was invented');
  assert.strictEqual(sel(p, 'Red').status, 'open', 'not even the scratch is applied');

  // THE CONTROL: the SAME venue, the same feed, the same withdrawal and the same
  // declaration on a WIN market settles with the deduction applied. That is the
  // entire extent of what this venue can do with a racing settlement, and this
  // assertion is what makes the refusals above honest rather than simply inert.
  const g = await venue('horse_racing');
  leg(g, 'Blue');
  leg(g, 'Red');
  const good = R.applyOutcome(g.db, g.m.id, {
    status: 'completed', winners: [g.ids.Blue], non_runners: [g.ids.Red],
    deductions: [pct(g.ids.Red, 20)],
  });
  assert.strictEqual(good.outcome, 'settled');
  assert.deepStrictEqual(wallet(g, 'alice'), { b: 115600, f: 0 });
  g.db.close(); p.db.close();
});

// ── D11: THE PRIMITIVE REFUSES TOO, SO A NEW CALLER INHERITS THE PROTECTION ───
// Everything above validates at the SEAM in lib/results.js, where the operator is
// still looking at the signal. If that were the only check, a second caller — a
// backfill, an admin route, another feed — would land a raw figure straight on the
// payout path, and the shape of this defect is that it balances either way.
check('D11 settleMarket refuses a malformed deduction itself, having moved nothing', async () => {
  const v = await venue();
  leg(v, 'Blue');
  const before = allFunds(v);
  const bad = [
    ['a bare number', 20, /list of declarations/],
    ['an undeclared unit', [{ selection_id: v.ids.Blue, unit: 'cents', pct_bp: 2000, scope: 'win' }], /unit drawn from/],
    ['a figure outside basis points', [{ selection_id: v.ids.Blue, unit: 'percent', pct_bp: 20000, scope: 'win' }], /basis points/],
    ['a coerced runner id', [{ selection_id: true, unit: 'percent', pct_bp: 2000, scope: 'win' }], /positive integer/],
    ['an unknown scope', [{ selection_id: v.ids.Blue, unit: 'percent', pct_bp: 2000, scope: 'eachway' }], /scope drawn from/],
  ];
  for (const [what, deductions, message] of bad) {
    assert.throws(() => S.settleMarket(v.db, v.m.id, { winner_selection_id: v.ids.Blue, deductions }),
      (e) => e.status === 400 && message.test(e.message), what);
    assert.deepStrictEqual(allFunds(v), before, `${what}: nothing moved`);
    assert.strictEqual(v.db.prepare('SELECT status FROM markets WHERE id=?').get(v.m.id).status, 'open',
      `${what}: the market is untouched`);
    assert.strictEqual(acc.assertConserved(v.db), 0);
  }
  // A deduction on a market being VOIDED is a contradiction, not a no-op: a void
  // refunds every stake, so there are no winnings for it to apply to, and ignoring
  // it would leave a row claiming a deduction that never happened.
  assert.throws(() => S.settleMarket(v.db, v.m.id, { void: true, deductions: [{ selection_id: v.ids.Blue, unit: 'percent', pct_bp: 2000, scope: 'win' }] }),
    (e) => e.status === 400 && /not both meaningful/.test(e.message), 'a void and a deduction are not both meaningful');

  // THE CONTROL: the same call with a well-formed declaration settles. Without this
  // the primitive that refused everything would pass.
  const ok = S.settleMarket(v.db, v.m.id, {
    winner_selection_id: v.ids.Blue,
    deductions: [{ selection_id: v.ids.Blue, unit: 'percent', pct_bp: 2000, scope: 'win' }],
  });
  assert.strictEqual(ok.market.status, 'settled');
  assert.strictEqual(ok.deductions.applied[0].applied_bp, 2000, 'and reports what it applied');
  assert.strictEqual(acc.assertConserved(v.db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(v.db), []);
  v.db.close();
});

// ── D12: A DEAD HEAT WITH A DEDUCTION — THE COMBINATION, NOT THE KEY ──────────
//
// STATE.md §5.6: reach tests the KEY and the defect is in the COMBINATION. That
// is not a lesson about this repository's rule table; it is about every shape this
// feature meets, and a dead heat is the one where the arithmetic forks twice —
// `share` is already divided among the joint winners BEFORE the deduction sees it,
// and the winner set arrives as an ARRAY rather than an id.
//
// It is worth pinning because the first version of `resolveFor` read its winner
// argument as an array only, so on every single-winner settlement it produced an
// EMPTY winner set and every declared deduction was applied to nobody — while the
// market settled, the provenance row recorded the declared figure, and the books
// balanced. A dead heat would have passed that version and a win would not.
check('D12 a dead heat with a declared deduction: each joint winner is charged its own share', async () => {
  const v = await venue();
  // Explicit sides rather than the `leg` helper, which always uses alice and bob —
  // and a dead heat where ONE backer held both joint winners would not test that
  // each winner is charged independently.
  backs(v, 'a', 'Blue'); lays(v, 'b', 'Blue');
  backs(v, 'c', 'Green'); lays(v, 'd', 'Green');
  leg(v, 'Red');
  // Two 10000-at-3.0 legs on the joint winners: a 20000 liability divided two ways
  // is a 10000 dividend each, and a 20% deduction takes 2000 off each.
  const r = R.applyOutcome(v.db, v.m.id, {
    status: 'completed', dead_heat: true, winners: [v.ids.Blue, v.ids.Green],
    non_runners: [v.ids.Red],
    deductions: [pct(v.ids.Red, 20)],
  });
  assert.strictEqual(r.outcome, 'settled', 'the dead heat still settles');
  assert.strictEqual(r.rule, 'dead_heat', 'under the dead-heat rule, with the withdrawal riding along');
  assert.deepStrictEqual(r.deductions.applied.map((a) => a.applied_bp), [2000, 2000],
    'BOTH joint winners carry the scale — an array winner set must not silently produce one of them');
  // 10000 dividend less 2000 = 8000 paid; commission ceil(8000 * 0.025) = 200.
  // alice also backed Red, whose refund moves no balance at all — which is the
  // point of a refund being a refund, and why her figure is the same as carol's
  // despite carrying two legs.
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 107800, f: 0 }, 'the first joint backer is charged on its share');
  assert.deepStrictEqual(wallet(v, 'carol'), { b: 107800, f: 0 }, 'and so is the second, identically');
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 92000, f: 0 }, 'each layer keeps the rest of its liability');
  assert.deepStrictEqual(wallet(v, 'dave'), { b: 92000, f: 0 });
  assert.strictEqual(acc.assertConserved(v.db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(v.db), []);

  // THE CONTROL BESIDE IT: the identical dead heat with NO declaration pays the
  // full 10000 dividend each. Without it, "charged its own share" would also be
  // true of a venue that paid 8000 regardless.
  const c = await venue();
  backs(c, 'a', 'Blue'); lays(c, 'b', 'Blue');
  backs(c, 'c', 'Green'); lays(c, 'd', 'Green');
  leg(c, 'Red');
  R.applyOutcome(c.db, c.m.id, {
    status: 'completed', dead_heat: true, winners: [c.ids.Blue, c.ids.Green],
    non_runners: [c.ids.Red],
  });
  assert.deepStrictEqual(wallet(c, 'alice'), { b: 109750, f: 0 }, 'the undivided share is paid in full, less commission');
  assert.deepStrictEqual(wallet(c, 'carol'), { b: 109750, f: 0 });
  assert.strictEqual(D.undeclaredCount(c.db), 1, 'and the absence is counted exactly once for the market');
  assert.strictEqual(acc.assertConserved(c.db), 0);
  c.db.close();
  v.db.close();
});

// ── D13: A MANUAL RELEASE OF A RACE THAT HAD A WITHDRAWAL IS COUNTED ──────────
// The release route has no `deductions` parameter: a human settling a held race by
// hand is not a feed declaring a steward-declared figure. So the winners are paid in
// FULL there — which is the operator's call, made with a written reason that is on
// the audit row. What must not happen is that path being INVISIBLE to the count: a
// market held for the place reason and released by an operator is still a withdrawal
// settlement at full payout, and `undeclaredCount` exists to report exactly those.
check('D13 releasing a held withdrawal market by hand is recorded as an undeclared deduction', async () => {
  const v = await venue();
  backs(v, 'a', 'Blue'); lays(v, 'b', 'Blue');
  leg(v, 'Red');
  // The pre-off withdrawal: Red leaves the book and its backers are refunded. The
  // race then goes to a hold, which is the ordinary racing shape — a dispute, or a
  // place market the engine will not price.
  const withdrawn = R.applyOutcome(v.db, v.m.id, { non_runners: [v.ids.Red] });
  assert.strictEqual(withdrawn.outcome, 'withdrawn');
  const held = R.applyOutcome(v.db, v.m.id, { status: 'completed', winners: [v.ids.Blue], disputed: true });
  assert.strictEqual(held.outcome, 'held', 'and the disputed result parks it for a human');
  assert.strictEqual(D.undeclaredCount(v.db), 0, 'a market nobody settled is not an overpayment');
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 10000 }, 'Red refunded, Blue still at risk');

  const released = R.releaseHold(v.db, {
    actor: { id: 1, role: 'admin' },
    marketId: v.m.id,
    decision: 'settle',
    winnerSelectionId: v.ids.Blue,
    reason: 'Dispute resolved with the feed; winner confirmed with the stewards',
  });
  assert.strictEqual(released.market.status, 'settled', 'an operator can still resolve it, with a written reason');
  // Paid IN FULL, because nothing was declared on this route — and said so. Red is
  // still a REFUND rather than a loser, so alice's net is the whole dividend.
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 119500, f: 0 }, 'the released winner is paid the full dividend');
  assert.strictEqual(D.undeclaredCount(v.db), 1, 'and the absence is COUNTED, not lost to the manual path');
  const row = provenance(v).pop();
  assert.strictEqual(row.rule, 'manual_release');
  assert.strictEqual(row.deduction_state, 'undeclared', 'recorded beside the human reason that authorised it');
  assert.strictEqual(acc.assertConserved(v.db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(v.db), []);

  // THE CONTROL BESIDE IT: releasing an ORDINARY held market — no withdrawal in it
  // — records no deduction state at all, so the count does not accumulate noise
  // from every manual settlement an operator has ever made.
  const c = await venue();
  backs(c, 'a', 'Blue'); lays(c, 'b', 'Blue');
  R.applyOutcome(c.db, c.m.id, { status: 'completed', winners: [c.ids.Blue], disputed: true });
  R.releaseHold(c.db, {
    actor: { id: 1, role: 'admin' }, marketId: c.m.id, decision: 'settle',
    winnerSelectionId: c.ids.Blue, reason: 'Dispute resolved, winner confirmed with the feed',
  });
  assert.strictEqual(provenance(c).pop().deduction_state, null, 'no withdrawal means no deduction question');
  assert.strictEqual(D.undeclaredCount(c.db), 0);
  assert.strictEqual(acc.assertConserved(c.db), 0);
  c.db.close();
  v.db.close();
});

(async () => {
  // Drain the collected checks IN ORDER, awaiting each. A check that rejects is a
  // failure of this suite, not of the next file: exiting here stops the rest of
  // this suite running rather than letting a broken assertion print a green line
  // for a body that never completed.
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
  console.log(`\ndeductions.test.js: ${passed} checks passed`);
})();