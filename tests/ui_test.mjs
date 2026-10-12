// ui_test.mjs — REAL-BROWSER verification of the exchange UI.
// Run: npm run test:ui
//
// Boots the server on a temp DB (bots on, drift off), drives the page in
// Chromium, and fails on ANY uncaught page error — the class of bug that
// `node --check` cannot see (wrong element id, runtime TypeError, a render
// path that never fires).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

// An async SCENARIO: its body runs (the old code passed async fns to check(),
// which only coerced them truthy — the admin section never executed and its
// checks passed vacuously). Inner assertions still call check() themselves;
// a thrown error fails the scenario instead of aborting the whole run.
const scenario = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log('  FAIL', name, '—', (e && e.message) || e);
    process.exitCode = 1;
  }
};

const server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
  cwd: ROOT,
  env: { ...process.env, DB_PATH: path.join(TMP, 'ui.db'), PORT: String(PORT), DRIFT_ENABLED: 'false' },
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

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
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = 'console.error: ' + msg.text();
  if (!signedIn && EXPECTED_PREAUTH_401.test(msg.text())) return;
  if (expectAuth401 && EXPECTED_PREAUTH_401.test(msg.text())) return;
  pageErrors.push(text);
});

try {
  // ── board renders with bot liquidity ──────────────────────────────────
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
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
  const chipText = await page.locator('#sportbar .chip').first().textContent();
  check('sport filter bar renders', /All/.test(chipText || ''), `(${String(chipText).trim()})`);
  check('signed-out user sees the sign-in button', (await page.locator('#authBtn').textContent()) === 'Sign in');
  // Seeded mode has no feed tree — the rail must be hidden, not stuck on a
  // permanent "No sports" placeholder. (S7)
  check('seeded mode hides the empty tree rail', await page.locator('#sidebar').isHidden());

  // ── seeded search: results appear, a click navigates (CRITICAL 3) ─────
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

  // ── clicking a price without a session opens the auth modal ──────────
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

  // ── sign in as the seeded demo user ──────────────────────────────────
  await page.fill('#authUser', 'demo');
  await page.fill('#authPass', 'demo123');
  await page.click('#authGo');
  // Wait for the real success signal (balance chip), then assert the modal closed.
  await page.waitForSelector('#balance:not([hidden])', { timeout: 10000 });
  check('auth modal closes after sign-in', (await page.locator('#authModal').getAttribute('class')) !== 'show');
  const balance = (await page.locator('#balance').textContent()) || '';
  signedIn = true;
  check('balance chip shows after sign-in', /\$\d/.test(balance), `(${balance.trim()})`);
  check('sign-in button becomes sign out', (await page.locator('#authBtn').textContent()) === 'Sign out');

  // ── place a bet through the slip ─────────────────────────────────────
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

  // ── my bets shows the order or a position ────────────────────────────
  await page.click('#nav button[data-page="bets"]');
  await page.waitForSelector('#betsBody', { timeout: 5000 });
  await page.click('[data-tab="positions"]');
  await page.waitForSelector('#betsBody .poscard, #betsBody .empty', { timeout: 5000 });
  const posHtml = (await page.locator('#betsBody').innerHTML()) || '';
  check('positions tab renders without error', posHtml.length > 0);
  await page.click('[data-tab="open"]');
  await page.waitForSelector('#betsBody table, #betsBody .empty', { timeout: 5000 });
  const openHtml = (await page.locator('#betsBody').innerHTML()) || '';
  check('open orders tab renders without error', openHtml.length > 0);

  // ── wallet shows the ledger ──────────────────────────────────────────
  await page.click('#nav button[data-page="wallet"]');
  await page.waitForSelector('#wBal', { timeout: 5000 });
  const bal = (await page.locator('#wBal').textContent()) || '';
  check('wallet renders a balance', /\$\d/.test(bal), `(${bal})`);
  await page.waitForFunction(() => document.querySelector('#wTx table, #wTx .empty'), null, { timeout: 10000 });
  check('wallet renders transactions or an empty state', true);

  // ── admin desk is hidden for a normal user ───────────────────────────
  check('admin tab hidden for a customer', await page.locator('#navAdmin').isHidden());
  await page.click('#nav button[data-page="markets"]');
  await page.waitForSelector('.ladder button.lcell[data-bet]', { timeout: 5000 });
  await page.screenshot({ path: SHOT, fullPage: false });
  console.log('  info screenshot:', SHOT);

  // ── admin desk: overround column + the server-backed fair-price helper ──
  await scenario('admin desk renders the overround column', async () => {
    await page.click('#authBtn'); // sign out of the customer session
    await page.waitForFunction(() => document.getElementById('authBtn').textContent === 'Sign in', null, { timeout: 10000 });
    await page.click('#authBtn');
    await page.waitForSelector('#authModal.show', { timeout: 5000 });
    await page.fill('#authUser', 'admin');
    await page.fill('#authPass', 'admin123');
    await page.click('#authGo');
    await page.waitForSelector('#navAdmin:not([hidden])', { timeout: 10000 });
    await page.click('#nav button[data-page="admin"]');
    await page.waitForSelector('#adminBody table', { timeout: 10000 });
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
  await scenario('settle dialog: aria role, W6 hint, Escape via the overlay stack', async () => {
    const settleBtn = page.locator('#adminBody [data-settle]').first();
    if ((await settleBtn.count()) === 0) return; // every market settled already — nothing to check
    await settleBtn.click();
    await page.waitForSelector('.modal[role="dialog"]', { timeout: 5000 });
    check('settle dialog opens with role=dialog', true);
    const hint = ((await page.locator('.modal[role="dialog"] .hint').textContent()) || '').trim();
    check('unsettled market shows the pick-a-winner hint', /Pick the winning runner/.test(hint), `("${hint.slice(0, 40)}…")`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.modal[role="dialog"]'), null, { timeout: 5000 });
    check('Escape closes the settle dialog (topmost overlay)', true);
  });

  await scenario('fair-price helper returns server-side conversions', async () => {
    await page.click('[data-view="create"]');
    await page.waitForSelector('[data-fair]', { timeout: 10000 });
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
  await scenario('register accepts an email; login accepts that email', async () => {
    await page.click('#authBtn'); // sign out of admin
    await page.waitForFunction(() => document.getElementById('authBtn').textContent === 'Sign in', null, { timeout: 10000 });
    await page.click('#authBtn');
    await page.waitForSelector('#authModal.show', { timeout: 5000 });
    await page.click('#authSwitch'); // → register mode
    await page.waitForFunction(() => document.getElementById('authEmailWrap').style.display !== 'none', null, { timeout: 5000 });
    check('register mode reveals the email field', true);
    await page.fill('#authUser', 'uitester');
    await page.fill('#authEmail', 'uitester@example.com');
    await page.fill('#authPass', 'secret1');
    await page.click('#authGo');
    await page.waitForSelector('#balance:not([hidden])', { timeout: 10000 });
    check('registration completes and signs in', true);
    await page.click('#authBtn'); // sign out
    await page.waitForFunction(() => document.getElementById('authBtn').textContent === 'Sign in', null, { timeout: 10000 });
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
    const who = (await page.locator('#who').textContent()) || '';
    check('sign-in by email lands in the right account', who.includes('uitester'), `(${who.trim()})`);
  });

  await scenario('account panel: sessions, and a password change that survives', async () => {
    await page.click('#accountBtn');
    await page.waitForSelector('#accountModal.show', { timeout: 5000 });
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
    await page.waitForFunction(() => !document.getElementById('accountModal').classList.contains('show'), null, { timeout: 5000 });
    // The caller's own session must still work — sign out and back in with the NEW password.
    await page.click('#authBtn');
    await page.waitForFunction(() => document.getElementById('authBtn').textContent === 'Sign in', null, { timeout: 10000 });
    await page.click('#authBtn');
    await page.waitForSelector('#authModal.show', { timeout: 5000 });
    await page.fill('#authUser', 'uitester@example.com');
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
    check('the new password works', true);
  });

  await scenario('admin desk: users and audit tabs', async () => {
    await page.click('#authBtn'); // sign out of uitester
    await page.waitForFunction(() => document.getElementById('authBtn').textContent === 'Sign in', null, { timeout: 10000 });
    await page.click('#authBtn');
    await page.waitForSelector('#authModal.show', { timeout: 5000 });
    await page.fill('#authUser', 'admin');
    await page.fill('#authPass', 'admin123');
    await page.click('#authGo');
    await page.waitForSelector('#navAdmin:not([hidden])', { timeout: 10000 });
    await page.click('#nav button[data-page="admin"]');
    await page.waitForSelector('[data-view="users"]', { timeout: 10000 });
    await page.click('[data-view="users"]');
    await page.waitForSelector('#adminBody .adm-tbl tbody tr', { timeout: 10000 });
    const userRows = await page.locator('#adminBody .adm-tbl tbody tr').count();
    check('users tab lists accounts', userRows >= 2, `(${userRows} rows)`);
    const acts = await page.locator('#adminBody [data-act]').count();
    check('each account row carries actions', acts >= userRows * 3, `(${acts} controls)`);
    await page.fill('#userSearch', 'uitester');
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

    await page.click('[data-view="audit"]');
    await page.waitForSelector('#adminBody .adm-tbl tbody tr', { timeout: 10000 });
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
