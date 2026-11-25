// The evidence flag, content side (zen-observe).
//
// The defenses act only on evidence of phishing or danger: one flag per
// document, with its reasons (hooked, made, listed, flagged). The parent
// (observe/evidence.sys.mjs) keeps the flags and publishes them as sharedData;
// this module answers from that copy, synchronously, in the page's process,
// with the marks this process made before the parent's copy comes back.
//
// It also holds the check of inserted markup (hookedMarkup) that the agent's
// world runs on the nodes its code inserts, and that zen-input's paste runs on
// the agent's markup, so the two count exactly the same things.
//
// Light on purpose: zen-input's guard imports it into every task page, and the
// parent may import it too. It imports only the shared names.

import { EVIDENCE_DOCS_KEY, EVIDENCE_REASONS, evidenceDetail } from "chrome://userscripts/content/zenius/content/worldkeys.sys.mjs";

export { EVIDENCE_DOCS_KEY, EVIDENCE_REASONS };

/** Hooked marks this process made (innerWindowId → detail), until the parent's copy has them. */
const hookedHere = new Map();
let watching = false;

function onWindowDestroyed(subject) {
  try {
    // Its id never comes back, and every read goes through live documents.
    hookedHere.delete(subject.QueryInterface(Ci.nsISupportsPRUint64).data);
  } catch {}
  if (watching && !hookedHere.size) {
    watching = false;
    try {
      Services.obs.removeObserver(onWindowDestroyed, "inner-window-destroyed");
    } catch {}
  }
}

/** A BrowsingContext for a Window, a BrowsingContext or a JSWindowActorChild. */
function contextOf(target) {
  try {
    if (!target) {
      return null;
    }
    if (BrowsingContext.isInstance(target)) {
      return target;
    }
    return target.browsingContext ?? null;
  } catch {
    return null;
  }
}

/** The current documents (innerWindowId) of the tab `bc` is in, its top's first. */
function documentsOfTab(bc) {
  const ids = [];
  try {
    for (const each of bc.top.getAllBrowsingContextsInSubtree()) {
      const id = each.currentWindowContext?.innerWindowId;
      if (id) {
        ids.push(id);
      }
    }
  } catch {}
  return ids;
}

function sharedFlags() {
  try {
    return Services.cpmm.sharedData.get(EVIDENCE_DOCS_KEY) ?? null;
  } catch {
    return null;
  }
}

/** A document's reasons: the parent's copy, and what this process marked before it. */
function marksOf(id, shared) {
  const theirs = shared?.get?.(id);
  const mine = hookedHere.get(id);
  if (mine === undefined) {
    return theirs ?? null;
  }
  return { hooked: mine, ...theirs };
}

/**
 * The page's evidence: each reason any of its current documents (the top
 * one, then its frames) has, with the first detail found. Synchronous.
 *
 * @param {Window|BrowsingContext} target  any document of the page
 * @returns {Record<string, string>} reason → detail; empty without evidence
 */
export function evidenceOf(target) {
  const out = {};
  const bc = contextOf(target);
  const shared = sharedFlags();
  if (!bc || (!shared?.size && !hookedHere.size)) {
    return out;
  }
  for (const id of documentsOfTab(bc)) {
    const marks = marksOf(id, shared);
    if (!marks) {
      continue;
    }
    for (const reason of EVIDENCE_REASONS) {
      if (reason in marks && !(reason in out)) {
        out[reason] = marks[reason];
      }
    }
  }
  return out;
}

/**
 * Has the page (its top document or a frame's) any evidence? Synchronous.
 *
 * @param {Window|BrowsingContext} target
 */
export function isEvident(target) {
  const bc = contextOf(target);
  const shared = sharedFlags();
  if (!bc || (!shared?.size && !hookedHere.size)) {
    return false;
  }
  return documentsOfTab(bc).some(id => !!marksOf(id, shared));
}

/**
 * zen-input's flag for the page, pageFlag's contract on evidence: "drop" when
 * its top document is one the agent made, "clean" when a document of it is
 * hooked (or made), else null. Listed and flagged pages get a warning, not a
 * clean copy: the danger is the page itself, which a reload brings back.
 *
 * @param {Window|BrowsingContext} target
 * @returns {"drop"|"clean"|null}
 */
export function evidenceFlag(target) {
  const bc = contextOf(target);
  if (!bc) {
    return null;
  }
  try {
    const top = bc.top.currentWindowContext?.innerWindowId;
    if (top && sharedFlags()?.get?.(top)?.made !== undefined) {
      return "drop";
    }
  } catch {}
  const ev = evidenceOf(bc);
  return ev.hooked !== undefined || ev.made !== undefined ? "clean" : null;
}

/**
 * The agent left code or a redirecting change in this window's document,
 * outside anything the parent sees: its world's insertions, or zen-input's
 * paste of markup that carries code. The document is hooked, here at once and
 * in the parent. Only that one: a window is hooked when the agent's code
 * wrote into it, not when page code left there could reach it: the defenses
 * act on evidence, and that route is a known gap with no reported use.
 *
 * @param {Window|BrowsingContext} target  the document's window
 * @param {string} detail  what was left, in a few words ("a script element")
 * @returns {string|null} the detail as recorded, when this marked the
 *   document; null when it was hooked already, or isn't a document here. The
 *   agent's call that marked it is told (content/agentworld.sys.mjs).
 */
export function markHooked(target, detail) {
  const bc = contextOf(target);
  if (!bc) {
    return null;
  }
  const text = evidenceDetail(detail);
  let id = 0;
  try {
    id = bc.docShell?.domWindow?.windowGlobalChild?.innerWindowId ?? 0;
  } catch {}
  if (!id || hookedHere.has(id) || sharedFlags()?.get?.(id)?.hooked !== undefined) {
    return null;
  }
  hookedHere.set(id, text);
  if (!watching) {
    watching = true;
    Services.obs.addObserver(onWindowDestroyed, "inner-window-destroyed");
  }
  try {
    Services.cpmm.sendAsyncMessage("zenius:evident", { marks: [[id, text]] });
  } catch (e) {
    console.error("[zenius] telling the parent of a hooked page", e);
  }
  return text;
}

/** Tests and diagnostics: what this module holds. */
export function evidenceHeld() {
  return { hookedHere: hookedHere.size, watching };
}

// ---------------------------------------------------------------------------
// The check of inserted markup

const FIELDS = new Set(["input", "textarea", "select"]);
const FRAMES = new Set(["iframe", "frame", "frameset"]);
// The attributes whose javascript: URL runs: a link's, a form's or a
// button's target, a frame's or an object's source, and an SVG animation's
// values, which can set a link's href. xlink:href's local name is href.
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "data", "to", "from", "values", "by"]);

/**
 * Does `value` hold a javascript: URL as a browser reads one: tabs and
 * newlines anywhere don't count, nor controls and spaces before the scheme.
 */
function isJavaScriptURL(value) {
  const s = String(value);
  let scheme = "";
  for (let i = 0; i < s.length && scheme.length < 11; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (!scheme && c <= 32)) {
      continue;
    }
    scheme += s[i];
  }
  return scheme.toLowerCase() === "javascript:";
}

/** What about one element counts as hooked, or null. */
function hookedElement(el) {
  const tag = el.localName;
  if (tag === "script") {
    return "a script element";
  }
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const name = attrs[i].localName.toLowerCase();
    if (name.startsWith("on")) {
      return `an inline handler (${name})`;
    }
  }
  for (let i = 0; i < attrs.length; i++) {
    const name = attrs[i].localName.toLowerCase();
    if (URL_ATTRIBUTES.has(name) && isJavaScriptURL(attrs[i].value)) {
      return `a javascript: URL (${name})`;
    }
  }
  if (FRAMES.has(tag)) {
    return "a frame";
  }
  if (tag === "object" || tag === "embed") {
    return "an object or embed element";
  }
  if (tag === "form") {
    return "a form";
  }
  if (tag === "input" && (el.getAttribute("type") ?? "").trim().toLowerCase() === "password") {
    return "a password field";
  }
  if (FIELDS.has(tag)) {
    return `a field (${tag})`;
  }
  const editable = el.getAttribute("contenteditable");
  if (editable !== null && editable.trim().toLowerCase() !== "false") {
    return "an editable area";
  }
  if (tag === "base") {
    return "a base element";
  }
  if (tag === "meta" && (el.getAttribute("http-equiv") ?? "").trim().toLowerCase() === "refresh") {
    return "a meta refresh";
  }
  if (tag === "style") {
    return "a style sheet";
  }
  if (tag === "link" && (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet")) {
    return "a style sheet";
  }
  return null;
}

/**
 * The first thing in `node` (itself, then its subtree in document order,
 * shadow roots included) that counts as hooked: code in the page's own realm
 * (a script, an inline handler, a javascript: URL, a frame, an object or
 * embed) or a change that redirects what the user types next (a form, a
 * field, an editable area, a base, a meta refresh, a style sheet). A
 * template's content isn't live, so it doesn't count. Pure: it reads the
 * node and changes nothing, so it runs as well over markup parsed inertly.
 *
 * @param {Node} node  an element, a fragment, a shadow root or a document
 * @returns {string|null} what it found, in a few words
 */
export function hookedMarkup(node) {
  try {
    const start = node?.nodeType === 9 ? node.documentElement : node;
    if (!start) {
      return null;
    }
    const stack = [start];
    while (stack.length) {
      const n = stack.pop();
      if (n.nodeType === 1) {
        const hit = hookedElement(n);
        if (hit) {
          return hit;
        }
        if (n.localName === "template") {
          continue;
        }
      }
      // Pushed last so it's checked first: a host's shadow tree, then its children.
      for (let c = n.lastElementChild; c; c = c.previousElementSibling) {
        stack.push(c);
      }
      let shadow = null;
      try {
        shadow = n.nodeType === 1 ? n.openOrClosedShadowRoot : null;
      } catch {}
      if (shadow) {
        stack.push(shadow);
      }
    }
  } catch (e) {
    console.error("[zenius] checking inserted markup", e);
  }
  return null;
}

/** What a changed attribute makes of its element, or null. */
function hookedAttribute(el, name, namespace) {
  const n = String(name).toLowerCase();
  if (n.startsWith("on")) {
    return `an inline handler (${n})`;
  }
  let value = null;
  try {
    value = namespace ? el.getAttributeNS(namespace, name) : el.getAttribute(name);
  } catch {}
  if (value !== null && URL_ATTRIBUTES.has(n) && isJavaScriptURL(value)) {
    return `a javascript: URL (${n})`;
  }
  const tag = el.localName;
  if ((tag === "iframe" || tag === "frame") && (n === "src" || n === "srcdoc")) {
    return "a frame";
  }
  if ((tag === "object" || tag === "embed") && (n === "data" || n === "src" || n === "type")) {
    return "an object or embed element";
  }
  if (tag === "form" && (n === "action" || n === "target" || n === "method" || n === "enctype")) {
    return `a changed form (${n})`;
  }
  if ((tag === "button" || tag === "input") && (n === "formaction" || n === "formtarget" || n === "formmethod" || n === "formenctype")) {
    return `a changed form (${n})`;
  }
  if (tag === "input" && n === "type" && (value ?? "").trim().toLowerCase() === "password") {
    return "a password field";
  }
  if ((tag === "input" || tag === "textarea" || tag === "form") && n === "autocomplete") {
    return "a field's autocomplete";
  }
  if (n === "contenteditable" && value !== null && value.trim().toLowerCase() !== "false") {
    return "an editable area";
  }
  if (tag === "base" && n === "href") {
    return "a base element";
  }
  if (tag === "meta" && (n === "http-equiv" || n === "content") && (el.getAttribute("http-equiv") ?? "").trim().toLowerCase() === "refresh") {
    return "a meta refresh";
  }
  if (tag === "link" && (n === "rel" || n === "href") && (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet")) {
    return "a style sheet";
  }
  return null;
}

/**
 * What a MutationObserver record of the agent's own write leaves that counts
 * as hooked (the world's watch, content/agentworld.sys.mjs), or null: the
 * nodes it added, by hookedMarkup; an attribute it changed; text put into a
 * style element (its sheet changes) or a script element (an empty one that's
 * connected runs it).
 *
 * @param {MutationRecord} record
 * @returns {string|null}
 */
export function hookedRecord(record) {
  try {
    const t = record.target;
    if (record.type === "childList") {
      if (t?.nodeType === 1 && record.addedNodes.length && (t.localName === "style" || t.localName === "script")) {
        return t.localName === "style" ? "a style sheet" : "a script element";
      }
      for (const node of record.addedNodes) {
        const hit = hookedMarkup(node);
        if (hit) {
          return hit;
        }
      }
      return null;
    }
    if (record.type === "attributes" && t?.nodeType === 1) {
      return hookedAttribute(t, record.attributeName, record.attributeNamespace);
    }
  } catch (e) {
    console.error("[zenius] checking the agent's write", e);
  }
  return null;
}
