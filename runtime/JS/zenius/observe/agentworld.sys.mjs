// The agent's code in an isolated world, parent side (the observe layer).
//
// The hooks the others call:
// - isWritten(target): did the agent's world write into the page, its top
//   document or a frame? The core reloads a written page before the user
//   types there; the UI and the core decide refusals after the task by it.
// - onWritten(fn): a document of a page became written.
// - discard(target): end the agent's worlds that could reach the page (its
//   group, every process), or every world of a task, and the workers they
//   started. The core calls it at a hand-off and at the task's end.
// - urlBefore(target): where a clean load of the page goes: the URL it had
//   before the agent's code changed it in place (pushState, replaceState,
//   the hash), while it still shows the agent's; null for its current one.
// The flags are per document (innerWindowId), so a reload or a new load
// starts clean. Content reads them from sharedData (content/agentworld.sys.mjs),
// and tells this module of writes it saw by the "zenius:written" message.

import { MADE_DOCS_KEY, WORLD_URL, WRITTEN_DOCS_KEY } from "chrome://userscripts/content/zenius/content/worldkeys.sys.mjs";
import { AGENT_CODE_DOCS_KEY, TASK_SPACES_KEY } from "chrome://userscripts/content/zenius/content/refusals.sys.mjs";
import { AGENT_BROWSERS_KEY } from "chrome://userscripts/content/zenius/content/guards.sys.mjs";
import { markEvident, onEvidentMessage } from "chrome://userscripts/content/zenius/observe/evidence.sys.mjs";

const lazy = {};
// Loaded only once a document is marked: the user's own pages never load it (I4).
ChromeUtils.defineESModuleGetters(lazy, {
  forgetWorldMarks: "chrome://userscripts/content/zenius/observe/agentcode.sys.mjs",
});

/** Writes are tracked: isWritten answers for the agent's world (the UI and the core key on it). */
export const tracksWrites = true;

/** Written documents (innerWindowId) → their tab's browserId. */
const written = new Map();
/** Documents (innerWindowId) whose URL the agent's code changed in place → {before, agentSet}. */
const agentURLs = new Map();
/** Top documents the agent made (innerWindowId) → their tab's browserId. */
const made = new Map();
const writtenListeners = new Set();

/** The tab's top BrowsingContext for a <browser>, a WindowGlobalParent or a BrowsingContext. */
function topOf(target) {
  try {
    const bc = target?.browsingContext ?? target;
    return bc?.top ?? null;
  } catch {
    return null;
  }
}

/** Forget the documents (innerWindowId → browserId) whose tab is gone. */
function dropClosedTabs(docs) {
  for (const [id, browserId] of docs) {
    if (!BrowsingContext.getCurrentTopByBrowserId(browserId)) {
      docs.delete(id);
    }
  }
}

function publish(key, docs) {
  dropClosedTabs(docs);
  Services.ppmm.sharedData.set(key, new Set(docs.keys()));
  Services.ppmm.sharedData.flush();
}

/**
 * Does the page hold writes the agent's world made: its current top
 * document, or any of its frames'? False once the top document is replaced.
 *
 * @param {Element|WindowGlobalParent|BrowsingContext} target  the page's
 *   <browser>, or any document or BrowsingContext in its tree
 * @returns {boolean}
 */
export function isWritten(target) {
  const top = topOf(target);
  if (!top || !written.size) {
    return false;
  }
  try {
    return top.getAllBrowsingContextsInSubtree().some(bc => written.has(bc.currentWindowGlobal?.innerWindowId));
  } catch {
    return false;
  }
}

/**
 * `fn({browser, innerWindowId})` once per document, when a document of a page
 * first becomes written.
 *
 * @returns {() => void} unsubscribe
 */
export function onWritten(fn) {
  writtenListeners.add(fn);
  return () => writtenListeners.delete(fn);
}

/**
 * Content saw the agent's world write into these documents of `bc`'s tab,
 * and, in `urls`, change their URLs in place (the core's glue). Flags only
 * ever get added from content: a forged one costs a reload.
 *
 * @param {BrowsingContext} bc  any BrowsingContext of the tab
 * @param {number[]} innerWindowIds
 * @param {Record<string, {before: string, agentSet: string}>} [urls]
 *   innerWindowId → the URL before the change and the one the agent set;
 *   recorded even for a document already written, or none (a navigation
 *   through the world's location facade writes nothing)
 */
export function noteWritten(bc, innerWindowIds, urls = {}) {
  const top = topOf(bc);
  if (!top?.browserId) {
    return;
  }
  noteURLs(top, urls);
  const fresh = innerWindowIds.filter(id => Number.isSafeInteger(id) && id > 0 && !written.has(id));
  if (!fresh.length) {
    return;
  }
  for (const id of fresh) {
    written.set(id, top.browserId);
  }
  publish(WRITTEN_DOCS_KEY, written);
  const browser = top.embedderElement ?? null;
  for (const id of fresh) {
    for (const fn of writtenListeners) {
      try {
        fn({ browser, innerWindowId: id });
      } catch (e) {
        console.error("[zenius] a written listener failed", e);
      }
    }
  }
}

/** Record the URL changes of `top`'s own documents, chaining the agent's consecutive ones. */
function noteURLs(top, urls) {
  for (const [key, rec] of Object.entries(urls ?? {})) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || typeof rec?.before !== "string" || typeof rec?.agentSet !== "string") {
      continue;
    }
    let inTab = false;
    try {
      inTab = WindowGlobalParent.getByInnerWindowId(id)?.browsingContext.top === top;
    } catch {}
    if (!inTab) {
      continue;
    }
    // A -> B, then B -> C: the last URL the agent didn't set is still A.
    const known = agentURLs.get(id);
    const before = known && known.agentSet === rec.before ? known.before : rec.before;
    agentURLs.set(id, { before, agentSet: rec.agentSet });
  }
  // A closed tab's documents go with it.
  for (const id of agentURLs.keys()) {
    if (!WindowGlobalParent.getByInnerWindowId(id)) {
      agentURLs.delete(id);
    }
  }
}

/**
 * Where a clean load of the page should go, for Take over: the URL its top
 * document had before the agent's code changed it in place, while it still
 * shows the URL the agent's code set.
 * Null when the current URL is the one to load: the agent never changed it,
 * or the site's own routing moved on since.
 *
 * @param {Element|WindowGlobalParent|BrowsingContext} target
 * @returns {string|null}
 */
export function urlBefore(target) {
  const top = topOf(target);
  const wgp = top?.currentWindowGlobal;
  const known = wgp && agentURLs.get(wgp.innerWindowId);
  if (!known) {
    return null;
  }
  let now = null;
  try {
    now = wgp.documentURI?.spec ?? null;
  } catch {}
  if (now === null || now !== known.agentSet) {
    return null;
  }
  // pushState, replaceState and a hash keep a document on its origin, so a
  // URL on another one didn't come from them: the parent never loads it.
  try {
    const [was, is] = [new URL(known.before), new URL(now)];
    return /^https?:$/.test(was.protocol) && was.origin === is.origin ? known.before : null;
  } catch {
    return null;
  }
}

/**
 * The agent made the page's current top document: page.goto or a reload to
 * data: or blob: (methods/navigation.sys.mjs). The input layer's guard can drop
 * the user's keys there.
 *
 * @param {BrowsingContext} bc
 */
export function noteMade(bc) {
  const top = topOf(bc);
  const id = top?.currentWindowGlobal?.innerWindowId;
  if (!id || made.has(id)) {
    return;
  }
  made.set(id, top.browserId);
  publish(MADE_DOCS_KEY, made);
  let scheme = "data";
  try {
    scheme = top.currentWindowGlobal.documentURI?.scheme || scheme;
  } catch {}
  markEvident(top.currentWindowGlobal, "made", `a ${scheme}: page`);
}

/** Was the page's current top document made by the agent (data:, blob:)? */
export function isMade(target) {
  const top = topOf(target);
  return !!top && made.has(top.currentWindowGlobal?.innerWindowId);
}

/** One WindowGlobalParent per content process among the group's documents. */
function onePerProcess(group) {
  const byProcess = new Map();
  try {
    for (const top of group.getToplevels()) {
      for (const bc of top.getAllBrowsingContextsInSubtree()) {
        const wgp = bc.currentWindowGlobal;
        const pid = wgp?.domProcess?.childID;
        if (wgp && pid !== undefined && !byProcess.has(pid)) {
          byProcess.set(pid, wgp);
        }
      }
    }
  } catch {}
  return [...byProcess.values()];
}

/**
 * End the agent's worlds that could reach a page: those of its group, in
 * every process. Or of several pages: the core's finish passes the task's
 * <browser>s, taken before endTask drops them from the task. Or, with
 * `{task}`, those of every page still in a live task, and their groups. The
 * workers the worlds started go with them.
 *
 * @param {Element|BrowsingContext|Array<Element|BrowsingContext>|{task: number}} target
 * @returns {Promise<void>} once each process has done it
 */
export async function discard(target) {
  const groups = new Map();
  const addGroup = top => {
    try {
      const group = top?.group;
      if (group && !groups.has(group.id)) {
        groups.set(group.id, group);
      }
    } catch {}
  };
  if (target && typeof target === "object" && "task" in target) {
    const spaces = Services.ppmm.sharedData.get(TASK_SPACES_KEY);
    for (const [browserId, space] of spaces ?? []) {
      if (space === target.task) {
        addGroup(BrowsingContext.getCurrentTopByBrowserId(browserId));
      }
    }
  } else {
    for (const each of Array.isArray(target) ? target : [target]) {
      addGroup(topOf(each));
    }
  }
  const calls = [];
  for (const [id, group] of groups) {
    // A world busy in a loop takes the discard only once it stops: it
    // stops at its next check (stopAsked in content).
    try {
      for (const top of group.getToplevels()) {
        askStop(top.browserId);
      }
    } catch {}
    for (const wgp of onePerProcess(group)) {
      calls.push(
        wgp
          .getActor("Zenius")
          .sendQuery("call", { module: "agentworld", fn: "discard", args: { group: id } })
          .catch(() => {})
      );
    }
  }
  await Promise.all(calls);
  // The worlds are gone, and so are the marks only they left, unless they
  // wrote into the page.
  if (Services.ppmm.sharedData.get(AGENT_CODE_DOCS_KEY)?.size) {
    for (const group of groups.values()) {
      try {
        for (const top of group.getToplevels()) {
          lazy.forgetWorldMarks(top);
        }
      } catch (e) {
        console.error("[zenius] forgetting the marks of discarded worlds", e);
      }
    }
  }
}

/**
 * A tab left its task (observe/setup.sys.mjs, publishTaskSpaces): kept at
 * the finish, left by a Stop, released. It's the user's now, so the agent's
 * worlds that could reach it end at once, whatever order the task's end ran
 * in (the snapshot layer's sandbox-probe, its kept group).
 *
 * @param {number} browserId
 */
export function discardLeftTab(browserId) {
  // A tab that closes takes its own worlds with its documents. Discarding
  // its group would also end the worlds of the task's other pages in it: an
  // opener whose adopted popup the agent closed, as the eval harness's e2e found.
  // The page leaves the task before its tab starts closing, so wait a turn:
  // by then the agent's close has removed the tab, and the user's is
  // animating it out, marked closing. A tab that is neither stays open
  // (kept, released, or closed while the user views it).
  Services.tm.dispatchToMainThread(() => {
    try {
      const top = BrowsingContext.getCurrentTopByBrowserId(browserId);
      if (!top || top.isDiscarded || tabClosing(top)) {
        return;
      }
      discard(top).catch(e => console.error("[zenius] discarding the worlds of a tab that left its task", e));
    } catch (e) {
      console.error("[zenius] checking a tab that left its task", e);
    }
  });
}

/** Is the tab of this top BrowsingContext closing, or already out of its window? */
function tabClosing(top) {
  try {
    const browser = top.embedderElement;
    if (!browser?.isConnected) {
      return true;
    }
    // Not ownerGlobal: Gecko 160 has no Node.ownerGlobal.
    return !!browser.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser?.(browser)?.closing;
  } catch {
    return false;
  }
}

/**
 * The agent put markup into this document outside its world: the input layer's
 * html paste, which a page's paste handler may insert as live markup
 * (the snapshot layer's pasteHtml). The document counts as written.
 *
 * @param {BrowsingContext} bc  the document's
 */
export function noteWrittenDocument(bc) {
  try {
    const id = bc?.currentWindowGlobal?.innerWindowId;
    if (id) {
      noteWritten(bc, [id]);
    }
  } catch (e) {
    console.error("[zenius] flagging a document the agent pasted into", e);
  }
}

/** What content saw the agent's world write, and the URLs it changed: from the sender's own documents only. */
function onWrittenMessage(msg) {
  const data = msg.data ?? {};
  // Each document must be the sending process's own. A parent message
  // manager's target has no childID in Gecko 160, only osPid; without one,
  // the message counts for nothing, so a process can't flag another site's
  // documents or steer their clean load.
  const pid = msg.target?.osPid;
  if (typeof pid !== "number") {
    return;
  }
  const mine = id => {
    try {
      const wgp = WindowGlobalParent.getByInnerWindowId(id);
      return wgp && wgp.domProcess?.osPid === pid ? wgp : null;
    } catch {
      return null;
    }
  };
  /** Each tab's top → the sender's documents in it that were written, and their URL changes. */
  const byTop = new Map();
  const entry = top => {
    let e = byTop.get(top);
    if (!e) {
      byTop.set(top, (e = { ids: [], urls: {} }));
    }
    return e;
  };
  for (const id of Array.isArray(data.ids) ? data.ids : []) {
    const wgp = Number.isSafeInteger(id) && mine(id);
    if (wgp) {
      entry(wgp.browsingContext.top).ids.push(id);
    }
  }
  for (const [key, rec] of Object.entries(data.urls ?? {})) {
    const id = Number(key);
    const wgp = Number.isSafeInteger(id) && mine(id);
    if (wgp) {
      entry(wgp.browsingContext.top).urls[key] = rec;
    }
  }
  // noteWritten (the core's shape) checks each URL record, chains the
  // agent's consecutive changes and drops closed tabs' records.
  for (const [top, { ids, urls }] of byTop) {
    noteWritten(top, ids, urls);
  }
}


/**
 * A loop in the agent's code that the world's deadline can't see (code its
 * code compiled at run time, or a source too long to rewrite) holds the
 * page's process, and the user's tabs on the site with it. Gecko's
 * slow-script watchdog reports it once the user's input waits on that
 * process for dom.max_script_run_time (10 s): zenius stops the agent's
 * script then, in a task's tab, instead of showing the notice. The site's
 * own scripts are left to the notice.
 */
function onHangReport(subject) {
  let report;
  try {
    report = subject.QueryInterface(Ci.nsIHangReport);
  } catch {
    return;
  }
  let file = "";
  let browserId = null;
  try {
    file = String(report.scriptFileName ?? "");
    browserId = report.scriptBrowser?.browserId ?? null;
  } catch {}
  if (!file.startsWith(WORLD_URL) || !browserId) {
    return;
  }
  const spaces = Services.ppmm.sharedData.get(TASK_SPACES_KEY);
  if (!spaces?.has?.(browserId)) {
    return;
  }
  try {
    report.terminateScript();
  } catch (e) {
    console.error("[zenius] stopping the agent's runaway script", e);
  }
}

/** Tabs (browserId) → when zenius last asked the agent's code there to stop (Date.now()). */
const stopAsks = new Map();
/** A stop asked this long before a run began still ends it: the IPC's lag. */
const STOP_SLACK_MS = 100;

function askStop(browserId) {
  if (!browserId) {
    return;
  }
  const now = Date.now();
  for (const [id, at] of stopAsks) {
    if (at < now - 60_000) {
      stopAsks.delete(id);
    }
  }
  stopAsks.set(browserId, now);
}

/**
 * Stop the agent's code that runs in this tab's worlds now. Gecko's own
 * stop (methods/observe.sys.mjs, stopPageScript) skips a sandbox's script,
 * and a busy world can't take a message: each world asks before it goes on,
 * every 200 ms of a long run (content/agentworld.sys.mjs, stopAsked).
 *
 * @param {Element} browser  the tab's <browser>
 */
export function stopWorldScripts(browser) {
  try {
    askStop(browser?.browserId);
  } catch {}
}

/**
 * A world's sync question: must its code, which has run `turnMs` in this
 * turn, stop? Yes once the agent doesn't drive the tab (the user holds the
 * task, or it ended), or when zenius asked the tab's code to stop after the
 * run began.
 */
function onWorldStop(msg) {
  const { browserId, turnMs } = msg.data ?? {};
  if (!Number.isSafeInteger(browserId) || !Services.ppmm.sharedData.get(AGENT_BROWSERS_KEY)?.has?.(browserId)) {
    return true;
  }
  const asked = stopAsks.get(browserId);
  return asked !== undefined && asked >= Date.now() - Math.max(0, Number(turnMs) || 0) - STOP_SLACK_MS;
}

let listening = false;

/**
 * The parent's ears for the worlds: content's word of written pages, their
 * question whether to go on, and Gecko's hang reports. On only while a
 * task, or a page that keeps the agent's code, needs them (I4;
 * observe/setup.sys.mjs's syncHooks). With them off, a world that asks is
 * told to stop by the silence.
 */
export function setAgentWorldActive(on) {
  if (!!on === listening) {
    return;
  }
  listening = !!on;
  if (listening) {
    Services.ppmm.addMessageListener("zenius:written", onWrittenMessage);
    Services.ppmm.addMessageListener("zenius:evident", onEvidentMessage);
    Services.ppmm.addMessageListener("zenius:worldStop", onWorldStop);
    Services.obs.addObserver(onHangReport, "process-hang-report");
  } else {
    Services.ppmm.removeMessageListener("zenius:written", onWrittenMessage);
    Services.ppmm.removeMessageListener("zenius:evident", onEvidentMessage);
    Services.ppmm.removeMessageListener("zenius:worldStop", onWorldStop);
    Services.obs.removeObserver(onHangReport, "process-hang-report");
    stopAsks.clear();
  }
}

/** Tests: whether the parent's ears for the worlds are on. */
export function agentWorldActive() {
  return listening;
}
