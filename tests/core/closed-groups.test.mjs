// Closed groups (docs/research/user-tab-reach.md, "Fix: closed groups"): a
// document where the agent's code can run never shares a browsing context
// group with a window outside its task. zen-core's parts: the group check
// (pages.codeRefusal, which zen-observe's and zen-input's methods ask before
// running the agent's code), the refusal of a release that would split a
// group (the manager's decision 1), and the hook zen-ux's pill hears item 3's
// refusals on.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
  // A page's own window.open with no click, kept in the background so
  // nothing the user sees changes (I1).
  await h.chrome(
    `Services.prefs.setBoolPref("dom.disable_open_during_load", false);
     Services.prefs.setBoolPref("browser.tabs.loadDivertedInBackground", true);
     return true;`
  );
});
after(async () => {
  await h
    ?.chrome(
      `Services.prefs.clearUserPref("dom.disable_open_during_load");
       Services.prefs.clearUserPref("browser.tabs.loadDivertedInBackground");
       return true;`
    )
    .catch(() => {});
  await h?.close();
});

const url = path => `${h.base}${path}`;
const refusal = (space, label) =>
  h.chrome(`const s = ctx.spaces.get(arg.space); return ctx.pages.codeRefusal(s, ctx.pages.get(s, arg.label));`, {
    space,
    label,
  });
const tabWith = async (space, part) => {
  let found = null;
  await h.until(async () => (found = (await h.call("tabs.list", { space })).find(t => t.url.includes(part))), 10000);
  return found;
};
/** The page's own code opens `path` with an opener, in a tab no task holds (as a site's script would). */
const openFromTab = (space, part, path) =>
  h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     const tab = [...W.allTabs()].find(t => t.linkedBrowser.currentURI.spec.includes(arg.part));
     return ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", {
       code: "return String(!!window.open(" + JSON.stringify(arg.url) + "))",
       privileged: false,
     });`,
    { part, url: url(path) }
  );
/** The user's Space, with tab U that opened popup P (both the user's), claimed by the agent. */
async function userTabWithPopup(name) {
  const space = await h.userSpace(name, url(`/api/text?cg=U-${name.replace(/\W/g, "")}`));
  const tag = name.replace(/\W/g, "");
  assert.equal(await openFromTab(space, `cg=U-${tag}`, `/api/text?cg=P-${tag}`), "true");
  // Zen puts a page's popup in the window's current Space. The user moves
  // it next to its opener (its group stays).
  await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     const find = part => [...W.allTabs()].find(t => t.linkedBrowser.currentURI.spec.includes(part));
     const end = Date.now() + 10000;
     while (!find(arg.p) && Date.now() < end) await new Promise(r => win.setTimeout(r, 25));
     const u = find(arg.u);
     const p = find(arg.p);
     if (!p) throw new Error("the popup never opened");
     u.ownerDocument.defaultView.gZenWorkspaces.moveTabToWorkspace(p, u.getAttribute("zen-workspace-id"));
     return true;`,
    { u: `cg=U-${tag}`, p: `cg=P-${tag}` }
  );
  await h.claim(space);
  return { space, U: await tabWith(space, `cg=U-${tag}`), P: await tabWith(space, `cg=P-${tag}`) };
}

test("a page whose group holds the user's window runs no agent code, from its adoption on", async () => {
  const { space, U, P } = await userTabWithPopup("cg adopt");
  // P's opener, the user's U, is outside the task.
  await h.call("pages.adopt", { space, tab: P.tab, as: "pop" });
  assert.deepEqual(await refusal(space, "pop"), { reason: "group", windows: 1 });
  // With U in the task too, nothing in the group is outside: U may run code.
  await h.call("pages.adopt", { space, tab: U.tab, as: "u" });
  assert.equal(await refusal(space, "u"), null);
  // P stays refused while it's in the task: the check found the user's
  // window once.
  assert.deepEqual(await refusal(space, "pop"), { reason: "group", windows: 1 });
  await h.call("pages.release", { space, page: "u", group: true });
  await h.remove(space);
});

test("a tab at an add-on's page gets no answer and keeps nothing: its group holds the add-on's background page", async () => {
  const space = await h.userSpace("cg addon", "about:compat");
  try {
    await h.claim(space);
    const A = await tabWith(space, "about:compat");
    // The page joins its task (register() checks it) while its group holds
    // the webcompat add-on's background page, in the extension process.
    await h.call("pages.adopt", { space, tab: A.tab, as: "addon" });
    const where = () =>
      h.chrome(
        `const s = ctx.spaces.get(arg);
         const t = ctx.pages.tabFor(ctx.pages.get(s, "addon"));
         return [t.linkedBrowser.browsingContext.currentWindowGlobal?.domProcess?.remoteType ?? null, ctx.pages.outsideTask(s, t)];`,
        space
      );
    assert.deepEqual(await where(), ["extension", 1]);
    assert.equal(await refusal(space, "addon"), null);
    // The user loads a web page there: a group of its own, and no refusal
    // left from the add-on's page.
    await h.chrome(
      `const t = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), "addon"));
       t.linkedBrowser.fixupAndLoadURIString(arg.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       const end = Date.now() + 10000;
       const web = () => /^web/.test(t.linkedBrowser.browsingContext.currentWindowGlobal?.domProcess?.remoteType ?? "");
       while (!(t.linkedBrowser.currentURI.spec === arg.url && web()) && Date.now() < end) {
         await new Promise(r => win.setTimeout(r, 25));
       }
       return true;`,
      { space, url: url("/api/text?cg=A") }
    );
    const [remoteType, outside] = await where();
    assert.match(remoteType, /^web/);
    assert.equal(outside, 0);
    assert.equal(await refusal(space, "addon"), null);
  } finally {
    await h.remove(space).catch(() => {});
  }
});

test("the check at each call sees a window that left the task, and the refusal stays", async () => {
  const space = await h.space("cg call");
  /** Close the popup's tab, wherever it is now; whether it was open. */
  const closePopup = tab =>
    h.chrome(
      `const t = ctx.pages.findTab(ctx.spaces.get(arg.space), arg.tab);
       if (t) t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false, skipPermitUnload: true });
       return !!t;`,
      { space, tab }
    );
  let popup = null;
  try {
    const { label } = await h.call("pages.new", { space, url: url("/api/text?cg=T") });
    assert.equal(await refusal(space, label), null, "the agent's own page has a group of its own");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: `String(!!window.open("/api/text?cg=X"))` });
    await h.until(async () => (popup = (await h.call("pages.list", { space })).find(p => p.url.includes("cg=X"))), 10000);
    assert.equal(await refusal(space, label), null, "its popup is a page of the task");
    // As if the popup left the task with no release: nothing in zenius does
    // that today, so the test moves it out itself.
    await h.chrome(
      `const s = ctx.spaces.get(arg.space); const page = ctx.pages.get(s, arg.label); const tab = ctx.pages.tabFor(page);
       ctx.pages.remove(page); ctx.pages.addUnmanaged(s, tab, "user"); return true;`,
      { space, label: popup.label }
    );
    assert.deepEqual(await refusal(space, label), { reason: "group", windows: 1 });
    await closePopup(popup.tab);
    assert.deepEqual(await refusal(space, label), { reason: "group", windows: 1 }, "gone, but code may have run meanwhile");
  } finally {
    // The popup is a tab of the user's now: it would keep the Agents Space.
    if (popup) {
      await closePopup(popup.tab).catch(() => {});
    }
    await h.call("spaces.finish", { space, keep: [] }).catch(() => h.remove(space));
  }
});

test("a release that would split a group is refused; group: true hands over the whole group", async () => {
  const { space, U, P } = await userTabWithPopup("cg release");
  await h.call("pages.adopt", { space, tab: U.tab, as: "u" });
  await h.call("pages.adopt", { space, tab: P.tab, as: "pop" });
  await assert.rejects(h.call("pages.release", { space, page: "u" }), e => {
    assert.equal(e.code, "ZEN_PAGE_GROUP_SHARED");
    assert.deepEqual(e.details?.pages ?? e.data?.pages, ["pop"]);
    assert.match(e.message, /shares a window group with page pop of this task/);
    assert.match(e.message, /task\.release\("u", \{ group: true \}\)/);
    assert.match(e.message, /close it first/);
    assert.match(e.message, /task\.handOff\(\)/);
    return true;
  });
  assert.deepEqual((await h.call("pages.list", { space })).map(p => p.label).sort(), ["pop", "u"], "nothing released");
  const out = await h.call("pages.release", { space, page: "u", group: true });
  assert.equal(out.tab, U.tab);
  assert.deepEqual(
    out.released.map(r => [r.page, r.tab]),
    [
      ["u", U.tab],
      ["pop", P.tab],
    ]
  );
  assert.deepEqual(await h.call("pages.list", { space }), []);
  await h.remove(space);
});

test("a release goes through once the page's group mates are closed, and takes an agent-opened mate with group: true", async () => {
  const { space, U, P } = await userTabWithPopup("cg close first");
  await h.call("pages.adopt", { space, tab: U.tab, as: "u" });
  await h.call("pages.adopt", { space, tab: P.tab, as: "pop" });
  await h.call("pages.close", { space, page: "pop" });
  await h.until(async () => !(await h.call("pages.list", { space })).some(p => p.label === "pop"), 10000);
  const out = await h.call("pages.release", { space, page: "u" });
  assert.equal(out.tab, U.tab);
  assert.equal(out.released, undefined, "a page alone in its group: the reply is as before");

  // The agent's action opens a popup from the user's tab: the popup is the
  // agent's, so only a group release hands it over.
  await h.call("pages.adopt", { space, tab: U.tab, as: "u2" });
  await h.call("page.evaluate", { space, page: "u2", isFunction: false, fn: `String(!!window.open("/api/text?cg=X2"))` });
  let popup = null;
  await h.until(async () => (popup = (await h.call("pages.list", { space })).find(p => p.url.includes("cg=X2"))), 10000);
  assert.equal(popup.openedBy, "agent");
  await assert.rejects(h.call("pages.release", { space, page: "u2" }), { code: "ZEN_PAGE_GROUP_SHARED" });
  const both = await h.call("pages.release", { space, page: "u2", group: true });
  assert.deepEqual(
    both.released.map(r => [r.page, r.openedBy]),
    [
      ["u2", U.openedBy],
      [popup.label, "agent"],
    ]
  );
  await h.remove(space);
});

/** A task page's own code opens `path`, as the site's script or the user's click would. */
const openFromPage = (space, label, path, features = "") =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     const tab = ctx.pages.tabFor(ctx.pages.get(s, arg.label));
     return ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", {
       code: "return String(!!window.open(" + JSON.stringify(arg.url) + ", '_blank', " + JSON.stringify(arg.features) + "))",
       privileged: false,
     });`,
    { space, label, url: url(path), features }
  );

/** The task's tabs, as tabs.list has them, read from chrome: the user holds the task. */
const taskTabs = space =>
  h.chrome(
    `return ctx.pages.inventory(ctx.spaces.get(arg)).map(({ tab, id, page, openedBy }) =>
       ({ tab: id, label: page?.label ?? null, opener: page?.opener ?? null, openedBy, url: tab.linkedBrowser.currentURI.spec }));`,
    space
  );

test("during a hold, a task page's open with an opener joins the task; one with no opener stays the user's", async () => {
  const space = await h.space("cg hold");
  try {
    const { label } = await h.call("pages.new", { space, url: url("/api/text?cg=H") });
    await h.call("spaces.handOff", { space });
    assert.equal(await openFromPage(space, label, "/api/text?cg=H1"), "true");
    assert.equal(await openFromPage(space, label, "/api/text?cg=H2", "noopener"), "false", "noopener: null");
    let popup = null;
    let plain = null;
    await h.until(async () => {
      const tabs = await taskTabs(space);
      popup = tabs.find(t => t.url.includes("cg=H1"));
      plain = tabs.find(t => t.url.includes("cg=H2"));
      return popup && plain;
    }, 10000);
    assert.ok(popup.label, "the popup with an opener is a page of the task");
    assert.equal(popup.opener, label);
    assert.equal(plain.label, null, "a tab with no opener has a group of its own and isn't a page");
    assert.equal(plain.openedBy, "user");
    // The user holds the page, and the popup it opened joined the hold: no
    // agent code anywhere in their group until the hold ends.
    assert.deepEqual(await refusal(space, label), { reason: "hold", windows: 2 });
    assert.deepEqual(await refusal(space, popup.label), { reason: "hold", windows: 2 });
    // The agent driving: an open with no opener is the agent's, as in Ego.
    await h.call("spaces.takeOver", { space });
    assert.equal(await refusal(space, label), null, "the page's group holds only the task's pages");
    assert.equal(await refusal(space, popup.label), null);
    assert.equal(await openFromPage(space, label, "/api/text?cg=H3", "noopener"), "false");
    await h.until(async () => (await h.call("pages.list", { space })).some(p => p.url.includes("cg=H3")), 10000);
  } finally {
    await h.call("spaces.takeOver", { space }).catch(() => {});
    await h.call("spaces.finish", { space, keep: [] }).catch(() => h.remove(space));
  }
});

/** Run `code` as the page's own script in the tab showing `part`, task page or not. */
const inTab = (part, code) =>
  h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     const tab = [...W.allTabs()].find(t => t.linkedBrowser.currentURI.spec.includes(arg.part));
     return ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", { code: arg.code, privileged: false });`,
    { part, code }
  );
const tabsShowing = part =>
  h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     return [...W.allTabs()].filter(t => t.linkedBrowser.currentURI.spec.includes(arg)).length;`,
    part
  );
const closeTabsShowing = part =>
  h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     for (const t of [...W.allTabs()].filter(t => t.linkedBrowser.currentURI.spec.includes(arg))) {
       t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false, skipPermitUnload: true });
     }
     return true;`,
    part
  );

// A written kept page stays written through the finish, standing in for a
// page whose clean reload failed: landing (2) reloads written kept pages at
// the task's end (zen-core's call, 2026-11-20).
const keepWritten = () => h.chrome(`Services.prefs.setBoolPref("zenius.handoff.quietReload", false); return true;`);
const reloadAgain = () => h.chrome(`Services.prefs.clearUserPref("zenius.handoff.quietReload"); return true;`).catch(() => {});

test("after the task, a kept page that ran agent code, and any page in its group, gets no new window", async () => {
  const space = await h.space("cg kept");
  await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     ctx.service.cgHeard = [];
     ctx.service.cgOff = W.onOpenRefused(info =>
       ctx.service.cgHeard.push([info.url.replace(/^.*\\?/, ""), info.reopened, info.browser?.currentURI?.spec.replace(/^.*\\?/, "") ?? null])
     );
     return true;`
  );
  const open = (from, path, target = "_blank", features = "") =>
    inTab(from, `return String(window.open(${JSON.stringify(url(path))}, ${JSON.stringify(target)}, ${JSON.stringify(features)}))`);
  try {
    const { label: k1 } = await h.call("pages.new", { space, url: url("/api/text?cg=K1") });
    // The agent's code writes into K1, so K1 holds it after the task, and
    // opens K2 with an opener: one group.
    await h.call("page.evaluate", {
      space,
      page: k1,
      isFunction: false,
      fn: `document.documentElement.setAttribute("data-zo-agent", "1"), String(!!window.open("/api/text?cg=K2"))`,
    });
    let k2 = null;
    await h.until(async () => (k2 = (await h.call("pages.list", { space })).find(p => p.url.includes("cg=K2"))), 10000);
    // A page alone in its group, on another site: the kept mark goes by
    // site, since the agent's code can stay in a site's storage.
    const { label: k3 } = await h.call("pages.new", { space, url: url("/api/text?cg=K3").replace("127.0.0.1", "localhost") });
    // During the task, K1's popups join it (item 2).
    assert.equal(await open("cg=K1", "/api/text?cg=D1"), "[object Window]");
    await h.until(async () => (await h.call("pages.list", { space })).some(p => p.url.includes("cg=D1")), 10000);
    await keepWritten();
    await h.call("spaces.finish", { space, keep: [k1, k2.label, k3] });

    assert.equal(await open("cg=K1", "/api/text?cg=R1"), "null", "window.open from the marked page");
    assert.equal(await open("cg=K1", "/api/text?cg=R2", "cgnamed"), "null", "a named target");
    await inTab(
      "cg=K1",
      `const a = document.createElement("a"); a.href = ${JSON.stringify(url("/api/text?cg=R3"))}; a.target = "_blank"; a.rel = "opener";
       document.body.append(a); a.click(); return true;`
    );
    assert.equal(await open("cg=K2", "/api/text?cg=R4"), "null", "an unmarked page in the marked page's group");
    assert.equal(await open("cg=K3", "/api/text?cg=R5"), "[object Window]", "a page without the agent's code");
    assert.equal(await open("cg=K1", "/api/text?cg=R6", "_blank", "noopener"), "null", "noopener: null, as always");
    await h.until(async () => (await tabsShowing("cg=R5")) === 1 && (await tabsShowing("cg=R6")) === 1, 10000);
    for (const refused of ["cg=R1", "cg=R2", "cg=R3", "cg=R4"]) {
      assert.equal(await tabsShowing(refused), 0, `${refused} opened nothing`);
    }
    assert.deepEqual(await h.chrome(`return ctx.service.cgHeard;`), [
      ["cg=R1", false, "cg=K1"],
      ["cg=R2", false, "cg=K1"],
      ["cg=R3", false, "cg=K1"],
      ["cg=R4", false, "cg=K2"],
    ]);
  } finally {
    await reloadAgain();
    await h.chrome(`ctx.service.cgOff?.(); delete ctx.service.cgOff; delete ctx.service.cgHeard; return true;`).catch(() => {});
    for (const part of ["cg=K1", "cg=K2", "cg=K3", "cg=D1", "cg=R"]) {
      await closeTabsShowing(part).catch(() => {});
    }
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
    await h.chrome(`ctx.spaces.maybeRemoveAgentsSpace(); return true;`).catch(() => {});
  }
});

// Feature popups as windows (the Mac's default; Linux's for a tab whose
// window.open zenius doesn't wrap). document.open with three arguments is
// window.open, without the wrapper a task page's window.open has.
const popupWindows = () =>
  h.chrome(
    `return [...Services.wm.getEnumerator("navigator:browser")].filter(w => !w.toolbar.visible).map(w => w.gBrowser?.selectedBrowser?.currentURI?.spec ?? "");`
  );
const closePopupWindows = () =>
  h.chrome(`for (const w of [...Services.wm.getEnumerator("navigator:browser")]) if (!w.toolbar.visible) w.close(); return true;`);
const docOpen = path =>
  `(() => { const w = Document.prototype.open.call(document, ${JSON.stringify(url(path))}, "_blank", "width=400,height=300"); window.__w = w; return w === null ? "null" : "closed=" + w.closed; })()`;
const guardOn = () =>
  h.chrome(`return ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/guards.sys.mjs").popupWindowGuardOn();`);

test("a task page's feature popup joins the task: a tab through window.open, and a window that gets past it moves in", async () => {
  const space = await h.space("cg window");
  try {
    const { label } = await h.call("pages.new", { space, url: url("/api/text?cg=W0") });
    assert.equal(await guardOn(), true, "a task is live");
    assert.equal(await openFromPage(space, label, "/api/text?cg=W1", "width=400,height=300"), "true");
    assert.equal(await h.call("page.evaluate", { space, page: label, isFunction: false, fn: docOpen("/api/text?cg=W2") }), "closed=false");
    let popups = [];
    await h.until(async () => (popups = (await h.call("pages.list", { space })).filter(p => /cg=W[12]/.test(p.url))).length === 2, 15000);
    assert.deepEqual(popups.map(p => p.opener), [label, label]);
    await h.until(async () => (await popupWindows()).length === 0, 10000);
    // The same browsing context: the page's handle still reaches it, once
    // its first document has loaded (pages.list shows a popup's URL while
    // it loads).
    const handle = () =>
      h.call("page.evaluate", { space, page: label, isFunction: false, fn: `String(window.__w.closed) + " " + window.__w.location.search` });
    await h.until(async () => (await handle()) === "false ?cg=W2", 10000);
  } finally {
    await closePopupWindows().catch(() => {});
    await h.call("spaces.finish", { space, keep: [] }).catch(() => h.remove(space));
  }
});

test("during a hold, a feature popup the user opens from a task page joins the task, from a window too", async () => {
  const space = await h.space("cg window hold");
  try {
    const { label } = await h.call("pages.new", { space, url: url("/api/text?cg=WH0") });
    await h.call("spaces.handOff", { space });
    // The page's own code, as the user's click would run it.
    assert.equal(await inTab("cg=WH0", `return String(!!window.open(${JSON.stringify(url("/api/text?cg=WH1"))}, "_blank", "width=400,height=300"));`), "true");
    assert.equal(await inTab("cg=WH0", `return ${docOpen("/api/text?cg=WH2")};`), "closed=false");
    let tabs = [];
    await h.until(async () => (tabs = (await taskTabs(space)).filter(t => /cg=WH[12]/.test(t.url) && t.label)).length === 2, 15000);
    assert.deepEqual(tabs.map(t => t.opener), [label, label]);
    await h.until(async () => (await popupWindows()).length === 0, 10000);
  } finally {
    await closePopupWindows().catch(() => {});
    await h.call("spaces.takeOver", { space }).catch(() => {});
    await h.call("spaces.finish", { space, keep: [] }).catch(() => h.remove(space));
  }
});

test("after the task, a kept page with the agent's code gets null for a feature popup, through window.open or past it", async () => {
  const space = await h.space("cg window kept");
  await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     ctx.service.wkHeard = [];
     ctx.service.wkOff = W.onOpenRefused(info => ctx.service.wkHeard.push([info.url.replace(/^.*\\?/, ""), info.reopened]));
     return true;`
  );
  try {
    const { label } = await h.call("pages.new", { space, url: url("/api/text?cg=WK") });
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: `document.documentElement.setAttribute("data-zo-agent", "1"), 1` });
    await keepWritten();
    await h.call("spaces.finish", { space, keep: [label] });
    assert.equal(await guardOn(), true, "a kept document holds the agent's code");
    assert.equal(await inTab("cg=WK", `return String(window.open(${JSON.stringify(url("/api/text?cg=WK1"))}, "_blank", "width=400,height=300"));`), "null");
    assert.equal(await inTab("cg=WK", `return ${docOpen("/api/text?cg=WK2")};`), "null");
    assert.deepEqual(await popupWindows(), []);
    assert.equal((await tabsShowing("cg=WK1")) + (await tabsShowing("cg=WK2")), 0, "nothing opened");
    // The window's refusal has no URL: the window creator doesn't get one.
    assert.deepEqual(await h.chrome(`return ctx.service.wkHeard;`), [
      ["cg=WK1", false],
      ["", false],
    ]);
  } finally {
    await reloadAgain();
    await h.chrome(`ctx.service.wkOff?.(); delete ctx.service.wkOff; delete ctx.service.wkHeard; return true;`).catch(() => {});
    await closePopupWindows().catch(() => {});
    await closeTabsShowing("cg=WK").catch(() => {});
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
    await h.chrome(`ctx.spaces.maybeRemoveAgentsSpace(); return true;`).catch(() => {});
  }
});

test("the window creator is zenius's only while a task is live or a kept document holds the agent's code (I4)", async () => {
  await h.until(async () => !(await guardOn()), 10000);
  const space = await h.space("cg window guard");
  try {
    const { label } = await h.call("pages.new", { space, url: url("/api/text?cg=WG") });
    assert.equal(await guardOn(), true, "a task is live");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: `document.documentElement.setAttribute("data-zo-agent", "1"), 1` });
    await keepWritten();
    await h.call("spaces.finish", { space, keep: [label] });
    assert.equal(await guardOn(), true, "the kept page holds the agent's code");
    await closeTabsShowing("cg=WG");
    await h.until(async () => !(await guardOn()), 10000);
  } finally {
    await reloadAgain();
    await closeTabsShowing("cg=WG").catch(() => {});
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
    await h.chrome(`ctx.spaces.maybeRemoveAgentsSpace(); return true;`).catch(() => {});
  }
  // A task whose pages ran no agent code, finished with nothing kept.
  const plain = await h.space("cg window guard 2");
  await h.call("pages.new", { space: plain, url: url("/api/text?cg=WG2") });
  assert.equal(await guardOn(), true);
  await h.call("spaces.finish", { space: plain, keep: [] }).catch(() => h.remove(plain));
  await h.until(async () => !(await guardOn()), 10000);
});

test("the user's own feature popup, from a tab where the agent's code never ran, opens as a window", async () => {
  const space = await h.userSpace("cg window user", url("/api/text?cg=WU"));
  try {
    assert.equal(await inTab("cg=WU", `return String(!!window.open(${JSON.stringify(url("/api/text?cg=WU1"))}, "_blank", "width=400,height=300"));`), "true");
    await h.until(async () => (await popupWindows()).some(u => u.includes("cg=WU1")), 10000);
  } finally {
    await closePopupWindows().catch(() => {});
    await h.remove(space).catch(() => {});
  }
});

test("after the task, a refusal in a kept page with the agent's code reaches onKeptRefused; a made-up kind or an unmarked page doesn't", async () => {
  const space = await h.space("cg kept refusal");
  await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     ctx.service.krHeard = [];
     ctx.service.krOff = W.onKeptRefused(info =>
       ctx.service.krHeard.push({ kind: info.kind, api: info.api, asked: info.asked, page: info.browser?.currentURI?.spec.replace(/^.*\\?/, "") ?? null })
     );
     return true;`
  );
  try {
    const { label: k1 } = await h.call("pages.new", { space, url: url("/api/text?cg=KR1") });
    // The agent's code runs in KR1: its document is marked.
    await h.call("page.evaluate", { space, page: k1, isFunction: false, fn: `document.documentElement.setAttribute("data-zo-agent", "1"), 1` });
    // On another site, where the agent's code never ran.
    const { label: k2 } = await h.call("pages.new", { space, url: url("/api/text?cg=KR2").replace("127.0.0.1", "localhost") });
    await keepWritten();
    await h.call("spaces.finish", { space, keep: [k1, k2] });
    // The page's own code, as a click of the user's would run it.
    await inTab("cg=KR1", `try { new Notification("hi"); } catch {} return true;`);
    await h.until(async () => (await h.chrome(`return ctx.service.krHeard.length;`)) >= 1, 10000);
    const [real] = await h.chrome(`return ctx.service.krHeard;`);
    assert.equal(real.kind, "notification");
    assert.equal(real.page, "cg=KR1");
    assert.ok(typeof real.api === "string" && real.api.length <= 80 && typeof real.asked === "string" && real.asked.length <= 80);
    // What the page's process could make up.
    await h.chrome(
      `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
       const send = (part, params) => {
         const bc = [...W.allTabs()].find(t => t.linkedBrowser.currentURI.spec.includes(part)).linkedBrowser.browsingContext;
         ctx.service.onContentEvent({ manager: bc.currentWindowGlobal, browsingContext: bc }, { name: "observe.refused", params });
       };
       send("cg=KR1", { kind: "madeUp", message: "x" });
       send("cg=KR1", { kind: "wakeLock", api: "a".repeat(500), asked: "b".repeat(500) });
       send("cg=KR2", { kind: "notification" });
       return true;`
    );
    assert.deepEqual((await h.chrome(`return ctx.service.krHeard;`)).slice(1), [
      { kind: "wakeLock", api: "a".repeat(80), asked: "b".repeat(80), page: "cg=KR1" },
    ]);
  } finally {
    await reloadAgain();
    await h.chrome(`ctx.service.krOff?.(); delete ctx.service.krOff; delete ctx.service.krHeard; return true;`).catch(() => {});
    for (const part of ["cg=KR1", "cg=KR2"]) {
      await closeTabsShowing(part).catch(() => {});
    }
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
    await h.chrome(`ctx.spaces.maybeRemoveAgentsSpace(); return true;`).catch(() => {});
  }
});

test("onOpenRefused tells each listener of a refused open; a listener's error doesn't stop the others", async () => {
  const heard = await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     const heard = [];
     const offBad = W.onOpenRefused(() => { throw new Error("a listener's own bug"); });
     const off = W.onOpenRefused(info => heard.push([info.url, info.reopened]));
     W.noteOpenRefused({ browser: null, url: "https://example.com/", reopened: true });
     off();
     offBad();
     W.noteOpenRefused({ browser: null, url: "", reopened: false });
     return heard;`
  );
  assert.deepEqual(heard, [["https://example.com/", true]]);
});
