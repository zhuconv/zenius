// Child half of the "ZeniusClipboard" actor (the UI). In a tab the agent
// drives, the page's own clipboard calls never reach the system clipboard,
// which is the user's. The parent decides whether a call belongs to the
// agent (the Space's clipboard) or to the user using the agent's page (their
// clipboard, as usual); see ZeniusClipboardParent.
//
// - Copy and cut events (execCommand("copy"), a page's copy handler): one
//   listener per tab and process, in the system group of the tab's chrome
//   event handler, so it runs after every page listener. It takes what Gecko
//   would write (the page's clipboardData if the page cancelled the event,
//   else the selection), empties and cancels the event so Gecko writes
//   nothing, deletes a cut's selection, and sends the content to the parent.
//   The input layer's interceptCopyCut, which the agent's chords install while
//   they run, catches its events in the capture phase of the same group and
//   empties them, so this listener then sees a cancelled, empty event and
//   leaves it alone. This guard doesn't install through interceptCopyCut:
//   that cancels every copy of the tab while installed, and a tab the user
//   took over, or a finished Space's, must copy natively again.
// - navigator.clipboard.writeText(), write(), readText() and read(): wrapped
//   in each document before the page's scripts run. They ask the parent
//   first, then either use the Space's clipboard or call the native method
//   (for the user: images and every other type keep working).
//
// The guards install in every document of an agent task's tabs, also one the
// user loads while holding the task, and every check runs per call: a tab
// handed to the user behaves natively, and the guard is there again when the
// user hands it back.
//
// The core's Zenius actor makes this one only in a task's documents, at its
// DOMWindowCreated, and calls installGuards(). Its helpers load on first use,
// so nothing of the UI loads in a user's tab (the core's I4).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  deleteSelection: "chrome://userscripts/content/zenius/content/input.sys.mjs",
  fromClipData: "chrome://userscripts/content/zenius/content/input.sys.mjs",
  isAgentDriven: "chrome://userscripts/content/zenius/content/taskset.sys.mjs",
  isAgentTaskPage: "chrome://userscripts/content/zenius/content/taskset.sys.mjs",
  pageError: "chrome://userscripts/content/zenius/ui/pagecall.sys.mjs",
  processTopWindow: "chrome://userscripts/content/zenius/content/input.sys.mjs",
  selectionContent: "chrome://userscripts/content/zenius/content/input.sys.mjs",
  settle: "chrome://userscripts/content/zenius/ui/pagecall.sys.mjs",
  toClipData: "chrome://userscripts/content/zenius/content/input.sys.mjs",
  // The agent's world (the observe layer) sees the page through Xrays, which show
  // only the native methods: it gets these wrappers too. Loaded with a
  // task's first guarded document (I4).
  mirrorMethod: "chrome://userscripts/content/zenius/content/agentworld.sys.mjs",
});

const ACTOR = "ZeniusClipboard";
/** The chrome event handlers (one per tab and process) already watched. */
const watched = new WeakSet();
/** Documents whose clipboard calls are guarded, so each gets it once. */
const guarded = new WeakSet();

export class ZeniusClipboardChild extends JSWindowActorChild {
  /**
   * Guard this document if it's a task's: from the Zenius actor's
   * DOMWindowCreated, and for the documents a tab already had when it
   * became a task's page (an adopted tab, a task claimed again after a
   * Stop; the core's ZeniusService.installGuards).
   * @returns {boolean} whether the guard went in now
   */
  installGuards() {
    return lazy.isAgentTaskPage(this.browsingContext) && this.#guard();
  }

  receiveMessage(msg) {
    return msg.name === "installGuards" && this.installGuards();
  }

  /** @returns {boolean} whether the guard went in now */
  #guard() {
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc || guarded.has(doc)) {
      return false;
    }
    guarded.add(doc);
    try {
      watchCopyCut(win);
      guardClipboardApi(win);
    } catch (e) {
      console.error("[zenius] clipboard guard failed", e);
    }
    return true;
  }
}

/** @param {Window} win */
function actorOf(win) {
  return win.windowGlobalChild?.getActor(ACTOR) ?? null;
}

// ---------------------------------------------------------------- copy and cut

/** @param {Window} win */
function watchCopyCut(win) {
  const root = lazy.processTopWindow(win).docShell?.chromeEventHandler;
  if (!root || watched.has(root)) {
    return;
  }
  watched.add(root);
  root.addEventListener("copy", onCopyCut, { mozSystemGroup: true });
  root.addEventListener("cut", onCopyCut, { mozSystemGroup: true });
}

/** @param {ClipboardEvent} e */
function onCopyCut(e) {
  if (!e.isTrusted) {
    return;
  }
  const at = Date.now();
  const target = e.composedTarget ?? e.target;
  const doc = target?.ownerDocument ?? target;
  const win = doc?.defaultView;
  if (!win || !lazy.isAgentDriven(win.browsingContext)) {
    return;
  }
  const prevented = e.defaultPrevented;
  let data = null;
  try {
    if (prevented) {
      // Gecko writes a cancelled event's clipboardData, if it holds any.
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const html = e.clipboardData?.getData("text/html") || null;
      data = text || html ? lazy.toClipData({ text, html }) : null;
    } else {
      const sel = lazy.selectionContent(doc);
      data = sel.text || sel.html ? lazy.toClipData(sel) : null;
    }
  } finally {
    // A cancelled event with an empty DataTransfer leaves Gecko nothing to
    // write.
    try {
      e.clipboardData?.clearData();
    } catch {}
    e.preventDefault();
  }
  if (!data) {
    return;
  }
  // Gecko skips the deletion of a cancelled cut; the page didn't cancel it.
  if (e.type === "cut" && !prevented) {
    lazy.deleteSelection(doc);
  }
  try {
    actorOf(win)?.sendAsyncMessage("clip", { op: e.type, data, at });
  } catch {
    // The document is going away.
  }
}

// ---------------------------------------------------------------- navigator.clipboard

/** @param {Window} win */
function guardClipboardApi(win) {
  const proto = Cu.waiveXrays(win).Clipboard?.prototype;
  if (!proto) {
    // No async clipboard here (an insecure context).
    return;
  }
  const bc = win.browsingContext;
  const native = {
    writeText: proto.writeText,
    write: proto.write,
    readText: proto.readText,
    read: proto.read,
  };
  const nativeCall = (name, self, args) => Reflect.apply(native[name], Cu.waiveXrays(self), args);

  function writeText(data) {
    const args = Array.from(arguments);
    if (!lazy.isAgentDriven(bc)) {
      return nativeCall("writeText", this, args);
    }
    const self = this;
    const at = Date.now();
    return lazy.settle(win, async () => {
      if (!args.length) {
        throw lazy.pageError(win, "TypeError", "Clipboard.writeText: At least 1 argument required, but only 0 passed");
      }
      requireActivation(win);
      const text = typeof data === "string" ? data : String(Cu.waiveXrays(data));
      const r = await actorOf(win).sendQuery("write", { data: lazy.toClipData({ text }), at });
      if (r?.route === "refused") {
        throw writeRefused(win);
      }
      return r?.route === "user" ? nativeCall("writeText", self, args) : undefined;
    });
  }

  function write(data) {
    const args = Array.from(arguments);
    if (!lazy.isAgentDriven(bc)) {
      return nativeCall("write", this, args);
    }
    const self = this;
    const at = Date.now();
    return lazy.settle(win, async () => {
      if (!args.length) {
        throw lazy.pageError(win, "TypeError", "Clipboard.write: At least 1 argument required, but only 0 passed");
      }
      requireActivation(win);
      const r = await actorOf(win).sendQuery("write", { data: await textOf(data), at });
      if (r?.route === "refused") {
        throw writeRefused(win);
      }
      return r?.route === "user" ? nativeCall("write", self, args) : undefined;
    });
  }

  function readText() {
    const args = Array.from(arguments);
    if (!lazy.isAgentDriven(bc)) {
      return nativeCall("readText", this, args);
    }
    const self = this;
    const at = Date.now();
    return lazy.settle(win, async () => {
      requireActivation(win);
      const r = await actorOf(win).sendQuery("read", { at });
      if (r?.route === "refused") {
        throw readRefused(win);
      }
      return r?.route === "user" ? nativeCall("readText", self, args) : lazy.fromClipData(r?.data).text;
    });
  }

  function read() {
    const args = Array.from(arguments);
    if (!lazy.isAgentDriven(bc)) {
      return nativeCall("read", this, args);
    }
    const self = this;
    const at = Date.now();
    return lazy.settle(win, async () => {
      requireActivation(win);
      const r = await actorOf(win).sendQuery("read", { at });
      if (r?.route === "refused") {
        throw readRefused(win);
      }
      return r?.route === "user" ? nativeCall("read", self, args) : clipboardItems(win, r?.data);
    });
  }

  for (const fn of [writeText, write, readText, read]) {
    const desc = Object.getOwnPropertyDescriptor(proto, fn.name);
    if (typeof desc?.value !== "function") {
      continue;
    }
    // The native method's own flags; exported functions read as native code.
    Object.defineProperty(proto, fn.name, {
      value: Cu.exportFunction(fn, win),
      writable: desc.writable,
      enumerable: desc.enumerable,
      configurable: desc.configurable,
    });
    lazy.mirrorMethod(win, "Clipboard.prototype", fn.name, fn);
  }
}

/**
 * Another site wrote the Space's clipboard: the page sees what a dismissed
 * paste prompt gives it, in Gecko's words.
 */
function readRefused(win) {
  return lazy.pageError(win, "NotAllowedError", "Clipboard read operation is not allowed.");
}

/** More text than the Space's clipboard takes (4 Mi UTF-16 units a type). */
function writeRefused(win) {
  return lazy.pageError(win, "NotAllowedError", "Clipboard write is not allowed.");
}

/** Like the native methods, clipboard access needs a recent user gesture. */
function requireActivation(win) {
  const ua = win.navigator.userActivation;
  if (!(ua ? ua.isActive : win.document.hasValidTransientUserGestureActivation)) {
    throw lazy.pageError(win, "NotAllowedError", "Clipboard access is only allowed in response to a user gesture.");
  }
}

/**
 * The text of the first ClipboardItem as ClipData, read through Xrays so the
 * page's own overrides don't run. Other types (images) aren't kept: the
 * Space's clipboard then holds nothing.
 *
 * @returns {Promise<object|null>}
 */
async function textOf(items) {
  const item = items?.[0];
  if (!item || typeof item.getType !== "function") {
    return null;
  }
  const types = Array.from(item.types ?? []);
  const read = async type => (types.includes(type) ? (await item.getType(type)).text() : null);
  const text = await read("text/plain");
  const html = await read("text/html");
  return text === null && html === null ? null : lazy.toClipData({ text: text ?? "", html });
}

/** The Space's clipboard as navigator.clipboard.read() returns it. */
function clipboardItems(win, clip) {
  if (!clip) {
    return Cu.cloneInto([], win);
  }
  const data = lazy.fromClipData(clip);
  const parts = { "text/plain": new win.Blob([data.text], { type: "text/plain" }) };
  if (data.html != null) {
    parts["text/html"] = new win.Blob([data.html], { type: "text/html" });
  }
  const item = new win.ClipboardItem(Cu.cloneInto(parts, win, { wrapReflectors: true }));
  return Cu.cloneInto([item], win, { wrapReflectors: true });
}
