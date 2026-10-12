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
const { httpError } = require('../auth');
const { transaction } = require('../tx');
const ledger = require('../ledger');
const { PENDING, CONFIRMED, FAILED, REFUNDED, STATUSES, assertProvider } = require('./provider');
const { referenceProvider } = require('./reference');

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
async function openDeposit(db, userId, cents) {
  if (!Number.isInteger(cents) || cents <= 0) throw httpError(400, 'Deposit must be a positive integer number of cents');
  const config = require('../config');
  if (cents > config.DEPOSIT_MAX_CENTS) {
    throw httpError(400, `Deposit intent exceeds the per-intent cap of $${(config.DEPOSIT_MAX_CENTS / 100).toFixed(2)}`);
  }
  const p = current();
  const intent = await p.createDepositIntent(userId, cents, 'USD');
  const row = transaction(db, () => {
    const info = db
      .prepare(
        `INSERT INTO payment_intents (user_id, provider, external_id, kind, amount_cents, currency, status)
         VALUES (?, ?, ?, 'deposit', ?, 'USD', ?)`
      )
      .run(userId, p.name, intent.externalId, cents, PENDING);
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
function confirmDeposit(db, intentId, { settled } = {}) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(intentId);
    if (!row) throw httpError(404, 'Payment intent not found');
    if (row.kind !== 'deposit') throw httpError(400, 'Not a deposit intent');
    if (row.status === CONFIRMED) return { already_confirmed: true, intent_id: row.id, status: CONFIRMED };
    if (row.status !== PENDING) throw httpError(409, `Payment intent is ${row.status}`);

    const config = require('../config');
    const today = db
      .prepare("SELECT COALESCE(SUM(amount_cents), 0) s FROM payment_intents WHERE kind = 'deposit' AND status = ? AND date(confirmed_at) = date('now')")
      .get(CONFIRMED).s;
    if (today + row.amount_cents > config.DEPOSIT_DAILY_MAX_CENTS) {
      throw httpError(400, `Deposit exceeds the daily cumulative cap of $${(config.DEPOSIT_DAILY_MAX_CENTS / 100).toFixed(2)}`);
    }

    db.prepare("UPDATE payment_intents SET status = ?, confirmed_at = datetime('now') WHERE id = ?").run(CONFIRMED, row.id);
    const after = ledger.deposit(db, row.user_id, row.amount_cents, config.DEPOSIT_MAX_CENTS);
    return { intent_id: row.id, status: CONFIRMED, ...after };
  });
}

/**
 * The WEBHOOK path: resolve a provider event to a pending intent and confirm
 * it, by external id, inside one transaction.
 *
 * This is the only way a deposit is confirmed in a real deployment. The
 * route that calls it (server.js) authenticates the provider by an HMAC over
 * the raw body BEFORE calling this — so by the time we are here, the claim
 * "the provider says intent X settled" is trusted, and this function only
 * has to make the confirmation safe to retry.
 *
 * The amount is cross-checked against the intent row: a provider event that
 * disagrees with what we recorded is a finding, not a credit. Without this a
 * provider bug (or a replay with a padded amount) would credit whatever the
 * event claimed rather than what the player asked for.
 */
function confirmByExternalId(db, { provider, externalId, amountCents }) {
  return transaction(db, () => {
    const row = db
      .prepare('SELECT * FROM payment_intents WHERE external_id = ? AND kind = ? AND status = ? ORDER BY id LIMIT 1')
      .get(String(externalId), 'deposit', PENDING);
    if (!row) throw httpError(404, 'No pending deposit intent matches that external id');
    if (row.provider !== String(provider)) throw httpError(400, 'Provider mismatch for that intent');
    if (Number.isFinite(amountCents) && Number(amountCents) !== row.amount_cents) {
      throw httpError(400, `Provider amount ${amountCents} disagrees with the recorded intent ${row.amount_cents}`);
    }
    const r = confirmDeposit(db, row.id);
    return { ...r, user_id: row.user_id, amount_cents: row.amount_cents };
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
function openWithdrawal(db, userId, cents, reason) {
  if (!Number.isInteger(cents) || cents <= 0) throw httpError(400, 'Withdrawal must be a positive integer number of cents');
  return transaction(db, () => {
    const u = ledger.getUser(db, userId);
    if (u.is_bot) throw httpError(400, 'The house account cannot withdraw');
    // Held, not paid: debited through the LEDGER, which is the only module
    // that writes users.balance_cents (enforced by tests/guard.test.js). The
    // first version of this function wrote the column directly, and the
    // outside audit found it as the one writer outside the guard's coverage.
    ledger.withdrawHold(db, userId, cents);
    const p = current();
    db.prepare(
      `INSERT INTO payment_intents (user_id, provider, external_id, kind, amount_cents, currency, status, failure_reason)
       VALUES (?, ?, NULL, 'withdrawal', ?, 'USD', ?, ?)`
    ).run(userId, p.name, cents, PENDING, reason || null);
    return { status: PENDING, amount_cents: cents };
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

  const accounts = require('../accounts');
  return {
    provider: p.name,
    provider_settled: settled,
    provider_unmatched: unmatched,
    provider_settled_cents: providerSettledCents,
    recorded_confirmed_cents: confirmedRow.s,
    // The finding. Non-zero means the provider and the venue disagree about
    // money that arrived, which is a loss or a liability until explained.
    drift_cents: providerSettledCents - confirmedRow.s,
    withdrawals_pending_cents: heldRow.s,
    gateway_clearing_cents: accounts.balanceOf(db, accounts.accountId(db, 'gateway_clearing', null)),
  };
}

module.exports = { register, select, current, openDeposit, confirmDeposit, confirmByExternalId, failDeposit, openWithdrawal, completeWithdrawal, failWithdrawal, reconcile, STATUSES };