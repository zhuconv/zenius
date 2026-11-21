// Tasks in the shared Agents Space (SPEC §3.4): every task an agent creates
// keeps its tabs in one Zen workspace, which goes once it's empty and no
// window shows it.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { connect } from "../../scripts/lib/rpc.mjs";
import { setup } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
  await cleanUp();
});
// One failed test leaves tasks and a renamed Space; the next starts clean.
afterEach(() => cleanUp());
after(() => h?.close());

/** Remove every task and give the Agents Space its default name back. */
async function cleanUp() {
  const removeTasks = () =>
    h.chrome(
      `for (const rec of ctx.spaces.records()) {
         if (rec.kind === "task" && !rec.gone) {
           for (const t of ctx.pages.tabsOf(rec)) ctx.pages.closeTab(t);
           ctx.spaces.remove(rec);
         }
       }
       return true;`
    );
  await removeTasks();
  if ((await h.chrome(`return ctx.spaces.agentsSpace.name`)) !== "Agents") {
    await h.space("agents reset");
    await renameAgentsSpace("Agents");
    await removeTasks();
  }
}

/** Rename the Agents Space as the user does, in Zen. */
const renameAgentsSpace = name =>
  h.chrome(
    `const uuid = ctx.spaces.agentsSpace.uuid;
     await win.gZenWorkspaces.saveWorkspace({ ...win.gZenWorkspaces.getWorkspaceFromId(uuid), name: arg });
     ctx.spaces.refresh();
     return true;`,
    name
  );

const url = path => `${h.base}${path}`;
const W = `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");`;

/** The Agents Space as the runtime and Zen see it. */
const agentsSpace = () =>
  h.chrome(
    `${W}
     const a = ctx.spaces.agentsSpace;
     const ws = a.uuid && win.gZenWorkspaces.getWorkspaceFromId(a.uuid);
     return { name: a.name, exists: !!ws, zenName: ws?.name ?? null, tabs: a.uuid ? W.tabsInWorkspace(a.uuid).length : 0 };`
  );
const workspaceCount = () => h.chrome(`return win.gZenWorkspaces.getWorkspaces().length`);
const listed = async () => (await h.call("spaces.list")).taskSpaces;
const tabsOf = async space => (await h.call("tabs.list", { space })).map(t => [t.label ?? null, t.openedBy]);
/** The workspace a page's tab is in. */
const homeOf = (space, page) =>
  h.chrome(`return ctx.resolvePage(arg).tab.getAttribute("zen-workspace-id")`, { space, page });
const agentsUuid = () => h.chrome(`return ctx.spaces.agentsSpace.uuid`);
/** Close a tab as the user does (Ctrl+W), by tab id. */
const userCloses = (space, tab) =>
  h.chrome(
    `const t = ctx.pages.findTab(ctx.spaces.get(arg.space), arg.tab);
     t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false, skipPermitUnload: true });
     return true;`,
    { space, tab }
  );
/** A task's tabs as the runtime holds them, also once the agent lost it. */
const taskTabs = space =>
  h.chrome(
    `const rec = ctx.spaces.peek(arg);
     return rec && ctx.pages.tabsOf(rec).map(t => {
       const page = ctx.pages.forTab(t);
       const id = ctx.pages.tabId(t);
       return { id, label: page?.label ?? null, openedBy: page?.openedBy ?? rec.ledger.unmanaged[id] };
     });`,
    space
  );
/** A tab's session value and zen-ux's tag, by page label or tab id. */
const marks = (space, ref) =>
  h.chrome(
    `const P = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/pages.sys.mjs");
     const rec = ctx.spaces.peek(arg.space);
     const tab = arg.page ? ctx.pages.tabFor(ctx.pages.get(rec, arg.page)) : ctx.pages.findTab(rec, arg.tab);
     return { value: P.readTabValue(tab), tag: tab.getAttribute("zenius-task") };`,
    { space, ...ref }
  );
/** A tab by tab id, wherever it is: open, its tag and session value, and whether its close waits. */
const tabState = id =>
  h.chrome(
    `${W}
     const P = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/pages.sys.mjs");
     const t = [...W.allTabs()].find(x => !x.closing && ctx.pages.tabId(x) === arg);
     return t ? { open: true, selected: t.selected, tag: t.getAttribute("zenius-task"), value: P.readTabValue(t), waits: ctx.pages.isDeferred(t) } : { open: false };`,
    id
  );
/** The user opens the Agents Space and selects a task's page. */
const userViews = (space, page) =>
  h.chrome(
    `await win.gZenWorkspaces.changeWorkspaceWithID(ctx.spaces.agentsSpace.uuid);
     win.gBrowser.selectedTab = ctx.resolvePage(arg).tab;
     return true`,
    { space, page }
  );
const userGoesTo = workspace =>
  h.chrome(`await win.gZenWorkspaces.changeWorkspaceWithID(arg); return true`, workspace);
const activeWorkspace = () => h.chrome(`return win.gZenWorkspaces.activeWorkspace`);
const pageTab = async (space, page) => (await h.call("pages.list", { space })).find(p => p.label === page).tab;
/** In-process events of one name, recorded while `fn` runs. */
async function recording(name, fn) {
  await h.chrome(
    `ctx.service.__recorded = [];
     ctx.service.__stopRecording = ctx.service.addEventListener((event, params) => {
       if (event === arg) ctx.service.__recorded.push({ space: params.space, tab: params.tab ? ctx.pages.tabId(params.tab) : null });
     });
     return true`,
    name
  );
  try {
    await fn();
    return await h.chrome(`return ctx.service.__recorded`);
  } finally {
    await h.chrome(`ctx.service.__stopRecording?.(); delete ctx.service.__stopRecording; delete ctx.service.__recorded; return true`);
  }
}
/** The Agents Space's strip, top to bottom: [task, label] per page, [null, tab id] for other tabs. */
const strip = () =>
  h.chrome(
    `const c = win.gZenWorkspaces.workspaceElement(ctx.spaces.agentsSpace.uuid)?.tabsContainer;
     return c ? [...c.querySelectorAll(".tabbrowser-tab")].filter(t => !t.hasAttribute("zen-empty-tab")).map(t => {
       const page = ctx.pages.forTab(t);
       return page ? [page.spaceId, page.label] : [null, ctx.pages.tabId(t)];
     }) : null;`
  );

test("two tasks share one Agents Space, which goes once both finish", async () => {
  const workspaces = await workspaceCount();
  const before = await h.view();
  const a = await h.space("agents A");
  const b = await h.space("agents B");
  assert.equal(await workspaceCount(), workspaces + 1, "one workspace for both tasks");
  assert.deepEqual(await agentsSpace(), { name: "Agents", exists: true, zenName: "Agents", tabs: 2 });
  const uuid = await agentsUuid();
  assert.equal(await homeOf(a, "p1"), uuid);
  assert.equal(await homeOf(b, "p1"), uuid);

  // A task's first tab goes at the bottom, its next ones after its last.
  assert.deepEqual(await strip(), [
    [a, "p1"],
    [b, "p1"],
  ]);
  await h.call("pages.new", { space: a });
  assert.deepEqual(await strip(), [
    [a, "p1"],
    [a, "p2"],
    [b, "p1"],
  ]);
  // Each task lists its own tabs only, and the Space itself isn't a task.
  assert.deepEqual(await tabsOf(a), [
    ["p1", "agent"],
    ["p2", "agent"],
  ]);
  assert.deepEqual(await tabsOf(b), [["p1", "agent"]]);
  const names = (await listed()).map(s => s.name);
  assert.ok(names.some(n => n.startsWith("agents A")) && names.some(n => n.startsWith("agents B")));
  // By its uuid, not its name: a Space the user named Agents is listed.
  assert.equal(
    await h.chrome(`return ctx.spaces.peekUuid(ctx.spaces.agentsSpace.uuid)?.id ?? null;`),
    null,
    "the Agents Space has no record, so it isn't listed"
  );

  const receipt = await h.call("spaces.finish", { space: a, keep: [] });
  assert.equal(receipt.closedSpace, true);
  assert.deepEqual(await agentsSpace(), { name: "Agents", exists: true, zenName: "Agents", tabs: 1 });
  await h.call("spaces.finish", { space: b, keep: [] });
  assert.equal((await agentsSpace()).exists, false, "the empty Agents Space goes");
  assert.equal(await workspaceCount(), workspaces);
  assert.deepEqual(await h.view(), before, "I1: the user's view changed");
});

test("a task's name is unique among tasks", async () => {
  const name = h.unique("agents same name");
  const id = (await h.call("spaces.create", { name })).id;
  await assert.rejects(h.call("spaces.create", { name }), {
    code: "ZEN_TASK_SPACE_NAME_IN_USE",
    data: { spaceId: id, ownership: "agent" },
  });
  await h.call("spaces.finish", { space: id, keep: [] });
});

test("the Agents Space gets the name the user gave it back when it returns", async () => {
  const a = await h.space("agents renamed");
  await renameAgentsSpace("Robots");
  await h.call("spaces.finish", { space: a, keep: [] });
  assert.equal((await agentsSpace()).exists, false);
  const b = await h.space("agents renamed again");
  assert.deepEqual(await agentsSpace(), { name: "Robots", exists: true, zenName: "Robots", tabs: 1 });
  await h.call("spaces.finish", { space: b, keep: [] });
});

test("finish keeps pages for the user; the task stays listed until they close", async () => {
  const space = await h.space("agents keep");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  await h.call("pages.new", { space });
  const receipt = await h.call("spaces.finish", { space, keep: ["p1"] });
  assert.equal(receipt.closedSpace, false);
  assert.deepEqual(receipt.closedManagedLabels, ["p2"]);
  assert.equal((await listed()).find(s => s.id === space)?.ownership, "user");
  await assert.rejects(h.call("tabs.list", { space }), { code: "ZEN_TASK_SPACE_INACTIVE" });
  const tabs = await taskTabs(space);
  assert.deepEqual(
    tabs.map(t => [t.label, t.openedBy]),
    [[null, "agent"]],
    "the kept page is the task's tab, unmanaged"
  );
  assert.deepEqual(
    await marks(space, { tab: tabs[0].id }),
    { value: { v: 1, task: space, openedBy: "agent" }, tag: null },
    "still the task's for a restart, without the agent's tag"
  );
  assert.equal((await agentsSpace()).tabs, 1);

  await userCloses(space, tabs[0].id);
  await h.until(async () => !(await listed()).some(s => s.id === space));
  await h.until(async () => !(await agentsSpace()).exists);
});

test("a page carries its task, label and opener in a session value, and zen-ux's tag", async () => {
  const space = await h.space("agents values");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  assert.deepEqual(await marks(space, { page: "p1" }), {
    value: { v: 1, task: space, openedBy: "agent", label: "p1" },
    tag: String(space),
  });
  await h.call("page.evaluate", {
    space,
    page: "p1",
    isFunction: false,
    fn: `(document.body.innerHTML = '<button id="go" style="display:block;height:30px" onclick="window.open(\\'/api/text?via=popup\\')">go</button>', true)`,
  });
  await h.agentClick(space, "p1", "#go");
  await h.until(async () => (await h.call("pages.list", { space })).some(p => p.label === "p2"));
  assert.deepEqual(await marks(space, { page: "p2" }), {
    value: { v: 1, task: space, openedBy: "agent", label: "p2", opener: "p1" },
    tag: String(space),
  });

  // The blank tab the last page.close() leaves is the task's, unlabeled.
  await h.call("pages.close", { space, page: "p2" });
  await h.call("pages.close", { space, page: "p1" });
  const [blank] = await taskTabs(space);
  assert.equal(blank.openedBy, "agent");
  assert.deepEqual(await marks(space, { tab: blank.id }), {
    value: { v: 1, task: space, openedBy: "agent" },
    tag: null,
  });
  assert.equal((await h.call("spaces.finish", { space, keep: [] })).closedSpace, true);
});

test("a tab the user opens from a task's page joins the task as theirs", async () => {
  const space = await h.space("agents user tab");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  await h.call("spaces.handOff", { space });
  // The user's middle-click: tabbrowser's addTab with the page as opener,
  // as ClickHandlerParent calls it.
  const tab = await h.chrome(
    `const t = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.peek(arg.space), "p1"));
     const added = t.ownerDocument.defaultView.gBrowser.addTab(arg.url, {
       openerBrowser: t.linkedBrowser, relatedToCurrent: true, inBackground: true,
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
     });
     return ctx.pages.tabId(added);`,
    { space, url: url("/api/text?opened=by-user") }
  );
  assert.deepEqual(
    (await taskTabs(space)).map(t => [t.label, t.openedBy]),
    [
      ["p1", "agent"],
      [null, "user"],
    ]
  );
  assert.deepEqual(await marks(space, { tab }), { value: { v: 1, task: space, openedBy: "user" }, tag: null });
  await h.call("spaces.takeOver", { space });
  assert.deepEqual(await tabsOf(space), [
    ["p1", "agent"],
    [null, "user"],
  ]);
  const receipt = await h.call("spaces.finish", { space, keep: [] });
  assert.equal(receipt.closedSpace, false, "the user's tab stays");
  assert.equal(receipt.protectedTabCount, 1);
});

test("a kept tab the agent adopts after a claim is a page again, with the tag", async () => {
  const space = await h.space("agents claim kept");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  await h.call("spaces.finish", { space, keep: ["p1"] });
  await h.claim(space);
  const [kept] = await h.call("tabs.list", { space });
  assert.equal(kept.label, undefined);
  const { label } = await h.call("pages.adopt", { space, tab: kept.tab });
  assert.deepEqual(await marks(space, { page: label }), {
    value: { v: 1, task: space, openedBy: "agent", label },
    tag: String(space),
  });
});

test("the user closing a task's last tab ends it, as the panel's Stop", async () => {
  const space = await h.space("agents last tab");
  const [{ tab }] = await h.call("tabs.list", { space });
  await userCloses(space, tab);
  await h.until(async () => (await listed()).find(s => s.id === space)?.ownership === "user");
  await assert.rejects(h.call("pages.new", { space }), { code: "ZEN_TASK_SPACE_INACTIVE" });
  await h.remove(space);
});

test("while the window shows a short Agents Space, a new page goes below the user's tab, then joins its task", async () => {
  const a = await h.space("agents shown A");
  const b = await h.space("agents shown B");
  const before = await h.view();
  const home = await h.chrome(`return win.gZenWorkspaces.activeWorkspace`);
  // Where the user's tab sits in the Space's tab list, less the strip's
  // scroll: what an agent change can move. Not its screen position: after
  // the user's switch, Zen shows the pinned section's separator (22 px, then
  // a 2 px padding-top transition on zen-workspace), which under load starts
  // up to 300 ms late, and a reading caught it midway (224 against 224.67).
  // Read once the window's animations end and the place holds for 3 frames.
  const top = ref =>
    h.chrome(
      `const tab = ctx.resolvePage(arg).tab;
       const space = win.gZenWorkspaces.workspaceElement(tab.getAttribute("zen-workspace-id"));
       const place = () =>
         tab.getBoundingClientRect().top - space.tabsContainer.getBoundingClientRect().top - space.scrollbox.scrollPosition;
       const frame = () => new Promise(r => win.requestAnimationFrame(() => r()));
       // Finite ones only: zen-ux's tag pulses while a task works.
       const ending = win.document
         .getAnimations()
         .filter(a => Number.isFinite(a.effect?.getComputedTiming?.().endTime));
       await Promise.race([
         Promise.all(ending.map(a => a.finished.catch(() => {}))),
         new Promise(r => win.setTimeout(r, 2000)),
       ]);
       const deadline = win.performance.now() + 2000;
       let last = null;
       let still = 0;
       while (still < 3 && win.performance.now() < deadline) {
         await frame();
         const now = place();
         still = now === last ? still + 1 : 0;
         last = now;
       }
       return last;`,
      ref
    );
  // A row is 40 px; under 1 px is no move the user can see.
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 1, `${message}: ${actual} px, was ${expected} px`);
  try {
    // The user opens the Agents Space and selects B's tab.
    await h.chrome(
      `await win.gZenWorkspaces.changeWorkspaceWithID(ctx.spaces.agentsSpace.uuid);
       win.gBrowser.selectedTab = ctx.resolvePage(arg).tab;
       return true`,
      { space: b, page: "p1" }
    );
    assert.equal(
      await h.chrome(`return win.gZenWorkspaces.workspaceElement(ctx.spaces.agentsSpace.uuid).overflows`),
      false,
      "the strip is short"
    );
    const y = await top({ space: b, page: "p1" });
    await h.call("pages.new", { space: a });
    assert.deepEqual(await strip(), [
      [a, "p1"],
      [b, "p1"],
      [a, "p2"],
    ]);
    near(await top({ space: b, page: "p1" }), y, "the user's tab moved");
    await new Promise(r => setTimeout(r, 300));
    near(await top({ space: b, page: "p1" }), y, "the user's tab moved later");
  } finally {
    await h.chrome(`await win.gZenWorkspaces.changeWorkspaceWithID(arg); return true`, home);
  }
  await h.until(async () => JSON.stringify(await strip()) === JSON.stringify([[a, "p1"], [a, "p2"], [b, "p1"]]));
  await h.call("spaces.finish", { space: a, keep: [] });
  await h.call("spaces.finish", { space: b, keep: [] });
  assert.deepEqual(await h.view(), before, "I1: the user's view changed");
});

test("a popup from a task's page joins that task, in the Agents Space", async () => {
  const a = await h.space("agents popups");
  const b = await h.space("agents bystander");
  await h.call("page.goto", { space: a, page: "p1", url: url("/api/text") });
  await h.call("page.evaluate", {
    space: a,
    page: "p1",
    isFunction: false,
    fn: `(document.body.innerHTML = '<button id="go" style="display:block;height:30px" onclick="window.open(\\'/api/text?via=popup\\')">go</button>', true)`,
  });
  await h.agentClick(a, "p1", "#go");
  await h.until(async () => (await h.call("pages.list", { space: a })).some(p => p.label === "p2"));
  assert.equal(await homeOf(a, "p2"), await agentsUuid());
  assert.deepEqual(await strip(), [
    [a, "p1"],
    [a, "p2"],
    [b, "p1"],
  ]);
  assert.deepEqual(
    (await h.call("pages.list", { space: a })).map(p => [p.label, p.opener]),
    [
      ["p1", null],
      ["p2", "p1"],
    ]
  );
  assert.deepEqual(await tabsOf(b), [["p1", "agent"]]);
  await h.call("spaces.finish", { space: a, keep: [] });
  await h.call("spaces.finish", { space: b, keep: [] });
});

test("pages.close of a tab the user sees waits until they leave it", async () => {
  const space = await h.space("agents waiting close");
  await h.call("pages.new", { space });
  const home = await activeWorkspace();
  const before = await h.view();
  const p2 = await pageTab(space, "p2");
  try {
    await userViews(space, "p2");
    const shown = await h.view();
    let receipt;
    const closing = await recording("tabClosing", async () => {
      receipt = await h.call("pages.close", { space, page: "p2" });
    });
    assert.deepEqual(receipt, { ok: true, deferred: true });
    assert.deepEqual(closing, [{ space, tab: p2 }], "zen-ux's pill hears of it");
    assert.deepEqual(
      (await h.call("pages.list", { space })).map(p => p.label),
      ["p1"],
      "the page ended for the agent at once"
    );
    assert.deepEqual(await h.view(), shown, "I1: the user's tab stays selected");
    assert.deepEqual(await tabState(p2), {
      open: true,
      selected: true,
      tag: null,
      value: { v: 1, task: space, openedBy: "agent", closing: true },
      waits: true,
    });
    // The user picks another tab: the waiting one closes.
    await h.chrome(`win.gBrowser.selectedTab = ctx.resolvePage(arg).tab; return true`, { space, page: "p1" });
    await h.until(async () => !(await tabState(p2)).open);
  } finally {
    await userGoesTo(home);
  }
  await h.call("spaces.finish", { space, keep: [] });
  assert.deepEqual(await h.view(), before, "I1: the user's view changed");
});

test("finish with a tab the user sees: it waits, and the Space goes once they leave", async () => {
  const space = await h.space("agents finish shown");
  const home = await activeWorkspace();
  const before = await h.view();
  const p1 = await pageTab(space, "p1");
  try {
    await userViews(space, "p1");
    const shown = await h.view();
    const receipt = await h.call("spaces.finish", { space, keep: [] });
    assert.equal(receipt.closedSpace, true);
    assert.deepEqual(receipt.closedManagedLabels, ["p1"]);
    assert.equal(receipt.pendingCloseCount, 1);
    assert.deepEqual(await h.view(), shown, "I1: the user's tab stays");
    assert.equal((await tabState(p1)).waits, true);
    assert.equal((await agentsSpace()).exists, true, "a Space a window shows is never emptied");
    await assert.rejects(h.call("pages.list", { space }), { code: "ZEN_TASK_SPACE_NOT_FOUND" });
  } finally {
    await userGoesTo(home);
  }
  await h.until(async () => !(await tabState(p1)).open);
  await h.until(async () => !(await agentsSpace()).exists);
  assert.deepEqual(await h.view(), before, "I1: the user's view changed");
});

test("the pill's Keep makes the waiting tab the user's; its Close closes it now", async () => {
  const space = await h.space("agents pill");
  await h.call("pages.new", { space });
  const home = await activeWorkspace();
  const p1 = await pageTab(space, "p1");
  const p2 = await pageTab(space, "p2");
  const tabOf = `${W} const t = [...W.allTabs()].find(x => ctx.pages.tabId(x) === arg);`;
  try {
    await userViews(space, "p2");
    assert.equal((await h.call("pages.close", { space, page: "p2" })).deferred, true);
    assert.equal(await h.chrome(`${tabOf} return ctx.service.keepDeferred(t)`, p2), true);
    assert.deepEqual(await tabState(p2), {
      open: true,
      selected: true,
      tag: null,
      value: { v: 1, task: space, openedBy: "user" },
      waits: false,
    });
    assert.deepEqual(
      (await taskTabs(space)).map(t => [t.label, t.openedBy]),
      [
        ["p1", "agent"],
        [null, "user"],
      ],
      "kept as a tab of user origin"
    );
    // The user leaves it: a kept tab stays.
    await h.chrome(`win.gBrowser.selectedTab = ctx.resolvePage(arg).tab; return true`, { space, page: "p1" });
    assert.equal((await h.call("pages.close", { space, page: "p1" })).deferred, true);
    assert.equal(await h.chrome(`${tabOf} return ctx.service.closeDeferred(t)`, p1), true);
    await h.until(async () => !(await tabState(p1)).open);
    assert.equal((await tabState(p2)).open, true);
  } finally {
    await userGoesTo(home);
  }
});

test("a task no client named for 72 hours closes when a client connects", async () => {
  const idle = await h.space("agents idle");
  const named = await h.space("agents named");
  const handed = await h.space("agents handed");
  await h.call("spaces.handOff", { space: handed });
  await h.call("spaces.takeOver", { space: handed });
  const mixed = await h.space("agents with a user tab");
  await h.chrome(
    `const rec = ctx.spaces.get(arg);
     ctx.pages.addUnmanaged(rec, ctx.pages.addTab(rec, win), "user");
     return true`,
    mixed
  );
  const age = ids =>
    h.chrome(`for (const id of arg) ctx.spaces.get(id).lastNamedAt = Date.now() - 73 * 3600e3; return true`, ids);
  const newClient = async () => (await connect(h.instance, { callTimeout: 30000 })).close();
  const ids = async () => (await h.call("spaces.list")).taskSpaces.map(s => s.id);

  await age([idle, handed, mixed]);
  await newClient();
  const left = await ids();
  assert.ok(!left.includes(idle), "the idle task closed");
  for (const id of [named, handed, mixed]) {
    assert.ok(left.includes(id), `task ${id} stays`);
  }

  // zenius.autoCloseHours 0 turns it off.
  await h.chrome(`Services.prefs.setIntPref("zenius.autoCloseHours", 0); return true`);
  try {
    await age([named]);
    await newClient();
    assert.ok((await ids()).includes(named));
  } finally {
    await h.chrome(`Services.prefs.clearUserPref("zenius.autoCloseHours"); return true`);
  }
});

test("an agent that claims one of the user's workspaces works there", async () => {
  const space = await h.userSpace("agents claimed", url("/api/text"));
  await h.claim(space);
  const { label } = await h.call("pages.new", { space });
  const home = await homeOf(space, label);
  assert.notEqual(home, await agentsUuid());
  assert.equal(
    home,
    await h.chrome(`return ctx.spaces.get(arg).uuid`, space),
    "the new page opens in the claimed workspace"
  );
  await h.remove(space);
});

test("finishing a claimed workspace never removes it, even with no tab of the user's left", async () => {
  const space = await h.userSpace("agents claimed finish", url("/api/text"));
  await h.claim(space);
  const [mine] = await h.call("tabs.list", { space });
  await h.call("pages.new", { space, url: url("/api/text?agent") });
  // The user closes their own tab: only the agent's page is left.
  await h.chrome(`win.gBrowser.removeTab(ctx.pages.findTab(ctx.spaces.get(arg.space), arg.tab)); return true`, {
    space,
    tab: mine.tab,
  });
  await h.until(async () => (await h.call("tabs.list", { space })).length === 1);
  const uuid = await h.chrome(`return ctx.spaces.get(arg).uuid`, space);
  const receipt = await h.call("spaces.finish", { space, keep: [] });
  assert.equal(receipt.closedSpace, false, "SPEC 3.4: finish() never removes the user's workspace");
  assert.equal(await h.chrome(`return !!win.gZenWorkspaces.getWorkspaceFromId(arg)`, uuid), true);
  assert.equal((await listed()).find(s => s.id === space)?.ownership, "user");
  await h.remove(space);
});

test("deleting the Agents Space ends its tasks", async () => {
  const space = await h.space("agents deleted");
  await h.chrome(`win.gZenWorkspaces.removeWorkspace(ctx.spaces.agentsSpace.uuid); return true`);
  await h.until(async () => (await listed()).find(s => s.id === space)?.ownership === "user");
  await assert.rejects(h.call("pages.new", { space }), { code: "ZEN_TASK_SPACE_INACTIVE" });
  assert.equal((await agentsSpace()).exists, false);
  await h.remove(space);
});

test("a task's front tab is its first page, then whichever the agent or the user made current last", async () => {
  const space = await h.space("agents front");
  const front = async () => (await h.call("pages.userPage", { space }))?.label ?? null;
  const active = async () => (await h.call("pages.list", { space })).filter(p => p.active).map(p => p.label);
  const home = await activeWorkspace();
  assert.equal(await front(), "p1", "a new task's first page");
  assert.deepEqual(await active(), ["p1"]);
  await h.assertNoPreemption(async () => {
    await h.call("page.goto", { space, page: "p1", url: url("/api/text?front1") });
    await h.call("pages.new", { space, url: url("/api/text?front2") });
    assert.equal(await front(), "p2", "a new page is the current one");
    await h.call("page.url", { space, page: "p1" });
    assert.equal(await front(), "p2", "a read leaves it");
    await h.call("page.evaluate", { space, page: "p1", fn: "1", isFunction: false });
    assert.equal(await front(), "p1", "an acting call makes its page current");
  });
  // The user looks at p2, then leaves: their selection came last.
  await userViews(space, "p2");
  assert.equal(await front(), "p2");
  await userGoesTo(home);
  assert.equal(await front(), "p2");
  // The agent acts on p1 while the user looks at p2: the user's page is what
  // they see, and once they leave, the agent's p1.
  await userViews(space, "p2");
  await h.call("page.evaluate", { space, page: "p1", fn: "1", isFunction: false });
  assert.equal(await front(), "p2", "a shown tab is the user's page");
  await userGoesTo(home);
  assert.equal(await front(), "p1");
  // The front tab closes: the task's first page again.
  await h.call("pages.close", { space, page: "p1" });
  assert.equal(await front(), "p2");
  assert.deepEqual(await active(), ["p2"]);
});

test("browser.health lists a marked Space other than the Agents Space, with its place in Zen's Space switcher", async () => {
  const t = await h.space("stray listed");
  const agents = await agentsUuid();
  // As a crash can leave one: zenius's mark, the same name, a tab.
  const stray = await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     const ws = await win.gZenWorkspaces.createAndSaveWorkspace("Agents", undefined, true, 0);
     ws.zenius = "agents-space";
     win.gZenWorkspaces.saveWorkspace(ws);
     W.addBackgroundTab(win, ws.uuid);
     return { uuid: ws.uuid, position: win.gZenWorkspaces.getWorkspaces().findIndex(s => s.uuid === ws.uuid) + 1 };`
  );
  h.madeSpaces.add(stray.uuid);
  const { strayAgentsSpaces } = await h.call("browser.health");
  assert.deepEqual(strayAgentsSpaces, [{ uuid: stray.uuid, name: "Agents", tabs: 1, position: stray.position }]);
  assert.ok(stray.position > 1);
  assert.ok(!strayAgentsSpaces.some(s => s.uuid === agents), "the Agents Space itself isn't listed");
  await h.call("spaces.finish", { space: t, keep: [] });
});
