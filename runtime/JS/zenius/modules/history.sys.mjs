// Task pages stay out of the user's history (the core, for the sign-in
// rules, 2026-11-27). Places then holds only the user's own visits: the
// sign-in rules' code measure asks whether the user visited a site before
// the task began, and an address an injected agent visited never comes up
// later in the user's own address bar.
//
// While a tab is a page of a task the agent has (publishAgentBrowsers'
// task pages: the agent's, or handed to the user), its <browser> carries
// disableglobalhistory, and its live BrowsingContext has useGlobalHistory
// false. Once it leaves (finish, Stop, release, a close), both go, so a
// tab a task leaves the user writes their history as before.
//
// The attribute is what holds: Gecko derives useGlobalHistory from it each
// time it makes the tab's frame loader, which a process switch does, and so
// does the new BrowsingContext a cross-site or COOP load can put in place
// of the old one. The live context's flag alone is lost at the next such
// load. Every window's copy of the tab gets the attribute, since Zen's
// window sync moves a page's docShell to the copy a window shows. A copy
// made later gets it when its browser goes in (the core's #onTaskBrowser
// publishes again). zenius's own mark says the attribute is zenius's, so
// a page that leaves never loses one Zen set (its Glance previews have
// their own). No observer or listener: with no task page, nothing runs
// (I4).

import { copiesOf } from "chrome://userscripts/content/zenius/modules/windows.sys.mjs";

const OFF = "disableglobalhistory";
/** On a <browser> whose OFF is zenius's. */
const MARK = "zenius-history-off";

/** The copies (tabs) kept out of history now. */
let kept = new Set();

/** One copy of a page: out of history, or back in unless Zen set the attribute itself. */
function setCopy(tab, off) {
  const browser = tab.linkedBrowser;
  if (!browser) {
    return;
  }
  if (off) {
    if (!browser.hasAttribute(OFF)) {
      browser.setAttribute(OFF, "true");
      browser.setAttribute(MARK, "true");
    }
  } else if (browser.hasAttribute(MARK)) {
    browser.removeAttribute(OFF);
    browser.removeAttribute(MARK);
  }
  // A tab that hasn't loaded since a restart has no context yet: its frame
  // loader, when it comes, takes the attribute.
  const bc = browser.browsingContext;
  const on = !browser.hasAttribute(OFF);
  try {
    if (bc && !bc.isDiscarded && bc.useGlobalHistory !== on) {
      bc.useGlobalHistory = on;
    }
  } catch (e) {
    console.error("[zenius] changing a page's history failed", e);
  }
}

/**
 * The task pages' tabs now: each copy of each is kept out of history, and a
 * copy that's no longer a task page's gets history back. Idempotent; the
 * core calls it each time the set may have changed.
 *
 * @param {Iterable<Element>} tabs
 */
export function keepFromHistory(tabs) {
  const next = new Set();
  for (const tab of tabs) {
    for (const copy of copiesOf(tab)) {
      next.add(copy);
    }
  }
  for (const copy of next) {
    setCopy(copy, true);
  }
  for (const copy of kept) {
    if (!next.has(copy) && !copy.closing && copy.isConnected) {
      setCopy(copy, false);
    }
  }
  kept = next;
}

/** For tests: how many copies are kept out of history. */
export function historyState() {
  return { copies: kept.size };
}
