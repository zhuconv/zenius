// Two windows, with Zen's window sync on (its default): every window has a
// copy of each tab, and Zen moves a page's docShell to the copy the user
// selects in the focused window; the copy it leaves shows about:blank (SPI
// "Windows: a page is its sync id").
// The UI's part:
// - the task's tag on every copy;
// - the pill, the cursor and the takeover prompt on the copy that holds the
//   page, following it between windows;
// - a claim prompt answered in one window gone from every window;
// - the tasks panel's Open in the window the user asked from.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { iso, setup } from "./lib.mjs";

let h;
let userView;
const run = Date.now().toString(36).slice(-5);

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  await openWindow();
});

after(async () => {
  await h?.chrome(`${W()} for (const w of wins().slice(1)) w.close(); return true;`).catch(() => {});
  await h?.close();
});

// Chrome-side helpers, declared again in each call. Windows are compared by
// outerWindowID, and waits use timers of no window: a window the code
// closes takes its own timers with it.
const W = () => `
  const Win = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
  const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
  const C = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/cursor.sys.mjs");
  const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
  const { setTimeout: later } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const nap = ms => new Promise(r => later(r, ms));
  const wait = async (fn, ms = 10000) => {
    for (const end = Date.now() + ms; !(await fn()); ) {
      if (Date.now() > end) throw new Error("timed out: " + fn);
      await nap(25);
    }
  };
  const wins = () => [...Services.wm.getEnumerator("navigator:browser")];
  const wid = w => w?.docShell?.outerWindowID ?? null;
  const nth = n => wins()[n];
  const nOf = tab => (tab ? wins().findIndex(w => wid(w) === wid(tab.ownerDocument.defaultView)) : null);
  const focusWin = async n => {
    nth(n).focus();
    await wait(() => wid(Services.focus.activeWindow) === wid(nth(n)));
  };
  const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
  const recOf = space => ctx.spaces.get(space);
  const pageOf = (space, label) => ctx.pages.get(recOf(space), label);
  const liveOf = (space, label) => ctx.pages.tabFor(pageOf(space, label));
  const copyOf = (tab, n) => Win.copyIn(tab, nth(n));
  const show = async (n, uuid) => {
    const w = nth(n);
    if (w.gZenWorkspaces.activeWorkspace !== uuid) await w.gZenWorkspaces.changeWorkspaceWithID(uuid);
  };
  // The user, in window n, focused, opens the page's Space and selects its
  // copy there: Zen moves the page's docShell to it.
  const viewIn = async (n, space, label) => {
    await focusWin(n);
    const copy = copyOf(liveOf(space, label), n);
    Pages.landOn(copy);
    await show(n, copy.getAttribute("zen-workspace-id"));
    if (nth(n).gBrowser.selectedTab !== copy) nth(n).gBrowser.selectedTab = copy;
    await wait(() => liveOf(space, label) === copy);
    return copy;
  };
  const pillOn = t => (t ? N.noticeElement(t, "zenius-control") : null);
  const buttonsOf = el => [...(el?.querySelectorAll("button") ?? [])].map(b => b.textContent);
  // The user's click, once the pill has armed (it ignores clicks for 400 ms).
  const press = async (el, label) => {
    await nap(450);
    const b = [...(el?.querySelectorAll("button") ?? [])].find(b => b.textContent === label);
    if (!b) throw new Error("no " + label + " button, only " + buttonsOf(el).join("|"));
    b.click();
  };
  // What the core's spaces.handOff does.
  const handOff = (rec, text) => {
    ctx.spaces.setStateText(rec, text);
    ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
  };
`;

/** Open the second window, focus the first again, and wait until Zen gave the second its copies. */
function openWindow() {
  return h.chrome(`${W()}
    const first = nth(0);
    const w = first.OpenBrowserWindow();
    await new Promise(r => w.addEventListener("load", r, { once: true }));
    await w.delayedStartupPromise;
    await w.gZenWorkspaces.promiseInitialized;
    await wait(() => w.gZenWorkspaces.allStoredTabs.length >= first.gZenWorkspaces.allStoredTabs.length);
    await focusWin(0);
    return wins().length;
  `);
}

/** A task on one page, made while the first window is the most recent, so its tab opens there. */
async function task(name, url = `${h.base}/zoo/forms.html`) {
  await h.chrome(`${W()} await focusWin(0); return true;`);
  const { id } = await h.createSpace({ name: `UI two windows: ${name} ${run}` });
  await h.call("page.goto", { space: id, page: "p1", url });
  return id;
}

/** Both windows back on the user's Space, the first focused. */
const userLeaves = () =>
  h.chrome(`${W()} for (let n = wins().length - 1; n >= 0; n--) await show(n, userWs); await focusWin(0); return true;`);

test("every copy of a task's tab carries the task's tag, in each window and in a window opened later, and it changes with the task", async () => {
  const space = await task("tags");
  try {
    const out = await h.chrome(`${W()}
      const rec = recOf(${space});
      const live = liveOf(${space}, "p1");
      const tagOf = t => ({ task: t.getAttribute("zenius-task"), state: t.getAttribute("zenius-task-state"), name: t.querySelector(".tab-content")?.getAttribute("zenius-task-name") ?? null });
      const both = () => [tagOf(copyOf(live, 0)), tagOf(copyOf(live, 1))];
      await wait(() => copyOf(live, 1)?.getAttribute("zenius-task-state"));
      const res = { start: both() };
      handOff(rec, "Log in to continue");
      try {
        await wait(() => both().every(t => t.state === "needs-user"));
        res.handed = both();
        // A window opened now gets a copy of the task's tab, tagged too.
        const w = nth(0).OpenBrowserWindow();
        try {
          await new Promise(r => w.addEventListener("load", r, { once: true }));
          await w.delayedStartupPromise;
          await w.gZenWorkspaces.promiseInitialized;
          await wait(() => Win.copyIn(live, w)?.getAttribute("zenius-task-state") === "needs-user");
          res.later = tagOf(Win.copyIn(live, w));
        } finally {
          w.close();
          await focusWin(0);
        }
      } finally {
        ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      }
      await wait(() => both().every(t => t.state !== "needs-user"));
      res.back = both();
      return res;
    `);
    const [first] = out.start;
    assert.equal(first.task, String(space));
    assert.match(first.name, new RegExp(run));
    assert.ok(["working", "idle"].includes(first.state), first.state);
    assert.deepEqual(out.start[1], first, "the second window's copy has the same tag");
    const handed = { ...first, state: "needs-user" };
    assert.deepEqual(out.handed, [handed, handed]);
    assert.deepEqual(out.later, handed, "so has a window opened later");
    assert.deepEqual(out.back[1], out.back[0]);
    assert.ok(["working", "idle"].includes(out.back[0].state), out.back[0].state);
  } finally {
    await h.call("spaces.finish", { space, keep: [] });
  }
});

test("the pill and the cursor go with the page into the window where the user views it, and back with it", async () => {
  const space = await task("follow");
  try {
    const out = await h.chrome(`${W()}
      const rec = recOf(${space});
      const where = () => {
        const live = liveOf(${space}, "p1");
        const copies = Win.copiesOf(live).sort((a, b) => nOf(a) - nOf(b));
        return {
          live: nOf(live),
          pills: copies.filter(c => pillOn(c)).map(nOf),
          cursors: copies.filter(c => C.cursorState(c)).map(c => [nOf(c), C.cursorState(c).hidden, C.cursorState(c).inDom]),
        };
      };
      const res = {};
      try {
        // Window 0 shows the page, where the agent works.
        await viewIn(0, ${space}, "p1");
        await C.moveCursor(liveOf(${space}, "p1"), { x: 40, y: 40 }, { label: "Click Next", kind: "click" });
        res.start = where();
        // The user views it in window 1.
        await viewIn(1, ${space}, "p1");
        res.moved = where();
        handOff(rec, "Log in to continue");
        await wait(() => pillOn(liveOf(${space}, "p1")));
        res.handed = where();
        // Back in window 0, which still shows its copy: the page comes back.
        await focusWin(0);
        await wait(() => nOf(liveOf(${space}, "p1")) === 0 && pillOn(liveOf(${space}, "p1")));
        res.back = { ...where(), buttons: buttonsOf(pillOn(liveOf(${space}, "p1"))) };
        await press(pillOn(liveOf(${space}, "p1")), "Resume agent");
        await wait(() => rec.ownership === "agent" && C.cursorState(liveOf(${space}, "p1"))?.inDom);
        res.handedBack = where();
        return res;
      } finally {
        if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      }
    `);
    assert.deepEqual(out.start, { live: 0, pills: [], cursors: [[0, false, true]] });
    assert.deepEqual(out.moved, { live: 1, pills: [], cursors: [[1, false, true]] }, "the cursor is drawn where the user looks");
    assert.deepEqual(out.handed, { live: 1, pills: [1], cursors: [[1, true, false]] }, "the pill is on the copy the user sees");
    assert.deepEqual(out.back, { live: 0, pills: [0], cursors: [[0, true, false]], buttons: ["Resume agent"] });
    assert.deepEqual(out.handedBack, { live: 0, pills: [], cursors: [[0, false, true]] });
  } finally {
    await userLeaves();
    await h.call("spaces.finish", { space, keep: [] });
  }
});

test("the takeover prompt goes with the page into the other window", async () => {
  const space = await task("takeover");
  try {
    const out = await h.chrome(`${W()}
      const rec = recOf(${space});
      const promptOn = t => N.noticeElement(t, "zenius-takeover");
      const promptIn = () => [0, 1].filter(n => promptOn(copyOf(liveOf(${space}, "p1"), n)));
      try {
        await viewIn(0, ${space}, "p1");
        // The user's input in the agent's page opens the prompt there.
        UI.takeover.handleInput(rec, liveOf(${space}, "p1"), "pointer");
        const first = promptIn();
        await viewIn(1, ${space}, "p1");
        await wait(() => promptIn()[0] === 1);
        return {
          first,
          moved: promptIn(),
          state: nOf(UI.takeover.promptState(rec.id)?.tab),
          text: N.noticeText(copyOf(liveOf(${space}, "p1"), 1), "zenius-takeover")?.startsWith("Agent paused") ?? false,
        };
      } finally {
        // Unpauses the task too.
        UI.takeover.resolve(rec.id, "cancel");
      }
    `);
    assert.deepEqual(out, { first: [0], moved: [1], state: 1, text: true });
  } finally {
    await userLeaves();
    await h.call("spaces.finish", { space, keep: [] });
  }
});

test("a claim prompt shows in every window, and answered in one it goes from every window", async () => {
  const space = await h.userSpace(`UI two windows claim ${run}`);
  // Both windows show the same tab: each has a prompt on its own copy. It's
  // a tab of the test's own, which window sync copies to the second window.
  // The first window's selected tab may have no copy: in a fresh profile
  // it's Zen's empty tab, and each window has its own.
  const tabId = await h.chrome(`${W()}
    await focusWin(0);
    await show(0, userWs);
    const tab = nth(0).gBrowser.addTab(${JSON.stringify(`${h.base}/`)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    try {
      nth(0).gBrowser.selectedTab = tab;
      await wait(() => Win.syncId(tab) && copyOf(tab, 1));
      await focusWin(1);
      const copy = copyOf(tab, 1);
      await show(1, copy.getAttribute("zen-workspace-id"));
      nth(1).gBrowser.selectedTab = copy;
      await focusWin(0);
      return Win.syncId(tab);
    } catch (e) {
      // A tab left behind would stay in the user's Space for every later test.
      nth(0).gBrowser.removeTab(tab, { animate: false });
      throw e;
    }
  `);
  try {
    const pending = h.call("spaces.claim", { space, client: "Trip planner", timeout: 30000 }).then(
      value => ({ value }),
      error => ({ error })
    );
    const out = await h.chrome(`${W()}
      const askFor = s => ctx.service.spaces.pendingClaims().find(a => a.space === s);
      await wait(() => askFor(${space}));
      const id = "zenius-claim:" + askFor(${space}).id;
      const shownIn = () => [0, 1].filter(n => N.noticeElement(nth(n).gBrowser.selectedTab, id));
      await wait(() => shownIn().length === 2);
      const res = { sameTab: Win.sameTab(nth(0).gBrowser.selectedTab, nth(1).gBrowser.selectedTab), shown: shownIn() };
      await focusWin(1);
      await press(N.noticeElement(nth(1).gBrowser.selectedTab, id), "Deny");
      await wait(() => shownIn().length === 0);
      res.after = shownIn();
      await focusWin(0);
      return res;
    `);
    const { error } = await pending;
    assert.deepEqual(out, { sameTab: true, shown: [0, 1], after: [] });
    assert.equal(error?.code, "ZEN_TASK_SPACE_CLAIM_DENIED", error?.message);
  } finally {
    await h
      .chrome(`${W()} const t = nth(0).document.getElementById(${JSON.stringify(tabId)}); if (t) nth(0).gBrowser.removeTab(t, { animate: false }); return true;`)
      .catch(() => {});
  }
  await userLeaves();
});

test("a close that waits for the user: its pill goes with the page between windows, and its Close closes the tab in every window", async () => {
  const space = await task("closing");
  const sync = await h.chrome(`${W()}
    await viewIn(0, ${space}, "p1");
    const copy = await viewIn(1, ${space}, "p1");
    return Win.syncId(copy);
  `);
  try {
    // Both windows show the page, so its close waits (the core, I1).
    await h.call("spaces.finish", { space, keep: [] });
    const out = await h.chrome(`${W()}
      const copyIn = n => nth(n).document.getElementById(${JSON.stringify(sync)});
      const pills = () => [0, 1].filter(n => copyIn(n) && N.noticeElement(copyIn(n), "zenius-task-finished"));
      await wait(() => pills().length);
      const res = { first: pills(), waits: ctx.service.pages.isDeferred(copyIn(0)) };
      await focusWin(0);
      await wait(() => pills().length === 1 && pills()[0] === 0);
      res.back = { pills: pills(), buttons: buttonsOf(N.noticeElement(copyIn(0), "zenius-task-finished")) };
      await press(N.noticeElement(copyIn(0), "zenius-task-finished"), "Close now");
      await wait(() => !copyIn(0) && !copyIn(1));
      return res;
    `);
    assert.deepEqual(out, { first: [1], waits: true, back: { pills: [0], buttons: ["Keep tab", "Close now"] } });
  } finally {
    await userLeaves();
  }
});

test("Open in a window's tasks panel shows the task in that window, on its copy of the page, and moves no other window's view", async () => {
  const space = await task("open");
  try {
    const out = await h.chrome(`${W()}
      await show(0, userWs);
      await focusWin(1);
      await show(1, userWs);
      const kept = { ws: nth(0).gZenWorkspaces.activeWorkspace, tab: Win.syncId(nth(0).gBrowser.selectedTab) };
      const copy = copyOf(liveOf(${space}, "p1"), 1);
      const panel = UI.openTasksPanel(nth(1));
      await wait(() => panel.state === "open", 5000);
      panel.querySelector('.zenius-task[data-space="${space}"] button[data-action="open"]').click();
      await wait(() => nth(1).gBrowser.selectedTab === copy && liveOf(${space}, "p1") === copy);
      return {
        shownInWindow1: nth(1).gZenWorkspaces.activeWorkspace === recOf(${space}).uuid,
        focused: wid(Services.focus.activeWindow) === wid(nth(1)),
        window0Kept: nth(0).gZenWorkspaces.activeWorkspace === kept.ws && Win.syncId(nth(0).gBrowser.selectedTab) === kept.tab,
      };
    `);
    assert.deepEqual(out, { shownInWindow1: true, focused: true, window0Kept: true });
  } finally {
    await userLeaves();
    await h.call("spaces.finish", { space, keep: [] });
  }
});

test("the user's view ends as it started", async () => {
  await h.chrome(`${W()}
    for (const w of wins().slice(1)) w.close();
    await wait(() => wins().length === 1);
    await show(0, userWs);
    const start = nth(0).document.getElementById(${JSON.stringify(userView.windows[0].selectedTabSyncId)});
    if (start && nth(0).gBrowser.selectedTab !== start) nth(0).gBrowser.selectedTab = start;
    await focusWin(0);
    return true;
  `);
  const view = await h.call("dev.viewState");
  assert.equal(view.windows.length, 1);
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTabSyncId, userView.windows[0].selectedTabSyncId);
});
