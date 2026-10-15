// theme.js — the colour theme: which one, and when it is applied.
//
// ── WHY THIS FILE IS IN <head>, BEFORE THE STYLESHEET ────────────────────────
// The dark palette is a second set of values under `[data-theme='dark']` on
// <html>. A theme that is applied after the stylesheet has painted is a theme
// the user sees a flash of the wrong one of: on a desk with the room lights on
// at 7am, a full-screen white flash on every page load is worse than having no
// dark mode at all. So the decision has to be made before the first paint, and
// it cannot be made inline — the venue's CSP is `script-src 'self'` with no
// 'unsafe-inline', so an inline snippet is refused by the browser rather than
// merely discouraged. An external, blocking, classic script is the only route
// that survives both constraints.
//
// ── WHY THE DEFAULT FOLLOWS THE OS AND THE OVERRIDE IS STORED ───────────────
// Both, deliberately, and in this order:
//
//   * `prefers-color-scheme` alone gives the user no way to disagree with their
//     OS. On a trading surface that is a real cost: a trader in a bright room
//     wants light, and a trader who has spent the evening in a dark room wants
//     dark, and neither of those is necessarily what the OS is set to.
//   * A stored manual choice alone leaves a first-time user on the OS default
//     anyway (there is no stored value), so it costs nothing to make that the
//     default rather than to ignore the OS.
//   * A server-side preference would survive a device change, but it couples a
//     purely presentational choice to the account model and to a migration, for
//     a preference that is close to free to set again.
//
// So: OS by default, an explicit three-way choice that persists in
// localStorage, and a live listener so that flipping the OS theme while the
// venue is open is honoured as long as the user has not overridden it.
//
// The stored VALUE is the choice ('auto' | 'light' | 'dark'); the stored
// CHOICE of theme is derived. Storing a resolved 'dark' would make "follow the
// OS" permanently un-recoverable, which is the trap this shape avoids.
(() => {
  'use strict';

  const KEY = 'obx.theme';
  const MODES = ['auto', 'light', 'dark'];
  const root = document.documentElement;

  // localStorage throws rather than returning null in a partitioned context or
  // with cookies blocked. A theme preference is not worth losing the page over,
  // and not worth failing the boot for either.
  function read() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }
  function write(mode) {
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* not persisted, still applied for this page */
    }
  }

  // Older browsers and some embedded webviews have no matchMedia at all. Dark is
  // the safer default there only in the sense that it is the one that works;
  // without the query the honest answer is "light", which is what the :root
  // block already says.
  function systemDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  const resolve = (mode) => (mode === 'auto' || !MODES.includes(mode) ? (systemDark() ? 'dark' : 'light') : mode);

  /**
   * Put a theme on the page. Safe to call from <head> (no controls yet) and
   * again from the picker once the controls exist.
   */
  function apply(mode) {
    const chosen = MODES.includes(mode) ? mode : 'auto';
    root.setAttribute('data-theme', resolve(chosen));
    // Which ANSWER is selected is a separate fact from which THEME resulted:
    // "Auto" on a dark OS is data-theme=dark and the Auto chip ticked.
    for (const input of document.querySelectorAll('#themePicker input[name="theme"]')) {
      input.checked = input.value === chosen;
    }
    // Branding owns this (shell.js syncThemeColor): one source of truth for
    // what the page ground is, so a theme change and a tenant palette cannot
    // each write a different value into the meta tag.
    const OB = window.OB;
    if (OB && OB.syncThemeColor) OB.syncThemeColor();
    return chosen;
  }

  // First paint. Reads storage, resolves, writes the attribute. Nothing here can
  // fail the load: every access is guarded.
  apply(read() || 'auto');

  function wire() {
    const picker = document.getElementById('themePicker');
    if (!picker || picker.dataset.wired) return;
    picker.dataset.wired = '1';
    // Re-apply once the controls exist. The head-time call set data-theme but
    // could not tick a radio that had not been parsed yet, so without this the
    // picker opens showing NOTHING selected on every page load — which reads as
    // a broken control rather than as an unanswered question.
    apply(read() || 'auto');
    picker.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || t.name !== 'theme') return;
      write(t.value);
      apply(t.value);
    });
    // Re-resolve when the OS flips, but ONLY while the user has not overridden
    // it. An explicit Dark on a machine that just went light must stay dark.
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', () => {
        const mode = read() || 'auto';
        if (mode === 'auto') apply('auto');
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.OBXTheme = { apply, read, resolve, write, KEY, MODES };
})();