'use strict';
// lib/retention.js — WHICH TABLES MAY BE DELETED, AND WHY THE ANSWER IS A LIST.
//
// ── THE PROBLEM THIS EXISTS TO PREVENT ─────────────────────────────────────
//
// lib/marketdata.js prunes the trade tape to a 30-day window, and it is the only
// pruner in the codebase today. That is fine while the only prunable thing in the
// database is a chart series.
//
// It stops being fine the moment a venue stores financial-crime records. A
// generic retention job that does not know what a table IS will happily delete an
// alert row, an unresolved threshold obligation, or a verification record — and
// the deletion is invisible. There is no row left saying "this was deleted by the
// retention job", no finding, no log. The regulator's question ("show me the alert
// you raised on this customer in March") is answered by a table that no longer
// contains March.
//
// That is the same failure mode this repository keeps finding, in a new costume: a
// control that is fully instrumented and enforced nowhere.
//
// ── SO THE ANSWER IS A LIST, AND IT IS DECLARATIVE ──────────────────────────
//
// `PROTECTED_TABLES` is the list, and every consumer of it is mechanical:
//
//   - lib/aml and lib/identity cite it;
//   - /api/admin/retention reports it, so an operator can SEE which tables are
//     financial-crime records before they write a job against this database;
//   - tests/retention.test.js reads every `DELETE FROM <table>` in lib/ and
//     asserts no protected table appears in one — which is the check that catches
//     the failure above the moment somebody writes the generic pruner, rather
//     than after a regulator asks.
//
// A list rather than a naming convention (`aml_*`, `identity_*`) because a
// convention is a promise about names, and a table whose name does not match its
// classification is exactly the one that gets deleted. A table that IS financial
// -crime material and is not on this list is a documentation failure, and
// docs/ROADMAP.md tracks it; a table that is NOT and is on the list is merely
// keeping more data than it needs to, which is the safe direction to be wrong in.
//
// ── AND THE ONE TABLE THAT IS THE OPPOSITE ──────────────────────────────────
//
// `age_assurance` is EXPLICITLY NOT PROTECTED, and the tension is the whole point.
//
// Age assurance is personal information collected to prove a person is over 18,
// and the reform bill's explanatory memorandum provides that it must be DESTROYED
// once used absent elevated consent. It is therefore the one record in this schema
// that a retention job must NOT keep — and it is also, structurally, the record
// that looks most like financial-crime material, because it sits beside the
// identity record and is referenced by an audited action.
//
// If the default for "looks like compliance data" were "keep it", this row would
// be kept forever by an operator who was being careful. So the exemption is
// EXPLICIT and it is asserted from both sides in the test: no protected table
// appears in a DELETE, and `age_assurance` is not on the protected list.
//
// ── WHY THERE IS NO PRUNER FOR ANYTHING HERE ────────────────────────────────
//
// Deliberately. lib/marketdata.js prunes because a chart series has a reader whose
// need expires; these records have readers whose need does not. Writing a pruner
// for financial-crime tables would be writing the defect this module exists to
// prevent — the mechanism by which a compliance record quietly disappears.
//
// What exists instead is ERASURE, and it is narrow, per-record, reasoned and
// audited: lib/identity's eraseAgeAssurance nulls the personal information and
// stamps `erased_at`. That is a decision about ONE person on ONE record with a
// NAME against it. A retention job is a decision about EVERYONE with no name
// against it. Those are different acts and only one of them is ever appropriate.
const { httpError } = require('./auth');

// ── The list ─────────────────────────────────────────────────────────────────
//
// A REASON PER TABLE, and that is the part that matters. A bare list of names is
// a list nobody can extend correctly, and the next contributor's question —
// "does my new table belong here?" — has to be answerable without asking the last
// contributor.
const PROTECTED_TABLES = [
  {
    table: 'aml_alerts',
    why:
      'A suspicious-activity finding. The duty to hold it outlives any retention policy an operator ' +
      'sets for its operational data, and an unresolved one has to survive being ignored — that is ' +
      'the entire design of the findings pattern.',
    retention: 'per the operator\'s AML/CTF policy and their regulator\'s requirements',
    prunable: false,
  },
  {
    table: 'aml_threshold_obligations',
    why:
      'The record of a REPORTING DUTY. A discharged duty is evidence that a statutory obligation was ' +
      'met, and an undischarged one is a thing still owed. Neither is an operational record.',
    retention: 'at least as long as the filing and the period a regulator may ask about it',
    prunable: false,
  },
  {
    table: 'aml_rule_thresholds',
    why:
      'The operator\'s calibration of a financial-crime control. It is the evidence for "was this ' +
      'threshold reasonable when it fired", which is a question asked about a past detection.',
    retention: 'as long as the alerts raised under it',
    prunable: false,
  },
  {
    table: 'aml_entitlements',
    why:
      'Who was permitted to read financial-crime material, and on whose authority. Deleting the ' +
      'grant destroys the evidence that the person who read a case file was allowed to.',
    retention: 'as long as the material that was read',
    prunable: false,
  },
  {
    table: 'identity_verifications',
    why:
      'The identity record, including the constituent checks that produced the decision. This is ' +
      'the evidence behind a KYC decision a customer may dispute months later.',
    retention: 'the operator\'s AML/CTF policy',
    prunable: false,
  },
  {
    table: 'funding_instruments',
    why:
      'The register that makes third-party funding detectable. Without it there is no baseline to ' +
      'compare a payer name against, which is the whole control.',
    retention: 'as long as any deposit was funded through it',
    prunable: false,
  },
  {
    table: 'payment_methods',
    why:
      'The record of the TERMS under which the venue was permitted to use a payment provider — ' +
      'approved-seller status and the countries it is approved for. That is a compliance fact about ' +
      'a contract, not a configuration preference.',
    retention: 'as long as any deposit was taken through it',
    prunable: false,
  },
  {
    table: 'data_sources',
    why:
      'The licence and approval register. A settlement months after the fact is defended by what the ' +
      'venue held at the time, and "we can show you the approval record" is the answer.',
    retention: 'the term of the approval, plus the period a dispute may reach back',
    prunable: false,
  },
  {
    table: 'reconciliation_findings',
    why:
      'Not new — listed here so there is ONE answer to "may a generic prune touch this table?" rather ' +
      'than two lists in two modules. A closed finding is still the record that a discrepancy existed ' +
      'and was explained.',
    retention: 'as long as the transactions it reconciles',
    prunable: false,
  },
];

// THE EXEMPTION. See the header: the record that must be DESTROYED is the one that
// most looks like something to keep.
const EXEMPT_FROM_PROTECTION = [
  {
    table: 'age_assurance',
    why:
      'Personal information collected FOR AGE ASSURANCE must be destroyed once used, absent elevated ' +
      'consent. Keeping it "because it looks like compliance data" would be the exact failure the ' +
      'provision exists to prevent, performed by an operator being careful. Erasure is per-record, ' +
      'reasoned and audited — see lib/identity eraseAgeAssurance — and a retention job is not that.',
    prunable: false,
  },
];

const PROTECTED_NAMES = new Set(PROTECTED_TABLES.map((t) => t.table));

/**
 * May a generic retention job delete from this table?
 *
 * THE DEFAULT IS NO, and the direction is the point. A question about an
 * unfamiliar table is answered "not without saying why", because the cost of
 * wrongly protecting a table is that it keeps more data than it needs to, and the
 * cost of wrongly deleting one is that a compliance record is gone and nobody
 * knows. Those are not symmetric and neither is the default.
 *
 * The exemption list is consulted FIRST and explicitly, so `age_assurance` gets a
 * deliberate "you must handle this yourself, per record" answer rather than
 * inheriting the protected default by accident.
 */
function mayPrune(db, table) {
  const exemption = EXEMPT_FROM_PROTECTION.find((t) => t.table === table);
  if (exemption) {
    // THE REASON IS RETURNED, not a generic sentence. An operator asking "why is
    // this not prunable?" is asking whether the tool they are about to write can
    // delete their age-assurance records, and "it is protected" would be a false
    // answer to a question about a table that must be DESTROYED.
    return { may: false, reason: 'exempt-from-protection', detail: exemption.why };
  }
  if (PROTECTED_NAMES.has(table)) {
    const entry = PROTECTED_TABLES.find((t) => t.table === table);
    return { may: false, reason: 'financial-crime-record', detail: entry ? entry.why : null };
  }
  return { may: true, reason: 'not-listed', detail: null };
}

/**
 * Throw if a caller is about to prune a protected table.
 *
 * The MECHANISM half. A report an operator reads is advice; a guard a pruner calls
 * is a control. A future generic retention job that does not know to call this
 * still gets caught by tests/retention.test.js, which greps the source for DELETE
 * statements — so the two defences cover each other, and neither relies on the next
 * contributor reading this header.
 */
function assertPrunable(table) {
  const v = mayPrune(null, table);
  if (!v.may) {
    throw httpError(500, `retention: "${table}" is not prunable (${v.reason}). ${v.detail || ''}`);
  }
  return true;
}

/** The policy, for the operator surface. Reports what exists; changes nothing. */
function policy() {
  return {
    protected: PROTECTED_TABLES,
    exempt: EXEMPT_FROM_PROTECTION,
    // The one pruner that exists, named with its window, so an operator reading
    // this knows exactly what is being deleted from their database and by what.
    existing_pruners: [
      {
        module: 'lib/marketdata.js',
        function: 'prunePriceHistory',
        tables: ['price_history', 'price_matched_levels'],
        note:
          'The trade tape and its minute rollup, pruned to a 30-day window because a chart series has ' +
          'a reader whose need expires. It does not touch anything on either list above, and ' +
          'tests/retention.test.js asserts that from the source rather than from this description.',
      },
    ],
    note:
      'There is no pruner for financial-crime records, and adding one would be the defect this module ' +
      'exists to prevent. Erasure is per record, reasoned and audited.',
  };
}

module.exports = {
  PROTECTED_TABLES,
  PROTECTED_NAMES,
  EXEMPT_FROM_PROTECTION,
  mayPrune,
  assertPrunable,
  policy,
};