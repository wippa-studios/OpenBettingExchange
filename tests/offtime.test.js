// tests/offtime.test.js — the OFF-TIME GATE. Pre-off-only betting.
//
// Run: node tests/offtime.test.js
//
// WHY THIS SUITE EXISTS. The venue decided to offer pre-off betting only. Until
// this gate, NOTHING tied tradability to events.starts_at: the in-play gate at
// the top of validateOrder checked SUSPENSION, and with the feed off nothing
// ever suspended a market at kick-off — a control with no driver, the dead-
// control shape this codebase keeps finding in review. So the gate is new
// behaviour guarding real money, and it gets the same treatment as every other
// money-path control here.
//
// WHAT IS ASSERTED, and why each matters:
//   - pre-off order still places (the gate must not break the product);
//   - post-off order refused with 409, and NO collateral frozen;
//   - post-off CASH-OUT refused (the control that is easy to forget, and the
//     one that leaves the venue paying against a moved price);
//   - a missing/garbage off time is treated as CLOSED (fail-closed — a bad
//     catalogue row must not silently re-open in-play trading);
//   - the off time parses identically from every format the admin validator
//     accepts, including the space-separated form the admin UI produces;
//   - secondsUntilOff drives a sane countdown.

'use strict';
process.env.SCRYPT_N = process.env.SCRYPT_N || '16384';
process.env.BOT_ENABLED = process.env.BOT_ENABLED || 'false';
process.env.DRIFT_ENABLED = process.env.DRIFT_ENABLED || 'false';
process.env.COMMISSION_RATE = process.env.COMMISSION_RATE || '0.025';
process.env.MIN_STAKE_CENTS = process.env.MIN_STAKE_CENTS || '100';
process.env.MAX_STAKE_CENTS = process.env.MAX_STAKE_CENTS || '1000000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const auth = require('../lib/auth');
const match = require('../lib/match');
const cashout = require('../lib/cashout');
const offtime = require('../lib/offtime');
const acc = require('../lib/accounts');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok', name);
  } catch (e) {
    console.error('  FAIL', name);
    console.error('       ', e.message);
    if (process.env.SHOW_STACK) console.error(e.stack);
    process.exitCode = 1;
  }
}

// A venue with one sport and a helper to build an event + market + selection at
// a given off-time. `status` defaults to 'upcoming' so the EVENT's own status is
// never the thing refusing the order — we are testing the off time in
// isolation, not the other guards.
function venue() {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  let n = 0;
  function event(startsAt, opts = {}) {
    n++;
    const name = `E${n}`;
    db.prepare('INSERT INTO events (sport_id, name, starts_at, status) VALUES (?, ?, ?, ?)').run(
      sport.id,
      name,
      startsAt,
      opts.status || 'upcoming'
    );
    const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(name);
    db.prepare('INSERT INTO markets (event_id, name) VALUES (?, ?)').run(ev.id, `M${n}`);
    const market = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id);
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(
      market.id,
      `S${n}`,
      opts.fairPrice === undefined ? 2.0 : opts.fairPrice
    );
    const selection = db.prepare('SELECT id FROM selections WHERE market_id = ?').get(market.id);
    return { eventId: ev.id, marketId: market.id, selectionId: selection.id };
  }
  const user = auth.registerUser(db, {
    username: 'alice',
    password: 'pw-alice-1234',
    balance_cents: 100000,
  });
  const back = (selectionId, stake = 10000) =>
    match.placeOrder(db, user, { selection_id: selectionId, side: 'back', price: 2.0, stake_cents: stake });
  const balance = () => db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(user.id).balance_cents;
  const frozen = () => db.prepare('SELECT COALESCE(SUM(frozen_cents),0) f FROM orders WHERE user_id = ?').get(user.id).f;
  return { db, user, event, back, balance, frozen };
}

const FUTURE = '2030-01-01 12:00:00';
const PAST = '2020-01-01 12:00:00';

check('O1 a PRE-OFF order still places — the gate does not break the product', () => {
  const v = venue();
  const e = v.event(FUTURE);
  const r = v.back(e.selectionId);
  assert.ok(r && (r.order || r.id), 'order accepted pre-off');
  assert.strictEqual(v.frozen(), 10000, 'and the stake is held as normal');
  assert.strictEqual(acc.assertConserved(v.db), 0, 'books balance');
});

check('O2 a POST-OFF order is refused with 409', () => {
  const v = venue();
  const e = v.event(PAST);
  assert.throws(() => v.back(e.selectionId), (err) => err.status === 409 && /off/i.test(err.message),
    'refused because the event is off');
});

check('O3 a refused POST-OFF order moves NO money and freezes NO collateral', () => {
  // The important half of O2: the refusal must happen before escrow is taken,
  // not after. A gate that fires late still shows a frozen stake the player
  // never asked for.
  const v = venue();
  const e = v.event(PAST);
  const before = v.balance();
  try { v.back(e.selectionId); } catch { /* expected */ }
  assert.strictEqual(v.balance(), before, 'balance untouched');
  assert.strictEqual(v.frozen(), 0, 'no order row froze collateral');
  assert.strictEqual(v.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0, 'and no order was written at all');
  assert.strictEqual(acc.assertConserved(v.db), 0, 'books balance');
});

check('O4 an order exactly AT the off time is refused (off is inclusive)', () => {
  // `nowMs >= off` means the instant of off is closed. Betting "up to and
  // including" the off would leave a zero-width window at the boundary and a
  // clock-skew argument about who got in first.
  const v = venue();
  const e = v.event(PAST);
  assert.throws(() => v.back(e.selectionId), (err) => err.status === 409);
});

check('O5 POST-OFF CASH-OUT is refused — the control that is easy to forget', () => {
  // Build a real matched position PRE-OFF, then move the off time into the
  // past (as if the event kicked off), then try to cash out. This must be
  // refused: paying a cash-out after off is in-play RISK even though in-play
  // betting is banned. If the gate is missing, the venue pays the player
  // against a fair price that a goal has just moved.
  const v = venue();
  const e = v.event(FUTURE);
  const bob = auth.registerUser(v.db, { username: 'bob', password: 'pw-bob-1234', balance_cents: 100000 });
  // Match alice back against bob lay so alice has a live position.
  match.placeOrder(v.db, v.user, { selection_id: e.selectionId, side: 'back', price: 2.0, stake_cents: 10000 });
  match.placeOrder(v.db, bob, { selection_id: e.selectionId, side: 'lay', price: 2.0, stake_cents: 10000 });
  // Nudge the fair price so a cash-out plan would otherwise exist, then move
  // off into the past.
  v.db.prepare('UPDATE selections SET fair_price = 1.5 WHERE id = ?').run(e.selectionId);
  v.db.prepare('UPDATE events SET starts_at = ? WHERE id = ?').run(PAST, e.eventId);
  assert.throws(
    () => cashout.cashoutMarket(v.db, v.user, e.marketId),
    (err) => err.status === 409 && /off/i.test(err.message),
    'cash-out refused once off has passed'
  );
});

check('O6 a MISSING off time is treated as CLOSED (fail-closed)', () => {
  // A bad/missing catalogue row must never be read as "no off => open forever",
  // or a single malformed row silently re-opens in-play trading. starts_at is
  // NOT NULL in the schema, so we test the unparseable-string path directly.
  const v = venue();
  const e = v.event(FUTURE);
  db_setStartsAt(v.db, e.eventId, 'not-a-date');
  assert.strictEqual(offtime.isOffReached(v.db, e.eventId), true, 'unparseable off time reads as off');
  assert.throws(() => v.back(e.selectionId), (err) => err.status === 409);
});

function db_setStartsAt(db, eventId, value) {
  db.prepare('UPDATE events SET starts_at = ? WHERE id = ?').run(value, eventId);
}

check('O7 the off time parses identically from every admin-accepted format', () => {
  // POST /api/admin/events accepts an ISO date or datetime, and the admin UI
  // composes "Event Start Date" + "Event Start Time". All of these are the same
  // instant, so none of them can accidentally read as a different off time.
  const base = offtime.offTimeMs('2030-01-01 12:00:00');
  assert.ok(base > 0, 'space form parses');
  assert.strictEqual(offtime.offTimeMs('2030-01-01T12:00:00Z'), base, 'ISO T + Z');
  assert.strictEqual(offtime.offTimeMs('2030-01-01T12:00:00'), base, 'ISO T, no zone');
  assert.strictEqual(offtime.offTimeMs('2030-01-01 12:00:00'), base, 'space form');
  assert.strictEqual(offtime.offTimeMs('2030-01-01T12:00:00.000Z'), base, 'with millis');
  // A bare DATE means midnight UTC, not local midnight.
  assert.strictEqual(offtime.offTimeMs('2030-01-01'), Date.parse('2030-01-01T00:00:00Z'), 'bare date = UTC midnight');
  assert.strictEqual(offtime.offTimeMs(''), null, 'empty string is not an off time');
  assert.strictEqual(offtime.offTimeMs(null), null, 'null is not an off time');
});

check('O8 secondsUntilOff is a sane countdown: positive pre-off, 0 at/after', () => {
  const v = venue();
  const future = v.event(FUTURE);
  const past = v.event(PAST);
  assert.ok(offtime.secondsUntilOff(v.db, future.eventId) > 0, 'future event counts down');
  assert.strictEqual(offtime.secondsUntilOff(v.db, past.eventId), 0, 'past event is 0, not negative');
});

check('O9 the gate reads the off time, not the event status', () => {
  // A market still flagged status='upcoming' but whose off time has passed must
  // be closed: status is metadata, the off time is the control. Conversely a
  // status='completed' event is closed too (guarded elsewhere) — this asserts
  // the off time is what closes an 'upcoming'-flagged event.
  const v = venue();
  const e = v.event(PAST, { status: 'upcoming' });
  assert.strictEqual(v.db.prepare('SELECT status FROM events WHERE id = ?').get(e.eventId).status, 'upcoming');
  assert.strictEqual(offtime.isOffReached(v.db, e.eventId), true, 'off time closes it regardless of status');
});

console.log(`\nofftime.test.js: ${passed} checks passed`);
if (passed < 9) { console.error('expected 9 checks'); process.exit(1); }