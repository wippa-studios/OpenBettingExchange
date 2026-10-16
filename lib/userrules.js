'use strict';
// lib/userrules.js — a player's own automated betting, as a RECORD (#76).
//
// ── WHY THIS IS A TABLE AND NOT AN ENGINE ──────────────────────────────────
//
// The product framing, from #67: a rule is an *automated extension of a human's
// betting* — the orders they would have placed themselves without watching
// every race. That framing is the security model, not a slogan. It means:
//
//   - There is no expression, no script, no `eval`, no loop, no filesystem and
//     no network anywhere below this line. The condition is `op`, the threshold
//     is a number, and there is exactly one function that knows what those
//     mean. A schema column is the only way to be SURE of that; a review can
//     only confirm it.
//   - The thing that fires is the SAME placeOrder a person's click goes
//     through. Not a variant of it, not a fast path around it — the identical
//     function, with the identical validateOrder, the identical abuse gates and
//     the identical in-play bet delay. Every limit in lib/limits.js is per
//     USER, so a rule that ran anywhere else would be an unlimited account with
//     a small one attached.
//
// ── THE CONDITION, AND WHAT "CROSSING" MEANS ───────────────────────────────
//
// v1 is one condition: this runner's price goes below (or above) a threshold.
// #67 decided rules fire CONTINUOUSLY — on every evaluation while the
// condition holds — and that semantics, with its cool-down and its visible
// fire count, is #77.
//
// What ships HERE is the narrower of the two, and the narrowing is deliberate:
// one-shot per crossing, re-arming when the condition lifts.
//
// A crossing is one boolean of state, and it is the only piece of memory in
// the whole design. A rule that has not yet seen its condition hold is ARMED.
// The tick it observes the condition holding, it fires and DISARMS. The tick
// the condition lifts, it re-arms. So a price resting exactly on the threshold,
// or oscillating across it at the tick rate, places ONE order per genuine
// crossing rather than one per evaluation.
//
// This is the safe side of the difference and it is also the cheap one: state
// is one column, there is no cool-down to tune, and #77 replaces this with
// continuous semantics by changing one function and its tests. It is NOT the
// semantics #67 chose, and it should not be mistaken for them — see
// docs/EXCHANGE_RULES.md, which says so in the same words.
//
// ── WHY EVERY PRICE IS INTEGER LADDER CENTS ────────────────────────────────
//
// Two reasons, and the second is the one that bites. First, lib/odds.js already
// keeps all band arithmetic in cents because three independently-rounded float
// comparisons do not compose. Second: the condition is a STRICT comparison
// against a threshold, and at 2.00 in binary floating point the question "is
// this strictly below 2.00" has to have an answer that does not depend on
// which side of the representation boundary the value landed. Cents make the
// comparison total.
//
// The stored threshold is SNAPPED to the ladder on the way in. A rule whose
// threshold sits between ticks could never fire at a price the order itself
// could be placed at, which is a rule that exists and does nothing.
const config = require('./config');
const ODDS = require('./odds');
const { transaction } = require('./tx');
const { httpError } = require('./auth');
const { now } = require('./util');

// Required lazily, and only where used. lib/match.js requires limits.js at load
// and limits.js lazy-requires match.js, so the graph already has one deliberate
// cycle; this module sits above both and requires them normally.
const MATCH = () => require('./match');

// Is an evaluation already running on this process? See the re-entry guard in
// `evaluateSelection`. Declared here rather than inside the function because it
// has to survive across the nested placement its own crossing performs — a local
// would be false again by the time the inner call arrived, which is exactly the
// case the guard exists to catch.
let evaluating = false;

// Per USER, not per rule instance and not per market. Decided in #67.
// Read by createRule on every create, which is why it is a constant here rather
// than config: it is a product decision about the feature's shape, not an
// operator-tunable risk parameter, and an operator who could raise it would be
// able to un-cap the feature by editing a file that looks like configuration.
const MAX_RULES_PER_USER = 3;

// The price the rule's order is placed AT, given the price it observed.
//
// This is the one piece of derived state in v1 and it is worth being explicit
// about, because the obvious implementation is wrong in a way that costs the
// player money. The user wrote a threshold; the price that tripped it may be
// better OR worse than that threshold, and which one depends on the side.
//
//   back  → a HIGHER price is better. max(observed, threshold)
//   lay   → a LOWER  price is better. min(observed, threshold)
//
// So "back if the price drops below 2.00" places at 2.00, NOT at whatever the
// price happened to be — a gap of a hundred ticks under a fast market is a very
// different bet from the one that was asked for, and the naive "place at the
// observed price" would silently take it. Symmetrically, "lay if the price
// rises above 2.00" lays at 2.00. Where the observation is already the better
// price ("back if the price RISES above 2.00"), it is used as-is, because
// clamping to the threshold would throw away the improvement the trigger
// exists to capture.
//
// Read it as a LIMIT ORDER, which is what #67's own framing said these are: the
// threshold is the price the user is willing to do, and the observation only
// ever moves it in the user's favour. In no case does the rule place a price
// worse than the one they named.
//
// Both inputs are already ladder ticks (the observation arrives snapped, the
// threshold was snapped on the way in), so the max/min is a tick too. The
// snapToTick is therefore idempotent rather than corrective — it stays because
// a rule that can be stored directly (a migration, an operator script) must not
// be able to produce an off-ladder order.
function orderPriceCents(rule, observedCents) {
  return rule.side === 'back'
    ? Math.max(observedCents, rule.threshold_cents)
    : Math.min(observedCents, rule.threshold_cents);
}

// Does the condition hold at this price? Strict on both sides.
//
// Strict matters and not for tidiness: `>=` would make a rule whose threshold
// equals the price it is watching permanently true, and combined with
// continuous semantics that is an order per evaluation forever. The crossing
// semantics in #76 make that survivable rather than fatal, but the closed
// interval is not what "below" means.
function holds(rule, priceCents) {
  return rule.op === 'below' ? priceCents < rule.threshold_cents : priceCents > rule.threshold_cents;
}

// ── creation ───────────────────────────────────────────────────────────────

/**
 * Create a rule for `user`.
 *
 * Everything is validated HERE rather than at a route, because #78 owns the
 * management API and will add one. A cap enforced in the route is a cap that
 * the next caller does not have, and this function is the only way a rule can
 * come into existence.
 *
 * Runs in a transaction because the cap is a read followed by a write. Two
 * concurrent creates against a user on their third rule both read "2 live" and
 * both insert, and a cap that is only enforced when nobody is looking is not a
 * cap. The transaction takes the write lock at BEGIN IMMEDIATE, so the second
 * create blocks and then re-reads.
 */
function createRule(db, user, spec) {
  const { selection_id, op, threshold, side, stake_cents } = spec || {};

  // Boundary types are checked strictly and before anything is read, matching
  // validateOrder's discipline: a garbage selection_id must be a 400 that names
  // the field, not a TypeError surfacing as a 500 from three frames down.
  if (!Number.isInteger(selection_id)) throw httpError(400, 'selection_id must be an integer');
  if (op !== 'below' && op !== 'above') {
    throw httpError(400, 'op must be "below" or "above"');
  }
  if (side !== 'back' && side !== 'lay') {
    throw httpError(400, 'side must be "back" or "lay"');
  }
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw httpError(400, 'threshold must be a finite number');
  }
  // Range BEFORE the snap, for the reason lib/odds.js documents: snapToTick
  // clamps, so a threshold of 5000 would be silently stored as 1000 and the rule
  // would fire a long way from where the user pointed it.
  if (!ODDS.inLadderRange(threshold)) {
    throw httpError(400, 'threshold must be between 1.01 and 1000');
  }
  // The same bounds validateOrder enforces, and deliberately the SAME constants:
  // a stake a rule may promise is a stake a person may place, because it is
  // placed by the same call. Bounds that differ would mean a rule could request
  // an order the engine would then refuse.
  if (typeof stake_cents !== 'number' || !Number.isInteger(stake_cents) || stake_cents < config.MIN_STAKE_CENTS || stake_cents > config.MAX_STAKE_CENTS) {
    throw httpError(400, `Stake must be an integer between ${config.MIN_STAKE_CENTS} and ${config.MAX_STAKE_CENTS} cents`);
  }

  const sel = db
    .prepare(
      `SELECT s.id, s.fair_price, s.status AS selection_status, m.status AS market_status
       FROM selections s JOIN markets m ON m.id = s.market_id
       WHERE s.id = ?`
    )
    .get(selection_id);
  if (!sel) throw httpError(404, 'Selection not found');
  if (sel.market_status !== 'open') throw httpError(409, 'Market is not open');
  if (sel.selection_status !== 'open') throw httpError(409, 'Selection is not open');

  const thresholdCents = ODDS.priceToCents(ODDS.snapToTick(threshold));

  return transaction(db, () => {
    // THE CAP. Counted live rules for this USER and nothing else — not all
    // rules, not rules on this market, not rules created today. A user with
    // three live rules cannot create a fourth; a second user is unaffected.
    const live = db
      .prepare("SELECT COUNT(*) c FROM user_rules WHERE user_id = ? AND status = 'live'")
      .get(user.id).c;
    if (live >= MAX_RULES_PER_USER) {
      throw httpError(409, `You already have ${MAX_RULES_PER_USER} live rules. Remove one before adding another.`, {
        code: 'rule_limit_reached',
        limit: MAX_RULES_PER_USER,
      });
    }

    // ARMING IS DECIDED HERE, not at the first evaluation, and this is the one
    // genuinely debatable choice in the file.
    //
    // A rule created while its own condition ALREADY holds starts DISARMED. It
    // fires when the price next leaves the condition and comes back — a real
    // crossing.
    //
    // The alternative (arm it, so the next evaluation fires immediately) was
    // rejected because it converts "I want this bet when the price crosses" into
    // "I want this bet at some point", and those are different instructions. A
    // user setting a threshold below the current price has asked for a reaction
    // to a move, not for the bet that move already made. It is also the more
    // dangerous of the two: it means the FIRST tick after creation places an
    // order, so the user is betting before they have read the confirmation.
    //
    // The cost is stated rather than hidden: a rule created below its threshold
    // will not fire until the price goes back above it first. Someone who wants
    // the immediate bet sets the threshold above the current price.
    const nowCents = sel.fair_price === null || sel.fair_price === undefined
      ? null
      : ODDS.priceToCents(ODDS.snapToTick(sel.fair_price));
    const armed = nowCents === null ? 1 : (holds({ op, threshold_cents: thresholdCents }, nowCents) ? 0 : 1);

    const info = db
      .prepare(
        `INSERT INTO user_rules
           (user_id, selection_id, op, threshold_cents, side, stake_cents, status, armed, last_price_cents)
         VALUES (?, ?, ?, ?, ?, ?, 'live', ?, ?)`
      )
      .run(user.id, selection_id, op, thresholdCents, side, stake_cents, armed, nowCents);
    return getRule(db, Number(info.lastInsertRowid));
  });
}

function getRule(db, id) {
  return db.prepare('SELECT * FROM user_rules WHERE id = ?').get(id) || null;
}

function rulesFor(db, userId) {
  return db.prepare('SELECT * FROM user_rules WHERE user_id = ? ORDER BY id').all(userId);
}

function liveRuleCount(db, userId) {
  return db.prepare("SELECT COUNT(*) c FROM user_rules WHERE user_id = ? AND status = 'live'").get(userId).c;
}

// ── killing ────────────────────────────────────────────────────────────────

/**
 * Kill a rule. Immediate and irreversible.
 *
 * "Immediate" is the load-bearing word. #67 requires killing a rule to stop new
 * crossings "on the spot", and the only way that is true is if evaluation
 * READS status at evaluation time rather than caching a rule list — which is
 * why evaluateSelection queries live rules per selection and never holds one in
 * module state. Kill this rule and the next evaluation cannot see it.
 *
 * Orders already placed are NOT cancelled. They are ordinary orders now, resting
 * or matched, and they are the user's. Cancelling them here would be the engine
 * reaching into a position it did not open, and #78 owns the surface where a
 * user does that deliberately.
 *
 * The rule row is KEPT rather than deleted. orders.rule_id and matches reference
 * it, and a rule that vanishes takes the ability to explain its own fills with
 * it. Deletion, if it ever ships, is a separate concern from stopping the rule.
 */
function killRule(db, userId, ruleId, reason = null) {
  const rule = getRule(db, ruleId);
  if (!rule || rule.user_id !== userId) throw httpError(404, 'Rule not found');
  if (rule.status === 'killed') return rule; // idempotent
  db.prepare(
    "UPDATE user_rules SET status = 'killed', killed_at = datetime('now'), killed_reason = ? WHERE id = ?"
  ).run(reason, ruleId);
  return getRule(db, ruleId);
}

/**
 * Kill every LIVE rule belonging to `userId`.
 *
 * Called from lib/limits.js exclude(). #67 decides self-exclusion is "instant"
 * and that it "kills live rules on the spot", and the alternative — leaving them
 * live and relying on every future placement being refused — was rejected for a
 * specific reason: a rule that stays armed is a rule that wakes up when the
 * exclusion lapses. Permanent exclusions never lapse, but timed ones do, and a
 * player who self-excluded for a month and was quietly traded on the day it
 * ended would have a complaint that is entirely correct.
 *
 * Lazy-required from limits.js, which cannot require this module at load time:
 * this module requires match.js, match.js requires limits.js.
 */
function killAllFor(db, userId, reason = 'self-excluded') {
  const info = db
    .prepare(
      "UPDATE user_rules SET status = 'killed', killed_at = datetime('now'), killed_reason = ? WHERE user_id = ? AND status = 'live'"
    )
    .run(reason, userId);
  return info.changes;
}

// ── evaluation ─────────────────────────────────────────────────────────────

// ── WHERE EVALUATION IS CALLED FROM, AND WHY IT IS NOT A DRIFT TICK ─────────
//
// THIS IS THE WHOLE OF #87, and the sentence that decides where it lives is the
// one below. There are exactly TWO production callers, and both are a place where
// the VENUE'S OWN PRICE genuinely moved:
//
//   lib/drift.js      — the venue's own price walk moved `selections.fair_price`.
//   lib/match.js      — two parties crossed, and the venue recorded what it
//                       traded at on `selections.ltp`.
//
// NEITHER IS BEHIND A CONFIGURATION GATE, and that is the entire fix. The
// original code had exactly one production caller, inside `lib/drift.js`, and
// `lib/drift.js` is only STARTED when `DRIFT_ON` — which is
// `config.DRIFT_ENABLED && !config.FEED_ENABLED`. So on any venue running a
// licensed feed (which is the configuration a licensed venue runs, and the one
// #87 was filed about) the function below was never called once. No order was
// placed, no exception was raised, and nothing was logged. The rule row read
// `status='live', armed=1` forever, so the feature looked armed and did nothing.
//
// WHY THE ORIGINAL PLACEMENT WAS STILL RIGHT, and why being right about that
// was not enough. The comment it carried said: "evaluate where the price moves,
// never from a second source that might lag or be missed." That reasoning is
// sound and it is preserved exactly — every caller below is the WRITE of a
// price, not a reader of one, so there is still no second source and nothing can
// lag. What it never checked was whether the path CONTAINING the write can run.
// A control placed inside a disabled feature is not a control, and #87 is the
// sixth instance of that shape this repository has found (STATE.md §5).
//
// WHY THE TRADED PRICE IS A REAL PRICE SOURCE AND NOT A TICK. On a venue with
// the feed on, drift is force-disabled (a correct decision — see the block at the
// `DRIFT_ON` hoist in server.js: a random walk must not reprice a book whose
// prices it cannot see), so `fair_price` on a materialised market is CONSTANT and
// a rule watching only that column could never fire, whatever the hook. The venue
// still has one price it can prove it produced: the price two of its own
// participants crossed at. That is written to `selections.ltp` and to the trade
// tape by `recordTrades`, and it is the most defensible price a venue has — it
// is the only one backed by money that actually changed hands. Hooking there is
// what makes a rule on a feed-mode venue live rather than merely reachable.
//
// WHAT A RULE MAY NOW OBSERVE, stated plainly because two sources is two
// sources. A rule sees the venue's own price, from whichever of those two writes
// moved it. On a drifting venue it mostly sees `fair_price`; on a feed-mode venue
// it sees `ltp`. The two are not interchangeable and are not merged — nothing
// copies a traded price into `fair_price` or the reverse, because `fair_price` is
// the desk's anchor (lib/bots.js quotes the ladder around it) and rewriting it
// from a trade would make the house's quote depend on one player's order. What
// makes the mixture safe is the crossing state machine below rather than any
// property of the prices: an ARMED rule's condition is false at the price it was
// armed at, so re-observing any price on the same side of the threshold does
// nothing at all. A spurious crossing requires the observed price itself to
// change sides, which means the venue's price really did.
//
// NEITHER CALLER IS A BROWSER. There is no SSE hook, no client evaluation and no
// timer: an evaluation happens when the venue moves its own price and at no other
// time, so a rule cannot fire because somebody had a tab open and cannot fire
// twice per price event (see the re-entry guard below).

/**
 * Evaluate every LIVE rule watching `selectionId` at `price`.
 *
 * Called from the two places the venue's own price moves — see the block above.
 * Both call it INSIDE the transaction that writes the price. The placement
 * matters for a reason worth stating: the observation and the order it caused
 * must commit together, or a rolled-back price move would leave a rule armed
 * from a price that never happened — and it would then fire on the next move, on
 * a stale belief.
 *
 * NEVER RE-ENTERS. A crossing places an order through `placeOrder`, which sweeps
 * the book, which can itself move the traded price and call straight back in
 * here. One guard, one flag, and the inner call is a no-op that says so. This is
 * the control behind "without evaluating twice": one price event produces at most
 * one evaluation, however deeply its own order nests. The recursion terminates
 * on the flag alone rather than on an argument about how many orders a crossing
 * can produce.
 *
 * Returns the counts, always, for every rule considered:
 *
 *   considered  live rules watching this selection (killed rules are not seen)
 *   crossed     conditions observed to have just become true
 *   placed      orders actually created
 *   refused     crossings the engine refused — an insufficient balance, a
 *               daily cap, a suspended market, self-exclusion
 *
 * `crossed - placed = refused` always holds, which is what makes the loop's
 * behaviour checkable from outside it rather than inferred from a tally. The
 * re-entrant no-op keeps the invariant too: it reports zeros, and zero crossings
 * is zero crossings.
 */
function evaluateSelection(db, selectionId, price) {
  // Snap the observation the same way the ladder does, so a rule is compared
  // against the price the board will show rather than a raw float.
  const priceCents = ODDS.priceToCents(ODDS.snapToTick(price));

  // ── THE RE-ENTRY GUARD (#87) ────────────────────────────────────────────
  // See the note above. Held in module scope deliberately: it is the one piece
  // of process state in this file, it is not a cached read of anything (a value
  // read once and reused would be wrong the moment a rule is killed), and it is
  // always cleared in a `finally` so a refusal that threw cannot wedge the engine
  // with rule evaluation permanently switched off — which would be this same
  // defect wearing a different hat.
  if (evaluating) {
    return { considered: 0, crossed: 0, placed: 0, refused: 0, errors: [], reentered: true };
  }
  evaluating = true;

  // ONE transaction for the whole evaluation, so a rule's observation and the
  // order it placed are atomic together (see the note above). Per-rule failures
  // are caught INSIDE it and cannot abort the rest — a user with three rules
  // where one is broke gets the other two evaluated.
  try {
    return transaction(db, () => {
      const live = db
        .prepare("SELECT * FROM user_rules WHERE selection_id = ? AND status = 'live' ORDER BY id")
        .all(selectionId);

      const stats = { considered: live.length, crossed: 0, placed: 0, refused: 0, errors: [] };
      for (const rule of live) {
        const holding = holds(rule, priceCents);
        if (!holding) {
          // The condition lifted: RE-ARM. This is the only other write that
          // changes behaviour, and it is the half that makes the rule fire again
          // on the next crossing rather than once ever.
          db.prepare(
            "UPDATE user_rules SET armed = 1, last_price_cents = ?, last_error = NULL, last_error_at = NULL WHERE id = ?"
          ).run(priceCents, rule.id);
          continue;
        }
        if (!rule.armed) {
          // Already inside the condition. One-shot per crossing: observe and do
          // nothing. This is the line that stops an oscillating price from turning
          // a single rule into a stream of orders.
          db.prepare('UPDATE user_rules SET last_price_cents = ? WHERE id = ?').run(priceCents, rule.id);
          continue;
        }

        // THE CROSSING. Disarm FIRST, then place.
        //
        // Ordering is the control, and it is the opposite of the order that feels
        // natural. If the placement threw and the disarm came after, the rule
        // would still be armed on the next evaluation and would try again — every
        // tick, for as long as the condition holds. That is the retry loop #67
        // explicitly rejected: a rule with an insufficient balance must fail
        // CLOSED and stop, not hammer the engine until the balance arrives.
        //
        // Disarming first also means a partial failure inside the placement
        // (validateOrder refusing after the row was written — impossible today,
        // since it refuses before any write, and structured this way because that
        // is not a property worth relying on) leaves a rule that will not re-fire
        // on the same crossing.
        stats.crossed++;
        db.prepare('UPDATE user_rules SET armed = 0 WHERE id = ?').run(rule.id);

        try {
          // The SAME placement path a person's click takes. Not a variant:
          // MATCH().placeOrder is the function POST /api/orders calls, so
          // validateOrder, the in-play bet delay, the per-user abuse gates, the
          // escrow and the match all run for a rule exactly as they run for a
          // hand. The one addition is rule_id, which is what attributes the order
          // and what makes the #75 self-cross exception legible.
          MATCH().placeOrder(db, { id: rule.user_id }, {
            selection_id: rule.selection_id,
            side: rule.side,
            price: ODDS.centsToPrice(orderPriceCents(rule, priceCents)),
            stake_cents: rule.stake_cents,
            rule_id: rule.id,
          });
          stats.placed++;
          db.prepare(
            `UPDATE user_rules
                SET fire_count = fire_count + 1, last_price_cents = ?,
                    last_fired_at = datetime('now'), last_error = NULL, last_error_at = NULL
              WHERE id = ?`
          ).run(priceCents, rule.id);
        } catch (e) {
          // REFUSED. Recorded on the rule, counted, and — because the disarm
          // above already stands — not retried.
          //
          // The reason string is stored rather than logged only, because the
          // player has to be able to find out why their rule stopped trading.
          // #79's list surface and #81's audit trail both read this column.
          stats.refused++;
          const msg = String((e && e.message) || e).slice(0, 200);
          stats.errors.push({ rule_id: rule.id, error: msg });
          db.prepare(
            `UPDATE user_rules
               SET refusal_count = refusal_count + 1, last_price_cents = ?,
                   last_error = ?, last_error_at = datetime('now')
               WHERE id = ?`
          ).run(priceCents, msg, rule.id);
          console.warn(`[rules] rule ${rule.id} refused: ${msg}`);
        }
      }
      return stats;
    });
  } finally {
    // The flag comes down in a `finally`, never on the success path alone. An
    // evaluation that threw before its transaction unwound would otherwise leave
    // `evaluating` true for the life of the process, and every rule on the venue
    // would be silently inert from that point on — which is the #87 defect
    // reproduced by a different route, and invisible for the same reason: no
    // error, no log line, a rule row that still reads armed.
    evaluating = false;
  }
}

module.exports = {
  MAX_RULES_PER_USER,
  createRule,
  getRule,
  rulesFor,
  liveRuleCount,
  killRule,
  killAllFor,
  evaluateSelection,
  orderPriceCents,
  holds,
};