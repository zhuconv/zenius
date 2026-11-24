// zenius's tasks strip and panel beside the agent sidebar's Work chats
// (ui/panel.sys.mjs; ui/index.sys.mjs's goToTask; the sidebar's
// openChatOfSpace). With several Work chats at work, the way to a task that
// needs the user leads to the chat that asked, beside the task's Space, so
// the user answers the right session.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

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

test("the tasks panel's Open goes to the chat that drives the task: the waiting one among several Work chats, and a working one, opening the sidebar if it's closed; a task no Work chat drives opens no sidebar", async () => {
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
  const first = await h.createSpace({ name: `zen-ux strip first ${run}`, source: { sidebar: chats.first } });
  const second = await h.createSpace({ name: `zen-ux strip second ${run}`, source: { sidebar: chats.second } });
  const other = await h.createSpace({ name: `zen-ux strip other ${run}`, source: { agent: "Codex", terminal: "devbox/t1" } });
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
      // A task no Work chat drives: its Space, and the sidebar as it was.
      await closeSidebar();
      await openRow(arg.other);
      await until(() => UI.watching(win) === arg.other, "the other program's task");
      await sleep(500);
      const other = look();
      await UI.stopWatching(win);
      return { waiting, working, other };
    `,
      { chats, first: first.id, second: second.id, other: other.id }
    );
    assert.deepEqual(out.waiting, { sidebar: true, chat: chats.second, watching: second.id }, "the waiting task's chat, not the one the sidebar showed");
    assert.deepEqual(out.working, { sidebar: true, chat: chats.first, watching: first.id });
    assert.deepEqual(out.other, { sidebar: false, chat: chats.first, watching: other.id }, "no sidebar for a task no Work chat drives");
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
