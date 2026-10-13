// risk.test.js — market-maker risk (Phase 2).
// Run: node tests/risk.test.js   (plain assert, no deps)
//
// What is under test is the BOUND, not the profitability. The bots quote a
// no-edge drift price, so their expectancy is negative by construction; these
// tests prove the venue's loss cannot exceed the configured caps. Claiming
// otherwise would be the error this file exists to prevent.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const risk = require('../lib/risk');
const bots = require('../lib/bots');
const config = require('../lib/config');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

const DEFAULTS = { max_liability_cents: 1000000, max_daily_loss_cents: 500000, quote_skew: 0.5 };

async function fixture() {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, 'Ev', datetime('now','+2 hours'))").run(sport.id);
  const ev = db.prepare("SELECT id FROM events WHERE name='Ev'").get();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare("SELECT id FROM markets WHERE event_id=?").get(ev.id);
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Runner', 2.0)").run(mkt.id);
  const sel = db.prepare("SELECT id FROM selections WHERE market_id=?").get(mkt.id);
  await bots.primeBotHash(); // ensureBot() is synchronous and cannot hash for itself
  const bot = bots.ensureBot(db);
  return { db, bot, marketId: mkt.id, selId: sel.id };
}

// Drive the bot's balance directly: this suite tests the RISK MODULE, and
// simulating losses by winning bets would make every example depend on the
// matching engine's rounding. The engine's arithmetic is proven in
// match/settle/ledger suites; here it is a given.
const setBalance = (db, botId, cents) => db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(cents, botId);

// Build live lay liability on the bot: `n` unmatched lay orders of `stake` at
// `price`. Liability is (price-1)*stake each, which is exactly the number the
// cap must see (see lib/risk.js layExposure).
function addLayLiability(db, bot, marketId, selId, { n, stake, price }) {
  for (let i = 0; i < n; i++) {
    require('../lib/match').placeOrder(db, bot, { selection_id: selId, side: 'lay', price, stake_cents: stake });
  }
}

// R1: a bot with NO risk row gets a finite default, never "unlimited". That
// distinction is the entire module — an unconfigured market maker with no cap
// is the unbounded loss it exists to close.
check('R1 missing risk row defaults to finite caps, never unlimited', async () => {
  const { db, bot } = (await fixture());
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM risk_bots').get().c, 0);
  const s = risk.status(db, bot.id, DEFAULTS);
  assert.strictEqual(s.max_liability_cents, 1000000);
  assert.strictEqual(s.max_daily_loss_cents, 500000);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM risk_bots').get().c, 1, 'row created');
});

// R2: healthy desk — no pressure, no skew, quoting allowed. A risk module
// that perturbs a healthy desk is a bug, not caution.
check('R2 a healthy bot has zero pressure and quotes unchanged', async () => {
  const { db, bot } = (await fixture());
  const s = risk.status(db, bot.id, DEFAULTS);
  assert.strictEqual(s.pressure, 0);
  assert.strictEqual(s.quoting_allowed, true);
  assert.strictEqual(risk.skewTicks(db, bot.id, DEFAULTS, 20), 0);
});

// R3: pressure rises CONTINUOUSLY as the cap approaches. This is what makes
// the cap graceful rather than a cliff — the bot is already quoting wide at
// 90%, which slows the bleed before the cap is reached.
check('R3 pressure and skew scale continuously toward the cap', async () => {
  const { db, bot, marketId, selId } = (await fixture());
  addLayLiability(db, bot, marketId, selId, { n: 10, stake: 100000, price: 1.5 }); // 500,000 = 50% of cap
  const half = risk.status(db, bot.id, DEFAULTS);
  assert.ok(Math.abs(half.pressure - 0.5) < 0.01, `pressure ~0.5, got ${half.pressure}`);
  assert.strictEqual(risk.skewTicks(db, bot.id, DEFAULTS, 20), 5, '0.5 * 0.5 * 20 = 5 ticks');

  addLayLiability(db, bot, marketId, selId, { n: 8, stake: 100000, price: 1.5 }); // +400,000 = 900,000 total
  const hi = risk.status(db, bot.id, DEFAULTS);
  assert.ok(Math.abs(hi.pressure - 0.9) < 0.01);
  assert.strictEqual(risk.skewTicks(db, bot.id, DEFAULTS, 20), 9);
});

// R4: the more urgent of the two caps drives pressure. A bot can be fine on
// liability and bleeding on the day, or the reverse.
check('R4 the more urgent of liability and daily-loss caps drives pressure', async () => {
  const { db, bot } = (await fixture());
  // Liability fine (0%), but the day is already at the loss cap.
  const s0 = risk.status(db, bot.id, DEFAULTS);
  const start = s0.day_start_balance;
  setBalance(db, bot.id, start - 250000); // 50% of the 500,000 daily loss cap
  const s = risk.status(db, bot.id, DEFAULTS);
  assert.strictEqual(s.liability_cents, 0, 'not in debt');
  assert.strictEqual(s.daily_pnl_cents, -250000);
  assert.ok(Math.abs(s.pressure - 0.5) < 0.01, 'daily loss drives pressure');
});

// R5: at the hard liability cap the bot STOPS quoting. Liquidity disappearing
// is correct; carrying an unbounded loss is not.
check('R5 hitting the liability cap stops quoting', async () => {
  const { db, bot, marketId, selId } = (await fixture());
  addLayLiability(db, bot, marketId, selId, { n: 20, stake: 100000, price: 1.5 }); // 1,000,000 = the cap
  const s = risk.status(db, bot.id, DEFAULTS);
  assert.strictEqual(s.liability_cents, 1000000);
  assert.strictEqual(s.quoting_allowed, false);
  assert.strictEqual(s.reason, 'liability_cap');
  assert.strictEqual(risk.skewTicks(db, bot.id, DEFAULTS, 20), null, 'null = do not quote');
});

// R6: the daily loss cap also stops quoting, and is independent of liability.
check('R6 hitting the daily loss cap stops quoting', async () => {
  const { db, bot } = (await fixture());
  const start = risk.status(db, bot.id, DEFAULTS).day_start_balance;
  setBalance(db, bot.id, start - 500000);
  const s = risk.status(db, bot.id, DEFAULTS);
  assert.strictEqual(s.quoting_allowed, false);
  assert.strictEqual(s.reason, 'daily_loss_cap');
});

// R7: the cap is a BOUND on the day's loss. Just past it, quoting stops, and
// the balance cannot go further down on the venue's own initiative.
check('R7 the cap bounds the day: past the cap nothing more is risked', async () => {
  const { db, bot, marketId } = (await fixture());
  const start = risk.status(db, bot.id, DEFAULTS).day_start_balance;
  setBalance(db, bot.id, start - 500000); // at the daily loss cap
  bots.quoteMarket(db, marketId);
  const openOrders = db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id=? AND status='open'").get(bot.id).c;
  assert.strictEqual(openOrders, 0, 'no fresh quotes at the cap');
});

// R8: the desk kill switch stops quoting everywhere, in one write.
check('R8 desk kill switch stops all quoting', async () => {
  const { db, bot, marketId } = (await fixture());
  const adm = (await A.registerUser(db, { username: 'ops', password: 'pw-ops-123' }));
  assert.strictEqual(risk.killSwitch(db), false);
  bots.quoteMarket(db, marketId);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id=? AND status='open'").get(bot.id).c > 0);

  risk.setKillSwitch(db, { actor: adm, on: true });
  assert.strictEqual(risk.killSwitch(db), true);
  bots.quoteMarket(db, marketId);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id=? AND status='open'").get(bot.id).c, 0,
    'kill switch cancelled and replaced nothing');
});

// R9: the kill switch does NOT silently cancel resting orders. Quotes already
// resting are promises the book has seen; ripping them is a separate,
// deliberate operator action.
check('R9 kill switch alone does not cancel resting quotes', async () => {
  const { db, bot, marketId } = (await fixture());
  const adm = (await A.registerUser(db, { username: 'ops', password: 'pw-ops-123' }));
  bots.quoteMarket(db, marketId);
  const resting = db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id=? AND status='open'").get(bot.id).c;
  assert.ok(resting > 0);
  risk.setKillSwitch(db, { actor: adm, on: true });
  const still = db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id=? AND status='open'").get(bot.id).c;
  assert.strictEqual(still, resting, 'resting quotes untouched by the kill switch');
});

// R10: withdraw is the explicit, separate withdrawal of liquidity.
check('R10 withdraw cancels resting quotes and releases escrow', async () => {
  const { db, bot, marketId } = (await fixture());
  bots.quoteMarket(db, marketId);
  const before = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(frozen_cents),0) f FROM orders WHERE user_id=? AND status='open'").get(bot.id);
  assert.ok(before.c > 0 && before.f > 0);
  const r = bots.withdrawAll(db);
  assert.strictEqual(r.cancelled_orders, before.c);
  assert.strictEqual(r.released_cents, before.f);
  const after = db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id=? AND status='open'").get(bot.id).c;
  assert.strictEqual(after, 0);
});

// R11: the daily baseline rolls with the UTC day. Without this a bot would be
// judged on a stale baseline forever — three quiet days then a loss would
// blow through a "daily" cap in one tick.
check('R11 the daily baseline rolls when the date changes', async () => {
  const { db, bot } = (await fixture());
  const s0 = risk.status(db, bot.id, DEFAULTS);
  assert.ok(s0.day_start_balance !== 0);
  // Backdate the baseline to yesterday; the next read must re-baseline to
  // today's balance, clearing an old loss.
  db.prepare("UPDATE risk_bots SET period_start = date('now','-1 day'), day_start_balance = ? WHERE bot_id = ?")
    .run(s0.day_start_balance - 999999, bot.id);
  setBalance(db, bot.id, 50000000);
  const s = risk.status(db, bot.id, DEFAULTS);
  assert.strictEqual(s.daily_pnl_cents, 0, 're-baselined to today');
  assert.strictEqual(s.quoting_allowed, true);
});

// R12: a rolling baseline cannot be used to reset a loss mid-day. It only
// moves on a date change, so repeated reads within a day are stable.
check('R12 repeated reads within a day do not reset the baseline', async () => {
  const { db, bot } = (await fixture());
  const s0 = risk.status(db, bot.id, DEFAULTS);
  setBalance(db, bot.id, s0.day_start_balance - 400000);
  for (let i = 0; i < 5; i++) assert.strictEqual(risk.status(db, bot.id, DEFAULTS).daily_pnl_cents, -400000);
  assert.strictEqual(risk.status(db, bot.id, DEFAULTS).day_start_balance, s0.day_start_balance);
});

// R13: skew widens BOTH sides away from fair. Widening only one side would
// leave the bot the best counterparty on the other — no mitigation at all.
check('R13 skew widens both sides away from fair', async () => {
  const { db, bot, marketId, selId } = (await fixture());
  const sel = db.prepare('SELECT * FROM selections WHERE id = ?').get(selId);
  const start = risk.status(db, bot.id, DEFAULTS).day_start_balance;
  setBalance(db, bot.id, start - 250000); // 50% of the daily-loss cap -> skew
  bots.quoteMarket(db, marketId);
  const orders = db.prepare("SELECT side, price FROM orders WHERE user_id=? AND status='open'").all(bot.id);
  const lays = orders.filter((o) => o.side === 'lay').map((o) => o.price);
  const backs = orders.filter((o) => o.side === 'back').map((o) => o.price);
  assert.ok(lays.length && backs.length);
  const F = sel.fair_price;
  assert.ok(lays.every((p) => p > F), 'lays stay ABOVE fair (users back into them)');
  assert.ok(backs.every((p) => p < F), 'backs stay BELOW fair (users lay into them)');
  // Under pressure the spread is WIDER than a zero-skew desk's, which quotes
  // k=1 exactly one tick from fair.
  const { nextTick, prevTick } = require('../lib/odds');
  assert.ok(Math.min(...lays) > nextTick(F), 'skew pushed lays further above fair');
  assert.ok(Math.max(...backs) < prevTick(F), 'skew pushed backs further below fair');
});

// R14: configuring caps is audited. These numbers are the bound on venue loss,
// so who set them and to what has to be answerable later.
check('R14 risk configuration and kill switch are audited', async () => {
  const { db, bot } = (await fixture());
  const adm = (await A.registerUser(db, { username: 'ops', password: 'pw-ops-123' }));
  risk.ensureRiskRow(db, bot.id, DEFAULTS);
  risk.configure(db, { actor: adm, botId: bot.id, max_liability_cents: 250000, max_daily_loss_cents: 125000, quote_skew: 0.75 });
  risk.setKillSwitch(db, { actor: adm, on: true });
  const A2 = require('../lib/audit');
  const acts = A2.list(db, { limit: 50 }).map((r) => r.action);
  assert.ok(acts.includes('risk.configured'));
  assert.ok(acts.includes('risk.kill_switch'));
  const cfgRow = A2.list(db, { limit: 50 }).find((r) => r.action === 'risk.configured');
  assert.strictEqual(cfgRow.actor_id, adm.id);
  assert.strictEqual(cfgRow.after.max_liability_cents, 250000);
});

// R15: caps apply to bots ONLY. Letting a human account carry a market-maker
// risk row would mean a player's funds could be frozen by a desk control.
check('R15 risk configuration rejects non-bot accounts', async () => {
  const { db } = (await fixture());
  const human = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123' }));
  assert.throws(() => risk.configure(db, { botId: human.id, max_liability_cents: 1000, max_daily_loss_cents: 1000 }), /bot accounts only/);
});

// R16: nonsense cap values are refused rather than clamped into something
// meaningless. A 0 liability cap would mean "instantly at the limit" — the bot
// never quotes — which is almost certainly not what the operator meant.
check('R16 invalid cap values are refused, not clamped', async () => {
  const { db, bot } = (await fixture());
  risk.ensureRiskRow(db, bot.id, DEFAULTS);
  assert.throws(() => risk.configure(db, { botId: bot.id, max_liability_cents: 0 }), /positive integer/);
  assert.throws(() => risk.configure(db, { botId: bot.id, max_liability_cents: -100 }), /positive integer/);
  assert.throws(() => risk.configure(db, { botId: bot.id, quote_skew: 5 }), /between 0 and 1/);
});

// R17: the desk view exposes every bot's exposure. A venue that cannot see
// its own market-maker loss discovers it by going bankrupt.
check('R17 desk view reports every bot with its exposure', async () => {
  const { db, bot, marketId, selId } = (await fixture());
  addLayLiability(db, bot, marketId, selId, { n: 5, stake: 100000, price: 1.5 }); // 250,000
  const desk = risk.desk(db, DEFAULTS);
  assert.strictEqual(desk.length, 1);
  assert.strictEqual(desk[0].bot_id, bot.id);
  assert.strictEqual(desk[0].liability_cents, 250000);
  assert.ok(desk[0].max_liability_cents > 0);
  assert.strictEqual(typeof desk[0].pressure, 'number');
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
  if (passed < 17) { console.error('expected 17 checks'); process.exit(1); }
  console.log(`\nrisk.test.js: ${passed} checks passed`);
})();
