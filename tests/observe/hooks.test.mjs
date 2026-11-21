// I4: zen-observe's observers that see the user's own browsing (every
// request, every blocked download, every new frame) run only while they
// have something of the agent's to watch (observe/setup.sys.mjs, syncHooks):
// from a task's first page to its last, and for the local-network refusal
// also while a page keeps the agent's code after its task.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(() => env.close());

const SETUP = "chrome://userscripts/content/zenius/observe/setup.sys.mjs";
const LOCALNET = "chrome://userscripts/content/zenius/observe/localnet.sys.mjs";
/** The hooks and what they wait for. Reading the marks prunes a closed tab's. */
const state = () => env.chrome(`return ChromeUtils.importESModule(${JSON.stringify(SETUP)}).hookState();`);
/** The local-network observer's flag alone, which prunes nothing. */
const localNetworkOn = () => env.chrome(`return ChromeUtils.importESModule(${JSON.stringify(LOCALNET)}).localNetworkActive();`);

/** The topics these hooks use, with how many observers each has now, ours or not. */
const TOPICS = [
  "http-on-opening-request",
  "http-on-modify-request",
  "http-on-stop-request",
  "http-on-failed-opening-request",
  "http-on-examine-response",
  "http-on-examine-cached-response",
  "http-on-examine-merged-response",
  "blocked-automatic-download",
  "browsing-context-attached",
];
const observers = () =>
  env.chrome(`const out = {}; for (const t of arg) out[t] = [...Services.obs.enumerateObservers(t)].length; return out;`, TOPICS);
/** What the task's hooks add to each topic: network's six, the local network's two, the DNS prefetch layer's three, the service-worker bypass's, downloads', audio's. */
const TASK_ADDS = {
  "http-on-opening-request": 2,
  "http-on-modify-request": 2,
  "http-on-stop-request": 1,
  "http-on-failed-opening-request": 1,
  "http-on-examine-response": 2,
  "http-on-examine-cached-response": 2,
  "http-on-examine-merged-response": 2,
  "blocked-automatic-download": 1,
  // audio's, for a muted page, and downloads', for an agent tab's new context.
  "browsing-context-attached": 2,
};
const plus = (counts, adds) => Object.fromEntries(Object.entries(counts).map(([t, n]) => [t, n + (adds[t] ?? 0)]));
const hooks = s => ({ network: s.network, downloads: s.downloads, localNetwork: s.localNetwork, serviceWorker: s.serviceWorker, dnsPrefetchOff: s.dnsPrefetchOff, navGuard: s.navGuard, audio: s.audio, holds: s.holds });
const OFF = { network: false, downloads: false, localNetwork: false, serviceWorker: false, dnsPrefetchOff: false, navGuard: false, audio: false, holds: false };

async function untilState(ok, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await state();
    if (ok(s)) {
      return s;
    }
    if (Date.now() > end) {
      assert.fail(`${what}: ${JSON.stringify(s)}`);
    }
    await new Promise(r => setTimeout(r, 50));
  }
}

test("with no task, none of these observers runs; a task's page turns them on, and the task's end turns them off", async () => {
  const idle = await untilState(s => !s.taskPages && !s.marks, "no task and no page with the agent's code to start with");
  assert.deepEqual(hooks(idle), OFF);
  const counts = await observers();
  await env.inSpace("hooks", async page => {
    // The hidden agent tab is muted before its page loads, which is what
    // audio's observer is for.
    await page.goto(`${env.base}/nav-target`);
    assert.deepEqual(hooks(await state()), { network: true, downloads: true, localNetwork: true, serviceWorker: true, dnsPrefetchOff: true, navGuard: true, audio: true, holds: false });
    assert.deepEqual(await observers(), plus(counts, TASK_ADDS));
  });
  const done = await untilState(s => !s.taskPages, "the task ended");
  assert.deepEqual(hooks(done), OFF);
  assert.deepEqual(await observers(), counts);
});

test("a page that keeps the agent's code keeps the local-network refusal and the service-worker bypass on after its task, until the user closes it", async () => {
  await untilState(s => !s.taskPages && !s.marks, "no task and no page with the agent's code to start with");
  const counts = await observers();
  const { id: space } = await env.call("spaces.create", { name: `hooks kept ${Date.now() % 100000}` });
  let browserId = null;
  let finished = false;
  try {
    await env.call("page.goto", { space, page: "p1", url: `${env.base}/nav-target` });
    // A write: the page holds the agent's code after its task only while written.
    await env.call("page.evaluate", { space, page: "p1", fn: `document.documentElement.setAttribute("data-zo-agent", "1"), 1`, isFunction: false });
    browserId = await env.chrome(`return ctx.resolvePage(arg).browser.browserId;`, { space, page: "p1" });
    await env.chrome(`Services.prefs.setBoolPref("zenius.handoff.quietReload", false); return true;`); // stays written: a failed clean reload
    await env.call("spaces.finish", { space, keep: ["p1"] });
    finished = true;
    const kept = await untilState(s => !s.taskPages, "the task ended");
    assert.equal(kept.marks, true);
    assert.deepEqual(hooks(kept), { network: false, downloads: false, localNetwork: true, serviceWorker: true, dnsPrefetchOff: false, navGuard: true, audio: false, holds: false });
    assert.deepEqual(await observers(), plus(counts, { "http-on-opening-request": 2, "http-on-modify-request": 1 }));
  } finally {
    await env.chrome(`Services.prefs.clearUserPref("zenius.handoff.quietReload"); return true;`).catch(() => {});
    if (!finished) {
      await env.call("spaces.finish", { space, keep: [] }).catch(() => {});
    }
    // The user closes the kept tab.
    await env.chrome(
      `const b = BrowsingContext.getCurrentTopByBrowserId(arg)?.embedderElement;
       const t = b && win.gBrowser.getTabForBrowser(b);
       if (t) win.gBrowser.removeTab(t, { animate: false });
       return !!t;`,
      browserId
    );
  }
  // Nothing of zenius's hears the user close the tab but its document's
  // end (window-global-destroyed), so wait on the flag alone first.
  const end = Date.now() + 5000;
  while (await localNetworkOn()) {
    if (Date.now() > end) {
      assert.fail(`the local-network observer stayed on after the kept page closed: ${JSON.stringify(await state())}`);
    }
    await new Promise(r => setTimeout(r, 50));
  }
  const closed = await untilState(s => !s.marks, "the kept page's mark went with its tab");
  assert.deepEqual(hooks(closed), OFF);
  assert.deepEqual(await observers(), counts);
});
