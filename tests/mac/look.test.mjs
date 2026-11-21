// The two-mode sidebar's look (the bundle's Mac test 1) in Zen's own Light
// and Dark: the Chat and Work chats and the directory drawer, laid out as the
// user asked (2026-11-21). zen-eval runs it in a visible window on the Mac:
//
//   ZENIUS_MAC_HEADED=1 tests/mac/run.sh tests/mac/look.test.mjs
//
// What it checks:
// - The header shows only the title: no subtitle, and no switch.
// - The composer is a taller box. The input is on top, two lines when empty.
//   Under it is one row: '+' and the Chat | Work switch on the left, the
//   pickers and the send button on the right. Work carries an orange count of
//   the tasks that need the user. The row holds at the sidebar's narrowest
//   width.
// - The drawer slides from the sidebar's page-side edge over the page,
//   without moving it, with Needs you, Working and Done. The current task is
//   open to its tabs.
// - Which parts let Zen's window material (the macOS vibrancy) show through:
//   the alpha of a snapshot over a transparent backdrop, beside Zen's own
//   sidebar, against hooks.mjs's MATERIAL. A snapshot can't draw the material
//   itself, and the run takes no screen capture (no Screen Recording
//   permission): the user sees the real vibrancy in the try Zen.
// Shots for a person to set beside zen-sidebar's references go to
// $ZENIUS_MAC_SHOTS (default $TMPDIR/zenius-mac-look).
//
// The scene: the tasks run.sh's fixture file loads (every state but
// Working), a page chat on a test page, and one live work chat
// (SCENARIO:flights) that holds a running step, so Working. Tasks the
// fixture lacks are started live through the mock agent's keywords.
import assert from "node:assert/strict";
import { mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { GROUPS, MATERIAL } from "./hooks.mjs";
import { BACKDROP, HEADED, WWW, inTheme, setup } from "./lib.mjs";

const OUT = process.env.ZENIUS_MAC_SHOTS || join(tmpdir(), "zenius-mac-look");
let h;
let scene;
const created = [];

/** Look checks, in scope for every chrome call here as `L`. */
const LOOK = `
const L = {
  header(doc) {
    const $ = s => doc.querySelector(s);
    const header = $(H.PANEL.header), title = $(H.PANEL.title);
    const texts = [...header.querySelectorAll("*")].filter(el => el !== title && !title.contains(el) && T.visible(el) &&
      [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
    return {
      mode: doc.documentElement.getAttribute(H.PANEL.mode),
      title: title?.textContent.trim() ?? null,
      titleShown: T.visible(title),
      titleLines: title ? Math.round(title.getBoundingClientRect().height / T.lineHeight(title) * 10) / 10 : null,
      otherText: texts.map(el => (el.id ? "#" + el.id : el.localName + "." + el.className) + ": " + el.textContent.trim().slice(0, 40)),
      switchInHeader: !!header.querySelector(H.PANEL.switch),
      favicon: T.visible($(H.PANEL.favicon)),
      dir: T.visible($(H.PANEL.dir)),
    };
  },
  bar(doc) {
    const $ = s => doc.querySelector(s);
    const box = $(H.PANEL.box), input = $(H.PANEL.input), bar = $(H.PANEL.bar);
    const send = T.visible($(H.PANEL.send)) ? $(H.PANEL.send) : $(H.PANEL.stop);
    const parts = { attach: $(H.PANEL.attach), switch: $(H.PANEL.switch), pickers: $(H.PANEL.pickers), send };
    const r = {}, inBar = {}, shown = {};
    for (const [k, el] of Object.entries(parts)) {
      shown[k] = T.visible(el);
      r[k] = shown[k] ? T.box(el) : null;
      inBar[k] = !!el && bar.contains(el);
    }
    const b = T.box(box), i = T.box(input), br = T.box(bar);
    const cs = doc.defaultView.getComputedStyle(input);
    const inner = input.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const bcs = doc.defaultView.getComputedStyle(bar);
    const contentRight = br.right - parseFloat(bcs.paddingRight) - parseFloat(bcs.borderRightWidth);
    // The four parts themselves, not #bar's children: a wrapper that moves
    // the pickers and send together is the bar's own business.
    const items = Object.entries(r).filter(([, x]) => x).map(([k, x]) => ({ id: k === "send" ? send.id : k, ...x }));
    const needs = $(H.PANEL.needs);
    const edged = T.visible(needs) ? [...items, { id: "needs", ...T.box(needs) }] : items;
    const overlaps = [];
    for (let x = 0; x < items.length; x++) {
      for (let y = x + 1; y < items.length; y++) {
        const p = items[x], q = items[y];
        if (Math.min(p.right, q.right) - Math.max(p.left, q.left) > 1 && Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 1) overlaps.push(p.id + "/" + q.id);
      }
    }
    const mid = x => (x.top + x.bottom) / 2;
    const sameRow = (p, q) => !!p && !!q && Math.abs(mid(p) - mid(q)) <= 4;
    const all = Object.values(shown).every(Boolean);
    const oneRow = all && sameRow(r.attach, r.switch) && sameRow(r.switch, r.pickers) && sameRow(r.pickers, r.send);
    // zen-sidebar's wrap: the pickers and send together on a second row,
    // under '+' and the switch.
    const twoRows = all && !oneRow && sameRow(r.attach, r.switch) && sameRow(r.pickers, r.send) &&
      Math.min(r.pickers.top, r.send.top) >= Math.max(r.attach.bottom, r.switch.bottom) - 1;
    const gaps = all ? [r.switch.left - r.attach.right, r.pickers.left - r.switch.right, r.send.left - r.pickers.right].map(Math.round) : null;
    return {
      inBar, shown, barInBox: box.contains(bar), inputInBox: box.contains(input),
      inputAboveBar: i.bottom <= br.top + 1,
      inputLines: input.value === "" ? Math.round(inner / T.lineHeight(input) * 10) / 10 : null,
      layout: oneRow ? "one row" : twoRows ? "two rows" : "neither",
      gaps,
      // '+' before the switch, and the pickers before send, in either layout.
      pairsInOrder: !!gaps && gaps[0] >= -1 && gaps[2] >= -1,
      sendRightmost: !!r.send && items.every(it => it.right <= r.send.right + 1),
      sendAtRight: !!r.send && r.send.right >= contentRight - 2,
      clipped: edged.filter(it => it.left < b.left - 0.5 || it.right > b.right + 0.5 || it.top < b.top - 0.5 || it.bottom > b.bottom + 0.5).map(it => it.id),
      overlaps,
      boxWidth: Math.round(b.width),
      items: items.map(it => it.id),
    };
  },
  switchState(doc) {
    const $ = s => doc.querySelector(s);
    const needs = $(H.PANEL.needs), toWork = $(H.PANEL.toWork);
    const want = T.cssVar(toWork ?? doc, H.PANEL.needsColor);
    const cs = needs ? doc.defaultView.getComputedStyle(needs) : null;
    return {
      chat: $(H.PANEL.toChat)?.getAttribute("aria-pressed") ?? null,
      work: toWork?.getAttribute("aria-pressed") ?? null,
      needsInWork: !!needs && !!toWork?.contains(needs),
      needsShown: T.visible(needs),
      needsText: needs?.textContent.trim() ?? null,
      orange: want, orangeHsl: T.hsl(want),
      paint: cs ? [T.rgba(cs.color), T.rgba(cs.backgroundColor)] : [],
    };
  },
  async mode(doc, mode) {
    doc.querySelector(mode === "chat" ? H.PANEL.toChat : H.PANEL.toWork).click();
    await T.until(() => doc.documentElement.getAttribute(H.PANEL.mode) === mode, 5000, mode + " mode");
  },
  async openDrawer(doc) {
    const root = () => win.document.querySelector(H.DRAWER.root);
    if (!T.glue().directoryOpen) doc.querySelector(H.PANEL.dir).click();
    await T.until(() => root() && !root().hidden && root().querySelector(H.DRAWER.drawer)?.classList.contains("open"), 5000, "the drawer to open");
    await T.sleep(400);
    return root().querySelector(H.DRAWER.drawer);
  },
  async closeDrawer() {
    T.glue().closeDirectory();
    await T.until(() => win.document.querySelector(H.DRAWER.root)?.hidden !== false, 3000, "the drawer to close");
  },
  sidebarBox: () => win.document.getElementById("sidebar-box") ?? win.document.getElementById("sidebar"),
};
`;
const look = (code, arg) => h.chrome(`${LOOK}\n${code}`, arg);

/** Same color, give or take rounding. */
const near = (a, b) => !!a && !!b && a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= 8) && a[3] > 200;

function assertOrange(rgba, where) {
  const [hue, sat, light] = rgbToHsl(rgba);
  assert.ok(hue >= 15 && hue <= 45 && sat >= 0.5 && light >= 0.3 && light <= 0.75,
    `${where} isn't orange: rgba(${rgba.join(", ")}), hue ${Math.round(hue)}, saturation ${sat.toFixed(2)}, lightness ${light.toFixed(2)}`);
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const hh = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hh * 60 + 360) % 360, s, l];
}

/**
 * The composer's row, as the user asked for it: one row wherever it fits.
 * With `narrow`, zen-sidebar's wrap passes too: '+' and the switch on the
 * first row, the pickers then send right-aligned on a second. Either way
 * nothing is hidden and nothing runs past #box's edge.
 */
function assertBar(bar, where, { narrow = false } = {}) {
  const all = JSON.stringify(bar);
  assert.ok(bar.barInBox && bar.inputInBox, `${where}: #input and #bar aren't both in #box: ${all}`);
  assert.ok(bar.inputAboveBar, `${where}: the input isn't above the row: ${all}`);
  if (bar.inputLines !== null) {
    assert.ok(bar.inputLines >= 1.8 && bar.inputLines <= 2.5, `${where}: the empty input is ${bar.inputLines} lines, not 2: ${all}`);
  }
  for (const [k, inside] of Object.entries(bar.inBar)) assert.ok(inside, `${where}: ${k} isn't in the composer's row: ${all}`);
  for (const [k, shown] of Object.entries(bar.shown)) assert.ok(shown, `${where}: ${k} is hidden: ${all}`);
  assert.deepEqual(bar.clipped, [], `${where}: parts of the row are cut off by the box: ${all}`);
  assert.deepEqual(bar.overlaps, [], `${where}: parts of the row overlap: ${all}`);
  assert.ok(bar.sendRightmost, `${where}: send isn't the rightmost: ${all}`);
  if (bar.layout === "one row") {
    assert.ok(bar.gaps.every(g => g >= -1), `${where}: the row isn't '+', the switch, the pickers, then send: ${all}`);
    // '+' and the switch on the left, the pickers and send on the right: the
    // widest gap is the one between the two groups.
    assert.ok(bar.gaps[1] >= Math.max(bar.gaps[0], bar.gaps[2]) - 1, `${where}: the switch and the pickers aren't split left and right: ${all}`);
    return;
  }
  assert.ok(narrow, `${where}: the row wraps where it should fit: ${all}`);
  assert.equal(bar.layout, "two rows", `${where}: the row is neither one row nor two ('+' and the switch, then the pickers and send): ${all}`);
  assert.ok(bar.pairsInOrder, `${where}: it isn't '+' then the switch, and the pickers then send: ${all}`);
  assert.ok(bar.sendAtRight, `${where}: the second row isn't right-aligned: ${all}`);
}

async function shot(name, theme) {
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${name}.png`);
  await h.chrome(`await T.sleep(300); return T.shot(arg.path, arg.backdrop);`, { path, backdrop: BACKDROP[theme] });
  assert.ok(statSync(path).size > 10_000, `${path} looks empty`);
  console.log(`# shot: ${path}`);
  return path;
}

before(async () => {
  mkdirSync(OUT, { recursive: true });
  h = await setup("look");
  // Zen greys out a window that isn't the frontmost, and the dev window
  // rarely is while a terminal runs the test (look.test.mjs in tests/ux).
  await h.chrome(`Services.prefs.setBoolPref("zen.view.grey-out-inactive-windows", false); return true;`);
  const page = WWW ? `${WWW}/article.html` : `${h.base}/zoo/long.html`;
  scene = await look(`
    const g = T.glue(), A = g.AgentService, gb = win.gBrowser;
    let tab = gb.tabs.find(t => t.linkedBrowser.currentURI.spec === arg.page);
    if (!tab) {
      tab = gb.addTab(arg.page, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      await T.until(() => tab.linkedBrowser.currentURI.spec === arg.page && !tab.hasAttribute("busy"), 15000, "the test page");
    }
    gb.selectedTab = tab;
    const doc = await T.openPanel();
    await L.mode(doc, "chat");
    const chat = g.conversationFor(tab);
    if (!chat.messages.some(m => m.role === "assistant")) {
      await g.submit(chat, { question: "SUMMARY What does this article say, in three points?", selection: "", attachments: [] });
      await T.until(() => !chat.busy && chat.messages.some(m => m.role === "assistant"), 30000, "the page chat's answer");
    }
    const { startWorkChat } = ChromeUtils.importESModule(H.MODULE);
    const count = s => [...A.tasks.values()].filter(c => c.task?.state === s).length;
    const started = [];
    const asks = ["Pick a window seat on my Tokyo flight QUESTION", "Find a hotel near Shibuya QUESTION"];
    for (let i = count("needs"); i < 2; i++) started.push(await startWorkChat(win, { text: asks[i], source: "new" }));
    if (!count("done")) started.push(await startWorkChat(win, { text: "Summarize the PriorTune paper SUMMARY", source: "new" }));
    const flights = await startWorkChat(win, { text: "Compare nonstop flights from SFO to Tokyo next month under $900 SCENARIO:flights", source: "urlbar" });
    started.push(flights);
    await T.until(() => count("needs") >= 2 && count("done") >= 1, 30000, "tasks that need the user, and one done");
    await T.until(() => {
      const c = A.tasks.get(flights);
      return c?.task?.state === "working" && c.messages.some(m => m.role === "tool" && m.status === "in_progress");
    }, 60000, "the flights task's running step");
    g.showTask(flights);
    gb.selectedTab = tab;
    return { page: arg.page, flights, started, title: A.tasks.get(flights).title, states: [...A.tasks.values()].map(c => c.task?.state) };
  `, { page });
  created.push(...scene.started);
  console.log(`# scene: ${JSON.stringify(scene.states)}; the current task is "${scene.title}"`);
});

after(async () => {
  if (h) {
    await h.chrome(`
      Services.prefs.clearUserPref("zen.view.grey-out-inactive-windows");
      const A = T.glue()?.AgentService;
      for (const uid of arg) {
        const c = A?.tasks.get(uid);
        if (c) A.removeTask(c);
      }
      T.glue()?.closeDirectory?.();
      return true;
    `, created).catch(e => console.log(`# cleanup: ${e.message}`));
    await h.close();
  }
  console.log(`# shots in ${OUT}`);
});

for (const theme of ["light", "dark"]) {
  test(`${theme}: Chat shows only the title in the header, and the switch in the composer's row`, () =>
    inTheme(h, theme, async () => {
      const r = await look(`
        const gb = win.gBrowser;
        T.glue().closeDirectory();
        gb.selectedTab = gb.tabs.find(t => t.linkedBrowser.currentURI.spec === arg.page) ?? gb.selectedTab;
        const doc = await T.openPanel();
        await L.mode(doc, "chat");
        await T.sleep(400);
        return { header: L.header(doc), bar: L.bar(doc), sw: L.switchState(doc), tabTitle: gb.selectedTab.label };
      `, { page: scene.page });
      const all = JSON.stringify(r);
      assert.equal(r.header.mode, "chat");
      assert.ok(r.header.titleShown, `no title: ${all}`);
      assert.equal(r.header.title, r.tabTitle, "the title isn't the bound tab's");
      assert.ok(r.header.titleLines <= 1.6, `the title takes ${r.header.titleLines} lines: ${all}`);
      assert.deepEqual(r.header.otherText, [], "the header shows text besides the title (a subtitle?)");
      assert.equal(r.header.switchInHeader, false, "the switch is still in the header");
      assert.ok(r.header.favicon, "Chat shows no favicon");
      assert.equal(r.header.dir, false, "Chat shows the drawer button, which is Work's");
      assertBar(r.bar, `${theme} Chat`);
      assert.equal(r.sw.chat, "true");
      assert.equal(r.sw.work, "false");
      assert.ok(r.sw.needsInWork, "the count isn't on Work");
      assert.ok(r.sw.needsShown, `Work shows no count, with tasks that need the user: ${all}`);
      await shot(`${theme}-chat`, theme);
    }));

  test(`${theme}: Work moves the switch, and its orange count is the tasks that need the user`, () =>
    inTheme(h, theme, async () => {
      const r = await look(`
        const doc = await T.openPanel();
        await L.mode(doc, "work");
        T.glue().showTask(arg.task);
        await T.sleep(500);
        return { header: L.header(doc), bar: L.bar(doc), sw: L.switchState(doc), title: T.glue().AgentService.tasks.get(arg.task)?.title,
          needing: [...T.glue().AgentService.tasks.values()].filter(c => c.task?.state === "needs").length };
      `, { task: scene.flights });
      const all = JSON.stringify(r);
      assert.equal(r.header.mode, "work");
      assert.equal(r.header.title, r.title, "the title isn't the current task's");
      assert.deepEqual(r.header.otherText, [], "the header shows text besides the title (a subtitle?)");
      assert.equal(r.header.switchInHeader, false, "the switch is still in the header");
      assert.ok(r.header.dir, "Work shows no drawer button");
      assert.equal(r.header.favicon, false, "Work shows the favicon, which is Chat's");
      assertBar(r.bar, `${theme} Work`);
      assert.equal(r.sw.work, "true");
      assert.equal(r.sw.chat, "false");
      assert.equal(r.sw.needsText, String(r.needing), `the count isn't the ${r.needing} tasks that need the user`);
      assertOrange(r.sw.orange, `${theme}: var(--needs-color)`);
      assert.ok(r.sw.paint.some(c => near(c, r.sw.orange)), `the count isn't painted in var(--needs-color): ${all}`);
      await shot(`${theme}-work`, theme);
    }));

  test(`${theme}: the drawer slides over the page, with Needs you, Working and Done`, () =>
    inTheme(h, theme, async () => {
      const r = await look(`
        const doc = await T.openPanel();
        await L.mode(doc, "work");
        T.glue().showTask(arg.task);
        await T.sleep(300);
        const page = win.gBrowser.selectedBrowser, sidebar = L.sidebarBox();
        const pageBefore = T.box(page);
        const drawer = await L.openDrawer(doc);
        const rows = [];
        let under = null;
        for (const el of drawer.querySelectorAll(H.DRAWER.group + ", " + H.DRAWER.row)) {
          if (el.matches(H.DRAWER.group)) under = el.dataset.group;
          else rows.push({ task: el.dataset.task, state: el.dataset.state, under, current: el.dataset.current === "true",
            tabs: el.querySelectorAll(H.DRAWER.tab).length });
        }
        return {
          side: drawer.dataset.side,
          expanded: doc.querySelector(H.PANEL.dir).getAttribute("aria-expanded"),
          drawer: T.box(drawer), sidebar: T.box(sidebar), page: T.box(page), pageBefore,
          groups: [...drawer.querySelectorAll(H.DRAWER.group)].map(el => ({ group: el.dataset.group, label: el.textContent.trim() })),
          rows,
          badge: doc.querySelector(H.PANEL.needs)?.textContent.trim(),
          orange: { drawer: T.cssVar(drawer, H.DRAWER.needsColor), panel: T.cssVar(doc.querySelector(H.PANEL.toWork) ?? doc, H.PANEL.needsColor) },
        };
      `, { task: scene.flights });
      try {
        const all = JSON.stringify(r);
        assert.equal(r.expanded, "true", "#dir isn't aria-expanded while the drawer is open");
        assert.deepEqual(r.groups.map(g => g.group), GROUPS.map(([g]) => g), `the groups: ${all}`);
        for (const [i, [, label]] of GROUPS.entries()) assert.ok(r.groups[i].label.startsWith(label), `group ${i} reads "${r.groups[i].label}"`);
        for (const row of r.rows.filter(x => GROUPS.some(([g]) => g === x.state))) {
          assert.equal(row.under, row.state, `a ${row.state} task is listed under ${row.under}`);
        }
        for (const [g] of GROUPS) assert.ok(r.rows.some(x => x.state === g), `no task under ${g}: ${all}`);
        const current = r.rows.filter(x => x.current);
        assert.equal(current.length, 1, `${current.length} current tasks: ${all}`);
        assert.equal(current[0].task, scene.flights, "the current task isn't the one shown");
        assert.ok(current[0].tabs >= 1, "the current task isn't open to its tabs");
        assert.deepEqual(r.rows.filter(x => !x.current && x.tabs).map(x => x.task), [], "another task is open to its tabs");
        assert.equal(r.badge, String(r.rows.filter(x => x.state === "needs").length), "Work's count isn't the drawer's Needs you");
        assert.ok(near(r.orange.drawer, r.orange.panel), `the drawer's orange isn't the count's: ${all}`);
        // From the sidebar's page-side edge, over the page, which stays put.
        const right = r.sidebar.left >= r.page.right - 1;
        assert.equal(r.side, right ? "left" : "right", `data-side for a sidebar on the ${right ? "right" : "left"}`);
        if (right) {
          assert.ok(r.drawer.right >= r.sidebar.left - 1 && r.drawer.right <= r.sidebar.left + 24, `the drawer doesn't start at the sidebar's edge: ${all}`);
          assert.ok(r.drawer.left >= r.page.left - 1 && r.drawer.left < r.sidebar.left, `the drawer isn't over the page: ${all}`);
        } else {
          assert.ok(r.drawer.left <= r.sidebar.right + 1 && r.drawer.left >= r.sidebar.right - 24, `the drawer doesn't start at the sidebar's edge: ${all}`);
          assert.ok(r.drawer.right <= r.page.right + 1 && r.drawer.right > r.sidebar.right, `the drawer isn't over the page: ${all}`);
        }
        for (const k of ["left", "top", "right", "bottom"]) {
          assert.ok(Math.abs(r.page[k] - r.pageBefore[k]) <= 0.5, `the page moved when the drawer opened: ${all}`);
        }
        await shot(`${theme}-directory`, theme);
      } finally {
        await look(`await L.closeDrawer(); return true;`);
      }
    }));

  test(`${theme}: which parts let Zen's window material show through`, { skip: !HEADED && "headed only: a headless window has no window material" }, () =>
    inTheme(h, theme, async () => {
      const r = await look(`
        const doc = await T.openPanel();
        await L.mode(doc, "work");
        T.glue().showTask(arg.task);
        const drawerEl = await L.openDrawer(doc);
        try {
          const [ox, oy] = T.panelOffset();
          const { width, height, data } = await T.pixels(1, "rgba(0,0,0,0)");
          const alpha = (x, y) => {
            x = Math.round(x); y = Math.round(y);
            return x < 0 || y < 0 || x >= width || y >= height ? null : data[(y * width + x) * 4 + 3];
          };
          // The alpha where the element under each point is a background, not content.
          const sample = (r, hit, accept) => {
            const out = [];
            for (let y = r.top + 2; y < r.bottom - 2 && out.length < 60; y += 5) {
              for (let x = r.left + 2; x < r.right - 2 && out.length < 60; x += 5) {
                const el = hit(x, y);
                const a = el && accept(el) ? alpha(x, y) : null;
                if (a !== null) out.push(a);
              }
            }
            return out.length ? { n: out.length, min: Math.min(...out), max: Math.max(...out) } : null;
          };
          const inWin = (x, y) => win.document.elementFromPoint(x, y);
          const inPanel = (x, y) => doc.elementFromPoint(x - ox, y - oy);
          const header = doc.querySelector(H.PANEL.header), box = doc.querySelector(H.PANEL.box);
          const toolbox = win.document.getElementById("navigator-toolbox");
          const page = win.gBrowser.selectedBrowser.getBoundingClientRect();
          const zenR = T.box(toolbox);
          return {
            zen: sample(zenR, inWin, el => toolbox.contains(el) && !el.closest("tab, toolbarbutton, toolbaritem, button, input, #urlbar")),
            panel: sample(T.box(doc.documentElement, ox, oy), inPanel, el => el === doc.body || el === doc.documentElement || el.id === "messages" || el.id === "empty"),
            header: sample(T.box(header, ox, oy), inPanel, el => el === header),
            box: sample(T.box(box, ox, oy), inPanel, el => el === box),
            drawer: sample(T.box(drawerEl), inWin, el => el === drawerEl || el.classList?.contains("asb-dir-list")),
            toolboxBesidePage: zenR.right <= page.left + 1 || zenR.left >= page.right - 1,
          };
        } finally {
          await L.closeDrawer();
        }
      `, { task: scene.flights });
      console.log(`# ${theme} alpha (0-255; Zen's material shows where it is low): ${JSON.stringify(r)}`);
      for (const part of ["panel", "header", "box", "drawer"]) {
        const s = r[part];
        assert.ok(s, `found no background to sample in the ${part}: ${JSON.stringify(r)}`);
        if (MATERIAL[part] === "solid") assert.ok(s.min >= 250, `the ${part} lets the backdrop through (alpha ${s.min}), but should be solid`);
        else assert.ok(s.max <= 245, `the ${part} is solid (alpha ${s.max}), but should let Zen's material through`);
      }
      if (r.zen && r.zen.max <= 245 && MATERIAL.panel === "solid") {
        console.log(`# note for the user's call: Zen's own sidebar lets its material through (alpha ${r.zen.min}-${r.zen.max}); the agent panel is solid by design`);
      }
    }));
}

test("the composer's row holds at the sidebar's narrowest width", () =>
  inTheme(h, "light", async () => {
    const r = await look(`
      const doc = await T.openPanel();
      await L.mode(doc, "work");
      const sidebar = L.sidebarBox();
      const was = sidebar.style.width;
      const before = sidebar.getBoundingClientRect().width;
      // Zen's own floor for the sidebar (168 px in 1.24), or 200 px where
      // none is set.
      const min = parseFloat(win.getComputedStyle(sidebar).minWidth) || 0;
      sidebar.style.width = (min >= 120 ? min : 200) + "px";
      await T.sleep(500);
      try {
        const out = { before: Math.round(before), min, after: Math.round(sidebar.getBoundingClientRect().width), bar: L.bar(doc), header: L.header(doc), sw: L.switchState(doc) };
        await L.mode(doc, "chat");
        await T.sleep(300);
        out.chatBar = L.bar(doc);
        out.chatHeader = L.header(doc);
        out.shot = await T.shot(arg.path, arg.backdrop);
        await L.mode(doc, "work");
        return out;
      } finally {
        sidebar.style.width = was;
        await T.sleep(300);
      }
    `, { path: join(OUT, "narrowest-chat.png"), backdrop: BACKDROP.light });
    console.log(`# narrowest: the sidebar went from ${r.before} px to ${r.after} px (its min-width is ${r.min} px); the row: ${r.bar.layout} in Work, ${r.chatBar.layout} in Chat`);
    assert.ok(r.after < r.before, `couldn't narrow the sidebar: ${JSON.stringify(r)}`);
    assertBar(r.bar, `Work at ${r.after} px`, { narrow: true });
    assertBar(r.chatBar, `Chat at ${r.after} px`, { narrow: true });
    // The scene has tasks that need the user, so the count keeps its place.
    assert.ok(r.sw.needsShown && r.sw.needsText, `Work's count is hidden at ${r.after} px: ${JSON.stringify(r.sw)}`);
    assert.ok(r.header.titleLines <= 1.6 && r.chatHeader.titleLines <= 1.6, `the title wraps at ${r.after} px`);
  }));
