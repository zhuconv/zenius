// Ownership state machine and the I3 control gate (modules/spaces.sys.mjs,
// the dispatcher in modules/service.sys.mjs, methods/spaces.sys.mjs).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { connect } from "../../scripts/lib/rpc.mjs";
import { setup, sleep } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(() => h?.close());

const url = path => `${h.base}${path}`;

test("a new space is the agent's, starts with p1, and its name is taken", async () => {
  const { profiles } = await h.call("profiles.list");
  assert.deepEqual(profiles[0], { id: "default", name: "Default", isDefault: true });
  const name = h.unique("own create");
  const created = await h.call("spaces.create", { name });
  assert.equal(created.ownership, "agent");
  // Pages come with their tab ids, as in pages.list.
  const [p1] = await h.call("pages.list", { space: created.id });
  assert.deepEqual(created.pages, [{ label: "p1", tab: p1.tab, openedBy: "agent" }]);
  const listed = (await h.call("spaces.list")).taskSpaces.find(s => s.id === created.id);
  assert.equal(listed.createdBy, "agent");
  assert.equal(listed.profileId, "default");
  assert.deepEqual(listed.pages, created.pages);
  await assert.rejects(h.call("spaces.create", { name }), { code: "ZEN_TASK_SPACE_NAME_IN_USE" });
  await h.call("spaces.finish", { space: created.id, keep: [] });
});

test("handOff stops agent calls with the reason; takeOver gives control back with the user's page", async () => {
  const space = await h.space("own handoff");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  assert.deepEqual(await h.call("spaces.handOff", { space }), { id: space, ownership: "agentDelegatedToUser" });
  // Under the user's control, spaces.list shows no Pages (I3).
  assert.equal((await h.call("spaces.list")).taskSpaces.find(s => s.id === space).pages, undefined);
  const inControl = { code: "ZEN_TASK_SPACE_USER_IN_CONTROL", data: { space, reason: "manual_takeover" } };
  await assert.rejects(h.call("page.goto", { space, page: "p1", url: url("/healthz") }), inControl);
  // Reads stop too, as in Ego, but setState still reaches the user.
  await assert.rejects(h.call("pages.list", { space }), inControl);
  assert.deepEqual(await h.call("spaces.setState", { space, text: "Waiting for you to sign in" }), { ok: true });
  // handOff again keeps the user in control.
  await h.call("spaces.handOff", { space });

  const waiting = h.call("spaces.waitForControl", { space, timeout: 10000 });
  await sleep(100);
  const back = await h.call("spaces.takeOver", { space });
  assert.equal(back.ownership, "agent");
  assert.equal(back.userPage.label, "p1");
  assert.equal(back.userPage.openedBy, "agent");
  assert.match(back.userPage.tab, /^t\d+$/);
  assert.deepEqual(back.pages, [{ label: "p1", tab: back.userPage.tab, openedBy: "agent" }]);
  assert.deepEqual(await waiting, { ownership: "agent" });
  await h.call("page.goto", { space, page: "p1", url: url("/healthz") });
  await h.call("spaces.finish", { space, keep: [] });
});

test("waitForControl times out while the user keeps control", async () => {
  const space = await h.space("own wait");
  await h.call("spaces.handOff", { space });
  await assert.rejects(h.call("spaces.waitForControl", { space, timeout: 200 }), { code: "ZEN_TIMEOUT" });
  await h.call("spaces.takeOver", { space });
  await h.call("spaces.finish", { space, keep: [] });
});

test("a takeover prompt holds mutating calls with held frames; reads go through", async () => {
  const space = await h.space("own pause");
  const frames = [];
  const off = h.client.onProgress(f => frames.push(f));
  try {
    await h.pause(space, true);
    const goto = h.call("page.goto", { space, page: "p1", url: url("/api/text") });
    await h.until(() => frames.some(f => f.held === true));
    assert.equal(frames[0].reason, "paused");
    assert.equal((await h.call("pages.list", { space })).length, 1);
    await sleep(150);
    await h.pause(space, false);
    // Ego's goto receipt has no URL; read it back.
    assert.deepEqual(await goto, {});
    assert.equal(await h.call("page.url", { space, page: "p1" }), url("/api/text"));
    assert.deepEqual(
      frames.map(f => f.held),
      [true, false]
    );

    // "Take over" while a call is held fails the call.
    frames.length = 0;
    await h.pause(space, true);
    const held = h.call("page.goto", { space, page: "p1", url: url("/healthz") });
    await h.until(() => frames.some(f => f.held === true));
    await h.userTakesOver(space);
    await assert.rejects(held, { code: "ZEN_TASK_SPACE_USER_IN_CONTROL", data: { space, reason: "manual_takeover" } });
    assert.deepEqual(
      frames.map(f => f.held),
      [true]
    );
  } finally {
    off();
  }
  await h.call("spaces.takeOver", { space });
  assert.equal(await h.call("page.evaluate", { space, page: "p1", fn: "location.href", isFunction: false }), url("/api/text"));
  await h.call("spaces.finish", { space, keep: [] });
});

test("a call held when its connection closes never runs", async () => {
  const space = await h.space("own drop");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  await h.pause(space, true);
  const other = await connect(h.instance);
  let held = false;
  other.onProgress(f => (held ||= f.held === true));
  other.call("page.goto", { space, page: "p1", url: url("/healthz") }).catch(() => {});
  await h.until(() => held);
  other.close();
  await sleep(200);
  await h.pause(space, false);
  await sleep(500);
  assert.equal(await h.call("page.evaluate", { space, page: "p1", fn: "location.href", isFunction: false }), url("/api/text"));
  await h.call("spaces.finish", { space, keep: [] });
});

test("finish keeps pages for the user; the task stays ended until the agent claims it again", async () => {
  const space = await h.space("own keep");
  assert.deepEqual(await h.call("spaces.finish", { space, keep: ["p1"] }), {
    spaceId: space,
    closedSpace: false,
    keptManagedLabels: ["p1"],
    closedManagedLabels: [],
    preservedUnmanagedCount: 0,
    protectedTabCount: 0,
    pendingCloseCount: 0,
  });
  assert.equal(await h.ownership(space), "user");
  const inactive = { code: "ZEN_TASK_SPACE_INACTIVE" };
  await assert.rejects(h.call("page.goto", { space, page: "p1", url: url("/healthz") }), inactive);
  await assert.rejects(h.call("spaces.waitForControl", { space, timeout: 5000 }), inactive);
  await assert.rejects(h.call("spaces.takeOver", { space }), inactive);
  await assert.rejects(h.call("spaces.handOff", { space }), inactive);

  const claimed = await h.claim(space);
  assert.equal(claimed.ownership, "agent");
  // The kept page is the agent's tab, now unmanaged: labels ended with the task.
  assert.equal(claimed.userPage.label, undefined);
  assert.equal(claimed.userPage.openedBy, "agent");
  await assert.rejects(h.call("page.goto", { space, page: "p1", url: url("/healthz") }), { code: "ZEN_PAGE_NOT_FOUND" });
  const tabs = await h.call("tabs.list", { space });
  assert.deepEqual(
    tabs.map(t => [t.label, t.openedBy]),
    [[undefined, "agent"]]
  );
  // The agent's own tab doesn't keep the space from closing.
  assert.equal((await h.call("spaces.finish", { space, keep: [] })).closedSpace, true);
});

test("the user's Stop ends the task but not its labels: after a claim, p1 still works", async () => {
  const space = await h.space("own stop");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  // The UI's panel Stop.
  await h.chrome('ctx.spaces.setOwnership(ctx.spaces.get(arg), "user", { source: "user" })', space);
  await assert.rejects(h.call("page.evaluate", { space, page: "p1", fn: "1", isFunction: false }), {
    code: "ZEN_TASK_SPACE_INACTIVE",
  });
  await assert.rejects(h.call("spaces.takeOver", { space }), { code: "ZEN_TASK_SPACE_INACTIVE" });
  const claimed = await h.claim(space);
  assert.equal(claimed.userPage.label, "p1");
  assert.deepEqual(claimed.pages, [{ label: "p1", tab: claimed.userPage.tab, openedBy: "agent" }]);
  assert.equal(await h.call("page.evaluate", { space, page: "p1", fn: "location.pathname", isFunction: false }), "/api/text");
  assert.equal((await h.call("pages.new", { space })).label, "p2");
  await h.call("spaces.finish", { space, keep: [] });
});

test("a claimed user Space keeps its tabs unmanaged, and they keep finish({keep: []}) from closing it", async () => {
  const space = await h.userSpace("own user", url("/api/text"));
  assert.equal(await h.ownership(space), "user");
  // Never claimed: Ego reports the user in control.
  await assert.rejects(h.call("pages.new", { space }), { code: "ZEN_TASK_SPACE_USER_IN_CONTROL" });
  const claimed = await h.claim(space);
  assert.deepEqual(Object.keys(claimed.userPage).sort(), ["openedBy", "tab"]);
  // The user's tabs aren't Pages until adopted.
  assert.deepEqual(claimed.pages, []);
  assert.equal(claimed.userPage.openedBy, "unknown");
  const receipt = await h.call("spaces.finish", { space, keep: [] });
  assert.equal(receipt.closedSpace, false);
  assert.equal(receipt.protectedTabCount, 1);
  assert.equal(receipt.preservedUnmanagedCount, 1);
  assert.equal(await h.ownership(space), "user");
  await h.remove(space);
});

test("spaces.list shows no tab titles of a user workspace that no agent claimed (I2)", async () => {
  const space = await h.userSpace("own titles", "data:text/html,<title>my bank statement</title>secret");
  const entry = async () => (await h.call("spaces.list")).taskSpaces.find(s => s.id === space);
  const { name, recentTabTitles } = await entry();
  assert.match(name, /^own titles /, "the name stays");
  assert.deepEqual(recentTabTitles, []);
  await h.claim(space);
  await h.until(async () => (await entry()).recentTabTitles.includes("my bank statement"));
  await h.call("spaces.finish", { space, keep: "all" });
  assert.ok((await entry()).recentTabTitles.includes("my bank statement"), "a claim that ended keeps them");
  await h.remove(space);
});

test("claim renames the space when given a name", async () => {
  const space = await h.userSpace("own rename");
  const name = h.unique("own renamed");
  const claimed = await h.claim(space, { name });
  assert.equal(claimed.name, name);
  assert.equal((await h.call("spaces.list")).taskSpaces.find(s => s.id === space).name, name);
  await h.remove(space);
});

test("ownership survives a clean browser restart", async () => {
  // Each task's p1 shows a page: Zen's session keeps a blank tab only once
  // it has a sync id (ZenSessionManager's #shouldCollectTab), and a blank p1
  // opened just before the quit sometimes didn't, so its task didn't come
  // back (SPI, "Restart").
  const task = async name => {
    const space = await h.space(name);
    await h.call("page.goto", { space, page: "p1", url: url(`/api/text?${encodeURIComponent(name)}`) });
    return space;
  };
  const kept = await task("own persist");
  await h.call("spaces.handOff", { space: kept });
  const ended = await task("own persist ended");
  await h.call("spaces.finish", { space: ended, keep: ["p1"] });
  // The user hands this one back from their own tab; the agent hasn't asked yet.
  const back = await task("own persist via");
  await h.call("spaces.handOff", { space: back });
  await handBack(back, "ownTab");
  await h.chrome("await ctx.service.flushState(); return true");
  // Zen's default: the session, so the task tabs, come back. With the dev
  // profile's 0, a task in the Agents Space would end with its tabs.
  await h.restart({ "browser.startup.page": 3 });

  const listed = (await h.call("spaces.list")).taskSpaces;
  // What the rebuild saw, for a failure (it flaked once under load).
  const seen = async () =>
    JSON.stringify({
      log: h.instanceLog(/restart rebuild|not restored/),
      tabs: await h.chrome(
        `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
         const P = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/pages.sys.mjs");
         return W.allTabs().map(t => P.readTabValue(t));`
      ),
      ids: { kept, ended, back },
    });
  assert.equal(listed.find(s => s.id === kept)?.ownership, "agentDelegatedToUser", await seen());
  assert.equal(listed.find(s => s.id === ended)?.ownership, "user", await seen());
  assert.ok(listed.some(s => s.id === back), await seen());
  await assert.rejects(h.call("pages.new", { space: ended }), { code: "ZEN_TASK_SPACE_INACTIVE" });
  await h.call("spaces.takeOver", { space: kept });
  assert.equal((await h.call("spaces.takeOver", { space: back })).via, "ownTab");
  await h.remove(kept);
  await h.remove(ended);
  await h.remove(back);
});

test("the user's own tab never joins a task, not even one that claims its Space", async () => {
  const mine = "data:text/html,<title>the user's tab</title>mine";
  const space = await h.userSpace("own tab", mine);
  // The UI's "Use your own tab": the user opens a page there to log in themselves.
  const ownURL = "data:text/html,<title>own tab secret</title>own";
  const own = await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     const rec = ctx.spaces.get(arg.space);
     const tab = W.addBackgroundTab(win, rec.uuid);
     tab.linkedBrowser.fixupAndLoadURIString(arg.url, {
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
     });
     const end = Date.now() + 10000;
     while (tab.linkedBrowser.currentURI.spec !== arg.url && Date.now() < end) {
       await new Promise(r => win.setTimeout(r, 25));
     }
     const marked = ctx.pages.markUserOwn(tab);
     // The user looks at it there last, so Zen remembers it as that Space's tab.
     const home = win.gZenWorkspaces.activeWorkspace;
     await win.gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
     win.gBrowser.selectedTab = tab;
     await win.gZenWorkspaces.changeWorkspaceWithID(home);
     return { marked, id: ctx.pages.tabId(tab) };`,
    { space, url: ownURL }
  );
  assert.equal(own.marked, true);

  const claimed = await h.claim(space);
  assert.equal(claimed.userPage, null, "the Space's remembered tab is the own tab, which isn't the task's");
  const tabs = await h.call("tabs.list", { space });
  assert.deepEqual(
    tabs.map(t => t.title),
    ["the user's tab"]
  );
  await assert.rejects(h.call("pages.adopt", { space, tab: own.id }), { code: "ZEN_PAGE_NOT_FOUND" });
  const listed = (await h.call("spaces.list")).taskSpaces.find(s => s.id === space);
  assert.ok(!JSON.stringify(listed).includes("own tab secret"), "spaces.list shows nothing of it");

  // The task ends; the own tab stays, untouched.
  await h.call("spaces.finish", { space, keep: [] });
  // Zen's gBrowser.tabs has only the active Space's tabs.
  assert.equal(
    await h.chrome(`return [...ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs").allTabs()].some(t => ctx.pages.tabId(t) === arg && ctx.pages.isUserOwn(t))`, own.id),
    true
  );
  await h.chrome(
    `const rec = ctx.spaces.peek(arg);
     for (const t of [...ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs").allTabs()]) {
       if (t.getAttribute("zen-workspace-id") === rec.uuid) win.gBrowser.removeTab(t, { animate: false });
     }
     ctx.spaces.refresh();
     return true;`,
    space
  );
});

/** The user hands the task back in the UI's UI, from their own tab (via "ownTab") or not. */
const handBack = (space, via) =>
  h.chrome(
    `ctx.spaces.setOwnership(ctx.spaces.get(arg.space), "agent", { source: "user", via: arg.via });
     return true;`,
    { space, via: via ?? null }
  );

test("the agent learns of a hand back from the user's own tab once, from waitForControl or takeOver", async () => {
  const space = await h.space("own via result");
  await h.call("spaces.handOff", { space });
  const waiting = h.call("spaces.waitForControl", { space, timeout: 10000 });
  await handBack(space, "ownTab");
  assert.deepEqual(await waiting, { ownership: "agent", via: "ownTab" });
  assert.equal((await h.call("spaces.takeOver", { space })).via, undefined, "said once");

  // Long after the hand back, the agent's takeOver still says so.
  await h.call("spaces.handOff", { space });
  await handBack(space, "ownTab");
  await sleep(200);
  assert.equal((await h.call("spaces.takeOver", { space })).via, "ownTab");

  // A new handoff spends it: this hand back came from the prompt.
  await h.call("spaces.handOff", { space });
  await handBack(space, "ownTab");
  await h.call("spaces.handOff", { space });
  await handBack(space);
  assert.deepEqual(await h.call("spaces.waitForControl", { space, timeout: 1000 }), { ownership: "agent" });
  await h.remove(space);
});

test("a hand back from the UI's own-tab notice says so on spaceChanged", async () => {
  const space = await h.space("own via");
  const events = await h.chrome(
    `const rec = ctx.spaces.get(arg);
     const seen = [];
     const off = ctx.service.addEventListener((name, params) => {
       if (name === "spaceChanged" && params.space === arg && params.ownership) seen.push(params);
     });
     ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "agent" });
     ctx.spaces.setOwnership(rec, "agent", { source: "user", via: "ownTab" });
     off();
     return seen;`,
    space
  );
  assert.deepEqual(
    events.map(e => [e.ownership, e.source, e.via ?? null]),
    [
      ["agentDelegatedToUser", "agent", null],
      ["agent", "user", "ownTab"],
    ]
  );
  await h.remove(space);
});
