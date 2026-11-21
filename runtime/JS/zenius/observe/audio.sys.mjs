// Agent tabs make sound only while the user can see them (zen-observe;
// docs/research/observe.md §10). A tab the user can't see is muted through
// its MediaController, the switch behind the tab's speaker button, so the
// page plays on silently: media keeps its clock and events, and agent tasks
// about media still work. Showing the tab, or handing its Space to the user,
// gives the sound back. Once the user mutes or unmutes a tab by hand, it is
// theirs and zenius leaves its sound alone.
//
// The agent hears of it (a Zenius.refused event, kind "audio") when a page
// plays sound while muted, once per document and muted spell. Gecko stops
// calling a muted tab audible, so the content guards report each start of
// playback (content/refusals.sys.mjs).
//
// zen-ux's indicator: the tab has the attribute zenius-muted while zenius
// keeps it muted, and zenius-muted-sound once its page has played sound in
// that time.

import { isBrowserVisible } from "chrome://userscripts/content/zenius/ui/visibility.sys.mjs";
import { reportRefused } from "chrome://userscripts/content/zenius/observe/refusals.sys.mjs";
import { AGENT_BROWSERS_KEY } from "chrome://userscripts/content/zenius/content/guards.sys.mjs";
import { MEDIA_HIDDEN_KEY } from "chrome://userscripts/content/zenius/content/media.sys.mjs";

// Pages by browserId, not <browser>: Zen's window sync moves a page's
// docShell, with its browserId and its MediaController's mute, to another
// window's copy of its tab (docs/research/two-windows.md).
/** Pages (browserId) zenius muted. */
const muted = new Set();
/** Muted page → the document (WindowGlobalParent) the agent was last told about. */
const heard = new Map();
/** Muted page → the tabs that carry its zenius-muted marks. */
const marked = new Map();
/** Pages the user muted or unmuted by hand. */
const usersChoice = new Set();
const windows = new WeakSet();
let isAgent = _browser => false;
let installed = false;

const MESSAGE =
  "The page is playing sound, but the user can't see this tab, so the tab is muted: the page plays on silently, and its sound comes back when the user opens the tab.";

/** Mute agent tabs the user can't see. Idempotent. */
export function installAudio({ isAgent: fn }) {
  isAgent = fn;
  if (installed) {
    return;
  }
  installed = true;
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    watchWindow(win);
  }
  Services.obs.addObserver(win => watchWindow(win), "browser-delayed-startup-finished");
}

let watchingReplacements = false;

/**
 * browsing-context-attached comes for every new frame and tab, the user's
 * own included, so it's heard only while zenius keeps some page muted (I4).
 */
function syncReplacementWatch() {
  const want = muted.size > 0;
  if (want === watchingReplacements) {
    return;
  }
  watchingReplacements = want;
  if (want) {
    Services.obs.addObserver(muteReplacement, "browsing-context-attached");
  } else {
    Services.obs.removeObserver(muteReplacement, "browsing-context-attached");
  }
}

/** For tests: is the observer for a muted page's new BrowsingContext on? */
export function audioHookActive() {
  return watchingReplacements;
}

/**
 * A process switch can replace a page's top BrowsingContext, for example
 * when a page opened at about:blank loads a site. The new one comes with a
 * MediaController of its own, unmuted, under the same browserId. So a page
 * zenius keeps muted gets the mute on its new controller at once, before the
 * new document can play.
 */
function muteReplacement(bc) {
  try {
    if (bc.parent || !muted.has(bc.browserId) || usersChoice.has(bc.browserId)) {
      return;
    }
    const controller = bc.mediaController;
    if (controller && !controller.isMuted) {
      controller.mute();
    }
  } catch (e) {
    console.error("[zenius] keeping a page's mute through a process switch failed", e);
  }
}

function watchWindow(win) {
  if (windows.has(win) || !win.gBrowser) {
    return;
  }
  windows.add(win);
  const sync = () => syncAll();
  // As in zen-ux's cursor: TabSelect comes before the new panel shows,
  // TabSwitchDone once it is on screen; a Space switch selects a tab.
  win.addEventListener("TabSelect", sync);
  win.addEventListener("TabSwitchDone", sync, true);
  win.addEventListener("ZenViewSplitter:SplitViewActivated", sync);
  win.document.addEventListener("visibilitychange", sync);
  win.addEventListener("TabAttrModified", event => {
    // Our own switch doesn't go through the tab, so a "muted" change is the
    // user's (the speaker button, Ctrl+M, the tab menu) or an add-on's.
    if (event.detail?.changed?.includes("muted")) {
      const id = event.target.linkedBrowser?.browserId;
      if (id) {
        usersChoice.add(id);
        forget(id);
      }
    }
  });
  // A copy without the page closes with its own browserId, which forgets nothing.
  win.addEventListener("TabClose", event => {
    const id = event.target.linkedBrowser?.browserId;
    if (id) {
      usersChoice.delete(id);
      forget(id);
    }
  });
}

/** The <browser> that holds the page now, in whichever window. */
function liveBrowser(id) {
  try {
    return BrowsingContext.getCurrentTopByBrowserId(id)?.embedderElement ?? null;
  } catch {
    return null;
  }
}

function agentBrowser(browser) {
  try {
    return !!browser && isAgent(browser);
  } catch {
    return false;
  }
}

function forget(id) {
  if (muted.delete(id)) {
    syncReplacementWatch();
    heard.delete(id);
    const tabs = marked.get(id) ?? new Set();
    marked.delete(id);
    const live = tabOf(liveBrowser(id));
    if (live) {
      tabs.add(live);
    }
    for (const tab of tabs) {
      tab.removeAttribute("zenius-muted");
      tab.removeAttribute("zenius-muted-sound");
    }
  }
  publishHidden();
}

/** Set a zenius-muted mark on the page's tab, remembering where it went. */
function mark(id, browser, name) {
  const tab = tabOf(browser);
  if (!tab) {
    return;
  }
  tab.setAttribute(name, "");
  let tabs = marked.get(id);
  if (!tabs) {
    marked.set(id, (tabs = new Set()));
  }
  tabs.add(tab);
}

/**
 * Tell content which agent tabs the user can't see, so their audible media
 * pause (content/media.sys.mjs): the tabs zenius keeps muted.
 */
let published = "";
function publishHidden() {
  const ids = [...muted].filter(id => liveBrowser(id)?.isConnected).sort((a, b) => a - b);
  const key = ids.join(",");
  if (key === published) {
    return;
  }
  published = key;
  try {
    Services.ppmm.sharedData.set(MEDIA_HIDDEN_KEY, ids);
    // At once: the user is looking at the tab, or has just stopped.
    Services.ppmm.sharedData.flush();
  } catch (e) {
    console.error("[zenius] couldn't publish the hidden agent tabs", e);
  }
}

function tabOf(browser) {
  try {
    return browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser) ?? null;
  } catch {
    return null;
  }
}

/**
 * Mute or unmute every agent tab, and every tab zenius muted, by whether
 * the user can see it. The agent's tabs come from zen-core's list: Zen's
 * gBrowser.tabs leaves out other workspaces' tabs.
 */
export function syncAll() {
  const ids = new Set([...muted, ...(Services.cpmm.sharedData.get(AGENT_BROWSERS_KEY) ?? [])]);
  for (const id of ids) {
    const browser = liveBrowser(id);
    if (browser?.isConnected) {
      syncAudio(browser);
    } else if (muted.has(id)) {
      forget(id);
    }
  }
  publishHidden();
}

/** Mute `browser` if it is an agent tab the user can't see, else give back the sound zenius took. */
export function syncAudio(browser) {
  const id = browser?.browserId;
  if (!id || usersChoice.has(id)) {
    return;
  }
  const controller = browser.browsingContext?.mediaController;
  if (!controller) {
    return;
  }
  const mute = browser.isConnected && agentBrowser(browser) && !isBrowserVisible(browser);
  if (!mute) {
    if (muted.has(id)) {
      forget(id);
      if (controller.isMuted) {
        controller.unmute();
      }
    }
    return;
  }
  if (muted.has(id)) {
    // A new BrowsingContext (a process switch) may have come without it.
    if (!controller.isMuted) {
      controller.mute();
    }
    return;
  }
  if (controller.isMuted) {
    // Muted by someone else: theirs to undo.
    return;
  }
  const audible = controller.isAudible;
  controller.mute();
  muted.add(id);
  syncReplacementWatch();
  publishHidden();
  mark(id, browser, "zenius-muted");
  if (audible) {
    noteSound(browser);
  }
}

/**
 * The page in `browser` started playing sound (from the content guards):
 * say so if zenius keeps the tab muted.
 */
export function noteSound(browser, url) {
  syncAudio(browser);
  const id = browser.browserId;
  const doc = browser.browsingContext?.currentWindowGlobal ?? null;
  if (!muted.has(id) || (doc && heard.get(id) === doc)) {
    return;
  }
  if (doc) {
    heard.set(id, doc);
  }
  mark(id, browser, "zenius-muted-sound");
  reportRefused(browser, "audio", MESSAGE, url);
}

/** For tests and the SPI: is `browser` muted by zenius right now? */
export function mutedByZenius(browser) {
  return muted.has(browser?.browserId);
}
