// The view keeper (SPEC §3.5, "A still view"). An agent change to a tab
// strip (a tab added, moved or closed) must leave what each window shows of
// its strip where it was. Zen's strip gets no help from scroll anchoring:
// even a plain element inserted above the view moved the tabs below it
// (probed 2026-11-20). So keepView() notes where a tab in view sits before
// the change and scrolls the strip back by however far it moved.
//
// A strip scrolls only as far as its content allows. In a strip shorter
// than its box (stripCanScroll() is false), or near its top, a change above
// the shown tab still moves it.
//
// This module is a leaf: zen-core's tab code imports it.

/** @param {Window} win */
function workspaceElementOf(win) {
  const zw = win.gZenWorkspaces;
  return zw?.workspaceElement?.(zw.activeWorkspace) ?? null;
}

/**
 * The scrolling box of the tab strip the window shows: its active Space's.
 *
 * @param {Window} win
 * @returns {Element|null}
 */
export function stripOf(win) {
  const ws = workspaceElementOf(win);
  return ws?.scrollbox?.scrollbox ?? ws?.scrollbox ?? null;
}

/**
 * Whether the window's strip is taller than its box, so keepView can scroll
 * it back after a change above the shown tab.
 *
 * @param {Window} win
 */
export function stripCanScroll(win) {
  const sb = stripOf(win);
  return !!sb && sb.scrollHeight - sb.clientHeight >= 1;
}

function* browserWindows() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (!win.closed && win.gBrowser && win.gZenWorkspaces) {
      yield win;
    }
  }
}

/**
 * Tabs to hold still, best first: the selected tab if it's in view, then
 * the strip's tabs in view from the top. After a change the first of them
 * still in the strip decides: a closed tab gives way to the next.
 *
 * @returns {Element[]}
 */
function anchorsOf(win, wsEl, sb) {
  const box = sb.getBoundingClientRect();
  const inView = r => r.height > 0 && r.bottom > box.top && r.top < box.bottom;
  const anchors = [];
  const selected = win.gBrowser.selectedTab;
  if (selected && wsEl.contains(selected) && inView(selected.getBoundingClientRect())) {
    anchors.push(selected);
  }
  const visible = [];
  for (const tab of wsEl.querySelectorAll(".tabbrowser-tab")) {
    const r = tab.getBoundingClientRect();
    if (inView(r)) {
      visible.push({ tab, top: r.top });
    }
  }
  visible.sort((a, b) => a.top - b.top);
  for (const { tab } of visible) {
    if (tab !== selected) {
      anchors.push(tab);
    }
  }
  return anchors;
}

function mark(win) {
  const wsEl = workspaceElementOf(win);
  const sb = stripOf(win);
  if (!wsEl || !sb) {
    return null;
  }
  const anchors = anchorsOf(win, wsEl, sb).map(tab => ({ tab, y: tab.getBoundingClientRect().top }));
  return anchors.length ? { win, wsEl, sb, ws: win.gZenWorkspaces.activeWorkspace, anchors } : null;
}

function restore(m) {
  if (m.win.closed || m.win.gZenWorkspaces.activeWorkspace !== m.ws || stripOf(m.win) !== m.sb) {
    // The window shows something else now: nothing of the old view to keep.
    return;
  }
  const anchor = m.anchors.find(a => a.tab.isConnected && m.wsEl.contains(a.tab));
  if (!anchor) {
    return;
  }
  const dy = anchor.tab.getBoundingClientRect().top - anchor.y;
  if (Math.abs(dy) >= 0.5) {
    // Instant: the strip's scrollbox scrolls smoothly by default
    // (arrowscrollbox's smoothscroll), and a slide would show the change.
    m.sb.scrollBy({ top: dy, behavior: "instant" });
  }
}

/**
 * Run `fn`, an agent change to tab strips, and keep each window's view of
 * its strip where it was. `fn` may return a promise; the view is put back
 * once it settles, and also when `fn` throws.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function keepView(fn) {
  const marks = [];
  for (const win of browserWindows()) {
    try {
      const m = mark(win);
      if (m) {
        marks.push(m);
      }
    } catch (e) {
      console.error("[zenius] keepView couldn't note a window's view", e);
    }
  }
  const putBack = () => {
    for (const m of marks) {
      try {
        restore(m);
      } catch (e) {
        console.error("[zenius] keepView couldn't put a window's view back", e);
      }
    }
  };
  let result;
  try {
    result = fn();
  } catch (e) {
    putBack();
    throw e;
  }
  if (result && typeof result.then === "function") {
    return result.then(
      value => {
        putBack();
        return value;
      },
      e => {
        putBack();
        throw e;
      }
    );
  }
  putBack();
  return result;
}
