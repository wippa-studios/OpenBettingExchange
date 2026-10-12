// slip.js — the bet slip
(() => {
  'use strict';

  const OB = window.OB;
  if (!OB) { console.error('[slip] window.OB missing — core.js must load first'); return; }

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

  // ── bet slip ─────────────────────────────────────────────────────────────
  function addToSlip(item) {
    // FEED GATE (removable — see bindLadder): defense in depth. The ladder
    // attaches no handlers in feed mode, but nothing else may ever build a
    // slip row the exchange is guaranteed to reject.
    if (OB.state.feedMode) {
      OB.toast('Feed markets are display-only', 'err');
      return;
    }
    // Identity = (market_id, selection_id, side). Feed selection ids are only
    // unique WITHIN a market (every soccer 1X2 market reuses 58805 for "The
    // Draw"), so keying on (selection_id, side) made clicking the same side
    // in a second race silently REMOVE the first. (W3)
    const at = OB.state.slip.findIndex(
      (x) =>
        String(x.market_id) === String(item.market_id) &&
        String(x.selection_id) === String(item.selection_id) &&
        x.side === item.side
    );
    if (at >= 0) {
      OB.state.slip.splice(at, 1);
    } else {
      if (OB.state.slip.length >= 10) {
        OB.toast('Slip is full (10 selections max)', 'err');
        return;
      }
      OB.state.slip.push(Object.assign({ stake_cents: 1000 }, item));
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
    const exposure = OB.Ladder.exposureCents(it.price, it.stake_cents);
    const detail =
      it.side === 'back'
        ? `<span class="muted">Profit</span> ${OB.fmt(exposure)} · <span class="muted">Return</span> ${OB.fmt(it.stake_cents + exposure)}`
        : `<span class="muted">Liability</span> ${OB.fmt(exposure)} · <span class="muted">Return</span> ${OB.fmt(it.stake_cents + exposure)}`;
    // W1: data-* markers carry NO values. The old `data-rm="ROW"` sentinel was
    // string-replaced per row index — which also corrupted any runner NAME
    // containing "ROW" ("ARROWTOWN RC" → "AR0TOWN RC"), and the replaced
    // values were never read anyway. Identity comes from the row's data-row;
    // the handlers are delegated (bindSlip), so nothing rebinds per row.
    return `<div class="sliphead">
            <div>
              <span class="side ${OB.esc(it.side)}">${OB.esc(it.side.toUpperCase())}</span>
              <strong>${OB.esc(it.selection_name)}</strong>
              <span class="tn">@ ${OB.price2(it.price)}</span>
              <div class="muted ellipsis">${OB.esc(it.event_name)} · ${OB.esc(it.market_name)}</div>
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
                <input class="tn" data-price value="${OB.price2(it.price)}" />
                <button type="button" class="btn sm" data-tick data-dir="1">+</button>
              </div>
            </div>
          </div>
          <div class="prev tn">${detail}</div>
          <button type="button" class="btn primary place" data-place>Place ${OB.fmt(it.stake_cents)}</button>`;
  }

  // Update ONE row's derived values in place — never restructure the row.
  // Rebuilding a row detaches the focused input, which fires blur -> change
  // and re-enters this function while the DOM is being mutated (Chromium then
  // reports "removeChild: the node to be removed is no longer a child").
  // Writing only text/values also keeps focus while the user types.
  function slipDetailText(it) {
    const exposure = OB.Ladder.exposureCents(it.price, it.stake_cents);
    const label = it.side === 'back' ? 'Profit' : 'Liability';
    return `${label} ${OB.fmt(exposure)} · Return ${OB.fmt(it.stake_cents + exposure)}`;
  }

  function updateSlipRow(i) {
    const row = document.querySelector(`.sliprow[data-row="${i}"]`);
    const it = OB.state.slip[i];
    if (!row || !it) return;
    const priceInput = row.querySelector('[data-price]');
    // Never fight the user for the field they are typing in.
    if (priceInput && document.activeElement !== priceInput) priceInput.value = OB.price2(it.price);
    const headPrice = row.querySelector('.sliphead .tn');
    if (headPrice) headPrice.textContent = `@ ${OB.price2(it.price)}`;
    const prev = row.querySelector('.prev');
    if (prev) prev.textContent = slipDetailText(it);
    const place = row.querySelector('[data-place]');
    if (place) place.textContent = `Place ${OB.fmt(it.stake_cents)}`;
    const stakeInput = row.querySelector('[data-stake]');
    if (stakeInput && document.activeElement !== stakeInput) stakeInput.value = (it.stake_cents / 100).toFixed(2);
  }

  // Slip events are DELEGATED from #slipBody (bound once in boot), keyed off
  // each row's data-row — so re-rendering the slip never rebinds anything,
  // and there is no per-row handler to go stale. (W1)
  function bindSlip() {
    const body = OB.$('slipBody');
    body.addEventListener('click', (e) => {
      const row = e.target.closest('.sliprow');
      if (!row) return;
      const i = Number(row.dataset.row);
      const it = OB.state.slip[i];
      if (!it) return;
      if (e.target.closest('[data-rm]')) {
        OB.state.slip.splice(i, 1);
        renderSlip();
        return;
      }
      const tick = e.target.closest('[data-tick]');
      if (tick) {
        it.price = OB.Ladder.stepPrice(it.price, Number(tick.dataset.dir));
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
      const it = OB.state.slip[i];
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
          OB.toast('Enter a valid price', 'err');
          updateSlipRow(i);
          return;
        }
        it.price = OB.Ladder.snapPrice(parsed);
        updateSlipRow(i);
      }
    });
  }

  function renderSlip() {
    const wrap = OB.el('slip');
    const body = OB.el('slipBody');
    if (!wrap || !body) return;
    if (!OB.state.slip.length) {
      wrap.hidden = true;
      body.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    body.innerHTML = OB.state.slip
      .map((it, i) => `<div class="sliprow" data-row="${i}">${slipRowHtml(it)}</div>`)
      .join('');
  }

  async function placeOne(i, btn) {
    const it = OB.state.slip[i];
    if (!it) return;
    btn.disabled = true;
    btn.textContent = 'Placing…';
    try {
      const r = await OB.api('POST', '/api/orders', {
        selection_id: it.selection_id,
        side: it.side,
        price: it.price,
        stake_cents: it.stake_cents,
      });
      const matched = r.fills.reduce((a, f) => a + f.stake_cents, 0);
      const resting = r.order.stake_cents - r.order.matched_cents;
      if (matched > 0 && resting === 0) OB.toast(`Matched ${OB.fmt(matched)} @ ${OB.price2(r.fills[0].price)}`);
      else if (matched > 0) OB.toast(`Matched ${OB.fmt(matched)} · ${OB.fmt(resting)} resting @ ${OB.price2(r.order.price)}`);
      else OB.toast(`Resting ${OB.fmt(r.order.stake_cents)} @ ${OB.price2(r.order.price)}`);
      OB.state.slip.splice(i, 1);
      renderSlip();
      OB.refreshMe();
      // Feed-aware board refresh — loadEvents() is the seeded loader and
      // updated nothing in feed mode. (W4)
      OB.refreshMarkets();
    } catch (e) {
      OB.toast(e.message, 'err');
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }


  Object.assign(OB, { addToSlip, bindSlip, placeOne, renderSlip, slipDetailText, slipRowHtml, updateSlipRow });
})();
