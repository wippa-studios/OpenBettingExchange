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
        </div>
        <div id="adminBody"></div>
      </div>`;
    page.querySelectorAll('[data-view]').forEach((b) => {
      b.onclick = () => {
        page.querySelectorAll('[data-view]').forEach((x) => x.classList.remove('primary'));
        b.classList.add('primary');
        if (b.dataset.view === 'markets') renderMarketsView();
        else if (b.dataset.view === 'users') renderUsersView();
        else if (b.dataset.view === 'audit') renderAuditView();
        else renderCreateView();
      };
    });
    renderMarketsView();
  }

  // ── accounts ──────────────────────────────────────────────────────────────
  // Every mutating control below is gated server-side too (reason required,
  // self-actions refused, last-admin protected). The prompts here exist so the
  // operator is told WHY at the point of action rather than after a 400.
  function askReason(what) {
    const reason = window.prompt(`${what}\n\nReason (recorded in the audit log):`);
    if (reason === null) return null;
    const trimmed = reason.trim();
    return trimmed ? trimmed : null;
  }

  async function renderUsersView(q) {
    const body = document.getElementById('adminBody');
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    body.innerHTML = '<div class="empty">Loading…</div>';
    let data;
    try {
      data = await api('GET', '/api/admin/users?' + params.toString());
    } catch (e) {
      body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }

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
          const raw = window.prompt('Adjustment in dollars (negative to claw back):');
          if (raw === null) return;
          const dollars = Number(raw);
          if (!Number.isFinite(dollars) || dollars === 0) return toast('Enter a non-zero amount', 'err');
          const cents = Math.round(dollars * 100);
          reason = askReason('Adjusting a balance');
          if (!reason) return;
          body_ = { delta_cents: cents, reason };
        } else if (act === 'suspend' || act === 'reinstate') {
          reason = askReason(act === 'suspend' ? 'Suspending an account' : 'Reinstating an account');
          if (!reason) return;
          body_ = { status: act === 'suspend' ? 'suspended' : 'active', reason };
        } else if (act === 'promote' || act === 'demote') {
          reason = askReason(act === 'promote' ? 'Granting admin' : 'Revoking admin');
          if (!reason) return;
          body_ = { role: act === 'promote' ? 'admin' : 'user', reason };
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
      </td>
    </tr>`;
  }

  // ── audit trail ───────────────────────────────────────────────────────────
  async function renderAuditView(target) {
    const body = document.getElementById('adminBody');
    body.innerHTML = '<div class="empty">Loading…</div>';
    let entries;
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (target) params.set('target', target);
      entries = (await api('GET', '/api/admin/audit?' + params.toString())).entries;
    } catch (e) {
      body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
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
          <td class="muted fineprint">${auditChange(e)}</td>
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
    const body = document.getElementById('adminBody');
    body.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const { markets } = await api('GET', '/api/admin/stats');
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
          b.disabled = true;
          try {
            await api('PATCH', `/api/admin/markets/${b.dataset.toggle}`, { status: b.dataset.status });
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
      body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
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

  async function settleDialog(marketId) {
    let book;
    let market;
    try {
      const r = await api('GET', `/api/markets/${marketId}/book`);
      book = r.book;
      market = r.market;
    } catch (e) {
      return toast(e.message, 'err');
    }
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    // S4: a real dialog. It registers on app.js's overlay stack, so Escape
    // closes THIS dialog (the global handler routes through the topmost
    // overlay — it used to only know #authModal), Tab stays inside it, and
    // focus returns to the button that opened it.
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="box">
        <h3 id="sdTitle">Settle ${esc(market.name)}</h3>
        <p class="muted hint">${
          // W6: whenText(market.settled_at) is ALWAYS truthy ('—' for null),
          // which hid the instruction on the desk's most consequential dialog.
          market.settled_at ? '' : 'Pick the winning runner, or void the market (everyone is refunded).'
        }</p>
        <div id="sdWinners" role="group" aria-label="Winning runner">
          ${book
            .map(
              (s) => `<label class="optrow"><input type="radio" name="winner" value="${attr(s.selection_id)}" /> ${esc(
                s.name
              )} <span class="muted tn">LTP ${price2(s.ltp)}</span></label>`
            )
            .join('')}
        </div>
        <label class="optrow"><input type="checkbox" id="sdVoid" /> Void market (refund all stakes)</label>
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
      const go = overlay.querySelector('#sdGo');
      go.disabled = true;
      try {
        const r = await api('POST', `/api/admin/markets/${marketId}/settle`, isVoid ? { void: true } : { winner_selection_id: Number(winner.value) });
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
    const body = document.getElementById('adminBody');
    body.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const sports = (await api('GET', '/api/sports')).sports;
      const events = (await api('GET', '/api/events')).events;
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
      evtForm.querySelector('[name="sport_id"]').onchange = async (e) => {
        const sid = e.target.value;
        if (!sid) {
          compSel.innerHTML = '<option value="">—</option>';
          return;
        }
        try {
          const { competitions } = await api('GET', `/api/admin/competitions?sport_id=${encodeURIComponent(sid)}`);
          compSel.innerHTML = '<option value="">—</option>' + competitions.map((c) => `<option value="${attr(c.id)}">${esc(c.name)}</option>`).join('');
        } catch {
          compSel.innerHTML = '<option value="">—</option>';
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
      body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  window.OBAdmin = { render };
})();
