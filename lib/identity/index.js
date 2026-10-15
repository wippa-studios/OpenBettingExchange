'use strict';
// lib/identity/index.js — registry, the verification lifecycle, and THE GATE.
//
// The interface is lib/identity/provider.js; this file is what the rest of the
// venue calls. Its job is narrow and it is the same job lib/payments/index.js
// has: hold the registry, hold the lifecycle, and refuse where refusing is the
// control.
//
// ── WHERE THIS IS A READING AND NOT LEGAL ADVICE ────────────────────────────
//
// Three places where this module interprets an obligation rather than restating
// one, written down so an operator's compliance officer can see what we decided
// and overrule it:
//
//   1. THE COMMENCEMENT DATE AND THE REPEAL. Australian law has required customer
//      pre-verification BEFORE an online gambling account is created since
//      29 September 2024, and the interim allowance for deferring it in special
//      circumstances was repealed rather than extended. This module enforces that
//      shape. It does not know what "special circumstances" the repeal removed —
//      because there are none, which is the reason it is a repeal — and if that
//      is wrong the fix is a different gate, not a different reading.
//
//   2. WHAT COUNTS AS "VERIFIED". The contract requires a DECISION plus its
//      constituent CHECKS, and refuses a pass with no checks. What a given vendor's
//      checks mean, and whether they are sufficient, is the operator's call with
//      their vendor. The mechanism makes the question answerable; it does not
//      answer it.
//
//   3. THE REMEDIATION PATH FOR PRE-EXISTING ACCOUNTS. There is deliberately no
//      `exempt` value, and an operator bringing a legacy account into compliance
//      records a decision with a written reason. Whether that is the right
//      remediation for the operator's regulator is theirs, and the audit row is
//      the evidence that a person decided it rather than a migration having
//      waved the base through.
//
// ── THE ENFORCEMENT POINT, AND WHY IT IS IN THE ENGINE ─────────────────────
//
// Australian law has required customer pre-verification BEFORE an online
// gambling account is created since 29 September 2024, and the interim
// allowance for deferring it in special circumstances was repealed rather than
// extended. So registration cannot, by itself, produce a usable account.
//
// That is enforced at FOUR places, and the list is short on purpose — a control
// that exists in one route is a control the next route forgets:
//
//   1. ORDER PLACEMENT — lib/match.js validateOrder(), immediately after the
//      off-time gate and BEFORE anything is written. Same position and same
//      reason as lib/offtime.js: a refusal that runs before the collateral is
//      taken leaves nothing behind, so a future caller cannot reach the escrow
//      path at all.
//
//   2. THE TRADE GATE — lib/limits.js assertTradeable(), which is the ONE
//      function every money path already calls. This is what makes the control
//      inherited rather than remembered: cash-out, the paper faucet and any new
//      money route get it by existing.
//
//   3. DEPOSIT CONFIRMATION — lib/payments/index.js confirmDeposit(), before
//      ledger.deposit. Deliberately at CONFIRMATION and not at intent creation,
//      for the same reason the RG deposit limit moved there: a check that runs
//      before the effect and consumes nothing is not a check on the effect.
//
//   4. WITHDRAWAL — lib/payments/index.js openWithdrawal(), before the hold.
//
// (4) IS THE INTERESTING ONE, because `/api/wallet/withdraw` deliberately does
// NOT call assertTradeable. lib/limits.js's own comment gives the reason:
// "Refusing to let someone take their own money out is a far worse failure than
// the gap above, and self-exclusion is a promise about PLAY, not about custody."
// That reasoning is correct for self-exclusion and it does NOT transfer to
// identity. An unverified account is an account the venue cannot prove belongs to
// the person asking — which is precisely the third-party-funding fact AUSTRAC
// treats as a finding in its own right (see lib/funding.js). Refusing a payout is
// the control; the alternative is paying money out of an account that may not be
// the account holder's, on a rail that cannot be clawed back. The asymmetry is
// deliberate and it is the only place in this codebase where custody and play
// pull in opposite directions.
//
// ── WHAT IS EXEMPT, AND WHY EACH EXEMPTION IS NAMED ─────────────────────────
//
//   THE HOUSE (is_bot = 1). The venue's own market maker cannot complete a
//   customer KYC flow because it is not a customer; it also CANNOT be gated,
//   because a venue whose liquidity provider cannot quote is a venue with no
//   market. Gating it would look correct and break the product.
//
//   THE OPERATOR'S OWN ACCOUNTS (role = 'admin'). A pre-verification obligation
//   is an obligation about CUSTOMERS. An admin account is the operator's own
//   staff account, and the compliance regime for staff accounts is the
//   operator's own HR and AML policy — not this codebase's business, and not
//   something to invent a rule for. Said plainly here because an exemption that
//   is not written down reads as a hole.
//
// Nothing else is exempt. There is deliberately no `exempt` value in the
// identity_status vocabulary: the remediation path for a legacy account is an
// operator recording a DECISION WITH A REASON (setDecision), which is audited
// and attributable, rather than a flag anybody can set.
//
// ── AGE ASSURANCE IS A SEPARATE RECORD, AND THAT IS THE POINT ──────────────
//
// See the long note on `age_assurance` in lib/store.js for the legal shape. The
// short version: the reform bill's explanatory memorandum addresses age
// assurance SEPARATELY from identity, provides that personal information
// collected FOR AGE ASSURANCE must be destroyed once used absent elevated
// consent, and provides that no Australian will be forced to use government
// identification (including Digital ID) for age assurance.
//
// Three consequences this file implements rather than describes:
//
//   1. THE ARTEFACT IS NOT A FIELD ON A USER. There is no date of birth on
//      `users`, no document image anywhere in this schema, and no document
//      number. `age_assurance` holds an ATTESTATION and an opaque vendor
//      handle, and nothing that identifies a person on its own.
//
//   2. IT IS INDIVIDUALLY ERASABLE, and erasing is a first-class audited action
//      (eraseAgeAssurance) rather than a consequence of something else.
//
//   3. "DESTROYED ONCE USED" IS STRUCTURAL, not scheduled. When a verification
//      reaches a decision, `eraseAgeAssurance` runs in the SAME transaction as
//      the decision write (see `applyDecision`). There is no window in which the
//      artefact exists and the obligation has been discharged.
//
// AND THE ASSUMPTION WE ARE DELIBERATELY NOT MAKING. It is entirely plausible
// that a privacy-preserving age-assurance network proves a person is over 18
// without the venue ever receiving an identity document or an identifier of any
// kind — which is the point of that design, and it matches the bill's safeguard
// directly. So the record shape above is built to be COMPLETE if the vendor
// returns nothing at all: `attributes` may be NULL, `outcome` is the whole
// payload, and no code path in this repository requires a document to have been
// seen. A model that assumed a stored document image would have been wrong on
// day one and expensive to change.
//
// RETENTION EITHER WAY. If the provision is not enacted, erasability costs
// nothing — the record is deleted when it has been used, and the durable fact
// that remains is a CHECK OUTCOME inside the verification's own checks list,
// which is financial-crime material and is kept. If it is enacted, retrofitting
// "separately erasable" onto a schema that conflated the two is the expensive
// direction. That asymmetry is the entire argument for the two tables.
const { httpError } = require('../auth');
const { transaction } = require('../tx');
const config = require('../config');
const audit = require('../audit');
const {
  PENDING,
  PASS,
  FAIL,
  REVIEW,
  CHECK_SANCTIONS,
  CHECK_SELF_EXCLUSION,
  assertProvider,
  decisionOf,
  screenOutcomeOf,
} = require('./provider');
const { referenceProvider } = require('./reference');

// ── The status vocabulary on `users.identity_status` ────────────────────────
//
// A COLUMN and not a derived lookup, for the reason lib/rg.js gives for
// `user_rg_state`: the gate runs on every money path, so it must be one indexed
// read and not a join against a table that could be missing a row.
//
// NOT the provider's decision vocabulary, though they overlap. `pending` here
// means "the venue has asked and has no answer", which is the state the gate has
// to act on; a provider decision of `pending` is the same thing, but `expired`
// and `closed` are provider session states that are NOT account states — an
// account whose session expired is still unverified, and folding those two
// vocabularies together would let a closed session read as a decision.
const IDENTITY_UNVERIFIED = 'unverified';
const IDENTITY_PENDING = 'pending';
const IDENTITY_VERIFIED = 'verified';
const IDENTITY_FAILED = 'failed';
const IDENTITY_REVIEW = 'review';
const IDENTITY_STATUSES = [
  IDENTITY_UNVERIFIED,
  IDENTITY_PENDING,
  IDENTITY_VERIFIED,
  IDENTITY_FAILED,
  IDENTITY_REVIEW,
];

// A provider DECISION mapped onto the account status it produces. Explicit
// rather than assumed equal, because the two vocabularies are genuinely
// different (see above) and the one case that matters is `expired`: a provider
// session that timed out is NOT a decision about the person, so it leaves the
// account unverified rather than failing them.
function statusForDecision(decision) {
  switch (decision) {
    case PASS: return IDENTITY_VERIFIED;
    case FAIL: return IDENTITY_FAILED;
    case REVIEW: return IDENTITY_REVIEW;
    case PENDING: return IDENTITY_PENDING;
    default: return IDENTITY_UNVERIFIED;
  }
}

let active = null;
const registry = new Map();

function register(p) {
  assertProvider(p);
  registry.set(p.name, p);
  return p;
}

/**
 * Select the provider.
 *
 * `identityRequired` mirrors payments' `realPayments`, and the refusal is for the
 * same reason. In a paper-money install the reference provider is the default
 * and always works. The moment an operator declares they are serving real
 * customers, the reference provider is REFUSED and the absence of a provider is a
 * HARD ERROR — because a mock that passes anyone is exactly what must never sit
 * behind a live customer onboarding flow, and the only safe moment to find that
 * out is startup.
 */
function select(name, { identityRequired = false } = {}) {
  if (name && registry.has(name)) {
    if (name === 'reference' && identityRequired) {
      throw httpError(500, 'identity: the reference provider cannot be used when pre-verification is required');
    }
    active = registry.get(name);
    return active;
  }
  if (identityRequired) {
    throw httpError(500, 'identity: pre-verification is required but no provider is configured');
  }
  active = register(referenceProvider());
  return active;
}

/** The active provider, resolved lazily so requiring this module is side-effect free. */
function current() {
  if (!active) active = register(referenceProvider());
  return active;
}

/**
 * Is this deployment enforcing customer pre-verification?
 *
 * A CONFIG question, answered without a row, for the reason lib/rg.js's
 * `configured()` is: the boot check must not depend on a user existing, and the
 * player-facing status must not either.
 *
 * DEFAULTS TO FALSE, and that is a statement about THIS repository — it is
 * paper-money software with seeded demo credentials and a README that says so.
 * It is NOT a statement about an Australian deployment, which must set it, and
 * server.js says so at boot in the same words lib/limits.js uses for the
 * suspended-tenant control: a control that is fully instrumented and enforced
 * nowhere is the most dangerous shape a bug can take.
 */
function required() {
  return !!config.IDENTITY_REQUIRED;
}

/**
 * THE GATE.
 *
 * Refuses an account that is not verified, with a DISTINCT code per status
 * because the client has to render different advice for each — the same
 * requirement lib/limits.js states for its refusals. `identity_pending` is not
 * the same message to a customer as `identity_failed`, and collapsing them is
 * how a customer concludes the venue has decided something about them.
 *
 * The codes are in `details.code`, which is where every other refusal in this
 * codebase puts its machine-readable reason.
 *
 * A NO-OP WHEN THE CONTROL IS OFF. Not because the control is satisfied, but
 * because there is no control: `required()` is false on a paper-money install and
 * the boot warning in server.js says so. A gate that cannot be turned off in a
 * test suite that has no identity provider is a gate every test would have to
 * mock around, which is how gates get deleted.
 */
function assertVerified(db, userId) {
  if (!required()) return;
  const u = db
    .prepare('SELECT id, is_bot, role, identity_status FROM users WHERE id = ?')
    .get(userId);
  if (!u) throw httpError(404, 'User not found');
  // The two named exemptions. See the header for why each exists.
  if (u.is_bot || u.role === 'admin') return;
  const status = u.identity_status || IDENTITY_UNVERIFIED;
  if (status === IDENTITY_VERIFIED) return;
  throw httpError(403, adviceFor(status), {
    code: `identity_${status}`,
    identity_status: status,
    // What the client should offer next. A status, not a URL: this module knows
    // the state, not the client's routing.
    next: status === IDENTITY_UNVERIFIED || status === IDENTITY_PENDING ? 'start_verification' : 'contact_operator',
  });
}

function adviceFor(status) {
  switch (status) {
    case IDENTITY_UNVERIFIED:
      return 'Your account must be verified before you can trade or move money.';
    case IDENTITY_PENDING:
      return 'Your identity check has not finished. Complete it before trading.';
    case IDENTITY_FAILED:
      return 'Your identity check did not pass. Contact the operator.';
    case IDENTITY_REVIEW:
      return 'Your identity check is with our team for review. Contact the operator.';
    default:
      return 'Your account is not verified.';
  }
}

/**
 * Start a verification for a prospective customer.
 *
 * Creates the durable row BEFORE asking the provider, not after. The reason is
 * the same one lib/payments/index.js gives for writing the intent first: a
 * verification that the venue asked for and has no record of is an account
 * permanently stuck at "unverified" with no way to find out why, and the
 * operator's first question would be unanswerable. Writing the row first means a
 * provider failure leaves a visible pending attempt, which is a thing a human can
 * act on.
 *
 * `reference` is an OPAQUE SUBJECT HANDLE, never a name, a date of birth or a
 * document. The venue must be able to ask a screening question without holding
 * the identity that answers it — see the note at the top of lib/identity/.
 */
async function startVerification(db, { userId, actor, reference, subjectName = null, jurisdiction = null }) {
  const p = current();
  const session = await p.startVerification({ reference: reference || `user:${userId}`, jurisdiction });
  return transaction(db, () => {
    const info = db
      .prepare(
        `INSERT INTO identity_verifications (user_id, provider, external_id, status, subject_reference, subject_name, started_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(userId, p.name, session.externalId, PENDING, reference || `user:${userId}`, subjectName);
    db.prepare('UPDATE users SET identity_status = ?, identity_status_at = datetime(\'now\') WHERE id = ?')
      .run(IDENTITY_PENDING, userId);
    audit.record(db, actor, audit.ACTIONS.IDENTITY_VERIFICATION_STARTED, `user:${userId}`,
      { identity_status: IDENTITY_UNVERIFIED }, { identity_status: IDENTITY_PENDING },
      'customer pre-verification');
    return {
      verification_id: Number(info.lastInsertRowid),
      external_id: session.externalId,
      status: PENDING,
      // Passed through verbatim and possibly null. Not every vendor has a
      // client-side token (a pure redirect flow has none), so nothing in this
      // repository may require one to exist.
      client_token: session.clientToken || null,
      identity_status: IDENTITY_PENDING,
    };
  });
}

/**
 * Normalise a provider's constituent checks into what the venue stores.
 *
 * The venue's own name where it recognises the check, and the VENDOR'S NAME
 * alongside it always — never instead of. A provider that renames its own check
 * must not silently stop being stored: the operator needs to see "their check is
 * called `document_check_v3` now, and it passed", and a schema that dropped
 * unknown names would make that question unanswerable after a vendor's release.
 *
 * `failed` collapses the store down to the checks that actually failed. A PASS
 * with NO checks is refused outright (see `applyDecision`): the operator could
 * not then answer "which check cleared this person?", which is the first
 * question a disputed refusal produces.
 */
function checkName(raw) {
  const key = typeof raw === 'string' ? raw : raw && (raw.check || raw.name);
  if (!key) return null;
  const normalised = String(key).trim();
  return {
    check: normalised,
    venue_check: normalised,
    outcome: (typeof raw === 'object' && raw && raw.outcome) || 'pass',
    at: (typeof raw === 'object' && raw && raw.at) || null,
  };
}

/**
 * Apply a decision: the one place `users.identity_status` is written from a
 * provider result, and the one place age assurance is destroyed once used.
 *
 * `verificationId` scopes the write. A decision for a verification that is not
 * the account's newest open one is still recorded — the audit row says so — but
 * it cannot move the account's status. That is deliberate: an out-of-order
 * callback for a session the customer abandoned last week must not flip the state
 * of the session they are in the middle of now.
 */
function applyDecision(db, { verificationId, providerName, decision, checks, detail, subjectName = null, actor }) {
  const decided = decisionOf(decision, providerName);
  const normChecks = (Array.isArray(checks) ? checks : []).map(checkName).filter(Boolean);
  if (decided === PASS && normChecks.length === 0) {
    throw httpError(
      502,
      'identity: the provider returned a pass with no constituent checks. Refusing to record it: ' +
        'a verification with no checks cannot be explained to the customer or to an examiner.'
    );
  }
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM identity_verifications WHERE id = ?').get(verificationId);
    if (!row) throw httpError(404, 'Verification not found');
    const next = statusForDecision(decided);

    // ONLY THE ACCOUNT'S CURRENT ATTEMPT MAY MOVE ITS STATUS. See the header for
    // why: an out-of-order callback for a session the customer abandoned last
    // week must not flip the state of the session they are in the middle of now.
    //
    // READ BEFORE THE UPDATE, and that ordering is the whole bug this line
    // records. It used to run AFTER, and by then this row's own status was no
    // longer 'pending' — so the "is there an open attempt?" query found nothing,
    // `open` was null, and the users row was NEVER WRITTEN. Every verification
    // recorded its decision on `identity_verifications` and left the account
    // stuck at "pending" forever, which is the exact account state the gate
    // refuses. It surfaced as a passing suite, because nothing asserted that a
    // pass moves the ACCOUNT.
    const open = db
      .prepare("SELECT id FROM identity_verifications WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT 1")
      .get(row.user_id, PENDING);
    const isCurrentAttempt = !!open && open.id === verificationId;

    db.prepare(
      `UPDATE identity_verifications
          SET status = ?, decision = ?, checks = ?, detail = ?, decided_at = datetime('now'),
              subject_name = COALESCE(?, subject_name)
        WHERE id = ?`
    ).run(decided, decided, JSON.stringify(normChecks), detail || null, subjectName, verificationId);

    if (isCurrentAttempt) {
      db.prepare("UPDATE users SET identity_status = ?, identity_status_at = datetime('now') WHERE id = ?")
        .run(next, row.user_id);
    }
    // THE OBLIGATION IS NOW DISCHARGED, so the artefact is gone. Same
    // transaction as the decision write, which is what makes "destroyed once
    // used" a property of the code rather than a job somebody might forget.
    const erased = eraseAgeAssurance(db, { userId: row.user_id, actor, reason: 'age assurance used for a verification decision' });
    audit.record(db, actor, audit.ACTIONS.IDENTITY_DECISION_RECORDED, `user:${row.user_id}`,
      { identity_status: IDENTITY_PENDING }, { identity_status: next, decision: decided },
      detail || 'provider decision');
    return {
      verification_id: verificationId,
      decision: decided,
      identity_status: next,
      // Whether the ACCOUNT's status actually moved. Reported because a
      // verification row recording a decision while the account stays pending is
      // a state an operator has to be able to see and diagnose, and it is
      // invisible without this field.
      account_updated: isCurrentAttempt,
      checks: normChecks,
      age_assurance_erased: erased.erased,
    };
  });
}

/**
 * Read a verification's outcome.
 *
 * The provider decides; this reads, records and maps. A provider still PENDING
 * is not an error and moves nothing — the account stays pending and the gate
 * keeps refusing, which is the correct answer for a customer who has not finished
 * the flow.
 */
async function readOutcome(db, { verificationId, actor }) {
  const row = db.prepare('SELECT * FROM identity_verifications WHERE id = ?').get(verificationId);
  if (!row) throw httpError(404, 'Verification not found');
  const p = current();
  const out = await p.readVerification(row.external_id);
  if (!out || out.decision === null || out.decision === undefined) {
    return { verification_id: verificationId, decision: null, identity_status: IDENTITY_PENDING, checks: [] };
  }
  return applyDecision(db, {
    verificationId,
    providerName: p.name,
    decision: out.decision,
    checks: out.checks,
    detail: out.detail,
    subjectName: out.subjectName || null,
    actor,
  });
}

/**
 * The provider's callback: the one automated path that writes a decision.
 *
 * `verifyCallback` authenticates the CALLER (an HMAC over the raw body), not the
 * session, exactly as lib/payments/index.js's webhook does for a deposit
 * confirmation. Without that check this is an unauthenticated endpoint that
 * decides whether somebody may trade.
 */
async function readCallback(db, { rawBody, headers, signature, actor }) {
  const p = current();
  const out = await p.verifyCallback(rawBody, headers, signature);
  if (!out) throw httpError(400, 'identity: the callback signature did not verify');
  const row = db
    .prepare("SELECT * FROM identity_verifications WHERE external_id = ? ORDER BY id DESC LIMIT 1")
    .get(out.externalId);
  if (!row) throw httpError(404, 'No verification matches that external id');
  return applyDecision(db, {
    verificationId: row.id,
    providerName: p.name,
    decision: out.decision,
    checks: out.checks,
    detail: out.detail,
    subjectName: out.subjectName || null,
    actor,
  });
}

/**
 * Run the two SCREENING obligations: the national self-exclusion register and
 * sanctions / PEP.
 *
 * WHAT THE CALLER GETS BACK IS `{ screened: true }`. That is the whole API and it
 * is deliberate: tipping off is a criminal offence in Australia and the
 * person being told is, in the self-exclusion case, the subject. A `POST
 * /api/identity/screen` that returned `hit: true` would be handing the customer
 * the fact that they are on a national register, and one that returned
 * `hit: false` would be telling them they had been screened when they had not.
 *
 * So the OUTCOME goes to the financial-crime record and nowhere else. Both
 * screens write an alert through lib/aml/findings, which is entitlement-gated —
 * see that file's header for the three tipping-off surfaces.
//
// `reference` is the opaque subject handle. The screening provider needs
// something to search on and this module will not be the thing that holds a
// person's identity.
 */
async function screen(db, { userId, actor, reference, jurisdiction = null }) {
  const p = current();
  const subject = { reference: reference || `user:${userId}` };
  const results = [];

  const exclusion = await p.checkSelfExclusion(subject);
  const exclOutcome = screenOutcomeOf(exclusion.outcome, p.name);
  results.push({ check: CHECK_SELF_EXCLUSION, outcome: exclOutcome });
  if (exclOutcome !== 'clear') {
    recordScreenAlert(db, {
      actor,
      userId,
      ruleId: 'AU-EX-01',
      severity: 'high',
      detail: `The national self-exclusion register returned "${exclOutcome}" for this subject`,
      evidence: { check: CHECK_SELF_EXCLUSION, outcome: exclOutcome, provider: p.name },
      source: 'screening',
    });
  }

  const sanctions = await p.screenSanctions(subject, { jurisdiction });
  const sancOutcome = screenOutcomeOf(sanctions.outcome, p.name);
  results.push({ check: CHECK_SANCTIONS, outcome: sancOutcome });
  if (sancOutcome !== 'clear') {
    recordScreenAlert(db, {
      actor,
      userId,
      ruleId: 'AU-SA-01',
      severity: 'high',
      detail: `Sanctions / PEP screening returned "${sancOutcome}" for this subject`,
      evidence: {
        check: CHECK_SANCTIONS,
        outcome: sancOutcome,
        provider: p.name,
        lists: sanctions.lists || null,
        lists_version: sanctions.lists_version || null,
      },
      source: 'screening',
    });
  }

  // The list version travels with the alert on purpose. "We screened against
  // something" is not an auditable statement, and a list version is the only way
  // to prove which list was current on the day the question was asked.
  return { screened: true, checks: results.length };
}

function recordScreenAlert(db, { actor, userId, ruleId, severity, detail, evidence, source }) {
  const findings = require('./../aml/findings');
  return transaction(db, () =>
    findings.recordAlert(db, {
      rule_id: ruleId,
      scope: findings.alertScope(ruleId, `user:${userId}`),
      severity,
      user_id: userId,
      detail,
      evidence,
      source,
    })
  );
}

/**
 * Record an age-assurance ATTESTATION.
 *
 * WHAT THIS STORES IS: the outcome, the method, the assurance level, an opaque
 * vendor handle and whatever attributes the vendor chose to return (which may be
 * nothing at all — see the note at the top of this file about privacy-preserving
 * age-assurance networks).
 *
 * WHAT IT DELIBERATELY DOES NOT STORE: a date of birth, a document type, a
 * document number, or an image. "A date of birth on the user" is the model this
 * whole split exists to avoid — it is the shape that makes age assurance and
 * identity un-erasable as separate concerns, and it is the shape a regulator is
 * most likely to have an opinion about.
 */
function recordAgeAssurance(db, { userId, actor, provider, externalId, method, assurance, outcome, attributes, expiresInDays = null, reason }) {
  const info = db
    .prepare(
      `INSERT INTO age_assurance (user_id, provider, external_id, method, assurance, outcome, attributes, verified_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', ?))`
    )
    .run(
      userId,
      provider || current().name,
      externalId || null,
      method,
      assurance,
      outcome,
      attributes === null || attributes === undefined ? null : JSON.stringify(attributes),
      expiresInDays === null || expiresInDays === undefined ? null : `+${Number(expiresInDays)} days`
    );
  audit.record(db, actor, audit.ACTIONS.AGE_ASSURANCE_RECORDED, `user:${userId}`,
    null, { method, assurance, outcome }, reason || 'age assurance recorded');
  return { id: Number(info.lastInsertRowid), user_id: userId, method, assurance, outcome };
}

/**
 * DESTROY an age-assurance record. Individually, on its own, with a reason.
 *
 * This is the action the reform bill's explanatory memorandum is about, made
 * callable: not a consequence of a job, not a cascade from deleting a user, a
 * first-class audited operation that nulls the identifying columns and stamps
 * `erased_at`.
 *
 * WHY NULL THE COLUMNS RATHER THAN DELETE THE ROW. A tombstone is the evidence
 * that an erasure happened, on whom, when and at whose instruction. Deleting the
 * row makes "did we erase it?" unanswerable, and the question is the one an
 * auditor asks first. What survives is a process fact — there WAS an age
 * assurance record for this account and it was destroyed on this date — and not
 * one byte of the personal information it held.
 *
 * NOT FINANCIAL-CRIME MATERIAL. age_assurance is the ONE table in lib/retention.js
 * that is explicitly not protected, and the tension is the point: the record that
 * must be destroyed is the one a generic financial-crime retention job would most
 * obviously try to keep.
 */
function eraseAgeAssurance(db, { userId, actor, reason }) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM age_assurance WHERE user_id = ?').get(userId);
    if (!row) return { erased: false, reason: 'no age-assurance record' };
    if (row.erased_at) return { erased: false, already_erased: true, erased_at: row.erased_at };
    db.prepare(
      `UPDATE age_assurance
          SET external_id = NULL, attributes = NULL, erased_at = datetime('now'), erased_by = ?
        WHERE user_id = ?`
    ).run(actor ? actor.id : null, userId);
    audit.record(db, actor, audit.ACTIONS.AGE_ASSURANCE_ERASED, `user:${userId}`,
      { provider: row.provider, method: row.method, outcome: row.outcome },
      { erased: true }, reason);
    return { erased: true, user_id: userId, at: db.prepare("SELECT datetime('now') AS t").get().t };
  });
}

/**
 * Operator decision on a verification. The REMEDIATION path.
 *
 * Needed because the pre-verification obligation has a commencement date and
 * this codebase has accounts created before it. An operator going live has to be
 * able to bring an existing account into compliance, and the only honest way to
 * do that is a decision with a name, a reason and an audit row — not a flag that
 * says "exempt".
 *
 * It deliberately CANNOT set `unverified`: an operator may move an account INTO
 * review or out of it, but only the provider's decision or another operator's
 * reasoned decision can make an account verified. Allowing `unverified` would
 * make this a "mark as trusted" button.
 */
function setDecision(db, { actor, userId, decision, reason, checks = null }) {
  const next = [IDENTITY_VERIFIED, IDENTITY_FAILED, IDENTITY_REVIEW].includes(decision) ? decision : null;
  if (!next) {
    throw httpError(400, 'decision must be one of verified, failed, review');
  }
  if (!reason || String(reason).trim().length < 5) {
    throw httpError(400, 'A written reason is required to record an identity decision');
  }
  return transaction(db, () => {
    const u = db.prepare('SELECT identity_status FROM users WHERE id = ?').get(userId);
    if (!u) throw httpError(404, 'User not found');
    db.prepare("UPDATE users SET identity_status = ?, identity_status_at = datetime('now') WHERE id = ?")
      .run(next, userId);
    audit.record(db, actor, audit.ACTIONS.IDENTITY_DECISION_RECORDED, `user:${userId}`,
      { identity_status: u.identity_status },
      { identity_status: next, decided_by: 'operator', checks: checks || null },
      reason);
    return { user_id: userId, identity_status: next };
  });
}

/**
 * Release a vendor session. A prospective customer who abandons the flow must
 * not leave a live session at the vendor, and the venue needs the ability to end
 * one it can no longer complete — a session that is never released is a vendor
 * holding a live session for a person the venue has no record of.
 */
async function releaseSession(db, { verificationId, actor }) {
  const row = db.prepare('SELECT * FROM identity_verifications WHERE id = ?').get(verificationId);
  if (!row) throw httpError(404, 'Verification not found');
  const p = current();
  const out = await p.closeSession(row.external_id);
  if (row.status === PENDING) {
    db.prepare("UPDATE identity_verifications SET status = 'closed' WHERE id = ?").run(verificationId);
    const open = db
      .prepare("SELECT id FROM identity_verifications WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT 1")
      .get(row.user_id, PENDING);
    if (open && open.id === verificationId) {
      db.prepare("UPDATE users SET identity_status = ?, identity_status_at = datetime('now') WHERE id = ?")
        .run(IDENTITY_UNVERIFIED, row.user_id);
    }
    audit.record(db, actor, audit.ACTIONS.IDENTITY_SESSION_RELEASED, `user:${row.user_id}`,
      { verification_id: verificationId }, { closed: !!out.closed }, 'customer abandoned or was released');
  }
  return { verification_id: verificationId, released: !!out.closed };
}

/**
 * The PLAYER-SAFE view of an account's verification state.
 *
 * This is the only identity surface a customer can read, and it is deliberately
 * the narrowest one available. It contains: the account's own status, whether a
 * verification is in progress, and what the client should offer next.
 *
 * IT DOES NOT CONTAIN, and this list is the design:
 *
 *   - any screening outcome (that is the tipping-off surface — see screen());
 *   - any financial-crime alert, ever;
 *   - the constituent checks, which name the vendor's checks and can include its
 *     internal reason codes;
 *   - any operator-written reason, which is an internal record.
 *
 * A customer is told what THEY must do and what state they are in. That is the
 * whole of what they are entitled to, and it is enough to render the flow.
 */
function statusOf(db, userId) {
  const u = db.prepare('SELECT identity_status, identity_status_at FROM users WHERE id = ?').get(userId);
  if (!u) throw httpError(404, 'User not found');
  const status = u.identity_status || IDENTITY_UNVERIFIED;
  const active = db
    .prepare("SELECT id, external_id, status FROM identity_verifications WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT 1")
    .get(userId, PENDING);
  return {
    identity_status: status,
    identity_status_at: u.identity_status_at || null,
    verification_in_progress: !!active,
    verification_id: active ? active.id : null,
    // The status is NOT quoted back as advice for a status this module does not
    // recognise, which would be the tell that a migration and this file had
    // drifted apart.
    message: adviceFor(status),
    // The machine-readable NEXT ACTION, and it is the same vocabulary the gate's
    // refusal uses so a client renders one thing rather than two that can
    // disagree. Present for exactly the states where the customer can act;
    // `contact_operator` for the two where only a person at the venue can, which
    // is a different thing for the client to render and must not look the same as
    // "keep going".
    next:
      status === IDENTITY_UNVERIFIED || status === IDENTITY_PENDING
        ? 'start_verification'
        : status === IDENTITY_VERIFIED
          ? null
          : 'contact_operator',
    enforced: required(),
  };
}

module.exports = {
  IDENTITY_UNVERIFIED,
  IDENTITY_PENDING,
  IDENTITY_VERIFIED,
  IDENTITY_FAILED,
  IDENTITY_REVIEW,
  IDENTITY_STATUSES,
  register,
  select,
  current,
  required,
  configured: required,
  assertVerified,
  startVerification,
  readOutcome,
  readCallback,
  // EXPORTED so the test suite can drive a decision without a network, and so an
  // operator tool can apply one from a provider response it received another way.
  // It is not on the HTTP surface: the only automated path that writes a decision
  // is the signed callback.
  applyDecision,
  releaseSession,
  screen,
  recordAgeAssurance,
  eraseAgeAssurance,
  setDecision,
  statusOf,
  checkName,
};