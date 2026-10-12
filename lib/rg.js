'use strict';
// lib/rg.js — responsible-gambling controls.
//
// These are not features. In most jurisdictions a venue that offers betting to
// real people MUST offer a session limit, a reality check, a deposit limit and
// a self-exclusion path; the last shipped in Phase 1, and these are the other
// three. docs/ROADMAP.md is blunt about it: the product should not be
// deployable to an operator who has not configured them.
//
// WHY THEY LIVE TOGETHER AND WHY THE GATE IS ONE PLACE. Every one of these is
// a REFUSAL to let a player keep doing something, and a refusal that is
// enforced in some paths and not others is not a control — it is a suggestion
// with a code path. So each control has exactly one assertion, and the betting
// paths all call `assertPlayable`, which runs all of them. A new betting route
// that calls it is covered; a new route that forgets is visible in review
// because there is one function to look for.
//
// WHY EACH IS OFF BY DEFAULT, WITH A BOOT WARNING. Zero means "not configured",
// not "unlimited but enforced": there is no sensible session limit that is
// correct for every operator, and hard-coding one would be the same mistake as
// hard-coding a PSP or a cooling-off period. So they are configured, not
// assumed — and the server says so at boot rather than letting a demo
// deployment reach production silently unguarded.
//
// THE STATE is a row per user, not columns on users: these controls are the
// first of several that are per-user, per-period, and jurisdiction-dependent
// (deposit limits by rolling 24h vs calendar day, session limits by
// inactivity), and a table can grow that without another users-table migration.
const { httpError } = require('./auth');
const { transaction } = require('./tx');

const config = require('./config');

/** The current time as SQLite sees it, so tests and the server never disagree. */
const sqliteNow = (db) => db.prepare("SELECT datetime('now') AS n").get().n;

/**
 * The per-user row, created on demand. A missing row means "no session
 * started, no check acknowledged", which is the correct default for a player
 * who has not started playing.
 */
function stateOf(db, userId, { create = false } = {}) {
  let row = db.prepare('SELECT * FROM user_rg_state WHERE user_id = ?').get(userId);
  if (!row && create) {
    // The reality clock starts when the row is created, NOT when a session
    // starts. It used to be stamped only by startSession, which meant
    // configuring RG_REALITY_CHECK_MINUTES WITHOUT RG_SESSION_MINUTES left
    // the check permanently not-due — a configured control that does nothing,
    // which is the exact failure this module exists to prevent. A control that
    // appears in the config and is inert is worse than an absent one.
    db.prepare(
      "INSERT INTO user_rg_state (user_id, last_reality_check_at) VALUES (?, datetime('now'))"
    ).run(userId);
    row = db.prepare('SELECT * FROM user_rg_state WHERE user_id = ?').get(userId);
  }
  return row || null;
}

/**
 * Start (or confirm) a play session.
 *
 * Called at sign-in. A session that is already running is NOT restarted: a
 * player who reconnects after a dropped connection must not get a fresh
 * session limit, or the limit is defeated by refreshing the page — which is the
 * single easiest way to defeat a session limit and the reason this is explicit
 * rather than "set it to now whenever someone logs in".
 *
 * An existing session older than the configured limit is LEFT as it is, so the
 * limit still bites: the session does not silently renew because the player
 * happened to sign in again.
 */
function startSession(db, userId) {
  const minutes = Number(config.RG_SESSION_MINUTES || 0);
  if (minutes <= 0) return { session_started_at: null, session_limit_minutes: 0, enforced: false };
  const idleReset = Number(config.RG_SESSION_IDLE_RESET_MINUTES || 0);
  return transaction(db, () => {
    const row = stateOf(db, userId, { create: true });
    if (row.session_started_at) {
      // The clock is PRESERVED across a sign-in. It is reset ONLY after a real
      // idle gap, which is the difference between a session limit and a
      // suggestion.
      //
      // It used to be cleared on logout, which made the control trivially
      // defeatable in two ways: sign out and straight back in for a fresh hour,
      // and — because the clock was per-USER — one logout from any session
      // cleared it for every OTHER live session too, with no re-login at all.
      //
      // So the reset condition is now IDLE, not LOGOUT: a player who walks away
      // and comes back tomorrow gets a fresh session, and a player who signs
      // out and back in thirty seconds does not. `last_active_at` is stamped by
      // middleware on every authenticated request, so the gap is measured from
      // real use rather than from a clock the player can set by signing out.
      if (idleReset > 0 && row.last_active_at) {
        const idle = db
          .prepare("SELECT CAST((julianday('now') - julianday(?)) * 1440 AS INTEGER) AS mins")
          .get(row.last_active_at).mins;
        if (idle >= idleReset) {
          db.prepare("UPDATE user_rg_state SET session_started_at = datetime('now') WHERE user_id = ?").run(userId);
          return { session_started_at: sqliteNow(db), session_limit_minutes: minutes, enforced: true, reset_after_idle_minutes: idle };
        }
      }
      return {
        session_started_at: row.session_started_at,
        session_limit_minutes: minutes,
        enforced: true,
        idle_reset_minutes: idleReset,
      };
    }
    db.prepare("UPDATE user_rg_state SET session_started_at = datetime('now'), last_active_at = datetime('now') WHERE user_id = ?").run(userId);
    return { session_started_at: sqliteNow(db), session_limit_minutes: minutes, enforced: true };
  });
}

/**
 * Signing out does NOT end the session clock.
 *
 * The clock is the player's, not the connection's: a session limit defeated by
 * signing out is not a limit, and one logout used to clear the clock for every
 * other live session as well. So logout records that the player is still around
 * (refreshing `last_active_at`) and leaves `session_started_at` alone. Only a
 * real idle gap starts a new session.
 *
 * `hardReset` is for the one case that genuinely should clear it — an operator
 * or a support action — and is not reachable from any player route.
 */
function endSession(db, userId, { hardReset = false } = {}) {
  if (hardReset) {
    db.prepare('UPDATE user_rg_state SET session_started_at = NULL WHERE user_id = ?').run(userId);
    return;
  }
  db.prepare("UPDATE user_rg_state SET last_active_at = datetime('now') WHERE user_id = ?").run(userId);
}

/** Stamp activity so an idle gap is measured from real use, not from sign-out. */
function touch(db, userId) {
  db.prepare("UPDATE user_rg_state SET last_active_at = datetime('now') WHERE user_id = ?").run(userId);
}

/**
 * SESSION LIMIT. Refuses play once the configured session has run.
 *
 * An open-ended breach is the point: the message tells the player exactly how
 * long they have been playing, because "your session has ended" with no
 * context is the kind of message that gets a support ticket and no
 * behavioural change.
 */
function assertSession(db, userId) {
  const minutes = Number(config.RG_SESSION_MINUTES || 0);
  if (minutes <= 0) return;
  const row = stateOf(db, userId);
  if (!row || !row.session_started_at) return; // not playing: nothing to enforce
  const r = db
    .prepare("SELECT session_started_at, CAST((julianday('now') - julianday(session_started_at)) * 1440 AS INTEGER) AS mins FROM user_rg_state WHERE user_id = ?")
    .get(userId);
  if (r.mins >= minutes) {
    throw httpError(403, `Your ${minutes}-minute session limit has been reached. Sign out to finish this session.`, {
      code: 'session_limit_reached',
      session_limit_minutes: minutes,
      played_minutes: r.mins,
    });
  }
}

/**
 * REALITY CHECK. Every N minutes of continuous play the player must
 * acknowledge a factual summary of their own session before they can bet
 * again.
 *
 * The engine, not the client, decides whether a check is due — a check the
 * player can skip by not clicking the dialog is not a check. The
 * acknowledgement endpoint is the only thing that resets the clock.
 */
function realityCheckDue(db, userId, { create = false } = {}) {
  const minutes = Number(config.RG_REALITY_CHECK_MINUTES || 0);
  if (minutes <= 0) return { due: false, due_in_minutes: null, enforced: false };
  const row = stateOf(db, userId, { create });
  if (!row) return { due: false, due_in_minutes: minutes, enforced: true };
  // The clock starts at sign-in too, so a player cannot dodge the first check
  // by never having a session row.
  const base = row.last_reality_check_at || row.session_started_at;
  if (!base) return { due: false, due_in_minutes: minutes, enforced: true };
  const r = db
    .prepare("SELECT CAST((julianday('now') - julianday(?)) * 1440 AS INTEGER) AS mins")
    .get(base);
  if (r.mins >= minutes) {
    return { due: true, due_in_minutes: 0, enforced: true, minutes_ago: r.mins };
  }
  return { due: false, due_in_minutes: minutes - r.mins, enforced: true };
}

/** The gate side of a reality check: refuse play while one is owed. */
function assertRealityCheck(db, userId) {
  // create: true — the gate is where the clock starts for a player who has
  // never opened a session, so the check cannot be dodged by never having one.
  const due = realityCheckDue(db, userId, { create: true });
  if (!due.due) return;
  throw httpError(403, 'Please review your session summary to continue.', {
    code: 'reality_check_due',
    minutes_ago: due.minutes_ago,
  });
}

/**
 * Acknowledge a reality check. Records the acknowledgement with the player's
 * own net position at that moment, so the summary a player is shown is
 * auditable rather than a client-side number.
 */
function acknowledgeRealityCheck(db, userId) {
  const minutes = Number(config.RG_REALITY_CHECK_MINUTES || 0);
  return transaction(db, () => {
    stateOf(db, userId, { create: true });
    // A CHECK THAT IS NOT DUE MUST NOT BE ACKNOWLEDGED.
    //
    // This endpoint used to stamp last_reality_check_at unconditionally, so a
    // player could call it whenever they liked and keep the countdown
    // permanently fresh: the gate would never fire and no summary would ever
    // be shown. The control existed, was reachable, and did nothing — the same
    // shape as every other dead control in this codebase's history, reached
    // this time by leaving out a single check.
    //
    // The clock is now only reset by a check that is genuinely owed, which
    // makes the endpoint idempotent-but-meaningless until it matters, and
    // makes "call it early" a 409 rather than a free reset.
    if (minutes > 0) {
      const due = realityCheckDue(db, userId);
      if (!due.due) {
        throw httpError(409, 'No reality check is due yet.', {
          code: 'reality_check_not_due',
          due_in_minutes: due.due_in_minutes,
        });
      }
    }
    const net = db
      .prepare(
        // The timestamp column on settlements is `at`, not `settled_at` (that
        // is the market column) — the first version of this queried a column
        // that does not exist and every reality check errored.
        `SELECT COALESCE(SUM(pnl_cents), 0) AS net FROM settlements
          WHERE user_id = ? AND date(at) = date('now')`
      )
      .get(userId).net;
    const u = db.prepare('SELECT balance_cents b FROM users WHERE id = ?').get(userId);
    db.prepare("UPDATE user_rg_state SET last_reality_check_at = datetime('now'), last_check_net_cents = ? WHERE user_id = ?")
      .run(net, userId);
    return { acknowledged_at: sqliteNow(db), net_settled_today_cents: net, balance_cents: u ? u.b : 0 };
  });
}

/**
 * DEPOSIT LIMIT. Cents deposited in a rolling day, across BOTH deposit paths
 * (the paper faucet and a payment intent), so the limit cannot be side-stepped
 * by choosing the other route.
 */
function depositedInWindow(db, userId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions
        WHERE user_id = ? AND type = 'deposit'
          AND at >= datetime('now', '-1 day')`
    )
    .get(userId).s;
}

function assertDeposit(db, userId, cents) {
  const cap = Number(config.RG_DEPOSIT_DAILY_CENTS || 0);
  if (cap <= 0) return;
  const spent = depositedInWindow(db, userId);
  if (spent + cents > cap) {
    throw httpError(
      403,
      `This deposit would take you over your $${(cap / 100).toFixed(2)} rolling 24-hour deposit limit ($${(spent / 100).toFixed(2)} used).`,
      { code: 'deposit_limit_reached', cap_cents: cap, deposited_cents: spent, requested_cents: cents }
    );
  }
}

/**
 * THE ONE GATE. Every betting path calls this, so a session limit or an owed
 * reality check cannot be bypassed by finding a route that forgot one of them.
 * Called inside the placement transaction, like every other abuse control: the
 * check reads a clock and the caller then writes money.
 */
function assertPlayable(db, userId) {
  assertSession(db, userId);
  assertRealityCheck(db, userId);
}

/** What the client renders: countdown, whether a check is owed, the deposit window. */
function status(db, userId) {
  const check = realityCheckDue(db, userId);
  const row = stateOf(db, userId);
  const minutes = Number(config.RG_SESSION_MINUTES || 0);
  const r = row && row.session_started_at
    ? db
        .prepare("SELECT CAST((julianday('now') - julianday(?)) * 1440 AS INTEGER) AS mins")
        .get(row.session_started_at).mins
    : 0;
  return {
    session_limit_minutes: minutes,
    session_started_at: row ? row.session_started_at : null,
    played_minutes: r,
    session_remaining_minutes: minutes > 0 ? Math.max(0, minutes - r) : null,
    session_reached: minutes > 0 && !!row && row.session_started_at && r >= minutes,
    reality_check_minutes: Number(config.RG_REALITY_CHECK_MINUTES || 0),
    reality_check_due: check.due,
    reality_check_due_in_minutes: check.due_in_minutes,
    deposit_limit_cents: Number(config.RG_DEPOSIT_DAILY_CENTS || 0),
    deposited_24h_cents: depositedInWindow(db, userId),
    deposit_limit_remaining_cents:
      Number(config.RG_DEPOSIT_DAILY_CENTS || 0) > 0
        ? Math.max(0, Number(config.RG_DEPOSIT_DAILY_CENTS) - depositedInWindow(db, userId))
        : null,
    // The single question an operator must be able to answer: is this
    // deployment guarded at all? Delegated, so the boot check and this
    // endpoint cannot drift into disagreeing.
    configured: configured(),
  };
}

/**
 * Is this deployment guarded at all?
 *
 * A CONFIG question, deliberately not answered by status() — that needs a user,
 * and a boot check should not depend on a row existing. All three zero means
 * unbounded play, which the server says so about at boot.
 */
function configured() {
  return (
    Number(config.RG_SESSION_MINUTES || 0) > 0 ||
    Number(config.RG_REALITY_CHECK_MINUTES || 0) > 0 ||
    Number(config.RG_DEPOSIT_DAILY_CENTS || 0) > 0
  );
}

module.exports = {
  configured,
  touch,
  startSession,
  endSession,
  assertSession,
  assertRealityCheck,
  assertPlayable,
  realityCheckDue,
  acknowledgeRealityCheck,
  assertDeposit,
  depositedInWindow,
  status,
  stateOf,
};
