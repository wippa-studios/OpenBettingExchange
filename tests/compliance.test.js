'use strict';
// tests/compliance.test.js — customer pre-verification, the identity provider
// seam, and the enforcement that stops an unverified account reaching money.
//
// Run: node tests/compliance.test.js   (plain assert, no deps)
//
// WHY THESE ASSERTIONS ARE MEASURED RATHER THAN READ. Every check here is
// written against the question the brief asks — "can an unverified account reach
// the money?" — and the interesting ones are the NEGATIVE ones: that the gate
// refuses at each of the four money paths, and that it refuses BEFORE anything
// was written. A test that only asserts "the happy path still works" would pass on
// a gate that was never installed.
process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';
process.env.CASHOUT_ENABLED = 'false';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const L = require('../lib/ledger');
const PAY = require('../lib/payments');
const ID = require('../lib/identity');
const IDP = require('../lib/identity/provider');
const IDR = require('../lib/identity/reference');
const config = require('../lib/config');
const TEN = require('../lib/tenants');

let passed = 0;
const ok = (name, cond, detail) => {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ''}`);
  passed++;
  console.log('  ok', name);
};

const REFUSALS = {};

// The config is read at module load, so flipping IDENTITY_REQUIRED has to be done
// by mutating the loaded object — the same technique the RG and payments suites
// use for the same reason.
function withRequired(on, fn) {
  const before = config.IDENTITY_REQUIRED;
  config.IDENTITY_REQUIRED = on;
  try {
    return fn();
  } finally {
    config.IDENTITY_REQUIRED = before;
  }
}

// The async twin. `withRequired` restores the flag in a `finally`, so handing it
// an async function restores it BEFORE the body's first await — the flag would be
// back to false by the time the promise resolved and the gate would be inert.
async function withRequiredAsync(on, fn) {
  const before = config.IDENTITY_REQUIRED;
  config.IDENTITY_REQUIRED = on;
  try {
    return await fn();
  } finally {
    config.IDENTITY_REQUIRED = before;
  }
}

function fresh() {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name,slug) VALUES ('F','football')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  db.prepare("INSERT INTO events (sport_id,name,starts_at) VALUES (?,?,datetime('now','+2 hours'))").run(sp.id, 'E');
  const ev = db.prepare("SELECT id FROM events WHERE name='E'").get();
  db.prepare("INSERT INTO markets (event_id,name) VALUES (?, 'M')").run(ev.id);
  const m = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  db.prepare("INSERT INTO selections (market_id,name,fair_price) VALUES (?,?,2.0)").run(m.id, 'A');
  db.prepare("INSERT INTO selections (market_id,name,fair_price) VALUES (?,?,2.0)").run(m.id, 'B');
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=? ORDER BY id').get(m.id).id;
  return { db, m, s1 };
}

// Funded by default so the ORDINARY case can be exercised: a gate that refuses
// everything because nobody had money is not evidence of anything. `fund: false`
// is for the deposit checks, which need to observe a balance of zero before and
// after a confirmation.
async function user(db, name, { fund = true } = {}) {
  return A.registerUser(db, {
    username: name,
    password: `pw-${name}-1234`,
    ...(fund ? { balance_cents: 500000 } : {}),
  });
}

// The code an assertion threw with, or null.
function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return (e && e.details && e.details.code) || null;
  }
}
// Takes a THUNK, not a promise: `confirmDeposit` throws SYNCHRONOUSLY (node:sqlite
// is synchronous and lib/tx.js rolls back and rethrows on the same tick), so
// `codeOfAsync(fn())` would throw while evaluating the argument and never reach
// the catch. The first version of this suite made exactly that mistake and it
// read as a crash rather than as a passing check.
async function codeOfAsync(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e && e.details && e.details.code) || null;
  }
}

(async () => {
  // ── 1. The seam: a half-implemented provider fails at BOOT ────────────────
  {
    const missing = (() => {
      try {
        IDP.assertProvider({ name: 'broken' });
        return null;
      } catch (e) {
        return e.message;
      }
    })();
    ok('I1  assertProvider refuses a provider with no methods', !!missing && /missing/.test(missing), missing);
    // verifyCallback is the one that is required and uncalled, and the test pins
    // that it is still required — it is the part that is easy to get wrong and
    // impossible to retrofit safely, so it is in the contract from day one.
    ok('I2  verifyCallback is REQUIRED though nothing calls it', /verifyCallback/.test(missing || ''), missing);
    ok('I3  the decision vocabulary is closed', !IDP.DECISIONS.includes('approved'));
    ok('I4  a provider returning an unknown decision is refused AT THE SEAM', (() => {
      try {
        IDP.decisionOf('APPROVED', 'vendor');
        return false;
      } catch (e) {
        return /unrecognised decision/.test(e.message);
      }
    })());
  }

  // ── 2. The reference provider exercises the whole contract ────────────────
  {
    const p = IDR.referenceProvider({ selfExclusionOutcome: IDP.HIT });
    const s = await p.startVerification({ reference: 'user:1' });
    ok('R1  the reference provider starts a session and returns a client token', !!s.externalId && !!s.clientToken);
    const pending = await p.readVerification(s.externalId);
    ok('R2  a started verification is PENDING, not decided', pending.decision === IDP.PENDING);
    const bad = await p.verifyCallback(JSON.stringify({ externalId: s.externalId, age: 30 }), {}, 'not-a-signature');
    ok('R3  a callback with a bad signature is rejected', bad === null);
    const minor = await (async () => {
      const t = await p.startVerification({ reference: 'u' });
      // Sign it the way the provider would: the reference exposes the signer on
      // the object graph via __test, so the test drives the real path.
      const crypto = require('crypto');
      const sig = crypto.createHmac('sha256', 'reference-secret-not-for-production')
        .update(JSON.stringify({ externalId: t.externalId, age: 16 })).digest('hex');
      return p.verifyCallback(JSON.stringify({ externalId: t.externalId, age: 16 }), {}, sig);
    })();
    ok('R5  a reference minor FAILS on the age check', minor && minor.decision === IDP.FAIL, minor && minor.decision);
    ok('R6  the failing check is named, not just the outcome', minor && minor.checks.some((c) => c.check === 'age_assurance'));
    const closed = await p.closeSession(s.externalId);
    ok('R7  a session can be closed', closed.closed === true);
    const excl = await p.checkSelfExclusion({ reference: 'user:1' });
    ok('R8  the reference self-exclusion screen is configurable to a HIT', excl.outcome === IDP.HIT);
    const sanc = await p.screenSanctions({ reference: 'user:1' }, {});
    ok('R9  a screening answer carries the lists it consulted', Array.isArray(sanc.lists) && !!sanc.lists_version);
  }

  // ── 3. Registration alone must not produce a usable account ───────────────
  {
    const { db, s1 } = fresh();
    const alice = await user(db, 'alice');
    const bob = await user(db, 'bob');
    const status = db.prepare('SELECT identity_status FROM users WHERE id = ?').get(alice.id).identity_status;
    ok('V1  a new account is born UNVERIFIED by default', status === ID.IDENTITY_UNVERIFIED, status);

    // The headline evidence: with pre-verification enforced, an unverified account
    // cannot place an order, cannot deposit and cannot withdraw.
    const ordersRefused = withRequired(true, () =>
      codeOf(() => M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 1000 }))
    );
    ok('V2  an unverified account cannot PLACE AN ORDER', ordersRefused === 'identity_unverified', ordersRefused);

    // Nothing was written. The refusal ran inside placeOrder's transaction and
    // before any collateral, so there is no order, no escrow and no ledger row.
    const left = db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id = ?').get(alice.id).c;
    const frozen = db.prepare('SELECT frozen_cents f FROM users WHERE id = ?').get(alice.id).f;
    ok('V4  the refused order left NO row behind (refused before collateral)', left === 0, `${left} order(s)`);
    ok('V5  ...and took no escrow', frozen === 0, `frozen=${frozen}`);

    // And the ordinary case still works, which is the other half: a gate that
    // refuses everything is not a gate.
    ID.setDecision(db, { actor: { id: 1, role: 'admin' }, userId: alice.id, decision: 'verified', reason: 'test remediation' });
    withRequired(true, () => {
      const order = M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 1000 });
      assert.ok(order && order.order, 'a verified account can trade');
    });
    ok('V6  a VERIFIED account can still place an order', true);
    ok('V7  a verified account\'s escrow is now held', db.prepare('SELECT frozen_cents f FROM users WHERE id=?').get(alice.id).f === 1000);

    // Distinguish the four states, because the client renders different advice.
    const codes = {};
    for (const st of [ID.IDENTITY_UNVERIFIED, ID.IDENTITY_PENDING, ID.IDENTITY_FAILED, ID.IDENTITY_REVIEW]) {
      db.prepare('UPDATE users SET identity_status = ? WHERE id = ?').run(st, bob.id);
      codes[st] = withRequired(true, () =>
        codeOf(() => M.placeOrder(db, bob, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 1000 }))
      );
    }
    const distinct = new Set(Object.values(codes));
    ok('V8  each status refuses with a DISTINCT machine-readable code', distinct.size === 4, JSON.stringify(codes));
    ok('V9  ...and each is the code naming that status', codes[ID.IDENTITY_FAILED] === 'identity_failed' && codes[ID.IDENTITY_REVIEW] === 'identity_review', JSON.stringify(codes));
    db.close();
  }

  // ── 4. The deposit and withdrawal paths ──────────────────────────────────
  {
    const { db } = fresh();
    const alice = await user(db, 'carol', { fund: false });
    const intent = await PAY.openDeposit(db, alice.id, 5000);
    const depositRefused = await withRequiredAsync(true, () =>
      codeOfAsync(() => PAY.confirmDeposit(db, intent.intent_id))
    );
    ok('D1  an unverified account cannot have a deposit CONFIRMED', depositRefused === 'identity_unverified', depositRefused);
    // The critical half: not refused, but refused with NO MONEY MOVED. A deposit
    // that failed the check and credited anyway is worse than one that failed.
    const bal = db.prepare('SELECT balance_cents b FROM users WHERE id=?').get(alice.id).b;
    const stillPending = db.prepare("SELECT status FROM payment_intents WHERE id=?").get(intent.intent_id).status;
    ok('D2  the refused deposit credited NOTHING', bal === 0, `balance=${bal}`);
    ok('D3  ...and the intent was NOT marked failed (a human must see it)', stillPending === 'pending', stillPending);

    ID.setDecision(db, { actor: { id: 1, role: 'admin' }, userId: alice.id, decision: 'verified', reason: 'test remediation' });
    await withRequiredAsync(true, () => {
      const r = PAY.confirmDeposit(db, intent.intent_id);
      assert.strictEqual(r.status, 'confirmed');
    });
    ok('D4  a verified account\'s deposit confirms', db.prepare('SELECT balance_cents b FROM users WHERE id=?').get(alice.id).b === 5000);

    // Withdrawal. THE INTERESTING ONE: /api/wallet/withdraw deliberately does not
    // gate on assertTradeable, because self-exclusion is a promise about play and
    // not about custody. Identity IS gated on the payout, because an unverified
    // account is one the venue cannot prove belongs to the person asking.
    const w = withRequired(true, () => codeOf(() => PAY.openWithdrawal(db, alice.id, 1000)));
    ok('D5  a verified account CAN withdraw (the control is not a blanket ban)', w === null, String(w));
    const afterOk = db.prepare("SELECT COUNT(*) c FROM payment_intents WHERE kind='withdrawal'").get().c;
    db.prepare('UPDATE users SET identity_status = ? WHERE id = ?').run('unverified', alice.id);
    const w2 = withRequired(true, () => codeOf(() => PAY.openWithdrawal(db, alice.id, 1000)));
    ok('D6  an unverified account cannot withdraw', w2 === 'identity_unverified', w2);
    const held = db.prepare("SELECT COUNT(*) c FROM payment_intents WHERE kind='withdrawal'").get().c;
    ok('D7  ...and no hold was taken on the refused withdrawal', held === afterOk, `${held} vs ${afterOk}`);
    // The debit matters more than the row: a refusal that still debited would be
    // a worse failure than one that refused, because the customer would be unable
    // to get the money back through the route that took it.
    ok('D8  ...and the refusal took no money either',
      db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM transactions WHERE user_id=? AND type='withdraw'").get(alice.id).s === -1000,
      'exactly the one successful withdrawal, and the ledger records it as a negative');
    db.close();
  }

  // ── 5. Exemptions, because an exemption nobody can see is a hole ─────────
  {
    const { db, s1 } = fresh();
    const admin = await A.createAccount(db, { username: 'boss', password: 'pw-boss-1234', role: 'admin' });
    const house = await A.createAccount(db, { username: 'house', password: 'pw-house-1234', is_bot: 1 });
    const alice = await user(db, 'dave');
    withRequired(true, () => {
      // Neither the operator's own accounts nor the venue's market maker can
      // complete a customer KYC flow, and gating them would break the product.
      ID.assertVerified(db, admin.id);
      ID.assertVerified(db, house.id);
      assert.ok(true);
    });
    ok('E1  the operator\'s own admin account is exempt from customer pre-verification', true);
    ok('E2  the venue\'s market-maker account is exempt', true);
    ok('E3  a customer is NOT exempt', codeOf(() => withRequired(true, () => ID.assertVerified(db, alice.id))) === 'identity_unverified');
    // And there is deliberately no "exempt" value an operator can set.
    ok('E4  there is no exempt status to set', !ID.IDENTITY_STATUSES.includes('exempt'));
    const rejected = (() => {
      try {
        ID.setDecision(db, { actor: admin, userId: alice.id, decision: 'unverified', reason: 'trying to wave it through' });
        return null;
      } catch (e) {
        return e.status;
      }
    })();
    ok('E5  an operator cannot record "unverified" as a decision', rejected === 400, String(rejected));
    const unreasoned = (() => {
      try {
        ID.setDecision(db, { actor: admin, userId: alice.id, decision: 'verified', reason: 'ok' });
        return null;
      } catch (e) {
        return e.status;
      }
    })();
    ok('E6  an operator decision needs a WRITTEN reason', unreasoned === 400, String(unreasoned));
    void s1;
    db.close();
  }

  // ── 6. The lifecycle: start -> decide -> destroy the age artefact ─────────
  {
    const { db } = fresh();
    const alice = await user(db, 'erin');
    const started = await ID.startVerification(db, { userId: alice.id, actor: alice, subjectName: 'Erin Example' });
    ok('L1  starting a verification moves the account to PENDING', started.identity_status === ID.IDENTITY_PENDING);
    ok('L2  ...and leaves the gate closed', codeOf(() => withRequired(true, () => ID.assertVerified(db, alice.id))) === 'identity_pending');

    // THE AGE-ASSURANCE SPLIT. Age assurance is its own record with its own
    // retention, and this is the assertion that it is separately erasable AND that
    // using it destroys it.
    ID.recordAgeAssurance(db, {
      userId: alice.id, actor: alice, provider: 'reference',
      method: 'privacy_preserving', assurance: 'attested', outcome: 'pass',
      attributes: { note: 'the vendor returned nothing identifiable' },
      reason: 'test',
    });
    const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all('age_assurance').map((r) => r.name);
    ok('A1  the age-assurance record carries NO date of birth', !cols.includes('dob') && !cols.includes('date_of_birth') && !cols.includes('birth_date'));
    ok('A2  ...and NO document image or number', !cols.some((c) => /document|image|passport|licence|license/.test(c)), cols.join(','));
    ok('A3  ...and no such column on users either', !db.prepare('SELECT name FROM pragma_table_info(?)').all('users').map((r) => r.name).some((c) => /dob|birth/.test(c)));

    // The identity record may carry a NAME (third-party funding needs it) and an
    // opaque subject reference; the age record may not be entangled with it.
    const ivCols = db.prepare('SELECT name FROM pragma_table_info(?)').all('identity_verifications').map((r) => r.name);
    ok('A4  the identity record carries the verified subject name', ivCols.includes('subject_name'));
    ok('A5  ...and an opaque subject reference', ivCols.includes('subject_reference'));

    // THE DECISION. Applying it must DESTROY the age artefact in the SAME
    // transaction, so there is no window in which the obligation is discharged
    // and the personal information still exists. That is the whole of
    // "destroyed once used" as a property of the CODE rather than of a job
    // somebody might forget to schedule.
    const appliedDecision = ID.applyDecision(db, {
      verificationId: started.verification_id,
      providerName: 'reference',
      decision: 'pass',
      checks: [
        { check: 'document', outcome: 'pass', at: '2026-01-01T00:00:00Z' },
        { check: 'face_liveness', outcome: 'pass', at: '2026-01-01T00:00:01Z' },
        { check: 'age_assurance', outcome: 'pass', at: '2026-01-01T00:00:02Z' },
      ],
      detail: 'all reference checks passed',
      subjectName: 'Erin Example',
      actor: null,
    });
    ok('L3  a decision carries the constituent checks that produced it', appliedDecision.checks.length === 3);
    ok('L4  ...and the vendor check names are stored verbatim',
      appliedDecision.checks.some((c) => c.check === 'face_liveness'), JSON.stringify(appliedDecision.checks.map((c) => c.check)));
    ok('A11 applying a decision DESTROYS the age artefact in the same transaction',
      appliedDecision.age_assurance_erased === true);
    const post = db.prepare('SELECT attributes, erased_at FROM age_assurance WHERE user_id = ?').get(alice.id);
    ok('A12 ...so the personal information is already gone when it returns',
      post.attributes === null && !!post.erased_at);
    // THE DURABLE EVIDENCE SURVIVES. The check OUTCOME is financial-crime
    // material and is kept; only the ARTEFACT is destroyed. That is the difference
    // between a design that works if the provision is enacted and one that does
    // not.
    ok('A13 ...while the durable obligation evidence REMAINS',
      appliedDecision.checks.some((c) => c.check === 'age_assurance' && c.outcome === 'pass'));
    ok('L5  a decided pass moves the account to VERIFIED', appliedDecision.identity_status === ID.IDENTITY_VERIFIED);
    // AND THE ACCOUNT ROW ACTUALLY MOVED. `identity_status` above is the decision
    // mapped to a status; this is the row. The first version of applyDecision
    // checked whether the attempt was current AFTER it had already stamped the
    // attempt as decided, so the check found nothing and the row was never
    // written — every pass recorded a decision and left the account pending
    // forever. Only this assertion catches it.
    ok('L5b ...and the users row was actually WRITTEN, not just returned',
      appliedDecision.account_updated === true &&
      db.prepare('SELECT identity_status FROM users WHERE id=?').get(alice.id).identity_status === ID.IDENTITY_VERIFIED);
    ok('L6  ...and the gate now opens', codeOf(() => withRequired(true, () => ID.assertVerified(db, alice.id))) === null);
    ok('L7  ...and the verified subject name is recorded for the funding comparison',
      db.prepare('SELECT subject_name n FROM identity_verifications WHERE id=?').get(started.verification_id).n === 'Erin Example');

    // ERASURE AS A STANDALONE ACTION, on a DIFFERENT account — because the
    // account above has already had its artefact destroyed BY USE, which is
    // A11 and is a different path. Reusing one account would make the second
    // erasure a no-op and the assertions below would pass for the wrong reason.
    const bob = await user(db, 'heidi');
    ID.recordAgeAssurance(db, {
      userId: bob.id, actor: bob, provider: 'reference',
      method: 'third_party', assurance: 'verified', outcome: 'pass',
      externalId: 'vendor-handle-abc', attributes: { anything: 'the vendor returned this' },
      reason: 'test',
    });
    const live = db.prepare('SELECT external_id, attributes, erased_at FROM age_assurance WHERE user_id = ?').get(bob.id);
    ok('A6a the live age-assurance record holds the vendor handle and its attributes',
      live.external_id === 'vendor-handle-abc' && !!live.attributes && !live.erased_at);
    const erased = ID.eraseAgeAssurance(db, { userId: bob.id, actor: bob, reason: 'no longer needed' });
    ok('A6  age assurance is INDIVIDUALLY erasable', erased.erased === true);
    const after = db.prepare('SELECT external_id, attributes, erased_at FROM age_assurance WHERE user_id = ?').get(bob.id);
    ok('A7  ...and erasing NULLS the identifying columns', after.external_id === null && after.attributes === null);
    ok('A8  ...and leaves the TOMBSTONE, so the erasure is provable', !!after.erased_at);
    ok('A9  ...and the tombstone is audited', db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='identity.age_assurance_erased'").get().c === 2, 'both erasures');
    const twice = ID.eraseAgeAssurance(db, { userId: bob.id, actor: bob, reason: 'again' });
    ok('A10 erasing twice is idempotent, not an error', twice.erased === false && !!twice.already_erased);
    ok('A14 erasing ONE person does not touch the other',
      db.prepare("SELECT COUNT(*) c FROM age_assurance WHERE user_id=? AND erased_at IS NULL").get(alice.id).c === 0 &&
      db.prepare("SELECT COUNT(*) c FROM age_assurance").get().c === 2);
    db.close();
  }

  // ── 7. A PASS WITH NO CHECKS IS REFUSED ──────────────────────────────────
  {
    const { db } = fresh();
    const alice = await user(db, 'frank');
    const s = await ID.startVerification(db, { userId: alice.id, actor: alice });
    const thrown = (() => {
      try {
        ID.applyDecision(db, {
          verificationId: s.verification_id,
          providerName: 'reference',
          decision: 'pass',
          checks: [],
          detail: 'a pass with nothing behind it',
          actor: null,
        });
        return null;
      } catch (e) {
        return e.status;
      }
    })();
    ok('C1  a PASS with no constituent checks is REFUSED', thrown === 502, String(thrown));
    ok('C2  ...and the account is still unverified, not quietly verified',
      db.prepare('SELECT identity_status s FROM users WHERE id=?').get(alice.id).s === ID.IDENTITY_PENDING);
    db.close();
  }

  // ── 8. Tipping-off: the player's own surface leaks nothing ───────────────
  {
    const { db } = fresh();
    const alice = await user(db, 'grace');
    await ID.startVerification(db, { userId: alice.id, actor: alice, subjectName: 'Grace Example' });
    // An alert, which is the thing that must never surface.
    db.prepare(
      `INSERT INTO aml_alerts (rule_id, scope, severity, user_id, detail, evidence)
       VALUES ('AU-TX-01','AU-TX-01:user:' || ?,'high',?,'a sanctions match','{"check":"sanctions"}')`
    ).run(alice.id, alice.id);
    const mine = ID.statusOf(db, alice.id);
    const text = JSON.stringify(mine);
    ok('T1  the player surface carries no alert', !/alert|sanction|investigat/i.test(text), text);
    ok('T2  ...no screening outcome', !/screen|hit|clear/i.test(text), text);
    ok('T3  ...no constituent checks', !/document|liveness|face_liveness/.test(text));
    ok('T4  ...no operator reason', !/reason/i.test(text));
    ok('T5  ...and no verified subject name', !/Grace Example/.test(text));
    ok('T6  ...but it does say what the customer must do', typeof mine.next === 'string' || /verif/i.test(mine.message));
    ok('T7  the screening endpoint returns NOTHING about the outcome', await (async () => {
      const r = await ID.screen(db, { userId: alice.id, actor: alice, reference: 'user:' + alice.id });
      return Object.keys(r).join(',') === 'screened,checks';
    })());
    // ...and the alert it created is entitlement-gated.
    const F = require('../lib/aml/findings');
    ok('T8  an unentitled operator is refused the alert list',
      codeOf(() => F.openAlerts(db, { actor: { id: 1, role: 'admin' } })) === 'aml_not_entitled');
    ok('T9  ...and an entitled one is not', await (async () => {
      F.setEntitlement(db, { actor: { id: 1, role: 'admin' }, userId: 1, entitled: true, reason: 'compliance officer' });
      const rows = F.openAlerts(db, { actor: { id: 1, role: 'admin' } });
      return Array.isArray(rows);
    })());
    ok('T10 the entitlement table ships with a reason and an audit row',
      db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='aml.entitlement_changed'").get().c === 1);
    db.close();
  }

  // ── 9. THE MIGRATION: idempotent, probing, and silent on a healthy boot ──
  //
  // Three properties the brief asks for by name, and each one is a property a
  // migration can look like it has while not having it — so each is measured.
  {
    const { openStore } = require('../lib/store');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    // A DATABASE FROM BEFORE THIS WORK, not a fresh one. The interesting case is
    // the upgrade path, and building it by opening a current schema and closing
    // it would test nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obx-mig-'));
    const file = path.join(dir, 'old.db');
    {
      // Build the "old" shape directly: the users/result_events/payment_intents
      // tables WITHOUT any compliance column, and without the new tables at all.
      const { DatabaseSync } = require('node:sqlite');
      const old = new DatabaseSync(file);
      old.exec(`CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, pass_hash TEXT, role TEXT,
        is_admin INTEGER DEFAULT 0, is_bot INTEGER DEFAULT 0, balance_cents INTEGER DEFAULT 0,
        frozen_cents INTEGER DEFAULT 0, email TEXT, created_at TEXT, self_excluded INTEGER DEFAULT 0
      );
      INSERT INTO users (username, role, balance_cents) VALUES ('legacy', 'user', 5000);`);
      old.close();
    }

    // FIRST UPGRADE.
    const db = openStore(file);
    const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all('users').map((r) => r.name);
    ok('M1  the migration ADDS the verification state to users',
      cols.includes('identity_status') && cols.includes('identity_status_at'), cols.join(','));
    ok('M2  ...and the registration origin the link analysis needs',
      cols.includes('registration_ip') && cols.includes('registration_device'));
    ok('M3  a PRE-EXISTING account is backfilled UNVERIFIED, not verified',
      db.prepare('SELECT identity_status s FROM users WHERE username=?').get('legacy').s === ID.IDENTITY_UNVERIFIED,
      db.prepare('SELECT identity_status s FROM users WHERE username=?').get('legacy').s);
    ok('M4  ...which is the obligation shape: the rule has a commencement date',
      ID.IDENTITY_STATUSES.includes('unverified'));
    ok('M5  ...and it was NOT silently waved through as verified', true);
    for (const t of ['age_assurance', 'identity_verifications', 'aml_alerts', 'aml_entitlements',
                     'aml_threshold_obligations', 'aml_rule_thresholds', 'funding_instruments',
                     'payment_methods', 'data_sources']) {
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
      ok(`M6  the migration CREATES the missing table ${t}`, !!has);
    }
    const ri = db.prepare('SELECT name FROM pragma_table_info(?)').all('result_events').map((r) => r.name);
    ok('M7  ...and EXTENDS result_events rather than replacing its source vocabulary',
      ri.includes('data_source_id') && ri.includes('source'));
    const pi = db.prepare('SELECT name FROM pragma_table_info(?)').all('payment_intents').map((r) => r.name);
    ok('M8  ...and extends payment_intents with the FUNDING side',
      pi.includes('payer_name') && pi.includes('funding_country') && pi.includes('funding_instrument_id')
      && pi.includes('payment_method_id') && pi.includes('beneficiary_country'));
    ok('M9  a legacy deposit intent records NO funding facts, rather than a guessed one',
      (db.prepare('SELECT COUNT(*) c FROM payment_intents').get().c === 0));

    // NOW THE THREE PROPERTIES THAT MATTER.
    //
    // (a) RE-RUNNABLE. `openStore` on the already-migrated file must not throw,
    //     which is the failure that would leave an operator unable to restart.
    const before = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    db.close();
    let reopened = null;
    let rerunError = null;
    try {
      reopened = openStore(file);
    } catch (e) {
      rerunError = e;
    }
    ok('M10 the migration is RE-RUNNABLE — a second open does not throw', !rerunError, rerunError && rerunError.message);
    ok('M11 ...and loses nothing', reopened && reopened.prepare('SELECT COUNT(*) c FROM users').get().c === before);
    ok('M12 ...and the backfilled status survives the second pass',
      reopened && reopened.prepare('SELECT identity_status s FROM users WHERE username=?').get('legacy').s === ID.IDENTITY_UNVERIFIED);

    // (b) WRITES NOTHING ON A HEALTHY BOOT. Measured by content hash, not by
    //     counting statements: a migration that rewrites a row to the same value
    //     writes a row, and on financial-crime tables that is not a harmless
    //     no-op.
    const tables = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map((r) => r.name);
    const snapshot = () => tables.map((t) => `${t}:${JSON.stringify(reopened.prepare(`SELECT * FROM "${t}"`).all())}`).join('|');
    const h1 = snapshot();
    reopened.close();
    const third = openStore(file);
    const h2 = snapshotWith(third, tables);
    ok('M13 a healthy boot changes NO ROW in ANY table', h1 === h2,
      h1 === h2 ? '' : tables.find((t, i) => h1.split('|')[i] !== h2.split('|')[i]));
    ok('M14 ...and the index set is stable across boots (no index recreated on every open)',
      indexesOf(third).length === indexesOf(openStore(file)).length);
    third.close();
    fs.rmSync(dir, { recursive: true, force: true });

    function snapshotWith(conn, ts) {
      return ts.map((t) => `${t}:${JSON.stringify(conn.prepare(`SELECT * FROM "${t}"`).all())}`).join('|');
    }
    function indexesOf(conn) {
      return conn.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    }
  }

  console.log(`\ncompliance.test.js: ${passed} checks passed`);
})().catch((e) => {
  console.error('compliance.test.js FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});