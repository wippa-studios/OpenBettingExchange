'use strict';
// lib/deductions.js — the DECLARED deduction on bets surviving a late scratching.
//
// ── WHY A DEDUCTION AT ALL, IN ONE PARAGRAPH ─────────────────────────────────
//
// lib/settle.js refunds a withdrawn runner's backers because that is what the
// rules say and it has always been true: WA rule 4A, "refund all bets on the
// late scratched runner and those bets are, by operation of this rule, declared
// off". That half is correct and this module does not touch it.
//
// The half that was missing is the other side of the same rule. Australian racing
// does not simply refund: it applies a DEDUCTION to the bets on the runners that
// SURVIVE, scaled by the withdrawn runner's odds. Three independent published
// schedules agree on the shape — betr Racing Rules v1.1 (18 September 2026) carry
// a literal *Scale of Deductions* table keyed by price band (80% at 1.01–1.16,
// 64% at 1.41–1.45, 27% at 3.41–3.50, 22% at 4.01–4.20, with separate columns
// for three-place and two-place); the GRV greyhound *Deduction Schedule* gives
// cents-in-the-dollar tables for WIN and PLACE keyed on the odds on offer of the
// withdrawn dog (15.00 or over = no deduction, 2.00 = 45 cents off a win, 1.20 =
// 72 cents); and WA 4A computes it by formula with the deduction applied to each
// remaining runner PROPORTIONAL TO THE ODDS AGAINST THAT RUNNER.
//
// So on an Australian racing launch, a venue that refunds and stops OVERPAYS the
// backers of every surviving runner by the deduction it never applies. That is a
// real-money loss on every race with a late scratching, and conservation cannot
// see it: the money goes to a real person in a real account. It is the same blind
// spot as the `greyhounds`/`greyhound` slug mismatch and the withdrawn-runner
// settlement — money that moves somewhere real, just to the wrong person.
//
// ── WHY THE VENUE DOES NOT COMPUTE ONE ───────────────────────────────────────
//
// Because the scale is published PER RACING AUTHORITY and PER JURISDICTION, it is
// versioned, and — this is the part that ends the argument — the STEWARDS declare
// the deduction in a particular race. WA rule 4A says so outright: where the
// withdrawn runner is shorter than the scale covers, the stewards may declare ALL
// wagers void and order the race re-opened. That outcome is a steward's call and
// no formula should guess at it: a venue that guesses "the table must mean X"
// has invented a racing rule, and on a licensed venue inventing a racing rule is
// not a rounding difference.
//
// So this module is the same shape as every other provider-shaped fact in this
// repository: THE VENUE IS THE MECHANISM, THE FEED IS THE AUTHORITY. A withdrawal
// signal may CARRY a declared deduction. The venue applies what is declared,
// records what it applied, and REFUSES TO INVENT ONE.
//
// ── WHAT THIS MODULE IS NOT ──────────────────────────────────────────────────
//
// It is not a scale. There is no table here, no price bands, no formula and no
// default. Search this file for one. If a jurisdiction's schedule needs
// re-basing after EACH withdrawal, the operator declares the composed figure as a
// single declaration; the venue sums what it is told and never re-bases. That
// limitation is stated in docs/EXCHANGE_RULES.md and repeated in the operator
// reply, because a limitation that only lives in a comment is a limitation an
// operator discovers in production.
//
// ── WHAT IT DOES: FOUR THINGS, AND THE ORDER MATTERS ────────────────────────
//
//   1. `parse`     — read the declaration off a signal and VALIDATE it, at the
//                    seam, before any money moves. Every rejection is NAMED. A
//                    malformed or out-of-range figure never becomes "no
//                    deduction", because that is the failure mode where a bad
//                    input quietly becomes a full payout.
//   2. `resolveFor`— turn accepted declarations into a per-runner basis-point
//                    scale for the runners that actually won, proportional to
//                    their own odds (WA 4A), clamped so it can never exceed the
//                    payout it is taken from.
//   3. the counts  — a withdrawal settled with NO declared deduction is a FINDING
//                    (`undeclaredCount`), not a silent full refund. It is counted
//                    rather than refused for the reason lib/datasources.js counts
//                    an outcome that names no licensed source: refusing would
//                    strand the market, and an invisible gap is worse than a
//                    tolerated one only if nobody is counting it. Somebody is.
//   4. `assertApplicable` — the primitive defends itself, so a future caller
//                    cannot land a raw feed figure straight on a payout path.
//
// THE UNIT DECLARATION IS NOT OPTIONAL, AND THAT IS THE POINT.
//
// A declared deduction arrives as a NUMBER, and a bare number does not say what
// it is a number OF. `27` is 27 percent, or 27 cents in the dollar (the GRV
// phrasing), or 27 units of a currency if somebody wired the wrong field. `0.27`
// is 27 percent read as a fraction — or 0.27 percent if the sender meant a
// percentage. Those readings differ by a factor of a hundred, and the venue has
// no way to tell which one the stewards meant. So the unit is REQUIRED, it is
// drawn from a CLOSED vocabulary, and an absent or unrecognised one is a named
// refusal.
//
// This is lib/aml/rules.js's convention and the reason it is written there on
// the rule rather than in a map in the engine: a unit table that lives apart from
// the thing it describes drifts silently, and the drift is a factor of 100 that
// reads as a working control. Here the "rule" is the declaration shape itself, so
// the map is the shape, and there is nothing to drift from.
//
// ── WHY A MISSING DECLARATION IS NOT REFUSED, AND A MALFORMED ONE IS ────────
//
// Three answers, and they must be VISIBLY different — the whole point of this
// module is that they are:
//
//   absent    the settlement proceeds in full. Refusing would strand the market
//             and every bettor in it, on a race that finished. The gap is
//             recorded on the provenance row and counted.
//   declared  applied, and recorded exactly: what was declared, in what unit, on
//             which runner, scaled by which odds, and whether it was clamped.
//   rejected  NOT applied, and NAMED. On a settlement path the market is HELD
//             rather than settled at full payout, because a bad declaration that
//             silently became "no deduction" is a full payout the venue did not
//             authorise. On a PRE-OFF withdrawal notice the refund still happens —
//             see the asymmetry note on `applyWithdrawal` in lib/results.js.
//
// ── THE CLAMP, AND WHY IT IS A CLAMP AND NOT A REFUSAL ──────────────────────
//
// A deduction is taken from a backer's WINNINGS (WA: the deduction is applied to
// the amount payable to the holder of the bet — the dividend, not the stake), so
// it can never exceed the winnings or the payout goes negative and the layer pays
// out more than they ever staked. `deductionOnShare` therefore caps at the share
// itself. A refusal would be the purer answer, and it is the WRONG one here: the
// clamp only bites when the odds-proportional scale pushes a declared figure past
// the payout, and a refusal would HOLD a race whose winner has been decided and
// whose losing backers have all lost. The clamp is recorded (`clamped: true`)
// rather than applied silently, because a clamp that leaves no trace is
// indistinguishable from the declared value and this row is what an auditor reads
// when the numbers do not add up.
const { httpError } = require('./auth');

// ── The unit vocabulary ──────────────────────────────────────────────────────
//
// CLOSED, for the reason lib/datasources.js closes `permits`: an open vocabulary
// is a value stored and never policed. `toBasisPoints` is the ONE place a declared
// figure becomes the integer the money path uses, so a second unit table could not
// disagree with this one.
//
// `max` is the unit's own range and is checked BEFORE conversion, so `percent: 300`
// is refused as out of range rather than converted to 30000 bp and then refused as
// "above full". Both are refusals; the first names the unit's range, which is what
// the operator reading the error needs.
const PERCENT = 'percent';
const FRACTION = 'fraction';
const UNITS = Object.freeze({
  // A whole-number percentage. betr's schedule is printed this way: "27%".
  [PERCENT]: { toBasisPoints: (v) => Math.round(v * 100), max: 100 },
  // A fraction of one. `0.27` is the same 27% — but a feed that sends `0.27`
  // while meaning a PERCENTAGE is off by a hundred, and it cannot be told apart
  // from a feed that means what it said. That is why the unit is declared rather
  // than inferred: both readings are legal, so neither may be guessed.
  [FRACTION]: { toBasisPoints: (v) => Math.round(v * 10000), max: 1 },
});
const UNIT_NAMES = Object.freeze(Object.keys(UNITS));

// The payout shape a declaration is FOR. betr's schedule has separate columns for
// win, three-place and two-place; GRV has separate WIN and PLACE tables. A
// deduction is a number about a SHAPE, so applying a place figure to a win payout
// is arithmetically wrong and is refused rather than attempted.
const WIN = 'win';
const PLACE = 'place';
const SCOPES = Object.freeze([WIN, PLACE]);

// 100% in basis points. The ceiling on every applied figure, and the reason a
// declared figure is stored as an INTEGER of ten-thousandths rather than a float:
// the arithmetic that moves money is integer arithmetic everywhere else in this
// codebase (see `liabilityOf`), and a percentage that arrives as 0.1 + 0.2 should
// not be the one place it does not.
const FULL_BP = 10000;

// ── The three recorded states ────────────────────────────────────────────────
//
// A CLOSED vocabulary with a CHECK in the schema, for the reason the states exist
// at all: `result_events.deduction_state` is what makes "settled a race with no
// declared deduction" a NUMBER rather than an absence. An open column would let a
// caller write a fourth state that nothing counts.
const UNDECLARED = 'undeclared'; // a withdrawal settled, and nothing was declared
const DECLARED = 'declared'; // applied, and recorded exactly
const REJECTED = 'rejected'; // refused, and named
const STATES = Object.freeze([UNDECLARED, DECLARED, REJECTED]);

// ── Rejection codes ──────────────────────────────────────────────────────────
//
// Named, enumerated, and never collapsed into "invalid". A refusal an operator
// cannot act on is a refusal they will route around, and each of these has a
// different remedy: fix the unit, fix the figure, fix the scope, or stop sending
// a deduction for a runner nobody withdrew.
const R = Object.freeze({
  NOT_A_LIST: 'deduction_not_a_list',
  ENTRY_NOT_AN_OBJECT: 'deduction_entry_not_an_object',
  UNIT_MISSING: 'deduction_unit_missing',
  UNIT_UNKNOWN: 'deduction_unit_unknown',
  VALUE_MISSING: 'deduction_value_missing',
  VALUE_NOT_A_NUMBER: 'deduction_value_not_a_number',
  VALUE_NEGATIVE: 'deduction_value_negative',
  VALUE_NOT_FINITE: 'deduction_value_not_finite',
  OUT_OF_RANGE: 'deduction_out_of_range',
  ABOVE_FULL: 'deduction_above_full',
  SCOPE_UNKNOWN: 'deduction_scope_unknown',
  SCOPE_NOT_APPLICABLE: 'deduction_scope_not_applicable',
  NOT_FOR_A_WITHDRAWN_RUNNER: 'deduction_not_for_a_withdrawn_runner',
  WITHOUT_WITHDRAWAL: 'deduction_without_withdrawal',
  SELECTION_ID_INVALID: 'deduction_selection_id_invalid',
});
const REJECTION_CODES = Object.freeze(Object.values(R));

function reject(code, message, extra = null) {
  return extra ? { code, message, ...extra } : { code, message };
}

/**
 * Read a signal's declaration.
 *
 * Returns `{ state, declarations, rejects }` and NEVER THROWS. A feed signal is
 * data, and a data problem must not become an exception out of the middle of a
 * poll that has nineteen good markets behind it — the caller decides what a
 * rejection means for its path (HELD on a settlement, recorded on a withdrawal
 * notice), and that decision belongs beside the money rather than in here.
 *
 * `undeclared` is a STATE and not an error: most feeds send no deduction at all,
 * and a signal that carries none is exactly as valid as one that carries a wrong
 * one. It is the difference between "the stewards said nothing" and "the stewards
 * said something unusable" that the caller has to be able to see, so the two are
 * never collapsed — collapsing them is the bug this function exists to prevent.
 */
function parse(signal) {
  const raw = signal && signal.deductions;
  // ABSENT. Not `undefined`-only: a null, a missing key, and an empty list are all
  // the same fact — nobody declared anything — and none of them is a malformed
  // declaration. `deductions: []` in particular is what a well-behaved feed sends
  // when there is no deduction, and refusing it would hold a finished race.
  if (raw === null || raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
    return { state: UNDECLARED, declarations: [], rejects: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      state: REJECTED,
      declarations: [],
      rejects: [reject(
        R.NOT_A_LIST,
        `deductions must be a list of declarations, got ${typeof raw}. A bare number has no unit and ` +
          'no runner attached to it, so there is nothing it could safely be applied to.',
        { received: typeof raw }
      )],
    };
  }
  const declarations = [];
  const rejects = [];
  for (const [i, entry] of raw.entries()) {
    const at = `deductions[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      rejects.push(reject(R.ENTRY_NOT_AN_OBJECT, `${at} must be an object naming a runner, a unit and a value`));
      continue;
    }
    // THE RUNNER. Strictly a positive integer, and it must be a runner this signal
    // withdrew: `Number(true) === 1`, so a coerced id would attach a real runner's
    // deduction to somebody else's, which is the same laundering #61 found in
    // releaseHold and lib/settle.js refuses to repeat for dead-heat winners.
    const sel = entry.selection_id;
    if (typeof sel !== 'number' || !Number.isInteger(sel) || sel <= 0) {
      rejects.push(reject(R.SELECTION_ID_INVALID, `${at}.selection_id must be a positive integer`, { received: sel }));
      continue;
    }
    // THE UNIT. Required, closed, and checked BEFORE the value, because a figure
    // with no unit cannot be range-checked either: 0.27 is in range for a fraction
    // and out of range for a percent, so the order of these two checks decides
    // which error the operator sees.
    const unit = entry.unit;
    if (unit === undefined || unit === null || unit === '') {
      rejects.push(reject(
        R.UNIT_MISSING,
        `${at} declares a deduction with no unit. Say which: ${UNIT_NAMES.map((u) => `"${u}"`).join(' or ')}. ` +
          'A bare number is refused because the readings differ by a factor of 100 — "27" is 27% as a ' +
          'percent and 0.27% if the sender meant a fraction.',
        { selection_id: sel }
      ));
      continue;
    }
    if (typeof unit !== 'string' || !Object.prototype.hasOwnProperty.call(UNITS, unit)) {
      rejects.push(reject(
        R.UNIT_UNKNOWN,
        `${at}.unit must be one of ${UNIT_NAMES.map((u) => `"${u}"`).join(', ')}; got ${JSON.stringify(unit)}. ` +
          'This venue does not convert between units: a figure in the wrong unit is the whole failure this check exists for.',
        { selection_id: sel, received: unit }
      ));
      continue;
    }
    // THE VALUE. Coercion is refused, not performed. `Number("27") === 27`, so a
    // quoted figure that became 27 by accident would be indistinguishable from a
    // declared one — and the audit row would record a number the stewards never
    // said. Dropping it silently would leave the market settled at full payout
    // with a malformed figure quietly discarded, which is the exact outcome this
    // module exists to prevent.
    const value = entry.value;
    if (value === undefined || value === null) {
      rejects.push(reject(R.VALUE_MISSING, `${at}.value is required`, { selection_id: sel, unit }));
      continue;
    }
    if (typeof value !== 'number' || Number.isNaN(value)) {
      rejects.push(reject(R.VALUE_NOT_A_NUMBER, `${at}.value must be a number, not ${JSON.stringify(value)}`, { selection_id: sel, unit }));
      continue;
    }
    if (!Number.isFinite(value)) {
      rejects.push(reject(R.VALUE_NOT_FINITE, `${at}.value must be finite; got ${value}`, { selection_id: sel, unit }));
      continue;
    }
    if (value < 0) {
      // NAMED SEPARATELY from a generic range check. A NEGATIVE deduction is not a
      // figure that is too small; it is a figure that would PAY THE SURVIVING
      // RUNNERS' BACKERS EXTRA, straight out of the layers' liability. That is the
      // most expensive direction this input can be wrong in, and it deserves its
      // own code so it can be alerted on by itself.
      rejects.push(reject(
        R.VALUE_NEGATIVE,
        `${at}.value is negative (${value}). A deduction below zero would PAY the backers of surviving ` +
          'runners rather than charge them, which is a payout the stewards did not authorise.',
        { selection_id: sel, unit, received: value }
      ));
      continue;
    }
    if (value > UNITS[unit].max) {
      rejects.push(reject(
        R.OUT_OF_RANGE,
        `${at}.value ${value} is outside the range of "${unit}" (0 to ${UNITS[unit].max})`,
        { selection_id: sel, unit, received: value }
      ));
      continue;
    }
    const bp = UNITS[unit].toBasisPoints(value);
    if (bp <= 0) {
      // A declared deduction of exactly zero. It is ACCEPTED, and it is applied as
      // nothing, because a published schedule really does say "no deduction" for a
      // withdrawn runner at 15.00 or over — GRV's first band. Refusing it would
      // hold a race the stewards have expressly said needs no deduction, and the
      // difference between "declared zero" and "declared nothing" is the difference
      // between a record and a gap.
      declarations.push({
        selection_id: sel,
        unit,
        scope: WIN,
        declared_value: value,
        pct_bp: 0,
        declared_by: readDeclaredBy(entry),
      });
      continue;
    }
    if (bp > FULL_BP) {
      rejects.push(reject(
        R.ABOVE_FULL,
        `${at}.value ${value} is ${bp / 100}% — a deduction cannot exceed 100% of the winnings it is taken from`,
        { selection_id: sel, unit, received: value }
      ));
      continue;
    }
    // THE SCOPE. Defaults to `win` because a venue that settles one shape settles
    // the win, and a declaration that names its scope explicitly is the better
    // input. Anything else is refused rather than ignored: a `place` figure applied
    // to a win payout is a different number, and silently skipping it would leave
    // the venue paying full and the operator believing a deduction was in force.
    let scope = entry.scope;
    if (scope === undefined || scope === null) scope = WIN;
    if (typeof scope !== 'string' || !SCOPES.includes(scope)) {
      rejects.push(reject(
        R.SCOPE_UNKNOWN,
        `${at}.scope must be one of ${SCOPES.map((s) => `"${s}"`).join(', ')}; got ${JSON.stringify(scope)}`,
        { selection_id: sel, unit, received: scope }
      ));
      continue;
    }
    declarations.push({
      selection_id: sel,
      unit,
      scope,
      declared_value: value,
      pct_bp: bp,
      declared_by: readDeclaredBy(entry),
    });
  }
  if (rejects.length > 0) {
    // A SIGNAL is rejected as a whole when any element of it is refused, not
    // partly applied. The alternative — drop the bad element and apply the rest —
    // is the "repairing a malformed feed signal is not the same as refusing it"
    // line lib/voidrules.js already wrote about withdrawn runners: the venue would
    // end up applying a figure the feed did not clearly assert as the whole
    // deduction, and the audit row would record a decision nobody made.
    return { state: REJECTED, declarations: [], rejects };
  }
  return { state: DECLARED, declarations, rejects: [] };
}

// Free text naming WHO declared the deduction — the stewards, an operator, a feed.
// Trimmed and length-capped rather than trusted: it lands in a JSON payload on a
// provenance row, and `declared_by` is the answer to "under whose authority was
// this race settled" months later. Absent stays absent (null) so a reader can tell
// "nobody said" from "nobody was asked".
function readDeclaredBy(entry) {
  const raw = entry.declared_by;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 200);
  return trimmed.length ? trimmed : null;
}

/**
 * Refuse a deduction that does not attach to a withdrawal, or to a runner this
 * signal withdrew.
 *
 * Separate from `parse` because it needs the withdrawal list, and because these
 * two are about the CONTEXT rather than the figure: a well-formed 27% attached to
 * a runner nobody withdrew is not a malformed declaration, it is a different
 * question. Applying it would take money out of a race where nothing was
 * scratched.
 */
function checkAttachment(declarations, withdrawnIds) {
  const withdrawn = new Set(withdrawnIds || []);
  const rejects = [];
  for (const d of declarations) {
    if (!withdrawn.has(d.selection_id)) {
      rejects.push(reject(
        R.NOT_FOR_A_WITHDRAWN_RUNNER,
        `A deduction was declared for selection ${d.selection_id}, which this outcome did not withdraw ` +
          `(${withdrawn.size ? withdrawnIds.join(', ') : 'no runner was withdrawn'}). A deduction is a charge on ` +
          'the runners that survived a scratching, so there is nothing for this one to attach to.',
        { selection_id: d.selection_id }
      ));
    }
  }
  return rejects;
}

/**
 * The scope a market actually settles.
 *
 * READ FROM THE MARKET ROW, not from the signal. A market declared `place` is not
 * settled by this engine at all — lib/results.js holds it — so a `place`
 * declaration on a `win` market is a figure for a shape nobody is pricing, and it
 * is refused rather than applied or ignored.
 */
function scopeNotApplicable(declarations, payoutShape) {
  const shape = payoutShape || WIN;
  return declarations
    .filter((d) => d.scope !== shape)
    .map((d) => reject(
      R.SCOPE_NOT_APPLICABLE,
      `A deduction was declared for the "${d.scope}" payout and this market is a "${shape}" market. ` +
        'Published schedules carry separate win, place and each-way tables, so the figures are not ' +
        'interchangeable; the venue refuses rather than apply the wrong one or drop it silently.',
      { selection_id: d.selection_id, declared_scope: d.scope, market_shape: shape }
    ));
}

/**
 * The shortest price on offer among the runners that are STILL IN THE MARKET.
 *
 * THE REFERENCE FOR THE PROPORTIONAL SCALE. WA 4A applies the deduction to each
 * remaining runner PROPORTIONAL TO THE ODDS AGAINST THAT RUNNER, which needs a
 * denominator: the shortest surviving price is the one that absorbed the least of
 * the withdrawn runner's chance, so the declared figure is applied at face value
 * there and scaled up for everything longer. A single surviving runner is its own
 * reference and pays the declared figure unscaled, which is the ordinary case.
 *
 * NULL, NOT ZERO, when no surviving runner has a price: the drift tick only moves
 * `fair_price` when it is switched on, so a venue that has never run it has NULL
 * prices and a reference cannot be computed. Returning zero here would divide by
 * zero and produce a deduction of nonsense; returning null makes the caller apply
 * the declared figure UNSCALED and RECORD that it did, which is both the honest
 * fallback and a countable thing — see `overview().counts.applied_without_odds_scale`.
 */
function referencePriceCents(db, marketId) {
  const row = db
    .prepare(
      `SELECT MIN(ROUND(fair_price * 100)) AS c
         FROM selections
        WHERE market_id = ? AND status = 'open' AND fair_price IS NOT NULL AND fair_price > 1`
    )
    .get(marketId);
  return row && row.c !== null && row.c > 100 ? Number(row.c) : null;
}

// The price on offer for ONE surviving runner, in integer hundredths. Integer
// hundredths rather than the float the column holds, because the scale in
// `resolveFor` DIVIDES by it and a price of 2.1 has no exact binary
// representation — rounding the price to a hundredth first means the scale is a
// function of the published price rather than of the float it happened to land on.
// It and `referencePriceCents` above are deliberately the SAME rounding, because
// the scale is a RATIO of the two and a mismatch between them would be a scale that
// moved when neither price did.
function priceCentsOf(db, selectionId) {
  const row = db
    .prepare("SELECT fair_price AS f FROM selections WHERE id = ? AND status = 'open'")
    .get(selectionId);
  if (!row || row.f === null || row.f === undefined || !(row.f > 1)) return null;
  return Math.round(row.f * 100);
}

/**
 * Turn accepted declarations into the scale to apply to each WINNING runner.
 *
 * `marketId` is the market being settled and `winners` is the winner SET — a single
 * id on the ordinary path, two on a dead heat. Returns
 *
 *   { by_selection: Map<selectionId, appliedBp>, applied: [...], unscaled: [...],
 *     declared_bp: <the composed figure, before the odds scale> }
 *
 * The `applied` array is what goes on the provenance row: for each winner, which
 * declarations were composed onto it, what they came to, what the odds made of
 * that, and whether the ceiling clamped it. A row that can answer "what was taken
 * off this payout, and on whose authority" is the difference between a settlement
 * and a rumour.
 *
 * MULTIPLE WITHDRAWALS ARE SUMMED, AND THE SUM IS NOT RE-BASED. Two runners
 * scratched at once is a real racing case, and a schedule that re-bases the odds
 * after each scratching is a real jurisdictional difference. The venue composes
 * what it is told and does not attempt the re-basing, because the re-basing IS the
 * scale — see the header. An operator whose jurisdiction re-bases declares the
 * composed figure as ONE declaration; the venue still applies exactly what it was
 * given. This is a stated limitation rather than a silent approximation, and it is
 * in docs/EXCHANGE_RULES.md next to the same sentence.
 */
function resolveFor(db, { marketId, declarations, winners }) {
  const bySelection = new Map();
  const applied = [];
  const unscaled = [];
  if (!Array.isArray(declarations) || declarations.length === 0) {
    return { by_selection: bySelection, applied, unscaled, declared_bp: 0 };
  }
  // The winner SET, normalised from whatever `settleTx` had. That is a single id on
  // the ordinary path and an array on the dead-heat path, and this function must not
  // care which. An earlier version read it as an array only, so `Array.isArray` was
  // false for EVERY single-winner settlement, the winner set came out empty, and
  // every declared deduction was applied to nobody while the market settled and the
  // books balanced exactly as happily. A silent no-op that the response does not
  // reveal is the worst kind: the operator sees a settled race, a declared figure on
  // the provenance row, and a payout reflecting neither.
  const winnerSet = Array.isArray(winners)
    ? [...new Set(winners)]
    : (winners === null || winners === undefined ? [] : [winners]);
  if (winnerSet.length === 0 || !Number.isInteger(marketId) || marketId <= 0) {
    return { by_selection: bySelection, applied, unscaled, declared_bp: 0 };
  }
  // Read the reference AFTER the withdrawal has been voided, which is the order
  // lib/results.js applies: `voidSelection` runs first, so the survivors are the
  // rows still `open` and the withdrawn runner can never set the denominator of the
  // scale that is being applied because of it.
  const reference = referencePriceCents(db, marketId);
  // Σ declared, and the SUM IS CAPPED HERE rather than only at application time.
  // Two declarations that come to more than the whole dividend are a fact about the
  // DECLARATION, and it belongs on the provenance row as such: an operator can then
  // see that the feed asked for 160% and the venue paid 100%, rather than
  // discovering the ceiling somewhere in a payout.
  const summedBp = declarations.reduce((s, d) => s + d.pct_bp, 0);
  const declaredBp = Math.min(summedBp, FULL_BP);
  const compositionClamped = summedBp > FULL_BP;
  for (const winnerId of winnerSet) {
    const winnerPrice = priceCentsOf(db, winnerId);
    let appliedBp = declaredBp;
    let scaled = false;
    let clamped = compositionClamped;
    if (reference !== null && winnerPrice !== null) {
      appliedBp = Math.round((declaredBp * winnerPrice) / reference);
      scaled = true;
      if (appliedBp > FULL_BP) {
        appliedBp = FULL_BP;
        clamped = true;
      }
    }
    if (appliedBp > 0) bySelection.set(winnerId, appliedBp);
    if (!scaled) unscaled.push(winnerId);
    applied.push({
      winner_selection_id: winnerId,
      applied_bp: appliedBp,
      declared_bp: declaredBp,
      composed_from: declarations.map((d) => ({
        selection_id: d.selection_id,
        unit: d.unit,
        scope: d.scope,
        declared_value: d.declared_value,
        pct_bp: d.pct_bp,
        declared_by: d.declared_by,
      })),
      // null rather than 0, and the difference is meaningful: 0 would say "the
      // odds made this nothing", which is a claim. `reference_price: null` says
      // the venue had no price to scale by, which is the truth.
      reference_price: reference === null ? null : reference / 100,
      winner_price: winnerPrice === null ? null : winnerPrice / 100,
      scaled,
      clamped,
    });
  }
  return { by_selection: bySelection, applied, unscaled, declared_bp: declaredBp };
}

/**
 * The deduction to take off ONE winning leg's share.
 *
 * THE ONLY ARITHMETIC IN THIS MODULE THAT TOUCHES MONEY, and it is here rather
 * than in lib/settle.js for one reason: the cash-out desk's realised-loss reading
 * recomputes the same share figure independently (lib/cashoutrisk.js) precisely so
 * it cannot drift from what was paid out. Two copies of this would be exactly the
 * duplication `liabilityOf` in lib/settle.js was extracted to kill, so there is one
 * copy and both call it.
 *
 * `shareCents` is what the backer would have been paid and the layer would have
 * lost — the dividend, floored the same way settlement floors it for a dead heat.
 * The deduction is a share OF that, so:
 *
 *   - it is taken from the WINNINGS and never from the stake. WA 4A applies the
 *     deduction to the amount payable to the holder, and taking it from the stake
 *     instead would charge a bettor who WON, which is not a deduction in any of
 *     the three published schedules;
 *   - it is FLOORED, matching the joint-favourite share. Rounding up would let a
 *     splitter round the venue's way on every leg, which is the same exploit
 *     commission rounding was fixed for;
 *   - it is CAPPED AT THE SHARE. This is the clamp, and it is why the payout
 *     cannot go negative: at a deduction of 100% the backer is paid nothing beyond
 *     their own stake returned and the layer keeps the whole liability, which is
 *     the extreme a published schedule can reach and a real one.
 */
function deductionOnShare(shareCents, appliedBp) {
  if (!Number.isInteger(shareCents) || shareCents <= 0) return 0;
  if (!Number.isInteger(appliedBp) || appliedBp <= 0) return 0;
  const raw = Math.floor((shareCents * Math.min(appliedBp, FULL_BP)) / FULL_BP);
  return Math.max(0, Math.min(raw, shareCents));
}

/**
 * The primitive defends itself.
 *
 * lib/settle.js calls this before it posts anything, for the reason
 * `cashoutPosition` carries its own market check: the money-moving function must
 * refuse a malformed figure at the point the money moves, not trust that its only
 * caller validated it. A future caller — a backfill script, an admin route, a
 * second feed — inherits the protection by existing rather than by remembering it.
 *
 * Throws a 400 with a message naming what is wrong, which is the shape the rest of
 * this repository's refusals use so an operator reading a log can act on it.
 */
function assertApplicable(declarations) {
  if (declarations === null || declarations === undefined) return;
  if (!Array.isArray(declarations)) {
    throw httpError(400, 'A deduction must be a list of declarations, or nothing at all');
  }
  for (const d of declarations) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      throw httpError(400, 'Each deduction must be an object');
    }
    if (typeof d.selection_id !== 'number' || !Number.isInteger(d.selection_id) || d.selection_id <= 0) {
      throw httpError(400, 'Each deduction must name a withdrawn runner by positive integer selection id');
    }
    if (typeof d.unit !== 'string' || !Object.prototype.hasOwnProperty.call(UNITS, d.unit)) {
      throw httpError(400, `Each deduction must declare a unit drawn from ${UNIT_NAMES.join(', ')}`);
    }
    if (!Number.isInteger(d.pct_bp) || d.pct_bp < 0 || d.pct_bp > FULL_BP) {
      throw httpError(400, `A deduction must be an integer of basis points between 0 and ${FULL_BP}`);
    }
    if (typeof d.scope !== 'string' || !SCOPES.includes(d.scope)) {
      throw httpError(400, `Each deduction must declare a scope drawn from ${SCOPES.join(', ')}`);
    }
  }
}

// ── The counts ───────────────────────────────────────────────────────────────
//
// THE VISIBILITY HALF, and it is a QUERY rather than a promise for the reason
// lib/datasources.js writes its own at length: a gap nobody can see is not a gap
// somebody is managing. Every function here reads `result_events`, which means the
// count cannot disagree with the settlement it is counting — there is one row per
// outcome and the state was written inside the outcome's own transaction.

// Every outcome that SETTLED a market that had a withdrawal in it.
//
// TWO PREDICATES, and both earn their keep. decision = 'settle' because the
// figure these counts exist to give an operator is MONEY OVERPAID, and money is
// only overpaid where something was SETTLED at full payout: a pre-off withdrawal
// refunds and settles nothing, and a market held because it is a place market this
// engine cannot price pays nobody. Counting either would put a number in front of
// an operator that does not correspond to a cent.
//
// deduction_state IS NOT NULL is the "there was a withdrawal" half, and it is a
// COLUMN rather than rule = 'non_runner' on purpose — which was the first version,
// and it was WRONG in a way worth recording. A completed race with a withdrawn
// runner records rule = 'non_runner'; a completed race with a withdrawn runner that
// ended in a DEAD HEAT records rule = 'dead_heat', because the market-level rule is
// the joint favourite and the withdrawal rides along with it (SETTLE_WITH_VOIDS in
// lib/voidrules.js). So a rule-based predicate skipped exactly the case where a
// short-priced outsider ties for first — where the deduction matters most and the
// stake is largest — and that race's overpayment was invisible in the number an
// operator reads to find out what the venue overpaid. The column says "this outcome
// raised a deduction question", which is the question the count is about.
const SETTLED_WITHDRAWALS = "SELECT * FROM result_events WHERE decision = 'settle' AND deduction_state IS NOT NULL";

/**
 * A withdrawal that settled and carried NO declared deduction.
 *
 * This is the number an Australian racing operator needs on a screen, because it
 * is the total the venue OVERPAID the backers of surviving runners on races where
 * nobody declared one. It is counted rather than refused for the reason the whole
 * module exists: refusing would strand the market, and a full refund on a finished
 * race is at least an honest mistake rather than a guess.
 */
function undeclaredCount(db) {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM (${SETTLED_WITHDRAWALS})
        WHERE deduction_state IS NULL OR deduction_state = 'undeclared'`
    )
    .get().c;
}

/**
 * A withdrawal whose deduction WAS declared, validated and applied.
 *
 * SETTLEMENT-SCOPED, like `undeclaredCount`, so the two are the same population
 * and an operator can read them against each other. A declaration RECORDED on a
 * pre-off notice is not in here: nothing was settled on it, and this is a count of
 * money moved. That declaration is on its provenance row, in full, and is the one
 * a settlement arriving later is free to state differently — which is the point of
 * validating twice.
 */
function declaredCount(db) {
  return db
    .prepare(`SELECT COUNT(*) AS c FROM (${SETTLED_WITHDRAWALS}) WHERE deduction_state = 'declared'`)
    .get().c;
}

/**
 * A withdrawal whose deduction was REFUSED, with the reason on the row.
 *
 * Counted separately from the other two because it is the one an operator has to
 * act on today: the market is either sitting in a hold or was settled without a
 * deduction the stewards asked for, and in both cases somebody owes somebody money
 * until a human says which way.
 */
function rejectedCount(db) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM result_events WHERE deduction_state = 'rejected'")
    .get().c;
}

/** The rejected declarations themselves, newest first, for the operator who has to fix one. */
function rejectedDeclarations(db, { limit = 200 } = {}) {
  return db
    .prepare(
      `SELECT id, market_id, source, decision, rule, reason, deductions_json AS deductions, at
         FROM result_events
        WHERE deduction_state = 'rejected'
        ORDER BY id DESC
        LIMIT ?`
    )
    .all(Math.min(Math.max(Number(limit) || 200, 1), 1000));
}

/**
 * Everything an operator needs on one screen.
 *
 * `unscaled` is reported separately and deserves its own line, because it is the
 * one number here that is a quality figure rather than a gap: a deduction that was
 * applied WITHOUT the proportional scale is correct arithmetic on an incomplete
 * price set, and an operator who wants the WA reading rather than the flat one
 * needs to know how often that happened.
 */
function overview(db) {
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM (${SETTLED_WITHDRAWALS})`)
    .get().c;
  const declared = declaredCount(db);
  const undeclared = undeclaredCount(db);
  const rejected = rejectedCount(db);
  // Counted by scanning the recorded application rather than by re-deriving it:
  // the row already says whether the scale was applied, so a recount can never
  // disagree with the settlement it is describing.
  let unscaled = 0;
  for (const row of db
    .prepare(`SELECT deductions_json AS d FROM (${SETTLED_WITHDRAWALS}) WHERE deduction_state = 'declared'`)
    .all()) {
    if (!row.d) continue;
    let parsed = null;
    try { parsed = JSON.parse(row.d); } catch { parsed = null; }
    if (parsed && parsed.applied && parsed.applied.some((a) => a.scaled === false)) unscaled += 1;
  }
  return {
    units: UNIT_NAMES,
    scopes: SCOPES,
    states: STATES,
    counts: {
      withdrawal_settlements: total,
      declared,
      undeclared,
      rejected,
      applied_without_odds_scale: unscaled,
      recorded_before_the_off: db
        .prepare("SELECT COUNT(*) AS c FROM result_events WHERE decision = 'void' AND deduction_state IS NOT NULL")
        .get().c,
    },
    note:
      'A withdrawal may CARRY a declared deduction; this venue never computes one. The scale is published ' +
      'per racing authority and declared by the stewards, and where the withdrawn runner is shorter than ' +
      'the scale covers WA 4A makes the outcome a steward decision to void all wagers and re-open the race ' +
      '- which no formula should guess at. A withdrawal with NO declaration is settled and COUNTED here ' +
      'rather than refused, because refusing would strand a finished race; a malformed one is refused and ' +
      'named, because a bad figure that silently became "no deduction" would be a full payout nobody ' +
      'authorised. declared and undeclared count SETTLEMENTS only, so they are the same population and ' +
      'read against each other; recorded_before_the_off counts withdrawal notices, which refund and settle ' +
      'nothing, and whose declarations are recorded on their own rows.',
  };
}

module.exports = {
  PERCENT,
  FRACTION,
  UNITS,
  UNIT_NAMES,
  WIN,
  PLACE,
  SCOPES,
  FULL_BP,
  UNDECLARED,
  DECLARED,
  REJECTED,
  STATES,
  R,
  REJECTION_CODES,
  parse,
  checkAttachment,
  scopeNotApplicable,
  resolveFor,
  deductionOnShare,
  assertApplicable,
  undeclaredCount,
  declaredCount,
  rejectedCount,
  rejectedDeclarations,
  overview,
};