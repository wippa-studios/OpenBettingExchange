// scripts/shoot.mjs — regenerate the documentation screenshots.
//
// Run:  node scripts/shoot.mjs
//
// The seven PNGs under docs/ had aged out of the truth: they were captured
// before the sport filter moved from a header bar into the left rail, so the
// README's own picture contradicted its own text. This regenerates them against
// the CURRENT UI and, more importantly, refuses to save a screenshot it has not
// verified: every capture is preceded by DOM assertions that the thing worth
// showing is actually on screen. A screenshot of an empty board is worse than
// no screenshot, because it looks like evidence.
//
// Two passes:
//   pass 1  seeded mode   — demo catalogue, bots quoting, the full product
//   pass 2  feed mode     — the board reading a REAL Betfair collector
//
// Everything is driven through the public UI exactly as a user would drive it,
// but STATE is prepared through the API first (a deposit, a placed order),
// because the point of the wallet and positions shots is the content, not the
// clicking.
//
// Output: 2x device scale (2880x1800 for a 1440x900 viewport), matching the
// existing assets. No private data is captured: this database is created fresh
// for the run and thrown away.

import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/scripts$/, '');
const SHOTS = join(ROOT, 'docs', 'shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let shots = 0;
let assertions = 0;

/** Assert, or abort the whole run: a wrong screenshot is worse than none. */
function must(cond, what) {
  assertions++;
  if (!cond) throw new Error(`before capturing: ${what}`);
}

async function cap(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
  shots++;
  console.log(`  shot  ${name}.png`);
}

/** A free port, by binding and releasing — same trick as the browser suite. */
async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

function startServer(env) {
  const srv = spawn('node', ['--no-warnings', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
  return srv;
}

async function waitUp(base, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/api/sports`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error('server never came up');
}

const j = async (base, method, path, { body, cookie } = {}) => {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, setCookie, cookie: (setCookie.find((c) => c.startsWith('ob_session=')) || '').split(';')[0] };
};

/** Sign in through the real modal, so the header shows the signed-in state. */
async function signIn(page, base, user, pass) {
  await page.goto(base);
  // #authBtn is a TOGGLE: "Sign in" when signed out, "Sign out" when signed
  // in. Signing in over an existing session therefore has to sign OUT first,
  // or the click logs the player out and the modal never appears.
  if ((await page.locator('#authBtn').textContent()).trim() === 'Sign out') {
    await page.locator('#authBtn').click();
    await page.waitForFunction(
      () => (document.getElementById('authBtn')?.textContent || '').trim() === 'Sign in',
      null,
      { timeout: 6000 }
    );
  }
  await page.locator('#authBtn').click();
  await page.fill('#authUser', user);
  await page.fill('#authPass', pass);
  await page.click('#authGo');
  // `.show`, NOT `[open]`. #authModal is a <div>, not a <dialog> — it carries no
  // `open` property at all, so `!document.querySelector('#authModal')?.open`
  // was `!undefined` = true from the very first poll. The wait therefore
  // returned instantly, before the login had been through fetch(), and the
  // captures downstream were of a half-rendered board. core.js openOverlay
  // shows and hides overlays with the `.show` class, which is what this must
  // wait on (the #accountModal wait below already said so in a comment).
  await page.waitForFunction(() => !document.querySelector('#authModal.show'), null, { timeout: 8000 });
  // …and it is only a real wait if the modal was actually OPEN when we started
  // waiting. Otherwise the predicate is vacuously true and the whole step is a
  // no-op — the exact class of bug this line used to be.
  must(await page.locator('#authBtn').textContent().then((t) => t.trim() === 'Sign out'), 'the sign-in completed');
}

/**
 * Tripwire: the browser is the only place the frontend's errors exist, and a
 * page error or a console.error leaves the UI looking merely quiet rather than
 * broken — the screenshots still capture, the run still passes. Before this,
 * the only 'console' output in the whole run was this script's own console.log,
 * so nothing in the browser was being watched at all.
 *
 * Collected, not thrown, so the run finishes and reports every fault; the
 * assertions below turn any of them into a failure.
 */
/**
 * Tripwire: the browser is the only place the frontend's errors exist, and a
 * page error or a console.error leaves the UI looking merely quiet rather than
 * broken — the screenshots still capture, the run still passes. Before this,
 * the only 'console' output in the whole run was this script's own console.log,
 * so nothing in the browser was being watched at all.
 *
 * Collected, not thrown, so the run finishes and reports every fault;
 * assertNoFaults below turns any of them into a failure.
 *
 * Calibrated so it FAILS on real faults and stays quiet on designed ones.
 * A tripwire that fires on every run is a tripwire people switch off, and this
 * one has to earn its keep:
 *
 *   · an uncaught exception, and any console.error the APP ITSELF wrote — never
 *     suppressed. That is the app saying something is wrong.
 *   · an HTTP 4xx Chrome reports as "Failed to load resource" — suppressed.
 *     These are answers the app asked for and handled: core.js probes /api/me
 *     on every boot and a signed-out 401 is that endpoint working. A 5xx is
 *     NOT suppressed, because a server error is never designed.
 *   · net::ERR_ABORTED on a request — suppressed. That is a cancellation (the
 *     SSE stream at /api/stream being torn down on sign-out or navigation),
 *     not a failure. Every OTHER request failure still trips.
 */
function watchBrowser(page) {
  const faults = [];
  const CHROME_4XX = /^Failed to load resource: the server responded with a status of 4\d\d\b/;
  page.on('pageerror', (e) => faults.push(`pageerror: ${e && e.message ? e.message : e}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (/favicon/i.test(text)) return;
    if (CHROME_4XX.test(text)) return;
    const at = m.location() && m.location().url ? ` <${m.location().url}>` : '';
    faults.push(`console.${m.type()}: ${text}${at}`);
  });
  page.on('requestfailed', (r) => {
    if (/favicon/i.test(r.url())) return;
    const err = (r.failure() && r.failure().errorText) || 'unknown';
    if (err === 'net::ERR_ABORTED') return;
    faults.push(`requestfailed: ${r.url()} — ${err}`);
  });
  return faults;
}

/** Must be called before browser.close(), or there is nothing left to read. */
function assertNoFaults(faults, where) {
  if (faults.length) {
    throw new Error(
      `browser reported ${faults.length} error(s) during ${where}:\n  ${faults.join('\n  ')}`
    );
  }
  assertions++;
}

// ── pass 1: seeded mode ──────────────────────────────────────────────────────

async function seededPass() {
  console.log('\npass 1 — seeded mode');
  const db = join(tmpdir(), `ob-shots-${process.pid}.db`);
  rmSync(db, { force: true });

  await new Promise((resolve, reject) => {
    const seed = spawn('node', ['--no-warnings', 'lib/seed.js'], {
      cwd: ROOT,
      env: { ...process.env, DB_PATH: db, SCRYPT_N: '16384' },
      stdio: 'inherit',
    });
    seed.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`seed exited ${c}`))));
  });

  const PORT = await freePort();
  const base = `http://127.0.0.1:${PORT}`;
  const srv = startServer({
    DB_PATH: db,
    PORT: String(PORT),
    SCRYPT_N: '16384',
    BOT_ENABLED: 'true',
    DRIFT_ENABLED: 'true',
  });

  try {
    await waitUp(base);
    const browser = await chromium.launch();
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    const faults = watchBrowser(page);

    // STATE, via the API, so the wallet and positions shots have real content.
    //
    // The seeded demo and admin accounts are behind the first-run password
    // change wall — a real deployment detail, and exactly the wrong thing to
    // have popping a modal open over a screenshot. So the player shots use a
    // FRESHLY REGISTERED user (no wall), and the admin shots change the admin
    // password through the allowlisted route first, then sign in with it.
    const PLAYER = { username: 'jordan', password: 'shots-Player-1' };
    const reg = await j(base, 'POST', '/api/auth/register', { body: PLAYER });
    must(reg.status === 200 || reg.status === 201, `register the player (got ${reg.status})`);
    const player = await j(base, 'POST', '/api/auth/login', { body: PLAYER });
    must(player.status === 200, 'player login for state setup');

    const deposit = await j(base, 'POST', '/api/wallet/deposit', {
      cookie: player.cookie,
      body: { amount_cents: 50000 }, // $500 — under the $1000 faucet cap
    });
    must(deposit.status === 200, `faucet deposit (got ${deposit.status} ${JSON.stringify(deposit.json || {})})`);

    // A resting order on the first market's first selection, so Positions has
    // exposure, escrow and an if-win number to show.
    const events = (await (await fetch(`${base}/api/events`)).json()).events;
    must(Array.isArray(events) && events.length, 'a seeded catalogue');
    const market = events[0].markets?.[0];
    must(market, 'a market on the first event');
    // /api/events already embeds each market's selections, so there is no
    // second fetch to get one.
    const sel = market.selections?.[0];
    must(sel, 'a selection on the first market');
    const order = await j(base, 'POST', '/api/orders', {
      cookie: player.cookie,
      body: { market_id: market.id, selection_id: sel.selection_id, side: 'back', price: 1.01, stake_cents: 2000, client_order_id: `shots-${Date.now()}` },
    });
    must(order.status === 200 || order.status === 201, `placing a demo order (got ${order.status} ${JSON.stringify(order.json || {})})`);

    // Unlock the seeded admin account through the one route a locked account
    // can still reach, then keep the new password for the UI sign-in below.
    const ADMIN_PASS = 'shots-Desk-9';
    const adm = await j(base, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    must(adm.status === 200, 'admin login for the password change');
    const changed = await j(base, 'POST', '/api/auth/change-password', {
      cookie: adm.cookie,
      body: { currentPassword: 'admin123', newPassword: ADMIN_PASS },
    });
    must(changed.status === 200, `admin password change (got ${changed.status} ${JSON.stringify(changed.json || {})})`);

    // 1. THE BOARD — the hero. Signed in, left rail visible, ladders rendered.
    await signIn(page, base, PLAYER.username, PLAYER.password);
    await page.waitForSelector('#sportsList .chip', { timeout: 10_000 });
    must(await page.locator('#sportsList .chip').count() >= 2, 'the sport rail renders');
    must((await page.locator('.card').count()) >= 1, 'event cards on the board');
    await page.waitForFunction(() => document.querySelectorAll('[data-bet="1"]').length >= 6, null, { timeout: 10_000 });
    must(true, 'priced ladder cells rendered');
    await sleep(700); // let price-change flashes settle, so the shot is calm
    await cap(page, 'board');

    // 2. THE BET SLIP — a price clicked, the slip open with that side and price.
    const cell = page.locator('[data-bet="1"][data-side="back"]').first();
    must(await cell.count() >= 1, 'a priced back cell to click');
    await cell.click();
    await page.waitForSelector('#slip:not([hidden])', { timeout: 6000 });
    must((await page.locator('#slipBody').textContent()).length > 0, 'the slip has a selection in it');
    await cap(page, 'betslip');

    // 3. POSITIONS — the matched order's exposure. The Bets page opens on the
    //    "Open orders" tab, and a fully-matched order leaves nothing resting
    //    there — so the Positions tab must be clicked, and the capture asserted
    //    on rows actually being present rather than on the empty state.
    await page.locator('[data-page="bets"]').click();
    await page.locator('[data-tab="positions"]').click();
    await page.waitForFunction(() => {
      const body = document.getElementById('betsBody');
      const t = body && body.textContent;
      return !!t && !/Loading/.test(t) && !/No matched positions/.test(t);
    }, null, { timeout: 8000 });
    await cap(page, 'positions');

    // 4. WALLET — the ledger rows from the deposit and the escrow.
    await page.locator('[data-page="wallet"]').click();
    await page.waitForFunction(() => {
      const p = document.getElementById('page');
      return p && /ledger|transaction|available/i.test(p.textContent) && p.textContent.length > 200;
    }, null, { timeout: 8000 });
    must(/frozen|escrow/i.test(await page.locator('#page').textContent()), 'escrow is shown');
    await cap(page, 'wallet');

    // 5. ACCOUNT — sessions, password change, RG controls.
    await page.locator('#accountBtn').click();
    // Overlays open with a .show class (core.js openOverlay), not the [open]
    // attribute — waiting for [open] times out on a modal that IS on screen.
    await page.waitForSelector('#accountModal.show', { timeout: 6000 });
    await cap(page, 'account');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#accountModal.show'), null, { timeout: 4000 });

    // 6 + 7. THE ADMIN DESK — markets (with live book stats) and users.
    await signIn(page, base, 'admin', ADMIN_PASS);
    await page.waitForSelector('#navAdmin:not([hidden])', { timeout: 8000 });
    await page.locator('#navAdmin').click();
    await page.waitForSelector('#adminBody', { timeout: 8000 });
    await page.waitForFunction(() => document.getElementById('adminBody')?.textContent.length > 100, null, { timeout: 8000 });
    await cap(page, 'admin-markets');

    must(await page.locator('[data-view="users"]').count() > 0, 'a users view tab to click');
    await page.locator('[data-view="users"]').click();
    await page.waitForFunction(() => /demo|admin/i.test(document.getElementById('adminBody')?.textContent || ''), null, { timeout: 8000 });
    await cap(page, 'admin-users');

    // The tripwire fires LAST, after every capture, so a fault anywhere in the
    // run — including a sign-in that silently threw — fails the run instead of
    // quietly shipping a screenshot of a broken page.
    assertNoFaults(faults, 'the seeded pass');

    await browser.close();
    rmSync(db, { force: true });
  } finally {
    srv.kill('SIGTERM');
  }
}

// ── pass 2: feed mode, against a real collector ────────────────────────────

async function feedPass() {
  console.log('\npass 2 — feed mode (real Betfair data)');
  const feedUrl = process.env.FEED_DATABASE_URL;
  if (!feedUrl) {
    console.log('  FEED_DATABASE_URL is not set — skipping the feed hero shot');
    return;
  }
  const db = join(tmpdir(), `ob-feedshots-${process.pid}.db`);
  rmSync(db, { force: true });

  const PORT = await freePort();
  const base = `http://127.0.0.1:${PORT}`;
  const srv = startServer({
    DB_PATH: db,
    PORT: String(PORT),
    SCRYPT_N: '16384',
    FEED_ENABLED: 'true',
    FEED_DATABASE_URL: feedUrl,
    FEED_STALE_SECONDS: '3600',
    BOT_ENABLED: 'false',
    DRIFT_ENABLED: 'false',
  });

  try {
    await waitUp(base);
    const browser = await chromium.launch();
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    const faults = watchBrowser(page);
    await page.goto(base);

    // In FEED mode the rail renders the deep nav tree, not the seeded sport
    // chips — renderSidebar() owns the rail here. Waiting for .chip would time
    // out on a rail that is working exactly as designed.
    await page.waitForSelector('#sidebar .treeitem.sport', { timeout: 20_000 });

    // The tree arrives ALREADY EXPANDED: loadNav() drills the first chain on
    // boot, and that chain's meeting is the one whose races start soonest —
    // which in practice means markets the odds job has already retired.
    // Measured: every race leaf in the boot meeting rendered 'No liquidity in
    // the latest frame' while 9,456 of 9,982 markets carry prices.
    //
    // So the capture navigates the way a user would: SEARCH for a match that
    // is known to have prices. The search index is the board itself, which is
    // ordered by book freshness — asking it for the first market with a real
    // ladder and searching for that fixture's name lands on live prices.
    const board = await (await fetch(`${base}/api/feed/board?limit=60`)).json();
    const pricedMarket = (board.markets || []).find(
      (m) => (m.selections || []).some((sel) => (sel.back || []).length + (sel.lay || []).length > 0)
    );
    must(pricedMarket, 'the feed board returned a market with a real ladder');
    const term = (pricedMarket.event_name || '').split(' v ')[0];
    must(term && term.length >= 2, `a searchable term (got ${JSON.stringify(term)})`);

    await page.fill('#globalSearch', term);
    await page.waitForSelector('#searchResults .srow', { timeout: 10_000 });
    await page.locator('#searchResults .srow').first().click();
    await page.waitForFunction(() => document.querySelectorAll('[data-bet="1"]').length >= 6, null, { timeout: 15_000 });

    // This is the one shot whose numbers are real Betfair's, so it is asserted
    // hardest: priced cells, an expanded tree, and no empty-state text.
    const priced = await page.evaluate(() => document.querySelectorAll('[data-bet="1"]').length);
    must(priced >= 6, `feed ladder cells rendered (got ${priced})`);
    must(
      (await page.locator('#sidebar .treeitem.race').count()) > 0,
      'the tree expanded to race leaves'
    );
    const pageText = await page.locator('#page').textContent();
    must(!/pick a race|no open events/i.test(pageText), 'the board is showing a market, not an empty state');
    await sleep(700);
    await cap(page, 'feed-board');

    assertNoFaults(faults, 'the feed pass');

    await browser.close();
    rmSync(db, { force: true });
  } finally {
    srv.kill('SIGTERM');
  }
}

await seededPass();
await feedPass();

console.log(`\n${shots} screenshots, ${assertions} DOM assertions, all verified`);
if (!shots) {
  console.error('no screenshots captured');
  process.exit(1);
}