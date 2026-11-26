// Registers the ZeniusInput actor, whose capture listeners keep mouse and
// pointer input in the tab it was for (content/capture.sys.mjs), and arms it
// only in the content processes where a task page lives, frames included
// (I4). A process without one has no listener of it in any tab, and a
// process loses them
// when its last task page goes. The guard is about input state that Gecko
// shares between a process's tabs, so where no task page lives there is
// nothing to guard. A page the agent's code left something hooked in
// (zen-observe's evidence, reason hooked) also arms its processes, after its
// task too: the typing guard (content/typing.sys.mjs)
// watches the user's keys there. So does a tab whose typing is held
// (input/typing.sys.mjs), until the hold lifts: the keys the user types in
// its clean copy meanwhile are held too, for the replay.

import { EVIDENCE_DOCS_KEY } from "chrome://userscripts/content/zenius/content/worldkeys.sys.mjs";
import { TASK_BROWSERS_KEY } from "chrome://userscripts/content/zenius/content/guards.sys.mjs";
import { KEPT_BROWSERS_KEY } from "chrome://userscripts/content/zenius/content/taskset.sys.mjs";
import { TYPING_HELD_DOCS_KEY, TYPING_HELD_TABS_KEY } from "chrome://userscripts/content/zenius/content/typingkeys.sys.mjs";
import { noteSecretTyped } from "chrome://userscripts/content/zenius/input/handback.sys.mjs";
import { noteHeldInput, noteUserTyping } from "chrome://userscripts/content/zenius/input/typing.sys.mjs";
import { allTabs } from "chrome://userscripts/content/zenius/modules/windows.sys.mjs";

const ACTOR = "ZeniusInput";
const WATCHED_KEYS = [TASK_BROWSERS_KEY, EVIDENCE_DOCS_KEY, TYPING_HELD_TABS_KEY, TYPING_HELD_DOCS_KEY, KEPT_BROWSERS_KEY];

export class ZeniusInputParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    if (name === "secretTyped") {
      // The user's input changed a secret field of this document in a task's
      // tab (content/typing.sys.mjs).
      noteSecretTyped(this.manager);
    } else if (name === "keptInput") {
      // The user's input in a finished task's kept page (content/typing.sys.mjs):
      // a reply in the task's Work chat leaves that page theirs.
      noteKeptInput(this.manager?.browsingContext?.top?.embedderElement ?? null);
    } else if (name === "typingHeld") {
      // The typing guard stopped the user's first press or key in a hooked
      // page (content/typing.sys.mjs).
      noteUserTyping(this.manager?.browsingContext?.top?.embedderElement ?? null, data);
    } else if (name === "typingHeldKey") {
      // The user's input that a hold dropped, for the clean copy's replay.
      noteHeldInput(this.manager?.browsingContext?.top?.embedderElement ?? null, data, this.manager?.domProcess?.childID ?? null);
    } else if (name === "heard") {
      // A release in the tab (content/capture.sys.mjs). The answer leaves
      // after every message its process sent before, the release of its
      // page's pointer capture included.
      return true;
    }
    return undefined;
  }
}

/** The content processes where the guard is armed, by childID. */
const armed = new Set();
let installed = false;
let syncQueued = false;

export function installCaptureGuards() {
  const def = {
    parent: { esModuleURI: "chrome://userscripts/content/zenius/input/capture.sys.mjs" },
    // No events: the child adds its listeners when armed, and only then.
    child: { esModuleURI: "chrome://userscripts/content/zenius/content/capture.sys.mjs" },
    allFrames: true,
    // Gecko 160 refuses actors in web content processes without this.
    safeForUntrustedWebProcess: true,
    messageManagerGroups: ["browsers"],
    remoteTypes: ["web", "webIsolated", "webCOOP+COEP"],
  };
  try {
    ChromeUtils.registerWindowActor(ACTOR, def);
  } catch {
    ChromeUtils.unregisterWindowActor(ACTOR);
    ChromeUtils.registerWindowActor(ACTOR, def);
  }
  armed.clear();
  if (!installed) {
    installed = true;
    Services.obs.addObserver(onWindowGlobal, "window-global-created");
    Services.obs.addObserver(onWindowGlobal, "window-global-destroyed");
    Services.cpmm.sharedData.addEventListener("change", e => {
      if (WATCHED_KEYS.some(key => e.changedKeys.includes(key))) {
        queueSync();
      }
    });
  }
  queueSync();
}

function taskIds() {
  return Services.ppmm.sharedData.get(TASK_BROWSERS_KEY) ?? new Set();
}

function heldTabIds() {
  return Services.ppmm.sharedData.get(TYPING_HELD_TABS_KEY) ?? new Set();
}

/** A finished task's kept pages that a reply may still hand back. */
function keptIds() {
  return Services.ppmm.sharedData.get(KEPT_BROWSERS_KEY) ?? new Set();
}

function noteKeptInput(browser) {
  try {
    const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");
    // Not ownerGlobal: Gecko 160 has no Node.ownerGlobal.
    const tab = browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser?.(browser) ?? null;
    const rec = tab ? ZeniusService.finishedTaskOf(tab) : null;
    if (rec) {
      ZeniusService.noteKeptInput(rec, browser, "typed");
    }
  } catch (e) {
    console.error("[zenius] noting the user's input in a kept page failed", e);
  }
}

/** The top BrowsingContexts of task pages, of hooked pages, of tabs whose typing is held, and of kept pages. */
function guardedTops() {
  const tops = new Set();
  for (const id of [...taskIds(), ...heldTabIds(), ...keptIds()]) {
    const top = BrowsingContext.getCurrentTopByBrowserId(id);
    if (top) {
      tops.add(top);
    }
  }
  for (const id of [...guardedDocs(), ...(Services.ppmm.sharedData.get(TYPING_HELD_DOCS_KEY) ?? [])]) {
    const top = WindowGlobalParent.getByInnerWindowId(id)?.browsingContext?.top;
    if (top) {
      tops.add(top);
    }
  }
  return tops;
}

/** The content processes where a guarded page lives, frames included, by childID. */
function liveProcesses() {
  const live = new Set();
  for (const top of guardedTops()) {
    for (const bc of top.getAllBrowsingContextsInSubtree()) {
      const wg = bc.currentWindowGlobal;
      if (wg && !wg.isInProcess && wg.domProcess) {
        live.add(wg.domProcess.childID);
      }
    }
  }
  return live;
}

/**
 * Every document of a tab in the process `childID`: the actor's reach.
 * Every workspace's tabs: Zen's gBrowser.browsers leaves out some of them
 * (a page kept after its task went to another workspace, and kept its
 * process's listeners when its last task page went).
 */
function* windowGlobalsIn(childID) {
  for (const tab of allTabs()) {
    for (const bc of tab.linkedBrowser?.browsingContext?.getAllBrowsingContextsInSubtree() ?? []) {
      const wg = bc.currentWindowGlobal;
      if (wg && !wg.isInProcess && !wg.isClosed && wg.domProcess?.childID === childID) {
        yield wg;
      }
    }
  }
}

function tell(wg, name) {
  try {
    wg.getActor(ACTOR).sendAsyncMessage(name);
  } catch {
    // Its document is going: so are its listeners' targets.
  }
}

function queueSync() {
  if (syncQueued) {
    return;
  }
  syncQueued = true;
  Services.tm.dispatchToMainThread(() => {
    syncQueued = false;
    sync();
  });
}

function sync() {
  const live = liveProcesses();
  for (const childID of [...armed]) {
    if (!live.has(childID)) {
      armed.delete(childID);
      // The child disarms its whole process at one message.
      for (const wg of windowGlobalsIn(childID)) {
        tell(wg, "disarm");
        break;
      }
    }
  }
  for (const childID of live) {
    if (!armed.has(childID)) {
      armed.add(childID);
      for (const wg of windowGlobalsIn(childID)) {
        tell(wg, "arm");
      }
    }
  }
}

function onWindowGlobal(wg, topic) {
  if (wg.isInProcess) {
    return;
  }
  if (topic === "window-global-created" && armed.has(wg.domProcess?.childID)) {
    // A new document in an armed process: a user's tab opening, a page
    // loading. Its actor can take a message once the notification is over.
    Services.tm.dispatchToMainThread(() => {
      if (!wg.isClosed) {
        tell(wg, "arm");
      }
    });
  }
  // A guarded page's document arriving in a process, or leaving one.
  const top = wg.browsingContext?.top;
  const id = top?.browserId;
  if ((id && (taskIds().has(id) || heldTabIds().has(id))) || flagged(wg.innerWindowId) || flagged(top?.currentWindowGlobal?.innerWindowId)) {
    queueSync();
  }
}

/**
 * Is the document `innerWindowId` hooked, the only evidence the typing guard
 * acts on? Listed and flagged pages get zen-ux's warning instead, and a page
 * the agent made keeps the user's input on (content/typing.sys.mjs).
 */
function flagged(innerWindowId) {
  return !!innerWindowId && guards(Services.ppmm.sharedData.get(EVIDENCE_DOCS_KEY)?.get(innerWindowId));
}

/** {reason: detail} of a document, as zen-observe's EVIDENCE_DOCS_KEY holds it: hooked? */
const guards = reasons => !!reasons && reasons.hooked !== undefined;

/** The hooked documents, which the typing guard acts on. */
function guardedDocs() {
  const docs = Services.ppmm.sharedData.get(EVIDENCE_DOCS_KEY);
  return docs ? [...docs].filter(([, reasons]) => guards(reasons)).map(([id]) => id) : [];
}
