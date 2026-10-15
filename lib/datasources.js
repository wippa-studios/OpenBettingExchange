'use strict';
// lib/datasources.js — the register of licensed data sources, and what it allows.
//
// ── WHY A REGISTER, AND NOT A COLUMN ────────────────────────────────────────
//
// Racing NSW's rules require an operator using NSW race-field information to hold
// an approval from Racing NSW REGARDLESS OF WHERE IT IS DOMICILED OR LICENSED,
// with fees payable. So the question "are we allowed to use this" has an answer
// that does not depend on where the venue is licensed, which makes it impossible
// to derive from the tenant row.
//
// And an approval is not a yes. The three things an approval can grant are
// DISPLAY, STORE and SETTLE, and they have completely different consequences: a
// display-only permission that settles a race is a settlement the venue cannot
// defend, and a store permission that is never displayed is a database holding
// data it has no right to hold. One boolean cannot express any of that, so
// `permits` is a set over a CLOSED vocabulary.
//
// ── WHY IT EXTENDS `result_events` RATHER THAN REPLACING IT ─────────────────
//
// `result_events.source` already exists and says something real: poll, webhook,
// manual, import — HOW the outcome arrived. It does not say UNDER WHAT RIGHT the
// venue may use the information it arrived in, and it cannot, because a transport
// has no opinion about a licence.
//
// So `data_source_id` is ADDED alongside it. Nothing that reads `source` changes,
// nothing about the existing vocabulary changes, and an outcome that arrives with
// no registered source still records exactly what it recorded before. What changes
// is that the venue can now answer "under whose approval did we settle this?",
// and can refuse to settle from a source whose approval does not permit settling.
//
// ── WHERE IT IS ENFORCED, AND WHERE IT DELIBERATELY IS NOT ─────────────────
//
// ENFORCED IN TWO PLACES:
//
//   1. `assertUsable(sourceId, use)` — the pre-flight check. An operator asks
//      "may I settle from this?" before they rely on it, and gets a refusal with
//      a reason. This is the "visible to an operator BEFORE they rely on it" the
//      brief asks for, and it is the check that makes an expired licence
//      impossible to rely on by accident.
//
//   2. `lib/results.js`'s `applyOutcome` validates a `dataSourceId` that is
//      SUPPLIED. An outcome that names a source whose licence does not permit
//      settling is refused; an outcome that names none behaves exactly as it did
//      before this module existed.
//
// AND IT IS NOT ENFORCED BY REFUSING A SETTLEMENT THAT NAMES NO SOURCE. That
// would be changing the settlement path, which is out of scope, and it would break
// every existing settlement on every existing deployment. Instead the gap is made
// VISIBLE: `unattributedSettlements()` counts outcomes with no source, and
// `/api/admin/data-sources` reports it. A control that is invisible is not a
// control, so the number is on the register's own surface rather than buried in a
// report nobody reads.
//
// ── NO DEFAULT LIST OF SOURCES ──────────────────────────────────────────────
//
// Ships empty, like aml_entitlements and funding_instruments, and for the same
// reason: this repository does not know what the operator has licensed, and a
// guessed licence reference is worse than none. Every field an approval carries —
// the owner, the authority, the reference, the permitted uses, the expiry — is the
// operator's to state, and stating it is an audited act.
const { httpError } = require('./auth');
const { transaction } = require('./tx');
const config = require('./config');
const audit = require('./audit');

// ── The permitted-use vocabulary ─────────────────────────────────────────────
//
// CLOSED, and deliberately so. The failure this column exists to catch is a
// settlement from a display-only approval, and an open column would let an
// operator invent a fourth use that nothing knows how to police. A closed
// vocabulary means a value nobody recognises is REFUSED rather than stored and
// never checked.
const DISPLAY = 'display';
const STORE = 'store';
const SETTLE = 'settle';
const USES = [DISPLAY, STORE, SETTLE];

function parsePermits(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => USES.includes(x)) : [];
  } catch {
    return [];
  }
}

/** Everything in the register, with the licence state resolved. */
function list(db) {
  const rows = db.prepare('SELECT * FROM data_sources ORDER BY owner, slug').all();
  return rows.map((r) => ({ ...r, permits: parsePermits(r.permits), state: licenceState(r) }));
}

/**
 * The licence state, as THREE answers and not two.
 *
 * expired / expiring / active. "Expiring" is not a warning bolted on — it is its
 * own state because it is the one an operator most needs to act on and the one a
 * two-valued flag would hide: a licence that expires in three weeks IS currently
 * usable, and an operator who reads "active" and stops looking is the failure.
 * The warning window is DATA_SOURCE_EXPIRY_WARN_DAYS because it is a property of
 * this venue's renewal process and not of any law.
 */
function licenceState(row, nowIso = null) {
  if (!row.enabled) return 'disabled';
  const now = nowIso || db_now();
  if (row.expires_at && row.expires_at <= now) return 'expired';
  if (row.expires_at) {
    // A WARN-FROM DATE, which is now + the window — not now MINUS it. It went the
    // other way round, and the effect was that `expiring` was unreachable: an
    // expiry in the future is always LATER than a date in the past, so the
    // comparison never fired and every licence read "active" until the day it
    // lapsed. That is the one operator most needs to act on, made unreachable by
    // a sign error.
    const warnFrom = shift(now, -config.DATA_SOURCE_EXPIRY_WARN_DAYS);
    if (row.expires_at <= warnFrom) return 'expiring';
  }
  if (row.starts_at && row.starts_at > now) return 'not_yet_active';
  return 'active';
}

// db_now is a seam so the state function can be tested with a fixed clock without
// a database. Not a general injection point — the callers all use the real clock.
let _now = null;
function db_now() {
  return _now || new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function setNow(iso) {
  _now = iso;
}

function shift(iso, days) {
  const d = new Date(`${iso.replace(' ', 'T')}Z`);
  d.setUTCDate(d.getUTCDate() - Number(days || 0));
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function byId(db, id) {
  return db.prepare('SELECT * FROM data_sources WHERE id = ?').get(id) || null;
}

function bySlug(db, slug) {
  return db.prepare('SELECT * FROM data_sources WHERE slug = ?').get(String(slug)) || null;
}

/**
 * MAY THE VENUE RELY ON THIS SOURCE FOR THIS USE?
 *
 * The pre-flight check, and the answer is a REFUSAL with a distinct machine-
 * readable code per cause, because the four causes have four different remedies:
 *
 *   unknown_source            — register it
 *   source_disabled           — the operator turned it off
 *   licence_expired           — renew it, or stop using it
 *   not_yet_active            — wait
 *   use_not_permitted         — the approval does not cover this use. THIS is the
 *                               one the `permits` column exists for: display-only
 *                               approval, settlement attempted.
 *
 * A refusal is THROWN rather than returned as a boolean. The callers are all in
 * front of a decision a human is about to make, and a boolean at a call site is
 * one somebody will ignore — the same argument lib/offtime.js and lib/limits.js
 * make for assertions over helpers.
 */
function assertUsable(db, sourceId, use) {
  if (!USES.includes(use)) {
    throw httpError(400, `use must be one of ${USES.join(', ')}`);
  }
  const row = byId(db, sourceId);
  if (!row) throw httpError(404, 'Data source not found', { code: 'unknown_source' });
  const state = licenceState(row);
  if (state === 'disabled') {
    throw httpError(409, 'That data source is not enabled', { code: 'source_disabled', source_id: sourceId });
  }
  if (state === 'expired') {
    throw httpError(
      409,
      `That data source's approval expired on ${row.expires_at}`,
      { code: 'licence_expired', source_id: sourceId, expires_at: row.expires_at }
    );
  }
  if (state === 'not_yet_active') {
    throw httpError(
      409,
      `That data source's approval does not start until ${row.starts_at}`,
      { code: 'not_yet_active', source_id: sourceId, starts_at: row.starts_at }
    );
  }
  const permits = parsePermits(row.permits);
  if (!permits.includes(use)) {
    throw httpError(
      409,
      `The approval for "${row.name}" does not permit ${use}. It permits: ${permits.length ? permits.join(', ') : 'nothing recorded'}.`,
      { code: 'use_not_permitted', source_id: sourceId, use, permits }
    );
  }
  return {
    source_id: row.id,
    slug: row.slug,
    name: row.name,
    owner: row.owner,
    authority: row.authority,
    licence_ref: row.licence_ref,
    use,
    state,
    expires_at: row.expires_at,
  };
}

/** The non-throwing form, for the "before you rely on it" screen. */
function checkUsable(db, sourceId, use) {
  try {
    return { ok: true, ...assertUsable(db, sourceId, use) };
  } catch (e) {
    return {
      ok: false,
      code: e.details && e.details.code ? e.details.code : 'unknown',
      message: e.message,
      details: e.details || null,
    };
  }
}

/**
 * Record or amend a source. An audited, reasoned act.
 *
 * `permits` is REQUIRED on create and validated against the closed vocabulary. A
 * register row that exists but permits nothing is a valid state — it records an
 * approval that grants nothing yet — and refusing to create it would leave the
 * operator with nowhere to record the approval they are waiting on, which is the
 * one moment the register is most useful.
 */
function configure(db, { actor, id = null, slug, name, owner, authority = null, licence_ref = null, fee_terms = null, permits = [], starts_at = null, expires_at = null, enabled = true, notes = null }) {
  if (!Array.isArray(permits) || permits.some((p) => !USES.includes(p))) {
    throw httpError(400, `permits must be an array drawn from ${USES.join(', ')}`);
  }
  if (!slug || !name || !owner) {
    throw httpError(400, 'slug, name and owner are required: a register that cannot say who owns a source is a list of names');
  }
  for (const [label, value] of [['starts_at', starts_at], ['expires_at', expires_at]]) {
    if (value === null || value === undefined) continue;
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(String(value))) {
      throw httpError(400, `${label} must be YYYY-MM-DD or YYYY-MM-DD HH:MM:SS (UTC)`);
    }
  }
  return transaction(db, () => {
    const before = id ? byId(db, id) : bySlug(db, slug);
    if (before) {
      db.prepare(
        `UPDATE data_sources
            SET slug = ?, name = ?, owner = ?, authority = ?, licence_ref = ?, fee_terms = ?,
                permits = ?, starts_at = ?, expires_at = ?, enabled = ?, notes = ?, updated_at = datetime('now')
          WHERE id = ?`
      ).run(slug, name, owner, authority, licence_ref, fee_terms, JSON.stringify(permits), starts_at, expires_at,
        enabled ? 1 : 0, notes, before.id);
      audit.record(db, actor, audit.ACTIONS.DATA_SOURCE_CONFIGURED, `data_source:${before.id}`,
        { permits: parsePermits(before.permits), expires_at: before.expires_at },
        { permits, expires_at, enabled: !!enabled }, 'data-source licence amended');
      return { ...byId(db, before.id), permits, state: licenceState(byId(db, before.id)) };
    }
    const info = db
      .prepare(
        `INSERT INTO data_sources (slug, name, owner, authority, licence_ref, fee_terms, permits, starts_at, expires_at, enabled, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(slug, name, owner, authority, licence_ref, fee_terms, JSON.stringify(permits), starts_at, expires_at, enabled ? 1 : 0, notes);
    audit.record(db, actor, audit.ACTIONS.DATA_SOURCE_CONFIGURED, `data_source:${Number(info.lastInsertRowid)}`,
      null, { slug, name, owner, permits }, 'data source registered');
    return { ...byId(db, Number(info.lastInsertRowid)), permits, state: licenceState(byId(db, Number(info.lastInsertRowid))) };
  });
}

/**
 * Outcomes that were applied with NO registered source.
 *
 * The visibility half of the enforcement argument, and the reason `data_source_id`
 * is nullable rather than NOT NULL: an outcome that arrived before the register
 * existed has no source, and forcing one would mean inventing a licence
 * attribution — which is precisely the fabrication this whole module exists to
 * stop. So the gap is counted and shown instead.
 *
 * `result_events.source` (poll / webhook / manual / import) is reported beside it,
 * because an operator reading this needs to know HOW each unattributed outcome
 * arrived as well as that it was unattributed — a webhook from a source nobody has
 * registered is a more interesting row than a manual settle by the desk.
 */
function unattributedSettlements(db, { limit = 500 } = {}) {
  return db
    .prepare(
      `SELECT re.id, re.market_id, re.source, re.decision, re.rule, re.at
         FROM result_events re
        WHERE re.data_source_id IS NULL
        ORDER BY re.id DESC
        LIMIT ?`
    )
    .all(Math.min(Math.max(Number(limit) || 500, 1), 5000));
}

function unattributedCount(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM result_events WHERE data_source_id IS NULL').get().c;
}

/**
 * Everything the operator needs on one screen: the register, the licence states,
 * the expiring-soon list, and the unattributed count.
 *
 * The unattributed count is on THIS surface rather than in a separate report
 * because the two questions are the same question — "may we rely on what we
 * settled from?" — and an operator who has to go looking for the second half will
 * not look.
 */
function overview(db) {
  const sources = list(db);
  return {
    uses: USES,
    expiry_warning_days: config.DATA_SOURCE_EXPIRY_WARN_DAYS,
    sources,
    counts: {
      total: sources.length,
      active: sources.filter((s) => s.state === 'active').length,
      expiring: sources.filter((s) => s.state === 'expiring').length,
      expired: sources.filter((s) => s.state === 'expired').length,
      disabled: sources.filter((s) => s.state === 'disabled').length,
    },
    // The register ships empty and says so rather than showing an empty list that
    // reads like "everything is fine".
    empty: sources.length === 0,
    unsettled_without_source: unattributedCount(db),
    note:
      'result_events.source records HOW an outcome arrived (poll / webhook / manual / import). ' +
      'data_source_id records UNDER WHOSE APPROVAL. An outcome with no data_source_id is counted ' +
      'here rather than being refused: inventing a licence attribution would be the fabrication ' +
      'this register exists to prevent.',
  };
}

module.exports = {
  DISPLAY,
  STORE,
  SETTLE,
  USES,
  parsePermits,
  list,
  byId,
  bySlug,
  licenceState,
  assertUsable,
  checkUsable,
  configure,
  unattributedSettlements,
  unattributedCount,
  overview,
  setNow,
};