// The user's own input in a task's tab, and in a page that may hold the
// agent's code, seen at the tab's root before any listener of the page
// (the input layer). Only those tabs' roots get these listeners: the user's own
// tabs never do (I4).
//
// - Take over: the user's first key
//   or press in a live task's tab discards the agent's worlds there
//   (the observe layer's discard, content/agentworld.sys.mjs), synchronously,
//   before any listener of the page sees it.
// - The typing guard, on evidence only. In a page the agent's code left
//   something hooked in (the observe layer's evidence, reason hooked), the
//   user's first press
//   or key anywhere in the tab is stopped before any listener of the page,
//   and so is every press and key of theirs after it, until the tab's top
//   document is replaced: nothing the agent's code left runs on their input.
//   A page the agent's code only filled, clicked or read has no evidence,
//   and the user's input goes through as in any page. Nor does a listed or
//   flagged page hold it: the danger there
//   is the page itself, which a clean copy can't remove, so the UI warns
//   instead. A
//   stopped press is stopped whole, so the focus stays where it was. The core
//   reloads the page (cleanOnDemand, from the parent's half,
//   input/typing.sys.mjs) with the form carried over, and puts the focus on
//   the field the user went for, if any (noteUserTarget). Scrolls and pointer
//   moves pass. A page the agent made (flag "drop") keeps the user's input
//   on: the UI reminds them instead.
//   The keys the user types while the clean copy loads are typed again into
//   it, in the field they went for, as the hold lifts (the replay, below).
//   The replay's own keys never set off a hold.
// - The user's secret field (onSecretTyped in input/handback.sys.mjs): their
//   own input first changing a password, a card's details or a one-time code
//   (content/secrets.sys.mjs) in a document of a task's tab. Their typing,
//   paste, drop and IME count, and so does their autofill: the password
//   manager and form autofill fill through the same trusted input events.
//   The parent hears it once per document.
//
// zenius's own input passes unseen: capture.sys.mjs's dispatchIn marks the
// tab while zenius dispatches it. A page's script makes only untrusted
// events.

import { TASK_BROWSERS_KEY } from "chrome://userscripts/content/zenius/content/guards.sys.mjs";
import { KEPT_BROWSERS_KEY } from "chrome://userscripts/content/zenius/content/taskset.sys.mjs";
import { secretKind } from "chrome://userscripts/content/zenius/content/secrets.sys.mjs";
import { discard } from "chrome://userscripts/content/zenius/content/agentworld.sys.mjs";
import { evidenceFlag, evidenceOf } from "chrome://userscripts/content/zenius/content/evidence.sys.mjs";
import { EVIDENCE_DOCS_KEY } from "chrome://userscripts/content/zenius/content/worldkeys.sys.mjs";
import {
  keydownEntry,
  mergedInput,
  REPLAY_MAX_ENTRIES,
  REPLAY_MAX_KEYS,
  TYPING_HELD_DOCS_KEY,
  TYPING_HELD_TABS_KEY,
} from "chrome://userscripts/content/zenius/content/typingkeys.sys.mjs";

const KEYS = new Set(["keydown", "keypress", "keyup"]);
// "text" is Gecko's own composition change, which the editor applies.
const COMPOSITION = new Set(["compositionstart", "compositionupdate", "compositionend", "text"]);
/** What a hold drops, in both event groups. */
const HELD_TYPES = [...KEYS, "paste", "drop", ...COMPOSITION];
/** One press, from its first event to its click (a tap's touches too): a stopped press loses all of them. */
const PRESS_TYPES = new Set([
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
  "touchstart",
  "touchend",
]);
const PRESS_STARTS = new Set(["pointerdown", "mousedown"]);
/** The user's first of these in a live task's tab is the Take over. */
const TAKE_OVER_TYPES = new Set(["keydown", "pointerdown", "mousedown", "touchstart", "paste", "drop", "compositionstart"]);
const LISTENED = [...HELD_TYPES, ...PRESS_TYPES];
const SYSTEM_CAPTURE = { capture: true, mozSystemGroup: true };

/** Documents whose secret field change this process already reported. */
let reported = new WeakSet();
/** Top documents held in this process since a trigger here, before the parent's word arrives. */
const heldHere = new Set();
/** Events this guard dropped in the default group, to drop again in the system group. */
let dropped = new WeakSet();
/** Tab root → the type that began a press this guard stopped, until the press ends. */
let stoppedPresses = new WeakMap();
/** Tab roots with this module's listeners. */
let typingRoots = new WeakSet();
const typingRefs = new Set();
/**
 * Tab root → a BrowsingContext of its tab here. The root is the tab's
 * WindowRoot, which can't say which tab it is (no docShell), so the actor
 * that arms it does.
 */
const tabOfRoot = new WeakMap();

let isZeniusInput = () => false;
let watching = false;
/** Set while the replay types (typeAgain): its keys are never a trigger. */
let replaying = false;

/** capture.sys.mjs passes its dispatchIn test: is zenius dispatching in this tab root now? */
export function setZeniusInputTest(fn) {
  isZeniusInput = fn;
}

function isTaskTab(bc) {
  try {
    return !!bc && !!Services.cpmm.sharedData.get(TASK_BROWSERS_KEY)?.has(bc.browserId);
  } catch {
    return false;
  }
}

/**
 * A page a finished task kept that a reply in its Work chat may hand back:
 * here the sense only reports the user's input to the parent (onInput),
 * so that page stays the user's. Nothing is dropped, held or discarded for
 * it.
 */
function isKeptTab(bc) {
  try {
    return !!bc && !!Services.cpmm.sharedData.get(KEPT_BROWSERS_KEY)?.has(bc.browserId);
  } catch {
    return false;
  }
}

/**
 * Did the agent's code leave something hooked in `bc`'s page, its top
 * document or a frame (the observe layer's evidence)? Only that holds the user's
 * input. A page the agent made reads "drop", and keeps it on, hooked or not.
 */
const isHookedPage = bc => evidenceFlag(bc) !== "drop" && evidenceOf(bc).hooked !== undefined;

/** The top document of `bc`'s tab, by innerWindowId. */
function topDocId(bc) {
  try {
    return bc?.top?.currentWindowContext?.innerWindowId ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Is the top document of `bc`'s tab held, since the user's trigger in a
 * hooked page (or a hand-off's reload that brought no new one)? Then none
 * of the user's presses and keys reach it.
 */
function documentHeld(bc) {
  const doc = topDocId(bc);
  return !!doc && (heldHere.has(doc) || !!Services.cpmm.sharedData.get(TYPING_HELD_DOCS_KEY)?.has(doc));
}

/** Does the core hold the typing of `bc`'s tab around a hand-off's reload? Presses pass. */
function tabTypingHeld(bc) {
  try {
    return !!bc?.browserId && !!Services.cpmm.sharedData.get(TYPING_HELD_TABS_KEY)?.has(bc.browserId);
  } catch {
    return false;
  }
}

/** Does a hold cover the user's typing in `bc`'s tab now? */
export function typingHeld(bc) {
  return documentHeld(bc) || tabTypingHeld(bc);
}

/** The element an event of the user's input goes to, inside shadow trees; a document's or window's root element. */
function targetOf(e) {
  const t = e.composedTarget ?? e.originalTarget ?? e.target;
  if (t?.nodeType === 1) {
    return t;
  }
  if (t?.nodeType === 9) {
    return t.documentElement;
  }
  return t?.parentElement ?? t?.document?.documentElement ?? null;
}

const TEXT_INPUTS = new Set([
  "text",
  "password",
  "search",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

/** Is `el` something the user's typing goes into? */
export function isEditable(el) {
  if (!el || el.nodeType !== 1) {
    return false;
  }
  if (el.ownerDocument?.designMode === "on" || el.isContentEditable) {
    return true;
  }
  if (HTMLTextAreaElement.isInstance(el)) {
    return true;
  }
  return HTMLInputElement.isInstance(el) && TEXT_INPUTS.has(el.type);
}

/** The field a press on `el` goes to: the field itself, or a label's. */
function pressedField(el) {
  if (isEditable(el)) {
    return el;
  }
  const control = el?.closest?.("label")?.control;
  return isEditable(control) ? control : null;
}

/** The user's event as a trigger: "press", "key", "paste", "drop" or "composition". */
function kindOf(type) {
  if (PRESS_TYPES.has(type)) {
    return "press";
  }
  if (KEYS.has(type)) {
    return "key";
  }
  return COMPOSITION.has(type) ? "composition" : type;
}

/**
 * Drop one event of the user's: no listener after this one sees it, and
 * nothing of its default runs in the page. A shortcut's key (Ctrl or Cmd,
 * or a function key like F5) keeps its default, so the browser's own
 * shortcuts still work: the page and its editor never see it, and a paste
 * it starts is dropped as a paste. Not Enter's: Ctrl+Enter in a text field
 * submits its form.
 */
function drop(e) {
  e.stopImmediatePropagation();
  const shortcut = KEYS.has(e.type) && e.key !== "Enter" && (e.ctrlKey || e.metaKey || /^F\d+$/.test(e.key));
  if (e.cancelable && !shortcut) {
    e.preventDefault();
  }
}

/** The core's note of the field the user went for, so its reload puts the focus back there. */
function noteTarget(field) {
  try {
    ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/forms.sys.mjs").noteUserTarget?.(field);
  } catch (e) {
    console.error("[zenius] couldn't note the user's field for the reload", e);
  }
}

/**
 * The user's trigger in `bc`'s tab: hold its typing, and tell the parent,
 * with whether it went for a field (only then is there a replay).
 */
function startHold(bc, win, trigger, field) {
  const doc = topDocId(bc);
  if (!doc) {
    return;
  }
  heldHere.add(doc);
  if (field) {
    userFields.set(bc.browserId, { doc, field: new WeakRef(field) });
  }
  try {
    win.windowGlobalChild?.getActor("ZeniusInput")?.sendAsyncMessage("typingHeld", { trigger, doc, field: !!field });
  } catch (e) {
    console.error("[zenius] couldn't report the user's typing", e);
  }
}

/** Is `e` part of a press this guard stopped? A new press ends the old one. */
function inStoppedPress(root, e) {
  const began = stoppedPresses.get(root);
  if (!began) {
    return false;
  }
  if (e.type === began) {
    // The stopped press's end never reached this tab (it ended outside).
    stoppedPresses.delete(root);
    return false;
  }
  if (e.type === "mouseup") {
    // Its click, if any, comes in this same task.
    Services.tm.dispatchToMainThread(() => {
      if (stoppedPresses.get(root) === began) {
        stoppedPresses.delete(root);
      }
    });
  }
  return true;
}

function onUserEvent(e) {
  const root = e.currentTarget;
  if (!e.isTrusted || isZeniusInput(root)) {
    return;
  }
  if (dropped.has(e)) {
    // The system group's turn of an event the default group dropped.
    drop(e);
    return;
  }
  const target = targetOf(e);
  const win = target?.ownerDocument?.defaultView ?? null;
  const bc = win?.browsingContext;
  if (!bc) {
    return;
  }
  if (TAKE_OVER_TYPES.has(e.type) && isTaskTab(bc)) {
    // Take over: no world of the agent's sees the user's input. Cheap when
    // there's none (again in the system group, and after the first).
    discard(win);
  }
  const press = PRESS_TYPES.has(e.type);
  // The rest of a press this guard stopped is no new input of the user's.
  const pressGoesOn = press && inStoppedPress(root, e);
  const docHeld = !pressGoesOn && documentHeld(bc);
  if (pressGoesOn || docHeld || (!press && tabTypingHeld(bc))) {
    if (!pressGoesOn) {
      noteHeldInput(win, bc, e, docHeld);
    }
    dropped.add(e);
    drop(e);
    return;
  }
  if (press && tabTypingHeld(bc)) {
    // A press passes a tab's hold: the user's typing before it may have been
    // for another field than their typing after it.
    noteHeldInput(win, bc, e, false);
  }
  // The trigger: the user's first press or key anywhere in a hooked page,
  // during its task or after. Never the replay's own keys, whatever the
  // page's flag says: a hold already took them once, and a clean copy born
  // hooked would otherwise hold, load afresh and replay without end.
  if (replaying || !isHookedPage(bc)) {
    return;
  }
  const field = press ? pressedField(target) : isEditable(target) ? target : null;
  if (field) {
    noteTarget(field);
  }
  startHold(bc, win, kindOf(e.type), field);
  if (!press) {
    // A key that set it off is the replay's first.
    noteHeldInput(win, bc, e, true);
  }
  if (PRESS_STARTS.has(e.type)) {
    stoppedPresses.set(root, e.type);
  }
  dropped.add(e);
  drop(e);
}

// ------------------------------------------------- the clean copy's replay
//
// The keys the user types while the clean copy of a hooked page loads
// aren't lost. This guard drops them as
// before, and logs what it drops: here, for the tab's current top document,
// and at the parent (input/typing.sys.mjs), which keeps them for the
// documents the clean copy replaces. The parent also records the user's
// keys itself as it routes them, until the hold lifts: a key typed at the
// very moment the clean copy commits reaches no document here (Gecko drops
// it during the swap), but it passed the parent. As the tab's hold
// lifts, the clean copy's process types it all again, in the order it came,
// before the user's next key. Only into the field the user went for, and
// only where the core's carry-over put the focus back (forms.sys.mjs's
// userFieldBack).

/** browserId → the user's input this guard dropped in its tab's current top document here: {doc, entries}. */
const logs = new Map();
/** browserId → the field the user's trigger went for, in the held document: {doc, field}. */
const userFields = new Map();
/** browserId → the parent's replay for the clean copy here, typed as the tab's hold lifts. */
const pendingReplays = new Map();
let watchingHolds = false;

/** The core's carry-over: the user's field, where it put the focus back in `doc`. */
function userFieldBack(doc) {
  try {
    return ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/forms.sys.mjs").userFieldBack?.(doc) ?? null;
  } catch {
    return null;
  }
}

/** The top document of `win`'s tab, when it's in this process. */
function topDocument(win) {
  try {
    return win.top?.document ?? null;
  } catch {
    return null;
  }
}

/** The field the user went for, in the document of `bc`'s tab that an event of theirs reached. */
function userFieldIn(win, bc, inHeldDoc) {
  if (inHeldDoc) {
    const noted = userFields.get(bc.browserId);
    return noted?.doc === topDocId(bc) ? (noted.field.deref() ?? null) : null;
  }
  const top = topDocument(win);
  return top ? userFieldBack(top) : null;
}

/**
 * What one event of the user's means for the replay:
 * - {key, code, keyCode}: text (one character, with no Ctrl, Alt or Meta
 *   but AltGr's) or Backspace, typed again;
 * - {end: true}: Enter, Tab, or a press that isn't on the user's field:
 *   what came before is typed, nothing after;
 * - {void: true}: anything else that changes the field or its caret (a
 *   shortcut, an arrow, Delete, a paste, a drop, an IME's composition):
 *   nothing is typed again, since a field with a part of what the user
 *   typed (their password, say) looks like their own typo;
 * - null: nothing for the replay (a modifier, a key's release, the rest of
 *   a press).
 *
 * @param {Event} e
 * @param {Element|null} mine  the user's field in the event's document, for a press
 */
function entryOf(e, mine) {
  const type = e.type;
  if (type === "keydown") {
    const entry = keydownEntry(e);
    // A key's, which the parent may have recorded too.
    return entry && { ...entry, src: "key" };
  }
  if (type === "paste" || type === "drop" || COMPOSITION.has(type)) {
    return { void: true };
  }
  if (PRESS_STARTS.has(type) || type === "touchstart") {
    // Again on the field the user went for, the same typing goes on: no
    // caret showed after their first press, so users press again.
    return mine && pressedField(targetOf(e)) === mine ? null : { end: true };
  }
  return null;
}

/**
 * Log one event of the user's that a hold dropped, or a press of theirs
 * that a tab's hold let by, here and at the parent.
 *
 * @param {boolean} inHeldDoc  the event's top document is held: the one the clean copy replaces
 */
function noteHeldInput(win, bc, e, inHeldDoc) {
  const id = bc.browserId;
  const doc = topDocId(bc);
  if (!id || !doc) {
    return;
  }
  const pressStart = PRESS_STARTS.has(e.type) || e.type === "touchstart";
  const entry = entryOf(e, pressStart ? userFieldIn(win, bc, inHeldDoc) : null);
  if (!entry) {
    return;
  }
  entry.t = Date.now();
  let log = logs.get(id);
  if (log?.doc !== doc) {
    log = { doc, entries: [] };
    logs.set(id, log);
  }
  watchHolds();
  if (log.entries.length >= REPLAY_MAX_ENTRIES) {
    return;
  }
  log.entries.push(entry);
  try {
    win.windowGlobalChild?.getActor("ZeniusInput")?.sendAsyncMessage("typingHeldKey", { entry, doc });
  } catch (err) {
    console.error("[zenius] couldn't keep the user's key for the clean copy", err);
  }
}

/**
 * The keys a replay types, from the user's input in order while held, or
 * null when they can't all be typed again.
 *
 * @param {Array<object>} entries
 * @param {number} until  the last moment (ms since the epoch) a key may have come
 */
function keysToType(entries, until) {
  const keys = [];
  for (const entry of entries) {
    if (entry?.end) {
      break;
    }
    if (!entry || entry.void || typeof entry.key !== "string" || !(entry.t <= until) || keys.length >= REPLAY_MAX_KEYS) {
      return null;
    }
    keys.push(entry);
  }
  return keys;
}

/** The focused element of `doc`, inside shadow trees. */
function deepActive(doc) {
  let el = doc.activeElement;
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}

/**
 * Type `keys` into `field`, focused in `win`, as the user's own: trusted
 * events, outside zenius's dispatch, so the page's handlers and this guard
 * take them as the user's typing (their secret field's report included).
 */
function typeAgain(win, field, keys) {
  const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
  if (!tip.beginInputTransactionForTests(win)) {
    return 0;
  }
  let typed = 0;
  // Gecko dispatches each key at once, inside these calls: the flag covers
  // exactly the replay's events, and the page's handlers they run.
  replaying = true;
  try {
    for (const { key, code, keyCode } of keys) {
      // A handler of the page's may move the focus: the rest stays dropped.
      if (win.closed || deepActive(win.document) !== field) {
        break;
      }
      const ev = new win.KeyboardEvent("", { key, code: code || "", keyCode: keyCode || 0 });
      const flags = key === "Backspace" ? tip.KEY_NON_PRINTABLE_KEY : tip.KEY_FORCE_PRINTABLE_KEY;
      tip.keydown(ev, flags);
      tip.keyup(ev, flags);
      typed++;
    }
  } finally {
    replaying = false;
  }
  return typed;
}

/** For tests: the replay's typing, as replayNow does it once the hold lifts. */
export function typeAgainForTest(win, field, keys) {
  return typeAgain(win, field, keys);
}

function replayNow(id) {
  const pending = pendingReplays.get(id);
  pendingReplays.delete(id);
  const log = logs.get(id);
  logs.delete(id);
  userFields.delete(id);
  const win = pending?.win.deref();
  if (!win || win.closed || pending.voided || topDocId(win.browsingContext) !== pending.doc) {
    return;
  }
  const here = log?.doc === pending.doc ? log.entries : [];
  const keys = keysToType(mergedInput(pending.keys, [...pending.entries, ...here]), pending.until);
  if (!keys?.length) {
    return;
  }
  const field = userFieldBack(win.document);
  if (!field || deepActive(win.document) !== field || !isEditable(field) || field.disabled || field.readOnly) {
    return;
  }
  typeAgain(win, field, keys);
}

/** Forget the logs of tabs no hold covers any more, that wait for no replay. */
function pruneLogs() {
  const docs = Services.cpmm.sharedData.get(TYPING_HELD_DOCS_KEY);
  const tabs = Services.cpmm.sharedData.get(TYPING_HELD_TABS_KEY);
  const held = (id, doc) => pendingReplays.has(id) || !!tabs?.has(id) || !!docs?.has(doc) || heldHere.has(doc);
  for (const [id, log] of logs) {
    if (!held(id, log.doc)) {
      logs.delete(id);
    }
  }
  for (const [id, noted] of userFields) {
    if (!held(id, noted.doc)) {
      userFields.delete(id);
    }
  }
}

function watchHolds() {
  if (watchingHolds) {
    return;
  }
  watchingHolds = true;
  Services.cpmm.sharedData.addEventListener("change", e => {
    if (!e.changedKeys.includes(TYPING_HELD_TABS_KEY) && !e.changedKeys.includes(TYPING_HELD_DOCS_KEY)) {
      return;
    }
    for (const [id, pending] of [...pendingReplays]) {
      const win = pending.win.deref();
      if (!win || win.closed) {
        pendingReplays.delete(id);
      } else if (!typingHeld(win.browsingContext)) {
        replayNow(id);
      }
    }
    pruneLogs();
  });
}

/**
 * The parent's replay for the clean copy now in `win` (input/typing.sys.mjs):
 * what the user's input left in the documents it replaced, and the keys the
 * parent routed to the tab meanwhile. It comes just before the tab's hold
 * lifts, and is typed then, with what this process dropped in the clean
 * copy meanwhile.
 *
 * @param {Window} win  the clean copy's top window
 * @param {{keys?: Array<object>, entries?: Array<object>, until?: number, void?: boolean}} data
 */
export function receiveReplay(win, { keys = [], entries = [], until = 0, void: voided = false } = {}) {
  const bc = win?.browsingContext;
  if (!bc?.browserId || bc.parent) {
    return;
  }
  pendingReplays.set(bc.browserId, {
    win: new WeakRef(win),
    doc: topDocId(bc),
    keys: Array.isArray(keys) ? keys.slice(0, REPLAY_MAX_ENTRIES) : [],
    entries: Array.isArray(entries) ? entries.slice(0, REPLAY_MAX_ENTRIES) : [],
    until: Number(until) || 0,
    voided: !!voided,
  });
  watchHolds();
  if (!typingHeld(bc)) {
    replayNow(bc.browserId);
  }
}

/** Documents of kept pages whose user input the parent has heard of. */
const keptReported = new WeakSet();

function onInput(e) {
  const root = e.currentTarget;
  if (!e.isTrusted || isZeniusInput(root)) {
    return;
  }
  const target = targetOf(e);
  const doc = target?.ownerDocument;
  if (!doc) {
    return;
  }
  const win = doc.defaultView;
  const bc = win?.browsingContext;
  // Any trusted input in a kept page, the user's typing, a paste, a drop
  // or a fill, keeps it the user's at a reply after its task's finish.
  if (bc && !keptReported.has(doc) && isKeptTab(bc.top)) {
    keptReported.add(doc);
    try {
      win.windowGlobalChild?.getActor("ZeniusInput")?.sendAsyncMessage("keptInput");
    } catch (err) {
      console.error("[zenius] couldn't report the user's input in a kept page", err);
    }
  }
  if (reported.has(doc)) {
    return;
  }
  if (!bc || !isTaskTab(bc) || !secretKind(target)) {
    return;
  }
  reported.add(doc);
  try {
    win.windowGlobalChild?.getActor("ZeniusInput")?.sendAsyncMessage("secretTyped");
  } catch (err) {
    console.error("[zenius] couldn't report the user's secret field", err);
  }
}

function addListeners(root) {
  // Default group, capture: at the tab's root this runs before any
  // listener of the page. The system group is dispatched afresh after it,
  // and holds the editor's own listeners: what's dropped is dropped there
  // too.
  for (const type of LISTENED) {
    root.addEventListener(type, onUserEvent, true);
    root.addEventListener(type, onUserEvent, SYSTEM_CAPTURE);
  }
  root.addEventListener("input", onInput, true);
}

function removeListeners(root) {
  for (const type of LISTENED) {
    root.removeEventListener(type, onUserEvent, true);
    root.removeEventListener(type, onUserEvent, SYSTEM_CAPTURE);
  }
  root.removeEventListener("input", onInput, true);
}

/**
 * The listeners go only on the roots of tasks' tabs and of pages with
 * something hooked in them, kept pages after a task included, and stay on
 * while a tab's typing is held: the keys the user types in a clean copy
 * before its hold lifts wait for its replay. capture.sys.mjs
 * calls this for each root it arms, with a BrowsingContext of its tab, and
 * this module again for all of them when the task tabs or the flags change.
 *
 * @param {EventTarget} root  the tab's WindowRoot in this process
 * @param {BrowsingContext} [bc]  a BrowsingContext of its tab, the first time
 */
export function syncTypingRoot(root, bc = tabOfRoot.get(root)) {
  if (!root || !bc) {
    return;
  }
  tabOfRoot.set(root, bc);
  // A tab of the user's here may join a task later (pages.adopt).
  watchTabs();
  let want = false;
  try {
    want = !bc.isDiscarded && (isTaskTab(bc) || isHookedPage(bc) || typingHeld(bc) || isKeptTab(bc));
  } catch {}
  if (want === typingRoots.has(root)) {
    return;
  }
  if (want) {
    typingRoots.add(root);
    typingRefs.add(new WeakRef(root));
    addListeners(root);
  } else {
    typingRoots.delete(root);
    removeListeners(root);
  }
}

/** Every root this process armed, after the task tabs or the flags changed. */
let rootsOfProcess = () => [];

export function setArmedRoots(fn) {
  rootsOfProcess = fn;
}

const WATCHED_KEYS = [TASK_BROWSERS_KEY, EVIDENCE_DOCS_KEY, TYPING_HELD_TABS_KEY, TYPING_HELD_DOCS_KEY, KEPT_BROWSERS_KEY];

function watchTabs() {
  if (watching) {
    return;
  }
  watching = true;
  Services.cpmm.sharedData.addEventListener("change", e => {
    if (!WATCHED_KEYS.some(key => e.changedKeys.includes(key))) {
      return;
    }
    for (const root of rootsOfProcess()) {
      syncTypingRoot(root);
    }
  });
}

/** No page that needs the guard lives in this process any more: no listener left. */
export function disarmTyping() {
  for (const ref of typingRefs) {
    const root = ref.deref();
    if (root) {
      removeListeners(root);
    }
  }
  typingRefs.clear();
  typingRoots = new WeakSet();
  reported = new WeakSet();
  dropped = new WeakSet();
  stoppedPresses = new WeakMap();
  heldHere.clear();
  logs.clear();
  userFields.clear();
  pendingReplays.clear();
}
