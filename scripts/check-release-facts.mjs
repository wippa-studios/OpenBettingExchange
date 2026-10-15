#!/usr/bin/env node
// scripts/check-release-facts.mjs — the changelog, the tags and package.json must agree.
//
// WHY THIS EXISTS (#84). Every other check in this repository asks one question:
// "does this doc match the code?" `check-docs.mjs` compares claims to source.
// `check-env-example.mjs` derives a surface from source and compares the example
// file to it. Both are the same shape, and both are structurally blind to one
// thing — a claim about something that DOES NOT EXIST.
//
// CHANGELOG.md carried `## [0.1.0] - 2026-09-24` and `## [0.2.0] - 2026-09-25`
// with substantive entries, on the repo's first two days. `git tag` returns
// NOTHING and `package.json` says `0.1.0`. So two dated releases were documented
// that were never tagged, and the changelog and the manifest disagree with each
// other and with the tags. Not one of the three was derived from the other two.
//
// This is the same blind spot class as the `<<<<<<< HEAD` markers committed in
// docs/API.md by `0597862` (caught and fixed at `3f9d648`, which added
// scripts/check-conflict-markers.mjs) and described in STATE.md §1: every other
// assertion here reads a file and reasons about what it SAYS, so a file that is
// absent — a tag that was never cut — is invisible to all of them. A checker
// cannot contradict a fact that is missing.
//
// Why that matters here more than in a normal repo: this project's stated goal
// is "an exchange usable by third parties", and the first thing a third party
// checks is whether the thing has ever been released. Today the honest answer and
// the documented answer are different, and only one of them is a fact.
//
// WHAT IS ASSERTED. Exactly two things, both mechanical, both derived:
//
//   1. Every `## [x.y.z] - YYYY-MM-DD` heading in CHANGELOG.md has a git tag.
//   2. package.json's version equals the HIGHEST released heading in CHANGELOG.md.
//
// WHAT IS NOT ASSERTED, AND WHY. Whether [0.1.0] and [0.2.0] SHOULD exist is an
// authorial decision, not a mechanical one, and this script takes no position on
// it. It reports which of the three sources disagree, and stops.
//
// ---------------------------------------------------------------------------
// ANTI-VACUITY. The whole class of defect this file is for is a FALSE PASS, so
// the ways this check could pass without checking anything are closed first:
//
//   - A SHALLOW CHECKOUT HAS NO TAGS, AND "NO TAGS" READS IDENTICALLY. The
//     default `actions/checkout` fetches depth 1 and no tags, so a check that
//     compared a changelog against `git tag` in CI would report "0 tags, both
//     releases untagged" on a repository whose tags were merely never fetched —
//     a confident, specific, FALSE accusation, produced by the harness rather
//     than by the repo. That is the single worst thing this script could do, so
//     it refuses to run on a shallow repository and says so. The CI step fetches
//     full history to keep this honest; see the comment on that step.
//   - If `git tag` cannot run at all, or CHANGELOG.md has no `## [` heading in
//     any shape, or a level-2 heading is neither `Unreleased` nor a dated
//     release, this FAILS LOUDLY. A check that cannot parse its input must not
//     report agreement — the vacuous pass is worse than no check, because it
//     reports and does not act.
//   - Tag NAMES are accepted in both conventions (`v0.1.0` and `0.1.0`). The
//     assertion is "a tag exists for this release", not "this project uses a
//     particular tag style", and enforcing a style would fail a correct repo on
//     a technicality. Whichever matched is reported, so the convention in use is
//     visible without being asserted.
//   - ZERO released headings is a legitimate PASS, not a vacuous one: nothing
//     released, nothing to tag. It is reported in those words rather than as
//     "consistent", because "consistent" would imply it verified something.
//
// Exit 0 when the three agree. Exit 1 otherwise, naming each disagreement.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const bail = (title, lines) => {
  console.error(`\ncheck-release-facts: CANNOT VERIFY — ${title}\n`);
  for (const l of lines) {
    console.error(`  ${l}`);
    console.error(`  ::error::${l}`);
  }
  console.error('\n  This is NOT a claim that the release record is consistent. Refusing to\n');
  console.error('  report agreement on an input this check could not read.\n');
  process.exit(1);
};

// ── 1. The tags ────────────────────────────────────────────────────────────
// Checked for fetchability BEFORE anything is compared to them. See ANTI-VACUITY.

let shallow;
try {
  shallow = git(['rev-parse', '--is-shallow-repository']);
} catch (e) {
  bail('this is not a git repository, or git could not be run', [
    `git rev-parse failed: ${String(e.message).slice(0, 160)}`,
  ]);
}
if (shallow === 'true') {
  bail('the checkout is shallow, so it has no tags to compare against', [
    'git rev-parse --is-shallow-repository reports true.',
    'A shallow checkout fetches no tags, so "no tags" here cannot be',
    'distinguished from "this project has never been tagged". Acting on that',
    'difference would report a repository as fabricating a release history when',
    'the harness simply did not download one.',
    'Fix: fetch history and tags (CI: `fetch-depth: 0` on checkout).',
  ]);
}

let tags;
try {
  tags = git(['tag', '--list']).split('\n').map((s) => s.trim()).filter(Boolean);
} catch (e) {
  bail('`git tag --list` could not be run', [String(e.message).slice(0, 160)]);
}

// ── 2. The released headings ───────────────────────────────────────────────

const changelogPath = join(ROOT, 'CHANGELOG.md');
if (!existsSync(changelogPath)) {
  bail('CHANGELOG.md does not exist', ['there is no release record to verify']);
}
const changelog = readFileSync(changelogPath, 'utf8');

// Every level-2 heading, in full — not every heading that happens to parse. A
// heading this check silently ignores is a heading it cannot make a claim about,
// and `[0.2.0] - unreleased` or `## [0.3.0]` with no date is exactly the shape
// that means something and must not be skipped by a pattern.
const rawHeadings = [...changelog.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
if (rawHeadings.length === 0) {
  bail('CHANGELOG.md contains no `## ` headings at all', [
    'expected at least `[Unreleased]` and any released versions',
  ]);
}

// A version is three dot-separated integers. Deliberately narrow: a heading like
// `## [1.0.0-rc.1] - 2026-10-01` is refused rather than guessed at, because
// comparing pre-release identifiers to a package.json version is a policy
// question (does `1.0.0-rc.1` outrank `1.0.0`?) and this check has no business
// answering one. Refusing is loud; guessing is quiet.
const SEMVER_CORE = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const releases = [];
const malformed = [];
let unreleasedCount = 0;
for (const h of rawHeadings) {
  // Keep a Changelog's shape is `## [x.y.z] - YYYY-MM-DD` with an
  // `## [Unreleased]` for the rest. The brackets wrap the VERSION only, never the
  // date, so they cannot be stripped with a single `\[(.+)\]` on the whole
  // heading — an earlier version of this parse did exactly that, matched
  // nothing, and reported both real releases as unrecognised.
  const bracket = h.match(/^\[([^\]]+)\](?:\s+-\s+(\S+))?\s*$/);
  if (bracket) {
    const [, label, date] = bracket;
    if (label === 'Unreleased') {
      unreleasedCount++;
      continue;
    }
    if (!date || !SEMVER_CORE.test(label) || !DATE.test(date)) {
      // A version with no date is the shape that means something and asserts
      // nothing: it reads as a shipped release with the evidence removed. That
      // is the #84 defect with the date deleted, so it is refused, not skipped.
      malformed.push(h);
      continue;
    }
    releases.push({ version: label, date, heading: h });
    continue;
  }
  // Unbracketed `## Unreleased` is also accepted; it is the older Keep a
  // Changelog spelling and carries no claim about a release.
  if (h === 'Unreleased') {
    unreleasedCount++;
    continue;
  }
  malformed.push(h);
}

if (malformed.length) {
  // Keep a Changelog allows "Unreleased" as the only un-dated heading. Anything
  // else un-dated is ambiguous: a draft release that reads as a shipped one is
  // the exact defect #84 describes, so it is refused rather than tolerated.
  bail(`CHANGELOG.md has ${malformed.length} level-2 heading(s) that are neither \`Unreleased\` nor a dated release`, [
    ...malformed.map((h) => `unrecognised heading: ## ${h}`),
    'expected `## [x.y.z] - YYYY-MM-DD`, or `## [Unreleased]`.',
    'A release heading with no date reads as shipped while asserting nothing',
    'was ever shipped — see #84.',
  ]);
}

// Highest by version, numerically. A string sort puts 0.10.0 below 0.9.0, and
// this repository has already shipped enough patch-level churn for that to bite.
function highest(list) {
  return list.reduce((best, r) => {
    if (!best) return r;
    const a = r.version.split('.').map(Number);
    const b = best.version.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] > b[i] ? r : best;
    }
    return best;
  }, null);
}

// ── 3. package.json ────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const pkgVersion = typeof pkg.version === 'string' ? pkg.version : null;
if (!pkgVersion) {
  bail('package.json has no usable `version`', [
    `found: ${JSON.stringify(pkg.version)}`,
  ]);
}

// ── The two assertions ─────────────────────────────────────────────────────

const problems = [];
const fail = (msg) => problems.push(msg);

const tagFor = (version) => tags.find((t) => t === version || t === `v${version}`);

if (releases.length === 0) {
  // Not a vacuous pass, and said so. Nothing is claimed as released, so there is
  // nothing to tag and no highest release to compare a version against.
  console.log(
    `check-release-facts: clean — CHANGELOG.md claims NO releases ` +
      `(${unreleasedCount} Unreleased heading(s), 0 dated), so there is nothing to have ` +
      `tagged. Verified nothing about tags beyond that. package.json is ${pkgVersion}.`
  );
  process.exit(0);
}

for (const r of releases) {
  const tag = tagFor(r.version);
  if (!tag) {
    fail(
      `CHANGELOG.md documents a release [${r.version}] dated ${r.date} and there is no git tag for it. ` +
        `The repository has ${tags.length} tag(s) in total` +
        (tags.length ? `: ${tags.join(', ')}` : '') +
        `. A dated release heading with no tag is a release that did not happen.`
    );
  }
}

const top = highest(releases);
if (pkgVersion !== top.version) {
  fail(
    `package.json says ${pkgVersion}; the highest released heading in CHANGELOG.md is ` +
      `[${top.version}] - ${top.date}. The manifest and the changelog must agree on which ` +
      `version this repository is at.`
  );
}

// ── Report ─────────────────────────────────────────────────────────────────

if (problems.length) {
  console.error(`\ncheck-release-facts: FAILED — ${problems.length} disagreement(s) between the release record and the repository.\n`);
  for (const p of problems) {
    console.error(`  x ${p}`);
    console.error(`  ::error::${p}`);
  }
  console.error(
    `\n  CHANGELOG.md claims ${releases.length} release(s): ${releases
      .map((r) => `[${r.version}]`)
      .join(', ')}. git tag reports ${tags.length}.\n`
  );
  console.error('  Which of these is right is an author decision (#84), not something a script can\n');
  console.error('  choose. Until it is made, this project\'s documented release history and its actual\n');
  console.error('  release history are different, and a reader cannot tell which one is real.\n');
  process.exit(1);
}

console.log(
  `check-release-facts: clean — ${releases.length} released heading(s), each with a tag ` +
    `(${releases.map((r) => `${r.version}→${tagFor(r.version)}`).join(', ')}); ` +
    `package.json agrees at ${pkgVersion}.`
);