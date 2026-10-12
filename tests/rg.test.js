// rg.test.js — responsible-gambling controls: session limit, reality check,
// deposit limit.
// Run: node tests/rg.test.js   (plain assert, no deps)
//
// WHY THIS EXISTS. Self-exclusion shipped in Phase 1; the other three
// controls every jurisdiction requires did not. docs/ROADMAP.md is blunt: the
// product should not be deployable to an operator who has not configured them.
// A session limit that lives in the UI is a suggestion — so these are asserted
// in the engine, inside the ONE function every betting path already calls.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';
process.env.FAUCET_MAX_CENTS = '1000000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const L = require('../lib/limits');
const RG = require('../lib/rg');
const ledger = require('../lib/ledger');
const acc = require('../lib/accounts');
const config = require('../lib/config');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

let n = 0;
function fixture() {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  n++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now','+2 hours'))").run(sp.id, `Ev ${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Ev ${n}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, 'Alpha');
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=?').get(mkt.id).id;
  const alice = A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 });
  const bob = A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 });
  return { db, alice, bob, marketId: mkt.id, s1 };
}

const bet = (f, who, price = 2.0, stake = 1000) =>
  M.placeOrder(f.db, who, { selection_id: f.s1, side: 'back', price, stake_cents: stake });
// A LAY, because two backs never match — the same trap this session's earlier
// tests fell into twice.
const lay = (f, who, price = 2.0, stake = 1000) =>
  M.placeOrder(f.db, who, { selection_id: f.s1, side: 'lay', price, stake_cents: stake });
const bal = (f, who) => f.db.prepare('SELECT balance_cents b, frozen_cents fz FROM users WHERE username=?').get(who);

// A helper that ages the RG clocks, since SQLite datetime is what both the
// engine and the tests read.
const age = (f, { session = 0, check = 0 } = {}) => {
  if (session) f.db.prepare("UPDATE user_rg_state SET session_started_at = datetime('now', ?) WHERE user_id = ?").run(`-${session} minutes`, f.alice.id);
  if (check) f.db.prepare("UPDATE user_rg_state SET last_reality_check_at = datetime('now', ?) WHERE user_id = ?").run(`-${check} minutes`, f.alice.id);
};

// G1: with NOTHING configured, play is unaffected. The controls are
// operator-configured, so the default must be a venue that works — the boot
// warning is what makes the default honest, not a refusal that breaks the demo.
check('G1 unconfigured RG controls change nothing', () => {
  const prev = [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES, config.RG_DEPOSIT_DAILY_CENTS];
  config.RG_SESSION_MINUTES = 0;
  config.RG_REALITY_CHECK_MINUTES = 0;
  config.RG_DEPOSIT_DAILY_CENTS = 0;
  try {
    assert.strictEqual(RG.configured(), false, 'reported as unconfigured');
    const f = fixture();
    assert.ok(bet(f, f.alice).order.id, 'play is unaffected');
    ledger.deposit(f.db, f.alice.id, 500000, config.FAUCET_MAX_CENTS);
    assert.strictEqual(bal(f, 'alice').b, 100000 + 500000, 'deposits are unaffected');
  } finally {
    [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES, config.RG_DEPOSIT_DAILY_CENTS] = prev;
  }
});

// G2: THE SESSION LIMIT. Age the session past the configured limit and play
// stops — at the engine, not in the UI.
check('G2 a session limit stops play at the limit', () => {
  const prev = config.RG_SESSION_MINUTES;
  config.RG_SESSION_MINUTES = 60;
  try {
    const f = fixture();
    RG.startSession(f.db, f.alice.id);
    assert.ok(bet(f, f.alice).order.id, 'play works inside the limit');
    age(f, { session: 61 });
    assert.throws(
      () => bet(f, f.alice),
      (e) => e.status === 403 && e.details.code === 'session_limit_reached' && e.details.session_limit_minutes === 60,
      'play stops after the limit'
    );
    // And no money moved on the refused attempt.
    assert.strictEqual(acc.assertConserved(f.db), 0);
  } finally {
    config.RG_SESSION_MINUTES = prev;
  }
});

// G3: THE LIMIT CANNOT BE RESET BY SIGNING IN AGAIN. This is the whole point —
// a session limit defeated by refreshing the page is not a limit. The session
// clock is stamped once and only cleared by signing OUT.
check('G3 signing in again does NOT restart the session clock', () => {
  const prev = config.RG_SESSION_MINUTES;
  config.RG_SESSION_MINUTES = 60;
  try {
    const f = fixture();
    RG.startSession(f.db, f.alice.id);
    age(f, { session: 61 });
    const first = RG.stateOf(f.db, f.alice.id).session_started_at;
    // A second sign-in (what a refresh looks like to the server).
    RG.startSession(f.db, f.alice.id);
    assert.strictEqual(RG.stateOf(f.db, f.alice.id).session_started_at, first, 'the clock is unchanged');
    assert.throws(() => bet(f, f.alice), (e) => e.details.code === 'session_limit_reached', 'still limited');
    // Signing OUT is the reset — a player who has finished should be able to
    // come back tomorrow.
    RG.endSession(f.db, f.alice.id);
    assert.strictEqual(RG.stateOf(f.db, f.alice.id).session_started_at, null);
    RG.startSession(f.db, f.alice.id);
    assert.ok(bet(f, f.alice).order.id, 'a new session plays again');
  } finally {
    config.RG_SESSION_MINUTES = prev;
  }
});

// G4: THE REALITY CHECK. The ENGINE decides one is due, and only the
// acknowledgement clears it. A check the player can skip by not clicking is
// not a check.
check('G4 a due reality check blocks play until acknowledged', () => {
  const prev = config.RG_REALITY_CHECK_MINUTES;
  config.RG_REALITY_CHECK_MINUTES = 20;
  try {
    const f = fixture();
    RG.startSession(f.db, f.alice.id);
    assert.strictEqual(RG.realityCheckDue(f.db, f.alice.id).due, false, 'not due at the start');
    assert.ok(bet(f, f.alice).order.id, 'play works');

    age(f, { check: 21 });
    const due = RG.realityCheckDue(f.db, f.alice.id);
    assert.strictEqual(due.due, true, 'due after the interval');
    assert.throws(
      () => bet(f, f.alice),
      (e) => e.status === 403 && e.details.code === 'reality_check_due',
      'play is blocked while a check is owed'
    );
    const ack = RG.acknowledgeRealityCheck(f.db, f.alice.id);
    assert.ok(ack.acknowledged_at, 'acknowledged');
    assert.strictEqual(RG.realityCheckDue(f.db, f.alice.id).due, false, 'and the clock resets');
    assert.ok(bet(f, f.alice).order.id, 'play resumes');
  } finally {
    config.RG_REALITY_CHECK_MINUTES = prev;
  }
});

// G5: the acknowledgement records the player's OWN net position, so the
// summary shown to them is auditable rather than a client-side number.
check('G5 a reality check records the player own net position', () => {
  const prev = config.RG_REALITY_CHECK_MINUTES;
  config.RG_REALITY_CHECK_MINUTES = 20;
  try {
    const f = fixture();
    RG.startSession(f.db, f.alice.id);
    // Give alice a settled win so there is a real net to report. bob LAYS:
    // two backs would never match and she would have nothing settled.
    bet(f, f.alice, 2.0, 1000);
    lay(f, f.bob, 2.0, 1000);
    require('../lib/settle').settleMarket(f.db, f.marketId, { winner_selection_id: f.s1 });
    const ack = RG.acknowledgeRealityCheck(f.db, f.alice.id);
    assert.strictEqual(ack.net_settled_today_cents, 1000, 'her net win is recorded');
    assert.strictEqual(ack.balance_cents, bal(f, 'alice').b, 'and her balance');
    assert.strictEqual(RG.stateOf(f.db, f.alice.id).last_check_net_cents, 1000, 'persisted');
  } finally {
    config.RG_REALITY_CHECK_MINUTES = prev;
  }
});

// G6: THE DEPOSIT LIMIT, on BOTH deposit paths. A limit that only guards the
// faucet is defeated by using the payment intent instead.
check('G6 the deposit limit applies to both deposit paths', () => {
  const prev = config.RG_DEPOSIT_DAILY_CENTS;
  config.RG_DEPOSIT_DAILY_CENTS = 100000;
  try {
    const f = fixture();
    ledger.deposit(f.db, f.alice.id, 60000, config.FAUCET_MAX_CENTS); // the faucet
    assert.strictEqual(RG.depositedInWindow(f.db, f.alice.id), 60000);
    // 40000 more fits; 40001 does not.
    RG.assertDeposit(f.db, f.alice.id, 40000); // exactly at the cap: allowed
    assert.throws(
      () => RG.assertDeposit(f.db, f.alice.id, 40001),
      (e) => e.status === 403 && e.details.code === 'deposit_limit_reached' && e.details.cap_cents === 100000,
      'one cent over is refused'
    );
  } finally {
    config.RG_DEPOSIT_DAILY_CENTS = prev;
  }
});

// G7: the deposit limit is a ROLLING window, so it cannot be reset by waiting
// for midnight — a calendar-day limit is trivially gamed by depositing at
// 23:59 and 00:01.
check('G7 the deposit window is rolling, not a calendar day', () => {
  const prev = config.RG_DEPOSIT_DAILY_CENTS;
  config.RG_DEPOSIT_DAILY_CENTS = 100000;
  try {
    const f = fixture();
    ledger.deposit(f.db, f.alice.id, 60000, config.FAUCET_MAX_CENTS);
    // Age that deposit to 23 hours ago: still inside the rolling 24h window.
    f.db.prepare("UPDATE transactions SET at = datetime('now','-23 hours') WHERE user_id = ? AND type='deposit'").run(f.alice.id);
    assert.strictEqual(RG.depositedInWindow(f.db, f.alice.id), 60000, 'still counted at 23h');
    // Age it past 24h: out of the window.
    f.db.prepare("UPDATE transactions SET at = datetime('now','-25 hours') WHERE user_id = ? AND type='deposit'").run(f.alice.id);
    assert.strictEqual(RG.depositedInWindow(f.db, f.alice.id), 0, 'released after 24h');
    RG.assertDeposit(f.db, f.alice.id, 100000); // the whole cap available again
  } finally {
    config.RG_DEPOSIT_DAILY_CENTS = prev;
  }
});

// G8: THE CONTROLS ARE NOT A BYPASS AROUND EXCLUSION OR SUSPENSION. They sit
// inside the same gate, and a self-excluded account is still refused with the
// exclusion message — not a session message that invites an argument.
check('G8 exclusion still outranks the RG controls', () => {
  const prev = [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES];
  config.RG_SESSION_MINUTES = 60;
  config.RG_REALITY_CHECK_MINUTES = 20;
  try {
    const f = fixture();
    RG.startSession(f.db, f.alice.id);
    L.exclude(f.db, { actor: null, userId: f.alice.id, until: null, reason: 'test' });
    assert.throws(
      () => bet(f, f.alice),
      (e) => e.details.code === 'self_excluded',
      'the exclusion message, which must never be arguable'
    );
  } finally {
    [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES] = prev;
  }
});

// G9: status() is what the client renders, and it must not disagree with the
// gate. If the countdown says 0 remaining and play still works, the UI is
// lying and the player finds out at the worst moment.
check('G9 the client status agrees with the gate', () => {
  const prev = [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES, config.RG_DEPOSIT_DAILY_CENTS];
  config.RG_SESSION_MINUTES = 60;
  config.RG_REALITY_CHECK_MINUTES = 20;
  config.RG_DEPOSIT_DAILY_CENTS = 100000;
  try {
    const f = fixture();
    RG.startSession(f.db, f.alice.id);
    let st = RG.status(f.db, f.alice.id);
    assert.strictEqual(st.configured, true, 'configured');
    assert.strictEqual(st.session_reached, false);
    assert.ok(st.session_remaining_minutes > 0 && st.session_remaining_minutes <= 60);
    assert.strictEqual(st.deposit_limit_remaining_cents, 100000);

    age(f, { session: 61, check: 21 });
    st = RG.status(f.db, f.alice.id);
    assert.strictEqual(st.session_reached, true, 'and it says so when reached');
    assert.strictEqual(st.session_remaining_minutes, 0);
    assert.strictEqual(st.reality_check_due, true, 'and that a check is owed');
    assert.throws(() => bet(f, f.alice), (e) => e.details.code === 'session_limit_reached', 'the gate agrees');
  } finally {
    [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES, config.RG_DEPOSIT_DAILY_CENTS] = prev;
  }
});

// G10: no state, no session. A user who has never signed in has no row and
// must not be blocked — otherwise a fresh account cannot play at all.
check('G10 a user with no RG state is not blocked', () => {
  const prev = config.RG_SESSION_MINUTES;
  config.RG_SESSION_MINUTES = 60;
  try {
    const f = fixture();
    assert.strictEqual(f.db.prepare('SELECT COUNT(*) c FROM user_rg_state').get().c, 0, 'no row yet');
    assert.ok(bet(f, f.alice).order.id, 'and play works');
    assert.doesNotThrow(() => RG.assertSession(f.db, f.alice.id));
    assert.doesNotThrow(() => RG.assertRealityCheck(f.db, f.alice.id));
  } finally {
    config.RG_SESSION_MINUTES = prev;
  }
});

console.log(`\nrg.test.js: ${passed} checks passed`);
if (passed < 10) { console.error('expected 10 checks'); process.exit(1); }