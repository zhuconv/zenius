// The pill on an agent close that waits (SPEC §3.5). An agent's close of a
// tab a window shows waits for the user to leave it (the core's tabClosing):
// the page ends for the agent at once, and the UI's pill says why the tab
// stays, with Keep tab (it becomes the user's) and Close now.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prelude, setup, iso } from "./lib.mjs";

let h;
let userView;
const run = Date.now().toString(36).slice(-5);

// Chrome-side helpers once the page has gone: the tab element is kept on
// the window by shownTask().
const Q = () => `
  const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
  const C = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/cursor.sys.mjs");
  const t = win.__zuTab;
  const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error("timed out waiting for " + fn);
      await sleep(25);
    }
  };
  const pill = () => N.noticeText(t, "zenius-task-finished");
  // What Firefox's announcer (A11yUtils.announce) last said.
  const heard = () => win.document.getElementById("a11y-announcement").firstChild?.getAttribute("aria-label") ?? null;
  // Announcements go out together a moment after the first (ANNOUNCE_MS).
  const heardSoon = async () => {
    await ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").announcementsOut(win);
    return heard();
  };
  // The user's click, once the pill has armed (it ignores clicks for 400 ms).
  const press = async label => {
    await sleep(450);
    const b = [...N.noticeElement(t, "zenius-task-finished").querySelectorAll("button")].find(b => b.textContent === label);
    b.click();
  };
  const backToUser = async () => {
    if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
  };
`;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  // An announcement the suite before left pending would join this suite's
  // first (they go out together within ANNOUNCE_MS).
  await h.chrome("await new Promise(r => win.setTimeout(r, 450)); return true;");
});

after(async () => {
  await h
    ?.chrome(
      `${Q()}
      await backToUser();
      for (const kept of win.__zuKept ?? []) if (kept.isConnected) gBrowser.removeTab(kept);
      delete win.__zuKept;
      delete win.__zuTab;
    `
    )
    .catch(() => {});
  await h?.close();
});

/** A task whose page p1 the user is looking at; returns its id. */
async function shownTask(name) {
  const { id } = await h.createSpace({ name });
  await h.call("page.goto", { space: id, page: "p1", url: `${h.base}/` });
  await h.chrome(`${prelude(id)}
    const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    await C.moveCursor(tab, { x: 30, y: 30 }, { label: "Click Done", kind: "click" });
    Pages.landOn(tab);
    await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
    await until(() => gBrowser.selectedTab === tab);
    win.__zuTab = tab;
    win.document.getElementById("a11y-announcement").replaceChildren();
  `);
  return id;
}

test("the agent closing the page the user is looking at: it waits, with a pill; Keep tab makes it theirs", async () => {
  const name = `zen-ux closing keep ${run}`;
  const space = await shownTask(name);
  const closed = await h.call("pages.close", { space, page: "p1" });
  assert.equal(closed.deferred, true, "the premise: the close waits, as the user sees the tab");
  const out = await h.chrome(`${Q()}
    try {
      await until(() => pill());
      const res = {
        pill: pill(),
        heard: await heardSoon(),
        cursor: C.cursorState(t),
        tag: t.getAttribute("zenius-task"),
        waiting: ctx.service.pages.isDeferred(t),
      };
      await press("Keep tab");
      res.kept = { waiting: ctx.service.pages.isDeferred(t), pill: pill(), page: !!ctx.service.lookup(t)?.page };
      // The user leaves it: a kept tab stays.
      await backToUser();
      await sleep(150);
      res.afterLeaving = t.isConnected && !t.closing;
      (win.__zuKept ??= []).push(t);
      return res;
    } finally {
      await backToUser();
    }
  `);
  assert.equal(out.pill, `Agent closed this page · ${iso(name)}, closes when you leave this tab`);
  assert.equal(out.heard, null, "an agent's close of one page is routine: not announced");
  assert.equal(out.cursor, null, "the page ended for the agent: no cursor");
  assert.equal(out.tag, null, "no task tag");
  assert.equal(out.waiting, true);
  assert.deepEqual(out.kept, { waiting: false, pill: null, page: false }, "the user's tab now, no pill");
  assert.equal(out.afterLeaving, true);
});

test("finish() while the user looks at the task's page: 'Task finished', and Close now closes it", async () => {
  // Either model: a task's own workspace stays while a window shows it, too.
  const name = `zen-ux closing finish ${run}`;
  const space = await shownTask(name);
  const receipt = await h.call("spaces.finish", { space, keep: [] });
  assert.ok(receipt.pendingCloseCount >= 1, JSON.stringify(receipt));
  const out = await h.chrome(`${Q()}
    try {
      await until(() => pill());
      const text = pill();
      const said = await heardSoon();
      await press("Close now");
      await until(() => !t.isConnected || t.closing);
      return { text, heard: said, closed: true };
    } finally {
      await backToUser();
    }
  `);
  assert.deepEqual(out, {
    text: `Task finished · ${iso(name)}, closes when you leave this tab`,
    heard: `Task finished: ${iso(name)}. This tab closes when you leave it.`,
    closed: true,
  });
});

test("leaving the tab closes it, pill and all", async () => {
  const space = await shownTask(`zen-ux closing leave ${run}`);
  await h.call("pages.close", { space, page: "p1" });
  const out = await h.chrome(`${Q()}
    try {
      await until(() => pill());
      await backToUser();
      await until(() => !t.isConnected || t.closing);
      return true;
    } finally {
      await backToUser();
    }
  `);
  assert.equal(out, true);
  await h.call("spaces.finish", { space, keep: [] });
});

test("after a restart (tabClosing with no task), the pill says only that the agent closed it", async () => {
  const space = await shownTask(`zen-ux closing restart ${run}`);
  await h.call("pages.close", { space, page: "p1" });
  const out = await h.chrome(`${Q()}
    try {
      await until(() => pill());
      // What the core's rebuild sends for a closing tab a window still shows.
      N.removeNotice(t, "zenius-task-finished");
      ctx.service.emitLocal("tabClosing", { space: null, tab: t });
      await until(() => pill());
      const text = pill();
      await press("Close now");
      await until(() => !t.isConnected || t.closing);
      return text;
    } finally {
      await backToUser();
    }
  `);
  assert.equal(out, "Agent closed this page · closes when you leave this tab");
  await h.call("spaces.finish", { space, keep: [] });
});

test("a close no one sees doesn't wait, and shows no pill", async () => {
  const { id: space } = await h.createSpace({ name: `zen-ux closing hidden ${run}` });
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  await h.chrome(`${prelude(space)} win.__zuTab = tab;`);
  const closed = await h.call("pages.close", { space, page: "p1" });
  assert.equal(closed.deferred, false);
  const out = await h.chrome(`${Q()} await until(() => !t.isConnected || t.closing); return pill();`);
  assert.equal(out, null);
  await h.call("spaces.finish", { space, keep: [] });
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
