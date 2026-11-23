// zen-snapshot's realm-safe DOM access, run first in each document's sandbox
// (content/snapshot/sandbox.sys.mjs). aria.js, locators.js and walker.js
// read the page through it.
//
// The sandbox shares the page's principal and compartment, so page script
// can use any object of ours it gets hold of: from a RegExp, a function or an
// array, x.constructor.constructor("return this")() is the sandbox's global.
// And a page can replace any
// method or getter on its own prototypes, so calling one runs page code. The
// rules for these scripts:
//   - Node, Element, Document and Range members: the sandbox's own copies
//     (primordials), so a page's replacements never run;
//   - every other DOM member (an input's value, a computed style's display,
//     a DOMRect's width): the page's, with its result reduced to a primitive,
//     a real node or an array of ours before anything else touches it;
//   - a page function gets only primitives and the page's own nodes, never
//     an object, array, function or RegExp of ours.
// getter() and method() below build accessors that follow these rules; the
// Playwright port (tests/snapshot/tools/port-playwright.mjs) routes every
// DOM access of aria.js through them.
"use strict";
(function () {
  const ELEMENT_NODE = 1;
  const DOCUMENT_NODE = 9;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  // A copy of a page collection stops here; a page can report any length.
  const MAX_NODES = 100000;

  /** The property's descriptor on proto or up its chain (all the sandbox's own). */
  function find(proto, name) {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const desc = Object.getOwnPropertyDescriptor(p, name);
      if (desc) return desc;
    }
    throw new TypeError(`zenius dom.js: no ${name}`);
  }

  const PROTOS = { Node: Node.prototype, Element: Element.prototype, Document: Document.prototype, Range: Range.prototype };
  const nodeTypeOf = find(Node.prototype, "nodeType").get;
  const namespaceOf = find(Element.prototype, "namespaceURI").get;
  const localNameOf = find(Element.prototype, "localName").get;

  /** The node's type, or 0 for anything that isn't a real node. Runs no page code. */
  function nodeType(value) {
    if (value === null || typeof value !== "object") return 0;
    try {
      return nodeTypeOf.call(value);
    } catch {
      return 0;
    }
  }

  // What a page member returned, made safe to use. null and undefined pass
  // through, so Playwright's `x || []` and `!x` read as they did.
  const str = v => (typeof v === "string" || v === null || v === undefined ? v : String(v));
  const num = v => (typeof v === "number" || v === null || v === undefined ? v : Number(v));
  const bool = v => (typeof v === "boolean" || v === null || v === undefined ? v : !!v);
  const node = v => (v === undefined || nodeType(v) ? v : null);
  /** A page collection (NodeList, HTMLCollection, array) as an array of ours holding only its real nodes. */
  function nodes(v) {
    if (v === null || v === undefined) return v;
    const out = [];
    const n = Math.min(Number(v.length) || 0, MAX_NODES);
    for (let i = 0; i < n; i++) {
      const item = v[i];
      if (nodeType(item)) out.push(item);
    }
    return out;
  }
  const SANITIZE = { str, num, bool, node, nodes, raw: v => v };

  /**
   * The primordials of a member on each owner kind it has in the sandbox.
   * Owners: "Node" (any node), "Element", "Document" (by node type), "Range".
   */
  function owned(name, owners, part) {
    const pick = owner => (owners.includes(owner) ? find(PROTOS[owner], name)[part] : null);
    return { node: pick("Node"), element: pick("Element"), document: pick("Document"), range: pick("Range") };
  }

  /**
   * An accessor for a DOM getter: the sandbox's own copy when the receiver
   * is a node of an owner's kind (or a Range), else the page's member, its
   * result sanitized by kind ("str", "num", "bool", "node", "nodes" or "raw"
   * for a DOM object whose own members go through accessors too). Natives
   * return what they declare, so only collections get copied.
   */
  function getter(name, owners, kind) {
    const sanitize = SANITIZE[kind];
    if (!sanitize) throw new TypeError(`zenius dom.js: kind ${kind}`);
    const own = owned(name, owners, "get");
    const keep = kind === "nodes" ? nodes : v => v;
    if (own.range) return o => own.range.call(o);
    return o => {
      const type = nodeType(o);
      if (type) {
        if (own.node) return keep(own.node.call(o));
        if (type === ELEMENT_NODE && own.element) return keep(own.element.call(o));
        if (type === DOCUMENT_NODE && own.document) return keep(own.document.call(o));
      }
      return sanitize(o[name]);
    };
  }

  /** The same for a DOM method; the port checks each call passes only primitives and nodes. */
  function method(name, owners, kind) {
    const sanitize = SANITIZE[kind];
    if (!sanitize) throw new TypeError(`zenius dom.js: kind ${kind}`);
    const own = owned(name, owners, "value");
    const keep = kind === "nodes" ? nodes : v => v;
    if (own.range) return (o, ...args) => own.range.call(o, ...args);
    return (o, ...args) => {
      const type = nodeType(o);
      if (type) {
        if (own.node) return keep(own.node.call(o, ...args));
        if (type === ELEMENT_NODE && own.element) return keep(own.element.call(o, ...args));
        if (type === DOCUMENT_NODE && own.document) return keep(own.document.call(o, ...args));
      }
      return sanitize(o[name](...args));
    };
  }

  /** `x instanceof HTMLFooElement` without the page's HTMLFooElement: an HTML element with that local name. */
  function isHtml(v, localName) {
    return nodeType(v) === ELEMENT_NODE && namespaceOf.call(v) === HTML_NS && localNameOf.call(v) === localName;
  }

  /** `o?.member` and `o?.method(...)` for accessors. */
  const opt = (o, accessor) => (o === null || o === undefined ? undefined : accessor(o));
  const optCall = (o, accessor, ...args) => (o === null || o === undefined ? undefined : accessor(o, ...args));

  Object.defineProperty(globalThis, "__zsDom", {
    value: Object.freeze({ find, nodeType, str, num, bool, node, nodes, getter, method, isHtml, opt, optCall }),
  });
})();
