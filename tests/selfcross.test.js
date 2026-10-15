// selfcross.test.js — the one deliberate weakening of the self-match guard (#75).
// Run: node tests/selfcross.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. The self-match guard stopped a user trading against
// themselves: no user may manufacture volume or P&L that no real counterparty
// produced. A user's AUTOMATED order crossing that same user's MANUAL order is
// now permitted, because with the house excluded from filling automated orders
// (#67) and only one real player on the venue, that is the only liquidity there
// is. Every automated order would otherwise rest forever.
//
// That is a real weakening and it is implemented as an explicit exception rather
// than by loosening the comparison, so the file exists to pin the EXACT width of
// what was given up:
//
//   PERMITTED   one side automated, both belong to this user
//   BLOCKED     two manual orders of one user      — unchanged
//   BLOCKED     two automated orders of one user   — still self-matching
//   BLOCKED     different users                    — ordinary crossing
//
// S4 and S5 are as important as S1. A test suite that only proves the new
// behaviour works would pass just as happily against a guard that had been
// deleted outright.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.FAUCET_MAX_CENTS = '100000';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');

let passed = 0;
// Every failure is reported. A harness that exits on the first one hides every
// later check behind it, and the later checks here are the ones that prove the
// exception is NARROW.
const failures = [];
const check = (name, fn) => { failures.push([name, fn]); };

let evCounter = 0;

async function fresh() {
  const db = openStore(':memory:');
  const mk = async (name, bal) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: bal });
  return {
    db,
    users: {
      alice: await mk('alice', 100000),
      bob: await mk('bob', 100000),
    },
  };
}

function mkMarket(db, name) {
  let sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  if (!sport) {
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
    sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  }
  evCounter++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now', '+2 hours'))")
    .run(sport.id, `SelfCross ${evCounter}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`SelfCross ${evCounter}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id);
  db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(mkt.id, name, 2.0);
  const sel = db.prepare('SELECT id FROM selections WHERE market_id = ? AND name = ?').get(mkt.id, name);
  return { selection_id: sel.id, market_id: mkt.id };
}

const orderRow = (db, id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const matchesFor = (db, orderId) =>
  db.prepare(
    'SELECT * FROM matches WHERE back_order_id = ? OR lay_order_id = ?'
  ).all(orderId, orderId);

// Mark an order as placed by automation. #76 owns the rule table, which does not
// exist yet, so the test writes the marker the guard actually reads rather than
// inventing a rule engine to produce it. What is under test here is the GUARD,
// not the rule that would set this column.
function markAutomated(db, orderId, ruleId = 9001) {
  db.prepare('UPDATE orders SET rule_id = ? WHERE id = ?').run(ruleId, orderId);
}

// ── S1 ─ the permitted case ─────────────────────────────────────────────────
check('S1 an automated order crosses the same user\'s manual order, and it is RECORDED', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');

  // Alice's bot backs. Her own manual order then lays against it.
  const bot = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'back', price: 2.0, stake_cents: 1000 }).order;
  markAutomated(db, bot.id);

  const manual = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });

  assert.strictEqual(manual.fills.length, 1, 'the permitted crossing did not happen');
  assert.strictEqual(manual.order.matched_cents, 1000, 'the manual order did not fill');

  // The crossing must be marked, or the weakening is invisible.
  const ms = matchesFor(db, bot.id);
  assert.strictEqual(ms.length, 1, `expected one match row, got ${ms.length}`);
  assert.strictEqual(ms[0].self_crossed, 1,
    'the match row does not record that this fill came from the player\'s OWN liquidity');
});

// ── S2 ─ the guard itself ────────────────────────────────────────────────────
check('S2 two MANUAL orders of one user are still blocked — the guard is intact', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');

  M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'back', price: 2.0, stake_cents: 1000 });
  const manual = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });

  assert.strictEqual(manual.fills.length, 0,
    'two manual orders of the same user matched — the ORIGINAL guard is gone');
  assert.strictEqual(manual.order.matched_cents, 0);
  assert.strictEqual(matchesFor(db, manual.order.id).length, 0, 'a match row was written anyway');
});

// ── S3 / S5 ─ NOT YET DRIVABLE, AND WHY ─────────────────────────────────────
//
// Both of these need an order that is automated **and is the taker**, which
// cannot be built yet. `rule_id` is set by the engine when a rule fires, never
// by the request (#81 requires exactly that), so a test can only mark an order
// AUTOMATED after `placeOrder` returns — by which time it has already matched.
//
// That is the right constraint and these checks do not route around it. A
// client-settable rule_id would make both cases testable and would also make it
// possible for a caller to mark their own order automated, which is the bypass
// this whole feature must not have.
//
// So until #76 exists, the two properties are pinned STRUCTURALLY instead, and
// this is stated plainly rather than dressed up: a source-level check is weaker
// than a behavioural one, and these two become behavioural checks in #76.

const { readFileSync } = require('node:fs');
const matchSrc = readFileSync(require.resolve('../lib/match'), 'utf8');

check('S3 the exception is EXCLUSIVE: two automated orders of one user stay blocked', async () => {
  // Asserted on the source because it cannot yet be driven. An OR would permit
  // two automated orders of one user to match each other — a far larger hole
  // than the one #75 opens, and the reason this line is written as `!==`.
  const guard = matchSrc.match(/if\s*\(!\(takerAutomated\s*!==\s*restingAutomated\)\)\s*continue;/);
  assert.ok(guard, 'the guard no longer uses an EXCLUSIVE comparison — two automated orders of one user would be permitted');
  assert.ok(!/takerAutomated\s*\|\|\s*restingAutomated/.test(matchSrc),
    'the guard uses an INCLUSIVE comparison — a user\'s own rules could match each other');
});

check('S5 the exception applies whichever side is automated (STRUCTURAL until #76)', async () => {
  // The mirror of S1: bot as taker, manual as resting. Not drivable yet for the
  // reason above, and the same exclusive comparison is what makes it symmetric
  // — the condition does not care which side is which.
  assert.ok(/takerAutomated\s*!==\s*restingAutomated/.test(matchSrc),
    'the comparison is not symmetric in form; the mirror direction may not hold');
  // What IS observable today: a third party's order crosses a same-user pair
  // normally, and is NOT marked self-crossed. The marker bridges one user only.
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');
  const bot = M.placeOrder(db, users.bob, { selection_id: mkt.selection_id, side: 'back', price: 2.0, stake_cents: 1000 }).order;
  markAutomated(db, bot.id);
  const alice = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });
  assert.strictEqual(alice.fills.length, 1, 'an ordinary crossing must still work');
  assert.strictEqual(matchesFor(db, bot.id)[0].self_crossed, 0,
    'a fill against a DIFFERENT user was marked self-crossed');
});

// ── S6b ─ the audit record ───────────────────────────────────────────────────
check('S7 a self-crossed fill is in the audit log, naming the rule that caused it', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');

  const bot = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'back', price: 2.0, stake_cents: 1000 }).order;
  markAutomated(db, bot.id, 4242);
  M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });

  const rows = db.prepare("SELECT * FROM audit_log WHERE action = 'trade.self_crossed'").all();
  assert.strictEqual(rows.length, 1, `expected exactly one audit row, got ${rows.length}`);
  assert.strictEqual(rows[0].actor_id, users.alice.id, 'the actor is not the player whose liquidity crossed');
  const after = JSON.parse(rows[0].after || '{}');
  assert.strictEqual(after.rule_id, 4242,
    'the audit row does not name the rule — after that rule is deleted the fill is untraceable');
  assert.strictEqual(after.resting_order_id, bot.id);
});

check('S8 an ORDINARY crossing writes NO self_crossed audit row', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');
  M.placeOrder(db, users.bob, { selection_id: mkt.selection_id, side: 'back', price: 2.0, stake_cents: 1000 });
  M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });
  const n = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'trade.self_crossed'").get().c;
  assert.strictEqual(n, 0, 'an ordinary fill was audited as self-crossed — the log becomes useless');
});

// ── S6 ─ the marker is the whole decision ────────────────────────────────────
check('S6 clearing rule_id restores the original guard exactly', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, 'Home');

  const bot = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'back', price: 2.0, stake_cents: 1000 }).order;
  markAutomated(db, bot.id);
  const manual = M.placeOrder(db, users.alice, { selection_id: mkt.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });
  assert.strictEqual(manual.fills.length, 1, 'S1 must have worked first — this check is meaningless otherwise');

  // A SECOND market, same users, but the resting order is no longer automated.
  const mkt2 = mkMarket(db, 'Away');
  const plain = M.placeOrder(db, users.alice, { selection_id: mkt2.selection_id, side: 'back', price: 2.0, stake_cents: 1000 }).order;
  assert.strictEqual(orderRow(db, plain.id).rule_id, null, 'rule_id must default to NULL = manual');
  const blocked = M.placeOrder(db, users.alice, { selection_id: mkt2.selection_id, side: 'lay', price: 2.0, stake_cents: 1000 });
  assert.strictEqual(blocked.fills.length, 0, 'an order with rule_id NULL must be blocked exactly as before');
});

(async () => {
  for (const [name, fn] of failures) {
    try {
      await fn();
      passed++;
      console.log('  ok  ', name);
    } catch (e) {
      console.log(`  FAIL ${name}\n         ${e && e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\nselfcross.test.js: ${passed} of ${failures.length} checks passed`);
  if (passed < failures.length) process.exit(1);
})();