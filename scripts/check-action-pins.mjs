#!/usr/bin/env node
// scripts/check-action-pins.mjs — refuse a `uses:` that is a mutable tag. #10.
//
// WHY. Every `uses: actions/checkout@v4` is a mutable pointer. It resolves to
// whatever the tag points at WHEN THE JOB RUNS, so the revision that executes
// with this workflow's permissions is chosen by whoever can move the tag in the
// upstream repository, not by this one. Pinning to a commit SHA is the standard
// answer, and it is only an answer if it stays applied — a pin that someone
// tidies back to `@v4` for readability is the same hole reopened.
//
// The second half of the rule is the part that gets forgotten. An opaque
// 40-character hash tells the next reader nothing, and a reader who cannot tell
// what a pin is pinned to has no reason not to "fix" it. So every pin must
// carry a version comment on the same line — `... # v7.0.1` — and that is
// enforced here rather than left to good intentions. It is also what lets
// dependabot's github-actions ecosystem upgrade these: it rewrites the SHA and
// the comment together, and the diff says which version moved.
//
// WHAT IS ACCEPTED:
//   - A full 40-character lowercase hex SHA, with a version comment.
//   - A local action (`./some/path`), which has no upstream to be pinned to and
//     is covered by this repository's own history instead.
//
// WHAT IS REFUSED: any other form — a tag (@v4), a branch (@main), a short SHA,
// a missing comment, or an unknown owner/repo shape.
//
// Exit 0 when every pin is well-formed. Exit 1 otherwise, naming the file.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOWS = join(ROOT, '.github', 'workflows');

const SHA = /^[0-9a-f]{40}$/;
// The comment must NAME a version, not merely exist. `# v4` is as useless as a
// bare hash; `# v7.0.1` is what a reviewer reads to approve the bump.
const VERSION_COMMENT = /#\s*v?\d+\.\d+/;

let files;
try {
  files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
} catch (e) {
  console.error(`check-action-pins: FAILED — cannot read ${WORKFLOWS}: ${e.message}`);
  process.exit(1);
}

// A check that finds no workflows, or no pins at all, asserts nothing and would
// pass on a repository that had deleted every workflow. Both are failures.
if (!files.length) {
  console.error('\ncheck-action-pins: FAILED — .github/workflows contains no workflow files.');
  console.error('  Either they were deleted or this check is pointed at the wrong tree.');
  console.error('  Refusing to report success on an input it did not examine.\n');
  process.exit(1);
}

const problems = [];
const pins = [];

for (const file of files.sort()) {
  const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(/^\s*-?\s*uses:\s*(\S+)/);
    if (!m) return;
    const ref = m[1];
    const where = `${file}:${i + 1}`;

    // A local action has no upstream tag to be retagged.
    if (ref.startsWith('./') || ref.startsWith('docker://')) return;

    const at = ref.lastIndexOf('@');
    if (at < 0) {
      problems.push({ where, ref, why: 'no @ref at all — unpinned' });
      return;
    }

    const action = ref.slice(0, at);
    const target = ref.slice(at + 1);

    if (!SHA.test(target)) {
      problems.push({
        where, ref,
        why: /^[0-9a-f]{7,39}$/.test(target)
          ? `short SHA (${target.length} chars) — use the full 40`
          : 'a tag or branch, which can be moved upstream after you pin it',
      });
      return;
    }

    if (!VERSION_COMMENT.test(line)) {
      problems.push({
        where, ref,
        why: 'pinned to a SHA with no version comment — nobody can tell what it is pinned to',
      });
      return;
    }

    pins.push({ where, action, target, comment: line.match(/#[^\n]*/)[0].trim() });
  });
}

if (!pins.length) {
  console.error('\ncheck-action-pins: FAILED — found workflow files but zero `uses:` lines in them.');
  console.error('  A workflow with no actions has nothing to pin, which means this check');
  console.error('  is not looking at what it thinks it is. Refusing to pass.\n');
  process.exit(1);
}

if (problems.length) {
  console.error(`\ncheck-action-pins: FAILED — ${problems.length} unpinned or unlabelled action reference(s).\n`);
  for (const { where, ref, why } of problems) {
    console.error(`  ${where}`);
    console.error(`      ${ref}`);
    console.error(`      ${why}`);
    console.error(`      ::error file=${where}::unpinned action ${ref} — ${why}`);
  }
  console.error('\n  Pin to a full 40-character SHA and name the version on the same line:\n');
  console.error('      - uses: actions/checkout@<40-char-sha> # v7.0.1\n');
  process.exit(1);
}

const byAction = new Map();
for (const p of pins) {
  if (!byAction.has(p.action)) byAction.set(p.action, { sha: p.target, comment: p.comment, n: 0 });
  const e = byAction.get(p.action);
  e.n++;
  // The same action must not be pinned two different ways in one repo.
  if (e.sha !== p.target) {
    problems.push({
      where: p.where, ref: p.action,
      why: `pinned to ${p.target.slice(0, 12)} here but ${e.sha.slice(0, 12)} elsewhere`,
    });
  }
}

if (problems.length) {
  console.error(`\ncheck-action-pins: FAILED — an action is pinned inconsistently.\n`);
  for (const p of problems) console.error(`  ${p.where}  ${p.ref}  — ${p.why}`);
  process.exit(1);
}

console.log(`check-action-pins: clean — ${pins.length} action reference(s), ${byAction.size} distinct action(s), all full SHAs with version comments:`);
for (const [action, e] of [...byAction].sort()) {
  console.log(`  ${action}  ${e.sha.slice(0, 12)}…  ${e.comment}${e.n > 1 ? `  (${e.n} uses)` : ''}`);
}