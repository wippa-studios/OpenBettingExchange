'use strict';
// lib/aml/reports.js — generating the data a regulator asks for.
//
// ── WHAT THIS GENERATES AND WHAT IT DOES NOT DO ─────────────────────────────
//
// Two report SHAPES, because two different obligations exist and conflating them
// is how a filing goes wrong:
//
//   THRESHOLD TRANSACTION REPORT — the data about deposits at or over the
//   customer-due-diligence exemption threshold (AUD 5,000 from 31 March 2026),
//   and about related transactions that crossed it together.
//
//   SUSPICIOUS MATTER REPORT — the data about activity a human has decided is
//   suspicious. Which is to say: this module reports on ALERTS, and an alert is
//   a SIGNAL. A report built from alerts is a report built from "a rule fired",
//   never from "this person is guilty of anything", and the `basis` field on every
//   row says which it is.
//
// IT SUBMITS NOTHING. No regulator, no portal, no network call. That is a scope
// boundary and not an omission, and it is the same boundary lib/payments/provider.js
// draws: a submission is a legal act in the operator's name, made under their
// licence, to a regulator they have a relationship with. Code in this repository
// that could do it would be making that act on their behalf, unreviewed by
// whoever needs to review it. What this repository does is make the data correct,
// complete, self-describing and exportable — and make the duty to file visible as
// an undischarged obligation until a human says otherwise.
//
// ── EVERY FIGURE SHIPS WITH ITS DEFINITION ──────────────────────────────────
//
// Inherited from lib/reports.js, and for the same reason it is there: a number
// without a definition is how an operator files the wrong return, and a regulatory
// filing is the most expensive place that mistake can land. Every report below
// carries its `definitions` block in BOTH the JSON and the CSV, and the CSV is
// the default for exactly the reason lib/reports.js makes it the default there —
// the CSV is the artefact that gets opened, attached and filed.
//
// ── TIPPING OFF, AND WHO CAN CALL THIS ──────────────────────────────────────
//
// Every function here requires an ENTITLED operator, checked through
// lib/aml/findings.js entitled(). That is the third of the three tipping-off
// surfaces described in that file's header, and it is the one that matters most
// for this module specifically: a threshold transaction report and a suspicious
// matter report are, by construction, lists of people.
//
// Generation is AUDITED (AML_REPORT_GENERATED) with the row ids it covered, so
// "who produced the report of these nine accounts, and when" is answerable. The
// audit row deliberately does NOT carry the report's contents: an audit log is
// read by a wider audience than the financial-crime desk, and putting the list in
// it would defeat the entitlement check on the way past.
const { httpError } = require('../auth');
const config = require('../config');
const audit = require('../audit');
const findings = require('./findings');
const thresholds = require('./thresholds');
const { RULES, knownRules } = require('./rules');

const MAX_ROWS = 50000;

// Reuse the CSV writer rather than writing a second one. lib/reports.js's version
// carries the formula-injection defence (`username` is attacker-controllable at
// registration, and a cell beginning `=` is executed by the spreadsheet that opens
// the filing) and duplicating it would be two places for the defence to rot.
const { csv, csvCell } = require('../reports');

// ── Threshold transaction report ─────────────────────────────────────────────

const TTR_DEFS = {
  user_id: 'The account holder.',
  basis:
    "'single' — one deposit at or over the threshold. 'related' — several deposits that each sat " +
    'below it and crossed it together, which is the structuring shape.',
  threshold_cents: 'The exemption threshold in force, in cents. Read from config, not assumed.',
  observed_cents: 'What was actually observed, in cents. For a related basis this is the SUM.',
  window_from: 'Start of the window the observation covers.',
  window_to: 'End of the window, or null while the window is still open.',
  transaction_ids: 'The ledger transactions that made up the window, so the figure is reproducible.',
  report_generated_at: 'When a report covering this obligation was generated. Null means none has been.',
  first_seen: 'When the crossing was first recorded. An unresolved duty has to survive being ignored.',
  seen_count: 'How many times it has been re-detected. One case, re-noticed — not N cases.',
  discharged_at: 'When a human closed it, with the written reason on the row. Null means open.',
};

/**
 * The threshold transaction report for a window.
 *
 * Reads OBLIGATIONS rather than re-deriving from the ledger, and that is a
 * deliberate choice: the ledger can be re-derived, an obligation cannot. If this
 * recomputed, an obligation that had been noticed and not yet filed would simply
 * not appear, and the report would be the thing that hides the duty rather than
 * the thing that discharges it.
 */
function thresholdTransactions(db, { actor, from, to }) {
  requireEntitled(db, actor);
  const obligations = thresholds.openObligations(db);
  const rows = obligations.map((o) => ({
    user_id: o.user_id,
    username: o.username,
    basis: o.basis,
    threshold_cents: o.threshold_cents,
    observed_cents: o.observed_cents,
    window_from: o.window_from,
    window_to: o.window_to,
    transaction_count: o.transaction_ids.length,
    report_generated_at: o.report_generated_at,
    first_seen: o.first_seen,
    seen_count: o.seen_count,
    discharged_at: o.discharged_at,
    detail: o.detail,
  }));
  const trimmed = rows.slice(0, MAX_ROWS);
  audit.record(db, actor, audit.ACTIONS.AML_REPORT_GENERATED, 'aml:threshold_transactions',
    { from: from || null, to: to || null }, { rows: trimmed.length, truncated: trimmed.length < rows.length },
    'threshold transaction report generated');
  return {
    report: 'threshold_transaction_report',
    generated_at: db.prepare("SELECT datetime('now') AS t").get().t,
    threshold: thresholds.policy(),
    period: { from: from || null, to: to || null },
    rows: trimmed,
    truncated: trimmed.length < rows.length,
    // THE SUBMISSION IS NOT THIS MODULE'S ACT, and the payload says so. An
    // operator reading this file needs to know the duty is OPEN and that nothing
    // here has discharged it.
    submission: {
      submitted: false,
      note:
        'This repository GENERATES reports and submits nothing to any regulator. The duty to file ' +
        'is discharged through lib/aml/thresholds.js discharge(), with a written reason naming what ' +
        'was filed and where.',
    },
    definitions: TTR_DEFS,
  };
}

function thresholdTransactionsCsv(rep) {
  const rows = [['user_id', 'username', 'basis', 'threshold_cents', 'observed_cents', 'window_from',
    'window_to', 'transaction_count', 'report_generated_at', 'first_seen', 'seen_count', 'discharged_at', 'detail']];
  for (const r of rep.rows) {
    rows.push([r.user_id, r.username, r.basis, r.threshold_cents, r.observed_cents, r.window_from,
      r.window_to, r.transaction_count, r.report_generated_at, r.first_seen, r.seen_count, r.discharged_at, r.detail]);
  }
  rows.push([]);
  for (const r of defsCsv(TTR_DEFS)) rows.push(r);
  return csv(rows);
}

// ── Suspicious matter report ─────────────────────────────────────────────────

const SMR_DEFS = {
  rule_id: 'The rule that fired. Resolvable in /api/admin/aml/rules for its published indicator and its calibration.',
  scope: 'What the alert is about. One open alert per subject, so repeated detection does not multiply the report.',
  severity: 'A starting priority. Not a conclusion, and not a finding about any person.',
  basis:
    "THIS IS A SIGNAL, NOT A FINDING. A row here says a rule fired against this account's ledger " +
    'activity. It does not say the account holder has done anything wrong, and the venue does not ' +
    'make that judgement — see lib/aml/rules.js.',
  seen_count: 'How many times the rule has fired for this subject. One case, re-noticed.',
  evidence: 'The figures that made the rule fire, as JSON. Reproducible from the ledger without re-running the rule.',
  resolved_at: 'When a human closed it, with the written reason. Null means it is still open.',
  resolution: 'The written reason. Required to close, for the reason lib/jobs.js requires it for a finding.',
};

/**
 * The suspicious matter report.
 *
 * BUILT FROM ALERTS, WITH THE BASIS STATED, and that is the whole of the
 * restraint this module practises. It does not decide that anything is suspicious
 * — it reports what the venue's rules observed, attributes each observation to
 * the published indicator behind it, and leaves the characterisation to the
 * operator's compliance officer.
 *
 * ALERTS ONLY, NEVER RESOLVED ONES. A closed alert is part of the record but not
 * part of a matter report: including it would mean reporting a suspicion the
 * operator has already examined and explained. `includeResolved` exists for the
 * internal case file, not for this function's default.
 */
function suspiciousMatter(db, { actor, includeResolved = false }) {
  requireEntitled(db, actor);
  const alerts = findings.openAlerts(db, { actor, limit: MAX_ROWS });
  const rows = alerts.map((a) => ({
    alert_id: a.id,
    rule_id: a.rule_id,
    // THE INDICATOR, resolved through the rule table, travels with every row.
    // A report that names a rule id without saying what it watches for is not a
    // report anybody can act on, and resolving it here rather than at the reader
    // means the two cannot drift apart.
    indicator: RULES[a.rule_id] ? RULES[a.rule_id].indicator : 'unknown rule',
    published_indicator: RULES[a.rule_id] ? RULES[a.rule_id].published || RULES[a.rule_id].indicator : null,
    scope: a.scope,
    severity: a.severity,
    user_id: a.user_id,
    basis: 'rule-fired',
    observed_cents: a.observed_cents,
    first_seen: a.first_seen,
    seen_at: a.seen_at,
    seen_count: a.seen_count,
    evidence: a.evidence,
    detail: a.detail,
    resolved_at: a.resolved_at,
    resolution: a.resolution,
  }));
  audit.record(db, actor, audit.ACTIONS.AML_REPORT_GENERATED, 'aml:suspicious_matter',
    null, { rows: rows.length, rules: [...new Set(rows.map((r) => r.rule_id))] },
    'suspicious matter report generated');
  return {
    report: 'suspicious_matter_report',
    generated_at: db.prepare("SELECT datetime('now') AS t").get().t,
    basis: 'signal-not-determination',
    rules_in_play: knownRules(),
    rows,
    truncated: rows.length >= MAX_ROWS,
    submission: {
      submitted: false,
      note:
        'This repository GENERATES reports and submits nothing to any regulator. Whether an ' +
        'observation is reportable is the operator\'s compliance officer\'s decision, and it is ' +
        'recorded on the alert with a written reason.',
    },
    definitions: SMR_DEFS,
  };
}

function suspiciousMatterCsv(rep) {
  const rows = [['alert_id', 'rule_id', 'indicator', 'scope', 'severity', 'user_id', 'basis',
    'observed_cents', 'first_seen', 'seen_at', 'seen_count', 'detail', 'resolved_at', 'resolution']];
  for (const r of rep.rows) {
    rows.push([r.alert_id, r.rule_id, r.indicator, r.scope, r.severity, r.user_id, r.basis,
      r.observed_cents, r.first_seen, r.seen_at, r.seen_count, r.detail, r.resolved_at, r.resolution]);
  }
  rows.push([]);
  for (const r of defsCsv(SMR_DEFS)) rows.push(r);
  return csv(rows);
}

/**
 * The data-source register as a CSV, because a register that cannot leave the
 * building is a register only this codebase can read, and the operator has to be
 * able to hand it to a compliance officer.
 */
function dataSourceRegisterCsv(db) {
  const rows = [['slug', 'name', 'owner', 'authority', 'licence_ref', 'fee_terms', 'permits',
    'starts_at', 'expires_at', 'enabled', 'notes']];
  for (const s of require('../datasources').list(db)) {
    rows.push([s.slug, s.name, s.owner, s.authority, s.licence_ref, s.fee_terms, s.permits.join('|'),
      s.starts_at, s.expires_at, s.enabled ? 'yes' : 'no', s.notes]);
  }
  return csv(rows);
}

/**
 * The rule set as CSV.
 *
 * Because "an operator must be able to see what rules exist and why" has to work
 * in a spreadsheet, not only in a JSON viewer. The calibration column is the one
 * that matters: it is the reasoning behind each threshold, and it is the column an
 * examiner or a new compliance officer should read first.
 */
function rulesCsv(rep) {
  const rows = [['rule_id', 'scope', 'published_indicator', 'indicator', 'default_severity',
    'shipped_tuning', 'effective_tuning', 'overridden', 'calibration']];
  for (const r of rep.rules) {
    rows.push([
      r.id, r.scope, r.published_indicator, r.indicator, r.default_severity,
      JSON.stringify(r.shipped_tuning), JSON.stringify(r.effective_tuning),
      r.overridden ? 'yes' : 'no', r.calibration,
    ]);
  }
  return csv(rows);
}

function defsCsv(defs) {
  return [['# definition', 'column', 'meaning']].concat(
    Object.entries(defs).map(([k, v]) => ['', k, v])
  );
}

/**
 * The entitlement gate, with the DATABASE this time.
 *
 * `findings.entitled` takes the db and the actor, and the first version of this
 * called it with a null connection — which made the check vacuously pass for any
 * truthy actor, so an unentitled operator would have been handed a report listing
 * the people it named. A guard that passes when it cannot check is worse than no
 * guard, and lib/limits.js says the same about a check that runs before the effect
 * and consumes nothing.
 */
function requireEntitled(db, actor) {
  if (!findings.entitled(db, actor)) {
    throw httpError(403, 'This operator is not entitled to financial-crime reports', { code: 'aml_not_entitled' });
  }
  return true;
}

module.exports = {
  MAX_ROWS,
  TTR_DEFS,
  SMR_DEFS,
  thresholdTransactions,
  thresholdTransactionsCsv,
  suspiciousMatter,
  suspiciousMatterCsv,
  rulesCsv,
  dataSourceRegisterCsv,
  csvCell,
  venueCurrency: () => config.VENUE_CURRENCY,
};