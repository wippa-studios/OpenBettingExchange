'use strict';
// lib/cashoutrisk.js — bounding the venue's exposure to cash-out.
//
// THE GAP THIS CLOSES. Phase 2 (lib/risk.js) bounds the MARKET MAKER's
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
// The control is the same shape as the bot cap, deliberately: a liability cap
// and a daily loss cap, checked before a buyout is quoted. It lives in its own
// module because cash-out risk is a DIFFERENT exposure from market-making —
// different counterparty, different timing — and folding it into risk_bots
// would blur two things an operator needs to see separately.
const { transaction } = require('./tx');
const audit = require('./audit');

// Exposure is measured in the CENTS THE VENUE EXPECTS TO PAY, i.e. the sum of
// outstanding cash-out quotes a player could take right now. That is the
// number that matters: a position nobody has cashed out is a market risk, and
// a position cashed out is a liability the venue already owes.
function outstandingExposure(db, userId = null) {
  const row = userId
    ? db.prepare("SELECT COALESCE(SUM(paid_cents),0) s FROM cashout_quotes WHERE status='open' AND user_id=?").get(userId)
    : db.prepare("SELECT COALESCE(SUM(paid_cents),0) s FROM cashout_quotes WHERE status='open'").get();
  return row.s;
}

function realisedLossToday(db) {
  // A cash-out that settled at less than fair value is a realised venue loss.
  // Stored as the shortfall at execution so it cannot be recomputed differently
  // later from a fair price that has since moved.
  const row = db.prepare(
    "SELECT COALESCE(SUM(fair_value_cents - paid_cents), 0) s FROM cashout_quotes WHERE status='taken' AND date(taken_at) = date('now')"
  ).get();
  return row.s;
}

/**
 * May this user be quoted right now?
 *
 * Returns null when permitted, or a reason code. Checked inside the quoting
 * transaction so two concurrent quotes cannot both read a pre-quote exposure
 * and both pass — the same check-then-act rule the placement limits follow.
 */
function refusal(db, userId, { venueMaxOutstandingCents, venueMaxDailyLossCents }) {
  const outstanding = outstandingExposure(db);
  if (venueMaxOutstandingCents > 0 && outstanding >= venueMaxOutstandingCents) {
    return { code: 'venue_exposure_cap', outstanding_cents: outstanding, cap_cents: venueMaxOutstandingCents };
  }
  const realised = realisedLossToday(db);
  if (venueMaxDailyLossCents > 0 && realised >= venueMaxDailyLossCents) {
    return { code: 'venue_daily_loss_cap', realised_cents: realised, cap_cents: venueMaxDailyLossCents };
  }
  // A per-user cap as well: one player cycling positions must not be able to
  // consume the whole venue budget in a session.
  const perUser = db.prepare(
    "SELECT COALESCE(SUM(paid_cents),0) s FROM cashout_quotes WHERE status='open' AND user_id=?"
  ).get(userId).s;
  const userCap = Math.floor(venueMaxOutstandingCents / 4) || 0;
  if (venueMaxOutstandingCents > 0 && userCap > 0 && perUser >= userCap) {
    return { code: 'user_exposure_cap', outstanding_cents: perUser, cap_cents: userCap };
  }
  return null;
}

/**
 * Record a quote. The venue's exposure begins at the QUOTE, not at execution:
 * if a player holds an unexercised quote and the venue has committed to it,
 * the liability exists whether or not it is taken. An expired quote releases
 * it, which is why expiry is mandatory rather than optional.
 */
function recordQuote(db, { userId, marketId, fairValueCents, quotedCents, source = 'quote' }) {
  return transaction(db, () => {
    const info = db
      .prepare(
        `INSERT INTO cashout_quotes (user_id, market_id, fair_value_cents, paid_cents, status, expires_at)
         VALUES (?, ?, ?, ?, 'open', datetime('now', ?))`
      )
      .run(userId, marketId, fairValueCents, quotedCents, '15 minutes');
    return Number(info.lastInsertRowid);
  });
}

/** Mark a quote exercised, recording what the venue actually paid. */
function takeQuote(db, quoteId) {
  db.prepare("UPDATE cashout_quotes SET status='taken', taken_at=datetime('now') WHERE id=?").run(quoteId);
}

function expireStaleQuotes(db) {
  const n = db.prepare(
    "UPDATE cashout_quotes SET status='expired' WHERE status='open' AND expires_at <= datetime('now')"
  ).run();
  return n.changes;
}

/** Desk view: exposure, realised loss today, and the headroom against each cap. */
function desk(db, cfg) {
  const outstanding = outstandingExposure(db);
  const realised = realisedLossToday(db);
  const openQuotes = db.prepare("SELECT COUNT(*) c FROM cashout_quotes WHERE status='open'").get().c;
  const takenToday = db
    .prepare("SELECT COUNT(*) c FROM cashout_quotes WHERE status='taken' AND date(taken_at)=date('now')")
    .get().c;
  return {
    outstanding_cents: outstanding,
    realised_loss_today_cents: realised,
    open_quotes: openQuotes,
    taken_today: takenToday,
    max_outstanding_cents: cfg.venueMaxOutstandingCents,
    max_daily_loss_cents: cfg.venueMaxDailyLossCents,
    outstanding_headroom_cents: Math.max(0, cfg.venueMaxOutstandingCents - outstanding),
    daily_loss_headroom_cents: Math.max(0, cfg.venueMaxDailyLossCents - realised),
    quoting_allowed: outstanding < cfg.venueMaxOutstandingCents && realised < cfg.venueMaxDailyLossCents,
  };
}

module.exports = {
  outstandingExposure,
  realisedLossToday,
  refusal,
  recordQuote,
  takeQuote,
  expireStaleQuotes,
  desk,
};