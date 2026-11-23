// The agent cursor (runtime/JS/zenius/ui/cursor.sys.mjs) in a real headless
// Zen: hidden tabs pay nothing, the user sees the cursor when they open the
// agent Space, moves animate and land on the right point at any zoom,
// content screenshots never contain it, and the user's view never changes
// unless the test itself plays the user.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prelude, setup, SMOOTH_FRAME_MS } from "./lib.mjs";

let h;
let space;
let P;
let userView;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  ({ id: space } = await h.createSpace({ name: "zen-ux cursor test" }));
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  P = prelude(space);
});

after(async () => {
  // Leave the browser as the user had it, even if a test failed midway.
  await h?.chrome(`
    const ws = ${JSON.stringify(userView?.windows?.[0]?.activeWorkspace ?? null)};
    if (ws && gZenWorkspaces.activeWorkspace !== ws) await gZenWorkspaces.changeWorkspaceWithID(ws);
  `);
  await h?.close();
});

test("on a hidden tab, a move records the point and returns at once", async t => {
  const r = await h.call("ui.cursor", { space, page: "p1", x: 120, y: 80, label: "Open the menu", kind: "click" });
  assert.deepEqual(r, { ok: true, visible: false, animated: false });

  const out = await h.chrome(`${P}
    C.stats.reset();
    const N = 1000;
    const t0 = ChromeUtils.now();
    for (let i = 0; i < N; i++) await C.moveCursor(tab, { x: i % 300, y: 90 }, { label: "Scan", kind: "move" });
    return {
      perCallMs: (ChromeUtils.now() - t0) / N,
      inMoveMs: C.stats.hiddenMs / C.stats.hidden,
      stats: { moves: C.stats.moves, hidden: C.stats.hidden, animated: C.stats.animated },
      state: C.cursorState(tab),
      layers: browser.parentElement.querySelectorAll(".zenius-cursor-layer").length,
    };
  `);
  assert.equal(out.stats.hidden, 1000);
  assert.equal(out.stats.animated, 0);
  // Returning at once means no frame, no animation and no overlay: far under
  // a millisecond. The bound leaves room for a busy machine (zen-eval measured
  // 0.23 ms a move on a Mac during a Zoom call); a wait for a frame or an
  // animation would still cost several times it.
  t.diagnostic(`a hidden move: ${out.perCallMs.toFixed(4)} ms a call, ${out.inMoveMs.toFixed(4)} ms of it in moveCursor`);
  assert.ok(out.perCallMs < 1, `a hidden move costs ${out.perCallMs} ms (${out.inMoveMs} ms in moveCursor)`);
  assert.equal(out.layers, 0, "no overlay DOM for a tab nobody has seen");
  assert.equal(out.state.x, 999 % 300);
  assert.equal(out.state.label, "Scan");
  assert.equal(out.state.stale, true);
  assert.deepEqual(await h.call("dev.viewState"), userView, "the user's view is unchanged");
});

test("opening the agent Space shows the agent's page with the cursor at its last point", async () => {
  const out = await h.chrome(`${P}
    await C.moveCursor(tab, { x: 222, y: 111 }, { label: "Click Save", kind: "click" });
    // Played by the user: the panel's Open shows the task's page, in either
    // model. (Zen's own landing tab is tests/ux/agentsspace.test.mjs's.)
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    await UI.openSpace(rec);
    await until(() => gBrowser.selectedTab === tab && C.cursorState(tab)?.inDom && !C.cursorState(tab).stale);
    const cur = browser.parentElement.querySelector(".zenius-cursor-layer > .zenius-cursor");
    const layer = cur.parentElement.getBoundingClientRect();
    const b = browser.getBoundingClientRect();
    return {
      selectedIsAgentTab: gBrowser.selectedTab === tab,
      transform: cur.style.transform,
      label: cur.querySelector(".zenius-cursor-label").textContent,
      layerMatchesBrowser: [layer.x, layer.y, layer.width, layer.height].join() === [b.x, b.y, b.width, b.height].join(),
    };
  `);
  assert.equal(out.selectedIsAgentTab, true, "Open selected the agent's page");
  assert.equal(out.transform, "translate(222px, 111px)");
  assert.equal(out.label, "Click Save");
  assert.equal(out.layerMatchesBrowser, true, "the overlay covers exactly the <browser>");
});

test("a visible move animates and resolves when the animation ends (or, in a window that paints too seldom for that, within the move's grace)", async () => {
  const out = await h.chrome(`${P}
    const { value: r, gap } = await withFrames(() => C.moveCursor(tab, { x: 500, y: 300 }, { label: "Click the big button", kind: "click" }));
    const cur = browser.parentElement.querySelector(".zenius-cursor");
    return { r, gap, transform: cur.style.transform, running: cur.getAnimations().filter(a => a.playState === "running").length };
  `);
  assert.equal(out.r.visible, true);
  assert.ok(out.r.ms >= 100 && out.r.ms < 1000, `move took ${out.r.ms} ms`);
  assert.equal(out.transform, "translate(500px, 300px)");
  // zen-eval's throttled Mac (background priority, the screen locked)
  // painted too seldom for the animation to end within the grace.
  if (out.gap > SMOOTH_FRAME_MS) {
    console.log(`# frames up to ${out.gap} ms apart: the move may resolve before its animation ends (animated ${out.r.animated}); not checked here`);
    return;
  }
  assert.equal(out.r.animated, true, `frames at most ${out.gap} ms apart`);
  assert.equal(out.running, 0, "the move animation has ended when the promise resolves");
});

test("the cursor lands on the same page point at 150% zoom", async () => {
  const out = await h.chrome(`${P}
    browser.fullZoom = 1.5;
    await sleep(300);
    const r = await C.moveCursor(tab, { x: 100, y: 60 }, { kind: "move" });
    const transform = browser.parentElement.querySelector(".zenius-cursor").style.transform;
    browser.fullZoom = 1;
    await sleep(300);
    const after = browser.parentElement.querySelector(".zenius-cursor").style.transform;
    return { r, transform, after };
  `);
  assert.equal(out.r.visible, true);
  assert.equal(out.transform, "translate(150px, 90px)");
  assert.equal(out.after, "translate(100px, 60px)", "a zoom change re-renders at the new scale");
});

test("the arrow's visible tip, its fill's farthest point the way it points, sits on the click point within half a pixel, at 100% and 150% zoom, however round its corners", async () => {
  const out = await h.chrome(`${P}
    // The way the arrow points: back along the bisector of its two long
    // edges, which leave the tip toward (19.3, 11.3) and (6.2, 20.5) in the
    // path's 24-unit box. Rounding moves no edge's direction.
    const unit = (x, y) => { const l = Math.hypot(x, y); return [x / l, y / l]; };
    const [ax, ay] = unit(19.3 - 3, 11.3 - 2);
    const [bx, by] = unit(6.2 - 3, 20.5 - 2);
    const [dx, dy] = unit(-(ax + bx), -(ay + by));
    if (gBrowser.selectedTab !== tab) {
      await ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI.openSpace(rec);
      await until(() => gBrowser.selectedTab === tab);
    }
    const res = [];
    try {
      for (const zoom of [1, 1.5]) {
        browser.fullZoom = zoom;
        await sleep(300);
        await C.moveCursor(tab, { x: 100, y: 60 }, { kind: "move" });
        const el = browser.parentElement.querySelector(".zenius-cursor");
        const svg = el.querySelector(".zenius-cursor-arrow");
        const path = svg.querySelector("path");
        const len = path.getTotalLength();
        let best = null;
        for (let i = 0; i <= 4000; i++) {
          const p = path.getPointAtLength((len * i) / 4000);
          const reach = p.x * dx + p.y * dy;
          if (!best || reach > best.reach) best = { reach, x: p.x, y: p.y };
        }
        const box = svg.getBoundingClientRect();
        const tip = { x: box.left + (best.x * box.width) / 24, y: box.top + (best.y * box.height) / 24 };
        const [, tx, ty] = el.style.transform.match(/translate\\(([-\\d.]+)px, ([-\\d.]+)px\\)/).map(Number);
        const layer = el.parentElement.getBoundingClientRect();
        const click = { x: layer.left + tx, y: layer.top + ty };
        res.push({ zoom, off: Math.hypot(tip.x - click.x, tip.y - click.y), click: [tx, ty] });
      }
    } finally {
      browser.fullZoom = 1;
      await sleep(300);
    }
    return res;
  `);
  for (const r of out) {
    assert.ok(r.off < 0.5, `at ${r.zoom * 100}% the tip is ${r.off.toFixed(2)} px off the click point`);
  }
  assert.deepEqual(out.map(r => r.click), [[100, 60], [150, 90]]);
});

test("content screenshots never include the cursor", async () => {
  const out = await h.chrome(`${P}
    const sum = async (wgp, rect) => {
      const bmp = await wgp.drawSnapshot(rect, 1, "white");
      const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let s = 0;
      for (let i = 0; i < d.length; i++) s = (s * 31 + d[i]) >>> 0;
      return s;
    };
    const content = browser.browsingContext.currentWindowGlobal;
    const chromeWin = win.browsingContext.currentWindowGlobal;
    const b = browser.getBoundingClientRect();
    await C.moveCursor(tab, { x: 40, y: 40 }, { label: "Here", kind: "move" });
    await sleep(100);
    const withCursor = { content: await sum(content, new win.DOMRect(0, 0, 160, 120)), chrome: await sum(chromeWin, new win.DOMRect(b.x, b.y, 160, 120)) };
    C.hideCursor(tab);
    await sleep(100);
    const without = { content: await sum(content, new win.DOMRect(0, 0, 160, 120)), chrome: await sum(chromeWin, new win.DOMRect(b.x, b.y, 160, 120)) };
    return { withCursor, without };
  `);
  assert.notEqual(out.withCursor.chrome, out.without.chrome, "the window snapshot shows the cursor (the check is sensitive)");
  assert.equal(out.withCursor.content, out.without.content, "the content snapshot is the same with and without the cursor");
});

test("switching back to the user's Space makes moves free again", async () => {
  const out = await h.chrome(`${P}
    await C.moveCursor(tab, { x: 10, y: 10 }, { kind: "move" });
    await gZenWorkspaces.changeWorkspaceWithID(${JSON.stringify(userView.windows[0].activeWorkspace)});
    await until(() => gBrowser.selectedTab !== tab);
    const r = await C.moveCursor(tab, { x: 30, y: 30 }, { kind: "click" });
    return { r, state: C.cursorState(tab) };
  `);
  assert.equal(out.r.visible, false);
  assert.equal(out.r.animated, false);
  assert.equal(out.state.stale, true);
  assert.deepEqual(await h.call("dev.viewState"), userView, "the user's view is back as it was");
});

// The guided check on the Mac (docs/reports/mac-relay.md): after Hand back (now Resume agent)
// the cursor didn't come back, and after a swipe back it had lost its label.
test("Resume agent brings the cursor back where it was, with its label", async () => {
  const out = await h.chrome(`${P}
    const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    const userWs = gZenWorkspaces.activeWorkspace;
    Pages.landOn(tab);
    await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
    await until(() => gBrowser.selectedTab === tab);
    await C.moveCursor(tab, { x: 300, y: 200 }, { label: "Waiting for you", kind: "move" });
    ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });
    const taken = C.cursorState(tab);
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    await until(() => C.cursorState(tab)?.inDom);
    const back = C.cursorState(tab);
    await gZenWorkspaces.changeWorkspaceWithID(userWs);
    return { taken, back };
  `);
  assert.equal(out.taken.inDom, false, "hidden while the user has control");
  assert.equal(out.taken.label, "Waiting for you", "its label is kept");
  const { x, y, label, hidden, idle, rendered } = out.back;
  assert.deepEqual({ x, y, label, hidden, idle }, { x: 300, y: 200, label: "Waiting for you", hidden: false, idle: false });
  assert.ok(rendered, "drawn again");
});

test("a cursor whose label faded shows it again when the user comes back", async () => {
  const out = await h.chrome(`${P}
    const userWs = gZenWorkspaces.activeWorkspace;
    await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
    await until(() => gBrowser.selectedTab === tab);
    await C.moveCursor(tab, { x: 200, y: 150 }, { label: "Waiting for you", kind: "move" });
    // Five seconds without a move fade the label; play that at once.
    browser.parentElement.querySelector(".zenius-cursor").setAttribute("idle", "true");
    const faded = C.cursorState(tab).idle;
    await gZenWorkspaces.changeWorkspaceWithID(userWs);
    await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
    await until(() => gBrowser.selectedTab === tab && !C.cursorState(tab).idle);
    const back = C.cursorState(tab);
    await gZenWorkspaces.changeWorkspaceWithID(userWs);
    return { faded, back };
  `);
  assert.equal(out.faded, true);
  assert.equal(out.back.idle, false, "the label shows again");
  assert.equal(out.back.label, "Waiting for you");
});

test("a task the user stopped forgets its cursor", async () => {
  const out = await h.chrome(`${P}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    await C.moveCursor(tab, { x: 50, y: 50 }, { label: "Pick a time", kind: "move" });
    UI.stopByUser(rec);
    const stopped = C.cursorState(tab);
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    return { stopped, afterClaim: C.cursorState(tab) };
  `);
  assert.equal(out.stopped, null);
  assert.equal(out.afterClaim, null, "claiming the Space again doesn't bring an old cursor back");
});

test("ui.cursor validates its parameters", async () => {
  await assert.rejects(h.call("ui.cursor", { space, page: "p1", x: "1", y: 2 }), { code: "ZEN_INVALID_ARGUMENT" });
  await assert.rejects(h.call("ui.cursor", { space, page: "p1", x: 1, y: 2, kind: "teleport" }), { code: "ZEN_INVALID_ARGUMENT" });
  await assert.rejects(h.call("ui.cursor", { space, page: "p1", x: 1, y: 2, label: 5 }), { code: "ZEN_INVALID_ARGUMENT" });
  await assert.rejects(h.call("ui.cursor", { space, page: "p9", x: 1, y: 2 }), { code: "ZEN_PAGE_NOT_FOUND" });
});

test("the glow takes the color pref when it's a CSS color, else the reference's blue, and a system color in forced colors", async () => {
  const out = await h.chrome(`${P}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    await UI.openSpace(rec);
    await until(() => gBrowser.selectedTab === tab);
    const PREF = "zenius.ux.cursor.glowColor";
    const glowFor = async value => {
      if (value === null) Services.prefs.clearUserPref(PREF);
      else Services.prefs.setStringPref(PREF, value);
      await C.moveCursor(tab, { x: 60, y: 60 }, { label: "Look", kind: "move" });
      const cur = browser.parentElement.querySelector(".zenius-cursor-layer > .zenius-cursor");
      return win.getComputedStyle(cur).getPropertyValue("--zenius-cursor-glow").trim();
    };
    try {
      const got = {
        unset: await glowFor(null),
        purple: await glowFor("#7c4dff"),
        named: await glowFor("teal"),
        bad: await glowFor("not a color"),
        variable: await glowFor("var(--zenius-agent-color)"),
        injected: await glowFor("red; background: url(x)"),
      };
      // No pref turns forced colors on in a Linux or macOS chrome, so this
      // parses the sheet and reads the rule it holds for them.
      const css = await (await win.fetch("chrome://userscripts/content/zenius/ui/zenius-ux.css")).text();
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(css);
      const rule = [...sheet.cssRules]
        .filter(r => r.conditionText === "(forced-colors: active)")
        .flatMap(r => [...r.cssRules])
        .find(r => r.selectorText === ".zenius-cursor");
      got.forced = rule?.style.getPropertyValue("--zenius-cursor-glow").trim() ?? null;
      return got;
    } finally {
      Services.prefs.clearUserPref(PREF);
    }
  `);
  assert.deepEqual(out, {
    unset: "#3d8bff",
    purple: "#7c4dff",
    named: "teal",
    bad: "#3d8bff",
    variable: "#3d8bff",
    injected: "#3d8bff",
    forced: "Highlight",
  });
});
