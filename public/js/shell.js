// shell.js — auth, account panel, routing, data loaders
(() => {
  'use strict';

  const OB = window.OB;
  if (!OB) { console.error('[shell] window.OB missing — core.js must load first'); return; }

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

  // ── narrow-screen race rail (W9) ─────────────────────────────────────────
  // Below 1000px the tree becomes a drawer driven by #navToggle. Picking a
  // race (or Escape) closes it so the board is readable again.
  function openNavRail() {
    document.body.classList.add('nav-open');
    const t = OB.$('navToggle');
    if (t) t.setAttribute('aria-expanded', 'true');
    const first = OB.qa('#sportsList .treeitem')[0];
    if (first) first.focus();
  }
  function closeNavRail() {
    if (!document.body.classList.contains('nav-open')) return;
    document.body.classList.remove('nav-open');
    const t = OB.$('navToggle');
    if (t) {
      t.setAttribute('aria-expanded', 'false');
      t.focus();
    }
  }

  OB.state.authMode = 'login';
  function openAuth(mode) {
    OB.state.authMode = mode || 'login';
    const registering = OB.state.authMode !== 'login';
    OB.$('authTitle').textContent = registering ? 'Create account' : 'Sign in';
    OB.$('authGo').textContent = registering ? 'Register' : 'Sign in';
    OB.$('authSwitch').textContent = registering ? 'Sign in' : 'Register';
    // On sign-in the identifier accepts a username OR an email, so there is
    // only ever one field to fill. Registration adds the optional address.
    OB.$('authEmailWrap').style.display = registering ? '' : 'none';
    OB.$('authUser').placeholder = registering ? 'username' : 'username or email';
    OB.$('authUser').value = '';
    OB.$('authEmail').value = '';
    OB.$('authPass').value = '';
    OB.openOverlay(OB.$('authModal'), OB.$('authUser'));
  }
  const closeAuth = () => OB.closeOverlay(OB.$('authModal'));

  /**
   * Act on `must_change_password` immediately after a successful sign-in.
   *
   * This function was CALLED at the end of submitAuth and DEFINED nowhere in the
   * repository. The login itself had already succeeded and the header had
   * already been rendered by the time the bare identifier was resolved, so the
   * ReferenceError was raised at the last statement of the try block — and the
   * catch turned it into `OB.toast('maybeForceSetup is not defined', 'err')`,
   * replacing the "Welcome back" that had just been shown. Every single sign-in
   * therefore ended on an error toast about an internal bug, and the lock this
   * line was written to surface was never surfaced at all.
   *
   * The behaviour is the one the call site's comment describes and the one
   * lib/auth.js's sanitizeUser promises the client when it exposes
   * must_change_password: "the UI can route the account straight to the
   * password panel instead of letting them discover the lock by clicking".
   *
   * So: open the account panel — which is where the change-password form lives,
   * and every route it needs (GET /api/me, POST /api/auth/change-password,
   * GET /api/auth/sessions) is on the server's SETUP_ALLOWLIST, so a locked
   * account can actually use it — and say plainly what is wrong.
   *
   * Toasting the lock REPLACES the "Welcome back" it follows, deliberately. A
   * cosmetic greeting and a hard block deserve different weight, and the block
   * is the one the operator must act on before anything else will work.
   */
  function maybeForceSetup(user) {
    if (!user || !user.must_change_password) return;
    OB.toast('Change your password before using the exchange', 'err');
    openAccount();
  }

  async function submitAuth() {
    const identifier = OB.$('authUser').value.trim();
    const password = OB.$('authPass').value;
    try {
      if (OB.state.authMode === 'login') {
        // Sent as `identifier` rather than `username` so the intent is
        // unambiguous at the server: this may well be an email address.
        const r = await OB.api('POST', '/api/auth/login', { identifier, password });
        OB.state.user = r.user;
        closeAuth();
        OB.renderHeader();
        OB.connectSSE(); // private balance/orders events follow the new session
        route();
        OB.toast(`Welcome back, ${r.user.username}`);
        // A seeded demo password locks the account out of everything except
        // the panel that fixes it, so say that up front rather than letting
        // the operator discover it with a 403 on their first bet.
        maybeForceSetup(r.user);
      } else {
        const email = OB.$('authEmail').value.trim();
        const r = await OB.api('POST', '/api/auth/register', {
          username: identifier,
          password,
          ...(email ? { email } : {}),
        });
        OB.state.user = r.user;
        closeAuth();
        OB.renderHeader();
        OB.connectSSE();
        route();
        OB.toast('Account created — top up in Wallet');
      }
    } catch (e) {
      OB.toast(e.message, 'err');
    }
  }

  // ── Account panel ─────────────────────────────────────────────────────────
  // Change password, and see/revoke every device signed in to this account.
  // Revoking here is the counterpart to the server revoking all OTHER sessions
  // on a password change: the two together cover both "someone else has my
  // password" and "someone else has my cookie".
  async function renderSessions() {
    // Reached from openAccount() and again after every revoke or password
    // change, so two of these are routinely in flight together; the panel is one
    // mount point and takes one token.
    const seq = OB.beginLoad('sessionList');
    const box = OB.$('sessionList');
    if (!box) return; // the panel was closed mid-flight
    box.textContent = 'Loading…';
    let list;
    try {
      list = (await OB.api('GET', '/api/auth/sessions')).sessions;
    } catch (e) {
      if (OB.isCurrent('sessionList', seq) && OB.$('sessionList') === box) box.textContent = e.message;
      return;
    }
    if (!OB.isCurrent('sessionList', seq) || OB.$('sessionList') !== box) return;
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
          await OB.api('DELETE', `/api/auth/sessions/${encodeURIComponent(s.id)}`);
          if (s.current) {
            // Revoked the session this tab is using — it is gone now.
            OB.toast('Signed out');
            OB.closeOverlay(OB.$('accountModal'));
            OB.logout();
          } else {
            OB.toast('Device signed out');
            renderSessions();
          }
        } catch (e) {
          OB.toast(e.message, 'err');
          btn.disabled = false;
        }
      };
      row.append(label, btn);
      box.append(row);
    }
  }

  function openAccount() {
    if (!OB.state.user) return openAuth('login');
    OB.$('accountWho').textContent =
      `${OB.state.user.username}${OB.state.user.email ? ' · ' + OB.state.user.email : ''}` +
      `${OB.state.user.role === 'admin' ? ' · admin' : ''}`;
    OB.$('pwCurrent').value = '';
    OB.$('pwNew').value = '';
    OB.$('pwNote').textContent = '';
    OB.openOverlay(OB.$('accountModal'), OB.$('pwCurrent'));
    renderSessions();
  }

  async function submitPasswordChange() {
    const currentPassword = OB.$('pwCurrent').value;
    const newPassword = OB.$('pwNew').value;
    try {
      const r = await OB.api('POST', '/api/auth/change-password', { currentPassword, newPassword });
      OB.$('pwCurrent').value = '';
      OB.$('pwNew').value = '';
      OB.$('pwNote').textContent = r.sessions_revoked
        ? `Password changed — ${r.sessions_revoked} other session(s) signed out.`
        : 'Password changed.';
      OB.toast('Password changed');
      renderSessions();
    } catch (e) {
      OB.toast(e.message, 'err');
    }
  }

  // ── routing ──────────────────────────────────────────────────────────────
  function route() {
    const hash = (location.hash || '#/markets').replace('#/', '');
    const known = ['markets', 'bets', 'wallet', 'admin'];
    OB.state.page = known.indexOf(hash) >= 0 ? hash : 'markets';
    if (OB.state.page === 'admin' && !(OB.state.user && OB.state.user.role === 'admin')) OB.state.page = 'markets';
    OB.qa('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === OB.state.page));
    renderPage();
  }

  function renderPage() {
    const page = OB.$('page');
    page.innerHTML = '';
    if (OB.state.page === 'markets') {
      // Feed mode needs its own container above the ladder area; seeded mode
      // renders straight into #page.
      if (OB.state.feedMode) {
        page.innerHTML = '<div id="races"></div>';
        return OB.renderMarkets();
      }
      return OB.renderMarkets();
    }
    if (OB.state.page === 'bets') return OB.renderBets();
    if (OB.state.page === 'wallet') return OB.renderWallet();
    if (OB.state.page === 'admin' && window.OBAdmin) return window.OBAdmin.render(page);
    page.innerHTML = '<div class="card"><div class="empty">Nothing here</div></div>';
  }

  // ── data loaders ─────────────────────────────────────────────────────────
  // Probe once at boot: a 409 from /api/feed/nav means FEED_ENABLED=false, and
  // the board stays on the seeded catalogue. Avoids shipping the feed flag to
  // the browser as a build-time constant.
  async function detectFeed() {
    try {
      const j = await (await fetch('/api/feed/nav')).json();
      OB.state.feedMode = !!(j && j.enabled);
    } catch {
      OB.state.feedMode = false;
    }
  }

  async function loadSports() {
    try {
      OB.state.sports = (await OB.api('GET', '/api/sports')).sports;
    } catch {
      OB.state.sports = [];
    }
    // In feed mode the sport/country/track selects replace the seeded chip bar,
    // so rendering it would just confuse the two navigation models.
    if (!OB.state.feedMode) OB.renderSportNav();
  }

  async function loadEvents() {
    // State-level race guard (W2): only the LATEST events fetch may write
    // state.events — a slow stale response landing after a newer one must
    // neither render (refreshMarkets' seq token) nor corrupt state.
    const seq = ++OB.state.eventsReqSeq;
    const qs = OB.state.sport ? `?sport=${encodeURIComponent(OB.state.sport)}` : '';
    try {
      const events = (await OB.api('GET', '/api/events' + qs)).events;
      if (seq === OB.state.eventsReqSeq) OB.state.events = events;
    } catch {
      if (seq === OB.state.eventsReqSeq) OB.state.events = [];
    }
    // Pure loader: rendering is refreshMarkets()'s job.
  }

  // Feed-aware refresh: in feed mode the nav and the races both move every
  // cycle, so both are reloaded and the page re-rendered.
  //
  // SERIALIZATION (W2): every refresh takes a ticket; when a newer refresh
  // starts while this one's fetches are in flight, the older one's renders are
  // dropped so a slow response can never paint over a fresh one.
  OB.state.refreshSeq = 0;
  OB.state.eventsReqSeq = 0;
  OB.state.navReqSeq = 0;
  OB.state.boardReqSeq = 0;
  OB.state.marketReqSeq = 0;
  async function refreshMarkets() {
    const seq = ++OB.state.refreshSeq;
    if (OB.state.feedMode) {
      await OB.loadNav(); // pure loader + selection resolution — no re-entry
      await OB.loadFeedMarkets();
      await OB.loadSelectedMarket();
      if (seq !== OB.state.refreshSeq) return; // superseded — never render stale data
      OB.renderSidebar();
      if (OB.state.page === 'markets') OB.renderMarkets();
      return;
    }
    await loadEvents();
    if (seq !== OB.state.refreshSeq) return;
    if (OB.state.page === 'markets') OB.renderMarkets();
  }

  async function refreshAll() {
    // refreshMarkets is feed-aware, so admin actions (create/settle/suspend)
    // refresh whatever board the deployment actually shows.
    await Promise.all([OB.refreshMe(), loadSports(), refreshMarkets()]);
  }


  Object.assign(OB, { closeAuth, closeNavRail, detectFeed, loadEvents, loadSports, openAccount, openAuth, openNavRail, refreshAll, refreshMarkets, renderPage, renderSessions, route, submitAuth, submitPasswordChange });
})();
