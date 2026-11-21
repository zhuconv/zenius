// Permission prompts in agent pages (runtime/JS/zenius/ui/permissions.sys.mjs).
// Storage access and the local network's put the Space under the user's
// control with Ego's reason key, wait in the background for the user to open
// the Space, and give control back once answered. Every other one is denied
// in a task's pages, during the user's hold too (the manager, 2026-11-20).
//
// The prompts that hand off need a cross-site frame, or a public page asking
// for a private address, to come up for real, so these tests raise them from
// chrome with the requesting origin as displayURI, as PermissionUI does: the
// watcher only sees PopupNotifications either way. A denied one is raised
// for real too, by persist().
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { iso, prelude, setup } from "./lib.mjs";

let h;

/** The site the hold cards name: the fixture's host, isolated as the card's texts are. */
const site = () => iso(new URL(h.base).hostname);
let space;
let P;
let userView;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  ({ id: space } = await h.createSpace({ name: "zen-ux permissions test" }));
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  P = `${prelude(space)}
    const PN = win.PopupNotifications;
    const Perm = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/permissions.sys.mjs");
    // A cross-site sign-in frame's storage access prompt, with Allow and Block.
    const askStorage = (from = null) =>
      PN.show(browser, "storage-access", "Allow the sign-in frame to use its cookies here?", "storage-access-notification-icon",
        { label: "Allow", accessKey: "A", callback() {} }, [{ label: "Block", accessKey: "B", callback() {} }],
        from ? { displayURI: Services.io.newURI(from) } : {});
  `;
  // A Block stored for the site would answer persist() without a prompt.
  await h.chrome(`${P} Services.perms.removeFromPrincipal(browser.contentPrincipal, "persistent-storage");`);
});

after(async () => {
  await h?.chrome(`${P}
    for (const id of ["storage-access", "geolocation", "persistent-storage", "password"]) {
      const n = PN.getNotification(id, browser);
      if (n) PN.remove(n);
    }
  `).catch(() => {});
  await h?.close();
});

const state = () => h.call("ui.state", { space });
const sleep = ms => new Promise(r => setTimeout(r, ms));

test("the prompts a task's pages may hand to the user, with Ego's reason keys, and the ones they never get", async () => {
  const out = await h.chrome(`${P}
    const ids = ["storage-access", "local-network", "loopback-network", "geolocation", "web-notifications", "persistent-storage", "midi", "webSerial-choosePort", "xr", "webRTC-shareDevices", "password"];
    return Object.fromEntries(ids.map(id => [id, Perm.reasonFor(id) ?? (Perm.isDenied(id) ? "denied" : null)]));
  `);
  assert.deepEqual(out, {
    "storage-access": "storage_access",
    "local-network": "local_network_access",
    "loopback-network": "local_network_access",
    geolocation: "denied",
    "web-notifications": "denied",
    "persistent-storage": "denied",
    midi: "denied",
    "webSerial-choosePort": "denied",
    xr: "denied",
    "webRTC-shareDevices": "denied",
    password: null,
  });
});

test("a storage access prompt in a background agent page hands the Space to the user", async () => {
  await h.chrome(`${P} askStorage(); return true;`);
  let s;
  for (let i = 0; i < 40 && (s = await state()).ownership === "agent"; i++) {
    await sleep(50);
  }
  assert.equal(s.ownership, "agentDelegatedToUser");
  assert.equal(s.reason, "storage_access");
  assert.equal(s.badge.state, "needs-user");
  assert.equal(s.controlNotice, `Agent paused · page asks for storage access · ${site()}`);
  const out = await h.chrome(`${P} return { pending: !!PN.getNotification("storage-access", browser), panelOpen: PN.isPanelOpen };`);
  assert.equal(out.pending, true, "Firefox keeps the prompt for when the user opens the Space");
  assert.equal(out.panelOpen, false, "nothing shows over the user's Space");
  assert.deepEqual(await h.call("dev.viewState"), userView);
  // The gate every mutating call passes (moveCursor's on visible tabs,
  // zen-core's dispatcher for the rest) fails with the reason key.
  const gate = await h.chrome(`${P}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    try { ctx.spaces.gate(rec); return null; } catch (e) { return { code: e.code, data: e.data }; }
  `);
  assert.deepEqual(gate, { code: "ZEN_TASK_SPACE_USER_IN_CONTROL", data: { space, reason: "storage_access" } });
});

// G10b on the Mac: after Open in the tasks panel no prompt showed
// (docs/reports/mac-relay.md). Firefox shows a background tab's prompt when
// the tab is selected, unless it suppresses doorhangers at that moment, and
// then only something that re-checks shows it. The test plays that miss:
// suppression during the switch, and a prompt the user had clicked away.
test("Open in the tasks panel shows the page's prompt, even when Firefox's own update misses it", async () => {
  const out = await h.chrome(`${P}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const userWs = gZenWorkspaces.activeWorkspace;
    const n = PN.getNotification("storage-access", browser);
    n.dismissed = true;
    const shouldSuppress = PN._shouldSuppress;
    let switching = true;
    PN._shouldSuppress = () => switching || shouldSuppress();
    PN._suppress = true;
    try {
      const panel = UI.openTasksPanel(win);
      await new Promise(r => panel.state === "open" ? r() : panel.addEventListener("popupshown", r, { once: true }));
      let tasksPanelAtSwitch = null;
      win.addEventListener("TabSelect", () => (tasksPanelAtSwitch = panel.state), { once: true, capture: true });
      panel.querySelector('.zenius-task[data-space="${space}"] [data-action="open"]').click();
      await until(() => gZenWorkspaces.activeWorkspace === rec.uuid && gBrowser.selectedBrowser === browser);
      const missed = PN.isPanelOpen;
      switching = false; // nothing in Firefox looks again by itself
      await until(() => PN.isPanelOpen && PN.panel.state === "open", 5000).catch(() => {});
      return {
        missed,
        tasksPanelAtSwitch,
        panelOpen: PN.isPanelOpen,
        showing: [...PN.panel.children].map(c => c.notification?.id),
      };
    } finally {
      PN._shouldSuppress = shouldSuppress;
      PN._suppress = shouldSuppress();
      PN.panel.hidePopup();
      await until(() => !PN.isPanelOpen);
      await gZenWorkspaces.changeWorkspaceWithID(userWs);
    }
  `);
  assert.equal(out.missed, false, "Firefox's own update didn't show it (the miss the test plays)");
  assert.equal(out.tasksPanelAtSwitch, "closed", "the tasks panel closed before the switch");
  assert.equal(out.panelOpen, true, "the doorhanger shows after Open");
  assert.deepEqual(out.showing, ["storage-access"]);
  // Switching Spaces moves focus, so compare where the user was.
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});

test("answering the prompt gives control back to the agent", async () => {
  await h.chrome(`${P} PN.remove(PN.getNotification("storage-access", browser));`);
  const s = await state();
  assert.equal(s.ownership, "agent");
  assert.equal(s.reason, null);
  assert.equal(s.controlNotice, null);
  const r = await h.call("ui.cursor", { space, page: "p1", x: 5, y: 5 });
  assert.equal(r.ok, true);
});

test("doorhangers that aren't permission prompts are ignored", async () => {
  await h.chrome(`${P} PN.show(browser, "password", "Save login?", "password-notification-icon", null, null, {});`);
  await sleep(50);
  assert.equal((await state()).ownership, "agent");
});

test("after a takeover, an answered prompt doesn't return control to the agent", async () => {
  await h.chrome(`${P}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    UI.forgetHandOffs(rec);
    askStorage();
    ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });
    PN.remove(PN.getNotification("storage-access", browser));
  `);
  const s = await state();
  assert.equal(s.ownership, "agentDelegatedToUser");
  assert.equal(s.reason, "manual_takeover");
  await h.chrome(`${P}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
  `);
  assert.equal((await state()).ownership, "agent");
});

test("a site whose prompt went unanswered can't ask again: after its own reload, it asks in vain", async () => {
  await h.call("page.events", { space, page: "p1" });
  await h.chrome(`${P}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    UI.forgetHandOffs(rec);
    askStorage();
    return true;
  `);
  let s = await state();
  assert.equal(s.ownership, "agentDelegatedToUser", "the first prompt hands the task over");
  // The page reloads itself: Firefox removes its prompt, unanswered
  // (PopupNotifications' locationChange), and the task goes back to the
  // agent. Without the limit the page could repeat this.
  const page = code => h.call("dev.evalContent", { space, page: "p1", privileged: false, code });
  const before = await page("return performance.timeOrigin;");
  await page("location.reload(); return true;");
  for (let i = 0; i < 60 && (s = await state()).ownership !== "agent"; i++) {
    await sleep(50);
  }
  assert.equal(s.ownership, "agent");
  // A new document, judged by its own clock: the evaluation sandbox's view of
  // the window keeps what the old page's callbacks wrote.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await page(`return performance.timeOrigin !== ${before} && document.readyState === "complete";`).catch(() => false);
    if (!ready) {
      await sleep(50);
    }
  }
  assert.equal(ready, true, "the page reloaded");
  const out = await h.chrome(`${P} askStorage(); return { owner: rec.ownership, pending: !!PN.getNotification("storage-access", browser) };`);
  assert.deepEqual(out, { owner: "agent", pending: false }, "the second request is cancelled at once, and the user isn't pulled in again");
  s = await state();
  assert.equal(s.controlNotice, null);
  const refused = (await h.call("page.events", { space, page: "p1" })).filter(e => e.method === "Zenius.refused").map(e => e.params);
  assert.equal(refused.length, 1, JSON.stringify(refused));
  assert.equal(refused[0].kind, "permissionPrompt");
  assert.match(refused[0].message, /^http:\/\/127\.0\.0\.1:\d+ asked for storage access after leaving an earlier request unanswered in this task, so the prompt was cancelled without asking the user\./);
});

// zen-core's backstop cancels these before any prompt. The watcher is the
// second line: one that shows anyway goes at once.
test("a request a task's pages never get is cancelled without asking the user, while they hold the task too: persist() from the page's own code", async () => {
  const persist = () =>
    h.call("dev.evalContent", {
      space,
      page: "p1",
      privileged: false,
      code: "window.__persist = null; navigator.storage.persist().then(r => (window.__persist = 'resolved ' + r), e => (window.__persist = 'ERR ' + e.name)); return true;",
    });
  const answer = async () => {
    for (let i = 0; i < 60; i++) {
      const a = await h.call("dev.evalContent", { space, page: "p1", privileged: false, code: "return window.__persist;" });
      if (a !== null) return a;
      await sleep(50);
    }
    return null;
  };
  // From where the tests before left it: the agent's, no prompt open.
  await h.chrome(`${P}
    ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI.forgetHandOffs(rec);
    const n = PN.getNotification("storage-access", browser);
    if (n) PN.remove(n);
    if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    return true;
  `);
  const seen = {};
  try {
    for (const holder of ["agent", "user"]) {
      if (holder === "user") {
        await h.chrome(`${P} ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" }); return true;`);
      }
      await persist();
      const a = await answer();
      const st = await state();
      const out = await h.chrome(`${P}
        const { SitePermissions } = ChromeUtils.importESModule("resource:///modules/SitePermissions.sys.mjs");
        return {
          pending: !!PN.getNotification("persistent-storage", browser),
          stored: SitePermissions.getForPrincipal(browser.contentPrincipal, "persistent-storage", browser).state === SitePermissions.UNKNOWN ? null : "stored",
        };
      `);
      seen[holder] = { answer: a, ownership: st.ownership, reason: st.reason, ...out };
    }
  } finally {
    await h.chrome(`${P} ctx.spaces.setOwnership(rec, "agent", { source: "user" }); return true;`);
  }
  assert.deepEqual(seen, {
    agent: { answer: "resolved false", ownership: "agent", reason: null, pending: false, stored: null },
    user: { answer: "resolved false", ownership: "agentDelegatedToUser", reason: "manual_takeover", pending: false, stored: null },
  });
});

test("a denied prompt that shows anyway in a task's page goes at once, while the user holds the task too, and the agent hears why; the user's own tab keeps it", async () => {
  await h.call("page.events", { space, page: "p1" });
  const ids = ["geolocation", "web-notifications", "persistent-storage", "midi", "webSerial-choosePort", "xr", "webRTC-shareDevices"];
  const out = await h.chrome(`${P}
    const ids = ${JSON.stringify(ids)};
    const show = (b, id) => PN.show(b, id, "Allow?", "geo-notification-icon", { label: "Allow", accessKey: "A", callback() {} }, null, { displayURI: Services.io.newURI("https://maps.example/") });
    const res = { agent: {}, held: {} };
    for (const id of ids) {
      show(browser, id);
      res.agent[id] = { pending: !!PN.getNotification(id, browser), owner: rec.ownership };
    }
    ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });
    try {
      for (const id of ids) {
        show(browser, id);
        res.held[id] = { pending: !!PN.getNotification(id, browser), owner: rec.ownership };
      }
    } finally {
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    }
    // The user's own tab, in their Space.
    const mine = gBrowser.addTab("about:blank", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    try {
      show(mine.linkedBrowser, "geolocation");
      res.mine = !!PN.getNotification("geolocation", mine.linkedBrowser);
    } finally {
      const n = PN.getNotification("geolocation", mine.linkedBrowser);
      if (n) PN.remove(n);
      gBrowser.removeTab(mine, { animate: false });
    }
    return res;
  `);
  const each = owner => Object.fromEntries(ids.map(id => [id, { pending: false, owner }]));
  assert.deepEqual(out.agent, each("agent"));
  assert.deepEqual(out.held, each("agentDelegatedToUser"), "the user's hold doesn't open them");
  assert.equal(out.mine, true, "the user's own tab keeps its prompt");
  const refused = (await h.call("page.events", { space, page: "p1" })).filter(e => e.method === "Zenius.refused").map(e => e.params);
  assert.equal(refused.length, 2 * ids.length, JSON.stringify(refused));
  assert.ok(refused.every(r => r.kind === "promptDenied"), JSON.stringify(refused));
  assert.equal(
    refused[0].message,
    "https://maps.example asked for your location, which a task's pages never get, so the prompt was cancelled without asking the user. If the site takes a typed place instead, type it.",
  );
  assert.equal(refused[1].message, "https://maps.example asked to show notifications, which a task's pages never get, so the prompt was cancelled without asking the user.");
});

test("a prompt that replaces the page's pending one keeps the task with the user", async () => {
  // Firefox replaces a pending prompt with the same id (the page asking
  // again before the user answered): the same handoff, not a second one.
  const out = await h.chrome(`${P}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    UI.forgetHandOffs(rec);
    askStorage();
    const first = rec.ownership;
    askStorage();
    const replaced = { owner: rec.ownership, pending: !!PN.getNotification("storage-access", browser) };
    PN.remove(PN.getNotification("storage-access", browser));
    return { first, replaced, answered: rec.ownership };
  `);
  assert.deepEqual(out, { first: "agentDelegatedToUser", replaced: { owner: "agentDelegatedToUser", pending: true }, answered: "agent" });
});

// The rest play prompts from chrome, each with its own displayURI as a
// requesting page's.
const prompts = () => `${P}
  const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
  const ask = site => askStorage(site);
`;

test("an answered prompt leaves the site able to ask again", async () => {
  const out = await h.chrome(`${prompts()}
    UI.forgetHandOffs(rec);
    const seen = [];
    for (let i = 0; i < 2; i++) {
      const n = ask("https://a.example/");
      seen.push(rec.ownership);
      PN.remove(n); // the user's Allow or Block
      seen.push(rec.ownership);
    }
    return seen;
  `);
  assert.deepEqual(out, ["agentDelegatedToUser", "agent", "agentDelegatedToUser", "agent"]);
});

test("handing back before answering spends the site's handoff", async () => {
  await h.call("page.events", { space, page: "p1" });
  const out = await h.chrome(`${prompts()}
    UI.forgetHandOffs(rec);
    ask("https://b.example/");
    const held = rec.ownership;
    ctx.spaces.setOwnership(rec, "agent", { source: "user" }); // the panel's Resume agent
    ask("https://b.example/"); // the page asks again
    return { held, owner: rec.ownership, pending: !!PN.getNotification("storage-access", browser) };
  `);
  assert.deepEqual(out, { held: "agentDelegatedToUser", owner: "agent", pending: false });
  const refused = (await h.call("page.events", { space, page: "p1" })).filter(e => e.method === "Zenius.refused").map(e => e.params);
  assert.equal(refused.length, 1, JSON.stringify(refused));
  assert.match(refused[0].message, /^https:\/\/b\.example asked for storage access after leaving an earlier request unanswered/);
});

test("after 3 unanswered requests in a task, no page can hand it to the user; the agent's handOff still can", async () => {
  await h.call("page.events", { space, page: "p1" });
  const out = await h.chrome(`${prompts()}
    UI.forgetHandOffs(rec);
    const seen = [];
    for (const site of ["https://c1.example/", "https://c2.example/", "https://c3.example/"]) {
      const n = ask(site);
      seen.push(rec.ownership);
      PN.remove(n, true); // withdrawn, as by a reload
    }
    ask("https://c4.example/");
    const fourth = { owner: rec.ownership, pending: !!PN.getNotification("storage-access", browser) };
    ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" }); // handOff()
    const handOff = rec.ownership;
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    return { seen, fourth, handOff };
  `);
  assert.deepEqual(out.seen, ["agentDelegatedToUser", "agentDelegatedToUser", "agentDelegatedToUser"]);
  assert.deepEqual(out.fourth, { owner: "agent", pending: false }, "a fresh site is refused too");
  assert.equal(out.handOff, "agentDelegatedToUser");
  const refused = (await h.call("page.events", { space, page: "p1" })).filter(e => e.method === "Zenius.refused").map(e => e.params);
  assert.equal(refused.length, 1, JSON.stringify(refused));
  assert.equal(refused[0].message, "https://c4.example asked for storage access, but pages left 3 requests unanswered in this task, so the prompt was cancelled without asking the user. To let them answer it, hand them the task.");
});

// Real requests through Firefox's prompt service, past zen-core's prompt
// backstop (modules/backstops.sys.mjs): ContentPermissionPrompt, its
// Integration override, PermissionUI, PopupNotifications, the watcher. A
// mock nsIContentPermissionRequest stands in for the page's, on the task's
// browser; storage access comes from a cross-site frame.
test("real requests through Firefox's prompt service: storage access and the local network's still hand the task to the user past zen-core's backstop; the rest are cancelled before any doorhanger; while the user holds the task, the kept ones are theirs", async () => {
  // A new document: zen-core tells the agent of each cancelled type once per document.
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/?prompt-service` });
  await h.call("page.events", { space, page: "p1" });
  const out = await h.chrome(`${P}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const service = Cc["@mozilla.org/content-permission/prompt;1"].getService(Ci.nsIContentPermissionPrompt);
    const frame = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(${JSON.stringify(h.base.replace("127.0.0.1", "localhost"))}), {});
    const request = (type, from) => {
      const types = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
      types.appendElement({ QueryInterface: ChromeUtils.generateQI(["nsIContentPermissionType"]), type, options: Cc["@mozilla.org/array;1"].createInstance(Ci.nsIArray) });
      return {
        QueryInterface: ChromeUtils.generateQI(["nsIContentPermissionRequest"]),
        types,
        principal: from,
        topLevelPrincipal: browser.contentPrincipal,
        element: browser,
        hasValidTransientUserGestureActivation: true,
        isHandlingUserInput: true,
        isRequestDelegatedToUnsafeThirdParty: false,
        getDelegatePrincipal: () => from,
        notifyShown() {},
        cancelled: false,
        cancel() { this.cancelled = true; },
        allow() {},
      };
    };
    // Content permission types → their doorhangers' ids.
    const KEPT = { "storage-access": "storage-access", "local-network": "local-network", "loopback-network": "loopback-network" };
    const DENIED = { "persistent-storage": "persistent-storage", geolocation: "geolocation", "desktop-notification": "web-notifications" };
    const res = { agent: {}, user: {} };
    try {
      for (const holder of ["agent", "user"]) {
        for (const [type, id] of Object.entries({ ...KEPT, ...DENIED })) {
          UI.forgetHandOffs(rec);
          if (holder === "agent" && rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
          if (holder === "user" && rec.ownership !== "agentDelegatedToUser") ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });
          const req = request(type, type === "storage-access" ? frame : browser.contentPrincipal);
          service.prompt(req);
          if (type in KEPT) await until(() => PN.getNotification(id, browser), 3000).catch(() => {});
          else await sleep(150);
          const n = PN.getNotification(id, browser);
          res[holder][type] = { shown: !!n, ownership: rec.ownership, reason: rec.reason ?? null, cancelled: req.cancelled };
          if (n) PN.remove(n);
        }
      }
    } finally {
      if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    }
    return res;
  `);
  const handed = reason => ({ shown: true, ownership: "agentDelegatedToUser", reason, cancelled: false });
  const cancelled = (ownership, reason) => ({ shown: false, ownership, reason, cancelled: true });
  assert.deepEqual(out.agent, {
    "storage-access": handed("storage_access"),
    "local-network": handed("local_network_access"),
    "loopback-network": handed("local_network_access"),
    "persistent-storage": cancelled("agent", null),
    geolocation: cancelled("agent", null),
    "desktop-notification": cancelled("agent", null),
  });
  const theirs = { shown: true, ownership: "agentDelegatedToUser", reason: "manual_takeover", cancelled: false };
  assert.deepEqual(out.user, {
    "storage-access": theirs,
    "local-network": theirs,
    "loopback-network": theirs,
    "persistent-storage": cancelled("agentDelegatedToUser", "manual_takeover"),
    geolocation: cancelled("agentDelegatedToUser", "manual_takeover"),
    "desktop-notification": cancelled("agentDelegatedToUser", "manual_takeover"),
  });
  const refused = (await h.call("page.events", { space, page: "p1" })).filter(e => e.method === "Zenius.refused").map(e => e.params);
  assert.ok(refused.length >= 3 && refused.every(r => r.kind === "promptDenied"), `the agent hears of the cancelled ones: ${JSON.stringify(refused)}`);
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
});
