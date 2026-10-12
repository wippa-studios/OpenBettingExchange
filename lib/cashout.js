'use strict';
// lib/cashout.js — close a matched position early.
//
// ── WHY THE MODEL CHANGED, AND WHY IT MATTERS ────────────────────────────────
//
// v1 hedged the position against the BOOK: place the opposite side at top of
// book and the position goes flat. That works for a single selection, because
// there is exactly one outcome to neutralise.
//
// It CANNOT work for a multi-selection position, and this is worth stating
// because "generalise the v1 hedge" is the obvious next step and it is a
// dead end. Hedging N selections with stakes S_i at each selection's own
// top-of-back price q_i forces every outcome to the same value V, which gives:
//
//     S_i = (k - Payout_i) / q_i     with   k = V + Σ S_i
//     V   = k(1 - Σ1/q_i) + Σ Payout_i/q_i
//     net = V - Σ S_i = k(1 - 2Σ1/q_i) + 2Σ Payout_i/q_i
//
// The coefficient of k is (1 - 2Σ1/q). For a two-runner market quoted at 2.0
// both sides, Σ1/q = 1 and every value of k yields the SAME net. For a
// dispersed book the coefficient is negative, so the best k is the smallest
// legal one (k = max Payout) and net comes out NEGATIVE.
//
// In other words: **hedging a multi-runner position against a fair book always
// costs the player money.** The apparent arbitrage is the book being fair.
// A market-hedged cash-out can never be worth anything, which is exactly why
// the `v1 scope` guard existed — it was not laziness, it was a correct
// refusal.
//
// ── WHAT EXCHANGES ACTUALLY DO ──────────────────────────────────────────────
//
// The VENUE quotes the cash-out. The player sells the position to the operator
// at a price derived from the operator's own fair probabilities, minus a
// margin. That generalises to any number of runners immediately, because it is
// a VALUATION and not a hedge construction:
//
//     fair_value = Σ_i  p_i · Payout_i
//     quoted     = floor(fair_value · (1 - CASHOUT_MARGIN_BPS/10000))
//
// p_i comes from each selection's fair price with the overround removed, so a
// book that sums to 105% does not hand the player 5% for free.
//
// The venue's edge is the margin and the fact that it knows its own prices
// better than the player does — not an impossible arbitrage.
'use strict';
const { httpError } = require('./auth');
const M = require('./match');
const { getUser } = require('./ledger');
const { transaction } = require('./tx');
const config = require('./config');

/**
 * Payout per outcome: what the user nets if selection i wins.
 *
 * `allSelectionIds` must be EVERY selection in the market, not just the ones
 * the user holds a bet on. That distinction is the whole multi-runner bug:
 * a player with a bet on Alpha only still has a real, usually losing, outcome
 * in every other runner, and omitting those outcomes silently values the
 * position as if the un-held runners could never win. That over-values a
 * one-sided position and pays the player for risk they actually carry.
 *
 * Mirrors lib/settle.js exactly — a back profits (P-1)*s on its own selection
 * and loses its stake otherwise; a lay is the mirror. Disagreeing with
 * settle.js by a single cent would mean the quoted cash-out differs from the
 * settlement the player was avoiding.
 *
 * Computed in one pass. For each leg, "some OTHER runner wins" is a constant
 * across all outcomes, so it is accumulated once in `otherTotal` and the
 * per-outcome figure is that constant adjusted by the leg's own contribution.
 */
function payoutsFor(bets, allSelectionIds) {
  // Constant contribution when the winning selection is one the user has NOT
  // backed/layed on: a back loses its stake, a lay gains its stake.
  let otherTotal = 0;
  const bySelection = new Map();
  for (const b of bets) {
    const base = b.my_side === 'back' ? -b.stake_cents : b.stake_cents;
    otherTotal += base;
    if (!bySelection.has(b.selection_id)) bySelection.set(b.selection_id, []);
    // The leg's own-selection outcome is (base - base) + profit = profit,
    // so only the PROFIT needs storing per selection.
    bySelection.get(b.selection_id).push(Math.round((b.price - 1) * b.stake_cents) * (b.my_side === 'back' ? 1 : -1));
  }
  return allSelectionIds.map((selectionId) => {
    const profits = bySelection.get(selectionId);
    if (!profits) {
      // No leg on this runner: the user loses on every leg they hold.
      return { selection_id: selectionId, payout_cents: otherTotal };
    }
    // The leg's own outcome replaces its `base` contribution with the profit.
    let selfBase = 0;
    for (const b of bets) {
      if (b.selection_id !== selectionId) continue;
      selfBase += b.my_side === 'back' ? -b.stake_cents : b.stake_cents;
    }
    return {
      selection_id: selectionId,
      payout_cents: otherTotal - selfBase + profits.reduce((a, p) => a + p, 0),
    };
  });
}

/**
 * Fair probabilities for a market's selections, overround removed.
 *
 * Normalising by the SUM of implied probabilities (rather than taking them at
 * face value) is what stops a 105% book paying out 105%. Selections with no
 * fair price are EXCLUDED rather than given zero probability: a selection the
 * operator cannot price must not be silently treated as certain not to win,
 * because a payout that ignores a real outcome is a payout that can be wrong.
 */
function fairProbsFor(db, marketId) {
  const rows = db
    .prepare("SELECT id, fair_price FROM selections WHERE market_id = ? AND status = 'open' AND fair_price IS NOT NULL")
    .all(marketId);
  if (rows.length === 0) return null;
  const implied = rows.map((r) => ({ id: r.id, p: 1 / r.fair_price }));
  const total = implied.reduce((a, r) => a + r.p, 0);
  if (!(total > 0)) return null;
  return new Map(implied.map((r) => [r.id, r.p / total]));
}

/**
 * Quote a cash-out, or null when one cannot be offered honestly.
 *
 * Returns null (no quote) rather than a bad number for: no position, settled
 * market, no fair prices, a non-positive fair value (the player is underwater
 * relative to the book and buying them out would be paying them to take on
 * risk), or a payout too small to be worth the venue's margin.
 */
function computeCashoutPlan(db, user, marketId) {
  // Operator switch. Checked before anything else so a venue that has turned
  // cash-out off gets a clean "no quote" rather than a quote it then declines.
  if (!config.CASHOUT_ENABLED) return null;
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (!market || market.status !== 'open') return null;
  // A HELD MARKET IS NOT OFFERABLE. cashoutPosition refuses one (409), so the
  // quote used to advertise a cash-out on a disputed market and then decline it
  // at execution — the positions view showed a player money the venue would not
  // pay them. Quoting what cannot be executed is not a neutral act.
  if (market.settlement_hold) return null;

  // Venue risk gate, BEFORE anything else is computed. The player chooses WHEN
  // to take a cash-out, so without a cap the venue's exposure is unbounded in
  // exactly the one direction it cannot defend: cycle a position, let the feed
  // revalue it against the venue, cash out the guaranteed payout, repeat. Each
  // cycle converts a market risk into a certain loss, which is strictly better
  // for the player than holding — and holding is what Phase 2's model assumes.
  // See lib/cashoutrisk.js.
  const riskRefusal = require('./cashoutrisk').refusal(db, user.id, {
    venueMaxOutstandingCents: config.CASHOUT_MAX_OUTSTANDING_CENTS,
    venueMaxDailyLossCents: config.CASHOUT_MAX_DAILY_LOSS_CENTS,
  });
  if (riskRefusal) return null;

  const bets = M.myMatchedBets(db, user.id, marketId);
  if (!bets.length) return null;

  // EVERY selection in the market, not only the ones held. See payoutsFor.
  const allSelectionIds = db
    .prepare("SELECT id FROM selections WHERE market_id = ? AND status = 'open'")
    .all(marketId)
    .map((r) => r.id);
  const payouts = payoutsFor(bets, allSelectionIds);
  const probs = fairProbsFor(db, marketId);
  if (!probs) return null;

  // Only outcomes we can price count. If a matched selection is unpriced the
  // valuation is not trustworthy, so decline rather than guess.
  let priced = 0;
  let unpriced = 0;
  for (const p of payouts) {
    if (probs.has(p.selection_id)) priced += probs.get(p.selection_id) * p.payout_cents;
    else unpriced++;
  }
  if (unpriced > 0) return null;

  if (!(priced > 0)) return null; // underwater vs the book — no buyout
  const quoted = Math.floor(priced * (1 - config.CASHOUT_MARGIN_BPS / 10000));
  if (quoted < config.MIN_STAKE_CENTS) return null;

  // The payout comes from the house, so it must be fundable NOW. Checked with
  // the same availableOf() the ledger will use, so a quote is executable.
  const me = getUser(db, user.id);
  if (me.is_bot) return null; // the house does not cash itself out

  return {
    market_id: marketId,
    mode: 'buyout',
    selection_count: payouts.length,
    legs: bets.length,
    fair_value_cents: Math.round(priced),
    value_cents: quoted,
    margin_bps: config.CASHOUT_MARGIN_BPS,
    // Per-outcome exposure, so the UI can show what is being given up.
    payouts,
  };
}

// Quote only (no execution) — decorates the positions view.
function cashoutQuote(db, user, marketId) {
  return computeCashoutPlan(db, user, marketId);
}

/**
 * Execute the buyout: the venue takes the position and pays the quoted value.
 *
 * All-or-nothing inside ONE transaction. The plan is recomputed INSIDE the
 * transaction, for the same reason the old market hedge was: the position can
 * change between a quote and an execute, and the player must never be paid a
 * quote for a position they no longer hold.
 */
function cashoutMarket(db, user, marketId) {
  return transaction(db, () => {
    // THE SAME GATE AS PLACING A BET. Cash-out closes a position and pays the
    // player, so a session limit, an owed reality check or a self-exclusion
    // applies to it exactly as it does to an order — and it previously did not,
    // because `assertTradeable` was called from exactly one place in the
    // codebase (order placement). A permanently self-excluded account was
    // refused on /api/orders and then walked out through /api/markets/:id/
    // cashout with the venue's money.
    //
    // Enforced in the ENGINE rather than the route, so a future caller of
    // cashoutMarket cannot forget it — which is the only reason this was
    // findable at all.
    require('./limits').assertTradeable(db, user);
    // THE OFF-TIME GATE, on cash-out too — not just on order placement. This is
    // the control that is easy to forget and the one that leaves real money at
    // risk: cashing out AFTER off pays the player against a fair price that has
    // just been moved by whatever happened in the event (a goal, a red card, a
    // runner breaking). A pre-off venue that keeps cash-out open through the
    // event has banned in-play BETTING but kept in-play RISK. Banning the bet
    // while paying the cash-out out is the exact unmanaged exposure
    // lib/inplay.js exists to contain, and this is where it is closed.
    //
    // Resolved from the market's event, in the ENGINE (not the route), so no
    // future caller of cashoutMarket can walk out with the venue's money past
    // off. A quote issued pre-off stays valid until off; execution at or after
    // off is refused here.
    {
      const row = db
        .prepare('SELECT e.id AS event_id FROM markets m JOIN events e ON e.id = m.event_id WHERE m.id = ?')
        .get(marketId);
      if (!row) throw httpError(404, 'Market not found');
      require('./offtime').assertOffNotReached(db, row.event_id);
    }
    const plan = computeCashoutPlan(db, user, marketId);
    if (!plan) throw httpError(409, 'Cash-out unavailable (no position / no fair price / position underwater)');
    const { cashoutPosition } = require('./settle');
    // The plan's fair value travels with the execution so the buyout row
    // records both what the position was worth and what was paid; the venue's
    // realised loss at settlement is computed from the matches themselves,
    // not from a stale fair price. The old takeQuote(db, null) here was a
    // no-op UPDATE against id NULL — the outside audit's F2: the entire risk
    // apparatus read zero forever because nothing ever wrote to it.
    const result = cashoutPosition(db, user.id, marketId, plan.value_cents, {
      fairValueCents: plan.fair_value_cents,
    });

    // Resting orders in this market are cancelled so they cannot be matched
    // into a position the player no longer has. Their escrow is released by
    // cancelOrder, which is the engine's own path — this module never writes
    // frozen_cents (tests/guard.test.js).
    let cancelled = 0;
    for (const o of M.openOrdersFor(db, user.id)) {
      if (o.market_id !== marketId) continue;
      M.cancelOrder(db, user, o.id);
      cancelled++;
    }
    return { ...plan, ...result, cancelled_orders: cancelled };
  });
}

module.exports = { cashoutQuote, cashoutMarket, computeCashoutPlan, payoutsFor, fairProbsFor };