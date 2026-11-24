// The agent status strip and tasks panel (runtime/JS/zenius/ui/panel.sys.mjs),
// and what handOff() shows (ui/index.sys.mjs).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prelude, setup, iso } from "./lib.mjs";

const NAME = "zen-ux panel test";
let h;

/** The site the hold cards name: the fixture's host, isolated as the card's texts are. */
const site = () => iso(new URL(h.base).hostname);
let space;
let P;
let userView;

before(async () => {
  h = await setup();
  // The OS notification is off by default, as these tests expect, whatever
  // a kept profile's last run left (its after() may not have run).
  await h.chrome(`Services.prefs.clearUserPref("zenius.ux.handoff.systemNotification"); return true;`);
  userView = await h.call("dev.viewState");
  ({ id: space } = await h.createSpace({ name: NAME }));
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  P = `${prelude(space)}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const doc = win.document;
    const strip = doc.getElementById("zenius-agents-strip");
    const panel = () => doc.getElementById("zenius-tasks-panel");
    const row = () => panel()?.querySelector('.zenius-task[data-space="${space}"]');
    const actionsOf = () => [...(row()?.querySelectorAll(".zenius-task-actions button") ?? [])].map(b => b.dataset.action);
    const openPanel = async () => {
      if (panel()?.state !== "open") {
        // With one task waiting, the strip's click goes to it, and All agent
        // tasks opens the panel.
        const allTasks = doc.getElementById("zenius-strip-all");
        (allTasks && !allTasks.hidden ? allTasks : strip).click();
        await until(() => panel()?.state === "open");
      }
    };
    const press = async action => {
      await openPanel();
      const b = row()?.querySelector('[data-action="' + action + '"]');
      if (!b) throw new Error("no " + action + " button, only " + actionsOf().join("|"));
      b.click();
    };
    const closePanel = async () => {
      if (panel()?.state === "open") {
        panel().hidePopup();
        await until(() => panel().state === "closed");
      }
    };
    const showUserSpace = async () => {
      await gZenWorkspaces.changeWorkspaceWithID(${JSON.stringify(userView.windows[0].activeWorkspace)});
      await until(() => gZenWorkspaces.activeWorkspace === ${JSON.stringify(userView.windows[0].activeWorkspace)});
      await sleep(200);
    };
  `;
});

after(async () => {
  await h?.chrome(`${P}
    Services.prefs.clearUserPref("zenius.ux.handoff.systemNotification");
    UI.alertsService = null;
    await closePanel();
    if (gZenWorkspaces.activeWorkspace !== ${JSON.stringify(userView?.windows[0].activeWorkspace)}) await showUserSpace();
  `).catch(() => {});
  await h?.close();
});

const state = () => h.call("ui.state", { space });

test("the strip's text fits a narrow sidebar", async () => {
  const out = await h.chrome(`
    const { stripText } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/panel.sys.mjs");
    return [stripText(1, 0, 0), stripText(3, 0, 0), stripText(3, 0, 1), stripText(3, 0, 2), stripText(3, 1, 2), stripText(3, 2, 0), stripText(2, 0, 0, 1), stripText(3, 0, 1, 2)];
  `);
  assert.deepEqual(out, [
    "1 agent task",
    "3 agent tasks",
    "1 agent working",
    "2 agents working",
    "An agent needs you",
    "2 agents need you",
    "1 agent paused",
    "1 agent working",
  ]);
});

test("the strip's line for one waiting task says what it waits for, after the task's name", async () => {
  const out = await h.chrome(`
    const { waitText } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/panel.sys.mjs");
    return ["sign_in", "irreversible", "human_check", "other", "handoff", "permission", "choice", "question", "error", "interrupted", "takeover", "constructor", "manual_takeover", null].map(waitText);
  `);
  assert.deepEqual(out, [
    "needs a sign-in",
    "needs your OK",
    "needs a human check",
    "needs you",
    "needs you",
    "needs your permission",
    "needs a choice",
    "needs an answer",
    "hit an error",
    "was interrupted",
    "waits for you",
    "needs you",
    "needs you",
    "needs you",
  ]);
});

test("the strip counts agent tasks and opens the panel, which lists them", async () => {
  const out = await h.chrome(`${P}
    await until(() => !strip.hidden);
    await openPanel();
    const r = row();
    const info = {
      // Its accessible name: a named line's words in full, whatever fits.
      strip: strip.getAttribute("aria-label") ?? strip.textContent,
      row: strip.parentElement.id,
      inSidebar: strip.parentElement.parentElement.id,
      name: r?.querySelector(".zenius-task-name").textContent,
      detail: r?.querySelector(".zenius-task-detail").textContent,
      actions: actionsOf(),
      // I4: not a CustomizableUI widget, so no change to the toolbar layout pref.
      cuiPlacement: CustomizableUI.getPlacementOfWidget("zenius-agents-strip"),
      inLayoutPref: Services.prefs.getStringPref("browser.uiCustomization.state", "").includes("zenius"),
    };
    await closePanel();
    return info;
  `);
  assert.match(out.strip, /^(\d+ agents? (task|tasks|working)|\d+ agents need you|.+ (needs .+|hit an error|was interrupted|waits for you))$/);
  assert.equal(out.row, "zenius-strip-row", "the strip and All agent tasks share a row");
  assert.equal(out.inSidebar, "TabsToolbar");
  assert.equal(out.name, iso(NAME));
  assert.match(out.detail, /^Agent/);
  assert.deepEqual(out.actions, ["open", "pause", "takeOver", "stop"]);
  assert.equal(out.cuiPlacement, null);
  assert.equal(out.inLayoutPref, false);
});

test("the agent sidebar's word on a task its chat drives: a running turn counts as working however long since the agent last acted, and the chat's wait for the user counts as needing them, in the badge and the strip", async () => {
  // A task of its own, where the agent hasn't acted: idle until told.
  const { id: fresh } = await h.createSpace({ name: `${NAME} sidebar word` });
  try {
    const out = await h.chrome(`${P}
      const r = ctx.spaces.peek(${fresh});
      const state = () => UI.badgeFor(r)?.state ?? null;
      const res = { before: state() };
      UI.noteSidebarTask(r.id, { running: true });
      res.running = state();
      UI.noteSidebarTask(r.id, { running: false });
      res.ended = state();
      UI.noteSidebarTask(r.id, { needs: "question" });
      await until(() => /need/.test(strip.textContent));
      // Its accessible name: a named line's words in full, whatever fits.
      res.needs = { state: state(), strip: strip.getAttribute("aria-label") ?? strip.textContent, attr: strip.getAttribute("state") };
      UI.noteSidebarTask(r.id, { needs: null });
      res.answered = state();
      return res;
    `);
    assert.deepEqual(out, {
      before: "idle",
      running: "working",
      ended: "idle",
      needs: { state: "needs-user", strip: out.needs.strip, attr: "needs-user" },
      answered: "idle",
    });
    assert.match(out.needs.strip, /^(.+ needs an answer|\d+ agents need you)$/);
  } finally {
    await h.call("spaces.finish", { space: fresh, keep: [] }).catch(() => {});
  }
});

test("Pause holds the agent's next action until Resume; user input opens no prompt meanwhile", async () => {
  const out = await h.chrome(`${P}
    const P2 = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    await press("pause");
    const g = ctx.spaces.gate(rec);
    let ran = false;
    g?.then(() => { ran = true; });
    // Show the agent's page and click it as the user would.
    P2.landOn(tab);
    await closePanel();
    await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
    await until(() => gBrowser.selectedTab === tab);
    await sleep(300);
    // The middle of the page: Firefox anchors its own doorhangers (an
    // update is available, say) at the window's top-left corner.
    const r = browser.getBoundingClientRect();
    for (const type of ["mousedown", "mouseup"]) {
      win.synthesizeMouseEvent(type, r.x + r.width / 2, r.y + r.height / 2, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
    }
    await sleep(150);
    const held = {
      waiting: !!g,
      ran,
      prompt: UI.takeover.promptState(rec.id),
      actions: (await openPanel(), actionsOf()),
      // The task's own word: the strip sums every task, and a kept profile
      // may hold another that needs the user (15 saved, on a Mac).
      badge: UI.badgeFor(rec)?.state ?? null,
    };
    await press("resume");
    await sleep(50);
    held.ranAfterResume = ran;
    await closePanel();
    await showUserSpace();
    return held;
  `);
  assert.equal(out.waiting, true, "the gate waits while paused");
  assert.equal(out.ran, false);
  assert.equal(out.prompt, null, "a Space the user paused opens no takeover prompt");
  assert.deepEqual(out.actions, ["open", "resume", "takeOver", "stop"]);
  assert.equal(out.badge, "paused", "a task the user paused doesn't need them");
  assert.equal(out.ranAfterResume, true);
  const s = await state();
  assert.equal(s.paused, false);
  assert.equal(s.pausedByUser, false);
});

test("a prompt closing doesn't resume a Space the user paused", async () => {
  const out = await h.chrome(`${P}
    UI.pauseByUser(rec);
    UI.takeover.handleInput(rec, tab, "pointer");
    UI.takeover.resolve(rec.id, "continue");
    const paused = rec.paused;
    // The resume first asks zen-input which pages hold a typed secret.
    await UI.resumeByUser(rec);
    return { paused, after: rec.paused };
  `);
  assert.deepEqual(out, { paused: true, after: false });
});

test("Take over in the panel hands the Space to the user and shows it", async () => {
  const out = await h.chrome(`${P}
    await press("takeOver");
    await until(() => gZenWorkspaces.activeWorkspace === rec.uuid);
    await until(() => panel().state === "closed");
    return { shown: gZenWorkspaces.activeWorkspace === rec.uuid, actions: (await openPanel(), actionsOf()) };
  `);
  assert.equal(out.shown, true);
  assert.deepEqual(out.actions, ["open", "handBack", "stop"]);
  let s = await state();
  assert.equal(s.ownership, "agentDelegatedToUser");
  assert.equal(s.reason, "manual_takeover");
  assert.equal(s.taskBadge.state, "user");
  assert.match(s.controlNotice, /^You're in control/);
  await h.chrome(`${P} await press("handBack"); await closePanel(); await showUserSpace();`);
  s = await state();
  assert.equal(s.ownership, "agent");
  assert.equal(s.controlNotice, null);
});

test("handOff shows the agent's request in its page and badge, and no OS notification by default", async () => {
  const view = await h.call("dev.viewState");
  const out = await h.chrome(`${P}
    UI.alertsService = { calls: [], showAlert(alert, listener) { this.calls.push({ title: alert.title, text: alert.text, listener }); } };
    ctx.spaces.setStateText(rec, "Log in to continue");
    // What zen-core's spaces.handOff does.
    ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
    await until(() => strip.getAttribute("state") === "needs-user");
    return { alerts: UI.alertsService.calls.length, strip: strip.textContent };
  `);
  assert.equal(out.alerts, 0);
  // The one waiting task is named; a hand-off with no reason needs you.
  assert.match(out.strip, /needs? you$/);
  const s = await state();
  assert.equal(s.taskBadge.state, "needs-user");
  assert.equal(s.taskBadge.text, "Log in to continue");
  assert.equal(s.controlNotice, `Agent needs you · ${iso(NAME)} on ${site()}`);
  assert.ok([s.controlNote, s.controlMore].includes(`The agent says: “${iso("Log in to continue")}”.`), JSON.stringify(s));
  assert.deepEqual(await h.call("dev.viewState"), view, "nothing moved the user's view");
  await h.chrome(`${P} ctx.spaces.setOwnership(rec, "agent", { source: "user" });`);
});

test("with zenius.ux.handoff.systemNotification on, handOff also notifies the OS; clicking it opens the Space", async () => {
  const out = await h.chrome(`${P}
    Services.prefs.setBoolPref("zenius.ux.handoff.systemNotification", true);
    ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
    const calls = UI.alertsService.calls;
    const call = calls[0];
    call?.listener.observe(null, "alertclickcallback", null);
    await until(() => gZenWorkspaces.activeWorkspace === rec.uuid);
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    ctx.spaces.setStateText(rec, "");
    await showUserSpace();
    return { count: calls.length, title: call?.title, text: call?.text };
  `);
  assert.equal(out.count, 1);
  assert.equal(out.title, `An agent needs you: ${NAME}`);
  assert.equal(out.text, "Log in to continue");
});

test("Stop ends the task: a waiting action fails, and the Space becomes the user's", async () => {
  const out = await h.chrome(`${P}
    await press("pause");
    const outcome = ctx.spaces.gate(rec).then(() => "ran", e => e.code);
    await press("stop");
    const code = await outcome;
    await sleep(50);
    let after;
    try { ctx.spaces.gate(rec); after = null; } catch (e) { after = e.code; }
    const info = {
      code,
      after,
      row: !!row(),
      undiscardable: tab.undiscardable,
      spaceKept: gZenWorkspaces.getWorkspaces().some(w => w.uuid === rec.uuid),
    };
    await closePanel();
    return info;
  `);
  assert.equal(out.code, "ZEN_TASK_SPACE_INACTIVE");
  assert.equal(out.after, "ZEN_TASK_SPACE_INACTIVE");
  assert.equal(out.row, false, "the task left the panel");
  assert.equal(out.undiscardable, false, "its tabs are ordinary tabs again");
  assert.equal(out.spaceKept, true, "the Space and its tabs stay");
  const s = await state();
  assert.equal(s.ownership, "user");
  assert.equal(s.badge, null);
  assert.equal(s.paused, false);
});

test("a Space deleted in Zen leaves the panel and loses its badge", async () => {
  // A Space of the task's own, which a claimed user Space is: the Agents
  // Space's tasks share theirs.
  const { id: other } = await h.claimedSpace("zen-ux panel test, deleted");
  const out = await h.chrome(`${P}
    const gone = ctx.spaces.peek(${other});
    await until(() => B.spaceBadge(gone.uuid));
    await openPanel();
    const rowOf = () => panel().querySelector('.zenius-task[data-space="${other}"]');
    const listed = !!rowOf();
    await gZenWorkspaces.removeWorkspace(gone.uuid);
    await until(() => !B.spaceBadge(gone.uuid));
    await until(() => !rowOf());
    await closePanel();
    return { listed };
  `);
  assert.equal(out.listed, true);
});

// The tests themselves switch Spaces as the user would, which moves focus;
// what must come back is the user's Space and tab.
test("each task lists its tabs, and a tab's name opens that tab", async () => {
  const { id: two } = await h.createSpace({ name: `zen-ux two tabs ${Date.now() % 100000}` });
  await h.call("page.goto", { space: two, page: "p1", url: `${h.base}/` });
  await h.call("pages.new", { space: two, url: `${h.base}/zoo/frames.html` });
  const out = await h.chrome(`${P}
    const T = ctx.resolvePage({ space: ${two}, page: "p1" });
    const twoRow = () => panel()?.querySelector('.zenius-task[data-space="${two}"]');
    try {
      await openPanel();
      const names = () => [...(twoRow()?.querySelectorAll(".zenius-task-tab") ?? [])];
      await until(() => names().length === 2);
      const listed = names().map(b => b.textContent);
      const second = names()[1];
      const want = ctx.service.pages.tabsOf(T.space).find(t => ctx.service.pages.tabId(t) === second.dataset.tab);
      second.click();
      await until(() => gZenWorkspaces.activeWorkspace === T.space.uuid && gBrowser.selectedTab === want);
      return { listed, shown: gBrowser.selectedTab === want, other: want !== T.tab };
    } finally {
      await closePanel();
      await showUserSpace();
    }
  `);
  assert.equal(out.listed.length, 2, JSON.stringify(out.listed));
  assert.ok(out.listed.every(t => t.length > 0), JSON.stringify(out.listed));
  assert.equal(out.shown, true);
  assert.equal(out.other, true, "the second tab, not the first");
  await h.call("spaces.finish", { space: two, keep: [] });
});

test("idle tasks: marked with the auto-close's wait in days, and closed in one click", async () => {
  // A task in the Agents Space the agent left alone past zenius.autoCloseHours.
  const { id: idle } = await h.createSpace({ name: `zen-ux idle task ${Date.now() % 100000}` });
  await h.call("page.goto", { space: idle, page: "p1", url: `${h.base}/` });
  const out = await h.chrome(`${P}
    const { idleText } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/panel.sys.mjs");
    const I = ctx.resolvePage({ space: ${idle}, page: "p1" });
    const idleRow = () => panel()?.querySelector('.zenius-task[data-space="${idle}"]');
    const words = [72, 24, 36, 1].map(idleText);
    try {
      await openPanel();
      const fresh = idleRow()?.querySelector(".zenius-task-idle")?.textContent ?? null;
      await closePanel();
      I.space.lastNamedAt = Date.now() - 73 * 3_600_000;
      await openPanel();
      const line = idleRow()?.querySelector(".zenius-task-idle span")?.textContent ?? null;
      idleRow().querySelector('[data-action="closeIdle"]').click();
      await until(() => !I.tab.isConnected || I.tab.closing);
      await until(() => !idleRow());
      return { words, fresh, line, gone: ctx.service.spaces.peek(${idle}) ?? null };
    } finally {
      await closePanel();
    }
  `);
  assert.deepEqual(out.words, ["3 days", "1 day", "36 hours", "1 hour"]);
  assert.equal(out.fresh, null, "a task named lately isn't idle");
  assert.equal(out.line, "Idle for 3 days");
  assert.equal(out.gone, null, "the task closed, its tab with it");
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
