// board.js — cash-out, feed board, markets page (the ladder)
(() => {
  'use strict';

  const OB = window.OB;
  if (!OB) { console.error('[board] window.OB missing — core.js must load first'); return; }

  // Cross-module names are referenced as OB.name at the call site and are
  // deliberately NOT destructured. Destructuring captures the VALUE at load
  // time, so a forward reference -- this module calling something the file
  // BELOW it has not exported yet -- binds to undefined permanently and
  // never recovers. Resolving through OB at each call is late enough to work
  // whatever the load order.
  //
  // References inside string literals, template CHUNKS and regex literals are
  // left alone. Each of those was a real corruption when the split was done by
  // hand: /api/x became /OB.api/x, ${state.user} kept a bare `state`, and
  // /^\d+$/ became /^\d+OB.$/. scripts/split-app.mjs does the rewriting and
  // is the reference for what must NOT be touched.

  // ── cash out ───────────────────────────────────────────────────────────
  // Green-up across an open position. lib/cashout.js already computes the plan;
  // this button is the single action that commits it.
  async function doCashOut() {
    if (!OB.state.user) {
      OB.toast('Sign in to cash out', 'err');
      OB.openAuth('login');
      return;
    }
    const btn = OB.$('cashoutBtn');
    btn.disabled = true;
    btn.textContent = 'Cashing out…';
    try {
      const { positions } = await OB.api('GET', '/api/positions');
      const open = (positions || []).filter((p) => p.market_status === 'open' && p.cashout);
      if (!open.length) {
        OB.toast('No cash-out available on your open positions', 'err');
        return;
      }
      // One market per click: a multi-runner green-up is not a single action,
      // and silently picking open[0] cashed out a market the user never chose.
      // With several live offers, send the user to Positions to pick; with
      // exactly one there is nothing to choose between. (W8)
      //
      // goTo(), NOT `location.hash = '#/bets'`: the fallback is pressed from
      // My Bets more often than from anywhere else, and assigning the hash it
      // already holds fires no `hashchange` — so route()/renderBets() never
      // ran, betsTab was 'positions' in state only, and the user was told to
      // pick one in Positions while Open orders stayed on screen.
      if (open.length > 1) {
        OB.state.betsTab = 'positions';
        OB.goTo('bets');
        OB.toast('Multiple positions can be cashed out — pick one in Positions');
        return;
      }
      const target = open[0];
      const r = await OB.api('POST', `/api/markets/${target.market_id}/cashout`);
      const v = r.value_cents;
      OB.toast(`Cashed out ${v >= 0 ? '+' : '−'}${OB.fmt(Math.abs(v))} on ${target.market_name}`, v >= 0 ? 'ok' : 'err');
      await OB.refreshMe();
      // Refresh the bets view ONLY when it is the one on screen. renderBets()
      // writes the WHOLE #page, so calling it unconditionally replaced the
      // markets ladder with the My Bets card while the nav highlight and
      // location.hash still said "Exchange" — and the cash-out's own `book`
      // broadcast then repainted the board over it 200ms later, so the
      // operator saw whichever of the two resolved last. Every sibling call
      // is conditioned this way (the SSE `orders` listener in boot.js).
      if (OB.state.page === 'bets') OB.renderBets();
    } catch (e) {
      OB.toast(e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Cash Out';
    }
  }

  // ── feed board (bookmaker-style navigation) ──────────────────────────────
  // With FEED_ENABLED the board is driven by the odds feed: a sport -> country
  // -> track -> meeting -> race hierarchy, then the price ladder for the races
  // chosen. The seeded catalogue (/api/events) remains for non-feed deployments.
  function renderRaces() {
    const host = OB.el('races');
    if (!host) return;
    const sel = OB.state.navSel || {};
    // ONE race on screen at a time, chosen in the tree. Betfair shows a single
    // market with its own title and time; a page of stacked cards is not the
    // same product.
    //
    // The market comes from /api/feed/market?id=, not from the board list. The
    // board is capped and recency-sorted, so looking the selection up in it
    // silently substituted a different market's prices whenever the pick fell
    // outside the cap - which, with 1400+ markets, it usually did.
    const m = OB.state.market;
    if (!m) {
      host.innerHTML = sel.market_id
        ? '<div class="card"><div class="empty">This market is no longer open on the feed</div></div>'
        : '<div class="card"><div class="empty">Pick a race from the tree on the left</div></div>';
      return;
    }
    if (String(m.market_id) !== String(sel.market_id)) {
      OB.state.navSel = Object.assign({}, sel, {
        market_id: m.market_id,
        event_id: String(m.event_id),
      });
    }
    const sels = m.selections || [];
    // A race can genuinely have liquidity on one side only (Betfair reports it
    // as unmatched). Saying which side is missing beats an empty column.
    const anyBack = sels.some((s) => (s.back || []).length);
    const anyLay = sels.some((s) => (s.lay || []).length);
    const note =
      !anyBack && !anyLay
        ? '<span class="muted">No liquidity in the latest frame</span>'
        : !anyLay
          ? '<span class="muted">No lay offers available</span>'
          : !anyBack
            ? '<span class="muted">No back offers available</span>'
            : '';
    // FEED GATE note (removable — see bindLadder): rendered where the slip
    // would open, because in feed mode no slip can ever open.
    const gate = OB.state.feedMode
      ? '<div class="racenote feednote">Feed markets are display-only</div>'
      : '';
    host.innerHTML = `<div class="card racecard">
      <div class="mkthead">
        <span class="race-time">${OB.esc(OB.clockText(m.market_time))}</span>
        <span class="race-name">${OB.esc(m.market_name || 'Race')}</span>
        <span class="muted race-evt">${OB.esc(m.event_name || '')}</span>
        <span class="spacer"></span>
        <span class="chip ${OB.esc(m.status)}">${OB.esc(m.status)}</span>
        ${m.in_play ? '<span class="chip live">IN-PLAY</span>' : ''}
        <span class="muted tn age">${OB.num(m.age_seconds)}s${m.stale ? ' · STALE' : ''}</span>
      </div>
      ${gate}
      ${note ? `<div class="racenote">${note}</div>` : ''}
      ${ladderHtml(m, m)}
    </div>`;
    bindLadder();
  }

  // ── markets page (Betfair-style ladder) ──────────────────────────────────
  function whenText(iso) {
    if (!iso) return '—';
    const d = new Date(String(iso).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return OB.esc(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderMarkets() {
    const page = OB.el('page');
    if (!page) return;
    // Feed mode: navigation lives entirely in the left tree, so the page holds
    // just the one selected market. The old Sport/Country/Track dropdown card
    // and its "Show races" button are gone — they duplicated the tree.
    if (OB.state.feedMode) {
      renderRaces();
      return;
    }
    // A FAILED LOAD AND AN EMPTY CATALOGUE ARE NOT THE SAME SCREEN.
    //
    // loadEvents() used to answer both with `state.events = []`, so a 500 from
    // /api/events and a venue with genuinely nothing on it rendered the same
    // card saying "No open events right now". The first thing an operator
    // concludes on seeing that is "we have gone out of business" — which is the
    // exact inverse of the truth, and it happened on every transient blip.
    //
    // So the failure says it FAILED, names why, offers a retry, and never claims
    // to know anything about the catalogue. The empty state keeps its own copy
    // and says how to fill it.
    if (OB.state.eventsError) {
      page.innerHTML =
        `<div class="card"><div class="empty err">The board could not be loaded — ${OB.esc(
          OB.state.eventsError
        )}</div>` +
        `<div class="row center"><button class="btn primary" id="boardRetry">Try again</button></div>` +
        `<p class="muted fineprint">This is a fault, not an empty market list. If it persists the venue is not trading.</p></div>`;
      const retry = document.getElementById('boardRetry');
      if (retry) {
        retry.onclick = async () => {
          retry.disabled = true;
          retry.textContent = 'Retrying…';
          await OB.loadEvents();
          OB.renderMarkets();
        };
      }
      return;
    }
    if (!OB.state.events.length) {
      page.innerHTML =
        '<div class="card"><div class="empty">No open events right now</div>' +
        '<p class="muted fineprint">The catalogue loaded and is genuinely empty — nothing is scheduled to trade.</p></div>';
      return;
    }
    const groups = new Map();
    for (const e of OB.state.events) {
      const key = e.competition || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    let html = '';
    for (const [comp, evs] of groups) {
      html += `<div class="card"><h3>${OB.esc(comp)}</h3>`;
      for (const e of evs) {
        html += `<div class="event">
          <div class="evmeta">
            <span class="nm">${OB.esc(e.name)}</span>
            <span class="when">${whenText(e.starts_at)}</span>
            <span class="chip ${OB.esc(e.status)}">${OB.esc(e.status)}</span>
          </div>`;
        for (const m of e.markets) {
          // ONE status, once. The event chip above and the market chip here sat
          // three lines apart saying `upcoming` and `open` about the same thing
          // in two different visual languages, and on this catalogue EVERY
          // market was `open` under an `upcoming` event — twelve pairs of chips
          // per board, which is how a board ends up with a status nobody can read
          // at a glance.
          //
          // So the event chip is the authority and a market chip is printed only
          // when the market is NOT open: `suspended` and `settled` are the states
          // an operator has to notice, and `open` is the absence of news.
          const marketStatus = m.status && m.status !== 'open'
            ? `<span class="chip ${OB.esc(m.status)}">${OB.esc(m.status)}</span>`
            : '';
          // `$0.00 matched` on every market with no volume is a number that is
          // always zero, and a row of zeros reads as a broken counter rather than
          // as a market nobody has backed.
          const matched = m.total_matched_cents
            ? `<span class="muted tn">${OB.fmt(m.total_matched_cents)} matched</span>`
            : '';
          // WINDOWED MATCHED VOLUME FOR THE MARKET (#93), beside the lifetime
      // figure already in this header.
      //
      // IT IS HERE AND NOT IN THE RUNNER CELL, and that is a measured decision
      // rather than a preference. The first version of #93 added a `MATCHED`
      // badge to `.lmid`, beside the existing `LTP` one. `.lrow`'s runner column
      // is `minmax(150px, 1.6fr)`, which at the documented 570px floor is exactly
      // 150px; with 24px of padding that leaves 126px. Measured at 570px on the
      // seeded board: the LTP badge is 51px and the MATCHED badge 102px, and
      // `.nm` — the RUNNER'S NAME — was squeezed to 0px wide and did not render
      // at all. A ladder that trades normally has an LTP badge on most rows, so
      // this was not an edge case: it hid the name of every runner that had
      // traded. The screenshot of it is the reason this is a comment.
      //
      // The per-LEVEL matched figures and their bars — the acceptance item — are
      // inside the price cells and cost no width at all, because a cell has
      // vertical room to spare and the grid has no eighth track to give (#136).
      // The windowed TOTAL needs a line of its own, and the market header is
      // where the lifetime total already lives, so both figures now sit together
      // and can be read against each other.
      //
      // Summed in the client from the per-selection figures `/api/events` already
      // returns, so it is the same number the ladder's runner rows carry and
      // needs no second server read.
      const windowed = (m.selections || []).reduce((a, s) => a + (Number(s.matched_cents) || 0), 0);
      // Every runner in this market was merged with the SAME window (one
      // `matchedByLevel` call covers the whole board), so the first runner that
      // traded states it. Reading it from the payload rather than from a client
      // constant is the same rule the movers strip follows: `?window=` is a
      // parameter, and a caption asserting a window it did not ask for is a lie.
      const windowedMinutes =
        (m.selections || []).find((s) => s.matched_cents)?.matched_window_minutes ||
        OB.Ladder.MATCHED_WINDOW_MINUTES;
      const matchedShown = windowed
        ? `<span class="muted tn matched-win" title="${OB.fmt(windowed)} matched in the last ${windowedMinutes} minute${
            windowedMinutes === 1 ? '' : 's'
          } of trading in this market, across every runner and price">${OB.fmt(windowed)} in ${
            windowedMinutes
          }m</span>`
        : '';
      html += `<div class="mkt">
            <div class="mkthead">
              <span>${OB.esc(m.name)}</span>
              ${marketStatus}
              ${matched}
              ${matchedShown}
            </div>
            ${ladderHtml(m, e)}
          </div>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }
    // The mover strip's mount (#93). Rendered as its own asynchronous fill
    // BELOW the ladders, so it can never delay or fail the board itself.
    html += '<div id="movers"></div>';
    page.innerHTML = html;
    renderMovers(page);
    bindLadder();
  }

  // ── the board's mover view (#93) ──────────────────────────────────────────
  //
  // ONE strip above the ladders, ranked by what actually traded. It was a
  // roadmap item with no implementation, and it could not have one: with no
  // reader on the trade tape there was no number to rank by.
  //
  // It is a SEPARATE FETCH rather than a field on /api/events, and that is a
  // deliberate cost: the board already re-reads every market's book on its
  // 15-second poll, and adding a ranked view of the whole venue to that same
  // response would make a poll that most clients never look at do work for all
  // of them. It shares the ladder's matched column server-side — one query,
  // two readers (lib/marketdata.js movers() and matchedByLevel()).
  //
  // The window label is rendered from the RESPONSE, not from a client constant.
  // `?window=` is a parameter, so a strip captioned "10 min" beside a figure
  // computed over 60 would be the UI asserting something it does not know.
  async function renderMovers(page) {
    const host = page.querySelector('#movers');
    if (!host) return;
    try {
      const r = await OB.api('GET', '/api/movers?limit=6');
      const rows = r && r.movers ? r.movers : [];
      const windowLabel = `${r.window_minutes} min`;
      const scopeNote = r.markets_available != null && r.markets_available > r.markets_considered
        ? `<span class="muted movers-scope" title="The busiest ${r.markets_considered} of ${r.markets_available} open markets">top ${r.markets_considered} of ${r.markets_available} markets</span>`
        : '';
      if (!rows.length) {
        host.innerHTML = `<div class="movers"><span class="muted movers-title">Movers</span>`
          + `<span class="muted">Nothing has traded in the last ${OB.esc(windowLabel)}</span></div>`;
        return;
      }
      host.innerHTML = `<div class="movers">`
        + `<span class="muted movers-title">Movers <span class="muted movers-win">last ${OB.esc(windowLabel)}</span></span>`
        + rows
          .map(
            (m) => `<span class="mover tn" title="${OB.esc(m.name || '')} — ${OB.fmt(m.matched_cents)} matched across ${
              m.fills
            } fill${m.fills === 1 ? '' : 's'} at ${m.levels} price level${m.levels === 1 ? '' : 's'}${
              m.lowest_price != null && m.top_price !== m.lowest_price
                ? `, ${OB.price2(m.lowest_price)}–${OB.price2(m.top_price)}`
                : ''
            }">`
              + `<span class="mover-name">${OB.esc(m.name || `Selection ${m.selection_id}`)}</span>`
              + `<span class="mover-vol">${OB.fmt(m.matched_cents)}</span></span>`
          )
          .join('')
        + scopeNote
        + `</div>`;
    } catch {
      // A failed movers strip must not take the board with it: the ladders are
      // the product and this is a summary of them. Say so and stop.
      host.innerHTML = '<div class="movers"><span class="muted movers-title">Movers</span>'
        + '<span class="muted">unavailable</span></div>';
    }
  }

  // ── the runner price chart (#93) ─────────────────────────────────────────
  //
  // THE THIRD THING THE ISSUE SAID WAS MISSING, and the reason the trade tape was
  // write-only in the first place: there was a series endpoint and nothing that
  // read it. `priceSeries` is one index range over ONE runner's fills, so a chart
  // costs one request — but only if something asks for it.
  //
  // ON DEMAND, NEVER ON THE POLL. The board re-reads every market's book every
  // 15 seconds; adding one request per runner per poll would be ~33 extra
  // synchronous reads per repaint for a chart most of the time nobody looks at,
  // and node:sqlite is single-threaded. So the chart is loaded when a runner is
  // ASKED for it, cached per (selection, window) until the next board repaint
  // clears it, and never fetched speculatively.
  //
  // A failure is silent but visible: the button says "unavailable" and the ladder
  // keeps working. A chart is not worth taking a board down for.
  const CHART_WINDOW_MINUTES = 60;
  const chartCache = new Map();

  function chartKey(selectionId, window) {
    return `${selectionId}:${window}`;
  }

  async function toggleChart(btn) {
    const id = btn.getAttribute('data-sel');
    if (!id) return;
    const sel = Number(id);
    // The host is the NEXT `.spark-row` after the price row this button is in —
    // a sibling of `.lrow`, never a child of it. See the note where the row is
    // built: a fourth child of `.lrow` would auto-place onto a second implicit
    // row and push every label in the ladder out of alignment (#136's geometry).
    const priceRow = btn.closest('.lrow');
    const hostRow = priceRow && priceRow.nextElementSibling && priceRow.nextElementSibling.classList.contains('spark-row')
      ? priceRow.nextElementSibling
      : null;
    const host = hostRow && hostRow.querySelector('.spark-host');
    if (!host) return;
    const shown = btn.getAttribute('aria-expanded') === 'true';
    if (shown) {
      btn.setAttribute('aria-expanded', 'false');
      hostRow.hidden = true;
      host.innerHTML = '';
      return;
    }
    btn.setAttribute('aria-expanded', 'true');
    hostRow.hidden = false;
    const key = chartKey(sel, CHART_WINDOW_MINUTES);
    const cached = chartCache.get(key);
    if (cached !== undefined) {
      host.innerHTML = cached;
      return;
    }
    host.innerHTML = '<span class="spark-wait muted">loading…</span>';
    try {
      const r = await OB.api('GET', `/api/selections/${sel}/price-history?window=${CHART_WINDOW_MINUTES}`);
      const series = (r && r.series) || [];
      // `sparkline()` returns '' for a series that cannot make a line, and that
      // empty string is CACHED with the rest: a runner with one fill would
      // otherwise re-fetch on every click for the rest of the session.
      // `OB.price2`, NOT `OB.fmt`. The series' `price` is a decimal odds value (2.00),
      // and `OB.fmt` formats CENTS as money — it rendered a price of 2.00 as
      // "$0.02" in the chart's accessible label. Caught by looking at the
      // rendered aria-label, which is the only place the number appears.
      const svg = OB.Ladder.sparkline(series, { fmt: OB.price2 });
      const html = svg || `<span class="muted">no price history in the last ${r.window_minutes}m</span>`;
      chartCache.set(key, html);
      // Only paint if this row is still on screen and still open: the poll can
      // have replaced the whole board while the request was in flight.
      if (!host.isConnected || btn.getAttribute('aria-expanded') !== 'true') return;
      host.innerHTML = html;
    } catch {
      if (!host.isConnected) return;
      host.innerHTML = '<span class="muted">chart unavailable</span>';
    }
  }

  // Betfair look: the best back price sits nearest the runner (rightmost of
  // the three left cells); the best lay price nearest the runner (leftmost of
  // the right cells).
  function ladderHtml(market, event) {
    // The header row must mirror the price row's grid exactly: 3 back columns,
    // the runner column, 3 lay columns. Each header spans three cells so the
    // labels sit centred over their own three-up group.
    // A market may have only one price level per side, and always emitting three
    // cells leaves two dead columns that shove the real price off-centre. Pad to
    // three, but mark the padding so the CSS can collapse it and let the live
    // cells take the width.
    // Row shape: RUNNER first, then three blue BACK cells, then three pink LAY
    // cells. Best price sits NEAREST the runner and depth runs outward, so the
    // ordering is reversed within each side.
    //
    // A market may have fewer than three levels on a side. Emitting dead cells
    // would shove the live price off-centre, so pad with a collapsed placeholder
    // that CSS hides — the grid columns stay aligned across rows either way.
    // Cell builder for one side. Defined inside the selection loop because it
    // closes over `sel`, the runner this row belongs to.
    // Build one side's three cells.
    //
    // The two BEST prices must sit directly adjacent, meeting in the middle of
    // the row: back's best occupies the rightmost column of the back group,
    // lay's best the leftmost of the lay group. With one level per side that
    // puts the two prices side by side rather than floating at the page edges,
    // and the depth levels then run outward from them.
    //
    // `align` says which end of the group the best price belongs to.
    const cellsFor = (sel, levels, side, align) => {
      const shown = levels.slice(0, 3);
      const n = shown.length;
      const out = shown.map((lv, i) => cellHtml(sel, market, event, lv, side, i > 0));
      while (out.length < 3) out.push('<div class="lcell empty blank"></div>');
      // n1/n2/n3 tell the CSS how many columns the live cells should span and
      // where to park them. CSS cannot infer this: every cell is the same
      // element type, so :only-of-type and :nth-child cannot see which ones are
      // real prices.
      const cls = `lstack n${n} ${align}`;
      return { cls, html: out.join('') };
    };
    // The header must consume exactly the same 7 grid columns as a price row:
    // RUNNER (1) | BACK (3) | LAY (3). A fourth child wraps onto a second
    // implicit row and throws every label out of alignment.
    const bookLabel = (v, label) =>
      v == null ? `${label} <span class="pct">—</span>` : `${label} <span class="pct">${v.toFixed(1)}%</span>`;
    let rows =
      '<div class="lrow lhdr">' +
      '<div class="hdr mid">RUNNER</div>' +
      `<div class="hdr b">${bookLabel(market.back_pct, 'BACK ALL')}</div>` +
      `<div class="hdr l">${bookLabel(market.lay_pct, 'LAY ALL')}</div></div>`;
    for (const sel of market.selections || []) {
      // Seeded selections carry an explicit status; feed selections do not, so
      // only an explicit non-'open' status suppresses the row.
      if (sel.status && sel.status !== 'open') {
        rows += `<div class="lrow"><div class="lmid"><div class="nm">${OB.esc(
          sel.name
        )}</div><div class="ltp muted">${OB.esc(sel.status)}</div></div><div class="lstack"></div><div class="lstack"></div></div>`;
        continue;
      }
      const back = sel.back || [];
      const lay = sel.lay || [];
      // Back arrives sorted high→low and lay low→high, so the BEST price is
      // index 0 on both sides. `atright` parks a side's first cell at the far
      // edge of that side's group and `atleft` at the near edge, which is why the
      // two classes are mirrored: with the best price first on both, the two best
      // prices land in the middle of the row and meet there (style.css:436).
      //
      // THE REVERSE THAT WAS HERE WAS THE BUG, AND IT INVERTED THE DOCUMENTED
      // INVARIANT. It made the back list worst-first, so `atright` parked the
      // WORST back price in the rightmost column of the back group — the column
      // touching the lay side. The junction between blue and pink, the most
      // prominent boundary in the row, was where the two prices a trader least
      // wants to meet were placed. Measured over 33 runner rows: the price
      // touching the lay group was the worst back on every one.
      //
      // Removing it makes the code match the comment it was written next to, and
      // makes "the two best prices meet in the middle" expressible at all.
      const b = cellsFor(sel, back, 'back', 'atright');
      const l = cellsFor(sel, lay, 'lay', 'atleft');
      // LAST TRADED PRICE — only worth showing when it says something the
      // ladder does not.
      //
      // It used to render whenever it was non-null, bare and unlabelled, in the
      // name column. When the last trade happened to be at a price that is
      // still on the ladder, that number appeared a second time OUTSIDE the
      // coloured boxes and read as a stray odds bug:
      //
      //   Park Meadings   Trap 1    LTP 5.10   back ladder 4.90 5.00 5.10
      //   Premier League  Arsenal   LTP 2.58   back ladder 2.54 2.56 2.58
      //
      // It showed on the FIRST runner of each card only because that is the one
      // that had traded; it was never a first-runner problem.
      //
      // So: suppress it when the ladder already shows that exact price (it adds
      // nothing and duplicates a number the reader can already see), and when it
      // IS shown, label it and give it a title, so a price that is genuinely
      // NOT on the ladder can never be mistaken for a live quote. An unlabelled
      // number sitting next to live prices will always be read as one of them.
      const ltpShown =
        sel.ltp != null &&
        ![...back, ...lay].some((lv) => lv && Number(lv.price) === Number(sel.ltp))
          ? `<div class="ltp tn" title="Last traded price — not currently on the ladder">` +
            `<span class="ltplab">LTP</span>${OB.price2(sel.ltp)}</div>`
          : '';
      // THE RUNNER'S WINDOWED MATCHED TOTAL (#93) IS NOT A BADGE HERE.
      //
      // It was, and it cost the runner its name. `.lmid` is a flex line holding
      // the name plus up to two badges; at the 570px floor the column is 150px
      // wide (`.lrow`: `minmax(150px, 1.6fr)`), so 126px of usable width had a
      // 51px `LTP` badge and a 102px `MATCHED` badge in it, and `.nm` was
      // measured at 0px — the name did not render on any row that had traded.
      // A ladder without visible runners is not a column with a crowding
      // problem, it is a broken ladder.
      //
      // So the windowed total went to the market header, beside the lifetime
      // total already there (see renderMarkets), and the per-LEVEL figures and
      // bars stayed in the price cells where they cost no width. What remains
      // here is the name and the pre-existing LTP badge, unchanged.
      //
      // The runner total is still reachable without spending width: it is the
      // runner cell's `title`, so hovering the name answers "what traded on this
      // runner lately" — and the movers strip lists the same figure for the
      // runners that moved most.
      const matchedTitle = sel.matched_cents
        ? ` title="${OB.esc(
            `${sel.name} — ${OB.fmt(sel.matched_cents)} matched across ${sel.matched_fills} fill${
              sel.matched_fills === 1 ? '' : 's'
            } in the last ${sel.matched_window_minutes || OB.Ladder.MATCHED_WINDOW_MINUTES} minute${
              (sel.matched_window_minutes || OB.Ladder.MATCHED_WINDOW_MINUTES) === 1 ? '' : 's'
            }, across every price on this runner`
          )}"`
        : '';
      rows +=
        `<div class="lrow">` +
        `<div class="lmid"${matchedTitle}><div class="nm" title="${OB.esc(sel.name)}">${OB.esc(sel.name)}</div>` +
        ltpShown +
        // THE CHART BUTTON (#93), the only new element inside the runner cell and
        // deliberately small: see the note above on why that column has no room.
        `<button type="button" class="spark-btn" data-sel="${OB.attr(sel.selection_id)}" ` +
        `aria-expanded="false" aria-label="Price history for ${OB.esc(sel.name)}" ` +
        `title="Traded price over the last ${CHART_WINDOW_MINUTES} minutes">▁▂▃</button>` +
        `</div>` +
        `<div class="${b.cls}">${b.html}</div>` +
        `<div class="${l.cls}">${l.html}</div></div>` +
        // THE CHART'S OWN ROW — a SIBLING of the price row, never a child of it.
        //
        // This is the geometry constraint stated as code. `.lrow` is an exact
        // seven-track grid and the comment in public/style.css says both the
        // header row and every price row must consume all seven or the labels
        // drift out of alignment. A fourth child would auto-place onto a second
        // implicit row: the runner cell would then stretch across both rows and
        // every label in the ladder would shift. So the chart gets its own row
        // whose single child spans `1 / -1` — it consumes seven tracks too, it
        // just has nothing else in them.
        `<div class="lrow spark-row" hidden><div class="spark-host"></div></div>`;
    }
    return `<div class="ladder">${rows}</div>`;
  }

  function cellHtml(sel, market, event, lv, side, isDepth) {
    if (!lv || !lv.size_cents) return '<div class="lcell empty">–</div>';
    const mktId = market.market_id != null ? market.market_id : market.id;
    // Flash state (S2): keyed by MARKET + selection + side + price, and reset
    // when the board switches markets — selection ids repeat across races
    // (feed selections are only unique within a market), so the old key let a
    // race's flash state bleed into the next one.
    if (String(mktId) !== String(OB.state.lastPricesMkt)) {
      lastPrices.clear();
      OB.state.lastPricesMkt = mktId;
    }
    const key = `${mktId}:${sel.selection_id}:${side}:${lv.price}`;
    const prev = lastPrices.get(key);
    lastPrices.set(key, lv.price);
    const flash = prev === undefined || prev === lv.price ? '' : lv.price > prev ? ' flash-up' : ' flash-down';
    const carried = lv.carried ? ' carried' : '';
    const depth = isDepth ? ' depth' : '';
    // THE MATCHED COLUMN (#93). `matchedCellParts` lives in ladder.js, not here,
    // so tests/ladder_parity.test.js can assert the exact markup under Node. A
    // column that can only be verified in a browser is a column nobody verifies.
    //
    // It rides INSIDE the cell — under the two numbers that were already there,
    // as a figure and a proportional bar — and NOT as an eighth grid column.
    // A new column would break the 7-column row geometry the ladder is built on
    // (public/ladder.js states it as LADDER_COLUMNS), and at the 570px floor
    // (#136) there is no width to spare. A bar costs none, and "how much of this
    // price is done" is what a trader's eye reads first.
    const cell = OB.Ladder.matchedCellParts(lv, OB.fmt);
    const f = cell.figures;
    // W7: real buttons — keyboard users can bet (Enter/Space come free), and
    // the price reads out to screen readers through the aria-label.
    const label = `${side === 'back' ? 'Back' : 'Lay'} ${sel.name} at ${OB.price2(lv.price)}, ${OB.fmt(f.unmatched_cents)} available`;
    // MATCHED VOLUME IN THE LABEL TOO. The unmatched size is what the button
    // ACTS on, so it leads; the matched figure follows, because a keyboard or
    // screen-reader user must get the same depth information the bar gives
    // everyone else. It was not in the label before #93.
    const labelFull = label + cell.labelSuffix;
    // FEED GATE (removable): feed prices build orders the exchange can never
    // accept (feed ids are not in the catalogue), so in feed mode the cells are
    // disabled buttons — focusable neither by pointer-trap nor tab, and
    // announced as unavailable. Remove the gate when feed markets are mapped
    // into the exchange catalogue (see also bindLadder + addToSlip).
    const gate = OB.state.feedMode ? ' disabled' : '';
    return (
      `<button type="button" class="lcell ${side}${flash}${carried}${depth}"${gate} data-bet="1" data-sel="${OB.attr(sel.selection_id)}" ` +
      `data-sname="${OB.esc(sel.name)}" data-mkt="${OB.attr(mktId)}" ` +
      `data-mname="${OB.esc(market.market_name || market.name)}" ` +
      `data-evt="${OB.esc((event && (event.event_name || event.name)) || '')}" ` +
      `data-side="${OB.esc(side)}" data-price="${OB.attr(lv.price)}" aria-label="${OB.esc(labelFull)}" title="${OB.esc(labelFull)}">` +
      `<span class="p tn">${OB.price2(lv.price)}</span><span class="s tn">${OB.fmt(f.unmatched_cents)}</span>` +
      `${cell.matchedRow}${cell.bar}</button>`
    );
  }

  // Last rendered price per (market, selection, side, price) for the flash
  // effect; lastPricesMkt scopes the map to the market currently on screen.
  const lastPrices = new Map();
  OB.state.lastPricesMkt = null;

  async function loadNav() {
    const seq = ++OB.state.navReqSeq;
    try {
      const sports = (await OB.api('GET', '/api/feed/nav')).sports || [];
      if (seq !== OB.state.navReqSeq) return; // a newer nav load owns state.nav
      OB.state.nav = sports;
      // Keep the current selection when it still exists, so a refresh does not
      // throw the bettor back to the first race of the first sport. When it does
      // not — first load, or a meeting the feed has rotated away — drill into
      // the first sport that has one, through exactly the code a click uses.
      // One code path means the first load and a click cannot diverge.
      // W2: drillFirst resolves into state only — no renderSidebar, no
      // refreshMarkets re-entry (the caller serializes and renders once).
      if (OB.state.navSel && OB.state.navSel.market_id && findMarket(OB.state.navSel.market_id)) return;
      for (const s of OB.state.nav || []) {
        if (OB.drillFirst({ sport: s.sport, country: null, comp: null, meeting: null })) return;
      }
      for (const k of OB.TREE_LEVELS) OB.state.treeOpen[k] = null;
    } catch {
      if (seq === OB.state.navReqSeq) OB.state.nav = [];
    }
  }

  // Is this market still present in the feed's tree? Decides whether a refresh
  // may keep the current selection or has to drill again.
  function findMarket(marketId) {
    for (const s of OB.state.nav || []) {
      for (const c of s.countries || []) {
        for (const k of c.competitions || []) {
          for (const m of k.meetings || []) {
            for (const r of m.races || []) {
              if (String(r.market_id) === String(marketId)) return { s, c, k, m, r };
            }
          }
        }
      }
    }
    return null;
  }


  // Search only. The ladder does NOT come from here: the board is a capped,
  // recency-sorted list and the catalogue is 1400+ markets, so a race picked
  // from the tree may not be in it at all. See loadSelectedMarket.
  async function loadFeedMarkets() {
    const seq = ++OB.state.boardReqSeq;
    try {
      const markets = (await OB.api('GET', '/api/feed/board?limit=500')).markets || [];
      if (seq === OB.state.boardReqSeq) OB.state.feedMarkets = markets;
    } catch {
      if (seq === OB.state.boardReqSeq) OB.state.feedMarkets = [];
    }
  }

  // The one market the page prices, by id. Anything outside the board's cap is
  // still reachable this way, which is what makes a deep tree navigable.
  async function loadSelectedMarket() {
    const id = OB.state.navSel && OB.state.navSel.market_id;
    if (!id) {
      OB.state.market = null;
      return;
    }
    const seq = ++OB.state.marketReqSeq;
    try {
      const res = await OB.api('GET', '/api/feed/market?id=' + encodeURIComponent(id));
      // A slower fetch for a PREVIOUSLY selected market must not overwrite the
      // one now on screen (state-level half of W2).
      if (seq !== OB.state.marketReqSeq) return;
      OB.state.market = res.market || null;
    } catch {
      if (seq === OB.state.marketReqSeq) OB.state.market = null;
    }
  }

  function bindLadder() {
    // ── FEED GATE (removable) ─────────────────────────────────────────────
    // Feed ladders are DISPLAY-ONLY: feed ids never exist in the exchange
    // catalogue (lib/feed.js inserts nothing into markets/selections), so any
    // bet built from them is rejected by validateOrder with 'Selection not
    // found'. Gate at the UI boundary: no bet handlers are attached in feed
    // mode, and the cells render as disabled buttons. To enable feed betting
    // once a feed→catalogue mapping exists, delete this early return (and the
    // matching guards in addToSlip and cellHtml's `gate`).
    if (OB.state.feedMode) {
      clearTimeout(OB.state.flashTimer);
      OB.state.flashTimer = setTimeout(() => {
        OB.qa('#page .flash-up, #page .flash-down').forEach((c) => c.classList.remove('flash-up', 'flash-down'));
      }, 700);
      return;
    }
    OB.qa('#page [data-bet]').forEach((c) => {
      c.onclick = () => {
        if (!OB.state.user) {
          OB.toast('Sign in to place a bet', 'err');
          OB.openAuth('login');
          return;
        }
        OB.addToSlip({
          selection_id: /^\d+$/.test(c.dataset.sel) ? Number(c.dataset.sel) : c.dataset.sel,
          selection_name: c.dataset.sname,
          market_id: /^\d+$/.test(c.dataset.mkt) ? Number(c.dataset.mkt) : c.dataset.mkt,
          market_name: c.dataset.mname,
          event_name: c.dataset.evt,
          side: c.dataset.side,
          price: Number(c.dataset.price),
        });
      };
    });
    // THE CHART BUTTON (#93). Bound here, INSIDE the non-feed path, because a feed
    // selection id is not in this venue's catalogue — `price-history` would 404
    // for every one of them, so in feed mode the button is simply not offered
    // rather than offered and always failing. The chart is READ-ONLY, so unlike
    // the bet cells it needs no session, no slip and no balance check.
    OB.qa('#page .spark-btn').forEach((b) => {
      b.onclick = () => toggleChart(b);
    });
    // Price flashes decay on their own so a fresh board keeps the tint brief.
    clearTimeout(OB.state.flashTimer);
    OB.state.flashTimer = setTimeout(() => {
      OB.qa('#page .flash-up, #page .flash-down').forEach((c) => c.classList.remove('flash-up', 'flash-down'));
    }, 700);
  }


  Object.assign(OB, { bindLadder, cellHtml, doCashOut, findMarket, ladderHtml, lastPrices, loadFeedMarkets, loadNav, loadSelectedMarket, renderMarkets, renderMovers, renderRaces, toggleChart, whenText });
})();
