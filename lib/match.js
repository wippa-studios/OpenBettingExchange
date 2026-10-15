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

// The single rounding point for a lay fill, extracted so the AFFORDABILITY CHECK
// and the escrow MOVEMENT cannot disagree. They must: if the check computes a
// different delta from the one that is later applied, the engine either refuses
// a fill it could have made, or makes one it cannot pay for.
function layFillDelta(price, fill, remAfter, layPrice, remEscBefore) {
  const fillLiability = Math.round((price - 1) * fill);
  const remEscAfter = escrowFor('lay', layPrice, remAfter);
  return { delta: remEscBefore - fillLiability - remEscAfter, remEscAfter };
}

// What the wallet would have to be topped up by for this fill to be legal.
// 0 means the fill moves no new money. Positive means this layer must find
// `n` cents it does not currently have.
function layFillTopUp(price, fill, remAfter, layPrice, remEscBefore) {
  return Math.max(0, -layFillDelta(price, fill, remAfter, layPrice, remEscBefore).delta);
}

function applyLayFill(db, lay, fill, price, remBefore, remEscBefore, ref) {
  const { delta, remEscAfter } = layFillDelta(price, fill, remBefore - fill, lay.price, remEscBefore);
  if (delta > 0) release(db, lay.user_id, delta, ref);
  else if (delta < 0) escrow(db, lay.user_id, -delta, ref); // rare 1-cent top-up
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
  const info = db
    .prepare(
      `INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents, matched_cents, frozen_cents, status, placed_at, eligible_at, delayed, client_order_id, rule_id)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'open', ?, ?, ?, ?, ?)`
    )
    .run(
      u.id, sel.market_id, sel.selection_id, req.side, price, stake, esc,
      now(), eligibleAt, delayMs > 0 ? 1 : 0, clientOrderId, ruleId
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

// Open (unmatched-remainder) orders for a user, with names joined.
function openOrdersFor(db, userId) {
  return db
    .prepare(
      `SELECT o.id, o.market_id, o.side, o.price, o.stake_cents, o.matched_cents, o.frozen_cents, o.status, o.placed_at,
              o.selection_id, s.name AS selection_name, m.name AS market_name, e.name AS event_name
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
  return { selection_id: s.id, name: s.name, pnl_cents: pnl };
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
