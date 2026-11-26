// The agent tasks panel, and the slim status strip in the sidebar that opens
// it.
//
// The strip sits in #TabsToolbar right above Zen's foot buttons, as a static
// child like Firefox's private-browsing indicator, so CustomizableUI neither
// moves it nor records it in browser.uiCustomization.state. It shows only
// while agent Spaces exist. The panel is a plain arrow <panel> that only the
// user opens; it never pops up by itself (I1).

import { log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";
import { isolate, isOneIsolate } from "chrome://userscripts/content/zenius/ui/text.sys.mjs";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const STRIP_ID = "zenius-agents-strip";
/** The strip's row: the strip, and its All agent tasks button at the end. */
const STRIP_ROW_ID = "zenius-strip-row";
const STRIP_ALL_ID = "zenius-strip-all";
const PANEL_ID = "zenius-tasks-panel";
/** Tab names a row shows; the rest are counted. */
const MAX_TABS = 4;
/** The longest a press in the panel holds its updates back. */
const PRESS_HOLD_MS = 2000;
/** How far above its anchor the panel opens. */
const PANEL_Y = -4;
/** The room the panel keeps from the window's edges. */
const PANEL_GAP = 4;
/** After the panel shows, it's measured once more this much later, in case the system places it late. */
const LATE_FIT_MS = 150;

/**
 * The auto-close's wait in words: "3 days" for zenius.autoCloseHours' 72.
 *
 * @param {number} hours
 */
export function idleText(hours) {
  if (hours > 0 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "1 day" : `${days} days`;
  }
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/**
 * @typedef {object} TaskRow
 * @property {number} id  task-space id
 * @property {string} name
 * @property {string} state  badge state (working, idle, paused, needs-user, user)
 * @property {string} detail  "Agent working · <text> · <action>", or for
 *   a task that waits for the user, 'Agent needs you. The agent says:
 *   "<text>".'
 * @property {"agent"|"agentDelegatedToUser"} ownership
 * @property {boolean} paused
 * @property {{id: string, title: string}[]} [tabs]  the task's tabs (SPEC §3.8)
 * @property {string|null} [idleFor]  "3 days" when the auto-close would take
 *   it (SPEC §3.4), else null
 * @property {boolean} [needs]  it waits for the user (needsUser)
 * @property {string|null} [waitsFor]  what it waits for, while it does
 *   (waitText)
 *
 * @typedef {{uid: string, name: string, why?: string|null}} SidebarWaiting
 *   an agent sidebar's task that needs the user with no zenius task saying
 *   so, and why (waitText)
 *  (ZeniusUI.noteSidebarWaiting)
 *
 * @typedef {object} PanelActions
 * @property {() => TaskRow[]} [rows]  fresh rows when the panel opens: tab
 *   titles and idleness change without a badge event
 * @property {(id: number) => void} open
 * @property {(id: number, tabId: string) => void} [openTab]
 * @property {(id: number) => void} [closeIdle]
 * @property {(id: number) => void} pause
 * @property {(id: number) => void} resume
 * @property {(id: number) => void} takeOver
 * @property {(id: number) => void} handBack
 * @property {(id: number) => void} stop
 * @property {(uid: string, win: Window) => void} [openSidebar]  the agent
 *   sidebar on one of its waiting tasks
 */

/**
 * Does the task wait for the user's answer, as the strip counts it? A
 * hand-off, a page's prompt, or the takeover prompt's pause; not a task the
 * user paused from the panel, which only waits for them. The agent sidebar's
 * Work count reads the same number (ZeniusUI.needsCount).
 *
 * @param {TaskRow} row
 */
export function needsUser(row) {
  return row.state === "needs-user" || (row.state === "paused" && !row.paused);
}

/**
 * Each window's strip and panel. `els` holds one row element per task for as
 * long as the task is listed: updates change those rows in place, so a
 * button the user has focused or is pressing survives an agent's progress
 * report (~12 updates a second under load). `actions` is the latest set,
 * which the buttons call.
 *
 * @type {WeakMap<Window, {strip: Element, panel: Element|null, rows: TaskRow[], els: Map<number, Element>, actions: PanelActions}>}
 */
const windows = new WeakMap();

/**
 * Render the strip (and the panel, if open) of one window.
 *
 * @param {Window} win
 * @param {TaskRow[]} rows
 * @param {PanelActions} actions
 */
export function updateTasks(win, rows, actions, waiting = []) {
  const w = ensureWindow(win, actions);
  if (!w) {
    return;
  }
  w.rows = rows;
  w.waiting = waiting;
  renderStrip(win, w);
  if (w.panel?.state === "open" || w.panel?.state === "showing") {
    // Mid-press, nothing in the panel moves: a row that grew or came above
    // would take the button from under the pointer, and the press would be
    // lost. The render waits for the release (2 s at most, should a release
    // never come).
    if (w.pressedAt && Date.now() - w.pressedAt < PRESS_HOLD_MS) {
      w.actions = actions;
      w.renderAfterPress = true;
      return;
    }
    renderPanel(win, w, actions);
  }
}

/**
 * Each window's watch (ui/watch.sys.mjs), for its strip: the task's name,
 * whether it's done, and the key that goes back.
 *
 * @typedef {{name: string, done?: boolean, key: string, words: string}} WatchHint
 * @type {WeakMap<Window, WatchHint>}
 */
const watchHints = new WeakMap();

/**
 * While `win` watches a task, its strip says so, and how to go back:
 * "Watching <task> [⌃Tab]" (the key a keycap). Once the task ended there,
 * while ⌃Tab still goes back: "Task done, [⌃Tab] back to your tabs". A
 * hint, not a Back button: a click still opens the tasks panel.
 *
 * @param {Window} win
 * @param {WatchHint|null} hint  `words`: the key as a screen reader should
 *   say it
 */
export function setStripWatching(win, hint) {
  if (hint) {
    watchHints.set(win, hint);
  } else {
    watchHints.delete(win);
  }
  const w = windows.get(win);
  if (w?.strip.isConnected) {
    renderStrip(win, w);
  }
}

/**
 * Can the user read the strip now? Not while it's hidden, nor in a
 * collapsed sidebar (only its dot shows), nor in compact mode while Zen
 * keeps the sidebar out of the window (it slides it away and hides its title
 * bar, which holds the strip), nor while it's out of the window any other
 * way.
 *
 * @param {Window} win
 */
export function stripSeen(win) {
  const strip = windows.get(win)?.strip;
  const label = strip?.isConnected ? strip.querySelector(".zenius-strip-text") : null;
  if (!label || strip.hidden || !label.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
    return false;
  }
  const r = label.getBoundingClientRect();
  return r.width >= 1 && r.height >= 1 && r.right > 0 && r.bottom > 0 && r.left < win.innerWidth && r.top < win.innerHeight;
}

function renderStrip(win, w) {
  const rows = w.rows;
  // Who waits for the user: zenius's tasks, then the agent sidebar's tasks
  // that need the user with no zenius task saying so, which count too, so
  // the strip and the sidebar's Work count agree.
  const waiting = w.waiting ?? [];
  const needs = [
    ...rows.filter(needsUser).map(row => ({ id: row.id, name: row.name, kind: row.waitsFor ?? null })),
    ...waiting.map(item => ({ uid: item.uid, name: item.name, kind: item.why ?? null })),
  ];
  const attention = needs.length;
  const working = rows.filter(r => r.state === "working").length;
  const paused = rows.filter(r => r.paused).length;
  const hint = watchHints.get(win);
  const shown = rows.length + waiting.length;
  w.strip.hidden = shown === 0 && !hint;
  w.row.hidden = w.strip.hidden;
  setAttr(w.strip, "state", attention ? "needs-user" : working ? "working" : paused ? "paused" : "idle");
  // One task waits: the strip names it and says what it waits for, and its
  // click goes there (ensureWindow).
  w.one = attention === 1 ? needs[0] : null;
  const text = w.one ? waitLine(w.one) : stripText(shown, attention, working, paused);
  const label = w.strip.querySelector(".zenius-strip-text");
  if (hint) {
    clearNamed(w.strip, label);
    w.all.hidden = true;
    // Once the watched task is done there may be no tasks to count.
    renderWatching(w.strip, label, hint, shown ? text : "");
    return;
  }
  if (w.strip.hasAttribute("watching")) {
    w.strip.removeAttribute("watching");
    w.strip.removeAttribute("aria-label");
    label.textContent = "";
  }
  if (w.one) {
    renderNamed(w.strip, label, w.one);
  } else {
    clearNamed(w.strip, label);
    setText(label, text);
  }
  // A collapsed sidebar shows only the dot: the tooltip carries the text,
  // and with several waiting, a line for each.
  setAttr(w.strip, "title", attention > 1 ? [text, ...needs.map(waitLine)].join("\n") : text);
  // While the strip's click goes to the one waiting task, All agent tasks opens
  // the panel.
  w.all.hidden = !w.one;
}

/**
 * "<task> needs a sign-in": the strip's line for one waiting task, and the
 * agent sidebar's hand-off card's title. The name goes in isolate(), whose
 * own bidi controls go first, so nothing in it reorders the words after it.
 *
 * @param {{name?: string, kind?: string|null}} item
 */
export function waitLine(item) {
  return `${isolate(item.name) || "A task"} ${waitText(item.kind)}`;
}

/** Each named line → the waiting task it names, for its fit when the width changes. */
const namedItems = new WeakMap();

/**
 * The strip names the one task that waits, then what it waits for, as
 * much as fits (fitNamed). Its tooltip and accessible name say it all.
 */
function renderNamed(strip, label, item) {
  if (!strip.hasAttribute("named")) {
    strip.setAttribute("named", "true");
    const doc = strip.ownerDocument;
    // Classes of their own: the watch's line has a name and a rest too.
    const who = doc.createElementNS(XHTML_NS, "span");
    who.className = "zenius-strip-who";
    const what = doc.createElementNS(XHTML_NS, "span");
    what.className = "zenius-strip-what";
    label.replaceChildren(who, what);
  }
  const task = isolate(item.name) || "A task";
  const nameEl = label.querySelector(".zenius-strip-who");
  setText(nameEl, task);
  // Only the name is on its line, so it can take its own direction: a cut
  // right-to-left name keeps its start.
  setAttr(nameEl, "dir", isOneIsolate(task) ? "auto" : "ltr");
  setAttr(strip, "aria-label", waitLine(item));
  namedItems.set(label, item);
  fitNamed(label);
}

/**
 * Fit the named line to the strip's width. The name comes first, whole,
 * cut with an ellipsis only when it alone is too long. What the task waits
 * for follows whole or not at all: its own words, else "needs you", else
 * nothing, never cut short.
 *
 * @param {Element} label
 */
function fitNamed(label) {
  const item = namedItems.get(label);
  const who = label.querySelector(":scope > .zenius-strip-who");
  const what = label.querySelector(":scope > .zenius-strip-what");
  if (!item || !who || !what) {
    return;
  }
  const own = waitText(item.kind);
  for (const words of own === NEEDS_YOU ? [own] : [own, NEEDS_YOU]) {
    setText(what, ` ${words}`);
    what.hidden = false;
    // Laid out only where the strip's text shows (not in a collapsed
    // sidebar): it fits again when it does (watchFit).
    if (!label.isConnected || label.clientWidth < 1) {
      return;
    }
    if (who.scrollWidth <= who.clientWidth + 1 && label.scrollWidth <= label.clientWidth + 1) {
      return;
    }
  }
  what.hidden = true;
}

/**
 * Fit the window's named line again whenever its strip's row changes width:
 * the sidebar's width, or the sidebar expanding. The row's width follows
 * the sidebar, not its text, so a fit doesn't set it off again.
 *
 * @param {Window} win
 * @param {Element} row
 * @param {Element} label
 */
function watchFit(win, row, label) {
  const ro = new win.ResizeObserver(() => {
    if (label.parentElement?.hasAttribute("named")) {
      fitNamed(label);
    }
  });
  ro.observe(row);
  return ro;
}

function clearNamed(strip, label) {
  if (strip.hasAttribute("named")) {
    strip.removeAttribute("named");
    strip.removeAttribute("aria-label");
    namedItems.delete(label);
    label.textContent = "";
  }
}

/**
 * "Watching <task> [⌃Tab]", or "Task done, [⌃Tab] back to your tabs", the key
 * a keycap as the watch chip draws it: where the strip is narrow the name, or
 * where ⌃Tab goes, is cut, never the key. The tooltip and the accessible name
 * say what the key does, and keep the strip's own news.
 */
function renderWatching(strip, label, { name, done = false, key, words }, text) {
  const state = done ? "done" : "true";
  if (strip.getAttribute("watching") !== state) {
    strip.setAttribute("watching", state);
    const doc = strip.ownerDocument;
    const span = (className, content) => {
      const el = doc.createElementNS(XHTML_NS, "span");
      el.className = className;
      el.textContent = content;
      return el;
    };
    label.replaceChildren(
      ...(done
        ? [span("zenius-strip-lead", "Task done,"), span("zenius-strip-key", ""), span("zenius-strip-rest", " back to your tabs")]
        : [span("zenius-strip-lead", "Watching "), span("zenius-strip-name", ""), span("zenius-strip-key", "")])
    );
  }
  const keyEl = label.querySelector(".zenius-strip-key");
  let kbd = keyEl.querySelector("kbd");
  if (!kbd) {
    kbd = strip.ownerDocument.createElementNS(XHTML_NS, "kbd");
    keyEl.replaceChildren(" ", kbd);
  }
  setText(kbd, key);
  const news = text ? [text] : [];
  if (done) {
    const task = isolate(name);
    const what = task ? `Task done: ${task}` : "Task done";
    setAttr(strip, "title", [`${what}. ${key} goes back to your tabs.`, ...news].join("\n"));
    setAttr(strip, "aria-label", [`${what}. ${words} goes back to your tabs.`, ...news.map(t => `${t}.`)].join(" "));
    return;
  }
  const task = isolate(name) || "a task";
  const nameEl = label.querySelector(".zenius-strip-name");
  setText(nameEl, task);
  // Only the name is on its line, so it can take its own direction: a cut
  // right-to-left name keeps its start.
  setAttr(nameEl, "dir", isOneIsolate(task) ? "auto" : "ltr");
  setAttr(strip, "title", [`Watching ${task}. ${key} goes back to your tabs.`, ...news].join("\n"));
  setAttr(strip, "aria-label", [`Watching ${task}. ${words} goes back to your tabs.`, ...news.map(t => `${t}.`)].join(" "));
}

/**
 * The strip has a narrow sidebar's width, so it says only what matters most:
 * who needs the user, else who is working. The panel has the rest.
 *
 * @param {number} total
 * @param {number} attention  tasks waiting for the user's answer
 * @param {number} working
 * @param {number} [paused]  tasks the user paused
 */
export function stripText(total, attention, working, paused = 0) {
  if (attention) {
    return attention === 1 ? "An agent needs you" : `${attention} agents need you`;
  }
  if (working) {
    return working === 1 ? "1 agent working" : `${working} agents working`;
  }
  if (paused) {
    return paused === 1 ? "1 agent paused" : `${paused} agents paused`;
  }
  return total === 1 ? "1 agent task" : `${total} agent tasks`;
}

/**
 * What a waiting task waits for, after its name. The kinds: an agent's
 * hand-off reason (sign_in, irreversible, human_check, other), a page's
 * permission prompt, a choice (the takeover prompt's pause, or a Take over
 * that couldn't begin), or why an agent sidebar's chat waits (its task's
 * `why`).
 */
const WAITS = new Map([
  ["sign_in", "needs a sign-in"],
  ["irreversible", "needs your OK"],
  ["human_check", "needs a human check"],
  ["permission", "needs your permission"],
  ["choice", "needs a choice"],
  ["zenius", "needs a choice"],
  ["question", "needs an answer"],
  ["error", "hit an error"],
  ["interrupted", "was interrupted"],
  // The user's own Take over of a chat's task: the agent waits for them.
  ["takeover", "waits for you"],
]);

/** What any waiting task waits for, where nothing more is known or fits. */
const NEEDS_YOU = "needs you";

/**
 * "needs a sign-in": what a task that needs the user waits for, said after
 * its name. Any other kind, a hand-off's other reason or none among them,
 * says only that it needs the user.
 *
 * @param {string|null} kind
 */
export function waitText(kind) {
  return WAITS.get(kind) ?? NEEDS_YOU;
}

/**
 * Open the tasks panel in `win`, anchored to `anchor` or to the strip.
 *
 * @param {Window} win
 * @param {PanelActions} actions
 * @param {Element} [anchor]
 */
export function openTasksPanel(win, actions, anchor) {
  const w = ensureWindow(win, actions);
  if (!w) {
    return null;
  }
  if (!w.panel) {
    w.panel = win.document.createXULElement("panel");
    w.panel.id = PANEL_ID;
    w.panel.setAttribute("type", "arrow");
    w.panel.setAttribute("role", "dialog");
    w.panel.setAttribute("aria-label", "Agent tasks");
    w.panel.setAttribute("orient", "vertical");
    const body = win.document.createElementNS(XHTML_NS, "div");
    body.className = "zenius-tasks";
    w.panel.append(body);
    win.document.getElementById("mainPopupSet").append(w.panel);
    // A closed panel keeps no rows: they hold old names and closures, and
    // it renders afresh when it opens.
    w.panel.addEventListener("popuphidden", event => {
      const cur = windows.get(win);
      if (event.target === event.currentTarget && cur) {
        cur.pressedAt = 0;
        cur.renderAfterPress = false;
        for (const el of cur.els.values()) {
          el.remove();
        }
        cur.els.clear();
      }
    });
    w.panel.addEventListener(
      "mousedown",
      () => {
        const cur = windows.get(win);
        if (cur) {
          cur.pressedAt = Date.now();
        }
      },
      true
    );
    // The release can come anywhere; the held render runs after the click.
    const release = () => {
      const cur = windows.get(win);
      if (!cur?.pressedAt) {
        return;
      }
      cur.pressedAt = 0;
      if (cur.renderAfterPress) {
        cur.renderAfterPress = false;
        win.setTimeout(() => {
          if (cur.panel?.state === "open") {
            renderPanel(win, cur, cur.actions);
          }
        }, 0);
      }
    };
    win.addEventListener("mouseup", release, true);
    win.addEventListener("blur", release);
  }
  if (actions.rows) {
    w.rows = actions.rows();
  }
  renderPanel(win, w, actions);
  const target = anchor?.isConnected ? anchor : w.strip;
  const position = panelPosition(win, w.panel, target);
  keepInWindow(win, w, target, position);
  w.panel.openPopup(target, position, 0, PANEL_Y, false, false);
  return w.panel;
}

/**
 * Where the panel opens: above its anchor, growing toward the window's
 * middle. So it lines up with the anchor's edge nearer the window's edge:
 * the left one of a strip on the left, the right one with the sidebar on
 * the right. A popup's "start" is the left edge left to right, the right
 * edge right to left.
 *
 * @param {Window} win
 * @param {Element} panel
 * @param {Element} anchor
 */
function panelPosition(win, panel, anchor) {
  const r = anchor.getBoundingClientRect();
  const onLeft = r.left + r.width / 2 <= win.innerWidth / 2;
  const rtl = win.getComputedStyle(panel).direction === "rtl";
  return onLeft !== rtl ? "before_start" : "before_end";
}

/**
 * Keep the panel inside its window. A popup is a window of its own, which the
 * system keeps on the screen, not in the browser's window. On a Mac whose
 * window doesn't fill the screen it hung 62 px past the window's right edge
 * with the sidebar on the right, and 13 px past a second window's left edge,
 * with the rows' Stop and Resume agent. Its margin (Zen's shadow margin, 8 px
 * on a Mac, none on Linux) and the window's place on the screen decide by how
 * much, so this measures where it landed and moves it in by that much.
 *
 * - It measures with layout's rect (rectInWindow). On Zen 1.24.3b on a Mac
 *   this no longer worked from the popup's screen rect alone: the panel
 *   stayed where it opened.
 * - It measures at popuppositioned, at popupshown, and once more a moment
 *   after, in case the system places the popup late.
 * - A move that didn't take (the panel is where it was) is made again as an
 *   absolute move on the screen.
 * - Each step goes to the log, so a run on a Mac shows which one failed.
 *
 * @param {Window} win
 * @param {object} w  the window's panel state
 * @param {Element} anchor
 * @param {string} position
 */
function keepInWindow(win, w, anchor, position) {
  w.unfit?.();
  const panel = w.panel;
  let x = 0;
  let y = PANEL_Y;
  let moves = 0;
  // Where the panel was when it was last moved: still there means the move
  // didn't take.
  let before = null;
  let later = 0;
  const fit = event => {
    const step = event?.type ?? "later";
    if (panel.state !== "showing" && panel.state !== "open") {
      return;
    }
    const r = rectInWindow(win, panel);
    if (!r) {
      log(`panel ${step}: ${panel.state}, no rect yet`);
      return;
    }
    const dx = into(r.left, r.right, win.innerWidth);
    const dy = r.vertical ? into(r.top, r.bottom, win.innerHeight) : 0;
    let how = "stays";
    if ((dx || dy) && moves < 3) {
      moves++;
      if (before && Math.abs(r.left - before.left) < 1 && Math.abs(r.top - before.top) < 1) {
        // Where layout puts its border box, on the screen.
        panel.moveTo(Math.round(win.mozInnerScreenX + r.left + dx), Math.round(win.mozInnerScreenY + r.top + dy));
        how = "moveTo";
      } else {
        x += dx;
        y += dy;
        panel.moveToAnchor(anchor, position, x, y, false);
        how = `moveToAnchor ${x},${y}`;
      }
      before = { left: r.left, top: r.top };
    }
    const a = anchor.getBoundingClientRect();
    log(
      `panel ${step}: ${panel.state} ${position}, anchor ${Math.round(a.left)}..${Math.round(a.right)}, ` +
        `${r.from} ${Math.round(r.left)}..${Math.round(r.right)} x ${Math.round(r.top)}..${Math.round(r.bottom)}, ` +
        `window ${win.innerWidth}x${win.innerHeight}${dx || dy ? `, off by ${dx},${dy}` : ""}: ${how}`
    );
  };
  const shown = event => {
    fit(event);
    win.clearTimeout(later);
    later = win.setTimeout(() => fit(), LATE_FIT_MS);
  };
  // A popup inside the panel sends its own popuphidden up through it.
  const hidden = event => event.target === panel && unfit();
  const unfit = () => {
    win.clearTimeout(later);
    panel.removeEventListener("popuppositioned", fit);
    panel.removeEventListener("popupshown", shown);
    panel.removeEventListener("popuphidden", hidden);
    if (w.unfit === unfit) {
      w.unfit = null;
    }
  };
  panel.addEventListener("popuppositioned", fit);
  panel.addEventListener("popupshown", shown);
  panel.addEventListener("popuphidden", hidden);
  w.unfit = unfit;
}

/**
 * The panel's place in its window's viewport, as layout puts it, which is
 * where the user sees it. An opening animation only slides it up or down:
 * a CSS transform on Windows and Linux, which moves layout's rect too, and
 * the window's own transform on a Mac, which doesn't. While a CSS transform
 * runs, its vertical place comes from its screen rect, where it will stop;
 * without one yet (Linux, before it shows), its vertical place waits.
 *
 * @param {Window} win
 * @param {Element} panel
 * @returns {{left: number, right: number, top: number, bottom: number, vertical: boolean, from: string}|null}
 */
function rectInWindow(win, panel) {
  const b = panel.getBoundingClientRect();
  const s = screenRect(win, panel);
  if (!b.width) {
    return s && { ...s, vertical: true, from: "screen" };
  }
  const r = { left: b.left, right: b.right, top: b.top, bottom: b.bottom, vertical: true, from: "layout" };
  if (win.getComputedStyle(panel).transform !== "none") {
    Object.assign(r, s ? { top: s.top, bottom: s.bottom, from: "layout+screen" } : { vertical: false });
  }
  return r;
}

/** The popup's screen rect in its window's viewport, or null before it has one. */
function screenRect(win, panel) {
  try {
    const s = panel.getOuterScreenRect();
    if (s.width) {
      const left = s.left - win.mozInnerScreenX;
      const top = s.top - win.mozInnerScreenY;
      return { left, top, right: left + s.width, bottom: top + s.height };
    }
  } catch {
    // Not a popup that can say.
  }
  return null;
}

/**
 * How far to move the span [a, b] so it lies inside [PANEL_GAP, size -
 * PANEL_GAP]. A span too long for that keeps its start inside.
 */
function into(a, b, size) {
  if (a < PANEL_GAP || b - a > size - 2 * PANEL_GAP) {
    return Math.round(PANEL_GAP - a);
  }
  if (b > size - PANEL_GAP) {
    return Math.round(size - PANEL_GAP - b);
  }
  return 0;
}

/** @param {Window} win */
export function closeTasksPanel(win) {
  windows.get(win)?.panel?.hidePopup();
}

/** @param {Window} win */
export function tasksPanel(win) {
  return windows.get(win)?.panel ?? null;
}

function ensureWindow(win, actions) {
  let w = windows.get(win);
  if (w?.strip.isConnected) {
    return w;
  }
  const doc = win.document;
  const foot = doc.getElementById("zen-sidebar-foot-buttons");
  if (!foot?.parentElement) {
    return null;
  }
  // The strip and All agent tasks share a row, as siblings: a button inside the
  // strip's role=button would be presentational to a screen reader.
  const row = doc.createElementNS(XHTML_NS, "div");
  row.id = STRIP_ROW_ID;
  row.hidden = true;
  const strip = doc.createElementNS(XHTML_NS, "div");
  strip.id = STRIP_ID;
  strip.hidden = true;
  strip.setAttribute("role", "button");
  strip.setAttribute("tabindex", "0");
  strip.setAttribute("title", "Agent tasks");
  const dot = doc.createElementNS(XHTML_NS, "span");
  dot.className = "zenius-strip-dot";
  const text = doc.createElementNS(XHTML_NS, "span");
  text.className = "zenius-strip-text";
  strip.append(dot, text);
  const all = doc.createElementNS(XHTML_NS, "button");
  all.id = STRIP_ALL_ID;
  all.hidden = true;
  all.setAttribute("title", "All agent tasks");
  all.setAttribute("aria-label", "All agent tasks");
  // The panel opens only at the user's click: the strip's, or All agent
  // tasks'.
  const showPanel = () => openTasksPanel(win, windows.get(win)?.actions ?? actions, strip);
  all.addEventListener("click", showPanel);
  const open = event => {
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    const now = windows.get(win);
    const act = now?.actions ?? actions;
    // The one waiting task the strip names: straight there, to its Space
    // and the chat that drives it, or to its chat in the agent sidebar.
    // Where only the dot shows (a collapsed sidebar), and while watching,
    // the panel opens, which names the tasks.
    const one = now?.one;
    if (one && !strip.hasAttribute("watching") && stripSeen(win)) {
      if (one.uid) {
        act.openSidebar?.(one.uid, win);
      } else {
        act.open?.(one.id, win);
      }
      return;
    }
    showPanel();
  };
  strip.addEventListener("click", open);
  strip.addEventListener("keydown", open);
  row.append(strip, all);
  foot.parentElement.insertBefore(row, foot);
  w?.fit?.disconnect();
  const fit = watchFit(win, row, text);
  w = { strip, row, all, fit, one: null, panel: w?.panel ?? null, rows: w?.rows ?? [], els: w?.els ?? new Map(), actions };
  windows.set(win, w);
  return w;
}

const ARRIVAL_ID = "zenius-arrival";

/**
 * A remote task just started while the agent sidebar is closed (its glue's
 * arrival): a small card right over the strip, where zenius tells the user a
 * task needs them, saying `text` with Watch and Stop. It takes no focus,
 * opens nothing and selects nothing (I1), and goes after `ms`, though not from
 * under the pointer or the keyboard's focus, or when dismissed. A new arrival
 * takes the card's place. It has the look of the agent sidebar's own card
 * (zenius-ux.css), whose panel sets the address apart the same way.
 *
 * @param {Window} win
 * @param {{text: string, watch: () => void, stop: () => void, ms: number}} arrival
 * @returns {boolean} whether it shows
 */
export function showArrival(win, { text, watch, stop, ms }) {
  const doc = win.document;
  const foot = doc.getElementById("zen-sidebar-foot-buttons");
  if (!foot?.parentElement || typeof text !== "string" || !text) {
    return false;
  }
  hideArrival(win);
  const make = (tag, className, label) => {
    const el = doc.createElementNS(XHTML_NS, tag);
    el.className = className;
    if (label) {
      el.textContent = label;
    }
    return el;
  };
  const card = make("div", "zenius-arrival");
  card.id = ARRIVAL_ID;
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", text);
  const button = (label, fn, which, extra = {}) => {
    const el = make("button", `zenius-arrival-button zenius-arrival-${which}`, label);
    el.type = "button";
    for (const [name, value] of Object.entries(extra)) {
      el.setAttribute(name, value);
    }
    el.addEventListener("click", event => {
      event.stopPropagation();
      hideArrival(win);
      fn?.();
    });
    return el;
  };
  // The address, the text's last isolate ("Task from <label> on <address>"),
  // is a chip; the text stays the same. The isolate's marks stay outside the
  // chip: Gecko breaks a line after a leading one even in a nowrap span,
  // which left a sliver of the chip on the line before.
  const line = make("span", "zenius-arrival-text");
  const end = text.lastIndexOf("\u2069");
  const start = end < 0 ? -1 : text.lastIndexOf("\u2068", end);
  if (start < 0) {
    line.textContent = text;
  } else {
    line.append(text.slice(0, start + 1), make("span", "zenius-arrival-addr", text.slice(start + 1, end)), text.slice(end));
  }
  card.append(
    line,
    button("Watch", watch, "watch"),
    button("Stop", stop, "stop"),
    button("✕", null, "close", { title: "Dismiss", "aria-label": "Dismiss" })
  );
  const row = doc.getElementById(STRIP_ROW_ID);
  foot.parentElement.insertBefore(card, row?.parentElement === foot.parentElement ? row : foot);
  const arm = () => {
    card.zeniusTimer = win.setTimeout(() => (card.matches(":hover, :focus-within") ? arm() : hideArrival(win)), ms);
  };
  arm();
  return true;
}

/** The arrival card goes, if it's up. */
export function hideArrival(win) {
  const card = win.document.getElementById(ARRIVAL_ID);
  if (card) {
    win.clearTimeout(card.zeniusTimer);
    card.remove();
  }
}

const setAttr = (el, name, value) => {
  if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
};

const setText = (el, text) => {
  if (el.textContent !== text) {
    el.textContent = text;
  }
};

/** The id of the task whose row holds `el`. */
const taskOf = el => Number(el.closest(".zenius-task")?.dataset.space);

/** A button that calls the window's latest `actions[button's action]`. */
function actionButton(doc, label, action, cls = "") {
  const b = doc.createElementNS(XHTML_NS, "button");
  b.textContent = label;
  b.className = `zenius-task-button ${cls}`.trim();
  b.dataset.action = action;
  b.addEventListener("click", async () => {
    const w = windows.get(doc.defaultView);
    const id = taskOf(b);
    const act = b.dataset.action;
    if (!w || Number.isNaN(id)) {
      return;
    }
    // These two take the user to the Space; the panel would only cover it.
    // Let it close first: a doorhanger the Space shows while this panel is
    // still closing can be rolled up with it (seen on the Mac).
    if (act === "open" || act === "takeOver") {
      await hidePanel(w.panel);
    }
    // The panel's window: with window sync, the task opens in it.
    w.actions?.[act]?.(id, doc.defaultView);
  });
  return b;
}

function createRow(doc, id) {
  const el = doc.createElementNS(XHTML_NS, "div");
  el.className = "zenius-task";
  el.dataset.space = String(id);
  el.id = `zenius-task-row-${id}`;
  // A screen reader names the row as it enters it, so its Open, Resume agent
  // and Stop say which task they're for. VoiceOver reads a focused button's
  // own name, not its group's, so each button is described by the row too
  // (updateRow).
  el.setAttribute("role", "group");
  const dot = doc.createElementNS(XHTML_NS, "span");
  dot.className = "zenius-task-dot";
  const info = doc.createElementNS(XHTML_NS, "div");
  info.className = "zenius-task-info";
  const name = doc.createElementNS(XHTML_NS, "div");
  name.className = "zenius-task-name";
  name.dir = "auto";
  const detail = doc.createElementNS(XHTML_NS, "div");
  detail.className = "zenius-task-detail";
  info.append(name, detail);
  const buttons = doc.createElementNS(XHTML_NS, "div");
  buttons.className = "zenius-task-actions";
  buttons.append(actionButton(doc, "Open", "open"), actionButton(doc, "Stop", "stop", "danger"));
  el.append(dot, info, buttons);
  return el;
}

/** The task's tabs by name; a name opens its tab. */
function syncTabs(doc, info, row) {
  const tabs = row.tabs ?? [];
  let list = info.querySelector(":scope > .zenius-task-tabs");
  if (!tabs.length) {
    list?.remove();
    return;
  }
  if (!list) {
    list = doc.createElementNS(XHTML_NS, "div");
    list.className = "zenius-task-tabs";
    info.querySelector(":scope > .zenius-task-detail").after(list);
  }
  const shown = tabs.slice(0, MAX_TABS);
  const have = [...list.querySelectorAll(":scope > .zenius-task-tab")];
  shown.forEach((tab, i) => {
    let b = have[i];
    if (!b) {
      b = doc.createElementNS(XHTML_NS, "button");
      b.className = "zenius-task-tab";
      // A title alone takes its own direction: a clipped right-to-left one
      // keeps its start.
      b.dir = "auto";
      b.addEventListener("click", async () => {
        const w = windows.get(doc.defaultView);
        const id = taskOf(b);
        const tabId = b.dataset.tab;
        if (!w || Number.isNaN(id)) {
          return;
        }
        await hidePanel(w.panel);
        w.actions?.openTab?.(id, tabId, doc.defaultView);
      });
      list.insertBefore(b, list.querySelector(":scope > .zenius-task-tabs-more"));
    }
    setText(b, isolate(tab.title));
    if (b.title !== b.textContent) {
      b.title = b.textContent;
    }
    if (b.dataset.tab !== tab.id) {
      b.dataset.tab = tab.id;
    }
  });
  for (const b of have.slice(shown.length)) {
    b.remove();
  }
  let more = list.querySelector(":scope > .zenius-task-tabs-more");
  if (tabs.length > MAX_TABS) {
    if (!more) {
      more = doc.createElementNS(XHTML_NS, "span");
      more.className = "zenius-task-tabs-more";
      list.append(more);
    }
    setText(more, `+${tabs.length - MAX_TABS} more`);
  } else {
    more?.remove();
  }
}

/** The auto-close's mark, with its one-click close. */
function syncIdle(doc, info, row) {
  let line = info.querySelector(":scope > .zenius-task-idle");
  if (!row.idleFor) {
    line?.remove();
    return;
  }
  if (!line) {
    line = doc.createElementNS(XHTML_NS, "div");
    line.className = "zenius-task-idle";
    const text = doc.createElementNS(XHTML_NS, "span");
    const b = doc.createElementNS(XHTML_NS, "button");
    b.className = "zenius-task-button danger";
    b.dataset.action = "closeIdle";
    b.textContent = "Close task";
    b.title = "Closes the task and its tabs. A tab you're looking at closes when you leave it.";
    b.addEventListener("click", () => {
      const id = taskOf(b);
      if (!Number.isNaN(id)) {
        windows.get(doc.defaultView)?.actions?.closeIdle?.(id);
      }
    });
    line.append(text, b);
    info.append(line);
  }
  setText(line.firstChild, `Idle for ${row.idleFor}`);
}

/**
 * Open and Stop stay; the buttons between them follow who holds the task:
 * Pause or Resume (the same button, relabelled) and Take over for the
 * agent, Resume agent for the user. Focus on a button that goes moves to the
 * first that comes, so the keyboard stays in the row.
 */
function syncButtons(doc, box, row) {
  const kind = row.ownership === "agent" ? "agent" : "user";
  const stop = box.lastElementChild;
  if (box.dataset.kind !== kind) {
    const gone = [...box.children].slice(1, -1);
    const hadFocus = gone.includes(doc.activeElement);
    for (const b of gone) {
      b.remove();
    }
    const made =
      kind === "agent"
        ? [actionButton(doc, "Pause", "pause"), actionButton(doc, "Take over", "takeOver")]
        : [actionButton(doc, "Resume agent", "handBack")];
    for (const b of made) {
      box.insertBefore(b, stop);
    }
    box.dataset.kind = kind;
    if (hadFocus) {
      made[0].focus();
    }
  }
  if (kind === "agent") {
    const pause = box.children[1];
    const [label, action] = row.paused ? ["Resume", "resume"] : ["Pause", "pause"];
    setText(pause, label);
    if (pause.dataset.action !== action) {
      pause.dataset.action = action;
    }
  }
}

/**
 * The Resume line under the row's Resume or Resume agent, once the user
 * typed a password, card or code where that button clears it. It's part of
 * the row's text, which describes each of its buttons.
 */
function syncClears(doc, el, row) {
  let line = el.querySelector(":scope > .zenius-task-clears");
  if (!row.clears) {
    line?.remove();
    return;
  }
  if (!line) {
    line = doc.createElementNS(XHTML_NS, "div");
    line.className = "zenius-task-clears";
    el.append(line);
  }
  setText(line, row.clears);
}

function updateRow(doc, el, row) {
  setAttr(el, "state", row.state);
  setAttr(el, "aria-label", isolate(row.name) || "Agent task");
  const info = el.querySelector(":scope > .zenius-task-info");
  setText(info.querySelector(":scope > .zenius-task-name"), isolate(row.name));
  const detail = info.querySelector(":scope > .zenius-task-detail");
  setText(detail, row.detail);
  if (detail.title !== row.detail) {
    detail.title = row.detail;
  }
  syncTabs(doc, info, row);
  syncIdle(doc, info, row);
  syncButtons(doc, el.querySelector(":scope > .zenius-task-actions"), row);
  syncClears(doc, el, row);
  // The task's name as each button's description, read after the button.
  // Close task keeps its title, which says what it closes.
  for (const b of el.querySelectorAll(":scope > .zenius-task-actions > button, .zenius-task-tab")) {
    setAttr(b, "aria-describedby", el.id);
  }
}

/** @param {Element} panel */
function hidePanel(panel) {
  if (panel.state === "closed") {
    return Promise.resolve();
  }
  const hidden = new Promise(resolve => panel.addEventListener("popuphidden", resolve, { once: true }));
  panel.hidePopup();
  // Never wait long: a panel that doesn't report hiding mustn't block Open.
  return Promise.race([hidden, new Promise(resolve => panel.ownerDocument.defaultView.setTimeout(resolve, 500))]);
}

/**
 * Show `w.rows`, changing only what changed: rows stay the same elements
 * while their tasks are listed, and move only when the order does.
 */
function renderPanel(win, w, actions) {
  w.actions = actions;
  const doc = win.document;
  const body = w.panel.querySelector(".zenius-tasks");
  let title = body.querySelector(":scope > .zenius-tasks-title");
  if (!title) {
    title = doc.createElementNS(XHTML_NS, "div");
    title.className = "zenius-tasks-title";
    title.textContent = "Agent tasks";
    body.prepend(title);
  }
  let empty = body.querySelector(":scope > .zenius-tasks-empty");
  if (w.rows.length || w.waiting?.length) {
    empty?.remove();
  } else if (!empty) {
    empty = doc.createElementNS(XHTML_NS, "div");
    empty.className = "zenius-tasks-empty";
    empty.textContent = "No agent is working right now.";
    title.after(empty);
  }
  const listed = new Set(w.rows.map(row => row.id));
  for (const [id, el] of w.els) {
    if (!listed.has(id)) {
      el.remove();
      w.els.delete(id);
    }
  }
  let prev = title;
  for (const row of w.rows) {
    let el = w.els.get(row.id);
    if (!el) {
      el = createRow(doc, row.id);
      w.els.set(row.id, el);
    }
    updateRow(doc, el, row);
    if (prev.nextElementSibling !== el) {
      prev.after(el);
    }
    prev = el;
  }
  renderWaiting(doc, body, prev, w);
}

/**
 * The agent sidebar's tasks that need the user before a zenius task says so
 * (a chat's question, error or permission): a row each under zenius's, with
 * what it waits for and Open, which shows that chat in the sidebar. The
 * strip counts them.
 */
function renderWaiting(doc, body, prev, w) {
  const waiting = w.waiting ?? [];
  const els = new Map([...body.querySelectorAll(":scope > .zenius-tasks-waiting")].map(el => [el.dataset.uid, el]));
  const listed = new Set(waiting.map(item => item.uid));
  for (const [uid, el] of els) {
    if (!listed.has(uid)) {
      el.remove();
      els.delete(uid);
    }
  }
  for (const item of waiting) {
    let el = els.get(item.uid);
    if (!el) {
      el = waitingRow(doc, item.uid);
      els.set(item.uid, el);
    }
    const name = isolate(item.name) || "New task";
    // A screen reader names the row as it enters it, so its Open says which
    // task it's for.
    setAttr(el, "aria-label", name);
    setText(el.querySelector(".zenius-task-name"), name);
    const what = waitText(item.why ?? null);
    setText(el.querySelector(".zenius-task-detail"), `${what[0].toUpperCase()}${what.slice(1)} in the agent sidebar`);
    if (prev.nextElementSibling !== el) {
      prev.after(el);
    }
    prev = el;
  }
}

/** A row for one of the agent sidebar's waiting tasks, in a task row's look. */
function waitingRow(doc, uid) {
  const el = doc.createElementNS(XHTML_NS, "div");
  el.className = "zenius-tasks-waiting";
  el.dataset.uid = uid;
  el.setAttribute("role", "group");
  const div = className => {
    const part = doc.createElementNS(XHTML_NS, "div");
    part.className = className;
    return part;
  };
  const dot = doc.createElementNS(XHTML_NS, "span");
  dot.className = "zenius-task-dot";
  const info = div("zenius-task-info zenius-tasks-waiting-text");
  const name = div("zenius-task-name");
  name.dir = "auto";
  info.append(name, div("zenius-task-detail"));
  const actions = div("zenius-task-actions");
  const open = doc.createElementNS(XHTML_NS, "button");
  open.className = "zenius-task-button";
  open.textContent = "Open";
  open.addEventListener("click", async () => {
    const now = windows.get(doc.defaultView);
    if (now) {
      await hidePanel(now.panel);
      now.actions?.openSidebar?.(el.dataset.uid, doc.defaultView);
    }
  });
  actions.append(open);
  el.append(dot, info, actions);
  return el;
}
