// The observe layer's per-page state follows a page when Zen's window sync moves
// its docShell to another window's copy of its tab (SPI "Windows: a page is
// its sync id"). The copy holds the page's browserId, BrowsingContext and
// web progress; the copy it left holds a blank docShell.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { pageHelpers, setup } from "./lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(async () => {
  await env?.chrome(`${W} await focus(0); for (const w of wins().slice(1)) w.close(); await until(() => wins().length === 1); return true;`).catch(() => {});
  await env?.close();
});

const NAV = "chrome://userscripts/content/zenius/observe/navtracker.sys.mjs";
const AUDIO = "chrome://userscripts/content/zenius/observe/audio.sys.mjs";

// Chrome-side helpers, as the core's tests/core/windows.test.mjs has them.
// Windows are compared by outerWindowID, and timers belong to no window: a
// window this code closes takes its own timers with it.
const W = `
  const Win = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const wins = () => [...Services.wm.getEnumerator("navigator:browser")];
  const wid = w => w?.docShell?.outerWindowID ?? null;
  const nth = n => wins()[n];
  const nOf = el => wins().findIndex(w => wid(w) === wid(el?.ownerDocument?.defaultView));
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
  const show = async (n, uuid) => {
    const w = nth(n);
    if (w.gZenWorkspaces.activeWorkspace !== uuid) {
      await w.gZenWorkspaces.changeWorkspace(w.gZenWorkspaces.getWorkspaces().find(ws => ws.uuid === uuid));
    }
  };
`;

/** Open a second window, focus the first again, and wait until Zen gave the second its copies. */
const OPEN_SECOND_WINDOW = `${W}
  const first = nth(0);
  const w = first.OpenBrowserWindow();
  await new Promise(r => w.addEventListener("load", r, { once: true }));
  await w.delayedStartupPromise;
  await w.gZenWorkspaces.promiseInitialized;
  await until(() => w.gZenWorkspaces.allStoredTabs.length >= first.gZenWorkspaces.allStoredTabs.length);
  await focus(0);
  return wins().length;`;

/** The user, in the second window, opens the Agents Space and selects the page's copy: its docShell moves there. */
const USER_SELECTS_IN_SECOND = `${W}
  const { tab, page } = ctx.resolvePage(arg);
  const id = page.browserId;
  await focus(1);
  await show(1, ctx.spaces.agentsSpace.uuid);
  await until(() => Win.copyIn(tab, nth(1))).catch(e => {
    const ids = w => [...w.gZenWorkspaces.allStoredTabs].map(t => t.id);
    throw new Error(e.message + "; the tab " + tab.id + ", window 1 holds " + JSON.stringify(ids(nth(1))) + ", window 0 " + JSON.stringify(ids(nth(0))) + ", windows " + wins().length);
  });
  const copy = Win.copyIn(tab, nth(1));
  nth(1).gBrowser.selectedTab = copy;
  await until(() => copy._zenContentsVisible && copy.linkedBrowser.browserId === id).catch(e => {
    throw new Error(e.message + "; " + JSON.stringify({
      copySpace: copy.getAttribute("zen-workspace-id"), shown: nth(1).gZenWorkspaces.activeWorkspace, agents: ctx.spaces.agentsSpace.uuid,
      visible: copy._zenContentsVisible, copyBrowserId: copy.linkedBrowser.browserId, id, selected: nth(1).gBrowser.selectedTab === copy,
      liveWindow: nOf(ctx.pages.tabFor(page)), focused: nOf(Services.focus.activeWindow?.document?.documentElement),
    }));
  });
  await sleep(100);
  return { id, window: nOf(ctx.pages.tabFor(page)), leftBehind: Win.copyIn(tab, nth(0))?.linkedBrowser.browserId ?? null };`;

/** The user closes the second window: Zen moves the page back first. */
const CLOSE_SECOND_WINDOW = `${W}
  await focus(0);
  for (const w of wins().slice(1)) w.close();
  await until(() => wins().length === 1);
  await sleep(300);
  return true;`;

/** The tracker and zenius's mute for the page with browserId `arg`, read off the <browser> that holds it now. */
const STATE = `${W}
  const { peekTracker } = ChromeUtils.importESModule(${JSON.stringify(NAV)});
  const { mutedByZenius } = ChromeUtils.importESModule(${JSON.stringify(AUDIO)});
  const live = BrowsingContext.getCurrentTopByBrowserId(arg).embedderElement;
  const nav = peekTracker(live);
  return {
    window: nOf(live),
    mark: nav?.zoMark ?? null,
    trackerBrowserIsLive: nav?.browser === live,
    url: nav?.currentURL ?? null,
    pending: !!nav?.pending,
    mutedByZenius: mutedByZenius(live),
    controllerMuted: live.browsingContext.mediaController.isMuted,
  };`;

const until = async (what, fn, ms = 10000) => {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) {
    last = await fn();
    if (last) {
      return last;
    }
  }
  throw new Error(`timed out waiting for ${what}`);
};

// As in the core's suite: the second window opens first, then the task, and
// the task is made directly; tests/core/windows.test.mjs checks what the
// user sees (I1) with two windows.
test("navigation state and zenius's mute follow a page into another window's copy of its tab, and back", async () => {
  const url = `${env.base}/nav-target`;
  let space;
  try {
    assert.equal(await env.chrome(OPEN_SECOND_WINDOW), 2);
    ({ id: space } = await env.call("spaces.create", { name: `two windows ${Date.now() % 100000}` }));
    // A page opened at about:blank, then loaded: a process switch that
    // replaces its BrowsingContext.
    const { label } = await env.call("pages.new", { space, url: "about:blank" });
    const page = pageHelpers(env, space, label);
    await page.goto(url);
    {
      // In the Agents Space, which the user isn't looking at: muted by
      // zenius, and a tracker with state of its own.
      const id = await env.chrome(
        `const { trackerFor } = ChromeUtils.importESModule(${JSON.stringify(NAV)});
         const { browser } = ctx.resolvePage(arg);
         trackerFor(browser).zoMark = "made before the move";
         return browser.browserId;`,
        page.P
      );
      const before = { window: 0, mark: "made before the move", trackerBrowserIsLive: true, url, pending: false };
      assert.deepEqual(await env.chrome(STATE, id), { ...before, mutedByZenius: true, controllerMuted: true });

      const moved = await env.chrome(USER_SELECTS_IN_SECOND, page.P);
      assert.equal(moved.window, 1, "pages.tabFor gives the copy in the second window");
      assert.notEqual(moved.leftBehind, id, "the first window's copy holds another docShell now");
      // The same tracker, on the copy that holds the page; the sound back,
      // since the user sees the page there.
      assert.deepEqual(
        await until("the page's sound back in the second window", async () => {
          const s = await env.chrome(STATE, id);
          return !s.controllerMuted && s;
        }),
        { ...before, window: 1, mutedByZenius: false, controllerMuted: false }
      );
      // Navigations go on being seen there: goto waits for this one through
      // the tracker.
      const there = `${env.base}/nav-target?in-the-second-window`;
      await page.goto(there);
      assert.equal(await page.call("page.url"), there);
      assert.deepEqual(await env.chrome(STATE, id), { ...before, window: 1, url: there, mutedByZenius: false, controllerMuted: false });

      // Zen moves the page back before the window closes: hidden again, so
      // muted again, and still the same tracker.
      await env.chrome(CLOSE_SECOND_WINDOW);
      assert.deepEqual(
        await until("the page muted again in the first window", async () => {
          const s = await env.chrome(STATE, id);
          return s.window === 0 && s.controllerMuted && s;
        }),
        { ...before, url: there, mutedByZenius: true, controllerMuted: true }
      );
      const back = `${env.base}/nav-target?back`;
      await page.goto(back);
      assert.equal(await page.call("page.url"), back);
      assert.equal((await env.chrome(STATE, id)).url, back);
    }
  } finally {
    await env.chrome(CLOSE_SECOND_WINDOW).catch(() => {});
    if (space !== undefined) {
      await env.call("spaces.finish", { space, keep: [] }).catch(() => {});
    }
  }
});

test("a page opened at about:blank and then loaded keeps zenius's mute through the process switch", () =>
  env.inSpace("mute through a switch", async first => {
    const { label } = await env.call("pages.new", { space: first.space, url: "about:blank" });
    const page = first.page(label);
    const id = await env.chrome(`return ctx.resolvePage(arg).browser.browserId;`, page.P);
    await page.goto(`${env.base}/nav-target`);
    const s = await until("the mute on the loaded page", async () => {
      const state = await env.chrome(STATE, id);
      return state.mutedByZenius && state;
    });
    assert.equal(s.controllerMuted, true, "zenius's record says muted, so the page's MediaController must be");
  }));
