// Per-window protections: keep agent tabs alive while hidden, route popups
// from agent pages into the agent's space, and stop agent pages from pulling
// focus. Installed once per browser window by the service.

import { log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";
import {
  addingAgentTab,
  copyingAgentTab,
  noteOpenRefused,
  syncedSoon,
  syncId,
  withoutZenContainerRouting,
  zeniusPlaced,
} from "chrome://userscripts/content/zenius/modules/windows.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ZeniusService: "chrome://userscripts/content/zenius/modules/service.sys.mjs",
});

/**
 * Agent tabs run as if visible: rAF at the display rate, unthrottled timers,
 * rendering, and no low-memory unloading. A hidden tab otherwise gets about one
 * frame a second and 1 s timer clamping.
 *
 * @param {Element} tab
 */
export function keepAlive(tab) {
  const browser = tab?.linkedBrowser;
  if (!browser || tab.closing) {
    return;
  }
  if (!tab.undiscardable) {
    tab.undiscardable = true;
  }
  if (!browser.docShellIsActive) {
    browser.docShellIsActive = true;
  }
}

/**
 * Keep `browser`'s content process at a shown tab's priority while zenius
 * still works in the page after its task (the discard, then the clean load's
 * form record, load and fill), though by then the page is the user's
 * background tab. Gecko lowers a process whose tabs are all background at
 * once, and on a busy Mac a background process can wait seconds for the CPU:
 * the record missed its limit there, and the user's typing wasn't carried
 * over. This sets the tab switcher's own knob, nsIRemoteTab.priorityHint,
 * which raises only the process: the page stays a background tab to its own
 * code (document.visibilityState, timers, autoplay, wake locks), as the
 * user's other background tabs are. A tab whose hint is already up (the
 * switcher's, for a tab the user shows) is left to the switcher. Returns the
 * release, which runs once.
 *
 * The hint belongs to the page's current process: a load that moved the page
 * to another would leave that one unheld. A clean load stays on the page's
 * site, and so in its process.
 *
 * @param {Element} browser
 * @returns {() => void}
 */
export function holdPriority(browser) {
  let remoteTab = null;
  try {
    remoteTab = browser?.frameLoader?.remoteTab ?? null;
    if (!remoteTab || remoteTab.priorityHint) {
      return () => {};
    }
    remoteTab.priorityHint = true;
  } catch (e) {
    log("raising a page's process failed:", e.message);
    return () => {};
  }
  let held = true;
  return () => {
    if (!held) {
      return;
    }
    held = false;
    try {
      remoteTab.priorityHint = false;
    } catch {}
  };
}

/** Undo keepAlive when a tab goes back to the user. */
export function releaseKeepAlive(tab) {
  const browser = tab?.linkedBrowser;
  if (!browser || tab.closing) {
    return;
  }
  if (tab.undiscardable) {
    tab.undiscardable = false;
  }
  const gBrowser = tab.ownerDocument.defaultView.gBrowser;
  const active = gBrowser?.shouldActivateDocShell ? gBrowser.shouldActivateDocShell(browser) : tab.selected;
  if (browser.docShellIsActive !== active) {
    browser.docShellIsActive = active;
  }
}

/**
 * @param {Window} win
 */
export function installWindowGuards(win) {
  const service = lazy.ZeniusService;
  const { gBrowser } = win;
  const originalAddTab = gBrowser.addTab;

  // Popups. target=_blank links and window.open() from a page reach
  // gBrowser.addTab through BrowserDOMWindow with openerBrowser set, in the
  // foreground by default. From an agent page they belong in the agent's
  // space, in the background, under the next label.
  gBrowser.addTab = function zeniusAddTab(uri, options = {}) {
    if (copyingAgentTab(this)) {
      // Window sync copying an agent tab zenius adds in another window:
      // neither Zen's open animation nor Firefox's scroll to a new
      // background tab (copyingAgentTab says why), as the original has neither.
      options = { ...options, skipAnimation: true, skipBackgroundNotify: true };
    }
    let route = null;
    try {
      route = service.popupRoute(options);
    } catch (e) {
      log("popupRoute failed", e.message);
    }
    if (!route) {
      const tab = originalAddTab.call(this, uri, options);
      try {
        if (tab) {
          service.noteOpenedTab(tab, options);
        }
      } catch (e) {
        log("noting a new tab failed", e.message);
      }
      return tab;
    }
    if (route.hold) {
      // While the user holds the task, their click or the site's code
      // opened it: it opens where and as Zen opens any popup, and joins the
      // task (closed groups, item 2).
      const tab = originalAddTab.call(this, uri, options);
      try {
        if (tab) {
          service.adoptPopup(win, tab, route);
        }
      } catch (e) {
        log("adopting a popup opened during a hold failed", e.message, e.stack);
      }
      return tab;
    }
    // skipBackgroundNotify: Firefox's background-tab notification scrolls
    // the strip to the new tab (SPEC §3.5). The view keeper covers the add,
    // which passes through the window's active Space, the move, and window
    // sync's copies (as pages.addTab says).
    const opts = { ...options, inBackground: true, skipAnimation: true, skipRoute: true, skipBackgroundNotify: true };
    let tab = null;
    service.pages.keepView(() => {
      tab = addingAgentTab(this, () =>
        withoutZenContainerRouting(win, opts.userContextId ?? route.space.userContextId ?? 0, () =>
          originalAddTab.call(this, uri, opts)
        )
      );
      if (!tab) {
        return null;
      }
      try {
        service.adoptPopup(win, tab, route);
      } catch (e) {
        log("adopting popup failed", e.message, e.stack);
      }
      return syncId(tab) ? null : syncedSoon(tab);
    });
    return tab;
  };

  // Closed groups (SPI.md, "Closed groups"): a page whose browsing context
  // group holds the agent's code, outside a live
  // task, gets no handle to a new window. Every tab a page opens comes
  // through createContentWindowInFrame. Throwing NS_ERROR_ABORT there
  // refuses the open as the popup blocker does: window.open returns null,
  // and no tab or window opens. (Returning null isn't a refusal: Gecko then
  // opens the page in a new window.)
  const bdw = win.browserDOMWindow?.wrappedJSObject;
  if (typeof bdw?.createContentWindowInFrame === "function" && !Object.hasOwn(bdw, "createContentWindowInFrame")) {
    const originalCreate = bdw.createContentWindowInFrame;
    bdw.createContentWindowInFrame = function zeniusCreateContentWindowInFrame(uri, params) {
      let refused = null;
      try {
        refused = service.openRefusal(params);
      } catch (e) {
        log("openRefusal failed", e.message);
      }
      if (!refused) {
        return originalCreate.apply(this, arguments);
      }
      const spec = uri?.spec ?? "";
      log(`closed groups: refused an open of ${spec || "about:blank"} from a page whose group holds the agent's code`);
      noteOpenRefused({
        browser: refused.browser,
        url: spec === "about:blank" ? "" : spec,
        reopened: false,
        ...(refused.hold ? { hold: true } : {}),
      });
      throw Components.Exception("zenius: the opener's group holds the agent's code", Cr.NS_ERROR_ABORT);
    };
  }

  // Window sync animates its move of a copy of a tab zenius placed in
  // another window: the strip of a window that shows the tab's Space slides
  // a row and back (zeniusPlaced says why). The copy goes to its place
  // without it. A user's own drag still animates.
  const dnd = gBrowser.tabContainer?.tabDragAndDrop;
  const originalTransition = dnd?.handle_drop_transition;
  const ownTransition = !!dnd && Object.hasOwn(dnd, "handle_drop_transition");
  if (typeof originalTransition === "function") {
    dnd.handle_drop_transition = function zeniusDropTransition(dropElement, draggedTab, ...rest) {
      if (zeniusPlaced(draggedTab)) {
        return undefined;
      }
      return originalTransition.call(this, dropElement, draggedTab, ...rest);
    };
  }

  // window.focus() and similar from a background agent page would make the
  // tabbrowser select that tab (and switch workspace). Swallow the request
  // before gBrowser sees it.
  const onFocusRequest = event => {
    if (service.isAgentDriven(event.target)) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  };
  win.addEventListener("framefocusrequested", onFocusRequest, true);

  // The tab switcher deactivates a tab it switched away from (after its
  // unload delay). If that was an agent tab, wake it again once the
  // switcher has finished its bookkeeping.
  const reactivate = event => {
    const browser = event.originalTarget;
    if (browser?.localName === "browser" && service.wantsKeepAlive(browser)) {
      win.setTimeout(() => {
        const tab = gBrowser.getTabForBrowser(browser);
        if (tab && service.wantsKeepAlive(browser)) {
          keepAlive(tab);
        }
      }, 0);
    }
  };
  win.addEventListener("MozLayerTreeCleared", reactivate, true);
  const refresh = () => service.refreshKeepAlive();
  win.addEventListener("TabSwitchDone", refresh);

  win.addEventListener(
    "unload",
    () => {
      if (gBrowser.addTab !== originalAddTab) {
        gBrowser.addTab = originalAddTab;
      }
      if (originalTransition && dnd.handle_drop_transition !== originalTransition) {
        if (ownTransition) {
          dnd.handle_drop_transition = originalTransition;
        } else {
          delete dnd.handle_drop_transition;
        }
      }
      win.removeEventListener("framefocusrequested", onFocusRequest, true);
      win.removeEventListener("MozLayerTreeCleared", reactivate, true);
      win.removeEventListener("TabSwitchDone", refresh);
    },
    { once: true }
  );
}

// ---------------------------------------------------------------------------
// Popup windows (closed groups, items 2 and 3, for windows)
//
// A feature popup (window.open with a size) opens as a window under Firefox's
// default browser.link.open_newwindow.restriction, 2: on the Mac always, and
// on Linux from a tab whose window.open zenius doesn't wrap. A window never
// reaches the tab hooks above. The parent creates it through the app's
// nsIWindowCreator, whose createChromeWindow gets the open's openWindowInfo:
// zenius wraps it while a task is live or a document holds the agent's code.
// - Item 3: an open with an opener from a page whose group holds the
//   agent's code, outside a live task, is refused there, before any window
//   exists: NS_ERROR_ABORT makes window.open (and document.open with
//   features) return null, with nothing opened. Closing the window in its
//   first moments instead leaves the page's window.open waiting for good
//   (measured on the Linux server, 2026-11-20).
// - Item 2: an open from a page of a live task makes its window, and at the
//   window's delayed startup its tab moves into the task as a page
//   (service.joinPopupWindow). The browsing context, and so the page's
//   handle and the opener, stay as they are.

/** The app's window creator while zenius's wraps it, else null. */
let appWindowCreator = null;

/** Is zenius's window creator in? (tests) */
export function popupWindowGuardOn() {
  return !!appWindowCreator;
}

/**
 * Wrap the app's window creator, or put it back.
 *
 * @param {object} service  ZeniusService
 * @param {boolean} on
 */
export function setPopupWindowGuard(service, on) {
  if (on === !!appWindowCreator) {
    return;
  }
  if (!on) {
    Services.ww.setWindowCreator(appWindowCreator);
    appWindowCreator = null;
    log("popup window guard: off");
    return;
  }
  let original;
  try {
    original = Services.startup.QueryInterface(Ci.nsIWindowCreator);
  } catch (e) {
    log("popup window guard: no app window creator", e.message);
    return;
  }
  appWindowCreator = original;
  Services.ww.setWindowCreator({
    QueryInterface: ChromeUtils.generateQI(["nsIWindowCreator"]),
    createChromeWindow(parent, chromeFlags, openWindowInfo, cancel) {
      let refused = null;
      let route = null;
      if (openWindowInfo?.parent) {
        try {
          refused = service.openRefusal({ openWindowInfo });
          route = refused ? null : service.popupRoute({ openWindowInfo });
        } catch (e) {
          log("checking a popup window failed", e.message);
        }
      }
      if (refused) {
        log("closed groups: refused a popup window from a page whose group holds the agent's code");
        noteOpenRefused({ browser: refused.browser, url: "", reopened: false, ...(refused.hold ? { hold: true } : {}) });
        throw Components.Exception("zenius: the opener's group holds the agent's code", Cr.NS_ERROR_ABORT);
      }
      const made = original.createChromeWindow(parent, chromeFlags, openWindowInfo, cancel);
      // Out again once nothing needs it, such as after the last kept
      // document with the agent's code closed.
      Promise.resolve().then(() => service.updatePopupWindowGuard());
      if (route) {
        try {
          joinWhenReady(service, made, route);
        } catch (e) {
          log("following a task's popup window failed", e.message);
        }
      }
      return made;
    },
  });
  log("popup window guard: on");
}

/**
 * Move a task's popup window into the task once the window is up: its
 * first browser holds the popup from the window's DOMContentLoaded, but the
 * opener's window.open waits on the window until later, and a move before
 * then leaves it waiting. The window's delayed startup is past that.
 *
 * @param {object} service
 * @param {nsIWebBrowserChrome} made  createChromeWindow's
 * @param {object} route  service.popupRoute's
 */
function joinWhenReady(service, made, route) {
  const popupWin = made.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIAppWindow).docShell.domWindow;
  const observer = {
    observe(subject, topic) {
      if (subject !== popupWin) {
        return;
      }
      Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
      Services.obs.removeObserver(observer, "domwindowclosed");
      if (topic === "browser-delayed-startup-finished") {
        try {
          service.joinPopupWindow(popupWin, route);
        } catch (e) {
          log("moving a task's popup window into its task failed", e.message, e.stack);
        }
      }
    },
  };
  Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  Services.obs.addObserver(observer, "domwindowclosed");
}
