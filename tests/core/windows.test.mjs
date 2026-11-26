// Two windows, with Zen's window sync on (its default): every window has a
// copy of each tab, and Zen moves a page's docShell to the copy the user
// selects in the focused window. A page is
// its tab's sync id (SPI "Windows: a page is its sync id"): the agent
// drives the live copy, the guards follow it, any copy maps to its page,
// a copy any window shows counts as shown, and lists count each tab once.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
/** The Agents Space, when the first window showed it as the file began. */
let startedOnAgents = null;
before(async () => {
  h = await setup();
  // The tests start with the first window on a Space of the user's, where
  // a user mostly is, and a second window opens on it too. A file before
  // this one may have left the Agents Space shown, as a user who looked at
  // it last would; the test that needs it shown shows it.
  startedOnAgents = await h.chrome(`
    const agents = ctx.spaces.agentsSpace?.uuid;
    if (!agents || win.gZenWorkspaces.activeWorkspace !== agents) return null;
    // A task's own Space isn't the user's; zenius's record of the user's Space is.
    const ours = new Set(ctx.spaces.records().filter(rec => rec.kind === "task" && !rec.gone).map(rec => rec.uuid));
    const user = win.gZenWorkspaces.getWorkspaces().find(ws => ws.uuid !== agents && !ours.has(ws.uuid));
    if (!user) return null;
    await win.gZenWorkspaces.changeWorkspace(user);
    return agents;`);
  await openWindow();
});
after(async () => {
  await h?.chrome(`${W} for (const w of wins().slice(1)) w.close(); return true;`).catch(() => {});
  if (startedOnAgents) {
    await h?.chrome(`${W} await show(0, arg); return true;`, startedOnAgents).catch(() => {});
  }
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

test("a hand-off with secret: the hand back blanks the page where its docShell is, after the user viewed it in another window", async () => {
  const { space, p2 } = await task("secret follow");
  try {
    await h.chrome(`${W} ctx.pages.noteFront(liveOf(arg.space, arg.p2)); return true;`, { space, p2 });
    await h.call("spaces.handOff", { space, secret: true });
    assert.deepEqual(await userSelects(1, space, p2, { focused: true }), { live: 1, selected: true }, "the docShell is in the second window's copy");
    // The user's step there shows the secret.
    await h.chrome(
      `${W} liveOf(arg.space, arg.p2).linkedBrowser.loadURI(Services.io.newURI(arg.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true;`,
      { space, p2, url: `${h.base}/api/text?two-token` }
    );
    await h.until(async () => (await h.chrome(`${W} return liveOf(arg.space, arg.p2).linkedBrowser.currentURI.spec;`, { space, p2 })).includes("two-token"), 10000);
    // The user's Resume.
    await h.chrome(`const s = ctx.spaces.get(arg); await ctx.service.beforeHandBack(s); ctx.spaces.setOwnership(s, "agent", { source: "user" }); return true;`, space);
    const now = await h.chrome(
      `${W} const tab = liveOf(arg.space, arg.p2); return { n: nOf(tab), url: tab.linkedBrowser.currentURI.spec, history: tab.linkedBrowser.browsingContext.sessionHistory?.count ?? 0 };`,
      { space, p2 }
    );
    assert.deepEqual(now, { n: 1, url: "about:blank", history: 1 }, "the copy the user saw the secret in is blank, with no history");
    assert.deepEqual((await h.call("spaces.waitForControl", { space, timeout: 5000 })).blanked, [p2]);
  } finally {
    await userLeaves(1);
    await h.call("spaces.finish", { space, keep: [] });
  }
});

test("a hand-off with secret: the step's page and typing in one window, then a window the user opens: the hand back blanks the page viewed there, and no copy's saved state keeps the step", async () => {
  const { space, p2 } = await task("secret new window");
  let n = 0;
  try {
    await h.chrome(`${W} ctx.pages.noteFront(liveOf(arg.space, arg.p2)); return true;`, { space, p2 });
    await h.call("spaces.handOff", { space, secret: true });
    // The user's step starts in the first window: its page, and their typing there.
    await h.chrome(
      `${W} liveOf(arg.space, arg.p2).linkedBrowser.loadURI(Services.io.newURI(arg.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true;`,
      { space, p2, url: `${h.base}/zoo/forms.html?new-window-token` }
    );
    const typed = await h.chrome(
      `${W} const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
       const inPage = code => ctx.content(liveOf(arg.space, arg.p2).linkedBrowser.browsingContext, "dev#evalContent", { code, privileged: false }).catch(() => "");
       await until(async () => liveOf(arg.space, arg.p2).linkedBrowser.currentURI.spec.includes("new-window-token") && (await inPage("return document.readyState;")) === "complete");
       await inPage('const f = document.querySelector("input[name=nickname]"); f.value = "typed-nw-secret"; f.dispatchEvent(new Event("input", { bubbles: true })); return 1;');
       await TabStateFlusher.flush(liveOf(arg.space, arg.p2).linkedBrowser);
       return SessionStore.getTabState(liveOf(arg.space, arg.p2)).includes("typed-nw-secret");`,
      { space, p2 }
    );
    assert.equal(typed, true, "the first window's copy saved the user's typing");
    // Then they open a window and view the page there: the first window's
    // copy keeps the state it had while it showed the page.
    n = (await openWindow()) - 1;
    assert.deepEqual(await userSelects(n, space, p2, { focused: true }), { live: n, selected: true }, "the docShell is in the new window's copy");
    await h.chrome(`const s = ctx.spaces.get(arg); await ctx.service.beforeHandBack(s); ctx.spaces.setOwnership(s, "agent", { source: "user" }); return true;`, space);
    const now = await h.chrome(
      `${W} const tab = liveOf(arg.space, arg.p2);
       const saved = Win.copiesOf(tab).map(c => SessionStore.getTabState(c)).join();
       return { n: nOf(tab), url: tab.linkedBrowser.currentURI.spec, history: tab.linkedBrowser.browsingContext.sessionHistory?.count ?? 0,
         copies: Win.copiesOf(tab).length, saved: ["new-window-token", "typed-nw-secret"].filter(s => saved.includes(s)) };`,
      { space, p2 }
    );
    assert.deepEqual(now, { n, url: "about:blank", history: 1, copies: n + 1, saved: [] }, "the copy the user saw the secret in is blank, and no copy's saved state keeps the step");
    assert.deepEqual((await h.call("spaces.waitForControl", { space, timeout: 5000 })).blanked, [p2]);
  } finally {
    if (n) {
      await userLeaves(n);
      await h.chrome(`${W} const w = nth(arg); const left = wins().length - 1; w.close(); await until(() => wins().length === left); await focus(0); return true;`, n);
    }
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

/**
 * Where each window has the copies of the task's pages: in its Agents
 * Space's strip, in order, with nothing in the Space the window shows.
 */
const copiesPlaced = (space, labels) =>
  h.chrome(
    `${W}
     const agents = ctx.spaces.agentsSpace.uuid;
     return wins().map((w, n) => {
       const box = w.gZenWorkspaces.workspaceElement(agents)?.tabsContainer;
       const shown = w.gZenWorkspaces.workspaceElement(w.gZenWorkspaces.activeWorkspace)?.tabsContainer;
       const copies = arg.labels.map(l => copyOf(liveOf(arg.space, l), n));
       return {
         inAgents: copies.map(c => !!c && !!box && box.contains(c) && c.getAttribute("zen-workspace-id") === agents),
         inOrder: copies.every((c, i) => i === 0 || c?.previousElementSibling === copies[i - 1]),
         inShown: copies.filter(c => c && shown !== box && shown?.contains(c)).length,
       };
     });`,
    { space, labels }
  );

/** Another task in the Agents Space: running, or stopped by the user, who keeps its tabs. */
async function otherTask(stopped) {
  const space = await h.space(stopped ? "stopped" : "running");
  const { label } = await h.call("pages.new", { space, url: `${h.base}/api/text?other` });
  const B = `const s = ctx.spaces.get(arg.space); const b = ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser;`;
  await h.until(async () => (await h.chrome(`${B} return b.currentURI.spec;`, { space, label })).includes("text?other"), 10000);
  // Both of its tabs: its first page, left blank, and the one it opened.
  const ids = await h.chrome(`${W} return ["p1", arg.label].map(l => Win.syncId(liveOf(arg.space, l)));`, { space, label });
  if (stopped) {
    await h.chrome(`${B} await ctx.service.userTakeOver(s, b); ctx.spaces.setOwnership(s, "user", { source: "user" }); return true;`, { space, label });
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
  }
  return {
    async end() {
      await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
      // The tabs a stop left are the user's: closed here as they would.
      await h.chrome(
        `${W}
         for (const id of arg) {
           const w = wins().find(w => w.document.getElementById(id)?.closing === false);
           if (w) w.gBrowser.removeTab(w.document.getElementById(id), { animate: false });
         }
         await until(() => wins().every(w => arg.every(id => !w.document.getElementById(id))));
         return true;`,
        ids
      );
    },
  };
}

test("a task's pages started as another's page closes get their copies in each window's Agents Space, with a task running or stopped", async () => {
  // The other task keeps the Agents Space. The second window shows a page
  // of a task that ends, and leaves it: its close goes ahead as the next
  // task starts. Window sync puts each copy after the copy of the tab
  // before the original, and the closing tab's copy is gone first.
  for (const stopped of [false, true]) {
    const other = await otherTask(stopped);
    let space;
    try {
      const ended = await task(`ended ${stopped ? "stopped" : "running"}`);
      await userSelects(1, ended.space, ended.p2, { focused: true });
      await userLeaves(1);
      const view = await h.view();
      await h.call("spaces.finish", { space: ended.space, keep: [] });
      let p2;
      ({ space, p2 } = await task(`after a close ${stopped ? "stopped" : "running"}`));
      await h.chrome(`${W} await sleep(300); return true;`);
      assert.deepEqual(
        await copiesPlaced(space, ["p1", p2]),
        [0, 1].map(() => ({ inAgents: [true, true], inOrder: true, inShown: 0 })),
        `${stopped}: each window's Agents Space has the task's copies, in order, and the Space it shows none`
      );
      assert.deepEqual(await h.view(), view, `${stopped}: I1, no window's view changed`);
      // The second window shows the page, so finish waits for it.
      await userSelects(1, space, p2, { focused: false });
      const done = await h.call("spaces.finish", { space, keep: [] });
      space = null;
      assert.equal(done.pendingCloseCount, 1, `${stopped}: p2 waits, since the second window shows it`);
      await userLeaves(1);
    } finally {
      await userLeaves(1).catch(() => {});
      if (space) await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
      await other.end();
    }
  }
});

test("copies window sync left in the Space a window shows go to its Agents Space with the task's next page, in order", async () => {
  // As window sync leaves them when the copy of the tab before the
  // original is missing: the copy where it opened, in the Space the
  // window shows, and each later page's copy after it there. Window sync
  // doesn't see this move: it ignores a closing window's events.
  const { space, p2 } = await task("stray copies");
  try {
    const strayed = await h.chrome(
      `${W}
       const w = nth(1);
       const copy = copyOf(liveOf(arg.space, arg.p2), 1);
       const shown = w.gZenWorkspaces.workspaceElement(w.gZenWorkspaces.activeWorkspace).tabsContainer;
       w._zenClosingWindow = true;
       try {
         w.gBrowser.zenHandleTabMove(copy, () => shown.insertBefore(copy, shown.querySelector(":scope > #tabbrowser-arrowscrollbox-periphery")));
       } finally {
         w._zenClosingWindow = false;
       }
       await sleep(100);
       return { inShown: shown.contains(copy), space: copy.getAttribute("zen-workspace-id") === ctx.spaces.agentsSpace.uuid };`,
      { space, p2 }
    );
    assert.deepEqual(strayed, { inShown: true, space: true }, "the second window's copy of p2 is in the Space it shows");
    const view = await h.view();
    const { label } = await h.call("pages.new", { space });
    await h.chrome(`${W} await until(() => copyOf(liveOf(arg.space, arg.label), 1)); await sleep(300); return true;`, { space, label });
    assert.deepEqual(
      await copiesPlaced(space, ["p1", p2, label]),
      [0, 1].map(() => ({ inAgents: [true, true, true], inOrder: true, inShown: 0 })),
      "both windows' Agents Spaces have every page's copy, in order"
    );
    assert.deepEqual(await h.view(), view, "I1: no window's view changed");
  } finally {
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
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

test("a page whose windows show the Agents Space, where one lacks the copy of the page before it, gets that copy again there, and its own after it, in the strip's order", async () => {
  // As above, with both windows on the Agents Space, as while the user
  // watches the agent in each. The task's next page opens in that strip
  // without a move, and window sync leaves its copy in the second window
  // where it opens: in the Agents Space's strip already, at its end.
  const { space, p2 } = await task("lacking copy, Agents shown");
  const userWs = await h.chrome(`${W} return nth(0).gZenWorkspaces.activeWorkspace;`);
  try {
    const removed = await h.chrome(
      `${W}
       const uuid = ctx.spaces.agentsSpace.uuid;
       await show(0, uuid);
       await show(1, uuid);
       await focus(0);
       const w = nth(1);
       const copy = copyOf(liveOf(arg.space, arg.p2), 1);
       w._zenClosingWindow = true;
       try {
         w.gBrowser.removeTab(copy, { animate: false });
       } finally {
         w._zenClosingWindow = false;
       }
       await until(() => !copyOf(liveOf(arg.space, arg.p2), 1), 5000).catch(() => {});
       return { shown: wins().map(w => w.gZenWorkspaces.activeWorkspace === uuid), gone: !copyOf(liveOf(arg.space, arg.p2), 1) };`,
      { space, p2 }
    );
    assert.deepEqual(removed, { shown: [true, true], gone: true });
    const view = await h.view();
    const { label } = await h.call("pages.new", { space });
    const placed = await h.chrome(
      `${W}
       const tab = liveOf(arg.space, arg.label);
       await until(() => copyOf(tab, 1));
       await sleep(300);
       const uuid = ctx.spaces.agentsSpace.uuid;
       const agents = nth(1).gZenWorkspaces.workspaceElement(uuid).tabsContainer;
       const originals = ["p1", arg.p2, arg.label].map(l => liveOf(arg.space, l));
       const copies = originals.map(t => copyOf(t, 1));
       // The task's pages in each window's Agents Space strip: the second's in the first's order.
       const ids = originals.map(t => Win.syncId(t));
       const pages = n => Win.stripTabs(nth(n), uuid).map(t => Win.syncId(t)).filter(id => ids.includes(id));
       return {
         inAgents: copies.map(c => !!c && agents.contains(c)),
         order: copies.every((c, i) => i === 0 || c?.previousElementSibling === copies[i - 1]),
         sameOrder: pages(0).length === 3 && JSON.stringify(pages(1)) === JSON.stringify(pages(0)),
       };`,
      { space, p2, label }
    );
    assert.deepEqual(placed, { inAgents: [true, true, true], order: true, sameOrder: true }, "the second window's Agents Space has every page's copy, in the first's order");
    assert.deepEqual(await h.view(), view, "I1: no window's view changed");
  } finally {
    await h.chrome(`${W} await show(0, arg); await show(1, arg); await focus(0); return true;`, userWs).catch(() => {});
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
  }
});

test("a strip's tabs, as zenius reads them, leave out Zen's empty tab, which Zen puts first in the strip of the Space a window shows, and a glance tab", async () => {
  // Neither is a page's tab: each window has an empty tab of its own, with
  // an id no other window has. A new window's missing copies come from the
  // other window whose strip has the most tabs, so an empty tab counted
  // there would tip that choice by one.
  const { space, p2 } = await task("strip's own tabs");
  const userWs = await h.chrome(`${W} return nth(0).gZenWorkspaces.activeWorkspace;`);
  try {
    const out = await h.chrome(
      `${W}
       const uuid = ctx.spaces.agentsSpace.uuid;
       await show(1, uuid);
       await focus(0);
       const w2 = nth(1);
       const empty = w2.gZenWorkspaces._emptyTab;
       const tabs = [...w2.gZenWorkspaces.workspaceElement(uuid).tabsContainer.children].filter(el => w2.gBrowser.isTab(el) && !el.closing);
       const strip = Win.stripTabs(w2, uuid);
       // A glance tab, for one read: the attribute comes off before anything else runs.
       const copy = copyOf(liveOf(arg.space, arg.p2), 1);
       copy.setAttribute("zen-glance-tab", "true");
       let glance;
       try {
         glance = !Win.stripTabs(w2, uuid).includes(copy);
       } finally {
         copy.removeAttribute("zen-glance-tab");
       }
       return {
         emptyFirst: tabs[0] === empty,
         strip: strip.length === tabs.length - 1 && strip.every((t, i) => t === tabs[i + 1]),
         glance,
         counts: [0, 1].map(n => Win.stripTabs(nth(n), uuid).length),
       };`,
      { space, p2 }
    );
    assert.deepEqual(
      { emptyFirst: out.emptyFirst, strip: out.strip, glance: out.glance, sameCount: out.counts[0] === out.counts[1] },
      { emptyFirst: true, strip: true, glance: true, sameCount: true },
      `the second window's Agents Space strip is its tabs after the empty tab, without a glance tab, as many as the first window's (${out.counts})`
    );
  } finally {
    await h.chrome(`${W} await show(1, arg); await focus(0); return true;`, userWs).catch(() => {});
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

const SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='4' fill='#0b8043'/></svg>";

test("after a restart, the copy a call loads a page in is the one Zen shows: its title and icon reach both windows, and a window that selects it shows the agent's document", async () => {
  const { space, p2 } = await task("restart load");
  // Neither window shows the task's pages at the quit: they come back unloaded.
  await h.chrome("await ctx.service.flushState(); return true");
  await h.restart({ "browser.startup.page": 3 });
  const restored = await h.chrome(
    `${W}
     await SessionStore.promiseAllWindowsRestored;
     await Promise.all(wins().map(w => w.gZenWorkspaces?.promiseInitialized));
     await sleep(1000);
     const copies = Win.copiesOf(liveOf(arg.space, arg.p2));
     return { windows: wins().length, copies: copies.length, unloaded: copies.every(c => !c.linkedPanel || c.hasAttribute("pending")) };`,
    { space, p2 }
  );
  assert.deepEqual(restored, { windows: 2, copies: 2, unloaded: true });
  try {
    // The agent's call loads the page in one copy, which then gets the
    // page's own title and an SVG icon, the kind window sync can't pass on.
    await h.call("page.goto", { space, page: p2, url: `${h.base}/?restart-load` });
    await h.call("page.evaluate", {
      space,
      page: p2,
      isFunction: false,
      fn: `(() => {
        document.title = "Restarted page";
        const l = document.createElement("link");
        l.rel = "icon";
        l.href = "data:image/svg+xml;base64," + btoa(${JSON.stringify(SVG)});
        document.head.append(l);
        document.body.dataset.agentMark = "the agent's";
        return 1;
      })()`,
    });
    const copies = await h.chrome(
      `${W}
       const live = liveOf(arg.space, arg.p2);
       const copies = Win.copiesOf(live);
       const ok = fn => until(fn, 5000).then(() => true, () => false);
       const titled = await ok(() => copies.every(c => c.getAttribute("label") === "Restarted page"));
       const iconed = await ok(() => !!live.linkedBrowser.mIconURL && copies.every(c => c.linkedBrowser?.mIconURL === live.linkedBrowser.mIconURL));
       return { titled, iconed, labels: copies.map(c => c.getAttribute("label")) };`,
      { space, p2 }
    );
    assert.deepEqual(copies, { titled: true, iconed: true, labels: ["Restarted page", "Restarted page"] }, "both windows' copies show the page's title and icon");
    // The user opens the page in the other window: Zen moves the agent's
    // document there (userSelects waits for it), and doesn't load one of
    // its own beside it.
    const selected = await userSelects(1, space, p2, { focused: true });
    assert.deepEqual(selected, { live: 1, selected: true });
    assert.deepEqual(
      await h.call("page.evaluate", { space, page: p2, isFunction: false, fn: "[location.search, document.body.dataset.agentMark]" }),
      ["?restart-load", "the agent's"],
      "the page is still the document the agent loaded and marked"
    );
  } finally {
    await userLeaves(1).catch(() => {});
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
  }
});
