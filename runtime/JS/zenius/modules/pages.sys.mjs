// Pages registry: the managed tabs of each task space, addressed by labels
// p1, p2, … that are never reused within a task, plus Ego's ledger of
// released and unmanaged tabs. A page is its tab's Zen sync id: with window
// sync, every window has a copy of the tab, and the page is whichever copy
// holds its docShell (SPI "Windows: a page is its sync id"). Without a sync
// id, a page is tied to its <browser>'s permanentKey, which survives moving
// the tab to another window (the <tab> element doesn't).
//
// Every tab also gets a tab id ("t12") for unmanaged tabs (tabs.list, adopt,
// release). Ids are stable while the browser runs, not across restarts.
//
// A workspace record's tabs are every tab in its workspace. A task's are its
// pages and the tabs its ledger keeps unmanaged (`ledger.unmanaged`, tab id →
// origin): the shared Agents Space also holds other tasks' tabs and the
// user's. Each task tab carries that membership in a session value, which
// Zen saves with the tab, for the restart; lookups stay in memory.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import {
  addBackgroundTab,
  allTabs,
  copiesOf,
  copyIn,
  currentTabOfWorkspace,
  hostWindow,
  isShown,
  lastInStrip,
  liveCopy,
  notePlacing,
  placeTab,
  repairCopiesSoon,
  sameTab,
  shownTabs,
  stripOverflows,
  syncedSoon,
  syncId,
  tabsInWorkspace,
  uniqueTabs,
  workspaceWindows,
} from "chrome://userscripts/content/zenius/modules/windows.sys.mjs";
import { keepAlive, releaseKeepAlive } from "chrome://userscripts/content/zenius/modules/guards.sys.mjs";
import { HELD_PAGES_KEY } from "chrome://userscripts/content/zenius/content/taskset.sys.mjs";
import { log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  // Load with the first agent call that needs them, not at startup (I4).
  redactText: "chrome://userscripts/content/zenius/content/signin.sys.mjs",
  showsSignInResult: "chrome://userscripts/content/zenius/observe/signin.sys.mjs",
});

/**
 * The session value tying a tab to its task: `{v: 1, task, openedBy, sync}`,
 * plus `label` and `opener` while it's a page (SPI "Which tabs are a
 * task's"). `sync` is the tab's Zen sync id, or null before Zen gives it one.
 * A tab moved to another window adds `movedFrom` (movedValue).
 */
export const TAB_VALUE_KEY = "zenius";
/** The task id on a task's pages that aren't the user's: zen-ux's tag reads it. */
export const TASK_ATTR = "zenius-task";

/** Write a tab's session value on every copy of it, or delete it (null). */
function writeTabValue(tab, value) {
  for (const copy of copiesOf(tab)) {
    try {
      if (value) {
        lazy.SessionStore.setCustomTabValue(copy, TAB_VALUE_KEY, JSON.stringify(value));
      } else {
        lazy.SessionStore.deleteCustomTabValue(copy, TAB_VALUE_KEY);
      }
    } catch (e) {
      log("writing a tab's session value failed", e.message);
    }
  }
}

/**
 * The value of a tab moved to another window: the task's, naming the sync
 * id the old tab had (`movedFrom`). Zen closes the old tab's copies in the
 * other windows from a queue of its own, and a quit before it has can keep
 * them in the session. They come back blank, with that sync id and the
 * task's value, and only this tells them from the task's tabs: the restart
 * closes them (Pages.closeLeftBehind). Zen never gives a sync id twice, so
 * only those copies have it. A tab with no sync id left none behind.
 *
 * Its `sync` is the new tab's own from the start: none in a torn-off
 * window, or none yet in a synced one, until Zen gives it one (#syncSoon).
 * A quit before then finds a value its tab owns, never the old tab's id.
 *
 * @param {object} value  the task's value, as the old tab had it
 * @param {string|null} from  the old tab's sync id
 * @param {string|null} to  the new tab's sync id
 */
function movedValue(value, from, to) {
  const moved = { ...value, sync: to };
  delete moved.movedFrom;
  if (from) {
    moved.movedFrom = from;
  }
  return moved;
}

/** zen-ux's tag on every copy of a tab: the task id, or none (null). */
function writeTag(tab, taskId) {
  for (const copy of copiesOf(tab)) {
    if (taskId === null) {
      copy.removeAttribute(TASK_ATTR);
    } else {
      copy.setAttribute(TASK_ATTR, String(taskId));
    }
  }
}

/** A custom session value of one tab element, or null. */
function rawValue(tab, key) {
  try {
    return lazy.SessionStore.getCustomTabValue(tab, key) || null;
  } catch {
    return null;
  }
}

/**
 * The session value that marks the user's own tab (zen-ux's "Use your own
 * tab"): no task ever holds it (I2).
 */
export const OWN_TAB_KEY = "zenius-own";

/** A tab's session value, or null: its own, else another copy's. */
export function readTabValue(tab) {
  for (const copy of [tab, ...copiesOf(tab).filter(c => c !== tab)]) {
    try {
      const raw = rawValue(copy, TAB_VALUE_KEY);
      const value = raw ? JSON.parse(raw) : null;
      if (value?.v === 1 && Number.isInteger(value.task)) {
        return value;
      }
    } catch {}
  }
  return null;
}

/**
 * Is a session value its tab's own? Firefox copies a tab's session values
 * into the tabs the user makes from it (Duplicate Tab, Reopen Closed Tab),
 * and Zen gives each of those a sync id of its own. So a task's value names
 * the sync id of the tab it was written for, and only that tab is the
 * task's. A value that names none (an older runtime's) can't show which tab
 * it was written for: the tab is the user's.
 *
 * @param {Element} tab
 * @param {object} value  readTabValue(tab)
 */
export function ownValue(tab, value) {
  return !!value && Object.hasOwn(value, "sync") && value.sync === syncId(tab);
}

/** Ego's default page budget (EGO_BROWSER_PAGE_BUDGET). */
export const DEFAULT_PAGE_BUDGET = 8;

/**
 * The budget when a request doesn't carry one (its top-level pageBudget,
 * from the SDK's EGO_BROWSER_PAGE_BUDGET): pref zenius.pageBudget, else
 * Ego's 8.
 */
export function defaultPageBudget() {
  const n = Services.prefs.getIntPref("zenius.pageBudget", DEFAULT_PAGE_BUDGET);
  return n > 0 ? n : DEFAULT_PAGE_BUDGET;
}
/** Ego's label rule (page-ledger.ts assertLabel). */
const LABEL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Remote types of web pages' documents, as observe/webcontent.sys.mjs has them. */
const WEB_PROCESS = /^(web$|webIsolated=|webCOOP\+COEP=)/;

/**
 * @typedef {object} PageRecord
 * @property {string} label
 * @property {number} spaceId
 * @property {"agent"|"unknown"} openedBy  agent: opened by the agent (newPage, popups); unknown: adopted
 * @property {object} key        the live copy's browser's permanentKey
 * @property {string|null} syncId  Zen's sync id, shared by every window's copy
 * @property {number} browserId  the docShell's browserId, which moves with it (0 until known)
 * @property {Element|null} tab  last known live copy; revalidated on every lookup
 * @property {number} createdAt  epoch ms
 * @property {string|null} opener  label of the page that opened this popup
 */

/** How many tabs the user holds in `tab`'s browsing context group (observe/hold.sys.mjs publishes them). */
function heldInGroup(tab) {
  const held = Services.ppmm.sharedData.get(HELD_PAGES_KEY);
  if (!held?.size) {
    return 0;
  }
  try {
    return tab.linkedBrowser.browsingContext.group.getToplevels().filter(top => held.has(top.browserId)).length;
  } catch {
    return 0;
  }
}

export class Pages {
  /** @type {Map<number, Map<string, PageRecord>>} spaceId → label → page */
  #bySpace = new Map();
  /** @type {WeakMap<object, PageRecord>} the live copy's permanentKey → page */
  #byKey = new WeakMap();
  /** @type {Map<string, PageRecord>} Zen sync id → page */
  #bySync = new Map();
  /** @type {WeakMap<object, string>} permanentKey → tab id, for tabs without a sync id */
  #tabIds = new WeakMap();
  /** @type {Map<string, string>} Zen sync id → tab id, shared by the copies */
  #syncTabIds = new Map();
  #nextTabId = 1;
  /** Called after pages are added or removed (the service republishes state). */
  onChange = null;
  /** (page, from, to) after a page's live copy changed: the service emits pageMoved. */
  onMoved = null;
  /** () once a task's session value is written: the service then watches tab restores. */
  onTaskValue = null;

  // ---------------------------------------------------------------------------
  // Tab ids

  /** A tab's id ("t12"), the same for every copy of it. @param {Element} tab */
  tabId(tab) {
    const key = tab?.linkedBrowser?.permanentKey;
    const sync = syncId(tab);
    if (sync) {
      let id = this.#syncTabIds.get(sync);
      if (!id) {
        // Window sync gives a tab its sync id from a queue of its own: an id
        // given before that stays the tab's id.
        id = (key && this.#tabIds.get(key)) || `t${this.#nextTabId++}`;
        this.#syncTabIds.set(sync, id);
      }
      return id;
    }
    if (!key) {
      return null;
    }
    let id = this.#tabIds.get(key);
    if (!id) {
      id = `t${this.#nextTabId++}`;
      this.#tabIds.set(key, id);
    }
    return id;
  }

  /**
   * The open tab, if any, that a closing tab moved to. A tear-off or a drag
   * to another window gives the new tab the old one's id (carryOver), and
   * Zen then closes the copies left behind.
   *
   * @param {Element} tab  a closing copy
   * @returns {Element|null}
   */
  movedTab(tab) {
    const id = this.#knownTabId(tab);
    if (!id) {
      return null;
    }
    for (const other of allTabs()) {
      if (other !== tab && !other.closing && this.#knownTabId(other) === id) {
        return other;
      }
    }
    return null;
  }

  /** A tab's id if it has one: tabId() without giving it one. */
  #knownTabId(tab) {
    const sync = syncId(tab);
    const key = tab?.linkedBrowser?.permanentKey;
    return (sync && this.#syncTabIds.get(sync)) || (key && this.#tabIds.get(key)) || null;
  }

  /**
   * A live tab of the space by tab id.
   *
   * @param {object} space  SpaceRecord
   * @param {string} id
   */
  findTab(space, id) {
    if (typeof id !== "string" || !id) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "tab must be a tab id from tabs.list, such as \"t12\"");
    }
    for (const tab of this.tabsOf(space)) {
      if (this.tabId(tab) === id) {
        return tab;
      }
    }
    return null;
  }

  /**
   * The space's tabs: for a workspace record every tab in the workspace, for
   * a task its pages and its unmanaged tabs. A task's tabs in its home come
   * first, in strip order, then any the user moved to another Space: Zen
   * lists the active Space's tabs first, which would reorder tabs.list as
   * the user switches.
   *
   * @param {object} space  SpaceRecord
   * @returns {Element[]}
   */
  tabsOf(space) {
    if (space.kind !== "task") {
      return tabsInWorkspace(space.uuid).filter(tab => !this.isUserOwn(tab));
    }
    const home = [];
    const elsewhere = [];
    // Each tab once, as its live copy (window sync).
    for (const tab of uniqueTabs()) {
      if (tab.closing || !tab.linkedBrowser) {
        continue;
      }
      const page = this.forTab(tab);
      if (page ? page.spaceId === space.id : this.tabId(tab) in space.ledger.unmanaged && !this.isUserOwn(tab)) {
        (tab.getAttribute("zen-workspace-id") === space.uuid ? home : elsewhere).push(tab);
      }
    }
    return home.concat(elsewhere);
  }

  // ---------------------------------------------------------------------------
  // Placement in the Agents Space (SPEC §3.5)

  /** @type {Map<Element, object>} tabs left at the bottom while their window showed the Space → task */
  #unplaced = new Map();

  /**
   * Runs every change zenius makes to a tab strip and returns its value. A
   * tab added or moved above the one a window shows moves that tab down a
   * row, and Zen's strip has no scroll anchoring: zen-ux's view keeper
   * (ui/viewkeeper.sys.mjs) replaces this to put every window's view back.
   */
  keepView = fn => fn();

  /** Can the strip this window shows scroll? zen-ux's stripCanScroll replaces it. */
  stripCanScroll = win => stripOverflows(win);

  /**
   * Add a background tab for the space to `win`, placed as SPEC §3.5 says.
   * The view keeper covers the add too: gBrowser.addTab first puts the tab
   * in the window's active Space, the user's, before it moves.
   *
   * @param {object} space  SpaceRecord
   * @param {Window} win
   */
  addTab(space, win) {
    let tab = null;
    this.keepView(() => {
      tab = addBackgroundTab(win, space.uuid, {
        userContextId: space.userContextId ?? 0,
        place: t => this.#place(space, t),
      });
      // Window sync copies the tab into the other windows from inside the
      // add, or, when this runs in a promise job, from its queue right
      // after: keep every window's view until it has.
      return syncId(tab) ? null : syncedSoon(tab);
    });
    return tab;
  }

  /**
   * Move a tab into the space's workspace and place it there: a popup. The
   * caller keeps the view (the addTab wrapper in modules/guards.sys.mjs).
   */
  moveIn(space, tab) {
    this.#place(space, tab);
    if (tab.getAttribute("zen-workspace-id") !== space.uuid) {
      notePlacing(tab);
      tab.ownerDocument.defaultView.gZenWorkspaces.moveTabToWorkspace(tab, space.uuid);
      repairCopiesSoon(tab);
    }
  }

  /**
   * Put a task's new tab in the Agents Space's strip: a task's first tab at
   * the bottom, a later one right after the task's last tab, so tasks stay
   * together and starting one never moves a tab the user sees. While any
   * window shows the Space in a strip too short to scroll, a tab put above
   * the user's would move theirs a row with no room to scroll it back: it
   * goes to the bottom, and settle() moves it next to its task once no
   * window shows the Space.
   *
   * A tab from another workspace enters the strip in the same move, so
   * window sync puts every window's copy of it there too (placeTab).
   *
   * @param {object} space  SpaceRecord
   * @param {Element} tab   in space.uuid's strip, or entering it
   */
  #place(space, tab) {
    if (space.kind !== "task") {
      return;
    }
    let after = this.#lastTabOf(space, tab);
    // Any window that shows the Space: Zen moves every window's copy of the
    // tab to the same place (window sync).
    const short = workspaceWindows().some(
      win => win.gZenWorkspaces?.activeWorkspace === space.uuid && !this.stripCanScroll(win)
    );
    if (after && short) {
      this.#unplaced.set(tab, space);
      after = null;
    }
    placeTab(tab, space.uuid, after);
  }

  /** Move the tabs #place() left at the bottom next to their task, where no window shows the Space now. */
  settle() {
    this.keepView(() => this.#settle());
  }

  #settle() {
    for (const [tab, space] of this.#unplaced) {
      if (!tab.isConnected || tab.closing || space.gone) {
        this.#unplaced.delete(tab);
        continue;
      }
      const uuid = tab.getAttribute("zen-workspace-id");
      if (workspaceWindows().some(win => win.gZenWorkspaces?.activeWorkspace === uuid)) {
        continue;
      }
      this.#unplaced.delete(tab);
      const after = this.#lastTabOf(space, tab);
      if (after && uuid === space.uuid) {
        placeTab(tab, uuid, after);
      }
    }
  }

  /** Does settle() have work? */
  get unsettled() {
    return this.#unplaced.size > 0;
  }

  /**
   * The task's last tab in `tab`'s window and strip, other than `tab` and
   * tabs still to settle. Its copy in that window: Zen syncs the strip's
   * order to every window.
   */
  #lastTabOf(space, tab) {
    const uuid = space.uuid;
    const win = tab.ownerDocument.defaultView;
    return lastInStrip(
      this.tabsOf(space)
        .map(t => copyIn(t, win))
        .filter(
          t =>
            t &&
            !sameTab(t, tab) &&
            t.getAttribute("zen-workspace-id") === uuid &&
            !t.pinned &&
            !this.#unplaced.has(t)
        )
    );
  }

  // ---------------------------------------------------------------------------
  // Registry

  /** @param {number} spaceId */
  #table(spaceId) {
    let table = this.#bySpace.get(spaceId);
    if (!table) {
      table = new Map();
      this.#bySpace.set(spaceId, table);
    }
    return table;
  }

  /**
   * Register a tab as a managed page.
   *
   * @param {object} space  SpaceRecord (its ledger records the label)
   * @param {Element} tab
   * @param {"agent"|"unknown"} openedBy
   * @param {{label?: string, opener?: string}} [opts]
   */
  register(space, tab, openedBy, { label, opener = null } = {}) {
    const ledger = space.ledger;
    const used = new Set(ledger.usedLabels);
    if (label !== undefined) {
      if (typeof label !== "string" || !LABEL_RE.test(label)) {
        throw new ZenError(
          "ZEN_INVALID_ARGUMENT",
          "page label must start with a letter and contain only letters, numbers, _ or -"
        );
      }
      if (used.has(label)) {
        throw new ZenError("ZEN_INVALID_ARGUMENT", `page label already used: ${label}`, { page: label });
      }
    } else {
      let n = ledger.nextLabel;
      while (used.has(`p${n}`)) {
        n++;
      }
      label = `p${n}`;
      ledger.nextLabel = n + 1;
    }
    ledger.usedLabels.push(label);
    const id = this.tabId(tab);
    delete ledger.unmanaged[id];
    ledger.retained = ledger.retained.filter(t => t !== id);
    const page = this.#newPage(space, tab, { label, openedBy, opener });
    this.#mark(space, tab, { label, openedBy, opener });
    // Closed groups, item 1: a tab that joins its task while its group holds
    // a window outside the task never runs the agent's code there.
    this.codeRefusal(space, page);
    this.onChange?.();
    return page;
  }

  /** A page record for `tab`'s live copy, in the space's table and the lookups. */
  #newPage(space, tab, { label, openedBy, opener }) {
    const live = liveCopy(tab) ?? tab;
    const page = {
      label,
      spaceId: space.id,
      openedBy,
      key: live.linkedBrowser.permanentKey,
      syncId: syncId(live),
      browserId: live.linkedBrowser.browserId || 0,
      tab: live,
      createdAt: Date.now(),
      opener,
    };
    this.#table(space.id).set(label, page);
    this.#byKey.set(page.key, page);
    if (page.syncId) {
      this.#bySync.set(page.syncId, page);
    }
    return page;
  }

  /**
   * Put a restored tab back in its task (the restart rebuild): under its
   * label if it was a page, else as an unmanaged tab of its origin. The tab
   * stays unloaded; a page method loads it (the service's restore gate).
   *
   * @param {object} space  SpaceRecord, a task
   * @param {Element} tab
   * @param {{label?: string, openedBy?: string, opener?: string}} value  its session value
   * @returns {PageRecord|null}
   */
  reattach(space, tab, value) {
    const openedBy = ["agent", "user", "unknown"].includes(value.openedBy) ? value.openedBy : "unknown";
    const label = typeof value.label === "string" && LABEL_RE.test(value.label) ? value.label : null;
    if (!label || this.#table(space.id).has(label) || !tab.linkedBrowser?.permanentKey) {
      this.addUnmanaged(space, tab, openedBy);
      return null;
    }
    if (!space.ledger.usedLabels.includes(label)) {
      space.ledger.usedLabels.push(label);
    }
    const opener = typeof value.opener === "string" && LABEL_RE.test(value.opener) ? value.opener : null;
    const page = this.#newPage(space, tab, { label, openedBy, opener });
    this.#mark(space, tab, { label, openedBy, opener });
    return page;
  }

  /** A tab whose task is gone: no session value, no tag. It's the user's. */
  forgetTask(tab) {
    writeTabValue(tab, null);
    writeTag(tab, null);
  }

  /**
   * Make a tab one of the task's unmanaged tabs, of origin `openedBy`: the
   * blank tab pages.close leaves, a page that stopped being one, a tab the
   * user opened from a page.
   *
   * @param {object} space  SpaceRecord
   * @param {Element} tab
   * @param {"agent"|"user"|"unknown"} openedBy
   */
  addUnmanaged(space, tab, openedBy) {
    if (this.isUserOwn(tab)) {
      return;
    }
    space.ledger.unmanaged[this.tabId(tab)] = openedBy;
    this.#mark(space, tab, { openedBy });
  }

  /**
   * zen-ux's "Use your own tab": the tab the user opens for a page they log
   * in to themselves. No task ever holds it, not even one that claims its
   * workspace, so no agent call reaches it (I2). Its own session value keeps
   * the mark across restarts and window moves. An agent's page can't be
   * marked.
   *
   * @returns {boolean} whether the tab is marked now
   */
  markUserOwn(tab) {
    if (!tab?.linkedBrowser || this.forTab(tab)) {
      return false;
    }
    // Every window's copy is the user's own (window sync).
    for (const copy of copiesOf(tab)) {
      try {
        lazy.SessionStore.setCustomTabValue(copy, OWN_TAB_KEY, "1");
      } catch (e) {
        log("marking the user's own tab failed", e.message);
        return false;
      }
    }
    for (const space of this.spaces?.records() ?? []) {
      if (space.ledger) {
        delete space.ledger.unmanaged[this.tabId(tab)];
      }
    }
    writeTabValue(tab, null);
    writeTag(tab, null);
    return true;
  }

  /** Is this the user's own tab (markUserOwn)? Any copy's mark counts. */
  isUserOwn(tab) {
    if (rawValue(tab, OWN_TAB_KEY)) {
      return true;
    }
    return copiesOf(tab).some(copy => copy !== tab && rawValue(copy, OWN_TAB_KEY));
  }

  /**
   * A window opened later gets its copies of every tab from Zen: give each
   * the marks of the tab's other copies (the session values and the tag), so
   * restarts and zen-ux's tags see the same tab in every window.
   *
   * @param {Element[]} tabs  new copies, in one window or several
   */
  markCopies(tabs) {
    for (const tab of tabs) {
      if (!syncId(tab) || tab.closing) {
        continue;
      }
      const others = copiesOf(tab).filter(copy => copy !== tab);
      // A page made before Zen gave its tab a sync id: any copy finds it now.
      for (const copy of others) {
        const page = this.#byKey.get(copy.linkedBrowser?.permanentKey);
        if (page) {
          this.#noteSyncId(page, copy);
          break;
        }
      }
      for (const key of [TAB_VALUE_KEY, OWN_TAB_KEY]) {
        const value = others.map(copy => rawValue(copy, key)).find(Boolean);
        if (value && rawValue(tab, key) !== value) {
          try {
            lazy.SessionStore.setCustomTabValue(tab, key, value);
          } catch (e) {
            log("copying a tab's session value to its copy failed", e.message);
          }
        }
      }
      const tag = others.map(copy => copy.getAttribute(TASK_ATTR)).find(Boolean);
      if (tag && tab.getAttribute(TASK_ATTR) !== tag) {
        tab.setAttribute(TASK_ATTR, tag);
      }
      this.#refreshSync(tab);
    }
  }

  /**
   * A tab moving to another window is a new element there, with the same
   * browser: its tag and session value go with it.
   *
   * A page goes with its document. When the tab that moved held it (a drag
   * to another window, or a tear-off into a new one, after which Zen closes
   * the copies left behind), the page is that tab now, and its value names
   * that tab's sync id, or none until Zen gives it one. A copy that moved
   * without the document (another window's copy of the page) takes
   * nothing: the page stays with its document, or ends with it, and the new
   * tab is the user's. Firefox has already moved the old tab's session
   * values to the new one by then, so that tab loses the task's. A tab the
   * task keeps that isn't a page goes the same way, and keeps its tab id,
   * by which the task's ledger holds it. Its copy that holds the document
   * is the one whose contents show (window sync); with none shown, as for
   * a tab no window has selected since a restart, the moving copy is it.
   * Either way, the moved tab's value names the old tab's sync id
   * (movedValue): a restart closes the copies left behind that a quit kept.
   *
   * This runs at the old tab's TabClose, before Firefox swaps the browsers:
   * the old tab's permanentKey and docShell go to the new tab after it.
   *
   * @returns {PageRecord|null} the page that moved, if one did
   */
  carryOver(from, to) {
    if (!to) {
      return null;
    }
    // A "Task finished" tab the user takes to another window is theirs.
    if (this.#deferred.delete(deferKey(from))) {
      writeTabValue(to, null);
      return null;
    }
    const value = readTabValue(from) ?? readTabValue(to);
    if (!value) {
      return null;
    }
    const key = from.linkedBrowser?.permanentKey;
    const page = value.label && key ? (this.#byKey.get(key) ?? null) : null;
    const standIn = value.label
      ? page?.spaceId !== value.task
      : copiesOf(from).some(copy => copy !== from && copy._zenContentsVisible);
    if (standIn) {
      // The user's tab, with a tab id of its own (movedTab).
      if (key) {
        this.#tabIds.delete(key);
      }
      writeTabValue(to, null);
      writeTag(to, null);
      return null;
    }
    writeTabValue(to, movedValue(value, syncId(from), syncId(to)));
    if (page) {
      writeTag(to, page.openedBy !== "user" ? page.spaceId : null);
      this.#rehome(page, to, key);
      if (from.undiscardable) {
        // Once the swap has given it the page's browser.
        Promise.resolve().then(() => keepAlive(to));
      }
      return page;
    }
    // Its tab id goes by the browser that moves to the new tab: a torn-off
    // window's tab has no sync id, and one in a synced window gets its own.
    const id = this.tabId(from);
    if (key && id) {
      this.#tabIds.set(key, id);
    }
    if (from.hasAttribute(TASK_ATTR)) {
      to.setAttribute(TASK_ATTR, from.getAttribute(TASK_ATTR));
    }
    if (syncId(to)) {
      this.#refreshSync(to);
    } else {
      this.#syncSoon(to);
    }
    return null;
  }

  /** The space's tabs with their origins, pages included: what a task keeps when its labels end. */
  members(space) {
    return this.tabsOf(space).map(tab => {
      const page = this.forTab(tab);
      return { tab, openedBy: page?.openedBy ?? space.ledger.unmanaged[this.tabId(tab)] ?? "unknown" };
    });
  }

  /**
   * Write a task tab's session value and zen-ux's tag. Only tasks have
   * them: a workspace's tabs are its by where they are, and its Space
   * shows whose it is.
   */
  #mark(space, tab, { label = null, openedBy, opener = null }) {
    if (space.kind !== "task") {
      return;
    }
    const value = { v: 1, task: space.id, openedBy };
    if (label) {
      value.label = label;
      if (opener) {
        value.opener = opener;
      }
    }
    value.sync = syncId(tab);
    writeTabValue(tab, value);
    writeTag(tab, label && openedBy !== "user" ? space.id : null);
    this.#syncSoon(tab);
    this.onTaskValue?.();
  }

  /**
   * A tab leaves its task for good and is the user's: its page, if it's
   * one, and its ledger entry go, and so do its session value and tag, so
   * no claim, adoption or restart gives it back to the task. A secret
   * step's tab that didn't blank, at the hand back
   * (service.blankSecretSteps).
   *
   * @param {object} space  SpaceRecord
   * @param {Element} tab  any copy
   * @returns {object|null} the space's page it was, if any
   */
  leaveTask(space, tab) {
    const id = this.tabId(tab);
    const found = this.forTab(tab);
    const page = found?.spaceId === space.id ? found : null;
    if (page) {
      this.remove(page);
    }
    delete space.ledger.unmanaged[id];
    space.ledger.retained = space.ledger.retained.filter(t => t !== id);
    releaseKeepAlive(liveCopy(tab) ?? tab);
    writeTabValue(tab, null);
    writeTag(tab, null);
    this.onTaskValue?.();
    return page;
  }

  /**
   * Which task holds this tab, as a page, a tab its ledger keeps, or a close
   * that waits: its id, else null. A tab carrying a task's session value
   * that no task holds is the user's.
   *
   * @param {Element} tab  any copy
   * @returns {number|null}
   */
  holderOf(tab) {
    const page = this.forTab(tab);
    if (page) {
      return page.spaceId;
    }
    const rec = this.#holderOf(this.tabId(tab));
    if (rec) {
      return rec.id;
    }
    return this.#deferred.get(deferKey(tab))?.spaceId ?? null;
  }

  /**
   * Zen gives a new tab its sync id after TabOpen, from a queue of its own:
   * once it has, the value of a tab its task holds names it.
   */
  #syncSoon(tab) {
    if (!syncId(tab)) {
      syncedSoon(tab).then(() => this.#refreshSync(tab));
    }
  }

  /** Name the tab's sync id, or none, in its value, if a task holds it and the value names another. */
  #refreshSync(tab) {
    if (tab.closing) {
      return;
    }
    const sync = syncId(tab);
    const value = readTabValue(tab);
    if (value && value.sync !== sync && this.holderOf(tab) === value.task) {
      writeTabValue(tab, { ...value, sync });
    }
  }

  /**
   * Open a new background tab (about:blank) in the space's workspace and
   * label it. A URL loads afterwards, through page.goto.
   *
   * @param {object} space  SpaceRecord
   */
  open(space) {
    const win = hostWindow(space.window);
    if (!win) {
      throw new ZenError("ZEN_BROWSER_UNAVAILABLE", "no browser window with workspaces is open");
    }
    space.window = win;
    const tab = this.addTab(space, win);
    keepAlive(tab);
    return this.register(space, tab, "agent");
  }

  // ---------------------------------------------------------------------------
  // Closed groups (SPI.md, "Closed groups"):
  // a document where the agent's code can run never shares a browsing
  // context group with a window outside its task.

  /** @type {WeakMap<PageRecord, {reason: "group", windows: number}>} pages refused the agent's code */
  #codeRefused = new WeakMap();

  /**
   * How many top-level windows in `tab`'s browsing context group aren't
   * pages of `space`: windows the code of a document in `tab` could reach
   * (its opener, a named lookup, a message's source). A top counts by its
   * browserId, so a page's own documents in the back-forward cache are its
   * own (Gecko keeps them in their old group). A window still opening has
   * no tab yet and doesn't count: it's in one before code could use it.
   *
   * @param {object} space  SpaceRecord
   * @param {Element} tab
   * @returns {number}
   */
  outsideTask(space, tab) {
    const group = tab?.linkedBrowser?.browsingContext?.group;
    if (!group) {
      return 0;
    }
    const mine = new Set();
    for (const page of this.list(space.id)) {
      const browserId = this.tabFor(page)?.linkedBrowser?.browserId;
      if (browserId) {
        mine.add(browserId);
      }
    }
    let outside = 0;
    for (const top of group.getToplevels()) {
      if (!mine.has(top.browserId) && (top.embedderElement || top.isInBFCache)) {
        outside++;
      }
    }
    return outside;
  }

  /**
   * Closed groups, item 1: why the agent's code may not run in `page`, or
   * null. Once a check finds a window outside the task in the page's group,
   * the page never runs it again while it's in the task: code there could
   * reach that window, and code run earlier would stay. register() checks
   * when a tab joins a task, and every method that runs the agent's code
   * checks before each call (zen-observe's and zen-input's). In memory only:
   * after a restart every tab has a group of its own.
   *
   * No answer, and nothing kept, while the tab's document isn't in a web
   * content process. An add-on's page (about:compat, any moz-extension:
   * page) shares its group with the add-on's background page, which is no
   * window of the user's (zen-observe measured it on Linux). zenius
   * runs no agent code in such a document (observe/webcontent.sys.mjs), and
   * a load from it to the web gets a group of its own, which the next check
   * sees.
   *
   * While the user holds a page of the group (zen-observe's holdPage), it
   * counts as outside the task: no agent code runs anywhere in the group,
   * where a page could still hold the held page's handle. That refusal
   * ("hold") isn't kept: it ends with the hold.
   *
   * @param {object} space  SpaceRecord
   * @param {PageRecord} page
   * @returns {{reason: "group"|"hold", windows: number}|null}  no URLs: they're the user's
   */
  codeRefusal(space, page) {
    const known = this.#codeRefused.get(page);
    if (known) {
      return { ...known };
    }
    const tab = this.tabFor(page);
    const remoteType = tab?.linkedBrowser?.browsingContext?.currentWindowGlobal?.domProcess?.remoteType ?? "";
    if (!WEB_PROCESS.test(remoteType)) {
      return null;
    }
    const held = heldInGroup(tab);
    if (held) {
      return { reason: "hold", windows: held };
    }
    const windows = this.outsideTask(space, tab);
    if (!windows) {
      return null;
    }
    const refusal = { reason: "group", windows };
    this.#codeRefused.set(page, refusal);
    log(`closed groups: page ${page.label} of space ${space.id} shares its group with ${windows} window(s) outside the task; no agent code runs there while it's in the task`);
    return { ...refusal };
  }

  /**
   * The other pages of `page`'s task in its browsing context group: the
   * pages a release has to take along (closed groups, decision 1).
   *
   * @param {object} space  SpaceRecord
   * @param {PageRecord} page
   * @returns {PageRecord[]}
   */
  groupMates(space, page) {
    const group = this.tabFor(page)?.linkedBrowser?.browsingContext?.group;
    if (!group) {
      return [];
    }
    const tops = new Set(group.getToplevels().map(top => top.browserId));
    return this.list(space.id).filter(
      other => other !== page && tops.has(this.tabFor(other)?.linkedBrowser?.browserId)
    );
  }

  /** Live pages of a space, in label order of creation. */
  list(spaceId) {
    const pages = [];
    for (const page of this.#table(spaceId).values()) {
      if (this.tabFor(page)) {
        pages.push(page);
      }
    }
    return pages;
  }

  /**
   * @param {object} space  SpaceRecord
   * @param {string} label
   * @returns {PageRecord}
   */
  get(space, label) {
    const page = this.#table(space.id).get(label);
    if (page && this.tabFor(page)) {
      return page;
    }
    // Ego's ledger diagnostics: say why a label no longer works.
    const ledger = space.ledger;
    let message = `page label not found: ${label}`;
    if (ledger.releasedLabels.includes(label)) {
      message = `page ${label} was released`;
    } else if (ledger.usedLabels.includes(label)) {
      message = `page ${label} was closed`;
    }
    throw new ZenError("ZEN_PAGE_NOT_FOUND", message, { space: space.id, page: label });
  }

  /** A live page by label, or null; never throws. */
  peek(spaceId, label) {
    const page = this.#bySpace.get(spaceId)?.get(label);
    return page && this.tabFor(page) ? page : null;
  }

  /** The page record for a tab, if it is managed. */
  forTab(tab) {
    return this.forBrowser(tab?.linkedBrowser);
  }

  /** The page record for a <browser>, any copy's, if it is managed. */
  forBrowser(browser) {
    const key = browser?.permanentKey;
    const page = key ? this.#byKey.get(key) : null;
    if (page) {
      return page;
    }
    // Another window's copy of the page's tab (window sync).
    const tab = browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser?.(browser);
    const sync = syncId(tab);
    return (sync && this.#bySync.get(sync)) ?? null;
  }

  /** Is `tab` a copy of the page's tab? */
  #isPageTab(tab, page) {
    return tab.linkedBrowser?.permanentKey === page.key || (page.syncId !== null && syncId(tab) === page.syncId);
  }

  /**
   * The page's live <tab>: the copy, in whichever window, that holds its
   * docShell (Zen moves it between windows' copies). Null once the tab has
   * closed in every window. A move found here is the page's: pageMoved.
   */
  tabFor(page) {
    let tab = page.tab;
    if (!(tab?.isConnected && !tab.closing && this.#isPageTab(tab, page))) {
      tab = null;
      for (const t of allTabs()) {
        if (!t.closing && this.#isPageTab(t, page)) {
          tab = t;
          break;
        }
      }
    }
    if (!tab) {
      page.tab = null;
      return null;
    }
    const live = liveCopy(tab, page.browserId) ?? tab;
    const from = page.tab;
    if (live !== from) {
      this.#rehome(page, live);
      if (from && sameTab(from, live)) {
        this.onMoved?.(page, from, live);
      }
    }
    // Zen gives a tab its sync id after TabOpen, from a queue of its own.
    this.#noteSyncId(page, live);
    const browserId = live.linkedBrowser?.browserId;
    if (browserId) {
      page.browserId = browserId;
    }
    return live;
  }

  /** Record the page's sync id once Zen has given its tab one. */
  #noteSyncId(page, tab) {
    const sync = syncId(tab);
    if (sync && page.syncId !== sync) {
      if (page.syncId && this.#bySync.get(page.syncId) === page) {
        this.#bySync.delete(page.syncId);
      }
      page.syncId = sync;
      this.#bySync.set(sync, page);
      this.#refreshSync(tab);
    }
  }

  /**
   * Make `live` the page's tab in the lookups.
   *
   * @param {PageRecord} page
   * @param {Element} live
   * @param {object} [key]  the browser's permanentKey: carryOver gives the
   *   one the swap after it brings
   */
  #rehome(page, live, key = live.linkedBrowser?.permanentKey) {
    const space = this.spaces?.peek(page.spaceId);
    // frontKey() of the page's tab until now.
    const wasFront = !!space && this.#front.get(space) === (page.syncId ?? page.key);
    if (this.#byKey.get(page.key) === page) {
      this.#byKey.delete(page.key);
    }
    page.key = key ?? page.key;
    this.#byKey.set(page.key, page);
    page.tab = live;
    const sync = syncId(live);
    if (sync !== page.syncId) {
      // Not a copy of the tab the page was: the tab that took its document
      // in another window (carryOver). The page is that tab now, by its
      // sync id or by none, and its value says which.
      if (page.syncId && this.#bySync.get(page.syncId) === page) {
        this.#bySync.delete(page.syncId);
      }
      page.syncId = sync;
      if (sync) {
        this.#bySync.set(sync, page);
      }
      this.#refreshSync(live);
      this.#syncSoon(live);
    }
    // The task's front tab stays this page, by its new tab's key.
    if (wasFront) {
      this.#front.set(space, page.syncId ?? page.key);
    }
  }

  /**
   * After Zen moved a docShell between two copies (EndSwapDocShells): the
   * page whose copy it was follows it now, and pageMoved goes out.
   *
   * @param {Element} browser  either <browser> of the swap
   */
  followMove(browser) {
    const page = this.forBrowser(browser);
    if (page) {
      this.tabFor(page);
    }
  }

  /** Forget a page (closed, released, or its space finished). */
  remove(page) {
    if (this.#table(page.spaceId).get(page.label) === page) {
      this.#table(page.spaceId).delete(page.label);
    }
    if (this.#byKey.get(page.key) === page) {
      this.#byKey.delete(page.key);
    }
    if (page.syncId && this.#bySync.get(page.syncId) === page) {
      this.#bySync.delete(page.syncId);
    }
    this.onChange?.();
  }

  /** Forget every page of a space. Their tabs lose the tag; finish() decides what they stay. */
  dropSpace(spaceId) {
    for (const page of this.#table(spaceId).values()) {
      const tab = this.tabFor(page);
      this.#byKey.delete(page.key);
      if (page.syncId && this.#bySync.get(page.syncId) === page) {
        this.#bySync.delete(page.syncId);
      }
      if (tab) {
        writeTag(tab, null);
      }
    }
    this.#bySpace.delete(spaceId);
    this.onChange?.();
  }

  // ---------------------------------------------------------------------------
  // Ego's page model on top of the registry

  /**
   * Every tab of the space, managed or not (Ego's task.tabs()).
   *
   * @param {object} space  SpaceRecord
   * @returns {{tab: Element, id: string, page: PageRecord|null, openedBy: string}[]}
   */
  inventory(space) {
    const out = [];
    for (const tab of this.tabsOf(space)) {
      const page = this.forTab(tab);
      const id = this.tabId(tab);
      if (page && page.spaceId === space.id) {
        out.push({ tab, id, page, openedBy: page.openedBy });
      } else {
        out.push({ tab, id, page: null, openedBy: space.ledger.unmanaged[id] ?? "unknown" });
      }
    }
    return out;
  }

  /**
   * Throw Ego's budget error when the space has `budget` managed pages.
   *
   * @param {object} space  SpaceRecord
   * @param {number} budget
   */
  checkBudget(space, budget) {
    const pages = this.list(space.id);
    if (pages.length < budget) {
      return;
    }
    const lines = pages.map(page => {
      const tab = this.tabFor(page);
      // A sign-in result's title is the user's (content/signin.sys.mjs), and
      // a URL that carries a sign-in's code is cut before it's shortened:
      // the socket's own cut needs the whole URL.
      const label = tab?.linkedBrowser && lazy.showsSignInResult(tab.linkedBrowser) ? "" : tab?.label;
      const title = compactTitle(lazy.redactText(label || tab?.linkedBrowser?.currentURI?.spec || "untitled"));
      return `  ${page.label.padEnd(6)} ${JSON.stringify(title)}`;
    });
    const suggestion = pages[0]?.label ?? "p1";
    throw new ZenError(
      "ZEN_PAGE_BUDGET_REACHED",
      [
        `Page budget reached (${pages.length}/${budget}) in space ${JSON.stringify(space.name)}.`,
        "",
        ...lines,
        "",
        `Close: await task.page('${suggestion}').close()`,
        `Reuse: await task.page('${suggestion}').goto(url)`,
      ].join("\n"),
      { space: space.id, budget, pages: pages.map(page => page.label) }
    );
  }

  /**
   * Stop managing a page without closing its tab (Ego's task.release()).
   * Only pages the agent didn't open can be released, except as part of
   * their browsing context group, which pages.release hands over whole
   * (closed groups).
   *
   * @param {object} space  SpaceRecord
   * @param {PageRecord} page
   * @param {{group?: boolean}} [opts]
   */
  release(space, page, { group = false } = {}) {
    if (page.openedBy === "agent" && !group) {
      throw new ZenError(
        "ZEN_INVALID_ARGUMENT",
        `page ${page.label} was created by the agent; close it instead of releasing it`,
        { space: space.id, page: page.label }
      );
    }
    const tab = this.tabFor(page);
    const id = this.tabId(tab);
    space.ledger.releasedLabels.push(page.label);
    this.remove(page);
    this.addUnmanaged(space, tab, page.openedBy);
    releaseKeepAlive(tab);
    return { tab: id, openedBy: page.openedBy };
  }

  // ---------------------------------------------------------------------------
  // Closing (SPEC §3.5: never close a tab a window shows)

  /**
   * Shown tabs whose close waits for the user to leave them, by deferKey()
   * (every copy of a tab is one entry).
   *
   * @type {Map<string|Element, {tab: Element, spaceId: number|null}>}
   */
  #deferred = new Map();
  /** The space registry (modules/spaces.sys.mjs), from the service. */
  spaces = null;
  /** (tab, {space, page, tabId}) once a close waits: the service emits pageClosed and tabClosing. */
  onDeferred = null;

  /**
   * Close a tab for the agent, without beforeunload prompts: an agent page's
   * prompt would wait in a background tab nobody sees. A tab a window shows
   * waits instead: it leaves its task now and closes once the user leaves
   * it (closeLeft) or clicks the pill's Close (closeDeferred).
   *
   * @param {Element} tab
   * @returns {boolean} whether the close waits
   */
  closeTab(tab) {
    if (!tab || tab.closing || !tab.isConnected) {
      return false;
    }
    if (this.#deferred.has(deferKey(tab))) {
      return true;
    }
    // Any window's copy counts as shown (window sync).
    if (isShown(tab)) {
      this.#defer(tab);
      return true;
    }
    this.#removeNow(tab);
    return false;
  }

  #removeNow(tab) {
    this.#deferred.delete(deferKey(tab));
    // One copy: Zen closes the others.
    const copy = liveCopy(tab) ?? tab;
    this.keepView(() =>
      copy.ownerDocument.defaultView.gBrowser.removeTab(copy, {
        animate: false,
        skipPermitUnload: true,
        closeWindowWithLastTab: false,
      })
    );
  }

  /**
   * The restart's first step with tabs: close the copies a moved tab left
   * in the other windows that a quit kept before Zen had closed them. Only
   * a tab whose sync id is, whole, the `movedFrom` of a tab's task value
   * (movedValue) closes, whatever value it carries, and never the moved tab
   * itself. The value that names it needn't be its tab's own (ownValue):
   * whichever tab carries it, a Duplicate Tab of the moved one included,
   * only the copies the old tab left can have that id. Every window's copy
   * closes here, at once and unanimated: Zen would close the others later,
   * from its own event queue and with an animation, and a window's session
   * state lists every tab still in its strip, closing ones too. A quit
   * meanwhile would bring them back again.
   *
   * @param {Element[]} tabs  one copy of each tab (uniqueTabs)
   * @returns {Set<Element>} those of `tabs` it closed
   */
  closeLeftBehind(tabs) {
    /** @type {Map<string, Element>} a moved tab's old sync id -> the moved tab */
    const moved = new Map();
    for (const tab of tabs) {
      const value = readTabValue(tab);
      if (typeof value?.movedFrom === "string" && value.movedFrom) {
        moved.set(value.movedFrom, tab);
      }
    }
    const closed = new Set();
    for (const tab of tabs) {
      const sync = syncId(tab);
      const mover = sync === null ? undefined : moved.get(sync);
      if (!mover || sameTab(mover, tab)) {
        continue;
      }
      for (const copy of copiesOf(tab)) {
        this.keepView(() =>
          copy.ownerDocument.defaultView.gBrowser.removeTab(copy, {
            animate: false,
            skipPermitUnload: true,
            closeWindowWithLastTab: false,
          })
        );
      }
      closed.add(tab);
    }
    return closed;
  }

  /**
   * The tab leaves its task now: its label ends, the tag and keep-alive go,
   * and its session value says closing, so a restart closes it unless a
   * window shows it.
   */
  #defer(tab) {
    const id = this.tabId(tab);
    const page = this.forTab(tab);
    const space = page ? this.spaces?.peek(page.spaceId) : this.#holderOf(id);
    const openedBy = page?.openedBy ?? space?.ledger.unmanaged[id] ?? "agent";
    if (page) {
      this.remove(page);
    }
    if (space) {
      delete space.ledger.unmanaged[id];
      space.ledger.retained = space.ledger.retained.filter(t => t !== id);
    }
    releaseKeepAlive(liveCopy(tab) ?? tab);
    writeTag(tab, null);
    if (space?.kind === "task") {
      writeTabValue(tab, { v: 1, task: space.id, openedBy, closing: true, sync: syncId(tab) });
      this.#syncSoon(tab);
    }
    this.#deferred.set(deferKey(tab), { tab, spaceId: space?.id ?? null });
    this.onDeferred?.(tab, { space, page, tabId: id });
  }

  /** The record whose ledger keeps this unmanaged tab, if any. */
  #holderOf(tabId) {
    for (const rec of this.spaces?.records() ?? []) {
      if (!rec.gone && tabId in rec.ledger.unmanaged) {
        return rec;
      }
    }
    return null;
  }

  /** Is a close waiting for the user to leave this tab (any copy of it)? */
  isDeferred(tab) {
    return this.#deferred.has(deferKey(tab));
  }

  get hasDeferred() {
    return this.#deferred.size > 0;
  }

  /** Close the waiting tabs no window shows any more: the user left them. */
  closeLeft() {
    for (const [key, info] of [...this.#deferred]) {
      const tab = liveCopy(info.tab);
      if (!tab) {
        this.#deferred.delete(key);
      } else if (!isShown(tab)) {
        this.#removeNow(tab);
      }
    }
  }

  /** The pill's Close: now, though the user sees it. */
  closeDeferred(tab) {
    if (!this.#deferred.has(deferKey(tab))) {
      return false;
    }
    this.#removeNow(tab);
    return true;
  }

  /**
   * The pill's Keep: the tab stays, as the user's. While its task exists it
   * stays the task's as a tab of user origin, as a kept page would.
   */
  keepDeferred(tab) {
    const info = this.#deferred.get(deferKey(tab));
    if (!info) {
      return false;
    }
    this.#deferred.delete(deferKey(tab));
    const space = info.spaceId === null ? null : this.spaces?.peek(info.spaceId);
    if (space && !space.gone) {
      this.addUnmanaged(space, tab, "user");
    } else {
      writeTabValue(tab, null);
    }
    return true;
  }

  /** A waiting tab closed some other way. */
  forgetDeferred(tab) {
    this.#deferred.delete(deferKey(tab));
  }

  /**
   * The user's page at a control boundary (claim, takeover): the tab the user
   * sees in the space, managed or not. Tabs that aren't pages are recorded as
   * unmanaged, as in Ego's ledger.
   *
   * @param {object} space  SpaceRecord
   * @returns {{label?: string, tab: string, openedBy: string}|null}
   */
  userPage(space) {
    const tab = this.userTab(space);
    if (!tab) {
      return null;
    }
    const id = this.tabId(tab);
    const page = this.forTab(tab);
    if (page && page.spaceId === space.id) {
      return { label: page.label, tab: id, openedBy: page.openedBy };
    }
    return { tab: id, openedBy: space.ledger.unmanaged[id] ?? "unknown" };
  }

  /**
   * The tab the user sees in the space. For a task in the shared Agents
   * Space: its tab a window shows, else the Space's remembered tab if that's
   * the task's (SPI "Tasks in the Agents Space").
   *
   * @param {object} space  SpaceRecord
   * @returns {Element|null}
   */
  userTab(space) {
    if (space.kind !== "task") {
      const tab = currentTabOfWorkspace(space.uuid);
      return tab && !this.isUserOwn(tab) ? tab : null;
    }
    // A task's tab a window shows, its front tab first; else its front tab.
    // A window shows a copy of one of `mine` (window sync): answer with ours.
    // A window without Spaces shows only the tabs it holds: one a task's
    // tab was torn off into (Move to New Window) shows that tab.
    const mine = this.tabsOf(space);
    const front = this.frontTab(space, mine);
    const synced = workspaceWindows();
    const holding = new Set(mine.map(tab => tab.ownerDocument?.defaultView));
    let shown = null;
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      if (win.closed || !(holding.has(win) || synced.includes(win))) {
        continue;
      }
      for (const tab of shownTabs(win)) {
        if (sameTab(tab, front)) {
          return front;
        }
        shown ??= mine.find(t => sameTab(t, tab)) ?? null;
      }
    }
    return shown ?? front;
  }

  /** @type {WeakMap<object, string|object>} task record → its front tab's frontKey() */
  #front = new WeakMap();

  /**
   * Ego's current Page, for a task in the shared Agents Space: the tab the
   * user would see on opening the task, where the panel's Open lands. It's
   * whichever came last of a tab the agent made current (zen-ux's
   * notePage: a new page, an acting call) and a task tab the user
   * selected; else the task's first page, else its first tab. If that tab
   * closes, the same fallback applies. It moves no window (I1).
   *
   * @param {object} space  SpaceRecord, a task
   * @param {Element[]} [mine]  its tabs, if the caller has them
   * @returns {Element|null}
   */
  frontTab(space, mine = this.tabsOf(space)) {
    const key = this.#front.get(space);
    const front = key && mine.find(tab => frontKey(tab) === key);
    if (front) {
      return front;
    }
    for (const page of this.list(space.id)) {
      const tab = this.tabFor(page);
      if (tab && mine.includes(tab)) {
        return tab;
      }
    }
    return mine[0] ?? null;
  }

  /** The agent made this tab current, or the user selected it: its task's front tab now. */
  noteFront(tab) {
    const key = frontKey(tab);
    if (!key || tab.closing || this.isUserOwn(tab)) {
      return;
    }
    const page = this.forTab(tab);
    const space = page ? this.spaces?.peek(page.spaceId) : this.#holderOf(this.tabId(tab));
    if (space?.kind === "task" && !space.gone) {
      this.#front.set(space, key);
    }
  }

  /**
   * Record every tab in the space that isn't a page as unmanaged, keeping
   * known origins (Ego: the first tab set after a claim is the boundary).
   *
   * @param {object} space  SpaceRecord
   */
  markBoundary(space) {
    for (const { id, page } of this.inventory(space)) {
      if (!page) {
        space.ledger.unmanaged[id] ??= "unknown";
      }
    }
  }
}

/** A tab's key in the waiting closes: its sync id, else the element. */
function deferKey(tab) {
  return syncId(tab) ?? tab;
}

/** What names a tab across its copies: its sync id, else its permanentKey. */
function frontKey(tab) {
  return syncId(tab) ?? tab?.linkedBrowser?.permanentKey ?? null;
}

function compactTitle(value) {
  const compact = String(value).replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}
