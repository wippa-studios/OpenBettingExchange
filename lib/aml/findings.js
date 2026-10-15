'use strict';
// lib/aml/findings.js — AML/CTF ALERTS as persistent findings.
//
// ── WHY THIS TABLE EXISTS RATHER THAN REUSING reconciliation_findings ───────
//
// It is tempting to say "reconciliation_findings is already the pattern, reuse
// it" and to reach for it. Read its schema first (lib/store.js):
//
//   expected_cents INTEGER NOT NULL,
//   actual_cents   INTEGER NOT NULL,
//   drift_cents    INTEGER NOT NULL
//
// Every column is a MONEY DISAGREEMENT and all three are NOT NULL. An AML alert
// is not a money disagreement: "this account placed nine bets in four minutes on
// one selection and won" has no expected figure, no actual figure and no drift,
// and forcing it into those columns would mean writing zeros — a fabricated
// financial claim on every alert, in the one table an operator is taught to read
// as factual. That is a worse defect than a second table.
//
// There are two further reasons, and both are structural rather than cosmetic:
//
//   1. RETENTION. Financial-crime records are kept for years; the trade tape's
//      retention policy is 30 days and the question "may a generic prune touch
//      this?" has to have one unambiguous answer per table (lib/retention.js).
//      Sharing a table shares an answer, and the two records have opposite ones.
//
//   2. AUDIENCE. reconciliation_findings is surfaced on the operations dashboard
//      to whoever runs the venue. AML alerts are financial-crime material and
//      tipping off — a criminal offence in Australia — is a question of WHO may
//      read a row, so the two populations cannot live in one table that one
//      query returns to both. See `entitled()` below.
//
// So the PATTERN is reused deliberately and the TABLE is not. The pattern, which
// is the whole of what lib/jobs.js argues for:
//
//   - keyed by the thing that disagrees, so repeated activity UPDATES one open
//     alert rather than burying the signal under a row per scan;
//   - `seen_count` and `seen_at`, so an operator can see a pattern that has been
//     re-detected rather than a single moment;
//   - resolved ONLY by a human, with a WRITTEN reason, and never by a machine
//     and never by the passage of time;
//   - an unresolved alert is re-listed on every read, so it cannot be made to
//     disappear by not looking.
//
// ── TIPPING OFF, AND THE AUDIENCES THIS MODULE KEEPS APART ─────────────────
//
// Section 261 of the Criminal Code (reckless disclosure of financial-crime
// information) makes it an offence to disclose that a person is the subject of a
// suspicious-matter investigation, and the exposure runs to staff who are NOT
// ENTITLED TO KNOW as well as to the customer. Three surfaces follow from that,
// and all three are in this file or in its callers:
//
//   1. THE CUSTOMER NEVER GETS A ROW. `lib/identity`'s player-facing
//      `/api/identity/me` reads `users.identity_status` and the verification
//      decision ONLY. It never calls anything in this module, and the gate
//      refusal it returns names the next action ("complete verification"), never
//      the reason a case exists.
//
//   2. STAFF GET A ROW ONLY IF THEY ARE ENTITLED. `entitled()` requires a row in
//      `aml_entitlements`. The WHO is the operator's compliance officer's call,
//      not ours — so the deliverable is the MECHANISM and the table, and it ships
//      EMPTY. An empty table means nobody is entitled, which means the surfaces
//      return nothing. That is the right default and it is the same reasoning
//      lib/config.js uses for FEED_CREDENTIALS_KEY: "not configured" is refused,
//      not treated as "allowed".
//
//   3. RESOLUTION AND EXPORT ARE AUDITED; A BULK LIST READ IS NOT, and that is a
//      deliberate accepted limitation rather than an oversight. Every
//      close-with-a-reason is an audit row, and every report generation is an
//      audit row, because those are the acts that matter. Auditing each row of
//      each list read would write an audit row per alert per dashboard poll,
//      which is a volume problem that gets solved by turning the audit off.
//
// WHAT IS DELIBERATELY ABSENT: an automatic expiry. Nothing in this file ages an
// alert out. A financial-crime record that disappears on a timer is the failure
// mode the whole reconciliation pattern exists to prevent, and the one thing this
// module is not allowed to do is introduce a second, quieter one.
const { transaction } = require('../tx');
const audit = require('../audit');

/**
 * A stable scope string for one alert.
 *
 * Keyed on the SUBJECT rather than on the moment, which is what makes repeated
 * detection update one row (see the header). The subject is the thing an
 * investigator would ask about: who, what, and — for the cross-account rules —
 * which pair.
 *
 * `ref` is optional and is how a relationship rule keys itself. Two accounts
 * linked by a shared device produce one scope, not two, so the second account's
 * detection increments the first's `seen_count` instead of opening a case an
 * analyst would immediately merge.
 */
function alertScope(ruleId, subject, ref) {
  const base = `${ruleId}:${subject}`;
  return ref ? `${base}:${ref}` : base;
}

/**
 * Record or update an alert.
 *
 * Mirrors jobs.recordFinding exactly, including the update-in-place branch, and
 * for the same reason: an alert that re-fires every scan and opens a new row
 * each time is noise, and noise is how a monitoring system gets switched off.
 *
 * `evidence` is JSON and is the answer to "what would this rule have caught?".
 * Every figure that made the rule fire travels with the alert, so an analyst
 * never has to re-run a query to find out what the machine saw — and so a
 * calibration argument ("this fired on 400 accounts, 390 of them because the
 * price floor is 1.20") can be settled with evidence rather than opinion.
 */
function recordAlert(db, { rule_id, scope, severity = 'medium', user_id = null, detail, evidence = null, observed_cents = null, source = 'scheduled' }) {
  if (!rule_id) throw new Error('aml: an alert needs a rule_id');
  if (!scope) throw new Error('aml: an alert needs a scope');
  const existing = db
    .prepare('SELECT * FROM aml_alerts WHERE scope = ? AND resolved_at IS NULL')
    .get(scope);
  if (existing) {
    db.prepare(
      `UPDATE aml_alerts
          SET severity = ?, detail = ?, evidence = ?, observed_cents = ?,
              seen_at = datetime('now'), seen_count = seen_count + 1
        WHERE id = ?`
    ).run(severity, detail || null, evidence === null ? existing.evidence : JSON.stringify(evidence), observed_cents, existing.id);
    return { id: existing.id, repeated: true, seen_count: existing.seen_count + 1 };
  }
  const info = db
    .prepare(
      `INSERT INTO aml_alerts (rule_id, scope, severity, user_id, detail, evidence, observed_cents, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(rule_id, scope, severity, user_id, detail || null, evidence === null ? null : JSON.stringify(evidence), observed_cents, source);
  return { id: Number(info.lastInsertRowid), repeated: false, seen_count: 1 };
}

/**
 * Close an alert. A HUMAN, with a WRITTEN reason, or it does not close.
 *
 * The five-character floor is not a formatting rule, it is the difference
 * between a record and a click. lib/jobs.js already draws this line for
 * reconciliation findings and the reasoning has not changed: the reason is what
 * an examiner reads months later, and "ok" or "fixed" records that someone
 * decided the answer was worth recording.
 *
 * Deliberately NOT idempotent-with-no-op on an already-closed alert... actually
 * it IS idempotent, and that is deliberate: a double-click on the resolve button
 * by an analyst who is certain must not 409 and leave them unsure whether the
 * case is closed. It reports `already_resolved` instead, which is honest.
 */
function resolveAlert(db, { actor, id, reason }) {
  if (!reason || String(reason).trim().length < 5) {
    throw Object.assign(new Error('A written reason is required to resolve an alert'), { status: 400 });
  }
  const row = db.prepare('SELECT * FROM aml_alerts WHERE id = ?').get(id);
  if (!row) throw Object.assign(new Error('Alert not found'), { status: 404 });
  if (row.resolved_at) return { id, already_resolved: true };
  db.prepare("UPDATE aml_alerts SET resolved_at = datetime('now'), resolved_by = ?, resolution = ? WHERE id = ?")
    .run(actor ? actor.id : null, String(reason).trim(), id);
  audit.record(db, actor, audit.ACTIONS.AML_ALERT_RESOLVED, `aml_alert:${id}`,
    { open: true, rule_id: row.rule_id, severity: row.severity },
    { open: false }, reason);
  return { id, resolved: true };
}

/**
 * Every OPEN alert, re-listed on every read.
 *
 * The re-listing is the pattern's whole point (see the header): an unresolved
 * alert has to survive being ignored, and the only way it does is if it is on
 * every page rather than on the page for the day it was detected.
 *
 * Requires entitlement. See the header — this is surface 2 of the three
 * tipping-off defences, and it is the one that keeps the material out of the
 * hands of staff who are not entitled to know.
 */
function openAlerts(db, { actor, limit = 200 } = {}) {
  if (!entitled(db, actor)) {
    throw Object.assign(
      new Error('This operator is not entitled to view financial-crime alerts'),
      { status: 403, details: { code: 'aml_not_entitled' } }
    );
  }
  const rows = db
    .prepare(
      `SELECT id, rule_id, scope, severity, user_id, detail, evidence, observed_cents,
              first_seen, seen_at, seen_count
         FROM aml_alerts
        WHERE resolved_at IS NULL
        ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id
        LIMIT ?`
    )
    .all(Math.min(Math.max(Number(limit) || 200, 1), 1000));
  return rows.map((r) => ({
    ...r,
    evidence: r.evidence ? JSON.parse(r.evidence) : null,
  }));
}

/** One alert, for the case file view. Entitled callers only. */
function alertById(db, { actor, id }) {
  if (!entitled(db, actor)) {
    throw Object.assign(
      new Error('This operator is not entitled to view financial-crime alerts'),
      { status: 403, details: { code: 'aml_not_entitled' } }
    );
  }
  const r = db.prepare('SELECT * FROM aml_alerts WHERE id = ?').get(id);
  if (!r) return null;
  return { ...r, evidence: r.evidence ? JSON.parse(r.evidence) : null };
}

/**
 * Is this operator entitled to financial-crime material?
 *
 * A row in `aml_entitlements` and nothing else. Deliberately NOT derived from
 * `users.role`: 'admin' is the venue's general operator role and is held by
 * whoever runs the trading desk, the content desk and the support desk. Whether
 * any of those people may read a suspicious-matter file is a question about a
 * specific person, a specific jurisdiction and a specific regulator's
 * expectations, and guessing at it in code would be exactly the kind of legal
 * judgement this module refuses to make.
 *
 * SHIPS EMPTY. An operator going live populates it, which is a deliberate
 * audited act (see lib/admin.js's grant path in server.js). Until then nobody is
 * entitled, which means the surfaces refuse rather than leak.
 */
function entitled(db, actor) {
  if (!actor || !actor.id) return false;
  return !!db.prepare('SELECT 1 FROM aml_entitlements WHERE user_id = ?').get(actor.id);
}

/** Grant or revoke the entitlement. An audited, reasoned operator action. */
function setEntitlement(db, { actor, userId, entitled: isEntitled, reason }) {
  if (!reason || String(reason).trim().length < 5) {
    throw Object.assign(new Error('A written reason is required'), { status: 400 });
  }
  return transaction(db, () => {
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!u) throw Object.assign(new Error('User not found'), { status: 404 });
    if (isEntitled) {
      db.prepare('INSERT INTO aml_entitlements (user_id, granted_by, reason) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET granted_by = excluded.granted_by, reason = excluded.reason, granted_at = datetime(\'now\')')
        .run(userId, actor ? actor.id : null, String(reason).trim());
    } else {
      db.prepare('DELETE FROM aml_entitlements WHERE user_id = ?').run(userId);
    }
    audit.record(db, actor, audit.ACTIONS.AML_ENTITLEMENT_CHANGED, `user:${userId}`,
      null, { entitled: !!isEntitled }, reason);
    return { user_id: userId, entitled: !!isEntitled };
  });
}

module.exports = {
  alertScope,
  recordAlert,
  resolveAlert,
  openAlerts,
  alertById,
  entitled,
  setEntitlement,
};