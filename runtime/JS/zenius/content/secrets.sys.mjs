// Content side of the hand-back guard (input/handback.sys.mjs): a frame's
// secret fields when the user gets control of an agent tab, and the ones to
// empty when the agent gets it back. Secret means a password, a card's
// number, security code or expiry, or a one-time code: the user submits
// secrets themselves, and a code the agent could read is one it could use.
// Addresses stay: the user fills
// them so the agent can go on. Both run synchronously when their message arrives,
// so nothing reaches the frame in between.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AutofillFormFactory: "resource://gre/modules/shared/AutofillFormFactory.sys.mjs",
  FormAutofillHeuristics: "resource://gre/modules/shared/FormAutofillHeuristics.sys.mjs",
});

const CARD_FIELDS = new Set(["cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"]);
const CODE_FIELD = "one-time-code";

/** Document → (field → its value when the user got control). */
const snapshots = new WeakMap();

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

/** Is or was type=password: a "show password" toggle makes it text. */
const isPassword = el => HTMLInputElement.isInstance(el) && (el.type === "password" || el.hasBeenTypePassword);
const isFormField = el => HTMLInputElement.isInstance(el) || HTMLSelectElement.isInstance(el) || HTMLTextAreaElement.isInstance(el);

/** Field → the kind form autofill's heuristics gave it (null: none), asked once. */
const heuristicKinds = new WeakMap();

/** The kind form autofill's heuristics give `el`, for card forms without autocomplete attributes. */
function heuristicKind(el) {
  if (heuristicKinds.has(el)) {
    return heuristicKinds.get(el);
  }
  let kind = null;
  try {
    const form = lazy.AutofillFormFactory.createFromField(el);
    for (const detail of lazy.FormAutofillHeuristics.getFormInfo(form, false) ?? []) {
      if ((detail.element ?? detail.elementWeakRef?.deref()) === el) {
        kind = CARD_FIELDS.has(detail.fieldName) ? "card" : null;
        break;
      }
    }
  } catch {
    // Not a field form autofill looks at.
  }
  heuristicKinds.set(el, kind);
  return kind;
}

/**
 * One field's kind, as secretFields would give it: what the Resume clear
 * empties. The user's typing watch (content/typing.sys.mjs) asks it at their
 * input, so form autofill's heuristics run once per field.
 *
 * @returns {"password"|"card"|"code"|null}
 */
export function secretKind(el) {
  if (!el || el.nodeType !== 1) {
    return null;
  }
  if (isPassword(el)) {
    return "password";
  }
  if (!isFormField(el)) {
    return null;
  }
  const fieldName = el.getAutocompleteInfo?.()?.fieldName;
  if (fieldName === CODE_FIELD) {
    return "code";
  }
  if (CARD_FIELDS.has(fieldName)) {
    return "card";
  }
  return heuristicKind(el);
}

/**
 * The frame's secret fields, each with its kind. Card fields are the ones
 * Firefox's form autofill finds (its own heuristics), and any field whose
 * autocomplete attribute names one, for forms the heuristics miss. A
 * one-time code goes by its autocomplete attribute.
 *
 * @returns {Map<Element, "password"|"card"|"code">}
 */
export function secretFields(doc) {
  const out = new Map();
  const roots = new Map();
  for (const el of allElements(doc)) {
    if (isPassword(el)) {
      out.set(el, "password");
      continue;
    }
    if (!isFormField(el)) {
      continue;
    }
    const fieldName = el.getAutocompleteInfo?.()?.fieldName;
    if (fieldName === CODE_FIELD) {
      out.set(el, "code");
      continue;
    }
    if (CARD_FIELDS.has(fieldName)) {
      out.set(el, "card");
    }
    try {
      const root = lazy.AutofillFormFactory.findRootForField(el);
      if (root && !roots.has(root)) {
        roots.set(root, el);
      }
    } catch {
      // Not a field form autofill looks at.
    }
  }
  for (const field of roots.values()) {
    try {
      const form = lazy.AutofillFormFactory.createFromField(field);
      for (const detail of lazy.FormAutofillHeuristics.getFormInfo(form, false) ?? []) {
        const el = detail.element ?? detail.elementWeakRef?.deref();
        if (el && CARD_FIELDS.has(detail.fieldName) && !out.has(el)) {
          out.set(el, "card");
        }
      }
    } catch (e) {
      console.warn("[zenius] card field detection failed; autocomplete attributes only", e);
    }
  }
  return out;
}

/**
 * Drop the autocomplete controller's cached results when the field it
 * controls is in this document. With the popup closed, ArrowDown or a click
 * into the focused field only reopens a cached result. So after the agent's
 * searches (empty, input/autofill.sys.mjs), the user taking over that field
 * got no suggestions until they typed. When the agent gets the tab back, the
 * user's results (a saved login among them) leave the process too.
 */
function forgetSearches(doc) {
  try {
    const field = Cc["@mozilla.org/satchel/form-fill-controller;1"].getService(Ci.nsIFormFillController).controlledElement;
    if (field?.ownerDocument === doc) {
      Cc["@mozilla.org/autocomplete/controller;1"].getService(Ci.nsIAutoCompleteController).resetInternalState();
    }
  } catch (e) {
    console.warn("[zenius] couldn't reset the autocomplete controller", e);
  }
}

/** The focused element, inside shadow roots too. */
function deepActiveElement(doc) {
  let el = doc.activeElement;
  for (let inner = el?.openOrClosedShadowRoot?.activeElement; inner; inner = el.openOrClosedShadowRoot?.activeElement) {
    el = inner;
  }
  return el;
}

/**
 * The user got control: remember every secret field's value. With
 * `skipFocused`, not the focused one's: the user's key may have changed it
 * already (input/handback.sys.mjs).
 */
export function snapshot(actor, { skipFocused = false } = {}) {
  const doc = actor.document;
  if (!doc) {
    return { fields: 0 };
  }
  const skip = skipFocused ? deepActiveElement(doc) : null;
  const values = new WeakMap();
  let fields = 0;
  for (const el of secretFields(doc).keys()) {
    if (el !== skip) {
      values.set(el, el.value);
    }
    fields++;
  }
  snapshots.set(doc, values);
  forgetSearches(doc);
  return { fields };
}

/** A <select>'s own default: what it showed before anyone chose. */
function defaultIndex(select) {
  const i = [...select.options].findIndex(o => o.defaultSelected);
  return i >= 0 ? i : select.options.length ? 0 : -1;
}

/** A <select>'s index at the snapshot: its value then, or its default without one. */
function indexBefore(select, before) {
  const target = before === undefined ? defaultIndex(select) : [...select.options].findIndex(o => o.value === before);
  return target >= 0 ? target : defaultIndex(select);
}

/** Whether a field differs from its snapshot, so the clear would undo it. */
function differs(el, before) {
  if (HTMLSelectElement.isInstance(el)) {
    return el.selectedIndex !== indexBefore(el, before);
  }
  return !!el.value && before !== el.value;
}

/** Undo what the user did to one field. Returns whether there was anything to undo. */
function undo(el, before) {
  if (!differs(el, before)) {
    return false;
  }
  if (HTMLSelectElement.isInstance(el)) {
    el.selectedIndex = indexBefore(el, before);
    // As form autofill fills a select.
    for (const type of ["input", "change"]) {
      el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true }));
    }
    return true;
  }
  // As if the user deleted it: input events, so the page's own state (a
  // React form, say) lets go of it too.
  el.setUserInput("");
  if (el.value) {
    el.value = "";
  }
  return true;
}

/**
 * zen-ux's Resume asks first (input/handback.sys.mjs, typedSecrets): how many
 * secret fields the clear would empty here. It changes nothing.
 */
export function changedSince(actor) {
  const doc = actor.document;
  const values = doc ? snapshots.get(doc) : undefined;
  let changed = 0;
  for (const el of doc ? secretFields(doc).keys() : []) {
    if (differs(el, values?.get(el))) {
      changed++;
    }
  }
  return { changed };
}

/**
 * The agent gets control back (or takes a tab it never held): empty the
 * secret fields that changed or appeared since the snapshot. Without a
 * snapshot, every one that holds a value. Returns how many, never what they
 * held.
 */
export function clearChanged(actor) {
  const doc = actor.document;
  if (!doc) {
    return { cleared: 0, passwords: 0, cards: 0, codes: 0 };
  }
  const values = snapshots.get(doc);
  snapshots.delete(doc);
  forgetSearches(doc);
  const counts = { cleared: 0, passwords: 0, cards: 0, codes: 0 };
  for (const [el, kind] of secretFields(doc)) {
    if (undo(el, values?.get(el))) {
      counts.cleared++;
      counts[`${kind}s`]++;
    }
  }
  return counts;
}
