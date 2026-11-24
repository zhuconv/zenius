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
// another process. It loads with the first report or the first agent call,
// not at startup (I4).

import {
  DEVICE_PAGES_KEY,
  SIGN_IN_DOCS_KEY,
  SIGN_IN_REASONS,
  carriesAuthorizationResponse,
  signInGateFor,
  signInRefusal,
} from "chrome://userscripts/content/zenius/content/signin.sys.mjs";
import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { devMode } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";

/** The tests' device-login pages: URL prefixes, read on a dev launcher's profile only. */
const DEVICE_PAGES_PREF = "zenius.signIn.devicePages";

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

/** The tests' device-login pages from the pref, on a dev launcher's profile; none elsewhere. */
function readDevicePages() {
  if (!devMode()) {
    return [];
  }
  try {
    return Services.prefs
      .getStringPref(DEVICE_PAGES_PREF, "")
      .split(/[\s,]+/)
      .filter(prefix => /^https?:\/\/[^/]+\//.test(prefix));
  } catch {
    return [];
  }
}

function publishDevicePagesNow() {
  try {
    Services.ppmm.sharedData.set(DEVICE_PAGES_KEY, readDevicePages());
    Services.ppmm.sharedData.flush();
  } catch (e) {
    console.error("[zenius] publishing the tests' device-login pages failed", e);
  }
}

/**
 * Publish the tests' extra device-login pages, on a dev launcher's profile
 * only (devMode()): a user.js line in the user's own profile adds none. At
 * the first connection, and again when a test changes the pref.
 */
export function publishDevicePages() {
  if (published) {
    return;
  }
  published = true;
  if (!devMode()) {
    return;
  }
  publishDevicePagesNow();
  Services.prefs.addObserver(DEVICE_PAGES_PREF, publishDevicePagesNow);
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
  return pick("authorization_response") ?? pick("device_login");
}

/**
 * Throw ZEN_SIGN_IN_PAGE if agent method `method`'s content call of kind
 * `gate` may not run in `bc`'s document, by what the parent knows. The
 * page's process checks again (content/signinguard.sys.mjs): this is only
 * the first check, which covers a frame whose top is in another process
 * before that process has heard.
 *
 * @param {string} method
 * @param {BrowsingContext} bc
 * @param {"read"|"act"} gate
 */
export function checkSignInCall(method, bc, gate) {
  const rule = signInRuleFor(bc);
  if (!rule || (rule.flag.reason === "device_login" && gate !== "act")) {
    return;
  }
  const { message, data } = signInRefusal(method, rule.flag, rule.frame);
  throw new ZenError("ZEN_SIGN_IN_PAGE", message, data);
}

/**
 * A page gate (methods/navigation.sys.mjs's pageGates): a method that reads
 * or acts in documents is refused on a sign-in page at dispatch, before its
 * handler runs, by what the parent knows. The page's process checks each of
 * its content calls again.
 *
 * @param {object} ctx  the call's context
 * @param {object} params
 * @param {string} method
 */
export function signInPageGate(ctx, params, method) {
  const kind = signInGateFor(ctx.i5, ctx.service.accessOf(method));
  if (!kind || !docs.size) {
    return undefined;
  }
  const { browsingContext } = ctx.resolvePage(params);
  checkSignInCall(method, browsingContext, kind);
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
