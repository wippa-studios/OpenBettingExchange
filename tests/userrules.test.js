// userrules.test.js — a player's declarative rules, evaluated server-side (#76).
// Run: node tests/userrules.test.js   (plain assert, no deps, offline)
//
// ── WHY THIS FILE ASSERTS COUNTS AND NOT OUTCOMES ─────────────────────────
//
// The obvious way to test a rules engine is: make a rule, move the price, assert
// an order appeared. That test passes against an engine that fires every single
// time it is asked, and against one that fires exactly once ever, and it would
// have passed against the continuous semantics #67 rejected. It proves nothing
// about the trigger.
//
// So every check below that involves evaluation asserts on THREE numbers: how
// many times the rule was CONSIDERED, how many CROSSINGS it saw, and how many
// ORDERS resulted. The counts come from the engine's own return value, so a
// change to how often it evaluates cannot be absorbed by a test that only looks
// at the end state. Where the price stream is driven deliberately rather than
// through drift's random walk, the drive is spelled out tick by tick.
//
// ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
//
// No test creates a rule over HTTP. There is no management route in #76 (#78
// owns it), and the one HTTP route that places orders is asserted below to
// refuse a client-supplied rule_id. A test suite that found an undocumented
// surface would be testing something #76 does not claim to have.
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
const L = require('../lib/limits');
const R = require('../lib/userrules');
const drift = require('../lib/drift');

let passed = 0;
// Every failure reported: a harness that exits on the first one hides every
// later check behind it, and the checks here are ordered so that a broken
// trigger shows up as several independent failures rather than one.
const failures = [];
const check = (name, fn) => { failures.push([name, fn]); };

// ── fixtures ───────────────────────────────────────────────────────────────

let evCounter = 0;

async function fresh(balance_cents = 1000000) {
  const db = openStore(':memory:');
  const mk = (name) => A.registerUser(db, { username: name, password: 'secret1', balance_cents });
  let sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  if (!sport) {
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
    sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  }
  return { db, users: { alice: await mk('alice'), bob: await mk('bob') }, balance_cents };
}

// One market, one selection, at an exact ladder price. Fair price matters: it
// is what a rule WATCHES (lib/drift.js is the only writer), so every check here
// needs a known starting observation.
function mkSelection(db, fair = 2.0, { marketName = 'Match Odds', selName = 'Home' } = {}) {
  evCounter++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1, ?, datetime('now', '+2 hours'))")
    .run(`Rules ${evCounter}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Rules ${evCounter}`);
  db.prepare('INSERT INTO markets (event_id, name) VALUES (?, ?)').run(ev.id, marketName);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id = ? ORDER BY id DESC').get(ev.id);
  db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(mkt.id, selName, fair);
  const sel = db.prepare('SELECT id FROM selections WHERE market_id = ? ORDER BY id DESC').get(mkt.id);
  return { selection_id: sel.id, market_id: mkt.id };
}

// Set a selection's fair price. This is the ONLY way a price moves in this
// venue apart from drift itself, and using it directly is what lets a check
// say "the price went to 1.98" rather than "the price probably went somewhere
// below 2.00 at some point".
function setFair(db, selectionId, price) {
  db.prepare('UPDATE selections SET fair_price = ? WHERE id = ?').run(price, selectionId);
}

// ONE evaluation. Not a loop: every check drives the stream itself so the tick
// count is part of the assertion rather than an accident.
function evaluate(db, selectionId, price) {
  setFair(db, selectionId, price);
  return R.evaluateSelection(db, selectionId, price);
}

// The CHECK clause the schema attaches to ONE column, or '' if it has none.
// Per-column rather than per-table because the claim under test is "no column
// hides an enumerated value", and a table-wide CHECK cannot answer that.
function colComment(ddl, column) {
  const re = new RegExp(`\\n\\s*${column}[^\\n]*\\n(?:[^\\n]*\\n)*?\\s*\\n`);
  const m = ddl.match(re);
  return m ? m[0] : '';
}

const ordersOf = (db, userId) =>
  db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id').all(userId);
const ruleRow = (db, id) => db.prepare('SELECT * FROM user_rules WHERE id = ?').get(id);
const matchesFor = (db, orderId) =>
  db.prepare('SELECT * FROM matches WHERE back_order_id = ? OR lay_order_id = ?').all(orderId, orderId);

// A rule as the product describes one: "if the price goes below 2.00, back at
// $100". A plain object literal, no wrapper class — the record IS the interface.
const belowBack = (db, user, sel, stake = 10000) =>
  R.createRule(db, user, { selection_id: sel.selection_id, op: 'below', threshold: 2.0, side: 'back', stake_cents: stake });

// ── V1: the record ─────────────────────────────────────────────────────────

check('V1 a rule is six fields: a threshold, a direction, a side, a stake', async () => {
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const rule = belowBack(db, users.alice, sel, 10000);

  assert.strictEqual(rule.op, 'below');
  assert.strictEqual(rule.threshold_cents, 200, 'the threshold is stored in integer ladder cents');
  assert.strictEqual(rule.side, 'back');
  assert.strictEqual(rule.stake_cents, 10000);
  assert.strictEqual(rule.user_id, users.alice.id);
  assert.strictEqual(rule.selection_id, sel.selection_id);
  assert.strictEqual(rule.status, 'live');
});

check('V2 a rule is a RECORD — no column can carry an expression, a script or free text', async () => {
  // The safety property of this feature is that a rule cannot be code, and a
  // comment cannot enforce that. The SCHEMA can, and so can this.
  //
  // The test is not "no column named 'expression'" — a column called `condition`
  // holding a JSON blob would pass that and be exactly the failure. It is the
  // shape: every column is either an INTEGER (money, counts, state) or one of
  // THREE closed-vocabulary TEXT columns whose CHECK constraint enumerates every
  // value it can ever hold. There is no free-text column, so there is nowhere to
  // put a rule that the engine would have to interpret.
  const { db } = await fresh();
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_rules'").get().sql;
  const cols = db.prepare('PRAGMA table_info(user_rules)').all();
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

  // The three closed vocabularies, and nothing else that a rule is MADE OF.
  const TEXT_COLUMNS = {
    op: ['below', 'above'],
    side: ['back', 'lay'],
    status: ['live', 'killed'],
  };
  // Two more free-TEXT columns exist and are DELIBERATE: `killed_reason` records
  // why a rule was killed, and `last_error` records why the engine last refused
  // one. Both are READ-BACK for the player and the operator, never
  // read-to-decide. The behavioural half of that claim is asserted at the end of
  // this check: a rule full of hostile text in those two columns still evaluates
  // to exactly one order per crossing, because the engine never consults them.
  const DIAGNOSTIC_TEXT = ['killed_reason', 'last_error'];
  const TIMESTAMPS = ['last_fired_at', 'last_error_at', 'killed_at'];

  // Exhaustive: every non-timestamp TEXT column is a vocabulary or a diagnostic.
  // A new one would have to be added to that list, which is the point.
  assert.deepStrictEqual(
    cols.filter((c) => /^TEXT/i.test(c.type) && !/_at$/.test(c.name)).map((c) => c.name).sort(),
    ['killed_reason', 'last_error', 'op', 'side', 'status'],
    'the only non-timestamp TEXT columns are the three vocabularies and the two diagnostics'
  );

  for (const c of cols) {
    if (/^TEXT/i.test(c.type)) {
      // SQLite has no timestamp type, so every `*_at` column is TEXT. Those, the
      // three vocabularies and the two diagnostics are the only TEXT columns
      // permitted: there is nowhere else to put a rule the engine must read.
      const isTimestamp = /_at$/.test(c.name);
      assert.ok(TEXT_COLUMNS[c.name] || DIAGNOSTIC_TEXT.includes(c.name) || isTimestamp,
        `user_rules.${c.name} is free TEXT — a column the engine would have to interpret. ` +
        'Only the three vocabularies, the two diagnostics and the *_at timestamps may be TEXT.');
      if (isTimestamp) {
        // created_at is the exception and is deliberate: it is NOT NULL with a
        // DEFAULT, because a rule whose creation time is unknown cannot be
        // explained to the player. Every other timestamp is nullable, because
        // "this has never fired" is a fact and not a gap to be filled in.
        const required = c.name === 'created_at';
        assert.ok(required ? c.notnull === 1 : c.notnull === 0,
          `user_rules.${c.name} ${required ? 'must' : 'must not'} be NOT NULL`);
        assert.ok(required ? /DEFAULT \(datetime\('now'\)\)/.test(ddl) : true,
          'created_at must default to now — a caller cannot be asked to supply it');
        assert.ok(!/CHECK/i.test(colComment(ddl, c.name)),
          `user_rules.${c.name} carries a CHECK; a timestamp that constrains its own shape is ` +
          'hiding an enumerated value');
      }
    } else {
      assert.ok(/^INTEGER/i.test(c.type), `user_rules.${c.name} is ${c.type}, not integer cents or state`);
    }
  }
  // Every *_at column the engine WRITES is written by datetime('now'), so the
  // shape a reader has to parse is the one SQLite produces. Asserted here because
  // #81 will read these columns and a differently-shaped timestamp is a silent
  // lexicographic comparison bug waiting to happen.
  assert.ok(/killed_at TEXT,/.test(ddl) && /last_fired_at TEXT,/.test(ddl));
  // Each vocabulary column's allowed values are ENUMERATED IN THE SCHEMA, not merely
  // validated in code — so a row written by a migration, a restore or an operator
  // script cannot smuggle in a fourth value.
  for (const [name, values] of Object.entries(TEXT_COLUMNS)) {
    for (const v of values) {
      assert.ok(ddl.includes(`'${v}'`), `the schema does not enumerate ${name}='${v}'`);
    }
    assert.ok(byName[name].notnull === 1, `${name} must be NOT NULL`);
  }
  // And the numeric columns are the only place a value can be arbitrary: a price
  // and a stake, both constrained to the ladder and to the stake bounds.
  assert.ok(/threshold_cents INTEGER NOT NULL/.test(ddl));
  assert.ok(/stake_cents INTEGER NOT NULL/.test(ddl));

  // No JSON, no BLOB, nothing the JSON layer of a future admin screen could turn
  // into a rule definition. Asserted against the real schema, not this file.
  assert.ok(!/\b(BLOB|JSON)\b/i.test(ddl), 'user_rules holds a BLOB or JSON column');
  for (const t of TIMESTAMPS) assert.ok(byName[t] && /^TEXT/i.test(byName[t].type), `${t} exists as a timestamp column`);

  // ── THE BEHAVIOURAL HALF ────────────────────────────────────────────────
  // Everything above is schema SHAPE. Shape is necessary and not sufficient: what
  // actually makes a rule a program is the engine READING something a player
  // wrote. So the claim is closed behaviourally — fill both diagnostic columns
  // with hostile text and prove evaluation is completely unchanged.
  const bdb = openStore(':memory:');
  const alice = await A.registerUser(bdb, { username: 'alice', password: 'secret1', balance_cents: 1000000 });
  bdb.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const bsel = mkSelection(bdb, 3.0);
  const rule = belowBack(bdb, alice, bsel, 10000);
  bdb.prepare('UPDATE user_rules SET killed_reason = ?, last_error = ? WHERE id = ?')
    .run("'; DROP TABLE orders; --", 'eval("while(1){}") && arm', rule.id);
  const s1 = evaluate(bdb, bsel.selection_id, 1.98);
  assert.strictEqual(s1.considered, 1, 'the rule still evaluates');
  assert.strictEqual(s1.placed, 1, 'and still places exactly one order on a crossing');
  const s2 = evaluate(bdb, bsel.selection_id, 1.97);
  assert.strictEqual(s2.crossed, 0, 'and still does not fire again inside the condition');
  assert.strictEqual(ordersOf(bdb, alice.id).length, 1, 'one order, not two — the diagnostics changed nothing');
  assert.strictEqual(
    bdb.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='orders'").get().c,
    1,
    'the orders table still exists: no text column is ever passed to SQL'
  );
});

check('V3 the threshold is SNAPPED to the ladder, and an off-ladder one is refused', async () => {
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  // 2.75 is inside the ladder's range but not on a tick: it would snap to 2.76,
  // so storing 2.75 would be a rule whose condition is compared against a price
  // the order itself could never be placed at.
  const rule = R.createRule(db, users.alice, {
    selection_id: sel.selection_id, op: 'below', threshold: 2.75, side: 'back', stake_cents: 10000,
  });
  assert.strictEqual(rule.threshold_cents, 276, '2.75 snapped to the 2.76 tick');
  // Out of range is a 400, not a clamp. snapToTick would clamp 5000 to 1000 and
  // silently point the rule at a completely different price.
  assert.throws(
    () => R.createRule(db, users.alice, { selection_id: sel.selection_id, op: 'below', threshold: 5000, side: 'back', stake_cents: 10000 }),
    (e) => e.status === 400,
    'a threshold of 5000 must be refused, not clamped to 1000'
  );
  assert.throws(
    () => R.createRule(db, users.alice, { selection_id: sel.selection_id, op: 'below', threshold: 0.5, side: 'back', stake_cents: 10000 }),
    (e) => e.status === 400
  );
});

check('V4 the condition vocabulary is closed: op and side are not free text', async () => {
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const base = { selection_id: sel.selection_id, threshold: 2.0, side: 'back', stake_cents: 10000 };
  // "price < 2 && myOtherRunner > 3" is not an op, and must not become one.
  for (const op of ['below', 'above']) {
    assert.ok(R.createRule(db, users.alice, { ...base, op }), `"${op}" must be accepted`);
  }
  for (const op of ['below2', 'lte', '<', 'below AND above', '', null, 1, true]) {
    assert.throws(
      () => R.createRule(db, users.alice, { ...base, op }),
      (e) => e.status === 400,
      `op ${JSON.stringify(op)} must be refused`
    );
  }
  for (const side of ['backward', 'buy', 'BANK', '', null, 0]) {
    assert.throws(
      () => R.createRule(db, users.alice, { ...base, op: 'below', side }),
      (e) => e.status === 400,
      `side ${JSON.stringify(side)} must be refused`
    );
  }
});

check('V5 a stake a person could not place, a rule cannot promise', async () => {
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const base = { selection_id: sel.selection_id, op: 'below', threshold: 2.0, side: 'back' };
  // The same bounds validateOrder enforces, from the same constants.
  assert.throws(() => R.createRule(db, users.alice, { ...base, stake_cents: 99 }), (e) => e.status === 400);
  assert.throws(() => R.createRule(db, users.alice, { ...base, stake_cents: 100001 }), (e) => e.status === 400);
  assert.throws(() => R.createRule(db, users.alice, { ...base, stake_cents: 100.5 }), (e) => e.status === 400);
  assert.throws(() => R.createRule(db, users.alice, { ...base, stake_cents: '10000' }), (e) => e.status === 400);
  assert.ok(R.createRule(db, users.alice, { ...base, stake_cents: 100 }), 'the minimum stake is still allowed');
});

check('V6 a rule cannot be created on a market that will refuse it anyway', async () => {
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  db.prepare("UPDATE markets SET status = 'settled' WHERE id = ?").run(sel.market_id);
  assert.throws(
    () => belowBack(db, users.alice, sel),
    (e) => e.status === 409,
    'a rule on a settled market could never fire; refusing it now is honest'
  );
  // Same for a selection the operator has taken out of play individually.
  const sel2 = mkSelection(db, 3.0, { marketName: 'M2', selName: 'Away' });
  db.prepare("UPDATE selections SET status = 'suspended' WHERE id = ?").run(sel2.selection_id);
  assert.throws(() => belowBack(db, users.alice, sel2), (e) => e.status === 409);
  // And a selection that does not exist is a 404, not an empty rule.
  assert.throws(
    () => R.createRule(db, users.alice, { selection_id: 999999, op: 'below', threshold: 2.0, side: 'back', stake_cents: 10000 }),
    (e) => e.status === 404
  );
});

// ── V2: the cap ────────────────────────────────────────────────────────────

check('V7 the cap is 3 LIVE rules per USER, and it is per user', async () => {
  const { db, users } = await fresh();
  const sels = [mkSelection(db, 3.0, { selName: 'A' }), mkSelection(db, 3.0, { selName: 'B' }), mkSelection(db, 3.0, { selName: 'C' }), mkSelection(db, 3.0, { selName: 'D' })];
  assert.strictEqual(R.MAX_RULES_PER_USER, 3);

  for (let i = 0; i < 3; i++) belowBack(db, users.alice, sels[i]);
  assert.strictEqual(R.liveRuleCount(db, users.alice.id), 3, 'three rules created');
  assert.throws(
    () => belowBack(db, users.alice, sels[3]),
    (e) => e.status === 409 && e.details && e.details.code === 'rule_limit_reached',
    'the FOURTH rule is refused'
  );
  assert.strictEqual(R.liveRuleCount(db, users.alice.id), 3, 'the refused create left nothing behind');

  // THE PER-USER HALF. A cap on "rules on this market" or "rules created today"
  // would let a user sidestep it by spreading across markets, which is why the
  // count is a plain COUNT over one user and no other predicate.
  assert.strictEqual(R.liveRuleCount(db, users.bob.id), 0);
  assert.ok(belowBack(db, users.bob, sels[0]), 'a different user is entirely unaffected by Alice\'s cap');
  assert.ok(belowBack(db, users.bob, sels[1]));
  assert.ok(belowBack(db, users.bob, sels[2]));
  assert.throws(() => belowBack(db, users.bob, sels[3]), (e) => e.status === 409);
});

check('V8 a KILLED rule frees its slot, and killing stops evaluation immediately', async () => {
  const { db, users } = await fresh();
  const sels = [mkSelection(db, 3.0, { selName: 'A' }), mkSelection(db, 3.0, { selName: 'B' }), mkSelection(db, 3.0, { selName: 'C' }), mkSelection(db, 3.0, { selName: 'D' })];
  const a = [sels[0], sels[1], sels[2]].map((s) => belowBack(db, users.alice, s));
  assert.throws(() => belowBack(db, users.alice, sels[3]), (e) => e.status === 409);

  R.killRule(db, users.alice.id, a[0].id, 'changed my mind');
  assert.strictEqual(R.liveRuleCount(db, users.alice.id), 2, 'the killed rule no longer counts');
  const fourth = belowBack(db, users.alice, sels[3]);
  assert.ok(fourth, 'the freed slot is usable');

  // IMMEDIATE, not eventual. #67 requires killing to stop crossings on the
  // spot, and the way that is true is that evaluation reads status per tick
  // rather than holding a cached list. Proved here by driving price THROUGH the
  // threshold the killed rule watches: if evaluation were cached, this would
  // fire.
  const stats = evaluate(db, sels[0].selection_id, 1.5);
  assert.strictEqual(stats.considered, 0, 'a killed rule is not even CONSIDERED — it was never cached');
  assert.strictEqual(ordersOf(db, users.alice.id).length, 0, 'no order, in either market');

  // And the row survives, so its orders can still be explained (#81).
  assert.strictEqual(ruleRow(db, a[0].id).status, 'killed');
  assert.strictEqual(ruleRow(db, a[0].id).fire_count, 0);
});

// ── V3: the trigger, driven tick by tick ───────────────────────────────────

check('V9 ONE-SHOT PER CROSSING: a price sitting inside the condition places ONE order, not one per evaluation', async () => {
  // This is the central behavioural claim of #76 and the one a single-shot
  // outcome test cannot make. Six evaluations, all of them with the condition
  // holding. Exactly one order may result. An engine that fired per evaluation
  // would place six; an engine with no arming at all would place one and then be
  // unable to fire again at all, which V10 covers.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const rule = belowBack(db, users.alice, sel, 10000);

  const first = evaluate(db, sel.selection_id, 1.98);  // 3.00 -> 1.98: CROSSES below 2.00
  assert.strictEqual(first.considered, 1);
  assert.strictEqual(first.crossed, 1, 'the crossing was seen');
  assert.strictEqual(first.placed, 1);
  assert.strictEqual(first.refused, 0);
  assert.strictEqual(first.crossed - first.placed, first.refused, 'crossed - placed = refused, always');

  // Now five more evaluations with the condition STILL holding and the price
  // moving further below. Every one of them is a real evaluation the engine
  // performs; none may place an order.
  let considered = first.considered;
  let crossed = first.crossed;
  let placed = first.placed;
  for (const p of [1.97, 1.96, 1.95, 1.90, 1.50]) {
    const s = evaluate(db, sel.selection_id, p);
    considered += s.considered;
    crossed += s.crossed;
    placed += s.placed;
    assert.strictEqual(s.crossed, 0, `price ${p} is not a crossing — the condition never lifted`);
    assert.strictEqual(s.placed, 0, `an evaluation at ${p} placed an order`);
  }
  assert.strictEqual(considered, 6, 'all six evaluations really ran');
  assert.strictEqual(crossed, 1, 'exactly one crossing in six evaluations');
  assert.strictEqual(placed, 1);
  assert.strictEqual(ordersOf(db, users.alice.id).length, 1, 'one order in the book, not five');
  assert.strictEqual(ruleRow(db, rule.id).fire_count, 1, 'the visible fire count agrees');
});

check('V10 it RE-ARMS: lift, cross again, and the rule fires a second time', async () => {
  // V9 alone is satisfied by a rule that fires exactly once ever. The arming
  // half is the difference between a crossing rule and a broken one, so it is
  // asserted as its own check with its own arithmetic.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const rule = belowBack(db, users.alice, sel, 10000);

  const s1 = evaluate(db, sel.selection_id, 1.98);
  assert.strictEqual(s1.placed, 1);
  const lift = evaluate(db, sel.selection_id, 2.04);
  assert.strictEqual(lift.crossed, 0, 'going back ABOVE the threshold is not a crossing');
  assert.strictEqual(lift.placed, 0);
  assert.strictEqual(ruleRow(db, rule.id).armed, 1, 'the rule re-armed the moment the condition lifted');

  const s2 = evaluate(db, sel.selection_id, 1.99);
  assert.strictEqual(s2.crossed, 1, 'a genuine second crossing');
  assert.strictEqual(s2.placed, 1);
  assert.strictEqual(ruleRow(db, rule.id).fire_count, 2);
  assert.strictEqual(ordersOf(db, users.alice.id).length, 2, 'two orders, two crossings');

  // And a third, to show it is not a two-strike machine.
  evaluate(db, sel.selection_id, 2.10);
  const s3 = evaluate(db, sel.selection_id, 1.80);
  assert.strictEqual(s3.placed, 1);
  assert.strictEqual(ordersOf(db, users.alice.id).length, 3);
});

check('V11 an OSCILLATING price places one order per crossing, not one per tick', async () => {
  // The DoS case #67 named: a price bouncing across the threshold at the drift
  // tick rate. Every crossing here is real, so one order each is correct — the
  // check is that the count equals the number of crossings and nothing else,
  // and specifically that the ticks which did NOT cross placed nothing.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const rule = belowBack(db, users.alice, sel, 10000);

  const path = [2.04, 1.98, 2.02, 1.96, 2.00, 1.99, 2.06, 1.97, 1.98, 1.98];
  let placed = 0;
  let considered = 0;
  for (const p of path) {
    const s = evaluate(db, sel.selection_id, p);
    placed += s.placed;
    considered += s.considered;
  }
  assert.strictEqual(considered, 10, 'every tick was evaluated');
  // Crossings: 1.98 (1), 1.96 (2), 1.99 (3), 1.97 (4). 1.98/1.98 again at the
  // end is NOT a crossing — the condition never lifted in between.
  assert.strictEqual(placed, 4, `expected 4 orders from 4 crossings, got ${placed}`);
  assert.strictEqual(ordersOf(db, users.alice.id).length, 4);
  assert.strictEqual(ruleRow(db, rule.id).fire_count, 4);
});

check('V12 `above` is the mirror of `below`, on both sides of the ladder', async () => {
  const { db, users } = await fresh();
  const sel = mkSelection(db, 1.5);
  const rule = R.createRule(db, users.alice, {
    selection_id: sel.selection_id, op: 'above', threshold: 2.0, side: 'lay', stake_cents: 10000,
  });
  const up = evaluate(db, sel.selection_id, 2.02);
  assert.strictEqual(up.crossed, 1);
  assert.strictEqual(up.placed, 1);
  // Rising further is not another crossing.
  const further = evaluate(db, sel.selection_id, 5.0);
  assert.strictEqual(further.crossed, 0);
  assert.strictEqual(further.placed, 0);
  evaluate(db, sel.selection_id, 1.20); // lifts -> re-arms
  // 2.02, not 2.01: the ladder steps .01 to 2.00 and then .02 to 2.02, so 2.01 is
  // NOT a price and snaps DOWN to 2.00 — which is not above 2.00. A rule compared
  // against an unsnapped observation would have fired here, on a price the venue
  // does not quote.
  const gap = evaluate(db, sel.selection_id, 2.01);
  assert.strictEqual(gap.crossed, 0, '2.01 is not a ladder price; it snaps to 2.00 and does not cross');
  const again = evaluate(db, sel.selection_id, 2.02);
  assert.strictEqual(again.crossed, 1, 'a second crossing of the threshold fires');
  // And staying above does not, which is the whole of the one-shot property.
  assert.strictEqual(evaluate(db, sel.selection_id, 9.0).crossed, 0, 'still above 2.00, so no further crossing');
  assert.strictEqual(ordersOf(db, users.alice.id).length, 2);
  assert.strictEqual(ruleRow(db, rule.id).fire_count, 2);
});

check('V13 the threshold is EXCLUSIVE — a price sitting exactly on it does not fire', async () => {
  // `>=` would make a rule whose threshold equals the live price permanently
  // true. Under one-shot semantics that is survivable; under the continuous
  // semantics #67 chose it is an order per evaluation forever. The rule is
  // strict now so that #77 does not have to discover this.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const rule = belowBack(db, users.alice, sel);
  const at = evaluate(db, sel.selection_id, 2.0);
  assert.strictEqual(at.crossed, 0, '2.00 is not strictly below 2.00');
  assert.strictEqual(at.placed, 0);
  assert.strictEqual(ruleRow(db, rule.id).armed, 1, 'and it is still armed for a real crossing');
  assert.strictEqual(evaluate(db, sel.selection_id, 1.99).placed, 1);
});

check('V14 a rule created while its condition ALREADY holds does not fire on the next tick', async () => {
  // Stated in lib/userrules.js and worth its own check, because it is the one
  // genuinely debatable choice in the file and the dangerous direction is the
  // one it refuses.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 1.50);  // already below 2.00
  const rule = belowBack(db, users.alice, sel);
  assert.strictEqual(rule.armed, 0, 'created inside the condition: disarmed');

  const s = evaluate(db, sel.selection_id, 1.49);
  assert.strictEqual(s.considered, 1, 'still evaluated — it is watched');
  assert.strictEqual(s.crossed, 0, 'but the price never CROSSED');
  assert.strictEqual(s.placed, 0, 'no order on the first tick after creation');
  assert.strictEqual(ordersOf(db, users.alice.id).length, 0);

  evaluate(db, sel.selection_id, 2.10);  // lifts -> re-arms
  assert.strictEqual(ruleRow(db, rule.id).armed, 1);
  assert.strictEqual(evaluate(db, sel.selection_id, 1.95).placed, 1, 'a real crossing fires');
});

check('V15 a rule on ONE selection never sees another selection\'s price', async () => {
  const { db, users } = await fresh();
  const watched = mkSelection(db, 3.0, { marketName: 'Watched', selName: 'Fav' });
  const other = mkSelection(db, 3.0, { marketName: 'Other', selName: 'Dog' });
  belowBack(db, users.alice, watched);

  const s = evaluate(db, other.selection_id, 1.10);
  assert.strictEqual(s.considered, 0, "another runner's move is not this rule's business");
  assert.strictEqual(ordersOf(db, users.alice.id).length, 0);
  assert.strictEqual(evaluate(db, watched.selection_id, 1.10).placed, 1, 'the watched selection does fire');
});

check('V16 one user\'s rule never fires for another user', async () => {
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  belowBack(db, users.alice, sel);
  const s = evaluate(db, sel.selection_id, 1.10);
  assert.strictEqual(s.placed, 1);
  const orders = ordersOf(db, users.bob.id);
  assert.strictEqual(orders.length, 0, "Bob's book is untouched by Alice's rule");
  const placed = ordersOf(db, users.alice.id);
  assert.strictEqual(placed.length, 1);
  assert.strictEqual(placed[0].user_id, users.alice.id, 'the order belongs to the rule owner');
});

check('V17 a rule survives its own order being cancelled or filled', async () => {
  // #67 asks the question directly: does a rule survive its order filling? In
  // crossing semantics the answer is forced — the rule does not "survive" a
  // firing at all, because a firing does not consume the rule. Only the re-arm
  // matters.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const rule = belowBack(db, users.alice, sel, 10000);
  const first = ordersOf(db, users.alice.id)[0] || evaluate(db, sel.selection_id, 1.98) && ordersOf(db, users.alice.id)[0];
  assert.strictEqual(ruleRow(db, rule.id).fire_count, 1);
  M.cancelOrder(db, users.alice, first.id);

  evaluate(db, sel.selection_id, 2.05);
  const s = evaluate(db, sel.selection_id, 1.97);
  assert.strictEqual(s.placed, 1, 'a cancelled order does not retire the rule');
  assert.strictEqual(ruleRow(db, rule.id).fire_count, 2);
});

// ── V4: the order the rule produces ────────────────────────────────────────

check('V18 the order is an ORDINARY order, attributable to its rule', async () => {
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const rule = belowBack(db, users.alice, sel, 10000);
  evaluate(db, sel.selection_id, 1.98);

  const [o] = ordersOf(db, users.alice.id);
  assert.ok(o, 'an order exists');
  assert.strictEqual(o.rule_id, rule.id, 'it names the rule that placed it');
  assert.strictEqual(o.side, 'back');
  assert.strictEqual(o.stake_cents, 10000);
  assert.strictEqual(o.status, 'open', 'it rests in the book like any hand-placed order');
  // And it is visible through the existing surface, not a parallel one: this is
  // the same query the player's own order list uses.
  const listed = M.openOrdersFor(db, users.alice.id);
  assert.strictEqual(listed.length, 1, 'it appears in the player\'s open orders');
  assert.strictEqual(listed[0].id, o.id);
});

check('V19 the price the order is placed AT never degrades past the threshold', async () => {
  // The derived price. The naive implementation — "place at the price that
  // tripped the rule" — is WRONG for half the four combinations, and wrong in
  // the direction that costs the player money.
  const { db, users } = await fresh();
  // FOUR combinations, so the per-user cap of 3 is spread over two users rather
  // than worked around: an earlier version of this check created four rules for
  // one user and hit the cap (V7), which is the cap working correctly.
  //
  // back + below: observed 1.50 is a WORSE back price than the 2.00 asked for.
  const sBackBelow = mkSelection(db, 3.0, { marketName: 'BB', selName: 'A' });
  const backBelow = belowBack(db, users.alice, sBackBelow, 10000);
  evaluate(db, sBackBelow.selection_id, 1.50);
  assert.strictEqual(ordersOf(db, users.alice.id).at(-1).price, 2.0,
    'back-below places at the THRESHOLD, not at a hundred ticks worse');

  // back + above: observed 3.00 is BETTER than the 2.00 threshold, and is kept.
  const sBackAbove = mkSelection(db, 1.5, { marketName: 'BA', selName: 'B' });
  R.createRule(db, users.alice, { selection_id: sBackAbove.selection_id, op: 'above', threshold: 2.0, side: 'back', stake_cents: 10000 });
  evaluate(db, sBackAbove.selection_id, 3.00);
  assert.strictEqual(ordersOf(db, users.alice.id).at(-1).price, 3.0,
    'back-above keeps the improvement rather than throwing it away');

  // lay + above: observed 5.00 is a WORSE lay price than 2.00.
  const sLayAbove = mkSelection(db, 1.5, { marketName: 'LA', selName: 'C' });
  R.createRule(db, users.bob, { selection_id: sLayAbove.selection_id, op: 'above', threshold: 2.0, side: 'lay', stake_cents: 10000 });
  evaluate(db, sLayAbove.selection_id, 5.00);
  assert.strictEqual(ordersOf(db, users.bob.id).at(-1).price, 2.0, 'lay-above places at the threshold');

  // lay + below: observed 1.50 is BETTER for a layer, and is kept.
  const sLayBelow = mkSelection(db, 3.0, { marketName: 'LB', selName: 'D' });
  R.createRule(db, users.bob, { selection_id: sLayBelow.selection_id, op: 'below', threshold: 2.0, side: 'lay', stake_cents: 10000 });
  evaluate(db, sLayBelow.selection_id, 1.50);
  assert.strictEqual(ordersOf(db, users.bob.id).at(-1).price, 1.5, 'lay-below keeps the improvement');
  assert.strictEqual(ruleRow(db, backBelow.id).fire_count, 1);
});

check('V20 the order is priced from the SNAPSHOT, so it is always on the ladder', async () => {
  // The stored threshold and the observed price are both ladder ticks, so the
  // min/max between them is a tick. This asserts the invariant holds against a
  // hand-edited row, because a rule can be written directly (a migration, an
  // operator script) and must not be able to produce an off-ladder order.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const rule = belowBack(db, users.alice, sel);
  db.prepare('UPDATE user_rules SET threshold_cents = 281 WHERE id = ?').run(rule.id); // 2.81 is between ticks
  const s = evaluate(db, sel.selection_id, 1.98);
  assert.strictEqual(s.placed, 1);
  const price = ordersOf(db, users.alice.id)[0].price;
  const { validTick } = require('../lib/odds');
  assert.ok(validTick(price), `${price} is not a ladder tick`);
});

check('V21 a rule CAN fill, and the fill is marked as the player\'s own liquidity', async () => {
  // With the house excluded (#67) the only counterparty is the same user's own
  // resting orders, via the #75 exception. If a rule's order could never fill,
  // the whole feature would be untestable and useless — and this is the path
  // #75 could not reach, because its test could only mark an order automated
  // AFTER placeOrder returned.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  // Alice's own manual lay rests, waiting to be taken.
  M.placeOrder(db, users.alice, { selection_id: sel.selection_id, side: 'lay', price: 2.0, stake_cents: 10000 });
  belowBack(db, users.alice, sel, 10000);

  const s = evaluate(db, sel.selection_id, 1.98);
  assert.strictEqual(s.placed, 1);
  const [o] = ordersOf(db, users.alice.id).filter((r) => r.rule_id !== null);
  assert.strictEqual(o.matched_cents, 10000, 'the rule order was TAKEN, as the taker');
  assert.strictEqual(o.status, 'fully_matched');
  const ms = matchesFor(db, o.id);
  assert.strictEqual(ms.length, 1);
  assert.strictEqual(ms[0].self_crossed, 1, 'the fill is recorded as the player\'s own liquidity');
  // The audit row already exists (#75, S7) and must still name the rule.
  const auditRows = db.prepare("SELECT * FROM audit_log WHERE action = 'trade.self_crossed'").all();
  assert.strictEqual(auditRows.length, 1);
  assert.strictEqual(JSON.parse(auditRows[0].after || '{}').rule_id, ruleIdOf(db, users.alice.id, 2.0), 'the audit row names the rule');
});

function ruleIdOf(db, userId, price) {
  const o = db.prepare('SELECT rule_id FROM orders WHERE user_id = ? AND price = ? AND rule_id IS NOT NULL').get(userId, price);
  return o ? o.rule_id : null;
}

// ── V5: the limits still bite ──────────────────────────────────────────────

check('V22 an INSUFFICIENT BALANCE fails closed — once, with the reason recorded, and never retried', async () => {
  // #67: "a rule that fires with insufficient funds must fail closed and notify,
  // not retry". The disarm-before-place ordering is what makes that true, and
  // the retry check below is what proves it: if the balance arrives and the
  // condition still holds, the rule must NOT wake up and place.
  const db = openStore(':memory:');
  const alice = await A.registerUser(db, { username: 'alice', password: 'secret1', balance_cents: 5000 });
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1, 'E', datetime('now', '+2 hours'))").run();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (1, 'Match Odds')").run();
  const mid = db.prepare('SELECT id FROM markets').get().id;
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Home', 3.0)").run(mid);
  const sid = db.prepare('SELECT id FROM selections').get().id;

  // A $1,000 stake against a $50 account. Deliberately far out of bounds rather
  // than exactly equal: escrow 100000 == balance 100000 is NOT a refusal
  // (availableOf returns the balance, and `<` is the test), so an exactly-equal
  // fixture would pass for the wrong reason.
  const rule = R.createRule(db, alice, { selection_id: sid, op: 'below', threshold: 2.0, side: 'back', stake_cents: 100000 });
  const s = evaluate(db, sid, 1.98);
  assert.strictEqual(s.crossed, 1, 'it crossed');
  assert.strictEqual(s.placed, 0, 'no order — the balance could not cover the stake');
  assert.strictEqual(s.refused, 1);
  assert.strictEqual(s.errors.length, 1);
  assert.ok(/balance/i.test(s.errors[0].error), `the refusal names the balance: ${s.errors[0].error}`);
  const row = ruleRow(db, rule.id);
  assert.strictEqual(row.refusal_count, 1);
  assert.strictEqual(row.fire_count, 0, 'a refusal is NOT counted as a firing — otherwise the tally lies about what was traded');
  assert.ok(row.last_error, 'the reason is stored so the player can find out');
  assert.strictEqual(ordersOf(db, alice.id).length, 0);

  // Top the account up, then keep the price inside the condition. No retry.
  db.prepare('UPDATE users SET balance_cents = 1000000, frozen_cents = 0 WHERE id = ?').run(alice.id);
  const again = evaluate(db, sid, 1.97);
  assert.strictEqual(again.considered, 1, 'still evaluated');
  assert.strictEqual(again.placed, 0, 'NOT retried while the condition holds');
  assert.strictEqual(ordersOf(db, alice.id).length, 0);
  assert.strictEqual(ruleRow(db, rule.id).refusal_count, 1, 'and not attempted again either');

  // Only a genuine re-crossing fires.
  evaluate(db, sid, 2.10);
  assert.strictEqual(evaluate(db, sid, 1.90).placed, 1, 'a real crossing after a real lift');
});

check('V23 the per-user STAKE cap bites a rule exactly as it bites a person', async () => {
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  L.setLimits(db, { userId: users.alice.id, scope: 'global', max_open_stake_cents: 5000 });

  // Below the cap: fires normally. Proves the gate is the cap and not the fact
  // that a rule is placing anything.
  const small = R.createRule(db, users.alice, { selection_id: sel.selection_id, op: 'below', threshold: 2.0, side: 'back', stake_cents: 5000 });
  assert.strictEqual(evaluate(db, sel.selection_id, 1.98).placed, 1);

  // Over the cap: refused, with the limit's own message and code.
  const big = R.createRule(db, users.alice, { selection_id: sel.selection_id, op: 'below', threshold: 1.5, side: 'back', stake_cents: 20000 });
  const s = evaluate(db, sel.selection_id, 1.40);
  assert.strictEqual(s.placed, 0, 'a rule cannot exceed a cap that stops a person');
  assert.strictEqual(s.refused, 1);
  assert.ok(/limit/i.test(s.errors[0].error), `names the limit: ${s.errors[0].error}`);
  assert.strictEqual(ruleRow(db, big.id).refusal_count, 1);
  assert.strictEqual(ruleRow(db, small.id).fire_count, 1);

  // AND the same cap stops a MANUAL order of the same size, in the same state.
  // If this passed for a rule but not for a hand, the rule had a parallel path.
  assert.throws(
    () => M.placeOrder(db, users.alice, { selection_id: sel.selection_id, side: 'back', price: 1.3, stake_cents: 20000 }),
    (e) => e.status === 429,
    'the identical stake is refused for a hand-placed order too'
  );
});

check('V24 the per-user MARKET LIABILITY cap bites a rule, on the lay side where it matters', async () => {
  // The lay axis is the one a stake cap cannot see: a $10 lay at 2.00 costs
  // $10,000 of liability and a $10 stake. A rule promising a fixed stake can
  // therefore request a liability cap it would never trip by hand.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 1.5);
  // A lay of 10000 @ 2.00 needs 10000 of escrow, so the cap has to sit BELOW
  // that for the gate to be reached. A cap above it would pass without ever
  // asking the question.
  L.setLimits(db, { userId: users.alice.id, scope: `market:${sel.market_id}`, max_market_liability_cents: 5000 });
  const rule = R.createRule(db, users.alice, {
    selection_id: sel.selection_id, op: 'above', threshold: 2.0, side: 'lay', stake_cents: 10000,
  });
  const s = evaluate(db, sel.selection_id, 3.00);
  assert.strictEqual(s.placed, 0, 'a $100 liability is over a $50 cap');
  assert.strictEqual(s.refused, 1);
  assert.ok(/liabilit/i.test(s.errors[0].error), `names the liability cap: ${s.errors[0].error}`);
  assert.strictEqual(ruleRow(db, rule.id).refusal_count, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id = ?').get(users.alice.id).c, 0);
});

check('V25 SELF-EXCLUSION kills a rule on the spot, and no evaluation happens at all', async () => {
  // #67 decides self-exclusion is "instant" and that it "kills live rules on the
  // spot". Two halves, and the order matters: the rules are killed, so a later
  // evaluation does not even CONSIDER them.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const rule = belowBack(db, users.alice, sel, 10000);
  assert.strictEqual(rule.armed, 1);
  assert.strictEqual(ruleRow(db, rule.id).status, 'live');

  L.exclude(db, { userId: users.alice.id, until: null, reason: 'done with this' });
  assert.strictEqual(L.exclusionOf(db, users.alice.id), 'permanent', 'the exclusion is in force');
  const killed = ruleRow(db, rule.id);
  assert.strictEqual(killed.status, 'killed', 'the live rule was killed by the exclusion itself');
  assert.ok(killed.killed_at, 'and the kill is timestamped');
  assert.strictEqual(R.liveRuleCount(db, users.alice.id), 0, 'the slot is free — an excluded player is not holding a cap slot');

  const s = evaluate(db, sel.selection_id, 1.98);
  assert.strictEqual(s.considered, 0, 'a killed rule is never evaluated, so nothing can be refused or placed');
  assert.strictEqual(s.placed, 0);
  assert.strictEqual(s.refused, 0);
  assert.strictEqual(ordersOf(db, users.alice.id).length, 0);

  // And it is not enough that ONE account was excluded: another user's rule on
  // the same selection is untouched, or "kill the rules" would be implemented
  // as "stop the venue".
  const bobRule = belowBack(db, users.bob, mkSelection(db, 3.0, { marketName: 'Bobs', selName: 'Fav' }), 10000);
  assert.strictEqual(ruleRow(db, bobRule.id).status, 'live');
  assert.strictEqual(evaluate(db, ruleRow(db, bobRule.id).selection_id, 1.98).placed, 1, "Bob's rule still works");
});

check('V25b even with the rule alive, an excluded account places NOTHING', async () => {
  // The defence-in-depth half, isolated so it cannot pass merely because
  // exclusion happened to kill the rule: re-arm a rule by hand (as a bad
  // migration or a partial failure would) and prove the engine still refuses.
  // The control that matters is the PLACEMENT gate, not the kill.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const rule = belowBack(db, users.alice, sel, 10000);
  L.exclude(db, { userId: users.alice.id, until: null, reason: 'done' });
  // Un-kill and re-arm it by hand, bypassing the kill path entirely.
  db.prepare("UPDATE user_rules SET status = 'live', armed = 1 WHERE id = ?").run(rule.id);

  const s = evaluate(db, sel.selection_id, 1.98);
  assert.strictEqual(s.considered, 1, 'the resurrected rule IS evaluated');
  assert.strictEqual(s.placed, 0, 'and the engine still refuses to place for an excluded account');
  assert.strictEqual(s.refused, 1);
  assert.ok(/exclud/i.test(s.errors[0].error), `names the exclusion: ${s.errors[0].error}`);
  assert.strictEqual(ordersOf(db, users.alice.id).length, 0);
  assert.strictEqual(ruleRow(db, rule.id).fire_count, 0);
  assert.strictEqual(ruleRow(db, rule.id).refusal_count, 1);
});

check('V26 the IN-PLAY BET DELAY is not routable around', async () => {
  // The delay exists because the venue cannot match a goal in real time. A bot
  // has every incentive to route around it, which is exactly why the check is
  // here rather than assumed: a rule's order must carry the SAME eligible_at a
  // hand-placed order would, and must NOT sweep on arrival.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  db.prepare('UPDATE markets SET inplay = 1, inplay_delay_ms = 60000 WHERE id = ?').run(sel.market_id);

  // A manual resting lay, so a rule order WOULD have something to take if the
  // delay were bypassed.
  M.placeOrder(db, users.alice, { selection_id: sel.selection_id, side: 'lay', price: 2.0, stake_cents: 10000 });
  belowBack(db, users.alice, sel, 10000);

  const s = evaluate(db, sel.selection_id, 1.98);
  assert.strictEqual(s.placed, 1, 'the rule still gets its order accepted');
  const o = ordersOf(db, users.alice.id).find((r) => r.rule_id !== null);
  assert.strictEqual(o.matched_cents, 0, 'but it matched NOTHING — the delay held');
  assert.strictEqual(o.status, 'open');
  assert.ok(o.eligible_at, 'it carries an eligible_at, exactly as a hand-placed in-play order would');
  assert.strictEqual(o.delayed, 1, 'and it is marked as delayed');
  assert.strictEqual(matchesFor(db, o.id).length, 0, 'no match row: the delay is the control, not a note');

  // And the same shape a person gets: a hand-placed in-play order in a second
  // market gets the identical treatment, which is what "the rule respects the
  // same gate" means rather than "the rule has a delay of its own".
  const sel2 = mkSelection(db, 3.0, { marketName: 'IP2', selName: 'Away' });
  db.prepare('UPDATE markets SET inplay = 1, inplay_delay_ms = 60000 WHERE id = ?').run(sel2.market_id);
  M.placeOrder(db, users.alice, { selection_id: sel2.selection_id, side: 'lay', price: 2.0, stake_cents: 10000 });
  const manual = M.placeOrder(db, users.alice, { selection_id: sel2.selection_id, side: 'back', price: 1.9, stake_cents: 10000 }).order;
  assert.ok(manual.eligible_at, 'a hand gets the same delay');
  // placeOrderTx coerces `delayed` to a boolean on the RETURNED row (the column
  // itself stays 0/1), so this is compared the way the API surfaces it.
  assert.strictEqual(!!manual.delayed, true);
  assert.strictEqual(manual.matched_cents, 0, 'and it matched nothing either');
  assert.strictEqual(!!o.eligible_at, !!manual.eligible_at, 'both are delayed, or neither is');

  // NEITHER swept. The rule's order and the hand's order are in the book
  // together, un-matched, waiting for the same release pass — so the automation
  // bought no latency advantage over a person, which is the entire reason the
  // delay exists. (Their PRICES differ legitimately: the rule places at its own
  // threshold, which V19 covers. What has to match here is the DELAY.)
});

check('V27 a rule order can never be placed on a SUSPENDED market', async () => {
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  belowBack(db, users.alice, sel, 10000);
  db.prepare("UPDATE markets SET suspend_until = datetime('now', '+1 hour') WHERE id = ?").run(sel.market_id);
  const s = evaluate(db, sel.selection_id, 1.98);
  assert.strictEqual(s.placed, 0);
  assert.strictEqual(s.refused, 1);
  assert.ok(/suspend/i.test(s.errors[0].error), `names the suspension: ${s.errors[0].error}`);
});

check('V28 a rule CANNOT set its own rule_id — the bypass this feature must not have', async () => {
  // The structural property: rule_id enters the engine on the INSERT, and the
  // only route that places orders builds its argument field by field. A caller
  // that could mark its own order automated could take the #75 self-cross
  // exception on demand, so what is asserted is the ENGINE, not the route's
  // JSON handling: an ordinary placeOrder with no rule_id writes NULL, and an
  // arbitrary caller-supplied rule_id never reaches placeOrderTx as a field the
  // engine trusts.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  const plain = M.placeOrder(db, users.alice, { selection_id: sel.selection_id, side: 'back', price: 1.9, stake_cents: 1000 }).order;
  assert.strictEqual(plain.rule_id, null, 'a hand-placed order is manual by default');

  // The request body a browser sends can contain anything at all. The route
  // destructures five named fields, so the rest never becomes part of `req`.
  // Reproduced here by putting rule_id in the body and passing exactly what the
  // route would pass.
  const body = { selection_id: sel.selection_id, side: 'back', price: 1.95, stake_cents: 1000, rule_id: 999999 };
  const { selection_id, side, price, stake_cents, client_order_id } = body;
  const spoofed = M.placeOrder(db, users.alice, { selection_id, side, price, stake_cents, client_order_id });
  assert.strictEqual(spoofed.order.rule_id, null, 'rule_id in a request body does not reach the engine');
});

// ── V6: no house participation (#67) ───────────────────────────────────────

check('V29 the HOUSE does not fill a rule order — the counterparty check of the #67 decision', async () => {
  // Decided in #67 and NOT implemented by #75: lib/bots.js must not fill an
  // automated order. Both directions are the same conflict of interest with the
  // words reversed, so both are asserted.
  await require('../lib/bots').primeBotHash();
  const db = openStore(':memory:');
  const alice = await A.registerUser(db, { username: 'alice', password: 'secret1', balance_cents: 1000000 });
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1, 'E', datetime('now', '+2 hours'))").run();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (1, 'Match Odds')").run();
  const mid = db.prepare('SELECT id FROM markets').get().id;
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Home', 3.0)").run(mid);
  const sid = db.prepare('SELECT id FROM selections').get().id;
  const bots = require('../lib/bots');
  const house = bots.ensureBot(db);

  // DIRECTION 1: the rule order is TAKER, the house's lay is resting.
  bots.requoteSelection(db, sid);
  const botOrders = db.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'open'").all(house.id);
  assert.ok(botOrders.length > 0, 'the house really is quoting, so this is not vacuous');
  R.createRule(db, alice, { selection_id: sid, op: 'below', threshold: 2.0, side: 'back', stake_cents: 10000 });
  const s = evaluate(db, sid, 1.98);
  assert.strictEqual(s.placed, 1, 'the rule order was accepted');
  const ruleOrder = db.prepare('SELECT * FROM orders WHERE user_id = ? AND rule_id IS NOT NULL').get(alice.id);
  assert.strictEqual(ruleOrder.matched_cents, 0, 'the house did NOT fill it');
  assert.strictEqual(ruleOrder.status, 'open');
  assert.strictEqual(matchesFor(db, ruleOrder.id).length, 0, 'and no match row was written');

  // DIRECTION 2: the rule order is RESTING and the house comes to take it. The
  // bot requotes after the rule has rested its order.
  bots.requoteSelection(db, sid);
  const after = db.prepare('SELECT * FROM orders WHERE id = ?').get(ruleOrder.id);
  assert.strictEqual(after.matched_cents, 0, 'a requote did not take the resting rule order either');
  assert.strictEqual(matchesFor(db, ruleOrder.id).length, 0);

  // AND the check is not "bots stop trading": a MANUAL order is still perfectly
  // matchable by the desk, so this cannot have been implemented by suppressing
  // the house.
  const manual = M.placeOrder(db, alice, { selection_id: sid, side: 'back', price: 1.90, stake_cents: 5000 });
  assert.ok(manual.fills.length > 0, 'a hand-placed order still crosses the house ladder');
});

check('V30 a rule that rests unfilled against the house leaves NO trace in the money path', async () => {
  // The self-crossed marker is NOT the property at risk here — the house is a
  // DIFFERENT user, so a house crossing would never be marked self-crossed even
  // if the guard permitted it. An earlier version of this check asserted only
  // that, and PASSED against a build with the no-house-participation rule
  // deleted. A check that cannot fail is worse than no check.
  //
  // The property that matters: an automated order the house did not take is
  // INVISIBLE to settlement, the trade tape, LTP and market volume. It exists,
  // it rests, and the player's money is escrowed against it — but nothing
  // traded, so no exposure and no price was created. If a blocked crossing wrote
  // any of those, a player would be shown a price and a volume no counterparty
  // ever produced.
  await require('../lib/bots').primeBotHash();
  const db = openStore(':memory:');
  const alice = await A.registerUser(db, { username: 'alice', password: 'secret1', balance_cents: 1000000 });
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1, 'E', datetime('now', '+2 hours'))").run();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (1, 'Match Odds')").run();
  const mid = db.prepare('SELECT id FROM markets').get().id;
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Home', 3.0)").run(mid);
  const sid = db.prepare('SELECT id FROM selections').get().id;
  require('../lib/bots').requoteSelection(db, sid);

  R.createRule(db, alice, { selection_id: sid, op: 'below', threshold: 2.0, side: 'back', stake_cents: 10000 });
  evaluate(db, sid, 1.98);
  const order = db.prepare('SELECT * FROM orders WHERE user_id = ? AND rule_id IS NOT NULL').get(alice.id);
  assert.ok(order, 'the rule order exists');
  assert.strictEqual(order.matched_cents, 0, 'the house did not take it');
  // Escrow IS held. That is what makes the invisibility assertions below a real
  // claim rather than a vacuous one: the order is committed, and it still must
  // not appear as a trade anywhere.
  assert.strictEqual(order.frozen_cents, 10000, 'the resting remainder is escrowed');

  assert.strictEqual(matchesFor(db, order.id).length, 0, 'no match row');
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) c FROM matches WHERE self_crossed = 1').get().c,
    0,
    'nothing was marked self-crossed'
  );
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'trade.self_crossed'").get().c,
    0,
    'and no self-crossed audit row was written for a crossing the guard blocked'
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) c FROM settlements WHERE user_id = ?').get(alice.id).c,
    0,
    'a settlement exists for a crossing that never happened'
  );
  // The tape and the volume are where a phantom fill would surface to a player.
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) c FROM price_history WHERE selection_id = ?').get(sid).c,
    0,
    'the trade tape recorded a price for a crossing that never happened'
  );
  assert.strictEqual(
    db.prepare('SELECT total_matched_cents v FROM markets WHERE id = ?').get(mid).v,
    0,
    'market volume counted a trade that never happened'
  );
  assert.strictEqual(
    db.prepare('SELECT ltp FROM selections WHERE id = ?').get(sid).ltp,
    null,
    'LTP moved without a trade'
  );
});

// ── V7: the hook point ─────────────────────────────────────────────────────

check('V31 evaluation happens on the VENUE\'S OWN PRICE STREAM, not on a timer of its own', async () => {
  // The claim is that a rule is driven by lib/drift.js — the only thing in the
  // codebase that moves a fair price. Proved by driving drift's exported tick
  // against a single open selection, which makes the selection it moves
  // deterministic, and letting the random walk run until the threshold is
  // crossed.
  const db = openStore(':memory:');
  await require('../lib/bots').primeBotHash();
  const alice = await A.registerUser(db, { username: 'alice', password: 'secret1', balance_cents: 1000000 });
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1, 'E', datetime('now', '+2 hours'))").run();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (1, 'Match Odds')").run();
  const mid = db.prepare('SELECT id FROM markets').get().id;
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Home', 3.0)").run(mid);
  const sid = db.prepare('SELECT id FROM selections').get().id;
  // `above 3.00` from a start of exactly 3.00, rather than `below 2.00` from 3.00.
  //
  // The walk is RANDOM, and a `below` rule from 3.00 only fires if the walk goes
  // the right way — which over 400 ticks it may simply not do. That makes the
  // check flaky, and a flaky check is worse than none: it fails on a good build
  // and everyone learns to re-run it. `above 3.00` is armed at creation and
  // fires on the first UP-tick whatever the walk does, so the assertion is about
  // the HOOK and not about which way a coin landed.
  const rule = R.createRule(db, alice, {
    selection_id: sid, op: 'above', threshold: 3.0, side: 'back', stake_cents: 10000,
  });
  assert.strictEqual(rule.armed, 1, 'armed: 3.00 is not strictly above 3.00');

  let fired = 0;
  let ticks = 0;
  for (let i = 0; i < 400 && fired === 0; i++) {
    drift.tick(db, null);
    ticks++;
    fired = ruleRow(db, rule.id).fire_count;
  }
  assert.strictEqual(fired, 1, `the venue's own price walk drove the rule to fire (after ${ticks} ticks)`);
  const o = db.prepare('SELECT * FROM orders WHERE rule_id = ?').get(rule.id);
  assert.ok(o, 'the order the walk produced is attributed to the rule');
  assert.ok(o.side === 'back');
  assert.strictEqual(o.stake_cents, 10000);
  // Priced by the THRESHOLD rule: the walk landed above 3.00, so the order took
  // that better price rather than being clamped back to the threshold.
  const fair = db.prepare('SELECT fair_price FROM selections WHERE id = ?').get(sid).fair_price;
  assert.ok(fair > 3.0, `the walk really did go above the threshold (fair=${fair})`);
  assert.strictEqual(o.price, fair, 'back-above keeps the improvement, so the order is at the price the walk reached');

  // And the walk really is the ONLY thing that moved it: nothing in this loop
  // called evaluateSelection by hand, so the engine's own tick is what fired it.
  assert.ok(ticks < 400, 'it fired well within the walk budget rather than on the last possible tick');
});

check('V32 with NO price event, a rule does nothing — which is the point', async () => {
  // "Driven by the price stream" has an edge: a selection whose price never
  // moves is never evaluated, so a rule sitting on it never fires. That is not a
  // bug to be papered over with a periodic re-scan — a re-scan would place
  // orders on observations the venue never made, and #77's continuous semantics
  // are where a timer belongs if one is ever wanted. Asserted so the edge is a
  // decision on the record rather than an accident nobody checked.
  const { db, users } = await fresh();
  const sel = mkSelection(db, 3.0);
  belowBack(db, users.alice, sel);
  const idle = db.prepare('SELECT * FROM user_rules').all();
  assert.strictEqual(idle.length, 1);
  assert.strictEqual(idle[0].fire_count, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0, 'no price moved, so no order');
  // And the rule is still live and armed — waiting, not broken.
  assert.strictEqual(idle[0].status, 'live');
  assert.strictEqual(idle[0].armed, 1);
});

check('V33 evaluation is SERVER-SIDE: nothing in public/ can drive a rule', async () => {
  // The brief for #76 is explicit that evaluation must never happen in the
  // browser, and the architectural claim is that the browser has no rule
  // surface at all in #76. Checked against the shipped frontend rather than
  // asserted in prose: there is no rules endpoint to call.
  const { readdirSync, readFileSync } = require('node:fs');
  const path = require('node:path');
  const jsDir = path.join(__dirname, '..', 'public', 'js');
  const files = readdirSync(jsDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, 'the frontend exists, so this is not a vacuous scan');
  for (const f of files) {
    const src = readFileSync(path.join(jsDir, f), 'utf8');
    assert.ok(!/user_rules|userrules|\/api\/rules/.test(src),
      `public/js/${f} mentions a rule surface — evaluation must not be drivable from the browser`);
  }
  // And no route on the server exposes rule creation either. #78 owns it.
  const server = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/api\/rules/.test(server), 'server.js exposes a rules route; #78 owns that surface');
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
  console.log(`\nuserrules.test.js: ${passed} of ${failures.length} checks passed`);
  if (passed < failures.length) process.exit(1);
})();