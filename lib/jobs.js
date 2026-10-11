'use strict';
// lib/jobs.js — scheduled operator work.
//
// WHAT BELONGS HERE. Jobs that must run whether or not anyone is looking:
// reconciliation, results-feed polling, and the daily housekeeping. Anything
// a human triggers is a ROUTE, not a job.
//
// RECONCILIATION IS THE ONE THAT MATTERS. lib/payments exposes a reconcile()
// report, but a report nobody runs is not a control. It has to be on a timer,
// it has to persist its findings, and a DISCREPANCY HAS TO SURVIVE BEING
// IGNORED — a drift of zero every hour is the expected state, so an operator
// who sees nothing learns nothing, and an operator who sees drift once and
// then sees nothing cannot tell whether it was fixed or merely hidden.
//
// So findings are recorded in a table with their drift, and an UNRESOLVED
// finding keeps re-surfacing until someone closes it explicitly. That is the
// whole difference between a control and a log line.
const { transaction } = require('./tx');
const audit = require('./audit');

/**
 * Record or update a reconciliation finding.
 *
 * Keyed by the thing that disagrees, not by timestamp, so repeated drift on
 * the same accounts UPDATES one open finding rather than creating a new one
 * every hour and burying the real signal in noise.
 */
function recordFinding(db, { scope, expected_cents, actual_cents, detail, source }) {
  const drift = actual_cents - expected_cents;
  const existing = db
    .prepare("SELECT * FROM reconciliation_findings WHERE scope = ? AND resolved_at IS NULL")
    .get(scope);
  if (existing) {
    db.prepare(
      'UPDATE reconciliation_findings SET expected_cents = ?, actual_cents = ?, drift_cents = ?, detail = ?, seen_at = datetime(\'now\'), seen_count = seen_count + 1 WHERE id = ?'
    ).run(expected_cents, actual_cents, drift, detail, existing.id);
    return { id: existing.id, drift_cents: drift, repeated: true };
  }
  const info = db
    .prepare(
      "INSERT INTO reconciliation_findings (scope, expected_cents, actual_cents, drift_cents, detail, source) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(scope, expected_cents, actual_cents, drift, detail, source);
  return { id: Number(info.lastInsertRowid), drift_cents: drift, repeated: false };
}

/** A finding is closed only by a human, with a reason. */
function resolveFinding(db, { actor, id, reason }) {
  if (!reason || String(reason).trim().length < 5) {
    throw Object.assign(new Error('A written reason is required to resolve a finding'), { status: 400 });
  }
  const row = db.prepare('SELECT * FROM reconciliation_findings WHERE id = ?').get(id);
  if (!row) throw Object.assign(new Error('Finding not found'), { status: 404 });
  if (row.resolved_at) return { id, already_resolved: true };
  db.prepare("UPDATE reconciliation_findings SET resolved_at = datetime('now'), resolved_by = ?, resolution = ? WHERE id = ?")
    .run(actor ? actor.id : null, String(reason).trim(), id);
  audit.record(db, actor, audit.ACTIONS.FINDING_RESOLVED, `reconciliation:${id}`,
    { open: true, drift_cents: row.drift_cents }, { open: false }, reason);
  return { id, resolved: true };
}

/**
 * One reconciliation pass.
 *
 * Checks the two things that actually matter for fund safety:
 *
 *   1. GLOBAL CONSERVATION — total debits must equal total credits. A non-zero
 *      drift here means the ledger itself is corrupt, which outranks every
 *      other finding.
 *   2. THE CACHE — users.balance_cents against the postings. Divergence here
 *      means every balance on screen is a lie, even though the ledger is right.
 *
 * Both are computed with `expected` set to the value that is true BY
 * CONSTRUCTION (0 for conservation), so a finding is a genuine disagreement
 * rather than two numbers being compared to each other.
 */
async function reconcileOnce(db) {
  const accounts = require('./accounts');
  const checks = [];

  const conserved = accounts.assertConserved(db);
  checks.push({
    scope: 'global_conservation',
    expected_cents: 0,
    actual_cents: conserved,
    detail: 'Total debits must equal total credits',
  });

  const divergent = accounts.assertUserAgrees(db);
  for (const d of divergent) {
    checks.push({
      scope: `user_balance:${d.user_id}`,
      expected_cents: d.balance_cents,
      actual_cents: d.postings_total,
      detail: `balance_cents ${d.balance_cents} vs postings ${d.postings_total}`,
    });
  }

  const findings = [];
  for (const c of checks) {
    if (c.expected_cents === c.actual_cents) continue;
    const f = transaction(db, () => recordFinding(db, { ...c, source: 'scheduled' }));
    findings.push({ ...c, ...f });
  }
  return {
    checked: checks.length,
    ok: findings.length === 0,
    findings,
    // Surfaces still open from earlier passes. Re-listed every run so a drift
    // cannot be ignored by simply not looking at the current run.
    open: db
      .prepare('SELECT id, scope, drift_cents, seen_count, first_seen, seen_at FROM reconciliation_findings WHERE resolved_at IS NULL ORDER BY ABS(drift_cents) DESC')
      .all(),
  };
}

/**
 * Run `fn` every `intervalMs`, without overlapping runs.
 *
 * The overlap guard is the important part. Reconciliation against a live PSP
 * is slow; if a run takes longer than the interval, a naive setInterval stacks
// runs until the process spends all its time reconciling. `running` makes a
 * slow pass SKIP the next tick instead, and the skip is counted so a
 * permanently-too-slow interval is visible rather than silent.
 */
function every(intervalMs, fn, { onError } = {}) {
  let running = false;
  let skipped = 0;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (running) { skipped++; return; }
    running = true;
    try {
      await fn();
    } catch (e) {
      if (onError) onError(e);
      else console.error('[job]', e);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  // A scheduled job must never hold the process open on its own.
  if (timer.unref) timer.unref();
  return {
    stop: () => { stopped = true; clearInterval(timer); },
    stats: () => ({ running, skipped, stopped }),
  };
}

module.exports = { recordFinding, resolveFinding, reconcileOnce, every };