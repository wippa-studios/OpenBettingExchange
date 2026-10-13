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
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

let n = 0;
async function fixture() {
  // ensureBot() is synchronous (it runs inside transactions in lib/settle.js and
  // lib/cashoutrisk.js) and so cannot derive the house password hash itself.
  // This venue is hand-built rather than seeded, so prime it explicitly.
  await require('../lib/bots').primeBotHash();
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
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 }));
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
check('G1 unconfigured RG controls change nothing', async () => {
  const prev = [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES, config.RG_DEPOSIT_DAILY_CENTS];
  config.RG_SESSION_MINUTES = 0;
  config.RG_REALITY_CHECK_MINUTES = 0;
  config.RG_DEPOSIT_DAILY_CENTS = 0;
  try {
    assert.strictEqual(RG.configured(), false, 'reported as unconfigured');
    const f = (await fixture());
    assert.ok(bet(f, f.alice).order.id, 'play is unaffected');
    ledger.deposit(f.db, f.alice.id, 500000, config.FAUCET_MAX_CENTS);
    assert.strictEqual(bal(f, 'alice').b, 100000 + 500000, 'deposits are unaffected');
  } finally {
    [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES, config.RG_DEPOSIT_DAILY_CENTS] = prev;
  }
});

// G2: THE SESSION LIMIT. Age the session past the configured limit and play
// stops — at the engine, not in the UI.
check('G2 a session limit stops play at the limit', async () => {
  const prev = config.RG_SESSION_MINUTES;
  config.RG_SESSION_MINUTES = 60;
  try {
    const f = (await fixture());
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

// G3: THE SESSION CLOCK SURVIVES LOGOUT, and only an IDLE GAP resets it.
//
// This check used to assert that signing out and back in gave a fresh session —
// which was the vulnerability, not the control. A session limit defeated by
// signing out is not a limit, and because the clock was per-USER, one logout
// cleared it for every OTHER live session too, with no re-login at all.
//
// The reset condition is now IDLE, measured from last_active_at (stamped by
// requireAuth on real use), so signing out cannot start a new session while
// walking away and coming back does.
check('G3 the session clock survives logout and resets only after an idle gap', async () => {
  const prev = [config.RG_SESSION_MINUTES, config.RG_SESSION_IDLE_RESET_MINUTES];
  config.RG_SESSION_MINUTES = 60;
  config.RG_SESSION_IDLE_RESET_MINUTES = 15;
  try {
    const f = (await fixture());
    RG.startSession(f.db, f.alice.id);
    age(f, { session: 61 });
    const first = RG.stateOf(f.db, f.alice.id).session_started_at;

    // A second sign-in (what a refresh looks like) does not touch the clock.
    RG.startSession(f.db, f.alice.id);
    assert.strictEqual(RG.stateOf(f.db, f.alice.id).session_started_at, first, 'the clock is unchanged by signing in');

    // Signing OUT does not clear it either — this is the fix.
    RG.endSession(f.db, f.alice.id);
    assert.strictEqual(
      RG.stateOf(f.db, f.alice.id).session_started_at,
      first,
      'signing out does NOT reset the clock'
    );
    RG.startSession(f.db, f.alice.id);
    assert.strictEqual(RG.stateOf(f.db, f.alice.id).session_started_at, first, 'and signing straight back in does not either');
    assert.throws(() => bet(f, f.alice), (e) => e.details.code === 'session_limit_reached', 'still limited');

    // Real activity does not reset it either — that is the point of touching
    // last_active_at rather than clearing session_started_at.
    RG.touch(f.db, f.alice.id);
    RG.startSession(f.db, f.alice.id);
    assert.strictEqual(RG.stateOf(f.db, f.alice.id).session_started_at, first, 'activity keeps the clock');

    // A genuine idle gap DOES start a fresh session: a player who finished for
    // the day must be able to come back, or the limit only ratchets upward.
    f.db.prepare("UPDATE user_rg_state SET last_active_at = datetime('now','-30 minutes') WHERE user_id = ?").run(f.alice.id);
    const r = RG.startSession(f.db, f.alice.id);
    assert.notStrictEqual(r.session_started_at, first, 'a 30-minute idle gap starts a new session');
    assert.ok(r.reset_after_idle_minutes >= 15, 'and says why');
    assert.ok(bet(f, f.alice).order.id, 'so the player can play again');
  } finally {
    [config.RG_SESSION_MINUTES, config.RG_SESSION_IDLE_RESET_MINUTES] = prev;
  }
});

// G3b: ONE logout must not clear another session's clock. Because the clock is
// per-user, a per-session reset is the only way to be sure — and it is exactly
// what the old `endSession` did, from any session.
check('G3b a logout cannot clear a clock another session is still playing', async () => {
  const prev = [config.RG_SESSION_MINUTES, config.RG_SESSION_IDLE_RESET_MINUTES];
  config.RG_SESSION_MINUTES = 60;
  config.RG_SESSION_IDLE_RESET_MINUTES = 15;
  try {
    const f = (await fixture());
    RG.startSession(f.db, f.alice.id);
    age(f, { session: 61 });
    const before = RG.stateOf(f.db, f.alice.id).session_started_at;
    // A "second browser" logs out. Nothing about that should touch the clock.
    RG.endSession(f.db, f.alice.id);
    assert.strictEqual(RG.stateOf(f.db, f.alice.id).session_started_at, before, 'the clock survives');
    assert.throws(() => bet(f, f.alice), (e) => e.details.code === 'session_limit_reached', 'and still bites');
    // Only an explicit hard reset clears it, and no player route offers one.
    RG.endSession(f.db, f.alice.id, { hardReset: true });
    assert.strictEqual(RG.stateOf(f.db, f.alice.id).session_started_at, null, 'a hard reset does clear it');
  } finally {
    [config.RG_SESSION_MINUTES, config.RG_SESSION_IDLE_RESET_MINUTES] = prev;
  }
});

// G4: THE REALITY CHECK. The ENGINE decides one is due, and only the
// acknowledgement clears it. A check the player can skip by not clicking is
// not a check.
check('G4 a due reality check blocks play until acknowledged', async () => {
  const prev = config.RG_REALITY_CHECK_MINUTES;
  config.RG_REALITY_CHECK_MINUTES = 20;
  try {
    const f = (await fixture());
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
check('G5 a reality check records the player own net position', async () => {
  const prev = config.RG_REALITY_CHECK_MINUTES;
  config.RG_REALITY_CHECK_MINUTES = 20;
  try {
    const f = (await fixture());
    RG.startSession(f.db, f.alice.id);
    // Give alice a settled win so there is a real net to report. bob LAYS:
    // two backs would never match and she would have nothing settled.
    bet(f, f.alice, 2.0, 1000);
    lay(f, f.bob, 2.0, 1000);
    require('../lib/settle').settleMarket(f.db, f.marketId, { winner_selection_id: f.s1 });
    // The check must be DUE before it can be acknowledged — the endpoint now
    // refuses a premature one (which used to be a free reset of the clock).
    assert.throws(
      () => RG.acknowledgeRealityCheck(f.db, f.alice.id),
      (e) => e.status === 409 && e.details.code === 'reality_check_not_due',
      'acknowledging a check that is not due is refused'
    );
    age(f, { check: 21 });
    assert.strictEqual(RG.realityCheckDue(f.db, f.alice.id).due, true, 'now it is due');
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
check('G6 the deposit limit applies to both deposit paths', async () => {
  const prev = config.RG_DEPOSIT_DAILY_CENTS;
  config.RG_DEPOSIT_DAILY_CENTS = 100000;
  try {
    const f = (await fixture());
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
check('G7 the deposit window is rolling, not a calendar day', async () => {
  const prev = config.RG_DEPOSIT_DAILY_CENTS;
  config.RG_DEPOSIT_DAILY_CENTS = 100000;
  try {
    const f = (await fixture());
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
check('G8 exclusion still outranks the RG controls', async () => {
  const prev = [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES];
  config.RG_SESSION_MINUTES = 60;
  config.RG_REALITY_CHECK_MINUTES = 20;
  try {
    const f = (await fixture());
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
check('G9 the client status agrees with the gate', async () => {
  const prev = [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES, config.RG_DEPOSIT_DAILY_CENTS];
  config.RG_SESSION_MINUTES = 60;
  config.RG_REALITY_CHECK_MINUTES = 20;
  config.RG_DEPOSIT_DAILY_CENTS = 100000;
  try {
    const f = (await fixture());
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
check('G10 a user with no RG state is not blocked', async () => {
  const prev = config.RG_SESSION_MINUTES;
  config.RG_SESSION_MINUTES = 60;
  try {
    const f = (await fixture());
    assert.strictEqual(f.db.prepare('SELECT COUNT(*) c FROM user_rg_state').get().c, 0, 'no row yet');
    assert.ok(bet(f, f.alice).order.id, 'and play works');
    assert.doesNotThrow(() => RG.assertSession(f.db, f.alice.id));
    assert.doesNotThrow(() => RG.assertRealityCheck(f.db, f.alice.id));
  } finally {
    config.RG_SESSION_MINUTES = prev;
  }
});

// ── The seven findings from the outside review, as regressions ──────────────
// Each of these was an EXECUTED exploit, not a theory. They are collected here
// because every one is the same failure mode: a control enforced on one path,
// at the wrong moment, or not at all. That is the sixth and seventh time this
// codebase has produced one.

// G11: CASH-OUT TOOK NO GATE AT ALL. assertTradeable was called from exactly
// one place in the codebase — order placement — so a permanently self-excluded
// account was refused on POST /api/orders and then walked out through
// POST /api/markets/:id/cashout with the venue's money.
check('G11 cash-out is gated exactly like placing a bet', async () => {
  const C = require('../lib/cashout');
  const prev = [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES];
  config.RG_SESSION_MINUTES = 60;
  config.RG_REALITY_CHECK_MINUTES = 20;
  try {
    // A real position to cash out, or the gate is never reached.
    const f = (await fixture());
    bet(f, f.alice);
    M.placeOrder(f.db, f.bob, { selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 1000 });
    // The position must be worth MORE than its stake, or the plan is refused as
    // underwater and the gate is never reached — which would make this check
    // pass for the wrong reason. payoutsFor NETS both outcomes (+10000 if her
    // selection wins, -10000 if it loses), so the fair price has to move in her
    // FAVOUR: below her 2.0 bet, not above it. Moving it up makes her position
    // underwater and the quote is correctly declined.
    f.db.prepare('UPDATE selections SET fair_price = 1.5 WHERE id = ?').run(f.s1);
    assert.ok(C.cashoutMarket(f.db, f.alice, f.marketId), 'a healthy player can cash out');

    // Self-excluded: the gate must refuse, in the ENGINE.
    const g = (await fixture());
    bet(g, g.alice);
    M.placeOrder(g.db, g.bob, { selection_id: g.s1, side: 'lay', price: 2.0, stake_cents: 1000 });
    g.db.prepare('UPDATE selections SET fair_price = 1.5 WHERE id = ?').run(g.s1);
    const before = g.db.prepare('SELECT balance_cents b FROM users WHERE username=?').get('alice').b;
    L.exclude(g.db, { actor: null, userId: g.alice.id, until: null, reason: 'test' });
    assert.throws(
      () => C.cashoutMarket(g.db, g.alice, g.marketId),
      (e) => e.status === 403 && e.details.code === 'self_excluded',
      'a SELF-EXCLUDED account cannot cash out'
    );
    assert.strictEqual(
      g.db.prepare('SELECT balance_cents b FROM users WHERE username=?').get('alice').b,
      before,
      'and no money moved'
    );

    // Past the session limit, and with a reality check owed: also refused.
    for (const [label, ages] of [['session limit', { session: 61 }], ['reality check', { check: 21 }]]) {
      const h = (await fixture());
      bet(h, h.alice);
      M.placeOrder(h.db, h.bob, { selection_id: h.s1, side: 'lay', price: 2.0, stake_cents: 1000 });
      h.db.prepare('UPDATE selections SET fair_price = 1.5 WHERE id = ?').run(h.s1);
      RG.startSession(h.db, h.alice.id);
      age(h, ages);
      assert.throws(() => C.cashoutMarket(h.db, h.alice, h.marketId), (e) => e.status === 403, `refused on the ${label}`);
    }
  } finally {
    [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES] = prev;
  }
});

// G12: A REALITY CHECK CANNOT BE ACKNOWLEDGED EARLY. The endpoint used to stamp
// the clock unconditionally, so calling it whenever the player liked kept the
// countdown permanently fresh: the gate never fired and no summary was ever
// shown. Twenty parallel calls all returned 200.
check('G12 acknowledging a check that is not due is refused', async () => {
  const prev = config.RG_REALITY_CHECK_MINUTES;
  config.RG_REALITY_CHECK_MINUTES = 20;
  try {
    const f = (await fixture());
    // The clock only starts when the player actually plays: a REFUSED
    // acknowledgement rolls back the row it would have created, so a refused
    // call on a virgin account leaves no trace at all — which is correct, and
    // also why this test has to establish the clock the real way first.
    bet(f, f.alice);
    assert.ok(RG.stateOf(f.db, f.alice.id), 'playing establishes the clock');
    // Not due at all.
    assert.throws(
      () => RG.acknowledgeRealityCheck(f.db, f.alice.id),
      (e) => e.status === 409 && e.details.code === 'reality_check_not_due',
      'refused when not due'
    );
    // One minute short of due: still refused, and the countdown is untouched.
    age(f, { check: 19 });
    assert.throws(() => RG.acknowledgeRealityCheck(f.db, f.alice.id), (e) => e.status === 409, 'refused just before due');
    const stillDueIn = RG.realityCheckDue(f.db, f.alice.id).due_in_minutes;
    assert.strictEqual(stillDueIn, 1, 'the countdown was NOT reset by the refused calls');
    // Due: now it works, and only then.
    age(f, { check: 21 });
    assert.ok(RG.acknowledgeRealityCheck(f.db, f.alice.id).acknowledged_at, 'accepted when genuinely due');
    assert.strictEqual(RG.realityCheckDue(f.db, f.alice.id).due, false, 'and the clock resets');
  } finally {
    config.RG_REALITY_CHECK_MINUTES = prev;
  }
});

// G13: EXCLUSION OUTRANKS THE SESSION LIMIT, so the message an excluded player
// sees is never "sign out and come back in". A permanently excluded account was
// being told its session limit had been reached — advice that leads straight
// back in, on an account that can never come back in.
check('G13 self-exclusion is reported ahead of any session-limit message', async () => {
  const prev = [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES];
  config.RG_SESSION_MINUTES = 60;
  config.RG_REALITY_CHECK_MINUTES = 20;
  try {
    const f = (await fixture());
    RG.startSession(f.db, f.alice.id);
    // BOTH conditions breached, plus a cancelled resting order from exclusion.
    L.exclude(f.db, { actor: null, userId: f.alice.id, until: null, reason: 'test' });
    age(f, { session: 61, check: 21 });
    assert.throws(
      () => bet(f, f.alice),
      (e) => e.details.code === 'self_excluded',
      'the EXCLUSION is the answer, not the session limit'
    );
    assert.throws(
      () => bet(f, f.alice),
      (e) => !/sign out/i.test(e.message),
      'and the message never tells an excluded player to sign out'
    );
  } finally {
    [config.RG_SESSION_MINUTES, config.RG_REALITY_CHECK_MINUTES] = prev;
  }
});

// G14: THE DEPOSIT LIMIT MUST BE ENFORCED WHERE THE MONEY LANDS. It was checked
// when the intent was CREATED, which moves no money — so N intents each passed a
// check that consumed nothing, and every one of them was credited. Measured: a
// $1,000 limit and $6,000 deposited, stopped only by an unrelated venue cap.
check('G14 the deposit limit is enforced at credit, not at intent creation', async () => {
  const prev = config.RG_DEPOSIT_DAILY_CENTS;
  config.RG_DEPOSIT_DAILY_CENTS = 100000; // $1,000
  try {
    const f = (await fixture());
    const PAY = require('../lib/payments');
    // Open MANY intents, each individually under the cap. This is what defeated
    // the control: creating an intent costs nothing, so any number of them can
    // be opened. Inserted directly because openDeposit is async and this suite's
    // harness is synchronous — and because the row is all the webhook path ever
    // looks at.
    const intents = [];
    for (let i = 0; i < 6; i++) {
      const r = f.db
        .prepare("INSERT INTO payment_intents (user_id, provider, kind, amount_cents) VALUES (?, 'test', 'deposit', 100000)")
        .run(f.alice.id);
      intents.push({ id: Number(r.lastInsertRowid) });
    }
    assert.strictEqual(intents.length, 6, 'six intents, each the full cap');
    assert.strictEqual(RG.depositedInWindow(f.db, f.alice.id), 0, 'nothing deposited yet');

    // Confirm them one by one. The FIRST five are within the rolling limit; the
    // sixth must be refused AT THE POINT OF CREDITING.
    let credited = 0;
    let refused = 0;
    for (const intent of intents) {
      try {
        PAY.confirmDeposit(f.db, intent.id, { settled: true });
        credited++;
      } catch (e) {
        if (e.status === 403 && e.details && e.details.code === 'deposit_limit_reached') refused++;
        else throw e;
      }
    }
    assert.strictEqual(credited, 1, 'only ONE deposit is credited');
    assert.strictEqual(refused, 5, 'the rest are refused at credit');
    assert.strictEqual(RG.depositedInWindow(f.db, f.alice.id), 100000, 'the window holds exactly the cap');
    assert.strictEqual(
      f.db.prepare('SELECT balance_cents b FROM users WHERE username=?').get('alice').b,
      100000 + 100000,
      'the player received exactly one capped deposit'
    );
  } finally {
    config.RG_DEPOSIT_DAILY_CENTS = prev;
  }
});

// ── #31: self-exclusion FAILED OPEN on a non-ISO end date ──────────────────
//
// exclude() validated with Date.parse, which accepts anything V8 can make
// sense of — including "15 Jan 2030". That value then passed through
// `.replace('T', ' ').slice(0, 19)` UNCHANGED and landed in a column compared
// LEXICOGRAPHICALLY against 'YYYY-MM-DD HH:MM:SS'. "15 Jan 2030" sorts before
// "2026-…" because '1' precedes '2', so exclusionOf() returned null — not
// excluded — the instant the exclusion was recorded.
//
// The control failed open on its own happy path. A player asking to be
// excluded was re-admitted immediately, and nothing anywhere reported it.
check('G15 a non-ISO exclusion end date is refused, not silently lapsed', async () => {
  const f = (await fixture());
  // The exact input that failed open.
  assert.throws(
    () => L.exclude(f.db, { actor: null, userId: f.alice.id, until: '15 Jan 2030', reason: 'test' }),
    (e) => e.status === 400,
    '"15 Jan 2030" is refused outright'
  );
  // …and nothing was written, so the account was never excluded at all.
  assert.strictEqual(
    f.db.prepare('SELECT self_excluded FROM users WHERE id = ?').get(f.alice.id).self_excluded,
    0,
    'and no half-made exclusion is left behind'
  );

  // Other shapes Date.parse would happily swallow.
  for (const bad of ['', 'garbage', '2030-02-31', '2030-13-01', '2030-01-15T25:00', '01/15/2030']) {
    assert.throws(
      () => L.exclude(f.db, { actor: null, userId: f.alice.id, until: bad, reason: 'test' }),
      (e) => e.status === 400,
      `${JSON.stringify(bad)} is refused`
    );
  }
});

// ── #31: and a FUTURE ISO end date is honoured, end to end ─────────────────
check('G16 a timed exclusion is stored in UTC and blocks trading until it lapses', async () => {
  const f = (await fixture());
  const far = '2099-01-15T00:00:00+05:00'; // midnight local, i.e. 19:00 UTC on the 14th
  L.exclude(f.db, { actor: null, userId: f.alice.id, until: far, reason: 'test' });

  // Stored as the UTC INSTANT, not as the wall-clock digits with the offset
  // stripped — which is what the old code did, ending the exclusion five hours
  // early.
  assert.strictEqual(
    f.db.prepare('SELECT excluded_until FROM users WHERE id = ?').get(f.alice.id).excluded_until,
    '2099-01-14 19:00:00',
    'stored as UTC, offset applied'
  );
  assert.ok(L.exclusionOf(f.db, f.alice.id), 'and it is in force');
  assert.throws(
    () => bet(f, f.alice),
    (e) => e.details.code === 'self_excluded',
    'so the account cannot trade'
  );

  // A date in the past is accepted as a date but has already lapsed.
  L.exclude(f.db, { actor: null, userId: f.alice.id, until: '2000-01-01T00:00:00Z', reason: 'test' });
  assert.strictEqual(L.exclusionOf(f.db, f.alice.id), null, 'a lapsed exclusion reads as none');
});

// ── #31: a MALFORMED stored value must fail CLOSED ─────────────────────────
// Validation at write time stops new rows, but a database written before this
// fix — or edited by hand — can still hold a value in the old shape. Silently
// re-admitting a player who asked to stop is the one failure this control
// must never have, so an unrecognised value keeps the exclusion in force.
check('G17 an unrecognised stored end date keeps the exclusion in force', async () => {
  const f = (await fixture());
  L.exclude(f.db, { actor: null, userId: f.alice.id, until: '2099-01-01T00:00:00Z', reason: 'test' });

  // Exactly what the old code would have stored for "15 Jan 2030".
  f.db.prepare('UPDATE users SET excluded_until = ? WHERE id = ?').run('15 Jan 2030', f.alice.id);
  assert.strictEqual(
    L.exclusionOf(f.db, f.alice.id),
    'permanent',
    'a malformed end date does NOT lapse the exclusion'
  );
  assert.throws(
    () => bet(f, f.alice),
    (e) => e.details.code === 'self_excluded',
    'and the account still cannot trade'
  );
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
  if (passed < 18) { console.error('expected 18 checks'); process.exit(1); }
  console.log(`\nrg.test.js: ${passed} checks passed`);
})();
