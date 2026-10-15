// core.js — state, DOM helpers, api, toast, tick ladder, overlay stack
//
// Split out of the former single-file app.js (1,891 lines). Behaviour is
// UNCHANGED: a mechanical extraction, not a rewrite. What changed is that each
// file is now readable on its own and none exceeds ~430 lines.
//
// WIRING. Classic scripts share one global scope, so the only safe way to
// share across files is an explicit namespace. window.OB is created HERE and
// extended by each file loaded after it, in order. Nothing else leaks: a
// top-level binding would collide with any other classic script on the page
// and be a fatal SyntaxError.
(() => {
  'use strict';

  const OB = (window.OB = window.OB || {});

  // ── state ────────────────────────────────────────────────────────────────
  // Tree levels, shallowest first. Used to collapse a branch and everything
  // beneath it in one pass.
  const TREE_LEVELS = ['sport', 'country', 'comp', 'meeting'];

  const state = {
    user: null,
    // Per-mount request tokens (#49). This lives ON `state` — not on a separate
    // `OB.state` — because `state` IS `OB.state`: the export at the bottom of
    // this file does `Object.assign(OB, { … state … })`, so anything created on
    // a different object is overwritten the moment core.js finishes loading, and
    // `beginLoad` then reads `reqSeq` off an object that has none.
    reqSeq: {},
    page: 'markets',
    sport: null,          // active sport slug (null = all)
    sports: [],
    market: null,         // the ONE selected market, fetched by id (feed mode)
    nav: null,            // the feed's sport -> country -> track -> meeting -> race tree
    navSel: null,         // the selected branch and the one chosen market
    // Which branch of the left tree is open, per level. Opening one closes its
    // siblings, so the rail always shows a single path.
    treeOpen: { sport: null, country: null, comp: null, meeting: null },
    events: [],
    slip: [],             // [{selection_id, selection_name, market_id, market_name, event_name, side, price, stake_cents}]
    betsTab: 'open',
    sse: null,
    pollTimer: null,
    flashTimer: null,
    bookTimer: null,      // SSE 'book' debounce
    sseRetryTimer: null,  // dead-stream reconnect backoff timer (W5)
    sseRetryMs: 0,        // current backoff, doubled per failure, reset on open
  };

  // ── tiny DOM helpers ─────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Escape ALL server-provided text before it goes near innerHTML. Sport,
  // event and selection names are admin-authored, so they are untrusted.
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // Strict escaper for interpolated server values in ATTRIBUTES — including
  // numeric ids and prices. Text is escaped; numbers must be finite: a NaN
  // id reaching a data- attribute is a bug we want loud, never a silent
  // "NaN" selector that queries the wrong row. (W10)
  function attr(v) {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new TypeError('non-finite number in attribute');
      return String(v);
    }
    return esc(v);
  }

  // Server numbers rendered as TEXT (not attributes): absent or unparseable
  // shows the fallback instead of "null" / "NaN".
  const num = (v, fallback = '—') => (Number.isFinite(v) ? String(v) : fallback);

  // Writing innerHTML into a node that a re-render already detached throws
  // NotFoundError ("node to be removed is no longer a child"). Every async
  // writer re-checks with isConnected before touching the DOM.
  function setHtml(node, html) {
    if (!node || !node.isConnected) return false;
    node.innerHTML = html;
    return true;
  }
  const el = (id) => {
    const n = OB.$(id);
    return n && n.isConnected ? n : null;
  };

  // ── sequence guards (last-arrival-wins is not a render policy) ───────────
  // An async loader must not paint a response that a NEWER load has already
  // superseded. Re-checking that the mount still exists only detects PAGE
  // navigation — switching a tab re-creates the same mount, so a slow in-flight
  // load passes the existence check and overwrites the newer tab's content while
  // the newer tab is highlighted. Every trigger is routine: two tab clicks, an
  // SSE burst, two balance events, two refreshMe calls.
  //
  // One token PER MOUNT POINT, never per loader: several loaders render into the
  // same container (#betsBody is written by loadOpenOrders, loadPositions AND
  // loadSettled), so a per-loader token would still let a stale loadPositions
  // overwrite a fresh loadOpenOrders — the precise bug the guard exists to stop.
  //
  // The state lives here, in core.js, because that is the only module loaded
  // before every other one, and the two calls are resolved through OB at the call
  // site like every other cross-module name.
  // `reqSeq` is initialised on `state` above, and `state` is what `OB.state` is —
  // see the note on the declaration. Nothing is created here: doing so created a
  // SECOND object that the export below immediately replaced, which surfaced as
  // "cannot read properties of undefined (reading 'me')" the first time any
  // loader ran, and as five unrelated errors in between.
  function beginLoad(mount) {
    const seq = (state.reqSeq[mount] || 0) + 1;
    state.reqSeq[mount] = seq;
    return seq;
  }
  const isCurrent = (mount, seq) => state.reqSeq[mount] === seq;

  const fmt = (cents) => '$' + ((Number(cents) || 0) / 100).toFixed(2);
  const signed = (cents) => (cents >= 0 ? '+' : '−') + fmt(Math.abs(cents));
  const price2 = (p) => (p == null ? '—' : Number(p).toFixed(2));

  // ── api ──────────────────────────────────────────────────────────────────
  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (res.status === 401 && state.user) {
      // The session died mid-flight (expired or replaced). Mirror logout()'s
      // cleanup so no stale private state survives: slip, header, the stream's
      // identity and the page all reset together. (S9)
      state.user = null;
      state.slip = [];
      OB.renderSlip();
      renderHeader();
      OB.connectSSE(); // the stream carries the userId — rebind it to anonymous
      OB.route();
    }
    if (!res.ok) {
      const err = new Error((json && json.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // ── toast ────────────────────────────────────────────────────────────────
  state.toastTimer = null;
  function toast(msg, kind = 'ok') {
    const t = OB.$('toast');
    t.textContent = msg;
    t.className = 'show ' + kind;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      t.className = '';
    }, 2600);
  }

  // ── client-side tick ladder ──────────────────────────────────────────────
  // The band table, snap and step maths live in ladder.js (integer price-cents),
  // loaded BEFORE this file — tests/ladder_parity.test.js pins it to lib/odds.js
  // so the slip's stepper can never disagree with the engine. UX sugar only:
  // the server re-snaps every price it accepts.
  const Ladder = window.OBLadder;

  // ── header / auth ────────────────────────────────────────────────────────
  function renderHeader() {
    const bal = OB.$('balance');
    const who = OB.$('who');
    const btn = OB.$('authBtn');
    const admin = OB.$('navAdmin');
    const acct = OB.$('accountBtn');
    if (state.user) {
      const avail = state.user.balance_cents - state.user.frozen_cents;
      bal.hidden = false;
      bal.innerHTML =
        `<span class="tn">${fmt(avail)}</span> <small>avail · ${fmt(state.user.frozen_cents)} frozen</small>`;
      who.textContent = state.user.username + (state.user.role === 'admin' ? ' · admin' : '');
      btn.textContent = 'Sign out';
      acct.hidden = false;
      admin.hidden = state.user.role !== 'admin';
    } else {
      bal.hidden = true;
      who.textContent = '';
      btn.textContent = 'Sign in';
      acct.hidden = true;
      admin.hidden = true;
    }
  }

  // The header balance and the session identity are a MOUNT POINT of their own:
  // two SSE `balance` events in quick succession fire two of these, and the
  // slower one must not roll the balance back or resurrect a stale identity.
  async function refreshMe() {
    const seq = beginLoad('me');
    try {
      const r = await api('GET', '/api/me');
      if (!isCurrent('me', seq)) return; // a newer refreshMe owns the header
      state.user = r.user;
      // The server's stake window, when it publishes one, replaces the client's
      // documented defaults (issue #47) so the slip can never hold a stake the
      // engine will refuse — nor refuse one it would accept. A build that does
      // not publish it simply leaves slip.js's defaults alone.
      if (OB.setStakeBounds) OB.setStakeBounds(r.stake_bounds);
    } catch {
      if (!isCurrent('me', seq)) return;
      state.user = null;
    }
    renderHeader();
  }

  async function logout() {
    try {
      await api('POST', '/api/auth/logout');
    } catch (e) {
      toast(e.message, 'err');
    }
    state.user = null;
    state.slip = [];
    OB.renderSlip();
    renderHeader();
    OB.connectSSE(); // the stream carries userId — rebind it to the new identity
    // The tenant falls back to the default when signed out, so the palette has
    // to go back with it — otherwise a player keeps an operator's branding.
    await OB.loadBranding();
    OB.route();
    toast('Signed out');
  }

  // ── overlay stack: Escape routing + focus management (S4) ────────────────
  // Both the auth modal (here) and the admin settle dialog (admin.js) are
  // modal overlays. Escape must close only the TOPMOST open overlay, and focus
  // must return to the element that opened it — so every overlay registers
  // here, and the shared keydown handler in boot() walks the stack.
  const overlayStack = [];
  const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

  function openOverlay(overlay, focusEl) {
    // Idempotent: opening an already-open overlay re-focuses it instead of
    // pushing a second stack entry (which would make Escape need two presses).
    if (!overlayStack.some((o) => o.overlay === overlay)) {
      overlayStack.push({ overlay, wasFocused: document.activeElement });
    }
    overlay.classList.add('show'); // auth modal; admin's .modal is flex already
    const target = focusEl || qa(FOCUSABLE, overlay)[0];
    if (target) target.focus();
  }

  function closeOverlay(overlay) {
    const i = overlayStack.findIndex((o) => o.overlay === overlay);
    let wasFocused = null;
    if (i >= 0) wasFocused = overlayStack.splice(i, 1)[0].wasFocused;
    // Static modals (auth, account) live in index.html and are only hidden;
    // admin dialogs are built fresh on every open, so those are removed.
    // data-persist marks the static ones — special-casing #authModal by id was
    // how the first one worked, and a second static modal made that invisible
    // assumption destroy it: overlay.remove() deleted #accountModal from the
    // DOM on the first Escape, and every later open was a null crash.
    if (overlay.hasAttribute('data-persist') || overlay.id === 'authModal') overlay.classList.remove('show');
    else overlay.remove();
    if (wasFocused && wasFocused.isConnected) wasFocused.focus();
  }

  // Keep Tab inside the topmost overlay: a modal must not leak focus to the
  // (still visible) page behind it.
  function trapTab(overlay, e) {
    const nodes = qa(FOCUSABLE, overlay).filter((n) => !n.disabled && n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!overlay.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }


  // Everything core declares, exported so the modules below can reach it.
  // Derived from the file's own definitions rather than hand-listed, because
  // a hand-written list is how a name goes missing and surfaces as an
  // undefined reference buried in a view three files away.
  Object.assign(OB, { $, FOCUSABLE, Ladder, TREE_LEVELS, api, attr, beginLoad, closeOverlay, el, esc, fmt, isCurrent, logout, num, openOverlay, overlayStack, price2, qa, refreshMe, renderHeader, setHtml, signed, state, toast, trapTab });
})();
