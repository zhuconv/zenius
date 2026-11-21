// zen-snapshot's page walker, run inside a document's sandbox
// (content/snapshot/sandbox.sys.mjs) after aria.js and locators.js. It turns
// one document into Ego's snapshot tree (docs/research/snapshot.md §1, §3):
// roles, names, text, hidden content, compaction, viewport clipping, refs and
// their locators.
//
// Hot paths call the sandbox's own copies of the DOM prototypes
// ("primordials"), which is several times faster than the page's and immune
// to page patches. Every other read of the page goes through dom.js, so page
// script never gets an object of ours (content-boundary.md, finding 1). The
// chrome side (index.sys.mjs) passes the few privileged reads a sandbox
// can't do with each capture; they're never on the sandbox's global.
"use strict";
(function () {
  const aria = globalThis.__zsAria;
  const locators = globalThis.__zsLocators;
  const dom = globalThis.__zsDom;
  // The chrome helpers of the capture in progress (capture() sets them).
  let helpers = null;
  const chrome = () => helpers;

  // ---- primordials ----
  const own = (proto, name) => Object.getOwnPropertyDescriptor(proto, name);
  const NodeP = Node.prototype;
  const ElementP = Element.prototype;
  const DocumentP = Document.prototype;
  const nodeType = own(NodeP, "nodeType").get;
  const firstChild = own(NodeP, "firstChild").get;
  const parentNodeOf = own(NodeP, "parentNode").get;
  const getRootNode = own(NodeP, "getRootNode").value;
  const textContentOf = own(NodeP, "textContent").get;
  const nextSibling = own(NodeP, "nextSibling").get;
  const nodeValue = own(NodeP, "nodeValue").get;
  const isConnected = own(NodeP, "isConnected").get;
  const ownerDocumentOf = own(NodeP, "ownerDocument").get;
  const baseURI = own(NodeP, "baseURI").get;
  const localNameOf = own(ElementP, "localName").get;
  const namespaceOf = own(ElementP, "namespaceURI").get;
  const getAttribute = own(ElementP, "getAttribute").value;
  const hasAttribute = own(ElementP, "hasAttribute").value;
  const shadowRootOf = own(ElementP, "shadowRoot").get;
  const matches = own(ElementP, "matches").value;
  const checkVisibility = own(ElementP, "checkVisibility").value;
  const getRect = own(ElementP, "getBoundingClientRect").value;
  const clientWidth = own(ElementP, "clientWidth").get;
  const clientHeight = own(ElementP, "clientHeight").get;
  const clientLeft = own(ElementP, "clientLeft").get;
  const clientTop = own(ElementP, "clientTop").get;
  const scrollWidth = own(ElementP, "scrollWidth").get;
  const scrollHeight = own(ElementP, "scrollHeight").get;
  const documentElementOf = own(DocumentP, "documentElement").get;
  const defaultViewOf = own(DocumentP, "defaultView").get;
  const parentElementOf = own(NodeP, "parentElement").get;
  const childrenOf = own(ElementP, "children").get;
  const createRange = own(DocumentP, "createRange").value;
  const rangeSelectNodeContents = own(Range.prototype, "selectNodeContents").value;
  const rangeRect = own(Range.prototype, "getBoundingClientRect").value;

  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const VISIBILITY = { visibilityProperty: true };
  const MAX_DEPTH = 1024;
  const TEXT_MAX_BYTES = 200;

  // ---- what each element prints (§1.2, §1.3) ----
  const TRANSPARENT = 1;
  const SKIP = 2;

  /** Native HTML elements with a role of their own; anything else is a container. */
  const NATIVE = {
    a: "anchor",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    p: "paragraph",
    ul: "unordered_list", dl: "unordered_list", menu: "unordered_list", ol: "ordered_list",
    li: "list_item", dt: "list_item", dd: "list_item",
    table: "table", tr: "table_row", td: "table_cell", th: "table_cell",
    img: "image", canvas: "canvas", video: "video", audio: "audio",
    iframe: "iframe", frame: "iframe",
    form: "form", fieldset: "group", button: "button", textarea: "textbox", output: "output",
    html: TRANSPARENT, slot: TRANSPARENT, details: TRANSPARENT, address: TRANSPARENT,
    thead: TRANSPARENT, tbody: TRANSPARENT, tfoot: TRANSPARENT, map: TRANSPARENT,
    hr: SKIP, progress: SKIP, meter: SKIP, br: SKIP, wbr: SKIP, head: SKIP, script: SKIP,
    style: SKIP, noscript: SKIP, template: SKIP, title: SKIP, meta: SKIP, link: SKIP,
    base: SKIP, datalist: SKIP, option: SKIP, optgroup: SKIP, param: SKIP, source: SKIP,
    track: SKIP, area: SKIP, colgroup: SKIP, col: SKIP,
  };

  // Chromium's page-content walker (ai_page_content_agent.cc, Chromium 156,
  // which Ego ships) makes a node for an element without a type of its own
  // only for a reason (ShouldSkipSingleNode); otherwise the element's
  // children attach to its parent. The reasons we can see from here follow.
  /** Always a node: <figure> and the annotated (landmark) roles. */
  const KEPT_TAGS = new Set(["figure", "header", "nav", "search", "main", "article", "section", "aside", "footer"]);
  const KEPT_ROLES = new Set(["banner", "navigation", "search", "main", "article", "region", "complementary", "contentinfo"]);
  /** ARIA roles Chromium gives a type: dialogs, and the form controls of ProcessAriaFormControlNode. */
  const TYPED_ROLES = new Set(["dialog", "alertdialog", "checkbox", "menuitemcheckbox", "switch", "menuitemradio", "radio",
    "searchbox", "textbox"]);
  /** ARIA roles Chromium counts as clickable (ui::IsClickable). */
  const CLICKABLE_ROLES = new Set(["button", "checkbox", "link", "listbox", "option", "menuitem", "menuitemcheckbox",
    "menuitemradio", "radio", "searchbox", "spinbutton", "switch", "tab", "textbox", "treeitem", "doc-backlink",
    "doc-biblioref", "doc-glossref", "doc-noteref"]);
  /** Attributes whose presence Chromium counts as a clickability reason. */
  const CLICK_ATTRIBUTES = ["aria-haspopup", "aria-checked", "aria-pressed", "aria-selected"];
  const SCROLLS = new Set(["auto", "scroll"]);
  /** Hidden content find-in-page can reveal. */
  const ACTIVATABLE = "details:not([open]) *, [hidden=until-found] *";
  /** Elements with no type that the older rule always dropped. */
  const PLAIN = new Set(["html", "details", "address"]);

  /** Elements that print as leaves: their DOM children never show. */
  const LEAF = new Set(["img", "canvas", "video", "audio", "iframe", "frame", "input", "select", "textarea"]);

  /** Explicit ARIA roles print Chromium's internal role name, lower-cased. */
  const ARIA_PRINTED = {
    combobox: "comboboxgrouping", img: "image", image: "image", option: "listboxoption",
    progressbar: "progressindicator", radio: "radiobutton", separator: "splitter",
    textbox: "textfield", generic: "genericcontainer", directory: "list",
    deletion: "contentdeletion", insertion: "contentinsertion",
  };
  const ARIA_ROLES = new Set(("alert alertdialog application article banner blockquote button caption cell " +
    "checkbox code columnheader combobox comment complementary contentinfo definition deletion dialog " +
    "directory document emphasis feed figure form generic grid gridcell group heading image img " +
    "insertion link list listbox listitem log main mark marquee math menu menubar menuitem " +
    "menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation " +
    "progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator " +
    "slider spinbutton status strong subscript suggestion superscript switch tab table tablist " +
    "tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem").split(" "));

  /** Elements that are focusable or otherwise act as controls get refs (§1.7). */
  const REF_TAGS = new Set(["a", "button", "input", "select", "textarea", "fieldset", "output", "summary", "iframe", "frame"]);
  const REF_ROLES = new Set(["menuitemcheckbox", "menuitemradio"]);

  function explicitRole(el) {
    const value = getAttribute.call(el, "role");
    if (!value) {
      return null;
    }
    for (const token of value.split(/\s+/)) {
      const role = token.toLowerCase();
      if (ARIA_ROLES.has(role) || /^(doc|graphics)-[a-z]+$/.test(role)) {
        return role;
      }
    }
    return null;
  }

  function inputType(el) {
    return (getAttribute.call(el, "type") || "text").toLowerCase();
  }

  function inputRole(type) {
    switch (type) {
      case "hidden": return SKIP;
      case "checkbox": return "checkbox";
      case "radio": return "radio";
      case "button": case "submit": case "reset": return "button";
      case "image": return "image";
      case "number": case "range": return "spinbutton";
      case "search": return "searchbox";
      default: return "textbox";
    }
  }

  function isListBox(el) {
    if (hasAttribute.call(el, "multiple")) {
      return true;
    }
    const size = parseInt(getAttribute.call(el, "size") || "", 10);
    return size > 1;
  }

  function nativeRole(el, tag, ns, c) {
    if (ns !== HTML_NS) {
      // The outermost <svg> prints as one node; MathML and other XML is walked as containers.
      return ns === SVG_NS ? (tag === "svg" ? "svg_root" : SKIP) : "container";
    }
    switch (tag) {
      case "input": return inputRole(inputType(el));
      case "select": return isListBox(el) ? "listbox" : "combobox";
      case "body": return c.apc || c.topLevel ? "container" : TRANSPARENT;
      case "dialog":
        // Closed dialogs are display:none and never get here.
        return matches.call(el, ":modal") ? "dialog_modal" : "dialog_modeless";
    }
    if (c.apc && PLAIN.has(tag)) {
      return "container";
    }
    return NATIVE[tag] ?? "container";
  }

  /**
   * Why Chromium keeps an element without a type of its own as a node, or
   * null when it doesn't and the element's children attach to its parent
   * (ShouldSkipSingleNode and AddNodeInteractionInfo in actionable mode).
   * Not seen from here: JS event listeners and :hover rules, which make
   * Chromium keep a few more wrappers.
   */
  function keepsWrapper(c, el, tag, role, overflowing) {
    if (!c.apc || c.hit === null) {
      return "all";
    }
    // Hit testing over the viewport gives a node a z-order, so interaction
    // info: in the viewport nearly every box stays a node.
    if (c.hit.has(el)) {
      return "hit";
    }
    if (KEPT_TAGS.has(tag)) {
      return "tag";
    }
    if (role && KEPT_ROLES.has(role)) {
      return "landmark";
    }
    if (role && TYPED_ROLES.has(role)) {
      return "typed-role";
    }
    if (tag === "label") {
      try {
        if (dom.node(el.control)) return "label";
      } catch {}
    }
    const style = styleOf(c, el);
    const position = dom.str(style.position);
    if (position === "fixed" || position === "sticky") {
      return position;
    }
    if (SCROLLS.has(dom.str(style.overflowX)) || SCROLLS.has(dom.str(style.overflowY))) {
      return "scrolls";
    }
    if (dom.str(style.contentVisibility) === "hidden") {
      return "content-visibility";
    }
    if (matches.call(el, ":popover-open, :modal")) {
      return "top-layer";
    }
    // Interaction info, which pointer-events: none rules out.
    if (dom.str(style.pointerEvents) === "none") {
      return null;
    }
    if (overflowing && dom.str(style.overflowX) !== "visible" && dom.str(style.overflowX) !== "clip") {
      return "scroller";
    }
    if (role && CLICKABLE_ROLES.has(role)) {
      return "clickable-role";
    }
    for (const name of CLICK_ATTRIBUTES) {
      if (getAttribute.call(el, name)) return name;
    }
    const expanded = getAttribute.call(el, "aria-expanded");
    if (expanded === "true" || expanded === "false") {
      return "aria-expanded";
    }
    const autocomplete = getAttribute.call(el, "autocomplete");
    if (autocomplete !== null && autocomplete.toLowerCase() !== "off") {
      return "autocomplete";
    }
    const ariaAutocomplete = getAttribute.call(el, "aria-autocomplete");
    if (ariaAutocomplete === "inline" || ariaAutocomplete === "list" || ariaAutocomplete === "both") {
      return "aria-autocomplete";
    }
    // cursor: pointer counts only where it's set, not inherited (a shadow
    // root's top elements count as setting it).
    if (dom.str(style.cursor) === "pointer") {
      const parent = parentNodeOf.call(el);
      if (!parent || nodeType.call(parent) !== ELEMENT_NODE || dom.str(styleOf(c, parent).cursor) !== "pointer") {
        return "cursor";
      }
    }
    return null;
  }

  function tabIndexed(el) {
    const value = getAttribute.call(el, "tabindex");
    return value !== null && /^\s*[-+]?\d/.test(value);
  }

  // A shadow host that delegates focus isn't focusable itself (focus goes to
  // the first focusable element in it), so its tabindex makes no ref: Material
  // Web's <md-list-item tabindex="-1"> prints none; the link inside it does.
  function delegatesFocus(el, tag) {
    let root = shadowRootOf.call(el);
    if (!root && tag.includes("-")) root = chrome().closedShadowRoot(el);
    return !!root && root.delegatesFocus === true;
  }

  function editingHost(el) {
    const value = getAttribute.call(el, "contenteditable");
    return value !== null && /^(|true|plaintext-only)$/i.test(value);
  }

  function wantsRef(el, tag, role) {
    if (REF_TAGS.has(tag)) {
      return tag !== "input" || inputType(el) !== "hidden";
    }
    if (tag === "dialog" || ((tag === "video" || tag === "audio") && hasAttribute.call(el, "controls"))) {
      return true;
    }
    return (tabIndexed(el) && !delegatesFocus(el, tag)) || editingHost(el) || REF_ROLES.has(role);
  }

  // ---- text (§1.5) ----
  const SPACES = /[\t\n\f\r ]+/g;
  const BLANK = /^[\s\p{Cf}]*$/u;

  function cleanText(value) {
    // Strings only: a page value of another type never meets our RegExps.
    let text = (typeof value === "string" ? value : String(value ?? "")).replace(SPACES, " ");
    let start = 0;
    let end = text.length;
    if (text.charCodeAt(0) === 32) start = 1;
    if (end > start && text.charCodeAt(end - 1) === 32) end--;
    text = start || end < text.length ? text.slice(start, end) : text;
    return BLANK.test(text) ? "" : truncate(text);
  }

  // Ego cuts at 200 UTF-8 bytes; we cut at the last whole character before that.
  function truncate(text) {
    if (text.length <= TEXT_MAX_BYTES / 3) {
      return text;
    }
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length;
      const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
      if (bytes + size > TEXT_MAX_BYTES) {
        return `${text.slice(0, i)}...`;
      }
      bytes += size;
      if (pair) i++;
    }
    return text;
  }

  function textLine(text) {
    return `text ${quoted(text)}`;
  }

  // Ego prints text and names between quotes as they are, inner quotes and
  // backslashes included (`anchor "Direct link to "Examples""`); only
  // locators escape (`css:a[aria-label="Direct link to \"Examples\""]`).
  // Control characters go: they print as nothing, and page text can't forge
  // the \u0001d:k\u0002 ref placeholders the parent fills in (§4.6).
  const CONTROLS = /[\u0000-\u001f\u007f]/g;
  function quoted(text) {
    return `"${String(text).replace(CONTROLS, "")}"`;
  }

  // ---- names (§1.4) ----
  /**
   * Chromium's page-content label, which Ego prints as the name (AddLabel):
   * aria-label, then the text content (not the accessible name) of each
   * aria-labelledby target, joined by spaces. pypi's tabpanel, labelled by a
   * tab whose aria-label is a sentence, prints the tab's text "Description".
   */
  function printedName(el) {
    const parts = [];
    const label = getAttribute.call(el, "aria-label");
    if (label && label.trim()) {
      parts.push(label);
    }
    const ids = getAttribute.call(el, "aria-labelledby");
    if (ids) {
      const root = getRootNode.call(el);
      for (const id of ids.split(SPACES)) {
        if (!id) continue;
        let target = null;
        try {
          target = dom.node(root.getElementById(id));
        } catch {}
        const text = target ? textContentOf.call(target) : "";
        if (text && text.trim()) parts.push(text);
      }
    }
    return parts.length ? cleanText(parts.join(" ")) : "";
  }

  /** Ref'd controls that can stand alone with no text in them (an anchor with a url= has that). */
  const NAMED_BY_CONTENT = new Set(["button", "anchor", "link"]);

  /** Where Ego's tree has no wrapper as a lone child (see walkElement). */
  const HOIST_INTO = new Set(["a", "button", "p", "td", "th"]);

  /** An unnamed, ref-less container record (debug info aside). */
  function plainContainer(record) {
    return record.block === undefined && (record.line === "container" || record.line.startsWith("container\u0007"));
  }

  /** Whether printed records show any text or name. */
  function identified(records) {
    for (const record of records) {
      if (record.block !== undefined || record.line.includes('"')) return true;
      if (record.kids && identified(record.kids)) return true;
    }
    return false;
  }

  // ---- geometry (§3.2) ----
  // A box counts as on screen only if some of its area is (Ego drops empty boxes).
  function intersects(r, clip) {
    return Math.min(r.right, clip.r) > Math.max(r.left, clip.l) && Math.min(r.bottom, clip.b) > Math.max(r.top, clip.t);
  }

  function inside(r, clip) {
    return r.left >= clip.l && r.right <= clip.r && r.top >= clip.t && r.bottom <= clip.b;
  }

  /**
   * Whether content reaches past the box, so its overflow style matters. An
   * inline box has no client area (0×0 by definition) and overflow doesn't
   * apply to it, yet its scroll size is its text's: every span and link
   * looked overflowing and paid a style read (100k on a 50k-row page). A
   * collapsed block (0×0, overflow hidden) has no client area either but
   * does clip, and only its rect tells it apart. Full-page scope has no rect
   * and needs this only to find scroll containers, which a box with no
   * client area can't usefully be.
   */
  function overflows(el, rect) {
    const cw = clientWidth.call(el);
    const ch = clientHeight.call(el);
    if (cw === 0 && ch === 0) {
      return !!rect && (scrollWidth.call(el) > rect.width + 1 || scrollHeight.call(el) > rect.height + 1);
    }
    return scrollHeight.call(el) > ch + 1 || scrollWidth.call(el) > cw + 1;
  }

  function intersect(a, b) {
    return { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) };
  }

  const EMPTY_CLIP = { l: 0, t: 0, r: 0, b: 0 };

  /** The CSS clip or clip-path:inset(50%) of a box, in viewport coordinates, or null. */
  function cssClip(style, r) {
    const value = dom.str(style.clip);
    if (value && value !== "auto") {
      const m = /rect\(([^)]*)\)/.exec(value);
      if (m) {
        const [top, right, bottom, left] = m[1].split(/[\s,]+/).map(v => (v === "auto" ? null : parseFloat(v)));
        return {
          l: r.left + (left ?? 0),
          t: r.top + (top ?? 0),
          r: right === null ? r.right : r.left + right,
          b: bottom === null ? r.bottom : r.top + bottom,
        };
      }
    }
    return dom.str(style.clipPath) === "inset(50%)" ? EMPTY_CLIP : null;
  }

  function clipTo(clip, el, r) {
    const l = r.left + clientLeft.call(el);
    const t = r.top + clientTop.call(el);
    return {
      l: Math.max(clip.l, l),
      t: Math.max(clip.t, t),
      r: Math.min(clip.r, l + clientWidth.call(el)),
      b: Math.min(clip.b, t + clientHeight.call(el)),
    };
  }

  // ---- the registry's content half (§5.1): node ↔ local id, per document ----
  const ids = new WeakMap();
  const nodes = new Map();
  let nextLocalId = 1;
  let sinceSweep = 0;

  function localIdFor(node) {
    let id = ids.get(node);
    if (id === undefined) {
      id = nextLocalId++;
      ids.set(node, id);
      nodes.set(id, new WeakRef(node));
      if (++sinceSweep > 500) {
        sinceSweep = 0;
        for (const [key, ref] of nodes) {
          if (!ref.deref()) nodes.delete(key);
        }
      }
    }
    return id;
  }

  // `detached`: also a node the page took out of the document and may put
  // back, as Ego's refs reach (zen-input's actions, input-gaps.md 11). Only
  // while it's this document's node: one the page moved into another
  // document (a frame's, another window's, a windowless one) still counts as
  // connected there, and an action would act outside the ref's page.
  const ownDocument = document;
  function resolve(localId, detached = false) {
    const node = nodes.get(localId)?.deref();
    if (!node || ownerDocumentOf.call(node) !== ownDocument) {
      return null;
    }
    return detached || isConnected.call(node) ? node : null;
  }

  // ---- locators (§1.8, §6) ----
  // The index in locators.firstMatches relies on this exact quoting.
  const cssString = value => locators.cssString(value);

  /**
   * Ego's locator candidates for an element, in its order. Its browser
   * proposes the first that matches only that element (uniqueLocators), and
   * none whose label, name or URL is over 80 bytes of UTF-8: no golden
   * locator's is longer (513 aria-label and 7,444 href ones), the Guardian's
   * longer aria-labels get href: instead, and so do Stack Overflow's 31 links
   * all labelled "Timeline" (§1.8). A form field has one candidate, its first
   * attribute present: pypi's search box shares its name with another field
   * and gets no locator, though its placeholder is unique.
   */
  function locatorsFor(el, tag, role, name, c) {
    const out = [];
    const css = (attr, value) => {
      if (value && fits(value)) out.push({ kind: "css", value: `${tag}[${attr}=${cssString(value)}]` });
    };
    if (tag === "input" || tag === "select" || tag === "textarea") {
      for (const attr of ["name", "placeholder", "aria-label"]) {
        const value = getAttribute.call(el, attr);
        if (value) {
          css(attr, value);
          break;
        }
      }
      return out;
    }
    // Ego proposes aria-label selectors only for links and buttons, ahead of
    // a role locator (pypi's <a role="tab" aria-label>).
    if (tag === "a" || tag === "button") css("aria-label", getAttribute.call(el, "aria-label"));
    // Named as the locator engine matches it (locators.js elementRole).
    if (role && name && fits(name)) out.push({ kind: "role", value: role === "img" ? "image" : role, name });
    if (tag === "a" && c.url) {
      try {
        const url = new URL(c.url);
        const value = url.origin === c.topOrigin ? url.pathname + url.search + url.hash : url.href;
        if (fits(value)) out.push({ kind: "href", value });
      } catch {}
    }
    return out;
  }

  /** Whether a locator value is at most 80 bytes of UTF-8 (locatorsFor). */
  function fits(value) {
    if (value.length > 80) return false;
    if (value.length <= 26) return true;
    let bytes = 0;
    for (const ch of value) {
      const cp = ch.codePointAt(0);
      bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
    return bytes <= 80;
  }

  /**
   * The document and every open shadow root in it, walked or not: Ego's
   * resolver searches them all, hidden and offscreen content included.
   */
  function rootsOf(doc) {
    return [doc, ...chrome().openShadowRoots(doc)];
  }

  /**
   * Picks each ref's locator: the first candidate that matches exactly its
   * own node in this document, one batch per candidate rank. Returns, per
   * ref, the locator text and whether it does (the last candidate's, with
   * false, when none does); matches in other documents are counted by the
   * chrome side (§6).
   */
  function uniqueLocators(doc, c) {
    const unique = new Map();
    let pending = c.refs.filter(ref => ref.locs?.length);
    if (!pending.length) {
      return unique;
    }
    const roots = rootsOf(doc);
    const cache = {};
    for (let rank = 0; pending.length; rank++) {
      const found = locators.firstMatches(doc, roots, pending.map(ref => ref.locs[rank]), cache);
      const next = [];
      pending.forEach((ref, i) => {
        const self = found[i].length === 1 && found[i][0] === ref.node;
        if (self || rank === ref.locs.length - 1) {
          unique.set(ref, { text: locatorText(ref.locs[rank]), self });
        } else {
          next.push(ref);
        }
      });
      pending = next;
    }
    return unique;
  }

  function locatorText(loc) {
    return loc.kind === "role" ? `role:${loc.value}[name=${JSON.stringify(loc.name)}]` : `${loc.kind}:${loc.value}`;
  }

  /** Matches of each locator text in this document (open shadow roots included). */
  // Dev aid for fitting Chromium's container rule (tests/snapshot/golden-diff.mjs --debug).
  function debugInfo(c, el, tag) {
    const style = c.win.getComputedStyle(el);
    const parent = parentElementOf.call(el);
    const parentDisplay = parent ? c.win.getComputedStyle(parent).display : "-";
    let texts = 0;
    let elements = 0;
    for (let n = firstChild.call(el); n; n = nextSibling.call(n)) {
      const type = nodeType.call(n);
      if (type === ELEMENT_NODE) elements++;
      else if (type === TEXT_NODE && nodeValue.call(n).trim()) texts++;
    }
    return `${tag}|${style.display}|${style.position}|${style.float}|${parentDisplay}|e${elements}t${texts}|${shadowRootOf.call(el) ? "host" : ""}`;
  }

  // ---- the walk ----
  function makeContext(doc, options) {
    const win = defaultViewOf.call(doc);
    return {
      doc,
      win,
      viewport: options.scope === "viewport",
      docIndex: options.docIndex ?? 0,
      topLevel: options.topLevel,
      topOrigin: options.topOrigin,
      wantLocators: options.locators !== false,
      debug: !!options.debug,
      // Chromium's rule for plain wrappers (keepsWrapper); fit.apc: false
      // keeps every wrapper, as before (golden-diff --fit).
      apc: options.fit?.apc !== false,
      // fit.hoist: false turns off the hoist into links, buttons, paragraphs
      // and cells (walkElement).
      fit: options.fit ?? {},
      // Elements hit testing finds in the viewport, top document only: Ego's
      // frames keep no wrapper for that (zoo-frames). Null: hit testing failed.
      hit: new Set(),
      // A frame's visible part, in its own coordinates, comes from its parent.
      viewportClip: options.clip ?? { l: 0, t: 0, r: dom.num(win.innerWidth), b: dom.num(win.innerHeight) },
      range: null,
      refs: [],
      url: null,
      stats: { elements: 0, texts: 0, styleReads: 0, rects: 0, pruned: 0, pseudoQueries: 0 },
      marked: null,
      // Computed styles read so far, and each text's parent's text-transform.
      styles: new Map(),
      ttOf: new Map(),
    };
  }

  // ---- generated content and text-transform (§3.5) ----

  // CSS text-transform, as Chromium applies it to the text Ego prints.
  const NOT_SPACE = /\S/;
  let words = null;
  function transform(text, value) {
    if (!value || value === "none" || !text) {
      return text;
    }
    if (value.includes("uppercase")) text = text.toUpperCase();
    else if (value.includes("lowercase")) text = text.toLowerCase();
    else if (value.includes("capitalize")) text = capitalize(text);
    if (value.includes("full-width")) text = text.replace(/[ -~]/g, ch => (ch === " " ? "\u3000" : String.fromCharCode(ch.charCodeAt(0) + 0xfee0)));
    return text;
  }

  /**
   * The first letter of each word in upper case, the rest as it is.
   * Chromium title-cases the first character of each word-break segment,
   * with no-break spaces counting as spaces.
   */
  function capitalize(text) {
    words ??= new Intl.Segmenter("en", { granularity: "word" });
    let out = "";
    for (const { index, segment } of words.segment(text.replace(/\u00a0/g, " "))) {
      const first = String.fromCodePoint(text.codePointAt(index));
      out += first.toUpperCase() + text.slice(index + first.length, index + segment.length);
    }
    return out;
  }

  /**
   * A text node's data, transformed as its parent's text-transform says
   * (an inherited property: the parent's computed value is the text's).
   */
  function transformedText(c, node) {
    const text = nodeValue.call(node);
    const parent = parentElementOf.call(node);
    // A text of spaces alone prints the same whatever the transform
    // (full-width's ideographic spaces collapse like any), and most of a
    // page's text nodes are only spaces.
    if (!parent || !NOT_SPACE.test(text)) {
      return text;
    }
    let value = c.ttOf.get(parent);
    if (value === undefined) {
      value = dom.str(styleOf(c, parent).textTransform) ?? "none";
      c.ttOf.set(parent, value);
    }
    return transform(text, value);
  }

  /** Private-use characters only: an icon font's glyphs, which tell an agent nothing. */
  const GLYPHS = /^[\p{Co}\s]*$/u;
  const ROW_GROUPS = new Set(["table", "thead", "tbody", "tfoot"]);

  /**
   * The element's content with its ::before and ::after boxes around it,
   * as Chromium's walker meets them among the element's layout children.
   * Elements are asked one by one (mayGenerate): picking the few with boxes
   * from the document's style rules would cost a site's first snapshot a
   * scan of all its CSS (generated.sys.mjs).
   */
  function walkContent(c, el, tag, out, frame, depth) {
    const root = shadowRootFor(el, tag);
    const boxes = mayGenerate(el, tag, frame, root) ? generatedOf(c, el) : null;
    if (boxes?.[0]) pushGenerated(c, tag, boxes[0], out, frame);
    walkChildren(c, el, tag, out, frame, depth, root);
    if (boxes?.[1]) pushGenerated(c, tag, boxes[1], out, frame);
  }

  /**
   * Whether Gecko is asked for the element's boxes. Leaves print no text of
   * their own, generated or not. In a shadow root whose sheets give no
   * ::before or ::after text (frame.skip, walkChildren), only these can still
   * have some: a shadow host (its own root's :host rules), a <q> (the UA's
   * quotes) and a part (the outer tree's ::part() rules).
   */
  function mayGenerate(el, tag, frame, root) {
    if (LEAF.has(tag)) {
      return false;
    }
    return !frame.skip || root !== null || tag === "q" || hasAttribute.call(el, "part");
  }

  /** The shadow root, open or closed, the walker prints in an element's place, or null. */
  function shadowRootFor(el, tag) {
    let root = shadowRootOf.call(el);
    if (!root && (tag.includes("-") || !firstChild.call(el))) {
      root = chrome().closedShadowRoot(el);
    }
    return root ?? null;
  }

  /** [before, after] (generated.sys.mjs generatedBoxes), or null. */
  function generatedOf(c, el) {
    c.stats.pseudoQueries++;
    const json = chrome().generated(el, c.viewport);
    if (typeof json !== "string") {
      return null;
    }
    try {
      const boxes = JSON.parse(json);
      return Array.isArray(boxes) ? boxes : null;
    } catch {
      return null;
    }
  }

  function pushGenerated(c, tag, box, out, frame) {
    const text = cleanText(transform(String(box[0] ?? ""), String(box[2] ?? "")));
    // A clearfix's empty table, an icon font's glyph: Ego prints both, but
    // neither tells an agent anything (docs/PARITY.md).
    if (!text || GLYPHS.test(text)) {
      return;
    }
    const r = box[3];
    if (c.viewport && !frame.inside && Array.isArray(r) && !intersects({ left: r[0], top: r[1], right: r[2], bottom: r[3] }, frame.clip)) {
      return;
    }
    let record = { line: textLine(text), kids: null };
    // A table part needs the table boxes around it that its parent isn't:
    // Chromium makes them anonymous, and Ego prints them (Wikipedia's rank
    // column is a tr::before laid out as a table cell).
    const display = String(box[1] ?? "");
    const cell = () => (record = { line: "table_cell", kids: [record] });
    const row = () => (record = { line: "table_row", kids: [record] });
    const table = () => (record = { line: "table", kids: [record] });
    if (display === "table-cell") {
      cell();
      if (tag !== "tr") {
        row();
        if (!ROW_GROUPS.has(tag)) table();
      }
    } else if (display === "table-row") {
      cell();
      row();
      if (!ROW_GROUPS.has(tag)) table();
    } else if (display === "table" || display === "inline-table") {
      cell();
      row();
      table();
    }
    out.push(record);
  }

  // A page's computed style: read its values through dom.str, as strings.
  // The declaration is live, so one per element serves the whole walk.
  function styleOf(c, el) {
    let style = c.styles.get(el);
    if (style === undefined) {
      c.stats.styleReads++;
      style = c.win.getComputedStyle(el);
      c.styles.set(el, style);
    }
    return style;
  }

  function pushText(out, text) {
    const clean = cleanText(text);
    if (clean) {
      out.push({ line: textLine(clean), kids: null });
    }
  }

  function textVisible(c, node, frame) {
    if (!c.viewport || frame.inside) {
      return true;
    }
    if (frame.rect && !intersects(frame.rect, frame.clip)) {
      return false;
    }
    c.range ??= createRange.call(c.doc);
    rangeSelectNodeContents.call(c.range, node);
    c.stats.rects++;
    return intersects(rangeRect.call(c.range), frame.clip);
  }

  /** A slot's assigned nodes (or its own), else the shadow root's (walkContent's `root`) or the element's. */
  function walkChildren(c, parent, tag, out, frame, depth, root = null) {
    let start;
    if (tag === "slot") {
      const assigned = dom.nodes(parent.assignedNodes());
      if (assigned.length) {
        // They belong to the host's tree, and this root's ::slotted() rules
        // can give them boxes: all of them get asked.
        const slotted = frame.skip ? { ...frame, skip: false } : frame;
        for (const node of assigned) walkNode(c, node, out, slotted, depth);
        return;
      }
      start = firstChild.call(parent);
    } else if (root) {
      // A shadow root's own sheets are the only author rules its elements
      // match (the document's stop at it): if they give no ::before or
      // ::after text, its elements needn't be asked (mayGenerate).
      const skip = !chrome().rootGenerates(root);
      if (skip !== !!frame.skip) frame = { ...frame, skip };
      start = firstChild.call(root);
    } else {
      start = firstChild.call(parent);
    }
    for (let node = start; node; node = nextSibling.call(node)) {
      walkNode(c, node, out, frame, depth);
    }
  }

  function walkNode(c, node, out, frame, depth) {
    const type = nodeType.call(node);
    if (type === TEXT_NODE) {
      c.stats.texts++;
      if (frame.visible && textVisible(c, node, frame)) {
        pushText(out, transformedText(c, node));
      }
    } else if (type === ELEMENT_NODE) {
      walkElement(c, node, out, frame, depth + 1);
    }
  }

  function walkElement(c, el, out, frame, depth) {
    if (depth > MAX_DEPTH) {
      return;
    }
    c.stats.elements++;
    const tag = localNameOf.call(el);
    const ns = namespaceOf.call(el);
    const native = nativeRole(el, tag, ns, c);
    if (native === SKIP) {
      return;
    }
    if (tag === "slot" && ns === HTML_NS) {
      // display: contents, so no box: its content keeps the parent's
      // geometry. A hidden slot hides what's assigned to it.
      if (styleOf(c, el).display !== "none") {
        walkChildren(c, el, tag, out, frame, depth);
      }
      return;
    }

    // Visibility: only display:none and visibility:hidden hide (§1.6).
    let visible = true;
    let transparent = native === TRANSPARENT;
    let boxless = false;
    if (!checkVisibility.call(el, VISIBILITY)) {
      const style = styleOf(c, el);
      const display = dom.str(style.display);
      if (display === "none") {
        return;
      }
      if (display === "contents") {
        transparent = boxless = true;
      } else if (dom.str(style.visibility) !== "visible") {
        visible = false;
      } else if (c.viewport || !matches.call(el, ACTIVATABLE)) {
        // Inside content-visibility: hidden. Chromium lays out what
        // find-in-page can reveal (a closed <details>, hidden=until-found)
        // and walks it, but its box has no visible area, so only full_page
        // shows it (MDN's Baseline details); an author's content-visibility:
        // hidden subtree it never walks.
        return;
      }
    }
    if (boxless) {
      walkContent(c, el, tag, out, frame, depth);
      return;
    }

    // Geometry, only for the viewport scope.
    let rect = null;
    let clip = frame.clip;
    let inView = true;
    if (c.viewport) {
      rect = getRect.call(el);
      c.stats.rects++;
      inView = intersects(rect, clip);
      if (!inView && clip !== c.viewportClip && intersects(rect, c.viewportClip)) {
        // Outside its ancestors' clip but on screen: fixed elements escape clips.
        if (styleOf(c, el).position === "fixed") {
          clip = c.viewportClip;
          inView = true;
        }
      }
    }

    // An offscreen box with nothing on screen inside it, per hit testing,
    // can't paint into the viewport: skip its subtree (§3.2). Zero-size boxes
    // stay walked, since portals and float wrappers hold content outside
    // themselves by design.
    if (!inView && c.marked && !c.marked.has(el) && rect.width > 0 && rect.height > 0) {
      c.stats.pruned++;
      return;
    }

    // Scroll containers clip their content and get refs (§1.7, §3.2). Only
    // a box whose content overflows can clip anything, so only those pay for
    // a style read. Visually hidden text (sr-only: 1px, overflow hidden, CSS
    // clip) is clipped away entirely, as in Chromium's visual rects.
    let scroller = false;
    let childClip = clip;
    let overflowing = false;
    if (!transparent && tag !== "html" && tag !== "body" && !LEAF.has(tag) && overflows(el, rect)) {
      overflowing = true;
      const style = styleOf(c, el);
      const x = dom.str(style.overflowX);
      const y = dom.str(style.overflowY);
      scroller = x === "auto" || x === "scroll" || y === "auto" || y === "scroll";
      if (c.viewport) {
        if (scroller || x !== "visible" || y !== "visible") {
          childClip = clipTo(clip, el, rect);
        }
        const own = cssClip(style, rect);
        if (own) {
          childClip = intersect(childClip, own);
          if (!intersects(rect, intersect(clip, own))) inView = false;
        }
      }
    }

    let role = explicitRole(el);
    const ref = !transparent && visible && (wantsRef(el, tag, role) || scroller);
    // Chromium types elements by tag whatever their role, and Ego prints a
    // role only when it's a real one: <li role="presentation"> stays a
    // list_item (pypi's tabs), and a plain <div role="none"> is a wrapper.
    if (role === "none" || role === "presentation") {
      role = null;
    }

    const kids = [];
    const leaf = LEAF.has(tag) || native === "svg_root" || native === "image";
    if (leaf) {
      if (visible && inView) {
        if (native === "iframe") {
          frameKids(c, el, rect, clip, kids);
        } else {
          controlKids(c, el, tag, kids);
        }
      }
    } else {
      const nextFrame = {
        clip: childClip,
        rect,
        // Overflowing content can reach past the box, so its text gets checked one by one.
        inside: c.viewport ? !!rect && !overflowing && inside(rect, childClip) : true,
        visible,
        skip: frame.skip,
      };
      walkContent(c, el, tag, kids, nextFrame, depth);
    }

    if (transparent || !visible) {
      for (const kid of kids) out.push(kid);
      return;
    }
    if (c.viewport && !inView && !kids.length) {
      return;
    }

    const printed = role ? ARIA_PRINTED[role] ?? role.replace(/-/g, "") : native;
    let name = printedName(el);
    // Ego's name is aria-label (and -labelledby) only. An icon button would
    // then print with nothing to tell it by: pdf.js labels its toolbar with
    // visually hidden text, which only full_page shows, and a title. Its
    // accessible name (that text, else the title) stands in (§1.4).
    if (!name && ref && NAMED_BY_CONTENT.has(printed) && !identified(kids) && !(tag === "a" && hasAttribute.call(el, "href"))) {
      name = truncate(aria.getElementAccessibleNameText(el, false));
    }
    if (!kids.length && !name && !ref && !leaf && printed !== "container" && (!c.apc || native === "container")) {
      // An empty element without a box (an empty inline span) makes no node.
      // Chromium prints a typed one whatever its size (Stack Overflow's empty
      // table_cell), and keepsWrapper rules on the rest.
      const r = rect ?? getRect.call(el);
      if (!r.width && !r.height) {
        return;
      }
    }
    if (printed === "container" && !name && !ref) {
      if (kids.length === 1) {
        out.push(kids[0]);
      } else if (kids.length > 1) {
        const why = keepsWrapper(c, el, tag, role, overflowing);
        if (!why) {
          for (const kid of kids) out.push(kid);
        } else {
          out.push({ line: c.debug ? `container\u0007${debugInfo(c, el, tag)}|${why}` : "container", kids });
        }
      }
      return;
    }
    if (native === "container" && !ref && !keepsWrapper(c, el, tag, role, overflowing)) {
      for (const kid of kids) out.push(kid);
      return;
    }

    // Ego's compaction, the other way round: a link, button, paragraph or
    // table cell whose only child is an unnamed, ref-less container takes
    // that container's children (httpbin's <p><label>, arxiv's <td><span>,
    // Stack Overflow's <a><div>, GitHub's <button><span>). Structural
    // parents keep theirs (python-docs' main > section, MDN's li > details),
    // and so do ref'd containers, which GitHub hoists and MDN doesn't.
    if (kids.length === 1 && plainContainer(kids[0]) && c.fit.hoist !== false && ns === HTML_NS && HOIST_INTO.has(tag)) {
      kids.splice(0, 1, ...kids[0].kids);
    }
    let line = name ? `${printed} ${quoted(name)}` : printed;
    let url = null;
    if (tag === "a" && ns === HTML_NS && hasAttribute.call(el, "href")) {
      try {
        url = new URL(getAttribute.call(el, "href"), baseURI.call(el)).href;
      } catch {}
    }
    if (ref) {
      c.url = url;
      const entry = {
        node: el,
        localId: localIdFor(el),
        role: printed,
        name,
        locs: c.wantLocators ? locatorsFor(el, tag, role, name, c) : null,
        url,
      };
      c.refs.push(entry);
      line += ` [\u0001${c.docIndex}:${c.refs.length - 1}\u0002]`;
    } else if (url) {
      line += ` [url=${url}]`;
    }
    out.push({ line, kids: kids.length ? kids : null });
  }

  // A frame's document: walked here when it's in this process, otherwise a
  // placeholder the parent fills in (§4.4). In the viewport scope the frame
  // gets the visible part of its content box, in its own coordinates.
  function frameKids(c, el, rect, clip, out) {
    let frameClip = null;
    if (c.viewport) {
      const box = clipTo(clip, el, rect);
      if (box.r <= box.l || box.b <= box.t) {
        return;
      }
      const left = rect.left + clientLeft.call(el);
      const top = rect.top + clientTop.call(el);
      frameClip = { l: box.l - left, t: box.t - top, r: box.r - left, b: box.b - top };
    }
    const block = chrome().frame(el, JSON.stringify({ clip: frameClip }));
    if (block) {
      out.push({ block });
    }
  }

  // Chromium prints the fields of its date and time editor as spinbutton
  // refs, each over its text, with the separators as text (zoo-forms:
  // `spinbutton "Year" [ref]` > `text "2000"`, then `text "/"`), and a
  // media element's control bar as button and spinbutton refs with the
  // times as text. Gecko's UA widgets have the same controls (§1.2); the
  // chrome side lists them (index.sys.mjs). Ego gives them no locator.
  function widgetKids(c, items, out) {
    for (const item of items) {
      if (!item.field) {
        pushText(out, item.text);
        continue;
      }
      const name = cleanText(item.label);
      // The chrome side keeps the control's node; item.field is its local id.
      c.refs.push({ node: null, localId: item.field, role: item.role, name, locs: null, url: null });
      const kids = [];
      pushText(kids, item.text ?? "");
      out.push({
        line: `${name ? `${item.role} ${quoted(name)}` : item.role} [\u0001${c.docIndex}:${c.refs.length - 1}\u0002]`,
        kids: kids.length ? kids : null,
      });
    }
  }

  function dateTimeFields(c, el, out) {
    const items = chrome().dateTimeFields(el);
    if (items) {
      widgetKids(c, items, out);
    }
    return !!items;
  }

  // Form controls print what Chromium shows inside them (§1.2).
  function controlKids(c, el, tag, out) {
    if (tag === "video" || tag === "audio") {
      if (hasAttribute.call(el, "controls")) {
        const items = chrome().mediaControls(el);
        if (items) {
          widgetKids(c, items, out);
        }
      }
      return;
    }
    if (tag === "input") {
      const type = inputType(el);
      switch (type) {
        case "checkbox": case "radio": case "image": case "color": case "range": case "hidden":
          return;
        case "button": case "submit": case "reset": {
          const value = getAttribute.call(el, "value");
          pushText(out, value ?? (type === "submit" ? "Submit" : type === "reset" ? "Reset" : ""));
          return;
        }
        case "file": {
          const files = el.files;
          const names = [];
          for (let i = 0, n = Math.min(dom.num(files?.length) || 0, 1000); i < n; i++) names.push(dom.str(files[i]?.name) ?? "");
          out.push({ line: "button", kids: [{ line: textLine("Browse…"), kids: null }] });
          pushText(out, names.length ? names.join(", ") :
            hasAttribute.call(el, "multiple") ? "No files selected." : "No file selected.");
          return;
        }
        default: {
          if ((type === "date" || type === "time" || type === "datetime-local") && dateTimeFields(c, el, out)) {
            return;
          }
          const value = dom.str(el.value);
          if (value) {
            // A password (or a field that was one, or is masked) prints
            // nothing, not even bullets: Chromium skips a secret field's
            // subtree once it holds anything (aria.js isSecretField).
            if (!aria.isSecretField(el)) pushText(out, value);
          } else {
            pushText(out, getAttribute.call(el, "placeholder") || "");
          }
        }
      }
    } else if (tag === "textarea") {
      const text = dom.str(el.value);
      if (text && aria.isSecretField(el)) return;
      const value = text || getAttribute.call(el, "placeholder") || "";
      for (const line of value.split("\n")) pushText(out, line);
    } else if (tag === "select") {
      if (!isListBox(el)) {
        const option = dom.nodes(el.selectedOptions)?.[0];
        if (option) pushText(out, dom.str(option.label));
        return;
      }
      for (const child of dom.nodes(childrenOf.call(el))) {
        const childTag = localNameOf.call(child);
        if (childTag === "option") {
          pushText(out, dom.str(child.label));
        } else if (childTag === "optgroup") {
          const label = cleanText(getAttribute.call(child, "label") || "");
          const group = label ? [{ line: `container ${quoted(label)}`, kids: [{ line: textLine(label), kids: null }] }] : [];
          for (const option of dom.nodes(childrenOf.call(child))) {
            if (localNameOf.call(option) === "option") pushText(group, dom.str(option.label));
          }
          if (group.length === 1) out.push(group[0]);
          else if (group.length) out.push({ line: "container", kids: group });
        }
      }
    }
  }

  function serialize(records, depth, lines) {
    const pad = "  ".repeat(depth);
    for (const record of records) {
      if (record.block !== undefined) {
        // A frame's own lines, serialized from its root at depth 0.
        for (const line of record.block.split("\n")) lines.push(pad + line);
        continue;
      }
      lines.push(pad + record.line);
      if (record.kids) serialize(record.kids, depth + 1, lines);
    }
  }

  /**
   * Snapshots one document.
   *
   * @param {Document} doc
   * @param {string} optionsJSON {scope: "viewport"|"full_page"|"subtree",
   *   topLevel, topOrigin, locators, rootLocalId?}
   * @param {object} chromeHelpers what the chrome side lends this capture
   *   (index.sys.mjs walkerFor); a page calling this itself has none
   * @returns {{text: string, meta: string}} text with ref placeholders
   *   (\u0001k\u0002 for meta.refs[k]); meta is JSON
   */
  function capture(doc, optionsJSON, chromeHelpers) {
    if (chromeHelpers === null || typeof chromeHelpers !== "object") {
      throw new TypeError("zenius walker: capture takes the chrome helpers");
    }
    const previous = helpers;
    helpers = chromeHelpers;
    try {
      return snapshotDocument(doc, optionsJSON);
    } finally {
      helpers = previous;
    }
  }

  function snapshotDocument(doc, optionsJSON) {
    const options = JSON.parse(optionsJSON);
    const t0 = performance.now();
    const c = makeContext(doc, options);
    const wantMarks = c.viewport && options.prune !== false;
    const wantHit = c.apc && (c.topLevel || options.fit?.hitFrames === true);
    if (wantMarks || wantHit) {
      const clip = c.viewportClip;
      const found =
        clip.r > clip.l && clip.b > clip.t ? chrome().onScreen(doc, JSON.stringify(clip), wantMarks) : { hit: [], marked: [] };
      if (wantMarks) c.marked = found ? new Set(found.marked) : null;
      if (wantHit) c.hit = found ? new Set(found.hit) : null;
    }
    const records = [];
    const frame = { clip: c.viewportClip, rect: null, inside: false, visible: true };
    if (options.rootLocalId) {
      const root = resolve(options.rootLocalId);
      if (!root) {
        return { text: "", meta: JSON.stringify({ stale: true }) };
      }
      walkElement(c, root, records, frame, 0);
    } else {
      const html = documentElementOf.call(doc);
      if (html) walkElement(c, html, records, frame, 0);
    }
    const walkMs = performance.now() - t0;

    const t1 = performance.now();
    const unique = c.wantLocators ? uniqueLocators(doc, c) : new Map();
    const locMs = performance.now() - t1;
    const refs = c.refs.map(ref => {
      const loc = unique.get(ref);
      return [ref.localId, ref.role, ref.name, loc?.text ?? null, ref.url, !!loc?.self];
    });
    // Ref metadata: placeholders become "ref=N, loc=…, url=…" in the parent,
    // which knows the numbers.
    const lines = options.rootLocalId ? [] : ["root"];
    serialize(records, options.rootLocalId ? 0 : 1, lines);
    const html = documentElementOf.call(doc);
    const meta = {
      refs,
      metrics: {
        viewportHeight: dom.num(c.win.innerHeight),
        scrollY: dom.num(c.win.scrollY),
        pageHeight: html ? scrollHeight.call(html) : 0,
      },
      stats: { ...c.stats, refs: refs.length, lines: lines.length, walkMs, locMs, totalMs: performance.now() - t0 },
    };
    return { text: lines.join("\n"), meta: JSON.stringify(meta) };
  }

  Object.defineProperty(globalThis, "__zsWalker", {
    value: Object.freeze({ capture, resolve }),
  });
})();
