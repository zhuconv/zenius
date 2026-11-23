// Content side of the quiet reload's form carry-over (zen-core, 2026-11-20).
// Before zenius reloads a page the user is about to
// hold, record() keeps the values of its visible, ordinary fields and which
// field had the focus; fill() puts them back into the new document, and the
// focus with them. Only the top document's fields, and only fields the
// site's own new document has.
//
// Never a secret (content/secrets.sys.mjs's passwords and card fields, and
// one-time codes), and never a field the user can't see. Gecko's own form
// restoration, which these loads keep off, restores hidden inputs too, where
// the agent could have planted a payee or a redirect that the user would
// then submit with their password.

import { secretFields } from "chrome://userscripts/content/zenius/content/secrets.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const TEXT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "number",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);
const CHECK_TYPES = new Set(["checkbox", "radio"]);
/** A record stays small: past these, the rest isn't carried. */
const MAX_FIELDS = 500;
const MAX_VALUE = 100000;
/** How long fill() waits for the new document's load event. */
const LOAD_WAIT_MS = 5000;

/** Every element under `root`, shadow roots included. */
function* allElements(root) {
  for (const el of root.querySelectorAll("*")) {
    yield el;
    const shadow = el.openOrClosedShadowRoot;
    if (shadow) {
      yield* allElements(shadow);
    }
  }
}

/**
 * "text", "check", "select", "textarea" or "password" for a field the
 * carry-over knows, else null. A password field's value never goes; its key
 * does, for the focus.
 */
function kindOf(el) {
  if (HTMLInputElement.isInstance(el)) {
    if (el.type === "password" || el.hasBeenTypePassword) {
      return "password";
    }
    return TEXT_TYPES.has(el.type) ? "text" : CHECK_TYPES.has(el.type) ? "check" : null;
  }
  if (HTMLTextAreaElement.isInstance(el)) {
    return "textarea";
  }
  return HTMLSelectElement.isInstance(el) ? "select" : null;
}

/**
 * Where a field sits in its document, the same way in the old document and
 * the new: its form's index (or none), its name or else its id, its type,
 * and for a checkbox or radio its value. Fields that share all of that are
 * told apart by their order (rank).
 */
function baseKey(el, doc) {
  const form = el.form;
  const formIndex = form ? Array.prototype.indexOf.call(doc.forms, form) : -1;
  // A password a "show" toggle made text is still a password field.
  const type = HTMLInputElement.isInstance(el) ? (el.hasBeenTypePassword ? "password" : el.type) : el.localName;
  const name = el.getAttribute("name") || el.id || "";
  return `${formIndex}|${name}|${type}${CHECK_TYPES.has(type) ? `|${el.value}` : ""}`;
}

function oneTimeCode(el) {
  try {
    if (el.getAutocompleteInfo?.()?.fieldName === "one-time-code") {
      return true;
    }
  } catch {}
  return /(^|\s)one-time-code(\s|$)/i.test(el.getAttribute("autocomplete") ?? "");
}

/** Can the user see it: rendered, not transparent, of some size, and not moved off the page. */
function visible(el) {
  try {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    const win = el.ownerDocument.defaultView;
    return rect.width >= 2 && rect.height >= 2 && rect.right + win.scrollX > 0 && rect.bottom + win.scrollY > 0;
  } catch {
    return false;
  }
}

/**
 * The visible, enabled fields record() and fill() look at, each under its
 * key, in document order. `carry`: its value may go across (never a secret's).
 */
function* fieldsOf(doc) {
  const secrets = secretFields(doc);
  const ranks = new Map();
  for (const el of allElements(doc)) {
    const kind = kindOf(el);
    if (!kind) {
      continue;
    }
    // Ranks count every field of the key, so a field hidden in one document
    // and shown in the other doesn't shift the rest.
    const base = baseKey(el, doc);
    const rank = ranks.get(base) ?? 0;
    ranks.set(base, rank + 1);
    if (el.disabled || el.readOnly || !visible(el)) {
      continue;
    }
    const carry = kind !== "password" && !secrets.has(el) && !oneTimeCode(el);
    yield { el, kind, key: `${base}#${rank}`, carry };
  }
}

/** The focused element, inside shadow roots too. */
function deepActiveElement(doc) {
  let el = doc.activeElement;
  while (el?.openOrClosedShadowRoot?.activeElement) {
    el = el.openOrClosedShadowRoot.activeElement;
  }
  return el;
}

const selectedValues = select => [...select.options].filter(o => o.selected).map(o => o.value);
const defaultValues = select => {
  const chosen = [...select.options].filter(o => o.defaultSelected).map(o => o.value);
  // With no option marked selected, a single select shows its first one.
  return chosen.length || select.multiple || !select.options.length ? chosen : [select.options[0].value];
};
const sameValues = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The values of the top document's visible, ordinary fields that differ
 * from what the page itself put there, and the key of the field that has
 * the focus, if any (a secret's too: its key, never its value).
 *
 * The page is about to be replaced, so its user activation goes too:
 * Gecko 160 puts up a beforeunload handler's leave prompt only for a page
 * the user (or the agent's click) activated, and that prompt would stop
 * zenius's load, the agent's own handler included. One call clears the
 * activation of the page's frames as well, in every process (measured
 * 2026-11-20: the load came in 30 ms, with no prompt).
 *
 * @returns {{fields: Array<{key: string, kind: string, value?: string, checked?: boolean, values?: string[]}>, focused: string|null}}
 */
/** Top document → the field the user went for (noteUserTarget). */
const userTargets = new WeakMap();
/** Top document → the user's field, where fill() put the focus back (zen-input's glue, for its replay). */
const userFieldsBack = new WeakMap();

/**
 * zen-input's replay of the keys the user typed while the clean copy
 * loaded: the field they went for, if fill() put the focus back there in
 * `doc`, else null (zen-input's glue).
 *
 * @param {Document} doc
 * @returns {Element|null}
 */
export function userFieldBack(doc) {
  const field = userFieldsBack.get(doc)?.deref();
  return field?.isConnected ? field : null;
}

/**
 * zen-input's typing guard stopped the user's first press or key into this
 * field of a written page, before the focus moved there: the reload on
 * demand (ZeniusService.cleanOnDemand) puts the focus there, not where the
 * page had it.
 *
 * @param {Element} field
 */
export function noteUserTarget(field) {
  const doc = field?.ownerDocument;
  if (doc && field.isConnected) {
    userTargets.set(doc, new WeakRef(field));
  }
}

export function record(actor) {
  const doc = actor.document;
  if (!doc?.documentElement || actor.browsingContext.parent) {
    return { fields: [], focused: null };
  }
  try {
    return { ...recordFields(doc), loadedFrom: loadedFrom(actor) };
  } finally {
    try {
      doc.clearUserGestureActivation();
    } catch (e) {
      console.warn("[zenius] clearing the page's user activation failed", e);
    }
  }
}

/**
 * The URL whose response is this document: its channel's, after any
 * redirects. The site's own pushState and replaceState change the URL the
 * page shows, never this one, so zen-core's quiet load goes here when the
 * URL shown would lead to another site (zen-snapshot's siteRouterRedirect).
 */
function loadedFrom(actor) {
  try {
    return actor.docShell?.currentDocumentChannel?.URI?.spec ?? null;
  } catch {
    return null;
  }
}

function recordFields(doc) {
  const fields = [];
  let focused = null;
  const target = userTargets.get(doc)?.deref();
  // Whether `focused` is the user's field, not the page's own focus (zen-input's glue).
  const userTarget = !!target?.isConnected;
  const active = target?.isConnected ? target : deepActiveElement(doc);
  for (const { el, kind, key, carry } of fieldsOf(doc)) {
    if (el === active) {
      focused = key;
    }
    if (!carry || fields.length >= MAX_FIELDS) {
      continue;
    }
    if (kind === "check") {
      if (el.checked !== el.defaultChecked) {
        fields.push({ key, kind, checked: el.checked });
      }
    } else if (kind === "select") {
      const values = selectedValues(el);
      if (!sameValues(values, defaultValues(el))) {
        fields.push({ key, kind, values });
      }
    } else if (el.value !== el.defaultValue && el.value.length <= MAX_VALUE) {
      fields.push({ key, kind, value: el.value });
    }
  }
  return { fields, focused, userTarget };
}

/** Resolves at the document's load event, or after `ms`. */
function loaded(doc, ms) {
  if (doc.readyState === "complete") {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const win = doc.defaultView;
    let timer = null;
    const done = event => {
      if (event && event.target !== doc) {
        return;
      }
      win.removeEventListener("load", done, true);
      lazy.clearTimeout(timer);
      resolve();
    };
    win.addEventListener("load", done, true);
    timer = lazy.setTimeout(done, ms);
  });
}

/**
 * Put record()'s values back, once the document has loaded, into the same
 * fields of the new document, and the focus into the field that had it. A
 * field the user already changed keeps what they typed.
 *
 * @returns {Promise<{filled: number, focused: boolean}>}
 */
export async function fill(actor, { fields = [], focused = null, userTarget = false } = {}) {
  const doc = actor.document;
  if ((!fields.length && !focused) || !doc || actor.browsingContext.parent) {
    return { filled: 0, focused: false };
  }
  // The parent asks as soon as the new document exists, which can be before
  // the parser has made its root: the page loads first.
  await loaded(doc, LOAD_WAIT_MS);
  if (!doc.documentElement) {
    return { filled: 0, focused: false };
  }
  const want = new Map(fields.map(field => [field.key, field]));
  const win = doc.defaultView;
  let filled = 0;
  let focusOn = null;
  for (const { el, kind, key, carry } of fieldsOf(doc)) {
    if (key === focused) {
      focusOn = el;
    }
    const field = want.get(key);
    if (!carry || !field || field.kind !== kind) {
      continue;
    }
    try {
      if (kind === "check") {
        // A radio can't be unchecked by a click; its group's checked one is
        // carried instead.
        if (field.checked && !el.checked && el.checked === el.defaultChecked) {
          el.click();
          filled++;
        } else if (!field.checked && el.checked && el.type === "checkbox" && el.checked === el.defaultChecked) {
          el.click();
          filled++;
        }
      } else if (kind === "select") {
        if (!sameValues(selectedValues(el), defaultValues(el))) {
          continue;
        }
        const values = new Set(field.values);
        let changed = false;
        for (const option of el.options) {
          const selected = values.has(option.value);
          if (option.selected !== selected) {
            option.selected = selected;
            changed = true;
          }
        }
        if (changed) {
          el.dispatchEvent(new win.Event("input", { bubbles: true }));
          el.dispatchEvent(new win.Event("change", { bubbles: true }));
          filled++;
        }
      } else if (el.value === el.defaultValue && el.value !== field.value) {
        // As form autofill fills: the page's handlers see it as typing.
        el.setUserInput(field.value);
        filled++;
      }
    } catch (e) {
      console.warn("[zenius] carrying a field over failed", e);
    }
  }
  if (focusOn) {
    try {
      focusOn.focus();
      // The caret where the user left off typing: at the end.
      try {
        focusOn.setSelectionRange?.(focusOn.value.length, focusOn.value.length);
      } catch {}
    } catch (e) {
      console.warn("[zenius] putting the focus back failed", e);
      focusOn = null;
    }
  }
  if (focusOn && userTarget === true) {
    userFieldsBack.set(doc, new WeakRef(focusOn));
  }
  return { filled, focused: !!focusOn };
}
