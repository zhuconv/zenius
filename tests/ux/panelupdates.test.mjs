// The open tasks panel under agents' updates (found in a load test). With
// agents reporting progress the panel re-renders about 12 times a second; it
// used to rebuild every row, so a focused button lost focus and a press lost
// its click. Now rows stay the same elements and change in place. The rows here
// are stand-ins that panel.sys.mjs draws itself, with actions that record their
// calls.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;

before(async () => {
  h = await setup();
});

after(async () => {
  // Back to ZeniusUI's own rows.
  await h
    ?.chrome(`
      const Panel = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/panel.sys.mjs");
      const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
      Panel.closeTasksPanel(win);
      Panel.updateTasks(win, UI.tasks(), {});
      return true;
    `)
    .catch(() => {});
  await h?.close();
});

const P = `
  const Panel = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/panel.sys.mjs");
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const doc = win.document;
  const calls = [];
  const spy = name => id => calls.push(name + " " + id);
  let rows = [];
  const actions = { rows: () => rows, open: spy("open"), openTab: (id, tab) => calls.push("openTab " + id + " " + tab), closeIdle: spy("closeIdle"), pause: spy("pause"), resume: spy("resume"), takeOver: spy("takeOver"), handBack: spy("handBack"), stop: spy("stop") };
  const row = (i, over = {}) => ({ id: 980000 + i, name: "Task " + i, state: "working", detail: "Agent working · step 1", ownership: "agent", paused: false, tabs: [{ id: "zu-up-" + i, title: "Checkout " + i }], idleFor: null, ...over });
  const update = next => {
    rows = next;
    Panel.updateTasks(win, rows, actions);
  };
  const open = async () => {
    Panel.closeTasksPanel(win);
    await sleep(50);
    // The strip hides with no real task, and a panel anchored to a hidden
    // element closes at once: anchor it to the sidebar's foot.
    const panel = Panel.openTasksPanel(win, actions, doc.getElementById("zen-sidebar-foot-buttons"));
    await new Promise(r => (panel.state === "open" ? r() : panel.addEventListener("popupshown", r, { once: true })));
    await sleep(100);
    if (panel.state !== "open") throw new Error("the panel closed by itself: " + panel.state);
    return panel;
  };
  const rowEl = (panel, i) => panel.querySelector('.zenius-task[data-space="' + (980000 + i) + '"]');
  const button = (panel, i, action) => rowEl(panel, i)?.querySelector('button[data-action="' + action + '"]');
`;

test("updates keep the rows and the user's focus: the same elements, only the changed text touched", async () => {
  const out = await h.chrome(`${P}
    update([0, 1, 2, 3, 4].map(i => row(i)));
    const panel = await open();
    try {
      const before = [0, 1, 2, 3, 4].map(i => rowEl(panel, i));
      const pause = button(panel, 2, "pause");
      pause.focus();
      const focusedFirst = doc.activeElement === pause;
      let touched = new Set();
      const obs = new win.MutationObserver(recs => {
        for (const r of recs) touched.add(r.target.closest?.(".zenius-task")?.dataset.space ?? r.target.parentElement?.closest(".zenius-task")?.dataset.space ?? "other");
      });
      obs.observe(panel, { subtree: true, childList: true, attributes: true, characterData: true });
      for (let k = 0; k < 50; k++) {
        update([0, 1, 2, 3, 4].map(i => row(i, { detail: "Agent working · step " + (i === 4 ? k + 2 : 1) })));
      }
      await sleep(0);
      obs.disconnect();
      return {
        focusedFirst,
        stillFocused: doc.activeElement === pause,
        sameRows: [0, 1, 2, 3, 4].every(i => rowEl(panel, i) === before[i]),
        detail: rowEl(panel, 4).querySelector(".zenius-task-detail").textContent,
        touched: [...touched],
      };
    } finally {
      Panel.closeTasksPanel(win);
    }
  `);
  assert.deepEqual(out, {
    focusedFirst: true,
    stillFocused: true,
    sameRows: true,
    detail: "Agent working · step 51",
    touched: ["980004"],
  });
});

test("a press lands though updates come between its mousedown and mouseup", async () => {
  const out = await h.chrome(`${P}
    update([0, 1, 2, 3].map(i => row(i)));
    const panel = await open();
    try {
      let landed = 0;
      for (let k = 0; k < 5; k++) {
        calls.length = 0;
        const b = button(panel, 2, "pause");
        const r = b.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        win.synthesizeMouseEvent("mousedown", x, y, { button: 0, buttons: 1, clickCount: 1 }, { isDOMEventSynthesized: false });
        for (let j = 0; j < 5; j++) {
          update([0, 1, 2, 3].map(i => row(i, { detail: "Agent working · step " + (k * 10 + j) })));
          await sleep(20);
        }
        win.synthesizeMouseEvent("mouseup", x, y, { button: 0, buttons: 0, clickCount: 1 }, { isDOMEventSynthesized: false });
        await sleep(50);
        if (calls.includes("pause 980002")) landed++;
      }
      return { landed };
    } finally {
      Panel.closeTasksPanel(win);
    }
  `);
  assert.deepEqual(out, { landed: 5 });
});

test("mid-press nothing moves: a row that comes or grows above waits until the release", async () => {
  const out = await h.chrome(`${P}
    update([0, 1, 2].map(i => row(i)));
    const panel = await open();
    try {
      const b = button(panel, 2, "pause");
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      win.synthesizeMouseEvent("mousedown", x, y, { button: 0, buttons: 1, clickCount: 1 }, { isDOMEventSynthesized: false });
      // A new task above, and the first row's tabs named by long URLs.
      const long = n => "https://shop.example.com/checkout/step-" + n + "?session=" + "x".repeat(40);
      update([row(0, { tabs: [1, 2, 3, 4].map(n => ({ id: "zu-up-l" + n, title: long(n) })) }), row(7), row(1), row(2)]);
      await sleep(30);
      const heldStill = Math.round(b.getBoundingClientRect().top - r.top);
      const newRowYet = !!rowEl(panel, 7);
      win.synthesizeMouseEvent("mouseup", x, y, { button: 0, buttons: 0, clickCount: 1 }, { isDOMEventSynthesized: false });
      await sleep(50);
      return { heldStill, newRowYet, landed: calls.includes("pause 980002"), newRowAfter: !!rowEl(panel, 7) };
    } finally {
      Panel.closeTasksPanel(win);
    }
  `);
  assert.deepEqual(out, { heldStill: 0, newRowYet: false, landed: true, newRowAfter: true });
});

test("Pause and Resume relabel one button; a change of hands swaps only the middle buttons and keeps the keyboard in the row", async () => {
  const out = await h.chrome(`${P}
    update([0, 1].map(i => row(i)));
    const panel = await open();
    try {
      const actionsOf = () => [...rowEl(panel, 1).querySelectorAll(".zenius-task-actions button")].map(b => b.dataset.action);
      const open1 = button(panel, 1, "open");
      const stop1 = button(panel, 1, "stop");
      const pause = button(panel, 1, "pause");
      pause.focus();
      update([row(0), row(1, { paused: true, state: "paused" })]);
      const resumed = { same: button(panel, 1, "resume") === pause, label: pause.textContent, focused: doc.activeElement === pause, actions: actionsOf() };
      update([row(0), row(1, { ownership: "agentDelegatedToUser", state: "needs-user" })]);
      const handBack = button(panel, 1, "handBack");
      const handed = { actions: actionsOf(), focusOnHandBack: doc.activeElement === handBack, openKept: button(panel, 1, "open") === open1, stopKept: button(panel, 1, "stop") === stop1 };
      handBack.click();
      return { resumed, handed, calls: calls.slice() };
    } finally {
      Panel.closeTasksPanel(win);
    }
  `);
  assert.deepEqual(out.resumed, { same: true, label: "Resume", focused: true, actions: ["open", "resume", "takeOver", "stop"] });
  assert.deepEqual(out.handed, { actions: ["open", "handBack", "stop"], focusOnHandBack: true, openKept: true, stopKept: true });
  assert.deepEqual(out.calls, ["handBack 980001"]);
});

test("rows come, go and reorder with their tasks; a closed panel keeps none", async () => {
  const out = await h.chrome(`${P}
    update([0, 1, 2].map(i => row(i)));
    const panel = await open();
    try {
      const order = () => [...panel.querySelectorAll(".zenius-task")].map(el => Number(el.dataset.space) - 980000);
      const a = rowEl(panel, 0);
      const c = rowEl(panel, 2);
      update([row(0), row(2)]);
      const dropped = { order: order(), aKept: rowEl(panel, 0) === a, cKept: rowEl(panel, 2) === c };
      update([row(2), row(0), row(3)]);
      const moved = { order: order(), aKept: rowEl(panel, 0) === a, cKept: rowEl(panel, 2) === c };
      update([]);
      const empty = { order: order(), text: panel.querySelector(".zenius-tasks-empty")?.textContent ?? null };
      update([row(5)]);
      const back = { order: order(), empty: !!panel.querySelector(".zenius-tasks-empty") };
      Panel.closeTasksPanel(win);
      await new Promise(r => (panel.state === "closed" ? r() : panel.addEventListener("popuphidden", r, { once: true })));
      return { dropped, moved, empty, back, closedRows: panel.querySelectorAll(".zenius-task").length };
    } finally {
      Panel.closeTasksPanel(win);
    }
  `);
  assert.deepEqual(out, {
    dropped: { order: [0, 2], aKept: true, cKept: true },
    moved: { order: [2, 0, 3], aKept: true, cKept: true },
    empty: { order: [], text: "No agent is working right now." },
    back: { order: [5], empty: false },
    closedRows: 0,
  });
});
