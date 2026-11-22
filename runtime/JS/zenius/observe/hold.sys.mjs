// zen-observe: the page the user holds (H), for the manager's hand-off rule
// (2026-11-20): while the user types in H, nothing of the agent's reaches it.
// zen-core calls holdPage() as a hand-off (or the user's Take over) begins,
// before its quiet reload, and releasePage() at Resume agent or at any other
// end of the hold. While H is held:
// - observe/navguard.sys.mjs refuses a load into H or one of its frames that
//   a document outside the hold started (the look-alike swap);
// - H's back-forward cache is evicted at the start, so Back can't bring back
//   a document that held the agent's code;
// - documents made in H from then on get BroadcastChannel and SharedWorker
//   scoped to H alone (content/refusals.sys.mjs, channelScope), so the
//   site's own cross-tab sync can't carry what the user types to the task's
//   other pages;
// - for the frame and COOP rule below, agentcode.sys.mjs's agentSitesNear
//   counts by site only documents from before a hold: a held tab's
//   documents made since its hold began (a task may hold several pages,
//   zen-core's holdFor) and those of a window zen-core reloaded for a hold
//   (holdReload) are fresh, since the agent's code is refused in a held
//   group.
// - a Back or Forward into a data: or blob: entry, the agent's kind of page,
//   is refused, and the user's history stays as it was;
// - a frame in H of a site that a window near H, which may hold the agent's
//   code, also shows is refused: from there it could be scripted. A load
//   that would make H's top such a site gets zen-core's COOP
//   (holdNeedsCoop), so H leaves the group as it loads.
// A popup H opens during the hold joins it: the user's sign-in flow may
// continue there. zen-ux hears each refusal (onHoldRefusal) for its line.

import { HELD_PAGES_KEY } from "chrome://userscripts/content/zenius/content/refusals.sys.mjs";

/** Held tabs (browserId) → the hold they're in (H's browserId). */
const held = new Map();
/**
 * Held tabs (browserId) → their documents (innerWindowId) from before the
 * hold. For another hold in the same group, agentSitesNear doesn't count the
 * ones made since by site.
 */
const before = new Map();
/** Tabs zen-core reloads for a hold (browserId) → the hold and their documents from before the reload. */
const reloaded = new Map();
let watching = false;
/** `fn()` after the holds change (observe/setup.sys.mjs's hooks). */
let holdsListener = null;
/** zen-ux's listeners for the guard's refusals in held pages. */
const refusalListeners = new Set();

export function onHolds(fn) {
  holdsListener = fn;
}

/** The documents (innerWindowId) in a tab's tree now. */
function documentsOf(top) {
  const ids = new Set();
  try {
    for (const bc of top.getAllBrowsingContextsInSubtree()) {
      const id = bc.currentWindowGlobal?.innerWindowId;
      if (id) {
        ids.add(id);
      }
    }
  } catch {}
  return ids;
}

function publish() {
  for (const id of [...held.keys()]) {
    if (!BrowsingContext.getCurrentTopByBrowserId(id)) {
      held.delete(id);
      before.delete(id);
    }
  }
  for (const [id, { hold }] of [...reloaded]) {
    if (!BrowsingContext.getCurrentTopByBrowserId(id) || ![...held.values()].includes(hold)) {
      reloaded.delete(id);
    }
  }
  Services.ppmm.sharedData.set(HELD_PAGES_KEY, new Map(held));
  Services.ppmm.sharedData.flush();
  watchPopups(held.size > 0);
  try {
    holdsListener?.();
  } catch (e) {
    console.error("[zenius] holds listener failed", e);
  }
}

/** A window a held tab opens joins its hold, from its first document. */
function onAttached(bc) {
  try {
    if (!bc || bc.parent || !bc.browserId || held.has(bc.browserId)) {
      return;
    }
    const hold = held.get(bc.opener?.top?.browserId);
    if (hold === undefined) {
      return;
    }
    held.set(bc.browserId, hold);
    before.set(bc.browserId, new Set());
    publish();
  } catch (e) {
    console.error("[zenius] a held page's popup", e);
  }
}

// browsing-context-attached comes for every new browsing context, the
// user's own included: heard only while a page is held (I4).
function watchPopups(want) {
  if (want === watching) {
    return;
  }
  watching = want;
  if (want) {
    Services.obs.addObserver(onAttached, "browsing-context-attached");
  } else {
    Services.obs.removeObserver(onAttached, "browsing-context-attached");
  }
}

/**
 * The user holds this page (H): an agent's hand-off, or the user's own Take
 * over. Call it before the quiet reload. Whether the page is held now.
 *
 * @param {Element} browser  H's <browser>
 * @returns {boolean}
 */
export function holdPage(browser) {
  let top = null;
  try {
    top = browser?.browsingContext?.top ?? null;
  } catch {}
  const id = top?.browserId;
  if (!id) {
    return false;
  }
  if (held.get(id) !== id) {
    held.set(id, id);
    before.set(id, documentsOf(top));
  }
  // Back would bring back a cached document as it was, the agent's code
  // and all; evicted, it loads afresh.
  try {
    top.sessionHistory?.evictAllDocumentViewers();
  } catch (e) {
    console.error("[zenius] evicting a held page's back-forward cache", e);
  }
  publish();
  return true;
}

/**
 * The hold on this page ends (Resume agent, a close, the task's end). The
 * popups that joined it leave with it.
 *
 * @param {Element} browser  H's <browser>
 */
export function releasePage(browser) {
  let id = null;
  try {
    id = browser?.browsingContext?.top?.browserId ?? browser?.browserId ?? null;
  } catch {}
  const hold = held.get(id);
  if (hold === undefined) {
    return;
  }
  for (const [tab, h] of [...held]) {
    if (h === hold) {
      held.delete(tab);
      before.delete(tab);
    }
  }
  for (const [tab, r] of [...reloaded]) {
    if (r.hold === hold) {
      reloaded.delete(tab);
    }
  }
  publish();
}

/**
 * zen-core reloads `browser`, a window of the held page's group that could
 * reach it, so that the hold keeps H's opener: call it right before the
 * reload. The documents the tab gets from then on count as fresh, as H's
 * do, until the hold ends: from holdPage on, the agent's code is refused in
 * every document of H's group, so nothing of the agent's is left there once
 * those windows are reloaded. The tab doesn't join the hold: its loads into
 * H are still refused.
 *
 * @param {Element} browser  the window zen-core reloads
 * @param {Element} heldBrowser  H's <browser>
 * @returns {boolean} whether H is held, so it counts
 */
export function holdReload(browser, heldBrowser) {
  const hold = holdOf(heldBrowser);
  let top = null;
  try {
    top = browser?.browsingContext?.top ?? null;
  } catch {}
  if (hold === undefined || !top?.browserId) {
    return false;
  }
  reloaded.set(top.browserId, { hold, docs: documentsOf(top) });
  return true;
}

/**
 * The hold a tab is in (H's browserId), or undefined.
 *
 * @param {BrowsingContext|Element|null} target  any BrowsingContext of the tab, or its <browser>
 */
export function holdOf(target) {
  let id = null;
  try {
    id = (target?.browsingContext ?? target)?.top?.browserId ?? null;
  } catch {}
  return id ? held.get(id) : undefined;
}

/** Is any page held? */
export function holdingAny() {
  return held.size > 0;
}

/**
 * Hear the navigation guard's refusals in held pages, for zen-ux's line:
 * `fn({browser, kind, url})`, where `browser` is the held tab's <browser>
 * and `kind` is "history" (Back or Forward into a data: or blob: entry),
 * "navigation" (another page's load into it) or "agentSite" (a frame of a
 * site a window near it may hold the agent's code on). Returns a function
 * that stops it.
 *
 * @param {(refusal: {browser: Element|null, kind: string, url: string}) => void} fn
 */
export function onHoldRefusal(fn) {
  refusalListeners.add(fn);
  return () => refusalListeners.delete(fn);
}

/** The guard refused a load in a held tab (observe/navguard.sys.mjs). */
export function heldLoadRefused(top, kind, url) {
  const refusal = { browser: top?.embedderElement ?? null, kind, url };
  for (const fn of refusalListeners) {
    try {
      fn(refusal);
    } catch (e) {
      console.error("[zenius] a hold refusal listener failed", e);
    }
  }
}

/** A URI's site (scheme and eTLD+1), or null: none for data:, which nothing else shares. */
export function siteOfURI(uri) {
  try {
    if (uri.schemeIs("data")) {
      return null;
    }
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {});
    return principal.isContentPrincipal ? principal.siteOriginNoSuffix || null : null;
  } catch {
    return null;
  }
}

/**
 * zen-core asks at the response of a load into a held tab's top document:
 * would it make H a site that a window near H, which may hold the agent's
 * code, also shows? Then zen-core puts COOP on it, and H leaves the group
 * as it loads. A sign-in popup returning to the agent's site is the case.
 *
 * @param {{id: number}|null} rec  the task's space record while it lives, else null
 * @param {Element} browser  the held tab's <browser>
 * @param {nsIURI} uri  the response's URL, after its redirects
 * @returns {boolean}
 */
export function holdNeedsCoop(rec, browser, uri) {
  if (holdOf(browser) === undefined) {
    return false;
  }
  const site = siteOfURI(uri);
  if (!site) {
    return false;
  }
  // Loaded here, not at the top: agentcode.sys.mjs imports this module.
  const { agentSitesNear } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs");
  return agentSitesNear(rec, browser).has(site);
}

/**
 * Was this document in the tab before its hold began, or before zen-core
 * reloaded it for a hold (holdReload)? True for every document of a tab
 * that's neither.
 *
 * @param {number} browserId  the tab's
 * @param {number} innerWindowId  the document's
 */
export function fromBeforeHold(browserId, innerWindowId) {
  const docs = before.get(browserId) ?? reloaded.get(browserId)?.docs;
  return !docs || docs.has(innerWindowId);
}
