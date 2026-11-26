// The names, limits and rules the typing guard shares between the content
// and parent processes (the input layer). They have a module of their own, with
// no imports, so the parent needn't evaluate content/typing.sys.mjs, nor
// the agent's world it imports, to read them, and a test can run the rules
// in node.

/** sharedData: top documents (innerWindowId) whose tab's typing is held since the user's trigger. */
export const TYPING_HELD_DOCS_KEY = "zenius:typingHeldDocs";
/** sharedData: browserIds whose typing the core holds around a hand-off's quiet reload (dropUserTyping). */
export const TYPING_HELD_TABS_KEY = "zenius:typingHeldTabs";

/**
 * The clean copy's replay: at most this
 * many of the user's keys, typed within this long of their trigger.
 */
export const REPLAY_MAX_KEYS = 64;
export const REPLAY_MS = 3000;
/**
 * What a tab's log keeps of the user's input while it's held, its stops
 * included. Past this the first entries decide already: they hold a stop,
 * or more keys than a replay types.
 */
export const REPLAY_MAX_ENTRIES = REPLAY_MAX_KEYS * 2;

/** Keys that change no text: a replay neither stops at them nor types them. */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
  "Super",
  "Hyper",
  "Fn",
  "FnLock",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Symbol",
  "SymbolLock",
]);
/** Keys after which the user's typing was for something else: a replay ends there, without them. */
const END_KEYS = new Set(["Enter", "Tab"]);
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * What a keydown of the user's means for the replay, in the parent as in
 * content: {key, code, keyCode} for text (one character, with no Ctrl, Alt
 * or Meta but AltGr's) or Backspace; {end: true} for Enter or Tab;
 * {void: true} for any other key that changes the field or its caret (a
 * shortcut, an arrow, Delete, an IME's); null for a modifier.
 *
 * @param {KeyboardEvent} e
 */
export function keydownEntry(e) {
  if (MODIFIER_KEYS.has(e.key)) {
    return null;
  }
  if (END_KEYS.has(e.key)) {
    return { end: true };
  }
  const altGr = !!e.getModifierState?.("AltGraph");
  if (e.isComposing || e.keyCode === 229 || e.metaKey || ((e.ctrlKey || e.altKey) && !altGr)) {
    return { void: true };
  }
  const key = String(e.key ?? "");
  const text = key === "Backspace" || ([...key].length === 1 && !CONTROL_CHAR.test(key));
  return text ? { key, code: e.code || "", keyCode: e.keyCode || 0 } : { void: true };
}

/**
 * How far one process's Date.now() may read behind another's for the same
 * moment. Content logs a key after the parent routed it, never before.
 */
const SAME_CLOCK_MS = 5;

/** Could `logged`, a key a content guard logged, be `routed`, one the parent recorded? */
function sameKey(logged, routed) {
  const same = routed.key !== undefined ? logged.key === routed.key : logged.key === undefined && !!logged.end === !!routed.end && !!logged.void === !!routed.void;
  return same && routed.t <= logged.t + SAME_CLOCK_MS;
}

/**
 * The user's input to a held tab in the order it came, each key once, for
 * the clean copy's replay: the parent's record of the keys it routed to the
 * tab (`routed`), with what the content guards logged (`logged`: those keys
 * that reached a document, and what only content sees, such as presses and
 * drops; the replaced documents' first, then the clean copy's).
 *
 * Content gets the keys in the order the parent routed them, so the longest
 * run of keys both have in that order pairs them. A key only the parent has
 * is one no document got (Gecko drops a key typed as the clean copy
 * commits): it goes between the pairs around it, after what content logged
 * before the parent routed it. A key only content has came before the
 * parent's record began (the trigger's, say).
 *
 * @param {Array<object>} routed  in order, each with `t`
 * @param {Array<object>} logged  in order, each with `t`; content's keys have `src: "key"`
 * @returns {Array<object>}
 */
export function mergedInput(routed, logged) {
  const keys = [];
  logged.forEach((e, i) => {
    if (e?.src === "key") {
      keys.push(i);
    }
  });
  const m = keys.length;
  const n = routed.length;
  // most[i][j]: the most pairs that logged keys i.. and routed keys j.. make.
  const most = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const skip = Math.max(most[i + 1][j], most[i][j + 1]);
      most[i][j] = sameKey(logged[keys[i]], routed[j]) ? Math.max(skip, most[i + 1][j + 1] + 1) : skip;
    }
  }
  const out = [];
  let l = 0;
  let r = 0;
  // Up to the next pair, what only one side has, by time. What content
  // logged by the moment the parent routed a key came before that key.
  const upTo = (lEnd, rEnd) => {
    while (l < lEnd || r < rEnd) {
      out.push(r >= rEnd || (l < lEnd && logged[l].t <= routed[r].t) ? logged[l++] : routed[r++]);
    }
  };
  for (let i = 0, j = 0; i < m && j < n; ) {
    if (most[i][j] === most[i + 1][j + 1] + 1 && sameKey(logged[keys[i]], routed[j])) {
      upTo(keys[i], j);
      out.push(routed[j]);
      l = keys[i] + 1;
      r = j + 1;
      i++;
      j++;
    } else if (most[i + 1][j] >= most[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  upTo(logged.length, n);
  return out;
}
