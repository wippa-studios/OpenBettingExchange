// boot.js — SSE, and the one place the app starts
(() => {
  'use strict';

  const OB = window.OB;
  if (!OB) { console.error('[boot] window.OB missing — core.js must load first'); return; }

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

  // This file also OWNS the start, and is last in load order for exactly
  // that reason: boot() reaches the router, the loaders and every view, so
  // a single missing export would be a blank page rather than one broken
  // view.
  // ── SSE ──────────────────────────────────────────────────────────────────
  // SSE 'book' is broadcast globally on every place/cancel/match/settle, so a
  // burst of activity in unrelated markets used to trigger a full refresh per
  // event. Debounced 200ms and scoped by the frame's market_id: feed mode
  // prices ONE market, and frames for other races never touch the board. (W2)
  function scheduleBookRefresh(marketId) {
    if (OB.state.feedMode) {
      const sel = OB.state.navSel && OB.state.navSel.market_id;
      if (sel != null && marketId != null && String(marketId) !== String(sel)) return;
    }
    clearTimeout(OB.state.bookTimer);
    OB.state.bookTimer = setTimeout(() => {
      if (OB.state.page === 'markets') OB.refreshMarkets();
    }, 200);
  }

  // A stream the browser has GIVEN UP on (EventSource.CLOSED — proxy 502,
  // expired session) never comes back on its own; EventSource only retries
  // while readyState is CONNECTING. Re-establish it with capped backoff. (W5)
  function scheduleSSEReconnect() {
    clearTimeout(OB.state.sseRetryTimer);
    OB.state.sseRetryMs = Math.min(OB.state.sseRetryMs ? OB.state.sseRetryMs * 2 : 1000, 30000);
    OB.state.sseRetryTimer = setTimeout(() => {
      if (OB.state.sse && OB.state.sse.readyState === EventSource.CLOSED) connectSSE();
    }, OB.state.sseRetryMs);
  }

  function connectSSE() {
    clearTimeout(OB.state.sseRetryTimer);
    if (OB.state.sse) OB.state.sse.close();
    const es = new EventSource('/api/stream');
    es.onopen = () => {
      OB.state.sseRetryMs = 0; // stream proven — a later failure starts from 1s again
    };
    es.addEventListener('book', (e) => {
      let marketId = null;
      try {
        marketId = JSON.parse(e.data).market_id;
      } catch {
        /* frame without a market id — refresh anyway */
      }
      scheduleBookRefresh(marketId);
    });
    es.addEventListener('balance', () => {
      OB.refreshMe();
      if (OB.state.page === 'wallet') OB.loadWallet();
    });
    es.addEventListener('orders', () => {
      if (OB.state.page === 'bets') OB.renderBets();
    });
    es.addEventListener('settlement', () => {
      if (OB.state.page === 'markets') OB.refreshMarkets();
      if (OB.state.page === 'bets') OB.renderBets();
    });
    es.addEventListener('error', () => {
      // CONNECTING means the browser is already retrying — hands off.
      if (es.readyState === EventSource.CLOSED) scheduleSSEReconnect();
    });
    OB.state.sse = es;
  }

  // A tab parked in the background can silently lose the stream while the
  // backoff timer is still far in the future — on return, retry immediately.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (OB.state.sse && OB.state.sse.readyState === EventSource.CLOSED) connectSSE();
  });

  // Poll fallback so the board still moves if the stream drops. The feed
  // publishes on a ~3 minute cadence, so polling faster than that only
  // re-reads the same frame. While the stream is LIVE (readyState 1) the SSE
  // path already drives every update — polling on top of it would only
  // duplicate fetches and widen the stale-frame race. (W2)
  function startPoll() {
    clearInterval(OB.state.pollTimer);
    OB.state.pollTimer = setInterval(
      () => {
        if (OB.state.sse && OB.state.sse.readyState === 1) return;
        if (OB.state.page === 'markets') OB.refreshMarkets();
      },
      OB.state.feedMode ? 60000 : 15000
    );
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  async function boot() {
    // One-time static bindings. Page-level handlers are attached by the render
    // functions; nothing here touches rendered content.
    OB.qa('#nav button').forEach((b) => {
      b.onclick = () => {
        location.hash = '#/' + b.dataset.page;
      };
    });
    OB.$('authBtn').onclick = () => (OB.state.user ? OB.logout() : OB.openAuth('login'));
    OB.$('accountBtn').onclick = () => OB.openAccount();
    OB.$('pwGo').onclick = () => OB.submitPasswordChange();
    OB.$('authGo').onclick = OB.submitAuth;
    OB.$('authSwitch').onclick = () => OB.openAuth(OB.state.authMode === 'login' ? 'register' : 'login');
    OB.$('authPass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') OB.submitAuth();
    });
    OB.$('authUser').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') OB.submitAuth();
    });
    OB.$('authModal').onclick = (e) => {
      if (e.target.id === 'authModal') OB.closeAuth();
    };
    const nt = OB.$('navToggle');
    if (nt) nt.onclick = () => (document.body.classList.contains('nav-open') ? OB.closeNavRail() : OB.openNavRail());
    // Escape closes the TOPMOST open overlay (auth modal, admin settle
    // dialog), or the narrow-screen rail; Tab is trapped inside that overlay.
    // The old handler only knew #authModal, so admin dialogs ignored Escape.
    // (S4)
    document.addEventListener('keydown', (e) => {
      const top = OB.overlayStack[OB.overlayStack.length - 1];
      if (e.key === 'Escape') {
        if (top) OB.closeOverlay(top.overlay);
        else if (OB.$('authModal').classList.contains('show')) OB.closeAuth();
        else OB.closeNavRail();
      }
      if (e.key === 'Tab' && top) OB.trapTab(top.overlay, e);
    });
    window.addEventListener('hashchange', OB.route);
    OB.bindSlip(); // one delegated pair of listeners for the whole slip (W1)
    OB.bindSearch();
    const co = OB.$('cashoutBtn');
    if (co) co.onclick = OB.doCashOut;

    await OB.refreshMe();
    await OB.detectFeed();
    await OB.loadSports();
    // W2: single-pass boot. loadNav resolves the selection in state (it no
    // longer re-enters refreshMarkets via openBranch), so the loads run once
    // and route() renders once — the old boot fetched the board twice.
    if (OB.state.feedMode) {
      await OB.loadNav();
      await OB.loadFeedMarkets();
      await OB.loadSelectedMarket();
    } else {
      await OB.loadEvents(); // seeded catalogue; useless in feed mode (S7)
    }
    OB.renderSidebar(); // renders the feed tree, or hides the rail in seeded mode
    OB.renderSlip();
    connectSSE();
    startPoll();
    OB.route();
  }


  OB.state.booted = false;
  function bootOnce() {
    if (OB.state.booted) return;
    OB.state.booted = true;
    boot();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootOnce);
  } else {
    bootOnce();
  }

  Object.assign(OB, { boot, bootOnce, connectSSE, scheduleBookRefresh, scheduleSSEReconnect, startPoll });
})();
