// Mouse input state that Gecko shares between the tabs of a content process
// (zen-input; zen-snapshot's audit, docs/research/process-input-state.md,
// items 2, 3 and 4).
//
// - Mouse capture is per process, and the parent keeps one pointer capture
//   per pointer, across processes. While zenius held a press in a hidden
//   agent page, the user's moves and clicks in their own tab went there (a
//   raw mouse.down, the selection drag it starts, a slider that captures the
//   pointer, the instant of a click). While the user, or another task, held
//   a press, zenius's events went to that tab instead of the agent's.
// - IMEStateManager is per process: any mouse button event zenius sends in
//   the process commits the composition the user has open in another tab
//   (docs/research/ime-commit.md).
// - The mouse's last point is per process (item 5): a move's movementX/Y
//   counts from the process's last move (EventStateManager's
//   sLastRefPoint), whatever tab it was in. The agent's first move in a tab
//   counted from the user's pointer in another, which its page could read,
//   and the user's next move counted from the agent's.
// - So is the pointer's (item 5b): after a reflow, Gecko re-hit-tests a page
//   the pointer is in, and puts its pointerover/out and :hover at the
//   process's last pointer point (dom.event.pointer.boundary.
//   dispatch_when_layout_change). After an agent's move, a reflow in the
//   user's page moved their :hover to the agent's point, where a hover menu
//   could open (I1), and after the user's move, a reflow in the agent's page
//   did so at the user's point, which the agent could read.
//
// So the guard's capture listeners run first at every tab's chrome event
// handler, in each web process where a task page lives (the parent arms the
// process, input/capture.sys.mjs; I4: none anywhere else), and drop what
// came to the wrong tab; Event.isSynthesized tells zenius's events (true) from the
// user's (false). And zenius sends no press or release while the user
// composes in another tab, or while a press is held in another tab: it
// waits until its action's deadline, and a release it owes waits as long as
// it takes. It never commits or cancels the user's word.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { disarmTyping, receiveReplay, setArmedRoots, setZeniusInputTest, syncTypingRoot } from "chrome://userscripts/content/zenius/content/typing.sys.mjs";
import { installContentPicker, uninstallContentPicker } from "chrome://userscripts/content/zenius/content/filepicker.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const POLL_MS = 50;
const MOZ_SOURCE_MOUSE = 1;

/** The tab a zenius input event is for, while Gecko dispatches it. */
let dispatching = null;

/**
 * Dispatch a zenius input event in `win`: a mouse or wheel event, and also
 * its keys, text, pastes, drag events and a fill's or a select's events,
 * which no capture redirects: content/typing.sys.mjs tells them from the
 * user's by this mark.
 *
 * @param {Window} win
 * @param {() => void} send
 * @param {"anchor"|"park"} [mode] an anchor only sets the process's last
 *   point, and its page hears no move of it; a park's page hears nothing
 * @returns {boolean} false when a capture in another tab took the event, and that tab dropped it
 */
export function dispatchIn(win, send, mode = null) {
  const outer = dispatching;
  const d = (dispatching = { root: win.docShell?.chromeEventHandler ?? null, taken: false, mode });
  try {
    send();
  } finally {
    dispatching = outer;
  }
  return !d.taken;
}

/** Process-top window → the press zenius holds there: {win, doc, x, y, button, mods}. */
const presses = new Map();
/** Process-top window → zenius input calls running there. */
const calls = new WeakMap();
/** Process-top window → the release zenius put off there: {win, release}. */
const deferred = new Map();
/**
 * The primary-button press the user holds in this process: {root, last},
 * the tab's chrome event handler (weakly) and when the user's mouse last
 * did anything here. Only that button starts a capture (a selection drag,
 * a scrollbar or slider drag): a right press's release goes to its context
 * menu, unseen here.
 */
let userPress = null;
// A press whose release went where this process can't see it stops
// counting once the user's mouse has been quiet here this long. Until then
// no zenius mouse event goes out, since even dropped in the user's tab a
// move would step their drag (zen-snapshot saw 5 s let one out).
const USER_PRESS_STALE_MS = 30000;
/** Process-top windows whose press the guard ended inside the user's current event. */
const ending = new Set();

let releaser = null;
let polling = false;

function alive(win) {
  try {
    return !Cu.isDeadWrapper(win) && !win.closed;
  } catch {
    return false;
  }
}

/** Record the press zenius holds in a tab, or null once it's released. */
export function notePress(top, press) {
  if (press) {
    presses.set(top, { ...press, doc: press.win.document });
  } else {
    presses.delete(top);
  }
}

export function enterCall(top) {
  calls.set(top, (calls.get(top) ?? 0) + 1);
}

export function leaveCall(top) {
  const n = Math.max(0, (calls.get(top) ?? 1) - 1);
  calls.set(top, n);
  if (!n) {
    park(top);
  }
}

/** How a held press ends unseen by its page (content/actions.sys.mjs sets it). */
export function setReleaser(fn) {
  releaser = fn;
}

function processTop(win) {
  let w = win;
  for (let parent = w.browsingContext?.parent; parent?.docShell; parent = w.browsingContext?.parent) {
    w = parent.docShell.domWindow;
  }
  return w;
}

// ---------------------------------------------------------------- the last point

/** Process-top window → zenius's last move there: {win, doc, x, y}, weakly. */
let lastMoves = new WeakMap();
/** The process-top window where zenius made the process's last move; null once the user's mouse moved. */
let lastMover = null;
/** zenius moved since the user's mouse last did, in this process. */
let userMoveStale = false;
/** Hiding the rest of the user's move, until this task ends. */
let hidingUserMove = false;

/**
 * Dispatch zenius's mouse event at (x, y) in `win`. A move counts from
 * zenius's own last point in that tab.
 *
 * @param {Window} win
 * @param {string} type
 * @param {number} x
 * @param {number} y
 * @param {(w: Window, type: string, x: number, y: number, buttons?: number) => void} send
 *   dispatches one mouse event of `type` at (x, y) in `w`, with these buttons if given
 * @returns {boolean} as dispatchIn
 */
export function dispatchPointer(win, type, x, y, send) {
  const top = processTop(win);
  // A release goes where the press left the pointer, which never parked.
  if (type !== "mouseup" && lastMover !== top && (type === "mousemove" || !presses.has(top))) {
    // First a move at zenius's last point in this tab, which sets the
    // process's last point to the agent's own, and brings a parked pointer
    // back in. No page hears the move, and the hover stays: the agent's
    // pointer is already there. A tab's first event is anchored at its own
    // point instead, so a first move counts 0, and the page hears that
    // point's hover change from the anchor, in the same order as from the
    // move.
    const last = lastMoves.get(top);
    const w = last?.win.deref();
    const buttons = type === "mousemove" ? undefined : 0;
    try {
      if (w && alive(w) && w.document === last.doc.deref()) {
        dispatchIn(w, () => send(w, "mousemove", last.x, last.y, buttons), "anchor");
      } else {
        dispatchIn(win, () => send(win, "mousemove", x, y, buttons), "anchor");
      }
      lastMover = top;
      userMoveStale = true;
    } catch (e) {
      // Without it a move only counts from another point.
      console.error("[zenius] anchor move failed", e);
    }
  }
  const sent = dispatchIn(win, () => send(win, type, x, y));
  lastMoves.set(top, { win: new WeakRef(win), doc: new WeakRef(win.document), x, y });
  unparked.add(top);
  if (type === "mousemove") {
    // One that a capture took went to another tab, whose point is then the last.
    lastMover = sent ? top : null;
    userMoveStale = true;
  }
  if (!(calls.get(top) > 0)) {
    // Outside an input call (a release that waited): once this dispatch is over.
    Services.tm.dispatchToMainThread(() => park(top));
  }
  return sent;
}

// ---------------------------------------------------------------- parking

/** Process-top windows that zenius's pointer is in, for Gecko, since its last input there. */
const unparked = new Set();

/**
 * zenius's pointer leaves its tab, as a real one leaves the window, and the
 * page's hover goes back to where the agent left it. Gecko then re-hit-tests
 * neither page with the agent's point (5b): the agent's page has no pointer
 * in it, and the process's pointer point is nobody's. Its next move counts
 * from nothing. The page hears none of it. A widget-synthesized move puts
 * the hover back without making its point the process's again. Not while
 * zenius holds a button there (the drag would end), or a dialog is open (the
 * call that answers it parks it).
 */
function park(top) {
  if (!unparked.has(top) || calls.get(top) > 0 || presses.has(top)) {
    return;
  }
  const last = lastMoves.get(top);
  const w = last?.win.deref();
  const same = !!w && alive(w) && w.document === last.doc.deref();
  // A document that replaced the agent's has no hover of the agent's to keep.
  const at = same ? w : alive(top) ? top : null;
  if (!at) {
    unparked.delete(top);
    return;
  }
  try {
    if (at.windowUtils.isInModalState()) {
      return;
    }
    unparked.delete(top);
    const data = { identifier: at.windowUtils.DEFAULT_MOUSE_POINTER_ID, button: 0, buttons: 0, clickCount: 0, modifiers: 0, inputSource: MOZ_SOURCE_MOUSE };
    const send = (type, widget) =>
      at.synthesizeMouseEvent(type, same ? last.x : 0, same ? last.y : 0, data, {
        isDOMEventSynthesized: true,
        isWidgetEventSynthesized: widget,
        isAsyncEnabled: false,
      });
    // "mousecancel" is the puppet widget's exit, which ESM counts as the
    // pointer leaving the window.
    dispatchIn(at, () => send("mousecancel", false), "park");
    if (same) {
      dispatchIn(at, () => send("mousemove", true), "park");
    }
  } catch (e) {
    console.error("[zenius] parking the pointer failed", e);
  }
  lastMover = null;
  userMoveStale = false;
}

/**
 * The user's move counts from the process's last point, which is zenius's
 * if zenius moved since. Such a move is hidden from the page. Gecko still
 * handles it, so the user's next move counts from their own point.
 */
function followUserMove(e) {
  if (e.type !== "pointerrawupdate") {
    lastMover = null;
  }
  if (!userMoveStale && !hidingUserMove) {
    return;
  }
  e.stopImmediatePropagation();
  // A move's pointerrawupdate may come in a task of its own; its pointermove
  // and mousemove then come in one task.
  if (e.type !== "pointerrawupdate" && userMoveStale) {
    userMoveStale = false;
    hidingUserMove = true;
    Services.tm.dispatchToMainThread(() => {
      hidingUserMove = false;
    });
  }
}

// ---------------------------------------------------------------- what blocks a press

/** The field outside `win`'s tab where the user is composing text, in this process. */
export function compositionElsewhere(win) {
  let el = null;
  try {
    el = Services.focus.focusedElement;
  } catch {}
  if (!el) {
    return null;
  }
  try {
    // Gecko 160 has no Node.ownerGlobal.
    const where = el.ownerDocument?.defaultView;
    if (!where || where.browsingContext?.top === win.browsingContext?.top) {
      return null;
    }
    return editorOf(el, where)?.composing ? el : null;
  } catch {
    return null;
  }
}

function editorOf(el, where) {
  if (el.editor) {
    return el.editor;
  }
  // contenteditable and designMode compose in the document's HTML editor.
  try {
    return where.docShell?.editingSession?.getEditorForWindow(where) ?? null;
  } catch {
    return null;
  }
}

/** Whether a press is held in another tab of this process: the user's, or another task's. */
export function pressElsewhere(win) {
  const root = win.docShell?.chromeEventHandler ?? null;
  const user = userPress && Date.now() - userPress.last < USER_PRESS_STALE_MS ? userPress.root.deref() : null;
  if (user && user !== root) {
    return true;
  }
  if (!user) {
    userPress = null;
  }
  const top = processTop(win);
  for (const [t, p] of presses) {
    if (!alive(t) || !alive(p.win) || p.win.document !== p.doc) {
      // Its tab closed, or navigated: Gecko let the press go with the document.
      presses.delete(t);
    } else if (t !== top) {
      return true;
    }
  }
  return false;
}

/**
 * Gecko's press on selectable content captures the mouse for the whole
 * content process: nsIFrame::HandlePress captures the nearest scroll
 * container, so that a selection drag scrolls it past its edges. While an
 * agent's press held that capture, or for the moment of an agent's click on
 * text, the user's next press or release in another tab of the process went
 * to the agent's page, where the guard dropped it: the user's click was
 * lost, or their page kept a press with no release (input-gaps.md F8). So
 * zenius drops that capture as soon as its press is handled. Its selection
 * drag goes on without it (nsIFrame::HandleDrag needs none), as zenius moves
 * within its page. A press on a scrollbar, a range input or a list box keeps
 * its capture, which its drag needs, and a page's pointer capture stays: the
 * guard (guardEvent) still covers those.
 */
export function pressWithoutCapture(win, send) {
  const root = processTop(win)?.docShell?.chromeEventHandler;
  let target = null;
  const seen = e => {
    target ??= e.originalTarget;
  };
  // System group: it runs after the page's listeners, at the press's own target.
  root?.addEventListener("mousedown", seen, { capture: true, mozSystemGroup: true });
  try {
    return send();
  } finally {
    root?.removeEventListener("mousedown", seen, { capture: true, mozSystemGroup: true });
    if (target && !dragNeedsCapture(target)) {
      try {
        win.document.releaseCapture();
      } catch (e) {
        console.error("zenius: couldn't drop the mouse capture of the agent's press", e);
      }
    }
  }
}

/** The parts whose press drags through Gecko's mouse capture. */
const CAPTURING_PARTS = new Set(["scrollbar", "scrollbarbutton", "slider", "thumb", "scrollcorner", "resizer", "select"]);

function dragNeedsCapture(node) {
  for (let n = node; n; n = n.flattenedTreeParentNode ?? n.parentNode ?? null) {
    if (n.nodeType === 1 && (CAPTURING_PARTS.has(n.localName) || (n.localName === "input" && n.type === "range"))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- the user's wheel

/**
 * Gecko keeps one wheel transaction per content process: until it times out
 * (mousewheel.transaction.timeout), every wheel event of the process goes to
 * the frame that started it, whichever tab the event was for. So a user's
 * wheel (a trackpad's momentum tail too) that came during an agent's motion
 * went to the agent's page, and an agent's wheel during the user's scroll
 * went to theirs (input-gaps.md F7). zenius ends its own transaction after
 * each wheel event it sends (content/actions.sys.mjs), and waits while the
 * user scrolls.
 */

/** When the user's last wheel event reached a tab of this process (epoch ms). */
let userWheelAt = 0;
/** A transaction of zenius's that no move could end (its tab holds a button): {root, until}. */
let liveAgentWheel = null;
/** The user's wheel gesture, momentum included, is over once it has been quiet this long. */
const USER_WHEEL_QUIET_MS = 250;

/** How long a wheel transaction outlives its last event, plus a margin. */
export function wheelTransactionMs() {
  return Services.prefs.getIntPref("mousewheel.transaction.timeout", 1500) + 100;
}

/** Whether the user's wheel reached a tab of this process within the last `ms`. */
export function userWheelWithin(ms) {
  return Date.now() - userWheelAt < ms;
}

/**
 * After zenius's wheel event in `win`: `ended` says whether its transaction
 * was ended at once. One that wasn't takes every wheel of the process until
 * it times out, and the guard keeps the user's from this page meanwhile.
 */
export function noteAgentWheel(win, ended) {
  const root = ended ? null : processTop(win)?.docShell?.chromeEventHandler;
  liveAgentWheel = root ? { root: new WeakRef(root), until: Date.now() + wheelTransactionMs() } : null;
}

/** Wait while the user scrolls in a tab of this process, until `deadline` (epoch ms). */
export async function untilWheelFree(deadline) {
  for (;;) {
    const quiet = Date.now() - userWheelAt;
    if (quiet >= USER_WHEEL_QUIET_MS) {
      return;
    }
    const left = deadline - Date.now();
    if (!(left > 0)) {
      throw blockedError("user_scrolling", "wheel");
    }
    await new Promise(resolve => lazy.setTimeout(resolve, Math.min(POLL_MS, left, USER_WHEEL_QUIET_MS - quiet)));
  }
}

function followUserWheel(root, e) {
  userWheelAt = Date.now();
  const live = liveAgentWheel;
  if (live && Date.now() < live.until && live.root.deref() === root) {
    // zenius's transaction in this tab took the user's wheel from their own: never this page's.
    drop(e);
  }
}

/**
 * What keeps zenius from sending a mouse button event in `win` now: the
 * user composing text in another tab of the process (the event would commit
 * their word), or a press held in another tab (the event would go there).
 *
 * @returns {"user_composing"|"mouse_held_elsewhere"|null}
 */
export function blocker(win) {
  if (compositionElsewhere(win)) {
    return "user_composing";
  }
  return pressElsewhere(win) ? "mouse_held_elsewhere" : null;
}

const WHY = {
  user_composing: what =>
    `the user is composing text in another tab of the browser, and a mouse ${what} would commit their word; retry once they finish`,
  mouse_held_elsewhere: what =>
    `the mouse is held down in another tab of the browser (a drag or a text selection there), which would take this mouse ${what}; retry once it's released`,
  user_scrolling: what =>
    `the user is scrolling in another tab of the browser, and a ${what} sent now would reach their page; retry once they stop`,
};

/** The transient error for a mouse event that `why` holds back. */
export function blockedError(why, what) {
  return new ZenError("ZEN_TIMEOUT", WHY[why](what), { reason: why, transient: true });
}

/**
 * Wait until zenius may send a mouse button event (`what`: "press",
 * "release", "move") in `win`, until `deadline` (epoch ms). A release put
 * off in this tab goes out first.
 */
export async function untilFree(win, deadline, what = "press") {
  for (;;) {
    const why = what === "move" ? (pressElsewhere(win) ? "mouse_held_elsewhere" : null) : blocker(win);
    if (!why) {
      if (what !== "move") {
        flushDeferred(processTop(win));
      }
      return;
    }
    const left = deadline - Date.now();
    if (!(left > 0)) {
      throw blockedError(why, what);
    }
    await new Promise(resolve => lazy.setTimeout(resolve, Math.min(POLL_MS, left)));
  }
}

/** Send `release` now if nothing blocks it in `win`, or as soon as nothing does. */
export function releaseWhenFree(win, release) {
  if (!blocker(win)) {
    release();
    return;
  }
  deferred.set(processTop(win), { win, release });
  if (!polling) {
    polling = true;
    lazy.setTimeout(pollDeferred, POLL_MS);
  }
}

function flushDeferred(top) {
  const d = deferred.get(top);
  if (d) {
    deferred.delete(top);
    try {
      d.release();
    } catch {}
  }
}

function pollDeferred() {
  for (const [top, d] of deferred) {
    if (!alive(d.win)) {
      deferred.delete(top);
    } else if (!blocker(d.win)) {
      flushDeferred(top);
    }
  }
  polling = deferred.size > 0;
  if (polling) {
    lazy.setTimeout(pollDeferred, POLL_MS);
  }
}

// ---------------------------------------------------------------- the guard

// The user's input, not a hover change that follows it, ends the press.
const ENDS_PRESS = new Set(["mousemove", "mousedown", "mouseup", "pointermove", "pointerdown", "pointerup", "wheel"]);
// Seen only to follow the user's press: a drag session takes the release.
const OBSERVED = new Set(["dragstart"]);
// The events that carry movementX/Y.
const MOVES = new Set(["pointerrawupdate", "pointermove", "mousemove"]);

/** The events the guard listens to: everything a mouse or pointer capture redirects. */
export const GUARDED_EVENTS = [
  "mousedown",
  "mouseup",
  "mousemove",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
  "mouseover",
  "mouseout",
  "mouseenter",
  "mouseleave",
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointerrawupdate",
  "pointerover",
  "pointerout",
  "pointerenter",
  "pointerleave",
  "wheel",
  "DOMMouseScroll",
  "MozMousePixelScroll",
  // The page's pending capture, taken at the user's first event, would tell
  // it where the user's pointer is.
  "gotpointercapture",
  ...OBSERVED,
];

function drop(e) {
  e.stopImmediatePropagation();
  if (e.cancelable) {
    e.preventDefault();
  }
}

function followUserPress(root, e) {
  if (e.type === "mousedown" && e.button === 0) {
    userPress = { root: new WeakRef(root), last: Date.now() };
  } else if (e.type === "dragstart" || (e.buttons === 0 && (e.type === "mouseup" || e.type === "mousemove" || e.type === "pointermove"))) {
    userPress = null;
  } else if (userPress) {
    userPress.last = Date.now();
  }
}

/** The window of the document an event is in. */
function windowOf(e) {
  const t = e.originalTarget ?? e.target;
  try {
    return t?.ownerDocument?.defaultView ?? t?.defaultView ?? (t?.document ? t : null);
  } catch {
    return null;
  }
}

function guardEvent(root, e) {
  if (e.isSynthesized) {
    if (dispatching?.mode && dispatching.root === root) {
      if (dispatching.mode === "park" || MOVES.has(e.type)) {
        e.stopImmediatePropagation();
      }
      return;
    }
    // zenius's event, which a press held in this tab took from the tab it was for.
    if (dispatching && dispatching.root !== root && !OBSERVED.has(e.type)) {
      drop(e);
      dispatching.taken = true;
    }
    return;
  }
  // What Gecko derives from zenius's own dispatch here (a pending capture
  // taken at its move) is zenius's, whatever its flags say.
  if (!e.isTrusted || dispatching?.root === root) {
    return;
  }
  if (e.type === "wheel") {
    if (dispatching) {
      // zenius's wheel, which a transaction of this tab took from the tab
      // it was for (the user's scroll): nothing else runs during its dispatch.
      drop(e);
      dispatching.taken = true;
      return;
    }
    followUserWheel(root, e);
  }
  followUserPress(root, e);
  if (OBSERVED.has(e.type)) {
    return;
  }
  if (MOVES.has(e.type)) {
    followUserMove(e);
  }
  const win = windowOf(e);
  const top = win && processTop(win);
  const press = top && presses.get(top);
  if (!press) {
    // The rest of the user's event whose start ended the press here.
    if (top && ending.has(top)) {
      drop(e);
    }
    return;
  }
  // The user's input in a tab where zenius holds a press: most often a
  // capture brought it from the user's own tab (agent tabs stay
  // docShell-active, SPEC §3.5, so document.hidden can't tell). It's never
  // this page's: the press ends, unseen by the page, and the user's next
  // events go where they point. If the tab is on screen, the user's input
  // there is a takeover, which the parent sees at the <browser>
  // (ui/takeover.sys.mjs). A press inside a running call (a click) ends
  // with that call.
  drop(e);
  if (!press.releasing && !(calls.get(top) > 0) && ENDS_PRESS.has(e.type) && releaser) {
    press.releasing = true;
    // Now, inside this event: Gecko's own handling of it runs whatever the
    // listeners do (nsIFrame::HandleDrag would step the press's selection
    // drag to the user's point), and must find the press over. The rest of
    // this event's dispatch here is dropped too.
    ending.add(top);
    Services.tm.dispatchToMainThread(() => ending.delete(top));
    releaser(top, press);
  }
}

// ---------------------------------------------------------------- arming

/** The tab roots in this process that have the guard's listeners. */
let guardedRoots = new WeakSet();
const rootRefs = new Set();

function onGuardEvent(e) {
  try {
    guardEvent(e.currentTarget, e);
  } catch (err) {
    console.error("[zenius] input guard failed", err);
  }
}

/** The guard's listeners on a tab's chrome event handler (the parent: a task page lives in this process). */
function armRoot(root, bc) {
  if (!root || guardedRoots.has(root)) {
    return;
  }
  // An agent tab's file chooser here says when its files reached the input
  // (content/filepicker.sys.mjs).
  installContentPicker();
  guardedRoots.add(root);
  rootRefs.add(new WeakRef(root));
  for (const type of GUARDED_EVENTS) {
    // Default group, capture: at the tab's chrome event handler this runs
    // before any listener of the page.
    root.addEventListener(type, onGuardEvent, true);
  }
  // A task's tab also gets the watch on the user's input there.
  syncTypingRoot(root, bc);
}

setZeniusInputTest(root => !!dispatching && dispatching.root === root);
setArmedRoots(() => [...rootRefs].map(ref => ref.deref()).filter(Boolean));

/** No task page lives in this process any more: no listener, and nothing of zenius's input to remember. */
function disarm() {
  disarmTyping();
  uninstallContentPicker();
  for (const ref of rootRefs) {
    const root = ref.deref();
    for (const type of root ? GUARDED_EVENTS : []) {
      root.removeEventListener(type, onGuardEvent, true);
    }
  }
  rootRefs.clear();
  guardedRoots = new WeakSet();
  presses.clear();
  deferred.clear();
  ending.clear();
  unparked.clear();
  lastMoves = new WeakMap();
  userPress = null;
  lastMover = null;
  userMoveStale = false;
  hidingUserMove = false;
}

/** For tests: whether this tab root has the guard's listeners. */
export function isArmed(root) {
  return guardedRoots.has(root);
}

export class ZeniusInputChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    if (name === "arm") {
      armRoot(this.docShell?.chromeEventHandler, this.browsingContext);
    } else if (name === "disarm") {
      disarm();
    } else if (name === "replayKeys") {
      // The keys the user typed while this clean copy loaded (input/typing.sys.mjs).
      receiveReplay(this.contentWindow, data);
    }
  }
}
