// File choosers in agent tabs (zen-input).
//
// A page's <input type=file> asks the parent process for an nsIFilePicker.
// We register a wrapper factory for "@mozilla.org/filepicker;1": a picker for
// a tab the agent drives never shows a native dialog (it would open over the
// user's screen). It goes to a waiter (page.waitForFileChooser), to the
// action that opened it (which then fails with ZEN_FILE_CHOOSER_OPENED, as
// Ego's unhandled-chooser guard does), or is cancelled. Every other tab gets
// the real picker, untouched.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";

const { setTimeout: setTimeoutMs, clearTimeout: clearTimeoutMs } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const CONTRACT = "@mozilla.org/filepicker;1";
const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);

/** @type {{isAgentBrowser: (browser: Element) => boolean, onOpen?: Function} | null} */
let host = null;
let installed = null;
let nextChooser = 1;
/** Opens per kind, for tests: an agent tab's chooser must never reach the native picker. */
const stats = { native: 0, agent: 0 };

/** Open choosers by id, until handled. */
const choosers = new Map();
/** browser → {resolve, reject, timer} for page.waitForFileChooser */
const waiters = new Map();
/** browser → {opened: boolean} while a guarded action runs */
const guards = new Map();

/**
 * Gecko's own picker, for a tab the agent doesn't drive. Gecko 160 has no
 * Components.classesByID, nor any other way to make a component by its CID,
 * so the contract names Gecko's picker for this one synchronous call, then
 * zenius's again.
 */
function platformPicker() {
  if (!installed) {
    return Cc[CONTRACT].createInstance(Ci.nsIFilePicker);
  }
  registrar.registerFactory(installed.origCID, "", CONTRACT, null);
  try {
    return Cc[CONTRACT].createInstance(Ci.nsIFilePicker);
  } finally {
    registrar.registerFactory(installed.cid, "", CONTRACT, null);
  }
}

/**
 * A picker's context must be a live one. Gecko's color picker uses a null
 * context unchecked (GTK at init, Cocoa at open) and crashes Zen, and on
 * Linux with a display a closed tab's one at open. ColorPickerParent and
 * FilePickerParent never pass null, nor do chrome callers, which pass their
 * window's; this refuses a caller's mistake before Gecko's picker sees it.
 */
export function refuseDeadContext(bc) {
  if (!bc || bc.isDiscarded) {
    throw Components.Exception("a picker needs a live browsing context", Cr.NS_ERROR_INVALID_ARG);
  }
}

function browserOf(bc) {
  try {
    return bc?.top?.embedderElement ?? null;
  } catch {
    return null;
  }
}

/** browser → {folder, answered}: the folder its next folder chooser gets (claimFolderChooser). */
const folderClaims = new Map();

/**
 * For page.setInputFiles on a webkitdirectory input: the tab's next folder
 * chooser, which the content side opens on that input, is answered with
 * `folder` at once. Gecko then grants the page's process that folder alone,
 * walks it and fires the input's events, as for the user's own pick. Call
 * `release` once the input has the files, or the call failed.
 *
 * @param {Element} browser
 * @param {nsIFile} folder
 */
export function claimFolderChooser(browser, folder) {
  const claim = { folder, answered: false };
  folderClaims.set(browser, claim);
  return {
    get answered() {
      return claim.answered;
    },
    release() {
      if (folderClaims.get(browser) === claim) {
        folderClaims.delete(browser);
      }
    },
  };
}

/**
 * nsIFilePicker for agent tabs; for anything else it hands every call to the
 * platform's picker.
 */
class Picker {
  constructor(origCID) {
    this.origCID = origCID;
    this.real = null;
    this.mode = Ci.nsIFilePicker.modeOpen;
    this._files = [];
    this.domFiles = [];
    this.attrs = { defaultString: "", defaultExtension: "", filterIndex: 0, addToRecentDocs: false, okButtonLabel: "", capture: 0 };
    this.displayDirectory = null;
    this.displaySpecialDirectory = "";
    // Tests reach the picker behind XPConnect.
    this.wrappedJSObject = this;
  }

  init(browsingContext, title, mode) {
    refuseDeadContext(browsingContext);
    const browser = browserOf(browsingContext);
    if (!browser || !host?.isAgentBrowser(browser)) {
      const real = platformPicker();
      real.init(browsingContext, title, mode);
      // Kept once Gecko took it: Gecko's open() after a failed init uses
      // the context init never set, and crashes Zen.
      this.real = real;
      return;
    }
    this.browser = browser;
    this.browsingContext = browsingContext;
    this.mode = mode;
  }

  appendFilters(mask) {
    this.real?.appendFilters(mask);
  }

  appendFilter(title, filter) {
    this.real?.appendFilter(title, filter);
  }

  appendRawFilter(filter) {
    this.real?.appendRawFilter(filter);
  }

  isModeSupported(mode) {
    return this.real ? this.real.isModeSupported(mode) : Promise.resolve(true);
  }

  open(callback) {
    if (this.real) {
      stats.native++;
      this.real.open(callback);
      return;
    }
    if (!this.browser) {
      throw Components.Exception("the file picker isn't initialized", Cr.NS_ERROR_NOT_INITIALIZED);
    }
    stats.agent++;
    // The folder chooser page.setInputFiles opened on its input itself: the
    // runtime answers it, and no script sees it.
    const claim = folderClaims.get(this.browser);
    if (claim && this.mode === Ci.nsIFilePicker.modeGetFolder) {
      folderClaims.delete(this.browser);
      claim.answered = true;
      this._files = [claim.folder];
      callback.done(Ci.nsIFilePicker.returnOK);
      return;
    }
    const id = String(nextChooser++);
    const chooser = { id, picker: this, callback, browser: this.browser, bc: this.browsingContext, mode: this.mode };
    const multiple = this.mode === Ci.nsIFilePicker.modeOpenMultiple;
    const waiter = waiters.get(this.browser);
    if (waiter) {
      waiters.delete(this.browser);
      choosers.set(id, chooser);
      onConnectionClose(waiter.conn, () => cancelChooser(id, "because the script that took it ended"));
      waiter.resolve({ chooser: id, multiple });
      return;
    }
    const guard = guards.get(this.browser);
    if (guard) {
      guard.opened = true;
    }
    // Nobody waits for it: cancel at once, before anything could show.
    callback.done(Ci.nsIFilePicker.returnCancel);
  }

  close() {
    this.real?.close();
  }

  get file() {
    return this.real ? this.real.file : (this._files[0] ?? null);
  }
  get fileURL() {
    return this.real ? this.real.fileURL : this._files[0] ? Services.io.newFileURI(this._files[0]) : null;
  }
  get domFileOrDirectory() {
    return this.real ? this.real.domFileOrDirectory : (this.domFiles[0] ?? null);
  }
  get domFileOrDirectoryEnumerator() {
    if (this.real) {
      return this.real.domFileOrDirectoryEnumerator;
    }
    return arrayEnumerator(this.domFiles);
  }
}

// Attributes that only matter to the platform picker.
for (const name of ["defaultString", "defaultExtension", "filterIndex", "addToRecentDocs", "okButtonLabel", "capture"]) {
  Object.defineProperty(Picker.prototype, name, {
    get() {
      return this.real ? this.real[name] : this.attrs[name];
    },
    set(v) {
      if (this.real) {
        this.real[name] = v;
      } else {
        this.attrs[name] = v;
      }
    },
  });
}
Object.defineProperty(Picker.prototype, "files", {
  get() {
    return this.real ? this.real.files : arrayEnumerator(this._files ?? []);
  },
  set(v) {
    this._files = v;
  },
});
Object.defineProperty(Picker.prototype, "QueryInterface", {
  value: ChromeUtils.generateQI(["nsIFilePicker"]),
});

function arrayEnumerator(items) {
  let i = 0;
  return {
    hasMoreElements: () => i < items.length,
    getNext: () => items[i++],
    [Symbol.iterator]: function* () {
      yield* items;
    },
    QueryInterface: ChromeUtils.generateQI(["nsISimpleEnumerator"]),
  };
}

/**
 * Install the factory once per parent process.
 *
 * @param {{isAgentBrowser: (browser: Element) => boolean}} h
 */
export function installFileChoosers(h) {
  host = h;
  if (installed) {
    return;
  }
  const origCID = registrar.contractIDToCID(CONTRACT);
  const cid = Services.uuid.generateUUID();
  const factory = {
    createInstance(iid) {
      return new Picker(origCID).QueryInterface(iid);
    },
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
  };
  registrar.registerFactory(cid, "zenius agent file picker", CONTRACT, factory);
  installed = { cid, factory, origCID };
  // An earlier run's upload files go at start (uploads wait for this).
  swept ??= sweepUploadLeftovers();
}

/** Put the platform picker back (tests, shutdown). */
export function uninstallFileChoosers() {
  if (!installed) {
    return;
  }
  registrar.unregisterFactory(installed.cid, installed.factory);
  registrar.registerFactory(installed.origCID, "", CONTRACT, null);
  installed = null;
}

/**
 * Run `fn` when this connection closes (the script that sent the call
 * ended), as Ego ties choosers and waits to the script's session.
 */
function onConnectionClose(conn, fn) {
  if (conn?.state) {
    (conn.state.onClose ??= []).push(fn);
  }
}

/**
 * Run `fn` once when `browser`'s page closes for the agent: zen-core's
 * pageClosed, which comes when the tab's last window copy closes.
 *
 * @returns {() => void} stop listening
 */
function onPageClosed(browser, fn) {
  let service;
  try {
    service = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs").ZeniusService;
  } catch {
    return () => {};
  }
  const page = service.pages?.forBrowser(browser);
  if (!page) {
    return () => {};
  }
  const off = service.addEventListener((name, p) => {
    if (name === "pageClosed" && p?.space === page.spaceId && p?.page === page.label) {
      off();
      fn();
    }
  });
  return off;
}

/**
 * Wait for the page's next file chooser. Registers synchronously, so a wait
 * sent before the triggering action is in place when the action runs. The
 * wait, and a chooser it takes, go with `conn`: a script that ends with a
 * wait armed must not take the next script's chooser, and a chooser it took
 * and never answered must not keep its input blocked, since Gecko allows
 * one chooser per input.
 *
 * @returns {Promise<{chooser: string, multiple: boolean}>}
 */
export function waitForChooser(browser, timeoutMs, conn = null) {
  if (waiters.has(browser)) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "this Page is already waiting for a file chooser");
  }
  return new Promise((resolve, reject) => {
    let offClosed = () => {};
    const end = () => {
      clearTimeoutMs(timer);
      offClosed();
      if (waiters.get(browser) === entry) {
        waiters.delete(browser);
      }
    };
    const entry = {
      conn,
      resolve: v => {
        end();
        resolve(v);
      },
    };
    const timer = setTimeoutMs(() => {
      end();
      reject(new ZenError("ZEN_FILE_CHOOSER_TIMEOUT", `page.waitForFileChooser timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    waiters.set(browser, entry);
    // A page that closes ends the wait at once, as Ego's chooser session is
    // detached then.
    offClosed = onPageClosed(browser, () => {
      if (waiters.get(browser) === entry) {
        end();
        reject(new ZenError("ZEN_PAGE_NOT_FOUND", "page.waitForFileChooser: the page closed before a file chooser opened"));
      }
    });
    onConnectionClose(conn, () => {
      if (waiters.get(browser) === entry) {
        end();
        reject(new ZenError("ZEN_FILE_CHOOSER_TIMEOUT", "page.waitForFileChooser ended with the script that sent it"));
      }
    });
  });
}

/** How many choosers opened natively (users' tabs) and intercepted (agent tabs). */
export function chooserStats() {
  return { ...stats };
}

/** Whether a waiter is armed for this page (guarded actions then don't guard). */
export function isWaiting(browser) {
  return waiters.has(browser);
}

/**
 * Guard an action: a chooser it opens is cancelled and recorded.
 *
 * @returns {{opened: boolean, stop(): void}}
 */
export function guardChoosers(browser) {
  const guard = { opened: false };
  guards.set(browser, guard);
  guard.stop = () => {
    if (guards.get(browser) === guard) {
      guards.delete(browser);
    }
  };
  return guard;
}

/** Where an intercepted chooser came from, without answering it. */
export function chooserInfo(id) {
  const chooser = choosers.get(String(id));
  if (!chooser) {
    const cancelled = cancelledChoosers.get(String(id));
    throw new ZenError(
      "ZEN_INVALID_ARGUMENT",
      cancelled ? `this file chooser was cancelled ${cancelled.why}; open it again` : "this file chooser was already handled",
      cancelled ? { cancelled: true } : undefined
    );
  }
  return { bc: chooser.bc, browser: chooser.browser, multiple: chooser.mode === Ci.nsIFilePicker.modeOpenMultiple };
}

/** Playwright's upload limit in remote mode, where it too sends the bytes. */
export const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

/** Bytes that `b64` decodes to, without decoding it. */
function decodedLength(b64) {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function decodeBase64(b64) {
  if (typeof Uint8Array.fromBase64 === "function") {
    return Uint8Array.fromBase64(b64);
  }
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/**
 * The type a real file pick would give this name: Gecko's MIME service, by
 * extension (no file is read). "" when it doesn't know.
 */
function typeForName(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  try {
    return Cc["@mozilla.org/mime;1"].getService(Ci.nsIMIMEService).getTypeFromExtension(name.slice(dot + 1));
  } catch {
    return "";
  }
}

/**
 * A file name the page may see, and the runtime may give a file of its own:
 * one path component, no control characters.
 */
function leafName(name) {
  const leaf = name.replace(/[\/\\\u0000-\u001f\u007f]/g, "_").trim();
  if (!leaf || leaf === "." || leaf === "..") {
    return "file";
  }
  if (leaf.length <= 200) {
    return leaf;
  }
  // Most file systems allow 255 bytes; keep the extension.
  const dot = leaf.lastIndexOf(".");
  const ext = dot > 0 && leaf.length - dot <= 16 ? leaf.slice(dot) : "";
  return leaf.slice(0, 200 - ext.length) + ext;
}

/**
 * DOM Files from the client's payloads. The browser runs outside the
 * agent's sandbox, so it never reads a path an agent names: the CLI reads
 * the files and sends their bytes (SPEC I5). A string is refused, whatever
 * it names.
 *
 * @param {unknown} files  [{name, mimeType?, lastModified?, base64}], or one of them
 * @param {string} operation  the SDK method, for messages
 * @returns {File[]}
 */
export function filesFromPayloads(files, operation) {
  const list = Array.isArray(files) ? files : files && typeof files === "object" ? [files] : null;
  if (!list) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `${operation} takes a list of files`);
  }
  let total = 0;
  for (const f of list) {
    if (typeof f === "string") {
      throw new ZenError(
        "ZEN_INVALID_ARGUMENT",
        `${operation} takes file contents, not paths: send {name, mimeType, lastModified, base64}; the client reads the files`
      );
    }
    if (!f || typeof f !== "object" || typeof f.name !== "string" || !f.name || typeof f.base64 !== "string") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `${operation}: each file needs a name and its contents in base64`);
    }
    if (f.mimeType !== undefined && typeof f.mimeType !== "string") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `${operation}: ${f.name}'s mimeType must be a string`);
    }
    if (f.lastModified !== undefined && !Number.isFinite(f.lastModified)) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `${operation}: ${f.name}'s lastModified must be a number (ms since the epoch)`);
    }
    total += decodedLength(f.base64);
  }
  // Before decoding anything: nothing over the limit is ever held twice.
  if (total > UPLOAD_LIMIT_BYTES) {
    throw new ZenError(
      "ZEN_INVALID_ARGUMENT",
      `${operation}: the files total ${total} bytes, over the limit of ${UPLOAD_LIMIT_BYTES} (${UPLOAD_LIMIT_BYTES / (1024 * 1024)} MB)`
    );
  }
  return list.map(f => {
    let bytes;
    try {
      bytes = decodeBase64(f.base64);
    } catch {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `${operation}: ${f.name}'s contents aren't valid base64`);
    }
    const name = leafName(f.name);
    return new File([bytes], name, { type: f.mimeType || typeForName(name), lastModified: Math.round(f.lastModified ?? Date.now()) });
  });
}

// A chooser's answer reaches a content process as files on disk: the
// parent's picker hands over nsIFiles, never DOM files. So the client's
// bytes go to files of the runtime's own, one fresh private directory per
// answer (never a path the agent named), deleted when the tab closes or Zen
// quits. The page sees the names and times sent; the type comes from the
// name, as for a real pick.
//
// They go under the profile, in <profile>/zenius-uploads (0700), not the
// system temp folder. A sandboxed CLI can usually write the temp folder
// (Codex's workspace-write can), so an agent that raced the write could put
// a link where a folder was to be, or swap a folder for one, and have the
// browser create its file outside (SPEC I5). No sandboxed CLI writes the
// profile. Inside, every folder and file is created exclusively, so nothing
// already there is written into or through, and before each write and after
// the last, no folder on the way may be a link. A check that fails fails the
// answer, which leaves the chooser open. Cleaning up never follows a link.
//
// Earlier versions kept them in the temp folder (zenius-upload-<hash>, -1,
// …). Those stay there for the system's temp cleanup. Removing one, in place
// or after moving it into the profile, recurses through folders that an
// agent which writes the temp folder, or is already inside one, can still
// change: nsLocalFile::Remove checks a folder, then opens it by path, so a
// folder swapped for a link in between has the link's target emptied.

/** browser → its upload directories, until the tab closes. */
const uploadDirs = new Map();
/** Every upload directory, oldest first: at most MAX_UPLOAD_DIRS stay. */
const allUploadDirs = [];
const MAX_UPLOAD_DIRS = 20;
let quitObserver = null;
/** Settles once an earlier run's directories are gone; uploads wait for it. */
let swept = null;

/** Where the upload directories go: in the profile, which no sandboxed CLI writes. */
export function uploadRoot() {
  return PathUtils.join(PathUtils.profileDir, "zenius-uploads");
}

/**
 * Hooks for tests, at the moments an agent racing the runtime would act:
 * `making(path)` before a folder of an upload is made, `made(path)` right
 * after. Unset outside tests.
 */
export const uploadTestHooks = { making: null, made: null };

function localFile(path) {
  const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  f.initWithPath(path);
  return f;
}

/** `path` is a link (lstat's view: isSymlink doesn't follow it); false if it's absent. */
function isLink(path) {
  try {
    return localFile(path).isSymlink();
  } catch {
    return false;
  }
}

/** The upload root, made if absent: a folder of the runtime's own, 0700, never a link to one. */
async function readyUploadRoot() {
  const root = uploadRoot();
  await IOUtils.makeDirectory(root, { createAncestors: false, ignoreExisting: true, permissions: 0o700 });
  if (isLink(root) || (await IOUtils.stat(root)).type !== "directory") {
    throw new ZenError("ZEN_INTERNAL", `the files weren't attached: ${root} isn't a folder of zenius's own`);
  }
  await IOUtils.setPermissions(root, 0o700);
  return root;
}

async function childrenOf(parent) {
  try {
    return await IOUtils.getChildren(parent, { ignoreAbsent: true });
  } catch (e) {
    console.warn(`[zenius] couldn't list ${parent} for upload leftovers`, e);
    return [];
  }
}

/**
 * "own" while the upload root is a folder of zenius's own, "absent" when
 * nothing is there, and "foreign" for anything else in its place, a link
 * included. Removal acts only on "own": through a link in the root's place,
 * a recursive remove would empty a folder of the same name wherever it
 * points. A backstop, since no agent writes the profile.
 */
function rootState(root = uploadRoot()) {
  const f = localFile(root);
  try {
    return f.isSymlink() ? "foreign" : f.isDirectory() ? "own" : "foreign";
  } catch (e) {
    return e.result === Cr.NS_ERROR_FILE_NOT_FOUND ? "absent" : "foreign";
  }
}

/**
 * Remove the upload root's folders that this run doesn't hold: an earlier
 * run's, left by a crash. Runs once at install; tests call it too. A link
 * is unlinked, never followed. Nothing outside the root is touched,
 * earlier versions' folders in the temp folder included (see above).
 */
export async function sweepUploadLeftovers() {
  const root = uploadRoot();
  const state = rootState(root);
  if (state !== "own") {
    if (state === "foreign") {
      console.warn(`[zenius] left ${root} alone: it isn't a folder of zenius's own`);
    }
    return;
  }
  for (const path of await childrenOf(root)) {
    if (!allUploadDirs.includes(path)) {
      await IOUtils.remove(path, { recursive: true, ignoreAbsent: true }).catch(e => console.warn("[zenius] couldn't remove an upload leftover", e));
    }
  }
}

/** Stop holding an upload directory and remove it: only one directly in the root, while the root is zenius's own. */
function removeDir(dir) {
  const i = allUploadDirs.indexOf(dir);
  if (i >= 0) {
    allUploadDirs.splice(i, 1);
  }
  const root = uploadRoot();
  const state = PathUtils.parent(dir) === root ? rootState(root) : "foreign";
  if (state !== "own") {
    if (state === "foreign") {
      console.warn(`[zenius] left ${dir}: the upload root isn't a folder of zenius's own`);
    }
    return;
  }
  IOUtils.remove(dir, { recursive: true, ignoreAbsent: true }).catch(e => console.warn("[zenius] couldn't remove upload directory", e));
}

function forgetBrowser(browser) {
  for (const dir of uploadDirs.get(browser) ?? []) {
    removeDir(dir);
  }
  uploadDirs.delete(browser);
}

function trackUploadDir(browser, dir) {
  if (!quitObserver) {
    quitObserver = {
      observe() {
        for (const dir of [...allUploadDirs]) {
          removeDir(dir);
        }
      },
    };
    Services.obs.addObserver(quitObserver, "quit-application");
  }
  let dirs = uploadDirs.get(browser);
  if (!dirs) {
    dirs = [];
    uploadDirs.set(browser, dirs);
    // Gecko 160 has no Node.ownerGlobal.
    const tab = browser.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser);
    tab?.addEventListener(
      "TabClose",
      event => {
        // A tab moving to another window keeps its page, and the page its files.
        const adopted = event.detail?.adoptedBy?.linkedBrowser;
        if (adopted) {
          for (const d of uploadDirs.get(browser) ?? []) {
            trackUploadDir(adopted, d);
          }
          uploadDirs.delete(browser);
        } else {
          forgetBrowser(browser);
        }
      },
      { once: true }
    );
  }
  if (!dirs.includes(dir)) {
    dirs.push(dir);
  }
  if (!allUploadDirs.includes(dir)) {
    allUploadDirs.push(dir);
  }
  while (allUploadDirs.length > MAX_UPLOAD_DIRS) {
    const old = allUploadDirs[0];
    for (const list of uploadDirs.values()) {
      const j = list.indexOf(old);
      if (j >= 0) {
        list.splice(j, 1);
      }
    }
    removeDir(old);
  }
}

/**
 * The files of a chooser's answer, written where the runtime chose.
 *
 * @param {Element} browser
 * @param {File[]} files  from filesFromPayloads
 * @returns {Promise<nsIFile[]>}
 */
export async function writeUploadFiles(browser, files) {
  if (!files.length) {
    return [];
  }
  swept ??= sweepUploadLeftovers();
  await swept;
  // All the bytes first, so nothing slow comes between making a folder and
  // writing into it.
  const contents = await Promise.all(files.map(f => f.arrayBuffer()));
  const root = await readyUploadRoot();
  const dir = await IOUtils.createUniqueDirectory(root, "upload", 0o700);
  trackUploadDir(browser, dir);
  const written = [];
  try {
    await uploadTestHooks.made?.(dir);
    for (const [i, file] of files.entries()) {
      // One directory per file: two files may share a name.
      const sub = PathUtils.join(dir, String(i));
      await uploadTestHooks.making?.(sub);
      assertNoLinkOnTheWay(root, sub);
      // Fails on anything already there, a link included.
      await IOUtils.makeDirectory(sub, { createAncestors: false, ignoreExisting: false, permissions: 0o700 });
      await uploadTestHooks.made?.(sub);
      const path = PathUtils.join(sub, file.name);
      assertNoLinkOnTheWay(root, path);
      // "create" fails on anything already there, a link included.
      await IOUtils.write(path, new Uint8Array(contents[i]), { mode: "create" });
      written.push(path);
      await IOUtils.setPermissions(path, 0o600);
      await IOUtils.setModificationTime(path, file.lastModified);
    }
    // A folder swapped for a link between its check and the write sent that
    // file outside: the answer fails.
    for (const path of written) {
      assertNoLinkOnTheWay(root, path);
    }
  } catch (e) {
    // The chooser stays open; what the runtime made is removed, never
    // through a link (IOUtils.remove unlinks one, and goes no further).
    forgetDir(dir);
    if (e instanceof ZenError) {
      throw e;
    }
    throw new ZenError("ZEN_INTERNAL", `the files weren't attached: zenius couldn't write them in its own folder (${e.message})`);
  }
  return written.map(localFile);
}

/** At most this many files in one folder upload; the byte cap is UPLOAD_LIMIT_BYTES. */
export const FOLDER_UPLOAD_MAX_FILES = 1000;
const MAX_SEGMENT_BYTES = 255;
// With the upload folder's own path in front, this stays under the Mac's
// 1024-byte path limit.
const MAX_RELATIVE_PATH_BYTES = 768;
const NOT_IN_A_PATH = /[\u0000-\u001f\u007f\\]/;

/**
 * A folder upload's plan, or null when no payload carries a relativePath
 * (plain files). Every check runs before anything is decoded or written,
 * and each refuses the whole call: every path the runtime writes stays
 * inside the folder it names (SPEC I5).
 *
 * @param {unknown} files  the client's payloads
 * @param {string} operation  the SDK method, for messages
 * @returns {{folder: string, segments: string[][]}|null}  segments[i] is payload i's path, folder first
 */
export function folderPlan(files, operation) {
  const list = Array.isArray(files) ? files : files && typeof files === "object" ? [files] : null;
  const carries = f => !!f && typeof f === "object" && f.relativePath !== undefined;
  if (!list || !list.some(carries)) {
    return null;
  }
  const refuse = why => {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `${operation}: ${why}`);
  };
  if (!list.every(carries)) {
    refuse("a folder upload gives every file a relativePath, and some files here have none");
  }
  if (list.length > FOLDER_UPLOAD_MAX_FILES) {
    refuse(`the folder holds ${list.length} files, over the limit of ${FOLDER_UPLOAD_MAX_FILES}`);
  }
  const bytes = s => new TextEncoder().encode(s).length;
  const sent = new Set();
  const segments = [];
  let folder = null;
  for (const f of list) {
    const rel = f.relativePath;
    if (typeof f.name !== "string" || !f.name || typeof f.base64 !== "string") {
      refuse("each file needs a name and its contents in base64");
    }
    if (typeof rel !== "string" || !rel) {
      refuse(`${JSON.stringify(f.name)}'s relativePath must be a non-empty string`);
    }
    const shown = JSON.stringify(rel.length > 200 ? `${rel.slice(0, 200)}…` : rel);
    if (rel.startsWith("/")) {
      refuse(`the relativePath ${shown} is absolute; it starts with the folder's own name`);
    }
    if (NOT_IN_A_PATH.test(rel)) {
      refuse(`the relativePath ${shown} holds a NUL, a backslash or another control character`);
    }
    const parts = rel.split("/");
    if (parts.some(p => p === "" || p === "." || p === "..")) {
      refuse(`the relativePath ${shown} has an empty, "." or ".." segment`);
    }
    if (parts.length < 2) {
      refuse(`the relativePath ${shown} names the folder, then the file: "<folder>/<name>"`);
    }
    if (bytes(rel) > MAX_RELATIVE_PATH_BYTES || parts.some(p => bytes(p) > MAX_SEGMENT_BYTES)) {
      refuse(`the relativePath ${shown} is too long: at most ${MAX_SEGMENT_BYTES} bytes a segment and ${MAX_RELATIVE_PATH_BYTES} in all, in UTF-8`);
    }
    if (parts.at(-1) !== f.name) {
      refuse(`the relativePath ${shown} must end with the file's name, ${JSON.stringify(f.name)}`);
    }
    folder ??= parts[0];
    if (parts[0] !== folder) {
      refuse(`a folder upload sends one folder, and ${JSON.stringify(folder)} and ${JSON.stringify(parts[0])} are two`);
    }
    if (sent.has(rel)) {
      refuse(`the relativePath ${shown} is sent twice`);
    }
    sent.add(rel);
    segments.push(parts);
  }
  for (const parts of segments) {
    for (let k = 2; k < parts.length; k++) {
      const above = parts.slice(0, k).join("/");
      if (sent.has(above)) {
        refuse(`${JSON.stringify(above)} is sent both as a file and as a folder`);
      }
    }
  }
  return { folder, segments };
}

/**
 * A folder upload, written as the tree it came from under a fresh upload
 * folder: <upload-n>/<folder>/…/<name>. Every folder and file is created
 * exclusively, with the same link checks as writeUploadFiles. Two names that
 * land on one file (a disk that folds case or Unicode forms) fail the call.
 *
 * @param {Element} browser
 * @param {File[]} files  from filesFromPayloads, in the plan's order
 * @param {{folder: string, segments: string[][]}} plan  from folderPlan
 * @returns {Promise<nsIFile>}  the folder
 */
export async function writeUploadFolder(browser, files, plan) {
  swept ??= sweepUploadLeftovers();
  await swept;
  const contents = await Promise.all(files.map(f => f.arrayBuffer()));
  const root = await readyUploadRoot();
  const dir = await IOUtils.createUniqueDirectory(root, "upload", 0o700);
  trackUploadDir(browser, dir);
  const written = [];
  const made = new Set();
  try {
    await uploadTestHooks.made?.(dir);
    for (const [i, parts] of plan.segments.entries()) {
      let at = dir;
      for (const part of parts.slice(0, -1)) {
        at = PathUtils.join(at, part);
        if (made.has(at)) {
          continue;
        }
        await uploadTestHooks.making?.(at);
        assertNoLinkOnTheWay(root, at);
        await IOUtils.makeDirectory(at, { createAncestors: false, ignoreExisting: false, permissions: 0o700 }).catch(e => {
          throw whyNotMade(at, e, parts);
        });
        made.add(at);
        await uploadTestHooks.made?.(at);
      }
      const path = PathUtils.join(at, parts.at(-1));
      assertNoLinkOnTheWay(root, path);
      await IOUtils.write(path, new Uint8Array(contents[i]), { mode: "create" }).catch(e => {
        throw whyNotMade(path, e, parts);
      });
      written.push(path);
      await IOUtils.setPermissions(path, 0o600);
      await IOUtils.setModificationTime(path, files[i].lastModified);
    }
    for (const path of written) {
      assertNoLinkOnTheWay(root, path);
    }
    // The page gets what Gecko finds there: exactly the files sent.
    const found = await countFiles(PathUtils.join(dir, plan.folder));
    if (found !== written.length) {
      throw new ZenError("ZEN_INTERNAL", `the folder wasn't attached: zenius wrote ${written.length} files and found ${found}`);
    }
  } catch (e) {
    forgetDir(dir);
    if (e instanceof ZenError) {
      throw e;
    }
    throw new ZenError("ZEN_INTERNAL", `the folder wasn't attached: zenius couldn't write it in its own folder (${e.message})`);
  }
  return localFile(PathUtils.join(dir, plan.folder));
}

/** Why a folder or file of an upload couldn't be made where nothing should have been. */
function whyNotMade(path, e, parts) {
  if (isLink(path)) {
    return new ZenError("ZEN_INTERNAL", "the files weren't attached: a folder zenius made for them became a link while it wrote them");
  }
  let there = false;
  try {
    there = localFile(path).exists();
  } catch {}
  if (there) {
    return new ZenError(
      "ZEN_INVALID_ARGUMENT",
      `two of the folder's names land on one file on this disk, which doesn't tell them apart (letter case, or Unicode forms): ${JSON.stringify(parts.join("/"))} and one sent before it`
    );
  }
  return e;
}

/** Regular files under `dir`, which may hold folders and files only: a link or anything else fails. */
async function countFiles(dir) {
  let n = 0;
  for (const path of await IOUtils.getChildren(dir)) {
    if (isLink(path)) {
      throw new ZenError("ZEN_INTERNAL", "the files weren't attached: a folder zenius made for them became a link while it wrote them");
    }
    const { type } = await IOUtils.stat(path);
    if (type === "directory") {
      n += await countFiles(path);
    } else if (type === "regular") {
      n++;
    } else {
      throw new ZenError("ZEN_INTERNAL", `the folder wasn't attached: something other than a file or folder appeared in it (${PathUtils.filename(path)})`);
    }
  }
  return n;
}

/**
 * Every folder from the upload root down to `path`, and `path` itself if it
 * exists, is what it looks like: not a link. And `path` resolves inside the
 * root.
 */
function assertNoLinkOnTheWay(root, path) {
  const rel = path.slice(root.length + 1).split("/");
  let at = root;
  for (const part of ["", ...rel]) {
    at = part ? PathUtils.join(at, part) : at;
    if (isLink(at)) {
      throw new ZenError("ZEN_INTERNAL", "the files weren't attached: a folder zenius made for them became a link while it wrote them");
    }
  }
  const real = localFile(path);
  const realRoot = localFile(root);
  try {
    real.normalize();
    realRoot.normalize();
  } catch {
    return;
  }
  if (!real.path.startsWith(realRoot.path + "/")) {
    throw new ZenError("ZEN_INTERNAL", "the files weren't attached: a file zenius wrote resolved outside its folder");
  }
}

/** Remove an upload directory and stop tracking it. */
function forgetDir(dir) {
  for (const list of uploadDirs.values()) {
    const j = list.indexOf(dir);
    if (j >= 0) {
      list.splice(j, 1);
    }
  }
  removeDir(dir);
}

/** Remove a folder upload (writeUploadFolder's folder) that never reached its input. */
export function dropUploadFolder(folder) {
  forgetDir(PathUtils.parent(folder.path));
}

/** For tests: the upload directories the runtime holds now. */
export function uploadDirectories() {
  return [...allUploadDirs];
}

/**
 * The chooser takes this answer: `count` files, as a folder or not. Checked
 * before anything is written.
 */
export function checkChooserFiles(id, count, folder = false) {
  const chooser = choosers.get(String(id));
  if (!chooser) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "this file chooser was already handled");
  }
  const picksFolder = chooser.mode === Ci.nsIFilePicker.modeGetFolder;
  if (folder && !picksFolder) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "this chooser takes files: send files without a relativePath, or open a folder chooser (an input with webkitdirectory)");
  }
  if (count && picksFolder && !folder) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "this chooser takes a folder: send one folder, each file with its relativePath");
  }
  if (!folder && count > 1 && chooser.mode !== Ci.nsIFilePicker.modeOpenMultiple) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "this file chooser takes one file");
  }
}

/** Choosers zenius cancelled → why and whose tab, so a late answer hears it. */
const cancelledChoosers = new Map();

/** The tab of a chooser zenius cancelled, or null. */
export function cancelledChooserBrowser(id) {
  return cancelledChoosers.get(String(id))?.browser ?? null;
}

/**
 * Answer a held chooser with nothing, as when a user closes the dialog: the
 * page hears cancel.
 *
 * @param {string} id
 * @param {string} why  for a late answer: "when …", "because …"
 * @returns {boolean} whether it was still held
 */
export function cancelChooser(id, why) {
  const chooser = choosers.get(String(id));
  if (!chooser) {
    return false;
  }
  choosers.delete(String(id));
  cancelledChoosers.set(String(id), { why, browser: chooser.browser });
  if (cancelledChoosers.size > 64) {
    cancelledChoosers.delete(cancelledChoosers.keys().next().value);
  }
  try {
    chooser.callback.done(Ci.nsIFilePicker.returnCancel);
  } catch (e) {
    console.warn("[zenius] couldn't cancel a file chooser", e);
  }
  return true;
}

/**
 * Cancel every held chooser whose tab the agent no longer drives: the user
 * took over or was handed the task, the task ended, or the tab closed. Its
 * answer would act under the user's control (I3). A held chooser also keeps
 * its input from opening another (Gecko allows one picker per input), so
 * the user's own click there would get nothing.
 */
export function cancelUndrivenChoosers() {
  for (const [id, chooser] of [...choosers]) {
    if (!host?.isAgentBrowser(chooser.browser)) {
      cancelChooser(id, "when the agent stopped driving its tab (the user took control, or the task ended)");
    }
  }
}

/**
 * Answer an intercepted chooser with these files: DOM files from
 * filesFromPayloads, and the same written by writeUploadFiles. The page
 * receives them as from a real choice: trusted input and change events.
 * Anything refused leaves the chooser open for another try.
 *
 * @param {string} id
 * @param {File[]} files
 * @param {nsIFile[]} onDisk
 * @returns {{bc: BrowsingContext, browser: Element}}
 */
export function setChooserFiles(id, files, onDisk) {
  checkChooserFiles(id, files.length);
  const chooser = choosers.get(String(id));
  choosers.delete(String(id));
  const picker = chooser.picker;
  picker.domFiles = files;
  picker._files = onDisk;
  chooser.callback.done(files.length ? Ci.nsIFilePicker.returnOK : Ci.nsIFilePicker.returnCancel);
  return { bc: chooser.bc, browser: chooser.browser };
}

/**
 * Answer a folder chooser with a folder writeUploadFolder made. Gecko's
 * picker parent reads `file`, grants the page's process that folder alone,
 * and the input walks it and fires its events.
 */
export function setChooserFolder(id, folder, count) {
  checkChooserFiles(id, count, true);
  const chooser = choosers.get(String(id));
  choosers.delete(String(id));
  chooser.picker.domFiles = [];
  chooser.picker._files = [folder];
  chooser.callback.done(Ci.nsIFilePicker.returnOK);
  return { bc: chooser.bc, browser: chooser.browser };
}
