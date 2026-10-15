'use strict';
// lib/bookversion.js — the book version handshake (#92).
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// The venue already corrects an off-ladder price silently: `validateOrder`
// snaps whatever it is given with `snapToTick`, and `GET /api/format/:price`
// documents that. That is deliberate and #37 fixed the validation branch — it is
// NOT the gap this module closes, and the two must not be confused.
//
// The gap is that placement had no version handshake. A client that read a
// ladder, saw `2.00` available for `5000` cents and sent that order had it
// placed at whatever the ladder said by the time the request arrived. The
// response was `201`, with `fills` showing the outcome, and the client could
// not distinguish:
//
//   - my order was accepted and did not match       — the market moved, normal
//   - my order was accepted at a price I did not intend — the ladder moved
//
// Without a version the venue is silently making a pricing decision on the
// client's behalf and the client has no way to audit it. So:
//
//   * every selection carries a MONOTONE counter, bumped on every state change
//     that alters the book a client reads;
//   * every market carries the aggregate of its selections;
//   * `POST /api/orders` accepts an OPTIONAL version, compares it INSIDE the
//     placement transaction, and refuses on a material mismatch with
//     `market_version_stale`.
//
// ── WHAT COUNTS AS A MATERIAL CHANGE ────────────────────────────────────────
//
// Bumped: a fill on the selection (lib/match.js recordTrades), a cancel on it
// (cancelOrderTx — the single funnel every cancellation in the codebase goes
// through, including bots, cash-out, self-exclusion and the admin desk), and a
// market suspension or resumption, which bumps the MARKET counter only.
//
// Deliberately NOT bumped, each with its reason, because a counter that bumps
// for things a client cannot see is a counter that fails clients for nothing:
//
//   * an order that RESTS. The honest reason is NOT that nothing changed —
//     adding size to a level does change the book. It is that the client that
//     caused it is the client making the claim: this control reports what
//     SOMEONE ELSE did to the book, and a counter the client's own click moves
//     is a counter that refuses the client's second order for something it
//     already knows. THE LIMITATION THAT FOLLOWS, stated rather than hidden:
//     another player merely ADDING size at a price is not counted, so a client
//     is not told that a level grew — only that it was traded or cancelled.
//   * the cash-out house leg. lib/settle.js inserts it with
//     `status = 'fully_matched'`, and `bookFor` filters on `status = 'open'`,
//     so it is invisible to every reader of the book. The player's resting
//     orders that the same transaction cancels DO bump, through cancelOrderTx.
//   * settlement and void. They set `markets.status = 'settled'` (and
//     `selections.status = 'void'`), after which `validateOrder` refuses every
//     placement with a 409 — a client is told directly and cannot be racing
//     anything.
//   * `price_history` / LTP writes. They follow a fill, which already bumped.
//
// ── WHY THE THRESHOLD IS A CONFIG VALUE, AND WHY IT IS NOT ZERO ────────────
//
// `config.MARKET_VERSION_MATERIAL_THRESHOLD` is how many book-altering events on
// that scope are TOLERATED before the venue refuses. Zero — refuse on any
// movement at all — was the first design and it is wrong for a measurable
// reason, recorded in docs/EXCHANGE_RULES.md because the number is a judgement
// call and the judgement is the deliverable: this venue's own market maker
// cancels and requotes every `DRIFT_INTERVAL_MS`, so a book advances under a
// client's feet whether or not anybody is trading. A zero tolerance would fail
// ordinary ladder clicks, which is the failure the issue warns about. A large
// tolerance is the other failure: the control becomes decorative.
//
// ── WHY IT RUNS INSIDE THE TRANSACTION, AND WHY THAT IS EASY HERE ──────────
//
// The read and the comparison must share a transaction with the order insert,
// for the same reason lib/limits.js enforces its caps there: a check-then-act
// outside one lets two concurrent placements both read the pre-bump version and
// both pass.
//
// On this engine that is nearly free, and the reason is worth stating plainly
// because it is a property a rewrite would give up silently:
//
//   `transaction()` opens with BEGIN IMMEDIATE, so it takes the write lock at
//   the START of the transaction rather than on first write. Two placements
//   therefore serialise at their boundary — the second WAITS (busy_timeout),
//   then runs on a fresh snapshot and reads the version the first one wrote.
//   There is no window between "read the version" and "write the order" for
//   another writer to slip into.
//
// THIS IS A CONTROL THE SYNCHRONOUS ENGINE MAKES EASY AND A POSTGRES REWRITE
// MAKES SUBTLE. Under READ COMMITTED against Postgres, `SELECT book_version` and
// `INSERT INTO orders` are two statements and another session can commit a bump
// between them; under REPEATABLE READ the loser would instead fail at COMMIT
// with a serialization error, which is a different failure a client has to be
// taught about. The same function, the same intent, and neither is obviously
// right until someone checks. Do not "simplify" this into a read outside the
// transaction on the grounds that it looked redundant.
const { httpError } = require('./auth');
const config = require('./config');

// The machine-readable code. Distinct from every other refusal on the route so
// a client can branch on it: this one means "re-read the book and decide
// again", which is advice, not an error to retry blindly.
const STALE = 'market_version_stale';

// Prepared-statement cache keyed per connection, exactly as lib/match.js does —
// the tests open one :memory: database per suite, so a module-global statement
// would leak across databases.
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

/**
 * Validate a client-supplied version field.
 *
 * ABSENT is not zero. `undefined` and `null` both mean "this client is not
 * doing the handshake", which is every existing caller and must keep working
 * byte-for-byte. Anything else must be a non-negative INTEGER, because the
 * comparison is a subtraction and a string would make `drift` a NaN — which
 * compares false against every threshold and would silently DISABLE the control
 * for a client that sent `"5"` instead of `5`.
 */
function readClaim(raw, field) {
  if (raw === undefined || raw === null) return null;
  if (!Number.isInteger(raw) || raw < 0) {
    throw httpError(400, `${field} must be a non-negative integer number of versions, or absent`);
  }
  return raw;
}

/** The selection's current book version. 0 for a selection with no column yet. */
function selectionVersion(db, selectionId) {
  const row = stmtsFor(db, 'sel-version', 'SELECT book_version FROM selections WHERE id = ?').get(selectionId);
  return row ? Number(row.book_version) : 0;
}

/** The market's current book version — the aggregate over its selections. */
function marketVersion(db, marketId) {
  const row = stmtsFor(db, 'mkt-version', 'SELECT book_version FROM markets WHERE id = ?').get(marketId);
  return row ? Number(row.book_version) : 0;
}

/**
 * A book-altering event on ONE selection: a fill, or a cancel.
 *
 * Bumps the selection AND the market, because the market version is the vector
 * over its selections — a client that read the whole market is stale if any
 * runner in it moved. Both writes are monotone increments on stored state, so
 * two of these in the same transaction compose (`+2`) rather than overwriting.
 */
function bumpBookVersion(db, { marketId, selectionId }) {
  db.prepare('UPDATE selections SET book_version = book_version + 1 WHERE id = ?').run(selectionId);
  db.prepare('UPDATE markets SET book_version = book_version + 1 WHERE id = ?').run(marketId);
}

/**
 * A MARKET-level change that alters whether orders can be accepted at all: a
 * suspension, a resumption, or going in-play.
 *
 * The market counter only, deliberately. A suspension is a fact about the
 * market, and `validateOrder` refuses every placement on a suspended market
 * with its own `409 { code: 'suspended' }` BEFORE this check is reached — so a
 * client placing into a suspension is told the actual reason rather than a
 * version drift, which is a worse message for the same fact.
 */
function bumpMarketVersion(db, marketId) {
  db.prepare('UPDATE markets SET book_version = book_version + 1 WHERE id = ?').run(marketId);
}

/**
 * THE CHECK. Compare the client's claims against the current counters and
 * refuse on a material mismatch.
 *
 * MUST be called inside the placement transaction (lib/match.js placeOrderTx),
 * immediately after `validateOrder` has resolved the selection and BEFORE any
 * escrow, order row or ledger posting exists. Two consequences of that position
 * that are load-bearing rather than tidy:
 *
 *   - a refusal writes NOTHING. There is no order to unwind, no collateral to
 *     release and no ledger row to reverse, because none was written.
 *   - an IDEMPOTENT REPLAY never reaches here. placeOrderTx returns the prior
 *     order for a known `client_order_id` before it validates anything, which is
 *     correct: the retry of a request that DID place is the one case where the
 *     client's claim is guaranteed stale, and refusing it would turn a retried
 *     request into a lost order.
 */
function assertVersionsFresh(db, { marketId, selectionId, selection_version, market_version }) {
  const selClaim = readClaim(selection_version, 'selection_version');
  const mktClaim = readClaim(market_version, 'market_version');
  // Omitting BOTH preserves today's behaviour exactly. This early return is the
  // whole compatibility contract: no claim, no check, no refusal, and the
  // placement continues byte-for-byte as it did before this module existed.
  if (selClaim === null && mktClaim === null) return;

  const threshold = config.MARKET_VERSION_MATERIAL_THRESHOLD;
  // Selection first, then market. The order is the client's answer to "which
  // one do I re-read?", and the selection is the narrower, more actionable of
  // the two — a runner's ladder, not a whole market.
  if (selClaim !== null) {
    const current = selectionVersion(db, selectionId);
    // `drift < 0` — a claim NEWER than the venue's own counter — is refused on
    // the same branch, and deliberately so. The counter is monotone, so a
    // client cannot legitimately hold a version this venue has never reached;
    // accepting one would mean the venue trusted a number it cannot explain.
    const drift = current - selClaim;
    if (drift < 0 || drift > threshold) {
      throw stale({ scope: 'selection', supplied: selClaim, current, drift, threshold });
    }
  }
  if (mktClaim !== null) {
    const current = marketVersion(db, marketId);
    const drift = current - mktClaim;
    if (drift < 0 || drift > threshold) {
      throw stale({ scope: 'market', supplied: mktClaim, current, drift, threshold });
    }
  }
}

// ONE place shapes the refusal, so the two scopes cannot drift in status, code
// or payload. 409 and not 429: the request is well-formed and the market will
// accept it once the client has re-read, which is exactly what Conflict means —
// and the same reasoning lib/inplay.js records for `assertNotSuspended`. 429
// would tell a client to retry the same request, which would fail identically.
//
// The payload carries what a client needs to recover WITHOUT a second request:
// what it claimed, what is true now, by how much, and the threshold that
// decided. That is the `market_liability_exceeded` shape (cap + current) and
// for the same reason — a player will appeal a refusal, and "why" has to be
// answerable from the response.
function stale({ scope, supplied, current, drift, threshold }) {
  return httpError(
    409,
    `The book has moved since you read it (${scope} version ${supplied}, now ${current}). Re-read the book and decide again.`,
    {
      code: STALE,
      scope,
      supplied_version: supplied,
      current_version: current,
      drift,
      threshold,
    }
  );
}

module.exports = {
  STALE,
  readClaim,
  selectionVersion,
  marketVersion,
  bumpBookVersion,
  bumpMarketVersion,
  assertVersionsFresh,
};