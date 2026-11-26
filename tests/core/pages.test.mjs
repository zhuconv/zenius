// Ego's page model in the pages registry (modules/pages.sys.mjs,
// methods/pages.sys.mjs): permanent labels, tab ids, budget, adopt and
// release, the blank tab left by closing the last page.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(() => h?.close());

const url = path => `${h.base}${path}`;

test("labels are never reused; closed labels say so", async () => {
  const space = await h.space("pages labels");
  const p2 = await h.call("pages.new", { space, url: url("/api/text") });
  assert.equal(p2.label, "p2");
  assert.match(p2.tab, /^t\d+$/);
  await h.call("pages.close", { space, page: "p2" });
  await assert.rejects(h.call("page.goto", { space, page: "p2", url: url("/healthz") }), {
    code: "ZEN_PAGE_NOT_FOUND",
    message: /page p2 was closed/,
  });
  await assert.rejects(h.call("page.goto", { space, page: "p9", url: url("/healthz") }), {
    code: "ZEN_PAGE_NOT_FOUND",
    message: /page label not found: p9/,
  });
  const p3 = await h.call("pages.new", { space });
  assert.equal(p3.label, "p3");
  const listed = await h.call("pages.list", { space });
  assert.deepEqual(
    listed.map(p => p.label),
    ["p1", "p3"]
  );
  for (const page of listed) {
    assert.equal(typeof page.createdAt, "number");
    assert.ok(Math.abs(Date.now() - page.createdAt) < 60000);
    assert.equal(page.opener, null);
    assert.equal(page.openedBy, "agent");
    assert.match(page.tab, /^t\d+$/);
  }
  assert.equal(listed[1].tab, p3.tab);
  await h.call("spaces.finish", { space, keep: [] });
});

test("closing the last page leaves a blank tab that never blocks finish()", async () => {
  const space = await h.space("pages anchor");
  await h.call("pages.close", { space, page: "p1" });
  const tabs = await h.call("tabs.list", { space });
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].label, undefined);
  assert.equal(tabs[0].openedBy, "agent");
  assert.equal(tabs[0].url, "about:blank");
  const receipt = await h.call("spaces.finish", { space, keep: [] });
  assert.deepEqual(receipt, {
    spaceId: space,
    closedSpace: true,
    keptManagedLabels: [],
    closedManagedLabels: [],
    preservedUnmanagedCount: 0,
    protectedTabCount: 0,
    pendingCloseCount: 0,
  });
  assert.equal(await h.ownership(space), null);
});

test("the blank tab goes when a later finish keeps other pages", async () => {
  const space = await h.space("pages anchor keep");
  await h.call("pages.new", { space });
  await h.call("pages.close", { space, page: "p1" });
  // p2 still lives, so no blank tab was needed; close p2 too.
  assert.equal((await h.call("tabs.list", { space })).length, 1);
  const p3 = await h.call("pages.new", { space });
  await h.call("pages.close", { space, page: "p2" });
  const receipt = await h.call("spaces.finish", { space, keep: [p3.label] });
  assert.equal(receipt.closedSpace, false);
  assert.deepEqual(receipt.keptManagedLabels, ["p3"]);
  assert.equal(receipt.protectedTabCount, 0);
  assert.equal(await h.ownership(space), "user");
  await h.remove(space);
});

test("finish closes the agent's pages that aren't kept and validates labels first", async () => {
  const space = await h.space("pages finish");
  await h.call("pages.new", { space });
  await h.call("pages.new", { space });
  await h.call("pages.close", { space, page: "p3" });
  await assert.rejects(h.call("spaces.finish", { space, keep: ["p3"] }), {
    code: "ZEN_PAGE_NOT_FOUND",
    message: /page p3 was closed/,
  });
  await assert.rejects(h.call("spaces.finish", { space }), { code: "ZEN_INVALID_ARGUMENT" });
  const receipt = await h.call("spaces.finish", { space, keep: ["p2"] });
  assert.deepEqual(receipt.keptManagedLabels, ["p2"]);
  assert.deepEqual(receipt.closedManagedLabels, ["p1"]);
  assert.equal((await h.claim(space)).ownership, "agent");
  assert.equal((await h.call("tabs.list", { space })).length, 1);
  await h.remove(space);
});

test("the page budget is Ego's 8", async () => {
  const space = await h.space("pages budget");
  for (let i = 2; i <= 8; i++) {
    assert.equal((await h.call("pages.new", { space })).label, `p${i}`);
  }
  await assert.rejects(h.call("pages.new", { space }), {
    code: "ZEN_PAGE_BUDGET_REACHED",
    message: /Page budget reached \(8\/8\)[\s\S]*Close: await task\.page\('p1'\)\.close\(\)/,
  });
  await h.call("pages.close", { space, page: "p5" });
  assert.equal((await h.call("pages.new", { space })).label, "p9");
  await h.call("spaces.finish", { space, keep: [] });
});

test("adopt a user's tab, use it, release it", async () => {
  const space = await h.userSpace("pages adopt", url("/api/text"));
  await h.claim(space);
  const [userTab] = await h.call("tabs.list", { space });
  assert.equal(userTab.openedBy, "unknown");
  assert.equal(userTab.url, url("/api/text"));
  const adopted = await h.call("pages.adopt", { space, tab: userTab.tab, as: "home" });
  assert.deepEqual(adopted, { label: "home", tab: userTab.tab });
  await assert.rejects(h.call("pages.adopt", { space, tab: userTab.tab }), { code: "ZEN_INVALID_ARGUMENT" });
  assert.equal(await h.call("page.evaluate", { space, page: "home", fn: "location.pathname", isFunction: false }), "/api/text");
  // New pages count from p1 in a claimed space.
  const mine = await h.call("pages.new", { space });
  assert.equal(mine.label, "p1");
  await assert.rejects(h.call("pages.release", { space, page: "p1" }), {
    code: "ZEN_INVALID_ARGUMENT",
    message: /created by the agent; close it instead/,
  });
  assert.deepEqual(await h.call("pages.release", { space, page: "home" }), { tab: userTab.tab, openedBy: "unknown" });
  await assert.rejects(h.call("page.evaluate", { space, page: "home", fn: "1", isFunction: false }), {
    code: "ZEN_PAGE_NOT_FOUND",
    message: /page home was released/,
  });
  const tabs = await h.call("tabs.list", { space });
  assert.deepEqual(
    tabs.map(t => [t.label, t.openedBy]).sort(),
    [
      ["p1", "agent"],
      [undefined, "unknown"],
    ].sort()
  );
  await assert.rejects(h.call("pages.adopt", { space, tab: "t999999" }), { code: "ZEN_PAGE_NOT_FOUND" });
  // The released user tab still protects the space.
  const receipt = await h.call("spaces.finish", { space, keep: [] });
  assert.equal(receipt.closedSpace, false);
  assert.equal(receipt.protectedTabCount, 1);
  await h.remove(space);
});

test("pages.userPage is the tab the user would see in the space", async () => {
  const space = await h.space("pages userpage");
  const p2 = await h.call("pages.new", { space, url: url("/healthz") });
  const userPage = await h.call("pages.userPage", { space });
  assert.ok(["p1", "p2"].includes(userPage.label));
  assert.equal(userPage.openedBy, "agent");
  // After an action on p2, it is the page Zen shows when the user opens the space.
  await h.call("page.evaluate", { space, page: "p2", fn: "1", isFunction: false });
  assert.deepEqual(await h.call("pages.userPage", { space }), { label: "p2", tab: p2.tab, openedBy: "agent" });
  const listed = await h.call("pages.list", { space });
  assert.deepEqual(
    listed.map(p => [p.label, p.active]),
    [
      ["p1", false],
      ["p2", true],
    ]
  );
  await h.call("spaces.finish", { space, keep: [] });
});

// Ego activates a Page for evaluate, navigation, snapshot, waits on the page
// and actions, but not for metadata reads (the eval harness's e2e, "page basic
// operations"). The current Page is the tab the user lands on in the space.
test("metadata reads, waitForURL and events leave the current Page alone; evaluate and goto activate", async () => {
  const space = await h.space("pages current");
  const current = async () => (await h.call("pages.userPage", { space })).label;
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  await h.call("pages.new", { space, url: url("/healthz") });
  assert.equal(await current(), "p2", "a new page is the current one");
  const reads = [
    ["page.url", {}],
    ["page.title", {}],
    ["page.info", {}],
    ["page.events", {}],
    ["page.waitForURL", { matcher: { type: "regex", value: "api/text", flags: "" }, options: {} }],
  ];
  for (const [method, extra] of reads) {
    await h.call(method, { space, page: "p1", ...extra });
    assert.equal(await current(), "p2", `${method} made p1 current`);
  }
  await h.call("page.evaluate", { space, page: "p1", fn: "1", isFunction: false });
  assert.equal(await current(), "p1", "evaluate makes its page current");
  await h.call("page.goto", { space, page: "p2", url: url("/api/text") });
  assert.equal(await current(), "p2", "goto makes its page current");
  await h.call("spaces.finish", { space, keep: [] });
});

test("adopting a tab doesn't make it the current Page", async () => {
  const space = await h.userSpace("pages adopt current", url("/api/text"));
  await h.claim(space);
  const [userTab] = await h.call("tabs.list", { space });
  assert.equal((await h.call("pages.new", { space })).label, "p1");
  assert.equal((await h.call("pages.userPage", { space })).label, "p1");
  await h.call("pages.adopt", { space, tab: userTab.tab, as: "home" });
  assert.equal((await h.call("pages.userPage", { space })).label, "p1");
  await h.remove(space);
});

test("pages.list shows a loading popup's URL, as page.url does", async () => {
  const space = await h.space("pages popup url");
  const slow = url("/api/slow?ms=4000");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  await h.call("page.evaluate", {
    space,
    page: "p1",
    isFunction: false,
    fn: `(document.body.innerHTML = '<button id="go" style="display:block;height:30px" onclick="window.open(\\'/api/slow?ms=4000\\')">go</button>', true)`,
  });
  await h.agentClick(space, "p1", "#go");
  await h.until(async () => (await h.call("pages.list", { space })).some(p => p.label === "p2" && p.url === slow), 3000);
  // The response is still held back: the browser itself shows about:blank.
  const { tab } = (await h.call("pages.list", { space })).find(p => p.label === "p2");
  assert.equal(
    await h.chrome("return ctx.pages.findTab(ctx.spaces.get(arg.space), arg.tab).linkedBrowser.currentURI.spec", { space, tab }),
    "about:blank"
  );
  assert.equal((await h.call("tabs.list", { space })).find(t => t.tab === tab).url, slow);
  assert.equal(await h.call("page.url", { space, page: "p2" }), slow);
  await h.call("spaces.finish", { space, keep: [] });
});
