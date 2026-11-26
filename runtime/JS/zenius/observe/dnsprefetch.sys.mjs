// The observe layer: a task's pages don't prefetch DNS.
//
// A page's <link rel=dns-prefetch> and an http page's links look names up
// with no channel, so neither the local-network refusal nor Firefox's LNA
// sees them. A .local name becomes an mDNS query on the user's LAN. Such
// lookups are an accepted residual, since any page in the user's own tabs
// makes them, and this layer is cheap.
//
// A document decides whether it prefetches once, when it's created: from its
// docShell's allowDNSPrefetch at that moment, or from its response's
// X-DNS-Prefetch-Control. Measured in Gecko 160 (2026-11-20): turning the
// docShell's flag off leaves the live document prefetching, and a cross-site
// load gets a new docShell with the flag on. So the parent adds
// `X-DNS-Prefetch-Control: off` to each document and frame response of a
// task's tabs, fresh or from cache. A page can't read its document's
// response headers.
//
// Not covered: documents with no response (srcdoc, about:blank, data:,
// blob:), and the lookups of preconnect and Early Hints, which no document
// setting turns off. After the task, a kept page's next document prefetches
// again: only the "task" scope gets the header.

import { requestScope } from "chrome://userscripts/content/zenius/observe/localnet.sys.mjs";

const TOPICS = ["http-on-examine-response", "http-on-examine-cached-response", "http-on-examine-merged-response"];

let opts = null;
let active = false;

function prefetchOff(subject) {
  let channel;
  try {
    channel = subject.QueryInterface(Ci.nsIHttpChannel);
  } catch {
    return;
  }
  const type = channel.loadInfo?.externalContentPolicyType;
  if (type !== Ci.nsIContentPolicy.TYPE_DOCUMENT && type !== Ci.nsIContentPolicy.TYPE_SUBDOCUMENT) {
    return;
  }
  let where;
  try {
    where = requestScope(channel, opts);
  } catch (e) {
    console.error("[zenius] placing a document for the DNS prefetch layer failed", e);
    return;
  }
  if (where?.scope !== "task") {
    return;
  }
  try {
    channel.setResponseHeader("X-DNS-Prefetch-Control", "off", false);
  } catch (e) {
    console.error("[zenius] turning a task document's DNS prefetch off failed", e);
  }
}

/**
 * @param {object} options
 * @param {(browser: Element|null) => boolean} options.isTask  is this tab a task's page?
 * @param {(top: BrowsingContext) => boolean} options.isAgentCode  did its top document run the agent's code?
 */
export function installDnsPrefetchOff({ isTask, isAgentCode }) {
  opts = { isTask, isAgentCode };
}

/**
 * On or off with a task's pages: the observers see every response, the
 * user's own browsing included (I4), so observe/setup.sys.mjs keeps them on
 * only while a task has pages.
 */
export function setDnsPrefetchOffActive(on) {
  if (!opts || !!on === active) {
    return;
  }
  active = !!on;
  for (const topic of TOPICS) {
    if (active) {
      Services.obs.addObserver(prefetchOff, topic);
    } else {
      Services.obs.removeObserver(prefetchOff, topic);
    }
  }
}

/** For tests: are the observers on? */
export function dnsPrefetchOffActive() {
  return active;
}
