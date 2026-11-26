// The user's setting for agents' page code (the observe layer). The agent's page
// code is what page.evaluate and page.waitForFunction run in its isolated
// world, and the agent's own pages (data:, blob:), whose code is all the
// agent's (PAGE_CODE_METHODS, OWN_PAGE_LOADS). html pasted into a page isn't
// code, and it is sanitized.
//
// zenius.agentTabs.pageCode is the setting:
//  - "always", the default: the world makes page code safe, and nothing asks
//    the user about safety unless they choose to be asked;
//  - "ask": a site runs page code once the user allows it there;
//  - "never": no page code runs, the agent's own pages included, whatever
//    the site list says.
// Any other value reads as "ask", so a typo runs nothing unasked.
//
// zenius.agentTabs.pageCodeSites lists the sites the user allowed, comma
// separated, each as its site origin (scheme://eTLD+1, as Gecko's
// siteOriginNoSuffix gives it, so https://example.com covers
// mail.example.com). Only the user writes either pref: in about:config, or
// with a click on the Allow button of the card (the input layer's, in the UI's
// files), through allowPageCodeSite, which writes the exact site on that
// click's trusted event only (as with allowPrivateNetworks). Agents can't
// reach either: they get no about:config and no pref method, and their
// synthesized clicks never leave the page. "Not now" on the card
// (declinePageCode) ends the asking for that site in that task.
//
// checkPageCode runs before the call makes a world or marks the page as
// holding the agent's code, so a refused call leaves neither.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";

export const PAGE_CODE_PREF = "zenius.agentTabs.pageCode";
export const PAGE_CODE_SITES_PREF = "zenius.agentTabs.pageCodeSites";

/**
 * The methods that run agent-supplied code in a page, and those that load
 * the agent's own page (a data: or blob: URL; pages.new with a url goes
 * through page.goto). tests/observe/pagecode.test.mjs walks the methods
 * registry, so a new method must be placed here or in its list of methods
 * that run none.
 */
export const PAGE_CODE_METHODS = Object.freeze(["page.evaluate", "page.waitForFunction"]);
export const OWN_PAGE_LOADS = Object.freeze(["page.goto", "page.reload", "pages.new"]);

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  isMade: "chrome://userscripts/content/zenius/observe/agentworld.sys.mjs",
});

/**
 * The setting: "always", "ask" or "never". Unset is "always". A pref of
 * another type reads as "ask", like any other value: getStringPref would
 * give its default, "always", for a Boolean false a user made meaning off.
 */
export function pageCodeMode() {
  const type = Services.prefs.getPrefType(PAGE_CODE_PREF);
  if (type === Services.prefs.PREF_INVALID) {
    return "always";
  }
  if (type !== Services.prefs.PREF_STRING) {
    return "ask";
  }
  const value = Services.prefs.getStringPref(PAGE_CODE_PREF).trim().toLowerCase();
  return value === "always" || value === "never" ? value : "ask";
}

/**
 * The site a document belongs to, as the allow list names it: an http(s)
 * principal's site origin without its container suffix. Null for anything
 * else (about:blank's null principal, file:, the agent's own data: page).
 *
 * @param {nsIPrincipal} principal
 * @returns {string|null}
 */
export function siteOf(principal) {
  try {
    if (!principal?.isContentPrincipal || !/^https?$/.test(principal.scheme)) {
      return null;
    }
    return principal.siteOriginNoSuffix.toLowerCase();
  } catch {
    return null;
  }
}

/** One list entry as siteOf writes a site; a bare host matches either scheme. */
function entryKey(entry) {
  return entry.trim().toLowerCase().replace(/\/+$/, "");
}

/** Whether the user allowed page code on `site`. */
export function siteAllowed(site) {
  if (!site) {
    return false;
  }
  const host = site.replace(/^https?:\/\//, "");
  return Services.prefs
    .getStringPref(PAGE_CODE_SITES_PREF, "")
    .split(",")
    .map(entryKey)
    .some(entry => entry && (entry === site || entry === host));
}

// The sites each task has been asked about, so a retrying agent raises one
// card per site, not one per call, and those the user declined for it.
// Keyed by the space's record: the entries go with it.
const asked = new WeakMap();
const declined = new WeakMap();
const listeners = new Set();

/**
 * Hear the asks: `fn({space, browser, site})` the first time a task's call
 * meets a site the user hasn't allowed, under "ask". The UI's card shows the
 * ask in that tab and writes the site on its Allow button's trusted click.
 *
 * @param {(ask: {space: object, browser: Element, site: string}) => void} fn
 * @returns {() => void} stop hearing them
 */
export function onPageCodeAsk(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The Allow button of the card: add the exact site to the user's list. Only
 * the user's own click counts: `event` must be that click's trusted event,
 * on an element inside `card`, the card's own chrome element. The agent's
 * clicks are synthesized in the page and never reach it.
 *
 * @param {string} site  as the ask gave it
 * @param {Event} event  the click
 * @param {Element} card
 * @returns {boolean} whether the site is on the list now
 */
export function allowPageCodeSite(site, event, card) {
  if (!event?.isTrusted || event.type !== "click" || !card?.contains?.(event.target)) {
    console.error("[zenius] page code: not the user's click on the card; nothing written");
    return false;
  }
  // One exact site, as siteOf writes it: never a list or a pattern.
  if (typeof site !== "string" || !/^https?:\/\/[^\s,/]+$/.test(site)) {
    console.error("[zenius] page code: no site to allow; nothing written");
    return false;
  }
  site = site.toLowerCase();
  if (!siteAllowed(site)) {
    // A list the user made as another type reads as empty, and
    // setStringPref replaces it, since the pref has no default value.
    const list = Services.prefs.getStringPref(PAGE_CODE_SITES_PREF, "");
    Services.prefs.setStringPref(PAGE_CODE_SITES_PREF, list.trim() ? `${list}, ${site}` : site);
  }
  return true;
}

/**
 * "Not now" on the card: the user declined page code on `site` for this
 * task. Its next calls there say so, so the agent stops asking.
 *
 * @param {object} space  the ask's space
 * @param {string} site
 */
export function declinePageCode(space, site) {
  if (!space || typeof site !== "string") {
    return;
  }
  let sites = declined.get(space);
  if (!sites) {
    sites = new Set();
    declined.set(space, sites);
  }
  sites.add(site.toLowerCase());
}

/** Tell the listeners once per task and site; whether anyone was told now. */
function ask(space, browser, site) {
  let sites = asked.get(space);
  if (!sites) {
    sites = new Set();
    asked.set(space, sites);
  }
  if (sites.has(site) || !listeners.size) {
    return false;
  }
  sites.add(site);
  for (const fn of listeners) {
    try {
      fn({ space, browser, site });
    } catch (e) {
      console.error("[zenius] a page-code ask listener failed:", e);
    }
  }
  return true;
}

/**
 * Refuse the agent's page code where the user's setting says so, before the
 * call makes a world. Under "ask", the agent's own data: or blob: page runs
 * its code, since all of that page is the agent's already. A frame inside it
 * from a site still needs that site allowed.
 *
 * @param {{method: string, space: object, page: {label: string}, browser: Element, bc: BrowsingContext}} call
 */
export function checkPageCode({ method, space, page, browser, bc }) {
  const mode = pageCodeMode();
  if (mode === "always") {
    return;
  }
  if (mode === "never") {
    throw new ZenError(
      "ZEN_PAGE_CODE_OFF",
      `${method}: the user has turned off agents' page code in this Zen, so zenius runs none. Read the page and act through clicks, fills and keys instead.`,
      { method, page: page.label, setting: "never" }
    );
  }
  const site = siteOf(bc?.currentWindowGlobal?.documentPrincipal);
  if (site ? siteAllowed(site) : lazy.isMade(bc)) {
    return;
  }
  if (site && declined.get(space)?.has(site)) {
    throw new ZenError(
      "ZEN_PAGE_CODE_ASKED",
      `${method}: the user declined agents' page code on ${site} for this task. Don't ask again or hand the task over for it: carry on with clicks, fills and reading the page.`,
      { method, page: page.label, setting: "ask", site, asked: false, declined: true }
    );
  }
  if (!site) {
    throw new ZenError(
      "ZEN_PAGE_CODE_ASKED",
      `${method}: the user runs agents' page code only on sites they allow, and this page has no site to allow, so zenius runs none here. Read the page and act through clicks, fills and keys instead.`,
      { method, page: page.label, setting: "ask", site: null, asked: false }
    );
  }
  const now = ask(space, browser, site);
  throw new ZenError(
    "ZEN_PAGE_CODE_ASKED",
    `${method}: the user hasn't allowed agents' page code on ${site}. ${now ? "zenius asked them in this tab." : "They've been asked in this tab."} Carry on with clicks, fills and reading the page. If the task can't go on without page code, hand it to the user saying why, and try again after they resume you.`,
    { method, page: page.label, setting: "ask", site, asked: now }
  );
}

/**
 * Under "never", the agent's own page (a data: or blob: URL, whose code is
 * all the agent's) doesn't load either: never means never. Under "ask" it
 * loads without asking.
 *
 * @param {{method: string, page: {label: string}, uri: nsIURI}} load
 */
export function checkOwnPageLoad({ method, page, uri }) {
  if ((uri?.scheme === "data" || uri?.scheme === "blob") && pageCodeMode() === "never") {
    throw new ZenError(
      "ZEN_PAGE_CODE_OFF",
      `${method}: the user has turned off agents' page code in this Zen, and a ${uri.scheme}: page is the agent's own code, so zenius doesn't load it. Use the site's own pages.`,
      { method, page: page.label, setting: "never" }
    );
  }
}
