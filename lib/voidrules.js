'use strict';
// lib/voidrules.js — per-sport rules for deciding whether an event VOIDS or
// SETTLES, and which rule fired.
//
// WHY THIS IS NOT OPTIONAL. A results feed that cannot tell the difference
// between "finished" and "abandoned" settles incorrectly, and the venue pays
// for the error. The cases that actually happen:
//
//   - a red card at 70 minutes: the match PLAYS ON. Betfair's standard rule
//     is that a match abandoned after a red card is VOID; abandoned for any
//     other reason it is SETTLED at the point of abandonment.
//   - a rained-off race: VOID, always. Nobody ran it.
//   - a walkover: VOID. The contestant did not compete.
//   - a postponed match inside the advertised start window: SETTLED at 0-0 in
//     the sports that price it that way, VOID in the ones that do not.
//
// So the SAME physical fact ("abandoned at minute 70") is VOID under one sport
// and SETTLED under another. There is no single boolean, which is why the rule
// is resolved from the SPORT and the REASON, and why the reason is recorded —
// an operator disputing a settlement needs to see which rule was applied.
//
// Every rule returns one of three outcomes, never two:
//
//   SETTLE — there is a result; settle with the winner(s)
//   VOID    — no result; refund everyone
//   HOLD    — the outcome is DISPUTED or ambiguous. Do not settle, do not
//             refund. Leave the market open and escalate to a human.
//
// HOLD is the one most feeds omit and it is the expensive one: settling a
// disputed market picks a side, and voiding one that had a result gives away
// money the venue owes. Neither is recoverable after the fact.
//
// ── SETTLE_WITH_VOIDS (#88): A FOURTH ANSWER ──────────────────────────────────
// It is not a fifth outcome for the MARKET, and that distinction is the whole
// point of the name. The market still produced a winner and still settles on
// it; what travels alongside the decision is a SET OF SELECTIONS that are
// voided on the way — the runners a feed declared non-runners, whose backers
// are refunded and whose price is struck from the book.
//
// It is its own constant rather than a flag on SETTLE because every consumer of
// `resolve` switches on the decision, and a flag is invisible to a switch. That
// is precisely the defect #88 reproduced: a race completed, `ruleKey` said
// `completed`, the decision was `settle`, and nothing downstream knew a
// selection had to be removed with it. A backer was charged a full stake on a
// runner that never raced, and conservation read green throughout because the
// money went somewhere real — just to the wrong person.
const SETTLE = 'settle';
const VOID = 'void';
const HOLD = 'hold';
const SETTLE_WITH_VOIDS = 'settle_with_voids';

// The rule vocabulary, per sport slug. Open by design: adding a sport is
// adding data here, not branching logic in the settlement path.
const RULES = {
  // Football: abandoned after a RED CARD voids; abandoned otherwise settles at
  // the point of abandonment (the standard published rule).
  football: {
    completed: SETTLE,
    abandoned_after_red_card: VOID,
    abandoned_other: SETTLE,
    postponed: SETTLE,
    walkover: VOID,
  },
  // Horse racing: a withdrawn runner leaves the book and its backers are
  // refunded, while the race itself still settles on the winner. A dead heat is a
  // joint favourite — not SP, which this codebase does not model — and SETTLES by
  // dividing the payout.
  horse_racing: {
    // A clean finish settles. A dead heat SETTLES TOO, now that the engine can
    // divide the payout among joint winners — settling one runner and shorting
    // the other was the alternative this table used to force, and it is simply
    // wrong: it underpays the winning runners' backers and overcharges their
    // layers. `resolve` still HOLDS a dead heat that does not name at least
    // two joint winners, because "someone tied" with no names is a dispute,
    // not a settlement.
    completed: SETTLE,
    // ── `non_runner` IS NOT A SUB-CASE OF `abandoned` (#88) ──────────────────
    // This entry used to be VOID, reachable only through `ruleKey`'s abandoned
    // branch, and that was the bug in one sentence: a race that COMPLETES with
    // a runner withdrawn is the ordinary case (a horse is pulled; the other
    // runners run), so the rule that was supposed to refund a non-runner's
    // backers could not fire for the only situation it exists to handle. The
    // completed race returned `completed`, this entry said VOID, and nobody was
    // ever consulted: the non-runner settled as an ordinary loser, its backers
    // were charged full stake, and the books still balanced. Conservation
    // cannot see that class of defect — see the `greyhounds` note below for the
    // same blind spot with a different cause.
    //
    // So the withdrawn runner is its own fact. It is not a statement about
    // whether the EVENT happened (`abandoned`, `walkover`, `postponed`) and it
    // is no longer folded into one: those keys are decided by `status` alone,
    // and this one is decided by the presence of a runner the feed withdrew.
    // The two are orthogonal, and the previous table conflated them.
    //
    // The value is SETTLE_WITH_VOIDS rather than VOID because a completed race
    // has a winner who must be paid. VOID here would refund EVERYONE —
    // including the backers of runners that ran and finished first — which is
    // as wrong as charging the withdrawn runner, in the other direction.
    non_runner: SETTLE_WITH_VOIDS,
    dead_heat: SETTLE,
    // `abandoned_other`, NOT `abandoned`. ruleKey() can only ever emit
    // abandoned_after_red_card, abandoned_other or non_runner — it never emits a
    // bare `abandoned`. So the entry that used to be spelled `abandoned` was
    // dead: a horse race abandoned with no non-runner list (the common case)
    // fell through to "no rule for abandoned_other" and was HELD forever, with
    // the only exit being a manual release. Five such entries existed across the
    // table; tests/settlement-findings.test.js (S-F5) asserts every declared key
    // is REACHABLE, which is the inverse of the slug-consistency check and
    // catches a whole class the other one cannot.
    abandoned_other: VOID,
  },
  // Greyhound: every runner runs or the race is abandoned -> void.
  //
  // The key is the SEEDED SLUG (`greyhounds`), not the singular. The mismatch
  // was silent and expensive: a normally-finished race fell through to the
  // unknown-sport default and was VOIDED, so the winner's backers were paid
  // nothing and the layers kept the pot — while the books still balanced,
  // because conservation cannot tell you a settled market paid nobody.
  // tests/rules-consistency.test.js now fails if the table and the seed
  // ever disagree again.
  greyhounds: {
    completed: SETTLE,
    // A WITHDRAWN TRAPPER, declared before the off, is the same shape as a
    // withdrawn horse: bets on that dog are refunded and the rest of the field
    // settles. Declared here rather than left to the unknown-sport default for
    // the reason #88 exists — a racing signal the table does not understand must
    // not be settled as though the runner had raced.
    non_runner: SETTLE_WITH_VOIDS,
    // `abandoned_other`, not `abandoned` — see horse_racing above. And there
    // is no `fall` entry: ruleKey has no `fall` signal at all, because a fall is
    // a completed race with a winner, not a distinct outcome. It was declared
    // here and could never fire.
    abandoned_other: VOID,
  },
  tennis: {
    completed: SETTLE,
    // `abandoned_other` — a retirement settles at the point of retirement.
    abandoned_other: SETTLE,
    walkover: VOID,
  },
  // Basketball: it was SEEDED but had no entry here, so every completed game
  // hit the unknown-sport default and was VOIDED — a finished NBA game paying
  // nobody. An abandonment is a forfeit, and whose forfeit it is depends on the
  // competition, so HOLD rather than guess.
  basketball: {
    completed: SETTLE,
    abandoned_other: HOLD,
  },
};

// The fallback when a sport has no entry. VOID is the conservative choice:
// refunding every stake is bounded and recoverable, whereas settling on a
// wrong winner moves money that the venue may not owe. A venue that adds a
// sport without rules should err towards giving money back, not towards
// inventing a result.
const DEFAULT_RULE = VOID;

/**
 * The runners a feed declared NON-RUNNERS, as validated selection ids.
 *
 * STRICTLY integers, no coercion, for the reason lib/settle.js is strict about
 * joint winners: `Number(true) === 1`, so a coerced `[true, 2]` becomes a valid
 * `[1, 2]` and voids somebody's real runner on a horse that raced. A malformed
 * element is DROPPED rather than repaired — repairing a malformed feed signal
 * is not the same as refusing it, and the audit row would then record a
 * withdrawal the feed never declared.
 *
 * Empty is the common case and is not an error: most feeds send no
 * `non_runners` at all, and lib/resultsfeed.js drops an empty list before it
 * gets here.
 */
function declaredNonRunners(signal) {
  const raw = signal && signal.non_runners;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    if (typeof x !== 'number' || !Number.isInteger(x) || x <= 0) continue;
    if (!out.includes(x)) out.push(x); // de-duplicated: one withdrawal, one refund
  }
  return out;
}

/**
 * Does this sport's rules say what a WITHDRAWN RUNNER means?
 *
 * The gate, not a convenience. A `non_runners` list is only a signal about the
 * market for a sport that publishes one; for every other sport the field does
 * not exist, so a stray one must not change the outcome. This is why
 * `non_runner` is a declared key per sport rather than a branch in `ruleKey`:
 * the table is the authority, exactly as it is for a dead heat in football.
 *
 * Exported because lib/results.js needs the same question for a withdrawal
 * notice that arrives with no `status` at all (a pre-off removal), which never
 * reaches `ruleKey`.
 */
function declaresNonRunners(sportSlug) {
  const sport = RULES[sportSlug];
  return !!sport && Object.prototype.hasOwnProperty.call(sport, 'non_runner');
}

/**
 * Decide the outcome for an event.
 *
 * `signal` describes what actually happened:
 *   { status: 'completed' | 'abandoned' | 'postponed' | 'walkover',
 *     red_card: bool, non_runners: [selectionId], dead_heat: bool,
 *     winners: [selectionId] }
 *
 * Returns { decision, rule, voided, winners, voided_selections, reason } —
 * `rule` is the key that fired, kept so the audit trail can answer "why was
 * this voided".
 *
 * `voided` still means ONE thing only: THE MARKET is void. A voided SELECTION
 * is reported separately in `voided_selections`, because conflating the two is
 * how a completed race with a withdrawn runner ends up refunding the runners
 * that finished.
 */
function resolve(sportSlug, signal) {
  const s = signal || {};
  const sport = RULES[sportSlug];
  const withdrawn = declaredNonRunners(s);
  // THE ORTHOGONAL FACT (#88). `non_runners` is consulted independently of
  // `status` — "this runner did not start" and "this event did not run" are
  // different facts about the world — but it only becomes a SIGNAL for a sport
  // whose rules define it (see declaresNonRunners). For any other sport the
  // list is not evidence of anything and cannot change the outcome.
  const nonRunnerSignal = declaresNonRunners(sportSlug) && withdrawn.length > 0;
  const rule = ruleKey(s, nonRunnerSignal);

  // HOLD is checked BEFORE the sport table, because a dispute is a dispute
  // whatever the sport's rules say, and no published rule should be able to
  // overrule "this outcome is contested".
  if (s.disputed === true) {
    return { decision: HOLD, rule: 'disputed', voided: false, winners: null, voided_selections: [], reason: 'Outcome is disputed and held for manual review' };
  }
  if (!sport) {
    return { decision: DEFAULT_RULE, rule: rule || 'unknown_sport', voided: true, winners: null, voided_selections: [], reason: `No void rules for sport "${sportSlug}"; defaulting to void` };
  }
  if (!rule) {
    // A completed event with no signal we recognise: do NOT invent a result.
    return { decision: HOLD, rule: 'unrecognised', voided: false, winners: null, voided_selections: [], reason: 'Outcome did not match any known rule; held for review' };
  }
  const decision = sport[rule];
  if (decision === undefined) {
    return { decision: HOLD, rule: `${rule}_unspecified`, voided: false, winners: null, voided_selections: [], reason: `Sport "${sportSlug}" has no rule for "${rule}"; held for review` };
  }
  if (decision === VOID) {
    return { decision: VOID, rule, voided: true, winners: null, voided_selections: [], reason: `Void: ${rule} under ${sportSlug} rules` };
  }
  // A decision this function does not implement is HELD rather than treated as
  // a settle. The check is explicit because a typo in the table used to fall
  // through to the SETTLE return below — so a misspelled rule entry would have
  // paid a winner on a market nobody had authorised.
  if (decision !== SETTLE && decision !== SETTLE_WITH_VOIDS) {
    return { decision: HOLD, rule: `${rule}_unsupported`, voided: false, winners: null, voided_selections: [], reason: `Sport "${sportSlug}" declares an unrecognised decision for "${rule}"; held for review` };
  }
  // SETTLE / SETTLE_WITH_VOIDS. Winners must be present and must belong to the
  // event; without them there is nothing to settle, which is a HOLD rather than
  // a guess.
  const winners = Array.isArray(s.winners) ? s.winners.filter((w) => Number.isInteger(w) && w > 0) : [];
  if (winners.length === 0) {
    return { decision: HOLD, rule: `${rule}_no_winner`, voided: false, winners: null, voided_selections: [], reason: `${rule} requires a winner but none was supplied; held for review` };
  }
  // A DEAD HEAT is only a settlement if it names at least TWO joint winners.
  // One name is not a dead heat — it is an ordinary finish, and treating it as
  // a joint favourite would halve a payout the rules say is a full one.
  if (rule === 'dead_heat' && winners.length < 2) {
    return { decision: HOLD, rule: 'dead_heat_underspecified', voided: false, winners: null, voided_selections: [], reason: 'Dead heat must name at least two joint winners; held for review' };
  }
  // A withdrawn runner rides ALONG with a settlement, whatever the settlement
  // is. Two shapes reach here:
  //
  //   - `non_runner` — an ordinary finish in which a runner did not start. The
  //     runner's selection is voided; the winner is paid in full.
  //   - `dead_heat` in a race where a third runner was withdrawn. The joint
  //     favourite among the runners that ran stands, and only the withdrawn one
  //     is voided. Voiding the dead heat itself would pay nobody, and settling
  //     it without the withdrawal would charge the withdrawn runner's backers.
  //
  // Both are `settle_with_voids` because the MARKET settles in both. A caller
  // that only understands SETTLE and VOID — which is every caller written before
  // #88 — would misread this as a plain settle, so the decision says so.
  if (decision === SETTLE_WITH_VOIDS || nonRunnerSignal) {
    return {
      decision: SETTLE_WITH_VOIDS,
      rule,
      voided: false,
      winners,
      voided_selections: withdrawn,
      reason: `Settle on ${rule} under ${sportSlug} rules with ${withdrawn.length} withdrawn runner(s) voided`,
    };
  }
  return { decision: SETTLE, rule, voided: false, winners, voided_selections: [], reason: `Settle on ${rule} under ${sportSlug} rules` };
}

// Map a status + modifiers to a rule key in RULES, or null when nothing
// matches. Split out so the sport table stays pure data.
//
// `nonRunnerSignal` is passed IN rather than read off `s` because whether a
// withdrawal list counts as a signal depends on the SPORT (see
// declaresNonRunners), and this function is deliberately sport-blind.
//
// The abandoned branch no longer looks at `non_runners`, and that is the #88
// fix rather than a detail: an abandoned race is refunded in full either way, so
// folding the withdrawal into the key bought nothing and cost the common case
// (a completed race with a withdrawn runner) its only chance to reach the rule.
// The default parameter keeps a direct `ruleKey(signal)` call behaving as before
// for every signal without a withdrawal.
function ruleKey(s, nonRunnerSignal = false) {
  if (s.status === 'walkover') return 'walkover';
  if (s.status === 'postponed') return 'postponed';
  if (s.status === 'abandoned') {
    if (s.red_card) return 'abandoned_after_red_card';
    return 'abandoned_other';
  }
  if (s.status === 'completed') {
    if (s.dead_heat) return 'dead_heat';
    return nonRunnerSignal ? 'non_runner' : 'completed';
  }
  return null;
}

// Sports with a rule set. Exported so an operator can see what is configured
// rather than discovering an unsettable market in production.
function knownSports() {
  return Object.keys(RULES).sort();
}

// hasRules: does this sport slug have its own rule set? Exported so the
// consistency test can assert the table and the seed agree, which is the only
// way a slug mismatch becomes a failing test instead of a voided market.
function hasRules(sportSlug) {
  return Object.prototype.hasOwnProperty.call(RULES, sportSlug);
}

/**
 * Every rule key `ruleKey` is capable of producing.
 *
 * Exported so tests can assert that every key DECLARED in RULES is actually
 * REACHABLE — tests/settlement-findings.test.js (S-F5) does that.
 * tests/rules-consistency.test.js covers the other axis — that every seeded
 * sport has a rule set — and neither test can catch the other's failure: a
 * sport whose rules all name unreachable keys looks perfectly consistent and
 * voids or holds everything.
 *
 * AND IT IS NOT ENOUGH ON ITS OWN, which #88 proved the expensive way. `non_runner`
 * was on this list and was reachable — through the abandoned branch — while the
 * only combination it exists to handle, a COMPLETED race with a withdrawn
 * runner, was unreachable and settled the withdrawn runner as a loser. Reach
 * tests the KEY; the defect was in the COMBINATION of status and withdrawal.
 * tests/voidrules.test.js now asserts the combination.
 */
const RULE_KEYS = Object.freeze([
  'completed',
  'dead_heat',
  'walkover',
  'postponed',
  'abandoned_after_red_card',
  'abandoned_other',
  'non_runner',
]);

module.exports = {
  SETTLE,
  VOID,
  HOLD,
  SETTLE_WITH_VOIDS,
  RULES,
  RULE_KEYS,
  DEFAULT_RULE,
  resolve,
  ruleKey,
  declaredNonRunners,
  declaresNonRunners,
  knownSports,
  hasRules,
};
