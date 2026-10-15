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

// THE SINGLE LIABILITY FORMULA. A lay's collateral on a matched stake s at price
// Q is round((Q−1)·s), and it has to be the same number in every place that
// moves it: at fill time, at a market void, at a cash-out, and — since #88 — at
// a SELECTION void.
//
// It was written out three times, identically, and a fourth copy is exactly how
// a refund and a settlement start disagreeing by a cent on a half-cent price.
// One function, four call sites: the escrow the engine froze and the escrow a
// refund returns are the same promise, so they are computed the same way.
function liabilityOf(price, stakeCents) {
  return Math.round((price - 1) * stakeCents);
}

// settleMarket(marketId, {winner_selection_id} | {dead_heat: [ids]} | {void: true})
// Settlement is irreversible, so validate the caller's intent STRICTLY:
// `void: "false"` must never void a market, and a winner must be a positive
// integer selection id (never a coerced boolean/string).
//
// A DEAD HEAT arrives as `dead_heat: [selId, ...]` — the set of joint winners.
// It is a real settlement, not a void: voiding a dead heat pays nobody, which
// underpays the winners and overcharges everyone else. The engine settles the
// winner SET, dividing the payout among the tied winners.
function settleMarket(db, marketId, opts = {}) {
  const { winner_selection_id: rawWinner = null, void: rawVoid = false, dead_heat: rawDead = null } = opts || {};
  if (typeof rawVoid !== 'boolean') {
    throw httpError(400, 'void must be a boolean (true/false)');
  }
  if (rawVoid && (rawWinner !== null || rawDead !== null)) {
    throw httpError(400, 'Provide either a winner or void:true, not both');
  }
  let winner = null;
  let winners = null;
  if (!rawVoid) {
    if (rawDead !== null) {
      if (!Array.isArray(rawDead)) {
        throw httpError(400, 'dead_heat must be an array of at least 2 joint winner selection ids');
      }
      // STRICTLY integers. The comment three lines above used to claim this
      // rejected coerced values, while the code called `Number()` on every
      // element — so `[true, 2]` became `[1, 2]`, `['1','2']` became `[1, 2]`
      // and `[[1],[2]]` became `[1, 2]`. That is exactly the coercion this
      // module documents itself as rejecting, it is reachable over the wire
      // because the route forwards the body unchanged, and it is how a
      // malformed request becomes a valid settlement of somebody's real money.
      // The three lines above it now do what they always said they did.
      const ids = [...new Set(rawDead)];
      if (ids.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x <= 0)) {
        throw httpError(400, 'dead_heat winner ids must be positive integers (not strings, booleans or arrays)');
      }
      // The COUNT is checked AFTER de-duplication: validating the raw array
      // length first let `[x, x]` through as a "dead heat" with one winner,
      // which records dead_heat=1 with a single joint winner — misleading in
      // the audit trail and a way around the two-winner rule entirely.
      if (ids.length < 2) {
        throw httpError(400, 'dead_heat must name at least 2 distinct joint winner selection ids');
      }
      winners = ids;
    } else {
      if (typeof rawWinner !== 'number' || !Number.isInteger(rawWinner) || rawWinner <= 0) {
        throw httpError(400, 'winner_selection_id must be a positive integer (or pass void: true)');
      }
      winner = rawWinner;
    }
  }
  const voidMarket = rawVoid;

  return transaction(db, () => settleTx(db, marketId, winner, voidMarket, winners));
}

function settleTx(db, marketId, winner, voidMarket, jointWinners = null) {
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (!market) throw httpError(404, 'Market not found');
  if (market.status === 'settled') throw httpError(409, 'Market already settled');

  // A HELD market is settled only through the reasoned release path. The
  // outside audit's F4: the feed poller and releaseHold both honour the hold,
  // but the plain admin settle route called straight into here, so any admin
  // could settle a disputed market without writing a reason. Enforcing it in
  // the settlement primitive — not in one caller — is the only shape where a
  // new route cannot quietly bypass it (the same reasoning as the first-run
  // lock and the placement limits).
  if (market.settlement_hold) {
    throw httpError(409, 'Market is held pending review; release it with a written reason first', {
      code: 'held',
      hold_reason: market.hold_reason || null,
    });
  }

  // The selections that were ALREADY void when settlement arrived, read BEFORE
  // markSettled. That ordering is load-bearing (#88): on a market void,
  // markSettled stamps `status = 'void'` onto every selection in the market, so
  // by the time the matches are aggregated the selections cannot tell you which
  // of them were refunded earlier by voidSelection and which this void has just
  // refunded along with everything else.
  //
  // Getting that wrong is a hard failure, not a rounding one: the earlier refund
  // already released that escrow, so the aggregate tries to release it again,
  // settleUser refuses ("releasing more than frozen"), and the whole settlement
  // rolls back. The market is then un-settleable by either route — voiding it
  // again hits the same wall — which is precisely the bricked-market-with-no-
  // repair-path outcome this codebase keeps paying for.
  const preVoided = alreadyVoidSelections(db, marketId);

  markSettled(db, market, winner, voidMarket, jointWinners);
  autoCancelOpenOrders(db, marketId);
  // The winner SET — an array for a dead heat, the single id otherwise. One
  // shape into the arithmetic, so the ordinary path is unchanged by
  // construction.
  const winnerSet = jointWinners || winner;
  const perUser = aggregateMatches(db, marketId, winnerSet, preVoided, voidMarket);
  const summary = settlePerUser(db, marketId, perUser, voidMarket);
  // Resolve any cash-out buyouts the venue executed in this market, so the
  // desk's realised-loss reading is the number the positions actually
  // returned rather than a pre-settlement estimate.
  require('./cashoutrisk').settleBuyouts(db, marketId, winnerSet, voidMarket);
  completeEventIfNeeded(db, market.event_id);

  const updated = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  // `previous_status` is returned rather than re-read by the caller, because
  // this is the row the transaction actually transitioned FROM. A caller that
  // SELECTed the status before calling would be reading a state that could
  // differ from the one that was really transitioned, and the audit row for
  // the most money-moving operator action in the venue would then be a
  // plausible-looking guess rather than a record. Returning it also makes the
  // correct behaviour the default: a route cannot forget to capture it.
  return { market: updated, per_user: summary, previous_status: market.status };
}

// Record the outcome: winner (must belong to THIS market) or void.
function markSettled(db, market, winner, voidMarket, jointWinners = null) {
  if (voidMarket) {
    db.prepare("UPDATE markets SET status = 'settled', settled_at = ?, winner_selection_id = NULL, dead_heat = 0, joint_winners = NULL WHERE id = ?").run(now(), market.id);
    db.prepare("UPDATE selections SET status = 'void' WHERE market_id = ?").run(market.id);
    return;
  }
  if (jointWinners) {
    // EVERY joint winner must belong to THIS market — a winner id from another
    // market is the foreign-selection 400, and a dead heat is not an exception
    // to it.
    for (const w of jointWinners) {
      if (!db.prepare('SELECT id FROM selections WHERE id = ? AND market_id = ?').get(w, market.id)) {
        throw httpError(400, 'Joint winner selection is not in this market');
      }
    }
    db.prepare(
      "UPDATE markets SET status = 'settled', settled_at = ?, winner_selection_id = NULL, dead_heat = 1, joint_winners = ? WHERE id = ?"
    ).run(now(), JSON.stringify(jointWinners), market.id);
    // Selections are deliberately NOT restatused. The ordinary win path leaves
    // them 'open' too, and the outcome of record is the market row
    // (winner_selection_id, or joint_winners for a dead heat). The first
    // version of this set them to 'lost', which the selections CHECK rejects
    // outright ('open','suspended','void') — and inventing a status here would
    // make the dead-heat path disagree with every market settled before it.
    return;
  }
  const sel = db.prepare('SELECT * FROM selections WHERE id = ? AND market_id = ?').get(winner, market.id);
  if (!sel) throw httpError(400, 'Winner selection is not in this market');
  db.prepare("UPDATE markets SET status = 'settled', settled_at = ?, winner_selection_id = ?, dead_heat = 0, joint_winners = NULL WHERE id = ?").run(now(), winner, market.id);
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

// The same cancel-and-release, scoped to ONE selection's resting orders.
// autoCancelOpenOrders above closes a whole market at settlement; this closes
// the ladder on a withdrawn runner while the market keeps trading.
function cancelOpenOrdersOnSelection(db, marketId, selectionIds) {
  const ph = selectionIds.map(() => '?').join(',');
  const openOrders = db
    .prepare(
      `SELECT * FROM orders WHERE market_id = ? AND status = 'open' AND selection_id IN (${ph})`
    )
    .all(marketId, ...selectionIds);
  const cancel = db.prepare("UPDATE orders SET status = 'cancelled', frozen_cents = 0, updated_at = ? WHERE id = ?");
  let released = 0;
  for (const o of openOrders) {
    if (o.frozen_cents > 0) {
      release(db, o.user_id, o.frozen_cents, { orderId: o.id, marketId });
      released += o.frozen_cents;
    }
    cancel.run(now(), o.id);
  }
  return { orders_cancelled: openOrders.length, released_cents: released };
}

// ── THE SELECTION-LEVEL VOID (#88) ───────────────────────────────────────────
//
// Until this existed, the only void in the venue was a WHOLE-MARKET void
// (`UPDATE selections SET status='void' WHERE market_id = ?` in markSettled), so
// a runner withdrawn before the off could not be removed at all. Its backers
// were charged full stake on a horse that never started, and the selection stayed
// 'open' — quoted in the ladder, priced into the positions matrix, and settled as
// an ordinary loser. The books balanced throughout: the money went somewhere real,
// just to the wrong person, which is the one failure class conservation cannot
// see (the same blind spot as the `greyhounds`/`greyhound` slug mismatch).
//
// A selection void is NOT a smaller market void, and the difference is money:
//
//   - the market KEEPS TRADING. Every other runner's book is untouched, so the
//     venue does not stop offering a race that is still running;
//   - a RESTING order on the voided runner is cancelled and its remainder escrow
//     released, exactly as at settlement — nobody's unmatched stake is stranded;
//   - a MATCHED leg is REFUNDED at the match price: the backer gets the stake
//     back and the layer gets the liability back. This is the same arithmetic the
//     market-level void uses, restricted to those legs, and it is a REFUND
//     (balanceDelta 0) rather than a transfer — the pot does not move, it comes
//     back;
//   - the selection becomes 'void', which is the durable record every later read
//     uses: lib/match.js refuses new orders on it, the bot stops quoting it
//     (lib/bots.js filters on status='open'), settlement skips its legs, and
//     cash-out refuses to buy out a position that has already been refunded.
//
// NO `settlements` ROW. Nothing was settled on this runner; the refund is a
// `refund` transaction in the wallet, which is where the player's own history
// shows it. A zero-P&L settlement row would put a phantom settlement of an
// OPEN market into per-market settlement reports.
//
// THE AUDIT ROW IS WRITTEN HERE, INSIDE THIS TRANSACTION, and by the primitive
// rather than by its callers. settleMarket's audit belongs to its callers
// (lib/results.js and the admin route), which was tolerable when there were two
// of them; this primitive moves money too and has a question only one of the two
// can answer — who removed this runner — so the row is written where the
// mutation is, with `mustRecord` rather than `record`, so a refund cannot commit
// with no record of it at all. That is the invariant lib/audit.js documents:
// an audit row can never exist for a change that rolled back, and a change that
// could not be audited does not happen.
function voidSelection(db, marketId, selectionIds, { actor = null, reason } = {}) {
  // STRICT ids, no coercion. `Number(true) === 1`, so a coerced `[true]` would
  // void selection 1 — a real runner, on a market the caller never named. This
  // is the same reasoning lib/settle.js applies to joint winners, and the same
  // laundering #61 found in releaseHold.
  if (!Array.isArray(selectionIds) || selectionIds.length === 0) {
    throw httpError(400, 'voidSelection needs at least one selection id');
  }
  const ids = [...new Set(selectionIds)];
  if (ids.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x <= 0)) {
    throw httpError(400, 'selection ids must be positive integers (not strings, booleans or arrays)');
  }
  // A WRITTEN REASON IS REQUIRED. The market-level release requires one for the
  // same reason: whoever removed a runner from a market has to be able to say
  // why, to a player disputing it and to a regulator afterwards. A system action
  // (the results feed) names its source instead.
  if (!reason || String(reason).trim().length < 5) {
    throw httpError(400, 'A written reason is required to void a selection');
  }
  return transaction(db, () => voidSelectionTx(db, marketId, ids, { actor, reason: String(reason).trim() }));
}

function voidSelectionTx(db, marketId, ids, { actor, reason }) {
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (!market) throw httpError(404, 'Market not found');
  // A SETTLED market is terminal. Its money has already moved — the winner has
  // been paid and every stake released — so there is nothing left to refund, and
  // "void this selection now" would be a request to take money back from a
  // player who has already been paid.
  if (market.status === 'settled') throw httpError(409, 'Market already settled');
  // A HELD market is a dispute a machine could not decide. Voiding one selection
  // out from under the operator who is adjudicating it would resolve the dispute
  // by accident, through the back door — the same reason settleTx refuses.
  if (market.settlement_hold) {
    throw httpError(409, 'Market is held pending review; release it with a written reason first', {
      code: 'held',
      hold_reason: market.hold_reason || null,
    });
  }
  // A selection id from ANOTHER market must not be voided through this one. The
  // id is the only thing that says which runner to remove, so a foreign id is a
  // caller mistake with money on it.
  const rows = db
    .prepare(`SELECT id, name, status FROM selections WHERE market_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
    .all(marketId, ...ids);
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    const foreign = ids.filter((x) => !found.has(x));
    throw httpError(400, `Selection is not in this market: ${foreign.join(', ')}`);
  }
  // IDEMPOTENT, because feeds re-deliver and an operator button can be pressed
  // twice. A selection that is ALREADY void has had its matched legs refunded
  // and its orders cancelled; running the refund again would release escrow that
  // is no longer there and throw an integrity error out of a re-delivery. So the
  // already-void ids are reported and skipped — moving no money at all.
  const fresh = rows.filter((r) => r.status !== 'void');
  const alreadyVoid = rows.filter((r) => r.status === 'void').map((r) => r.id);
  if (fresh.length === 0) {
    return {
      market_id: marketId,
      voided_selections: [],
      already_void: alreadyVoid,
      orders_cancelled: 0,
      released_cents: 0,
      refunded_cents: 0,
      per_user: [],
    };
  }

  const freshIds = fresh.map((r) => r.id);
  const ph = freshIds.map(() => '?').join(',');
  const cancelled = cancelOpenOrdersOnSelection(db, marketId, freshIds);

  // MATCHED LEGS: refund each side its OWN contribution at the MATCH price, the
  // identical arithmetic (and the identical rounding point) as a market-level
  // void. `ledger.settleUser` with balanceDelta 0 and refundCents > 0 is what
  // makes this a refund rather than a payout: balance does not move, frozen
  // comes down, and the player sees a `refund` line in their wallet.
  const legs = db
    .prepare(
      `SELECT mt.selection_id, mt.price, mt.stake_cents,
              bo.user_id AS back_user, lo.user_id AS lay_user
         FROM matches mt
         JOIN orders bo ON bo.id = mt.back_order_id
         JOIN orders lo ON lo.id = mt.lay_order_id
        WHERE mt.market_id = ? AND mt.selection_id IN (${ph}) AND mt.cashout = 0`
    )
    .all(marketId, ...freshIds);
  const perUser = new Map();
  const acc = (uid, cents) => {
    const cur = perUser.get(uid) || { frozenRelease: 0, refundCents: 0 };
    cur.frozenRelease += cents;
    cur.refundCents += cents;
    perUser.set(uid, cur);
  };
  for (const m of legs) {
    acc(m.back_user, m.stake_cents);
    acc(m.lay_user, liabilityOf(m.price, m.stake_cents));
  }
  const summary = [];
  let refunded = 0;
  for (const [uid, a] of perUser) {
    settleUser(db, uid, { balanceDelta: 0, frozenRelease: a.frozenRelease, commissionCents: 0, refundCents: a.refundCents, marketId });
    refunded += a.refundCents;
    summary.push({ user_id: uid, refund_cents: a.refundCents });
  }

  db.prepare(`UPDATE selections SET status = 'void' WHERE market_id = ? AND id IN (${ph})`).run(marketId, ...freshIds);
  require('./audit').mustRecord(
    db, actor,
    require('./audit').ACTIONS.SELECTION_VOIDED,
    `market:${marketId}`,
    { selections: fresh.map((r) => ({ id: r.id, name: r.name, status: r.status })) },
    { selections: fresh.map((r) => ({ id: r.id, name: r.name, status: 'void' })), refunded_cents: refunded, released_cents: cancelled.released_cents, orders_cancelled: cancelled.orders_cancelled },
    reason
  );

  return {
    market_id: marketId,
    voided_selections: freshIds,
    already_void: alreadyVoid,
    orders_cancelled: cancelled.orders_cancelled,
    released_cents: cancelled.released_cents,
    refunded_cents: refunded,
    per_user: summary,
  };
}

// The selections this market has already refunded, as ids. Read before
// markSettled, which is the only thing that makes it meaningful — see the call
// site.
function alreadyVoidSelections(db, marketId) {
  return db
    .prepare("SELECT id FROM selections WHERE market_id = ? AND status = 'void'")
    .all(marketId)
    .map((r) => r.id);
}

// Resolve matched bets -> per-user aggregates (pot accounting).
//
// `preVoided` is the set of selection ids whose matched legs have ALREADY been
// refunded — by a selection void (#88) — and must never be settled again. It is
// passed in rather than re-read from `selections.status` here, because on a
// market void markSettled has by now voided every selection and the column can
// no longer distinguish "refunded earlier" from "refunded just now".
//
// `voidMarket` still means what it always did — refund EVERY remaining leg — and
// it is deliberately independent of `preVoided`: a market void refunds the field,
// minus whatever a withdrawal has already given back.
function aggregateMatches(db, marketId, winner, preVoided = [], voidMarket = false) {
  // OMITTED ENTIRELY WHEN NOTHING IS PRE-VOIDED, rather than emitted as
  // `NOT IN (NULL)`. That is not a stylistic preference: `x NOT IN (NULL)` is
  // NULL — unknown, not true — in SQL, so the clause excluded EVERY match and
  // the ordinary win path settled nothing while reporting success. The empty
  // list is the overwhelmingly common case, so the conditional is the honest
  // shape: no clause, or a clause with ids in it.
  const excluded = preVoided.length
    ? ` AND mt.selection_id NOT IN (${preVoided.map(() => '?').join(',')})`
    : '';
  const rows = db
    .prepare(
      `SELECT mt.back_order_id, mt.lay_order_id, mt.selection_id, mt.price, mt.stake_cents,
              bo.user_id AS back_user, lo.user_id AS lay_user
       FROM matches mt
       JOIN orders bo ON bo.id = mt.back_order_id
       JOIN orders lo ON lo.id = mt.lay_order_id
       -- CASHED-OUT MATCHES ARE NOT EXPOSURE ANY MORE. A cash-out bought the
       -- position off the player, released their collateral and paid them the
       -- quoted value; settling the same match again would pay it twice, which
       -- is the worst bug this system could have. The flag is on matches,
       -- because orders.frozen_cents is engine-owned (tests/guard.test.js).
       --
       -- NOR ARE MATCHES ON AN ALREADY-REFUNDED SELECTION (#88). A runner
       -- withdrawn before the off had its legs REFUNDED by voidSelection: the
       -- backer got the stake back, the layer the liability, and that escrow is
       -- gone. Settling them again would debit a stake already returned — and not
       -- merely double-count, because the wallet's frozen is already zero for
       -- them, so settleUser throws "releasing more than frozen" and rolls back
       -- the ENTIRE market's payout over a runner that never raced.
       --
       -- The exclusion is the id SET PASSED IN, not a re-read of the status
       -- column, and it is passed in because on a market void markSettled has
       -- just stamped 'void' onto every selection: a column read here could not
       -- tell "refunded earlier by a withdrawal" from "refunded just now by this
       -- void". Filtering on the column made a market void refund NOTHING — every
       -- match excluded, every backer's escrow stranded — which is what
       -- tests/settle.test.js (S4, S10) caught.
       WHERE mt.market_id = ? AND mt.cashout = 0${excluded}`
    )
    .all(marketId, ...preVoided);

  // The WINNING SET. A single winner is a set of ONE, so the ordinary path runs
  // through exactly the same arithmetic as the dead-heat path — floor(x/1) is x
  // — and the pre-existing settlement behaviour is unchanged by construction
  // rather than by a branch someone has to keep in sync. That matters: this is
  // the most carefully tested path in the codebase, and "unchanged" here means
  // proved by the existing suite, not asserted.
  const winners = Array.isArray(winner) ? winner.map(Number) : (winner === null || winner === undefined ? [] : [Number(winner)]);
  const winnerSet = new Set(winners);
  const shareCount = winnerSet.size;

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
    const liability = liabilityOf(Q, s); // single rounding point (matches the fill-time liability)
    if (voidMarket) {
      acc(m.back_user, 0, s, s);
      acc(m.lay_user, 0, liability, liability);
    } else if (winnerSet.has(m.selection_id)) {
      // Backer wins — possibly JOINTLY.
      //
      // WHAT DIVIDES IS THE PAYOUT, NOT THE STAKE. Each side returns its OWN
      // collateral in full (the backer their s, the layer their liability L),
      // and the wager result itself is the liability divided among the tied
      // winners. The first version of this code divided the STAKE as well,
      // which strands escrow: a backer releases only their n-th share, and
      // nobody ever releases the other shares when the joint winner has no
      // backers of their own — so frozen_cents does not reach zero after
      // settlement, which the property sweep asserts for every participant.
      //
      // THE SHARE IS FLOORED, and that is not a rounding preference. With a
      // rounded share, splitting one large win into many tiny matches wins the
      // rounding every time: a 1-cent match at 2.0 has L=1, so with two joint
      // winners round(0.5)=1 and the player wins a full cent on a cent stake,
      // repeatably — the same splitter exploit the audit found in commission
      // (F7). Flooring closes the direction; the sub-cent remainder simply
      // never leaves the layer's collateral, so no accounting is needed for it
      // and conservation is exact per match, because BOTH sides are debited
      // the same floored number.
      const share = Math.floor(liability / shareCount);
      acc(m.back_user, share, s, 0);
      acc(m.lay_user, -share, liability, 0);
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
    // THE VENUE PAYS NO COMMISSION TO ITSELF. commissionBpsForUser is called
    // for every participant with no is_bot exclusion, so a market in which NO
    // PLAYER won anything — every real backer having been bought out — booked
    // venue revenue out of the house's own cash-out takeover win. That is not
    // fee income: it inflates the commission base in every report and shows the
    // operator collecting a fee from themselves.
    const isBot = !!db.prepare('SELECT is_bot FROM users WHERE id = ?').get(uid)?.is_bot;
    // PER-TENANT commission, in bps (the outside audit's F6: the operator-
    // configurable rate was stored, audited, displayed in the admin UI — and
    // never consulted here, so every tenant kept paying the global rate).
    const bps = require('./tenants').commissionBpsForUser(db, uid);
    // Rounding is CEIL, i.e. house-favourable, deliberately. ROUND down let a
    // player SPLIT a large win across markets to shave commission (the audit's
    // F7: 4198 in one market paid 105; as 2099+2099 it paid 104). With ceil,
    // splitting can only pay MORE, so the exploit direction is gone — and the
    // cost to a player is at most one cent per market.
    const commission = !isBot && pnl > 0 ? Math.ceil((pnl * bps) / 10000) : 0;
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

/**
 * Close ONE user's position in a market as a cash-out buyout.
 *
 * Lives here, not in lib/cashout.js, because it moves matched escrow and only
 * this module may write it (tests/guard.test.js).
 *
 * THE COUNTERPARTY MUST NOT BE STRANDED, and that is the subtle part. Marking
 * the player's matches cashout=1 removes them from settlement — but a match is
 * a match between TWO users, so naively excluding it would leave the
 * OPPONENT's collateral frozen forever, never settled, never released. The
 * venue therefore TAKES OVER the player's side: a replacement match is created
 * with the house on the player's side and the same counterparty on the other.
 * At settlement the counterparty meets the venue, exactly as they would have
 * met the player.
 *
 * Three things happen, atomically:
 *   1. the player's matched collateral is released (their own money back — a
 *      cash-out sells the POSITION, it does not confiscate the stake);
 *   2. the quoted value is paid house -> player, through the normal ledger;
 *   3. replacement matches put the venue on the player's side, and the
 *      originals are flagged cashout=1 so they are never settled.
 *
 * Step 3 is the one that must never be forgotten. Skipping it is a
 * double-settlement on the player's side and a permanent freeze on the
 * counterparty's. Neither is a rounding error.
 */
function cashoutPosition(db, userId, marketId, payoutCents, { fairValueCents = null } = {}) {
  if (!Number.isInteger(payoutCents)) {
    throw httpError(500, 'Cash-out payout must be an integer number of cents');
  }

  // THE PRIMITIVE DEFENDS ITSELF (the outside audit's F3). Its single caller
  // checks market state, and that was the entire guard: the money-moving
  // function itself would happily pay out against an already-SETTLED market,
  // releasing some other market's escrow to cover it, stranding the
  // counterparty, and leaving the market permanently un-settleable. Any
  // second caller — a batch tool, a future API, an admin script — would have
  // inherited none of the guard. State validation lives here, where the money
  // moves, so it cannot be bypassed by calling from somewhere new.
  const mkt = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (!mkt) throw httpError(404, 'Market not found');
  if (mkt.status !== 'open') throw httpError(409, `Market is ${mkt.status}`);
  if (mkt.settlement_hold) {
    throw httpError(409, 'Market is held pending review', { code: 'held', hold_reason: mkt.hold_reason || null });
  }

  const legs = db
    .prepare(
      `SELECT mt.id AS match_id, mt.selection_id, mt.price, mt.stake_cents,
              mt.back_order_id, mt.lay_order_id,
              bo.user_id AS back_user, lo.user_id AS lay_user
         FROM matches mt
         JOIN orders bo ON bo.id = mt.back_order_id
         JOIN orders lo ON lo.id = mt.lay_order_id
         JOIN selections sn ON sn.id = mt.selection_id
        WHERE mt.market_id = ? AND mt.cashout = 0
          AND (bo.user_id = ? OR lo.user_id = ?)
          -- ONLY ON A SELECTION THAT STILL EXISTS AS AN OUTCOME (#88). A leg on
          -- a voided runner has ALREADY been refunded to both sides by
          -- voidSelection() — the player's stake came back and their escrow is
          -- gone — so buying that position out would pay them a second time for
          -- a position they do not hold. computeCashoutPlan already declines in
          -- that state (an unpriceable outcome refuses the quote), so this is
          -- the primitive defending itself rather than repairing a reachable
          -- bug: the whole point of the guard is that a second caller inherits
          -- the protection.
          AND sn.status = 'open'`
    )
    .all(marketId, userId, userId);
  if (legs.length === 0) throw httpError(409, 'No open position to cash out');

  const house = require('./bots').ensureBot(db);

  // ONE accumulator, because there is only one quantity (#20).
  //
  // This used to be two — `frozenRelease` and `transferred` — both summing
  // `legFrozen` on adjacent lines, and both returned. They could never differ:
  // the player's collateral released per leg and the escrow the house takes on
  // per leg are the same number moved from one balance to another (see the
  // `ledger.escrow(house, legFrozen)` call below). Two accumulators for one
  // number is two variables free to drift the next time someone edits one of
  // them.
  //
  // Both RESPONSE fields are kept, because `transferred_cents` is part of the
  // documented response body and removing a documented field is a breaking API
  // change rather than a tidy-up. `transferred_cents` is an alias for the same
  // figure; docs/API.md says so. If one of them ever does need to mean
  // something different, that is the moment to split them — deliberately, with
  // the arithmetic to back it.
  let frozenRelease = 0;
  const houseMatchIds = []; // replacement matches; resolved at settlement
  for (const leg of legs) {
    const isBackSide = leg.back_user === userId;
    const s = leg.stake_cents;
    // The player's collateral on this leg: stake for a back, (P-1)*s for a
    // lay — the same single rounding point the fill used.
    const legFrozen = isBackSide ? s : Math.round((leg.price - 1) * s);
    frozenRelease += legFrozen;

    // The house takes the player's side. A fully-matched order with no
    // remainder carries frozen_cents == 0: the collateral lives in the
    // wallet, per the escrow contract, not on the order row.
    const houseOrder = db
      .prepare(
        `INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents,
                             matched_cents, frozen_cents, status, placed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'fully_matched', datetime('now'))`
      )
      .run(house.id, marketId, leg.selection_id, isBackSide ? 'back' : 'lay', leg.price, s, s);
    const houseOrderId = Number(houseOrder.lastInsertRowid);

    const hm = db
      .prepare(
        `INSERT INTO matches (market_id, selection_id, back_order_id, lay_order_id, price, stake_cents, at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        marketId,
        leg.selection_id,
        // The house takes the PLAYER's slot; the other slot keeps the
        // COUNTERPARTY's order. Both slots swap together.
        //
        // THE LAY SIDE WAS WRONG UNTIL THE SECOND OUTSIDE REVIEW. The back slot
        // used `leg.lay_order_id` in BOTH branches — the player's own order —
        // so a lay-side cash-out paired the house with the player's dead order
        // and DROPPED THE COUNTERPARTY from the live match entirely: their
        // collateral stayed frozen against a match flagged cashout=1, and the
        // market's settlement then failed outright with "releasing more than
        // frozen" — a bricked market with no repair path, on the exact path
        // the comment below warns about. Every existing test cashed out a BACK
        // position, which is why the correct branch masked the broken one.
        // The back slot holds: house (player was back) or the COUNTERPARTY's
        // back order (player was lay).
        isBackSide ? houseOrderId : leg.back_order_id,
        isBackSide ? leg.lay_order_id : houseOrderId,
        leg.price,
        s
      );
    houseMatchIds.push(Number(hm.lastInsertRowid));

    // Escrow moves with the position: house funds -> house escrow. Routed
    // through ledger.escrow rather than written by hand, so the cache columns
    // and the double-entry postings cannot drift. It also means a house that
    // cannot fund the position REFUSES the buyout rather than taking on
    // exposure it does not have — which is the correct failure.
    require('./ledger').escrow(db, house.id, legFrozen, { marketId, orderId: houseOrderId });
  }

  // Release the player's collateral and pay them the quote, both through the
  // ledger so the cache columns and the postings move together.
  settleUser(db, userId, { balanceDelta: payoutCents, frozenRelease, commissionCents: 0, marketId });

  db.prepare('UPDATE matches SET cashout = 1 WHERE market_id = ? AND cashout = 0 AND id IN (' +
    legs.map(() => '?').join(',') + ')').run(marketId, ...legs.map((l) => l.match_id));

  // Record the executed buyout — inside the SAME transaction that paid the
  // player. The first version of the risk module tracked quotes that were
  // never persisted, so every reading was zero and the caps never fired
  // (the outside audit's F2). What the venue carries is executed buyouts, so
  // that is what is written, with the replacement match ids so settlement
  // can later compute the realised loss.
  const { recordBuyout } = require('./cashoutrisk');
  recordBuyout(db, {
    userId,
    marketId,
    fairValueCents: Number.isInteger(fairValueCents) ? fairValueCents : payoutCents,
    paidCents: payoutCents,
    houseMatchIds: houseMatchIds,
  });

  // A settlements row records the event, so the wallet ledger and the
  // per-market settlement history both show what happened and why.
  db.prepare(
    // pnl_cents is the player's NET RESULT of the buyout, which is the payout
    // MINUS the stake they no longer risk. Recording the payout itself claimed
    // a gain of the full payout, which broke the reports' own zero-sum
    // invariant (reports.js) and inflated the commission base. The stake they
    // gave up is already reflected in the escrow they were released from.
    'INSERT INTO settlements (market_id, user_id, credit_cents, commission_cents, pnl_cents) VALUES (?, ?, ?, 0, ?)'
  ).run(marketId, userId, payoutCents, payoutCents - frozenRelease);

  // `transferred_cents` is the SAME figure as `frozen_release_cents`, by
  // construction — see the comment on the accumulator above. Both are returned
  // because both are documented response fields; the client must not read the
  // pair as two independent quantities.
  return { frozen_release_cents: frozenRelease, payout_cents: payoutCents, matches_closed: legs.length, transferred_cents: frozenRelease };
}

module.exports = { settleMarket, voidSelection, settledFor, cashoutPosition };
