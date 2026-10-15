'use strict';
// lib/limits.js — abuse controls.
//
// READ THE ROADMAP §2 FIRST, because the category of control here is
// routinely misunderstood and getting it wrong produces either a useless
// feature or a solvency bug:
//
//   These limits are NOT a solvency control. A player cannot win more than
//   their escrow covers — a back freezes `s`, a lay freezes `(P-1)*s`, the pot
//   is `s*P`, and both sides release into the winner. Every match is
//   collateralised on both sides, so there is no correlation exposure and no
//   default risk on a matched position.
//
//   Limits are an ABUSE control. They bound what one account can do to the
//   book's integrity (one player wedging a market open), not what the venue
//   can lose. Adding a limit here does not make the venue safer from a bad
//   bet; it makes the venue safer from a bad ACTOR.
//
// The venue's actual unbounded liability is the market maker — see
// lib/risk.js. That is why these two are separate modules.
//
// Design rules that follow from "the player will appeal":
//   - a breach refuses with a DISTINCT error code per cause, not a generic
//     400, because the client has to render different advice for each;
//   - every refusal carries a DISTINCT, MACHINE-READABLE reason code in
//     `details.code`, so the client renders specific advice and the refusal is
//     diagnosable from the response alone.
//
// …and one line this file used to carry is now gone rather than left standing,
// because it described an intent the implementation does not meet:
//
//   "every refusal carries a reason that is PERSISTED, because 'why was my
//    bet refused' must still be answerable months later"
//
// Nothing persisted one. Every assert* below runs INSIDE the placement
// transaction (see lib/match.js placeOrderTx) and signals by throwing, so a
// row written here would be rolled back with the refusal that wrote it — the
// claim is not merely unimplemented, it is unimplementable from this module.
// The server logs only status >= 500, so a refused order or deposit leaves no
// server-side trace at all. Answering the question months later means asking
// the player. Closing the gap means writing the refusal from the request
// handler, AFTER the transaction has rolled back — which is server.js's, not
// this module's.
//   - limits are a TABLE, not constants. MIN_STAKE_CENTS / MAX_STAKE_CENTS
//     stay venue-wide defaults; a per-user row overrides them.
//
// Enforcement lives INSIDE the placement transaction, so two concurrent
// placements cannot both read a pre-limit liability and both pass. Reading
// the current liability and writing the new order in one transaction is the
// whole reason this is safe; a check-then-act outside a transaction is not.
const { httpError } = require('./auth');
const { transaction } = require('./tx');
const audit = require('./audit');

// lib/match.js is required LAZILY, inside exclude() only. match.js requires
// this module at load time to enforce placement limits, so a top-level require
// here would be a cycle: whichever side loaded first would see a partially
// populated exports object. store.js backfillFrozenCents uses the same
// lazy-require escape hatch for the same reason.

// Venue-wide fallback. A user with no `limits` row is unlimited on these
// axes — the absence of a row is the absence of a restriction, not a zero
// cap. Reading NULL as 0 would silently freeze every account on upgrade.
const NO_LIMITS = {
  max_open_stake_cents: null,
  max_market_liability_cents: null,
  max_daily_settled_cents: null,
};

// Scope vocabulary. 'global' applies everywhere; 'market:<id>' narrows to one
// market. Kept a closed set so a scope string can never be interpolated into
// SQL from user input without validation.
const GLOBAL_SCOPE = 'global';

function marketScope(marketId) {
  return `market:${marketId}`;
}

function isValidScope(scope) {
  // TYPE first. The route substitutes the default only for `undefined`
  // (server.js: `scope === undefined ? GLOBAL_SCOPE : scope`), so `5`, `null`
  // and `['global']` all arrive here straight from JSON — and the line below
  // calls `.startsWith` on them. Without this guard that is a TypeError with
  // no `.status`, which the error handler renders as a 500: bad input
  // answered with "the server is broken", which trains operators to ignore
  // 5xx from this route.
  //
  // The inconsistency is the tell. capOf() a few lines below explicitly
  // rejects a non-integer on every AXIS, so a caller reading this module
  // cannot infer that the SCOPE was the unvalidated one.
  if (typeof scope !== 'string') return false;
  if (scope === GLOBAL_SCOPE) return true;
  if (!scope.startsWith('market:')) return false;
  const id = Number(scope.slice('market:'.length));
  return Number.isInteger(id) && id > 0;
}

// Limits are nullable columns meaning "no cap on this axis". Store 0 as a
// real zero (a player capped at nothing can still place nothing) rather than
// coercing it to unlimited.
function capOf(value, field) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw httpError(400, `${field} must be a non-negative integer number of cents, or null for no cap`);
  }
  return value;
}

/**
 * Effective limits for a user in one market: the market scope wins over
 * global on a per-axis basis, so setting a market-specific liability cap does
 * not silently clear the user's global daily cap. Axes are merged, not the
 * whole row, because operators set these one at a time.
 */
function effective(db, userId, marketId) {
  const rows = db
    .prepare('SELECT scope, max_open_stake_cents, max_market_liability_cents, max_daily_settled_cents FROM limits WHERE user_id = ?')
    .all(userId);
  const byScope = new Map(rows.map((r) => [r.scope, r]));
  const global = byScope.get(GLOBAL_SCOPE);
  const scoped = marketId ? byScope.get(marketScope(marketId)) : undefined;
  const pick = (field) => {
    const s = scoped ? scoped[field] : null;
    if (s !== null && s !== undefined) return s;
    return global ? global[field] : null;
  };
  return {
    max_open_stake_cents: pick('max_open_stake_cents'),
    max_market_liability_cents: pick('max_market_liability_cents'),
    max_daily_settled_cents: pick('max_daily_settled_cents'),
  };
}

/**
 * Current open liability for a user on a market: the sum of escrow held
 * against their RESTING orders there (orders.frozen_cents, the per-order
 * remainder escrow — see lib/match.js).
 *
 * Deliberately excludes matched portions. A matched position's stake stays
 * frozen in the WALLET but is held per-market-agnostic; it is already
 * collateralised and cannot be cancelled, so counting it here would refuse
 * placements for exposure the user can no longer change.
 */
function marketLiability(db, userId, marketId) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(frozen_cents), 0) AS liability
         FROM orders
        WHERE user_id = ? AND market_id = ? AND status = 'open'`
    )
    .get(userId, marketId);
  return r.liability;
}

/**
 * Net settlement today for a user, in cents. `settlements.at` is
 * datetime('now') (UTC), so date(at) is the UTC trading day — consistent with
 * the rest of the schema's timestamps.
 *
 * NET, not gross: a cap on gross settlement would be defeated by churn
 * (win small, lose small, repeat) and would effectively be a no-op for
 * anyone who is net flat, which is the opposite of what an operator
 * intends.
 *
 * NET MEANS NET — the commission is subtracted here, because it is NOT
 * subtracted at write time. This comment used to assert "pnl_cents is already
 * net of commission at write time", and that was false: lib/settle.js stores
 * the gross delta in pnl_cents and the fee in its own column,
 *
 *   INSERT INTO settlements (..., commission_cents, pnl_cents)
 *   VALUES (?, ?, ?, ?, ?)  -- commission, a.balanceDelta
 *
 * so the sum was gross of the fee and the cap tripped earlier than promised.
 * The reasoning above is sound; the code did not match it. commission_cents is
 * NOT NULL, so the subtraction cannot go NULL — and it is charged only when
 * pnl > 0, so on a losing settlement it is zero and the sum is unchanged.
 */
function netSettledToday(db, userId) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(pnl_cents - commission_cents), 0) AS net
         FROM settlements
        WHERE user_id = ? AND date(at) = date('now')`
    )
    .get(userId);
  return r.net;
}

/**
 * Is this account currently self-excluded? Returns the exclusion end
 * ('permanent', or an ISO datetime) or null.
 *
 * The FLAG decides whether excluded at all; the DATE only decides for how
 * long. Both "permanently excluded" and "never excluded" are reachable, which
 * is why they are not encoded in the nullable date alone.
 */
function exclusionOf(db, userId) {
  const u = db.prepare('SELECT self_excluded, excluded_until FROM users WHERE id = ?').get(userId);
  if (!u || !u.self_excluded) return null;
  if (!u.excluded_until) return 'permanent';
  // A stored end date that is not in SQLite's canonical shape is treated as
  // STILL EXCLUDED. This fails CLOSED, and it has to: the old code compared the
  // raw string against datetime('now') and anything that did not sort after
  // the current time returned null — "not excluded". A hand-edited row, a value
  // written before exclude() validated its input, or simply "15 Jan 2030"
  // (whose first character sorts before the "2" of a 202x date) silently
  // RE-ADMITTED a self-excluded player. A player's own request to stop is the
  // one control here that must never fail open, so anything unrecognised keeps
  // the exclusion in force rather than lifting it.
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(u.excluded_until)) return 'permanent';
  const nowRow = db.prepare("SELECT datetime('now') AS now").get();
  return u.excluded_until > nowRow.now ? u.excluded_until : null;
}

/**
 * Gate every trading path: suspended or excluded accounts cannot trade.
 * Distinct messages because the CLIENT must render different advice — a
 * suspension is an operator decision the player may appeal, an exclusion is
 * the player's own request and must never be argued with.
 *
 * A SUSPENDED TENANT IS GATED HERE TOO (#32), in the engine rather than in a
 * route, for the reason this function exists at all: it is the ONE gate every
 * money path already calls, so a control added anywhere else is a control some
 * route can forget. It is what makes an ALREADY-SIGNED-IN player stop as well
 * as stopping the next login.
 *
 * `status` here is a USER's. A tenant is a whole venue, and its own state lives
 * in lib/tenants.js — which is also why this reads it through that module
 * rather than reaching for the tenants table directly.
 */
function assertTradeable(db, user) {
  const row = db.prepare('SELECT status, excluded_until FROM users WHERE id = ?').get(user.id);
  if (!row) throw httpError(404, 'User not found');
  if (row.status === 'suspended') {
    throw httpError(403, 'This account is suspended. Contact the operator.', { code: 'account_suspended' });
  }
  // SELF-EXCLUSION IS CHECKED FIRST, and that ordering is the control.
  //
  // It used to be checked AFTER the responsible-gambling controls, so a player
  // who was both excluded and past their session limit was told "Your
  // 30-minute session limit has been reached. Sign out to finish this
  // session." — advice that leads straight back in, on an account that can
  // never come back in. The exclusion message must be the one they see: it is
  // the only answer to that question that is not an argument.
  const until = exclusionOf(db, user.id);
  if (until) {
    // Deliberately offers NO support route. An excluded account that can
    // argue its way back in is not excluded — that is the entire point of the
    // control, and a support-desk override silently defeats it.
    throw httpError(
      403,
      until === 'permanent'
        ? 'This account is permanently self-excluded.'
        : `This account is self-excluded until ${until}.`,
      { code: 'self_excluded', until }
    );
  }
  // …and the TENANT is checked next, after the exclusion for the same reason.
  // A suspension also leads nowhere straight back in, so letting it outrank the
  // exclusion would reintroduce the exact advice-that-leads-back-in this
  // function was reordered to stop giving.
  //
  // Lazy require: match.js requires this module at load time, and the cycle
  // note at the top of the file explains why that matters.
  const tenantRefusal = require('./tenants').suspensionRefusalForUser(db, user.id);
  if (tenantRefusal) {
    throw httpError(403, 'This trading venue is suspended. Contact the operator.', { code: tenantRefusal });
  }
  // The RG controls run HERE, inside the ONE function every betting path
  // already calls — not in a parallel gate someone has to remember. A session
  // limit or an owed reality check enforced in some routes and not others is
  // not a control, and the route that forgot would be the one a motivated
  // player finds.
  require('./rg').assertPlayable(db, user.id);
}

/**
 * Placement gate. Refuses when the order would push the user's open
 * liability on this market past their cap.
 *
 * MUST be called inside the placement transaction (see lib/match.js
 * placeOrderTx). The check reads a SUM and the caller then inserts an order;
 * if those are in different transactions, two concurrent placements both see
 * the pre-limit sum and both pass.
 */
function assertPlacement(db, userId, marketId, escrowCents) {
  const lim = effective(db, userId, marketId);
  const cap = lim.max_market_liability_cents;
  if (cap === null) return;
  const current = marketLiability(db, userId, marketId);
  if (current + escrowCents > cap) {
    throw httpError(
      429,
      `This order would exceed your market liability limit of $${(cap / 100).toFixed(2)}`,
      { code: 'market_liability_exceeded', cap_cents: cap, current_cents: current }
    );
  }
}

/** Per-order stake cap, applied against the STAKE (not the escrow). */
function assertStake(db, userId, marketId, stakeCents) {
  const lim = effective(db, userId, marketId);
  const cap = lim.max_open_stake_cents;
  if (cap !== null && stakeCents > cap) {
    throw httpError(429, `Stake exceeds your limit of $${(cap / 100).toFixed(2)}`, {
      code: 'stake_limit_exceeded',
      cap_cents: cap,
    });
  }
}

/**
 * May this user's order take fills today?
 *
 * When the daily net-settlement cap is reached the answer is NO — and the
 * order still rests. It is NOT cancelled, and that distinction is the whole
 * point: silently cancelling would change the meaning of the book for
 * everyone else looking at it, and a player whose order vanished for no
 * stated reason is a support incident. The order simply stops participating
 * in matching, which is visible and explicable.
 */
function matchingAllowed(db, userId, marketId) {
  const lim = effective(db, userId, marketId);
  const cap = lim.max_daily_settled_cents;
  if (cap === null) return true;
  return netSettledToday(db, userId) < cap;
}

/**
 * Operator-set limits for a user.
 *
 * ABSENT vs NULL, AND WHY THE SIGNATURE CHANGED.
 *
 * The contract the route documents is "a key that is ABSENT leaves that axis
 * untouched; a key present with a null CLEARS the cap", and the route tries
 * honouring it by spreading `...(x === undefined ? {} : { x })`.
 *
 * That does not work, and could not. Destructuring the parameter gives an absent
 * key the same `undefined` as an explicitly-passed one, so by the time
 * `capOf` ran, "absent" and "absent-valued" were indistinguishable — and
 * `capOf(undefined)` returns null, which CLEARS. Measured: stake 5000 and daily
 * 9000, then a PUT carrying only `max_open_stake_cents: 1000` returned
 * `max_daily_settled_cents: null`. Tightening one cap silently granted an
 * unlimited daily cap, which is precisely the harm the route comment says it is
 * preventing.
 *
 * The whole request object is therefore taken un-destructured, and each axis is
 * resolved against its own key's PRESENCE. Validating the absent axis against
 * its previous value would also be wrong in the other direction — re-validating
 * a stored cap that predates the current rules should not refuse a no-op.
 */
function setLimits(db, req) {
  const { actor, userId, scope } = req;
  if (!isValidScope(scope)) throw httpError(400, `Invalid limit scope: ${scope}`);
  const present = (k) => Object.prototype.hasOwnProperty.call(req, k);
  return transaction(db, () => {
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!u) throw httpError(404, 'User not found');
    // Absent axis: keep whatever is stored. `undefined` here means "no row yet",
    // which is correctly a null cap.
    const prev = db.prepare('SELECT * FROM limits WHERE user_id = ? AND scope = ?').get(userId, scope) || {};
    const axis = (k) => (present(k) ? capOf(req[k], k) : (prev[k] === undefined ? null : prev[k]));
    const open = axis('max_open_stake_cents');
    const liab = axis('max_market_liability_cents');
    const daily = axis('max_daily_settled_cents');
    db.prepare(
      `INSERT INTO limits (user_id, scope, max_open_stake_cents, max_market_liability_cents, max_daily_settled_cents)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, scope) DO UPDATE SET
         max_open_stake_cents = excluded.max_open_stake_cents,
         max_market_liability_cents = excluded.max_market_liability_cents,
         max_daily_settled_cents = excluded.max_daily_settled_cents`
    ).run(userId, scope, open, liab, daily);
    const after = effective(db, userId, scope.startsWith('market:') ? Number(scope.slice(7)) : null);
    audit.record(db, actor, audit.ACTIONS.LIMITS_CHANGED, `user:${userId}`, null, { scope, ...after }, null);
    return { user_id: userId, scope, ...after };
  });
}

function getLimits(db, userId) {
  return db
    .prepare('SELECT scope, max_open_stake_cents, max_market_liability_cents, max_daily_settled_cents FROM limits WHERE user_id = ? ORDER BY scope')
    .all(userId);
}

/**
 * Self-exclusion. ABSOLUTE and outranking open positions.
 *
 * Behaviour on exclude:
 *   - resting orders are cancelled and their escrow released, so funds are
 *     not stranded in escrow by an account that will never trade again;
 *   - MATCHED positions are deliberately left alone. They are collateralised
 *     on both sides and must still settle — releasing them, or refusing to
 *     settle them, would mean the venue chooses which side of a matched bet
 *     to honour. Excluding someone must not cost the counterparty money.
 *   - `until` is nullable = permanent. Permanent is the safe default for a
 *     real exclusion; a timed one that lapses into re-admission is a
 *     different (and much weaker) product decision.
 *
 * There is deliberately no `unexclude` on this module. Reinstatement is a
 * separate, audited operator action, not the inverse of this call.
 */
function exclude(db, { actor, userId, until = null, reason = null }) {
  if (until !== null) {
    // STRICT validation, and normalisation to UTC.
    //
    // `Date.parse` accepts anything V8 can make sense of, including "15 Jan
    // 2030". That passed, and `.replace('T', ' ').slice(0, 19)` then left it
    // unchanged — so a non-ISO string reached a column that is later compared
    // LEXICOGRAPHICALLY against 'YYYY-MM-DD HH:MM:SS'. "15 Jan 2030" sorts
    // before "2026-…" because '1' precedes '2', so exclusionOf() read it as
    // LAPSED and the exclusion was recorded as complete the instant it was
    // made. The control failed open on its own happy path.
    //
    // Offsets were discarded too: '2030-01-15T00:00:00+05:00' became
    // '2030-01-15 00:00:00', five hours late, ending the exclusion early.
    //
    // toSqlUtc() accepts only the documented ISO shapes (verifying the calendar
    // by round-trip, so 2030-02-31 is refused) and stores the instant in UTC.
    const normalised = require('./util').toSqlUtc(until);
    if (normalised === null) {
      throw httpError(400, 'until must be null (permanent) or an ISO-8601 datetime (YYYY-MM-DD[THH:MM[:SS]][Z|±HH:MM])');
    }
    until = normalised;
  }
  return transaction(db, () => {
    const match = require('./match'); // lazy: see the cycle note at the top
    const u = db.prepare('SELECT id, self_excluded, excluded_until FROM users WHERE id = ?').get(userId);
    if (!u) throw httpError(404, 'User not found');
    if (u.is_bot) throw httpError(400, 'Bots cannot be excluded');

    let cancelled = 0;
    let releasedCents = 0;
    for (const o of match.openOrdersFor(db, userId)) {
      if (o.frozen_cents > 0) releasedCents += o.frozen_cents;
      match.cancelOrder(db, { id: userId }, o.id);
      cancelled++;
    }
    db.prepare('UPDATE users SET self_excluded = 1, excluded_until = ? WHERE id = ?').run(until, userId);
    audit.record(
      db, actor, audit.ACTIONS.USER_EXCLUDED, `user:${userId}`,
      { excluded_until: u.excluded_until }, { excluded_until: until }, reason
    );
    return { id: userId, excluded_until: until, cancelled_orders: cancelled, released_cents: releasedCents };
  });
}

module.exports = {
  GLOBAL_SCOPE,
  marketScope,
  isValidScope,
  NO_LIMITS,
  effective,
  marketLiability,
  netSettledToday,
  exclusionOf,
  assertTradeable,
  assertPlacement,
  assertStake,
  matchingAllowed,
  setLimits,
  getLimits,
  exclude,
};