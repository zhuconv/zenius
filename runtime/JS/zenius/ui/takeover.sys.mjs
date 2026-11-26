// Takeover: the user's own input in an agent's page pauses the agent and
// asks whether to take over.
//
// Telling the user's input from the agent's needs no flag: real input (OS
// mouse, keyboard, touch) always enters through the parent process, where a
// chrome listener sees it targeted at the tab's <browser>, while the input
// our actors synthesize is dispatched inside the content process and never
// passes through the parent. Input that zenius code dispatches from the
// parent must run inside withAgentInput().

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import {
  moveNotice,
  removeNotice,
  showNotice,
} from "chrome://userscripts/content/zenius/ui/notices.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export const PROMPT = "zenius-takeover";
const IS_MAC = AppConstants.platform === "macosx";
// After "Let it continue", clicks don't re-prompt for a moment, so closing a
// menu the user had opened doesn't nag them again.
const GRACE_MS = 3000;
// A keydown older than this says nothing any more: isUserUsing asks about
// the last second.
const KEY_MEMORY_MS = 60000;
const INPUT_EVENTS = ["pointerdown", "touchstart", "keydown", "drop"];

// The pill counts down to what happens if the user does nothing: after
// clicks the agent resumes, after typing the user keeps control. The two
// end oppositely, so their titles differ, not only their muted text.
const TITLE = { clicked: "Agent paused", typed: "You're taking over" };
const DETAIL = {
  clicked: "it resumes in {s} s",
  typed: "in {s} s",
};

let agentInputDepth = 0;

/**
 * Run `fn`, which dispatches input into a page from the parent process,
 * without the takeover detector mistaking it for the user. Dispatch is
 * synchronous, so a depth counter covers it.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function withAgentInput(fn) {
  agentInputDepth++;
  try {
    return fn();
  } finally {
    agentInputDepth--;
  }
}

/** Is input that zenius dispatches from the parent under way (withAgentInput)? */
export function isAgentInput() {
  return agentInputDepth > 0;
}

/**
 * Keys that only modify other keys or switch the input source. Pressed
 * alone they never type, even in the middle of an IME composition: Cmd
 * before Cmd+L, or CapsLock switching a Chinese IME between Chinese and
 * English.
 */
const MODIFIER_KEYS = new Set([
  "Alt", "AltGraph", "CapsLock", "Control", "Fn", "FnLock", "Hyper", "Meta",
  "NumLock", "OS", "ScrollLock", "Shift", "Super", "Symbol", "SymbolLock",
  "Alphanumeric", "CodeInput", "Convert", "Eisu", "HangulMode", "HanjaMode",
  "Hankaku", "Hiragana", "HiraganaKatakana", "JunjaMode", "KanaMode",
  "KanjiMode", "Katakana", "ModeChange", "NonConvert", "Romaji", "Zenkaku",
  "ZenkakuHankaku", "GroupFirst", "GroupLast", "GroupNext", "GroupPrevious",
  "Unidentified",
]);

/**
 * What an input event seen in chrome means for takeover.
 *
 * @param {Event} event
 * @param {{mac?: boolean}} [platform]  defaults to this build's; tests pass
 *   both, so the Mac's rules run on Linux too
 * @returns {"pointer"|"key"|"drop"|null} null when it doesn't count
 */
export function classifyInput(event, { mac = IS_MAC } = {}) {
  switch (event.type) {
    case "pointerdown":
    case "touchstart":
      return "pointer";
    case "drop":
      return "drop";
    case "keydown":
      return keyCounts(event, mac) ? "key" : null;
  }
  return null;
}

/**
 * Keys that type or edit in the page count; browser shortcuts, lone
 * modifiers, input-source switches, F-keys and Escape don't.
 *
 * @param {KeyboardEvent} e
 * @param {boolean} mac
 */
function keyCounts(e, mac) {
  const key = e.key;
  if (MODIFIER_KEYS.has(key)) {
    return false;
  }
  const printable = [...key].length === 1;
  // AltGr types a character, though Windows also reports it as Ctrl+Alt.
  if (!mac && printable && e.getModifierState("AltGraph")) {
    return true;
  }
  // Shortcuts before IME state: an IME can keep composing while the user
  // presses Cmd+L.
  const accel = mac ? e.metaKey : e.ctrlKey;
  if (accel) {
    // Paste, cut, undo, redo and word deletion change the page; the rest are
    // browser shortcuts (new tab, address bar, switch Space, find, …).
    return /^[vxzy]$/i.test(key) || key === "Backspace" || key === "Delete";
  }
  if (mac ? e.ctrlKey : e.metaKey) {
    return false;
  }
  if (e.altKey && !mac) {
    return false; // Alt+key menu access on Windows and Linux
  }
  if (e.isComposing || key === "Process" || key === "Dead") {
    return true; // IME composition (a Chinese IME's keys come as Process) or an accent
  }
  if (printable) {
    return true; // a printable character, including space
  }
  return key === "Enter" || key === "Backspace" || key === "Delete" || key === "Tab";
}

/**
 * @typedef {object} TakeoverHost
 * @property {(tab: Element) => ({rec: object}|null)} lookup
 *   the Space record if `tab` is a managed page of an agent Space
 * @property {(rec: object, paused: boolean) => void} setPaused
 * @property {(rec: object, ownership: string, opts: {reason?: string, source: string}) => void} setOwnership
 * @property {(rec: object, outcome: string) => void} [onChange]
 *   called when a prompt opens or closes
 * @property {(rec: object) => boolean} [held]
 *   true while the user has paused the Space: input then opens no prompt
 * @property {(rec: object) => void} [noteUserInput]
 *   the user's real input reached one of the task's pages, whatever its
 *   ownership (zen-core's spaces.noteUserInput)
 * @property {(tab: Element) => (object|null)} [finishedTaskOf]
 *   the ended task that kept `tab` open at its finish, or null (zen-core's
 *   finishedTaskOf, which follows a page moved to another window)
 * @property {(rec: object, browser: Element, kind: "clicked"|"typed") => void} [noteKeptInput]
 *   the user clicked or typed in such a kept tab (zen-core's noteKeptInput):
 *   a reply to the task's chat then leaves that page with the user
 */

/**
 * @typedef {object} PromptState
 * @property {object} rec  the Space record
 * @property {Element} tab  where the prompt shows
 * @property {boolean} typed  the user typed, pasted or dropped something
 * @property {number} inputs
 * @property {number} openedAt
 * @property {number} timer
 * @property {number} deadline  when the quiet timer fires (epoch ms)
 */

export class Takeover {
  /**
   * Why input events reaching chrome did or didn't count, for diagnosing a
   * prompt that doesn't open (only on some machines, say).
   */
  stats = { seen: 0, counted: 0, skipped: {}, last: null };
  /** @type {Map<number, PromptState>} spaceId → open prompt */
  #prompts = new Map();
  /** @type {Map<number, number>} spaceId → no re-prompt for pointers until */
  #grace = new Map();
  /** @type {WeakMap<Window, Function>} */
  #listeners = new WeakMap();
  /**
   * The page's browserId → time of the user's last keydown there. By the
   * page, not its <browser>: window sync moves the page between windows'
   * copies of its tab, and its browserId goes with it.
   *
   * @type {Map<number, number>}
   */
  #lastKey = new Map();

  /** @param {TakeoverHost} host */
  constructor(host) {
    this.host = host;
  }

  get quietMs() {
    return Services.prefs.getIntPref("zenius.ux.takeover.quietMs", 10000);
  }

  /** @param {Window} win */
  attachWindow(win) {
    if (this.#listeners.has(win)) {
      return;
    }
    const onInput = event => this.#onEvent(win, event);
    this.#listeners.set(win, onInput);
    for (const type of INPUT_EVENTS) {
      // Capture on the window runs before any chrome handler could stop the
      // event, and before the page sees it. Not the system group: there,
      // pointerdown aimed at a remote <browser> never shows up.
      win.addEventListener(type, onInput, { capture: true });
    }
    win.addEventListener("unload", () => this.detachWindow(win), { once: true });
  }

  /** @param {Window} win */
  isAttached(win) {
    return this.#listeners.has(win);
  }

  /** @param {Window} win */
  detachWindow(win) {
    const onInput = this.#listeners.get(win);
    if (!onInput) {
      return;
    }
    this.#listeners.delete(win);
    for (const type of INPUT_EVENTS) {
      win.removeEventListener(type, onInput, { capture: true });
    }
  }

  /**
   * @param {Window} win
   * @param {Event} event
   */
  #onEvent(win, event) {
    this.stats.seen++;
    const skip = reason => {
      this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1;
      const t = event.target;
      this.stats.last = {
        type: event.type,
        key: event.key ?? null,
        target: t?.localName ?? null,
        // A <browser> that isn't the selected one, or no longer in the
        // window, points at input captured by an earlier page.
        selected: t?.localName === "browser" ? t === win.gBrowser?.selectedBrowser : null,
        connected: t?.isConnected ?? null,
        reason,
      };
    };
    if (agentInputDepth > 0) {
      return skip("agentInput");
    }
    if (!event.isTrusted) {
      return skip("untrusted");
    }
    const browser = event.target;
    // Only the page itself: clicks on chrome (this prompt, the URL bar, the
    // Space header) never count.
    if (browser?.localName !== "browser") {
      return skip("notPage");
    }
    // Every real key, counted or not: a Cmd+C opens no prompt, but the copy
    // it makes is the user's (lastKeyAt, for the clipboard).
    if (event.type === "keydown") {
      this.#noteKey(browser);
    }
    const kind = classifyInput(event);
    if (!kind) {
      return skip("notInput");
    }
    const tab = win.gBrowser?.getTabForBrowser(browser);
    const hit = tab && this.host.lookup(tab);
    if (!hit) {
      // A tab an ended task kept open: the user's click or key there keeps
      // the page with them when a reply gives the task back. What counts is
      // what counts here (classifyInput): a scrollbar drag or Space counts
      // too, which only keeps a page that may have changed with the user.
      // Every counted one goes; zen-core keeps the first per tab.
      const kept = tab ? this.host.finishedTaskOf?.(tab) : null;
      if (kept) {
        try {
          this.host.noteKeptInput?.(kept, browser, kind === "key" ? "typed" : "clicked");
        } catch (e) {
          console.error("[zenius] noting the user's input in a kept tab failed", e);
        }
        return skip("kept");
      }
      return skip("notManaged");
    }
    // Whoever holds the task: an agent's takeOver, or its claim of a task
    // handed to the user, waits until 10 s after the user's last real input
    // there (zen-core keeps the time).
    try {
      this.host.noteUserInput?.(hit.rec);
    } catch (e) {
      console.error("[zenius] noting the user's input failed", e);
    }
    if (hit.rec.ownership !== "agent") {
      return skip("notAgent");
    }
    // A Space the user paused from the tasks panel already waits for them.
    if (this.host.held?.(hit.rec)) {
      return skip("held");
    }
    if (!this.handleInput(hit.rec, tab, kind)) {
      return skip("grace");
    }
    this.stats.counted++;
    this.stats.last = { type: event.type, key: event.key ?? null, target: "browser", reason: "counted" };
  }

  /**
   * The user's own input reached an agent's page.
   *
   * @param {object} rec  Space record, ownership "agent"
   * @param {Element} tab
   * @param {"pointer"|"key"|"drop"} kind
   * @returns {PromptState|null}
   */
  handleInput(rec, tab, kind) {
    let st = this.#prompts.get(rec.id);
    if (!st) {
      if (kind === "pointer" && Date.now() < (this.#grace.get(rec.id) ?? 0)) {
        return null;
      }
      // zen-input's hand-back hook reads promptState(id).typed at the pause
      // (input/handback.sys.mjs): keep it.
      st = { rec, tab, typed: kind !== "pointer", inputs: 0, openedAt: Date.now(), timer: 0, deadline: 0 };
      this.#prompts.set(rec.id, st);
      // Pause first and synchronously, while the page hasn't even seen this
      // event yet, so the agent's next action waits.
      this.host.setPaused(rec, true);
      this.host.onChange?.(rec, "opened");
    } else if (st.tab !== tab) {
      removeNotice(st.tab, PROMPT);
      st.tab = tab;
      // The prompt follows the user to this page of the task.
      this.host.onChange?.(rec, "moved");
    }
    st.inputs++;
    if (kind !== "pointer") {
      st.typed = true;
    }
    lazy.clearTimeout(st.timer);
    const quietMs = this.quietMs;
    st.deadline = Date.now() + quietMs;
    st.timer = lazy.setTimeout(() => this.resolve(rec.id, st.typed ? "takeover" : "continue"), quietMs);
    // Each input restarts the countdown; the pill updates in place.
    this.#render(st);
    return st;
  }

  /**
   * A page moved to another window's copy of its tab (window sync,
   * zen-core's pageMoved): its prompt goes with it, its countdown running.
   *
   * @param {Element} from
   * @param {Element} to
   */
  movePage(from, to) {
    for (const st of this.#prompts.values()) {
      if (st.tab === from && to && to !== from) {
        st.tab = to;
        moveNotice(from, to, PROMPT);
      }
    }
  }

  /** @param {PromptState} st */
  #render(st) {
    const id = st.rec.id;
    showNotice(st.tab, PROMPT, {
      title: st.typed ? TITLE.typed : TITLE.clicked,
      detail: st.typed ? DETAIL.typed : DETAIL.clicked,
      until: st.deadline,
      tone: "agent",
      buttons: [
        { label: st.typed ? "Take over now" : "Take over", primary: true, onClick: () => this.resolve(id, "takeover") },
        { label: "Resume agent", onClick: () => this.resolve(id, "continue") },
      ],
    });
  }

  /**
   * Close a Space's prompt.
   *
   * @param {number} spaceId
   * @param {"takeover"|"continue"|"cancel"} outcome
   *   cancel: ownership changed elsewhere (handOff, the panel, finish)
   */
  resolve(spaceId, outcome) {
    const st = this.#prompts.get(spaceId);
    if (!st) {
      return;
    }
    this.#prompts.delete(spaceId);
    lazy.clearTimeout(st.timer);
    removeNotice(st.tab, PROMPT);
    const { rec } = st;
    if (outcome === "takeover") {
      // Ownership first: the agent's waiting action must fail with
      // USER_IN_CONTROL rather than run when the pause lifts. The host's
      // Take over may reload the page first (zen-core's userTakeOver), and
      // keeps the agent paused until the hold begins.
      if (this.host.takeOver) {
        this.host.takeOver(rec, st.tab, { typed: !!st.typed });
      } else {
        this.host.setOwnership(rec, "agentDelegatedToUser", {
          reason: "manual_takeover",
          source: "user",
        });
      }
    } else if (outcome === "continue") {
      this.#grace.set(spaceId, Date.now() + GRACE_MS);
    }
    this.host.setPaused(rec, false);
    this.host.onChange?.(rec, outcome);
  }

  /** @param {number} spaceId */
  /**
   * When the user last pressed a key in this page (epoch ms), or 0.
   *
   * @param {Element} browser
   */
  lastKeyAt(browser) {
    return (browser?.browserId && this.#lastKey.get(browser.browserId)) || 0;
  }

  /** A key the user pressed in this page, now. Old entries go, so the map stays small. */
  #noteKey(browser) {
    const id = browser.browserId;
    if (!id) {
      return;
    }
    const now = Date.now();
    if (this.#lastKey.size >= 64) {
      for (const [k, at] of this.#lastKey) {
        if (now - at > KEY_MEMORY_MS) {
          this.#lastKey.delete(k);
        }
      }
    }
    this.#lastKey.set(id, now);
  }

  promptState(spaceId) {
    const st = this.#prompts.get(spaceId);
    return st
      ? { typed: st.typed, inputs: st.inputs, openedAt: st.openedAt, tab: st.tab }
      : null;
  }

  /** Close every prompt without changing ownership (shutdown, tests). */
  reset() {
    for (const id of [...this.#prompts.keys()]) {
      this.resolve(id, "cancel");
    }
    this.#grace.clear();
    this.stats = { seen: 0, counted: 0, skipped: {}, last: null };
  }
}
