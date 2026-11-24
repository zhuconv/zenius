// Browser-window helpers: which window hosts agent tabs, and how to add a tab
// to a workspace without touching what the user sees.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ZenWindowSync: "resource:///modules/zen/ZenWindowSync.sys.mjs",
  ZeniusService: "chrome://userscripts/content/zenius/modules/service.sys.mjs",
});

/** Browser windows whose workspaces are usable, most recently used first. */
export function workspaceWindows() {
  return lazy.BrowserWindowTracker.orderedWindows.filter(
    win =>
      !win.closed &&
      win.gZenWorkspaces?.workspaceEnabled &&
      !win.gZenWorkspaces.privateWindowOrDisabled &&
      !lazy.PrivateBrowsingUtils.isWindowPrivate(win)
  );
}

/**
 * The window that holds new agent tabs. Workspaces are synced across
 * windows, but unpinned tabs live in one window, so we put a space's tabs in
 * one place and remember it.
 */
export function hostWindow(preferred) {
  if (preferred && !preferred.closed && workspaceWindows().includes(preferred)) {
    return preferred;
  }
  return workspaceWindows()[0] ?? null;
}

/**
 * Every tab element in every browser window. Zen's gBrowser.tabs lists only
 * the active workspace's tabs, so ask gZenWorkspaces for all of them. With
 * window sync, that's every window's copy of each tab: uniqueTabs() lists
 * each tab once.
 */
export function* allTabs() {
  for (const win of lazy.BrowserWindowTracker.orderedWindows) {
    if (win.closed || !win.gBrowser) {
      continue;
    }
    yield* win.gZenWorkspaces?.workspaceEnabled ? win.gZenWorkspaces.allStoredTabs : win.gBrowser.tabs;
  }
}

// ---------------------------------------------------------------------------
// Zen's window sync (SPI "Windows: a page is its sync id")
//
// Zen 1.24 makes every window a view of the same tabs: each tab has a copy
// in every synced window, the copies share Zen's sync id (tab.id), and one
// of them holds the page's docShell (Zen's _zenContentsVisible). Zen moves
// the docShell to the copy the user selects in the focused window, and off
// a window before it closes. Each copy keeps its own permanentKey.

/** Zen's sync id, shared by a tab's copies; null without one (no window sync). */
export function syncId(tab) {
  const id = tab?.id;
  return typeof id === "string" && id ? id : null;
}

/** The copy of the tab with sync id `id` in `win`, or null. */
function copyInWindow(win, id) {
  const el = win.document?.getElementById(id);
  return el && el.localName === "tab" && !el.closing ? el : null;
}

/**
 * Every window's copy of a tab that's still open, most recently used window
 * first, with `tab` itself among them if it's open. A tab without a sync id
 * is its own only copy.
 *
 * @param {Element} tab
 * @returns {Element[]}
 */
export function copiesOf(tab) {
  const id = syncId(tab);
  if (!id) {
    return tab && !tab.closing && tab.isConnected ? [tab] : [];
  }
  const copies = [];
  for (const win of lazy.BrowserWindowTracker.orderedWindows) {
    if (win.closed || !win.gBrowser) {
      continue;
    }
    const copy = copyInWindow(win, id);
    if (copy) {
      copies.push(copy);
    }
  }
  return copies;
}

/** The copy of `tab` in `win`, or null. */
export function copyIn(tab, win) {
  const id = syncId(tab);
  if (!id) {
    return tab?.ownerDocument?.defaultView === win ? tab : null;
  }
  return win && !win.closed ? copyInWindow(win, id) : null;
}

/**
 * The copy that holds the page's docShell: the one whose browser has
 * `browserId` if given, else the one Zen marks visible, else `tab`.
 *
 * @param {Element} tab
 * @param {number} [browserId]
 * @returns {Element|null}
 */
export function liveCopy(tab, browserId = 0) {
  const copies = copiesOf(tab);
  if (copies.length < 2) {
    return copies[0] ?? null;
  }
  if (browserId) {
    const holder = copies.find(copy => copy.linkedBrowser?.browserId === browserId);
    if (holder) {
      return holder;
    }
  }
  return copies.find(copy => copy._zenContentsVisible) ?? (copies.includes(tab) ? tab : copies[0]);
}

/** Are these the same tab: the same element, or two copies of one tab? */
export function sameTab(a, b) {
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const id = syncId(a);
  return id !== null && id === syncId(b);
}

/**
 * Every tab once, in the order allTabs() first meets it: its live copy for a
 * tab with copies.
 */
export function* uniqueTabs() {
  const seen = new Set();
  for (const tab of allTabs()) {
    const id = syncId(tab);
    if (id === null) {
      yield tab;
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const live = liveCopy(tab);
    if (live) {
      yield live;
    }
  }
}

/**
 * Tabs whose zen-workspace-id is `uuid`, across windows, each tab once (its
 * live copy). Essentials show in every workspace but belong to none, so
 * they're left out.
 */
export function tabsInWorkspace(uuid) {
  const tabs = [];
  for (const tab of uniqueTabs()) {
    if (
      tab.getAttribute("zen-workspace-id") === uuid &&
      !tab.hasAttribute("zen-empty-tab") &&
      !tab.hasAttribute("zen-essential") &&
      !tab.closing
    ) {
      tabs.push(tab);
    }
  }
  return tabs;
}

/**
 * The tab the user sees in a workspace: the selected tab of a window showing
 * it, else the tab Zen will select when the user switches there, else the
 * most recently used one. Null for an empty workspace.
 *
 * @param {string} uuid
 * @returns {Element|null}
 */
export function currentTabOfWorkspace(uuid) {
  const tabs = tabsInWorkspace(uuid);
  if (!tabs.length) {
    return null;
  }
  // A window's selected tab may be a copy of the one in `tabs`.
  const inSpace = tab => tab && tabs.find(t => sameTab(t, tab));
  for (const win of workspaceWindows()) {
    const shown = win.gZenWorkspaces.activeWorkspace === uuid && inSpace(win.gBrowser.selectedTab);
    if (shown) {
      return shown;
    }
  }
  for (const win of workspaceWindows()) {
    const remembered = inSpace(win.gZenWorkspaces.lastSelectedWorkspaceTabs?.[uuid]);
    if (remembered) {
      return remembered;
    }
  }
  return tabs.reduce((best, tab) => ((tab.lastAccessed || 0) > (best.lastAccessed || 0) ? tab : best));
}

/**
 * Of `candidates`, the tab a window shows in workspace `uuid` (the window's
 * selected tab while that workspace is active), else the tab Zen reselects
 * there when the user returns. Null if neither is a candidate.
 *
 * @param {string} uuid
 * @param {Set<Element>} candidates
 * @returns {Element|null}
 */
export function shownOrRememberedTab(uuid, candidates) {
  // A window's selected tab may be a copy of a candidate.
  const candidate = tab => (tab && [...candidates].find(t => sameTab(t, tab))) || null;
  for (const win of workspaceWindows()) {
    const shown = win.gZenWorkspaces.activeWorkspace === uuid && candidate(win.gBrowser.selectedTab);
    if (shown) {
      return shown;
    }
  }
  for (const win of workspaceWindows()) {
    const remembered = candidate(win.gZenWorkspaces.lastSelectedWorkspaceTabs?.[uuid]);
    if (remembered) {
      return remembered;
    }
  }
  return null;
}

/**
 * The tabs a window shows (SPEC §3.5): its selected tab, which is in its
 * active Space, or every tab of the split view holding it. Minimized and
 * covered windows count: closing one of these would change the selection
 * the user comes back to.
 *
 * @param {Window} win
 * @returns {Element[]}
 */
export function shownTabs(win) {
  const selected = win && !win.closed ? win.gBrowser?.selectedTab : null;
  if (!selected) {
    return [];
  }
  if (selected.group?.hasAttribute?.("split-view-group")) {
    return [...selected.group.tabs];
  }
  if (selected.splitview?.tabs?.length) {
    return [...selected.splitview.tabs];
  }
  return [selected];
}

/** Does a window show this tab: any window, any copy of it? */
export function isShown(tab) {
  return copiesOf(tab).some(copy => shownTabs(copy.ownerDocument?.defaultView).includes(copy));
}

/** compareDocumentPosition's DOCUMENT_POSITION_FOLLOWING (no Node global here). */
const FOLLOWING = 4;

/** The last of `tabs` in strip order, or null. They share a window. */
export function lastInStrip(tabs) {
  return tabs.reduce((last, tab) => (!last || last.compareDocumentPosition(tab) & FOLLOWING ? tab : last), null);
}

/** Can the strip the window shows scroll? Zen's own overflow state. */
export function stripOverflows(win) {
  const ws = win.gZenWorkspaces;
  return !!ws?.workspaceElement(ws.activeWorkspace)?.overflows;
}

/**
 * Move an unpinned tab to workspace `uuid`'s strip, from another workspace
 * or within this one: right after `after` (or the folder or split view
 * holding it), else to the bottom. Goes through Zen's zenHandleTabMove, as
 * its own moveTabsToWorkspace does, so the tab strip's bookkeeping and
 * TabMove follow.
 *
 * Window sync moves every other window's copy of the tab on TabMove, to
 * where the tab is at that moment. So a tab enters the workspace in one
 * move, at its place: moveTabsToWorkspace would put it at the top first
 * (zen.view.show-newtab-button-top), and the copies would stay there. And
 * Tabbrowser fires TabMove only when the tab's index changes, while
 * gBrowser.tabs lists only the workspace the window shows: a move inside
 * a workspace the window doesn't show fires none, so this asks window sync
 * to move the copies itself.
 *
 * @param {Element} tab
 * @param {string} uuid
 * @param {Element|null} after
 */
export function placeTab(tab, uuid, after) {
  const win = tab.ownerDocument.defaultView;
  const { gBrowser, gZenWorkspaces } = win;
  const container = gZenWorkspaces.workspaceElement(uuid)?.tabsContainer;
  if (!container || tab.pinned || tab.hasAttribute("zen-essential") || tab.group || tab.splitview) {
    // A tab in a folder or split view stays with it.
    return;
  }
  const entering = tab.getAttribute("zen-workspace-id") !== uuid;
  if (!entering && tab.parentElement !== container) {
    return;
  }
  const topLevel = el => {
    while (el && el.parentElement !== container) {
      el = el.parentElement;
    }
    return el;
  };
  let ref;
  const anchor = after && after !== tab ? topLevel(after) : null;
  if (anchor) {
    ref = anchor.nextSibling;
  } else {
    // After the last tab, folder or split view; the new-tab button stays last.
    const items = [...container.children].filter(
      el => el !== tab && (gBrowser.isTab(el) || gBrowser.isTabGroup?.(el) || gBrowser.isSplitViewWrapper?.(el))
    );
    ref = items.length
      ? items.at(-1).nextSibling
      : container.querySelector(":scope > #tabbrowser-arrowscrollbox-periphery");
  }
  // Never right after a tab on its way out: window sync puts each copy
  // after the copy of the tab before it, and a closing tab's copies may be
  // gone already, which leaves the new tab's copies in the Space each
  // window shows. Before the closing tabs, the order is the same once
  // they're gone. (A close that waits for the user is an open tab still.)
  for (
    let prev = ref ? ref.previousElementSibling : container.lastElementChild;
    prev && prev !== tab && leaving(gBrowser, prev);
    prev = prev.previousElementSibling
  ) {
    ref = prev;
  }
  if (!entering && (ref === tab || tab.nextSibling === ref)) {
    // In place already; window sync copies a new tab after this all the same.
    repairCopiesSoon(tab);
    return;
  }
  let synced = false;
  const onMove = () => {
    synced = true;
  };
  notePlacing(tab);
  tab.addEventListener("TabMove", onMove);
  try {
    gBrowser.zenHandleTabMove(tab, () => {
      if (entering) {
        tab.setAttribute("zen-workspace-id", uuid);
      }
      container.insertBefore(tab, ref);
    });
  } finally {
    tab.removeEventListener("TabMove", onMove);
  }
  if (!synced) {
    syncCopies(tab);
  }
  repairCopiesSoon(tab);
}

/**
 * Is `el` a tab on its way out? Tabbrowser marks a tab closing, and adds it
 * to its removing tabs, from the start of its removal, its animation
 * included, until it leaves the strip.
 *
 * @param {object} gBrowser
 * @param {Element} el
 */
function leaving(gBrowser, el) {
  return gBrowser.isTab(el) && (!!el.closing || !!gBrowser._removingTabs?.has?.(el));
}

/** Have Zen's window sync move every other window's copy of `tab` to where it is. */
function syncCopies(tab) {
  if (!syncId(tab)) {
    return;
  }
  try {
    // Its TabMove handler, which reads only the event's target.
    lazy.ZenWindowSync?.on_TabMove?.({ target: tab });
  } catch (e) {
    console.error("[zenius] window sync didn't move a tab's copies", e);
  }
}

// ---------------------------------------------------------------------------
// Where Zen 1.24's window sync falls short for agent tabs

/** Sync ids of tabs zenius placed lately → when that ends (Date.now() ms). */
const placing = new Map();
// Long enough for window sync's queue, which runs a TabMove's handler after
// any slower handler before it.
const PLACING_MS = 2000;

/** Note that zenius is moving `tab`, and window sync is about to move its copies. */
export function notePlacing(tab) {
  const id = syncId(tab);
  if (!id) {
    return;
  }
  const now = Date.now();
  if (placing.size > 64) {
    for (const [key, until] of placing) {
      if (until < now) {
        placing.delete(key);
      }
    }
  }
  placing.set(id, now + PLACING_MS);
}

/**
 * Whether `tab` is a copy of a tab zenius placed in the last two seconds.
 * Window sync moves each window's copy after the copy of the tab before it,
 * and in a window that shows the tab's Space it animates that move
 * (handle_drop_transition) as a drag from where the copy sat: from a Space
 * the window doesn't show, or from the top of the strip. Every tab in
 * between starts a row off and slides back over about 300 ms, so the
 * window's view jumps when the agent opens a page (I1; windows.test.mjs).
 * The guards' wrapper (modules/guards.sys.mjs) skips that animation for
 * these tabs.
 *
 * @param {Element} tab
 */
export function zeniusPlaced(tab) {
  const id = syncId(tab);
  const until = id ? placing.get(id) : 0;
  if (!until) {
    return false;
  }
  if (until < Date.now()) {
    placing.delete(id);
    return false;
  }
  return true;
}

/** Does window sync copy tabs into `win`? */
function syncsInto(win) {
  return (
    !!win &&
    !win.closed &&
    !win._zenClosingWindow &&
    !!win.gZenWindowSync &&
    !!win.gZenStartup?.isReady &&
    !!win.gZenWorkspaces?.workspaceEnabled &&
    !win.gZenWorkspaces.privateWindowOrDisabled
  );
}

/** Does window sync copy `tab` (as Zen's on_TabOpen decides)? */
function syncsTab(tab) {
  return (
    !!syncId(tab) &&
    Services.prefs.getBoolPref("zen.window-sync.enabled", true) &&
    (tab.pinned || !Services.prefs.getBoolPref("zen.window-sync.sync-only-pinned-tabs", true)) &&
    !tab.ownerDocument?.defaultView?.gZenWorkspaces?.privateWindowOrDisabled
  );
}

/** The tabs of `uuid`'s strip in `win`, in order: not those in folders or split views. */
export function stripTabs(win, uuid) {
  const container = win?.gZenWorkspaces?.workspaceElement(uuid)?.tabsContainer;
  return container ? [...container.children].filter(el => win.gBrowser.isTab(el) && !el.closing) : [];
}

/**
 * Give `win` the copies of `tabs` that window sync left out of it. `tabs`
 * are one window's copies, in their strip's order. Zen 1.24 leaves a window
 * without a tab's copy for good when the window opens while that tab is the
 * session's only one and has no history yet, as a new agent page has: Zen
 * hands the new window the others' tabs as a first window's state, and
 * Firefox's restoreWindow drops a first window's lone blank tab. Without
 * the copy, the user can't find that page in this window, and window sync,
 * which moves a copy after the copy of the tab before it, leaves the next
 * page's copy where it opened: in the Space the window shows, the user's.
 *
 * Each copy is made as Zen's on_TabOpen makes one, then window sync places
 * it, names it and gives it its icon. Call this from a promise job: Zen's
 * own TabOpen handler for a copy is queued, and must find the sync id set,
 * or it would take the copy for a new tab and copy it into every window.
 *
 * @param {Element[]} tabs
 * @param {Window} win
 * @returns {Element[]} the copies made
 */
export function fillCopies(tabs, win) {
  const made = [];
  if (!syncsInto(win)) {
    return made;
  }
  for (const tab of tabs) {
    const id = syncId(tab);
    if (
      !id ||
      tab.closing ||
      !tab.isConnected ||
      tab.ownerDocument?.defaultView === win ||
      copyInWindow(win, id) ||
      !syncsTab(tab) ||
      // Not an agent page: those stay Zen's.
      tab.pinned ||
      tab.group ||
      tab.splitview ||
      ["zen-essential", "zen-empty-tab", "zen-glance-tab"].some(attr => tab.hasAttribute(attr))
    ) {
      continue;
    }
    const copy = win.gBrowser.addTrustedTab("about:blank", {
      inBackground: true,
      skipAnimation: true,
      skipBackgroundNotify: true,
      createLazyBrowser: true,
      userContextId: tab.userContextId,
    });
    copy.id = id;
    if (!tab.hasAttribute("pending")) {
      copy.removeAttribute("pending");
    }
    if (tab.hasAttribute("zenDefaultUserContextId")) {
      copy.setAttribute("zenDefaultUserContextId", true);
    }
    made.push(copy);
    notePlacing(tab);
    syncCopies(tab);
  }
  for (const copy of made) {
    // From the copy that holds the page: Zen syncs a label and an icon from it only.
    const live = copiesOf(copy).find(c => c._zenContentsVisible);
    if (!live) {
      continue;
    }
    try {
      lazy.ZenWindowSync?.on_ZenTabLabelChanged?.({ target: live });
      lazy.ZenWindowSync?.on_ZenTabIconChanged?.({ target: live });
    } catch (e) {
      console.error("[zenius] window sync didn't name a copy", e);
    }
  }
  return made;
}

/**
 * Tabs zenius placed lately → until when (Date.now() ms) repairCopies runs
 * each time window sync has handled one's TabOpen or TabMove.
 *
 * @type {WeakMap<Element, number>}
 */
const repairing = new WeakMap();
// Window sync handles a new tab's TabOpen within a few ms, unless its queue
// holds a slower handler first, such as a docShell swap's.
const REPAIRING_MS = 10000;
/** Does window sync call afterWindowSync? null until first asked; false after shutdown. */
let following = null;

/**
 * Check that each synced window has `tab`'s copy in `tab`'s Space, and
 * repair what window sync left (repairCopies): in a promise job after this
 * when the tab has its sync id, which is when Zen's queued TabMove handler
 * runs and where fillCopies may run, and again each time window sync has
 * handled the tab's TabOpen or TabMove in the next few seconds. A new tab
 * gets its sync id, its copies and their first place in window sync's
 * TabOpen handler, which may run only after the tab's add and move. A Zen
 * whose window sync has no handlers to follow gets the check once the
 * tab has its id.
 *
 * @param {Element} tab
 */
export function repairCopiesSoon(tab) {
  if (!tab) {
    return;
  }
  repairing.set(tab, Date.now() + REPAIRING_MS);
  const follows = followWindowSync();
  if (syncId(tab)) {
    if (syncsTab(tab)) {
      Promise.resolve().then(() => repairNow(tab));
    }
  } else if (!follows) {
    syncedSoon(tab).then(() => {
      if (syncId(tab) && syncsTab(tab)) {
        repairNow(tab);
      }
    });
  }
}

/** Have window sync call afterWindowSync after each event its queue handles, if it can. */
function followWindowSync() {
  if (following === null) {
    following = false;
    try {
      // Inside the try: the lazy getter throws on a Zen without the module.
      const sync = lazy.ZenWindowSync;
      if (typeof sync?.addSyncHandler === "function" && typeof sync.removeSyncHandler === "function") {
        sync.addSyncHandler(afterWindowSync);
        following = true;
      }
    } catch (e) {
      console.error("[zenius] can't follow window sync's handlers", e);
    }
  }
  return following;
}

/** At shutdown: leave nothing of zenius in window sync. */
export function stopFollowingWindowSync() {
  if (following) {
    try {
      lazy.ZenWindowSync.removeSyncHandler(afterWindowSync);
    } catch (e) {
      console.error("[zenius] can't stop following window sync's handlers", e);
    }
  }
  following = false;
}

/**
 * Window sync calls this with each event its queue handled (not those it
 * handles at once, as TabSelect), right after the event's handler, in the
 * next promise job. For a new agent tab, that's right after the TabOpen
 * handler that made and placed the tab's copies: before the window paints,
 * and before the view keeper, which waits for the tab's sync id, puts each
 * window's view back. So a copy that passed through the Space a window
 * shows leaves it unseen. Any other tab's event costs a type check or one
 * lookup.
 *
 * @param {Event} event
 */
function afterWindowSync(event) {
  if (event?.type !== "TabOpen" && event?.type !== "TabMove") {
    return;
  }
  const tab = event.target;
  const until = tab ? repairing.get(tab) : undefined;
  if (!until) {
    return;
  }
  if (until < Date.now()) {
    repairing.delete(tab);
    return;
  }
  if (syncId(tab) && syncsTab(tab)) {
    repairNow(tab);
  }
}

function repairNow(tab) {
  try {
    repairCopies(tab);
  } catch (e) {
    console.error("[zenius] repairing a tab's copies failed", e);
  }
}

/**
 * Give each synced window the copies of `tab`'s strip, up to `tab`, that
 * it lacks (fillCopies), and move those that sit outside the strip of
 * `tab`'s Space in that window into it (moveCopiesInto).
 *
 * @param {Element} tab
 */
function repairCopies(tab) {
  if (tab.closing || !tab.isConnected || tab.group || tab.splitview) {
    return;
  }
  const win = tab.ownerDocument.defaultView;
  const uuid = tab.getAttribute("zen-workspace-id");
  for (const other of workspaceWindows()) {
    if (other === win || !syncsInto(other)) {
      continue;
    }
    const copy = copyInWindow(other, tab.id);
    const box = other.gZenWorkspaces.workspaceElement(uuid)?.tabsContainer;
    if (!box || (copy && box.contains(copy))) {
      continue;
    }
    const strip = stripTabs(win, uuid);
    const upTo = strip.indexOf(tab);
    const tabs = upTo < 0 ? [tab] : strip.slice(0, upTo + 1);
    const made = fillCopies(tabs, other);
    const moved = moveCopiesInto(tabs, other, box, uuid);
    console.warn(
      `[zenius] a window had ${copy ? "its copy of tab " + tab.id + " outside the tab's Space" : "no copy of tab " + tab.id} after window sync; made ${made.length} and moved ${moved} into the Space there`
    );
  }
}

/**
 * Move the copies in `win` of `tabs` (one window's strip, in order) that
 * sit outside `box`, the strip of their Space in `win`, into it: each
 * after the copy of the nearest tab before it whose copy is there, else
 * first, as window sync places a copy. Window sync leaves a copy where it
 * opened, in the Space `win` shows, when the tab before the original has
 * no copy in `win` (a closing tab's may be gone already), and then puts
 * each later page's copy after that one, there too.
 *
 * @param {Element[]} tabs
 * @param {Window} win
 * @param {Element} box
 * @param {string} uuid
 * @returns {number} the copies moved
 */
function moveCopiesInto(tabs, win, box, uuid) {
  const { gBrowser } = win;
  let before = null;
  let moved = 0;
  for (const tab of tabs) {
    const copy = copyInWindow(win, syncId(tab));
    if (!copy || copy.closing) {
      continue;
    }
    if (box.contains(copy)) {
      before = topLevelIn(box, copy);
      continue;
    }
    if (copy.pinned || copy.group || copy.splitview || copy.hasAttribute("zen-essential") || copy === gBrowser.selectedTab) {
      // Not a strip's own tab, or the one the window shows: left as it is.
      continue;
    }
    const ref = before ? before.nextSibling : box.firstChild;
    notePlacing(tab);
    gBrowser.zenHandleTabMove(copy, () => {
      copy.setAttribute("zen-workspace-id", uuid);
      box.insertBefore(copy, ref);
    });
    before = copy;
    moved++;
  }
  return moved;
}

/** The child of `box` that holds `el`: a folder, a split view, or `el`. */
function topLevelIn(box, el) {
  while (el && el.parentElement !== box) {
    el = el.parentElement;
  }
  return el;
}

/** Tabbrowsers zenius is adding an agent tab to → adds under way, until window sync has copied each tab. */
const agentAdds = new Map();

/**
 * Whether an addTab in `gBrowser` is window sync copying an agent tab that
 * zenius is adding in another window. The addTab wrapper
 * (modules/guards.sys.mjs) opens those copies as zenius opens the
 * original: without Zen's open animation, since an animated copy above a
 * window's view slides its tabs down over 120 ms, which the view keeper
 * can't hold; and without Firefox's background-tab notification, which
 * scrolls a strip to show a new tab (SPEC §3.5).
 *
 * @param {object} gBrowser
 */
export function copyingAgentTab(gBrowser) {
  for (const adding of agentAdds.keys()) {
    if (adding !== gBrowser) {
      return true;
    }
  }
  return false;
}

/**
 * Run `fn`, which adds an agent tab to `gBrowser` and returns it, with
 * copyingAgentTab() true for the other windows until window sync has
 * copied the tab: from inside the add, or, when this runs in a promise
 * job, from its queue right after.
 *
 * @param {object} gBrowser
 * @param {() => Element} fn
 * @returns {Element}
 */
export function addingAgentTab(gBrowser, fn) {
  agentAdds.set(gBrowser, (agentAdds.get(gBrowser) ?? 0) + 1);
  const done = () => {
    const left = (agentAdds.get(gBrowser) ?? 1) - 1;
    if (left > 0) {
      agentAdds.set(gBrowser, left);
    } else {
      agentAdds.delete(gBrowser);
    }
  };
  let tab = null;
  try {
    tab = fn();
  } finally {
    if (tab && !syncId(tab)) {
      syncedSoon(tab).then(done);
    } else {
      done();
    }
  }
  return tab;
}

/**
 * Resolves once window sync has given `tab` its sync id (it copies the tab
 * into the other windows in the same handler), or after a few turns of
 * microtasks: its queue may hold a slower handler.
 *
 * @param {Element} tab
 */
export async function syncedSoon(tab) {
  for (let i = 0; i < 20 && !syncId(tab) && !tab.closing; i++) {
    await Promise.resolve();
  }
}

/**
 * Snapshot of what the user sees in each window, for I1 checks: the selected
 * tab, active workspace and focus. Compare two snapshots with `sameView`.
 */
export function viewState() {
  const fm = Services.focus;
  return {
    activeWindow: describeWindow(fm.activeWindow),
    windows: lazy.BrowserWindowTracker.orderedWindows.map(win => ({
      id: describeWindow(win),
      selectedTab: win.gBrowser?.selectedTab?.linkedBrowser?.browserId ?? null,
      // Stable across Zen's docShell swaps, which change the browserId above.
      selectedTabSyncId: syncId(win.gBrowser?.selectedTab),
      activeWorkspace: win.gZenWorkspaces?.activeWorkspace ?? null,
      focusedElement: describeElement(win.document.commandDispatcher?.focusedElement),
    })),
  };
}

function describeWindow(win) {
  return win ? win.docShell?.outerWindowID ?? null : null;
}

function describeElement(el) {
  if (!el) {
    return null;
  }
  return `${el.localName}${el.id ? "#" + el.id : ""}`;
}

/**
 * Run `fn` with Zen's per-tab container logic turned off for this window.
 *
 * Zen's getContextIdIfNeeded() replaces a new tab's container with the active
 * workspace's, and when exactly one workspace uses the requested container it
 * marks the tab to switch the window to that workspace. Neither is right for
 * agent tabs, so for one synchronous gBrowser.addTab call we answer it
 * ourselves.
 *
 * @param {Window} win
 * @param {number} userContextId
 * @param {() => any} fn
 */
export function withoutZenContainerRouting(win, userContextId, fn) {
  const ws = win.gZenWorkspaces;
  const own = Object.getOwnPropertyDescriptor(ws, "getContextIdIfNeeded");
  ws.getContextIdIfNeeded = () => [userContextId, false, undefined];
  try {
    return fn();
  } finally {
    if (own) {
      Object.defineProperty(ws, "getContextIdIfNeeded", own);
    } else {
      delete ws.getContextIdIfNeeded;
    }
  }
}

/**
 * Add a background tab directly into a workspace, without selecting it and
 * without switching the window's workspace.
 *
 * gBrowser.addTab({zenWorkspaceId}) would mark the tab `change-workspace`,
 * and Zen's TabBrowserInserted handler then switches the window to that
 * workspace. So we add the tab to the active strip (bypassing Zen's container
 * routing) and move it before anything paints.
 *
 * @param {Window} win
 * @param {string} workspaceUuid
 * @param {object} [opts]
 * @param {number} [opts.userContextId]
 * @param {Function} [opts.addTab]  the unwrapped gBrowser.addTab, if wrapped
 * @param {(tab: Element) => void} [opts.place]  moves the new tab into the
 *   workspace instead of Zen's moveTabToWorkspace (placeTab, at its place)
 */
export function addBackgroundTab(win, workspaceUuid, { userContextId = 0, addTab, place } = {}) {
  const { gBrowser, gZenWorkspaces } = win;
  const add = addTab ?? gBrowser.addTab;
  // Always about:blank, from a null principal in the tab's container: an
  // agent's URL loads only through page.goto, which checks it (SPEC §3.9,
  // I5). The system principal here would let a URL passed in by mistake
  // open chrome:, about: or file: pages with chrome privileges.
  const tab = addingAgentTab(gBrowser, () =>
    withoutZenContainerRouting(win, userContextId, () =>
      add.call(gBrowser, "about:blank", {
        inBackground: true,
        skipAnimation: true,
        skipRoute: true,
        skipBackgroundNotify: true,
        userContextId,
        triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({ userContextId }),
      })
    )
  );
  if (!tab) {
    throw new Error("gBrowser.addTab returned no tab");
  }
  place?.(tab);
  if (tab.getAttribute("zen-workspace-id") !== workspaceUuid) {
    notePlacing(tab);
    gZenWorkspaces.moveTabToWorkspace(tab, workspaceUuid);
  }
  // Moved or not, window sync copies the new tab after this.
  repairCopiesSoon(tab);
  return tab;
}

// ---------------------------------------------------------------------------
// Closed groups (SPI.md, "Closed groups"): after a task, a page whose group holds the agent's code gets no
// handle to a new window. The parent refuses the opener-linked open; zen-ux's
// pill tells the user when nothing opened in its place.

/** @type {Set<(info: {browser: Element, url: string, reopened: boolean, evident?: true, evidence?: Record<string, string>}) => void>} */
const openRefusedListeners = new Set();

/**
 * Call `fn` for each opener-linked open the parent refuses. `browser` is
 * the opener's top <browser>, `url` the spec Gecko passed ("" for an empty
 * or about:blank open), and `reopened` whether a plain tab with no opener
 * opened the URL in its place; `evident` and `evidence` as withEvidence
 * says. Returns a remover.
 *
 * @param {(info: {browser: Element, url: string, reopened: boolean, evident?: true, evidence?: Record<string, string>}) => void} fn
 * @returns {() => void}
 */
export function onOpenRefused(fn) {
  openRefusedListeners.add(fn);
  return () => openRefusedListeners.delete(fn);
}

/**
 * Tell onOpenRefused's listeners of a refused open. Item 3 calls it, and
 * tests may: a listener's error is logged and doesn't stop the others.
 *
 * @param {{browser: Element, url: string, reopened: boolean}} info
 */
export function noteOpenRefused(info) {
  info = withEvidence(info);
  for (const fn of [...openRefusedListeners]) {
    try {
      fn(info);
    } catch (e) {
      console.error("zenius: an onOpenRefused listener failed", e);
    }
  }
}

/**
 * The events add `evident: true` and the page's `evidence` ({reason:
 * detail}, zen-observe's) when the page has evidence a clean copy clears:
 * hooked or made, the defenses' trigger. Otherwise they leave both out, and zen-ux reads the page.
 * A caller's own value stands.
 */
function withEvidence(info) {
  if (!info?.browser || "evident" in info) {
    return info;
  }
  try {
    const evidence = lazy.ZeniusService.evidenceOf(info.browser);
    return evidence.hooked !== undefined || evidence.made !== undefined ? { ...info, evident: true, evidence } : info;
  } catch (e) {
    console.error("zenius: reading a page's evidence failed for a refusal event, so it counts as evident", e);
    return { ...info, evident: true, evidence: {} };
  }
}

// The reminders (zen-ux): after its task, a page whose top document holds the
// agent's code keeps the task's refusals (content/refusals.sys.mjs). zen-ux's
// card tells the user when their own action there was refused.

/**
 * The kinds content/refusals.sys.mjs reports (its report() calls and
 * WORKER_REFUSALS): the only ones onKeptRefused passes on, since the event
 * comes from the page's own process.
 */
export const KEPT_REFUSAL_KINDS = new Set([
  "cacheStorage",
  "deviceAccess",
  "fullscreen",
  "localNetwork",
  "notification",
  "pointerLock",
  "serviceWorker",
  "share",
  "speech",
  "wakeLock",
]);

/** api and asked are cut to this many characters. */
export const KEPT_TEXT_MAX = 80;

/** @type {Set<(info: {browser: Element, kind: string, api: string, asked: string, evident?: true, evidence?: Record<string, string>}) => void>} */
const keptRefusedListeners = new Set();

/**
 * Call `fn` for each refusal in a page no live task holds whose top
 * document holds the agent's code. `browser` is the tab's top <browser>,
 * `kind` one of KEPT_REFUSAL_KINDS, and `api` and `asked` zen-observe's
 * strings from the event, at most KEPT_TEXT_MAX characters each ("" when
 * absent). Returns a remover.
 *
 * @param {(info: {browser: Element, kind: string, api: string, asked: string}) => void} fn
 * @returns {() => void}
 */
export function onKeptRefused(fn) {
  keptRefusedListeners.add(fn);
  return () => keptRefusedListeners.delete(fn);
}

/**
 * Tell onKeptRefused's listeners of a refusal. The service calls it, and
 * tests may: a listener's error is logged and doesn't stop the others.
 *
 * @param {{browser: Element, kind: string, api: string, asked: string}} info
 */
export function noteKeptRefused(info) {
  info = withEvidence(info);
  for (const fn of [...keptRefusedListeners]) {
    try {
      fn(info);
    } catch (e) {
      console.error("zenius: an onKeptRefused listener failed", e);
    }
  }
}
