// A task's pages don't prefetch DNS (observe/dnsprefetch.sys.mjs): neither
// <link rel=dns-prefetch> nor an http page's links reach the resolver from
// a task's documents and frames. The user's own tabs still prefetch, and so
// does a kept page's next document after the task.
//
// Lookups stay on this machine: network.dns.native-is-localhost answers
// every name with loopback, and the resolver's cache (nsIDashboard) shows
// which names were looked up.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setup } from "./lib.mjs";

let env;
let site;
let base;
/** network.dns.disablePrefetch as the dev profile had it, put back at the end. */
let prefetchWas = true;
const TAG = `${process.pid}-${Date.now() % 1e6}`;
/** The names a page made from `n` would look up: its link's and its anchor's, its frame's link's and anchor's. */
const namesOf = n => [`zo-pf-l-${n}-${TAG}.test`, `zo-pf-a-${n}-${TAG}.test`, `zo-pf-fl-${n}-${TAG}.test`, `zo-pf-fa-${n}-${TAG}.test`];

before(async () => {
  env = await setup();
  site = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const n = u.searchParams.get("n") ?? "x";
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    if (u.pathname === "/frame") {
      res.end(`<!doctype html><link rel=dns-prefetch href="//zo-pf-fl-${n}-${TAG}.test"><a href="http://zo-pf-fa-${n}-${TAG}.test/x">a</a>`);
    } else {
      res.end(
        `<!doctype html><title>prefetch ${n}</title><link rel=dns-prefetch href="//zo-pf-l-${n}-${TAG}.test">` +
          `<a href="http://zo-pf-a-${n}-${TAG}.test/x">a</a><iframe src="/frame?n=${n}"></iframe>`
      );
    }
  });
  await new Promise(r => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${site.address().port}`;
  await env.chrome(`Services.prefs.setBoolPref("network.dns.native-is-localhost", true); return true;`);
  // Dev profiles turn DNS prefetch off (scripts/dev/no-outside-traffic.js);
  // the user's tabs here need Firefox's own default.
  prefetchWas = await env.chrome(
    `const was = Services.prefs.getBoolPref("network.dns.disablePrefetch", false); Services.prefs.setBoolPref("network.dns.disablePrefetch", false); return was;`
  );
});
after(async () => {
  await env?.chrome(`Services.prefs.clearUserPref("network.dns.native-is-localhost"); return true;`).catch(() => {});
  await env?.chrome(`Services.prefs.setBoolPref("network.dns.disablePrefetch", arg); return true;`, prefetchWas).catch(() => {});
  site?.close();
  await env?.close();
});

/** The names in the resolver's cache. */
const looked = async () =>
  new Set(
    await env.chrome(`const d = Cc["@mozilla.org/network/dashboard;1"].getService(Ci.nsIDashboard);
      return await new Promise(r => d.requestDNSInfo({ onDashboardDataAvailable: data => r((data.entries ?? []).map(e => e.hostname)) }));`)
  );

/** Wait until every name is in the resolver's cache. */
async function untilLookedUp(names, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const seen = await looked();
    const missing = names.filter(n => !seen.has(n));
    if (!missing.length) {
      return;
    }
    if (Date.now() > end) {
      assert.fail(`${what}: never looked up ${missing.join(", ")}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

/** A tab of the user's, in a Space of theirs: open, load, run, close. */
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
  close: mark =>
    env.chrome(
      `for (const t of [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].filter(t => t.hasAttribute(arg))) win.gBrowser.removeTab(t);
       return true;`,
      mark
    ),
};

test("a task's pages and their frames don't prefetch DNS, by link or dns-prefetch; the user's tabs still do", async () => {
  const mark = `zo-pf-user-${Date.now()}`;
  try {
    await env.inSpace("dns prefetch", async page => {
      await page.goto(`${base}/page?n=task`);
      // The user's tab loads the same page meanwhile. Once its names are
      // looked up, the task page's would have been too.
      await userTab.open(`${base}/page?n=user`, mark);
      await untilLookedUp(namesOf("user"), "the user's tab");
      await new Promise(r => setTimeout(r, 500));
      const seen = await looked();
      assert.deepEqual(
        namesOf("task").filter(n => seen.has(n)),
        [],
        "the task's page looked up names"
      );
    });
  } finally {
    await userTab.close(mark).catch(() => {});
  }
});

test("after the task, a kept page's next document prefetches again", async () => {
  const { id: space } = await env.call("spaces.create", { name: `dns prefetch kept ${Date.now() % 100000}` });
  const P = { space, page: "p1" };
  const mark = `zo-pf-kept-${Date.now()}`;
  let finished = false;
  try {
    await env.call("page.goto", { ...P, url: `${base}/page?n=kept1` });
    await env.chrome(`ctx.resolvePage(arg.P).tab.setAttribute(arg.mark, "1"); return true;`, { P, mark });
    await env.call("spaces.finish", { space, keep: ["p1"] });
    finished = true;
    // The user loads another page in the kept tab, from the address bar.
    await env.chrome(
      `const tab = [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].find(t => t.hasAttribute(arg.mark));
       if (!tab) throw new Error("the kept tab is gone");
       tab.linkedBrowser.loadURI(Services.io.newURI(arg.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       return true;`,
      { mark, url: `${base}/page?n=kept2` }
    );
    await untilLookedUp(namesOf("kept2"), "the kept page's next document");
    const seen = await looked();
    assert.deepEqual(
      namesOf("kept1").filter(n => seen.has(n)),
      [],
      "the page loaded during the task looked up names"
    );
  } finally {
    if (!finished) {
      await env.call("spaces.finish", { space, keep: [] }).catch(() => {});
    }
    await userTab.close(mark).catch(() => {});
  }
});
