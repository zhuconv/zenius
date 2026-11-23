// Page APIs that would open the operating system's UI over the user's view
// (runtime/JS/zenius/ui/systemui/): notifications and passkeys in a tab the
// agent drives.
//
// Nothing here may show real OS UI on the Mac, where test-all runs headless
// Zen on the user's desktop: cases that would let a native notification or a
// passkey request through run on Linux only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { iso, prelude, setup } from "./lib.mjs";

let h;

/** The site the hold cards name: the fixture's host, isolated as the card's texts are. */
const site = () => iso(new URL(h.base).hostname);
let space;
let P;
let userView;
let linux = false;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  ({ id: space } = await h.createSpace({ name: "zen-ux system UI test" }));
  P = `${prelude(space)}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
    const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    const { systemUiStats: stats } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/systemui/ZeniusSystemUiParent.sys.mjs");
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    const origin = ${JSON.stringify(new URL(h.base).origin)};
    const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);
    const showAgentPage = async () => {
      Pages.landOn(tab);
      await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
      await until(() => gBrowser.selectedTab === tab);
    };
    const backToUserSpace = async () => {
      if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
    };
  `;
  linux = await h.chrome(`
    const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
    return AppConstants.platform === "linux";
  `);
  // Notifications are allowed for the fixture's site, as if the user had
  // allowed them earlier: the case that would show one.
  await h.chrome(`${P} Services.perms.addFromPrincipal(principal, "desktop-notification", Services.perms.ALLOW_ACTION);`);
  await setupPage();
});

/** The fixture page with a button per case, at `url`. */
async function setupPage(url = `${h.base}/`) {
  await h.call("page.goto", { space, page: "p1", url });
  await evaluate(`(() => {
    document.body.innerHTML = "";
    const done = p => p.then(v => (window.__r = v ?? "ok"), e => (window.__r = "ERR " + e.name));
    window.__abort = new AbortController();
    const passkey = extra => done(navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), timeout: 60000 }, ...extra }).then(() => "got"));
    const actions = {
      notify: () => {
        const n = new Notification("Table booked", { body: "7 pm, 4 people", tag: "booking" });
        window.__n = n;
        window.__log = [];
        n.onshow = () => window.__log.push("show");
        n.addEventListener("close", () => window.__log.push("close"));
        window.__r = "made";
      },
      swNotify: () => done(ServiceWorkerRegistration.prototype.showNotification.call({}, "From a worker", { body: "worker body" }).then(() => "resolved")),
      passkey: () => passkey({}),
      passkeyAbortable: () => passkey({ signal: window.__abort.signal }),
      passkeyAutofill: () => passkey({ mediation: "conditional" }),
    };
    for (const [id, fn] of Object.entries(actions)) {
      const b = document.createElement("button");
      b.id = id;
      b.textContent = id;
      b.onclick = fn;
      document.body.append(b, " ");
    }
    return true;
  })()`);
}

after(async () => {
  await h?.chrome(`${P}
    Services.perms.removeFromPrincipal(principal, "desktop-notification");
    if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    await backToUserSpace();
  `).catch(() => {});
  await h?.close();
});

/**
 * Page code, in the page's own world as its scripts run: the window's own
 * eval, called from the page-world sandbox, so the page's builtins (its
 * Object.prototype, its navigator) are the ones used. page.evaluate is the
 * agent's world, where passkeys and notifications are refused outright.
 */
function evaluate(expr) {
  return pageScript(`return window.eval(${JSON.stringify(expr)});`);
}

/** The page's own script: not an agent call, so it runs while the user holds the Space too. */
function pageScript(code) {
  return h.call("dev.evalContent", { space, page: "p1", privileged: false, code });
}

async function agentClick(id) {
  await pageScript("window.__r = undefined; return true;");
  await h.call("page.click", { space, page: "p1", target: `#${id}` });
}

const result = () => pageScript("return window.__r === undefined ? null : String(window.__r);");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const events = async method => (await h.call("page.events", { space, page: "p1" })).filter(e => e.method === method).map(e => e.params);

test("a notification from an agent page shows nothing; the page sees it as shown, and the agent hears of it", async () => {
  const before = await h.chrome(`${P} return { ...stats, alerts: [...Services.wm.getEnumerator("alert:alert")].length };`);
  await agentClick("notify");
  await sleep(300);
  const page = JSON.parse(
    await evaluate(`JSON.stringify({
      r: window.__r,
      log: window.__log,
      isNotification: window.__n instanceof Notification,
      tag: Object.prototype.toString.call(window.__n),
      fields: [window.__n.title, window.__n.body, window.__n.tag],
      permission: Notification.permission,
      requestPermission: typeof Notification.requestPermission,
    })`)
  );
  assert.deepEqual(page, {
    r: "made",
    log: ["show"],
    isNotification: true,
    tag: "[object Notification]",
    fields: ["Table booked", "7 pm, 4 people", "booking"],
    permission: "granted",
    requestPermission: "function",
  });
  await pageScript("window.__n.close(); return true;");
  assert.deepEqual(JSON.parse(await pageScript("return JSON.stringify(window.__log);")), ["show", "close"]);
  const after = await h.chrome(`${P} return { ...stats, alerts: [...Services.wm.getEnumerator("alert:alert")].length };`);
  assert.equal(after.notifications, before.notifications + 1);
  assert.equal(after.alerts, before.alerts, "no alert window");
  const heard = (await events("Zenius.notification")).at(-1);
  assert.deepEqual({ ...heard, url: undefined }, { title: "Table booked", body: "7 pm, 4 people", tag: "booking", url: undefined });
  assert.ok(heard.url.startsWith(h.base));
});

test("registration.showNotification() from an agent page shows nothing either", async () => {
  await agentClick("swNotify");
  await sleep(200);
  assert.equal(await result(), "resolved");
  const heard = (await events("Zenius.notification")).at(-1);
  assert.equal(heard.title, "From a worker");
  assert.equal(heard.body, "worker body");
});

test("in a tab the user holds, notification calls are the page's own again", async () => {
  // The native call here fails at once (no worker behind `this`), so no
  // notification shows anywhere: it only proves the guard stepped aside.
  await h.chrome(`${P} ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });`);
  try {
    const r = await pageScript(
      `return ServiceWorkerRegistration.prototype.showNotification.call({}, "The user's own").then(() => "resolved", e => "ERR " + e.name);`
    );
    assert.equal(r, "ERR TypeError");
  } finally {
    await h.chrome(`${P} ctx.spaces.setOwnership(rec, "agent", { source: "user" });`);
  }
});

test("a passkey request waits for the user: the Space is theirs, and the request runs once they see the page", async () => {
  const before = await h.chrome(`${P} UI.forgetHandOffs(rec); return { ...stats };`);
  await agentClick("passkey");
  await sleep(400);
  assert.equal(await result(), null, "still waiting");
  const held = await h.chrome(`${P}
    return { owner: rec.ownership, reason: rec.reason, pill: N.noticeText(tab, "zenius-control"), stats: { ...stats } };
  `);
  assert.equal(held.owner, "agentDelegatedToUser");
  assert.equal(held.reason, "permission_prompt");
  assert.equal(held.pill, `Agent paused · page asks for a passkey on ${site()}`);
  assert.equal(held.stats.passkeyHeld, before.passkeyHeld + 1);
  const call = await h.call("page.click", { space, page: "p1", target: "#passkey" }).then(
    () => "ok",
    e => e.code
  );
  assert.equal(call, "ZEN_TASK_SPACE_USER_IN_CONTROL", "the agent waits too");
  if (!linux) {
    // On the Mac the native request could open macOS's passkey sheet: end it
    // the other way, by handing back.
    await h.chrome(`${P} ctx.spaces.setOwnership(rec, "agent", { source: "user" });`);
    await sleep(400);
    assert.equal(await result(), "ERR NotAllowedError");
    return;
  }
  // The user opens the Space and sees the page: the request runs (the Linux server has no
  // authenticator, so it fails natively), and the Space goes back to the agent.
  const after = await h.chrome(`${P}
    await showAgentPage();
    await until(() => stats.passkeyGo > ${before.passkeyGo}, 3000);
    await until(() => rec.ownership === "agent", 5000);
    await backToUserSpace();
    return { owner: rec.ownership, stats: { ...stats } };
  `);
  assert.equal(after.stats.passkeyGo, before.passkeyGo + 1);
  assert.equal(after.owner, "agent", "back to the agent once the request settled");
  assert.match(await result(), /^ERR /);
});

test("a passkey request is refused when the user hands back without looking", async () => {
  const before = await h.chrome(`${P} UI.forgetHandOffs(rec); return { ...stats };`);
  await agentClick("passkey");
  await sleep(300);
  await h.chrome(`${P}
    await until(() => rec.ownership === "agentDelegatedToUser");
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
  `);
  await sleep(400);
  assert.equal(await result(), "ERR NotAllowedError");
  const after = await h.chrome(`${P} return { owner: rec.ownership, stats: { ...stats } };`);
  assert.equal(after.owner, "agent");
  assert.equal(after.stats.passkeyRefused, before.passkeyRefused + 1);
  assert.equal(after.stats.passkeyGo, before.passkeyGo);
});

test("an aborted passkey request ends the hold", async () => {
  await h.chrome(`${P} UI.forgetHandOffs(rec);`);
  await agentClick("passkeyAbortable");
  await h.chrome(`${P} await until(() => rec.ownership === "agentDelegatedToUser");`);
  await pageScript("window.__abort.abort(); return true;");
  await sleep(400);
  assert.equal(await result(), "ERR AbortError");
  assert.equal(await h.chrome(`${P} await until(() => rec.ownership === "agent", 3000); return rec.ownership;`), "agent");
});

test("passkey autofill (conditional mediation) passes through without a hold", async t => {
  if (!linux) {
    t.skip("it makes a native passkey request (Linux only)");
    return;
  }
  const before = await h.chrome(`${P} return { ...stats };`);
  await agentClick("passkeyAutofill");
  await sleep(300);
  const after = await h.chrome(`${P} return { owner: rec.ownership, stats: { ...stats } };`);
  assert.equal(after.owner, "agent");
  assert.equal(after.stats.passkeyHeld, before.passkeyHeld);
});

test("a site that left a passkey request unanswered can't hand the task over again, by passkey or prompt; another site still can", async () => {
  // The page withdraws its own request (an abort), which hands the task
  // back: the loop a page could otherwise repeat at will.
  await setupPage(); // a fresh AbortController
  await h.chrome(`${P} UI.forgetHandOffs(rec);`);
  await events("Zenius.refused");
  await agentClick("passkeyAbortable");
  await h.chrome(`${P} await until(() => rec.ownership === "agentDelegatedToUser");`);
  await pageScript("window.__abort.abort(); return true;");
  await h.chrome(`${P} await until(() => rec.ownership === "agent", 3000);`);
  const before = await h.chrome(`${P} return { ...stats };`);
  await agentClick("passkey");
  await sleep(300);
  assert.equal(await result(), "ERR NotAllowedError", "refused as a cancelled request is");
  const after = await h.chrome(`${P} return { owner: rec.ownership, pill: N.noticeText(tab, "zenius-control"), stats: { ...stats } };`);
  assert.equal(after.owner, "agent", "the user isn't pulled in again");
  assert.equal(after.pill, null);
  assert.equal(after.stats.passkeyHeld, before.passkeyHeld);
  assert.equal(after.stats.passkeyRefused, before.passkeyRefused + 1);
  // Nor by a permission prompt: one budget for both. A storage access prompt,
  // one of the two kinds a task's pages may still hand to the user, raised
  // from chrome for the page's own origin, as a cross-site sign-in frame's
  // would be (tests/ux/permissions.test.mjs).
  const prompt = await h.chrome(`${P}
    const PN = win.PopupNotifications;
    PN.show(browser, "storage-access", "Allow the sign-in frame to use its cookies here?", "storage-access-notification-icon", { label: "Allow", accessKey: "A", callback() {} }, null, {});
    return { owner: rec.ownership, pending: !!PN.getNotification("storage-access", browser) };
  `);
  assert.deepEqual(prompt, { owner: "agent", pending: false }, "the prompt is cancelled at once");
  const refused = await events("Zenius.refused");
  assert.deepEqual(refused.map(r => r.kind), ["passkey", "permissionPrompt"], JSON.stringify(refused));
  assert.match(refused[0].message, /^http:\/\/127\.0\.0\.1:\d+ asked for a passkey after leaving an earlier request unanswered in this task, so the page got NotAllowedError without asking the user\. To let them answer it, hand them the task\.$/);
  assert.match(refused[1].message, /^http:\/\/127\.0\.0\.1:\d+ asked for storage access after leaving an earlier request unanswered in this task, so the prompt was cancelled/);
  // Another origin in the same task still gets its handoff.
  try {
    await setupPage(`${h.base.replace("127.0.0.1", "localhost")}/`);
    await agentClick("passkeyAbortable");
    const held = await h.chrome(`${P} await until(() => rec.ownership === "agentDelegatedToUser"); return rec.ownership;`);
    assert.equal(held, "agentDelegatedToUser");
    await pageScript("window.__abort.abort(); return true;");
    await h.chrome(`${P} await until(() => rec.ownership === "agent", 3000);`);
  } finally {
    await h.chrome(`${P} if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });`);
    await setupPage();
  }
});

test("a passkey request the user answered leaves the site able to ask again", async t => {
  if (!linux) {
    t.skip("the user's answer is a native passkey request (Linux only)");
    return;
  }
  await h.chrome(`${P} UI.forgetHandOffs(rec);`);
  for (const round of [1, 2]) {
    await agentClick("passkey");
    const out = await h.chrome(`${P}
      await until(() => rec.ownership === "agentDelegatedToUser");
      const before = stats.passkeyGo;
      // The user opens the Space: the request runs (the Linux server has no
      // authenticator, so it fails as a cancelled sheet does).
      await showAgentPage();
      await until(() => stats.passkeyGo > before, 3000);
      await until(() => rec.ownership === "agent", 5000);
      await backToUserSpace();
      return rec.ownership;
    `);
    assert.equal(out, "agent", `round ${round}: held, answered, and back to the agent`);
    assert.match(await result(), /^ERR /);
  }
});

test("the system UI parent ignores messages from pages that aren't a task's, and checks the rest", async () => {
  await events("Zenius.notification");
  const out = await h.chrome(`${P}
    const actorFor = b => b.browsingContext.currentWindowGlobal.getActor("ZeniusSystemUi");
    const mine = actorFor(gBrowser.selectedTab.linkedBrowser);
    const theirs = actorFor(browser);
    const before = stats.notifications;
    const res = {
      userNote: mine.receiveMessage({ name: "notification", data: { title: "FORGED" } }),
      userPasskey: mine.receiveMessage({ name: "passkey", data: { id: "x" } }),
      oddPasskey: theirs.receiveMessage({ name: "passkey", data: { id: 7 } }),
      noData: theirs.receiveMessage({ name: "passkey", data: null }),
    };
    theirs.receiveMessage({ name: "notification", data: { title: "T", body: { toString: () => "B" }, url: "https://elsewhere.example/" } });
    res.counted = stats.notifications - before;
    return res;
  `);
  assert.equal(out.userNote, null);
  assert.deepEqual(out.userPasskey, { go: true }, "a user tab's request is its own");
  assert.deepEqual(out.oddPasskey, { go: false });
  assert.deepEqual(out.noData, { go: false });
  assert.equal(out.counted, 1);
  const notes = await events("Zenius.notification");
  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.equal(notes[0].title, "T");
  assert.equal(notes[0].body, "", "only strings count");
  assert.ok(notes[0].url.startsWith(h.base), `the parent's own URL: ${notes[0].url}`);
});

test("the quiet Notification's handler has no prototype a page could add traps to", async () => {
  const out = await evaluate(`(() => {
    Object.defineProperty(Object.prototype, "get", { value: () => "trapped", configurable: true, writable: true });
    try {
      return [Notification.permission, typeof Notification.requestPermission];
    } finally {
      delete Object.prototype.get;
    }
  })()`);
  assert.deepEqual(out, ["granted", "function"]);
});

test("the pill follows the task's record, not an event's word for it", async () => {
  // A spaceChanged whose params contradict the record (as a forged one
  // would) changes nothing the user sees.
  const out = await h.chrome(`${P}
    if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    ctx.service.emitLocal("spaceChanged", { space: rec.id, ownership: "agentDelegatedToUser", source: "bogus", reason: "manual_takeover" });
    return { owner: rec.ownership, pill: N.noticeText(tab, "zenius-control"), badge: UI.badgeFor(rec)?.state ?? null };
  `);
  assert.deepEqual(out, { owner: "agent", pill: null, badge: out.badge });
  assert.notEqual(out.badge, "needs-user");
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
