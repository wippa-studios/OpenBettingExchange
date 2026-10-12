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
  const { api, fmt, price2, esc, attr, openOverlay, closeOverlay, toast } = OB;

  // A panel that failed to load must say WHY. A blank card reads as "nothing
  // to see", which is the opposite of the truth when the server is old or the
  // endpoint is erroring.
  function unavailable(msg) {
    return `<div class="empty">${esc(msg)}</div>`;
  }

  function money(cents) {
    return `<span class="${cents > 0 ? 'win' : cents < 0 ? 'loss' : 'muted'}">${fmt(cents)}</span>`;
  }

  function askReason(what) {
    const reason = window.prompt(`${what}\n\nReason (recorded in the audit log):`);
    if (reason === null) return null;
    return reason.trim() ? reason.trim() : null;
  }

  // ── Risk desk ─────────────────────────────────────────────────────────────
  // The numbers an operator MUST be able to see: how much the market maker
  // owes, how far it is from its caps, and whether the kill switch is pulled.
  // A venue that cannot see its own market-maker loss discovers it by going
  // bankrupt.
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
          <div class="meter" title="${pct}% of cap"><div class="meterfill ${pct > 80 ? 'bad' : pct > 50 ? 'warn' : ''} w-${Math.round(pct / 10) * 10}"></div></div>
          <span class="muted">${pct}%</span>
        </td>
        <td>${b.quoting_allowed ? '<span class="chip live">quoting</span>' : `<span class="chip suspended">${esc(b.reason || 'stopped')}</span>`}</td>
      </tr>`;
    }).join('');

    let cashout = '<tr><td colspan="6" class="muted">Cash-out risk unavailable on this build.</td></tr>';
    try {
      const co = await api('GET', '/api/admin/risk/cashout');
      cashout = `
        <tr><td><strong>Cash-out exposure</strong></td>
            <td>${money(co.outstanding_cents)}</td>
            <td class="muted">${fmt(co.max_outstanding_cents)}</td>
            <td>${money(-co.realised_loss_today_cents)}</td>
            <td colspan="2">${co.quoting_allowed
              ? `<span class="chip live">${co.open_quotes} open quote(s)</span>`
              : '<span class="chip suspended">capped</span>'}</td></tr>`;
    } catch { /* older build — keep the row, say so in it */ }

    body.innerHTML = `
      <h4>Market maker</h4>
      <table class="tbl">
        <thead><tr><th>Account</th><th>Liability</th><th>Cap</th><th>Today P&amp;L</th><th>Pressure</th><th>State</th></tr></thead>
        <tbody>${bots || '<tr><td colspan="6" class="muted">No market makers</td></tr>'}${cashout}</tbody>
      </table>
      <div class="row gap">
        <button class="btn ${data.kill_switch ? 'danger' : ''}" id="riskKill">${data.kill_switch ? 'Release kill switch' : 'PULL KILL SWITCH'}</button>
        <button class="btn" id="riskWithdraw">Withdraw all bot quotes</button>
        <button class="btn sm" id="riskExpireQuotes">Expire stale cash-out quotes</button>
      </div>
      <p class="muted small">Killing stops NEW quotes; it does not cancel resting ones, because a quote
      already on the book is a promise the venue made. Withdrawing is the separate, explicit action.</p>
      <div id="riskOut"></div>`;

    const out = body.querySelector('#riskOut');
    body.querySelector('#riskKill').onclick = async () => {
      const on = !data.kill_switch;
      const why = on ? 'releasing the desk' : 'pulling the desk kill switch';
      const reason = askReason(`You are ${why}`);
      if (!reason) return;
      try {
        await api('PUT', '/api/admin/risk/kill-switch', { on });
        toast(`Kill switch ${on ? 'released' : 'pulled'}`);
        renderRiskView(body);
      } catch (e) { toast(e.message); }
      void why;
    };
    body.querySelector('#riskWithdraw').onclick = async () => {
      const reason = askReason('Withdrawing every resting bot quote');
      if (!reason) return;
      try {
        const r = await api('POST', '/api/admin/risk/withdraw', { reason });
        toast(`Cancelled ${r.cancelled_orders} quote(s), released ${fmt(r.released_cents)}`);
        renderRiskView(body);
      } catch (e) { toast(e.message); }
    };
    body.querySelector('#riskExpireQuotes').onclick = async () => {
      try {
        const r = await api('POST', '/api/admin/risk/cashout/expire', {});
        toast(`Expired ${r.expired} stale quote(s)`);
        renderRiskView(body);
      } catch (e) { toast(e.message); }
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
      b.onclick = () => {
        const reason = askReason('Closing this reconciliation finding');
        if (!reason) return;
        api('POST', `/api/admin/reconciliation/findings/${b.dataset.resolve}/resolve`, { reason })
          .then(() => { toast('Finding resolved'); renderReconView(body); })
          .catch((e) => toast(e.message));
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
    const reason = askReason(`Releasing this held market as ${decision}`);
    if (!reason) return;
    let winner = null;
    if (decision === 'settle') {
      const raw = window.prompt('Winning selection id (see the market on the board):');
      if (raw === null) return;
      winner = Number(raw);
      if (!Number.isInteger(winner) || winner <= 0) { toast('A positive selection id is required'); return; }
    }
    try {
      await api('POST', `/api/admin/results/held/${marketId}/release`, {
        decision, winner_selection_id: winner, reason,
      });
      toast(`Market ${marketId} ${decision === 'void' ? 'voided' : 'settled'}`);
      renderResultsView(body);
    } catch (e) { toast(e.message); }
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

  function editTenant(body, tenant) {
    const out = body.querySelector('#tenantOut');
    out.innerHTML = `
      <div class="card">
        <h4>Edit ${esc(tenant.name)}</h4>
        <label>Commission (bps)</label>
        <input id="tBps" type="number" min="0" max="2000" value="${tenant.commission_bps}">
        <label>Jurisdictions (comma-separated ISO codes; empty = unrestricted)</label>
        <input id="tJuris" value="${esc(JSON.parse(tenant.jurisdictions || '[]').join(', '))}">
        <label>Status</label>
        <select id="tStatus"><option value="active" ${tenant.status === 'active' ? 'selected' : ''}>active</option>
          <option value="suspended" ${tenant.status === 'suspended' ? 'selected' : ''}>suspended</option></select>
        <div class="row gap"><button class="btn primary" id="tSave">Save</button>
        <button class="btn" id="tCancel">Cancel</button></div>
      </div>`;
    out.querySelector('#tCancel').onclick = () => { out.innerHTML = ''; };
    out.querySelector('#tSave').onclick = async () => {
      const jurisRaw = out.querySelector('#tJuris').value.trim();
      try {
        await api('PUT', `/api/admin/tenants/${tenant.id}`, {
          commission_bps: Number(out.querySelector('#tBps').value),
          status: out.querySelector('#tStatus').value,
          jurisdictions: jurisRaw ? jurisRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [],
        });
        toast('Tenant updated');
        renderTenantsView(body);
      } catch (e) { toast(e.message); }
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