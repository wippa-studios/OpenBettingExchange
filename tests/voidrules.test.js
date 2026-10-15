// voidrules.test.js — the per-sport void rules, and the SIGNAL COMBINATIONS.
//
// Run: node tests/voidrules.test.js   (plain assert, no deps)
//
// WHY THIS FILE IS ABOUT COMBINATIONS, AND NOT KEYS.
//
// #88 was a money-path defect that a key-reachability check passed straight
// through. `non_runner` was a declared key, it WAS reachable (through the
// abandoned branch), and every assertion about keys was green while a completed
// race with a declared non-runner settled that runner as an ordinary loser —
// charging a bettor a full stake on a horse that never started, with the books
// still balancing.
//
// The lesson is worth more than the fix: reach tests the KEY, and the defect was
// in the COMBINATION of `status` and `non_runners`. A table of keys with a test
// that each key is reachable can still describe a venue where the combination
// that costs the most money is unreachable. So every case here is a signal
// through `resolve`, and each one asserts the CONTROL beside it — the same
// signal without the withdrawal — so a rule table that voided everything, or
// settled everything, cannot pass.
//
// The key-reachability check still exists and is still worth having
// (tests/settlement-findings.test.js S-F5). It just cannot see this.
'use strict';

const assert = require('assert');
const rules = require('../lib/voidrules');

let passed = 0;
// No async in this file, but the drain is kept so a suite here and a suite
// elsewhere are read the same way, and so adding an awaitable case later cannot
// report a promise that later rejected as a pass.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

const ALPHA = 1; // the withdrawn runner
const BETA = 2; // the runner that runs and wins
const GAMMA = 3; // the other runner that runs

// V1: THE REPORTED CASE. A race that COMPLETES with one runner declared a
// non-runner is not a plain settlement — the withdrawn selection is voided and
// the winner is still paid. The decision is its own value precisely so that a
// caller cannot mistake it for a plain settle by not reading a flag.
check('V1 a completed race with a non-runner is not a plain SETTLE', () => {
  const sig = { status: 'completed', winners: [BETA], non_runners: [ALPHA] };
  const r = rules.resolve('horse_racing', sig);
  assert.notStrictEqual(r.decision, rules.SETTLE, 'a plain settle is what charged the withdrawn runner');
  assert.strictEqual(r.decision, rules.SETTLE_WITH_VOIDS);
  assert.deepStrictEqual(r.voided_selections, [ALPHA], 'and it names the selection to remove');
  assert.deepStrictEqual(r.winners, [BETA], 'the winner that ran is still carried');
  assert.strictEqual(r.voided, false, 'the MARKET is not void — the winner must still be paid');
  assert.strictEqual(r.rule, 'non_runner', 'the recorded rule says which rule fired');

  // THE CONTROL. Identical signal, withdrawal removed: this is an ordinary
  // finish, and it must stay one. Without this assertion the case above would
  // also pass against a table that voids every completed race.
  const plain = rules.resolve('horse_racing', { status: 'completed', winners: [BETA] });
  assert.strictEqual(plain.decision, rules.SETTLE);
  assert.strictEqual(plain.rule, 'completed');
  assert.deepStrictEqual(plain.voided_selections, []);
});

// V2: THE COMBINATION IS REACHABLE IN EVERY SPORT THAT DECLARES THE RULE, for
// the reason that is the whole point of the suite — `non_runner` being a
// reachable KEY was always true and told nobody anything useful.
check('V2 the combination is reachable in each racing sport that declares it', () => {
  const racers = ['horse_racing', 'greyhounds'];
  assert.deepStrictEqual(racers.filter((s) => rules.declaresNonRunners(s)), racers, 'both racing slugs declare it');
  for (const slug of racers) {
    const r = rules.resolve(slug, { status: 'completed', winners: [BETA], non_runners: [ALPHA] });
    assert.strictEqual(r.decision, rules.SETTLE_WITH_VOIDS, `${slug}: a completed race with a withdrawn runner`);
    assert.deepStrictEqual(r.voided_selections, [ALPHA], `${slug}: names the withdrawn selection`);
    // ...and the combination is reachable through ruleKey too, which is what
    // makes the key itself live rather than declared.
    assert.strictEqual(rules.ruleKey({ status: 'completed' }, true), 'non_runner');
    assert.strictEqual(rules.ruleKey({ status: 'completed' }), 'completed');
    const plain = rules.resolve(slug, { status: 'completed', winners: [BETA] });
    assert.strictEqual(plain.decision, rules.SETTLE, `${slug}: an ordinary finish is still an ordinary finish`);
  }
});

// V3: A WITHDRAWN RUNNER IS A SEPARATE FACT FROM AN ABANDONED RACE.
//
// They were conflated: `non_runner` used to be reachable only from the abandoned
// branch, which is the bug in one sentence. So the market-level keys are decided
// by `status` ALONE now, and a withdrawal changes nothing about whether the race
// happened — an abandoned race is refunded in full either way, and a completed
// one is settled on its winner either way.
check('V3 an abandoned race is still void, and the withdrawal changes nothing', () => {
  for (const sig of [
    { status: 'abandoned', non_runners: [ALPHA] },
    { status: 'abandoned' },
    { status: 'abandoned', winners: [BETA], non_runners: [ALPHA] },
  ]) {
    const r = rules.resolve('horse_racing', sig);
    assert.strictEqual(r.decision, rules.VOID, `void: ${JSON.stringify(sig)}`);
    assert.strictEqual(r.voided, true);
    // No per-selection list: there is nothing to remove when the whole race is
    // refunded, and a consumer that voids selections AND the market would
    // double-count the refund.
    assert.deepStrictEqual(r.voided_selections, [], `no selection voids on a voided market: ${JSON.stringify(sig)}`);
  }
  // The other two abandonments are unchanged, including the red card.
  assert.strictEqual(rules.resolve('horse_racing', { status: 'abandoned', red_card: true, non_runners: [ALPHA] }).decision, rules.HOLD,
    'horse racing has no red-card rule, so it is held — unchanged by this work');
  assert.strictEqual(rules.resolve('football', { status: 'abandoned', red_card: true }).decision, rules.VOID);
});

// V4: A DEAD HEAT AMONG THE RUNNERS THAT RAN, IN A RACE WHERE A THIRD RUNNER
// WAS WITHDRAWN. Two things have to be true at once, and getting either wrong
// costs a real bettor money: the joint favourite must still be paid (voiding the
// dead heat pays nobody) and the withdrawn runner must not be charged (settling
// it without the withdrawal is #88 again).
check('V4 a dead heat survives a withdrawal, and the withdrawal still applies', () => {
  const r = rules.resolve('horse_racing', {
    status: 'completed', dead_heat: true, winners: [BETA, GAMMA], non_runners: [ALPHA],
  });
  assert.strictEqual(r.decision, rules.SETTLE_WITH_VOIDS);
  assert.strictEqual(r.rule, 'dead_heat', 'the dead heat is still the market-level rule');
  assert.deepStrictEqual(r.winners.sort(), [BETA, GAMMA], 'both joint winners are carried');
  assert.deepStrictEqual(r.voided_selections, [ALPHA], 'and the withdrawn runner is voided');

  // CONTROL: the same dead heat with nobody withdrawn is a plain settlement.
  const plain = rules.resolve('horse_racing', { status: 'completed', dead_heat: true, winners: [BETA, GAMMA] });
  assert.strictEqual(plain.decision, rules.SETTLE);
  assert.deepStrictEqual(plain.voided_selections, []);
});

// V5: A SPORT THAT DOES NOT MODEL WITHDRAWN RUNNERS IS NOT AFFECTED.
//
// The rules table is the authority on whether `non_runners` means anything, and
// that gate is what stops a stray withdrawal list on a football fixture from
// freezing the match or voiding a "runner". It also keeps the football path
// byte-for-byte as it was: a completed match with a stray field settles.
check('V5 a sport that does not model withdrawals is unaffected by one', () => {
  for (const slug of ['football', 'tennis', 'basketball', 'greyhounds_does_not_exist']) {
    assert.strictEqual(rules.declaresNonRunners(slug), false, `${slug} declares no withdrawal rule`);
  }
  const fb = rules.resolve('football', { status: 'completed', winners: [BETA], non_runners: [ALPHA] });
  assert.strictEqual(fb.decision, rules.SETTLE, 'a completed football match settles on its winner');
  assert.strictEqual(fb.rule, 'completed');
  assert.deepStrictEqual(fb.voided_selections, [], 'and voids no selection');

  // An UNKNOWN sport still defaults to void — the conservative rule that has
  // always applied is untouched, and it does NOT become a selection void.
  const unknown = rules.resolve('curling', { status: 'completed', winners: [BETA], non_runners: [ALPHA] });
  assert.strictEqual(unknown.decision, rules.DEFAULT_RULE);
  assert.strictEqual(unknown.voided, true);
  assert.deepStrictEqual(unknown.voided_selections, []);
});

// V6: A DISPUTE OUTRANKS THE WITHDRAWAL, AS IT OUTRANKS EVERY OTHER RULE.
//
// A disputed market is money a machine must not move in either direction: not
// by settling a race whose field is in dispute, and not by refunding a
// withdrawal nobody has verified.
check('V6 a disputed outcome is held, withdrawal or not', () => {
  const d = rules.resolve('horse_racing', {
    status: 'completed', winners: [BETA], non_runners: [ALPHA], disputed: true,
  });
  assert.strictEqual(d.decision, rules.HOLD);
  assert.strictEqual(d.rule, 'disputed');
  assert.deepStrictEqual(d.voided_selections, [], 'nothing is removed from a disputed market');
});

// V7: NO COERCION REACHES A WITHDRAWAL.
//
// `Number(true) === 1` and `Number('2') === 2`, so a coerced list would void a
// real runner the feed never named — the same laundering #61 found in
// releaseHold, on a path that now MOVES MONEY. Malformed elements are dropped,
// and a list with nothing usable left in it is not a withdrawal at all: the race
// settles as the ordinary finish it is.
check('V7 a coerced or malformed withdrawal list removes nothing', () => {
  const bad = [[true], ['2'], [0], [-1], [2.5], [[2]], [null], [{}]];
  for (const non_runners of bad) {
    const r = rules.resolve('horse_racing', { status: 'completed', winners: [BETA], non_runners });
    assert.strictEqual(r.decision, rules.SETTLE, `${JSON.stringify(non_runners)} is not a withdrawal`);
    assert.deepStrictEqual(r.voided_selections, [], `${JSON.stringify(non_runners)} voids nothing`);
  }
  // A GOOD element beside a bad one still counts, and only the good one: the
  // dropped element is not repaired into a selection nobody named.
  const mixed = rules.resolve('horse_racing', { status: 'completed', winners: [BETA], non_runners: [ALPHA, true, '9'] });
  assert.deepStrictEqual(mixed.voided_selections, [ALPHA]);
  assert.strictEqual(mixed.decision, rules.SETTLE_WITH_VOIDS);
  // A non-array is not a list at all.
  assert.deepStrictEqual(
    rules.resolve('horse_racing', { status: 'completed', winners: [BETA], non_runners: '1,2' }).voided_selections, []
  );
  assert.deepStrictEqual(
    rules.resolve('horse_racing', { status: 'completed', winners: [BETA], non_runners: {} }).voided_selections, []
  );
});

// V8: THE SAME RUNNER NAMED TWICE IS ONE WITHDRAWAL. The refund is computed
// from matches, so a duplicated id cannot become two refunds — but it must not
// be relied on downstream to notice, because the guarantee belongs here where
// the list is read.
check('V8 a duplicated withdrawal id is de-duplicated', () => {
  const r = rules.resolve('horse_racing', { status: 'completed', winners: [BETA], non_runners: [ALPHA, ALPHA, ALPHA] });
  assert.deepStrictEqual(r.voided_selections, [ALPHA]);
  assert.deepStrictEqual(rules.declaredNonRunners({ non_runners: [ALPHA, ALPHA, true, '3', ALPHA] }), [ALPHA]);
});

// V9: A COMPLETED RACE WITH A WITHDRAWAL BUT NO WINNER IS HELD. There is
// nothing to settle once the withdrawn runner is out of the book, and a void
// here would refund everybody — including the runners that finished.
check('V9 a withdrawal with no winner is held, not voided and not settled', () => {
  const r = rules.resolve('horse_racing', { status: 'completed', non_runners: [ALPHA] });
  assert.strictEqual(r.decision, rules.HOLD);
  assert.strictEqual(r.rule, 'non_runner_no_winner');
  assert.strictEqual(r.voided, false, 'held: nobody is refunded');
});

// V10: THE TABLE CANNOT DECIDE SOMETHING THIS MODULE DOES NOT IMPLEMENT. A
// misspelled decision used to fall through to the SETTLE return below the table
// lookup, so a typo in the rules would have paid a winner on a market nobody
// authorised.
check('V10 an unimplemented decision is held, not silently settled', () => {
  const saved = rules.RULES.horse_racing.non_runner;
  try {
    rules.RULES.horse_racing.non_runner = 'settl';
    const r = rules.resolve('horse_racing', { status: 'completed', winners: [BETA], non_runners: [ALPHA] });
    assert.strictEqual(r.decision, rules.HOLD);
    assert.strictEqual(r.rule, 'non_runner_unsupported');
  } finally {
    rules.RULES.horse_racing.non_runner = saved;
  }
  // And the control: the real value still settles with voids.
  assert.strictEqual(
    rules.resolve('horse_racing', { status: 'completed', winners: [BETA], non_runners: [ALPHA] }).decision,
    rules.SETTLE_WITH_VOIDS
  );
});

// V11: EVERY SETTLE-FAMILY DECISION CARRIES THE SAME SHAPE, so a consumer
// switching on the decision cannot read a missing field as "no withdrawals".
check('V11 every decision returns the full result shape', () => {
  const signals = [
    { status: 'completed', winners: [BETA] },
    { status: 'completed', winners: [BETA], non_runners: [ALPHA] },
    { status: 'completed', dead_heat: true, winners: [BETA, GAMMA] },
    { status: 'abandoned', red_card: true },
    { status: 'walkover' },
    { status: 'completed', winners: [BETA], disputed: true },
    { status: 'something-new', winners: [BETA] },
    { status: 'completed' },
  ];
  for (const sig of signals) {
    const r = rules.resolve('horse_racing', sig);
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'voided_selections'), `voided_selections: ${JSON.stringify(sig)}`);
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'voided'), `voided: ${JSON.stringify(sig)}`);
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'winners'), `winners: ${JSON.stringify(sig)}`);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `reason: ${JSON.stringify(sig)}`);
    // A market is void OR selections are void — never both, and never neither on
    // a decision that resolves one of them.
    assert.ok(!(r.voided && r.voided_selections.length > 0), `not both: ${JSON.stringify(sig)}`);
  }
});

(async () => {
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
  if (passed < 11) { console.error('expected 11 checks'); process.exit(1); }
  console.log(`\nvoidrules.test.js: ${passed} checks passed`);
})();