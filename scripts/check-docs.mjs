#!/usr/bin/env node
// scripts/check-docs.mjs — fail CI when the documentation contradicts the code.
//
// WHY THIS EXISTS. The repo review found the README stating that cash-out was
// "green-up close at top of book" (it is a venue buyout), that there was "no
// payments and no withdrawals anywhere in this codebase" (both ship), that a
// results feed was "not implemented (out of scope)" (it shipped), a stale
// table count, and stale test counts. All of it was true when written and
// quietly false later.
//
// Documentation rot is not cosmetic here. A contributor who reads the cash-out
// section will implement the market hedge — a model that is provably
// value-destroying. Numbers that drift are how a README stops being evidence.
//
// So the checks are mechanical, not editorial: they assert claims that CAN be
// checked against the code. Anything requiring judgement stays out, because a
// linter that cries wolf gets disabled.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const note = (ok, msg) => { if (!ok) failures.push(msg); };

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => existsSync(path.join(ROOT, rel));

// ── 1. Table count claimed in README/ARCHITECTURE must match the schema ─────
const { openStore } = require(path.join(ROOT, 'lib/store.js'));
const db = openStore(':memory:');
const tableCount = db
  .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .get().c;
db.close();

for (const rel of ['README.md', 'docs/ARCHITECTURE.md']) {
  if (!exists(rel)) continue;
  const src = read(rel);
  // "13 tables", "one readable SQL file of 22 tables"
  const claims = [...src.matchAll(/(\d+)\s+tables/gi)].map((m) => Number(m[1]));
  for (const n of claims) {
    note(
      n === tableCount,
      `${rel} claims ${n} tables; the schema has ${tableCount}. Update the number or the schema.`
    );
  }
}

// ── 2. Test counts must match what the runner actually reports ─────────────
// Parsed rather than hardcoded, so the number is always live.
function suiteCount() {
  return readdirCount('.test.js');
}
function readdirCount(suffix) {
  const files = execFileSync('bash', ['-lc', `ls ${path.join(ROOT, 'tests')} | grep -- '${suffix}$' | wc -l`], { encoding: 'utf8' });
  return Number(files.trim());
}
// Returns { count } on a fully green run, or { count: null, why } otherwise.
//
// ── WHY THIS REFUSES TO COMPARE A FAILED RUN ──────────────────────────────
// The original version grepped `run_all: .*checks` and took whatever number it
// found. But tests/run_all.js prints a summary line on FAILURE too:
//
//   run_all: ALL GREEN — 39 suites, 495 checks passed
//   run_all: FAILURES — 34/39 suites green (440 checks); failed: api.test.js
//
// Both match. So when the suite did not pass, this read the PARTIAL count and
// compared it against the docs — inventing a discrepancy that did not exist.
// In CI that is exactly what happened: the `guards` job never ran `npm ci`, so
// suites needing express/pg died on require, the count came back 440 (CI said
// 442), and CI went red accusing README.md of lying while the README was right.
//
// A checker that cannot tell "the docs are wrong" from "the suite did not run"
// is worse than no checker, because it reports a confident falsehood. So a
// failed run yields NO count, and the caller says so plainly instead.
function checkCount() {
  try {
    const out = execFileSync(
      'bash',
      ['-lc', `cd ${ROOT} && npm test 2>&1 | grep -E '^run_all:' | tail -1`],
      { encoding: 'utf8', timeout: 600000 }
    );
    const green = out.match(/run_all: ALL GREEN — \d+ suites, (\d+) checks passed/);
    if (green) return { count: Number(green[1]) };
    const bad = out.match(/run_all: FAILURES[^\n]*/);
    return { count: null, why: bad ? bad[0] : 'the suite printed no summary' };
  } catch (e) {
    return { count: null, why: `the suite could not be run (${e && e.message ? e.message.slice(0, 120) : 'unknown'})` };
  }
}

const suites = suiteCount();
const { count: checks, why: countFailure } = checkCount();

// Refuse to make any claim about the docs' check count unless the suite is
// green. Failing here is deliberate: a doc-consistency checker that silently
// skips its own central assertion is a control that reports and does not act —
// the exact failure this project's audit keeps finding.
if (checks === null) {
  console.error('\n  CANNOT VERIFY the documented check count.');
  console.error(`  The test suite did not pass, so there is no count to compare against:\n    ${countFailure}`);
  console.error('  This is NOT a claim that the docs are correct. Fix the suite, then re-run.');
  process.exit(1);
}
if (checks) {
  // ONLY the `npm test` line. The UI and smoke suites have their own counts
  // and are legitimately different numbers; comparing all of them against the
  // unit total flags correct documentation as wrong.
  for (const rel of ['README.md', 'CONTRIBUTING.md']) {
    if (!exists(rel)) continue;
    const src = read(rel);
    for (const line of src.split('\n')) {
      if (!/npm test\b/.test(line)) continue;
      const m = line.match(/(\d+)\s+checks/);
      if (!m) continue;
      note(
        Number(m[1]) === checks,
        `${rel}: "npm test" claims ${m[1]} checks; the suite reports ${checks}.`
      );
    }
  }
  const suiteClaims = { 'README.md': suites };
  for (const [rel, expected] of Object.entries(suiteClaims)) {
    const src = read(rel);
    for (const m of src.matchAll(/(\d+)\s+suites/gi)) {
      note(Number(m[1]) === expected, `${rel} claims ${m[1]} suites; there are ${expected}.`);
    }
  }
}

// ── 3. Cash-out model: docs must not describe the removed market hedge ────
// This is the one that matters most. The v1 hedge formula was provably
// value-destroying; a doc that still teaches it sends a contributor to
// implement the wrong thing.
for (const rel of ['README.md', 'docs/EXCHANGE_RULES.md', 'docs/ARCHITECTURE.md']) {
  if (!exists(rel)) continue;
  const src = read(rel);
  note(
    !/round\(\s*Σ|Σ\s*sᵢ|green-up close at top of book|hedge_price/i.test(src),
    `${rel} still describes cash-out as a market hedge. The engine now uses a ` +
    `venue buyout (lib/cashout.js) — see its header for the derivation.`
  );
}

// ── 4. "Not implemented" list must not name things that now ship ──────────
const shipped = [
  { re: /no payments and no withdrawals/i, what: 'payments + withdrawals' },
  { re: /results feed[^\n]*not implemented/i, what: 'the results feed' },
  { re: /settlement is a manual admin action/i, what: 'automatic settlement' },
];
for (const rel of ['README.md', 'docs/EXCHANGE_RULES.md']) {
  if (!exists(rel)) continue;
  const src = read(rel);
  for (const { re, what } of shipped) {
    note(!re.test(src), `${rel} still lists ${what} as missing. It ships now.`);
  }
}

// ── 5. Every file the docs link to must exist ─────────────────────────────
// A dead link in a README is a dead end for a contributor.
for (const rel of ['README.md', 'CONTRIBUTING.md']) {
  const src = read(rel);
  for (const m of src.matchAll(/\]\(([^)#]+?)\)/g)) {
    const target = m[1];
    if (/^https?:/.test(target)) continue;
    note(exists(target), `${rel} links to ${target}, which does not exist.`);
  }
}

// ── 6. README's API table must not omit routes ────────────────────────────
// Cheap proxy: every /api route family the server exposes should appear in
// the README. Catches a shipped feature with no documented entry point.
const serverSrc = read('server.js');
const readme = exists('README.md') ? read('README.md') : '';
const families = new Set(
  [...serverSrc.matchAll(/app\.(?:get|post|put|patch|delete)\('\/api\/([a-z-]+)/g)].map((m) => m[1])
);
for (const fam of [...families].sort()) {
  // Only require the major surfaces; leaf routes are covered by docs/API.md.
  if (['format', 'stream', 'me', 'branding'].includes(fam)) continue;
  note(
    readme.includes(`/api/${fam}`),
    `README does not mention /api/${fam} — a shipped endpoint with no documentation.`
  );
}

// ── Report ────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n  Documentation is out of date (${failures.length}):\n`);
  for (const f of failures) console.error(`   x ${f}`);
  console.error('\n  These are claims the code contradicts. Fix the doc or the code.\n');
  process.exit(1);
}
console.log(`  docs consistent with the code (${tableCount} tables, ${suites} suites, ${checks ?? '?'} checks)`);