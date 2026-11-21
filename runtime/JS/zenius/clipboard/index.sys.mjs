// Starts the per-Space clipboard (zen-ux): registers the ZeniusClipboard
// actor, whose child guards page-initiated clipboard calls in agent tabs, and
// empties a Space's clipboard when its task ends. methods/ui.sys.mjs calls
// startClipboard() when it loads.

import { SpaceClipboard } from "chrome://userscripts/content/zenius/clipboard/store.sys.mjs";

const BASE = "chrome://userscripts/content/zenius/clipboard/";
const ACTOR = "ZeniusClipboard";
let started = false;

/** @param {object} service  ZeniusService */
export function startClipboard(service) {
  if (started) {
    return;
  }
  started = true;
  const def = {
    parent: { esModuleURI: `${BASE}ZeniusClipboardParent.sys.mjs` },
    // No DOMWindowCreated of its own: zen-core's Zenius actor makes this
    // one in a task's documents only, at theirs, before the page's scripts
    // (installGuards). A user's document never loads it (zen-core's I4).
    child: { esModuleURI: `${BASE}ZeniusClipboardChild.sys.mjs` },
    allFrames: true,
    safeForUntrustedWebProcess: true,
    messageManagerGroups: ["browsers"],
    // Web content only, as the Zenius actor (I5).
    remoteTypes: ["web", "webIsolated", "webCOOP+COEP"],
  };
  try {
    ChromeUtils.registerWindowActor(ACTOR, def);
  } catch {
    ChromeUtils.unregisterWindowActor(ACTOR);
    ChromeUtils.registerWindowActor(ACTOR, def);
  }
  // A tab that becomes a task's page gets the guard in the documents it
  // already has (zen-core's ZeniusService.installGuards).
  service.addGuardActor(ACTOR);
  service.addEventListener((event, params) => {
    const id = params?.space;
    if (typeof id !== "number") {
      return;
    }
    const rec = service.spaces.peek(id);
    if (event === "spaceFinished" || !rec || rec.gone) {
      SpaceClipboard.clear(id);
    }
  });
}
