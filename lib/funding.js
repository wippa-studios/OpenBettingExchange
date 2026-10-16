'use strict';
// lib/funding.js — WHAT PAID FOR THE ACCOUNT, and whether we will take it.
//
// WHY THIS MODULE EXISTS. AUSTRAC's statement against a large Australian
// operator in December 2024 made two findings that are about this and about
// nothing else in the codebase:
//
//   1. deposit channels enabled credits that "obscured or could obscure the
//      identity of the depositor or the source of money/funds", across EFT, BPAY,
//      debit card, credit card, digital wallets, PayPal, retail-bought prepaid
//      cards, the operator's own branded reloadable cards, and a loyalty product;
//   2. transaction monitoring did not detect "a person (a third party) other
//      than the person in whose name the betting account was held".
//
// The second is the one this module exists to catch, and catching it needs more
// than a name comparison, which is the part that is easy to get catastrophically
// wrong in the other direction.
//
// ── THE OSKO TRAP, WHICH IS THE WHOLE DESIGN OF THIS FILE ──────────────────
//
// On the NPP/Osko rail in Australia, an operator's RECEIVING PayID is normally
// registered to a PAYMENT PROCESSOR or INTERMEDIARY COMPANY, not to the venue.
// The processor pools the money and settles it onward. So the naive rule —
//
//     "the funding instrument's registered name must equal the account holder's"
//
// — is FALSE for every single legitimate Osko customer in the country. Ship it
// and the venue refuses all legitimate bank and PayID funding, and the operator
// discovers this in production on a Monday.
//
// So the comparison is not "name equals name". It is "WHOSE instrument is it",
// answered from a REGISTER the operator maintains:
//
//   owner_kind = 'venue'      -> the venue's own account.            CLEARED
//   owner_kind = 'processor'  -> a contracted processor's POOL, held on
//                                the venue's behalf.                   CLEARED
//   owner_kind = 'player'     -> an account holder's own instrument.
//                                The name MUST match.                   REFUSED
//                                on mismatch — that is the finding.
//   owner_kind = 'unknown'    -> nobody can say who owns it.          REFUSED
//
// 'unknown' is the fail-closed half and it is what makes this a control rather
// than a formality. An instrument whose ownership nobody can state IS the
// third-party case by definition; the alternative reading — "we don't know, so
// we'll allow it" — is the defect in its purest form.
//
// WHICH IS WHY THIS REGISTER SHIPS EMPTY. A venue going live must register its
// receiving accounts and its processor pools before it can accept anything, and
// an unregistered instrument is REFUSED (FUNDING_REFUSE_UNREGISTERED) rather
// than allowed. Exactly the posture lib/config.js takes for FEED_CREDENTIALS_KEY:
// "not configured" is refused, not treated as "allowed".
//
// ── WHY INTAKE, AND WHY IT MUST BE A REFUSAL ────────────────────────────────
//
// NPP/Osko transfers are IRREVOCABLE with no chargeback. Once a deposit has been
// accepted onto that rail it cannot be clawed back by anyone, including the
// venue and including the bank. That is exactly why this has to be a refusal
// AT INTAKE rather than a flag reviewed afterwards: a wrongly-accepted deposit on
// an irrevocable rail is money that arrived, that the venue credited, that no
// counterparty can reverse, and that a third party may have sent. There is no
// recovery step available at all, so the check either happens before the credit
// or it does not happen.
//
// Compare a card rail, where a chargeback exists and a reversal is possible. The
// asymmetry is the reason the two are treated differently, and it is the reason
// this module's refusals are recorded (lib/audit.js FUNDING_REFUSED) even though
// no money moved: the question an operator has to be able to answer is "was this
// attempted, and how often?", and a refusal that leaves no trace is not a
// control, it is an absence.
//
// ── WHERE THE MONEY IS ──────────────────────────────────────────────────────
//
// NOT IN lib/payments/. The payment provider contract is out of scope for other
// work in flight and is not touched here — this module is a GATE that the
// existing paths call, plus the registry it compares against. It moves no money,
// opens no transaction it did not open as a caller, and changes nothing about
// how a deposit is created or confirmed.
//
// The gate is invoked from exactly one place on the credit path —
// lib/payments/index.js confirmDeposit(), immediately before ledger.deposit —
// for the reason the RG deposit limit is enforced there rather than at intent
// creation: a check that runs before the effect and consumes nothing is not a
// check on the effect. An intent created before the funds arrive cannot be
// screened against facts that do not exist yet.
const { httpError } = require('./auth');
const { transaction } = require('./tx');
const config = require('./config');
const audit = require('./audit');

// ── The instrument vocabulary ────────────────────────────────────────────────
const OWNER_VENUE = 'venue';
const OWNER_PROCESSOR = 'processor';
const OWNER_PLAYER = 'player';
const OWNER_UNKNOWN = 'unknown';
const OWNER_KINDS = [OWNER_VENUE, OWNER_PROCESSOR, OWNER_PLAYER, OWNER_UNKNOWN];

// The owner kinds that CLEAR a deposit regardless of the name on the rail.
//
// 'unknown' is absent, and that absence is the control. See the header.
const CLEARED_OWNER_KINDS = new Set([OWNER_VENUE, OWNER_PROCESSOR]);

/**
 * Fold a name for comparison.
 *
 * Casefolded, whitespace-collapsed, punctuation-stripped. Deliberately
 * conservative: it does NOT transliterate, does NOT reorder, and does NOT try to
 * match "Smith, John A." to "John A Smith". Names arrive from two systems that
 * disagree about punctuation and neither is wrong, and a fuzzy matcher here would
 * be a control whose behaviour nobody could explain to an analyst or to the
 * customer it refused.
 *
 * THE CONSEQUENCE IS STATED RATHER THAN HIDDEN: a name that differs by more than
 * case and spacing is a MISMATCH and the deposit is refused. Over-refusing a
 * borderline customer is the correct failure direction for an irrevocable rail,
 * and the remedy is a registered instrument or an operator decision — both of
 * which are audited acts, and neither of which is a guess.
 */
function foldName(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks so "José" and "Jose" compare equal. Everything else
    // is left alone: see above.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── The registered-instrument register ───────────────────────────────────────

function listInstruments(db, { tenantId } = {}) {
  const rows = tenantId
    ? db.prepare('SELECT * FROM funding_instruments WHERE tenant_id = ? ORDER BY label').all(tenantId)
    : db.prepare('SELECT * FROM funding_instruments ORDER BY tenant_id, label').all();
  return rows.map((r) => ({ ...r, enabled: !!r.enabled }));
}

/**
 * Look an instrument up by the name the RAIL reported.
 *
 * Matched on the FOLDED registered_owner rather than the raw string, for the
 * reason foldName gives. An exact SQL equality test here would miss every rail
 * that uppercases or re-spaces what it reports, and the operator would conclude
 * the control is broken rather than that the comparison was too strict.
 *
 * Returns EVERY match, not the first. Two rows with the same owner is a register
 * that needs an operator's attention, and picking one silently would hide it.
 */
function findInstrumentsByOwner(db, ownerName) {
  const folded = foldName(ownerName);
  if (!folded) return [];
  return listInstruments(db).filter((r) => r.enabled && foldName(r.registered_owner) === folded);
}

// ── Payment methods, and the terms under which the venue may use them ─────────

/**
 * List a tenant's payment methods, parsed.
 *
 * A method the venue may not use is still LISTED, with why — an operator
 * configuring this needs to see the method they were about to enable and the
 * reason it is refused, not an absence that reads as "I did not know that
 * existed".
 */
function listMethods(db, { tenantId } = {}) {
  const rows = tenantId
    ? db.prepare('SELECT * FROM payment_methods WHERE tenant_id = ? ORDER BY slug').all(tenantId)
    : db.prepare('SELECT * FROM payment_methods ORDER BY tenant_id, slug').all();
  return rows.map((r) => ({
    ...r,
    enabled: !!r.enabled,
    credit_linked: !!r.credit_linked,
    permitted_countries: parseCountries(r.permitted_countries),
  }));
}

function parseCountries(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((c) => String(c).toUpperCase()) : null;
  } catch {
    return null;
  }
}

/**
 * Record a payment method and the TERMS under which the venue may use it.
 *
 * THE REFUSAL THAT MATTERS IS THE LAST ONE: a wallet or a PayPal whose provider
 * restricts the merchant cannot be ENABLED without recording what the provider
 * requires. That is the difference between recording "PayPal" and recording
 * "PayPal, approved seller, Australian customers only" — and only the second is
 * a fact anything can be enforced against.
 *
 * Why it is specific to those two kinds rather than to all of them: a plain
 * bank transfer has no provider placing conditions on the merchant, so demanding
 * a seller status there would be a field nobody can fill in. The rule is
 * therefore "if your provider restricts you, you must record how", which is
 * expressible and true, rather than "fill this in", which is neither.
 */
function setMethod(db, { actor, tenantId, slug, label, kind, credit_linked = false, seller_status = null, permitted_countries = null, enabled = true, note = null }) {
  if (!PERMITTED_METHOD_KINDS.includes(kind)) {
    throw httpError(400, `kind must be one of ${PERMITTED_METHOD_KINDS.join(', ')}`);
  }
  if (seller_status !== null && !SELLER_STATUSES.includes(seller_status)) {
    throw httpError(400, `seller_status must be one of ${SELLER_STATUSES.join(', ')}`);
  }
  if (enabled && RESTRICTED_MERCHANT_KINDS.includes(kind) && !seller_status) {
    throw httpError(
      400,
      `${kind} cannot be enabled without recording seller_status. "PayPal" and "PayPal, approved ` +
        'seller, Australian customers only" are different facts, and only the second is one that ' +
        'anything can be enforced against.',
      { code: 'payment_method_terms_required' }
    );
  }
  if (permitted_countries !== null && !Array.isArray(permitted_countries)) {
    throw httpError(400, 'permitted_countries must be an array of ISO country codes or null');
  }
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO payment_methods (tenant_id, slug, label, kind, credit_linked, seller_status, permitted_countries, enabled, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, slug) DO UPDATE SET
         label = excluded.label, kind = excluded.kind, credit_linked = excluded.credit_linked,
         seller_status = excluded.seller_status, permitted_countries = excluded.permitted_countries,
         enabled = excluded.enabled, note = excluded.note, updated_at = datetime('now')`
    ).run(
      tenantId,
      String(slug).trim(),
      label,
      kind,
      credit_linked ? 1 : 0,
      seller_status,
      permitted_countries === null ? null : JSON.stringify(permitted_countries.map((c) => String(c).toUpperCase())),
      enabled ? 1 : 0,
      note
    );
    audit.record(db, actor, audit.ACTIONS.PAYMENT_METHOD_CONFIGURED, `payment_method:${tenantId}/${slug}`,
      null, { kind, credit_linked: !!credit_linked, seller_status, enabled: !!enabled },
      'payment method terms configured');
    const row = db.prepare('SELECT * FROM payment_methods WHERE tenant_id = ? AND slug = ?').get(tenantId, slug);
    return { ...row, enabled: !!row.enabled, credit_linked: !!row.credit_linked, permitted_countries: parseCountries(row.permitted_countries) };
  });
}

// The closed kind vocabulary, in one place, and SHARED by the setter and the
// reader so the two cannot disagree — the same rule lib/limits.js holds for its
// scope vocabulary.
const PERMITTED_METHOD_KINDS = [
  'bank_transfer', 'debit_card', 'credit_card', 'wallet', 'prepaid', 'paypal', 'bpay', 'other',
];
const SELLER_STATUSES = ['approved_seller', 'restricted_seller'];
// The kinds whose providers place conditions on the merchant.
const RESTRICTED_MERCHANT_KINDS = ['paypal', 'wallet'];

/**
 * Register a funding instrument.
 *
 * `owner_kind` is the field that makes the Osko case work and the third-party
 * case detectable, and the register REQUIRES the operator to say which they mean
 * rather than inferring it. There is no default: a row with `owner_kind =
 * 'unknown'` has to be typed deliberately, and it is the honest way to record
 * "we genuinely cannot say" — which then REFUSES deposits, loudly, instead of
 * quietly allowing them.
 */
function registerInstrument(db, { actor, tenantId, label, instrument_kind, registered_owner, owner_kind, processor_ref = null, jurisdiction = null, enabled = true, notes = null }) {
  if (!OWNER_KINDS.includes(owner_kind)) {
    throw httpError(400, `owner_kind must be one of ${OWNER_KINDS.join(', ')}`);
  }
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO funding_instruments (tenant_id, label, instrument_kind, registered_owner, owner_kind, processor_ref, jurisdiction, enabled, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(tenantId, label, instrument_kind, registered_owner, owner_kind, processor_ref, jurisdiction, enabled ? 1 : 0, notes);
    audit.record(db, actor, audit.ACTIONS.FUNDING_INSTRUMENT_REGISTERED, `funding_instrument:${tenantId}`,
      null, { label, instrument_kind, owner_kind, processor_ref }, 'funding instrument registered');
    const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    return db.prepare('SELECT * FROM funding_instruments WHERE id = ?').get(id);
  });
}

/** Disable a registered instrument. Revoking a processor, not deleting history. */
function disableInstrument(db, { actor, id, reason }) {
  if (!reason || String(reason).trim().length < 5) {
    throw httpError(400, 'A written reason is required');
  }
  const row = db.prepare('SELECT * FROM funding_instruments WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'Funding instrument not found');
  return transaction(db, () => {
    db.prepare("UPDATE funding_instruments SET enabled = 0, updated_at = datetime('now') WHERE id = ?").run(id);
    audit.record(db, actor, audit.ACTIONS.FUNDING_INSTRUMENT_REGISTERED, `funding_instrument:${id}`,
      { enabled: 1 }, { enabled: 0 }, reason);
    return { id, enabled: false };
  });
}

// ── THE GATE ─────────────────────────────────────────────────────────────────

/**
 * May we accept this deposit?
 *
 * Everything it checks is a REFUSAL, and each refusal carries a DISTINCT
 * machine-readable `code`, for the reason lib/limits.js states about its own
 * refusals: the client has to render different advice for each, and the refusal
 * has to be diagnosable from the response alone. A single generic "deposit not
 * allowed" would be indistinguishable from six different problems and would send
 * the customer — and the operator's support desk — to the wrong place.
 *
 * THE ORDER IS DELIBERATE and it is cheapest-and-most-fundamental first:
 *
 *   1. THE METHOD IS USABLE AT ALL. A method the venue is not permitted to take
 *      is refused before anything about this particular deposit is read, because
 *      no fact about one deposit can make an unusable method usable.
 *   2. THE CREDIT RULE. One Australian operator prohibits credit cards AND any
 *      payment method linked to a credit card — including digital wallets and
 *      BPAY — for online wagering, while leaving debit cards unaffected. So this
 *      is a property of the METHOD (`credit_linked`) rather than of its name:
 *      "accepts Apple Pay" and "accepts a credit-linked instrument" are
 *      different answers and one kind column cannot express both.
 *   3. THE SELLER TERMS. A provider that restricts the merchant must have those
 *      terms recorded, and the recorded countries are enforced — which is how
 *      "approved seller, AU customers only" stops being a note in a spreadsheet.
 *   4. THE RESTRICTED JURISDICTION LIST. Where the MONEY came from, which is not
 *      the same question as where the customer PLAYED — lib/tenants.js answers
 *      that one at session creation and this one is a different fact.
 *   5. THE INSTRUMENT'S OWNER. The Osko trap, resolved above.
 *   6. THE THIRD-PARTY NAME MATCH. Last, because it is the only one that needs a
 *      customer identity to compare against, and steps 1-5 are all decidable
 *      without knowing who the customer is.
 *
 * NOT THROWN WHEN THE CONTROL IS OFF. `config.FUNDING_REFUSE_UNREGISTERED` is the
 * one switch here, and it governs ONLY step 5's unregistered case. Everything
 * else is unconditional: a disabled method is disabled whether or not this key is
 * set, because "monitoring is off" is not a reason to accept a credit card.
 */
function assertDepositFunded(db, { actor, userId, methodSlug, payerName, fundingCountry, instrumentId = null, subjectName = null }) {
  // A PAPER-MONEY INSTALL HAS NO FUNDING TO INSPECT.
  //
  // Every deposit on a venue that has not declared itself regulated is synthetic:
  // a faucet credit or a reference-provider confirmation. There is no payment
  // instrument, no registered owner, and nothing to compare a payer name against.
  // Running the gate anyway would refuse every deposit on such a venue — which is
  // not a control, it is a bug, and it is why this switch is read FIRST and
  // separately from FUNDING_REFUSE_UNREGISTERED.
  //
  // The two are separate because they answer different questions:
  // FUNDING_REFUSE_UNREGISTERED asks "on a REAL venue, may we accept an
  // instrument nobody has registered?", and REGULATED_DEPLOYMENT asks "is there
  // anything real to inspect at all?". An operator who has declared themselves
  // regulated may still deliberately permit unregistered instruments during a
  // migration, and that is their call to make explicitly.
  if (!config.REGULATED_DEPLOYMENT) {
    return { regulated: false, tenant_id: null, method: null, instrument: null };
  }
  const tenants = require('./tenants');
  // Resolved THROUGH lib/tenants rather than by reading users.tenant_id here,
  // because a NULL tenant_id means "the default tenant" in this codebase and a
  // raw read would hand this module a null where every method and instrument row
  // has a real tenant id. Every other money module in the repository resolves
  // tenancy the same way.
  const tenant = tenants.ofUser(db, userId);
  const tenantId = tenant ? tenant.id : null;

  // ── 1. the method ─────────────────────────────────────────────────────────
  const method = methodSlug ? db.prepare('SELECT * FROM payment_methods WHERE tenant_id = ? AND slug = ?').get(tenantId, methodSlug) : null;
  if (methodSlug && !method) {
    throw refuse('payment_method_unknown', `Unknown payment method "${methodSlug}"`);
  }
  if (method && !method.enabled) {
    throw refuse('payment_method_disabled', 'That payment method is not currently accepted');
  }

  // ── 2. credit ────────────────────────────────────────────────────────────
  //
  // Set by the operator against their own policy, per method. This codebase does
  // not ship a rule about which methods are credit-linked, because it does not
  // know the operator's acquiring arrangements — it knows only that the
  // distinction has to be EXPRESSIBLE, and a `kind` column alone cannot express
  // it (a wallet can be debit-funded or credit-linked and is the same wallet).
  if (method && method.credit_linked) {
    throw refuse('credit_linked_method_prohibited',
      'This payment method draws on credit and cannot be used for online wagering deposits');
  }

  // ── 3. seller terms ──────────────────────────────────────────────────────
  if (method && RESTRICTED_MERCHANT_KINDS.includes(method.kind) && !method.seller_status) {
    throw refuse('payment_method_terms_unrecorded',
      'The terms under which this payment provider may be used have not been recorded');
  }
  if (method && payerOrFundingCountryIsOutside(method, fundingCountry)) {
    throw refuse('funding_country_not_permitted',
      'This payment provider may not be used to accept funding from that country');
  }

  // ── 4. restricted jurisdictions ──────────────────────────────────────────
  //
  // DISTINCT FROM THE SESSION GATE, and deliberately. lib/tenants.js refuses a
  // session created from a blocked jurisdiction, which answers "where does this
  // person PLAY". A regulator treats "where does the MONEY come from" as a
  // separate fact, and it is separate in the data: a customer sitting in Sydney
  // can fund the account from an account abroad, and nothing about their session
  // shows it. The two controls share a vocabulary and no code.
  if (isRestricted(fundingCountry)) {
    throw refuse('restricted_funding_jurisdiction',
      'The venue does not accept funding from that country');
  }

  // ── 5. the instrument's owner ────────────────────────────────────────────
  //
  // An explicit instrument id is the strongest signal and wins; otherwise the
  // rail's reported name is looked up in the register.
  const instrument = instrumentId
    ? db.prepare('SELECT * FROM funding_instruments WHERE id = ?').get(instrumentId)
    : payerName
      ? findInstrumentsByOwner(db, payerName)[0] || null
      : null;

  if (!instrument) {
    if (config.FUNDING_REFUSE_UNREGISTERED) {
      throw refuse('funding_instrument_unregistered',
        'The funding instrument for this deposit is not registered with the venue. ' +
          'Deposits can only be accepted from a registered account or from a contracted ' +
          "processor's pool on the venue's behalf.",
        { payer_name: payerName || null });
    }
    // Permitted by configuration. The audit row still lands, because "we do not
    // know who this is and we allowed it" is a fact an operator needs to be able
    // to count.
    audit.record(db, actor, audit.ACTIONS.FUNDING_REFUSED, `user:${userId}`,
      null, { allowed_unregistered: true, payer_name: payerName || null },
      'FUNDING_REFUSE_UNREGISTERED=false — unregistered instrument allowed by configuration');
  } else if (!instrument.enabled) {
    throw refuse('funding_instrument_disabled',
      'The funding instrument for this deposit is not currently accepted');
  } else if (!CLEARED_OWNER_KINDS.has(instrument.owner_kind)) {
    // 'unknown' and 'player' both land here. 'player' is the one that needs the
    // name comparison below, and it is deliberately NOT short-circuited: an
    // instrument registered to a PLAYER is only this account's if the names
    // match.
    if (instrument.owner_kind === OWNER_PLAYER) {
      const mismatch = nameMismatch(payerName, subjectName);
      if (mismatch) {
        throw refuse('funding_instrument_third_party',
          'The funding instrument is registered to a different name than the account holder',
          { payer_name: payerName || null, instrument_id: instrument.id });
      }
    } else {
      throw refuse('funding_instrument_owner_unknown',
        'The funding instrument has no registered owner the venue can name',
        { instrument_id: instrument.id });
    }
  }

  return { tenant_id: tenantId, method: method || null, instrument: instrument || null };
}

/**
 * The third-party finding, stated precisely.
 *
 * Returns a short reason string when the names do NOT match, or null when they
 * do. Two things it will NOT do:
 *
 *   - it will not treat a MISSING name as a match. If the rail reported no
 *     payer name and the account has a verified subject name, there is nothing to
 *     compare and the honest answer is that the check could not be made. That
 *     surfaces as its own refusal rather than being rounded to "fine" — the
 *     alternative is a control that reports success on the cases it could not
 *     see, which is worse than a control that reports nothing.
 *   - it will not fuzzy-match. See foldName.
 */
function nameMismatch(payerName, subjectName) {
  const payer = foldName(payerName);
  const subject = foldName(subjectName);
  if (!payer) return 'payer-name-not-reported';
  if (!subject) return 'subject-name-unavailable';
  return payer === subject ? null : 'payer-name-differs-from-account-holder';
}

// Where the money came from, which is what a sender-controlled header claims and
// what the venue's own configuration and the tenant's allowlist constrain. It is
// NOT `users`' idea of where the customer is.
function fundingCountryOf(intent) {
  return intent && intent.funding_country ? String(intent.funding_country).toUpperCase() : null;
}

/**
 * May we PAY OUT to this country?
 *
 * The withdrawal-side half of the funding gate, and it is SEPARATE from
 * `assertDepositFunded` on purpose: a customer may legitimately be funded
 * domestically and paid out to a family member abroad, and a customer funded from
 * one country may be paid out to another. Coupling them would refuse a real
 * payout for a fact about the deposit.
 *
 * What it refuses is only a country on the operator's restricted list, and it
 * refuses it BEFORE the hold is taken — see lib/payments/index.js openWithdrawal
 * for why a payout is the one place where the self-exclusion "promise about play,
 * not about custody" reasoning does not transfer.
 *
 * A NULL country is ALLOWED, and the reason is written out in the caller: at the
 * point a withdrawal is opened the payout has often not been instructed yet, so
 * many providers report the beneficiary later. Forcing a country at this point
 * would make venues invent one, and a fabricated country compared against a
 * restricted list is worse than an absent one. The retrospective indicator rule
 * catches the rest.
 */
function assertWithdrawalDestination(db, { userId, beneficiaryCountry }) {
  // Same paper-money posture as assertDepositFunded: with no restricted list
  // configured there is nothing to refuse, and on a venue that has not declared
  // itself regulated there is nothing real to refuse it on.
  if (!beneficiaryCountry || !config.REGULATED_DEPLOYMENT) return { beneficiary_country: beneficiaryCountry || null, regulated: !!config.REGULATED_DEPLOYMENT };
  const c = String(beneficiaryCountry).toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) {
    throw refuse('beneficiary_country_invalid', 'beneficiary_country must be a two-letter country code', { beneficiary_country: beneficiaryCountry });
  }
  if (isRestricted(c)) {
    // Recorded OUTSIDE the payout transaction, by the caller, for the same reason
    // as a deposit refusal: a row written inside the transaction that the refusal
    // rolls back does not survive it.
    throw refuse('restricted_payout_jurisdiction', 'The venue does not pay out to that country', { beneficiary_country: c });
  }
  return { beneficiary_country: c };
}

function isRestricted(country) {
  if (!country) return false;
  return config.AML_RESTRICTED_JURISDICTIONS.includes(String(country).toUpperCase());
}

function payerOrFundingCountryIsOutside(method, fundingCountry) {
  const permitted = parseCountries(method.permitted_countries);
  if (!permitted || !permitted.length) return false;
  const c = String(fundingCountry || '').toUpperCase();
  // An ABSENT country cannot satisfy a country allowlist, and saying so is the
  // point of recording one: "approved seller, Australian customers only" is
  // unenforceable if an absent country is treated as permitted.
  return !c || !permitted.includes(c);
}

/**
 * Build the refusal.
 *
 * It only BUILDS one. It does not write the audit row, and that is a structural
 * point rather than an oversight: `assertDepositFunded` is called from inside
 * `confirmDeposit`'s transaction, so an audit row written here would be rolled
 * back by the very refusal that wrote it — which is precisely the defect
 * lib/limits.js's header records about persisted order refusals. The record of
 * the attempt therefore has to be written by the CALLER, after the transaction has
 * unwound. See recordRefusal, and its caller in server.js.
 *
 * Every code here is DISTINCT and stable, because the client renders different
 * advice per code and a support desk triages on it. They are part of the API
 * contract, not prose.
 */
function refuse(code, message, extra = {}) {
  return httpError(403, message, { code, ...extra });
}

/**
 * Record a refusal. Called by the CALLER, after the transaction has rolled back.
 *
 * This is the other half of `refuse`'s design note: the gate builds an error and
 * throws, and the caller records what happened once the transaction has unwound.
 * The audit row therefore survives the refusal that produced it, which is the only
 * place from which "was this attempted, and how often?" is answerable — a row
 * written inside the transaction would be rolled back with it.
 *
 * NO MONEY MOVED, and the row exists anyway. An accepted deposit on an
 * irrevocable rail cannot be reversed; an attempted one that was refused is the
 * fact an operator needs to be able to count, and a refusal that leaves no trace
 * is an absence rather than a control.
 */
function recordRefusal(db, { actor, userId, code, detail = null }) {
  audit.record(db, actor, audit.ACTIONS.FUNDING_REFUSED, `user:${userId}`,
    null, { code, detail: detail || null }, 'deposit refused at intake');
  return { refused: true, code };
}

module.exports = {
  OWNER_VENUE,
  OWNER_PROCESSOR,
  OWNER_PLAYER,
  OWNER_UNKNOWN,
  OWNER_KINDS,
  PERMITTED_METHOD_KINDS,
  SELLER_STATUSES,
  RESTRICTED_MERCHANT_KINDS,
  foldName,
  listInstruments,
  findInstrumentsByOwner,
  listMethods,
  setMethod,
  registerInstrument,
  disableInstrument,
  assertDepositFunded,
  assertWithdrawalDestination,
  recordRefusal,
  nameMismatch,
  isRestricted,
  fundingCountryOf,
};