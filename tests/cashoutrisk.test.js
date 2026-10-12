// cashoutrisk.test.js — bounding the venue's cash-out exposure.
// Run: node tests/cashoutrisk.test.js   (plain assert, no deps)
//
// THE ATTACK THIS PREVENTS. The player chooses WHEN to take a cash-out, so
// they take it precisely when the venue is worst exposed: build a position,
// let the feed revalue it against the venue, cash out the guaranteed payout,
// rebuild, repeat. Each cycle converts a market risk into a certain loss —
// strictly better for the player than holding, and holding is what Phase 2's
// risk model assumes.
//
// THE HISTORY THIS SUITE GUARDS AGAINST. The first version of the risk module
// tracked QUOTES — and the outside audit (F2) found that no production path
// ever recorded one: a quote and its execution are atomic in the same
// request, `takeQuote(db, null)` was an UPDATE against id NULL, and every
// reading was zero forever. The caps existed only in their comments. These
// tests are written against the REAL flow — executed buyouts, recorded inside
// the paying transaction, resolved at settlement — and the ones that matter
// (X9, X1) fail if the recording ever stops happening again.
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
const S = require('../lib/settle');
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
  return { db, alice, bob, marketId: mkt.id, s1, s2: s1 + 1 };
}

const CFG = (over = {}) => ({
  venueMaxOutstandingCents: 100000,
  venueMaxDailyLossCents: 50000,
  ...over,
});

// X1: THE AUDIT'S FINDING, AS A REGRESSION. A real cash-out must leave a
// real row, and the desk must read it. The original bug was not that the caps
// were wrong — it is that nothing ever wrote the data they read, so a venue
// could execute thirty buyouts and the desk would still show zero exposure
// and full headroom.
check('X1 a REAL cash-out is recorded and the desk reads it', () => {
  const f = fixture();
  M.placeOrder(f.db, f.alice, { selection_id: f.s1, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(f.db, f.bob, { selection_id: f.s1, side: 'lay', price: 2.5, stake_cents: 10000 });
  const C = require('../lib/cashout');
  const plan = C.cashoutQuote(f.db, f.alice, f.marketId);
  assert.ok(plan, 'a quote exists for an in-the-money position');
  C.cashoutMarket(f.db, f.alice, f.marketId);

  const rows = f.db.prepare("SELECT * FROM cashout_quotes WHERE status='taken'").all();
  assert.strictEqual(rows.length, 1, 'the executed buyout is on the books');
  assert.strictEqual(rows[0].paid_cents, plan.value_cents, 'paid is the quote');
  assert.strictEqual(rows[0].fair_value_cents, plan.fair_value_cents, 'fair value recorded at execution');
  const ids = JSON.parse(rows[0].house_match_ids);
  assert.ok(Array.isArray(ids) && ids.length > 0, 'with the replacement match ids for settlement');

  const d = CR.desk(f.db, CFG());
  assert.strictEqual(d.open_buyouts, 1, 'the desk sees the open buyout');
  assert.strictEqual(d.taken_today, 1);
  assert.ok(d.outstanding_cents > 0, 'exposure is a real number, not the eternal zero of the old bug');
  assert.strictEqual(d.outlay_today_cents, plan.value_cents, 'outlay is what was paid');
});

// X2: exposure is the fair value of UNRESOLVED buyouts only.
check('X2 exposure counts only unresolved markets', () => {
  const f = fixture();
  M.placeOrder(f.db, f.alice, { selection_id: f.s1, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(f.db, f.bob, { selection_id: f.s1, side: 'lay', price: 2.5, stake_cents: 10000 });
  require('../lib/cashout').cashoutMarket(f.db, f.alice, f.marketId);
  assert.ok(CR.outstandingExposure(f.db) > 0, 'open market → exposure');
  S.settleMarket(f.db, f.marketId, { void: true });
  assert.strictEqual(CR.outstandingExposure(f.db), 0, 'resolved market → released');
  assert.strictEqual(CR.settleBuyouts(f.db, f.marketId, null, true), 0, 'already resolved');
});

// X3: the venue exposure cap stops quoting.
check('X3 the venue exposure cap stops quoting', () => {
  const f = fixture();
  // Exposure is the FAIR VALUE of unresolved buyouts; outlay is what was
  // PAID. To isolate the exposure cap, keep the outlay under the daily cap
  // ($50000) while the fair value sits at the exposure cap ($100000).
  CR.recordBuyout(f.db, { userId: f.alice.id, marketId: f.marketId, fairValueCents: 100000, paidCents: 1000, houseMatchIds: [] });
  const r = CR.refusal(f.db, f.alice.id, CFG());
  assert.ok(r, 'quoting refused');
  assert.strictEqual(r.code, 'venue_exposure_cap');
  assert.strictEqual(r.outstanding_cents, 100000, 'refusal reports the real reading');
});

// X4: a per-user cap, so one player cycling positions cannot consume the
// whole venue budget in a session. The holder is refused; a fresh player is
// not — otherwise the per-user cap would just ration the venue to whoever
// arrived first.
check('X4 a per-user cap stops the HOLDER, not everyone', () => {
  const f = fixture();
  // Five unresolved buyouts at fair value 6000 each: 30000 exposure, well
  // under the venue cap of 100000, over the per-user cap of 25000.
  for (let i = 0; i < 5; i++) {
    CR.recordBuyout(f.db, { userId: f.alice.id, marketId: f.marketId, fairValueCents: 6000, paidCents: 500, houseMatchIds: [] });
  }
  assert.strictEqual(CR.outstandingExposure(f.db), 30000, 'venue total is well under its own cap');
  const r = CR.refusal(f.db, f.alice.id, CFG());
  assert.ok(r, 'the holder is refused');
  assert.strictEqual(r.code, 'user_exposure_cap');
  assert.strictEqual(r.outstanding_cents, 30000, 'the holder carries the exposure');
  assert.strictEqual(r.cap_cents, 25000, 'a quarter of the venue cap');
  assert.strictEqual(CR.refusal(f.db, f.bob.id, CFG()), null, 'a fresh player is not rationed');
});

// X5: the DAILY cap gates on outlay — what has been PAID today — because it
// is known at decision time. Realised loss is backward-looking: by the time
// it is measurable the money is gone.
check('X5 the daily cap gates on outlay paid today', () => {
  const f = fixture();
  CR.recordBuyout(f.db, { userId: f.alice.id, marketId: f.marketId, fairValueCents: 60000, paidCents: 50000, houseMatchIds: [] });
  const r = CR.refusal(f.db, f.bob.id, CFG());
  assert.ok(r, 'refused on outlay, not exposure');
  assert.strictEqual(r.code, 'venue_daily_outlay_cap');
  assert.strictEqual(r.outlay_cents, 50000);
});

// X6-X8: the realised-loss arithmetic. The audit noted the old metric summed
// fair − paid — a MARGIN figure, always positive by construction, and not the
// venue's loss at all. The venue paid the player AND took the position, so
// its loss is paid − pnl(the taken-over legs). These build a real buyout and
// settle it both ways.
function realBuyout(f) {
  // Alice backs 10000 @ 2.5 and is laid by Bob, then cashes out. The venue
  // takes over Alice's back side and pays her the quoted value.
  M.placeOrder(f.db, f.alice, { selection_id: f.s1, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(f.db, f.bob, { selection_id: f.s1, side: 'lay', price: 2.5, stake_cents: 10000 });
  const plan = require('../lib/cashout').cashoutMarket(f.db, f.alice, f.marketId);
  const row = f.db.prepare("SELECT * FROM cashout_quotes WHERE status='taken'").get();
  // The fixture travels with the plan: the checks below need marketId and the
  // selection ids, and the first version returned only {plan, row}, which made
  // every settleMarket call read `undefined` as the winner.
  return { ...f, plan, row };
}

check('X6 settling the WINNING side records the venue profit as a negative loss', () => {
  const f = realBuyout(fixture());
  // The house took over Alice's BACK at 2.5 for stake 10000; her selection
  // wins, so the house receives 15000 for the 9804 it paid (quote ≈ 98% of
  // fair 10000... plan.value). Loss = paid − 15000, negative: a profitable buyout.
  S.settleMarket(f.db, f.marketId, { winner_selection_id: f.s1 });
  const q = f.db.prepare('SELECT * FROM cashout_quotes').get();
  assert.strictEqual(q.settled_at !== null, true, 'resolved at settlement');
  assert.strictEqual(q.proceeds_cents, 15000, 'the house collected the back winnings');
  assert.strictEqual(q.loss_cents, f.plan.value_cents - 15000, 'loss is paid minus what the position returned');
  assert.ok(q.loss_cents < 0, 'a winning takeover PROFITED the venue');
  assert.ok(CR.realisedLossToday(f.db) === 0, 'a profitable buyout is not counted as a loss');
});

check('X7 settling the LOSING side records the full true cost', () => {
  const f = realBuyout(fixture());
  // Alice's selection loses: the house's taken-over back stake is gone, and it
  // ALSO paid her the quote. The true loss is paid + stake — which the old
  // fair−paid metric could never show.
  S.settleMarket(f.db, f.marketId, { winner_selection_id: f.s2 });
  const q = f.db.prepare('SELECT * FROM cashout_quotes').get();
  assert.strictEqual(q.proceeds_cents, -10000, 'the house lost the stake it took over');
  assert.strictEqual(q.loss_cents, f.plan.value_cents + 10000, 'paid AND the lost stake');
  assert.strictEqual(CR.realisedLossToday(f.db), f.plan.value_cents + 10000, 'the desk reads the real loss');
});

check('X8 a VOID market costs the venue the whole payout', () => {
  const f = realBuyout(fixture());
  S.settleMarket(f.db, f.marketId, { void: true });
  const q = f.db.prepare('SELECT * FROM cashout_quotes').get();
  assert.strictEqual(q.proceeds_cents, 0, 'stake returned, nothing won');
  assert.strictEqual(q.loss_cents, f.plan.value_cents, 'the payout is gone: the venue bought a cancelled position');
  assert.strictEqual(CR.outstandingExposure(f.db), 0, 'and the exposure is released');
});

// X9: zero caps mean unlimited, not never-quote — reading zero as a hard stop
// would take the venue offline by misconfiguration.
check('X9 zero caps mean unlimited rather than never-quote', () => {
  const f = fixture();
  CR.recordBuyout(f.db, { userId: f.alice.id, marketId: f.marketId, fairValueCents: 99999, paidCents: 99999, houseMatchIds: [] });
  assert.strictEqual(CR.refusal(f.db, f.alice.id, { venueMaxOutstandingCents: 0, venueMaxDailyLossCents: 0 }), null);
});

// X10: caps of zero report unlimited headroom as null, not a fake number.
check('X10 the desk reports unlimited headroom as null', () => {
  const f = fixture();
  const d = CR.desk(f.db, { venueMaxOutstandingCents: 0, venueMaxDailyLossCents: 0 });
  assert.strictEqual(d.outstanding_headroom_cents, null);
  assert.strictEqual(d.daily_outlay_headroom_cents, null);
  assert.strictEqual(d.quoting_allowed, true);
});

// X11: THE CAP IS ENFORCED IN THE REAL QUOTE PATH. This was the second half
// of the audit's finding: not only did nothing record exposure, the refusal
// gate in computeCashoutPlan read those eternal zeros. Place real orders,
// saturate the budget with a real recorded buyout, and the path must go quiet
// — and must return the moment the cap lifts.
//
// Carol takes the second position, deliberately: if ALICE takes both sides
// her combined position goes underwater and the quote refuses for a DIFFERENT
// (correct) reason, which made this check fail for the wrong cause. Alice's
// position must be untouched by the saturation step so the cap is the only
// variable.
check('X11 the cap is enforced in the real quote path', () => {
  const f = fixture();
  const carol = A.registerUser(f.db, { username: 'carol', password: 'pw-carol-123', balance_cents: 1000000 });
  const C = require('../lib/cashout');
  // Alice's position: a clean in-the-money back, matched by Bob.
  M.placeOrder(f.db, f.alice, { selection_id: f.s1, side: 'back', price: 2.5, stake_cents: 10000 });
  M.placeOrder(f.db, f.bob, { selection_id: f.s1, side: 'lay', price: 2.5, stake_cents: 10000 });
  assert.ok(C.cashoutQuote(f.db, f.alice, f.marketId), 'quoted when healthy');

  // Bob builds a SECOND, larger position against Carol, and cashes THAT out —
  // a real recorded buyout big enough to saturate the venue budget, without
  // touching Alice's position.
  M.placeOrder(f.db, f.bob, { selection_id: f.s2, side: 'back', price: 2.5, stake_cents: 40000 });
  M.placeOrder(f.db, carol, { selection_id: f.s2, side: 'lay', price: 2.5, stake_cents: 40000 });
  C.cashoutMarket(f.db, f.bob, f.marketId);
  assert.ok(CR.outstandingExposure(f.db) > 0, 'the real buyout is on the books');
  assert.ok(CR.outlayToday(f.db) > 0, 'and so is the outlay');

  const prev = config.CASHOUT_MAX_OUTSTANDING_CENTS;
  config.CASHOUT_MAX_OUTSTANDING_CENTS = 1000;
  try {
    assert.strictEqual(C.cashoutQuote(f.db, f.alice, f.marketId), null, 'NO quote once the cap is hit');
  } finally {
    config.CASHOUT_MAX_OUTSTANDING_CENTS = prev;
  }
  assert.ok(C.cashoutQuote(f.db, f.alice, f.marketId), 'and it returns when the cap lifts');
});

console.log(`\ncashoutrisk.test.js: ${passed} checks passed`);
if (passed < 11) { console.error('expected 11 checks'); process.exit(1); }