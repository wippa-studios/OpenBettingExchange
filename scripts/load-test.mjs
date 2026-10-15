#!/usr/bin/env node
// scripts/load-test.mjs — measure the ACTUAL ceiling, rather than asserting one.
//
// WHY THIS SHIPS. Every roadmap note about this system says the persistence
// ceiling is "unmeasured", and unmeasured is not a property, it is an absence
// of one. An operator deciding whether to run this needs a number, and a
// number nobody measured is a number they guess at — usually optimistically.
//
// The synchronous single-connection design is a genuine STRENGTH: `DatabaseSync`
// never yields, which is WHY the match sweep is inherently atomic, and 60
// concurrent orders completing in a quarter of a second is the evidence. The
// question this answers is where that stops being true, which is the only
// number that matters for capacity planning.
//
// WHAT IT DOES NOT DO: claim the engine scales horizontally. It measures one
// process, one connection, one machine. Node with a single-threaded event loop
// and a synchronous SQLite write path has a ceiling, and finding it is the
// point.
//
// Usage:
//   node scripts/load-test.mjs [--orders 500] [--concurrency 20] [--json]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const asJson = argv.includes('--json');

const TOTAL = Number(arg('orders', 500));
const CONCURRENCY = Number(arg('concurrency', 20));

// Distinct accounts so the trade rate is not one player hammering, and no
// idempotency keys so every request is a real order rather than a replay.
const PLAYERS = 25;
const results = { total: TOTAL, concurrency: CONCURRENCY, players: PLAYERS, phases: [], errors: {} };

const TMP = mkdtempSync(path.join(tmpdir(), 'obx_load_'));
const PORT = 9000 + Math.floor(Math.random() * 900);

function say(...a) { if (!asJson) console.log(...a); }

// ── Boot ───────────────────────────────────────────────────────────────────
const server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: path.join(TMP, 'load.db'),
    DRIFT_ENABLED: 'false',
    BOT_ENABLED: 'true',
    // Volume limits DISABLED so this measures the ENGINE rather than the
    // limiter. This is not hiding a constraint — the default trade limit of
    // 120/min/user is documented and the load test is a capacity measurement,
    // not a rate-limit test. A limiter that is never seen in a benchmark is a
    // limiter nobody has watched work under load.
    RATE_LIMIT_TRADE: '0',
    RATE_LIMIT_READ: '0',
    RATE_LIMIT_WALLET: '0',
    RATE_LIMIT_CASHOUT: '0',
    RATE_LIMIT_ADMIN: '0',
    // …and auth, which bounds the two KDF routes the run registers and signs
    // in through. It was added with those two routes and this list is the same
    // list: a bucket left at its default here would silently cap the run and
    // the numbers would describe the limiter instead of the engine.
    RATE_LIMIT_AUTH: '0',
    ADMIN_PASSWORD: 'load-admin-password',
    DEMO_PASSWORD: 'load-demo-password',
    SCRYPT_N: '16384',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const BASE = `http://127.0.0.1:${PORT}`;

async function waitForBoot() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not boot\n${serverLog}`);
}

function note(kind) {
  results.errors[kind] = (results.errors[kind] || 0) + 1;
}

/**
 * One measured phase. Reports throughput AND the tail, because a mean that
 * hides a 4-second p99 is worse than no number at all — an operator sizing a
 * box cares about the slow request, not the average one.
 */
async function phase(name, count, worker) {
  const lat = [];
  let done = 0;
  const t0 = performance.now();
  let cursor = 0;
  const runners = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= count) return;
      const s = performance.now();
      try { await worker(i); } catch (e) { note(name); if (!results.first_error) results.first_error = String(e.message || e); }
      lat.push(performance.now() - s);
      done++;
    }
  });
  await Promise.all(runners);
  const elapsed = (performance.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0);
  const p = {
    phase: name, requests: done, seconds: +elapsed.toFixed(3),
    rps: +(done / elapsed).toFixed(1),
    p50_ms: +pct(0.5).toFixed(1), p95_ms: +pct(0.95).toFixed(1), p99_ms: +pct(0.99).toFixed(1),
    max_ms: +(lat[lat.length - 1] || 0).toFixed(1),
  };
  results.phases.push(p);
  say(`  ${name.padEnd(18)} ${String(done).padStart(5)} req  ${String(p.rps).padStart(8)} rps  ` +
      `p50 ${String(p.p50_ms).padStart(6)}ms  p95 ${String(p.p95_ms).padStart(7)}ms  p99 ${String(p.p99_ms).padStart(7)}ms  max ${p.max_ms}ms`);
  return p;
}

async function json(pathname, init) {
  const r = await fetch(BASE + pathname, init);
  if (!r.ok) throw new Error(`${pathname} -> ${r.status}`);
  return r.json();
}

const post = (pathname, body, cookie) =>
  json(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), origin: BASE },
    body: JSON.stringify(body),
  });
const get = (pathname, cookie) => json(pathname, { headers: { ...(cookie ? { cookie } : {}), origin: BASE } });

async function main() {
  await waitForBoot();
  say(`\n  OpenBettingExchange load test — ${TOTAL} orders, ${CONCURRENCY} concurrent, ${PLAYERS} players`);
  say('  Single process, single SQLite connection. Measuring the ceiling, not claiming scale.\n');

  // ── Setup ────────────────────────────────────────────────────────────────
  const adminCookie = (await post('/api/auth/login', { username: 'admin', password: 'load-admin-password' }));
  void adminCookie;
  // Register players and sign them in. Register is the slow part (scrypt), so
  // it is done BEFORE the measured phases and never counted against them.
  const cookies = [];
  // Registered accounts open at zero, and an order with no escrow is refused
  // — correctly. Fund each player through their own faucet so the load phase
  // measures the ENGINE rather than the first failure it walks into. (The
  // first version of this script swallowed the resulting 400s as "errors"
  // and reported a FAIL that had nothing to do with throughput.)
  const FUND_CENTS = 90000; // under the default FAUCET_MAX_CENTS of 100000
  for (let i = 0; i < PLAYERS; i++) {
    const name = `load${i}`;
    await post('/api/auth/register', { username: name, password: 'load-player-password' });
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ username: name, password: 'load-player-password' }),
    });
    const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    cookies.push(cookie);
    await post('/api/wallet/deposit', { amount_cents: FUND_CENTS }, cookie);
  }
  const events = await get('/api/events');
  const market = events.events[0].markets[0];
  const selId = market.selections[0].selection_id;
  // A ladder of distinct prices so orders spread across levels rather than
  // all queueing on one — a single hot level measures lock contention, not
  // throughput.
  const prices = [1.8, 2.0, 2.2, 2.4, 2.6];
  say(`  seeded ${PLAYERS} players · market ${market.id} · selection ${selId}\n`);

  // ── Phases ───────────────────────────────────────────────────────────────
  await phase('order-place', TOTAL, async (i) => {
    const c = cookies[i % cookies.length];
    await post('/api/orders', {
      selection_id: selId,
      side: 'back',
      price: prices[i % prices.length],
      stake_cents: 100,
    }, c);
  });

  await phase('order-read', TOTAL, async (i) => {
    await get('/api/orders', cookies[i % cookies.length]);
  });

  await phase('book-read', Math.max(200, Math.floor(TOTAL / 2)), async () => {
    await get(`/api/markets/${market.id}/book`);
  });

  await phase('wallet-read', Math.max(200, Math.floor(TOTAL / 2)), async (i) => {
    await get('/api/wallet', cookies[i % cookies.length]);
  });

  // Position + cash-out quote: the read-heavy path the UI hits constantly.
  await phase('positions', Math.max(200, Math.floor(TOTAL / 2)), async (i) => {
    await get('/api/positions', cookies[i % cookies.length]);
  });

  // ── Integrity after the load ─────────────────────────────────────────────
  // A throughput number is worthless if the books are wrong afterwards, so the
  // invariant is re-checked against the same file the load just wrote.
  const { execFileSync } = await import('node:child_process');
  const integrity = JSON.parse(execFileSync(process.execPath, ['-e', `
    const {openStore}=require('./lib/store');
    const acc=require('./lib/accounts');
    const db=openStore(process.env.DB_PATH);
    console.log(JSON.stringify({
      conserved: acc.assertConserved(db),
      divergent: acc.assertUserAgrees(db).length,
      orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
    }));
  `], { cwd: ROOT, env: { ...process.env, DB_PATH: path.join(TMP, 'load.db') }, encoding: 'utf8' }));

  results.integrity = integrity;
  const totalErrors = Object.values(results.errors).reduce((a, b) => a + b, 0);
  results.total_errors = totalErrors;
  results.verdict = integrity.conserved === 0 && integrity.divergent === 0 && totalErrors === 0
    ? 'PASS' : 'FAIL';

  say(`\n  integrity after load: conserved=${integrity.conserved} cache_divergent=${integrity.divergent} orders=${integrity.orders}`);
  say(`  errors: ${totalErrors === 0 ? 'none' : JSON.stringify(results.errors)}`);
  say(`  verdict: ${results.verdict}\n`);

  if (asJson) console.log(JSON.stringify(results, null, 2));
  process.exitCode = results.verdict === 'PASS' ? 0 : 1;
}

try {
  await main();
} catch (e) {
  console.error('\n  load test aborted:', e.message);
  if (!asJson) console.error(serverLog.split('\n').slice(-12).join('\n'));
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  rmSync(TMP, { recursive: true, force: true });
}