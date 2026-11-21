// ==UserScript==
// @name           Agent URL bar
// @description    Type '>' and a task in the address bar to hand it to the agent sidebar (zenius try-out).
// @include        main
// ==/UserScript==

/* Loads agent-urlbar/AgentUrlbar.sys.mjs, which adds the address bar's
 * "Ask agent" rows once per process and sends a picked one to the agent
 * sidebar (agent-sidebar.uc.js) of the window it was picked in. */
(function agentUrlbar() {
  "use strict";
  const SCRIPT_URL = Components.stack.filename.split(" -> ").pop();
  const BASE = SCRIPT_URL.slice(0, SCRIPT_URL.lastIndexOf("/") + 1) + "agent-urlbar/";
  try {
    ChromeUtils.importESModule(BASE + "AgentUrlbar.sys.mjs");
  } catch (e) {
    console.error("[agent-urlbar]", e);
  }
})();
