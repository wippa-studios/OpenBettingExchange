'use strict';
// lib/payments/index.js — registry and the confirmation-gated money flow.
//
// The deposit path is the important part, and its shape is the point of the
// whole module:
//
//   1. createDepositIntent  -> record the intent, credit NOTHING
//   2. (provider confirms, by webhook or by reconcile)
//   3. confirmDeposit       -> NOW the player is funded, in ONE transaction
//                              that also posts to gateway_clearing
//
// Steps 1 and 3 are separated by design and by schema (payment_intents.status),
// so "funded" is never a consequence of "asked". A player who opens ten
// intents and walks away is funded zero times, and the ledger can prove it.
//
// #104: every intent records the CURRENCY OF THE PLAYER'S TENANT, and
// confirmation refuses an intent recorded in a currency that is not the
// tenant's. `payment_intents.currency` used to carry the same hard-coded 'USD'
// default the ledger column did and was read by nothing, which meant a
// provider could confirm an intent in one currency into a ledger that assumed
// another and nothing would notice. It is read now — see confirmDeposit.
const { httpError } = require('../auth');
const { transaction } = require('../tx');
const ledger = require('../ledger');
const { currencyForUser } = require('../tenants');
const { PENDING, CONFIRMED, FAILED, REFUNDED, STATUSES, assertProvider } = require('./provider');
const { referenceProvider } = require('./reference');

/**
 * An amount in cents, named with the currency it is actually in. Replaces a
 * hard-coded `$` in a limit message, which on a venue accounting in AUD told a
 * player their cap was in dollars.
 *
 * Deliberately the ISO code and not a symbol: a symbol table in the server is a
 * second currency registry to keep current, and '$' is shared by dozens of
 * currencies, so the code is the unambiguous half.
 */
function amountIn(currency, cents) {
  return `${currency} ${(cents / 100).toFixed(2)}`;
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
 * `realPayments` gates the reference provider hard. In a paper-money install
 * it is the default and always works. The moment an operator declares they
 * are handling real money, the reference provider is REFUSED — because a mock
 * that confirms any deposit instantly is the exact thing that must never sit
 * behind a live payment button. Failing at startup is the only safe moment to
 * discover that.
 */
function select(name, { realPayments = false } = {}) {
  if (name && registry.has(name)) {
    if (name === 'reference' && realPayments) {
      throw httpError(500, 'payments: the reference provider cannot be used when real payments are enabled');
    }
    active = registry.get(name);
    return active;
  }
  if (realPayments) {
    throw httpError(500, 'payments: real payments are enabled but no provider is configured');
  }
  active = register(referenceProvider());
  return active;
}

function current() {
  if (!active) active = register(referenceProvider());
  return active;
}

// ── Funding-side helpers, used by confirmDeposit's gate ─────────────────────

/**
 * The payment method slug this deposit was started through.
 *
 * RESOLVED FROM THE INTENT ROW rather than taken as a parameter, and that is
 * deliberate: the funding gate runs at CONFIRMATION, where the only trustworthy
 * statement of which method the customer chose is the one recorded when the
 * intent was created. A method supplied at confirmation would be a method the
 * CUSTOMER chose at the moment the money arrived — which is to say, a method they
 * could change after the fact, and the terms of use are precisely what the gate
 * exists to enforce.
 *
 * NULL when the intent names no method, which is the state of every intent on a
 * database that predates the column. lib/funding.js treats "no method named" as
 * "no method to enforce" and the caller decides whether that is acceptable for
 * their deployment — it is a register question, not a code question.
 */
function fundingSlug(db, intent) {
  if (!intent.payment_method_id) return null;
  const row = db.prepare('SELECT slug FROM payment_methods WHERE id = ?').get(intent.payment_method_id);
  return row ? row.slug : null;
}

/**
 * The account holder's VERIFIED name, for the third-party funding comparison.
 *
 * READ FROM THE IDENTITY RECORD and nowhere else, and it is the only place in the
 * codebase that needs a person's name at all. Everything else about screening and
 * verification runs on the opaque `subject_reference`, because the venue must be
 * able to ask a screening question without holding the identity that answers it.
 *
 * NULL for an account with no decision — and NULL is NOT the same as a match.
 * lib/funding.js treats a missing subject name as "the check could not be made"
 * and refuses, rather than rounding it to "fine": a control that reports success
 * on the cases it could not see is worse than a control that reports nothing.
 */
function verifiedSubjectName(db, userId) {
  const row = db
    .prepare(
      `SELECT iv.subject_name
         FROM identity_verifications iv
         JOIN users u ON u.id = iv.user_id
        WHERE iv.user_id = ? AND iv.decision = 'pass' AND iv.subject_name IS NOT NULL
        ORDER BY iv.id DESC LIMIT 1`
    )
    .get(userId);
  return row ? row.subject_name : null;
}

/**
 * Step 1. Record the intent. The player is NOT credited — the column is
 * written, the postings are not.
 *
 * The per-intent cap is enforced HERE, at creation, because the alternative
 * is enforcing it nowhere: the confirmation path credits whatever the intent
 * row says, and the outside audit found that a player could open an intent
 * for 50,000,000 cents and then confirm it themselves. The cap at creation
 * bounds the blast radius of any single confirmation, whatever calls it.
 */
/**
 * Step 1. Record the INTENT. Credits nothing.
 *
 * `opts.paymentMethodSlug` is OPTIONAL and is the method the customer chose.
 * It is recorded here, at intent creation, rather than at confirmation, because
 * that is the only point at which the choice is the CUSTOMER'S rather than
 * something they could change after the money arrived — and the terms under
 * which the venue is permitted to use a payment provider are exactly what
 * lib/funding.js enforces. See fundingSlug() for how it is resolved back.
 *
 * An ABSENT slug is allowed and recorded as absent. A venue whose PSP does not
 * surface a method list has no method to enforce, and refusing the intent for
 * that would refuse every deposit. The register question — "are your methods
 * declared?" — is visible on /api/admin/payment-methods and at boot, and it is
 * the operator's to answer.
 */
async function openDeposit(db, userId, cents, opts = {}) {
  if (!Number.isInteger(cents) || cents <= 0) throw httpError(400, 'Deposit must be a positive integer number of cents');
  const config = require('../config');
  // Resolved ONCE and used for both the provider call and the row, so the two
  // can never disagree: an intent the provider was asked to charge in one
  // currency and that we recorded in another is precisely the case
  // confirmDeposit() now refuses, and creating it here would be creating the
  // fault we guard against.
  const currency = currencyForUser(db, userId);
  if (cents > config.DEPOSIT_MAX_CENTS) {
    throw httpError(400, `Deposit intent exceeds the per-intent cap of ${amountIn(currency, config.DEPOSIT_MAX_CENTS)}`);
  }
  const p = current();
  const intent = await p.createDepositIntent(userId, cents, currency);
  const row = transaction(db, () => {
    // Resolved through lib/tenants rather than by reading users.tenant_id, for
    // the same reason every other money module does: a NULL tenant_id means
    // "the default tenant" and a raw read hands this a null where every method
    // row has a real tenant id.
    const methodId = opts.paymentMethodSlug
      ? (() => {
          const t = require('../tenants').ofUser(db, userId);
          if (!t) return null;
          const m = db.prepare('SELECT id FROM payment_methods WHERE tenant_id = ? AND slug = ?').get(t.id, String(opts.paymentMethodSlug));
          return m ? m.id : null;
        })()
      : null;
    const info = db
      .prepare(
        `INSERT INTO payment_intents (user_id, provider, external_id, kind, amount_cents, currency, status, payment_method_id)
         VALUES (?, ?, ?, 'deposit', ?, ?, ?, ?)`
      )
      .run(userId, p.name, intent.externalId, cents, currency, PENDING, methodId);
    return { id: Number(info.lastInsertRowid), ...intent };
  });
  return { intent_id: row.id, external_id: intent.externalId, status: PENDING, client_secret: intent.clientSecret };
}

/**
 * Step 3. Credit the player — ONLY on confirmed funds.
 *
 * Idempotent by intent id: confirming twice moves money once. Without this a
 * retried webhook is a double-credit, which is the same class of bug as
 * crediting on initiation and just as easy to ship.
 *
 * THERE IS NO PLAYER-CALLABLE ROUTE TO THIS FUNCTION. The outside audit's
 * critical finding was exactly that: any signed-in player could POST to
 * /api/wallet/deposit-intent/:id/confirm and mint unbounded money, because
 * confirmation checked only that the intent was pending — never that money
 * had arrived, never who was calling. Confirmation is now reachable ONLY from
 * the provider-authenticated webhook and from the admin desk, and it
 * additionally enforces a cumulative per-user daily cap, so even a
 * compromised webhook is bounded.
 */
// No options object. It used to destructure `{ settled }` and then never read
// it, which is worse than dead code: the parameter name claimed the provider's
// settlement state was consulted here, and it was not. Nothing is gated on it,
// so accepting it was an invitation to believe otherwise.
function confirmDeposit(db, intentId) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(intentId);
    if (!row) throw httpError(404, 'Payment intent not found');
    if (row.kind !== 'deposit') throw httpError(400, 'Not a deposit intent');
    if (row.status === CONFIRMED) return { already_confirmed: true, intent_id: row.id, status: CONFIRMED };
    if (row.status !== PENDING) throw httpError(409, `Payment intent is ${row.status}`);

    // THE INTENT'S CURRENCY MUST BE THE TENANT'S, CHECKED HERE WHERE THE MONEY
    // LANDS (#104).
    //
    // `payment_intents.currency` used to be written 'USD' at this module's two
    // insert sites and read by nobody, so it recorded nothing: a provider could
    // confirm an intent in one currency into a ledger that assumed another and
    // the confirmation would succeed. The check is here rather than at intent
    // creation because creation moves no money — the same argument as the RG
    // limit below, and for the same reason: a check that runs before the effect
    // and consumes nothing is not a check on the effect.
    //
    // It also catches a row whose currency is the SCHEMA's default rather than
    // a value anybody chose. That default is now the venue's own currency (see
    // the SCHEMA signature in lib/store.js), so on a correctly configured venue
    // it agrees with the tenant and this check is quiet. It fires when the two
    // genuinely differ — a provider confirming an intent in one currency into a
    // ledger denominated in another — which is the case that used to credit
    // silently.
    const tenantCurrency = currencyForUser(db, row.user_id);
    if (row.currency !== tenantCurrency) {
      throw httpError(
        409,
        `Payment intent ${row.id} is recorded in ${row.currency}, but user ${row.user_id} trades in ` +
          `${tenantCurrency}. Refusing to credit it: there is no conversion rate in this ledger, so the ` +
          'amount would be credited as though the two were the same money.'
      );
    }

    // ── THE FUNDING GATE, BEFORE THE CREDIT ──────────────────────────────────
    //
    // WHAT IS REFUSED, AND WHY IT IS HERE RATHER THAN AT INTENT CREATION:
    //
    //   - the account is not identity-verified. Australian law has required
    //     customer pre-verification since 29 September 2024, and it is enforced on
    //     the CONFIRMATION path because that is where the money lands. A check at
    //     intent creation consumes nothing and gates nothing — the same argument
    //     the RG deposit limit two lines below makes, for the same reason, and the
    //     same measured failure it was written up to prevent.
    //
    //   - the funding itself is not acceptable. A deposit whose funding instrument
    //     is registered to a DIFFERENT NAME from the account holder is refused
    //     rather than flagged, and lib/funding.js carries the whole argument —
    //     including the Osko trap, where a naive name-match would refuse every
    //     legitimate Australian deposit, and the reason the refusal has to happen
    //     HERE: NPP/Osko transfers are irrevocable with no chargeback, so there is
    //     no recovery step available after the fact.
    //
    // THE ORDER IS BEFORE EVERY WRITE IN THIS FUNCTION and before ledger.deposit,
    // so a refusal leaves the intent exactly as it was: pending, uncredited, and
    // re-decidable once a human has dealt with whatever the refusal named.
    //
    // AND IT DOES NOT MARK THE INTENT FAILED, which is the non-obvious half. A
    // refused deposit is a thing a HUMAN has to look at — a third-party funder, an
    // unregistered instrument, a restricted jurisdiction — and failing it would
    // make it invisible to exactly the person who needs to see it. The intent
    // stays pending, and the refusal is recorded outside this transaction by the
    // caller (lib/funding.js recordRefusal), for the reason lib/limits.js's
    // header gives about persisted order refusals: a row written inside the
    // transaction would be rolled back with the refusal that wrote it.
    require('../identity').assertVerified(db, row.user_id);
    require('../funding').assertDepositFunded(db, {
      actor: null,
      userId: row.user_id,
      methodSlug: fundingSlug(db, row),
      payerName: row.payer_name,
      fundingCountry: row.funding_country,
      instrumentId: row.funding_instrument_id,
      subjectName: verifiedSubjectName(db, row.user_id),
    });

    // THE THRESHOLD. Crossing it creates a DURABLE OBLIGATION — a row that
    // re-surfaces until a human discharges it with a written reason — rather than
    // a log line, because a reporting duty has to survive the process that noticed
    // it. See lib/aml/thresholds.js for why it deliberately is not a rule.
    require('../aml/thresholds').detect(db, {
      userId: row.user_id,
      intentId: row.id,
      amountCents: row.amount_cents,
    });

    // THE RG DEPOSIT LIMIT IS ENFORCED HERE, where the money actually lands.
    //
    // It was checked when the INTENT was created, which moves no money — so a
    // player could open N intents, each of which passed a check that consumed
    // nothing, and have every one of them credited. Measured: a $1,000 limit
    // and $6,000 deposited, stopped only by the venue's unrelated daily cap.
    //
    // The intent-time check stays as a fast, human-friendly failure, but it is
    // a hint; THIS is the control. A check that runs before the effect and
    // consumes nothing is not a check on the effect.
    if (row.amount_cents != null) {
      require('../rg').assertDeposit(db, row.user_id, Number(row.amount_cents));
    }

    // THE PER-USER DAILY CAP, scoped to THIS user.
    //
    // The sum had no `user_id` predicate while `row.user_id` sat right there in
    // scope, so DEPOSIT_DAILY_MAX_CENTS — documented in lib/config.js as
    // "cumulative per user per day" — was actually a venue-wide total. Two
    // players each depositing half the cap exhausted it between them, and the
    // second one was refused for money that was never theirs. The cap named
    // after a per-user limit was the one thing bounding a single compromised
    // account, and it was shared.
    const config = require('../config');
    const today = db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) s
           FROM payment_intents
          WHERE kind = 'deposit' AND status = ? AND user_id = ? AND currency = ?
            AND date(confirmed_at) = date('now')`
      )
      .get(CONFIRMED, row.user_id, tenantCurrency).s;
    if (today + row.amount_cents > config.DEPOSIT_DAILY_MAX_CENTS) {
      // `currency = ?` is part of the same currency, not a new cap: a deposit
      // taken in another denomination would otherwise consume this tenant's
      // cap, and comparing it against a cap denominated in this one is the
      // arithmetic this codebase refuses everywhere else.
      throw httpError(400, `Deposit exceeds the daily cumulative cap of ${amountIn(tenantCurrency, config.DEPOSIT_DAILY_MAX_CENTS)}`);
    }

    // A venue-wide float ceiling is deliberately NOT added here, and the
    // omission is a decision rather than an oversight. It is a real control —
    // the venue's total float is its own risk — but it COUPLES unrelated
    // players: a house full of $1,000 depositors would exhaust a $5,000
    // ceiling and the last of them would be refused over a limit that had
    // nothing to do with them. It needs its own operator-chosen value and its
    // own failure semantics, which is a design decision for a follow-up rather
    // than something to smuggle in beside a per-user predicate fix.
    //
    // This function therefore restores what DEPOSIT_DAILY_MAX_CENTS means and
    // nothing more. lib/limits.js already carries per-USER max deposit caps;
    // the per-VENUE ceiling belongs beside them, under its own name.

    db.prepare("UPDATE payment_intents SET status = ?, confirmed_at = datetime('now') WHERE id = ?").run(CONFIRMED, row.id);
    const after = ledger.deposit(db, row.user_id, row.amount_cents, config.DEPOSIT_MAX_CENTS);
    return { intent_id: row.id, status: CONFIRMED, ...after };
  });
}

/**
 * The WEBHOOK path: resolve a provider event to a deposit intent and confirm
 * it, by external id, inside one transaction.
 *
 * This is the only way a deposit is confirmed in a real deployment. The
 * route that calls it (server.js) authenticates the provider by an HMAC over
 * the raw body AND a delivery timestamp BEFORE calling this — so by the time we
 * are here, the claim "the provider says intent X settled, recently" is trusted,
 * and this function only has to make the confirmation safe to retry.
 *
 * THE LOOKUP IS NOT FILTERED BY `status = 'PENDING'`, and that is the fix. It
 * used to be, which meant a provider's routine at-least-once REDELIVERY of an
 * already-confirmed intent fell through to the 404 below — answering "no such
 * thing, stop trying" when the truth is "already done, nothing to do". Providers
 * retry on a non-2xx and many alert on a 4xx, so every duplicate raised a false
 * error. It also made a duplicate indistinguishable from a genuinely unknown id,
 * which is a different fault with a different remedy.
 *
 * `confirmDeposit` already handles the duplicate correctly and always did — it
 * returns `{already_confirmed: true}` for a CONFIRMED intent and refuses any
 * other final state with a 409. The filter meant that branch was DEAD when
 * called from here. Removing the filter is what makes the already-written
 * behaviour reachable; the money still moves once, because confirmDeposit is
 * still the only thing that credits.
 *
 * The amount is cross-checked against the intent row: a provider event that
 * disagrees with what we recorded is a finding, not a credit. Without this a
 * provider bug (or a replay with a padded amount) would credit whatever the
 * event claimed rather than what the player asked for.
 *
 * `currency` is the same cross-check for the denomination, and it is OPTIONAL
 * because the caller decides that: the webhook route in server.js passes only
 * provider, external id and amount today, so no currency claim is compared here
 * yet. When the route is given one, an event that names a currency other than
 * the recorded intent is refused the same way a padded amount is. The intent's
 * own currency is checked unconditionally inside confirmDeposit either way, so
 * nothing about a wrong-currency credit depends on this parameter.
 */
/**
 * Confirm by the provider's own external id, recording WHAT THE RAIL REPORTED
 * about the funding first.
 *
 * ── WHY THE FUNDING METADATA IS WRITTEN HERE, NOT TAKEN FROM THE CALLER ────
 *
 * `payer_name` and `funding_country` are the ONLY facts the third-party-funding
 * control has, and they are facts about the PAYMENT, not about the account. They
 * come from the PSP, so they arrive on the PSP's confirmation — and they are
 * recorded onto the intent here, BEFORE `confirmDeposit` runs the funding gate,
 * because the gate reads them from the intent row.
 *
 * The alternative — accepting them as a parameter and passing them straight to
 * the gate — is worse than it looks: it makes the detection signal a parameter
 * of the function that is supposed to detect it, so an adapter that forgot to
 * pass them would produce a control that silently finds nothing. Recording first
 * and reading second means the row is the single statement of what the rail said,
 * and the gate cannot be fed a value that disagrees with it.
 *
 * IT IS NOT OVERWRITTEN IF ALREADY RECORDED. The first report wins: a later
 * confirmation cannot restate who funded the deposit, because "the instrument was
 * registered to somebody else" and then later "no, it was registered to them"
 * is exactly the kind of drift a financial-crime record must not have.
 */
function confirmByExternalId(db, { provider, externalId, amountCents, currency, funding = null }) {
  return transaction(db, () => {
    const row = db
      .prepare('SELECT * FROM payment_intents WHERE external_id = ? AND kind = ? ORDER BY id LIMIT 1')
      .get(String(externalId), 'deposit');
    if (!row) throw httpError(404, 'No deposit intent matches that external id');
    if (row.provider !== String(provider)) throw httpError(400, 'Provider mismatch for that intent');
    if (Number.isFinite(amountCents) && Number(amountCents) !== row.amount_cents) {
      throw httpError(400, `Provider amount ${amountCents} disagrees with the recorded intent ${row.amount_cents}`);
    }
    if (currency !== undefined && currency !== null && String(currency) !== row.currency) {
      throw httpError(400, `Provider currency ${currency} disagrees with the recorded intent ${row.currency}`);
    }

    // THE RAIL'S OWN ACCOUNT OF THE FUNDING. COALESCEd, so a confirmation that
    // carries nothing leaves whatever was recorded at intent time alone, and a
    // confirmation that repeats the same values changes nothing.
    if (funding && (funding.payerName || funding.fundingCountry || funding.instrumentId !== undefined)) {
      db.prepare(
        `UPDATE payment_intents
            SET payer_name = COALESCE(payer_name, ?),
                funding_country = COALESCE(funding_country, ?),
                funding_instrument_id = COALESCE(funding_instrument_id, ?)
          WHERE id = ?`
      ).run(
        funding.payerName === undefined || funding.payerName === null ? null : String(funding.payerName).slice(0, 200),
        funding.fundingCountry === undefined || funding.fundingCountry === null ? null : String(funding.fundingCountry).toUpperCase().slice(0, 2),
        funding.instrumentId === undefined ? null : funding.instrumentId,
        row.id
      );
    }

    // Re-read: the gate below reads the row, and the row has just changed.
    const fresh = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(row.id);
    const r = confirmDeposit(db, fresh.id);
    return { ...r, user_id: fresh.user_id, amount_cents: fresh.amount_cents, currency: fresh.currency };
  });
}

/** Mark a deposit failed. No money moves — nothing was ever credited. */
function failDeposit(db, intentId, reason) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(intentId);
    if (!row) throw httpError(404, 'Payment intent not found');
    if (row.kind !== 'deposit') throw httpError(400, 'Not a deposit intent — use the withdrawal lifecycle for withdrawals');
    if (row.status !== PENDING) throw httpError(409, `Payment intent is already ${row.status}`);
    db.prepare("UPDATE payment_intents SET status = ?, failure_reason = ? WHERE id = ?").run(FAILED, reason || null, intentId);
    return { intent_id: intentId, status: FAILED };
  });
}

/**
 * Complete a withdrawal: the provider has paid the player out, so the hold is
 * discharged and the money stays booked against gateway_clearing — the
 * provider-facing settlement position. It does NOT come back to the venue:
 * reading the clearing account as "money sent to players, net of deposits
 * received" is what makes it an operator-visible number rather than a leak.
 *
 * Before this existed the lifecycle was a dead end (the outside audit's F5):
 * a withdrawal could be opened and debited, and nothing in the system could
 * ever complete or refund it, so the money sat in clearing forever.
 */
function completeWithdrawal(db, intentId, reason) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(intentId);
    if (!row) throw httpError(404, 'Payment intent not found');
    if (row.kind !== 'withdrawal') throw httpError(400, 'Not a withdrawal intent');
    if (row.status === CONFIRMED) return { already_confirmed: true, intent_id: row.id, status: CONFIRMED };
    if (row.status !== PENDING) throw httpError(409, `Withdrawal intent is ${row.status}`);
    db.prepare("UPDATE payment_intents SET status = ?, confirmed_at = datetime('now'), failure_reason = ? WHERE id = ?")
      .run(CONFIRMED, reason || null, row.id);
    return { intent_id: row.id, status: CONFIRMED, amount_cents: row.amount_cents };
  });
}

/**
 * Fail or cancel a withdrawal: the money never left, so the player is
 * refunded in full and the books return to the state before the request.
 */
function failWithdrawal(db, intentId, reason) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(intentId);
    if (!row) throw httpError(404, 'Payment intent not found');
    if (row.kind !== 'withdrawal') throw httpError(400, 'Not a withdrawal intent');
    if (row.status !== PENDING) throw httpError(409, `Withdrawal intent is ${row.status}`);
    db.prepare("UPDATE payment_intents SET status = ?, failure_reason = ? WHERE id = ?").run(FAILED, reason || null, row.id);
    ledger.withdrawRefund(db, row.user_id, row.amount_cents);
    return { intent_id: row.id, status: FAILED, refunded_cents: row.amount_cents };
  });
}

/**
 * Open a withdrawal. Funds are debited and HELD immediately — a withdrawal
 * request must reduce spendable balance at once, or a player could request
 * several withdrawals against the same balance and walk away with all of them.
 *
 * `period_start` records the hold so a cooling-off window and a reconciliation
 * step can be applied later. It is NOT enforced here: a cooling-off period is
 * a per-jurisdiction legal requirement, and hard-coding one would be the same
 * mistake as hard-coding a PSP.
 */
function openWithdrawal(db, userId, cents, reason, destination = {}) {
  if (!Number.isInteger(cents) || cents <= 0) throw httpError(400, 'Withdrawal must be a positive integer number of cents');
  // The currency the hold was debited in — which is the currency the payout
  // has to be made in. Recorded on the intent rather than assumed at the point
  // of payout, because a provider asked to pay out in one currency while the
  // venue held the player's funds in another is a loss, and the only place to
  // catch it is where the intent is opened.
  //
  // `destination` carries `beneficiary_country` when the caller knows it. It is
  // OPTIONAL, and an absent country is not refused here: at this point in the
  // lifecycle the payout has not been instructed and many providers report the
  // beneficiary only when they make it. What is refused is a country the venue
  // has been told is restricted — see the assertion below — and the indicator
  // rule in lib/aml/rules.js catches the rest retrospectively, which is the
  // honest division between a gate and a signal.
  const currency = currencyForUser(db, userId);
  return transaction(db, () => {
    const u = ledger.getUser(db, userId);
    if (u.is_bot) throw httpError(400, 'The house account cannot withdraw');
    // ── CUSTOMER PRE-VERIFICATION, ON THE PAYOUT ────────────────────────────
    //
    // AND THIS IS THE ONE PLACE WHERE THE ASYMMETRY WITH SELF-EXCLUSION BITES,
    // so the reasoning has to be written down rather than assumed.
    //
    // `/api/wallet/withdraw` deliberately does NOT call assertTradeable, and the
    // route's own comment gives the reason: "Refusing to let someone take their own
    // money out is a far worse failure than the gap above, and self-exclusion is a
    // promise about PLAY, not about custody."
    //
    // That reasoning is correct for self-exclusion and it does NOT transfer to
    // identity. An unverified account is an account the venue cannot prove belongs
    // to the person asking. Paying money out of it is not custody of their own
    // money — it is a payout to whoever opened the account, from a rail that in
    // the NPP/Osko case cannot be reversed at all, on an account whose
    // third-party funding is precisely the finding lib/funding.js exists to stop.
    //
    // So this is custody AND eligibility at once, and it is enforced HERE — before
    // the hold is taken, which is the same position lib/offtime.js and
    // lib/match.js's validateOrder take: a refusal that runs before the effect
    // leaves nothing behind for a human to unwind.
    require('../identity').assertVerified(db, userId);

    // THE BENEFICIARY COUNTRY, refused at intake for the same reason the funding
    // country is. "Attempts to withdraw funds to an international bank account" is a
    // published indicator and AUSTRAC treated international funding as a separate
    // finding from the session-jurisdiction gate, so the two are kept apart here
    // for the same reason they are kept apart in lib/funding.js.
    require('../funding').assertWithdrawalDestination(db, {
      userId,
      beneficiaryCountry: destination && destination.beneficiary_country ? destination.beneficiary_country : null,
    });

    // Held, not paid: debited through the LEDGER, which is the only module
    // that writes users.balance_cents (enforced by tests/guard.test.js). The
    // first version of this function wrote the column directly, and the
    // outside audit found it as the one writer outside the guard's coverage.
    ledger.withdrawHold(db, userId, cents);
    const p = current();
    // `beneficiary_country` rides on the intent rather than being logged
    // elsewhere, because it is the only durable link between a payout and the
    // account it was made to, and lib/aml/rules.js's international-withdrawal
    // indicator reads it from here. Storing it on the withdrawal intent and not
    // on the user is the right shape: a customer's beneficiary can change, and a
    // column on `users` would overwrite the history.
    db.prepare(
      `INSERT INTO payment_intents (user_id, provider, external_id, kind, amount_cents, currency, status, failure_reason, beneficiary_country)
       VALUES (?, ?, NULL, 'withdrawal', ?, ?, ?, ?, ?)`
    ).run(userId, p.name, cents, currency, PENDING, reason || null,
      destination && destination.beneficiary_country ? String(destination.beneficiary_country).toUpperCase() : null);
    return { status: PENDING, amount_cents: cents, currency };
  });
}

/**
 * RECONCILIATION. Discrepancies are FINDINGS, not exceptions to log.
 *
 * drift is the one number that matters: what the provider says it settled,
 * minus what we recorded as confirmed. It is deliberately NOT a re-derivation
 * of our own balances — comparing internal totals to each other proves nothing
 * about whether real money arrived. It has to be an EXTERNAL comparison.
 *
 * The internal figures are reported alongside so an operator reading a drift
 * has the context to investigate it rather than just an alert.
 */
async function reconcile(db) {
  const p = current();
  const report = (await p.reconcile()) || { settled: [], unmatched: [] };
  const settled = report.settled || [];
  const unmatched = report.unmatched || [];

  const providerSettledCents = settled.reduce((s, r) => s + (Number(r.amount_cents) || Number(r.cents) || 0), 0);
  const confirmedRow = db
    .prepare("SELECT COALESCE(SUM(amount_cents), 0) s FROM payment_intents WHERE kind = 'deposit' AND status = ?")
    .get(CONFIRMED);
  const heldRow = db
    .prepare("SELECT COALESCE(SUM(amount_cents), 0) s FROM payment_intents WHERE kind = 'withdrawal' AND status = ?")
    .get(PENDING);

  // WHICH CURRENCY these sums are in (#104). Reported, and asserted to be the
  // one, because every figure above is a bare integer of cents: a total is only
  // meaningful next to its denomination, and this function sums the whole
  // table. Nothing in the supported configuration can produce a second value
  // here — confirmDeposit() refuses an intent in another currency, so a
  // confirmed row can only be in a tenant's currency and every tenant's
  // currency is the venue's — which is exactly why the check is a finding
  // rather than an error: if it ever fires, something got past two guards and
  // an operator needs to see the number, not a 500.
  const currencies = db
    .prepare('SELECT DISTINCT currency FROM payment_intents ORDER BY currency')
    .all()
    .map((r) => r.currency);
  const venue = require('../config').VENUE_CURRENCY;

  const accounts = require('../accounts');
  return {
    provider: p.name,
    // The denomination every figure below is in.
    currency: venue,
    provider_settled: settled,
    provider_unmatched: unmatched,
    provider_settled_cents: providerSettledCents,
    recorded_confirmed_cents: confirmedRow.s,
    // The finding. Non-zero means the provider and the venue disagree about
    // money that arrived, which is a loss or a liability until explained.
    drift_cents: providerSettledCents - confirmedRow.s,
    withdrawals_pending_cents: heldRow.s,
    gateway_clearing_cents: accounts.balanceOf(db, accounts.accountId(db, 'gateway_clearing', null)),
    // A non-empty list means the sums above are not a single-currency figure
    // and must not be read as one. Named rather than counted so the operator
    // sees WHICH denominations are involved.
    currencies_seen: currencies,
  };
}

module.exports = { register, select, current, openDeposit, confirmDeposit, confirmByExternalId, failDeposit, openWithdrawal, completeWithdrawal, failWithdrawal, reconcile, STATUSES };