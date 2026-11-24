// Permission prompts in agent pages (runtime/JS/zenius/ui/permissions.sys.mjs),
// on evidence only. While the agent drives, a page's prompt puts the Space
// under the user's control with Ego's reason key, waits in the background for
// the user to open the Space, and gives control back once answered. During the
// user's hold it's theirs. On evidence of danger in the page it's cancelled,
// held or not; the camera, microphone and screen's is cancelled while the agent
// drives.
//
// The prompts that hand off need a cross-site frame, or a public page asking
// for a private address, to come up for real, so these tests raise them from
// chrome with the requesting origin as displayURI, as PermissionUI does: the
// watcher only sees PopupNotifications either way. persist() and the
// prompt service's requests raise them for real, through zen-observe's
// backstops, which cancel them only on evidence (their commit C): those tests
// give the page real evidence (the flag is per document) and end on a new load.
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
  // No page has evidence of danger unless a test says so (zen-observe's
  // flag, which their suites test).
  await h.chrome(`${P} ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI.evidenceOf = () => ({}); return true;`);
});

after(async () => {
  await h?.chrome(`${P}
    ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI.evidenceOf = null;
    for (const id of ["storage-access", "geolocation", "persistent-storage", "password"]) {
      const n = PN.getNotification(id, browser);
      if (n) PN.remove(n);
    }
  `).catch(() => {});
  await h?.close();
});

const state = () => h.call("ui.state", { space });
const sleep = ms => new Promise(r => setTimeout(r, ms));

test("the prompts a task's pages hand to the user, with Ego's reason keys (its catch-all for those without one), and the devices' prompt, which is never the agent's", async () => {
  const out = await h.chrome(`${P}
    const ids = ["storage-access", "local-network", "loopback-network", "geolocation", "web-notifications", "persistent-storage", "midi", "webSerial-choosePort", "xr", "webRTC-shareDevices", "password"];
    return Object.fromEntries(ids.map(id => [id, Perm.reasonFor(id) ?? (Perm.isDevicePrompt(id) ? "device" : null)]));
  `);
  assert.deepEqual(out, {
    "storage-access": "storage_access",
    "local-network": "local_network_access",
    "loopback-network": "local_network_access",
    geolocation: "location",
    "web-notifications": "notifications",
    "persistent-storage": "permission_prompt",
    midi: "midi",
    "webSerial-choosePort": "serial",
    xr: "permission_prompt",
    "webRTC-shareDevices": "device",
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
  assert.equal(s.controlNotice, `Agent paused · page asks for storage access on ${site()}`);
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

// On the Mac, after Open in the tasks panel no prompt showed. Firefox shows
// a background tab's prompt when the tab is selected, unless it suppresses
// doorhangers at that moment, and then only something that re-checks shows
// it. The test plays that miss: suppression during the switch, and a prompt
// the user had clicked away.
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

// zen-observe's backstop (their C) cancels persist() before any prompt only in
// a page with evidence of danger, held or not; otherwise the prompt shows. The
// page gets real evidence for the last two cases: the flag is per document,
// so they come last, and the test ends on a new load.
test("persist() from the page's own code: while the agent drives, its prompt hands the task to the user; during their hold it's theirs; on evidence of danger it's cancelled without asking, held or not", async () => {
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
  const reset = () =>
    h.chrome(`${P}
      ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI.forgetHandOffs(rec);
      for (const id of ["storage-access", "persistent-storage"]) {
        const n = PN.getNotification(id, browser);
        if (n) PN.remove(n);
      }
      if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      return true;
    `);
  const look = async () => {
    const st = await state();
    const out = await h.chrome(`${P} return !!PN.getNotification("persistent-storage", browser);`);
    return { ownership: st.ownership, reason: st.reason, pending: out };
  };
  const seen = {};
  try {
    for (const [name, evident, held] of [["agent", false, false], ["held", false, true], ["evidentAgent", true, false], ["evidentHeld", true, true]]) {
      await reset();
      await h.chrome(`${P}
        if (${evident}) {
          const { markEvident, isEvident } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");
          markEvident(browser, "flagged", "zen-ux's permissions test");
          if (!isEvident(browser)) throw new Error("the page has no evidence");
        }
        if (${held}) ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });
        return true;
      `);
      await persist();
      if (evident) {
        seen[name] = { answer: await answer(), ...(await look()) };
      } else {
        let st = await look();
        for (let i = 0; i < 40 && !st.pending; i++) {
          await sleep(50);
          st = await look();
        }
        seen[name] = st;
        if (name === "agent") {
          // Ego's catch-all key, with the prompt's own words.
          seen.notice = (await state()).controlNotice;
        }
      }
    }
  } finally {
    await reset();
    await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  }
  assert.deepEqual(seen, {
    agent: { ownership: "agentDelegatedToUser", reason: "permission_prompt", pending: true },
    held: { ownership: "agentDelegatedToUser", reason: "manual_takeover", pending: true },
    evidentAgent: { answer: "resolved false", ownership: "agent", reason: null, pending: false },
    evidentHeld: { answer: "resolved false", ownership: "agentDelegatedToUser", reason: "manual_takeover", pending: false },
    notice: `Agent paused · page asks for persistent storage on ${site()}`,
  });
});

test("a permission prompt in a task's page: while the agent drives it hands the task to the user with its reason; during their hold it's theirs; on evidence of danger it goes at once, held or not, and the agent hears why; the camera, microphone, screen or speakers' goes at once while the agent drives and is the user's in their hold; the user's own tab keeps its prompts", async () => {
  await h.call("page.events", { space, page: "p1" });
  const reasons = { geolocation: "location", "web-notifications": "notifications", "persistent-storage": "permission_prompt", midi: "midi", "webSerial-choosePort": "serial", xr: "permission_prompt" };
  const DEV = "webRTC-shareDevices";
  const out = await h.chrome(`${P}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const ids = ${JSON.stringify(Object.keys(reasons))};
    const DEV = ${JSON.stringify(DEV)};
    const show = (b, id) => PN.show(b, id, "Allow?", "geo-notification-icon", { label: "Allow", accessKey: "A", callback() {} }, null, { displayURI: Services.io.newURI("https://maps.example/") });
    const drop = (b, id) => {
      const n = PN.getNotification(id, b);
      if (n) PN.remove(n);
    };
    const toAgent = () => {
      if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    };
    const hold = () => ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });
    const look = id => ({ pending: !!PN.getNotification(id, browser), owner: rec.ownership, reason: rec.reason ?? null });
    const res = { agent: {}, held: {}, evident: {}, evidentHeld: {} };
    try {
      UI.evidenceOf = () => ({});
      for (const id of [...ids, DEV]) {
        UI.forgetHandOffs(rec);
        toAgent();
        show(browser, id);
        res.agent[id] = look(id);
        drop(browser, id);
      }
      toAgent();
      hold();
      for (const id of [...ids, DEV]) {
        show(browser, id);
        res.held[id] = look(id);
        drop(browser, id);
      }
      toAgent();
      UI.evidenceOf = b => (b === browser ? { hooked: "a script element" } : {});
      for (const id of ["geolocation", "storage-access", DEV]) {
        UI.forgetHandOffs(rec);
        show(browser, id);
        res.evident[id] = look(id);
        drop(browser, id);
      }
      hold();
      for (const id of ["geolocation", DEV]) {
        show(browser, id);
        res.evidentHeld[id] = look(id);
        drop(browser, id);
      }
    } finally {
      UI.evidenceOf = () => ({});
      UI.forgetHandOffs(rec);
      toAgent();
    }
    // The user's own tab, in their Space.
    const mine = gBrowser.addTab("about:blank", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    try {
      show(mine.linkedBrowser, "geolocation");
      res.mine = !!PN.getNotification("geolocation", mine.linkedBrowser);
    } finally {
      drop(mine.linkedBrowser, "geolocation");
      gBrowser.removeTab(mine, { animate: false });
    }
    return res;
  `);
  const handed = Object.fromEntries(Object.entries(reasons).map(([id, reason]) => [id, { pending: true, owner: "agentDelegatedToUser", reason }]));
  assert.deepEqual(out.agent, { ...handed, [DEV]: { pending: false, owner: "agent", reason: null } }, "while the agent drives");
  const theirs = { pending: true, owner: "agentDelegatedToUser", reason: "manual_takeover" };
  assert.deepEqual(out.held, Object.fromEntries([...Object.keys(reasons), DEV].map(id => [id, theirs])), "in the user's hold");
  const gone = { pending: false, owner: "agent", reason: null };
  assert.deepEqual(out.evident, { geolocation: gone, "storage-access": gone, [DEV]: gone }, "on evidence, while the agent drives");
  const goneHeld = { pending: false, owner: "agentDelegatedToUser", reason: "manual_takeover" };
  assert.deepEqual(out.evidentHeld, { geolocation: goneHeld, [DEV]: goneHeld }, "on evidence, in the user's hold");
  assert.equal(out.mine, true, "the user's own tab keeps its prompt");
  const refused = (await h.call("page.events", { space, page: "p1" })).filter(e => e.method === "Zenius.refused").map(e => e.params);
  assert.ok(refused.every(r => r.kind === "promptDenied"), JSON.stringify(refused));
  assert.deepEqual(
    refused.map(r => r.message),
    [
      "https://maps.example asked for the camera, microphone, screen or speakers, which the agent never gets, so the prompt was cancelled without asking the user. The user can allow it while they hold the task.",
      "https://maps.example asked for your location, and zenius holds evidence of danger in this page, so the prompt was cancelled without asking the user. If the site takes a typed place instead, type it.",
      "https://maps.example asked for storage access, and zenius holds evidence of danger in this page, so the prompt was cancelled without asking the user.",
      "https://maps.example asked for the camera, microphone, screen or speakers, and zenius holds evidence of danger in this page, so the prompt was cancelled without asking the user.",
      "https://maps.example asked for your location, and zenius holds evidence of danger in this page, so the prompt was cancelled without asking the user. If the site takes a typed place instead, type it.",
      "https://maps.example asked for the camera, microphone, screen or speakers, and zenius holds evidence of danger in this page, so the prompt was cancelled without asking the user.",
    ],
  );
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

// Real requests through Firefox's prompt service, past zen-observe's prompt
// backstop (modules/backstops.sys.mjs): ContentPermissionPrompt, its
// Integration override, PermissionUI, PopupNotifications, the watcher. A
// mock nsIContentPermissionRequest stands in for the page's, on the task's
// browser; storage access comes from a cross-site frame. The page gets real
// evidence for the last cases, so the override is what cancels them (their
// C); the watcher's own cancel is the test before.
test("real requests through Firefox's prompt service, past zen-observe's backstops: while the agent drives, each hands the task to the user with its reason; while the user holds the task, each is theirs; on evidence of danger, each is cancelled before any doorhanger, held or not", async () => {
  // A new document: zen-core tells the agent of each cancelled type once per document.
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/?prompt-service` });
  await h.call("page.events", { space, page: "p1" });
  const out = await h.chrome(`${P}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const { markEvident, isEvident } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");
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
    const TYPES = {
      "storage-access": "storage-access",
      "local-network": "local-network",
      "loopback-network": "loopback-network",
      "persistent-storage": "persistent-storage",
      geolocation: "geolocation",
      "desktop-notification": "web-notifications",
    };
    const res = { agent: {}, user: {}, evidentAgent: {}, evidentUser: {} };
    try {
      for (const [name, holder, evident] of [["agent", "agent", false], ["user", "user", false], ["evidentAgent", "agent", true], ["evidentUser", "user", true]]) {
        if (evident && !isEvident(browser)) {
          markEvident(browser, "flagged", "zen-ux's permissions test");
          if (!isEvident(browser)) throw new Error("the page has no evidence");
        }
        for (const [type, id] of Object.entries(TYPES)) {
          UI.forgetHandOffs(rec);
          if (holder === "agent" && rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
          if (holder === "user" && rec.ownership !== "agentDelegatedToUser") ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });
          const req = request(type, type === "storage-access" ? frame : browser.contentPrincipal);
          service.prompt(req);
          if (!evident) await until(() => PN.getNotification(id, browser), 3000).catch(() => {});
          else await sleep(150);
          const n = PN.getNotification(id, browser);
          res[name][type] = { shown: !!n, ownership: rec.ownership, reason: rec.reason ?? null, cancelled: req.cancelled };
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
    "persistent-storage": handed("permission_prompt"),
    geolocation: handed("location"),
    "desktop-notification": handed("notifications"),
  });
  const theirs = { shown: true, ownership: "agentDelegatedToUser", reason: "manual_takeover", cancelled: false };
  const types = Object.keys(out.agent);
  assert.deepEqual(out.user, Object.fromEntries(types.map(t => [t, theirs])));
  assert.deepEqual(out.evidentAgent, Object.fromEntries(types.map(t => [t, cancelled("agent", null)])));
  assert.deepEqual(out.evidentUser, Object.fromEntries(types.map(t => [t, cancelled("agentDelegatedToUser", "manual_takeover")])));
  const refused = (await h.call("page.events", { space, page: "p1" })).filter(e => e.method === "Zenius.refused").map(e => e.params);
  assert.ok(refused.length >= 1 && refused.every(r => r.kind === "promptDenied"), `the agent hears of the cancelled ones: ${JSON.stringify(refused)}`);
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
});
