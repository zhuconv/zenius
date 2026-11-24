// Phase 3 polish: the Space's status has a line of its own under its
// header, the tasks strip fits a collapsed sidebar, and reduced motion is
// respected.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prelude, setup } from "./lib.mjs";

let h;
let space;
let P;
let userView;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  // A Space of the task's own, whose name the header shows (the Agents
  // Space's is its own, short one): a claimed user Space.
  let page;
  ({ id: space, page } = await h.claimedSpace("Book a table for four people tonight"));
  await h.call("page.goto", { space, page, url: `${h.base}/` });
  P = `${prelude(space, page)}
    const doc = win.document;
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    const showSpace = async uuid => {
      await gZenWorkspaces.changeWorkspaceWithID(uuid);
      await until(() => gZenWorkspaces.activeWorkspace === uuid);
      await sleep(250);
    };
  `;
});

after(async () => {
  await h?.chrome(`${P}
    Services.prefs.clearUserPref("ui.prefersReducedMotion");
    Services.prefs.clearUserPref("zen.view.sidebar-expanded");
    B.setSpaceBadge(rec.uuid, null);
    if (gZenWorkspaces.activeWorkspace !== userWs) await showSpace(userWs);
  `).catch(() => {});
  await h?.close();
});

test("the Space's status has a line of its own under its header: its state words show whole, and the name and Zen's actions button keep their room", async () => {
  const out = await h.chrome(`${P}
    const tb = doc.getElementById("navigator-toolbox");
    const width0 = tb.style.width;
    const ws = () => doc.getElementById(rec.uuid);
    const header = () => ws().querySelector(":scope > .zen-current-workspace-indicator");
    const w = el => Math.round(el.getBoundingClientRect().width);
    // The header alone: what the Space's name and Zen's actions button get.
    const room = () => ({
      name: w(header().querySelector(".zen-current-workspace-indicator-name")),
      actions: w(header().querySelector(":scope > .zen-workspaces-actions")),
    });
    const status = () => {
      const el = ws().querySelector(":scope > .zenius-space-status");
      const words = el.querySelector(".zenius-space-status-words");
      const more = el.querySelector(".zenius-space-status-more");
      const hr = header().getBoundingClientRect();
      const sr = el.getBoundingClientRect();
      const wr = words.getBoundingClientRect();
      const tr = tb.getBoundingClientRect();
      return {
        under: el.previousElementSibling === header() && sr.top >= hr.bottom - 7 && Math.abs(sr.left - (hr.left + parseFloat(win.getComputedStyle(header()).paddingLeft))) <= 1,
        words: words.textContent,
        wordsWhole: words.scrollWidth <= words.clientWidth + 1 && wr.left >= tr.left && wr.right <= tr.right,
        more: w(more),
        em: parseFloat(win.getComputedStyle(el).fontSize),
      };
    };
    await showSpace(rec.uuid);
    const res = {};
    try {
      // Zen's narrowest sidebar, its default here, and a wide one.
      for (const width of [152, 186, 300]) {
        tb.style.width = width + "px";
        B.setSpaceBadge(rec.uuid, null);
        await sleep(100);
        const bare = room();
        B.setSpaceBadge(rec.uuid, { state: "needs-user", text: "Choose a time for the table at the Italian place on Main Street", action: "Pick a time" });
        await sleep(100);
        res[width] = { ...status(), roomKept: JSON.stringify(room()) === JSON.stringify(bare) };
      }
      Services.prefs.setBoolPref("zen.view.sidebar-expanded", false);
      await sleep(300);
      const el = ws().querySelector(":scope > .zenius-space-status");
      const icon = header().getBoundingClientRect();
      const dot = el.getBoundingClientRect();
      res.collapsed = {
        text: win.getComputedStyle(el.querySelector(".zenius-space-status-text")).display,
        small: dot.width <= 14,
        centered: Math.abs(dot.left + dot.width / 2 - (icon.left + icon.width / 2)) <= 1,
      };
      return res;
    } finally {
      Services.prefs.clearUserPref("zen.view.sidebar-expanded");
      tb.style.width = width0;
      B.setSpaceBadge(rec.uuid, null);
      await showSpace(userWs);
    }
  `);
  for (const width of [152, 186, 300]) {
    const got = out[width];
    assert.equal(got.under, true, `${width}px: under the header, where its content starts`);
    assert.equal(got.words, "Agent needs you");
    assert.equal(got.wordsWhole, true, `${width}px: the state words show whole`);
    // Zen collapses its actions button until the header is hovered: the
    // header's layout is the same with the status as without it.
    assert.equal(got.roomKept, true, `${width}px: the name and the actions button keep their room`);
  }
  // Fonts decide how much is left at the narrowest: Linux's words fill the
  // line, a Mac's left a stub of the rest. Either
  // way no stub shows: the next test sweeps the widths.
  assert.ok(out[152].more === 0 || out[152].more >= 5 * out[152].em, `at the narrowest, the words alone or at least five letters' room of the rest (${out[152].more}px)`);
  assert.ok(out[300].more > 40, `a wide sidebar shows the rest too (${out[300].more}px)`);
  assert.deepEqual(out.collapsed, { text: "none", small: true, centered: true });
});

test("at no sidebar width does the Space's status show a stub of its rest: the rest gets five letters' room, fits whole, or hides", async () => {
  const out = await h.chrome(`${P}
    const tb = doc.getElementById("navigator-toolbox");
    const width0 = tb.style.width;
    const frames = () => new Promise(r => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
    const steps = [];
    try {
      B.setSpaceBadge(rec.uuid, { state: "needs-user", text: "Choose a time for the table at the Italian place on Main Street", action: "Pick a time" });
      await showSpace(rec.uuid);
      for (let width = 152; width <= 320; width += 6) {
        tb.style.width = width + "px";
        await frames();
        await sleep(30);
        const el = doc.getElementById(rec.uuid).querySelector(":scope > .zenius-space-status");
        const more = el.querySelector(".zenius-space-status-more");
        const em = parseFloat(win.getComputedStyle(el).fontSize);
        const room = more.getBoundingClientRect().width;
        steps.push({
          width,
          short: el.hasAttribute("short"),
          room: Math.round(room),
          min: 5 * em,
          clipped: more.scrollWidth > more.clientWidth + 1,
          words: win.getComputedStyle(el.querySelector(".zenius-space-status-words")).display !== "none",
          title: el.getAttribute("title"),
        });
      }
      return steps;
    } finally {
      tb.style.width = width0;
      B.setSpaceBadge(rec.uuid, null);
      await showSpace(userWs);
    }
  `);
  for (const s of out) {
    // A stub is a clipped rest with some room, but less than five letters'.
    const ok = s.short ? s.room === 0 : s.room === 0 || s.room >= s.min || !s.clipped;
    assert.ok(ok && s.words, `${s.width}px: ${JSON.stringify(s)}`);
    assert.ok(s.title.startsWith("Agent needs you ") && s.title.includes("Italian place on Main Street"), `${s.width}px: the title keeps the whole text`);
  }
  assert.ok(out.some(s => s.short), "some width hides the rest");
  assert.ok(out.some(s => !s.short && s.clipped), "some width shows part of it, with an ellipsis");
});

test("a collapsed sidebar shows the strip's dot, with its text as the tooltip", async () => {
  const out = await h.chrome(`${P}
    const strip = doc.getElementById("zenius-agents-strip");
    await until(() => !strip.hidden);
    const text = strip.querySelector(".zenius-strip-text");
    const before = win.getComputedStyle(text).display;
    Services.prefs.setBoolPref("zen.view.sidebar-expanded", false);
    await until(() => doc.documentElement.getAttribute("zen-sidebar-expanded") !== "true");
    await sleep(100);
    const collapsed = { display: win.getComputedStyle(text).display, title: strip.getAttribute("title"), text: text.textContent };
    Services.prefs.setBoolPref("zen.view.sidebar-expanded", true);
    await until(() => doc.documentElement.getAttribute("zen-sidebar-expanded") === "true");
    return { before, collapsed };
  `);
  assert.notEqual(out.before, "none");
  assert.equal(out.collapsed.display, "none");
  assert.equal(out.collapsed.title, out.collapsed.text, "the tooltip says what the text said");
});

test("with reduced motion the cursor jumps and nothing pulses", async () => {
  const out = await h.chrome(`${P}
    const P2 = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    Services.prefs.setIntPref("ui.prefersReducedMotion", 1);
    await until(() => win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    P2.landOn(tab);
    await showSpace(rec.uuid);
    await until(() => gBrowser.selectedTab === tab);
    await sleep(200);
    await C.moveCursor(tab, { x: 30, y: 30 }, { kind: "move" });
    const far = await C.moveCursor(tab, { x: 600, y: 400 }, { kind: "click" });
    B.setSpaceBadge(rec.uuid, { state: "working", text: "", action: "" });
    await sleep(50);
    const dot = doc.querySelector('#zen-workspaces-button toolbarbutton[zen-workspace-id="' + rec.uuid + '"] > .zenius-space-badge');
    const pulse = dot ? win.getComputedStyle(dot).animationName : "no badge";
    Services.prefs.clearUserPref("ui.prefersReducedMotion");
    await until(() => !win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const animatedAgain = (await C.moveCursor(tab, { x: 100, y: 100 }, { kind: "move" })).animated;
    C.hideCursor(tab);
    await showSpace(userWs);
    return { animated: far.animated, ms: far.ms, pulse, animatedAgain };
  `);
  assert.equal(out.animated, false);
  assert.ok(out.ms < 60, `the move took ${out.ms} ms`);
  assert.equal(out.pulse, "none");
  assert.equal(out.animatedAgain, true, "motion comes back with the setting");
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
