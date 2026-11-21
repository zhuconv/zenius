// ==UserScript==
// @name           zenius
// @description    Agentic Zen runtime: per-window bootstrap
// @include        main
// ==/UserScript==

// Everything lives in the ZeniusService singleton; each browser window only
// registers itself. The service prints "[zenius] window loaded, instance=…"
// once the socket is listening, which scripts/zen-dev.sh waits for.
(function zenius() {
  "use strict";
  const register = () => {
    try {
      const { ZeniusService } = ChromeUtils.importESModule(
        "chrome://userscripts/content/zenius/modules/service.sys.mjs"
      );
      ZeniusService.registerWindow(window).catch(e => {
        dump(`[zenius] window registration failed: ${e?.message}\n${e?.stack ?? ""}\n`);
        console.error("[zenius]", e);
      });
    } catch (e) {
      dump(`[zenius] bootstrap failed: ${e?.message}\n${e?.stack ?? ""}\n`);
      console.error("[zenius]", e);
    }
  };
  // Zen's own startup comes first (I4): fx-autoconfig runs this at the
  // window's DOMContentLoaded, where loading the runtime delayed the first
  // window by ~30 ms. Nothing needs zenius sooner, since no agent Page can
  // exist before its socket listens.
  const whenIdle = () => ChromeUtils.idleDispatch(register, { timeout: 1000 });
  if (window.gBrowserInit?.delayedStartupFinished) {
    whenIdle();
    return;
  }
  const observer = subject => {
    if (subject === window) {
      Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
      whenIdle();
    }
  };
  Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  window.addEventListener(
    "unload",
    () => {
      try {
        Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
      } catch {}
    },
    { once: true }
  );
})();
