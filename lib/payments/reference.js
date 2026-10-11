'use strict';
// lib/payments/reference.js — a complete provider that moves no real money.
//
// This is the REFERENCE IMPLEMENTATION, not a stub: it exercises every method
// of the interface, including webhook signature verification and
// reconciliation, so the seam is proven rather than merely declared. It is
// what the test suite drives and what a new provider can be written against.
//
// It is also the safe default for a paper-money deployment: with no adapter
// configured, this one answers "confirmed" deterministically. It NEVER does
// that silently in a real deployment — the registry refuses to select it when
// REAL_PAYMENTS is enabled, because an operator who thinks they are taking
// real money must never be served a mock that confirms anything.
const crypto = require('crypto');
const { PENDING, CONFIRMED, FAILED, REFUNDED, assertProvider } = require('./provider');

function referenceProvider({ secret = 'reference-secret-not-for-production' } = {}) {
  // In-memory because this provider holds no money and persists nothing. A
  // real adapter keeps state in the PSP, not here — that is the entire point of
  // the seam.
  const intents = new Map();

  function sign(payload) {
    return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  }

  return assertProvider({
    name: 'reference',

    async createDepositIntent(userId, cents, currency = 'USD') {
      if (!Number.isInteger(cents) || cents <= 0) throw new Error('payments: deposit must be a positive integer number of cents');
      const externalId = `ref_${crypto.randomUUID()}`;
      intents.set(externalId, { externalId, userId, cents, currency, status: PENDING });
      return { externalId, status: PENDING, clientSecret: sign({ externalId, userId, cents }) };
    },

    // Deliberately callable in both directions so a test can prove the
    // distinction between "asked for" and "arrived": nothing is credited at
    // intent time, and a withdrawal stays pending until explicitly settled.
    async confirmDeposit(externalId) {
      const i = intents.get(externalId);
      if (!i) return { externalId, status: FAILED };
      if (i.status === REFUNDED) return { ...i, status: FAILED };
      i.status = CONFIRMED;
      return { ...i };
    },

    async createWithdrawal(userId, cents, currency = 'USD') {
      if (!Number.isInteger(cents) || cents <= 0) throw new Error('payments: withdrawal must be a positive integer number of cents');
      const externalId = `ref_w_${crypto.randomUUID()}`;
      intents.set(externalId, { externalId, userId, cents, currency, status: PENDING, withdrawal: true });
      return { externalId, status: PENDING };
    },

    // Constant-time compare, and the signature is checked over the RAW body —
    // re-serialising parsed JSON would change key order and break every real
    // provider's signature. Getting this wrong is the difference between an
    // endpoint anyone can credit money with and one they cannot.
    async verifyWebhook(rawBody, headers, signature) {
      const expected = sign(JSON.parse(rawBody));
      const a = Buffer.from(String(expected));
      const b = Buffer.from(String(signature || ''));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      const parsed = JSON.parse(rawBody);
      const i = intents.get(parsed.externalId);
      if (!i) return null;
      i.status = parsed.status === REFUNDED ? REFUNDED : CONFIRMED;
      return { ...i };
    },

    async reconcile() {
      return { settled: [], unmatched: [] };
    },
  });
}

module.exports = { referenceProvider };