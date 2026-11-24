// A tab the user makes from a task's tab is the user's (SPI "Which tabs are
// a task's"). Firefox copies a tab's session values into the tabs made from
// it, Duplicate Tab and Reopen Closed Tab among them: such a tab loses the
// task's value as it restores. A task's value names the sync id of the tab
// it was written for, and the restart rebuild keeps it only on that tab.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
let home;
const dir = mkdtempSync(join(tmpdir(), "zenius-user-tabs-"));

before(async () => {
  h = await setup();
  home = await h.chrome(`return win.gZenWorkspaces.activeWorkspace`);
});
after(async () => {
  // No task left for the files after this one, which share this Zen.
  await h
    ?.chrome(
      `${C}
       for (const rec of ctx.spaces.records()) {
         if (rec.kind === "task" && !rec.gone) {
           for (const t of ctx.pages.tabsOf(rec)) ctx.pages.closeTab(t);
           ctx.spaces.remove(rec);
         }
       }
       // The user's now, as each tab at a u- URL: left, they would keep the
       // Agents Space for the files after this one.
       for (const t of tabsAt("/api/text?u-")) win.gBrowser.removeTab(t, { animate: false });
       // Reopen Closed Tab shows the Agents Space: the window shows the
       // user's again, as the files after this one expect.
       if (arg && win.gZenWorkspaces.activeWorkspace !== arg) await win.gZenWorkspaces.changeWorkspaceWithID(arg);
       // Saved with the session at the quit below, it would outlast the restart.
       Services.prefs.clearUserPref("zen.window-sync.enabled");
       return true;`,
      home
    )
    .catch(() => {});
  // Window sync only starts with Zen: the last test's Zen started without
  // it, so the files after this one get a Zen started with it.
  await h?.restart().catch(() => {});
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

const url = path => `${h.base}${path}`;
const C = `
  const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
  const value = t => { try { return JSON.parse(SessionStore.getCustomTabValue(t, "zenius") || "null"); } catch { return null; } };
  const tabOf = (space, label) => ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(space), label));
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 10000) => {
    for (const end = Date.now() + ms; !(await fn()); ) {
      if (Date.now() > end) return false;
      await sleep(25);
    }
    return true;
  };
  const shows = (t, part) => (t.linkedBrowser?.currentURI?.spec ?? "").includes(part);
  // The URL a tab's history is at: an unloaded tab's browser shows none.
  const at = t => { try { const s = JSON.parse(SessionStore.getTabState(t)); return s.entries?.[s.index - 1]?.url ?? ""; } catch { return ""; } };
  // Every tab, in every workspace, whose history is at a URL with this part.
  const tabsAt = part => [...new Set([...win.gBrowser.tabs, ...(win.gZenWorkspaces?.allStoredTabs ?? [])])].filter(t => !t.closing && at(t).includes(part));
`;

async function task(name, paths) {
  const space = await h.space(name);
  const labels = [];
  for (const path of paths) {
    const { label } = await h.call("pages.new", { space });
    await h.call("page.goto", { space, page: label, url: url(path) });
    labels.push(label);
  }
  return { space, labels };
}

/** The ids of a task's tabs, from tabs.list. */
const listed = async space => (await h.call("tabs.list", { space })).map(t => t.tab);

/** Quit Zen as the user does (it saves its session), then start it with these prefs. */
async function restart(prefs) {
  await h.chrome(`await ctx.service.flushState(); return true`);
  const file = join(dir, "prefs.js");
  writeFileSync(file, `${Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n")}\n`);
  process.env.ZENIUS_DEV_PREFS = file;
  try {
    await h.restart({});
  } finally {
    delete process.env.ZENIUS_DEV_PREFS;
  }
}

test("a task's page carries a value that names its tab's sync id, written before Zen gave the tab one", async () => {
  const a = await task("values name their tab", ["/api/text?own1"]);
  const out = await h.chrome(
    `${C}
     const t = tabOf(arg.space, arg.page);
     await until(() => value(t)?.sync === t.id);
     return { id: t.id, value: value(t) };`,
    { space: a.space, page: a.labels[0] }
  );
  assert.ok(out.id, "Zen gave the tab a sync id");
  assert.deepEqual(out.value, { v: 1, task: a.space, openedBy: "agent", label: a.labels[0], sync: out.id });
});

test("Duplicate Tab on a task's page makes a tab of the user's: no task value, no tag, not the task's", async () => {
  const a = await task("duplicate", ["/api/text?u-dup1"]);
  const out = await h.chrome(
    `${C}
     const t = tabOf(arg.space, arg.page);
     const dup = win.gBrowser.duplicateTab(t, true);
     const restored = await until(() => shows(dup, "u-dup1"));
     await sleep(200);
     return {
       restored,
       dup: value(dup),
       tag: dup.getAttribute("zenius-task"),
       dupPage: ctx.pages.forTab(dup)?.label ?? null,
       id: ctx.pages.tabId(dup),
       page: value(t)?.label ?? null,
     };`,
    { space: a.space, page: a.labels[0] }
  );
  assert.ok(out.restored, "the duplicate shows the page");
  assert.equal(out.dup, null, "Firefox's copy of the task's value is gone");
  assert.equal(out.tag, null);
  assert.equal(out.dupPage, null);
  assert.ok(!(await listed(a.space)).includes(out.id), "tabs.list leaves the duplicate out");
  assert.equal(out.page, a.labels[0], "the page keeps its own value");
});

test("Reopen Closed Tab on a page the user closed makes a tab of the user's: its label stays ended", async () => {
  const a = await task("reopen", ["/api/text?re1", "/api/text?u-re2"]);
  const out = await h.chrome(
    `${C}
     const t = tabOf(arg.space, arg.page);
     const closed = SessionStore.getClosedTabCountForWindow(win);
     win.gBrowser.removeTab(t, { animate: false });
     // Firefox keeps a closed tab for Reopen once its last state is in.
     await until(() => !t.isConnected && SessionStore.getClosedTabCountForWindow(win) > closed);
     const re = SessionStore.undoCloseTab(win, 0);
     const restored = await until(() => shows(re, "u-re2"));
     await sleep(200);
     return { restored, value: value(re), tag: re.getAttribute("zenius-task"), page: ctx.pages.forTab(re)?.label ?? null, id: ctx.pages.tabId(re) };`,
    { space: a.space, page: a.labels[1] }
  );
  assert.ok(out.restored, "the reopened tab shows the page");
  assert.equal(out.value, null, "Firefox's copy of the task's value is gone");
  assert.equal(out.tag, null);
  assert.equal(out.page, null);
  assert.ok(!(await h.call("pages.list", { space: a.space })).some(p => p.label === a.labels[1]), "the closed page's label stays ended");
  assert.ok(!(await listed(a.space)).includes(out.id), "tabs.list leaves the reopened tab out");
});

test("at a restart, a value counts only on the tab whose sync id it names; an older runtime's names none, so its task ends", async () => {
  const a = await task("restart own", ["/api/text?ra1", "/api/text?ra2"]);
  // A task tab that just a moment ago opened: its value names its sync id
  // once Zen gives it one.
  const { label: fresh } = await h.call("pages.new", { space: a.space });
  const b = await task("restart old value", ["/api/text?u-rb1"]);
  await h.chrome(
    `${C}
     const p1 = tabOf(arg.a, arg.p1);
     // Tabs of the user's that carry a task's value, as Firefox copies them:
     // one names p1's sync id, as a duplicate's would, one names none.
     for (const [part, v] of [
       ["u-copy", { ...value(p1), label: "p8" }],
       ["u-none", { v: 1, task: arg.a, label: "p9", openedBy: "agent" }],
     ]) {
       const t = win.gBrowser.addTab(arg.base + "/api/text?" + part, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       await until(() => shows(t, part));
       SessionStore.setCustomTabValue(t, "zenius", JSON.stringify(v));
     }
     // Values an older runtime wrote on every tab of task b: they name no sync id.
     for (const t of ctx.pages.tabsOf(ctx.spaces.get(arg.b))) {
       const old = value(t);
       delete old.sync;
       SessionStore.setCustomTabValue(t, "zenius", JSON.stringify(old));
     }
     return true;`,
    { a: a.space, p1: a.labels[0], b: b.space, base: h.base }
  );
  // Zen gives it its sync id from a queue of its own; its value follows.
  await h.until(() => h.chrome(`${C} return !!tabOf(arg.space, arg.page).id;`, { space: a.space, page: fresh }), 10000);

  const pages = (await h.call("pages.list", { space: a.space })).map(p => p.label).sort();
  assert.ok(pages.includes(fresh));

  await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": false });

  assert.deepEqual((await h.call("pages.list", { space: a.space })).map(p => p.label).sort(), pages, "the task's own pages come back");
  const users = await h.chrome(
    `${C}
     return ["u-copy", "u-none", "u-rb1"].map(part => {
       const found = tabsAt("/api/text?" + part);
       return found.length === 1 ? { part, value: value(found[0]), tag: found[0].getAttribute("zenius-task"), page: ctx.pages.forTab(found[0])?.label ?? null } : { part, found: found.length };
     });`
  );
  assert.deepEqual(users, [
    { part: "u-copy", value: null, tag: null, page: null },
    { part: "u-none", value: null, tag: null, page: null },
    { part: "u-rb1", value: null, tag: null, page: null },
  ]);
  await assert.rejects(h.call("pages.list", { space: b.space }), e => {
    assert.equal(e.code, "ZEN_TASK_SPACE_NOT_FOUND");
    assert.equal(e.data?.reason, "not_restored");
    return true;
  });
});

test("with window sync off, a tab still gets a sync id that a restart keeps, so its task comes back", async () => {
  await h.chrome(`Services.prefs.setBoolPref("zen.window-sync.enabled", false); return true;`);
  const a = await task("sync off", ["/api/text?so1"]);
  const before = await h.chrome(
    `${C}
     const t = tabOf(arg.space, arg.page);
     await until(() => !!t.id && value(t)?.sync === t.id);
     return { id: t.id, sync: value(t)?.sync ?? null };`,
    { space: a.space, page: a.labels[0] }
  );
  assert.ok(before.id, "Zen gave the tab a sync id with window sync off");
  assert.equal(before.sync, before.id);
  const pages = (await h.call("pages.list", { space: a.space })).map(p => p.label).sort();

  await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": false, "zen.window-sync.enabled": false });

  assert.deepEqual((await h.call("pages.list", { space: a.space })).map(p => p.label).sort(), pages);
  const afterId = await h.chrome(`${C} return tabOf(arg.space, arg.page)?.id ?? null;`, { space: a.space, page: a.labels[0] });
  assert.equal(afterId, before.id, "the restart kept the tab's sync id");
});
