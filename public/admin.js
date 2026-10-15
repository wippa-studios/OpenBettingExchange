// admin.js — admin trading desk (IIFE; consumes the single window.OB global
// exported by app.js). Every call below maps to a real API route.
(() => {
  'use strict';

  const OB = window.OB;
  if (!OB) {
    console.error('[admin] window.OB missing — app.js must load first');
    return;
  }
  // Destructure EXACTLY what this file uses — window.OB is deliberately
  // narrowed to this list (app.js S6), so anything else is undefined here.
  const { api, toast, fmt, price2, esc, attr, state, refreshAll, openOverlay, closeOverlay } = OB;

  // How long a justification must be before the desk will send one.
  //
  // A DESK POLICY, not a server rule: lib/admin.js's reasonOr400 refuses an
  // EMPTY reason and a 500-character one, and enforces no floor in between.
  // Asking for a whole sentence is what makes an audit row worth reading six
  // months later, and the dialog states the requirement before the operator is
  // told they got it wrong.
  const MIN_REASON = 5;

  async function render(page) {
    if (!(state.user && state.user.role === 'admin')) {
      page.innerHTML = '<div class="card"><div class="empty">Admin only</div></div>';
      return;
    }
    page.innerHTML = `
      <div class="card">
        <h3>Trading desk</h3>
        <div class="tabs">
          <button class="btn sm primary" data-view="markets">Markets</button>
          <button class="btn sm" data-view="users">Users</button>
          <button class="btn sm" data-view="audit">Audit</button>
          <button class="btn sm" data-view="create">Create</button>
          <button class="btn sm" data-view="risk">Risk</button>
          <button class="btn sm" data-view="ledger">Ledger</button>
          <button class="btn sm" data-view="recon">Reconcile</button>
          <button class="btn sm" data-view="results">Held</button>
          <button class="btn sm" data-view="tenants">Tenants</button>
          <button class="btn sm" data-view="ops">Ops</button>
        </div>
        <div id="adminBody"></div>
      </div>`;
    page.querySelectorAll('[data-view]').forEach((b) => {
      b.onclick = () => {
        page.querySelectorAll('[data-view]').forEach((x) => x.classList.remove('primary'));
        b.classList.add('primary');
        const v = b.dataset.view;
        // The operator views live in admin-risk.js and share this tab strip and
        // this #adminBody, so there is ONE code path for rendering and the two
        // halves cannot drift apart.
        if (window.OBAdminRisk && window.OBAdminRisk.views.includes(v)) {
          window.OBAdminRisk.renderInto(v);
        } else if (v === 'markets') renderMarketsView();
        else if (v === 'users') renderUsersView();
        else if (v === 'audit') renderAuditView();
        else renderCreateView();
      };
    });
    renderMarketsView();
  }

  // ── accounts ──────────────────────────────────────────────────────────────
  // Every mutating control below is gated server-side too (reason required,
  // self-actions refused, last-admin protected). The dialogs here exist so the
  // operator is told WHY at the point of action rather than after a 400.

  /** Justify an action. Resolves the reason, or null if the operator cancelled. */
  function askReason(what) {
    return OB.askReason(what, { minLength: MIN_REASON });
  }

  // Every desk view renders into #adminBody, so they all share ONE sequence
  // token: rapid tab clicks used to leave the users table painted over the audit
  // table the operator had just selected, because whichever response landed last
  // won regardless of which request was made last.
  async function renderUsersView(q) {
    const seq = OB.beginLoad('adminBody');
    const body = document.getElementById('adminBody');
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    body.innerHTML = '<div class="empty">Loading…</div>';
    let data;
    try {
      data = await api('GET', '/api/admin/users?' + params.toString());
    } catch (e) {
      if (OB.isCurrent('adminBody', seq) && document.getElementById('adminBody') === body) {
        body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      }
      return;
    }
    if (!OB.isCurrent('adminBody', seq) || document.getElementById('adminBody') !== body) return;

    body.innerHTML = `
      <div class="row adm-gap">
        <input id="userSearch" class="grow" placeholder="search username or email" value="${attr(q || '')}" />
        <button class="btn sm" id="userSearchGo">Search</button>
        <button class="btn sm" id="userSearchClear">Clear</button>
        <span class="muted">${data.total} account(s)</span>
      </div>
      <table class="adm-tbl">
        <thead><tr class="fineprint">
          <th>ID</th><th>User</th><th>Email</th><th>Role</th>
          <th>Status</th><th class="num">Available</th><th></th>
        </tr></thead>
        <tbody>${data.users.map(userRow).join('')}</tbody>
      </table>`;

    const search = document.getElementById('userSearch');
    const run = () => renderUsersView(search.value.trim());
    document.getElementById('userSearchGo').onclick = run;
    document.getElementById('userSearchClear').onclick = () => renderUsersView('');
    search.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } };

    body.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = async () => {
        const id = Number(btn.dataset.id);
        const act = btn.dataset.act;
        let reason = null;
        let body_ = {};

        if (act === 'balance') {
          // Amount AND justification in ONE dialog. They were two consecutive
          // window.prompts, so cancelling the second silently discarded the
          // first with nothing on screen to say so.
          const r = await OB.askDialog({
            title: 'Adjust balance',
            message: `Adjusting ${(data.users.find((u) => u.id === id) || {}).username || `#${id}`}'s balance. The reason is recorded in the audit log.`,
            confirmLabel: 'Adjust',
            fields: [
              {
                id: 'amount',
                label: 'Amount in dollars',
                type: 'number',
                step: '0.01',
                placeholder: 'negative to claw back',
                required: true,
                validate: (v) => {
                  const n = Number(v);
                  if (!Number.isFinite(n)) return 'Enter a number of dollars';
                  if (n === 0) return 'Enter a non-zero amount';
                  return null;
                },
              },
              { id: 'reason', label: 'Reason', placeholder: 'why this, in one line', required: true, minLength: MIN_REASON },
            ],
          });
          if (!r.ok) return;
          reason = r.values.reason;
          body_ = { delta_cents: Math.round(Number(r.values.amount) * 100), reason };
        } else if (act === 'suspend' || act === 'reinstate') {
          reason = await askReason(act === 'suspend' ? 'Suspending an account' : 'Reinstating an account');
          if (!reason) return;
          body_ = { status: act === 'suspend' ? 'suspended' : 'active', reason };
        } else if (act === 'promote' || act === 'demote') {
          reason = await askReason(act === 'promote' ? 'Granting admin' : 'Revoking admin');
          if (!reason) return;
          body_ = { role: act === 'promote' ? 'admin' : 'user', reason };
        } else if (act === 'limits' || act === 'exclude') {
          // Dialogs of their own: limits need the account's current row and
          // the market list, and self-exclusion needs a reason and an end date
          // typed rather than guessed. Both fall through to the dialog and
          // return — there is nothing here to send with the generic handler.
          btn.disabled = false;
          const row = data.users.find((u) => u.id === id);
          if (act === 'limits') await limitsDialog(row || { id });
          else await excludeDialog(row || { id, username: `#${id}` });
          return;
        }

        btn.disabled = true;
        try {
          if (act === 'balance') await api('POST', `/api/admin/users/${id}/balance`, body_);
          else await api('PATCH', `/api/admin/users/${id}`, body_);
          toast('Done');
          renderUsersView(q);
        } catch (e) {
          toast(e.message, 'err');
          btn.disabled = false;
        }
      };
    });
  }

  function userRow(u) {
    const suspended = u.status === 'suspended';
    const isAdmin = u.role === 'admin';
    return `<tr>
      <td class="tn">${u.id}</td>
      <td>${esc(u.username)}</td>
      <td class="muted">${u.email ? esc(u.email) : '—'}</td>
      <td>${isAdmin ? '<strong>admin</strong>' : 'user'}</td>
      <td>${suspended ? '<strong>suspended</strong>' : 'active'}</td>
      <td class="tn num">${fmt(u.available_cents)}${
        u.frozen_cents ? ` <small class="muted">· ${fmt(u.frozen_cents)} frozen</small>` : ''
      }</td>
      <td class="acts">
        <button class="btn sm" data-act="balance" data-id="${u.id}">Balance</button>
        <button class="btn sm" data-act="${suspended ? 'reinstate' : 'suspend'}" data-id="${u.id}">${suspended ? 'Reinstate' : 'Suspend'}</button>
        <button class="btn sm" data-act="${isAdmin ? 'demote' : 'promote'}" data-id="${u.id}">${isAdmin ? 'Revoke admin' : 'Make admin'}</button>
        <button class="btn sm" data-act="limits" data-id="${u.id}">Limits</button>
        <button class="btn sm red" data-act="exclude" data-id="${u.id}">Self-exclude</button>
      </td>
    </tr>`;
  }

  // ── per-user limits + self-exclusion (#52) ────────────────────────────────
  //
  // lib/limits.js enforces the stake cap, the market-liability cap and the
  // daily settled cap — plus operator-recorded self-exclusion — on EVERY trade
  // (LIMITS.assertTradeable / assertPlacement / assertStake, and
  // RG.assertDeposit on funding). Both controls were API routes only: an
  // operator running the venue from this desk could set none of them, and the
  // only route to either was a terminal.

  const LIMIT_AXES = [
    ['max_open_stake_cents', 'Max open stake', 'per order, in dollars'],
    ['max_market_liability_cents', 'Max market liability', 'per market, in dollars'],
    ['max_daily_settled_cents', 'Max daily settled', 'per day, in dollars'],
  ];

  // Dollars to whole cents. The engine takes INTEGER CENTS; a float would be
  // rejected by capOf(). This is presentation only — lib/limits.js is what
  // validates the number and what enforces the cap on every placement.
  function dollarsToCents(raw) {
    const v = Number(String(raw).trim());
    return Number.isFinite(v) ? Math.round(v * 100) : NaN;
  }

  function existingLimitsHtml(rows) {
    if (!rows.length) {
      return '<p class="muted fineprint">No limits recorded — every axis is uncapped at the venue default.</p>';
    }
    const cap = (c) => (c === null || c === undefined ? '<span class="muted">no cap</span>' : fmt(c));
    return (
      '<table class="adm-tbl"><thead><tr class="fineprint"><th>Scope</th><th>Open stake</th>' +
      '<th>Market liability</th><th>Daily settled</th></tr></thead><tbody>' +
      rows
        .map(
          (r) =>
            `<tr><td><code>${esc(r.scope)}</code></td><td class="tn">${cap(r.max_open_stake_cents)}</td>` +
            `<td class="tn">${cap(r.max_market_liability_cents)}</td><td class="tn">${cap(r.max_daily_settled_cents)}</td></tr>`
        )
        .join('') +
      '</tbody></table>'
    );
  }

  /**
   * Edit one account's abuse limits, for one scope.
   *
   * EVERY AXIS IS ALWAYS SENT, and the form is pre-filled from the row the
   * server already holds. That is not tidiness — it is the only safe shape.
   *
   * The route's own comment says "a key that is ABSENT leaves that axis
   * untouched; a key present with a null CLEARS the cap", and warns that
   * omitting a daily cap while tightening a stake limit "must not silently hand
   * the account an unlimited daily cap". That promise is not kept: the route
   * omits the absent key, lib/limits.js's capOf() maps `undefined` to `null`,
   * and setLimits writes every axis on every call. Measured against a running
   * server: stake 5000 + daily 9000, then a second PUT carrying only
   * `max_open_stake_cents: 1000`, came back with `max_daily_settled_cents:
   * null`. Omitting a key CLEARS that cap. Reported separately; fixing it is
   * lib/limits.js's and server.js's, not this file's.
   *
   * So this control never omits anything. It edits a whole row, shows the whole
   * row, and sends all three axes on every save — the bug cannot be reached
   * from the desk, and an operator who only means to raise the stake cap sees
   * the daily cap they are keeping rather than silently dropping it.
   *
   * The per-axis "no cap" box is a real, separate decision from leaving a
   * number alone; both are explicit here, and the server is still the authority
   * on whether the values are acceptable.
   */
  async function limitsDialog(user) {
    let existing = [];
    let markets = [];
    try {
      existing = (await api('GET', `/api/admin/users/${user.id}/limits`)).limits || [];
    } catch (e) {
      return toast(e.message, 'err');
    }
    // The market list only names the scopes; if it will not load the operator
    // can still set the global scope, which is the one that matters most.
    try {
      markets = (await api('GET', '/api/admin/stats')).markets || [];
    } catch {
      markets = [];
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `Limits for ${user.username}`);
    overlay.innerHTML = `
      <div class="box">
        <h3>Limits — ${esc(user.username)}</h3>
        <p class="muted hint">Enforced inside the placement transaction, so two concurrent orders cannot
          both slip under a cap. Tick <em>no cap</em> to remove a cap; leave the amount alone to keep it.</p>
        <div id="lmExisting">${existingLimitsHtml(existing)}</div>
        <label class="fieldlabel" for="lmScope">Scope</label>
        <select id="lmScope">
          <option value="global">global — every market</option>
          ${markets
            .map((m) => `<option value="market:${attr(m.id)}">${esc(m.name)} — ${esc(m.event_name)}</option>`)
            .join('')}
        </select>
        ${LIMIT_AXES.map(
          ([key, label, hint]) => `
          <label class="fieldlabel" for="lm_${key}">${esc(label)} <span class="muted">${esc(hint)}</span></label>
          <div class="fieldrow">
            <input class="noflex" id="lm_${key}" data-cents="${key}" type="number" min="0" step="0.01" placeholder="no cap" />
            <label class="optrow"><input type="checkbox" data-nocap="${key}" /> no cap</label>
          </div>`
        ).join('')}
        <div class="row mt">
          <button class="btn primary grow" id="lmSave">Save limits</button>
          <button class="btn" id="lmCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    openOverlay(overlay);
    const close = () => closeOverlay(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#lmCancel').onclick = close;

    const scopeSel = overlay.querySelector('#lmScope');
    const inputs = {};
    for (const [key] of LIMIT_AXES) {
      inputs[key] = {
        amt: overlay.querySelector(`[data-cents="${key}"]`),
        nocap: overlay.querySelector(`[data-nocap="${key}"]`),
      };
    }

    // Switching scope shows that scope's row, not a blank form: an operator
    // editing `market:12` must see what `market:12` currently says.
    //
    // The amount fields are NEVER disabled. An earlier draft greyed them out
    // whenever the axis was uncapped, which meant a fresh account opened with
    // three dead boxes and the operator had to untick "no cap" before they
    // could type — a form that reads as broken. Instead the checkbox is the
    // explicit statement of "no cap" and the amount is always typeable; an
    // unticked box with an empty amount is refused on save rather than
    // silently read as unlimited.
    const fill = () => {
      const row = existing.find((r) => r.scope === scopeSel.value);
      for (const [key] of LIMIT_AXES) {
        const v = row ? row[key] : null;
        const uncapped = v === null || v === undefined;
        inputs[key].amt.value = uncapped ? '' : (v / 100).toFixed(2);
        inputs[key].nocap.checked = uncapped;
      }
    };
    scopeSel.onchange = fill;
    for (const [key] of LIMIT_AXES) {
      inputs[key].nocap.onchange = () => {
        if (inputs[key].nocap.checked) inputs[key].amt.value = '';
      };
      inputs[key].amt.oninput = () => {
        // Typing a number IS choosing to cap that axis, so the box gives way.
        if (inputs[key].amt.value.trim() !== '') inputs[key].nocap.checked = false;
      };
    }
    fill();

    overlay.querySelector('#lmSave').onclick = async () => {
      const body = { scope: scopeSel.value };
      for (const [key, label] of LIMIT_AXES) {
        const { amt, nocap } = inputs[key];
        // No branch here omits a key — see the note above.
        if (nocap.checked) {
          body[key] = null;
          continue;
        }
        const raw = amt.value.trim();
        if (raw === '') {
          return toast(`${label}: type an amount, or tick "no cap"`, 'err');
        }
        body[key] = dollarsToCents(raw);
        if (!Number.isInteger(body[key]) || body[key] < 0) {
          return toast('Caps are whole amounts of dollars, zero or more', 'err');
        }
      }
      const go = overlay.querySelector('#lmSave');
      go.disabled = true;
      try {
        await api('PUT', `/api/admin/users/${user.id}/limits`, body);
        toast(`Limits saved for ${user.username}`);
        close();
      } catch (e) {
        toast(e.message, 'err');
        go.disabled = false;
      }
    };
  }

  /**
   * Self-exclusion: an operator-recorded, ABSOLUTE block on an account trading.
   *
   * It has no inverse on purpose (there is no unexclude route) — reinstatement
   * is a separate audited decision — so this dialog warns about what it does
   * before it does it: resting orders are cancelled and their escrow released.
   *
   * `until` IS SENT AS STRICT ISO. lib/limits.js used to take any string
   * Date.parse could make sense of and store it with the offset stripped, and
   * the stored value is later compared LEXICOGRAPHICALLY against
   * 'YYYY-MM-DD HH:MM:SS' — so "15 Jan 2030" sorted before "2026-…" and the
   * exclusion read as already lapsed the instant it was made. lib/util.js's
   * toSqlUtc() now refuses that shape outright and normalises offsets to UTC.
   * The control here is a <input type="datetime-local">, whose value is a
   * local wall clock, and it is converted to an absolute UTC instant before it
   * is sent: toSqlUtc reads an offset-less value as UTC, not as the operator's
   * local time, so passing the raw field through would store the wrong moment.
   *
   * Permanent is the default, matching lib/limits.js: a timed exclusion that
   * lapses into re-admission is a weaker product decision, and it should be
   * the one the operator has to ask for.
   */
  async function excludeDialog(user) {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `Self-exclude ${user.username}`);
    overlay.innerHTML = `
      <div class="box">
        <h3>Self-exclude ${esc(user.username)}</h3>
        <p class="muted hint">Absolute, and there is no undo from this screen: reinstatement is a separate,
          audited decision. Resting orders are cancelled and their escrow released. MATCHED positions are
          left alone on purpose — they are collateralised on both sides and must still settle.</p>
        <label class="fieldlabel" for="exReason">Reason (recorded in the audit log)</label>
        <input id="exReason" type="text" autocomplete="off" placeholder="why this account is being excluded" />
        <label class="optrow"><input type="checkbox" id="exPermanent" checked /> Permanent (recommended)</label>
        <label class="fieldlabel" for="exUntil">Ends at (local time)</label>
        <input id="exUntil" type="datetime-local" disabled />
        <div class="muted fineprint" id="exNote"></div>
        <div class="row mt">
          <button class="btn red grow" id="exGo">Self-exclude ${esc(user.username)}</button>
          <button class="btn" id="exCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    openOverlay(overlay);
    const close = () => closeOverlay(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#exCancel').onclick = close;

    const permanent = overlay.querySelector('#exPermanent');
    const until = overlay.querySelector('#exUntil');
    const note = overlay.querySelector('#exNote');
    const setPermanent = () => {
      until.disabled = permanent.checked;
      note.textContent = permanent.checked
        ? 'Sent as until: null — no end date.'
        : 'Sent as a strict ISO-8601 UTC instant. Local wall-clock here, converted before sending.';
    };
    permanent.onchange = setPermanent;
    // `change`, NOT `input`: editing the field passes through an empty value on
    // the way to anything the operator types, and an `input` handler that
    // treated empty as "go back to permanent" re-disabled the field mid-edit —
    // so the control could never be typed into.
    until.onchange = setPermanent;
    setPermanent();

    overlay.querySelector('#exGo').onclick = async () => {
      const reason = overlay.querySelector('#exReason').value.trim();
      if (!reason) return toast('A written reason is required', 'err');
      let iso = null;
      if (!permanent.checked) {
        // Never read an empty end date as "the epoch", and never silently
        // promote it to permanent: an operator who unticked the box asked for
        // a timed exclusion, so say what is missing.
        if (!until.value) return toast('Pick an end date and time, or tick Permanent', 'err');
        const d = new Date(until.value);
        if (Number.isNaN(d.getTime())) return toast('That is not a date and time this browser can read', 'err');
        // Strip the milliseconds: toSqlUtc's documented shape ends at seconds.
        iso = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
      }
      const go = overlay.querySelector('#exGo');
      go.disabled = true;
      try {
        const r = await api('POST', `/api/admin/users/${user.id}/exclude`, { until: iso, reason });
        toast(
          `${user.username} excluded${r.excluded_until ? ' until ' + r.excluded_until : ' permanently'} · ` +
            `${r.cancelled_orders} order(s) cancelled · ${fmt(r.released_cents)} released`
        );
        close();
      } catch (e) {
        toast(e.message, 'err');
        go.disabled = false;
      }
    };
  }

  // ── audit trail ───────────────────────────────────────────────────────────
  async function renderAuditView(target) {
    const seq = OB.beginLoad('adminBody');
    const body = document.getElementById('adminBody');
    body.innerHTML = '<div class="empty">Loading…</div>';
    let entries;
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (target) params.set('target', target);
      entries = (await api('GET', '/api/admin/audit?' + params.toString())).entries;
    } catch (e) {
      if (OB.isCurrent('adminBody', seq) && document.getElementById('adminBody') === body) {
        body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      }
      return;
    }
    if (!OB.isCurrent('adminBody', seq) || document.getElementById('adminBody') !== body) return;
    if (!entries.length) {
      body.innerHTML = '<div class="empty">No audit entries yet</div>';
      return;
    }
    body.innerHTML = `
      <div class="row adm-gap">
        <input id="auditTarget" class="grow" placeholder="filter by target, e.g. user:4" value="${attr(target || '')}" />
        <button class="btn sm" id="auditGo">Filter</button>
        <button class="btn sm" id="auditClear">Clear</button>
      </div>
      <table class="adm-tbl">
        <thead><tr class="fineprint">
          <th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Change</th><th>Reason</th>
        </tr></thead>
        <tbody>${entries.map((e) => `<tr>
          <td class="tn muted">${esc(e.at)}</td>
          <td class="tn">${e.actor_id === null ? '<span class="muted">system</span>' : '#' + e.actor_id}</td>
          <td>${esc(e.action)}</td>
          <td class="tn">${esc(e.target || '')}</td>
          <td class="muted fineprint">${OB.esc(auditChange(e))}</td>
          <td class="muted">${esc(e.reason || '')}</td>
        </tr>`).join('')}</tbody>
      </table>`;

    const go = () => renderAuditView(document.getElementById('auditTarget').value.trim());
    document.getElementById('auditGo').onclick = go;
    document.getElementById('auditClear').onclick = () => renderAuditView('');
  }

  // Renders only the keys that actually changed, so a role flip does not print
  // the whole balance alongside it.
  function auditChange(e) {
    if (!e.before && !e.after) return '';
    const keys = Array.from(new Set([...Object.keys(e.before || {}), ...Object.keys(e.after || {})]));
    return keys
      .map((k) => `${k}: ${JSON.stringify(e.before?.[k])} → ${JSON.stringify(e.after?.[k])}`)
      .join('; ');
  }

  // ── markets + settlement ────────────────────────────────────────────────
  async function renderMarketsView() {
    const seq = OB.beginLoad('adminBody');
    const page = document.getElementById('pageAdmin') || document.querySelector('#adminBody')?.parentElement;
    const body = document.getElementById('adminBody');
    body.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const { markets } = await api('GET', '/api/admin/stats');
      if (!OB.isCurrent('adminBody', seq) || document.getElementById('adminBody') !== body) return;
      if (!markets.length) {
        body.innerHTML = '<div class="empty">No markets</div>';
        return;
      }
      body.innerHTML =
        '<table><thead><tr><th>Market</th><th>Event</th><th>Status</th><th>Matched</th><th>Open orders</th><th>Overround</th><th>Actions</th></tr></thead><tbody>' +
        markets
          .map(
            (m) => `<tr>
          <td>${esc(m.name)}</td>
          <td>${esc(m.event_name)}</td>
          <td><span class="chip ${esc(m.status)}">${esc(m.status)}</span></td>
          <td class="tn">${fmt(m.total_matched_cents)}</td>
          <td class="tn">${m.open_orders}</td>
          <td class="tn">${overroundCell(m.overround)}</td>
          <td>${
            m.status === 'settled'
              ? '<span class="muted">settled</span>'
              : `<button class="btn sm" data-toggle="${attr(m.id)}" data-status="${m.status === 'open' ? 'suspended' : 'open'}">${
                  m.status === 'open' ? 'Suspend' : 'Restore'
                }</button>
                 <button class="btn sm primary" data-settle="${attr(m.id)}">Settle</button>`
          }</td>
        </tr>`
          )
          .join('') +
        '</tbody></table>';

      body.querySelectorAll('[data-toggle]').forEach((b) => {
        b.onclick = async () => {
          // A reason, before anything is written. This route DOES audit
          // `body.reason || null`, and it was always null in practice: the
          // desk could suspend a USER with a justification and could not
          // suspend a market with one. server.js enforces no minimum length
          // here, so this dialog is the only place the requirement exists —
          // which is why it refuses an empty answer rather than sending a
          // blank and losing it again.
          const suspending = b.dataset.status === 'suspended';
          const reason = await askReason(`${suspending ? 'Suspending' : 'Restoring'} this market`);
          if (!reason) return;
          b.disabled = true;
          try {
            await api('PATCH', `/api/admin/markets/${b.dataset.toggle}`, {
              status: b.dataset.status,
              reason,
            });
            toast('Market ' + b.dataset.status);
            renderMarketsView();
            refreshAll();
          } catch (e) {
            toast(e.message, 'err');
            b.disabled = false;
          }
        };
      });
      body.querySelectorAll('[data-settle]').forEach((b) => {
        b.onclick = () => settleDialog(b.dataset.settle);
      });
    } catch (e) {
      if (OB.isCurrent('adminBody', seq) && document.getElementById('adminBody') === body) {
        body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      }
    }
  }

  // Overround is the desk's margin/arb signal: positive = margined,
  // negative = the runners can all be backed for a guaranteed profit.
  function overroundCell(v) {
    if (v === null || v === undefined) return '<span class="muted" title="a runner has no available price">–</span>';
    const pct = (v * 100).toFixed(2) + '%';
    if (v < -0.001) return `<span class="win" title="arbitrage available">${pct}</span>`;
    if (v > 0.001) return `<span class="muted" title="margined">${pct}</span>`;
    return '<span class="muted" title="fair">0.00%</span>';
  }

  // How long a settlement justification must be before the desk will settle
  // anything. A DESK POLICY, not a server rule: the settle route records
  // `body.reason || null` and enforces no length at all. It matches the
  // held-release route, where lib/results.js does refuse under five — so the
  // two operator actions that decide disputed money ask for the same thing.
  const MIN_SETTLE_REASON = 5;

  async function settleDialog(marketId) {
    let book;
    let market;
    let desk = null;
    try {
      const r = await api('GET', `/api/markets/${marketId}/book`);
      book = r.book;
      market = r.market;
    } catch (e) {
      return toast(e.message, 'err');
    }
    // NAME THE MARKET. The title used to be `Settle ${market.name}` — and a
    // market's name in this catalogue is literally "Winner", so the most
    // consequential dialog in the product was titled "Settle Winner" and named
    // an event, an outcome, a price, a volume and a number of affected
    // accounts: nothing. The event name and the desk's own view of the market
    // come from /api/admin/stats, which the markets table was just rendered
    // from, so this is the same source rather than a second opinion.
    try {
      const stats = await api('GET', '/api/admin/stats');
      desk = (stats.markets || []).find((m) => Number(m.id) === Number(marketId)) || null;
    } catch {
      desk = null; // a title is worth having; a dialog is not worth refusing over one
    }
    const eventName = (desk && desk.event_name) || `event ${market.event_id}`;
    const title = `Settle ${OB.esc(eventName)} — ${OB.esc(market.name)}`;
    // How much money this decision moves, and how many runners it moves it for.
    const matched = (desk && desk.total_matched_cents) || market.total_matched_cents || 0;
    const facts =
      `<div class="sd-facts">` +
      `<span><span class="muted">Matched</span> <strong>${fmt(matched)}</strong></span>` +
      `<span><span class="muted">Runners</span> <strong>${book.length}</strong></span>` +
      `<span><span class="muted">State</span> <strong>${OB.esc(market.status)}</strong></span>` +
      (market.settled_at ? `<span><span class="muted">Settled</span> <strong>${OB.esc(market.settled_at)}</strong></span>` : '') +
      `</div>`;
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    // S4: a real dialog. It registers on app.js's overlay stack, so Escape
    // closes THIS dialog (the global handler routes through the topmost
    // overlay — it used to only know #authModal), Tab stays inside it, and
    // focus returns to the button that opened it.
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `Settle ${eventName} — ${market.name}`);
    overlay.innerHTML = `
      <div class="box">
        <h3 id="sdTitle">${title}</h3>
        ${facts}
        <p class="muted hint">${
          // W6: whenText(market.settled_at) is ALWAYS truthy ('—' for null),
          // which hid the instruction on the desk's most consequential dialog.
          market.settled_at ? '' : 'Pick the winning runner, or void the market (everyone is refunded).'
        }</p>
        <div id="sdWinners" role="group" aria-label="Winning runner">
          ${book
            .map((s) => {
              // A runner that has never traded used to show "LTP —" and nothing
              // else, so every radio in a fresh market read as the same blank
              // row. Where there is no last trade, the ladder's own best prices
              // are what the operator is actually choosing between.
              const bestBack = s.back && s.back.length ? OB.price2(s.back[0].price) : null;
              const bestLay = s.lay && s.lay.length ? OB.price2(s.lay[0].price) : null;
              const priced =
                s.ltp != null
                  ? `LTP ${OB.price2(s.ltp)}`
                  : bestBack || bestLay
                    ? `no trades yet · best back ${bestBack || '—'} · best lay ${bestLay || '—'}`
                    : 'no trades yet · no prices on the book';
              return `<label class="optrow"><input type="radio" name="winner" value="${attr(s.selection_id)}" /> ${esc(
                s.name
              )} <span class="muted tn">${esc(priced)}</span></label>`;
            })
            .join('')}
        </div>
        <label class="optrow"><input type="checkbox" id="sdVoid" /> Void market (refund all stakes)</label>
        <label class="fieldlabel" for="sdReason">Reason (recorded in the audit log)</label>
        <input id="sdReason" type="text" autocomplete="off" placeholder="why this result, in one line" />
        <div class="row mt">
          <button class="btn primary grow" id="sdGo">Settle</button>
          <button class="btn" id="sdCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    openOverlay(overlay); // Escape + focus trap + focus return, via the stack
    const close = () => closeOverlay(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#sdCancel').onclick = close;
    overlay.querySelector('#sdVoid').onchange = (e) => {
      overlay.querySelectorAll('input[name="winner"]').forEach((r) => {
        r.disabled = e.target.checked;
      });
    };
    overlay.querySelector('#sdGo').onclick = async () => {
      const isVoid = overlay.querySelector('#sdVoid').checked;
      const winner = overlay.querySelector('input[name="winner"]:checked');
      if (!isVoid && !winner) return toast('Pick a winner or void the market', 'err');
      // THE REASON. server.js calls settlement "moves the most money of any
      // operator action" and audits `body.reason || null` — always absent in
      // practice, because the dialog had nowhere to put one. A settlement later
      // disputed therefore had a winner and no why. The route accepts the field
      // and records it; it enforces no minimum length here, so this floor is a
      // DESK POLICY mirroring the held-release route (lib/results.js refuses
      // under five), not a control the server backstops. Read it here, send it,
      // and the audit row carries it either way.
      const reason = (overlay.querySelector('#sdReason').value || '').trim();
      if (reason.length < MIN_SETTLE_REASON) {
        return toast(`A reason of at least ${MIN_SETTLE_REASON} characters is required`, 'err');
      }
      const go = overlay.querySelector('#sdGo');
      go.disabled = true;
      try {
        const r = await api(
          'POST',
          `/api/admin/markets/${marketId}/settle`,
          isVoid
            ? { void: true, reason }
            : { winner_selection_id: Number(winner.value), reason }
        );
        const fees = r.per_user.reduce((a, u) => a + u.commission_cents, 0);
        toast(`Settled ${r.per_user.length} position(s) · commission ${fmt(fees)}`);
        close();
        renderMarketsView();
        refreshAll();
      } catch (e) {
        toast(e.message, 'err');
        go.disabled = false;
      }
    };
  }

  // ── create form ─────────────────────────────────────────────────────────
  async function renderCreateView() {
    const seq = OB.beginLoad('adminBody');
    const body = document.getElementById('adminBody');
    body.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const sports = (await api('GET', '/api/sports')).sports;
      const events = (await api('GET', '/api/events')).events;
      if (!OB.isCurrent('adminBody', seq) || document.getElementById('adminBody') !== body) return;
      const sportOpts = sports.map((s) => `<option value="${attr(s.id)}">${esc(s.name)}</option>`).join('');
      const eventOpts = events.map((e) => `<option value="${attr(e.id)}">${esc(e.name)}</option>`).join('');
      const marketOpts = events
        .filter((e) => e.markets.length)
        .map((e) => `<optgroup label="${esc(e.name)}">${e.markets.map((m) => `<option value="${attr(m.id)}">${esc(m.name)}</option>`).join('')}</optgroup>`)
        .join('');
      body.innerHTML = `
        <div class="creategrid">
          <form class="card" data-f="sport">
            <h3>Sport</h3>
            <label>Name</label><input name="name" placeholder="Football" />
            <button class="btn primary" type="submit">Create</button>
          </form>
          <form class="card" data-f="comp">
            <h3>Competition</h3>
            <label>Sport</label><select name="sport_id">${sportOpts}</select>
            <label>Name</label><input name="name" placeholder="Premier League" />
            <label>Country</label><input name="country" placeholder="ENG" />
            <button class="btn primary" type="submit">Create</button>
          </form>
          <form class="card" data-f="event">
            <h3>Event</h3>
            <label>Sport</label><select name="sport_id">${sportOpts}</select>
            <label>Competition</label><select name="competition_id" data-comps><option value="">—</option></select>
            <label>Name</label><input name="name" placeholder="Arsenal vs Chelsea" />
            <label>Starts (UTC)</label><input name="starts_at" type="datetime-local" />
            <button class="btn primary" type="submit">Create</button>
          </form>
          <form class="card" data-f="market">
            <h3>Market</h3>
            <label>Event</label><select name="event_id">${eventOpts}</select>
            <label>Name</label><input name="name" placeholder="Match Odds" />
            <button class="btn primary" type="submit">Create</button>
          </form>
          <form class="card" data-f="sel">
            <h3>Selection</h3>
            <label>Market</label><select name="market_id">${marketOpts}</select>
            <label>Name</label><input name="name" placeholder="Arsenal" />
            <label>Fair price</label><input name="fair_price" type="number" step="0.01" min="1.01" max="1000" placeholder="2.40" data-fair />
            <div class="muted fnote" data-fairnote>American / fractional / implied from the server</div>
            <button class="btn primary" type="submit">Create</button>
          </form>
        </div>
        <p class="muted">Creating a selection with a fair price makes the bot quote ladders around it (when bots are enabled).</p>`;

      // Fair-price helper: the conversions come from lib/odds.js via the API,
      // so the desk never shows a number the engine would not agree with.
      const fair = body.querySelector('[data-fair]');
      const note = body.querySelector('[data-fairnote]');
      let noteSeq = 0;
      fair.onchange = async () => {
        const raw = fair.value.trim();
        if (raw === '') {
          note.textContent = 'American / fractional / implied from the server';
          return;
        }
        const seq = ++noteSeq;
        try {
          const r = await api('GET', `/api/format/${encodeURIComponent(raw)}`);
          if (seq !== noteSeq) return; // a newer keystroke already answered
          note.innerHTML =
            `<strong>${esc(r.american)}</strong> · ${esc(r.fractional)} · implied ${(r.implied_prob * 100).toFixed(1)}%` +
            (Math.abs(r.decimal - Number(raw)) > 1e-9 ? ` <span class="muted">(snaps to ${price2(r.decimal)})</span>` : '');
        } catch (e) {
          if (seq === noteSeq) note.textContent = e.message;
        }
      };

      // competition dropdown follows the chosen sport
      const evtForm = body.querySelector('form[data-f="event"]');
      const compSel = evtForm.querySelector('[name="competition_id"]');
      // Its own mount point: picking two sports in quick succession must not let
      // the slower first response fill the dropdown for the second.
      let compSeq = 0;
      evtForm.querySelector('[name="sport_id"]').onchange = async (e) => {
        const sid = e.target.value;
        const seq = ++compSeq;
        if (!sid) {
          compSel.innerHTML = '<option value="">—</option>';
          return;
        }
        try {
          const { competitions } = await api('GET', `/api/admin/competitions?sport_id=${encodeURIComponent(sid)}`);
          if (seq !== compSeq || !compSel.isConnected) return;
          compSel.innerHTML = '<option value="">—</option>' + competitions.map((c) => `<option value="${attr(c.id)}">${esc(c.name)}</option>`).join('');
        } catch {
          if (seq === compSeq && compSel.isConnected) compSel.innerHTML = '<option value="">—</option>';
        }
      };

      body.querySelectorAll('form[data-f]').forEach((form) => {
        form.onsubmit = async (ev) => {
          ev.preventDefault();
          const btn = form.querySelector('button');
          const get = (n) => {
            const el = form.querySelector(`[name="${n}"]`);
            return el ? el.value.trim() : '';
          };
          const kind = form.dataset.f;
          const payload = {};
          try {
            if (kind === 'sport') payload.name = get('name');
            if (kind === 'comp') {
              payload.sport_id = Number(get('sport_id'));
              payload.name = get('name');
              payload.country = get('country') || null;
            }
            if (kind === 'event') {
              payload.sport_id = Number(get('sport_id'));
              payload.competition_id = get('competition_id') ? Number(get('competition_id')) : null;
              payload.name = get('name');
              payload.starts_at = get('starts_at').replace('T', ' ');
            }
            if (kind === 'market') {
              payload.event_id = Number(get('event_id'));
              payload.name = get('name');
            }
            if (kind === 'sel') {
              payload.market_id = Number(get('market_id'));
              payload.name = get('name');
              const fp = get('fair_price');
              payload.fair_price = fp === '' ? null : Number(fp);
            }
            btn.disabled = true;
            const path = {
              sport: '/api/admin/sports',
              comp: '/api/admin/competitions',
              event: '/api/admin/events',
              market: '/api/admin/markets',
              sel: '/api/admin/selections',
            }[kind];
            await api('POST', path, payload);
            toast(`${kind} created`);
            form.reset();
            renderCreateView();
            refreshAll();
          } catch (e) {
            toast(e.message, 'err');
          }
          btn.disabled = false;
        };
      });
    } catch (e) {
      if (OB.isCurrent('adminBody', seq) && document.getElementById('adminBody') === body) {
        body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      }
    }
  }

  window.OBAdmin = { render };
})();
