// zen-observe: a task's pages don't use the site's service worker.
//
// The worker a site registered from the user's own tabs runs for them,
// outside the task. Left alone, it would control the task's pages too: its
// fetch handler would see their requests and navigations, answer them, and
// could fetch what the refusals stop (a worker's own requests have no tab,
// so the local-network refusal can't place them). Measured in Gecko 160:
// LOAD_BYPASS_SERVICE_WORKER on a request's channel at
// http-on-opening-request keeps it from the worker, navigations and frames
// included, even after the worker's clients.claim(). The page
// can't reach the worker either (content/refusals.sys.mjs,
// guardServiceWorkerAccess), nor can the workers it starts
// (content/workerguard.js).
//
// Which requests: the same as the local-network refusal's
// (observe/localnet.sys.mjs requestScope): a task's pages, the popups on
// their way to be its pages, and after the task the pages that keep the
// agent's code, except the user's own load that replaces such a page.
// Dedicated workers' requests name their tab (associatedBrowsingContext).
// A shared worker's carry no tab, nor do those of the workers it starts.
// requestScope places them by the mark in the worker's URL (taskWorkerMark):
// its script load's URL carries it, and its requests' loading principal,
// which Gecko makes from that URL. So a task page's shared worker skips the
// site's worker from its start, and still after the site's worker claims
// it. The workers it starts carry the mark too (content/workerguard.js).

import { requestScope, typedTopLoad } from "chrome://userscripts/content/zenius/observe/localnet.sys.mjs";

let opts = null;
let active = false;

function bypass(subject) {
  let channel;
  try {
    channel = subject.QueryInterface(Ci.nsIChannel);
  } catch {
    return;
  }
  let where;
  try {
    where = requestScope(channel, opts);
  } catch (e) {
    console.error("[zenius] placing a request for the service-worker bypass failed", e);
    return;
  }
  if (!where || (where.scope === "agentCode" && typedTopLoad(channel))) {
    return;
  }
  try {
    channel.loadFlags |= Ci.nsIChannel.LOAD_BYPASS_SERVICE_WORKER;
  } catch (e) {
    console.error("[zenius] keeping a request from the site's service worker failed", e);
  }
}

/**
 * @param {object} options
 * @param {(browser: Element|null) => boolean} options.isTask  is this tab a task's page?
 * @param {(top: BrowsingContext) => boolean} options.isAgentCode  did its top document run the agent's code?
 */
export function installServiceWorkerBypass({ isTask, isAgentCode }) {
  opts = { isTask, isAgentCode };
}

/**
 * On or off, with the local-network refusal's lifetime: the observer sees
 * every request, the user's own browsing included (I4), so
 * observe/setup.sys.mjs keeps it on only while a task has pages or a page
 * keeps the agent's code.
 */
export function setServiceWorkerBypassActive(on) {
  if (!opts || !!on === active) {
    return;
  }
  active = !!on;
  if (active) {
    Services.obs.addObserver(bypass, "http-on-opening-request");
  } else {
    Services.obs.removeObserver(bypass, "http-on-opening-request");
  }
}

/** For tests: is the observer on? */
export function serviceWorkerBypassActive() {
  return active;
}
