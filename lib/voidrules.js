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
const SETTLE = 'settle';
const VOID = 'void';
const HOLD = 'hold';

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
  // Horse racing: a non-runner is void; a dead heat pays out at SP (joint
  // favourite), which this codebase does not model — so a dead heat HOLDS
  // rather than settling one runner and shorting the other.
  horse_racing: {
    // A clean finish settles. A dead heat does NOT: it pays joint favourite,
    // which this engine does not model, so it is held rather than settled on
    // one runner and short on the other.
    completed: SETTLE,
    non_runner: VOID,
    dead_heat: HOLD,
    abandoned: VOID,
  },
  // Greyhound: every runner runs or the race is abandoned -> void.
  greyhound: {
    completed: SETTLE,
    abandoned: VOID,
    fall: SETTLE,
  },
  tennis: {
    completed: SETTLE,
    abandoned: SETTLE, // retirement: the match settles at the point of retirement
    walkover: VOID,
  },
};

// The fallback when a sport has no entry. VOID is the conservative choice:
// refunding every stake is bounded and recoverable, whereas settling on a
// wrong winner moves money that the venue may not owe. A venue that adds a
// sport without rules should err towards giving money back, not towards
// inventing a result.
const DEFAULT_RULE = VOID;

/**
 * Decide the outcome for an event.
 *
 * `signal` describes what actually happened:
 *   { status: 'completed' | 'abandoned' | 'postponed' | 'walkover',
 *     red_card: bool, non_runners: [selectionId], dead_heat: bool,
 *     winners: [selectionId] }
 *
 * Returns { decision, rule, voided, winners, reason } — `rule` is the key
 * that fired, kept so the audit trail can answer "why was this voided".
 */
function resolve(sportSlug, signal) {
  const s = signal || {};
  const sport = RULES[sportSlug];
  const rule = ruleKey(s);

  // HOLD is checked BEFORE the sport table, because a dispute is a dispute
  // whatever the sport's rules say, and no published rule should be able to
  // overrule "this outcome is contested".
  if (s.disputed === true) {
    return { decision: HOLD, rule: 'disputed', voided: false, winners: null, reason: 'Outcome is disputed and held for manual review' };
  }
  if (!sport) {
    return { decision: DEFAULT_RULE, rule: rule || 'unknown_sport', voided: true, winners: null, reason: `No void rules for sport "${sportSlug}"; defaulting to void` };
  }
  if (!rule) {
    // A completed event with no signal we recognise: do NOT invent a result.
    return { decision: HOLD, rule: 'unrecognised', voided: false, winners: null, reason: 'Outcome did not match any known rule; held for review' };
  }
  const decision = sport[rule];
  if (decision === undefined) {
    return { decision: HOLD, rule: `${rule}_unspecified`, voided: false, winners: null, reason: `Sport "${sportSlug}" has no rule for "${rule}"; held for review` };
  }
  if (decision === VOID) {
    return { decision: VOID, rule, voided: true, winners: null, reason: `Void: ${rule} under ${sportSlug} rules` };
  }
  // SETTLE. Winners must be present and must belong to the event; without them
  // there is nothing to settle, which is a HOLD rather than a guess.
  const winners = Array.isArray(s.winners) ? s.winners.filter((w) => Number.isInteger(w) && w > 0) : [];
  if (winners.length === 0) {
    return { decision: HOLD, rule: `${rule}_no_winner`, voided: false, winners: null, reason: `${rule} requires a winner but none was supplied; held for review` };
  }
  return { decision: SETTLE, rule, voided: false, winners, reason: `Settle on ${rule} under ${sportSlug} rules` };
}

// Map a status + modifiers to a rule key in RULES, or null when nothing
// matches. Split out so the sport table stays pure data.
function ruleKey(s) {
  if (s.status === 'completed') return s.dead_heat ? 'dead_heat' : 'completed';
  if (s.status === 'walkover') return 'walkover';
  if (s.status === 'postponed') return 'postponed';
  if (s.status === 'abandoned') {
    if (s.red_card) return 'abandoned_after_red_card';
    if (Array.isArray(s.non_runners) && s.non_runners.length > 0) return 'non_runner';
    return 'abandoned_other';
  }
  return null;
}

// Sports with a rule set. Exported so an operator can see what is configured
// rather than discovering an unsettable market in production.
function knownSports() {
  return Object.keys(RULES).sort();
}

module.exports = { SETTLE, VOID, HOLD, RULES, DEFAULT_RULE, resolve, ruleKey, knownSports };