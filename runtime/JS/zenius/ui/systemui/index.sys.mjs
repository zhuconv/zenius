// Registers the "ZeniusSystemUi" actor (the UI): passkey requests and
// notifications from agent pages, which would open the operating system's UI
// over the user's view. methods/ui.sys.mjs calls startSystemUi() when it
// loads; see ZeniusSystemUiChild for the behaviour.

const BASE = "chrome://userscripts/content/zenius/ui/systemui/";
const ACTOR = "ZeniusSystemUi";
let started = false;

/** @param {object} service  ZeniusService */
export function startSystemUi(service) {
  if (started) {
    return;
  }
  started = true;
  const def = {
    parent: { esModuleURI: `${BASE}ZeniusSystemUiParent.sys.mjs` },
    // No DOMWindowCreated of its own: the core's Zenius actor makes this
    // one in a task's documents only, at theirs, before the page's scripts
    // (installGuards). A user's document never loads it (the core's I4).
    child: { esModuleURI: `${BASE}ZeniusSystemUiChild.sys.mjs` },
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
  // A tab that joins a task after its document started (adopted, claimed)
  // gets an explicit installGuards request from the core.
  service.addGuardActor?.(ACTOR);
}
