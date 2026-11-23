// Locator queries for zenius, run inside a document's sandbox
// (content/snapshot/sandbox.sys.mjs) after aria.js. Mirrors Ego's resolver
// (refs/ego-lite package/ego-browser/src/element-resolver.ts) so a locator a
// snapshot prints matches exactly its node:
//   css:   querySelectorAll over the document, then each open shadow root
//   href:  a[href] whose resolved path+search+hash, or full href, equals it
//   role:  elements not hidden from the accessibility tree with that role,
//          and the name exact (name=) or a case-insensitive substring after
//          collapsing whitespace (name*=)
// Portions adapted from citrolabs/ego-lite (MIT License).
"use strict";
(function () {
  const aria = globalThis.__zsAria;
  // Page reads go through dom.js: the sandbox's own Element and Document
  // members, and page values only as strings or real nodes, so page script
  // never gets an object of ours.
  const dom = globalThis.__zsDom;
  const querySelectorAll = dom.method("querySelectorAll", ["Element", "Document"], "nodes");
  const shadowRootOf = dom.find(Element.prototype, "shadowRoot").get;
  const localNameOf = dom.find(Element.prototype, "localName").get;
  const getAttributeOf = dom.find(Element.prototype, "getAttribute").value;
  const hrefOf = el => dom.str(el.href);
  const baseOf = doc => dom.str(doc.location.href);

  // Ego's __egoQueryAllOpenShadow: the document's matches first, then each
  // open shadow root's, depth first in document order.
  function queryAllOpenShadow(doc, selector) {
    const matches = [];
    const roots = [doc];
    while (roots.length) {
      const root = roots.pop();
      matches.push(...querySelectorAll(root, selector));
      const elements = querySelectorAll(root, "*");
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        const shadowRoot = shadowRootOf.call(elements[index]);
        if (shadowRoot) {
          roots.push(shadowRoot);
        }
      }
    }
    return matches;
  }

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Ego compares the roles Chromium's accessibility tree gives, lower-cased,
  // with two internal names mapped, and maps a query the same way
  // (element-resolver.ts normalizeRole).
  function normalizeRole(value) {
    const role = String(value || "").toLowerCase();
    return { listboxoption: "option", textfield: "textbox" }[role] || role;
  }

  // An element's ARIA role as Chromium's tree names it: ARIA's img is its
  // image. Only elements get this, so role:img matches nothing, as in Ego.
  function elementRole(el) {
    const role = normalizeRole(aria.getAriaRole(el));
    return role === "img" ? "image" : role;
  }

  function nameMatches(actual, expected, mode) {
    if (mode === "exact") {
      return actual === expected;
    }
    return normalizeText(actual).toLowerCase().includes(normalizeText(expected).toLowerCase());
  }

  function hrefMatches(doc, href) {
    return el => {
      try {
        const url = new URL(hrefOf(el), baseOf(doc));
        return url.pathname + url.search + url.hash === href || url.href === href;
      } catch {
        return false;
      }
    };
  }

  // Chromium leaves these out of the accessibility tree, so Ego never matches them.
  const IGNORED_ROLES = new Set(["none", "presentation"]);

  // Tags that can carry each role implicitly (aria.js kImplicitRoleByTagName),
  // so a role query computes roles only for candidates a native selector
  // found: those tags plus anything with a role attribute.
  const IMPLICIT_TAGS = {
    article: "article", banner: "header", blockquote: "blockquote", button: "button,input",
    caption: "caption", cell: "td,th", checkbox: "input", code: "code", columnheader: "th,td",
    combobox: "select,input", complementary: "aside", contentinfo: "footer", definition: "dd",
    deletion: "del", dialog: "dialog", document: "html", emphasis: "em", figure: "figure",
    form: "form", gridcell: "td,th", group: "details,fieldset,optgroup",
    heading: "h1,h2,h3,h4,h5,h6", image: "img,svg", insertion: "ins", link: "a,area",
    list: "menu,ol,ul", listbox: "datalist,select", listitem: "li", main: "main", mark: "mark",
    math: "math", meter: "meter", navigation: "nav", option: "option", paragraph: "p",
    progressbar: "progress", radio: "input", region: "section", row: "tr",
    rowgroup: "tbody,tfoot,thead", rowheader: "th,td", search: "search", searchbox: "input",
    separator: "hr", slider: "input", spinbutton: "input", status: "output", strong: "strong",
    subscript: "sub", superscript: "sup", table: "table", term: "dfn,dt", textbox: "textarea,input",
    time: "time",
  };

  function queryRole(doc, role, name, mode) {
    const wanted = normalizeRole(role);
    if (IGNORED_ROLES.has(wanted)) {
      return [];
    }
    aria.beginAriaCaches();
    try {
      const tags = IMPLICIT_TAGS[wanted];
      return queryAllOpenShadow(doc, tags ? `[role],${tags}` : "[role]").filter(
        el =>
          elementRole(el) === wanted &&
          !aria.isElementHiddenForAria(el) &&
          nameMatches(aria.getElementAccessibleNameText(el, false), name, mode)
      );
    } finally {
      aria.endAriaCaches();
    }
  }

  /** A CSS string for an attribute value, as the walker's css: locators quote it. */
  function cssString(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ").replace(/\r/g, "\\d ")}"`;
  }

  // The css: locators the walker proposes: tag[attr="value"] with only
  // cssString's escapes, so an index keyed by cssString matches exactly what
  // querySelectorAll would. Anything else (a form feed, say, which no CSS
  // string can hold) takes the real query.
  const SIMPLE_CSS = /^(input|select|textarea|a|button)\[(name|placeholder|aria-label)=("(?:[^"\\\f\0]|\\[\\"]|\\[ad] )*")\]$/;

  /** A printed locator text back to {kind, value, name?}, or null. */
  function parse(text) {
    if (text.startsWith("css:")) return { kind: "css", value: text.slice(4) };
    if (text.startsWith("href:")) return { kind: "href", value: text.slice(5) };
    const m = /^role:([A-Za-z0-9_-]+)\[name=(.*)\]$/.exec(text);
    if (m) {
      try {
        return { kind: "role", value: m[1], name: JSON.parse(m[2]) };
      } catch {}
    }
    return null;
  }

  /**
   * The first two elements each locator matches exactly, as query() would
   * find them in `roots` (a document and all its open shadow roots): enough
   * to tell none, one and many. Role locators share one pass over the
   * candidates, so a page's worth of them costs one name computation per
   * element of a wanted role, not one sweep each.
   *
   * @param {Document} doc
   * @param {Array<Document|ShadowRoot>} roots
   * @param {Array<{kind: string, value: string, name?: string}|null>} items
   * @param {{anchors?: Map<string, Element[]>}} [cache] shared across calls on one document
   * @returns {Array<Element[]>}
   */
  function firstMatches(doc, roots, items, cache = {}) {
    const found = items.map(() => []);
    const add = (i, el) => {
      if (found[i].length < 2) found[i].push(el);
    };
    const roles = new Map();
    const simple = new Map();
    const attrsByTag = new Map();
    items.forEach((item, i) => {
      if (item?.kind === "css") {
        // Lone surrogates may not survive the CSS parser: real query for those.
        const m = item.value.isWellFormed() ? SIMPLE_CSS.exec(item.value) : null;
        if (m) {
          let attrs = attrsByTag.get(m[1]);
          if (!attrs) attrsByTag.set(m[1], (attrs = new Set()));
          attrs.add(m[2]);
          let list = simple.get(item.value);
          if (!list) simple.set(item.value, (list = []));
          list.push(i);
          return;
        }
        try {
          for (const root of roots) {
            for (const el of querySelectorAll(root, item.value)) {
              add(i, el);
              if (found[i].length > 1) return;
            }
          }
        } catch {}
      } else if (item?.kind === "href") {
        // Callers that check several batches pass a cache for the index.
        cache.anchors ??= anchorIndex(doc, roots);
        for (const el of cache.anchors.get(item.value) ?? []) add(i, el);
      } else if (item?.kind === "role") {
        const wanted = normalizeRole(item.value);
        if (IGNORED_ROLES.has(wanted)) return;
        let byName = roles.get(wanted);
        if (!byName) roles.set(wanted, (byName = new Map()));
        let list = byName.get(item.name);
        if (!list) byName.set(item.name, (list = []));
        list.push(i);
      }
    });
    if (simple.size) {
      // One pass for all of them: each querySelectorAll scans the whole
      // document, 0.25 ms apiece on Wikipedia.
      const selectors = [];
      for (const [tag, attrs] of attrsByTag) {
        for (const attr of attrs) selectors.push(`${tag}[${attr}]`);
      }
      const selector = selectors.join(",");
      for (const root of roots) {
        for (const el of querySelectorAll(root, selector)) {
          const tag = localNameOf.call(el);
          for (const attr of attrsByTag.get(tag) ?? []) {
            const value = getAttributeOf.call(el, attr);
            if (value === null) continue;
            const list = simple.get(`${tag}[${attr}=${cssString(value)}]`);
            if (list) for (const i of list) add(i, el);
          }
        }
      }
    }
    if (roles.size) {
      const selectors = new Set(["[role]"]);
      for (const role of roles.keys()) {
        for (const tag of (IMPLICIT_TAGS[role] ?? "").split(",")) {
          if (tag) selectors.add(tag);
        }
      }
      const selector = [...selectors].join(",");
      aria.beginAriaCaches();
      try {
        for (const root of roots) {
          for (const el of querySelectorAll(root, selector)) {
            const byName = roles.get(elementRole(el));
            if (!byName || aria.isElementHiddenForAria(el)) continue;
            const list = byName.get(aria.getElementAccessibleNameText(el, false));
            if (list) for (const i of list) add(i, el);
          }
        }
      } finally {
        aria.endAriaCaches();
      }
    }
    return found;
  }

  /** How many elements (0, 1, or 2 for many) each printed locator text matches: a JSON array. */
  function countTexts(doc, roots, textsJSON) {
    const items = JSON.parse(textsJSON).map(parse);
    return JSON.stringify(firstMatches(doc, roots, items).map(found => found.length));
  }

  /** Anchors by both forms Ego's href matching accepts: path+query+hash and the full URL. */
  function anchorIndex(doc, roots) {
    const anchors = new Map();
    const index = (key, a) => {
      let list = anchors.get(key);
      if (!list) anchors.set(key, (list = []));
      if (list.length < 2) list.push(a);
    };
    for (const root of roots) {
      for (const a of querySelectorAll(root, "a[href]")) {
        // a.href is already parsed and serialized: for http(s) the path form
        // starts at the first "/" after the authority, no URL object needed.
        const href = hrefOf(a);
        let path = null;
        if (href.startsWith("https://") || href.startsWith("http://")) {
          const slash = href.indexOf("/", href.indexOf("//") + 2);
          if (slash > 0) path = href.slice(slash);
        }
        if (path === null) {
          try {
            const url = new URL(href, baseOf(doc));
            path = url.pathname + url.search + url.hash;
            if (url.href !== href) index(url.href, a);
          } catch {
            continue;
          }
        }
        index(href, a);
        if (path !== href) index(path, a);
      }
    }
    return anchors;
  }

  function query(doc, kind, value, name, mode) {
    switch (kind) {
      case "css":
        return queryAllOpenShadow(doc, value);
      case "href":
        return queryAllOpenShadow(doc, "a[href]").filter(hrefMatches(doc, value));
      case "role":
        return queryRole(doc, value, name, mode);
    }
    throw new TypeError(`Unknown locator kind: ${kind}`);
  }

  Object.defineProperty(globalThis, "__zsLocators", {
    value: Object.freeze({
      query,
      queryAllOpenShadow,
      parse,
      firstMatches,
      countTexts,
      cssString,
      role: el => aria.getAriaRole(el),
      name: el => aria.getElementAccessibleNameText(el, false),
      hiddenForAria: el => aria.isElementHiddenForAria(el),
    }),
  });
})();
