// A task's tab torn off into a new window (Move to New Window, or a drag out
// of the strip), with window sync on and two windows. The torn-off tab is a
// new element in a new window, and Zen closes the tab's copies in the other
// windows. If the page's document went with it, the page stays the task's
// there, guarded, as a tab moved to another window does, and a hand-off
// still loads it afresh when the agent's code left something in it. If it
// didn't, the page ends, and the new window's tab is the user's. A tab the
// task keeps that isn't a page goes the same way, under its tab id.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const dir = mkdtempSync(join(tmpdir(), "zenius-tear-off-"));

let h;
let home;
/** The tasks this file starts, which it finishes at the end. */
const spaces = [];
before(async () => {
  h = await setup();
  home = await h.chrome(`return win.gZenWorkspaces.activeWorkspace`);
  await openWindow();
});
after(async () => {
  for (const space of spaces) {
    await h?.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "agent", { source: "user" }); return true;`, space).catch(() => {});
    await h?.call("spaces.finish", { space, keep: [] }).catch(() => {});
  }
  // The files after this one share this Zen: one window, showing the Space it showed.
  await h
    ?.chrome(
      `${W}
       for (const w of wins().slice(1)) w.close();
       await focus(0);
       if (arg && win.gZenWorkspaces.activeWorkspace !== arg) await win.gZenWorkspaces.changeWorkspaceWithID(arg);
       return true;`,
      home
    )
    .catch(() => {});
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

const W = `
  const Win = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const { AGENT_BROWSERS_KEY } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/guards.sys.mjs");
  const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
  const wins = () => [...Services.wm.getEnumerator("navigator:browser")];
  const wid = w => w?.docShell?.outerWindowID ?? null;
  const nth = n => wins()[n];
  const nOf = tab => wins().findIndex(w => wid(w) === wid(tab.ownerDocument.defaultView));
  const recOf = space => ctx.spaces.get(space);
  const pageOf = (space, label) => ctx.pages.peek(space, label);
  const liveOf = (space, label) => ctx.pages.tabFor(pageOf(space, label));
  const { setTimeout: later } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const sleep = ms => new Promise(r => later(r, ms));
  const until = async (fn, ms = 10000) => {
    for (const end = Date.now() + ms; !(await fn()); ) {
      if (Date.now() > end) throw new Error("timed out: " + fn);
      await sleep(25);
    }
  };
  const focus = async n => {
    nth(n).focus();
    await until(() => wid(Services.focus.activeWindow) === wid(nth(n)));
  };
  const value = t => { try { return JSON.parse(SessionStore.getCustomTabValue(t, "zenius") || "null"); } catch { return null; } };
  const agentSet = () => [...(Services.ppmm.sharedData.get(AGENT_BROWSERS_KEY) ?? [])];
  // Tear a tab off into a new window, and wait until Zen has closed its
  // copies in the other windows. A copy Zen closes stays in its window,
  // closing, until its animation ends, and the window's session state
  // keeps it until then: a restart could bring it back. The torn-off tab
  // itself is the tear-off's to remove: torn off from a copy without the
  // document, it can stay in its window, closing, after the rest are gone.
  const tearOff = async tab => {
    const n = wins().length;
    const sync = Win.syncId(tab);
    tab.ownerDocument.defaultView.gBrowser.replaceTabWithWindow(tab);
    await until(() => wins().length > n);
    const w = wins().at(-1);
    await until(() => w.gBrowser?.tabs?.length > 0 && w.document.readyState === "complete");
    // Every Space's tabs: gBrowser.tabs has only the shown Space's.
    await until(() => !wins().slice(0, n).some(x => (x.gZenWorkspaces?.allStoredTabs ?? [...x.gBrowser.tabs]).some(t => t !== tab && t.isConnected && Win.syncId(t) === sync)));
    await sleep(500);
    return w;
  };
`;

async function openWindow() {
  return h.chrome(
    `${W}
     const first = nth(0);
     const w = first.OpenBrowserWindow();
     await new Promise(r => w.addEventListener("load", r, { once: true }));
     await w.delayedStartupPromise;
     await w.gZenWorkspaces.promiseInitialized;
     await until(() => w.gZenWorkspaces.allStoredTabs.length >= first.gZenWorkspaces.allStoredTabs.length, 30000);
     await focus(0);
     return wins().length;`
  );
}

/** A task with pages on these paths, made while the first window is the most recent one. */
async function task(name, paths) {
  await h.chrome(`${W} await focus(0); return true;`);
  const space = await h.space(name);
  spaces.push(space);
  const labels = [];
  for (const path of paths) {
    const { label } = await h.call("pages.new", { space });
    await h.call("page.goto", { space, page: label, url: `${h.base}${path}` });
    labels.push(label);
  }
  // Each page has its copy in the second window.
  await h.chrome(`${W} await until(() => arg.labels.every(l => Win.copyIn(liveOf(arg.space, l), nth(1)))); return true;`, { space, labels });
  return { space, labels };
}

/** Close the windows after the first two, and focus the first. */
const closeNewWindows = () => h.chrome(`${W} for (const w of wins().slice(2)) w.close(); await focus(0); return true;`);

test("Move to New Window on a task's page: the page stays the task's in the new window, guarded, and the agent still drives it", async () => {
  const { space, labels } = await task("tear off the page", ["/api/text?to-live1"]);
  try {
    const out = await h.chrome(
      `${W}
       const t = liveOf(arg.space, arg.page);
       const before = { bc: t.linkedBrowser.browsingContext.id, bid: t.linkedBrowser.browserId, sync: Win.syncId(t) };
       const w = await tearOff(t);
       const page = pageOf(arg.space, arg.page);
       const now = page ? ctx.pages.tabFor(page) : null;
       return {
         page: !!page,
         inNewWindow: !!now && nOf(now) === wins().length - 1,
         sameDocument: now?.linkedBrowser?.browsingContext?.id === before.bc,
         label: value(now)?.label ?? null,
         valueNamesItsTab: !!now && value(now)?.sync === Win.syncId(now),
         // The whole id: two made in one millisecond share its time part.
         namesOldTab: typeof before.sync === "string" && value(now)?.movedFrom === before.sync,
         tag: now?.getAttribute("zenius-task") ?? null,
         guarded: agentSet().includes(now?.linkedBrowser?.browserId ?? before.bid),
         // What Take over and the hold card ask of a tab.
         control: ctx.service.lookup(now)?.page?.label ?? null,
       };`,
      { space, page: labels[0] }
    );
    assert.deepEqual(out, {
      page: true,
      inNewWindow: true,
      sameDocument: true,
      label: labels[0],
      valueNamesItsTab: true,
      namesOldTab: true,
      tag: String(space),
      guarded: true,
      control: labels[0],
    });
    assert.ok((await h.call("pages.list", { space })).some(p => p.label === labels[0]), "pages.list still has it");
    const evaluated = await h.call("page.evaluate", { space, page: labels[0], fn: "location.search", isFunction: false });
    assert.match(JSON.stringify(evaluated), /to-live1/, "the agent still drives the page");
  } finally {
    await closeNewWindows();
  }
});

test("Move to New Window on another window's copy of a task's page: the page ends with the copies Zen closes, and the new window's tab is the user's", async () => {
  const { space, labels } = await task("tear off a copy", ["/api/text?to-copy1"]);
  try {
    const out = await h.chrome(
      `${W}
       const copy = Win.copyIn(liveOf(arg.space, arg.page), nth(1));
       const w = await tearOff(copy);
       return {
         page: !!pageOf(arg.space, arg.page),
         newTabs: [...w.gBrowser.tabs].map(t => ({ value: value(t), tag: t.getAttribute("zenius-task") })),
       };`,
      { space, page: labels[0] }
    );
    assert.equal(out.page, false, "Zen closed the page's live copy too");
    assert.ok(out.newTabs.length > 0);
    assert.deepEqual(out.newTabs, out.newTabs.map(() => ({ value: null, tag: null })), "the new window's tab carries no task value or tag");
    assert.ok(!(await h.call("pages.list", { space })).some(p => p.label === labels[0]));
  } finally {
    await closeNewWindows();
  }
});

test("a page torn off into a new window comes back after a restart, still the task's", async () => {
  const { space, labels } = await task("tear off and restart", ["/api/text?to-restart1"]);
  try {
    const sync = await h.chrome(
      `${W}
       await tearOff(liveOf(arg.space, arg.page));
       return Win.syncId(liveOf(arg.space, arg.page));`,
      { space, page: labels[0] }
    );
    // Zen gives the tab in a torn-off window no sync id, and keeps none for it.
    assert.equal(sync, null);
    await h.chrome(`await ctx.service.flushState(); return true`);
    const file = join(dir, "prefs.js");
    writeFileSync(file, 'user_pref("browser.startup.page", 3);\nuser_pref("zen.workspaces.continue-where-left-off", false);\n');
    process.env.ZENIUS_DEV_PREFS = file;
    try {
      await h.restart({});
    } finally {
      delete process.env.ZENIUS_DEV_PREFS;
    }
    assert.ok((await h.call("pages.list", { space })).some(p => p.label === labels[0]), "the page came back");
    const out = await h.chrome(
      `${W}
       const t = liveOf(arg.space, arg.page);
       return { tag: t.getAttribute("zenius-task"), valueNamesItsTab: value(t)?.sync === Win.syncId(t) };`,
      { space, page: labels[0] }
    );
    assert.deepEqual(out, { tag: String(space), valueNamesItsTab: true });
  } finally {
    await closeNewWindows();
  }
});

/**
 * Tear off a task's page the agent's code hooked (a style sheet outlives the
 * discard of its world: zen-observe's evidence), run `between`, hand off,
 * and return what the hand-off held and loaded afresh.
 */
test("a hand-off with secret: a page torn off into a new window during the user's step blanks there at the hand back, and no copy's saved state keeps the step's page", async () => {
  const { space, labels } = await task("secret torn", ["/api/text?secret-torn"]);
  const [label] = labels;
  try {
    await h.chrome(`${W} ctx.pages.noteFront(liveOf(arg.space, arg.page)); return true;`, { space, page: label });
    await h.call("spaces.handOff", { space, secret: true });
    await h.chrome(
      `${W} liveOf(arg.space, arg.page).linkedBrowser.loadURI(Services.io.newURI(arg.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true;`,
      { space, page: label, url: `${h.base}/api/text?secret-torn-token` }
    );
    await h.until(async () => (await h.chrome(`${W} return liveOf(arg.space, arg.page).linkedBrowser.currentURI.spec;`, { space, page: label })).includes("secret-torn-token"), 10000);
    await h.chrome(`${W} await tearOff(liveOf(arg.space, arg.page)); return true;`, { space, page: label });
    await h.chrome(`const s = ctx.spaces.get(arg); await ctx.service.beforeHandBack(s); ctx.spaces.setOwnership(s, "agent", { source: "user" }); return true;`, space);
    const now = await h.chrome(
      `${W} const t = liveOf(arg.space, arg.page);
       return { inNewWindow: nOf(t) === wins().length - 1, url: t.linkedBrowser.currentURI.spec, history: t.linkedBrowser.browsingContext.sessionHistory?.count ?? 0,
         saved: Win.copiesOf(t).map(c => SessionStore.getTabState(c)).join().includes("secret-torn-token") };`,
      { space, page: label }
    );
    assert.deepEqual(now, { inNewWindow: true, url: "about:blank", history: 1, saved: false });
    assert.deepEqual((await h.call("spaces.waitForControl", { space, timeout: 5000 })).blanked, [label]);
  } finally {
    await closeNewWindows();
  }
});

async function tornHandOff(name, between) {
  const { space, labels } = await task(name, ["/api/text?" + name.replace(/\W+/g, "-")]);
  const [label] = labels;
  await h.call("page.evaluate", { space, page: label, isFunction: false, fn: `(document.head.append(document.createElement("style")), 1)` });
  const torn = await h.chrome(
    `${W} ${EV}
     const t = liveOf(arg.space, arg.page);
     const evidence = EV.evidenceOf(t.linkedBrowser);
     await tearOff(t);
     return { evidence, now: state(liveOf(arg.space, arg.page)) };`,
    { space, page: label }
  );
  assert.ok(torn.evidence.hooked, "the agent's code left the page hooked");
  assert.equal(torn.now.inNewWindow, true);
  assert.deepEqual(torn.now.evidence, torn.evidence, "the evidence went with the document");
  await between(space);
  const reply = await h.call("spaces.handOff", { space });
  const now = await h.chrome(`${W} ${EV} return state(liveOf(arg.space, arg.page));`, { space, page: label });
  return { label, reply, now, inner: torn.now.inner };
}

const EV = `const EV = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");
  const hold = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/hold.sys.mjs");
  const state = t => ({
    inNewWindow: nOf(t) === wins().length - 1,
    inner: t.linkedBrowser.browsingContext.currentWindowGlobal?.innerWindowId ?? 0,
    evidence: EV.evidenceOf(t.linkedBrowser),
    held: hold.holdOf(t.linkedBrowser) !== undefined,
  });`;

/** The hand-off held the torn-off page and loaded it afresh, clean. */
function heldAfresh({ label, reply, now, inner }) {
  assert.deepEqual(reply.reloaded, [label], "the hand-off loads the torn-off page afresh");
  assert.equal(now.inNewWindow, true);
  assert.equal(now.held, true, "the page the hand-off holds");
  assert.notEqual(now.inner, inner, "a new document");
  assert.deepEqual(now.evidence, {}, "with no evidence");
}

test("a hand-off after a tear-off holds the torn-off page the user sees, though the agent's last call was on another page, and loads it afresh", async () => {
  try {
    heldAfresh(
      await tornHandOff("tear off and hand off", async space => {
        // The agent's last call is on p1, in the Agents Space no window shows.
        await h.call("page.goto", { space, page: "p1", url: `${h.base}/api/text?to-front-p1` });
      })
    );
  } finally {
    await closeNewWindows();
  }
});

test("a hand-off after a tear-off, with a tab of the user's shown in the new window, holds the torn-off page, the agent's last", async () => {
  try {
    heldAfresh(
      await tornHandOff("tear off and look away", () =>
        h.chrome(
          `${W}
           const w = wins().at(-1);
           const t = w.gBrowser.addTab("about:blank", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
           w.gBrowser.selectedTab = t;
           await until(() => w.gBrowser.selectedTab === t);
           return true;`
        )
      )
    );
  } finally {
    await closeNewWindows();
  }
});

/**
 * A task whose only tab is one it keeps that isn't a page: the blank tab
 * pages.close leaves when it closes the task's last page, which the agent's
 * code lists and closes by tab id. Here it loads a page of its own, as a
 * tab someone browses in does, and has its copy in the second window.
 */
async function keptTab(name, path) {
  await h.chrome(`${W} await focus(0); return true;`);
  const space = await h.space(name);
  spaces.push(space);
  // The task's one page, which it starts with.
  const [first] = await h.call("tabs.list", { space });
  await h.call("pages.close", { space, page: first.label });
  // The page ends once Zen has closed its last copy, from window sync's queue.
  await h.chrome(`${W} await until(() => !pageOf(arg.space, arg.label)); return true;`, { space, label: first.label });
  const listed = await h.call("tabs.list", { space });
  assert.deepEqual(listed.map(t => t.label ?? null), [null], "pages.close left the task one tab, not a page");
  const id = listed[0].tab;
  await h.chrome(
    `${W}
     const t = ctx.pages.findTab(recOf(arg.space), arg.id);
     t.linkedBrowser.fixupAndLoadURIString(arg.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
     await until(() => t.linkedBrowser.currentURI?.spec === arg.url && !t.hasAttribute("busy"));
     await until(() => Win.copyIn(t, nth(1)));
     return true;`,
    { space, id, url: `${h.base}/api/text?${path}` }
  );
  return { space, id };
}

/** The tab ids the task's tabs.list names: none once the task has ended. */
const listedIds = space => h.call("tabs.list", { space }).then(
  list => list.map(t => t.tab),
  () => []
);

test("a tab its task keeps that isn't a page, torn off into a new window, stays the task's there, under its tab id", async () => {
  const { space, id } = await keptTab("kept tab torn off", "kto-1");
  try {
    const out = await h.chrome(
      `${W}
       const from = ctx.pages.findTab(recOf(arg.space), arg.id);
       const old = Win.syncId(from);
       // The new tab's value as the move wrote it, before anything later
       // could: this listener runs right after zenius's own, at the old
       // tab's TabClose.
       const before = from.ownerDocument.defaultView;
       let atMove = "no move";
       const onClose = e => {
         if (e.target === from) {
           const v = value(e.detail?.adoptedBy);
           atMove = v && { sync: v.sync, namesOldTab: v.movedFrom === old };
         }
       };
       before.addEventListener("TabClose", onClose);
       let w;
       try {
         w = await tearOff(from);
       } finally {
         before.removeEventListener("TabClose", onClose);
       }
       const t = ctx.pages.findTab(recOf(arg.space), arg.id);
       return {
         found: !!t,
         inNewWindow: !!t && wid(t.ownerDocument.defaultView) === wid(w),
         holder: t ? ctx.pages.holderOf(t) : null,
         task: t ? value(t)?.task ?? null : null,
         sync: t ? value(t)?.sync : "no tab",
         namesOldTab: typeof old === "string" && !!t && value(t)?.movedFrom === old,
         atMove,
       };`,
      { space, id }
    );
    // Its value names the tab's own sync id, from the move on: none, in a
    // torn-off window, never the old tab's. And the old tab's as movedFrom,
    // whose copies Zen closes.
    assert.deepEqual(out, {
      found: true,
      inNewWindow: true,
      holder: space,
      task: space,
      sync: null,
      namesOldTab: true,
      atMove: { sync: null, namesOldTab: true },
    });
    assert.deepEqual(await listedIds(space), [id], "the agent's code lists it under the same id");
  } finally {
    await closeNewWindows();
  }
});

test("a tab its task keeps, torn off into a new window, comes back after a restart, still the task's", async () => {
  const { space, id } = await keptTab("kept tab torn off, restart", "kto-2");
  try {
    await h.chrome(`${W} await tearOff(ctx.pages.findTab(recOf(arg.space), arg.id)); return true;`, { space, id });
    await h.chrome(`await ctx.service.flushState(); return true`);
    const file = join(dir, "prefs.js");
    writeFileSync(file, 'user_pref("browser.startup.page", 3);\nuser_pref("zen.workspaces.continue-where-left-off", false);\n');
    process.env.ZENIUS_DEV_PREFS = file;
    try {
      await h.restart({});
    } finally {
      delete process.env.ZENIUS_DEV_PREFS;
    }
    // Tab ids last while the browser runs: the tab has a new one now.
    const listed = await h.call("tabs.list", { space });
    assert.deepEqual(listed.map(t => [t.label ?? null, t.url]), [[null, `${h.base}/api/text?kto-2`]], "the task kept its tab");
    const out = await h.chrome(
      `${W}
       const t = ctx.pages.findTab(recOf(arg.space), arg.tab);
       return {
         task: value(t)?.task ?? null,
         valueNamesItsTab: value(t)?.sync === Win.syncId(t),
         movedFrom: value(t)?.movedFrom ?? null,
       };`,
      { space, tab: listed[0].tab }
    );
    // The rebuild wrote its value afresh: the old tab's id is gone from it.
    assert.deepEqual(out, { task: space, valueNamesItsTab: true, movedFrom: null });
  } finally {
    await closeNewWindows();
  }
});

test("a tab its task keeps, torn off and Zen quit at once, comes back alone: the copies it left behind close, and the user's tabs stay", async () => {
  const { space, id } = await keptTab("kept tab torn off, quit at once", "kto-4");
  const urls = { plain: `${h.base}/api/text?kto-4-plain`, own: `${h.base}/api/text?kto-4-own` };
  /** The sync ids of two tabs of the user's: a plain one, and one marked as their own. */
  let users = { plain: null, own: null };
  try {
    users = await h.chrome(
      `${W}
       const open = async url => {
         const t = nth(0).gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
         await until(() => t.linkedBrowser.currentURI?.spec === url && !t.hasAttribute("busy"));
         await until(() => Win.syncId(t) && Win.copyIn(t, nth(1)));
         return t;
       };
       const plain = await open(arg.plain);
       const own = await open(arg.own);
       if (!ctx.pages.markUserOwn(own)) throw new Error("not marked");
       return { plain: Win.syncId(plain), own: Win.syncId(own) };`,
      urls
    );
    // The tear-off, and no wait for Zen to close the copies left behind.
    const torn = await h.chrome(
      `${W}
       const t = ctx.pages.findTab(recOf(arg.space), arg.id);
       const old = Win.syncId(t);
       const n = wins().length;
       t.ownerDocument.defaultView.gBrowser.replaceTabWithWindow(t);
       await until(() => wins().length > n);
       const w = wins().at(-1);
       const moved = () => ctx.pages.findTab(recOf(arg.space), arg.id);
       await until(() => moved() && wid(moved().ownerDocument.defaultView) === wid(w));
       return { old, movedFrom: value(moved())?.movedFrom ?? null, task: value(moved())?.task ?? null };`,
      { space, id }
    );
    assert.equal(typeof torn.old, "string");
    // The whole id: two made in one millisecond share its time part.
    assert.deepEqual(
      { movedFrom: torn.movedFrom, task: torn.task },
      { movedFrom: torn.old, task: space },
      "the moved tab's value names the sync id its old tab had"
    );
    await h.chrome(`await ctx.service.flushState(); return true`);
    const file = join(dir, "prefs.js");
    writeFileSync(file, 'user_pref("browser.startup.page", 3);\nuser_pref("zen.workspaces.continue-where-left-off", false);\n');
    process.env.ZENIUS_DEV_PREFS = file;
    try {
      await h.restart({});
    } finally {
      delete process.env.ZENIUS_DEV_PREFS;
    }
    const listed = await h.call("tabs.list", { space });
    assert.deepEqual(listed.map(t => [t.label ?? null, t.url]), [[null, `${h.base}/api/text?kto-4`]], "the task has its one tab, and no blank one left behind");
    const out = await h.chrome(
      `${W}
       const t = ctx.pages.findTab(recOf(arg.space), arg.tab);
       // Every window's tab with this sync id, closing or not.
       const withId = s => wins().flatMap(w => [w.document.getElementById(s)].filter(x => x?.localName === "tab"));
       const open = s => withId(s).filter(x => !x.closing);
       return {
         task: value(t)?.task ?? null,
         valueNamesItsTab: value(t)?.sync === Win.syncId(t),
         movedFrom: value(t)?.movedFrom ?? null,
         leftBehind: withId(arg.old).length,
         plain: open(arg.plain).length > 0,
         own: open(arg.own).length > 0 && ctx.pages.isUserOwn(open(arg.own)[0]),
       };`,
      { space, tab: listed[0].tab, old: torn.old, ...users }
    );
    assert.deepEqual(out, { task: space, valueNamesItsTab: true, movedFrom: null, leftBehind: 0, plain: true, own: true });
  } finally {
    await h
      .chrome(
        `${W}
         for (const s of arg) {
           const x = s && wins().map(w => w.document.getElementById(s)).find(e => e?.localName === "tab" && !e.closing);
           if (x) x.ownerDocument.defaultView.gBrowser.removeTab(x, { animate: false });
         }
         return true;`,
        [users.plain, users.own]
      )
      .catch(() => {});
    await closeNewWindows();
  }
});

test("the restart's close of copies left behind takes the id from any task value, compares it whole, and closes no other tab, nor the one that names it", async () => {
  const out = await h.chrome(
    `${W}
     await focus(0);
     const g = nth(0).gBrowser;
     const open = async () => {
       const t = g.addTab("about:blank", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       await until(() => Win.syncId(t) && Win.copyIn(t, nth(1)));
       return t;
     };
     const tabs = { left: await open(), prefix: await open(), mover: await open(), self: await open(), other: await open() };
     const ids = Object.fromEntries(Object.entries(tabs).map(([k, t]) => [k, Win.syncId(t)]));
     const mark = (t, v) => SessionStore.setCustomTabValue(t, "zenius", JSON.stringify({ v: 1, task: 999999, openedBy: "agent", ...v }));
     // A moved tab whose value isn't its own names a copy left behind.
     mark(tabs.mover, { sync: "not its own", movedFrom: ids.left });
     // Part of an id names nothing: two made in one millisecond share it.
     mark(tabs.other, { sync: ids.other, movedFrom: ids.prefix.slice(0, -1) });
     // A value naming its own tab's id doesn't close that tab.
     mark(tabs.self, { sync: ids.self, movedFrom: ids.self });
     const closed = ctx.pages.closeLeftBehind(Object.values(tabs));
     // Any copy left, closing or not.
     const present = s => wins().some(w => w.document.getElementById(s)?.localName === "tab");
     const result = { closed: [...closed].map(t => Object.keys(tabs).find(k => tabs[k] === t)), present: Object.fromEntries(Object.entries(ids).map(([k, s]) => [k, present(s)])) };
     for (const t of Object.values(tabs)) {
       if (t.isConnected && !t.closing) g.removeTab(t, { animate: false });
     }
     return result;`
  );
  assert.deepEqual(out, {
    closed: ["left"],
    present: { left: false, prefix: true, mover: true, self: true, other: true },
  });
});

test("Move to New Window on another window's copy of a tab its task keeps: the tab ends with the copies Zen closes, and the new window's tab is the user's", async () => {
  const { space, id } = await keptTab("kept tab's copy torn off", "kto-3");
  try {
    const out = await h.chrome(
      `${W}
       const t = ctx.pages.findTab(recOf(arg.space), arg.id);
       const copy = Win.copyIn(t, nth(1));
       // The copy without the document: the first window's has it.
       const standIn = !!t._zenContentsVisible && !copy._zenContentsVisible;
       const w = await tearOff(copy);
       const moved = [...w.gBrowser.tabs].find(x => !x.hasAttribute("zen-empty-tab"));
       return { standIn, value: value(moved), tag: moved.getAttribute("zenius-task"), holder: ctx.pages.holderOf(moved) };`,
      { space, id }
    );
    assert.deepEqual(out, { standIn: true, value: null, tag: null, holder: null });
    assert.deepEqual(await listedIds(space), [], "the task's tab ended");
  } finally {
    await closeNewWindows();
  }
});
