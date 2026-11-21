// The per-tab task tag (ui/tasktags.sys.mjs, zenius-ux.css; SPEC §3.8).
// zen-core marks task pages with zenius-task=<id>; these tests set it the
// way zen-core does, then check what zen-ux adds: the task's state on the
// tab and its name for the chip, kept in step with the Space badge.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prelude, setup, iso } from "./lib.mjs";

let h;
let space;
let P;
let userView;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  ({ id: space } = await h.createSpace({ name: "zen-ux tag test" }));
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  P = `${prelude(space)}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const TT = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/tasktags.sys.mjs");
    const content = tab.querySelector(".tab-content");
    const expanded = () => win.document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
    const read = () => ({
      state: tab.getAttribute("zenius-task-state"),
      name: content.getAttribute("zenius-task-name"),
    });
    const tick = () => new Promise(r => win.setTimeout(r, 0));
  `;
  await h.chrome(`${P} tab.setAttribute("zenius-task", String(rec.id)); await tick();`);
});

after(async () => {
  await h?.chrome(`${P} tab.removeAttribute("zenius-task");`).catch(() => {});
  await h?.close();
});

test("a task page wears its task's tag: the state on the tab, the name for the chip", async () => {
  const out = await h.chrome(`${P}
    await C.moveCursor(tab, { x: 20, y: 20 }, { label: "Click Search", kind: "click" });
    const chip = win.getComputedStyle(content, "::after");
    return {
      ...read(),
      badge: UI.badgeFor(rec).state,
      expanded: expanded(),
      chip: { content: chip.content, display: chip.display },
      close: win.getComputedStyle(tab.querySelector(".tab-close-button")).display,
    };
  `);
  assert.equal(out.state, "working");
  assert.equal(out.state, out.badge, "the tag and the badge agree");
  assert.equal(out.name, "zen-ux tag test");
  if (out.expanded) {
    assert.notEqual(out.chip.content, "none");
    assert.notEqual(out.chip.display, "none");
    assert.equal(out.close, "none", "the hidden close button gives the chip its place");
  }
});

test("the tag follows the task: paused, needs-user, user, and back", async () => {
  const out = await h.chrome(`${P}
    const seen = {};
    ctx.spaces.setPaused(rec, true);
    seen.paused = read().state;
    ctx.spaces.setPaused(rec, false);
    ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
    seen.needs = read().state;
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });
    seen.user = read().state;
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    await C.moveCursor(tab, { x: 30, y: 30 }, { label: "Click Next", kind: "click" });
    seen.back = read().state;
    return seen;
  `);
  assert.deepEqual(out, { paused: "paused", needs: "needs-user", user: "user", back: "working" });
});

test("a tab zen-core tags later gets the tag at once; untagged, it loses it", async () => {
  const out = await h.chrome(`${P}
    tab.removeAttribute("zenius-task");
    await tick();
    const untagged = read();
    tab.setAttribute("zenius-task", String(rec.id));
    await tick();
    return { untagged, tagged: read() };
  `);
  assert.deepEqual(out.untagged, { state: null, name: null });
  assert.equal(out.tagged.name, "zen-ux tag test");
  assert.ok(["working", "idle"].includes(out.tagged.state), out.tagged.state);
});

test("the tab's tooltip names the task and its state", async () => {
  const tooltip = await h.chrome(`${P}
    ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
    const text = gBrowser.getTabTooltip(tab);
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    return text;
  `);
  assert.ok(tooltip.endsWith(`\nTask: ${iso("zen-ux tag test")} · Agent needs you`), tooltip);
});

test("with the sidebar collapsed to icons, the tag is a dot on the tab's icon", async () => {
  const out = await h.chrome(`${P}
    const root = win.document.documentElement;
    const was = root.getAttribute("zen-sidebar-expanded");
    const look = () => ({
      dot: win.getComputedStyle(tab.querySelector(".tab-icon-stack"), "::before").content,
      chip: win.getComputedStyle(content, "::after").content,
    });
    try {
      root.removeAttribute("zen-sidebar-expanded");
      const collapsed = look();
      root.setAttribute("zen-sidebar-expanded", "true");
      const open = look();
      return { collapsed, open };
    } finally {
      if (was === null) root.removeAttribute("zen-sidebar-expanded");
      else root.setAttribute("zen-sidebar-expanded", was);
    }
  `);
  assert.equal(out.collapsed.dot, '""');
  assert.equal(out.collapsed.chip, "none");
  assert.equal(out.open.dot, "none");
  assert.notEqual(out.open.chip, "none");
});

test("the end of the task takes the tag away", async () => {
  const out = await h.chrome(`${P}
    UI.stopByUser(rec);
    await tick();
    return { ...read(), tag: TT.taskTagOf(tab) };
  `);
  assert.deepEqual(out, { state: null, name: null, tag: null });
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
