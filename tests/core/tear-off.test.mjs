// A task's tab torn off into a new window (Move to New Window, or a drag out
// of the strip), with window sync on and two windows. The torn-off tab is a
// new element in a new window, and Zen closes the tab's copies in the other
// windows. If the page's document went with it, the page stays the task's
// there, guarded, as a tab moved to another window does, and a hand-off
// still loads it afresh when the agent's code left something in it. If it
// didn't, the page ends, and the new window's tab is the user's.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const dir = mkdtempSync(join(tmpdir(), "zenius-tear-off-"));

let h;
let home;
/** The tasks this file starts, which it finishes at the end. */
const spaces = [];
before(async () => {
  h = await setup();
  home = await h.chrome(`return win.gZenWorkspaces.activeWorkspace`);
  await openWindow();
});
after(async () => {
  for (const space of spaces) {
    await h?.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "agent", { source: "user" }); return true;`, space).catch(() => {});
    await h?.call("spaces.finish", { space, keep: [] }).catch(() => {});
  }
  // The files after this one share this Zen: one window, showing the Space it showed.
  await h
    ?.chrome(
      `${W}
       for (const w of wins().slice(1)) w.close();
       await focus(0);
       if (arg && win.gZenWorkspaces.activeWorkspace !== arg) await win.gZenWorkspaces.changeWorkspaceWithID(arg);
       return true;`,
      home
    )
    .catch(() => {});
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

const W = `
  const Win = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const { AGENT_BROWSERS_KEY } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/guards.sys.mjs");
  const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
  const wins = () => [...Services.wm.getEnumerator("navigator:browser")];
  const wid = w => w?.docShell?.outerWindowID ?? null;
  const nth = n => wins()[n];
  const nOf = tab => wins().findIndex(w => wid(w) === wid(tab.ownerDocument.defaultView));
  const recOf = space => ctx.spaces.get(space);
  const pageOf = (space, label) => ctx.pages.peek(space, label);
  const liveOf = (space, label) => ctx.pages.tabFor(pageOf(space, label));
  const { setTimeout: later } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const sleep = ms => new Promise(r => later(r, ms));
  const until = async (fn, ms = 10000) => {
    for (const end = Date.now() + ms; !(await fn()); ) {
      if (Date.now() > end) throw new Error("timed out: " + fn);
      await sleep(25);
    }
  };
  const focus = async n => {
    nth(n).focus();
    await until(() => wid(Services.focus.activeWindow) === wid(nth(n)));
  };
  const value = t => { try { return JSON.parse(SessionStore.getCustomTabValue(t, "zenius") || "null"); } catch { return null; } };
  const agentSet = () => [...(Services.ppmm.sharedData.get(AGENT_BROWSERS_KEY) ?? [])];
  // Tear a tab off into a new window, and wait until Zen has closed its
  // copies in the other windows.
  const tearOff = async tab => {
    const n = wins().length;
    const sync = Win.syncId(tab);
    tab.ownerDocument.defaultView.gBrowser.replaceTabWithWindow(tab);
    await until(() => wins().length > n);
    const w = wins().at(-1);
    await until(() => w.gBrowser?.tabs?.length > 0 && w.document.readyState === "complete");
    await until(() => !wins().slice(0, n).some(x => [...x.gBrowser.tabs].some(t => !t.closing && Win.syncId(t) === sync)));
    await sleep(500);
    return w;
  };
`;

async function openWindow() {
  return h.chrome(
    `${W}
     const first = nth(0);
     const w = first.OpenBrowserWindow();
     await new Promise(r => w.addEventListener("load", r, { once: true }));
     await w.delayedStartupPromise;
     await w.gZenWorkspaces.promiseInitialized;
     await until(() => w.gZenWorkspaces.allStoredTabs.length >= first.gZenWorkspaces.allStoredTabs.length, 30000);
     await focus(0);
     return wins().length;`
  );
}

/** A task with pages on these paths, made while the first window is the most recent one. */
async function task(name, paths) {
  await h.chrome(`${W} await focus(0); return true;`);
  const space = await h.space(name);
  spaces.push(space);
  const labels = [];
  for (const path of paths) {
    const { label } = await h.call("pages.new", { space });
    await h.call("page.goto", { space, page: label, url: `${h.base}${path}` });
    labels.push(label);
  }
  // Each page has its copy in the second window.
  await h.chrome(`${W} await until(() => arg.labels.every(l => Win.copyIn(liveOf(arg.space, l), nth(1)))); return true;`, { space, labels });
  return { space, labels };
}

/** Close the windows after the first two, and focus the first. */
const closeNewWindows = () => h.chrome(`${W} for (const w of wins().slice(2)) w.close(); await focus(0); return true;`);

test("Move to New Window on a task's page: the page stays the task's in the new window, guarded, and the agent still drives it", async () => {
  const { space, labels } = await task("tear off the page", ["/api/text?to-live1"]);
  try {
    const out = await h.chrome(
      `${W}
       const t = liveOf(arg.space, arg.page);
       const before = { bc: t.linkedBrowser.browsingContext.id, bid: t.linkedBrowser.browserId };
       const w = await tearOff(t);
       const page = pageOf(arg.space, arg.page);
       const now = page ? ctx.pages.tabFor(page) : null;
       return {
         page: !!page,
         inNewWindow: !!now && nOf(now) === wins().length - 1,
         sameDocument: now?.linkedBrowser?.browsingContext?.id === before.bc,
         label: value(now)?.label ?? null,
         valueNamesItsTab: !!now && value(now)?.sync === Win.syncId(now),
         tag: now?.getAttribute("zenius-task") ?? null,
         guarded: agentSet().includes(now?.linkedBrowser?.browserId ?? before.bid),
         // What Take over and the hold card ask of a tab.
         control: ctx.service.lookup(now)?.page?.label ?? null,
       };`,
      { space, page: labels[0] }
    );
    assert.deepEqual(out, {
      page: true,
      inNewWindow: true,
      sameDocument: true,
      label: labels[0],
      valueNamesItsTab: true,
      tag: String(space),
      guarded: true,
      control: labels[0],
    });
    assert.ok((await h.call("pages.list", { space })).some(p => p.label === labels[0]), "pages.list still has it");
    const evaluated = await h.call("page.evaluate", { space, page: labels[0], fn: "location.search", isFunction: false });
    assert.match(JSON.stringify(evaluated), /to-live1/, "the agent still drives the page");
  } finally {
    await closeNewWindows();
  }
});

test("Move to New Window on another window's copy of a task's page: the page ends with the copies Zen closes, and the new window's tab is the user's", async () => {
  const { space, labels } = await task("tear off a copy", ["/api/text?to-copy1"]);
  try {
    const out = await h.chrome(
      `${W}
       const copy = Win.copyIn(liveOf(arg.space, arg.page), nth(1));
       const w = await tearOff(copy);
       return {
         page: !!pageOf(arg.space, arg.page),
         newTabs: [...w.gBrowser.tabs].map(t => ({ value: value(t), tag: t.getAttribute("zenius-task") })),
       };`,
      { space, page: labels[0] }
    );
    assert.equal(out.page, false, "Zen closed the page's live copy too");
    assert.ok(out.newTabs.length > 0);
    assert.deepEqual(out.newTabs, out.newTabs.map(() => ({ value: null, tag: null })), "the new window's tab carries no task value or tag");
    assert.ok(!(await h.call("pages.list", { space })).some(p => p.label === labels[0]));
  } finally {
    await closeNewWindows();
  }
});

test("a page torn off into a new window comes back after a restart, still the task's", async () => {
  const { space, labels } = await task("tear off and restart", ["/api/text?to-restart1"]);
  try {
    const sync = await h.chrome(
      `${W}
       await tearOff(liveOf(arg.space, arg.page));
       return Win.syncId(liveOf(arg.space, arg.page));`,
      { space, page: labels[0] }
    );
    // Zen gives the tab in a torn-off window no sync id, and keeps none for it.
    assert.equal(sync, null);
    await h.chrome(`await ctx.service.flushState(); return true`);
    const file = join(dir, "prefs.js");
    writeFileSync(file, 'user_pref("browser.startup.page", 3);\nuser_pref("zen.workspaces.continue-where-left-off", false);\n');
    process.env.ZENIUS_DEV_PREFS = file;
    try {
      await h.restart({});
    } finally {
      delete process.env.ZENIUS_DEV_PREFS;
    }
    assert.ok((await h.call("pages.list", { space })).some(p => p.label === labels[0]), "the page came back");
    const out = await h.chrome(
      `${W}
       const t = liveOf(arg.space, arg.page);
       return { tag: t.getAttribute("zenius-task"), valueNamesItsTab: value(t)?.sync === Win.syncId(t) };`,
      { space, page: labels[0] }
    );
    assert.deepEqual(out, { tag: String(space), valueNamesItsTab: true });
  } finally {
    await closeNewWindows();
  }
});

/**
 * Tear off a task's page the agent's code hooked (a style sheet outlives the
 * discard of its world: zen-observe's evidence), run `between`, hand off,
 * and return what the hand-off held and loaded afresh.
 */
async function tornHandOff(name, between) {
  const { space, labels } = await task(name, ["/api/text?" + name.replace(/\W+/g, "-")]);
  const [label] = labels;
  await h.call("page.evaluate", { space, page: label, isFunction: false, fn: `(document.head.append(document.createElement("style")), 1)` });
  const torn = await h.chrome(
    `${W} ${EV}
     const t = liveOf(arg.space, arg.page);
     const evidence = EV.evidenceOf(t.linkedBrowser);
     await tearOff(t);
     return { evidence, now: state(liveOf(arg.space, arg.page)) };`,
    { space, page: label }
  );
  assert.ok(torn.evidence.hooked, "the agent's code left the page hooked");
  assert.equal(torn.now.inNewWindow, true);
  assert.deepEqual(torn.now.evidence, torn.evidence, "the evidence went with the document");
  await between(space);
  const reply = await h.call("spaces.handOff", { space });
  const now = await h.chrome(`${W} ${EV} return state(liveOf(arg.space, arg.page));`, { space, page: label });
  return { label, reply, now, inner: torn.now.inner };
}

const EV = `const EV = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");
  const hold = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/hold.sys.mjs");
  const state = t => ({
    inNewWindow: nOf(t) === wins().length - 1,
    inner: t.linkedBrowser.browsingContext.currentWindowGlobal?.innerWindowId ?? 0,
    evidence: EV.evidenceOf(t.linkedBrowser),
    held: hold.holdOf(t.linkedBrowser) !== undefined,
  });`;

/** The hand-off held the torn-off page and loaded it afresh, clean. */
function heldAfresh({ label, reply, now, inner }) {
  assert.deepEqual(reply.reloaded, [label], "the hand-off loads the torn-off page afresh");
  assert.equal(now.inNewWindow, true);
  assert.equal(now.held, true, "the page the hand-off holds");
  assert.notEqual(now.inner, inner, "a new document");
  assert.deepEqual(now.evidence, {}, "with no evidence");
}

test("a hand-off after a tear-off holds the torn-off page the user sees, though the agent's last call was on another page, and loads it afresh", async () => {
  try {
    heldAfresh(
      await tornHandOff("tear off and hand off", async space => {
        // The agent's last call is on p1, in the Agents Space no window shows.
        await h.call("page.goto", { space, page: "p1", url: `${h.base}/api/text?to-front-p1` });
      })
    );
  } finally {
    await closeNewWindows();
  }
});

test("a hand-off after a tear-off, with a tab of the user's shown in the new window, holds the torn-off page, the agent's last", async () => {
  try {
    heldAfresh(
      await tornHandOff("tear off and look away", () =>
        h.chrome(
          `${W}
           const w = wins().at(-1);
           const t = w.gBrowser.addTab("about:blank", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
           w.gBrowser.selectedTab = t;
           await until(() => w.gBrowser.selectedTab === t);
           return true;`
        )
      )
    );
  } finally {
    await closeNewWindows();
  }
});
