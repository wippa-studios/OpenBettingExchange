// nonrunner.test.js — a DECLARED NON-RUNNER (#88): the money path.
//
// Run: node tests/nonrunner.test.js   (plain assert, no deps)
//
// THE DEFECT THIS REPRODUCES. A race completes with one runner declared a
// non-runner before the off. `applyOutcome` settled the market as an ordinary
// clean finish: the withdrawn runner's backers were charged their full stake as
// though their horse had run and lost, and the selection stayed `open` — still
// quoted in the ladder, still priced into the positions P&L matrix. The books
// balanced the whole time. The money went somewhere real; it just went to the
// wrong person, and conservation cannot see that.
//
// TWO CAUSES, ONE ROOT. `ruleKey` consulted `non_runners` only under
// `status === 'abandoned'`, so `non_runner: VOID` was unreachable for the only
// case it exists to handle — and the only reason it was reachable at all was an
// abandoned race, which is already refunded by `abandoned_other`. And there was
// no per-selection void in the venue at all: the single
// `UPDATE selections SET status='void'` is scoped to a whole market.
//
// WHY CONSERVATION IS NOT THE ASSERTION HERE. It cannot be: this defect keeps
// every financial invariant green by construction, which is the same blind spot
// as the `greyhounds`/`greyhound` slug mismatch in docs/ROADMAP.md §6.8. So the
// assertions are about WHO WAS PAID and WHO WAS REFUNDED, plus one explicit
// conservation check to prove the refund did not become a transfer.
//
// Every check asserts the PRE-STATE FIRST: the stake is committed and the
// selection is `open` before the action, so a run where the code did nothing
// cannot pass.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';
process.env.CASHOUT_ENABLED = 'true';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const R = require('../lib/results');
const S = require('../lib/settle');
const VR = require('../lib/voidrules');
const C = require('../lib/cashout');
const acc = require('../lib/accounts');
const audit = require('../lib/audit');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this file
// rather than run eagerly - an eager runner would report a passing check whose
// promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

let n = 0;
// A racing venue: one event, one WINNER market, three runners. `sport` is a
// parameter so the same fixture can prove that a sport with no withdrawal rule
// is untouched (a control, and the honest gate on `non_runners`).
async function venue(sport = 'horse_racing', { payout_shape = null } = {}) {
  // ensureBot() is synchronous (it runs inside transactions in lib/settle.js and
  // lib/cashoutrisk.js) and so cannot derive the house password hash itself.
  // This venue is hand-built rather than seeded, so prime it explicitly.
  await require('../lib/bots').primeBotHash();
  const db = openStore(':memory:');
  db.prepare('INSERT INTO sports (name, slug) VALUES (?, ?)').run(sport, sport);
  const sp = db.prepare('SELECT id FROM sports WHERE slug=?').get(sport);
  n++;
  db.prepare("INSERT INTO events (sport_id,name,starts_at,status) VALUES (?, ?, datetime('now','+2 hours'), 'live')").run(sp.id, `Race ${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name=?').get(`Race ${n}`);
  if (payout_shape) {
    db.prepare("INSERT INTO markets (event_id,name,payout_shape) VALUES (?, 'To Be Placed', ?)").run(ev.id, payout_shape);
  } else {
    db.prepare("INSERT INTO markets (event_id,name) VALUES (?, 'Winner')").run(ev.id);
  }
  const m = db.prepare('SELECT * FROM markets WHERE event_id=? ORDER BY id DESC').get(ev.id);
  const ids = {};
  for (const nm of ['Red', 'Blue', 'Green']) {
    db.prepare('INSERT INTO selections (market_id,name,fair_price) VALUES (?, ?, 3.0)').run(m.id, nm);
    ids[nm] = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(m.id, nm).id;
  }
  const mk = async (u) => A.registerUser(db, { username: u, password: `pw-${u}-1234`, balance_cents: 100000 });
  return {
    db, m, ids,
    a: (await mk('alice')), b: (await mk('bob')), c: (await mk('carol')), d: (await mk('dave')),
  };
}

// A plain object, not the row: node:sqlite returns null-prototype objects and
// deepStrictEqual compares prototypes, so asserting a row against a literal
// fails on the prototype rather than on the numbers.
const wallet = (v, who) => {
  const r = v.db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE username=?').get(who);
  return { b: r.b, f: r.f };
};
const sel = (v, name) => v.db.prepare('SELECT status FROM selections WHERE id=?').get(v.ids[name]);
const orderOn = (v, name, who) =>
  v.db.prepare("SELECT o.id, o.status, o.frozen_cents FROM orders o JOIN users u ON u.id=o.user_id WHERE o.market_id=? AND o.selection_id=? AND u.username=? ORDER BY o.id")
    .all(v.m.id, v.ids[name], who);
const bets = (v, who, name, stake = 10000, price = 3.0) =>
  M.placeOrder(v.db, v[who], { selection_id: v.ids[name], side: 'back', price, stake_cents: stake });
const lays = (v, who, name, stake = 10000, price = 3.0) =>
  M.placeOrder(v.db, v[who], { selection_id: v.ids[name], side: 'lay', price, stake_cents: stake });
// The HOUSE as a counterparty. The issue's own reproduction is a bettor backing
// the withdrawn runner against the house laying it, so the suite runs that shape
// rather than two players, and the house paying no commission to itself keeps
// the "only the commission left the players" assertion readable.
const houseLay = (v, name, stake = 10000, price = 3.0) =>
  M.placeOrder(v.db, require('../lib/bots').ensureBot(v.db), {
    selection_id: v.ids[name], side: 'lay', price, stake_cents: stake,
  });
const house = (v) => v.db.prepare('SELECT id, balance_cents b FROM users WHERE is_bot=1').get();
// Every balance in the venue, players and house together. This is the number
// that proves a REFUND rather than a transfer: after a withdrawal it must be
// unchanged, because a backer's stake came back to the backer and nobody else's
// did.
const allFunds = (v) => {
  const r = v.db.prepare('SELECT SUM(balance_cents) t, SUM(frozen_cents) f FROM users').get();
  return { t: r.t, f: r.f };
};

// ── N1: THE ISSUE'S REPRO, END TO END ────────────────────────────────────────
// One withdrawal, four exposures, one of them somebody else's money:
//   Red   — alice backs 10000 @3.0, bob lays it          (the withdrawn runner)
//   Red   — dave backs 7000 @5.0, resting and unmatched  (escrow to release)
//   Blue  — carol backs 10000 @3.0, the HOUSE lays it    (the winner, settles)
//   Green — dave backs 5000 @2.0, resting and unmatched  (unrelated, untouched)
check('N1 a declared non-runner is refunded and removed; the rest of the market settles', async () => {
  const v = (await venue());
  bets(v, 'a', 'Red');                       // alice backs Red
  lays(v, 'b', 'Red');                       // bob lays Red
  bets(v, 'd', 'Red', 7000, 5.0);            // dave rests a back on Red, unmatched
  bets(v, 'd', 'Green', 5000, 2.0);          // dave rests a back on Green, unmatched
  bets(v, 'c', 'Blue');                      // carol backs the winner
  houseLay(v, 'Blue');                       // the house lays it

  // ── PRE-STATE. A run where the code did nothing must fail below.
  //
  // THE ESCROW MODEL, so the numbers mean what they look like: `balance_cents`
  // is TOTAL funds and `frozen_cents` is the part of them committed to an
  // order, so placing a stake does not debit the balance — it moves money from
  // `available` into `frozen`. A stake only leaves the balance when it is LOST,
  // which is exactly what the bug did: a bettor charged 10000 on a runner that
  // never raced. So the refund is observable as frozen returning to zero, as a
  // `refund` transaction rather than a `settle` one, and as the balance ending
  // where it started instead of 10000 lighter.
  assert.strictEqual(sel(v, 'Red').status, 'open', 'the withdrawn runner starts life as a live outcome');
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 10000 }, 'alice has Red at risk: 10000 frozen');
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 100000, f: 20000 }, 'bob has Red at risk as the layer: a 10000 lay at 3.0 is a 20000 liability');
  assert.deepStrictEqual(wallet(v, 'dave'), { b: 100000, f: 12000 }, 'dave has 7000 + 5000 resting, unmatched');
  assert.deepStrictEqual(wallet(v, 'carol'), { b: 100000, f: 10000 }, 'carol has Blue at risk');
  const orders = v.db.prepare("SELECT COUNT(*) n FROM orders WHERE status='open'").get().n;
  assert.strictEqual(orders, 2, 'two resting orders, both unmatched');
  const fundsBefore = allFunds(v);
  assert.notStrictEqual(fundsBefore.f, 0, 'and escrow is genuinely committed before the outcome arrives');

  // The race completes; Blue wins; Red was declared a non-runner before the off.
  const r = R.applyOutcome(v.db, v.m.id, { status: 'completed', winners: [v.ids.Blue], non_runners: [v.ids.Red] });

  assert.strictEqual(r.outcome, 'settled', 'the market settles on the runner that ran');
  assert.strictEqual(r.rule, 'non_runner', 'and the rule recorded is the withdrawal');
  assert.deepStrictEqual(r.voided_selections, [v.ids.Red], 'the withdrawn selection is reported');

  // THE SELECTION IS NOT LEFT 'open'. This is the second half of the issue's
  // defect: before, nothing recorded the non-runner at all, so the runner went
  // on being quoted as a live outcome.
  assert.strictEqual(sel(v, 'Red').status, 'void', "the withdrawn runner is not 'open'");

  // THE STAKE CAME BACK. Not "was not charged" — the stake was committed and
  // frozen before the outcome arrived, and it is released again with nothing
  // paid out and nothing taken: the same money, back in the same account. Before
  // the fix alice ended at 90000 with a `settle` row of -10000: her stake
  // transferred to bob as though Red had run and lost.
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 0 }, "alice's stake on the withdrawn runner is returned in full");
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 100000, f: 0 }, 'the layer is refunded his liability at the match price');

  // THE RESTING ORDER ON THE WITHDRAWN RUNNER IS CANCELLED AND UNFROZEN.
  assert.deepStrictEqual(wallet(v, 'dave'), { b: 100000, f: 0 }, "dave's unmatched stakes are released, not left frozen");
  for (const o of orderOn(v, 'Red', 'dave')) assert.strictEqual(o.status, 'cancelled', 'and the order on the withdrawn runner is cancelled');
  assert.strictEqual(
    v.db.prepare("SELECT COUNT(*) n FROM orders WHERE status='open' AND selection_id=?").get(v.ids.Red).n,
    0, 'no order on the withdrawn runner is left open'
  );

  // A REFUND, NOT A PAYOUT OR A TRANSFER: alice has no `settle` row (she won
  // nothing) and no loss, and her refund is visible as a refund.
  const kinds = v.db.prepare('SELECT type FROM transactions WHERE user_id=? ORDER BY id').all(v.a.id).map((x) => x.type);
  assert.ok(!kinds.includes('settle'), `alice was neither paid nor charged: ${kinds.join(',')}`);
  assert.ok(!kinds.includes('commission'), 'and pays no commission on money she got back');
  const refund = v.db.prepare("SELECT amount_cents a FROM transactions WHERE user_id=? AND type='refund' AND market_id=?").get(v.a.id, v.m.id);
  assert.ok(refund && refund.a === 10000, `her 10000 shows as a refund (${refund && refund.a})`);
  assert.strictEqual(
    v.db.prepare('SELECT COUNT(*) n FROM settlements WHERE user_id=?').get(v.a.id).n,
    0, 'and no settlement row: nothing was settled on a runner that never started'
  );

  // THE OTHER RUNNERS SETTLE NORMALLY. Blue won: carol is paid the 20000
  // liability less 2.5% commission and the house pays it.
  assert.deepStrictEqual(wallet(v, 'carol'), { b: 119500, f: 0 }, 'carol is paid the Blue liability: +20000 - 500 commission');
  assert.strictEqual(
    house(v).b, 100000000 - 20000, 'the house pays the liability and takes nothing for Red'
  );
  assert.strictEqual(
    v.db.prepare('SELECT COUNT(*) n FROM transactions WHERE type=? AND user_id=?').get('commission', house(v).id).n,
    0, 'and the venue does not charge itself a fee to be paid'
  );

  // CONSERVATION, EXPLICITLY. assertConserved is the ledger invariant; the funds
  // sum is the "refund, not a transfer" claim: exactly the commission left the
  // players, and the house is where it went. Nothing was moved to make the
  // withdrawn runner's stake whole — it came back to the bettor.
  assert.strictEqual(acc.assertConserved(v.db), 0, 'the ledger still balances');
  assert.deepStrictEqual(acc.assertUserAgrees(v.db), [], 'the balance cache agrees with the postings');
  const fundsAfter = allFunds(v);
  assert.strictEqual(fundsAfter.t, fundsBefore.t - 500, 'only the commission left the players: no stake was transferred anywhere');
  assert.strictEqual(fundsAfter.f, 0, 'and no escrow is left frozen');
  const market = v.db.prepare('SELECT status, winner_selection_id w FROM markets WHERE id=?').get(v.m.id);
  assert.deepStrictEqual({ status: market.status, w: market.w }, { status: 'settled', w: v.ids.Blue });
  v.db.close();
});

// ── N2: THE RECORD. A refund with no provenance is a refund nobody can defend
// in a dispute, which is the whole reason result_events exists.
check('N2 the withdrawal and the refund are both recorded', async () => {
  const v = (await venue());
  bets(v, 'a', 'Red'); lays(v, 'b', 'Red');
  R.applyOutcome(v.db, v.m.id, { status: 'completed', winners: [v.ids.Blue], non_runners: [v.ids.Red] }, { source: 'poll', externalId: 'feed-nr-1' });

  const src = v.db.prepare('SELECT * FROM result_events WHERE market_id=?').get(v.m.id);
  assert.ok(src, 'provenance written in the settlement transaction');
  assert.strictEqual(src.decision, 'settle', 'the market settled');
  assert.strictEqual(src.rule, 'non_runner', 'under the withdrawal rule');
  assert.strictEqual(src.source_event_id, 'feed-nr-1');
  assert.strictEqual(JSON.parse(src.payload).non_runners[0], v.ids.Red, 'and names which runner was withdrawn');

  // THE AUDIT ROW IS WRITTEN BY THE PRIMITIVE, INSIDE THE REFUND'S OWN
  // TRANSACTION — not by the caller, which is the only way "audited or it did
  // not happen" survives a new caller.
  const row = audit.list(v.db, { action: audit.ACTIONS.SELECTION_VOIDED });
  assert.strictEqual(row.length, 1, 'exactly one audit row for one withdrawal');
  assert.strictEqual(row[0].target, `market:${v.m.id}`);
  assert.strictEqual(row[0].actor_id, null, 'a feed withdrawal is a system action, and says so by having no actor');
  assert.strictEqual(row[0].before.selections[0].status, 'open', 'the before state is the live selection');
  assert.strictEqual(row[0].after.selections[0].status, 'void', 'and the after state is the removal');
  assert.strictEqual(row[0].after.refunded_cents, 30000, 'with the money that moved: alice 10000 of stake, bob 20000 of liability');
  assert.match(row[0].reason, /non-runner/i, 'and a written reason');
  v.db.close();
});

// ── N3: NO AUDIT ROW, NO REFUND. mustRecord throws inside the transaction, so
// an unwritable audit log rolls the refund back rather than committing an
// unrecorded transfer of a player's stake.
check('N3 a refund that cannot be audited does not happen', async () => {
  const v = (await venue());
  bets(v, 'a', 'Red'); lays(v, 'b', 'Red');
  const before = allFunds(v);
  // The audit table goes away. Nothing else about the venue changes, so this is
  // the ONLY reason the call can fail.
  v.db.exec('DROP TABLE audit_log');

  assert.throws(() => R.applyOutcome(v.db, v.m.id, { status: 'completed', winners: [v.ids.Blue], non_runners: [v.ids.Red] }),
    (e) => e.status === 500, 'the venue refuses rather than paying out unrecorded');

  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 10000 }, "alice's stake is still frozen and still hers: nothing moved");
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 100000, f: 20000 });
  assert.strictEqual(sel(v, 'Red').status, 'open', 'and the selection was not removed either');
  assert.strictEqual(v.db.prepare('SELECT status FROM markets WHERE id=?').get(v.m.id).status, 'open', 'the market is untouched');
  assert.deepStrictEqual(allFunds(v), before, 'the books are exactly as they were');
  assert.strictEqual(v.db.prepare('SELECT COUNT(*) n FROM result_events').get().n, 0, 'no provenance for a settlement that did not happen');
  assert.strictEqual(acc.assertConserved(v.db), 0);
  v.db.close();
});

// ── N4: A WITHDRAWAL BEFORE THE OFF. The market keeps trading; the runner
// leaves the book; its backers are refunded while the market is still open.
check('N4 a pre-off withdrawal removes the runner and leaves the market open', async () => {
  const v = (await venue());
  bets(v, 'a', 'Red'); lays(v, 'b', 'Red');
  bets(v, 'd', 'Red', 7000, 5.0);        // resting on the withdrawn runner
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 10000 });
  assert.deepStrictEqual(wallet(v, 'dave'), { b: 100000, f: 7000 });

  // No `status`: this is a withdrawal NOTICE, not a result. There was no
  // pre-off removal route at all before #88, so this signal used to do nothing.
  const r = R.applyOutcome(v.db, v.m.id, { non_runners: [v.ids.Red] }, { source: 'webhook', externalId: 'wd-1' });
  assert.strictEqual(r.outcome, 'withdrawn', `the runner is removed (${JSON.stringify(r)})`);
  assert.deepStrictEqual(r.voided_selections, [v.ids.Red]);
  assert.strictEqual(sel(v, 'Red').status, 'void');
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 0 }, 'the backer is refunded at the match price');
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 100000, f: 0 }, 'and so is the layer');
  assert.deepStrictEqual(wallet(v, 'dave'), { b: 100000, f: 0 }, 'the resting order is cancelled and released');

  // THE MARKET KEEPS TRADING. It is not settled, it is not held, and the runners
  // that are still in it still take orders — which is the whole difference
  // between a selection void and a market void.
  const m = v.db.prepare('SELECT status, settlement_hold FROM markets WHERE id=?').get(v.m.id);
  assert.deepStrictEqual({ s: m.status, h: m.settlement_hold }, { s: 'open', h: 0 }, 'still open, not held');
  assert.deepStrictEqual(allFunds(v), { t: 400000, f: 0 }, 'a refund: the total is exactly what it was, at frozen zero');
  bets(v, 'a', 'Blue'); lays(v, 'b', 'Blue');
  assert.strictEqual(v.db.prepare("SELECT COUNT(*) n FROM orders WHERE status='open'").get().n, 0, 'and the new orders matched each other');
  // And the removed runner cannot be bet on any more.
  assert.throws(() => bets(v, 'c', 'Red'), (e) => e.status === 409 && /not open/i.test(e.message),
    'a void selection refuses new orders');
  assert.strictEqual(acc.assertConserved(v.db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(v.db), []);
  v.db.close();
});

// ── N5: A FEED RE-DELIVERS. A withdrawal cannot lean on the market's terminal
// `settled` state to be idempotent, so it carries its own delivery check.
check('N5 a re-delivered withdrawal is a no-op', async () => {
  const v = (await venue());
  bets(v, 'a', 'Red'); lays(v, 'b', 'Red');
  R.applyOutcome(v.db, v.m.id, { non_runners: [v.ids.Red] }, { source: 'webhook', externalId: 'wd-2' });
  const after = allFunds(v);
  const refunds = v.db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='refund'").get().n;

  const again = R.applyOutcome(v.db, v.m.id, { non_runners: [v.ids.Red] }, { source: 'webhook', externalId: 'wd-2' });
  assert.strictEqual(again.outcome, 'already_applied', 'the second delivery is recognised');
  assert.deepStrictEqual(allFunds(v), after, 'and moves no money');
  assert.strictEqual(v.db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='refund'").get().n, refunds, 'no second refund');
  assert.strictEqual(v.db.prepare('SELECT COUNT(*) n FROM result_events').get().n, 1, 'and no second provenance row');
  assert.strictEqual(audit.list(v.db, { action: audit.ACTIONS.SELECTION_VOIDED }).length, 1, 'no second audit row');

  // A DIFFERENT notice for the same already-void runner is still a no-op rather
  // than an integrity error: the legs are gone, so there is nothing to refund
  // twice. This is the re-delivery a feed sends with a fresh id.
  const third = R.applyOutcome(v.db, v.m.id, { non_runners: [v.ids.Red] }, { source: 'webhook', externalId: 'wd-3' });
  assert.strictEqual(third.outcome, 'withdrawn');
  assert.deepStrictEqual(third.voided_selections, [], 'nothing left to remove');
  assert.deepStrictEqual(allFunds(v), after, 'and still no money moved');
  v.db.close();
});

// ── N6: THE CONTROL ON THE GATE. A sport whose rules do not define a withdrawn
// runner is not to have one applied: the venue holds rather than invent a rule
// or leave a player exposed.
check('N6 a withdrawal notice in a sport that does not model one is held', async () => {
  const v = (await venue('football'));
  bets(v, 'a', 'Red'); lays(v, 'b', 'Red');
  const before = allFunds(v);
  const r = R.applyOutcome(v.db, v.m.id, { non_runners: [v.ids.Red] });
  assert.strictEqual(r.outcome, 'held', 'held for a human, not applied');
  assert.strictEqual(r.rule, 'non_runner_unspecified');
  assert.match(r.reason, /football/);
  assert.strictEqual(sel(v, 'Red').status, 'open', 'nothing removed');
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 10000 }, "alice's stake is untouched — holding is not voiding");
  const m = v.db.prepare('SELECT status, settlement_hold FROM markets WHERE id=?').get(v.m.id);
  assert.deepStrictEqual({ s: m.status, h: m.settlement_hold }, { s: 'open', h: 1 }, 'and the market is flagged for review');
  assert.deepStrictEqual(allFunds(v), before);

  // THE CONTROL: a completed football match settles on its winner even with a
  // stray withdrawal list attached. The rules table is the authority on whether
  // the field means anything, and for football it does not.
  const f = (await venue('football'));
  bets(f, 'a', 'Red'); lays(f, 'b', 'Red');
  const done = R.applyOutcome(f.db, f.m.id, { status: 'completed', winners: [f.ids.Blue], non_runners: [f.ids.Red] });
  assert.strictEqual(done.outcome, 'settled', 'the ordinary football path is unchanged');
  assert.deepStrictEqual(done.voided_selections, []);
  assert.deepStrictEqual(wallet(f, 'alice'), { b: 90000, f: 0 }, 'and Red settles as an ordinary loser — as it always did in football');
  f.db.close();
  v.db.close();
});

// ── N7: A CONTRADICTORY SIGNAL IS REFUSED, not resolved by picking a half.
check('N7 an outcome that names a winner and the same runner as withdrawn is held', async () => {
  const v = (await venue());
  bets(v, 'a', 'Red'); lays(v, 'b', 'Red');
  const before = allFunds(v);
  const r = R.applyOutcome(v.db, v.m.id, { status: 'completed', winners: [v.ids.Red], non_runners: [v.ids.Red] });
  assert.strictEqual(r.outcome, 'held');
  assert.match(r.reason, /winner declared a non-runner/);
  assert.deepStrictEqual(allFunds(v), before, 'and no money moved');
  assert.strictEqual(v.db.prepare('SELECT status FROM markets WHERE id=?').get(v.m.id).status, 'open');

  // A withdrawn runner from ANOTHER market is the same class of mistake and is
  // refused the same way: the id is the instruction to move money. The other
  // selection must live in the SAME database — two separate `:memory:` fixtures
  // hand out the SAME ids, so a "foreign" id taken from a second venue is not
  // foreign at all and this assertion would silently prove nothing.
  const other = (await venue());
  const evId = other.db.prepare('SELECT event_id FROM markets WHERE id=?').get(other.m.id).event_id;
  other.db.prepare("INSERT INTO markets (event_id,name) VALUES (?, 'Somewhere Else')").run(evId);
  const otherMarket = other.db.prepare('SELECT id FROM markets WHERE event_id=? ORDER BY id DESC LIMIT 1').get(evId).id;
  other.db.prepare('INSERT INTO selections (market_id,name,fair_price) VALUES (?, ?, 3.0)').run(otherMarket, 'Elsewhere');
  const foreign = other.db.prepare('SELECT id FROM selections WHERE market_id=?').get(otherMarket).id;
  assert.notStrictEqual(foreign, other.ids.Red, 'the fixture really does hold a foreign selection id');
  bets(other, 'a', 'Red'); lays(other, 'b', 'Red');
  const cross = R.applyOutcome(other.db, other.m.id, { status: 'completed', winners: [other.ids.Blue], non_runners: [foreign] });
  assert.strictEqual(cross.outcome, 'held', 'a foreign selection id cannot void through this market');
  assert.match(cross.reason, /withdrawn runner not in market/);
  assert.strictEqual(other.db.prepare('SELECT status FROM selections WHERE id=?').get(foreign).status, 'open', 'and the other market is untouched');
  assert.deepStrictEqual(allFunds(other), before, 'no money moved in either market');
  other.db.close();
  v.db.close();
});

// ── N8: PLACE MARKETS ARE REFUSED EXPLICITLY. A place payout depends on a
// finishing position and its distribution CHANGES when a runner is withdrawn,
// which this engine cannot compute. It has one payout shape and computes that
// one — so the honest answer is to say so, in a hold, with the reason recorded.
check('N8 a place market is held rather than settled with a withdrawal applied', async () => {
  const v = (await venue('horse_racing', { payout_shape: 'place' }));
  bets(v, 'a', 'Red'); lays(v, 'b', 'Red');
  const before = allFunds(v);
  const r = R.applyOutcome(v.db, v.m.id, { status: 'completed', winners: [v.ids.Blue], non_runners: [v.ids.Red] });
  assert.strictEqual(r.outcome, 'held', 'the venue refuses rather than computing a wrong place payout');
  assert.match(r.reason, /place market cannot be settled with a withdrawal/);
  assert.strictEqual(sel(v, 'Red').status, 'open', 'no selection removed');
  assert.deepStrictEqual(allFunds(v), before, 'no money moved');
  const m = v.db.prepare('SELECT status, settlement_hold FROM markets WHERE id=?').get(v.m.id);
  assert.deepStrictEqual({ s: m.status, h: m.settlement_hold }, { s: 'open', h: 1 }, 'parked for a human');
  const src = v.db.prepare('SELECT decision, rule FROM result_events WHERE market_id=?').get(v.m.id);
  assert.strictEqual(src.decision, 'hold', 'and the refusal is on the provenance row, not just in a log');
  // The refusal is specific to the withdrawal: a place market with a plain
  // result still settles, because this engine's single payout shape IS a win and
  // that is the shape the operator declared by calling it 'place'... which is
  // why the refusal has to be explicit. Recorded here so the gap is visible.
  const settled = R.releaseHold(v.db, {
    actor: { id: 1, role: 'admin' },
    marketId: v.m.id,
    decision: 'settle',
    winnerSelectionId: v.ids.Blue,
    reason: 'Reviewed the place rules manually with the provider',
  });
  assert.strictEqual(settled.market.status, 'settled', 'an operator can still resolve it by hand, with a written reason');
  v.db.close();
});

// ── N9: THE PRIMITIVE REFUSES BAD INPUT, AND SAYS SO WITHOUT MOVING MONEY.
// Every case here is one that would otherwise void a runner nobody named, refund
// a stranger's stake, or pay a second time.
check('N9 voidSelection refuses malformed, foreign and terminal calls', async () => {
  const v = (await venue());
  bets(v, 'a', 'Red'); lays(v, 'b', 'Red');
  // A REAL foreign selection, in the SAME database. A second `:memory:` fixture
  // hands out the same ids, so "another venue's runner 1" is this venue's runner
  // 1 — an assertion built that way passes against a primitive with no market
  // check at all, which is the same trap tests/deadheat.test.js (H6) records.
  const evId = v.db.prepare('SELECT event_id FROM markets WHERE id=?').get(v.m.id).event_id;
  v.db.prepare("INSERT INTO markets (event_id,name) VALUES (?, 'Somewhere Else')").run(evId);
  const sibling = v.db.prepare('SELECT id FROM markets WHERE event_id=? ORDER BY id DESC LIMIT 1').get(evId).id;
  v.db.prepare('INSERT INTO selections (market_id,name,fair_price) VALUES (?, ?, 3.0)').run(sibling, 'Elsewhere');
  const foreignId = v.db.prepare('SELECT id FROM selections WHERE market_id=?').get(sibling).id;
  assert.notStrictEqual(foreignId, v.ids.Red, 'the fixture really does hold a foreign selection id');
  const before = allFunds(v);
  const untouched = (what) => {
    assert.strictEqual(sel(v, 'Red').status, 'open', `${what}: nothing removed`);
    assert.deepStrictEqual(allFunds(v), before, `${what}: no money moved`);
    assert.strictEqual(v.db.prepare('SELECT status FROM markets WHERE id=?').get(v.m.id).status, 'open', `${what}: market untouched`);
    assert.strictEqual(audit.list(v.db, { action: audit.ACTIONS.SELECTION_VOIDED }).length, 0, `${what}: no audit row`);
  };
  // `Number(true) === 1`: a coerced id must never pick a runner.
  const bad = [
    [{ selection_ids: [true] }, (e) => e.status === 400 && /positive integers/i.test(e.message), 'coerced boolean id'],
    [{ selection_ids: [String(v.ids.Red)] }, (e) => e.status === 400, 'quoted id'],
    [{ selection_ids: [] }, (e) => e.status === 400, 'empty list'],
    [{ selection_ids: [[v.ids.Red]] }, (e) => e.status === 400, 'nested array'],
    [{ selection_ids: [v.ids.Red], reason: 'x' }, (e) => e.status === 400 && /reason/i.test(e.message), 'no written reason'],
    [{ selection_ids: [v.ids.Red], reason: '   ' }, (e) => e.status === 400, 'a blank reason is no reason'],
    [{ selection_ids: [foreignId], reason: 'runner pulled by the steward' }, (e) => e.status === 400 && /not in this market/i.test(e.message), 'a selection from another market'],
  ];
  for (const [opts, is, what] of bad) {
    assert.throws(() => S.voidSelection(v.db, v.m.id, opts.selection_ids, { reason: opts.reason }), is, what);
    untouched(what);
  }
  // Not an array at all.
  assert.throws(() => S.voidSelection(v.db, v.m.id, v.ids.Red, { reason: 'runner pulled by the steward' }),
    (e) => e.status === 400 && /at least one selection id/i.test(e.message), 'a bare id is not a list');
  untouched('a bare id');
  // An unknown market.
  assert.throws(() => S.voidSelection(v.db, 999999, [v.ids.Red], { reason: 'runner pulled by the steward' }),
    (e) => e.status === 404, 'unknown market');
  // A SETTLED market: its money has already moved and a winner has been paid.
  S.settleMarket(v.db, v.m.id, { winner_selection_id: v.ids.Green });
  assert.throws(() => S.voidSelection(v.db, v.m.id, [v.ids.Red], { reason: 'runner pulled by the steward' }),
    (e) => e.status === 409 && /already settled/i.test(e.message), 'a settled market is terminal');
  // A HELD market: a dispute a machine could not decide.
  const h = (await venue());
  bets(h, 'a', 'Red'); lays(h, 'b', 'Red');
  R.applyOutcome(h.db, h.m.id, { status: 'completed', winners: [h.ids.Blue], disputed: true });
  assert.throws(() => S.voidSelection(h.db, h.m.id, [h.ids.Red], { reason: 'runner pulled by the steward' }),
    (e) => e.status === 409 && /held/i.test(e.message), 'a held market is not voided from under the operator');
  assert.deepStrictEqual(wallet(h, 'alice'), { b: 100000, f: 10000 }, "and the held bettor's stake is untouched");

  // THE CONTROL: the same call with a real id and a real reason works, so a
  // primitive that refused everything would not pass this check.
  const c = (await venue());
  bets(c, 'a', 'Red'); lays(c, 'b', 'Red');
  const res = S.voidSelection(c.db, c.m.id, [c.ids.Red], { actor: { id: 1, role: 'admin' }, reason: 'StEWard withdrew Red before the off' });
  assert.deepStrictEqual(res.voided_selections, [c.ids.Red]);
  assert.strictEqual(res.refunded_cents, 30000, 'both sides of the matched leg refunded: 10000 of stake + 20000 of liability');
  assert.strictEqual(c.db.prepare('SELECT status FROM selections WHERE id=?').get(c.ids.Red).status, 'void');

  // IDEMPOTENT, and provably so: a second call reports the runner as already
  // void and moves nothing. The refunds are computed from matches, which are
  // still on the book, so without this the second call would try to release
  // escrow that is no longer there.
  const after = allFunds(c);
  const twice = S.voidSelection(c.db, c.m.id, [c.ids.Red], { reason: 'StEWard withdrew Red before the off' });
  assert.deepStrictEqual(twice.voided_selections, [], 'nothing left to void');
  assert.deepStrictEqual(twice.already_void, [c.ids.Red], 'and it says which runner was already gone');
  assert.deepStrictEqual(allFunds(c), after, 'no second refund');
  assert.strictEqual(c.db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='refund'").get().n, 2, 'the two original refunds, not four');
  h.db.close(); v.db.close(); c.db.close();
});

// ── N9b: A WITHDRAWAL FOLLOWED BY A MARKET VOID (#88's nastiest ordering).
// `markSettled` stamps `status = 'void'` onto EVERY selection when a market is
// voided, so by the time the legs are aggregated the selection column cannot say
// which runner a withdrawal had already refunded. Reading it that way either
// refunds the withdrawal's legs twice — which settleUser refuses as "releasing
// more than frozen", rolling back the entire market's payout — or, with the
// opposite mistake, refunds nothing at all and strands every backer's escrow.
//
// Both are silent in the sense that matters: the market reports settled. So the
// order is asserted here rather than left to the reader.
check('N9b a withdrawal followed by a market void refunds each leg exactly once', async () => {
  const v = (await venue());
  bets(v, 'a', 'Red'); lays(v, 'b', 'Red');   // Red: to be withdrawn, then voided with the market
  bets(v, 'a', 'Blue'); lays(v, 'b', 'Blue'); // Blue: ordinary, voided with the market
  const before = allFunds(v);
  assert.notStrictEqual(before.f, 0, 'both legs carry escrow before anything happens');

  // First: Red is withdrawn. Both of its counterparties are refunded; Blue's
  // legs are untouched and still frozen.
  S.voidSelection(v.db, v.m.id, [v.ids.Red], { reason: 'StEWard withdrew Red before the off' });
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 10000 }, 'Red refunded, Blue stake still at risk');
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 100000, f: 20000 }, 'and Blue liability (2.0 stake, 1.0 liability)');

  // Then: the whole market is abandoned. The Blue legs must be refunded too —
  // and Red's legs must NOT be refunded a second time.
  S.settleMarket(v.db, v.m.id, { void: true });

  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 0 }, 'every leg refunded once, nothing left frozen');
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 100000, f: 0 });
  assert.deepStrictEqual(allFunds(v), { t: before.t, f: 0 }, 'a refund, not a transfer — and not a double one');
  assert.strictEqual(
    v.db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='refund'").get().n,
    4, 'one refund per side per leg: Red and Blue, backer and layer'
  );
  assert.strictEqual(v.db.prepare('SELECT status FROM markets WHERE id=?').get(v.m.id).status, 'settled');
  assert.strictEqual(acc.assertConserved(v.db), 0, 'and the books balance');
  assert.deepStrictEqual(acc.assertUserAgrees(v.db), []);
  v.db.close();
});

// ── N10: THE POSITION THAT WAS REFUNDED IS NOT A POSITION. Cash-out buys a
// live position off a player; a runner that has been withdrawn and refunded is
// not one, and paying for it twice would be the same class of bug as settling
// a refunded match again.
check('N10 a refunded runner cannot be bought out again', async () => {
  const v = (await venue());
  bets(v, 'a', 'Red', 10000); lays(v, 'b', 'Red', 10000);
  // The position has to be worth something for a quote to be possible at all —
  // a position priced at exactly fair is declined, which is a different refusal
  // and would make the assertion below pass for the wrong reason.
  v.db.prepare('UPDATE selections SET fair_price = 1.5 WHERE id = ?').run(v.ids.Red);
  // With the position live, a quote is possible — the control that proves the
  // refusal below is about the withdrawal and not about this fixture.
  assert.ok(C.computeCashoutPlan(v.db, v.a, v.m.id), 'alice can be quoted while her Red position is live');
  S.voidSelection(v.db, v.m.id, [v.ids.Red], { reason: 'StEWard withdrew Red before the off' });
  assert.strictEqual(C.computeCashoutPlan(v.db, v.a, v.m.id), null, 'and cannot once it has been refunded');
  assert.throws(() => C.cashoutMarket(v.db, v.a, v.m.id), (e) => e.status === 409, 'execution refuses too');
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000, f: 0 }, 'and she has simply her stake back');
  assert.strictEqual(acc.assertConserved(v.db), 0);
  v.db.close();
});

// ── N11: THE HOUSE'S OWN POSITION IS REFUNDED TOO. A cash-out puts the venue
// on one side of the match, so a withdrawal has to release ITS collateral as
// well — and the desk's realised loss has to read as what it is (the venue paid
// for a position that was then cancelled) rather than as a phantom losing bet.
check('N11 a house takeover leg on a withdrawn runner is refunded, not settled', async () => {
  const v = (await venue());
  bets(v, 'a', 'Red', 10000); lays(v, 'b', 'Red', 10000);
  v.db.prepare('UPDATE selections SET fair_price = 1.5 WHERE id = ?').run(v.ids.Red);
  const quote = C.cashoutMarket(v.db, v.a, v.m.id);
  assert.ok(quote.payout_cents > 0, 'alice bought out, so the house took her side');
  const h = house(v);
  // PRE-STATE: the house is now on one side of a real match on Red, with real
  // escrow behind it. Without this, "the house holds no escrow afterwards" could
  // be true because it never had any.
  assert.ok(v.db.prepare('SELECT frozen_cents f FROM users WHERE id=?').get(h.id).f > 0,
    'the house is carrying the position it just took over');
  assert.deepStrictEqual(wallet(v, 'alice'), { b: 100000 + quote.payout_cents, f: 0 },
    'and the player has been paid and released');

  const r = R.applyOutcome(v.db, v.m.id, { status: 'completed', winners: [v.ids.Blue], non_runners: [v.ids.Red] });
  assert.strictEqual(r.outcome, 'settled', 'the market still settles on the runner that ran');

  // BOTH sides of the takeover match are made whole: the house's escrow on the
  // voided runner came back, and bob's counterparty liability with it. Neither
  // is left frozen — a stranded escrow is the failure a settlement integrity
  // error reports days later, on somebody else's market.
  assert.strictEqual(
    v.db.prepare('SELECT frozen_cents f FROM users WHERE id=?').get(h.id).f,
    0, 'the house holds no escrow on a runner that never ran'
  );
  assert.deepStrictEqual(wallet(v, 'bob'), { b: 100000, f: 0 }, 'and the counterparty is refunded, not left holding a voided leg');
  for (const u of ['alice', 'bob']) {
    assert.strictEqual(v.db.prepare('SELECT frozen_cents f FROM users WHERE username=?').get(u).f, 0, `${u} unfrozen`);
  }
  // THE DESK'S FIGURE. The house paid for a position that was then cancelled,
  // so it recovered nothing from it: proceeds 0 and the whole payout as a loss.
  // Reading the refunded leg as a losing leg instead would have reported a
  // liability the venue never owed.
  const q = v.db.prepare('SELECT proceeds_cents p, loss_cents l, settled_at s FROM cashout_quotes').get();
  assert.ok(q.s, 'the buyout resolved at settlement');
  assert.strictEqual(q.p, 0, 'the house recovered nothing from a refunded leg');
  assert.strictEqual(q.l, quote.payout_cents, 'so the loss is the whole payout — an honest figure');
  assert.strictEqual(acc.assertConserved(v.db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(v.db), []);
  v.db.close();
});

(async () => {
  // Drain the collected checks IN ORDER, awaiting each. A check that rejects is
  // a failure of this suite, not of the next file: exiting here stops the rest
  // of this suite running rather than letting a broken assertion print a green
  // line for a body that never completed.
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
  if (passed < 12) { console.error('expected 12 checks'); process.exit(1); }
  console.log(`\nnonrunner.test.js: ${passed} checks passed`);
})();