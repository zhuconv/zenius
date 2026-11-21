// Whether a person could be looking at a tab's content right now.
//
// Background tab panels stay laid out and only skip painting
// (-moz-subtree-hidden-only-visually in xul.css), so checkVisibility() and
// IntersectionObserver call them visible. Agent tabs may also be kept
// docShell-active on purpose (SPEC §3.5), so docShellIsActive says nothing
// either. What decides it is whether the tab's panel is one the tab deck
// shows: the selected one, or a member of the split view on screen.

const SHOWN_PANEL =
  ".deck-selected, .split-view-panel-active, [zen-split='true']";

/**
 * @param {Element} tab  a tabbrowser tab
 * @returns {boolean}
 */
export function isTabVisible(tab) {
  const browser = tab?.linkedBrowser;
  if (!browser?.isConnected) {
    return false;
  }
  return isBrowserVisible(browser);
}

/**
 * @param {Element} browser  a content <browser>
 * @returns {boolean}
 */
export function isBrowserVisible(browser) {
  const win = browser.ownerDocument.defaultView;
  // document.hidden covers a minimized window, and on macOS a fully
  // occluded one.
  if (!win || win.closed || win.document.hidden) {
    return false;
  }
  if (win.windowState === win.STATE_MINIMIZED) {
    return false;
  }
  return deckShows(win, browser);
}

/** Whether the window's tab deck shows the browser's panel. */
function deckShows(win, browser) {
  const panel = browser.closest(".browserSidebarContainer");
  if (!panel?.matches(SHOWN_PANEL)) {
    return false;
  }
  // A split member left over from another workspace's split group keeps
  // zen-split only while its group is on screen, but double-check the
  // container itself isn't hidden by Zen's split CSS.
  return win.getComputedStyle(panel).visibility !== "hidden";
}
