'use strict';
// tests/feed-hygiene.test.js — six small defects in the feed stack (#64).
//
// Run: node tests/feed-hygiene.test.js   (plain assert, no deps)
//
// Each check below names the defect it covers in its own failure message, and
// the harness reports EVERY failure rather than exiting at the first — the
// sibling suite resultsfeed-signal-shape.test.js exits on its first failure, so
// in a naive run one red check hides every check after it. Here a red run is a
// statement about the whole file.
//
// These are all in the class this repository keeps producing: something that
// LOOKS like it works — a backoff at the wrong rung, a value that is wrong
// rather than absent, a sort that contradicts the comment above it, a limit that
// turns a blank into a one-market board. None of them throws. Each one was green
// in the suite that surrounded it.
//
// K1 and K3 need the supervisor, so the environment is pinned HERE, before any
// lib module is loaded — lib/config.js evaluates at import.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.FEED_CREDENTIALS_KEY = crypto.randomBytes(32).toString('hex');
process.env.FEED_ENABLED = 'true';
process.env.FEED_RUNNER_ENABLED = 'true';
process.env.FEED_DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/feed';
// A collector that dies immediately, so the exit path is taken at once. This is
// the real path, not a stub: the supervisor spawns a child, the child exits, and
// the supervisor decides how long to wait — which is the decision under test.
const DYING = path.join(os.tmpdir(), `dying-collector-${process.pid}.sh`);
fs.writeFileSync(DYING, '#!/bin/bash\nexit 1\n', { mode: 0o755 });
process.env.FEED_COLLECTOR_CMD = DYING;

const assert = require('assert');

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const feed = require('../lib/feed');
const runner = require('../lib/feedrunner');

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

// The floor documented beside the constant, and the ceiling. Both are stated in
// lib/feedrunner's header comment, so the test states them too — a test that
// hardcodes the WRONG number passes just as happily as one that hardcodes the
// right one, and docs/FEED.md says the backoff runs "from 5 s".
const FLOOR_SECONDS = 5;
const FLOOR_MS = FLOOR_SECONDS * 1000;
const CEILING_MS = 300_000;

/**
 * Let the supervisor really crash a child, and return the log line it wrote
 * about the restart.
 *
 * The wait is read from `health().recent_log` rather than measured by waiting
 * it out: the line is written synchronously inside the exit handler, so this is
 * fast and has no timing race, and it is the number an OPERATOR reads.
 */
async function firstCrashLog() {
  const { openStore } = require('../lib/store');
  const auth = require('../lib/auth');
  const tenants = require('../lib/tenants');
  const FC = require('../lib/feedcreds');

  const db = openStore(':memory:');
  const tenant = tenants.defaultTenant(db);
  const admin = (await auth.registerUser(db, { username: 'admin', password: 'pw-admin-1234', balance_cents: 0 }));
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
  FC.setCredentials(db, {
    actor: admin,
    tenantId: tenant.id,
    appKey: 'TESTKEYnotreal12',
    username: 'test.bettfair-demo',
    password: 'not-a-real-password',
  });
  runner.setDb(db);

  const started = runner.start(tenant.id);
  assert.ok(started.started, `the supervisor must launch the test collector: ${started.reason}`);

  const deadline = Date.now() + 10_000;
  let line = null;
  while (Date.now() < deadline && !line) {
    line = runner.health(tenant.id).recent_log
      .map((l) => l.line)
      .find((l) => /exited unexpectedly/.test(l));
    if (!line) await new Promise((r) => setTimeout(r, 25));
  }
  // Clear the pending restart whatever happens, so the suite does not leave a
  // timer behind that would respawn a dead collector for the rest of the run.
  runner.stop(tenant.id);
  runner.stopAll();
  db.close();
  return line;
}

/** ONE ROW PER SELECTION, as v_feed2 returns it. */
const row = (over = {}) => ({
  market_id: '1.100',
  market_name: 'Match Odds',
  fixture_id: '10',
  event_name: 'Arsenal v Chelsea',
  market_start_time: '2026-10-20T12:00:00.000Z',
  odds_captured_at: '2026-10-15T11:00:00.000Z',
  event_type_id: 4339,
  selection_id: 1,
  runner_name: 'Arsenal',
  sort_priority: 1,
  ...over,
});

(async () => {
  // ── K1 ────────────────────────────────────────────────────────────────────
  // The supervisor incremented `consecutiveFailures` and THEN asked for the
  // wait, so the first value the exit path ever produced was 1 and the first
  // restart waited 10 s — `BACKOFF_START_MS` was a value the code could not
  // reach, while docs/FEED.md described the backoff as running "from 5 s".
  //
  // This drives the REAL exit path rather than calling backoffMs directly,
  // because the defect was never in the formula: it was the order of two
  // statements at the call site, and only the exit path can catch that. A unit
  // test of backoffMs({consecutiveFailures: 0}) passes against the bug — which
  // is exactly what tests/feedrunner.test.js R4 did.
  await check('K1 the FIRST restart waits the documented floor, not double it', async () => {
    const log = await firstCrashLog();
    const said = /retrying in (\d+)s \(failure (\d+)\)/.exec(log);
    assert.ok(said, `the supervisor must log the wait it armed; got: ${JSON.stringify(log)}`);
    assert.strictEqual(
      Number(said[1]),
      FLOOR_SECONDS,
      `the first restart must wait ${FLOOR_SECONDS}s — BACKOFF_START_MS is otherwise unreachable`
    );
    // The log names the failure it is ABOUT to record, so it reads 1 while the
    // wait was computed from 0. Pinning both stops a fix that reorders the pair
    // and leaves the operator reading a count that disagrees with the wait.
    assert.strictEqual(Number(said[2]), 1, 'the log counts the crash it is reporting');
  });

  // ── K2 ────────────────────────────────────────────────────────────────────
  await check('K2 the backoff doubles per failure and stops at the ceiling', () => {
    // `backoffMs` is the formula the exit path arms the timer with, and it is a
    // function of the failures recorded SO FAR. Pinned as a property so a
    // doubling mistake cannot hide behind a matching list of literals.
    for (let n = 0; n <= 12; n++) {
      assert.strictEqual(
        runner.backoffMs({ consecutiveFailures: n }),
        Math.min(FLOOR_MS * 2 ** n, CEILING_MS),
        `${n} failures recorded so far must wait ${Math.min(FLOOR_MS * 2 ** n, CEILING_MS)}ms`
      );
    }
    const seq = [0, 1, 2, 3, 4].map((n) => runner.backoffMs({ consecutiveFailures: n }));
    assert.deepStrictEqual(
      seq,
      [FLOOR_MS, 10_000, 20_000, 40_000, 80_000],
      `the sequence must start at the floor and double; got ${JSON.stringify(seq)}`
    );
    assert.strictEqual(runner.backoffMs({ consecutiveFailures: 99 }), CEILING_MS, 'and it must cap');
    // The floor must not be reachable only by accident: the rung above it is
    // strictly worse, so the first crash is the cheapest restart the
    // supervisor ever performs.
    assert.ok(
      runner.backoffMs({ consecutiveFailures: 1 }) > runner.backoffMs({ consecutiveFailures: 0 }),
      'the second crash must wait longer than the first'
    );
  });

  // ── K3 ────────────────────────────────────────────────────────────────────
  await check('K3 an unreadable credential store reports UNKNOWN, not configured:true', () => {
    // No database has been set on the supervisor, so FC.status() throws on its
    // query — which is the only path that reaches safeStatus's fallback.
    const h = runner.health('tenant-with-no-db');
    const stored = h.configured;
    assert.ok(stored && typeof stored === 'object', 'health must still report a credential status');
    assert.ok(
      !('configured' in stored) || stored.configured === null,
      `a store we could not read is UNKNOWN, not configured: true — got ${JSON.stringify(stored.configured)}`
    );
    assert.notStrictEqual(stored.configured, true, 'the specific fabrication this covers');
    // An unknown that carries no reason is the same defect wearing a hat.
    assert.ok(
      typeof stored.error === 'string' && stored.error.length > 0,
      `an unknown must say why it is unknown; got ${JSON.stringify(stored)}`
    );
  });

  // ── K4 ────────────────────────────────────────────────────────────────────
  await check('K4 market.sport_id carries a real value, and the query selects it', () => {
    const out = feed.groupRows([row()]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(
      out[0].sport_id,
      4339,
      `sport_id read row.sport_type_id, which no view has; it is always undefined (got ${out[0].sport_id})`
    );
    // …and the value has to arrive from somewhere, or the assertion above is
    // satisfied by a constant.
    assert.match(
      feed.boardSql(2, false),
      /v\.event_type_id/,
      'the board query must select the column the field is read from'
    );
    assert.match(feed.boardSql(1, false), /v\.event_type_id/, 'on both feeds');
    // NAV_SQL already aliased it; the board was the odd one out.
    assert.match(feed.NAV_SQL, /event_type_id\s+AS sport_id/);
  });

  // ── K5 ────────────────────────────────────────────────────────────────────
  await check('K5 the served board keeps the ORDER the query chose', () => {
    // Feed 2 orders by BOOK FRESHNESS, not start time — the comment above
    // boardSql argues that at length, because start-time ordering leads with
    // already-finished markets that have no prices. The two rows below are in
    // the order the query returned them; the SECOND one starts EARLIER, so any
    // re-sort by start time swaps them.
    const rows = [
      row({ market_id: '1.100', market_start_time: '2026-10-20T12:00:00.000Z' }),
      row({ market_id: '1.200', market_start_time: '2026-10-18T09:30:00.000Z', selection_id: 2, runner_name: 'Chelsea' }),
    ];
    const served = feed.shape(rows, { priced: true });
    assert.strictEqual(served.length, 2);
    assert.deepStrictEqual(
      served.map((m) => m.market_id),
      ['1.100', '1.200'],
      `the board must keep the query's order; got ${JSON.stringify(served.map((m) => m.market_id))}`
    );
    // Grouping is a Map walk, so this holds by construction — and that is the
    // invariant that makes dropping the client-side sort safe rather than lucky.
    assert.deepStrictEqual(
      feed.groupRows(rows).map((m) => m.market_id),
      ['1.100', '1.200'],
      'groupRows must preserve row order for the above to mean anything'
    );
  });

  // ── K6 ────────────────────────────────────────────────────────────────────
  await check('K6 ?limit= with a blank or nonsense value falls back, never to one market', () => {
    const cases = [
      ['', 'an empty query param — the most likely junk a URL produces'],
      ['   ', 'whitespace'],
      [0, 'a literal zero'],
      ['0', 'the string zero'],
      [-5, 'a negative'],
      ['-5', 'the string negative'],
      ['abc', 'non-numeric'],
      [undefined, 'absent'],
      [null, 'null'],
      [NaN, 'NaN'],
    ];
    for (const [raw, what] of cases) {
      assert.strictEqual(
        feed.boardLimit(raw, 50),
        50,
        `?limit=${JSON.stringify(raw)} (${what}) is junk and must fall back to the configured 50, ` +
          `not clamp to a one-market board`
      );
    }
    // …and a value that IS a request is still honoured, and still bounded.
    assert.strictEqual(feed.boardLimit(12, 50), 12);
    assert.strictEqual(feed.boardLimit('12', 50), 12);
    assert.strictEqual(feed.boardLimit(9999, 50), 500, 'the ceiling still holds');
    assert.strictEqual(feed.boardLimit(1, 50), 1, 'asking for one market still means one');
  });

  console.log(`\nfeed-hygiene.test.js: ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
  if (passed !== 6) { console.error(`expected 6 checks, ran ${passed}`); process.exit(1); }
})();