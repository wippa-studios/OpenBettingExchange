// api.test.js — HTTP integration, fully offline:
//   :memory: DB (via env BEFORE requires), ephemeral port-0 server,
//   BOT_ENABLED=false, DRIFT_ENABLED=false.
// Flow: register → deposit → board → place orders → match → positions →
//       admin settle → wallet reflects credit net of commission.
'use strict';

// scrypt cost: this suite creates many accounts and pays the hash once per
// account, but asserts NOTHING about the stored hash format. auth.test.js
// runs at the real default (SCRYPT_N=65536) and owns that coverage.
process.env.SCRYPT_N = '16384';
process.env.DB_PATH = ':memory:';
process.env.DRIFT_ENABLED = 'false';
process.env.BOT_ENABLED = 'false';

const assert = require('assert');
const srv = require('../server');
// Only for `verifyPassword`, so the first-run-lock checks below can sign in with
// whichever password the seeded demo account currently holds.
const A = require('../lib/auth');

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log('  ok', name);
};

(async () => {
  const server = srv.app.listen(0, '127.0.0.1'); // loopback only
  await new Promise((resolve) => server.on('listening', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const j = async (method, path, { body, cookie, origin } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    let json = null;
    try {
      json = await res.json();
    } catch {}
    // Headers are returned as a plain object so a test can assert on them
    // (content-type, content-disposition). The reporting routes are the first
    // thing in this codebase whose CORRECTNESS is partly in their headers — a
    // CSV export an operator cannot attribute or that a browser renders inline
    // instead of downloading is wrong in a way a status code cannot show.
    const respHeaders = {};
    for (const [k, v] of res.headers) respHeaders[k] = v;
    return { status: res.status, json, setCookie, headers: respHeaders };
  };
  const cookieOf = (r) => (r.setCookie.find((c) => c.startsWith('ob_session=')) || '').split(';')[0];

  // SSE reader helper: returns an awaitable that resolves true once a frame
  // `event: <name>` has arrived on the stream (bounded by a timeout so a
  // missing broadcast fails fast instead of hanging the suite).
  const sseWaiter = (reader) => {
    const dec = new TextDecoder();
    let buf = '';
    return (name, ms = 5000) => {
      const scan = async () => {
        for (;;) {
          if (buf.includes(`event: ${name}\n`)) return true;
          const { value, done } = await reader.read();
          if (done) return false;
          buf += dec.decode(value, { stream: true });
        }
      };
      const timeout = new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for SSE "event: ${name}"`)), ms);
        if (t.unref) t.unref();
      });
      return Promise.race([scan(), timeout]);
    };
  };

  try {
    // ── register + auto-login ──────────────────────────────────────────
    await check('register → 201 + session cookie + user', async () => {
      const r = await j('POST', '/api/auth/register', { body: { username: 'alice', password: 'secret1' } });
      assert.strictEqual(r.status, 201);
      assert.ok(r.json.user && r.json.user.username === 'alice');
      assert.strictEqual(r.json.user.pass_hash, undefined);
      assert.ok(cookieOf(r).startsWith('ob_session='));
    });

    const aliceLogin = await j('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } });
    const alice = cookieOf(aliceLogin);
    const bobLogin = await j('POST', '/api/auth/register', { body: { username: 'bob', password: 'secret2' } });
    const bob = cookieOf(bobLogin);
    await j('POST', '/api/wallet/deposit', { body: { amount_cents: 50000 }, cookie: bob }); // faucet before trading

    await check('401 without session', async () => {
      const r = await j('GET', '/api/me');
      assert.strictEqual(r.status, 401);
    });

    // ── faucet deposit ─────────────────────────────────────────────────
    await check('deposit + faucet cap', async () => {
      const r = await j('POST', '/api/wallet/deposit', { body: { amount_cents: 50000 }, cookie: alice });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.balance_cents, 50000);
      const over = await j('POST', '/api/wallet/deposit', { body: { amount_cents: 100001 }, cookie: alice });
      assert.strictEqual(over.status, 400);
      const bad = await j('POST', '/api/wallet/deposit', { body: { amount_cents: -5 }, cookie: alice });
      assert.strictEqual(bad.status, 400);
    });

    // ── board ──────────────────────────────────────────────────────────
    let marketId = null;
    let selId = null;
    await check('sports + events board (seeded)', async () => {
      const sp = await j('GET', '/api/sports');
      assert.strictEqual(sp.status, 200);
      assert.ok(sp.json.sports.some((s) => s.slug === 'football'));
      const ev = await j('GET', '/api/events?sport=football');
      assert.strictEqual(ev.status, 200);
      assert.ok(ev.json.events.length >= 4);
      const m = ev.json.events[0].markets[0];
      assert.ok(m && m.selections.length >= 2);
      marketId = m.id;
      selId = m.selections[0].selection_id;
      // prices are valid ladder ticks with 2dp
      for (const sel of m.selections) {
        assert.ok(sel.back.every((l) => l.price >= 1.01 && l.price <= 1000));
      }
    });

    // ── trading: alice back (rests) → bob lay (matches) ─────────────────
    await check('place order → rests without liquidity', async () => {
      const r = await j('POST', '/api/orders', { body: { selection_id: selId, side: 'back', price: 2.5, stake_cents: 10000 }, cookie: alice });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.json.order.status, 'open');
      assert.strictEqual(r.json.order.matched_cents, 0);
    });

    await check('bob lay matches alice back at resting price', async () => {
      const r = await j('POST', '/api/orders', { body: { selection_id: selId, side: 'lay', price: 2.5, stake_cents: 10000 }, cookie: bob });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.json.order.status, 'fully_matched');
      assert.deepStrictEqual(r.json.fills, [{ price: 2.5, stake_cents: 10000 }]);
      // bob's liability escrow (2.5-1)*10000 = 15000
      const me = await j('GET', '/api/me', { cookie: bob });
      assert.strictEqual(me.json.user.frozen_cents, 15000);
    });

    await check('positions matrix + escrow', async () => {
      const r = await j('GET', '/api/positions', { cookie: alice });
      assert.strictEqual(r.status, 200);
      const pos = r.json.positions.find((p) => p.market_id === marketId);
      assert.ok(pos);
      const leg = pos.selections.find((s) => s.selection_id === selId);
      assert.strictEqual(leg.my_back_stake_cents, 10000);
      assert.strictEqual(leg.frozen_cents, 10000);
      // if-win P&L: +15000 profit; if-lose: -10000
      const pnlWin = pos.pnl_if_win.find((x) => x.selection_id === selId);
      assert.strictEqual(pnlWin.pnl_cents, 15000);
    });

    await check('open orders list + validation errors', async () => {
      const bad = await j('POST', '/api/orders', { body: { selection_id: selId, side: 'back', price: 2.5, stake_cents: '10000' }, cookie: alice });
      assert.strictEqual(bad.status, 400);
      const low = await j('POST', '/api/orders', { body: { selection_id: selId, side: 'back', price: 2.5, stake_cents: 50 }, cookie: alice });
      assert.strictEqual(low.status, 400);
    });

    // ── admin: settle → wallet reflects credit net of commission ────────
    await check('admin settle → settlement credit net of commission', async () => {
      const adminLogin = await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
      assert.strictEqual(adminLogin.status, 200);
      const admin = cookieOf(adminLogin);
      const r = await j('POST', `/api/admin/markets/${marketId}/settle`, { body: { winner_selection_id: selId }, cookie: admin });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.market.status, 'settled');
      // alice: 50000 + 15000 profit - round(15000*0.025)=375 → 64625
      const w = await j('GET', '/api/wallet', { cookie: alice });
      assert.strictEqual(w.json.balance_cents, 64625);
      assert.strictEqual(w.json.frozen_cents, 0);
      // bob: lost his liability (2.5-1)*10000 = 15000 → 50000 - 15000 = 35000
      const wb = await j('GET', '/api/wallet', { cookie: bob });
      assert.strictEqual(wb.json.balance_cents, 35000);
      // settled market rejects orders
      const po = await j('POST', '/api/orders', { body: { selection_id: selId, side: 'back', price: 2.5, stake_cents: 10000 }, cookie: alice });
      assert.strictEqual(po.status, 409);
    });

    // ── admin stats + role guards ───────────────────────────────────────
    await check('admin stats + role guard', async () => {
      const adminLogin = await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
      const admin = cookieOf(adminLogin);
      const r = await j('GET', '/api/admin/stats', { cookie: admin });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.markets.length >= 1);
      const forbidden = await j('GET', '/api/admin/stats', { cookie: alice });
      assert.strictEqual(forbidden.status, 403);
    });

    // ── origin guard ────────────────────────────────────────────────────
    await check('origin guard: foreign origin 403', async () => {
      const r = await j('POST', '/api/wallet/deposit', { body: { amount_cents: 100 }, cookie: alice, origin: 'https://evil.example' });
      assert.strictEqual(r.status, 403);
      const ok = await j('POST', '/api/wallet/deposit', { body: { amount_cents: 100 }, cookie: alice, origin: `http://127.0.0.1:${port}` });
      assert.strictEqual(ok.status, 200);
    });

    // ── settlements history ─────────────────────────────────────────────
    await check('settlements history reflects the settle', async () => {
      const r = await j('GET', '/api/settlements', { cookie: alice });
      assert.strictEqual(r.status, 200);
      const row = r.json.settlements.find((x) => x.market_id === marketId);
      assert.ok(row, 'settlement row present');
      assert.strictEqual(row.pnl_cents, 15000);
      assert.strictEqual(row.commission_cents, 375);
      assert.ok(row.event_name, 'event name joined');
    });

    // ── API hygiene: JSON 404, no HTML leaking to API clients ───────────
    await check('unknown /api path answers JSON 404', async () => {
      const r = await j('GET', '/api/nope');
      assert.strictEqual(r.status, 404);
      assert.ok(r.json && r.json.error, 'JSON error body');
    });

    // #3. Money-bearing responses must say `no-store`. These are cookie-
    // authenticated GETs carrying balances and per-runner exposure — the shape a
    // shared proxy caches, and the shape it serves back to the WRONG user if the
    // cache key ignores the cookie. Asserted on the HEADER, not the status: a 200
    // with no cache directive is exactly the bug.
    await check('money routes answer no-store so no proxy may cache a balance', async () => {
      for (const path of ['/api/me', '/api/wallet', '/api/positions', '/api/settlements', '/api/orders']) {
        const r = await j('GET', path, { cookie: alice });
        assert.strictEqual(r.status, 200, `${path} answers 200`);
        // Assert the directive is EXACTLY no-store. `assert.ok(/no-store/...)`
        // would also pass on `public, no-store`, which permits a shared cache.
        assert.strictEqual(
          r.headers['cache-control'],
          'no-store',
          `${path} must answer Cache-Control: no-store (got ${JSON.stringify(r.headers['cache-control'])})`
        );
      }
    });

    await check('foreign origin rejected even with a malformed body', async () => {
      const res = await fetch(`${base}/api/wallet/deposit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: alice },
        body: '{not json',
      });
      assert.strictEqual(res.status, 403); // guard runs before the body parser
    });


    // ── price formats (the pricing library, exposed for the desk) ──────
    await check('GET /api/format returns every format from lib/odds', async () => {
      const r = await j('GET', '/api/format/2.5');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.decimal, 2.5);
      assert.strictEqual(r.json.american, '+150');
      assert.strictEqual(r.json.fractional, '3/2');
      assert.ok(Math.abs(r.json.implied_prob - 0.4) < 1e-12);
      const short = await j('GET', '/api/format/1.4');
      assert.strictEqual(short.json.american, '-250');
      assert.strictEqual(short.json.fractional, '2/5');
    });

    // #37. The route snapped FIRST and validated the snapped value, which made the
    // 400 branch dead by construction: snapToTick clamps to [1.01, 1000] and
    // always returns a tick, so `GET /api/format/5000` answered 200 {decimal:
    // 1000}. A caller checking a price was told a DIFFERENT price was fine.
    //
    // The off-tick case stays 200 on purpose: the desk's fair-price helper shows
    // a trader what the engine would make of a hand-typed near-miss, and
    // POST /api/orders documents the same clamp. Only a number that is not a
    // price at all is refused.
    await check('GET /api/format refuses a price outside the ladder instead of clamping', async () => {
      // Off-tick but IN range: still snapped. The desk depends on this.
      const snap = await j('GET', '/api/format/2.75'); // 2.75 is not a tick
      assert.strictEqual(snap.status, 200, 'an off-tick price inside the ladder is still snapped');
      assert.ok([2.74, 2.76].includes(snap.json.decimal), `snapped to ${snap.json.decimal}`);

      assert.strictEqual((await j('GET', '/api/format/abc')).status, 400, 'non-numeric is refused');

      // Out of range in every direction. Before the fix each answered 200 with a
      // confident clamp — 5000 -> 1000, 0.5 -> 1.01.
      for (const bad of ['5000', '1000.01', '-5', '0.5', '0']) {
        const r = await j('GET', `/api/format/${bad}`);
        assert.strictEqual(r.status, 400, `${bad} is outside the ladder and must be refused (got ${r.status})`);
        assert.strictEqual(r.json.error, 'Price is outside the 1.01-1000 ladder', `and says why (${bad})`);
        // The decisive assertion: a clamp would answer 200, so a body carrying
        // a DIFFERENT price than the one asked for must not exist at all.
        assert.strictEqual(r.json.decimal, undefined, `${bad} must not come back as some other price`);
      }

      // Both ends of the ladder itself are IN range, and must still answer.
      for (const good of ['1.01', '1000']) {
        const r = await j('GET', `/api/format/${good}`);
        assert.strictEqual(r.status, 200, `${good} is on the ladder and must answer (got ${r.status})`);
        assert.strictEqual(r.json.decimal, Number(good), `${good} is returned unchanged`);
      }
    });

    // ── admin stats carry the per-market overround ──────────────────────
    await check('admin stats include a per-market overround', async () => {
      const adminLogin = await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
      const r = await j('GET', '/api/admin/stats', { cookie: cookieOf(adminLogin) });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.markets.length >= 1);
      for (const m of r.json.markets) {
        assert.ok(m.overround === null || typeof m.overround === 'number', 'overround is a number or null');
      }
    });

    // ── a 5xx must never leak internals to the client ───────────────────
    await check('error handler hides 5xx detail but keeps 4xx messages', async () => {
      const sent = {};
      const res = {
        status(code) { sent.code = code; return this; },
        json(body) { sent.body = body; },
      };
      srv.errorHandler(
        Object.assign(new Error('UNIQUE constraint failed: users.username at /srv/data/db'), { status: 500 }),
        {}, res, () => {}
      );
      assert.strictEqual(sent.code, 500);
      assert.deepStrictEqual(sent.body, { error: 'Internal error' });
      assert.ok(!JSON.stringify(sent.body).includes('UNIQUE'));

      srv.errorHandler(Object.assign(new Error('Insufficient available balance'), { status: 400 }), {}, res, () => {});
      assert.strictEqual(sent.code, 400);
      assert.deepStrictEqual(sent.body, { error: 'Insufficient available balance' });
    });

    // ── SSE stream ──────────────────────────────────────────────────────
    await check('SSE stream responds with event-stream', async () => {
      const res = await fetch(`${base}/api/stream`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type').startsWith('text/event-stream'));
      const reader = res.body.getReader();
      const { value } = await reader.read();
      assert.ok(new TextDecoder().decode(value).includes('retry:'));
      await reader.cancel();
    });

    // ── W1: a malformed cookie escape must not 500 the whole request ──────
    await check('malformed cookie escape never 500s (sibling-app cookie)', async () => {
      const r = await j('GET', '/api/sports', { cookie: 'ob_session=%; other=%%' });
      assert.strictEqual(r.status, 200);
      assert.ok(Array.isArray(r.json.sports));
    });

    // ── Bearer tokens authenticate exactly like the session cookie ────────
    await check('Bearer token authenticates without a cookie', async () => {
      const login = await j('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } });
      const token = cookieOf(login).split('=')[1];
      assert.ok(token.length >= 32, 'opaque token');
      const res = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.user.username, 'alice');
    });

    // ── S6: the feed board limit clamps to [1, 500] (pure helper) ────────
    await check('feed board limit clamps to [1, 500]', async () => {
      assert.strictEqual(srv.clampFeedLimit('abc', 60), 60); // junk → default
      assert.strictEqual(srv.clampFeedLimit(undefined, 60), 60); // absent → default
      assert.strictEqual(srv.clampFeedLimit(0, 60), 1); // clamped up
      assert.strictEqual(srv.clampFeedLimit(-5, 60), 1);
      assert.strictEqual(srv.clampFeedLimit(2.9, 60), 2); // floored
      assert.strictEqual(srv.clampFeedLimit(250, 60), 250);
      assert.strictEqual(srv.clampFeedLimit(99999, 60), 500); // clamped down
      assert.strictEqual(srv.clampFeedLimit('42', 60), 42); // query values are strings
    });

    // ── S4: non-integer :id params answer 400 before any query runs ──────
    await check('non-integer :id params answer 400 on every route', async () => {
      const admin = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));
      assert.strictEqual((await j('GET', '/api/markets/abc/book')).status, 400);
      assert.strictEqual((await j('GET', '/api/markets/12.5/book')).status, 400);
      assert.strictEqual((await j('POST', '/api/orders/xyz/cancel', { cookie: alice })).status, 400);
      assert.strictEqual((await j('POST', '/api/markets/1.5/cashout', { cookie: alice })).status, 400);
      assert.strictEqual((await j('PATCH', '/api/admin/markets/abc', { body: { status: 'open' }, cookie: admin })).status, 400);
      assert.strictEqual((await j('POST', '/api/admin/markets/abc/settle', { body: { void: true }, cookie: admin })).status, 400);
    });

    // ── role guards on the settle route (the desk's most consequential call)
    await check('settle route: 401 anonymous, 403 non-admin', async () => {
      const anon = await j('POST', `/api/admin/markets/${marketId}/settle`, { body: { void: true } });
      assert.strictEqual(anon.status, 401);
      const forbidden = await j('POST', `/api/admin/markets/${marketId}/settle`, { body: { void: true }, cookie: alice });
      assert.strictEqual(forbidden.status, 403);
    });

    // #30. The settle audit row recorded the LITERAL 'open' as the "before"
    // state, whatever the market actually was. Settling an open market makes
    // the lie invisible, so this check settles a SUSPENDED one: settleTx refuses
    // only `settled` and `held`, so a suspended market settles normally, and
    // the recorded prior state is then provably not 'open'.
    //
    // The audit row is the record an operator, an auditor or a regulator reads
    // to answer "what state was this market in when you settled it", on the
    // single most money-moving action the venue offers.
    await check('the settle audit row records the market\'s ACTUAL prior status', async () => {
      const admin = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));

      // Build a dedicated market so the check does not disturb the ones other
      // checks in this suite settled.
      const sport = (await j('GET', '/api/sports')).json.sports.find((s) => s.slug === 'football');
      const ev = await j('POST', '/api/admin/events', {
        body: { sport_id: sport.id, name: 'audit-prior-state event', starts_at: '2031-01-01T00:00:00Z' },
        cookie: admin,
      });
      assert.strictEqual(ev.status, 201, `event created (${JSON.stringify(ev.json)})`);
      const comp = await j('GET', `/api/admin/competitions?sport_id=${sport.id}`, { cookie: admin });
      const compId = (comp.json.competitions[0] || {}).id;
      const mkt = await j('POST', '/api/admin/markets', {
        body: { event_id: ev.json.event.id, name: 'audit-prior-state market' },
        cookie: admin,
      });
      assert.strictEqual(mkt.status, 201, `market created (${JSON.stringify(mkt.json)})`);
      const mid = mkt.json.market.id;
      const sel = await j('POST', '/api/admin/selections', {
        body: { market_id: mid, name: 'Runner A' },
        cookie: admin,
      });
      assert.strictEqual(sel.status, 201);

      // Put it in a state that is NOT 'open'.
      const susp = await j('PATCH', `/api/admin/markets/${mid}`, { body: { status: 'suspended', reason: 'audit probe' }, cookie: admin });
      assert.strictEqual(susp.status, 200, 'market suspended');
      assert.strictEqual(susp.json.market.status, 'suspended', 'really suspended before the settle');

      const settled = await j('POST', `/api/admin/markets/${mid}/settle`, { body: { winner_selection_id: sel.json.selection.id }, cookie: admin });
      assert.strictEqual(settled.status, 200, `settled (${JSON.stringify(settled.json)})`);

      const audit = await j('GET', `/api/admin/audit?limit=100`, { cookie: admin });
      const row = audit.json.entries.find((r) => r.target === `market:${mid}` && r.action === 'market.settled');
      assert.ok(row, 'a market.settled audit row exists for this market');
      assert.ok(row.before, 'the row carries a "before" state at all');
      assert.strictEqual(
        row.before.status,
        'suspended',
        `the recorded prior status must be what the market WAS (suspended), not the literal 'open' (got ${JSON.stringify(row.before)})`
      );
    });

    // ── #25: the risk-cap route must not call every fault a 400 ──────────────
    //
    // The route caught everything and stamped `e.status = 400` on whatever
    // lacked one, so a SQLITE_BUSY during a restore, a constraint violation or
    // a TypeError all answered 400 — which errorHandler does not log (it only
    // logs at >= 500). The operator setting a bot's liability cap got "your
    // input was rejected", concluded nothing changed, and nothing was written
    // down anywhere. A risk control that silently failed to apply.
    await check('a genuine server fault on the risk route is 5xx, not a silent 400', async () => {
      const desk = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));
      const bot = srv.db.prepare('SELECT id FROM users WHERE is_bot = 1 LIMIT 1').get();
      assert.ok(bot, 'a bot account exists to configure');

      // INPUT errors are the operator's own, and are still 4xx. These prove the
      // fix did not simply turn every failure into a 500.
      const badCap = await j('PUT', `/api/admin/risk/bots/${bot.id}`, {
        body: { max_liability_cents: 0 },
        cookie: desk,
      });
      assert.strictEqual(badCap.status, 400, 'a non-positive cap is still a 400');
      assert.match(badCap.json.error, /positive integer/, 'and says why');

      const badSkew = await j('PUT', `/api/admin/risk/bots/${bot.id}`, {
        body: { quote_skew: 7 },
        cookie: desk,
      });
      assert.strictEqual(badSkew.status, 400, 'an out-of-range skew is still a 400');

      // A FAULT, injected at the module boundary so the route cannot
      // misclassify it: a plain Error with no status, exactly the shape the
      // blanket `if (!e.status) e.status = 400` used to stamp a 400 onto.
      // (Closing the database would prove the same thing but destroys every
      // check after it, so the seam used here is the module object itself.)
      const RISK = require('../lib/risk');
      const realConfigure = RISK.configure;
      const logged = [];
      const realConsoleError = console.error;
      console.error = (...a) => { logged.push(a.join(' ')); };
      RISK.configure = () => { throw new Error('SQLITE_BUSY: database is locked'); };
      try {
        const faulted = await j('PUT', `/api/admin/risk/bots/${bot.id}`, {
          body: { max_liability_cents: 250000 },
          cookie: desk,
        });
        assert.strictEqual(faulted.status, 500, `a real fault is a 500, got ${faulted.status}`);
        assert.strictEqual(
          faulted.json.error,
          'Internal error',
          'and the internals are not leaked to the client'
        );
        // errorHandler only logs at >= 500, so the OLD route produced a 400 and
        // therefore NO log line at all — nothing to reconcile against later.
        assert.ok(
          logged.some((l) => /database is locked/.test(l)),
          `the fault is logged, got ${JSON.stringify(logged)}`
        );
      } finally {
        RISK.configure = realConfigure;
        console.error = realConsoleError;
      }

      // And the route still works afterwards.
      const good = await j('PUT', `/api/admin/risk/bots/${bot.id}`, {
        body: { max_liability_cents: 250000 },
        cookie: desk,
      });
      assert.strictEqual(good.status, 200, `a valid cap still applies (${JSON.stringify(good.json || {})})`);
    });
    //
    // The route applied status and role in sequence, each through lib/admin.js
    // which opens its OWN transaction(). So the role half could 400 AFTER the
    // status half had committed: a suspension, that account's resting orders
    // cancelled and its live sessions deleted, all behind a request that
    // returned 400. The operator re-submits and meets "Account is already
    // suspended" — orders cancelled and sessions gone as a side effect of a
    // request that reported failure.
    //
    // The trigger is deliberately one half failing for a reason that has
    // NOTHING to do with the other: an unrecognised role is rejected by
    // lib/admin.js's own validation, before it even opens its transaction. The
    // suspension must be rolled back with it.
    await check('a refused role change rolls back the suspension in the same PATCH', async () => {
      const desk = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));

      // A second admin, who is the last one that could be demoted.
      await j('POST', '/api/auth/register', { body: { username: 'lastadmin', password: 'secret1' } });
      const made = await j('POST', '/api/auth/login', { body: { username: 'lastadmin', password: 'secret1' } });
      const lastAdminId = made.json.user.id;
      const promote = await j('PATCH', `/api/admin/users/${lastAdminId}`, {
        body: { role: 'admin', reason: 'desk cover' },
        cookie: desk,
      });
      assert.strictEqual(promote.status, 200, `promote the second admin (${JSON.stringify(promote.json || {})})`);

      // Suspend and demote together. The demotion is refused: the role is not
      // one lib/admin.js recognises.
      const both = await j('PATCH', `/api/admin/users/${lastAdminId}`, {
        body: { status: 'suspended', role: 'superuser', reason: 'combined change' },
        cookie: desk,
      });
      assert.strictEqual(both.status, 400, 'the combined request is refused');

      // …and NOTHING from it survives. The suspension must have rolled back
      // with the rejected role change.
      const after = srv.db.prepare('SELECT status, role FROM users WHERE id = ?').get(lastAdminId);
      assert.strictEqual(after.status, 'active', 'the suspension was rolled back');
      assert.strictEqual(after.role, 'admin', 'and the refused role change never landed');

      // The session deleted by the suspension must still work too.
      const stillIn = await j('GET', '/api/me', { cookie: cookieOf(made) });
      assert.strictEqual(stillIn.status, 200, 'and the live session was not revoked');

      // Re-suspending on its own still works — the rollback undid the failed
      // request, not the capability.
      const alone = await j('PATCH', `/api/admin/users/${lastAdminId}`, {
        body: { status: 'suspended', reason: 'genuine suspension' },
        cookie: desk,
      });
      assert.strictEqual(alone.status, 200, 'a suspension on its own still lands');
      assert.strictEqual(
        srv.db.prepare('SELECT status FROM users WHERE id = ?').get(lastAdminId).status,
        'suspended'
      );
    });

    // ── S5: starts_at must be ISO-8601 (the admin form sends "2030-01-01 12:00")
    let sseEventId = null;
    let sseMarketId = null;
    let sseSelId = null;
    await check('admin event requires an ISO-8601 starts_at', async () => {
      const admin = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));
      const sport = (await j('GET', '/api/sports')).json.sports[0];
      const garbage = await j('POST', '/api/admin/events', { body: { sport_id: sport.id, name: 'No Time FC', starts_at: 'next tuesday' }, cookie: admin });
      assert.strictEqual(garbage.status, 400);
      const fake = await j('POST', '/api/admin/events', { body: { sport_id: sport.id, name: 'No Time FC', starts_at: '2030-02-31 10:00' }, cookie: admin });
      assert.strictEqual(fake.status, 400); // Feb 31 is not a date
      const good = await j('POST', '/api/admin/events', { body: { sport_id: sport.id, name: 'SSE Test FC', starts_at: '2030-01-01 12:00' }, cookie: admin });
      assert.strictEqual(good.status, 201);
      sseEventId = good.json.event.id;
    });

    // ── S7: schema constraint violations map to honest 4xx codes ──────────
    await check('SQLite constraint violations map to 409/400 at admin routes', async () => {
      const admin = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));
      const sport = (await j('GET', '/api/sports')).json.sports[0];
      // duplicate sport slug → UNIQUE violation → 409
      const dup = await j('POST', '/api/admin/sports', { body: { name: sport.name }, cookie: admin });
      assert.strictEqual(dup.status, 409);
      assert.strictEqual(dup.json.error, 'Sport slug already exists');
      // ghost foreign keys → FK violations → 400
      const badComp = await j('POST', '/api/admin/competitions', { body: { sport_id: 999999, name: 'Ghost League' }, cookie: admin });
      assert.strictEqual(badComp.status, 400);
      const badMk = await j('POST', '/api/admin/markets', { body: { event_id: 999999, name: 'Ghost Market' }, cookie: admin });
      assert.strictEqual(badMk.status, 400);
      const badSel = await j('POST', '/api/admin/selections', { body: { market_id: 999999, name: 'Ghost Runner' }, cookie: admin });
      assert.strictEqual(badSel.status, 400);
    });

    // ── S11: fair_price must be finite; build a fresh market for SSE ─────
    await check('selection rejects a non-finite fair_price; fresh market built', async () => {
      const admin = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));
      const mk = await j('POST', '/api/admin/markets', { body: { event_id: sseEventId, name: 'SSE Match Odds' }, cookie: admin });
      assert.strictEqual(mk.status, 201);
      sseMarketId = mk.json.market.id;
      const badFair = await j('POST', '/api/admin/selections', { body: { market_id: sseMarketId, name: 'NaN Runner', fair_price: 'not-a-number' }, cookie: admin });
      assert.strictEqual(badFair.status, 400);
      assert.strictEqual(badFair.json.error, 'fair_price must be a number');
      const sel = await j('POST', '/api/admin/selections', { body: { market_id: sseMarketId, name: 'SSE Runner', fair_price: 2.5 }, cookie: admin });
      assert.strictEqual(sel.status, 201);
      sseSelId = sel.json.selection.id;
      assert.strictEqual(sel.json.selection.fair_price, 2.5);
    });

    // ── SSE broadcast: book on placement, balance on settlement ──────────
    await check('SSE broadcasts book on place and balance on settle', async () => {
      // Alice's OWN stream (opened with her cookie) so private frames arrive.
      const res = await fetch(`${base}/api/stream`, { headers: { cookie: alice } });
      assert.strictEqual(res.status, 200);
      const reader = res.body.getReader();
      const seen = sseWaiter(reader);
      let reader2 = null; // assigned once the second stream opens, inside try
      try {
        const place = await j('POST', '/api/orders', { body: { selection_id: sseSelId, side: 'back', price: 2.5, stake_cents: 10000 }, cookie: alice });
        assert.strictEqual(place.status, 201);
        assert.ok(await seen('book'), 'event: book frame after placement');
        // Bob lays into the resting back so the market has a MATCH — only
        // matched participants reach settlement's per_user list, which is
        // what drives the private balance broadcast.
        const lay = await j('POST', '/api/orders', { body: { selection_id: sseSelId, side: 'lay', price: 2.5, stake_cents: 10000 }, cookie: bob });
        assert.strictEqual(lay.status, 201);
        assert.strictEqual(lay.json.order.status, 'fully_matched');
        // A SECOND stream, opened after the place/match but before the
        // settle: placement ALSO broadcasts a private 'balance' to the
        // placer, so only a stream that connected after that moment can
        // prove the SETTLEMENT broadcast independently.
        const res2 = await fetch(`${base}/api/stream`, { headers: { cookie: alice } });
        reader2 = res2.body.getReader();
        const seen2 = sseWaiter(reader2);
        // Capture totals before the settle (escrow never moves them), then
        // assert the exact pot arithmetic: back 10000 @ 2.5 -> winner pot =
        // 10000 + (2.5-1)*10000 = 25000, commission round(25000*0.025) = 625;
        // the layer funds the pot with the (2.5-1)*10000 = 15000 liability.
        const beforeAlice = (await j('GET', '/api/wallet', { cookie: alice })).json.balance_cents;
        const beforeBob = (await j('GET', '/api/wallet', { cookie: bob })).json.balance_cents;
        const admin = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));
        const settle = await j('POST', `/api/admin/markets/${sseMarketId}/settle`, { body: { winner_selection_id: sseSelId }, cookie: admin });
        assert.strictEqual(settle.status, 200);
        assert.strictEqual(settle.json.market.status, 'settled');
        assert.ok(await seen2('balance'), 'event: balance frame after settlement');
        // the win lands in alice's wallet: the backer is credited the layer's
        // liability (2.5-1)*10000 = 15000 (her own 10000 stake only unfroze —
        // it never left balance_cents), minus round(15000*0.025)=375 commission
        const w = await j('GET', '/api/wallet', { cookie: alice });
        assert.strictEqual(w.json.balance_cents, beforeAlice + 15000 - 375);
        assert.strictEqual(w.json.frozen_cents, 0);
        // bob funded the pot with the (2.5-1)*10000 = 15000 liability
        const wb = await j('GET', '/api/wallet', { cookie: bob });
        assert.strictEqual(wb.json.balance_cents, beforeBob - 15000);
        assert.strictEqual(wb.json.frozen_cents, 0);
      } finally {
        await reader.cancel();
        if (reader2) await reader2.cancel();
      }
    });

    // ── W3: login/register rate limiting (each check pins + resets) ──────
    await check('ten consecutive login failures lock just that username', async () => {
      srv.resetLoginLimiter();
      await j('POST', '/api/auth/register', { body: { username: 'rl_target', password: 'secret1' } });
      for (let i = 0; i < 10; i++) {
        const r = await j('POST', '/api/auth/login', { body: { username: 'rl_target', password: 'wrong-pw' } });
        assert.strictEqual(r.status, 401, `attempt ${i + 1}/10 stays a plain 401`);
      }
      // locked: 429, a generic body, and a positive Retry-After
      const locked = await j('POST', '/api/auth/login', { body: { username: 'rl_target', password: 'wrong-pw' } });
      assert.strictEqual(locked.status, 429);
      assert.strictEqual(locked.json.error, 'Too many failed attempts; try again later');
      const raw = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'rl_target', password: 'wrong-pw' }),
      });
      assert.ok(Number(raw.headers.get('retry-after')) >= 1, 'Retry-After is a positive number of seconds');
      // the lock is per username: everyone else logs in normally
      const admin = await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
      assert.strictEqual(admin.status, 200);
      srv.resetLoginLimiter();
      // and the reset clears it: the correct password works again immediately
      const ok = await j('POST', '/api/auth/login', { body: { username: 'rl_target', password: 'secret1' } });
      assert.strictEqual(ok.status, 200);
    });

    await check('a per-SOURCE counter stops the fresh-username flood', async () => {
      // The per-username lockout is trivially bypassed: crypto.scryptSync blocks
      // the event loop, so the attack is to mint a FRESH username per request and
      // never touch any username counter at all. Measured before this counter
      // existed: /api/sports went from a 1.6ms median to 723ms (p95 1568ms) —
      // a ~460x amplification, with orders, matching, settlement and the admin
      // desk all stopping together.
      srv.resetLoginLimiter();
      let reached = 0;
      let rejected = 0;
      for (let i = 0; i < 40; i++) {
        const r = await j('POST', '/api/auth/login', {
          body: { username: `flood_${i}_${Math.random().toString(36).slice(2, 7)}`, password: 'wrong-pw' },
        });
        if (r.status === 401) reached++;
        if (r.status === 429) rejected++;
      }
      // The source counter must bite well before every attempt costs a scrypt.
      assert.ok(rejected > 0, `the per-source counter engaged (${reached} reached scrypt, ${rejected} rejected)`);
      assert.ok(reached < 40, 'the flood was cut short rather than all reaching the KDF');
      // And the server is still serving: the control works by refusing work,
      // not by wedging the process.
      const alive = await j('GET', '/api/sports');
      assert.strictEqual(alive.status, 200, 'the server still answers after the flood');
      srv.resetLoginLimiter();
    });

    await check('the per-source lock does not fire on ordinary shared-IP use', async () => {
      // Ten failures must lock the TARGET USERNAME, not every other user behind
      // the same address. An office on one NAT, or a phone behind a carrier NAT,
      // is the same address as its users — locking them out would punish a
      // shared connection for one person's typos. Caught by the API suite when
      // both counters shared a threshold.
      srv.resetLoginLimiter();
      for (let i = 0; i < 10; i++) {
        await j('POST', '/api/auth/login', { body: { username: 'nat_victim', password: 'wrong-pw' } });
      }
      const other = await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
      assert.strictEqual(other.status, 200, 'an unrelated account on the same address is unaffected');
      srv.resetLoginLimiter();
    });

    await check('interleaved successes reset the failure counter', async () => {
      srv.resetLoginLimiter();
      await j('POST', '/api/auth/register', { body: { username: 'rl_inter', password: 'secret1' } });
      for (let i = 0; i < 9; i++) {
        await j('POST', '/api/auth/login', { body: { username: 'rl_inter', password: 'nope' } });
      }
      const win = await j('POST', '/api/auth/login', { body: { username: 'rl_inter', password: 'secret1' } });
      assert.strictEqual(win.status, 200); // a success below threshold is never blocked
      // the success reset the counter: 9 more misses still do not lock, and
      // the correct password keeps working (without the reset this would 429)
      for (let i = 0; i < 9; i++) {
        await j('POST', '/api/auth/login', { body: { username: 'rl_inter', password: 'nope' } });
      }
      const again = await j('POST', '/api/auth/login', { body: { username: 'rl_inter', password: 'secret1' } });
      assert.strictEqual(again.status, 200);
      srv.resetLoginLimiter();
    });

    await check('ten failed registrations lock the calling IP', async () => {
      srv.resetLoginLimiter();
      const create = await j('POST', '/api/auth/register', { body: { username: 'rl_dup', password: 'secret1' } });
      assert.strictEqual(create.status, 201); // creation is a success — resets the IP counter
      for (let i = 0; i < 10; i++) {
        const r = await j('POST', '/api/auth/register', { body: { username: 'rl_dup', password: 'secret1' } });
        assert.strictEqual(r.status, 409, `duplicate attempt ${i + 1}/10 stays a plain 409`);
      }
      const locked = await j('POST', '/api/auth/register', { body: { username: 'rl_someone_else', password: 'secret9' } });
      assert.strictEqual(locked.status, 429); // the IP is locked, even for a fresh username
      srv.resetLoginLimiter();
      const fresh = await j('POST', '/api/auth/register', { body: { username: 'rl_after', password: 'secret9' } });
      assert.strictEqual(fresh.status, 201); // reset unblocks the shared-IP register path
    });

    // ── The deposit trust boundary (outside audit's F1, at the HTTP layer) ──
    // The critical finding was that any signed-in player could confirm a
    // deposit intent themselves and mint unlimited money. These checks pin
    // the boundary at the ROUTE level: a player reaches open + read, never
    // confirm; only the provider-authenticated webhook can.
    await check('W1 a player can open a deposit intent but it credits nothing', async () => {
      const login = await j('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } });
      const cookie = cookieOf(login);
      const before = (await j('GET', '/api/wallet', { cookie })).json.balance_cents;
      const r = await j('POST', '/api/wallet/deposit-intent', { body: { amount_cents: 25000 }, cookie });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.intent_id, 'an intent id exists');
      assert.strictEqual(r.json.status, 'pending');
      const after = (await j('GET', '/api/wallet', { cookie })).json.balance_cents;
      assert.strictEqual(after, before, 'opening an intent moves no money');
    });

    await check('W2 THE PLAYER-CONFIRMABLE ROUTE IS GONE (404)', async () => {
      const login = await j('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } });
      const cookie = cookieOf(login);
      const before = (await j('GET', '/api/wallet', { cookie })).json.balance_cents;
      // The auditor's exact exploit: any intent id, the player's own session.
      // (The balance is relative, not absolute: alice has been trading
      // throughout this suite, and the point is that THIS route cannot move
      // it — not what it happened to be.)
      const r = await j('POST', '/api/wallet/deposit-intent/1/confirm', { body: {}, cookie });
      assert.strictEqual(r.status, 404, 'the route no longer exists');
      const after = (await j('GET', '/api/wallet', { cookie })).json.balance_cents;
      assert.strictEqual(after, before, 'and no self-service credit path remains');
    });

    await check('W3 the webhook is default-deny without the secret', async () => {
      // This suite runs without PAYMENTS_WEBHOOK_SECRET, so the route 404s —
      // the safe default: an unauthenticated confirm path is exactly the
      // critical bug the audit found, so it must not exist unless configured.
      const r = await j('POST', '/api/payments/webhook', { body: { external_id: 'x', amount_cents: 100 } });
      assert.ok(r.status === 404 || r.status === 401, `unsigned/unconfigured webhook is refused, got ${r.status}`);
    });

    // #9. `POST /api/wallet/withdraw` called `Number(amount_cents)` before
    // handing the value to lib/payments, so `"100"`, `true` and `[100]` were all
    // coerced into a valid cent amount and DEBITED. Every other money edge in
    // the codebase refuses them at the boundary.
    //
    // The balance is made large FIRST, deliberately. A player with 50c would
    // get `400 Withdrawal exceeds available balance` for every one of these
    // values, coercion or not — and a test that only asserted "400" would then
    // pass with the bug present. Asserting the refusal happens *with money
    // available to take* is what makes it a real test: before the fix these
    // three debit real cents and answer 200; after, they are refused and the
    // balance is untouched.
    await check('W0 withdraw refuses non-integer cents at the route, with funds available', async () => {
      const reg = await j('POST', '/api/auth/register', { body: { username: 'wendy', password: 'secret1' } });
      const cookie = cookieOf(reg);
      await j('POST', '/api/wallet/deposit', { body: { amount_cents: 50000 }, cookie });
      const start = (await j('GET', '/api/wallet', { cookie })).json.balance_cents;
      assert.strictEqual(start, 50000, 'the account really does have funds to withdraw');

      for (const [label, amount] of [['a string', '100'], ['a boolean', true], ['an array', [100]]]) {
        const r = await j('POST', '/api/wallet/withdraw', { body: { amount_cents: amount, reason: 'boundary test' }, cookie });
        assert.strictEqual(r.status, 400, `${label} amount_cents is refused (got ${r.status} ${JSON.stringify(r.json)})`);
        // Assert the message too: a 400 from an unrelated check (say, the
        // balance cap) would satisfy the status assertion alone and hide a
        // coercion that still went through.
        assert.match(
          r.json.error,
          /positive integer/i,
          `${label} is refused as a non-integer, not for some other reason (got ${JSON.stringify(r.json.error)})`
        );
      }

      // The point of the whole check: not one cent left the account.
      const after = (await j('GET', '/api/wallet', { cookie })).json.balance_cents;
      assert.strictEqual(after, start, 'no coerced value debited anything');

      // And the control: a REAL integer still works, so the check is not just
      // "withdraw always 400s".
      const ok = await j('POST', '/api/wallet/withdraw', { body: { amount_cents: 100, reason: 'boundary test' }, cookie });
      assert.strictEqual(ok.status, 200, 'an integer withdrawal still opens an intent');
      assert.strictEqual((await j('GET', '/api/wallet', { cookie })).json.balance_cents, start - 100);
    });

    // ── Every operator/control route is CALLED at least once ──────────────
    // `const MATCH = M;` went missing to a shell-quoting failure and NOTHING
    // failed: the delay-release job and its admin route were dead, because no
    // test called them and the undefined identifier only errors when the route
    // is taken. A route nobody exercises is a route nobody knows is broken, so
    // these are called for real — the point is reachability, not behaviour,
    // which the module suites cover.
    await check('R1 the in-play delay-release route is reachable and answers', async () => {
      const admin = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));
      const r = await j('POST', '/api/admin/inplay/release-delays', { body: { limit: 50 }, cookie: admin });
      assert.strictEqual(r.status, 200, 'the manual release trigger answers');
      assert.strictEqual(typeof r.json.considered, 'number', 'and reports what it considered');
      assert.ok(r.json.released !== undefined && r.json.filled !== undefined, 'with the counts a desk needs');
    });

    await check('R2 the responsible-gambling status route answers, configured or not', async () => {
      const r = await j('GET', '/api/auth/rg', { cookie: cookieOf(await j('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } })) });
      assert.strictEqual(r.status, 200);
      // The three controls and the "is this deployment guarded at all" answer.
      for (const k of ['session_limit_minutes', 'reality_check_minutes', 'deposit_limit_cents', 'configured']) {
        assert.ok(k in r.json, `reports ${k}`);
      }
    });

    await check('R3 the reality-check acknowledgement is reachable and idempotent', async () => {
      const cookie = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } }));
      const first = await j('POST', '/api/auth/reality-check', { body: {}, cookie });
      assert.strictEqual(first.status, 200);
      assert.ok(first.json.acknowledged_at, 'stamps an acknowledgement');
      // Re-acknowledging is not an error: a player double-clicking the dialog
      // must not be shown a failure.
      const second = await j('POST', '/api/auth/reality-check', { body: {}, cookie });
      assert.strictEqual(second.status, 200, 'and again');
    });

    await check('R4 the results-feed state route answers, configured or not', async () => {
      const admin = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));
      const r = await j('GET', '/api/admin/results/feed', { cookie: admin });
      assert.strictEqual(r.status, 200, 'the operator can ask whether the feed is up');
      // The three states an operator must be able to tell apart, and no more.
      assert.ok(['not_configured', 'failing', 'stale', 'ok'].includes(r.json.status), `a known status (got ${r.json.status})`);
      assert.ok('consecutive_failures' in r.json && 'last_ok_at' in r.json, 'with the counters a desk needs');
    });

    await check('R5 a manual results poll is reachable and settles nothing by itself', async () => {
      const admin = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));
      const r = await j('POST', '/api/admin/results/poll', { body: {}, cookie: admin });
      assert.strictEqual(r.status, 200, 'the manual trigger answers');
      assert.strictEqual(typeof r.json.considered, 'number');
      // With no feed configured it must be a clean no-op, not an outage.
      assert.strictEqual(r.json.error, null, 'and report no error');
    });

    // R6: every reporting route answers, as CSV and as JSON, and every one of
    // them is CALLED. Six routes that nobody exercises is six routes nobody
    // knows are broken — the same gap that hid the dead delay-release job and
    // the intVal route.
    await check('R6 every reporting route answers, CSV and JSON', async () => {
      const admin = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));
      const routes = [
        ['/api/admin/reports/summary', ['period', 'definitions', 'financial', 'activity', 'rates', 'self_check_ok']],
        ['/api/admin/reports/settlements', ['period', 'statements', 'definitions']],
        ['/api/admin/reports/volume', ['period', 'by_market', 'by_selection', 'definitions']],
        ['/api/admin/reports/volume-by-selection', ['period', 'rows', 'definitions']],
        ['/api/admin/reports/commission', ['period', 'rows', 'definitions']],
        ['/api/admin/reports/operational', ['period', 'definitions', 'activity', 'rates']],
      ];
      for (const [route, keys] of routes) {
        const csv = await j('GET', route, { cookie: admin });
        assert.strictEqual(csv.status, 200, `${route} answers`);
        assert.match(String(csv.headers['content-type'] || ''), /text\/csv/, `${route} defaults to CSV`);
        // A report an operator cannot attribute is a report in a downloads
        // folder by Friday, so the period rides in the filename.
        assert.match(String(csv.headers['content-disposition'] || ''), /attachment; filename=".*\d{4}-\d{2}-\d{2}/, `${route} names the period`);

        const json = await j('GET', `${route}?format=json`, { cookie: admin });
        assert.strictEqual(json.status, 200, `${route} answers as JSON`);
        for (const k of keys) assert.ok(k in json.json, `${route} reports ${k}`);
      }
    });

    await check('R7 the financial summary carries its definitions and self-check', async () => {
      const admin = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));
      const r = await j('GET', '/api/admin/reports/summary?format=json', { cookie: admin });
      assert.strictEqual(r.status, 200);
      // A figure without a definition gets filed wrong, so the definitions ship
      // with the numbers rather than in a separate document.
      for (const k of ['commission', 'ggr', 'turnover', 'margin_bps']) {
        assert.ok(r.json.definitions[k], `defines ${k}`);
      }
      assert.ok('self_check_ok' in r.json, 'and reports whether its own invariant holds');
      assert.ok(r.json.self_check_basis, 'and STATES the invariant rather than asserting a bare number');
    });

    await check('R8 a reporting period is validated rather than defaulted silently', async () => {
      const admin = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } }));
      // An operator who asked for a month and was handed the lifetime total
      // would file it, so a bad period is an error, not a fallback.
      for (const q of ['?from=nope', '?to=nope', '?from=2026-02-01&to=2026-01-01', '?from=2000-01-01']) {
        const r = await j('GET', `/api/admin/reports/summary${q}`, { cookie: admin });
        assert.strictEqual(r.status, 400, `refused: ${q}`);
      }
      // A valid explicit window is honoured.
      const ok = await j('GET', '/api/admin/reports/summary?from=2026-01-01&to=2026-01-31&format=json', { cookie: admin });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.json.period.from, '2026-01-01');
      assert.strictEqual(ok.json.period.to, '2026-01-31');
    });

    await check('R9 reporting is behind the admin role', async () => {
      const player = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } }));
      for (const route of ['/api/admin/reports/summary', '/api/admin/reports/settlements', '/api/admin/reports/operational']) {
        const r = await j('GET', route, { cookie: player });
        assert.strictEqual(r.status, 403, `${route} is not readable by a player`);
      }
    });

    await check('W4 a deposit intent above the per-intent cap is refused', async () => {
      const login = await j('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } });
      const r = await j('POST', '/api/wallet/deposit-intent', {
        body: { amount_cents: 50000000 },
        cookie: cookieOf(login),
      });
      assert.strictEqual(r.status, 400, 'the 50,000,000-cent exploit is refused at creation');
      assert.ok(/per-intent cap/.test(r.json.error));
    });

    // ── #33 + #34: the first-run lock must be escapable through the UI ──────
    //
    // A locked account must be able to load the page that fixes the lock, and
    // must be able to reach every route on the setup allowlist. Both of these
    // go wrong in the direction of an unusable deployment, which is what the
    // lock's own comment calls a trap rather than a control.
    await check('a locked account can load the frontend it must use to unlock', async () => {
      // Flag exactly one account, and restore it afterwards, so the rest of
      // this suite's seeded admin is untouched.
      srv.db.prepare('UPDATE users SET must_change_password = 1 WHERE username = ?').run('demo');
      const locked = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'demo', password: 'demo123' } }));
      try {
        // The control first: prove the lock IS engaged for this session. Without
        // it, the static assertions below would pass vacuously — an unlocked
        // account also gets 200 for these paths, which is exactly the trap of a
        // test that cannot fail.
        const refused = await j('GET', '/api/wallet', { cookie: locked });
        assert.strictEqual(refused.status, 403, 'the lock really is engaged for this session');
        assert.match(refused.json.error, /Change your password/i);

        for (const [path, type] of [['/', /text\/html/], ['/style.css', /text\/css/], ['/ladder.js', /javascript/]]) {
          const res = await fetch(`${base}${path}`, { headers: { cookie: locked } });
          assert.strictEqual(res.status, 200, `a locked account must still load ${path} (got ${res.status})`);
          const ct = res.headers.get('content-type') || '';
          assert.match(ct, type, `${path} is served as itself, not as the lock's JSON error`);
        }

        // And the whole point: the account can still reach the fix, then load
        // the UI again. Asserting only the static assets would pass even if the
        // change-password route were itself behind the lock — which is the
        // failure this codebase has already had once (server.js, firstRunLockResponse).
        const cp = await j('POST', '/api/auth/change-password', {
          body: { currentPassword: 'demo123', newPassword: 'demo-after-unlock' },
          cookie: locked,
        });
        assert.strictEqual(cp.status, 200, `the lock is escapable (${JSON.stringify(cp.json)})`);
      } finally {
        // Leave the account usable for any later check, and unflag it.
        srv.db.prepare('UPDATE users SET must_change_password = 0 WHERE username = ?').run('demo');
      }
    });

    // #34. `SETUP_ALLOWLIST` held `DELETE /api/auth/sessions/:id` — a route
    // PATTERN — while `isSetupRoute` compared the literal `${method} ${path}`
    // against it. `req.path` is the concrete path, so that entry could never
    // match and was dead by construction.
    //
    // This walks EVERY allowlisted route against a locked session, which is what
    // the issue names as the missing test: one entry in the wrong form and this
    // fails, rather than the next person adding a fifth.
    await check('every first-run-lock allowlisted route is reachable while locked', async () => {
      // The previous check changed this account's password, so sign in with the
      // one it now has rather than the seed value.
      const demoPw = srv.db
        .prepare("SELECT pass_hash FROM users WHERE username = 'demo'")
        .get().pass_hash;
      const which = (await A.verifyPassword('demo-after-unlock', demoPw)) ? 'demo-after-unlock' : 'demo123';
      srv.db.prepare('UPDATE users SET must_change_password = 1 WHERE username = ?').run('demo');
      // A second session for the SAME account, so revoking one does not sign the
      // caller out of the session it is calling from.
      const locked = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'demo', password: which } }));
      const other = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'demo', password: which } }));
      try {
        // Control: the lock is engaged. Without it every "reachable" assertion
        // below would be vacuous.
        assert.strictEqual((await j('GET', '/api/wallet', { cookie: locked })).status, 403, 'the lock is engaged');

        // The five allowlisted entries, each exercised for real.
        assert.strictEqual((await j('GET', '/api/me', { cookie: locked })).status, 200, 'GET /api/me');
        assert.strictEqual((await j('GET', '/api/auth/sessions', { cookie: locked })).status, 200, 'GET /api/auth/sessions');

        // The one that could never match. Revoke the OTHER session, so the
        // caller survives and the assertion is about reachability, not self-logout.
        const listed = await j('GET', '/api/auth/sessions', { cookie: locked });
        const ids = listed.json.sessions.map((s) => s.id);
        assert.ok(ids.length >= 2, `two sessions exist to choose between (${JSON.stringify(ids)})`);
        const current = (await j('GET', '/api/auth/sessions', { cookie: locked })).json.sessions.find((s) => s.current).id;
        const victim = ids.find((id) => id !== current);
        assert.ok(victim, 'a non-current session id to revoke');
        const del = await j('DELETE', `/api/auth/sessions/${victim}`, { cookie: locked });
        assert.strictEqual(
          del.status,
          200,
          `DELETE /api/auth/sessions/:id must be reachable while locked (got ${del.status} ${JSON.stringify(del.json)})`
        );

        // logout last: it ends the session, so anything after it would 401.
        assert.strictEqual((await j('POST', '/api/auth/logout', { cookie: other })).status, 200, 'POST /api/auth/logout');

        // And the pattern must stay a pattern: a two-segment path is not a
        // session id, so it must NOT become allowlisted by the prefix.
        const deeper = await fetch(`${base}/api/auth/sessions/a/b`, { method: 'DELETE', headers: { cookie: locked } });
        assert.strictEqual(deeper.status, 403, 'a path the pattern does not describe stays locked');
      } finally {
        srv.db.prepare('UPDATE users SET must_change_password = 0 WHERE username = ?').run('demo');
      }
    });

    console.log(`\napi.test.js: ${passed} checks passed`);
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
