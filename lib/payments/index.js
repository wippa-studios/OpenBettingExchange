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
 */
async function openDeposit(db, userId, cents) {
  if (!Number.isInteger(cents) || cents <= 0) throw httpError(400, 'Deposit must be a positive integer number of cents');
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
 */
function confirmDeposit(db, intentId, { settled } = {}) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(intentId);
    if (!row) throw httpError(404, 'Payment intent not found');
    if (row.kind !== 'deposit') throw httpError(400, 'Not a deposit intent');
    if (row.status === CONFIRMED) return { already_confirmed: true, intent_id: row.id, status: CONFIRMED };
    if (row.status !== PENDING) throw httpError(409, `Payment intent is ${row.status}`);

    db.prepare("UPDATE payment_intents SET status = ?, confirmed_at = datetime('now') WHERE id = ?").run(CONFIRMED, row.id);
    const after = ledger.deposit(db, row.user_id, row.amount_cents, Number.MAX_SAFE_INTEGER);
    return { intent_id: row.id, status: CONFIRMED, ...after };
  });
}

/** Mark a deposit failed. No money moves — nothing was ever credited. */
function failDeposit(db, intentId, reason) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(intentId);
    if (!row) throw httpError(404, 'Payment intent not found');
    if (row.status !== PENDING) throw httpError(409, `Payment intent is already ${row.status}`);
    db.prepare("UPDATE payment_intents SET status = ?, failure_reason = ? WHERE id = ?").run(FAILED, reason || null, intentId);
    return { intent_id: intentId, status: FAILED };
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
    const available = ledger.availableOf(u);
    if (cents > available) throw httpError(400, 'Withdrawal exceeds available balance');
    // Held, not paid: debited from the player's funds so it cannot be spent,
    // and parked in gateway_clearing as money the venue owes out.
    const bal = u.balance_cents - cents;
    db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(bal, userId);
    const txId = Number(
      db
        .prepare(
          `INSERT INTO transactions (user_id, type, amount_cents, balance_after, frozen_after)
           VALUES (?, 'adjust', ?, ?, ?)`
        )
        .run(userId, -cents, bal, u.frozen_cents).lastInsertRowid
    );
    const accounts = require('../accounts');
    accounts.postTransfer(db, {
      transaction_id: txId,
      from: accounts.accountId(db, 'player_funds', userId),
      to: accounts.accountId(db, 'gateway_clearing', null),
      deltaCents: cents,
      memo: 'withdrawal held',
    });
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

module.exports = { register, select, current, openDeposit, confirmDeposit, failDeposit, openWithdrawal, reconcile, STATUSES };