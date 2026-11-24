// pages.* and tabs.* methods (zen-core): Ego's page model. Managed pages have
// labels; every tab of a space has a tab id for task.tabs(), adopt and
// release.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { keepAlive } from "chrome://userscripts/content/zenius/modules/guards.sys.mjs";
import { clearAdopted } from "chrome://userscripts/content/zenius/input/handback.sys.mjs";
import { displayURL } from "chrome://userscripts/content/zenius/observe/navtracker.sys.mjs";
import { noteAdopted } from "chrome://userscripts/content/zenius/observe/agentcode.sys.mjs";
import { showsSignInResult } from "chrome://userscripts/content/zenius/observe/signin.sys.mjs";
import { hostWindow, sameTab } from "chrome://userscripts/content/zenius/modules/windows.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  markEvident: "chrome://userscripts/content/zenius/observe/evidence.sys.mjs",
});

/** zen-observe's limit on an evidence detail, which zen-ux's notice shows the user. */
const FLAG_REASON_MAX = 200;
/** One line the user reads: no C0 or C1 control character, and no bidi formatting character to reorder it. */
const FLAG_REASON_BAD = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

function tabInfo(tab, current) {
  return {
    // A sign-in result's title is the user's (content/signin.sys.mjs), in
    // their own tabs too: a page that shows the code may show it there.
    title: showsSignInResult(tab.linkedBrowser) ? "" : (tab.label ?? ""),
    // As page.url() reads it: a popup still loading its first document lists
    // the URL it's loading (zen-observe's displayURL).
    url: tab.linkedBrowser ? displayURL(tab.linkedBrowser) : "",
    active: sameTab(tab, current),
  };
}

// Gate classes (SPI.md, "Dispatch"): access for the control gate (I3), i5
// for the web-content gate (I5).
export const access = {
  "pages.list": "read",
  "tabs.list": "read",
  "pages.new": "mutate",
  "pages.adopt": "mutate",
  "pages.release": "mutate",
  "pages.close": "mutate",
  "pages.userPage": "read",
  "page.flag": "mutate",
};

export const i5 = {
  "pages.list": "none",
  "tabs.list": "none",
  "pages.new": "none",
  "pages.adopt": "none",
  "pages.release": "none",
  "pages.close": "none",
  "pages.userPage": "none",
  "page.flag": "document",
};

export const methods = {
  "pages.list": async (ctx, params) => {
    const space = ctx.resolveSpace(params);
    const current = ctx.pages.userTab(space);
    return ctx.pages.list(space.id).map(page => {
      const tab = ctx.pages.tabFor(page);
      const { title, url, active } = tabInfo(tab, current);
      return {
        label: page.label,
        tab: ctx.pages.tabId(tab),
        openedBy: page.openedBy,
        url,
        title,
        active,
        createdAt: page.createdAt,
        opener: page.opener,
      };
    });
  },

  "tabs.list": async (ctx, params) => {
    const space = ctx.resolveSpace(params);
    const current = ctx.pages.userTab(space);
    return ctx.pages.inventory(space).map(({ tab, id, page, openedBy }) => ({
      ...(page ? { label: page.label } : {}),
      tab: id,
      ...tabInfo(tab, current),
      openedBy,
    }));
  },

  "pages.new": async (ctx, params) => {
    const space = ctx.resolveSpace(params);
    ctx.pages.checkBudget(space, ctx.pageBudget);
    const page = ctx.pages.open(space);
    if (params.url) {
      await ctx.call("page.goto", { space: space.id, page: page.label, url: params.url, options: params.options ?? {} });
    }
    return { label: page.label, tab: ctx.pages.tabId(ctx.pages.tabFor(page)) };
  },

  // Manage a tab from tabs.list (a user's tab after a claim, or a blank tab
  // the agent left). It keeps its origin.
  "pages.adopt": async (ctx, params) => {
    const space = ctx.resolveSpace(params);
    const tab = ctx.pages.findTab(space, params.tab);
    if (!tab) {
      throw new ZenError("ZEN_PAGE_NOT_FOUND", `untracked page ${params.tab} is no longer open in space ${space.id}`, {
        space: space.id,
        tab: params.tab,
      });
    }
    const existing = ctx.pages.forTab(tab);
    if (existing) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `target ${params.tab} is already page ${existing.label}`, {
        space: space.id,
        page: existing.label,
      });
    }
    if (params.as !== undefined && typeof params.as !== "string") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "pages.adopt as must be a page label");
    }
    ctx.pages.checkBudget(space, ctx.pageBudget);
    const openedBy = space.ledger.unmanaged[params.tab] ?? "unknown";
    const page = ctx.pages.register(space, tab, openedBy, { label: params.as });
    // zen-observe: the document a tab of the user's shows now is theirs, so
    // the kept-code pill never says the agent made it.
    noteAdopted(tab.linkedBrowser, openedBy);
    keepAlive(tab);
    // zen-input: passwords and card details the agent didn't set are emptied
    // before its first call on the page. Sent before anything here awaits,
    // so even a call pipelined behind this one finds them gone.
    clearAdopted(tab.linkedBrowser);
    // The tab's documents predate the adoption, so they have no guards yet.
    await ctx.service.installGuards(tab);
    return { label: page.label, tab: params.tab };
  },

  "pages.release": async (ctx, params) => {
    const space = ctx.resolveSpace(params);
    const page = ctx.pages.get(space, params.page);
    if (params.group !== undefined && typeof params.group !== "boolean") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "pages.release group must be a boolean");
    }
    // Closed groups: the user's window would share
    // a browsing context group with pages where the agent's code runs. The
    // agent names every page it hands over; taking more unasked could take
    // its main page.
    const mates = ctx.pages.groupMates(space, page);
    if (mates.length && params.group !== true) {
      const labels = mates.map(other => other.label);
      throw new ZenError(
        "ZEN_PAGE_GROUP_SHARED",
        // In the SDK's terms, as agents read it (zen-sdk's suggestion).
        `page ${page.label} shares a window group with page${labels.length > 1 ? "s" : ""} ` +
          `${labels.join(", ")} of this task, whose code could reach it once it's the user's. Release them ` +
          `together with task.release("${page.label}", { group: true }), or close ` +
          `${labels.length > 1 ? "them" : "it"} first. For the user's input in the middle of a task, such as ` +
          "a login, hand control to the user (task.handOff()) instead of releasing.",
        { space: space.id, page: page.label, pages: labels }
      );
    }
    if (!mates.length) {
      return ctx.pages.release(space, page);
    }
    // The whole group, the named page first. Pages the agent opened go too:
    // the agent asked for the group.
    const released = [page, ...mates].map(each => ({ page: each.label, ...ctx.pages.release(space, each, { group: true }) }));
    return { ...released[0], released };
  },

  "pages.close": async (ctx, params) => {
    const space = ctx.resolveSpace(params);
    const page = ctx.pages.get(space, params.page);
    const tab = ctx.pages.tabFor(page);
    // As in Ego, closing the last tab leaves a blank one so the space
    // survives. It is the agent's: finish() closes it.
    if (ctx.pages.tabsOf(space).length <= 1) {
      const anchor = ctx.pages.addTab(space, hostWindow(tab.ownerDocument.defaultView));
      ctx.pages.addUnmanaged(space, anchor, "agent");
    }
    // TabClose removes the page and emits pageClosed. A tab a window shows
    // waits for the user to leave it, and its page ends now (SPEC §3.5).
    const deferred = ctx.pages.closeTab(tab);
    return { ok: true, deferred };
  },

  "pages.userPage": async (ctx, params) => ctx.pages.userPage(ctx.resolveSpace(params)),

  // The agent's own evidence:
  // the page looks like phishing or wants what the task doesn't need. Its
  // document then gets every defense that reads evidence, and zen-ux's
  // notice tells the user the reason. Per document, as all evidence is: a
  // reload or a new load starts clean.
  "page.flag": async (ctx, params) => {
    const space = ctx.resolveSpace(params);
    const page = ctx.pages.get(space, params.page);
    const reason = typeof params.reason === "string" ? params.reason.trim() : "";
    if (!reason || reason.length > FLAG_REASON_MAX || FLAG_REASON_BAD.test(reason)) {
      throw new ZenError(
        "ZEN_INVALID_ARGUMENT",
        `reason must be one line of 1 to ${FLAG_REASON_MAX} characters saying why the page looks like phishing or dangerous`
      );
    }
    const browser = ctx.pages.tabFor(page)?.linkedBrowser;
    if (!browser?.browsingContext?.currentWindowGlobal) {
      throw new ZenError("ZEN_PAGE_NOT_FOUND", `${page.label} has no document yet: flag it once it has loaded`);
    }
    lazy.markEvident(browser, "flagged", reason);
    return { ok: true };
  },
};
