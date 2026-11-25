// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Content side of page actions (zen-input). Each export runs in one frame's
// own process, called from methods/actions.sys.mjs. Work that belongs to an
// out-of-process iframe comes back as `{forward: {bcId, args}}` (input routed
// by coordinates or focus) or `{frames: [...]}` (a selector the parent must
// also count there), and the parent continues in that process.
//
// Errors: a ZenError with data.transient is retried by the parent until the
// action's deadline, as Ego retries its transient element errors.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import * as A from "chrome://userscripts/content/zenius/content/actionability.sys.mjs";
import * as C from "chrome://userscripts/content/zenius/content/capture.sys.mjs";
import * as I from "chrome://userscripts/content/zenius/content/input.sys.mjs";
import * as R from "chrome://userscripts/content/zenius/content/resolve.sys.mjs";
import { expectOwnFolder, onChooserAnswered, onChooserOpening, openOwnChooser } from "chrome://userscripts/content/zenius/content/filepicker.sys.mjs";
import { ADDON_PAGE, whyNotWebDocument } from "chrome://userscripts/content/zenius/observe/webcontent.sys.mjs";

const BUTTON_NUMBER = { left: 0, middle: 1, right: 2 };
const BUTTON_MASK = { left: 1, right: 2, middle: 4 };

// Ego's motion and timing constants (page-actions.ts, scroll-motion.ts).
const AUTO_SCROLL_ATTEMPTS = 6;
const WHEEL_SINGLE_EVENT_DISTANCE = 120;
const WHEEL_PIXELS_PER_STEP = 80;
const WHEEL_MAX_STEPS = 12;
const WHEEL_STEP_INTERVAL_MS = 8;
// A motion waits at most this long for another tab's motion to end.
const WHEEL_TURN_MAX_WAIT_MS = 2000;
const INPUT_EVENT_DELAY_MS = 25;
const SETTLE_FRAME_MAX_MS = 25;
const STABLE_TOLERANCE_PX = 0.25;
const FILL_VERIFICATION_ATTEMPTS = 5;
const FILL_VERIFICATION_INTERVAL_MS = 50;

function transient(message, data = {}) {
  const reason = R.reasonOf(message);
  return new ZenError(reason ? "ZEN_NOT_ACTIONABLE" : "ZEN_TIMEOUT", message, {
    ...(reason ? { reason } : {}),
    ...data,
    transient: true,
  });
}

// ---------------------------------------------------------------- dialogs

// A JavaScript dialog blocks the page's script, and the dispatch that ran
// it, until the agent answers. Ego's pending input commands fail once one
// opens, so no later step of the gesture reaches the page, even after the
// answer (page-model.ts:3142-3145). Here the call is still on the stack
// under the dialog. Gecko's prompter fires DOMWillOpenModalDialog at the
// tab's WindowRoot before it blocks (Prompter.sys.mjs, openPrompt), so an
// input call stops at its next step once one fired while it ran. The step
// that opened the dialog finishes, as the event Chromium was handling does.
// A dialog in another process of the tab isn't seen here; the parent still
// returns at once (methods/actions.sys.mjs, observed and untilDialog).

/** Thrown at the next step once a dialog opened; inputCall() catches it. */
class DialogInterrupt extends Error {}

/** @type {WeakMap<EventTarget, {active: number, opened: boolean}>} per tab, by its WindowRoot */
const dialogWatches = new WeakMap();

function dialogWatch(win) {
  const root = win?.docShell?.chromeEventHandler;
  if (!root) {
    return null;
  }
  let watch = dialogWatches.get(root);
  if (!watch) {
    const w = { active: 0, opened: false };
    root.addEventListener(
      "DOMWillOpenModalDialog",
      () => {
        if (w.active) {
          w.opened = true;
        }
      },
      { capture: true, mozSystemGroup: true }
    );
    dialogWatches.set(root, w);
    watch = w;
  }
  return watch;
}

/** Ends the gesture here if a dialog opened in the tab during the call, or is open. */
function stopAtDialog(win) {
  if (dialogWatches.get(win?.docShell?.chromeEventHandler)?.opened || win?.windowUtils?.isInModalState()) {
    throw new DialogInterrupt();
  }
}

/**
 * Run an input call. One that a dialog cut short returns `{...cut, dialog:
 * true}`. `fn` gets the call's record: pointerEvent() keeps in `pressed` a
 * button this call pressed and hasn't released.
 */
async function inputCall(win, fn, cut = {}) {
  const watch = dialogWatch(win);
  const call = { pressed: null };
  const top = I.processTopWindow(win);
  if (watch) {
    watch.active++;
  }
  C.enterCall(top);
  try {
    stopAtDialog(win);
    return await fn(call);
  } catch (e) {
    if (!(e instanceof DialogInterrupt)) {
      if (["mouse_held_elsewhere", "user_composing", "user_scrolling"].includes(e?.data?.reason)) {
        // Cut short mid-gesture by another tab: nothing of this call's stays
        // held, though the release itself waits until it's safe to send.
        try {
          releasePress(call);
        } catch {}
      }
      throw e;
    }
    try {
      releasePress(call);
    } catch {
      // The answer may have navigated the press's window away: nothing is held there.
    }
    return { ...cut, dialog: true };
  } finally {
    C.leaveCall(top);
    if (watch && --watch.active === 0) {
      watch.opened = false;
    }
  }
}

/**
 * A press whose release the dialog cut off: the page never sees a mouseup,
 * as in Ego, but Gecko gets one, or the press it started (a text selection
 * drag) keeps the mouse captured process-wide (see releaseHiddenly). An
 * emulated drag it began ends with it, without a drop.
 */
function releasePress(call) {
  const p = call.pressed;
  if (!p) {
    return;
  }
  call.pressed = null;
  const drag = drags.get(p.win);
  if (drag) {
    drag.active = null;
  }
  releaseHiddenly(p.win, p.x, p.y, p.button, p.mods);
  heldButtons.set(I.processTopWindow(p.win), 0);
}

// The user's input reached a tab where zenius holds a press (a capture
// brought it there): end the press unseen, so the capture goes too. Until
// the release goes out (it may wait for the user's word), the press stays
// on record, and the guard keeps the user's input from the page.
C.setReleaser((top, press) => {
  heldButtons.set(top, 0);
  const drag = drags.get(press.win);
  if (drag) {
    drag.active = null;
  }
  try {
    releaseHiddenly(press.win, press.x, press.y, press.button, press.mods);
  } catch {}
});

// ---------------------------------------------------------------- frames

/** Where a frame element's viewport starts, in its document's viewport px. */
export function frameOrigin(frameEl) {
  const r = frameEl.getBoundingClientRect();
  const cs = frameEl.ownerDocument.defaultView.getComputedStyle(frameEl);
  return {
    x: r.left + frameEl.clientLeft + parseFloat(cs.paddingLeft || "0"),
    y: r.top + frameEl.clientTop + parseFloat(cs.paddingTop || "0"),
  };
}

/** Offset of `win`'s viewport inside this process's outermost viewport. */
export function originInProcessTop(win) {
  let x = 0;
  let y = 0;
  for (let w = win; ; ) {
    const fe = w.browsingContext?.embedderElement;
    if (!fe) {
      return { x, y };
    }
    const o = frameOrigin(fe);
    x += o.x;
    y += o.y;
    w = fe.ownerDocument.defaultView;
  }
}

/** The innermost element at a viewport point, through shadow roots. */
export function deepElementFromPoint(root, x, y) {
  let el = root.elementFromPoint(x, y);
  for (let depth = 0; el && depth < 32; depth++) {
    const inner = el.openOrClosedShadowRoot?.elementFromPoint(x, y);
    if (!inner || inner === el) {
      break;
    }
    el = inner;
  }
  return el;
}

/**
 * The out-of-process frame under a point of this process's top viewport, with
 * its viewport offset. Same-process frames are walked through: input
 * dispatched at the top reaches them.
 */
function remoteFrameAt(doc, x, y) {
  let d = doc;
  let ox = 0;
  let oy = 0;
  for (let depth = 0; depth < 32; depth++) {
    const el = deepElementFromPoint(d, x - ox, y - oy);
    if (!el || !I.isFrameElement(el) || !el.browsingContext) {
      return null;
    }
    const o = frameOrigin(el);
    ox += o.x;
    oy += o.y;
    if (!el.browsingContext.docShell) {
      return { bcId: el.browsingContext.id, ox, oy };
    }
    d = el.contentDocument;
    if (!d) {
      return null;
    }
  }
  return null;
}

/**
 * The document that input at (x, y) of `win`'s viewport reaches in this
 * process: same-process frames walked through, as dispatched events go.
 */
function documentAt(win, x, y) {
  let d = win.document;
  let ox = 0;
  let oy = 0;
  for (let depth = 0; depth < 32; depth++) {
    const el = deepElementFromPoint(d, x - ox, y - oy);
    const inner = el && I.isFrameElement(el) && el.browsingContext?.docShell ? el.contentDocument : null;
    if (!inner) {
      return d;
    }
    const o = frameOrigin(el);
    ox += o.x;
    oy += o.y;
    d = inner;
  }
  return d;
}

/**
 * SPEC I5: input lands only in web content. zen-observe's gate checks the
 * document each content call goes to, out-of-process frames included, but
 * events sent here reach this process's frames on their own. One of those
 * can be Firefox's error page for a frame that failed (with its "Accept the
 * risk" button), laid over the page, which a forced click or a raw
 * `page.mouse` at a point would otherwise reach.
 *
 * @param {Document} doc where the input would land
 * @param {string} method the agent method, for the message
 * @param {string} where e.g. "the point (10, 20)"
 */
function checkLanding(doc, method, where) {
  const why = whyNotWebDocument(doc);
  if (why === ADDON_PAGE) {
    // As zen-observe's checks: the frame's host is the add-on's id in this
    // profile, which the page may not see, and the agent didn't ask for it.
    throw new ZenError(
      "ZEN_PAGE_NOT_WEB_CONTENT",
      `${method} refused: ${where} is in an add-on's frame (a password manager's menu, say), which isn't web content. Agents act only in web pages: act elsewhere in the page, or hand the task to the user.`,
      { method, frame: true }
    );
  }
  if (why) {
    const url = doc.documentURI;
    throw new ZenError(
      "ZEN_PAGE_NOT_WEB_CONTENT",
      `${method} refused: ${where} is in a frame that shows ${url}, which isn't web content (${why}). Agents act only in web pages: act elsewhere in the page, or hand the task to the user.`,
      { url, method, frame: true }
    );
  }
}

const atPoint = (win, p, method) => checkLanding(documentAt(win, p.x, p.y), method, `the point (${Math.round(p.x)}, ${Math.round(p.y)})`);

/**
 * Next hop toward frame `bcId`: the out-of-process frame embedded in this
 * process on the way to it, with its viewport offset; null when `bcId` lives
 * here (or is gone).
 */
function hopToward(bcId) {
  for (let bc = BrowsingContext.get(bcId); bc; bc = bc.parent) {
    if (bc.docShell) {
      return null;
    }
    if (bc.parent?.docShell) {
      const fe = bc.embedderElement;
      if (!fe) {
        return null;
      }
      const top = originInProcessTop(fe.ownerDocument.defaultView);
      const o = frameOrigin(fe);
      return { bcId: bc.id, ox: top.x + o.x, oy: top.y + o.y };
    }
  }
  return null;
}

function shiftSteps(steps, ox, oy) {
  return steps.map(s => (s.x === undefined ? s : { ...s, x: s.x - ox, y: s.y - oy }));
}

// ---------------------------------------------------------------- mouse guards and drag emulation

const MOUSE_GUARD_TYPES = ["contextmenu", "mousedown", "mouseup", "click", "auxclick"];

/**
 * While our own mouse events are dispatched, cancel native defaults that would
 * reach past the agent's page: the browser's context menu (it opens over the
 * user's view), middle-click (which pastes the user's PRIMARY selection on
 * Linux and opens links wherever the window is), and a native drag session
 * (it would take the OS pointer; the drag is emulated instead). The page's
 * own listeners run first and see the events unchanged. A middle click on a
 * link is kept in `call.openLinks` for the parent, which opens it in the
 * task (middleClickLink).
 */
function guardMouseDefaults(win, drag, call) {
  const listener = e => {
    if (e.type === "dragstart") {
      if (!e.defaultPrevented) {
        drag.begin(e);
      }
      e.preventDefault();
      return;
    }
    if (e.type === "auxclick" && call) {
      const link = middleClickLink(e);
      if (link) {
        (call.openLinks ??= []).push(link);
      }
    }
    if (e.type === "contextmenu" || e.button === 1) {
      e.preventDefault();
    }
  };
  const opts = { capture: true, mozSystemGroup: true };
  for (const type of [...MOUSE_GUARD_TYPES, "dragstart"]) {
    win.addEventListener(type, listener, opts);
  }
  return () => {
    for (const type of [...MOUSE_GUARD_TYPES, "dragstart"]) {
      win.removeEventListener(type, listener, opts);
    }
  };
}

/**
 * A middle click on a link opens it as a new page of the task, as on
 * Ego, where Chromium opens it in a background tab that joins the task
 * (receipt.popups). Firefox's own handling stays cancelled; this takes what
 * its ClickHandlerChild would send, and the parent opens the link as its
 * ClickHandlerParent would, in the task (methods/actions.sys.mjs,
 * openMiddleClickedLinks).
 *
 * @param {MouseEvent} e an auxclick, after the page's listeners
 * @returns {{href: string, referrerInfo: string, policyContainer: string|null}|null}
 */
function middleClickLink(e) {
  if (e.defaultPrevented || e.button !== 1) {
    return null;
  }
  const target = e.composedTarget;
  const kind = target && ChromeUtils.getClassName(target);
  // As Firefox: no link opens from an editor (Linux pastes there instead).
  if (!target || target.isContentEditable || target.ownerDocument?.designMode === "on" || kind === "HTMLInputElement" || kind === "HTMLTextAreaElement") {
    return null;
  }
  const [href, node, principal] = lazy.BrowserUtils.hrefAndLinkNodeForClickEvent(e) ?? [];
  if (!href || Services.io.extractScheme(href) === "javascript") {
    return null;
  }
  try {
    Services.scriptSecurityManager.checkLoadURIStrWithPrincipal(principal, href);
  } catch {
    return null;
  }
  const doc = e.originalTarget.ownerDocument;
  const referrerInfo = Cc["@mozilla.org/referrer-info;1"].createInstance(Ci.nsIReferrerInfo);
  if (node) {
    referrerInfo.initWithElement(node);
  } else {
    referrerInfo.initWithDocument(doc);
  }
  return {
    href,
    referrerInfo: lazy.E10SUtils.serializeReferrerInfo(referrerInfo),
    policyContainer: doc.policyContainer ? lazy.E10SUtils.serializePolicyContainer(doc.policyContainer) : null,
  };
}

const drags = new WeakMap();

/**
 * HTML5 drag and drop without a native drag session: after the page's
 * dragstart, pointer moves become drag/dragenter/dragover/dragleave and the
 * release becomes drop/dragend, all trusted, carrying the data the page put
 * on its DataTransfer.
 */
class DragEmulation {
  constructor(win) {
    this.win = win;
    this.active = null;
  }

  begin(e) {
    this.active = {
      source: e.composedTarget ?? e.target,
      // A private copy of what the page put on it: Gecko may empty the
      // page's own DataTransfer once dragstart is over.
      dataTransfer: e.dataTransfer?.mozCloneForEvent("dragstart") ?? null,
      over: null,
      dropEffect: "none",
    };
  }

  /**
   * One drag event for drag `a` (end() has already cleared this.active).
   * Its DataTransfer is a clone for this event, as Gecko's drag service
   * makes one: the items keep the principal of the page that set them, so
   * the page can read them in drop. (Items a DataTransfer gets from chrome
   * code carry the system principal, and the page reads them as empty.)
   */
  #event(a, type, target, x, y, mods, buttons, dropEffect) {
    const win = target.ownerDocument.defaultView;
    const dt = a.dataTransfer?.mozCloneForEvent(type) ?? new win.DataTransfer();
    if (dropEffect) {
      try {
        dt.dropEffect = dropEffect;
      } catch {}
    }
    const ev = new win.DragEvent(type, {
      bubbles: true,
      cancelable: type !== "dragleave" && type !== "dragend",
      composed: true,
      clientX: x,
      clientY: y,
      screenX: win.mozInnerScreenX + x,
      screenY: win.mozInnerScreenY + y,
      buttons,
      ctrlKey: mods.includes("Control"),
      shiftKey: mods.includes("Shift"),
      altKey: mods.includes("Alt"),
      metaKey: mods.includes("Meta"),
      dataTransfer: dt,
      view: win,
    });
    // Inside dispatchIn: zenius's drop, not the user's (content/typing.sys.mjs).
    let notCancelled = true;
    C.dispatchIn(win, () => {
      notCancelled = I.dispatchTrusted(target, ev);
    });
    return { notCancelled, dt };
  }

  move(x, y, mods, buttons) {
    const a = this.active;
    this.#event(a, "drag", a.source, x, y, mods, buttons);
    const el = deepElementFromPoint(this.win.document, x, y) ?? this.win.document.documentElement;
    const initial = initialDropEffect(a.dataTransfer?.effectAllowed);
    if (el !== a.over) {
      if (a.over?.isConnected) {
        this.#event(a, "dragleave", a.over, x, y, mods, buttons);
      }
      a.over = el;
      this.#event(a, "dragenter", el, x, y, mods, buttons, initial);
    }
    const { notCancelled, dt } = this.#event(a, "dragover", el, x, y, mods, buttons, initial);
    // A drop target accepts by cancelling dragover, and refuses with dropEffect "none".
    a.dropEffect = notCancelled ? "none" : dt.dropEffect;
  }

  end(x, y, mods) {
    const a = this.active;
    this.active = null;
    let dropped = false;
    if (a.over?.isConnected && a.dropEffect !== "none") {
      this.#event(a, "drop", a.over, x, y, mods, 0, a.dropEffect);
      dropped = true;
    } else if (a.over?.isConnected) {
      this.#event(a, "dragleave", a.over, x, y, mods, 0);
    }
    if (a.source.isConnected) {
      this.#event(a, "dragend", a.source, x, y, mods, 0, dropped ? a.dropEffect : "none");
    }
    return dropped;
  }
}

/** The dropEffect that dragenter and dragover start with: the HTML spec's table, without modifier keys. */
function initialDropEffect(effectAllowed) {
  switch (effectAllowed) {
    case "none":
      return "none";
    case "link":
    case "linkMove":
      return "link";
    case "move":
      return "move";
    default:
      return "copy";
  }
}

function dragFor(win) {
  let d = drags.get(win);
  if (!d) {
    d = new DragEmulation(win);
    drags.set(win, d);
  }
  return d;
}

/**
 * One mouse event, or its drag-and-drop counterpart while an emulated drag is
 * active. Focus events are emulated after a press that moved focus. `call`
 * (inputCall's record) learns of a press until its release.
 */
function pointerEvent(win, type, x, y, { button = "left", buttons = 0, clickCount = 1, mods = [], call = null } = {}) {
  stopAtDialog(win);
  if (type === "mousedown" || type === "mouseup") {
    // Callers wait for C.untilFree() first; this only keeps a caller that
    // didn't from committing the user's word or pressing in their tab.
    const why = C.blocker(win);
    if (why) {
      throw C.blockedError(why, type === "mousedown" ? "press" : "release");
    }
    const top = I.processTopWindow(win);
    heldButtons.set(top, buttons);
    // What Gecko holds, for the capture guard: set at the press, cleared
    // when a release goes out (below, or a hidden one).
    if (type === "mousedown") {
      C.notePress(top, { win, x, y, button, mods });
    }
    if (call) {
      call.pressed = type === "mousedown" ? { win, x, y, button, mods } : null;
    }
  }
  const drag = dragFor(win);
  if (drag.active && type === "mousemove") {
    drag.move(x, y, mods, buttons);
    return;
  }
  if (drag.active && type === "mouseup") {
    drag.end(x, y, mods);
    releaseHiddenly(win, x, y, button, mods);
    return;
  }
  const unguard = guardMouseDefaults(win, drag, call);
  try {
    const prev = type === "mousedown" ? I.focusedElement(win) : null;
    if (type === "mouseup" && !buttons) {
      C.notePress(I.processTopWindow(win), null);
    }
    const send = () => I.mouseEvent(win, type, x, y, { button: BUTTON_NUMBER[button] ?? 0, buttons, clickCount, mods });
    if (type === "mousedown") {
      // It keeps no process-wide mouse capture, which took the user's press.
      C.pressWithoutCapture(win, send);
    } else {
      send();
      if (type === "mouseup" && !buttons) {
        // A pointer capture the page took ends here, and the parent hears so a moment later.
        C.holdUntilParentHears(I.processTopWindow(win));
      }
    }
    if (type === "mousedown") {
      I.emulateFocusChange(prev, I.focusedElement(win));
      if (button === "right") {
        // On Linux and macOS the widget fires contextmenu after a right
        // press (Chromium too, for Ego); a synthesized press gets none. The
        // guard above cancels the browser's own menu, after the page's
        // listeners. It is the widget's own event: none after a press that
        // opened a dialog.
        stopAtDialog(win);
        I.mouseEvent(win, "contextmenu", x, y, { button: 2, buttons, clickCount, mods });
      }
    }
  } finally {
    unguard();
  }
  if (type === "mousemove" && drag.active) {
    // This move started a drag: a drag session sends its first dragenter
    // and dragover where the pointer now is.
    stopAtDialog(win);
    drag.move(x, y, mods, buttons);
  }
}

const HIDDEN_RELEASE_TYPES = ["pointerup", "mouseup", "click", "auxclick", "dblclick", "contextmenu"];
const HIDDEN_MOVE_TYPES = [
  "pointerrawupdate",
  "pointermove",
  "pointerover",
  "pointerout",
  "pointerenter",
  "pointerleave",
  "mousemove",
  "mouseover",
  "mouseout",
  "mouseenter",
  "mouseleave",
];

/** Each tab's held buttons (top window → mask), from the presses and releases we send. */
const heldButtons = new WeakMap();

/**
 * After an emulated drop, the page must not see a mouseup (a real drag and
 * drop ends without one), but Gecko still needs the native release: without
 * it the pointer stays pressed and the mouse stays captured process-wide, and
 * once this document is gone (bfcache), every real mouse event in this
 * content process is dropped, in every tab it hosts. So send it, and stop it
 * at the tab's chrome event handler, ahead of every page listener; Gecko's
 * own handling still runs. A release on the pressed element makes a click,
 * and after a second press a dblclick: their defaults (a link's
 * navigation, a checkbox's toggle) are cancelled too.
 */
function releaseHiddenly(win, x, y, button, mods) {
  // While the user composes in another tab, or holds a press there, the
  // release waits: it would commit their word, or go to their tab.
  C.releaseWhenFree(win, () => sendHiddenRelease(win, x, y, button, mods));
}

function sendHiddenRelease(win, x, y, button, mods) {
  const root = win.docShell?.chromeEventHandler;
  if (!root) {
    return;
  }
  C.notePress(I.processTopWindow(win), null);
  const stop = e => {
    e.stopImmediatePropagation();
    if (e.type !== "pointerup" && e.type !== "mouseup") {
      e.preventDefault();
    }
  };
  for (const type of HIDDEN_RELEASE_TYPES) {
    root.addEventListener(type, stop, true);
  }
  try {
    I.mouseEvent(win, "mouseup", x, y, { button: BUTTON_NUMBER[button] ?? 0, buttons: 0, clickCount: 1, mods });
  } finally {
    for (const type of HIDDEN_RELEASE_TYPES) {
      root.removeEventListener(type, stop, true);
    }
  }
  C.holdUntilParentHears(I.processTopWindow(win));
}

function maskOf(names) {
  let mask = 0;
  for (const n of names ?? []) {
    mask |= BUTTON_MASK[n] ?? 0;
  }
  return mask;
}

// ---------------------------------------------------------------- wheel motion

/**
 * Gecko keeps sending wheel events to the frame a recent wheel scrolled, for
 * mousewheel.transaction.timeout ms after the last one, even once that frame
 * is a previous document in the bfcache. Our synthesized wheel skips APZ,
 * which would otherwise route it, so after a navigation the page doesn't see
 * it. Each lost event also extends that transaction.
 */
const wheelTransactionMs = C.wheelTransactionMs;

/**
 * One wheel event, its transaction ended at once. The transaction is the
 * process's, so one left alive between our events took the user's wheel
 * (a trackpad's momentum tail) from their tab into this page, and the
 * user's took ours into theirs (C.untilWheelFree). So
 * this waits while the user scrolls, ends what their scroll left, and ends
 * its own before anything else can run. `origin` keeps a motion on what its
 * first event scrolled (wheelEvents). A lost event (see above) is waited
 * out once, then scrolled directly.
 *
 * @returns {Promise<false | {target: Node | null, out: BrowsingContext | null}>} the event's
 *   target and, when nothing in this process could scroll, the frame whose
 *   embedding document takes the scroll on (I.wheelScroller); false past the deadline
 */
async function wheelStep(win, x, y, dx, dy, mods, deadline, origin) {
  for (let again = true; ; again = false) {
    stopAtDialog(win);
    await C.untilWheelFree(deadline || Date.now() + RAW_MOUSE_WAIT_MS);
    if (C.userWheelWithin(wheelTransactionMs())) {
      // Their gesture is over, but its transaction may live on.
      endWheelTransaction(win, x, y, mods);
    }
    const sent = I.wheelAt(win, x, y, dx, dy, mods, origin);
    C.noteAgentWheel(win, endWheelTransaction(win, x, y, mods));
    if (sent.dispatched || remoteFrameAt(win.document, x, y)) {
      return { target: sent.target ?? null, out: sent.out ?? null };
    }
    if (!(again && C.userWheelWithin(wheelTransactionMs()))) {
      break;
    }
    // The user's scroll took it: wait for them again.
  }
  const waitMs = wheelTransactionMs();
  if (deadline && Date.now() + waitMs >= deadline) {
    return false;
  }
  await I.sleep(waitMs);
  stopAtDialog(win);
  const retried = I.wheelAt(win, x, y, dx, dy, mods, origin);
  C.noteAgentWheel(win, endWheelTransaction(win, x, y, mods));
  if (!retried.dispatched) {
    const target = (origin?.isConnected && origin) || deepElementFromPoint(win.document, x, y) || win.document.documentElement;
    return { target, out: I.scrollFromWheel(target, dx, dy)?.out ?? null };
  }
  return { target: retried.target ?? null, out: retried.out ?? null };
}

/**
 * Gecko keeps one wheel transaction per content process, not per tab, and
 * every tab of a window covers the same screen rectangle. So until it times
 * out, the next wheel that any other tab of the process sends goes to the
 * frame this motion scrolled: that tab's page misses it and waits the
 * transaction out (wheelStep), and this tab's page gets it. With tasks on
 * one site, which share a few processes, a click that scrolled its target
 * into view took 1.7 s about one time in three.
 *
 * A real pointer move outside the transaction's frame ends it. So after a
 * motion, send one beyond the tab's top-left corner and one back to where
 * the wheel was. The tab's chrome event handler stops both ahead of every
 * page listener, as with releaseHiddenly's release. Skipped while the tab
 * holds a button, since a move could start a drag then.
 */
function endWheelTransaction(win, x, y, mods) {
  const top = I.processTopWindow(win);
  const root = top.docShell?.chromeEventHandler;
  if (!root || heldButtons.get(top) || win.windowUtils?.isInModalState()) {
    return false;
  }
  const stop = e => e.stopImmediatePropagation();
  for (const type of HIDDEN_MOVE_TYPES) {
    root.addEventListener(type, stop, true);
  }
  try {
    I.mouseEvent(top, "mousemove", -1, -1, { buttons: 0, mods });
    I.mouseEvent(win, "mousemove", x, y, { buttons: 0, mods });
    return true;
  } catch (e) {
    // Another tab holds a press: the moves would go there. The transaction
    // stays; the next wheel turn waits it out.
    if (e?.data?.reason !== "mouse_held_elsewhere") {
      throw e;
    }
    return false;
  } finally {
    for (const type of HIDDEN_MOVE_TYPES) {
      root.removeEventListener(type, stop, true);
    }
  }
}

// One wheel motion at a time in this content process, whichever tab sends
// it: a wheel sent during another tab's motion would join its transaction.
let wheelTurn = Promise.resolve();

/** Wait for the motion before this one (at most until `deadline`), then hold the turn. */
async function takeWheelTurn(deadline) {
  const previous = wheelTurn;
  let release;
  wheelTurn = new Promise(resolve => (release = resolve));
  const waitMs = deadline ? Math.max(0, deadline - Date.now()) : WHEEL_TURN_MAX_WAIT_MS;
  await Promise.race([previous, I.sleep(Math.min(waitMs, WHEEL_TURN_MAX_WAIT_MS))]);
  return release;
}

/**
 * Ego's wheel motion: up to 12 eased events 8 ms apart at one point. Stops
 * (returning false) when the deadline passes between events. What nothing
 * in this process could scroll adds up in `chained`, for the parent to
 * carry on past this process's frame (methods/actions.sys.mjs chainWheel).
 */
async function wheelMotion(win, motion, deadline, mods = [], chained = null) {
  const release = await takeWheelTurn(deadline);
  try {
    return await wheelEvents(win, motion, deadline, mods, chained);
  } finally {
    try {
      C.noteAgentWheel(win, endWheelTransaction(win, motion.x, motion.y, mods));
    } catch {
      // The tab navigated or closed during the motion: no transaction is left in it.
    }
    release();
  }
}

/**
 * Gecko sends every event of a wheel gesture to its first one's target, so
 * a page that scrolls a scroll box under the pointer keeps scrolling. zenius
 * ends its gesture after each event (wheelStep), so each later event of a
 * motion scrolls from the first one's target itself. The page's listeners
 * see it at the element under the pointer.
 */
async function wheelEvents(win, { x, y, deltaX, deltaY }, deadline, mods, chained) {
  const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  const steps = distance <= WHEEL_SINGLE_EVENT_DISTANCE ? 1 : Math.min(WHEEL_MAX_STEPS, Math.ceil(distance / WHEEL_PIXELS_PER_STEP));
  let sentX = 0;
  let sentY = 0;
  let origin = null;
  for (let step = 1; step <= steps; step++) {
    if (step > 1) {
      if (deadline && Date.now() >= deadline) {
        return false;
      }
      await I.sleep(WHEEL_STEP_INTERVAL_MS);
      if (deadline && Date.now() >= deadline) {
        return false;
      }
    }
    const p = step / steps;
    const eased = step === steps ? 1 : p * p * (3 - 2 * p);
    const dx = deltaX * eased - sentX;
    const dy = deltaY * eased - sentY;
    sentX += dx;
    sentY += dy;
    const sent = await wheelStep(win, x, y, dx, dy, mods, deadline, origin);
    if (!sent) {
      return false;
    }
    if (sent.out && chained) {
      chained.bcId = sent.out.id;
      chained.dx += dx;
      chained.dy += dy;
    }
    if (step === 1) {
      origin = sent.target;
    }
  }
  return true;
}

// ---------------------------------------------------------------- point stage

/**
 * Two frames, so what the page does on them (an animation, a sticky header,
 * a lazy row) has run before the point is taken.
 *
 * A hidden agent tab's frames can stop for a while. Its docShell stays
 * active (SPEC §3.5), so it paints, but the compositor acknowledges a
 * hidden tab's paints only when it renders for another reason (every 200
 * to 500 ms on an idle screen, measured). After two unacknowledged paints
 * Gecko's refresh driver waits ("waiting for paint"): the page's own frames
 * don't run either, so nothing frame-driven can move. A click paints, so
 * back-to-back clicks each waited out the old 100 ms cap (110 ms a click
 * against 35 ms). So each frame here is a
 * rAF or SETTLE_FRAME_MAX_MS, whichever comes first, and a first frame that
 * didn't come ends the wait.
 *
 * @returns {Promise<boolean>} whether both frames came
 */
async function settle(win) {
  for (let i = 0; i < 2; i++) {
    const came = await new Promise(resolve => {
      try {
        win.requestAnimationFrame(() => resolve(true));
      } catch {
        resolve(false);
        return;
      }
      I.sleep(SETTLE_FRAME_MAX_MS).then(() => resolve(false));
    });
    if (!came) {
      return false;
    }
  }
  return true;
}

function rectMoved(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
}

function sameWheelRequest(a, b) {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.deltaX - b.deltaX) < 1 && Math.abs(a.deltaY - b.deltaY) < 1;
}

function pointFor(el, position) {
  return position ? A.positionPoint(el, position) : A.actionPointForElement(el);
}

/**
 * Scroll until `evaluate` stops asking: wheel motions first (trusted, and
 * a page may cancel them), then once a programmatic scroll when a motion
 * left the request unchanged (a wheel trap, or the end of a scroll range).
 */
async function bringIntoView(el, evaluate, { action, subject, deadline, counters }) {
  const win = el.ownerDocument.defaultView;
  const notVisible = () => transient(`${action} failed: ${subject} is not visible in the viewport`);
  let previous;
  let fellBack = false;
  for (let attempt = 0; attempt <= AUTO_SCROLL_ATTEMPTS; attempt++) {
    const r = await evaluate();
    if (r.error) {
      throw transient(`${action} failed: ${r.error}`);
    }
    if (!r.scroll) {
      return r;
    }
    const s = r.scroll;
    if (attempt === AUTO_SCROLL_ATTEMPTS || ![s.x, s.y, s.deltaX, s.deltaY].every(Number.isFinite) || Date.now() >= deadline) {
      throw notVisible();
    }
    if (previous && sameWheelRequest(previous, s)) {
      if (fellBack) {
        throw notVisible();
      }
      fellBack = true;
      previous = undefined;
      // Through Xrays, so a page-patched scrollIntoView is bypassed.
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      continue;
    }
    previous = s;
    counters.wheel = true;
    if (!(await wheelMotion(win, s, deadline))) {
      throw notVisible();
    }
  }
  throw notVisible();
}

/** Bring each same-process frame owner of `el` into view, outermost first. */
async function frameOwnersIntoView(el, opts) {
  const owners = [];
  for (let w = el.ownerDocument.defaultView; w.browsingContext?.embedderElement; ) {
    const fe = w.browsingContext.embedderElement;
    owners.unshift(fe);
    w = fe.ownerDocument.defaultView;
  }
  for (const owner of owners) {
    await ownerIntoView(owner, opts);
  }
}

function ownerIntoView(owner, opts) {
  return bringIntoView(
    owner,
    async () => {
      if (!owner.isConnected) {
        return { error: "iframe is not connected" };
      }
      const rect = owner.getBoundingClientRect();
      const point = A.actionPointForElement(owner);
      if (rect.width <= 0 || rect.height <= 0 || !point) {
        return { error: "iframe is not visible" };
      }
      return { scroll: A.scrollRequestForPoint(owner, point) };
    },
    { ...opts, subject: "iframe" }
  );
}

/**
 * Ego's point stage: connected, visible, (enabled), scrolled into view,
 * settled (strict: not moving), not covered. Returns the point in the
 * element's own viewport.
 */
async function pointStage(el, { action, position, hitTest, requireEnabled, stability, deadline, counters }) {
  await frameOwnersIntoView(el, { action, deadline, counters });
  const r = await bringIntoView(
    el,
    async () => {
      if (!el.isConnected) {
        return { error: "element is not connected" };
      }
      const rect = el.getBoundingClientRect();
      let point = pointFor(el, position);
      if (rect.width <= 0 || rect.height <= 0 || !point) {
        return { error: "element is not visible" };
      }
      if (requireEnabled && A.isActionTargetDisabled(el)) {
        return { error: "element is disabled" };
      }
      const scroll = A.scrollRequestForPoint(el, point);
      if (scroll) {
        return { scroll };
      }
      if (stability !== "none") {
        await settle(el.ownerDocument.defaultView);
        const after = el.getBoundingClientRect();
        if (stability === "strict" && rectMoved(rect, after) > STABLE_TOLERANCE_PX) {
          return { error: "element is not stable" };
        }
        point = pointFor(el, position);
        if (!point) {
          return { error: "element is not visible" };
        }
      }
      if (hitTest) {
        const interceptor = A.interceptingElementAtPoint(el, point);
        if (interceptor) {
          return { error: `${A.describeHitTarget(interceptor)} intercepts pointer events` };
        }
      }
      return { point };
    },
    { action, subject: "element", deadline, counters }
  );
  if (![r.point.x, r.point.y].every(Number.isFinite)) {
    throw new ZenError("ZEN_INTERNAL", `${action} could not resolve the element position`);
  }
  return r.point;
}

/** Click's check right before each press: connected, enabled, not covered. */
function assertClickTarget(el, point, force) {
  if (!el.isConnected) {
    throw transient("page.click failed: element is not connected");
  }
  if (A.isActionTargetDisabled(el)) {
    throw transient("page.click failed: element is disabled");
  }
  if (!force) {
    const interceptor = A.interceptingElementAtPoint(el, point);
    if (interceptor) {
      throw transient(`page.click failed: ${A.describeHitTarget(interceptor)} intercepts pointer events`);
    }
  }
}

/** Visible center of the element (for the agent cursor), or null. */
function visibleCenter(el) {
  const rect = el.getBoundingClientRect();
  const view = el.ownerDocument.defaultView;
  if (!view || rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(view.innerWidth, rect.right);
  const bottom = Math.min(view.innerHeight, rect.bottom);
  return right > left && bottom > top ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
}

/** A point in `el`'s viewport as the process top sees it. */
function topPoint(el, point) {
  if (!point) {
    return null;
  }
  const o = originInProcessTop(el.ownerDocument.defaultView);
  return { x: point.x + o.x, y: point.y + o.y };
}

// ---------------------------------------------------------------- target resolution

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  markHooked: "chrome://userscripts/content/zenius/content/evidence.sys.mjs",
  noteWrittenWindow: "chrome://userscripts/content/zenius/content/agentworld.sys.mjs",
  resolveRef: "chrome://userscripts/content/zenius/content/snapshot/registry.sys.mjs",
});

/**
 * The element a selector or ref names in this process: refs directly; a
 * selector by Ego's rule (main document first, then frames). When frames in
 * other processes must be counted too, returns {frames} for the parent.
 */
function resolveTarget(actor, { target, ref, only, level, action }) {
  const win = actor.contentWindow;
  if (ref) {
    // A node the page took out stays its ref's until it's gone: the call
    // retries while it's out and acts once it's back, as Ego's does. One
    // the page moved into another document is stale already: the walker's
    // resolve keeps only its own document's.
    const el = lazy.resolveRef(actor, ref, { detached: true });
    if (!el.isConnected) {
      throw transient(`${action ?? "page action"} failed: element is not connected`);
    }
    return { el };
  }
  const parsed = R.parseTarget(target);
  if (only) {
    return { el: R.pickIn(win.document, parsed, level) };
  }
  const elements = R.elementsIn(win.document, parsed);
  const main = R.summarize(elements, level);
  if (main.actionable.length === 1) {
    return { el: main.actionable[0] };
  }
  if (main.actionable.length > 1) {
    throw R.ambiguityError(parsed, main.count, R.diagnostics(elements));
  }
  const list = [
    {
      bcId: win.browsingContext.id,
      count: main.count,
      actionable: 0,
      blocker: main.blocker,
      diag: main.count ? R.diagnostics(elements) : undefined,
    },
    ...R.summarizeContexts(win, parsed, level, { skipFirst: true }),
  ];
  if (list.some(s => s.remote)) {
    return { frames: list };
  }
  const { bcId } = R.decide(parsed, list, level);
  const fwin = BrowsingContext.get(bcId)?.docShell?.domWindow;
  if (!fwin) {
    throw new ZenError("ZEN_SELECTOR_NOT_FOUND", `Element not found: ${parsed.raw}`, { matches: 0, transient: true });
  }
  return { el: fwin === win ? main.actionable[0] : R.pickIn(fwin.document, parsed, level) };
}

/**
 * Count a selector in this out-of-process frame and the frames under it, for
 * the parent's choice across processes.
 */
export async function count(actor, { target, level }) {
  return { frames: R.summarizeContexts(actor.contentWindow, R.parseTarget(target), level) };
}

/**
 * Bring the frame owner of child `childBcId` into view; returns its viewport
 * origin. With `measure`, for an action that needn't see the frame,
 * nothing is checked or scrolled, and a frame that is gone has no origin.
 */
export async function frameOwnerIntoView(actor, { childBcId, action, deadline, measure }) {
  const owner = BrowsingContext.get(childBcId)?.embedderElement;
  if (measure) {
    return { origin: owner?.isConnected ? ownerOrigin(owner) : null };
  }
  if (!owner) {
    throw transient(`${action} failed: iframe is not available`);
  }
  // Scrolling by wheel is input: a wheel listener's dialog ends the action.
  return inputCall(owner.ownerDocument.defaultView, async () => {
    const counters = {};
    await frameOwnersIntoView(owner, { action, deadline, counters });
    await ownerIntoView(owner, { action, deadline, counters });
    return { origin: ownerOrigin(owner), wheel: !!counters.wheel };
  });
}

/** A frame owner's content origin in its process's outermost viewport. */
function ownerOrigin(owner) {
  const o = frameOrigin(owner);
  const top = originInProcessTop(owner.ownerDocument.defaultView);
  return { x: o.x + top.x, y: o.y + top.y };
}

// ---------------------------------------------------------------- element actions

const pending = new WeakMap();

/**
 * One attempt of a selector action, in the process that holds (or may hold)
 * the target. `phase` "prepare" stops before input and keeps the target for
 * the "perform" call that follows the visible cursor's move.
 */
export async function act(actor, args) {
  const win = actor.contentWindow;
  return inputCall(win, async call => {
    let el;
    let point;
    if (args.phase === "perform") {
      const p = pending.get(win);
      pending.delete(win);
      if (!p || p.token !== args.token) {
        throw transient(`${args.action} failed: element is not connected`);
      }
      ({ el, point } = p);
    } else {
      const r = resolveTarget(actor, args);
      if (r.frames) {
        return { frames: r.frames };
      }
      el = r.el;
    }
    const counters = {};
    const kind = args.action === "page.dblclick" ? "click" : args.action.slice(5);
    // Before the action, which may rename the element ("Signing in…").
    const step = args.phase === "prepare" ? null : stepName(el);
    const out = await ACTIONS[kind](el, { ...args, point, counters, win, call });
    if (out?.prepared) {
      pending.set(win, { token: args.token, el, point: out.prepared });
      return { prepared: true, point: topPoint(el, out.prepared) };
    }
    return { ...out, step, wheel: !!counters.wheel };
  });
}

/** Elements whose text is a value, which a label's text leaves out. */
const VALUE_TEXT = new Set(["input", "select", "textarea", "option", "datalist"]);

/** A node's text without the text of fields inside it (a select's options). */
function textBesideFields(node, depth = 0) {
  let text = "";
  for (let c = node.firstChild; c && text.length < 300 && depth < 8; c = c.nextSibling) {
    if (c.nodeType === 3) {
      text += c.data;
    } else if (c.nodeType === 1 && !VALUE_TEXT.has(c.localName)) {
      text += textBesideFields(c, depth + 1);
    }
  }
  return text;
}

/**
 * The element as the task's step names it (input/steps.sys.mjs): `name`,
 * what the user sees it called, or else `noun`, what it is. Never a field's
 * value, nor an editable area's text, which may be the user's own. Cheap: it
 * reads attributes and text, no layout. The parent cleans and caps the name:
 * it comes from the page.
 *
 * @param {Element} el
 * @returns {{name?: string, noun?: string}}
 */
export function stepName(el) {
  try {
    const attr = n => el.getAttribute(n)?.trim() || "";
    const tag = el.localName;
    const type = tag === "input" ? attr("type").toLowerCase() || "text" : "";
    const button = tag === "input" && ["submit", "button", "reset", "image"].includes(type);
    const field = !button && (tag === "input" || tag === "textarea" || tag === "select");
    const editable = !field && el.isContentEditable;
    const doc = el.ownerDocument;
    const labelledBy = attr("aria-labelledby")
      .split(/\s+/)
      .filter(Boolean)
      .map(id => doc.getElementById(id))
      .filter(Boolean)
      .map(node => textBesideFields(node))
      .join(" ")
      .trim();
    const label = field && el.labels?.length ? textBesideFields(el.labels[0]).trim() : "";
    const name =
      attr("aria-label") ||
      labelledBy ||
      label ||
      (button ? (type === "image" ? attr("alt") : attr("value")) : "") ||
      attr("placeholder") ||
      (tag === "img" || tag === "area" ? attr("alt") : "") ||
      attr("title") ||
      (field || editable ? "" : el.textContent.trim()) ||
      (field ? attr("name") : "");
    if (name) {
      return { name: name.slice(0, 300) };
    }
    const noun = editable
      ? "an editable area"
      : field
        ? "a field"
        : tag === "a"
          ? "a link"
          : tag === "button" || button
            ? "a button"
            : tag === "img"
              ? "an image"
              : "an element";
    return { noun };
  } catch {
    return {};
  }
}

const ACTIONS = {
  async click(el, args) {
    const o = args.options ?? {};
    const force = o.force === true;
    let point = args.point;
    if (!point) {
      point = await pointStage(el, {
        action: "page.click",
        position: o.position,
        hitTest: !force,
        requireEnabled: true,
        stability: "recompute",
        deadline: args.deadline,
        counters: args.counters,
      });
      if (args.phase === "prepare") {
        return { prepared: point };
      }
    }
    const win = el.ownerDocument.defaultView;
    const button = o.button ?? "left";
    const clickCount = args.action === "page.dblclick" ? 2 : (o.clickCount ?? 1);
    const delay = o.delay ?? 0;
    // A forced click skips the hit test that would find a frame laid over the element.
    atPoint(win, point, args.action);
    const probe = fileInputProbe(win);
    const call = args.call;
    try {
      pointerEvent(win, "mousemove", point.x, point.y, { button: "left", buttons: 0, mods: args.mods, call });
      for (let n = 1; n <= clickCount; n++) {
        await C.untilFree(win, args.deadline, "press");
        // A dialog the last release opened ends the gesture before this check could fail on it.
        stopAtDialog(win);
        assertClickTarget(el, point, force);
        pointerEvent(win, "mousedown", point.x, point.y, { button, buttons: BUTTON_MASK[button], clickCount: n, mods: args.mods, call });
        if (delay) {
          await I.sleep(delay);
        }
        await C.untilFree(win, args.deadline, "release");
        pointerEvent(win, "mouseup", point.x, point.y, { button, buttons: 0, clickCount: n, mods: args.mods, call });
        if (delay && n < clickCount) {
          await I.sleep(delay);
        }
      }
    } finally {
      probe.stop();
    }
    return { point: topPoint(el, point), fileInputClicked: probe.seen, ...(call?.openLinks ? { openLinks: call.openLinks } : {}) };
  },

  async hover(el, args) {
    const o = args.options ?? {};
    let point = args.point;
    if (!point) {
      point = await pointStage(el, {
        action: "page.hover",
        position: o.position,
        hitTest: o.force !== true,
        requireEnabled: false,
        stability: "strict",
        deadline: args.deadline,
        counters: args.counters,
      });
      if (args.phase === "prepare") {
        return { prepared: point };
      }
    }
    atPoint(el.ownerDocument.defaultView, point, args.action);
    pointerEvent(el.ownerDocument.defaultView, "mousemove", point.x, point.y, { buttons: 0, mods: args.mods, call: args.call });
    return { point: topPoint(el, point) };
  },

  async focus(el, args) {
    focusForAction(el);
    return { point: topPoint(el, visibleCenter(el)) };
  },

  async press(el, args) {
    const focused = focusForAction(el);
    const out = await runKeySteps(focused.ownerDocument.defaultView, args);
    return { ...out, point: topPoint(el, visibleCenter(el)) };
  },

  async fill(el, args) {
    return fillElement(el, args);
  },

  async selectOption(el, args) {
    return selectOptions(el, args.choices);
  },

  async setInputFiles(el, args) {
    let input;
    try {
      input = A.fileInputTarget(el);
    } catch (e) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", e.message);
    }
    const win = input.ownerDocument.defaultView;
    if (args.folder) {
      return setInputFolder(input, args.folder);
    }
    const files = args.files ?? [];
    // A one-file input keeps the first, as Chromium does (Ego's live run).
    input.mozSetFileArray(input.multiple ? files : files.slice(0, 1));
    I.dispatchTrusted(input, new win.Event("input", { bubbles: true, composed: true }));
    I.dispatchTrusted(input, new win.Event("change", { bubbles: true }));
    return {};
  },
};

/**
 * A folder for a webkitdirectory input. A content process may read a folder
 * only once Gecko's picker parent has granted it that folder, so this opens
 * the input's own folder chooser, which the parent answers at once with the
 * folder it wrote (filechooser.sys.mjs, claimFolderChooser). Gecko then walks
 * the folder and fires the input's input and change events, as for the
 * user's pick. showPicker() needs the page's transient activation: this one
 * call gets it, and it is consumed right after, so the page can't spend it.
 * Firefox's question before a folder reaches a page is answered yes for this
 * folder alone (content/filepicker.sys.mjs, expectOwnFolder).
 */
async function setInputFolder(input, folder) {
  if (!input.hasAttribute("webkitdirectory")) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "page.setInputFiles: the input takes files; a folder needs an input with webkitdirectory");
  }
  const doc = input.ownerDocument;
  const win = doc.defaultView;
  // Firefox's question before the folder reaches the input gets yes, for this folder in this frame, once.
  const delivered = awaitFileInput({ contentWindow: win, browsingContext: win.browsingContext }, { expectFiles: true, folder, input });
  try {
    openOwnChooser(() => {
      doc.notifyUserGestureActivation();
      try {
        input.showPicker();
      } finally {
        doc.consumeTransientUserGestureActivation();
      }
    });
  } catch (e) {
    if (e?.name === "InvalidStateError") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "page.setInputFiles: the input is disabled or read-only, so it takes no folder");
    }
    throw new ZenError("ZEN_INTERNAL", `page.setInputFiles: the input's folder chooser didn't open (${e?.message ?? e})`);
  }
  await delivered;
  return {};
}

/**
 * dragAndDrop: both ends resolved here, then four events 25 ms apart.
 *
 * On screen the parent calls it in three phases, for the cursor:
 * "prepare" resolves and stages both ends and dispatches nothing,
 * "press" moves to the source and presses there once the cursor has flown
 * to it, and "release" moves to the target and releases there once the
 * cursor has flown on. The page hears the same four events.
 */
export async function drag(actor, args) {
  if (args.phase === "press" || args.phase === "release") {
    return inputCall(actor.contentWindow, call => dragPhase(actor, args, call));
  }
  return inputCall(actor.contentWindow, call => dragIn(actor, args, call));
}

/** A drag between "prepare" and "release", by the actor's window: its token, ends, points and counters. */
const dragPending = new WeakMap();

async function dragPhase(actor, args, call) {
  const p = dragPending.get(actor.contentWindow);
  // The release goes where the target was staged, whatever the press did to
  // the page, as in one call.
  if (!p || p.token !== args.token || (args.phase === "press" && (!p.src.isConnected || !p.dst.isConnected))) {
    dragPending.delete(actor.contentWindow);
    throw transient("page.dragAndDrop failed: element is not connected");
  }
  const { win, a, b } = p;
  const button = args.options?.button ?? "left";
  const mask = BUTTON_MASK[button];
  if (args.phase === "press") {
    // The page had the cursor's flight to change: the source must still
    // take the press, as a click's target is checked after its flight.
    atPoint(win, a, "page.dragAndDrop");
    const interceptor = args.options?.force !== true && A.interceptingElementAtPoint(p.src, a);
    if (interceptor) {
      dragPending.delete(actor.contentWindow);
      throw transient(`page.dragAndDrop failed: ${A.describeHitTarget(interceptor)} intercepts pointer events`);
    }
    pointerEvent(win, "mousemove", a.x, a.y, { buttons: 0, mods: args.mods, call });
    await I.sleep(INPUT_EVENT_DELAY_MS);
    await C.untilFree(win, args.deadline, "press");
    pointerEvent(win, "mousedown", a.x, a.y, { button, buttons: mask, clickCount: 1, mods: args.mods, call });
    await I.sleep(INPUT_EVENT_DELAY_MS);
    return {};
  }
  dragPending.delete(actor.contentWindow);
  pointerEvent(win, "mousemove", b.x, b.y, { button, buttons: mask, mods: args.mods, call });
  await I.sleep(INPUT_EVENT_DELAY_MS);
  await C.untilFree(win, args.deadline, "release");
  pointerEvent(win, "mouseup", b.x, b.y, { button, buttons: 0, clickCount: 1, mods: args.mods, call });
  return { from: p.from, point: p.point, wheel: !!p.counters.wheel };
}

async function dragIn(actor, args, call) {
  const src = resolveTarget(actor, { ...args, target: args.source, ref: args.sourceRef, only: args.onlySource });
  const dst = resolveTarget(actor, { ...args, target: args.target, ref: args.targetRef, only: args.onlyTarget });
  if (src.frames || dst.frames) {
    // An end that isn't here may be in an out-of-process frame, or not on
    // the page yet: the parent chooses its frame, as for a click. `at`: the
    // frame of an end found here, which may be another of this process's.
    const at = r => r.el?.ownerDocument.defaultView.browsingContext.id;
    return { frames: { source: src.frames, target: dst.frames }, at: { source: at(src), target: at(dst) } };
  }
  const o = args.options ?? {};
  const counters = {};
  const stage = (el, position) =>
    pointStage(el, {
      action: "page.dragAndDrop",
      position,
      hitTest: o.force !== true,
      requireEnabled: false,
      stability: "strict",
      deadline: args.deadline,
      counters,
    });
  const win = src.el.ownerDocument.defaultView;
  const dwin = dst.el.ownerDocument.defaultView;
  if (dwin !== win) {
    // Two frames of this process: the parent drags across them (dragAim).
    return { split: { source: win.browsingContext.id, target: dwin.browsingContext.id } };
  }
  const a = await stage(src.el, o.sourcePosition);
  const b = await stage(dst.el, o.targetPosition);
  atPoint(win, a, "page.dragAndDrop");
  atPoint(win, b, "page.dragAndDrop");
  if (args.phase === "prepare") {
    const ends = { from: topPoint(src.el, a), point: topPoint(dst.el, b) };
    dragPending.set(actor.contentWindow, { token: args.token, win, src: src.el, dst: dst.el, a, b, counters, ...ends });
    return { prepared: true, ...ends };
  }
  const button = o.button ?? "left";
  const mask = BUTTON_MASK[button];
  pointerEvent(win, "mousemove", a.x, a.y, { buttons: 0, mods: args.mods, call });
  await I.sleep(INPUT_EVENT_DELAY_MS);
  await C.untilFree(win, args.deadline, "press");
  pointerEvent(win, "mousedown", a.x, a.y, { button, buttons: mask, clickCount: 1, mods: args.mods, call });
  await I.sleep(INPUT_EVENT_DELAY_MS);
  pointerEvent(win, "mousemove", b.x, b.y, { button, buttons: mask, mods: args.mods, call });
  await I.sleep(INPUT_EVENT_DELAY_MS);
  await C.untilFree(win, args.deadline, "release");
  pointerEvent(win, "mouseup", b.x, b.y, { button, buttons: 0, clickCount: 1, mods: args.mods, call });
  return { from: topPoint(src.el, a), point: topPoint(dst.el, b), wheel: !!counters.wheel };
}

// A drag between frames runs as Ego's does, in page coordinates: the
// press's frame gets the move to the source, the
// press and the move toward the target, and the frame under the drop point
// gets the release. Chromium keeps a pressed mouse's moves in the frame
// where the press began; Gecko would hand that move to the frame under it
// (zenius's press keeps no capture), so it goes to the press's document
// itself (heldMove). Ego's live run logged top:mousemove, top:mousedown,
// top:mousemove, frame:mouseup. The press then ends out of the page's sight
// in its own frame (dragDone): Gecko there needs its release. A draggable
// source starts no HTML drag: the moves after the press aren't Gecko's.

/** dragAndDrop between frames: one end, found and staged in this frame. */
export async function dragAim(actor, args) {
  return inputCall(actor.contentWindow, async () => {
    const source = args.end === "source";
    const r = resolveTarget(actor, { ...args, target: source ? args.source : args.target, ref: source ? args.sourceRef : args.targetRef, only: true });
    if (r.frames) {
      throw new ZenError("ZEN_SELECTOR_NOT_FOUND", "page.dragAndDrop: an end moved to another frame", { transient: true });
    }
    const o = args.options ?? {};
    const point = await pointStage(r.el, {
      action: "page.dragAndDrop",
      position: source ? o.sourcePosition : o.targetPosition,
      hitTest: o.force !== true,
      requireEnabled: false,
      stability: "strict",
      deadline: args.deadline,
      counters: {},
    });
    atPoint(r.el.ownerDocument.defaultView, point, "page.dragAndDrop");
    // `top`: as this process's top window sees it (the parent adds the rest).
    return { point, top: topPoint(r.el, point) };
  });
}

/** dragAndDrop between frames, in the source's frame: the move there, the press, and the held move toward the target (`toward`, in this frame's viewport). */
export async function dragPress(actor, args) {
  const win = actor.contentWindow;
  return inputCall(win, async call => {
    const { point: a, toward, mods } = args;
    const button = args.options?.button ?? "left";
    const mask = BUTTON_MASK[button];
    pointerEvent(win, "mousemove", a.x, a.y, { buttons: 0, mods, call });
    await I.sleep(INPUT_EVENT_DELAY_MS);
    await C.untilFree(win, args.deadline, "press");
    pointerEvent(win, "mousedown", a.x, a.y, { button, buttons: mask, clickCount: 1, mods, call });
    await I.sleep(INPUT_EVENT_DELAY_MS);
    stopAtDialog(win);
    heldMove(win, toward.x, toward.y, mask, mods);
    return {};
  });
}

/** A pressed mouse's move that stays in `win`'s document, as Chromium keeps it in the frame of the press. */
function heldMove(win, x, y, buttons, mods = []) {
  const doc = win.document;
  const target = doc.elementFromPoint(x, y) ?? doc.documentElement;
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    screenX: win.mozInnerScreenX + x,
    screenY: win.mozInnerScreenY + y,
    buttons,
    ctrlKey: mods.includes("Control"),
    shiftKey: mods.includes("Shift"),
    altKey: mods.includes("Alt"),
    metaKey: mods.includes("Meta"),
    view: win,
  };
  C.dispatchIn(win, () => {
    I.dispatchTrusted(target, new win.PointerEvent("pointermove", { ...init, pointerId: C.agentPointerId(), pointerType: "mouse", isPrimary: true }));
    I.dispatchTrusted(target, new win.MouseEvent("mousemove", init));
  });
}

/** dragAndDrop between frames, in the target's frame: the release at the drop point. */
export async function dragRelease(actor, args) {
  const win = actor.contentWindow;
  return inputCall(win, async call => {
    await C.untilFree(win, args.deadline, "release");
    pointerEvent(win, "mouseup", args.point.x, args.point.y, { button: args.options?.button ?? "left", buttons: 0, clickCount: 1, mods: args.mods, call });
    return {};
  });
}

/** dragAndDrop between frames, back in the source's frame: its press ends, out of the page's sight. */
export function dragDone(actor, args) {
  const win = actor.contentWindow;
  if (!win) {
    return {};
  }
  heldButtons.set(I.processTopWindow(win), 0);
  releaseHiddenly(win, args.point.x, args.point.y, args.options?.button ?? "left", args.mods ?? []);
  return {};
}

/**
 * Watches for a click that would open a file chooser, and for a chooser the
 * page asks for itself during the action (showPicker()), so
 * the parent knows how long to wait for one after the action. Ego's probe
 * wraps the input's click() and showPicker() for the same.
 */
function fileInputProbe(win) {
  const probe = { seen: false };
  const listener = e => {
    const t = e.composedTarget ?? e.target;
    const input = t?.localName === "label" ? t.control : t;
    if (input?.localName === "input" && String(input.type).toLowerCase() === "file") {
      probe.seen = true;
    }
  };
  const opts = { capture: true, mozSystemGroup: true };
  win.addEventListener("click", listener, opts);
  const browserId = win.browsingContext?.browserId;
  const off = onChooserOpening(id => {
    if (browserId && id === browserId) {
      probe.seen = true;
    }
  });
  probe.stop = () => {
    win.removeEventListener("click", listener, opts);
    off();
  };
  return probe;
}

// ---------------------------------------------------------------- focus

function deepActiveElement(doc) {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

/**
 * Ego's focus rule: the element, else a strong focus target among its
 * ancestors, else its unique editable descendant. Fires the focus events a
 * focused tab would. Returns the element that has focus.
 */
function focusForAction(el) {
  if (!el.isConnected) {
    throw transient("page.focus failed: element is not connected");
  }
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const tryFocus = candidate => {
    if (typeof candidate.focus !== "function") {
      return null;
    }
    const prev = I.focusedElement(win);
    candidate.focus();
    const active = deepActiveElement(doc);
    if (active === candidate || A.containsComposed(candidate, active)) {
      const host = I.editingHost(active);
      if (host) {
        I.ensureCaretIn(host);
      }
      I.emulateFocusChange(prev, I.focusedElement(win));
      return active;
    }
    return null;
  };
  const direct = tryFocus(el);
  if (direct) {
    return direct;
  }
  for (let ancestor = A.composedParent(el); ancestor; ancestor = A.composedParent(ancestor)) {
    if (A.isStrongFocusTarget(ancestor)) {
      const focused = tryFocus(ancestor);
      if (focused) {
        return focused;
      }
    }
  }
  const editable = A.composedDescendantMatches(el, A.isEditableFocusTarget, true);
  if (editable.length === 1) {
    const focused = tryFocus(editable[0]);
    if (focused) {
      return focused;
    }
  }
  const active = deepActiveElement(doc);
  const details = `(${String(el.tagName || "element").toLowerCase()}, contenteditable=${Boolean(el.isContentEditable)}, tabIndex=${el.tabIndex}, active=${String(active?.tagName || "none").toLowerCase()}`;
  if (editable.length > 1) {
    throw new ZenError(
      "ZEN_SELECTOR_AMBIGUOUS",
      `page.focus failed: element contains multiple editable targets ${details}, candidates=${editable.length})`,
      { matches: editable.length }
    );
  }
  throw new ZenError("ZEN_NOT_ACTIONABLE", `page.focus failed: element is not focusable ${details})`, { reason: "hidden" });
}

// ---------------------------------------------------------------- fill

const TEXT_INPUT_TYPES = new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);
const DIRECT_INPUT_TYPES = new Set(["color", "date", "time", "datetime-local", "month", "range", "week"]);

function observedValue(el) {
  const tag = el.localName;
  return tag === "input" || tag === "textarea" ? el.value : (el.innerText ?? el.textContent ?? "");
}

/** Ego's preparation: checks, direct types, focus, select-all when clearing. */
function prepareFill(el, value, clearFirst) {
  if (!el.isConnected) {
    return { error: "element is not connected" };
  }
  const tag = el.localName;
  const observed = observedValue(el);
  const view = el.ownerDocument.defaultView;
  const rect = el.getBoundingClientRect();
  const style = view?.getComputedStyle(el);
  if (!view || rect.width <= 0 || rect.height <= 0 || style?.visibility === "hidden" || style?.display === "none") {
    return { error: "element is not visible" };
  }
  if (A.isActionTargetDisabled(el)) {
    return { error: "element is disabled" };
  }
  if (el.readOnly) {
    return { error: "element is read only" };
  }
  if (tag === "input") {
    const type = String(el.type).toLowerCase();
    if (!TEXT_INPUT_TYPES.has(type) && !DIRECT_INPUT_TYPES.has(type)) {
      return { error: `input type "${type}" cannot be filled` };
    }
    if (type === "number" && value.trim() !== "" && Number.isNaN(Number(value.trim()))) {
      return { error: "cannot type non-numeric text into input[type=number]" };
    }
    if (DIRECT_INPUT_TYPES.has(type)) {
      const next = value.trim();
      focusQuietly(el);
      if (A.isActionTargetDisabled(el)) {
        return { error: "element is disabled" };
      }
      el.value = next;
      if (el.value !== next) {
        return { error: "malformed value" };
      }
      // Inside dispatchIn: zenius's events, not the user's (content/typing.sys.mjs).
      C.dispatchIn(view, () => {
        el.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new view.Event("change", { bubbles: true }));
      });
      return { status: "done", kind: "input", cursorPoint: visibleCenter(el) };
    }
  } else if (tag !== "textarea" && !el.isContentEditable) {
    return { error: "element is not an input, textarea, or contenteditable element" };
  }
  focusQuietly(el);
  if (A.isActionTargetDisabled(el)) {
    return { error: "element is disabled" };
  }
  const details = { status: "needsinput", kind: el.isContentEditable ? "contenteditable" : tag, cursorPoint: visibleCenter(el), before: String(observed) };
  if (!clearFirst) {
    return details;
  }
  if (tag === "input" || tag === "textarea") {
    el.select();
  } else {
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    const selection = view.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return details;
}

/** focus({preventScroll}) with the events a focused tab would fire. */
function focusQuietly(el) {
  const win = el.ownerDocument.defaultView;
  const prev = I.focusedElement(win);
  el.focus({ preventScroll: true });
  const now = I.focusedElement(win);
  const host = I.editingHost(now);
  if (host) {
    I.ensureCaretIn(host);
  }
  I.emulateFocusChange(prev, now);
}

const PERMANENT_FILL_ERRORS = /cannot be filled|non-numeric|malformed value|not an input, textarea/;

function fillPreparationError(message) {
  const text = `page.fill failed: ${message}`;
  if (PERMANENT_FILL_ERRORS.test(message)) {
    return new ZenError("ZEN_INVALID_ARGUMENT", text);
  }
  return transient(text);
}

/** Insert the value the way CDP Input.insertText does; "" with clearFirst is a Delete key. */
function dispatchFillInput(el, value, clearFirst, args) {
  const win = el.ownerDocument.defaultView;
  if (clearFirst && value.length === 0) {
    const def = { key: "Delete", code: "Delete", keyCode: 46, location: 0 };
    stopAtDialog(win);
    I.keyEvent(win, "down", def, { mods: [] });
    stopAtDialog(win);
    I.keyEvent(win, "up", def, { mods: [] });
    return;
  }
  if (value.length > 0) {
    stopAtDialog(win);
    I.insertText(el.ownerDocument, value);
  }
}

function classifyFillOutcome(beforeValue, expectedValue, actualValue, clearFirst, inputType) {
  const normalize = text => String(text).replace(/\r\n?/g, "\n").replace(/\u200b/g, "");
  const before = normalize(beforeValue);
  const expected = normalize(expectedValue);
  const actual = normalize(actualValue);
  if (clearFirst ? actual === expected : actual.includes(expected)) {
    return "exact";
  }
  if (inputType === "number" && expected.trim() !== "" && actual.trim() !== "" && Number(actual) === Number(expected)) {
    return "equivalent";
  }
  const integerExpected = expected.normalize("NFKC").trim();
  if (/^\d+$/.test(integerExpected)) {
    const actualDigits = actual.normalize("NFKC").replace(/\D/g, "");
    if (actualDigits === integerExpected) {
      return "equivalent";
    }
    const beforeDigits = before.normalize("NFKC").replace(/\D/g, "");
    if (clearFirst && beforeDigits.length > 0 && actualDigits === beforeDigits + integerExpected) {
      return "appended";
    }
  }
  if (clearFirst && actual === before + expected && before.length > 0) {
    return "appended";
  }
  return actual === before ? "unchanged" : "transformed";
}

const ACCEPTED = new Set(["exact", "equivalent", "transformed"]);

async function verifyFill(el, before, value, clearFirst) {
  // Ego reads back in a later command: after the page's microtasks, which
  // may undo the text.
  await I.settleMicrotasks();
  let prior;
  let consecutive = 0;
  let last = "unchanged";
  for (let attempt = 0; attempt < FILL_VERIFICATION_ATTEMPTS; attempt += 1) {
    // Ego's read-back is a later command, which fails once a dialog opened.
    stopAtDialog(el.ownerDocument.defaultView);
    if (!el.isConnected) {
      throw new ZenError("ZEN_INTERNAL", "page.fill could not verify the result: element is not connected");
    }
    const actual = String(observedValue(el));
    const type = el.localName === "input" ? String(el.type).toLowerCase() : "";
    const outcome = classifyFillOutcome(before, value, actual, clearFirst, type);
    last = outcome;
    if (ACCEPTED.has(outcome)) {
      return outcome;
    }
    const reading = `${outcome}\u0000${actual}`;
    if (reading === prior) {
      if (++consecutive === 2) {
        return outcome;
      }
    } else {
      prior = reading;
      consecutive = 1;
    }
    if (attempt + 1 < FILL_VERIFICATION_ATTEMPTS) {
      await I.sleep(FILL_VERIFICATION_INTERVAL_MS);
    }
  }
  return last;
}

/** Ego's one pointer activation for editors that ignored the text. */
async function activateEditor(el, args) {
  const point = await pointStage(el, {
    action: "page.fill",
    hitTest: true,
    stability: "recompute",
    requireEnabled: false,
    deadline: args.deadline,
    counters: args.counters,
  });
  const interceptor = A.interceptingElementAtPoint(el, point);
  if (interceptor) {
    throw transient(`page.click failed: ${A.describeHitTarget(interceptor)} intercepts pointer events`);
  }
  for (let current = A.hitElementAtPoint(el, point); current && current !== el; current = A.composedParent(current)) {
    if (A.isExplicitInteractiveElement(current)) {
      throw new ZenError(
        "ZEN_NOT_ACTIONABLE",
        `page.fill cannot safely activate the editor because ${A.describeHitTarget(current)} would receive the click`,
        { reason: "covered" }
      );
    }
  }
  const win = el.ownerDocument.defaultView;
  pointerEvent(win, "mousemove", point.x, point.y, { buttons: 0, call: args.call });
  if (A.isActionTargetDisabled(el)) {
    throw transient("page.fill failed: element is disabled");
  }
  await C.untilFree(win, args.deadline, "press");
  pointerEvent(win, "mousedown", point.x, point.y, { button: "left", buttons: 1, clickCount: 1, call: args.call });
  await C.untilFree(win, args.deadline, "release");
  pointerEvent(win, "mouseup", point.x, point.y, { button: "left", buttons: 0, clickCount: 1, call: args.call });
}

async function fillElement(matched, args) {
  const value = args.value;
  const clearFirst = args.options?.clearFirst ?? true;
  let el;
  try {
    el = A.fillTarget(matched);
  } catch (e) {
    throw new ZenError("ZEN_SELECTOR_AMBIGUOUS", e.message);
  }
  // Scroll only: a moving or covered field can still be filled.
  await pointStage(el, {
    action: "page.fill",
    hitTest: false,
    stability: "none",
    requireEnabled: false,
    deadline: args.deadline,
    counters: args.counters,
  });
  let prep = prepareFill(el, value, clearFirst);
  if (prep.error) {
    throw fillPreparationError(prep.error);
  }
  const cursor = topPoint(el, prep.cursorPoint);
  if (prep.status === "done") {
    return { point: cursor };
  }
  if (A.isActionTargetDisabled(el)) {
    throw transient("page.fill failed: element is disabled");
  }
  dispatchFillInput(el, value, clearFirst, args);
  let outcome = await verifyFill(el, prep.before, value, clearFirst);
  if (ACCEPTED.has(outcome)) {
    return { point: cursor };
  }
  await activateEditor(el, args);
  prep = prepareFill(el, value, clearFirst);
  if (prep.error) {
    throw fillPreparationError(prep.error);
  }
  if (prep.status !== "needsinput") {
    throw new ZenError("ZEN_INTERNAL", "page.fill received an invalid preparation result");
  }
  if (A.isActionTargetDisabled(el)) {
    throw transient("page.fill failed: element is disabled");
  }
  dispatchFillInput(el, value, clearFirst, args);
  outcome = await verifyFill(el, prep.before, value, clearFirst);
  if (ACCEPTED.has(outcome)) {
    return { point: cursor };
  }
  const what = prep.kind === "contenteditable" ? "editor" : "field";
  throw new ZenError("ZEN_NOT_ACTIONABLE", `page.fill did not accept the text. Click the ${what} and use page.keyboard, then verify the result.`);
}

// ---------------------------------------------------------------- selectOption

function selectOptions(matched, choices) {
  const t = A.selectTarget(matched);
  if (t.error) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `page.selectOption failed: ${t.error}`);
  }
  const select = t.select;
  if (!select.isConnected) {
    throw transient("page.selectOption failed: element is not connected");
  }
  const view = select.ownerDocument.defaultView;
  const rect = select.getBoundingClientRect();
  const style = view?.getComputedStyle(select);
  if (!view || rect.width <= 0 || rect.height <= 0 || style?.display === "none" || style?.visibility === "hidden") {
    throw transient("page.selectOption failed: element is not visible");
  }
  if (A.isActionTargetDisabled(select)) {
    throw transient("page.selectOption failed: element is disabled");
  }
  const options = Array.from(select.options);
  const chosen = [];
  let remaining = choices.slice();
  const matches = (choice, option, index) =>
    typeof choice === "string"
      ? option.value === choice || option.label === choice
      : (choice.value === undefined || option.value === choice.value) &&
        (choice.label === undefined || option.label === choice.label) &&
        (choice.index === undefined || index === choice.index);
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (remaining.find(choice => matches(choice, option, index)) === undefined) {
      continue;
    }
    chosen.push(option);
    if (!select.multiple) {
      remaining = [];
      break;
    }
    remaining = remaining.filter(choice => !matches(choice, option, index));
  }
  if (remaining.length > 0) {
    const available = options.map((o, i) => `${i}: value=${JSON.stringify(o.value)}, label=${JSON.stringify(o.label)}`).join("; ");
    throw new ZenError(
      "ZEN_SELECTOR_NOT_FOUND",
      `page.selectOption failed: option ${JSON.stringify(remaining[0])} was not found; available options: ${available || "(none)"}`,
      { transient: true }
    );
  }
  for (const option of options) {
    option.selected = false;
  }
  for (const option of chosen) {
    option.selected = true;
  }
  const selected = Array.from(select.selectedOptions, o => o.value);
  // Inside dispatchIn: zenius's events, not the user's (content/typing.sys.mjs).
  C.dispatchIn(view, () => {
    select.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
    select.dispatchEvent(new view.Event("change", { bubbles: true }));
  });
  return { selected, point: topPoint(select, visibleCenter(select)) };
}

// ---------------------------------------------------------------- page.mouse

// How long a raw mouse step waits for another tab, when the parent gives no deadline.
const RAW_MOUSE_WAIT_MS = 3000;

/**
 * One raw mouse step: it waits while the user composes or holds a press in
 * another tab, and a step a press there took (and dropped) goes again.
 */
async function rawStep(win, what, deadline, send) {
  for (;;) {
    await C.untilFree(win, deadline, what);
    try {
      return await send();
    } catch (e) {
      if (e?.data?.reason !== "mouse_held_elsewhere" || Date.now() >= deadline) {
        throw e;
      }
      await I.sleep(50);
    }
  }
}

function lastPoint(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].x !== undefined) {
      return steps[i];
    }
  }
  return null;
}

/**
 * Dispatch mouse steps given in this frame's viewport px:
 * {t: "move"|"down"|"up", x, y, button, clickCount, buttons: [names], mods},
 * {t: "wheel", x, y, dx, dy, mods} or {t: "sleep", ms}.
 *
 * @param {JSWindowActorChild} actor
 * @param {{steps: object[], captureBcId?: number|null, guardChooser?: boolean}} args
 */
export async function mouse(actor, { steps, captureBcId, guardChooser, deadline }) {
  const win = actor.contentWindow;
  const here = actor.browsingContext.id;
  let hop = null;
  if (captureBcId && captureBcId !== here) {
    hop = hopToward(captureBcId);
  } else if (!captureBcId) {
    const p = lastPoint(steps);
    hop = p ? remoteFrameAt(actor.document, p.x, p.y) : null;
  }
  if (hop) {
    return {
      forward: {
        bcId: hop.bcId,
        args: { steps: shiftSteps(steps, hop.ox, hop.oy), captureBcId: captureBcId || null },
      },
    };
  }
  // Where something happens: presses, releases, wheels, and where the
  // pointer ends up. Passing over a frame on the way is only a hover.
  const last = lastPoint(steps);
  for (const s of steps) {
    if (s.t === "down" || s.t === "up" || s.t === "wheel" || s === last) {
      atPoint(win, s, "page.mouse");
    }
  }
  const until = deadline ?? Date.now() + RAW_MOUSE_WAIT_MS;
  // A press that an earlier call made (page.mouse.down) stays the agent's to
  // release; inputCall releases only this call's own.
  return inputCall(
    win,
    async call => {
      const result = { bcId: here };
      const probe = guardChooser ? fileInputProbe(win) : null;
      try {
        for (const s of steps) {
          switch (s.t) {
            case "sleep":
              await I.sleep(s.ms);
              break;
            case "wheel": {
              // Checked once, not retried: a motion cut short partway has
              // already scrolled.
              await C.untilFree(win, until, "move");
              // The call's deadline bounds a wait for the user's scroll.
              const chained = result.chained ?? { bcId: null, dx: 0, dy: 0 };
              await wheelMotion(win, { x: s.x, y: s.y, deltaX: s.dx, deltaY: s.dy }, until, s.mods, chained);
              if (chained.bcId) {
                result.chained = chained;
              }
              break;
            }
            case "move":
              await rawStep(win, "move", until, () =>
                pointerEvent(win, "mousemove", s.x, s.y, { button: "left", buttons: maskOf(s.buttons), mods: s.mods, call })
              );
              break;
            case "down":
            case "up":
              await rawStep(win, s.t === "down" ? "press" : "release", until, () =>
                pointerEvent(win, s.t === "down" ? "mousedown" : "mouseup", s.x, s.y, {
                  button: s.button,
                  buttons: maskOf(s.buttons),
                  clickCount: s.clickCount,
                  mods: s.mods,
                  call,
                })
              );
              break;
          }
        }
      } finally {
        probe?.stop();
      }
      if (probe) {
        result.fileInputClicked = probe.seen;
      }
      if (call.openLinks) {
        result.openLinks = call.openLinks;
      }
      return result;
    },
    { bcId: here }
  );
}

/**
 * The rest of a wheel's scroll, past `frameBcId`'s frame in this document,
 * as if the wheel had chained out of it (methods/actions.sys.mjs
 * chainWheel). The frame's page heard the wheel; this page hears none.
 *
 * @returns {{chained?: {bcId: number, dx: number, dy: number}}} what goes on past this document
 */
export function scrollFromFrame(actor, { frameBcId, dx, dy }) {
  const frame = BrowsingContext.get(frameBcId)?.embedderElement;
  if (!frame?.isConnected) {
    return {};
  }
  const chosen = I.scrollFromWheel(frame, dx, dy);
  return chosen?.out ? { chained: { bcId: chosen.out.id, dx, dy } } : {};
}

// ---------------------------------------------------------------- page.keyboard

/** The out-of-process frame that holds focus, if focus left this process. */
function focusHop(doc) {
  const el = I.deepestActive(doc);
  if (!el || !I.isFrameElement(el)) {
    return null;
  }
  const bc = el.browsingContext;
  return bc && !bc.docShell ? { bcId: bc.id } : null;
}

function focusedWindow(win) {
  const el = I.focusedElement(win);
  return el?.ownerDocument?.defaultView ?? win;
}

/**
 * Run keyboard steps in the focused frame:
 * {k: "down"|"up", def: {key, code, keyCode, location}, mods, repeat},
 * {k: "insert", text} or {k: "sleep", ms}. Clipboard chords act on the
 * Space's clipboard (`clipboard`, zen-ux's ClipData, or `pasteContent`
 * {text, html} for keyboard.paste).
 *
 * @returns {{clipboard?: object}} ClipData that a copy or cut produced
 */
export async function keyboard(actor, args) {
  if (args.tabFrom) {
    // A Tab went past the end of a cross-site frame in this document: focus
    // goes on after the frame's element, before the rest of the keys.
    const frame = BrowsingContext.get(args.tabFrom.frame)?.embedderElement;
    const left = frame ? I.tabInPage(frame.ownerDocument.defaultView, args.tabFrom.forward, frame) : null;
    if (left) {
      return { forward: { bcId: actor.browsingContext.parent.id, args: { tabFrom: { ...args.tabFrom, frame: left.leftFrame } } } };
    }
    if (frame) {
      // The frame heard its blur in its own process.
      I.emulateFocusChange(null, I.focusedElement(frame.ownerDocument.defaultView));
    }
  }
  const hop = focusHop(actor.document);
  if (hop) {
    return { forward: { bcId: hop.bcId, args: { tabFrom: null } } };
  }
  // What the keys did before a dialog cut them short (a copy) still counts.
  const out = args.carry ?? { bcId: actor.browsingContext.id };
  return inputCall(actor.contentWindow, () => runKeySteps(actor.contentWindow, args, out), out);
}

async function runKeySteps(win, { steps, isMac, clipboard, pasteContent, guardChooser }, out = {}) {
  const probe = guardChooser ? fileInputProbe(win) : null;
  try {
    for (const [index, s] of (steps ?? []).entries()) {
      if (index > 0) {
        await I.settleMicrotasks();
      }
      stopAtDialog(win);
      if (s.k === "sleep") {
        await I.sleep(s.ms);
        continue;
      }
      const kwin = focusedWindow(win);
      // Keys go to the focused frame; a key that moved focus into one that
      // isn't web content (Tab into an error page's frame) can't act there.
      checkLanding(kwin.document, "page.keyboard", "the focused element");
      if (s.k === "insert") {
        I.insertText(kwin.document, s.text);
        continue;
      }
      const prev = I.focusedElement(win);
      I.ensureEditorCaret(prev);
      // Focus may have moved since (a page's own focus(), autofocus).
      I.syncDateTimeFocus(kwin);
      const guard = I.interceptShortcuts(kwin, isMac);
      let consumed = false;
      try {
        consumed = I.keyEvent(kwin, s.k, s.def, { mods: s.mods, repeat: s.repeat });
      } finally {
        guard.stop();
      }
      let left = null;
      for (const req of guard.requests) {
        if (req.op === "tab") {
          left = I.tabInPage(kwin, req.forward) ? { forward: req.forward } : left;
        }
      }
      if (s.k === "down" && !consumed && !guard.requests.some(req => req.op === "tab")) {
        I.keepInEditingHost(prev, I.focusedElement(win));
      }
      I.emulateFocusChange(prev, I.focusedElement(win));
      for (const req of guard.requests) {
        if (req.op === "tab") {
          continue;
        }
        if (req.op === "save") {
          out.save = true;
          continue;
        }
        if (req.op === "paste") {
          const content = pasteContent ? I.toClipData(pasteContent) : (clipboard ?? {});
          const into = focusedWindow(win);
          if (!req.plain && typeof content["text/html"] === "string" && content["text/html"] !== "") {
            // Any html the agent's input pastes, page.keyboard's or the
            // Space clipboard's: the parent marks the document it goes into
            // (markPastedHtml), sanitized as it is, as a second layer.
            (out.htmlPastedIn ??= []).push(into.browsingContext.id);
            // And it counts as written here at once, before the paste: a
            // page's paste handler may insert it as live markup (zen-observe's
            // glue).
            lazy.noteWrittenWindow(into);
            // Evidence against the page only when the markup carries what
            // zen-observe counts as hooked: here at once, before the paste,
            // and in the parent. Inert markup,
            // formatted text into a mail or a document, is none.
            const hooked = I.hookedPaste(into, content["text/html"]);
            if (hooked) {
              lazy.markHooked(into, `a paste with ${hooked}`);
            }
          }
          I.pasteInto(into, content, { plain: req.plain });
          continue;
        }
        if (req.content) {
          out.clipboard = req.content;
          // zen-ux's glue: the Space's clipboard is readable by this origin only.
          out.clipboardOrigin = kwin.document.nodePrincipal.origin;
          out.bcId = I.processTopWindow(kwin).browsingContext.id;
          // A later paste in the same call uses what was just copied.
          clipboard = req.content;
        }
      }
      if (left) {
        // Tabbed out of this cross-site frame: the rest of the keys go to the
        // document around it, which moves focus on first.
        const frame = I.processTopWindow(win).browsingContext;
        if (probe) {
          out.fileInputClicked = probe.seen;
        }
        return {
          forward: {
            bcId: frame.parent.id,
            args: { steps: steps.slice(index + 1), tabFrom: { frame: frame.id, forward: left.forward }, carry: out, clipboard },
          },
        };
      }
    }
    if (steps?.length) {
      // The last key's microtasks too, before the probe is read: a page's
      // handler may click a file input from one.
      await I.settleMicrotasks();
    }
  } finally {
    probe?.stop();
  }
  if (probe) {
    out.fileInputClicked = probe.seen;
  }
  return out;
}

// ---------------------------------------------------------------- idle probe

const idleStates = new WeakMap();

function requestsInFlight(doc) {
  const group = doc.documentLoadGroup;
  if (!group) {
    return 0;
  }
  let n = 0;
  for (const request of group.requests) {
    try {
      if (request.QueryInterface(Ci.nsIRequest).isPending()) {
        n++;
      }
    } catch {}
  }
  return n;
}

/**
 * How long the page has been idle: no DOM mutation, no request in flight,
 * loaded, visible, no same-process frame still loading. The first probe
 * starts watching and reads 0, as Ego's does.
 */
export async function idleProbe(actor) {
  const win = actor.contentWindow;
  const doc = win.document;
  const now = Date.now();
  let s = idleStates.get(doc);
  if (!s) {
    s = { dom: now, net: now };
    s.observer = new win.MutationObserver(() => {
      s.dom = Date.now();
    });
    s.observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    idleStates.set(doc, s);
    return { idleMs: 0 };
  }
  if (doc.readyState !== "complete" || doc.visibilityState !== "visible") {
    return { idleMs: 0 };
  }
  for (const c of R.contextsFrom(win).slice(1)) {
    if (c.win && c.win.document.readyState !== "complete") {
      return { idleMs: 0 };
    }
  }
  if (requestsInFlight(doc) > 0) {
    s.net = now;
    return { idleMs: 0 };
  }
  return { idleMs: Math.max(0, Math.min(now - s.dom, now - s.net)) };
}

/** A round trip through this frame's process: what it queued before ran. */
export function ping() {
  return {};
}

/** How long a folder's walk may take before its input event. */
const FOLDER_WAIT_MS = 10000;

/**
 * Resolves once a chooser's files reached a file input of this frame and its
 * input and change events have run (or after 2 s). Called before the parent
 * answers the chooser.
 *
 * A folder (`folder`, the path the parent staged) passes Firefox's folder
 * question once, in this frame, until this ends. Gecko walks it after the
 * answer and fires input and change when the walk ends, so this waits for
 * them, up to FOLDER_WAIT_MS: on the window, on `input` when the caller
 * knows it, and on the input that opened the chooser, which zenius's picker
 * names with the answer (an input the page never attached sends them only
 * to itself). If the question wasn't answered yes, nothing was attached, and
 * this fails.
 */
export function awaitFileInput(actor, { expectFiles, folder = null, input = null }) {
  const win = actor.contentWindow;
  const lapse = folder ? expectOwnFolder(actor.browsingContext, folder) : null;
  return new Promise((resolve, reject) => {
    const opts = { capture: true, mozSystemGroup: true };
    let timer;
    let offAnswered = null;
    let failure = null;
    const targets = input ? [win, input] : [win];
    const listen = t => {
      targets.includes(t) || targets.push(t);
      t.addEventListener("input", onInput, opts);
      t.addEventListener("cancel", onInput, opts);
    };
    const done = () => {
      lapse?.();
      for (const t of targets) {
        t.removeEventListener("input", onInput, opts);
        t.removeEventListener("cancel", onInput, opts);
      }
      offAnswered?.();
      I.clearTimeout(timer);
      if (failure) {
        reject(failure);
      } else {
        resolve({});
      }
    };
    // input is composed, so it reaches the window from shadow trees; change
    // follows it in the same task, so wait one more task for its handlers.
    // Only Gecko's own counts: a page's synthetic one reaches these
    // listeners too, and would end the wait early.
    const onInput = e => {
      if (!e.isTrusted) {
        return;
      }
      const t = e.composedTarget ?? e.target;
      if (t?.localName === "input" && String(t.type).toLowerCase() === "file") {
        I.setTimeout(done, 0);
      }
    };
    for (const t of [...targets]) {
      listen(t);
    }
    // An input the page never attached: its events never reach the window,
    // but zenius's picker in this process sees the input's callback return,
    // with its files set and its handlers run. A folder's
    // events come later, from Gecko's walk, at the input the picker names.
    offAnswered = onChooserAnswered(actor.browsingContext, (result, info) => {
      if (!folder || !info?.folder || result !== Ci.nsIFilePicker.returnOK) {
        done();
      } else if (!info.confirmed) {
        failure = new ZenError("ZEN_INTERNAL", "the folder wasn't attached: Firefox's folder question was answered Cancel");
        done();
      } else if (info.input && !targets.includes(info.input)) {
        listen(info.input);
      }
    });
    timer = I.setTimeout(done, folder ? FOLDER_WAIT_MS : expectFiles ? 2000 : 100);
  });
}
