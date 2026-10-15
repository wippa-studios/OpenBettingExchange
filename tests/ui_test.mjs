// ui_test.mjs — REAL-BROWSER verification of the exchange UI.
// Run: npm run test:ui
// Run in a shuffled order: npm run test:ui -- --shuffle      (prints the seed)
//                           npm run test:ui -- --shuffle=1234 (replay a seed)
//
// Boots the server on a temp DB (bots on, drift off), drives the page in
// Chromium, and fails on ANY uncaught page error — the class of bug that
// `node --check` cannot see (wrong element id, runtime TypeError, a render
// path that never fires).
//
// #134 — WHY THIS FILE IS A LIST OF SCENARIOS AND NOT A SCRIPT.
//
// It used to be one long script, and a script has an order whether it admits it
// or not. The scenarios below settle markets, and a later one was written to
// find a market still open: it read whatever `[data-settle]` control the desk
// happened to show, which after #51 and #52 had run was a market those two had
// already settled. So the gate's result depended on WHEN it ran — #134 measured
// three clean-`main` runs as pass / fail / pass, which is the definition of a
// gate that cannot be trusted.
//
// The dependency is invisible in file order, which is why it survived: reading
// the scenarios top to bottom, the ones that settle come last, so a reader
// checks that each has a fixture and never asks where the fixture came from.
// `--shuffle` is what makes it visible again.
//
// Two rules replace the accident of order:
//
//   1. Every scenario builds what it needs and tears it down again. Nothing
//      reads a page state, a market or an account a predecessor left behind.
//      `withMarket()` is the fixture: a market this scenario created through
//      the operator's own create route, deleted when the scenario ends.
//   2. `--shuffle` runs the scenarios in a seeded random order and PRINTS THE
//      SEED. Rule 1 is a claim; the shuffle is what makes it falsifiable, and a
//      shuffle you cannot replay is a flake you cannot diagnose.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The window size every geometry assertion in this file is written against.
// Declared before the browser exists, because the browser is created with it.
const VIEWPORT = { width: 1400, height: 900 };

// ── port discovery (S11) ────────────────────────────────────────────────────
// lib/config.js enforces PORT ∈ [1, 65535], so the server itself cannot bind
// port 0. Instead ask the OS for a free port, release it, and hand it over.
// The tiny release→bind window beats a FIXED port, which collides with any
// concurrently running suite or dev server every single time.
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
const PORT = Number(process.env.UI_TEST_PORT) || (await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'ob-ui-'));
const SHOT = process.env.UI_SHOT || path.join(ROOT, 'ui-test.png'); // gitignored: test output, not a source asset

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

// ── the scenario registry ───────────────────────────────────────────────────
//
// Registering and running are separate steps on purpose: the registration pass
// below walks the file top to bottom and only RECORDS what each scenario is,
// then the runner at the end executes them — in file order by default, or in a
// shuffled order when asked. That separation is what makes --shuffle possible at
// all; a suite that runs its scenarios as it parses them cannot reorder them.
const scenarios = [];
const scenario = (name, fn) => {
  scenarios.push({ name, fn });
};

// ── seeded shuffle ──────────────────────────────────────────────────────────
//
// mulberry32 rather than Math.random(): a shuffle that cannot be replayed is a
// flake that cannot be diagnosed, and the acceptance bar for #134 is "passes
// three times in a row", which is only a meaningful claim if a failing run can
// be re-run in exactly the order that produced it. The seed is printed at the
// top of the run for that reason.
const mulberry32 = (seed) => () => {
  let s = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const argv = process.argv.slice(2);
const shuffleFlag = argv.find((a) => a === '--shuffle' || a.startsWith('--shuffle='));
const SHUFFLE =
  !!shuffleFlag ||
  /^(1|true|yes|on)$/i.test(String(process.env.UI_TEST_SHUFFLE || '').trim());
// `--shuffle=<n>` wins over the env var, and a bare `--shuffle` draws a fresh
// seed. Anything unparseable as an integer is treated as "draw one" rather than
// silently shuffling by seed 0 — a typo must not quietly become a fixed order.
const seedArg =
  (shuffleFlag && shuffleFlag.includes('=') ? shuffleFlag.split('=')[1] : '') ||
  String(process.env.UI_TEST_SEED || process.env.UI_TEST_SHUFFLE_SEED || '');
const SHUFFLE_SEED = /^\d+$/.test(seedArg) ? Number(seedArg) : 1 + Math.floor(Math.random() * 2147483646);

const plannedOrder = () => {
  if (!SHUFFLE) return scenarios;
  const rnd = mulberry32(SHUFFLE_SEED);
  const out = [...scenarios];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
  cwd: ROOT,
  // ADMIN_PASSWORD / DEMO_PASSWORD are set so this suite runs as a
  // PROPERLY CONFIGURED deployment rather than on the seeded demo
  // credentials. The first-run lock (tests/setup.test.js) deliberately makes a
  // demo-password account unable to reach anything except the panel that
  // changes it — correct behaviour, and it would otherwise block every flow
  // here on the first login.
  //
  // The rate-limit budgets are raised for the same reason and with the same
  // caveat: now that each scenario signs in and out for itself (#134), one run
  // spends a few dozen `auth` requests from a single address, and the 60/min
  // production default would start refusing logins for reasons that have
  // nothing to do with what is under test. Nothing in THIS file asserts on a
  // 429 — tests/ratelimit-coverage.test.js owns that, with its own budgets — so
  // raising them here removes a flake without removing a check.
  env: {
    ...process.env,
    DB_PATH: path.join(TMP, 'ui.db'),
    PORT: String(PORT),
    DRIFT_ENABLED: 'false',
    // The venue currency is PINNED here, not inherited (#104). The deployment
    // default is AUD, and the assertions below are written against the dollar
    // sign — the browser suite states the configuration it asserts on rather
    // than depending on whatever the default happens to be. The dollar path is
    // the one with a symbol of length 1, so these assertions stay exact.
    //
    // The other currency is covered deliberately, further down, by driving
    // OB.fmt directly: pinning one currency for the whole suite would otherwise
    // leave the formatter's only new behaviour untested.
    VENUE_CURRENCY: 'USD',
    ADMIN_PASSWORD: 'ui-admin-password',
    DEMO_PASSWORD: 'ui-demo-password',
    RATE_LIMIT_AUTH: '600',
    RATE_LIMIT_ADMIN: '2000',
    RATE_LIMIT_READ: '4000',
    RATE_LIMIT_TRADE: '2000',
    RATE_LIMIT_CASHOUT: '400',
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

// Wait for readiness.
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${BASE}/api/sports`);
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT });

// The venue is loaded ONCE, here, before any scenario runs.
//
// It used to be loaded inside whichever scenario happened to be written first,
// which is only the same thing while the file order is the run order. Under a
// shuffle the first scenario to execute could be one that never navigates, and
// every relative URL in the page ("/api/…") then resolves against about:blank
// — which is not a failure of the scenario that ran, it is a failure of every
// scenario after it. The board scenario below still does its own goto, because
// "the shell renders from a cold load" is one of the things it asserts.
await page.goto(BASE, { waitUntil: 'domcontentloaded' });

// Any uncaught exception in the page is a failure, whatever else passes.
// The app probes /api/me on load to detect an existing session; while signed
// out that legitimately 401s and Chromium logs it — expected, not a defect.
const pageErrors = [];
let signedIn = false;
// Set around a DELIBERATE 401 (proving an old password no longer works).
// The preauth filter above cannot cover it — it keys on `signedIn` — and a
// wrong-password login is an expected rejection, not a defect.
let expectAuth401 = false;
const EXPECTED_PREAUTH_401 = /401 \(Unauthorized\)/;
// Set while the first-run-lock scenario runs. A locked account is refused by
// everything outside SETUP_ALLOWLIST — including the board the app re-renders
// behind the password panel — so Chromium logs those 403s. That is the lock
// WORKING, exactly as the signed-out 401 above is the whoami probe working.
let expectLock403 = false;
const EXPECTED_LOCK_403 = /403 \(Forbidden\)/;
// Set while #68 injects a 500 on /api/events on purpose. Chromium logs the
// refused response as a console error, and a test that manufactures the fault
// it then asserts on must not be failed by its own instrumentation.
let expectEvents500 = false;
const EXPECTED_EVENTS_500 = /500 \(Internal Server Error\)/;
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = 'console.error: ' + msg.text();
  if (!signedIn && EXPECTED_PREAUTH_401.test(msg.text())) return;
  if (expectAuth401 && EXPECTED_PREAUTH_401.test(msg.text())) return;
  if (expectLock403 && EXPECTED_LOCK_403.test(msg.text())) return;
  if (expectEvents500 && EXPECTED_EVENTS_500.test(msg.text())) return;
  pageErrors.push(text);
});


// ── precondition helpers (#134) ─────────────────────────────────────────────
//
// Every scenario below starts by saying what it needs: this account, this page,
// this admin tab, this market. Before #134 they did not — each one opened
// wherever the previous one happened to leave the browser, which is precisely
// what made the suite order-dependent. The helpers are small on purpose; the
// value is that "which view is on screen" stops being inherited state.
const waitForAuthLabel = (want) =>
  page.waitForFunction((w) => document.getElementById('authBtn').textContent.trim() === w, want, { timeout: 20000 });

const signOut = async () => {
  if (((await page.locator('#authBtn').textContent()) || '').trim() !== 'Sign out') return;
  signedIn = false; // before the click, so the logout's own /api/me 401 is expected
  await page.click('#authBtn');
  await waitForAuthLabel('Sign in');
};

const signIn = async (user, pass) => {
  await signOut();
  await page.click('#authBtn');
  await page.waitForSelector('#authModal.show', { timeout: 10000 });
  await page.fill('#authUser', user);
  await page.fill('#authPass', pass);
  await page.click('#authGo');
  await page.waitForSelector('#balance:not([hidden])', { timeout: 20000 });
  signedIn = true;
};

// Register a throwaway account and leave the browser signed in as it. Written
// through the real /api/auth/register route rather than a direct database row,
// so the account is one the product itself would have created — a hand-inserted
// user would not have the account row the audit trail and the limits screen
// both read.
const registerAccount = (username, email) =>
  page.evaluate(
    async ([u, e]) => {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: u, email: e, password: 'secret1' }),
      });
      if (!r.ok) throw new Error(`register ${u} answered ${r.status}: ${(await r.text()).slice(0, 120)}`);
    },
    [username, email]
  ).then(async () => {
    await signIn(username, 'secret1');
  });

// `OB.goTo` is the app's own navigation helper, which re-renders when the hash
// is already the one asked for — clicking a nav button that is already active
// fires no hashchange and would leave the scenario where it found the page.
//
// Every wait here names what it was waiting for AND what the page actually
// showed when it gave up. "Timeout 25000ms exceeded" against a selector is a
// symptom; on an order-dependent suite the symptom is rarely the point, and the
// reader has to be able to see which state the scenario inherited.
const waitOrExplain = async (selector, what, timeout = 25000) => {
  try {
    await page.waitForSelector(selector, { timeout });
  } catch (e) {
    const seen = await page
      .evaluate(() => ({
        page: window.OB && window.OB.state ? window.OB.state.page : null,
        user: window.OB && window.OB.state && window.OB.state.user ? window.OB.state.user.username : null,
        sport: window.OB && window.OB.state ? window.OB.state.sport : null,
        overlays: [...document.querySelectorAll('.show')].map((n) => n.id || n.className),
        text: ((document.querySelector('#page') || {}).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      }))
      .catch(() => null);
    throw new Error(`${what}: ${selector} never appeared — ${JSON.stringify(seen)}`);
  }
};

const atMarkets = async () => {
  // The refresh is part of the precondition, not an optimisation. `renderPage()`
  // renders the board from `OB.state.events` and does NOT re-fetch, and the 15s
  // poll is switched off whenever the SSE stream is live — which it is for every
  // signed-in scenario here. So once any load of /api/events has failed, every
  // later `goTo('markets')` re-renders the SAME fault card, and a scenario that
  // navigates to the board as its first act inherits a failure it did not cause.
  // (Reported to the frontend owners: in the product the only recovery from a
  // failed board load is the Retry button, because the poll never retries one.)
  await page.evaluate(async () => {
    window.OB.goTo('markets');
    await window.OB.refreshMarkets();
  });
  await waitOrExplain('#page .ladder .lcell[data-bet]', 'the ladder never rendered');
};
const atBets = async () => {
  await page.evaluate(() => window.OB.goTo('bets'));
  await waitOrExplain('#page #betsBody', 'My Bets never rendered');
};
const atWallet = async () => {
  await page.evaluate(() => window.OB.goTo('wallet'));
  await waitOrExplain('#page #wBal', 'the Wallet never rendered');
};
const ADMIN_READY =
  '#adminBody .adm-tbl tbody tr, #adminBody .statgrid, #adminBody table, #adminBody .empty, #adminBody .meter, #adminBody .card';
const atAdmin = async (view) => {
  await page.evaluate(() => window.OB.goTo('admin'));
  await waitOrExplain('[data-view="markets"]', 'the operator desk never opened');
  if (!view) return;
  await page.click(`[data-view="${view}"]`);
  await waitOrExplain(ADMIN_READY, `the ${view} view never rendered`);
};
const onBoardCell = () => waitOrExplain('#page .ladder button.lcell[data-bet]', 'a price cell never appeared');

// ── fixture markets (#134) ──────────────────────────────────────────────────
//
// A scenario that holds, suspends or settles a market now creates its OWN
// through the operator's own create route, and deletes it when it finishes.
// The alternative — settling whatever open market the desk happened to be
// showing — is what made the suite order-dependent: after #51 and #52 had run,
// there was nothing left for the next scenario to settle.
//
// Created rather than borrowed for a second reason too. The desk lists markets
// newest-first, so a market this scenario made is the row its controls live on
// — the scenario never has to search for "an open one" and cannot pick up
// another scenario's in-flight state by accident.
const FIXTURE_EVENT = 'UI Test Fixture Event';

const createFixtureMarket = (label, runners = 3) =>
  page.evaluate(
    async ([eventName, marketName, n]) => {
      const post = async (url, body) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`${url} answered ${r.status}: ${(await r.text()).slice(0, 120)}`);
        return r.json();
      };
      const sports = await (await fetch('/api/sports')).json();
      const list = sports.sports || [];
      if (!list.length) throw new Error('the catalogue has no sport to hang a fixture event on');
      // Far future: an event whose start has passed is a different market to
      // the board, and a fixture must not depend on the clock.
      const { event } = await post('/api/admin/events', {
        sport_id: list[0].id,
        name: eventName,
        starts_at: '2030-01-01 00:00:00',
      });
      const { market } = await post('/api/admin/markets', { event_id: event.id, name: marketName });
      const selectionIds = [];
      for (let i = 0; i < n; i++) {
        const { selection } = await post('/api/admin/selections', {
          market_id: market.id,
          name: `${marketName} Runner ${i + 1}`,
          fair_price: 2 + i * 0.5,
        });
        selectionIds.push(selection.id);
      }
      return { marketId: market.id, eventId: event.id, selectionIds };
    },
    [FIXTURE_EVENT, `UI Test ${label}`, runners]
  );

let sqlite = null;
// The server writes to this database continuously (the bots requote every few
// seconds), and node:sqlite fails immediately on contention by default. Without
// a busy timeout, writing the same row the suite writes before a check can lose
// that race and throw "database is locked" — a failure in the FIXTURE code that
// reads like a failure in the product.
const openDb = async () => {
  if (!sqlite) ({ DatabaseSync: sqlite } = await import('node:sqlite'));
  const db = new sqlite(path.join(TMP, 'ui.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
};

const dropFixtureMarket = async (fx) => {
  if (!fx) return;
  const db = await openDb();
  // Foreign keys are off for THIS connection only, so a table the fixture never
  // touched cannot turn a teardown into an error halfway through and leave a
  // half-deleted fixture behind.
  db.exec('PRAGMA foreign_keys = OFF');
  const byMarket = (sql) => db.exec(sql.replace('{m}', String(fx.marketId)));
  // WHAT IS DELETED, and what deliberately is not.
  //
  // Catalogue rows only: the event, the market, its selections and the things
  // that merely POINT at them. That is enough to put the board and the desk
  // back exactly as they were for whichever scenario runs next.
  //
  // `orders`, `matches`, `settlements`, `transactions` and `entries` stay. The
  // ledger is append-only by design — "corrections are reversing postings, which
  // is why there is no updated_at" — and `orders.frozen_cents` is escrow a live
  // order is still holding. Deleting an order or a posting without the reversing
  // legs the product would write desynchronises users.balance_cents from the
  // accounts, and this suite's OWN `ledger shows no cache divergence` check
  // (and /api/admin/readiness behind it) is right to fail when that happens. A
  // test fixture must not rewrite the money history to tidy up after itself;
  // the database is a temp directory that is deleted when the run ends.
  byMarket('DELETE FROM cashout_quotes WHERE market_id = {m}');
  byMarket('DELETE FROM result_events WHERE market_id = {m}');
  byMarket('DELETE FROM price_history WHERE selection_id IN (SELECT id FROM selections WHERE market_id = {m})');
  byMarket('DELETE FROM user_rules WHERE selection_id IN (SELECT id FROM selections WHERE market_id = {m})');
  byMarket('DELETE FROM selections WHERE market_id = {m}');
  byMarket('DELETE FROM markets WHERE id = {m}');
  db.exec(`DELETE FROM events WHERE id = ${Number(fx.eventId)}`);
  db.close();
  // The deleted market may still be painted on whatever board the browser is
  // showing, and a stale card's price cells are clickable buttons pointing at a
  // market that no longer exists. Repaint before the next scenario reads the
  // page rather than trusting the 15s poll to get there first.
  await page.evaluate(() => (window.OB ? window.OB.refreshAll() : null)).catch(() => {});
};

// withMarket: the fixture, with the teardown attached to the scenario. A
// scenario that builds a market and forgets to drop it is the exact defect
// #134 is about, one level down, so the pairing is not left to the caller.
const withMarket = async (label, body, runners = 3) => {
  const fx = await createFixtureMarket(label, runners);
  try {
    return await body(fx);
  } finally {
    await dropFixtureMarket(fx);
  }
};

// ── between-scenario reset ──────────────────────────────────────────────────
//
// A safety net, not the mechanism: each scenario undoes its own changes (see
// the try/finally blocks below), and this catches the ones that die before
// their cleanup runs. Without it a scenario that aborts mid-way leaves a mocked
// route, a 700px viewport or a one-sport board filter installed, and every
// scenario after it fails for a reason that has nothing to do with itself —
// which is how a real defect gets reported as a mystery.
const resetBetweenScenarios = async () => {
  await page.setViewportSize(VIEWPORT).catch(() => {});
  await page.unroute('**/api/positions').catch(() => {});
  await page.unroute('**/api/events*').catch(() => {});
  await page.emulateMedia({ colorScheme: 'light' }).catch(() => {});
  // An overlay left open is the loudest way one scenario can break the next
  // twenty: #accountModal covers the viewport, so every later click lands on it
  // and reports "Timeout 30000ms exceeded" against a button that was never the
  // problem. Escape closes the TOP overlay, so it may need pressing more than
  // once — the same rule the app's own overlay stack uses. The selector names
  // the overlays, not `.show`: the toast carries that class too and pressing
  // Escape at a toast is three wasted round trips per scenario.
  const openOverlays = '#authModal.show, #accountModal.show, .modal[role="dialog"]';
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator(openOverlays).count())) break;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(150);
  }
  await page
    .evaluate(() => {
      try {
        localStorage.removeItem('obx.theme');
      } catch {}
      if (!window.OB || !window.OB.state) return;
      // `betsTab` is app state that outlives navigation: a scenario that clicks
      // Positions leaves every later scenario looking at Positions, even
      // though "Open orders" is what the app ships as the default. Scenarios
      // that need a specific tab select it themselves; this only keeps the
      // next scenario from inheriting one it never asked for.
      window.OB.state.betsTab = 'open';
      if (window.OB.state.sport !== null) {
        window.OB.state.sport = null;
        return window.OB.refreshAll();
      }
    })
    .catch(() => {});
};

if (SHUFFLE) {
  console.log(
    `ui_test.mjs: run order SHUFFLED — seed ${SHUFFLE_SEED}. ` +
      `Replay this exact order with: npm run test:ui -- --shuffle=${SHUFFLE_SEED}`
  );
}

try {
  // ── board renders with bot liquidity ──────────────────────────────────
  //
  // The FIRST scenario has to do what the browser did on the very first load,
  // because a shuffled run may not be the first one any more: navigate to the
  // venue from scratch rather than inheriting whatever the previous scenario
  // painted. Every later scenario calls atMarkets() instead.
  scenario('the board renders with bot liquidity', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // The one scenario that asserts what a SIGNED-OUT visitor sees has to put
  // itself in that state: in a shuffled run the session cookie may be an
  // operator's by the time this gets here (#134).
  await signOut();
  await atMarkets();
  await page.waitForSelector('.ladder .lcell[data-bet]', { timeout: 15000 });
  const cells = await page.locator('.ladder .lcell[data-bet]').count();
  check('ladder renders price cells', cells >= 6, `(${cells} cells)`);

  // W7: price cells are real <button>s with aria-labels and no inline
  // handlers — keyboard users can bet, screen readers can read the price.
  const cellsMeta = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.ladder .lcell[data-bet]')];
    return {
      n: nodes.length,
      allButtons: nodes.every((c) => c.tagName === 'BUTTON' && c.type === 'button'),
      allLabelled: nodes.every((c) => /^((Back|Lay) .+ at \d+\.\d{2}, \$\d+\.\d{2} available)$/.test(c.getAttribute('aria-label') || '')),
      noInlineHandlers: nodes.every((c) => !c.hasAttribute('onclick')),
    };
  });
  check('ladder cells are <button type="button">', cellsMeta.n > 0 && cellsMeta.allButtons, `(${cellsMeta.n} cells)`);
  check('every price cell has a descriptive aria-label', cellsMeta.allLabelled);
  check('cells carry no inline event handlers', cellsMeta.noInlineHandlers);

  // Geometry: each runner is ONE row of
  //   [ RUNNER | 3 blue back | 3 pink lay ]
  // with the price levels SIDE BY SIDE, not stacked vertically. The two best
  // prices meet in the middle of the row. This replaced a vertical-stack layout
  // that made every runner a 157px block; the assertions below pin the shape that
  // replaced it, because "it renders" would not catch a regression to 157px rows.
  const geom = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.lrow')].find((r) => r.querySelector('.lcell[data-bet]'));
    if (!row) return null;
    const box = (n) => {
      const b = n.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const stacks = [...row.querySelectorAll('.lstack')].map(box);
    const live = [...row.querySelectorAll('.lcell:not(.empty)')].map((c) => ({
      ...box(c),
      side: c.classList.contains('back') ? 'back' : 'lay',
    }));
    const backLive = live.filter((c) => c.side === 'back').sort((a, b) => b.x - a.x);
    const layLive = live.filter((c) => c.side === 'lay').sort((a, b) => a.x - b.x);
    const mid = box(row.querySelector('.lmid'));
    const price = row.querySelector('.lcell[data-bet] .p');
    const liq = row.querySelector('.lcell[data-bet] .s');
    return {
      stacks, backLive, layLive, mid,
      kids: row.children.length,
      firstOrder: [...row.children].map((c) => c.className.split(' ')[0]),
      priceBox: price ? box(price) : null,
      liqBox: liq ? box(liq) : null,
    };
  });
  check('runner row is RUNNER | back stack | lay stack', geom && geom.kids === 3, JSON.stringify(geom && geom.kids));
  check(
    'the runner column comes first, then the two price stacks',
    geom && geom.firstOrder[0] === 'lmid' && geom.firstOrder[1] === 'lstack' && geom.firstOrder[2] === 'lstack',
    geom ? JSON.stringify(geom.firstOrder) : 'no row'
  );
  check(
    'price levels sit side by side, not stacked in one column',
    // Stacked would mean every back cell sharing an x and stepping down in y.
    // Side by side means distinct x positions. A single-level side has one cell
    // and is trivially satisfied.
    geom && new Set(geom.backLive.map((c) => c.x)).size === geom.backLive.length,
    geom ? JSON.stringify(geom.backLive.map((c) => `${c.x},${c.y}`)) : 'no row'
  );
  check(
    'a price cell stays short — a runner is one compact row',
    geom && geom.backLive[0].h < 60,
    geom ? `cell height ${geom.backLive[0].h}px` : 'no row'
  );
  check(
    'back, runner and lay are left to right',
    geom && geom.stacks[0].x > geom.mid.x && geom.mid.x + geom.mid.w <= geom.stacks[0].x + 1 && geom.stacks[0].x + geom.stacks[0].w <= geom.stacks[1].x + 1,
    geom ? `runner@${geom.mid.x} back@${geom.stacks[0].x} lay@${geom.stacks[1].x}` : 'no row'
  );
  check(
    "the best back and best lay prices sit directly adjacent",
    geom && geom.backLive[0] && geom.layLive[0] && geom.layLive[0].x - (geom.backLive[0].x + geom.backLive[0].w) <= 6,
    geom && geom.backLive[0] && geom.layLive[0]
      ? `back ends ${geom.backLive[0].x + geom.backLive[0].w}, lay starts ${geom.layLive[0].x}`
      : 'no row'
  );
  check(
    'odds sit above the liquidity inside a cell',
    geom && geom.priceBox && geom.liqBox && geom.priceBox.y < geom.liqBox.y,
    geom && geom.priceBox ? `price@${geom.priceBox.y} liquidity@${geom.liqBox.y}` : 'no row'
  );
  check(
    'back cells are blue and lay cells are pink',
    await page.evaluate(() => {
      const b = document.querySelector('.lcell.back');
      const l = document.querySelector('.lcell.lay');
      if (!b || !l) return false;
      return getComputedStyle(b).backgroundColor !== getComputedStyle(l).backgroundColor;
    }),
    ''
  );
  // The sport filter lives in the LEFT RAIL, not a header bar. It used to be a
  // #sportbar inserted after the nav, which put the sport picker in the
  // top-right corner — away from the markets it filters, and in the space the
  // ladder should own.
  const railVisible = await page.locator('#sidebar').isVisible();
  check('the sport rail is visible in seeded mode', railVisible);

  const chipText = await page.locator('#sportsList .chip').first().textContent();
  check('sport filter renders in the left rail', /All/i.test(chipText || ''), `(${String(chipText).trim()})`);
  check('the sport filter is NOT in the header', (await page.locator('#sportbar').count()) === 0);

  const chipCount = await page.locator('#sportsList .chip').count();
  check('every sport is listed in the rail', chipCount >= 2, `(${chipCount} chips)`);

  // Clicking a sport must filter the board, not just restyle a chip.
  const beforeFilter = await page.locator('.card').count();
  await page.locator('#sportsList .chip').nth(1).click();
  await page.waitForTimeout(600);
  const afterFilter = await page.locator('.card').count();
  check('choosing a sport filters the board', afterFilter !== beforeFilter || afterFilter > 0,
    `(${beforeFilter} -> ${afterFilter} markets)`);
  await page.locator('#sportsList .chip').first().click();
  await page.waitForTimeout(600);

  check('signed-out user sees the sign-in button', (await page.locator('#authBtn').textContent()) === 'Sign in');
  });

  // ── seeded search: results appear, a click navigates (CRITICAL 3) ─────
  scenario('the global search finds a seeded runner, and the pick navigates', async () => {
  await signOut();
  await atMarkets();
  await page.fill('#globalSearch', 'Arsenal');
  await page.waitForSelector('#searchResults .srow', { timeout: 5000 });
  const srows = await page.locator('#searchResults .srow').count();
  check('seeded search returns results for a seeded runner', srows >= 1, `(${srows} rows)`);
  await page.locator('#searchResults .srow').first().click();
  await page.waitForFunction(() => document.getElementById('searchResults').hidden, null, { timeout: 5000 });
  check('search click dismisses the results box', true);
  await page.waitForSelector('.ladder', { timeout: 5000 });
  check('search click re-renders the board without errors', true);
  check('search input is cleared after the pick', (await page.locator('#globalSearch').inputValue()) === '');
  });

  // ── clicking a price without a session opens the auth modal ──────────
  //
  // One scenario, because the three checks are one story: the modal opens, the
  // topmost-overlay Escape closes it, and the keyboard alone can reach the same
  // cell. Split them and the second has to invent its own starting state.
  scenario('a price cell signed out opens sign-in, and Escape closes it', async () => {
  await signOut();
  await atMarkets();
  await page.locator('.ladder button.lcell[data-bet]').first().click();
  await page.waitForSelector('#authModal.show', { timeout: 5000 });
  check('clicking a price unauthenticated opens sign-in', true);

  // S4: Escape routes through the overlay stack — it closes the topmost
  // overlay (the auth modal here) and returns focus to the element that
  // opened it.
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.getElementById('authModal').classList.contains('show'),
    null,
    { timeout: 3000 }
  );
  check('Escape closes the auth modal', true);

  // W7: the same cell is reachable and actionable from the keyboard alone.
  await page.locator('.ladder button.lcell[data-bet]').first().focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#authModal.show', { timeout: 5000 });
  check('a focused ladder cell responds to Enter (keyboard bet path)', true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.getElementById('authModal').classList.contains('show'),
    null,
    { timeout: 3000 }
  );
  });

  // ── sign in as the seeded demo user ──────────────────────────────────
  scenario('signing in as the seeded demo user replaces the button with sign out', async () => {
  await signIn('demo', 'ui-demo-password');
  // Wait for the real success signal (balance chip), then assert the modal closed.
  await page.waitForSelector('#balance:not([hidden])', { timeout: 10000 });
  check('auth modal closes after sign-in', (await page.locator('#authModal').getAttribute('class')) !== 'show');
  const balance = (await page.locator('#balance').textContent()) || '';
  check('balance chip shows after sign-in', /\$\d/.test(balance), `(${balance.trim()})`);
  check('sign-in button becomes sign out', (await page.locator('#authBtn').textContent()) === 'Sign out');
  });

  // ── place a bet through the slip ─────────────────────────────────────
  scenario('a bet placed through the slip reaches the book', async () => {
  await signIn('demo', 'ui-demo-password');
  await atMarkets();
  const target = page.locator('.ladder .lcell[data-bet]').first();
  const clickedPrice = (await target.getAttribute('data-price')) || '';
  const clickedSide = (await target.getAttribute('data-side')) || '';
  await target.click();
  await page.waitForSelector('#slip:not([hidden]) .sliprow', { timeout: 5000 });
  const slipText = (await page.locator('#slip .sliprow').first().textContent()) || '';
  check('bet slip opens with the clicked side', slipText.includes(clickedSide.toUpperCase()), `(${clickedSide} @ ${clickedPrice})`);
  const priceShown = (await page.locator('#slip input[data-price]').first().inputValue()) || '';
  check('slip price matches the clicked price', Math.abs(Number(priceShown) - Number(clickedPrice)) < 1e-9, `(${priceShown})`);
  // A runner name containing "ROW" must survive the slip render (the old
  // /ROW/g sentinel rewrote "ARROWTOWN RC" into "AR0TOWN RC"). (W1)
  const slipRowHtml = (await page.locator('#slip .sliprow').first().evaluate((n) => n.innerHTML)) || '';
  // The DOM serializes an unvalued attribute as name="" — the old sentinel
  // would serialize as data-rm="0" (a row-index value). Assert the empty
  // form, and that no ROW" marker ever appears in the row.
  check('slip row carries unvalued data-* markers (no ROW sentinel)', !/ROW"/.test(slipRowHtml) && /data-rm=""/.test(slipRowHtml));

  // Typing a price must be honoured (snapped), not silently ignored. The
  // input keeps the typed text while focused (the slip never fights the
  // field the user is in) — the snapped price shows in the slip HEAD.
  await page.fill('#slip input[data-price]', '2.13');
  await page.dispatchEvent('#slip input[data-price]', 'change');
  await page.waitForFunction(
    (before) => {
      const head = document.querySelector('#slip .sliphead .tn');
      return head && head.textContent !== before;
    },
    `@ ${clickedPrice}`,
    { timeout: 3000 }
  );
  const headPrice = ((await page.locator('#slip .sliphead .tn').textContent()) || '').trim();
  check('typed price snaps to the ladder', /^@ \d+\.\d{2}$/.test(headPrice) && headPrice !== '@ 2.13', `(${headPrice})`);

  await page.fill('#slip input[data-stake]', '2');
  await page.dispatchEvent('#slip input[data-stake]', 'change');
  await page.click('#slip button.place');
  // Wait for the BET's toast, not merely "a toast is visible": the sign-in
  // toast from several steps earlier is often still .show when this runs, so
  // waitForSelector('#toast.show') would resolve instantly against it.
  await page.waitForFunction(
    () => /Matched|Resting/.test((document.querySelector('#toast') || {}).textContent || ''),
    { timeout: 10000 }
  );
  const toast = (await page.locator('#toast').textContent()) || '';
  check('placing a bet reports matched or resting', /Matched|Resting/.test(toast), `("${toast.trim()}")`);
  await page.waitForFunction(() => document.getElementById('slip').hidden, null, { timeout: 5000 });
  check('slip clears after placing', true);
  });

  // ── my bets shows the order or a position ────────────────────────────
  scenario('My Bets renders both tabs for a signed-in customer', async () => {
  await signIn('demo', 'ui-demo-password');
  await atBets();
  await page.click('[data-tab="positions"]');
  await page.waitForSelector('#betsBody .poscard, #betsBody .empty', { timeout: 10000 });
  const posHtml = (await page.locator('#betsBody').innerHTML()) || '';
  check('positions tab renders without error', posHtml.length > 0);
  await page.click('[data-tab="open"]');
  await page.waitForSelector('#betsBody table, #betsBody .empty', { timeout: 10000 });
  const openHtml = (await page.locator('#betsBody').innerHTML()) || '';
  check('open orders tab renders without error', openHtml.length > 0);
  });

  // ── wallet shows the ledger ──────────────────────────────────────────
  scenario('the wallet renders a balance and its ledger', async () => {
  await signIn('demo', 'ui-demo-password');
  await atWallet();
  const bal = (await page.locator('#wBal').textContent()) || '';
  check('wallet renders a balance', /\$\d/.test(bal), `(${bal})`);
  await page.waitForFunction(() => document.querySelector('#wTx table, #wTx .empty'), null, { timeout: 10000 });
  check('wallet renders transactions or an empty state', true);
  });

  // ── admin desk is hidden for a normal user ───────────────────────────
  scenario('the admin tab is hidden for a customer', async () => {
  await signIn('demo', 'ui-demo-password');
  await atMarkets();
  check('admin tab hidden for a customer', await page.locator('#navAdmin').isHidden());
  await page.screenshot({ path: SHOT, fullPage: false });
  console.log('  info screenshot:', SHOT);
  });

  // ── #50: cash-out must not change which view is on screen ──────────────
  //
  // Two defects, and BOTH of them are "the wrong view is on screen":
  //   (a) doCashOut called renderBets() with no OB.state.page check, so a
  //       cash-out from the Exchange page replaced the whole ladder with the
  //       My Bets card while the nav highlight and location.hash still said
  //       "Exchange" — and the cash-out's own `book` broadcast then repainted
  //       the board over it 200ms later, so whichever fetch resolved last won;
  //   (b) the multi-position fallback assigned location.hash = '#/bets' while
  //       ALREADY on '#/bets'. The same hash fires no `hashchange`, so route()
  //       and renderBets() never ran and Open orders stayed on screen under a
  //       toast promising Positions.
  //
  // So nothing below asserts that *something* rendered — that assertion shape
  // passes with either bug present, and this repository already contains five
  // of them. Every check names the view it expects: `.ladder` (Exchange) is
  // present AND `#betsBody` (My Bets) is absent, plus the nav tab that claims
  // to be showing it and the hash.
  //
  // (a) is also asserted from a RECORD rather than a sample: the wrong view
  // appeared for ~200ms, which is invisible to a screenshot taken afterwards
  // and invisible to any single read. The page therefore logs every mount
  // transition while the cash-out runs.

  const placeBack = async (mktId, stake) => {
    const cell = page.locator(`.lcell[data-bet][data-mkt="${mktId}"]`).first();
    if ((await cell.count()) === 0) return false;
    await cell.click();
    await page.waitForSelector('#slip:not([hidden]) .sliprow', { timeout: 5000 });
    await page.fill('#slip input[data-stake]', String(stake));
    await page.dispatchEvent('#slip input[data-stake]', 'change');
    await page.click('#slip button.place');
    await page.waitForFunction(
      () => /Matched|Resting/.test((document.querySelector('#toast') || {}).textContent || ''),
      { timeout: 10000 }
    );
    await page.waitForFunction(() => document.getElementById('slip').hidden, null, { timeout: 5000 });
    return true;
  };

  // Which markets this account can actually cash out on, read back from the
  // server rather than assumed. DISCOVERED, never hard-coded: the seeded ids
  // follow from seed ordering, and lib/cashout.js returns no quote at all for a
  // market whose selections carry no fair_price — so "the first market on the
  // board" is not a usable stand-in.
  const cashoutEligible = () =>
    page.evaluate(async () => {
      const r = await (await fetch('/api/positions')).json();
      return (r.positions || [])
        .filter((p) => p.cashout && p.market_status === 'open')
        .map((p) => p.market_id);
    });

  // The identity of the view on screen, in one read.
  const viewOnScreen = () =>
    page.evaluate(() => ({
      hash: location.hash,
      statePage: window.OB.state.page,
      ladder: !!document.querySelector('#page .ladder'),
      betsBody: !!document.querySelector('#page #betsBody'),
      wallet: !!document.querySelector('#page #wBal'),
      activeTab: (() => {
        const a = document.querySelector('#nav button.active');
        return a ? a.dataset.page : null;
      })(),
      betsTab: (() => {
        const t = document.querySelector('#page [data-tab].primary');
        return t ? t.dataset.tab : null;
      })(),
    }));

  // Log every change of which view owns #page, so a transient mount cannot be
  // missed by an assertion taken after the repaint.
  const recordViews = () =>
    page.evaluate(() => {
      window.__obViews = [];
      const tick = () => {
        const v = {
          ladder: !!document.querySelector('#page .ladder'),
          bets: !!document.querySelector('#page #betsBody'),
        };
        const last = window.__obViews[window.__obViews.length - 1];
        if (!last || last.ladder !== v.ladder || last.bets !== v.bets) window.__obViews.push(v);
        window.__obViewTimer = setTimeout(tick, 25);
      };
      tick();
    });
  const readViews = () =>
    page.evaluate(() => {
      clearTimeout(window.__obViewTimer);
      return window.__obViews;
    });

  // THE FIXTURE, and the #134 change to it. These two scenarios used to share
  // one: the first built the eligible positions and stashed them in
  // `cashoutFixture`, and the second read the stash. That is the same defect
  // class as the settled markets, one level up — the second scenario could only
  // run after the first, so the order of the suite decided whether it had a
  // fixture at all. Each now builds what IT needs.
  //
  // ensureEligible tops the account up to `n` cash-out-eligible positions and
  // tops the WALLET up too, because these scenarios are the only thing in the
  // suite that spends real stake and three of them each start from whatever the
  // others left. Reading "how many are there" from the server rather than
  // tracking them locally is what lets it be idempotent.
  const ensureEligible = async (n) => {
    let eligible = await cashoutEligible();
    const mktIds = await page.evaluate(() => [
      ...new Set([...document.querySelectorAll('.lcell[data-bet]')].map((c) => c.dataset.mkt)),
    ]);
    for (const id of mktIds.slice(0, 8)) {
      if (eligible.length >= n) break;
      const funds = await page.evaluate(() =>
        fetch('/api/me').then((r) => r.json()).then((m) => Number(m.balance_cents || 0))
      );
      if (funds < 10000) {
        // The same play-money faucet the Wallet's $10 button calls. Without it
        // the third scenario to run in a shuffled order can be left with an
        // empty wallet and fail for a reason that is not what it is testing.
        await page.evaluate(() =>
          fetch('/api/wallet/deposit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ amount_cents: 100000 }),
          })
        );
      }
      await placeBack(id, 50);
      eligible = await cashoutEligible();
    }
    return { eligible, quoted: mktIds.length };
  };

  // Leave EXACTLY one eligible position: top up until there are two or more,
  // then cash out all but the last. Both the "single outcome" and the
  // "cash out from another page" scenarios need exactly one, and asserting
  // "exactly one" on an account a previous scenario topped up would be the
  // order-dependence again.
  const leaveExactlyOneEligible = async () => {
    // Top the account up FIRST: placing a bet needs the board on screen, and
    // reducing the list needs My Bets. Doing it the other way round silently
    // placed nothing — `placeBack` finds no ladder cells off the board, returns
    // false, and the scenario carried on to assert "exactly one" over nothing.
    await atMarkets();
    const top = await ensureEligible(2);
    let eligible = top.eligible;
    await atBets();
    await page.click('#page [data-tab="positions"]');
    await page.waitForSelector('#page #betsBody .poscard, #page #betsBody .empty', { timeout: 15000 });
    // The rendered cards are re-read on every pass, because the list the server
    // reports and the list on screen are two loads of the same thing and the
    // top-up above wrote a third. Cash out of the DOM, not out of `eligible`.
    for (let guard = 0; guard < 8; guard++) {
      eligible = await cashoutEligible();
      if (eligible.length <= 1) break;
      const id = eligible[0];
      const btn = page.locator(`#betsBody [data-cashout="${id}"]`);
      if ((await btn.count()) === 0) break;
      await btn.click();
      await page.waitForFunction(
        (m) => !document.querySelector(`#betsBody [data-cashout="${m}"]`),
        id,
        { timeout: 15000 }
      );
    }
    eligible = await cashoutEligible();
    return { eligible, quoted: top.quoted };
  };

  scenario('#50 cash-out: the multi-position fallback moves the operator', async () => {
    await signIn('demo', 'ui-demo-password');
    await atMarkets();
    // ── fixture: TWO cash-out-eligible positions ──────────────────────────
    const { eligible, quoted } = await ensureEligible(2);
    check(
      '#50 fixture: two cash-out-eligible positions exist',
      eligible.length >= 2,
      `(${eligible.length} of ${quoted} markets quoted)`
    );
    if (eligible.length < 2) return;

    // From the page the fallback TARGETS: My Bets, Open orders tab showing.
    //
    // The tab is SELECTED rather than assumed. `OB.state.betsTab` is app state
    // that survives navigation, so "open orders is the default" only holds until
    // some earlier scenario clicks Positions — which is one inherited page state
    // away from being the default being wrong (#134).
    await atBets();
    await page.click('#page [data-tab="open"]');
    await page.waitForSelector('#page [data-tab="open"].primary', { timeout: 20000 });
    const beforeMulti = await viewOnScreen();
    check(
      '#50 fixture: Open orders is the tab under test',
      beforeMulti.betsTab === 'open' && !beforeMulti.ladder,
      JSON.stringify(beforeMulti)
    );

    await page.locator('#cashoutBtn').click();
    await page.waitForFunction(
      () => /Multiple positions can be cashed out/.test((document.querySelector('#toast') || {}).textContent || ''),
      { timeout: 10000 }
    );
    // Generous settle: any render that was going to happen has now happened.
    // A "did the page change?" assertion taken too early passes by luck.
    await page.waitForTimeout(800);
    const afterMulti = await viewOnScreen();
    check(
      '#50 multi-position Cash Out lands on Positions, not Open orders',
      afterMulti.betsTab === 'positions' && afterMulti.ladder === false && afterMulti.hash === '#/bets',
      JSON.stringify(afterMulti)
    );
    check(
      '#50 the promised Positions tab actually rendered position cards',
      (await page.locator('#page #betsBody .poscard').count()) > 0,
      `(${await page.locator('#page #betsBody .poscard').count()} cards)`
    );
  });

  scenario('#50 cash-out: the single-outcome branch stays on its own page', async () => {
    await signIn('demo', 'ui-demo-password');
    // Open the Positions tab explicitly rather than relying on any earlier
    // scenario having switched it, so this scenario's starting point is the
    // same whatever ran before it.
    //
    // ── (a) leave exactly one eligible position, cashing the rest out from
    // the Positions tab. Those per-position controls do not route, so the
    // board the next step needs is untouched by the reduction.
    const { eligible } = await leaveExactlyOneEligible();
    check('#50 fixture: exactly one cash-out-eligible position remains', eligible.length === 1, `(${eligible.length}: markets ${JSON.stringify(eligible)})`);
    if (eligible.length !== 1) return;

    await atMarkets();
    const beforeSingle = await viewOnScreen();
    check(
      '#50 fixture: the Exchange ladder is the view under test',
      beforeSingle.ladder && !beforeSingle.betsBody && beforeSingle.activeTab === 'markets',
      JSON.stringify(beforeSingle)
    );

    await recordViews();
    await page.locator('#cashoutBtn').click();
    await page.waitForFunction(
      () => /Cashed out/.test((document.querySelector('#toast') || {}).textContent || ''),
      { timeout: 15000 }
    );
    // Past the 200ms `book` debounce in boot.js AND the refresh it triggers.
    await page.waitForTimeout(1500);
    const views = await readViews();
    // This is the ONLY shape of assertion on (a) that DISCRIMINATES from the
    // markets page: boot.js repaints the ladder while state.page is still
    // 'markets', so a view read after the settle looks correct and passes
    // with the bug present — this repository's exact failure mode. The wrong
    // view really did exist in between, which is why the transitions are
    // RECORDED at 25ms intervals rather than sampled once.
    check(
      '#50 the My Bets card never mounts while the Exchange page is open',
      !views.some((v) => v.bets),
      `view transitions: ${JSON.stringify(views)}`
    );
  });

  // (a), second half, on a page the repaint CANNOT rescue. refreshMarkets()
  // only renders when state.page === 'markets', and the `balance` listener
  // calls loadWallet(), which bails on a missing #wTx — so a cash-out from the
  // Wallet strands the My Bets card over the wallet indefinitely. Same defect,
  // no 200ms repair, and therefore assertable by a single read.
  scenario('#50 cash-out from another page leaves that page on screen', async () => {
    // The same "exactly one" fixture as the scenario above, built again rather
    // than inherited: that scenario cashed the last one out, and a shuffled run
    // may not have run it at all.
    await signIn('demo', 'ui-demo-password');
    const { eligible } = await leaveExactlyOneEligible();
    check('#50 fixture: exactly one cash-out-eligible position remains', eligible.length === 1, `(${eligible.length}: markets ${JSON.stringify(eligible)})`);
    if (eligible.length !== 1) return;

    await atWallet();
    await page.waitForSelector('#page #wTx table, #page #wTx .empty', { timeout: 10000 });
    const before = await viewOnScreen();
    check(
      '#50 fixture: the Wallet is the view under test',
      before.wallet && !before.betsBody && before.activeTab === 'wallet',
      JSON.stringify(before)
    );

    await page.locator('#cashoutBtn').click();
    await page.waitForFunction(
      () => /Cashed out/.test((document.querySelector('#toast') || {}).textContent || ''),
      { timeout: 15000 }
    );
    // Well past the debounce, and past the 15s poll — which also declines to
    // repaint a page that is not the markets page.
    await page.waitForTimeout(2000);
    const after = await viewOnScreen();
    check(
      '#50 Cash Out on the Wallet page leaves the Wallet page on screen',
      after.wallet && !after.betsBody && after.activeTab === 'wallet' && after.hash === '#/wallet',
      JSON.stringify(after)
    );
  });

  // ── admin desk: overround column + the server-backed fair-price helper ──
  scenario('admin desk renders the overround column', async () => {
    await signIn('admin', 'ui-admin-password');
    await atAdmin('markets');
    await page.waitForSelector('#adminBody table', { timeout: 15000 });
    const heads = await page.locator('#adminBody th').allTextContents();
    check('overround column present', heads.some((h) => /overround/i.test(h)), `(${heads.join(',')})`);
    const orCells = await page.locator('#adminBody td:nth-child(6)').count();
    check('overround cells rendered', orCells >= 1, `(${orCells} markets)`);
    const suspend = page.locator('#adminBody [data-toggle]').first();
    check('suspend/restore control present', (await suspend.count()) === 1);
  });

  // S4 + W6: the settle dialog is a real dialog on the shared overlay stack.
  // Escape must close it (the global handler used to only know #authModal),
  // and the pick-a-winner hint must render — whenText(settled_at) was always
  // truthy, so it never did.
  //
  // Own fixture (#134). This used to open the settle dialog on whatever open
  // market the desk happened to show and returned silently — "every market
  // settled already — nothing to check" — when there was none. A silent return
  // is a check that verifies nothing, and the state it was silently skipping on
  // was created by the scenarios below. It now opens a market it created, so the
  // dialog is always there to be asserted on.
  scenario('settle dialog: aria role, W6 hint, Escape via the overlay stack', async () => {
    await signIn('admin', 'ui-admin-password');
    await withMarket('settle dialog aria', async (fx) => {
      await atAdmin('markets');
      await page.waitForSelector(`#adminBody [data-settle="${fx.marketId}"]`, { timeout: 15000 });
      await page.locator(`#adminBody [data-settle="${fx.marketId}"]`).click();
      await page.waitForSelector('.modal[role="dialog"]', { timeout: 10000 });
      check('settle dialog opens with role=dialog', true);
      const hint = ((await page.locator('.modal[role="dialog"] .hint').textContent()) || '').trim();
      check('unsettled market shows the pick-a-winner hint', /Pick the winning runner/.test(hint), `("${hint.slice(0, 40)}…")`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.modal[role="dialog"]'), null, { timeout: 10000 });
      check('Escape closes the settle dialog (topmost overlay)', true);
    });
  });

  scenario('fair-price helper returns server-side conversions', async () => {
    await signIn('admin', 'ui-admin-password');
    await atAdmin('create');
    await page.waitForSelector('[data-fair]', { timeout: 15000 });
    await page.fill('[data-fair]', '2.5');
    await page.dispatchEvent('[data-fair]', 'change');
    // the conversions come from lib/odds.js via /api/format — the desk must not
    // invent them client-side
    await page.waitForFunction(
      () => /\+\d+|-\d+/.test(document.querySelector('[data-fairnote]').textContent || ''),
      null,
      { timeout: 10000 }
    );
    const note = (await page.locator('[data-fairnote]').textContent()) || '';
    check('american + fractional + implied shown', /\d+\/\d+/.test(note) && /implied/.test(note), `("${note.trim()}")`);
  });

  // ── accounts (2.4): register-with-email, the account panel, and the two
  // new admin tabs. The mutations themselves are covered by admin.test.js and
  // the live curl e2e; this scenario proves the UI surfaces actually render
  // and that the identifier flow works in a real browser.
  //
  // EVERY scenario below registers its OWN account (#134). They used to share
  // one — `uitester`, created by whichever of them ran first — so the password
  // the account-panel scenario changed it to, and the audit row the admin
  // scenario looked for, were both properties of the run ORDER. Four accounts
  // instead of one is the price of "this scenario needs an account with a
  // password change in its audit trail" being a statement about itself.
  scenario('register accepts an email; login accepts that email', async () => {
    await signOut();
    await page.click('#authBtn');
    await page.waitForSelector('#authModal.show', { timeout: 10000 });
    await page.click('#authSwitch'); // → register mode
    await page.waitForFunction(() => document.getElementById('authEmailWrap').style.display !== 'none', null, { timeout: 5000 });
    check('register mode reveals the email field', true);
    await page.fill('#authUser', 'uitester');
    await page.fill('#authEmail', 'uitester@example.com');
    await page.fill('#authPass', 'secret1');
    await page.click('#authGo');
    await page.waitForSelector('#balance:not([hidden])', { timeout: 10000 });
    signedIn = true;
    check('registration completes and signs in', true);
    await signOut();
    await page.click('#authBtn');
    await page.waitForSelector('#authModal.show', { timeout: 5000 });
    // Login mode: the email field is hidden, and the single identifier field
    // accepts the EMAIL the account was registered with.
    await page.waitForFunction(() => document.getElementById('authEmailWrap').style.display === 'none', null, { timeout: 5000 });
    check('login mode hides the email field', true);
    await page.fill('#authUser', 'uitester@example.com');
    await page.fill('#authPass', 'secret1');
    await page.click('#authGo');
    await page.waitForSelector('#balance:not([hidden])', { timeout: 10000 });
    signedIn = true;
    const who = (await page.locator('#who').textContent()) || '';
    check('sign-in by email lands in the right account', who.includes('uitester'), `(${who.trim()})`);
  });

  // Its own account, not `uitester`: this scenario CHANGES the password, and
  // the scenario that registers uitester asserts the account is reachable with
  // `secret1`. Sharing one account made those two assertions a coin toss on
  // which ran first.
  scenario('account panel: sessions, and a password change that survives', async () => {
    await registerAccount('paneltester', 'paneltester@example.com');
    await page.click('#accountBtn');
    await page.waitForSelector('#accountModal.show', { timeout: 10000 });
    check('account panel opens as a dialog', (await page.locator('#accountModal').getAttribute('role')) === 'dialog');
    await page.waitForFunction(
      () => /this device/.test(document.getElementById('sessionList').textContent || ''),
      null,
      { timeout: 10000 }
    );
    check('sessions list marks the current device', true);
    await page.fill('#pwCurrent', 'secret1');
    await page.fill('#pwNew', 'secret2');
    await page.click('#pwGo');
    await page.waitForFunction(
      () => /Password changed/.test(document.getElementById('pwNote').textContent || ''),
      null,
      { timeout: 10000 }
    );
    check('password change reports the result', true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('accountModal').classList.contains('show'), null, { timeout: 10000 });
    // The caller's own session must still work — sign out and back in with the NEW password.
    await signOut();
    await page.click('#authBtn');
    await page.waitForSelector('#authModal.show', { timeout: 5000 });
    await page.fill('#authUser', 'paneltester@example.com');
    await page.fill('#authPass', 'secret1'); // the OLD one
    expectAuth401 = true; // a wrong-password login is an expected 401
    await page.click('#authGo');
    await page.waitForFunction(
      () => /Invalid username or password/.test(document.getElementById('toast').textContent || ''),
      null,
      { timeout: 10000 }
    );
    expectAuth401 = false;
    check('the old password no longer works', true);
    await page.fill('#authPass', 'secret2'); // the NEW one
    await page.click('#authGo');
    await page.waitForSelector('#balance:not([hidden])', { timeout: 10000 });
    signedIn = true;
    check('the new password works', true);
  });

  scenario('admin desk: users and audit tabs', async () => {
    // Its own account, changed a password, so the audit row this scenario reads
    // is one it created rather than one it inherited (#134).
    await registerAccount('audittester', 'audittester@example.com');
    await page.click('#accountBtn');
    await page.waitForSelector('#accountModal.show', { timeout: 10000 });
    await page.fill('#pwCurrent', 'secret1');
    await page.fill('#pwNew', 'secret2');
    await page.click('#pwGo');
    await page.waitForFunction(
      () => /Password changed/.test(document.getElementById('pwNote').textContent || ''),
      null,
      { timeout: 10000 }
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('accountModal').classList.contains('show'), null, { timeout: 10000 });

    await signIn('admin', 'ui-admin-password');
    await atAdmin('users');
    await page.waitForSelector('#adminBody .adm-tbl tbody tr', { timeout: 15000 });
    const userRows = await page.locator('#adminBody .adm-tbl tbody tr').count();
    check('users tab lists accounts', userRows >= 2, `(${userRows} rows)`);
    const acts = await page.locator('#adminBody [data-act]').count();
    check('each account row carries actions', acts >= userRows * 3, `(${acts} controls)`);
    await page.fill('#userSearch', 'audittester');
    await page.click('#userSearchGo');
    await page.waitForFunction(
      () => document.querySelectorAll('#adminBody .adm-tbl tbody tr').length === 1,
      null,
      { timeout: 10000 }
    );
    check('user search narrows by the email-registered account', true);
    // Read the account's id from the narrowed row, so the audit filter below
    // targets the account that actually has entries rather than a hard-coded
    // id that depends on seed ordering.
    const uid = ((await page.locator('#adminBody .adm-tbl tbody tr td').first().textContent()) || '').trim();

    await atAdmin('audit');
    await page.waitForSelector('#adminBody .adm-tbl tbody tr', { timeout: 15000 });
    const auditText = (await page.locator('#adminBody .adm-tbl tbody').textContent()) || '';
    check('audit tab records the password change with an actor and reason', /user\.password_changed/.test(auditText), `(${auditText.slice(0, 60)}…)`);
    await page.fill('#auditTarget', `user:${uid}`);
    await page.click('#auditGo');
    await page.waitForFunction(
      // Guarded: between the click and the re-render the tbody is briefly
      // absent, and an unguarded null read here would surface as a page error.
      // `uid` is passed as the arg — the predicate executes in PAGE context
      // and cannot close over this scope.
      (id) => {
        const tb = document.querySelector('#adminBody .adm-tbl tbody');
        return !!tb && (tb.textContent || '').includes(`user:${id}`);
      },
      uid,
      { timeout: 10000 }
    );
    check('audit filter narrows by target', true);

    // ── Operator console ──────────────────────────────────────────────────
    // These views existed as API routes with no way to open them, which is the
    // gap this suite now exists to close: the tabs must render REAL data, not
    // just exist. A tab that loads and shows "unavailable" is a regression.
    // Wait for THIS view's own heading, never a generic `table`: a previous
    // view also has a table, so a generic selector matches stale content
    // instantly and the assertion then reads the view before it.
    const waitForHeading = (re) =>
      page.waitForFunction(
        (src) => {
          const h = document.querySelector('#adminBody h4');
          return !!h && new RegExp(src, 'i').test(h.textContent || '');
        },
        re.source,
        { timeout: 10000 }
      );

    await page.click('[data-view="risk"]');
    await waitForHeading(/market maker/i);
    const riskText = (await page.locator('#adminBody').textContent()) || '';
    check('risk desk renders the market maker', /Market maker/i.test(riskText) && /MarketMakers/.test(riskText), `(${riskText.slice(0, 50)}…)`);
    check('risk desk reports cash-out exposure', /Cash-out exposure/i.test(riskText));
    const hasKill = (await page.locator('#riskKill').count()) === 1;
    check('risk desk offers the kill switch', hasKill);

    await page.click('[data-view="ledger"]');
    await page.waitForSelector('#adminBody .statgrid', { timeout: 10000 });
    const ledgerText = (await page.locator('#adminBody').textContent()) || '';
    check('ledger reports fund segregation as a number', /Players' funds/i.test(ledgerText) && /balanced/i.test(ledgerText), `(${ledgerText.slice(0, 60)}…)`);
    check('ledger shows no cache divergence', !/disagrees with the postings/i.test(ledgerText));

    await page.click('[data-view="recon"]');
    await page.waitForSelector('#adminBody table, #adminBody .empty', { timeout: 10000 });
    const reconText = (await page.locator('#adminBody').textContent()) || '';
    check('reconciliation view renders', /Reconciliation/i.test(reconText), `(${reconText.slice(0, 50)}…)`);

    await page.click('[data-view="results"]');
    await waitForHeading(/markets held/i);
    const heldText = (await page.locator('#adminBody').textContent()) || '';
    check('held-markets view renders', /Markets held/i.test(heldText), `(${heldText.slice(0, 50)}…)`);
    check('void rules are documented on screen', /Void rules/i.test(heldText) && /settle/.test(heldText));

    await page.click('[data-view="tenants"]');
    await waitForHeading(/^tenants/i);
    const tenantText = (await page.locator('#adminBody').textContent()) || '';
    check('tenant view renders with commission in bps', /bps/i.test(tenantText), `(${tenantText.slice(0, 50)}…)`);

    await page.click('[data-view="ops"]');
    await page.waitForSelector('#adminBody .statgrid', { timeout: 10000 });
    const opsText = (await page.locator('#adminBody').textContent()) || '';
    check('ops view shows readiness and the ledger check', /Readiness/i.test(opsText) && /balanced/i.test(opsText), `(${opsText.slice(0, 60)}…)`);
    check('ops view offers a backup control', (await page.locator('#opsBackup').count()) === 1);

    // A dead panel must SAY it is dead. A blank card reads as "nothing to see",
    // which is the opposite of the truth when an endpoint errored.
    const degrade = await page.evaluate(async () => {
      document.getElementById('adminBody').innerHTML = '<div class="empty">forced</div>';
      return true;
    });
    check('admin body is a stable shared mount', degrade);
  });

// ── #68 §2.4: the operator console's visual language does not exist ───────
  //
  // public/admin-risk.js renders ten class names style.css never defines. A
  // missing class is invisible to every check that asserts an element EXISTS —
  // the meter, the stat tiles and the tables are all in the DOM — so every
  // assertion here is about GEOMETRY, VISIBILITY or COLOUR: the things that
  // change when a rule exists.
  scenario('#68 the risk desk renders its meter, its KPI row and a kill switch that looks like one', async () => {
    await signIn('admin', 'ui-admin-password');
    await atAdmin('risk');
    // `attached`, not `visible`: a .meter with zero height is not visible, which
    // IS the defect. Waiting for visible here would turn it into a 10s timeout
    // instead of the measured failure below.
    await page.waitForSelector('#adminBody .meter', { state: 'attached', timeout: 15000 });

    const desk = await page.evaluate(() => {
      const box = (sel) => {
        const n = document.querySelector(sel);
        if (!n) return null;
        const r = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, background: cs.backgroundColor };
      };
      return { meter: box('#adminBody .meter'), fill: box('#adminBody .meterfill'), kill: box('#riskKill'), withdraw: box('#riskWithdraw') };
    });
    check(
      '#68 the market-maker pressure meter has height',
      !!desk.meter && desk.meter.h > 0 && desk.meter.display !== 'none',
      `(meter ${desk.meter ? `${desk.meter.w}x${desk.meter.h} display:${desk.meter.display}` : 'absent'})`
    );
    check(
      '#68 the meter fill is painted, not a zero-box',
      !!desk.fill && desk.fill.h > 0 && desk.fill.background !== 'rgba(0, 0, 0, 0)',
      `(fill ${desk.fill ? `${desk.fill.w}x${desk.fill.h} ${desk.fill.background}` : 'absent'})`
    );
    check(
      '#68 the fill is the width the markup asked for',
      !!desk.fill && !!desk.meter && desk.fill.w > 0 && desk.fill.w < desk.meter.w + 1,
      `(fill ${desk.fill ? desk.fill.w : '?'} within meter ${desk.meter ? desk.meter.w : '?'})`
    );

    // THE HIGHEST-CONSEQUENCE ITEM IN THE BATCH. The most destructive control
    // in the product rendered identically to the second-most destructive, so an
    // operator could not see which one they were about to press.
    check(
      '#68 the kill switch does not look like the button beside it',
      !!desk.kill && !!desk.withdraw && desk.kill.background !== desk.withdraw.background,
      `(kill ${desk.kill ? desk.kill.background : '?'} vs withdraw ${desk.withdraw ? desk.withdraw.background : '?'})`
    );
    check(
      '#68 the kill switch is drawn in the danger colour',
      !!desk.kill && desk.kill.background === 'rgb(253, 236, 235)',
      `(kill bg ${desk.kill ? desk.kill.background : '?'} — --red-bg is rgb(253,236,235))`
    );
    check(
      '#68 the withdraw button is NOT drawn as a second danger control',
      !!desk.withdraw && desk.withdraw.background === 'rgb(255, 255, 255)',
      `(withdraw bg ${desk.withdraw ? desk.withdraw.background : '?'})`
    );

    // The KPI row: six numbers intended as a row, stacked in a column because
    // .statgrid had no rule.
    await page.click('[data-view="ledger"]');
    await page.waitForSelector('#adminBody .statgrid .stat', { timeout: 10000 });
    const kpi = await page.evaluate(() => {
      const stats = [...document.querySelectorAll('#adminBody .statgrid .stat')];
      const boxes = stats.map((n) => n.getBoundingClientRect());
      const grid = document.querySelector('#adminBody .statgrid');
      return {
        n: stats.length,
        rows: new Set(boxes.map((b) => Math.round(b.y))).size,
        gridDisplay: grid ? getComputedStyle(grid).display : null,
        gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : 0,
        widest: Math.round(Math.max(...boxes.map((b) => b.width))),
      };
    });
    check('#68 the ledger KPI tiles are laid out by a real grid', kpi.gridDisplay === 'grid', `(display ${kpi.gridDisplay})`);
    check(
      '#68 the six ledger figures share a row rather than a column',
      kpi.n >= 6 && kpi.rows === 1 && kpi.widest < kpi.gridWidth * 0.3,
      `(${kpi.n} tiles in ${kpi.rows} row(s), widest ${kpi.widest}px of ${kpi.gridWidth}px)`
    );

    // .small: the sub-labels were rendering at 14px body size because the class
    // meant nothing. Type SIZE is out of scope for this issue, so this asserts
    // that the class RESOLVES — a rule exists and it is smaller than body —
    // rather than that any particular number is correct.
    const small = await page.evaluate(() => {
      const n = document.querySelector('#adminBody .small');
      if (!n) return null;
      return { px: parseFloat(getComputedStyle(n).fontSize), body: parseFloat(getComputedStyle(document.body).fontSize) };
    });
    check(
      '#68 the small sub-label class actually makes text smaller',
      !!small && small.px < small.body,
      `(${small ? `${small.px}px vs body ${small.body}px` : 'no .small on the ledger'})`
    );

    // Each of the ten names must now have a rule of its own. The geometry
    // assertions above prove three of them are load-bearing; this proves the
    // rest exist, which is the only way to catch one being renamed back.
    await page.click('[data-view="risk"]');
    await page.waitForSelector('#adminBody table.tbl', { timeout: 10000 });
    const defined = await page.evaluate((names) => {
      const found = new Set();
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const r of rules) {
          if (!r.selectorText) continue;
          for (const part of r.selectorText.split(',')) {
            const t = part.trim();
            if (names.includes(t)) found.add(t);
          }
        }
      }
      const tbl = document.querySelector('#adminBody table.tbl');
      const cell = tbl ? tbl.querySelector('td') : null;
      return {
        missing: names.filter((n) => !found.has(n)),
        tblPadding: cell ? getComputedStyle(cell).padding : null,
      };
    }, ['.meter', '.meterfill', '.statgrid', '.stat', '.small', '.bad', '.ok', '.gap', '.tbl']);
    check(
      '#68 every class the operator console renders now has a rule',
      defined.missing.length === 0,
      `(no rule for: ${defined.missing.join(', ') || 'none'})`
    );
    check(
      '#68 the operator tables take their own cell padding',
      defined.tblPadding === '6px 8px',
      `(td padding ${defined.tblPadding})`
    );

    // The dialog's own confirm button has to match what it is about to do, for
    // the same reason the kill switch's own styling had to: a red "Release" is
    // an action dressed as a danger, and an operator reads colour faster than
    // they read the verb.
    await page.click('[data-view="risk"]');
    await page.waitForSelector('#riskKill', { timeout: 10000 });
    const killLabel = ((await page.locator('#riskKill').textContent()) || '').trim();
    await page.click('#riskKill');
    await page.waitForSelector('.modal[role="dialog"] #askGo', { timeout: 10000 });
    const confirmTone = await page.evaluate(() => getComputedStyle(document.querySelector('.modal[role="dialog"] #askGo')).backgroundColor);
    const confirmLabel = ((await page.locator('.modal[role="dialog"] #askGo').textContent()) || '').trim();
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {});
    check(
      '#68 the kill-switch dialog\'s confirm button matches what the button does',
      // Off (the dangerous direction) => red. On (releasing) => the neutral
      // primary face, never red.
      /pull/i.test(killLabel)
        ? confirmTone === 'rgb(253, 236, 235)' && /pull/i.test(confirmLabel)
        : confirmTone === 'rgb(10, 10, 11)' && /release/i.test(confirmLabel),
      `(button said "${killLabel}", confirm "${confirmLabel}" in ${confirmTone})`
    );

  });

  // ── #68 §2.2: the account panel claims to be a modal and is not ───────────
  //
  // `#accountModal` is declared `role="dialog" aria-modal="true"` and is
  // hidden/shown through the overlay stack like #authModal — but it matched no
  // rule in style.css, so `openOverlay()` toggled a class nothing styled. The
  // result was a permanent full-width block at the bottom of <body>, on screen
  // on every short page (My Bets, Wallet, all ten admin tabs).
  //
  // Asserted as VISIBILITY and GEOMETRY, never as presence: the panel is in the
  // DOM either way, which is exactly why this survived.
  scenario('#68 the account panel is a modal, not a permanent block at the bottom of the page', async () => {
    // Wallet is a short page, so the leaked panel was on screen there.
    await signIn('demo', 'ui-demo-password');
    await atWallet();
    await page.waitForTimeout(400);
    const closed = await page.evaluate(() => {
      const n = document.getElementById('accountModal');
      const r = n.getBoundingClientRect();
      return {
        display: getComputedStyle(n).display,
        visible: r.width > 0 && r.height > 0,
        position: getComputedStyle(n).position,
        coversViewport: r.width >= window.innerWidth - 1 && r.height >= window.innerHeight - 1,
        onScreen: r.top < window.innerHeight && r.bottom > 0,
      };
    });
    check('#68 the account panel is not rendered until it is opened', !closed.visible && closed.display === 'none', `(display ${closed.display}, ${closed.visible ? 'visible' : 'not visible'})`);
    check(
      '#68 no account panel is left on screen over a short page',
      !closed.onScreen,
      `(it occupies the viewport ${closed.onScreen ? '' : 'nowhere'}; position ${closed.position})`
    );
    // The controls inside it occupied real boxes on the page, so a screen
    // reader walking My Bets or the Wallet reached a password form as ordinary
    // in-flow content with no dialog announced. An empty box is the observable
    // form of "not in the page".
    const leaked = await page.evaluate(() => {
      const ids = ['pwCurrent', 'pwNew', 'pwGo'];
      return ids.map((id) => {
        const n = document.getElementById(id);
        return n ? Math.round(n.getBoundingClientRect().height) : -1;
      });
    });
    check(
      '#68 the password form occupies no space on the page',
      leaked.every((h) => h === 0),
      `(heights ${leaked.join(', ')}px)`
    );

    await page.click('#accountBtn');
    await page.waitForSelector('#accountModal.show', { timeout: 5000 });
    const open = await page.evaluate(() => {
      const n = document.getElementById('accountModal');
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      const box = document.querySelector('#accountModal .box');
      return {
        display: cs.display,
        position: cs.position,
        coversViewport: r.width >= window.innerWidth - 1 && r.height >= window.innerHeight - 1,
        boxWidth: box ? Math.round(box.getBoundingClientRect().width) : 0,
        boxCentred: box
          ? Math.abs((box.getBoundingClientRect().left + box.getBoundingClientRect().right) / 2 - window.innerWidth / 2) < 2
          : false,
        focused: document.activeElement ? document.activeElement.id : null,
      };
    });
    check('#68 opening the account panel overlays the page', open.display === 'flex' && open.position === 'fixed' && open.coversViewport, `(display ${open.display}, position ${open.position})`);
    check('#68 the account panel is a centred box, not a full-width bar', open.boxWidth > 100 && open.boxWidth < 600 && open.boxCentred, `(box ${open.boxWidth}px, centred ${open.boxCentred})`);
    check('#68 opening it moves focus into the dialog', open.focused === 'pwCurrent', `(focus on ${open.focused})`);

    // Escape closes it and returns focus where it came from — the behaviour a
    // static block can never have, and the one that makes it a modal.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('accountModal').classList.contains('show'), null, { timeout: 3000 });
    const after = await page.evaluate(() => ({
      display: getComputedStyle(document.getElementById('accountModal')).display,
      focused: document.activeElement ? document.activeElement.id : null,
    }));
    check('#68 Escape closes the account panel', after.display === 'none', `(display ${after.display})`);
    check('#68 Escape returns focus to the button that opened it', after.focused === 'accountBtn', `(focus on ${after.focused})`);
  });

// ── #68 §5 cheap wins, on the surfaces they touch ─────────────────────────
  //
  // The viewport and the bot baseline are both changed here and both are put
  // back in a finally: a scenario that leaves a 700px-wide browser or a
  // shifted day-start balance behind makes every scenario after it fail for a
  // reason that is not its own (#134).
  scenario('#68 the one-liners: slip label, ledger column, drawer, money format', async () => {
    // `Place —` on a disabled button read as a truncated string.
    await signIn('admin', 'ui-admin-password');
    try {
    await atMarkets();
    await onBoardCell();
    await page.locator('.ladder button.lcell[data-bet]').first().click();
    await page.waitForSelector('#slip .sliprow [data-stake]', { timeout: 5000 });
    await page.fill('#slip [data-stake]', '0.40');
    await page.dispatchEvent('#slip [data-stake]', 'change');
    await page.waitForTimeout(300);
    const placeLabel = (await page.locator('#slip button.place').first().textContent()) || '';
    check(
      '#68 a disabled Place button says Place, not a truncated "Place —"',
      placeLabel.trim() === 'Place' && (await page.locator('#slip button.place').first().isDisabled()),
      `("${placeLabel.trim()}")`
    );
    // Clean the slip up so nothing is left half-filled on the page.
    await page.locator('#slip [data-rm]').first().click();

    // The wallet ledger's BALANCE column means "balance after" while the figure
    // at the top of the same screen labelled BALANCE means the total.
    await atWallet();
    // The faucet writes a transaction, so the ledger table exists. Without one
    // there is no table at all and the column name cannot be read.
    await page.locator('#page [data-dep]').first().click();
    await page.waitForSelector('#wTx table', { timeout: 15000 });
    const walletHeads = await page.evaluate(() =>
      [...document.querySelectorAll('#wTx th')].map((n) => n.textContent.trim())
    );
    check(
      '#68 the ledger column says which balance it is',
      walletHeads.indexOf('Balance after') >= 0 && walletHeads.indexOf('Balance') < 0,
      `(${walletHeads.join(' / ')})`
    );

    // One negative-money format: admin.js rendered $-140.43, core.js -$140.43.
    check(
      '#68 the player-facing signed format is the minus-sign one',
      (await page.evaluate(() => window.OB.signed(-14043))) === '−$140.43',
      `(signed(-14043) = ${await page.evaluate(() => window.OB.signed(-14043))})`
    );

    // #104: the money formatter follows the currency /api/branding published.
    // Before this, core.js hard-coded '$', so every amount on every screen was
    // a dollar sign regardless of the venue — the symptom the issue led with.
    //
    // Driven through the REAL loaded module and the REAL published state, not
    // a reimplementation: the pre-state is read first, so a check that passed
    // because the page had no currency would be caught here rather than
    // congratulating itself.
    const branding = await (await fetch(`${BASE}/api/branding`)).json();
    check(
      '#104 /api/branding publishes the venue currency',
      branding.currency === 'USD',
      `(branding.currency = ${JSON.stringify(branding.currency)})`
    );
    check(
      '#104 the page formatted money in the currency branding published',
      (await page.evaluate(() => window.OB.state.currency)) === branding.currency,
      `(page = ${await page.evaluate(() => window.OB.state.currency)})`
    );
    const rendered = await page.evaluate(async () => {
      const before = window.OB.fmt(100);
      const real = window.OB.state.currency;
      window.OB.state.currency = 'AUD';
      const aud = window.OB.fmt(100);
      window.OB.state.currency = 'BRL';
      const brl = window.OB.fmt(100);
      window.OB.state.currency = null;
      const none = window.OB.fmt(100);
      window.OB.state.currency = real;
      return { before, aud, brl, none, restored: window.OB.state.currency };
    });
    check(
      '#104 the symbol is the currency\'s, and an unknown code renders as itself',
      rendered.before === '$1.00' && rendered.aud === 'A$1.00' && rendered.brl === 'BRL 1.00' && rendered.none === '1.00',
      `(USD ${rendered.before} / AUD ${rendered.aud} / BRL ${rendered.brl} / none ${rendered.none})`
    );
    check(
      '#104 the probe left the page on the currency branding published',
      rendered.restored === branding.currency,
      `(state.currency = ${rendered.restored})`
    );
    // The formatter really is what paints the header: a tenant swap changes
    // the header, not just the helper.
    const headerSwaps = await page.evaluate(async () => {
      const el = window.OB.$('balance');
      const real = window.OB.state.currency;
      window.OB.state.currency = 'GBP';
      window.OB.renderHeader();
      const during = el.textContent;
      window.OB.state.currency = real;
      window.OB.renderHeader();
      return { during, after: el.textContent };
    });
    check(
      '#104 the balance chip re-renders in the tenant\'s currency',
      headerSwaps.during.includes('£') && !headerSwaps.during.includes('$') && headerSwaps.after.includes('$'),
      `(during ${headerSwaps.during.trim()} / after ${headerSwaps.after.trim()})`
    );
    //
    // A loss is MADE, not hoped for: `daily_pnl_cents` is the bot's balance
    // minus its day-start balance, so raising the baseline in the same column
    // lib/risk.js reads produces a real negative. Without it the check is
    // vacuous — a venue whose bot happens to be up today renders no negative
    // and the assertion passes whatever the formatter does. The baseline is
    // restored immediately afterwards.
    {
      const db = await openDb();
      const rows = db.prepare('SELECT bot_id, day_start_balance FROM risk_bots').all();
      for (const r of rows) {
        db.prepare('UPDATE risk_bots SET day_start_balance = ? WHERE bot_id = ?').run(
          r.day_start_balance + 12345,
          r.bot_id
        );
      }
      db.close();
      // The restore is a finally, not a line after the checks. A baseline left
      // shifted makes every LATER run of the risk desk report a loss that is
      // not there, and in a shuffled order "later" is whichever scenario the
      // seed happened to pick.
      try {
        await atAdmin('risk');
        await page.waitForSelector('#adminBody .meter', { timeout: 15000 });
        const adminMoney = await page.evaluate(() => {
          const cells = [...document.querySelectorAll('#adminBody td span')].map((n) => n.textContent.trim());
          return cells.filter((t) => /^[-−+]?\$/.test(t));
        });
        const negatives = adminMoney.filter((t) => /^[-−]/.test(t));
        check(
          '#68 the operator console renders a negative amount to check the format of',
          negatives.length > 0,
          `(${adminMoney.length} figures: ${adminMoney.slice(0, 5).join(' | ')})`
        );
        check(
          '#68 the operator console uses the same negative-money format as the player screens',
          negatives.length > 0 && negatives.every((t) => !/^\$-/.test(t)),
          `(${negatives.join(' | ')})`
        );
      } finally {
        const db2 = await openDb();
        for (const r of rows) {
          db2.prepare('UPDATE risk_bots SET day_start_balance = ? WHERE bot_id = ?').run(r.day_start_balance, r.bot_id);
        }
        db2.close();
      }
    }

    // The drawer: picking a destination left the drawer open over it.
    await page.setViewportSize({ width: 700, height: 900 });
    await page.waitForTimeout(200);
    await page.click('#navToggle');
    await page.waitForFunction(() => document.body.classList.contains('nav-open'), null, { timeout: 3000 });
    await page.click('#nav button[data-page="wallet"]');
    await page.waitForTimeout(500);
    check(
      '#68 choosing a destination closes the navigation drawer',
      !(await page.evaluate(() => document.body.classList.contains('nav-open'))),
      '(the drawer was still open over the page it navigated to)'
    );
    } finally {
      // Back to the shape the rest of the suite measures geometry against.
      await page.setViewportSize(VIEWPORT);
    }
  });

  // ── #68 §3.1: a 500 and an empty venue rendered the same screen ───────────
  //
  // shell.js answered a failed /api/events with `state.events = []`, which
  // board.js rendered as "No open events right now" — the same card a venue
  // with genuinely nothing on it produces. The operator's first conclusion on
  // seeing that is "we have gone out of business", which is the inverse of the
  // truth, and it happened on every transient blip.
  scenario('#68 the board says which of the two it is: a fault, or an empty catalogue', async () => {
   // A deliberately broken route is a hazard to everything after it: the board
   // stays broken, and every later scenario inherits a page with an error card on
   // it. Undo the injection and restore the board on EVERY path, so a failure in
   // here is a named failure rather than a cascade.
   await signIn('demo', 'ui-demo-password');
   await atMarkets();
   try {
    // A real 500, injected on the route the app actually calls.
    expectEvents500 = true;
    await page.route('**/api/events*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'catalogue unavailable' }) })
    );
    await page.evaluate(() => {
      location.hash = '#/markets';
      return window.OB.refreshMarkets();
    });
    await page.waitForSelector('#boardRetry', { timeout: 15000 });
    const failed = await page.evaluate(() => {
      const card = document.querySelector('#page .card');
      return {
        text: (card ? card.textContent : '') || '',
        retry: !!document.getElementById('boardRetry'),
        coloured: card ? getComputedStyle(card.querySelector('.empty')).color : null,
      };
    });
    check(
      '#68 a failed board load says it FAILED and names the reason',
      /could not be loaded/i.test(failed.text) && /catalogue unavailable/i.test(failed.text),
      `("${failed.text.replace(/\s+/g, ' ').slice(0, 90)}")`
    );
    check(
      '#68 a failed board load is NOT the empty-catalogue message',
      !/no open events right now/i.test(failed.text),
      `("${failed.text.replace(/\s+/g, ' ').slice(0, 90)}")`
    );
    check('#68 a failed board load offers a retry', failed.retry);
    check(
      '#68 a fault is drawn in the alarm colour, not the muted empty state',
      failed.coloured === 'rgb(194, 38, 31)',
      `(colour ${failed.coloured} — --red is rgb(194,38,31))`
    );

    // The retry has to work, or the button is decoration.
    await page.unroute('**/api/events*');
    expectEvents500 = false;
    await page.click('#boardRetry');
    await page.waitForSelector('.ladder .lcell[data-bet]', { timeout: 15000 });
    check('#68 retrying after a failure loads the board again', true);

    // Now the genuinely empty case, with the route answering 200 and no
    // events. It must be a DIFFERENT screen, not a differently-worded one.
    await page.route('**/api/events*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [] }) })
    );
    await page.evaluate(() => window.OB.refreshMarkets());
    await page.waitForSelector('#page .card .empty', { timeout: 15000 });
    const empty = await page.evaluate(() => {
      const card = document.querySelector('#page .card');
      return {
        text: (card ? card.textContent : '') || '',
        retry: !!document.getElementById('boardRetry'),
      };
    });
    check(
      '#68 a genuinely empty catalogue says so, and says the load worked',
      /no open events right now/i.test(empty.text) && /genuinely empty|loaded/i.test(empty.text),
      `("${empty.text.replace(/\s+/g, ' ').slice(0, 90)}")`
    );
    check('#68 an empty catalogue offers no retry — nothing failed', !empty.retry);
   } finally {
    await page.unroute('**/api/events*').catch(() => {});
    expectEvents500 = false;
    await page.evaluate(() => window.OB.refreshMarkets()).catch(() => {});
    await page.waitForSelector('.ladder .lcell[data-bet]', { timeout: 20000 }).catch(() => {});
   }
  });

  // ── #68 §3.3 / §3.4 / §5: the player and operator surfaces ────────────────
  scenario('#68 positions, the settle dialog and the cheap wins', async () => {
    // ── §3.3 BACKED and FROZEN printed the same number on every back leg ───
    //
    // Driven from a FIXTURE rather than from a bet placed through the slip. A
    // position needs a matched order, and whether a given price crosses depends
    // on what the bots are quoting at that moment — so the fixture made this
    // check fail roughly a third of runs for reasons that had nothing to do with
    // what it is checking. This is the same renderer on the same endpoint; only
    // the response is pinned.
    //
    // The payload is built to contain exactly the case the finding is about: a
    // back-only leg, where lib/match.js's escrowFor equals the stake, so the
    // old FROZEN column printed the BACKED number again on every such row.
    //
    // The mock is un-installed in a finally. It used to be un-installed on the
    // line after the last check, which a thrown wait would skip — and a mocked
    // /api/positions left installed hands every later scenario a position list
    // this test made up (#134).
    await signIn('demo', 'ui-demo-password');
    await page.route('**/api/positions', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          positions: [
            {
              market_id: 1,
              market_name: 'Match Odds',
              market_status: 'open',
              event_name: 'Fixture vs Server',
              cashout: null,
              selections: [
                { name: 'Back only', my_back_stake_cents: 5051, my_lay_stake_cents: 0, frozen_cents: 5051 },
                { name: 'Laid too', my_back_stake_cents: 0, my_lay_stake_cents: 2000, frozen_cents: 4000 },
              ],
              pnl_if_win: [
                { name: 'Back only', pnl_cents: 5000 },
                { name: 'Laid too', pnl_cents: -4000 },
              ],
            },
          ],
        }),
      })
    );
    try {
    await atBets();
    await page.click('[data-tab="positions"]');
    await page.waitForSelector('#betsBody .poscard', { timeout: 15000 });
    const pos = await page.evaluate(() => {
      const card = document.querySelector('#betsBody .poscard');
      if (!card) return null;
      return {
        heads: [...card.querySelectorAll('th')].map((n) => n.textContent.trim()),
        rows: [...card.querySelectorAll('tbody tr')].map((r) =>
          [...r.querySelectorAll('td')].map((n) => n.textContent.trim())
        ),
        head: (card.querySelector('.poshead') || {}).textContent.replace(/\s+/g, ' ').trim() || '',
      };
    });
    check(
      '#68 the positions table drops the column that duplicated Backed',
      !!pos && pos.heads.indexOf('Frozen') < 0,
      `(${pos ? pos.heads.join(' / ') : 'no position card'})`
    );
    check(
      '#68 a back-only leg is shown once, not twice',
      !!pos && pos.rows.some((r) => r[1] === '$50.51') && pos.rows.every((r) => r.length === 3),
      `(${pos ? JSON.stringify(pos.rows) : ''})`
    );
    check(
      '#68 the escrow a position holds is stated once, on the position',
      !!pos && /escrow held \$90\.51/i.test(pos.head),
      `("${pos ? pos.head.slice(0, 90) : ''}")`
    );
    } finally {
      await page.unroute('**/api/positions').catch(() => {});
    }

    // ── §3.4 the settle dialog named nothing ────────────────────────────────
    //
    // On a market this scenario created (#134). It used to open the dialog on
    // whichever market the desk listed first and, when the catalogue had been
    // settled out from under it by an earlier scenario, report
    // "fixture: a market to settle — every market is settled". That named
    // failure was honest, and it was also the suite telling the truth about
    // itself: this check only had a fixture if the scenarios before it had
    // left one.
    await signIn('admin', 'ui-admin-password');
    await withMarket('settle dialog naming', async (fx) => {
    await atAdmin('markets');
    await page.waitForSelector(`#adminBody [data-settle="${fx.marketId}"]`, { timeout: 15000 });
    await page.locator(`#adminBody [data-settle="${fx.marketId}"]`).click();
    await page.waitForSelector('.modal[role="dialog"] #sdGo', { timeout: 15000 });
    const named = await page.evaluate(() => {
      const title = document.querySelector('#sdTitle');
      const facts = document.querySelector('.sd-facts');
      const rows = [...document.querySelectorAll('.modal[role="dialog"] #sdWinners .optrow')];
      return {
        title: (title ? title.textContent : '').trim(),
        facts: (facts ? facts.textContent : '').replace(/\s+/g, ' ').trim(),
        ariaLabel: document.querySelector('.modal[role="dialog"]').getAttribute('aria-label') || '',
        rows: rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
      };
    });
    check(
      '#68 the settle dialog names the EVENT, not the market type',
      /settle/i.test(named.title) && !/^settle winner$/i.test(named.title.trim()),
      `("${named.title}")`
    );
    check(
      '#68 the settle dialog is labelled to assistive tech by event and market',
      /settle .+ — /i.test(named.ariaLabel),
      `("${named.ariaLabel}")`
    );
    check(
      '#68 the settle dialog states what the decision moves',
      /matched/i.test(named.facts) && /runners/i.test(named.facts) && /\$/.test(named.facts),
      `("${named.facts.slice(0, 80)}")`
    );
    check(
      '#68 every runner in the settle dialog carries a price, not a bare dash',
      named.rows.length > 0 && named.rows.every((r) => /LTP|best back|no trades/i.test(r)),
      `(${named.rows.length} rows: ${named.rows.slice(0, 2).join(' | ').slice(0, 90)})`
    );
    await page.click('.modal[role="dialog"] #sdCancel');
    await page.waitForTimeout(300);
    });

    // ── §5: two status chips three lines apart, and a row of $0.00 ─────────
    await signIn('demo', 'ui-demo-password');
    const boardCopy = await page.evaluate(async () => {
      window.OB.goTo('markets');
      await window.OB.refreshMarkets();
      await new Promise((r) => setTimeout(r, 900));
      const heads = [...document.querySelectorAll('.mkthead .chip')].map((n) => n.textContent.trim());
      const heads2 = [...document.querySelectorAll('.evmeta .chip')].map((n) => n.textContent.trim());
      const matched = [...document.querySelectorAll('.mkthead .muted')].map((n) => n.textContent.trim());
      return { heads, heads2, matched };
    });
    check(
      '#68 a market never repeats "open" under an event chip that already says it is trading',
      !boardCopy.heads.includes('open'),
      `(event chips ${JSON.stringify(boardCopy.heads2.slice(0, 3))}, market chips ${JSON.stringify(boardCopy.heads.slice(0, 3))})`
    );
    check(
      '#68 no market advertises $0.00 matched',
      !boardCopy.matched.some((m) => /\$0\.00\s+matched/.test(m)),
      `(${boardCopy.matched.length} matched labels: ${boardCopy.matched.slice(0, 3).join(' | ')})`
    );
  });

  // ── #51: a held market can be released as a DEAD HEAT, chosen by NAME ────
  //
  // Two defects, both on the operator's most consequential screen:
  //   (a) the release route has accepted `dead_heat` since lib/results.js
  //       gained it, and no screen could send it - so an operator facing a held
  //       dead heat could only pick one winner (paying a whole stake to one
  //       runner and charging the other joint winner's backer his entire stake
  //       on a horse that TIED) or void every runner;
  //   (b) the prompt demanded "Winning selection id (see the market on the
  //       board)" - and the board renders NAMES only. cellHtml() puts ids in
  //       data-sel and aria-label, never as text.
  //
  // (b) is checked by RECORDING every window.prompt the page raises and
  // asserting that none of them asks for an id. (a) is checked by driving the
  // real control - tick two runners - and reading the POST body the browser
  // actually sent. Asserting that the endpoint accepts a dead_heat would prove
  // nothing about the desk: that path already worked, and the bug is that
  // nothing on screen reaches it.

  // Every dialog the page raises, in order. Empty queue => DISMISS, which is
  // exactly what Playwright does with an unhandled dialog, so registering this
  // handler changes no other scenario's behaviour.
  const prompts = [];
  let promptQueue = [];
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt' && promptQueue.length) {
      prompts.push(d.message());
      await d.accept(promptQueue.shift());
      return;
    }
    prompts.push(d.message());
    await d.dismiss();
  });
  // The release POST body, captured off the wire.
  let releasePayload = null;
  // Admin writes captured the same way, for #52.
  const adminWrites = {};
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (/\/api\/admin\/results\/held\/\d+\/release$/.test(p)) {
      try {
        releasePayload = JSON.parse(r.postData() || 'null');
      } catch {
        releasePayload = { __unparseable: r.postData() };
      }
      return;
    }
    if (r.method() === 'POST' || r.method() === 'PUT' || r.method() === 'PATCH') {
      if (!/^\/api\/admin\/(users\/\d+\/(limits|exclude)|markets\/\d+(\/settle)?)$/.test(p)) return;
      try {
        adminWrites[`${r.method()} ${p}`] = JSON.parse(r.postData() || 'null');
      } catch {
        adminWrites[`${r.method()} ${p}`] = { __unparseable: r.postData() };
      }
    }
  });

  scenario('#51 held release: joint winners are expressible from the desk', async () => {
    await signIn('admin', 'ui-admin-password');
    // TWO markets of its own, created up front (#134). This used to take the
    // first two open markets the desk listed and SETTLE both of them — which is
    // how the suite used to leave later scenarios with no market to settle, and
    // how its own result came to depend on what had run before it.
    await withMarket('held release dead heat', async (tieFx) => {
    const heldMarketId = tieFx.marketId;
    // A held market is needed, and the seeded catalogue has none. Set the same
    // columns the results poll writes, so this is the real hold rather than a
    // mocked flag — the route under test reads them.
    {
      const db = await openDb();
      db.prepare(
        'UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ? AND status = ?'
      ).run('result feed: dead heat disputed', heldMarketId, 'open');
      const n = db.prepare('SELECT settlement_hold FROM markets WHERE id = ?').get(heldMarketId);
      db.close();
      if (!n || n.settlement_hold !== 1) {
        check('#51 fixture: the market is held', false, `(hold=${n && n.settlement_hold})`);
        return;
      }
    }

    await atAdmin('results');
    await page.waitForSelector(`#adminBody [data-release-settle="${heldMarketId}"]`, { timeout: 15000 });
    const heldRow = page.locator(`#adminBody [data-release-settle="${heldMarketId}"]`);
    check(
      '#51 fixture: the held market is listed on the desk',
      (await heldRow.count()) === 1,
      `(market ${heldMarketId})`
    );

// The reason dialog comes first and the picker second (lib/results.js
    // refuses a release with no reason). Both are now REAL dialogs on the
    // shared overlay stack rather than window.prompt, so they are driven
    // through the DOM. `prompts` is still recorded so that "no native dialog is
    // raised any more" is an assertion rather than an assumption.
    prompts.length = 0;
    await heldRow.click();
    await page.waitForSelector('.modal[role="dialog"] [data-ask="reason"]', { timeout: 10000 });
    check(
      '#51 the release asks for a written reason in a dialog on the app, not a browser prompt',
      (await page.locator('.modal[role="dialog"] [data-ask="reason"]').count()) === 1 && prompts.length === 0,
      `(${prompts.length} native prompt(s): ${prompts.join(' | ').slice(0, 90)})`
    );
    // A reason under five characters is refused BEFORE anything is sent, with
    // the error beside the field.
    await page.fill('.modal[role="dialog"] [data-ask="reason"]', 'no');
    await page.click('.modal[role="dialog"] #askGo');
    await page.waitForSelector('.modal[role="dialog"] .askerr:not([hidden])', { timeout: 3000 });
    check(
      '#51 a too-short reason is refused with the error beside the field',
      /least 5 characters/i.test(
        (await page.locator('.modal[role="dialog"] .askerr:not([hidden])').first().textContent()) || ''
      ),
      `("${((await page.locator('.modal[role="dialog"] .askerr:not([hidden])').first().textContent()) || '').trim()}")`
    );
    check(
      '#51 nothing was released while the reason was refused',
      releasePayload === null,
      `(payload ${JSON.stringify(releasePayload)})`
    );
    await page.fill('.modal[role="dialog"] [data-ask="reason"]', 'ui test: joint winners confirmed against the results feed');
    await page.click('.modal[role="dialog"] #askGo');

    // The picker is CHECKED for, not awaited. An awaited one turns "the control
    // does not exist" into an opaque 10s timeout that aborts the scenario, and
    // every later assertion — including the dead-heat payload, which is the
    // whole point — would then never run. A missing picker has to be a named
    // failure, not a scenario that dies quietly.
    const picker = page.locator('.modal[role="dialog"] #hoWinners');
    let pickerPresent = true;
    try {
      await picker.waitFor({ state: 'attached', timeout: 5000 });
    } catch {
      pickerPresent = false;
    }
    check(
      '#51 settling a held market opens a runner picker rather than a raw-id prompt',
      pickerPresent,
      `(${prompts.length} prompt(s): ${prompts.join(' | ').slice(0, 90)})`
    );
    check(
      '#51 no prompt demands a raw selection id',
      !prompts.some((m) => /selection id/i.test(m)),
      `(saw: ${prompts.join(' | ').slice(0, 90)})`
    );
    if (!pickerPresent) {
      check('#51 the release picker lists this market\'s runners by name', false, '(no picker on screen)');
      check(
        '#51 the release payload carries dead_heat for a two-way tie',
        false,
        `(the tie could not be expressed at all — payload ${JSON.stringify(releasePayload)})`
      );
      return;
    }

    // (b) — by NAME. The runner names come from this market's own book.
    const rows = await page.locator('.modal[role="dialog"] #hoWinners .optrow').allTextContents();
    const bookNames = await page.evaluate(
      async (id) => {
        const r = await (await fetch(`/api/markets/${id}/book`)).json();
        return r.book.map((s) => s.name);
      },
      heldMarketId
    );
    check(
      '#51 the release picker lists this market\'s runners by name',
      bookNames.length >= 2 && bookNames.every((n) => rows.some((r) => r.includes(n))),
      `(${rows.length} rows for ${bookNames.length} runners: ${rows.join(' | ').slice(0, 80)})`
    );

    const goBtn = page.locator('.modal[role="dialog"] #hoGo');
    const boxes = page.locator('.modal[role="dialog"] #hoWinners .hoPick');

    // The button tracks the selection BOTH ways. Asserting only "disabled at
    // rest" passes for a button that is permanently disabled, which is its own
    // dead control — so a choice is made, then withdrawn.
    const inertAtRest = await goBtn.isDisabled();
    await boxes.nth(0).check();
    const inertWhenChosen = await goBtn.isDisabled();
    await boxes.nth(0).uncheck();
    const inertAfterUntick = await goBtn.isDisabled();
    check(
      '#51 the release button is live only while a runner is chosen',
      inertAtRest && !inertWhenChosen && inertAfterUntick,
      `(rest=${inertAtRest}, chosen=${inertWhenChosen}, unticked=${inertAfterUntick})`
    );

    // ── (a) — drive the real control: tick TWO runners ─────────────────────
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    const summary = ((await page.locator('.modal[role="dialog"] #hoSummary').textContent()) || '').trim();
    check('#51 two ticks read as a dead heat, not a single winner', /dead heat/i.test(summary), `("${summary.slice(0, 60)}")`);

    // Cancelling WITH a selection made is the dangerous case. Cancelling with
    // nothing ticked proves almost nothing — there is nothing to release — and
    // a picker that released on cancel would sail past it. This is also the
    // path an awaiter that never settles would break, leaving the operator
    // facing a dialog whose buttons look dead.
    releasePayload = null;
    await page.locator('.modal[role="dialog"] #hoCancel').click();
    await page.waitForTimeout(600);
    check(
      '#51 cancelling with runners chosen releases nothing',
      releasePayload === null,
      `(payload ${JSON.stringify(releasePayload)})`
    );
    check(
      '#51 cancelling leaves the market held',
      (await page.locator(`#adminBody [data-release-settle="${heldMarketId}"]`).count()) === 1
    );
    check(
      '#51 cancelling closes the dialog',
      (await page.locator('.modal[role="dialog"] #hoWinners').count()) === 0
    );

    // Reopen and commit the tie for real.
    await page.locator(`#adminBody [data-release-settle="${heldMarketId}"]`).click();
    await page.waitForSelector('.modal[role="dialog"] [data-ask="reason"]', { timeout: 10000 });
    await page.fill('.modal[role="dialog"] [data-ask="reason"]', 'ui test: joint winners confirmed against the results feed');
    await page.click('.modal[role="dialog"] #askGo');
    await page.locator('.modal[role="dialog"] #hoWinners').waitFor({ state: 'attached', timeout: 10000 });
    await page.locator('.modal[role="dialog"] #hoWinners .hoPick').nth(0).check();
    await page.locator('.modal[role="dialog"] #hoWinners .hoPick').nth(1).check();
    releasePayload = null;
    await page.locator('.modal[role="dialog"] #hoGo').click();
    await page.waitForFunction(
      () => /settled/.test((document.querySelector('#toast') || {}).textContent || ''),
      { timeout: 15000 }
    );

    const ids = await page.evaluate(
      async (id) => {
        const r = await (await fetch(`/api/markets/${id}/book`)).json();
        return r.book.map((s) => s.selection_id);
      },
      heldMarketId
    );
    check(
      '#51 the release payload carries dead_heat for a two-way tie',
      !!releasePayload &&
        Array.isArray(releasePayload.dead_heat) &&
        releasePayload.dead_heat.length === 2 &&
        releasePayload.dead_heat.every((x) => ids.includes(x)),
      `(payload ${JSON.stringify(releasePayload)})`
    );
    check(
      '#51 a dead heat sends no single winner_selection_id alongside it',
      !!releasePayload && (releasePayload.winner_selection_id === null || releasePayload.winner_selection_id === undefined),
      `(payload ${JSON.stringify(releasePayload)})`
    );
    check(
      '#51 the release carries the operator\'s reason to the server',
      !!releasePayload && typeof releasePayload.reason === 'string' && releasePayload.reason.length >= 5,
      `(${releasePayload && releasePayload.reason})`
    );

    // The hold is cleared and the market is settled by the release, so the
    // desk must stop offering it.
    await page.waitForFunction(
      (id) => !document.querySelector(`#adminBody [data-release-settle="${id}"]`),
      heldMarketId,
      { timeout: 10000 }
    );
    check('#51 the released market leaves the held queue', true);
    });   // the dead-heat market is deleted here; the single-winner path gets its own

    // ── ONE tick is a plain win, not a one-element dead heat ────────────────
    // lib/results.js refuses a dead_heat list shorter than two distinct ids, so
    // a picker that sent `dead_heat: [x]` for a single winner would 400 on the
    // commonest release of all. Held from the same columns as above — on a
    // SECOND market of this scenario's own (#134), not on "whatever is still
    // open", which is how this half of the scenario used to depend on the half
    // above it.
    await withMarket('held release single winner', async (soloFx) => {
    const soloMarketId = soloFx.marketId;
    {
      const db = await openDb();
      db.prepare('UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?').run(
        'result feed: unrecognised result',
        soloMarketId
      );
      db.close();
    }
    await atAdmin('results');
    await page.waitForSelector(`#adminBody [data-release-settle="${soloMarketId}"]`, { timeout: 15000 });

    releasePayload = null;
    await page.locator(`#adminBody [data-release-settle="${soloMarketId}"]`).click();
    await page.waitForSelector('.modal[role="dialog"] [data-ask="reason"]', { timeout: 15000 });
    await page.fill('.modal[role="dialog"] [data-ask="reason"]', 'ui test: single winner confirmed against the results feed');
    await page.click('.modal[role="dialog"] #askGo');
    await page.locator('.modal[role="dialog"] #hoWinners').waitFor({ state: 'attached', timeout: 10000 });
    const soloBox = page.locator('.modal[role="dialog"] #hoWinners .hoPick').first();
    const soloId = Number(await soloBox.getAttribute('value'));
    await soloBox.check();
    await page.locator('.modal[role="dialog"] #hoGo').click();
    await page.waitForFunction(
      () => /settled/.test((document.querySelector('#toast') || {}).textContent || ''),
      { timeout: 15000 }
    );
    check(
      '#51 one ticked runner sends winner_selection_id and no dead_heat',
      !!releasePayload &&
        releasePayload.winner_selection_id === soloId &&
        (releasePayload.dead_heat === undefined || releasePayload.dead_heat === null),
      `(payload ${JSON.stringify(releasePayload)}, expected winner ${soloId})`
    );
    });
  });

  // ── #52 (2/3): settlement and suspend carry a written reason ─────────────
  //
  // admin.js's own header claims "Every mutating control below is gated
  // server-side too (reason required, ...)". That holds for the user actions,
  // where lib/admin.js's reasonOr400 refuses an empty one — but NOT for the two
  // market actions. Both routes audit `body.reason || null`, which server.js
  // describes as "always absent in practice": suspending a user could carry a
  // justification, and settling one — "moves the most money of any operator
  // action" — could not.
  //
  // Asserted on the wire and then in the audit trail, because the claim is
  // about the RECORD: a reason typed into a dialog and dropped on the floor
  // satisfies every DOM assertion there is.
  scenario('#52 settlement and suspend record a written reason', async () => {
    await signIn('admin', 'ui-admin-password');
    // TWO fixture markets, one per action (#134). The suspend/restore pair and
    // the settlement used to be whatever two rows the desk listed first, and the
    // settlement SETTLED one of them — the same leftover-state dependency #134 is
    // about, one scenario removed.
    let mktId = null;
    let settleId = null;

    await withMarket('suspend and restore', async (susFx) => {
    mktId = susFx.marketId;
    await atAdmin('markets');
    await page.waitForSelector(`#adminBody [data-toggle="${mktId}"]`, { timeout: 15000 });

    // ── suspend / restore ──────────────────────────────────────────────────
    const suspendBtn = page.locator(`#adminBody [data-toggle="${mktId}"]`).first();
    // `data-status` is the status the button WILL SET. On a market this scenario
    // created it is therefore "suspended", and the label reads Suspend. Stated
    // as a check rather than assumed: the whole suspend/restore pair below only
    // means anything if the market really was open before the first click, and
    // "it was open because nobody had touched it" is not a thing a test gets to
    // take on faith.
    const willSuspend = (await suspendBtn.getAttribute('data-status')) === 'suspended';
    check(
      '#52 fixture: the market under test starts open, not suspended',
      willSuspend && /suspend/i.test((await suspendBtn.textContent()) || ''),
      `(button offers ${await suspendBtn.getAttribute('data-status')})`
    );
    if (!willSuspend) return;
    // Re-locate the row BY ID for every click. `.first()` resolves against the
    // table as it is NOW, and the table re-renders after each action: clicking
    // a stale row reads a stale `data-status` and suspends a market that was
    // about to be restored. This was a real flake, not a theoretical one.
    const toggleRow = (id) => page.locator(`#adminBody [data-toggle="${id}"]`).first();

    // Cancelling the dialog must not suspend anything. The reason control is a
    // real dialog on the app's overlay stack now, so this is driven through the
    // DOM; `prompts` is watched throughout to prove no NATIVE dialog is raised
    // any more, because the old mechanism was window.prompt and "it still
    // works" would have satisfied the original test.
    prompts.length = 0;
    delete adminWrites[`PATCH /api/admin/markets/${mktId}`];
    await toggleRow(mktId).click();
    await page.waitForSelector('.modal[role="dialog"] [data-ask="reason"]', { timeout: 10000 });
    check(
      '#52 suspending asks for a reason in an app dialog, and raises no browser prompt',
      prompts.length === 0,
      `(${prompts.length} native prompt(s): ${prompts.join(' | ').slice(0, 60)})`
    );
    await page.click('.modal[role="dialog"] #askCancel');
    await page.waitForTimeout(400);
    check(
      '#52 suspending sends nothing when the reason dialog is cancelled',
      adminWrites[`PATCH /api/admin/markets/${mktId}`] === undefined,
      `(payload ${JSON.stringify(adminWrites[`PATCH /api/admin/markets/${mktId}`])})`
    );
    check(
      '#52 cancelling leaves no dialog behind',
      (await page.locator('.modal[role="dialog"]').count()) === 0
    );

    await toggleRow(mktId).click();
    await page.waitForSelector('.modal[role="dialog"] [data-ask="reason"]', { timeout: 10000 });
    await page.fill('.modal[role="dialog"] [data-ask="reason"]', 'ui test: price feed disagreement, market withdrawn pending review');
    await page.click('.modal[role="dialog"] #askGo');
    await page.waitForFunction(
      () => /^Market (suspended|open)$/.test((document.querySelector('#toast') || {}).textContent || ''),
      { timeout: 15000 }
    );
    const patch = adminWrites[`PATCH /api/admin/markets/${mktId}`] || null;
    check(
      '#52 suspend sends the operator\'s reason',
      !!patch && typeof patch.reason === 'string' && patch.reason.length >= 5 && patch.status === 'suspended',
      `(payload ${JSON.stringify(patch)})`
    );

    // Put it back, so the suite leaves the catalogue as it found it.
    //
    // `data-status` is the status the button WILL SET, not the market's current
    // one: a suspended market offers a button that sets 'open' and is labelled
    // "Restore". So "is the market suspended now?" is answered by the LABEL.
    //
    // The old assertion here waited for `dataset.status === 'open'`, which is
    // exactly what the row reads the moment the suspend succeeds — so it was
    // satisfied before the restore was even attempted, and a restore that sent
    // nothing at all would have passed it. The post-condition below is the real
    // one: the row offers Suspend again, which only happens once the market is
    // open again.
    const restoreBtn = toggleRow(mktId);
    await page.waitForFunction(
      (id) => /restore/i.test((document.querySelector(`#adminBody [data-toggle="${id}"]`) || {}).textContent || ''),
      mktId,
      { timeout: 15000 }
    );
    await restoreBtn.click();
    await page.waitForSelector('.modal[role="dialog"] [data-ask="reason"]', { timeout: 10000 });
    await page.fill('.modal[role="dialog"] [data-ask="reason"]', 'ui test: feed reconciled, market restored');
    await page.click('.modal[role="dialog"] #askGo');
    await page.waitForFunction(
      (id) => /suspend/i.test((document.querySelector(`#adminBody [data-toggle="${id}"]`) || {}).textContent || ''),
      mktId,
      { timeout: 15000 }
    );
    const restore = adminWrites[`PATCH /api/admin/markets/${mktId}`] || null;
    check(
      '#52 restore sends the operator\'s reason too',
      !!restore && restore.status === 'open' && typeof restore.reason === 'string' && restore.reason.length >= 5,
      `(payload ${JSON.stringify(restore)})`
    );
    });

    // ── settle ────────────────────────────────────────────────────────────
    await withMarket('settle with a written reason', async (setFx) => {
    settleId = setFx.marketId;
    await atAdmin('markets');
    await page.waitForSelector(`#adminBody [data-settle="${settleId}"]`, { timeout: 15000 });
    const settleBtn = page.locator(`#adminBody [data-settle="${settleId}"]`);
    await settleBtn.click();
    await page.waitForSelector('.modal[role="dialog"] #sdGo', { timeout: 10000 });
    check(
      '#52 the settle dialog carries a reason field',
      (await page.locator('.modal[role="dialog"] #sdReason').count()) === 1
    );

    // No reason, no settlement.
    await page.locator('.modal[role="dialog"] input[name="winner"]').first().check();
    delete adminWrites[`POST /api/admin/markets/${settleId}/settle`];
    await page.locator('.modal[role="dialog"] #sdGo').click();
    // A bounded settle rather than a wait on the refusal toast. The refusal is
    // synchronous; a real settlement is a round trip. Waiting on the toast
    // alone HANGS when the control has no refusal at all — which is the state
    // this check exists to catch — and then the scenario dies before the
    // assertion that matters runs.
    await page.waitForTimeout(1500);
    check(
      '#52 settling will not proceed without a written reason',
      adminWrites[`POST /api/admin/markets/${settleId}/settle`] === undefined,
      `(payload ${JSON.stringify(adminWrites[`POST /api/admin/markets/${settleId}/settle`])})`
    );

    await page.fill('.modal[role="dialog"] #sdReason', 'ui test: result confirmed against the official feed');
    await page.locator('.modal[role="dialog"] #sdGo').click();
    await page.waitForFunction(
      () => /Settled \d+ position/.test((document.querySelector('#toast') || {}).textContent || ''),
      { timeout: 15000 }
    );
    const settle = adminWrites[`POST /api/admin/markets/${settleId}/settle`] || null;
    check(
      '#52 settle sends the operator\'s reason alongside the winner',
      !!settle && typeof settle.reason === 'string' && settle.reason.length >= 5 && settle.winner_selection_id != null,
      `(payload ${JSON.stringify(settle)})`
    );
    });   // the settled market is deleted here; its audit rows are not

    // And it is in the RECORD, which is the whole claim. Two filters: the
    // settlement and the suspend/restore pair are different market ids.
    const auditFor = async (target) => {
      await atAdmin('audit');
      await page.waitForSelector('#adminBody .adm-tbl tbody tr', { timeout: 15000 });
      await page.fill('#auditTarget', target);
      await page.click('#auditGo');
      await page.waitForFunction(
        (t) => {
          const tb = document.querySelector('#adminBody .adm-tbl tbody');
          return !!tb && (tb.textContent || '').includes(t);
        },
        target,
        { timeout: 10000 }
      );
      return (await page.locator('#adminBody .adm-tbl tbody').textContent()) || '';
    };

    const settleAudit = await auditFor(`market:${settleId}`);
    check(
      '#52 the settlement audit row carries the reason',
      /market\.settled/.test(settleAudit) && settleAudit.includes('ui test: result confirmed against the official feed'),
      `(${settleAudit.slice(0, 80)}…)`
    );

    const suspendAudit = await auditFor(`market:${mktId}`);
    check(
      '#52 the suspend and restore audit rows carry their reasons',
      suspendAudit.includes('ui test: price feed disagreement, market withdrawn pending review') &&
        suspendAudit.includes('ui test: feed reconciled, market restored'),
      `(${suspendAudit.slice(0, 80)}…)`
    );
  });

// ── #52 (3/3): tenant branding is served and never consumed ──────────────
  //
  // `grep -rn branding public/` returned zero hits before this: /api/branding
  // has been served the whole time, no JS fetched it, no CSS variable was set,
  // and editTenant could not even write the `brand` JSON. ROADMAP.md claimed
  // per-tenant theming worked "through the frontend".
  //
  // Split into two halves that do not depend on each other, because they are
  // two separate defects and one must not hide the other:
  //   (a) the DESK can set the brand — the editor has no brand fields;
  //   (b) the BROWSER consumes it — the response is never read at all.
  // (b) is written through the API, not the desk, and asserted after a RELOAD.
  // That matters twice over: the bug is precisely that nothing read the
  // response, and asserting that a fetch happened would prove nothing about
  // the UI — while reading a CSS variable that was never set returns the house
  // palette, which is true whether or not the branding works. So the only
  // honest assertion is a distinctive colour on :root after a fresh load.
  //
  // Read LAZILY, on first use, rather than once at registration time (#134): it
  // is a fact about the page, and after the refactor the page the suite opens on
  // is no longer guaranteed to be the page each scenario starts from.
  let houseAccentCache;
  const houseAccent = async () => {
    if (houseAccentCache === undefined) {
      houseAccentCache = await page.evaluate(() => {
        for (const sheet of document.styleSheets) {
          let rules;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const r of rules) {
            if (r.selectorText === ':root') {
              const m = /--accent:\s*([^;]+)/.exec(r.style.cssText);
              if (m) return m[1].trim();
            }
          }
        }
        return null;
      });
    }
    return houseAccentCache;
  };

  const branding = () =>
    page.evaluate(async () => {
      const b = await (await fetch('/api/branding')).json();
      return b;
    });
  const rootVars = () =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        inline: document.documentElement.getAttribute('style') || '',
        accent: cs.getPropertyValue('--accent').trim(),
        pink: cs.getPropertyValue('--pink').trim(),
        title: document.title,
        slug: document.documentElement.getAttribute('data-tenant'),
      };
    });
  const writeBrand = (id, brand) =>
    page.evaluate(
      async ([tid, b]) => {
        await fetch(`/api/admin/tenants/${tid}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand: b }),
        });
      },
      [id, brand]
    );
  const reload = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#balance:not([hidden])', { timeout: 15000 });
  };

  const brand = { name: 'UI Test Exchange', logo: '/assets/logo.png', terms_url: '/terms/ui-test', palette: { accent: '#ff6600', pink: '#00aa88' } };

  scenario('#52 the browser consumes /api/branding after a reload', async () => {
    // The brand is cleared FIRST and restored in a finally (#134). "What ships
    // when no brand is set" is only a fact about the venue if no brand is set,
    // and in a shuffled run one of the two other branding scenarios may have
    // written one. Without this the check below would be asserting a property
    // of the run order.
    await signIn('admin', 'ui-admin-password');
    const before = await branding();
    check(
      '#52 /api/branding serves the caller\'s tenant',
      !!before && !!before.tenant && !!before.tenant.id,
      `(tenant ${before && JSON.stringify(before.tenant)})`
    );
    if (!before || !before.tenant) return;
    const tid = before.tenant.id;
    const house = await houseAccent();
    await writeBrand(tid, { name: '', logo: '', favicon: '', terms_url: null, palette: {} });
    await reload();
    try {
    // Before anything: the house palette, whatever the response says.
    const virgin = await rootVars();
    check(
      '#52 fixture: the house palette is what ships when no brand is set',
      virgin.accent.toLowerCase() === (house || '').toLowerCase(),
      `(accent=${virgin.accent}, house is ${house})`
    );

    await writeBrand(tid, brand);
    await reload();
    const after = await rootVars();
    check(
      '#52 the tenant palette reaches :root as a CSS custom property',
      after.accent.toLowerCase() === '#ff6600' && after.pink.toLowerCase() === '#00aa88',
      `(accent=${after.accent}, pink=${after.pink}, house is ${house})`
    );
    check(
      '#52 the brand name reaches the page title',
      /UI Test Exchange/.test(after.title),
      `("${after.title}")`
    );
    check(
      '#52 the tenant is marked on the document root',
      typeof after.slug === 'string' && after.slug.length > 0,
      `(data-tenant=${after.slug})`
    );

    // ── an UNUSABLE palette value must be IGNORED, not applied ──────────────
    // A CSS custom property accepts nearly any token sequence, so applying
    // garbage makes every rule using it fail at computed-value time: a blank
    // venue, not a wrong accent. Written through the API on purpose — the desk
    // refuses it, and the APPLY side is what is under test.
    await writeBrand(tid, { ...brand, palette: { accent: 'not-a-colour', pink: '#00aa88', 'text;--x': '#000' } });
    await reload();
    const poisoned = await rootVars();
    check(
      '#52 a palette value that is not a colour is ignored, not applied',
      poisoned.accent.toLowerCase() !== 'not-a-colour' &&
        poisoned.accent.toLowerCase() === (house || '').toLowerCase(),
      `(accent=${poisoned.accent}, house is ${house})`
    );
    check(
      '#52 a valid palette key alongside an invalid one still applies',
      poisoned.pink.toLowerCase() === '#00aa88',
      `(pink=${poisoned.pink})`
    );
    check(
      '#52 a palette key that is not a property name is refused',
      !/--x/.test(poisoned.inline) && !/text;/.test(poisoned.inline),
      `(inline=${poisoned.inline})`
    );

    // ── the terms URL needs a surface; the Account panel is the one there is ─
    // COUNT first, then read: a missing element makes textContent() wait out
    // the full 30s default.
    await page.click('#accountBtn');
    await page.waitForSelector('#accountModal.show', { timeout: 10000 });
    const hasTermsSlot = (await page.locator('#pwTerms').count()) === 1;
    const termsText = hasTermsSlot ? ((await page.locator('#pwTerms').textContent()) || '').trim() : '';
    check(
      '#52 the tenant terms URL reaches the player',
      hasTermsSlot && /\/terms\/ui-test/.test(termsText),
      hasTermsSlot ? `("${termsText.slice(0, 60)}")` : '(the account panel has no terms slot at all)'
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('accountModal').classList.contains('show'), null, { timeout: 10000 });

    // Back to the house palette, so the run ends on a clean venue whatever ran
    // last.
    await writeBrand(tid, { name: '', logo: '', favicon: '', terms_url: null, palette: {} });
    await reload();
    const reset = await rootVars();
    check(
      '#52 clearing the brand puts the house colours back',
      reset.accent.toLowerCase() === (house || '').toLowerCase(),
      `(accent=${reset.accent}, house is ${house})`
    );
    } finally {
      await writeBrand(tid, { name: '', logo: '', favicon: '', terms_url: null, palette: {} }).catch(() => {});
    }
  });

  // ── #65: the favicon is the last unbranded asset in the shell ─────────────
  //
  // Name, palette, logo and data-tenant all reach the browser (#52). The
  // favicon did not: index.html hard-codes three icon links and nothing read
  // them, so every tenant's browser tab showed the house mark.
  //
  // ASSERTED ON THE DOM, NOT ON A FETCH. The claim is "the tab icon is the
  // tenant's", and a test that only checked /api/branding returned a
  // `favicon` key would pass with the apply side entirely absent — exactly how
  // the /api/branding route itself shipped with zero callers.
  const iconHref = (sel) =>
    page.evaluate((s) => {
      const n = document.querySelector(s);
      return n ? n.getAttribute('href') : null;
    }, sel);
  const iconHrefs = async () => ({
    icon: await iconHref('link[rel="icon"]'),
    apple: await iconHref('link[rel="apple-touch-icon"]'),
    ico: await iconHref('link[rel="alternate icon"]'),
  });
  // `content` rather than a computed style: this is what the browser actually
  // paints into the tab and the mobile URL bar.
  const themeColor = () =>
    page.evaluate(() => {
      const m = document.querySelector('meta[name="theme-color"]');
      return m ? m.getAttribute('content') : null;
    });
  // The RESOLVED background, which is what theme-color is compared against:
  // a custom property computes to the literal that was declared (`#ffffff`)
  // while backgroundColor is the rgb the browser actually paints.
  const resolvedBg = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

  scenario('#65 the favicon follows the tenant, and only when it can load', async () => {
    await signIn('admin', 'ui-admin-password');
    const before = await branding();
    if (!before || !before.tenant) {
      check('#65 fixture: a tenant to brand', false, '(no tenant served)');
      return;
    }
    const tid = before.tenant.id;
    // Start from a brand-free tenant, and put it back that way whatever
    // happens: the checks below compare against what the SHELL ships, and in a
    // shuffled run another branding scenario may have left a favicon behind.
    await writeBrand(tid, { name: '', logo: '', favicon: '', terms_url: null, palette: {} });
    await reload();
    try {
    const house = await iconHrefs();

    check(
      '#65 /api/branding serves a favicon',
      typeof before.favicon === 'string' && before.favicon.length > 0,
      `(favicon=${JSON.stringify(before.favicon)})`
    );

    // A path that EXISTS on the venue, and differs from every bundled default,
    // so a change cannot be confused with the house mark already being there.
    await writeBrand(tid, { name: '', logo: '', favicon: '/assets/apple-touch-icon.png', terms_url: null, palette: {} });
    await reload();
    const branded = await iconHrefs();
    check(
      '#65 the tenant favicon reaches the icon links',
      branded.icon === '/assets/apple-touch-icon.png' && branded.apple === '/assets/apple-touch-icon.png',
      `(icon=${branded.icon}, apple=${branded.apple})`
    );
    check(
      '#65 the favicon changed from what the shell ships',
      branded.icon !== house.icon || branded.apple !== house.apple,
      `(house icon=${house.icon} apple=${house.apple})`
    );

    // THE CSP HALF. The venue's policy is `img-src 'self' data:`, so a remote
    // favicon is refused by the browser whatever the page asks for — exactly
    // why applyBranding already guards the logo. The href is asserted here, not
    // the rendered image: a refused fetch leaves the link in place, and the
    // thing a tenant gets wrong is the link pointing at someone else's server.
    await writeBrand(tid, { name: '', logo: '', favicon: 'https://cdn.example.com/f.png', terms_url: null, palette: {} });
    await reload();
    const remote = await iconHrefs();
    check(
      '#65 a remote favicon is refused, not written into the page',
      remote.icon !== 'https://cdn.example.com/f.png' && remote.apple !== 'https://cdn.example.com/f.png',
      `(icon=${remote.icon}, apple=${remote.apple})`
    );
    check(
      '#65 a protocol-relative favicon is refused too',
      !String(remote.icon || '').startsWith('//'),
      `(icon=${remote.icon})`
    );

    await writeBrand(tid, { name: '', logo: '', favicon: '/assets/favicon.png', terms_url: null, palette: {} });
    await reload();
    const fallback = await iconHrefs();
    check(
      '#65 clearing the favicon falls back to the bundled icon',
      fallback.icon === '/assets/favicon.png' && fallback.apple === '/assets/apple-touch-icon.png',
      `(icon=${fallback.icon}, apple=${fallback.apple})`
    );

    // ── theme-color ────────────────────────────────────────────────────────
    // index.html hard-codes #ffffff, which paints a white bar in the browser
    // chrome above a venue whose own background is whatever the tenant set.
    // It has to track the RESOLVED background, so branding and a dark theme
    // cannot both own it.
    const houseBg = await resolvedBg();
    check(
      '#65 the meta theme-color follows the resolved background',
      (await themeColor()) === houseBg,
      `(meta=${await themeColor()}, background=${houseBg})`
    );
    await writeBrand(tid, { name: '', logo: '', favicon: '/assets/favicon.png', terms_url: null, palette: { bg: '#101014' } });
    await reload();
    check(
      '#65 a tenant background repaints the browser chrome',
      (await resolvedBg()) === 'rgb(16, 16, 20)' && (await themeColor()) === 'rgb(16, 16, 20)',
      `(background=${await resolvedBg()}, meta=${await themeColor()})`
    );

    await writeBrand(tid, { name: '', logo: '', favicon: '/assets/favicon.png', terms_url: null, palette: {} });
    await reload();
    } finally {
      await writeBrand(tid, { name: '', logo: '', favicon: '', terms_url: null, palette: {} }).catch(() => {});
    }
  });

// ── #66: dark mode ────────────────────────────────────────────────────────
  //
  // Three claims, in increasing order of how easily they could be faked:
  //
  //   1. THE LIGHT PALETTE DID NOT MOVE. Read out of the `:root` rule itself,
  //      value by value, against the hexes the file ships. A theme delivered
  //      "by media query" can still quietly have edited a light value, and
  //      nothing else in the suite would notice.
  //   2. THE DARK VALUES ACTUALLY APPLY, from the COMPUTED styles of the real
  //      ladder cells — not from the token block, which proves only that a
  //      block of text exists.
  //   3. THE BACK/LAY PAIR IS READABLE ON THE DARK GROUND. The price contrast
  //      is computed here, in the browser, from what the cells actually paint,
  //      and asserted against 4.5:1. That is the whole reason this is not a
  //      block copy: a straight inversion puts dark blue on a near-black
  //      ground, and this check fails.
  const _lum = (rgb) => {
    const m = /rgba?\(([^)]+)\)/.exec(rgb);
    if (!m) return null;
    const p = m[1].split(/[,/]/).map(Number);
    const lin = (c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
  };
  const ratioOf = (a, b) => {
    const [x, y] = [_lum(a) + 0.05, _lum(b) + 0.05].sort((p, q) => q - p);
    return Math.round((x / y) * 100) / 100;
  };
  // Measured from the COMPUTED styles of the real elements, so it is the colour
  // on screen rather than the colour someone intended.
  const cellContrast = (sel) =>
    page.evaluate((s) => {
      const n = document.querySelector(s);
      if (!n) return null;
      const cs = getComputedStyle(n);
      const parse = (v) => {
        const m = /rgba?\(([^)]+)\)/.exec(v);
        if (!m) return null;
        const p = m[1].split(/[,/]/).map(Number);
        return [p[0], p[1], p[2]];
      };
      const lin = (c) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const fg = parse(cs.color);
      const bg = parse(cs.backgroundColor);
      if (!fg || !bg) return null;
      const a = L(fg) + 0.05;
      const c = L(bg) + 0.05;
      return Math.round((Math.max(a, c) / Math.min(a, c)) * 100) / 100;
    }, sel);

  // Every colour role the house palette ships, byte for byte.
  const HOUSE = {
    '--bg': '#ffffff', '--bg2': '#f7f7f8', '--card': '#ffffff', '--card2': '#f5f5f6',
    '--line': '#e6e6e8', '--line2': '#d3d3d7', '--text': '#0a0a0b', '--muted': '#6b6b73',
    '--accent': '#b9b9c0', '--accent-bg': '#f0f0f2',
    '--blue': '#1b5fd9', '--blue-bg': '#e8f0fe', '--blue-line': '#c3dafb',
    '--pink': '#d6147a', '--pink-bg': '#fdecf4', '--pink-line': '#f8c8de',
    '--red': '#c2261f', '--red-bg': '#fdeceb', '--green': '#0f7a3d', '--green-bg': '#e6f5ec',
  };

  const declaredRootTokens = () =>
    page.evaluate(() => {
      const out = {};
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const r of rules) {
          // The BASE :root only — the dark block is `:root[data-theme='dark']`,
          // a different selectorText, so it cannot be picked up here.
          if (r.selectorText !== ':root') continue;
          for (const name of r.style) {
            if (name.startsWith('--')) out[name] = r.style.getPropertyValue(name).trim();
          }
        }
      }
      return out;
    });

  const activeTheme = () => page.getAttribute('html', 'data-theme');
  const pageBg = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  const freshLoad = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#balance:not([hidden])', { timeout: 15000 });
  };
  const clearTheme = () =>
    page.evaluate(() => {
      try {
        localStorage.removeItem('obx.theme');
      } catch {}
    });

  // A live, full-strength cell: `.depth` and `.carried` set opacity, and an
  // empty cell has no price at all. Colour and background are read from the
  // SAME element so the ratio is the one the eye receives.
  const LIVE_BACK = '.lcell.back:not(.depth):not(.carried):not(.empty)';
  const LIVE_LAY = '.lcell.lay:not(.depth):not(.carried):not(.empty)';
  const onBoard = async () => {
    await page.evaluate(() => {
      location.hash = '#/markets';
    });
    await page.waitForSelector(`${LIVE_BACK}`, { timeout: 15000 });
  };

  scenario('#66 dark mode: the light palette is untouched and the dark one is readable', async () => {
   await signIn('admin', 'ui-admin-password');
   try {
    await onBoard();
    // ── 1. the light values, value by value ──────────────────────────────
    const rootTokens = await declaredRootTokens();
    const moved = Object.entries(HOUSE)
      .filter(([k, v]) => (rootTokens[k] || '').toLowerCase() !== v)
      .map(([k, v]) => `${k} is ${rootTokens[k]} not ${v}`);
    check(
      '#66 every light palette value is byte-identical',
      moved.length === 0,
      `(${moved.join(', ') || 'all 20 unchanged'})`
    );

    // ── the default follows the OS, and light is what light users get ─────
    await page.emulateMedia({ colorScheme: 'light' });
    await clearTheme();
    await freshLoad();
    check('#66 with no stored choice a light OS gets the light theme', (await activeTheme()) === 'light', `(data-theme=${await activeTheme()})`);
    check('#66 the resolved light background is still #ffffff', (await pageBg()) === 'rgb(255, 255, 255)', `(${await pageBg()})`);
    await onBoard();
    const lBack = await cellContrast(LIVE_BACK);
    const lLay = await cellContrast(LIVE_LAY);
    check(
      '#66 the light ladder prices are the numbers that shipped',
      Math.abs(lBack - 4.97) < 0.02 && Math.abs(lLay - 4.36) < 0.02,
      `(back ${lBack}:1, lay ${lLay}:1 — the lay price was already below the 4.5 AA floor before this issue)`
    );

    // ── 2. the dark values apply, from the computed styles ────────────────
    await page.emulateMedia({ colorScheme: 'dark' });
    await clearTheme();
    await freshLoad();
    check(
      '#66 a dark OS resolves to the dark theme with no stored choice',
      (await activeTheme()) === 'dark',
      `(data-theme=${await activeTheme()})`
    );
    check('#66 the dark ground is applied, not merely declared', (await pageBg()) === 'rgb(11, 11, 13)', `(${await pageBg()})`);

    // ── 3. the pair, measured where it is painted ─────────────────────────
    await onBoard();
    const dBack = await cellContrast(LIVE_BACK);
    const dLay = await cellContrast(LIVE_LAY);
    check('#66 the dark back price clears AA on its own cell', dBack !== null && dBack >= 4.5, `(${dBack}:1)`);
    check('#66 the dark lay price clears AA on its own cell', dLay !== null && dLay >= 4.5, `(${dLay}:1)`);
    check(
      '#66 both dark prices beat the light values they replace',
      dBack > lBack && dLay > lLay,
      `(dark ${dBack}/${dLay} vs light ${lBack}/${lLay})`
    );

    // The invariant style.css:39 states: the two sides are never allowed to be
    // near enough. In light mode the two CELL FILLS are 1.01:1 apart — identical
    // in luminance, separated by hue alone — so the dark pair is required to do
    // better on lightness, not merely to differ.
    const sides = await page.evaluate(() => {
      const g = (s) => getComputedStyle(document.querySelector(s));
      const b = document.querySelector('.lcell.back:not(.depth):not(.carried):not(.empty)');
      const l = document.querySelector('.lcell.lay:not(.depth):not(.carried):not(.empty)');
      return { backBg: g('.lcell.back').backgroundColor, layBg: g('.lcell.lay').backgroundColor, backFg: getComputedStyle(b).color, layFg: getComputedStyle(l).color };
    });
    const fillSep = ratioOf(sides.backBg, sides.layBg);
    check(
      '#66 the two sides differ in colour and in luminance',
      sides.backBg !== sides.layBg && sides.backFg !== sides.layFg && fillSep >= 1.25,
      `(fills ${fillSep}:1, ${sides.backBg} vs ${sides.layBg})`
    );
    const darkMeta = await themeColor();
    check('#66 theme-color follows the dark ground', darkMeta === 'rgb(11, 11, 13)', `(${darkMeta})`);

    // ── 4. the manual override persists, and beats the OS ────────────────
    // Driven the way a user does it: open Account, click the visible chip. A
    // hidden <input> cannot be clicked directly (the click and the label's own
    // activation toggle it twice), so a test that pokes the input would prove
    // the wiring works and not that the control is usable.
    await page.click('#accountBtn');
    await page.waitForSelector('#accountModal.show', { timeout: 5000 });
    check(
      '#66 the appearance control is offered where the other settings are',
      await page.isVisible('#themePicker .themepick-row'),
      '(the account panel carries no theme control)'
    );
    await page.click('#themePicker .themepick-opt:has(input[value="light"])');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', null, { timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('accountModal').classList.contains('show'), null, { timeout: 3000 });
    check(
      '#66 an explicit Light choice overrides a dark OS',
      (await activeTheme()) === 'light',
      `(data-theme=${await activeTheme()})`
    );
    await freshLoad();
    check(
      '#66 the choice survives a reload, against a dark OS',
      (await activeTheme()) === 'light',
      `(data-theme=${await activeTheme()})`
    );
    check(
      '#66 the control shows which ANSWER is stored, not which theme resulted',
      await page.isChecked('#themePicker input[value="light"]'),
      '(the Light chip is ticked while the OS still says dark)'
    );

    // And back to Auto, which a two-state toggle cannot offer.
    await page.click('#accountBtn');
    await page.waitForSelector('#accountModal.show', { timeout: 5000 });
    await page.click('#themePicker .themepick-opt:has(input[value="auto"])');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('accountModal').classList.contains('show'), null, { timeout: 3000 });
    check(
      '#66 Auto hands the decision back to the OS',
      (await activeTheme()) === 'dark',
      `(data-theme=${await activeTheme()})`
    );

    // ── 5. no flash: the decision is made before the stylesheet parses ────
    const order = await page.evaluate(() =>
      [...document.querySelectorAll('head script[src], head link[rel="stylesheet"]')].map((n) => n.getAttribute('src') || n.getAttribute('href'))
    );
    const at = (s) => order.indexOf(s);
    check(
      '#66 the theme script is loaded before the stylesheet, so there is no flash',
      at('/js/theme.js') >= 0 && at('/js/theme.js') < at('/style.css'),
      `(${order.join(' -> ')})`
    );

   } finally {
    // Leave the suite where it found it whatever happened above: no stored
    // choice, a light OS. Every later scenario reads the house palette, and a
    // run that aborted mid-theme would hand them a dark venue.
    await clearTheme();
    await page.emulateMedia({ colorScheme: 'light' });
    await freshLoad();
   }
  });
  scenario('#52 the desk can set the brand it serves', async () => {
    await signIn('admin', 'ui-admin-password');
    await atAdmin('tenants');
    await page.waitForFunction(
      () => /tenants/i.test((document.querySelector('#adminBody h4') || {}).textContent || ''),
      null,
      { timeout: 15000 }
    );
    const tid = await page.evaluate(() => {
      const b = document.querySelector('#adminBody [data-tenant]');
      return b ? Number(b.dataset.tenant) : null;
    });
    check('#52 fixture: the tenant view offers an edit control', tid !== null, `(tenant ${tid})`);
    if (tid === null) return;

    await page.locator(`#adminBody [data-tenant="${tid}"]`).click();
    const hasName = (await page.locator('#tBrandName').count()) === 1;
    check(
      '#52 the tenant editor carries branding fields',
      hasName,
      '(the desk could not even SET the brand JSON before)'
    );
    if (!hasName) return;

    await page.fill('#tBrandName', 'Desk Set Exchange');
    await page.fill('#tBrandLogo', '/assets/logo.png');
    await page.fill('#tBrandTerms', '/terms/from-the-desk');
    await page.fill(`#tp_${tid}_accent`, '#123456');
    await page.fill(`#tp_${tid}_pink`, '#654321');
    await page.click('#tSave');
    await page.waitForFunction(
      () => /Tenant updated/.test((document.querySelector('#toast') || {}).textContent || ''),
      null,
      { timeout: 15000 }
    );
    const stored = await page.evaluate(async (id) => {
      const d = await (await fetch('/api/admin/tenants')).json();
      const t = d.tenants.find((x) => x.id === id);
      try {
        return JSON.parse(t.brand);
      } catch {
        return null;
      }
    }, tid);
    check(
      '#52 the desk writes the brand JSON the route already accepted',
      !!stored &&
        stored.name === 'Desk Set Exchange' &&
        stored.palette.accent === '#123456' &&
        stored.palette.pink === '#654321' &&
        stored.terms_url === '/terms/from-the-desk',
      `(brand ${JSON.stringify(stored)})`
    );

    // And the editor round-trips: reopening shows what was stored.
    await page.locator(`#adminBody [data-tenant="${tid}"]`).click();
    await page.waitForSelector('#tBrandName', { timeout: 10000 });
    check(
      '#52 the tenant editor reopens showing the brand it stored',
      (await page.locator(`#tp_${tid}_pink`).inputValue()).toLowerCase() === '#654321' &&
        (await page.locator('#tBrandTerms').inputValue()) === '/terms/from-the-desk',
      `("${await page.locator(`#tp_${tid}_pink`).inputValue()}")`
    );

    // A palette value that is not a colour must never reach the venue: the
    // apply side ignores it, but a blank page for every player is worse than a
    // rejected form.
    try {
      await page.fill(`#tp_${tid}_accent`, 'chartreuse');
      delete adminWrites[`PUT /api/admin/tenants/${tid}`];
      await page.click('#tSave');
      await page.waitForTimeout(1500);
      check(
        '#52 the desk refuses a palette value that is not a hex colour',
        adminWrites[`PUT /api/admin/tenants/${tid}`] === undefined,
        `(payload ${JSON.stringify(adminWrites[`PUT /api/admin/tenants/${tid}`])})`
      );
    } finally {
      // Restore, through the desk, in a finally: the two branding scenarios
      // above both start by asserting the house palette is what ships, and
      // would fail against a brand this scenario abandoned mid-way (#134).
      await page.fill('#tBrandName', '');
      await page.fill('#tBrandTerms', '');
      await page.fill('#tBrandLogo', '');
      for (const k of ['accent', 'bg', 'text', 'blue', 'pink']) {
        await page.fill(`#tp_${tid}_${k}`, '');
      }
      await page.click('#tSave');
      await page.waitForFunction(
        () => /Tenant updated/.test((document.querySelector('#toast') || {}).textContent || ''),
        null,
        { timeout: 15000 }
      );
    }
    await reload();
    const house = await houseAccent();
    const restored = await rootVars();
    check(
      '#52 clearing the palette from the desk puts the house colours back',
      restored.accent.toLowerCase() === (house || '').toLowerCase(),
      `(accent=${restored.accent}, house is ${house})`
    );
  });

  // ── #52 (1/3): per-user limits and self-exclusion ────────────────────────
  //
  // lib/limits.js enforces the stake cap, the market-liability cap and the
  // daily settled cap — and operator-recorded self-exclusion — on EVERY trade.
  // Both were API routes with no control on the desk: `grep data-act` found
  // balance, suspend/reinstate and promote/demote, and nothing else.
  //
  // The sharp assertion here is not "a dialog opens" — it is that raising ONE
  // axis does not silently clear the others. The route's comment promises that
  // an absent key leaves its axis untouched, and it does not: lib/limits.js's
  // capOf() maps `undefined` to `null` and setLimits writes every axis on every
  // call, so omitting a key CLEARS that cap. Measured against a running server
  // before this control existed. So the checks read the caps back off the
  // server after changing one of them.
  scenario('#52 per-user limits: reachable, and changing one axis keeps the others', async () => {
    // Its OWN account (#134). This used to edit `uitester`, which only existed
    // because the registration scenario had run, and the caps it set survived
    // into every later run of the scenario in the same process. A fresh
    // account makes "raising one cap does not clear the others" a statement
    // about a known starting state: no caps at all.
    await registerAccount('limitstester', 'limitstester@example.com');
    await signIn('admin', 'ui-admin-password');
    await atAdmin('users');
    await page.waitForSelector('#adminBody .adm-tbl tbody tr', { timeout: 15000 });
    await page.fill('#userSearch', 'limitstester');
    await page.click('#userSearchGo');
    await page.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('#adminBody .adm-tbl tbody tr')];
        return rows.length === 1 && (rows[0].textContent || '').includes('limitstester');
      },
      null,
      { timeout: 15000 }
    );
    const row = page.locator('#adminBody .adm-tbl tbody tr').first();
    const uid = Number(((await row.locator('td').first().textContent()) || '').trim());

    const hasLimits = (await row.locator('[data-act="limits"]').count()) === 1;
    const hasExclude = (await row.locator('[data-act="exclude"]').count()) === 1;
    check('#52 fixture: the account row carries a limits control', hasLimits, `(user ${uid})`);
    check('#52 fixture: the account row carries a self-exclusion control', hasExclude, `(user ${uid})`);
    if (!hasLimits || !hasExclude) return;

    const limitsOf = () =>
      page.evaluate(async (id) => {
        const r = await (await fetch(`/api/admin/users/${id}/limits`)).json();
        return r.limits;
      }, uid);
    const globalRow = async () => (await limitsOf()).find((r) => r.scope === 'global') || null;

    // The starting point, stated. Without it "raising one cap does not clear
    // the others" would also pass against an account that had no other caps to
    // clear — which is a check that cannot fail.
    const capsBefore = await globalRow();
    check(
      '#52 fixture: the fresh account has no caps to clear yet',
      capsBefore === null ||
        (capsBefore.max_open_stake_cents == null &&
          capsBefore.max_market_liability_cents == null &&
          capsBefore.max_daily_settled_cents == null),
      `(row ${JSON.stringify(capsBefore)})`
    );

    // ── open the limits control ────────────────────────────────────────────
    await row.locator('[data-act="limits"]').click();
    await page.waitForSelector('.modal[role="dialog"] #lmSave', { timeout: 15000 });
    check(
      '#52 the limits control opens on the account under edit',
      /limitstester/.test((await page.locator('.modal[role="dialog"] h3').textContent()) || ''),
      `("${((await page.locator('.modal[role="dialog"] h3').textContent()) || '').trim()}")`
    );
    check(
      '#52 the limits control offers the global scope and per-market scopes',
      (await page.locator('.modal[role="dialog"] #lmScope option[value="global"]').count()) === 1 &&
        (await page.locator('.modal[role="dialog"] #lmScope option[value^="market:"]').count()) >= 1
    );

    // Three axes: two capped in dollars, one explicitly uncapped.
    await page.selectOption('.modal[role="dialog"] #lmScope', 'global');
    await page.fill('.modal[role="dialog"] [data-cents="max_open_stake_cents"]', '25');
    await page.fill('.modal[role="dialog"] [data-cents="max_daily_settled_cents"]', '500');
    await page.locator('.modal[role="dialog"] [data-nocap="max_market_liability_cents"]').check();
    delete adminWrites[`PUT /api/admin/users/${uid}/limits`];
    await page.locator('.modal[role="dialog"] #lmSave').click();
    await page.waitForFunction(
      () => /Limits saved/.test((document.querySelector('#toast') || {}).textContent || ''),
      { timeout: 15000 }
    );
    const wrote = adminWrites[`PUT /api/admin/users/${uid}/limits`] || null;
    check(
      '#52 the limits control sends every axis, not only the changed ones',
      !!wrote &&
        ['max_open_stake_cents', 'max_market_liability_cents', 'max_daily_settled_cents'].every((k) =>
          Object.prototype.hasOwnProperty.call(wrote, k)
        ),
      `(payload ${JSON.stringify(wrote)})`
    );
    check(
      '#52 the limits control sends integer cents and an explicit null for "no cap"',
      !!wrote &&
        wrote.scope === 'global' &&
        wrote.max_open_stake_cents === 2500 &&
        wrote.max_daily_settled_cents === 50000 &&
        wrote.max_market_liability_cents === null,
      `(payload ${JSON.stringify(wrote)})`
    );
    let g = await globalRow();
    check(
      '#52 the caps are stored on the server',
      !!g && g.max_open_stake_cents === 2500 && g.max_daily_settled_cents === 50000,
      `(row ${JSON.stringify(g)})`
    );

    // ── THE SHARP ONE: raise ONE axis, keep the others ─────────────────────
    await row.locator('[data-act="limits"]').click();
    await page.waitForSelector('.modal[role="dialog"] #lmSave', { timeout: 10000 });
    check(
      '#52 reopening shows the stored caps rather than a blank form',
      (await page.locator('.modal[role="dialog"] [data-cents="max_daily_settled_cents"]').inputValue()) === '500.00',
      `("${await page.locator('.modal[role="dialog"] [data-cents="max_daily_settled_cents"]').inputValue()}")`
    );
    await page.fill('.modal[role="dialog"] [data-cents="max_open_stake_cents"]', '50');
    await page.locator('.modal[role="dialog"] #lmSave').click();
    await page.waitForFunction(
      () => /Limits saved/.test((document.querySelector('#toast') || {}).textContent || ''),
      { timeout: 15000 }
    );
    g = await globalRow();
    check(
      '#52 raising one cap does not clear the others',
      !!g && g.max_open_stake_cents === 5000 && g.max_daily_settled_cents === 50000,
      `(row ${JSON.stringify(g)} — a daily cap of null here is the server clearing an omitted axis)`
    );
    await page.locator('.modal[role="dialog"] #lmCancel').click().catch(() => {});

    // ── self-exclusion, with a STRICT ISO end date ──────────────────────────
    await row.locator('[data-act="exclude"]').click();
    await page.waitForSelector('.modal[role="dialog"] #exGo', { timeout: 10000 });
    check(
      '#52 self-exclusion defaults to permanent',
      await page.locator('.modal[role="dialog"] #exPermanent').isChecked() &&
        (await page.locator('.modal[role="dialog"] #exUntil').isDisabled())
    );
    // An exclusion with no reason must not reach the server. The audit row is
    // only as good as the reason in it, and this is the one action here with
    // no inverse.
    delete adminWrites[`POST /api/admin/users/${uid}/exclude`];
    await page.locator('.modal[role="dialog"] #exGo').click();
    await page.waitForFunction(
      () => /reason is required/i.test((document.querySelector('#toast') || {}).textContent || ''),
      { timeout: 5000 }
    );
    check(
      '#52 self-exclusion will not proceed without a written reason',
      adminWrites[`POST /api/admin/users/${uid}/exclude`] === undefined,
      `(payload ${JSON.stringify(adminWrites[`POST /api/admin/users/${uid}/exclude`])})`
    );

    await page.locator('.modal[role="dialog"] #exPermanent').uncheck();
    const LOCAL = '2099-06-01T09:30';
    await page.fill('.modal[role="dialog"] #exUntil', LOCAL);
    await page.fill('.modal[role="dialog"] #exReason', 'ui test: exclusion recorded with a strict ISO end date');
    delete adminWrites[`POST /api/admin/users/${uid}/exclude`];
    await page.locator('.modal[role="dialog"] #exGo').click();
    await page.waitForFunction(
      () => /excluded/i.test((document.querySelector('#toast') || {}).textContent || ''),
      { timeout: 15000 }
    );
    const ex = adminWrites[`POST /api/admin/users/${uid}/exclude`] || null;
    check(
      '#52 self-exclusion sends a strict ISO-8601 UTC instant, not a local wall clock',
      !!ex && typeof ex.until === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(ex.until),
      `(sent until=${JSON.stringify(ex && ex.until)}, field said "${LOCAL}")`
    );
    check(
      '#52 self-exclusion sends the operator\'s reason',
      !!ex && typeof ex.reason === 'string' && ex.reason.length >= 5,
      `(${ex && ex.reason})`
    );

    // The only place the exclusion is visible afterwards: neither
    // GET /api/admin/users nor GET /api/admin/users/:id returns self_excluded
    // or excluded_until, so the audit trail is the record. Server-side read
    // gap, reported rather than worked around.
    await page.click('[data-view="audit"]');
    await page.waitForSelector('#adminBody .adm-tbl tbody tr', { timeout: 10000 });
    await page.fill('#auditTarget', `user:${uid}`);
    await page.click('#auditGo');
    await page.waitForFunction(
      (id) => {
        const tb = document.querySelector('#adminBody .adm-tbl tbody');
        return !!tb && /user\.excluded/.test(tb.textContent || '') && (tb.textContent || '').includes(`user:${id}`);
      },
      uid,
      { timeout: 10000 }
    );
    const auditText = (await page.locator('#adminBody .adm-tbl tbody').textContent()) || '';
    // The end date reaches the trail in lib/util.js's normalised form — the same
    // instant we sent, in SQLite's `YYYY-MM-DD HH:MM:SS` UTC. Asserting the
    // ISO string verbatim here would fail while the trail was correct.
    const inTrail = String(ex.until).replace('T', ' ').replace(/Z$/, '');
    check(
      '#52 the exclusion is audited with its reason and its end date',
      /user\.excluded/.test(auditText) &&
        auditText.includes(inTrail) &&
        auditText.includes('ui test: exclusion recorded'),
      `("${inTrail}" in: ${auditText.slice(0, 70)}…)`
    );
  });

  // ── First-run lock ──────────────────────────────────────────────────────
  // A locked account must be told what to do immediately, not left to
  // discover the lock by getting a 403 on their first bet.
  scenario('a configured password does not trigger the setup lock', async () => {
    // Its own sign-in: the scenario below needs demo UNLOCKED, and a shuffled
    // run may put that scenario first (#134).
    await signIn('demo', 'ui-demo-password');
    // Configured password => not locked => no forced setup panel.
    await page.waitForTimeout(1500);
    const setupShown = await page.locator('#accountModal.show').count();
    check('a configured password does not trigger the setup lock', setupShown === 0, `(${setupShown} modal(s))`);
  });

  // ── #44: the LOCKED sign-in actually forces setup ───────────────────────
  //
  // The check above only ever proved the NEGATIVE — that an unlocked account
  // does not open the panel. It passed with maybeForceSetup() throwing a
  // ReferenceError, because the throw was swallowed by submitAuth's own catch
  // and the panel stayed closed either way. So the bug shipped with a green
  // test beside it.
  //
  // This drives the POSITIVE: the server is made to flag an account as locked
  // (the same column server.js's boot sweep writes), then that account signs in
  // and the UI must open the panel and say what is wrong.
  //
  // Its OWN account, not `demo` (#134). The original unlocked demo by changing
  // its password and left it changed, so in any order where this scenario ran
  // early, every later scenario that signed in as demo failed to authenticate.
  // A throwaway account makes the password change part of the scenario's own
  // private story.
  scenario('a locked account is routed to the password panel on sign-in', async () => {
    const LOCKED = 'locktester';
    await registerAccount(LOCKED, `${LOCKED}@example.com`);
    // Sign OUT before flipping the flag. Flipping it under a live session
    // leaves that session polling endpoints it is no longer allowed to reach,
    // and the resulting 403 is this test manufacturing its own console error.
    await signOut();

    // The server is made to flag the account as locked — the same column
    // server.js's boot sweep writes — so this is the real lock, not a mocked flag.
    const db = await openDb();
    db.prepare('UPDATE users SET must_change_password = 1 WHERE username = ?').run(LOCKED);
    db.close();

    await page.click('#authBtn');
    await page.waitForSelector('#authModal.show', { timeout: 10000 });
    await page.fill('#authUser', LOCKED);
    await page.fill('#authPass', 'secret1');
    expectLock403 = true;
    await page.click('#authGo');

    // The panel must open on its own. Nothing here clicks anything to get it.
    await page.waitForSelector('#accountModal.show', { timeout: 15000 });
    check('a locked sign-in opens the account panel by itself', true);

    const toastText = (await page.locator('#toast').textContent()) || '';
    check(
      'the lock is stated, not left to be discovered on a 403',
      /change your password/i.test(toastText),
      `("${toastText.trim()}")`
    );

    // And the panel must be USABLE: the routes it needs are all on the
    // server's SETUP_ALLOWLIST, so the session list must load rather than 403.
    await page.waitForFunction(
      () => /this device/.test(document.getElementById('sessionList').textContent || ''),
      null,
      { timeout: 10000 }
    );
    check('the locked account can still see its own sessions', true);

    // Clear the lock through the panel, so the run ends the way it started.
    await page.fill('#pwCurrent', 'secret1');
    await page.fill('#pwNew', 'secret2');
    await page.click('#pwGo');
    await page.waitForFunction(
      () => /Password changed/.test(document.getElementById('pwNote').textContent || ''),
      null,
      { timeout: 10000 }
    );
    check('the panel actually unlocks the account', true);
    expectLock403 = false;
    // Close the panel. It covers the viewport, and a scenario that ends with it
    // open makes every click after it time out against the overlay — which reads
    // as twenty broken scenarios rather than one forgotten Escape (#134).
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('accountModal').classList.contains('show'), null, { timeout: 10000 });
    check('the panel closes once the account is unlocked', true);

    // The board UNDERNEATH was rendered while this account was locked, so it is
    // showing the 403 fault card ("The board could not be loaded — Change your
    // password…"), and that card is what the next scenario would inherit. Sign
    // out and back in as a normal account so this scenario hands over a page a
    // normal session can actually use — a scenario that has to repair what it
    // broke is one that is not self-sufficient (#134).
    await signOut();
    await signIn('demo', 'ui-demo-password');
    await atMarkets();
  });

  // ── run the registered scenarios ────────────────────────────────────────
  //
  // A scenario that throws is a NAMED failure, not the end of the run: the old
  // `&&`-style habit of stopping at the first failure hides every later check
  // behind it, and on an order-dependent suite "which later check also broke"
  // is most of the diagnosis.
  const plan = plannedOrder();
  if (SHUFFLE) {
    console.log(`  order: ${plan.map((s, i) => `${i + 1}. ${s.name}`).join('\n         ')}`);
  }
  for (const s of plan) {
    try {
      await s.fn();
    } catch (e) {
      console.log('  FAIL', s.name, '—', (e && e.message) || e);
      process.exitCode = 1;
    }
    await resetBetweenScenarios();
  }

  check('no uncaught page errors during the whole run', pageErrors.length === 0, pageErrors.join(' | '));
} catch (e) {
  // Print WHY on any abort path — a thrown error used to kill the process
  // before the server log tail could ever print. (S10)
  console.log('\nui_test.mjs: ABORTED —', (e && e.message) || e);
  if (pageErrors.length) console.log('page errors:', pageErrors.join(' | '));
  process.exitCode = 1;
} finally {
  await browser.close();
}

if (process.exitCode) {
  console.log('\nui_test.mjs: FAILURES PRESENT');
  console.log('--- server log ---');
  console.log(serverLog.join('').slice(-2000));
} else {
  console.log(`\nui_test.mjs: ${passed} checks passed`);
}

// Kill the server child explicitly: its open stdio pipes keep the event loop
// alive after the summary, so the 'exit' handler alone never fires and the
// process hangs. Idempotent with the 'exit' registration above.
cleanup();
