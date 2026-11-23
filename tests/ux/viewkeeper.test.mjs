// The view keeper (ui/viewkeeper.sys.mjs, SPEC §3.5 "A still view"), which
// zen-core's tab code wraps around every agent change to a strip: the shown
// tab stays where it was on screen.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
let userView;
let tall;
let short;

// Chrome-side helpers. Tabs are about:blank from a null principal, as
// zen-core's addBackgroundTab makes them, told apart by an attribute.
const K = `
  const VK = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/viewkeeper.sys.mjs");
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const frame = () => new Promise(r => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
  const settle = async () => { await frame(); await sleep(150); await frame(); };
  const top = el => Math.round(el.getBoundingClientRect().top);
  const T = n => gBrowser.tabs.find(t => t.getAttribute("zenius-test-tab") === n);
  const add = (uuid, n) => {
    const t = gBrowser.addTab("about:blank", {
      inBackground: true, skipAnimation: true, skipBackgroundNotify: true,
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}),
    });
    t.setAttribute("zenius-test-tab", n);
    gZenWorkspaces.moveTabToWorkspace(t, uuid);
    return t;
  };
  const drop = n => { const t = T(n); if (t) gBrowser.removeTab(t, { animate: false }); };
  // Show tab n in its Space, centred in a strip that scrolls.
  const showAt = async (uuid, n, { centre = true } = {}) => {
    if (gZenWorkspaces.activeWorkspace !== uuid) await gZenWorkspaces.changeWorkspaceWithID(uuid);
    gBrowser.selectedTab = T(n);
    await settle();
    const sb = VK.stripOf(win);
    // Instant: the strip scrolls smoothly by default, and a slide still
    // running would move the tab during a measurement.
    if (centre) sb.scrollBy({ top: top(T(n)) - (top(sb) + sb.clientHeight / 2), behavior: "instant" });
    await settle();
  };
`;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  // Zen puts each new tab at the top of its Space: A1 ends up first.
  ({ tall, short } = await h.chrome(`${K}
    const t = await gZenWorkspaces.createAndSaveWorkspace("zen-ux view keeper, tall", undefined, true);
    for (let i = 30; i >= 1; i--) add(t.uuid, "A" + i);
    const s = await gZenWorkspaces.createAndSaveWorkspace("zen-ux view keeper, short", undefined, true);
    for (let i = 3; i >= 1; i--) add(s.uuid, "S" + i);
    return { tall: t.uuid, short: s.uuid };
  `));
});

after(async () => {
  await h
    ?.chrome(
      `${K}
      const userWs = ${JSON.stringify(userView?.windows[0].activeWorkspace ?? null)};
      if (userWs && gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
      for (const t of gBrowser.tabs.filter(t => t.hasAttribute("zenius-test-tab"))) gBrowser.removeTab(t, { animate: false });
      for (const uuid of ${JSON.stringify([tall, short])}) if (uuid) await gZenWorkspaces.removeWorkspace(uuid);
    `
    )
    .catch(() => {});
  await h?.close();
});

test("a tab added above the shown tab: Zen's strip moves it a row, keepView holds it still", async t => {
  const out = await h.chrome(`${K}
    await showAt(${JSON.stringify(tall)}, "A15");
    const user = T("A15");
    let y0 = top(user);
    add(${JSON.stringify(tall)}, "N1");
    // At once, and after the next frames: on a throttled Mac (the screen
    // locked) the tab hadn't moved at once.
    const now = top(user) - y0;
    await settle();
    const after = top(user) - y0;
    const without = Math.abs(after) > Math.abs(now) ? after : now;
    await showAt(${JSON.stringify(tall)}, "A15");
    y0 = top(user);
    VK.keepView(() => add(${JSON.stringify(tall)}, "N2"));
    const kept = top(user) - y0;
    await settle();
    const later = top(user) - y0;
    const canScroll = VK.stripCanScroll(win);
    drop("N1");
    drop("N2");
    return { without, kept, later, canScroll };
  `);
  assert.equal(out.canScroll, true);
  if (out.without < 30) {
    // Zen's strip itself held the tab, so keepView's hold can't be told apart.
    t.skip(`the premise doesn't hold here: without the keeper the tab moved ${out.without} px, at once and after the next frames`);
    return;
  }
  assert.ok(Math.abs(out.kept) <= 1, `moved ${out.kept} px`);
  assert.ok(Math.abs(out.later) <= 1, `moved ${out.later} px after the next frames`);
});

test("moves across the shown tab, either way, leave it where it was", async () => {
  const out = await h.chrome(`${K}
    await showAt(${JSON.stringify(tall)}, "A15");
    const user = T("A15");
    let y0 = top(user);
    VK.keepView(() => gBrowser.moveTabBefore(T("A25"), T("A10")));
    const up = top(user) - y0;
    await showAt(${JSON.stringify(tall)}, "A15");
    y0 = top(user);
    VK.keepView(() => gBrowser.moveTabAfter(T("A25"), T("A20")));
    const down = top(user) - y0;
    return { up, down };
  `);
  assert.ok(Math.abs(out.up) <= 1, `moved ${out.up} px`);
  assert.ok(Math.abs(out.down) <= 1, `moved ${out.down} px`);
});

test("a tab closed above the shown tab: no double correction on top of Firefox's own", async () => {
  const out = await h.chrome(`${K}
    add(${JSON.stringify(tall)}, "C1");
    await showAt(${JSON.stringify(tall)}, "A15");
    const user = T("A15");
    const y0 = top(user);
    VK.keepView(() => gBrowser.removeTab(T("C1"), { animate: false }));
    const kept = top(user) - y0;
    await settle();
    return { kept, later: top(user) - y0 };
  `);
  assert.ok(Math.abs(out.kept) <= 1, `moved ${out.kept} px`);
  assert.ok(Math.abs(out.later) <= 1, `moved ${out.later} px after the next frames`);
});

test("with the shown tab scrolled out of view, the tabs in view hold still", async () => {
  const out = await h.chrome(`${K}
    await showAt(${JSON.stringify(tall)}, "A28", { centre: false });
    const sb = VK.stripOf(win);
    sb.scrollTo({ top: 0, behavior: "instant" });
    await settle();
    const box = sb.getBoundingClientRect();
    const firstInView = gBrowser.tabs
      .filter(t => t.hasAttribute("zenius-test-tab") && t.getBoundingClientRect().top >= box.top && t.getBoundingClientRect().bottom <= box.bottom)
      .sort((a, b) => top(a) - top(b))[0];
    const selectedInView = top(T("A28")) < box.bottom;
    const y0 = top(firstInView);
    VK.keepView(() => add(${JSON.stringify(tall)}, "N3"));
    const kept = top(firstInView) - y0;
    drop("N3");
    return { selectedInView, kept, scrolled: Math.round(sb.scrollTop) };
  `);
  assert.equal(out.selectedInView, false, "the premise: the selected tab is out of view");
  assert.ok(Math.abs(out.kept) <= 1, `moved ${out.kept} px`);
});

test("keepView waits for a promise, and puts the view back when fn throws", async () => {
  const out = await h.chrome(`${K}
    await showAt(${JSON.stringify(tall)}, "A15");
    const user = T("A15");
    let y0 = top(user);
    const value = await VK.keepView(async () => {
      await sleep(30);
      add(${JSON.stringify(tall)}, "N4");
      return 7;
    });
    const asyncKept = top(user) - y0;
    await showAt(${JSON.stringify(tall)}, "A15");
    y0 = top(user);
    let thrown = null;
    try {
      VK.keepView(() => {
        add(${JSON.stringify(tall)}, "N5");
        throw new Error("boom");
      });
    } catch (e) {
      thrown = e.message;
    }
    const throwKept = top(user) - y0;
    drop("N4");
    drop("N5");
    return { value, asyncKept, thrown, throwKept };
  `);
  assert.equal(out.value, 7);
  assert.ok(Math.abs(out.asyncKept) <= 1, `moved ${out.asyncKept} px`);
  assert.equal(out.thrown, "boom");
  assert.ok(Math.abs(out.throwKept) <= 1, `moved ${out.throwKept} px`);
});

test("a strip shorter than its box can't scroll: a tab above the shown one moves it (the known limit), one below doesn't", async () => {
  const out = await h.chrome(`${K}
    await showAt(${JSON.stringify(short)}, "S2", { centre: false });
    const user = T("S2");
    const canScroll = VK.stripCanScroll(win);
    let y0 = top(user);
    VK.keepView(() => add(${JSON.stringify(short)}, "N6"));
    const above = top(user) - y0;
    y0 = top(user);
    VK.keepView(() => gBrowser.moveTabAfter(add(${JSON.stringify(short)}, "N7"), T("S3")));
    const below = top(user) - y0;
    drop("N6");
    drop("N7");
    return { canScroll, above, below };
  `);
  assert.equal(out.canScroll, false);
  assert.ok(out.above >= 30, `a tab above moved it ${out.above} px`);
  assert.ok(Math.abs(out.below) <= 1, `a tab below moved it ${out.below} px`);
});

test("the user's view ends as it started", async () => {
  await h.chrome(`${K}
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
  `);
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
