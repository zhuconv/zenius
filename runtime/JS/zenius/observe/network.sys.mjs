// Per-tab network activity in the parent (zen-observe): requests in flight,
// network idle, and the Network.* events page.events() reports, without
// devtools or the accessibility service.
//
// Every HTTP channel passes the http-on-* observers. A channel belongs to a
// tab through its load info's browsing context, whose browserId is the same
// for every frame of the tab, out-of-process iframes included; a dedicated
// worker's requests carry the window's browsing context id.

import { whyNotWebPrincipal } from "chrome://userscripts/content/zenius/observe/webcontent.sys.mjs";

const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const START = "http-on-modify-request";
const ENDS = ["http-on-stop-request", "http-on-failed-opening-request"];
const RESPONSES = ["http-on-examine-response", "http-on-examine-cached-response", "http-on-examine-merged-response"];

const P = Ci.nsIContentPolicy;
// Firefox loads the tab icon itself, attributed to the tab, and Ego ignores
// favicons for network idle (its favicon-redirect case); WebSockets stay
// open for the page's lifetime. Both still appear in page.events().
const NOT_COUNTED = new Set([P.TYPE_INTERNAL_IMAGE_FAVICON, P.TYPE_WEBSOCKET]);

// CDP's Network.ResourceType for Gecko's external content policy types.
const RESOURCE_TYPES = new Map([
  [P.TYPE_DOCUMENT, "Document"],
  [P.TYPE_SUBDOCUMENT, "Document"],
  [P.TYPE_STYLESHEET, "Stylesheet"],
  [P.TYPE_IMAGE, "Image"],
  [P.TYPE_IMAGESET, "Image"],
  [P.TYPE_MEDIA, "Media"],
  [P.TYPE_FONT, "Font"],
  [P.TYPE_SCRIPT, "Script"],
  [P.TYPE_XMLHTTPREQUEST, "XHR"],
  [P.TYPE_FETCH, "Fetch"],
  [P.TYPE_WEBSOCKET, "WebSocket"],
  [P.TYPE_BEACON, "Ping"],
  [P.TYPE_PING, "Ping"],
  [P.TYPE_WEB_MANIFEST, "Manifest"],
  [P.TYPE_CSP_REPORT, "CSPViolationReport"],
]);

/**
 * @typedef {object} RequestInfo
 * @property {string} id         channelId, as CDP's requestId
 * @property {string} url
 * @property {string} method
 * @property {string} type       CDP resource type
 * @property {boolean} counted   holds network idle
 * @property {number} startedAt  ChromeUtils.now()
 */

class TabNetwork {
  /** @type {Map<string, RequestInfo>} */
  requests = new Map();
  counted = 0;
  lastChange = ChromeUtils.now();
  /** @type {Set<{check: () => void}>} */
  waiters = new Set();

  changed() {
    this.lastChange = ChromeUtils.now();
    for (const waiter of this.waiters) {
      waiter.check();
    }
  }
}

/** @type {Map<number, TabNetwork>} browserId → state */
const tabs = new Map();
/** @type {Set<(event: string, browserId: number, info: RequestInfo, channel: nsIHttpChannel) => void>} */
const requestListeners = new Set();
let shouldTrack = _browserId => true;
let active = false;

function browserIdOf(channel) {
  const li = channel.loadInfo;
  if (!li) {
    return null;
  }
  const bc =
    li.browsingContext ||
    li.associatedBrowsingContext ||
    (li.frameBrowsingContextID ? BrowsingContext.get(li.frameBrowsingContextID) : null) ||
    (li.browsingContextID ? BrowsingContext.get(li.browsingContextID) : null);
  return bc?.browserId ?? null;
}

/**
 * I5: only web documents' requests are the page's. A request in the tab made
 * by a document that isn't web content (an add-on's frame, such as a
 * password manager's menu loading each saved site's icon), or that an
 * add-on starts there (a content script's fetch), is neither reported in
 * page.events nor counted: its URL and headers are the add-on's. The
 * browser's own loads for the page (its icon, a navigation from the URL bar)
 * still count.
 */
function webRequest(loadInfo) {
  const loading = loadInfo.loadingPrincipal;
  if (loading && whyNotWebPrincipal(loading)) {
    return false;
  }
  const trigger = loadInfo.triggeringPrincipal;
  return !trigger || trigger.isSystemPrincipal || !whyNotWebPrincipal(trigger);
}

function tabFor(browserId, create) {
  let net = tabs.get(browserId);
  if (!net && create) {
    net = new TabNetwork();
    tabs.set(browserId, net);
  }
  return net ?? null;
}

function resourceType(loadInfo) {
  const external = loadInfo.externalContentPolicyType;
  if (loadInfo.internalContentPolicyType === P.TYPE_INTERNAL_EVENTSOURCE) {
    return "EventSource";
  }
  return RESOURCE_TYPES.get(external) ?? "Other";
}

const observer = {
  observe(subject, topic) {
    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch {
      return;
    }
    const loadInfo = channel.loadInfo;
    if (!loadInfo || loadInfo.loadErrorPage) {
      return;
    }
    const browserId = browserIdOf(channel);
    if (!browserId) {
      return;
    }
    const id = String(channel.channelId);
    if (topic === START) {
      if (!shouldTrack(browserId) || !webRequest(loadInfo)) {
        return;
      }
      const net = tabFor(browserId, true);
      const info = {
        id,
        url: channel.URI.spec,
        method: channel.requestMethod,
        type: resourceType(loadInfo),
        counted: !NOT_COUNTED.has(loadInfo.internalContentPolicyType),
        startedAt: ChromeUtils.now(),
      };
      net.requests.set(id, info);
      if (info.counted) {
        net.counted++;
        net.changed();
      }
      notify("request", browserId, info, channel);
      return;
    }
    const net = tabFor(browserId, false);
    const info = net?.requests.get(id);
    if (!info) {
      return;
    }
    if (RESPONSES.includes(topic)) {
      notify("response", browserId, info, channel);
      return;
    }
    net.requests.delete(id);
    if (info.counted) {
      net.counted--;
      net.changed();
    }
    notify(Components.isSuccessCode(channel.status) ? "finished" : "failed", browserId, info, channel);
  },
};

function notify(event, browserId, info, channel) {
  for (const fn of requestListeners) {
    try {
      fn(event, browserId, info, channel);
    } catch (e) {
      console.error("[zenius] network listener failed", e);
    }
  }
}

/**
 * `track(browserId)` decides which tabs to follow; it runs once per request
 * start, so keep it cheap. The observers run only while setNetworkActive.
 */
export function installNetwork({ track } = {}) {
  if (track) {
    shouldTrack = track;
  }
}

/**
 * Observe requests, or stop. These observers see every request of every
 * tab, the user's own browsing included, so observe/setup.sys.mjs keeps
 * them on only while a task has pages (I4).
 */
export function setNetworkActive(on) {
  if (!!on === active) {
    return;
  }
  active = !!on;
  for (const topic of [START, ...ENDS, ...RESPONSES]) {
    if (active) {
      Services.obs.addObserver(observer, topic);
    } else {
      Services.obs.removeObserver(observer, topic);
    }
  }
  if (!active) {
    // The ends of the requests in flight won't be seen: forget them, so a
    // tab that joins a later task doesn't wait on them for network idle.
    for (const net of tabs.values()) {
      net.requests.clear();
      net.counted = 0;
      net.changed();
    }
    sweepNetwork();
  }
}

/** For tests: are the request observers on? */
export function networkActive() {
  return active;
}

/** `fn(event, browserId, info, channel)` for request, response, finished, failed. */
export function onRequestEvent(fn) {
  requestListeners.add(fn);
  return () => requestListeners.delete(fn);
}

/** Requests in flight that hold network idle, oldest first. */
export function inflight(browserId) {
  return [...(tabs.get(browserId)?.requests.values() ?? [])].filter(r => r.counted);
}

/**
 * How long the tab has had no counted request in flight, in ms: 0 while one
 * is, Infinity before any was seen. A request's end counts as activity too,
 * as in Ego's lastActivityAt. For zen-input's missing-target fail-fast.
 */
export function networkQuietMs(browserId) {
  const net = tabs.get(browserId);
  if (!net) {
    return Infinity;
  }
  return net.counted > 0 ? 0 : ChromeUtils.now() - net.lastChange;
}

/**
 * Resolve true once the tab has had no counted request in flight for
 * `idleMs`, or false at `timeoutMs`. Quiet time before the call counts, as
 * in Ego's lastActivityAt.
 */
export function waitForNetworkIdle(browserId, { idleMs = 500, timeoutMs = 10000 } = {}) {
  const net = tabFor(browserId, true);
  return new Promise(resolve => {
    let idleTimer = null;
    const waiter = {
      check() {
        clearTimeout(idleTimer);
        idleTimer = null;
        if (net.counted > 0) {
          return;
        }
        const quiet = ChromeUtils.now() - net.lastChange;
        if (quiet >= idleMs) {
          done(true);
          return;
        }
        idleTimer = setTimeout(() => waiter.check(), Math.ceil(idleMs - quiet) + 1);
      },
    };
    const deadline = setTimeout(() => done(false), Math.max(0, timeoutMs));
    const done = value => {
      clearTimeout(deadline);
      clearTimeout(idleTimer);
      net.waiters.delete(waiter);
      resolve(value);
    };
    net.waiters.add(waiter);
    waiter.check();
  });
}

/** Restart the quiet period, so idle means "quiet since now" (goto, reload). */
export function resetQuiet(browserId) {
  tabFor(browserId, true).lastChange = ChromeUtils.now();
}

/** Forget tabs whose browser is gone. */
export function sweepNetwork() {
  for (const [browserId, net] of tabs) {
    if (!net.waiters.size && !BrowsingContext.getCurrentTopByBrowserId(browserId)) {
      tabs.delete(browserId);
    }
  }
}
