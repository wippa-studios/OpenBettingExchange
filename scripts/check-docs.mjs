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

// Every doc that states a table count is checked, not just two. The count was
// stale in exactly the files nobody looked at: docs/WORKSTREAMS.md said 13
// while the schema had 25, and no check read it.
//
// CHANGELOG.md is deliberately EXCLUDED everywhere it could carry a historical
// number: "grew from 340 to 584 checks" is an accurate record of a past review,
// and rewriting it to match today would make the history less accurate, not more.
// A checker that flags correct history gets disabled.
const DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'docs/API.md',
  'docs/ARCHITECTURE.md',
  'docs/EXCHANGE_RULES.md',
  'docs/FEED.md',
  'docs/ROADMAP.md',
  'docs/WORKSTREAMS.md',
];

for (const rel of DOCS) {
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

  // ── The BROWSER suite count, checked for CONSISTENCY across the docs ─────
  // Not checked against a live run: that needs Playwright and a browser, which
  // is too expensive for a doc checker and would make it flaky.
  //
  // But consistency is nearly as useful and costs nothing. `test:ui` sat at
  // "74 checks" in README.md, CONTRIBUTING.md and docs/WORKSTREAMS.md while the
  // suite actually ran 78 — three files agreeing with each other and all wrong,
  // which is why no per-file check against the real number ever fired: the
  // `npm test` check above only reads the npm-test line.
  //
  // So: collect every browser-suite count stated anywhere, and if they disagree
  // with each other, fail and say which files disagree. That catches a stale
  // edit in one file even though every other file is equally stale — and it
  // cannot produce a false positive, because it only fires on actual
  // disagreement rather than on a number it is guessing.
  const uiCounts = new Map(); // count -> [rel, ...]
  for (const rel of DOCS) {
    if (!exists(rel)) continue;
    for (const line of read(rel).split('\n')) {
      // Lines that state the browser suite: the `test:ui` script line, or prose
      // describing the browser suite. Both patterns appear in these docs.
      if (!/test:ui|browser suite/i.test(line)) continue;
      // Skip the npm-test line entirely — it states the unit total, not the
      // browser one, and comparing them is the exact false positive that made
      // an earlier version of this checker useless.
      if (/npm test\b/.test(line)) continue;
      // A sentence that gives the UNIT total and then mentions the browser
      // suite in the same breath — "625 checks across 47 suites, plus a browser
      // suite and a live smoke script" — must not have its unit figure read as
      // the browser one. That phrasing is natural to write and the first version
      // of this check flagged exactly it, which is the kind of false positive
      // that gets a checker switched off.
      const unitTotal = line.match(/(\d+)\s+checks\s+across\s+\d+\s+suites/);
      const m = unitTotal ? line.match(/(\d+)[- ]check(?!s\s+across)/) : line.match(/(\d+)[- ]check/);
      if (!m) continue;
      if (unitTotal && m[1] === unitTotal[1]) continue;
      if (!uiCounts.has(Number(m[1]))) uiCounts.set(Number(m[1]), []);
      uiCounts.get(Number(m[1])).push(rel);
    }
  }
  if (uiCounts.size > 1) {
    const parts = [...uiCounts].map(([n, rels]) => `${n} in ${rels.join(', ')}`);
    note(
      false,
      `The browser-suite check count is stated inconsistently: ${parts.join('; ')}. ` +
        `All of these describe tests/ui_test.mjs, so they must agree — then re-run ` +
        `\`npm run test:ui\` and update the one that is stale.`
    );
  }
}

// ── 3. Cash-out model: docs must not describe the removed market hedge ────
// This is the one that matters most. The v1 hedge formula was provably
// value-destroying; a doc that still teaches it sends a contributor to
// implement the wrong thing.
// docs/API.md was NOT in this list, which is how it kept describing the removed
// hedge (`"hedge_price"`, a `hedge_order` response and a `409` for a
// multi-runner position) long after the engine moved to a venue buyout.
//
// The list is now EVERY doc and the regex was widened with it, because adding
// files alone is not sufficient: the phrasing varies. docs/ARCHITECTURE.md said
// "green-up close" and "computes per-runner hedges", and docs/ROADMAP.md said
// "green-up close, hedge scaled 1/n" in a LIVE capability table — three files,
// three different strings, and the old regex caught none of them.
//
// CHANGELOG.md is excluded and is the reason this can be this broad: it records
// the v1 model as history on purpose, so including it would guarantee a false
// positive and teach everyone to ignore the check.
for (const rel of DOCS) {
  if (!exists(rel)) continue;
  const src = read(rel);
  note(
    !/round\(\s*Σ|Σ\s*sᵢ|green-up close|hedge_price|hedge scaled|per-runner hedge/i.test(src),
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
//
// This checked only README.md and CONTRIBUTING.md, so every link inside
// docs/ was unchecked — which is how CONTRIBUTING came to point at a deleted
// public/app.js for as long as it did. Docs are linked to *more* than the root
// README, so this was the wrong pair of files to trust.
for (const rel of DOCS) {
  if (!exists(rel)) continue;
  const src = read(rel);
  // Resolve relative to the linking file's own directory: docs/API.md links to
  // EXCHANGE_RULES.md as a sibling, while README.md links to docs/API.md from
  // the root. Checking both against the repo root would fail every sibling link.
  const dir = path.dirname(rel);
  for (const m of src.matchAll(/\]\(([^)#]+?)\)/g)) {
    const target = m[1];
    if (/^https?:/.test(target)) continue;
    const resolved = path.join(dir, target);
    note(exists(resolved), `${rel} links to ${target}, which does not exist.`);
  }
}

// ── 5b. Every registered route must be documented in docs/API.md ──────────
// The file that had the largest gap: 37 routes documented against 87 registered.
//
// The proximity rule matters. A plain substring search for the path counts a
// route as documented if the string appears ANYWHERE in the file — and
// `DELETE /api/auth/sessions/:id` appeared only inside the first-run-lock
// allowlist, in a code block, while the route itself was documented nowhere.
// Requiring the method within a short distance of the path catches that.
if (exists('docs/API.md')) {
  const apiDoc = read('docs/API.md');
  const routes = [...read('server.js').matchAll(
    /^app\.(get|post|put|patch|delete)\(\s*[`'"'"'"]([^`'"'"'"]+)/gm
  )].map((m) => ({ method: m[1].toUpperCase(), path: m[2] }));

  const undocumented = routes.filter((r) => {
    // Parameterised paths collapse to a literal the doc is expected to use.
    const plain = r.path.replace(/\$\{[^}]+\}/g, ':id').replace(/[?].*$/, '');
    // The path must appear, and the HTTP method must appear NEAR it. A route
    // that only exists as a string somewhere unrelated is not documentation.
    for (const m of apiDoc.matchAll(new RegExp(escapeRe(plain), 'g'))) {
      const window = apiDoc.slice(Math.max(0, m.index - 60), m.index + plain.length + 60);
      if (window.toUpperCase().includes(r.method)) return false;
    }
    return true;
  });

  note(
    undocumented.length === 0,
    `docs/API.md does not document ${undocumented.length} of ${routes.length} registered routes: ` +
      undocumented.slice(0, 8).map((r) => `${r.method} ${r.path}`).join(', ') +
      (undocumented.length > 8 ? ', …' : '') +
      '. Every endpoint an integrator can call belongs in the reference.'
  );
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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