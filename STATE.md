# STATE.md — where this project actually is

Written after the 81-issue review and remediation pass. Every number here was
measured, not remembered. Where something is asserted from memory it says so.

**Purpose:** one page that separates *what exists* from *what is needed*, so
nobody has to re-derive it from the issue tracker. It is a snapshot, not a
contract — if it disagrees with the code, the code is right and this file is a bug.

---

## 1. What exists

### It runs, from a clean clone

Verified end to end in a throwaway clone, not on the author's machine:

```
git clone → npm install → npm run seed → npm start → HTTP 200
```

`npm run seed` produces 5 sports, 6 competitions, 12 events, 12 markets, 33
selections, 3 users, and bot liquidity on every open market.

### The engine is real

A back/lay order book with a matching engine, per-order escrow as the single
source of truth, tick-ladder pricing, a venue-buyout cash-out, an in-play bet
delay, per-user abuse limits, responsible-gambling controls, and an operator desk.
*Measured 2026-10-16:* **16,870 lines** across `server.js` and **33 `lib/`
modules**, **13 frontend source files**, and a **64-suite** test suite.

*(This sentence said "47,803 lines across 32 `lib/` modules, 10 frontend files",
written in `4c90586`. It does not reconcile with anything, then or now: `4c90586`
had 16,686 lines in `server.js` + `lib/` and 42,701 including `tests/`, and 33
modules rather than 32. So it was not a number that later drifted — it never
matched a measurable quantity, in a file whose preamble claims every number here
was measured. That is the failure this file exists to record, so it is recorded
here instead. The denominator is now stated rather than left to the reader to
infer, because "lines" without a denominator is exactly how a figure becomes
unfalsifiable.)*

### The safeguards are unusually complete

- **Audit trail** on every consequential action, with a transaction so a mutation
  cannot commit without its audit row.
- **Backup** by `VACUUM INTO` — a transactionally consistent snapshot of a *live*
  database — with integrity verification and retention pruning.
- **Responsible gambling**: deposit limits, session limits, reality checks,
  self-exclusion. All wired, and self-exclusion is unconditional.
- **Error handling** that clamps 5xx to a generic message so internals cannot
  reach a browser.
- **Secrets** are refused rather than stored in plaintext when no encryption key
  is configured.

### Engineering discipline

| | |
|---|---|

| Tests | **1297 checks / 78 suites**, plus a **220-check** Playwright browser suite, also runnable in a seeded random order (**#134**). **Dated snapshot, 2026-10-16** — the preamble above says so, but a reader who lands on this cell does not see the preamble, so it says so here too. These two figures are machine-asserted against `npm test` by `check-docs.mjs`, so they cannot quietly rot; see §1a. |
| CI | **7 jobs, 8 runs** — the `test` matrix runs on node 22 and 24, so there is one more run than job. *(This cell said "8 jobs" for months. It contradicted its own list — which enumerates seven — and `ci.yml` has seven. The 8 is real, but it is runs.)* |
| Supply chain | every action pinned to a full commit SHA, dependabot configured |
| Docs | `check-docs.mjs` **fails the build** when documentation contradicts the code |
| Secrets | a blocking scan of new commits, plus an advisory full-history scan |

The documentation checker is the unusual part. It caught, unprompted: three
stale test counts, an "orphaned" screenshot, a doc claiming the frontend never
calls `/api/branding` (false for months), and a fabricated image link I
introduced while fixing another thing.

### §1a. A correct number presented wrongly, and a wrong number beside it — #103

**The test count in that table was already correct when #103 was filed.** The
filing measured `main` at `7b37ab7`, where this row did say 799/63, and that was
true of that commit. But `b3bc325` — `docs: STATE.md refreshed — real counts` —
had already replaced it with 817/64 about seven minutes after the issue was
opened, so by the time anyone read the report the number was right. Worth
recording rather than skipping: a report that measures a pinned commit goes stale
the moment the commit it measured is no longer the tip, and "the report is out of
date" and "the report was wrong" are different findings.

That was never the substance. The substance is what the filing said next: **the
disclaimer lived in a preamble a reader never reaches.** A search for the test
count, or a link pinned straight to the table, drops someone into a bare number
with no indication that it is a snapshot rather than a live figure. So the marker
is now **in the cell itself**, dated, naming the check that keeps it true.

What changed in the table, all of it found by measuring rather than by reading:

| Cell | Was | Is |
|---|---|---|
| Tests row | 817 checks / 64 suites — correct, but undated and unmarked | same figures, **marked a dated snapshot in the cell**, and asserted against `npm test` by `check-docs.mjs` |
| CI row | **8 jobs** | **7 jobs, 8 runs** — `ci.yml` defines seven jobs; the `test` matrix is what makes eight runs |

The CI row had been wrong the whole time, and it was wrong *against its own
list* — the old text enumerated seven jobs and then said eight. The reader it
misled believed this project ran eight distinct CI jobs, and would have gone
looking for a surface that does not exist. Both figures are now asserted.

`STATE.md` is **not** in `check-docs.mjs`'s document list, deliberately, and the
reason is worth keeping: §2.2 quotes the fabricated `[0.2.0]` changelog verbatim
because quoting it is how that section makes its point, so an unscoped
present-tense count check would demand that its `24 checks` become today's
number and destroy the evidence. So the new assertion is **anchored on the row**,
not on a pattern — it reads the first `| Tests |` and `| CI |` cells in the file
and nothing else, which is why this table's own cells read "Tests row" and
"CI row" rather than reproducing those two anchors and racing them. A wrong
number in that cell fails; the historical quote three sections down cannot fail
it. Both directions are proven: a wrong count fails, and a **deleted** row fails
rather than silently escaping the check.

The `.env.example` key count was the other half of #103, and it got the opposite
treatment, for a reason. There were three numbers for one fact — `README.md` said
**61**, `docs/ROADMAP.md` said **58**, the derived surface is **61** — and the
count now appears in **no** prose at all, only in the pass line of the checker
that derives it. That decision is recorded in `docs/ROADMAP.md` §1 so it is not
quietly undone.

### The checks that watch the *checker* — `3f9d648`

Worth calling out because it is the only class of defect that every assertion in
this repository is structurally blind to. `docs/API.md` shipped to `main` with
live `<<<<<<< HEAD` markers in its route table, committed by a blanket `git add`
during a rebase. All 8 CI runs were green — seven jobs, and the `test` matrix
makes eight. *(This said "8 CI jobs". There were never 8 jobs; the 8 is runs, and
calling it jobs is the same conflation the §1 table above had been carrying.)*

Every assertion here asks *"does this claim match the code?"* A conflict marker is
not a wrong claim — it is the **absence** of a file's intended content. No count,
link, route-coverage or contradiction check can see it, because each one reads
the file and reasons about what it says, and this one says nothing.

The same mistake had already been caught once in a worktree, where a suite died on
`SyntaxError: Unexpected token '<<'`. In `server.js` a marker is a syntax error
and the codebase screams; in markdown it is inert text and waits. The lesson is
the asymmetry, not the bug: **the same mistake is loud in code and silent in
prose**, and there had been a safety net for exactly one of them.

`scripts/check-conflict-markers.mjs` now runs in CI. It matches the 7-character
opening marker at the start of a line and nothing else — matching `=======` alone
would fire on horizontal rules and prose, and a check that cries wolf gets
switched off.

### Governance

MIT licence, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/SECURITY.md`,
PR and issue templates, dependabot, and a Keep-a-Changelog `CHANGELOG.md` with
substantive Security entries.

---

## 2. What is needed

Ordered by how much it changes what the project *is*, not by effort.

### 2.1 An external API contract — the defining gap

**Betfair's Exchange API is their product.** The ecosystem around it is the
reason the exchange has users. This project cannot grow past its own UI without
the equivalent.

As measured on `main` before the work started:

| | |
|---|---|
| API version header | **0 occurrences** |
| Rate limits documented | **0 mentions** in `docs/API.md` |
| Machine-readable error codes | partial — some routes carried `details.code`, most carried nothing |
| Stability promise | none |

**Status: MERGED at `8fe1ee9`.** What it builds, and what is deliberately odd
about it:

- `X-API-Version` on **every** `/api` response including errors, because a client
  most needs to know what it is talking to when it is failing. It is a
  *response* header, not a request one — requiring it would break every existing
  call on the day it landed, and a version you can only opt *out* of is not a
  promise.
- `API_VERSION` is a **standalone constant, not a config key**, while almost
  everything else in `lib/config.js` is deployment config read from the
  environment. That asymmetry is the design: an operator who could set it could
  announce version 2 from a `.env` while still serving version 1, and every
  client trusting the header would be wrong undetectably.
- `X-RateLimit-Limit/-Remaining/-Reset` on **every** response through a limited
  route, not only the 429. A disabled bucket emits **no** headers rather than
  `Limit: 0` — a disabled limit is not a limit of zero, and announcing one tells
  a pacing client to back off against a ceiling that does not exist.
- A machine-readable `code` on every error, via a single `apiError()` shaper all
  44 error responses now route through, so the two response paths cannot drift.

Still open in that area, and it is not small: the SSE stream as a documented
subscription with reconnect semantics. What exists is an *invalidation ping*, not
a market data feed — see `#90`, filed during the Betfair-parity deep dive.

### 2.2 A first release — and a changelog that invents two

Measured, not remembered:

| | |
|---|---|
| `git tag` | **0 tags** |
| `package.json` version | `0.1.0` |
| Was `0.2.0` ever set? | **No** — `git log -S'"version": "0.2' -- package.json` returns nothing |
| `CHANGELOG.md` sections | `[Unreleased]` (343 lines), `[0.2.0] - 2026-09-25`, `[0.1.0] - 2026-09-24` |

**The `-- package.json` is load-bearing, and dropping it makes the answer
backwards.** Without the pathspec the command returns **two** commits, not none:
`656c81c` matches a *transitive dependency's* `"version": "0.2.0"` at
`package-lock.json:302`, and `6ffd1f3` matches STATE.md's own text quoting this
command. So the unscoped form appears to show `0.2.0` being set, and the
conclusion drawn from it would be the opposite of the truth. Scoped to the
manifest it is empty, and `git log -S'"version":' -- package.json` returns
exactly one commit — the scaffold — so this project has only ever been `0.1.0`.
(This row previously quoted the unscoped command and claimed it returned
nothing, which is the precise defect #103 is about: a documented claim that does
not survive running the command it documents.)

So the changelog documents **two releases that never happened**, on the repo's
first two days, with no tags and no version bump behind them. `[0.2.0]` describes

"a real-browser Playwright suite (24 checks)" — that was true on day 2, when the
repository had **8 commits**. It is 220 browser checks and 78 suites now.
For an open-source project this is worse than an absent changelog, because it
answers "is this maintained?" wrongly. A reader concludes there is a release
history; there is none. `[0.2.0]` also contains **two separate `### Fixed`
sections**, which Keep a Changelog forbids.

`check-docs.mjs` does not catch any of it, which is the expected result: the
question it asks is "does this doc match the code?", and a fabricated release is
not a contradiction — it is a claim about a *fact that does not exist*. Same
blind spot class as the conflict markers in §1.

Cutting a real `v0.1.0` needs an authorial decision, not a mechanical fix: fold
`0.1.0`/`0.2.0` into `[Unreleased]` (honest, loses nothing), or keep them as
draft headings marked unreleased. Either way the tag and the `package.json`
version have to be made to agree with each other, which today they do not.

### 2.3 User automation — specced, half-built

The product decision: in-app user bots, rules not code, evaluated server-side.
Decomposed into `#75`–`#81`. **`#75` and `#76` are merged.**

Counterparty, as decided: **a user's own manual orders may fill that user's
rules** — audited and visible. The house must NOT fill bot orders.

Two things carry forward:

- **`#77` is deferred by decision, not by neglect.** `#76` shipped one-shot per
  crossing; the product decision said continuous. One-shot was accepted as
  adequate for now, so `#77` is parked rather than pending.
- **Self-generated P&L is the price of the feature.** With the house excluded
  from filling bot orders and one player on the venue, a rule's only counterparty
  is that player's own manual orders. Every such fill is marked
  `matches.self_crossed` and audited, but a player whose numbers are partly
  self-produced needs to be told in the product, not only in the docs. Carried by
  `#79`/`#81`.

### 2.3a `#75` had not enforced the decision it was meant to enforce

Recorded because of what it says about this project's own bookkeeping. The rule
that the **house must not fill bot orders** had been written into an agent brief
as *already done*. It was not: the sweep's only same-party test was
`o.user_id === userId`, so an automated order was matchable by any other user —
which on this venue is the house bot and nothing else. With the bot requoting
every 5 seconds, **every rule order would have been taken by the desk within a
tick**, and the feature would have looked like it worked while quietly being
desk-filled.

The agent found it by checking. It was the second time this pass that an
instruction I wrote about the repo's state turned out to be wrong.

### 2.4 Known defect: the browser suite is order-dependent — FIXED at `fix/browserorder`

Three clean-`main` runs gave pass / fail / pass. Cause: scenarios in
`ui_test.mjs` settled markets, and a later scenario was written to find a market
still open — it read whatever `[data-settle]` control the desk happened to show,
which after #51 and #52 had run was a market those two had already settled. A
gate that passes or fails on execution order is not a gate.

Fixed. `tests/ui_test.mjs` is now a list of registered scenarios rather than one
long script, and every scenario:

- **builds its own fixture** — a market it creates through `POST
  /api/admin/markets` (the desk lists markets newest-first, so its own is the row
  its controls live on) — and **deletes it in a `finally`**;
- **owns its account**: four throwaway accounts instead of one shared
  `uitester`, because the password-change scenario changed the password the
  registration scenario asserted, and the audit row the desk scenario read was a
  property of the run order;
- **states its preconditions** — `signIn()`, `atMarkets()`, `atAdmin(view)` —
  instead of inheriting whichever page and session the previous one left;
- **restores what it changed** — tenant brand, viewport, bot day-start balance,
  mocked routes and open overlays all go back in a `finally`.

One teardown is deliberately partial, and the reason is the money path: the
fixture deletes catalogue rows but leaves `orders`, `settlements`, `transactions`
and `entries` alone. The ledger is append-only by design, and `orders.frozen_cents`
is escrow a live order still holds — deleting either without the reversing legs
desynchronises `users.balance_cents` from the accounts, which the suite's own
`ledger shows no cache divergence` check (and `/api/admin/readiness` behind it)
is right to fail on.

**Run-order shuffling is a supported mode, not a comment.** `npm run
test:ui:shuffle` runs the same 220 checks in a seeded random order and prints the
seed; `--shuffle=<n>` replays one exactly. Without a shuffle, "each scenario
builds its own fixture" is a claim; with one it is falsifiable, and a shuffle you
cannot replay is a flake you cannot diagnose.

A related assertion was also found to be vacuous — it waited for a row state that
was already true *before* the action under test, so a no-op would have passed.
**That one was already fixed on `main`** by `82528f5` (the #68 batch), which
replaced the `dataset.status === 'open'` wait with the post-condition "the row
offers Suspend again". Verified present in this worktree; the comment recording
the old shape is at `tests/ui_test.mjs`.

### 2.5 Blocked on a person, not on engineering

A live Betfair app key, username and password were committed to this **public**
repository (`9eac3a4`) and purged from HEAD only (`173a68b`), so the value is
still readable with `git log -p`. Every piece of surrounding tooling is built and
green. **Rotation and a history rewrite are the only remaining actions, and
neither is a code change. Tracked in #128.**

### 2.6 Dark mode: colour-vision deficiency is weaker than it looks

Measured across three standard deuteranopia simulations — they disagree, and one
of them says dark is *better* than light, so the honest statement is a range:

```
dark  1.35 – 1.93 : 1
light 1.04 – 3.16 : 1
```

Dark is consistently near the floor. Re-deriving the hexes was attempted and
**rejected**: maximising colour-vision separation drives the pair to white and
teal, destroying the blue/pink identity the ladder depends on. The fix is a
**non-colour secondary channel** (border or shape), not a different hex.

### 2.7 Adapter / plugin seam — discussed, deliberately paused

The seam partly exists: `lib/resultsfeed.js` already normalises provider signals
so the engine is provider-agnostic, and `lib/results.js` injects the transport
rather than hard-wiring it.

The blocker is the price feed, which is bound to Postgres views (`FROM
${feedView(feed)}`), so any adapter inherits Postgres. The deeper blocker is
semantic: an adapter that half-works does not crash, it **produces wrong prices
or wrong market state**, which the engine cannot detect. Any adapter story needs
a conformance suite before it needs adapters.

---

## 3. What is deliberately not here

- **Dark mode as a palette swap.** The light palette is byte-identical by
  constraint and verified: 0 of 22 tokens changed.
- **Netting opposite orders on a slip** (`#68` §2.5). It changes what a position
  *is*; engine semantics, needs a product decision.
- **A bottom tab bar on mobile** (`#68` §2.3). Costs 56px of a screen the ladder
  is already losing, and adds a second navigation metaphor.

---

## 4. How to read the issue tracker

**105 filed, 75 closed, 30 open** — and `#106` exists, so the true count is at
least 106. Measured with `search_issues`, not counted by hand.

GitHub's issue-search index LAGS, repeatedly and in both directions. It reported
`total: 105` while the highest issue number was `106`; earlier it reported 8 open
when 10 existed, and `issue_write` returned `{}` for two creations that had
succeeded. Never treat a count from this API as authoritative without also
reading the highest issue number.

| | |
|---|---|
| Open | `#67` (parent), `#77` (deferred by decision), `#78`–`#81` (specced, not built) |

- **`[high]` / `[medium]` / `[low]`** title prefixes mirror the `priority:P0`, `priority:P1` and `priority:P2` labels. Labels are created on first use when attached to an issue, so the set is not fixed by the tooling. The launch backlog (#138) uses them.
- **A closed issue means the change merged and CI was green**, not that it was
  written.
- **`#76` reports two things it did not build that are still open**: continuous
  semantics (`#77`, now deferred) and the house-participation gap, which it found
  by checking rather than by being told.

## 4a. A second, concurrent line of work exists

Issues `#88`–`#106` were filed on 2026-10-15, 17:04–17:07, during the window this
work was fixing the API contract and the test harness. They are a **Betfair-parity
deep dive**, and they are not mine: `#88` (`applyOutcome` settling a declared
non-runner as a loser — a money-path defect, said to reproduce on `main` today),
`#90` (the SSE stream is an invalidation ping, not a market data feed), `#95`
(no market type; the engine models one shape), `#100` (operator surface), `#106`
(no navigation read model — no `listEventTypes` equivalent).

The launch backlog built from this review is tracked in #138, with the decisions it depends on at #107–#112.

**Nothing in §2 was written with those in mind**, so this file understates the gap
between this venue and Betfair considerably. Read it alongside the tracker, not
instead of it. Three consequences worth acting on:

- **`#88` claimed a reproducible money-path defect on `main`. VERIFIED, and it
  outranked everything in §2** — it lost a bettor's stake rather than omitting a
  feature, so it was fixed before anything else on this list. Measured on the old
  code, a completed race with one declared non-runner settled as a clean finish:
  the backer's stake was gone (`balance_cents` 100000 → 90000), the withdrawn
  selection was still `open`, and `assertConserved` returned **0** throughout.
  The rule table is now consulted per sport, `non_runners` is an independent
  signal rather than a sub-case of `abandoned`, and a selection-level void
  exists. What the issue got **wrong** is in §5.6.
- **`#90` is not in the feed plan's estimate.** The plan's stages do not mention the client-facing SSE stream, so its 13–17 day figure excludes it. An earlier version of this file said the plan had costed streaming as already built. That was wrong, and I made the claim without re-reading the plan.
- **`#95` does not touch §2.6.** The colour-separation decision concerns the colour pair on the ladder, not the market model. An earlier version of this file said a second market shape would invalidate it. That claim was unsupported.

## 5. The failure modes worth remembering

Each of these actually cost something on this pass. They are listed because they
are the ones that a future contributor is most likely to repeat.

1. **A comment that asserts behaviour the code does not have.** Twice caught:
   once in a source-level "test" that was really a regex standing in for a
   behavioural check (deleted in `#76`, not kept alongside), and once in my own
   API-contract comment claiming a promotion mechanism was "already used by the
   tenant and cash-out paths" when tracing showed **zero** sites reached it.
2. **Vacuous tests.** Five at the start of the review, two more in
   `selfcross.test.js`, and one that waited for a state that was already true
   *before* the action under test — so a no-op would have passed.
3. **Harnesses that exit on first failure**, hiding every later check behind the
   first one. Hoist the check, or report all failures.
4. **A branch reporting "all green" while running the wrong dependency.** One
   worktree ran Express 4 against a `^5.3.0` manifest. Run `npm ci` in every
   worktree before trusting a suite.
5. **Assuming the repo's state instead of checking it.** Twice, both times the
   brief was wrong rather than the code being broken.
6. **Testing a KEY when the defect was a COMBINATION.** `#88` is the fourth time
   this pass found a green assertion that structurally could not see the defect,
   and the first time the *assertion itself was the right shape and aimed at the
   wrong thing*. Every declared rule key was reachable — `non_runner` included,
   through the abandoned branch — and the key-reachability check passed while a
   completed race with a withdrawn runner settled that runner as a loser and
   charged a bettor their whole stake. Reach tests the key; the money was in the
   combination of `status` and `non_runners`. `tests/voidrules.test.js` now
   asserts the combination, and every case in it asserts the control beside it
   (the same signal without the withdrawal), so a table that voided or settled
   everything cannot pass either.

   The issue also claimed `tests/voidrules.test.js` existed and that
   `rules-consistency.test.js` held the reachability check. Neither was true: the
   void-rule cases lived in `results.test.js`, and the reachability check is
   `settlement-findings.test.js` (S-F5) — a claim traced from a comment in
   `lib/voidrules.js` that had been wrong for longer than the issue.