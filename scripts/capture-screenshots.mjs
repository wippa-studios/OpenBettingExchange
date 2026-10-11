// scripts/capture-screenshots.mjs
//
// Regenerates every image in docs/ from a real seeded server. The committed
// screenshots are build output like any other: if the UI changes and they are
// not re-captured, the README starts lying, which is the one thing a
// screenshot is worse than not having.
//
//   npm run shots
//
// Deliberately NOT part of `npm test`. It needs Playwright's Chromium, takes
// ~20s, and produces no assertions — tests/ui_test.mjs is what actually
// verifies the UI.
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DOCS = path.join(ROOT, 'docs');
const SHOTS = path.join(DOCS, 'shots');

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = mkdtempSync(path.join(tmpdir(), 'ob-shots-'));

// A throwaway database every run, so the images reflect the current seed and
// never depend on — or mutate — data/openbettingexchange.db.
const server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: path.join(TMP, 'shots.db') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (b) => serverLog.push(String(b)));
server.stderr.on('data', (b) => serverLog.push(String(b)));

const cleanup = () => {
  try { server.kill(); } catch { /* already gone */ }
  // The child's stdio pipes keep this process's event loop alive after the work
  // is done, so the script would hang forever instead of exiting. Unref and
  // destroy them explicitly — same reason tests/ui_test.mjs kills its child by
  // hand rather than trusting the 'exit' handler alone.
  try { server.stdout.destroy(); server.stderr.destroy(); server.unref(); } catch { /* best effort */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/sports`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up\n' + serverLog.join(''));
}

const signIn = async (page, username, password) => {
  await page.click('#authBtn');
  await page.waitForSelector('#authModal.show', { timeout: 10000 });
  await page.fill('#authUser', username);
  await page.fill('#authPass', password);
  await page.click('#authGo');
  await page.waitForSelector('#balance:not([hidden])', { timeout: 15000 });
};

const signOut = async (page) => {
  await page.click('#authBtn');
  await page.waitForFunction(() => document.getElementById('authBtn').textContent === 'Sign in', null, { timeout: 15000 });
};

let failed = false;
try {
  await waitForServer();
  // Seed the catalogue, then let the bots quote so the board is not empty.
  execSync(`node --no-warnings lib/seed.js`, { cwd: ROOT, env: { ...process.env, DB_PATH: path.join(TMP, 'shots.db') } });
  await new Promise((r) => setTimeout(r, 2500)); // bot quoting pass

  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  const shot = async (name, opts = {}) => {
    const file = name === 'board' ? path.join(DOCS, 'screenshot.png') : path.join(SHOTS, `${name}.png`);
    await page.screenshot({ path: file, ...opts });
    console.log('  captured', path.relative(ROOT, file));
  };

  // ── the board, signed out (the README hero) ──────────────────────────
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.ladder button.lcell[data-bet]', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 600));
  await shot('board');

  // ── player journey ────────────────────────────────────────────────────
  await signIn(page, 'demo', 'demo123');

  // Place a couple of bets so Positions has real content.
  for (const i of [0, 1]) {
    const cell = page.locator('.ladder .lcell[data-bet]').nth(i * 3);
    await cell.click();
    await page.waitForSelector('#slip:not([hidden]) .sliprow', { timeout: 10000 });
    await page.fill('#slip input[data-stake]', '25');
    await page.dispatchEvent('#slip input[data-stake]', 'change');
    await page.click('#slip button.place');
    await page.waitForFunction(
      () => /Matched|Resting/.test((document.getElementById('toast') || {}).textContent || ''),
      null,
      { timeout: 15000 }
    );
    await page.waitForFunction(() => document.getElementById('slip').hidden, null, { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 300));
  }

  // Bet slip, still open, with a price selected — shows the stake/price UI.
  await page.locator('.ladder .lcell[data-bet]').nth(2).click();
  await page.waitForSelector('#slip:not([hidden]) .sliprow', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));
  await shot('betslip');
  await page.keyboard.press('Escape');

  await page.click('#nav button[data-page="bets"]');
  await page.waitForSelector('#betsBody', { timeout: 10000 });
  await page.click('[data-tab="positions"]');
  await page.waitForSelector('#betsBody .poscard, #betsBody .empty', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 500));
  await shot('positions');

  await page.click('#nav button[data-page="wallet"]');
  await page.waitForSelector('#wBal', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#wTx table, #wTx .empty'), null, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 400));
  await shot('wallet');

  // Account panel: sessions, password form.
  await page.click('#accountBtn');
  await page.waitForSelector('#accountModal.show', { timeout: 10000 });
  await page.waitForFunction(
    () => /this device/.test(document.getElementById('sessionList').textContent || ''),
    null,
    { timeout: 15000 }
  );
  await new Promise((r) => setTimeout(r, 400));
  await shot('account');
  await page.keyboard.press('Escape');

  // ── admin desk ────────────────────────────────────────────────────────
  await signOut(page);
  await signIn(page, 'admin', 'admin123');
  await page.click('#nav button[data-page="admin"]');
  await page.waitForSelector('#adminBody table', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 400));
  await shot('admin-markets');

  // Users tab.
  await page.click('[data-view="users"]');
  await page.waitForSelector('#adminBody .adm-tbl tbody tr', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 400));
  await shot('admin-users');

  // Give the audit tab something real to show: suspend, then reinstate, a
  // balance adjustment, and a promotion — so the image is not an empty table.
  //
  // Both actions drive window.prompt, and the balance flow asks for the AMOUNT
  // and then the REASON — two dialogs, not one. A single `once` handler leaves
  // the second prompt to be auto-dismissed, which makes the action a silent
  // no-op and the following wait time out. One queue drains both in order.
  const answers = ['25', 'goodwill credit', 'chargeback under review'];
  const onDialog = (d) => d.accept(answers.length ? answers.shift() : '');
  page.on('dialog', onDialog);

  await page.locator('#adminBody [data-act="balance"]').first().click();
  await page.waitForFunction(
    () => /Done/.test((document.getElementById('toast') || {}).textContent || ''),
    null,
    { timeout: 15000 }
  );
  await page.waitForSelector('#adminBody .adm-tbl tbody tr', { timeout: 15000 });
  await page.locator('#adminBody [data-act="suspend"]').first().click();
  await page.waitForFunction(
    () => /Done/.test((document.getElementById('toast') || {}).textContent || ''),
    null,
    { timeout: 15000 }
  );
  page.off('dialog', onDialog);

  await page.click('[data-view="audit"]');
  await page.waitForSelector('#adminBody .adm-tbl tbody tr', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 400));
  await shot('admin-audit');

  await browser.close();
  console.log('\nscreenshots: done');
} catch (e) {
  failed = true;
  console.error('\nscreenshots: FAILED —', e && e.message);
  console.error(serverLog.join('').slice(-2000));
  process.exitCode = 1;
} finally {
  cleanup();
}

if (failed) process.exitCode = 1;