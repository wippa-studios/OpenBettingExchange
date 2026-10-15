'use strict';
// tests/sse-fairness.test.js — who gets a live stream when they are scarce.
//
// Run: node tests/sse-fairness.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. `/api/stream` had ONE cap — `clients.size >= 2000` —
// over a pool in which every stream costs the venue the same and an
// unauthenticated one returns nothing but public `book` frames. One script
// could therefore open all 2000 of them: the attacker's cost was 2000 open TCP
// connections and the venue's was its live UX for everyone, who then got a 503
// on the live-update channel.
//
// A test that opens one stream and makes one API call cannot see any of that,
// so this file does two different things for the two different rules:
//
//   · OVER REAL HTTP, one source competing with one player. Every connection
//     from an offline test shares one loopback address, so this is the only
//     shape that can be reproduced with sockets — and it is the shape the
//     issue describes.
//
//   · AGAINST THE POLICY FUNCTION, for the flood the HTTP shape cannot build.
//     A flood spread across 100 addresses is the one an attacker reaches for
//     after the per-address rule lands, and it is not reproducible from
//     loopback. `streamAdmission` is a pure function of the pool's contents
//     precisely so it can be handed a pool that was built rather than opened.
//
// WHY THE HARNESS HERE DOES NOT HIDE ITS OWN FAILURES. The sibling suite
// (tests/resultsfeed-signal-shape.test.js) exits on its FIRST failure, so in a
// naive run one red check masks every check after it and the rest ship
// unverified. This file reports EVERY failure and only then fails.
process.env.SCRYPT_N = '16384';
process.env.DB_PATH = ':memory:';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
// A small pool so the rules are reachable in a handful of requests. 10 is the
// floor lib/config.js enforces on MAX_SSE_CLIENTS and this suite uses it rather
// than lowering the floor to make its own numbers smaller; the anonymous
// reservation is then ceil(10 × 0.8) = 8.
process.env.MAX_SSE_CLIENTS = '10';
process.env.MAX_SSE_CLIENTS_PER_SOURCE = '3';
process.env.MAX_SSE_CLIENTS_PER_USER = '2';

const assert = require('assert');
const srv = require('../server');
const A = require('../lib/auth');

const GLOBAL = 10;
const PER_SOURCE = 3;
const PER_USER = 2;
const ANON_CAP = Math.ceil(GLOBAL * 0.8); // 8

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

const LIMITS = { global: GLOBAL, perSource: PER_SOURCE, perUser: PER_USER, anonCap: ANON_CAP };

/**
 * Open a stream and keep it OPEN.
 *
 * The handle matters: a stream that is opened and immediately released frees
 * its slot, so a test that opened 3 streams and dropped them would prove
 * nothing about a cap that counts what is CONNECTED. Every reader is left
 * pending and cancelled in the finally block.
 */
async function openStream(base, cookie) {
  const headers = cookie ? { cookie } : {};
  const controller = new AbortController();
  const res = await fetch(`${base}/api/stream`, { headers, signal: controller.signal });
  if (res.status !== 200) {
    let body = null;
    try { body = await res.json(); } catch { /* a 503 JSON body, or nothing */ }
    return { status: res.status, retryAfter: res.headers.get('retry-after'), json: body, close: () => controller.abort() };
  }
  // Start draining so the socket is genuinely held rather than sitting in a
  // full buffer — a response nobody reads is a different thing from a viewer.
  const reader = res.body.getReader();
  reader.read().catch(() => {});
  return { status: res.status, retryAfter: null, json: null, close: () => controller.abort() };
}

(async () => {
  const server = srv.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await srv.ready;

  /**
   * Close streams and WAIT for the server to release their slots.
   *
   * Aborting the client socket is not the same as the server having removed the
   * client from `clients`: that happens on the server's own `close` event, some
   * time after the abort. Without this wait each check leaks its streams into
   * the next one — which is exactly what happened the first time: the second
   * check's first flood stream was refused by the FIRST check's leftovers, and
   * it read as a fairness failure.
   *
   * The wait is by observation, not by sleeping a guessed interval: keep
   * connecting anonymously until the venue accepts one, which can only happen
   * once this address holds fewer than PER_SOURCE streams again.
   */
  async function releaseAll(streams) {
    for (const s of streams) s.close();
    for (let i = 0; i < 100; i++) {
      const probe = await openStream(base);
      if (probe.status === 200) { probe.close(); return; }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('the server never released the streams — aborting the client socket is not enough');
  }

  const j = async (method, path, { body, cookie } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      json: await res.json().catch(() => null),
      setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [],
    };
  };

  // ── S1 ────────────────────────────────────────────────────────────────────
  // The per-source rule, over real sockets. The control comes FIRST: the first
  // PER_SOURCE streams must be ACCEPTED, because a cap that refuses everything
  // would satisfy "the flood is refused" too.
  await check('S1 one address cannot take the pool: an anonymous flood stops at the per-source cap', async () => {
    const held = [];
    try {
      const statuses = [];
      for (let i = 0; i < PER_SOURCE + 2; i++) {
        const s = await openStream(base);
        held.push(s);
        statuses.push(s.status);
      }
      assert.deepStrictEqual(
        statuses.slice(0, PER_SOURCE),
        Array(PER_SOURCE).fill(200),
        `an ordinary viewer inside the per-source budget must get a stream; got ${statuses.join(',')}`
      );
      assert.deepStrictEqual(
        statuses.slice(PER_SOURCE),
        [429, 429],
        `the flood must be refused past it — this is the whole fix; got ${statuses.join(',')}`
      );
      const refused = held[PER_SOURCE];
      assert.ok(refused.retryAfter, 'a caller over its own share must be told when to come back');
      assert.match(refused.json.error, /this address/i, `and must be told the limit is theirs; got ${JSON.stringify(refused.json)}`);
      // And the pool was NOT full: 3 of 10 slots are still free, so the refusal
      // above is the per-source rule rather than the global cap by accident.
      const stillRoom = await j('GET', '/api/sports');
      assert.strictEqual(stillRoom.status, 200, 'the venue is still serving ordinary requests');
    } finally {
      await releaseAll(held);
    }
  });

  // ── S2 ────────────────────────────────────────────────────────────────────
  // THE STARVATION PROPERTY, over real sockets. The flood and the player are on
  // the SAME loopback address — the worst case, because a rule that counted
  // every stream from the address would lock this player out.
  await check('S2 an authenticated player still gets a stream while the flood is running', async () => {
    const flood = [];
    try {
      for (let i = 0; i < PER_SOURCE; i++) flood.push(await openStream(base));
      assert.deepStrictEqual(flood.map((f) => f.status), Array(PER_SOURCE).fill(200), 'the flood is up');

      const login = await j('POST', '/api/auth/login', { body: { username: 'demo', password: 'demo123' } });
      assert.strictEqual(login.status, 200, `the player must be able to sign in: ${JSON.stringify(login.json)}`);
      const cookie = (login.setCookie[0] || '').split(';')[0];

      const player = await openStream(base, cookie);
      try {
        assert.strictEqual(player.status, 200, `a signed-in player must not be starved by anonymous streams from their own address; got ${player.status}`);
        // A second player, on a different account, is equally entitled.
        await A.registerUser(srv.db, { username: 'rival', password: 'rival-password', balance_cents: 0 });
        const rivalLogin = await j('POST', '/api/auth/login', { body: { username: 'rival', password: 'rival-password' } });
        const rival = await openStream(base, (rivalLogin.setCookie[0] || '').split(';')[0]);
        try {
          assert.strictEqual(rival.status, 200, 'and so must a second account');
        } finally {
          rival.close();
        }
      } finally {
        player.close();
      }
    } finally {
      await releaseAll(flood);
    }
  });

  // ── S3 ────────────────────────────────────────────────────────────────────
  // The per-USER half, which the per-source rule does not cover: 2000 tabs is
  // one account, and it is the shape that looks entirely legitimate.
  await check('S3 one account cannot take the pool in tabs', async () => {
    const login = await j('POST', '/api/auth/login', { body: { username: 'demo', password: 'demo123' } });
    const cookie = (login.setCookie[0] || '').split(';')[0];
    const held = [];
    try {
      const statuses = [];
      for (let i = 0; i < PER_USER + 1; i++) {
        const s = await openStream(base, cookie);
        held.push(s);
        statuses.push(s.status);
      }
      assert.deepStrictEqual(
        statuses.slice(0, PER_USER),
        Array(PER_USER).fill(200),
        `a signed-in player may hold several tabs; got ${statuses.join(',')}`
      );
      assert.strictEqual(
        statuses[PER_USER],
        429,
        `the account's own share is bounded; got ${statuses.join(',')}`
      );
      assert.match(held[PER_USER].json.error, /this account/i, `and must be told the limit is the account's; got ${JSON.stringify(held[PER_USER].json)}`);
    } finally {
      await releaseAll(held);
    }
  });

  // ── S4 ────────────────────────────────────────────────────────────────────
  // THE RESERVATION, against the policy function — because this flood is one
  // spread across many sources, which loopback cannot produce.
  //
  // This is the check that makes "a player is never starved" true rather than
  // likely: an attacker who spreads the flood past the per-address rule still
  // cannot take the last fifth of the pool.
  await check('S4 anonymous streams spread across sources still cannot take the pool', () => {
    // One anonymous stream from each of 100 DIFFERENT addresses — the flood
    // that a per-source rule cannot see. Under the old code every one of these
    // was admitted until clients.size reached the global cap.
    const spread = Array.from({ length: ANON_CAP + 40 }, (_, i) => ({ remote: `10.0.0.${i}`, userId: null }));

    // The flood is admitted only as far as the reservation allows.
    let admitted = 0;
    for (const c of spread) {
      if (srv.streamAdmission(spread.slice(0, admitted), c, LIMITS) === null) admitted++;
      else break;
    }
    assert.strictEqual(
      admitted,
      ANON_CAP,
      `anonymous traffic must stop at the reservation (${ANON_CAP}), not the global cap; admitted ${admitted}`
    );
    assert.ok(ANON_CAP < GLOBAL, 'and the reservation must leave real room — a share of 100% would reserve nothing');

    // THE PLAYER. Same rules, same saturated pool — and there is still a slot.
    // The state is the streams that were ACTUALLY admitted, which is what the
    // loop above counted; passing the whole `spread` list would be a pool of 48
    // and the global cap would answer for reasons that have nothing to do with
    // the reservation.
    const pool = spread.slice(0, admitted);
    const player = { remote: '10.0.0.99', userId: 7 };
    const refusal = srv.streamAdmission(pool, player, LIMITS);
    assert.strictEqual(
      refusal,
      null,
      `an authenticated player must be admitted while anonymous streams fill the pool; got ${JSON.stringify(refusal)}`
    );

    // And the reservation is a CEILING on anonymous traffic, not a floor on
    // players: when the pool is genuinely full, nobody is admitted, including
    // the player. A reservation that ignored the global cap would over-admit.
    const full = Array.from({ length: GLOBAL }, (_, i) => ({ remote: `10.0.1.${i}`, userId: null }));
    assert.deepStrictEqual(
      srv.streamAdmission(full, player, LIMITS),
      { status: 503, error: 'Too many concurrent streams' },
      'a full pool refuses everyone'
    );
  });

  // ── S5 ────────────────────────────────────────────────────────────────────
  // The controls for S4, in the same shape, so a reservation that refused
  // EVERYONE would not pass it.
  await check('S5 the reservation admits players and refuses them only for their own reasons', () => {
    const empty = [];
    assert.strictEqual(srv.streamAdmission(empty, { remote: '1.1.1.1', userId: null }, LIMITS), null, 'an empty pool admits anyone');
    assert.strictEqual(srv.streamAdmission(empty, { remote: '1.1.1.1', userId: 3 }, LIMITS), null, 'and any player');

    // One player alone, past the per-USER cap: the refusal is the ACCOUNT's,
    // not the pool's.
    const mine = Array.from({ length: PER_USER }, (_, i) => ({ remote: `9.9.9.${i}`, userId: 3 }));
    const refusal = srv.streamAdmission(mine, { remote: '9.9.9.200', userId: 3 }, LIMITS);
    assert.strictEqual(refusal.status, 429, 'a player over their own cap is refused');
    assert.ok(/this account/i.test(refusal.error), 'and the message must name the account, not the venue');
    // …and a DIFFERENT player is unaffected by the first one's tabs.
    assert.strictEqual(srv.streamAdmission(mine, { remote: '9.9.9.200', userId: 4 }, LIMITS), null, 'another player is unaffected');

    // One anonymous viewer at the source cap: the refusal is the ADDRESS's.
    const fromOne = Array.from({ length: PER_SOURCE }, () => ({ remote: '8.8.8.8', userId: null }));
    const anonRefusal = srv.streamAdmission(fromOne, { remote: '8.8.8.8', userId: null }, LIMITS);
    assert.strictEqual(anonRefusal.status, 429, 'an anonymous viewer over the source cap is refused');
    assert.ok(/this address/i.test(anonRefusal.error), 'and the message must name the address');
    // …and an authenticated player behind that SAME address is admitted, which
    // is the whole reason the source cap counts anonymous streams only.
    assert.strictEqual(
      srv.streamAdmission(fromOne, { remote: '8.8.8.8', userId: 5 }, LIMITS),
      null,
      'a signed-in player behind a saturated anonymous address must still be admitted'
    );
  });

  console.log(`\nsse-fairness.test.js: ${passed} checks passed, ${failures.length} failed`);
  server.close();
  if (failures.length) process.exit(1);
  if (passed !== 5) { console.error(`expected 5 checks, ran ${passed}`); process.exit(1); }
})();