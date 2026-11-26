// The per-tab task tag (SPEC §3.8): which task an agent tab belongs to, and
// that task's state, on the tab itself.
//
// The core marks each task page with `zenius-task=<task id>` (pages only:
// kept, released and user-opened tabs don't carry it). The UI adds the rest
// from the same state as the Space badge and the tasks panel (ZeniusUI's
// badgeFor), so the three never disagree:
// - `zenius-task-state` on the tab: working | idle | paused | needs-user | user
// - `zenius-task-name` on the tab's .tab-content, which zenius-ux.css shows
//   with attr(): a pseudo-element reads its own element's attributes.
// A MutationObserver applies them to tabs the core tags later, in every
// window, so the core needs no event for it.

import { isolate } from "chrome://userscripts/content/zenius/ui/text.sys.mjs";

export const TAG_STATE_TEXT = {
  working: "Agent working",
  idle: "Agent idle",
  paused: "Agent paused: waiting for you",
  "needs-user": "Agent needs you",
  user: "You're in control",
};

/** @type {Map<string, {state: string, name: string}>} keyed by task id */
const tags = new Map();
const WATCHED = Symbol("zenius.taskTags");

function* browserWindows() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (!win.closed && win.gBrowser) {
      yield win;
    }
  }
}

/**
 * The window's tabs carrying a task. From the DOM: Zen's gBrowser.tabs
 * lists only the active Space's tabs.
 *
 * @param {Window} win
 */
function taggedTabs(win) {
  return win.document.querySelectorAll(".tabbrowser-tab[zenius-task], .tabbrowser-tab[zenius-task-state]");
}

/** @param {Element} tab */
function apply(tab) {
  const id = tab.getAttribute("zenius-task");
  const tag = id === null ? undefined : tags.get(id);
  const content = tab.querySelector(".tab-content");
  if (tag) {
    if (tab.getAttribute("zenius-task-state") !== tag.state) {
      tab.setAttribute("zenius-task-state", tag.state);
    }
    if (content && content.getAttribute("zenius-task-name") !== tag.name) {
      content.setAttribute("zenius-task-name", tag.name);
    }
  } else {
    tab.removeAttribute("zenius-task-state");
    content?.removeAttribute("zenius-task-name");
  }
}

/**
 * Set or clear what a task's tags show, in every window.
 *
 * @param {number|string} taskId
 * @param {{state: string, name: string}|null} tag
 */
export function setTaskTag(taskId, tag) {
  const id = String(taskId);
  const prev = tags.get(id);
  if (tag ? prev?.state === tag.state && prev?.name === tag.name : !prev) {
    return;
  }
  if (tag) {
    tags.set(id, { state: tag.state, name: String(tag.name ?? "") });
  } else {
    tags.delete(id);
  }
  for (const win of browserWindows()) {
    for (const tab of taggedTabs(win)) {
      if (tab.getAttribute("zenius-task") === id) {
        apply(tab);
      }
    }
  }
}

/**
 * What a tab's tag shows, or null.
 *
 * @param {Element} tab
 * @returns {{id: string, state: string, name: string}|null}
 */
export function taskTagOf(tab) {
  const id = tab?.getAttribute?.("zenius-task");
  const tag = id === null || id === undefined ? undefined : tags.get(id);
  return tag ? { id, ...tag } : null;
}

/**
 * Follow the core's zenius-task attributes in a window, and add the tag's
 * line to tab tooltips.
 *
 * @param {Window} win
 */
export function watchTaskTags(win) {
  if (win[WATCHED]) {
    return;
  }
  win[WATCHED] = true;
  const observer = new win.MutationObserver(records => {
    for (const r of records) {
      if (r.target.classList?.contains("tabbrowser-tab")) {
        apply(r.target);
      }
    }
  });
  observer.observe(win.document.documentElement, {
    attributes: true,
    attributeFilter: ["zenius-task"],
    subtree: true,
  });
  win.addEventListener("unload", () => observer.disconnect(), { once: true });
  for (const tab of taggedTabs(win)) {
    apply(tab);
  }
  const gb = win.gBrowser;
  if (typeof gb.getTabTooltip === "function") {
    const original = gb.getTabTooltip;
    gb.getTabTooltip = function (tab, ...rest) {
      const text = original.call(this, tab, ...rest);
      const tag = taskTagOf(tab);
      return tag ? `${text}\nTask: ${isolate(tag.name)} · ${TAG_STATE_TEXT[tag.state] ?? tag.state}` : text;
    };
  }
}
