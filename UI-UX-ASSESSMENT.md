# UI/UX assessment — OpenBettingExchange

**Branch** `assess/ux` · **base** `origin/main` @ `ab16649` · **date** 2026-10-15
**Screenshots** `ux-shots/` (53 PNGs, all inspected). Captured at 1.5× and palette-reduced
to keep the commit reviewable; the details every finding cites are legible at that size.
**Nothing in this report was implemented.** No file outside this document and `ux-shots/`
was touched.

---

## 0. Method, and what it means for how much to trust this

`scripts/shoot.mjs` carries a rule I inherited: *never save a screenshot you have not
verified, because a screenshot of an empty board is worse than no screenshot — it looks
like evidence.* I wrote a throwaway driver (`/tmp/opencode/ux-shoot.mjs`, outside the
repo) that boots the server on a free port against a temp DB, registers and funds two
players, places matched and resting orders through the real UI, walks every admin
sub-tab, forces server errors and slow responses, and repeats the lot at 390 px. Every
capture is preceded by a DOM assertion that the subject is actually on screen; a failed
assertion skips the shot rather than saving an empty one.

I then wrote a second throwaway probe (`/tmp/opencode/ux-probe.mjs`) for claims that a
screenshot alone cannot settle — computed styles, `getBoundingClientRect` geometry,
API response shapes. Where this report says "measured", it means one of those two
scripts produced a number, and the number is quoted.

47 captures landed in the full UI walk; a second probe run added 6 more targeted at claims
a screenshot could not settle. The four captures that failed did so for reasons that
turned out to be findings rather than harness bugs (see §7.8). The browser reported no
uncaught page errors and no console errors across the whole run, which is worth saying:
nothing below is a crash. Everything here is a page that renders successfully and is wrong.

---

## 1. The constraint, and what it rules out

The brand palette (`style.css:28-58`) and the type system (`Inter`, 14 px base, the
display tracking) are settled and I have not questioned a single value in them. Stating
that plainly matters, because there is one piece of advice that this kind of review
almost always produces, that I am deliberately not producing, and that a reader will
otherwise assume I forgot:

**Dark mode.** It is the obvious free win for any light-only product and it is the first
thing I would ordinarily write. It is out: (a) it is already tracked as `#66` and blocked
by the same constraint you gave me; (b) more importantly, on a trading surface it is not
free. A dark ladder has to re-derive the blue/pink pair against a dark ground, and the
current pair is doing real work — `style.css:39-47` says the two hues "are never allowed
to be near enough" because a ladder where the sides are not instantly distinguishable is
unreadable. Re-tuning two functional hues against a new ground is a design project with
its own contrast testing, not a palette swap, and it would land on the one screen that
must stay fastest to parse. Saying "add dark mode" would be a wish dressed as a finding.

Also ruled out, and not mentioned anywhere else in this report: any colour, font, font
size, type scale, or spacing that exists to express brand identity. That includes the
Inter substitution decision, the `-0.1em` display tracking, the 8 px radius, the blue/pink
pair and the red/green P&L axis. **Structure, layout, hierarchy, density, copy, state
design, interaction and motion are all in scope, and several of the highest-value items
below live there.**

---

## 2. The five that matter, ranked

Ranked by (impact × confidence) ÷ effort. Everything else in §3 and §4 is real but smaller.

---

### 2.1 — The ladder row reads as a monotone ramp, because the best price on each side is at opposite ends. **Betfair is not like this. The repo's own comments say it should not be like this. A test named for the invariant does not check it.**

This is the single highest-value finding in the assessment, and it is the one the repo is
most confident about being right.

**What the code claims.** `style.css:206-212`:

> The two BEST prices must sit directly adjacent, meeting in the middle of the row: back's
> best occupies the rightmost column of the back group, lay's best the leftmost of the lay
> group.

`public/js/board.js:205-212` says the same thing at greater length, and `board.js:246-247`:

> Back arrives sorted high→low and lay low→high, so the best price is index 0 in each;
> reverse the back list to place it nearest the runner.

**What the code does.** Two things combine to invert it. `board.js:248` reverses the back
list (`back.slice().reverse()`), so after the reversal the *worst* back price is the first
child. `style.css:443-445` then parks the first child in `grid-column: 3` — the column
adjacent to the lay group. Net result: **the worst back price is the one that touches the
lay group, and the best back price is pinned to the far left against the runner.**

**Measured.** Geometry probe over all 33 priced runner rows across the 12 ladders on the
board, reading `x` from `getBoundingClientRect` (not DOM order, which is reversed and
misleading here). One sampled runner per ladder:

```
Arsenal         back L→R 2.46 2.44 2.42   lay L→R 2.34 2.36 2.38
  best back 2.46 · touching the runner ✓   touching the lay group ✗ (2.42)
Liverpool       back 2.82 2.80 2.78        lay 2.70 2.72 2.74   → same
Everton         back 3.50 3.45 3.40        lay 3.10 3.15 3.20   → same
Sinner          back 2.00 1.99 1.98        lay 1.90 1.91 1.92   → same
…  12 of 12 sampled ladders: backBestNextToLayGroup = false, on every row.
```

Look at the Arsenal line again as a trader would: **2.46 2.44 2.42 │ 2.34 2.36 2.38**. The
whole row is one descending ramp. There is no peak, no valley, no junction. The two prices
that meet in the middle are the *worst* back (2.42) and the *best* lay (2.34) — which is
also, incidentally, the most visually prominent cell boundary in the row because it is
where blue hands over to pink.

**What Betfair does.** Betfair's classic Exchange ladder puts the **runner name in the
centre**, with back prices to its left and lay prices to its right, best price on each
side adjacent to the name. So the row reads `worst back … best back │ RUNNER │ best lay …
worst lay` — a clear V whose point is the two prices you would actually trade at. Our
runner is at the far *left* edge (`style.css:352-362`, `grid-template-columns: minmax(150px,
1.6fr) repeat(3,…) repeat(3,…)`), so the invariant "the two best prices are adjacent" is
geometrically impossible to satisfy and only one of them can touch the runner.

**The test that should have caught it does not.** `tests/ui_test.mjs:203-208` is named
*"the best back and best lay prices sit directly adjacent"*. It sorts `backLive` by
descending `x` and `layLive` by ascending `x`, then asserts
`layLive[0].x - (backLive[0].x + backLive[0].w) <= 6`. That measures **whether the two
*groups* touch**, not whether the two *best prices* touch. It passes on the broken layout
because the rightmost back cell is always adjacent to the leftmost lay cell. My own probe
re-implemented that same assertion (`P4`) and it reports `gap=4px` on all 33 rows — green,
and meaningless.

**Effort** S. **Fix options**, in order of preference:
1. Move the runner column between the two price groups (Betfair's shape). One
   `grid-template-columns` reorder plus the `atleft`/`atright` flips. This is the fix I
   would choose: it makes the invariant expressible at all.
2. If the runner must stay left, drop the `.reverse()` at `board.js:248` and flip
   `atright` to `atleft` so the best back price lands in the column touching the lay group.
   Cheaper, and restores the comment's literal claim, but still leaves a monotone ramp.

**What it costs.** Option 1 moves the runner name to the middle of the row, which is a
visible change to the board's most-seen surface and will invalidate the eight geometry
assertions at `tests/ui_test.mjs:152-213`. Option 2 costs nothing but leaves the ramp. I
am not proposing a third option that adds a best-price marker, because a marker would be
adding furniture to the screen that exists precisely so you do not need one.

**Strongest argument against me.** *The cells are colour-coded blue/pink and labelled, so
a trader reads "which price is best" from the ladder's shape, and the current shape is
fine because the best price on each side is always the one nearest the runner name — which
is a perfectly learnable convention.* That is a real argument and it is why option 2 is
tempting. It fails because it only holds for the back side: the best lay price is never
near the runner, so the convention teaches the right answer on one side and the wrong one
on the other. A convention that is right half the time is worse than none. **Second
counter-argument:** someone may say the ramp is actually good — a descending row means
your eye slides from best-back down to best-lay without backtracking. That is a
legitimate reading of the current shape and I cannot rule it out from a screenshot. See
the falsification test.

**What would falsify 2.1.** A time-and-motion test with 6 experienced exchange traders on
this ladder vs. a runner-centred variant, asking them to point at "the best price to back
this runner" within 2 seconds, with error rate and time as the measures. *If the
runner-centred variant does not reduce either*, my finding is wrong and the current layout
should be left alone. Cheaper and nearly as good: an eye-tracking comparison. A third
falsifier: if I am wrong about the direction, the fix is one line — reverse the stacking —
so the downside of being wrong is small. That is the main reason I rank this first despite
the uncertainty: **the cost of the mistake is bounded, and the current state contradicts
the repo's own documentation in a way that will otherwise propagate.**

---

### 2.2 — The account panel is not a modal. It is a permanent block at the bottom of every page, and "opening" it does nothing.

`public/index.html:98` declares `<div id="accountModal" data-persist role="dialog"
aria-modal="true">`. `style.css:631` hides overlays with the selector pair
`#authModal, .modal { display: none }` and `style.css:641` shows them with
`#authModal.show, .modal { display: flex }`.

**`#accountModal` matches neither selector.** It is not `#authModal` and it does not carry
the `.modal` class. There is **no CSS rule anywhere in the repository that mentions
`#accountModal`** — measured by walking every `cssRules` of every stylesheet in the
browser:

```
P1 accountModal, closed:
  display: "block"     position: "static"    width: 1440   height: 241
  top (in document flow): 3228px            on screen right now: false
  cssRuleMentioningAccountModal: null
```

So `openOverlay()` adding `.show` (`core.js:252`) and `closeOverlay()` removing it
(`core.js:267`) toggle a class that nothing styles. The panel is a full-width static block
at the very bottom of `<body>`, permanently rendered.

**Where it shows up.** It is invisible on the Exchange page, because the board is ~3200 px
tall and pushes it off-screen. It is **on screen on every short page**: My Bets, Wallet,
and all ten admin tabs. `ux-shots/13-my-bets-open-orders.png`,
`ux-shots/16-wallet.png`, `ux-shots/20-my-bets-settled-rows.png`,
`ux-shots/25-admin-risk.png` and every admin shot show a full-width black **"Change
password"** bar spanning the viewport below the content, plus the session rows bleeding in
underneath it. `ux-shots/45-mobile-positions.png` shows the worst case: on a phone, "Account
/ Current password / New password" renders inline as what looks like a legitimate section
of the My Bets page, at natural size, unmissable.

This is the repo's documented failure mode — a comment describing behaviour the code does
not have — at its most visible. `core.js:257-267` contains a careful, correct paragraph
about `data-persist` overlays being hidden rather than removed, and `shell.js:189-199`
faithfully calls `openOverlay`. Every layer of the mechanism works. The CSS rule that makes
it a modal was never written.

**Effort** XS. One rule: `#accountModal { display: none } … #accountModal.show { display: flex }`,
mirroring `style.css:631/641`. I am not applying it — it is in "cheap wins" below.

**Second-order consequence worth naming.** Because the panel is always in the DOM and always
visible, `core.js:274-291 trapTab()` filters focusable nodes by `offsetParent !== null`, so
its inputs count as "visible" and are eligible for the focus trap — but the trap only runs
while `#accountModal` is on the overlay stack. Meanwhile a screen-reader user tabbing
through My Bets reaches the password form as ordinary in-flow content, with no dialog
announcement, no `aria-modal` honoured (the attribute is set, but there is nothing to
hide), and no focus return.

**Strongest argument against.** *"It's cosmetic — the form still works, the button still
posts, the panel still shows your sessions."* True, and it is why this has survived. But
"it still works" is not the bar for a surface that claims `aria-modal="true"`: an
assistive-tech user is told a modal exists, none exists, and focus walks into the page
behind it. The cost of the fix is one CSS rule; the cost of not fixing it is that the
account panel cannot be redesigned until it is.

---

### 2.3 — On a phone the whole application renders at 52% scale, and the entire lay side of every ladder is off-screen.

`style.css:730-751` has exactly two breakpoints: below 1000 px the rail becomes a drawer
and the search box is hidden; below 900 px `main` stacks and the slip goes full width.
There is no rule that makes the ladder, or the header, fit a phone.

**Measured at 390 × 844, signed in:**

```
layout viewport width        750 px      ← the browser grew it
visual scale                 0.52        ← 390/750; everything renders at half size
header scrollWidth           750 px      (clientWidth 390)
ladder minimum width         570 px      ← .lrow's own floor
body scrollWidth             750 px      horizontal scroll also present
```

`document.documentElement.scrollWidth > 390` is `true`, and Chrome's shrink-to-fit has
already zoomed the page out to 0.52 to accommodate it. The ladder's floor is structural:
`style.css:356-359` declares `minmax(150px, 1.6fr) repeat(3, minmax(70px, 1fr)) repeat(3,
minmax(70px, 1fr))` — 150 + 6 × 70 + gaps ≈ 570 px, and no media query touches it.

**What the user actually sees.** `ux-shots/41-mobile-board.png`: the header reads
"…tingExchange ☰ Exchange My Bets Wallet" and is clipped mid-"Wallet"; the balance chip is
cut off at "$5136."; **the Account button and Sign out are entirely off-screen.** Every
ladder shows RUNNER, three back columns, and then the page ends — **all three lay columns
are beyond the right edge.** A user on a phone cannot see or tap a single lay price. That
is not a squeezed desktop; it is half the product missing.

`ux-shots/45-mobile-positions.png` confirms the header truncation: no balance, no Account,
no Sign out.

**Touch targets, in device pixels at the resulting 0.52 scale** (WCAG 2.2 AA target
minimum is 24 × 24 CSS px; platform guidance is 44 × 44):

```
ladder price cell    35 × 20      slip × remove      9 ×  9
Place button        175 × 19      price stepper −   15 × 14
stake input          85 × 18      navToggle ☰       18 × 16
Cash Out            190 × 19
```

A 9-pixel delete button is below any threshold that has ever been proposed.

**Effort** M, and it is genuinely two problems. (a) The header needs to collapse below
~700 px: move identity + balance + Account + Sign out behind the existing hamburger, or
into a bottom sheet. (b) The ladder needs a phone layout that is not "the same grid,
narrower". The honest answer for (b) is that **a six-column price ladder plus a runner name
does not fit 390 px at a legible size, and pretending otherwise is what produced 0.52.**
Betfair's own mobile product does not try to render the full ladder — it shows one runner
at a time with its best back and best lay, and a tap expands the depth. That is a different
product on a phone, not a squeezed desktop, and I would build that.

**Tradeoff I am naming.** Collapsing the header below 700 px costs persistent access to
Exchange / My Bets / Wallet, which is the top-level IA. Betfair solves this with a
persistent bottom tab bar on mobile — but that costs 56 px of vertical space on a screen
where the ladder is already fighting for height, and it introduces a second navigation
metaphor alongside the rail drawer. I would keep the header nav and move identity/balance
into the drawer, not add a bottom bar. That is a judgment call and I could be wrong.

**Strongest argument against.** *"Mobile is not the target audience for an exchange;
traders use desktop."* Fair, and if the venue is genuinely desktop-only the honest fix is
to say so and serve a 760 px minimum with a real message below it — **not** to ship 52%
scale to a phone and let Chrome decide. Shipping a broken mobile experience is worse than
not having one, because there is no signal that anything is wrong. That is the strongest
form of the argument and I do not have a rebuttal other than "the money is in mobile".

**Falsification test.** Instrument `visualViewport.scale` and first-meaningful-ladder-paint
for real mobile sessions. If p95 time-to-first-tappable-lay-price on a 390 px device is
already inside 2 s and session length on mobile matches desktop, the case weakens to
"cosmetic". I expect it to fail badly: the lay side requires a horizontal scroll
*discovery* on a touch device, and I would bet most users never find it.

---

### 2.4 — The operator console's visual language does not exist. The risk meter is zero pixels tall and the kill switch is a neutral button.

`public/admin-risk.js` renders markup using ten class names that `style.css` never
defines: `.meter`, `.meterfill` (base), `.statgrid`, `.stat`, `.small`, `.bad`, `.warn`,
`.danger`, `.ok`, `.gap`. `style.css:773-783` defines `.meterfill.w-0` … `.w-100` — eleven
rules that set **only `width`**.

Measured on the live Risk tab:

```
.meter      height 0px   background transparent   border 0px none
.meterfill  height 0px   background transparent   (width 70.36px, correctly computed)
Playwright: "locator resolved to hidden <div class="meter" title="58% of cap">"
```

Playwright reports the meter as **hidden** because Chromium's visibility test requires a
non-empty box. It is not merely unstyled; it does not exist visually.

Consequences, all visible in `ux-shots/25-admin-risk.png`, `26-admin-ledger.png`,
`30-admin-ops.png`:

- **The market-maker pressure meter is invisible.** `admin-risk.js:80` emits
  `<div class="meter" title="58% of cap"><div class="meterfill w-60"></div></div>`. The
  single most important "how close is the house to its cap" signal renders as the bare
  text "32%".
- **The kill switch is not distinguished from the button beside it.**
  `admin-risk.js:112` emits `class="btn ${data.kill_switch ? 'danger' : ''}"`; with the
  switch off that is literally `class="btn "`. Measured: kill switch background
  `rgb(255,255,255)`, "Withdraw all bot quotes" background `rgb(255,255,255)`. The most
  destructive control in the product looks identical to the second-most destructive.
  `.btn.red` already exists (`style.css:337`).
- **"The ledger does not balance. Do not trade."** (`admin-risk.js:173`, `class="bad"`) and
  **"Conservation drift: DRIFT"** (`admin-risk.js:165`) render in default black. The alarm
  states of an operator console have no alarm styling.
- **The Ledger and Ops stat tiles stack vertically** (`admin-risk.js:159-169`,
  `382-388`) instead of forming a KPI row, because `.statgrid` has no rule. `26-admin-ledger.png`
  shows six numbers in a 400 px column where a 6-across row was intended.
- **`results_feed: not_configured` and `risk_desk: live` render identically**
  (`ux-shots/30-admin-ops.png`). The alarming value is indistinguishable from the healthy
  one.
- `.small` missing means every sub-label ("unsettled buyouts, fair value", "realised loss
  today", "outlay today $0.00 of $5000.00") renders at 14 px body size.

There is a related, smaller inconsistency in the same file: `admin-risk.js:32-34 money()`
uses `fmt()`, so negatives render as `$-140.43`, while the player-facing `signed()`
(`core.js:122`) renders `−$140.43`. Both appear in `ux-shots/25` (`$-140.43`, red) and
`26` (`$-1015996.48`) — the same product, two negative-money formats, one of them
`$-` which is not a number anyone writes.

**Effort** S for the CSS (it is ~30 lines). M if you also want the desk to be *usable*
rather than merely present (see §3.5 on `window.prompt`).

**Strongest argument against.** *"These are nine missing class definitions; just add them."*
Yes — and that is exactly the risk. The moment the meter renders, someone will have
committed to a 0-100 bucketed width scale with no height, no colour ramp, and no notion of
what 60% should *look* like versus 85%. Shipping `.meterfill { height: 6px; background:
var(--green) }` would make the risk desk look fixed while encoding a threshold nobody
agreed to. The honest version is: add the structural CSS *and* decide the alarm threshold
in the same change, or explicitly label it non-alarming. I would rather this ship as a
small deliberate change than as a lint fix.

**Falsification test.** Give an operator 10 seconds on the Risk tab and ask "is the market
maker close to its cap, yes or no?" Today they must read a number and do arithmetic. If a
sample of operators answers correctly >80% of the time anyway, the meter is a nicety and I
am over-weighting it. I expect them to fail on the "is this healthy or not" question rather
than the arithmetic, because `$-140.43` in red next to a green `$30694.23` liability and a
"quoting" chip does not compose into a verdict.

---

### 2.5 — The slip will happily send two opposite orders on the same runner, one Place button per row, and never marks your selections on the board.

Three related gaps in `public/js/slip.js`, all of which Betfair gets right and all of
which are visible in the screenshots.

**(a) No netting.** Clicking a back price and then a lay price on the *same runner* puts
**two rows** in the slip:

```
BACK Kilmore Quay @ 3.70  … Profit $27.00 · Return $37.00  [Place $10.00]
LAY  Kilmore Quay @ 3.20  … Liability $22.00 · Return $32.00 [Place $10.00]
```

(`ux-shots/09-slip-two-rows.png`, reproduced identically in the probe.) Both POST to
`/api/orders` as separate orders, both match, and the player ends up with a netted-off
position, two escrows and two commission legs for what was, in intent, a single click.
Betfair merges back+lay on one selection into a single netted instruction and warns when
the result is a no-op. `slip.js:108-124` keys identity on
`(market_id, selection_id, side)` — the *side* is part of the identity, so the two cannot
collapse even in principle.

**(b) One Place per row.** `slip.js:170-172` renders the Place button inside every row, and
`slip.js:313 placeOne()` posts one order per call. A ten-row slip is ten clicks, ten
sequential round-trips, and ten toasts — each of which replaces the last
(`core.js:160-168`, single 2.6 s timer). Betfair's slip has one **Place bet** for the whole
slip. Note carefully: **a "Place all" is not an accumulator.** It would still be ten
independent orders — the engine has no multi-order endpoint, but `Promise.all` over the
existing `placeOne` with one consolidated result toast gets 90% of the value for a fraction
of the cost. The repo's README lists accumulators as "Not implemented"; that is a
different feature and should not block this one.

**(c) No mark on the board.** Nothing in `board.js` knows what is in the slip or what you
hold. `ux-shots/08-slip-one-row.png` shows the clicked cell carrying only a transient focus
ring; after the order matches and the board refreshes (`slip.js:346`), your selection looks
identical to every other. Betfair shades selections you have a live position in, and it
also greys your own resting orders out of the ladder so you do not lay yourself. Given
this product's own numbers — 12 bot orders per market, 18 on the football ones
(`ux-shots/21-admin-markets.png`) — the ladder is currently a wall of the venue's own
quotes, and there is no way to tell which cell is *yours*.

**(d) The disabled Place label.** `slip.js:171,200` render the label as `Place —` when the
stake is invalid. `ux-shots/10-slip-stake-error.png`: the row correctly says *"Minimum
stake is $1.00"* in red and the button correctly disables, but the button reads "Place —",
which looks like a truncated string rather than a disabled control.

**Effort** S for (b) and (d), M for (a) (needs an engine-side netting or a client-side
merge), S for (c).

**What I am giving up.** (c) costs visual state on the densest screen in the product. Two
selections marked is fine; a market where you hold four legs starts to look noisy, and the
colour palette is fixed so I cannot introduce a fourth hue — marking has to be weight,
underline or opacity, all of which fight the existing flash animation (`style.css:428-429`,
`board.js:436-439`). I would mark with a 2 px left rule on the runner cell and nothing
else. (b) costs nothing except that a single "Place all" makes partial failure harder to
explain — which is why the consolidated result must say *which* rows failed, not just that
some did.

**Strongest argument against.** *Per-row Place is better for the trader who wants to place
legs individually as prices move, and "Place all" would encourage spray-and-pray across ten
markets.* That is a real argument and it is why Betfair's own slip offers both. I would
keep per-row Place and **add** a single "Place all (N)" beneath the slip, not replace it.
That weakens my recommendation to "add one button", which is fine — the button is cheap
and the argument is about which to keep.

**Falsification test.** Instrument `POST /api/orders` per placed order from the UI and
count rows-per-submit in a moderated session of 10 traders. If the median slip has ≤2 rows
and ≥90% of submissions are single-row, "Place all" is a convenience with no measurable
value and should be dropped. If the median is 4+ rows, it is the difference between one
click and five. The netting half falsifies differently: if no test participant ever backs
and lays the same runner, then netting is a correctness fix (two orders where one was meant)
rather than a UX feature, and should be argued as a bug, not as a recommendation.

---

## 3. Findings that are real but smaller

### 3.1 A server error and an empty venue are the same screen

`shell.js:279-281`:

```js
} catch {
  if (seq === OB.state.eventsReqSeq) OB.state.events = [];
}
```

A 500 from `/api/events` and a genuinely empty catalogue both render
`board.js:147` *"No open events right now."* Measured directly:

```
after an injected 500 on /api/events : "No open events right now"  (1 card, 0 ladders)
genuinely empty catalogue            : "No open events right now"
```

`ux-shots/48-board-500-isolated.png` vs `ux-shots/49-board-genuinely-empty.png` — the two
are byte-for-byte the same UI. The operator's first response to a broken exchange should
not be "have we gone out of business?". Every async loader in the app uses this same
`.empty` + `e.message` shape (`views.js:100,174,206,293`; `admin.js:82,181,281,522`;
`admin-risk.js:28-30`), so this is a pattern, not one endpoint. `admin-risk.js:28-30
unavailable()` is the one place that gets it right — "Risk desk unavailable: {message}" —
which is proof the team already knows the pattern and it simply was not applied.

There is **no loading skeleton anywhere** — eight literal `Loading…` strings
(`views.js:38,236`, `shell.js:140`, `index.html:113`, `admin.js:76,173,230,373`) and
nothing on the board at all, which renders blank until `/api/events` resolves.

### 3.2 Three documented UI affordances do not exist

The repo has a well-earned reputation for comments describing behaviour the code does not
have. Three more instances, all UI, all in surfaces the README advertises:

| Claimed | Reality | Evidence |
|---|---|---|
| "The server publishes its live window on `/api/me` as `stake_bounds` and `refreshMe()` hands it to `setStakeBounds()`" (`slip.js:29-32`) | `/api/me` returns `{ user }` only. `stake_bounds` appears **nowhere** in `server.js` or `lib/`. `setStakeBounds(undefined)` always returns `false` and the client's `{min:100,max:100000}` is the only window. | measured: `/api/me` top-level keys `["user"]`; `grep -rn stake_bounds server.js lib/` → 0 hits. `MIN_STAKE_CENTS`/`MAX_STAKE_CENTS` *are* operator-configurable (`config.js:293-294`), so a venue that sets them differently gets a slip whose `min`/`max` attributes and inline errors disagree with the engine. |
| `style.css:712-713`: *"Book percentage in the ladder header: 'BACK ALL 147.0%'"* | `/api/events` market objects are `['id','name','status','total_matched_cents','selections']`. No `back_pct`, no `lay_pct`. `board.js:228-234 bookLabel()` renders the em-dash fallback **on every market, forever**. | `ux-shots/05-board-signed-in.png` and every board shot: "BACK ALL —" / "LAY ALL —". `marketOverround()` exists in `lib/match.js:692` and the admin desk uses it — it is simply not published to the board. |
| README:147 *"User administration. Status, limits, balance adjustment and self-exclusion, each action audited with a reason."* | The users table (`admin.js:149-167`) renders Balance / Suspend / Make-admin. `server.js:1365-1399` has `/api/admin/users/:id/limits` (GET+PUT) and `/api/admin/users/:id/exclude` (POST). **Neither is called from `public/`.** | measured: `document.documentElement.outerHTML` matches `/limits/i` = false, `/self.?exclu|exclude/i` = false. |

A fourth, in the same family: `server.js:1581` implements `POST /api/wallet/withdraw` and
the wallet view (`views.js:221-253`) renders **no withdraw control at all** — the only way
to move money out of this exchange is to have someone run `curl`. In a paper-money demo
that is defensible; the moment real money is described anywhere in the product it is not.

### 3.3 Settled markets stay in Positions, and `BACKED` always equals `FROZEN`

`lib/match.js:765-789 positionsFor()` filters on `mt.cashout = 0` but **not on market
status**, so a settled market keeps appearing in the Positions tab with live-looking P&L
chips (`ux-shots/45-mobile-positions.png` shows a card badged `settled` still listing
`Kilmore Quay +$140.43`). The comment at `lib/match.js:769-774` shows the team already
reasoned that "a closed position has no business in a list of positions" — they applied it
to cash-outs and not to settlements.

In the same table, `views.js:123-125` renders `BACKED`, `LAID` and `FROZEN`. For any
back-only leg `escrowFor` equals the stake (`lib/match.js:102`), so `BACKED` and `FROZEN`
print the same number on every row — `ux-shots/14-my-bets-positions.png`: `$50.51 / — /
$50.51`. Three columns, one number, and "Frozen" is a word a bettor will read as "staked".

What the Positions tab does well, and should be protected: **the if-this-wins P&L matrix
(`views.js:129-134`) is the single best thing in this UI.** Six chips, colour-coded, signed,
one per runner. That is exactly Betfair's position row and it is already correct — match
it, don't redesign it. What it lacks is the other half of the answer: there is no
unconditional/net P&L and no aggregate exposure anywhere in the product.

### 3.4 Settle: the most consequential dialog in the product names nothing

`ux-shots/31-admin-settle-dialog.png`. The dialog is `role="dialog"`, Escape-closable,
focus-trapped, and correctly instructs *"Pick the winning runner, or void the market
(everyone is refunded)"* (`admin.js:317-321`, a good W6 fix). Its title is
**"Settle Winner"** — because `admin.js:316` interpolates `market.name`, and the market's
name is literally "Winner". The event, the odds, the matched volume, the number of affected
accounts and the money at stake are all absent. Each radio shows `LTP —`. An operator is
irreversibly settling other people's money from a dialog that names a generic market type.

Betfair's ops tooling is not the comparable here; the comparable is any payment console.
Minimum fix: title it with the event, list each runner with its LTP and the stake
currently at risk, and require the reason through a real control.

### 3.5 `window.prompt` is the reason-capture mechanism for every consequential admin action

`admin.js:60-65` (`askReason`), `admin.js:117` (balance adjustment), `admin-risk.js:44-57`
(kill switch, withdraw-all-quotes), `admin-risk.js:289` (*"Winning selection id (see the
market on the board)"* — a bare integer ID, for a hold release, with no list to choose
from). `window.prompt` cannot be styled, is not focus-trapped with the rest of the app,
renders as a tiny native dialog on mobile Chrome, and is invisible to the overlay stack.
It is also how a required audit reason is collected on **PULL KILL SWITCH**.

### 3.6 Copy and microcopy

- Two status chips per event in two different styles: `board.js:164` renders the event's
  `upcoming` chip (grey outline) directly above `board.js:170` rendering the market's
  `open` chip (green outline). Three lines apart, same information, two visual languages.
- `$0.00 matched` on every market with no volume — a number that is always zero reads as
  broken. `21-admin-markets.png` shows ten of twelve rows at `$0.00`.
- The wallet ledger's `BALANCE` column (`views.js:276`) means *balance after*, while the
  figure labelled `BALANCE` at the top of the same screen (`views.js:224`) means total
  balance. Same word, two meanings, one screen.
- `escrow` ledger rows render their amount unsigned (`views.js:281`), so you cannot tell
  direction; the running `BALANCE` is unchanged across all three (`16-wallet.png`).
- `#toast` sits at `top: 60px` with `z-index: 30` (`style.css:612-626`) and covers the
  content behind it — see `20-my-bets-settled-rows.png`, where the error toast sits on top
  of the Positions/Settled tab strip.
- Negative money has two formats: `$-140.43` (admin) and `−$140.43` (player). See §2.4.

### 3.7 Empty and loading states are thin but not dishonest

The empty states are at least *present* and correct — "No unmatched orders", "No matched
positions", "No settled markets yet", "No transactions yet"
(`ux-shots/15`, `37`, `38`). Betfair's equivalent surfaces point at the next action
("go find a market"); ours do not. That is a fair, small improvement: every one of these is
a dead end with no button.

`admin-risk.js:258` renders "Nothing held. Every outcome resolved cleanly." *inside a
table body*, so the MARKET / WHY IT IS HELD headers dangle above a sentence
(`ux-shots/28-admin-held.png`). Minor, and the fix is one line.

### 3.8 On mobile the nav drawer has no dismissal route that a user would guess

`shell.js:24-39` is the drawer's only open/close pair, and `closeNavRail()` is called from
exactly two places: a **race-leaf** click (`nav.js:137`) and **Escape** (`boot.js:140-144`).

In seeded mode there are no race leaves — the rail is the sport chip list — so the only
closures are the hamburger again and Escape. Tapping any header nav button navigates and
leaves the drawer open over the content. Measured:

```
opened the drawer with #navToggle      → body.nav-open = true
tapped "Wallet" in the header          → OB.state.page = "wallet"
                                         body.nav-open = true
                                         sidebar transform = matrix(1,0,0,1,0,0)  ← fully open
```

`ux-shots/47-mobile-drawer-blocks-content.png` shows the consequence: the drawer covers
the Positions tab strip and the top of the bet slip, and there is **no scrim** — only a
box-shadow — so it reads as a broken layout rather than an open drawer. The drawer is also
full-height (`style.css:144-155`, `bottom: 0`) with 240 px of empty white below five
sports.

**Effort** S — close it in the `#nav button` handler at `boot.js:113-117`, and add a
tap-outside scrim. **Strongest argument against:** a user who taps a nav item and sees the
drawer still there will simply tap the hamburger again; the cost is one confused moment,
not a dead end. That is fair, and it is cheaper to fix than to defend.

---

## 4. The admin desk as a separate product

It is a separate product and it is currently a CMS with an ops console bolted on. Ten
equal-weight tabs in one row (`admin.js:20-34`), no grouping, no severity signal:

```
Markets  Users  Audit  Create  Risk  Ledger  Reconcile  Held  Tenants  Ops
```

**Reconcile** and **Held** are queues that need a human. **Create** is catalogue
administration. **Risk**, **Ledger**, **Ops** are an operations console. Grouping them —
or, better, gating the ops half behind an explicit "Operations" entry — would mean an
operator opening the desk sees what is on fire. Today nothing tells them; they must know
that tab 7 matters.

Two concrete consequences visible in the shots:

- **Every open market shows negative overround** — `-35.27%`, `-28.06%`, `-1.91%`,
  `-3.58%` … all green, all "arbitrage available" (`admin.js:288-294`,
  `ux-shots/21-admin-markets.png`). The bot quotes a crossed book (skew widens both sides
  away from fair, `lib/bots.js:112-129`), so the venue's headline margin signal reads as
  free money on every market. An operator learns to ignore the column, which is the worst
  possible outcome for the column.
- **The sport rail is rendered on My Bets, Wallet and all ten admin tabs**
  (`nav.js:43 rail.hidden = false`) where it does nothing. It occupies 178 px and reads as
  live navigation. On the Exchange page it is the filter; elsewhere it is furniture.

Betfair's own admin surfaces are separate applications from the exchange front end. That is
the right instinct, not because of brand, but because they have different users, different
density requirements and different risk profiles — and mixing them is why the ops half has
ended up with undefined CSS and a `window.prompt` on the kill switch.

---

## 5. Cheap wins — one-liners, described, not applied

Per the brief, none of these were applied.

| # | Change | Where | Why it is cheap |
|---|---|---|---|
| 1 | Add `#accountModal` to the `display:none` / `.show { display:flex }` selector pair | `style.css:631,641` | One selector edit fixes §2.2 |
| 2 | Change `nav.js:48` to `math.max(1, total - checked)` | one line | Never displays "0/0" |
| 3 | Stop rendering the event-level `upcoming` chip when the market chip says `open` | `board.js:164` | Removes the duplicate status |
| 4 | Hide `$0.00 matched` when volume is zero | `board.js:171` | |
| 5 | Use `signed()` instead of `fmt()` in `admin-risk.js money()` | `admin-risk.js:32-34` | One negative-money format |
| 6 | Change `PULL KILL SWITCH` to use the existing `.btn.red` | `admin-risk.js:112` | `.btn.red` exists at `style.css:337` |
| 7 | Replace `Place —` with `Place` (disabled) | `slip.js:171,200` | |
| 8 | Rename the ledger table column to "Balance after" | `views.js:276` | |
| 9 | Drop the `FROZEN` column from positions (it equals `BACKED` for back-only legs) | `views.js:125` | |
| 10 | Close the nav drawer on any `#nav button` click | `shell.js` route/`boot.js:113` | One line; fixes §3.8 |
| 11 | Add `.meter`, `.meterfill`, `.statgrid`, `.stat`, `.small`, `.bad`, `.danger` to `style.css` | see §2.4 | Structural only — see the caveat there about the threshold |

---

## 6. What I would **not** do

Ranked by how likely I am to be wrong about these, which is high.

- **Dark mode / theming.** Ruled out by the constraint and argued in §1.
- **More charts.** The Ledger tab is the proof: it has the numbers and no visual
  treatment, so it reads as a paragraph. Adding charts without the treatment budget
  produces the same paragraph with more ink.
- **Replacing the My Bets table with cards.** The table scans; cards don't. Betfair uses a
  table and so should this.
- **A "next race up" carousel or auto-scrolling board.** Motion on this screen currently
  *means* "a price moved" (`board.js:286-300`, `style.css:428-429`). Reusing it for
  navigation destroys the one signal that matters.
- **A bottom tab bar on mobile.** See the tradeoff named in §2.3 — 56 px of a screen the
  ladder is already losing.
- **An acca/accumulator feature.** Engine scope, explicitly out of scope in the README, and
  it would change what a "slip" means.
- **A sort control on the board.** Betfair deliberately has none in the ladder; ordering is
  a property of the market list, not a per-view control. Adding one puts a control strip
  between the header and the first price.
- **Touching the price ladder's cell size or type size.** Both are inside the fixed type
  system. §2.3's mobile fix must come from the *layout* (fewer columns, runner centred), not
  from shrinking type — which is exactly the trap the current 0.52 scale fell into.

---

## 7. What I could not assess, and what I am therefore not claiming

Naming gaps is worth more than papering over them.

1. **Feed mode is entirely unassessed.** `FEED_DATABASE_URL` is unset here. The
   sport→country→track→meeting→race rail, the "No liquidity in the latest frame" note, the
   `STALE` age badge, the "Feed markets are display-only" gate and the whole tree-navigation
   IA are read from source only (`board.js:68-126`, `nav.js:66-166`, `style.css:186-230`)
   and I have **not seen any of it render**. `scripts/shoot.mjs:396-404` documents that the
   boot path lands on a meeting whose races are retired — a boot-navigation problem I am
   flagging as *known and documented*, not as a discovery.
2. **No latency was measured.** `scripts/load-test.mjs` exists; I did not run it. Everything
   I say about performance is structural: SSE with a 200 ms book debounce
   (`boot.js:30-39`), a 15 s poll fallback in seeded mode (`boot.js:98-107`), and a full
   `innerHTML` re-render of the board on every refresh (`board.js:180`) with no diffing and
   no scroll anchoring. I have **no** p50/p95 numbers and make none.
3. **No screen reader, no `prefers-reduced-motion`, no forced-colors.** Accessibility
   findings here are DOM- and geometry-based (ARIA attributes, `offsetParent` visibility,
   target sizes). I did not hear the app. The only automated check I can point at is
   `tests/ui_test.mjs:134-145`, which is good and real: price cells are `<button>`s with
   descriptive `aria-label`s. I found nothing to fault in that specific area.
4. **The 2-level ladder case could not be reproduced in the geometry probe.** `01`, `05`,
   `08` and `10` capture it clearly (Kilmore Quay down to two back levels after my own
   order ate the top), and the API book dump confirms two levels existed. But when I
   re-ran the probe against a fresh bot book, every runner had 3+3 and the invariant test
   was uniformly green. So my "33 of 33 rows" numbers describe the *healthy* case only; the
   degenerate case rests on screenshots.
5. **Not driven:** deposit-intent/PSP flow, all four RG controls (reality check, session
   limit, deposit limit, self-exclusion) beyond confirming they have no UI, reports/CSV,
   audit pagination, the tenants edit round-trip, kill-switch and withdraw execution,
   reconcile resolve, backup (the endpoint 404s here — `OPS_TOKEN` unset — which is itself
   the `ux-shots/33` finding). **Extrapolation, flagged as such:** every one of these lives
   in the same two admin files that reference undefined CSS, so I expect the §2.4 class of
   defect there too. I did not verify it and am not claiming it.
6. **Viewport coverage is 1440×900 and 390×844 only.** Not 768, 1024, 1280, 2560. The
   ladder's `minmax()` floor means 1024 is likely a third problem I did not look at.
7. **Only `/api/events` was error-injected.** The other loaders use the same code shape but
   I did not exercise each one.
8. **Two planned captures did not land as intended.** `35-loading-state.png` caught the
   Settled *empty* state rather than a loading state — which is itself the finding in
   §3.1: there is no loading state to photograph. `#50`, `#51`, `#52` are excluded by
   instruction; §2.2's leaked panel and the always-enabled Cash Out button are adjacent to
   `#50` but are different defects, and I have said so where relevant.
9. **No users.** Every legibility claim about density and hierarchy is mine, not measured.
   A first-time user and a professional would read this board very differently, and I have
   no evidence about which of them this is built for.

---

## 8. Screenshot index

All in `ux-shots/`. Inspected individually; none is a duplicate by accident.

| File | What it shows |
|---|---|
| `01-signed-out-board.png` | Full ladder, signed out; Kilmore Quay at 2 back levels — the ladder gap case |
| `02`/`03-auth-modal-*.png` | Sign in / Register |
| `04-auth-error-toast.png` | Invalid credentials |
| `05-board-signed-in.png` | Hero board; "BACK ALL —"; the monotone-ramp row |
| `06-search-results.png` | Search dropdown |
| `07-ladder-keyboard-focus.png` | Focus ring on a price cell |
| `08-slip-one-row.png` | Single slip row, Profit/Return |
| `09-slip-two-rows.png` | Back + lay, same runner, unnetted |
| `10-slip-stake-error.png` | "Minimum stake is $1.00", disabled "Place —" |
| `11-slip-typed-price-snapped.png` | Typed price snapped to the ladder |
| `12-toast-matched.png` | Fill confirmation |
| `13-my-bets-open-orders.png` | Open orders + **leaked account panel** |
| `14-my-bets-positions.png` | If-this-wins matrix; BACKED == FROZEN; "Cash out unavailable" |
| `15-my-bets-settled-empty.png` | Settled empty state |
| `16-wallet.png` | Wallet + **leaked account panel** |
| `17-account-panel.png` | The panel as "opened" |
| `18-board-cashout-button.png` | Always-enabled Cash Out in chrome |
| `19-cash-out-result.png` | "No cash-out available on your open positions" |
| `20-my-bets-settled-rows.png` | Settled row; toast covering the tab strip; leak |
| `21-admin-markets.png` | Desk; every market negative overround |
| `22-admin-users.png` | Users; three identical action buttons; no limits/exclusion |
| `23-admin-audit.png` | Audit trail |
| `24-admin-create.png` | Five create forms; raw `datetime-local`; unbalanced grid |
| `25-admin-risk.png` | **Invisible pressure meter**; unstyled kill switch; `$-140.43` |
| `26-admin-ledger.png` | `.statgrid` unstyled; "balanced" unweighted; `$-1015996.48` |
| `27-admin-recon.png` | Reconciliation findings |
| `28-admin-held.png` | Held markets + void rules |
| `29-admin-tenants.png` | Tenants |
| `30-admin-ops.png` | Readiness checks; `not_configured` styled like `live` |
| `31-admin-settle-dialog.png` | **"Settle Winner"** — the dialog names nothing |
| `32-admin-tenant-edit.png` | Inline tenant editor |
| `33-admin-ops-backup.png` | Backup failure rendered as bare "Not found" |
| `34-board-server-error.png` | 500 on `/api/events` — indistinguishable from empty |
| `35-loading-state.png` | Settled-empty; there is no loading state to capture |
| `36-signed-out-gate.png` | My Bets signed out |
| `37`/`38-*-fresh-empty.png` | Fresh account: wallet and My Bets empty |
| `39-mobile-signed-out-board.png` | Mobile board, signed out |
| `40-mobile-auth.png` | Mobile auth modal |
| `41-mobile-board.png` | **Entire lay side off-screen**; header clipped |
| `42-mobile-board-full.png` | Same, full page |
| `43-mobile-slip.png` | Mobile bet slip |
| `44-mobile-rail.png` | Nav drawer |
| `45-mobile-positions.png` | Account/Sign out off-screen; settled position in Positions; leak |
| `46-mobile-wallet.png` | Mobile wallet |
| `47-mobile-drawer-blocks-content.png` | Drawer stays open over content, no scrim |
| `48-board-500-isolated.png` | Error state |
| `49-board-genuinely-empty.png` | Empty state — identical to 48 |
| `50`/`51-admin-ledger-*.png` | Cropped ledger evidence |
| `52-mobile-signed-in-header.png` | Signed-in mobile header geometry |
| `53-mobile-slip-signed-in.png` | Mobile slip touch targets |