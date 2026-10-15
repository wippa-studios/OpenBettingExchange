#!/usr/bin/env node
// scripts/check-env-example.mjs — keep .env.example honest about lib/config.js.
//
// THE PROBLEM (#5). `.env.example` documented 15 keys while the server read far more.
// It drifted because nothing checked it. The consequence is not cosmetic: a key
// missing from the example is a knob an operator cannot discover without reading
// the source, and several of them fail CLOSED — FEED_CREDENTIALS_KEY unset means
// the venue refuses to store a credential, OPS_TOKEN unset means /metrics 404s,
// BACKUP_DIR unset means the scheduled backup never runs. Those are surprising
// enough that discovering them by reading source is the wrong way to find out.
//
// THE TRAP THIS HAS TO AVOID. A completeness check is trivially vacuous. It can
// pass on an empty file, pass on a file that happens to list only the keys that
// were checked, or pass because the extractor silently found nothing and
// compared an empty set against an empty set. Every one of those is green and
// worthless. Three things are done about it:
//
//   1. THE SURFACE IS EXTRACTED FROM THE SOURCE, NEVER HARD-CODED. A list of
//      keys written next to the check would go stale the moment the check was
//      the thing that needed updating, and adding a config key would not make
//      it fail — which is the whole job.
//   2. THE EXTRACTION IS SELF-AUDITED (see `assertSurfaceIsReal`). If
//      lib/config.js is renamed, restructured or deleted, the parse is required
//      to still find a large, plausible surface containing known sentinels.
//      A check that cannot parse its input fails instead of passing empty.
//   3. THE OTHER DIRECTION IS ASSERTED TOO (see MUST_REMAIN_TRACKABLE). The
//      same parse is required to return a NON-trivial .env.example. Combined
//      with rule 1, an empty file fails with every surface key named as missing,
//      and a source that fails to parse fails loudly. Neither can be green.
//
// NO CONFIG-KEY COUNT IS WRITTEN IN THIS FILE, deliberately. #103 found
// `README.md` claiming 61, `docs/ROADMAP.md` claiming 58, and `.env.example`
// actually carrying 61 — three documents, three numbers, and the two that
// disagreed were both correct on the day they were written. The count is
// printed by this script's own PASS line, which is derived from `lib/config.js`
// at run time, and the guarantee that actually matters — every key the code
// reads is documented, with the right default — is what the rules below
// enforce. A hand-maintained figure in a comment is exactly the kind of claim
// that rots in silence. **DO NOT RE-ADD ONE.**
//
// COMMENTS ARE STRIPPED BEFORE THE SURFACE IS SCANNED, and that is not a
// refinement — it is the difference between a check that is right and one that
// reports a confident falsehood. `lib/config.js` explains at length why
// `API_VERSION` is deliberately NOT read from the environment, and the sentence
// doing the explaining contains the literal text `raw.API_VERSION`. The regex
// below matched that PROSE, put a constant into the "keys the code reads"
// surface, and then failed every run with:
//
//     MISSING  API_VERSION  read by the code but absent from .env.example
//
// — for a key the same file insists must not be in `.env.example`, because
// adding it would document a knob that does not exist and invite an operator to
// set it. Satisfying the check the honest way was impossible: the two rules
// contradict each other and the checker did not know which one it was in.
//
// The same class of bug applies to `process.env.X`, which is read out of
// server.js and lib/. A comment that NAMES a key it does not read is the normal
// way to explain why a key is deliberately absent, so scanning prose is not a
// theoretical risk here — it is how this file was already wrong.
//
// WHAT IS ASSERTED, AND WHAT IS NOT. Said plainly because a guard that overstates
// itself is the failure this repo keeps paying for:
//
//   - COVERAGE: every key the code reads is present as a real assignment.
//     Asserted against the derived surface, not against a number written here.
//   - NO PHANTOMS: every key in .env.example is one the code actually reads, so
//     a renamed or deleted key cannot linger as documentation of nothing.
//   - DEFAULTS MATCH: where the code has a concrete default, the example states
//     it. Enforced for lib/config.js DEFAULTS and for the inline
//     `process.env.X || <literal>` defaults in server.js.
//   - SECRETS STAY BLANK: a key whose default is null, or whose name ends in
//     KEY/SECRET/TOKEN/PASSWORD, must have an EMPTY value. An operator who
//     copies the file must not ship a live token, and an example value is
//     precisely how that happens. Covers OPS_TOKEN, RESULTS_FEED_SECRET,
//     FEED_CREDENTIALS_KEY, PAYMENTS_WEBHOOK_SECRET, ADMIN_PASSWORD,
//     DEMO_PASSWORD.
//   - NOT ENFORCED: the VALUE of FEED_DATABASE_URL and RESULTS_FEED_URL, whose
//     defaults are the empty string — an example file is more useful showing
//     the shape of a URL than showing nothing. Their PRESENCE is enforced.
//   - NOT ENFORCED: FEED_COLLECTOR_VERBOSE's value. It is read as
//     `=== '1'`, which has no default literal to compare against.
//
// Exit 0 when consistent. Exit 1 otherwise, naming the specific key and rule.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

// ── Extracting the real surface ───────────────────────────────────────────

/**
 * Remove comments from JS source, so a scan for `raw.X` / `process.env.X` reads
 * CODE and not the prose describing it.
 *
 * The same trim `scripts/check-docs.mjs` and `tests/guard.test.js` already use,
 * for the same reason — both of those hit a check that fired for the wrong
 * reason because a comment named the very thing being checked.
 *
 * Not string-aware, deliberately: a `//` inside a string literal would truncate
 * the rest of that line, which can only ever REMOVE a candidate key, never
 * invent one. Losing a key makes the checker report a MISSING that is not
 * there, which is loud and fixable; inventing one is what produced the
 * API_VERSION false positive. `lib/config.js` has no `//` inside a string.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

/**
 * Slice the `DEFAULTS` object literal out of lib/config.js and evaluate it.
 *
 * Evaluated rather than regex-parsed because the VALUES are typed — 7777 is a
 * number, `false` is a boolean, `null` is a deliberate "unset" that means
 * something quite different from `''`. A parser that flattened those to strings
 * could not tell "unset, and unset is refused" from "empty string", which is
 * the distinction the secret rule turns on.
 *
 * The slice is found by matching braces with strings and comments skipped, so a
 * brace inside a comment or a quoted value does not end the object early. If
 * the anchor is not found at all, this throws rather than returning {} — an
 * empty DEFAULTS is never a valid input to a completeness check.
 */
function extractDefaults(src) {
  const anchor = src.indexOf('const DEFAULTS = {');
  if (anchor < 0) throw new Error('could not find `const DEFAULTS = {` in lib/config.js');
  const start = src.indexOf('{', anchor);

  let depth = 0, i = start, quote = null;
  for (; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && next === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && next === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('unbalanced braces while slicing DEFAULTS from lib/config.js');

  const literal = src.slice(start, i);
  // An empty context: DEFAULTS is a literal of primitives, so nothing in it can
  // reach a global, a require or the filesystem.
  const out = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 2000 });
  if (!out || typeof out !== 'object') throw new Error('DEFAULTS did not evaluate to an object');
  return out;
}

let DEFAULTS;
let RAW_READS;
try {
  const configSrc = readFileSync(join(ROOT, 'lib', 'config.js'), 'utf8');
  DEFAULTS = extractDefaults(configSrc);
  // Keys the loader reads off the merged env object. One of them,
  // PAYMENTS_WEBHOOK_SECRET, has NO entry in DEFAULTS at all — which is itself a
  // gap in lib/config.js, and is why the surface cannot be DEFAULTS alone.
  // COMMENTS REMOVED FIRST — see stripComments() and the header note on why a
  // sentence explaining that API_VERSION is not read was being read as a read.
  RAW_READS = [...stripComments(configSrc).matchAll(/\braw\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
} catch (e) {
  // A check that cannot read its source must fail LOUDLY and say why. Left
  // unhandled this surfaced as a raw stack trace, which is technically a
  // failure and practically unreadable in a CI log.
  console.error('\ncheck-env-example: FAILED — could not read the config surface from lib/config.js.\n');
  console.error(`  ${e.message}`);
  console.error('  ::error::cannot extract lib/config.js DEFAULTS — this check cannot be trusted;');
  console.error('  ::error::refusing to report "consistent" on an input it could not parse\n');
  process.exit(1);
}

// Knobs read straight off process.env in application code, bypassing
// lib/config.js entirely. Seven of them, and DELAY_RELEASE_INTERVAL_MS /
// RECONCILE_INTERVAL_MS among them are in the README's config table — so they
// are real, documented, operator-facing settings that DEFAULTS cannot see.
// Excluded: tests/ and scripts/ (harness knobs like UI_TEST_PORT, not venue
// configuration) and npm_package_version (injected by npm, not an operator).
const INDIRECT_EXCLUDE = new Set(['npm_package_version']);
// Listed by extension and then filtered in JS rather than by pathspec: git
// pathspecs need `:(glob)` for `**`, and `'lib/**/*.js'` silently matches only
// the NESTED files — it returned 3 of this repo's 35 lib files, which quietly
// dropped LOG_LEVEL and FEED_COLLECTOR_VERBOSE from the surface until the
// no-phantom rule caught them appearing in the example with nothing reading them.
const appFiles = execSync("git ls-files '*.js'", { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => f === 'server.js' || f.startsWith('lib/'));

const DIRECT_READS = new Set();
const INLINE_DEFAULTS = new Map(); // key -> default literal, from `process.env.K || <lit>`
for (const file of appFiles) {
  // Comments stripped for the same reason as RAW_READS: an explanatory sentence
  // naming a key it does NOT read is not a read, and treating it as one is how
  // this check comes to demand a `.env.example` entry for a constant.
  const src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    if (!INDIRECT_EXCLUDE.has(m[1])) DIRECT_READS.add(m[1]);
  }
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\s*\|\|\s*(?:Number\(\s*)?(\d+(?:\.\d+)?|'[^']*'|"[^"]*")/g)) {
    INLINE_DEFAULTS.set(m[1], m[2].replace(/^['"]|['"]$/g, ''));
  }
}

// ── Self-audit: the extraction must be real before anything is compared ────

/**
 * Refuse to run on a surface that does not look like this codebase's config.
 *
 * This is the guard against the vacuous pass. Without it, a rename of DEFAULTS,
 * a move to ESM, or a deleted lib/config.js would produce an empty surface, the
 * example file would match it exactly, and the check would report "consistent"
 * while enforcing nothing at all.
 */
function assertSurfaceIsReal(surface) {
  const problems = [];

  if (Object.keys(DEFAULTS).length < 40) {
    problems.push(`DEFAULTS yielded only ${Object.keys(DEFAULTS).length} keys (expected ~50) — lib/config.js was probably restructured`);
  }
  if (!RAW_READS.length) {
    problems.push('no `raw.<KEY>` reads found in lib/config.js — the loader shape changed');
  }
  if (surface.size < 45) {
    problems.push(`surface is only ${surface.size} keys (expected 45+) — extraction regressed`);
  }
  // Sentinels spanning the classes: a scalar server key, a security control, a
  // null-default secret, and a knob read straight off process.env.
  for (const k of ['PORT', 'SCRYPT_N', 'OPS_TOKEN', 'DELAY_RELEASE_INTERVAL_MS']) {
    if (!surface.has(k)) problems.push(`sentinel key ${k} is absent from the extracted surface`);
  }

  if (problems.length) {
    console.error('\ncheck-env-example: FAILED — the config surface could not be extracted reliably.\n');
    for (const p of problems) {
      console.error(`  ${p}`);
      console.error(`  ::error::${p} — this check cannot be trusted; refusing to report "consistent"`);
    }
    console.error('\n  A completeness check that cannot parse its source passes vacuously.\n');
    process.exit(1);
  }
}

const SURFACE = new Set([...Object.keys(DEFAULTS), ...RAW_READS, ...DIRECT_READS]);
assertSurfaceIsReal(SURFACE);

// ── Parsing .env.example the way lib/config.js parses .env ────────────────

function parseEnvExample(file) {
  if (!file) throw new Error('called without a path');
  const out = new Map();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    // A COMMENTED key does not count as present. The operator copies this file
    // verbatim, so a key that is only mentioned in a comment is still a key they
    // do not have.
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    // Same quote-stripping the loader does, so both sides of every comparison
    // below are the value the server would actually see.
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    out.set(key, val);
  }
  return out;
}

const EXAMPLE_PATH = join(ROOT, '.env.example');
const example = parseEnvExample(EXAMPLE_PATH);

// The other half of the anti-vacuity pair. assertSurfaceIsReal stops the SOURCE
// side collapsing; this stops the FILE side. An empty or all-commentary
// .env.example is not a passing state, it is the bug this issue is about.
if (example.size < SURFACE.size * 0.5) {
  console.error(
    `\ncheck-env-example: FAILED — .env.example defines only ${example.size} key(s) ` +
      `for a ${SURFACE.size}-key surface. That is a gutted file, not a passing one.`
  );
  console.error('  ::error::.env.example is effectively empty; the completeness check would be vacuous');
  process.exit(1);
}

// ── The rules ─────────────────────────────────────────────────────────────

// A key whose default is null is "unset, and unset is refused". A key named
// like a credential must not ship an example value, whatever its default is:
// the realistic accident is someone writing OPS_TOKEN=changeme, an operator
// copying the file, and a live token that anyone can guess on /metrics.
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD)$/;

const problems = [];
const fail = (rule, key, detail) => problems.push({ rule, key, detail });

// Rule 1 — coverage.
for (const key of [...SURFACE].sort()) {
  if (!example.has(key)) {
    fail('MISSING', key, 'read by the code but absent from .env.example');
  }
}

// Rule 2 — no phantoms.
for (const key of [...example.keys()].sort()) {
  if (!SURFACE.has(key)) {
    fail('PHANTOM', key, 'documented in .env.example but read by no code — stale or misspelled');
  }
}

// Rules 3 and 4 — values.
const rule = (key) => {
  const declared = Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? DEFAULTS[key] : INLINE_DEFAULTS.get(key);
  if (SECRET_NAME.test(key)) return 'secret';
  if (declared === null) return 'blank';
  if (declared === undefined) return 'free';   // no default literal to compare
  if (declared === '') return 'sample';       // default is "nothing"; a shape is useful
  return 'exact';
};

for (const key of [...SURFACE].sort()) {
  if (!example.has(key)) continue; // already reported by rule 1
  const value = example.get(key);
  const kind = rule(key);

  if (kind === 'secret' || kind === 'blank') {
    if (value !== '') {
      fail('SECRET_NOT_BLANK', key,
        `must be blank in the example (${SECRET_NAME.test(key) ? 'a credential is never shipped as an example' : 'its default is unset, and unset is refused'}), got ${JSON.stringify(value)}`);
    }
    continue;
  }
  if (kind === 'sample' || kind === 'free') continue;

  const declared = Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? DEFAULTS[key] : INLINE_DEFAULTS.get(key);
  if (value !== String(declared)) {
    fail('VALUE_MISMATCH', key,
      `.env.example says ${JSON.stringify(value)}, the code defaults to ${JSON.stringify(String(declared))}`);
  }
}

// ── Report ────────────────────────────────────────────────────────────────

if (problems.length) {
  const byRule = new Map();
  for (const p of problems) byRule.set(p.rule, (byRule.get(p.rule) || 0) + 1);

  console.error(`\ncheck-env-example: FAILED — ${problems.length} problem(s) in .env.example.\n`);
  for (const p of problems) {
    const why = p.rule === 'MISSING'
      ? 'add it with a one-line meaning, and its default'
      : p.rule === 'PHANTOM'
        ? 'it is read by no code — delete it, or fix the name'
        : p.rule === 'VALUE_MISMATCH'
          ? 'copy the value the code actually defaults to'
          : 'blank it out';
    console.error(`  ${p.rule.padEnd(17)} ${p.key}`);
    console.error(`  ${' '.repeat(17)} ${p.detail}`);
    console.error(`  ${' '.repeat(17)} fix: ${why}`);
    console.error(`  ::error file=.env.example::${p.rule}: ${p.key} — ${p.detail}`);
  }
  console.error(`\n  ${[...byRule].map(([r, n]) => `${r}: ${n}`).join('   ')}`);
  console.error(`  surface: ${SURFACE.size} keys (${Object.keys(DEFAULTS).length} in DEFAULTS, ` +
    `${RAW_READS.filter((k) => !(k in DEFAULTS)).length} read but not defaulted, ` +
    `${[...DIRECT_READS].length} read straight off process.env)`);
  console.error(`  .env.example documents ${example.size}.\n`);
  process.exit(1);
}

console.log(
  `check-env-example: clean — all ${SURFACE.size} config keys documented, ` +
    `values match the defaults (${example.size} assignments).`
);