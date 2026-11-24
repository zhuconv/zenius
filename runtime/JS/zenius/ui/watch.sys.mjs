// Watching an agent's task: the window shows the task's tabs, remembers
// where the user was, and ⌃Tab goes back there.
// Every way the user goes to an agent's task is a watch (ZeniusUI.watch):
// the tasks panel's Open, a notification, the agent sidebar's live card and
// directory.
//
// While a window watches, its strip says so, with the key as a keycap:
// "Watching <task> [⌃Tab]". Where the strip can't be read (compact mode, a
// collapsed sidebar), a chip in the page area's top left corner says the
// same. Both are hints, not controls: the user rejected a Back button left
// in the session, and one over the page sits where a site's links do, so
// every click goes through the chip to the page.
//
// ⌃Tab means "back" only while the window watches; everywhere else it is
// Zen's. Picking a tab outside the task, or another Space, ends the watch
// where the user went. A watch's listeners are in only while it lasts.
//
// The task's end doesn't end it: the user reaches for ⌃Tab right then. The
// window stays where it is, on the task's page, which waits until the user
// leaves it (SPEC §3.5); the hints say "Task done, [⌃Tab] back to your
// tabs"; ⌃Tab goes back until the user goes elsewhere themselves. Nothing
// moves by itself.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { setStripWatching, stripSeen } from "chrome://userscripts/content/zenius/ui/panel.sys.mjs";
import { isolate } from "chrome://userscripts/content/zenius/ui/text.sys.mjs";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const CHIP_ID = "zenius-watch-pill";
/** The key that goes back, as the hints show it. */
export const BACK_KEY = AppConstants.platform === "macosx" ? "⌃Tab" : "Ctrl+Tab";
/** The same key, as a screen reader should say it. */
export const BACK_KEY_WORDS = "Control Tab";
/**
 * The ⌃Tab press that ended a watch goes no further: its repeats, and a copy
 * the page sends back, would move a tab. Presses this soon after are its.
 */
const SWALLOW_MS = 500;
/** The key's listeners wait this long at most for that press to end. */
const KEYS_KEPT_MS = 5000;
/** Zen slides its compact sidebar in and out over 0.15 to 0.25 s. */
const SETTLE_MS = 300;
/**
 * In the system group, at the window, so it comes before Zen's own ⌃Tab (the
 * tab box's and ctrlTab's listeners, on the document in that group), which
 * it stops.
 */
const KEY_OPTIONS = { capture: true, mozSystemGroup: true };

/**
 * @typedef {object} WatchHooks
 * @property {(id: number, tab: Element) => boolean} isTaskTab  one of the
 *   task's tabs, or a window's copy of one
 * @property {(id: number) => string} nameOf  the task's name now
 * @property {(win: Window, change: WatchChange) => void} changed  the
 *   window began, moved or ended a watch, or its task ended
 *
 * @typedef {object} WatchChange
 * @property {number|null} space  the task the window watches now, else null
 * @property {boolean} done  the task the window watched ended, and ⌃Tab
 *   still goes back
 * @property {string} name  that task's name
 *
 * @typedef {object} Place  where the user was
 * @property {string|null} workspace  their Space
 * @property {Element|null} tab  their tab there; null: the one Zen
 *   remembers for that Space
 */

export class Watches {
  /** @type {WeakMap<Window, object>} */
  #windows = new WeakMap();

  /** @param {WatchHooks} hooks */
  constructor(hooks) {
    this.hooks = hooks;
  }

  /**
   * The task `win` watches: its Space id, else null.
   *
   * @param {Window} win
   * @returns {number|null}
   */
  of(win) {
    return this.#windows.get(win)?.id ?? null;
  }

  /**
   * The task `win` watched until it ended, while ⌃Tab still goes back: its
   * Space id, else null.
   *
   * @param {Window} win
   * @returns {number|null}
   */
  doneOf(win) {
    return this.#windows.get(win)?.done?.id ?? null;
  }

  /**
   * Watch task `id` in `win`. `show` switches the window to the task, and
   * the selections that makes end nothing. A window that already watches,
   * or still has the way back from a task that ended, keeps its way back to
   * where the user first was; otherwise it's `from`.
   *
   * @param {Window} win
   * @param {number} id
   * @param {Place} from  where the user is now
   * @param {() => Promise<void>} show
   * @returns {Promise<boolean>} whether the window shows the task
   */
  async begin(win, id, from, show) {
    const w = this.#state(win);
    const back = active(w) ? w.back : from;
    const before = win.gBrowser.selectedTab;
    w.switching++;
    try {
      await show();
    } finally {
      w.switching--;
    }
    if (win.closed) {
      return false;
    }
    const tab = win.gBrowser.selectedTab;
    if (!this.hooks.isTaskTab(id, tab)) {
      // The task's tabs went meanwhile. A watch that this switch took the
      // window away from ends here: another task's, or an ended task's, on
      // its page.
      const stays = w.id !== null ? this.hooks.isTaskTab(w.id, tab) : tab === before;
      if (active(w) && !stays) {
        this.#end(win, w);
      }
      return false;
    }
    const moved = w.id !== id;
    w.id = id;
    w.done = null;
    w.back = back;
    this.#listen(win, w);
    this.#texts(win, w);
    this.#updateChip(win, w);
    if (moved) {
      this.hooks.changed(win, { space: id, done: false, name: this.hooks.nameOf(id) ?? "" });
    }
    return true;
  }

  /**
   * End `win`'s watch. With `back` (⌃Tab), the window goes back to where the
   * user was: their Space, and their tab if it's still open.
   *
   * @param {Window} win
   * @param {{back?: boolean}} [options]
   * @returns {Promise<boolean>} whether a watch ended
   */
  async end(win, { back = true } = {}) {
    const w = this.#windows.get(win);
    if (!w || !active(w)) {
      return false;
    }
    const place = w.back;
    this.#end(win, w);
    if (back && place && !win.closed) {
      w.switching++;
      try {
        await goTo(win, place);
      } catch (e) {
        console.error("[zenius] going back to the user's tabs failed", e);
      } finally {
        w.switching--;
      }
    }
    return true;
  }

  /**
   * Task `id` ended. A window that watched it stays where it is: on the
   * task's page, whose close waits until the user leaves it (SPEC §3.5), or
   * on a page the task kept. Its hints say the task is done, and ⌃Tab still
   * goes back, until the user goes elsewhere themselves.
   *
   * @param {number} id
   */
  forget(id) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const w = this.#windows.get(win);
      if (w?.id === id && !win.closed) {
        const name = this.hooks.nameOf(id) ?? "";
        w.id = null;
        w.done = { id, name };
        this.#texts(win, w);
        this.#updateChip(win, w);
        this.hooks.changed(win, { space: null, done: true, name });
      }
    }
  }

  /** The hints follow a task's new name. */
  refresh() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const w = this.#windows.get(win);
      if (w && w.id !== null && !win.closed) {
        this.#texts(win, w);
      }
    }
  }

  #state(win) {
    let w = this.#windows.get(win);
    if (!w) {
      w = {
        id: null,
        /** @type {{id: number, name: string}|null} the task that ended while watched */
        done: null,
        back: null,
        switching: 0,
        listening: false,
        keys: false,
        swallowUntil: 0,
        keysTimer: 0,
        settleTimer: 0,
        chip: null,
        layout: null,
        sizes: null,
        onKey: null,
        onTabSelect: null,
        recheck: null,
      };
      this.#windows.set(win, w);
    }
    return w;
  }

  #end(win, w) {
    w.id = null;
    w.done = null;
    w.back = null;
    this.#unlisten(win, w);
    if (w.chip) {
      w.chip.hidden = true;
    }
    setStripWatching(win, null);
    this.hooks.changed(win, { space: null, done: false, name: "" });
  }

  #listen(win, w) {
    if (!w.keys) {
      w.onKey ??= event => this.#onKey(win, w, event);
      for (const type of ["keydown", "keyup"]) {
        win.addEventListener(type, w.onKey, KEY_OPTIONS);
      }
      w.keys = true;
    }
    clearTimeout(w.keysTimer);
    if (w.listening) {
      return;
    }
    w.listening = true;
    w.onTabSelect ??= event => {
      if (w.switching) {
        return;
      }
      if (w.id !== null) {
        if (!this.hooks.isTaskTab(w.id, win.gBrowser.selectedTab)) {
          this.#end(win, w);
        }
        return;
      }
      // An ended task's way back lasts until the user goes elsewhere
      // themselves. The tab Zen picks when the one shown closes (its pill's
      // Close, ⌘W) isn't a place they picked. Firefox picks it before it
      // marks that tab closing, in the same call, so look once that's over:
      // a page the user left closes later (zen-core's closeLeft, a tick on).
      const done = w.done;
      const previous = event.detail?.previousTab;
      if (done) {
        Promise.resolve().then(() => {
          if (w.done === done && !w.switching && !(previous && (previous.closing || !previous.isConnected))) {
            this.#end(win, w);
          }
        });
      }
    };
    win.addEventListener("TabSelect", w.onTabSelect);
    // Whether the strip can be read changes with Zen's layout: compact mode
    // and its hover, the sidebar's width, the window's size. Checked once
    // Zen's slide is over.
    w.recheck ??= () => {
      clearTimeout(w.settleTimer);
      w.settleTimer = setTimeout(() => this.#updateChip(win, w), SETTLE_MS);
    };
    w.layout = new win.MutationObserver(w.recheck);
    w.layout.observe(win.document.documentElement, { attributes: true });
    const toolbox = win.document.getElementById("navigator-toolbox");
    if (toolbox) {
      w.layout.observe(toolbox, { attributes: true });
    }
    win.addEventListener("resize", w.recheck);
    win.addEventListener("ZenCompactMode:LayoutUpdate", w.recheck);
  }

  #unlisten(win, w) {
    if (w.listening) {
      w.listening = false;
      win.removeEventListener("TabSelect", w.onTabSelect);
      win.removeEventListener("resize", w.recheck);
      win.removeEventListener("ZenCompactMode:LayoutUpdate", w.recheck);
      w.layout?.disconnect();
      w.layout = null;
      w.sizes?.disconnect();
      w.sizes = null;
      clearTimeout(w.settleTimer);
    }
    if (!w.swallowUntil) {
      this.#dropKeys(win, w);
      return;
    }
    // The press that ended the watch is still down: the key's listeners stay
    // until it comes up.
    clearTimeout(w.keysTimer);
    w.keysTimer = setTimeout(() => {
      w.swallowUntil = 0;
      if (!active(w)) {
        this.#dropKeys(win, w);
      }
    }, KEYS_KEPT_MS);
  }

  #dropKeys(win, w) {
    clearTimeout(w.keysTimer);
    if (w.keys) {
      w.keys = false;
      for (const type of ["keydown", "keyup"]) {
        win.removeEventListener(type, w.onKey, KEY_OPTIONS);
      }
    }
  }

  #onKey(win, w, event) {
    // Only the user's own keys move the window.
    if (!event.isTrusted || event.key !== "Tab") {
      return;
    }
    if (event.type === "keyup") {
      w.swallowUntil = 0;
      if (!active(w)) {
        this.#dropKeys(win, w);
      }
      return;
    }
    if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
      return;
    }
    if (!active(w)) {
      if (w.swallowUntil && (event.repeat || Date.now() < w.swallowUntil)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    w.swallowUntil = Date.now() + SWALLOW_MS;
    this.end(win);
  }

  /** What the hints say: the task watched, or that it's done. */
  #hint(w) {
    if (w.id === null) {
      return { name: w.done?.name ?? "", done: true };
    }
    return { name: this.hooks.nameOf(w.id) ?? "", done: false };
  }

  #texts(win, w) {
    const { name, done } = this.#hint(w);
    setStripWatching(win, { name, done, key: BACK_KEY, words: BACK_KEY_WORDS });
    if (w.chip) {
      setChipText(w.chip, name, done);
    }
  }

  /** The chip shows only while the strip's words can't be read. */
  #updateChip(win, w) {
    if (!active(w) || win.closed || stripSeen(win)) {
      if (w.chip) {
        w.chip.hidden = true;
      }
      return;
    }
    if (!w.chip?.isConnected) {
      w.chip = makeChip(win);
      if (!w.chip) {
        return;
      }
    }
    const { name, done } = this.#hint(w);
    setChipText(w.chip, name, done);
    w.chip.hidden = false;
    if (!w.sizes) {
      const area = win.document.getElementById("tabbrowser-tabpanels");
      if (area) {
        w.sizes = new win.ResizeObserver(() => w.chip && !w.chip.hidden && placeChip(win, w.chip));
        w.sizes.observe(area);
      }
    }
    placeChip(win, w.chip);
  }
}

/** A watch, or the way back from a task that ended while watched. */
function active(w) {
  return w.id !== null || w.done !== null;
}

/**
 * "Watching <task> [⌃Tab]", or "Task done, [⌃Tab] back to your tabs", over
 * the page area; hidden until placed.
 */
function makeChip(win) {
  const doc = win.document;
  const host = doc.getElementById("tabbrowser-tabbox") ?? doc.getElementById("browser");
  if (!host) {
    return null;
  }
  const make = (tag, className = "", text = "") => {
    const el = doc.createElementNS(XHTML_NS, tag);
    if (className) {
      el.className = className;
    }
    if (text) {
      el.textContent = text;
    }
    return el;
  };
  const chip = make("div");
  chip.id = CHIP_ID;
  chip.hidden = true;
  const key = make("span", "zenius-watch-key");
  key.append(make("kbd", "", BACK_KEY));
  // Once the task is done there's room for where ⌃Tab goes. That's cut
  // first, never the key.
  const rest = make("span", "zenius-watch-rest");
  rest.hidden = true;
  chip.append(make("span", "zenius-watch-eye"), make("span", "zenius-watch-name"), key, rest);
  host.append(chip);
  return chip;
}

/** "Watching <b>task</b>", or "Task done," and where ⌃Tab goes. */
function setChipText(chip, name, done) {
  const label = chip.querySelector(".zenius-watch-name");
  const rest = chip.querySelector(".zenius-watch-rest");
  if (!label || !rest) {
    return;
  }
  chip.toggleAttribute("done", done);
  rest.hidden = !done;
  // Empty while hidden: the chip's text is what it shows.
  const where = done ? "back to your tabs" : "";
  if (rest.textContent !== where) {
    rest.textContent = where;
  }
  if (done) {
    if (label.textContent !== "Task done," || label.firstElementChild) {
      label.textContent = "Task done,";
    }
    return;
  }
  let b = label.querySelector("b");
  if (!b) {
    b = chip.ownerDocument.createElementNS(XHTML_NS, "b");
    label.replaceChildren("Watching ", b);
  }
  const text = isolate(name) || "a task";
  if (b.textContent !== text) {
    b.textContent = text;
  }
}

/**
 * In the page area's top left corner, small: never over the page's top
 * middle, where its search and sign-in fields sit, and at most 280 px or
 * 40 % of the page area wide (a long name is cut).
 */
function placeChip(win, chip) {
  const host = chip.parentNode;
  const area = win.document.getElementById("tabbrowser-tabpanels") ?? win.gBrowser.selectedBrowser;
  if (!host || !area) {
    return;
  }
  const h = host.getBoundingClientRect();
  const a = area.getBoundingClientRect();
  chip.style.left = `${a.left - h.left + 8}px`;
  chip.style.top = `${a.top - h.top + 8}px`;
  chip.style.maxWidth = `${Math.round(Math.max(120, Math.min(280, a.width * 0.4)))}px`;
}

/** @param {Window} win @param {Place} place */
async function goTo(win, { workspace, tab }) {
  const spaces = win.gZenWorkspaces;
  if (workspace && spaces && spaces.activeWorkspace !== workspace) {
    await spaces.changeWorkspaceWithID(workspace);
  }
  if (tab?.isConnected && !tab.closing && win.gBrowser.selectedTab !== tab) {
    win.gBrowser.selectedTab = tab;
  }
  win.gBrowser.selectedBrowser?.focus();
}
