'use strict';
// lib/match.js — the matching engine (the heart of the exchange).
//
// Semantics (Betfair-correct, per PLAN):
//   - Back @P (stake S, backer-stake units): sweeps resting LAY offers with
//     Q >= P, HIGHEST Q first (best-for-taker), matched AT THE RESTING
//     order's price Q. Remainder rests as a back offer at P.
//   - Lay @Q (accepts backer stake S): sweeps resting BACK offers with
//     P <= Q, LOWEST P first (least liability), matched at the resting P.
//     Remainder rests as a lay offer at Q.
//   - Self-match guard: a user never matches their own resting order.
//   - Pot per match: s (backer) + (P-1)*s (layer); settlement pays the
//     winner side the pot (see lib/settle.js).
//
// Escrow contract (orders.frozen_cents is the per-order source of truth):
//   - orders.frozen_cents = the escrow held against the order's UNMATCHED
//     REMAINDER — exactly what a cancel (or settlement's auto-cancel)
//     releases. The MATCHED part's liability stays frozen in the wallet
//     ON TOP of the column until settlement releases it.
//   - Placement freezes escrowFor(side, price, stake) and sets the column
//     to the same amount.
//   - Every LAY fill of f at match price P (whether the lay order is the
//     taker or the resting side) adjusts the layer's wallet so it holds
//     exactly round((P-1)*f) [this fill's settlement liability] plus
//     escrowFor('lay', Q, remainder) [the still-unmatched remainder]:
//       delta = trackedRemEsc - round((P-1)*f) - escrowFor('lay', Q, remAfter)
//     delta > 0 -> release(delta); delta < 0 -> escrow(-delta) — the rare
//     1-cent top-up when per-fill rounding sums above the single
//     placement rounding (e.g. lay 100 @ 1.51 filled 50 + 50). The
//     column becomes the new remainder escrow.
//   - BACK fills move no money: the matched stake simply stays frozen
//     (the backer's pot contribution); the column shrinks with the
//     remainder.
//   - Invariant (THE contract): the wallet always holds, for every order,
//     its matched liability plus its tracked remainder escrow. So
//     settlement can never release more than is frozen, no cent is ever
//     stranded, and after a settle or void every participant's
//     frozen_cents returns to exactly 0.
//   - Why not simply release (Q-P)*f per fill, as this engine once did:
//     placement, match and settlement each round a liability ONCE, and
//     three independently rounded formulas do not compose —
//     round((Q-1)*S) - round((Q-P)*f) can land 1 cent above or below
//     round((P-1)*f) for perfectly reachable stakes, which either
//     permanently blocks settlement ('Settlement integrity error') or
//     strands the cent forever.
const { httpError } = require('./auth');
const { escrow, release, availableOf, getUser } = require('./ledger');
const { transaction, inTransaction } = require('./tx');
const { snapToTick, impliedProb } = require('./odds');
const { now } = require('./util');
const config = require('./config');
// Phase 1 abuse gates. limits.js lazy-requires this module inside exclude(),
// so the dependency is one-way at load time and there is no cycle.
const LIMITS = require('./limits');
// Audit is one-way: lib/audit.js requires only ./tx, so this cannot cycle.
const audit = require('./audit');
// The book-version handshake (#92). Its own module, and not a section of this
// file, for one reason: lib/inplay.js has to bump the market counter on a
// suspension, and inplay is required HERE lazily (gate()) while this module is
// required eagerly — so the shared half has to be something both can depend on
// without either of them depending on the other. lib/bookversion.js requires
// only ./auth and ./config, so there is no cycle to reason about at all.
const BOOKVERSION = require('./bookversion');
// In-play gate. Required lazily to keep the match <-> inplay dependency
// one-way at load time (inplay does not need the engine).
let INPLAY_GATE = null;
function gate() {
  if (!INPLAY_GATE) INPLAY_GATE = require('./inplay');
  return INPLAY_GATE;
}

// Prepared-statement cache, keyed per database handle: the board and the
// sweep re-run the same SQL constantly, and tests open one :memory:
// database per process, so a module-global statement would leak across
// databases. WeakMap lets a thrown-away db be collected with its stmts.
const stmtCache = new WeakMap();

function stmtsFor(db, key, sql) {
  let perDb = stmtCache.get(db);
  if (!perDb) {
    perDb = new Map();
    stmtCache.set(db, perDb);
  }
  let stmt = perDb.get(key);
  if (!stmt) {
    stmt = db.prepare(sql);
    perDb.set(key, stmt);
  }
  return stmt;
}

function getSelection(db, selectionId) {
  const sel = db
    .prepare(
      `SELECT s.id AS selection_id, s.market_id, s.name, s.status AS selection_status,
              m.status AS market_status, e.status AS event_status, e.id AS event_id
       FROM selections s
       JOIN markets m ON m.id = s.market_id
       JOIN events e ON e.id = m.event_id
       WHERE s.id = ?`
    )
    .get(selectionId);
  if (!sel) throw httpError(404, 'Selection not found');
  return sel;
}

// The one escrow formula. Back freezes the stake; lay freezes
// round((price-1) * stake) — single rounding point (house rule).
// Exported: cash-out's funding check and PKG3's bots quote with it too.
function escrowFor(side, price, stake) {
  return side === 'back' ? stake : Math.round((price - 1) * stake);
}

function validateOrder(db, user, { selection_id, side, price, stake_cents }) {
  if (side !== 'back' && side !== 'lay') throw httpError(400, 'side must be "back" or "lay"');
  // Boundary types are checked strictly (W4): an undefined/garbage
  // selection_id must be a 400, not a TypeError bubbling up as a 500.
  if (!Number.isInteger(selection_id)) throw httpError(400, 'selection_id must be an integer');
  // Type-strict boundary (house lesson: Number('1')/Number(true) coercion slips).
  if (typeof stake_cents !== 'number' || !Number.isInteger(stake_cents) || stake_cents < config.MIN_STAKE_CENTS || stake_cents > config.MAX_STAKE_CENTS) {
    throw httpError(400, `Stake must be an integer between ${config.MIN_STAKE_CENTS} and ${config.MAX_STAKE_CENTS} cents`);
  }
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw httpError(400, 'Price must be a number');
  }
  const stake = stake_cents;
  const p = snapToTick(price);
  // Redundant backstop: snapToTick already clamps to [1.01, 1000]. Kept as
  // a boundary guard so a future ladder change fails loudly here at the
  // API edge instead of deep in the ledger.
  if (!(p >= 1.01 && p <= 1000)) throw httpError(400, 'Price out of range');
  const sel = getSelection(db, selection_id);
  if (sel.market_status !== 'open') throw httpError(409, 'Market is not open');
  if (sel.selection_status !== 'open') throw httpError(409, 'Selection is not open');
  if (sel.event_status === 'completed') throw httpError(409, 'Event is completed');
  // In-play gate. A SUSPENDED market accepts nothing — that is the control
  // that stops a sharp trading the venue's reaction latency during a goal, so
  // it is checked before anything else touches money. An in-play market with no
  // suspension additionally reports WHEN the order becomes matchable; the
  // engine matches immediately and the delay is enforced by the venue's
  // matching pass, which is what lib/inplay.js schedules.
  gate().assertNotSuspended(db, sel.market_id);
  // OFF-TIME GATE. The primary control now that the venue is pre-off-only: no
  // order may be placed at or after the event's off time, whatever the market's
  // own status says. Placed immediately after the status checks and BEFORE any
  // collateral is touched, so a post-off order is refused before it can freeze
  // anything. The existing event_status/market_status checks still run — an
  // admin-suspended market is closed early — but the off time is the backstop
  // that closes the market on its own even with no feed and no suspension
  // driver. See lib/offtime.js for why pre-off-only is the product decision.
  const offtime = require('./offtime');
  offtime.assertOffNotReached(db, sel.event_id);
  return { stake, price: p, sel };
}

// Apply one fill of `fill` cents at match price `price` to a LAY-side
// order (the taker's own lay, or a resting lay a back taker just matched).
// `lay` is an orders ROW (or row-like): snake_case `user_id` + `price`.
// Adjusts the layer's wallet per the escrow contract above and returns
// the order's new remainder escrow (its new frozen_cents).
// Is this order one a user's AUTOMATION placed, rather than a human?
//
// `rule_id` is the whole answer. NULL means manual, which is the default for
// every order that exists today and for every order a person places.
//
// Queried by id rather than read off the row already in hand because the
// SWEEP'S TAKER order is never in `resting` — it was inserted moments ago and is
// not selected by the same statement — so both sides of the comparison have to
// be read the same way. A cache would be wrong the moment an order is re-read
// after the rule that placed it was killed.
function automatedRuleId(db, orderId) {
  const row = db.prepare('SELECT rule_id FROM orders WHERE id = ?').get(orderId);
  return row && row.rule_id != null ? row.rule_id : null;
}

function isAutomatedOrder(db, orderId) {
  return automatedRuleId(db, orderId) !== null;
}

// Is this account one of the venue's own (the house bot), rather than a player?
//
// Separate from `isAutomatedOrder` on purpose: the two are independent facts
// and the no-house-participation rule in sweepAndFill needs BOTH. A house order
// is never automated (bots.js places no rules), and a player's automated order
// is never a house order, so reading one where the other is wanted would be a
// silent "no".
function isBotUser(db, userId) {
  const row = db.prepare('SELECT is_bot FROM users WHERE id = ?').get(userId);
  return !!(row && row.is_bot);
}

// ── Escrow arithmetic: one formula, one sign convention ─────────────────────
//
// The TIME IN FORCE vocabulary sits at the head of this section rather than
// with the lifecycle code because the sweep that enforces LAPSE reaches
// `cancelOrderTx`, and this is the section that owns what an order OWES.

const PERSIST = 'PERSIST';
const LAPSE = 'LAPSE';

/**
 * Read and validate a client-supplied `persistence` (#97) — how long this
 * venue keeps an UNMATCHED order.
 *
 * Before this, every order on this venue was GFD-ish: it rested until it
 * matched or somebody cancelled it, across the turn in-play like everything
 * else. That is a decision a trader could not make, which is why the only way
 * to be flat before an event started was to watch a clock and cancel by hand.
 *
 * STRICT, over a CLOSED vocabulary, for the reason lib/limits.js gives for
 * refusing a bad limit value: this is an instruction about MONEY, and the
 * engine either carries it out or refuses it. A value accepted and ignored
 * would be worse than one refused, which is exactly why `MARKET_ON_CLOSE` is
 * not in the set — this engine has no starting-price auction and no
 * `starting_price` field, so storing it would be a promise with nothing behind
 * it.
 *
 * ABSENT means `PERSIST`, and that is not a convenience default: it is this
 * venue's ENTIRE previous behaviour, so a client that says nothing gets the
 * version it got before #97, byte for byte. It is also why the column's own
 * DEFAULT is honest — an order nobody expressed a persistence for IS a persist
 * order, and a database upgrading into this feature has every pre-existing row
 * already correct.
 */
function readPersistence(raw) {
  if (raw === undefined || raw === null) return PERSIST;
  if (raw === LAPSE || raw === PERSIST) return raw;
  throw httpError(400, `persistence must be "${LAPSE}" or "${PERSIST}"`);
}

// THE ONE PLACE A REMAINDER-ESCROW CHANGE MOVES MONEY, and the single sign
// convention that goes with it (#97).
//
// `held` is what the wallet currently holds against this order's unmatched
// remainder — which is always exactly orders.frozen_cents, read inside the
// transaction — and `target` is what it must hold once this step is done.
// Positive `delta` is the layer/backer being asked for MORE collateral, so it
// is escrowed; negative releases. Returns `target`, which is what the caller
// writes to the column.
//
// WHY IT IS A FUNCTION AND NOT TWO CALL SITES. The FILL path and the AMEND path
// are the same operation with different targets, and before #97 each had its
// own copy of "if delta > 0 escrow else release". A sign convention duplicated
// on a money path is a cent that gets released when it should have been frozen,
// and this engine has already lost one that way twice (E14/E15: the release
// rule was right about the magnitude and wrong about which side of the fill it
// belonged to). One function means a future third caller cannot get it wrong,
// and a test that pins the invariant pins both paths at once.
//
// The caller MUST pass `held` read inside the transaction, not a value carried
// in from outside it. That is the check-then-act boundary lib/limits.js and
// lib/bookversion.js both exist to keep: a `held` computed before the write lock
// is a check-then-act, and two concurrent amends would both release against the
// same stale escrow.
function holdRemainderEscrow(db, userId, held, target, ref) {
  const delta = target - held;
  if (delta > 0) escrow(db, userId, delta, ref);
  else if (delta < 0) release(db, userId, -delta, ref); // rare 1-cent top-up on the way up
  return target;
}

// What a lay-side step must hold in the wallet WHEN IT IS DONE.
//
//   a fill of `fill` at match price `price`:
//       this fill's settlement liability  +  the new remainder's escrow
//   an amend of a purely unmatched remainder:
//       (no fill, so no new liability)     +  the new remainder's escrow
//
// The second case is why this is not just the fill formula: an amend matched
// NOTHING, so it must not be charged a fill liability it did not incur, and it
// must not leave the matched part's existing liability disturbed — which is
// exactly what "target = escrowFor(side, price, newRemainder)" says.
//
// Extracted so the AFFORDABILITY CHECK, the ESCROW MOVEMENT and the AMEND cannot
// disagree: if the check computes a different target from the one that is later
// applied, the engine either refuses a fill it could have made, makes one it
// cannot pay for, or — on an amend — quietly takes back the wrong cent.
function layCollateralTargets(price, fill, remAfter, layPrice) {
  return {
    fillLiability: Math.round((price - 1) * fill),
    remEscAfter: escrowFor('lay', layPrice, remAfter),
  };
}

// The single rounding point for a lay fill, extracted so the AFFORDABILITY CHECK
// and the escrow MOVEMENT cannot disagree. They must: if the check computes a
// different delta from the one that is later applied, the engine either refuses
// a fill it could have made, or makes one it cannot pay for.
function layFillDelta(price, fill, remAfter, layPrice, remEscBefore) {
  const { fillLiability, remEscAfter } = layCollateralTargets(price, fill, remAfter, layPrice);
  return { delta: remEscBefore - fillLiability - remEscAfter, remEscAfter };
}

// What the wallet would have to be topped up by for this fill to be legal.
// 0 means the fill moves no new money. Positive means this layer must find
// `n` cents it does not currently have.
function layFillTopUp(price, fill, remAfter, layPrice, remEscBefore) {
  return Math.max(0, -layFillDelta(price, fill, remAfter, layPrice, remEscBefore).delta);
}

function applyLayFill(db, lay, fill, price, remBefore, remEscBefore, ref) {
  const { fillLiability, remEscAfter } = layCollateralTargets(price, fill, remBefore - fill, lay.price);
  holdRemainderEscrow(db, lay.user_id, remEscBefore, fillLiability + remEscAfter, ref);
  return remEscAfter;
}

// Sweep the opposite book and fill resting orders at THEIR price — best
// price first (highest lay for a back taker, lowest back for a lay
// taker), FIFO within a level (ORDER BY price, id). One fill touches two
// orders: the resting one, and the taker's own when the taker is the lay
// side. Returns { fills, remaining, remEsc }.
// `atTakerPrice` is the delay-release path: an order that rested through its
// bet delay is released into the book AS A MAKER, so it fills at the price IT
// asked for, never at a better one. Filling it at a counterparty's better
// price would hand the player money they did not ask for and silently change
// their position arithmetic.
function sweepAndFill(db, { sel, orderId, userId, side, price, stake, remEsc }, { atTakerPrice = false } = {}) {
  const layTaker = side === 'lay';
  const resting = layTaker
    ? stmtsFor(
        db,
        'rests-back',
        // A resting order still inside its in-play bet delay is NOT matchable:
        // the whole point of the delay is that a price moved by a goal does not
        // instantly meet an order placed before it. One of the two enforcement
        // points; the other is the taker gate in placeOrderTx.
        `SELECT * FROM orders
          WHERE selection_id = ? AND side = 'back' AND status = 'open' AND price <= ?
            AND (eligible_at IS NULL OR eligible_at <= datetime('now'))
          ORDER BY price ASC, id ASC`
      ).all(sel.selection_id, price)
    : stmtsFor(
        db,
        'rests-lay',
        `SELECT * FROM orders
          WHERE selection_id = ? AND side = 'lay' AND status = 'open' AND price >= ?
            AND (eligible_at IS NULL OR eligible_at <= datetime('now'))
          ORDER BY price DESC, id ASC`
      ).all(sel.selection_id, price);
  const insMatch = stmtsFor(
    db,
    'ins-match',
    'INSERT INTO matches (market_id, selection_id, back_order_id, lay_order_id, price, stake_cents, self_crossed) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const updResting = stmtsFor(
    db,
    'upd-resting',
    'UPDATE orders SET matched_cents = ?, frozen_cents = ?, status = ?, updated_at = ? WHERE id = ?'
  );
  const fills = [];
  let remaining = stake;
  // A user at their daily net-settlement cap must not be matched EITHER way.
  // The taker path has always consulted this; the resting side did not, so a
  // capped user's order sat in the book and was matched by the next arrival —
  // the cap defeated by resting instead of taking. The delay-release pass
  // already checks it (see releaseDelayed), which is why the gap was so easy to
  // miss: two of the three sweeps honoured the cap and the busiest did not.
  //
  // Memoised per user for the sweep: matchingAllowed runs a SUM over today's
  // settlements, and a book with fifty resting orders would otherwise run it
  // fifty times per sweep to answer the same question about the same people.
  const capMemo = new Map();
  const mayRest = (uid, marketId) => {
    const key = `${uid}:${marketId}`;
    if (!capMemo.has(key)) capMemo.set(key, LIMITS.matchingAllowed(db, uid, marketId));
    return capMemo.get(key);
  };
  // Is the TAKER's own order automated? Read once per sweep, not per resting
  // order: it is a property of the taker, and re-reading it inside the loop
  // would let a future bug move it.
  const takerRuleId = automatedRuleId(db, orderId);
  const takerAutomated = takerRuleId !== null;
  // Is the TAKER a venue account rather than a player? Read once per sweep, for
  // the same reason the rule id is: it is a property of the taker, and asking
  // it again inside the loop would let a future bug answer it differently.
  const takerIsBot = isBotUser(db, userId);
  // Memoised per user for the same reason capMemo is: `is_bot` is a users read,
  // and a sweep across a quoted book would otherwise repeat it per order. Only
  // consulted when automation is actually involved (see below), so the ordinary
  // no-rules sweep pays nothing at all.
  const botMemo = new Map();
  const isBotUid = (uid) => {
    if (!botMemo.has(uid)) botMemo.set(uid, isBotUser(db, uid));
    return botMemo.get(uid);
  };
  // Read the house flag only when the sweep can actually be one that needs it:
  // a taker that is automated, or a taker that IS the house. Every other sweep
  // — which is every sweep on a venue with no rules, and all but one of them
  // on a venue with rules — skips the whole question.
  const houseRelevant = takerAutomated || takerIsBot;
  for (const o of resting) {
    if (remaining === 0) break;
    let selfCrossed = false;
    // NO HOUSE PARTICIPATION IN AN AUTOMATED ORDER (#67).
    //
    // Decided: "lib/bots.js must not fill an automated order". Read from BOTH
    // directions, because "the house must not fill" is only half of it — a rule
    // that takes the house's resting quote has been filled BY the house at a
    // price the house chose, which is the same conflict of interest with the
    // words reversed. So the single condition is: exactly one side is the house
    // AND exactly one side is automated -> refuse. Two players, or a house
    // against a manual order, are untouched.
    //
    // Neither #75 nor anything before it enforced this. That issue built the
    // guard's same-user exception and, as a consequence, made an automated order
    // matchable by ANY other user in the book — which on this venue means the
    // house bot, the only other participant. Left unenforced, every rule order
    // the bot requote passed would have been taken by the desk within a tick.
    // It is a `continue`, so it can only ever refuse a crossing: it cannot
    // loosen the self-match guard below, which still runs untouched.
    // Read ONCE per resting order, here, and BOTH questions below use it. Two
    // reads of the same fact in one function is how a future edit ends up
    // deciding them differently, and one of them is the self-match guard.
    //
    // The condition is `sameUser || houseRelevant` and NOT `houseRelevant`
    // alone, and the first version of this read `houseRelevant` only. That
    // silently DISABLED the #75 self-cross exception: a manual order taker
    // against an automated resting order of the same user computed
    // restingAutomated as false from a value it had never read, so the guard
    // saw two manual orders and blocked the crossing #75 exists to permit.
    // tests/selfcross.test.js S1, S6 and S7 caught it immediately — which is
    // the argument for leaving them behavioural rather than structural.
    //
    // When neither applies the read is genuinely skipped, so the ordinary
    // sweep — neither side automated, neither the house — pays nothing.
    const sameUser = o.user_id === userId;
    const restingRuleId = sameUser || houseRelevant ? automatedRuleId(db, o.id) : null;
    const restingAutomated = restingRuleId !== null;
    if (houseRelevant && isBotUid(o.user_id) !== takerIsBot && (takerAutomated || restingAutomated)) continue;
    if (sameUser) {
      // THE SELF-MATCH GUARD, AND ITS ONE DELIBERATE EXCEPTION (#75).
      //
      // The guard exists so a user cannot manufacture volume or P&L that no
      // real counterparty produced. It blocks a user trading against themselves.
      //
      // A user's AUTOMATED order crossing that same user's MANUAL order is now
      // permitted, because it is the only liquidity available: the house does
      // not fill automated orders (#67), and until a second real player arrives
      // there is nobody else. That is a genuine weakening of the guard, and it
      // is implemented as an EXPLICIT, NARROW exception rather than by loosening
      // the comparison, so that what was given up is visible in the code:
      //
      //   PERMITTED  exactly one side is automated, both belong to this user
      //   BLOCKED    two manual orders of the same user — unchanged
      //   BLOCKED    two automated orders of the same user — still self-matching
      //
      // The last line is the one worth stating twice. Letting a user's rules
      // cross each other would be a far bigger hole than the one being opened
      // here, and it is not wanted.
      // restingRuleId / restingAutomated were read above for the house check, and
      // are reused here rather than re-read.
      if (!(takerAutomated !== restingAutomated)) continue;
      selfCrossed = true;
      // THE AUDIT RECORD. `matches.self_crossed` is the queryable marker; this is
      // the durable trail, because the question an auditor or a support agent
      // actually asks is "where did this fill come from", and it has to be
      // answerable from the log alone rather than by joining four tables.
      //
      // Both sides belong to `userId`, so that is the actor. The automated side's
      // rule id is in `after` because it is the fact that makes this fill
      // different, and without it the row cannot be tied back to a rule once
      // that rule is deleted (#81).
      audit.record(
        db,
        { id: userId },
        audit.ACTIONS.SELF_CROSSED,
        `user:${userId}`,
        null,
        { match_side: 'automated', rule_id: takerAutomated ? takerRuleId : restingRuleId, resting_order_id: o.id },
        'self-crossed: automated order filled by the same user\'s own liquidity'
      );
    }
    // Transient: a daily cap lifts at midnight, so the order is left RESTING
    // rather than cancelled. Same reasoning as the release pass — clearing it
    // would destroy an order over a limit that expires on its own.
    if (!mayRest(o.user_id, o.market_id)) continue;
    const avail = o.stake_cents - o.matched_cents;
    if (avail <= 0) continue;
    const fill = Math.min(remaining, avail);
    const at = atTakerPrice ? price : o.price; // the resting price stands, unless this is a release
    // A RESTING LAYER that cannot fund this fill is skipped, not allowed to fail
    // the sweep. Per-fill rounding means a layer's escrow can fall a cent short
    // of what the fill needs (lay 100 @ 1.51 filled 50 + 50 is the documented
    // case). Calling escrow() for it threw a 400 from inside this transaction,
    // which rolled back EVERY fill in the sweep — including fills already
    // settled against other players who had done nothing wrong. One player's
    // missing cent destroyed a stranger's trade.
    //
    // The check runs BEFORE the match row is written. Placing it after would
    // mean the insert happens and is then unwound, which is the current bug.
    //
    // The layer's order is left RESTING, not cancelled. It stays in the book and
    // matches as soon as the money is there, which is reversible and loses
    // nobody's position. Cancelling a player's order because they spent the
    // balance would be the worse outcome.
    if (o.side === 'lay') {
      const topUp = layFillTopUp(at, fill, avail - fill, o.price, o.frozen_cents);
      if (topUp > 0 && availableOf(getUser(db, o.user_id)) < topUp) continue;
    }
    insMatch.run(sel.market_id, sel.selection_id, layTaker ? o.id : orderId, layTaker ? orderId : o.id, at, fill, selfCrossed ? 1 : 0);
    const matched = o.matched_cents + fill;
    if (o.side === 'lay') {
      // Resting lay receives a fill: adjust its wallet escrow per contract.
      const escAfter = applyLayFill(db, o, fill, at, o.stake_cents - o.matched_cents, o.frozen_cents, { orderId: o.id, marketId: sel.market_id });
      updResting.run(matched, escAfter, matched >= o.stake_cents ? 'fully_matched' : 'open', now(), o.id);
    } else {
      // Resting back receives a fill: the matched stake stays frozen (the
      // backer's pot); the column shrinks with the remainder.
      updResting.run(matched, o.stake_cents - matched, matched >= o.stake_cents ? 'fully_matched' : 'open', now(), o.id);
    }
    if (layTaker) {
      // The taker's own lay order receives this fill too.
      remEsc = applyLayFill(db, { user_id: userId, price }, fill, at, remaining, remEsc, { orderId, marketId: sel.market_id });
    }
    remaining -= fill;
    fills.push({ price: at, stake_cents: fill });
  }
  return { fills, remaining, remEsc };
}

// Write the taker's own order state after the sweep: matched amount,
// status, and frozen_cents = the (still unmatched) remainder's escrow.
function finalizeTaker(db, { orderId, side, price, stake, remaining, sel }) {
  const matched = stake - remaining;
  const frozen = escrowFor(side, price, remaining); // back: remainder; lay: remainder liability
  const status = remaining === 0 ? 'fully_matched' : 'open';
  stmtsFor(
    db,
    'upd-taker',
    'UPDATE orders SET matched_cents = ?, frozen_cents = ?, status = ?, updated_at = ? WHERE id = ?'
  ).run(matched, frozen, status, now(), orderId);
  return matched;
}

// Trade tape: one price_history row per fill; LTP = last traded price;
// market volume += what this placement matched.
function recordTrades(db, sel, fills, matched) {
  if (fills.length === 0) return;
  const insHist = stmtsFor(db, 'ins-hist', 'INSERT INTO price_history (selection_id, price) VALUES (?, ?)');
  for (const f of fills) insHist.run(sel.selection_id, f.price);
  db.prepare('UPDATE selections SET ltp = ? WHERE id = ?').run(fills[fills.length - 1].price, sel.selection_id);
  db.prepare('UPDATE markets SET total_matched_cents = total_matched_cents + ? WHERE id = ?').run(matched, sel.market_id);
  // THE BOOK MOVED (#92), so the version moves with it.
  //
  // HERE rather than at each fill site because this function is already the one
  // place that means "something traded": it writes the tape, moves LTP and adds
  // the market's volume, and it returns early when nothing matched. A bump
  // placed at the INSERT INTO matches statement would have to be repeated in the
  // sweep, in the delay-release pass and in whatever future path fills an order,
  // and any of them missed would be a book that changed without saying so —
  // which is the exact failure this whole feature exists to make observable.
  //
  // ONCE PER PLACEMENT, not once per fill. A sweep can take five fills off five
  // resting orders; the client whose claim this defends learned one thing, which
  // is that the ladder it read is no longer the ladder it saw. Counting each
  // fill would advance the counter by five for one observable event and make the
  // threshold mean "fills" rather than "changes to the book".
  BOOKVERSION.bumpBookVersion(db, { marketId: sel.market_id, selectionId: sel.selection_id });
}

// ── In-play delay release ──────────────────────────────────────────────────
//
// The enforcement above makes a delayed order REST instead of matching on
// arrival. This is the other half: when the delay expires, the order has to be
// released INTO the book, or in-play trading is simply broken — an order would
// sit there forever because nothing sweeps it until a taker happens to arrive.
//
// It is released as a MAKER, filling at the price it asked for (see
// sweepAndFill's atTakerPrice), which is the conservative semantic: the player
// gets the price they were shown, never a surprise improvement.
//
// PER-ORDER transactions, deliberately. A batch-wide transaction would be
// atomic but fragile: one malformed order aborts the whole pass and every
// other due order waits for the next tick. Per-order means a bad order costs
// only itself.
function releaseEligibleOrders(db, { limit = 200 } = {}) {
  const due = db
    .prepare(
      `SELECT id FROM orders
        WHERE status = 'open'
          AND eligible_at IS NOT NULL
          AND eligible_at <= datetime('now')
          AND matched_cents < stake_cents
        ORDER BY eligible_at ASC, id ASC
        LIMIT ?`
    )
    .all(limit);
  if (due.length === 0) return { considered: 0, released: 0, filled: 0, skipped: 0 };

  const stats = { considered: due.length, released: 0, filled: 0, skipped: 0 };
  for (const { id } of due) {
    try {
      transaction(db, () => {
        const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
        if (!o) return;

        // ── THE eligible_at CLEAR IS DELIBERATELY LAST, NOT FIRST ─────────
        // It used to run before every gate below, justified as "a due order
        // that turns out to be unmatchable is still no longer DELAYED". That
        // is true for a TERMINAL condition and wrong for a TRANSIENT one, and
        // the difference is not academic:
        //
        //   - clear it on a suspension, and every order that came due during a
        //     feed outage silently loses its bet delay FOREVER. It then matches
        //     with no delay of its own, which is the sharp-protection control
        //     failing quietly and the venue misreporting its own latency.
        //   - clear it on an abuse-control refusal and the order leaves the
        //     delayed set entirely — and NULL means "immediately eligible", so
        //     the very next taker takes it. Skipping the sweep is not the same
        //     as refusing to trade, and writing the clear anyway turned a cap
        //     into a no-op.
        //
        // So: terminal conditions clear it (the state is genuinely finished and
        // nothing would ever clean it up), transient ones leave it alone (the
        // condition may lift and a later pass must still be able to act).
        const clearDelay = () => db.prepare('UPDATE orders SET eligible_at = NULL WHERE id = ?').run(o.id);

        if (o.status !== 'open' || o.matched_cents >= o.stake_cents) {
          // Terminal: cancelled, settled away, or filled by an earlier release
          // in this same pass. Stale state no query would ever clean up.
          clearDelay();
          return;
        }

        // ONE definition of "can this market trade", not a second one here.
        // The first version of this check re-implemented the rule against
        // markets.status and missed SUSPENSION entirely, which is stored in
        // suspend_until and leaves status='open' — so a suspended market was
        // still released into. Reusing marketGate is what the D12 lesson
        // demands: the placement gate and the release gate must read the same
        // source, or a control exists in one path and not the other.
        // NOT named `gate`: the module helper is called gate(), and shadowing
        // it with a local const puts the right-hand side in the temporal dead
        // zone — a ReferenceError that the per-order catch below swallowed as
        // a "skipped" order, so the pass silently released nothing.
        // Transient: a suspension lifts, so the delay must survive it.
        const marketGate = gate().marketGate(db, o.market_id);
        if (!marketGate.allowed) { stats.skipped++; return; }
        const sel = getSelection(db, o.selection_id);
        if (!sel || sel.selection_status !== 'open' || sel.market_status !== 'open') { stats.skipped++; return; }

        // THE SAME ABUSE CONTROL THE TAKER PATH APPLIES. The release pass is the
        // only sweep that did not consult LIMITS.matchingAllowed, so a user at
        // their daily net-settlement cap was blocked pre-match and matched
        // anyway in-play — the cap defeated by choosing an in-play market.
        //
        // Transient: the cap lifts, so the delay survives. (See clearDelay above
        // for why clearing it here would be worse than not checking at all.)
        if (!LIMITS.matchingAllowed(db, o.user_id, o.market_id)) {
          stats.skipped++;
          return;
        }

        // Released. Leave the delayed set so the next pass does not re-scan it;
        // from here it is an ordinary resting order any taker may match.
        clearDelay();

        const remBefore = o.stake_cents - o.matched_cents;
        const swept = sweepAndFill(
          db,
          { sel, orderId: o.id, userId: o.user_id, side: o.side, price: o.price, stake: remBefore, remEsc: o.frozen_cents },
          { atTakerPrice: true }
        );
        const filled = remBefore - swept.remaining;
        // finalizeTaker expects `remaining` on the SAME SCALE as `stake` (both
        // totals), and derives `matched = stake - remaining`. So `remaining` here
        // must be the order's TOTAL unmatched amount, which is exactly
        // `swept.remaining` — the sweep was handed `remBefore`, so what is left
        // of it IS the total unmatched.
        //
        // The first version passed `o.matched_cents + swept.remaining`, which
        // double-counted the already-matched part. That is invisible for a fresh
        // order (matched_cents is 0) and corrupts every order that was filled as
        // a COUNTERPARTY by an earlier released order in the same pass — the
        // ordinary shape of a crossing in-play book. The result: matched_cents
        // wiped back to 0 and frozen_cents inflated to the full stake, so
        // cancelOrderTx released collateral that was securing a LIVE match, and
        // settlement then refused with "releasing more than frozen" — leaving the
        // market permanently unsettleable AND un-voidable. The double-entry
        // invariants never fired, because the ledger postings stayed balanced;
        // the corruption was in the order row.
        finalizeTaker(db, {
          orderId: o.id, side: o.side, price: o.price,
          stake: o.stake_cents, remaining: swept.remaining, sel,
        });
        if (filled > 0) recordTrades(db, sel, swept.fills, filled);
        stats.released++;
        stats.filled += filled;
      });
    } catch (e) {
      // One bad order must not stop the others. Logged, not swallowed.
      stats.skipped++;
      console.warn(`[inplay] release of order ${id} failed: ${e.message}`);
    }
  }
  return stats;
}

// Place an order: validate -> escrow -> sweep the opposite book -> rest the
// remainder -> LTP/history/volume. Atomic (one transaction; ledger ops nest
// via their own SAVEPOINTs).
function placeOrder(db, user, req) {
  return transaction(db, () => {
    try {
      return placeOrderTx(db, user, req);
    } catch (e) {
      // The UNIQUE index is the authoritative idempotency guard. Two retries
      // of the same request can both pass the read above; the loser loses at
      // the INSERT. Converting that here — rather than surfacing a 500 — is
      // what makes idempotency hold under concurrency instead of only in the
      // single-threaded case.
      if (isClientOrderIdConflict(e) && req.client_order_id) {
        const id = validateClientOrderId(req.client_order_id);
        const prior = existingByClientOrderId(db, user.id, id);
        if (prior) {
          return { order: prior, fills: [], book: bookFor(db, prior.market_id), idempotent_replay: true };
        }
      }
      throw e;
    }
  });
}

// A UNIQUE violation on the (user_id, client_order_id) index.
//
// MATCHED ON THE COLUMNS, because that is what SQLite actually puts in the
// message. Both branches of this used to test for the index NAME,
// `idx_orders_client_id`, and SQLite never emits an index name in a UNIQUE
// error — it emits the column list. Verified against a real driver error from
// a duplicate insert on this very schema:
//
//   errcode 2067
//   "UNIQUE constraint failed: orders.user_id, orders.client_order_id"
//
// So the predicate was false for every error that could reach it, and the
// race-recovery branch in placeOrder() — the whole reason this function
// exists — was unreachable. Two concurrent retries of the same request would
// return a 500 to the loser instead of the order it had already placed.
//
// Matching the full `table.column, table.column` list keeps the precision the
// comment claimed: an unrelated unique violation (a duplicate username, say)
// names different columns and is still not mistaken for a replay.
function isClientOrderIdConflict(e) {
  if (!e || typeof e !== 'object') return false;
  const msg = String(e.message || '');
  if (typeof e.errcode === 'number' && (e.errcode & 0xff) !== 19) {
    // A driver error that is not SQLITE_CONSTRAINT cannot be this index.
    return false;
  }
  return msg.includes('orders.user_id') && msg.includes('orders.client_order_id');
}

// The matching body with NO transaction of its own: the caller owns one.
// Exported for cash-out, which must span the hedge's full-fill check inside a
// single transaction (a partial hedge fill rolls back entirely). Calling this
// directly would write an order, matches and ledger rows without a rollback
// point, so it refuses to run outside one.
/**
 * Validate a client-supplied idempotency key.
 *
 * Bounded to a sane length and to characters that survive a round trip
 * through a JSON body and a query string unchanged. An unvalidated key would
 * be stored verbatim, so refusing is cheaper than sanitising: a key that does
 * not fit this shape came from a client doing something we do not support.
 */
function validateClientOrderId(raw) {
  if (raw === undefined || raw === null) return null; // absent = not idempotent
  if (typeof raw !== 'string') throw httpError(400, 'client_order_id must be a string');
  const id = raw.trim();
  if (id === '') return null; // an empty string means "not supplied", not "id 0"
  if (id.length > 64) throw httpError(400, 'client_order_id must be at most 64 characters');
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw httpError(400, 'client_order_id may contain only letters, digits, dot, underscore, colon or hyphen');
  }
  return id;
}

/**
 * Return an existing order for this idempotency key, or null.
 *
 * MUST run inside the placement transaction, and MUST run before any escrow is
 * taken. Reading it outside the transaction would be the exact check-then-act
 * race the Phase 1 limit checks exist to avoid: two concurrent retries of the
 * same request would both read null and both place the order.
 */
function existingByClientOrderId(db, userId, clientOrderId) {
  if (!clientOrderId) return null;
  return db.prepare('SELECT * FROM orders WHERE user_id = ? AND client_order_id = ?').get(userId, clientOrderId) || null;
}

function placeOrderTx(db, user, req) {
  if (!inTransaction(db)) {
    throw httpError(500, 'placeOrderTx must be called inside a transaction (use placeOrder)');
  }
  const clientOrderId = validateClientOrderId(req.client_order_id);
  // TIME IN FORCE (#97). Read here, before anything is written, so an unknown
  // persistence is a 400 that leaves no order and no escrow behind — the same
  // position `client_order_id` validation occupies for the same reason.
  const persistence = readPersistence(req.persistence);
  // THE RULE THAT PLACED THIS ORDER (#76), written on the INSERT — before the
  // sweep, not after it.
  //
  // The position is the whole point. sweepAndFill reads orders.rule_id for the
  // TAKER to decide the self-match exception (#75), so an automated order has to
  // already be marked automated at the instant it starts matching. Marking it
  // afterwards is precisely what #75 could not do: its test could only write
  // the marker once placeOrder had returned, by which time the order had
  // already matched, which is why bot-as-taker and bot-vs-bot had to be pinned
  // with source-level assertions. Both are behavioural now.
  //
  // NOT CLIENT-SETTABLE, and the reason it lives here rather than in a route is
  // what makes that true. POST /api/orders destructures the five fields it
  // accepts out of the body and builds an object literal, so a `rule_id` in a
  // request never reaches this function at all — there is no filter here to get
  // wrong later. A caller that could mark its own order automated could hand
  // itself the #75 self-cross exception on demand, so the only way in is the
  // engine: lib/userrules.js, which sets it when a rule of the placing user's
  // own fires.
  //
  // A malformed value is an internal contract violation (500), not a 400: the
  // request body is the only place a bad number legitimately arrives, and it
  // never gets here.
  const ruleId =
    req.rule_id === undefined || req.rule_id === null
      ? null
      : Number.isInteger(req.rule_id) && req.rule_id > 0
        ? req.rule_id
        : (() => { throw httpError(500, 'rule_id must be a positive integer or absent'); })();

  // Idempotent replay: return the order that already exists rather than
  // placing a second. The UNIQUE index is the real guard — this read is what
  // makes the common case a clean 200 instead of a constraint error — and if
  // two requests race past it, the loser's INSERT raises the unique
  // violation, which placeOrder converts to the same replay below.
  if (clientOrderId) {
    const prior = existingByClientOrderId(db, user.id, clientOrderId);
    if (prior) {
      return {
        order: prior,
        fills: [],
        book: bookFor(db, prior.market_id),
        idempotent_replay: true,
      };
    }
  }

  const { stake, price, sel } = validateOrder(db, user, req);

  // ── THE MARKET-VERSION HANDSHAKE (#92) ────────────────────────────────────
  // A client MAY declare which book it priced against; the venue compares that
  // claim inside this transaction and refuses a materially stale one.
  //
  // POSITION IS THE WHOLE ARGUMENT, and it is the same one lib/limits.js makes.
  // This runs after validateOrder because that is the first point at which the
  // selection — and therefore the market the claim is scoped to — is known; it
  // runs before `escrow()` because a refusal must leave NOTHING behind, and
  // before the order INSERT because an order row is the thing being protected.
  // Everything between here and the COMMIT is one transaction with no await
  // points in it (node:sqlite is synchronous), and `transaction()` opens with
  // BEGIN IMMEDIATE, so this read and the order insert cannot be interleaved by
  // another placement. Read the version BEFORE this line and two concurrent
  // placements would both pass on a value neither traded against.
  //
  // OMITTING both fields skips the check entirely and the placement continues
  // byte-for-byte as it did before #92. That is the compatibility contract, and
  // it is not an accident of the ordering above: `assertVersionsFresh` returns
  // immediately when neither claim is present.
  BOOKVERSION.assertVersionsFresh(db, {
    marketId: sel.market_id,
    selectionId: sel.selection_id,
    selection_version: req.selection_version,
    market_version: req.market_version,
  });

  const esc = escrowFor(req.side, price, stake);
  const u = getUser(db, user.id);
  if (availableOf(u) < esc) {
    throw httpError(400, 'Insufficient available balance for the stake/liability');
  }
  // Phase 1 abuse gates. Each reads state the caller is about to change, so
  // all three MUST run inside this transaction — the guard above proves we
  // are in one. Checking them outside would be a check-then-act race: two
  // concurrent placements would both read the pre-limit liability and both
  // pass. See lib/limits.js for why these are abuse controls, not solvency.
  LIMITS.assertTradeable(db, user);
  LIMITS.assertStake(db, u.id, sel.market_id, stake);
  LIMITS.assertPlacement(db, u.id, sel.market_id, esc);
  escrow(db, u.id, esc, { marketId: sel.market_id });

  // ── The in-play bet delay, ENFORCED ──────────────────────────────────────
  // The order is accepted and escrowed now; it simply may not MATCH until
  // eligible_at. NULL means immediately eligible, which is every pre-match
  // order — so the pre-match path is unchanged down to the byte.
  const delayMs = INPLAY_GATE.delayMsFor(db, sel.market_id);
  let eligibleAt = null;
  if (delayMs > 0) {
    eligibleAt = db.prepare("SELECT datetime('now', ?) t").get(`+${Math.ceil(delayMs / 1000)} second`).t;
  }

  // Insert first so match rows can reference this order; frozen_cents is
  // the per-order escrow source of truth (at placement: the full stake's).
  // `persistence` is NOT client-settable and NOT defaulted here by accident:
  // readPersistence is the closed vocabulary, and its absent case is PERSIST,
  // which is what every order on this venue did before #97 existed.
  const info = db
    .prepare(
      `INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents, matched_cents, frozen_cents, status, placed_at, eligible_at, delayed, client_order_id, rule_id, persistence)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'open', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      u.id, sel.market_id, sel.selection_id, req.side, price, stake, esc,
      now(), eligibleAt, delayMs > 0 ? 1 : 0, clientOrderId, ruleId, persistence
    );
  const orderId = Number(info.lastInsertRowid);

  // Phase 1 daily clamp: once the user's net-settlement cap for today is
  // reached, the order still RESTS — it simply does not sweep. Cancelling it
  // would be worse than useless: it would change the meaning of the book for
  // everyone else looking at it, and an order that vanished for no stated
  // reason is a support incident.
  // THE TAKER GATE. A delayed order does not sweep on arrival — that was the
  // whole bug: the venue told the client "matchable in 60s" and matched it
  // anyway. It rests instead, and the release pass below matches it when the
  // delay expires.
  const takerEligible = !eligibleAt;
  const swept = takerEligible && LIMITS.matchingAllowed(db, u.id, sel.market_id)
    ? sweepAndFill(db, { sel, orderId, userId: u.id, side: req.side, price, stake, remEsc: esc })
    : { fills: [], remaining: stake, remEsc: esc };
  const matched = finalizeTaker(db, { orderId, side: req.side, price, stake, remaining: swept.remaining, sel });
  recordTrades(db, sel, swept.fills, matched);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (eligibleAt) order.delayed = true;
  return { order, fills: swept.fills, book: bookFor(db, sel.market_id) };
}

// Cancel the UNMATCHED remainder of an open order. Releases exactly the
// tracked remainder escrow (orders.frozen_cents) — no formula re-derived.
// The matched part's liability stays frozen for settlement.
function cancelOrder(db, user, orderId) {
  return transaction(db, () => cancelOrderTx(db, user, orderId));
}

function cancelOrderTx(db, user, orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || o.user_id !== user.id) throw httpError(404, 'Order not found');
  if (o.status === 'cancelled') throw httpError(400, 'Order already cancelled');
  if (o.status === 'fully_matched') throw httpError(400, 'Order is fully matched — nothing to cancel');
  if (o.frozen_cents > 0) release(db, user.id, o.frozen_cents, { orderId: o.id, marketId: o.market_id });
  db.prepare("UPDATE orders SET status = 'cancelled', frozen_cents = 0, updated_at = ? WHERE id = ?").run(now(), o.id);
  // A cancel REMOVES size somebody was reading, so it is a book change (#92) —
  // and this is the single funnel every cancellation in the codebase passes
  // through: the cancel route, the bots' requote, cash-out, self-exclusion, a
  // tenant suspension and the admin desk all call cancelOrder or cancelOrderTx
  // rather than writing orders.status themselves. One bump here covers all of
  // them, which is why it is here and not in the route.
  //
  // The refusals above this line reach NO bump, and deliberately: none of them
  // changed the book. Bumping on a call that did nothing is how a version-based
  // control starts being routed around.
  BOOKVERSION.bumpBookVersion(db, { marketId: o.market_id, selectionId: o.selection_id });
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
}

// ── Amend (#97) ─────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS AND WHY IT IS NOT CANCEL-AND-REPLACE. Cancel-and-replace was
// this venue's only way to change a resting order, and it is materially worse
// than it sounds in three separate ways, all of which cost a trader something:
//
//   - IT LOSES QUEUE POSITION. FIFO inside a price level is a named invariant
//     (ORDER BY price, id; E13, E20), so cancelling and re-placing at the SAME
//     price moves the order to the BACK of that level's queue. A market maker
//     resizing from 4000 to 1000 would be silently demoted behind everyone who
//     arrived after them — for an operation that is supposed to be a no-op.
//   - IT CHURNS THE LEDGER. A release and a fresh escrow where one delta would
//     do, so the player's own transaction history fills with pairs that
//     describe one decision.
//   - IT IS TWO ROUND TRIPS AND TWO FAILURE MODES. A cancel that succeeds
//     followed by a place that fails leaves the trader flat when they meant to
//     be hedged, which on a money path is the worst possible split.
//
// So the amend is ONE transaction that keeps the order's `id`. Keeping the id is
// not an optimisation: `id` IS the queue position (`ORDER BY price, id`), so
// any implementation that re-inserts the row — or that cancels and re-places
// behind the scenes — silently breaks price-time priority and every test that
// reads a queue order still passes.
//
// ATOMIC BY CONSTRUCTION: one `transaction()` from the first read of the order
// to the last write of escrow, so there is no window in which the order is at
// the new price and still holds the old collateral. `amendOrderTx` refuses to
// run outside one, exactly as `placeOrderTx` does, so a caller cannot reach the
// escrow movement without the write lock.
function amendOrder(db, user, orderId, changes) {
  return transaction(db, () => amendOrderTx(db, user, orderId, changes));
}

// Would an order resting at `price` CROSS the resting book?
//
// The engine's consistency rule is "a resting back and a resting lay can never
// price-cross, because whichever arrived second would have matched" (E11's
// comment). An AMEND is the second arrival, so an amend that crossed would break
// that rule — and would break it in the worst way, because a crossing is a
// match waiting to happen rather than a cosmetic blemish. The instant that
// counterparty became matchable, the delay-release pass runs it as a TAKER and
// takes this order at a price the client never placed.
//
// TWO THINGS THIS DELIBERATELY COUNTS, and the first is the one a first
// implementation gets wrong:
//
//   - DELAYED resting orders. `eligible_at` is not "not there": a delayed order
//     is released into the book AS A TAKER later (see releaseEligibleOrders),
//     so it is liquidity in waiting. Ignoring it here would let an amend become
//     an unfilled market order the client never wrote.
//   - THE ORDER'S OWN USER's orders. The self-match guard means those cannot
//     match each other, so counting them is over-cautious rather than wrong —
//     but the invariant this protects is a property of the BOOK as displayed,
//     not of executability, and a book that reads as crossed is a support
//     incident whatever the guard would have done with it.
function wouldPriceCross(db, order, price) {
  const row = order.side === 'lay'
    ? db
        .prepare(
          `SELECT MIN(price) AS p FROM orders
            WHERE selection_id = ? AND side = 'back' AND status = 'open'
              AND matched_cents < stake_cents AND id <> ?`
        )
        .get(order.selection_id, order.id)
    : db
        .prepare(
          `SELECT MAX(price) AS p FROM orders
            WHERE selection_id = ? AND side = 'lay' AND status = 'open'
              AND matched_cents < stake_cents AND id <> ?`
        )
        .get(order.selection_id, order.id);
  // NULL means no resting order on the far side at all.
  if (row.p === null) return false;
  return order.side === 'lay' ? row.p <= price : row.p >= price;
}

/**
 * The matching body with NO transaction of its own: the caller owns one.
 * Exported so a caller that must span the amend with something else of its own
 * (nothing today) can, and refused if called bare.
 */
function amendOrderTx(db, user, orderId, changes) {
  if (!inTransaction(db)) {
    throw httpError(500, 'amendOrderTx must be called inside a transaction (use amendOrder)');
  }
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  // SAME 404 as cancel, and for the same reason: an order that exists but is
  // somebody else's must be indistinguishable from one that does not exist, or
  // this endpoint becomes an oracle for which ids are real.
  if (!o || o.user_id !== user.id) throw httpError(404, 'Order not found');
  if (o.status === 'cancelled') throw httpError(400, 'Order already cancelled');
  // `matched_cents >= stake_cents` as well as the status, because that is the
  // condition the escrow contract is written against and the one a corrupt or
  // half-migrated row would actually present.
  if (o.status === 'fully_matched' || o.matched_cents >= o.stake_cents) {
    throw httpError(400, 'Order is fully matched — there is nothing left to amend');
  }

  const has = (k) => changes[k] !== undefined;
  if (!has('price') && !has('stake_cents') && !has('persistence')) {
    // A no-op amend is refused rather than answered 200. A 200 that changed
    // nothing teaches a client that the call worked without telling it whether
    // the venue heard it, which is how a stale client ends up believing it is
    // hedged when it is not.
    throw httpError(400, 'Nothing to amend: send price, stake_cents, or persistence');
  }

  // THE GATES ARE validateOrder's, not a second set. Ladder snapping, the stake
  // bounds, market/selection/event status, the in-play suspension and the
  // off-time backstop all live there, and this is the D12 lesson applied to an
  // amend: a control that exists on the placement path and not on the amend
  // path is a control with a hole in it, and the hole is the one a client who
  // is told "amend instead of re-placing" will drive straight into.
  const newStake = has('stake_cents') ? changes.stake_cents : o.stake_cents;
  const { stake, price, sel } = validateOrder(db, user, {
    selection_id: o.selection_id,
    side: o.side,
    price: has('price') ? changes.price : o.price,
    stake_cents: newStake,
  });

  // A stake can shrink, but NOT past what has already traded, and not all the
  // way to it either: a remainder of zero is a fully matched order, which is a
  // state only a COUNTERPARTY may put an order into. Amending an order to
  // "fully matched" would release collateral securing nothing and leave the row
  // claiming a fill that never happened.
  if (stake <= o.matched_cents) {
    throw httpError(
      400,
      `stake_cents must stay above the ${o.matched_cents} cents already matched on this order — an order cannot be amended into a fully matched one`
    );
  }
  const newRemainder = stake - o.matched_cents;

  // Only a PRICE change can create a crossing, and only then is the question
  // live: an unchanged-price amend cannot cross, because the order was resting
  // at that price a moment ago and a book cannot cross (whichever arrived second
  // would have matched). Checking on an unchanged price would refuse size-only
  // amends for a condition that did not exist.
  if (price !== o.price && wouldPriceCross(db, o, price)) {
    throw httpError(
      409,
      `Amending to ${price} would price-cross the resting book. Placing an order at that price would match it instead — cancel and place, or amend to a price that does not cross.`,
      { code: 'amend_would_cross', price, selection_id: o.selection_id }
    );
  }

  // The version handshake (#92) is available here too, and for the same reason
  // it is on placement: an amend is a decision taken against a book the client
  // read, and "the ladder moved under me" is exactly the thing a trader
  // resizing an order needs to be told. Omitting both fields skips the check
  // entirely, which is the same compatibility contract placement carries.
  BOOKVERSION.assertVersionsFresh(db, {
    marketId: o.market_id,
    selectionId: o.selection_id,
    selection_version: changes.selection_version,
    market_version: changes.market_version,
  });

  // THE ESCROW DELTA. One formula, one sign convention, the same helper the
  // partial-fill path uses — see holdRemainderEscrow. What is different here is
  // what the TARGET is, and the difference is the whole arithmetic of an amend:
  // an amend matched nothing, so it owes no fill liability, and the matched
  // part's existing collateral is untouched. The target is therefore exactly
  // the new remainder's escrow, for both sides:
  //
  //   back: escrowFor('back', price, remainder) = remainder
  //   lay:  escrowFor('lay',  price, remainder) = round((price - 1) * remainder)
  //
  // `held` is o.frozen_cents, read HERE, inside the transaction that holds the
  // write lock — the same reason placement re-reads the version here rather
  // than in the route.
  const targetEsc = escrowFor(o.side, price, newRemainder);

  // THE ABUSE GATES, on the DELTA rather than on the whole order.
  //
  // `assertPlacement` sums orders.frozen_cents over the user's OPEN orders in
  // this market, and THIS order's old escrow is already in that sum. So the
  // post-amend liability is exactly `current + (target - held)`, and the honest
  // thing to check is the positive part of that delta: a shrink can never push
  // anyone past an upper cap, and passing the new total would refuse an amend
  // that REDUCES risk. `assertStake` still sees the whole stake, because that
  // cap is per order rather than per market.
  const escDelta = targetEsc - o.frozen_cents;
  // The affordability check placement makes, in the same ORDER placement makes
  // it — wallet first, then the abuse gates — so one request cannot be told
  // "you cannot afford that" on one path and "that breaks a limit" on the other.
  if (escDelta > 0 && availableOf(getUser(db, user.id)) < escDelta) {
    throw httpError(400, 'Insufficient available balance for the stake/liability');
  }
  LIMITS.assertTradeable(db, user);
  LIMITS.assertStake(db, user.id, sel.market_id, stake);
  LIMITS.assertPlacement(db, user.id, sel.market_id, escDelta > 0 ? escDelta : 0);

  const frozen = holdRemainderEscrow(db, o.user_id, o.frozen_cents, targetEsc, {
    orderId: o.id,
    marketId: o.market_id,
  });
  const persistence = has('persistence') ? readPersistence(changes.persistence) : o.persistence;
  // ONE UPDATE, price, size, time in force and escrow together. Four statements
  // here would still be one transaction, but a reader could not tell from the
  // code that the escrow and the price it was computed from move atomically —
  // and that is precisely the fact the next reader needs to check.
  db.prepare('UPDATE orders SET price = ?, stake_cents = ?, persistence = ?, frozen_cents = ?, updated_at = ? WHERE id = ?')
    .run(price, stake, persistence, frozen, now(), o.id);

  const bookMoved = price !== o.price || stake !== o.stake_cents;
  // AN AMEND IS A BOOK CHANGE AND IT BUMPS (#92).
  //
  // Not optional, and not the "an order that merely rests" carve-out that
  // placement lives under. That carve-out is about the client MOVING ITS OWN
  // counter by clicking; this is a change to an order that was already on the
  // book, changing the SIZE another client is reading at that level and
  // possibly the price itself. The clients that need telling about it are the
  // ones who did not amend anything.
  //
  // Guarded on the values actually changing, for the reason cancelOrderTx guards
  // its refusals: a bump on a call that changed nothing is a version-based
  // control that starts being routed around. A persistence-only amend is
  // invisible to every reader of the book — `bookFor` does not read the column
  // — so it moves no version, and saying so here is what stops the next person
  // adding one "for consistency".
  if (bookMoved) BOOKVERSION.bumpBookVersion(db, { marketId: o.market_id, selectionId: o.selection_id });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
  return {
    order,
    book: bookFor(db, o.market_id),
    // WHAT CHANGED, so a client does not have to diff two order rows and so a
    // size-only amend is visibly distinct from a price change.
    price_changed: price !== o.price,
    size_changed: stake !== o.stake_cents,
    // The escrow movement, signed: positive means the venue took MORE
    // collateral, negative means it gave some back. Zero means the order's
    // wallet position is unchanged, which is a real answer and not an absence
    // of one — a lay at the same price with the same remainder is exactly 0.
    escrow_delta_cents: escDelta,
  };
}

// ── Bulk cancel (#97) ───────────────────────────────────────────────────────
//
// How many ids one call will take. Betfair caps its lists; so does this. Two
// hundred is comfortably above the case the issue names — a market maker with
// forty resting orders — and comfortably below "one request that holds the
// venue's write lock while it walks a list a client chose the length of". The
// cap is on the REQUEST, so it is checked before anything is read or written.
const MAX_BULK_CANCEL = 200;

/**
 * Validate a client-supplied list of order ids, IN FULL, before any is used.
 *
 * The #29 lesson applies exactly: a `LIKE` built from a request body revoked
 * every session on the venue, because a list was treated as trusted text. This
 * is the opposite shape — a list of integers, bound one at a time — and it is
 * written so that a future "optimisation" cannot turn it back into a string:
 *
 *   - EVERY element is validated, not the first few and not the array's type.
 *     A list that fails validation must have touched NOTHING, which is why this
 *     throws rather than skipping the bad entries.
 *   - NOTHING IS INTERPOLATED. Each id reaches SQLite as a bound parameter of a
 *     single-row `WHERE id = ?`. There is no code path in this function that
 *     builds an `IN (...)` list, so there is nothing to inject INTO.
 *   - A JSON string "1,2" is not a list. It is refused, not split, because
 *     splitting is how a client ends up cancelling orders it never named.
 */
function readOrderIdList(raw) {
  if (!Array.isArray(raw)) throw httpError(400, 'order_ids must be a JSON array of order ids');
  if (raw.length === 0) throw httpError(400, 'order_ids must contain at least one order id');
  if (raw.length > MAX_BULK_CANCEL) {
    throw httpError(400, `order_ids accepts at most ${MAX_BULK_CANCEL} ids in one call; split the request`);
  }
  return raw.map((v, i) => {
    // Number.isInteger, not Number(v): "3" and true would both coerce to an id
    // a client never named, and a strict integer is the only shape that cannot.
    if (!Number.isInteger(v) || v <= 0) {
      throw httpError(400, `order_ids[${i}] must be a positive integer order id`);
    }
    return v;
  });
}

/**
 * Cancel a LIST of orders, authorising each id INDEPENDENTLY.
 *
 * PARTIAL, DELIBERATELY. The single-order route is all-or-nothing: one id, one
 * outcome. A list is not, and the reason is the workflow it exists for — a
 * market maker with forty resting orders pulling them before kick-off does not
 * want a stranger's id, or one order that filled while they were building the
 * request, to cost them the other thirty-nine. Refusing the whole batch for one
 * unusable id is the behaviour the issue calls out, and the one that makes a
 * bulk endpoint worse than a loop.
 *
 * PER-ORDER TRANSACTIONS, for the same reason releaseEligibleOrders uses them:
 * a failure on one order must cost that order only, and must not unwind the
 * escrow of orders already cancelled. It also means a concurrent cancellation
 * of the same id is a per-id race with a per-id answer rather than a batch that
 * dies whole.
 *
 * "not your order" and "no such order" answer IDENTICALLY (`not_found`). That is
 * deliberate and it is the same choice `cancelOrderTx` makes: a bulk endpoint
 * that distinguished them would let a client map the venue's order ids from the
 * outside, which is a bigger disclosure than any of the errors it would replace.
 */
function cancelOrders(db, user, rawIds) {
  const ids = readOrderIdList(rawIds);
  const results = [];
  const marketIds = new Set();
  let cancelled = 0;
  let releasedCents = 0;
  for (const id of ids) {
    let outcome;
    try {
      outcome = transaction(db, () => {
        // The read is INSIDE the transaction, so the classification below and the
        // cancel it precedes cannot be separated by another writer.
        const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
        if (!o || o.user_id !== user.id) {
          return { order_id: id, status: 'not_found', code: 'not_found' };
        }
        if (o.status === 'cancelled') {
          return { order_id: id, status: 'already_cancelled', code: 'already_cancelled' };
        }
        if (o.status === 'fully_matched' || o.matched_cents >= o.stake_cents) {
          return { order_id: id, status: 'fully_matched', code: 'fully_matched' };
        }
        const released_cents = o.frozen_cents;
        cancelOrderTx(db, user, id);
        return { order_id: id, status: 'cancelled', code: 'cancelled', released_cents, market_id: o.market_id };
      });
    } catch (e) {
      // An id that fails INSIDE the cancellation — a ledger refusal, a database
      // error — is reported against that id and nothing else. It is deliberately
      // not re-thrown: the caller asked for forty cancels and thirty-nine of
      // them worked, and turning one internal fault into a 500 for the request
      // would leave the client unable to tell which thirty-nine.
      outcome = { order_id: id, status: 'error', code: 'cancel_failed', detail: String(e.message || e) };
    }
    if (outcome.status === 'cancelled') {
      cancelled++;
      releasedCents += outcome.released_cents;
      marketIds.add(outcome.market_id);
      delete outcome.market_id;
    }
    results.push(outcome);
  }
  return {
    results,
    cancelled,
    failed: ids.length - cancelled,
    released_cents: releasedCents,
    // The distinct markets whose book changed, so the route broadcasts once per
    // market rather than once per order. A batch that touched forty orders
    // across two markets is two board updates, not forty.
    market_ids: [...marketIds],
  };
}

// ── Time in force: the LAPSE sweep (#97) ────────────────────────────────────

/**
 * Cancel every unmatched `LAPSE` order whose market has gone in-play.
 *
 * MODELLED ON releaseEligibleOrders, deliberately and in every respect that
 * matters, because it has the same shape of risk:
 *
 *   - PER-ORDER TRANSACTIONS, so one bad order costs only itself and the rest
 *     of the pass still runs. A batch-wide transaction here would be atomic and
 *     fragile in exactly the way that function's comment describes.
 *   - THE SCAN IS OUTSIDE, THE DECISION IS INSIDE. `due` is a candidate list;
 *     the order is re-read inside the transaction that holds the write lock, and
 *     so is the market's `inplay` flag. Reading either outside would be the
 *     check-then-act that lib/limits.js L13 and lib/bookversion.js both exist to
 *     document: two writers, one snapshot, both acting.
 *
 * WHAT THE RACE-FREE ARGUMENT ACTUALLY IS, because "it runs on a timer" is not
 * one. The dangerous interleaving is a TAKER arriving at the same instant: the
 * taker's sweepAndFill reads resting orders, and if the lapse pass cancelled
 * one after that read, the taker would write a MATCH row against a cancelled
 * order — and cancelOrderTx would have released collateral that was securing a
 * live position. That is not hypothetical; it is exactly the corruption the
 * releaseEligibleOrders comment describes when a double-counted remainder let
 * settlement release "collateral that was securing a LIVE match", leaving a
 * market permanently unsettleable AND un-voidable.
 *
 * It cannot happen, for a structural reason rather than a timing one:
 *
 *   1. `transaction()` opens with BEGIN IMMEDIATE, so this pass takes the write
 *      lock at its START. A taker's placement takes it too. There is no
 *      interleaving *within* either: node:sqlite is synchronous, so a
 *      transaction body has no await point in it.
//   2. Whichever commits FIRST is the only one whose state the other will ever
//      read. If the lapse commits first, the taker's `SELECT ... status='open'`
//      runs on a fresh snapshot and does not see the order at all. If the taker
//      commits first, the lapse pass re-reads the row INSIDE its own
//      transaction and sees `matched_cents` advanced — so a fully matched order
//      is skipped, and a partially filled one is cancelled for what is left,
//      which is the correct answer rather than the only survivable one.
//
//   3. So the order is EITHER matched OR cancelled, never both, and the wallet
//      always still holds the matched liability. tests/amend.test.js proves it
//      with two PROCESSES released from a barrier, because a single-threaded
//      simulation of this race is the shape that passes against a broken
//      implementation, which is the L13 lesson the issue cites.
//
//   MUTATION-TESTED, and the finding is worth recording because it says what
//   these re-reads are actually FOR. Two mutants were tried. Moving this pass's
//   guard OUTSIDE the write transaction while still cancelling through
//   cancelOrderTx SURVIVED: the funnel re-reads the row inside its own
//   transaction and refuses an order that is no longer open, so the stale read
//   bought an attacker nothing. Replacing the funnel with a direct
//   release-and-write on the stale row was caught on round 1 of 3, on every run,
//   with exactly the corruption above. So the protection is not "the outer guard
//   happens to be inside a transaction": it is that cancellation goes through
//   ONE funnel which re-reads and refuses. Which is the reason cancelOrderTx is
//   documented as the single funnel every cancellation in this codebase passes
//   through, and the reason this pass must never grow a private shortcut around
//   it: the shortcut would look identical in a single-threaded test and would
//   be lethal under concurrency.
//
// TRANSIENT vs TERMINAL, the distinction releaseEligibleOrders draws and which
 * is easy to get backwards: a market that is NOT in-play is not a condition
 * this pass refuses to act on forever, it is a market that has not turned yet.
// So the order is simply left alone, not marked, not logged as skipped — the
// next pass must still find it.
 */
function lapseOrders(db, { limit = 200 } = {}) {
  const due = db
    .prepare(
      `SELECT o.id FROM orders o
         JOIN markets m ON m.id = o.market_id
        WHERE o.status = 'open'
          AND o.persistence = 'LAPSE'
          AND o.matched_cents < o.stake_cents
          AND m.inplay = 1
        ORDER BY o.id ASC
        LIMIT ?`
    )
    .all(limit);
  const stats = { considered: due.length, lapsed: 0, skipped: 0, released_cents: 0, market_ids: new Set() };
  for (const { id } of due) {
    try {
      const r = transaction(db, () => {
        const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
        // Terminal since the scan: filled by a taker that beat us to the lock, or
        // cancelled by the player. Stale state no query would ever clean up, and
        // cancelling it now would release nothing but claim to have.
        if (!o || o.status !== 'open' || o.matched_cents >= o.stake_cents) return null;
        // Re-read the MARKET too, not just the order. A market that has not gone
        // in-play yet is not a refusal — it is a later pass, so it must not be
        // counted as one either.
        const m = db.prepare('SELECT inplay FROM markets WHERE id = ?').get(o.market_id);
        if (!m || !m.inplay) return null;
        const released_cents = o.frozen_cents;
        // The SAME funnel every other cancellation in this codebase uses, which
        // is what makes the lapse audited as a book change (the version bump)
        // rather than as a quiet status write.
        cancelOrderTx(db, { id: o.user_id }, o.id);
        return { released_cents, market_id: o.market_id };
      });
      if (r) {
        stats.lapsed++;
        stats.released_cents += r.released_cents;
        stats.market_ids.add(r.market_id);
      }
    } catch (e) {
      stats.skipped++;
      console.warn(`[lapse] order ${id} failed: ${e.message}`);
    }
  }
  return {
    considered: stats.considered,
    lapsed: stats.lapsed,
    skipped: stats.skipped,
    released_cents: stats.released_cents,
    market_ids: [...stats.market_ids],
  };
}

// Open (unmatched-remainder) orders for a user, with names joined.
// `persistence` rides here so the client's own order list can tell them how
// long the venue intends to keep each order — a trader who cannot see whether
// their order will lapse before kick-off cannot use the feature.
function openOrdersFor(db, userId) {
  return db
    .prepare(
      `SELECT o.id, o.market_id, o.side, o.price, o.stake_cents, o.matched_cents, o.frozen_cents, o.status, o.placed_at,
              o.persistence, o.selection_id, s.name AS selection_name, m.name AS market_name, e.name AS event_name
       FROM orders o
       JOIN selections s ON s.id = o.selection_id
       JOIN markets m ON m.id = o.market_id
       JOIN events e ON e.id = m.event_id
       WHERE o.user_id = ? AND o.status = 'open'
       ORDER BY o.id DESC`
    )
    .all(userId);
}

// Aggregated price levels for every selection in a market.
//   back side ("available to back") = resting LAY offers, HIGHEST price first.
//   lay side ("available to lay") = resting BACK offers, LOWEST price first.
//
// `version` is the selection's BOOK VERSION (#92): the number a client sends
// back with an order to say which ladder it priced against. It rides here
// rather than on a new endpoint because every consumer of a book already reads
// this shape — the board, the trading desk, and the placement response itself —
// so a client never has to make a second request to learn what it just read.
// Additive: `book`, `lay`, `ltp`, `status` and `name` are unchanged, so an
// existing reader sees exactly what it saw before.
function bookFor(db, marketId, levels = 3) {
  const sels = stmtsFor(db, 'book-sels', 'SELECT id, name, status, ltp, book_version FROM selections WHERE market_id = ? ORDER BY id').all(marketId);
  const backStmt = stmtsFor(
    db,
    'book-back',
    `SELECT price, SUM(stake_cents - matched_cents) AS size_cents FROM orders
     WHERE selection_id = ? AND side = 'lay' AND status = 'open' AND stake_cents > matched_cents
     GROUP BY price ORDER BY price DESC LIMIT ?`
  );
  const layStmt = stmtsFor(
    db,
    'book-lay',
    `SELECT price, SUM(stake_cents - matched_cents) AS size_cents FROM orders
     WHERE selection_id = ? AND side = 'back' AND status = 'open' AND stake_cents > matched_cents
     GROUP BY price ORDER BY price ASC LIMIT ?`
  );
  return sels.map((s) => ({
    selection_id: s.id,
    name: s.name,
    status: s.status,
    ltp: s.ltp,
    version: Number(s.book_version),
    back: backStmt.all(s.id, levels).map((r) => ({ price: r.price, size_cents: r.size_cents })),
    lay: layStmt.all(s.id, levels).map((r) => ({ price: r.price, size_cents: r.size_cents })),
  }));
}

// Book overround for a market: the sum of the implied probability of the best
// price a backer can get on each runner, minus 1. On an exchange this is the
// desk's margin/arbitrage signal — negative means the runners can all be backed
// for a guaranteed profit. null when a runner has no available liquidity,
// because a partial book cannot be summed meaningfully.
function marketOverround(db, marketId) {
  const book = bookFor(db, marketId, 1);
  if (!book.length) return null;
  let sum = 0;
  for (const sel of book) {
    const best = sel.back[0]; // resting lays, highest first = best price to back
    if (!best) return null;
    sum += impliedProb(best.price);
  }
  return sum - 1;
}

// The user's matched bets (rows tagged with my_side) across all markets, or
// scoped to one market when marketId is given.
function myMatchedBets(db, userId, marketId = null) {
  const sql = `SELECT mt.market_id, mt.selection_id, mt.price, mt.stake_cents,
            CASE WHEN bo.user_id = ? THEN 'back' ELSE 'lay' END AS my_side
     FROM matches mt
     JOIN orders bo ON bo.id = mt.back_order_id
     JOIN orders lo ON lo.id = mt.lay_order_id
     -- Cashed-out matches are not exposure: the position was bought off the
     -- player. Listing them here would let a closed position be quoted and
     -- cashed out a second time, and would keep it on the positions view.
     WHERE (bo.user_id = ? OR lo.user_id = ?) AND mt.cashout = 0${marketId ? ' AND mt.market_id = ?' : ''}`;
  const args = marketId ? [userId, userId, userId, marketId] : [userId, userId, userId];
  return db.prepare(sql).all(...args);
}

// One selection's leg for positionsFor: matched stakes + the still-frozen
// matched escrow. Under the escrow contract the wallet holds exactly
// round((P-1)*s) per matched lay fill and s per matched back stake, so
// recomputing here is exact, not an approximation.
function legFor(s, bets) {
  let backStake = 0;
  let layStake = 0;
  let frozen = 0;
  for (const b of bets) {
    if (b.my_side === 'back') {
      backStake += b.stake_cents;
      frozen += b.stake_cents;
    } else {
      layStake += b.stake_cents;
      frozen += Math.round((b.price - 1) * b.stake_cents);
    }
  }
  return {
    selection_id: s.id,
    name: s.name,
    status: s.status,
    my_back_stake_cents: backStake,
    my_lay_stake_cents: layStake,
    frozen_cents: frozen,
  };
}

// If-this-selection-wins P&L across the user's bets in one market.
//
// The selection's STATUS is carried, not just its arithmetic (#88). A runner
// withdrawn before the off is voided and its stake refunded, so the row is no
// longer an outcome the player is exposed to — but the matrix is built from the
// market's selections rather than from the ones that can still win, and a row
// that reads "if Red wins: +400" with no indication that Red cannot run is the
// P&L-matrix half of the same defect the issue describes. Consumers filter or
// label it; nothing is dropped, because "this runner was removed and here is
// what it would have been" is the record of the withdrawal.
function pnlIfWinFor(s, bets) {
  let pnl = 0;
  for (const b of bets) {
    const profit = Math.round((b.price - 1) * b.stake_cents); // back profit == lay loss
    if (b.my_side === 'back') {
      pnl += b.selection_id === s.id ? profit : -b.stake_cents;
    } else {
      pnl += b.selection_id === s.id ? -profit : b.stake_cents;
    }
  }
  return { selection_id: s.id, name: s.name, status: s.status, pnl_cents: pnl };
}

// Matched positions for a user across all markets: per-selection matched
// stake/liability + the if-win P&L matrix (cashout values are added by
// lib/cashout.js). The user's bets are bucketed ONCE (by market and by
// market:selection) instead of re-filtered per market x selection.
function positionsFor(db, userId) {
  // `mt.cashout = 0` mirrors myMatchedBets, and the comment there is the
  // reason: a bought-off match is not exposure.
  //
  // Without it this query still produced the market row while myMatchedBets
  // returned nothing for it, so a fully cashed-out market stayed in
  // /api/positions as an entry with no legs and no quote — which reads as a
  // bug to the player who deliberately closed the position, and is mildly
  // misleading in the other direction too, since a closed position has no
  // business in a list of positions.
  //
  // The double cash-out itself was already prevented, but by a SECOND query
  // rather than by this one: the protection was incidental, not structural.
  const markets = db
    .prepare(
      `SELECT DISTINCT m.id AS market_id, m.name AS market_name, m.status AS market_status,
              m.winner_selection_id, e.name AS event_name
       FROM matches mt
       JOIN orders bo ON bo.id = mt.back_order_id
       JOIN orders lo ON lo.id = mt.lay_order_id
       JOIN markets m ON m.id = mt.market_id
       JOIN events e ON e.id = m.event_id
       WHERE (bo.user_id = ? OR lo.user_id = ?) AND mt.cashout = 0
       ORDER BY m.id DESC`
    )
    .all(userId, userId);

  const myBets = myMatchedBets(db, userId);
  const byMarket = new Map();
  const bySelection = new Map();
  for (const b of myBets) {
    const mk = byMarket.get(b.market_id);
    if (mk) mk.push(b);
    else byMarket.set(b.market_id, [b]);
    const key = `${b.market_id}:${b.selection_id}`;
    const sk = bySelection.get(key);
    if (sk) sk.push(b);
    else bySelection.set(key, [b]);
  }

  return markets.map((m) => {
    const sels = db
      .prepare('SELECT id, name, status FROM selections WHERE market_id = ? ORDER BY id')
      .all(m.market_id);
    const marketBets = byMarket.get(m.market_id) || [];
    return {
      market_id: m.market_id,
      market_name: m.market_name,
      event_name: m.event_name,
      market_status: m.market_status,
      winner_selection_id: m.winner_selection_id,
      selections: sels.map((s) => legFor(s, bySelection.get(`${m.market_id}:${s.id}`) || [])),
      pnl_if_win: sels.map((s) => pnlIfWinFor(s, marketBets)),
    };
  });
}

module.exports = {
  placeOrder,
  placeOrderTx,
  releaseEligibleOrders,
  // #97 — the order lifecycle beyond place/fill/cancel. `amendOrderTx` and
  // `cancelOrderTx` are exported alongside their wrappers for the same reason
  // `placeOrderTx` is: a caller that must span one of them with something else
  // of its own inside a single transaction cannot do it through the wrapper.
  // Both REFUSE to run outside a transaction, so exporting them widens the set
  // of callers, not the set of ways to skip the write lock.
  amendOrder,
  amendOrderTx,
  cancelOrders,
  readOrderIdList,
  lapseOrders,
  readPersistence,
  PERSISTENCE: { LAPSE, PERSIST },
  MAX_BULK_CANCEL,
  validateClientOrderId,
  existingByClientOrderId,
  // Exported so tests/idempotency.test.js can assert the predicate against a
  // REAL caught driver error. That distinction matters: a hand-built error
  // fixture is written to match whatever the implementation happens to look
  // for, so it passes against a predicate that can never return true — which
  // is exactly the bug this predicate had. A duplicate inserted through
  // SQLite produces whatever the driver actually says.
  isClientOrderIdConflict,
  // #76 — exported so tests/userrules.test.js can prove the no-house-participation
  // rule from the OTHER side: that a manual order is still perfectly matchable
  // against a bot quote, so the check is not "bots stop quoting" in disguise.
  isBotUser,
  cancelOrder,
  openOrdersFor,
  bookFor,
  marketOverround,
  positionsFor,
  myMatchedBets,
  escrowFor,
};
