// The agent's code in an isolated world, content side (the observe layer).
//
// The agent's page code runs in a sandbox per document, never in the page's
// own JavaScript. This module keeps the worlds of this process, discards
// them, and answers the page flags the input layer's guard reads synchronously:
// - written: the agent's world wrote into one of the page's documents, so
//   the core reloads it before the user types there;
// - made: the page's top document is one the agent made (data:, blob:).
// The parent (observe/agentworld.sys.mjs) publishes both as sharedData sets
// of innerWindowIds, so a reload or a new load clears a flag by itself.
//
// Two Debugger hooks watch each world:
// - onNativeCall on the world sees every built-in that runs in the world's
//   realm, called by the agent's code or scheduled by it to run later. A
//   built-in that isn't a known read or action counts as a write and flags
//   the group's documents here. The call's deadline ends a runaway script
//   here, since the parent's cancel only reaches the page's own global.
// - onNewScript on the page's windows sees eval and Function compiled with
//   no page frame on the stack, and a script element the world inserts.
//
// Hooked: what the agent's
// code leaves that outlives the discard of its world marks the page with
// evidence (content/evidence.sys.mjs). Listeners, timers, observers and
// workers end with the world, so they don't count.
// What does:
// - code in the page's own realm, which now runs instead of being refused: a
//   script element, the page's eval and Function, a string timer, another
//   window's timer or location setter, a javascript: URL;
// - a change a write of the world makes that redirects what the user types
//   next (hookedRecord). From the world's first write in a run until the run
//   ends, a MutationObserver watches its group's documents, and only the
//   records a write made are checked, not those of an action such as a
//   click, which are the page's own doing;
// - style rules, a font face (document.fonts.add), a shadow root and
//   document.write, which leave no record, by the built-in itself.

import { MADE_DOCS_KEY, WORLD_URL, WRITTEN_DOCS_KEY } from "chrome://userscripts/content/zenius/content/worldkeys.sys.mjs";
import { hookedRecord, markHooked } from "chrome://userscripts/content/zenius/content/evidence.sys.mjs";

// Content modules import them from here too; the parent imports worldkeys.
export { MADE_DOCS_KEY, WORLD_URL, WRITTEN_DOCS_KEY };

/**
 * The agent's worlds in this process, by document (innerWindowId):
 * {sandbox, group, browserId, report}. A world's report collects, during a
 * call, the page globals its code read and couldn't see; evaluate takes it
 * after each call.
 */
const worlds = new Map();

// Installed in each world before the agent's first call. The agent's code
// shares this global, so everything the setup and its wrappers use later is
// taken now, before any of that code runs. It installs:
// - a Proxy under the world's view of the window, so a page global the Xray
//   can't show (window.ready) throws instead of reading undefined, bare or as
//   window.X;
// - window and self as the world's own global, and document.defaultView too,
//   so window.X goes through that Proxy and window.__x stays in the world;
// - setTimeout and setInterval: a function runs in the world; a string, or
//   an object that turns into one, runs in the page itself and marks it
//   hooked;
// - window.location: reads as the page's; a javascript: URL marks the page
//   hooked before it runs there. The page's other location setters
//   (document.location, another window's) mark it in the native hook, which
//   can't see their URL, since an Xray won't let them be wrapped;
// - Worker and SharedWorker that record what they start, for the discard,
//   and count as a write;
// - the page's console, so the agent's console.log is the page's, as before;
// - the counter and the tick the agent's loops call (instrumentLoops).
// It returns {ours, takeWorkers, track, adopter}: `ours` are the wrappers
// whose frames may call the timers and location setters.
const SETUP = `(function (pageOnly, missed, hooked, xrayWindow, isJavaScriptURL, wrote, tick, unrewrite) {
  "use strict";
  const apply = Reflect.apply;
  const reflectConstruct = Reflect.construct;
  const reflectGet = Reflect.get;
  const reflectSet = Reflect.set;
  const reflectHas = Reflect.has;
  const ownKeys = Reflect.ownKeys;
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const getPrototypeOf = Object.getPrototypeOf;
  const setPrototypeOf = Object.setPrototypeOf;
  const StringCtor = String;
  const TypeErrorCtor = TypeError;
  const ReferenceErrorCtor = ReferenceError;
  const ProxyCtor = Proxy;
  const ours = [];
  const own = fn => {
    ours[ours.length] = fn;
    return fn;
  };
  // Descriptors and Proxy handlers here have no prototype. A descriptor
  // would inherit a get or a value that the agent's code gave the world's
  // Object.prototype (the adopter below must hold however the agent's code
  // changed the world's built-ins). A handler would inherit each trap it
  // lacks from there, and the engine hands a trap the handler's target: the
  // page's native Worker behind ours, say.
  const fixed = (value, enumerable) => ({ __proto__: null, value, writable: false, enumerable, configurable: false });

  // Behind the window's own properties, in the world's view of the window:
  // the world's own prototype stays the sandbox's, where Gecko's slow-script
  // watchdog finds the page's window (SandboxWindowOrNull).
  // The sandbox's proxy finds a property by its descriptors, so a hidden
  // global shows as a getter that throws.
  const proto = getPrototypeOf(xrayWindow);
  const hidden = k => typeof k === "string" && !reflectHas(proto, k) && pageOnly(k);
  const thrower = k =>
    function () {
      missed(k);
      throw new ReferenceErrorCtor("zenius: " + k + " is the page's own JavaScript, which the agent's code doesn't see: it runs in an isolated world that shares only the page's DOM");
    };
  setPrototypeOf(xrayWindow, new ProxyCtor(proto, {
    __proto__: null,
    getOwnPropertyDescriptor(t, k) {
      const own = getOwnPropertyDescriptor(t, k);
      if (own || !hidden(k)) {
        return own && setPrototypeOf(own, null);
      }
      return { __proto__: null, get: thrower(k), set: undefined, enumerable: false, configurable: true };
    },
    has(t, k) {
      return reflectHas(t, k) || hidden(k);
    },
    get(t, k, r) {
      if (hidden(k)) {
        thrower(k)();
      }
      return reflectGet(t, k, r);
    },
  }));

  for (const name of ["setTimeout", "setInterval"]) {
    const native = xrayWindow[name];
    const timer = own({
      [name](handler) {
        if (typeof handler !== "function") {
          // It runs in the page itself, where it outlives the world.
          hooked("a string timer");
        }
        return apply(native, xrayWindow, arguments);
      },
    }[name]);
    defineProperty(globalThis, name, { value: timer, writable: true, configurable: true, enumerable: true });
  }

  const locationOf = () => reflectGet(xrayWindow, "location");
  const L = locationOf();
  const hrefSet = getOwnPropertyDescriptor(L, "href").set;
  const nativeAssign = getOwnPropertyDescriptor(L, "assign").value;
  const nativeReplace = getOwnPropertyDescriptor(L, "replace").value;
  // The URL is read once, so an object can't show one URL to the check and
  // another to the navigation.
  const go = own(function go(url, how) {
    const s = StringCtor(url);
    if (isJavaScriptURL(s)) {
      hooked("a javascript: URL (location)");
    }
    return apply(how === "assign" ? nativeAssign : how === "replace" ? nativeReplace : hrefSet, locationOf(), [s]);
  });
  const assign = own(function assign(url) {
    return go(url, "assign");
  });
  const replace = own(function replace(url) {
    return go(url, "replace");
  });
  // Location's members are unforgeable, which a Proxy over it must report
  // as they are: so the facade's target is an empty object, and every trap
  // reads the current Location.
  const reflectDefineProperty = Reflect.defineProperty;
  const reflectDeleteProperty = Reflect.deleteProperty;
  const handler = {
    __proto__: null,
    get: own(function get(t, k) {
      if (k === "assign") {
        return assign;
      }
      if (k === "replace") {
        return replace;
      }
      const loc = locationOf();
      const v = reflectGet(loc, k);
      return typeof v === "function" ? function () { return apply(v, loc, arguments); } : v;
    }),
    // href goes through the check. hash and the URL's parts can't make a
    // javascript: URL: Location keeps a page's scheme http(s).
    set: own(function set(t, k, v) {
      if (k === "href") {
        go(v, "href");
        return true;
      }
      return reflectSet(locationOf(), k, v);
    }),
    has: (t, k) => reflectHas(locationOf(), k),
    ownKeys: () => ownKeys(locationOf()),
    getOwnPropertyDescriptor(t, k) {
      const d = getOwnPropertyDescriptor(locationOf(), k);
      if (d) {
        setPrototypeOf(d, null);
        d.configurable = true;
      }
      return d;
    },
    getPrototypeOf: () => getPrototypeOf(locationOf()),
    defineProperty: (t, k, d) => reflectDefineProperty(locationOf(), k, d),
    deleteProperty: (t, k) => reflectDeleteProperty(locationOf(), k),
  };
  const facade = new ProxyCtor({}, handler);
  defineProperty(globalThis, "location", {
    get: own(function location() {
      return facade;
    }),
    set: own(function location(url) {
      go(url, "href");
    }),
    enumerable: true,
    configurable: false,
  });

  let workers = [];
  const track = function track(Ctor, kind) {
    if (typeof Ctor !== "function") {
      return Ctor;
    }
    const tracked = new ProxyCtor(Ctor, {
      __proto__: null,
      construct(t, args, nt) {
        const w = reflectConstruct(t, args, nt === tracked ? t : nt);
        defineProperty(workers, workers.length, { __proto__: null, value: [kind, w], writable: true, enumerable: true, configurable: true });
        // A shared worker lives as long as the page's document does: the
        // page is written, so it is reloaded before the user types there and
        // at the task's end.
        wrote();
        return w;
      },
    });
    // As the page guards' constructors do: the prototype's constructor is
    // ours too, not the page's native one, which would start a worker past
    // the record.
    const prototype = reflectGet(Ctor, "prototype");
    if (prototype) {
      defineProperty(prototype, "constructor", { __proto__: null, value: tracked, writable: true, enumerable: false, configurable: true });
    }
    return tracked;
  };
  const takeWorkers = function takeWorkers() {
    const list = workers;
    workers = [];
    return list;
  };

  // el.dataset.x = v sets an attribute through the map's named setter, which
  // calls no built-in the hook could see: the world's dataset reports it.
  const datasets = new WeakMap();
  const reflectDefine = Reflect.defineProperty;
  const reflectDelete = Reflect.deleteProperty;
  const weakGet = WeakMap.prototype.get;
  const weakSet = WeakMap.prototype.set;
  const datasetProxy = real => {
    let p = apply(weakGet, datasets, [real]);
    if (!p) {
      p = new ProxyCtor({}, {
        __proto__: null,
        get: (t, k) => reflectGet(real, k),
        set: (t, k, v) => {
          wrote();
          return reflectSet(real, k, v);
        },
        defineProperty: (t, k, d) => {
          wrote();
          return reflectDefine(real, k, d);
        },
        deleteProperty: (t, k) => {
          wrote();
          return reflectDelete(real, k);
        },
        has: (t, k) => reflectHas(real, k),
        ownKeys: () => ownKeys(real),
        getOwnPropertyDescriptor(t, k) {
          const d = getOwnPropertyDescriptor(real, k);
          if (d) {
            setPrototypeOf(d, null);
            d.configurable = true;
          }
          return d;
        },
        getPrototypeOf: () => getPrototypeOf(real),
      });
      apply(weakSet, datasets, [real, p]);
    }
    return p;
  };

  // Our shims for the windows the world reaches, made from what this setup
  // took: a window the world reaches later gets them the same way, however
  // the agent's code changed the world's built-ins meanwhile.
  const adopter = {
    dataset(xw) {
      // By index: the agent's code may have given Array a new iterator.
      const names = ["HTMLElement", "SVGElement", "MathMLElement"];
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const proto = xw[name] && xw[name].prototype;
        const d = proto && getOwnPropertyDescriptor(proto, "dataset");
        if (!d || typeof d.get !== "function" || d.configurable === false) {
          continue;
        }
        const nativeGet = d.get;
        defineProperty(proto, "dataset", {
          __proto__: null,
          get: {
            dataset() {
              return datasetProxy(apply(nativeGet, this, []));
            },
          }.dataset,
          enumerable: d.enumerable,
          configurable: false,
        });
      }
    },
    method(xw, isOwn, parts, name, fn) {
      let target = xw;
      for (let i = 0; i < parts.length; i++) {
        target = target == null ? null : target[parts[i]];
      }
      if (target == null) {
        return false;
      }
      let value = fn;
      if (parts.length === 0 && name === "open") {
        const inner = fn;
        value = function open(url) {
          const s = url === undefined ? url : StringCtor(url);
          if (s !== undefined && isJavaScriptURL(s)) {
            hooked("a javascript: URL (window.open)");
          }
          return apply(inner, this, [s, arguments[1], arguments[2]]);
        };
      }
      defineProperty(target, name, fixed(value, true));
      if (isOwn && parts.length === 0) {
        defineProperty(globalThis, name, fixed(value, true));
      }
      return true;
    },
    getter(xw, parts, name, fn, wrap) {
      let target = xw;
      for (let i = 0; i < parts.length; i++) {
        target = target == null ? null : target[parts[i]];
      }
      if (target == null) {
        return false;
      }
      const d = getOwnPropertyDescriptor(target, name);
      if (!d || typeof d.get !== "function" || d.configurable === false) {
        return false;
      }
      // A trap (mirrorGetterTrap) gets the world's own getter to call, which
      // runs in the world's realm.
      const get = wrap ? new ProxyCtor(d.get, { __proto__: null, apply: fn }) : fn;
      defineProperty(target, name, { __proto__: null, get, set: d.set, enumerable: d.enumerable, configurable: false });
      return true;
    },
    ctor(xw, isOwn, name, value) {
      const d = getOwnPropertyDescriptor(xw, name);
      if (d && d.configurable === false) {
        return false;
      }
      defineProperty(xw, name, fixed(value, false));
      if (isOwn) {
        defineProperty(globalThis, name, fixed(value, false));
      }
      return true;
    },
    native(xw, name) {
      return xw[name];
    },
  };

  // The agent's loops count here, and call tick every 4096 turns, so the
  // hook sees a loop that calls no built-in (instrumentLoops). A function's
  // text stays the agent's own.
  defineProperty(globalThis, "__zeniusLoops", fixed(new Int32Array(1), false));
  defineProperty(globalThis, "__zeniusTick", fixed(tick, false));
  const functionProto = getPrototypeOf(function () {});
  const nativeToString = functionProto.toString;
  const indexOf = StringCtor.prototype.indexOf;
  const toString = {
    toString() {
      if (this === toString) {
        return "function toString() {\\n    [native code]\\n}";
      }
      const text = apply(nativeToString, this, []);
      return apply(indexOf, text, ["__zeniusLoops"]) === -1 ? text : unrewrite(text);
    },
  }.toString;
  defineProperty(functionProto, "toString", { value: toString, writable: true, enumerable: false, configurable: true });
  defineProperty(globalThis, "window", { value: globalThis, enumerable: true });
  defineProperty(globalThis, "self", { value: globalThis, enumerable: true });
  try {
    defineProperty(xrayWindow.document, "defaultView", { get: () => globalThis, configurable: true });
  } catch {}
  if (Object.prototype.hasOwnProperty.call(globalThis, "console")) {
    delete globalThis.console;
  }
  return { ours, takeWorkers, track, adopter };
})`;

// The observer is on only while this process holds something of the agent's
// for some document: a world, shims, a URL record or a written flag. Each of
// those puts it on, and it comes off with the last of them. A process that
// hosted a task then watches nothing for the user's later documents there.
let watchingDestroyed = false;

function watchDestroyed() {
  if (!watchingDestroyed) {
    watchingDestroyed = true;
    Services.obs.addObserver(onWindowDestroyed, "inner-window-destroyed");
  }
}

function unwatchDestroyedIfIdle() {
  if (watchingDestroyed && !worlds.size && !mirrors.size && !urls.size && !writtenHere.size) {
    watchingDestroyed = false;
    try {
      Services.obs.removeObserver(onWindowDestroyed, "inner-window-destroyed");
    } catch {}
  }
}

/** A document that goes takes its world with it, whatever the route. */
function onWindowDestroyed(subject) {
  try {
    const id = subject.QueryInterface(Ci.nsISupportsPRUint64).data;
    mirrors.delete(id);
    urls.delete(id);
    // Its id never comes back, and every check of the flags reads live documents.
    writtenHere.delete(id);
    docEpoch++;
    const world = worlds.get(id);
    if (world) {
      discardWorld(id, world);
    }
  } catch {}
  unwatchDestroyedIfIdle();
}

// ---------------------------------------------------------------------------
// The hooks

function newDebugger() {
  if (!globalThis.Debugger) {
    const { addDebuggerToGlobal } = ChromeUtils.importESModule("moz-src:///devtools/platform/jsdebugger.sys.mjs");
    addDebuggerToGlobal(globalThis);
  }
  return new globalThis.Debugger();
}

const SAFE = 0;
const WRITE = 1;
const TIMER = 2;
const NAVIGATE = 3;
const HISTORY = 4;
const OPEN = 5;
// A read that reaches into a shadow tree: the world's watch then observes the
// documents' shadow roots too, which a document's observer doesn't reach.
const SHADOW = 6;
// Built-ins whose effect outlives the world and leaves no MutationObserver
// record: each marks the page hooked by itself.
const HOOK_STYLE = 7;
const HOOK_SHADOW = 8;
const HOOK_WRITE = 9;
const HOOK_FONT = 10;
const HOOK_DETAILS = { [HOOK_STYLE]: "a style rule", [HOOK_SHADOW]: "a shadow root", [HOOK_WRITE]: "document.write", [HOOK_FONT]: "a font face" };
const isWriteKind = kind => kind === WRITE || kind >= HOOK_STYLE;
// Our shims of those built-ins in a task's pages (adopt): the world calls the
// shim, which calls the native from chrome, where the hook doesn't see it.
const MIRROR_KINDS = { "Element.prototype.attachShadow": HOOK_SHADOW };

// The DOM's methods and setters that neither write nor run code: reads, and
// the agent's actions. Every other method or setter of the DOM counts as a
// write, so a gap costs a reload, never a missed write. By interface; a
// mixin's members are on each interface that includes it. JavaScript's own
// built-ins (and the engine's helpers they call) only ever reach the page
// through the DOM's, which the hook sees in turn, so they count as reads,
// as do the DOM's static methods.
const SAFE_METHODS = {
  EventTarget: ["addEventListener", "removeEventListener", "dispatchEvent"],
  Node: ["contains", "compareDocumentPosition", "isEqualNode", "isSameNode", "getRootNode", "hasChildNodes", "lookupPrefix", "lookupNamespaceURI", "isDefaultNamespace", "cloneNode"],
  Element: [
    "getAttribute", "getAttributeNS", "getAttributeNames", "getAttributeNode", "getAttributeNodeNS", "hasAttribute", "hasAttributeNS", "hasAttributes",
    "querySelector", "querySelectorAll", "getElementsByTagName", "getElementsByTagNameNS", "getElementsByClassName", "matches", "closest", "webkitMatchesSelector",
    "getBoundingClientRect", "getClientRects", "checkVisibility", "getAnimations", "scrollIntoView", "scroll", "scrollTo", "scrollBy", "hasPointerCapture",
  ],
  HTMLElement: ["click", "focus", "blur"],
  SVGElement: ["focus", "blur", "getBBox", "getCTM", "getScreenCTM"],
  MathMLElement: ["focus", "blur"],
  Document: [
    "getElementById", "querySelector", "querySelectorAll", "getElementsByTagName", "getElementsByTagNameNS", "getElementsByClassName", "getElementsByName",
    "createElement", "createElementNS", "createTextNode", "createComment", "createDocumentFragment", "createRange", "createTreeWalker", "createNodeIterator",
    "createEvent", "importNode", "elementFromPoint", "elementsFromPoint", "caretPositionFromPoint", "getSelection", "hasFocus", "getAnimations", "hasStorageAccess",
    "queryCommandState", "queryCommandValue", "queryCommandEnabled", "queryCommandSupported",
    "evaluate", "createExpression", "createNSResolver",
  ],
  XPathResult: ["iterateNext", "snapshotItem"],
  XPathExpression: ["evaluate"],
  XPathEvaluator: ["evaluate", "createExpression", "createNSResolver"],
  DocumentFragment: ["getElementById", "querySelector", "querySelectorAll"],
  ShadowRoot: ["getElementById", "elementFromPoint", "elementsFromPoint", "getSelection", "getAnimations"],
  Window: [
    "getComputedStyle", "matchMedia", "getSelection", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback",
    "queueMicrotask", "clearTimeout", "clearInterval", "fetch", "atob", "btoa", "structuredClone", "scroll", "scrollTo", "scrollBy", "focus", "blur",
    "postMessage", "alert", "confirm", "prompt", "stop", "close", "createImageBitmap", "reportError",
  ],
  HTMLInputElement: ["select", "setSelectionRange", "setRangeText", "stepUp", "stepDown", "checkValidity", "reportValidity", "showPicker", "setCustomValidity"],
  HTMLTextAreaElement: ["select", "setSelectionRange", "setRangeText", "checkValidity", "reportValidity", "setCustomValidity"],
  HTMLSelectElement: ["item", "namedItem", "checkValidity", "reportValidity", "showPicker", "setCustomValidity"],
  HTMLFormElement: ["checkValidity", "reportValidity", "requestSubmit", "submit", "reset"],
  HTMLButtonElement: ["checkValidity", "reportValidity", "setCustomValidity"],
  HTMLCanvasElement: ["getContext", "toDataURL", "toBlob"],
  HTMLMediaElement: ["play", "pause", "canPlayType", "load"],
  HTMLImageElement: ["decode"],
  HTMLCollection: ["item", "namedItem"],
  HTMLAllCollection: ["item", "namedItem"],
  HTMLOptionsCollection: ["item", "namedItem"],
  HTMLFormControlsCollection: ["item", "namedItem"],
  NodeList: ["item"],
  RadioNodeList: ["item"],
  DOMTokenList: ["contains", "item", "supports"],
  NamedNodeMap: ["getNamedItem", "getNamedItemNS", "item"],
  CSSStyleDeclaration: ["getPropertyValue", "getPropertyPriority", "item"],
  DOMRectReadOnly: ["toJSON"],
  DOMRect: ["toJSON"],
  Range: [
    "setStart", "setEnd", "setStartBefore", "setStartAfter", "setEndBefore", "setEndAfter", "collapse", "selectNode", "selectNodeContents",
    "compareBoundaryPoints", "cloneContents", "cloneRange", "detach", "isPointInRange", "comparePoint", "intersectsNode", "getBoundingClientRect",
    "getClientRects", "toString", "createContextualFragment",
  ],
  Selection: [
    "getRangeAt", "addRange", "removeRange", "removeAllRanges", "empty", "collapse", "collapseToStart", "collapseToEnd", "extend",
    "selectAllChildren", "setBaseAndExtent", "setPosition", "containsNode", "modify", "toString",
  ],
  TreeWalker: ["parentNode", "firstChild", "lastChild", "previousSibling", "nextSibling", "previousNode", "nextNode"],
  NodeIterator: ["nextNode", "previousNode", "detach"],
  Event: ["preventDefault", "stopPropagation", "stopImmediatePropagation", "composedPath", "initEvent"],
  CustomEvent: ["initCustomEvent"],
  MutationObserver: ["observe", "disconnect", "takeRecords"],
  ResizeObserver: ["observe", "unobserve", "disconnect"],
  IntersectionObserver: ["observe", "unobserve", "disconnect", "takeRecords"],
  PerformanceObserver: ["observe", "disconnect", "takeRecords"],
  Performance: ["now", "mark", "measure", "getEntries", "getEntriesByType", "getEntriesByName", "toJSON"],
  Location: ["reload", "toString"],
  History: ["back", "forward", "go"],
  URL: ["toString", "toJSON"],
  URLSearchParams: ["get", "getAll", "has", "toString", "keys", "values", "entries", "forEach", "append", "set", "delete", "sort"],
  FormData: ["get", "getAll", "has", "keys", "values", "entries", "forEach", "append", "set", "delete"],
  Headers: ["get", "has", "keys", "values", "entries", "forEach", "append", "set", "delete", "getSetCookie"],
  Response: ["text", "json", "arrayBuffer", "blob", "formData", "clone", "bytes"],
  Request: ["text", "json", "arrayBuffer", "blob", "formData", "clone", "bytes"],
  Blob: ["text", "arrayBuffer", "slice", "stream", "bytes"],
  TextEncoder: ["encode", "encodeInto"],
  TextDecoder: ["decode"],
  Crypto: ["getRandomValues", "randomUUID"],
  SubtleCrypto: ["digest"],
  DOMParser: ["parseFromString"],
  XMLSerializer: ["serializeToString"],
  XMLHttpRequest: ["open", "send", "setRequestHeader", "getResponseHeader", "getAllResponseHeaders", "abort", "overrideMimeType"],
  Storage: ["getItem", "key"],
  CanvasRenderingContext2D: ["getImageData", "measureText", "isPointInPath", "isPointInStroke", "getTransform"],
  Worker: ["postMessage", "terminate"],
  MessagePort: ["postMessage", "start", "close"],
  BroadcastChannel: ["postMessage", "close"],
  WebSocket: ["send", "close"],
  EventSource: ["close"],
  AbortController: ["abort"],
  AbortSignal: ["throwIfAborted"],
  Clipboard: [],
};
const SAFE_SETTERS = {
  HTMLInputElement: ["value", "checked", "indeterminate", "selectionStart", "selectionEnd", "selectionDirection", "valueAsNumber", "valueAsDate"],
  HTMLTextAreaElement: ["value", "selectionStart", "selectionEnd", "selectionDirection"],
  HTMLSelectElement: ["value", "selectedIndex"],
  HTMLOptionElement: ["selected"],
  Element: ["scrollTop", "scrollLeft"],
  HTMLMediaElement: ["currentTime", "volume", "muted", "playbackRate"],
  Event: ["returnValue", "cancelBubble"],
  XMLHttpRequest: ["responseType", "timeout", "withCredentials"],
};
const LOCATION_PARTS = ["href", "protocol", "host", "hostname", "port", "pathname", "search"];

// One member for each of the generic natives the DOM's bindings share (by
// the kind of \`this\` they take, and whether they throw or reject): every
// DOM method and setter is one of these, told apart by its JitInfo
// (measured on Gecko 160: all 5026 methods and setters of a page's
// interfaces). [interface or "window", "location", "document"; name; "value"
// or "set"].
const GENERICS = [
  ["Element", "getAttribute", "value"],
  ["HTMLMediaElement", "play", "value"],
  ["window", "getComputedStyle", "value"],
  ["window", "fetch", "value"],
  ["window", "postMessage", "value"],
  ["Element", "id", "set"],
  ["window", "name", "set"],
  ["window", "location", "set"],
  ["Document", "onreadystatechange", "set"],
  ["window", "onmouseenter", "set"],
];

/** name → [[native, kind]] of the DOM's members zenius knows, and the generic natives; made once per process. */
let tables = null;

function referenceTables(win) {
  let secure = false;
  try {
    secure = !!win.isSecureContext;
  } catch {}
  // Rebuilt once from a secure page, whose interfaces an insecure one lacks.
  if (tables && (tables.secure || !secure)) {
    return tables;
  }
  const dom = new Map();
  const put = (fn, kind) => {
    if (typeof fn !== "function" || !fn.name) {
      return;
    }
    const list = dom.get(fn.name);
    if (list) {
      list.push([fn, kind]);
    } else {
      dom.set(fn.name, [[fn, kind]]);
    }
  };
  const desc = (o, k) => {
    try {
      return o ? Object.getOwnPropertyDescriptor(o, k) : undefined;
    } catch {
      return undefined;
    }
  };
  // Before the reads, which share some of their names: the first match wins.
  put(desc(win.Element?.prototype, "shadowRoot")?.get, SHADOW);
  put(desc(win.Event?.prototype, "composedPath")?.value, SHADOW);
  put(desc(win.Node?.prototype, "getRootNode")?.value, SHADOW);
  for (const name of ["insertRule", "addRule", "replace", "replaceSync"]) {
    put(desc(win.CSSStyleSheet?.prototype, name)?.value, HOOK_STYLE);
  }
  put(desc(win.CSSGroupingRule?.prototype, "insertRule")?.value, HOOK_STYLE);
  put(desc(win.CSSStyleRule?.prototype, "selectorText")?.set, HOOK_STYLE);
  put(desc(win.Document?.prototype, "adoptedStyleSheets")?.set, HOOK_STYLE);
  put(desc(win.ShadowRoot?.prototype, "adoptedStyleSheets")?.set, HOOK_STYLE);
  put(desc(win.Element?.prototype, "attachShadow")?.value, HOOK_SHADOW);
  // A face added under a family the page's own CSS uses loads its URL for
  // each character the page then shows in it, the user's typing included:
  // a style rule's keylogger with no rule.
  put(desc(win.FontFaceSet?.prototype, "add")?.value, HOOK_FONT);
  for (const name of ["write", "writeln", "open"]) {
    put(desc(win.Document?.prototype, name)?.value, HOOK_WRITE);
  }
  for (const [iface, names] of Object.entries(SAFE_METHODS)) {
    const proto = win[iface]?.prototype;
    for (const name of names) {
      put(desc(proto, name)?.value, SAFE);
    }
  }
  for (const [iface, names] of Object.entries(SAFE_SETTERS)) {
    const proto = win[iface]?.prototype;
    for (const name of names) {
      put(desc(proto, name)?.set, SAFE);
    }
  }
  for (const name of SAFE_METHODS.Window) {
    put(desc(win, name)?.value, SAFE);
  }
  put(desc(win, "setTimeout")?.value, TIMER);
  put(desc(win, "setInterval")?.value, TIMER);
  const loc = win.location;
  for (const part of LOCATION_PARTS) {
    put(desc(loc, part)?.set, NAVIGATE);
  }
  put(desc(loc, "assign")?.value, NAVIGATE);
  put(desc(loc, "replace")?.value, NAVIGATE);
  put(desc(loc, "hash")?.set, HISTORY);
  put(desc(win, "location")?.set, NAVIGATE);
  put(desc(win.document, "location")?.set, NAVIGATE);
  put(desc(win.History?.prototype, "pushState")?.value, HISTORY);
  put(desc(win.History?.prototype, "replaceState")?.value, HISTORY);
  // Our shim calls it from chrome, which the hook doesn't see.
  put(desc(win, "open")?.value, OPEN);

  const generics = [];
  for (const [where, name, part] of GENERICS) {
    const target = where === "window" ? win : win[where]?.prototype;
    const fn = desc(target, name)?.[part];
    if (typeof fn === "function") {
      generics.push(fn);
    }
  }
  tables = { dom, generics, secure };
  return tables;
}

function classify(callee) {
  if (callee.isBoundFunction || callee.isProxy) {
    // A bound function's target and a Proxy's traps come to the hook in turn.
    return SAFE;
  }
  const name = callee.name;
  if (!name) {
    // The engine's own: a promise's resolving functions and jobs.
    return SAFE;
  }
  try {
    if (callee.isNativeGetterWithJitInfo()) {
      // A getter reads; shadowRoot's opens a shadow tree for the world's watch.
      for (const [fn, kind] of tables.dom.get(name) ?? []) {
        if (kind === SHADOW && callee.isSameNativeWithJitInfo(fn)) {
          return SHADOW;
        }
      }
      return SAFE;
    }
  } catch {}
  for (const [fn, kind] of tables.dom.get(name) ?? []) {
    try {
      if (callee.isSameNativeWithJitInfo(fn)) {
        return kind;
      }
    } catch {}
  }
  for (const fn of tables.generics) {
    try {
      if (callee.isSameNative(fn)) {
        // A DOM method or setter zenius doesn't know as a read.
        return WRITE;
      }
    } catch {}
  }
  return SAFE;
}

/** Bumped when a document comes or goes, so a world flags a new one too. */
let docEpoch = 0;

/** The innerWindowIds of the same-process documents of the world's group. */
function groupDocuments(world) {
  const ids = [];
  for (const w of windowsOfGroup(world.bc)) {
    const id = w.windowGlobalChild?.innerWindowId;
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * The world wrote: every document of its group in this process is written.
 * The hook doesn't see which one, so it flags all; the cost of too many is a
 * reload.
 */
function flagWritten(world) {
  if (world.flaggedEpoch === docEpoch || world.settingUp) {
    return;
  }
  world.flaggedEpoch = docEpoch;
  const fresh = groupDocuments(world).filter(id => !writtenHere.has(id));
  for (const id of fresh) {
    markWritten(id);
  }
  if (fresh.length) {
    tellParent({ ids: fresh });
  }
}

/**
 * Agent input put markup into this window's document outside the world: a
 * paste with html, the agent's own or the Space's clipboard through its
 * Ctrl/Cmd+V. A page's paste handler may insert it as live markup, so the
 * document counts as written, here at once and in the parent. So does every
 * other document of its group in this process, as for a write of the world
 * (flagWritten): the markup's handlers run as the page's own code and reach
 * them.
 *
 * @param {Window} win  the document's window
 */
export function noteWrittenWindow(win) {
  try {
    const fresh = [];
    for (const w of [win, ...windowsOfGroup(win.browsingContext)]) {
      const id = w?.windowGlobalChild?.innerWindowId;
      if (id && !writtenHere.has(id) && !fresh.includes(id)) {
        fresh.push(id);
      }
    }
    for (const id of fresh) {
      markWritten(id);
    }
    if (fresh.length) {
      tellParent({ ids: fresh });
    }
  } catch (e) {
    console.error("[zenius] flagging a document the agent pasted into", e);
  }
}

/**
 * A dedicated worker starts for `win`'s document. The worker guard calls this
 * while the worker's constructor still runs, so the stack shows whose code
 * called it. One the agent's world started counts as a write, as the world's
 * own Worker counts it (SETUP's track): the page is reloaded before the user
 * types there and at the task's end, and the worker goes with its document.
 * That covers a native constructor the world's code reached past ours too,
 * since the hook never sees a DOM constructor that runs through an Xray. A
 * worker the page's own code starts is the page's, from a handler the
 * agent's click ran too.
 *
 * @param {Window} win  the worker's owner window
 * @returns {boolean} whether the world started it
 */
export function noteWorkerStart(win) {
  if (!worlds.size || nearestScriptedFrame() !== "world") {
    return false;
  }
  noteWrittenWindow(win);
  return true;
}

/**
 * A document that comes into a group where another document of this process
 * is written, or is one the agent made, can be reached by the code left
 * there, which runs as the page's own once the world is gone: it counts as
 * written too. A write of the world flags the documents already there
 * (flagWritten); this flags those that come later, so the hand-off's check
 * of the held page can trust the flags alone, not the sites where the
 * agent's code ran (as the SDK's rehearsal showed). A tab's own earlier
 * document never runs beside its next one: it's gone, or frozen in the
 * back-forward cache, so a clean copy of a written page starts clean.
 *
 * @param {Window} win  the new document's window
 */
function flagIfExposed(win) {
  try {
    const shared = Services.cpmm.sharedData.get(WRITTEN_DOCS_KEY);
    const made = Services.cpmm.sharedData.get(MADE_DOCS_KEY);
    if (!writtenHere.size && !shared?.size && !made?.size) {
      return;
    }
    const id = win.windowGlobalChild?.innerWindowId;
    if (!id || writtenHere.has(id) || shared?.has?.(id)) {
      return;
    }
    const exposed = windowsOfGroup(win.browsingContext).some(other => {
      const otherId = other.windowGlobalChild?.innerWindowId;
      return !!otherId && otherId !== id && (writtenHere.has(otherId) || !!shared?.has?.(otherId) || !!made?.has?.(otherId));
    });
    if (exposed) {
      markWritten(id);
      tellParent({ ids: [id] });
    }
  } catch (e) {
    console.error("[zenius] checking a new document beside a written one", e);
  }
}

function tellParent(data) {
  try {
    Services.cpmm.sendAsyncMessage("zenius:written", data);
  } catch (e) {
    console.error("[zenius] telling the parent of a written page", e);
  }
}

// The URL a document had before the agent's code changed it in place
// (pushState, replaceState, the hash, a location set to the same document),
// so the core's clean load goes back there and not to an address the agent
// chose. innerWindowId → {before, agentSet}.
const urls = new Map();
let urlsPending = null;

function documentURL(win) {
  try {
    return win?.document?.documentURI ?? null;
  } catch {
    return null;
  }
}

/** The world is about to change a URL of its group in place: note each document's, then see which changed. */
function noteURLChange(world) {
  if (!urlsPending) {
    urlsPending = new Map();
    // After the call itself: the Debugger runs a hook's promise jobs as the
    // hook returns, before the built-in it was called for.
    Services.tm.dispatchToMainThread(settleURLs);
  }
  for (const win of windowsOfGroup(world.bc)) {
    const id = win.windowGlobalChild?.innerWindowId;
    const now = documentURL(win);
    if (!id || now === null) {
      continue;
    }
    const known = urls.get(id);
    // The site moved on since the agent's last change: its URL is the clean one now.
    if (!known || (known.agentSet !== null && known.agentSet !== now)) {
      watchDestroyed();
      urls.set(id, { before: now, agentSet: null });
    }
    urlsPending.set(id, win);
  }
}

function settleURLs() {
  const pending = urlsPending;
  urlsPending = null;
  if (!pending) {
    return;
  }
  const changed = {};
  let any = false;
  for (const [id, win] of pending) {
    const known = urls.get(id);
    const now = documentURL(win);
    if (!known || now === null) {
      continue;
    }
    if (now !== known.before) {
      known.agentSet = now;
      changed[id] = { before: known.before, agentSet: now };
      any = true;
    } else if (known.agentSet === null) {
      urls.delete(id);
    }
  }
  if (any) {
    tellParent({ ids: [], urls: changed });
  }
}

/** Is the world's newest frame one of its own wrappers (SETUP's `ours`)? */
function fromOurs(world) {
  try {
    const frame = world.dbg.getNewestFrame();
    return !!frame?.callee && world.ours.has(frame.callee);
  } catch {
    return false;
  }
}

/** A callback the world's code left ran too long between calls: the agent hears of it as a page event. */
function noteRunaway(world) {
  try {
    world.win.windowGlobalChild?.getActor("Zenius")?.emit("observe.refused", {
      kind: "agentCode",
      message: `The agent's code, run earlier, was refused: ${RUNAWAY_TEXT}`,
      url: String(world.win.location.href).slice(0, 2000),
    });
  } catch {}
}

// Outside a call, a callback the agent's code left (a timer, a listener, a
// promise's continuation) may run this long in one turn of the event loop.
// The page's process, the user's tabs on the site included, waits on it.
const IDLE_LIMIT_MS = 1000;

/** The world's code runs in a new turn of the event loop: note when, and forget it once the turn is over. */
function startTurn(world, now) {
  if (!world.turnStart) {
    world.turnStart = now;
    Services.tm.dispatchToMainThread(world.endTurn);
  }
}

/**
 * The deadlines. The parent's cancel doesn't reach a sandbox's script, so the
 * hook ends it, as if by an uncatchable error, at a built-in it calls; a loop
 * that calls none runs on until the slow-script watchdog (a residual). Like
 * Chrome's Runtime.evaluate timeout, a call's deadline ends the code that is
 * running when it falls, the call's own or a callback it left, and the call
 * reports it; a callback that starts after it still runs (Ego's late
 * effects). While no call runs, the world's code may run IDLE_LIMIT_MS at
 * once.
 * Returns true when the running code must end.
 */
function pastDeadline(world) {
  const now = ChromeUtils.now();
  startTurn(world, now);
  let expired = false;
  for (const call of world.calls) {
    if (call.deadline < now && call.deadline >= world.turnStart) {
      // The code that runs may be another call's, which the world can't
      // tell apart: it ends too, and this call reports its deadline.
      world.calls.delete(call);
      call.stop({ terminated: true });
      expired = true;
    }
  }
  if (expired) {
    return true;
  }
  // While a call runs, its deadline bounds the world's code: a continuation
  // after an await runs in a later turn, and may take the call's time.
  if (!world.calls.size && !world.turnCall && now - world.turnStart > IDLE_LIMIT_MS) {
    world.turnStart = now;
    noteRunaway(world);
    return true;
  }
  if (now - world.turnStart >= CONTROL_CHECK_MS && now - world.controlCheckedAt >= CONTROL_CHECK_MS) {
    world.controlCheckedAt = now;
    if (stopAsked(world, now - world.turnStart)) {
      for (const call of world.calls) {
        call.stop({ terminated: true });
      }
      world.calls.clear();
      return true;
    }
  }
  return false;
}

// A long run asks the parent this often whether it may go on: when the user
// takes the task, or zenius stops the tab's script, the parent says stop.
// Gecko's own stop (methods/observe.sys.mjs, stopPageScript) skips a
// sandbox's script, and a busy world can't take a message.
const CONTROL_CHECK_MS = 200;

/**
 * Must the agent's code that has run `turnMs` in this turn stop? A sync
 * message, sent at most every CONTROL_CHECK_MS of a long run. No answer
 * means no task is live in the parent, so nothing of the agent's may run.
 */
function stopAsked(world, turnMs) {
  let answers;
  try {
    answers = Services.cpmm.sendSyncMessage("zenius:worldStop", { browserId: world.browserId, turnMs });
  } catch {
    return false;
  }
  return !answers?.length || answers.some(answer => answer === true);
}

/**
 * Is the built-in about to run called by a step of zenius's own in the world
 * (asOwnStep), not by the agent's code? Its newest frame in the world is then
 * one of the adopter's functions, which only chrome holds, or there's none:
 * chrome calls a built-in of the world itself. The agent's code is always
 * the newest frame when it calls one, also when one of zenius's steps runs
 * it (a getter it left), so its deadline still holds.
 *
 * Such a step isn't the agent's code: no deadline ends it, and what it does
 * isn't the agent's writes. Ending it would end, as by an uncatchable error,
 * the actor's handling of the new document it adopts: the guards still to go
 * in after it never would. A page whose own turn runs past IDLE_LIMIT_MS and
 * then makes a frame could do that at will.
 */
function ownStep(world) {
  try {
    const frame = world.dbg.getNewestFrame();
    return !frame || world.steps.has(frame.callee);
  } catch {
    return false;
  }
}

/** Run `fn`, a step of zenius's own in `world` (ownStep). */
function asOwnStep(world, fn) {
  world.ownSteps++;
  try {
    return fn();
  } finally {
    world.ownSteps--;
  }
}

const RUNAWAY_TEXT = `a callback the agent's code left in the page (a timer, a listener or a promise's continuation) ran past ${IDLE_LIMIT_MS} ms at once, and zenius stopped it, since the page's process waits on it.`;

function onNative(world, callee, reason) {
  if (world.ownSteps && !world.cutOwnSteps && ownStep(world)) {
    return undefined;
  }
  if (pastDeadline(world)) {
    return null;
  }
  // What the previous built-in changed, before this one runs.
  if (world.watch?.on) {
    takeWatched(world);
  }
  let kind = world.kinds.get(callee);
  if (kind === undefined) {
    kind = classify(callee);
    world.kinds.set(callee, kind);
    if (isWriteKind(kind) && world.writes.length < 50) {
      world.writes.push(`${callee.name}${reason === "set" ? " (set)" : ""}`);
    }
  }
  world.lastKind = kind;
  switch (kind) {
    case SAFE:
      return undefined;
    case SHADOW:
      world.shadowSeen = true;
      return undefined;
    case TIMER:
      if (!fromOurs(world)) {
        leftCode(world, "another window's timer");
      }
      return undefined;
    case NAVIGATE:
      if (!fromOurs(world)) {
        // The hook can't see the URL: a javascript: one runs in this
        // document, and any other replaces the document, mark and all.
        leftCode(world, "a location set past window.location");
      }
      noteURLChange(world);
      return undefined;
    case HISTORY:
      noteURLChange(world);
      flagWritten(world);
      return undefined;
    case OPEN:
      leftCode(world, "window.open past zenius's");
      return undefined;
    case HOOK_STYLE:
    case HOOK_SHADOW:
    case HOOK_WRITE:
    case HOOK_FONT:
      leftCode(world, HOOK_DETAILS[kind]);
      return undefined;
    default:
      flagWritten(world);
      watchWrites(world);
      return undefined;
  }
}

/** The world left code in the page's own realm, or a change only its built-in shows: the page is hooked, and written. */
function leftCode(world, detail) {
  flagWritten(world);
  noteHooked(world, markHooked(world.win, detail));
}

/**
 * The world's call left what `text` says in a document that wasn't hooked
 * before (markHooked's answer): the call's reply says so, since the page now
 * loads afresh before the user acts there and at the task's end
 * (content/evaluate.sys.mjs, PROTOCOL "hooked"). A world with no call
 * running drops it at its next call's start (takeReport).
 */
function noteHooked(world, text) {
  if (text) {
    world.report.hooked.push(text);
  }
}

/** The shadow roots in `doc`, nested ones too. */
function shadowRootsOf(doc) {
  const roots = [];
  const walk = root => {
    const it = doc.createTreeWalker(root, 1);
    for (let el = it.nextNode(); el; el = it.nextNode()) {
      const shadow = el.openOrClosedShadowRoot;
      if (shadow) {
        roots.push(shadow);
        walk(shadow);
      }
    }
  };
  try {
    walk(doc);
  } catch {}
  return roots;
}

/**
 * The world wrote: its watch observes the group's documents (and their
 * shadow roots, once its code has reached into one) until the run ends.
 */
function watchWrites(world) {
  if (world.watch?.on) {
    return;
  }
  if (!world.watch) {
    try {
      world.watch = { mo: new world.win.MutationObserver(records => recordsLeft(world, records)), on: false };
    } catch (e) {
      console.error("[zenius] watching the agent's writes", e);
      return;
    }
  }
  const options = { childList: true, subtree: true, attributes: true };
  for (const win of windowsOfGroup(world.bc)) {
    try {
      world.watch.mo.observe(win.document, options);
      if (world.shadowSeen) {
        for (const root of shadowRootsOf(win.document)) {
          world.watch.mo.observe(root, options);
        }
      }
    } catch {}
  }
  world.watch.on = true;
  armRunEnd(world);
}

/** The run ends when its oldest frame of the world's pops: a return, a throw, or an await. */
function armRunEnd(world) {
  try {
    let frame = world.dbg.getNewestFrame();
    while (frame?.older) {
      frame = frame.older;
    }
    if (!frame || world.runFrame === frame) {
      return;
    }
    world.runFrame = frame;
    frame.onPop = () => endRun(world);
  } catch (e) {
    console.error("[zenius] watching the end of the agent's run", e);
  }
}

/** The watch takes the run's last records and stops, so the page's own changes after it are never the world's. */
function endRun(world) {
  world.runFrame = null;
  const watch = world.watch;
  if (!watch?.on) {
    return;
  }
  takeWatched(world);
  try {
    watch.mo.disconnect();
  } catch {}
  watch.on = false;
  world.lastKind = SAFE;
}

/** Records that waited past a run whose end the watch couldn't see: they count as the run's, and it stops. */
function recordsLeft(world, records) {
  if (records.length && isWriteKind(world.lastKind)) {
    checkRecords(world, records);
  }
  endRun(world);
}

/** The records since the last built-in: a write's count, an action's are the page's doing. */
function takeWatched(world) {
  let records = [];
  try {
    records = world.watch.mo.takeRecords();
  } catch {}
  if (records.length && isWriteKind(world.lastKind)) {
    checkRecords(world, records);
  }
}

/**
 * Each document a record that counts as hooked is in is marked: the agent's
 * code wrote there (the defenses act on evidence), the world's own page or
 * another of its group.
 */
function checkRecords(world, records) {
  const marked = new Set();
  for (const record of records) {
    let win = world.win;
    try {
      const node = record.target;
      win = (node.nodeType === 9 ? node : node.ownerDocument)?.defaultView ?? win;
    } catch {}
    if (marked.has(win)) {
      continue;
    }
    const detail = hookedRecord(record);
    if (detail) {
      noteHooked(world, markHooked(win, detail));
      marked.add(win);
    }
  }
}

/** Tests and diagnostics: the names of the built-ins that counted as writes in this world, first seen first. */
export function writesOf(win) {
  return [...(worlds.get(win?.windowGlobalChild?.innerWindowId)?.writes ?? [])];
}

// The page's compile hook, one per group: eval and Function compiled with no
// page frame on the stack (the world's direct call, or a built-in it handed a
// timer, a job or a listener), and a script element the world inserts. The
// site's own eval, string timers and inline handlers have a page frame, or
// aren't these kinds.
const compileHooks = new Map();
const EVALS = new Set(["eval", "Function", "GeneratorFunction", "AsyncFunction", "AsyncGeneratorFunction"]);
const CHROME_FILES = ["chrome://", "resource://", "moz-src://", "jar:"];

/** Whose script compiled the eval or Function `script`: "world", "page", or null when no content script did. */
function introducer(script) {
  // The script that called eval or Function, which the source records: no
  // stack to walk. Without one (a built-in called it from a job), or when it
  // is self-hosted or chrome (a built-in the world called, like map), the
  // stack says who is beneath it.
  let file = "";
  try {
    file = script.source.introductionScript?.url || "";
  } catch {}
  if (!file || file === "self-hosted" || CHROME_FILES.some(p => file.startsWith(p))) {
    return nearestScriptedFrame();
  }
  return file.startsWith(WORLD_URL) ? "world" : "page";
}

/** "world", "page", or null when no content frame is on the stack. */
function nearestScriptedFrame() {
  for (let f = Components.stack; f; f = f.caller) {
    const file = f.filename || "";
    if (!file || file === "self-hosted" || CHROME_FILES.some(p => file.startsWith(p))) {
      continue;
    }
    return file.startsWith(WORLD_URL) ? "world" : "page";
  }
  return null;
}

function onPageScript(group, script) {
  let type;
  try {
    type = script.source.introductionType;
  } catch {
    return;
  }
  const isEval = EVALS.has(type);
  // inlineScript: one document.write wrote, with the world's frame below it.
  if (!isEval && type !== "injectedScript" && type !== "inlineScript") {
    return;
  }
  const who = isEval ? introducer(script) : nearestScriptedFrame();
  if (who === "page" || (who === null && !isEval)) {
    return;
  }
  // It runs, in the page's own realm, where it outlives the world: the page
  // is hooked.
  const detail = !isEval ? "a script element" : type === "eval" ? "eval in the page" : "Function in the page";
  try {
    const group_ = [...worlds.values()].filter(w => w.group === group);
    let win = null;
    try {
      win = script.global.unsafeDereference();
    } catch {}
    for (const world of group_) {
      flagWritten(world);
    }
    const target = win ?? group_[0]?.win;
    if (target) {
      // Whichever world of the group compiled it: the one whose call runs
      // reports it, the others drop it at their next call's start.
      const text = markHooked(target, detail);
      for (const world of group_) {
        noteHooked(world, text);
      }
    }
  } catch (e) {
    console.error("[zenius] marking the agent's code in the page", e);
  }
}

function watchCompiles(group, win) {
  let hook = compileHooks.get(group);
  if (!hook) {
    hook = { dbg: newDebugger(), ids: new Set() };
    hook.dbg.onNewScript = script => onPageScript(group, script);
    compileHooks.set(group, hook);
  }
  const id = win?.windowGlobalChild?.innerWindowId;
  if (!id || hook.ids.has(id)) {
    return;
  }
  try {
    hook.dbg.addDebuggee(win);
    hook.ids.add(id);
  } catch (e) {
    console.error("[zenius] watching a page's compiles", e);
  }
}

function unwatchCompiles(group) {
  for (const world of worlds.values()) {
    if (world.group === group) {
      return;
    }
  }
  const hook = compileHooks.get(group);
  if (hook) {
    compileHooks.delete(group);
    try {
      hook.dbg.onNewScript = undefined;
      hook.dbg.removeAllDebuggees();
    } catch {}
  }
}

/**
 * A call into `world` begins, with `budgetMs` for its run, its code's
 * callbacks included, until it settles (0: none). `call.stopped` settles
 * with {terminated} if the hook stops the call's code at the deadline after
 * it went async, which the call can't see by itself.
 *
 * @returns {{deadline: number, stop: Function, stopped: Promise<{terminated: true}>}}
 */
export function beginCall(world, budgetMs) {
  let stop;
  const stopped = new Promise(resolve => (stop = resolve));
  const now = ChromeUtils.now();
  const call = { deadline: budgetMs > 0 ? now + budgetMs : Infinity, stop, stopped };
  // Calls the parent gave up on long ago, whose promise never settled.
  for (const old of world.calls) {
    if (old.deadline + 60000 < now) {
      world.calls.delete(old);
    }
  }
  world.calls.add(call);
  startTurn(world, now);
  world.turnCall = call;
  return call;
}

/** The call into `world` is over. */
export function endCall(world, call) {
  world.calls.delete(call);
}

// ---------------------------------------------------------------------------
// Loops

// A loop that calls no built-in never meets the hook, and nothing else can
// stop a sandbox's script: the parent's cancel and the slow-script watchdog
// look for a window's global. So each loop body
// in the agent's code gets a counter that calls a no-op built-in every 4096
// turns, and the hook ends the loop at its deadline like any other code. The
// engine's own parser finds the loops, so the rewrite matches what runs; a
// source it can't parse, or a long one, runs as it is.
const LOOP_KINDS = new Set(["WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"]);
const LOOP_CHECK = "if(!(++__zeniusLoops[0]&4095))__zeniusTick();";
const MAX_INSTRUMENTED = 256 * 1024;
const LOOP_KEYWORDS = { WhileStatement: "while", DoWhileStatement: "do", ForStatement: "for", ForInStatement: "for", ForOfStatement: "for" };
/**
 * source → its rewrite, the most recent ones up to REWRITES_CHARS: waitForFunction
 * runs one predicate many times, and a function's text is read back from here.
 */
const rewrites = new Map();
const REWRITES_CHARS = 8 * 1024 * 1024;
let rewritesChars = 0;
let reflectParse = null;

/**
 * `source` with the deadline's counter in each loop body, and the edits made,
 * by line and 0-based column of the original ({line, column, length}), for
 * remapPosition. The source as it is, with no edits, when it doesn't parse.
 *
 * @param {string} source
 * @returns {{source: string, edits: {line: number, column: number, length: number}[]}}
 */
export function instrumentLoops(source) {
  const known = rewrites.get(source);
  if (known) {
    rewrites.delete(source);
    rewrites.set(source, known);
    return known;
  }
  const made = rewriteLoops(source);
  rewrites.set(source, made);
  rewritesChars += source.length + made.source.length;
  while (rewritesChars > REWRITES_CHARS && rewrites.size > 1) {
    const [old, r] = rewrites.entries().next().value;
    rewrites.delete(old);
    rewritesChars -= old.length + r.source.length;
  }
  return made;
}

/**
 * The agent's own text of a function the rewrite changed: `text` is a piece
 * of a rewritten source, with the counters taken out. Unknown text comes
 * back as it is.
 */
function unrewrite(text) {
  for (const r of rewrites.values()) {
    if (!r.cuts?.length) {
      continue;
    }
    const start = r.source.indexOf(text);
    if (start < 0) {
      continue;
    }
    const end = start + text.length;
    let out = "";
    let at = start;
    for (const [cut, length] of r.cuts) {
      if (cut + length <= start || cut >= end) {
        continue;
      }
      out += r.source.slice(at, Math.max(at, cut));
      at = Math.max(at, cut + length);
    }
    return out + r.source.slice(at, end);
  }
  return text;
}

function rewriteLoops(source) {
  const none = { source, edits: [] };
  if (source.length > MAX_INSTRUMENTED || !/\b(for|while|do)\b/.test(source)) {
    return none;
  }
  let ast;
  try {
    reflectParse ??= ChromeUtils.importESModule("moz-src:///toolkit/components/reflect/reflect.sys.mjs").Reflect.parse;
    ast = reflectParse(source, { loc: true });
  } catch {
    return none;
  }
  // Lines as the engine counts them, for its 1-based line and column.
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 10 || c === 0x2028 || c === 0x2029 || (c === 13 && source.charCodeAt(i + 1) !== 10)) {
      starts.push(i + 1);
    }
  }
  const offset = p => (p && p.line >= 1 && p.line <= starts.length ? starts[p.line - 1] + p.column - 1 : -1);
  const inserts = [];
  let ok = true;
  const stack = [ast];
  while (stack.length && ok) {
    const node = stack.pop();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (LOOP_KINDS.has(node.type) && node.body?.loc) {
      const head = offset(node.loc?.start);
      const start = offset(node.body.loc.start);
      const end = offset(node.body.loc.end);
      if (!source.startsWith(LOOP_KEYWORDS[node.type], head) || start < 0 || end < start) {
        ok = false;
        break;
      }
      if (node.body.type === "BlockStatement") {
        if (source[start] !== "{") {
          ok = false;
          break;
        }
        inserts.push([start + 1, LOOP_CHECK]);
      } else {
        inserts.push([start, "{" + LOOP_CHECK], [end, "}"]);
      }
    }
    for (const key in node) {
      if (key !== "loc" && key !== "type") {
        const value = node[key];
        if (value && typeof value === "object") {
          stack.push(value);
        }
      }
    }
  }
  if (!ok || !inserts.length) {
    return none;
  }
  // Stable: two closings at one place stay as pushed.
  inserts.sort((a, b) => a[0] - b[0]);
  let out = "";
  let last = 0;
  for (const [at, text] of inserts) {
    out += source.slice(last, at) + text;
    last = at;
  }
  out += source.slice(last);
  try {
    reflectParse(out);
  } catch {
    return none;
  }
  const edits = inserts.map(([at, text]) => {
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= at) {
      line++;
    }
    return { line: line + 1, column: at - starts[line], length: text.length };
  });
  // Where each insert sits in the rewritten source, for unrewrite.
  let shift = 0;
  const cuts = inserts.map(([at, text]) => {
    const cut = [at + shift, text.length];
    shift += text.length;
    return cut;
  });
  return { source: out, edits, cuts };
}

/**
 * A 1-based column of the rewritten source, on `line`, as the agent's own
 * source has it: the counter's text comes out. Lines don't change.
 */
export function remapPosition(edits, line, column) {
  if (!edits?.length) {
    return column;
  }
  const c = column - 1;
  let shift = 0;
  for (const e of edits) {
    if (e.line !== line) {
      continue;
    }
    const start = e.column + shift;
    if (c >= start + e.length) {
      shift += e.length;
    } else if (c >= start) {
      return e.column + 1;
    } else {
      break;
    }
  }
  return c - shift + 1;
}

/**
 * The agent's world for the document in `win`, made at the first call and
 * kept across calls until the document is hidden or a discard.
 *
 * @param {Window} win  the document's window (an Xray, as actors see it)
 */
export function worldFor(win) {
  const id = win.windowGlobalChild?.innerWindowId;
  const known = worlds.get(id);
  if (known && !Cu.isDeadWrapper(known.sandbox)) {
    return known;
  }
  referenceTables(win);
  const sandbox = Cu.Sandbox(win, {
    sandboxPrototype: win,
    wantXrays: true,
    allowWaivers: false,
    sameZoneAs: win,
    wantComponents: false,
    wantExportHelpers: false,
    sandboxName: "zenius agent world",
  });
  const dbg = newDebugger();
  const dS = dbg.addDebuggee(sandbox);
  const world = {
    id,
    win,
    bc: win.browsingContext,
    sandbox,
    dbg,
    dS,
    group: win.browsingContext.group.id,
    browserId: win.browsingContext.top.browserId,
    report: { missed: [], hooked: [] },
    // Debugger.Object → its kind (SAFE, WRITE, …), and our wrappers.
    kinds: new WeakMap(),
    ours: new WeakSet(),
    // zenius's own steps in the world: how many run now, and the functions
    // they run there (ownStep).
    ownSteps: 0,
    steps: new WeakSet(),
    // Tests only: the hook ends zenius's own steps too, as before they were
    // exempt (zenius.test.cutOwnSteps), to show what a cut can cost.
    cutOwnSteps: Services.prefs.getBoolPref("zenius.test.cutOwnSteps", false),
    // innerWindowId → how many of its method shims this world has (adopt).
    adopted: new Map(),
    // Our constructors, made once from this document's guards (adopt).
    ctors: new Map(),
    // The calls running in the world, each with its deadline (beginCall).
    calls: new Set(),
    writes: [],
    // When the world's code started running in this turn of the event loop.
    turnStart: 0,
    // The call whose own run this turn is: its deadline, not the idle limit, bounds the turn.
    turnCall: null,
    // When the world last asked the parent whether it may go on (stopAsked).
    controlCheckedAt: 0,
    endTurn: () => {
      world.turnStart = 0;
      world.turnCall = null;
    },
    flaggedEpoch: -1,
    settingUp: true,
    // Hooked: the watch of its writes ({mo, on}), the kind of the last
    // built-in, the frame whose pop ends the run, and whether its code
    // reached into a shadow tree.
    watch: null,
    lastKind: SAFE,
    runFrame: null,
    shadowSeen: false,
  };
  const exported = (fn, kind = SAFE) => {
    const f = Cu.exportFunction(fn, sandbox);
    world.kinds.set(dS.makeDebuggeeValue(f), kind);
    return f;
  };
  world.exported = exported;
  const waived = Cu.waiveXrays(win);
  const pageOnly = exported(name => {
    try {
      return Object.prototype.hasOwnProperty.call(waived, String(name));
    } catch {
      return false;
    }
  });
  const missed = exported(name => void world.report.missed.push(String(name)));
  const hooked = exported(detail => leftCode(world, String(detail)));
  const isJavaScriptURL = exported(s => {
    try {
      return new URL(String(s), "http://zenius.invalid/").protocol === "javascript:";
    } catch {
      return false;
    }
  });
  const wrote = exported(() => flagWritten(world));
  // A built-in that does nothing: the hook, at its call, checks the deadline.
  const tick = exported(() => {});
  const unrewriteText = exported(text => unrewrite(String(text)));
  const api = Cu.waiveXrays(
    Cu.evalInSandbox(SETUP, sandbox, "latest", WORLD_URL + "/setup", 1)(pageOnly, missed, hooked, win, isJavaScriptURL, wrote, tick, unrewriteText)
  );
  for (let i = 0; i < api.ours.length; i++) {
    world.ours.add(dS.makeDebuggeeValue(api.ours[i]));
  }
  // Only chrome holds the adopter: the agent's code can't reach its functions.
  for (const key of Object.keys(api.adopter)) {
    world.steps.add(dS.makeDebuggeeValue(api.adopter[key]));
  }
  world.takeWorkers = api.takeWorkers;
  world.track = api.track;
  world.adopter = api.adopter;
  dbg.onNativeCall = (callee, reason) => onNative(world, callee, reason);
  // Before the world is held: a setup that throws below still leaves it
  // with the observer that ends it with its document.
  watchDestroyed();
  worlds.set(id, world);
  try {
    asOwnStep(world, () => buildConstructors(world, win));
    // Our guards, as the page's world has them: in the world's view of its
    // own window and of every other window of its group it can reach.
    for (const other of windowsOfGroup(win.browsingContext)) {
      adopt(world, other);
      watchCompiles(world.group, other);
    }
  } finally {
    world.settingUp = false;
  }
  // A navigation hides the document: its world goes, so nothing of the
  // agent's comes back with it from the back-forward cache.
  win.addEventListener("pagehide", () => discardWorld(id, world), { mozSystemGroup: true, once: true });
  return world;
}

/**
 * What the world's code met since the last take: {missed: [names], hooked:
 * [what it left in a document that wasn't hooked before]}.
 */
export function takeReport(world) {
  const report = world.report;
  world.report = { missed: [], hooked: [] };
  return report;
}

/** Documents this process saw written, before the parent's copy arrives. */
const writtenHere = new Set();

function markWritten(id) {
  watchDestroyed();
  writtenHere.add(id);
}

/**
 * Our page-world shims of each document (innerWindowId): {methods: [{path,
 * name, fn, getter?, wrap?}], ctors: [{name, trap}]}. A world reaches
 * the document through Xrays, which show only the natives, so each world
 * that can reach it gets the same shims in its own view of the document's
 * window (adopt).
 */
const mirrors = new Map();

function mirrorsOf(win) {
  const id = win?.windowGlobalChild?.innerWindowId;
  if (!id) {
    return null;
  }
  watchDestroyed();
  let table = mirrors.get(id);
  if (!table) {
    mirrors.set(id, (table = { methods: [], ctors: [] }));
  }
  return table;
}

/**
 * A shim the page's world got with Cu.exportFunction(fn, <path>, {defineAs:
 * name}); the agent's worlds get `fn` at the same place. `path` is
 * "Element.prototype", or "" for the window itself.
 */
export function mirrorMethod(win, path, name, fn) {
  mirror(win, { path, name, fn });
}

/**
 * A getter the page's world got at `<path>[name]` (a guard's): the agent's
 * worlds get `fn` there as the getter, as mirrorMethod does a method.
 */
export function mirrorGetter(win, path, name, fn) {
  mirror(win, { path, name, fn, getter: true });
}

/**
 * A getter a guard made in chrome over the native at `<path>[name]`: the
 * agent's worlds each get a Proxy over their own native getter there, with
 * `apply(target, self, args)` as its trap. The native the trap calls then
 * runs in the world's realm, so its errors are the world's own (callerIn).
 */
export function mirrorGetterTrap(win, path, name, apply) {
  mirror(win, { path, name, fn: apply, getter: true, wrap: true });
}

function mirror(win, entry) {
  const table = mirrorsOf(win);
  if (!table) {
    return;
  }
  table.methods.push(entry);
  // A guard that installs after the document joined a world (another
  // actor's, on the same DOMWindowCreated) still reaches that world.
  const id = win.windowGlobalChild.innerWindowId;
  for (const world of worlds.values()) {
    if (world.adopted.has(id)) {
      adopt(world, win);
    }
  }
}

/**
 * The sandbox of the agent's world `value` belongs to, or null: a guard
 * that answers the world's call makes what it hands back there, so the
 * world sees it through its own Xrays, never as a page object.
 *
 * @param {*} value  an object or function the caller passed
 */
export function worldSandboxOf(value) {
  if (!worlds.size || value === null || (typeof value !== "object" && typeof value !== "function")) {
    return null;
  }
  let global = null;
  try {
    global = Cu.getGlobalForObject(value);
  } catch {
    return null;
  }
  for (const world of worlds.values()) {
    if (world.sandbox === global) {
      return world.sandbox;
    }
  }
  return null;
}

/**
 * A constructor the worlds refuse, with `refuse` as its construct trap: one
 * whose page guard failed and refuses in the page instead
 * (content/refusals.sys.mjs, failClosed), or Notification, which the agent's
 * own code never gets to make. The worlds get one that refuses, made in
 * chrome from each world's own Proxy, with no script (guardedIn), over the
 * one they'd have had. `refuse(caller)` throws, and gets the world's own
 * built-ins (callerIn) to make its error with.
 */
export function mirrorRefusal(win, name, refuse) {
  mirrorsOf(win)?.ctors.push({ name, trap: (target, args, newTarget, caller) => refuse(caller) });
}

/**
 * A constructor guard made in chrome (content/refusals.sys.mjs, wrapInPage):
 * the worlds get one made the same way over theirs (guardedIn), with `trap`
 * as its construct trap.
 */
export function mirrorTrap(win, name, trap) {
  mirrorsOf(win)?.ctors.push({ name, trap });
}

/**
 * What a guard's trap makes in the world's realm, with the world's own
 * built-ins, taken before any of the agent's code runs: `TypeError`, and
 * `construct(target, list, newTarget)`, which calls the native from the
 * world's realm, as the agent's own `new` would. An error made elsewhere
 * reaches the world badly: one made in the page's realm through an Xray
 * that can't read its message, and one made in chrome (a native that
 * chrome calls makes its errors there) as an InvalidStateError.
 */
function callerIn(world) {
  const realm = Cu.waiveXrays(world.sandbox);
  const construct = realm.Reflect.construct;
  const WorldArray = realm.Array;
  return {
    TypeError: realm.TypeError,
    construct(target, list, newTarget) {
      // The list in the world's realm, by own properties: none of the
      // world's setters or iterators runs.
      const own = new WorldArray();
      for (let i = 0; i < list.length; i++) {
        Object.defineProperty(own, i, { value: list[i], writable: true, enumerable: true, configurable: true });
      }
      return construct(target, own, newTarget);
    },
  };
}

/**
 * The world's guarded `name` (mirrorTrap, mirrorRefusal): a Proxy made in
 * chrome from the world's own Proxy and Object, taken before any of the
 * agent's code runs, over the one the world has, with no script. Its
 * prototype's constructor is the Proxy too. `trap(target, args, newTarget,
 * caller)` gets the arguments waived, the target as newTarget when the world
 * constructs the Proxy itself, and `caller`, the world's own (callerIn).
 */
function guardedIn(world, win, name, trap) {
  const Native = world.ctors.get(name) ?? world.adopter.native(win, name);
  if (typeof Native !== "function") {
    return null;
  }
  const realm = Cu.waiveXrays(world.sandbox);
  const caller = world.caller;
  const handler = realm.Object.create(null);
  let made = null;
  handler.construct = world.exported((target, args, newTarget) => {
    const nt = Cu.waiveXrays(newTarget);
    return trap(target, Cu.waiveXrays(args), nt === made ? target : newTarget, caller);
  });
  made = Cu.waiveXrays(new realm.Proxy(Native, handler));
  const proto = realm.Reflect.get(Native, "prototype");
  if (proto) {
    const desc = realm.Object.create(null);
    desc.value = made;
    desc.writable = true;
    desc.configurable = true;
    realm.Reflect.defineProperty(proto, "constructor", desc);
  }
  return made;
}

/**
 * The world's constructors, made once, from its own document's guards and
 * before any of the agent's code runs: every window it reaches gets these,
 * so a window that comes later can't be handed one made from built-ins the
 * agent's code changed. Worker and SharedWorker also record what they start.
 */
function buildConstructors(world, win) {
  world.caller = callerIn(world);
  const table = mirrors.get(world.id);
  for (const { name, trap } of table?.ctors ?? []) {
    try {
      const made = guardedIn(world, win, name, trap);
      if (made) {
        world.ctors.set(name, made);
      }
    } catch (e) {
      console.error(`[zenius] the agent's world didn't get ${name}`, e);
    }
  }
  for (const name of ["Worker", "SharedWorker"]) {
    const base = world.ctors.get(name) ?? world.adopter.native(win, name);
    if (typeof base === "function") {
      world.ctors.set(name, world.track(base, name));
    }
  }
}

/** The shims of `win`'s document that `world` hasn't got yet, in its view of `win`. */
function adopt(world, win) {
  asOwnStep(world, () => adoptNow(world, win));
}

/** adopt's work, run as zenius's own step (asOwnStep). */
function adoptNow(world, win) {
  const id = win?.windowGlobalChild?.innerWindowId;
  if (!id) {
    return;
  }
  const own = id === world.id;
  let done = world.adopted.get(id);
  if (!done) {
    done = { methods: 0 };
    world.adopted.set(id, done);
    try {
      world.adopter.dataset(win);
    } catch (e) {
      console.error("[zenius] the agent's world didn't get its dataset", e);
    }
    for (const [name, value] of world.ctors) {
      try {
        world.adopter.ctor(win, own, name, value);
      } catch (e) {
        console.error(`[zenius] the agent's world didn't get ${name}`, e);
      }
    }
  }
  const table = mirrors.get(id);
  for (; table && done.methods < table.methods.length; done.methods++) {
    const { path, name, fn, getter, wrap } = table.methods[done.methods];
    try {
      const parts = Cu.cloneInto(path ? path.split(".") : [], world.sandbox);
      if (getter) {
        world.adopter.getter(win, parts, name, world.exported(fn), !!wrap);
        continue;
      }
      world.adopter.method(win, own, parts, name, world.exported(fn, MIRROR_KINDS[`${path}.${name}`] ?? SAFE));
    } catch (e) {
      console.error(`[zenius] the agent's world didn't get ${path || "window"}.${name}`, e);
    }
  }
}

/** The same-process windows of `bc`'s BrowsingContextGroup. */
function windowsOfGroup(bc) {
  const wins = [];
  try {
    for (const top of bc.group.getToplevels()) {
      for (const each of top.getAllBrowsingContextsInSubtree()) {
        // Only this process's documents: another process's window is a
        // remote proxy here, and the world can't reach into it anyway.
        const w = each.docShell?.domWindow;
        if (w) {
          wins.push(w);
        }
      }
    }
  } catch {}
  return wins;
}

/**
 * `win`'s document just got its shims (content/refusals.sys.mjs, at
 * DOMWindowCreated): every world of its group in this process gets them too,
 * before any of their code can reach the new document. A new document
 * beside a written one of its group is flagged written here too
 * (flagIfExposed), worlds or not.
 */
export function adoptIntoWorlds(win) {
  flagIfExposed(win);
  if (!worlds.size) {
    return;
  }
  let group;
  try {
    group = win.browsingContext.group.id;
  } catch {
    return;
  }
  docEpoch++;
  for (const world of worlds.values()) {
    if (world.group === group) {
      adopt(world, win);
      watchCompiles(group, win);
    }
  }
}

/** A BrowsingContext for a Window, a BrowsingContext, or a JSWindowActorChild. */
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

/** The current documents (innerWindowId) of the tab `bc` is in, its frames' too. */
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

/** Forget one world and end everything of it. */
function discardWorld(id, world) {
  if (worlds.get(id) !== world) {
    return;
  }
  worlds.delete(id);
  try {
    world.watch?.mo.disconnect();
  } catch {}
  try {
    world.dbg.onNativeCall = undefined;
    world.dbg.removeAllDebuggees();
  } catch {}
  // The workers it started end with it: a dedicated worker is terminated, a
  // shared one loses the world's port. Read through chrome's own Xrays, so
  // nothing the agent's code changed in its world stands in the way.
  try {
    const list = Cu.waiveXrays(world.takeWorkers());
    for (let i = 0; i < list.length; i++) {
      const [kind, w] = [list[i][0], Cu.unwaiveXrays(list[i][1])];
      try {
        if (kind === "Worker") {
          w.terminate();
        } else {
          w.port.close();
        }
      } catch {}
    }
  } catch (e) {
    console.error("[zenius] ending the agent's workers", e);
  }
  try {
    Cu.nukeSandbox(world.sandbox);
  } catch (e) {
    console.error("[zenius] discarding the agent's world", e);
  }
  unwatchCompiles(world.group);
  unwatchDestroyedIfIdle();
}

/**
 * Discard the agent's worlds that could reach `target`'s page through an
 * Xray: every world of its BrowsingContextGroup in this process. The input layer's
 * guard calls it at Take over, at the user's first key or press, before any
 * page listener; the parent's discard calls it in each process of the group.
 * Synchronous, cheap when there's nothing to discard, safe at any time.
 *
 * @param {Window|BrowsingContext|JSWindowActorChild} target
 * @param {{group?: number}} [args]  the parent's call names the group
 * @returns {number} how many worlds went
 */
export function discard(target, args = {}) {
  const group = typeof args?.group === "number" ? args.group : contextOf(target)?.group?.id;
  if (group === undefined || !worlds.size) {
    return 0;
  }
  let count = 0;
  for (const [id, world] of [...worlds]) {
    if (world.group === group) {
      discardWorld(id, world);
      count++;
    }
  }
  return count;
}

/**
 * Tests: `expr` evaluated in the agent's world of the actor's document, as
 * JSON, or `{none: true}` when the document has no world. It never makes
 * one, so a test reads what the agent's code left (its `window.__x`) as it
 * is, also while the agent may not call.
 *
 * @param {JSWindowActorChild} actor
 * @param {{expr: string}} args
 */
export function peek(actor, { expr } = {}) {
  const world = worlds.get(actor?.manager?.innerWindowId);
  if (!world) {
    return { none: true };
  }
  const text = Cu.evalInSandbox(`JSON.stringify(${String(expr)})`, world.sandbox, null, `${WORLD_URL}/setup`, 1);
  return { value: text === undefined ? undefined : JSON.parse(text) };
}

/** Tests: what this process holds of the agent's, and whether it watches documents go. */
export function held() {
  return { watching: watchingDestroyed, worlds: worlds.size, hooks: compileHooks.size, mirrors: mirrors.size, urls: urls.size, written: writtenHere.size };
}

/**
 * Does the page `target` is in hold writes the agent's world made: its
 * current top document, or any of its frames'? Synchronous; other
 * processes' documents come from the parent's sharedData copy.
 *
 * @param {Window|BrowsingContext} target
 */
export function isWritten(target) {
  const bc = contextOf(target);
  if (!bc) {
    return false;
  }
  const shared = Services.cpmm.sharedData.get(WRITTEN_DOCS_KEY);
  return documentsOfTab(bc).some(id => writtenHere.has(id) || !!shared?.has?.(id));
}

/**
 * The input layer's flag for the page `target` is in: "drop" when its top
 * document is one the agent made, "clean" when it's written, else null.
 * Kept pages after the task included.
 *
 * @param {Window|BrowsingContext} target
 * @returns {"drop"|"clean"|null}
 */
export function pageFlag(target) {
  const bc = contextOf(target);
  if (!bc) {
    return null;
  }
  try {
    const top = bc.top.currentWindowContext?.innerWindowId;
    if (top && Services.cpmm.sharedData.get(MADE_DOCS_KEY)?.has?.(top)) {
      return "drop";
    }
  } catch {}
  return isWritten(bc) ? "clean" : null;
}
