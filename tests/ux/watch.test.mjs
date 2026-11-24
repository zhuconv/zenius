// zenius's watch (runtime/JS/zenius/ui/watch.sys.mjs): every way to an agent's
// task is a watch. The window shows the task and remembers where the user was.
// The strip, or a chip where the strip can't be read, says "Watching <task>
// [Ctrl+Tab]", and Ctrl+Tab goes back; once the task ends there, "Task done,
// [Ctrl+Tab] back to your tabs", until the user goes elsewhere themselves. The
// agent sidebar's ways in (its live card and its directory) are in
// sidebar.test.mjs.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { iso, prelude, setup } from "./lib.mjs";

const A = "zen-ux watch A";
const B = "zen-ux watch B";
/** The key as the platform shows it (watch.sys.mjs's BACK_KEY). */
const KEY = process.platform === "darwin" ? "⌃Tab" : "Ctrl+Tab";
let h;
let a;
let b;
let P;
let userView;
/** Tasks the tests below make and finish, finished again in after() if one failed. */
const more = [];

/** An agent task with a page, p1. */
async function newTask(name) {
  const { id } = await h.createSpace({ name });
  more.push(id);
  await h.call("page.goto", { space: id, page: "p1", url: `${h.base}/` });
  return id;
}

/**
 * The user's Open on task `id` from the tasks panel, with the announcer
 * cleared once that watch's announcement has gone out; the page it shows is
 * kept as win.__zuShown. Then the agent finishes the task, keeping nothing.
 */
async function watchThenFinish(id) {
  await h.chrome(`${P}
    await backToUser();
    await press(${id}, "open");
    await until(() => UI.watching(win) === ${id}, 5000);
    panel().hidePopup();
    win.__zuShown = gBrowser.selectedTab;
    await announcementsOut(win);
    doc.getElementById("a11y-announcement").replaceChildren();
    return true;
  `);
  const receipt = await h.call("spaces.finish", { space: id, keep: [] });
  assert.ok(receipt.pendingCloseCount >= 1, `the premise: the page the user watches waits to close (${JSON.stringify(receipt)})`);
}

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  // A tab of the user's own to come back to: Zen removes the profile's empty
  // tab once the window leaves its Space.
  await h.chrome(`
    const t = win.gBrowser.addTab(${JSON.stringify(`${h.base}/`)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    t.setAttribute("zen-ux-watch-user", "true");
    win.gBrowser.selectedTab = t;
    return true;
  `);
  ({ id: a } = await h.createSpace({ name: A }));
  await h.call("page.goto", { space: a, page: "p1", url: `${h.base}/` });
  ({ id: b } = await h.createSpace({ name: B }));
  await h.call("page.goto", { space: b, page: "p1", url: `${h.base}/` });
  P = `${prelude(a)}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const doc = win.document;
    const strip = doc.getElementById("zenius-agents-strip");
    const chip = () => doc.getElementById("zenius-watch-pill");
    const panel = () => doc.getElementById("zenius-tasks-panel");
    const rowOf = id => panel()?.querySelector('.zenius-task[data-space="' + id + '"]');
    const openPanel = async () => {
      if (panel()?.state !== "open") {
        // With one task waiting, the strip's click goes to it, and All agent
        // tasks opens the panel.
        const allTasks = doc.getElementById("zenius-strip-all");
        (allTasks && !allTasks.hidden ? allTasks : strip).click();
        await until(() => panel()?.state === "open");
      }
    };
    const press = async (id, action) => {
      await openPanel();
      const button = rowOf(id)?.querySelector('[data-action="' + action + '"]');
      if (!button) throw new Error("no " + action + " button for task " + id);
      button.click();
    };
    const key = type => win.dispatchEvent(new win.KeyboardEvent(type, { key: "Tab", code: "Tab", keyCode: 9, ctrlKey: true, bubbles: true, cancelable: true }));
    // The user's Ctrl+Tab, down and up: whether anything stopped it.
    const ctrlTab = () => {
      const stopped = !key("keydown");
      key("keyup");
      return stopped;
    };
    const hint = () => ({
      watching: strip.getAttribute("watching"),
      name: strip.querySelector(".zenius-strip-name")?.textContent ?? null,
      key: strip.querySelector(".zenius-strip-key")?.textContent ?? null,
      chip: !!chip() && !chip().hidden,
    });
    // Once the watched task is done.
    const doneHint = () => ({
      watching: strip.getAttribute("watching"),
      text: strip.querySelector(".zenius-strip-text").textContent,
      key: strip.querySelector(".zenius-strip-key")?.textContent ?? null,
      chip: !!chip() && !chip().hidden,
    });
    const announcementsOut = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").announcementsOut;
    // What Firefox's announcer says, once zenius's announcements have gone
    // out together (ANNOUNCE_MS).
    const heardSoon = async () => {
      await announcementsOut(win);
      return doc.getElementById("a11y-announcement").firstChild?.getAttribute("aria-label") ?? null;
    };
    // Which of el's parts are cut: wider than they show.
    const cuts = (el, names) => Object.fromEntries(names.map(n => {
      const part = el.querySelector(n);
      return [n, part ? part.scrollWidth > part.clientWidth + 1 : null];
    }));
    // The user's own Space, as the window had it before any task, and their
    // tab there: never wherever a test left the window.
    const userSpace = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    const findUserTab = () => doc.querySelector(".tabbrowser-tab[zen-ux-watch-user]");
    const userTab = findUserTab();
    const atUser = () => gZenWorkspaces.activeWorkspace === userSpace && gBrowser.selectedTab === userTab;
    const events = [];
    const onWatch = e => events.push(e.detail?.space ?? null);
    const backToUser = async () => {
      await UI.stopWatching(win, { back: false });
      if (panel()?.state === "open") {
        panel().hidePopup();
      }
      if (gZenWorkspaces.activeWorkspace !== userSpace) await gZenWorkspaces.changeWorkspaceWithID(userSpace);
      if (userTab?.isConnected) gBrowser.selectedTab = userTab;
      await sleep(200);
    };
  `;
});

after(async () => {
  await h?.chrome(`${P}
    Services.prefs.setBoolPref("zen.view.sidebar-expanded", true);
    await backToUser();
    gBrowser.removeTab(userTab, { animate: false });
  `).catch(() => {});
  for (const space of [a, b, ...more]) {
    await h?.call("spaces.finish", { space, keep: [] }).catch(() => {});
  }
  await h?.close();
});

test("the tasks panel's Open is a watch: the strip says 'Watching <task> [Ctrl+Tab]', a screen reader hears the way back, and Ctrl+Tab goes back to the user's tab, then is Zen's again", async () => {
  const out = await h.chrome(`${P}
    await backToUser();
    Services.prefs.setBoolPref("zen.view.sidebar-expanded", true);
    await until(() => doc.documentElement.getAttribute("zen-sidebar-expanded") === "true");
    const said = [];
    const announce = win.A11yUtils.announce;
    win.A11yUtils.announce = o => said.push(o.raw);
    win.addEventListener("zenius-watch", onWatch);
    const res = {};
    try {
      res.unwatched = { stopped: ctrlTab(), atUser: atUser() };
      await press(${a}, "open");
      await until(() => UI.watching(win) === ${a}, 5000);
      await sleep(400);
      res.watch = { onPage: gBrowser.selectedTab === tab, ...hint() };
      res.title = strip.getAttribute("title").split("\\n")[0];
      res.label = strip.getAttribute("aria-label").split(". ").slice(0, 2).join(". ");
      res.said = said.filter(s => /^Watching/.test(s));
      res.began = events.splice(0);
      res.stopped = ctrlTab();
      await until(() => UI.watching(win) === null && atUser(), 5000);
      res.back = { atUser: atUser(), ...hint(), text: strip.querySelector(".zenius-strip-text").textContent, label: strip.getAttribute("aria-label") };
      res.ended = events.splice(0);
      // That press is over: Ctrl+Tab is Zen's again.
      await sleep(600);
      res.after = { stopped: ctrlTab(), atUser: atUser() };
    } finally {
      win.A11yUtils.announce = announce;
      win.removeEventListener("zenius-watch", onWatch);
      await backToUser();
    }
    return res;
  `);
  assert.deepEqual(out.unwatched, { stopped: false, atUser: true }, "Ctrl+Tab while not watching is Zen's");
  assert.deepEqual(out.watch, { onPage: true, watching: "true", name: iso(A), key: ` ${KEY}`, chip: false });
  assert.equal(out.title, `Watching ${iso(A)}. ${KEY} goes back to your tabs.`);
  assert.equal(out.label, `Watching ${iso(A)}. Control Tab goes back to your tabs`);
  assert.deepEqual(out.said, [`Watching ${iso(A)}. Control Tab goes back to your tabs.`]);
  assert.deepEqual(out.began, [a]);
  assert.equal(out.stopped, true, "the watch's Ctrl+Tab went no further");
  assert.equal(out.back.atUser, true);
  assert.equal(out.back.watching, null);
  assert.equal(out.back.name, null);
  assert.equal(out.back.label, null);
  // The strip's own line again: a count, or the one waiting task named.
  assert.match(out.back.text, /agent|needs |waits for you|hit an error|was interrupted/);
  assert.deepEqual(out.ended, [null]);
  assert.deepEqual(out.after, { stopped: false, atUser: true }, "Ctrl+Tab after the watch is Zen's");
});

test("the panel's tab names and Take over watch too; watching another task keeps the way back; another Space ends the watch where the user went, and the task's end doesn't", async () => {
  const out = await h.chrome(`${P}
    await backToUser();
    const res = {};
    try {
      // A tab name in the panel.
      await openPanel();
      rowOf(${a}).querySelector(".zenius-task-tab").click();
      await until(() => UI.watching(win) === ${a}, 5000);
      res.tabName = gBrowser.selectedTab === tab;
      // Another task's Open moves the watch; the way back stays the user's tab.
      await press(${b}, "open");
      await until(() => UI.watching(win) === ${b}, 5000);
      res.moved = hint().name;
      res.movedStopped = ctrlTab();
      // The way back is a Space switch, which takes a moment.
      await until(() => UI.watching(win) === null && atUser(), 5000);
      res.movedBack = atUser();
      // The user goes to their own Space themselves: the watch ends there.
      await press(${a}, "open");
      await until(() => UI.watching(win) === ${a}, 5000);
      await gZenWorkspaces.changeWorkspaceWithID(userSpace);
      await until(() => gZenWorkspaces.activeWorkspace === userSpace);
      await sleep(200);
      res.left = { watching: UI.watching(win), name: hint().name };
      // Take over, from the panel: the user has the page, and watches it.
      if (!atUser()) gBrowser.selectedTab = userTab;
      await press(${a}, "takeOver");
      await until(() => UI.watching(win) === ${a} && rec.ownership === "agentDelegatedToUser", 5000);
      res.takeOver = { onPage: gBrowser.selectedTab === tab, watching: hint().watching };
      res.takeOverStopped = ctrlTab();
      await until(() => UI.watching(win) === null && atUser(), 5000);
      res.takeOverBack = { atUser: atUser(), held: rec.ownership };
      await press(${a}, "handBack");
      await until(() => rec.ownership === "agent", 5000);
      // Watching B, whose task then ends.
      await press(${b}, "open");
      await until(() => UI.watching(win) === ${b}, 5000);
      res.beforeEnd = UI.watching(win);
    } catch (e) {
      await backToUser();
      throw e;
    }
    return res;
  `);
  await h.call("spaces.finish", { space: b, keep: [] });
  const ended = await h.chrome(`${P}
    try {
      await until(() => UI.watching(win) === null, 5000);
      return { watching: UI.watching(win), done: UI.watchingDone(win), hint: hint().watching };
    } finally {
      await backToUser();
    }
  `);
  assert.equal(out.tabName, true, "the tab name watches the task on that tab");
  assert.equal(out.moved, iso(B));
  assert.equal(out.movedStopped, true);
  assert.equal(out.movedBack, true, "back to where the user first was, not to A");
  assert.deepEqual(out.left, { watching: null, name: null }, "the user's own switch ended the watch");
  assert.deepEqual(out.takeOver, { onPage: true, watching: "true" });
  assert.equal(out.takeOverStopped, true);
  assert.deepEqual(out.takeOverBack, { atUser: true, held: "agentDelegatedToUser" }, "back to the user's tab, the page still theirs");
  assert.equal(out.beforeEnd, b);
  assert.deepEqual(ended, { watching: null, done: b, hint: "done" }, "the task's end keeps the way back (the tests below)");
});

test("where the strip can't be read (a collapsed sidebar, compact mode), the chip says the same in the page area's corner and every click goes through it; it goes once the strip can be read", async () => {
  const out = await h.chrome(`${P}
    // Where a click at a point lands, by the window's hit test (which skips
    // pointer-events: none): the page (its <browser>) or chrome.
    const landsOn = (x, y) => {
      const el = doc.elementFromPoint(x, y);
      return !el ? "nothing" : el.localName === "browser" ? "page" : el.closest?.("#zenius-watch-pill") ? "chip" : el.id || el.localName;
    };
    const look = () => {
      const c = chip();
      if (!c || c.hidden) return { shown: false };
      const area = doc.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
      const r = c.getBoundingClientRect();
      return {
        shown: true,
        text: c.textContent,
        corner: r.left - area.left >= 0 && r.left - area.left < 20 && r.top - area.top >= 0 && r.top - area.top < 20,
        onChip: landsOn(r.left + r.width / 2, r.top + r.height / 2),
        topCenter: landsOn(area.left + area.width / 2, area.top + 20),
      };
    };
    const compact = win.gZenCompactModeManager;
    const wasCompact = compact.preference;
    const res = {};
    try {
      await backToUser();
      Services.prefs.setBoolPref("zen.view.sidebar-expanded", false);
      await until(() => doc.documentElement.getAttribute("zen-sidebar-expanded") !== "true");
      await press(${a}, "open");
      await until(() => UI.watching(win) === ${a}, 5000);
      await sleep(400);
      res.collapsed = look();
      Services.prefs.setBoolPref("zen.view.sidebar-expanded", true);
      await until(() => doc.documentElement.getAttribute("zen-sidebar-expanded") === "true");
      await sleep(500);
      res.expanded = look();
      compact.preference = true;
      await until(() => compact.preference && !doc.documentElement.hasAttribute("zen-compact-animating"), 5000);
      await sleep(800);
      res.compact = look();
      res.stopped = ctrlTab();
      await until(() => UI.watching(win) === null && atUser(), 5000);
      res.back = look();
    } finally {
      compact.preference = wasCompact;
      Services.prefs.clearUserPref("zen.view.compact.enable-at-startup");
      await until(() => compact.preference === wasCompact && !doc.documentElement.hasAttribute("zen-compact-animating"), 5000).catch(() => {});
      Services.prefs.setBoolPref("zen.view.sidebar-expanded", true);
      await backToUser();
    }
    return res;
  `);
  const shown = { shown: true, text: `Watching ${iso(A)}${KEY}`, corner: true, onChip: "page", topCenter: "page" };
  assert.deepEqual(out.collapsed, shown, "a collapsed sidebar shows only the strip's dot");
  assert.deepEqual(out.expanded, { shown: false }, "the strip says it again");
  assert.deepEqual(out.compact, shown, "compact mode keeps the sidebar out of the window");
  assert.equal(out.stopped, true);
  assert.deepEqual(out.back, { shown: false });
});

test("a watched task's end keeps the way back: the window stays on its page, the strip says 'Task done, [Ctrl+Tab] back to your tabs', a screen reader hears it, and Ctrl+Tab goes back, which closes the page", async () => {
  const C = "zen-ux watch C";
  const c = await newTask(C);
  await h.chrome(`${P}
    win.__zuEvents = [];
    win.__zuOnWatch = e => win.__zuEvents.push({ space: e.detail?.space ?? null, done: e.detail?.done ?? null });
    win.addEventListener("zenius-watch", win.__zuOnWatch);
    return true;
  `);
  await watchThenFinish(c);
  const out = await h.chrome(`${P}
    const t = win.__zuShown;
    const res = {};
    try {
      await until(() => UI.watchingDone(win) === ${c}, 5000);
      res.done = { live: UI.watching(win), stayed: gBrowser.selectedTab === t, waits: t.isConnected && !t.closing, ...doneHint() };
      res.title = strip.getAttribute("title").split("\\n")[0];
      res.label = strip.getAttribute("aria-label");
      res.heard = await heardSoon();
      res.stopped = ctrlTab();
      await until(() => UI.watchingDone(win) === null && atUser(), 5000);
      res.back = { atUser: atUser(), watching: strip.getAttribute("watching"), text: strip.querySelector(".zenius-strip-text").textContent };
      res.events = win.__zuEvents.splice(0);
      await until(() => !t.isConnected || t.closing, 5000);
      res.closed = true;
      // That press is over: Ctrl+Tab is Zen's again.
      await sleep(600);
      res.after = { stopped: ctrlTab(), atUser: atUser() };
    } finally {
      win.removeEventListener("zenius-watch", win.__zuOnWatch);
      delete win.__zuOnWatch;
      delete win.__zuEvents;
      await backToUser();
    }
    return res;
  `);
  assert.deepEqual(out.done, {
    live: null,
    stayed: true,
    waits: true,
    watching: "done",
    text: `Task done, ${KEY} back to your tabs`,
    key: ` ${KEY}`,
    chip: false,
  }, "nothing moved, and the page waits for the user to leave it");
  assert.equal(out.title, `Task done: ${iso(C)}. ${KEY} goes back to your tabs.`);
  assert.ok(out.label.startsWith(`Task done: ${iso(C)}. Control Tab goes back to your tabs.`), out.label);
  assert.equal(out.heard, `Task done: ${iso(C)}. Control Tab goes back to your tabs. This tab closes when you leave it.`);
  assert.equal(out.stopped, true, "the way back's Ctrl+Tab went no further");
  assert.equal(out.back.atUser, true);
  assert.equal(out.back.watching, null);
  // The strip's own line again: a count, or the one waiting task named.
  assert.match(out.back.text, /agent|needs |waits for you|hit an error|was interrupted/);
  assert.deepEqual(out.events, [
    { space: c, done: false },
    { space: null, done: true },
    { space: null, done: false },
  ], "the agent sidebar hears the watch begin, its task end, and the way back end");
  assert.equal(out.closed, true, "leaving the page closed it");
  assert.deepEqual(out.after, { stopped: false, atUser: true }, "Ctrl+Tab after the way back is Zen's");
});

test("after a watched task's end, the user's own pick of another tab ends the way back where they went; the page's Close, another task's Open and the chip where the strip can't be read keep it, and only the words after the key are cut", async () => {
  const d = await newTask("zen-ux watch D");
  await watchThenFinish(d);
  const picked = await h.chrome(`${P}
    const t = win.__zuShown;
    const res = {};
    try {
      await until(() => UI.watchingDone(win) === ${d}, 5000);
      // The user picks another tab themselves: A's page.
      gBrowser.selectedTab = tab;
      await until(() => gBrowser.selectedTab === tab);
      await sleep(300);
      res.picked = { onA: gBrowser.selectedTab === tab, live: UI.watching(win), done: UI.watchingDone(win), watching: strip.getAttribute("watching") };
      await until(() => !t.isConnected || t.closing, 5000);
      res.closed = true;
      await sleep(600);
      res.after = { stopped: ctrlTab(), onA: gBrowser.selectedTab === tab };
    } finally {
      await backToUser();
    }
    return res;
  `);
  const e = await newTask("zen-ux watch E");
  await watchThenFinish(e);
  const kept = await h.chrome(`${P}
    const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
    const t = win.__zuShown;
    const res = {};
    try {
      await until(() => UI.watchingDone(win) === ${e}, 5000);
      // A narrow strip cuts where Ctrl+Tab goes, never "Task done" or the key.
      const label = strip.querySelector(".zenius-strip-text");
      const need = [...label.children].reduce((sum, part) => sum + part.scrollWidth, 0);
      label.style.maxWidth = need - 40 + "px";
      res.stripCuts = cuts(label, [".zenius-strip-lead", ".zenius-strip-key", ".zenius-strip-rest"]);
      label.style.maxWidth = "";
      // A collapsed sidebar: the chip says it, and cuts the same way.
      Services.prefs.setBoolPref("zen.view.sidebar-expanded", false);
      await until(() => doc.documentElement.getAttribute("zen-sidebar-expanded") !== "true");
      await sleep(400);
      const c = chip();
      const parts = [".zenius-watch-name", ".zenius-watch-key", ".zenius-watch-rest"];
      res.chip = {
        shown: !!c && !c.hidden,
        done: !!c?.hasAttribute("done"),
        parts: parts.map(n => c?.querySelector(n)).filter(p => p && !p.hidden).map(p => p.textContent),
      };
      const placed = c.style.maxWidth;
      c.style.maxWidth = c.getBoundingClientRect().width - 40 + "px";
      res.chipCuts = cuts(c, parts);
      c.style.maxWidth = placed;
      Services.prefs.setBoolPref("zen.view.sidebar-expanded", true);
      await until(() => doc.documentElement.getAttribute("zen-sidebar-expanded") === "true");
      await sleep(500);
      res.expanded = { chip: !c.hidden, watching: strip.getAttribute("watching") };
      // The page's Close: Zen picks the next tab, which the user didn't.
      await until(() => N.noticeText(t, "zenius-task-finished"));
      await sleep(450);
      [...N.noticeElement(t, "zenius-task-finished").querySelectorAll("button")].find(b => b.textContent === "Close now").click();
      await until(() => !t.isConnected || t.closing, 5000);
      await sleep(300);
      res.closed = { done: UI.watchingDone(win), watching: strip.getAttribute("watching"), atUser: atUser() };
      // Another task's Open: the way back is still to the user's tab.
      await press(${a}, "open");
      await until(() => UI.watching(win) === ${a}, 5000);
      res.watchingA = { done: UI.watchingDone(win), name: hint().name };
      res.stopped = ctrlTab();
      await until(() => UI.watching(win) === null && atUser(), 5000);
      res.back = atUser();
    } finally {
      Services.prefs.setBoolPref("zen.view.sidebar-expanded", true);
      await backToUser();
    }
    return res;
  `);
  assert.deepEqual(picked.picked, { onA: true, live: null, done: null, watching: null }, "the user's own pick ended the way back, there");
  assert.equal(picked.closed, true, "and the page they left closed");
  assert.deepEqual(picked.after, { stopped: false, onA: true }, "Ctrl+Tab is Zen's again");
  assert.deepEqual(kept.stripCuts, { ".zenius-strip-lead": false, ".zenius-strip-key": false, ".zenius-strip-rest": true });
  assert.deepEqual(kept.chip, { shown: true, done: true, parts: ["Task done,", KEY, "back to your tabs"] });
  assert.deepEqual(kept.chipCuts, { ".zenius-watch-name": false, ".zenius-watch-key": false, ".zenius-watch-rest": true });
  assert.deepEqual(kept.expanded, { chip: false, watching: "done" });
  assert.deepEqual(kept.closed, { done: e, watching: "done", atUser: false }, "the tab Zen picked after the page's Close isn't the user's pick");
  assert.deepEqual(kept.watchingA, { done: null, name: iso(A) });
  assert.equal(kept.stopped, true);
  assert.equal(kept.back, true, "back to where the user first was");
});
