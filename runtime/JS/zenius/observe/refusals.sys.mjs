// Firefox UI an agent page may not open (zen-observe): anything that would
// show over the user's view, leave the browser or touch the OS. In a tab the
// agent drives, zenius refuses it and tells the agent, never silently: a
// "Zenius.refused" event in page.events(), and `refused: [{kind, message}]`
// in the receipt of the action that caused it. This module refuses print,
// HTTP authentication and external apps; the I1/I4 sweep
// (docs/research/observe.md §10) lists every surface and who handles it.
//
// Other owners: reportRefused(browser, kind, message) for a surface you
// refuse; watchRefusals(browser) for an action's receipt (docs/SPI.md).

import { pushEvent } from "chrome://userscripts/content/zenius/observe/events.sys.mjs";
import { cut, STRING_TEXT } from "chrome://userscripts/content/zenius/observe/textcap.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  amContentHandler: "resource://gre/modules/amContentHandler.sys.mjs",
  DOMFullscreenParent: "resource:///actors/DOMFullscreenParent.sys.mjs",
  LoginManagerAuthPrompter: "resource://gre/modules/LoginManagerAuthPrompter.sys.mjs",
  nsContentDispatchChooser: "resource://gre/modules/ContentDispatchChooser.sys.mjs",
  PointerLockParent: "resource:///actors/PointerLockParent.sys.mjs",
  PopupAndRedirectBlockingParent: "moz-src:///toolkit/actors/PopupAndRedirectBlockingParent.sys.mjs",
  PromptUtils: "resource://gre/modules/PromptUtils.sys.mjs",
  WebProtocolHandlerRegistrar: "moz-src:///browser/components/protocolhandler/WebProtocolHandlerRegistrar.sys.mjs",
});

/** @type {Set<{browserId: number, seen: {kind: string, message: string}[]}>} */
const watchers = new Set();
let isAgent = _browser => false;
let installed = false;
const PATCHED = Symbol("zenius.refusals");

/**
 * Tell the agent that its page asked for something zenius refused.
 *
 * @param {Element} browser the agent's tab
 * @param {string} kind     "print", "httpAuth", …
 * @param {string} message  what happened and what the agent can do instead
 * @param {string} [url]    the document or request that asked
 * @param {{api?: string, asked?: string}} [what]  for a device or a
 *   notification: the API and what it asked for in a few words (zen-ux's
 *   card for a kept page reads them)
 */
export function reportRefused(browser, kind, message, url, what = null) {
  const browserId = browser?.browserId;
  if (!browserId) {
    return;
  }
  const params = { kind, message, url: url ?? browser.currentURI?.spec ?? "" };
  for (const field of ["api", "asked"]) {
    if (typeof what?.[field] === "string") {
      params[field] = cut(what[field], STRING_TEXT);
    }
  }
  pushEvent(browserId, "Zenius.refused", params);
  // A message may quote a URL the page chose; the receipt keeps a capped one.
  const text = cut(String(message), STRING_TEXT);
  for (const w of watchers) {
    if (w.browserId === browserId) {
      w.seen.push({ kind, message: text });
      w.wake?.();
    }
  }
}

/**
 * Collect what the tab refuses while an action runs, for its receipt.
 *
 *   const r = watchRefusals(browser);
 *   … the action …
 *   const refused = r.stop(); // [{kind, message}], empty if none
 */
export function watchRefusals(browser) {
  const w = { browserId: browser.browserId, seen: [], wake: null };
  watchers.add(w);
  return {
    /** What was refused so far. */
    get seen() {
      return w.seen;
    },
    /**
     * Resolves with the first refusal of `kind`, seen already or to come. A
     * refusal that ends what the action waits for without an event of its
     * own (a reload that Firefox's question stopped) wakes the wait.
     */
    first(kind) {
      return new Promise(resolve => {
        const check = () => {
          const hit = w.seen.find(r => r.kind === kind);
          if (hit) {
            resolve(hit);
            return true;
          }
          return false;
        };
        if (check()) {
          return;
        }
        const prior = w.wake;
        w.wake = () => {
          prior?.();
          check();
        };
      });
    },
    stop() {
      watchers.delete(w);
      return w.seen;
    },
  };
}

/**
 * Refuse, in tabs where `isAgent(browser)`: print, HTTP authentication,
 * external apps, add-on installs, the pop-up-blocked bar, protocol handler
 * registration, and (backstops for content/refusals.sys.mjs) fullscreen and
 * pointer lock. Idempotent.
 */
export function installRefusals({ isAgent: fn }) {
  isAgent = fn;
  if (installed) {
    return;
  }
  installed = true;
  for (const install of [
    installAuth,
    installExternalApps,
    installAddonInstalls,
    installPopupBlocked,
    installProtocolHandlers,
    installFullscreenBackstop,
    installPointerLockBackstop,
  ]) {
    try {
      install();
    } catch (e) {
      console.error(`[zenius] ${install.name} failed`, e);
    }
  }
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    patchPrint(win);
  }
  Services.obs.addObserver(win => patchPrint(win), "browser-delayed-startup-finished");
}

function agentBrowser(browser) {
  try {
    return !!browser && isAgent(browser);
  } catch {
    return false;
  }
}

// window.print() asks the parent for a browser to hold the document's print
// copy (OPEN_PRINT_BROWSER), and PrintUtils answers by opening the print
// dialog in the tab: it takes keyboard focus from wherever the user is, even
// in a hidden tab. For an agent tab, take Firefox's path for a user who
// cancels the system print dialog instead: hold the copy in a browser nobody
// sees, then remove it. print() returns in the page as after a Cancel
// (throwing would make it raise NotAllowedError, which no page expects).
function patchPrint(win) {
  let utils;
  try {
    utils = win.PrintUtils;
  } catch {
    return;
  }
  if (!utils || utils[PATCHED]) {
    return;
  }
  const original = utils.handleStaticCloneCreatedForPrint;
  utils.handleStaticCloneCreatedForPrint = function (openWindowInfo) {
    let browser = null;
    try {
      browser = openWindowInfo?.parent?.top?.embedderElement ?? null;
    } catch {}
    if (openWindowInfo?.isForWindowDotPrint && agentBrowser(browser)) {
      reportRefused(
        browser,
        "print",
        "The page called window.print(). Agent pages never open the print dialog, so nothing was printed and the page went on as if the user had cancelled.",
        openWindowInfo.parent?.currentWindowGlobal?.documentURI?.spec
      );
      const host = this.createParentBrowserForStaticClone(openWindowInfo.parent, openWindowInfo);
      host.style.cssText = "position: fixed; width: 0; height: 0; visibility: hidden; pointer-events: none;";
      // Not before returning it: the page's print() still waits for this answer.
      win.setTimeout(() => host.remove(), 0);
      return host;
    }
    return original.apply(this, arguments);
  };
  utils[PATCHED] = true;
}

// An HTTP auth challenge (401, 407) asks LoginManagerAuthPrompter, which
// fires DOMWillOpenModalDialog and opens a tab-modal sign-in dialog. For an
// agent tab, answer "cancelled" before either: the response to the
// unauthenticated request loads, as in a browser whose user clicked Cancel.
function installAuth() {
  const proto = lazy.LoginManagerAuthPrompter.prototype;
  const original = proto.promptAuthInternal;
  proto.promptAuthInternal = async function (channel, level, authInfo) {
    const browser = this._browser;
    if (!agentBrowser(browser)) {
      return original.apply(this, arguments);
    }
    let host = "";
    let realm = "";
    try {
      ({ displayHost: host, realm } = lazy.PromptUtils.getAuthTarget(channel, authInfo));
    } catch {}
    const proxy = !!(authInfo.flags & Ci.nsIAuthInformation.AUTH_PROXY);
    reportRefused(
      browser,
      "httpAuth",
      `${proxy ? "The proxy" : host || "The server"} asked for a username and password (HTTP authentication${realm ? `, realm ${JSON.stringify(realm)}` : ""}). ` +
        "Agent pages never show the sign-in dialog, so the server's response to the request without credentials loaded instead. " +
        "Hand the task to the user to sign in, or, with credentials the user gave you, open the URL with them (https://user:password@host/path).",
      channel.URI?.spec
    );
    return false;
  };
}

// A link or navigation to a scheme another app handles (mailto:, zoommtg:,
// slack:, tel:) ends in nsContentDispatchChooser, which asks in a tab-modal
// dialog (taking keyboard focus from wherever the user is, even from a
// hidden tab) and then launches the app, which comes to the front. Agent
// pages never leave the browser: refuse before either.
function installExternalApps() {
  const proto = lazy.nsContentDispatchChooser.prototype;
  const original = proto.handleURI;
  proto.handleURI = async function (handler, uri, principal, browsingContext, triggeredExternally) {
    let browser = null;
    try {
      browser = browsingContext?.top?.embedderElement ?? null;
    } catch {}
    if (triggeredExternally || !agentBrowser(browser)) {
      return original.apply(this, arguments);
    }
    reportRefused(
      browser,
      "externalApp",
      `The page tried to open ${uri.spec} in another app. Agent pages never leave the browser, so nothing was opened. If the user should open it, tell them the link.`,
      uri.spec
    );
    return undefined;
  };
}

// An .xpi reaches amContentHandler (the application/x-xpinstall content
// handler) before anything is downloaded or asked; from there Firefox shows
// its install doorhangers. Agent pages never install add-ons.
function installAddonInstalls() {
  const proto = lazy.amContentHandler.prototype;
  const original = proto.handleContent;
  proto.handleContent = function (mimetype, context, request) {
    let browser = null;
    let uri = "";
    try {
      browser = request.QueryInterface(Ci.nsIChannel).loadInfo.targetBrowsingContext?.top?.embedderElement ?? null;
      uri = request.URI?.spec ?? "";
    } catch {}
    if (!agentBrowser(browser)) {
      return original.apply(this, arguments);
    }
    request.cancel(Cr.NS_BINDING_ABORTED);
    reportRefused(
      browser,
      "addonInstall",
      `The navigation led to a browser add-on to install (${uri}). Agent tabs never install add-ons, so nothing was downloaded or installed. If the user wants it, tell them the link.`,
      uri
    );
    return undefined;
  };
}

// A pop-up the page opens without user activation is blocked, as in any
// tab, and Firefox then shows the "pop-up blocked" bar (and an address bar
// icon) for the tab. In an agent tab the blocker's count is never updated,
// so neither appears, now or when the user opens the tab later, and the
// agent is told what was blocked instead.
function installPopupBlocked() {
  const proto = lazy.PopupAndRedirectBlockingParent.prototype;
  const originalPopups = proto.updateBrowserAboutPopupCount;
  const reported = new WeakMap();
  proto.updateBrowserAboutPopupCount = function (message) {
    let browser = null;
    try {
      browser = this.browsingContext.top.embedderElement;
    } catch {}
    if (!agentBrowser(browser)) {
      return originalPopups.apply(this, arguments);
    }
    const wg = this.manager;
    this.sendQuery("GetBlockedPopups").then(
      popups => {
        const seen = reported.get(wg) ?? 0;
        for (const popup of (popups ?? []).slice(seen)) {
          const url = popup?.popupWindowURISpec || "";
          reportRefused(
            browser,
            "popupBlocked",
            `The page tried to open a pop-up${url ? ` (${url})` : ""} without a user action, and the browser blocked it as for any page. To open it, click the link or button that opens it (page.click).`,
            url
          );
        }
        reported.set(wg, Math.max(seen, popups?.length ?? 0));
      },
      () => {}
    );
    return undefined;
  };
  const originalRedirect = proto.updateBrowserAboutBlockedRedirect;
  proto.updateBrowserAboutBlockedRedirect = function () {
    let browser = null;
    try {
      browser = this.browsingContext.top.embedderElement;
    } catch {}
    if (!agentBrowser(browser)) {
      return originalRedirect.apply(this, arguments);
    }
    reportRefused(
      browser,
      "redirectBlocked",
      "A frame in the page tried to redirect the whole page without a user action, and the browser blocked it as for any page."
    );
    return undefined;
  };
}

// registerProtocolHandler() asks the user in a bar on the tab; accepting it
// would change which site handles those links for the user everywhere.
function installProtocolHandlers() {
  const proto = lazy.WebProtocolHandlerRegistrar.prototype;
  const original = proto.registerProtocolHandler;
  proto.registerProtocolHandler = function (protocol, uri, title, documentURI, browserOrWindow) {
    const browser = browserOrWindow instanceof Ci.nsIDOMWindow ? null : browserOrWindow;
    if (!agentBrowser(browser)) {
      return original.apply(this, arguments);
    }
    reportRefused(
      browser,
      "protocolHandler",
      `The page asked to handle ${String(protocol || "").toLowerCase()}: links for the user (registerProtocolHandler). Agent pages never change the user's handlers, so it was refused without asking.`,
      documentURI?.spec
    );
    return undefined;
  };
}

// The guards in content/refusals.sys.mjs deny fullscreen and pointer lock
// before a request leaves the page. A request that got past them (through a
// frame created before they were installed, say) reaches the parent here:
// fullscreen is dropped before the window is touched, and a pointer lock is
// let go at once, without its warning.
function installFullscreenBackstop() {
  const proto = lazy.DOMFullscreenParent.prototype;
  const original = proto.receiveMessage;
  proto.receiveMessage = function (message) {
    if (message.name === "DOMFullscreen:Request") {
      let browser = null;
      try {
        browser = this.browsingContext.top.embedderElement;
      } catch {}
      if (agentBrowser(browser)) {
        reportRefused(browser, "fullscreen", "The page asked for fullscreen. Agent pages never go fullscreen, which would take over the user's screen, so the request was denied.");
        letGo(this.manager);
        return undefined;
      }
    }
    return original.apply(this, arguments);
  };
}

function installPointerLockBackstop() {
  const proto = lazy.PointerLockParent.prototype;
  const original = proto.receiveMessage;
  proto.receiveMessage = function (message) {
    if (message.name === "PointerLock:Entered") {
      let browser = null;
      try {
        browser = this.manager.browsingContext.top.embedderElement;
      } catch {}
      if (agentBrowser(browser)) {
        reportRefused(browser, "pointerLock", "The page locked the pointer. Agent pages never capture the user's cursor, so it was released at once.");
        letGo(this.manager);
        return undefined;
      }
    }
    return original.apply(this, arguments);
  };
}

/** Ask the frame to leave fullscreen and pointer lock (content/refusals.sys.mjs). */
function letGo(windowGlobal) {
  try {
    windowGlobal
      .getActor("Zenius")
      .sendQuery("call", { module: "refusals", fn: "exitFullscreenAndPointerLock", args: {} })
      .catch(() => {});
  } catch {}
}
