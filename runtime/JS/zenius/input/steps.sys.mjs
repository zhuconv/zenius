// Each task's recent steps (zen-input; the user's ask of 2026-11-21).
// Every zenius task shows in the sidebar, whoever
// drives it (a Claude or Codex session in a terminal, a script, the sidebar's
// own agents), and its view lists what the agent did there. zen-core's
// dispatcher tells this module of each call a client makes, as it begins and
// as it ends (beginCall, endCall). The calls that are steps go into their
// task's ring, running until they end, and the oldest go past
// STEPS_PER_TASK. zen-ux reads the rings beside zen-core's task feed
// (stepsOf, onStep).
//
// A step is a line the user reads, and it lasts (zen-snapshot's points):
// - It never holds what the agent typed, pasted or chose, nor code, a value
//   or a file the call carried. A key shows only when it types no text.
// - A navigation shows the page's origin only, as snapshot, permissions and
//   the hand-off do: a URL's path, query and userinfo carry tokens.
// - An element's name comes from the page (content/actions.sys.mjs,
//   stepName): it's put on one line, invisible and control characters go,
//   it's capped, and it's quoted with any quote marks of its own turned
//   into apostrophes, so it can't read as the panel's own text. zen-ux
//   renders it as text.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
});

/** The steps a task keeps: its last ones. */
export const STEPS_PER_TASK = 50;
/** Tasks whose steps are kept, the last active ones: a finished task's stay readable for a while. */
const TASKS_KEPT = 32;
/** An element's name in a step, at most, in characters as the user counts them. */
const NAME_MAX = 60;

/** Task (space id) → its steps, oldest first; the Map's order is the tasks' last activity. */
const rings = new Map();
const listeners = new Set();
let nextId = 1;

/**
 * zen-core's dispatcher: a client's call begins. A call on a task that's a
 * step joins the task's ring at once, running, so a long wait shows while
 * it lasts; endCall settles it.
 *
 * @param {{method: string, params: object, at: number}} call  `at`: when it began (epoch ms)
 * @returns {object|null} the running step, for endCall; null when the call is none (yet)
 */
export function beginCall({ method, params, at } = {}) {
  const space = params?.space;
  if (!Number.isSafeInteger(space)) {
    return null;
  }
  const text = describeCall(method, params);
  if (!text) {
    return null;
  }
  return add(space, {
    id: nextId++,
    at: Number.isFinite(at) ? at : Date.now(),
    ms: null,
    method,
    text,
    outcome: "running",
    page: typeof params.page === "string" ? params.page : null,
  });
}

/**
 * zen-core's dispatcher: the call beginCall gave `step` for has ended. The
 * step gets its outcome and run time, and its text what the handler learned:
 * the element's name from the page. A call that names no task (a chooser's)
 * becomes a step here, once its handler has found the task.
 *
 * @param {object|null} step  beginCall's
 * @param {{method: string, params: object, outcome: string, ms: number, at: number, found?: {target?: object, space?: number, page?: string}}} call
 *   `outcome` is "ok" or the error's code; `ms` the run time, held time left
 *   out; `found` what the handler learned (ctx.step): the element it acted
 *   on, as content's stepName gives it, and the task and tab of a call that
 *   names a chooser instead of a page
 * @returns {object|null} the step as it ended
 */
export function endCall(step, { method, params, outcome, ms, at, found } = {}) {
  const space = step?.space ?? (Number.isSafeInteger(params?.space) ? params.space : found?.space);
  if (!Number.isSafeInteger(space)) {
    return null;
  }
  const text = describeCall(method, params, found?.target);
  const settle = s => {
    s.ms = Number.isFinite(ms) ? Math.round(ms * 10) / 10 : 0;
    s.outcome = typeof outcome === "string" && outcome ? outcome : "ok";
    s.text = text ?? s.text;
    return s;
  };
  if (step) {
    const held = rings.get(space)?.find(s => s.id === step.id);
    // Gone past the ring's end while it ran: nothing shows it any more.
    return held ? tell(space, settle(held)) : null;
  }
  if (!text) {
    return null;
  }
  return add(space, settle({ id: nextId++, at: Number.isFinite(at) ? at : Date.now(), method, text, page: typeof found?.page === "string" ? found.page : null }));
}

/** A new step at the end of its task's ring. */
function add(space, step) {
  const ring = rings.get(space) ?? [];
  rings.delete(space);
  rings.set(space, ring);
  ring.push(step);
  if (ring.length > STEPS_PER_TASK) {
    ring.splice(0, ring.length - STEPS_PER_TASK);
  }
  while (rings.size > TASKS_KEPT) {
    rings.delete(rings.keys().next().value);
  }
  return { ...tell(space, step), space };
}

function tell(space, step) {
  for (const fn of [...listeners]) {
    try {
      fn({ space, step: { ...step } });
    } catch (e) {
      console.error("[zenius] an onStep listener failed", e);
    }
  }
  return step;
}

/**
 * The task's recent steps, in the order their calls began, oldest first:
 * `{id, at, ms, method, text, outcome, page}`. `outcome` is "running" until
 * the call ends, then "ok" or the error's code, and `ms` null until then.
 * `id` grows from step to step, across tasks; `page` is the tab's label,
 * null for a call that names none (pages.new).
 *
 * @param {number} space  the task's space id
 * @returns {object[]}
 */
export function stepsOf(space) {
  return (rings.get(space) ?? []).map(step => ({ ...step }));
}

/**
 * `fn({space, step})` when a step begins and when it ends, as stepsOf has it
 * then: the same `id` both times.
 *
 * @returns {() => void} unsubscribe
 */
export function onStep(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------- the text

/** Characters that change how a line reads without showing: controls, bidi and other format characters, lone surrogates, and the rest that show nothing. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;
/** Quote marks, which a name turns into apostrophes so it can't close the step's quotes. */
const QUOTES = /["\u201C\u201D\u201E\u201F\u2033\u2036\u275D\u275E\u301D\u301E\u301F\uFF02]/g;

/** Text on one line, without invisible characters. */
function clean(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(INVISIBLE, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** At most `max` characters as the user counts them (code points), with … where it's cut. */
function cut(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** A name, quoted, or null when nothing of it shows. */
function quoted(text) {
  const name = cut(clean(text).replace(QUOTES, "'"), NAME_MAX);
  return name ? `"${name}"` : null;
}

/** What content's stepName may call an element that has no name. */
const NOUNS = new Set(["an editable area", "a field", "a button", "a link", "an image", "an element"]);

/**
 * The element as a step names it: the name the page gives it, else what it
 * is, else what the selector names (text=, a role's name), else "an element".
 */
function what(found, selector) {
  if (typeof found === "string") {
    return quoted(found) ?? what(null, selector);
  }
  if (found && typeof found === "object") {
    const name = quoted(found.name);
    if (name) {
      return name;
    }
    if (NOUNS.has(found.noun)) {
      return found.noun;
    }
  }
  return quoted(selectorName(selector)) ?? "an element";
}

/** The name a selector gives its element, for a call that found none: text=, a role's name, :has-text and :text-is. */
function selectorName(selector) {
  if (typeof selector !== "string") {
    return null;
  }
  const s = selector.trim();
  let m = /^text=(.+)$/s.exec(s);
  if (m) {
    return unquote(m[1]);
  }
  m = /^(?:loc=)?role:[A-Za-z0-9_-]+\[name\*?=(.+)\]$/s.exec(s);
  if (m) {
    return unquote(m[1]);
  }
  m = /:(?:has-text|text-is)\((.+)\)$/s.exec(s);
  return m ? unquote(m[1]) : null;
}

function unquote(text) {
  const m = /^\s*(["'])(.*)\1\s*$/s.exec(text);
  return m ? m[2] : text;
}

/**
 * A URL as a step shows it: its origin (scheme, host in ASCII so a look-alike
 * can't pass for the real one, and port), or what kind of page it is.
 */
function shownOrigin(raw) {
  let uri;
  try {
    uri = Services.io.newURI(String(raw ?? "").trim());
  } catch {
    return null;
  }
  switch (uri.scheme) {
    case "http":
    case "https":
      try {
        return Services.scriptSecurityManager.createContentPrincipal(uri, {}).originNoSuffix;
      } catch {
        return null;
      }
    case "about":
      return /^about:blank(?:[?#]|$)/.test(uri.spec) ? "a blank page" : "a browser page";
    case "file":
      return "a local file";
    default:
      return /^[a-z][a-z0-9+.-]{0,15}$/.test(uri.scheme) ? `a ${uri.scheme}: page` : "a page";
  }
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "ControlOrMeta"]);
const SHORTCUT_MODIFIERS = new Set(["Control", "Meta", "ControlOrMeta"]);

/**
 * A key or chord as the user's keyboard names it, or null when it would type
 * text (a character, with Shift or Option at most) or isn't a key's name.
 */
function shownKey(chord) {
  const raw = String(chord ?? "");
  const parts = raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
  const key = parts.pop();
  if (!key || !parts.every(mod => MODIFIERS.has(mod))) {
    return null;
  }
  const single = Array.from(key).length === 1;
  if (single) {
    if (!parts.some(mod => SHORTCUT_MODIFIERS.has(mod)) || !/^[\x21-\x7e]$/.test(key)) {
      return null;
    }
  } else if (!/^[A-Za-z][A-Za-z0-9]{1,24}$/.test(key)) {
    return null;
  }
  const mac = lazy.AppConstants.platform === "macosx";
  const names = mac ? { Meta: "Cmd", ControlOrMeta: "Cmd", Alt: "Option" } : { ControlOrMeta: "Control" };
  return [...parts.map(mod => names[mod] ?? mod), single ? key.toUpperCase() : key].join("+");
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const EVENTS = {
  popup: "a new tab",
  download: "a download",
  filechooser: "a file chooser",
  dialog: "a dialog",
  load: "the page to load",
  domcontentloaded: "the page to load",
  close: "the tab to close",
};
const MOUSE = {
  click: "Click on the page",
  move: "Move the pointer",
  down: "Press the mouse button",
  up: "Release the mouse button",
  wheel: "Scroll the page",
};
const KEYBOARD = {
  type: () => "Type text",
  insertText: () => "Type text",
  paste: () => "Paste text",
  press: p => `Press ${shownKey(p.key) ?? "a key"}`,
  down: p => `Hold ${shownKey(p.key) ?? "a key"}`,
  up: p => `Release ${shownKey(p.key) ?? "a key"}`,
};

/** Each method that's a step, and its text from the call's params and what it found. */
const TEXTS = {
  "pages.new": p => (p.url ? `Open ${shownOrigin(p.url) ?? "a page"} in a new tab` : "Open a new tab"),
  "pages.adopt": () => "Take a tab into the task",
  "pages.release": () => "Leave a tab to the user",
  "pages.close": () => "Close a tab",
  "page.goto": p => `Open ${shownOrigin(p.url) ?? "a page"}`,
  "page.reload": () => "Reload the page",
  "page.waitForURL": () => "Wait for the page's address",
  "page.waitForLoadState": () => "Wait for the page to load",
  "page.waitForSelector": (p, t) => `Wait for ${what(t, p.target)}`,
  "page.waitForFunction": () => "Wait for the page",
  "page.waitForEvent": p => `Wait for ${EVENTS[p.event] ?? "the page"}`,
  "page.evaluate": () => "Run code in the page",
  "page.fetch": p => `Fetch from ${shownOrigin(p.url) ?? "the web"}`,
  "page.screenshot": () => "Take a screenshot",
  "page.acceptDialog": () => "Accept the page's dialog",
  "page.dismissDialog": () => "Dismiss the page's dialog",
  "page.snapshot": p =>
    p.options?.scope === "subtree" || p.options?.root !== undefined
      ? "Read part of the page"
      : p.options?.scope === "full_page"
        ? "Read the whole page"
        : "Read the page",
  "page.click": (p, t) => `Click ${what(t, p.target)}`,
  "page.dblclick": (p, t) => `Double-click ${what(t, p.target)}`,
  "page.hover": (p, t) => `Hover over ${what(t, p.target)}`,
  "page.focus": (p, t) => `Focus ${what(t, p.target)}`,
  "page.fill": (p, t) => `${p.value === "" ? "Clear" : "Type into"} ${what(t, p.target)}`,
  "page.selectOption": (p, t) => `Choose in ${what(t, p.target)}`,
  "page.press": (p, t) => `Press ${shownKey(p.chord) ?? "a key"} on ${what(t, p.target)}`,
  "page.setInputFiles": (p, t) => {
    const n = Array.isArray(p.files) ? p.files.length : 0;
    return n ? `Attach ${plural(n, "file")} to ${what(t, p.target)}` : `Clear the files of ${what(t, p.target)}`;
  },
  "page.dragAndDrop": p => `Drag ${what(null, p.source)} to ${what(null, p.target)}`,
  "filechooser.setFiles": p => {
    const n = Array.isArray(p.files) ? p.files.length : 0;
    return n ? `Attach ${plural(n, "file")}` : "Cancel the file chooser";
  },
  "page.mouse": p => MOUSE[p.action] ?? null,
  "page.keyboard": p => KEYBOARD[p.action]?.(p) ?? null,
  "spaces.handOff": () => "Hand the task to the user",
  "spaces.takeOver": () => "Take the task back",
  "spaces.waitForControl": () => "Wait for the user",
  "spaces.finish": () => "Finish the task",
};

/**
 * A call as a step's text, or null when the call is no step (a query such as
 * page.url, the runtime's own methods).
 *
 * @param {string} method
 * @param {object} params
 * @param {{name?: string, noun?: string}|string} [target]  what the action found
 * @returns {string|null}
 */
export function describeCall(method, params, target) {
  const text = Object.hasOwn(TEXTS, method) ? TEXTS[method] : null;
  if (!text) {
    return null;
  }
  try {
    return text(params && typeof params === "object" ? params : {}, target) || null;
  } catch (e) {
    console.error(`[zenius] the step of ${method}`, e);
    return null;
  }
}
