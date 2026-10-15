// orderlife.test.js — the HTTP surface of the order lifecycle (#97).
// Run: node tests/orderlife.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS SEPARATELY FROM tests/amend.test.js. The engine suite
// proves what an amend, a bulk cancel and a lapse DO. It cannot prove that the
// routes are wired to them, that the route-level validation (a non-integer `:id`
// is a 400, not a 500) exists, or that a partial bulk cancel reaches a client as
// 200 with per-order outcomes rather than as an exception.
//
// That gap is not hypothetical in this repository. tests/shutdown.test.js was
// written after `stopAll()` shipped with ZERO CALLERS — implemented, correct,
// and unreachable — and its whole reason for existing is that a unit test
// proves a function works and says nothing about whether anything calls it. The
// three routes below are the same shape of claim, so they are called over real
// HTTP here.
//
// Its own process, and it boots the server itself, so a failure in server.js
// cannot take the engine suite down with it and make one broken wire look like a
// broken engine.
'use strict';

// scrypt cost: this suite creates accounts and pays the hash once each, and
// asserts NOTHING about the stored hash format. auth.test.js owns that.
process.env.SCRYPT_N = '16384';
process.env.DB_PATH = ':memory:';
process.env.DRIFT_ENABLED = 'false';
process.env.BOT_ENABLED = 'false';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const srv = require('../server');

let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(e);
    process.exit(1);
  }
  passed++;
  console.log('  ok', name);
};

(async () => {
  const server = srv.app.listen(0, '127.0.0.1'); // loopback only
  await new Promise((resolve) => server.on('listening', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const j = async (method, path, { body, cookie } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  };
  const login = async (username, password) => {
    const r = await fetch(base + '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    const raw = setCookie.find((c) => c.startsWith('ob_session='));
    assert.ok(raw, `registering ${username} produced no session`);
    return raw.split(';')[0];
  };

  // A venue of our own, so nothing the seed created can match against it and the
  // assertions are about THIS feature rather than about whatever liquidity
  // happened to be resting.
  const sport = (() => {
    const existing = srv.db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
    if (existing) return existing;
    srv.db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
    return srv.db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  })();
  srv.db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, 'Lifecycle Event', datetime('now','+2 hours'))").run(sport.id);
  const ev = srv.db.prepare("SELECT id FROM events WHERE name = 'Lifecycle Event'").get();
  srv.db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const marketId = srv.db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id).id;
  const selIds = {};
  for (const [name, fair] of [['Alpha', 2.0], ['Beta', 2.2]]) {
    srv.db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(marketId, name, fair);
    selIds[name] = srv.db.prepare('SELECT id FROM selections WHERE market_id = ? AND name = ?').get(marketId, name).id;
  }
  const s1 = selIds.Alpha;
  const s2 = selIds.Beta;

  const alice = await login('life-alice', 'secret1');
  const bob = await login('life-bob', 'secret2');
  await j('POST', '/api/wallet/deposit', { body: { amount_cents: 100000 }, cookie: alice });
  await j('POST', '/api/wallet/deposit', { body: { amount_cents: 100000 }, cookie: bob });

  const wallet = async (cookie) => (await j('GET', '/api/wallet', { cookie })).json;
  const place = (cookie, body) => j('POST', '/api/orders', { body, cookie });
  // A price band nothing is resting in, so a placement is a REST and the escrow
  // assertions are about escrow rather than about a match.
  const PLACE = (n, extra = {}) => ({ selection_id: s2, side: 'back', price: 1.1, stake_cents: n, ...extra });
  const restId = async (cookie, n, extra) => {
    const r = await place(cookie, PLACE(n, extra));
    assert.strictEqual(r.status, 201, `placing failed: ${JSON.stringify(r.json)}`);
    assert.strictEqual(r.json.order.status, 'open', 'precondition: it rests rather than matching');
    return r.json.order.id;
  };

  await check('R1 POST /api/orders accepts persistence, and the default is PERSIST', async () => {
    const lapsing = await place(alice, PLACE(1000, { persistence: 'LAPSE' }));
    assert.strictEqual(lapsing.status, 201);
    assert.strictEqual(lapsing.json.order.persistence, 'LAPSE');

    // THE COMPATIBILITY CONTRACT: a client that says nothing gets the behaviour
    // it got before #97. This is the assertion that fails if the feature ever
    // ships with LAPSE as the default, which would silently start cancelling
    // every resting book on the venue.
    const plain = await place(alice, PLACE(1000));
    assert.strictEqual(plain.status, 201);
    assert.strictEqual(plain.json.order.persistence, 'PERSIST');

    const listed = await j('GET', '/api/orders', { cookie: alice });
    assert.strictEqual(listed.status, 200);
    const byId = new Map(listed.json.orders.map((o) => [o.id, o]));
    assert.strictEqual(byId.get(lapsing.json.order.id).persistence, 'LAPSE', 'a client can see how long the venue will keep each order');
    assert.strictEqual(byId.get(plain.json.order.id).persistence, 'PERSIST');

    // An unsupported value is a 400 at the edge, writing nothing.
    const bad = await place(alice, PLACE(1000, { persistence: 'MARKET_ON_CLOSE' }));
    assert.strictEqual(bad.status, 400);
    assert.match(bad.json.error, /persistence must be "LAPSE" or "PERSIST"/);
    const after = await wallet(alice);
    // Both placements above are still escrowed, and the refused one added
    // nothing — asserted as a NUMBER rather than as "the call threw".
    assert.strictEqual(after.frozen_cents, 2000, 'the refused placement froze no collateral');
  });

  await check('R2 PATCH /api/orders/:id amends size, one transaction, with the delta in the response', async () => {
    const id = await restId(alice, 10000);
    const before = await wallet(alice);

    const r = await j('PATCH', `/api/orders/${id}`, { body: { stake_cents: 4000 }, cookie: alice });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    // The id is the queue position, so it MUST be the same row.
    assert.strictEqual(r.json.order.id, id);
    assert.strictEqual(r.json.order.stake_cents, 4000);
    assert.strictEqual(r.json.order.price, 1.1, 'the price is untouched');
    assert.strictEqual(r.json.size_changed, true);
    assert.strictEqual(r.json.price_changed, false);
    assert.strictEqual(r.json.escrow_delta_cents, -6000, 'signed: collateral came back');
    // The book rides along so a client running the #92 handshake does not need a
    // second request to learn the version its next order should claim.
    assert.ok(Number.isInteger(r.json.market_version), 'market_version is present');
    assert.ok(Array.isArray(r.json.book), 'and the book is, exactly as a placement returns it');
    const after = await wallet(alice);
    assert.strictEqual(after.frozen_cents, before.frozen_cents - 6000, 'exactly the delta was released');
    assert.strictEqual(after.balance_cents, before.balance_cents, 'and no balance moved');

    // A price amend on a BACK moves NO collateral, and saying so is half the
    // contract: the escrow of a back is the stake, whatever the price. An
    // implementation that "adjusted" it here would be inventing money.
    const p = await j('PATCH', `/api/orders/${id}`, { body: { price: 1.2 }, cookie: alice });
    assert.strictEqual(p.status, 200);
    assert.strictEqual(p.json.price_changed, true);
    assert.strictEqual(p.json.size_changed, false);
    assert.strictEqual(p.json.escrow_delta_cents, 0, "a back's escrow is its stake, not a function of price");
    assert.strictEqual(p.json.order.price, 1.2);

    // The other half: on a LAY the price IS the liability, so the same call
    // moves collateral — and the amount is round((price - 1) * remainder).
    const lay = await j('POST', '/api/orders', {
      body: { selection_id: s2, side: 'lay', price: 1.05, stake_cents: 1000 },
      cookie: bob,
    });
    assert.strictEqual(lay.status, 201);
    assert.strictEqual(lay.json.order.status, 'open', 'precondition: it rests rather than sweeping the 1.1 backs');
    const bobBefore = await wallet(bob);
    const amended = await j('PATCH', `/api/orders/${lay.json.order.id}`, { body: { price: 1.09 }, cookie: bob });
    assert.strictEqual(amended.status, 200, JSON.stringify(amended.json));
    // round(0.09 * 1000) - round(0.05 * 1000) = 90 - 50.
    assert.strictEqual(amended.json.escrow_delta_cents, 40, "a layer's escrow follows the price");
    const bobAfter = await wallet(bob);
    assert.strictEqual(bobAfter.frozen_cents, bobBefore.frozen_cents + 40, 'and exactly that much was escrowed');
    assert.strictEqual(bobAfter.balance_cents, bobBefore.balance_cents);
  });

  await check('R3 PATCH refuses what it must, and says why', async () => {
    const id = await restId(alice, 5000);

    const empty = await j('PATCH', `/api/orders/${id}`, { body: {}, cookie: alice });
    assert.strictEqual(empty.status, 400, 'a no-op amend is refused, not answered 200');
    assert.match(empty.json.error, /Nothing to amend/);

    // A non-integer path id is a 400 from intId, never a 500 and never a silent
    // "not found" that would send a client looking in the wrong place.
    const badId = await j('PATCH', '/api/orders/not-a-number', { body: { stake_cents: 1000 }, cookie: alice });
    assert.strictEqual(badId.status, 400);

    // A stranger's order is 404 — the same answer an id that does not exist
    // gives, so the route is not an oracle for which ids are real.
    const bobOrder = await restId(bob, 2000);
    const notYours = await j('PATCH', `/api/orders/${bobOrder}`, { body: { stake_cents: 1000 }, cookie: alice });
    const notThere = await j('PATCH', '/api/orders/987654', { body: { stake_cents: 1000 }, cookie: alice });
    assert.strictEqual(notYours.status, 404);
    assert.strictEqual(notThere.status, 404);
    assert.strictEqual(notYours.json.error, notThere.json.error, 'identical answers');

    // The refused amends left the order exactly as it was.
    const listed = await j('GET', '/api/orders', { cookie: alice });
    const row = listed.json.orders.find((o) => o.id === id);
    assert.strictEqual(row.stake_cents, 5000, 'and moved no collateral');
  });

  await check('R4 POST /api/orders/bulk-cancel returns per-order outcomes, and a partial one is 200', async () => {
    const a = await restId(alice, 1000);
    const b = await restId(alice, 2000);
    const stranger = await restId(bob, 3000);
    const before = await wallet(alice);
    const bobBefore = await wallet(bob);

    const r = await j('POST', '/api/orders/bulk-cancel', {
      body: { order_ids: [a, stranger, 987654, b] },
      cookie: alice,
    });
    // 200 even though two ids failed: a batch of four in which two worked IS a
    // success that happened, and any other status leaves the client unable to
    // tell which two.
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.cancelled, 2);
    assert.strictEqual(r.json.failed, 2);
    assert.strictEqual(r.json.released_cents, 3000, "alice's two orders, and not one cent of bob's");
    assert.deepStrictEqual(
      r.json.results.map((x) => [x.order_id, x.status]),
      [[a, 'cancelled'], [stranger, 'not_found'], [987654, 'not_found'], [b, 'cancelled']],
      'one outcome per id, in the order the client sent them'
    );
    assert.ok(Array.isArray(r.json.market_ids) && r.json.market_ids.includes(marketId), 'the books that changed are named, so the route broadcasts once per market');

    const after = await wallet(alice);
    assert.strictEqual(after.frozen_cents, before.frozen_cents - 3000, 'exactly the authorised subset was released');
    const bobAfter = await wallet(bob);
    assert.strictEqual(bobAfter.frozen_cents, bobBefore.frozen_cents, "a stranger's escrow is untouched");
    const bobOrders = await j('GET', '/api/orders', { cookie: bob });
    assert.ok(bobOrders.json.orders.some((o) => o.id === stranger), 'and their order is still open');
  });

  await check('R5 a malformed bulk list is a 400 that cancels NOTHING', async () => {
    const id = await restId(alice, 1000);
    const before = await wallet(alice);
    const listedBefore = (await j('GET', '/api/orders', { cookie: alice })).json.orders.length;

    // A bare string — the #29 payload class, in a list-shaped field.
    const asString = await j('POST', '/api/orders/bulk-cancel', { body: { order_ids: String(id) }, cookie: alice });
    assert.strictEqual(asString.status, 400);
    // A list with one unusable element, which must refuse the WHOLE request
    // rather than cancelling the usable one.
    const partlyBad = await j('POST', '/api/orders/bulk-cancel', { body: { order_ids: [id, '1 OR 1=1'] }, cookie: alice });
    assert.strictEqual(partlyBad.status, 400);
    assert.match(partlyBad.json.error, /order_ids\[1\] must be a positive integer/);
    const missingField = await j('POST', '/api/orders/bulk-cancel', { body: {}, cookie: alice });
    assert.strictEqual(missingField.status, 400);

    const after = await wallet(alice);
    assert.strictEqual(after.frozen_cents, before.frozen_cents, 'no collateral moved on any of them');
    const listedAfter = (await j('GET', '/api/orders', { cookie: alice })).json.orders.length;
    assert.strictEqual(listedAfter, listedBefore, 'and no order changed state');
    assert.ok((await j('GET', '/api/orders', { cookie: alice })).json.orders.some((o) => o.id === id), 'the target order is still open');
  });

  await check('R6 the new routes need a session, like every other money route', async () => {
    const id = await restId(alice, 1000);
    assert.strictEqual((await j('PATCH', `/api/orders/${id}`, { body: { stake_cents: 500 } })).status, 401);
    assert.strictEqual((await j('POST', '/api/orders/bulk-cancel', { body: { order_ids: [id] } })).status, 401);
    // …and the order really is untouched by the unauthenticated attempts.
    const row = (await j('GET', '/api/orders', { cookie: alice })).json.orders.find((o) => o.id === id);
    assert.strictEqual(row.stake_cents, 1000);
  });

  await check('R7 the whole lifecycle over HTTP: place, amend at an unchanged price, bulk cancel', async () => {
    // The integration shape the issue describes, end to end and over real HTTP:
    // two resting orders, one resized in place, the pair cancelled in ONE call.
    const first = await restId(alice, 1000);
    const second = await restId(alice, 2000);
    const before = await wallet(alice);

    const amended = await j('PATCH', `/api/orders/${first}`, { body: { stake_cents: 1500 }, cookie: alice });
    assert.strictEqual(amended.status, 200);
    assert.strictEqual(amended.json.order.id, first, 'same order, not a replacement');
    const mid = await wallet(alice);
    assert.strictEqual(mid.frozen_cents, before.frozen_cents + 500, 'the increase was escrowed');

    const cancelled = await j('POST', '/api/orders/bulk-cancel', { body: { order_ids: [first, second] }, cookie: alice });
    assert.strictEqual(cancelled.status, 200);
    assert.strictEqual(cancelled.json.cancelled, 2);
    const after = await wallet(alice);
    assert.strictEqual(after.frozen_cents, mid.frozen_cents - 3500, 'both orders came back exactly');
    assert.strictEqual(after.balance_cents, mid.balance_cents, 'and nothing was charged');
    const open = (await j('GET', '/api/orders', { cookie: alice })).json.orders.map((o) => o.id);
    assert.ok(!open.includes(first) && !open.includes(second), 'neither is open any more');
  });

  await check('R8 the venue is still consistent after every route above', async () => {
    // The last line, and the one that matters: a lifecycle feature that leaves
    // the books unbalanced has moved money that cannot be recovered. Asserted
    // against the same helpers the engine suite uses rather than a summary of
    // its own, so a pass here means the whole thing agrees.
    const acc = require('../lib/accounts');
    assert.strictEqual(acc.assertConserved(srv.db), 0, 'the ledger is not conserved');
    assert.deepStrictEqual(acc.assertUserAgrees(srv.db), [], 'a wallet disagrees with its postings');
  });

  // R9: THE LAPSE SWEEP IS NOT RIDING THE DELAY-RELEASE KNOB.
  //
  // A structural check, and deliberately so — the same shape guard.test.js uses
  // for `orders.frozen_cents`. What is pinned here is a WIRING fact that no
  // behavioural test of the engine can see: `lapseOrders` is reached from
  // server.js, and the only question is which guard reaches it.
  //
  // It shipped nested inside `if (JOBS_INTERVALS.delayReleaseMs > 0)`, so an
  // operator setting DELAY_RELEASE_INTERVAL_MS=0 — a documented, supported value,
  // and the natural one for a venue that has withdrawn in-play — silently got no
  // lapse sweep at all. Every order marked LAPSE then rested forever, no log line
  // said so, and every engine test passed because they call `lapseOrders`
  // directly. A control that only runs when an unrelated toggle is on is the
  // dead-control shape this repository keeps finding; this check is what makes
  // the decoupling a fact rather than a comment.
  await check('R9 the lapse sweep has its own timer and does not ride the delay-release knob', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /lapseMs: Number\(process\.env\.LAPSE_INTERVAL_MS/, 'LAPSE_INTERVAL_MS is its own knob');
    assert.match(
      src,
      /if \(JOBS_INTERVALS\.lapseMs > 0\) \{[\s\S]*?JOBS\.every\(JOBS_INTERVALS\.lapseMs[\s\S]*?MATCH\.lapseOrders\(db\)/,
      'the sweep is registered under the lapse guard'
    );

    // The specific coupling that shipped: the sweep must NOT be reachable from
    // the delay-release block. Bounded slice, so this cannot drift onto an
    // unrelated later `if` when the file grows.
    const guardAt = src.indexOf('if (JOBS_INTERVALS.delayReleaseMs > 0) {');
    assert.ok(guardAt > -1, 'the delay-release guard still exists — this file changed shape, re-pin it');
    const delayBlock = src.slice(guardAt, src.indexOf('\n}\n', guardAt));
    assert.ok(
      !/lapseOrders/.test(delayBlock),
      'lapseOrders is reachable from the delay-release block again — DELAY_RELEASE_INTERVAL_MS=0 would kill it silently'
    );

    // Disabling it is loud rather than silent, because the failure this fixes
    // produced no log line at all. Anchored on the `else` arm, so this cannot be
    // satisfied by an unrelated warning elsewhere in the file.
    assert.match(
      src,
      /if \(JOBS_INTERVALS\.lapseMs > 0\) \{[\s\S]*?\} else \{[\s\S]*?console\.warn\('\[lapse\] LAPSE_INTERVAL_MS=0/,
      'turning it off warns at boot'
    );
  });

  server.close();
  console.log(`\norderlife.test.js: ${passed} checks passed`);
  if (passed < 9) { console.error('expected 9 checks'); process.exit(1); }
})();