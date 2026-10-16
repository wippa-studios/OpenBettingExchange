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

/**
 * ONE AML MONITORING PASS.
 *
 * A ROUTE IS NOT A CONTROL, and that is the whole argument for this function
 * existing separately from `POST /api/admin/aml/scan`. The same reasoning
 * `reconcileOnce` gives for reconciliation applies exactly: a report nobody runs
 * is not a control. A rule set that only fires when an operator remembers to
 * press a button is a rule set that does not fire, and the difference is
 * invisible from inside the code — every assertion passes and no alert is ever
 * raised.
 *
 * SO WHAT A PASS DOES, and what it deliberately does not:
 *
 *   - runs the declarative rule set over a BOUNDED cohort (the most recently
 *     active accounts, capped), because node:sqlite is synchronous and an
 *     unbounded scan over a real book is an outage;
 *   - records what fired as PERSISTENT FINDINGS, so a pattern re-detected is one
 *     case an analyst reads rather than one row per scan;
 *   - sweeps the ledger for threshold crossings a deposit path never reached,
 *     which is what makes the reporting duty answerable from the DATA rather than
 *     from the fact that a particular code path ran;
 *   - reports what it did, including any rule that THREW, because a rule that has
 *     stopped watching is the failure nobody sees.
 *
 * IT BLOCKS NOTHING. There is no suspension, no closure and no limit anywhere in
 * this path, and that is a design property rather than a missing feature:
 * "is this activity suspicious" is a legal judgement this codebase refuses to
 * make on the operator's behalf.
 *
 * Returns a summary rather than throwing. A monitoring pass that aborts on the
 * first error watches nothing after the first bad night, so every rule is
 * isolated and a broken one is reported as a failure rather than swallowed.
 */
function amlPass(db, { limit = 200, windowDays = 30 } = {}) {
  const engine = require('./aml/engine');
  const thresholds = require('./aml/thresholds');
  const config = require('./config');

  // OFF IS OFF, and says so in the return value rather than in a log line an
  // operator has to know to read. A monitoring system which is off and unannounced
  // reads as one which is on and quiet.
  if (!config.AML_MONITORING_ENABLED) {
    return { enabled: false, scanned: 0, raised: 0, failed_rules: [], obligations: 0, note: 'AML_MONITORING_ENABLED is false — no rule is running.' };
  }

  const scan = engine.scan(db, { limit, actor: null });
  // The ledger sweep is separate from the rule scan on purpose: it is the pass
  // that catches what the DEPOSIT PATH missed, and a database restored from a
  // backup or funded through the admin desk never went through that path.
  const obligations = thresholds.scanForCrossings(db, { windowDays });
  return {
    enabled: true,
    scanned: scan.scanned,
    raised: scan.raised,
    // Reported, never hidden. A rule that throws on every pass is a rule that has
    // stopped watching, and this is the only place that becomes visible.
    failed_rules: scan.failed_rules,
    obligations: obligations.obligations,
    threshold_cents: thresholds.thresholdCents(),
  };
}

module.exports = { recordFinding, resolveFinding, reconcileOnce, every, amlPass };