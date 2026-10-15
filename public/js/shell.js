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
        await OB.loadBranding(); // the tenant is resolved per user (#52)
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
        await OB.loadBranding(); // the tenant is resolved per user (#52)
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
    // The tenant's terms URL. There is no terms page and no footer in this
    // shell, so the account panel is the one surface where a player is already
    // looking at themselves and can be shown a per-tenant legal link. Absent
    // (the default tenant sets none) the row is hidden rather than left empty.
    const terms = OB.el('pwTerms');
    const brandTerms = OB.state.branding && OB.state.branding.terms_url;
    if (terms && brandTerms) {
      terms.innerHTML = `Terms &amp; conditions: <a href="${OB.attr(brandTerms)}" target="_blank" rel="noopener noreferrer">${OB.esc(
        brandTerms
      )}</a>`;
      terms.hidden = false;
    } else if (terms) {
      terms.textContent = '';
      terms.hidden = true;
    }
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

  // ── tenant branding (#52) ────────────────────────────────────────────────
  // /api/branding has been served the whole time and NOTHING read it: a grep
  // for "branding" across public/ returned zero hits, and editTenant could not
  // even set the `brand` JSON, so ROADMAP.md's claim that per-tenant theming
  // works "through the frontend" described a capability that did not exist.
  // It is a CONFIG READ, which is exactly why the no-build frontend can do it:
  // applying CSS custom properties from a JSON response.
  //
  // THE PALETTE IS UNTRUSTED INPUT. It comes from a tenant row anything with
  // API access can write, and a CSS custom property accepts nearly any token
  // sequence — so setProperty('--text', 'not a colour') really does set it,
  // and every rule using var(--text) then fails at computed-value time. That
  // is a blank venue, not a wrong accent. So: hex shapes only, property names
  // restricted, and anything else IGNORED rather than applied. The house
  // palette in :root stands for whatever is refused.
  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const PROP_NAME = /^[a-z][a-z0-9-]{0,30}$/i;
  // A path ON THIS VENUE. The CSP is `img-src 'self' data:`, so anything with
  // a scheme or a leading `//` is refused by the browser; written in as an href
  // it is a tab icon pointing at a third-party host, which is both broken and a
  // disclosure. Same rule as the logo, and for the same reason.
  const LOCAL_PATH = /^\/(?!\/)/;

  /**
   * Repaint the browser chrome from whatever background is ACTUALLY resolved.
   *
   * index.html shipped `content="#ffffff"` as a literal, which painted a white
   * bar above a venue whose own background is whatever the tenant set (or, once
   * there is a dark theme, whatever the theme resolved to). Two features were
   * about to write one hard-coded value.
   *
   * Read from the computed backgroundColor rather than re-deriving a hex, so
   * there is exactly ONE place that knows what the page ground is: whatever
   * `--bg` computes to, after the cascade, after the theme, after the tenant.
   */
  function syncThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const bg = getComputedStyle(document.documentElement).backgroundColor;
    if (bg) meta.setAttribute('content', bg);
  }

  /**
   * Swap the favicon links for a tenant's icon (#65).
   *
   * Three links, because three surfaces consume one field: `rel=icon` is the
   * tab and the desktop bookmark, `rel=apple-touch-icon` is the iOS home-screen
   * icon, and `rel=alternate icon` is the legacy .ico.
   *
   * The shell's OWN hrefs are snapshotted first and restored whenever the
   * tenant's icon is unusable or is simply the bundled default. Restoring
   * matters: pointing `apple-touch-icon` at /assets/favicon.png would replace a
   * 180px home-screen icon with the 32px tab one, so "no tenant icon" has to
   * mean "exactly what index.html ships", not "the first href everywhere".
   */
  const SHELL_ICONS = (() => {
    const read = (sel) => {
      const n = document.querySelector(sel);
      return n ? n.getAttribute('href') : null;
    };
    return {
      icon: read('link[rel="icon"]'),
      apple: read('link[rel="apple-touch-icon"]'),
      ico: read('link[rel="alternate icon"]'),
    };
  })();

  function applyFavicon(url) {
    const set = (sel, href) => {
      const n = document.querySelector(sel);
      if (n && href) n.setAttribute('href', href);
    };
    // Unusable, or the bundled default: the shell's own links, untouched. A
    // tenant with a half-configured brand renders the default venue.
    if (typeof url !== 'string' || !LOCAL_PATH.test(url) || url === SHELL_ICONS.icon) {
      set('link[rel="icon"]', SHELL_ICONS.icon);
      set('link[rel="apple-touch-icon"]', SHELL_ICONS.apple);
      set('link[rel="alternate icon"]', SHELL_ICONS.ico);
      return;
    }
    set('link[rel="icon"]', url);
    set('link[rel="apple-touch-icon"]', url);
    // Only when the tenant really supplies one: pointing the legacy link at a
    // PNG makes browsers that honour it fetch it under the wrong declared type.
    if (/\.ico$/i.test(url)) set('link[rel="alternate icon"]', url);
  }

  function applyBranding(b) {
    if (!b) return;
    OB.state.branding = b;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(b.palette || {})) {
      if (!PROP_NAME.test(String(k))) continue;
      if (!HEX.test(String(v).trim())) continue;
      root.style.setProperty(`--${k}`, String(v).trim());
    }
    if (b.name) document.title = `${b.name} — paper-money betting exchange`;
    const logo = document.querySelector('.logo img');
    // The venue's own CSP is `img-src 'self' data:`, so a remote logo URL is
    // refused by the browser whatever we do here. A path that would be blocked
    // is left alone rather than swapped for a broken image.
    if (logo && typeof b.logo === 'string' && LOCAL_PATH.test(b.logo)) {
      logo.src = b.logo;
      logo.alt = b.name || 'Exchange';
    }
    applyFavicon(b.favicon);
    if (b.tenant && b.tenant.slug) root.setAttribute('data-tenant', b.tenant.slug);
    // THE CURRENCY (#104). The last thing branding sets, because it is the one
    // that has to be right before anything renders an amount: fmt() in core.js
    // reads it and used to hard-code '$', so a white-label venue showed every
    // price in another currency's symbol.
    //
    // Only a well-formed code is accepted. A missing or malformed one leaves the
    // previous value alone rather than clearing it to null, because a stale
    // correct code beats no code — and an unrecognised-but-shaped code is a
    // DISPLAY question, which moneySymbol() answers by rendering the code
    // itself. lib/tenants.js is what refuses a bad currency on the money side.
    if (typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency)) {
      // Re-render only on a real change. The session change that brings us
      // here can swap tenants, and a tenant is a currency — so figures already
      // on screen would otherwise keep the previous tenant's symbol. At boot
      // the currency has never been set, so the header is not re-rendered for
      // nothing on the common path.
      if (OB.state.currency !== b.currency) {
        OB.state.currency = b.currency;
        OB.renderHeader();
      }
    }
    syncThemeColor();
  }

  // Called at boot and again whenever the SESSION changes, because the tenant
  // is resolved per user (`TEN.ofUser`) and falls back to the default when
  // signed out. A failure is not fatal: the :root palette is the default.
  async function loadBranding() {
    try {
      applyBranding(await OB.api('GET', '/api/branding'));
    } catch {
      /* the default palette stands */
    }
  }

  // ── routing ──────────────────────────────────────────────────────────────

  /**
   * Navigate to a page BY NAME, handling the case where the caller is already
   * on it.
   *
   * Assigning `location.hash` the value it already holds fires no `hashchange`,
   * so `route()` never runs and the promised move never happens. This is not a
   * corner: it is exactly what the Cash Out multi-position fallback did when
   * pressed from My Bets — the most likely place to press it — so it told the
   * user to pick one in Positions while Open orders stayed on screen.
   *
   * "Navigate to the page I am already on" is a recurring shape in this
   * codebase and every occurrence needs the same guard, so it is a helper
   * rather than a one-line patch at the call site.
   *
   * Re-rendering the current page is the honest meaning of that navigation:
   * the caller asked for this view to be the one on screen, and it is.
   */
  function goTo(page) {
    const hash = '#/' + page;
    if (location.hash === hash) {
      route();
      return;
    }
    location.hash = hash;
  }

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
      if (seq === OB.state.eventsReqSeq) {
        OB.state.events = events;
        // A LOAD THAT WORKED. Cleared here rather than in renderMarkets, so the
        // flag can never outlive the response it belongs to.
        OB.state.eventsError = null;
      }
    } catch (e) {
      if (seq === OB.state.eventsReqSeq) {
        OB.state.events = [];
        // AND A LOAD THAT DID NOT. These two used to be the same screen: a 500
        // and a venue with nothing on both rendered "No open events right now",
        // which is the one thing a trader must never be told when the exchange
        // is broken. An empty catalogue is a business state and a 500 is a
        // fault; the board now says which one the user is looking at and offers
        // a retry, because the first question after a failed load is "try
        // again", and before that it is "is this us or the market?".
        OB.state.eventsError = (e && e.message) || 'The board could not be loaded';
      }
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
  OB.state.eventsError = null;
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


  Object.assign(OB, { applyBranding, applyFavicon, closeAuth, closeNavRail, detectFeed, goTo, loadBranding, loadEvents, loadSports, openAccount, openAuth, openNavRail, refreshAll, refreshMarkets, renderPage, renderSessions, route, submitAuth, submitPasswordChange, syncThemeColor });
})();
