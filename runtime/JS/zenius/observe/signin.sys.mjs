// The sign-in rules, parent side (content/signin.sys.mjs has the rules). The
// Zenius actor assesses each document of a task's tabs and reports the
// sign-in pages it finds. This module keeps them by innerWindowId for the
// parent's own checks:
// - before an agent method's content call (ctx.content), as a first check:
//   the page's process checks again, atomically with the call;
// - around a screenshot, which the parent paints;
// - for the events a sign-in result's document makes, which are dropped;
// - for the titles the lists and page.info report.
// It publishes them as sharedData too, for a frame whose top document is in
// another process. A page that only its own settings show to be a consent
// prompt (Microsoft's work and school sign-in host) is checked in its
// process once parsed; an act there waits for that check (signInPageGate).
// An act is checked against its tab's current address too, for a page that
// moves to a device-login page or a consent screen in place.
// It loads with the first report or the first agent call, not at startup
// (I4).

import {
  SIGN_IN_DOCS_KEY,
  SIGN_IN_REASONS,
  TEST_PAGES_KEY,
  carriesAuthorizationResponse,
  consentByConfig,
  listedPageOf,
  signInGateFor,
  signInRefusal,
} from "chrome://userscripts/content/zenius/content/signin.sys.mjs";
import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { devMode } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";

/**
 * The tests' pages, URL prefixes read on a dev launcher's profile only:
 * device-login pages, consent screens, and consent screens told apart by
 * their own settings as Microsoft's are. A loopback mock under one of them
 * meets the rule as the provider's page would.
 */
const TEST_PAGE_PREFS = {
  device: "zenius.signIn.devicePages",
  consent: "zenius.signIn.consentPages",
  consentConfig: "zenius.signIn.consentConfigPages",
};
const NO_TEST_PAGES = Object.freeze({ device: [], consent: [], consentConfig: [] });
let testPages = NO_TEST_PAGES;

/**
 * The sign-in pages the actor reported, while their documents live.
 *
 * @type {Map<number, {reason: string, page: string}>}
 */
const docs = new Map();
let watchingDestroyed = false;
let published = false;

function publish() {
  try {
    Services.ppmm.sharedData.set(SIGN_IN_DOCS_KEY, new Map(docs));
    Services.ppmm.sharedData.flush();
  } catch (e) {
    console.error("[zenius] publishing the sign-in pages failed", e);
  }
}

/** A destroyed document can't come back (a stay in the back-forward cache keeps it): its flag goes. */
function onDocumentDestroyed(windowGlobal) {
  let id = 0;
  try {
    id = windowGlobal.innerWindowId;
  } catch {}
  if (id && docs.delete(id)) {
    publish();
    watch();
  }
}

function watch() {
  // window-global-destroyed comes for every document, the user's own
  // included: heard only while a sign-in page is kept (I4).
  const want = docs.size > 0;
  if (want !== watchingDestroyed) {
    watchingDestroyed = want;
    if (want) {
      Services.obs.addObserver(onDocumentDestroyed, "window-global-destroyed");
    } else {
      Services.obs.removeObserver(onDocumentDestroyed, "window-global-destroyed");
    }
  }
}

/** The tests' pages from the prefs, on a dev launcher's profile; none elsewhere. */
function readTestPages() {
  if (!devMode()) {
    return NO_TEST_PAGES;
  }
  const read = pref => {
    try {
      return Services.prefs
        .getStringPref(pref, "")
        .split(/[\s,]+/)
        .filter(prefix => /^https?:\/\/[^/]+\//.test(prefix));
    } catch {
      return [];
    }
  };
  return {
    device: read(TEST_PAGE_PREFS.device),
    consent: read(TEST_PAGE_PREFS.consent),
    consentConfig: read(TEST_PAGE_PREFS.consentConfig),
  };
}

function publishTestPagesNow() {
  testPages = readTestPages();
  try {
    Services.ppmm.sharedData.set(TEST_PAGES_KEY, testPages);
    Services.ppmm.sharedData.flush();
  } catch (e) {
    console.error("[zenius] publishing the tests' sign-in pages failed", e);
  }
}

/**
 * Publish the tests' extra pages, on a dev launcher's profile only
 * (devMode()): a user.js line in the user's own profile adds none. At the
 * first connection, and again when a test changes a pref.
 */
export function publishTestPages() {
  if (published) {
    return;
  }
  published = true;
  if (!devMode()) {
    return;
  }
  publishTestPagesNow();
  for (const pref of Object.values(TEST_PAGE_PREFS)) {
    Services.prefs.addObserver(pref, publishTestPagesNow);
  }
}

/**
 * The Zenius actor's report: `windowGlobal`'s document is a sign-in page.
 * The id is the actor's own, never one the page's process names.
 *
 * @param {WindowGlobalParent} windowGlobal
 * @param {{reason: string, page: string}} flag
 */
export function noteSignInPage(windowGlobal, flag) {
  let id = 0;
  try {
    id = windowGlobal?.innerWindowId ?? 0;
  } catch {}
  if (!id || !SIGN_IN_REASONS.includes(flag?.reason)) {
    return;
  }
  docs.set(id, { reason: flag.reason, page: String(flag.page ?? "").slice(0, 120) });
  watch();
  publish();
}

/** The sign-in flag of the document `innerWindowId`, or null. */
export function signInFlagOf(innerWindowId) {
  return (innerWindowId && docs.get(innerWindowId)) || null;
}

/** The flag of `bc`'s current document, or null. */
function flagOfContext(bc) {
  try {
    return signInFlagOf(bc?.currentWindowGlobal?.innerWindowId);
  } catch {
    return null;
  }
}

/**
 * The flag that rules a call into `bc`, as the parent knows it: its own
 * document's, else its tab's top document's (a frame of a sign-in result is
 * the user's too). `frame` says which.
 *
 * @param {BrowsingContext} bc
 * @returns {{flag: {reason: string, page: string}, frame: boolean}|null}
 */
export function signInRuleFor(bc) {
  const own = flagOfContext(bc);
  let top = null;
  try {
    top = bc?.top && bc.top !== bc ? flagOfContext(bc.top) : null;
  } catch {}
  const pick = reason => (own?.reason === reason ? { flag: own, frame: false } : top?.reason === reason ? { flag: top, frame: true } : null);
  return pick("authorization_response") ?? pick("device_login") ?? pick("consent") ?? pick("one_time_code");
}

/**
 * The user handed these frames back (input/handback.sys.mjs): a code
 * refusal's flags on their documents go, as in their processes
 * (content/signinguard.sys.mjs clearCodeMarks). Synchronous, so the agent's
 * next call, which waits for the hand back, finds them gone.
 *
 * @param {Iterable<BrowsingContext>} bcs
 */
export function clearCodeFlags(bcs) {
  let changed = false;
  for (const bc of bcs) {
    let id = 0;
    try {
      id = bc?.currentWindowGlobal?.innerWindowId ?? 0;
    } catch {}
    if (id && docs.get(id)?.reason === "one_time_code") {
      docs.delete(id);
      changed = true;
    }
  }
  if (changed) {
    publish();
  }
}

/**
 * The rule the tab's current address gives an act in `bc`: a device-login
 * page's or a consent screen's, matched as each document's own address is.
 * A page can move to such an address in place (history.pushState), which
 * no document's load shows; the top's address is the one its tab shows.
 * Only acts ask: reads, and a sign-in result, follow each document's load.
 *
 * @param {BrowsingContext} bc
 * @returns {{flag: {reason: string, page: string}, frame: boolean}|null}
 */
function addressRuleFor(bc) {
  let top = null;
  let uri = null;
  try {
    top = bc?.top ?? null;
    uri = top?.currentURI ?? null;
  } catch {}
  const flag = uri ? listedPageOf(uri, testPages) : null;
  return flag ? { flag, frame: top !== bc } : null;
}

/**
 * Throw ZEN_SIGN_IN_PAGE if agent method `method`'s content call of kind
 * `gate` may not run in `bc`'s document, by what the parent knows: its
 * documents' flags, and for an act its tab's current address. The page's
 * process checks again (content/signinguard.sys.mjs): this is only the
 * first check, which covers a frame whose top is in another process before
 * that process has heard.
 *
 * @param {string} method
 * @param {BrowsingContext} bc
 * @param {"read"|"act"} gate
 */
export function checkSignInCall(method, bc, gate) {
  const rule = signInRuleFor(bc) ?? (gate === "act" ? addressRuleFor(bc) : null);
  if (!rule || (rule.flag.reason !== "authorization_response" && gate !== "act")) {
    return;
  }
  const { message, data } = signInRefusal(method, rule.flag, rule.frame);
  throw new ZenError("ZEN_SIGN_IN_PAGE", message, data);
}

/** The address of `bc`'s current document, or null. */
function documentURIOf(bc) {
  try {
    return bc?.currentWindowGlobal?.documentURI ?? bc?.currentURI ?? null;
  } catch {
    return null;
  }
}

/** `bc` and its top, where their documents are pages only their own settings can show to be a consent prompt. */
function pagesToSettle(bc) {
  const out = [];
  let top = null;
  try {
    top = bc?.top ?? null;
  } catch {}
  for (const context of top && top !== bc ? [bc, top] : [bc]) {
    if (context && consentByConfig(documentURIOf(context), testPages.consentConfig)) {
      out.push(context);
    }
  }
  return out;
}

/**
 * A page gate (methods/navigation.sys.mjs's pageGates): a method that reads
 * or acts in documents is refused on a sign-in page at dispatch, before its
 * handler runs, by what the parent knows. The page's process checks each of
 * its content calls again. An act on a page that only its own settings can
 * show to be a consent prompt waits for the page's process to have checked
 * them, which the page's parsing may hold, so no act lands on the prompt
 * before its check, input from the parent (page.mouse, page.keyboard)
 * included.
 *
 * @param {object} ctx  the call's context
 * @param {object} params
 * @param {string} method
 */
export function signInPageGate(ctx, params, method) {
  const kind = signInGateFor(ctx.i5, ctx.service.accessOf(method));
  if (!kind) {
    return undefined;
  }
  const { browsingContext } = ctx.resolvePage(params);
  const settle = kind === "act" ? pagesToSettle(browsingContext) : [];
  if (settle.length) {
    return Promise.all(
      settle.map(bc =>
        ctx.service.content(bc, "signinguard#settle", {}).then(({ flag, innerWindowId } = {}) => {
          // The page's process reports the flag too; this one is in hand,
          // for the document it checked, if that is still the current one.
          if (flag && innerWindowId && bc.currentWindowGlobal?.innerWindowId === innerWindowId) {
            noteSignInPage(bc.currentWindowGlobal, flag);
          }
        })
      )
    ).then(() => checkSignInCall(method, browsingContext, kind));
  }
  // An act is checked against its tab's address whatever the documents.
  if (docs.size || kind === "act") {
    checkSignInCall(method, browsingContext, kind);
  }
  return undefined;
}

/**
 * Is any document of the tab whose top is `top` a sign-in result? A
 * screenshot paints every frame, so one such frame anywhere refuses it.
 *
 * @param {BrowsingContext} top
 * @returns {{flag: {reason: string, page: string}, frame: boolean}|null}
 */
export function signInResultInTab(top) {
  if (!docs.size || !top) {
    return null;
  }
  let contexts = [];
  try {
    contexts = top.getAllBrowsingContextsInSubtree();
  } catch {
    return null;
  }
  for (const bc of contexts) {
    const flag = flagOfContext(bc);
    if (flag?.reason === "authorization_response") {
      return { flag, frame: bc !== top };
    }
  }
  return null;
}

/**
 * Is a tab's top document, or the address it shows, a sign-in result? For
 * the titles the agent is given: a sign-in result's title is "" (a page
 * that shows the code may show it in its title). A tab the user browses in
 * isn't assessed, so its address is tested as it is now.
 *
 * @param {Element} browser  a tab's <browser>
 */
export function showsSignInResult(browser) {
  try {
    const bc = browser?.browsingContext;
    if (flagOfContext(bc)?.reason === "authorization_response") {
      return true;
    }
    return carriesAuthorizationResponse(browser?.currentURI?.spec ?? "");
  } catch {
    return false;
  }
}

/**
 * Did a sign-in result's document, or a frame of one, make the event (a
 * request, a dialog, a download)? Its events are dropped: they can carry
 * the page's text or its address and code (a beacon's parameters).
 *
 * @param {number} innerWindowId  the document that made it
 */
export function fromSignInResult(innerWindowId) {
  if (!docs.size || !innerWindowId) {
    return false;
  }
  if (signInFlagOf(innerWindowId)?.reason === "authorization_response") {
    return true;
  }
  try {
    const top = WindowGlobalParent.getByInnerWindowId(innerWindowId)?.browsingContext?.top;
    return flagOfContext(top)?.reason === "authorization_response";
  } catch {
    return false;
  }
}

/** Is the top document of the tab `browserId` a sign-in result? */
export function tabTopIsSignInResult(browserId) {
  if (!docs.size || !browserId) {
    return false;
  }
  try {
    return flagOfContext(BrowsingContext.getCurrentTopByBrowserId(browserId))?.reason === "authorization_response";
  } catch {
    return false;
  }
}

/** For tests and the SPI: how many sign-in pages are kept. */
export function signInPageCount() {
  return docs.size;
}
