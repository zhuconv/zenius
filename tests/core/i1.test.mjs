// I1, no preemption (SPEC §3.9): nothing the agent does changes any window's
// selected tab or workspace, focus, or the number of windows. Also the
// keep-alive that lets hidden agent tabs run like visible ones.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup, sleep } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(() => h?.close());

const url = path => `${h.base}${path}`;

test("a whole task leaves the user's view alone", async () => {
  await h.assertNoPreemption(async () => {
    const space = await h.space("i1 lifecycle");
    await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
    await h.call("pages.new", { space, url: url("/healthz") });
    await h.call("page.evaluate", { space, page: "p2", fn: "document.body.textContent", isFunction: false });
    await h.call("spaces.handOff", { space });
    await h.call("spaces.takeOver", { space });
    await h.call("pages.close", { space, page: "p2" });
    await h.call("spaces.finish", { space, keep: ["p1"] });
    await h.claim(space);
    await h.call("spaces.finish", { space, keep: [] });
  });
});

test("finish keeps the Space a window shows until the user leaves it", async () => {
  const space = await h.space("i1 finish shown");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  // The user opens the task's Space and looks at its page.
  const { home, uuid, name } = await h.chrome(
    `const rec = ctx.spaces.get(arg);
     const home = win.gZenWorkspaces.activeWorkspace;
     await win.gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
     win.gBrowser.selectedTab = ctx.resolvePage({ space: arg, page: "p1" }).tab;
     return { home, uuid: rec.uuid, name: rec.name };`,
    space
  );
  const exists = () => h.chrome(`return !!win.gZenWorkspaces.getWorkspaceFromId(arg)`, uuid);
  try {
    // The view once the user's switch has settled. On a fresh window Gecko's
    // focus manager blurs the page's browser 250-600 ms after the switch,
    // with no finish and no script on the stack (seen whenever this file
    // ran first): so a view that holds for 0.9 s.
    let view = await h.view();
    for (let same = 0, end = Date.now() + 8000; same < 3 && Date.now() < end; ) {
      await sleep(300);
      const now = await h.view();
      same = JSON.stringify(now) === JSON.stringify(view) ? same + 1 : 0;
      view = now;
    }
    const receipt = await h.call("spaces.finish", { space, keep: [] });
    assert.equal(receipt.pendingCloseCount, 1);
    // Zen moved the window within 60 ms when the workspace went at once.
    await sleep(300);
    assert.deepEqual(await h.view(), view, "I1: the user's view changed");
    assert.equal(await exists(), true);
    assert.ok(
      !(await h.call("spaces.list")).taskSpaces.some(s => s.name === name),
      "the waiting workspace isn't listed as the user's"
    );
  } finally {
    // The user leaves: the page closes, and the Space goes.
    await h.chrome(`await win.gZenWorkspaces.changeWorkspaceWithID(arg); return true`, home);
  }
  // The switch, then the close, then the removal: at a load of 40 on the Linux server
  // that took more than 5 s.
  await h.until(async () => !(await exists()), 20000);
});

test("popups from an agent page open in its space, in the background, labelled; focus requests are swallowed", async () => {
  const space = await h.space("i1 popups");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  await h.call("page.evaluate", {
    space,
    page: "p1",
    isFunction: false,
    fn: `(document.body.innerHTML = \`
      <a id="link" href="/api/text?via=link" target="_blank" style="display:block;height:30px">link</a>
      <button id="open" style="display:block;height:30px" onclick="window.ref1 = window.open('/api/text?via=open')">open</button>
      <button id="features" style="display:block;height:30px" onclick="window.ref2 = window.open('/api/text?via=features', 'x', 'width=400,height=300')">features</button>
      <button id="focus" style="display:block;height:30px" onclick="window.focus()">focus</button>\`, true)`,
  });
  const popups = await h.chrome("ctx.service.__testWatch = ctx.watchPopups(arg, 'p1'); return true", space);
  assert.equal(popups, true);
  await h.assertNoPreemption(async () => {
    for (const id of ["#link", "#open", "#features", "#focus"]) {
      await h.agentClick(space, "p1", id);
    }
    await h.until(async () => (await h.call("pages.list", { space })).length >= 4);
  });
  const watched = await h.chrome("const w = ctx.service.__testWatch; delete ctx.service.__testWatch; return w.stop()");
  const pages = await h.call("pages.list", { space });
  await h.until(async () => (await h.call("pages.list", { space })).every(p => p.url !== "about:blank"));
  const listed = await h.call("pages.list", { space });
  assert.deepEqual(
    listed.map(p => [p.label, p.url.replace(h.base, ""), p.opener, p.openedBy]),
    [
      ["p1", "/api/text", null, "agent"],
      ["p2", "/api/text?via=link", "p1", "agent"],
      ["p3", "/api/text?via=open", "p1", "agent"],
      ["p4", "/api/text?via=features", "p1", "agent"],
    ]
  );
  // The receipt hook names each popup with its tab id.
  assert.deepEqual(
    watched,
    pages.slice(1).map(p => ({ label: p.label, targetId: p.tab }))
  );
  const opened = await h.call("dev.evalContent", {
    space,
    page: "p1",
    code: "[window.ref1?.opener === window, window.ref2?.opener === window]",
  });
  assert.deepEqual(opened, [true, true], "window.open() returns the popup and keeps its opener");
  await h.call("spaces.finish", { space, keep: [] });
});

test("a hidden agent tab runs like a visible one, also while handed to the user; finish releases it", async () => {
  const space = await h.space("i1 keepalive");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  const probe = `const t = performance.now();
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 10));
    const timersMs = performance.now() - t;
    let frames = 0;
    const t1 = performance.now();
    await new Promise(r => { const tick = () => (++frames, performance.now() - t1 < 200 ? requestAnimationFrame(tick) : r()); requestAnimationFrame(tick); });
    return { hidden: document.hidden, timersMs, frames }`;
  const live = await h.call("dev.evalContent", { space, page: "p1", code: probe });
  assert.equal(live.hidden, false);
  assert.ok(live.timersMs < 300, `five 10 ms timers took ${Math.round(live.timersMs)} ms`);
  assert.ok(live.frames >= 5, `only ${live.frames} animation frames in 200 ms`);

  const active = () =>
    h.chrome(
      `const rec = ctx.spaces.get(arg.space);
       const tab = ctx.pages.findTab(rec, arg.tab);
       return { active: tab.linkedBrowser.docShellIsActive, undiscardable: !!tab.undiscardable };`,
      { space, tab: p1Tab }
    );
  const p1Tab = (await h.call("pages.list", { space }))[0].tab;
  assert.deepEqual(await active(), { active: true, undiscardable: true });
  await h.call("spaces.handOff", { space });
  assert.deepEqual(await active(), { active: true, undiscardable: true }, "a task handed to the user keeps running");
  await h.call("spaces.takeOver", { space });
  await h.call("spaces.finish", { space, keep: ["p1"] });
  assert.deepEqual(await active(), { active: false, undiscardable: false }, "the user's tab is a normal hidden tab again");
  await h.remove(space);
});
