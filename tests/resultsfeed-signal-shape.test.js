// tests/resultsfeed-signal-shape.test.js — what a results feed is ALLOWED to say.
//
// Run: node tests/resultsfeed-signal-shape.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. `normaliseSignal` accepted six booleans, carried them
// through, and then tested for content against a list naming two of them. So:
//
//   - `abandoned`, `walkover`, `completed` and `disputed` on their own were
//     DISCARDED as "not a signal", even though they are terminal outcomes;
//   - `completed`/`abandoned`/`walkover` reached lib/voidrules.js unchanged and
//     keyed off nothing there, because `ruleKey` reads `status`. A feed that
//     said "completed, winner 3" was HELD as `unrecognised` — a hold whose
//     recorded reason blamed the provider for a payload the transport had
//     itself already declared valid.
//
// The booleans are NOT removed here. `red_card` and `dead_heat` are read by
// `ruleKey`; `disputed` is read first by `resolve`, ahead of every published
// rule, precisely so a contested outcome cannot be quietly resolved. The fix is
// to normalise the three that are REDUNDANT SPELLINGS of `status` onto the
// field the decision layer actually reads, and to derive the drop test from the
// flag list so a newly added flag cannot be carried-but-not-counted.
//
// Every check here is about the OUTCOME — what the venue does with the signal —
// not about whether a key came out the other side of the normaliser. A test that
// only asserted the shape would pass while the market was still held, which is
// the bug, and while a one-word `{"abandoned": true}` was still being thrown
// away, which is the other half of it.
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
const M = require('../lib/match');
const RF = require('../lib/resultsfeed');
const rules = require('../lib/voidrules');
const acc = require('../lib/accounts');

let passed = 0;
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

let venue = 0;
// A market with real exposure whose event is OFF, which is the only state a
// results feed ever sees: the clock moved, betting closed, a result became
// possible. Built honestly — nothing hand-writes a "has a result" flag.
async function market(sport = 'football') {
  await require('../lib/bots').primeBotHash();
  const db = openStore(':memory:');
  db.prepare('INSERT INTO sports (name, slug) VALUES (?, ?)').run(sport, sport);
  const sp = db.prepare('SELECT id FROM sports WHERE slug=?').get(sport);
  venue++;
  db.prepare(
    "INSERT INTO events (sport_id, name, starts_at, status) VALUES (?, ?, datetime('now','+2 hours'), 'live')"
  ).run(sp.id, `Ev ${venue}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Ev ${venue}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  const ids = [];
  for (const nm of ['Alpha', 'Beta']) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, nm);
    ids.push(db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, nm).id);
  }
  const alice = await A.registerUser(db, {
    username: `alice${venue}`, password: 'pw-alice-123', balance_cents: 100000,
  });
  const bob = await A.registerUser(db, {
    username: `bob${venue}`, password: 'pw-bob-123', balance_cents: 100000,
  });
  // Two sides of one price, so the market holds real money and a void has
  // something to refund.
  M.placeOrder(db, alice, { selection_id: ids[0], side: 'back', price: 2.0, stake_cents: 1000 });
  M.placeOrder(db, bob, { selection_id: ids[0], side: 'lay', price: 2.0, stake_cents: 1000 });
  db.prepare(
    "UPDATE events SET starts_at = datetime('now','-2 hours') WHERE id = (SELECT event_id FROM markets WHERE id = ?)"
  ).run(mkt.id);
  return { db, marketId: mkt.id, alpha: ids[0], beta: ids[1] };
}

// A transport that answers with one scripted body.
function replying(body) {
  return async () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    async text() { return JSON.stringify(body); },
  });
}

const marketRow = (f) => f.db.prepare('SELECT * FROM markets WHERE id=?').get(f.marketId);
const sourceRows = (f) =>
  // better-sqlite3 hands back null-prototype rows; project them so a
  // deepStrictEqual against a plain literal compares values, not prototypes.
  f.db
    .prepare('SELECT decision, rule FROM result_events WHERE market_id=? ORDER BY id')
    .all(f.marketId)
    .map((r) => ({ decision: r.decision, rule: r.rule }));

// ── 1. The flags that were carried and then thrown away ───────────────────

check('S1 every flag the normaliser accepts survives on its own', () => {
  for (const flag of ['dead_heat', 'red_card', 'abandoned', 'walkover', 'completed', 'disputed']) {
    const sig = RF.normaliseSignal({ [flag]: true });
    assert.notStrictEqual(sig, null, `${flag}: true is a statement, not an empty payload`);
    assert.strictEqual(sig[flag], true, `${flag}: true is carried, not reinterpreted`);
  }
  // ...and a flag that asserts nothing is still not a signal. The line is
  // between "the feed stated an outcome" and "the feed stated the absence of
  // one": `{"red_card": false}` names no outcome, so promoting it to one would
  // turn a provider's silence into a HOLD. Nothing is invented either — an
  // absent flag stays absent, which is the distinction the loop exists for.
  assert.strictEqual(RF.normaliseSignal({ red_card: false }), null);
  assert.strictEqual(RF.normaliseSignal({ dead_heat: false }), null);
  assert.ok(!('dead_heat' in RF.normaliseSignal({ status: 'completed', winners: [3] })));
  assert.strictEqual(RF.normaliseSignal({ dead_heat: false, status: 'completed', winners: [3] }).dead_heat, false);
  // Nothing recognisable at all is still nothing.
  assert.strictEqual(RF.normaliseSignal({ vendor: 'acme', junk: 1 }), null);
  assert.strictEqual(RF.normaliseSignal({ winners: [] }), null, 'an empty winner list names nobody');
  assert.strictEqual(RF.normaliseSignal(null), null);
  assert.strictEqual(RF.normaliseSignal([1, 2]), null);
});

check('S2 a dispute is a dispute — the first rule outranks every published one', () => {
  const d = rules.resolve('football', RF.normaliseSignal({ disputed: true }));
  assert.strictEqual(d.decision, rules.HOLD, 'never settled, never guessed');
  assert.strictEqual(d.rule, 'disputed', 'and recorded as the dispute it is');
});

// ── 2. A redundant spelling must reach the layer that reads it ────────────

check('S3 "completed, winner 3" settles; it is not held as unrecognised', () => {
  const sig = RF.normaliseSignal({ completed: true, winners: [3] });
  const d = rules.resolve('football', sig);
  assert.strictEqual(d.decision, rules.SETTLE, `expected a settlement, got ${d.decision}/${d.rule}`);
  assert.strictEqual(d.rule, 'completed', 'under the published rule, not a guess');
  assert.deepStrictEqual(d.winners, [3]);
});

check('S4 an abandonment resolves through the sport rules, not through nothing', () => {
  const plain = rules.resolve('greyhounds', RF.normaliseSignal({ abandoned: true }));
  assert.strictEqual(plain.rule, 'abandoned_other', 'a race abandoned with no non-runner list');
  assert.strictEqual(plain.decision, rules.VOID, 'greyhounds void an abandonment');

  // Same signal, a red card: the modifier must still outrank the plain case,
  // which is the whole point of carrying `red_card` separately.
  const rc = rules.resolve('football', RF.normaliseSignal({ abandoned: true, red_card: true }));
  assert.strictEqual(rc.rule, 'abandoned_after_red_card');
  assert.strictEqual(rc.decision, rules.VOID, 'and football voids an abandonment after a red card');

  // An explicit status outranks the boolean spelling, so a provider that
  // contradicts itself is decided by the field the decision layer reads.
  assert.strictEqual(
    rules.resolve('football', RF.normaliseSignal({ status: 'completed', abandoned: true, winners: [3] })).rule,
    'completed'
  );
});

// ── 3. End to end: what the CONSUMER does with it ─────────────────────────

check('S5 a boolean-spelled outcome settles the market end to end', async () => {
  RF.resetState();
  const f = await market('football');
  const fetcher = RF.createFetcher({
    url: 'https://results.example/v1/outcomes',
    // No `status` anywhere. The provider spells the outcome the short way.
    fetchImpl: replying({ outcomes: [{ market_id: f.marketId, completed: true, winners: [f.alpha] }] }),
  });
  const run = await RF.pollNow(f.db, { fetcher });
  assert.strictEqual(run.applied, 1, 'the outcome was applied, not held');
  assert.strictEqual(run.results[0].outcome, 'settled');
  assert.strictEqual(marketRow(f).status, 'settled');
  // Provenance, so a dispute can be traced to the feed event that caused it.
  assert.deepStrictEqual(sourceRows(f), [{ decision: 'settle', rule: 'completed' }]);
  assert.strictEqual(acc.assertConserved(f.db), 0, 'the books still balance');
});

check('S6 a one-word walkover voids the market and refunds it', async () => {
  RF.resetState();
  const f = await market('football');
  const fetcher = RF.createFetcher({
    url: 'https://results.example/v1/outcomes',
    fetchImpl: replying({ outcomes: [{ market_id: f.marketId, walkover: true }] }),
  });
  const run = await RF.pollNow(f.db, { fetcher });
  assert.strictEqual(run.applied, 1, 'the walkover reached the consumer at all');
  assert.strictEqual(run.results[0].outcome, 'voided', 'football voids a walkover');
  assert.deepStrictEqual(sourceRows(f), [{ decision: 'void', rule: 'walkover' }]);
  // A void is recorded as a SETTLED market whose selections are void — settle.js
  // settles the market and stamps the outcome onto the selections, so asserting
  // `markets.status` would pass on a win too.
  assert.strictEqual(marketRow(f).status, 'settled');
  assert.strictEqual(marketRow(f).winner_selection_id, null, 'and no winner was named');
  const sels = f.db
    .prepare('SELECT status FROM selections WHERE market_id=?')
    .all(f.marketId)
    .map((r) => r.status);
  assert.deepStrictEqual(sels, ['void', 'void'], 'every selection is void');
  // Nobody is left out of pocket: the backer's stake came back in full.
  const alice = f.db.prepare('SELECT balance_cents b FROM users WHERE username = ?').get(`alice${venue}`);
  assert.strictEqual(alice.b, 100000, 'the backer was refunded the whole 10000');
  assert.strictEqual(acc.assertConserved(f.db), 0);
});

check('S7 an abandonment with no winner is RECORDED as a named hold, not dropped', async () => {
  RF.resetState();
  const f = await market('football');
  const fetcher = RF.createFetcher({
    url: 'https://results.example/v1/outcomes',
    fetchImpl: replying({ outcomes: [{ market_id: f.marketId, abandoned: true }] }),
  });
  const run = await RF.pollNow(f.db, { fetcher });
  assert.strictEqual(run.applied, 1, 'the abandonment reached the consumer');
  // Football's `abandoned_other` SETTLES, and a settlement that names no winner
  // is a HOLD — a NAMED one, with a reason an operator can act on.
  assert.strictEqual(run.results[0].outcome, 'held');
  assert.strictEqual(run.results[0].rule, 'abandoned_other_no_winner');
  const row = marketRow(f);
  assert.strictEqual(row.settlement_hold, 1, 'held, and visibly so');
  assert.ok(row.hold_reason && row.hold_reason.length > 0, 'with a recorded reason');
  assert.strictEqual(row.status, 'open', 'a held market is neither settled nor voided');
  assert.deepStrictEqual(sourceRows(f), [{ decision: 'hold', rule: 'abandoned_other_no_winner' }]);
  assert.strictEqual(acc.assertConserved(f.db), 0);
});

check('S8 a signal the transport counted is a signal the venue acted on', async () => {
  RF.resetState();
  const f = await market('football');
  const fetcher = RF.createFetcher({
    url: 'https://results.example/v1/outcomes',
    fetchImpl: replying({ outcomes: [{ market_id: f.marketId, disputed: true }] }),
  });
  const run = await RF.pollNow(f.db, { fetcher });
  assert.strictEqual(run.applied, 1, 'a dispute is an outcome, not an empty payload');
  assert.strictEqual(run.results[0].outcome, 'held');
  assert.strictEqual(run.results[0].rule, 'disputed');
  assert.strictEqual(RF.state().signals_received, 1, 'and it was counted');
  assert.strictEqual(RF.state().dropped_entries, 0, 'nothing was dropped');
  assert.strictEqual(RF.state().last_error, null, 'the poll was not reported as a failure');
  // A payload of entries that name an outcome nobody can use is still a shape
  // change, still loud: the fix must not make silence acceptable.
  assert.throws(
    () => RF.parseOutcomes({ outcomes: { 5: { vendor: 'acme' } } }),
    (e) => e.reason === 'unrecognised_shape'
  );
});

check('S9 a configured feed that has never once answered is not "ok"', () => {
  RF.resetState();
  // Configuring a transport is not the same as the transport working. `stale`
  // used to require a previous success to have an age to measure, so from boot
  // until the first successful poll the state was `ok` — and if the poll job
  // never ran at all, it stayed `ok` forever. The module header calls
  // staleness the operator's alarm; this was the hole in it.
  RF.createFetcher({ url: 'https://results.example/v1/outcomes', fetchImpl: replying({}) });
  const h = RF.health({ staleAfterMs: 60000 });
  assert.strictEqual(h.configured, true, 'the feed IS configured');
  assert.strictEqual(h.polls, 0);
  assert.strictEqual(h.last_ok_at, null);
  assert.strictEqual(h.stale, true, 'waiting for a first answer is waiting');
  assert.strictEqual(h.status, 'stale', 'and it must not read as a working feed');
  // The four states stay four. An unconfigured feed has never been asked, so
  // "waiting" is the wrong word for it.
  RF.resetState();
  RF.createFetcher({ url: null, fetchImpl: replying({}) });
  assert.strictEqual(RF.health({ staleAfterMs: 60000 }).status, 'not_configured');
});

(async () => {
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (e) {
      console.error(`  FAIL ${name}\n       ${e && e.message}`);
      process.exit(1);
    }
    passed++;
    console.log(`  ok   ${name}`);
  }
  console.log(`\nresultsfeed-signal-shape.test.js: ${passed} checks passed`);
  if (passed < 9) { console.error("expected 9 checks"); process.exit(1); }
})();
