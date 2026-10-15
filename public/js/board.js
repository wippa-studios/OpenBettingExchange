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
      if (open.length > 1) {
        OB.state.betsTab = 'positions';
        location.hash = '#/bets';
        OB.toast('Multiple positions can be cashed out — pick one in Positions');
        return;
      }
      const target = open[0];
      const r = await OB.api('POST', `/api/markets/${target.market_id}/cashout`);
      const v = r.value_cents;
      OB.toast(`Cashed out ${v >= 0 ? '+' : '−'}${OB.fmt(Math.abs(v))} on ${target.market_name}`, v >= 0 ? 'ok' : 'err');
      await OB.refreshMe();
      OB.renderBets();
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
    if (!OB.state.events.length) {
      page.innerHTML = '<div class="card"><div class="empty">No open events right now</div></div>';
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
          html += `<div class="mkt">
            <div class="mkthead">
              <span>${OB.esc(m.name)}</span>
              <span class="chip ${OB.esc(m.status)}">${OB.esc(m.status)}</span>
              <span class="muted tn">${OB.fmt(m.total_matched_cents)} matched</span>
            </div>
            ${ladderHtml(m, e)}
          </div>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }
    page.innerHTML = html;
    bindLadder();
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
      rows +=
        `<div class="lrow">` +
        `<div class="lmid"><div class="nm" title="${OB.esc(sel.name)}">${OB.esc(sel.name)}</div>` +
        ltpShown +
        `</div>` +
        `<div class="${b.cls}">${b.html}</div>` +
        `<div class="${l.cls}">${l.html}</div></div>`;
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
    // W7: real buttons — keyboard users can bet (Enter/Space come free), and
    // the price reads out to screen readers through the aria-label.
    const label = `${side === 'back' ? 'Back' : 'Lay'} ${sel.name} at ${OB.price2(lv.price)}, ${OB.fmt(lv.size_cents)} available`;
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
      `data-side="${OB.esc(side)}" data-price="${OB.attr(lv.price)}" aria-label="${OB.esc(label)}" title="${OB.esc(label)}">` +
      `<span class="p tn">${OB.price2(lv.price)}</span><span class="s tn">${OB.fmt(lv.size_cents)}</span></button>`
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
    // Price flashes decay on their own so a fresh board keeps the tint brief.
    clearTimeout(OB.state.flashTimer);
    OB.state.flashTimer = setTimeout(() => {
      OB.qa('#page .flash-up, #page .flash-down').forEach((c) => c.classList.remove('flash-up', 'flash-down'));
    }, 700);
  }


  Object.assign(OB, { bindLadder, cellHtml, doCashOut, findMarket, ladderHtml, lastPrices, loadFeedMarkets, loadNav, loadSelectedMarket, renderMarkets, renderRaces, whenText });
})();
