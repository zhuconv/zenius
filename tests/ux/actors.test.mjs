// The UI's content actors, ZeniusClipboard and ZeniusSystemUi, live only in a
// task's documents (SPEC's I4). They have no DOMWindowCreated of their own:
// the core's Zenius actor makes them in a task's new documents, top and
// frames, and calls their installGuards(). A user's document never gets them,
// so nothing of theirs loads in the user's tabs. The clipboard and system-UI
// suites check what the guards do; this one checks where they live.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const ACTORS = ["ZeniusClipboard", "ZeniusSystemUi"];
const run = Date.now().toString(36).slice(-5);
let h;
let space;
let userView;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  // A task is live through every test: a user's document stays bare anyway.
  ({ id: space } = await h.createSpace({ name: `zen-ux actors ${run}` }));
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/api/text?task` });
});

after(async () => {
  await h?.close();
});

// Chrome-side: which of the UI's actors a document already has (never making
// one), read in its own process; and a frame added to a page.
const K = `
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 5000) => {
    for (const end = Date.now() + ms; !(await fn()); ) {
      if (Date.now() > end) throw new Error("timed out waiting for " + fn);
      await sleep(25);
    }
  };
  const actorsIn = bc => ctx.content(bc, "dev#evalContent", {
    privileged: true,
    code: "return arg.map(n => !!actor.manager.getExistingActor(n));",
    arg: ${JSON.stringify(ACTORS)},
  });
  // A new document in a frame of the page: its own DOMWindowCreated.
  const addFrame = async (bc, src) => {
    await ctx.content(bc, "dev#evalContent", {
      code: "const f = document.createElement('iframe'); f.src = arg; document.body.append(f); await new Promise(r => f.addEventListener('load', r, { once: true })); return true;",
      arg: src,
    });
    return bc.children.at(-1);
  };
`;

test("a document in the user's own tab, and its frame, get neither of zen-ux's actors, while a task is live", async () => {
  const userSpace = await h.userSpace(`zen-ux actors user ${run}`);
  const out = await h.chrome(`${K}
    const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
    const tab = W.tabsInWorkspace(ctx.spaces.get(${userSpace}).uuid)[0];
    const b = tab.linkedBrowser;
    const url = ${JSON.stringify(`${h.base}/api/text?user`)};
    b.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    await until(() => b.currentURI.spec === url && b.browsingContext.currentWindowGlobal?.documentURI?.spec === url);
    await sleep(200);
    const top = b.browsingContext;
    const frame = await addFrame(top, "/api/text?user-frame");
    return { task: !!ctx.service.controlOf(b), top: await actorsIn(top), frame: await actorsIn(frame) };
  `);
  assert.deepEqual(out, { task: false, top: [false, false], frame: [false, false] });
});

test("a task's new documents, top and frame, get both of zen-ux's actors", async () => {
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/api/text?task-again` });
  const out = await h.chrome(`${K}
    const { browser } = ctx.resolvePage({ space: ${space}, page: "p1" });
    const top = browser.browsingContext;
    const frame = await addFrame(top, "/api/text?task-frame");
    return { top: await actorsIn(top), frame: await actorsIn(frame) };
  `);
  assert.deepEqual(out, { top: [true, true], frame: [true, true] });
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
});
