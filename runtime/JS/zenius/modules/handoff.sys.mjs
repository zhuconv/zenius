// zen-core: the page the user holds (H), at an agent's hand-off or the
// user's Take over, for the manager's rule of 2026-11-20. In this order:
// nothing of the agent's can reach what the user types in H; H keeps its
// opener when it can; only documents that may hold the agent's code reload.
// zen-observe's handOffCheck says where that code may be
// (observe/agentcode.sys.mjs), and its holdPage keeps everything else away
// while the user holds H (observe/hold.sys.mjs). This module picks the
// remedy and does the loads.
//
// A quiet load (cleanLoad) brings the page's URL again as a new GET entry in
// place of the current one. A POST result is never resubmitted, and Gecko
// restores no form state: a plain reload puts hidden inputs back too, where
// the agent may have planted a payee or a redirect (measured on Gecko 160,
// 2026-11-20). The visible, ordinary fields come back explicitly, secrets
// never (content/forms.sys.mjs). A load into a group of its own (`newGroup`)
// gets COOP same-origin-allow-popups on that one response, and Gecko then
// replaces the tab's browsing context, as for any COOP change: other
// windows' handles to it read closed and its opener is cut, while the
// popups it opens later keep theirs.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});
// zen-observe's modules, whole, once a hold needs them.
Object.defineProperties(lazy, {
  agentCode: { get: () => ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs") },
  hold: { get: () => ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/hold.sys.mjs") },
});

/** How long a quiet load may take to bring a new document. */
const LOAD_TIMEOUT_MS = 15000;
/** How long every process gets to end the agent's sandboxes (zen-observe's discard). */
const DISCARD_TIMEOUT_MS = 10000;
const RECORD_TIMEOUT_MS = 3000;
/** fill() waits for the new document's load event, up to 5 s, first. */
const FILL_TIMEOUT_MS = 8000;
const COOP = "Cross-Origin-Opener-Policy";
const RESPONSE_TOPICS = ["http-on-examine-response", "http-on-examine-cached-response", "http-on-examine-merged-response"];
/**
 * How long the quiet load's window stays open after the fill: a site's page
 * that sends itself on as it loads does it by then (its own
 * location.replace, at once or on load).
 */
const SETTLE_MS = 300;

/**
 * The group switch waits on the user's decision about the isolated world
 * (the manager, 2026-11-20): with the agent's code in sandboxes zenius
 * discards at the hand-off, other windows' handles reach only the site's
 * own code. Off, the windows that could reach H load afresh in place
 * instead, and a load during the hold gets no COOP.
 */
const GROUP_SWITCH_PREF = "zenius.handoff.groupSwitch";
const groupSwitchOn = () => Services.prefs.getBoolPref(GROUP_SWITCH_PREF, false);
/**
 * Tests of the hold's other layers (the refusals that apply to code planted
 * before a hold) turn the quiet loads off, to keep that code; never off
 * otherwise.
 */
const QUIET_RELOAD_PREF = "zenius.handoff.quietReload";

/** @type {object|null} ZeniusService, for the response hook */
let service = null;
/** Tabs (browserId) whose next document response goes into a group of its own. */
const coopLoads = new Set();
/**
 * Tabs (browserId) whose quiet load must stay on the page's site: the site
 * it started on, and the URL of a redirect off it that zenius stopped.
 *
 * @type {Map<number, {site: string, stopped: string|null}>}
 */
const quietSites = new Map();
/** Space id → the <browser>s zenius holds for the user in that task. */
const holds = new Map();
let hookOn = false;

/** zen-input's: typing to the page is dropped until the returned function is called (input/typing.sys.mjs). */
function dropTyping(browser) {
  try {
    const typing = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/typing.sys.mjs");
    const release = typing.dropUserTyping?.(browser);
    return typeof release === "function" ? release : null;
  } catch {
    return null;
  }
}

function within(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => lazy.setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms)),
  ]);
}

/** The tab's first document after `before`, once it's there. */
async function newDocument(browser, before, ms, stopped = () => null) {
  const end = Date.now() + ms;
  for (;;) {
    const why = stopped();
    if (why) {
      throw new Error(why);
    }
    const windowGlobal = browser.browsingContext?.currentWindowGlobal;
    if (windowGlobal && windowGlobal.innerWindowId !== before && !windowGlobal.isInitialDocument) {
      return windowGlobal;
    }
    if (Date.now() > end) {
      throw new Error(`no new document came in ${ms / 1000} s`);
    }
    await new Promise(resolve => lazy.setTimeout(resolve, 25));
  }
}

function aloneInGroup(bc) {
  try {
    return bc.group.getToplevels().every(top => top.browserId === bc.browserId);
  } catch {
    return false;
  }
}

/**
 * The site a quiet load must stay on: eTLD+1, or the host of an IP address
 * or localhost; no scheme, so a site's move to https stays on it. Null for
 * a page with no site (about:, data:), which no redirect leaves.
 */
function siteOf(uri) {
  try {
    if (!uri || !(uri.schemeIs("http") || uri.schemeIs("https"))) {
      return null;
    }
    return Services.scriptSecurityManager.createContentPrincipal(uri, {}).baseDomain || uri.host || null;
  } catch {
    return null;
  }
}

/**
 * Where a quiet load goes when the URL the page shows would take it off its
 * site: the URL that brought the document (forms#record's loadedFrom),
 * without its fragment, on the shown URL's origin (pushState and
 * replaceState never leave it). Null when there's none, or it's the load
 * that was just stopped (`tried`).
 *
 * @param {string|null|undefined} spec
 * @param {nsIURI} shown
 * @param {nsIURI} tried
 * @returns {nsIURI|null}
 */
function loadedFromURL(spec, shown, tried) {
  try {
    const url = spec ? Services.io.newURI(spec) : null;
    if (!url || !(url.schemeIs("http") || url.schemeIs("https")) || url.prePath !== shown.prePath) {
      return null;
    }
    const bare = url.mutate().setRef("").finalize();
    return bare.equalsExceptRef(tried) ? null : bare;
  } catch {
    return null;
  }
}

/** Where a redirect response sends the load, or null. */
function redirectTarget(channel) {
  try {
    return Services.io.newURI(channel.getResponseHeader("Location"), null, channel.URI);
  } catch {
    return null;
  }
}

let requestHookOn = false;

/**
 * While a quiet load that must stay on its site is under way, no document
 * request of its tab goes to another site: a redirect's, or one the
 * page's own script starts as it loads (zen-snapshot's
 * siteRouterJsRedirect). It's cancelled before it's sent.
 */
const requestHook = {
  observe(subject) {
    try {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const loadInfo = channel.loadInfo;
      if (loadInfo.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT) {
        return;
      }
      const quiet = quietSites.get(BrowsingContext.get(loadInfo.browsingContextID)?.browserId);
      if (quiet && siteOf(channel.URI) !== quiet.site) {
        quiet.stopped ??= channel.URI.spec;
        channel.cancel(Cr.NS_BINDING_ABORTED);
        log("a load of another site during a quiet load was stopped");
      }
    } catch {}
  },
};

function syncResponseHook() {
  const wantRequests = quietSites.size > 0;
  if (wantRequests !== requestHookOn) {
    requestHookOn = wantRequests;
    if (wantRequests) {
      Services.obs.addObserver(requestHook, "http-on-modify-request");
    } else {
      Services.obs.removeObserver(requestHook, "http-on-modify-request");
    }
  }
  const want = coopLoads.size > 0 || holds.size > 0 || quietSites.size > 0;
  if (want === hookOn) {
    return;
  }
  hookOn = want;
  for (const topic of RESPONSE_TOPICS) {
    if (want) {
      Services.obs.addObserver(responseHook, topic);
    } else {
      Services.obs.removeObserver(responseHook, topic);
    }
  }
}

/**
 * COOP on this response, unless the site sends its own: same-origin is
 * stricter than what zenius would add, and same-origin-allow-popups is it.
 * The caller checks the result in the new document (aloneInGroup).
 */
function setCoop(channel) {
  let sent = "";
  try {
    sent = channel.getResponseHeader(COOP).trim().toLowerCase();
  } catch {}
  if (!sent || sent === "unsafe-none") {
    channel.setResponseHeader(COOP, "same-origin-allow-popups", false);
  }
}

/**
 * Would H's top, on `uri`'s site, share its group with a window outside its
 * hold that holds what the agent's world wrote (ZeniusService.isWritten) and
 * shows that site? An error counts as yes.
 */
function reachesWritten(bc, uri) {
  try {
    const site = siteOf(uri);
    const top = bc.top;
    const hold = lazy.hold.holdOf(top);
    return top.group.getToplevels().some(other => {
      if (other.id === top.id || other.isDiscarded || (hold !== undefined && lazy.hold.holdOf(other) === hold)) {
        return false;
      }
      return (
        !!service?.isWritten(other) &&
        other.getAllBrowsingContextsInSubtree().some(c => {
          const doc = c.currentWindowGlobal?.documentURI;
          return !!doc && siteOf(doc) === site;
        })
      );
    });
  } catch (e) {
    log("checking for written windows next to the held page failed, so its load leaves the group:", e.message);
    return true;
  }
}

/** During a hold, a load that zen-observe says would bring H next to the agent's code (holdNeedsCoop). */
function holdNeedsCoop(bc, uri) {
  const hold = lazy.hold;
  if (typeof hold.holdNeedsCoop !== "function" || hold.holdOf(bc) === undefined) {
    return false;
  }
  const browser = bc.embedderElement;
  const rec = browser ? (service?.controlOf(browser)?.space ?? null) : null;
  try {
    return !!hold.holdNeedsCoop(rec, browser, uri);
  } catch (e) {
    log("holdNeedsCoop failed", e.message);
    return false;
  }
}

// Every document response passes here while zenius holds a page or waits for
// a load of its own: the user's browsing too, so only then (I4).
const responseHook = {
  observe(subject) {
    let channel = null;
    let bc = null;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const loadInfo = channel.loadInfo;
      if (loadInfo.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT) {
        return;
      }
      bc = BrowsingContext.get(loadInfo.browsingContextID);
    } catch {
      return;
    }
    const browserId = bc?.browserId;
    if (!browserId) {
      return;
    }
    let status = 0;
    try {
      status = channel.responseStatus;
    } catch {}
    // COOP counts on the final response, not on a redirect's.
    if (status >= 300 && status < 400) {
      // zen-snapshot's siteRouterRedirect: the site's own router can put
      // its open redirect in the URL (pushState accepts any same-origin
      // one), so zenius's quiet load of the page would carry the user to
      // another site. The load stops here, before anything of that site
      // loads; the old document stays, and the hand-off is refused.
      const quiet = quietSites.get(browserId);
      const to = quiet ? redirectTarget(channel) : null;
      if (to && siteOf(to) !== quiet.site) {
        quiet.stopped = to.spec;
        channel.cancel(Cr.NS_BINDING_ABORTED);
        log("a quiet load's redirect to another site was stopped");
      }
      return;
    }
    if (coopLoads.has(browserId)) {
      coopLoads.delete(browserId);
      setCoop(channel);
      return;
    }
    // Never reachable: with the group switch off, a window the load would
    // bring H next to has had its agent's code discarded, so only one that
    // still holds the world's writes needs H out of the group.
    if (!holds.size || !holdNeedsCoop(bc, channel.URI) || !(groupSwitchOn() || reachesWritten(bc, channel.URI))) {
      return;
    }
    setCoop(channel);
    log("the held page leaves its group as it loads a site where the agent's code may run");
    if (bc.opener) {
      const control = bc.embedderElement ? service?.controlOf(bc.embedderElement) : null;
      if (control) {
        service.spaces.noteOpenerCut(control.space);
      }
    }
  },
};

/**
 * Load the page in `browser` afresh, quietly (see the top of this file):
 * typing to it is dropped meanwhile (zen-input), its visible ordinary
 * fields come back, and so does the focus, in the field that had it.
 *
 * Fields come back only into a document of the same origin: the user's
 * typing never goes to another site's page.
 *
 * It loads the URL the page had before the agent's code last changed it in
 * place (zen-observe's urlBefore, the manager's rule for Take over), while
 * the page still shows the URL the agent's code set; else the current one.
 * The site's own routing (its pushState) stays the target.
 *
 * @param {object} svc  ZeniusService
 * @param {Element} browser
 * @param {{newGroup?: boolean, sameSite?: boolean}} [opts]
 *   sameSite: the load must end on the page's site (the page the user is
 *   about to hold): a redirect off it, or a load of another site that the
 *   new document starts, is stopped before it's sent. The site's own router
 *   can show its open redirect (zen-snapshot's siteRouterRedirect), so the
 *   load then goes once more, to the URL that brought the document
 *   (loadedFromURL), stopped off the site the same way; if there's no such
 *   URL, or it's stopped too, the load fails (the manager, 2026-11-21)
 *   writtenFails: the clean copy on demand. A load whose document comes in
 *   written fails (`stillWritten` on the error), the tab's typing held on
 *   it and nothing replayed
 * @returns {Promise<{how: "reload"|"get", alone: boolean, openerCut: boolean, carried: boolean, focused: boolean, urlBefore: string|null, loadedFrom: string|null}>}
 *   how: "get" when a POST result was loaded again by GET; loadedFrom: the
 *   URL that brought the document, when the load went there instead
 */
export async function cleanLoad(svc, browser, { newGroup = false, sameSite = false, writtenFails = false } = {}) {
  service = svc;
  const bc = browser?.browsingContext;
  const windowGlobal = bc?.currentWindowGlobal;
  if (!bc || !windowGlobal) {
    throw new Error("the page has no document");
  }
  let post = false;
  try {
    const history = bc.sessionHistory;
    post = !!history?.getEntryAtIndex(history.index)?.postData;
  } catch {}
  const hadOpener = !!bc.opener;
  const release = dropTyping(browser);
  let form = null;
  let trouble = null;
  try {
    form = await within(svc.content(bc, "forms#record", {}), RECORD_TIMEOUT_MS, "recording the form");
  } catch (e) {
    trouble = `record: ${e.message}`;
    log("the quiet load carries no form over:", e.message);
  }
  const before = windowGlobal.innerWindowId;
  const origin = windowGlobal.documentPrincipal?.originNoSuffix ?? null;
  const uri = browser.currentURI;
  let back = null;
  try {
    const url = svc.urlBefore?.(browser);
    back = url ? Services.io.newURI(url) : null;
    // Only the fragment differs: that load would only scroll the document.
    if (back?.hasRef && back.specIgnoringRef === uri.specIgnoringRef) {
      back = back.mutate().setRef("").finalize();
    }
  } catch (e) {
    log("the URL from before the agent's change didn't parse; the quiet load goes to the current one:", e.message);
    back = null;
  }
  const site = sameSite ? siteOf(uri) : null;
  const quiet = site ? { site, stopped: null } : null;
  // Null: a reload of the URL shown (only its fragment would change). A
  // POST result goes again by GET.
  const first = !back && !post && uri.hasRef ? null : (back ?? (post ? uri.mutate().setRef("").finalize() : uri));
  const instead = quiet ? loadedFromURL(form?.loadedFrom, uri, first ?? uri) : null;
  if (quiet) {
    quietSites.set(browser.browserId, quiet);
  }
  if (newGroup) {
    coopLoads.add(browser.browserId);
  }
  syncResponseHook();
  // zen-observe's glue: what this load brings holds nothing of the agent's,
  // so handOffCheck doesn't count it by site (a clean copy isn't reloaded
  // again at Take over, zen-sdk's rehearsal on 424962d).
  try {
    lazy.agentCode.noteCleanLoad?.(browser);
  } catch (e) {
    log("zen-observe's note of a clean load failed:", e.message);
  }
  try {
    const offSite = url => `it would have gone to ${url}, on another site, so zenius stopped that load`;
    /** One load to `target` (null: the reload), until its document is there, filled, and settled on the site. */
    const loadOnce = async (target, since) => {
      if (target) {
        browser.loadURI(target, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
        });
      } else {
        // The same URL with its fragment would only scroll the old document. A
        // reload that bypasses the cache restores no form state either.
        browser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
      }
      // Tests shorten the wait (service.quietLoadTimeoutMs).
      const fresh = await newDocument(browser, since, svc.quietLoadTimeoutMs ?? LOAD_TIMEOUT_MS, () => quiet?.stopped && offSite(quiet.stopped));
      // A way off the site that the response hook didn't see (a service
      // worker's redirect, say): the document is there, but the user doesn't
      // get it.
      if (quiet && siteOf(fresh.documentURI) !== quiet.site) {
        throw Object.assign(new Error(`it ended on ${fresh.documentURI?.spec}, on another site`), { offSite: fresh.documentURI?.spec ?? null });
      }
      let filled = 0;
      let focused = false;
      const sameOrigin = !!origin && fresh.documentPrincipal?.originNoSuffix === origin;
      if (!sameOrigin && (form?.fields?.length || form?.focused)) {
        trouble = "another origin";
        log("the fresh document is of another origin, so no field comes back");
      }
      if (sameOrigin && (form?.fields?.length || form?.focused)) {
        try {
          ({ filled = 0, focused = false } = await within(
            svc.content(fresh.browsingContext, "forms#fill", form),
            FILL_TIMEOUT_MS,
            "filling the form"
          ));
        } catch (e) {
          trouble = `fill: ${e.message}`;
          log("carrying the form over failed:", e.message);
        }
      }
      // What the carry-over saw, as counts, for a test or a bug report that
      // finds the fields missing (zen-ux's carried false once under a loaded
      // test-all, 2026-11-20, not reproduced since).
      svc.lastQuietLoad = { recorded: form ? (form.fields?.length ?? 0) : null, focus: !!form?.focused, filled, trouble };
      if (quiet) {
        const end = Date.now() + SETTLE_MS;
        while (!quiet.stopped && Date.now() < end) {
          await new Promise(resolve => lazy.setTimeout(resolve, 25));
        }
        const now = browser.browsingContext?.currentWindowGlobal;
        if (quiet.stopped) {
          throw new Error(offSite(quiet.stopped));
        }
        if (now && siteOf(now.documentURI) !== quiet.site) {
          throw Object.assign(new Error(`it ended on ${now.documentURI?.spec}, on another site`), { offSite: now.documentURI?.spec ?? null });
        }
      }
      return { filled, focused };
    };
    let done;
    let wentInstead = false;
    try {
      done = await loadOnce(first, before);
    } catch (e) {
      // Only a load zenius stopped on its way off the site goes again, once,
      // to the URL that brought the document; that one is stopped the same
      // way. The fields come back from the record of the first document.
      if (!quiet?.stopped || !instead) {
        throw e;
      }
      log("the quiet load would have left the site, so it goes to the URL that brought the page's document");
      quiet.stopped = null;
      if (newGroup) {
        coopLoads.add(browser.browserId);
      }
      // The first load may have brought a document before it was stopped.
      done = await loadOnce(instead, browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? before);
      wentInstead = true;
    }
    // Beside a window of its group that still holds the agent's writes (a
    // popup on its site, or the page that opened it), a new document comes
    // in written too (zen-observe's flagIfExposed). The user's typing can't
    // go into that copy, and its replay would be their next trigger there:
    // on 99cdc39 the page loaded afresh again and again (zen-snapshot's Take
    // over probes). The settle above gave content's flag time to come.
    if (writtenFails && svc.isWritten(browser)) {
      release?.({ failed: true, holdNow: true });
      throw Object.assign(
        new Error(
          "the clean copy came in written too: a window of its group still holds the agent's writes (a popup on its site, or the page that opened it). The user's typing there stays held until that window closes and the page loads again"
        ),
        { stillWritten: true }
      );
    }
    release?.();
    const now = browser.browsingContext;
    return {
      how: post && !back ? "get" : "reload",
      alone: aloneInGroup(now),
      openerCut: hadOpener && !now.opener,
      carried: done.filled > 0,
      focused: done.focused,
      urlBefore: back?.spec ?? null,
      loadedFrom: wentInstead ? instead.spec : null,
    };
  } catch (e) {
    // No new document: the old one may still hold the agent's code, so
    // typing stays dropped until one commits (zen-input).
    release?.({ failed: true });
    // The last load was stopped on its way off the site: where it would
    // have gone (holdFor's data.offSite).
    if (quiet?.stopped && e && typeof e === "object" && !e.offSite) {
      e.offSite = quiet.stopped;
    }
    throw e;
  } finally {
    if (quiet) {
      quietSites.delete(browser.browserId);
    }
    if (newGroup) {
      coopLoads.delete(browser.browserId);
    }
    syncResponseHook();
  }
}

/**
 * The manager's channel mute (2026-11-20): close the BroadcastChannels and
 * shared-worker ports H's documents opened before the hold, in each of them
 * (zen-observe's content/refusals.sys.mjs, muteChannels). Opened in the
 * task's scope, they let H hear the task's pages, and them H, both ways;
 * what H opens from now on gets the held scope. It runs after the
 * agent-page check, so a hand-off refused there leaves the site's channels
 * open. A document that went away meanwhile took its channels with it.
 */
async function muteHeldChannels(svc, browser) {
  const calls = [];
  try {
    for (const bc of browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? []) {
      if (bc.currentWindowGlobal) {
        calls.push(svc.content(bc, "refusals#muteChannels", {}).catch(e => log("muting a held document's channels:", e.message)));
      }
    }
  } catch (e) {
    log("muting the held page's channels failed:", e.message);
  }
  await Promise.all(calls);
}

function refused(svc, browser, reason, message) {
  const page = svc.pages.forBrowser?.(browser)?.label ?? null;
  return new ZenError("ZEN_HANDOFF_REFUSED", message, { page, reason });
}

/**
 * The user is about to hold the page in `browser` (H): hold it
 * (zen-observe's holdPage), then make it safe as the manager's rule says.
 * zen-observe's handOffCheck decides what may hold the agent's code: its
 * `page` is the one predicate for H's own reload.
 * - H's own documents may hold the agent's code, and no other window of its
 *   group that may hold it shares a site with H: H reloads in place, and
 *   keeps its opener.
 * - Such a window exists: those windows reload in place, and H keeps its
 *   group and opener. With the group switch on (GROUP_SWITCH_PREF), H
 *   reloads into a group of its own instead, unless its opener is on
 *   another site (zen-observe's opener "other"), whose sign-in flow the
 *   switch would cut.
 * - Afterwards nothing may still reach H. If something does, those windows
 *   reload in place (the last resort), and if even then, the hold is refused.
 * A page the agent made (data:, blob:, a written about:blank) is held and
 * left as it is (`agentPage`). With `refuseAgentPage` (the agent's own
 * hand-off) nothing else happens, and the caller refuses it.
 *
 * Before any load, the agent's sandboxes go, with the workers they started,
 * in every process (zen-observe's discard, the user's decision (A)): what
 * the agent's code left running can't act on H or on the loads.
 *
 * @param {object} svc  ZeniusService
 * @param {object} rec  the live task's SpaceRecord
 * @param {Element} browser  H's <browser>
 * @param {{refuseAgentPage?: boolean}} [opts]
 * @returns {Promise<{agentPage: boolean, how: "reload"|"get"|null, reloaded: Element[], carried: boolean, openerCut: boolean}>}
 *   how: H's own load, if it had one; reloaded: every tab loaded afresh
 * @throws {ZenError} ZEN_HANDOFF_REFUSED (reason "discardFailed", "reloadFailed" or "reachable"), with the hold released;
 *   a "reloadFailed" whose load of H would have left H's site has data.offSite, the other site's URL
 */
export async function holdFor(svc, rec, browser, { refuseAgentPage = false } = {}) {
  service = svc;
  const { hold, agentCode } = lazy;
  if (!hold.holdPage(browser)) {
    throw new ZenError("ZEN_PAGE_NOT_FOUND", "the page has no document to hold");
  }
  let held = holds.get(rec.id);
  if (!held) {
    holds.set(rec.id, (held = new Set()));
  }
  held.add(browser);
  syncResponseHook();
  const result = { agentPage: false, how: null, reloaded: [], carried: false, openerCut: false };
  // Each quiet load says where and why in the log (zen-sdk's ask): the user
  // sees only a reload.
  const loadH = async (newGroup, why) => {
    log(`the held page loads afresh ${newGroup ? "into a new window group" : "in place"}: ${why}`);
    const r = await cleanLoad(svc, browser, { newGroup, sameSite: true });
    result.how ??= r.how;
    result.carried ||= r.carried;
    result.openerCut ||= r.openerCut;
    if (!result.reloaded.includes(browser)) {
      result.reloaded.push(browser);
    }
  };
  const loadOther = async (other, why) => {
    log(`${svc.pages.forBrowser?.(other)?.label ?? "a page"}, which could reach the held page, loads afresh in place: ${why}`);
    // Its documents from now on are fresh for handOffCheck, as H's are
    // (zen-observe's holdReload): nothing of its site with the agent's code
    // is left in H's group to script them, and codeRefusal refuses new code
    // there for the whole hold.
    hold.holdReload?.(other, browser);
    try {
      await cleanLoad(svc, other);
    } catch (e) {
      const label = svc.pages.forBrowser?.(other)?.label;
      throw refused(
        svc,
        browser,
        "reloadFailed",
        `${label ?? "A page that could reach it"}, which may hold the agent's code, didn't load afresh (${e.message}). Call task.handOff() again once; if it fails again, tell the user in your reply and go on without the hand-off.`
      );
    }
    if (!result.reloaded.includes(other)) {
      result.reloaded.push(other);
    }
  };
  try {
    let check = agentCode.handOffCheck(rec, browser);
    result.agentPage = !!check.agentPage;
    if (result.agentPage && refuseAgentPage) {
      // Refused: the agent keeps its code.
      return result;
    }
    try {
      await within(
        Promise.all([svc.discardAgentCode({ task: rec.id }), muteHeldChannels(svc, browser)]),
        DISCARD_TIMEOUT_MS,
        "stopping the agent's code and muting the page's channels"
      );
    } catch (e) {
      throw refused(
        svc,
        browser,
        "discardFailed",
        `The agent's code in the task's pages didn't stop (${e.message}). Call task.handOff() again once; if it fails again, tell the user in your reply and go on without the hand-off.`
      );
    }
    if (result.agentPage) {
      return result;
    }
    if (!Services.prefs.getBoolPref(QUIET_RELOAD_PREF, true)) {
      log("the hand-off's quiet loads are off (a test of the hold's other layers)");
      return result;
    }
    if (check.reaching.length && check.opener !== "other" && groupSwitchOn()) {
      const n = check.reaching.length;
      await loadH(true, `${n} ${n === 1 ? "window" : "windows"} of its group may hold the agent's code`);
    } else {
      for (const { browser: other } of check.reaching) {
        if (other) {
          await loadOther(other, "it may hold the agent's code");
        }
      }
      if (check.page) {
        await loadH(false, "its document may hold the agent's code");
      }
    }
    check = agentCode.handOffCheck(rec, browser);
    if (check.page || check.reaching.length) {
      log(`the held page can still be reached (page: ${check.page}, windows: ${check.reaching.length}): they reload in place`);
      for (const { browser: other } of check.reaching) {
        if (other) {
          await loadOther(other, "it may still hold the agent's code");
        }
      }
      if (check.page) {
        await loadH(false, "its document may still hold the agent's code");
      }
      check = agentCode.handOffCheck(rec, browser);
      if (check.page || check.reaching.length) {
        throw refused(
          svc,
          browser,
          "reachable",
          "Another of the task's pages on the same site may still hold the agent's code and could reach the page. Close the task's other pages on that site (page.close()), then call task.handOff() again."
        );
      }
    }
    return result;
  } catch (e) {
    releaseHold(rec, browser);
    const error =
      e instanceof ZenError
        ? e
        : refused(
            svc,
            browser,
            "reloadFailed",
            `The page didn't load afresh (${e.message}). Call task.handOff() again once; if it fails again, tell the user in your reply and go on without the hand-off.`
          );
    // A load that would have left the site fails the same way again, so
    // zen-ux's card offers no Try again for it.
    if (!(e instanceof ZenError) && e?.offSite) {
      error.data = { ...error.data, offSite: e.offSite };
    }
    // The manager's rule: the user never holds a page while a document
    // zenius meant to replace is still there, so a failed load refuses the
    // hand-off. The pages that did load afresh have lost the agent's state:
    // the refusal names them.
    const reloaded = result.reloaded.map(b => svc.pages.forBrowser?.(b)?.label).filter(Boolean);
    if (error.code === "ZEN_HANDOFF_REFUSED" && reloaded.length) {
      error.data = { ...error.data, reloaded };
    }
    throw error;
  }
}

/** End one held page's hold (and its popups'). */
export function releaseHold(rec, browser) {
  try {
    lazy.hold.releasePage(browser);
  } catch (e) {
    log("releasing a held page failed", e.message);
  }
  const held = holds.get(rec.id);
  held?.delete(browser);
  if (held && !held.size) {
    holds.delete(rec.id);
  }
  syncResponseHook();
}

/** The hold ends for every page of the task: Resume, Stop, finish, the task gone. */
export function releaseHolds(rec) {
  for (const browser of [...(holds.get(rec.id) ?? [])]) {
    releaseHold(rec, browser);
  }
}

/** Does zenius hold a page of this task for the user now? */
export function holdingInTask(spaceId) {
  return !!holds.get(spaceId)?.size;
}
