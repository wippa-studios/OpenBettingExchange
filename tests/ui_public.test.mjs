// ui_public.test.mjs — browser verification of the public/ defects (issues
// #47, #48, #49, #50, #51).
//
// Run: node tests/ui_public.test.mjs
//
// WHY A SEPARATE FILE. tests/ui_test.mjs belongs to the server/lib workstream
// and is run by `npm run test:ui`; this file is standalone so the public/ fixes
// can be verified without editing it. It boots the SAME server on a temp DB
// with the SAME environment the browser suite uses.
//
// WHY IT IS NOT VACUOUS. Three of these defects are RACES or ordering bugs, and
// a test that fires one request and reads one render passes forever against code
// that is broken. Every such assertion here genuinely interleaves two
// out-of-order events with page.route(): the first request is HELD OPEN, a
// second one is allowed to complete, and only then is the first released. Each
// stale response carries a distinct marker, so "the stale render won" is
// observable as text rather than inferred.
//
// WHY EACH SCENARIO GETS A FRESH PAGE. Page-level route interception survives a
// navigation, so a handler parked on a gate in one scenario is still live in the
// next. One page per scenario keeps each test's failure about that test.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

const PORT = Number(process.env.UI_PUBLIC_PORT) || (await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'ob-uipub-'));

let passed = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    passed++;
    console.log('  ok  ', name, extra);
  } else {
    console.log('  FAIL', name, extra);
    process.exitCode = 1;
  }
};

const server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
  cwd: ROOT,
  // Non-demo credentials: the first-run lock (tests/setup.test.js) refuses every
  // route outside the setup allowlist for a seeded-password account, which would
  // block every flow below on the first login.
  env: {
    ...process.env,
    DB_PATH: path.join(TMP, 'uipub.db'),
    PORT: String(PORT),
    DRIFT_ENABLED: 'false',
    ADMIN_PASSWORD: 'uipub-admin-password',
    DEMO_PASSWORD: 'uipub-demo-password',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));

const cleanup = () => {
  server.kill('SIGKILL');
  rmSync(TMP, { recursive: true, force: true });
};
process.on('exit', cleanup);

for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`${BASE}/api/sports`);
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

// Every scenario starts from a clean page in the SAME session (the cookie is on
// the context), so a handler parked on a gate cannot outlive its test.
let page = null;
// Real JavaScript/console failures only — page LIFECYCLE is tracked separately,
// because each scenario deliberately closes its page before the next opens.
const pageErrors = [];
let pageDied = null;
const EXPECTED_401 = /401 \(Unauthorized\)/;

async function freshPage() {
  if (page) await page.close().catch(() => {});
  page = await ctx.newPage();
  let signedIn = false;
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + String(e)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    if (!signedIn && EXPECTED_401.test(t)) return; // the signed-out whoami probe
    pageErrors.push('console.error: ' + t);
  });
  page.on('crash', () => (pageDied = 'page crashed'));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ladder .lcell[data-bet]', { timeout: 20000 });
  return { markSignedIn: () => (signedIn = true) };
}

const ONLY = process.env.ONLY || '';

const scenario = async (name, fn) => {
  // ONLY=<substring> runs one scenario. Page-level route interception and parked
  // handlers are the easiest thing to get wrong in a browser suite, and being
  // able to run one scenario in isolation is what makes that debuggable.
  if (ONLY && name.indexOf(ONLY) < 0) return;
  pageDied = null;
  try {
    await fn();
  } catch (e) {
    console.log('  FAIL', name, '—', (e && e.stack) || e);
    process.exitCode = 1;
  }
  if (pageDied) {
    console.log('  FAIL', name, '—', pageDied);
    process.exitCode = 1;
  }
};

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * A latch a route handler parks on until the test releases it.
 *   gate.wait()   — signal "the request has arrived" (idempotent)
 *   gate.pending  — awaitable the handler parks on
 *   gate.open()   — let the held response through
 */
function latch() {
  let release;
  let reached;
  const pending = new Promise((r) => {
    release = r;
  });
  const wait = new Promise((r) => {
    reached = r;
  });
  return {
    wait: () => reached,
    pending,
    open: () => release(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(user, pass) {
  // The session cookie lives on the CONTEXT, so a second page in the same run
  // is already signed in — and #authBtn is a toggle, so clicking it there would
  // sign OUT instead of opening the modal.
  if (await page.evaluate(() => !!(window.OB && window.OB.state.user))) return;
  await page.click('#authBtn');
  await page.fill('#authUser', user);
  await page.fill('#authPass', pass);
  await page.click('#authGo');
  await page.waitForFunction(() => window.OB && window.OB.state.user, null, { timeout: 20000 });
}

/** Clear the slip from page-side state (no test here ever keeps a real bet). */
const resetSlip = () =>
  page.evaluate(() => {
    window.OB.state.slip.length = 0;
    window.OB.renderSlip();
  });

/** Add `n` distinct selections to the slip from the visible ladder. */
async function addSelections(n) {
  for (let k = 0; k < n; k++) {
    const before = await page.evaluate(() => window.OB.state.slip.length);
    const clicked = await page.evaluate(() => {
      const have = new Set(
        window.OB.state.slip.map((s) => `${s.market_id}:${s.selection_id}:${s.side}`)
      );
      const cell = [...document.querySelectorAll('.ladder .lcell[data-bet]')].find(
        (c) => !have.has(`${c.dataset.mkt}:${c.dataset.sel}:${c.dataset.side}`)
      );
      if (!cell) return false;
      cell.click();
      return true;
    });
    if (!clicked) throw new Error('no free ladder cell left to add');
    await page.waitForFunction((want) => window.OB.state.slip.length === want, before + 1, { timeout: 10000 });
  }
}

const slipState = () =>
  page.evaluate(() => window.OB.state.slip.map((s) => ({ id: s.selection_id, name: s.selection_name, side: s.side })));

// ── #47 the slip accepts stakes the engine must refuse ──────────────────────
await scenario('#47 the slip validates against the engine stake window', async () => {
  const p = await freshPage();
  await login('demo', 'uipub-demo-password');
  p.markSignedIn();
  await addSelections(1);

  const row = () => page.locator('.sliprow').first();
  const setStake = async (v) => {
    const input = row().locator('[data-stake]');
    await input.fill(String(v));
    // The delegated handler listens for `change`; fill() fires it on blur or
    // Enter, and dispatching it explicitly makes the step independent of where
    // the focus happens to be.
    await input.dispatchEvent('change');
  };
  const stake0 = () =>
    page.evaluate(() => ({
      cents: window.OB.state.slip[0].stake_cents,
      error: window.OB.state.slip[0].stake_error || null,
    }));
  const disabled = () => row().locator('[data-place]').isDisabled();
  const errText = async () => {
    const n = row().locator('.stakeerr');
    return (await n.count()) ? (await n.first().innerText()).trim() : null;
  };

  check('a slip row exists to test against', (await page.locator('.sliprow').count()) === 1, '');

  // Start from a stake that is NEITHER the 1000 default nor out of range, so
  // "the handler quietly substituted the default" is observable instead of
  // indistinguishable from "the handler kept what was there".
  await setStake(25);
  check('the row starts at a non-default valid stake', (await stake0()).cents === 2500, JSON.stringify(await stake0()));

  // Below the floor: MIN_STAKE_CENTS is 100 = $1.00.
  await setStake(0.5);
  check('a below-minimum stake disables Place', await disabled(), '');
  check('a below-minimum stake explains the minimum', /minimum/i.test((await errText()) || ''), JSON.stringify(await errText()));
  check(
    'a rejected stake is NOT silently rewritten to a value the user never typed',
    (await stake0()).cents === 2500,
    `stake_cents=${(await stake0()).cents}`
  );
  check(
    'the rejected figure the user typed is still the one on screen',
    (await row().locator('[data-stake]').inputValue()) === '0.5',
    await row().locator('[data-stake]').inputValue()
  );

  // Above the ceiling: $2,000.00 = 200000 cents > MAX_STAKE_CENTS.
  await setStake(2000);
  check('an above-maximum stake disables Place', await disabled(), '');
  check('an above-maximum stake explains the maximum', /maximum/i.test((await errText()) || ''), JSON.stringify(await errText()));

  // Unparseable: nothing may be substituted for it.
  await setStake('');
  check('an empty stake disables Place', await disabled(), '');
  check('an empty stake leaves the last good stake untouched', (await stake0()).cents === 2500, `stake_cents=${(await stake0()).cents}`);

  // Exactly at the bounds is legal — inclusive, per EXCHANGE_RULES.
  await setStake(1);
  check('the minimum stake itself is placeable', !(await disabled()), JSON.stringify(await stake0()));
  await setStake(1000);
  check('the maximum stake itself is placeable', !(await disabled()), JSON.stringify(await stake0()));

  await setStake(10);
  const mid = await stake0();
  check('a valid stake is kept verbatim and clears the error', mid.cents === 1000 && mid.error === null && (await errText()) === null, JSON.stringify(mid));

  const attrs = await row().locator('[data-stake]').evaluate((n) => ({ min: n.getAttribute('min'), max: n.getAttribute('max') }));
  check('the stake input advertises the same window', attrs.min === '1.00' && attrs.max === '1000.00', JSON.stringify(attrs));

  // placeOne must refuse an invalid row even when a stale button reference
  // bypasses the disabled attribute, so the engine is never sent a stake it
  // will refuse.
  await setStake(0.5);
  const posted = await page.evaluate(async () => {
    const real = window.OB.api;
    let sent = null;
    window.OB.api = (m, p, b) => {
      if (m === 'POST' && p === '/api/orders') sent = b;
      return real(m, p, b);
    };
    const btn = document.querySelector('.sliprow [data-place]');
    btn.disabled = false; // a stale reference, exactly as the handler sees it
    await window.OB.placeOne(0, btn);
    window.OB.api = real;
    return sent;
  });
  check('placeOne refuses to send a stake outside the engine window', posted === null, JSON.stringify(posted));
});

// ── #47 the window is the SERVER'S, not a second copy in the client ─────────
await scenario('#47 the client adopts the stake window the server publishes', async () => {
  const p = await freshPage();
  await login('demo', 'uipub-demo-password');
  p.markSignedIn();
  await addSelections(1);

  const serveBounds = async (bounds) => {
    await page.route('**/api/me', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.stake_bounds = bounds;
      await route.fulfill({ response: res, json: body });
    });
    await page.evaluate(() => window.OB.refreshMe());
    await sleep(400);
  };

  await serveBounds({ min_cents: 500, max_cents: 25000 });
  const adopted = await page.evaluate(() => window.OB.state.stakeBounds);
  check('the client adopts the window the server publishes', adopted && adopted.min_cents === 500 && adopted.max_cents === 25000, JSON.stringify(adopted));

  const attrs = await page.locator('.sliprow').first().locator('[data-stake]').evaluate((n) => ({ min: n.getAttribute('min'), max: n.getAttribute('max') }));
  check('the stake input follows the server-published window', attrs.min === '5.00' && attrs.max === '250.00', JSON.stringify(attrs));

  const input = page.locator('.sliprow').first().locator('[data-stake]');
  await input.fill('4.00');
  await input.dispatchEvent('change');
  check(
    'a stake legal under the defaults but illegal under the server window is refused',
    await page.locator('.sliprow').first().locator('[data-place]').isDisabled(),
    ''
  );

  // A malformed window must be IGNORED, never half-applied.
  await page.unroute('**/api/me');
  await serveBounds({ min_cents: 500, max_cents: null });
  const kept = await page.evaluate(() => window.OB.state.stakeBounds);
  check('a half-specified window is ignored, not partially applied', kept && kept.max_cents === 25000, JSON.stringify(kept));
});

// ── #48 placeOne splices the slip by a stale index ──────────────────────────
await scenario('#48 removing a slip row mid-flight does not delete another bet', async () => {
  const p = await freshPage();
  await login('demo', 'uipub-demo-password');
  p.markSignedIn();
  await addSelections(2);
  const before = await slipState();
  const ident = (s) => `${s.id}:${s.side}`;
  check(
    'the slip holds two distinct bets to start with',
    before.length === 2 && ident(before[0]) !== ident(before[1]),
    JSON.stringify(before)
  );

  // HOLD the order POST open, so the removal below genuinely happens while
  // placeOne is suspended on its await — not before it, not after it.
  const gate = latch();
  const posted = [];
  await page.route('**/api/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posted.push(route.request().postDataJSON());
    gate.wait();
    await gate.pending;
    return route.continue();
  });

  await page.locator('.sliprow').first().locator('[data-place]').click();
  await gate.wait();

  // Ordinary user behaviour while waiting: change my mind about the first bet.
  await page.locator('.sliprow').first().locator('[data-rm]').click();

  gate.open(); // the order now resolves
  await sleep(700); // let the POST land and the slip re-render

  const left = await slipState();
  check('exactly one order was posted', posted.length === 1, JSON.stringify(posted));
  check(
    'the posted order is the one that was pressed',
    posted[0] && String(posted[0].selection_id) === String(before[0].id),
    JSON.stringify({ posted: posted[0], pressed: before[0] })
  );
  check(
    'the OTHER bet survives the removal — a stale index does not delete it',
    left.length === 1 && String(left[0].id) === String(before[1].id),
    `slip left ${JSON.stringify(left)}, expected exactly ${JSON.stringify([before[1]])}`
  );
});

// ── #49 the loaders have no sequence guard ─────────────────────────────────
await scenario('#49 a stale response cannot overwrite a newer render (bets)', async () => {
  const p = await freshPage();
  await login('demo', 'uipub-demo-password');
  p.markSignedIn();

  // Two OUT-OF-ORDER responses into the SAME container: the Open-orders fetch is
  // held open, the Positions fetch completes, and only then does the stale one
  // land. Without a per-mount sequence token the stale open-orders table paints
  // over the Positions tab that is still highlighted.
  const gate = latch();
  await page.route('**/api/orders*', async (route) => {
    gate.wait();
    await gate.pending;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        orders: [
          {
            id: 987654,
            event_name: 'STALE-EVENT',
            market_name: 'STALE-MARKET',
            selection_name: 'STALE-SELECTION',
            side: 'back',
            price: 2,
            stake_cents: 1000,
            matched_cents: 0,
            placed_at: '2026-01-01 00:00:00',
          },
        ],
      }),
    });
  });
  await page.route('**/api/positions*', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        positions: [
          {
            market_id: 424242,
            market_name: 'FRESH-MARKET',
            market_status: 'open',
            event_name: 'FRESH-EVENT',
            cashout: null,
            selections: [{ name: 'FRESH-SELECTION', my_back_stake_cents: 1000, my_lay_stake_cents: 0, frozen_cents: 1000 }],
            pnl_if_win: [{ name: 'FRESH-SELECTION', pnl_cents: 1000 }],
          },
        ],
      }),
    })
  );

  await page.evaluate(() => {
    window.OB.state.betsTab = 'open';
    location.hash = '#/bets';
  });
  await gate.wait(); // the Open-orders load is in flight and parked
  await page.locator('[data-tab="positions"]').click(); // switch tab mid-flight
  await page.waitForSelector('#betsBody .poscard');
  check('the newer render is the Positions tab', /FRESH-SELECTION/.test(await page.locator('#betsBody').innerText()), '');

  gate.open(); // the stale Open-orders response finally lands
  await sleep(600);

  const body = await page.locator('#betsBody').innerText();
  check('the stale Open-orders response does NOT overwrite the Positions render', !/STALE-SELECTION/.test(body), JSON.stringify(body.slice(0, 200)));
  const tabCls = await page.locator('[data-tab="positions"]').getAttribute('class');
  check('the Positions tab is still the highlighted one', /primary/.test(tabCls || ''), tabCls || '');
});

await scenario('#49 a stale response cannot overwrite a newer render (wallet)', async () => {
  const p = await freshPage();
  await login('demo', 'uipub-demo-password');
  p.markSignedIn();

  // Same shape on a different mount point: the first loadWallet() is held open,
  // the second completes, and only then is the first released.
  await page.evaluate(() => {
    location.hash = '#/wallet';
  });
  await page.waitForSelector('#wBal');

  const gate = latch();
  let n = 0;
  await page.route('**/api/wallet', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    n++;
    const cents = n === 1 ? 111 : 222;
    if (n === 1) {
      gate.wait();
      await gate.pending;
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        balance_cents: cents,
        available_cents: cents,
        frozen_cents: 0,
        transactions: [{ type: 'deposit', amount_cents: cents, balance_after: cents, frozen_after: 0, at: '2026-01-01 00:00:00' }],
      }),
    });
  });

  // NOTE the block bodies: `page.evaluate(() => window.OB.loadWallet())`
  // RETURNS the loader's promise, so Playwright waits for the very request the
  // gate is holding open and the page dies on the stall. The block-bodied calls
  // below fire the loader and return undefined.
  await page.evaluate(() => {
    window.OB.loadWallet();
  });
  await gate.wait(); // the older load is parked
  await page.evaluate(() => {
    window.OB.loadWallet();
  }); // the newer load wins
  await page.waitForFunction(() => document.querySelector('#wBal') && /2\.22/.test(document.querySelector('#wBal').textContent), null, { timeout: 10000 });
  check('the newer wallet render is on screen', true, '');

  gate.open(); // the stale response finally lands
  await sleep(600);
  const bal = await page.locator('#wBal').textContent();
  check('a stale wallet response does NOT roll the balance back', /2\.22/.test(bal || ''), bal || '');
});

// ── #50 cash-out renders My Bets from the markets page ─────────────────────
await scenario('#50 cashing out does not replace the page you are on', async () => {
  const p = await freshPage();
  await login('demo', 'uipub-demo-password');
  p.markSignedIn();

  const positions = (list) =>
    page.route('**/api/positions*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ positions: list }),
      });
    });
  const mk = (id, name) => ({
    market_id: id,
    market_name: name,
    market_status: 'open',
    event_name: 'EV' + id,
    cashout: { value_cents: 500, fair_value_cents: 600, margin_bps: 200 },
    selections: [{ name: 'S', my_back_stake_cents: 1000, my_lay_stake_cents: 0, frozen_cents: 1000 }],
    pnl_if_win: [{ name: 'S', pnl_cents: 1000 }],
  });

  // (b) The multi-position fallback must actually LAND on My Bets → Positions.
  // It used to assign the hash the page was ALREADY on, which fires no
  // hashchange, so nothing ever rendered. From the markets page the same
  // assignment happens to work, which is exactly why the bug survived — so
  // start here, on My Bets, which is the most likely place to press Cash Out.
  await page.evaluate(() => {
    window.OB.state.betsTab = 'open';
    location.hash = '#/bets';
  });
  await page.waitForSelector('#betsBody');
  const startTab = await page.locator('[data-tab="open"]').getAttribute('class');
  check('the fallback is exercised from the Open orders tab of My Bets', /primary/.test(startTab || ''), startTab || '');
  await positions([mk(111, 'MULTI-A'), mk(222, 'MULTI-B')]);
  await page.click('#cashoutBtn');
  await page.waitForFunction(() => window.OB.state.betsTab === 'positions', null, { timeout: 10000 });
  await sleep(500);
  const landed = await page.evaluate(() => ({
    page: window.OB.state.page,
    hash: location.hash,
    hasBetsBody: !!document.querySelector('#betsBody'),
    tabCls: (document.querySelector('[data-tab="positions"]') || {}).className || '',
  }));
  check('the multi-position fallback NAVIGATES to My Bets', landed.page === 'bets' && /#\/bets/.test(landed.hash), JSON.stringify(landed));
  check('the multi-position fallback RENDERS the Positions tab it promised', landed.hasBetsBody && /primary/.test(landed.tabCls), JSON.stringify(landed));
  await page.unroute('**/api/positions*');

  // (a) A single successful cash-out must not paint My Bets over the ladder.
  await page.evaluate(() => (location.hash = '#/markets'));
  await page.waitForSelector('.ladder .lcell[data-bet]');
  await positions([mk(333, 'SINGLE-A')]);
  await page.route('**/api/markets/*/cashout', async (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value_cents: 700, market_id: 333 }) })
  );
  await page.click('#cashoutBtn');
  await sleep(1200);
  const after = await page.evaluate(() => ({
    page: window.OB.state.page,
    navActive: (document.querySelector('#nav button.active') || {}).dataset?.page || '',
    ladder: !!document.querySelector('.ladder .lcell[data-bet]'),
    betsBody: !!document.querySelector('#betsBody'),
  }));
  check(
    'cashing out from the markets page leaves the MARKETS page rendered — not the My Bets card',
    after.page === 'markets' && after.ladder && !after.betsBody,
    JSON.stringify(after)
  );
  check('what is on screen still matches the highlighted nav item', after.navActive === after.page, JSON.stringify(after));
});

// ── #51 the held-market release dialog ──────────────────────────────────────
await scenario('#51 the held release dialog names the runners and can express a dead heat', async () => {
  const p = await freshPage();
  // The session cookie is shared across the context, so the earlier scenarios
  // left it signed in as `demo` — and the desk is admin-only. Start clean.
  await page.evaluate(() => window.OB.logout());
  await page.waitForFunction(() => window.OB && !window.OB.state.user, null, { timeout: 15000 });
  await login('admin', 'uipub-admin-password');
  p.markSignedIn();

  await page.route('**/api/admin/results/held', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ markets: [{ id: 555, market_name: 'HELD RACE', event_name: 'HELD EVENT', hold_reason: 'disputed dead heat' }] }),
    })
  );
  await page.route('**/api/admin/results/void-rules', async (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not on this build"}' })
  );

  const runners = [
    { selection_id: 8801, name: 'SILVERPORT', ltp: 3.4 },
    { selection_id: 8802, name: 'BRIGHT BAY', ltp: 3.6 },
  ];
  await page.route('**/api/markets/555/book', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        market: { id: 555, name: 'HELD RACE', settled_at: null },
        book: runners.map((r) => Object.assign({ back: [], lay: [] }, r)),
      }),
    })
  );

  const releases = [];
  await page.route('**/api/admin/results/held/555/release', async (route) => {
    releases.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  // The dialog asks the operator for a written reason; the test is the operator.
  page.on('dialog', (d) => d.accept('held market resolved by the desk'));

  await page.evaluate(() => {
    location.hash = '#/admin';
  });
  await page.waitForSelector('[data-view="results"]');
  await page.click('[data-view="results"]');
  await page.waitForSelector('[data-release-settle="555"]');
  await page.click('[data-release-settle="555"]');
  await page.waitForSelector('.modal [data-winner]', { timeout: 10000 });

  const labels = await page.locator('.modal [data-winner]').allInnerTexts();
  check('the release dialog names every runner', /SILVERPORT/.test(labels.join('|')) && /BRIGHT BAY/.test(labels.join('|')), JSON.stringify(labels));
  check('the release dialog shows no raw selection-id prompt', !/selection id/i.test(await page.locator('.modal').innerText()), '');

  // One winner.
  await page.locator('.modal [data-winner="8801"]').click();
  await page.click('.modal #releaseGo');
  await sleep(500);
  check(
    'a single winner is sent as winner_selection_id',
    releases.length === 1 && releases[0].decision === 'settle' && releases[0].winner_selection_id === 8801,
    JSON.stringify(releases)
  );
  check('a single winner sends no dead_heat list', releases[0] && (releases[0].dead_heat === undefined || releases[0].dead_heat === null), JSON.stringify(releases[0]));

  // Two joint winners — the case the issue says is unreachable from the desk.
  await page.waitForSelector('[data-release-settle="555"]');
  await page.click('[data-release-settle="555"]');
  await page.waitForSelector('.modal [data-winner]');
  await page.locator('.modal [data-winner="8801"]').click();
  await page.locator('.modal [data-winner="8802"]').click();
  await page.click('.modal #releaseGo');
  await sleep(500);
  const dh = releases[1];
  check(
    'a dead heat is sent as a dead_heat list of joint winners',
    !!dh && dh.decision === 'settle' && Array.isArray(dh.dead_heat) && dh.dead_heat.slice().sort().join(',') === '8801,8802',
    JSON.stringify(dh)
  );
  check('a dead heat carries no single winner_selection_id', !!dh && (dh.winner_selection_id === undefined || dh.winner_selection_id === null), JSON.stringify(dh));

  // Void still works, and still demands a written reason.
  await page.waitForSelector('[data-release-void="555"]');
  await page.click('[data-release-void="555"]');
  await page.waitForSelector('.modal [data-void]');
  await page.click('.modal #releaseGo');
  await sleep(500);
  const vd = releases[2];
  check('voiding still works from the same dialog, with the reason attached', !!vd && vd.decision === 'void' && vd.reason === 'held market resolved by the desk', JSON.stringify(vd));
});

// ── wrap up ────────────────────────────────────────────────────────────────
await sleep(200);
check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));

await browser.close();

console.log(`\n${passed} check(s) passed`);
const errs = serverLog.filter((l) => /\berror\b/i.test(l));
if (errs.length) {
  console.log('\nserver log (filtered):');
  for (const l of errs.slice(0, 10)) console.log('  ', l.trim());
}
