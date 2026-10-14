// guard.test.js — mechanical enforcement of the escrow invariant's linchpin.
// Run: node tests/guard.test.js   (plain assert, no deps)
//
// THE PROBLEM THIS EXISTS TO SOLVE. The escrow invariant — a matched position
// cannot lose more than it was collateralised for — holds only because
// `orders.frozen_cents` is treated as maintained EXCLUSIVELY by the matching
// engine. That is a convention, not a type. docs/ROADMAP.md and
// docs/WORKSTREAMS.md both name it as the single risk that cuts across the
// whole codebase, and both say the same thing: enforce it before other people
// start editing the engine.
//
// This suite is that enforcement. It reads the source of every module and
// fails if something that is not the engine writes the column. A comment
// cannot do this; a convention rots silently; a test fails loudly on the
// commit that breaks it.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'lib');

// Modules allowed to write orders.frozen_cents, and why. Kept as an explicit
// allowlist rather than a blocklist, so a NEW module writing the column is a
// test failure by default — you opt in, you do not opt out.
const ALLOWED = {
  'match.js': 'the matching engine: remainder escrow on fill, cancel, and take finalisation',
  'settle.js': 'settlement auto-cancel sets the remainder to 0 — the position is being closed',
  'store.js': 'one-shot migration backfill, which recomputes via match.js escrowFor rather than re-deriving the formula',
};

// G1: the allowlist matches reality, so the list cannot rot.
check('G1 every allowed writer still exists and is the only kind of module', async () => {
  const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js'));
  for (const [name, why] of Object.entries(ALLOWED)) {
    assert.ok(files.includes(name), `allowed writer ${name} still exists`);
    assert.ok(why && why.length > 10, `${name} carries a stated reason`);
  }
  // Nothing in the allowlist may be a test or a frontend file.
  for (const name of Object.keys(ALLOWED)) assert.ok(!/\.test\.|\.mjs$/.test(name), `${name} is a lib module`);
});

// G2: THE GUARD. No module outside the allowlist may contain an UPDATE
// against orders.frozen_cents.
check('G2 no unapproved module writes orders.frozen_cents', async () => {
  const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    if (ALLOWED[f]) continue;
    const src = fs.readFileSync(path.join(LIB, f), 'utf8');
    // Strip comments so the engine's own documentation of the convention
    // does not trip its own enforcement.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/UPDATE\s+orders\s+SET[^;]*frozen_cents/i.test(code)) {
      offenders.push(f);
    }
  }
  assert.deepStrictEqual(offenders, [], `unapproved writers of orders.frozen_cents: ${offenders.join(', ')}`);
});

// G3: the allowlist is not being widened silently. If someone adds a module
// to ALLOWED without saying why, G1 makes them say why — but this pins that
// the set is exactly the three reviewed modules, so a widening is a visible
// diff rather than a quiet one.
check('G3 the allowlist is exactly the three reviewed modules', async () => {
  assert.deepStrictEqual(Object.keys(ALLOWED).sort(), ['match.js', 'settle.js', 'store.js']);
});

// G4: server.js must not write the column either. It is the largest file and
// the most likely place for an emergency fix to land.
check('G4 the HTTP layer never writes orders.frozen_cents', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/UPDATE\s+orders\s+SET[^;]*frozen_cents/i.test(src), 'server.js writes orders.frozen_cents');
});

// G5: the frontend must not either. A browser that could write escrow would
// make the invariant unprovable.
check('G5 the frontend never writes orders.frozen_cents', async () => {
  for (const f of ['app.js', 'admin.js', 'ladder.js']) {
    const p = path.join(ROOT, 'public', f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    assert.ok(!/frozen_cents\s*=/.test(src), `public/${f} assigns frozen_cents`);
  }
});

// G6: the engine really does own it — match.js is where the writes are, so
// this guard is protecting something rather than passing vacuously.
check('G6 the matching engine genuinely owns the column', async () => {
  const src = fs.readFileSync(path.join(LIB, 'match.js'), 'utf8');
  const writes = (src.match(/UPDATE\s+orders\s+SET[^;]*frozen_cents/gi) || []).length;
  assert.ok(writes >= 3, `expected the engine to write frozen_cents in several places, found ${writes}`);
});

// ── The WALLET columns ───────────────────────────────────────────────────────
// The outside audit's third fix: the guard covered orders.frozen_cents but
// NOT users.balance_cents / users.frozen_cents — and at the time, the
// withdrawal path in lib/payments wrote balance_cents directly, outside
// ledger.js and outside any enforcement. The module that owns the wallet
// columns is what makes "balance_cents is a cache of the double-entry
// postings" a theorem rather than a hope: a writer that bypasses the posting
// layer breaks assertUserAgrees silently and the player sees a wrong balance.
// That writer moved into ledger.withdrawHold; these checks pin it there.
const WALLET_ALLOWED = {
  'ledger.js': 'the posting layer: the only module that writes the wallet columns AND their double-entry counterparts together',
};

// G7: no module outside the allowlist UPDATEs the wallet columns.
check('G7 only ledger.js writes users.balance_cents / users.frozen_cents', async () => {
  const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    if (WALLET_ALLOWED[f]) continue;
    const code = fs.readFileSync(path.join(LIB, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (/UPDATE\s+users\s+SET[^;]*(balance_cents|frozen_cents)/i.test(code)) {
      offenders.push(f);
    }
  }
  assert.deepStrictEqual(offenders, [], `unapproved writers of the wallet columns: ${offenders.join(', ')}`);
});

// G8: server.js — the largest file and the likeliest landing spot for an
// "emergency" balance fix — must not write them either.
check('G8 the HTTP layer never writes the wallet columns', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/UPDATE\s+users\s+SET[^;]*(balance_cents|frozen_cents)/i.test(src), 'server.js writes the wallet columns');
});

// G9: the OPENING balance is the one legitimate write outside an UPDATE — an
// INSERT at account creation, validated to a non-negative integer by
// createAccount. Pin it to auth.js so nobody else mints starting balances.
check('G9 only auth.js inserts an opening balance', async () => {
  const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    if (f === 'auth.js') continue;
    const code = fs.readFileSync(path.join(LIB, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (/INSERT\s+INTO\s+users[^;]*balance_cents/i.test(code)) offenders.push(f);
  }
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  if (/INSERT\s+INTO\s+users[^;]*balance_cents/i.test(srv)) offenders.push('server.js');
  assert.deepStrictEqual(offenders, [], `unapproved opening-balance inserts: ${offenders.join(', ')}`);
});

// G10: the guard is not vacuous — ledger.js really is where the writes are.
check('G10 ledger.js genuinely owns the wallet columns', async () => {
  const src = fs.readFileSync(path.join(LIB, 'ledger.js'), 'utf8');
  const writes = (src.match(/UPDATE\s+users\s+SET[^;]*(balance_cents|frozen_cents)/gi) || []).length;
  assert.ok(writes >= 4, `expected ledger.js to write the wallet columns in several places, found ${writes}`);
});

// G11: NO SOURCE FILE MAY CARRY A MACHINE-ABSOLUTE PATH.
//
// This exists because one did. tests/reporting-findings.test.js was generated
// from a scratch script under /tmp, and a leftover
// `require('/home/Joel/Desktop/OpenBettingExchange/lib/config')` shipped
// committed. It was unused, so locally it cost nothing and the suite was green;
// in CI it failed with "Cannot find module '/home/Joel/Desktop/...'" and took
// the whole Test job and the Repository-guards job red with it.
//
// The failure mode is what makes this worth a guard rather than a one-line fix:
// a test that passes on the machine that wrote it and fails everywhere else. A
// generated or copied test is exactly how that happens, and nothing in the
// offline suite would have caught it — only CI, after a push.
check('G11 no source or test file carries a machine-absolute path', async () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs|json)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, 'utf8')
        // Strip comments before matching, exactly as G4/G5 do. A comment that
        // QUOTES the offending pattern (as this check's own note does) is
        // documentation, not a broken require, and a guard that flags its own
        // comment is a guard people learn to ignore.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // Matches an absolute path under a home directory, or any absolute
      // require/import of a project path that is not relative.
      const m = src.match(/(?:require\(|from\s+)["'](?:\/home\/|\/Users\/|\/root\/)[^"']*["']/g);
      if (m) offenders.push(`${path.relative(ROOT, full)}: ${m[0]}`);
    }
  };
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'tests'));
  walk(path.join(ROOT, 'scripts'));
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  if (/(?:require\(|from\s+)["'](?:\/home\/|\/Users\/|\/root\/)[^"']*["']/.test(srv)) offenders.push('server.js');
  assert.deepStrictEqual(offenders, [], `machine-absolute paths: ${offenders.join('; ')}`);
});

// G12: a module declares 'use strict' AT MOST ONCE.
//
// This exists because lib/cashout.js did: the directive sat on line 1 and again
// on line 45, immediately after the 43-line file header. Harmless to the runtime
// — and that is exactly why it is worth a guard. A second directive is invisible
// in every sense: it changes no behaviour, so nothing else in the suite could
// ever notice it, and its only effect is to make the top of the file ambiguous
// about where the header ends. It reads as a merge accident, because it is one.
//
// The check counts the directive rather than testing for a particular style, so
// it cannot fire on a module that simply omits the directive (a CommonJS module
// is not strict by default, but adding one is a separate convention and this
// guard has no opinion about it). Comments are stripped first, so a directive
// quoted inside a comment — as this check's own note does — is documentation
// rather than a duplicate.
check('G12 no module declares "use strict" twice', async () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const count = (src.match(/^\s*['"]use strict['"];?/gm) || []).length;
      if (count > 1) offenders.push(`${path.relative(ROOT, full)}: ${count}`);
    }
  };
  walk(LIB);
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  if ((srv.match(/^\s*['"]use strict['"];?/gm) || []).length > 1) offenders.push('server.js');
  assert.deepStrictEqual(offenders, [], `modules declaring 'use strict' more than once: ${offenders.join(', ')}`);
});

// G13: a leg's escrow is accumulated into exactly ONE variable.
//
// lib/settle.js's cashoutPosition carried two accumulators — `frozenRelease`
// and `transferred` — both summing `legFrozen` on adjacent lines, and both
// returned. They can never differ: the collateral the player releases and the
// escrow the house takes on per leg are the same number moving between
// balances. Two names for one number is a promise of a distinction that does
// not exist, and it is two variables free to drift the next time somebody edits
// one of them.
//
// This cannot be caught by asserting the two are EQUAL: they were equal before
// the fix and after it, so such a test passes with the duplication present —
// the trap of a test that cannot fail. The duplication IS the defect, so the
// guard counts the accumulations.
//
// Comments are stripped first, so the explanation of why there is now only one
// (which necessarily names both) is not read as a second accumulation.
check('G13 a cash-out leg escrow is accumulated once, not into two variables', async () => {
  const src = fs.readFileSync(path.join(LIB, 'settle.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const fn = src.match(/function cashoutPosition\([\s\S]*?\n}\n/);
  assert.ok(fn, 'cashoutPosition still exists');
  const accumulations = [...fn[0].matchAll(/(\w+)\s*\+=\s*legFrozen\b/g)].map((m) => m[1]);
  assert.deepStrictEqual(
    accumulations,
    ['frozenRelease'],
    `legFrozen is accumulated into ${JSON.stringify(accumulations)} — one variable, not two`
  );
  // And the response field it feeds is documented as an alias rather than a
  // second quantity, so a client does not read the pair as independent.
  assert.match(
    fn[0],
    /transferred_cents:\s*frozenRelease/,
    'transferred_cents is returned as an alias of frozen_release_cents, not from a second accumulator'
  );
});

(async () => {
  // Drain the collected checks IN ORDER, awaiting each. A check that rejects
  // is a failure of this suite, not of the next file: exiting here stops
  // the rest of this suite running rather than letting a broken assertion
  // print a green line for a body that never completed.
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (e) {
      console.error(`  FAIL ${name}`);
      console.error(e);
      process.exit(1);
    }
    passed++;
    console.log('  ok', name);
  }
  if (passed < 13) { console.error("expected 13 checks"); process.exit(1); }
  console.log(`\nguard.test.js: ${passed} checks passed`);
})();
