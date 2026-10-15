// views.js — my bets, wallet
(() => {
  'use strict';

  const OB = window.OB;
  if (!OB) { console.error('[views] window.OB missing — core.js must load first'); return; }

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

  // ── my bets ──────────────────────────────────────────────────────────────
  function renderBets() {
    const page = OB.el('page');
    if (!page) return;
    if (!OB.state.user) {
      page.innerHTML =
        '<div class="card"><div class="empty">Sign in to see your orders, positions and history.</div>' +
        '<div class="row center"><button class="btn primary" id="betsSignin">Sign in</button></div></div>';
      OB.$('betsSignin').onclick = () => OB.openAuth('login');
      return;
    }
    page.innerHTML = `<div class="card">
      <div class="tabs">
        <button class="btn sm ${OB.state.betsTab === 'open' ? 'primary' : ''}" data-tab="open">Open orders</button>
        <button class="btn sm ${OB.state.betsTab === 'positions' ? 'primary' : ''}" data-tab="positions">Positions</button>
        <button class="btn sm ${OB.state.betsTab === 'settled' ? 'primary' : ''}" data-tab="settled">Settled</button>
      </div>
      <div id="betsBody"><div class="empty">Loading…</div></div>
    </div>`;
    OB.qa('[data-tab]', page).forEach((b) => {
      b.onclick = () => {
        OB.state.betsTab = b.dataset.tab;
        renderBets();
      };
    });
    if (OB.state.betsTab === 'open') loadOpenOrders();
    else if (OB.state.betsTab === 'positions') loadPositions();
    else loadSettled();
  }

  // All three loaders below render into #betsBody and therefore share ONE
  // sequence token: they are alternatives writing the same mount, so a stale
  // loadPositions must not be allowed to overwrite a fresh loadOpenOrders.
  async function loadOpenOrders() {
    const seq = OB.beginLoad('betsBody');
    if (!OB.el('betsBody')) return; // navigated away mid-flight
    try {
      const { orders } = await OB.api('GET', '/api/orders');
      // The existence check below only detects PAGE navigation; switching tabs
      // re-creates #betsBody, so a slow load passes it and overwrites the newer
      // tab. The token is what actually orders the renders.
      if (!OB.isCurrent('betsBody', seq)) return;
      const body = OB.el('betsBody');
      if (!body) return; // tab changed while the request was in flight
      if (!orders.length) {
        OB.setHtml(body, '<div class="empty">No unmatched orders</div>');
        return;
      }
      OB.setHtml(body,
        '<table><thead><tr><th>Event</th><th>Selection</th><th>Side</th><th>Price</th><th>Unmatched</th><th>Placed</th><th></th></tr></thead><tbody>' +
        orders
          .map(
            (o) => `<tr>
          <td>${OB.esc(o.event_name)}<div class="muted">${OB.esc(o.market_name)}</div></td>
          <td>${OB.esc(o.selection_name)}</td>
          <td class="side ${OB.esc(o.side)}">${OB.esc(o.side.toUpperCase())}</td>
          <td class="tn">${OB.price2(o.price)}</td>
          <td class="tn">${OB.fmt(o.stake_cents - o.matched_cents)}</td>
          <td class="muted">${OB.whenText(o.placed_at)}</td>
          <td><button class="btn sm red" data-cancel="${OB.attr(o.id)}">Cancel</button></td>
        </tr>`
          )
          .join('') +
        '</tbody></table>');
      OB.qa('[data-cancel]', body).forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try {
            await OB.api('POST', `/api/orders/${b.dataset.cancel}/cancel`);
            OB.toast('Order cancelled');
            loadOpenOrders();
            OB.refreshMe();
          } catch (e) {
            OB.toast(e.message, 'err');
            b.disabled = false;
          }
        };
      });
    } catch (e) {
      if (OB.isCurrent('betsBody', seq)) OB.setHtml(OB.el('betsBody'), `<div class="empty">${OB.esc(e.message)}</div>`);
    }
  }

  async function loadPositions() {
    const seq = OB.beginLoad('betsBody');
    if (!OB.el('betsBody')) return; // navigated away mid-flight
    try {
      const { positions } = await OB.api('GET', '/api/positions');
      if (!OB.isCurrent('betsBody', seq)) return;
      const body = OB.el('betsBody');
      if (!body) return; // tab changed while the request was in flight
      if (!positions.length) {
        OB.setHtml(body, '<div class="empty">No matched positions</div>');
        return;
      }
      OB.setHtml(body, positions
        .map((p) => {
          const live = p.selections.filter(
            (s) => s.my_back_stake_cents || s.my_lay_stake_cents || s.frozen_cents
          );
          const legs = live
            .map(
              (s) => `<tr>
                <td>${OB.esc(s.name)}</td>
                <td class="tn">${s.my_back_stake_cents ? OB.fmt(s.my_back_stake_cents) : '—'}</td>
                <td class="tn">${s.my_lay_stake_cents ? OB.fmt(s.my_lay_stake_cents) : '—'}</td>
              </tr>`
            )
            .join('');
          // ONE escrow figure, for the position, instead of a per-leg column
          // that repeated the Backed column.
          //
          // The table used to end BACKED | LAID | FROZEN, and for any back-only
          // leg lib/match.js's escrowFor equals the stake — so every such row
          // printed the same number twice (`$50.51 / — / $50.51`) and the third
          // column read as "Frozen is a word a bettor will take to mean staked",
          // when it is the collateral held against the whole position. That is
          // the number a player actually wants ("how much of my money is tied
          // up"), and it is a property of the position rather than of a leg, so
          // it belongs beside the position's own name.
          const frozen = p.selections.reduce((a, s) => a + (Number(s.frozen_cents) || 0), 0);
          const frozenNote = frozen ? ` · escrow held <span class="tn">${OB.fmt(frozen)}</span>` : '';
          const matrix = p.pnl_if_win
            .map(
              (w) =>
                `<span class="pnlchip ${w.pnl_cents >= 0 ? 'win' : 'loss'}">${OB.esc(w.name)} ${OB.signed(w.pnl_cents)}</span>`
            )
            .join('');
          const cash =
            p.cashout != null
              ? `<button class="btn green" data-cashout="${OB.attr(p.market_id)}" title="Cash out ${OB.signed(
                  p.cashout.fair_value_cents
                )} fair value less ${OB.esc(String(p.cashout.margin_bps))}bps margin">Cash out ${OB.signed(
                  p.cashout.value_cents
                )}</button>`
              : '<span class="muted">Cash out unavailable</span>';
          return `<div class="poscard">
            <div class="poshead">
              <div><strong>${OB.esc(p.market_name)}</strong> <span class="chip ${OB.esc(p.market_status)}">${OB.esc(
            p.market_status
          )}</span></div>
              <div class="muted">${OB.esc(p.event_name)}${frozenNote}</div>
            </div>
            <table><thead><tr><th>Selection</th><th>Backed</th><th>Laid</th></tr></thead><tbody>${legs}</tbody></table>
            <div class="pnlrow">${matrix}</div>
            <div>${cash}</div>
          </div>`;
        })
        .join(''));
      OB.qa('[data-cashout]', body).forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try {
            const r = await OB.api('POST', `/api/markets/${b.dataset.cashout}/cashout`);
            OB.toast(`Cashed out ${OB.signed(r.value_cents)}`);
            loadPositions();
            OB.refreshMe();
            // Feed-aware board refresh (W4): loadEvents() updated nothing in
            // feed mode, so the ladder stayed stale after a cash-out.
            OB.refreshMarkets();
          } catch (e) {
            OB.toast(e.message, 'err');
            b.disabled = false;
          }
        };
      });
    } catch (e) {
      if (OB.isCurrent('betsBody', seq)) OB.setHtml(OB.el('betsBody'), `<div class="empty">${OB.esc(e.message)}</div>`);
    }
  }

  async function loadSettled() {
    const seq = OB.beginLoad('betsBody');
    if (!OB.el('betsBody')) return; // navigated away mid-flight
    try {
      const { settlements } = await OB.api('GET', '/api/settlements');
      if (!OB.isCurrent('betsBody', seq)) return;
      const body = OB.el('betsBody');
      if (!body) return; // tab changed while the request was in flight
      if (!settlements.length) {
        OB.setHtml(body, '<div class="empty">No settled markets yet</div>');
        return;
      }
      OB.setHtml(body,
        '<table><thead><tr><th>Event</th><th>Market</th><th>Result</th><th>P&amp;L</th><th>Commission</th><th>When</th></tr></thead><tbody>' +
        settlements
          .map(
            (s) => `<tr>
          <td>${OB.esc(s.event_name)}</td>
          <td>${OB.esc(s.market_name)}</td>
          <td>${OB.esc(s.selection_name || 'Void')}</td>
          <td class="tn ${s.pnl_cents >= 0 ? 'win' : 'loss'}">${OB.signed(s.pnl_cents)}</td>
          <td class="tn muted">${OB.fmt(s.commission_cents)}</td>
          <td class="muted">${OB.whenText(s.at)}</td>
        </tr>`
          )
          .join('') +
        '</tbody></table>');
    } catch (e) {
      if (OB.isCurrent('betsBody', seq)) OB.setHtml(OB.el('betsBody'), `<div class="empty">${OB.esc(e.message)}</div>`);
    }
  }

  // ── wallet ───────────────────────────────────────────────────────────────
  function renderWallet() {
    const page = OB.el('page');
    if (!page) return;
    if (!OB.state.user) {
      page.innerHTML =
        '<div class="card"><div class="empty">Sign in to use the wallet.</div>' +
        '<div class="row center"><button class="btn primary" id="walSignin">Sign in</button></div></div>';
      OB.$('walSignin').onclick = () => OB.openAuth('login');
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
    OB.qa('[data-dep]', page).forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await OB.api('POST', '/api/wallet/deposit', { amount_cents: Number(b.dataset.dep) });
          OB.toast(`Added ${OB.fmt(Number(b.dataset.dep))} play money`);
          loadWallet();
          OB.refreshMe();
        } catch (e) {
          OB.toast(e.message, 'err');
        }
        b.disabled = false;
      };
    });
    loadWallet();
  }

  // One token for the WHOLE wallet render: the three balance figures and the
  // transaction table are a single snapshot, and half of one is a wrong answer.
  // Two SSE `balance` events fire two of these, so the race is routine.
  async function loadWallet() {
    const seq = OB.beginLoad('wTx');
    if (!OB.el('wTx')) return; // navigated away mid-flight
    try {
      const w = await OB.api('GET', '/api/wallet');
      if (!OB.isCurrent('wTx', seq)) return;
      const balEl = OB.el('wBal');
      if (!balEl || !OB.el('wTx')) return; // left the wallet page mid-flight
      balEl.textContent = OB.fmt(w.balance_cents);
      OB.el('wAvail').textContent = OB.fmt(w.available_cents);
      OB.el('wFroz').textContent = OB.fmt(w.frozen_cents);
      const tx = OB.el('wTx');
      if (!w.transactions.length) {
        OB.setHtml(tx, '<div class="empty">No transactions yet</div>');
        return;
      }
      const credits = ['deposit', 'settle', 'refund', 'release'];
      OB.setHtml(tx,
        // "Balance" in this column is the balance AFTER the row, while the
        // "Balance" figure at the top of the same screen is the total. Same
        // word, two meanings, one page — which is how a reader checks one
        // against the other and concludes the ledger is wrong.
        '<table><thead><tr><th>Type</th><th>Amount</th><th>Balance after</th><th>Frozen after</th><th>When</th></tr></thead><tbody>' +
        w.transactions
          .map((t) => {
            const isCredit = credits.indexOf(t.type) >= 0 && t.amount_cents >= 0;
            const cls = t.type === 'commission' || t.amount_cents < 0 ? 'loss' : isCredit ? 'win' : 'muted';
            const amt = t.type === 'escrow' || t.type === 'release' ? OB.fmt(Math.abs(t.amount_cents)) : OB.signed(t.amount_cents);
            return `<tr>
              <td>${OB.esc(t.type)}</td>
              <td class="tn ${cls}">${amt}</td>
              <td class="tn">${OB.fmt(t.balance_after)}</td>
              <td class="tn">${OB.fmt(t.frozen_after)}</td>
              <td class="muted">${OB.whenText(t.at)}</td>
            </tr>`;
          })
          .join('') +
        '</tbody></table>');
    } catch (e) {
      if (OB.isCurrent('wTx', seq)) OB.setHtml(OB.el('wTx'), `<div class="empty">${OB.esc(e.message)}</div>`);
    }
  }


  Object.assign(OB, { loadOpenOrders, loadPositions, loadSettled, loadWallet, renderBets, renderWallet });
})();
