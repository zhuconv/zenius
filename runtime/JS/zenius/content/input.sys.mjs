// Input synthesis in the page's own process (zen-input).
//
// Everything here works in a tab the user can't see and never reaches the
// parent: mouse events go through window.synthesizeMouseEvent, keys through
// nsITextInputProcessor, text through the element's editor. See
// docs/research/background-input.md for why each mechanism was chosen.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { keyDefinition, MODIFIER_NAMES } from "chrome://userscripts/content/zenius/content/keys.sys.mjs";
import { blockedError, blocker, dispatchIn, dispatchPointer, pressElsewhere } from "chrome://userscripts/content/zenius/content/capture.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** Timers that aren't throttled with the page's own timers. */
export const setTimeout = (fn, ms) => lazy.setTimeout(fn, ms);
export const clearTimeout = id => lazy.clearTimeout(id);

const MOZ_SOURCE_MOUSE = 1;
const MOUSE_BUTTONS = { left: 0, middle: 1, right: 2, back: 3, forward: 4 };
const BUTTON_BITS = [1, 4, 2, 8, 16]; // MouseEvent.buttons bit per button number
const MOD_CODES = { Shift: "ShiftLeft", Control: "ControlLeft", Alt: "AltLeft", Meta: "MetaLeft" };

/** Timer that isn't throttled with the page's own timers. */
export function sleep(ms) {
  return ms > 0 ? new Promise(r => lazy.setTimeout(r, ms)) : Promise.resolve();
}

/** Let pending tasks (input event side effects, microtasks) run once. */
export function tick() {
  return new Promise(r => Services.tm.dispatchToMainThread(r));
}

/** Hops in settleMicrotasks(): a page's chain of microtasks (an async handler's awaits) runs out well within this. */
const MICROTASK_HOPS = 16;

/**
 * Let the page's pending microtasks run, and the ones they chain, but no
 * other task: each await queues behind what is already queued. A real key
 * ends its task, so the page's microtasks run before the next key, and
 * Ego's keys and its fill's read-back are separate commands. Without this,
 * a call's keys all ran before any of the page's microtasks, and fill read
 * the field back before a microtask undid the text (input-gaps.md B5). No
 * task gets in, so a navigation or a timer can't come between two keys.
 */
export async function settleMicrotasks() {
  for (let i = 0; i < MICROTASK_HOPS; i++) {
    await null;
  }
}

// ---------------------------------------------------------------- mouse

/** @param {string[]} mods held modifier names */
export function modifierMask(utils, mods) {
  let mask = 0;
  for (const m of mods ?? []) {
    mask |= { Shift: utils.MODIFIER_SHIFT, Control: utils.MODIFIER_CONTROL, Alt: utils.MODIFIER_ALT, Meta: utils.MODIFIER_META }[m] ?? 0;
  }
  return mask;
}

export function buttonNumber(name) {
  const n = MOUSE_BUTTONS[name ?? "left"];
  if (n === undefined) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `Unknown mouse button: ${JSON.stringify(name)}`);
  }
  return n;
}

/** MouseEvent.buttons for a set of pressed button numbers. */
export function buttonsMask(pressed) {
  let mask = 0;
  for (const b of pressed ?? []) {
    mask |= BUTTON_BITS[b] ?? 0;
  }
  return mask;
}

/**
 * One trusted mouse event at viewport CSS px of `win`'s document.
 * isDOMEventSynthesized: false so nothing marks it as a test event.
 *
 * @returns {boolean} whether the page called preventDefault()
 */
export function mouseEvent(win, type, x, y, { button = 0, buttons, clickCount = 1, mods } = {}) {
  // Nothing goes out while another tab of the process holds a press: Gecko
  // would give it the event, and even dropped there a move still extends a
  // selection drag (nsIFrame::HandleDrag ignores the event's status). Nor a
  // press or release while the user composes in another tab, which it
  // would commit (content/capture.sys.mjs).
  const what = type === "mouseup" ? "release" : type === "mousemove" ? "move" : "press";
  const why = what === "move" ? (pressElsewhere(win) ? "mouse_held_elsewhere" : null) : blocker(win);
  if (why) {
    throw blockedError(why, what);
  }
  const utils = win.windowUtils;
  const data = {
    identifier: utils.DEFAULT_MOUSE_POINTER_ID,
    button,
    clickCount,
    modifiers: modifierMask(utils, mods),
    inputSource: MOZ_SOURCE_MOUSE,
  };
  if (buttons !== undefined) {
    data.buttons = buttons;
  }
  // Flagged as synthesized for tests, like the keyboard's test transaction:
  // otherwise Gecko's input-event security delay (dom.input_events.security.*)
  // silently drops real-looking mouse input for the first few dozen ms after
  // a document is shown, and a hidden agent tab's refresh driver doesn't tick
  // to end it. Pages see the same trusted events either way. The flag is
  // also how the capture guard tells zenius's events from the user's.
  const send = (w, t, px, py, b) =>
    w.synthesizeMouseEvent(t, px, py, b === undefined ? data : { ...data, buttons: b }, {
      isDOMEventSynthesized: true,
      isWidgetEventSynthesized: false,
      isAsyncEnabled: false,
    });
  // A move counts from zenius's own last point in the tab, not from the
  // process's last move, which may be the user's in another tab; and the
  // pointer leaves the tab after the call (content/capture.sys.mjs).
  const sent = dispatchPointer(win, type, x, y, send);
  if (!sent) {
    // A press held in another tab of the process (the user's text
    // selection, a drag, another task's mouse.down) took it, as Gecko gives
    // that tab every mouse event of the process; that tab dropped it.
    throw blockedError("mouse_held_elsewhere", what);
  }
  return true;
}

// ---------------------------------------------------------------- keys

const tips = new WeakMap();

/**
 * A text input processor bound to `win`. Content processes can only send
 * keys through a test transaction (the normal one throws
 * NS_ERROR_NOT_AVAILABLE on keydown); pages can't tell the difference.
 */
export function tipFor(win) {
  let tip = tips.get(win);
  if (!tip) {
    tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    tips.set(win, tip);
  }
  if (!tip.beginInputTransactionForTests(win)) {
    throw new ZenError("ZEN_INTERNAL", "could not start a keyboard input transaction");
  }
  return tip;
}

/** Make the processor's modifier state equal `mods` without dispatching events. */
export function syncModifiers(tip, win, mods) {
  const want = new Set(mods ?? []);
  for (const name of MODIFIER_NAMES) {
    if (tip.getModifierState(name) !== want.has(name)) {
      const ev = new win.KeyboardEvent("", { key: name, code: MOD_CODES[name] });
      const flags = tip.KEY_NON_PRINTABLE_KEY | tip.KEY_DONT_DISPATCH_MODIFIER_KEY_EVENT;
      if (want.has(name)) {
        tip.keydown(ev, flags);
      } else {
        tip.keyup(ev, flags);
      }
    }
  }
}

/** Keys whose keydown toggles a lock in the text input processor. */
const LOCK_KEYS = new Set(["CapsLock", "NumLock", "ScrollLock"]);

function keyFlags(tip, def) {
  const printable = def.key.length === 1 && def.key !== "\0";
  let flags = printable ? tip.KEY_FORCE_PRINTABLE_KEY : tip.KEY_NON_PRINTABLE_KEY;
  if (!def.keyCode) {
    flags |= tip.KEY_KEEP_KEYCODE_ZERO;
  }
  if (!def.location) {
    flags |= tip.KEY_KEEP_KEY_LOCATION_STANDARD;
  }
  return flags;
}

/**
 * Dispatch keydown (+ keypress) or keyup for one key, `def` being
 * {key, code, keyCode, location}, with `mods` held. For a modifier key's own
 * keydown, the processor turns that modifier on itself.
 *
 * @returns {boolean} whether the keydown/keyup was consumed (preventDefault)
 */
export function keyEvent(win, phase, def, { mods = [], repeat = false } = {}) {
  const tip = tipFor(win);
  syncModifiers(tip, win, phase === "down" ? mods.filter(m => m !== def.key) : mods);
  if (phase === "down" && LOCK_KEYS.has(def.key) && !tip.getModifierState(def.key)) {
    // A lock key never locks for the agent, as with Ego: Chromium's
    // synthesized keys carry no lock state. The processor toggles a lock on
    // its key's keydown, so it goes on silently first, and the key's own
    // keydown turns it off again (input-gaps.md 23).
    const lock = new win.KeyboardEvent("", { key: def.key, code: def.code });
    const silent = tip.KEY_NON_PRINTABLE_KEY | tip.KEY_DONT_DISPATCH_MODIFIER_KEY_EVENT;
    tip.keydown(lock, silent);
    tip.keyup(lock, silent);
  }
  const ev = new win.KeyboardEvent("", {
    key: def.key,
    code: def.code,
    keyCode: def.keyCode,
    location: def.location,
    repeat,
  });
  const flags = keyFlags(tip, def);
  // Inside dispatchIn: zenius's keys, not the user's (content/typing.sys.mjs).
  let consumed = false;
  dispatchIn(win, () => {
    consumed = phase === "down" ? (tip.keydown(ev, flags) & tip.KEYDOWN_IS_CONSUMED) !== 0 : !tip.keyup(ev, flags);
  });
  return consumed;
}

// ---------------------------------------------------------------- editing

/** The element keyboard input goes to in this document (focused element or body). */
/** The focused element of `doc`, inside shadow trees (keys go there). */
export function keyboardTarget(doc) {
  return activeThroughShadow(doc.activeElement) ?? doc.body ?? doc.documentElement;
}

function activeThroughShadow(el) {
  while (el?.openOrClosedShadowRoot?.activeElement) {
    el = el.openOrClosedShadowRoot.activeElement;
  }
  return el;
}

export function isTextControl(el) {
  if (!el) {
    return false;
  }
  if (el.localName === "textarea") {
    return true;
  }
  if (el.localName !== "input") {
    return false;
  }
  return ["", "text", "search", "url", "tel", "email", "password", "number"].includes((el.type ?? "").toLowerCase());
}

export function editingHost(el) {
  for (let n = el; n; n = n.parentElement) {
    if (n.isContentEditable && !n.parentElement?.isContentEditable) {
      return n;
    }
  }
  return el?.ownerDocument?.designMode === "on" ? el.ownerDocument.body : null;
}

/**
 * In a document without system focus, focus() doesn't put the caret into a
 * contenteditable host; do what Gecko does when it does have focus: caret at
 * the start, unless the selection is already inside.
 */
export function ensureCaretIn(host) {
  const win = host.ownerDocument.defaultView;
  const sel = win.getSelection();
  if (sel.rangeCount && host.contains(sel.anchorNode)) {
    return;
  }
  sel.collapse(host, 0);
}

function htmlEditorFor(win) {
  return win.docShell?.editingSession?.getEditorForWindow(win) ?? null;
}

/**
 * Insert text where the caret is, as an IME commit or emoji palette would:
 * beforeinput/input with inputType "insertText", undoable. Nothing happens
 * when no editable element has focus (as with CDP Input.insertText).
 *
 * @returns {boolean} whether an editor took the text
 */
export function insertText(doc, text) {
  // Inside dispatchIn: the input events it fires are zenius's, not the
  // user's (content/typing.sys.mjs).
  let took = false;
  dispatchIn(doc.defaultView, () => {
    took = insertTextNow(doc, text);
  });
  return took;
}

function insertTextNow(doc, text) {
  const el = keyboardTarget(doc);
  if (isTextControl(el) && el.editor && !el.readOnly && !el.disabled) {
    el.editor.insertText(text);
    return true;
  }
  const host = editingHost(el);
  if (host) {
    ensureCaretIn(host);
    const ed = htmlEditorFor(doc.defaultView);
    if (ed) {
      ed.insertText(text);
      return true;
    }
    return doc.execCommand("insertText", false, text);
  }
  return false;
}

/** An nsITransferable with the given flavors, in order. */
function makeTransferable(pairs) {
  const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
  t.init(null);
  for (const [flavor, data] of pairs) {
    const s = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
    s.data = data;
    t.addDataFlavor(flavor);
    t.setTransferData(flavor, s);
  }
  return t;
}

/** The HTML editor of `win`'s document (contenteditable or designMode), or null. */
function htmlEditorOf(win) {
  try {
    return win.docShell?.editingSession?.getEditorForWindow(win) ?? null;
  } catch {
    return null;
  }
}

/**
 * Paste {text, html} through the focused editor, never the system clipboard:
 * a trusted `paste` event with that clipboardData, then insertFromPaste.
 * Undoable like a real paste. Inside dispatchIn: zenius's paste, not the
 * user's (content/typing.sys.mjs).
 */
export function pasteContent(doc, content = {}) {
  let took = false;
  dispatchIn(doc.defaultView, () => {
    took = pasteNow(doc, content);
  });
  return took;
}

function pasteNow(doc, { text = "", html } = {}) {
  const win = doc.defaultView;
  const el = keyboardTarget(doc);
  if (isTextControl(el) && el.editor && !el.readOnly && !el.disabled) {
    // Text editors take the first flavor.
    const pairs = [["text/plain", text]];
    if (html != null) {
      pairs.push(["text/html", html]);
    }
    el.editor.pasteTransferable(makeTransferable(pairs));
    return true;
  }
  const host = editingHost(el);
  if (host) {
    ensureCaretIn(host);
    const pairs = html != null ? [["text/html", html], ["text/plain", text]] : [["text/plain", text]];
    // The document's HTML editor itself: after the tab navigated, the paste
    // command event silently dropped every paste (Gecko 160).
    const editor = htmlEditorOf(win);
    if (editor) {
      editor.pasteTransferable(makeTransferable(pairs));
    } else {
      win.windowUtils.sendContentCommandEvent("pasteTransferable", makeTransferable(pairs));
    }
    return true;
  }
  // Nothing editable: real browsers still fire `paste` at the focused element.
  // Gecko's ClipboardEventInit takes one {dataType, data}, not clipboardData.
  const ev = new win.ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, dataType: "text/plain", data: text });
  if (html != null) {
    ev.clipboardData?.setData("text/html", html);
  }
  dispatchTrusted(el, ev);
  return false;
}

/** The selection as {text, html}, inside a text control or the document. */
export function selectionContent(doc) {
  const el = keyboardTarget(doc);
  if (isTextControl(el)) {
    const v = el.value ?? "";
    const text = el.type === "password" ? "" : v.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
    return { text, html: null };
  }
  const sel = doc.defaultView.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    return { text: "", html: null };
  }
  const div = doc.createElement("div");
  for (let i = 0; i < sel.rangeCount; i++) {
    div.appendChild(sel.getRangeAt(i).cloneContents());
  }
  return { text: sel.toString(), html: div.innerHTML };
}

/**
 * Delete the selection a cut took, through the editor so undo restores it.
 */
export function deleteSelection(doc) {
  const el = keyboardTarget(doc);
  if (isTextControl(el) && el.editor && !el.readOnly && !el.disabled) {
    el.editor.deleteSelection(Ci.nsIEditor.eNone, Ci.nsIEditor.eStrip);
  } else if (editingHost(el)) {
    doc.execCommand("delete");
  }
}

// ---------------------------------------------------------------- wheel

/**
 * One wheel event at viewport CSS px of `win`'s document. Gecko delivers the
 * event in a hidden tab but never runs its default scroll there, and a smooth
 * scroll stalls, so the native default is always cancelled (after the page's
 * own listeners have run) and replaced by an instant scroll of the element
 * Gecko would have scrolled. Ctrl+wheel would zoom the tab: never emulated.
 * `origin`, the target of a motion's first event, is where the scroll
 * starts instead: Gecko sends all of a gesture's events to its first one's
 * target, and zenius ends its gesture after each event (input-gaps.md F7).
 * The page hears the deltas asked, in CSS px, as zenius scrolls them. Gecko
 * takes them in device pixels, and would first multiply them by the wheel
 * speed prefs, which are for the user's own wheel (Zen ships
 * mousewheel.default.delta_multiplier_y 200: pages heard twice the distance,
 * and at a devicePixelRatio of 2 half of it).
 *
 * @returns {{dispatched: boolean, target?: Node, prevented?: boolean, scrolled?: boolean, out?: BrowsingContext | null}}
 *   `out`: nothing in this process could scroll, and the scroll goes on past
 *   that frame, in another process (wheelScroller)
 */
export function wheelAt(win, x, y, dx, dy, mods, origin = null) {
  // A press held in another tab of the process may take the wheel too.
  if (pressElsewhere(win)) {
    throw blockedError("mouse_held_elsewhere", "wheel");
  }
  const utils = win.windowUtils;
  const dpr = win.devicePixelRatio || 1;
  let seen = null;
  const listener = e => {
    if (!seen) {
      seen = { prevented: e.defaultPrevented, target: e.composedTarget ?? e.originalTarget ?? e.target };
    }
    e.preventDefault();
  };
  // System group: it runs after every page listener, so defaultPrevented is
  // the page's decision. At the tab's root, which a same-process frame's
  // events reach too: the wheel lands in one once a motion scrolls it under
  // the pointer (input-gaps.md F7). A window sees only its own document's.
  const at = win.docShell?.chromeEventHandler ?? win;
  at.addEventListener("wheel", listener, { capture: true, mozSystemGroup: true });
  try {
    // One that a press in another tab took anyway is dropped there.
    dispatchIn(win, () =>
      utils.sendWheelEvent(
        x,
        y,
        dx * dpr,
        dy * dpr,
        0,
        win.WheelEvent.DOM_DELTA_PIXEL,
        modifierMask(utils, mods),
        0,
        0,
        utils.WHEEL_EVENT_CUSTOMIZED_BY_USER_PREFS
      )
    );
  } finally {
    at.removeEventListener("wheel", listener, { capture: true, mozSystemGroup: true });
  }
  if (!seen) {
    return { dispatched: false };
  }
  if (seen.prevented || (mods ?? []).includes("Control")) {
    return { dispatched: true, target: seen.target, prevented: seen.prevented, scrolled: false };
  }
  const from = origin?.isConnected ? origin : seen.target;
  const chosen = scrollFromWheel(from, dx, dy);
  return { dispatched: true, target: seen.target, prevented: false, scrolled: !!chosen?.el, out: chosen?.out ?? null };
}

function isRootScroller(el) {
  const doc = el.ownerDocument;
  return el === doc.scrollingElement || el === doc.documentElement;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * The viewport's overflow, `prop` "overflowX" or "overflowY". While the
 * root's overflow is visible on both axes, CSS gives the viewport the
 * body's: body{overflow:hidden} is how a modal locks the page's scroll, and
 * a real wheel leaves such a page where it is (input-gaps.md 19).
 */
function viewportOverflow(doc, prop) {
  const win = doc.defaultView;
  const root = doc.documentElement;
  const rootStyle = win.getComputedStyle(root);
  if (rootStyle.overflowX !== "visible" || rootStyle.overflowY !== "visible") {
    return rootStyle[prop];
  }
  const body = doc.body;
  if (root.localName === "html" && root.namespaceURI === XHTML_NS && body?.localName === "body" && body.parentNode === root) {
    return win.getComputedStyle(body)[prop];
  }
  return rootStyle[prop];
}

/** Room left to scroll `el` by `delta` along `axis` ("x" | "y"). */
function canScrollBy(el, axis, delta) {
  if (!delta) {
    return false;
  }
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  let pos;
  let max;
  if (isRootScroller(el)) {
    const ov = viewportOverflow(doc, axis === "y" ? "overflowY" : "overflowX");
    if (ov === "hidden" || ov === "clip") {
      return false;
    }
    pos = axis === "y" ? win.scrollY : win.scrollX;
    max = axis === "y" ? win.scrollMaxY : win.scrollMaxX;
  } else {
    const ov = win.getComputedStyle(el)[axis === "y" ? "overflowY" : "overflowX"];
    if (ov !== "auto" && ov !== "scroll" && ov !== "overlay") {
      return false;
    }
    pos = axis === "y" ? el.scrollTop : Math.abs(el.scrollLeft);
    max = axis === "y" ? el.scrollTopMax : el.scrollLeftMax;
  }
  return delta > 0 ? pos < max - 0.5 : pos > 0.5;
}

/** A scroll container that keeps the wheel from chaining past it. */
function stopsChaining(el, dx, dy) {
  if (isRootScroller(el)) {
    return false;
  }
  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  const scrolls = v => v === "auto" || v === "scroll" || v === "overlay";
  if (dy && scrolls(cs.overflowY) && cs.overscrollBehaviorY !== "auto" && el.scrollTopMax > 0) {
    return true;
  }
  return !!dx && scrolls(cs.overflowX) && cs.overscrollBehaviorX !== "auto" && el.scrollLeftMax > 0;
}

/**
 * The root's overscroll-behavior keeps the wheel in its document, as a
 * scroll container's does (stopsChaining): a frame's page can keep the
 * wheel from scrolling the page around it.
 */
function rootStopsChaining(doc, dx, dy) {
  const win = doc.defaultView;
  const cs = win.getComputedStyle(doc.documentElement);
  const contains = (delta, overflow, max, behavior) => !!delta && overflow !== "hidden" && overflow !== "clip" && max > 0 && behavior !== "auto";
  return (
    contains(dy, viewportOverflow(doc, "overflowY"), win.scrollMaxY, cs.overscrollBehaviorY) ||
    contains(dx, viewportOverflow(doc, "overflowX"), win.scrollMaxX, cs.overscrollBehaviorX)
  );
}

function flatParent(node) {
  return node.flattenedTreeParentNode ?? node.parentNode ?? node.host ?? null;
}

/**
 * What a wheel at `target` scrolls, as Gecko's wheel handling chooses: the
 * nearest ancestor, across shadow trees and same-process frames, that can
 * still move in the wheel's direction; otherwise the document.
 *
 * @returns {{el: Element} | {out: BrowsingContext} | null} `el` scrolls.
 *   `out`: nothing in this process can, and the scroll goes on in the
 *   document embedding `out`'s, which is another process's (Gecko's own
 *   wheel gets there through APZ, which zenius's skips: input-gaps.md 18).
 *   null: nothing scrolls, or something keeps the wheel from chaining.
 */
export function wheelScroller(target, dx, dy) {
  let node = target?.nodeType === 1 ? target : target?.parentElement ?? target?.ownerDocument?.documentElement;
  while (node) {
    const doc = node.ownerDocument;
    for (let el = node; el && el.nodeType === 1; el = flatParent(el)) {
      if (canScrollBy(el, "y", dy) || canScrollBy(el, "x", dx)) {
        return { el };
      }
      if (stopsChaining(el, dx, dy)) {
        return null;
      }
    }
    const root = doc.scrollingElement ?? doc.documentElement;
    if (root && (canScrollBy(root, "y", dy) || canScrollBy(root, "x", dx))) {
      return { el: root };
    }
    if (rootStopsChaining(doc, dx, dy)) {
      return null;
    }
    const bc = doc.defaultView?.browsingContext;
    node = bc?.embedderElement ?? null;
    if (!node) {
      return bc?.parent ? { out: bc } : null;
    }
  }
  return null;
}

/**
 * Scroll at once what a wheel at `target` would (wheelScroller).
 *
 * @returns {{el: Element} | {out: BrowsingContext} | null} wheelScroller's choice
 */
export function scrollFromWheel(target, dx, dy) {
  const chosen = wheelScroller(target, dx, dy);
  if (chosen?.el) {
    const opts = { left: dx, top: dy, behavior: "instant" };
    if (isRootScroller(chosen.el)) {
      chosen.el.ownerDocument.defaultView.scrollBy(opts);
    } else {
      chosen.el.scrollBy(opts);
    }
  }
  return chosen;
}

// ---------------------------------------------------------------- focus

/** The innermost focused element in this process, through same-process frames. */
export function deepestActive(doc) {
  let d = doc;
  for (;;) {
    const el = activeThroughShadow(d.activeElement);
    if (!el || !isFrameElement(el) || !el.browsingContext?.docShell || !el.contentDocument) {
      return el;
    }
    d = el.contentDocument;
  }
}

export function isFrameElement(el) {
  const n = el?.localName;
  return n === "iframe" || n === "frame" || n === "object" || n === "embed";
}

function isDocRoot(el) {
  const doc = el?.ownerDocument;
  return !el || el === doc.body || el === doc.documentElement;
}

/** A contenteditable element or a designMode document's: the document's HTML editor edits it. */
function isRichEditable(el) {
  return !!el?.isContentEditable && !isTextControl(el);
}

/**
 * Gecko turns an HTML editor's caret on when the editor really gets focus
 * (EditorBase::OnFocus), and off on blur. Emulated focus never reaches
 * that code, and with the caret off, caret moves ignore a selection:
 * ArrowLeft doesn't collapse it and End doesn't move.
 */
function setEditorCaret(doc, on) {
  try {
    htmlEditorOf(doc.defaultView)?.selectionController.setCaretEnabled(on);
  } catch {}
}

/**
 * Before keys: a rich editor that has only emulated focus (the page focused
 * it by script, autofocus or a Tab) gets what real focus gives it: the
 * selection inside its editing host, at the start unless it's already
 * inside, and the caret on. A hidden tab's focus() places neither, so keys
 * typed after it were lost while inserted text landed
 * (docs/research/background-input.md). Chromium places the caret on focus.
 */
export function ensureEditorCaret(el) {
  if (isRichEditable(el) && !el.ownerDocument.hasFocus()) {
    const host = editingHost(el);
    if (host) {
      ensureCaretIn(host);
    }
    setEditorCaret(el.ownerDocument, true);
  }
}

/**
 * After a key in a rich editor that has only emulated focus: real focus
 * limits the selection to the editing host (HTMLEditor::OnFocus sets the
 * ancestor limiter), which the editor skips when its window lacks focus,
 * and chrome code can't set it. So a move to the document's end (Ctrl+End,
 * Ctrl+Shift+End; Shift+End on the Mac) left the host: the selection ran
 * into the next editor on the page, or the caret left and focus went to the
 * body, and the text typed next was lost (input-gaps.md B25). Put the
 * selection back where the limiter would have stopped it, and the focus
 * with it. The caller runs this only after a key whose default action ran
 * (a page that handles the key moves the selection itself), and not after
 * a Tab, which moves focus on purpose.
 *
 * @param {Element} el what had focus before the key
 * @param {Element|null} now what has it after
 */
export function keepInEditingHost(el, now) {
  try {
    if (!isRichEditable(el) || el.ownerDocument.hasFocus() || (now && now !== el && !isDocRoot(now))) {
      return;
    }
    const host = editingHost(el);
    const doc = host?.ownerDocument;
    const sel = doc?.defaultView.getSelection();
    if (!host?.isConnected || !sel?.rangeCount) {
      return;
    }
    const contents = doc.createRange();
    contents.selectNodeContents(host);
    const inside = (node, offset) => {
      if (node && host.contains(node)) {
        return [node, offset];
      }
      // A point, not a node: the move may leave it in an ancestor, such as
      // (body, its last offset), which comes after the host's contents.
      let after;
      try {
        after = contents.comparePoint(node, offset) > 0;
      } catch {
        // Another tree (the host in a shadow root): order by node.
        after = !!(host.compareDocumentPosition(node) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING);
      }
      return edgeOf(host, after);
    };
    const [an, ao] = inside(sel.anchorNode, sel.anchorOffset);
    const [fn, fo] = inside(sel.focusNode, sel.focusOffset);
    if (an === sel.anchorNode && ao === sel.anchorOffset && fn === sel.focusNode && fo === sel.focusOffset) {
      return;
    }
    sel.setBaseAndExtent(an, ao, fn, fo);
    if (doc.activeElement !== host) {
      // Without system focus this moves activeElement only, and the page
      // hears nothing: focus never left the host for a focused editor.
      host.focus({ preventScroll: true });
    }
  } catch (e) {
    console.error("[zenius] keeping the selection in its editing host failed", e);
  }
}

/**
 * The first or last caret point inside `host`, as Gecko's moves place it:
 * in its first or last editable text.
 */
function edgeOf(host, atEnd) {
  let node = host;
  for (;;) {
    const child = atEnd ? node.lastChild : node.firstChild;
    if (!child) {
      return [node, atEnd ? node.childNodes.length : 0];
    }
    if (child.nodeType === child.TEXT_NODE) {
      return [child, atEnd ? child.length : 0];
    }
    if (child.nodeType === child.ELEMENT_NODE && child.firstChild && child.isContentEditable) {
      node = child;
      continue;
    }
    // Beside it: an empty element, or one the user can't edit (a mention
    // chip). Before a trailing <br>, the editor's line padding.
    const index = Array.prototype.indexOf.call(node.childNodes, child);
    return [node, atEnd && child.localName !== "br" ? index + 1 : index];
  }
}

/**
 * Without system focus, Gecko moves activeElement but fires no focus events
 * (a hidden agent tab). After input that may have moved focus, fire
 * blur/focusout on the old element and focus/focusin on the new one, as a
 * focused tab would have, and switch rich editors' carets as focus would.
 * Date and time inputs hear of focus moving among their fields too.
 */
export function emulateFocusChange(prev, next) {
  const view = (next ?? prev)?.ownerDocument?.defaultView;
  if (view) {
    // Before the page's blur, as the widget's commit comes first with system focus.
    syncDateTimeFocus(view);
  }
  if (prev === next) {
    return;
  }
  const hasFocus = el => {
    try {
      return el.ownerDocument.hasFocus();
    } catch {
      return false;
    }
  };
  if ((next && hasFocus(next)) || (prev && hasFocus(prev))) {
    return;
  }
  const fire = (target, type, related) => {
    const win = target.ownerDocument.defaultView;
    const sameDoc = related && related.ownerDocument === target.ownerDocument;
    dispatchTrusted(
      target,
      new win.FocusEvent(type, {
        bubbles: type === "focusin" || type === "focusout",
        composed: true,
        relatedTarget: sameDoc && !isDocRoot(related) ? related : null,
        view: win,
      })
    );
  };
  if (prev && !isDocRoot(prev) && prev.isConnected) {
    fire(prev, "blur", next);
    fire(prev, "focusout", next);
  }
  if (next && !isDocRoot(next) && next.isConnected) {
    fire(next, "focus", prev);
    fire(next, "focusin", prev);
  }
  const sameEditor = isRichEditable(next) && next.ownerDocument === prev?.ownerDocument;
  if (isRichEditable(prev) && !sameEditor) {
    setEditorCaret(prev.ownerDocument, false);
  }
  if (isRichEditable(next)) {
    setEditorCaret(next.ownerDocument, true);
  }
}

// ---------------------------------------------------------------- date and time fields

/** Per tab (its top document in this process): the date or time field whose widget last heard from us that it has focus. */
const dateTimeFocus = new WeakMap();

/** `el` when it is a field (or the picker button) of a date or time input's UA widget, else null. */
function dateTimeField(el) {
  try {
    if (!el?.matches?.(".datetime-edit-field, .datetime-picker-button")) {
      return null;
    }
    const host = el.getRootNode()?.host;
    return host && HTMLInputElement.isInstance(host) && host.dateTimeBoxElement ? el : null;
  } catch {
    return null;
  }
}

/**
 * Date and time inputs keep their fields in a UA widget (datetimebox.js),
 * which follows focus among them by two events only: a field's focus, and
 * MozDateTimeWillBlur when a field loses it. On that blur the widget
 * forgets the digits typed in the field and commits a complete date or
 * time to the input. Without system focus (a hidden or unfocused agent
 * tab) Gecko fires neither. So the widget never knew which field had
 * focus: the digit that completed a field threw on advancing, and the
 * date stayed empty. A date typed field by field didn't commit, and a
 * field typed again after a partial entry ran on from it.
 *
 * Send the widget those two events as a focused tab would: before each
 * key, and after any input that may move focus (emulateFocusChange). They
 * stay inside the widget. The page sees only the input and change events
 * of a commit, as with system focus.
 *
 * @param {Window} win a window of the tab, in this process
 */
export function syncDateTimeFocus(win) {
  let doc;
  let now;
  try {
    const top = processTopWindow(win);
    doc = top.document;
    now = dateTimeField(Services.focus.getFocusedElementForWindow(top, true, {}));
    if (doc.hasFocus()) {
      // Gecko fires the real events.
      remember(doc, now);
      return;
    }
  } catch {
    return;
  }
  const was = dateTimeFocus.get(doc) ?? null;
  if (was === now) {
    return;
  }
  remember(doc, now);
  if (was?.isConnected) {
    blurDateTimeField(was, now?.getRootNode() === was.getRootNode());
  }
  if (now) {
    const view = now.ownerDocument.defaultView;
    now.dispatchEvent(new view.FocusEvent("focus", { view }));
  }
}

/**
 * The widget's MozDateTimeWillBlur carries the field's blur event, read while
 * that blur is being dispatched (its targets are set only then). So fire a
 * blur at the field, which doesn't leave the widget's shadow tree, and send
 * MozDateTimeWillBlur from it. Focus staying inside the input is a blur
 * toward the input itself.
 */
function blurDateTimeField(field, staysInInput) {
  const input = field.getRootNode().host;
  const view = field.ownerDocument.defaultView;
  const willBlur = blur => input.dateTimeBoxElement?.dispatchEvent(new view.CustomEvent("MozDateTimeWillBlur", { detail: blur }));
  const opts = { mozSystemGroup: true };
  field.addEventListener("blur", willBlur, opts);
  try {
    field.dispatchEvent(new view.FocusEvent("blur", { relatedTarget: staysInInput ? input : null, view }));
  } finally {
    field.removeEventListener("blur", willBlur, opts);
  }
}

function remember(doc, field) {
  if (field) {
    dateTimeFocus.set(doc, field);
  } else {
    dateTimeFocus.delete(doc);
  }
}

// ---------------------------------------------------------------- trusted synthetic events

/**
 * Dispatch a DOM event the page sees as trusted: Gecko marks an event
 * trusted when chrome code dispatches it. Works inside shadow trees, unlike
 * windowUtils.dispatchDOMEventViaPresShellForTesting (which also crashes the
 * content process for ClipboardEvents in Gecko 160). No pres-shell default
 * handling runs; callers do any default themselves.
 *
 * @returns {boolean} false when the page called preventDefault()
 */
export function dispatchTrusted(target, event) {
  return target.dispatchEvent(event);
}

/** The outermost window of this tab that lives in this process. */
export function processTopWindow(win) {
  let w = win;
  for (;;) {
    const parent = w.browsingContext?.parent;
    if (!parent?.docShell) {
      return w;
    }
    w = parent.docShell.domWindow;
  }
}

/**
 * Tab or Shift+Tab in an agent's page, in Gecko's own order, without
 * leaving the page. Past the top document's end Gecko would hand focus to
 * the browser window. Here the page loses focus instead, as a Chromium page
 * does when its browser takes focus; the next Tab starts at the page's top.
 *
 * In a cross-site frame, the move past its end goes on in the document
 * around it, in that document's process: the caller hands the rest of its
 * keys there (`{leftFrame}`, the frame's browsing context id).
 *
 * @param {Window} win a window of the tab in this process
 * @param {boolean} forward
 * @param {Element} [from] start here instead of at the focused element
 * @returns {{leftFrame: number} | null}
 */
export function tabInPage(win, forward, from = null) {
  const fm = Services.focus;
  const type = forward ? fm.MOVEFOCUS_FORWARD : fm.MOVEFOCUS_BACKWARD;
  // Without parent traversal, Gecko wraps around at a document's end
  // instead of going on in the document above, or in the browser window at
  // the top. So the step up to a same-process parent is taken here.
  const flags = fm.FLAG_BYKEY | fm.FLAG_NOPARENTFRAME;
  const top = processTopWindow(win);
  let start = from ?? focusedElement(win);
  if (isDocRoot(start)) {
    start = null;
  }
  let doc = start?.ownerDocument ?? top.document;
  for (;;) {
    const next = fm.moveFocus(doc.defaultView, start, type, flags);
    // No element back: Gecko took focus into a cross-site frame, which
    // focuses its own element, or found nothing here.
    if (next ? !wrappedAround(start, next, doc, forward) : hasRemoteFrame(doc)) {
      return null;
    }
    const frame = doc.defaultView.browsingContext.embedderElement;
    if (!frame) {
      fm.clearFocus(top);
      return top.browsingContext.parent ? { leftFrame: top.browsingContext.id } : null;
    }
    start = frame;
    doc = frame.ownerDocument;
  }
}

/** Whether Gecko's move from `start` went past the end of `doc` and around. */
function wrappedAround(start, next, doc, forward) {
  if (!start) {
    return false;
  }
  let here = next;
  while (here && here.ownerDocument !== doc) {
    here = here.ownerDocument?.defaultView?.browsingContext?.embedderElement ?? null;
  }
  if (!here) {
    return false;
  }
  return here === start || (forward ? tabPrecedes(here, start) : tabPrecedes(start, here));
}

/** Tab order within one document: positive tabindex first, then tree order. */
function tabPrecedes(a, b) {
  const group = el => {
    const n = parseInt(el.getAttribute?.("tabindex") ?? "", 10);
    return n > 0 ? n : Infinity;
  };
  const ga = group(a);
  const gb = group(b);
  return ga !== gb ? ga < gb : composedPrecedes(a, b);
}

/** Whether `a` comes before `b` in the composed tree, a shadow tree at its host. */
function composedPrecedes(a, b) {
  const chain = node => {
    const out = [];
    for (let n = node; n; n = n.parentNode ?? n.host ?? null) {
      out.unshift(n);
    }
    return out;
  };
  const ca = chain(a);
  const cb = chain(b);
  let i = 0;
  while (i < ca.length && i < cb.length && ca[i] === cb[i]) {
    i++;
  }
  if (i === ca.length || i === cb.length) {
    return i === ca.length;
  }
  // A host's shadow tree first; its light children show at its slots.
  if (ca[i].nodeType === 11 || cb[i].nodeType === 11) {
    return ca[i].nodeType === 11;
  }
  return (ca[i].compareDocumentPosition(cb[i]) & 4) !== 0;
}

function hasRemoteFrame(doc) {
  const walk = bc => bc.children.some(c => !c.docShell || walk(c));
  return walk(doc.defaultView.browsingContext);
}

/** The innermost focused element of the tab, as far as this process sees. */
export function focusedElement(win) {
  return deepestActive(processTopWindow(win).document);
}

/**
 * focus() as the page would see it with system focus: in a hidden agent tab
 * Gecko moves activeElement but fires no focus events, so send them.
 * :focus still won't match there.
 *
 * @returns {boolean} whether focus is now on `el` or inside it
 */
export function focusElement(el) {
  const win = el.ownerDocument.defaultView;
  const prev = focusedElement(win);
  el.focus({ preventScroll: true });
  const now = focusedElement(win);
  const inside = now === el || (now && el.contains(now)) || (now && el.shadowRoot?.contains(now));
  if (!inside) {
    return false;
  }
  const host = editingHost(now);
  if (host) {
    ensureCaretIn(host);
  }
  emulateFocusChange(prev, now);
  return true;
}

/**
 * The clipboard command a keypress would run natively, or null:
 * accel+C/X/V (accel+Shift+V pastes plain text), and on Linux and Windows
 * also Ctrl+Insert, Shift+Insert and Shift+Delete.
 */
function clipboardCommand(e, isMac) {
  const accel = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (accel && !e.altKey) {
    const op = { c: "copy", x: "cut", v: "paste" }[e.key?.toLowerCase()];
    if (op) {
      return { op, plain: op === "paste" && e.shiftKey };
    }
  }
  if (!isMac && !e.altKey && !e.metaKey) {
    if (e.key === "Insert" && e.ctrlKey && !e.shiftKey) {
      return { op: "copy", plain: false };
    }
    if (e.key === "Insert" && e.shiftKey && !e.ctrlKey) {
      return { op: "paste", plain: false };
    }
    if (e.key === "Delete" && e.shiftKey && !e.ctrlKey) {
      return { op: "cut", plain: false };
    }
  }
  return null;
}

// Both clipboard listeners run in the system group, after every page
// listener, at the tab's chrome event handler, which sees every frame of the
// tab in this process.
const SYSTEM_CAPTURE = { capture: true, mozSystemGroup: true };
const SYSTEM_BUBBLE = { mozSystemGroup: true };

/** zen-ux's ClipData (MIME type → data, most preferred first) from {text, html}. */
export function toClipData({ text = "", html = null } = {}) {
  return html != null ? { "text/html": html, "text/plain": text } : { "text/plain": text };
}

/** {text, html} from ClipData; types other than plain text and HTML are ignored. */
export function fromClipData(data) {
  const text = data?.["text/plain"];
  const html = data?.["text/html"];
  return { text: typeof text === "string" ? text : "", html: typeof html === "string" ? html : null };
}

/** Each tab root's copy/cut handlers; the last one installed gets each event. */
const copyCutHandlers = new WeakMap();

/**
 * Catch every trusted copy and cut in `win`'s tab, in this process, and keep
 * it off the system clipboard. Copy and cut run natively, so the page gets
 * Gecko's own trusted event and Gecko's own rules (password fields,
 * user-select, the page's handlers) decide what is copied. A ClipboardEvent
 * dispatched through the pres shell would crash the content process in
 * Gecko 160.
 *
 * After the page's listeners have run, `onClip` gets
 * {op: "copy"|"cut", prevented, content: ClipData|null, doc}. `content` is
 * the page's own data if it cancelled the event, otherwise the selection.
 * The event's DataTransfer is then emptied and the event cancelled, which
 * leaves Gecko nothing to write. A cut the page didn't cancel still deletes
 * its selection, through the editor, so undo restores it.
 *
 * The last handler installed for a tab gets each event: zen-ux's page guards
 * install one for the page's own copy and cut, and the agent's chords
 * install theirs on top while they run.
 *
 * @param {(clip: {op: string, prevented: boolean, content: object|null, doc: Document}) => void} onClip
 * @returns {{stop(): void}}
 */
export function interceptCopyCut(win, onClip) {
  const root = win.docShell?.chromeEventHandler ?? win;
  let entry = copyCutHandlers.get(root);
  if (!entry) {
    const handlers = [];
    const listener = e => {
      const handler = handlers.at(-1);
      if (!handler || !e.isTrusted) {
        return;
      }
      const prevented = e.defaultPrevented;
      const target = e.composedTarget ?? e.target;
      const doc = target?.ownerDocument ?? target;
      let content = null;
      try {
        if (prevented) {
          const text = e.clipboardData?.getData("text/plain") ?? "";
          const html = e.clipboardData?.getData("text/html") || null;
          content = text || html ? toClipData({ text, html }) : null;
        } else {
          const sel = selectionContent(doc);
          content = sel.text || sel.html ? toClipData(sel) : null;
        }
      } finally {
        try {
          e.clipboardData?.clearData();
        } catch {}
        e.preventDefault();
      }
      if (e.type === "cut" && !prevented && content) {
        deleteSelection(doc);
      }
      handler({ op: e.type, prevented, content, doc });
    };
    entry = { handlers, listener };
    copyCutHandlers.set(root, entry);
    root.addEventListener("copy", listener, SYSTEM_CAPTURE);
    root.addEventListener("cut", listener, SYSTEM_CAPTURE);
  }
  entry.handlers.push(onClip);
  return {
    stop() {
      const i = entry.handlers.lastIndexOf(onClip);
      if (i >= 0) {
        entry.handlers.splice(i, 1);
      }
      if (!entry.handlers.length && copyCutHandlers.get(root) === entry) {
        copyCutHandlers.delete(root);
        root.removeEventListener("copy", entry.listener, SYSTEM_CAPTURE);
        root.removeEventListener("cut", entry.listener, SYSTEM_CAPTURE);
      }
    },
  };
}

/**
 * Paste ClipData into the focused editable of `win`'s document as a user's
 * paste: a trusted `paste` event carrying the data, then the editor's
 * insert, which undo reverts. Empty data still fires the event and inserts
 * nothing. Never reads the system clipboard.
 *
 * @param {{plain?: boolean}} [opts] paste as plain text (Ctrl+Shift+V)
 * @returns {boolean} whether an editor took it
 */
export function pasteInto(win, data, { plain = false } = {}) {
  const content = fromClipData(data);
  if (plain) {
    return pasteContent(win.document, { text: content.text });
  }
  return pasteContent(win.document, content.html ? { ...content, html: sanitizePastedHtml(content.html) } : content);
}

/**
 * The html flavor of a paste the agent's input makes, as the page and its
 * editor get it. Gecko's own sanitizer drops scripts, event-handler
 * attributes and javascript: URLs, as Chromium does for a paste: Ego's
 * agents never see a pasted onerror run, and a page's paste handler that
 * inserts the html as is runs nothing of it here either (the manager's
 * layer, 2026-11-20). Styles and comments stay, so formatting and the
 * fragment markers editors read survive.
 *
 * @param {string} html
 * @returns {string} a whole document's markup
 */
export function sanitizePastedHtml(html) {
  const flags = Ci.nsIParserUtils.SanitizerAllowStyle | Ci.nsIParserUtils.SanitizerAllowComments;
  return Cc["@mozilla.org/parserutils;1"].getService(Ci.nsIParserUtils).sanitize(html, flags);
}

/**
 * Accel+S that the page didn't cancel: Firefox's chrome would save the page.
 * Agent keys never reach chrome, so the caller does what chrome would.
 */
function isSaveChord(e, isMac) {
  const accel = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return accel && !e.altKey && !e.shiftKey && e.key?.toLowerCase() === "s";
}

/**
 * The browser shortcuts in one key event:
 * - A paste chord's native command is cancelled and recorded, so the
 *   caller pastes the Space's clipboard.
 * - Copy and cut are caught by interceptCopyCut.
 * - Accel+S is recorded as {op: "save"}.
 * `requests` lists them in order. A page that cancelled the key gets
 * none of them, as natively.
 */
export function interceptShortcuts(win, isMac) {
  const requests = [];
  // Tab and F6 move focus by default, and Gecko hands focus that leaves the
  // page's top document to the browser window, where it lands on the user's
  // tab, the Agents strip or the address bar (zen-snapshot's audit,
  // docs/research/process-input-state.md). This listener is the last of the
  // system group, after the page and any editor that takes Tab for itself.
  // An agent's Tab then moves within the page (tabInPage), and F6 and
  // Ctrl+Tab, which move between documents and the browser's toolbars, do
  // nothing.
  const root = processTopWindow(win).docShell?.chromeEventHandler;
  const navListener = e => {
    if (!e.isTrusted || e.defaultPrevented || e.altKey || (e.keyCode !== e.DOM_VK_TAB && e.keyCode !== e.DOM_VK_F6)) {
      return;
    }
    e.preventDefault();
    if (e.keyCode === e.DOM_VK_TAB && !e.ctrlKey) {
      requests.push({ op: "tab", forward: !e.shiftKey });
    }
  };
  root?.addEventListener("keypress", navListener, SYSTEM_BUBBLE);
  const keyListener = e => {
    if (!e.isTrusted) {
      return;
    }
    if (isSaveChord(e, isMac)) {
      if (!e.defaultPrevented) {
        requests.push({ op: "save" });
      }
      return;
    }
    const cmd = clipboardCommand(e, isMac);
    if (cmd?.op !== "paste") {
      return;
    }
    if (!e.defaultPrevented) {
      requests.push(cmd);
    }
    e.preventDefault();
  };
  win.addEventListener("keypress", keyListener, SYSTEM_CAPTURE);
  const copyCut = interceptCopyCut(win, clip => requests.push(clip));
  return {
    requests,
    stop() {
      win.removeEventListener("keypress", keyListener, SYSTEM_CAPTURE);
      root?.removeEventListener("keypress", navListener, SYSTEM_BUBBLE);
      copyCut.stop();
    },
  };
}

export { keyDefinition };
