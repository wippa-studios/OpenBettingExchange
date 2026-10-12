// cashoutrisk.test.js — bounding the venue's cash-out exposure.
// Run: node tests/cashoutrisk.test.js   (plain assert, no deps)
//
// THE ATTACK THIS PREVENTS. The player chooses WHEN to take a cash-out, so
// they will take it precisely when the venue is worst exposed: build a
// position, let the feed revalue it against the venue, cash out a guaranteed
// payout, rebuild. Each cycle converts a market risk into a certain loss —
// which is strictly better for the player than holding, and holding is what
// the Phase 2 risk model assumes.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.CASHOUT_MARGIN_BPS = '200';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const CR = require('../lib/cashoutrisk');
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
  for (const nm of ['Alpha', 'Beta']) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, nm);
  }
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, 'Alpha').id;
  const alice = A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 1000000 });
  const bob = A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 1000000 });
  return { db, alice, bob, marketId: mkt.id, s1 };
}

const CFG = (over = {}) => ({
  venueMaxOutstandingCents: 100000,
  venueMaxDailyLossCents: 50000,
  ...over,
});

// X1: a healthy venue quotes freely.
check('X1 a healthy venue has no exposure and is permitted to quote', () => {
  const f = fixture();
  assert.strictEqual(CR.outstandingExposure(f.db), 0);
  assert.strictEqual(CR.refusal(f.db, f.alice.id, CFG()), null);
  const d = CR.desk(f.db, CFG());
  assert.strictEqual(d.quoting_allowed, true);
  assert.strictEqual(d.outstanding_headroom_cents, 100000);
});

// X2: exposure begins at the QUOTE, not at execution. If a player holds an
// unexercised quote the liability exists whether or not it is taken — that is
// what makes the cap meaningful rather than decorative.
check('X2 exposure begins at the quote, not at execution', () => {
  const f = fixture();
  CR.recordQuote(f.db, { userId: f.alice.id, marketId: f.marketId, fairValueCents: 5000, quotedCents: 4900 });
  assert.strictEqual(CR.outstandingExposure(f.db), 4900, 'an unexercised quote is exposure');
  CR.takeQuote(f.db, 1);
  assert.strictEqual(CR.outstandingExposure(f.db), 0, 'exercised, so no longer outstanding');
});

// X3: THE VENUE CAP. Once outstanding exposure reaches the cap, quoting stops.
check('X3 the venue exposure cap stops quoting', () => {
  const f = fixture();
  CR.recordQuote(f.db, { userId: f.alice.id, marketId: f.marketId, fairValueCents: 60000, quotedCents: 100000 });
  assert.strictEqual(CR.outstandingExposure(f.db), 100000);
  const r = CR.refusal(f.db, f.alice.id, CFG());
  assert.ok(r, 'quoting refused');
  assert.strictEqual(r.code, 'venue_exposure_cap');
  assert.strictEqual(r.cap_cents, 100000);
  assert.strictEqual(r.outstanding_cents, 100000);
});

// X4: a PER-USER cap, so one player cycling positions cannot consume the whole
// venue budget in a session.
check('X4 a per-user cap stops one player taking the whole venue budget', () => {
  const f = fixture();
  // Per-user cap is a quarter of the venue cap (25000). The player WHO HOLDS
  // the exposure is refused — a fresh player must still be able to quote, or
  // the per-user cap would simply ration the venue to whoever arrived first.
  for (let i = 0; i < 5; i++) {
    CR.recordQuote(f.db, { userId: f.alice.id, marketId: f.marketId, fairValueCents: 6000, quotedCents: 5000 });
  }
  assert.strictEqual(CR.outstandingExposure(f.db), 25000, 'venue total is well under its own cap');
  const r = CR.refusal(f.db, f.alice.id, CFG());
  assert.ok(r, 'the holder is refused');
  assert.strictEqual(r.code, 'user_exposure_cap');
  assert.strictEqual(r.cap_cents, 25000);
  // A fresh player is unaffected.
  assert.strictEqual(CR.refusal(f.db, f.bob.id, CFG()), null, 'a fresh player is not rationed');
});

// X5: the DAILY LOSS cap. Realised shortfall is fixed at execution, not
// recomputed later — otherwise moving a fair price could rewrite history.
check('X5 the daily loss cap stops quoting once the shortfall is reached', () => {
  const f = fixture();
  CR.recordQuote(f.db, { userId: f.alice.id, marketId: f.marketId, fairValueCents: 60000, quotedCents: 10000 });
  CR.takeQuote(f.db, 1); // shortfall 50000 == the daily cap
  assert.strictEqual(CR.realisedLossToday(f.db), 50000);
  const r = CR.refusal(f.db, f.alice.id, CFG());
  assert.ok(r);
  assert.strictEqual(r.code, 'venue_daily_loss_cap');
});

// X6: a stale quote RELEASES its exposure. Without expiry an abandoned quote
// would pin the venue's entire budget forever and the venue would be unable to
// quote to anyone.
check('X6 expired quotes release the venue exposure', () => {
  const f = fixture();
  CR.recordQuote(f.db, { userId: f.alice.id, marketId: f.marketId, fairValueCents: 60000, quotedCents: 100000 });
  assert.strictEqual(CR.outstandingExposure(f.db), 100000);
  assert.ok(CR.refusal(f.db, f.alice.id, CFG()), 'at the cap');
  // Age it past its expiry.
  f.db.prepare("UPDATE cashout_quotes SET expires_at = datetime('now','-1 hour')").run();
  const n = CR.expireStaleQuotes(f.db);
  assert.strictEqual(n, 1);
  assert.strictEqual(CR.outstandingExposure(f.db), 0, 'exposure released');
  assert.strictEqual(CR.refusal(f.db, f.alice.id, CFG()), null, 'and quoting resumes');
});

// X7: the cap is wired into the QUOTE path, not merely available. A risk module
// nothing calls is the exact failure Phase 2 was written to avoid.
check('X7 the cap is enforced in the cash-out quote path', () => {
  const f = fixture();
  const C = require('../lib/cashout');
  // An in-the-money position, so the quote exists when the cap is not reached.
  M.placeOrder(f.db, f.alice, { selection_id: f.s1, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(f.db, f.bob, { selection_id: f.s1, side: 'lay', price: 2.5, stake_cents: 10000 });
  assert.ok(C.cashoutQuote(f.db, f.alice, f.marketId), 'quoted when healthy');

  // Saturate the venue budget with a real outstanding quote, then drop the cap
  // below it. (Setting the cap to 1 was the first attempt and does nothing:
  // the check is `outstanding >= cap`, and 0 >= 1 is false.)
  CR.recordQuote(f.db, { userId: f.bob.id, marketId: f.marketId, fairValueCents: 6000, quotedCents: 5000 });
  const prev = config.CASHOUT_MAX_OUTSTANDING_CENTS;
  config.CASHOUT_MAX_OUTSTANDING_CENTS = 1000;
  try {
    assert.strictEqual(C.cashoutQuote(f.db, f.alice, f.marketId), null, 'NO quote once the cap is hit');
  } finally {
    config.CASHOUT_MAX_OUTSTANDING_CENTS = prev;
  }
  assert.ok(C.cashoutQuote(f.db, f.alice, f.marketId), 'and it returns when the cap lifts');
});

// X8: caps of ZERO mean UNLIMITED, not "never quote". Reading a zero cap as a
// hard stop would take the venue offline by misconfiguration.
check('X8 a zero cap means unlimited rather than never-quote', () => {
  const f = fixture();
  CR.recordQuote(f.db, { userId: f.alice.id, marketId: f.marketId, fairValueCents: 99999, quotedCents: 99999 });
  const r = CR.refusal(f.db, f.alice.id, { venueMaxOutstandingCents: 0, venueMaxDailyLossCents: 0 });
  assert.strictEqual(r, null, 'zero is disabled, not zero exposure');
});

console.log(`\ncashoutrisk.test.js: ${passed} checks passed`);
if (passed < 8) { console.error('expected 8 checks'); process.exit(1); }