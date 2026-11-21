// I3 for the agent's JavaScript: waitForFunction and evaluate run only while
// the agent controls its Space (observe/control.sys.mjs). A pause holds a
// wait, and its predicate doesn't run; the user taking the Space ends it.
// An evaluation running when control goes fails, and a busy script stops.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { checkView, pageHelpers, setup } from "../observe/lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(() => env.close());

const sleep = ms => new Promise(r => setTimeout(r, ms));

const LOGIN = "data:text/html,<title>login</title><input id=pw type=password autofocus>";

/** The page's own state, read by the test (dev.evalContent isn't the agent's, and no gate holds it). */
const pageValue = (page, expr) => env.call("dev.evalContent", { ...page.P, code: expr });
/**
 * A value in the agent's world for the page, where its code keeps
 * `window.__x` (docs/research/isolated-world.md); undefined once the page
 * has no world.
 */
const worldValue = async (page, expr) => {
  const r = await env.chrome(
    `const { browser } = ctx.resolvePage(arg.P);
     return await ctx.content(browser.browsingContext, "agentworld#peek", { expr: arg.expr });`,
    { P: page.P, expr }
  );
  return r?.none ? undefined : r?.value;
};
/** The values the predicate read that weren't the empty field; none once its world is gone. */
const typed = async page => ((await worldValue(page, "window.__seen")) ?? []).filter(v => v !== "");

/** Chrome code with this page's tab, browser and Space record in scope. */
const withPage = (page, code, arg) =>
  env.chrome(`const { tab, browser, space: rec } = ctx.resolvePage(arg.P); ${code}`, { P: page.P, ...arg });

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) {
      return v;
    }
    assert.ok(Date.now() < end, `timed out waiting for ${fn}`);
    await sleep(25);
  }
}

/**
 * The agent takes its Space back so it can finish it; then finish. A
 * takeOver waits until 10 s after the user's last real input in the task
 * (zen-core's 7b626b3, which zen-ux's detector feeds), and this test played
 * the user just before: age that input first.
 */
async function finish(page) {
  await withPage(page, `if (rec.lastUserInputAt) rec.lastUserInputAt -= 10000; return true;`).catch(() => {});
  await env.call("spaces.takeOver", { space: page.space }).catch(() => {});
  await env.call("spaces.finish", { space: page.space, keep: [] });
}

test("a predicate polling a password field during a takeover prompt never sees a typed character", async () => {
  // This test is the user: they open the agent's Space and type, so it puts
  // their view back itself and checks that it did.
  const userView = await env.call("dev.viewState");
  const { id } = await env.call("spaces.create", { name: `takeover typing ${Date.now() % 100000}` });
  const page = pageHelpers(env, id, "p1");
  try {
    await page.goto(LOGIN);
    // Every value the agent's predicate reads, kept in the page.
    const waiting = page.call("page.waitForFunction", {
      fn: "() => { const v = document.getElementById('pw').value; (window.__seen ??= []).push(v); return v === 'never'; }",
      isFunction: true,
      options: { timeout: 20000, polling: 20 },
    });
    waiting.catch(() => {});
    await until(async () => ((await worldValue(page, "window.__seen?.length ?? 0")) ?? 0) >= 3);

    // The user opens the agent's Space and types in the field. zen-ux's
    // prompt pauses the agent at the first key, before the page sees it.
    await withPage(
      page,
      `win.__zoUser = { workspace: win.gZenWorkspaces.activeWorkspace, tab: win.gBrowser.selectedTab };
       ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs").notePage(tab);
       await win.gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
       if (win.gBrowser.selectedTab !== tab) win.gBrowser.selectedTab = tab;
       browser.focus();
       return true;`
    );
    await env.call("dev.evalContent", { ...page.P, privileged: true, code: `actor.contentWindow.document.getElementById("pw").focus(); true` });
    await withPage(
      page,
      `const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
       tip.beginInputTransactionForTests(win);
       for (const key of "secret") {
         const ev = new win.KeyboardEvent("", { key });
         tip.keydown(ev);
         tip.keyup(ev);
         await new Promise(r => win.setTimeout(r, 40));
       }
       return true;`
    );
    await sleep(400);
    assert.equal(await pageValue(page, "document.getElementById('pw').value"), "secret", "the user's typing reached the page");
    assert.equal(await withPage(page, `return rec.paused;`), true, "the takeover prompt paused the agent");
    assert.deepEqual(await typed(page), [], "the predicate read what the user typed");

    // The user takes over: the held wait ends, and the predicate never runs again.
    await withPage(
      page,
      `ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI.takeover.resolve(rec.id, "takeover"); return true;`
    );
    const e = await waiting.then(
      v => assert.fail(`the wait resolved with ${v}`),
      err => err
    );
    assert.equal(e.code, "ZEN_TASK_SPACE_USER_IN_CONTROL", e.message);
    assert.equal(e.data.stopped, "page.waitForFunction");
    assert.equal(e.data.reason, "manual_takeover");
    await sleep(200);
    assert.deepEqual(await typed(page), [], "the predicate ran again after the takeover");
  } finally {
    await withPage(
      page,
      `const u = win.__zoUser;
       if (u) {
         await win.gZenWorkspaces.changeWorkspaceWithID(u.workspace);
         if (u.tab?.isConnected && win.gBrowser.selectedTab !== u.tab) win.gBrowser.selectedTab = u.tab;
         delete win.__zoUser;
       }
       return true;`
    ).catch(() => {});
    await finish(page);
  }
  await checkView("takeover typing", userView, await env.call("dev.viewState"), {});
});

test("a pause holds a wait: its predicate doesn't run, and the pause doesn't count against its timeout", () =>
  env.inSpace("pause holds wait", async page => {
    try {
      await page.goto(LOGIN);
      const started = Date.now();
      const waiting = page.call("page.waitForFunction", {
        fn: "() => { window.__runs = (window.__runs || 0) + 1; return window.__go === true; }",
        isFunction: true,
        options: { timeout: 2000, polling: 20 },
      });
      waiting.catch(() => {});
      await until(async () => ((await worldValue(page, "window.__runs ?? 0")) ?? 0) >= 3);
      // The panel's Pause.
      await withPage(page, `service.spaces.setPaused(rec, true); return true;`);
      await sleep(100);
      const runs = await worldValue(page, "window.__runs");
      await worldValue(page, "window.__go = true");
      // Longer than the wait's whole timeout.
      await sleep(2500);
      assert.equal(await worldValue(page, "window.__runs"), runs, "the predicate ran while the Space was paused");
      await withPage(page, `service.spaces.setPaused(rec, false); return true;`);
      assert.equal(await waiting, true);
      assert.ok(Date.now() - started > 2500, "the wait outlasted its timeout, which the pause didn't count");
    } finally {
      await withPage(page, `service.spaces.setPaused(rec, false); return true;`);
    }
  }));

test("an evaluation running when the agent loses control fails, and a busy script is stopped", () =>
  env.inSpace("evaluate stopped", async page => {
    try {
      // Firefox stops a page's running script only on http(s) and file pages
      // (BrowserParent::CanCancelContentJS); on data:, blob: and about:blank
      // a busy script runs on after the call fails.
      await page.goto(`${env.base}/nav-target`);
      // A script that keeps the page busy for 20 s; the user takes the Space.
      const busy = page.fail("page.evaluate", {
        fn: "(() => { const end = Date.now() + 20000; while (Date.now() < end) {} return 'done'; })()",
        isFunction: false,
        responseTimeout: 60000,
      });
      await sleep(300);
      const t0 = Date.now();
      await withPage(page, `service.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" }); return true;`);
      const e = await busy;
      assert.equal(e.code, "ZEN_TASK_SPACE_USER_IN_CONTROL", e.message);
      assert.equal(e.data.stopped, "page.evaluate");
      assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
      // The page answers again: its script was stopped, not left running.
      const answered = Date.now();
      assert.equal(await pageValue(page, "1 + 1"), 2);
      assert.ok(Date.now() - answered < 2000, "the page stayed busy");

      // One waiting on a promise, when the user pauses.
      await env.call("spaces.takeOver", { space: page.space });
      const pending = page.fail("page.evaluate", { fn: "new Promise(() => {})", isFunction: false, responseTimeout: 60000 });
      await sleep(300);
      await withPage(page, `service.spaces.setPaused(rec, true); return true;`);
      const p = await pending;
      assert.equal(p.code, "ZEN_TASK_SPACE_USER_IN_CONTROL", p.message);
      assert.equal(p.data.reason, "paused");
      assert.equal(p.data.stopped, "page.evaluate");
    } finally {
      await withPage(page, `service.spaces.setPaused(rec, false); return true;`);
      await env.call("spaces.takeOver", { space: page.space }).catch(() => {});
    }
  }));
