'use strict';
// lib/settle.js — market settlement: pot distribution + commission.
//
// Pot accounting per match (stake s, match price Q): the pot is s (backer's
// escrow) + (Q-1)*s (layer's escrow) = s*Q. Winner side is credited the pot;
// void refunds each side's own contribution. Money is conserved except the
// commission, which is charged on NET winnings per user per market.
//
// Escrow coordination (see lib/match.js's contract): each order's
// orders.frozen_cents is the tracked escrow of its unmatched remainder, so
// the auto-cancel below releases exactly that column — and the matched
// liabilities released here (round((Q-1)*s) per match, the same single
// rounding point the fills used) are always covered by the wallet, by
// construction. After settlement every participant's frozen_cents is 0.
const { httpError } = require('./auth');
const { release, settleUser } = require('./ledger');
const { transaction } = require('./tx');
const { now } = require('./util');
const config = require('./config');

// settleMarket(marketId, {winner_selection_id} | {void: true})
// Settlement is irreversible, so validate the caller's intent STRICTLY:
// `void: "false"` must never void a market, and a winner must be a positive
// integer selection id (never a coerced boolean/string).
function settleMarket(db, marketId, opts = {}) {
  const { winner_selection_id: rawWinner = null, void: rawVoid = false } = opts || {};
  if (typeof rawVoid !== 'boolean') {
    throw httpError(400, 'void must be a boolean (true/false)');
  }
  if (rawVoid && rawWinner !== null) {
    throw httpError(400, 'Provide either a winner_selection_id or void:true, not both');
  }
  let winner = null;
  if (!rawVoid) {
    if (typeof rawWinner !== 'number' || !Number.isInteger(rawWinner) || rawWinner <= 0) {
      throw httpError(400, 'winner_selection_id must be a positive integer (or pass void: true)');
    }
    winner = rawWinner;
  }
  const voidMarket = rawVoid;

  return transaction(db, () => settleTx(db, marketId, winner, voidMarket));
}

function settleTx(db, marketId, winner, voidMarket) {
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (!market) throw httpError(404, 'Market not found');
  if (market.status === 'settled') throw httpError(409, 'Market already settled');

  markSettled(db, market, winner, voidMarket);
  autoCancelOpenOrders(db, marketId);
  const perUser = aggregateMatches(db, marketId, winner, voidMarket);
  const summary = settlePerUser(db, marketId, perUser, voidMarket);
  completeEventIfNeeded(db, market.event_id);

  const updated = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  return { market: updated, per_user: summary };
}

// Record the outcome: winner (must belong to THIS market) or void.
function markSettled(db, market, winner, voidMarket) {
  if (voidMarket) {
    db.prepare("UPDATE markets SET status = 'settled', settled_at = ?, winner_selection_id = NULL WHERE id = ?").run(now(), market.id);
    db.prepare("UPDATE selections SET status = 'void' WHERE market_id = ?").run(market.id);
    return;
  }
  const sel = db.prepare('SELECT * FROM selections WHERE id = ? AND market_id = ?').get(winner, market.id);
  if (!sel) throw httpError(400, 'Winner selection is not in this market');
  db.prepare("UPDATE markets SET status = 'settled', settled_at = ?, winner_selection_id = ? WHERE id = ?").run(now(), winner, market.id);
}

// Auto-cancel every open (unmatched-remainder) order in the market,
// releasing exactly its tracked remainder escrow (orders.frozen_cents).
// The MATCHED part's liability stays frozen for the settlement step below.
function autoCancelOpenOrders(db, marketId) {
  const openOrders = db.prepare("SELECT * FROM orders WHERE market_id = ? AND status = 'open'").all(marketId);
  const cancel = db.prepare("UPDATE orders SET status = 'cancelled', frozen_cents = 0, updated_at = ? WHERE id = ?");
  for (const o of openOrders) {
    if (o.frozen_cents > 0) release(db, o.user_id, o.frozen_cents, { orderId: o.id, marketId });
    cancel.run(now(), o.id);
  }
}

// Resolve matched bets -> per-user aggregates (pot accounting).
function aggregateMatches(db, marketId, winner, voidMarket) {
  const rows = db
    .prepare(
      `SELECT mt.back_order_id, mt.lay_order_id, mt.selection_id, mt.price, mt.stake_cents,
              bo.user_id AS back_user, lo.user_id AS lay_user
       FROM matches mt
       JOIN orders bo ON bo.id = mt.back_order_id
       JOIN orders lo ON lo.id = mt.lay_order_id
       WHERE mt.market_id = ?`
    )
    .all(marketId);

  const perUser = new Map();
  const acc = (uid, d, f, r) => {
    const cur = perUser.get(uid) || { balanceDelta: 0, frozenRelease: 0, refundCents: 0 };
    cur.balanceDelta += d;
    cur.frozenRelease += f;
    cur.refundCents += r;
    perUser.set(uid, cur);
  };

  for (const m of rows) {
    const s = m.stake_cents;
    const Q = m.price;
    const liability = Math.round((Q - 1) * s); // single rounding point (matches the fill-time liability)
    if (voidMarket) {
      acc(m.back_user, 0, s, s);
      acc(m.lay_user, 0, liability, liability);
    } else if (m.selection_id === winner) {
      // Backer wins: their own stake unfreezes, the layer's liability pays them.
      acc(m.back_user, liability, s, 0);
      acc(m.lay_user, -liability, liability, 0);
    } else {
      // Layer wins: the backer's stake pays them.
      acc(m.back_user, -s, s, 0);
      acc(m.lay_user, s, liability, 0);
    }
  }
  return perUser;
}

// Settle per user: commission on NET winnings only (house pattern), one
// settlements row each.
function settlePerUser(db, marketId, perUser, voidMarket) {
  const summary = [];
  for (const [uid, a] of perUser) {
    const pnl = a.balanceDelta; // net winnings (can be negative)
    const commission = pnl > 0 ? Math.round(pnl * config.COMMISSION_RATE) : 0;
    settleUser(db, uid, {
      balanceDelta: a.balanceDelta,
      frozenRelease: a.frozenRelease,
      commissionCents: commission,
      refundCents: voidMarket ? a.refundCents : 0,
      marketId,
    });
    // credit_cents = gross received back (risked + net) = the pot share won.
    db.prepare(
      'INSERT INTO settlements (market_id, user_id, credit_cents, commission_cents, pnl_cents) VALUES (?, ?, ?, ?, ?)'
    ).run(marketId, uid, a.frozenRelease + a.balanceDelta, commission, pnl);
    summary.push({ user_id: uid, pnl_cents: pnl, commission_cents: commission });
  }
  return summary;
}

// An event completes when all of its markets are settled.
function completeEventIfNeeded(db, eventId) {
  const remaining = db
    .prepare("SELECT COUNT(*) AS n FROM markets WHERE event_id = ? AND status != 'settled'")
    .get(eventId).n;
  if (remaining === 0) {
    db.prepare("UPDATE events SET status = 'completed' WHERE id = ?").run(eventId);
  }
}

// Settled history for a user, from the precomputed settlements table.
function settledFor(db, userId) {
  return db
    .prepare(
      `SELECT st.*, m.name AS market_name, e.name AS event_name, s.name AS selection_name
       FROM settlements st
       JOIN markets m ON m.id = st.market_id
       JOIN events e ON e.id = m.event_id
       LEFT JOIN selections s ON s.id = m.winner_selection_id
       WHERE st.user_id = ?
       ORDER BY st.id DESC`
    )
    .all(userId);
}

module.exports = { settleMarket, settledFor };
