// The UI with tasks sharing the Agents Space (SPEC §3.4, §3.8; pref
// zenius.agentsSpace, read when a task is created). Two tasks live in one
// Zen workspace: each keeps its own state in the panel and on its tabs, and
// the Agents Space's badge shows only while a task needs the user.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup, iso } from "./lib.mjs";

let h;
let userView;
let a;
let b;
// Ended tasks keep their names in the instance's state across runs (until
// the core's restart step drops tasks whose tabs didn't come back).
const run = Date.now().toString(36).slice(-5);
const nameA = `zen-ux agents A ${run}`;
const nameB = `zen-ux agents B ${run}`;

// Chrome-side helpers for both tasks.
const Q = () => `
  const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
  const C = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/cursor.sys.mjs");
  const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
  const A = ctx.resolvePage({ space: ${a}, page: "p1" });
  const B = ctx.resolvePage({ space: ${b}, page: "p1" });
  const uuid = A.space.uuid;
  const btn = () => win.document.querySelector('#zen-workspaces-button toolbarbutton[zen-workspace-id="' + uuid + '"]');
  // The status line under the Space's header.
  const statusEl = () => win.document.getElementById(uuid)?.querySelector(":scope > .zenius-space-status");
  const badge = () => ({
    attr: btn()?.getAttribute("zenius-agent") ?? null,
    tooltip: btn()?.getAttribute("tooltiptext") ?? null,
    status: statusEl()?.querySelector(".zenius-space-status-text")?.textContent ?? null,
  });
  const row = rec => UI.tasks().find(r => r.id === rec.id)?.state ?? null;
  const tick = () => new Promise(r => win.setTimeout(r, 0));
`;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  ({ id: a } = await h.createSpace({ name: nameA }));
  ({ id: b } = await h.createSpace({ name: nameB }));
  for (const space of [a, b]) {
    await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  }
});

after(async () => {
  await h
    ?.chrome(
      `${Q()}
      for (const p of [A, B]) {
        if (p.space.ownership === "agentDelegatedToUser") ctx.spaces.setOwnership(p.space, "agent", { source: "user" });
      }
    `
    )
    .catch(() => {});
  await h?.close();
});

test("both tasks live in the Agents Space, each with its own state in the panel and on its tab", async () => {
  const out = await h.chrome(`${Q()}
    await C.moveCursor(A.tab, { x: 20, y: 20 }, { label: "Click Search", kind: "click" });
    ctx.spaces.setOwnership(B.space, "agentDelegatedToUser", { source: "agent" });
    await tick();
    const res = {
      // The core marks task pages; the UI's tag builds on it.
      marked: [A.tab.getAttribute("zenius-task") === String(A.space.id), B.tab.getAttribute("zenius-task") === String(B.space.id)],
      kinds: [A.space.kind, B.space.kind],
      shared: A.space.uuid === B.space.uuid && ctx.service.spaces.isAgentsSpace(uuid),
      rows: [row(A.space), row(B.space)],
      tags: [A.tab.getAttribute("zenius-task-state"), B.tab.getAttribute("zenius-task-state")],
    };
    ctx.spaces.setOwnership(B.space, "agent", { source: "user" });
    return res;
  `);
  assert.deepEqual(out.marked, [true, true]);
  assert.deepEqual(out.kinds, ["task", "task"]);
  assert.equal(out.shared, true);
  assert.deepEqual(out.rows, ["working", "needs-user"]);
  assert.deepEqual(out.tags, ["working", "needs-user"]);
});

test("the Agents Space's badge shows only while a task there needs the user", async () => {
  const out = await h.chrome(`${Q()}
    await C.moveCursor(A.tab, { x: 30, y: 30 }, { label: "Click Next", kind: "click" });
    const working = badge();
    ctx.spaces.setStateText(B.space, "Log in to continue");
    ctx.spaces.setOwnership(B.space, "agentDelegatedToUser", { source: "agent" });
    const one = badge();
    ctx.spaces.setOwnership(A.space, "agentDelegatedToUser", { source: "agent" });
    const two = badge();
    ctx.spaces.setOwnership(A.space, "agent", { source: "user" });
    ctx.spaces.setOwnership(B.space, "agent", { source: "user" });
    const none = badge();
    // zenius keeps the name the user last gave the Agents Space.
    return { working, one, two, none, name: gZenWorkspaces.getWorkspaceFromId(uuid).name };
  `);
  assert.deepEqual(out.working, { attr: null, tooltip: out.working.tooltip, status: null }, "no badge while tasks just work");
  assert.equal(out.one.attr, "needs-user");
  assert.equal(out.one.tooltip, `${iso(out.name)} — Agent needs you ${iso(nameB)}, ${iso("Log in to continue")}`);
  assert.equal(out.one.status, `Agent needs you ${iso(nameB)}, ${iso("Log in to continue")}`);
  assert.equal(out.two.status, `Agent needs you 2 tasks: ${iso(nameA)}, ${iso(nameB)}`);
  assert.equal(out.none.attr, null);
  assert.equal(out.none.status, null);
});

test("the user's input in one task's page pauses that task only; the other goes on", async () => {
  const out = await h.chrome(`${Q()}
    try {
      UI.takeover.handleInput(A.space, A.tab, "pointer");
      await tick();
      return {
        prompt: [!!UI.takeover.promptState(A.space.id), !!UI.takeover.promptState(B.space.id)],
        paused: [A.space.paused, B.space.paused],
        owners: [A.space.ownership, B.space.ownership],
        rows: [row(A.space), row(B.space)],
      };
    } finally {
      UI.takeover.reset();
      await tick();
    }
  `);
  assert.deepEqual(out.prompt, [true, false], "the prompt is A's");
  assert.deepEqual(out.paused, [true, false]);
  assert.deepEqual(out.owners, ["agent", "agent"]);
  assert.equal(out.rows[0], "paused");
  assert.notEqual(out.rows[1], "paused");
  // The resume first asks the input layer which pages hold a typed secret.
  const after = await h.chrome(`${Q()}
    for (const end = Date.now() + 3000; A.space.paused && Date.now() < end; ) await new Promise(r => win.setTimeout(r, 25));
    return [A.space.paused, B.space.paused];
  `);
  assert.deepEqual(after, [false, false], "A resumes when the prompt goes");
});

test("the end of one task leaves the badge to another that still needs the user", async () => {
  const out = await h.chrome(`${Q()}
    ctx.spaces.setOwnership(A.space, "agentDelegatedToUser", { source: "agent" });
    ctx.spaces.setOwnership(B.space, "agentDelegatedToUser", { source: "agent" });
    UI.stopByUser(A.space);
    await tick();
    const res = { badge: badge(), rows: [row(A.space), row(B.space)], tagA: A.tab.getAttribute("zenius-task-state") };
    ctx.spaces.setOwnership(B.space, "agent", { source: "user" });
    return res;
  `);
  assert.equal(out.badge.attr, "needs-user");
  assert.ok(out.badge.status.startsWith(`Agent needs you ${iso(nameB)}`), out.badge.status);
  assert.deepEqual(out.rows, [null, "needs-user"]);
  assert.equal(out.tagA, null);
});

test("agent actions there leave the Agents Space's landing tab to the user", async () => {
  const out = await h.chrome(`${Q()}
    const before = gZenWorkspaces.lastSelectedWorkspaceTabs[uuid] ?? null;
    await C.moveCursor(A.tab, { x: 40, y: 40 }, { label: "Click Book", kind: "click" });
    await C.moveCursor(B.tab, { x: 40, y: 40 }, { label: "Click Pay", kind: "click" });
    const after = gZenWorkspaces.lastSelectedWorkspaceTabs[uuid] ?? null;
    return { active: gZenWorkspaces.activeWorkspace === uuid, same: before === after };
  `);
  assert.equal(out.active, false, "the premise: the user is in their own Space");
  assert.equal(out.same, true);
});

test("the panel's Open lands on the task's page", async () => {
  const out = await h.chrome(`${Q()}
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    ctx.spaces.setOwnership(B.space, "agentDelegatedToUser", { source: "agent" });
    try {
      await UI.openSpace(B.space);
      return { active: gZenWorkspaces.activeWorkspace === uuid, selected: gBrowser.selectedTab === B.tab };
    } finally {
      ctx.spaces.setOwnership(B.space, "agent", { source: "user" });
      await gZenWorkspaces.changeWorkspaceWithID(userWs);
    }
  `);
  assert.deepEqual(out, { active: true, selected: true });
});

test("from inside the Agents Space, on one task's page, Open on the other task lands on its page: Zen's switch to the Space already shown selects nothing, so the watch selects the page itself", async () => {
  const out = await h.chrome(`${Q()}
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    try {
      await UI.openSpace(A.space);
      const first = { active: gZenWorkspaces.activeWorkspace === uuid, selected: gBrowser.selectedTab === A.tab };
      // Zen's own switch, as the premise: it leaves the selection alone.
      Pages.landOn(B.tab);
      await gZenWorkspaces.changeWorkspaceWithID(uuid);
      const zens = gBrowser.selectedTab === B.tab;
      gBrowser.selectedTab = A.tab;
      await UI.openSpace(B.space);
      return { first, zens, active: gZenWorkspaces.activeWorkspace === uuid, selected: gBrowser.selectedTab === B.tab, watching: UI.watching(win) === B.space.id };
    } finally {
      await gZenWorkspaces.changeWorkspaceWithID(userWs);
    }
  `);
  assert.deepEqual(out.first, { active: true, selected: true });
  assert.equal(out.zens, false, "the premise: Zen's switch to the Space it shows selects nothing");
  assert.deepEqual({ ...out, first: undefined, zens: undefined }, { first: undefined, zens: undefined, active: true, selected: true, watching: true });
});

test("with nothing needing the user, Open lands on the task's front tab: the agent's newest page, then the user's pick", async () => {
  const { label } = await h.call("pages.new", { space: b, url: `${h.base}/zoo/frames.html` });
  try {
    const out = await h.chrome(`${Q()}
      const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
      const second = ctx.resolvePage({ space: ${b}, page: ${JSON.stringify(label)} }).tab;
      try {
        await UI.openSpace(B.space);
        const agents = gBrowser.selectedTab === second;
        // The user picks the first page, then leaves.
        gBrowser.selectedTab = B.tab;
        await gZenWorkspaces.changeWorkspaceWithID(userWs);
        await UI.openSpace(B.space);
        return { agents, users: gBrowser.selectedTab === B.tab };
      } finally {
        await gZenWorkspaces.changeWorkspaceWithID(userWs);
      }
    `);
    assert.deepEqual(out, { agents: true, users: true });
  } finally {
    await h.call("pages.close", { space: b, page: label });
  }
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
