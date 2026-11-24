// The local-network notice. zen-observe refuses a load the user started to the
// local network in an agent's tab: a task's tab, the user's hold included, or a
// kept page with the agent's writes. It tells zen-ux through onUserLoadRefused.
// In a task's tab, the tab says access was denied, and why. Open it yourself
// opens the address in a tab of the user's own: the one they typed, or the home
// page of the site the page chose. For an address they typed, Add to allowlist
// appends that exact host to zenius.agentTabs.allowPrivateNetworks, on the
// user's own click only, and loads it in the tab; what it does waits behind the
// '?'. The agent's synthesized clicks and keys can't press it. A kept page
// shows nothing: it loads afresh, quietly. These tests call the hook's
// listener the way zen-observe does.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { iso, setup } from "./lib.mjs";

let h;
let userView;
const run = Date.now().toString(36).slice(-5);

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
});

after(async () => {
  await h?.chrome(`const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI; UI.cleanLoad = null; UI.evidenceOf = null; return true;`).catch(() => {});
  await h?.close();
});

// Chrome-side helpers: pages by browserId, which outlives their labels.
const K = `
  const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
  const Win = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 5000) => {
    for (const end = Date.now() + ms; !(await fn()); ) {
      if (Date.now() > end) throw new Error("timed out waiting for " + fn);
      await sleep(25);
    }
  };
  const tabOf = bid => [...Win.uniqueTabs()].find(t => t.linkedBrowser?.browserId === bid) ?? null;
  const noticeOf = bid => N.noticeElement(tabOf(bid), "zenius-localnet");
  const card = bid => {
    const el = noticeOf(bid);
    return el
      ? {
          text: N.noticeText(tabOf(bid), "zenius-localnet"),
          note: el.querySelector(".zenius-card-note")?.textContent ?? null,
          buttons: [...el.querySelectorAll(".zenius-card-buttons button")].map(b => b.textContent),
          // The '?' shows the rest at any width.
          more: el.hasAttribute("has-more"),
        }
      : null;
  };
  // The user's click, once the notice has armed (it ignores clicks for 400 ms).
  const press = async (el, label) => {
    await sleep(450);
    const b = [...(el?.querySelectorAll("button") ?? [])].find(b => b.textContent === label);
    if (!b) throw new Error("no " + label + " button");
    b.click();
  };
  const refused = (bid, url, origin, reason, typed, scope) =>
    UI.userLoadRefused({ browser: tabOf(bid).linkedBrowser, url, origin, reason, typed, scope });
  // The user's own click in a page, through the parent as the OS's would.
  const userClick = async bid => {
    const b = tabOf(bid).linkedBrowser;
    const r = b.getBoundingClientRect();
    for (const type of ["mousedown", "mouseup"]) {
      b.ownerDocument.defaultView.synthesizeMouseEvent(type, r.x + 5, r.y + 5, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
    }
    await sleep(100);
  };
  // zen-observe's flag and zen-core's cleanLoad, standing in.
  const calls = [];
  const standIn = bid => {
    const b = tabOf(bid).linkedBrowser;
    const doc = b.browsingContext.currentWindowGlobal.innerWindowId;
    UI.evidenceOf = target => (target === b && b.browsingContext.currentWindowGlobal?.innerWindowId === doc ? { hooked: "a script element" } : {});
    UI.cleanLoad = async browser => {
      calls.push(browser.browserId);
      return { how: "reload" };
    };
  };
  // A tab opened after \`before\` (a set of tabs): the new one.
  const opened = before => [...Win.uniqueTabs()].find(t => !before.has(t)) ?? null;
  // zen-observe's list of local hosts agents may reach.
  const ALLOW = "zenius.agentTabs.allowPrivateNetworks";
  const allowList = () => Services.prefs.getStringPref(ALLOW, "");
  // The tab in view, as the user's click on its card needs.
  const view = async t => {
    ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs").landOn(t);
    await gZenWorkspaces.changeWorkspaceWithID(t.getAttribute("zen-workspace-id"));
    await until(() => gBrowser.selectedTab === t);
  };
`;

/** A task with one page, p1, on `url`. */
async function task(name, url) {
  const { id: space } = await h.createSpace({ name: `zen-ux localnet ${name} ${run}` });
  await h.call("page.goto", { space, page: "p1", url });
  const bid = await h.chrome(`return ctx.resolvePage({ space: ${space}, page: "p1" }).browser.browserId;`);
  return { space, bid };
}

/** Close tabs by browserId, in every window, and go back to the user's Space. */
const cleanUp = bids =>
  h.chrome(`${K}
    for (const bid of ${JSON.stringify(bids)}) {
      const t = tabOf(bid);
      if (t) t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
    }
    if (gZenWorkspaces.activeWorkspace !== ${JSON.stringify(userView.windows[0].activeWorkspace)}) await gZenWorkspaces.changeWorkspaceWithID(${JSON.stringify(userView.windows[0].activeWorkspace)});
    return true;
  `);

const host = () => new URL(h.base).hostname;

/** The allowlist as the profile had it (null: unset), and back. */
const ALLOW_PREF = "zenius.agentTabs.allowPrivateNetworks";
const savedAllowList = () => h.chrome(`return Services.prefs.prefHasUserValue(${JSON.stringify(ALLOW_PREF)}) ? Services.prefs.getStringPref(${JSON.stringify(ALLOW_PREF)}) : null;`);
const restoreAllowList = had =>
  h.chrome(
    had === null
      ? `Services.prefs.clearUserPref(${JSON.stringify(ALLOW_PREF)}); return true;`
      : `Services.prefs.setStringPref(${JSON.stringify(ALLOW_PREF)}, ${JSON.stringify(had)}); return true;`
  );
// The notice's line: an address the user typed, or one the page chose.
// The note's text, with what waits behind the '?'.
const policy = host => `The current network policy doesn't allow agents to access ${iso(host)}.`;
const typedNote = host => `${policy(host)} It's on your local network; Add to allowlist lets every agent tab reach it, until you remove it.`;
const chosenNote = host => `${policy(host)} It's on your local network, and this page tried to reach it; opening it yourself opens its home page in a tab of yours.`;

test("a load the user typed, refused in a task's tab: the notice says why and names the allowlist, and takes no focus; its button opens the address in a tab of the user's own, selected, in the tab's container", async () => {
  const { bid } = await task("typed", `${h.base}/zoo/forms.html`);
  const extra = [];
  try {
    const before = await h.call("dev.viewState");
    const shown = await h.chrome(`${K}
      refused(${bid}, ${JSON.stringify(`${h.base}/zoo/forms.html?typed`)}, ${JSON.stringify(h.base)}, "a private address", true);
      await until(() => noticeOf(${bid}));
      return card(${bid});
    `);
    const after = await h.call("dev.viewState");
    assert.deepEqual(shown, {
      text: `Network access denied · ${iso(host())}`,
      note: typedNote(host()),
      buttons: ["Open it yourself", "Add to allowlist", "Dismiss"],
      more: true,
    });
    assert.deepEqual(after, before, "no focus taken, no view moved");
    const out = await h.chrome(`${K}
      const from = tabOf(${bid});
      // The user presses it on the agent's tab, in the agent's Space, so
      // Open it yourself switches the window to the user's own Space.
      await view(from);
      const tabs = new Set(Win.uniqueTabs());
      // Every tab the window selects on the way: only the new one, not the
      // Space's last tab first (landOn).
      const selected = [];
      const onSelect = e => selected.push(e.target.linkedBrowser?.browserId ?? null);
      win.gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
      let t;
      try {
        await press(noticeOf(${bid}), "Open it yourself");
        await until(() => opened(tabs)?.linkedBrowser.currentURI.spec.endsWith("?typed"));
        t = opened(tabs);
        await until(() => t.ownerDocument.defaultView.gBrowser.selectedTab === t);
      } finally {
        win.gBrowser.tabContainer.removeEventListener("TabSelect", onSelect);
      }
      return {
        others: selected.filter(id => id !== t.linkedBrowser.browserId).length,
        bid: t.linkedBrowser.browserId,
        space: t.getAttribute("zen-workspace-id"),
        own: ctx.service.pages.isUserOwn(t),
        container: t.userContextId === from.userContextId,
        opener: t.linkedBrowser.browsingContext.opener === null,
        notice: !!noticeOf(${bid}),
      };
    `);
    extra.push(out.bid);
    assert.deepEqual(
      { ...out, bid: undefined },
      { others: 0, bid: undefined, space: userView.windows[0].activeWorkspace, own: true, container: true, opener: true, notice: false }
    );
  } finally {
    await cleanUp([bid, ...extra]);
  }
});

test("Add to allowlist: the user's click appends that exact host to zenius.agentTabs.allowPrivateNetworks (an IPv6 address without brackets, never a port or a range), once, after what the list had; then the address loads in this tab", async () => {
  const { bid } = await task("allow", `${h.base}/zoo/forms.html`);
  const had = await savedAllowList();
  try {
    const out = await h.chrome(`${K}
      const t = tabOf(${bid});
      await view(t);
      const button = () => [...(noticeOf(${bid})?.querySelectorAll("button") ?? [])].find(b => b.textContent === "Add to allowlist");
      // The user's own click, as the OS's would come.
      const realClick = async el => {
        const r = el.getBoundingClientRect();
        for (const type of ["mousedown", "mouseup"]) {
          win.synthesizeMouseEvent(type, r.x + r.width / 2, r.y + r.height / 2, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
        }
      };
      // The card arms 400 ms after it shows; a load ends it.
      const allowAndLoad = async url => {
        refused(${bid}, url, ${JSON.stringify(h.base)}, "a private address", true);
        await until(() => button());
        await sleep(450);
        await realClick(button());
        await until(() => t.linkedBrowser.currentURI.spec === url && !t.linkedBrowser.webProgress.isLoadingDocument, 8000);
      };
      const res = {};
      Services.prefs.setStringPref(ALLOW, "10.0.0.0/8");
      // An IPv6 address: the loopback, so nothing leaves the machine.
      await allowAndLoad("http://[::1]:" + ${JSON.stringify(new URL(h.base).port)} + "/api/text?allowed");
      res.v6 = allowList();
      await allowAndLoad(${JSON.stringify(`${h.base}/api/text?allowed`)});
      res.v4 = { list: allowList(), notice: !!noticeOf(${bid}) };
      // The host is on the list already: nothing more is added.
      await allowAndLoad(${JSON.stringify(`${h.base}/api/text?again`)});
      res.again = allowList();
      return res;
    `);
    assert.equal(out.v6, "10.0.0.0/8, ::1");
    assert.deepEqual(out.v4, { list: `10.0.0.0/8, ::1, ${host()}`, notice: false });
    assert.equal(out.again, `10.0.0.0/8, ::1, ${host()}`);
  } finally {
    await restoreAllowList(had);
    await cleanUp([bid]);
  }
});

test("Add to allowlist: the agent's synthesized input can't press it: its click where the button shows lands in the page, its Tab, Enter and Space stay in the page, and its code reaches only the page; the list stays as it was and nothing loads", async () => {
  // A page with nothing to focus: the user's Tab from it goes to the card.
  const { space, bid } = await task("synth", `${h.base}/api/text?synth`);
  const had = await savedAllowList();
  try {
    const spot = await h.chrome(`${K}
      const t = tabOf(${bid});
      await view(t);
      Services.prefs.setStringPref(ALLOW, "10.0.0.0/8");
      refused(${bid}, ${JSON.stringify(`${h.base}/api/text?allowed`)}, ${JSON.stringify(h.base)}, "a private address", true);
      await until(() => noticeOf(${bid}));
      await sleep(450);
      const r = [...noticeOf(${bid}).querySelectorAll("button")].find(b => b.textContent === "Add to allowlist").getBoundingClientRect();
      const area = t.linkedBrowser.getBoundingClientRect();
      return {
        x: Math.round(r.x + r.width / 2 - area.x),
        y: Math.round(r.y + r.height / 2 - area.y),
        over: r.left >= area.left && r.right <= area.right && r.top >= area.top && r.bottom <= area.bottom,
      };
    `);
    assert.equal(spot.over, true, "the button shows over the page");
    // The agent's input, through zen-input as any agent's.
    await h.call("page.mouse", { space, page: "p1", action: "click", x: spot.x, y: spot.y, options: {} });
    for (let i = 0; i < 4; i++) {
      await h.call("page.keyboard", { space, page: "p1", action: "press", key: "Tab", options: {} });
    }
    await h.call("page.keyboard", { space, page: "p1", action: "press", key: "Enter", options: {} });
    await h.call("page.keyboard", { space, page: "p1", action: "press", key: "Space", options: {} });
    const hit = await h.call("page.evaluate", {
      space,
      page: "p1",
      fn: "({ x, y }) => { const el = document.elementFromPoint(x, y); el?.click(); return el?.localName ?? null; }",
      arg: { x: spot.x, y: spot.y },
      isFunction: true,
    });
    const out = await h.chrome(`${K}
      await sleep(300);
      const focused = Services.focus.focusedElement;
      return {
        list: allowList(),
        notice: !!noticeOf(${bid}),
        url: tabOf(${bid}).linkedBrowser.currentURI.spec,
        focusOnCard: !!(focused && noticeOf(${bid})?.contains(focused)),
      };
    `);
    assert.notEqual(hit, null, "the agent's code finds the page's element there");
    assert.deepEqual(out, { list: "10.0.0.0/8", notice: true, url: `${h.base}/api/text?synth`, focusOnCard: false });
  } finally {
    await restoreAllowList(had);
    await cleanUp([bid]);
  }
});

test("a load the page chose: the notice says so, with no Add to allowlist, and its button opens the site's home page in a tab of the user's own", async () => {
  const { bid } = await task("chosen", `${h.base}/zoo/forms.html`);
  const extra = [];
  try {
    const out = await h.chrome(`${K}
      refused(${bid}, ${JSON.stringify(`${h.base}/zoo/forms.html?chosen#here`)}, ${JSON.stringify(h.base)}, "a private address", false);
      await until(() => noticeOf(${bid}));
      const shown = card(${bid});
      const tabs = new Set(Win.uniqueTabs());
      await press(noticeOf(${bid}), "Open it yourself");
      await until(() => opened(tabs)?.linkedBrowser.currentURI.spec === ${JSON.stringify(`${h.base}/`)});
      const t = opened(tabs);
      return { shown, bid: t.linkedBrowser.browserId, own: ctx.service.pages.isUserOwn(t) };
    `);
    extra.push(out.bid);
    assert.deepEqual(out.shown, {
      text: `Network access denied · ${iso(host())}`,
      note: chosenNote(host()),
      buttons: ["Open it yourself", "Dismiss"],
      more: true,
    });
    assert.equal(out.own, true);
  } finally {
    await cleanUp([bid, ...extra]);
  }
});

test("in a kept page with the agent's writes, a load the page chose after the user's click loads the page afresh, quietly, with no notice; one with no click of theirs changes nothing", async () => {
  const { space, bid } = await task("kept", `${h.base}/zoo/forms.html`);
  try {
    await h.call("page.evaluate", { space, page: "p1", fn: "() => document.title", isFunction: true });
    await h.call("spaces.finish", { space, keep: ["p1"] });
    const out = await h.chrome(`${K}
      standIn(${bid});
      // The page in view, for the user's click.
      const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
      const t = tabOf(${bid});
      Pages.landOn(t);
      await gZenWorkspaces.changeWorkspaceWithID(t.getAttribute("zen-workspace-id"));
      await until(() => gBrowser.selectedTab === t);
      // zen-observe lets the user's own typed load replace a kept page's
      // document; it refuses only a load the page chose.
      const show = () => refused(${bid}, ${JSON.stringify(`${h.base}/zoo/forms.html?link`)}, ${JSON.stringify(h.base)}, "a private address", false);
      show();
      await sleep(200);
      const unasked = { calls: calls.length, card: card(${bid}) };
      await userClick(${bid});
      show();
      await until(() => calls.length);
      return { unasked, clicked: { calls: calls.slice(), card: card(${bid}) } };
    `);
    assert.deepEqual(out, { unasked: { calls: 0, card: null }, clicked: { calls: [bid], card: null } });
  } finally {
    await h.chrome(`${K} UI.cleanLoad = null; UI.evidenceOf = null; return true;`);
    await cleanUp([bid]);
  }
});

test("after the user's Stop, the page is theirs: a refused load shows no notice there, unless zen-observe's scope says the tab is a task's", async () => {
  const { space, bid } = await task("stop", `${h.base}/zoo/forms.html`);
  try {
    const out = await h.chrome(`${K}
      standIn(${bid});
      UI.stopByUser(ctx.spaces.peek(${space}));
      const chosen = scope => {
        refused(${bid}, ${JSON.stringify(`${h.base}/zoo/forms.html?link`)}, ${JSON.stringify(h.base)}, "a private address", false, scope);
        return card(${bid})?.note ?? null;
      };
      return { owner: ctx.spaces.peek(${space}).ownership, stopped: chosen(), task: chosen("task") };
    `);
    assert.deepEqual(out, {
      owner: "user",
      stopped: null,
      task: chosenNote(host()),
    });
  } finally {
    await h.chrome(`${K} UI.cleanLoad = null; UI.evidenceOf = null; return true;`);
    await cleanUp([bid]);
  }
});

test("end to end, on zen-observe's refusal: in the user's hold, an address they type to a .local name isn't opened, and the tab says why", async () => {
  const { space, bid } = await task("e2e", `${h.base}/zoo/forms.html`);
  try {
    const out = await h.chrome(`${K}
      const rec = ctx.spaces.peek(${space});
      ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "agent" });
      const b = tabOf(${bid}).linkedBrowser;
      const was = b.browsingContext.currentWindowGlobal.innerWindowId;
      // As the address bar loads it. zen-observe refuses a .local name before
      // any lookup (http-on-opening-request): nothing leaves the machine.
      b.loadURI(Services.io.newURI("http://lan.local/zenius-e2e"), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      await until(() => noticeOf(${bid}));
      // Whatever the refused load shows next, the notice stays.
      await sleep(1000);
      return { card: card(${bid}), url: b.currentURI.spec, same: b.browsingContext.currentWindowGlobal?.innerWindowId === was };
    `);
    assert.deepEqual(out.card, {
      text: `Network access denied · ${iso("lan.local")}`,
      note: typedNote("lan.local"),
      buttons: ["Open it yourself", "Add to allowlist", "Dismiss"],
      more: true,
    }, JSON.stringify({ url: out.url, same: out.same }));
  } finally {
    await h.chrome(`
      const rec = ctx.spaces.peek(${space});
      if (rec && rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      return true;
    `);
    await cleanUp([bid]);
  }
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
});
