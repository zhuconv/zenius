// After its task, a page can't open a window with an opener while its window
// group holds a document the agent's sandbox wrote into: zen-core refuses it
// (item 3 of the closed-groups plan, docs/research/user-tab-reach.md), and
// opens nothing in its place (a form posted into a new window, about:blank,
// blob:, data:, a feature popup refused on the Mac, and today every other).
// Under the user's decision (A) nothing shows: when the user's own click or
// key there came just before, the pages with the writes load afresh,
// quietly (zen-core's cleanLoad), this page or the group's others, so the
// next try opens. One the page opened on its own, one a plain tab opened
// instead (reopened), or one refused during a hold changes nothing.
// zen-core's hook, noteOpenRefused, stands in for its refusals here, a
// reload for zen-core's cleanLoad, and a stand-in for zen-observe's
// isWritten; tests/core has the refusals themselves.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
let userView;
const run = Date.now().toString(36).slice(-5);

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
});

after(async () => {
  await h?.chrome(`const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI; UI.cleanLoad = null; UI.isWritten = null; return true;`).catch(() => {});
  await h?.close();
});

// Chrome-side helpers: pages by browserId, the cards that once showed, the
// announcer, and zen-core's hook.
const K = `
  const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
  const Win = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
  const UIM = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
  const UI = UIM.ZeniusUI;
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 5000) => {
    for (const end = Date.now() + ms; !(await fn()); ) {
      if (Date.now() > end) throw new Error("timed out waiting for " + fn);
      await sleep(25);
    }
  };
  const tabOf = bid => [...Win.uniqueTabs()].find(t => t.linkedBrowser?.browserId === bid) ?? null;
  const read = (bid, id) => {
    const el = N.noticeElement(tabOf(bid), id);
    return el ? { text: N.noticeText(tabOf(bid), id), note: el.querySelector(".zenius-card-note")?.textContent ?? null, buttons: [...el.querySelectorAll("button")].map(b => b.textContent) } : null;
  };
  const kept = bid => read(bid, "zenius-kept-code");
  const windows = bid => read(bid, "zenius-no-windows");
  const docOf = bid => tabOf(bid)?.linkedBrowser.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0;
  const refuse = (bid, url, reopened = false) => Win.noteOpenRefused({ browser: tabOf(bid).linkedBrowser, url, reopened });
  // zen-observe's flag, standing in: these pages' current documents hold
  // the agent's writes, and lose them with a new document.
  const writtenDocs = new Set();
  const writeInto = bid => writtenDocs.add(docOf(bid));
  UI.isWritten = target => writtenDocs.has(target?.browsingContext?.currentWindowGlobal?.innerWindowId ?? target?.currentWindowGlobal?.innerWindowId ?? -1);
  // The user's own click in the page in view, through the parent as the
  // OS's would: what a quiet reload follows.
  const userClick = async bid => {
    const b = tabOf(bid).linkedBrowser;
    const r = b.getBoundingClientRect();
    for (const type of ["mousedown", "mouseup"]) {
      b.ownerDocument.defaultView.synthesizeMouseEvent(type, r.x + 5, r.y + 5, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
    }
    await sleep(100);
  };
  // zen-core's cleanLoad, standing in: a reload.
  const calls = [];
  UI.cleanLoad = async browser => {
    calls.push(browser.browserId);
    browser.reload();
    return { how: "reload", newGroup: false };
  };
  // Firefox's announcer; announcements go out a moment after the first.
  const announcer = win.document.getElementById("a11y-announcement");
  const hush = async () => {
    await UIM.announcementsOut(win);
    announcer?.replaceChildren();
  };
  const heard = async () => {
    await UIM.announcementsOut(win);
    return announcer?.firstChild?.getAttribute("aria-label") ?? null;
  };
`;

/** A task with a page on `url`, p1. */
async function task(name, url) {
  const { id: space } = await h.createSpace({ name: `zen-ux nowin ${name} ${run}` });
  await h.call("page.goto", { space, page: "p1", url });
  const p1 = await h.chrome(`return ctx.resolvePage({ space: ${space}, page: "p1" }).browser.browserId;`);
  return { space, name: `zen-ux nowin ${name} ${run}`, p1 };
}

const view = bid =>
  h.chrome(`${K}
    const t = tabOf(${bid});
    Pages.landOn(t);
    await gZenWorkspaces.changeWorkspaceWithID(t.getAttribute("zen-workspace-id"));
    await until(() => gBrowser.selectedTab === t);
    return true;
  `);
const backToUser = () =>
  h.chrome(`
    if (gZenWorkspaces.activeWorkspace !== ${JSON.stringify(userView.windows[0].activeWorkspace)}) await gZenWorkspaces.changeWorkspaceWithID(${JSON.stringify(userView.windows[0].activeWorkspace)});
    return true;
  `);
const closeTabs = bids =>
  h.chrome(`${K}
    for (const bid of ${JSON.stringify(bids)}) {
      const t = tabOf(bid);
      if (t) t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
    }
    return true;
  `);

async function waitFor(fn, ms = 10000) {
  for (const end = Date.now() + ms; !(await fn()); ) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${fn}`);
    }
    await new Promise(r => setTimeout(r, 50));
  }
}

test("a kept page with the agent's writes that couldn't open a window the user asked for loads afresh, quietly, and shows nothing; with no input of the user's just before, a window opened in a plain tab instead, or one refused during a hold, nothing happens", async () => {
  const t = await task("own", `${h.base}/zoo/forms.html`);
  try {
    await h.call("page.evaluate", { space: t.space, page: "p1", fn: "() => document.title", isFunction: true });
    await view(t.p1);
    await h.call("spaces.finish", { space: t.space, keep: ["p1"] });
    const out = await h.chrome(`${K}
      await sleep(200);
      writeInto(${t.p1});
      const res = {};
      // The page opened it on its own: no click or key of the user's.
      refuse(${t.p1}, "");
      await sleep(300);
      res.unasked = calls.length;
      await hush();
      await userClick(${t.p1});
      refuse(${t.p1}, ${JSON.stringify(`${h.base}/api/text?plain`)}, true);
      UI.openRefused({ browser: tabOf(${t.p1}).linkedBrowser, url: "", hold: true });
      await sleep(300);
      res.ignored = calls.length;
      const doc = docOf(${t.p1});
      refuse(${t.p1}, "");
      await until(() => docOf(${t.p1}) !== doc && !tabOf(${t.p1}).linkedBrowser.webProgress.isLoadingDocument);
      res.reloaded = { calls: calls.slice(), kept: kept(${t.p1}), windows: windows(${t.p1}), heard: await heard() };
      // Its new document holds none of the agent's writes: nothing more.
      await userClick(${t.p1});
      refuse(${t.p1}, "");
      await sleep(300);
      res.after = calls.length;
      return res;
    `);
    assert.equal(out.unasked, 0, "an open with no input of the user's");
    assert.equal(out.ignored, 0, "an open a plain tab opened instead, and one refused during a hold");
    assert.deepEqual(out.reloaded, { calls: [t.p1], kept: null, windows: null, heard: null });
    assert.equal(out.after, 1);
  } finally {
    await closeTabs([t.p1]);
    await backToUser();
  }
});

test("a page linked to a kept page with the agent's writes, with none itself: when the user's window is refused, that page loads afresh, quietly, so the next try opens; neither shows anything", async () => {
  const t = await task("linked", `${h.base}/api/text?opener`);
  const other = h.base.replace("127.0.0.1", "localhost");
  let p2 = 0;
  try {
    // The agent's code in p1 (127.0.0.1); its popup, on another site, runs none.
    const onclick = `window.open('${other}/api/text?linked')`;
    await h.call("page.evaluate", {
      space: t.space,
      page: "p1",
      isFunction: false,
      fn: `(document.title = "Checkout", document.body.innerHTML = ${JSON.stringify(`<button id="go" style="display:block;width:200px;height:30px" onclick="${onclick}">go</button>`)}, true)`,
    });
    // The agent's own click: a synthesized one would be the user's press,
    // which waits for a clean copy of a written page.
    await h.call("page.click", { space: t.space, page: "p1", target: "#go" });
    await waitFor(async () => (await h.call("pages.list", { space: t.space })).some(p => p.label === "p2" && p.url.endsWith("?linked")));
    await h.call("page.waitForLoadState", { space: t.space, page: "p2", state: "load", options: {} });
    p2 = await h.chrome(`return ctx.resolvePage({ space: ${t.space}, page: "p2" }).browser.browserId;`);
    await view(p2);
    // zen-core's quiet loads off: the written p1 isn't reloaded at the
    // task's end, as when that reload fails (zen-core's closed-groups tests
    // do the same), so it still holds the agent's writes.
    await h.chrome(`Services.prefs.setBoolPref("zenius.handoff.quietReload", false); return true;`);
    await h.call("spaces.finish", { space: t.space, keep: ["p1", "p2"] });
    const out = await h.chrome(`${K}
      writeInto(${t.p1});
      await sleep(200);
      const group = bid => tabOf(bid).linkedBrowser.browsingContext.group.getToplevels().map(top => top.browserId).sort();
      const res = { sameGroup: group(${p2}).join() === group(${t.p1}).join() && group(${p2}).length === 2 };
      refuse(${p2}, "");
      await sleep(300);
      res.unasked = calls.length;
      await hush();
      await userClick(${p2});
      const doc = docOf(${t.p1});
      refuse(${p2}, "");
      await until(() => docOf(${t.p1}) !== doc);
      res.reloaded = { calls: calls.slice(), p1: { kept: kept(${t.p1}), windows: windows(${t.p1}) }, p2: { kept: kept(${p2}), windows: windows(${p2}) }, heard: await heard() };
      await until(() => !tabOf(${t.p1}).linkedBrowser.webProgress.isLoadingDocument);
      await userClick(${p2});
      refuse(${p2}, "");
      await sleep(300);
      res.after = calls.length;
      return res;
    `);
    assert.equal(out.sameGroup, true, "p2 shares p1's window group");
    assert.equal(out.unasked, 0, "an open with no input of the user's");
    assert.deepEqual(out.reloaded, { calls: [t.p1], p1: { kept: null, windows: null }, p2: { kept: null, windows: null }, heard: null });
    assert.equal(out.after, 1, "p1 loaded afresh: nothing keeps p2 from opening windows");
  } finally {
    await h.chrome(`Services.prefs.clearUserPref("zenius.handoff.quietReload"); return true;`).catch(() => {});
    await closeTabs([t.p1, p2].filter(Boolean));
    await backToUser();
  }
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
});
