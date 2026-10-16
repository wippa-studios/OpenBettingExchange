'use strict';
// lib/identity/provider.js — the identity/verification provider INTERFACE.
//
// NO PROVIDER IS BUILT IN, and that is a deliberate deliverable boundary on the
// same grounds lib/payments/provider.js sets out, not because we ran out of time.
//
// Gambling is a RESTRICTED CATEGORY for identity providers. Which vendor an
// Australian venue may use is not a technical question: the AML/CTF obligations
// attach to the VENUE, and the vendor contract, the data residency, the
// screening lists and the audit rights are exactly the things an operator's
// counsel has already negotiated. Shipping a specific provider would be shipping
// OUR guess at their compliance position — the same mistake as shipping a PSP.
//
// So the deliverable is the SEAM plus the CONTRACT, and the reference
// implementation next door proves the seam works end to end without a network.
//
// ── WHAT THE CONTRACT HAS TO COVER, AND WHY EACH METHOD EXISTS ─────────────
//
//   startVerification  Begin a KYC run for a prospective customer and hand back
//                      whatever the vendor needs on the client side. Almost
//                      every KYC vendor is a redirect-or-SDK flow: the venue
//                      cannot make the decision itself, so the method that
//                      creates a vendor session is the first thing it needs.
//
//   readVerification   Read the OUTCOME plus the individual CHECKS that produced
//                      it. Not just "pass". A decision with no constituent
//                      checks is unusable: when a customer disputes the refusal
//                      — and they will — the operator has to be able to say WHICH
//                      check failed, months later, from its own record.
//
//   checkSelfExclusion Australia runs a NATIONAL self-exclusion scheme, so the
//                      question "is this person already excluded somewhere I
//                      cannot see?" is not answerable from this venue's own
//                      `users.self_excluded` column. That column is the venue's
//                      own record and knows nothing about any other operator.
//
//   screenSanctions     Sanctions and politically-exposed-person screening. A
//                      different obligation with a different cadence (lists
//                      move; a KYC decision does not) and a different failure
//                      mode, so it is a separate method rather than a flag.
//
//   closeSession        Tear a vendor session down. A prospective customer who
//                      abandons the flow must not leave a live session at the
//                      vendor, and the venue needs the ability to end one it can
//                      no longer complete.
//
//   verifyCallback      REQUIRED even though nothing calls it yet — see below.
//
// ── WHY verifyCallback IS REQUIRED FROM DAY ONE ────────────────────────────
//
// lib/payments/provider.js makes the same argument for its webhook method, and
// it is the same argument: the part that is easy to get wrong and impossible to
// retrofit safely is the one you are tempted to leave for later. A KYC vendor's
// callback is the path that WRITES A DECISION. Add it after the first incident
// and every signature check has to be re-derived under time pressure, and the
// first version written under time pressure is the one that trusts the header.
//
// It is in the contract precisely so that a half-implemented provider fails at
// BOOT (see assertProvider) rather than at the first customer.
//
// ── THE DECISION VOCABULARY IS CLOSED ───────────────────────────────────────
//
// Not an enum for tidiness. `if (result.decision === 'pass')` written by an
// implementer who spelled it 'PASS' silently reads as a failure and refuses
// every customer, with nothing in the log to say why. A closed vocabulary means
// the reconciler, the admin desk and the enforcement gate can all reason about a
// decision without string-matching vendor-specific wording — which is the whole
// reason lib/payments/provider.js closes its status set the same way.
//
// Note what is NOT in it: 'approved'. A verification decision here is about
// IDENTITY and ELIGIBILITY, never about whether the venue is happy to open an
// account. Those are different decisions with different owners and different
// appeal paths, and merging them is how a compliance function quietly becomes a
// commercial one.
const PENDING = 'pending';
const PASS = 'pass';
const FAIL = 'fail';
const REVIEW = 'review';
const EXPIRED = 'expired';
const CLOSED = 'closed';
const DECISIONS = [PENDING, PASS, FAIL, REVIEW, EXPIRED, CLOSED];

// The INDIVIDUAL CHECKS a verification may consist of. Also closed, and
// deliberately SEPARATE from the decision above: a vendor that returns
// { decision: 'review', checks: [{ name: 'document_forgery', ... }] } is
// telling the operator something the decision alone cannot. An open
// `name` vocabulary is required here because vendors DO publish their own check
// names and refusing them would make the seam unusable — so the rule is that the
// venue STORES the vendor's name verbatim alongside, never instead of, its own
// normalisation. See lib/identity/index.js: `checkName`.
//
// WHAT `CHECK_AGE` IS NOT ASSUMED TO BE, and this belongs at the point the
// contract is declared rather than at the point a column is written.
//
// It is tempting to read it as "the venue received a government document and
// checked the date on it". That assumption is probably WRONG, and the contract is
// built so it costs nothing if it is. The reform bill's explanatory memorandum
// addresses age assurance separately from identity and provides that no Australian
// is to be forced to use government identification — including Digital ID — for
// it. A privacy-preserving digital-identity network built for exactly that purpose
// asserts that a person is over 18 WITHOUT the venue ever receiving a document, a
// photograph or an identifier of any kind; that is the whole point of the design,
// and it matches the bill's own safeguard.
//
// So the contract says nothing about an artefact. It requires an OUTCOME and, if
// the vendor returns one, a `method` and an `assurance` level — and the
// `age_assurance` table in lib/store.js holds an attestation with no document
// field in it at all. If a vendor DOES hand over a document, the venue records
// that it did and destroys the artefact on use; it does not keep one.
const CHECK_DOCUMENT = 'document';
const CHECK_FACE = 'face_liveness';
const CHECK_ADDRESS = 'address';
const CHECK_AGE = 'age_assurance';
const CHECK_SANCTIONS = 'sanctions_pep';
const CHECK_SELF_EXCLUSION = 'self_exclusion_register';
const CORE_CHECKS = [
  CHECK_DOCUMENT,
  CHECK_FACE,
  CHECK_ADDRESS,
  CHECK_AGE,
  CHECK_SANCTIONS,
  CHECK_SELF_EXCLUSION,
];

// Screening outcomes. Separate from DECISIONS on purpose. A sanctions hit is not
// a verification failure and must never be recorded as one: the verification is
// still validly decided, the customer is still who they said they were, and the
// two facts have to stay separable for the report and for the appeal.
const CLEAR = 'clear';
const HIT = 'hit';
const INDETERMINATE = 'indeterminate';
const SCREEN_OUTCOMES = [CLEAR, HIT, INDETERMINATE];

/**
 * Assert an object implements the contract. Called by the registry on
 * registration so a half-implemented provider fails at BOOT, loudly, rather
 * than at the first real customer.
 *
 * This is the whole reason the interface exists, and lib/payments/provider.js
 * already argued it: a missing method must be a startup crash, never a runtime
 * surprise on someone's identity — or, worse, a silent PASS because the caller
 * treated an absent method as "nothing to check".
 */
function assertProvider(p) {
  if (!p || typeof p !== 'object') throw new Error('identity: provider must be an object');
  if (typeof p.name !== 'string' || !p.name) throw new Error('identity: provider needs a name');
  const required = [
    'startVerification',
    'readVerification',
    'checkSelfExclusion',
    'screenSanctions',
    'closeSession',
    'verifyCallback',
  ];
  const missing = required.filter((m) => typeof p[m] !== 'function');
  if (missing.length) {
    throw new Error(`identity: provider "${p.name}" is missing ${missing.join(', ')}`);
  }
  return p;
}

// Normalise a decision a provider returned, or throw.
//
// THROWS rather than passing the value through, and that is the load-bearing
// half. A decision outside the closed set means the provider and the venue
// disagree about a control that gates real money: if this returned the raw
// string, `assertVerified` would compare it against PASS, not match, and the
// customer's account would sit unverified with a row that says something else.
// A loud failure at the seam is the only place this can be caught.
function decisionOf(raw, providerName) {
  if (!DECISIONS.includes(raw)) {
    throw new Error(
      `identity: provider "${providerName}" returned an unrecognised decision ${JSON.stringify(raw)}; ` +
        `expected one of ${DECISIONS.join(', ')}. The provider must map its own vocabulary onto the venue's.`
    );
  }
  return raw;
}

function screenOutcomeOf(raw, providerName) {
  if (!SCREEN_OUTCOMES.includes(raw)) {
    throw new Error(
      `identity: provider "${providerName}" returned an unrecognised screening outcome ${JSON.stringify(raw)}; ` +
        `expected one of ${SCREEN_OUTCOMES.join(', ')}.`
    );
  }
  return raw;
}

module.exports = {
  PENDING,
  PASS,
  FAIL,
  REVIEW,
  EXPIRED,
  CLOSED,
  DECISIONS,
  CLEAR,
  HIT,
  INDETERMINATE,
  SCREEN_OUTCOMES,
  CHECK_DOCUMENT,
  CHECK_FACE,
  CHECK_ADDRESS,
  CHECK_AGE,
  CHECK_SANCTIONS,
  CHECK_SELF_EXCLUSION,
  CORE_CHECKS,
  assertProvider,
  decisionOf,
  screenOutcomeOf,
};