// results-webhook.test.js — POST /api/results/webhook, end to end over real HTTP.
//
// Its own file for ONE reason: lib/config.js is evaluated at import, so
// RESULTS_WEBHOOK_SECRET cannot be flipped inside a process that has already
// loaded the server. Every other suite runs with it UNSET, which is the safe
// default and makes the route a 404 — so the authenticated path, where the
// route SETTLES A MARKET, would have no coverage anywhere. tests/webhook.test.js
// exists for exactly this reason on the payments side and says so in its header.
//
// ── WHAT IS PINNED, AND WHY EACH CASE IS HERE ────────────────────────────────
//
//   W1  a correctly signed, fresh delivery settles the market and the winner is
//       paid. With its CONTROL beside it: the same market with an unsigned POST
//       settles nothing, in the very same process, so "it settled" cannot be
//       explained by the fixture.
//
//   W2  DEFAULT-DENY. No secret configured => 404 (not 401). No signature => 401.
//       Wrong signature => 401. Signature over a different body => 401. A
//       body-only signature => 401. A missing timestamp => 400. A timestamp
//       edited on a captured request => 401, which is the one that proves the
//       timestamp is INSIDE the MAC rather than merely read.
//
//   W3  THE REPLAY WINDOW. A captured request presented outside the window is
//       refused with 400 and the settlement does not happen again — and the
//       signature is still genuine, so only the window can be what refused it.
//
//   W4  AN EXACT REPLAY INSIDE THE WINDOW IS REFUSED AS A SETTLEMENT, not as a
//       request. This is the deliberate difference from a naive replay defence
//       and it is asserted with its reason: at-least-once delivery means the
//       sender WILL resend inside the window, and answering 401 there would make
//       a correct provider think it was banned. What must not happen is a second
//       payout — asserted on the row, on the balance, and on the provenance.
//
//   W5  ID-SPACE. A signal naming the FEED's runner ids settles the right market,
//       because `lib/feedcat.js admitSignal` translated it — with the control
//       beside it: the same market in the VENUE's id space, and the identical
//       request naming a market this venue does not have (422, and nothing
//       settles).
//
//   W6  A HELD OUTCOME IS REPORTED AS HELD, with its reason, and the market is
//       still open with players in it. NOT 200 — see the route's note; a feed
//       operator told 200 stops resending and the venue's players sit in a
//       market nothing settles.
//
//   W7  A PRE-OFF WITHDRAWAL has a route at all, which the poll timer has never
//       had (`pendingMarkets` only asks about markets already OFF), and a
//       pre-off RESULT is held rather than settled — with the control beside it.
//
//   W8  PROVENANCE AND AUDIT. Every accepted delivery writes a `results.delivered`
//       row naming the transport, and every hold writes `results.held`.
//
//   W9  THE BOOT MESSAGE says what is actually true, in each configuration.
//       This is the check the defect itself would have failed: the old line
//       promised a webhook that did not exist.
'use strict';

// Set BEFORE the server is required — config reads the environment at import.
process.env.RESULTS_WEBHOOK_SECRET = 'test-results-webhook-secret-not-a-real-secret';
process.env.SCRYPT_N = '16384';
process.env.DB_PATH = ':memory:';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
// No RESULTS_FEED_URL: this file is about the PUSH transport, and leaving the
// poll unconfigured is the honest starting point — a venue that pushes outcomes
// does not also need to be polled.

const assert = require('assert');
const crypto = require('crypto');

let passed = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push([name, e]);
    console.error(`  FAIL ${name}\n       ${e && e.message}`);
  }
};

const SECRET = process.env.RESULTS_WEBHOOK_SECRET;
const WINDOW = 300;

// Exactly the scheme the route computes, so the test signs what the route
// verifies rather than a paraphrase of it — the distinction tests/webhook.test.js
// draws and the reason a paraphrase would be a test of nothing.
function sign(body, timestamp) {
  return crypto.createHmac('sha256', SECRET).update(`${timestamp}.`).update(body).digest('hex');
}
const now = () => Math.floor(Date.now() / 1000);

let n = 0;
/**
 * A market in the FUTURE, with three runners.
 *
 * FUTURE, always, and `off()` below moves it into the past. That ordering is the
 * real one: a venue trades a market before its off, the race runs, and the result
 * arrives after. `validateOrder` refuses betting on an event that is already off,
 * so a fixture that started in the past could never have a backer in it — and a
 * settlement with nobody in it proves nothing about money.
 *
 * `sport` is the SPORT SLUG, spelled the way lib/voidrules.js publishes its rules.
 * That is not cosmetic: `rules.resolve` falls through to a default on an unknown
 * sport, and the default is VOID. "horse racing" with a space would void a greyhound
 * market and refund it to nobody.
 */
function mkMarket(db, { sport = 'football' } = {}) {
  let s = db.prepare('SELECT id FROM sports WHERE slug = ?').get(sport);
  if (!s) {
    db.prepare('INSERT INTO sports (name, slug) VALUES (?, ?)').run(sport, sport);
    s = db.prepare('SELECT id FROM sports WHERE slug = ?').get(sport);
  }
  n++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now', '+2 hours'))").run(s.id, `WH ${n}`);
  const ev = db.prepare('SELECT * FROM events WHERE name = ?').get(`WH ${n}`);
  db.prepare('INSERT INTO markets (event_id, name) VALUES (?, ?)').run(ev.id, 'Match Odds');
  const mkt = db.prepare('SELECT * FROM markets WHERE event_id = ? ORDER BY id DESC').get(ev.id);
  const names = sport === 'football' ? ['Home', 'Draw', 'Away'] : ['Alpha', 'Beta'];
  for (const nm of names) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, nm);
  }
  const sels = db.prepare('SELECT id, name FROM selections WHERE market_id = ? ORDER BY id').all(mkt.id);
  return { market: mkt, event: ev, selections: sels, refs: null };
}

/** The race has gone off: the venue stops trading and a result becomes possible. */
function off(db, market) {
  db.prepare("UPDATE events SET starts_at = datetime('now', '-2 hours') WHERE id = ?").run(market.event_id);
  return market;
}

/**
 * The same market, MATERIALISED from a feed catalogue: the venue's rows carry
 * the feed's own market and runner ids, so a signal naming those has to be
 * translated before it can be placed.
 */
function mkMaterialised(db) {
  const f = mkMarket(db, { sport: 'football' });
  const feedMarketId = `1.${900000 + f.market.id}`;
  for (const s of f.selections) {
    db.prepare("INSERT INTO feed_map (provider, kind, local_id, external_id) VALUES (?, 'selection', ?, ?)")
      .run('postgres', s.id, `${feedMarketId}:${s.id}`);
  }
  db.prepare("INSERT INTO feed_map (provider, kind, local_id, external_id) VALUES (?, 'market', ?, ?)")
    .run('postgres', f.market.id, feedMarketId);
  db.prepare("INSERT INTO feed_map (provider, kind, local_id, external_id) VALUES (?, 'event', ?, ?)")
    .run('postgres', f.event.id, `1.${800000 + f.event.id}`);
  f.refs = { feedMarketId, externalIds: f.selections.map((s) => `${feedMarketId}:${s.id}`) };
  return f;
}

(async () => {
  const srv = require('../server');
  await srv.ready;
  const server = srv.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = async (bodyObj, { timestamp, signature, raw, url = '/api/results/webhook' } = {}) => {
    const body = raw !== undefined ? raw : JSON.stringify(bodyObj);
    const headers = { 'content-type': 'application/json' };
    if (timestamp !== undefined) headers['x-obx-timestamp'] = String(timestamp);
    if (signature !== undefined) headers['x-obx-signature'] = signature;
    const res = await fetch(base + url, { method: 'POST', headers, body });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };
  /** A correctly signed, fresh delivery. The scheme, used by every happy path. */
  const deliver = async (bodyObj, opts = {}) => {
    const raw = JSON.stringify(bodyObj);
    const ts = opts.timestamp === undefined ? now() : opts.timestamp;
    return post(null, { raw, timestamp: ts, signature: sign(raw, ts), ...opts });
  };

  const db = srv.db;
  const A = require('../lib/auth');
  const M = require('../lib/match');
  /** A funded player. Money movement is asserted on the SETTLEMENT rows, not on
   * a balance: at even money a winner's profit is exactly zero, so a balance
   * comparison reads the commission and nothing else. */
  const newUser = async (name) =>
    A.registerUser(db, { username: name, password: 'secret1', balance_cents: 1000000 });

  try {
    // ── W1 ──────────────────────────────────────────────────────────────────
    await check('W1 a valid signed delivery settles the market, pays the winner, and records provenance', async () => {
      const alice = await newUser('wh_alice');
      const bob = await newUser('wh_bob');
      const { market, selections } = mkMarket(db);
      const home = selections[0];
      const away = selections[2];
      // Alice backs the winner, Bob backs the loser, so a settlement moves money in
      // ONE direction and a "settled" that settled nothing would be visible.
      // MATCHED, not resting. Settlement pays MATCHED legs, so a fixture of two
      // uncrossed orders settles the market and credits nobody — which is a
      // "settled" that proves nothing about money moving.
      M.placeOrder(db, alice, { selection_id: home.id, side: 'back', price: 2.0, stake_cents: 10000 });
      M.placeOrder(db, bob, { selection_id: home.id, side: 'lay', price: 2.0, stake_cents: 10000 });
      // ── THE CONTROL, BESIDE IT ────────────────────────────────────────────
      // The same shape, unsigned, in the same process against the same code. If
      // an unsigned POST also settled, then everything above was the fixture and
      // not the signature — which is the whole defect this route could have had.
      const ctl = mkMarket(db);
      M.placeOrder(db, alice, { selection_id: ctl.selections[0].id, side: 'back', price: 2.0, stake_cents: 10000 });
      // A timestamp and NO signature — the case that matters. With no timestamp
      // either, the route refuses on the timestamp first (400), which is also
      // correct but measures the protocol error rather than the authentication.
      const unsigned = await post(
        { outcomes: { [ctl.market.id]: { status: 'completed', winners: [ctl.selections[0].id] } } },
        { timestamp: now() }
      );
      assert.strictEqual(unsigned.status, 401, `an unsigned delivery settled a market (got ${unsigned.status} ${JSON.stringify(unsigned.json)})`);
      assert.strictEqual(
        db.prepare('SELECT status FROM markets WHERE id = ?').get(ctl.market.id).status, 'open',
        'an unsigned POST settled a market'
      );
      off(db, ctl.market);

      off(db, market);
      const r = await deliver({ outcomes: { [market.id]: { status: 'completed', winners: [home.id] } } });
      assert.strictEqual(r.status, 200, `signed delivery was not accepted (${r.status} ${JSON.stringify(r.json)})`);
      assert.strictEqual(r.json.results[0].outcome, 'settled', `the market did not settle: ${JSON.stringify(r.json.results[0])}`);
      assert.strictEqual(r.json.results[0].market_id, market.id);
      assert.strictEqual(r.json.unreadable_entries, 0);

      assert.strictEqual(db.prepare('SELECT status FROM markets WHERE id = ?').get(market.id).status, 'settled');
      // ON THE SETTLEMENT ROW, NOT ON A BALANCE. At even money a winner's
      // profit is exactly zero and a balance comparison would be reading the
      // commission; the settlement row is where the engine states what it paid.
      const aliceSettled = db.prepare('SELECT * FROM settlements WHERE market_id = ? AND user_id = ?').get(market.id, alice.id);
      const bobSettled = db.prepare('SELECT * FROM settlements WHERE market_id = ? AND user_id = ?').get(market.id, bob.id);
      assert.ok(aliceSettled, 'the winner was not paid at all');
      assert.ok(bobSettled, 'the loser was not settled at all — so "settled" would mean nothing here');
      assert.ok(aliceSettled.pnl_cents > 0, `the winner's P&L is ${aliceSettled.pnl_cents}`);
      assert.ok(bobSettled.pnl_cents < 0, `the loser's P&L is ${bobSettled.pnl_cents}`);
      assert.strictEqual(aliceSettled.credit_cents, 20000, 'even money pays twice the stake back');
      // THE PROVENANCE ROW, which is what a disputed settlement is defended with.
      const ev = db
        .prepare('SELECT * FROM result_events WHERE market_id = ?')
        .get(market.id);
      assert.ok(ev, 'no provenance row was written');
      assert.strictEqual(ev.decision, 'settle');
      assert.strictEqual(ev.source, 'webhook', 'the provenance row must say HOW the outcome arrived');
      assert.strictEqual(ev.data_source_id, null);
    });

    // ── W2 ──────────────────────────────────────────────────────────────────
    await check('W2 default-deny: no signature, a wrong one, a tampered body and a missing timestamp are all refused', async () => {
      const body = JSON.stringify({ outcomes: { 999999: { status: 'completed', winners: [1] } } });
      const ts = now();

      // No signature at all.
      assert.strictEqual((await post(null, { raw: body, timestamp: ts })).status, 401, 'unsigned');
      // A valid signature for one timestamp, presented with another.
      assert.strictEqual((await post(null, { raw: body, timestamp: ts, signature: sign(body, ts + 1) })).status, 401, 'timestamp swap');
      // Signature over a different body.
      assert.strictEqual((await post(null, { raw: body + ' ', timestamp: ts, signature: sign(body, ts) })).status, 401, 'body tamper');
      // Signature from the wrong secret.
      const wrong = crypto.createHmac('sha256', 'wrong-secret').update(`${ts}.`).update(body).digest('hex');
      assert.strictEqual((await post(null, { raw: body, timestamp: ts, signature: wrong })).status, 401, 'wrong secret');
      // THE DECISIVE ONE, and the same one tests/webhook.test.js pins on the
      // payments side: a signature over the BODY ALONE is refused. If it
      // verified, an attacker holding one captured delivery could replay it
      // forever simply by sending a fresh `x-obx-timestamp` beside it, and the
      // replay window would be decorative.
      const bodyOnly = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
      assert.strictEqual(
        (await post(null, { raw: body, timestamp: now(), signature: bodyOnly })).status, 401,
        'a body-only signature was accepted — the replay window is not real'
      );
      // Missing timestamp: a protocol error, reported as one.
      const noTs = await post(null, { raw: body, signature: sign(body, ts) });
      assert.strictEqual(noTs.status, 400, 'a missing timestamp must be a 400');
      assert.match(noTs.json.error, /timestamp/i);

      // AND NOTHING SETTLED. Every one of the above was aimed at a market that
      // does not exist, so it proves the AUTH path rather than the money path —
      // hence one more, against a real market, with the control being W1's
      // signed delivery of the same signal.
      const { market, selections } = mkMarket(db);
      const body2 = JSON.stringify({ outcomes: { [market.id]: { status: 'completed', winners: [selections[0].id] } } });
      off(db, market);
      await post(null, { raw: body2, timestamp: now(), signature: crypto.createHmac('sha256', 'nope').update(`${now()}.`).update(body2).digest('hex') });
      assert.strictEqual(db.prepare('SELECT status FROM markets WHERE id = ?').get(market.id).status, 'open', 'a forged delivery settled a market');
    });

    // ── W3 ──────────────────────────────────────────────────────────────────
    await check('W3 the route is a 404 with no secret configured, and the replay window refuses a stale capture', async () => {
      // THE 404, asserted against the SAME route with the secret removed rather
      // than against a re-implementation. `config` is frozen at import, so this
      // is the one property this suite cannot drive in-process: it is asserted
      // structurally, on the code, and it is 404 rather than 401 because a
      // scanner must not learn the route exists.
      const src = require('fs').readFileSync(require.resolve('../server.js'), 'utf8');
      const fn = src.match(/app\.post\('\/api\/results\/webhook'[^\n]*\n(?:.*\n)*?\}\);/);
      assert.ok(fn, 'the route is no longer registered at this path — reword this check, do not delete it');
      assert.ok(
        /verifySignedWebhook\(req, config\.RESULTS_WEBHOOK_SECRET\)/.test(fn[0]),
        'the route must delegate to verifySignedWebhook, or the two webhooks can drift apart again'
      );
      const helper = src.match(/function verifySignedWebhook\(req, secret\) \{[\s\S]*?\n\}/);
      assert.ok(helper, 'verifySignedWebhook is gone — the payments webhook has lost its shared scheme');
      assert.ok(
        /if \(!secret\) return \{ ok: false, status: 404/.test(helper[0]),
        'an unconfigured webhook must be a 404, not a 401: a scanner must not learn the route exists'
      );

      // THE WINDOW, driven for real. A capture from outside the window is
      // refused with 400 — and the signature is still genuine, which is what
      // makes the 400 rather than the 401 the control: only the window can be
      // what refused it.
      const alice = await newUser('wh_stale');
      const { market, selections } = mkMarket(db);
      M.placeOrder(db, alice, { selection_id: selections[0].id, side: 'back', price: 2.0, stake_cents: 10000 });
      const body = JSON.stringify({ outcomes: { [market.id]: { status: 'completed', winners: [selections[0].id] } } });
      const staleTs = now() - (WINDOW + 60);
      off(db, market);
      const stale = await post(null, { raw: body, timestamp: staleTs, signature: sign(body, staleTs) });
      assert.strictEqual(stale.status, 400, `a stale delivery was not refused (got ${stale.status} ${JSON.stringify(stale.json)})`);
      assert.match(stale.json.error, /replay window/i, 'and it must say the replay window was the reason');
      assert.strictEqual(
        db.prepare('SELECT status FROM markets WHERE id = ?').get(market.id).status, 'open',
        'a stale delivery settled a market'
      );
    });

    // ── W4 ──────────────────────────────────────────────────────────────────
    await check('W4 an EXACT replay is refused AS A SETTLEMENT — inside the window and outside it', async () => {
      const alice = await newUser('wh_replay');
      const { market, selections } = mkMarket(db);
      const home = selections[0];
      const away = selections[2];
      // MATCHED exposure, for the same reason as W1: settlement pays matched legs.
      M.placeOrder(db, alice, { selection_id: home.id, side: 'back', price: 2.0, stake_cents: 10000 });
      const bob = await newUser('wh_replay_2');
      M.placeOrder(db, bob, { selection_id: home.id, side: 'lay', price: 2.0, stake_cents: 10000 });
      assert.strictEqual(
        db.prepare('SELECT COUNT(*) c FROM matches WHERE market_id = ?').get(market.id).c, 1,
        'the fixture did not actually cross, so the settlement below would pay nobody'
      );

      // THE CAPTURE. Byte for byte: the same body, the same timestamp, the same
      // signature. This is what an attacker who has seen one delivery holds.
      const body = JSON.stringify({ outcomes: { [market.id]: { status: 'completed', winners: [home.id] } } });
      const capturedTs = now();
      const capturedSig = sign(body, capturedTs);

      off(db, market);
      const first = await post(null, { raw: body, timestamp: capturedTs, signature: capturedSig });
      assert.strictEqual(first.status, 200, `the capture works while fresh (${first.status} ${JSON.stringify(first.json)})`);
      assert.strictEqual(first.json.results[0].outcome, 'settled');
      // ON THE SETTLEMENT, NOT ON A BALANCE: at even money a winner's profit is
      // zero and the balance moves by exactly the commission.
      const paid = db.prepare('SELECT * FROM settlements WHERE market_id = ?').all(market.id);
      assert.strictEqual(paid.length, 2, 'the first delivery did not pay both participants');
      const aliceAfter = paid.find((p) => p.user_id === alice.id).credit_cents;
      assert.strictEqual(aliceAfter, 20000);

      // INSIDE THE WINDOW: served, and settling nothing.
      //
      // NOT 401, and the reason is the contract rather than leniency. Delivery is
      // at-least-once: a sender whose response was lost WILL resend inside the
      // window, and a 401 there teaches a correctly-configured feed that it has
      // been banned. What must be impossible is a SECOND PAYOUT — so the refusal
      // under test is of the SETTLEMENT, not of the request, and it is asserted
      // on the money rather than on the status code.
      const replay = await post(null, { raw: body, timestamp: capturedTs, signature: capturedSig });
      assert.strictEqual(replay.status, 200, `a re-delivery inside the window should be served, got ${replay.status} ${JSON.stringify(replay.json)}`);
      assert.strictEqual(replay.json.results[0].outcome, 'already_settled', `the replay re-settled: ${JSON.stringify(replay.json.results[0])}`);
      assert.strictEqual(
        db.prepare('SELECT COALESCE(SUM(credit_cents),0) c FROM settlements WHERE market_id = ?').get(market.id).c, aliceAfter,
        'THE REPLAY PAID THE WINNER A SECOND TIME'
      );
      assert.strictEqual(
        db.prepare('SELECT COUNT(*) c FROM result_events WHERE market_id = ?').get(market.id).c, 1,
        'the replay wrote a second provenance row'
      );
      assert.strictEqual(
        db.prepare('SELECT COUNT(*) c FROM settlements WHERE market_id = ?').get(market.id).c, paid.length,
        'the replay settled the market twice'
      );

      // OUTSIDE THE WINDOW: refused outright, 400, with the signature still
      // genuine — so it is the window that did the refusing.
      const staleTs = capturedTs - (WINDOW + 120);
      const outside = await post(null, { raw: body, timestamp: staleTs, signature: sign(body, staleTs) });
      assert.strictEqual(outside.status, 400, `a replay outside the window was not refused (got ${outside.status})`);
      assert.match(outside.json.error, /replay window/i);
      assert.strictEqual(
        db.prepare('SELECT COUNT(*) c FROM settlements WHERE market_id = ?').get(market.id).c, 2,
        'and it paid somebody'
      );

      // AND THE EDITED CAPTURE, which is the one that matters most: the same
      // body and the same signature with a DIFFERENT timestamp must not verify. If
      // it did, one captured delivery would be an unlimited supply of valid ones.
      // Offset by 60s so it cannot coincide with the captured one by accident —
      // `now()` and `capturedTs` are both "this second" in a fast test, and the
      // forged request would then be a byte-identical REPLAY rather than an edit,
      // which is a different check.
      const forged = await post(null, { raw: body, timestamp: capturedTs - 60, signature: capturedSig });
      assert.strictEqual(forged.status, 401, `editing the timestamp invalidated nothing (got ${forged.status})`);
      assert.strictEqual(
        db.prepare('SELECT COUNT(*) c FROM settlements WHERE market_id = ?').get(market.id).c, 2,
        'and it paid somebody'
      );
    });

    // ── W5 ──────────────────────────────────────────────────────────────────
    await check('W5 a signal in the FEED id space settles the right market; one in no id space settles nothing', async () => {
      const alice = await newUser('wh_space');
      const { market, selections, refs } = mkMaterialised(db);
      const home = selections[0];
      // MATCHED exposure: settlement pays MATCHED legs, so a fixture of two
      // uncrossed orders "settles" and credits nobody.
      M.placeOrder(db, alice, { selection_id: home.id, side: 'back', price: 2.0, stake_cents: 10000 });
      const bob = await newUser('wh_space_2');
      M.placeOrder(db, bob, { selection_id: home.id, side: 'lay', price: 2.0, stake_cents: 10000 });
      assert.strictEqual(
        db.prepare('SELECT COUNT(*) c FROM matches WHERE market_id = ?').get(market.id).c, 1,
        'the fixture did not cross, so "the winner was paid" below would be vacuous'
      );

      // THE FEED'S OWN MARKET ID AND RUNNER IDS — which is all a licensed feed
      // has ever been given, because the venue's autoincrement ids are numbers it
      // invented. Without lib/feedcat.js `admitSignal` this reaches the market's
      // membership test as foreign for every winner, takes the empty-winner HOLD
      // branch and parks real money.
      off(db, market);
      const r = await deliver({ outcomes: { [refs.feedMarketId]: { status: 'completed', winners: [refs.externalIds[0]] } } });
      assert.strictEqual(r.status, 200, `a feed-id-space delivery was not accepted (${r.status} ${JSON.stringify(r.json)})`);
      assert.strictEqual(r.json.results[0].outcome, 'settled', `the feed-id-space signal did not settle: ${JSON.stringify(r.json.results[0])}`);
      assert.strictEqual(r.json.results[0].market_id, market.id, 'it settled the wrong market');
      const paid = db.prepare('SELECT * FROM settlements WHERE market_id = ?').all(market.id);
      assert.strictEqual(paid.length, 2, 'the winner and loser were not both settled');
      assert.ok(paid.find((p) => p.pnl_cents > 0), 'nobody was paid a profit, so the settlement settled nothing');
      // The id space is RECORDED, because "which space did this feed use" is the
      // first question an operator asks when an outcome looks wrong.
      const ev = db.prepare('SELECT payload FROM result_events WHERE market_id = ?').get(market.id);
      assert.match(ev.payload, /feed/, 'the provenance row does not record which id space the decision was made in');
      assert.match(ev.payload, new RegExp(refs.feedMarketId.replace(/\./g, '\\.')), 'nor the feed market it was about');

      // ── THE CONTROL, BESIDE IT: THE VENUE'S OWN ID SPACE ──────────────────
      // `requestBody` sends local ids BESIDE the feed's, so an operator's own API
      // may answer in either space and both must work. If only the feed space
      // worked, half of every integration this repository ships against would be
      // broken and the check above would still be green.
      const ctl = mkMaterialised(db);
      M.placeOrder(db, alice, { selection_id: ctl.selections[0].id, side: 'back', price: 2.0, stake_cents: 10000 });
      off(db, ctl.market);
      const local = await deliver({ outcomes: { [ctl.market.id]: { status: 'completed', winners: [ctl.selections[0].id] } } });
      assert.strictEqual(local.status, 200, `a local-id-space delivery was not accepted (${local.status} ${JSON.stringify(local.json)})`);
      assert.strictEqual(local.json.results[0].outcome, 'settled', 'the venue\'s own id space does not settle');

      // ── AND THE CONTROL FOR THE REFUSAL: AN ID IN NEITHER SPACE ───────────
      const ghost = mkMarket(db);
      const noSuch = await deliver({ outcomes: { 987654321: { status: 'completed', winners: [1] } } });
      assert.strictEqual(noSuch.status, 422, `a market this venue does not have was not reported as unplaceable (got ${noSuch.status})`);
      assert.strictEqual(noSuch.json.unmapped, 1);
      assert.strictEqual(noSuch.json.results[0].outcome, 'unmapped');
      assert.strictEqual(
        db.prepare('SELECT status FROM markets WHERE id = ?').get(ghost.market.id).status, 'open',
        'an unplaceable delivery settled some other market'
      );
    });

    // ── W6 ──────────────────────────────────────────────────────────────────
    await check('W6 a HELD outcome is reported as held, with its reason — never as 200-OK', async () => {
      const alice = await newUser('wh_held');
      const { market, selections } = mkMarket(db);
      const home = selections[0];
      M.placeOrder(db, alice, { selection_id: home.id, side: 'back', price: 2.0, stake_cents: 10000 });

      // `disputed` is checked by lib/voidrules.js AHEAD of every published rule
      // precisely so no table can quietly settle a contested event. It is the one
      // word a provider can send that the venue must never resolve itself.
      off(db, market);
      const r = await deliver({ outcomes: { [market.id]: { status: 'completed', winners: [home.id], disputed: true } } });
      assert.notStrictEqual(r.status, 200, `a held outcome was answered 200 — a feed operator would read that as settled (got ${r.status})`);
      assert.strictEqual(r.status, 202, `expected 202 "received, not resolved"; got ${r.status} ${JSON.stringify(r.json)}`);
      assert.strictEqual(r.json.held, 1);
      assert.strictEqual(r.json.results[0].outcome, 'held');
      assert.ok(r.json.results[0].reason && r.json.results[0].reason.length > 0, 'the hold was reported with no reason — a feed operator cannot act on that');
      assert.ok(r.json.results[0].rule, 'and with no named rule, so it cannot be looked up');

      // The market is HELD, not settled, and still OPEN — players are still in it.
      const m = db.prepare('SELECT status, settlement_hold, hold_reason FROM markets WHERE id = ?').get(market.id);
      assert.strictEqual(m.status, 'open', 'a held market must stay open: players hold positions in it');
      assert.strictEqual(m.settlement_hold, 1);
      assert.ok(m.hold_reason);
      assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM settlements WHERE market_id = ?').get(market.id).c, 0, 'a held outcome paid somebody');
      assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM result_events WHERE market_id = ? AND decision = ?').get(market.id, 'settle').c, 0);

      // AND THE RE-DELIVERY OF A HELD SIGNAL REPORTS THE HOLD, not "applied".
      // "Already applied" is a sentence about the FIRST delivery and the sender
      // is reading the second; a market that was held and then answered
      // "already_applied" and nothing else looks settled to the feed operator.
      const again = await deliver({ outcomes: { [market.id]: { status: 'completed', winners: [home.id], disputed: true } } });
      assert.strictEqual(again.status, 202, `a re-delivery of a held signal changed its answer (got ${again.status})`);
      assert.strictEqual(again.json.results[0].outcome, 'held');
    });

    // ── W7 ──────────────────────────────────────────────────────────────────
    await check('W7 a PRE-OFF WITHDRAWAL has a route; a PRE-OFF RESULT is held, not settled', async () => {
      const alice = await newUser('wh_withdraw');
      const { market, selections } = mkMarket(db, { sport: 'horse_racing' });
      const alpha = selections[0];
      M.placeOrder(db, alice, { selection_id: alpha.id, side: 'back', price: 2.0, stake_cents: 10000 });
      const escrowBefore = db.prepare('SELECT frozen_cents FROM orders WHERE user_id = ? AND selection_id = ?').get(alice.id, alpha.id).frozen_cents;
      assert.ok(escrowBefore > 0, 'the backer is not escrowed, so the refund below would prove nothing');

      // THIS IS THE DELIVERY THE POLL TIMER CANNOT CARRY. `results.pendingMarkets`
      // only ever asks about markets whose event is already OFF, and a racing
      // withdrawal arrives BEFORE the off — which is the gap that made a webhook
      // necessary rather than convenient.
      const r = await deliver({ outcomes: { [market.id]: { non_runners: [alpha.id] } } });
      assert.strictEqual(r.status, 200, `a pre-off withdrawal was not accepted (${r.status} ${JSON.stringify(r.json)})`);
      assert.strictEqual(r.json.results[0].outcome, 'withdrawn', JSON.stringify(r.json.results[0]));
      assert.deepStrictEqual(r.json.results[0].voided_selections, [alpha.id]);
      assert.strictEqual(db.prepare('SELECT status FROM selections WHERE id = ?').get(alpha.id).status, 'void');
      assert.strictEqual(
        db.prepare('SELECT status FROM markets WHERE id = ?').get(market.id).status, 'open',
        'a withdrawal settles the market — the rest of the field is still running'
      );
      assert.strictEqual(
        db.prepare('SELECT frozen_cents FROM orders WHERE user_id = ? AND selection_id = ?').get(alice.id, alpha.id).frozen_cents, 0,
        'the withdrawn runner\'s escrow was not released'
      );

      // ── AND ITS CONTROL, BESIDE IT: A PRE-OFF RESULT IS HELD ───────────────
      // The push transport has no `pendingMarkets` filter doing the work for it —
      // the sender decides what to talk about and when. Without this guard a feed
      // (or a bug in one) could announce a result for a race that has not started,
      // settle it and pay out on it. `lib/settle.js` has no off-time check of its
      // own; the consumer is the control.
      const ctl = mkMarket(db, { sport: 'horse_racing' });
      const beta = ctl.selections[1];
      M.placeOrder(db, alice, { selection_id: beta.id, side: 'back', price: 2.0, stake_cents: 10000 });
      const early = await deliver({ outcomes: { [ctl.market.id]: { status: 'completed', winners: [beta.id] } } });
      assert.strictEqual(early.status, 202, `a pre-off result was not held (got ${early.status} ${JSON.stringify(early.json)})`);
      assert.strictEqual(early.json.results[0].outcome, 'held');
      assert.strictEqual(early.json.results[0].rule, 'pre_off_result');
      assert.strictEqual(
        db.prepare('SELECT status FROM markets WHERE id = ?').get(ctl.market.id).status, 'open',
        'a race that had not started was SETTLED'
      );
    });

    // ── W8 ──────────────────────────────────────────────────────────────────
    await check('W8 every accepted delivery is audited, and every hold is audited separately', async () => {
      const alice = await newUser('wh_audit');
      const ok = mkMarket(db);
      M.placeOrder(db, alice, { selection_id: ok.selections[0].id, side: 'back', price: 2.0, stake_cents: 10000 });
      off(db, ok.market);
      await deliver({ outcomes: { [ok.market.id]: { status: 'completed', winners: [ok.selections[0].id] } } });

      const rows = db.prepare("SELECT * FROM audit_log WHERE action = 'results.delivered' ORDER BY id").all();
      assert.ok(rows.length > 0, 'a delivery that settled a market left no audit row');
      const last = rows[rows.length - 1];
      const after = JSON.parse(last.after || '{}');
      assert.strictEqual(last.actor_id, null, 'the actor must be the SYSTEM, not an admin — lib/audit.js defines NULL as "no human did this"');
      assert.strictEqual(after.transport, 'webhook');
      assert.ok(after.settled >= 1, 'the row does not record what the delivery settled');
      assert.ok('held' in after && 'already_applied' in after, 'the row must carry every count, so an operator can see what a delivery did without re-reading it');

      const held = mkMarket(db);
      off(db, held.market);
      await deliver({ outcomes: { [held.market.id]: { status: 'completed', winners: [held.selections[0].id], disputed: true } } });
      // Scoped to THIS market. Earlier checks in this file held markets too, and a
      // count over the whole table would be asserting on the order the suite
      // happens to run in.
      const holdRows = db.prepare("SELECT * FROM audit_log WHERE action = 'results.held' AND target = ?").all(`market:${held.market.id}`);
      assert.strictEqual(holdRows.length, 1, 'a held outcome left no audit row, and a hold is the one thing here a machine could not decide');
      assert.strictEqual(holdRows[0].target, `market:${held.market.id}`);
      const holdAfter = JSON.parse(holdRows[0].after || '{}');
      assert.ok(holdAfter.reason && holdAfter.rule, 'the hold row does not say why it was held');

      // AND the operator surface reports the transport. lib/ops.js readiness puts
      // both transports on one page, because a push-configured venue never polls
      // and the poll half alone would read "configured and failing" for a feed
      // that is answering perfectly.
      const r = srv.OPS.readiness(db);
      assert.ok('results_webhook' in r.checks, 'readiness does not report the results webhook at all');
      assert.strictEqual(r.checks.results_webhook, 'ok', `readiness says the webhook is ${r.checks.results_webhook} with the secret configured`);
    });

    // ── W9 ──────────────────────────────────────────────────────────────────
    await check('W9 the boot message states what is TRUE in each configuration, and promises nothing', async () => {
      const RF = require('../lib/resultsfeed');

      // NOTHING CONFIGURED — the case the defect shipped in. The old line said
      // markets "settle by webhook or by an operator settling them by hand" and
      // there was no webhook. So the line must NOT mention a webhook here, and
      // must say plainly that an operator settles every market.
      const none = RF.resultsBootStatus({ RESULTS_FEED_URL: '', RESULTS_WEBHOOK_SECRET: null });
      assert.strictEqual(none.level, 'warn', 'a venue with no results transport is a warning, not a log line');
      assert.ok(
        !/settle by webhook/i.test(none.message),
        `the line must not name a transport that is not configured: ${none.message}`
      );
      assert.ok(/no automatic/i.test(none.message), `the line must say outcomes are not automatic: ${none.message}`);
      assert.ok(
        /admin\/markets\/:id\/settle/.test(none.message),
        `the line must name the route that IS the settlement path: ${none.message}`
      );

      // THE WEBHOOK ONLY — the configuration the customer described: a licensed
      // feed that pushes. The line must say the webhook is live, or an operator
      // who read "no automatic results feed" would go looking for a poller.
      const push = RF.resultsBootStatus({ RESULTS_FEED_URL: '', RESULTS_WEBHOOK_SECRET: 'set' });
      assert.strictEqual(push.level, 'log', 'a venue configured for a push is told so at log, not warn — or every boot warns and nobody reads the block');
      assert.ok(/webhook active/i.test(push.message), `the webhook line must say it is active: ${push.message}`);
      assert.ok(/pre-off withdrawal/i.test(push.message), `and must say the withdrawal route exists: ${push.message}`);

      // THE POLL ONLY, and the correction the old line needed: a poll cannot
      // carry a withdrawal, and saying otherwise is what sent this defect.
      const poll = RF.resultsBootStatus({ RESULTS_FEED_URL: 'https://feed.example/results', RESULTS_WEBHOOK_SECRET: null });
      assert.strictEqual(poll.level, 'log');
      assert.ok(/pre-off withdrawal has no route through the timer/i.test(poll.message), `the poll-only line must be honest about withdrawals: ${poll.message}`);

      // BOTH — and neither line may claim the other is off.
      const both = RF.resultsBootStatus({ RESULTS_FEED_URL: 'https://feed.example/results', RESULTS_WEBHOOK_SECRET: 'set' });
      assert.ok(/TWICE/i.test(both.message), `a venue with both transports should be told both are live: ${both.message}`);

      // THE LINE IS A FUNCTION OF THE CONFIGURATION AND NOTHING ELSE, which is
      // what makes it checkable: the same config object must always render the
      // same line, and no line may mention a transport that is off.
      for (const cfg of [
        { RESULTS_FEED_URL: '', RESULTS_WEBHOOK_SECRET: null },
        { RESULTS_FEED_URL: '', RESULTS_WEBHOOK_SECRET: 'set' },
        { RESULTS_FEED_URL: 'https://x', RESULTS_WEBHOOK_SECRET: null },
        { RESULTS_FEED_URL: 'https://x', RESULTS_WEBHOOK_SECRET: 'set' },
      ]) {
        const line = RF.resultsBootStatus(cfg).message;
        if (!cfg.RESULTS_WEBHOOK_SECRET) {
          assert.ok(!/webhook active/i.test(line), `with no secret the line must not announce a webhook: ${line}`);
        }
        if (!cfg.RESULTS_FEED_URL) {
          assert.ok(!/POLL active/i.test(line), `with no URL the line must not announce a poll: ${line}`);
        }
      }
    });

    console.log(`\nresults-webhook.test.js: ${passed} checks passed, ${failures.length} failed`);
    if (failures.length) {
      for (const [name, e] of failures) console.error(`       ${name}: ${e && e.stack}`);
      process.exit(1);
    }
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});