// zen-observe: a document where the agent's code ran doesn't navigate a
// window outside the task (docs/research/user-tab-reach.md, "Fix: closed
// groups", item 4, the second layer).
//
// Items 1 to 3 keep such a document from holding a handle to a window
// outside the task. This catches a navigation that gets through anyway. A
// content policy in the parent sees every document and frame load, whatever
// the scheme (http(s), blob:, about:blank), before http-on-opening-request,
// and loadInfo.triggeringWindowId names the document that started it
// (measured in Gecko 160, 2026-11-20). REJECT_REQUEST stops the load before
// anything is sent: the target stays where it was, with no error page. The
// page hears nothing: the commonest path, setting a cross-origin window's
// location, runs in C++ that a page guard can't wrap.
//
// It can't see what names the target's own document as the source: a
// navigation run as the target's code through a same-origin handle, or a
// history move or reload of the target. Nor close(), which reaches the
// target as WindowClose with no source. Items 1 to 3 cover those.
//
// While the user holds a page (observe/hold.sys.mjs), a load into it or one
// of its frames that any document outside the hold started is refused too:
// a page of another site can't read the held page, but it could swap it for
// a look-alike while the user types (the manager's hand-off rule,
// 2026-11-20). A hold's own documents, and the user's and zenius's loads,
// which name no document, still load. Two more, whoever starts them: a Back
// or Forward into a data: or blob: entry (the agent's kind of page), and a
// frame of a site that a window near the held page, which may hold the
// agent's code, also shows.

import { cut, STRING_TEXT } from "chrome://userscripts/content/zenius/observe/textcap.sys.mjs";
import { reportRefused } from "chrome://userscripts/content/zenius/observe/refusals.sys.mjs";

const CID = Components.ID("{3d6f0b4e-8a1c-4f5e-9b27-6c0e2d7a91f4}");
const CONTRACT = "@zenius/navguard-policy;1";
const C = Ci.nsIContentPolicy;

/**
 * @type {{
 *   isAgentCode: (top: BrowsingContext) => boolean,
 *   taskOf: (browser: Element|null) => unknown,
 *   holdOf: (top: BrowsingContext) => unknown,
 *   heldRefused: (top: BrowsingContext, kind: string, url: string) => void,
 *   agentSiteNear: (top: BrowsingContext, uri: nsIURI) => boolean,
 * }|null}
 */
let opts = null;
let active = false;

/** The top of the document that started a load, or null. */
function sourceTop(loadInfo) {
  const id = loadInfo.triggeringWindowId;
  if (!id) {
    return null;
  }
  return WindowGlobalParent.getByInnerWindowId(id)?.browsingContext?.top ?? null;
}

/**
 * Is the tab `target` outside the task of the tab `source`? Not when it is
 * that tab or a page of the same live task. Nor a window that shows nothing
 * yet but its initial about:blank: one being opened, which zen-core's items
 * 2 and 3 let open or not, and with an opener or not. A window that has
 * shown a page is outside even with the source as its opener:
 * window.open(url, name) on the user's named tab makes the caller its
 * opener before the load is checked (measured in Gecko 160, 2026-11-20).
 * After the task, every other tab that has shown a page is outside.
 */
function outside(source, target) {
  if (target.browserId === source.browserId) {
    return false;
  }
  const shown = target.currentWindowGlobal;
  if (!shown || shown.isInitialDocument) {
    return false;
  }
  const task = opts.taskOf(source.embedderElement);
  if (task === null || task === undefined) {
    return true;
  }
  return opts.taskOf(target.embedderElement) !== task;
}

/** Refusals told lately (key → time): Gecko may ask the policy more than once for one load. */
const told = new Map();

/** Is this refusal new, not one told in the last two seconds? */
function firstTelling(key) {
  const now = Date.now();
  for (const [k, at] of told) {
    if (now - at > 2000) {
      told.delete(k);
    }
  }
  if (told.has(key)) {
    return false;
  }
  told.set(key, now);
  return true;
}

function urlOf(location) {
  try {
    return cut(location.spec, STRING_TEXT);
  } catch {
    return "";
  }
}

/** Refuse another page's load into a held page; the agent hears of it if its page started it. */
function refuseHeld(location, source, target) {
  const browser = source.embedderElement;
  const task = opts.taskOf(browser);
  const url = urlOf(location);
  if (!firstTelling(`navigation ${source.id} ${target.id} ${url}`)) {
    return C.REJECT_REQUEST;
  }
  if ((task !== null && task !== undefined) || opts.isAgentCode(source)) {
    reportRefused(
      browser,
      "heldPageNavigation",
      `The page tried to load ${url || "a page"} in the page the user holds. While the user holds a page, no other page navigates it or its frames, so zenius stopped the load before it was sent.`
    );
  }
  opts.heldRefused?.(target, "navigation", url);
  return C.REJECT_REQUEST;
}

/** Refuse a load in a held tab that no other page started, and tell zen-ux once. */
function refuseInHold(target, kind, url) {
  if (firstTelling(`${kind} ${target.id} ${url}`)) {
    opts.heldRefused?.(target, kind, url);
  }
  return C.REJECT_REQUEST;
}

/** Is a session history load (Back, Forward, a history.go) under way in this tab? */
function historyLoad(top) {
  try {
    return (top.sessionHistory?.requestedIndex ?? -1) >= 0;
  } catch {
    return false;
  }
}

/**
 * Gecko set the tab's requestedIndex to the refused entry before the load
 * reached this policy, and leaves it there until a document commits; the
 * next history load counts from it (CanonicalBrowsingContext::HistoryGo).
 * So the history menu's pick of the agent's entry loaded H's first entry
 * afresh, with what the user typed gone (zen-snapshot's hold map). A
 * goToIndex far past the end makes nsSHistory::LoadEntry clear it and load
 * nothing (measured in Gecko 160, 2026-11-20: the document and the user's
 * field stayed, and the next pick was refused as the first). Glue by
 * zen-core.
 */
function forgetRefusedIndex(target) {
  let refused = -1;
  try {
    refused = target.sessionHistory?.requestedIndex ?? -1;
  } catch {}
  if (refused < 0) {
    return;
  }
  // Not from inside the policy: the refused load is still unwinding.
  Services.tm.dispatchToMainThread(() => {
    try {
      const history = target.isDiscarded ? null : target.sessionHistory;
      if (history?.requestedIndex === refused) {
        target.goToIndex(history.count + 1000);
      }
    } catch (e) {
      console.error("[zenius] forgetting a refused history load failed", e);
    }
  });
}

/** A load into a held tab (its top or a frame): ACCEPT, or REJECT_REQUEST with the reason told. */
function heldLoad(location, type, source, target, hold) {
  if (source && opts.holdOf(source) !== hold) {
    return refuseHeld(location, source, target);
  }
  if ((location.schemeIs("data") || location.schemeIs("blob")) && historyLoad(target)) {
    forgetRefusedIndex(target);
    return refuseInHold(target, "history", urlOf(location));
  }
  if (type === C.TYPE_SUBDOCUMENT && opts.agentSiteNear?.(target, location)) {
    return refuseInHold(target, "agentSite", urlOf(location));
  }
  return C.ACCEPT;
}

const policy = {
  QueryInterface: ChromeUtils.generateQI(["nsIContentPolicy", "nsIFactory"]),
  createInstance(iid) {
    return this.QueryInterface(iid);
  },
  // Never throws: every document load in the browser comes through here
  // while it's on.
  shouldLoad(location, loadInfo) {
    try {
      const type = loadInfo.externalContentPolicyType;
      if (type !== C.TYPE_DOCUMENT && type !== C.TYPE_SUBDOCUMENT) {
        return C.ACCEPT;
      }
      const target = BrowsingContext.get(loadInfo.browsingContextID)?.top ?? null;
      if (!target) {
        return C.ACCEPT;
      }
      const source = sourceTop(loadInfo);
      const hold = opts.holdOf?.(target);
      if (hold !== undefined && hold !== null) {
        const verdict = heldLoad(location, type, source, target, hold);
        if (verdict !== C.ACCEPT) {
          return verdict;
        }
      }
      if (!source || !opts.isAgentCode(source) || !outside(source, target)) {
        return C.ACCEPT;
      }
      const url = urlOf(location);
      if (!firstTelling(`user ${source.id} ${target.id} ${url}`)) {
        return C.REJECT_REQUEST;
      }
      reportRefused(
        source.embedderElement,
        "userTabNavigation",
        `The page tried to load ${url || "a page"} in a tab outside the task. A page where the agent's code ran doesn't navigate the user's tabs, so zenius stopped the load before it was sent, and the tab stayed as it was.`
      );
      return C.REJECT_REQUEST;
    } catch (e) {
      console.error("[zenius] the navigation guard failed", e);
      return C.ACCEPT;
    }
  },
  shouldProcess() {
    return C.ACCEPT;
  },
};

/**
 * @param {object} options
 * @param {(top: BrowsingContext) => boolean} options.isAgentCode  did this top document run the agent's code?
 * @param {(browser: Element|null) => unknown} options.taskOf  the live task a tab is a page of, or null
 * @param {(top: BrowsingContext) => unknown} options.holdOf  the hold a tab is in, or undefined
 * @param {(top: BrowsingContext, kind: string, url: string) => void} options.heldRefused  tell zen-ux of a refusal in a held tab
 * @param {(top: BrowsingContext, uri: nsIURI) => boolean} options.agentSiteNear  is the URI of a site a window near this held tab may hold the agent's code on?
 */
export function installNavGuard({ isAgentCode, taskOf, holdOf, heldRefused, agentSiteNear }) {
  opts = { isAgentCode, taskOf, holdOf, heldRefused, agentSiteNear };
}

/**
 * On or off. Registered only while it has something to guard, a task's
 * pages or a page that keeps the agent's code (I4): the content policy sees
 * every document load in the browser.
 */
export function setNavGuardActive(on) {
  if (!opts || !!on === active) {
    return;
  }
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  if (on) {
    registrar.registerFactory(CID, "zenius navigation guard", CONTRACT, policy);
    Services.catMan.addCategoryEntry("content-policy", CONTRACT, CONTRACT, false, true);
  } else {
    Services.catMan.deleteCategoryEntry("content-policy", CONTRACT, false);
    registrar.unregisterFactory(CID, policy);
  }
  active = !!on;
}

/** For tests: is the guard registered, as the category manager has it? */
export function navGuardActive() {
  try {
    return Services.catMan.getCategoryEntry("content-policy", CONTRACT) === CONTRACT;
  } catch {
    return false;
  }
}
