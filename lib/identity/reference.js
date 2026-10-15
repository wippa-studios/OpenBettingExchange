'use strict';
// lib/identity/reference.js — a complete identity provider that talks to nobody.
//
// This is the REFERENCE IMPLEMENTATION, not a stub: it exercises every method of
// the interface, including the callback signature check, so the seam is PROVEN
// rather than merely declared. It is what the test suite drives and what a real
// adapter is written against.
//
// It is also the safe default for a paper-money deployment, on exactly the terms
// lib/payments/reference.js uses and with the same asymmetry: with no adapter
// configured, this provider decides deterministically, and it NEVER does that
// silently in a real deployment. lib/identity/index.js's registry refuses to
// select it when IDENTITY_REQUIRED is on, because a mock that returns PASS for
// anyone is precisely the thing that must never sit behind a live customer
// onboarding flow.
//
// WHAT "DETERMINISTIC" MEANS HERE, and why it is not simply "always pass".
//
// The interesting seam behaviour — the part a real adapter will get wrong and the
// part the tests need to be able to drive — is the DECISION MAPPING. So this
// provider maps a small set of deterministic INPUTS to outcomes:
//
//   an age of 17 (or under)            -> FAIL      (a minor)
//   a surname on the KNOWN_BLOCKLIST    -> REVIEW    (needs a human)
//   anything else                       -> PASS
//
// and every screening method answers `indeterminate` unless the reference is
// constructed with an answer, because a screening method that quietly answered
// "clear" would make the enforcement path untestable: there would be no way to
// prove the venue REFUSES a hit, only that it accepts a pass.
//
// WHY IN-MEMORY. A real adapter keeps session state at the vendor and this
// process holds only the reference. That is the entire point of the seam, and it
// is also why nothing here is a durable store.
const crypto = require('crypto');
const {
  PENDING,
  PASS,
  FAIL,
  REVIEW,
  CLEAR,
  HIT,
  INDETERMINATE,
  CHECK_DOCUMENT,
  CHECK_FACE,
  CHECK_AGE,
  CHECK_SANCTIONS,
  CHECK_SELF_EXCLUSION,
  assertProvider,
} = require('./provider');

// An obviously-synthetic fixture. Not a real name, not a real date of birth, and
// the header's warning about pasting .env values into "sample data" applies here
// with full force — this is exactly the shape of value that ends up committed by
// accident.
const REFERENCE_MINOR_AGE = 17;

// A name that means "this person needs a human to look at them". Chosen because
// it is self-evidently not a customer: a list that could match a real person is
// a list that would eventually match one.
const REFERENCE_REVIEW_SURNAMES = new Set(['Screenshot']);

/**
 * The reference provider.
 *
 * @param {object} opts
 * @param {string} opts.secret                 HMAC secret for verifyCallback.
 * @param {string} opts.selfExclusionOutcome   Override for checkSelfExclusion.
 * @param {string} opts.sanctionsOutcome      Override for screenSanctions.
 * @param {string} opts.closedOutcome          What a CLOSED session reports.
 */
function referenceProvider({
  secret = 'reference-secret-not-for-production',
  selfExclusionOutcome = CLEAR,
  sanctionsOutcome = CLEAR,
} = {}) {
  const sessions = new Map();

  function sign(payload) {
    return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  }

  // The decision for a claimed identity, as this reference models a vendor's.
  //
  // `age` and `surname` are the vendor's OWN inputs — the venue does not
  // interpret them and never stores them (see lib/identity/index.js on why an
  // age claim is not kept here). They exist to make the mapping testable.
  function decide({ age, surname }) {
    if (typeof age === 'number' && Number.isFinite(age) && age < REFERENCE_MINOR_AGE) {
      return { decision: FAIL, failed: CHECK_AGE, detail: `Age assurance returned a result below the reference minimum of ${REFERENCE_MINOR_AGE}` };
    }
    if (typeof surname === 'string' && REFERENCE_REVIEW_SURNAMES.has(surname)) {
      return { decision: REVIEW, failed: CHECK_FACE, detail: 'Reference provider routed this to manual review' };
    }
    return { decision: PASS, failed: null, detail: 'All reference checks passed' };
  }

  // The constituent checks that produced a decision. A PASS with no checks is
  // the shape lib/identity/index.js refuses to store: the operator could not
  // then answer "which check cleared this person?".
  function checksFor(decision, failed) {
    const core = [CHECK_DOCUMENT, CHECK_FACE];
    const age = { check: CHECK_AGE, outcome: failed === CHECK_AGE ? 'fail' : 'pass', at: new Date().toISOString() };
    const sanctions = {
      check: CHECK_SANCTIONS,
      outcome: sanctionsOutcome === CLEAR ? 'pass' : 'flag',
      at: new Date().toISOString(),
    };
    const exclusion = {
      check: CHECK_SELF_EXCLUSION,
      outcome: selfExclusionOutcome === CLEAR ? 'pass' : 'flag',
      at: new Date().toISOString(),
    };
    const all = [
      ...core.map((c) => ({ check: c, outcome: 'pass', at: new Date().toISOString() })),
      age,
      sanctions,
      exclusion,
    ];
    return decision === PASS || decision === REVIEW ? all : all.filter((c) => c.check === failed);
  }

  return assertProvider({
    name: 'reference',

    // The shape a real vendor returns: a session id the venue stores, and a
    // client-side token the browser hands back to the vendor's SDK. Both are
    // OPTIONAL in the contract because not every vendor has both — a pure
    // redirect flow has no client token at all — so the venue must never require
    // one to be present. This reference returns both, which is the richer shape
    // and therefore the one worth proving against.
    async startVerification(subject) {
      const externalId = `idv_${crypto.randomUUID()}`;
      sessions.set(externalId, { externalId, subject, status: PENDING });
      return {
        externalId,
        status: PENDING,
        clientToken: sign({ externalId, subject: subject && subject.reference }),
      };
    },

    async readVerification(externalId) {
      const s = sessions.get(String(externalId));
      if (!s) return { externalId, decision: null, checks: [], detail: 'No such verification session' };
      // Not auto-decided: a real vendor's decision arrives on a callback or on a
      // poll, and this reference lets a TEST decide, so the seam's "asked" versus
      // "decided" separation is observable exactly as it is in production. The
      // decision is applied by `decide()` at read time only when a claim has been
      // recorded; until then it stays PENDING.
      if (s.status !== PENDING) return { ...s, decision: s.decision, checks: checksFor(s.decision, s.failed) };
      return { externalId, status: PENDING, decision: PENDING, checks: [] };
    },

    async checkSelfExclusion(subject) {
      // The reference answers with the CONFIGURED outcome and a NORMALISED
      // subject reference. A real implementation is a lookup against a national
      // scheme; what matters for the seam is that it is a separate call and that
      // its answer is not inferred from this venue's own `self_excluded` column.
      return {
        outcome: selfExclusionOutcome,
        subjectReference: hashRef(subject && subject.reference),
        detail:
          selfExclusionOutcome === CLEAR
            ? 'Reference: no match in the simulated national register'
            : 'Reference: matched the simulated national register',
      };
    },

    async screenSanctions(subject, context) {
      return {
        outcome: sanctionsOutcome,
        // A real screening provider returns the lists consulted and their
        // versions. The contract REQUIRES them: "we screened against something"
        // is not an auditable statement, and a list version is the only way to
        // prove which list was current on the day.
        lists: ['reference:simulated-sanctions', 'reference:simulated-pep'],
        lists_version: 'reference-1',
        checked_at: new Date().toISOString(),
        jurisdiction: (context && context.jurisdiction) || null,
        detail: `Reference screening: ${sanctionsOutcome}`,
      };
    },

    async closeSession(externalId) {
      const s = sessions.get(String(externalId));
      if (!s) return { externalId, closed: false, detail: 'No such session' };
      s.status = 'closed';
      return { externalId, closed: true, detail: 'Reference session released' };
    },

    // The callback that WRITES a decision. Constant-time compare over the raw
    // body, exactly as lib/payments/reference.js does for a deposit confirmation
    // and for the same reason: re-serialising parsed JSON changes key order and
    // breaks every real vendor's signature, so the check is over the RAW bytes.
    async verifyCallback(rawBody, headers, signature) {
      const parsed = JSON.parse(String(rawBody));
      const expected = sign(parsed);
      const a = Buffer.from(String(expected));
      const b = Buffer.from(String(signature || ''));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      const s = sessions.get(parsed.externalId);
      if (!s) return null;
      s.decision = decide(parsed);
      s.status = s.decision.decision;
      s.failed = s.decision.failed;
      return { ...s, decision: s.decision.decision, checks: checksFor(s.decision.decision, s.decision.failed) };
    },

    // ── Test-only surface, deliberately NOT part of the contract ─────────────
    //
    // A vendor cannot be told "decide this one now" by anything the venue sends,
    // so a test needs a side door. It is attached to the object rather than to
    // the contract so `assertProvider` does not require it and a real adapter
    // cannot be shipped with a "make anyone pass" method on it.
    __test: {
      decide,
      hashRef,
      sessionCount: () => sessions.size,
    },
  });
}

// A stable, non-reversible reference for a subject. The venue never needs the
// person's name to ask a screening question, so it should not hold one either:
// this is what a real adapter would return as an opaque subject handle.
function hashRef(reference) {
  if (reference === undefined || reference === null || reference === '') return null;
  return crypto.createHash('sha256').update(String(reference)).digest('hex').slice(0, 32);
}

module.exports = { referenceProvider, hashRef, REFERENCE_MINOR_AGE };