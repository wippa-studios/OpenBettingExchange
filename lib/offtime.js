'use strict';
// lib/offtime.js — the OFF-TIME GATE: bets may only be placed PRE-OFF.
//
// WHY THIS MODULE EXISTS. Until now the venue could accept an order at any
// time. `lib/inplay.js` managed in-play risk (suspension, bet delay) but
// nothing tied tradability to `events.starts_at`: with FEED_ENABLED off, no
// caller ever suspended a market at kick-off, so the "in-play gate" at the top
// of validateOrder was a control with no one driving it. That is the dead-
// control shape this codebase keeps finding. The product decision is to remove
// in-play betting entirely, which means the gate that MATTERS is the off time,
// and this is where it lives.
//
// WHY PRE-OFF-ONLY IS THE RIGHT CALL, in one line from lib/inplay.js: an
// in-play price is a forecast of a future event, the book reacts in ~200ms,
// and the venue is systematically slower than its own liquidity — so anyone
// with a low-latency feed trades the delay rather than the football. Removing
// in-play removes that whole class of sharp. Betfair's on-play delay exists for
// the same reason.
//
// WHAT IT GATES. Two things, and the second is the one that is easy to forget:
//
//   1. PLACING an order (back or lay) on any selection of the event.
//   2. CASHING OUT an existing position.
//
// (2) is not optional. A pre-off venue that keeps cash-out open through the
// event has banned in-play BETTING but kept in-play RISK: the venue still owes
// money on a position whose fair price just moved on a goal. That is exactly
// the unmanaged exposure lib/inplay.js exists to contain. Both the order path
// and the cash-out path assert this module.
//
// WHAT THIS DOES NOT DO (deliberately, so it is not mistaken for a full
// in-play solution if in-play is ever revisited):
//   - It does NOT settle positions at off. At off, exposure is frozen: every
//     matched stake stands until the result arrives. It does not auto-void,
//     auto-lay, or otherwise touch open money.
//   - It does NOT withdraw cash-out's existing quotes. A quote issued PRE-OFF
//     stays valid until off (the position was priced pre-off); one issued at or
//     after off is refused because the price it was based on is stale.
//
// THE OFF TIME ITSELF. `events.starts_at`, already present and already
// validated ISO-8601 on admin create (POST /api/admin/events), and exactly the
// field the feed publishes for feed markets. Admin-set events use the same
// column, composed from their "Event Start Date" + "Event Start Time" inputs in
// the admin UI. So there is ONE off-time source of truth for both — no second
// column, and no way for the two to disagree.
//
// TIMEZONE, which is where off-time bugs actually live. `starts_at` is stored as
// text. The gate must compare against the SAME clock the feed and the rest of
// the system use, so this normalises to a UTC instant before comparing. SQLite
// `datetime('now')` is UTC, and the settlement path already keys off
// `datetime('now')`, so UTC is the consistent choice here.

const { httpError } = require('./auth');

/**
 * Parse `events.starts_at` into a UTC epoch milliseconds value.
 *
 * Accepts the same shapes the admin validator accepts — 'YYYY-MM-DD',
 * 'YYYY-MM-DD HH:MM', 'YYYY-MM-DD HH:MM:SS', and the ISO variants with 'T' and
 * an optional 'Z'/offset — because those are exactly what is stored. A bare
 * date or a datetime with no offset is interpreted as UTC, matching how the
 * rest of the system writes timestamps (datetime('now') is UTC).
 *
 * Returns null if the value is absent or unparseable. A null off time does NOT
 * mean "open forever": assertOffNotReached treats an unknown off time as
 * CLOSED (fail-closed), so a malformed catalogue row can never make a market
 * trade indefinitely. That direction is deliberate — a missing off time must
 * not be read as "no off", or a bad row silently re-opens in-play trading.
 */
function offTimeMs(startsAt) {
  if (startsAt === null || startsAt === undefined) return null;
  const s = String(startsAt).trim();
  if (s === '') return null;
  // Date.parse reads a ZONELESS 'YYYY-MM-DDTHH:MM' as LOCAL time. SQLite's
  // datetime('now') — which the settlement path and every timestamp in this
  // system use — is UTC. So an off time written as '2030-01-01T12:00:00' would
  // resolve to a different instant depending on the server's TZ, and a venue
  // in one timezone would open or close betting at the wrong wall-clock moment.
  //
  // Fix: normalise to explicit UTC before parsing, in this order:
  //   1. already has an explicit offset/Z  -> leave it alone (Date.parse is
  //      unambiguous);
  //   2. 'YYYY-MM-DD HH:MM[:SS]'          -> 'T' + 'Z';
  //   3. 'YYYY-MM-DDTHH:MM[:SS]' zoneless -> append 'Z';
  //   4. bare 'YYYY-MM-DD'                -> UTC midnight.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  let normalised;
  if (hasZone) {
    normalised = s;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    normalised = `${s}T00:00:00Z`;
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    normalised = `${s.replace(' ', 'T')}Z`;
  } else {
    // Anything else: hand it to Date.parse unchanged and let it fail, so an
    // unexpected format reads as "no off time" (fail-closed) rather than being
    // silently coerced into some local-time instant.
    normalised = s;
  }
  const ms = Date.parse(normalised);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Has the event's off time passed? Now is injectable for tests; defaults to
 * the real clock.
 *
 * Returns true (OFF / closed to betting) when:
 *   - the off time is in the past, or
 *   - the off time is missing or unparseable (fail-closed).
 *
 * An event that has not started yet returns false (still tradeable).
 */
function isOffReached(db, eventId, nowMs = Date.now()) {
  const row = db
    .prepare('SELECT starts_at FROM events WHERE id = ?')
    .get(eventId);
  // Fail-closed on a missing row too: if the event does not exist we cannot
  // prove it is pre-off, so we refuse. Defence in depth behind the FK.
  if (!row) return true;
  const off = offTimeMs(row.starts_at);
  if (off === null) return true;
  return nowMs >= off;
}

/**
 * Human-readable seconds until off. Returns:
 *   - a positive integer of seconds while the event is still upcoming,
 *   - 0 once off has passed,
 *   - null when the off time is unknown/unparseable (treat as closed).
 *
 * It used to be documented as existing "for the client's countdown and for the
 * bots' quoting policy", and neither of those callers exists — grep for
 * `secondsUntilOff` outside this file and the only hits are its own definition,
 * its export and tests/offtime.test.js. The client countdown is computed in the
 * browser from `event_time`, and lib/bots.js does not consult it.
 *
 * Kept, and kept correct, because the return contract above is the one thing
 * about an off time that is easy to get wrong (never negative, null when
 * unknown) and it is the shape the UI will want the moment it stops computing
 * this itself. It is documented as having no caller rather than deleted, so the
 * next reader is not misled about how the countdown is derived today.
 */
function secondsUntilOff(db, eventId, nowMs = Date.now()) {
  const row = db.prepare('SELECT starts_at FROM events WHERE id = ?').get(eventId);
  if (!row) return null;
  const off = offTimeMs(row.starts_at);
  if (off === null) return null;
  if (nowMs >= off) return 0;
  return Math.ceil((off - nowMs) / 1000);
}

/**
 * THE ASSERTION, BY SELECTION. Throws 409 if the event for `selectionId`'s
 * market is at or past its off time. Kept separate from isOffReached so the two
 * query styles (by event id vs by selection id) do not get crossed at a call
 * site.
 *
 * IT HAS NO CALLER. The comment here used to say "Used by the order path
 * (validateOrder)", and that is false: `validateOrder` calls
 * `assertOffNotReached(db, sel.event_id)` directly (lib/match.js), resolving the
 * event from the selection it already holds rather than re-querying for it. The
 * only other production caller of the by-event form is the cash-out path
 * (lib/cashout.js), also by event id.
 *
 * That matters because the old comment implied there were TWO enforcement points
 * for the pre-off gate and an auditor counting them would find one. The gate is
 * enforced in one place, by event id, from both callers. This function is the
 * by-selection spelling of it, correct and complete, with no production caller —
 * so anything relying on it as an enforcement point is relying on nothing.
 */
function assertOffNotReachedBySelection(db, selectionId, nowMs = Date.now()) {
  const sel = db
    .prepare(
      `SELECT e.id AS event_id
         FROM selections s
         JOIN markets m ON m.id = s.market_id
         JOIN events  e ON e.id = m.event_id
        WHERE s.id = ?`
    )
    .get(selectionId);
  if (!sel) throw httpError(404, 'Selection not found');
  assertOffNotReached(db, sel.event_id, nowMs);
}

/**
 * The assertion, by event id. Throws 409 once off is reached. Used by the
 * cash-out path, which knows the market (and therefore the event) but not
 * necessarily a selection.
 */
function assertOffNotReached(db, eventId, nowMs = Date.now()) {
  if (isOffReached(db, eventId, nowMs)) {
    throw httpError(409, 'Betting is closed: this event is off (in-play betting is not offered)');
  }
}

module.exports = {
  offTimeMs,
  isOffReached,
  secondsUntilOff,
  assertOffNotReached,
  assertOffNotReachedBySelection,
};