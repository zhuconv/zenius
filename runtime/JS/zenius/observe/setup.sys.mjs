// Installs zen-observe's process-wide hooks once, when the first of its
// method modules loads: dialog interception, download diversion, the network
// observers and the event buffers. They must be in place before any agent
// page runs, since a click from another module can open a dialog or start a
// download.
//
// The observers that see the user's own browsing too (every request, every
// blocked download) run only while they have something of the agent's to
// watch (I4): from the first task page to the last, and for the local network
// also while a page keeps the agent's code after its task. See syncHooks.

import { ZeniusService } from "chrome://userscripts/content/zenius/modules/service.sys.mjs";
import { log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";
import { installDialogs } from "chrome://userscripts/content/zenius/observe/dialogs.sys.mjs";
import { discardLeftTab, setAgentWorldActive } from "chrome://userscripts/content/zenius/observe/agentworld.sys.mjs";
import { installRefusals, reportRefused } from "chrome://userscripts/content/zenius/observe/refusals.sys.mjs";
import { installAudio, noteSound, syncAll, audioHookActive } from "chrome://userscripts/content/zenius/observe/audio.sys.mjs";
import {
  installDownloads,
  sweepDownloads,
  onDownload,
  onDownloadEvent,
  deleteTaskDownloads,
  setDownloadsActive,
  downloadsActive,
} from "chrome://userscripts/content/zenius/observe/downloads.sys.mjs";
import {
  installNetwork,
  sweepNetwork,
  onRequestEvent,
  setNetworkActive,
  networkActive,
} from "chrome://userscripts/content/zenius/observe/network.sys.mjs";
import { installLocalNetwork, setLocalNetworkActive, localNetworkActive } from "chrome://userscripts/content/zenius/observe/localnet.sys.mjs";
import { installDnsPrefetchOff, setDnsPrefetchOffActive, dnsPrefetchOffActive } from "chrome://userscripts/content/zenius/observe/dnsprefetch.sys.mjs";
import { installNavGuard, setNavGuardActive, navGuardActive } from "chrome://userscripts/content/zenius/observe/navguard.sys.mjs";
import { holdOf, holdingAny, onHolds, heldLoadRefused, siteOfURI } from "chrome://userscripts/content/zenius/observe/hold.sys.mjs";
import {
  installServiceWorkerBypass,
  setServiceWorkerBypassActive,
  serviceWorkerBypassActive,
} from "chrome://userscripts/content/zenius/observe/swbypass.sys.mjs";
import { pushEvent, sweepEvents, cdpTime } from "chrome://userscripts/content/zenius/observe/events.sys.mjs";
import { fromSignInResult, tabTopIsSignInResult } from "chrome://userscripts/content/zenius/observe/signin.sys.mjs";
import { redactReferences } from "chrome://userscripts/content/zenius/content/signin.sys.mjs";
import { trackerFor } from "chrome://userscripts/content/zenius/observe/navtracker.sys.mjs";
import { stopCapture } from "chrome://userscripts/content/zenius/observe/capture.sys.mjs";
import {
  sweepAgentCode,
  agentCodeDocument,
  agentCodeBrowserIds,
  agentSitesNear,
  hasAgentCodeMarks,
  onAgentCodeMarks,
} from "chrome://userscripts/content/zenius/observe/agentcode.sys.mjs";
import { AGENT_BROWSERS_KEY, TASK_BROWSERS_KEY } from "chrome://userscripts/content/zenius/content/guards.sys.mjs";
import { TASK_SPACES_KEY } from "chrome://userscripts/content/zenius/content/refusals.sys.mjs";
import { HELD_PAGES_KEY } from "chrome://userscripts/content/zenius/content/taskset.sys.mjs";

let done = false;

/** Does any task have a page now, whoever holds it? */
function taskPagesLive() {
  return (Services.ppmm.sharedData.get(TASK_BROWSERS_KEY)?.size ?? 0) > 0;
}

/**
 * Turn on the observers that see the user's own browsing only while they
 * have something of the agent's to watch: the request observers and the
 * blocked-download one while a task has pages, and the local-network
 * refusal also while a page keeps the agent's code after its task. Called
 * when a task's pages change (zen-core's taskBrowsers event) and when the
 * marks do. (audio.sys.mjs and agentcode.sys.mjs time their own observers.)
 */
function syncHooks() {
  publishTaskSpaces();
  const tasks = taskPagesLive();
  setNetworkActive(tasks);
  setDownloadsActive(tasks);
  setDnsPrefetchOffActive(tasks);
  const kept = tasks || hasAgentCodeMarks();
  setLocalNetworkActive(kept);
  setServiceWorkerBypassActive(kept);
  setAgentWorldActive(kept);
  // A held page is a task's, so a hold implies a task; the guard stays on
  // for one all the same until zen-core releases it.
  setNavGuardActive(kept || holdingAny());
  // zen-core's popup window guard, on the same terms (glue).
  ZeniusService.updatePopupWindowGuard();
}

/** What publishTaskSpaces last sent, to send only a change. */
let publishedSpaces = "[]";
let publishedMap = new Map();

/**
 * Tell content which task each task tab is a page of (browserId → space
 * id), for the BroadcastChannel scope (content/refusals.sys.mjs
 * channelScope). Called with every change to the task set, which zen-core
 * publishes before a new page's first load.
 */
function publishTaskSpaces() {
  const spaces = new Map();
  try {
    for (const space of ZeniusService.spaces.records()) {
      if (space.gone || !ZeniusService.spaces.isAgentTask(space)) {
        continue;
      }
      for (const page of ZeniusService.pages.list(space.id)) {
        const id = ZeniusService.pages.tabFor(page)?.linkedBrowser?.browserId;
        if (id) {
          spaces.set(id, space.id);
        }
      }
    }
  } catch (e) {
    log("zen-observe: listing the task tabs' spaces failed:", e.message);
    return;
  }
  const text = JSON.stringify([...spaces]);
  if (text === publishedSpaces) {
    return;
  }
  publishedSpaces = text;
  // A tab that leaves its task is the user's now: the agent's worlds that
  // could reach it end here, at once.
  for (const [id, space] of publishedMap) {
    if (spaces.get(id) !== space) {
      discardLeftTab(id);
    }
  }
  publishedMap = spaces;
  Services.ppmm.sharedData.set(TASK_SPACES_KEY, spaces);
  Services.ppmm.sharedData.flush();
}

/**
 * A tab of the task, or the held page, that a worker's mark names
 * ("zenius-task-<space>", "zenius-held-<hold>", as content/refusals.sys.mjs's
 * channelScope makes them), to tell a refusal of the worker's to; null for
 * "zenius-agent" or a task with no page open.
 */
function browserOfMark(mark) {
  const m = /^zenius-(task|held)-(.+)$/.exec(mark);
  const map = m ? Services.ppmm.sharedData.get(m[1] === "task" ? TASK_SPACES_KEY : HELD_PAGES_KEY) : null;
  for (const [browserId, value] of map ?? []) {
    if (String(value) === m[2]) {
      const browser = BrowsingContext.getCurrentTopByBrowserId(browserId)?.embedderElement;
      if (browser) {
        return browser;
      }
    }
  }
  return null;
}

/**
 * A task's tab, or a tab whose top document holds the agent's code, that
 * has a document (the top one or a frame's) of this origin; null if none.
 * For a blob shared worker's request, which only names its origin. Run
 * only for requests to the local network, so a walk of the task's tabs is
 * cheap enough.
 */
function taskTabShowing(origin) {
  const ids = new Set(Services.ppmm.sharedData.get(TASK_BROWSERS_KEY) ?? []);
  for (const id of agentCodeBrowserIds()) {
    ids.add(id);
  }
  for (const id of ids) {
    const top = BrowsingContext.getCurrentTopByBrowserId(id);
    for (const bc of top?.getAllBrowsingContextsInSubtree() ?? []) {
      try {
        if (bc.currentWindowGlobal?.documentPrincipal?.origin === origin) {
          return top.embedderElement ?? null;
        }
      } catch {}
    }
  }
  return null;
}

/** For tests (dev.evalChrome): which of these observers are on, and why. */
export function hookState() {
  return {
    taskPages: taskPagesLive(),
    marks: hasAgentCodeMarks(),
    network: networkActive(),
    downloads: downloadsActive(),
    localNetwork: localNetworkActive(),
    dnsPrefetchOff: dnsPrefetchOffActive(),
    navGuard: navGuardActive(),
    holds: holdingAny(),
    serviceWorker: serviceWorkerBypassActive(),
    audio: audioHookActive(),
  };
}

/** The page record for a tab's <browser>, or null if zenius doesn't manage it. */
export function managedPage(browser) {
  return browser ? ZeniusService.pages.forBrowser(browser) : null;
}

/** The <browser> of a page by space id and label, or null. */
export function browserOf(spaceId, label) {
  const page = spaceId === undefined ? null : ZeniusService.pages.peek(spaceId, label);
  return page ? (ZeniusService.pages.tabFor(page)?.linkedBrowser ?? null) : null;
}

function headersOf(channel, response) {
  const headers = {};
  // A Location (or Refresh, Link) can name a sign-in's callback relative to
  // the request, which the socket's redaction of absolute URLs can't see.
  let base = "";
  try {
    base = channel.URI?.spec ?? "";
  } catch {}
  const visitor = {
    visitHeader(name, value) {
      const key = name.toLowerCase();
      const seen = redactReferences(value, base);
      headers[key] = key in headers ? `${headers[key]}, ${seen}` : seen;
    },
  };
  try {
    if (response) {
      channel.visitOriginalResponseHeaders(visitor);
    } else {
      channel.visitRequestHeaders(visitor);
    }
  } catch {}
  return headers;
}

/** Network.* events for page.events(), shaped as CDP sends them. */
function networkEvent(event, browserId, info, channel) {
  // The sign-in rules: what a sign-in result's document requests is the
  // user's (a beacon can carry the page's address, code and all).
  let windowId = 0;
  try {
    windowId = channel.loadInfo?.innerWindowID ?? 0;
  } catch {}
  if (fromSignInResult(windowId)) {
    return;
  }
  const time = cdpTime();
  switch (event) {
    case "request":
      pushEvent(browserId, "Network.requestWillBeSent", {
        requestId: info.id,
        loaderId: "",
        documentURL: channel.loadInfo?.loadingPrincipal?.spec ?? info.url,
        request: { url: info.url, method: info.method, headers: headersOf(channel, false) },
        ...time,
        initiator: { type: "other" },
        type: info.type,
      });
      break;
    case "response": {
      let status = 0;
      let statusText = "";
      let mimeType = "";
      try {
        status = channel.responseStatus;
        statusText = channel.responseStatusText;
        mimeType = channel.contentType;
      } catch {}
      pushEvent(browserId, "Network.responseReceived", {
        requestId: info.id,
        loaderId: "",
        timestamp: time.timestamp,
        type: info.type,
        response: { url: info.url, status, statusText, headers: headersOf(channel, true), mimeType },
      });
      break;
    }
    case "finished":
      pushEvent(browserId, "Network.loadingFinished", {
        requestId: info.id,
        timestamp: time.timestamp,
        encodedDataLength: Math.max(0, Number(channel.transferSize) || 0),
      });
      break;
    case "failed":
      pushEvent(browserId, "Network.loadingFailed", {
        requestId: info.id,
        timestamp: time.timestamp,
        type: info.type,
        errorText: ChromeUtils.getXPCOMErrorName(channel.status),
        canceled: channel.status === Cr.NS_BINDING_ABORTED,
      });
      break;
  }
}

export function setupObserve() {
  if (done) {
    return;
  }
  done = true;
  const service = ZeniusService;
  installDialogs({ intercept: browser => service.isAgentDriven(browser) });
  try {
    installRefusals({ isAgent: browser => service.isAgentDriven(browser) });
  } catch (e) {
    log("zen-observe: refusal hooks failed:", e.message);
  }
  try {
    installAudio({ isAgent: browser => service.isAgentDriven(browser) });
  } catch (e) {
    log("zen-observe: audio hooks failed:", e.message);
  }
  installNetwork({
    track: browserId => !!managedPage(BrowsingContext.getCurrentTopByBrowserId(browserId)?.embedderElement),
  });
  onRequestEvent(networkEvent);
  // A task's tabs, whoever holds them now: the set the content guards read.
  const inSet = (key, browser) => !!browser?.browserId && !!Services.ppmm.sharedData.get(key)?.has(browser.browserId);
  try {
    installLocalNetwork({
      isTask: browser => inSet(TASK_BROWSERS_KEY, browser),
      isAgentDriven: browser => inSet(AGENT_BROWSERS_KEY, browser),
      isAgentCode: top => agentCodeDocument(top),
      report: reportRefused,
      browserOfMark,
      taskTabShowing,
    });
  } catch (e) {
    log("zen-observe: local network hooks failed:", e.message);
  }
  installDnsPrefetchOff({
    isTask: browser => inSet(TASK_BROWSERS_KEY, browser),
    isAgentCode: top => agentCodeDocument(top),
  });
  installNavGuard({
    isAgentCode: top => agentCodeDocument(top),
    // The live task a tab is a page of: its page record's space.
    taskOf: browser => (inSet(TASK_BROWSERS_KEY, browser) ? (managedPage(browser)?.spaceId ?? null) : null),
    holdOf: top => holdOf(top),
    heldRefused: (top, kind, url) => heldLoadRefused(top, kind, url),
    agentSiteNear: (top, uri) => {
      const site = siteOfURI(uri);
      if (!site) {
        return false;
      }
      const page = managedPage(top.embedderElement);
      return agentSitesNear(page ? { id: page.spaceId } : null, top).has(site);
    },
  });
  installServiceWorkerBypass({
    isTask: browser => inSet(TASK_BROWSERS_KEY, browser),
    isAgentCode: top => agentCodeDocument(top),
  });
  installDownloads({
    isAgent: browser => service.isAgentDriven(browser),
    pageOf: browser => {
      const page = managedPage(browser);
      return page ? { spaceId: page.spaceId, label: page.label } : null;
    },
    // A download that starts while its tab shows a sign-in result is the
    // user's, as that page is: no wait, record or event tells the agent of it.
    isUsers: browser => tabTopIsSignInResult(browser.browserId),
  }).catch(e => log("zen-observe: download hooks failed:", e.message));
  onAgentCodeMarks(syncHooks);
  onHolds(syncHooks);
  syncHooks();
  onDownload(entry => {
    if (entry.users) {
      return;
    }
    pushEvent(entry.browserId, "Page.downloadWillBegin", {
      frameId: "",
      guid: entry.id,
      url: entry.url,
      suggestedFilename: entry.suggestedFilename,
    });
  });
  // The service's "download" event (docs/PROTOCOL.md): each download's start
  // and end in a task's page, which a client shows with no call or wait of
  // its own. The user's downloads (isUsers) aren't told.
  onDownloadEvent(event => {
    if (typeof event.spaceId !== "number") {
      return;
    }
    service.emit("download", {
      space: event.spaceId,
      page: event.page,
      download: event.download,
      url: event.url,
      suggestedFilename: event.suggestedFilename,
      state: event.state,
      ...(event.path !== undefined && { path: event.path }),
      ...(event.failure !== undefined && { failure: event.failure }),
    });
  });
  service.addEventListener((event, params) => {
    if (event === "taskBrowsers") {
      syncHooks();
      return;
    }
    if (event === "pageClosed" || event === "spaceFinished") {
      sweepNetwork();
      if (event === "spaceFinished") {
        deleteTaskDownloads(params.space).catch(e => log("zen-observe: a finished task's downloads:", e.message));
      }
      sweepDownloads();
      sweepAgentCode(event === "spaceFinished" ? params.space : undefined);
      // A closing tab still has its browsing context when pageClosed comes,
      // and a finished task's kept tabs live on as the user's: what decides
      // is whether zenius still drives the tab for an agent.
      sweepEvents(browserId => !!managedPage(BrowsingContext.getCurrentTopByBrowserId(browserId)?.embedderElement));
    } else if (event === "observe.console") {
      const browser = browserOf(params.space, params.page);
      if (browser) {
        const { space: _s, page: _p, ...rest } = params;
        pushEvent(browser.browserId, "Runtime.consoleAPICalled", rest);
      }
    } else if (event === "popup") {
      // Follow the popup's first navigation from the start, so calls on it
      // wait for its document instead of answering from about:blank.
      const browser = browserOf(params.space, params.page);
      if (browser) {
        trackerFor(browser).markPopup();
      }
    } else if (event === "observe.refused") {
      // From the content guards (content/refusals.sys.mjs).
      const browser = browserOf(params.space, params.page);
      if (browser && typeof params.kind === "string") {
        reportRefused(browser, params.kind, String(params.message ?? ""), params.url, { api: params.api, asked: params.asked });
      }
    } else if (event === "observe.media") {
      // content/media.sys.mjs paused or resumed media as the user lost or
      // got sight of the tab.
      const browser = browserOf(params.space, params.page);
      if (browser && (params.action === "paused" || params.action === "resumed")) {
        pushEvent(browser.browserId, params.action === "paused" ? "Zenius.mediaPaused" : "Zenius.mediaResumed", {
          reason: "hidden",
          count: Math.max(0, Number(params.count) || 0),
          url: String(params.url ?? ""),
        });
      }
    } else if (event === "observe.sound") {
      const browser = browserOf(params.space, params.page);
      if (browser) {
        noteSound(browser, params.url);
      }
    }
  });
  watchAgentTabs();
}

// zen-core publishes which tabs the agent drives (content/guards.sys.mjs).
// Joining or leaving decides the tab's sound. A tab that joins with its page
// already loaded gets the content guards (the refusals among them) from
// zen-core's installGuards, in every frame. A tab that joins stops any
// stream in it, the user's from their hold among them: the agent never uses
// the user's devices. Resume, a claim and an adoption all come here, once
// each (zen-core's set changes with the Space's ownership).
function watchAgentTabs() {
  let agentIds = new Set(Services.cpmm.sharedData.get(AGENT_BROWSERS_KEY) ?? []);
  Services.cpmm.sharedData.addEventListener("change", event => {
    if (event.changedKeys.includes(AGENT_BROWSERS_KEY)) {
      syncAll();
      const now = new Set(Services.cpmm.sharedData.get(AGENT_BROWSERS_KEY) ?? []);
      for (const id of now) {
        if (!agentIds.has(id)) {
          const browser = BrowsingContext.getCurrentTopByBrowserId(id)?.embedderElement;
          if (browser) {
            stopCapture(browser);
          }
        }
      }
      agentIds = now;
    }
  });
  syncAll();
}
