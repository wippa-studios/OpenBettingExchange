// nav.js — sport nav, sidebar tree, global search
(() => {
  'use strict';

  const OB = window.OB;
  if (!OB) { console.error('[nav] window.OB missing — core.js must load first'); return; }

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

  // ── sports filter ────────────────────────────────────────────────────────
  //
  // The sport chips live in the LEFT RAIL, not in the header. They used to be
  // created as a #sportbar and inserted after the nav, which put the sport
  // picker in the top-right corner — separated from the markets it filters,
  // in the one piece of screen real estate that should be the ladder.
  //
  // In seeded mode this rail is now the ONLY navigation, so hiding it (which
  // renderSidebar used to do when there is no feed tree) would leave the venue
  // with no sport picker at all. Feed mode still uses the same rail for the
  // sport → country → track → meeting → race tree, so exactly one of the two
  // owns it at a time and neither has to know about the other's markup.
  function renderSportNav() {
    const rail = OB.$('sidebar');
    const list = OB.$('sportsList');
    // Feed mode owns the rail with the deep tree; the chips would be a second,
    // competing navigation over the same space.
    if (!rail || !list || OB.state.feedMode) {
      const old = OB.$('sportbar');
      if (old) old.remove();
      return;
    }
    rail.hidden = false;
    const all = `<button class="chip chipblock ${OB.state.sport === null ? 'on' : ''}" data-sport="">All sports</button>`;
    const chips = OB.state.sports
      .map(
        (s) =>
          `<button class="chip chipblock ${OB.state.sport === s.slug ? 'on' : ''}" data-sport="${OB.attr(s.slug)}">${OB.esc(s.name)} <span class="muted">${s.event_count}</span></button>`
      )
      .join('');
    list.innerHTML = `<div class="sidehead">SPORTS</div>` + all + chips;
    OB.qa('button[data-sport]', list).forEach((b) => {
      b.onclick = () => {
        OB.state.sport = b.dataset.sport || null;
        renderSportNav();
        OB.refreshMarkets();
      };
    });
  }

  // ── left rail: expandable tree ───────────────────────────────────────────
  // A deep tree, bookmaker style:
  //   Sport > Country > Track > Meeting > each race by start time.
  // Only the path to the current selection is expanded, so the rail stays
  // scannable instead of dumping 200 leaf nodes on screen.
  function renderSidebar() {
    const aside = OB.$('sidebar');
    const list = OB.$('sportsList');
    if (!aside || !list) return;
    // Seeded mode has no tree data, so the deep tree does not render — but the
    // rail itself STAYS VISIBLE, because in seeded mode it is the sport picker.
    // It used to be hidden outright here ("the sport chips are that mode's
    // nav"), which was true when the chips were a header bar and stopped being
    // true the moment they moved into this rail: hiding it would have left the
    // venue with no way to filter by sport at all.
    //
    // renderSportNav() owns the rail's contents in seeded mode; this function
    // must not blank it, or the two would erase each other depending on which
    // ran last.
    if (!OB.state.feedMode) {
      aside.hidden = false;
      return;
    }
    aside.hidden = false;
    const sports = OB.state.nav || [];
    if (!sports.length) {
      list.innerHTML = '<div class="sidehead">SPORTS</div><div class="sempty">No sports</div>';
      return;
    }
    const sel = OB.state.navSel || {};
    const activeMarket = String(sel.market_id || '');

    // Expansion reads ONLY from state.treeOpen, never from the selection.
    // Gating expansion on "is this the selected sport" meant opening a second
    // sport could never expand anything: the old sport collapsed, the new one
    // was not the selection, so the rail emptied. Expansion and selection are
    // now separate concerns, and openBranch() sets both together.
    let html = '';
    for (const s of [...sports].sort((a, b) => a.sport.localeCompare(b.sport))) {
      const sOpen = OB.state.treeOpen.sport === s.sport;
      html += treeNode('sport', s.sport, s.sport === sel.sport, sOpen, { sport: s.sport });
      if (!sOpen) continue;
      for (const c of s.countries) {
        const cOpen = sOpen && OB.state.treeOpen.country === c.country;
        html += treeNode('country', c.country, c.country === sel.country, cOpen,
          { sport: s.sport, country: c.country });
        if (!cOpen) continue;
        for (const k of c.competitions) {
          const kOpen = cOpen && OB.state.treeOpen.comp === k.competition;
          html += treeNode('comp', k.competition, k.competition === sel.competition, kOpen,
            { sport: s.sport, country: c.country, comp: k.competition });
          if (!kOpen) continue;
          for (const m of k.meetings) {
            const mOpen = kOpen && String(OB.state.treeOpen.meeting) === String(m.event_id);
            html += treeNode('meeting', m.event_name, String(m.event_id) === String(sel.event_id), mOpen,
              { sport: s.sport, country: c.country, comp: k.competition, meeting: m.event_id });
            if (!mOpen) continue;
            for (const r of racesByTime(m)) {
              const rOn = String(r.market_id) === activeMarket;
              html += `<button class="treeitem race${rOn ? ' on' : ''}" data-mkt="${OB.attr(r.market_id)}">`
                + `<span class="t">${OB.esc(clockText(r.market_time))}</span>`
                + `<span class="n">${OB.esc(r.market_label || r.market_name)}</span>`
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
    OB.qa('.treeitem.race', list).forEach((b) => {
      b.onclick = () => {
        OB.state.navSel = Object.assign({}, OB.state.navSel, { market_id: b.dataset.mkt });
        OB.closeNavRail(); // narrow screens: picking a race closes the drawer (W9)
        renderSidebar();
        OB.refreshMarkets();
      };
    });

    // Disclosure toggles are delegated so a rebuilt tree carries no stale
    // handlers. Which branch is open lives in state, not in the DOM.
    OB.qa('.treeitem[data-kind]', list).forEach((b) => {
      b.onclick = () => {
        const level = OB.TREE_LEVELS[b.dataset.kind];
        if (b.dataset.open === '1') {
          // Collapsing hides this level and everything beneath it. The board
          // keeps showing the selected race: the rail changing must not change
          // what is priced.
          for (let i = OB.TREE_LEVELS.indexOf(level); i < OB.TREE_LEVELS.length; i++) {
            OB.state.treeOpen[OB.TREE_LEVELS[i]] = null;
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
      for (const k of OB.TREE_LEVELS) OB.state.treeOpen[k] = null;
      return false;
    }
    OB.state.treeOpen.sport = chain.s.sport;
    OB.state.treeOpen.country = chain.c ? chain.c.country : null;
    OB.state.treeOpen.comp = chain.k.competition;
    OB.state.treeOpen.meeting = chain.m.event_id;
    OB.state.navSel = {
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
    if (ok) OB.refreshMarkets();
    return ok;
  }

  // Walk a tree path down to one concrete chain: sport, country, track,
  // meeting and the earliest race in it. Picks the earliest race rather than
  // the first row so that opening a meeting lands on the next race off, which
  // is what a bettor opening a meeting wants to see.
  function resolveChain(path) {
    const s = find(OB.state.nav || [], 'sport', path.sport);
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
      .map((key) => ` data-${key}="${OB.attr(path[key])}"`).join('');
    return (
      `<button class="treeitem ${kind}${isCurrent ? ' cur' : ''}" data-kind="${kind}"${attrs}` +
      ` data-open="${isOpen ? '1' : ''}">` +
      `<span class="caret${isOpen ? ' open' : ''}"></span>` +
      `<span class="t">${OB.esc(label)}</span></button>`
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
    if (OB.state.feedMode) {
      for (const m of OB.state.feedMarkets || []) {
        if ((m.event_name || '').toLowerCase().includes(term)) push('MEETING', m.event_name, m.market_name, m);
        if ((m.market_name || '').toLowerCase().includes(term)) push('RACE', m.market_name, m.event_name, m);
        for (const s of m.selections || []) {
          if ((s.name || '').toLowerCase().includes(term)) {
            push('RUNNER', s.name, `${m.market_name} · ${m.event_name}`, m);
          }
        }
      }
    } else {
      for (const e of OB.state.events || []) {
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
    OB.state.navSel = Object.assign({}, OB.state.navSel, { market_id: id });
    if (OB.state.feedMode) {
      const hit = OB.findMarket(id);
      if (hit) {
        // Expand the rail along the hit's own path so the race leaf is visible
        // and highlighted — the same state a click on that leaf would set.
        OB.state.treeOpen.sport = hit.s.sport;
        OB.state.treeOpen.country = hit.c ? hit.c.country : null;
        OB.state.treeOpen.comp = hit.k.competition;
        OB.state.treeOpen.meeting = hit.m.event_id;
        OB.state.navSel = {
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
    OB.refreshMarkets();
  }

  function renderSearchResults(rows) {
    const box = OB.$('searchResults');
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
            <span class="k">${OB.esc(r.kind)}</span><span>${OB.esc(r.label)}</span>
            <span class="m">${OB.esc(r.sub || '')}</span></button>`
        )
        .join('') + (rows.length >= 30 ? '<div class="sempty">Refine your search…</div>' : '');
    OB.qa('.srow', box).forEach((b) => {
      b.onclick = () => {
        const r = rows[Number(b.dataset.i)];
        box.hidden = true;
        OB.$('globalSearch').value = '';
        if (r) selectSearchedMarket(r.market);
      };
    });
  }

  function bindSearch() {
    const input = OB.$('globalSearch');
    if (!input) return;
    const box = OB.$('searchResults');
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


  Object.assign(OB, { bindSearch, clockText, drillFirst, find, ms, openBranch, racesByTime, renderSearchResults, renderSidebar, renderSportNav, resolveChain, searchAll, selectSearchedMarket, treeNode });
})();
