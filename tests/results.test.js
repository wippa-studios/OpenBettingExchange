// results.test.js — results feed, per-sport void rules, reconciliation job.
// Run: node tests/results.test.js   (plain assert, no deps)
//
// The property that matters most here is the one feeds usually get wrong: a
// DISPUTED outcome must be HELD, not settled and not voided. Settling picks a
// side the venue may be wrong about; voiding gives away money the venue may
// owe. Neither is recoverable after the fact.
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
const M = require('../lib/match');
const R = require('../lib/results');
const VR = require('../lib/voidrules');
const JOBS = require('../lib/jobs');
const acc = require('../lib/accounts');
const audit = require('../lib/audit');

// Some checks are async (the reconciler and the scheduler), so checks are
// COLLECTED and awaited in order — an eager runner would report a passing
// check whose promise later rejected.
const pending = [];
let passed = 0;
const check = (name, fn) => { pending.push([name, fn]); };

let n = 0;
function fixture(sport = 'football', fair = 2.0) {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES (?, ?)").run(sport, sport);
  const sp = db.prepare('SELECT id FROM sports WHERE slug=?').get(sport);
  n++;
  // 'live' so bets can be placed; the feed transitions it to 'completed'.
  db.prepare("INSERT INTO events (sport_id, name, starts_at, status) VALUES (?, ?, datetime('now','-2 hours'), 'live')")
    .run(sp.id, `Ev ${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Ev ${n}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  const ids = [];
  for (const nm of ['Alpha', 'Beta']) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(mkt.id, nm, fair);
    ids.push(db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, nm).id);
  }
  const alice = A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 });
  const bob = A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 });
  return { db, alice, bob, marketId: mkt.id, s1: ids[0], s2: ids[1] };
}

// bet: a matched position so settlement has something to do.
// The feed's precondition: the event has finished.
const completeEvent = (f) => f.db.prepare("UPDATE events SET status='completed' WHERE id=(SELECT event_id FROM markets WHERE id=?)").run(f.marketId);

const bet = (f) => {
  M.placeOrder(f.db, f.alice, { selection_id: f.s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(f.db, f.bob, { selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 10000 });
};
const status = (db, id) => db.prepare('SELECT status, settlement_hold, hold_reason FROM markets WHERE id=?').get(id);

// V1: the SAME physical fact is void under one sport and settled under another.
// That is why this is a rule table and not a boolean.
check('V1 abandoned after a red card is void in football but settles elsewhere', () => {
  const sig = { status: 'abandoned', red_card: true };
  assert.strictEqual(VR.resolve('football', sig).decision, VR.VOID);
  // No rule for a red card in greyhound racing -> HELD, not guessed. The slug
  // is the SEEDED one (plural); the table used to be keyed on the singular,
  // which meant every greyhound outcome hit the unknown-sport VOID default.
  const g = VR.resolve('greyhounds', sig);
  assert.strictEqual(g.decision, VR.HOLD, 'an unspecified case is held, not invented');
  // Abandoned WITHOUT a red card settles at the point of abandonment —
  // and needs a winner, because there is nothing to settle without one.
  assert.strictEqual(VR.resolve('football', { status: 'abandoned', winners: [1] }).decision, VR.SETTLE);
});

// V2: a rained-off race and a walkover void. Nobody ran / nobody competed.
check('V2 non-runners and walkovers void', () => {
  assert.strictEqual(VR.resolve('horse_racing', { status: 'abandoned', non_runners: [1] }).decision, VR.VOID);
  assert.strictEqual(VR.resolve('football', { status: 'walkover' }).decision, VR.VOID);
  assert.strictEqual(VR.resolve('tennis', { status: 'walkover' }).decision, VR.VOID);
});

// V3: a DISPUTE IS HELD, and it outranks every published rule. Settling picks
// a side; voiding gives away money the venue may owe.
check('V3 a disputed outcome is held, outranking the sport rules', () => {
  const d = VR.resolve('football', { status: 'completed', winners: [1], disputed: true });
  assert.strictEqual(d.decision, VR.HOLD);
  assert.strictEqual(d.rule, 'disputed');
  // Even a rule that would normally SETTLE yields to the dispute.
  assert.strictEqual(VR.resolve('tennis', { status: 'abandoned', disputed: true }).decision, VR.HOLD);
});

// V4: an unrecognised outcome is HELD. A feed that does not model a case must
// escalate, not default to void (giving money back without cause) or settle.
check('V4 an unrecognised signal is held, never guessed', () => {
  const r = VR.resolve('football', { status: 'something-new', winners: [1] });
  assert.strictEqual(r.decision, VR.HOLD);
  assert.strictEqual(r.rule, 'unrecognised');
});

// V5: a sport with NO rules defaults to VOID — bounded and recoverable — while
// a KNOWN signal with no outcome data is HELD.
check('V5 unknown sports default to void; missing winners hold', () => {
  const unknown = VR.resolve('curling', { status: 'completed', winners: [1] });
  assert.strictEqual(unknown.decision, VR.VOID);
  // A rule that settles but supplies no winner cannot be executed.
  const noWinner = VR.resolve('football', { status: 'abandoned' });
  assert.strictEqual(noWinner.decision, VR.HOLD);
  assert.strictEqual(noWinner.rule, 'abandoned_other_no_winner');
});

// R1: a normal completion settles the market and records PROVENANCE. A
// settlement with no source row is one nobody can defend in a dispute.
check('R1 a completed event settles with a recorded source', () => {
  const f = fixture();
  bet(f);
  const r = R.applyOutcome(f.db, f.marketId, { status: 'completed', winners: [f.s1] }, { source: 'poll', externalId: 'feed-1' });
  assert.strictEqual(r.outcome, 'settled');
  assert.strictEqual(status(f.db, f.marketId).status, 'settled');
  const src = f.db.prepare('SELECT * FROM result_events WHERE market_id=?').get(f.marketId);
  assert.ok(src, 'provenance written');
  assert.strictEqual(src.source, 'poll');
  assert.strictEqual(src.source_event_id, 'feed-1');
  assert.strictEqual(src.decision, 'settle');
  assert.strictEqual(acc.assertConserved(f.db), 0);
});

// R2: RE-DELIVERY IS IDEMPOTENT. A feed re-delivers; re-delivering must not
// pay twice or error out of the batch.
check('R2 re-delivering an outcome is idempotent', () => {
  const f = fixture();
  bet(f);
  R.applyOutcome(f.db, f.marketId, { status: 'completed', winners: [f.s1] }, { externalId: 'feed-x' });
  const after = f.db.prepare('SELECT balance_cents b, frozen_cents fr FROM users WHERE id=?').get(f.alice.id);
  const again = R.applyOutcome(f.db, f.marketId, { status: 'completed', winners: [f.s1] }, { externalId: 'feed-x' });
  assert.strictEqual(again.outcome, 'already_settled');
  const after2 = f.db.prepare('SELECT balance_cents b, frozen_cents fr FROM users WHERE id=?').get(f.alice.id);
  assert.strictEqual(after2.b, after.b, 'no second payout');
  assert.strictEqual(acc.assertConserved(f.db), 0);
});

// R3: a disputed outcome HOLDS the market — it stays OPEN (the player really
// does hold a position) but is excluded from automatic settlement.
check('R3 a disputed market is held open, not settled or voided', () => {
  const f = fixture();
  bet(f);
  const r = R.applyOutcome(f.db, f.marketId, { status: 'completed', winners: [f.s1], disputed: true });
  assert.strictEqual(r.outcome, 'held');
  const st = status(f.db, f.marketId);
  assert.strictEqual(st.status, 'open', 'still open');
  assert.strictEqual(st.settlement_hold, 1, 'flagged held');
  assert.ok(st.hold_reason, 'with a reason');
  // The player's collateral is untouched — holding is not voiding.
  assert.strictEqual(f.db.prepare('SELECT frozen_cents f FROM users WHERE id=?').get(f.alice.id).f, 10000);
});

// R4: a held market is excluded from the polling cycle, so the feed cannot
// settle it behind the operator's back on the next tick.
check('R4 held markets are excluded from the poll cycle', () => {
  const f = fixture();
  bet(f);
  R.applyOutcome(f.db, f.marketId, { status: 'completed', winners: [f.s1], disputed: true });
  completeEvent(f);
  const run = R.pollOnce(f.db, () => ({ [f.marketId]: { status: 'completed', winners: [f.s1] } }));
  assert.strictEqual(run.applied, 0, 'nothing applied');
  assert.strictEqual(status(f.db, f.marketId).status, 'open', 'and it is still held open');
});

// R5: releasing a hold is explicit and leaves an audit trail. The whole point
// of holding is that a machine could not decide it.
check('R5 releasing a hold requires a reason and is audited', () => {
  const f = fixture();
  bet(f);
  R.applyOutcome(f.db, f.marketId, { status: 'completed', winners: [f.s1], disputed: true });
  const ops = A.registerUser(f.db, { username: 'ops', password: 'pw-ops-1234', balance_cents: 0 });
  f.db.prepare("UPDATE users SET role='admin', is_admin=1 WHERE id=?").run(ops.id);

  assert.throws(() => R.releaseHold(f.db, { actor: ops, marketId: f.marketId, decision: 'settle', winnerSelectionId: f.s1, reason: '' }), /reason is required/);
  assert.throws(() => R.releaseHold(f.db, { actor: ops, marketId: f.marketId, decision: 'hold', reason: 'because' }), /settle or void/);

  R.releaseHold(f.db, { actor: ops, marketId: f.marketId, decision: 'settle', winnerSelectionId: f.s1, reason: 'Feed confirmed the result with the provider' });
  assert.strictEqual(status(f.db, f.marketId).status, 'settled');
  assert.strictEqual(status(f.db, f.marketId).settlement_hold, 0, 'hold cleared');
  const acts = audit.list(f.db, { limit: 50 }).map((r) => r.action);
  assert.ok(acts.includes(audit.ACTIONS.MARKET_SETTLED), 'audited');
  const src = f.db.prepare("SELECT * FROM result_events WHERE rule='manual_release'").get();
  assert.ok(src, 'provenance records the manual release');
  assert.strictEqual(src.source, 'manual');
  assert.strictEqual(acc.assertConserved(f.db), 0);
});

// R6: a winner from ANOTHER market is refused, not silently settled. Paying
// the wrong selection is worse than refusing.
check('R6 a winner outside the market is held, not settled', () => {
  const f = fixture();
  bet(f);
  const foreign = 99999;
  const r = R.applyOutcome(f.db, f.marketId, { status: 'completed', winners: [foreign] });
  assert.strictEqual(r.outcome, 'held');
  assert.ok(/winner not in market/.test(r.reason));
  assert.strictEqual(status(f.db, f.marketId).status, 'open');
});

// R7: multiple winners SETTLE AS A JOINT FAVOURITE. This test used to assert
// they were HELD, and that was correct at the time: the engine settled exactly
// one selection, so paying one winner would strand the other. It has the model
// now — a winner SET with the payout divided — and holding a dead heat forever
// is its own failure: the operator's only exit was to VOID, which pays nobody,
// underpaying the winners and overcharging their layers.
check('R7 multiple winners settle as a joint favourite, not a half-settlement', () => {
  const f = fixture();
  bet(f);
  const r = R.applyOutcome(f.db, f.marketId, { status: 'completed', winners: [f.s1, f.s2] });
  assert.strictEqual(r.outcome, 'settled', 'a dead heat settles');
  const m = f.db.prepare('SELECT dead_heat d, joint_winners j, winner_selection_id w FROM markets WHERE id = ?').get(f.marketId);
  assert.strictEqual(m.d, 1, 'recorded as a dead heat');
  assert.strictEqual(m.w, null, 'not a single-winner settlement');
  assert.deepStrictEqual(JSON.parse(m.j).sort((a, b) => a - b), [f.s1, f.s2].sort((a, b) => a - b));
  assert.strictEqual(acc.assertConserved(f.db), 0, 'and the books balance');
});

// R7b: a dead heat that names only ONE joint winner is not a dead heat — it is
// an ordinary finish, and halving a full payout would be a rules error. This
// uses a HORSE-RACING fixture, because the sport table is per sport and
// football has no dead_heat rule at all (so it holds for a different, also
// correct, reason — see R7c).
check('R7b a dead heat naming one winner is held, not halved', () => {
  const f = fixture('horse_racing', 4.0); // the SEEDED slug, underscored
  bet(f);
  const r = R.applyOutcome(f.db, f.marketId, { status: 'completed', dead_heat: true, winners: [f.s1] });
  assert.strictEqual(r.outcome, 'held');
  // Both underspecified-dead-heat guards (the rule table's, and the one in
  // applyOutcome for names filtered out as foreign) use the same wording, so
  // this one assertion covers both.
  assert.ok(/at least two joint winners/i.test(r.reason), `reason: ${r.reason}`);
  assert.strictEqual(status(f.db, f.marketId).status, 'open', 'the market is untouched');
  assert.strictEqual(acc.assertConserved(f.db), 0, 'and nothing moved');
});

// R7c: a dead heat in a sport with NO dead-heat rule is held, not settled on
// the sport's `completed` rule. The rule table is per sport for a reason: a
// football abandonment after a red card voids, a racing one settles.
check('R7c a dead heat in a sport without that rule is held', () => {
  const f = fixture('football');
  bet(f);
  const r = R.applyOutcome(f.db, f.marketId, { status: 'completed', dead_heat: true, winners: [f.s1, f.s2] });
  assert.strictEqual(r.outcome, 'held');
  assert.ok(/no rule for/i.test(r.reason), `reason: ${r.reason}`);
  assert.strictEqual(status(f.db, f.marketId).status, 'open');
});

// R8: a poll cycle settles what the feed reports and ignores what it does not.
check('R8 a poll cycle settles only markets the feed has outcomes for', () => {
  const f = fixture();
  bet(f);
  completeEvent(f);
  const run = R.pollOnce(f.db, () => ({ [f.marketId]: { status: 'completed', winners: [f.s2] } }));
  assert.strictEqual(run.applied, 1);
  assert.strictEqual(run.results[0].outcome, 'settled');
  // A market with no signal is untouched.
  const g = fixture();
  bet(g);
  const run2 = R.pollOnce(g.db, () => ({}));
  assert.strictEqual(run2.applied, 0);
  assert.strictEqual(status(g.db, g.marketId).status, 'open');
});

// J1: reconciliation on a HEALTHY book finds nothing and invents no findings.
check('J1 a healthy book reconciles clean', async () => {
  const f = fixture();
  bet(f);
  const r = await JOBS.reconcileOnce(f.db);
  assert.strictEqual(r.ok, true, 'no findings');
  assert.strictEqual(r.findings.length, 0);
  assert.strictEqual(r.open.length, 0);
});

// J2: drift becomes a FINDING that PERSISTS, is re-surfaced every run, and is
// only closed by a human with a reason. A discrepancy that vanishes when
// nobody looks is not a control.
check('J2 drift persists, re-surfaces, and closes only with a reason', async () => {
  const f = fixture();
  bet(f);
  // Corrupt the cache column directly: the postings stay right, the screen
  // goes wrong — exactly the failure the cache check exists to catch.
  f.db.prepare('UPDATE users SET balance_cents = balance_cents + 1234 WHERE id = ?').run(f.alice.id);

  const first = await JOBS.reconcileOnce(f.db);
  assert.strictEqual(first.ok, false, 'drift detected');
  assert.ok(first.findings.length >= 1);
  const scope = `user_balance:${f.alice.id}`;
  assert.ok(first.findings.some((x) => x.scope === scope), 'scoped to the user');

  // Second run: the SAME finding is updated, not duplicated.
  const second = await JOBS.reconcileOnce(f.db);
  const rows = f.db.prepare('SELECT * FROM reconciliation_findings WHERE scope = ? AND resolved_at IS NULL').all(scope);
  assert.strictEqual(rows.length, 1, 'one open finding, not a new one each run');
  assert.strictEqual(rows[0].seen_count, 2, 'but its occurrence count grows');
  assert.strictEqual(second.open.length >= 1, true, 'and it keeps surfacing');

  // Closing needs a human and a written reason.
  const ops = A.registerUser(f.db, { username: 'ops', password: 'pw-ops-1234', balance_cents: 0 });
  assert.throws(() => JOBS.resolveFinding(f.db, { actor: ops, id: rows[0].id, reason: '' }), /reason is required/);
  JOBS.resolveFinding(f.db, { actor: ops, id: rows[0].id, reason: 'Ledger rebuild verified against provider statement' });
  const closed = f.db.prepare('SELECT * FROM reconciliation_findings WHERE id=?').get(rows[0].id);
  assert.ok(closed.resolved_at, 'closed');
  assert.strictEqual(closed.resolved_by, ops.id);
  assert.strictEqual(closed.resolution, 'Ledger rebuild verified against provider statement');
  const acts = audit.list(f.db, { limit: 50 }).map((r) => r.action);
  assert.ok(acts.includes(audit.ACTIONS.FINDING_RESOLVED), 'resolution is audited');
});

// J3: global conservation drift outranks everything. If the ledger itself is
// corrupt, that is the finding an operator must see first.
check('J3 conservation drift is reported as a finding', async () => {
  const f = fixture();
  bet(f);
  // Write an UNBALANCED posting directly — the exact corruption the guard in
  // lib/accounts.js exists to prevent, forced past it to prove the reconciler
  // would notice if it ever got through.
  const txId = Number(f.db.prepare("INSERT INTO transactions (user_id,type,amount_cents,balance_after,frozen_after) VALUES (?,'deposit',1,1,0)").run(f.alice.id).lastInsertRowid);
  f.db.prepare("INSERT INTO entries (transaction_id, account_id, direction, amount_cents) VALUES (?, ?, 'credit', 777)").run(txId, acc.accountId(f.db, 'house_float', null));

  const r = await JOBS.reconcileOnce(f.db);
  assert.strictEqual(r.ok, false);
  const cons = r.findings.find((x) => x.scope === 'global_conservation');
  assert.ok(cons, 'conservation finding');
  assert.strictEqual(cons.expected_cents, 0);
  assert.strictEqual(cons.actual_cents, 777, 'drift equals the unbalanced amount');
});

// J4: the scheduler does not STACK. A reconciliation pass slower than its
// interval must skip ticks, not pile up — otherwise a slow pass eventually
// spends the whole process on reconciling.
check('J4 the scheduler skips rather than stacking slow runs', async () => {
  let started = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  let release;
  const gate = new Promise((res) => { release = res; });
  const job = JOBS.every(5, async () => {
    started++;
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await gate;
    concurrent--;
  });
  await new Promise((r) => setTimeout(r, 40)); // several intervals elapse
  const mid = job.stats();
  job.stop();
  release();
  await gate;
  assert.strictEqual(mid.running, true, 'first run is in flight');
  assert.ok(mid.skipped >= 1, 'ticks during a slow run were skipped');
  assert.strictEqual(maxConcurrent, 1, 'never two runs at once');
  assert.ok(started >= 1);
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
    } catch (e) {
      console.error('  FAIL', name);
      console.error(e);
      process.exit(1);
    }
    passed++;
    console.log('  ok', name);
  }
  console.log(`\nresults.test.js: ${passed} checks passed`);
  if (passed < 16) { console.error('expected 16 checks'); process.exit(1); }
})();