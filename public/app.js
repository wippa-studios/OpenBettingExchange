// app.js — OpenBettingExchange exchange UI.
//
// House convention: ONE IIFE, ONE controlled global (window.OB) shared with
// admin.js — no top-level bindings leak into the page scope (classic scripts
// share a single global scope, so a collision is a fatal SyntaxError).
(() => {
  'use strict';

  // ── state ────────────────────────────────────────────────────────────────
  // Tree levels, shallowest first. Used to collapse a branch and everything
  // beneath it in one pass.
  const TREE_LEVELS = ['sport', 'country', 'comp', 'meeting'];

  const state = {
    user: null,
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
    const n = $(id);
    return n && n.isConnected ? n : null;
  };

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
      renderSlip();
      renderHeader();
      connectSSE(); // the stream carries the userId — rebind it to anonymous
      route();
    }
    if (!res.ok) {
      const err = new Error((json && json.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // ── toast ────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, kind = 'ok') {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
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
    const bal = $('balance');
    const who = $('who');
    const btn = $('authBtn');
    const admin = $('navAdmin');
    const acct = $('accountBtn');
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

  async function refreshMe() {
    try {
      state.user = (await api('GET', '/api/me')).user;
    } catch {
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
    renderSlip();
    renderHeader();
    connectSSE(); // the stream carries userId — rebind it to the new identity
    route();
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

  // ── narrow-screen race rail (W9) ─────────────────────────────────────────
  // Below 1000px the tree becomes a drawer driven by #navToggle. Picking a
  // race (or Escape) closes it so the board is readable again.
  function openNavRail() {
    document.body.classList.add('nav-open');
    const t = $('navToggle');
    if (t) t.setAttribute('aria-expanded', 'true');
    const first = qa('#sportsList .treeitem')[0];
    if (first) first.focus();
  }
  function closeNavRail() {
    if (!document.body.classList.contains('nav-open')) return;
    document.body.classList.remove('nav-open');
    const t = $('navToggle');
    if (t) {
      t.setAttribute('aria-expanded', 'false');
      t.focus();
    }
  }

  let authMode = 'login';
  function openAuth(mode) {
    authMode = mode || 'login';
    const registering = authMode !== 'login';
    $('authTitle').textContent = registering ? 'Create account' : 'Sign in';
    $('authGo').textContent = registering ? 'Register' : 'Sign in';
    $('authSwitch').textContent = registering ? 'Sign in' : 'Register';
    // On sign-in the identifier accepts a username OR an email, so there is
    // only ever one field to fill. Registration adds the optional address.
    $('authEmailWrap').style.display = registering ? '' : 'none';
    $('authUser').placeholder = registering ? 'username' : 'username or email';
    $('authUser').value = '';
    $('authEmail').value = '';
    $('authPass').value = '';
    openOverlay($('authModal'), $('authUser'));
  }
  const closeAuth = () => closeOverlay($('authModal'));

  async function submitAuth() {
    const identifier = $('authUser').value.trim();
    const password = $('authPass').value;
    try {
      if (authMode === 'login') {
        // Sent as `identifier` rather than `username` so the intent is
        // unambiguous at the server: this may well be an email address.
        const r = await api('POST', '/api/auth/login', { identifier, password });
        state.user = r.user;
        closeAuth();
        renderHeader();
        connectSSE(); // private balance/orders events follow the new session
        route();
        toast(`Welcome back, ${r.user.username}`);
      } else {
        const email = $('authEmail').value.trim();
        const r = await api('POST', '/api/auth/register', {
          username: identifier,
          password,
          ...(email ? { email } : {}),
        });
        state.user = r.user;
        closeAuth();
        renderHeader();
        connectSSE();
        route();
        toast('Account created — top up in Wallet');
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ── Account panel ─────────────────────────────────────────────────────────
  // Change password, and see/revoke every device signed in to this account.
  // Revoking here is the counterpart to the server revoking all OTHER sessions
  // on a password change: the two together cover both "someone else has my
  // password" and "someone else has my cookie".
  async function renderSessions() {
    const box = $('sessionList');
    box.textContent = 'Loading…';
    let list;
    try {
      list = (await api('GET', '/api/auth/sessions')).sessions;
    } catch (e) {
      box.textContent = e.message;
      return;
    }
    if (!list.length) {
      box.textContent = 'No active sessions.';
      return;
    }
    box.textContent = '';
    for (const s of list) {
      const row = document.createElement('div');
      // .sess-row instead of row.style.marginBottom — the CSP blocks inline
      // style ATTRIBUTES, not CSSOM writes, but the house convention is no
      // ad-hoc styling anywhere, so layout belongs in style.css either way.
      row.className = 'row sess-row';
      const label = document.createElement('span');
      label.textContent =
        `${s.current ? '● this device' : '○'} · started ${s.created_at} · expires ${s.expires_at}`;
      const btn = document.createElement('button');
      btn.className = 'btn sm';
      btn.textContent = 'Sign out';
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api('DELETE', `/api/auth/sessions/${encodeURIComponent(s.id)}`);
          if (s.current) {
            // Revoked the session this tab is using — it is gone now.
            toast('Signed out');
            closeOverlay($('accountModal'));
            logout();
          } else {
            toast('Device signed out');
            renderSessions();
          }
        } catch (e) {
          toast(e.message, 'err');
          btn.disabled = false;
        }
      };
      row.append(label, btn);
      box.append(row);
    }
  }

  function openAccount() {
    if (!state.user) return openAuth('login');
    $('accountWho').textContent =
      `${state.user.username}${state.user.email ? ' · ' + state.user.email : ''}` +
      `${state.user.role === 'admin' ? ' · admin' : ''}`;
    $('pwCurrent').value = '';
    $('pwNew').value = '';
    $('pwNote').textContent = '';
    openOverlay($('accountModal'), $('pwCurrent'));
    renderSessions();
  }

  async function submitPasswordChange() {
    const currentPassword = $('pwCurrent').value;
    const newPassword = $('pwNew').value;
    try {
      const r = await api('POST', '/api/auth/change-password', { currentPassword, newPassword });
      $('pwCurrent').value = '';
      $('pwNew').value = '';
      $('pwNote').textContent = r.sessions_revoked
        ? `Password changed — ${r.sessions_revoked} other session(s) signed out.`
        : 'Password changed.';
      toast('Password changed');
      renderSessions();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ── routing ──────────────────────────────────────────────────────────────
  function route() {
    const hash = (location.hash || '#/markets').replace('#/', '');
    const known = ['markets', 'bets', 'wallet', 'admin'];
    state.page = known.indexOf(hash) >= 0 ? hash : 'markets';
    if (state.page === 'admin' && !(state.user && state.user.role === 'admin')) state.page = 'markets';
    qa('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === state.page));
    renderPage();
  }

  function renderPage() {
    const page = $('page');
    page.innerHTML = '';
    if (state.page === 'markets') {
      // Feed mode needs its own container above the ladder area; seeded mode
      // renders straight into #page.
      if (state.feedMode) {
        page.innerHTML = '<div id="races"></div>';
        return renderMarkets();
      }
      return renderMarkets();
    }
    if (state.page === 'bets') return renderBets();
    if (state.page === 'wallet') return renderWallet();
    if (state.page === 'admin' && window.OBAdmin) return window.OBAdmin.render(page);
    page.innerHTML = '<div class="card"><div class="empty">Nothing here</div></div>';
  }

  // ── data loaders ─────────────────────────────────────────────────────────
  // Probe once at boot: a 409 from /api/feed/nav means FEED_ENABLED=false, and
  // the board stays on the seeded catalogue. Avoids shipping the feed flag to
  // the browser as a build-time constant.
  async function detectFeed() {
    try {
      const j = await (await fetch('/api/feed/nav')).json();
      state.feedMode = !!(j && j.enabled);
    } catch {
      state.feedMode = false;
    }
  }

  async function loadSports() {
    try {
      state.sports = (await api('GET', '/api/sports')).sports;
    } catch {
      state.sports = [];
    }
    // In feed mode the sport/country/track selects replace the seeded chip bar,
    // so rendering it would just confuse the two navigation models.
    if (!state.feedMode) renderSportNav();
  }

  async function loadEvents() {
    // State-level race guard (W2): only the LATEST events fetch may write
    // state.events — a slow stale response landing after a newer one must
    // neither render (refreshMarkets' seq token) nor corrupt state.
    const seq = ++eventsReqSeq;
    const qs = state.sport ? `?sport=${encodeURIComponent(state.sport)}` : '';
    try {
      const events = (await api('GET', '/api/events' + qs)).events;
      if (seq === eventsReqSeq) state.events = events;
    } catch {
      if (seq === eventsReqSeq) state.events = [];
    }
    // Pure loader: rendering is refreshMarkets()'s job.
  }

  // Feed-aware refresh: in feed mode the nav and the races both move every
  // cycle, so both are reloaded and the page re-rendered.
  //
  // SERIALIZATION (W2): every refresh takes a ticket; when a newer refresh
  // starts while this one's fetches are in flight, the older one's renders are
  // dropped so a slow response can never paint over a fresh one.
  let refreshSeq = 0;
  let eventsReqSeq = 0;
  let navReqSeq = 0;
  let boardReqSeq = 0;
  let marketReqSeq = 0;
  async function refreshMarkets() {
    const seq = ++refreshSeq;
    if (state.feedMode) {
      await loadNav(); // pure loader + selection resolution — no re-entry
      await loadFeedMarkets();
      await loadSelectedMarket();
      if (seq !== refreshSeq) return; // superseded — never render stale data
      renderSidebar();
      if (state.page === 'markets') renderMarkets();
      return;
    }
    await loadEvents();
    if (seq !== refreshSeq) return;
    if (state.page === 'markets') renderMarkets();
  }

  async function refreshAll() {
    // refreshMarkets is feed-aware, so admin actions (create/settle/suspend)
    // refresh whatever board the deployment actually shows.
    await Promise.all([refreshMe(), loadSports(), refreshMarkets()]);
  }

  // ── sports filter ────────────────────────────────────────────────────────
  function renderSportNav() {
    let bar = $('sportbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'sportbar';
      bar.className = 'sportbar';
      $('nav').parentNode.insertBefore(bar, $('nav').nextSibling);
    }
    const all = `<button class="chip ${state.sport === null ? 'on' : ''}" data-sport="">All</button>`;
    const chips = state.sports
      .map(
        (s) =>
          `<button class="chip ${state.sport === s.slug ? 'on' : ''}" data-sport="${attr(s.slug)}">${esc(s.name)} <span class="muted">${s.event_count}</span></button>`
      )
      .join('');
    bar.innerHTML = all + chips;
    qa('button[data-sport]', bar).forEach((b) => {
      b.onclick = () => {
        state.sport = b.dataset.sport || null;
        renderSportNav();
        refreshMarkets();
      };
    });
  }

  // ── left rail: expandable tree ───────────────────────────────────────────
  // A deep tree, bookmaker style:
  //   Sport > Country > Track > Meeting > each race by start time.
  // Only the path to the current selection is expanded, so the rail stays
  // scannable instead of dumping 200 leaf nodes on screen.
  function renderSidebar() {
    const aside = $('sidebar');
    const list = $('sportsList');
    if (!aside || !list) return;
    // Seeded mode has no tree data — hide the rail instead of leaving a
    // permanent "No sports" placeholder. The sport chips are that mode's nav.
    if (!state.feedMode) {
      aside.hidden = true;
      return;
    }
    aside.hidden = false;
    const sports = state.nav || [];
    if (!sports.length) {
      list.innerHTML = '<div class="sempty">No sports</div>';
      return;
    }
    const sel = state.navSel || {};
    const activeMarket = String(sel.market_id || '');

    // Expansion reads ONLY from state.treeOpen, never from the selection.
    // Gating expansion on "is this the selected sport" meant opening a second
    // sport could never expand anything: the old sport collapsed, the new one
    // was not the selection, so the rail emptied. Expansion and selection are
    // now separate concerns, and openBranch() sets both together.
    let html = '';
    for (const s of [...sports].sort((a, b) => a.sport.localeCompare(b.sport))) {
      const sOpen = state.treeOpen.sport === s.sport;
      html += treeNode('sport', s.sport, s.sport === sel.sport, sOpen, { sport: s.sport });
      if (!sOpen) continue;
      for (const c of s.countries) {
        const cOpen = sOpen && state.treeOpen.country === c.country;
        html += treeNode('country', c.country, c.country === sel.country, cOpen,
          { sport: s.sport, country: c.country });
        if (!cOpen) continue;
        for (const k of c.competitions) {
          const kOpen = cOpen && state.treeOpen.comp === k.competition;
          html += treeNode('comp', k.competition, k.competition === sel.competition, kOpen,
            { sport: s.sport, country: c.country, comp: k.competition });
          if (!kOpen) continue;
          for (const m of k.meetings) {
            const mOpen = kOpen && String(state.treeOpen.meeting) === String(m.event_id);
            html += treeNode('meeting', m.event_name, String(m.event_id) === String(sel.event_id), mOpen,
              { sport: s.sport, country: c.country, comp: k.competition, meeting: m.event_id });
            if (!mOpen) continue;
            for (const r of racesByTime(m)) {
              const rOn = String(r.market_id) === activeMarket;
              html += `<button class="treeitem race${rOn ? ' on' : ''}" data-mkt="${attr(r.market_id)}">`
                + `<span class="t">${esc(clockText(r.market_time))}</span>`
                + `<span class="n">${esc(r.market_label || r.market_name)}</span>`
                + `${r.in_play ? '<span class="dot live"></span>' : ''}</button>`;
            }
          }
        }
      }
    }
    list.innerHTML = html;

    // A race leaf carries no ancestry data of its own: it is only reachable
    // inside an expanded branch, and the branch already knows where it is.
    // Copy the path from the open nodes rather than restating it per leaf.
    qa('.treeitem.race', list).forEach((b) => {
      b.onclick = () => {
        state.navSel = Object.assign({}, state.navSel, { market_id: b.dataset.mkt });
        closeNavRail(); // narrow screens: picking a race closes the drawer (W9)
        renderSidebar();
        refreshMarkets();
      };
    });

    // Disclosure toggles are delegated so a rebuilt tree carries no stale
    // handlers. Which branch is open lives in state, not in the DOM.
    qa('.treeitem[data-kind]', list).forEach((b) => {
      b.onclick = () => {
        const level = TREE_LEVELS[b.dataset.kind];
        if (b.dataset.open === '1') {
          // Collapsing hides this level and everything beneath it. The board
          // keeps showing the selected race: the rail changing must not change
          // what is priced.
          for (let i = TREE_LEVELS.indexOf(level); i < TREE_LEVELS.length; i++) {
            state.treeOpen[TREE_LEVELS[i]] = null;
          }
          renderSidebar();
          return;
        }
        openBranch({
          sport: b.dataset.sport,
          country: b.dataset.country || null,
          comp: b.dataset.comp || null,
          meeting: b.dataset.meeting || null,
        });
      };
    });
  }

  // Resolve a tree path down to one concrete chain WITHOUT rendering or
  // refreshing: loadNav() uses this to keep the boot/refresh path single-pass
  // (it used to re-enter refreshMarkets through openBranch, double-fetching
  // the board on every nav load), and openBranch() wraps it with the
  // render + refresh a user click wants.
  function drillFirst(path) {
    const chain = resolveChain(path);
    // The feed can rotate a meeting away between render and click. Rather than
    // expand a branch whose races are gone, collapse back and leave the board
    // alone — an empty rail reads as a broken page.
    if (!chain) {
      for (const k of TREE_LEVELS) state.treeOpen[k] = null;
      return false;
    }
    state.treeOpen.sport = chain.s.sport;
    state.treeOpen.country = chain.c ? chain.c.country : null;
    state.treeOpen.comp = chain.k.competition;
    state.treeOpen.meeting = chain.m.event_id;
    state.navSel = {
      sport: chain.s.sport,
      country: chain.c ? chain.c.country : null,
      competition: chain.k.competition,
      event_id: chain.m.event_id,
      market_id: chain.r.market_id,
    };
    return true;
  }

  // Open a branch AND select the earliest race inside it, so the rail and the
  // board can never disagree about which market is priced. Opening Horse
  // Racing therefore behaves exactly like opening Greyhound Racing: nothing
  // below the sport level is hardcoded for one racing code or the other.
  function openBranch(path) {
    const ok = drillFirst(path);
    renderSidebar();
    if (ok) refreshMarkets();
    return ok;
  }

  // Walk a tree path down to one concrete chain: sport, country, track,
  // meeting and the earliest race in it. Picks the earliest race rather than
  // the first row so that opening a meeting lands on the next race off, which
  // is what a bettor opening a meeting wants to see.
  function resolveChain(path) {
    const s = find(state.nav || [], 'sport', path.sport);
    if (!s) return null;
    const c = path.country ? find(s.countries, 'country', path.country) : null;
    if (path.country && !c) return null;
    const k = path.comp ? find((c || s).competitions || [], 'competition', path.comp) : null;
    if (path.comp && !k) return null;
    // Flatten to the track nodes under this branch. s.countries holds COUNTRY
    // nodes, whose children are tracks, so a branch that names neither a country
    // nor a track has to be collected through one more level before it can be
    // walked for meetings.
    let tracks;
    if (k) {
      tracks = [k];
    } else {
      tracks = [];
      for (const cc of c ? [c] : s.countries || []) tracks.push(...(cc.competitions || []));
    }
    // Candidate meetings: the one named by the path, else everything beneath
    // the node the click landed on.
    let best = null;
    for (const kk of tracks) {
      for (const m of kk.meetings || []) {
        if (path.meeting && String(m.event_id) !== String(path.meeting)) continue;
        for (const r of racesByTime(m)) {
          if (!best || ms(r.market_time) < ms(best.r.market_time)) best = { k: kk, m, r };
        }
      }
    }
    if (!best) return null;
    // Recover the country that owns the chosen track: opening a sport has to
    // expose the country level, which the path never named.
    const owner = [c, ...s.countries].find((cc) => cc && (cc.competitions || []).includes(best.k));
    return { s, c: owner || null, k: best.k, m: best.m, r: best.r };
  }

  // Races in start order. Absent or unparseable times sort last rather than
  // poisoning the comparison with NaN, which would leave the list unsorted.
  function racesByTime(meeting) {
    return (meeting.races || []).slice().sort((a, b) => ms(a.market_time) - ms(b.market_time));
  }

  function ms(iso) {
    const t = iso ? new Date(iso).getTime() : NaN;
    return isNaN(t) ? Infinity : t;
  }

  // HH:MM for a race's start time, the label a racing tree uses per node.
  function clockText(iso) {
    if (!iso) return '--:--';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '--:--';
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // One tree row: a disclosure caret plus the label. Toggling is handled by
  // delegation in bindTree() rather than per-node handlers, so rebuilding the
  // tree never leaves stale listeners behind.
  function treeNode(kind, label, isCurrent, isOpen, path) {
    const attrs = Object.keys(path)
      .map((key) => ` data-${key}="${attr(path[key])}"`).join('');
    return (
      `<button class="treeitem ${kind}${isCurrent ? ' cur' : ''}" data-kind="${kind}"${attrs}` +
      ` data-open="${isOpen ? '1' : ''}">` +
      `<span class="caret${isOpen ? ' open' : ''}"></span>` +
      `<span class="t">${esc(label)}</span></button>`
    );
  }

  // Find a node in a list by one of its identifying fields.
  function find(list, key, value) {
    return (list || []).find((x) => x[key] === value);
  }

  // ── global search ──────────────────────────────────────────────────────
  // Searches what is already loaded rather than re-querying the server: the
  // board already holds every market on screen.
  //
  // CRITICAL-3: the source is MODE-AWARE. Feed mode walks the feed board
  // (state.feedMarkets); seeded mode walks the seeded catalogue
  // (state.events) — the old code only knew the feed list, which is empty in
  // seeded deployments, so search returned NOTHING there.
  function searchAll(q) {
    const term = String(q || '').trim().toLowerCase();
    if (term.length < 2) return [];
    const out = [];
    const seen = new Set();
    const push = (kind, label, sub, m) => {
      const key = kind + '|' + label;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind, label, sub, market: m });
    };
    if (state.feedMode) {
      for (const m of state.feedMarkets || []) {
        if ((m.event_name || '').toLowerCase().includes(term)) push('MEETING', m.event_name, m.market_name, m);
        if ((m.market_name || '').toLowerCase().includes(term)) push('RACE', m.market_name, m.event_name, m);
        for (const s of m.selections || []) {
          if ((s.name || '').toLowerCase().includes(term)) {
            push('RUNNER', s.name, `${m.market_name} · ${m.event_name}`, m);
          }
        }
      }
    } else {
      for (const e of state.events || []) {
        for (const m of e.markets || []) {
          if ((m.name || '').toLowerCase().includes(term)) push('MARKET', m.name, e.name, m);
          for (const s of m.selections || []) {
            if ((s.name || '').toLowerCase().includes(term)) {
              push('RUNNER', s.name, `${m.name} · ${e.name}`, m);
            }
          }
        }
      }
    }
    return out.slice(0, 30);
  }

  // CRITICAL-3: a search hit must actually NAVIGATE. The old click wrote
  // state.navSel.events, which nothing ever read — the board never moved.
  // Now the hit's market_id becomes the selection and the full tree path is
  // resolved through the same nodes a click walks (findMarket), so the rail
  // highlights the race and the board prices it. Seeded mode has no tree: the
  // board is one page, so refreshing it (with the hit still on screen) is the
  // whole job.
  function selectSearchedMarket(market) {
    const id = market && market.market_id != null ? market.market_id : market && market.id;
    if (id == null) return;
    state.navSel = Object.assign({}, state.navSel, { market_id: id });
    if (state.feedMode) {
      const hit = findMarket(id);
      if (hit) {
        // Expand the rail along the hit's own path so the race leaf is visible
        // and highlighted — the same state a click on that leaf would set.
        state.treeOpen.sport = hit.s.sport;
        state.treeOpen.country = hit.c ? hit.c.country : null;
        state.treeOpen.comp = hit.k.competition;
        state.treeOpen.meeting = hit.m.event_id;
        state.navSel = {
          sport: hit.s.sport,
          country: hit.c ? hit.c.country : null,
          competition: hit.k.competition,
          event_id: hit.m.event_id,
          market_id: id,
        };
        renderSidebar();
      }
      // Not in the tree (rotated away): loadSelectedMarket() still prices it
      // by id; the rail just cannot highlight what it cannot see.
    }
    refreshMarkets();
  }

  function renderSearchResults(rows) {
    const box = $('searchResults');
    if (!box) return;
    if (!rows.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML =
      rows
        .map(
          (r, i) => `<button class="srow" data-i="${i}">
            <span class="k">${esc(r.kind)}</span><span>${esc(r.label)}</span>
            <span class="m">${esc(r.sub || '')}</span></button>`
        )
        .join('') + (rows.length >= 30 ? '<div class="sempty">Refine your search…</div>' : '');
    qa('.srow', box).forEach((b) => {
      b.onclick = () => {
        const r = rows[Number(b.dataset.i)];
        box.hidden = true;
        $('globalSearch').value = '';
        if (r) selectSearchedMarket(r.market);
      };
    });
  }

  function bindSearch() {
    const input = $('globalSearch');
    if (!input) return;
    const box = $('searchResults');
    input.addEventListener('input', () => renderSearchResults(searchAll(input.value)));
    input.addEventListener('focus', () => {
      if (input.value.trim().length >= 2) renderSearchResults(searchAll(input.value));
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (box) box.hidden = true;
        input.blur();
      }
      if (e.key === 'Enter') {
        const first = box && box.querySelector('.srow');
        if (first) first.click();
      }
    });
    document.addEventListener('click', (e) => {
      if (box && !box.contains(e.target) && e.target !== input) box.hidden = true;
    });
  }

  // ── cash out ───────────────────────────────────────────────────────────
  // Green-up across an open position. lib/cashout.js already computes the plan;
  // this button is the single action that commits it.
  async function doCashOut() {
    if (!state.user) {
      toast('Sign in to cash out', 'err');
      openAuth('login');
      return;
    }
    const btn = $('cashoutBtn');
    btn.disabled = true;
    btn.textContent = 'Cashing out…';
    try {
      const { positions } = await api('GET', '/api/positions');
      const open = (positions || []).filter((p) => p.market_status === 'open' && p.cashout);
      if (!open.length) {
        toast('No cash-out available on your open positions', 'err');
        return;
      }
      // One market per click: a multi-runner green-up is not a single action,
      // and silently picking open[0] cashed out a market the user never chose.
      // With several live offers, send the user to Positions to pick; with
      // exactly one there is nothing to choose between. (W8)
      if (open.length > 1) {
        state.betsTab = 'positions';
        location.hash = '#/bets';
        toast('Multiple positions can be cashed out — pick one in Positions');
        return;
      }
      const target = open[0];
      const r = await api('POST', `/api/markets/${target.market_id}/cashout`);
      const v = r.value_cents;
      toast(`Cashed out ${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))} on ${target.market_name}`, v >= 0 ? 'ok' : 'err');
      await refreshMe();
      renderBets();
    } catch (e) {
      toast(e.message, 'err');
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
    const host = el('races');
    if (!host) return;
    const sel = state.navSel || {};
    // ONE race on screen at a time, chosen in the tree. Betfair shows a single
    // market with its own title and time; a page of stacked cards is not the
    // same product.
    //
    // The market comes from /api/feed/market?id=, not from the board list. The
    // board is capped and recency-sorted, so looking the selection up in it
    // silently substituted a different market's prices whenever the pick fell
    // outside the cap - which, with 1400+ markets, it usually did.
    const m = state.market;
    if (!m) {
      host.innerHTML = sel.market_id
        ? '<div class="card"><div class="empty">This market is no longer open on the feed</div></div>'
        : '<div class="card"><div class="empty">Pick a race from the tree on the left</div></div>';
      return;
    }
    if (String(m.market_id) !== String(sel.market_id)) {
      state.navSel = Object.assign({}, sel, {
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
    const gate = state.feedMode
      ? '<div class="racenote feednote">Feed markets are display-only</div>'
      : '';
    host.innerHTML = `<div class="card racecard">
      <div class="mkthead">
        <span class="race-time">${esc(clockText(m.market_time))}</span>
        <span class="race-name">${esc(m.market_name || 'Race')}</span>
        <span class="muted race-evt">${esc(m.event_name || '')}</span>
        <span class="spacer"></span>
        <span class="chip ${esc(m.status)}">${esc(m.status)}</span>
        ${m.in_play ? '<span class="chip live">IN-PLAY</span>' : ''}
        <span class="muted tn age">${num(m.age_seconds)}s${m.stale ? ' · STALE' : ''}</span>
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
    if (isNaN(d.getTime())) return esc(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderMarkets() {
    const page = el('page');
    if (!page) return;
    // Feed mode: navigation lives entirely in the left tree, so the page holds
    // just the one selected market. The old Sport/Country/Track dropdown card
    // and its "Show races" button are gone — they duplicated the tree.
    if (state.feedMode) {
      renderRaces();
      return;
    }
    if (!state.events.length) {
      page.innerHTML = '<div class="card"><div class="empty">No open events right now</div></div>';
      return;
    }
    const groups = new Map();
    for (const e of state.events) {
      const key = e.competition || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    let html = '';
    for (const [comp, evs] of groups) {
      html += `<div class="card"><h3>${esc(comp)}</h3>`;
      for (const e of evs) {
        html += `<div class="event">
          <div class="evmeta">
            <span class="nm">${esc(e.name)}</span>
            <span class="when">${whenText(e.starts_at)}</span>
            <span class="chip ${esc(e.status)}">${esc(e.status)}</span>
          </div>`;
        for (const m of e.markets) {
          html += `<div class="mkt">
            <div class="mkthead">
              <span>${esc(m.name)}</span>
              <span class="chip ${esc(m.status)}">${esc(m.status)}</span>
              <span class="muted tn">${fmt(m.total_matched_cents)} matched</span>
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
        rows += `<div class="lrow"><div class="lmid"><div class="nm">${esc(
          sel.name
        )}</div><div class="ltp muted">${esc(sel.status)}</div></div><div class="lstack"></div><div class="lstack"></div></div>`;
        continue;
      }
      const back = sel.back || [];
      const lay = sel.lay || [];
      // Back arrives sorted high→low and lay low→high, so the best price is
      // index 0 in each; reverse the back list to place it nearest the runner.
      const b = cellsFor(sel, back.slice().reverse(), 'back', 'atright');
      const l = cellsFor(sel, lay, 'lay', 'atleft');
      rows +=
        `<div class="lrow">` +
        `<div class="lmid"><div class="nm" title="${esc(sel.name)}">${esc(sel.name)}</div>` +
        (sel.ltp != null ? `<div class="ltp tn">${price2(sel.ltp)}</div>` : '') +
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
    if (String(mktId) !== String(lastPricesMkt)) {
      lastPrices.clear();
      lastPricesMkt = mktId;
    }
    const key = `${mktId}:${sel.selection_id}:${side}:${lv.price}`;
    const prev = lastPrices.get(key);
    lastPrices.set(key, lv.price);
    const flash = prev === undefined || prev === lv.price ? '' : lv.price > prev ? ' flash-up' : ' flash-down';
    const carried = lv.carried ? ' carried' : '';
    const depth = isDepth ? ' depth' : '';
    // W7: real buttons — keyboard users can bet (Enter/Space come free), and
    // the price reads out to screen readers through the aria-label.
    const label = `${side === 'back' ? 'Back' : 'Lay'} ${sel.name} at ${price2(lv.price)}, ${fmt(lv.size_cents)} available`;
    // FEED GATE (removable): feed prices build orders the exchange can never
    // accept (feed ids are not in the catalogue), so in feed mode the cells are
    // disabled buttons — focusable neither by pointer-trap nor tab, and
    // announced as unavailable. Remove the gate when feed markets are mapped
    // into the exchange catalogue (see also bindLadder + addToSlip).
    const gate = state.feedMode ? ' disabled' : '';
    return (
      `<button type="button" class="lcell ${side}${flash}${carried}${depth}"${gate} data-bet="1" data-sel="${attr(sel.selection_id)}" ` +
      `data-sname="${esc(sel.name)}" data-mkt="${attr(mktId)}" ` +
      `data-mname="${esc(market.market_name || market.name)}" ` +
      `data-evt="${esc((event && (event.event_name || event.name)) || '')}" ` +
      `data-side="${esc(side)}" data-price="${attr(lv.price)}" aria-label="${esc(label)}" title="${esc(label)}">` +
      `<span class="p tn">${price2(lv.price)}</span><span class="s tn">${fmt(lv.size_cents)}</span></button>`
    );
  }

  // Last rendered price per (market, selection, side, price) for the flash
  // effect; lastPricesMkt scopes the map to the market currently on screen.
  const lastPrices = new Map();
  let lastPricesMkt = null;

  async function loadNav() {
    const seq = ++navReqSeq;
    try {
      const sports = (await api('GET', '/api/feed/nav')).sports || [];
      if (seq !== navReqSeq) return; // a newer nav load owns state.nav
      state.nav = sports;
      // Keep the current selection when it still exists, so a refresh does not
      // throw the bettor back to the first race of the first sport. When it does
      // not — first load, or a meeting the feed has rotated away — drill into
      // the first sport that has one, through exactly the code a click uses.
      // One code path means the first load and a click cannot diverge.
      // W2: drillFirst resolves into state only — no renderSidebar, no
      // refreshMarkets re-entry (the caller serializes and renders once).
      if (state.navSel && state.navSel.market_id && findMarket(state.navSel.market_id)) return;
      for (const s of state.nav || []) {
        if (drillFirst({ sport: s.sport, country: null, comp: null, meeting: null })) return;
      }
      for (const k of TREE_LEVELS) state.treeOpen[k] = null;
    } catch {
      if (seq === navReqSeq) state.nav = [];
    }
  }

  // Is this market still present in the feed's tree? Decides whether a refresh
  // may keep the current selection or has to drill again.
  function findMarket(marketId) {
    for (const s of state.nav || []) {
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
    const seq = ++boardReqSeq;
    try {
      const markets = (await api('GET', '/api/feed/board?limit=500')).markets || [];
      if (seq === boardReqSeq) state.feedMarkets = markets;
    } catch {
      if (seq === boardReqSeq) state.feedMarkets = [];
    }
  }

  // The one market the page prices, by id. Anything outside the board's cap is
  // still reachable this way, which is what makes a deep tree navigable.
  async function loadSelectedMarket() {
    const id = state.navSel && state.navSel.market_id;
    if (!id) {
      state.market = null;
      return;
    }
    const seq = ++marketReqSeq;
    try {
      const res = await api('GET', '/api/feed/market?id=' + encodeURIComponent(id));
      // A slower fetch for a PREVIOUSLY selected market must not overwrite the
      // one now on screen (state-level half of W2).
      if (seq !== marketReqSeq) return;
      state.market = res.market || null;
    } catch {
      if (seq === marketReqSeq) state.market = null;
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
    if (state.feedMode) {
      clearTimeout(state.flashTimer);
      state.flashTimer = setTimeout(() => {
        qa('#page .flash-up, #page .flash-down').forEach((c) => c.classList.remove('flash-up', 'flash-down'));
      }, 700);
      return;
    }
    qa('#page [data-bet]').forEach((c) => {
      c.onclick = () => {
        if (!state.user) {
          toast('Sign in to place a bet', 'err');
          openAuth('login');
          return;
        }
        addToSlip({
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
    clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(() => {
      qa('#page .flash-up, #page .flash-down').forEach((c) => c.classList.remove('flash-up', 'flash-down'));
    }, 700);
  }

  // ── bet slip ─────────────────────────────────────────────────────────────
  function addToSlip(item) {
    // FEED GATE (removable — see bindLadder): defense in depth. The ladder
    // attaches no handlers in feed mode, but nothing else may ever build a
    // slip row the exchange is guaranteed to reject.
    if (state.feedMode) {
      toast('Feed markets are display-only', 'err');
      return;
    }
    // Identity = (market_id, selection_id, side). Feed selection ids are only
    // unique WITHIN a market (every soccer 1X2 market reuses 58805 for "The
    // Draw"), so keying on (selection_id, side) made clicking the same side
    // in a second race silently REMOVE the first. (W3)
    const at = state.slip.findIndex(
      (x) =>
        String(x.market_id) === String(item.market_id) &&
        String(x.selection_id) === String(item.selection_id) &&
        x.side === item.side
    );
    if (at >= 0) {
      state.slip.splice(at, 1);
    } else {
      if (state.slip.length >= 10) {
        toast('Slip is full (10 selections max)', 'err');
        return;
      }
      state.slip.push(Object.assign({ stake_cents: 1000 }, item));
    }
    renderSlip();
  }

  // One slip row's derived values (preview + button label) — recomputed in
  // place. Rebuilding the whole slip from inside an input's change handler
  // detaches the node the browser is dispatching on, which Chromium reports
  // as "NotFoundError: the node to be removed is no longer a child"; updating
  // only the affected row also preserves focus while typing.
  function slipRowHtml(it) {
    // Integer price-cents, one rounding — the same maths the engine uses (S3).
    const exposure = Ladder.exposureCents(it.price, it.stake_cents);
    const detail =
      it.side === 'back'
        ? `<span class="muted">Profit</span> ${fmt(exposure)} · <span class="muted">Return</span> ${fmt(it.stake_cents + exposure)}`
        : `<span class="muted">Liability</span> ${fmt(exposure)} · <span class="muted">Return</span> ${fmt(it.stake_cents + exposure)}`;
    // W1: data-* markers carry NO values. The old `data-rm="ROW"` sentinel was
    // string-replaced per row index — which also corrupted any runner NAME
    // containing "ROW" ("ARROWTOWN RC" → "AR0TOWN RC"), and the replaced
    // values were never read anyway. Identity comes from the row's data-row;
    // the handlers are delegated (bindSlip), so nothing rebinds per row.
    return `<div class="sliphead">
            <div>
              <span class="side ${esc(it.side)}">${esc(it.side.toUpperCase())}</span>
              <strong>${esc(it.selection_name)}</strong>
              <span class="tn">@ ${price2(it.price)}</span>
              <div class="muted ellipsis">${esc(it.event_name)} · ${esc(it.market_name)}</div>
            </div>
            <button type="button" class="rm" data-rm title="Remove">×</button>
          </div>
          <div class="slipgrid">
            <div>
              <label>Stake</label>
              <input class="stake" data-stake type="number" min="1" step="0.01" value="${(it.stake_cents / 100).toFixed(2)}" />
            </div>
            <div>
              <label>Price</label>
              <div class="stepper">
                <button type="button" class="btn sm" data-tick data-dir="-1">−</button>
                <input class="tn" data-price value="${price2(it.price)}" />
                <button type="button" class="btn sm" data-tick data-dir="1">+</button>
              </div>
            </div>
          </div>
          <div class="prev tn">${detail}</div>
          <button type="button" class="btn primary place" data-place>Place ${fmt(it.stake_cents)}</button>`;
  }

  // Update ONE row's derived values in place — never restructure the row.
  // Rebuilding a row detaches the focused input, which fires blur -> change
  // and re-enters this function while the DOM is being mutated (Chromium then
  // reports "removeChild: the node to be removed is no longer a child").
  // Writing only text/values also keeps focus while the user types.
  function slipDetailText(it) {
    const exposure = Ladder.exposureCents(it.price, it.stake_cents);
    const label = it.side === 'back' ? 'Profit' : 'Liability';
    return `${label} ${fmt(exposure)} · Return ${fmt(it.stake_cents + exposure)}`;
  }

  function updateSlipRow(i) {
    const row = document.querySelector(`.sliprow[data-row="${i}"]`);
    const it = state.slip[i];
    if (!row || !it) return;
    const priceInput = row.querySelector('[data-price]');
    // Never fight the user for the field they are typing in.
    if (priceInput && document.activeElement !== priceInput) priceInput.value = price2(it.price);
    const headPrice = row.querySelector('.sliphead .tn');
    if (headPrice) headPrice.textContent = `@ ${price2(it.price)}`;
    const prev = row.querySelector('.prev');
    if (prev) prev.textContent = slipDetailText(it);
    const place = row.querySelector('[data-place]');
    if (place) place.textContent = `Place ${fmt(it.stake_cents)}`;
    const stakeInput = row.querySelector('[data-stake]');
    if (stakeInput && document.activeElement !== stakeInput) stakeInput.value = (it.stake_cents / 100).toFixed(2);
  }

  // Slip events are DELEGATED from #slipBody (bound once in boot), keyed off
  // each row's data-row — so re-rendering the slip never rebinds anything,
  // and there is no per-row handler to go stale. (W1)
  function bindSlip() {
    const body = $('slipBody');
    body.addEventListener('click', (e) => {
      const row = e.target.closest('.sliprow');
      if (!row) return;
      const i = Number(row.dataset.row);
      const it = state.slip[i];
      if (!it) return;
      if (e.target.closest('[data-rm]')) {
        state.slip.splice(i, 1);
        renderSlip();
        return;
      }
      const tick = e.target.closest('[data-tick]');
      if (tick) {
        it.price = Ladder.stepPrice(it.price, Number(tick.dataset.dir));
        updateSlipRow(i);
        return;
      }
      const place = e.target.closest('[data-place]');
      if (place) placeOne(i, place);
    });
    body.addEventListener('change', (e) => {
      const row = e.target.closest('.sliprow');
      if (!row) return;
      const i = Number(row.dataset.row);
      const it = state.slip[i];
      if (!it) return;
      if (e.target.matches('[data-stake]')) {
        const cents = Math.round(parseFloat(e.target.value) * 100);
        it.stake_cents = Number.isFinite(cents) && cents > 0 ? cents : 1000;
        updateSlipRow(i);
        return;
      }
      if (e.target.matches('[data-price]')) {
        // Typed prices are honoured (snapped to the ladder), never ignored.
        const parsed = parseFloat(e.target.value);
        if (!Number.isFinite(parsed)) {
          toast('Enter a valid price', 'err');
          updateSlipRow(i);
          return;
        }
        it.price = Ladder.snapPrice(parsed);
        updateSlipRow(i);
      }
    });
  }

  function renderSlip() {
    const wrap = el('slip');
    const body = el('slipBody');
    if (!wrap || !body) return;
    if (!state.slip.length) {
      wrap.hidden = true;
      body.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    body.innerHTML = state.slip
      .map((it, i) => `<div class="sliprow" data-row="${i}">${slipRowHtml(it)}</div>`)
      .join('');
  }

  async function placeOne(i, btn) {
    const it = state.slip[i];
    if (!it) return;
    btn.disabled = true;
    btn.textContent = 'Placing…';
    try {
      const r = await api('POST', '/api/orders', {
        selection_id: it.selection_id,
        side: it.side,
        price: it.price,
        stake_cents: it.stake_cents,
      });
      const matched = r.fills.reduce((a, f) => a + f.stake_cents, 0);
      const resting = r.order.stake_cents - r.order.matched_cents;
      if (matched > 0 && resting === 0) toast(`Matched ${fmt(matched)} @ ${price2(r.fills[0].price)}`);
      else if (matched > 0) toast(`Matched ${fmt(matched)} · ${fmt(resting)} resting @ ${price2(r.order.price)}`);
      else toast(`Resting ${fmt(r.order.stake_cents)} @ ${price2(r.order.price)}`);
      state.slip.splice(i, 1);
      renderSlip();
      refreshMe();
      // Feed-aware board refresh — loadEvents() is the seeded loader and
      // updated nothing in feed mode. (W4)
      refreshMarkets();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }

  // ── my bets ──────────────────────────────────────────────────────────────
  function renderBets() {
    const page = el('page');
    if (!page) return;
    if (!state.user) {
      page.innerHTML =
        '<div class="card"><div class="empty">Sign in to see your orders, positions and history.</div>' +
        '<div class="row center"><button class="btn primary" id="betsSignin">Sign in</button></div></div>';
      $('betsSignin').onclick = () => openAuth('login');
      return;
    }
    page.innerHTML = `<div class="card">
      <div class="tabs">
        <button class="btn sm ${state.betsTab === 'open' ? 'primary' : ''}" data-tab="open">Open orders</button>
        <button class="btn sm ${state.betsTab === 'positions' ? 'primary' : ''}" data-tab="positions">Positions</button>
        <button class="btn sm ${state.betsTab === 'settled' ? 'primary' : ''}" data-tab="settled">Settled</button>
      </div>
      <div id="betsBody"><div class="empty">Loading…</div></div>
    </div>`;
    qa('[data-tab]', page).forEach((b) => {
      b.onclick = () => {
        state.betsTab = b.dataset.tab;
        renderBets();
      };
    });
    if (state.betsTab === 'open') loadOpenOrders();
    else if (state.betsTab === 'positions') loadPositions();
    else loadSettled();
  }

  async function loadOpenOrders() {
    if (!el('betsBody')) return; // navigated away mid-flight
    try {
      const { orders } = await api('GET', '/api/orders');
      const body = el('betsBody');
      if (!body) return; // tab changed while the request was in flight
      if (!orders.length) {
        setHtml(body, '<div class="empty">No unmatched orders</div>');
        return;
      }
      setHtml(body,
        '<table><thead><tr><th>Event</th><th>Selection</th><th>Side</th><th>Price</th><th>Unmatched</th><th>Placed</th><th></th></tr></thead><tbody>' +
        orders
          .map(
            (o) => `<tr>
          <td>${esc(o.event_name)}<div class="muted">${esc(o.market_name)}</div></td>
          <td>${esc(o.selection_name)}</td>
          <td class="side ${esc(o.side)}">${esc(o.side.toUpperCase())}</td>
          <td class="tn">${price2(o.price)}</td>
          <td class="tn">${fmt(o.stake_cents - o.matched_cents)}</td>
          <td class="muted">${whenText(o.placed_at)}</td>
          <td><button class="btn sm red" data-cancel="${attr(o.id)}">Cancel</button></td>
        </tr>`
          )
          .join('') +
        '</tbody></table>');
      qa('[data-cancel]', body).forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try {
            await api('POST', `/api/orders/${b.dataset.cancel}/cancel`);
            toast('Order cancelled');
            loadOpenOrders();
            refreshMe();
          } catch (e) {
            toast(e.message, 'err');
            b.disabled = false;
          }
        };
      });
    } catch (e) {
      setHtml(el('betsBody'), `<div class="empty">${esc(e.message)}</div>`);
    }
  }

  async function loadPositions() {
    if (!el('betsBody')) return; // navigated away mid-flight
    try {
      const { positions } = await api('GET', '/api/positions');
      const body = el('betsBody');
      if (!body) return; // tab changed while the request was in flight
      if (!positions.length) {
        setHtml(body, '<div class="empty">No matched positions</div>');
        return;
      }
      setHtml(body, positions
        .map((p) => {
          const legs = p.selections
            .filter((s) => s.my_back_stake_cents || s.my_lay_stake_cents || s.frozen_cents)
            .map(
              (s) => `<tr>
                <td>${esc(s.name)}</td>
                <td class="tn">${s.my_back_stake_cents ? fmt(s.my_back_stake_cents) : '—'}</td>
                <td class="tn">${s.my_lay_stake_cents ? fmt(s.my_lay_stake_cents) : '—'}</td>
                <td class="tn">${fmt(s.frozen_cents)}</td>
              </tr>`
            )
            .join('');
          const matrix = p.pnl_if_win
            .map(
              (w) =>
                `<span class="pnlchip ${w.pnl_cents >= 0 ? 'win' : 'loss'}">${esc(w.name)} ${signed(w.pnl_cents)}</span>`
            )
            .join('');
          const cash =
            p.cashout != null
              ? `<button class="btn green" data-cashout="${attr(p.market_id)}">Cash out ${signed(p.cashout.value_cents)} @ ${price2(
                  p.cashout.hedge_price
                )}</button>`
              : '<span class="muted">Cash out unavailable</span>';
          return `<div class="poscard">
            <div class="poshead">
              <div><strong>${esc(p.market_name)}</strong> <span class="chip ${esc(p.market_status)}">${esc(
            p.market_status
          )}</span></div>
              <div class="muted">${esc(p.event_name)}</div>
            </div>
            <table><thead><tr><th>Selection</th><th>Backed</th><th>Laid</th><th>Frozen</th></tr></thead><tbody>${legs}</tbody></table>
            <div class="pnlrow">${matrix}</div>
            <div>${cash}</div>
          </div>`;
        })
        .join(''));
      qa('[data-cashout]', body).forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try {
            const r = await api('POST', `/api/markets/${b.dataset.cashout}/cashout`);
            toast(`Cashed out ${signed(r.value_cents)}`);
            loadPositions();
            refreshMe();
            // Feed-aware board refresh (W4): loadEvents() updated nothing in
            // feed mode, so the ladder stayed stale after a cash-out.
            refreshMarkets();
          } catch (e) {
            toast(e.message, 'err');
            b.disabled = false;
          }
        };
      });
    } catch (e) {
      setHtml(el('betsBody'), `<div class="empty">${esc(e.message)}</div>`);
    }
  }

  async function loadSettled() {
    if (!el('betsBody')) return; // navigated away mid-flight
    try {
      const { settlements } = await api('GET', '/api/settlements');
      const body = el('betsBody');
      if (!body) return; // tab changed while the request was in flight
      if (!settlements.length) {
        setHtml(body, '<div class="empty">No settled markets yet</div>');
        return;
      }
      setHtml(body,
        '<table><thead><tr><th>Event</th><th>Market</th><th>Result</th><th>P&amp;L</th><th>Commission</th><th>When</th></tr></thead><tbody>' +
        settlements
          .map(
            (s) => `<tr>
          <td>${esc(s.event_name)}</td>
          <td>${esc(s.market_name)}</td>
          <td>${esc(s.selection_name || 'Void')}</td>
          <td class="tn ${s.pnl_cents >= 0 ? 'win' : 'loss'}">${signed(s.pnl_cents)}</td>
          <td class="tn muted">${fmt(s.commission_cents)}</td>
          <td class="muted">${whenText(s.at)}</td>
        </tr>`
          )
          .join('') +
        '</tbody></table>');
    } catch (e) {
      setHtml(el('betsBody'), `<div class="empty">${esc(e.message)}</div>`);
    }
  }

  // ── wallet ───────────────────────────────────────────────────────────────
  function renderWallet() {
    const page = el('page');
    if (!page) return;
    if (!state.user) {
      page.innerHTML =
        '<div class="card"><div class="empty">Sign in to use the wallet.</div>' +
        '<div class="row center"><button class="btn primary" id="walSignin">Sign in</button></div></div>';
      $('walSignin').onclick = () => openAuth('login');
      return;
    }
    page.innerHTML = `<div class="card">
      <h3>Wallet</h3>
      <div class="wgrid">
        <div><span class="muted">Balance</span><div class="wbig tn" id="wBal">—</div></div>
        <div><span class="muted">Available</span><div class="wbig tn" id="wAvail">—</div></div>
        <div><span class="muted">Frozen (escrow)</span><div class="wbig tn" id="wFroz">—</div></div>
      </div>
      <div class="row mt">
        <span class="muted">Faucet:</span>
        <button class="btn sm" data-dep="1000">$10</button>
        <button class="btn sm" data-dep="5000">$50</button>
        <button class="btn sm" data-dep="10000">$100</button>
        <button class="btn sm" data-dep="100000">$1,000</button>
      </div>
      <h3>Transactions</h3>
      <div id="wTx"><div class="empty">Loading…</div></div>
    </div>`;
    qa('[data-dep]', page).forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await api('POST', '/api/wallet/deposit', { amount_cents: Number(b.dataset.dep) });
          toast(`Added ${fmt(Number(b.dataset.dep))} play money`);
          loadWallet();
          refreshMe();
        } catch (e) {
          toast(e.message, 'err');
        }
        b.disabled = false;
      };
    });
    loadWallet();
  }

  async function loadWallet() {
    if (!el('wTx')) return; // navigated away mid-flight
    try {
      const w = await api('GET', '/api/wallet');
      const balEl = el('wBal');
      if (!balEl || !el('wTx')) return; // left the wallet page mid-flight
      balEl.textContent = fmt(w.balance_cents);
      el('wAvail').textContent = fmt(w.available_cents);
      el('wFroz').textContent = fmt(w.frozen_cents);
      const tx = el('wTx');
      if (!w.transactions.length) {
        setHtml(tx, '<div class="empty">No transactions yet</div>');
        return;
      }
      const credits = ['deposit', 'settle', 'refund', 'release'];
      setHtml(tx,
        '<table><thead><tr><th>Type</th><th>Amount</th><th>Balance</th><th>Frozen</th><th>When</th></tr></thead><tbody>' +
        w.transactions
          .map((t) => {
            const isCredit = credits.indexOf(t.type) >= 0 && t.amount_cents >= 0;
            const cls = t.type === 'commission' || t.amount_cents < 0 ? 'loss' : isCredit ? 'win' : 'muted';
            const amt = t.type === 'escrow' || t.type === 'release' ? fmt(Math.abs(t.amount_cents)) : signed(t.amount_cents);
            return `<tr>
              <td>${esc(t.type)}</td>
              <td class="tn ${cls}">${amt}</td>
              <td class="tn">${fmt(t.balance_after)}</td>
              <td class="tn">${fmt(t.frozen_after)}</td>
              <td class="muted">${whenText(t.at)}</td>
            </tr>`;
          })
          .join('') +
        '</tbody></table>');
    } catch (e) {
      setHtml(el('wTx'), `<div class="empty">${esc(e.message)}</div>`);
    }
  }

  // ── SSE ──────────────────────────────────────────────────────────────────
  // SSE 'book' is broadcast globally on every place/cancel/match/settle, so a
  // burst of activity in unrelated markets used to trigger a full refresh per
  // event. Debounced 200ms and scoped by the frame's market_id: feed mode
  // prices ONE market, and frames for other races never touch the board. (W2)
  function scheduleBookRefresh(marketId) {
    if (state.feedMode) {
      const sel = state.navSel && state.navSel.market_id;
      if (sel != null && marketId != null && String(marketId) !== String(sel)) return;
    }
    clearTimeout(state.bookTimer);
    state.bookTimer = setTimeout(() => {
      if (state.page === 'markets') refreshMarkets();
    }, 200);
  }

  // A stream the browser has GIVEN UP on (EventSource.CLOSED — proxy 502,
  // expired session) never comes back on its own; EventSource only retries
  // while readyState is CONNECTING. Re-establish it with capped backoff. (W5)
  function scheduleSSEReconnect() {
    clearTimeout(state.sseRetryTimer);
    state.sseRetryMs = Math.min(state.sseRetryMs ? state.sseRetryMs * 2 : 1000, 30000);
    state.sseRetryTimer = setTimeout(() => {
      if (state.sse && state.sse.readyState === EventSource.CLOSED) connectSSE();
    }, state.sseRetryMs);
  }

  function connectSSE() {
    clearTimeout(state.sseRetryTimer);
    if (state.sse) state.sse.close();
    const es = new EventSource('/api/stream');
    es.onopen = () => {
      state.sseRetryMs = 0; // stream proven — a later failure starts from 1s again
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
      refreshMe();
      if (state.page === 'wallet') loadWallet();
    });
    es.addEventListener('orders', () => {
      if (state.page === 'bets') renderBets();
    });
    es.addEventListener('settlement', () => {
      if (state.page === 'markets') refreshMarkets();
      if (state.page === 'bets') renderBets();
    });
    es.addEventListener('error', () => {
      // CONNECTING means the browser is already retrying — hands off.
      if (es.readyState === EventSource.CLOSED) scheduleSSEReconnect();
    });
    state.sse = es;
  }

  // A tab parked in the background can silently lose the stream while the
  // backoff timer is still far in the future — on return, retry immediately.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.sse && state.sse.readyState === EventSource.CLOSED) connectSSE();
  });

  // Poll fallback so the board still moves if the stream drops. The feed
  // publishes on a ~3 minute cadence, so polling faster than that only
  // re-reads the same frame. While the stream is LIVE (readyState 1) the SSE
  // path already drives every update — polling on top of it would only
  // duplicate fetches and widen the stale-frame race. (W2)
  function startPoll() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(
      () => {
        if (state.sse && state.sse.readyState === 1) return;
        if (state.page === 'markets') refreshMarkets();
      },
      state.feedMode ? 60000 : 15000
    );
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  async function boot() {
    // One-time static bindings. Page-level handlers are attached by the render
    // functions; nothing here touches rendered content.
    qa('#nav button').forEach((b) => {
      b.onclick = () => {
        location.hash = '#/' + b.dataset.page;
      };
    });
    $('authBtn').onclick = () => (state.user ? logout() : openAuth('login'));
    $('accountBtn').onclick = () => openAccount();
    $('pwGo').onclick = () => submitPasswordChange();
    $('authGo').onclick = submitAuth;
    $('authSwitch').onclick = () => openAuth(authMode === 'login' ? 'register' : 'login');
    $('authPass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAuth();
    });
    $('authUser').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAuth();
    });
    $('authModal').onclick = (e) => {
      if (e.target.id === 'authModal') closeAuth();
    };
    const nt = $('navToggle');
    if (nt) nt.onclick = () => (document.body.classList.contains('nav-open') ? closeNavRail() : openNavRail());
    // Escape closes the TOPMOST open overlay (auth modal, admin settle
    // dialog), or the narrow-screen rail; Tab is trapped inside that overlay.
    // The old handler only knew #authModal, so admin dialogs ignored Escape.
    // (S4)
    document.addEventListener('keydown', (e) => {
      const top = overlayStack[overlayStack.length - 1];
      if (e.key === 'Escape') {
        if (top) closeOverlay(top.overlay);
        else if ($('authModal').classList.contains('show')) closeAuth();
        else closeNavRail();
      }
      if (e.key === 'Tab' && top) trapTab(top.overlay, e);
    });
    window.addEventListener('hashchange', route);
    bindSlip(); // one delegated pair of listeners for the whole slip (W1)
    bindSearch();
    const co = $('cashoutBtn');
    if (co) co.onclick = doCashOut;

    await refreshMe();
    await detectFeed();
    await loadSports();
    // W2: single-pass boot. loadNav resolves the selection in state (it no
    // longer re-enters refreshMarkets via openBranch), so the loads run once
    // and route() renders once — the old boot fetched the board twice.
    if (state.feedMode) {
      await loadNav();
      await loadFeedMarkets();
      await loadSelectedMarket();
    } else {
      await loadEvents(); // seeded catalogue; useless in feed mode (S7)
    }
    renderSidebar(); // renders the feed tree, or hides the rail in seeded mode
    renderSlip();
    connectSSE();
    startPoll();
    route();
  }

  // Controlled global consumed by admin.js (the one allowed browser global).
  // Narrowed to EXACTLY what admin.js destructures — the old export leaked
  // internals (route, renderPage, refreshMarkets, refreshMe, loadEvents,
  // whenText) that no other file reads. (S6)
  window.OB = {
    api, toast, fmt, price2, esc, attr, state, refreshAll,
    openOverlay, closeOverlay,
  };

  let booted = false;
  function bootOnce() {
    if (booted) return;
    booted = true;
    boot();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootOnce);
  } else {
    bootOnce();
  }
})();
