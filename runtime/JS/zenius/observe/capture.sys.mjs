// A stream the user started in a task's tab ends when the agent drives the
// tab again (zen-observe).
//
// During the user's hold (or Take over) a task's page may use the camera,
// the microphone or the screen through Firefox's own prompt, as any site
// does. The agent never uses the user's devices, so when the tab becomes the
// agent's again (Resume, a claim, a tab joining an agent's task), every
// stream in it stops, through WebRTC's own stop-sharing, the message
// Firefox's sharing indicator sends. The site's stored grants stay: while the
// agent drives, the device gate refuses before they could apply
// (modules/backstops.sys.mjs). A tab the user keeps at the task's end is
// theirs, so its stream goes on.

import { log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  reportRefused: "chrome://userscripts/content/zenius/observe/refusals.sys.mjs",
  webrtcUI: "resource:///modules/webrtcUI.sys.mjs",
});

/**
 * The tab's WebRTC streams, one per document that captures. webrtcUI keeps
 * them in _streams; the tab's sharing state names only the document that
 * reported last, which serves when _streams is gone in a later Gecko.
 */
function streamsOf(browser) {
  const top = browser.browsingContext;
  const all = lazy.webrtcUI._streams;
  if (Array.isArray(all)) {
    return all.filter(s => s.topBrowsingContext === top).map(s => ({ bc: s.browsingContext, state: s.state }));
  }
  const sharing = browser._sharingState?.webRTC;
  return sharing?.windowId ? [{ bc: sharing.browsingContext, state: sharing }] : [];
}

/** A stream state's keys, and what the agent hears they captured (screen, window and tab sharing are all "screen"). */
const WORDS = [
  ["camera", "camera"],
  ["microphone", "microphone"],
  ["screen", "screen"],
  ["window", "screen"],
  ["browser", "screen"],
];

/** "the camera", "the camera and microphone", "the camera, microphone and screen". */
function listed(words) {
  if (!words.length) {
    return "the devices";
  }
  return `the ${words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`}`;
}

/**
 * Stop every stream in the tab. Returns how many documents were told to
 * stop; 0 when nothing captured. It never throws: the caller is a change of
 * control, which must go on.
 *
 * @param {Element} browser  the tab's <browser>
 */
export function stopCapture(browser) {
  const start = ChromeUtils.now();
  let streams;
  try {
    streams = browser?.browsingContext ? streamsOf(browser) : [];
  } catch (e) {
    console.error("[zenius] reading a tab's streams failed", e);
    return 0;
  }
  if (!streams.length) {
    return 0;
  }
  try {
    // As Firefox's own stop does, so WebRTCParent adds no grace period in
    // which the page could start the device again without asking.
    lazy.webrtcUI.forgetActivePermissionsFromBrowser(browser);
  } catch (e) {
    log("capture: forgetting the tab's active permissions failed", e.message);
  }
  let stopped = 0;
  const used = new Set();
  for (const { bc, state } of streams) {
    const windowId = state?.windowId;
    try {
      const actor = bc?.currentWindowGlobal?.getActor("WebRTC");
      if (!actor || !windowId) {
        continue;
      }
      // A plain window id stops all of the document's capture
      // (MediaManager's OnNavigation); "screen:" stops the screen's alone,
      // for a document that shares one.
      actor.sendAsyncMessage("webrtc:StopSharing", windowId);
      if (state.screen || state.window || state.browser) {
        actor.sendAsyncMessage("webrtc:StopSharing", `screen:${windowId}`);
      }
      stopped++;
      for (const [key, words] of WORDS) {
        if (state[key]) {
          used.add(words);
        }
      }
    } catch (e) {
      console.error("[zenius] stopping a stream failed", e);
    }
  }
  if (stopped) {
    const words = [...used];
    try {
      lazy.reportRefused(
        browser,
        "deviceAccess",
        `zenius stopped ${listed(words)} the page used while the user held it: the agent never uses the user's devices. The site keeps what the user allowed; hand the task to the user again if it needs them.`,
        browser.currentURI?.spec,
        { api: "stopSharing", asked: words.join(" ") || "devices" }
      );
    } catch {}
    log(`capture: stopped ${stopped} stream(s) in tab ${browser.browserId} in ${(ChromeUtils.now() - start).toFixed(1)} ms`);
  }
  return stopped;
}
