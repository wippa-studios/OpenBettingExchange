// tests/run_all.js — the unit/API test runner behind `npm test`.
// Run: npm test   (or directly: node tests/run_all.js)
//
// The old "test" script was an &&-chain: the FIRST failing suite stopped the
// chain and every downstream result was invisible — a broken config.test.js
// hid whether match, settle or api were green at all. This runner instead:
//
//   - discovers every tests/*.test.js (sorted, so the order is stable);
//   - runs each suite in its own child process, exactly as the chain did;
//   - echoes each suite's own output (the familiar "  ok ..." lines);
//   - prints a one-line verdict per suite with the suite's own check count;
//   - ALWAYS runs every suite, and exits non-zero if ANY of them failed.
//
// smoke.sh and ui_test.mjs stay separate npm scripts on purpose: the smoke
// suite boots a real server end to end and the browser suite needs
// Chromium, so neither belongs in the plain offline "test" run.
//
// A single suite alone is unchanged: node tests/match.test.js
'use strict';
const { spawnSync } = require('child_process');
const { readdirSync } = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Suites that need env from OUTSIDE their own file. lib/config.js is
// evaluated at import, so FEED_ENABLED cannot be pinned from inside
// feed_nav.test.js — the runner hands it the same environment the old
// npm chain did: feed on, pointed at the reserved dead port (nothing
// listens on 59999, so the connection fails instantly, offline).
// Every other suite pins its own env in its preamble.
const SUITE_ENV = {
  'feed_nav.test.js': {
    FEED_ENABLED: 'true',
    FEED_DATABASE_URL: 'postgresql://feed:feed@127.0.0.1:59999/offline',
  },
};

// ui_test.mjs is deliberately not a *.test.js (it is a different npm script,
// needing Chromium); smoke.sh is not JavaScript. Both stay out.
const suites = readdirSync(path.join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let failures = 0;
let checks = 0;
const failedNames = [];

console.log(`→ ${suites.length} unit/API suites, each in its own process (a failure never masks the rest)`);

// Per-suite wall-clock ceiling.
//
// WHY THIS EXISTS, because it was found the expensive way. `spawnSync` has no
// timeout by default, so a suite that HANGS stops the entire run: no summary
// line, no exit code, no failure recorded — the remaining ~48 suites simply
// never run, and the only symptom is silence. That is the worst possible
// failure mode for a gate, because it is indistinguishable from a slow run.
//
// The trigger was a single over-specified assertion in express5.test.js: a
// `listen()`ed server was closed *after* the assertions rather than in a
// `finally`, so the failed assertion leaked the socket and the suite hung. The
// fix belongs in the tests, and it does — but it must ALSO belong here, because
// the next such bug should cost a failed line, not a dead run.
//
// Generous enough to be uninteresting: the slowest suite here is api.test.js at
// well under two minutes, so 5 minutes is a hang and not a slow suite. It is
// reported as TIMEOUT and distinct from an assertion failure on purpose — "it
// hung" and "it asserted wrong" are different diagnoses, and collapsing them
// sends the reader to the wrong file.
const SUITE_TIMEOUT_MS = 300_000;

for (const suite of suites) {
  const run = spawnSync(process.execPath, [path.join('tests', suite)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...SUITE_ENV[suite] },
    timeout: SUITE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  // The suite's own per-check lines stay visible, unfiltered.
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);

  // The suite's closing line ("<file>: N checks passed") is the
  // authoritative count. A suite that died before printing it falls back to
  // counting its "ok" lines, so a crash still reports what did run.
  const summary = String(run.stdout || '').match(/(\d+) checks passed/);
  const count = summary
    ? Number(summary[1])
    : (String(run.stdout || '').match(/^\s*ok\b/gm) || []).length;
  checks += count;

  if (run.status === 0) {
    console.log(`  PASS ${suite} — ${count} checks`);
  } else {
    failures++;
    failedNames.push(suite);
    const timedOut = !!(run.error && run.error.code === 'ETIMEDOUT');
    const why = timedOut
      ? `TIMEOUT after ${Math.round(SUITE_TIMEOUT_MS / 1000)}s (it hung, which is not the same as it failed)`
      : run.status === null
        ? `signal ${run.signal}`
        : `exit ${run.status}`;
    console.log(`  FAIL ${suite} — ${count} checks ok, then ${why}`);
  }
}

console.log();
if (failures === 0) {
  console.log(`run_all: ALL GREEN — ${suites.length} suites, ${checks} checks passed`);
} else {
  console.log(
    `run_all: FAILURES — ${suites.length - failures}/${suites.length} suites green (${checks} checks);` +
      ` failed: ${failedNames.join(', ')}`
  );
}
process.exit(failures === 0 ? 0 : 1);
