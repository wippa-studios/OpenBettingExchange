// payments.test.js — payments abstraction (Phase 3).
// Run: node tests/payments.test.js   (plain assert, no deps)
//
// The invariant worth the most here is NEGATIVE: a deposit must not credit
// anything until the provider CONFIRMS funds arrived. Every other assertion
// here exists to make that hard to regress.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const acc = require('../lib/accounts');
const pay = require('../lib/payments');
const { referenceProvider } = require('../lib/payments/reference');
const { assertProvider, PENDING, CONFIRMED } = require('../lib/payments/provider');

// Payments checks are async (the provider seam is), so checks are COLLECTED
// and awaited in order rather than run eagerly — an eager runner would report
// a passing check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

async function fixture() {
  const db = openStore(':memory:');
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-1234', balance_cents: 100000 }));
  return { db, alice };
}
const bal = (db, id) => db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id=?').get(id);
// node:sqlite rows are null-prototype, so deepStrictEqual against an object
// literal fails on the prototype alone. Compare the money, not the object.
function assertWallet(db, id, b, f, msg) {
  const r = bal(db, id);
  assert.ok(r.b === b && r.f === f, `${msg}: expected b=${b} f=${f}, got b=${r.b} f=${r.f}`);
}

// P1: THE rule. Asking to deposit moves no money.
check('P1 a deposit intent credits NOTHING', async () => {
  const { db, alice } = (await fixture());
  await pay.openDeposit(db, alice.id, 25000);
  assertWallet(db, alice.id, 100000, 0, 'balance untouched');
  const row = db.prepare("SELECT status FROM payment_intents WHERE kind='deposit'").get();
  assert.strictEqual(row.status, PENDING);
  assert.strictEqual(acc.assertConserved(db), 0);
});

// P2: credit happens on CONFIRMATION, and posts to gateway_clearing.
check('P2 confirmation credits the player from gateway_clearing', async () => {
  const { db, alice } = (await fixture());
  const i = await pay.openDeposit(db, alice.id, 25000);
  const clearingBefore = acc.balanceOf(db, acc.accountId(db, 'gateway_clearing', null));
  const r = pay.confirmDeposit(db, i.intent_id);
  assert.strictEqual(r.status, CONFIRMED);
  assert.strictEqual(bal(db, alice.id).b, 125000, 'funded exactly once');
  assert.strictEqual(acc.balanceOf(db, acc.accountId(db, 'gateway_clearing', null)), clearingBefore - 25000);
  assert.strictEqual(acc.assertConserved(db), 0);
  assert.deepEqual(acc.assertUserAgrees(db), []);
});

// P3: confirming twice moves money ONCE. A retried webhook is the classic
// double-credit, and the intent id is what makes it impossible.
check('P3 confirmation is idempotent', async () => {
  const { db, alice } = (await fixture());
  const i = await pay.openDeposit(db, alice.id, 25000);
  pay.confirmDeposit(db, i.intent_id);
  const r2 = pay.confirmDeposit(db, i.intent_id);
  assert.strictEqual(r2.already_confirmed, true);
  assertWallet(db, alice.id, 125000, 0, 'still funded once');
  assert.strictEqual(acc.assertConserved(db), 0);
});

// P4: opening many intents and abandoning them funds the player ZERO times.
// This is the attack that crediting-on-initiation exists to prevent.
check('P4 abandoned intents fund nothing', async () => {
  const { db, alice } = (await fixture());
  for (let n = 0; n < 10; n++) await pay.openDeposit(db, alice.id, 25000);
  assertWallet(db, alice.id, 100000, 0, 'not one cent credited');
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM payment_intents WHERE status='pending'").get().c, 10);
});

// P5: a failed deposit moves nothing and cannot be revived into a credit.
check('P5 a failed intent cannot later be confirmed', async () => {
  const { db, alice } = (await fixture());
  const i = await pay.openDeposit(db, alice.id, 25000);
  pay.failDeposit(db, i.intent_id, 'card declined');
  assert.throws(() => pay.confirmDeposit(db, i.intent_id), /is failed/);
  assert.strictEqual(bal(db, alice.id).b, 100000);
});

// P6: a withdrawal holds funds immediately, so the same balance cannot be
// withdrawn twice.
check('P6 a withdrawal holds funds at once', async () => {
  const { db, alice } = (await fixture());
  const before = acc.balanceOf(db, acc.accountId(db, 'gateway_clearing', null));
  pay.openWithdrawal(db, alice.id, 40000, 'player request');
  assertWallet(db, alice.id, 60000, 0, 'debited immediately and not spendable again');
  assert.strictEqual(acc.balanceOf(db, acc.accountId(db, 'gateway_clearing', null)), before + 40000, 'venue now owes it out');
  assert.strictEqual(acc.assertConserved(db), 0);
  assert.deepEqual(acc.assertUserAgrees(db), []);
});

// P7: a withdrawal cannot exceed available funds — the over-draft is refused
// at the boundary rather than leaving the venue owing money it does not have.
check('P7 a withdrawal cannot overdraw', async () => {
  const { db, alice } = (await fixture());
  assert.throws(() => pay.openWithdrawal(db, alice.id, 500000, 'too much'), /exceeds available/);
  assertWallet(db, alice.id, 100000, 0, 'nothing moved');
  assert.throws(() => pay.openWithdrawal(db, alice.id, 0), /positive integer/);
});

// P8: reconciliation reports the drift rather than silently tolerating it.
check('P8 reconcile reports drift', async () => {
  const { db, alice } = (await fixture());
  pay.openWithdrawal(db, alice.id, 40000, 'player request');
  const rep = await pay.reconcile(db);
  assert.strictEqual(rep.provider, 'reference');
  assert.strictEqual(rep.withdrawals_pending_cents, 40000);
  assert.strictEqual(rep.recorded_confirmed_cents, 0);
  // Drift compares the PROVIDER's settled view to ours. The reference provider
  // has settled nothing and we have confirmed nothing, so it is zero — and
  // that is the whole point: a non-zero value here means the provider and the
  // venue disagree about real money, which no internal re-derivation could
  // ever detect.
  assert.strictEqual(rep.drift_cents, 0);
});

// P9: an incomplete provider is REFUSED AT BOOT. The whole value of an
// interface is that a missing method is a startup crash, not a production
// surprise on someone's money.
check('P9 an incomplete provider is refused', async () => {
  assert.throws(() => assertProvider({ name: 'broken', createDepositIntent() {} }), /missing confirmDeposit/);
  assert.throws(() => assertProvider({}), /needs a name/);
  assert.throws(() => assertProvider(null), /must be an object/);
  assert.doesNotThrow(() => assertProvider(referenceProvider()));
});

// P10: REAL payments refuse the reference provider. A mock that instantly
// confirms any deposit must never sit behind a live payment button, and the
// only safe moment to find that out is startup.
check('P10 real payments refuse the reference provider', async () => {
  assert.throws(() => pay.select('reference', { realPayments: true }), /cannot be used when real payments/);
  assert.throws(() => pay.select('never-configured', { realPayments: true }), /no provider is configured/);
  // Paper money falls back to it happily.
  assert.strictEqual(pay.select(undefined, { realPayments: false }).name, 'reference');
});

// P11: webhook signatures are verified over the RAW body with a constant-time
// compare. Re-serialising parsed JSON changes key order and breaks every real
// provider's signature; a non-constant compare leaks it.
check('P11 webhook signature verification rejects a forged payload', async () => {
  const p = referenceProvider({ secret: 'test-secret' });
  const intent = await p.createDepositIntent(1, 1000, 'USD');
  const good = require('crypto').createHmac('sha256', 'test-secret').update(JSON.stringify({ externalId: intent.externalId, status: 'confirmed' })).digest('hex');
  const ok = await p.verifyWebhook(JSON.stringify({ externalId: intent.externalId, status: 'confirmed' }), {}, good);
  assert.ok(ok, 'a genuine signature is accepted');
  const forged = await p.verifyWebhook(JSON.stringify({ externalId: intent.externalId, status: 'confirmed' }), {}, 'deadbeef');
  assert.strictEqual(forged, null, 'a forged signature is refused');
});

(async () => {
  let passed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (e) {
      console.error(`  FAIL ${name}`);
      console.error(e);
      process.exit(1);
    }
    passed++;
    console.log('  ok', name);
  }
  console.log(`\npayments.test.js: ${passed} checks passed`);
  if (passed < 11) { console.error('expected 11 checks'); process.exit(1); }
})();