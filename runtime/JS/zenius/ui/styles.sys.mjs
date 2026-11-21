// Loads zenius-ux.css into a browser window once.

const CSS_URL = "chrome://userscripts/content/zenius/ui/zenius-ux.css";

/** @type {WeakSet<Window>} */
const styled = new WeakSet();

/**
 * @param {Window} win  a browser (chrome) window
 */
export function ensureStyles(win) {
  if (styled.has(win)) {
    return;
  }
  styled.add(win);
  win.windowUtils.loadSheetUsingURIString(
    CSS_URL,
    win.windowUtils.AUTHOR_SHEET
  );
}

/**
 * Remove our sheet from a window (tests and hot reload).
 *
 * @param {Window} win
 */
export function removeStyles(win) {
  if (!styled.has(win)) {
    return;
  }
  styled.delete(win);
  try {
    win.windowUtils.removeSheetUsingURIString(
      CSS_URL,
      win.windowUtils.AUTHOR_SHEET
    );
  } catch {
    // The window may be closing.
  }
}
