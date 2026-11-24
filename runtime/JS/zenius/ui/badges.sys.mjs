// Agent Space badges: a dot on the Space's button in Zen's Space switcher,
// and a status line under the Space's header.
//
// Zen re-renders both on every workspace change, but only touches the
// button's tooltip, its .zen-workspace-icon child and the header's icon and
// name. So the badge is our own child element plus a `zenius-agent`
// attribute, and we re-apply everything on ZenWorkspacesUIUpdate, which Zen
// fires in every window after it reconciles the switcher.

import { ensureStyles } from "chrome://userscripts/content/zenius/ui/styles.sys.mjs";
import { isolate } from "chrome://userscripts/content/zenius/ui/text.sys.mjs";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_TEXT = 140;

/**
 * Badge states, in the order they draw attention.
 * - "working": the agent is acting (pulsing dot)
 * - "idle": an agent Space with nothing happening
 * - "paused": a takeover prompt is open
 * - "needs-user": handed off, or a permission prompt waits for the user
 * - "user": the user took over
 *
 * @typedef {"working"|"idle"|"paused"|"needs-user"|"user"} BadgeState
 *
 * @typedef {object} BadgeInfo
 * @property {BadgeState} state
 * @property {string} [text]  setAgentTaskState text
 * @property {string} [label]  what shows instead of `text`, built from
 *   isolated names (the Agents Space's badge names its tasks)
 * @property {string} [action]  the current action label
 * @property {string} [name]  Space name, for the tooltip
 */

/** @type {Map<string, BadgeInfo>} keyed by workspace uuid */
const badges = new Map();
/** @type {WeakSet<Window>} */
const hooked = new WeakSet();
let observing = false;
/**
 * The least room the rest of a Space's status gets, in ems. With less it
 * hides, rather than show a stub such as "Agent needs you ·…": on a Mac's
 * narrower system font the narrowest sidebar leaves it a few pixels,
 * where Linux's words fill the line. The status's title keeps the whole
 * text.
 */
const MIN_REST_EM = 5;
/** Each window's ResizeObserver: a Space's status refits when its width changes. */
const resizers = new WeakMap();

/**
 * Set or clear the badge of the Space with workspace `uuid` in every window.
 *
 * @param {string} uuid
 * @param {BadgeInfo|null} info  null removes the badge
 */
export function setSpaceBadge(uuid, info) {
  if (info) {
    badges.set(uuid, {
      state: info.state,
      text: clip(info.text),
      // A label cut short would leave an isolate open over what follows it:
      // too long a label shows as the clipped text instead.
      label: info.label && info.label.length <= MAX_TEXT ? info.label : undefined,
      action: clip(info.action),
      name: info.name,
    });
  } else {
    badges.delete(uuid);
  }
  for (const win of browserWindows()) {
    applyWindow(win);
  }
}

/** @param {string} uuid */
export function spaceBadge(uuid) {
  return badges.get(uuid) ?? null;
}

/** Remove every badge (tests, shutdown). */
export function clearSpaceBadges() {
  badges.clear();
  for (const win of browserWindows()) {
    applyWindow(win);
  }
}

function clip(s) {
  return s ? String(s).slice(0, MAX_TEXT) : "";
}

function* browserWindows() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (!win.closed && win.gZenWorkspaces) {
      yield win;
    }
  }
}

/** @param {Window} win */
function hookWindow(win) {
  if (hooked.has(win)) {
    return;
  }
  hooked.add(win);
  win.addEventListener("ZenWorkspacesUIUpdate", () => applyWindow(win));
  if (!observing) {
    observing = true;
    Services.obs.addObserver(subject => {
      // A new window builds its switcher during startup; apply once it has.
      const w = subject;
      w.gZenWorkspaces?.promiseInitialized.then(() => applyWindow(w));
    }, "browser-delayed-startup-finished");
  }
}

/**
 * The words a header's status pill always shows in full, its start; what
 * follows them (the rest of the state, the tasks' names) is clipped first.
 * They're what every handoff shows: at the sidebar's default width the pill
 * had shown "Agent nee…".
 */
const STATE_WORDS = {
  working: "Agent working",
  idle: "Agent Space",
  paused: "Agent paused",
  "needs-user": "Agent needs you",
  user: "You're in control",
};

/**
 * The status's words: the state's own (STATE_WORDS), then a space and the
 * rest, its parts after a comma: "Agent working Finding a table for 2, Click
 * Submit". The state's words are in the pill's color, the rest in gray
 * (zenius-ux.css). The Space's tooltip reads the same words.
 *
 * @param {BadgeInfo} info
 */
export function describe(info) {
  const words = STATE_WORDS[info.state] ?? "";
  // Each part isolated: a right-to-left name keeps its order and its place.
  const rest = [info.state === "paused" ? "waiting for you" : "", info.label ?? isolate(info.text), isolate(info.action)]
    .filter(Boolean)
    .join(", ");
  return [words, rest].filter(Boolean).join(" ");
}

/** @param {Window} win */
export function applyWindow(win) {
  hookWindow(win);
  const doc = win.document;
  ensureStylesFor(win);

  for (const btn of doc.querySelectorAll(
    "#zen-workspaces-button toolbarbutton[zen-workspace-id]"
  )) {
    const info = badges.get(btn.getAttribute("zen-workspace-id"));
    let dot = btn.querySelector(":scope > .zenius-space-badge");
    if (!info) {
      if (btn.hasAttribute("zenius-agent")) {
        btn.removeAttribute("zenius-agent");
        const ws = win.gZenWorkspaces.getWorkspaceFromId(
          btn.getAttribute("zen-workspace-id")
        );
        if (ws) {
          btn.setAttribute("tooltiptext", ws.name);
        }
      }
      dot?.remove();
      continue;
    }
    btn.setAttribute("zenius-agent", info.state);
    if (!dot) {
      dot = doc.createElementNS(XHTML_NS, "span");
      dot.className = "zenius-space-badge";
      dot.setAttribute("aria-hidden", "true");
      btn.append(dot);
    }
    const name =
      win.gZenWorkspaces.getWorkspaceFromId(btn.getAttribute("zen-workspace-id"))
        ?.name ?? info.name;
    btn.setAttribute("tooltiptext", `${isolate(name)} — ${describe(info)}`);
  }

  for (const space of doc.querySelectorAll("zen-workspace")) {
    const info = badges.get(space.id);
    const indicator = space.querySelector(":scope > .zen-current-workspace-indicator");
    if (!indicator) {
      continue;
    }
    // Its own line under the header, as wide as the sidebar. In the header's
    // row, of a fixed height, it had to share the width with the Space's
    // name and Zen's actions button, and showed "Agent nee…" at the
    // sidebar's default width.
    let status = space.querySelector(":scope > .zenius-space-status");
    if (!info) {
      status?.remove();
      space.removeAttribute("zenius-agent");
      resizers.get(win)?.unobserve(space);
      continue;
    }
    space.setAttribute("zenius-agent", info.state);
    if (!status) {
      status = doc.createElementNS(XHTML_NS, "div");
      status.className = "zenius-space-status";
      const dot = doc.createElementNS(XHTML_NS, "span");
      dot.className = "zenius-space-status-dot";
      const label = doc.createElementNS(XHTML_NS, "span");
      label.className = "zenius-space-status-text";
      // The state's words, kept whole, then the rest, which clips.
      const words = doc.createElementNS(XHTML_NS, "span");
      words.className = "zenius-space-status-words";
      const more = doc.createElementNS(XHTML_NS, "span");
      more.className = "zenius-space-status-more";
      label.append(words, more);
      status.append(dot, label);
    }
    if (status.previousElementSibling !== indicator) {
      indicator.after(status);
    }
    // The sidebar's width: an observer fits it at once, and on each change.
    watchWidth(win, space);
    status.setAttribute("state", info.state);
    const text = describe(info);
    const label = status.querySelector(".zenius-space-status-text");
    if (label.textContent !== text) {
      const words = STATE_WORDS[info.state] ?? "";
      const cut = words && text.startsWith(words) ? words.length : text.length;
      label.querySelector(".zenius-space-status-words").textContent = text.slice(0, cut);
      label.querySelector(".zenius-space-status-more").textContent = text.slice(cut);
      fitStatus(status);
    }
    status.setAttribute("title", text);
  }
}

/**
 * Refit a Space's status whenever the Space's width changes, which is the
 * sidebar's. The status's own width follows its text, so it wouldn't grow
 * back.
 *
 * @param {Window} win
 * @param {Element} space  its zen-workspace
 */
function watchWidth(win, space) {
  let ro = resizers.get(win);
  if (!ro) {
    ro = new win.ResizeObserver(entries => {
      for (const { target } of entries) {
        const status = target.querySelector?.(":scope > .zenius-space-status");
        if (status) {
          fitStatus(status);
        }
      }
    });
    resizers.set(win, ro);
  }
  ro.observe(space);
}

/**
 * Show the rest of the status after its state words only when it gets at
 * least MIN_REST_EM of room, or fits whole.
 *
 * @param {Element} status
 */
export function fitStatus(status) {
  const win = status.ownerDocument?.defaultView;
  const more = status.querySelector(".zenius-space-status-more");
  if (!win || !more) {
    return;
  }
  // Measured as it lays out with the rest shown: the attribute only hides.
  status.removeAttribute("short");
  if (!more.textContent || !status.isConnected) {
    return;
  }
  const room = more.getBoundingClientRect().width;
  const clipped = more.scrollWidth > more.clientWidth + 1;
  const em = parseFloat(win.getComputedStyle(status).fontSize) || 10.5;
  if (clipped && room < MIN_REST_EM * em) {
    status.setAttribute("short", "true");
  }
}

function ensureStylesFor(win) {
  ensureStyles(win);
}
