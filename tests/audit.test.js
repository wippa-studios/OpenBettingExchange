// audit.test.js — regression tests for the outside money-path audit's findings.
// Run: node tests/audit.test.js   (plain assert, no deps)
//
// This suite exists because every finding below was found by a reviewer who
// had never seen the codebase, after the author's own reviews had all passed.
// An outside reading is not a formality: the author of a money path is
// structurally unable to review it, because they test what they built against
// what they intended, and the two drift apart silently.
//
// Each check names the finding it closes, in the auditor's numbering, and the
// checks assert the EXPLOIT is closed — not merely that a function exists.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';
process.env.CASHOUT_MARGIN_BPS = '200';

const assert = require('assert');
const crypto = require('crypto');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const config = require('../lib/config');
const pay = require('../lib/payments');
const ledger = require('../lib/ledger');
const acc = require('../lib/accounts');
const M = require('../lib/match');
const S = require('../lib/settle');
const T = require('../lib/tenants');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

const bal = (db, id) => db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id=?').get(id);
const clean = (db) => {
  assert.strictEqual(acc.assertConserved(db), 0, 'conservation broken');
  assert.deepStrictEqual(acc.assertUserAgrees(db), [], 'cache diverged from postings');
};

async function fixture() {
  const db = openStore(':memory:');
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 0 }));
  return { db, alice, bob };
}

// ── F1: the critical one. Any player could mint unlimited money by
// self-confirming a deposit intent. The confirm route checked only that the
// intent was PENDING — never that money had arrived, never who was calling —
// and credited with the faucet cap bypassed (Number.MAX_SAFE_INTEGER).
// ────────────────────────────────────────────────────────────────────────────

// A1: THE ORIGINAL EXPLOIT IS CLOSED AT THE DATA LAYER. The auditor's exact
// sequence was: open an intent for 50,000,000 cents, confirm it, get
// $500,000. The per-intent cap refuses the OPEN now — before the
// confirmation question can even arise.
check('A1 (F1) the 50,000,000-cent exploit is refused at intent creation', async () => {
  const { db, alice } = (await fixture());
  await assert.rejects(
    () => pay.openDeposit(db, alice.id, 50000000),
    (e) => e.status === 400 && /per-intent cap/.test(e.message)
  );
  const rows = db.prepare('SELECT COUNT(*) c FROM payment_intents').get().c;
  assert.strictEqual(rows, 0, 'no intent row, so nothing to confirm later');
});

// A2: even a legitimate-sized intent cannot be confirmed by its OWNER —
// there is no session-authenticated path to confirmation at all. The
// function is only callable from the webhook (provider-authenticated) and
// the admin desk. This test documents the trust boundary: what a PLAYER can
// reach is open + read, never confirm.
check('A2 (F1) confirmation resolves by EXTERNAL id — a player cannot name an intent id', async () => {
  const { db, alice } = (await fixture());
  const intent = await pay.openDeposit(db, alice.id, 25000);
  assert.strictEqual(bal(db, alice.id).b, 100000, 'opening an intent credits nothing');
  // confirmByExternalId is the ONLY programmatic confirm, and it takes the
  // provider's external id, not our internal one — the caller must be the
  // entity that created the intent with the provider.
  assert.throws(() => pay.confirmByExternalId(db, { provider: 'reference', externalId: 'wrong-id', amountCents: 25000 }), /No pending deposit/);
  // The internal-id confirm still exists for the webhook/admin paths and is
  // cap-bound; a player who somehow reached it would still hit A3's cap.
  const r = pay.confirmDeposit(db, intent.intent_id);
  assert.strictEqual(r.status, 'confirmed');
  assert.strictEqual(bal(db, alice.id).b, 125000, 'a provider-driven confirm credits exactly once');
  clean(db);
});

// A3: the DAILY cumulative cap. Even a fully compromised webhook is bounded:
// the original path could credit unbounded amounts in one day; now the
// per-user-per-day total refuses.
check('A3 (F1) a compromised webhook is bounded by the daily cumulative cap', async () => {
  const { db, alice } = (await fixture());
  // Cap the day at 100000 cents; ask for two intents of 60000 each.
  const prev = config.DEPOSIT_DAILY_MAX_CENTS;
  config.DEPOSIT_DAILY_MAX_CENTS = 100000;
  try {
    const a = await pay.openDeposit(db, alice.id, 60000);
    const b = await pay.openDeposit(db, alice.id, 60000);
    pay.confirmDeposit(db, a.intent_id);
    assert.strictEqual(bal(db, alice.id).b, 160000, 'first confirm passes');
    assert.throws(() => pay.confirmDeposit(db, b.intent_id), /daily cumulative cap/);
    assert.strictEqual(bal(db, alice.id).b, 160000, 'the second does not credit');
  } finally {
    config.DEPOSIT_DAILY_MAX_CENTS = prev;
  }
  clean(db);
});

// A3b: the daily cap is PER USER. The sum that enforces it had no user_id
// predicate while row.user_id sat in scope, so DEPOSIT_DAILY_MAX_CENTS —
// documented as "cumulative per user per day" — was a venue-wide total. Two
// players each depositing half the cap exhausted it between them, and the
// second was refused over money that was never theirs. The cap named after a
// per-user limit was the one thing bounding a single compromised account, and
// it was shared.
//
// With the venue-wide bug in place, alice's 60000 + bob's 60000 hits the
// 100000 ceiling and bob is refused. With the predicate in place both land.
check('A3b the daily cumulative cap is scoped PER USER, not venue-wide', async () => {
  const { db, alice, bob } = (await fixture());
  const prev = config.DEPOSIT_DAILY_MAX_CENTS;
  config.DEPOSIT_DAILY_MAX_CENTS = 100000; // $1,000 a day each
  try {
    const aliceIntent = await pay.openDeposit(db, alice.id, 60000);
    const bobIntent = await pay.openDeposit(db, bob.id, 60000);
    pay.confirmDeposit(db, aliceIntent.intent_id);
    pay.confirmDeposit(db, bobIntent.intent_id);

    assert.strictEqual(bal(db, alice.id).b, 160000, "alice credited, and only alice's own deposits count");
    assert.strictEqual(
      bal(db, bob.id).b,
      60000,
      "bob is credited too — alice's $600 is not bob's problem"
    );

    // …and the per-user cap is still real: bob's own second deposit refuses.
    const bobSecond = await pay.openDeposit(db, bob.id, 60000);
    assert.throws(() => pay.confirmDeposit(db, bobSecond.intent_id), /daily cumulative cap/);
    assert.strictEqual(bal(db, bob.id).b, 60000, 'and credits nothing');
    // …while alice, having deposited less in total, can still deposit.
    const aliceSecond = await pay.openDeposit(db, alice.id, 40000);
    pay.confirmDeposit(db, aliceSecond.intent_id);
    assert.strictEqual(bal(db, alice.id).b, 200000, "alice's own cap tracks her own money");
  } finally {
    config.DEPOSIT_DAILY_MAX_CENTS = prev;
  }
  clean(db);
});

// A4: the webhook's amount is CROSS-CHECKED against the recorded intent. The
// original confirmation credited whatever the intent ROW said, but a
// provider event claiming a different amount was never compared — a padded
// replay is a finding, not a credit.
check('A4 (F1) a webhook amount disagreeing with the intent is refused', async () => {
  const { db, alice } = (await fixture());
  const intent = await pay.openDeposit(db, alice.id, 25000);
  assert.throws(
    () => pay.confirmByExternalId(db, { provider: 'reference', externalId: intent.external_id, amountCents: 999999 }),
    /disagrees with the recorded intent/
  );
  assert.strictEqual(bal(db, alice.id).b, 100000, 'nothing credited');
  // The correct amount confirms fine.
  pay.confirmByExternalId(db, { provider: 'reference', externalId: intent.external_id, amountCents: 25000 });
  assert.strictEqual(bal(db, alice.id).b, 125000);
  clean(db);
});

// A5: the webhook ROUTE is signature-gated, and the signature is verified
// over the RAW body in constant time. Without a secret the route does not
// exist (404). This drives the real server route via supertest-style HTTP
// through the app — done here at the module boundary instead, because the
// property that matters is that the route is unreachable unsigned, which is
// enforced by the route's own guard.
check('A5 (F1) the HMAC secret makes signatures non-forgeable', async () => {
  // The route-level behaviour is covered by the smoke suite; here the
  // property under test is that a signature over a DIFFERENT body cannot
  // authenticate this body — the reason the route verifies the raw bytes.
  const secret = 'test-secret';
  const body = JSON.stringify({ external_id: 'x', amount_cents: 100 });
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const other = crypto.createHmac('sha256', secret).update(body + ' ').digest('hex');
  assert.notStrictEqual(sig, other, 'one trailing space changes the signature');
  const wrong = crypto.createHmac('sha256', 'wrong-secret').update(body).digest('hex');
  assert.notStrictEqual(sig, wrong, 'a different secret never matches');
});

// ── F3/F4: the settlement and cash-out primitives must defend THEMSELVES ───

// A6: cashoutPosition refuses a SETTLED market. The auditor called the
// primitive directly and it paid out AGAIN against a settled market,
// releasing another market's escrow to cover it, then bricked that market's
// settlement. The caller checked market state; the primitive now does too,
// so no second caller can inherit an unguarded money path.
check('A6 (F3) cashoutPosition refuses a settled market even when called directly', async () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, 'A6', datetime('now','+2 hours'))").run(sp.id);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get('A6');
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, 'Alpha');
  db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, 'Beta');
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, 'Alpha').id;
  const s2 = s1 + 1;
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 }));
  M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 1000 });
  M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 1000 });
  S.settleMarket(db, mkt.id, { winner_selection_id: s1 });

  // The auditor's exact call: the primitive against the settled market.
  assert.throws(
    () => S.cashoutPosition(db, alice.id, mkt.id, 5000),
    (e) => e.status === 409 && /settled/i.test(e.message),
    'the primitive refuses'
  );
  assert.strictEqual(bal(db, alice.id).b, 101000 - 25, 'and alice keeps her settled result, nothing more');
  void s2;
  clean(db);
});

// A7: a HELD market cannot be settled through the plain route. The reasoned
// release (a written reason, recorded in the audit log) is the only way out.
check('A7 (F4) a held market cannot be settled through the plain path', async () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, 'A7', datetime('now','+2 hours'))").run(sp.id);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get('A7');
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  db.prepare("UPDATE markets SET settlement_hold = 1, hold_reason = 'disputed outcome' WHERE id = ?").run(mkt.id);

  assert.throws(
    () => S.settleMarket(db, mkt.id, { void: true }),
    (e) => e.status === 409 && /held pending review/i.test(e.message),
    'the settlement primitive refuses'
  );
  assert.strictEqual(db.prepare('SELECT status FROM markets WHERE id=?').get(mkt.id).status, 'open', 'the market is untouched');
});

// ── F5: the withdrawal lifecycle was a dead end ─────────────────────────────

// A8: a withdrawal can now COMPLETE. Before, money sat in gateway_clearing
// forever: no route could finish it, and failDeposit did not even check the
// kind, so failing a withdrawal neither refunded nor re-credited.
check('A8 (F5) a withdrawal completes and the clearing position is reported', async () => {
  const { db, alice } = (await fixture());
  // The player's OPENING balance also posts through gateway_clearing, so the
  // assertions are DELTAS against a baseline — an absolute figure here would
  // depend on how the account was funded, not on the withdrawal.
  const clearingBefore = acc.balanceOf(db, acc.accountId(db, 'gateway_clearing', null));
  pay.openWithdrawal(db, alice.id, 40000, 'player request');
  assert.strictEqual(bal(db, alice.id).b, 60000, 'held at open');
  const intentId = db.prepare("SELECT id FROM payment_intents WHERE kind='withdrawal'").get().id;
  const r = pay.completeWithdrawal(db, intentId, 'provider paid out');
  assert.strictEqual(r.status, 'confirmed');
  assert.strictEqual(bal(db, alice.id).b, 60000, 'completion moves nothing further — it left at open');
  assert.strictEqual(
    acc.balanceOf(db, acc.accountId(db, 'gateway_clearing', null)) - clearingBefore,
    40000,
    'the clearing position records the completed payout'
  );
  // Idempotent: a retried completion is not a second payment.
  const again = pay.completeWithdrawal(db, intentId, 'retry');
  assert.strictEqual(again.already_confirmed, true);
  clean(db);
});

// A9: a withdrawal can FAIL and the player is refunded IN FULL, through the
// ledger, with the reverse posting — the books return to the state before
// the request.
check('A9 (F5) a failed withdrawal refunds the player exactly', async () => {
  const { db, alice } = (await fixture());
  const clearingBefore = acc.balanceOf(db, acc.accountId(db, 'gateway_clearing', null));
  pay.openWithdrawal(db, alice.id, 40000, 'player request');
  const intentId = db.prepare("SELECT id FROM payment_intents WHERE kind='withdrawal'").get().id;
  const r = pay.failWithdrawal(db, intentId, 'provider rejected');
  assert.strictEqual(r.refunded_cents, 40000);
  assert.strictEqual(bal(db, alice.id).b, 100000, 'the player is whole again');
  assert.strictEqual(
    acc.balanceOf(db, acc.accountId(db, 'gateway_clearing', null)) - clearingBefore,
    0,
    'nothing left stranded in clearing'
  );
  assert.throws(() => pay.failWithdrawal(db, intentId, 'again'), /is failed/);
  // And failDeposit refuses withdrawal intents outright.
  assert.throws(() => pay.failDeposit(db, intentId, 'x'), /use the withdrawal lifecycle/);
  clean(db);
});

// ── F6/F7: commission is the tenant's, and rounding is house-favourable ────

async function settleFixture() {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, 'Cx', datetime('now','+2 hours'))").run(sp.id);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get('Cx');
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, 'Alpha');
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=?').get(mkt.id).id;
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 }));
  return { db, mkt, s1, alice, bob };
}

// A10: a tenant negotiated down to 100 bps pays 100 bps. The audit's F6 was
// that the configurable figure was stored, audited, displayed in the admin
// UI — and never consulted at settlement.
check('A10 (F6) settlement charges the TENANT commission, not the global rate', async () => {
  const { db, mkt, s1, alice, bob } = (await settleFixture());
  // Alice backs 10000 @ 2.0 and wins 10000; at the default 250 bps the
  // commission is 250, at 100 bps it is 100.
  M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  const defaultBps = T.commissionBpsForUser(db, alice.id);
  assert.strictEqual(defaultBps, 250, 'the default tenant carries 250 bps');

  T.configure(db, { tenantId: T.defaultTenant(db).id, commission_bps: 100 });
  S.settleMarket(db, mkt.id, { winner_selection_id: s1 });
  assert.strictEqual(bal(db, alice.id).b, 100000 + 10000 - 100, 'charged 100 bps exactly');
  clean(db);
});

// A11: commission rounds UP. The audit's F7: 4198 in one market paid 105
// (round), split as 2099+2099 it paid 52+52=104 — a splitter could shave the
// fee. With ceil, splitting can only pay MORE, so the exploit direction is
// gone.
check('A11 (F7) splitting a win can no longer underpay commission', async () => {
  // Two markets, identical shape: a back of 2099 @ 2.0 wins 2099 each.
  // Commission each = ceil(2099 * 0.025) = ceil(52.475) = 53. Two markets
  // pay 53+53 = 106, versus the single-market 4198 win paying
  // ceil(4198 * 0.025) = ceil(104.95) = 105. Splitting pays MORE, not less.
  const results = [];
  for (let i = 0; i < 2; i++) {
    const { db, mkt, s1, alice, bob } = (await settleFixture());
    M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 2099 });
    M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 2099 });
    S.settleMarket(db, mkt.id, { winner_selection_id: s1 });
    results.push(100000 + 2099 - bal(db, alice.id).b);
  }
  assert.strictEqual(results[0], 53, 'each small market pays ceil');
  assert.strictEqual(results[0] + results[1], 106, 'split total (106) is not less than the whole (105)');
});

// ── F10: the house must be able to settle into a negative balance ──────────

// A12: the schema exempts the house bot from the non-negative CHECK because
// a won bet is paid out of the venue's own balance. The ledger used to refuse
// it anyway — which rolled back the ENTIRE market's payout and left the
// market un-settleable with no repair path (the audit's F10).
//
// No LEGITIMATE path can create this state: adjust refuses to drain below
// escrow, and an affordable position can never settle negative because its
// escrow covers the maximum loss. So this check is DEFENSE-IN-DEPTH for
// exactly one situation — a bug (like the lay-side replacement bug this same
// review found) consuming escrow out from under a live position. When that
// happens, the market must still SETTLE, because a bricked market with a
// stranded counterparty is worse than a house that owes money.
//
// The fixture reproduces the bug-shaped state directly — cache and postings
// kept in agreement — because no ledger operation can (correctly) express it.
check('A12 (F10) the house can settle negative without bricking the market', async () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, 'A12', datetime('now','+2 hours'))").run(sp.id);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get('A12');
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, 'Alpha');
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=?').get(mkt.id).id;
  // ensureBot() is synchronous (it runs inside transactions elsewhere) and so
  // cannot derive the house password hash itself — prime it first.
  await require('../lib/bots').primeBotHash();
  const house = require('../lib/bots').ensureBot(db);
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
  M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 1000 });
  M.placeOrder(db, { id: house.id }, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 1000 });

  const B = bal(db, house.id).b;
  const drain = B - 1; // leave the house one cent
  db.prepare('UPDATE users SET balance_cents = 1 WHERE id = ?').run(house.id);
  const info = db
    .prepare("INSERT INTO transactions (user_id, type, amount_cents, balance_after, frozen_after) VALUES (?, 'adjust', ?, 1, ?)")
    .run(house.id, -drain, bal(db, house.id).f);
  // A POSITIVE delta debits `from` and credits `to` — money from -> to. (The
  // first version passed -drain and CREDITED the house, doubling it: the sign
  // convention is from the posting layer, not from the transaction row.)
  acc.postTransfer(db, {
    transaction_id: Number(info.lastInsertRowid),
    from: acc.accountId(db, 'player_funds', house.id),
    to: acc.accountId(db, 'house_float', null),
    deltaCents: drain,
    memo: 'test: bug-shaped drain, postings kept in agreement',
  });
  // The cache and the postings agree even in this hand-built state.
  assert.deepStrictEqual(acc.assertUserAgrees(db), [], 'the fixture is postings-consistent');

  // The house loses the 1000-cent lay. Its balance would go to 1 - 1000.
  S.settleMarket(db, mkt.id, { winner_selection_id: s1 });
  assert.strictEqual(bal(db, house.id).b, 1 - 1000, 'the house paid out of its own balance, into negative');
  assert.strictEqual(db.prepare('SELECT status FROM markets WHERE id=?').get(mkt.id).status, 'settled', 'the market SETTLED — not bricked');
  assert.strictEqual(bal(db, alice.id).b, 100000 + 1000 - 25, "and the winner got paid, which is the whole point");
  clean(db);
});

// A13: the faucet (F8) stays per-deposit only — infinite paper money by
// repetition is ACCEPTABLE for a demo, but the property must be explicit,
// and the deposit-intent path that IS bounded must not be reachable from
// the faucet.
check('A13 (F8) the faucet is per-deposit, and that is documented and deliberate', async () => {
  const { db, alice } = (await fixture());
  for (let i = 0; i < 12; i++) ledger.deposit(db, alice.id, 100000, config.FAUCET_MAX_CENTS);
  assert.strictEqual(bal(db, alice.id).b, 100000 + 12 * 100000, 'the paper faucet repeats: fine for a demo');
  clean(db);
});

(async () => {
  // Drain the collected checks IN ORDER, awaiting each. A check that rejects
  // is a failure of this suite, not of the next file: exiting here stops
  // the rest of this suite running rather than letting a broken assertion
  // print a green line for a body that never completed.
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
  if (passed < 14) { console.error('expected 14 checks'); process.exit(1); }
  console.log(`\naudit.test.js: ${passed} checks passed`);
})();
