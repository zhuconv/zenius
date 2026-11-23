// The typing guard's parent half (zen-input; 2026-11-20, on evidence only
// since the user's call of 2026-11-21).
// content/typing.sys.mjs stops the user's first press or key anywhere in a
// page the agent's code left something hooked in (zen-observe's evidence),
// and tells this module, which:
// - holds the tab's typing in every process of the tab, through sharedData,
//   until its top document is replaced;
// - asks zen-core for a clean copy (ZeniusService.cleanOnDemand): the page
//   loads afresh, with the form carried over and the focus back on the
//   field;
// - tells zen-ux (onUserTyping);
// - when the trigger went for a field, keeps what the user's input leaves
//   in the documents the clean copy replaces, and records the user's keys
//   itself as it routes them to the tab, until the clean copy is in. Then
//   it hands both to the clean copy, to be typed again there as its hold
//   lifts (content/typing.sys.mjs's replay; the manager's rule,
//   2026-11-20), and drops them (the manager's design, 2026-11-21).
// zen-core also holds a tab's typing around a hand-off's quiet reload
// (dropUserTyping), whether or not the user set anything off.

import {
  keydownEntry,
  REPLAY_MAX_ENTRIES,
  REPLAY_MAX_KEYS,
  REPLAY_MS,
  TYPING_HELD_DOCS_KEY,
  TYPING_HELD_TABS_KEY,
} from "chrome://userscripts/content/zenius/content/typingkeys.sys.mjs";

/** Top document (innerWindowId) → its browserId, held since the user's trigger. */
const heldDocs = new Map();
/** browserId → how many dropUserTyping holds are on. */
const heldTabs = new Map();
/** zen-ux's hooks. */
const hooks = new Set();

const TRIGGERS = new Set(["press", "key", "paste", "drop", "composition"]);

/**
 * browserId → what the user's input left in its tab since their trigger
 * went for a field, while the clean copy loads: {entries, until, origin,
 * keys, stopKeys}. `entries`: what the content guards logged; `keys`: the
 * parent's own record of the user's keys. Their keys, so never logged: they
 * may be a password.
 */
const replays = new Map();

/**
 * The replay of `id`'s tab goes: the parent stops watching the user's keys
 * and drops what it kept of them, even where the record is still held.
 */
function dropReplay(id, replay = replays.get(id)) {
  if (!replay) {
    return;
  }
  replay.stopKeys?.();
  replay.keys = [];
  replay.entries = [];
  if (replays.get(id) === replay) {
    replays.delete(id);
  }
}

/**
 * Record the user's keys to `browser`'s tab into `replay.keys`, as the
 * parent routes them to its content process. A key typed at the very moment
 * the clean copy commits reaches no document there (Gecko drops it during
 * the swap), but it passed here.
 *
 * @returns {(() => void)|null} stop
 */
function watchKeys(browser, replay) {
  // Not ownerGlobal: Gecko 160 has no Node.ownerGlobal.
  const win = browser.ownerDocument?.defaultView;
  if (!win) {
    return null;
  }
  const opts = { capture: true, mozSystemGroup: true };
  let on = true;
  function stop() {
    if (on) {
      on = false;
      win.removeEventListener("keydown", onKey, opts);
    }
  }
  function onKey(e) {
    // The first dispatch only, on its way to content: not content's reply.
    if (!e.isTrusted || e.target !== browser || e.isReplyEventFromRemoteContent) {
      return;
    }
    const entry = keydownEntry(e);
    if (!entry) {
      return;
    }
    const t = Date.now();
    replay.keys.push({ ...entry, t });
    // Past an end, a void, a key too late or one too many, the replay's
    // keys are settled: the parent keeps no more of the user's.
    if (entry.end || entry.void || t > replay.until || replay.keys.length > REPLAY_MAX_KEYS) {
      stop();
    }
  }
  win.addEventListener("keydown", onKey, opts);
  return stop;
}

/** An entry of the content guard's (content/typing.sys.mjs's entryOf), as it may be kept. */
function checkedEntry(entry) {
  const t = Number(entry?.t);
  if (!Number.isFinite(t)) {
    return { void: true, t: Date.now() };
  }
  if (entry.end === true) {
    return { end: true, t };
  }
  const key = entry.key;
  if (entry.void === true || typeof key !== "string" || (key !== "Backspace" && [...key].length !== 1)) {
    return { void: true, t };
  }
  const src = entry.src === "key" ? { src: "key" } : {};
  return { key, code: typeof entry.code === "string" ? entry.code : "", keyCode: Number.isInteger(entry.keyCode) ? entry.keyCode : 0, t, ...src };
}

/**
 * The content guard's word: one event of the user's input that a hold
 * dropped in `browser`'s tab, or a press there that it let by.
 *
 * @param {Element} browser
 * @param {{entry: object, doc: number}} data  `doc`: the top document it reached
 * @param {number|null} childID  the content process it came from
 */
export function noteHeldInput(browser, data, childID) {
  const r = replays.get(browser?.browserId);
  if (!r || typeof data?.doc !== "number" || r.entries.length >= REPLAY_MAX_ENTRIES) {
    return;
  }
  r.entries.push({ ...checkedEntry(data.entry), doc: data.doc, childID });
}

/**
 * The clean copy is in and the hold lifts: its replay goes to the new top
 * document. Only to a document of the origin the user typed into.
 */
function sendReplay(browser) {
  const r = replays.get(browser.browserId);
  if (!r) {
    return;
  }
  const { keys, entries: logged, until, origin } = r;
  dropReplay(browser.browserId, r);
  const wg = browser.browsingContext?.currentWindowGlobal;
  if (!wg || wg.isClosed || wg.documentPrincipal?.originNoSuffix !== origin) {
    return;
  }
  const doc = wg.innerWindowId;
  const childID = wg.domProcess?.childID ?? null;
  // The clean copy's process logged what it dropped itself: only the
  // replaced documents' input goes. A frame of the clean copy's in another
  // process has input its log lacks, so the replay couldn't be whole.
  const entries = logged.filter(e => e.doc !== doc).map(({ doc: _doc, childID: _child, ...entry }) => entry);
  const voided = logged.some(e => e.doc === doc && e.childID !== childID);
  try {
    // The parent's record goes with it, and from here only the clean copy
    // has the user's keys.
    wg.getActor("ZeniusInput").sendAsyncMessage("replayKeys", { keys, entries, until, void: voided });
  } catch (e) {
    console.error("[zenius] couldn't send the user's keys to the clean copy", e);
  }
}

function publish() {
  // A document that went can't come back: its hold goes with it.
  for (const id of [...heldDocs.keys()]) {
    const wg = WindowGlobalParent.getByInnerWindowId(id);
    if (!wg || wg.isClosed) {
      heldDocs.delete(id);
    }
  }
  Services.ppmm.sharedData.set(TYPING_HELD_DOCS_KEY, new Set(heldDocs.keys()));
  Services.ppmm.sharedData.set(TYPING_HELD_TABS_KEY, new Set(heldTabs.keys()));
  Services.ppmm.sharedData.flush();
}

/**
 * zen-core, around a hand-off's quiet reload (modules/handoff.sys.mjs):
 * drop the user's keys, pastes, drops and compositions to `browser`'s page,
 * in every process of the tab, until the returned release is called.
 * Clicks and scrolls pass. Holds nest, and a release is idempotent.
 *
 * `release({failed: true})`: no new document came, and the one the hold
 * began in may still hold the agent's code. Its typing stays dropped until
 * another document replaces it; a document that already did goes free.
 *
 * `release({failed: true, holdNow: true})`: a new document came, but it
 * can't take the user's typing either (zen-core's clean copy that came in
 * written, beside a window of its group that holds the agent's writes). Its
 * typing stays dropped too, until another document replaces it.
 *
 * @param {Element} browser
 * @returns {(opts?: {failed?: boolean, holdNow?: boolean}) => void} release
 */
export function dropUserTyping(browser) {
  const id = browser?.browserId;
  if (!id) {
    return () => {};
  }
  const before = browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? null;
  heldTabs.set(id, (heldTabs.get(id) ?? 0) + 1);
  publish();
  let released = false;
  return ({ failed = false, holdNow = false } = {}) => {
    if (released) {
      return;
    }
    released = true;
    if (failed && before && !heldDocs.has(before)) {
      heldDocs.set(before, id);
    }
    const now = failed && holdNow ? (browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? null) : null;
    if (now && !heldDocs.has(now)) {
      heldDocs.set(now, id);
    }
    if (failed) {
      // No clean copy: the user's keys stay dropped.
      dropReplay(id);
    }
    const left = (heldTabs.get(id) ?? 1) - 1;
    if (left > 0) {
      heldTabs.set(id, left);
    } else {
      heldTabs.delete(id);
      if (!failed) {
        // Before the publish below, on the same channel: the clean copy has
        // the replay before its hold lifts, and types it before any key the
        // user sends after.
        sendReplay(browser);
      }
    }
    publish();
  };
}

/**
 * zen-ux: `fn({browser, trigger, field, reloaded})` when the typing guard
 * stopped the user's first press or key in a hooked page
 * (anywhere in the tab, a button too), once per document. `trigger`
 * is "press", "key", "paste", "drop" or "composition". `field`: the trigger
 * went for a field, so the clean copy gets its focus and the user's keys
 * back (the replay); else their press went nowhere. `reloaded` is zen-core's
 * cleanOnDemand promise: it resolves once the clean document is in with the
 * form and focus back, and rejects if none came; the user's keys there stay
 * dropped then.
 *
 * @param {(e: {browser: Element, trigger: string, field: boolean, reloaded: Promise}) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onUserTyping(fn) {
  hooks.add(fn);
  return () => hooks.delete(fn);
}

/** zen-core's clean copy of `browser`'s page. */
function cleanCopy(browser) {
  const reloaded = Promise.resolve().then(() => {
    const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");
    return ZeniusService.cleanOnDemand(browser);
  });
  reloaded.catch(e => console.error("[zenius] the clean copy of a written page failed; the user's typing there stays held", e));
  return reloaded;
}

/**
 * The content guard's word (input/capture.sys.mjs's actor): the user's
 * trigger held `doc`, the top document of `browser`'s tab.
 *
 * @param {Element} browser
 * @param {{trigger: string, doc: number, field?: boolean}} data  `field`: the trigger went for a field
 */
export function noteUserTyping(browser, { trigger, doc, field } = {}) {
  if (!browser || !TRIGGERS.has(trigger) || typeof doc !== "number") {
    return;
  }
  // The tab's current top document only: word about one already replaced
  // holds nothing.
  if (browser.browsingContext?.currentWindowGlobal?.innerWindowId !== doc || heldDocs.has(doc)) {
    return;
  }
  heldDocs.set(doc, browser.browserId);
  const id = browser.browserId;
  const origin = browser.browsingContext?.currentWindowGlobal?.documentPrincipal?.originNoSuffix ?? null;
  const replay = field === true && origin ? { entries: [], until: Date.now() + REPLAY_MS, origin, keys: [], stopKeys: null } : null;
  dropReplay(id);
  if (replay) {
    replays.set(id, replay);
    replay.stopKeys = watchKeys(browser, replay);
  }
  publish();
  const reloaded = cleanCopy(browser);
  // A clean copy sends its replay as its hold lifts; none that came, or one
  // with nothing to clean, leaves the keys dropped.
  const forget = () => dropReplay(id, replay);
  reloaded.then(forget, forget);
  for (const fn of [...hooks]) {
    try {
      fn({ browser, trigger, field: field === true, reloaded });
    } catch (e) {
      console.error("[zenius] an onUserTyping hook failed", e);
    }
  }
}

/** For tests: the holds on now. */
export function typingHolds() {
  publish();
  return { docs: [...heldDocs.keys()], tabs: [...heldTabs.keys()] };
}
