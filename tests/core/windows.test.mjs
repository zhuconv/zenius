// Two windows, with Zen's window sync on (its default): every window has a
// copy of each tab, and Zen moves a page's docShell to the copy the user
// selects in the focused window (docs/research/two-windows.md). A page is
// its tab's sync id (SPI "Windows: a page is its sync id"): the agent
// drives the live copy, the guards follow it, any copy maps to its page,
// a copy any window shows counts as shown, and lists count each tab once.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
  await openWindow();
});
after(async () => {
  await h?.chrome(`${W} for (const w of wins().slice(1)) w.close(); return true;`).catch(() => {});
  await h?.close();
});

// Chrome-side helpers, declared again in each h.chrome call. Windows are
// compared by outerWindowID: the sandbox's wrappers of one window needn't be
// identical objects.
const W = `
  const Win = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const { AGENT_BROWSERS_KEY, TASK_BROWSERS_KEY } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/guards.sys.mjs");
  const wins = () => [...Services.wm.getEnumerator("navigator:browser")];
  const wid = w => w?.docShell?.outerWindowID ?? null;
  const nth = n => wins()[n];
  const nOf = tab => wins().findIndex(w => wid(w) === wid(tab.ownerDocument.defaultView));
  const recOf = space => ctx.spaces.get(space);
  const pageOf = (space, label) => ctx.pages.get(recOf(space), label);
  const liveOf = (space, label) => ctx.pages.tabFor(pageOf(space, label));
  const copyOf = (tab, n) => Win.copyIn(tab, nth(n));
  // Timers of no window: a window this code closes takes its own with it.
  const { setTimeout: later } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const sleep = ms => new Promise(r => later(r, ms));
  const until = async (fn, ms = 10000) => {
    for (const end = Date.now() + ms; !(await fn()); ) {
      if (Date.now() > end) throw new Error("timed out: " + fn);
      await sleep(25);
    }
  };
  const agentsWs = n => nth(n).gZenWorkspaces.getWorkspaces().find(w => w.uuid === ctx.spaces.agentsSpace.uuid);
  const show = async (n, uuid) => {
    const w = nth(n);
    if (w.gZenWorkspaces.activeWorkspace !== uuid) {
      await w.gZenWorkspaces.changeWorkspace(w.gZenWorkspaces.getWorkspaces().find(ws => ws.uuid === uuid));
    }
  };
  const focus = async n => {
    nth(n).focus();
    await until(() => wid(Services.focus.activeWindow) === wid(nth(n)));
  };
  const sets = () => ({
    agent: [...(Services.ppmm.sharedData.get(AGENT_BROWSERS_KEY) ?? [])],
    task: [...(Services.ppmm.sharedData.get(TASK_BROWSERS_KEY) ?? [])],
  });
`;

/** Open the second window, focus the first again, and wait until Zen gave the second its copies. */
async function openWindow() {
  return h.chrome(
    `${W}
     const first = nth(0);
     const w = first.OpenBrowserWindow();
     await new Promise(r => w.addEventListener("load", r, { once: true }));
     await w.delayedStartupPromise;
     await w.gZenWorkspaces.promiseInitialized;
     // A new window gets every tab's copy from Zen's window sync: under a
     // load of 40 that took more than 10 s once.
     await until(() => w.gZenWorkspaces.allStoredTabs.length >= first.gZenWorkspaces.allStoredTabs.length, 30000);
     await focus(0);
     return wins().length;`
  );
}

/**
 * A task with two pages on fixture pages "one" and "two", made while the
 * first window is the most recent one, so its tabs open there.
 */
async function task(name) {
  if ((await h.chrome(`${W} return wins().length;`)) < 2) {
    await openWindow();
  }
  await h.chrome(`${W} await focus(0); return true;`);
  const space = await h.space(name);
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/api/text?one` });
  const p2 = (await h.call("pages.new", { space })).label;
  await h.call("page.goto", { space, page: p2, url: `${h.base}/api/text?two` });
  return { space, p2 };
}

/** The user, in window n (focused or not), opens the Agents Space and selects the page's copy there. */
const userSelects = (n, space, label, { focused }) =>
  h.chrome(
    `${W}
     if (arg.focused) await focus(arg.n); else await focus(arg.n === 0 ? 1 : 0);
     await show(arg.n, ctx.spaces.agentsSpace.uuid);
     const copy = copyOf(liveOf(arg.space, arg.label), arg.n);
     nth(arg.n).gBrowser.selectedTab = copy;
     if (arg.focused) {
       // Zen moves the docShell to the copy the focused window selects.
       await until(() => copy._zenContentsVisible && copy.linkedBrowser.browserId === pageOf(arg.space, arg.label).browserId);
     }
     await sleep(100);
     return { live: nOf(liveOf(arg.space, arg.label)), selected: Win.syncId(nth(arg.n).gBrowser.selectedTab) === Win.syncId(copy) };`,
    { n, space, label, focused }
  );

/** Put window n back on the first window's Space (the user's), first window focused. */
const userLeaves = n =>
  h.chrome(`${W} await show(arg, nth(0).gZenWorkspaces.activeWorkspace); await focus(0); return true;`, n);

test("every window's copy of a page carries its tag, its session value and its tab id, and maps to the page", async () => {
  const { space, p2 } = await task("copies");
  const out = await h.chrome(
    `${W}
     const P = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/pages.sys.mjs");
     const live = liveOf(arg.space, arg.p2);
     const copy = copyOf(live, 1);
     return {
       windows: [nOf(live), copy && nOf(copy)],
       tag: [live.getAttribute(P.TASK_ATTR), copy?.getAttribute(P.TASK_ATTR)],
       value: [P.readTabValue(live)?.label, JSON.parse(SessionStore.getCustomTabValue(copy, P.TAB_VALUE_KEY) || "null")?.label],
       tabId: ctx.pages.tabId(live) === ctx.pages.tabId(copy),
       lookup: ctx.service.lookup(copy)?.page.label,
       shown: Win.isShown(copy),
     };`,
    { space, p2 }
  );
  assert.deepEqual(out, {
    windows: [0, 1],
    tag: [String(space), String(space)],
    value: [p2, p2],
    tabId: true,
    lookup: p2,
    shown: false,
  });
  await h.call("spaces.finish", { space, keep: [] });
});

test("a window opened after a task gets its copies marked as the task's", async () => {
  const { space, p2 } = await task("late window");
  const out = await h.chrome(
    `${W}
     const P = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/pages.sys.mjs");
     const w = nth(0).OpenBrowserWindow();
     try {
       await new Promise(r => w.addEventListener("load", r, { once: true }));
       await w.delayedStartupPromise;
       await w.gZenWorkspaces.promiseInitialized;
       const live = liveOf(arg.space, arg.p2);
       await until(() => Win.copyIn(live, w));
       const copy = Win.copyIn(live, w);
       await until(() => copy.getAttribute(P.TASK_ATTR) === String(arg.space));
       return {
         tag: copy.getAttribute(P.TASK_ATTR),
         value: JSON.parse(SessionStore.getCustomTabValue(copy, P.TAB_VALUE_KEY) || "null")?.label,
         lookup: ctx.service.lookup(copy)?.page.label,
       };
     } finally {
       w.close();
       await focus(0);
     }`,
    { space, p2 }
  );
  assert.deepEqual(out, { tag: String(space), value: p2, lookup: p2 });
  await h.call("spaces.finish", { space, keep: [] });
});

test("a page follows its docShell into the window where the user views it: the agent and the guards go with it", async () => {
  const { space, p2 } = await task("follow");
  const before = await h.chrome(`${W} return { sets: sets(), browserId: pageOf(arg.space, arg.p2).browserId };`, { space, p2 });
  assert.ok(before.sets.agent.includes(before.browserId));
  // Each evalChrome call has a sandbox of its own: the listener lives on the service.
  await h.chrome(
    `${W}
     const moves = (ctx.service.testMoves = []);
     ctx.service.testOffMoves = ctx.service.addEventListener((e, p) => e === "pageMoved" && moves.push({ space: p.space, page: p.page, from: nOf(p.from), to: nOf(p.to) }));
     return true;`
  );
  try {
    const sel = await userSelects(1, space, p2, { focused: true });
    assert.deepEqual(sel, { live: 1, selected: true }, "the live copy is the second window's");
    // The agent reads and acts in the page the user sees.
    assert.equal(await h.call("page.url", { space, page: p2 }), `${h.base}/api/text?two`);
    // A content call reaches the live page, not the blank copy.
    assert.equal(await h.call("page.evaluate", { space, page: p2, fn: "location.href", isFunction: false }), `${h.base}/api/text?two`);
    const after = await h.chrome(
      `${W} ctx.service.publishAgentBrowsers(); return { sets: sets(), browserId: liveOf(arg.space, arg.p2).linkedBrowser.browserId, moves: ctx.service.testMoves };`,
      { space, p2 }
    );
    assert.equal(after.browserId, before.browserId, "the page's browserId moved with its docShell");
    assert.ok(after.sets.agent.includes(before.browserId), `agent set ${after.sets.agent} has ${before.browserId}`);
    assert.ok(after.sets.task.includes(before.browserId), `task set ${after.sets.task} has ${before.browserId}`);
    assert.deepEqual(after.moves, [{ space, page: p2, from: 0, to: 1 }]);
  } finally {
    await h.chrome(`${W} ctx.service.testOffMoves?.(); delete ctx.service.testOffMoves; delete ctx.service.testMoves; return true;`);
    await userLeaves(1);
    await h.call("spaces.finish", { space, keep: [] });
  }
});

test("finish waits for a tab another window shows, and no window's view moves", async () => {
  for (const focused of [false, true]) {
    const { space, p2 } = await task(`finish shown ${focused ? "focused" : "unfocused"}`);
    await userSelects(1, space, p2, { focused });
    const view = await h.view();
    const done = await h.call("spaces.finish", { space, keep: [] });
    assert.equal(done.pendingCloseCount, 1, `${focused}: p2 waits, since the second window shows it`);
    assert.deepEqual(done.closedManagedLabels.sort(), ["p1", p2].sort());
    assert.deepEqual(await h.view(), view, `${focused}: I1, no window's view changed`);
    // The user leaves it: it closes in every window.
    const left = await h.chrome(
      `${W}
       const tab = nth(1).gBrowser.selectedTab;
       const id = Win.syncId(tab);
       await show(1, nth(0).gZenWorkspaces.activeWorkspace);
       await until(() => wins().every(w => !w.document.getElementById(id)));
       return true;`
    );
    assert.equal(left, true);
    await userLeaves(1);
  }
});

test("lists count each tab once, whatever the number of windows", async () => {
  const { space, p2 } = await task("count");
  const tabs = await h.call("tabs.list", { space });
  assert.equal(tabs.length, 2, JSON.stringify(tabs));
  assert.deepEqual((await h.call("pages.list", { space })).map(p => p.label).sort(), ["p1", p2].sort());
  const ids = await h.chrome(
    `${W} return Win.tabsInWorkspace(ctx.spaces.agentsSpace.uuid).filter(t => ctx.service.lookup(t)?.rec.id === arg).length;`,
    space
  );
  assert.equal(ids, 2);
  await h.call("spaces.finish", { space, keep: [] });
});

test("the user's selection of a copy in another window makes it the task's front tab", async () => {
  const { space, p2 } = await task("front");
  await h.call("page.title", { space, page: "p1" }); // the agent's last page: p1
  await userSelects(1, space, p2, { focused: false });
  assert.equal((await h.call("pages.userPage", { space }))?.label, p2);
  await userLeaves(1);
  await h.call("spaces.finish", { space, keep: [] });
});

test("the user's own tab is theirs in every window: no claim lists or adopts any copy of it", async () => {
  const space = await h.userSpace("own copies", `${h.base}/api/text?own`);
  const out = await h.chrome(
    `${W}
     const rec = recOf(arg);
     const tab = Win.tabsInWorkspace(rec.uuid)[0];
     await until(() => copyOf(tab, 1));
     const marked = ctx.pages.markUserOwn(tab);
     return { marked, own: [ctx.pages.isUserOwn(tab), ctx.pages.isUserOwn(copyOf(tab, 1))] };`,
    space
  );
  assert.deepEqual(out, { marked: true, own: [true, true] });
  // The user views it from the second window: its live copy is there now.
  await h.chrome(
    `${W}
     await focus(1);
     await show(1, recOf(arg).uuid);
     const copy = copyOf(Win.tabsInWorkspace(recOf(arg).uuid)[0], 1);
     nth(1).gBrowser.selectedTab = copy;
     await until(() => copy._zenContentsVisible);
     return true;`,
    space
  );
  await h.claim(space);
  const tabs = await h.call("tabs.list", { space });
  assert.ok(!tabs.some(t => /own/.test(t.url ?? "")), `tabs.list lists no copy of the own tab: ${JSON.stringify(tabs)}`);
  await userLeaves(1);
  await h.call("spaces.finish", { space, keep: [] });
  await h.remove(space);
});

/**
 * Task A's new page goes right after A's tabs, above task B's, while the
 * second window shows the Agents Space with a tab of B selected. Returns
 * that window's view before and after: its selection, Space, the selected
 * tab's place on screen, and whether its strip can scroll; and each place
 * that tab had, frame by frame, in between.
 */
async function secondWindowAround(many) {
  await h.chrome(`Services.prefs.setIntPref("zenius.pageBudget", 40); return true;`);
  try {
    await h.chrome(`${W} await focus(0); return true;`);
    const a = await h.space(`keep view A ${many}`);
    const b = await h.space(`keep view B ${many}`);
    for (let i = 0; i < (many ? 24 : 1); i++) {
      await h.call("pages.new", { space: b });
    }
    // Read once the strip holds still: Zen animates a switch of Space (its
    // tabs), and tabs opening and closing. When the switch ends, it sets
    // the Space's padding-top to its essentials' height in the window's
    // next frame (#updatePaddingTopOnTabs), 20 px here. Under load the
    // second window's frames come seldom: reads 50 ms apart agreed four
    // times before that frame came (80 or 82 for 102, then 102 after the
    // next page: the switch finishing, not the page). So first wait for the
    // window's strip to have no animation running, then for reads that
    // agree across four of the window's own frames. The selected tab's
    // place is read inside the strip's box: the Space's header above it
    // settles a few pixels late now and then after a switch, which no tab
    // of the strip moves.
    const mark = () =>
      h.chrome(
        `${W}
         const w = nth(1);
         const strip = () => {
           const ws = w.gZenWorkspaces.workspaceElement(w.gZenWorkspaces.activeWorkspace);
           return ws?.scrollbox?.scrollbox ?? ws?.scrollbox;
         };
         const read = () => {
           const tab = w.gBrowser.selectedTab;
           const top = tab.getBoundingClientRect().top - strip().getBoundingClientRect().top;
           return { selected: Win.syncId(tab), space: w.gZenWorkspaces.activeWorkspace, top: Math.round(top), canScroll: ctx.pages.stripCanScroll(w) };
         };
         const animating = () => {
           const ws = w.gZenWorkspaces.workspaceElement(w.gZenWorkspaces.activeWorkspace);
           return (
             w.gZenWorkspaces._animatingChange ||
             w.document.getAnimations().some(a => {
               const target = a.effect?.target;
               return (
                 ["running", "pending"].includes(a.playState) &&
                 target && (ws?.contains(target) || target.contains?.(ws)) &&
                 a.effect.getComputedTiming().endTime !== Infinity
               );
             })
           );
         };
         // One of the window's frames, which runs what Zen left for it; or
         // 1 s if none comes (a throttled window's rate).
         const frame = () => Promise.race([new Promise(r => w.requestAnimationFrame(() => r())), sleep(1000)]);
         let last = null;
         for (let same = 0, end = Date.now() + 10000; same < 4 && Date.now() < end; ) {
           await frame();
           await sleep(50);
           if (animating()) {
             same = 0;
             last = null;
             continue;
           }
           const now = JSON.stringify(read());
           same = now === last ? same + 1 : 0;
           last = now;
         }
         return read();`
      );
    await h.chrome(
      `${W}
       await show(1, ctx.spaces.agentsSpace.uuid);
       nth(1).gBrowser.selectedTab = copyOf(liveOf(arg, "p1"), 1);
       await sleep(300);
       return true;`,
      b
    );
    const before = await mark();
    // Every frame of the second window's from here: a read after the strip
    // settles misses a slide and back (Zen's animated synced move), and a
    // loaded machine catches it midway now and then.
    await h.chrome(
      `${W}
       const w = nth(1);
       const strip = () => {
         const ws = w.gZenWorkspaces.workspaceElement(w.gZenWorkspaces.activeWorkspace);
         return ws?.scrollbox?.scrollbox ?? ws?.scrollbox;
       };
       const tab = w.gBrowser.selectedTab;
       const tops = (ctx.service.testFrameTops = []);
       const frame = () => {
         if (ctx.service.testFrameTops !== tops) return;
         const top = Math.round(tab.getBoundingClientRect().top - strip().getBoundingClientRect().top);
         if (tops.at(-1) !== top) tops.push(top);
         w.requestAnimationFrame(frame);
       };
       w.requestAnimationFrame(frame);
       return true;`
    );
    await h.call("pages.new", { space: a });
    await h.chrome(`${W} await sleep(500); return true;`);
    const after = await mark();
    const frames = await h.chrome(`const tops = ctx.service.testFrameTops ?? []; ctx.service.testFrameTops = null; return tops;`);
    await userLeaves(1);
    await h.call("spaces.finish", { space: a, keep: [] });
    await h.call("spaces.finish", { space: b, keep: [] });
    return { before, after, frames };
  } finally {
    await h.chrome(`Services.prefs.clearUserPref("zenius.pageBudget"); return true;`);
  }
}

test("a new page's copies don't move the view of a window that shows the Agents Space, in a strip that can't scroll", async () => {
  const { before, after, frames } = await secondWindowAround(false);
  assert.equal(before.canScroll, false);
  assert.deepEqual(after, before, "I1: the second window's selection, Space and view stayed put");
  assert.deepEqual(frames, [before.top], "I1: no frame of the second window moved its selected tab");
});

test("a new page's copies don't move the view of a window that shows the Agents Space, in a strip that scrolls", async () => {
  const { before, after, frames } = await secondWindowAround(true);
  assert.equal(before.canScroll, true);
  assert.deepEqual(after, before, "I1: the second window's selection, Space and view stayed put");
  assert.deepEqual(frames, [before.top], "I1: no frame of the second window moved its selected tab");
});

test("a tab the user's own tab opens is theirs too, in every window", async () => {
  const space = await h.userSpace("own opener", `${h.base}/api/text?own-opener`);
  const out = await h.chrome(
    `${W}
     const rec = recOf(arg);
     const own = Win.tabsInWorkspace(rec.uuid)[0];
     ctx.pages.markUserOwn(own);
     // As a middle-click on one of its links opens it.
     const w = own.ownerDocument.defaultView;
     const opened = w.gBrowser.addTab("about:blank", {
       openerBrowser: own.linkedBrowser,
       inBackground: true,
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
     });
     await until(() => copyOf(opened, 1));
     return { own: [ctx.pages.isUserOwn(opened), ctx.pages.isUserOwn(copyOf(opened, 1))] };`,
    space
  );
  assert.deepEqual(out, { own: [true, true] });
  await h.claim(space);
  assert.deepEqual(await h.call("tabs.list", { space }), [], "no tab of the user's own reaches the agent");
  await h.call("spaces.finish", { space, keep: [] });
  await h.remove(space);
});

test("closing the window that holds a page's docShell keeps the page in the other window", async () => {
  const { space, p2 } = await task("close window");
  await userSelects(1, space, p2, { focused: true });
  // The user goes back to the first window, then closes the second.
  await h.chrome(`${W} await focus(0); nth(1).close(); await until(() => wins().length === 1); await sleep(300); return true;`);
  assert.equal(await h.call("page.url", { space, page: p2 }), `${h.base}/api/text?two`);
  assert.equal(await h.call("page.evaluate", { space, page: p2, fn: "location.href", isFunction: false }), `${h.base}/api/text?two`);
  assert.equal(await h.chrome(`${W} return nOf(liveOf(arg.space, arg.p2));`, { space, p2 }), 0);
  await h.call("spaces.finish", { space, keep: [] });
  await openWindow();
});

/** Close every window but the first, which keeps focus. */
const oneWindow = () =>
  h.chrome(`${W} for (const w of wins().slice(1)) w.close(); await until(() => wins().length === 1); await focus(0); return true;`);

test("a window opened while an agent page is the session's lone blank tab gets that page's copy, and the next page's copy goes to its Agents Space", async () => {
  // Zen hands a new window the other windows' tabs as a first window's
  // state, and Firefox's restoreWindow drops a first window's lone tab with
  // no history: a fresh profile's first task page, before it loads. Here
  // the state Zen hands over is cut down to that one page, as there.
  await oneWindow();
  const space = await h.space("lone tab");
  try {
    const opened = await h.chrome(
      `${W}
       const { ZenSessionStore } = ChromeUtils.importESModule("resource:///modules/zen/ZenSessionManager.sys.mjs");
       const p1 = liveOf(arg, "p1");
       const restore = ZenSessionStore.restoreNewWindow;
       ZenSessionStore.restoreNewWindow = function (w, ssi, ...rest) {
         const own = Object.hasOwn(ssi, "initializeWindow");
         const init = ssi.initializeWindow;
         ssi.initializeWindow = function (win, state) {
           for (const data of state?.windows ?? []) {
             data.tabs = (data.tabs ?? []).filter(t => t.zenSyncId === p1.id).map(t => ({ ...t, entries: [] }));
           }
           return init.call(this, win, state);
         };
         try {
           return restore.call(this, w, ssi, ...rest);
         } finally {
           if (own) ssi.initializeWindow = init;
           else delete ssi.initializeWindow;
         }
       };
       let w;
       try {
         w = nth(0).OpenBrowserWindow();
         await new Promise(r => w.addEventListener("load", r, { once: true }));
         await w.delayedStartupPromise;
         await w.gZenWorkspaces.promiseInitialized;
       } finally {
         ZenSessionStore.restoreNewWindow = restore;
       }
       await until(() => copyOf(p1, 1), 5000).catch(() => {});
       const copy = copyOf(p1, 1);
       await focus(0);
       const agents = w.gZenWorkspaces.workspaceElement(ctx.spaces.agentsSpace.uuid)?.tabsContainer;
       return { copy: !!copy, inAgents: !!copy && !!agents?.contains(copy), page: copy ? ctx.service.lookup(copy)?.page.label ?? null : null };`,
      space
    );
    assert.deepEqual(opened, { copy: true, inAgents: true, page: "p1" }, "the new window has the page's copy, in its Agents Space");
    // Window sync puts a new copy after the copy of the tab before it, so
    // without p1's this one stayed where it opened: in the Space the window
    // shows, the user's.
    const { label } = await h.call("pages.new", { space });
    const placed = await h.chrome(
      `${W}
       const tab = liveOf(arg.space, arg.label);
       await until(() => copyOf(tab, 1));
       await sleep(100);
       const w = nth(1);
       const copy = copyOf(tab, 1);
       const agents = w.gZenWorkspaces.workspaceElement(ctx.spaces.agentsSpace.uuid).tabsContainer;
       return {
         inAgents: agents.contains(copy),
         afterP1: copy.previousElementSibling === copyOf(liveOf(arg.space, "p1"), 1),
         inShownStrip: w.gBrowser.tabs.includes(copy),
       };`,
      { space, label }
    );
    assert.deepEqual(placed, { inAgents: true, afterP1: true, inShownStrip: false }, "I3: the next page's copy is in that window's Agents Space");
    // The user shows the Agents Space there and selects the page: its docShell comes.
    const selected = await h.chrome(
      `${W}
       await focus(1);
       await show(1, ctx.spaces.agentsSpace.uuid);
       const copy = copyOf(liveOf(arg.space, arg.label), 1);
       nth(1).gBrowser.selectedTab = copy;
       await until(() => copy._zenContentsVisible);
       return nth(1).gBrowser.selectedTab === copy;`,
      { space, label }
    );
    assert.equal(selected, true);
  } finally {
    await h.chrome(`${W} if (wins().length > 1) await show(1, nth(0).gZenWorkspaces.activeWorkspace); return true;`).catch(() => {});
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
    // That window has none of the user's tabs: the state was cut down.
    await oneWindow();
    await openWindow();
  }
});

test("a page whose window lacks the copy of the page before it still gets its copy in that window's Agents Space", async () => {
  // A window can lack a copy (above); then window sync leaves the copy of
  // the page after it where it opened. Here the task's last page's copy
  // goes from the second window without window sync seeing it (Zen ignores
  // a closing window's events), and the task's next page comes after it.
  const { space, p2 } = await task("lacking copy");
  try {
    const removed = await h.chrome(
      `${W}
       const w = nth(1);
       const copy = copyOf(liveOf(arg.space, arg.p2), 1);
       w._zenClosingWindow = true;
       try {
         w.gBrowser.removeTab(copy, { animate: false });
       } finally {
         w._zenClosingWindow = false;
       }
       // Until it's gone, not a fixed wait: under load it took longer than
       // 100 ms (zen-eval's Mac dry-run, beside the e2e suite).
       await until(() => !copyOf(liveOf(arg.space, arg.p2), 1), 5000).catch(() => {});
       return { gone: !copyOf(liveOf(arg.space, arg.p2), 1), first: !!copyOf(liveOf(arg.space, arg.p2), 0) };`,
      { space, p2 }
    );
    assert.deepEqual(removed, { gone: true, first: true });
    const { label } = await h.call("pages.new", { space });
    const placed = await h.chrome(
      `${W}
       const tab = liveOf(arg.space, arg.label);
       await until(() => copyOf(tab, 1));
       await sleep(200);
       const w = nth(1);
       const agents = w.gZenWorkspaces.workspaceElement(ctx.spaces.agentsSpace.uuid).tabsContainer;
       const copies = ["p1", arg.p2, arg.label].map(l => copyOf(liveOf(arg.space, l), 1));
       return {
         inAgents: copies.map(c => !!c && agents.contains(c)),
         order: copies.every((c, i) => i === 0 || c?.previousElementSibling === copies[i - 1]),
       };`,
      { space, p2, label }
    );
    assert.deepEqual(placed, { inAgents: [true, true, true], order: true }, "the second window's Agents Space has every page's copy, in order");
  } finally {
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
  }
});

test("after a restart with two windows, each tab is one page again, and every copy is marked", async () => {
  const { space, p2 } = await task("restart");
  const own = await h.userSpace("restart own", `${h.base}/api/text?own-restart`);
  await h.chrome(`${W} ctx.pages.markUserOwn(Win.tabsInWorkspace(recOf(arg).uuid)[0]); return true;`, own);
  // The user viewed p2 from the second window: its live copy is there.
  await userSelects(1, space, p2, { focused: true });
  await userLeaves(1);
  await h.chrome("await ctx.service.flushState(); return true");
  // Zen's default: the session comes back (the dev profile's 0 starts clean).
  await h.restart({ "browser.startup.page": 3 });
  const out = await h.chrome(
    `${W}
     const P = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/pages.sys.mjs");
     await SessionStore.promiseAllWindowsRestored;
     await Promise.all(wins().map(w => w.gZenWorkspaces?.promiseInitialized));
     await sleep(1000);
     const rec = recOf(arg.space);
     const tabs = ctx.pages.tabsOf(rec);
     const copies = tabs.flatMap(t => Win.copiesOf(t));
     const ownTab = Win.tabsInWorkspace(recOf(arg.own).uuid)[0];
     return {
       windows: wins().length,
       tabs: tabs.length,
       pages: ctx.pages.list(arg.space).map(p => p.label).sort(),
       copies: copies.length,
       tagged: copies.filter(c => c.getAttribute(P.TASK_ATTR) === String(arg.space)).length,
       valued: copies.filter(c => JSON.parse(SessionStore.getCustomTabValue(c, P.TAB_VALUE_KEY) || "null")?.task === arg.space).length,
       own: Win.copiesOf(ownTab).map(c => ctx.pages.isUserOwn(c) && !!SessionStore.getCustomTabValue(c, P.OWN_TAB_KEY)),
     };`,
    { space, own }
  );
  assert.deepEqual(out, {
    windows: 2,
    tabs: 2,
    pages: ["p1", p2].sort(),
    copies: 4,
    tagged: 4,
    valued: 4,
    own: [true, true],
  });
  // A claim of the user's Space still finds no tab of theirs to hand over.
  await h.claim(own);
  assert.deepEqual(await h.call("tabs.list", { space: own }), [], "no copy of the user's own tab reaches the agent");
  await h.call("spaces.finish", { space: own, keep: [] });
  await h.call("spaces.finish", { space, keep: [] });
  await h.remove(own);
});
