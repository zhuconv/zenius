// Downloads from agent tabs (zen-observe): no panel, no toolbar animation,
// nothing in ~/Downloads or in history. Each file lands in its own folder
// under the profile's zenius-downloads until the agent reads or deletes it.
//
// Three hooks:
//  1. The tab's downloadFolderOverride puts the .part file in our directory.
//  2. The final file comes from nsIHelperAppLauncherDialog's
//     promptForSaveToFileAsync() even when nothing is shown; for agent tabs
//     we answer it with our own path, and show() never opens its window.
//  3. Download objects for agent tabs never join the public list, which the
//     panel, the animation, history and the session store all watch.

import { reportRefused } from "chrome://userscripts/content/zenius/observe/refusals.sys.mjs";
import { cut } from "chrome://userscripts/content/zenius/observe/textcap.sys.mjs";

const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
const { DownloadPaths } = ChromeUtils.importESModule("resource://gre/modules/DownloadPaths.sys.mjs");
const { nsUnknownContentTypeDialog } = ChromeUtils.importESModule("resource://gre/modules/HelperAppDlg.sys.mjs");
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  DownloadIntegration: "resource://gre/modules/DownloadIntegration.sys.mjs",
  PdfJsParent: "resource://pdf.js/PdfJsParent.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

// What a task's downloads may hold at once: page script can start downloads
// without end, one click can start hundreds, and each one fills the disk.
// Prefs, for a user who needs more.
const MAX_COUNT_PREF = "zenius.observe.downloads.maxCount";
const MAX_MIB_PREF = "zenius.observe.downloads.maxMiB";
const DEFAULT_MAX_COUNT = 50;
const DEFAULT_MAX_MIB = 1024;
const MiB = 1024 * 1024;

function limits() {
  return {
    count: Math.max(0, Services.prefs.getIntPref(MAX_COUNT_PREF, DEFAULT_MAX_COUNT)),
    mib: Math.max(0, Services.prefs.getIntPref(MAX_MIB_PREF, DEFAULT_MAX_MIB)),
  };
}

/**
 * @typedef {object} DownloadEntry
 * @property {string} id
 * @property {object} download          Gecko's Download
 * @property {number} browserId
 * @property {number|undefined} spaceId
 * @property {string|undefined} page
 * @property {string} url
 * @property {string} suggestedFilename
 * @property {string} dir               this download's own folder
 * @property {object|null} owner        the connection that received it
 * @property {Set<() => void>} changes
 * @property {string} [refusal]          why zenius stopped it, once it did
 * @property {boolean} [checked]         its finished file was checked to be zenius's own
 */

/** @type {Map<string, DownloadEntry>} */
const entries = new Map();
/** @type {Set<{browserId: number, resolve: (e: DownloadEntry) => void}>} */
const waiters = new Set();
/** @type {Set<(e: DownloadEntry) => void>} */
const downloadListeners = new Set();
let seq = 0;
let agentBrowser = _browser => false;
let pageOf = _browser => null;
let installed = false;

// Agent downloads land under the profile, in <profile>/zenius-downloads
// (0700, made afresh at each start), each in a folder of its own inside
// (d<random>, 0700). The browser writes them outside any agent's sandbox, so
// the whole path must be out of the agent's reach too. The temp folder isn't:
// a sandboxed CLI may write it (Codex's workspace-write can), and a link it
// put in place of one of these folders would have the browser write a site's
// bytes wherever the link points, or the cleanup delete there. No sandboxed
// CLI writes the profile. Every folder is made exclusively, and before the
// browser writes and after, each folder and file is checked to be zenius's
// own, with no link in its place or above it. Those checks are only a
// backstop: a path can't be checked and used in one step.
const ROOT_NAME = "zenius-downloads";
let root = null;
/** `root` with every link resolved, at its making: what each check compares with. */
let realRoot = null;
/** Settles with `root` once installDownloads has made it. */
let rootReady = null;

/** This run's directory for agent downloads; null until installDownloads has made it. */
export function downloadRoot() {
  return root;
}

async function readyRoot() {
  if (!rootReady) {
    throw new Error("agent downloads aren't installed");
  }
  return rootReady;
}

function localFile(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}

/** What is at `path` itself, a link never followed: "link", "dir", "file", "other", or null for nothing. */
function entryKind(path) {
  const file = localFile(path);
  try {
    if (file.isSymlink()) {
      return "link";
    }
  } catch (e) {
    return e.result === Cr.NS_ERROR_FILE_NOT_FOUND ? null : "other";
  }
  try {
    return file.isDirectory() ? "dir" : file.isFile() ? "file" : "other";
  } catch {
    return "other";
  }
}

/** `path` with every link resolved, or null when it doesn't resolve. */
function resolved(path) {
  try {
    const file = localFile(path);
    file.normalize();
    return file.path;
  } catch {
    return null;
  }
}

/**
 * Why `path` isn't zenius's own `kind` ("dir" or "file") that resolves to
 * `real`, or null: a link in its place, or one above it, fails it.
 */
function notOwn(path, kind, real) {
  const found = entryKind(path);
  if (found !== kind) {
    return found === "link" ? "a link stood in its place" : found ? "something else stood in its place" : "it was gone";
  }
  return resolved(path) === real ? null : "a link above it led elsewhere";
}

/**
 * Make the root afresh: what a start does. The last run's downloads are
 * stale, and no other run shares the profile. IOUtils.remove unlinks a
 * link, here or anywhere inside, and never follows one (nsIFile::Remove
 * looks at each entry with lstat). Exported for tests, which call it while
 * they hold no download.
 */
export async function remakeDownloadRoot() {
  const path = PathUtils.join(PathUtils.profileDir, ROOT_NAME);
  root = null;
  realRoot = null;
  await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
  await IOUtils.makeDirectory(path, { createAncestors: false, ignoreExisting: false, permissions: 0o700 });
  // The profile's own path may hold links (a home folder on a link, say).
  const profile = resolved(PathUtils.profileDir);
  const real = profile && PathUtils.join(profile, ROOT_NAME);
  const why = real ? notOwn(path, "dir", real) : "the profile's folder didn't resolve";
  if (why) {
    throw new Error(`zenius's download folder isn't its own: ${why}`);
  }
  root = path;
  realRoot = real;
  return root;
}

/**
 * Remove what the root holds that no download does (a folder a refusal
 * left while the root wasn't zenius's own, say), and nothing outside it.
 * Tests and zen-snapshot's staging-probe call it while no download starts.
 *
 * Earlier versions kept the root in the temp folder
 * (zenius-downloads-<hash>, -1, …). Those stay there for install.sh's
 * uninstall and the system's temp cleanup. Removing one, in place or after
 * moving it into the profile, recurses through folders that an agent which
 * writes the temp folder, or is already inside one, can still change.
 * nsLocalFile::Remove checks a folder with lstat, then opens it by path, so
 * a folder swapped for a link in between has the link's target emptied.
 * Removing only their plain files has the same flaw: each is reached through
 * a folder that can be swapped.
 */
export async function sweepDownloadLeftovers() {
  const into = await readyRoot();
  if (notOwn(into, "dir", realRoot)) {
    return;
  }
  const held = new Set([...entries.values()].map(e => e.dir));
  let children = [];
  try {
    children = await IOUtils.getChildren(into, { ignoreAbsent: true });
  } catch (e) {
    console.warn("[zenius] couldn't list the download folder for leftovers", e);
    return;
  }
  for (const path of children) {
    if (!held.has(path)) {
      await IOUtils.remove(path, { recursive: true, ignoreAbsent: true }).catch(e =>
        console.warn("[zenius] couldn't remove a download leftover", e.message)
      );
    }
  }
}

function agentBrowserFor(browsingContextId) {
  try {
    const browser = BrowsingContext.get(browsingContextId)?.top?.embedderElement;
    return browser && agentBrowser(browser) ? browser : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {(browser: Element) => boolean} opts.isAgent  tabs whose downloads we take
 * @param {(browser: Element) => {spaceId: number, label: string}|null} opts.pageOf
 */
export async function installDownloads({ isAgent, pageOf: findPage }) {
  agentBrowser = isAgent;
  pageOf = findPage;
  if (installed) {
    return;
  }
  installed = true;
  rootReady = remakeDownloadRoot();
  // Without a root, the hooks still go in: agent downloads are refused.
  await rootReady.catch(e => console.error("[zenius] agent downloads have no folder; each is refused", e));

  const proto = nsUnknownContentTypeDialog.prototype;
  const originalPrompt = proto.promptForSaveToFileAsync;
  const originalShow = proto.show;
  proto.promptForSaveToFileAsync = function (launcher, _context, defaultName, extension) {
    const browser = agentBrowserFor(launcher.browsingContextId);
    if (!browser) {
      return originalPrompt.apply(this, arguments);
    }
    // Until it has a destination, the launcher's file is Gecko's own
    // temporary one, made exclusively under a random name in the tab's
    // download folder (wherever a link there led). Its cancel keeps it once
    // the response has ended (measured), so a refusal removes it.
    let temp = null;
    let url = "";
    try {
      temp = launcher.targetFile?.path ?? null;
      url = launcher.source?.spec ?? "";
    } catch {}
    const refuse = message => {
      launcher.saveDestinationAvailable(null);
      if (temp) {
        IOUtils.remove(temp, { ignoreAbsent: true }).catch(() => {});
      }
      refused(browser, message, url);
    };
    // Fail closed: Gecko began this one outside zenius's folder, so the tab
    // had no override (a new top context zenius hadn't set, say). Answering
    // would have Gecko move that file into the folder and go on writing
    // through it.
    if (!temp || !root || PathUtils.parent(temp) !== root) {
      refuse(outsideRefusal(url));
      prepareBrowser(browser);
      return undefined;
    }
    targetFile(defaultName, extension).then(
      file => launcher.saveDestinationAvailable(file),
      e => refuse(stagingRefusal(url, e))
    );
    return undefined;
  };
  proto.show = function (launcher) {
    if (!agentBrowserFor(launcher.browsingContextId)) {
      return originalShow.apply(this, arguments);
    }
    // Save without asking; this calls promptForSaveToFileAsync above.
    launcher.promptForSaveDestination();
    return undefined;
  };

  // pdf.js's download button and its Cmd+S save through its parent actor
  // with saveURL(…, aSkipPrompt = false), which always asks for a file in a
  // Save As picker and makes a transfer that names no tab. For agent tabs,
  // save it as an agent download instead: no picker, the same events.
  const originalSaveURL = lazy.PdfJsParent.prototype._saveURL;
  lazy.PdfJsParent.prototype._saveURL = function (message) {
    let browser = null;
    try {
      browser = this.browser;
    } catch {}
    if (!browser || !agentBrowser(browser)) {
      return originalSaveURL.call(this, message);
    }
    savePdfForAgent(browser, message.data ?? {}).catch(e => console.error("[zenius] pdf.js save failed", e));
    return undefined;
  };

  const list = await Downloads.getList(Downloads.ALL);
  guardSpamProtection();
  listMade = true;
  syncBlockedDownloads();
  syncContextWatch();
  const originalAdd = list.add;
  list.add = async function (download) {
    const browser = agentBrowserFor(download?.source?.browsingContextId);
    if (!browser) {
      return originalAdd.call(this, download);
    }
    register(browser, download);
    return undefined;
  };
}

/**
 * Firefox lets a site start one download without a click; it cancels the
 * next ones and shows them as blocked in the downloads panel of the tab's
 * window, opening the panel or flashing the window. For an agent tab that
 * is the user's window (I1). The downloads module's observer was added when
 * the list above was made; ours comes later, so it runs first (observers run
 * newest first), and has the panel's update pass over the agent's.
 */
let spamSkip = null;
function guardSpamProtection() {
  let protection = null;
  try {
    lazy.DownloadIntegration._initializeDownloadSpamProtection();
    protection = lazy.DownloadIntegration.downloadSpamProtection;
  } catch {}
  if (typeof protection?.update !== "function") {
    console.warn("[zenius] no download spam protection to guard");
    return;
  }
  const originalUpdate = protection.update;
  protection.update = function (url, window) {
    const skip = spamSkip;
    spamSkip = null;
    if (skip && skip.url === url && skip.window === window && ChromeUtils.now() - skip.at < 1000) {
      return undefined;
    }
    return originalUpdate.apply(this, arguments);
  };
}

/** Firefox blocked a site's second download without a click. */
function blockedDownload(subject, _topic, site) {
  let browser = null;
  try {
    browser = subject?.top?.embedderElement ?? null;
  } catch {}
  if (!browser || !agentBrowser(browser)) {
    return;
  }
  spamSkip = { url: site, window: subject.topChromeWindow, at: ChromeUtils.now() };
  refused(
    browser,
    `Firefox blocked another download from ${cut(String(site), 256)}: a site may start only one download without a click. Click what starts the download (page.click) instead.`,
    String(site)
  );
}

let blockedWanted = false;
let blockedActive = false;
let listMade = false;

/**
 * Hear Firefox's blocked downloads, or stop: only while a task has pages
 * (observe/setup.sys.mjs, I4), since only an agent tab's matter.
 */
export function setDownloadsActive(on) {
  blockedWanted = !!on;
  syncBlockedDownloads();
  syncContextWatch();
}

function syncBlockedDownloads() {
  // Ours goes in only after the downloads module's own observer, which
  // comes with the list (installDownloads), so that ours runs first.
  const want = blockedWanted && listMade;
  if (want === blockedActive) {
    return;
  }
  blockedActive = want;
  if (want) {
    Services.obs.addObserver(blockedDownload, "blocked-automatic-download");
  } else {
    Services.obs.removeObserver(blockedDownload, "blocked-automatic-download");
  }
}

/** For tests: are the blocked-download observer and the one that sets a new context's folder on? "partly" when only one is. */
export function downloadsActive() {
  return blockedActive === watchingContexts ? blockedActive : "partly";
}

/** Tell the agent, its waits for a download included. */
function refused(browser, message, url) {
  reportRefused(browser, "download", message, url);
  for (const w of waiters) {
    if (w.browserId === browser.browserId) {
      waiters.delete(w);
      w.resolve({ refused: message });
      break;
    }
  }
}

/** Cancel a download and remove what it wrote, its own folder under ours included. */
async function discard(download) {
  await download.cancel().catch(() => {});
  await download.finalize(true).catch(() => {});
  await removeOwnFolder(download.target?.path ? PathUtils.parent(download.target.path) : null);
}

/**
 * Remove a download's folder: only one directly in the root, and only while
 * the root is still zenius's own, so the path can't lead elsewhere.
 * IOUtils.remove unlinks a link in the folder's place, or inside, and never
 * follows one.
 */
async function removeOwnFolder(dir) {
  if (!root || !dir || PathUtils.parent(dir) !== root) {
    return;
  }
  const why = notOwn(root, "dir", realRoot);
  if (why) {
    console.warn("[zenius] left a download's folder: the download folder isn't zenius's own", why);
    return;
  }
  await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true }).catch(() => {});
}

/** What the agent is told when a download's folder isn't zenius's own (`why`: a string or an Error). */
function stagingRefusal(url, why) {
  const reason = typeof why === "string" ? why : why?.staging;
  return `zenius refused a download from ${cut(String(url), 256)}: the folder it keeps downloads in had changed${reason ? ` (${reason})` : ""}, so the file could have landed somewhere else. Nothing was saved. Something other than zenius is changing Zen's profile folder; tell the user.`;
}

/** What the agent is told when Gecko began a download outside zenius's folder. */
function outsideRefusal(url) {
  return `zenius refused a download from ${cut(String(url), 256)}: the browser began it outside the folder zenius keeps downloads in, so zenius canceled it before saving anything. Start it again: the tab uses that folder now.`;
}

/** An Error whose `staging` says why a download's folder isn't zenius's own. */
function stagingError(why) {
  return Object.assign(new Error(`zenius's download folder changed: ${why}`), { staging: why });
}

/**
 * Why a download's file at `target` isn't where zenius put it, or null: in
 * a folder of its own directly in the root, both zenius's own, with no link
 * in the file's place or its .part's (the browser opens the .part, and its
 * final move puts the file into a folder a link there points to).
 */
function stagingFault(target) {
  if (!root || !realRoot) {
    return "zenius has no download folder";
  }
  const dir = typeof target === "string" ? PathUtils.parent(target) : null;
  if (!dir || PathUtils.parent(dir) !== root) {
    return "the file was going elsewhere";
  }
  return (
    notOwn(root, "dir", realRoot) ??
    notOwn(dir, "dir", PathUtils.join(realRoot, PathUtils.filename(dir))) ??
    (entryKind(target) === "link" || entryKind(`${target}.part`) === "link" ? "a link stood in the file's place" : null)
  );
}

/** Why a finished download's file isn't the one zenius staged, or null: a plain file, not a link, in its own folder. */
function finishedFault(entry) {
  const target = entry.download.target.path;
  return (
    stagingFault(target) ??
    notOwn(target, "file", PathUtils.join(realRoot, PathUtils.filename(PathUtils.parent(target)), PathUtils.filename(target)))
  );
}

/** The download fails with the reason, its files go, and the agent is told. */
function refuseStaged(entry, why) {
  if (entry.refusal) {
    return;
  }
  entry.refusal = stagingRefusal(entry.url, why);
  const browser = BrowsingContext.getCurrentTopByBrowserId(entry.browserId)?.embedderElement;
  discard(entry.download);
  if (browser) {
    refused(browser, entry.refusal, entry.url);
  }
}

/**
 * The finished file's path, while it's still the one zenius staged: no
 * link in its place or above it. Otherwise null, and the download fails
 * with the reason (a backstop: a link there would have download.read hand
 * the agent a file from outside its sandbox, I5).
 */
export function finishedFile(entry) {
  const why = finishedFault(entry);
  if (why) {
    refuseStaged(entry, why);
    return null;
  }
  return entry.download.target.path;
}

/** The downloads a task holds now and their bytes so far; refused ones hold nothing. */
function usageOf(spaceId) {
  let count = 0;
  let bytes = 0;
  for (const e of entries.values()) {
    if (e.spaceId === spaceId && !e.refusal) {
      count++;
      bytes += Math.max(0, Number(e.download.currentBytes) || 0);
    }
  }
  return { count, bytes };
}

function limitText(url, why) {
  return `zenius refused a download from ${cut(String(url), 256)}: ${why}. Save the downloads the task needs (download.saveAs() or download.path()), then delete them with download.delete() to make room, or ask the user to raise the limit.`;
}

/** Why a new download would take its task past a limit, or null. */
function overOnStart(spaceId, download) {
  const { count, mib } = limits();
  const usage = usageOf(spaceId);
  if (usage.count >= count) {
    return `the task holds ${usage.count} downloads, the most it may (${MAX_COUNT_PREF})`;
  }
  const expected = download.hasProgress ? Math.max(0, Number(download.totalBytes) || 0) : 0;
  if (usage.bytes + expected > mib * MiB) {
    return `it would take the task's downloads past ${mib} MiB (${MAX_MIB_PREF})`;
  }
  return null;
}

/** Why a running download has taken, or will take, its task past the byte limit, or null. */
function overWhileRunning(entry) {
  const { mib } = limits();
  const usage = usageOf(entry.spaceId);
  const d = entry.download;
  const own = Math.max(0, Number(d.currentBytes) || 0);
  const expected = d.hasProgress ? Math.max(own, Number(d.totalBytes) || 0) : own;
  if (usage.bytes - own + expected > mib * MiB) {
    return `it would take the task's downloads past ${mib} MiB (${MAX_MIB_PREF})`;
  }
  return null;
}

/**
 * A file for one download, in a folder made for it alone, checked just
 * before the browser gets its path: the root and the folder are zenius's
 * own, and nothing is yet where the file or its .part goes. Rejects with a
 * stagingError otherwise.
 */
async function targetFile(defaultName, extension) {
  const base = await readyRoot().catch(() => {
    throw stagingError("zenius has no download folder");
  });
  const name = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const dir = PathUtils.join(base, name);
  const before = notOwn(base, "dir", realRoot);
  if (before) {
    throw stagingError(before);
  }
  // Exclusively: anything already there, a link included, fails it.
  try {
    await IOUtils.makeDirectory(dir, { createAncestors: false, ignoreExisting: false, permissions: 0o700 });
  } catch {
    throw stagingError("something stood where a download's folder goes");
  }
  const leaf = DownloadPaths.sanitize(defaultName || "", { compressWhitespaces: true }) || `download${extension || ""}`;
  const path = PathUtils.join(dir, leaf);
  const why = stagingFault(path) ?? (entryKind(path) || entryKind(`${path}.part`) ? "something stood where the file goes" : null);
  if (why) {
    // Links planted in it are unlinked, never followed.
    await removeOwnFolder(dir);
    throw stagingError(why);
  }
  return localFile(path);
}

/** pdf.js's save of the PDF it shows (its edits included), as an agent download. */
async function savePdfForAgent(browser, { blobUrl, originalUrl, filename }) {
  if (typeof blobUrl !== "string" || !blobUrl) {
    return;
  }
  const url = originalUrl || blobUrl;
  let file = null;
  try {
    file = await targetFile(filename, ".pdf");
  } catch (e) {
    refused(browser, stagingRefusal(url, e), url);
  }
  try {
    if (!file) {
      return;
    }
    const download = await Downloads.createDownload({
      source: {
        url: blobUrl,
        isPrivate: lazy.PrivateBrowsingUtils.isBrowserPrivate(browser),
        browsingContextId: browser.browsingContext?.id,
        userContextId: browser.browsingContext?.originAttributes?.userContextId ?? 0,
      },
      target: file.path,
    });
    const entry = register(browser, download, { url, suggestedFilename: PathUtils.filename(file.path) });
    // A refused one is canceled already, and start() would restart it. Its
    // failure is the agent's to read (download.failure()).
    if (entry) {
      await download.start().catch(() => {});
    }
  } finally {
    if (blobUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {}
    }
    Services.obs.notifyObservers(null, "pdfjs:saveComplete");
  }
}

/** Make the tab's .part files land in our directory. Cheap; call often. */
export function prepareBrowser(browser) {
  if (!root) {
    rootReady?.then(() => prepareBrowser(browser), () => {});
    return;
  }
  const bc = browser?.browsingContext;
  if (!bc) {
    return;
  }
  preparedIds.add(bc.browserId);
  if (bc.downloadFolderOverride !== root) {
    try {
      bc.downloadFolderOverride = root;
    } catch {}
  }
}

/** browserIds of the agent tabs prepareBrowser set, for their new top contexts. */
const preparedIds = new Set();

/**
 * A cross-site load can replace a tab's top BrowsingContext (Gecko 160's
 * fission.bfcacheInParent), and the new one starts with no
 * downloadFolderOverride: CanonicalBrowsingContext::ReplacedBy doesn't carry
 * it over. A download the new page started before zenius's next call then had
 * its temporary file in Gecko's default folder, the user's Downloads. So an
 * agent tab's new top context gets the override as it attaches, before its
 * first load; so does a new tab an agent tab opened. The prompt fails closed
 * for anything this misses.
 */
function contextAttached(bc) {
  try {
    if (!root || bc.parent || !bc.isContent) {
      return;
    }
    // A replacement attaches while the old context still holds the tab.
    const browser = bc.embedderElement ?? BrowsingContext.getCurrentTopByBrowserId(bc.browserId)?.embedderElement ?? null;
    const opener = bc.opener?.top?.embedderElement ?? null;
    const agents = browser ? agentBrowser(browser) : preparedIds.has(bc.browserId);
    if (agents || (opener && agentBrowser(opener))) {
      bc.downloadFolderOverride = root;
    }
  } catch (e) {
    console.error("[zenius] setting a new context's download folder failed", e);
  }
}

let watchingContexts = false;

/** browsing-context-attached comes for every new frame and tab, the user's own included: heard only while a task has pages (I4). */
function syncContextWatch() {
  const want = blockedWanted && installed;
  if (want === watchingContexts) {
    return;
  }
  watchingContexts = want;
  if (want) {
    Services.obs.addObserver(contextAttached, "browsing-context-attached");
  } else {
    Services.obs.removeObserver(contextAttached, "browsing-context-attached");
  }
}

/**
 * Track an agent tab's download. `source` overrides what the agent is told
 * (a pdf.js save downloads a blob: URL, but came from the PDF's URL).
 *
 * @returns {DownloadEntry|null} null when it took the task past a limit
 */
function register(browser, download, source = {}) {
  download.launchWhenSucceeded = false;
  const page = pageOf(browser);
  const url = source.url ?? download.source.url;
  // The folder may have changed since targetFile checked it.
  const misplaced = stagingFault(download.target?.path);
  if (misplaced) {
    discard(download);
    refused(browser, stagingRefusal(url, misplaced), url);
    return null;
  }
  const over = overOnStart(page?.spaceId, download);
  if (over) {
    // Never the agent's: no download to read, only the refusal.
    discard(download);
    refused(browser, limitText(url, over), url);
    return null;
  }
  const entry = {
    id: `download-${++seq}`,
    download,
    browserId: browser.browserId,
    spaceId: page?.spaceId,
    page: page?.label,
    url,
    suggestedFilename: source.suggestedFilename ?? PathUtils.filename(download.target.path),
    dir: PathUtils.parent(download.target.path),
    owner: null,
    changes: new Set(),
  };
  // Nobody else watches this download: it is on no list.
  download.onchange = () => {
    if (!entry.refusal && !download.stopped) {
      const why = overWhileRunning(entry);
      if (why) {
        // The agent knows this download: it stays, failed with the reason.
        entry.refusal = limitText(entry.url, why);
        discard(download);
        refused(browser, entry.refusal, entry.url);
      }
    }
    if (!entry.refusal && download.succeeded && !entry.checked) {
      entry.checked = true;
      finishedFile(entry);
    }
    for (const fn of entry.changes) {
      fn();
    }
  };
  entries.set(entry.id, entry);
  for (const fn of downloadListeners) {
    try {
      fn(entry);
    } catch (e) {
      console.error("[zenius] download listener failed", e);
    }
  }
  for (const w of waiters) {
    if (w.browserId === entry.browserId) {
      waiters.delete(w);
      w.resolve(entry);
      break;
    }
  }
  return entry;
}

/**
 * Arm a wait for the tab's next download, synchronously (the SDK sends the
 * wait before the action that starts the download).
 *
 * @returns {{promise: Promise<DownloadEntry|null>, cancel: () => void}} null on timeout
 */
export function waitForDownload(browserId, timeoutMs) {
  let waiter;
  let timer;
  const promise = new Promise(resolve => {
    waiter = {
      browserId,
      resolve: entry => {
        clearTimeout(timer);
        resolve(entry);
      },
    };
    waiters.add(waiter);
    timer = setTimeout(() => {
      waiters.delete(waiter);
      resolve(null);
    }, Math.max(0, timeoutMs));
  });
  return {
    promise,
    cancel() {
      clearTimeout(timer);
      waiters.delete(waiter);
    },
  };
}

/** `fn(entry)` for every download from an agent tab. */
export function onDownload(fn) {
  downloadListeners.add(fn);
  return () => downloadListeners.delete(fn);
}

/** @returns {DownloadEntry|null} */
export function getDownload(id) {
  return entries.get(String(id)) ?? null;
}

/** Resolve once the download succeeded, failed or was canceled. */
export function whenStopped(entry) {
  if (entry.download.stopped) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const check = () => {
      if (entry.download.stopped) {
        entry.changes.delete(check);
        resolve();
      }
    };
    entry.changes.add(check);
  });
}

/** Gecko's failure text, zenius's refusal, "canceled", or null while fine. */
export function failureOf(entry) {
  if (entry.refusal) {
    return entry.refusal;
  }
  const d = entry.download;
  if (d.succeeded) {
    return null;
  }
  if (d.canceled) {
    return "canceled";
  }
  if (d.error) {
    return d.error.message || String(d.error);
  }
  return null;
}

export async function cancelDownload(entry) {
  const d = entry.download;
  if (d.stopped) {
    return;
  }
  await d.cancel().catch(() => {});
  await d.finalize(true).catch(() => {});
}

/** Remove the download's files and forget it. */
export async function deleteDownload(entry) {
  entries.delete(entry.id);
  entry.owner?.state?.zeniusDownloads?.delete(entry);
  await cancelDownload(entry);
  await removeOwnFolder(entry.dir);
}

/** A finished task's downloads go, files and all, whoever received them. */
export async function deleteTaskDownloads(spaceId) {
  await Promise.all([...entries.values()].filter(e => e.spaceId === spaceId).map(deleteDownload));
}

/** For tests and the SPI: what a task's downloads hold now. */
export function taskDownloads(spaceId) {
  return usageOf(spaceId);
}

/**
 * Tie a download to the connection that received it: when that connection
 * closes, its temporary files go (a promise the SDK's guide makes).
 */
export function claimDownload(entry, conn) {
  if (!conn || entry.owner) {
    return;
  }
  entry.owner = conn;
  const state = conn.state;
  if (!state.zeniusDownloads) {
    state.zeniusDownloads = new Set();
    (state.onClose ??= []).push(() => {
      for (const owned of state.zeniusDownloads) {
        deleteDownload(owned);
      }
      state.zeniusDownloads.clear();
    });
  }
  state.zeniusDownloads.add(entry);
}

/** Delete unclaimed downloads of tabs that are gone. */
export function sweepDownloads() {
  for (const entry of entries.values()) {
    if (!entry.owner && !BrowsingContext.getCurrentTopByBrowserId(entry.browserId)) {
      deleteDownload(entry);
    }
  }
}
