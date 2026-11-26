// File choosers in a content process where a task page lives (the input layer).
//
// A page's <input type=file> asks its own process for an nsIFilePicker:
// Gecko's proxy for the parent's picker (input/filechooser.sys.mjs). While
// the process is armed (content/capture.sys.mjs), this module puts a picker
// of its own in front of that proxy. In an agent tab it hands the proxy a
// callback of its own too, which calls the input's and then says the
// chooser was answered: by then the files are on the input and its input
// and change handlers have run, even on an input the page never attached,
// whose events never reach the window. So fileChooser.setFiles returns at
// once there, as Ego's does (content/actions.sys.mjs's awaitFileInput).
//
// Gecko asks for a picker before it says which tab it's for, so the factory
// is the whole process's: in any other tab, the picker hands every call to
// Gecko's proxy as it came, the input's callback included. The page sees
// none of it.
//
// A folder's input and change come later, once Gecko has walked it, and an
// input the page never attached sends them only to itself. Gecko names the
// input as its chooser opens (file-input-picker-opening, right after init,
// for WebDriver BiDi), so an agent tab's picker keeps it and says it with
// the answer: whoever waits for the walk listens on it too.

import { TASK_BROWSERS_KEY } from "chrome://userscripts/content/zenius/content/guards.sys.mjs";
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const CONTRACT = "@mozilla.org/filepicker;1";
const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);

/** The factory while it's installed: {cid, factory, origCID}. */
let installed = null;
/** BrowsingContext id → what waits for a chooser answered in that frame. */
const waiting = new Map();
/** What hears an agent tab's page ask for a chooser: fn(browserId). */
const opening = new Set();
/** Set while the runtime opens an input's chooser itself (openOwnChooser): no page asked. */
let runtimeOpening = false;
/** The agent tab's picker Gecko just initialized, until it names the input that asked for it. */
let initing = null;

// Firefox asks before a folder pick reaches a page (HTMLInputElement's
// nsFilePickerShownCallback calls nsIPromptCollection.confirmFolderUpload,
// Bug 1338637: a site mustn't trick a person into a folder pick), and in an
// agent tab the observe layer's handler answers Cancel. When the folder is the
// runtime's own (page.setInputFiles or fileChooser.setFiles with a folder:
// the agent named every file, and its sandbox bounded what it read), the
// question is answered yes, once:
// - the parent arms a token for one frame and the folder it staged under
//   <profile>/zenius-uploads (expectOwnFolder, on the runtime's own actor
//   message, which no page reaches);
// - the token is taken only when zenius's picker hands that frame its
//   answer, and matches only that folder's name in that frame;
// - it lapses once the delivery ends, or after OWN_FOLDER_MS.
// Every other ask, the user's own tabs in this process included, goes to
// Firefox's service as it came; an error there never turns into yes.
const PROMPTS = "@mozilla.org/embedcomp/prompt-collection;1";
const OWN_FOLDER_MS = 5000;
/** BrowsingContext id → the token for the folder the parent is handing that frame. */
const ownFolders = new Map();
/** The delivery zenius's picker is running now: {bcId, name, used}, or null. */
let delivering = null;
/** Firefox's own prompt collection, while zenius's is in front of it. */
let firefoxPrompts = null;
let promptsInstalled = null;

/**
 * Gecko's own picker proxy. Gecko 160 has no Components.classesByID, nor any
 * other way to make a component by its CID, so the contract names Gecko's
 * proxy for this one synchronous call, then zenius's again.
 */
function geckoPicker() {
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

function isTaskTab(bc) {
  try {
    return !!bc?.browserId && !!Services.cpmm.sharedData.get(TASK_BROWSERS_KEY)?.has(bc.browserId);
  } catch {
    return false;
  }
}

/**
 * A chooser of frame `bcId` was answered, and its input's handlers ran. For
 * a folder, `info` says whether zenius answered Firefox's folder question
 * yes ({folder, confirmed}), and which input asked (`input`, or null); the
 * folder's input and change come later, at that input, once Gecko has
 * walked it.
 */
function answered(bcId, result, info = { folder: false, confirmed: false, input: null }) {
  for (const fn of [...(waiting.get(bcId) ?? [])]) {
    try {
      fn(result, info);
    } catch (e) {
      console.error("[zenius] a file chooser's answer listener failed", e);
    }
  }
}

/** Gecko's picker proxy, behind one of zenius's: the input calls this, and this calls Gecko's. */
class ContentPicker {
  constructor() {
    this.inner = geckoPicker();
    /** An agent tab's picker? Known at init, from its tab. */
    this.agent = false;
    this.bcId = 0;
    /** The input that asked for this chooser, which Gecko names right after init; held until the answer. */
    this.input = null;
    // Tests reach the picker behind XPConnect.
    this.wrappedJSObject = this;
  }

  init(browsingContext, title, mode) {
    this.agent = isTaskTab(browsingContext);
    this.bcId = browsingContext?.id ?? 0;
    this.inner.init(browsingContext, title, mode);
    initing = this.agent ? this : null;
    if (!this.agent || runtimeOpening) {
      return;
    }
    // Still inside the page's own call (a click's default action, click(),
    // showPicker()), so the action running it hears of the chooser. open()
    // comes later: Gecko first reads the last folder used, asynchronously.
    for (const fn of [...opening]) {
      try {
        fn(browsingContext.browserId);
      } catch (e) {
        console.error("[zenius] a file chooser's listener failed", e);
      }
    }
  }

  appendFilters(mask) {
    this.inner.appendFilters(mask);
  }

  appendFilter(title, filter) {
    this.inner.appendFilter(title, filter);
  }

  appendRawFilter(filter) {
    this.inner.appendRawFilter(filter);
  }

  isModeSupported(mode) {
    return this.inner.isModeSupported(mode);
  }

  open(callback) {
    if (!this.agent) {
      this.inner.open(callback);
      return;
    }
    const bcId = this.bcId;
    const folder = this.inner.mode === Ci.nsIFilePicker.modeGetFolder;
    const picker = this;
    this.inner.open({
      done(result) {
        const input = picker.input;
        picker.input = null;
        // Gecko asks about a folder inside the input's callback.
        const own = folder && result === Ci.nsIFilePicker.returnOK ? takeOwnFolder(bcId) : null;
        delivering = own;
        try {
          callback?.done(result);
        } finally {
          delivering = null;
          // Gecko grants the activation before its folder question, so it
          // is spent whatever the answer: no person picked this folder.
          if (folder && result === Ci.nsIFilePicker.returnOK) {
            spendActivation(bcId);
          }
          answered(bcId, result, { folder, confirmed: !!own?.used, input });
        }
      },
      QueryInterface: ChromeUtils.generateQI(["nsIFilePickerShownCallback"]),
    });
  }

  close() {
    this.inner.close();
  }
}

// The rest of nsIFilePicker, as Gecko's proxy has it.
for (const name of ["defaultString", "defaultExtension", "filterIndex", "displayDirectory", "displaySpecialDirectory", "addToRecentDocs", "okButtonLabel", "capture"]) {
  Object.defineProperty(ContentPicker.prototype, name, {
    get() {
      return this.inner[name];
    },
    set(v) {
      this.inner[name] = v;
    },
  });
}
for (const name of ["mode", "file", "fileURL", "files", "domFileOrDirectory", "domFileOrDirectoryEnumerator"]) {
  Object.defineProperty(ContentPicker.prototype, name, {
    get() {
      return this.inner[name];
    },
  });
}
Object.defineProperty(ContentPicker.prototype, "QueryInterface", {
  value: ChromeUtils.generateQI(["nsIFilePicker"]),
});

/**
 * The parent runtime is about to hand frame `bc` the folder it staged at
 * `path`: Firefox's question before that folder reaches the input is
 * answered yes, once. Called only on the runtime's own actor message.
 *
 * @param {BrowsingContext} bc
 * @param {string} path  the staged folder, <profile>/zenius-uploads/upload-<n>/<folder>
 * @returns {() => void} lapse: call once the delivery completed or failed
 */
export function expectOwnFolder(bc, path) {
  if (ownFolderTestHooks.unarmed) {
    return () => {};
  }
  const token = { name: PathUtils.filename(path), path, timer: null };
  const lapse = () => {
    clearTimeout(token.timer);
    if (ownFolders.get(bc.id) === token) {
      ownFolders.delete(bc.id);
    }
  };
  token.timer = setTimeout(lapse, OWN_FOLDER_MS);
  ownFolders.set(bc.id, token);
  return lapse;
}

/** For tests: `unarmed` leaves the runtime's folder to Firefox's question, as a lapsed token would. */
export const ownFolderTestHooks = { unarmed: false };

/** Frame `bcId`'s token, taken as zenius's picker delivers its folder: {bcId, name, used}, or null. */
function takeOwnFolder(bcId) {
  const token = ownFolders.get(bcId);
  if (!token) {
    return null;
  }
  ownFolders.delete(bcId);
  clearTimeout(token.timer);
  return { bcId, name: token.name, used: false };
}

/**
 * Gecko grants the page transient activation for every pick
 * (nsFilePickerShownCallback::Done), a person's gesture. A folder delivered
 * to an agent tab is the runtime's, no person's: the activation is spent
 * before the input's events, which come once Gecko has walked the folder.
 * page.setInputFiles with files grants none either, nor does Ego's.
 */
function spendActivation(bcId) {
  try {
    BrowsingContext.get(bcId)?.window?.document?.consumeTransientUserGestureActivation();
  } catch (e) {
    console.error("[zenius] couldn't spend the activation of a folder pick", e);
  }
}

/** Firefox's prompt collection, but for the runtime's own folder (see above). */
class Prompts {
  confirmFolderUpload(browsingContext, directoryName) {
    let own = false;
    try {
      const d = delivering;
      own = !!d && !d.used && d.bcId === browsingContext?.id && d.name === directoryName;
      if (own) {
        d.used = true;
      }
    } catch (e) {
      console.error("[zenius] the folder question's check failed; Firefox asks", e);
      own = false;
    }
    return own ? true : firefoxPrompts.confirmFolderUpload(browsingContext, directoryName);
  }

  confirmRepost(browsingContext) {
    return firefoxPrompts.confirmRepost(browsingContext);
  }

  asyncBeforeUnloadCheck(browsingContext) {
    return firefoxPrompts.asyncBeforeUnloadCheck(browsingContext);
  }
}
Prompts.prototype.QueryInterface = ChromeUtils.generateQI(["nsIPromptCollection"]);

function installPrompts() {
  if (promptsInstalled) {
    return;
  }
  try {
    const origCID = registrar.contractIDToCID(PROMPTS);
    firefoxPrompts = Cc[PROMPTS].getService(Ci.nsIPromptCollection);
    const cid = Services.uuid.generateUUID();
    const factory = {
      createInstance(iid) {
        return new Prompts().QueryInterface(iid);
      },
      QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    };
    registrar.registerFactory(cid, "zenius prompt collection (content)", PROMPTS, factory);
    promptsInstalled = { cid, factory, origCID };
  } catch (e) {
    // Folder uploads then meet Firefox's question, and the observe layer's Cancel.
    console.error("[zenius] couldn't put zenius's prompt collection in this content process", e);
  }
}

function uninstallPrompts() {
  if (!promptsInstalled) {
    return;
  }
  const { cid, factory, origCID } = promptsInstalled;
  promptsInstalled = null;
  try {
    registrar.unregisterFactory(cid, factory);
    registrar.registerFactory(origCID, "", PROMPTS, null);
  } catch (e) {
    console.error("[zenius] couldn't take zenius's prompt collection out of this content process", e);
  }
}

/**
 * Gecko names the input that asked for a chooser right after it initialized
 * the picker (HTMLInputElement::InitFilePicker), in the same call: the agent
 * tab's picker just initialized keeps it, if it's that input's frame.
 */
const pickerOpening = {
  observe(input) {
    const picker = initing;
    initing = null;
    try {
      // ownerGlobal isn't on a page's element behind its Xray.
      if (picker && input?.ownerDocument?.defaultView?.browsingContext?.id === picker.bcId) {
        picker.input = input;
      }
    } catch (e) {
      console.error("[zenius] couldn't tell which input opened a file chooser", e);
    }
  },
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
};

/** Put zenius's picker in front of Gecko's proxy in this content process, once. */
export function installContentPicker() {
  if (installed || Services.appinfo.processType !== Services.appinfo.PROCESS_TYPE_CONTENT) {
    return;
  }
  try {
    const origCID = registrar.contractIDToCID(CONTRACT);
    const cid = Services.uuid.generateUUID();
    const factory = {
      createInstance(iid) {
        try {
          return new ContentPicker().QueryInterface(iid);
        } catch (e) {
          console.error("[zenius] zenius's file picker failed in this content process", e);
          // The page's file inputs never go without a picker: Gecko's from
          // now on, even if this one couldn't be made.
          uninstallContentPicker();
          return Cc[CONTRACT].createInstance(Ci.nsIFilePicker).QueryInterface(iid);
        }
      },
      QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    };
    registrar.registerFactory(cid, "zenius file picker (content)", CONTRACT, factory);
    installed = { cid, factory, origCID };
    Services.obs.addObserver(pickerOpening, "file-input-picker-opening");
    installPrompts();
  } catch (e) {
    // setFiles still works, by the window's events: up to 2 s for an input the page never attached.
    console.error("[zenius] couldn't put zenius's file picker in this content process", e);
  }
}

/** Gecko's proxy alone again, once no task page lives in this process. A picker already made keeps working. */
export function uninstallContentPicker() {
  if (!installed) {
    return;
  }
  uninstallPrompts();
  try {
    Services.obs.removeObserver(pickerOpening, "file-input-picker-opening");
  } catch {}
  initing = null;
  const { cid, factory, origCID } = installed;
  installed = null;
  try {
    registrar.unregisterFactory(cid, factory);
    registrar.registerFactory(origCID, "", CONTRACT, null);
  } catch (e) {
    console.error("[zenius] couldn't take zenius's file picker out of this content process", e);
  }
}

/**
 * Run `open`, which opens a file input's chooser on the runtime's behalf
 * (page.setInputFiles with a folder), without telling onChooserOpening's
 * listeners: the page didn't ask for it, so no action's chooser guard may
 * count it. Gecko calls init() synchronously inside showPicker().
 */
export function openOwnChooser(open) {
  runtimeOpening = true;
  try {
    return open();
  } finally {
    runtimeOpening = false;
  }
}

/**
 * Call `fn` with the tab's browserId each time a page in an agent tab of
 * this process asks for a chooser. It runs inside the page's own call,
 * before the chooser opens or reaches the parent.
 *
 * @param {(browserId: number) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onChooserOpening(fn) {
  opening.add(fn);
  return () => opening.delete(fn);
}

/**
 * Call `fn` once a chooser of the agent tab's frame `bc` is answered: its
 * files are on their input, and the input's handlers have run.
 *
 * @param {BrowsingContext} bc
 * @param {(result: number, info: {folder: boolean, confirmed: boolean, input: ?HTMLInputElement}) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onChooserAnswered(bc, fn) {
  const id = bc?.id;
  if (!id) {
    return () => {};
  }
  let fns = waiting.get(id);
  if (!fns) {
    fns = new Set();
    waiting.set(id, fns);
  }
  fns.add(fn);
  return () => {
    fns.delete(fn);
    if (!fns.size && waiting.get(id) === fns) {
      waiting.delete(id);
    }
  };
}

