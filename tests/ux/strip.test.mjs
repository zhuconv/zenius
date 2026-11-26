// zenius's tasks strip and panel beside the agent sidebar's Work chats
// (ui/panel.sys.mjs; ui/index.sys.mjs's goToTask; the sidebar's
// openChatOfSpace). With several Work chats at work, the way to a task that
// needs the user leads to the chat that asked, beside the task's Space, so
// the user answers the right session.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { iso, setup } from "./lib.mjs";

const run = Date.now().toString(36).slice(-5);
let h;
let sidebarWasOpen = false;

const HELPERS = `
  const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
  const A = win.ucAgentSidebar.AgentService;
  const spaces = A.zenius().spaces;
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() > end) throw new Error("timed out waiting for " + what);
      await sleep(25);
    }
  };
  const sidebarShows = () => win.SidebarController.isOpen && win.SidebarController.currentID === "viewAgentSidebar";
  const tasksPanel = () => win.document.getElementById("zenius-tasks-panel");
  // The tasks panel's Open on zenius task id's row, as the user clicks it.
  const openRow = async id => {
    if (tasksPanel()?.state !== "open") {
      UI.openTasksPanel(win);
      await until(() => tasksPanel()?.state === "open", "the tasks panel");
    }
    const row = await until(() => tasksPanel().querySelector("#zenius-task-row-" + id), "the row of task " + id);
    [...row.querySelectorAll("button")].find(b => b.textContent === "Open").click();
  };
  const closeSidebar = async () => {
    if (sidebarShows()) win.SidebarController.hide();
    await until(() => !sidebarShows(), "the sidebar to close");
  };
  const look = () => ({ sidebar: sidebarShows(), chat: win.ucAgentSidebar.currentTask?.uid ?? null, watching: UI.watching(win) });
`;
const chrome = (code, arg) => h.call("dev.evalChrome", { code: `${HELPERS}\n${code}`, arg });

before(async () => {
  h = await setup();
  sidebarWasOpen = await chrome(`return sidebarShows();`);
});

after(async () => {
  await chrome(
    `
    if (!arg) await closeSidebar();
    return true;
  `,
    sidebarWasOpen
  ).catch(() => {});
  await h?.close();
});

test("the tasks panel's Open goes to the chat that drives the task: the waiting one among several Work chats, and a working one, opening the sidebar if it's closed; a task no Work chat drives opens its own read-only view there", async () => {
  // Two of the sidebar's Work chats, each driving a zenius task (the source
  // its zenius server sends names the chat), and a task another program
  // drives.
  const chats = await chrome(`
    const make = text => {
      const conv = A.createTask();
      A.addTask(conv, text);
      return conv.uid;
    };
    return { first: make("First errand"), second: make("Second errand") };
  `);
  const first = await h.createSpace({ name: `UI strip first ${run}`, source: { sidebar: chats.first } });
  const second = await h.createSpace({ name: `UI strip second ${run}`, source: { sidebar: chats.second } });
  const other = await h.createSpace({ name: `UI strip other ${run}`, source: { agent: "Codex", terminal: "devbox/t1" } });
  for (const { id } of [first, second, other]) {
    await h.call("page.goto", { space: id, page: "p1", url: `${h.base}/` });
  }
  // The second chat's task hands the user its page for a sign-in.
  await h.call("spaces.handOff", { space: second.id, reason: "sign_in" });
  try {
    const out = await chrome(
      `
      // The sidebar shows the first chat when the user opens the waiting task.
      await win.ucAgentSidebar.openTask(arg.chats.first);
      await until(() => win.ucAgentSidebar.currentTask?.uid === arg.chats.first, "the first chat");
      await openRow(arg.second);
      await until(() => UI.watching(win) === arg.second && win.ucAgentSidebar.currentTask?.uid === arg.chats.second, "the waiting task and its chat");
      const waiting = look();
      await UI.stopWatching(win);
      // The sidebar closed: Open on a task that works opens it on that chat.
      await closeSidebar();
      await openRow(arg.first);
      await until(() => UI.watching(win) === arg.first && sidebarShows() && win.ucAgentSidebar.currentTask?.uid === arg.chats.first, "the working task and its chat");
      const working = look();
      await UI.stopWatching(win);
      // A task no Work chat drives: its Space, and that task's own
      // read-only view in the sidebar, opened though it was closed, not the
      // chat it showed before.
      await closeSidebar();
      await openRow(arg.other);
      // The view is the task's stand-in, which the panel, loading as the
      // sidebar opens, shows read-only.
      const readOnly = () => win.document.getElementById("sidebar")?.contentDocument?.documentElement?.dataset.external ?? null;
      await until(
        () => UI.watching(win) === arg.other && sidebarShows() && win.ucAgentSidebar.currentTask?.uid === "ext-" + arg.other && readOnly() === "true",
        "the other program's task and its read-only view"
      );
      const other = { ...look(), external: win.ucAgentSidebar.currentTask?.external === true, readOnly: readOnly() };
      await UI.stopWatching(win);
      return { waiting, working, other };
    `,
      { chats, first: first.id, second: second.id, other: other.id }
    );
    assert.deepEqual(out.waiting, { sidebar: true, chat: chats.second, watching: second.id }, "the waiting task's chat, not the one the sidebar showed");
    assert.deepEqual(out.working, { sidebar: true, chat: chats.first, watching: first.id });
    assert.deepEqual(out.other, { sidebar: true, chat: `ext-${other.id}`, watching: other.id, external: true, readOnly: "true" }, "a task no Work chat drives: its own read-only view");
  } finally {
    await chrome(
      `
      const rec = spaces.peek(arg.second);
      if (rec && !rec.gone && rec.ownership !== "agent") spaces.setOwnership(rec, "agent", { source: "user" });
      for (const uid of Object.values(arg.chats)) {
        const conv = A.tasks.get(uid);
        if (conv) A.removeTask(conv);
      }
      return true;
    `,
      { chats, second: second.id }
    ).catch(() => {});
  }
});

// The strip names the one task that waits for the user, and what it waits
// for, and its click goes straight there; All agent tasks, at its end,
// opens the panel. With several waiting it counts them.
const STRIP = `
  const strip = win.document.getElementById("zenius-agents-strip");
  const all = win.document.getElementById("zenius-strip-all");
  // What the strip says: a named line's accessible name has its words in
  // full (the width test checks what of them shows), a count's its text.
  const shown = () => ({
    says: strip.getAttribute("aria-label") ?? strip.querySelector(".zenius-strip-text").textContent,
    title: strip.getAttribute("title"),
    named: strip.hasAttribute("named"),
    all: !all.hidden,
  });
  const closePanel = async () => {
    if (tasksPanel()?.state === "open") tasksPanel().hidePopup();
    await until(() => (tasksPanel()?.state ?? "closed") === "closed", "the panel to close");
  };
`;

test("one waiting task: the strip names it and what it waits for, and its click goes to it and its chat; All agent tasks opens the panel, as the dot of a collapsed sidebar does; two waiting are counted, each named in the tooltip", async () => {
  const chats = await chrome(`
    const make = text => {
      const conv = A.createTask();
      A.addTask(conv, text);
      return conv.uid;
    };
    return { first: make("First errand"), second: make("Second errand") };
  `);
  const first = await h.createSpace({ name: `UI strip one ${run}`, source: { sidebar: chats.first } });
  const second = await h.createSpace({ name: `UI strip two ${run}`, source: { sidebar: chats.second } });
  for (const { id } of [first, second]) {
    await h.call("page.goto", { space: id, page: "p1", url: `${h.base}/` });
  }
  try {
    assert.equal(await chrome(`return UI.needsCount();`), 0, "no task waits as the test starts");
    await h.call("spaces.handOff", { space: second.id, reason: "sign_in" });
    const one = await chrome(
      `${STRIP}
      const res = {};
      res.one = await until(() => strip.hasAttribute("named") && shown(), "the strip naming the waiting task");
      // Its click goes to the task, and the chat that drives it.
      await closeSidebar();
      strip.click();
      await until(() => UI.watching(win) === arg.second && sidebarShows() && win.ucAgentSidebar.currentTask?.uid === arg.chats.second, "the waiting task and its chat");
      res.clicked = { ...look(), panel: tasksPanel()?.state ?? "closed", all: !all.hidden };
      await UI.stopWatching(win);
      await until(() => strip.hasAttribute("named"), "the strip naming the task again");
      // All agent tasks opens the panel.
      all.click();
      await until(() => tasksPanel()?.state === "open", "the panel from All agent tasks");
      res.allOpens = UI.watching(win);
      await closePanel();
      // A collapsed sidebar shows the dot only: its click opens the panel.
      const pref = "zen.view.sidebar-expanded";
      const had = Services.prefs.prefHasUserValue(pref) ? Services.prefs.getBoolPref(pref) : null;
      const expanded = () => win.document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
      const wasExpanded = expanded();
      Services.prefs.setBoolPref(pref, false);
      try {
        await until(() => !expanded(), "the sidebar to collapse");
        await sleep(200);
        res.collapsed = { allSeen: all.checkVisibility(), title: strip.getAttribute("title") };
        strip.click();
        await until(() => tasksPanel()?.state === "open", "the panel from the dot");
        res.collapsed.watching = UI.watching(win);
        await closePanel();
      } finally {
        if (had === null) Services.prefs.clearUserPref(pref);
        else Services.prefs.setBoolPref(pref, had);
        await until(() => expanded() === wasExpanded, "the sidebar as it was");
      }
      return res;
    `,
      { chats, second: second.id }
    );
    const name = iso(`UI strip two ${run}`);
    assert.deepEqual(one.one, { says: `${name} needs a sign-in`, title: `${name} needs a sign-in`, named: true, all: true });
    assert.deepEqual(one.clicked, { sidebar: true, chat: chats.second, watching: second.id, panel: "closed", all: false }, "straight to the task and its chat; watching, the strip says so and All agent tasks goes");
    assert.equal(one.allOpens, null, "All agent tasks opens the panel and goes nowhere");
    assert.deepEqual(one.collapsed, { allSeen: false, title: `${name} needs a sign-in`, watching: null });
    // Two waiting: the count, each named in the tooltip, and the panel.
    await h.call("spaces.handOff", { space: first.id, reason: "irreversible" });
    const two = await chrome(
      `${STRIP}
      const res = {};
      res.two = await until(() => strip.querySelector(".zenius-strip-text").textContent === "2 agents need you" && shown(), "the strip counting two");
      strip.click();
      await until(() => tasksPanel()?.state === "open", "the panel from the strip");
      res.watching = UI.watching(win);
      await closePanel();
      return res;
    `
    );
    assert.deepEqual(two.two, {
      says: "2 agents need you",
      title: `2 agents need you\n${iso(`UI strip one ${run}`)} needs your OK\n${name} needs a sign-in`,
      named: false,
      all: false,
    });
    assert.equal(two.watching, null, "the panel, not a task");
  } finally {
    await chrome(
      `
      for (const id of arg.spaces) {
        const rec = spaces.peek(id);
        if (rec && !rec.gone && rec.ownership !== "agent") spaces.setOwnership(rec, "agent", { source: "user" });
      }
      for (const uid of Object.values(arg.chats)) {
        const conv = A.tasks.get(uid);
        if (conv) A.removeTask(conv);
      }
      return true;
    `,
      { chats, spaces: [first.id, second.id] }
    ).catch(() => {});
    for (const { id } of [first, second]) {
      await h.call("spaces.finish", { space: id, keep: [] }).catch(() => {});
    }
  }
});

test("a chat that needs the user before its agent opened a zenius task: the strip names it, and its click shows the chat in the sidebar; the panel has its row, with what it waits for and Open", async () => {
  const out = await chrome(
    `${STRIP}
    const conv = A.createTask();
    const res = {};
    try {
      A.addTask(conv, "Third errand");
      conv.push({ role: "user", text: "Third errand" });
      conv.push({ role: "assistant", text: "I found two nonstop flights. Do you want the morning one or the evening one?" });
      A.refreshTask(conv);
      res.why = conv.task.why;
      res.one = await until(() => strip.hasAttribute("named") && shown(), "the strip naming the chat");
      await closeSidebar();
      strip.click();
      await until(() => sidebarShows() && win.ucAgentSidebar.currentTask?.uid === conv.uid, "the chat in the sidebar");
      res.clicked = { sidebar: sidebarShows(), chat: win.ucAgentSidebar.currentTask?.uid === conv.uid, watching: UI.watching(win) };
      // The panel: the chat's row.
      all.click();
      await until(() => tasksPanel()?.state === "open" && tasksPanel().querySelector(".zenius-tasks-waiting"), "the chat's row in the panel");
      const row = tasksPanel().querySelector(".zenius-tasks-waiting");
      res.row = {
        label: row.getAttribute("aria-label"),
        name: row.querySelector(".zenius-task-name").textContent,
        detail: row.querySelector(".zenius-task-detail").textContent,
        buttons: [...row.querySelectorAll("button")].map(b => b.textContent),
      };
      await closePanel();
      return res;
    } finally {
      A.removeTask(conv);
    }
  `
  );
  const name = iso("Third errand");
  assert.equal(out.why, "question");
  assert.deepEqual(out.one, { says: `${name} needs an answer`, title: `${name} needs an answer`, named: true, all: true });
  assert.deepEqual(out.clicked, { sidebar: true, chat: true, watching: null }, "the chat in the sidebar; no Space to watch");
  assert.deepEqual(out.row, { label: name, name, detail: "Needs an answer in the agent sidebar", buttons: ["Open"] });
});

test("one waiting task at any sidebar width: the name comes first, and what it waits for shows whole or not at all; a name too long alone is cut with an ellipsis; the tooltip and the strip's name say it all", async t => {
  const name = `Trip ${run}`;
  const long = `Trip ${run} for the whole family, a summer in Kyoto, Osaka and Nara with the grandparents`;
  const space = await h.createSpace({ name });
  await h.call("page.goto", { space: space.id, page: "p1", url: `${h.base}/` });
  try {
    assert.equal(await chrome(`return UI.needsCount();`), 0, "no task waits as the test starts");
    await h.call("spaces.handOff", { space: space.id, reason: "sign_in" });
    const out = await chrome(
      `${STRIP}
      await until(() => strip.hasAttribute("named"), "the strip naming the waiting task");
      const doc = win.document;
      const tb = doc.getElementById("navigator-toolbox");
      const width0 = tb.style.width;
      const row = doc.getElementById("zenius-strip-row");
      const label = strip.querySelector(".zenius-strip-text");
      const who = label.querySelector(".zenius-strip-who");
      const what = label.querySelector(".zenius-strip-what");
      const frames = () => new Promise(r => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
      const measure = () => {
        const seen = what.checkVisibility();
        return {
          what: seen ? what.textContent : null,
          whoWhole: who.scrollWidth <= who.clientWidth + 1,
          whoWidth: Math.round(who.getBoundingClientRect().width),
          lineWhole: label.scrollWidth <= label.clientWidth + 1 && (!seen || what.getBoundingClientRect().right <= label.getBoundingClientRect().right + 0.5),
          label: strip.getAttribute("aria-label"),
          title: strip.getAttribute("title"),
          row: Math.round(row.getBoundingClientRect().width),
        };
      };
      const errors = [];
      const onError = e => errors.push(String(e.message));
      win.addEventListener("error", onError);
      const res = { usualWidth: Math.round(tb.getBoundingClientRect().width), usual: measure(), up: {}, down: {} };
      try {
        // Only the row's ResizeObserver fits the line again: nothing renders
        // the strip while the sidebar's width changes.
        for (let width = 152; width <= 340; width += 4) {
          tb.style.width = width + "px";
          await frames();
          await sleep(30);
          res.up[width] = measure();
        }
        for (let width = 336; width >= 152; width -= 8) {
          tb.style.width = width + "px";
          await frames();
          await sleep(30);
          res.down[width] = measure();
        }
        tb.style.width = width0;
        await frames();
        await spaces.rename(spaces.peek(arg.id), arg.long);
        await until(() => who.textContent.includes(arg.long), "the long name");
        await frames();
        const got = measure();
        res.long = { what: got.what, whoCut: who.scrollWidth > who.clientWidth + 1, lineWhole: got.lineWhole, label: got.label };
      } finally {
        win.removeEventListener("error", onError);
        tb.style.width = width0;
      }
      res.errors = errors;
      return res;
    `,
      { id: space.id, long }
    );
    const line = `${iso(name)} needs a sign-in`;
    const LEVEL = new Map([
      [" needs a sign-in", 0],
      [" needs you", 1],
      [null, 2],
    ]);
    t.diagnostic(`usual ${out.usualWidth}px: ${JSON.stringify(out.usual.what)}; ` + Object.entries(out.up).map(([w, g]) => `${w}:${LEVEL.get(g.what)}`).join(" "));
    for (const [way, sweep] of Object.entries({ up: out.up, down: out.down })) {
      let last = 2;
      for (const width of Object.keys(sweep).map(Number).sort((a, b) => a - b)) {
        const got = sweep[width];
        const at = `${width}px, ${way}: ${JSON.stringify(got)}`;
        assert.ok(LEVEL.has(got.what), `${at}: what it waits for in whole words`);
        assert.ok(got.lineWhole && got.whoWidth > 0, `${at}: the name shows, and nothing is clipped`);
        assert.ok(got.what === null || got.whoWhole, `${at}: what it waits for shows only after the whole name`);
        assert.deepEqual([got.label, got.title], [line, line], `${at}: the tooltip and the strip's name say it all`);
        assert.ok(LEVEL.get(got.what) <= last, `${at}: a wider strip says no less`);
        last = LEVEL.get(got.what);
      }
    }
    for (const width of Object.keys(out.down)) {
      assert.deepEqual(out.down[width], out.up[width], `${width}px: the same line, whichever way the sidebar got there`);
    }
    assert.equal(out.up[340].what, " needs a sign-in", "a wide sidebar shows the whole line");
    assert.ok(out.usual.whoWhole, `the usual width (${out.usualWidth}px) shows the whole name`);
    assert.deepEqual(out.long, { what: null, whoCut: true, lineWhole: true, label: `${iso(long)} needs a sign-in` }, "a name too long alone takes the line, cut");
    assert.deepEqual(out.errors, [], "no ResizeObserver loop");
  } finally {
    await chrome(
      `
      const rec = spaces.peek(arg);
      if (rec && !rec.gone && rec.ownership !== "agent") spaces.setOwnership(rec, "agent", { source: "user" });
      return true;
    `,
      space.id
    ).catch(() => {});
    await h.call("spaces.finish", { space: space.id, keep: [] }).catch(() => {});
  }
});
