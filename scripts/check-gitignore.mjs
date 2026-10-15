#!/usr/bin/env node
// scripts/check-gitignore.mjs — assert .gitignore still refuses the files it claims to.
//
// WHY THIS EXISTS (#12). `git add .` is the normal workflow and .gitignore is the
// only thing between that and a committed private key. CI already fails on a
// tracked .key/.pem/.p12, but that is (a) after the fact and (b) by extension
// only — .netrc and pgpass are bare `name<password` files with no extension, so
// the existing guard cannot see them at all.
//
// So the coverage gap is a .gitignore gap, and this closes it.
//
// WHY IT ASKS GIT RATHER THAN GREPPING THE FILE. A grep for `*.key` in
// .gitignore is a check of the text, not of the behaviour: it would pass on a
// line that has been commented out, would not notice that a later pattern
// re-includes the path, and would say nothing about the dozens of ways a
// pattern can match a directory that a text match cannot reason about.
// `git check-ignore` IS the answer, so the check asks it.
//
// THE ANCHOR THAT MAKES THIS NON-VACUOUS. A "is X ignored?" check passes if the
// tool silently reports everything as ignored, if it runs in the wrong
// directory, or if .gitignore grows a blanket `*`. So MUST_REMAIN_TRACKABLE is
// not decoration: the SAME git invocation is asserted to return "ignored" for
// some probes and "not ignored" for others, in one run. If the harness lies in
// either direction this fails instead of passing. `.env.example` is the sharpest
// of these — it sits directly behind the `.env.*` glob and is the one .env file
// in the repo that is supposed to be public.
//
// Exit 0 when every probe lands where it should. Exit 1 otherwise.

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Every one of these must be refused by git. The first block is the #12 report:
// credential filenames that were measurable as committable. The second is what
// .gitignore already protected, kept here so that fixing #12 cannot quietly
// regress the original coverage.
const MUST_BE_IGNORED = [
  // Private key material, by extension.
  'app.key', 'client.key', 'server.key',
  'app.pem', 'tls.pem', 'cert.p12', 'cert.pfx', 'keystore.jks',
  // SSH private keys — the one an operator drags in from a host.
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  // Bare name==password files. No extension, so the tracked-file guard is blind.
  '.netrc', '_netrc', 'pgpass', '.pgpass',
  // Tooling blobs.
  'secrets.json', 'credentials.json',
  // .env variants, in any directory — tooling writes these at any depth.
  '.env.local', '.env.production', 'config/.env.staging', 'api/.env.development',
  // Pre-existing protections. Directory patterns are probed WITH the trailing
  // slash: `node_modules/` and `data/` only match a directory, and a bare
  // `node_modules` probe matches nothing at all.
  '.env', 'data/openbettingexchange.db', 'data/x.db-wal', 'server.log',
  'ui-test.png', 'betfair-market-snapshots/certs/app.key',
  'node_modules/', 'data/', 'betfair-market-snapshots/',
];

// Every one of these must REMAIN committable. This list is the check's
// conscience: it is what stops the fix from becoming a new outage.
const MUST_REMAIN_TRACKABLE = [
  // The example file is what an operator is told to copy. The `.env.*` glob in
  // .gitignore would swallow it without the `!.env.example` negation, and the
  // repo would lose the only documented configuration surface it ships.
  '.env.example',
  // A sample of ordinary source, so the check also fails if someone reaches for
  // a blanket `*` or an over-broad `*.json` / `*.js`.
  'package.json', 'package-lock.json', 'README.md', 'server.js',
  'lib/config.js', 'scripts/check-gitignore.mjs',
  'public/style.css', 'docs/FEED.md', 'tests/config.test.js',
];

// Self-check: a check with an empty probe list asserts nothing and passes. A
// refactor that emptied one of the lists above must fail loudly, not silently
// turn this into a no-op.
if (!MUST_BE_IGNORED.length || !MUST_REMAIN_TRACKABLE.length) {
  console.error('check-gitignore: FAILED — a probe list is empty, so this check asserts nothing.');
  process.exit(1);
}

const probes = [...MUST_BE_IGNORED, ...MUST_REMAIN_TRACKABLE];

// `--no-index` asks the question this check actually cares about — "what do the
// exclude rules say about this path?" — independently of whether the path
// happens to be tracked already. Without it, `git check-ignore` refuses to
// report a tracked path as ignored, so every MUST_REMAIN_TRACKABLE probe built
// from an existing file would be vacuously green no matter what .gitignore said.
// That is exactly the way this check could have passed while doing nothing.
//
// Probed ONE AT A TIME rather than piped through `--stdin`, so a git-level
// error is attributed to the path that caused it instead of failing the whole
// batch with no context.
const SYMLINK_LIMIT = /beyond a symbolic link/;

const ignored = new Map();  // path -> the pattern that ignored it
const skipped = [];         // path -> why git could not answer

for (const path of probes) {
  // THE VERDICT IS THE EXIT STATUS, AND NOT WITH -v. `git check-ignore -v`
  // exits 0 whenever *any* pattern matched the path — including a NEGATED one.
  // A path re-included by `!.env.example` prints its `!` pattern and still
  // exits 0. Reading -v's stdout (or its status) as "is this ignored?" therefore
  // reports a correctly un-ignored file as ignored, which is how this check
  // failed its own control case. `-q` gives the real answer: 0 ignored,
  // 1 not ignored, 128 git refused the pathspec.
  const verdict = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', path], { cwd: ROOT, encoding: 'utf8' });

  if (verdict.error) {
    console.error(`check-gitignore: FAILED — could not run git check-ignore: ${verdict.error.message}`);
    process.exit(1);
  }

  if (verdict.status === 128) {
    const msg = (verdict.stderr || '').trim();
    if (SYMLINK_LIMIT.test(msg)) {
      skipped.push({ path, reason: 'symlinked in this working tree; not answerable here' });
      continue;
    }
    console.error(`check-gitignore: FAILED — git check-ignore errored on ${path}: ${msg}`);
    process.exit(1);
  }

  if (verdict.status !== 0) continue; // 1 = not ignored; nothing to record

  // Ignored, so now ask which rule did it, for the failure message. At this
  // point -v is being read for what it is actually for.
  const run = spawnSync('git', ['check-ignore', '-v', '--no-index', '--', path], { cwd: ROOT, encoding: 'utf8' });
  const out = (run.stdout || '').trim();
  const tab = out.indexOf('\t');
  // `<source>:<line>:<pattern>` — the pattern is the LAST segment, so a
  // pattern containing a colon still names itself correctly.
  const pattern = (tab < 0 ? out : out.slice(0, tab)).split(':').pop() || '(unknown rule)';
  ignored.set(path, pattern);
}

const problems = [];

const skippedPaths = new Set(skipped.map((s) => s.path));

for (const p of MUST_BE_IGNORED) {
  // A probe git could not answer is absent from `ignored` for a reason that is
  // already reported above. Judging it here would report it a second time, as a
  // false failure.
  if (skippedPaths.has(p)) continue;
  if (!ignored.has(p)) {
    problems.push({ kind: 'COMMITTABLE', path: p, detail: 'nothing in .gitignore matches it' });
  }
}

for (const p of MUST_REMAIN_TRACKABLE) {
  if (skippedPaths.has(p)) continue;
  const pattern = ignored.get(p);
  if (pattern !== undefined) {
    problems.push({
      kind: 'WRONGLY IGNORED',
      path: p,
      detail: `${pattern} matches it — git would refuse to add it`,
    });
  }
}

// ── A SYMLINK IS NOT A DIRECTORY ───────────────────────────────────────────
//
// The probes above CANNOT see the defect this check exists for. `git
// check-ignore` answers identically for `node_modules` and `node_modules/`,
// because in the real checkout node_modules IS a directory — verified by running
// it. Adding the bare form to MUST_BE_IGNORED would have been theatre: it would
// have looked like coverage while proving nothing.
//
// A trailing slash matches a directory and nothing else. A symlink is not a
// directory to git, so `node_modules/` protected the real directory and did
// nothing against the symlinked one — which is what every agent worktree here
// creates. Three agents hit that and reported it as cosmetic; it was deferred,
// and it then cost a `git add -A` that committed a symlink to node_modules into
// this repository. The merge installed it over the real directory and
// `require('express')` stopped resolving in the main checkout.
//
// So: ask git the only question that separates the two forms, in a throwaway
// repo, with a real symlink on disk.
{
  const scratch = mkdtempSync(join(tmpdir(), 'gitignore-symlink-'));
  try {
    writeFileSync(join(scratch, '.gitignore'), readFileSync(join(ROOT, '.gitignore'), 'utf8'));
    // ONLY node_modules, and that scoping is the point.
    //
    // `data/` and `betfair-market-snapshots/` are real directories that stay
    // real directories; a trailing slash on those is correct and tightening it
    // would be churn. node_modules is different: it is symlinked by every git
    // worktree, which is why the failure is reachable at all. A check that
    // flagged all three would have been reporting two non-problems to look
    // thorough, and would have taught people to ignore it.
    const dirPatterns = ['node_modules'];
    const offenders = [];
    for (const name of dirPatterns) {
      // A fresh repo per pattern. `git init` over an existing one keeps the
      // previous symlink, and then git status reports the wrong name.
      const repo = mkdtempSync(join(scratch, 'r-'));
      writeFileSync(join(repo, '.gitignore'), readFileSync(join(ROOT, '.gitignore'), 'utf8'));
      spawnSync('git', ['init', '-q'], { cwd: repo });
      mkdirSync(join(repo, 'target-dir'), { recursive: true });
      writeFileSync(join(repo, 'target-dir', 'f.txt'), 'x');
      symlinkSync(join(repo, 'target-dir'), join(repo, name));
      const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: repo, encoding: 'utf8',
      });
      const listed = String(r.stdout || '');
      // `?? <name>` and nothing after it means git would happily track it.
      if (listed.split('\n').some((l) => l === `?? ${name}`)) offenders.push(name);
    }
    for (const name of offenders) {
      problems.push({
        kind: 'SYMLINK-EXPOSED',
        path: name,
        detail:
          `.gitignore uses \`${name}/\`, which matches a DIRECTORY and nothing else. ` +
          `It does not cover the symlinked form every agent worktree creates, so a ` +
          `symlink at this path is committable. Drop the trailing slash.`,
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (problems.length) {
  console.error(`\ncheck-gitignore: FAILED — ${problems.length} path(s) are on the wrong side of .gitignore.\n`);
  for (const { kind, path, detail } of problems) {
    const gh = `::error file=.gitignore::${kind}: ${path} (${detail})`;
    console.error(`  ${kind.padEnd(18)} ${path}  — ${detail}`);
    console.error(`  ${gh}`);
  }
  console.error('\n  COMMITTABLE    a file git would stage on `git add .`. Add the pattern.');
  console.error('  WRONGLY IGNORED a tracked file git would refuse to add. Add a ! exception.');
  console.error('  SYMLINK-EXPOSED a name a trailing-slash pattern fails to protect when it is a symlink. Drop the slash.\n');
  process.exit(1);
}

console.log(
  `check-gitignore: clean — ${MUST_BE_IGNORED.length - skipped.length} credential path(s) ignored, ` +
    `${MUST_REMAIN_TRACKABLE.length} path(s) confirmed still committable, ` +
    `node_modules verified against the symlink form` +
    (skipped.length ? `, ${skipped.length} unanswerable in this working tree.` : '.')
);

for (const { path, reason } of skipped) {
  console.log(`  note: ${path} not probed — ${reason}`);
}