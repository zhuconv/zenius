// The sites where the agent ran its own code (zen-observe), for zen-ux's
// "Use your own tab" (ui/index.sys.mjs). Code the agent runs on a site can
// outlive the document it ran in, and could read what the user types there:
// - in a same-site popup or frame it wrote a script into;
// - as a blob: page it navigated to, all the agent's code, on the site's
//   origin;
// - in the site's storage (a service worker, Cache Storage);
// - reaching a page that navigates to the site later (an opener, a frame).
// So the record goes by site, per task, for the task's life. Once the
// agent's code has run in any document of a site, every document of that
// site in the task counts, whatever the path. page.evaluate and
// page.waitForFunction note each site they run in.
//
// An opaque document (a null principal: a sandboxed frame, what one writes
// into its popup) goes by its precursor's site, the site that made it. One
// with no site behind it at all counts as the agent's, record or not: only the
// agent's goto (or the user typing one) makes a top-level data: page, since
// Firefox refuses content's own top-level data: navigation.

import { AGENT_CODE_DOCS_KEY } from "chrome://userscripts/content/zenius/content/refusals.sys.mjs";
import { fromBeforeHold, holdOf } from "chrome://userscripts/content/zenius/observe/hold.sys.mjs";
import { isWritten, onWritten } from "chrome://userscripts/content/zenius/observe/agentworld.sys.mjs";

/** Task (its space id) → the sites (siteOriginNoSuffix) where its agent ran its code. */
const sites = new Map();

// The refusals that hold for a task's whole life stay on a document that may
// hold the agent's code: code the agent left there keeps running after the
// task. The content guards read the marked top documents from sharedData
// (AGENT_CODE_DOCS_KEY), and the parent's local network check asks
// agentCodeDocument(). This module marks a tab's top document as the agent's
// code is about to run in it, during the task, so nothing is unmarked at the
// finish. A mark of the agent's world code lasts only while its world does,
// unless the page is written (forgetWorldMarks, onWritten); the others last
// while their tab lives: a document the tab goes Back to is the same
// document, with the same code.

/** Marked top documents (innerWindowId) → their tab's browserId. */
const agentCodeDocs = new Map();

/**
 * Of those, the ones only the agent's world ran in (page.evaluate,
 * page.waitForFunction). The world holds that code, so the mark goes with the
 * world (forgetWorldMarks), unless the world wrote into the page: a group
 * holds the agent's code only while a page in it has a live world or is
 * written. Every other mark (a page the agent made, its html paste, a written
 * document) stays with the document.
 */
const worldOnly = new Set();

// A written document marks its tab's top for good: the agent's writes may
// run as the page's code later, a Ctrl+V of html included. A top document
// marks itself: one flagged as it comes in (beside a written one of its
// group) isn't its tab's current top here yet.
onWritten(({ browser, innerWindowId }) => {
  let id = 0;
  let browserId = 0;
  try {
    const bc = WindowGlobalParent.getByInnerWindowId(innerWindowId)?.browsingContext;
    const top = bc?.parent ? bc.top : bc;
    id = bc?.parent ? top?.currentWindowGlobal?.innerWindowId : innerWindowId;
    browserId = top?.browserId ?? 0;
  } catch {}
  if (!id || !browserId) {
    const top = browser?.browsingContext?.top;
    id = top?.currentWindowGlobal?.innerWindowId ?? 0;
    browserId = top?.browserId ?? 0;
  }
  if (id) {
    worldOnly.delete(id);
  }
  if (markDoc(id, browserId)) {
    publishAgentCodeDocs();
  }
});

/** Forget the documents (innerWindowId → browserId) whose tab is gone; whether any went. */
function dropClosedTabs(docs) {
  let dropped = false;
  for (const [id, browserId] of docs) {
    if (!BrowsingContext.getCurrentTopByBrowserId(browserId)) {
      docs.delete(id);
      dropped = true;
    }
  }
  return dropped;
}

function publishAgentCodeDocs() {
  dropClosedTabs(agentCodeDocs);
  Services.ppmm.sharedData.set(AGENT_CODE_DOCS_KEY, new Set(agentCodeDocs.keys()));
  Services.ppmm.sharedData.flush();
  marksChanged();
}

let marksListener = null;
let watchingDestroyed = false;

/** `fn()` after the marked documents change (observe/setup.sys.mjs's hooks). */
export function onAgentCodeMarks(fn) {
  marksListener = fn;
}

/** Is any document marked, so its page keeps the task's refusals? */
export function hasAgentCodeMarks() {
  // A mark that goes here goes everywhere, its listener told: else the
  // document's own window-global-destroyed would find nothing to drop.
  if (dropClosedTabs(agentCodeDocs)) {
    publishAgentCodeDocs();
  }
  return agentCodeDocs.size > 0;
}

/** A destroyed document can't come back (a stay in bfcache keeps it): its mark goes. */
function onDocumentDestroyed(windowGlobal) {
  let id = 0;
  try {
    id = windowGlobal.innerWindowId;
  } catch {}
  if (id && agentCodeDocs.delete(id)) {
    publishAgentCodeDocs();
  }
}

function marksChanged() {
  // window-global-destroyed comes for every document, the user's own
  // included: heard only while a document is marked (I4).
  const want = agentCodeDocs.size > 0;
  if (want !== watchingDestroyed) {
    watchingDestroyed = want;
    if (want) {
      Services.obs.addObserver(onDocumentDestroyed, "window-global-destroyed");
    } else {
      Services.obs.removeObserver(onDocumentDestroyed, "window-global-destroyed");
    }
  }
  try {
    marksListener?.();
  } catch (e) {
    console.error("[zenius] agent-code marks listener failed", e);
  }
}

/** Mark the current top document of `bc`'s tab; whether it is new. */
function markTop(bc) {
  const top = bc?.top;
  return markDoc(top?.currentWindowGlobal?.innerWindowId, top?.browserId);
}

/** Mark a top document (innerWindowId) of the tab `browserId`; whether it is new. */
function markDoc(id, browserId) {
  if (!id || !browserId || agentCodeDocs.has(id)) {
    return false;
  }
  agentCodeDocs.set(id, browserId);
  return true;
}

/** The current top BrowsingContext of a <browser>, WindowGlobalParent or BrowsingContext. */
function topOf(target) {
  try {
    return (target?.browsingContext ?? target)?.top ?? null;
  } catch {
    return null;
  }
}

/**
 * Is the tab's current top document one where this module saw the agent's
 * code run? (zen-ux may fold it into its mark.)
 *
 * @param {Element|WindowGlobalParent|BrowsingContext} target
 */
export function agentCodeTop(target) {
  const id = topOf(target)?.currentWindowGlobal?.innerWindowId;
  return !!id && agentCodeDocs.has(id);
}

/** The browserIds of the tabs whose current top document is marked. */
export function agentCodeBrowserIds() {
  const ids = new Set();
  for (const [id, browserId] of agentCodeDocs) {
    try {
      if (BrowsingContext.getCurrentTopByBrowserId(browserId)?.currentWindowGlobal?.innerWindowId === id) {
        ids.add(browserId);
      }
    } catch {}
  }
  return ids;
}

/**
 * The agent's worlds that could reach this tab are gone (observe/agentworld's
 * discard): the mark only world code left goes too, unless the page is
 * written.
 *
 * @param {BrowsingContext} top
 */
export function forgetWorldMarks(top) {
  const id = top?.currentWindowGlobal?.innerWindowId;
  if (!id || !worldOnly.has(id) || isWritten(top)) {
    return;
  }
  worldOnly.delete(id);
  if (agentCodeDocs.delete(id)) {
    publishAgentCodeDocs();
  }
}

/**
 * Do the task-long refusals still hold in this tab after its task: is its
 * current top document marked?
 *
 * @param {Element|WindowGlobalParent|BrowsingContext} target
 */
export function agentCodeDocument(target) {
  return agentCodeTop(target);
}

/** A site (scheme and eTLD+1, no port) for a principal, its precursor's for an opaque one, or a site as given. */
function siteOf(site) {
  try {
    if (typeof site === "string") {
      return site || null;
    }
    if (site instanceof Ci.nsIPrincipal) {
      if (site.isNullPrincipal) {
        const precursor = site.precursorPrincipal;
        return precursor ? siteOf(precursor) : null;
      }
      return site.siteOriginNoSuffix || null;
    }
  } catch {}
  return null;
}

/**
 * An about:blank document. One with no site behind it is a tab zenius or the
 * user opened blank: no other document can script it, so only code run in it
 * writes into it, and that code marks its tab: an untouched about:blank
 * isn't the agent's.
 */
function isBlank(windowGlobal) {
  try {
    return /^about:blank(?:[?#]|$)/.test(windowGlobal?.documentURI?.spec ?? "");
  } catch {
    return false;
  }
}

/** An opaque document with no site behind it (the agent's data: page): all the agent's. */
function isSiteless(principal) {
  try {
    return principal instanceof Ci.nsIPrincipal && principal.isNullPrincipal && !principal.precursorPrincipal;
  } catch {
    return false;
  }
}

/**
 * The agent's code is about to run in `bc`'s current document, for the task
 * `rec`. Call it right before the content call, which goes to that same
 * document. blob: and about:blank documents go by their principal's site.
 *
 * @param {{id: number}} rec  the task's space record
 * @param {BrowsingContext} bc  the frame the code runs in
 */
export function noteAgentCode(rec, bc, { world = false } = {}) {
  endCleanCopies(bc);
  // The tab's top document, whatever the site: the code can reach the
  // whole page from there.
  const id = bc?.top?.currentWindowGlobal?.innerWindowId;
  const fresh = markTop(bc);
  if (world && fresh && id && !isWritten(bc)) {
    worldOnly.add(id);
  } else if (!world && id) {
    worldOnly.delete(id);
  }
  if (fresh) {
    publishAgentCodeDocs();
  }
  if (rec?.id === undefined || rec.id === null) {
    return;
  }
  const site = siteOf(bc?.currentWindowGlobal?.documentPrincipal);
  if (!site) {
    return;
  }
  let ran = sites.get(rec.id);
  if (!ran) {
    sites.set(rec.id, (ran = new Set()));
  }
  ran.add(site);
}

/**
 * Whether the agent's code ran on `site`'s site in the task `rec`, at any
 * time in the task, in any of its documents.
 *
 * @param {{id: number}} rec  the task's space record
 * @param {nsIPrincipal|string} site  a principal (a document's), or a site
 *   as `siteOriginNoSuffix` gives it
 * @returns {boolean}
 */
export function agentCodeOnSite(rec, site) {
  if (isSiteless(site)) {
    return true;
  }
  const want = siteOf(site);
  return !!want && !!sites.get(rec?.id)?.has(want);
}

/**
 * Whether the page in `browser` shows a site where the task's agent ran its
 * code: its top document's or any frame's. zen-ux asks at a handOff or a
 * takeover, and again at each of the page's navigations while the user
 * holds the task. Pass the <browser> that holds the page (zen-core's
 * `pages.tabFor`), whether or not the tab is still one of the task's pages.
 *
 * @param {{id: number}} rec  the task's space record
 * @param {Element} browser
 * @returns {boolean}
 */
export function agentCodeInPage(rec, browser) {
  return siteRanIn(rec, topOf(browser));
}

/**
 * agentCodeInPage for a tab's top BrowsingContext, over the documents
 * `counts` lets through (all by default).
 */
function siteRanIn(rec, top, counts = () => true) {
  const ran = sites.get(rec?.id);
  let contexts = [];
  try {
    contexts = top?.getAllBrowsingContextsInSubtree() ?? [];
  } catch {}
  return contexts.some(bc => {
    const windowGlobal = bc.currentWindowGlobal;
    if (!windowGlobal || !counts(windowGlobal)) {
      return false;
    }
    const principal = windowGlobal.documentPrincipal;
    if (isSiteless(principal)) {
      return !isBlank(windowGlobal);
    }
    const site = siteOf(principal);
    return !!site && !!ran?.has(site);
  });
}

/**
 * The top documents (innerWindowId → browserId) that tabs of the user's
 * showed when the agent adopted them: the user's, even a blank one where
 * the agent's code then ran.
 */
const adoptedDocs = new Map();

/**
 * zen-core's pages.adopt calls this as a tab joins a task. A tab of the
 * user's (not one the agent opened) shows the user's document, so
 * agentMadePage never calls it the agent's. Documents the tab loads later
 * follow the usual rule.
 *
 * @param {Element} browser  the adopted tab's <browser>
 * @param {string} openedBy  zen-core's: "agent" for a tab the agent opened
 */
export function noteAdopted(browser, openedBy) {
  if (openedBy === "agent") {
    return;
  }
  let top = null;
  try {
    top = browser?.browsingContext?.top ?? null;
  } catch {}
  const id = top?.currentWindowGlobal?.innerWindowId;
  if (!id) {
    return;
  }
  dropClosedTabs(adoptedDocs);
  adoptedDocs.set(id, top.browserId);
}

/** Addresses no website serves: documents script made or wrote, and the agent's own. */
const MADE_URL = /^(?:about:(?:blank|srcdoc)(?:[?#]|$)|data:|blob:)/i;

/**
 * Whether the page's top document is one the agent may have made itself,
 * not a page a website served. zen-ux's pill then says the agent made the
 * page and offers no own tab. Its address is about:blank, about:srcdoc,
 * data: or blob: (what script makes or writes, and the agent's own data:
 * page), and either it has no site behind it, or its site (the precursor's,
 * for an opaque one) is one where the agent's code ran in the task.
 *
 * A page served over http(s) never counts, even a CSP-sandboxed (opaque)
 * one. Nor does the document a tab of the user's showed when the agent
 * adopted it (noteAdopted), such as their blank New Tab: the user made it. Nor does a popup another document filled with document.write: Gecko
 * gives it the writer's URL, as the HTML spec says, so it reads as the
 * writer's page. agentCodeInPage covers both, and the user's own tab at that
 * URL is the real page.
 *
 * @param {{id: number}} rec  the task's space record
 * @param {Element} browser  the <browser> that holds the page
 * @returns {boolean}
 */
export function agentMadePage(rec, browser) {
  let windowGlobal = null;
  let spec = "";
  try {
    windowGlobal = browser?.browsingContext?.currentWindowGlobal ?? null;
    spec = windowGlobal?.documentURI?.spec ?? "";
  } catch {}
  if (!windowGlobal || adoptedDocs.has(windowGlobal.innerWindowId)) {
    return false;
  }
  const principal = windowGlobal.documentPrincipal;
  if (isSiteless(principal) && isBlank(windowGlobal)) {
    // Blank and untouched, unless the agent's code ran in it and wrote it.
    return agentCodeDocument(browser);
  }
  // agentCodeOnSite also answers true for a document with no site behind it.
  return !!principal && MADE_URL.test(spec) && agentCodeOnSite(rec, principal);
}

/** The sites (siteOriginNoSuffix) of a tab's documents, its frames' too; none for an opaque one, which nothing can script. */
function sitesIn(top) {
  const found = new Set();
  try {
    for (const bc of top.getAllBrowsingContextsInSubtree()) {
      const principal = bc.currentWindowGlobal?.documentPrincipal;
      if (principal?.isContentPrincipal && principal.siteOriginNoSuffix) {
        found.add(principal.siteOriginNoSuffix);
      }
    }
  } catch {}
  return found;
}

/**
 * May the agent's code be in this tab's documents? Its top document is
 * marked, or, while the task lives, one of its documents shows a site where
 * the task's agent ran code, other than the fresh ones: a held tab's made
 * since its hold began, a window's that zen-core reloaded for a hold
 * (holdReload), and a clean copy's (noteCleanLoad).
 */
function mayHoldCode(rec, live, tab) {
  return (
    agentCodeDocument(tab) ||
    (live &&
      siteRanIn(rec, tab, windowGlobal => fromBeforeHold(tab.browserId, windowGlobal.innerWindowId) && fromBeforeClean(tab.browserId, windowGlobal.innerWindowId)))
  );
}

/**
 * Tabs zenius loaded afresh (zen-core's cleanLoad: the clean copy on demand
 * at the user's press, Resume's reload, the hand-off's own loads):
 * browserId → the tab's documents (innerWindowId) just before the load. The
 * documents the load brought hold nothing of the agent's, so the site rule
 * skips them, as it skips a hold's fresh ones (fromBeforeHold). Once the
 * agent's code runs anywhere in the tab's group again, a world could leave
 * code or form values in them (a form value is no write), so they count by
 * site again (noteAgentCode).
 */
const cleanLoaded = new Map();

/**
 * zen-core's cleanLoad, just before it loads `browser`'s page afresh.
 *
 * @param {Element} browser
 */
export function noteCleanLoad(browser) {
  let top = null;
  try {
    top = browser?.browsingContext?.top ?? null;
  } catch {}
  if (!top?.browserId) {
    return;
  }
  const docs = new Set();
  try {
    for (const bc of top.getAllBrowsingContextsInSubtree()) {
      const id = bc.currentWindowGlobal?.innerWindowId;
      if (id) {
        docs.add(id);
      }
    }
  } catch {}
  cleanLoaded.set(top.browserId, docs);
}

/** Is this document of the tab one from before zenius last loaded the tab afresh (or did it never)? */
function fromBeforeClean(browserId, innerWindowId) {
  const docs = cleanLoaded.get(browserId);
  return !docs || docs.has(innerWindowId);
}

/** The agent's code runs in `bc`'s group: the clean copies there count by site again; closed tabs' records go. */
function endCleanCopies(bc) {
  if (!cleanLoaded.size) {
    return;
  }
  let group = null;
  try {
    group = bc?.group?.id ?? null;
  } catch {}
  if (group === null) {
    // Fail closed: with no group to tell them apart, every clean copy
    // counts by site again.
    cleanLoaded.clear();
    return;
  }
  for (const browserId of [...cleanLoaded.keys()]) {
    let top = null;
    try {
      top = BrowsingContext.getCurrentTopByBrowserId(browserId);
    } catch {}
    let same = true;
    try {
      same = !!top && top.group?.id === group;
    } catch {}
    if (!top || same) {
      cleanLoaded.delete(browserId);
    }
  }
}

/** The other live tops of `top`'s browsing context group, less those in its hold. */
function othersOutsideHold(top) {
  const hold = holdOf(top);
  let tops = [];
  try {
    tops = top.group?.getToplevels() ?? [];
  } catch {}
  return tops.filter(other => {
    try {
      return other.id !== top.id && !other.isDiscarded && (hold === undefined || holdOf(other) !== hold);
    } catch {
      return false;
    }
  });
}

/**
 * The sites of the documents in the windows of H's group, outside its
 * hold, that may hold the agent's code. A document of one of these sites in
 * H could be reached from there, through top, opener and frames, and
 * scripted (document.domain joins a site's origins). During a hold, a frame
 * of such a site in H is refused (observe/navguard.sys.mjs), and a load
 * that would make H's top one gets zen-core's COOP (holdNeedsCoop).
 *
 * @param {{id: number}|null} rec  the task's space record while it lives, else null
 * @param {Element|BrowsingContext} browser  H's <browser>, or a BrowsingContext in it
 * @returns {Set<string>}
 */
export function agentSitesNear(rec, browser) {
  const found = new Set();
  const top = topOf(browser);
  if (!top) {
    return found;
  }
  const live = rec?.id !== undefined && rec?.id !== null;
  for (const other of othersOutsideHold(top)) {
    try {
      if (mayHoldCode(rec, live, other)) {
        for (const site of sitesIn(other)) {
          found.add(site);
        }
      }
    } catch {}
  }
  return found;
}

/** A finished task's record goes: its pages are the user's, or closed. */
export function sweepAgentCode(finishedSpaceId) {
  if (finishedSpaceId !== undefined) {
    sites.delete(finishedSpaceId);
  }
}
