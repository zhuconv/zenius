// ==UserScript==
// @name           zen-dev startup watch
// @description    Dev profiles only: says where a window's startup stopped, if it never finished
// @include        main
// ==/UserScript==

/* Dev Zens on the Mac sometimes stall before zenius loads: the window never
 * reaches its delayed startup, which Zen's own mods and zenius's service both
 * wait for (twice on 2026-11-22). scripts/zen-dev.sh copies this file into each
 * dev profile it starts. install.sh never copies it, and release.sh's package
 * leaves scripts/dev/ out (tests/core/zen-dev-stall.test.mjs checks both).
 *
 * It only logs. It sets one timer at the window's load. If the window's delayed
 * startup hasn't finished 30 s later, it writes one line to the log, about the
 * window's own state, and does nothing else. A window that started gets no
 * line, and nothing waits on this. */
(function zenDevStartupWatch() {
  "use strict";
  const WAIT_MS = 30000;
  const SEARCH = "moz-src:///toolkit/components/search/SearchService.sys.mjs";
  const loaded = Date.now();
  setTimeout(() => {
    const init = window.gBrowserInit;
    if (window.closed || init?.delayedStartupFinished) {
      return;
    }
    // browser-init.js: onLoad sets _loadHandled and arms _boundDelayedStartup
    // for the window's first MozAfterPaint; _delayedStartup clears it first
    // thing, and sets delayedStartupFinished last.
    let stage;
    if (!init?._loadHandled) {
      stage = "before-onload-end";
    } else if (init._boundDelayedStartup) {
      stage = "waiting-for-first-paint";
    } else {
      stage = "in-delayed-startup";
    }
    const state = { stage, readyState: document.readyState, hidden: document.hidden };
    const read = (name, get) => {
      try {
        state[name] = get();
      } catch (e) {
        state[name] = `error: ${e?.name ?? "?"}`;
      }
    };
    read("active", () => window.browsingContext.isActive);
    read("firstPaintPending", () => window.windowUtils.isFirstPaint);
    read("pendingTick", () => window.windowUtils.refreshDriverHasPendingTick);
    read("layers", () => window.windowUtils.layerManagerType);
    read("remoteLayers", () => window.windowUtils.layerManagerRemote);
    // Only a search service that is already loaded: the watch loads nothing.
    read("searchInitialized", () =>
      Components.utils.isESModuleLoaded(SEARCH) ? ChromeUtils.importESModule(SEARCH).SearchService.isInitialized : "not-loaded"
    );
    const fields = Object.entries(state)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join(" ");
    dump(`[zen-dev] window startup stalled: no delayed startup ${Math.round((Date.now() - loaded) / 1000)} s after the window's load; ${fields}\n`);
  }, WAIT_MS);
})();
