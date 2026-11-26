// What the user sees when they open an agent's task, and which page the agent
// is working on.
//
// On a Space switch Zen selects the Space's entry in
// gZenWorkspaces.lastSelectedWorkspaceTabs, and falls back to an empty new
// tab. An agent's action never changes that entry: the Agents Space lands on
// the user's own last pick (SPEC §3.5), and a user's workspace an agent
// claimed is still theirs. Only the user's own request (the tasks panel's
// Open, a notification) points it at an agent's page, through landOn.

/** @type {Set<(tab: Element) => void>} */
const listeners = new Set();

/**
 * Note that the agent is acting on `tab`, for listeners: the UI controller
 * tracks each task's current page and activity this way.
 *
 * @param {Element} tab
 */
export function notePage(tab) {
  for (const fn of listeners) {
    try {
      fn(tab);
    } catch (e) {
      console.error("[zenius] notePage listener failed", e);
    }
  }
}

/**
 * The user asked to see this page (the tasks panel's Open, a notification):
 * their switch to its Space lands on it, without first showing another tab.
 *
 * @param {Element} tab
 * @returns {boolean} whether Zen's entry was set
 */
export function landOn(tab) {
  const win = tab?.ownerDocument?.defaultView;
  const zw = win?.gZenWorkspaces;
  const uuid = tab?.getAttribute("zen-workspace-id");
  if (!zw || !uuid || tab.closing) {
    return false;
  }
  zw.lastSelectedWorkspaceTabs[uuid] = tab;
  return true;
}

/**
 * @param {(tab: Element) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onNotePage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** @type {Set<(tab: Element, method: string) => void>} */
const callListeners = new Set();

/**
 * Note that an agent's call names `tab`, a page of its task, whether it acts
 * there or only reads it (the core's call context, before the call runs):
 * the UI controller takes the cursor off the task's other pages, since the
 * agent works here now. Unlike notePage, it leaves the page the Space opens
 * on as it is.
 *
 * @param {Element} tab
 * @param {string} method  the call's: pages.close names a page it ends
 */
export function notePageCall(tab, method) {
  for (const fn of callListeners) {
    try {
      fn(tab, method);
    } catch (e) {
      console.error("[zenius] notePageCall listener failed", e);
    }
  }
}

/**
 * @param {(tab: Element, method: string) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onNotePageCall(fn) {
  callListeners.add(fn);
  return () => callListeners.delete(fn);
}
