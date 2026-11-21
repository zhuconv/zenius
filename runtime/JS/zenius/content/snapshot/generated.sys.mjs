// Gecko's generated boxes (CSS ::before and ::after) of one element, for the
// walker to print where Chromium's layout tree has them (walker.js;
// docs/research/snapshot.md §3.5). The sandbox can't see them: they are
// native anonymous content, which only chrome reaches.
//
// The walker asks about each element it visits, in a full-page walk as in a
// viewport one, except in a shadow root whose own sheets can't give a box
// text (rootGenerates). Asking costs 2-6 µs an element on the Linux server, in
// proportion to what the walk visits. Picking the elements to ask from the
// document's style rules instead costs in proportion to its CSS, which a
// site's first snapshot pays (GitHub's 17,581 rules: 35-100 ms, against a
// 60 ms target for a whole viewport snapshot), and on full pages it saved
// under half of the asking, on some pages none (docs/reports/zen-snapshot.md,
// 2026-11-20). A shadow root's sheets are small, so reading them is cheap.

/** What a scroll container lists after its children, before ::after (Gecko 160). */
const SCROLL_PARTS = new Set(["scrollbar", "scrollcorner", "resizer"]);
const DOCUMENT_FRAGMENT_NODE = 11;

/**
 * The element's ::before and ::after as Gecko lays them out, for the walker:
 * a JSON string of [before, after], each null or [text, display,
 * textTransform, rect]. Counters, quotes and attr() come resolved. Boxes
 * with no text (a clearfix's content: "") or that aren't visible are null.
 * rect is [left, top, right, bottom] in the document's viewport, with
 * `wantRect`, else null. Null for an element with neither box.
 *
 * @param {Element} el
 * @param {boolean} wantRect
 * @returns {string|null}
 */
export function generatedBoxes(el, wantRect) {
  let kids;
  try {
    kids = InspectorUtils.getChildrenForNode(el, true, false);
  } catch {
    return null;
  }
  const n = kids.length;
  if (!n) {
    return null;
  }
  // A shadow host's own root comes first, then ::marker and ::before, the
  // (light) children, and ::after last, after a scroll container's
  // scrollbar parts. A read costs about a microsecond (an Xray) and most
  // elements have neither box, so only the ends are read.
  let first = 0;
  let name = kids[0].localName;
  if (name == null && kids[0].nodeType === DOCUMENT_FRAGMENT_NODE) {
    if (n === 1) {
      return null;
    }
    first = 1;
    name = kids[1].localName;
  }
  if (name === "_moz_generated_content_marker" && first + 1 < n) {
    first++;
    name = kids[first].localName;
  }
  let last = n - 1;
  let lastName = last === first ? name : kids[last].localName;
  while (last > first && SCROLL_PARTS.has(lastName)) {
    last--;
    lastName = last === first ? name : kids[last].localName;
  }
  const before = name === "_moz_generated_content_before" ? kids[first] : null;
  const after = lastName === "_moz_generated_content_after" && (last > first || !before) ? kids[last] : null;
  if (!before && !after) {
    return null;
  }
  const win = el.ownerDocument?.defaultView;
  if (!win) {
    return null;
  }
  const out = [boxOf(win, el, before, "::before", wantRect), boxOf(win, el, after, "::after", wantRect)];
  return out[0] || out[1] ? JSON.stringify(out) : null;
}

function boxOf(win, el, kid, pseudo, wantRect) {
  const text = kid?.textContent;
  if (!text) {
    return null;
  }
  const style = win.getComputedStyle(el, pseudo);
  if (style.visibility !== "visible") {
    return null;
  }
  let rect = null;
  if (wantRect) {
    const r = kid.getBoundingClientRect();
    rect = [r.left, r.top, r.right, r.bottom];
  }
  return [text, style.display, style.textTransform, rect];
}

/** A ::before or ::after (Gecko writes :before as ::before), anywhere in a selector. */
const PSEUDO = /:(?:before|after)\b/i;
/** content values that give a box no text; any other may (a string, attr(), a counter, var()). */
const NO_TEXT = new Set(["", "none", "normal", "initial", "unset", '""', "''"]);

/** One document walk's verdicts, by sheet and by an inline sheet's text. */
let verdicts = new WeakMap();
let textVerdicts = new Map();

/** Starts a document walk afresh: sheets can change between snapshots. */
export function forgetRoots() {
  verdicts = new WeakMap();
  textVerdicts = new Map();
}

/**
 * Whether a shadow root's own stylesheets may give any ::before or ::after
 * in it text. They are the only author rules its elements match: the
 * document's stop at the root, except ::part(), and its hosts' and slots'
 * rules reach across through :host and ::slotted(), which the walker
 * handles itself. True when a sheet can't be read.
 *
 * @param {ShadowRoot} root
 * @returns {boolean}
 */
export function rootGenerates(root) {
  try {
    for (const sheet of root.styleSheets) {
      if (sheetGenerates(sheet)) return true;
    }
    for (const sheet of root.adoptedStyleSheets) {
      if (sheetGenerates(sheet)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function sheetGenerates(sheet) {
  let verdict = verdicts.get(sheet);
  if (verdict === undefined) {
    // Declarative shadow roots repeat a component's <style> in each instance.
    const owner = sheet.ownerNode;
    const text = owner?.localName === "style" && !InspectorUtils.hasRulesModifiedByCSSOM(sheet) ? owner.textContent : null;
    verdict = text === null ? undefined : textVerdicts.get(text);
    if (verdict === undefined) {
      verdict = rulesGenerate(sheet.cssRules, false);
      if (text !== null) textVerdicts.set(text, verdict);
    }
    verdicts.set(sheet, verdict);
  }
  return verdict;
}

/**
 * Whether these rules may give a ::before or ::after text: a style rule
 * naming one whose content or animation may (with the declarations and
 * rules nested in it), a keyframe that animates content, or an @import,
 * which isn't followed.
 */
function rulesGenerate(rules, inPseudo) {
  for (let i = 0, n = rules.length; i < n; i++) {
    const rule = rules[i];
    const type = rule.type;
    if (type === 3) {
      return true;
    }
    let pseudo = inPseudo;
    if (type === 1) {
      pseudo = inPseudo || PSEUDO.test(rule.selectorText);
    }
    if ((pseudo && (type === 1 || (type === 0 && rule.style))) || type === 8) {
      const style = rule.style;
      if (!NO_TEXT.has(style.getPropertyValue("content"))) return true;
      if (type !== 8) {
        const animation = style.getPropertyValue("animation-name");
        if (animation !== "" && animation !== "none") return true;
      }
    }
    const kids = rule.cssRules;
    if (kids && kids.length && rulesGenerate(kids, pseudo)) {
      return true;
    }
  }
  return false;
}
