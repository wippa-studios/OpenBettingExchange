'use strict';
// lib/cashoutrisk.js — bounding the venue's exposure to cash-out.
//
// THE ATTACK THIS CLOSES. Phase 2 (lib/risk.js) bounds the MARKET MAKER's
// liability, because a bot quoting a no-edge price is an unbounded loss. That
// reasoning did not travel to cash-out, and cash-out is a far easier way to
// lose: the player picks WHEN to take the offer, so they will always take it
// precisely when the venue is worst exposed.
//
// A player can otherwise repeat: build a position the feed then revalues
// against them, cash out a guaranteed payout, rebuild, repeat. Each cycle
// converts the venue's exposure into a certain loss, which is strictly better
// for the player than holding — and holding is what the risk model assumes.
//
// ── WHAT IS ACTUALLY MEASURED (and why it changed) ──────────────────────────
// The first version of this module tracked QUOTES: exposure began when a
// quote was issued and expired if unexercised. The outside audit's F2 finding
// was that no production path ever recorded one — a quote and its execution
// are ATOMIC in the same request here, so there is no live "open quote" to
// track, and every reading was zero forever. A control that exists only in
// its comments is worse than a documented gap: it makes the roadmap claim a
// defence the venue does not have.
//
// So the module now measures what the venue actually carries:
//
//   OUTSTANDING EXPOSURE  the fair value of buyouts it has executed whose
//                         markets are still unresolved. Money the venue has
//                         committed to positions it now owns.
//   DAILY OUTLAY          the total it has PAID players for buyouts today.
//                         Forward-looking and known at decision time, so it
//                         is the quantity the daily cap gates on: it bounds
//                         what a bad day can cost through cash-out, whatever
//                         the positions later return.
//   REALISED LOSS         settled today: paid_cents minus whatever the taken-
//                         over positions actually returned at settlement.
//                         Backward-looking; reported to the desk rather than
//                         gated on, because it has already happened.
//
// Every buyout row is written at EXECUTION, inside the same transaction that
// pays the player, so the readings cannot lag reality.
const { transaction } = require('./tx');

// ── Readings ───────────────────────────────────────────────────────────────

/** Fair value of executed buyouts in still-unresolved markets. */
function outstandingExposure(db, userId = null) {
  const sql = `
    SELECT COALESCE(SUM(q.fair_value_cents), 0) s
      FROM cashout_quotes q
      JOIN markets m ON m.id = q.market_id
     WHERE q.status = 'taken'
       AND q.settled_at IS NULL
       AND m.status = 'open'`;
  const row = userId
    ? db.prepare(sql + ' AND q.user_id = ?').get(userId)
    : db.prepare(sql).get();
  return row.s;
}

/** Total paid to players for buyouts executed today (the daily cap's input). */
function outlayToday(db, userId = null) {
  const sql = `
    SELECT COALESCE(SUM(paid_cents), 0) s
      FROM cashout_quotes
     WHERE status = 'taken'
       AND date(taken_at) = date('now')`;
  const row = userId ? db.prepare(sql + ' AND user_id = ?').get(userId) : db.prepare(sql).get();
  return row.s;
}

/**
 * Realised venue loss on buyouts settled today: what was paid minus what the
 * taken-over positions returned. Only meaningful once settleBuyouts has run,
 * which settlement calls for every market it resolves.
 */
function realisedLossToday(db) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(loss_cents), 0) s
         FROM cashout_quotes
        WHERE settled_at IS NOT NULL
          AND date(settled_at) = date('now')
          AND loss_cents > 0`
    )
    .get().s;
}

// ── Recording ──────────────────────────────────────────────────────────────

/**
 * Record an executed buyout. Called from cashoutPosition INSIDE the same
 * transaction that pays the player, so the risk readings can never lag the
 * money. house_match_ids are the replacement matches the venue wrote — at
 * settlement they resolve, and the realised loss becomes computable.
 */
function recordBuyout(db, { userId, marketId, fairValueCents, paidCents, houseMatchIds }) {
  const info = db
    .prepare(
      `INSERT INTO cashout_quotes
         (user_id, market_id, fair_value_cents, paid_cents, status, expires_at, taken_at, house_match_ids)
       VALUES (?, ?, ?, ?, 'taken', datetime('now'), datetime('now'), ?)`
    )
    .run(userId, marketId, fairValueCents, paidCents, JSON.stringify(houseMatchIds));
  return Number(info.lastInsertRowid);
}

/**
 * Resolve every executed buyout in a market, as settlement resolves the market.
 * Called from settleTx inside the settlement transaction.
 *
 * The venue's loss on one buyout is NOT paid − fair (a margin figure, and
 * always positive by construction) and it is NOT paid − 0 (which forgets that
 * the venue also took the position over): it is paid_cents − pnl(house legs),
 * because the venue paid the player AND owned the position afterwards. A
 * buyout that pays $50 for a position that then loses $100 at settlement
 * cost the venue $150, and no pre-settlement figure can show that.
 *
 * A VOID market resolves every leg at pnl 0 — stake returned, nothing won —
 * so the venue's loss is the whole payout: it paid for a position that was
 * then cancelled. That is the honest number.
 */
function settleBuyouts(db, marketId, winner, voidMarket) {
  const rows = db
    .prepare("SELECT * FROM cashout_quotes WHERE market_id = ? AND status = 'taken' AND settled_at IS NULL")
    .all(marketId);
  // Resolve the house account LAZILY: ensureBot CREATES it (with its seed
  // balance) when absent, and calling it on every settlement made the house
  // row a side effect of settling anything at all — silently changing global
  // balance sums. No buyouts, no need for the house to exist here.
  if (rows.length === 0) return 0;
  const { ensureBot } = require('./bots');
  const houseId = ensureBot(db).id;
  const winnerSet = new Set(
    Array.isArray(winner) ? winner.map(Number) : (winner === null || winner === undefined ? [] : [Number(winner)])
  );
  let settled = 0;
  for (const q of rows) {
    let ids = [];
    try { ids = JSON.parse(q.house_match_ids || '[]'); } catch { ids = []; }
    let pnl = 0;
    for (const mid of ids) {
      const m = db
        .prepare(
          `SELECT mt.selection_id, mt.price, mt.stake_cents,
                  bo.user_id AS back_user, lo.user_id AS lay_user
             FROM matches mt
             JOIN orders bo ON bo.id = mt.back_order_id
             JOIN orders lo ON lo.id = mt.lay_order_id
            WHERE mt.id = ?`
        )
        .get(mid);
      if (!m) continue;
      const houseIsBack = m.back_user === houseId;
      const houseIsLay = m.lay_user === houseId;
      if (!houseIsBack && !houseIsLay) continue; // not a takeover leg
      if (voidMarket) continue; // stake returned: pnl contribution 0
      // The winner may be a SET (a dead heat), in which case the venue's
      // takeover leg is one of the joint winners and is paid a SHARE of the
      // liability — the same floor(liability / n) the settlement applies, so
      // the desk's realised-loss reading agrees with what was paid out. This
      // is a reporting figure, not a posting.
      const won = winnerSet.has(m.selection_id);
      const shareCount = Math.max(1, winnerSet.size);
      const share = Math.floor(Math.round((m.price - 1) * m.stake_cents) / shareCount);
      if (houseIsBack) pnl += won ? share : -m.stake_cents;
      else pnl += won ? -share : m.stake_cents;
    }
    // loss = what the venue paid minus what the position returned. Negative
    // loss means the buyout PROFITED the venue (paid below what the position
    // returned) — a real outcome, not an error.
    const loss = q.paid_cents - pnl;
    db.prepare(
      `UPDATE cashout_quotes SET proceeds_cents = ?, loss_cents = ?, settled_at = datetime('now') WHERE id = ?`
    ).run(pnl, loss, q.id);
    settled++;
  }
  return settled;
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * May this user be quoted right now?
 *
 * Returns null when permitted, or a reason code. Checked inside the quoting
 * transaction so two concurrent quotes cannot both read a pre-quote exposure
 * and both pass — the same check-then-act rule the placement limits follow.
 *
 * The DAILY cap gates on outlay (what has been paid today), not on realised
 * loss: realised loss is backward-looking — by the time it is measurable the
 * money is gone — whereas outlay is known at decision time and genuinely
 * bounds the worst case. Both are reported to the desk.
 */
function refusal(db, userId, { venueMaxOutstandingCents, venueMaxDailyLossCents }) {
  // 0 means unlimited rather than never-quote: reading a zero cap as a hard
  // stop would take the venue offline by misconfiguration.
  const outstanding = outstandingExposure(db);
  if (venueMaxOutstandingCents > 0 && outstanding >= venueMaxOutstandingCents) {
    return { code: 'venue_exposure_cap', outstanding_cents: outstanding, cap_cents: venueMaxOutstandingCents };
  }
  const outlay = outlayToday(db);
  if (venueMaxDailyLossCents > 0 && outlay >= venueMaxDailyLossCents) {
    return { code: 'venue_daily_outlay_cap', outlay_cents: outlay, cap_cents: venueMaxDailyLossCents };
  }
  // A per-user cap as well: one player cycling positions must not be able to
  // consume the whole venue budget in a session.
  const userOutstanding = outstandingExposure(db, userId);
  const userCap = Math.floor(venueMaxOutstandingCents / 4) || 0;
  if (venueMaxOutstandingCents > 0 && userCap > 0 && userOutstanding >= userCap) {
    return { code: 'user_exposure_cap', outstanding_cents: userOutstanding, cap_cents: userCap };
  }
  return null;
}

/** Desk view: the real readings, headroom against each cap, and the gate. */
function desk(db, cfg) {
  const outstanding = outstandingExposure(db);
  const outlay = outlayToday(db);
  const realised = realisedLossToday(db);
  const openBuyouts = db
    .prepare("SELECT COUNT(*) c FROM cashout_quotes WHERE status = 'taken' AND settled_at IS NULL")
    .get().c;
  const takenToday = db
    .prepare("SELECT COUNT(*) c FROM cashout_quotes WHERE status = 'taken' AND date(taken_at) = date('now')")
    .get().c;
  const quotingAllowed =
    (cfg.venueMaxOutstandingCents === 0 || outstanding < cfg.venueMaxOutstandingCents) &&
    (cfg.venueMaxDailyLossCents === 0 || outlay < cfg.venueMaxDailyLossCents);
  return {
    outstanding_cents: outstanding,
    outlay_today_cents: outlay,
    realised_loss_today_cents: realised,
    open_buyouts: openBuyouts,
    taken_today: takenToday,
    max_outstanding_cents: cfg.venueMaxOutstandingCents,
    max_daily_outlay_cents: cfg.venueMaxDailyLossCents,
    outstanding_headroom_cents: cfg.venueMaxOutstandingCents > 0 ? Math.max(0, cfg.venueMaxOutstandingCents - outstanding) : null,
    daily_outlay_headroom_cents: cfg.venueMaxDailyLossCents > 0 ? Math.max(0, cfg.venueMaxDailyLossCents - outlay) : null,
    quoting_allowed: quotingAllowed,
  };
}

module.exports = {
  outstandingExposure,
  outlayToday,
  realisedLossToday,
  recordBuyout,
  settleBuyouts,
  refusal,
  desk,
};