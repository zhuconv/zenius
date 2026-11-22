// The agent cursor: an arrow with a short action label that moves over an
// agent tab's page while someone can see that tab.
//
// It is drawn in chrome, in a layer inside the tab's .browserStack, so the
// page can't see it, content screenshots don't include it and it never
// touches the OS cursor. Moves animate with the Web Animations API on
// `transform`, which the compositor runs off the main thread. When nobody
// can see the tab, a move only records the point and returns at once; the
// layer catches up when the tab is shown again.

import { isTabVisible } from "chrome://userscripts/content/zenius/ui/visibility.sys.mjs";
import { ensureStyles } from "chrome://userscripts/content/zenius/ui/styles.sys.mjs";
import { notePage } from "chrome://userscripts/content/zenius/ui/pages.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
// Our own arrowhead in a 24-unit box with its tip at (3, 2): black with a
// thin white edge in a soft glow, after Codex's cursor, which the user
// preferred to the purple arrow (2026-11-21). The CSS offsets the tip onto
// the layer's origin. Its corners are round, as the user asked (2026-11-21,
// their pick of three rounder candidates): each is a quadratic whose control
// point is the old sharp corner (tip (3, 2), wings toward (19.3, 11.3) and
// (6.2, 20.5)), with a shallower notch and slightly longer wings. The tip's
// curve is symmetric, so its middle, the farthest point the arrow reaches,
// is (3, 2): tests/ux/cursor.test.mjs pins it on the click point.
const ARROW_PATH = "M4.54 2.37 L16.91 9.84 Q19.99 11.70 16.47 12.41 L13.44 13.02 Q11.09 13.49 9.84 15.54 L8.21 18.22 Q6.34 21.29 5.64 17.76 L2.82 3.58 Q2.32 1.03 4.54 2.37Z";
// The glow's color when the pref is unset or isn't a color: the reference's
// blue. zenius's purple is #7c4dff.
const DEFAULT_GLOW = "#3d8bff";
const GLOW_PREF = "zenius.ux.cursor.glowColor";
const EASING = "cubic-bezier(0.3, 0, 0.2, 1)";
const APPEAR_MS = 140;
const IDLE_AFTER_MS = 5000;
const MAX_LABEL = 120;
const CLICK_KINDS = new Set(["click", "dblclick", "down"]);
export const CURSOR_KINDS = new Set([
  "move",
  "hover",
  "click",
  "dblclick",
  "down",
  "up",
  "drag",
  "drop",
  "wheel",
  "type",
  "focus",
  "select",
]);

/**
 * @typedef {object} CursorOptions
 * @property {string} [label]  short action text for the pill; "" clears it,
 *   undefined keeps the current one
 * @property {string} [kind]  one of CURSOR_KINDS; click, dblclick and down
 *   add a ripple
 *
 * @typedef {object} CursorResult
 * @property {boolean} visible  someone could see the tab when it was called
 * @property {boolean} animated  a move animation ran (and has ended)
 * @property {number} ms  time spent inside move()
 */

/** Per-tab state. x and y are top-level viewport CSS px of the content. */
class CursorState {
  /** @type {number|null} */ x = null;
  /** @type {number|null} */ y = null;
  label = "";
  kind = "move";
  /** Last rendered position in chrome px, or null if never rendered. */
  /** @type {number|null} */ rx = null;
  /** @type {number|null} */ ry = null;
  stale = false;
  /** @type {Element|null} */ layer = null;
  /** @type {Element|null} */ cursor = null;
  /** @type {Element|null} */ labelEl = null;
  /** @type {Animation|null} */ anim = null;
  idleTimer = 0;
  /** Hidden while the user has control; point and label are kept. */
  hidden = false;
}

/** @type {WeakMap<Element, CursorState>} keyed by tab */
const states = new WeakMap();
/** Tabs with a cursor, so a tab switch can bring them up to date. */
/** @type {Set<Element>} */
const live = new Set();
/** @type {WeakSet<Window>} */
const watched = new WeakSet();

const prefs = {
  get animate() {
    return Services.prefs.getBoolPref("zenius.ux.cursor.animate", true);
  },
  get durationScale() {
    const v = Services.prefs.getIntPref("zenius.ux.cursor.durationPercent", 100);
    return Math.max(0, v) / 100;
  },
};

/** The last glow pref read and the color it gave, so a render checks it once. */
let glowSeen = { raw: null, color: DEFAULT_GLOW };

/**
 * The glow's color from GLOW_PREF, as `win`'s CSS parses it. A value that
 * isn't a plain color (or refers to a variable, whose value the pref can't
 * vouch for) gives the default, so a bad pref never leaves the cursor
 * without its glow.
 *
 * @param {Window} win
 */
function glowColor(win) {
  const raw = Services.prefs.getStringPref(GLOW_PREF, "").trim();
  if (raw !== glowSeen.raw) {
    let ok = false;
    try {
      ok = !!raw && !/\b(var|env|attr)\s*\(/i.test(raw) && win.CSS.supports("color", raw);
    } catch {}
    glowSeen = { raw, color: ok ? raw : DEFAULT_GLOW };
  }
  return glowSeen.color;
}

export const stats = {
  moves: 0,
  hidden: 0,
  animated: 0,
  interrupted: 0,
  /** Total time spent in move() calls on hidden tabs, ms. */
  hiddenMs: 0,
  reset() {
    this.moves = this.hidden = this.animated = this.interrupted = 0;
    this.hiddenMs = 0;
  },
};

/** @type {((tab: Element) => boolean)|null} */
let mayDraw = null;

/**
 * Install the check that keeps the agent's cursor off a Space the user
 * controls. The UI controller sets it; without one, every managed tab may
 * show the cursor.
 *
 * @param {((tab: Element) => boolean)|null} fn  false: draw nothing
 */
export function setCursorPolicy(fn) {
  mayDraw = fn;
}

/**
 * Move `tab`'s agent cursor to `point` and show `opts.label` beside it.
 *
 * Resolves when the move animation ends, or at once when nobody can see the
 * tab. Never rejects for display problems: the cursor is a hint, and must not
 * fail the action it illustrates. It doesn't wait for the agent's turn
 * either: the caller passes the control gate after it (SPI "UI hooks"),
 * because the user watching may click during the flight. While the user
 * controls the Space it draws nothing and forgets the tab's cursor.
 *
 * @param {Element} tab  a tabbrowser tab
 * @param {{x: number, y: number}} point  top-level viewport CSS px
 * @param {CursorOptions} [opts]
 * @returns {Promise<CursorResult>}
 */
export async function moveCursor(tab, point, opts = {}) {
  const t0 = ChromeUtils.now();
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError("moveCursor: point needs finite x and y");
  }
  stats.moves++;
  if (mayDraw && !mayDraw(tab)) {
    hideCursor(tab);
    return { visible: false, animated: false, ms: ChromeUtils.now() - t0 };
  }
  let st = states.get(tab);
  if (!st) {
    st = new CursorState();
    states.set(tab, st);
    live.add(tab);
    watchWindow(tab.ownerDocument.defaultView);
  }
  st.hidden = false;
  st.x = x;
  st.y = y;
  st.kind = opts.kind ?? "move";
  if (opts.label !== undefined) {
    st.label = String(opts.label ?? "").slice(0, MAX_LABEL);
  }
  // The page the agent acts on is the one to show when the user opens the
  // Space.
  notePage(tab);

  if (!isTabVisible(tab)) {
    st.stale = true;
    const ms = ChromeUtils.now() - t0;
    stats.hidden++;
    stats.hiddenMs += ms;
    return { visible: false, animated: false, ms };
  }

  let animated = false;
  try {
    animated = await render(tab, st, { animate: prefs.animate && !reducedMotion(tab) });
  } catch (e) {
    console.error("[zenius] cursor render failed", e);
  }
  return { visible: true, animated, ms: ChromeUtils.now() - t0 };
}

/**
 * Take `tab`'s cursor off the page while the user has control. Its point
 * and label are kept, so showCursor() can put it back when control returns.
 *
 * @param {Element} tab
 */
export function hideCursor(tab) {
  const st = states.get(tab);
  if (!st) {
    return;
  }
  removeLayer(st);
  st.hidden = true;
}

/**
 * Put back a cursor hideCursor() took away, at its last point and with its
 * label. On a tab nobody sees, it shows when the tab does.
 *
 * @param {Element} tab
 */
export function showCursor(tab) {
  const st = states.get(tab);
  if (!st?.hidden) {
    return;
  }
  st.hidden = false;
  st.stale = true;
  if (isTabVisible(tab)) {
    render(tab, st, { animate: prefs.animate && !reducedMotion(tab) }).catch(e =>
      console.error("[zenius] cursor show failed", e)
    );
  }
}

/**
 * The page moved to another window's copy of its tab (window sync,
 * zen-core's pageMoved): its cursor goes with it, at the same point and
 * with its label, hidden still if the user has control. It's drawn on the
 * new copy at once if a window shows it, else when one does.
 *
 * @param {Element} from
 * @param {Element} to
 */
export function moveCursorTab(from, to) {
  const st = states.get(from);
  if (!st || !to || from === to) {
    return;
  }
  removeLayer(st);
  states.delete(from);
  live.delete(from);
  forgetCursor(to);
  states.set(to, st);
  live.add(to);
  watchWindow(to.ownerDocument.defaultView);
  st.stale = true;
  if (!st.hidden && isTabVisible(to)) {
    render(to, st, { animate: false }).catch(e => console.error("[zenius] cursor move failed", e));
  }
}

/**
 * Remove `tab`'s cursor for good: the task ended or the tab closed.
 *
 * @param {Element} tab
 */
export function forgetCursor(tab) {
  const st = states.get(tab);
  if (!st) {
    return;
  }
  removeLayer(st);
  states.delete(tab);
  live.delete(tab);
}

/** @param {CursorState} st */
function removeLayer(st) {
  st.anim?.cancel();
  st.anim = null;
  lazy.clearTimeout(st.idleTimer);
  st.layer?.remove();
  st.layer = st.cursor = st.labelEl = null;
  st.rx = st.ry = null;
}

/**
 * The cursor's recorded state, for tests and the status panel.
 *
 * @param {Element} tab
 */
export function cursorState(tab) {
  const st = states.get(tab);
  if (!st) {
    return null;
  }
  return {
    x: st.x,
    y: st.y,
    label: st.label,
    kind: st.kind,
    stale: st.stale,
    hidden: st.hidden,
    rendered: st.rx === null ? null : { x: st.rx, y: st.ry },
    inDom: !!st.layer?.isConnected,
    // The label fades out a few seconds after the last move.
    idle: !!st.cursor?.hasAttribute("idle"),
  };
}

/**
 * Bring visible cursors up to date without animating, after something may
 * have revealed or resized their tabs. A cursor whose label had faded shows
 * it again: the user who comes back sees what the agent was doing.
 *
 * @param {Window} [win]  limit to one window
 */
export function syncVisibleCursors(win) {
  for (const tab of live) {
    if (!tab.isConnected) {
      forgetCursor(tab);
      continue;
    }
    if (win && tab.ownerDocument.defaultView !== win) {
      continue;
    }
    const st = states.get(tab);
    if (!st || st.hidden || !isTabVisible(tab)) {
      continue;
    }
    if (st.stale || !st.layer?.isConnected) {
      render(tab, st, { animate: false }).catch(e =>
        console.error("[zenius] cursor sync failed", e)
      );
    } else if (st.cursor?.hasAttribute("idle")) {
      st.cursor.removeAttribute("idle");
      scheduleIdle(st);
    }
  }
}

/**
 * @param {Element} tab
 * @param {CursorState} st
 * @param {{animate: boolean}} options
 * @returns {Promise<boolean>} whether an animation ran to its end
 */
async function render(tab, st, { animate }) {
  const browser = tab.linkedBrowser;
  const win = browser.ownerDocument.defaultView;
  ensureStyles(win);
  ensureLayer(st, browser);
  const { layer, cursor, labelEl } = st;
  // In forced colors the sheet sets a system color instead of this.
  const glow = glowColor(win);
  if (layer.style.getPropertyValue("--zenius-cursor-glow-pref") !== glow) {
    layer.style.setProperty("--zenius-cursor-glow-pref", glow);
  }

  // Content CSS px to chrome CSS px. fullZoom covers Ctrl+/- page zoom.
  const zoom = browser.fullZoom || 1;
  const maxX = Math.max(0, layer.clientWidth - 1);
  const maxY = Math.max(0, layer.clientHeight - 1);
  const tx = Math.min(Math.max(st.x * zoom, 0), maxX);
  const ty = Math.min(Math.max(st.y * zoom, 0), maxY);
  const to = `translate(${tx}px, ${ty}px)`;

  let from = null;
  if (st.anim?.playState === "running") {
    // Start from wherever the interrupted move had got to.
    from = win.getComputedStyle(cursor).transform;
    st.anim.cancel();
    stats.interrupted++;
  } else if (st.rx !== null && !st.stale) {
    from = cursor.style.transform;
  }
  const dist = st.rx === null ? 0 : Math.hypot(tx - st.rx, ty - st.ry);
  const firstShow = st.rx === null || !cursor.style.transform;

  cursor.style.transform = to;
  cursor.removeAttribute("idle");
  if (labelEl.textContent !== st.label) {
    labelEl.textContent = st.label;
  }
  st.rx = tx;
  st.ry = ty;
  st.stale = false;
  scheduleIdle(st);

  if (!animate) {
    // Even without motion, show that a click happened: the ring then fades
    // in place instead of growing.
    if (CLICK_KINDS.has(st.kind) && reducedMotion(tab)) {
      ripple(cursor, st.kind, { still: true });
    }
    return false;
  }
  const scale = prefs.durationScale;
  /** @type {Animation|null} */
  let anim = null;
  let duration = 0;
  if (firstShow) {
    duration = APPEAR_MS * scale;
    anim = cursor.animate(
      [
        { opacity: 0, transform: `${to} scale(0.5)` },
        { opacity: 1, transform: to },
      ],
      { duration, easing: "ease-out" }
    );
  } else if (from && dist >= 2) {
    duration = moveDuration(dist) * scale;
    anim = cursor.animate([{ transform: from }, { transform: to }], {
      duration,
      easing: EASING,
    });
  }
  if (!anim || duration <= 0) {
    anim?.cancel();
    if (CLICK_KINDS.has(st.kind)) {
      ripple(cursor, st.kind);
    }
    return false;
  }
  st.anim = anim;
  // A hidden or throttled window can delay `finished`; never wait much
  // longer than the animation itself.
  const ended = await Promise.race([
    anim.finished.then(
      () => true,
      () => false
    ),
    new Promise(resolve => lazy.setTimeout(() => resolve(false), duration + 120)),
  ]);
  if (st.anim === anim) {
    st.anim = null;
  }
  if (ended) {
    stats.animated++;
    if (CLICK_KINDS.has(st.kind)) {
      ripple(cursor, st.kind);
    }
  }
  return ended;
}

/** The user asked the OS (or ui.prefersReducedMotion) for less motion. */
function reducedMotion(tab) {
  try {
    return tab.ownerDocument.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Longer moves take longer, within limits that keep actions brisk. */
function moveDuration(dist) {
  return Math.min(380, Math.max(120, 110 + dist * 0.28));
}

function ripple(cursor, kind, { still = false } = {}) {
  const doc = cursor.ownerDocument;
  const count = kind === "dblclick" ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const ring = doc.createElementNS(XHTML_NS, "div");
    ring.className = "zenius-cursor-ripple";
    cursor.prepend(ring);
    const frames = still
      ? [{ opacity: 0.9 }, { opacity: 0 }]
      : [
          { transform: "scale(0.3)", opacity: 0.9 },
          { transform: "scale(1.5)", opacity: 0 },
        ];
    const a = ring.animate(frames, { duration: 420, delay: i * 140, easing: "ease-out", fill: "both" });
    a.finished.then(
      () => ring.remove(),
      () => ring.remove()
    );
  }
}

function scheduleIdle(st) {
  lazy.clearTimeout(st.idleTimer);
  st.idleTimer = lazy.setTimeout(() => {
    st.cursor?.setAttribute("idle", "true");
  }, IDLE_AFTER_MS);
}

/**
 * @param {CursorState} st
 * @param {Element} browser
 */
function ensureLayer(st, browser) {
  const stack = browser.parentElement;
  if (st.layer?.parentNode === stack) {
    return;
  }
  // First use, or the tab's browser moved (tab dragged to another window).
  st.layer?.remove();
  st.rx = st.ry = null;
  const doc = browser.ownerDocument;
  const layer = doc.createElementNS(XHTML_NS, "div");
  layer.className = "zenius-cursor-layer";
  layer.setAttribute("aria-hidden", "true");
  const cursor = doc.createElementNS(XHTML_NS, "div");
  cursor.className = "zenius-cursor";
  const glow = doc.createElementNS(XHTML_NS, "div");
  glow.className = "zenius-cursor-glow";
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "zenius-cursor-arrow");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ARROW_PATH);
  svg.append(path);
  const labelEl = doc.createElementNS(XHTML_NS, "span");
  labelEl.className = "zenius-cursor-label";
  cursor.append(glow, svg, labelEl);
  layer.append(cursor);
  stack.append(layer);
  Object.assign(st, { layer, cursor, labelEl });
}

/** @param {Window} win */
function watchWindow(win) {
  if (watched.has(win)) {
    return;
  }
  watched.add(win);
  const sync = () => syncVisibleCursors(win);
  // TabSelect fires before the tab switcher shows the new panel, so it is
  // too early on its own; TabSwitchDone comes once the panel is on screen.
  // A Space switch selects a tab, so it ends in both as well.
  win.addEventListener("TabSelect", sync);
  win.addEventListener("TabSwitchDone", sync, true);
  win.addEventListener("ZenViewSplitter:SplitViewActivated", sync);
  win.document.addEventListener("visibilitychange", sync);
  win.addEventListener("FullZoomChange", e => {
    const tab = win.gBrowser?.getTabForBrowser(e.target);
    const st = tab && states.get(tab);
    if (st && isTabVisible(tab)) {
      render(tab, st, { animate: false }).catch(() => {});
    }
  });
  win.addEventListener("TabClose", e => forgetCursor(e.target));
  win.addEventListener(
    "unload",
    () => {
      for (const tab of live) {
        if (tab.ownerDocument.defaultView === win) {
          forgetCursor(tab);
        }
      }
    },
    { once: true }
  );
}
