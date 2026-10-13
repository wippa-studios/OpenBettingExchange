// rules-consistency.test.js — the rule table and the seed must agree.
// Run: node tests/rules-consistency.test.js   (plain assert, no deps)
//
// WHY THIS EXISTS. The rules table in lib/voidrules.js is keyed by sport SLUG,
// and a sport with no entry falls through to a default of VOID. That default
// is the right fail-safe — refunding every stake is bounded and recoverable,
// settling on a wrong winner moves money the venue may not owe — but it makes
// a KEY MISMATCH indistinguishable from a deliberate no-rules decision.
//
// And the mismatch existed, in two places, and was silently voiding money:
//
//   - the seed creates `greyhounds`, the table had `greyhound`;
//   - the seed creates `basketball`, the table had no entry at all.
//
// So a normally-finished greyhound race and a finished NBA game were both
// VOIDED: every backer's stake came back, nobody was paid, and the layers kept
// the pot. The markets reported `settled` and the books balanced perfectly —
// conservation cannot tell you that a settled market paid the wrong person.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const assert = require('assert');
const { openStore } = require('../lib/store');
const rules = require('../lib/voidrules');
const seed = require('../lib/seed');
const A = require('../lib/auth');
const M = require('../lib/match');
const R = require('../lib/results');
const acc = require('../lib/accounts');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

// S1: EVERY seeded sport has a rule set. This is the check whose absence let a
// finished race be voided.
check('S1 every seeded sport has a rule set', async () => {
  const db = openStore(':memory:');
  await seed.seed(db);
  const slugs = db.prepare('SELECT slug FROM sports ORDER BY slug').all().map((r) => r.slug);
  assert.ok(slugs.length > 0, 'the seed creates sports');
  const missing = slugs.filter((s) => !rules.hasRules(s));
  assert.deepStrictEqual(missing, [], `seeded sports with no void rules: ${missing.join(', ')}`);
  db.close();
});

// S2: and the reverse — every rule set names a sport that exists, so a typo in
// the table is caught as a typo rather than as a silently-voided market.
check('S2 every rule set names a real sport', async () => {
  const db = openStore(':memory:');
  await seed.seed(db);
  const slugs = new Set(db.prepare('SELECT slug FROM sports').all().map((r) => r.slug));
  const orphans = Object.keys(rules.RULES).filter((k) => !slugs.has(k));
  assert.deepStrictEqual(orphans, [], `rule sets for sports that are not seeded: ${orphans.join(', ')}`);
  db.close();
});

// S3: the specific regression, end to end. A finished race with a winner
// SETTLES and pays the winner. This is the assertion that would have failed
// before the key was aligned, and it is worth having in this exact form
// because it is the only place the whole chain (feed signal -> rule -> settle
// -> payout) is exercised against a seeded sport.
check('S3 a finished greyhound race with a winner PAYS the winner', async () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Greyhounds', 'greyhounds')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='greyhounds'").get();
  db.prepare("INSERT INTO events (sport_id, name, starts_at, status) VALUES (?, 'R1', datetime('now','+2 hours'), 'live')").run(sp.id);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get('R1');
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Winner')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  for (const n of ['Red', 'Blue']) db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 3.0)').run(mkt.id, n);
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, 'Red').id;
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 }));
  M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 3.0, stake_cents: 1000 });
  M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: 3.0, stake_cents: 1000 });

  // The race has gone OFF - the one transition a real venue reaches on its own.
  // This used to set status='completed', which lib/settle.js only writes once
  // EVERY market on the event has settled, so the flag described a state the
  // event could not be in while this market was still open.
  db.prepare("UPDATE events SET starts_at = datetime('now','-2 hours') WHERE id = ?").run(ev.id);
  const r = R.applyOutcome(db, mkt.id, { status: 'completed', winners: [s1] });
  assert.strictEqual(r.outcome, 'settled', 'a finished race settles (it used to VOID)');
  const a = db.prepare('SELECT balance_cents b FROM users WHERE username=?').get('alice');
  const b = db.prepare('SELECT balance_cents b FROM users WHERE username=?').get('bob');
  // alice wins 2000 less 2.5% commission (50): +1950. bob pays it.
  assert.strictEqual(a.b, 100000 + 2000 - 50, 'the winner is paid');
  assert.strictEqual(b.b, 100000 - 2000, 'the layer pays it');
  assert.strictEqual(acc.assertConserved(db), 0);
  db.close();
});

// S4: the same for basketball, the other sport that had no rules at all.
check('S4 a finished basketball game with a winner PAYS the winner', async () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Basketball', 'basketball')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='basketball'").get();
  db.prepare("INSERT INTO events (sport_id, name, starts_at, status) VALUES (?, 'G1', datetime('now','+2 hours'), 'live')").run(sp.id);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get('G1');
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Money Line')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  for (const n of ['Home', 'Away']) db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, n);
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, 'Home').id;
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 }));
  M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 1000 });
  M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 1000 });

  // The race has gone OFF - the one transition a real venue reaches on its own.
  // This used to set status='completed', which lib/settle.js only writes once
  // EVERY market on the event has settled, so the flag described a state the
  // event could not be in while this market was still open.
  db.prepare("UPDATE events SET starts_at = datetime('now','-2 hours') WHERE id = ?").run(ev.id);
  const r = R.applyOutcome(db, mkt.id, { status: 'completed', winners: [s1] });
  assert.strictEqual(r.outcome, 'settled');
  assert.strictEqual(db.prepare('SELECT balance_cents b FROM users WHERE username=?').get('alice').b, 100000 + 1000 - 25, 'paid');
  assert.strictEqual(acc.assertConserved(db), 0);
  db.close();
});

// S5: horse racing is seeded, and its dead-heat rule is reachable — the
// capability is not dead code behind a sport that does not exist.
check('S5 horse racing is seeded and settles a dead heat as a joint favourite', async () => {
  const db = openStore(':memory:');
  await seed.seed(db);
  const sp = db.prepare("SELECT id FROM sports WHERE slug='horse_racing'").get();
  assert.ok(sp, 'horse racing exists in the seed');
  db.prepare("INSERT INTO events (sport_id, name, starts_at, status) VALUES (?, 'DH', datetime('now','+2 hours'), 'live')").run(sp.id);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get('DH');
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Winner')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  for (const n of ['Red', 'Blue']) db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.5)').run(mkt.id, n);
  const [red, blue] = db.prepare('SELECT id FROM selections WHERE market_id=? ORDER BY id').all(mkt.id).map((r) => r.id);
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 }));
  M.placeOrder(db, alice, { selection_id: red, side: 'back', price: 2.5, stake_cents: 1000 });
  M.placeOrder(db, bob, { selection_id: red, side: 'lay', price: 2.5, stake_cents: 1000 });

  // The race has gone OFF - the one transition a real venue reaches on its own.
  // This used to set status='completed', which lib/settle.js only writes once
  // EVERY market on the event has settled, so the flag described a state the
  // event could not be in while this market was still open.
  db.prepare("UPDATE events SET starts_at = datetime('now','-2 hours') WHERE id = ?").run(ev.id);
  const r = R.applyOutcome(db, mkt.id, { status: 'completed', dead_heat: true, winners: [red, blue] });
  assert.strictEqual(r.outcome, 'settled', 'the dead heat settles');
  const m = db.prepare('SELECT dead_heat d, joint_winners j FROM markets WHERE id=?').get(mkt.id);
  assert.strictEqual(m.d, 1);
  assert.strictEqual(JSON.parse(m.j).length, 2);
  // Liability 1500, divided between two joint winners -> 750 to alice.
  assert.strictEqual(db.prepare('SELECT balance_cents b FROM users WHERE username=?').get('alice').b, 100000 + 750 - 19, 'paid a share, not a void');
  assert.strictEqual(acc.assertConserved(db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(db), []);
  db.close();
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
  if (passed < 5) { console.error('expected 5 checks'); process.exit(1); }
  console.log(`\nrules-consistency.test.js: ${passed} checks passed`);
})();
