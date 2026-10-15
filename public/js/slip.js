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

  // ── the engine's stake window ───────────────────────────────────────────
  // The engine refuses anything outside [MIN_STAKE_CENTS, MAX_STAKE_CENTS]
  // (lib/config.js, enforced in lib/match.js validateOrder; EXCHANGE_RULES
  // §"Placing an order" step 2 makes that the contract). The slip used to check
  // only `cents > 0`, so it happily built "Place $0.50" and "Place $2,000.00" —
  // both of which can only fail, with a 400, after the user presses Place.
  //
  // THESE ARE THE SERVER'S DEFAULTS AND THE ONLY COPY ON THE CLIENT. The
  // server publishes its live window on /api/me as `stake_bounds` and
  // refreshMe() hands it to setStakeBounds(), which replaces them — so a venue
  // that configures a different MIN/MAX_STAKE_CENTS gets a slip that agrees
  // with it rather than a second constant that drifts.
  OB.state.stakeBounds = { min_cents: 100, max_cents: 100000 };

  function stakeBounds() {
    return OB.state.stakeBounds || { min_cents: 100, max_cents: 100000 };
  }

  /**
   * Adopt the server's window. An unusable one is IGNORED rather than
   * half-applied: a bounds object missing an endpoint must never silently widen
   * or close what the slip will accept. Returns whether anything changed.
   */
  function setStakeBounds(bounds) {
    const min = Number(bounds && bounds.min_cents);
    const max = Number(bounds && bounds.max_cents);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max < min) return false;
    const prev = OB.state.stakeBounds;
    if (prev && prev.min_cents === min && prev.max_cents === max) return false;
    OB.state.stakeBounds = { min_cents: min, max_cents: max };
    // A window that MOVED can invalidate a row that was already typed, so the
    // whole slip is re-checked rather than only the rows that happen to be on
    // screen. Re-validating from stake_raw where there is one keeps the message
    // talking about the figure the user actually entered.
    for (const it of OB.state.slip) {
      it.stake_error = stakeError(it.stake_raw != null ? parseStakeCents(it.stake_raw) : it.stake_cents);
    }
    OB.renderSlip();
    return true;
  }

  /** Typed stake -> whole cents, or null when it is not an amount at all. */
  function parseStakeCents(raw) {
    const s = typeof raw === 'string' ? raw.trim() : raw;
    if (s === '' || s == null) return null;
    const dollars = parseFloat(s);
    if (!Number.isFinite(dollars)) return null;
    return Math.round(dollars * 100);
  }

  /**
   * null when the stake is placeable, or the reason it is not.
   *
   * The REASON is what the row shows. There is deliberately no fallback value:
   * substituting a stake the user never typed is the same failure mode as
   * silently clamping a price, and it leaves the input and the Place button
   * disagreeing about what is about to be sent.
   */
  function stakeError(cents) {
    const b = stakeBounds();
    if (cents === null) return 'Enter a stake, in dollars';
    if (cents < b.min_cents) return `Minimum stake is ${OB.fmt(b.min_cents)}`;
    if (cents > b.max_cents) return `Maximum stake is ${OB.fmt(b.max_cents)}`;
    return null;
  }

  // What the stake box shows. A rejected amount keeps the TEXT the user typed:
  // rewriting it to the last good value would leave the error message talking
  // about a number that is no longer on screen.
  function stakeInputValue(it) {
    if (it.stake_error && it.stake_raw != null) return String(it.stake_raw);
    return (it.stake_cents / 100).toFixed(2);
  }

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
    const b = stakeBounds();
    const err = it.stake_error;
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
              <input class="stake" data-stake type="number" min="${(b.min_cents / 100).toFixed(2)}" max="${(b.max_cents / 100).toFixed(2)}" step="0.01" value="${OB.esc(stakeInputValue(it))}" />
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
          ${err ? `<div class="stakeerr">${OB.esc(err)}</div>` : ''}
          <button type="button" class="btn primary place" data-place${err ? ' disabled' : ''}>${
            // The em-dash read as a truncated string rather than a disabled
            // control. The row already says why it cannot be placed, one line
            // above the button; the button says what it is.
            err ? 'Place' : `Place ${OB.fmt(it.stake_cents)}`
          }</button>`;
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
    if (place) {
      place.disabled = !!it.stake_error;
      place.textContent = it.stake_error ? 'Place' : `Place ${OB.fmt(it.stake_cents)}`;
    }
    // A rejected amount stays in the box; normalising it here would leave the
    // message referring to a figure that is no longer on screen.
    const stakeInput = row.querySelector('[data-stake]');
    if (stakeInput && document.activeElement !== stakeInput && !it.stake_error) {
      stakeInput.value = (it.stake_cents / 100).toFixed(2);
    }
    // The message is created and removed rather than rewritten, because
    // setHtml-style innerHTML on the ROW would detach the focused input.
    let err = row.querySelector('.stakeerr');
    if (it.stake_error) {
      if (!err) {
        err = document.createElement('div');
        err.className = 'stakeerr';
        if (place) row.insertBefore(err, place);
        else row.appendChild(err);
      }
      err.textContent = it.stake_error;
    } else if (err) {
      err.remove();
    }
  }

  // Remove a row BY IDENTITY, never by position.
  //
  // `OB.state.slip` is a mutable array the user can change for the whole
  // duration of any in-flight request: the × button, a re-add, a tick, a
  // cancel. An index captured before an `await` and spliced after it therefore
  // points at whatever row moved into that slot meanwhile — so pressing Place on
  // row 0 and then removing row 0 while the POST was in flight deleted row 1
  // instead, silently discarding a bet the user never placed and never cancelled.
  // Every removal in this file goes through here, so the rule has one home.
  function removeFromSlip(it) {
    const at = OB.state.slip.indexOf(it);
    if (at < 0) return false;
    OB.state.slip.splice(at, 1);
    renderSlip();
    return true;
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
        removeFromSlip(it);
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
        // Validate against the ENGINE's window, and never substitute a value the
        // user did not type: a rejected amount keeps the last good stake in
        // state, the typed text stays in the box, and the row says why.
        const raw = e.target.value;
        const cents = parseStakeCents(raw);
        const err = stakeError(cents);
        it.stake_raw = raw;
        it.stake_error = err;
        if (!err) it.stake_cents = cents;
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
    // `i` names the row on SCREEN; `it` is the bet. Only `it` may outlive this
    // function's await — see removeFromSlip for why a position cannot.
    const it = OB.state.slip[i];
    if (!it) return;
    // Defence in depth for the row's disabled Place button: a caller holding a
    // stale reference must not send a stake the engine will refuse. This is UX,
    // not a control — lib/match.js is the control.
    if (it.stake_error) {
      OB.toast(it.stake_error, 'err');
      updateSlipRow(i);
      return;
    }
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
      // By identity, not by position: the user may have removed, re-added or
      // re-ordered rows while this POST was in flight.
      removeFromSlip(it);
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


  Object.assign(OB, { addToSlip, bindSlip, parseStakeCents, placeOne, removeFromSlip, renderSlip, setStakeBounds, slipDetailText, slipRowHtml, stakeBounds, stakeError, stakeInputValue, updateSlipRow });
})();
