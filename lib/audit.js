'use strict';
// lib/audit.js — append-only record of OPERATOR actions.
//
// Deliberately separate from lib/ledger.js. `transactions` answers "did the
// money move, and to what balance"; audit_log answers "who decided this, and
// why". The two overlap only for adjustments, where BOTH are written: the
// ledger row is the money, the audit row is the authority and the reason.
//
// Two properties this module exists to guarantee:
//
//   1. It never throws into a caller's transaction. A failure to record an
//      audit row must not roll back a settlement that is arithmetically
//      correct — but it must be loud, because an unauditable operator action
//      is the failure this table exists to prevent. So: catch, warn, continue.
//   2. It records the SYSTEM as an actor too. `actor_id` NULL means "no human
//      did this" (an automatic settlement, a drift tick). Collapsing that into
//      "the admin did it" would be the single most misleading thing an audit
//      log could do.
const { inTransaction } = require('./tx');

// Actions are a fixed vocabulary rather than free text, so an operator-facing
// audit filter can enumerate them and a typo cannot invent a new category.
//
// THE VOCABULARY IS ALSO A PROMISE, and it is only honest while every entry is
// actually written. Three entries here used to be defined and never recorded
// anywhere in the codebase — USER_REGISTER, RESULT_APPLIED and RESULT_HELD — so
// the schema advertised categories that did not exist, and an operator asking
// "who logged in to this account last Tuesday" would look for one the code
// said existed and find nothing.
//
// USER_LOGIN, USER_LOGIN_FAILED and USER_LOGOUT are recorded by lib/auth.js.
//
// The three removed entries are deliberately absent rather than quietly
// restored, because their only honest call sites are outside this module:
// USER_REGISTER belongs on the POST /api/auth/register route (server.js —
// lib/auth.js's registerUser is also the test suite's account factory, so
// auditing it there would file every fixture as a human registration), and
// RESULT_APPLIED / RESULT_HELD belong at the results-apply site in
// lib/results.js. Re-adding an entry is one line plus its record call; leaving
// it defined without one is the defect.
const ACTIONS = {
  USER_LOGIN: 'user.login',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGOUT: 'user.logout',
  USER_PASSWORD_CHANGED: 'user.password_changed',
  USER_SESSIONS_REVOKED: 'user.sessions_revoked',
  USER_STATUS_CHANGED: 'user.status_changed',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_EXCLUDED: 'user.excluded',
  LIMITS_CHANGED: 'user.limits_changed',
  BALANCE_ADJUSTED: 'user.balance_adjusted',
  MARKET_SETTLED: 'market.settled',
  MARKET_SUSPENDED: 'market.suspended',
  MARKET_RESTORED: 'market.restored',
  RISK_CONFIGURED: 'risk.configured',
  RISK_KILL_SWITCH: 'risk.kill_switch',
  RISK_LOSS_CAP_HIT: 'risk.loss_cap_hit',
  TENANT_CONFIGURED: 'tenant.configured',
  FINDING_RESOLVED: 'reconciliation.finding_resolved',
  BACKUP_TAKEN: 'ops.backup_taken',
  PAYMENT_INTENT_COMPLETED: 'payments.intent_completed',
  PAYMENT_INTENT_FAILED: 'payments.intent_failed',
};

function actorOf(actor) {
  if (actor === null || actor === undefined) return null;
  return typeof actor === 'object' ? actor.id : actor;
}

/**
 * Record one operator action.
 *
 * @param db      open database
 * @param actor   user id, a sanitized user, or null for a system action
 * @param action  one of ACTIONS
 * @param target  subject string, e.g. 'user:42'
 * @param before  object of changed fields BEFORE (optional)
 * @param after   object of changed fields AFTER  (optional)
 * @param reason  operator-supplied cause (optional, but required by callers
 *                that change money or access)
 */
function record(db, actor, action, target, before, after, reason) {
  try {
    db.prepare(
      `INSERT INTO audit_log (actor_id, action, target, before, after, reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      actorOf(actor),
      action,
      target ?? null,
      before === undefined || before === null ? null : JSON.stringify(before),
      after === undefined || after === null ? null : JSON.stringify(after),
      reason === undefined || reason === null ? null : String(reason).slice(0, 500)
    );
    return true;
  } catch (e) {
    // Loud, but never fatal to the caller's transaction.
    console.warn('[audit] FAILED to record', action, '->', e.message);
    return false;
  }
}

/**
 * `record`, but a FAILED audit write THROWS.
 *
 * `record` above deliberately swallows its own errors: it logs a warning and
 * returns false, because most callers record from outside a transaction and
 * should not have an audit-log problem take down an unrelated request. That is
 * the right default and it is kept.
 *
 * It is the wrong default INSIDE a transaction, and the reason matters: a bare
 * `transaction(db, () => { mutate(); record(); })` closes nothing. Nothing is
 * thrown, so nothing rolls back, and the mutation commits with no audit row at
 * all — which is precisely the gap that made `lib/tenants.js` (no wrapper) and
 * `lib/risk.js` (wrapper, audit outside it) reachable.
 *
 * So the invariant is enforced in BOTH directions:
 *
 *   - an audit row can never exist for a change that was rolled back — the
 *     transaction gives this, and it is the one server.js already claimed;
 *   - a change that could not be audited does not happen — this gives this, and
 *     it is the one nothing was enforcing.
 *
 * Call it inside a transaction. Outside one, throwing changes nothing except
 * that the caller now hears about the failure instead of losing it.
 *
 * WHO USES IT TODAY: `lib/tenants.js` (commission rate, tenant status) and
 * `lib/risk.js` (the kill switch), which are the two mutators behind #27.
 *
 * `lib/admin.js` still calls `record`. Its audit rows DO share a transaction
 * with its mutations, so the guarantee it is relied on for — an audit row can
 * never exist for a change that was rolled back — is intact and true. The
 * opposite direction is not enforced there: if the audit INSERT fails, the
 * mutation still commits. That gap is unchanged by this commit and is not part
 * of it; `lib/jobs.js`, `lib/results.js` and `lib/feedcreds.js` are the same.
 * Adopting `mustRecord` in those is a separate, deliberate decision — it turns
 * an audit-log outage into a refused operator action, which is correct for a
 * commercial or legal fact and may not be wanted for every call site.
 */
function mustRecord(db, ...args) {
  if (!record(db, ...args)) {
    const e = new Error('The audit log could not be written, so the change was rolled back');
    // 5xx on purpose: the operator's intent was refused by the venue's own
    // machinery, and errorHandler will report it as an internal fault — which is
    // what it is. The message names the cause so the log says what happened.
    e.status = 500;
    throw e;
  }
  return true;
}

// Convenience for wrapping an operation so the audit row and the mutation share
// one transaction: if the mutation rolls back, so does its audit row, and an
// audit row can never exist for an action that did not happen — nor, since
// mustRecord, can the action happen without one.
function inAuditedTx(db, fn, auditArgs) {
  const tx = require('./tx');
  return tx.transaction(db, () => {
    const result = fn();
    if (auditArgs) mustRecord(db, ...auditArgs);
    return result;
  });
}

// Read side, for the admin desk. Newest first, optionally narrowed.
function list(db, { limit = 100, target, action, actorId } = {}) {
  const where = [];
  const params = [];
  if (target) { where.push('target = ?'); params.push(target); }
  if (action) { where.push('action = ?'); params.push(action); }
  if (actorId) { where.push('actor_id = ?'); params.push(actorId); }
  const sql =
    `SELECT id, actor_id, action, target, before, after, reason, at
       FROM audit_log
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC
      LIMIT ?`;
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 1000));
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({
      id: r.id,
      actor_id: r.actor_id,
      action: r.action,
      target: r.target,
      before: r.before ? JSON.parse(r.before) : null,
      after: r.after ? JSON.parse(r.after) : null,
      reason: r.reason,
      at: r.at,
    }));
}

module.exports = { ACTIONS, record, mustRecord, inAuditedTx, list, inTransaction };
