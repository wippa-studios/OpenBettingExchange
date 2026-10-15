'use strict';
// lib/aml/thresholds.js — the $5,000 threshold, as a DURABLE OBLIGATION.
//
// ── WHY THIS IS NOT A RULE IN lib/aml/rules.js ─────────────────────────────
//
// Because it is not an indicator. Every rule in the rules table encodes published
// guidance about what looks SUSPICIOUS, and being suspicious is a judgement a
// human makes. Crossing the customer-due-diligence exemption threshold is a
// STATUTORY FACT with a REPORTING DUTY attached, and putting it in the same table
// would suggest the duty is discretionary — that a threshold crossing is
// something an analyst might decide not to act on. It is not.
//
// So the two live apart deliberately: rules produce findings for a person;
// thresholds produce obligations for the record.
//
// ── THE THRESHOLD, AND WHY IT IS CONFIGURATION ─────────────────────────────
//
// Since 31 March 2026 the customer-due-diligence exemption threshold for
// gambling providers dropped from under AUD 10,000 to under AUD 5,000. It is
// config.AML_THRESHOLD_CENTS rather than a constant for the reason every other
// monetary control in lib/config.js is: the operator is the one who knows their
// regulator's current position, and hard-coding a legal figure is the same
// mistake as hard-coding a PSP.
//
// ── A DUTY HAS TO SURVIVE THE PROCESS THAT NOTICED IT ──────────────────────
//
// A log line satisfies nothing. The whole point of a reporting duty is that it is
// still answerable months later by someone who was not here, and a line in a
// rotating log is not. So:
//
//   - each crossing is a ROW, keyed on the account and the window, and repeated
//     crossings UPDATE it and increment `seen_count` rather than opening a new one
//     every time — the same pattern-and-not-a-log argument lib/jobs.js makes for
//     reconciliation findings;
//   - it is re-listed on every read until a human DISCHARGES it with a written
//     reason, because an obligation nobody closed is an obligation nobody did;
//   - the `null` in `report_generated_at` on an old obligation is the single most
//     useful thing an operator can be shown, which is why the open list is sorted
//     with the oldest ungenerated first.
//
// ── TWO BASES, AND STRUCTURING IS THE POINT ─────────────────────────────────
//
//   'single'  — one transaction at or over the threshold.
//   'related' — several transactions that each sat UNDER it and together crossed
//              it. Structuring is exactly this, and a threshold that only looks
//              at individual amounts does not see it at all.
//
// The 'related' basis is a ROLLING WINDOW over the ledger's own deposit
// transactions, so it catches a pattern spread across a day rather than needing
// the customer to make one big transfer.
//
// ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
//
// It does not submit anything to AUSTRAC, or to anyone. This module GENERATES
// the data a report needs (lib/aml/reports.js) and records that the generation
// happened. Filing is the operator's act, through their own channel, and the
// `discharge` path takes their written reason for it. A repository that could
// file on their behalf would be making a legal submission in their name from code
// nobody reviewed with their regulator.
const { httpError } = require('../auth');
const { transaction } = require('../tx');
const config = require('../config');
const audit = require('../audit');

// The rolling window a 'related' basis aggregates over. 24 hours is the shortest
// window in which a person can plausibly make several transfers and still be
// describing one funding decision, and it is long enough to catch the obvious
// "six transfers just under the line" pattern.
const RELATED_WINDOW_HOURS = 24;

/**
 * Detect a threshold crossing and, if there is one, record the OBLIGATION.
 *
 * Called from the deposit CONFIRMATION path, not from a scheduled scan, for the
 * reason every control in this codebase that moves money is enforced where the
 * effect is rather than where it is announced: a check that runs before the
 * effect and consumes nothing is not a check on the effect. An intent is created
 * before the funds exist and therefore before there is a funded transaction to
 * aggregate.
 *
 * `basis` decides which question is asked, and BOTH are asked at confirmation —
 * a single large deposit and a run of small ones are different shapes of the same
 * duty and neither subsumes the other.
 */
function detect(db, { userId, intentId, amountCents, actor = null }) {
  // A PAPER-MONEY INSTALL HAS NO REPORTING DUTY.
  //
  // Raising a statutory threshold obligation against a synthetic faucet deposit
  // would put rows in an operator's regulatory queue that correspond to nothing,
  // and a queue that fills with noise is a queue nobody reads. Same reasoning as
  // the funding gate's header: the control needs something real to act on before
  // acting is the correct behaviour, not a failure to act.
  if (!config.REGULATED_DEPLOYMENT) return { threshold_cents: thresholdCents(), obligations: [], regulated: false };
  const threshold = thresholdCents();
  const raised = [];

  if (amountCents >= threshold) {
    // THE WINDOW'S START, and a fallback rather than a null.
    //
    // `window_from` is NOT NULL, because an obligation with no stated window
    // cannot be answered months later — which is the entire reason the row
    // exists. So when the intent row cannot be read (an operator re-running a
    // scan, a caller that has no intent id), the window starts NOW rather than
    // being left null. The first version read the intent and passed `null`
    // straight through, and a single missing row turned every deposit
    // confirmation into a 500 — a compliance control taking down the deposit path
    // it was supposed to annotate.
    const intentRow = intentId ? db.prepare('SELECT created_at FROM payment_intents WHERE id = ?').get(intentId) : null;
    const from = (intentRow && intentRow.created_at) || db.prepare("SELECT datetime('now') AS t").get().t;
    raised.push(
      recordObligation(db, {
        userId,
        basis: 'single',
        threshold,
        observed: amountCents,
        from,
        to: null,
        transactionIds: intentId ? [intentId] : [],
        detail: `A single deposit of ${amountCents} cents is at or over the ${threshold} cent threshold`,
        actor,
      })
    );
  }

  // The related basis. Aggregated over the ledger's deposit transactions, because
  // that is where a funded deposit becomes a fact — and because a window built
  // on intents would count deposits that never arrived.
  const from = db.prepare("SELECT datetime('now', ?) AS t").get(`-${RELATED_WINDOW_HOURS} hours`).t;
  const rows = db
    .prepare(
      `SELECT id, amount_cents, at FROM transactions
        WHERE user_id = ? AND type = 'deposit' AND at >= ? ORDER BY at`
    )
    .all(userId, from);
  const total = rows.reduce((s, r) => s + r.amount_cents, 0);
  // "Just under" is the shape: every individual amount BELOW the threshold and the
  // sum at or over it. A set that includes one over-threshold deposit is the
  // 'single' basis's job and reporting it twice would put two obligations on one
  // deposit.
  const allUnder = rows.every((r) => r.amount_cents < threshold);
  if (allUnder && rows.length >= 2 && total >= threshold) {
    raised.push(
      recordObligation(db, {
        userId,
        basis: 'related',
        threshold,
        observed: total,
        from,
        to: null,
        transactionIds: rows.map((r) => r.id),
        detail: `${rows.length} deposits totalling ${total} cents crossed the ${threshold} cent threshold together, none individually over it`,
        actor,
      })
    );
  }
  return { threshold_cents: threshold, obligations: raised };
}

/**
 * Record or update the obligation.
 *
 * Keyed on (user, basis) for the same reason reconciliation findings are keyed on
 * scope: a pattern that recurs must be ONE row an analyst reads, not a new row
 * every time it is noticed.
 */
function recordObligation(db, { userId, basis, threshold, observed, from, to, transactionIds, detail, actor }) {
  return transaction(db, () => {
    const existing = db
      .prepare("SELECT * FROM aml_threshold_obligations WHERE user_id = ? AND basis = ? AND discharged_at IS NULL")
      .get(userId, basis);
    if (existing) {
      db.prepare(
        `UPDATE aml_threshold_obligations
            SET threshold_cents = ?, observed_cents = ?, window_from = ?, window_to = ?,
                transaction_ids = ?, detail = ?, seen_at = datetime('now'), seen_count = seen_count + 1
          WHERE id = ?`
      ).run(threshold, observed, from, to, JSON.stringify(transactionIds || []), detail, existing.id);
      return { id: existing.id, basis, repeated: true };
    }
    const info = db
      .prepare(
        `INSERT INTO aml_threshold_obligations
           (user_id, basis, threshold_cents, observed_cents, window_from, window_to, transaction_ids, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(userId, basis, threshold, observed, from, to, JSON.stringify(transactionIds || []), detail);
    return { id: Number(info.lastInsertRowid), basis, repeated: false };
  });
}

function thresholdCents() {
  return Number(config.AML_THRESHOLD_CENTS);
}

/**
 * Every OPEN obligation, re-listed on every read.
 *
 * SORTED WITH THE OLDEST UNGENERATED FIRST, and that ordering is the point of
 * the report rather than a convenience: the question an operator opens this
 * screen to answer is "what is the oldest thing I still owe a report on?".
 */
function openObligations(db, { limit = 500 } = {}) {
  const rows = db
    .prepare(
      `SELECT o.id, o.user_id, o.basis, o.threshold_cents, o.observed_cents, o.window_from,
              o.window_to, o.transaction_ids, o.detail, o.report_reference, o.report_generated_at,
              o.first_seen, o.seen_at, o.seen_count, u.username
         FROM aml_threshold_obligations o
         JOIN users u ON u.id = o.user_id
        WHERE o.discharged_at IS NULL
        ORDER BY (o.report_generated_at IS NOT NULL), o.first_seen, o.id
        LIMIT ?`
    )
    .all(Math.min(Math.max(Number(limit) || 500, 1), 5000));
  return rows.map((r) => ({ ...r, transaction_ids: parseIds(r.transaction_ids) }));
}

/**
 * Discharge an obligation. A HUMAN, with a WRITTEN reason, or it stays.
 *
 * `report_reference` is the GENERATION reference from lib/aml/reports.js, not a
 * filing receipt, and the comment on the schema says why: this repository
 * generates reports and submits nothing, so accepting a string here could let an
 * operator mark a statutory duty discharged on the strength of a file nobody sent.
 * What they record is that the report was generated and what it was called; the
 * filing itself is their act and their written reason says so.
 */
function discharge(db, { actor, id, reportReference = null, reason }) {
  if (!reason || String(reason).trim().length < 5) {
    throw httpError(400, 'A written reason is required to discharge a threshold obligation');
  }
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM aml_threshold_obligations WHERE id = ?').get(id);
    if (!row) throw httpError(404, 'Threshold obligation not found');
    if (row.discharged_at) return { id, already_discharged: true };
    if (reportReference) {
      db.prepare('UPDATE aml_threshold_obligations SET report_reference = ?, report_generated_at = datetime(\'now\') WHERE id = ?')
        .run(String(reportReference).slice(0, 200), id);
    }
    db.prepare("UPDATE aml_threshold_obligations SET discharged_at = datetime('now'), discharged_by = ?, discharge_reason = ? WHERE id = ?")
      .run(actor ? actor.id : null, String(reason).trim(), id);
    audit.record(db, actor, audit.ACTIONS.AML_OBLIGATION_DISCHARGED, `aml_obligation:${id}`,
      { basis: row.basis, observed_cents: row.observed_cents, open: true },
      { open: false, report_reference: reportReference }, reason);
    return { id, discharged: true };
  });
}

/**
 * Scan the whole book for crossings that a deposit path did not reach.
 *
 * THE PASS THAT CATCHES WHAT THE GATE MISSED. `detect` runs at confirmation,
 * which is where the control belongs — but a book restored from a backup, a
 * database that predates the column, or a deposit made through an admin desk
 * will not have gone through it. A scheduled pass over the ledger makes the duty
 * answerable from the DATA rather than from the fact that a code path ran, which
 * is the difference between a control and a hope.
 *
 * Same cohort discipline as the rule scan: bounded, and the operator chooses it.
 */
function scanForCrossings(db, { windowDays = 30, limit = 2000 } = {}) {
  const threshold = thresholdCents();
  const cutoff = db.prepare("SELECT datetime('now', ?) AS t").get(`-${windowDays} days`).t;
  const accounts = db
    .prepare(
      `SELECT user_id, SUM(amount_cents) AS total, COUNT(*) AS n, MIN(at) AS first_at
         FROM transactions
        WHERE type = 'deposit' AND at >= ? AND user_id IN (SELECT id FROM users WHERE is_bot = 0)
        GROUP BY user_id
       HAVING SUM(amount_cents) >= ?
        ORDER BY total DESC
        LIMIT ?`
    )
    .all(cutoff, threshold, Math.min(Math.max(Number(limit) || 2000, 1), 100000));
  const found = [];
  for (const a of accounts) {
    const ids = db
      .prepare("SELECT id FROM transactions WHERE user_id = ? AND type = 'deposit' AND at >= ? ORDER BY at")
      .all(a.user_id, cutoff)
      .map((r) => r.id);
    found.push(
      recordObligation(db, {
        userId: a.user_id,
        basis: 'related',
        threshold,
        observed: a.total,
        from: cutoff,
        to: null,
        transactionIds: ids,
        detail: `Ledger scan: ${a.n} deposits totalling ${a.total} cents in ${windowDays} days`,
        actor: null,
      })
    );
  }
  return { window_days: windowDays, threshold_cents: threshold, obligations: found.length };
}

/** The threshold as the venue runs it, for the operator surface and the reports. */
function policy() {
  return {
    threshold_cents: thresholdCents(),
    currency: config.VENUE_CURRENCY,
    related_window_hours: RELATED_WINDOW_HOURS,
    effective_from: '2026-03-31',
    note:
      'AUD 5,000 from 31 March 2026; AUD 10,000 before that. CONFIG, because the operator holds ' +
      'the licence and knows their regulator\'s current position — hard-coding a legal figure is ' +
      'the same mistake as hard-coding a PSP.',
    restricted_jurisdictions_configured: config.AML_RESTRICTED_JURISDICTIONS.length,
  };
}

function parseIds(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

module.exports = {
  RELATED_WINDOW_HOURS,
  detect,
  recordObligation,
  openObligations,
  discharge,
  scanForCrossings,
  thresholdCents,
  policy,
};