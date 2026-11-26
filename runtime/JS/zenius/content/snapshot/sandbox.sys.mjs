// One sandbox per document for the snapshot layer's content scripts. Each
// sandbox has the page's principal, so
// it reads the DOM without Xrays, and its own copies of the core DOM
// prototypes, which the walker calls as primordials. Page script can't see
// the sandbox's globals, and the scripts never hand it an object of theirs
// (dom.js): the sandbox shares the page's compartment, so one such object
// would give a page the sandbox's global.
// The global holds no chrome function either: the walker gets its helpers
// per capture (index.sys.mjs), aria.js its password check while it loads.
//
// Scripts (dom.js, aria.js, locators.js, walker.js) load into a sandbox on first
// use and stay for the document's lifetime, with the state they keep (the
// walker's ref tables). The sandbox goes away with its inner window. Each
// process compiles them once (precompile()); a new document's sandbox then
// only runs them, 2-3 ms instead of 16-21 (a page with 27 same-site frames
// paid 300 ms on its first snapshot).

const BASE = "chrome://userscripts/content/zenius/content/snapshot/";

/** Script name → what it needs loaded before it. */
const SCRIPTS = {
  dom: [],
  aria: ["dom"],
  locators: ["dom", "aria"],
  walker: ["dom", "aria", "locators"],
};

/** @type {Map<number, {innerWindowId: number, sandbox: object, loaded: Set<string>}>} */
const sandboxes = new Map();

/** Script name → its compiled form, once compiled in this process. */
const compiled = new Map();
/** Script name → the compile in progress or done. */
const compiling = new Map();

/**
 * Compiles the scripts once per process. Callers await it before load(),
 * which falls back to loading from source while a compile is pending or
 * failed.
 */
export function precompile() {
  return Promise.all(
    Object.keys(SCRIPTS).map(name => {
      let pending = compiling.get(name);
      if (!pending) {
        pending = ChromeUtils.compileScript(`${BASE}${name}.js`).then(
          script => compiled.set(name, script),
          () => {}
        );
        compiling.set(name, pending);
      }
      return pending;
    })
  );
}

let observing = false;
function observeWindowDestruction() {
  if (observing) {
    return;
  }
  observing = true;
  Services.obs.addObserver(subject => {
    const id = subject.QueryInterface(Ci.nsISupportsPRUint64).data;
    const entry = sandboxes.get(id);
    if (entry) {
      sandboxes.delete(id);
      try {
        Cu.nukeSandbox(entry.sandbox);
      } catch {}
    }
  }, "inner-window-destroyed");
}

/**
 * Whether an input is or was a password field (a show-password toggle makes
 * it type=text; hasBeenTypePassword is chrome-only). Read through Xrays, so
 * page script can't change the answer. aria.js's isSecretField keeps such a
 * field's value out of snapshots and names.
 */
function passwordInput(el) {
  try {
    return el.localName === "input" && (el.type === "password" || el.hasBeenTypePassword === true);
  } catch {
    return false;
  }
}

/**
 * The sandbox entry for a content window, created on first use.
 *
 * @param {Window} win the content window, as chrome code sees it
 */
export function sandboxFor(win) {
  const innerWindowId = win.windowGlobalChild.innerWindowId;
  let entry = sandboxes.get(innerWindowId);
  if (!entry) {
    observeWindowDestruction();
    const sandbox = Cu.Sandbox(win, {
      sandboxPrototype: win,
      sameZoneAs: win,
      wantXrays: false,
      // Never "Window": reading Window.prototype members crashes Gecko 160's
      // content process.
      wantGlobalProperties: ["Element", "Node", "Document", "NodeFilter", "Range", "CSS", "URL"],
      sandboxName: "zenius snapshot",
    });
    entry = { innerWindowId, sandbox, loaded: new Set() };
    sandboxes.set(innerWindowId, entry);
  }
  return entry;
}

/**
 * Local ids for nodes the page-principal sandbox can't hold: the fields of a
 * date or time input's datetimebox, which live in a UA widget's scope. The
 * chrome side keeps them per document, with ids from here up, past any the
 * walker hands out; resolveRef (registry.sys.mjs) looks them up here.
 */
export const UA_LOCAL_ID_BASE = 2 ** 30;

/** The local id of a UA widget node in this document, the same each time. */
export function uaLocalId(entry, node) {
  entry.uaIds ??= new WeakMap();
  entry.uaNodes ??= new Map();
  let id = entry.uaIds.get(node);
  if (id === undefined) {
    id = UA_LOCAL_ID_BASE + entry.uaNodes.size;
    entry.uaIds.set(node, id);
    entry.uaNodes.set(id, new WeakRef(node));
  }
  return id;
}

/** The UA widget node with that local id, or null once it's gone. */
export function uaNode(entry, id) {
  const node = entry.uaNodes?.get(id)?.deref();
  return node?.isConnected ? node : null;
}

/** The sandbox entry for an inner window id, or null once it's gone. */
export function sandboxById(innerWindowId) {
  return sandboxes.get(innerWindowId) ?? null;
}

/**
 * Loads a script (and what it needs) into the sandbox once, and returns the
 * sandbox's global with Xrays waived, so callers see what the scripts
 * defined. Unwaive what comes back before handing DOM nodes to others.
 */
export function load(entry, name) {
  if (!entry.loaded.has(name)) {
    for (const dependency of SCRIPTS[name]) {
      load(entry, dependency);
    }
    const script = compiled.get(name);
    // aria.js takes the password check as it loads, and the global keeps no
    // chrome function a page could call.
    if (name === "aria") {
      Cu.exportFunction(passwordInput, entry.sandbox, { defineAs: "__zsPasswordInput" });
    }
    try {
      if (script) {
        script.executeInGlobal(entry.sandbox);
      } else {
        Services.scriptloader.loadSubScript(`${BASE}${name}.js`, entry.sandbox);
      }
    } finally {
      if (name === "aria") {
        delete Cu.waiveXrays(entry.sandbox).__zsPasswordInput;
      }
    }
    entry.loaded.add(name);
  }
  return Cu.waiveXrays(entry.sandbox);
}
