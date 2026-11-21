// A task's pages and the local network (zen-observe). They may not reach
// private-network addresses or .local names: an app's first reach into the
// local network raises macOS 15's Local Network prompt, whose answer covers
// the whole Zen.app, the user's own Zen included (the manager's order,
// 2026-11-20). Loopback stays open, for dev servers and the tests'
// fixtures. The user can open hosts and ranges, such as servers on a private
// network, in the zenius.agentTabs.allowPrivateNetworks pref, which agents
// can't reach: they get no about:config and no pref method.
//
// The refusal holds in a task's tabs for its whole life, the user's hold
// included (a page the user loads there would become the agent's when it
// resumes), and after the task in a tab whose top document ran the agent's
// code, until that document is replaced (observe/agentcode.sys.mjs). There a
// load the user starts from the browser (the address bar, a bookmark) goes
// through: it replaces that document. A load the user started that is
// refused is told to onUserLoadRefused's listeners (zen-ux's notice in the
// tab), so it isn't cancelled silently (the manager's decision,
// 2026-11-20).
//
// The parent cancels a task page's request as it opens
// (http-on-opening-request), before the channel looks the host up or
// connects; a redirect's new request, which that topic skips, at
// http-on-modify-request, before it connects. page.goto refuses before
// loading (agentLoadRefusal). A task's shared worker's requests, and those
// of the workers it starts from a URL, name no tab: the mark in their
// loading principal places them (taskWorkerMark). A blob shared worker's
// carry neither, only the origin's principal: while a task's document shows
// that site, its private-address requests are refused, the user's own blob
// shared workers' on the site included (blobWorkerSite; the manager's call,
// 2026-11-21: rare, and suspect from a public site). A task's data: shared
// worker, which has no site, is refused (content/refusals.sys.mjs). Not
// caught here
// (docs/research/observe.md):
// - a DNS name that resolves to a private address;
// - connection hints, which make no request: preconnect, and DNS prefetch;
// - the site's service worker's own requests;
// - WebRTC, which content/refusals.sys.mjs refuses in the page.

export const ALLOW_PREF = "zenius.agentTabs.allowPrivateNetworks";

const V4_PRIVATE = [
  ["10.0.0.0", 8, "a private address"],
  ["172.16.0.0", 12, "a private address"],
  ["192.168.0.0", 16, "a private address"],
  ["169.254.0.0", 16, "a link-local address"],
];
const V6_PRIVATE = [
  ["fc00::", 7, "a private address"],
  ["fe80::", 10, "a link-local address"],
];

/** A dotted-quad IPv4 address as a number, or null. Gecko writes every IPv4 host so (3232235777 → 192.168.1.1). */
function v4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) {
    return null;
  }
  const parts = m.slice(1).map(Number);
  return parts.some(p => p > 255) ? null : parts.reduce((n, p) => n * 256 + p, 0);
}

/** An IPv6 address (brackets and zone allowed) as a BigInt, or null. */
function v6(text) {
  let h = text.replace(/^\[|\]$/g, "").toLowerCase();
  const zone = h.indexOf("%");
  if (zone >= 0) {
    h = h.slice(0, zone);
  }
  if (!h.includes(":")) {
    return null;
  }
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (dotted) {
    const n = v4(dotted[2]);
    if (n === null) {
      return null;
    }
    h = `${dotted[1]}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) {
    return null;
  }
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

const inV4 = (n, base, bits) => bits === 0 || Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));
const inV6 = (n, base, bits) => n >> BigInt(128 - bits) === base >> BigInt(128 - bits);

/** The host without a trailing dot, in lower case. */
const plain = host =>
  String(host ?? "")
    .toLowerCase()
    .replace(/\.$/, "");

/**
 * What makes `host` part of the local network, or null: "a private address",
 * "a link-local address" or "a .local name". Loopback and DNS names aren't.
 *
 * @param {string} host  a URI's host, as nsIURI gives it
 */
export function privateReason(host) {
  const h = plain(host);
  if (!h) {
    return null;
  }
  if (h === "local" || h.endsWith(".local")) {
    return "a .local name";
  }
  const a = v4(h);
  if (a !== null) {
    return V4_PRIVATE.find(([base, bits]) => inV4(a, v4(base), bits))?.[2] ?? null;
  }
  const b = v6(h);
  if (b === null) {
    return null;
  }
  // IPv4-mapped (::ffff:a.b.c.d), which Gecko writes in hex.
  if (b >> 32n === 0xffffn) {
    const n = Number(b & 0xffffffffn);
    return privateReason([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  return V6_PRIVATE.find(([base, bits]) => inV6(b, v6(base), bits))?.[2] ?? null;
}

/**
 * The user's list: comma-separated hosts (exact, any case), addresses and
 * CIDR ranges, IPv4 or IPv6 ("10.20.0.0/16, fd00::/8, printer.local").
 * Entries it can't read are skipped.
 */
export function parseAllowList(text) {
  const hosts = new Set();
  const ranges4 = [];
  const ranges6 = [];
  for (const raw of String(text ?? "").split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) {
      continue;
    }
    const slash = entry.lastIndexOf("/");
    const address = slash >= 0 ? entry.slice(0, slash) : entry;
    const bits = slash >= 0 ? Number(entry.slice(slash + 1)) : null;
    const a = v4(address);
    const b = a === null ? v6(address) : null;
    if (a !== null) {
      const n = bits ?? 32;
      if (Number.isInteger(n) && n >= 0 && n <= 32) {
        ranges4.push([a, n]);
      }
    } else if (b !== null) {
      const n = bits ?? 128;
      if (Number.isInteger(n) && n >= 0 && n <= 128) {
        ranges6.push([b, n]);
      }
    } else if (slash < 0) {
      hosts.add(plain(entry));
    }
  }
  return { hosts, ranges4, ranges6 };
}

/** Does the user's list (parseAllowList's) open `host`? */
export function allowedBy(list, host) {
  const h = plain(host);
  if (list.hosts.has(h)) {
    return true;
  }
  const a = v4(h);
  if (a !== null) {
    return list.ranges4.some(([base, bits]) => inV4(a, base, bits));
  }
  const b = v6(h);
  if (b === null) {
    return false;
  }
  if (b >> 32n === 0xffffn) {
    const n = Number(b & 0xffffffffn);
    if (list.ranges4.some(([base, bits]) => inV4(n, base, bits))) {
      return true;
    }
  }
  return list.ranges6.some(([base, bits]) => inV6(b, base, bits));
}

/** Why a task's page may not reach `host` under the list `allowText`, or null when it may. */
export function refusedReason(host, allowText) {
  const reason = privateReason(host);
  return reason && !allowedBy(parseAllowList(allowText), host) ? reason : null;
}

/** What the agent and the page are told for a refused request to `uri`. */
function refusalText(uri, reason, what, who = "The page") {
  return `${who} tried to reach ${uri.prePath}, ${reason} on the local network (${what}). A task's pages never reach the local network: macOS asks the user before an app does, for their whole browser. zenius refused it. If the task needs this host, ask the user to do that step in their own tab.`;
}

/**
 * Why page.goto may not load `uri` in a task's page, as the error's text,
 * or null when it may.
 *
 * @param {nsIURI} uri
 */
export function agentLoadRefusal(uri) {
  let host = "";
  try {
    host = uri.host;
  } catch {
    return null;
  }
  const reason = refusedReason(host, Services.prefs.getStringPref(ALLOW_PREF, ""));
  return reason
    ? `net::ERR_ACCESS_DENIED. ${uri.prePath} is ${reason} on the local network. A task's pages never reach the local network: macOS asks the user before an app does, for their whole browser. If the task needs this host, hand off and ask the user to open it in this tab (task.handOff({ message })), or ask them to do that step in their own tab.`
    : null;
}

/**
 * Whose rules a request follows: its tab's, or for a popup not yet routed,
 * its openers'. "task": a task's tab. "agentCode": a tab, not a task's,
 * whose top document ran the agent's code. Null: neither.
 *
 * @returns {{browser: Element|null, scope: "task"|"agentCode"}|null}
 */
/**
 * content/refusals.sys.mjs's marks on the URL of a shared worker a task's
 * document starts (SHARED_MARK, SCOPED_MARKS), which content/workerguard.js
 * puts on the URL of each worker that one starts from a URL: "zenius-agent",
 * or "zenius-task-" or "zenius-held-" and the scope, among the fragment's
 * "&"-separated parts. Copied, so the parent doesn't load the content
 * guards' module (I4).
 */
const SHARED_MARK = "zenius-agent";
const SCOPED_MARKS = ["zenius-task-", "zenius-held-"];
const markIn = ref => (ref ? (ref.split("&").find(part => part === SHARED_MARK || SCOPED_MARKS.some(m => part.startsWith(m))) ?? null) : null);

/**
 * The mark of a request of a task's shared worker or of a worker under one,
 * or null. Such requests name no tab. Their loading principal is the
 * worker's, which Gecko makes from the worker's URL, mark and all
 * (measured: `http://…/shared.js#zenius-task-2`). A worker's script load
 * carries the mark in its own URL. That counts when the loading principal
 * has none, as when a blob shared worker the agent wrote, whose principal
 * is the origin's, starts one.
 */
export function taskWorkerMark(channel) {
  try {
    const li = channel.loadInfo;
    const own = markIn(li.loadingPrincipal?.URI?.ref);
    if (own) {
      return own;
    }
    const type = li.internalContentPolicyType;
    return type === Ci.nsIContentPolicy.TYPE_INTERNAL_SHARED_WORKER || type === Ci.nsIContentPolicy.TYPE_INTERNAL_WORKER ? markIn(channel.URI.ref) : null;
  } catch {
    return null;
  }
}

/** The browsing context a request names, or null: a shared worker's, or a worker's under one, name none. */
function contextOf(li) {
  try {
    return (
      li.browsingContext ||
      li.associatedBrowsingContext ||
      (li.frameBrowsingContextID ? BrowsingContext.get(li.frameBrowsingContextID) : null) ||
      (li.browsingContextID ? BrowsingContext.get(li.browsingContextID) : null)
    );
  } catch {
    return null;
  }
}

/**
 * The origin of a blob worker's request with no tab, or null. Gecko gives a
 * blob worker its origin's principal, with no path, whichever code made
 * the blob: the page's, the agent's world, or a worker (measured:
 * `http://127.0.0.1:…/`). Nothing else with no tab has one: a worker from a
 * URL has that URL's principal, and the site's service worker its script's.
 */
export function blobWorkerSite(channel) {
  try {
    const li = channel.loadInfo;
    const principal = li.loadingPrincipal;
    if (contextOf(li) || !principal?.isContentPrincipal || principal.URI.pathQueryRef !== "/") {
      return null;
    }
    return principal.origin;
  } catch {
    return null;
  }
}

/**
 * Where a request belongs: `{browser, scope}` for a task's tab ("task") or
 * a tab whose top document ran the agent's code ("agentCode"), or
 * `{browser: null, scope, mark}` for a request of a task's worker that
 * names no tab (taskWorkerMark); null for the user's own.
 */
export function requestScope(channel, { isTask, isAgentCode }) {
  const li = channel.loadInfo;
  const bc = contextOf(li);
  const own = bc?.top?.embedderElement ?? null;
  let top = bc?.top ?? null;
  for (let depth = 0; top && depth < 5; depth++) {
    if (isTask(top.embedderElement)) {
      return { browser: own, scope: "task" };
    }
    if (isAgentCode(top)) {
      return { browser: own, scope: "agentCode" };
    }
    let opener = null;
    try {
      opener = top.opener ?? top.crossGroupOpener ?? null;
    } catch {}
    top = opener?.top ?? null;
  }
  if (!bc) {
    const mark = taskWorkerMark(channel);
    if (mark) {
      return { browser: null, scope: mark === SHARED_MARK ? "agentCode" : "task", mark };
    }
  }
  return null;
}

/**
 * A page load the user started from the browser: the address bar, a
 * bookmark (the system principal). After the task it replaces the document
 * the agent's code ran in, so that tab's rules don't hold for it.
 */
export function typedTopLoad(channel) {
  try {
    const li = channel.loadInfo;
    return li?.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_DOCUMENT && !!li.triggeringPrincipal?.isSystemPrincipal;
  } catch {
    return false;
  }
}

/** Listeners for refused loads the user started (zen-ux's notice). */
const userLoadListeners = new Set();

/**
 * `fn({browser, url, origin, reason, typed, scope})` when a load the user
 * started in a task's tab, or in a tab whose page ran the agent's code, is
 * refused. `scope` says which: "task" (the tab, or the opener a popup came
 * from, is a task's) or "agentCode" (its top document, or that opener's,
 * ran the agent's code, after the task or after a release). The load is one
 * from the browser (`typed`: the address bar, a bookmark), or a link or
 * form they used in the page while the agent didn't drive it. `url` is what
 * was refused; when `typed` is false the page chose it, so a way out should
 * offer `origin`'s home rather than `url`. Returns a function that removes
 * the listener.
 */
export function onUserLoadRefused(fn) {
  userLoadListeners.add(fn);
  return () => userLoadListeners.delete(fn);
}

const P = Ci.nsIContentPolicy;
/** browserId and prePath → when it was last reported, so a page that tries a host often says so once. */
const reported = new Map();

let installed = false;

/**
 * Cancel the requests of a task's pages to the local network.
 *
 * @param {object} opts
 * @param {(browser: Element|null) => boolean} opts.isTask  is this tab a task's page?
 * @param {(browser: Element|null) => boolean} opts.isAgentDriven  does the agent drive it now?
 * @param {(top: BrowsingContext) => boolean} opts.isAgentCode  did its top document run the agent's code?
 * @param {(browser: Element, kind: string, message: string, url: string) => void} opts.report
 * @param {(mark: string) => Element|null} [opts.browserOfMark]  a tab of the task a worker's mark names, to tell the refusal to
 * @param {(origin: string) => Element|null} [opts.taskTabShowing]  a task's tab, or a tab that keeps the agent's code, with a document of this origin
 */
export function installLocalNetwork({ isTask, isAgentDriven, isAgentCode, report, browserOfMark = () => null, taskTabShowing = () => null }) {
  if (installed) {
    return;
  }
  installed = true;
  observer = subject => {
    let channel;
    let host = "";
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
      host = channel.URI.host;
    } catch {
      return;
    }
    // Most requests stop here: a DNS name, or loopback.
    if (!privateReason(host) || !Components.isSuccessCode(channel.status)) {
      return;
    }
    let where = requestScope(channel, { isTask, isAgentCode });
    if (!where) {
      // A blob shared worker's request, while a task's document shows its site.
      const origin = blobWorkerSite(channel);
      let shows = null;
      try {
        shows = origin ? taskTabShowing(origin) : null;
      } catch {}
      if (shows) {
        where = { browser: shows, scope: "task", blob: true };
      }
    }
    if (!where?.browser && !where?.mark) {
      return;
    }
    const reason = refusedReason(host, Services.prefs.getStringPref(ALLOW_PREF, ""));
    if (!reason) {
      return;
    }
    const { scope } = where;
    let browser = where.browser;
    const li = channel.loadInfo;
    const type = li?.externalContentPolicyType;
    const typed = typedTopLoad(channel);
    // After the task, the user's own navigation replaces the document the
    // agent's code ran in: it is theirs.
    if (scope === "agentCode" && typed) {
      return;
    }
    channel.cancel(Cr.NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED);
    const userStarted = type === P.TYPE_DOCUMENT && !isAgentDriven(browser) && (typed || !!li?.hasValidUserGestureActivation);
    if (userStarted) {
      const notice = { browser, url: channel.URI.spec, origin: channel.URI.prePath, reason, typed, scope };
      for (const fn of userLoadListeners) {
        try {
          fn(notice);
        } catch (e) {
          console.error("[zenius] a refused load's listener failed", e);
        }
      }
    }
    const what = where.blob ? "a request with no tab" : where.mark ? "a request of a worker it started" : type === P.TYPE_DOCUMENT ? "a page load" : type === P.TYPE_SUBDOCUMENT ? "a frame's load" : "a request";
    if (where.mark) {
      // A worker names no tab: told on a page of the task its mark names, if one is open.
      try {
        browser = browserOfMark(where.mark);
      } catch {
        browser = null;
      }
      if (!browser) {
        return;
      }
    }
    // A navigation's refusal is page.goto's error, so it is always told.
    if (type !== P.TYPE_DOCUMENT) {
      const key = `${browser.browserId} ${channel.URI.prePath}`;
      const now = ChromeUtils.now();
      if (now - (reported.get(key) ?? -Infinity) < 30000) {
        return;
      }
      if (reported.size > 500) {
        reported.clear();
      }
      reported.set(key, now);
    }
    report(browser, "localNetwork", refusalText(channel.URI, reason, what, where.blob ? "A blob shared worker of this site" : "The page"), channel.URI.spec);
  };
}

let observer = null;
let active = false;

/**
 * Refuse, or stop. The observer sees every request of every tab, the user's
 * own browsing included, so observe/setup.sys.mjs keeps it on only while a
 * task has pages or a page keeps the agent's code (I4).
 */
export function setLocalNetworkActive(on) {
  if (!observer || !!on === active) {
    return;
  }
  active = !!on;
  for (const topic of ["http-on-opening-request", "http-on-modify-request"]) {
    if (active) {
      Services.obs.addObserver(observer, topic);
    } else {
      Services.obs.removeObserver(observer, topic);
    }
  }
}

/** For tests: is the refusal's observer on? */
export function localNetworkActive() {
  return active;
}
