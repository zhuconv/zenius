// The site's storage that outlives the task (content/refusals.sys.mjs and
// content/workerguard.js; docs/research/own-tab.md, item 3). In every
// document of an agent task's pages, and in the workers they start,
// serviceWorker.register() and Cache's put, add and addAll reject with
// SecurityError for the task's life, the user's hold included, so nothing
// lands in the user's profile. A page the task kept is the user's again.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "../observe/lib.mjs";
import { startVectorServer } from "../observe/vectors/fixture.mjs";

let env;
let vectors;
before(async () => {
  env = await setup();
  vectors = await startVectorServer();
  // Code planted before a hand-off stays in the page: these tests check the refusals it meets during the hold (zen-core's glue).
  await env.chrome(`Services.prefs.setBoolPref("zenius.handoff.quietReload", false); return true;`);
});
after(async () => {
  await env?.chrome(`Services.prefs.clearUserPref("zenius.handoff.quietReload"); return true;`).catch(() => {});
  vectors?.server.close();
  await env?.close();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
// The fixture's vectors are the page's own code (window.__vectors), and keep
// their outcomes in the page (window.__vectorResults): the agent's code,
// which runs in its isolated world, sees neither, so these go through
// dev.evalContent, in the page's own JavaScript.
const results = (page, id) =>
  env.call("dev.evalContent", { ...page.P, code: `JSON.stringify(window.__vectorResults[${JSON.stringify(id)}] ?? null)` }).then(JSON.parse);
/** Run the page's vectors after an agent call, as the agent's code once started them in the page itself. */
const runVectors = async (page, code) => {
  await page.evaluate("1");
  return env.call("dev.evalContent", { ...page.P, code });
};
const refusedEvents = async page => (await page.call("page.events")).filter(e => e.method === "Zenius.refused").map(e => e.params);

async function until(what, fn, ms = 8000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    last = await fn();
    if (last) {
      return last;
    }
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

/** Each vector's outcomes once it has as many as `counts` says. */
async function outcomes(page, counts) {
  const out = {};
  for (const [id, count] of Object.entries(counts)) {
    out[id] = await until(id, async () => {
      const r = await results(page, id);
      return r?.length >= count ? r : null;
    });
  }
  return out;
}

const STORAGE = {
  "sw-register": 1,
  "cache-write": 3,
  "storage-fresh-frame": 2,
  "worker-storage": 2,
  "nested-worker-storage": 2,
  "shared-worker-storage": 2,
};
const refusedAll = counts => Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, Array(n).fill("SecurityError")]));

/** What the fixture's origin left in the profile: service worker scopes, and Cache Storage entries. */
async function leftovers(page) {
  const scopes = await env.chrome(
    `const swm = Cc["@mozilla.org/serviceworkers/manager;1"].getService(Ci.nsIServiceWorkerManager);
     const regs = swm.getAllRegistrations();
     const out = [];
     for (let i = 0; i < regs.length; i++) {
       const r = regs.queryElementAt(i, Ci.nsIServiceWorkerRegistrationInfo);
       if (r.scope.startsWith(arg)) out.push(r.scope);
     }
     return out;`,
    vectors.base
  );
  const cached = JSON.parse(
    await page.evaluate(`caches.open("zenius-vectors").then(c => c.keys()).then(k => JSON.stringify(k.map(r => r.url)))`)
  );
  return { scopes, cached };
}

test("an agent task's pages register no service worker and write no Cache Storage, fresh frames and workers included", () =>
  env.inSpace("storage", async page => {
    await page.goto(`${vectors.base}/vectors`);
    await page.call("page.events");
    await runVectors(page, `setTimeout(() => { for (const id of ${JSON.stringify(Object.keys(STORAGE))}) window.__vectors[id](); }, 0); 1`);
    assert.deepEqual(await outcomes(page, STORAGE), refusedAll(STORAGE));
    assert.deepEqual(await leftovers(page), { scopes: [], cached: [] });

    const events = await refusedEvents(page);
    // Once per document and kind (the page, the fresh frame), and once per
    // worker and kind (the worker, the nested one, the shared one).
    const pageLines = events.filter(e => e.message.startsWith("The page tried"));
    const workerLines = events.filter(e => e.message.startsWith("A worker the page started (blob:"));
    assert.deepEqual(pageLines.map(e => e.kind).sort(), ["cacheStorage", "cacheStorage", "serviceWorker", "serviceWorker"]);
    assert.deepEqual(workerLines.map(e => e.kind).sort(), [
      "cacheStorage",
      "cacheStorage",
      "cacheStorage",
      "serviceWorker",
      "serviceWorker",
      "serviceWorker",
    ]);
    assert.equal(events.length, pageLines.length + workerLines.length, JSON.stringify(events));
    assert.ok(
      pageLines.some(e => e.message.startsWith("The page tried to register a service worker (/sw.js). It would stay in the user's profile")),
      JSON.stringify(pageLines)
    );
    assert.ok(pageLines.some(e => e.message.startsWith("The page tried to write to the site's Cache Storage (Cache.put).")));
    // The page goes on working: reading the site's caches isn't refused.
    assert.equal(await page.evaluate(`caches.has("zenius-vectors").then(String)`), "true");
    await page.evaluate(`caches.delete("zenius-vectors").then(String)`);
  }));

test("a popup's first document is refused at once: its natives, grabbed before the popup is the task's, and its worker", () =>
  env.inSpace("storage popup", async page => {
    await page.goto(`${vectors.base}/vectors`);
    await page.call("page.click", { target: "#v-popup-storage" });
    const out = await outcomes(page, { "popup-storage": 4 });
    assert.deepEqual(out["popup-storage"].slice().sort(), ["SecurityError", "SecurityError", "SecurityError", "SecurityError"], JSON.stringify(out));
    assert.deepEqual(await leftovers(page), { scopes: [], cached: [] });
    await page.evaluate(`caches.delete("zenius-vectors").then(String)`);
  }));

test("a fresh popup's frames are refused before the popup is the task's, and clearing its opener changes nothing", () =>
  env.inSpace("storage popup frames", async page => {
    await page.goto(`${vectors.base}/vectors`);
    await page.call("page.click", { target: "#v-popup-frame-storage" });
    await page.call("page.click", { target: "#v-popup-opener-null" });
    assert.deepEqual(await outcomes(page, { "popup-frame-storage": 2, "popup-opener-null": 2 }), {
      "popup-frame-storage": ["SecurityError", "SecurityError"],
      "popup-opener-null": ["SecurityError", "SecurityError"],
    });
    assert.deepEqual(await leftovers(page), { scopes: [], cached: [] });
    await page.evaluate(`caches.delete("zenius-vectors").then(String)`);
  }));

/** A tab of the user's (not the agent's) on `url`, marked `mark`, and code run in its page. */
const userTab = {
  open: (url, mark) =>
    env.chrome(
      `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
       const { setTimeout: later } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
       const ws = win.gZenWorkspaces.getWorkspaces().find(w => !ctx.spaces.isAgentsSpace(w.uuid))?.uuid;
       const t = W.addBackgroundTab(win, ws);
       t.setAttribute(arg.mark, "1");
       const uri = Services.io.newURI(arg.url);
       t.linkedBrowser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, {}) });
       for (const end = Date.now() + 10000; ; await new Promise(r => later(r, 50))) {
         const b = t.linkedBrowser;
         if (b.currentURI?.spec === arg.url && !b.webProgress?.isLoadingDocument) return true;
         if (Date.now() > end) throw new Error("the user's tab didn't load");
       }`,
      { url, mark }
    ),
  run: (mark, code) =>
    env.chrome(
      `const tab = [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].find(t => t.hasAttribute(arg.mark));
       if (!tab) throw new Error("the user's tab is gone");
       return ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", { code: arg.code });`,
      { mark, code }
    ),
  close: mark =>
    env.chrome(
      `for (const t of [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].filter(t => t.hasAttribute(arg))) win.gBrowser.removeTab(t);
       return true;`,
      mark
    ),
};

test("a task's page gets a shared worker of its own: the user's tab's worker never writes for it, and still works for the user", async () => {
  const mark = `zo-user-shared-${Date.now()}`;
  try {
    await userTab.open(`${vectors.base}/plain?user`, mark);
    const ask = `const w = (window.__cacheSync ??= new SharedWorker("/shared-cache.js", "cache-sync"));
      return await new Promise(r => { w.port.onmessage = e => r(e.data); w.port.postMessage({ cache: "zenius-vectors", url: location.origin + "/plain?" + arg, body: "the user's" }); });`;
    const asUser = code => userTab.run(mark, `const arg = "users-own"; ${code}`);
    assert.equal(await asUser(ask), "stored", "the user's own worker writes for the user");
    await env.inSpace("storage user shared", async page => {
      await page.goto(`${vectors.base}/vectors`);
      await runVectors(page, `window.__vectors["user-shared-worker"](); window.__vectors["shared-constructor-storage"](); 1`);
      assert.deepEqual(await outcomes(page, { "user-shared-worker": 1, "shared-constructor-storage": 2 }), {
        "user-shared-worker": ["SecurityError"],
        "shared-constructor-storage": ["SecurityError", "SecurityError"],
      });
      const events = await refusedEvents(page);
      assert.ok(
        events.some(e => e.kind === "cacheStorage" && e.message.startsWith("A worker the page started (http") && /\/shared-cache\.js#zenius-task-\d+/.test(e.message)),
        JSON.stringify(events)
      );
    });
    // The user's worker, still connected, still works for the user; the
    // agent's request never reached it.
    assert.equal(await asUser(ask), "stored");
    assert.deepEqual(
      JSON.parse(await asUser(`const c = await caches.open("zenius-vectors"); return JSON.stringify((await c.keys()).map(r => new URL(r.url).search).sort());`)),
      ["?users-own"]
    );
  } finally {
    await userTab.run(mark, `await caches.delete("zenius-vectors"); return true;`).catch(() => {});
    await userTab.close(mark).catch(() => {});
  }
});

/**
 * Worker code: what a task page's worker reaches of the site's service
 * worker. Where it gets the worker, it asks it to fetch /hit?<tag> (the
 * site's worker does that on a message).
 */
const workerReach = (origin, tag) => `(async () => {
  const within = (p, what) => Promise.race([p, new Promise(r => setTimeout(() => r("no answer: " + what), 3000))]);
  const ask = { fetch: ${JSON.stringify(origin)} + "/hit?" + ${JSON.stringify(tag)} };
  const out = { container: typeof navigator.serviceWorker };
  const c = navigator.serviceWorker.controller;
  out.controller = c ? "a worker" : String(c);
  if (c) c.postMessage(ask);
  const reg = await within(navigator.serviceWorker.getRegistration(${JSON.stringify(origin + "/plain")}), "getRegistration");
  out.registration = String(reg);
  if (reg && reg.active) reg.active.postMessage(ask);
  out.registrations = (await within(navigator.serviceWorker.getRegistrations(), "getRegistrations")).length;
  out.ready = await Promise.race([navigator.serviceWorker.ready.then(() => "settled"), new Promise(r => setTimeout(() => r("pending"), 500))]);
  try { out.postMessage = String(ServiceWorker.prototype.postMessage.call(null, ask)); } catch (e) { out.postMessage = e.name; }
  return JSON.stringify(out);
})()`;

test("a task's pages don't use the site's service worker that the user's tab registered: it sees none of their requests, they and their workers can't reach it, and the user's tab still uses it", async () => {
  const mark = `zo-sw-site-${Date.now()}`;
  /** What the worker saw of the task's requests: it counts each one on /hit?sw-saw-<path and query>. */
  const sawTask = () => Object.keys(vectors.stats.hits).filter(k => k.startsWith("sw-saw-") && k.includes("sw-task"));
  const viaWorker = `const r = await fetch("/sw-intercept"); return r.status + " " + await r.text();`;
  try {
    await userTab.open(`${vectors.base}/plain?sw-user`, mark);
    // The user's tab registers the site's worker, which takes the site's pages at once.
    assert.equal(
      await userTab.run(
        mark,
        `await navigator.serviceWorker.register("/sw-site.js");
         await navigator.serviceWorker.ready;
         for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) await new Promise(r => setTimeout(r, 50));
         ${viaWorker}`
      ),
      "200 from-sw",
      "the user's tab is the worker's"
    );
    await env.inSpace("site service worker", async page => {
      await page.goto(`${vectors.base}/plain?sw-task`);
      const reach = async step =>
        JSON.parse(
          await page.evaluate(`(async () => {
            const within = (p, what) => Promise.race([p, new Promise(r => setTimeout(() => r("no answer: " + what), 3000))]);
            const out = {};
            out.controller = navigator.serviceWorker.controller;
            out.registration = String(await within(navigator.serviceWorker.getRegistration(), "getRegistration"));
            out.registrations = (await within(navigator.serviceWorker.getRegistrations(), "getRegistrations")).length;
            out.ready = await Promise.race([navigator.serviceWorker.ready.then(() => "settled"), new Promise(r => setTimeout(() => r("pending"), 500))]);
            out.fetch = await within(fetch("/sw-intercept?sw-task-fetch-${step}").then(r => r.status, e => e.name), "fetch");
            const f = document.createElement("iframe");
            f.src = "/plain?sw-task-frame-${step}";
            await within(new Promise(r => { f.onload = r; document.body.append(f); }), "frame");
            out.frame = f.contentDocument?.title ?? null;
            f.remove();
            // A blob worker reads a relative URL against its blob: address.
            const url = location.origin + "/sw-intercept?sw-task-worker-${step}";
            const w = new Worker(URL.createObjectURL(new Blob(["fetch(" + JSON.stringify(url) + ").then(r => postMessage(r.status), e => postMessage(e.name))"], { type: "text/javascript" })));
            out.worker = await within(new Promise(r => { w.onmessage = e => r(e.data); }), "worker");
            w.terminate();
            const dw = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerReach(vectors.base, "sw-task-worker-message"))} + ".then(r => postMessage(r))"], { type: "text/javascript" })));
            out.workerReach = await within(new Promise(r => { dw.onmessage = e => r(JSON.parse(e.data)); }), "worker reach");
            dw.terminate();
            ${
              step === "first"
                ? `const sw = new SharedWorker("/shared-fetch.js", "shared-fetch");
                   out.shared = await within(new Promise(r => { sw.port.onmessage = e => r(e.data); sw.port.postMessage(location.origin + "/sw-intercept?sw-task-shared"); }), "shared");
                   const sr = new SharedWorker(URL.createObjectURL(new Blob(["onconnect = e => { const p = e.ports[0]; " + ${JSON.stringify(workerReach(vectors.base, "sw-task-shared-message"))} + ".then(r => p.postMessage(r)); };"], { type: "text/javascript" })));
                   out.sharedReach = await within(new Promise(r => { sr.port.onmessage = e => r(JSON.parse(e.data)); sr.port.start(); }), "shared reach");`
                : ""
            }
            return JSON.stringify(out);
          })()`)
        );
      // The workers the page starts get the page's answers. After the
      // claim, a blob worker would inherit the site's worker as controller.
      const hidden = { container: "object", controller: "null", registration: "undefined", registrations: 0, ready: "pending", postMessage: "undefined" };
      const none = { controller: null, registration: "undefined", registrations: 0, ready: "pending", fetch: 404, frame: "plain", worker: 404, workerReach: hidden };
      // A shared worker the page starts skips the site's worker too, from
      // its start (and after a claim: the next test).
      assert.deepEqual(await reach("first"), { ...none, shared: "404 ", sharedReach: hidden });
      // The worker claims every client of the site, the task's page among them: still nothing.
      await userTab.run(mark, `navigator.serviceWorker.controller.postMessage({ claim: true }); await new Promise(r => setTimeout(r, 500)); return true;`);
      assert.deepEqual(await reach("claimed"), none);
      // A navigation the worker would answer itself loads from the site.
      await page.goto(`${vectors.base}/plain?sw-nav&sw-task-nav`);
      assert.equal(await page.call("page.title"), "plain");
      assert.deepEqual(sawTask(), [], "the worker saw a request of the task's page");
      const asked = Object.keys(vectors.stats.hits).filter(k => k === "sw-task-worker-message" || k === "sw-task-shared-message");
      assert.deepEqual(asked, [], "a task page's worker reached the site's worker");
      const events = (await refusedEvents(page)).filter(e => e.kind === "serviceWorker");
      const pageReach = events.filter(e => e.message.startsWith("The page tried"));
      const workerReachLines = events.filter(e => e.message.startsWith("A worker the page started"));
      assert.ok(
        pageReach.length >= 1 && pageReach.every(e => /^The page tried to reach the site's service worker \((controller|getRegistrations?|ready|postMessage)\)\. It runs for the user's own tabs/.test(e.message)),
        JSON.stringify(events)
      );
      // Once per worker, apart from the page's: the dedicated one at each step, and the shared one.
      assert.equal(workerReachLines.length, 3, JSON.stringify(events));
      assert.ok(
        workerReachLines.every(e =>
          /^A worker the page started \(blob:http:\/\/127\.0\.0\.1:\d+\/[^)]*\) tried to reach the site's service worker \(controller\)\. It runs for the user's own tabs on this site, outside the task, so a task's pages and their workers don't use it: zenius answered as if the site had none\.$/.test(e.message)
        ),
        JSON.stringify(workerReachLines)
      );
      assert.equal(events.length, pageReach.length + workerReachLines.length, JSON.stringify(events));
    });
    // The user's tab is still the worker's.
    assert.equal(await userTab.run(mark, viaWorker), "200 from-sw");
  } finally {
    await userTab
      .run(mark, `for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); return true;`)
      .catch(() => {});
    await userTab.close(mark).catch(() => {});
  }
});

/** The user's tab registers the fixture's site worker and waits until it controls the tab. */
async function registerSiteWorker(mark, then = "return true;") {
  return userTab.run(
    mark,
    `await navigator.serviceWorker.register("/sw-site.js");
     await navigator.serviceWorker.ready;
     for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) await new Promise(r => setTimeout(r, 50));
     ${then}`
  );
}

const unregisterSiteWorker = mark =>
  userTab.run(mark, `for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); return true;`).catch(() => {});

/** Worker code that answers the site worker's offer through its port with `who`, and posts "ready" (to `reply`) once it listens. */
const offerListener = (who, reply) =>
  `navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.offer) e.ports[0]?.postMessage(${JSON.stringify(who)}); });
   navigator.serviceWorker.startMessages?.();
   ${reply}("ready");`;

test("the site's worker can't reach a task's page, its frame, the agent's world or their workers first: its messages and their ports never arrive, and the user's tab still gets them", async () => {
  const mark = `zo-sw-offer-${Date.now()}`;
  const answers = () =>
    Object.keys(vectors.stats.hits)
      .filter(k => k.startsWith("sw-offer-answer-"))
      .map(k => k.slice("sw-offer-answer-".length))
      .sort();
  try {
    await userTab.open(`${vectors.base}/plain?sw-offer-user`, mark);
    await registerSiteWorker(
      mark,
      `navigator.serviceWorker.addEventListener("message", e => { if (e.data?.offer) e.ports[0]?.postMessage("user"); });
       navigator.serviceWorker.startMessages();
       return true;`
    );
    await env.inSpace("site worker's offer", async page => {
      await page.goto(`${vectors.base}/plain?sw-offer-task`);
      // The page's own code listens every way it can, and answers through the port.
      await runVectors(
        page,
        `window.__swHeard = [];
         const answer = who => e => { window.__swHeard.push(who + (e.isTrusted ? "" : " (dispatched)")); e.ports[0]?.postMessage(who); };
         navigator.serviceWorker.onmessage = answer("page-onmessage");
         navigator.serviceWorker.addEventListener("message", answer("page-listener"));
         navigator.serviceWorker.addEventListener("message", answer("page-capture"), true);
         navigator.serviceWorker.onmessageerror = answer("page-messageerror");
         // The page's own dispatched message still reaches its listeners.
         navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: "own" }));
         1`
      );
      // The agent's world, a same-site frame, a worker and a shared worker listen too.
      assert.equal(
        await page.evaluate(`(async () => {
          const within = (p, what) => Promise.race([p, new Promise(r => setTimeout(() => r("no answer: " + what), 3000))]);
          navigator.serviceWorker.addEventListener("message", e => { if (e.data?.offer) e.ports[0]?.postMessage("world"); }, true);
          const f = document.createElement("iframe");
          f.src = "/plain?sw-offer-frame";
          await within(new Promise(r => { f.onload = r; document.body.append(f); }), "frame");
          f.contentWindow.navigator.serviceWorker.addEventListener("message", e => { if (e.data?.offer) e.ports[0]?.postMessage("frame"); });
          f.contentWindow.navigator.serviceWorker.startMessages();
          const blob = code => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
          window.__offerWorker = new Worker(blob(${JSON.stringify(offerListener("worker", "postMessage"))}));
          const worker = await within(new Promise(r => { __offerWorker.onmessage = e => r(e.data); }), "worker");
          window.__offerShared = new SharedWorker(blob("onconnect = c => { const postReady = m => c.ports[0].postMessage(m); " + ${JSON.stringify(offerListener("shared", "postReady"))} + " };"));
          const shared = await within(new Promise(r => { __offerShared.port.onmessage = e => r(e.data); __offerShared.port.start(); }), "shared");
          return worker + " " + shared;
        })()`),
        "ready ready"
      );
      await userTab.run(mark, `navigator.serviceWorker.controller.postMessage({ offer: "go" }); return true;`);
      await until("the user's tab's answer", async () => answers().includes("user"));
      // Time for the other answers to come, if any could.
      await sleep(1500);
      assert.deepEqual(answers(), ["user"], "a task's document or worker answered the site's worker through its port");
      assert.deepEqual(JSON.parse(await env.call("dev.evalContent", { ...page.P, code: "JSON.stringify(window.__swHeard)" })), [
        "page-capture (dispatched)",
        "page-onmessage (dispatched)",
        "page-listener (dispatched)",
      ]);
      const events = (await refusedEvents(page)).filter(e => e.kind === "serviceWorker");
      const pageLine =
        "The site's service worker sent the page a message. It runs for the user's own tabs on this site, outside the task, so a task's pages don't use it: zenius dropped the message and closed the ports it carried, as if the site had none.";
      // The page and its frame, once each; the worker and the shared worker, once each.
      assert.deepEqual(
        events.filter(e => e.message === pageLine).map(e => new URL(e.url).search).sort(),
        ["?sw-offer-frame", "?sw-offer-task"],
        JSON.stringify(events)
      );
      const workerLines = events.filter(e => e.message.startsWith("The site's service worker sent a worker the page started ("));
      assert.equal(workerLines.length, 2, JSON.stringify(events));
      assert.ok(
        workerLines.every(e =>
          /^The site's service worker sent a worker the page started \(blob:http:\/\/127\.0\.0\.1:\d+\/[^)]*\) a message\. It runs for the user's own tabs on this site, outside the task, so a task's pages and their workers don't use it: zenius dropped the message and closed the ports it carried, as if the site had none\.$/.test(e.message)
        ),
        JSON.stringify(workerLines)
      );
      assert.equal(events.length, 4, JSON.stringify(events));
    });
  } finally {
    await unregisterSiteWorker(mark);
    await userTab.close(mark).catch(() => {});
  }
});

test("a task's shared worker and the workers it starts skip the site's worker from their start and once it claims them, and the user's shared worker still uses it", async () => {
  const mark = `zo-sw-claim-${Date.now()}`;
  const userShared = tag =>
    userTab.run(
      mark,
      `window.__userShared ??= new SharedWorker("/shared-fetch.js", "user-claim");
       return await new Promise(r => { __userShared.port.onmessage = e => r(e.data); __userShared.port.postMessage(location.origin + "/sw-intercept?${tag}"); });`
    );
  try {
    await userTab.open(`${vectors.base}/plain?sw-claim-user`, mark);
    await registerSiteWorker(mark);
    assert.equal(await userShared("sw-claim-user-first"), "200 from-sw", "the user's shared worker is the site worker's");
    await env.inSpace("site worker's claim", async page => {
      await page.goto(`${vectors.base}/plain?sw-claim-task`);
      // The task's shared worker fetches, and so do the workers it starts:
      // from the site's script or a blob, kept from step to step or fresh.
      // After the claim, a blob worker it starts inherits the site's worker
      // (a blob worker's principal carries no mark: the bound in
      // docs/research/observe.md), so that one isn't asked then.
      const reach = step =>
        page.evaluate(`(async () => {
          const within = (p, what) => Promise.race([p, new Promise(r => setTimeout(() => r("no answer: " + what), 3000))]);
          window.__nest ??= new SharedWorker("/shared-nest.js", "nest");
          const ask = m => within(new Promise(r => { __nest.port.onmessage = e => r(e.data); __nest.port.postMessage(m); }), JSON.stringify(m));
          const url = what => location.origin + "/sw-intercept?sw-claim-task-" + what + "-${step}";
          const out = {};
          out.shared = await ask({ fetch: url("shared") });
          out.keptSite = await ask({ nested: "site", url: url("kept-site") });
          out.keptBlob = await ask({ nested: "blob", url: url("kept-blob") });
          out.freshSite = await ask({ nested: "site", fresh: true, url: url("fresh-site") });
          // A blob shared worker the agent wrote, whose principal is the
          // origin's, starts a worker from the site's script.
          const nestCode = "onconnect = e => { const p = e.ports[0]; p.onmessage = m => { const w = new Worker(location.origin + '/worker-fetch.js'); w.onmessage = r => p.postMessage(r.data); w.postMessage(m.data); }; };";
          window.__blobNest ??= new SharedWorker(URL.createObjectURL(new Blob([nestCode], { type: "text/javascript" })));
          out.blobNestSite = await within(new Promise(r => { __blobNest.port.onmessage = e => r(e.data); __blobNest.port.postMessage(url("blob-nest-site")); }), "blob nest");
          if ("${step}" === "first") {
            out.freshBlob = await ask({ nested: "blob", fresh: true, url: url("fresh-blob") });
            // Its URL and its site worker's carry the task's mark; their locations read them.
            out.where = await ask({ where: true });
            out.keptSiteWhere = await ask({ nested: "site", url: "location" });
          }
          return JSON.stringify(out);
        })()`).then(JSON.parse);
      const none = { shared: "404 ", keptSite: "404 ", keptBlob: "404 ", freshSite: "404 ", blobNestSite: "404 " };
      const { where, keptSiteWhere, ...first } = await reach("first");
      assert.match(where, /^http:\/\/127\.0\.0\.1:\d+\/shared-nest\.js#zenius-task-[^#&]+$/);
      assert.match(keptSiteWhere, /^http:\/\/127\.0\.0\.1:\d+\/worker-fetch\.js#zenius-task-[^#&]+$/);
      // The site's worker claims every client of the site: the shared worker
      // and its running workers among them.
      await userTab.run(mark, `navigator.serviceWorker.controller.postMessage({ claim: true }); await new Promise(r => setTimeout(r, 700)); return true;`);
      const claimed = await reach("claimed");
      // A worker the shared worker starts from the site's script skips the
      // site's worker from its start, as the shared worker does; after the
      // claim all of them still do.
      assert.deepEqual({ first, claimed }, { first: { ...none, freshBlob: "404 " }, claimed: none });
      // Nor their script loads: only the task's workers load these scripts here.
      const saw = Object.keys(vectors.stats.hits).filter(
        k => k.startsWith("sw-saw-") && (k.includes("sw-claim-task") || k === "sw-saw-worker-fetch.js" || k === "sw-saw-shared-nest.js")
      );
      assert.deepEqual(saw, [], "the site's worker saw a request of the task's workers");
      assert.deepEqual((await refusedEvents(page)).filter(e => e.kind === "serviceWorker"), []);
    });
    // The user's shared worker, claimed with the rest, still uses the site's worker.
    assert.equal(await userShared("sw-claim-user-claimed"), "200 from-sw");
  } finally {
    await unregisterSiteWorker(mark);
    await userTab.close(mark).catch(() => {});
  }
});

test("the refusals hold while the user holds the task: code left in the page still can't register or write", () =>
  env.inSpace("storage hold", async page => {
    await page.goto(`${vectors.base}/vectors`);
    const held = { "sw-register": 1, "cache-write": 3, "worker-storage": 2 };
    await runVectors(page, `setTimeout(() => { for (const id of ${JSON.stringify(Object.keys(held))}) window.__vectors[id](); }, 600); 1`);
    await page.call("spaces.handOff", { reason: "manual_takeover" });
    await sleep(2000);
    await page.call("spaces.takeOver");
    assert.deepEqual(await outcomes(page, held), refusedAll(held));
    assert.deepEqual(await leftovers(page), { scopes: [], cached: [] });
    await page.evaluate(`caches.delete("zenius-vectors").then(String)`);
  }));

test("a page the task kept is the user's again: its service worker and its cache writes go through", async () => {
  const space = await env.call("spaces.create", { name: `storage kept ${Date.now() % 100000}` });
  const P = { space: space.id, page: "p1" };
  const mark = `zo-storage-kept-${Date.now()}`;
  let finished = false;
  try {
    await env.call("page.goto", { ...P, url: `${vectors.base}/vectors` });
    await env.chrome(`ctx.resolvePage(arg.P).tab.setAttribute(arg.mark, "1"); return true;`, { P, mark });
    await env.call("spaces.finish", { space: space.id, keep: ["p1"] });
    finished = true;
    // Page script in the kept tab, through its document's actor.
    const run = code =>
      env.chrome(
        `const tab = [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].find(t => t.hasAttribute(arg.mark));
         if (!tab) throw new Error("the kept tab is gone");
         return ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", { code: arg.code });`,
        { mark, code }
      );
    const out = await run(`
      const out = [];
      try { await navigator.serviceWorker.register("/sw.js"); out.push("registered"); } catch (e) { out.push(e.name); }
      try { const c = await caches.open("zenius-vectors"); await c.put("/plain?kept", new Response("mine")); out.push("put"); } catch (e) { out.push(e.name); }
      return out;`);
    assert.deepEqual(out, ["registered", "put"]);
    await run(`
      await Promise.all((await navigator.serviceWorker.getRegistrations()).map(r => r.unregister()));
      await caches.delete("zenius-vectors");
      return true;`);
  } finally {
    if (!finished) {
      await env.call("spaces.finish", { space: space.id, keep: [] }).catch(() => {});
    }
    await env.chrome(
      `for (const tab of [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].filter(t => t.hasAttribute(arg))) win.gBrowser.removeTab(tab);
       return true;`,
      mark
    );
  }
});
