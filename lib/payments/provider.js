'use strict';
// lib/payments/provider.js — the payment provider INTERFACE.
//
// NO PROVIDER IS BUILT IN, and that is a deliberate deliverable boundary, not
// an omission. Every jurisdiction has different requirements, gambling is a
// restricted category almost everywhere, and the operator running this already
// has a contract with a PSP they have been through legal review with. Shipping
// a specific provider would be shipping OUR guess at their compliance
// position. So the deliverable is the seam plus the contract, and the
// reference implementation next door proves the seam works end to end.
//
// THE RULE THAT MATTERS: credit on CONFIRMATION, never on INITIATION.
//
//   createDepositIntent  -> the player has ASKED to deposit. Nothing is
//                           credited. Money is not in the venue's account.
//   confirmDeposit       -> the provider says the money actually arrived.
//
// Crediting at intent time is the classic double-spend bug: a player opens
// several intents, abandons them, and has been funded several times. It is
// also, in a licensed venue, an unsecured liability the moment it ships.
//
// Withdrawals are the mirror and are deliberately slower: funds are HELD,
// a cooling-off period elapses, then a reconciliation step confirms the
// outgoing payment settled. A withdrawal that is never reconciled is a
// permanent, invisible liability.
//
// A provider MUST implement:
//   name                    string, stable — it lands on every intent row
//   createDepositIntent     (userId, cents, currency) -> { externalId, status, clientSecret? }
//   confirmDeposit          (externalId)             -> { status, cents, currency, externalId }
//   createWithdrawal        (userId, cents, currency) -> { externalId, status }
//   verifyWebhook           (rawBody, headers, signature) -> { externalId, status, cents }
//   reconcile               (sinceIso) -> { settled[], unmatched[] }
//
// `verifyWebhook` is REQUIRED even though nothing calls it yet. Webhook
// verification is the part that is easy to get wrong and impossible to retrofit
// safely, so it is part of the contract from day one rather than something a
// future implementer bolts on.
//
// Statuses are a closed vocabulary so the reconciler can reason about them
// without string-matching provider-specific wording.
const PENDING = 'pending';
const CONFIRMED = 'confirmed';
const FAILED = 'failed';
const REJECTED = 'rejected';
const REFUNDED = 'refunded';
const STATUSES = [PENDING, CONFIRMED, FAILED, REJECTED, REFUNDED];

/**
 * Assert an object implements the contract. Called by the registry on
 * registration so a half-implemented provider fails at BOOT, loudly, rather
 * than at the first deposit in production.
 *
 * This is the whole reason the interface exists: a missing method must be a
 * startup crash, never a runtime surprise on someone's money.
 */
function assertProvider(p) {
  if (!p || typeof p !== 'object') throw new Error('payments: provider must be an object');
  if (typeof p.name !== 'string' || !p.name) throw new Error('payments: provider needs a name');
  const required = ['createDepositIntent', 'confirmDeposit', 'createWithdrawal', 'verifyWebhook', 'reconcile'];
  const missing = required.filter((m) => typeof p[m] !== 'function');
  if (missing.length) {
    throw new Error(`payments: provider "${p.name}" is missing ${missing.join(', ')}`);
  }
  return p;
}

module.exports = { PENDING, CONFIRMED, FAILED, REJECTED, REFUNDED, STATUSES, assertProvider };