// The page-code card (zen-input's glue in zen-ux's files). With the user's
// page-code setting at "ask", zen-observe holds the agent's page code on a
// site the user hasn't allowed, and asks once per task and site
// (observe/pagecode.sys.mjs, onPageCodeAsk). The agent's tab asks the user,
// in zen-observe's words: Allow on this site puts the site on the user's
// list, on their own click only; Not now refuses it for that task and writes
// nothing.
//
// The card is a notice (ui/notices.sys.mjs): chrome, which page code can't
// reach, and the agent's synthesized clicks and keys never leave its content.
// It takes no focus and moves no view (I1). It stays until the user answers,
// as zen-observe doesn't ask again for that task and site, and goes when the
// task ends or its tab closes.

import { noticeElement, removeNotice, showNotice } from "chrome://userscripts/content/zenius/ui/notices.sys.mjs";
import { isolate } from "chrome://userscripts/content/zenius/ui/text.sys.mjs";
import { isTabVisible } from "chrome://userscripts/content/zenius/ui/visibility.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  allowPageCodeSite: "chrome://userscripts/content/zenius/observe/pagecode.sys.mjs",
  declinePageCode: "chrome://userscripts/content/zenius/observe/pagecode.sys.mjs",
});

/** The card's notice, one per site in a task's tab: this plus the site. */
export const PAGE_CODE_NOTICE = "zenius-pagecode:";

/**
 * The cards up, by task and site: a task's end takes its cards down, and an
 * Allow every card for that site. `space` is the task's record, as the ask
 * gave it (zen-observe keys its asks by it); `id` is its id.
 *
 * @type {Map<string, {space: object, id: number, site: string, tab: Element, value: string}>}
 */
const asks = new Map();

/**
 * zen-observe's site, "https://example.com", as the card names it: the
 * host for https, else the whole site, so an http site doesn't pass for
 * the https one the list keeps apart. Always whole: the user decides on it,
 * and the card's title wraps (zenius-ux.css). The host as the address bar
 * shows it (displayHost: an IDN in Unicode only where Firefox finds it
 * safe from look-alikes, else in punycode), an IPv6 one in brackets.
 *
 * @param {string} site
 * @returns {string} "" when it isn't a site
 */
export function siteLabel(site) {
  let uri = null;
  try {
    uri = typeof site === "string" && site ? Services.io.newURI(site) : null;
  } catch {}
  let host = "";
  try {
    host = uri?.displayHost || uri?.host || "";
  } catch {}
  if (!host) {
    return "";
  }
  if (host.includes(":")) {
    host = `[${host}]`;
  }
  return uri.scheme === "https" ? host : `${uri.scheme}://${host}`;
}

/**
 * The card's opts (also for the Mac look test): zen-observe's words.
 *
 * @param {string} site  zen-observe's site, "https://example.com"
 * @param {{allow?: (event: Event) => void, notNow?: () => void}} [actions]
 * @returns {import("chrome://userscripts/content/zenius/ui/notices.sys.mjs").NoticeOptions}
 */
export function pageCodeCard(site, actions = {}) {
  return {
    title: `Allow the agent's code on ${isolate(siteLabel(site))}?`,
    tone: "attention",
    buttons: [
      // It stays when the click isn't the user's own, or the write didn't
      // happen: the question is still open.
      { label: "Allow on this site", primary: true, stays: true, onClick: actions.allow ?? (() => {}) },
      { label: "Not now", onClick: actions.notNow ?? (() => {}) },
    ],
  };
}

/**
 * zen-observe's ask: show the card in the tab of `browser`. A second ask for
 * the same task and site updates the card in place.
 *
 * @param {{space: {id: number}, browser: Element, site: string}} event  space: the task's record
 * @param {{announce?: (text: string, win: Window) => void}} [hooks]
 *   announce: ZeniusUI's, for a card that shows in the window in front
 * @returns {boolean} whether a card shows
 */
export function askPageCode({ space, browser, site } = {}, { announce } = {}) {
  prune();
  const win = browser?.ownerDocument?.defaultView;
  const tab = win?.gBrowser?.getTabForBrowser(browser);
  const id = space?.id;
  if (!tab || tab.closing || typeof id !== "number" || !siteLabel(site)) {
    return false;
  }
  const value = PAGE_CODE_NOTICE + site;
  const card = pageCodeCard(site, {
    allow: event => allow(tab, value, site, event),
    notNow: () => notNow(space, site),
  });
  // One card per site per task: an ask from another of the task's tabs
  // moves it there.
  const key = keyOf(id, site);
  const before = asks.get(key);
  if (before && before.tab !== tab) {
    asks.delete(key);
    removeNotice(before.tab, before.value, { refocus: false });
  }
  if (!showNotice(tab, value, card)) {
    return false;
  }
  asks.set(key, { space, id, site, tab, value });
  if (win === Services.wm.getMostRecentWindow("navigator:browser") && isTabVisible(tab)) {
    announce?.(card.title, win);
  }
  return true;
}

/**
 * The task ended: its cards go. Its asks end with it in zen-observe.
 *
 * @param {number} id  the task's id
 */
export function endPageCodeAsks(id) {
  for (const [key, ask] of asks) {
    if (ask.id === id) {
      asks.delete(key);
      removeNotice(ask.tab, ask.value, { refocus: false });
    }
  }
}

/**
 * Allow on this site. Only the user's own click writes the list: a trusted
 * click on this button, in this tab's card (#allowLocal's check, as zen-ux
 * asked). zen-observe's allowPageCodeSite checks it again and writes the
 * exact site once.
 *
 * @param {Element} tab
 * @param {string} value
 * @param {string} site
 * @param {Event} event  the button's click
 */
function allow(tab, value, site, event) {
  const button = event?.target?.closest?.(".zenius-card-button");
  if (!event?.isTrusted || event.type !== "click" || !button || !noticeElement(tab, value)?.contains(button)) {
    console.error("[zenius] Allow on this site: not the user's click on its button; nothing written");
    return;
  }
  let allowed = false;
  try {
    allowed = !!lazy.allowPageCodeSite(site, event, noticeElement(tab, value));
  } catch (e) {
    console.error("[zenius] Allow on this site failed", e);
  }
  if (!allowed) {
    return;
  }
  // The site is on the list for every task: no card need ask for it.
  for (const [key, ask] of asks) {
    if (ask.site === site) {
      asks.delete(key);
      removeNotice(ask.tab, ask.value);
    }
  }
  removeNotice(tab, value);
}

/**
 * Not now: that task's calls on the site fail, saying the user declined.
 * Nothing is written, and zen-observe doesn't ask again for that task and
 * site. The card goes after the click.
 *
 * @param {{id: number}} space  the task's record, as the ask gave it
 * @param {string} site
 */
function notNow(space, site) {
  asks.delete(keyOf(space.id, site));
  try {
    lazy.declinePageCode(space, site);
  } catch (e) {
    console.error("[zenius] Not now failed", e);
  }
}

function keyOf(id, site) {
  return `${id} ${site}`;
}

/** Cards whose tab closed went with it. */
function prune() {
  for (const [key, ask] of asks) {
    if (!ask.tab.isConnected || ask.tab.closing || !noticeElement(ask.tab, ask.value)) {
      asks.delete(key);
    }
  }
}
