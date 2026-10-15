// admin-risk.js — the OPERATOR CONSOLE for risk, ledger, reconciliation,
// results holds, tenants and backups (IIFE; consumes the single window.OB
// global exported by app.js).
//
// WHY THIS FILE EXISTS. The engine shipped a market-maker risk desk, a
// double-entry ledger, reconciliation findings, a results feed with dispute
// holds, multi-tenancy and per-user limits — and an admin UI that reached nine
// endpoints out of thirty. An operator could not open any of it. Capability
// nobody can reach is not a feature, and it is worse than absent: the roadmap
// reads as if the desk exists.
//
// Everything here maps to a real route and degrades honestly: a 404 from an
// older server renders "not available on this build" rather than a blank
// panel, so an operator is never left wondering whether they clicked wrong.
(() => {
  'use strict';

  const OB = window.OB;
  if (!OB) {
    console.error('[admin-risk] window.OB missing — app.js must load first');
    return;
  }
  const { api, fmt, price2, esc, attr, openOverlay, closeOverlay, toast, signed } = OB;

  // A panel that failed to load must say WHY. A blank card reads as "nothing
  // to see", which is the opposite of the truth when the server is old or the
  // endpoint is erroring.
  function unavailable(msg) {
    return `<div class="empty">${esc(msg)}</div>`;
  }

  // ONE negative-money format across the product. This used to use fmt(), which
  // renders a negative as `$-140.43` — a shape nobody writes — while the
  // player-facing signed() in core.js renders `−$140.43` for the same number.
  // Two formats for one quantity, on two screens, in the same product.
  //
  // Zero is unsigned on purpose: "+$0.00" claims a gain that did not happen.
  function money(cents) {
    const text = cents === 0 ? fmt(0) : signed(cents);
    return `<span class="${cents > 0 ? 'win' : cents < 0 ? 'loss' : 'muted'}">${text}</span>`;
  }

  // The prompt says the reason is recorded, so it must actually reach the
  // server. The kill-switch handler used to capture it and send only `{ on }`,
  // and the server wrote a hard-coded null into the audit row — the operator was
  // told their justification was kept and it was thrown away.
  //
  // The length floor is enforced in the dialog as well as on the server: the
  // server's is the control, but lib/results.js refuses a held release under
  // five characters, and being told the minimum before submitting is better
  // than a 400 on the screen that moves the most money.
  const MIN_REASON = 5;
  // `danger` paints the CONFIRM button red, so it is passed per action and
  // defaults to false. Left always-on, "Release kill switch" — the one button on
  // this desk that puts quoting BACK — offered a red confirmation, which is the
  // same inversion the button itself had.
  const askReason = (what, extra) =>
    OB.askReason(what, Object.assign({ minLength: MIN_REASON }, extra || {}));

  /**
   * Every toast that reports a failure has to say so.
   *
   * `toast()` defaults its kind to 'ok', and five call sites here passed
   * `toast(e.message)` — so a REJECTED tenant update, a refused kill switch and a
   * failed withdrawal all rendered in the green success style. A failure the
   * product presents as a success is worse than no feedback at all: the
   * operator walks away believing an action they did not take happened.
   */
  const toastError = (e) => toast((e && e.message) || String(e), 'err');

  // ── Risk desk ─────────────────────────────────────────────────────────────
  // The numbers an operator MUST be able to see: how much the market maker
  // owes, how far it is from its caps, and whether the kill switch is pulled.
  // A venue that cannot see its own market-maker loss discovers it by going
  // bankrupt.
  //
  // ONE alarm threshold, stated once. The fill is healthy below it and red at
  // or above it; the percentage beside the bar carries the precision. There is
  // deliberately no middle band: the palette has two alarm hues and a third
  // state drawn in neutral grey would make a 60% bar look calmer than a 30% one.
  const METRE_ALARM_PCT = 80;

  async function renderRiskView(body) {
    let data;
    try {
      data = await api('GET', '/api/admin/risk');
    } catch (e) {
      body.innerHTML = unavailable(`Risk desk unavailable: ${e.message}`);
      return;
    }
    const bots = (data.bots || []).map((b) => {
      const pct = b.max_liability_cents > 0 ? Math.round((b.pressure || 0) * 100) : 0;
      return `<tr>
        <td><strong>${esc(b.username)}</strong></td>
        <td>${money(b.liability_cents)}</td>
        <td class="muted">${fmt(b.max_liability_cents)}</td>
        <td>${money(b.daily_pnl_cents)}</td>
        <td>
          <div class="meter" role="img" aria-label="${attr(pct)}% of cap${pct >= METRE_ALARM_PCT ? ', over the alarm threshold' : ''}" title="${attr(pct)}% of cap"><div class="meterfill${pct >= METRE_ALARM_PCT ? ' bad' : ''} w-${Math.round(pct / 10) * 10}"></div></div>
          <span class="muted">${pct}%</span>
        </td>
        <td>${b.quoting_allowed ? '<span class="chip live">quoting</span>' : `<span class="chip suspended">${esc(b.reason || 'stopped')}</span>`}</td>
      </tr>`;
    }).join('');

    let cashout = '<tr><td colspan="6" class="muted">Cash-out risk unavailable on this build.</td></tr>';
    try {
      const co = await api('GET', '/api/admin/risk/cashout');
      // The desk reads EXECUTED BUYOUTS now, not quotes: exposure is the
      // fair value of buyouts in unresolved markets, outlay is what has been
      // paid today. Both are written inside the paying transaction — the
      // previous "quotes" reading was zero forever (the audit's F2).
      cashout = `
        <tr><td><strong>Cash-out exposure</strong><div class="muted small">unsettled buyouts, fair value</div></td>
            <td>${money(co.outstanding_cents)}</td>
            <td class="muted">${fmt(co.max_outstanding_cents)}</td>
            <td>${money(-co.realised_loss_today_cents)}<div class="muted small">realised loss today</div></td>
            <td colspan="2">${co.quoting_allowed
              ? `<span class="chip live">${co.open_buyouts} open buyout(s) · ${co.taken_today} taken today</span>`
              : '<span class="chip suspended">capped</span>'}
                <div class="muted small">outlay today ${fmt(co.outlay_today_cents)} of ${fmt(co.max_daily_outlay_cents)}</div></td></tr>`;
    } catch { /* older build — keep the row, say so in it */ }

    body.innerHTML = `
      <h4>Market maker</h4>
      <table class="tbl">
        <thead><tr><th>Account</th><th>Liability</th><th>Cap</th><th>Today P&amp;L</th><th>Pressure</th><th>State</th></tr></thead>
        <tbody>${bots || '<tr><td colspan="6" class="muted">No market makers</td></tr>'}${cashout}</tbody>
      </table>
      <div class="row gap">
        <button class="btn ${data.kill_switch ? '' : 'red'}" id="riskKill">${data.kill_switch ? 'Release kill switch' : 'PULL KILL SWITCH'}</button>
        <button class="btn" id="riskWithdraw">Withdraw all bot quotes</button>
      </div>
      <p class="muted small">Killing stops NEW quotes; it does not cancel resting ones, because a quote
      already on the book is a promise the venue made. Withdrawing is the separate, explicit action.</p>
      <div id="riskOut"></div>`;

    const out = body.querySelector('#riskOut');
    // THE DESTRUCTIVE CONTROL MUST LOOK LIKE THE DESTRUCTIVE CONTROL. The label
    // is conditional — pulling is destructive, releasing is not — so the styling
    // has to be conditional the same way. It used to be the other way round:
    // `data.kill_switch ? 'danger' : ''` painted the danger style onto the
    // button that says "Release kill switch" and left "PULL KILL SWITCH" in the
    // neutral .btn face, identical to "Withdraw all bot quotes" beside it.
    body.querySelector('#riskKill').onclick = async () => {
      const on = !data.kill_switch;
      const why = on ? 'releasing the desk' : 'pulling the desk kill switch';
      const reason = await askReason(`You are ${why}`, {
        // `on` is the state the switch is moving TO, so it is also the verb:
        // moving it on is PULLING, which is the destructive one. (Getting this
        // backwards would have put a red "Release" on the screen.)
        confirmLabel: on ? 'Pull' : 'Release',
        danger: on,
      });
      if (!reason) return;
      try {
        await api('PUT', '/api/admin/risk/kill-switch', { on, reason });
        toast(`Kill switch ${on ? 'released' : 'pulled'}`);
        renderRiskView(body);
      } catch (e) { toastError(e); }
      void why;
    };
    body.querySelector('#riskWithdraw').onclick = async () => {
      const reason = await askReason('Withdrawing every resting bot quote', {
        confirmLabel: 'Withdraw',
        danger: true, // it cancels promises the venue already made
      });
      if (!reason) return;
      try {
        const r = await api('POST', '/api/admin/risk/withdraw', { reason });
        toast(`Cancelled ${r.cancelled_orders} quote(s), released ${fmt(r.released_cents)}`);
        renderRiskView(body);
      } catch (e) { toastError(e); }
    };
    void out;
  }

  // ── Ledger ────────────────────────────────────────────────────────────────
  // The double-entry view. Fund segregation as a NUMBER rather than a promise.
  async function renderLedgerView(body) {
    let d;
    try {
      d = await api('GET', '/api/admin/ledger');
    } catch (e) {
      body.innerHTML = unavailable(`Ledger unavailable: ${e.message}`);
      return;
    }
    const drift = d.conserved_cents;
    const seg = d.segregation || {};
    const divergent = d.cache_divergent || [];
    body.innerHTML = `
      <h4>Double-entry ledger</h4>
      <div class="statgrid">
        <div class="stat"><div class="muted small">Players' funds</div><strong>${fmt(seg.player_cents)}</strong></div>
        <div class="stat"><div class="muted small">Venue accounts</div><strong>${fmt(seg.venue_cents)}</strong></div>
        <div class="stat"><div class="muted small">Commission earned</div><strong>${fmt(d.commission_cents)}</strong></div>
        <div class="stat"><div class="muted small">House float</div><strong>${fmt(d.house_float_cents)}</strong></div>
        <div class="stat"><div class="muted small">Gateway clearing</div><strong>${fmt(d.gateway_clearing_cents)}</strong></div>
        <div class="stat ${drift === 0 ? '' : 'bad'}">
          <div class="muted small">Conservation drift</div>
          <strong>${drift === 0 ? 'balanced' : `${fmt(drift)} DRIFT`}</strong>
        </div>
      </div>
      ${drift === 0
        ? '<p class="muted small">Total debits equal total credits. Players\' money is ' +
          fmt(seg.player_cents) + ', held in per-user accounts and separable by query.</p>'
        : '<p class="bad">The ledger does not balance. Do not trade. Reconcile before continuing.</p>'}
      ${
        divergent.length
          ? `<p class="bad">${divergent.length} account(s) where balance_cents disagrees with the postings: ` +
            divergent.slice(0, 5).map((x) => `#${x.user_id}`).join(', ') +
            (divergent.length > 5 ? '…' : '') +
            '. The cached column is what the player sees, so these are wrong balances on screen.</p>'
          : ''
      }`;
  }

  // ── Reconciliation ────────────────────────────────────────────────────────
  // Discrepancies are FINDINGS, not log lines. They persist and re-surface
  // until a human closes them with a reason.
  async function renderReconView(body) {
    let findings = [];
    try {
      const d = await api('GET', '/api/admin/reconciliation/findings');
      findings = d.findings || [];
    } catch (e) {
      body.innerHTML = unavailable(`Reconciliation unavailable: ${e.message}`);
      return;
    }
    const open = findings.filter((f) => !f.resolved_at);
    const rows = findings.map((f) => `
      <tr class="${f.resolved_at ? 'muted' : ''}">
        <td><code>${esc(f.scope)}</code></td>
        <td>${fmt(f.expected_cents)}</td>
        <td>${fmt(f.actual_cents)}</td>
        <td>${money(f.drift_cents)}</td>
        <td class="muted">${f.seen_count}&times;</td>
        <td class="small">${esc(f.resolution || f.detail || '')}</td>
        <td>${f.resolved_at
          ? `<span class="muted small">closed ${esc((f.resolved_by_username || ''))}</span>`
          : `<button class="btn sm" data-resolve="${f.id}">Resolve</button>`}</td>
      </tr>`).join('');

    body.innerHTML = `
      <h4>Reconciliation ${open.length ? `<span class="chip suspended">${open.length} open</span>` : '<span class="chip live">clean</span>'}</h4>
      <table class="tbl">
        <thead><tr><th>Scope</th><th>Expected</th><th>Actual</th><th>Drift</th><th>Seen</th><th>Note</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="muted">No findings — the books agree.</td></tr>'}</tbody>
      </table>`;
    body.querySelectorAll('[data-resolve]').forEach((b) => {
      b.onclick = async () => {
        const reason = await askReason('Closing this reconciliation finding', { confirmLabel: 'Close' });
        if (!reason) return;
        try {
          await api('POST', `/api/admin/reconciliation/findings/${b.dataset.resolve}/resolve`, { reason });
          toast('Finding resolved');
          renderReconView(body);
        } catch (e) { toastError(e); }
      };
    });
  }

  // ── Results holds ─────────────────────────────────────────────────────────
  // A held market is still OPEN — the player holds a real position. These are
  // the disputes and unrecognised outcomes a machine could not decide.
  async function renderResultsView(body) {
    let held = [];
    let rules = null;
    try {
      const d = await api('GET', '/api/admin/results/held');
      held = d.markets || [];
    } catch (e) {
      body.innerHTML = unavailable(`Results feed unavailable: ${e.message}`);
      return;
    }
    try {
      rules = await api('GET', '/api/admin/results/void-rules');
    } catch { rules = null; }

    const rows = held.map((m) => `
      <tr>
        <td><strong>${esc(m.market_name)}</strong><div class="muted small">${esc(m.event_name)}</div></td>
        <td class="small">${esc(m.hold_reason || '')}</td>
        <td>
          <button class="btn sm primary" data-release-settle="${m.id}">Settle</button>
          <button class="btn sm" data-release-void="${m.id}">Void</button>
        </td>
      </tr>`).join('');

    body.innerHTML = `
      <h4>Markets held <span class="muted small">disputed or unrecognised outcomes</span></h4>
      <table class="tbl">
        <thead><tr><th>Market</th><th>Why it is held</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="muted">Nothing held. Every outcome resolved cleanly.</td></tr>'}</tbody>
      </table>
      ${
        rules
          ? `<h4>Void rules</h4>
             <p class="muted small">The same physical fact can be void in one sport and settled in another —
             a match abandoned after a red card voids in football, settles otherwise. Unknown signals are
             <strong>held</strong>, never guessed. Unknown sports default to void.</p>
             <table class="tbl"><thead><tr><th>Sport</th><th>Rules</th></tr></thead><tbody>
             ${Object.keys(rules.rules || {}).map((sport) =>
               `<tr><td><code>${esc(sport)}</code></td><td class="small">${
                 Object.entries(rules.rules[sport]).map(([k, v]) =>
                   `${esc(k)} → <span class="chip ${v === 'void' ? 'suspended' : v === 'hold' ? 'live' : 'live'}">${esc(v)}</span>`
                 ).join(' ')
               }</td></tr>`).join('')}
             </tbody></table>`
          : ''
      }`;
    body.querySelectorAll('[data-release-settle]').forEach((b) => {
      b.onclick = () => releaseHeld(body, Number(b.dataset.releaseSettle), 'settle');
    });
    body.querySelectorAll('[data-release-void]').forEach((b) => {
      b.onclick = () => releaseHeld(body, Number(b.dataset.releaseVoid), 'void');
    });
  }

  async function releaseHeld(body, marketId, decision) {
    const reason = await askReason(`Releasing this held market as ${decision}`, {
      confirmLabel: decision === 'void' ? 'Void market' : 'Continue to winners',
    });
    if (!reason) return;
    const payload = { decision, reason };
    if (decision === 'settle') {
      // By NAME, from the market's own book. The id prompt this replaced -
      // "Winning selection id (see the market on the board)" - asked the
      // operator for a value the product renders NOWHERE: cellHtml() puts
      // selection ids into data-sel and aria-label only, and the settle dialog
      // showed names too. A wrong id is a 400 on the screen that moves the
      // most money.
      const picked = await pickJointWinners(marketId);
      if (picked === null) return; // cancelled - releasing nothing
      // ONE runner is a win; TWO OR MORE is the dead heat. Sending a single
      // winner_selection_id for a tie is the harm lib/results.js records at
      // lines 316-323: releasing a held joint favourite as one runner paid a
      // whole stake to one person and charged the other joint winner's backer
      // his entire stake on a horse that TIED. The route has accepted
      // `dead_heat` for that reason and no screen could send it. This is it.
      if (picked.length === 1) payload.winner_selection_id = picked[0];
      else payload.dead_heat = picked;
    }
    try {
      await api('POST', `/api/admin/results/held/${marketId}/release`, payload);
      toast(`Market ${marketId} ${decision === 'void' ? 'voided' : 'settled'}`);
      renderResultsView(body);
    } catch (e) { toastError(e); }
  }

  /**
   * Choose the winning runner(s) of a held market, BY NAME.
   *
   * Resolves with the chosen selection ids, or null when the operator
   * cancelled. The runners come from the same `/api/markets/:id/book` call the
   * settle dialog makes, so the two screens cannot drift about what a market's
   * runners are.
   *
   * Checkboxes rather than radios because the engine settles a SET of winners:
   * lib/settle.js takes `dead_heat` as the joint-winner set and divides each pot
   * among them. One tick and two ticks are therefore the same control meaning
   * two different outcomes, so the summary line says which one is about to
   * happen BEFORE the operator commits money.
   *
   * The runner id is printed beside each name - muted, after the name - so the
   * value that reaches the audit trail can be read off the screen instead of
   * taken on trust. It is never something the operator has to type.
   *
   * The "at least one selection" guard is usability, NOT a control.
   * lib/results.js is the authority: it refuses a dead_heat list shorter than
   * two DISTINCT ids, a non-integer, a boolean and a quoted string, and a
   * release carrying neither a winner nor a dead_heat is a 400.
   */
  async function pickJointWinners(marketId) {
    let book;
    try {
      const r = await api('GET', `/api/markets/${marketId}/book`);
      book = r.book || [];
    } catch (e) {
      toastError(e);
      return null;
    }
    if (!book.length) {
      toast('This market has no runners to choose from', 'err');
      return null;
    }
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    // The shared overlay stack, so Escape closes THIS dialog, Tab stays inside
    // it and focus returns to the button that opened it - the same treatment
    // settleDialog gets.
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="box">
        <h3>Release as settled</h3>
        <p class="muted hint">Tick the one runner that won. Tick two or more if they tied - a joint
          result splits each pot between them, which is NOT the same as paying one runner the whole pot.</p>
        <div id="hoWinners" role="group" aria-label="Winning runners">
          ${book
            .map(
              (s) => `<label class="optrow">
              <input type="checkbox" class="hoPick" value="${attr(s.selection_id)}" />
              <span>${esc(s.name)}</span>
              <span class="muted tn">#${attr(s.selection_id)} &middot; LTP ${price2(s.ltp)}</span>
            </label>`
            )
            .join('')}
        </div>
        <div class="muted fineprint" id="hoSummary" aria-live="polite">Nothing selected.</div>
        <div class="row mt">
          <button class="btn primary grow" id="hoGo" disabled>Release as settled</button>
          <button class="btn" id="hoCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    openOverlay(overlay);

    let settle;
    const answered = new Promise((res) => { settle = res; });
    // Cancel and the backdrop both mean "release nothing", and both must
    // unblock the awaiter in releaseHeld as well as dismiss the overlay.
    const dismiss = () => { closeOverlay(overlay); settle(null); };

    const go = overlay.querySelector('#hoGo');
    const summary = overlay.querySelector('#hoSummary');
    const picked = () =>
      Array.from(overlay.querySelectorAll('.hoPick'))
        .filter((c) => c.checked)
        .map((c) => {
          const row = c.closest('.optrow');
          const name = row.querySelector('span:not(.muted)');
          return { id: Number(c.value), name: (name && name.textContent) || '' };
        });

    overlay.querySelectorAll('.hoPick').forEach((c) => {
      c.onchange = () => {
        const sel = picked();
        go.disabled = sel.length === 0;
        if (sel.length === 0) summary.textContent = 'Nothing selected.';
        else if (sel.length === 1) summary.textContent = `Settling as ${sel[0].name}.`;
        else
          summary.textContent =
            `Dead heat: ${sel.length} joint winners (${sel.map((p) => p.name).join(', ')}). ` +
            'Each pot is split between them.';
      };
    });
    overlay.querySelector('#hoCancel').onclick = dismiss;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) dismiss();
    });
    go.onclick = () => {
      const ids = picked().map((p) => p.id);
      closeOverlay(overlay);
      // DISTINCT: lib/results.js refuses a dead_heat of fewer than two
      // DISTINCT ids, so the list must never carry a repeat.
      settle(ids.length ? [...new Set(ids)] : null);
    };
    return answered;
  }

  // ── Tenants ───────────────────────────────────────────────────────────────
  async function renderTenantsView(body) {
    let list = [];
    try {
      const d = await api('GET', '/api/admin/tenants');
      list = d.tenants || [];
    } catch (e) {
      body.innerHTML = unavailable(`Tenants unavailable: ${e.message}`);
      return;
    }
    const rows = list.map((t) => {
      let juris = [];
      let brand = null;
      try { juris = JSON.parse(t.jurisdictions || '[]'); } catch { juris = []; }
      try { brand = JSON.parse(t.brand || 'null'); } catch { brand = null; }
      return `<tr>
        <td><strong>${esc(t.name)}</strong><div class="muted small">${esc(t.slug)}</div></td>
        <td>${t.commission_bps} bps <span class="muted small">(${(t.commission_bps / 100).toFixed(2)}%)</span></td>
        <td>${juris.length ? esc(juris.join(', ')) : '<span class="muted">unrestricted</span>'}</td>
        <td>${esc((brand && brand.name) || '—')}</td>
        <td>${t.status === 'active' ? '<span class="chip live">active</span>' : '<span class="chip suspended">suspended</span>'}</td>
        <td><button class="btn sm" data-tenant="${t.id}">Edit</button></td>
      </tr>`;
    }).join('');
    body.innerHTML = `
      <h4>Tenants</h4>
      <p class="muted small">Self-hosting is the degenerate case of multi-tenancy. Commission is in basis
      points, an integer, because a float converted per settlement ends up a cent off.</p>
      <table class="tbl">
        <thead><tr><th>Tenant</th><th>Commission</th><th>Jurisdictions</th><th>Brand</th><th>State</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">No tenants</td></tr>'}</tbody>
      </table>
      <div id="tenantOut"></div>`;
    body.querySelectorAll('[data-tenant]').forEach((b) => {
      b.onclick = () => editTenant(body, list.find((t) => t.id === Number(b.dataset.tenant)));
    });
  }

  // ── Branding ────────────────────────────────────────────────────────────
  // The keys the desk offers. The APPLY side (shell.js) accepts any property
  // name a tenant row carries, so an operator who sets `red` or `card2` through
  // the API gets it too; this is the curated subset worth surfacing, not a
  // closed vocabulary.
  const PALETTE_KEYS = [
    ['accent', 'Accent'],
    ['bg', 'Background'],
    ['text', 'Text'],
    ['blue', 'Back prices'],
    ['pink', 'Lay prices'],
  ];
  const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

  function currentBrand(tenant) {
    try {
      const b = JSON.parse(tenant.brand || 'null');
      return b && typeof b === 'object' ? b : {};
    } catch {
      return {};
    }
  }

  // Prefixed so two tenants can be edited on one screen without their palettes
  // bleeding into each other.
  const pf = (tenantId, key) => `tp_${tenantId}_${key.replace(/[^a-z0-9]/gi, '')}`;

  function editTenant(body, tenant) {
    const out = body.querySelector('#tenantOut');
    const brand = currentBrand(tenant);
    const pal = brand.palette && typeof brand.palette === 'object' ? brand.palette : {};
    out.innerHTML = `
      <div class="card">
        <h4>Edit ${esc(tenant.name)}</h4>
        <label>Commission (bps)</label>
        <input id="tBps" type="number" min="0" max="2000" value="${attr(tenant.commission_bps)}">
        <label>Jurisdictions (comma-separated ISO codes; empty = unrestricted)</label>
        <input id="tJuris" value="${esc(JSON.parse(tenant.jurisdictions || '[]').join(', '))}">
        <label>Status</label>
        <select id="tStatus"><option value="active" ${tenant.status === 'active' ? 'selected' : ''}>active</option>
          <option value="suspended" ${tenant.status === 'suspended' ? 'selected' : ''}>suspended</option></select>

        <h4 class="fieldlabel adm-sub">Branding</h4>
        <p class="muted fineprint">A config read, not a build step: these become CSS custom properties on
          :root. Every player of this tenant sees them.</p>
        <label>Brand name (page title, logo alt text)</label>
        <input id="tBrandName" value="${esc(brand.name || '')}">
        <label>Logo (a path on this venue, e.g. /assets/logo.png)</label>
        <input id="tBrandLogo" value="${esc(brand.logo || '')}">
        <label>Favicon (tab and home-screen icon; a path on this venue, e.g. /assets/favicon.png)</label>
        <input id="tBrandFavicon" value="${esc(brand.favicon || '')}">
        <label>Terms URL (shown in the player's Account panel)</label>
        <input id="tBrandTerms" value="${esc(brand.terms_url || '')}">
        <label>Palette — hex colours, empty = the house default</label>
        ${PALETTE_KEYS.map(
          ([k, label]) =>
            `<div class="fieldrow">
              <span class="muted tn palkey">${esc(label)}</span>
              <input id="${pf(tenant.id, k)}" value="${esc(pal[k] || '')}" placeholder="unset" spellcheck="false" />
            </div>`
        ).join('')}

        <div class="row gap"><button class="btn primary" id="tSave">Save</button>
        <button class="btn" id="tCancel">Cancel</button></div>
      </div>`;
    out.querySelector('#tCancel').onclick = () => { out.innerHTML = ''; };
    out.querySelector('#tSave').onclick = async () => {
      const jurisRaw = out.querySelector('#tJuris').value.trim();
      // Validate HERE, not server-side: lib/tenants.js stores `brand` as an
      // opaque JSON.stringify with no inspection at all, so the desk is the
      // only thing standing between a typo and a venue whose --text is not a
      // colour and every rule using it fails at computed-value time.
      const palette = {};
      for (const [k] of PALETTE_KEYS) {
        const raw = out.querySelector(`#${pf(tenant.id, k)}`).value.trim();
        if (!raw) continue;
        if (!HEX_RE.test(raw)) return toast(`Palette "${k}" must be a hex colour, e.g. #1b5fd9`, 'err');
        palette[k] = raw;
      }
      const logo = out.querySelector('#tBrandLogo').value.trim();
      if (logo && !/^\/(?!\/)/.test(logo)) {
        return toast('The logo must be a path on this venue, e.g. /assets/logo.png', 'err');
      }
      // The same rule as the logo, and for the same reason: the venue's CSP is
      // `img-src 'self' data:`, so a remote icon is a refused fetch and a tab
      // pointing at a third-party host. Refused HERE rather than written and
      // left broken.
      const favicon = out.querySelector('#tBrandFavicon').value.trim();
      if (favicon && !/^\/(?!\/)/.test(favicon)) {
        return toast('The favicon must be a path on this venue, e.g. /assets/favicon.png', 'err');
      }
      const termsUrl = out.querySelector('#tBrandTerms').value.trim();
      const nextBrand = {
        name: out.querySelector('#tBrandName').value.trim(),
        logo: logo || '/assets/logo.png',
        favicon: favicon || '/assets/favicon.png',
        terms_url: termsUrl || null,
        palette,
      };
      try {
        await api('PUT', `/api/admin/tenants/${tenant.id}`, {
          commission_bps: Number(out.querySelector('#tBps').value),
          status: out.querySelector('#tStatus').value,
          jurisdictions: jurisRaw ? jurisRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [],
          brand: nextBrand,
        });
        // ONE toast, not two. toast() overwrites #toast in place, so a second
        // call silently replaces the first: the "Tenant updated" confirmation
        // this used to be followed by was never seen by anybody.
        toast('Tenant updated · branding applies on the next page load');
        renderTenantsView(body);
      } catch (e) { toastError(e); }
    };
  }

  // ── Operations ────────────────────────────────────────────────────────────
  async function renderOpsView(body) {
    let health = null;
    let ready = null;
    try {
      health = await api('GET', '/healthz');
      ready = await api('GET', '/readyz');
    } catch (e) {
      body.innerHTML = unavailable(`Operational endpoints unavailable: ${e.message}`);
      return;
    }
    body.innerHTML = `
      <h4>Operations</h4>
      <div class="statgrid">
        <div class="stat"><div class="muted small">Uptime</div><strong>${health.uptime_seconds}s</strong></div>
        <div class="stat ${ready.status === 'ready' ? '' : 'bad'}">
          <div class="muted small">Readiness</div><strong>${esc(ready.status)}</strong></div>
      </div>
      <table class="tbl"><tbody>
        ${Object.entries(ready.checks || {}).map(([k, v]) =>
          `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td></tr>`).join('')}
      </tbody></table>
      <h4>Backup</h4>
      <p class="muted small">A snapshot uses VACUUM INTO, so it is consistent on a live database — a plain
      file copy of a WAL database can be torn and produce a restore that does not open. Snapshots are
      integrity checked as they are taken.</p>
      <div class="row gap"><button class="btn" id="opsBackup">Take a snapshot now</button></div>
      <div id="opsOut"></div>`;
    body.querySelector('#opsBackup').onclick = async () => {
      const out = body.querySelector('#opsOut');
      out.innerHTML = '<span class="muted">Taking a snapshot…</span>';
      try {
        const r = await api('POST', '/api/admin/backup', {});
        out.innerHTML = `<p class="ok small">Snapshot at <code>${esc(r.path)}</code> — ${r.bytes} bytes,
          ${r.users} accounts, integrity ${esc(r.integrity)}.</p>`;
      } catch (e) {
        out.innerHTML = `<p class="bad small">${esc(e.message)}</p>`;
      }
    };
  }

  // ── Registration ──────────────────────────────────────────────────────────
  const VIEWS = {
    risk: renderRiskView,
    ledger: renderLedgerView,
    recon: renderReconView,
    results: renderResultsView,
    tenants: renderTenantsView,
    ops: renderOpsView,
  };

  /**
   * Render an operator view into `page`. Called by admin.js when a tab is
   * selected, so the desk is one code path with two entry points rather than
   * two implementations that drift.
   */
  function renderInto(view) {
    // #adminBody is the mount EVERY admin view renders into, so the operator
    // views are indistinguishable from the built-in ones to the caller and
    // there is a single code path. Resolved by id rather than passed down
    // because the built-in views already do exactly this, and two different
    // ways of reaching one element is how they drift.
    const body = document.getElementById('adminBody');
    if (!body) return;
    (VIEWS[view] || renderOpsView)(body);
  }

  window.OBAdminRisk = { renderInto, views: Object.keys(VIEWS) };
})();