// marketversion.test.js — the book-version handshake on placement (#92).
//
// Run: node tests/marketversion.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. Before #92 the venue had no version at all: a client
// that read a ladder and sent an order had it placed at whatever the ladder
// said by the time the request arrived, answered 201, and could not tell
// "accepted and did not match" from "accepted at a price I did not intend".
//
// WHAT IT IS DELIBERATELY NOT ABOUT. `snapToTick` still corrects an off-ladder
// price silently, and #37 fixed the validation branch around it. That is
// correct. The missing thing was the version HANDSHAKE, and nothing in here
// changes, re-litigates or weakens the snapping behaviour — MV8 pins that it is
// untouched, so this file cannot be read as having quietly altered it.
//
// EVERY CHECK HERE ASSERTS A PRE-STATE. The failure mode this repository keeps
// paying for is a check that would pass if the code did nothing, so each one
// either shows the version at 0 before the action, or shows that the action
// could not have happened without the code under test running. The concurrency
// check (MV6) additionally asserts that exactly one of two processes placed an
// order, which a no-op implementation would fail by placing zero.
//
// THE HARNESS DOES NOT EXIT ON FIRST FAILURE. Every check is drained in order
// and every failure is reported, so one broken expectation cannot hide the
// twelve behind it.
'use strict';

// Pin the money knobs before anything loads lib/config, so an ambient .env can
// never change what these examples assert. SCRYPT_N is lowered because this
// suite creates several accounts; it asserts nothing about the stored hash.
process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const BV = require('../lib/bookversion');
const INPLAY = require('../lib/inplay');
const config = require('../lib/config');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
const failures = [];
const checks = [];
const check = async (name, fn) => { checks.push([name, fn]); };

// The threshold this suite is written against. Read, not hard-coded into the
// expectations, so a change to the DEFAULT moves the boundary assertions with
// it instead of quietly turning them into something else. (The boundary is also
// pinned explicitly in MV4, which does not depend on this.)
const T = config.MARKET_VERSION_MATERIAL_THRESHOLD;

let evCounter = 0;

// A market with two runners and four funded players.
async function fixture() {
  const db = openStore(':memory:');
  const mk = (name) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: 1000000 });
  let sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  if (!sport) {
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football','football')").run();
    sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  }
  evCounter++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now','+2 hours'))")
    .run(sport.id, `MV Event ${evCounter}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`MV Event ${evCounter}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const marketId = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id).id;
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Alpha', 2.0)").run(marketId);
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Beta', 2.4)").run(marketId);
  const s1 = db.prepare("SELECT id FROM selections WHERE market_id = ? AND name='Alpha'").get(marketId).id;
  const s2 = db.prepare("SELECT id FROM selections WHERE market_id = ? AND name='Beta'").get(marketId).id;
  return {
    db,
    marketId,
    s1,
    s2,
    users: {
      alice: await mk('alice'),
      bob: await mk('bob'),
      carol: await mk('carol'),
      dave: await mk('dave'),
    },
  };
}

const selVersion = (db, id) => BV.selectionVersion(db, id);
const mktVersion = (db, id) => BV.marketVersion(db, id);
const orderCount = (db, marketId) =>
  db.prepare('SELECT COUNT(*) c FROM orders WHERE market_id = ?').get(marketId).c;
const matchCount = (db, marketId) =>
  db.prepare('SELECT COUNT(*) c FROM matches WHERE market_id = ?').get(marketId).c;

// N consecutive fills ON THE SAME SELECTION, each one a real order placement
// that really matched. This is how the boundary tests move the version by a
// known amount without hand-writing a counter, so "the version advanced by 2"
// is an observation about the engine rather than a fixture.
function fillNTimes(f, n) {
  for (let i = 0; i < n; i++) {
    // A fresh counterparty each time, so no self-match guard and no exhausted
    // balance can turn a fill into something else.
    M.placeOrder(f.db, f.users.dave, { selection_id: f.s1, side: 'back', price: 2.0, stake_cents: 1000 });
    M.placeOrder(f.db, f.users.bob, { selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 1000 });
  }
}

// Move the version by exactly one, without a fill, by cancelling.
function cancelOnce(f) {
  const o = M.placeOrder(f.db, f.users.carol, { selection_id: f.s2, side: 'back', price: 3.0, stake_cents: 1000 }).order;
  M.cancelOrder(f.db, f.users.carol, o.id);
}

// ── MV1 ─────────────────────────────────────────────────────────────────────
// The version exists, starts at zero, and is READABLE where a client reads a
// book. Without this, every other check here could pass against a version that
// is written but never exposed.
check('MV1 the book carries a version per selection and per market, starting at 0', async () => {
  const f = await fixture();
  // Pre-state: nothing has traded and nothing has been cancelled.
  assert.strictEqual(f.db.prepare('SELECT COUNT(*) c FROM matches').get().c, 0, 'the fixture must start with an empty book');
  assert.strictEqual(selVersion(f.db, f.s1), 0, 'a fresh selection must be at version 0');
  assert.strictEqual(mktVersion(f.db, f.marketId), 0, 'a fresh market must be at version 0');

  const book = M.bookFor(f.db, f.marketId);
  const alpha = book.find((s) => s.selection_id === f.s1);
  assert.ok(alpha, 'Alpha must appear in the book');
  assert.strictEqual(alpha.version, 0, 'the version must be ON the book a client reads, not only in the database');
  // The book shape is otherwise untouched — MV8 is the deeper pin on that, but
  // a new field that displaced an existing one would break every reader.
  for (const k of ['selection_id', 'name', 'status', 'ltp', 'back', 'lay']) {
    assert.ok(k in alpha, `the existing book field ${k} must survive the new one`);
  }
});

// ── MV2 ─────────────────────────────────────────────────────────────────────
// A FILL bumps it. One placement that matched, one bump — not one per fill and
// not one per order row.
check('MV2 a fill bumps both the selection and the market version', async () => {
  const f = await fixture();
  assert.strictEqual(selVersion(f.db, f.s1), 0, 'precondition: 0');
  assert.strictEqual(mktVersion(f.db, f.marketId), 0, 'precondition: 0');

  M.placeOrder(f.db, f.users.dave, { selection_id: f.s1, side: 'back', price: 2.0, stake_cents: 1000 });
  // The backer matched NOTHING — a book with no liquidity — so this placement
  // did not move the book and must not have moved the version. Asserting the
  // negative here is what stops the next assertion meaning "the version always
  // goes up by one when somebody places an order".
  assert.strictEqual(matchCount(f.db, f.marketId), 0, 'precondition: nothing matched yet');
  assert.strictEqual(selVersion(f.db, f.s1), 0, 'an order that merely RESTS must not bump the version');
  assert.strictEqual(mktVersion(f.db, f.marketId), 0, 'nor the market');

  const r = M.placeOrder(f.db, f.users.bob, { selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 1000 });
  assert.strictEqual(r.fills.length, 1, 'precondition: this one really matched');
  assert.strictEqual(matchCount(f.db, f.marketId), 1);
  assert.strictEqual(selVersion(f.db, f.s1), 1, 'a fill must bump the selection version');
  assert.strictEqual(mktVersion(f.db, f.marketId), 1, 'and the market version, which is the vector over its selections');
  // The OTHER runner is untouched: a market-wide bump on every fill would make
  // the per-selection version useless to a ladder client, because activity on
  // Beta is not a change to Alpha's ladder.
  assert.strictEqual(selVersion(f.db, f.s2), 0, 'a fill on one runner must not bump its sibling');
});

// ── MV3 ─────────────────────────────────────────────────────────────────────
// A CANCEL bumps it, and a cancellation that changed nothing does not.
check('MV3 a cancel bumps the selection version; a refused cancel bumps nothing', async () => {
  const f = await fixture();
  const before = selVersion(f.db, f.s2);
  cancelOnce(f);
  assert.strictEqual(selVersion(f.db, f.s2), before + 1, 'a cancel removes size somebody was reading');
  assert.strictEqual(mktVersion(f.db, f.marketId), before + 1, 'and the market version follows');

  // Cancelling it twice: the second is refused by validateOrderTx before any
  // write, so it must not advance the counter. This is the pre-state assertion
  // that makes "a cancel bumps" mean something — a bump on every call would
  // pass the first half and fail here.
  const alreadyCancelled = f.db
    .prepare("SELECT id FROM orders WHERE user_id = ? AND status='cancelled'")
    .get(f.users.carol.id).id;
  let second = null;
  try { M.cancelOrder(f.db, f.users.carol, alreadyCancelled); } catch (e) { second = e; }
  assert.ok(second, 'cancelling a cancelled order must refuse');
  assert.strictEqual(second.status, 400);
  assert.strictEqual(selVersion(f.db, f.s2), before + 1, 'a cancel of an already-cancelled order must not bump again');

  let err = null;
  try { M.cancelOrder(f.db, f.users.carol, 999999); } catch (e) { err = e; }
  assert.ok(err, 'a cancel of an order that does not exist must refuse');
  assert.strictEqual(selVersion(f.db, f.s2), before + 1, 'and must not bump either');
});

// ── MV4 ─────────────────────────────────────────────────────────────────────
// THE BOUNDARY. This is the check the issue asks for by name: the materiality
// threshold asserted AT ITS BOUNDARY rather than merely somewhere inside it.
//
// THE SEMANTIC BEING PINNED, stated precisely because "threshold" is otherwise
// ambiguous by one:
//
//   MARKET_VERSION_MATERIAL_THRESHOLD is the number of book-altering events a
//   client may be BEHIND and still be accepted. So a drift of exactly T is
//   ACCEPTED and a drift of T + 1 is REFUSED.
//
// Both halves are asserted, and only with both can a defect be caught: a check
// that only asserted the refusal would also pass against an implementation that
// refused everything including drift 0, and one that only asserted the
// acceptance would pass against an implementation that never checked.
check('MV4 the materiality threshold is asserted AT ITS BOUNDARY, both sides', async () => {
  const f = await fixture();
  const claimed = selVersion(f.db, f.s1);
  assert.strictEqual(claimed, 0, 'precondition: a fresh selection reads 0');
  // Liquidity, so the fills below really fill.
  M.placeOrder(f.db, f.users.dave, { selection_id: f.s1, side: 'back', price: 2.0, stake_cents: 40000 });

  // EXACTLY at the threshold: tolerated. (T is 2, so this is two fills.)
  fillNTimes(f, T);
  assert.strictEqual(
    selVersion(f.db, f.s1) - claimed, T,
    `the book must be exactly ${T} event(s) ahead of the claim for the boundary to mean anything`
  );
  const accepted = M.placeOrder(f.db, f.users.alice, {
    selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 1000, selection_version: claimed,
  });
  assert.ok(accepted.order.id, `a drift of exactly ${T} is INSIDE the threshold and must be ACCEPTED`);

  // ONE PAST the threshold: refused. The drift is re-derived from the database
  // rather than assumed, so the accepted order above — which matched, and so
  // bumped the version once itself — cannot make this half pass for the wrong
  // reason.
  const nowAt = selVersion(f.db, f.s1);
  const driftNow = nowAt - claimed;
  assert.ok(driftNow > T, `the book must now be past the threshold; drift is ${driftNow}`);
  const claimsToMake = nowAt - (T + 1);
  assert.ok(claimsToMake >= 0, `the fixture must be able to reach a claim exactly ${T + 1} behind; got ${nowAt}`);
  let err = null;
  try {
    M.placeOrder(f.db, f.users.alice, {
      selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 1000, selection_version: claimsToMake,
    });
  } catch (e) { err = e; }
  assert.ok(err, `a drift of ${T + 1} — one past the threshold — must be REFUSED`);
  assert.strictEqual(err.status, 409, 'and refused as a Conflict — the order is well formed, the book moved');
  assert.strictEqual(err.details.code, BV.STALE, 'with the distinct machine-readable code, not a generic 409');
  assert.strictEqual(err.details.threshold, T, 'the refusal must state the threshold that decided it');
  assert.strictEqual(err.details.drift, T + 1, 'and how far behind the claim was');
  assert.strictEqual(
    err.details.current_version - err.details.supplied_version, T + 1,
    'drift, current and supplied must agree'
  );
  assert.strictEqual(err.details.scope, 'selection', 'and which scope to re-read');
});

// ── MV5 ─────────────────────────────────────────────────────────────────────
// OMITTING THE VERSION PRESERVES TODAY'S BEHAVIOUR EXACTLY. A hard
// compatibility requirement, so it is asserted as behaviour and not inferred
// from the code: a request with no version fields, and one with them explicitly
// null, both place exactly as they did before the feature existed.
//
// The "before" half is not a memory of the old behaviour — it is the SAME
// request made twice, once with a version that is current and once with none,
// and the two must be indistinguishable in what they leave behind.
check('MV5 omitting the version preserves today\'s behaviour exactly', async () => {
  const f = await fixture();
  const base = { selection_id: f.s1, side: 'lay', price: 3.0, stake_cents: 1000 };

  // A RESTING order first, so the two placements below both actually match and
  // the comparison is between two real trades rather than two no-ops.
  M.placeOrder(f.db, f.users.dave, { selection_id: f.s1, side: 'back', price: 3.0, stake_cents: 4000 });

  // (a) no version fields at all.
  const plain = M.placeOrder(f.db, f.users.alice, base);
  // (b) both fields explicitly null — the JSON shape a client sends when it has
  // a null in hand rather than an absent key.
  const nulled = M.placeOrder(f.db, f.users.bob, { ...base, selection_version: null, market_version: null });
  // (c) an EXPLICITLY CURRENT version — the same request with the handshake on.
  const withVersion = M.placeOrder(f.db, f.users.carol, {
    ...base, selection_version: selVersion(f.db, f.s1), market_version: mktVersion(f.db, f.marketId),
  });

  for (const [label, r] of [['omitted', plain], ['null', nulled], ['current version', withVersion]]) {
    assert.ok(r.order.id, `${label}: must place`);
    assert.strictEqual(r.fills.length, 1, `${label}: must fill identically`);
    assert.strictEqual(r.order.price, 3.0, `${label}: at the price asked for`);
    assert.strictEqual(r.order.matched_cents, 1000, `${label}: for the size asked for`);
    assert.strictEqual(r.order.status, 'fully_matched', `${label}: and the same terminal state`);
  }
  // And the money came from the right place each time, which is the part that
  // would actually break an existing caller.
  for (const u of [f.users.alice, f.users.bob, f.users.carol]) {
    const row = f.db.prepare('SELECT balance_cents b, frozen_cents fz FROM users WHERE id = ?').get(u.id);
    assert.strictEqual(row.fz, 2000, 'a matched LAY of 1000 @ 3.0 leaves exactly (3-1)*1000 frozen');
  }
});

// ── MV6 ─────────────────────────────────────────────────────────────────────
// CONCURRENCY. Two OS PROCESSES, one database file, one barrier.
//
// WHY A CHILD PROCESS AND NOT TWO CALLS. node:sqlite is SYNCHRONOUS and this
// codebase is single-threaded, so a second `placeOrder` in this process cannot
// begin until the first has returned — it is not a race, it is a queue. The
// property under test is about two placements that BOTH hold a claim on the
// same book and act on it at the same time, and the only way to express that
// with the engine this repository actually has is two processes against one
// file. This is the same move tests/login-lock-restart.test.js makes, for the
// same reason.
//
// WHAT IT PROVES, precisely. Both children read the selection's version, then
// wait on a barrier the parent releases at the same moment for both. Each then
// submits the version it read. Exactly ONE placement may succeed; every other
// must be refused with `market_version_stale`. The check is run with the
// threshold at 0 so "at most threshold+1 succeed" is "exactly one".
//
// WHAT IT ALSO ASSERTS, which is what stops it being satisfied by a control that
// simply refuses everybody: that one order really was placed, that the version
// advanced by exactly one, and that the loser wrote nothing at all.
const CHILD = `
process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
// The threshold is PINNED TO 0 in the child, so this check is about the check
// and not about the default. Read before anything loads lib/config.
process.env.MARKET_VERSION_MATERIAL_THRESHOLD = '0';
const fs = require('fs');
const { openStore } = require(${JSON.stringify(path.join(ROOT, 'lib/store.js'))});
const M = require(${JSON.stringify(path.join(ROOT, 'lib/match.js'))});
const BV = require(${JSON.stringify(path.join(ROOT, 'lib/bookversion.js'))});

const dbPath = process.argv[1];
const userId = Number(process.argv[2]);
const selectionId = Number(process.argv[3]);
const stake = Number(process.argv[4]);
const readyPath = process.argv[5];
const goPath = process.argv[6];

const db = openStore(dbPath);
// "THE CLIENT READ THE LADDER." Read BEFORE the barrier, so this claim is
// genuinely held across the other process's placement rather than being
// re-derived afterwards — which is the whole point of the race.
const claimed = BV.selectionVersion(db, selectionId);
fs.writeFileSync(readyPath, String(claimed));
const deadline = Date.now() + 30000;
while (!fs.existsSync(goPath)) {
  if (Date.now() > deadline) { console.error('child: barrier never released'); process.exit(3); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
let out;
try {
  const r = M.placeOrder(db, { id: userId }, { selection_id: selectionId, side: 'lay', price: 2.0, stake_cents: stake, selection_version: claimed });
  out = { claimed, ok: true, order_id: r.order.id, fills: r.fills.length };
} catch (e) {
  out = { claimed, ok: false, status: e.status || null, code: (e.details && e.details.code) || null, message: e.message };
}
console.log('MVREPORT ' + JSON.stringify(out));
// exitCode, NOT process.exit(): stdout to a pipe is asynchronous in node, and
// process.exit() can truncate a pending write — which would show up as "the
// child produced no report" and send a reader looking for an engine bug. The
// database handle holds nothing open, so the process exits on its own once the
// write has drained.
process.exitCode = 0;
`;

function runRace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obx-mv-race-'));
  const dbPath = path.join(dir, 'race.db');
  // Both children must open the SAME bytes, so the parent builds the fixture in
  // a file rather than in :memory: — an in-memory database dies with the process
  // that created it, and the race would pass for the wrong reason.
  const db = openStore(dbPath);
  const seed = async () => {
    const mk = (name) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: 1000000 });
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football','football')").run();
    const sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
    assert.ok(sport, 'precondition: the sport row the event hangs off must exist');
    db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, 'Race', datetime('now','+2 hours'))").run(sport.id);
    const ev = db.prepare("SELECT id FROM events WHERE name='Race'").get();
    db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
    const marketId = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id).id;
    db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Alpha', 2.0)").run(marketId);
    const selectionId = db.prepare('SELECT id FROM selections WHERE market_id = ?').get(marketId).id;
    // A resting BACK big enough for BOTH contenders to fill. Every successful
    // placement therefore produces a fill, and every fill bumps the version —
    // which is what makes "exactly one succeeded" the right expectation rather
    // than "at most one": a placement that merely rested would bump nothing and
    // both would legitimately be allowed.
    const filler = await mk('filler');
    M.placeOrder(db, filler, { selection_id: selectionId, side: 'back', price: 2.0, stake_cents: 40000 });
    // …and a WARM-UP fill, so the version the racers will claim is already
    // above zero. Without it the racers would claim version 0 and a
    // "the fixture must be able to prove the control fires" precondition could
    // not distinguish a working control from one that had never been exercised.
    const warmup = await mk('warmup');
    M.placeOrder(db, warmup, { selection_id: selectionId, side: 'lay', price: 2.0, stake_cents: 1000 });
    return {
      db, marketId, selectionId,
      users: { filler, warmup, one: await mk('racer1'), two: await mk('racer2') },
    };
  };
  return seed().then((raced) => {
    raced.dir = dir;
    raced.dbPath = dbPath;
    return raced;
  });
}

function spawnRacer(dbPath, userId, selectionId, stake, readyPath, goPath) {
  const child = spawn(process.execPath, ['-e', CHILD, dbPath, String(userId), String(selectionId), String(stake), readyPath, goPath], {
    cwd: ROOT,
    env: { ...process.env, MARKET_VERSION_MATERIAL_THRESHOLD: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let errOut = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { errOut += d; });
  const done = new Promise((resolve) => {
    child.on('close', (status) => resolve({ status, out, errOut }));
  });
  return { child, done };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(file, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${what} never appeared at ${file}`);
    await sleep(10);
  }
}

check('MV6 a CONCURRENT placement cannot bypass the check: two processes, one version, one winner', async () => {
  const raced = await runRace();
  const { db, dbPath, marketId, selectionId, users, dir } = raced;
  try {
    const claimedByParent = selVersion(db, selectionId);
    assert.ok(claimedByParent > 0, 'precondition: the fixture\'s own fill already moved the version');
    const ordersBefore = orderCount(db, marketId);

    const goPath = path.join(dir, 'go');
    const ready1 = path.join(dir, 'ready1');
    const ready2 = path.join(dir, 'ready2');
    const r1 = spawnRacer(dbPath, users.one.id, selectionId, 1000, ready1, goPath);
    const r2 = spawnRacer(dbPath, users.two.id, selectionId, 1000, ready2, goPath);

    // Both children read the version and park on the barrier BEFORE either is
    // released. If either never got there the race below would be sequential,
    // which is the L13 shape the issue explicitly rules out.
    await waitForFile(ready1, 'racer 1 ready');
    await waitForFile(ready2, 'racer 2 ready');
    assert.strictEqual(
      Number(fs.readFileSync(ready1, 'utf8')),
      Number(fs.readFileSync(ready2, 'utf8')),
      'both racers must have read the SAME version, or there is no race to lose'
    );

    fs.writeFileSync(goPath, 'go');
    const [c1, c2] = await Promise.all([r1.done, r2.done]);

    const report = (c, who) => {
      const line = String(c.out || '').split('\n').filter((l) => l.startsWith('MVREPORT ')).pop();
      assert.ok(line, `${who} produced no report (exit ${c.status}): ${String(c.errOut || '').slice(0, 500)}`);
      return JSON.parse(line.slice('MVREPORT '.length));
    };
    const a = report(c1, 'racer 1');
    const b = report(c2, 'racer 2');

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);

    // EXACTLY ONE. "At most one" would also be satisfied by an implementation
    // that refuses every versioned order, and "at least one" by one that
    // ignores the claim — this assertion is what forces both halves at once.
    assert.strictEqual(
      winners.length, 1,
      `exactly one of the two concurrent placements must be accepted at threshold 0; got ${winners.length} (${JSON.stringify([a, b])})`
    );
    assert.strictEqual(winners[0].fills, 1, 'the winner really matched — a rest would not have bumped anything');

    assert.strictEqual(losers.length, 1, 'the other must have been refused');
    assert.strictEqual(losers[0].status, 409, 'with 409 Conflict, not a 500 and not a silent accept');
    assert.strictEqual(losers[0].code, BV.STALE, 'and with the distinct machine-readable code');

    // The refusal left NOTHING. The version advanced by exactly the winner's
    // one fill, the database holds exactly one new order and exactly one new
    // match, and the loser has no row at all. This is the half that would catch
    // an implementation which compared correctly but still wrote the order.
    assert.strictEqual(
      selVersion(db, selectionId),
      claimedByParent + 1,
      `the refused concurrent placement must not have advanced the version; expected ${claimedByParent + 1}, got ${selVersion(db, selectionId)}`
    );
    assert.strictEqual(
      orderCount(db, marketId), ordersBefore + 1,
      'exactly one new order row — a refused placement must write none'
    );
    assert.strictEqual(
      matchCount(db, marketId), 2,
      'exactly one new match (the fixture placed one); the loser must have matched nothing'
    );
    const loserRows = db
      .prepare('SELECT COUNT(*) c FROM orders WHERE user_id IN (?, ?) AND market_id = ?')
      .get(users.one.id, users.two.id, marketId).c;
    assert.strictEqual(loserRows, 1, 'and only the WINNER of the two racers has an order row');
  } finally {
    for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* not created */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

// ── MV7 ─────────────────────────────────────────────────────────────────────
// THE CLIENT'S VIEW OF THE FAILURE. A client that re-reads and resubmits with
// the version it was just given is trading normally one round-trip later — the
// whole point of a handshake is that recovering from a refusal is cheap.
check('MV7 a refused client recovers on the next attempt with the version it was handed', async () => {
  const f = await fixture();
  M.placeOrder(f.db, f.users.dave, { selection_id: f.s1, side: 'back', price: 2.0, stake_cents: 20000 });
  const stale = selVersion(f.db, f.s1);
  fillNTimes(f, T + 1);
  assert.ok(
    selVersion(f.db, f.s1) - stale > T,
    `precondition: the book must have moved beyond the threshold; moved ${selVersion(f.db, f.s1) - stale}`
  );

  // Threshold 2 by default, so one event is tolerated. Drive it past the
  // threshold deterministically rather than depending on the default here.
  const claim = selVersion(f.db, f.s1) - (T + 1);
  assert.ok(claim >= 0, 'the fixture must be able to construct a claim beyond the threshold');
  let refused = null;
  try {
    M.placeOrder(f.db, f.users.alice, { selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 1000, selection_version: claim });
  } catch (e) { refused = e; }
  assert.ok(refused, 'a claim beyond the threshold must be refused');
  // THE RECOVERY. The refusal carries `current_version`, so the client does not
  // even need a second request to know what to send.
  const recovered = M.placeOrder(f.db, f.users.alice, {
    selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 1000,
    selection_version: refused.details.current_version,
  });
  assert.ok(recovered.order.id, 'resubmitting with the version from the refusal must place');
  assert.strictEqual(recovered.fills.length, 1, 'and must actually match — the book is liquid');
  assert.strictEqual(
    selVersion(f.db, f.s1),
    refused.details.current_version + 1,
    'that fill bumps the version again, so the next claim has to be re-read too'
  );
});

// ── MV8 ─────────────────────────────────────────────────────────────────────
// SNAPPING IS UNCHANGED. #37 fixed the validation branch around `snapToTick`,
// and `GET /api/format/:price` documents the correction. The version handshake
// is a different thing and must not have quietly changed it — this pins that a
// versioned order with an off-ladder price still SNAPS rather than refusing.
check('MV8 a versioned order still SNAPS an off-ladder price rather than refusing it', async () => {
  const f = await fixture();
  const version = selVersion(f.db, f.s1);
  const r = M.placeOrder(f.db, f.users.alice, {
    selection_id: f.s1, side: 'back', price: 2.013, stake_cents: 1000, selection_version: version,
  });
  assert.ok(r.order.id, 'must still place');
  // 2.013 sits in the gap between the 1.01–2.00 and 2.02–3.00 bands, so
  // snapToTick rounds it UP to the band edge. The exact value is lib/odds.js's
  // to decide; what is pinned here is that it was corrected and not refused.
  assert.ok(Math.abs(r.order.price - 2.013) > 1e-9, `the price must have been corrected, got ${r.order.price}`);
  assert.strictEqual(
    r.order.price,
    require('../lib/odds').snapToTick(2.013),
    'and corrected to the same tick lib/odds.js names — the engine and the docs agree'
  );
  // The price was corrected rather than refused, so the version handshake and
  // the snap are independent controls: an order that merely RESTS is accepted
  // on a current claim and does not move the version.
  assert.strictEqual(selVersion(f.db, f.s1), version, 'an order that rests must not bump the version');
  assert.strictEqual(
    r.order.matched_cents, 0,
    'precondition: this order rested — there was no liquidity to match against'
  );
});

// ── MV9 ─────────────────────────────────────────────────────────────────────
// A MALFORMED CLAIM IS A 400, NOT A SILENT PASS.
//
// This is the quiet way the control dies. `drift` is a subtraction; if a string
// slipped through, `current - "5"` is NaN, and `NaN > threshold` is false — so a
// client sending `"5"` instead of `5` would be waved through forever with the
// control believing it ran.
check('MV9 a malformed version is refused as a 400, never silently ignored', async () => {
  const f = await fixture();
  for (const bad of ['5', 2.5, -1, true, [], { v: 1 }]) {
    for (const field of ['selection_version', 'market_version']) {
      let err = null;
      try {
        M.placeOrder(f.db, f.users.alice, { selection_id: f.s1, side: 'lay', price: 3.0, stake_cents: 1000, [field]: bad });
      } catch (e) { err = e; }
      assert.ok(err, `${field}=${JSON.stringify(bad)} must be refused`);
      assert.strictEqual(err.status, 400, `${field}=${JSON.stringify(bad)} must be a 400, got ${err.status}`);
      assert.ok(/non-negative integer/.test(err.message), `${field}=${JSON.stringify(bad)}: ${err.message}`);
    }
  }
  // And the proof the loop above cannot be satisfied by refusing everything: a
  // well-formed claim on an unmoved book still places.
  const ok = M.placeOrder(f.db, f.users.alice, {
    selection_id: f.s1, side: 'lay', price: 3.0, stake_cents: 1000, selection_version: selVersion(f.db, f.s1),
  });
  assert.ok(ok.order.id, 'a well-formed claim must still be accepted');
});

// ── MV10 ────────────────────────────────────────────────────────────────────
// A SUSPENSION BUMPS THE MARKET VERSION — and only the market version.
//
// The selection half of that matters: `validateOrder` refuses every placement on
// a suspended market with its OWN 409 before this check is reached, so a client
// is told the real reason rather than a version drift, which is worse advice for
// the same fact.
check('MV10 a suspension bumps the market version, and a re-assert of it bumps nothing', async () => {
  const f = await fixture();
  const m0 = mktVersion(f.db, f.marketId);
  const s0 = selVersion(f.db, f.s1);

  INPLAY.setSuspended(f.db, { marketId: f.marketId, suspended: true, reason: 'feed outage' });
  assert.strictEqual(mktVersion(f.db, f.marketId), m0 + 1, 'suspending a market must bump its version');
  assert.strictEqual(selVersion(f.db, f.s1), s0, 'and must NOT bump the runners — the suspension gate already refuses placements');

  INPLAY.setSuspended(f.db, { marketId: f.marketId, suspended: true, reason: 'feed outage' });
  assert.strictEqual(
    mktVersion(f.db, f.marketId), m0 + 1,
    're-issuing the suspension a market is already under changes nothing a client can read, so it must not bump'
  );

  // Resuming opens the book again: a client holding a pre-suspension version is
  // genuinely trading against a book it has not seen.
  INPLAY.setSuspended(f.db, { marketId: f.marketId, suspended: false });
  assert.strictEqual(mktVersion(f.db, f.marketId), m0 + 2, 'a resumption is a change too');

  // Drive the drift PAST the threshold so the client-side half below is a real
  // refusal rather than a tolerated one — cycles are counted, not assumed, so
  // this does not depend on the default being 2.
  let cycles = 2;
  while (mktVersion(f.db, f.marketId) - m0 <= T) {
    INPLAY.setSuspended(f.db, { marketId: f.marketId, suspended: true, reason: 'feed outage' });
    INPLAY.setSuspended(f.db, { marketId: f.marketId, suspended: false });
    cycles += 2;
  }
  assert.ok(cycles > 2, 'precondition: at least one further suspension cycle was needed');

  // And the client-side consequence, end to end: a claim from before the
  // suspension is stale against the market scope.
  let err = null;
  try {
    M.placeOrder(f.db, f.users.alice, { selection_id: f.s1, side: 'lay', price: 3.0, stake_cents: 1000, market_version: m0 });
  } catch (e) { err = e; }
  assert.ok(err, 'a market claim from before the suspension must be refused');
  assert.strictEqual(err.details.code, BV.STALE);
  assert.strictEqual(err.details.scope, 'market', 'and named against the market scope');
  assert.strictEqual(err.details.supplied_version, m0, 'the refusal must echo the claim it refused');
});

// ── MV11 ────────────────────────────────────────────────────────────────────
// THE CLAIM CANNOT RUN AHEAD OF THE VENUE. A version the venue has never
// reached is a number it cannot explain, and accepting one would mean trusting
// the client about the venue's own state — the precise inversion this control
// exists to prevent.
check('MV11 a claim AHEAD of the venue is refused, not honoured', async () => {
  const f = await fixture();
  const current = selVersion(f.db, f.s1);
  assert.strictEqual(current, 0, 'precondition: an unmoved book');
  let err = null;
  try {
    M.placeOrder(f.db, f.users.alice, { selection_id: f.s1, side: 'lay', price: 3.0, stake_cents: 1000, selection_version: current + 5 });
  } catch (e) { err = e; }
  assert.ok(err, 'a version the venue has never reached must be refused');
  assert.strictEqual(err.status, 409);
  assert.strictEqual(err.details.code, BV.STALE);
  assert.ok(err.details.drift < 0, `the refusal must show a NEGATIVE drift, got ${err.details.drift}`);
  // …and a claim that is merely CURRENT is fine, so the rule above is not just
  // "refuse anything that is not zero".
  const ok = M.placeOrder(f.db, f.users.alice, {
    selection_id: f.s1, side: 'lay', price: 3.0, stake_cents: 1000, selection_version: current,
  });
  assert.ok(ok.order.id, 'the current version must be accepted');
});

// ── MV12 ────────────────────────────────────────────────────────────────────
// AN IDEMPOTENT REPLAY IS NOT A STALE ORDER.
//
// The one case where a client's claim is GUARANTEED to be stale: the retry of a
// request that already placed. placeOrderTx answers a known `client_order_id`
// with the order that exists, before it validates anything — so a retry is
// returned rather than refused, and refusing it would turn a retried request
// into a lost order.
check('MV12 a retried idempotent request returns its order rather than refusing it as stale', async () => {
  const f = await fixture();
  const version = selVersion(f.db, f.s1);
  const first = M.placeOrder(f.db, f.users.alice, {
    selection_id: f.s1, side: 'lay', price: 3.0, stake_cents: 1000, client_order_id: 'mv-retry-1', selection_version: version,
  });
  assert.ok(first.order.id, 'the first attempt places');
  assert.strictEqual(first.idempotent_replay, undefined, 'and is not a replay');

  // The book moves, so the client's original claim is now stale.
  fillNTimes(f, 1);
  assert.ok(selVersion(f.db, f.s1) > version, 'precondition: the book really moved');

  const replay = M.placeOrder(f.db, f.users.alice, {
    selection_id: f.s1, side: 'lay', price: 3.0, stake_cents: 1000, client_order_id: 'mv-retry-1', selection_version: version,
  });
  assert.strictEqual(replay.idempotent_replay, true, 'the retry must be answered as a replay');
  assert.strictEqual(replay.order.id, first.order.id, 'returning the SAME order, not placing a second one');
  const rows = f.db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id = ?').get(f.users.alice.id).c;
  assert.strictEqual(rows, 1, 'and the database must hold exactly one order for that client_order_id');
});

// ── MV13 ────────────────────────────────────────────────────────────────────
// A REFUSAL INSIDE THE TRANSACTION MUST LEAVE NO MONEY AND NO AUDIT TRAIL OF
// AN ORDER THAT DOES NOT EXIST. assertVersionsFresh runs before `escrow()`, so
// the claim is that a refusal writes nothing at all — which is a different
// property from "the order is not there", because a rollback that still left a
// ledger posting would be an unrecoverable stranding of a player's funds.
check('MV13 a stale refusal moves no money and writes no order', async () => {
  const f = await fixture();
  const walletBefore = f.db.prepare('SELECT balance_cents b, frozen_cents fz FROM users WHERE id = ?').get(f.users.alice.id);
  const ordersBefore = f.db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id = ?').get(f.users.alice.id).c;
  const txBefore = f.db.prepare("SELECT COUNT(*) c FROM transactions WHERE user_id = ? AND type != 'opening'").get(f.users.alice.id).c;

  fillNTimes(f, T + 1);
  const claim = selVersion(f.db, f.s1) - (T + 1);
  let err = null;
  try {
    M.placeOrder(f.db, f.users.alice, { selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 1000, selection_version: claim });
  } catch (e) { err = e; }
  assert.ok(err, 'precondition: the claim must be beyond the threshold');

  const walletAfter = f.db.prepare('SELECT balance_cents b, frozen_cents fz FROM users WHERE id = ?').get(f.users.alice.id);
  assert.deepStrictEqual(
    { b: walletAfter.b, fz: walletAfter.fz },
    { b: walletBefore.b, fz: walletBefore.fz },
    'a refused placement must move no money and freeze no escrow'
  );
  assert.strictEqual(
    f.db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id = ?').get(f.users.alice.id).c,
    ordersBefore,
    'and must leave no order row'
  );
  assert.strictEqual(
    f.db.prepare("SELECT COUNT(*) c FROM transactions WHERE user_id = ? AND type != 'opening'").get(f.users.alice.id).c,
    txBefore,
    'and no ledger row — an escrow that was taken and not released would strand the player\'s funds'
  );
});

// ── MV14 ────────────────────────────────────────────────────────────────────
// THE THRESHOLD IS CONFIGURATION, NOT A CONSTANT, and a nonsense value refuses
// to boot rather than being silently clamped.
//
// The second half is the one that matters in practice: a threshold that fell
// back to its default because somebody typed `lots` would be a control quietly
// running at a value nobody chose, which is how an operator believes a venue is
// strict when it is not.
check('MV14 the threshold is a validated config key, not a hard-coded constant', async () => {
  const { loadConfig } = require('../lib/config');
  // The default is a NUMBER and it is the one the boundary tests above ran at.
  assert.ok(Number.isInteger(config.MARKET_VERSION_MATERIAL_THRESHOLD), 'the default must be an integer');
  assert.strictEqual(config.MARKET_VERSION_MATERIAL_THRESHOLD, 2, 'and the documented default is 2');

  // It is READABLE from the environment, so an operator can move it.
  const raised = loadConfig(null, { MARKET_VERSION_MATERIAL_THRESHOLD: '7' });
  assert.strictEqual(raised.MARKET_VERSION_MATERIAL_THRESHOLD, 7, 'an operator-set value must be honoured');

  // 0 is legal, and means "refuse on any movement".
  assert.strictEqual(
    loadConfig(null, { MARKET_VERSION_MATERIAL_THRESHOLD: '0' }).MARKET_VERSION_MATERIAL_THRESHOLD,
    0,
    'zero must be accepted — it is the strict end of the range, not a missing value'
  );
  // Nonsense refuses to boot rather than falling back to the default.
  for (const bad of ['lots', '-1', '2.5', '100000']) {
    assert.throws(
      () => loadConfig(null, { MARKET_VERSION_MATERIAL_THRESHOLD: bad }),
      /MARKET_VERSION_MATERIAL_THRESHOLD/,
      `${JSON.stringify(bad)} must be refused at boot`
    );
  }
  // …and an EMPTY value is "unset", not the strictest setting. `Number('') === 0`
  // would otherwise make a bare `MARKET_VERSION_MATERIAL_THRESHOLD=` silently
  // refuse every versioned order, which is a behaviour switch nobody chose.
  assert.strictEqual(
    loadConfig(null, { MARKET_VERSION_MATERIAL_THRESHOLD: '' }).MARKET_VERSION_MATERIAL_THRESHOLD,
    2,
    'an empty value must fall back to the default, not to 0'
  );
  assert.strictEqual(
    loadConfig(null, { MARKET_VERSION_MATERIAL_THRESHOLD: '   ' }).MARKET_VERSION_MATERIAL_THRESHOLD,
    2,
    'and neither must a whitespace-only one'
  );
});

(async () => {
  // Drain in order and report EVERY failure. A harness that exits on the first
  // one leaves everything after it unverified.
  for (const [name, fn] of checks) {
    try {
      await fn();
      passed++;
      console.log('  ok', name);
    } catch (e) {
      failures.push([name, e]);
      console.error(`  FAIL ${name}`);
      console.error('       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e));
    }
  }
  console.log(`\nmarketversion.test.js: ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
})();