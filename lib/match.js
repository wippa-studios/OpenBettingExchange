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
              m.status AS market_status, e.status AS event_status
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
  return { stake, price: p, sel };
}

// Apply one fill of `fill` cents at match price `price` to a LAY-side
// order (the taker's own lay, or a resting lay a back taker just matched).
// `lay` is an orders ROW (or row-like): snake_case `user_id` + `price`.
// Adjusts the layer's wallet per the escrow contract above and returns
// the order's new remainder escrow (its new frozen_cents).
function applyLayFill(db, lay, fill, price, remBefore, remEscBefore, ref) {
  const fillLiability = Math.round((price - 1) * fill); // single rounding point
  const remEscAfter = escrowFor('lay', lay.price, remBefore - fill);
  const delta = remEscBefore - fillLiability - remEscAfter;
  if (delta > 0) release(db, lay.user_id, delta, ref);
  else if (delta < 0) escrow(db, lay.user_id, -delta, ref); // rare 1-cent top-up
  return remEscAfter;
}

// Sweep the opposite book and fill resting orders at THEIR price — best
// price first (highest lay for a back taker, lowest back for a lay
// taker), FIFO within a level (ORDER BY price, id). One fill touches two
// orders: the resting one, and the taker's own when the taker is the lay
// side. Returns { fills, remaining, remEsc }.
function sweepAndFill(db, { sel, orderId, userId, side, price, stake, remEsc }) {
  const layTaker = side === 'lay';
  const resting = layTaker
    ? stmtsFor(
        db,
        'rests-back',
        `SELECT * FROM orders WHERE selection_id = ? AND side = 'back' AND status = 'open' AND price <= ?
         ORDER BY price ASC, id ASC`
      ).all(sel.selection_id, price)
    : stmtsFor(
        db,
        'rests-lay',
        `SELECT * FROM orders WHERE selection_id = ? AND side = 'lay' AND status = 'open' AND price >= ?
         ORDER BY price DESC, id ASC`
      ).all(sel.selection_id, price);
  const insMatch = stmtsFor(
    db,
    'ins-match',
    'INSERT INTO matches (market_id, selection_id, back_order_id, lay_order_id, price, stake_cents) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const updResting = stmtsFor(
    db,
    'upd-resting',
    'UPDATE orders SET matched_cents = ?, frozen_cents = ?, status = ?, updated_at = ? WHERE id = ?'
  );
  const fills = [];
  let remaining = stake;
  for (const o of resting) {
    if (remaining === 0) break;
    if (o.user_id === userId) continue; // self-match guard
    const avail = o.stake_cents - o.matched_cents;
    if (avail <= 0) continue;
    const fill = Math.min(remaining, avail);
    const at = o.price; // the resting order's price stands
    insMatch.run(sel.market_id, sel.selection_id, layTaker ? o.id : orderId, layTaker ? orderId : o.id, at, fill);
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

// A UNIQUE violation on the (user_id, client_order_id) index. Matched on the
// index name as well as the generic constraint text so an unrelated unique
// violation (e.g. a duplicate username) is never mistaken for an idempotent
// replay and silently swallowed.
function isClientOrderIdConflict(e) {
  if (!e || typeof e !== 'object') return false;
  if (typeof e.errcode === 'number' && (e.errcode & 0xff) === 19) {
    return String(e.message || '').includes('idx_orders_client_id');
  }
  return String(e.message || '').includes('idx_orders_client_id');
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

  // Insert first so match rows can reference this order; frozen_cents is
  // the per-order escrow source of truth (at placement: the full stake's).
  const info = db
    .prepare(
      `INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents, matched_cents, frozen_cents, status, placed_at, client_order_id)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'open', ?, ?)`
    )
    .run(u.id, sel.market_id, sel.selection_id, req.side, price, stake, esc, now(), clientOrderId);
  const orderId = info.lastInsertRowid;

  // Phase 1 daily clamp: once the user's net-settlement cap for today is
  // reached, the order still RESTS — it simply does not sweep. Cancelling it
  // would be worse than useless: it would change the meaning of the book for
  // everyone else looking at it, and an order that vanished for no stated
  // reason is a support incident.
  const swept = LIMITS.matchingAllowed(db, u.id, sel.market_id)
    ? sweepAndFill(db, { sel, orderId, userId: u.id, side: req.side, price, stake, remEsc: esc })
    : { fills: [], remaining: stake, remEsc: esc };
  const matched = finalizeTaker(db, { orderId, side: req.side, price, stake, remaining: swept.remaining, sel });
  recordTrades(db, sel, swept.fills, matched);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
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
function bookFor(db, marketId, levels = 3) {
  const sels = stmtsFor(db, 'book-sels', 'SELECT id, name, status, ltp FROM selections WHERE market_id = ? ORDER BY id').all(marketId);
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
  const markets = db
    .prepare(
      `SELECT DISTINCT m.id AS market_id, m.name AS market_name, m.status AS market_status,
              m.winner_selection_id, e.name AS event_name
       FROM matches mt
       JOIN orders bo ON bo.id = mt.back_order_id
       JOIN orders lo ON lo.id = mt.lay_order_id
       JOIN markets m ON m.id = mt.market_id
       JOIN events e ON e.id = m.event_id
       WHERE bo.user_id = ? OR lo.user_id = ?
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
  validateClientOrderId,
  existingByClientOrderId,
  cancelOrder,
  openOrdersFor,
  bookFor,
  marketOverround,
  positionsFor,
  myMatchedBets,
  escrowFor,
};
