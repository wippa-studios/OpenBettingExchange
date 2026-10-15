'use strict';
// lib/inplay.js — in-play markets: suspension, bet delay, traded volume.
//
// WHY THIS IS NOT A SMALL FEATURE. A pre-match exchange is safe from the
// sharpest money in betting. In-play it is not, and the reason is structural:
//
//   An in-play price is a FORECAST of a future event, and the venue's book is
//   people reacting to what they can see RIGHT NOW — a goal, a red card, a
//   runner breaking. If the venue publishes prices instantly and the book
//   reacts in 200ms, the venue is systematically slower than its own
//   liquidity, and anyone with a low-latency feed trades the delay rather than
//   the football.
//
//   Every real venue therefore DELAYS in-play prices. Betfair's delay is the
//   industry reference and it exists for this reason alone. Pretending
//   otherwise is not a missing feature; it is a venue that loses money to
//   sharps on every goal.
//
// WHAT THIS MODELS, in order of how much it matters:
//
//   1. MARKET SUSPENSION at kick-off. The single highest-value control: for
//      a configurable window the market refuses orders outright. Nothing
//      sharp can be done against a market that is not accepting bets.
//   2. BET DELAY. Orders placed during the window are accepted but queued and
//      become eligible for matching only once it expires — so a price moved by
//      a goal does not instantly meet a resting order placed before it.
//   3. TRADED VOLUME. What actually traded, in money, not order count. The
//      signal a trader needs and the one a demo board has never had.
//
// The delay is applied to ELIGIBILITY, not to the order timestamp: the order
// records when it was PLACED (for the audit trail and the tape) and when it
// became MATCHABLE. Those are different times and conflating them makes the
// tape lie about what the venue could have known.
const { httpError } = require('./auth');
const { now } = require('./util');

// Why an order cannot match yet. A closed vocabulary so the client can render
// the right advice — "this market is closed" and "your order is waiting for
// the delay" need different words.
const SUSPENDED = 'suspended';
const DELAYED = 'delayed';
const ELIGIBLE = 'eligible';

/**
 * Is this market accepting orders right now?
 *
 * Suspension is stored on the market rather than derived from a clock, so an
 * operator can pull a market for any reason — a feed outage, a disputed goal,
 * a manual hold — and the reason is recorded rather than guessed at.
 */
function marketGate(db, marketId) {
  const m = db.prepare('SELECT status, inplay, inplay_delay_ms, suspend_until FROM markets WHERE id = ?').get(marketId);
  if (!m) throw httpError(404, 'Market not found');
  if (m.status !== 'open') return { allowed: false, reason: SUSPENDED, detail: 'Market is not open' };

  if (m.suspend_until) {
    const nowTs = db.prepare("SELECT datetime('now') AS n").get().n;
    if (m.suspend_until > nowTs) {
      return { allowed: false, reason: SUSPENDED, detail: 'Market is suspended', until: m.suspend_until };
    }
  }
  if (!m.inplay) return { allowed: true, reason: ELIGIBLE };
  return { allowed: true, reason: ELIGIBLE, inplay: true };
}

/**
 * The engine's gate. A SUSPENDED market accepts nothing, and the refusal says
 * WHY — a player who is told "suspended" understands and a player told "not
 * open" thinks they have been blocked for no reason.
 *
 * Refusal is a 409, not a 400: the request is well-formed and the market will
 * accept it later, which is exactly what Conflict means.
 */
function assertNotSuspended(db, marketId) {
  const g = marketGate(db, marketId);
  if (!g.allowed) {
    throw httpError(409, g.detail || 'Market is suspended', {
      code: g.reason,
      until: g.until || null,
    });
  }
}

/**
 * The configured bet delay for a market, in milliseconds. 0 when the market
 * is not in-play, or is in-play with no delay.
 *
 * A tiny helper because the ENGINE needs the number on every placement and
 * `eligibility()` returns a whole advisory object. Keeping the rule in one
 * place matters here more than usual: the client-facing report and the
 * engine's enforcement must read the SAME source, or the venue tells a player
 * an order is protected and then matches it anyway — which is exactly what
 * happened before the delay was enforced at all.
 */
function delayMsFor(db, marketId) {
  const row = db.prepare('SELECT inplay, inplay_delay_ms FROM markets WHERE id = ?').get(marketId);
  if (!row || !row.inplay) return 0;
  const ms = Number(row.inplay_delay_ms);
  return Number.isInteger(ms) && ms > 0 ? ms : 0;
}

/**
 * When may an order placed now be MATCHED?
 *
 * Returns `eligible_at` — the moment matching may begin. For a pre-match
 * market that is immediately. For an in-play market it is `now + delay`.
 *
 * Deliberately returns a time rather than a boolean: the client needs to tell
 * the player WHEN, and "delayed" without a duration is indistinguishable from
 * "broken".
 */
function eligibility(db, marketId) {
  const gate = marketGate(db, marketId);
  if (!gate.allowed) return { ...gate, eligible_at: null };
  const m = db.prepare('SELECT inplay, inplay_delay_ms FROM markets WHERE id=?').get(marketId);
  if (!m.inplay) return { ...gate, eligible_at: now() };
  const delay = Number.isInteger(m.inplay_delay_ms) ? m.inplay_delay_ms : 0;
  if (delay <= 0) return { ...gate, eligible_at: now() };
  const row = db.prepare("SELECT datetime('now', ?) AS t").get(`+${delay} second`);
  return { ...gate, eligible_at: row.t, delay_ms: delay, reason: DELAYED };
}

/**
 * Suspend or resume a market.
 *
 * `until` may be null for an open-ended suspension — which is what an
 * operator wants during a feed outage, where guessing a resume time is worse
 * than requiring a human to restore it.
 */
function setSuspended(db, { marketId, suspended, until = null, reason = null }) {
  const m = db.prepare('SELECT id, status FROM markets WHERE id = ?').get(marketId);
  if (!m) throw httpError(404, 'Market not found');
  if (m.status !== 'open') throw httpError(409, 'Only an open market can be suspended');
  if (suspended && until !== null && Number.isNaN(Date.parse(until))) {
    throw httpError(400, 'until must be null or an ISO datetime');
  }
  const stamp = until ? new Date(until).toISOString().replace('T', ' ').slice(0, 19) : null;
  db.prepare('UPDATE markets SET suspend_until = ?, suspend_reason = ? WHERE id = ?')
    .run(suspended ? stamp || '9999-12-31 23:59:59' : null, suspended ? reason : null, marketId);
  return { market_id: marketId, suspended: !!suspended, until: suspended ? stamp || null : null, reason };
}

/**
 * Mark a market in-play, optionally with a delay.
 *
 * Suspending AT the moment of going live is the point: the venue stops
 * accepting bets at exactly the instant the event becomes unpredictable, then
 * resumes into a delay. Without that instant of closure there is a window
 * where the book reacts faster than the venue and the sharp wins it.
 */
function setInplay(db, { marketId, inplay, delayMs }) {
  const m = db.prepare('SELECT id, status FROM markets WHERE id = ?').get(marketId);
  if (!m) throw httpError(404, 'Market not found');
  if (m.status !== 'open') throw httpError(409, 'Only an open market can go in-play');
  const delay = delayMs === undefined || delayMs === null ? null : Number(delayMs);
  if (delay !== null && (!Number.isInteger(delay) || delay < 0 || delay > 600000)) {
    throw httpError(400, 'delayMs must be an integer between 0 and 600000 (10 minutes)');
  }
  if (inplay) {
    // Suspend on going live: the venue must not be accepting bets at the
    // moment the event turns unpredictable.
    db.prepare("UPDATE markets SET inplay = 1, inplay_delay_ms = ?, suspend_until = '9999-12-31 23:59:59', suspend_reason = ? WHERE id = ?")
      .run(delay === null ? 0 : delay, 'Event started', marketId);
  } else {
    db.prepare("UPDATE markets SET inplay = 0, inplay_delay_ms = 0, suspend_until = NULL, suspend_reason = NULL WHERE id = ?")
      .run(marketId);
  }
  return { market_id: marketId, inplay: !!inplay, delay_ms: delay === null ? 0 : delay };
}

/**
 * Release the suspension an in-play market starts with.
 *
 * Separate from setSuspended because this is the DESK clearing the
// kick-off suspension, not an operator pulling a market — and it is the only
 * way an in-play market starts taking bets.
 */
function releaseKickoffSuspension(db, marketId) {
  const m = db.prepare('SELECT id, inplay, inplay_delay_ms FROM markets WHERE id = ?').get(marketId);
  if (!m) throw httpError(404, 'Market not found');
  if (!m.inplay) return { market_id: marketId, released: false, reason: 'not in-play' };
  db.prepare("UPDATE markets SET suspend_until = NULL, suspend_reason = NULL WHERE id = ?").run(marketId);
  return { market_id: marketId, released: true, delay_ms: m.inplay_delay_ms };
}

/**
 * Traded volume for a market: what actually matched, in money.
 *
 * Distinct from `markets.total_matched_cents`, which is a lifetime counter
 * the board already shows. This is a WINDOW, because "how much traded in the
 * last 10 minutes" is the liquidity signal a trader needs, and a lifetime
 * total answers a question nobody asks.
 */
function tradedVolume(db, marketId, windowMinutes = 10) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS fills,
              COALESCE(SUM(stake_cents), 0) AS staked,
              COALESCE(SUM(CAST(ROUND(stake_cents * price) AS INTEGER)), 0) AS turned_over
         FROM matches
        WHERE market_id = ?
          AND at >= datetime('now', ?)`
    )
    .get(marketId, `-${Math.max(1, Number(windowMinutes) || 10)} minutes`);
  // Turned over is money through the market (stake x price); staked is the
  // backer stake. An operator watching venue revenue cares about the former.
  return {
    window_minutes: Number(windowMinutes) || 10,
    fills: row.fills,
    staked_cents: row.staked,
    turned_over_cents: row.turned_over,
  };
}

/** Per-selection traded volume, for a market-mover view. */
function volumeBySelection(db, marketId, windowMinutes = 10) {
  return db
    .prepare(
      `SELECT mt.selection_id, s.name,
              COUNT(*) AS fills,
              COALESCE(SUM(mt.stake_cents), 0) AS staked
         FROM matches mt
         JOIN selections s ON s.id = mt.selection_id
        WHERE mt.market_id = ?
          AND mt.at >= datetime('now', ?)
        GROUP BY mt.selection_id
        ORDER BY staked DESC`
    )
    .all(marketId, `-${Math.max(1, Number(windowMinutes) || 10)} minutes`);
}

module.exports = {
  SUSPENDED, DELAYED, ELIGIBLE,
  marketGate, assertNotSuspended, delayMsFor, eligibility, setSuspended, setInplay,
  releaseKickoffSuspension, tradedVolume, volumeBySelection,
};