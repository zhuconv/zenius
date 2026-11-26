// SPEC §3.9 I5 (the observe layer): the browser is no way out of an agent's
// sandbox. Zen runs with the user's full rights, so an agent may load only
// web URLs, and act only in web-content documents. This module decides
// both: navigation's goto and reload check their URL; the page gate
// (methods/navigation.sys.mjs) checks the page's document before every
// method that acts in or reads it; and every content call such a method
// makes checks the document it reaches, frames included (the core's ctx).
//
// Before, goto loaded with the system principal: file: and resource: pages
// opened, about:config and chrome:// pages loaded in the parent process,
// where page.evaluate had Services and ChromeUtils, and about:logins got
// every saved password. A document is refused by its principal, its URL
// and its process, so no one of them has to be right.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";

/** What an agent may load: these schemes, and about:blank. */
const LOADABLE = new Set(["http", "https", "data", "blob"]);
const LOADABLE_TEXT = "http:, https:, data:, blob: and about:blank";

/** Documents at these schemes are never the agent's (about: only past about:blank and about:srcdoc). */
const PRIVILEGED = new Set(["about", "chrome", "file", "jar", "moz-extension", "moz-src", "resource", "view-source"]);

/**
 * Firefox's viewers for web content: pdf.js and the JSON viewer show an
 * http(s) PDF or JSON response in the site's own web process, but their
 * documents have these resource: principals. They stay the agent's, as
 * Chromium's viewers are Ego's. Their one bridge to chrome is Save, as a
 * download (the JSON viewer checks that what it saves is its own blob).
 */
const VIEWERS = ["resource://pdf.js/web/viewer.html", "resource://devtools/client/jsonview/"];

/** Firefox's pages for a load that failed. They show the failed URL, but they are about: documents with their own powers (certificate exceptions). */
const ERROR_PAGE = /^about:(neterror|certerror|blocked|httpsonlyerror)\b/;

/** The remote types of web content processes (E10SUtils): not file, extension, privilegedabout, privilegedmozilla or the parent. */
const WEB_PROCESS = /^(web$|webIsolated=|webCOOP\+COEP=)/;

/**
 * Methods that don't act in or read the document: navigation (goto and
 * reload check their URL instead), what the parent answers alone, and waits
 * for navigations and events. They work whatever the page shows, so an
 * agent can always see where it is and leave.
 */
export const OUTSIDE_DOCUMENT = new Set([
  "page.goto",
  "page.reload",
  "page.url",
  "page.info",
  "page.events",
  "page.waitForURL",
  "page.waitForLoadState",
  "page.waitForEvent",
]);

/** Agent methods whose content calls reach only web content. */
function actsInDocument(method) {
  return (method.startsWith("page.") && !OUTSIDE_DOCUMENT.has(method)) || method.startsWith("filechooser.");
}

/** "about:blank" for about:Blank?x#y; null for other schemes. */
function aboutPath(uri) {
  return uri.scheme === "about" ? uri.spec.replace(/[?#].*$/, "").toLowerCase() : null;
}

/** "a file:", "an about:" */
function aScheme(scheme) {
  return `${/^[aeiou]/.test(scheme) ? "an" : "a"} ${scheme}:`;
}

/** about:blank and about:srcdoc take the principal of whoever made them. */
function inherits(uri) {
  const path = aboutPath(uri);
  return path === "about:blank" || path === "about:srcdoc";
}

/**
 * Refuse a load an agent asked for unless I5 allows its URL.
 *
 * @param {nsIURI} uri
 * @param {string} method  "page.goto", "page.reload"
 * @throws {ZenError} ZEN_URL_NOT_ALLOWED
 */
export function checkAgentLoad(uri, method) {
  if (LOADABLE.has(uri.scheme) || aboutPath(uri) === "about:blank") {
    return;
  }
  const verb = method === "page.reload" ? "reload" : "open";
  throw new ZenError(
    "ZEN_URL_NOT_ALLOWED",
    `${method} can't ${verb} ${uri.spec}, ${aScheme(uri.scheme)} URL: agents load only ${LOADABLE_TEXT} URLs, never browser, local or add-on pages. If the task needs this page, ask the user to open it.`,
    { url: uri.spec, scheme: uri.scheme }
  );
}

/**
 * How to load `uri` for the agent in `browser`: never with the system
 * principal, so Firefox applies the checks it applies to a page's own
 * links.
 * - http(s): the URL's own principal, as if the site navigated itself, so
 *   the request stays same-site (SameSite=Strict cookies) as Ego's do.
 * - blob: its origin's principal (Firefox loads a blob: URL only for its
 *   own origin).
 * - data: and about:blank: a new null principal; data: needs Firefox's
 *   explicit flag to load at the top level without the system principal.
 *
 * @returns {{triggeringPrincipal: nsIPrincipal, loadFlags: number}}
 */
export function agentLoadOptions(uri, browser) {
  const ssm = Services.scriptSecurityManager;
  const attrs = originAttributes(browser);
  let triggeringPrincipal;
  let loadFlags = Ci.nsIWebNavigation.LOAD_FLAGS_NONE;
  if (uri.scheme === "http" || uri.scheme === "https") {
    triggeringPrincipal = ssm.createContentPrincipal(uri, attrs);
  } else if (uri.scheme === "blob") {
    let origin = "null";
    try {
      origin = new URL(uri.spec).origin;
    } catch {}
    triggeringPrincipal =
      origin === "null" ? ssm.createNullPrincipal(attrs) : ssm.createContentPrincipal(Services.io.newURI(origin), attrs);
  } else {
    triggeringPrincipal = ssm.createNullPrincipal(attrs);
    if (uri.scheme === "data") {
      loadFlags |= Ci.nsIWebNavigation.LOAD_FLAGS_FORCE_ALLOW_DATA_URI;
    }
  }
  return { triggeringPrincipal, loadFlags };
}

/** The tab's container and private-browsing id: a top-level load's own attributes. */
function originAttributes(browser) {
  const oa = browser.browsingContext?.originAttributes ?? {};
  const attrs = {};
  if (oa.userContextId) {
    attrs.userContextId = oa.userContextId;
  }
  if (oa.privateBrowsingId) {
    attrs.privateBrowsingId = oa.privateBrowsingId;
  }
  return attrs;
}

/** byPrincipalAndURL's reason for an add-on's document, which page.screenshot's refusal names. */
export const ADDON_PAGE = "it is an add-on's page";

/** Why a document with this principal and URL isn't web content, or null; in the parent and in content alike. */
function byPrincipalAndURL(principal, uri) {
  if (!principal || principal.isSystemPrincipal) {
    return "it is a browser page, with the system principal";
  }
  if (principal.isExpandedPrincipal || principal.addonId || principal.scheme === "moz-extension") {
    return ADDON_PAGE;
  }
  if (uri && ERROR_PAGE.test(uri.spec)) {
    return "it is Firefox's error page for a load that failed";
  }
  if (uri && PRIVILEGED.has(uri.scheme) && !inherits(uri)) {
    return `it is ${aScheme(uri.scheme)} page`;
  }
  if (principal.isContentPrincipal && PRIVILEGED.has(principal.scheme) && !VIEWERS.some(v => principal.spec.startsWith(v))) {
    return `its document has ${aScheme(principal.scheme)} principal`;
  }
  return null;
}

/**
 * Parent side, for code that sees a request rather than a document (the
 * network observer): why a request loaded or triggered by `principal` isn't
 * a web document's, or null when it is.
 *
 * @param {nsIPrincipal} principal
 * @returns {string|null}
 */
export function whyNotWebPrincipal(principal) {
  return byPrincipalAndURL(principal, null);
}

/**
 * Why the document of `wgp` isn't web content an agent may act in, or null
 * when it is. Whoever loaded it: a privileged page the user opened in an
 * agent tab during a takeover counts too.
 *
 * @param {WindowGlobalParent} wgp
 * @returns {string|null}
 */
export function notWebContent(wgp) {
  const why = byPrincipalAndURL(wgp.documentPrincipal, wgp.documentURI);
  if (why) {
    return why;
  }
  if (wgp.isInProcess) {
    return "it runs in the browser's own process, not a web content process";
  }
  const remoteType = wgp.domProcess?.remoteType ?? "";
  if (!WEB_PROCESS.test(remoteType)) {
    return `it runs in Firefox's ${remoteType || "unknown"} process, not a web content process`;
  }
  return null;
}

/**
 * Does the browsing context's document run in a web content process? Only
 * there can the agent's code run, and only there does its browsing context
 * group matter to closed groups (the core's pages.codeRefusal). An add-on's,
 * the browser's, a privileged about: page's or a file's process has groups
 * of its own, which a top-level load to the web leaves for a new group
 * (measured in Gecko 160, 2026-11-20). An add-on's pages share its group
 * with its background page, which a check there would count as a window
 * outside the task. No document yet counts as web.
 *
 * @param {BrowsingContext} bc
 * @returns {boolean}
 */
export function inWebProcess(bc) {
  const wgp = bc?.currentWindowGlobal;
  if (!wgp) {
    return true;
  }
  if (wgp.isInProcess) {
    return false;
  }
  return WEB_PROCESS.test(wgp.domProcess?.remoteType ?? "");
}

function refusal(method, where, url, why, data) {
  return new ZenError(
    "ZEN_PAGE_NOT_WEB_CONTENT",
    `${method} refused: ${where} shows ${url}, which isn't web content (${why}). Agents act only in web pages (${LOADABLE_TEXT}). Load one with page.goto, or hand the task to the user.`,
    data
  );
}

/**
 * The page gate's check, on the page's own document: throw unless the agent
 * may act in it.
 *
 * @throws {ZenError} ZEN_PAGE_NOT_WEB_CONTENT
 */
export function checkWebContent(browser, { method, label }) {
  const wgp = browser.browsingContext?.currentWindowGlobal;
  if (!wgp || wgp.isClosed) {
    return; // no document: the method reports that itself
  }
  const why = notWebContent(wgp);
  if (why) {
    // The URL page.url() reports: an error page's is the load that failed.
    const url = browser.currentURI?.spec ?? "";
    throw refusal(method, `page ${label}`, url, why, { url, page: label, method });
  }
}

/**
 * Before a content call made for agent method `method`: throw unless the
 * document of `bc`, top-level or a frame, is web content. Frames matter: a
 * web page can hold an add-on's frame (a password manager's menu) or an
 * error page for a frame that failed.
 *
 * @param {string} method
 * @param {BrowsingContext} bc
 * @param {string} [i5]  the method's declared I5 class, from the core's
 *   dispatch: outside and dev go unchecked, any other is checked. A caller
 *   that passes none gets the method's name's (actsInDocument).
 * @throws {ZenError} ZEN_PAGE_NOT_WEB_CONTENT
 */
export function checkContentCall(method, bc, i5) {
  if (i5 === undefined ? !actsInDocument(method) : i5 === "outside" || i5 === "dev") {
    return;
  }
  const wgp = bc?.currentWindowGlobal;
  if (!wgp || wgp.isClosed) {
    return; // the content call reports a document that is gone
  }
  const why = notWebContent(wgp);
  if (!why) {
    return;
  }
  const top = bc === bc.top;
  if (!top && why === ADDON_PAGE) {
    // As checkPaintable: the frame's host is the add-on's id in this
    // profile, which the page may not see, and the agent didn't ask for it.
    throw new ZenError(
      "ZEN_PAGE_NOT_WEB_CONTENT",
      `${method} refused: a frame in the page is an add-on's (a password manager's menu, say), which isn't web content. Agents act only in web pages: act elsewhere in the page, or hand the task to the user.`,
      { method, frame: true }
    );
  }
  const url = (top ? bc.embedderElement?.currentURI?.spec : null) ?? wgp.documentURI?.spec ?? "";
  throw refusal(method, top ? "the page" : "a frame in the page", url, why, { url, method, frame: !top });
}

/**
 * page.screenshot paints every frame of the page (drawSnapshot), where the
 * page gate checked the page's own document only. Throw unless that
 * document is web content and no frame in the page is the browser's own,
 * shown or hidden: the page's script could show a hidden one before the
 * paint. The screenshot checks before and after it paints, so a frame that
 * comes meanwhile fails it too.
 *
 * An add-on's frame (a password manager's menu, say) doesn't fail it: the
 * screenshot paints over it (methods/observe.sys.mjs, addonAreas). This
 * returns the add-on frames to paint over, the outermost only: a frame
 * inside an add-on's paints within it.
 *
 * Firefox's error page in a frame still paints. It shows the URL the page
 * asked for and Firefox's own text, an agent can't act in it, and a frame
 * that X-Frame-Options blocks shows one.
 *
 * @param {string} method
 * @param {Element} browser  the page's <browser>
 * @param {string} label
 * @returns {BrowsingContext[]} the add-on frames to paint over
 * @throws {ZenError} ZEN_PAGE_NOT_WEB_CONTENT
 */
export function checkPaintable(method, browser, label) {
  checkWebContent(browser, { method, label });
  const top = browser.browsingContext;
  const addons = [];
  for (const bc of top?.getAllBrowsingContextsInSubtree() ?? []) {
    const wgp = bc.currentWindowGlobal;
    if (bc === top || !wgp || wgp.isClosed) {
      continue;
    }
    const why = notWebContent(wgp);
    if (!why || ERROR_PAGE.test(wgp.documentURI?.spec ?? "")) {
      continue;
    }
    if (why === ADDON_PAGE) {
      addons.push(bc);
      continue;
    }
    throw new ZenError(
      "ZEN_PAGE_NOT_WEB_CONTENT",
      `${method} refused: a frame that isn't web content (${why}) is in this page (${label}). A screenshot would paint it, and such a frame can show the browser's or the user's own data. It stays refused while the frame is in the page, even hidden. page.snapshot still works: it leaves such frames out.`,
      { method, page: label, frame: true }
    );
  }
  const within = (bc, outer) => {
    for (let b = bc.parent; b; b = b.parent) {
      if (b === outer) {
        return true;
      }
    }
    return false;
  };
  return addons.filter(bc => !addons.some(outer => outer !== bc && within(bc, outer)));
}

/**
 * Content side, for code that walks into a same-process frame's document
 * itself (the snapshot layer's capture, the input layer's frame contexts): is `doc` web
 * content? A web page's frame in its own process can still be Firefox's
 * error page for a frame that failed.
 *
 * @param {Document} doc
 */
export function isWebDocument(doc) {
  return !whyNotWebDocument(doc);
}

/**
 * Content side: why `doc` isn't web content, or null when it is (the input layer's
 * input checks put it in their refusals).
 *
 * @param {Document} doc
 * @returns {string|null}
 */
export function whyNotWebDocument(doc) {
  try {
    return byPrincipalAndURL(doc.nodePrincipal, doc.documentURIObject);
  } catch {
    return "its document can't be checked";
  }
}

/**
 * The runtime's I5 status, for zenius doctor (browser.health's `i5`, agreed
 * with the SDK): an install from a stale commit can't pass. Everything is
 * computed from what enforces I5, and nothing opens a tab:
 * - loads: what checkAgentLoad allows, sorted;
 * - pageGate: webContentGate is among the service's page gates;
 * - contentGate: ctx.content, as a method acting in documents gets it,
 *   refuses the browser window's own document before sending anything;
 * - refuses: checkAgentLoad refuses about:config and file:///, and
 *   notWebContent refuses the browser window's document.
 * A check that throws reports false.
 *
 * @param {{pageGates?: Function[], content?: Function}} hooks  from the service
 */
export async function i5Status({ pageGates = [], content } = {}) {
  const loads = [...[...LOADABLE].map(scheme => `${scheme}:`), "about:blank"].sort();
  let pageGate = false;
  try {
    // Imported here: methods/navigation.sys.mjs imports this module.
    const { webContentGate } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/methods/navigation.sys.mjs");
    pageGate = pageGates.includes(webContentGate);
  } catch {}
  const chrome = Services.wm.getMostRecentWindow("navigator:browser")?.browsingContext ?? null;
  let contentGate = false;
  if (chrome && typeof content === "function") {
    try {
      await content(chrome, "evaluate#ping", {}, { timeout: 1000 });
    } catch (e) {
      contentGate = e?.code === "ZEN_PAGE_NOT_WEB_CONTENT";
    }
  }
  const refusesLoad = spec => {
    try {
      checkAgentLoad(Services.io.newURI(spec), "page.goto");
      return false;
    } catch (e) {
      return e?.code === "ZEN_URL_NOT_ALLOWED";
    }
  };
  let refuses = false;
  try {
    const wgp = chrome?.currentWindowGlobal;
    refuses = refusesLoad("about:config") && refusesLoad("file:///") && !!wgp && !!notWebContent(wgp);
  } catch {}
  return { loads, pageGate, contentGate, refuses };
}
