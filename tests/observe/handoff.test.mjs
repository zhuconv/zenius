// The hold (observe/hold.sys.mjs; the hand-off rule) keeps everything of
// the agent's away from the page H while the user holds it.
// agentSitesNear (observe/agentcode.sys.mjs) names the sites of the
// windows near H that may hold the agent's code, for the hold's frame and
// COOP rule. What a hand-off loads afresh is the core's call, from the
// evidence flag (tests/core/handoff.test.mjs).
// 127.0.0.1 (env.base, vectors.base) and localhost (vectors.crossBase) are
// the fixture's two sites.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setup } from "./lib.mjs";
import { startVectorServer } from "./vectors/fixture.mjs";

let env;
let vectors;
/** Pages the back-forward cache keeps: the fixture's are no-store, which Firefox never caches. */
let cacheable;
before(async () => {
  env = await setup();
  vectors = await startVectorServer();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>cacheable</title><p>${req.url}`);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  cacheable = { server, base: `http://127.0.0.1:${server.address().port}` };
  // A page's own window.open with no click, kept in the background, as
  // closedgroups.test.mjs does.
  await env.chrome(
    `Services.prefs.setBoolPref("dom.disable_open_during_load", false);
     Services.prefs.setBoolPref("browser.tabs.loadDivertedInBackground", true);
     return true;`
  );
});
after(async () => {
  await env
    ?.chrome(
      `Services.prefs.clearUserPref("dom.disable_open_during_load");
       Services.prefs.clearUserPref("browser.tabs.loadDivertedInBackground");
       return true;`
    )
    .catch(() => {});
  vectors?.server.close();
  cacheable?.server.close();
  await env?.close();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = v => JSON.stringify(v);
const FIND = `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const find = url => { const b = [...W.allTabs()].map(t => t.linkedBrowser).find(b => b.currentURI?.spec === url); if (!b) throw new Error("no tab shows " + url); return b; };
  const HOLD = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/hold.sys.mjs");`;

/** agentSitesNear for the tab showing `url`, with `P`'s task while it lives: the sites near it, sorted. */
const near = (P, url, live = true) =>
  env.chrome(
    `${FIND}
     const { agentSitesNear } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs");
     return [...agentSitesNear(arg.live ? ctx.resolvePage(arg.P).space : null, find(arg.url))].sort();`,
    { P, url, live }
  );
/** The site agentSitesNear names a page at `url` by. */
const siteOf = url =>
  env.chrome(`return Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(arg), {}).siteOriginNoSuffix;`, url);
const hold = url => env.chrome(`${FIND} return HOLD.holdPage(find(arg));`, url);
const release = url => env.chrome(`${FIND} HOLD.releasePage(find(arg)); return HOLD.holdingAny();`, url);
const holdOf = url => env.chrome(`${FIND} return HOLD.holdOf(find(arg)) ?? null;`, url);
/** The tab's top document (innerWindowId) and whether it has finished loading. */
const docOf = url =>
  env.chrome(
    `${FIND}
     const b = [...W.allTabs()].map(t => t.linkedBrowser).find(b => b.currentURI?.spec === arg);
     return b && !b.webProgress?.isLoadingDocument ? b.browsingContext.currentWindowGlobal?.innerWindowId ?? 0 : 0;`,
    url
  );
const until = async (what, fn, ms = 10000) => {
  for (const end = Date.now() + ms; ; await sleep(50)) {
    const v = await fn();
    if (v) {
      return v;
    }
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
  }
};
/** Run `code` as the page's own script in the tab showing `url` (as code the agent planted would run); what it leaves in window.__out. */
const asPage = (url, code) =>
  env.chrome(
    `${FIND}
     const s = "const s = document.createElement('script'); s.textContent = " + JSON.stringify(arg.code) + "; document.documentElement.append(s); s.remove(); return JSON.stringify(window.__out ?? null);";
     return JSON.parse(await ctx.content(find(arg.url).browsingContext, "dev#evalContent", { privileged: false, code: s }));`,
    { url, code }
  );
const closeTabs = urls =>
  env
    .chrome(
      `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
       for (const t of [...W.allTabs()].filter(t => arg.some(u => (t.linkedBrowser.currentURI?.spec ?? "").startsWith(u)))) t.ownerDocument.defaultView.gBrowser.removeTab(t);
       return true;`,
      urls
    )
    .catch(() => {});

/** Listen to the hold's refusals (the UI's hook) in the browser window; returns a reader. */
async function holdRefusals() {
  await env.chrome(
    `const HOLD = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/hold.sys.mjs");
     win.__zoHoldOff?.();
     win.__zoHoldRefusals = [];
     win.__zoHoldOff = HOLD.onHoldRefusal(r => win.__zoHoldRefusals.push({ kind: r.kind, url: r.url, held: !!r.browser }));
     return true;`
  );
  return () => env.chrome(`return win.__zoHoldRefusals;`);
}
const stopHoldRefusals = () => env.chrome(`win.__zoHoldOff?.(); win.__zoHoldOff = null; return true;`).catch(() => {});
/** The tab's session history position. */
const historyIndex = url => env.chrome(`${FIND} return find(arg).browsingContext.sessionHistory.index;`, url);
// The page's own history.back() and forward(): the browser's Back skips
// entries the user never interacted with (browser.navigation.requireUserInteraction),
// the page's own doesn't, so that's the way to an agent-made entry.
const goes = (url, how) => asPage(url, `history.${how === "goBack" ? "back" : "forward"}(); window.__out = 1;`);

test("agentSitesNear: the sites, frames' too, of the other windows of a page's group where the agent's code may be; with no live task, only marks count", () =>
  env.inSpace("sites near", async page => {
    const tag = Date.now();
    const T = `${vectors.crossBase}/plain?opener=${tag}`;
    const P = `${env.base}/nav-target?idp=${tag}`;
    const U = `${vectors.crossBase}/plain?by-site=${tag}`;
    const S = `${vectors.crossBase}/plain?same-site=${tag}`;
    const [A, B] = [await siteOf(T), await siteOf(P)];
    try {
      await page.goto(T);
      // The agent's code runs in T, which opens P on the other site.
      await page.evaluate(`window.__p = window.open(${js(P)}); 1`);
      await until("P", () => docOf(P));
      assert.deepEqual(await near(page.P, P), [A], "T, where the agent's code ran");
      assert.deepEqual(await near(page.P, T), [], "P: the agent's code ran nowhere on its site");

      // T's own script opens U on T's site: U counts by site while the task
      // lives, and not without it, since nothing marked it.
      await asPage(T, `window.open(${js(U)}); window.__out = 1;`);
      await until("U", () => docOf(U));
      assert.deepEqual(await near(page.P, T), [A], "U, by site");
      assert.deepEqual(await near(page.P, T, false), [], "U, with no live task");

      // A frame of P's site in T: through top, opener and frames, it can
      // walk to P.
      await page.evaluate(`const f = document.createElement("iframe"); f.src = ${js(`${env.base}/nav-target?frame=${tag}`)}; document.body.append(f); 1`);
      await until("T's frame", () =>
        env.chrome(`${FIND} return find(arg).browsingContext.children.some(c => c.currentWindowGlobal?.documentURI?.spec?.includes("frame="));`, T)
      );
      assert.deepEqual(await near(page.P, P), [A, B].sort());

      // A popup of T's site that comes in once T was written (its frame) is
      // flagged written itself (flagIfExposed), which marks it.
      await page.evaluate(`window.__s = window.open(${js(S)}); 1`);
      await until("S", () => docOf(S));
      assert.deepEqual(await near(page.P, T, false), [A], "S, marked");

      // With no live task, T's marks still count, and so does its frame's site.
      assert.deepEqual(await near(page.P, P, false), [A, B].sort());
    } finally {
      await closeTabs([P, U, S]);
    }
  }));

test("a clean copy zenius loaded isn't near the agent's code by site, until the agent's code runs in its group again", () =>
  env.inSpace("handoff clean copy", async page => {
    const tag = Date.now();
    const X = `${vectors.crossBase}/plain?written=${tag}`;
    const Y = `${env.base}/nav-target?beside=${tag}`;
    const Q = `${vectors.crossBase}/plain?popup=${tag}`;
    const A = await siteOf(X);
    const fresh = async what => {
      const first = await docOf(X);
      return async () =>
        until(what, async () => {
          const d = await docOf(X);
          return d && d !== first;
        });
    };
    try {
      await page.goto(X);
      // X's own popup on the other site, where the agent's code never runs:
      // the window the sites near X are read from.
      await asPage(X, `window.open(${js(Y)}); window.__out = 1;`);
      await until("Y", () => docOf(Y));
      await page.evaluate(`document.documentElement.dataset.zo = "1"; 1`);
      assert.deepEqual(await near(page.P, Y), [A], "the page the agent's world wrote into");
      // A reload that isn't zenius's: the fresh document still counts by site.
      let loaded = await fresh("the reload");
      await env.chrome(`${FIND} find(arg).reload(); return true;`, X);
      await loaded();
      assert.deepEqual(await near(page.P, Y), [A], "a reload of the page's or the user's, by site");
      // zenius's clean load (the input layer's clean copy on demand goes through it).
      loaded = await fresh("the clean copy");
      await env.chrome(`${FIND} await ctx.service.cleanLoad(find(arg), { sameSite: true }); return true;`, X);
      await loaded();
      assert.deepEqual(await near(page.P, Y), [], "the clean copy, though the agent's code ran on its site");
      try {
        assert.equal(await hold(X), true);
        assert.deepEqual(await near(page.P, Y), [], "the clean copy, while the user holds it");
      } finally {
        await release(X);
      }
      // The page's own popup of its site, where the agent's code then runs:
      // a world in the group again, so the clean copy counts by site again.
      await asPage(X, `window.open(${js(Q)}); window.__out = 1;`);
      await until("the popup", () => docOf(Q));
      assert.deepEqual(await near(page.P, Q), [], "before the agent's code runs in the group again");
      let popup = null;
      for (let i = 0; i < 100 && !popup; i++) {
        popup = (await env.call("pages.list", { space: page.P.space })).find(p => p.url === Q)?.label ?? null;
        if (!popup) {
          await sleep(50);
        }
      }
      assert.ok(popup, "the popup joined the task");
      await env.call("page.evaluate", { space: page.P.space, page: popup, fn: "1", isFunction: false });
      assert.deepEqual(await near(page.P, Q), [A], "the clean copy, once the agent's code ran in its group again");
    } finally {
      await closeTabs([Y, Q]);
    }
  }));

test("the hold: a window the core reloads for it isn't near the agent's code by site, until the hold ends", () =>
  env.inSpace("handoff fresh", async page => {
    const tag = Date.now();
    const T = `${vectors.crossBase}/plain?opener=${tag}`;
    const H = `${vectors.crossBase}/plain?held=${tag}`;
    const A = await siteOf(T);
    try {
      await page.goto(T);
      await page.evaluate(`window.__h = window.open(${js(H)}); 1`);
      await until("H", () => docOf(H));
      assert.equal(await hold(H), true);
      assert.deepEqual(await near(page.P, H), [A], "T, where the agent's code ran");
      // The core reloads T for the hold: T's fresh document doesn't count by site.
      const t1 = await docOf(T);
      assert.equal(await env.chrome(`${FIND} return HOLD.holdReload(find(arg.T), find(arg.H));`, { T, H }), true);
      await env.chrome(`${FIND} find(arg).reload(); return true;`, T);
      await until("T's fresh document", async () => {
        const d = await docOf(T);
        return d && d !== t1;
      });
      assert.deepEqual(await near(page.P, H), [], "T's fresh document");
      assert.equal(await release(H), false);
      assert.deepEqual(await near(page.P, H), [A], "after the hold, T counts by site again");
    } finally {
      await closeTabs([H]);
    }
  }));

test("the hold: a task may hold several pages (the core's holdFor); for one, a tab of another hold in its group counts by site only with its documents from before that hold", () =>
  env.inSpace("two holds", async page => {
    const tag = Date.now();
    const T = `${vectors.crossBase}/plain?opener=${tag}`;
    const H1 = `${vectors.crossBase}/plain?held-one=${tag}`;
    const H2 = `${vectors.crossBase}/plain?held-two=${tag}`;
    const A = await siteOf(T);
    try {
      await page.goto(T);
      await page.evaluate(`window.__h1 = window.open(${js(H1)}); window.__h2 = window.open(${js(H2)}); 1`);
      await until("H1", () => docOf(H1));
      await until("H2", () => docOf(H2));
      assert.equal(await hold(H1), true);
      assert.equal(await hold(H2), true);
      assert.notEqual(await holdOf(H1), await holdOf(H2), "two holds");
      // The core reloads T for H1's hold, so only H2 is left to count.
      const t1 = await docOf(T);
      assert.equal(await env.chrome(`${FIND} return HOLD.holdReload(find(arg.T), find(arg.H));`, { T, H: H1 }), true);
      await env.chrome(`${FIND} find(arg).reload(); return true;`, T);
      await until("T's fresh document", async () => {
        const d = await docOf(T);
        return d && d !== t1;
      });
      assert.deepEqual(await near(page.P, H1), [A], "H2's document from before its hold, by site");
      // A reload of H2 during its hold, such as the user's: the agent's code
      // is refused in a held group, so the fresh document doesn't count by site.
      const h2 = await docOf(H2);
      await env.chrome(`${FIND} find(arg).reload(); return true;`, H2);
      await until("H2's fresh document", async () => {
        const d = await docOf(H2);
        return d && d !== h2;
      });
      assert.deepEqual(await near(page.P, H1), [], "H2's document from its hold");
    } finally {
      await release(H1).catch(() => {});
      await release(H2).catch(() => {});
      await closeTabs([H1, H2]);
    }
  }));

test("the hold: others' loads into H and its frames are refused, H's own and its popups' go", () =>
  env.inSpace("handoff hold", async page => {
    const tag = Date.now();
    // T, where the agent's code ran, on one site; H, its sign-in popup, and
    // U, another of T's popups, on the other. U holds none of the agent's
    // code, but it's outside the hold.
    const T = `${vectors.crossBase}/plain?opener=${tag}`;
    const H = `${env.base}/nav-target?held=${tag}`;
    const U = `${env.base}/nav-target?other-popup=${tag}`;
    const away = `${env.base}/nav-target?swapped=${tag}`;
    const frames = url =>
      env.chrome(`${FIND} return find(arg).browsingContext.children.map(c => c.currentWindowGlobal?.documentURI?.spec ?? "");`, url);
    const read = await holdRefusals();
    try {
      await page.goto(T);
      // The agent opens both (its code's popups go); T's own code then finds
      // H by name, since the agent's handles stay in its isolated world.
      await page.evaluate(`window.open(${js(H)}, "zo-held-${tag}"); window.open(${js(U)}); 1`);
      await until("H", () => docOf(H));
      await until("U", () => docOf(U));

      // T moves H during the hold: refused, H stays; T's line once, though Gecko may ask twice.
      assert.equal(await hold(H), true);
      await page.call("page.events");
      await asPage(T, `window.open("", "zo-held-${tag}").location.href = ${js(away)}; window.__out = 1;`);
      await sleep(800);
      assert.ok(await docOf(H), "H still shows its page");
      const refused = (await page.call("page.events")).filter(e => e.method === "Zenius.refused" && e.params.kind === "heldPageNavigation");
      assert.equal(refused.length, 1, js(refused));
      assert.ok(!refused[0].params.message.includes(`held=${tag}`), "the message names only what the page tried to load");
      // After the release, T's load goes.
      assert.equal(await release(H), false, "no hold left");
      await asPage(T, `window.open("", "zo-held-${tag}").location.href = ${js(away)}; window.__out = 1;`);
      await until("H moved after the release", () => docOf(away));

      // Held again, with a frame of its own site, as a payment frame. U, of
      // H's site, finds H by name and moves its frame: refused. (A named
      // open makes U H's opener, which is why T's turn came first.)
      assert.equal(await hold(away), true);
      await asPage(away, `{ const f = document.createElement("iframe"); f.src = ${js(`${env.base}/nav-target?h-frame=${tag}`)}; document.body.append(f); } window.__out = 1;`);
      await until("H's frame", async () => (await frames(away)).some(u => u.includes("h-frame=")));
      await asPage(U, `try { window.open("", "zo-held-${tag}").frames[0].location.href = ${js(`${away}&frame=1`)}; window.__out = "asked"; } catch (e) { window.__out = e.name; }`);
      await sleep(800);
      assert.ok((await frames(away)).some(u => u.includes("h-frame=")), "H's frame stayed");
      assert.deepEqual((await read()).map(r => r.kind), ["navigation", "navigation"]);

      // A popup H opens during the hold joins it, and may report back to H.
      const Q = `${env.base}/nav-target?held-popup=${tag}`;
      await asPage(away, `window.__q = window.open(${js(Q)}); window.__out = 1;`);
      await until("Q", () => docOf(Q));
      assert.equal(await holdOf(Q), await holdOf(away), "Q joined H's hold");
      const back = `${env.base}/nav-target?reported=${tag}`;
      await asPage(Q, `window.opener.location.href = ${js(back)}; window.__out = 1;`);
      await until("H moved by its own popup", () => docOf(back));

      // H's own navigation goes.
      const own = `${env.base}/nav-target?own=${tag}`;
      await asPage(back, `location.href = ${js(own)}; window.__out = 1;`);
      await until("H's own navigation", () => docOf(own));
      assert.equal(await release(own), false, "no hold left");
      assert.equal(await holdOf(Q), null, "Q left with H");
    } finally {
      await stopHoldRefusals();
      await env.chrome(`const HOLD = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/hold.sys.mjs"); return HOLD.holdingAny();`).catch(() => {});
      await closeTabs([H, U, away, `${env.base}/nav-target?held-popup=${tag}`, `${env.base}/nav-target?reported=${tag}`, `${env.base}/nav-target?own=${tag}`]);
    }
  }));

/** Does the tab's history entry for `url` keep its document in the back-forward cache? (the core's guards.test.mjs) */
const cached = (browserId, url) =>
  env.chrome(
    `const sh = BrowsingContext.getCurrentTopByBrowserId(arg.browserId).sessionHistory;
     for (let i = 0; i < sh.count; i++) {
       const entry = sh.getEntryAtIndex(i);
       if (entry.URI.spec === arg.url && entry.isInBFCache) return true;
     }
     return false;`,
    { browserId, url }
  );

test("the hold: H's back-forward cache is evicted, and its fresh documents' channels and shared workers are H's alone", () =>
  env.inSpace("handoff hold scope", async page => {
    const tag = Date.now();
    const T = `${cacheable.base}/t?${tag}`;
    const { label } = await env.call("pages.new", { space: page.space, url: `${cacheable.base}/start?${tag}` });
    const H = page.page(label);
    const browserId = await env.chrome(`return ctx.resolvePage(arg).tab.linkedBrowser.browserId;`, H.P);
    // H shows A, then B, until A waits in its back-forward cache. Gecko
    // doesn't cache a page left while its load group still holds a request,
    // so each try waits longer after the load (as the core's test does).
    let A = null;
    let B = null;
    for (let n = 1, settle = 250; n <= 4 && !A; n++, settle *= 2) {
      const a = `${cacheable.base}/a-${n}?${tag}`;
      const b = `${cacheable.base}/b-${n}?${tag}`;
      await H.goto(a);
      await sleep(settle);
      await H.goto(b);
      if (await until("A in the cache", () => cached(browserId, a), 2000).then(() => true, () => false)) {
        A = a;
        B = b;
      }
    }
    assert.ok(A, "Gecko cached none of four pages in the tab");
    await page.goto(T);

    assert.equal(await hold(B), true);
    assert.equal(await cached(browserId, A), false, "holdPage emptied H's back-forward cache");
    await asPage(B, `history.back(); window.__out = 1;`);
    await until("A after the hold began", () => docOf(A));

    // H's documents made since the hold began talk only among themselves.
    const LISTEN = `window.__got = []; window.__ch = new BroadcastChannel("zo-held"); window.__ch.onmessage = e => window.__got.push(e.data); window.__out = window.__ch.name;`;
    assert.equal(await asPage(A, LISTEN), "zo-held");
    await page.evaluate(`window.__got = []; window.__ch = new BroadcastChannel("zo-held"); window.__ch.onmessage = e => window.__got.push(e.data); 1`);
    await asPage(A, `window.__ch.postMessage("from-held"); window.__out = 1;`);
    await page.evaluate(`window.__ch.postMessage("from-task"); 1`);
    await sleep(600);
    assert.deepEqual(await asPage(A, `window.__out = window.__got;`), [], "H heard the task's page");
    assert.deepEqual(await page.evaluate("window.__got"), [], "the task's page heard H");
    await asPage(
      A,
      `const w = new SharedWorker(URL.createObjectURL(new Blob(["onconnect = e => e.ports[0].postMessage(self.location.hash)"], { type: "text/javascript" })));
       w.port.onmessage = e => { window.__hash = e.data; }; w.port.start(); window.__out = 1;`
    );
    const hash = await until("the shared worker's answer", () => asPage(A, `window.__out = window.__hash ?? null;`));
    assert.match(hash, /zenius-held-\d+/);
    assert.equal(await release(A), false);
  }));

test("the hold: Back or Forward into a data: or blob: entry is refused, and the history stays", () =>
  env.inSpace("handoff history", async page => {
    const tag = Date.now();
    const at = name => `${cacheable.base}/${name}?${tag}`;
    const AGENT = `data:text/html,<title>agent-${tag}</title>`;
    const read = await holdRefusals();
    /** A new page of the task through `urls`, each the agent's goto, then `back` steps back by the page's own script. */
    const pageWith = async (urls, back = 0) => {
      const { label } = await env.call("pages.new", { space: page.space, url: urls[0] });
      const P = page.page(label);
      for (const url of urls.slice(1)) {
        await P.goto(url);
      }
      // The parent commits the last entry after the page has loaded; a
      // history.back() sent before then goes from the entry before it (a
      // flake under test-all's load).
      const last = urls[urls.length - 1];
      await until("the history settled", () =>
        env.chrome(`${FIND} const sh = find(arg.last).browsingContext.sessionHistory; return sh.count === arg.n && sh.index === arg.n - 1 && sh.requestedIndex === -1;`, { last, n: urls.length })
      );
      for (let n = 1; n <= back; n++) {
        await asPage(urls[urls.length - n], `history.back(); window.__out = 1;`);
        await until(`back to ${urls[urls.length - n - 1]}`, () => docOf(urls[urls.length - n - 1]));
      }
      return P;
    };
    try {
      // Control, with no hold: the page's own history.back() reaches the
      // agent's data: entry (the browser's Back skips entries the user
      // never touched; the page's doesn't), while Gecko keeps its document
      // in the back-forward cache. A fresh load of that entry is Firefox's
      // own refusal (no principal it trusts started it), and Gecko doesn't
      // cache a page left while its load group still holds a request: so
      // each try waits longer before leaving it, and goes back only once
      // the entry is cached (a flake under test-all's load).
      let reached = 0;
      for (let n = 1, settle = 250; n <= 4 && !reached; n++, settle *= 2) {
        const agent = `${AGENT}-c${n}`;
        const c2 = at(`c2-${n}`);
        const { label } = await env.call("pages.new", { space: page.space, url: at(`c1-${n}`) });
        const P = page.page(label);
        await P.goto(agent);
        await sleep(settle);
        await P.goto(c2);
        const browserId = await env.chrome(`return ctx.resolvePage(arg).tab.linkedBrowser.browserId;`, P.P);
        if (!(await until(`${agent} in the cache`, () => cached(browserId, agent), 2000).then(() => true, () => false))) {
          continue;
        }
        await until("the history settled", () =>
          env.chrome(`${FIND} const sh = find(arg).browsingContext.sessionHistory; return sh.count === 3 && sh.index === 2 && sh.requestedIndex === -1;`, c2)
        );
        await asPage(c2, `history.back(); window.__out = 1;`);
        reached = await until(`back to ${agent}`, () => docOf(agent));
      }
      assert.ok(reached, "Gecko cached none of four data: pages, so the control never went back");

      // Back into it during a hold: refused, at B still, the history as it was.
      const AGENT2 = `${AGENT}-2`;
      await pageWith([at("a"), AGENT2, at("b")]);
      assert.equal(await hold(at("b")), true);
      await asPage(at("b"), `history.back(); window.__out = 1;`);
      await sleep(800);
      assert.ok(await docOf(at("b")), "H stays at B");
      assert.equal(await historyIndex(at("b")), 2);
      assert.equal(await release(at("b")), false);

      // Forward into it: refused.
      const AGENT3 = `${AGENT}-3`;
      await pageWith([at("f1"), AGENT3], 1);
      assert.equal(await hold(at("f1")), true);
      await asPage(at("f1"), `history.forward(); window.__out = 1;`);
      await sleep(800);
      assert.ok(await docOf(at("f1")), "H stays where it was");
      assert.equal(await historyIndex(at("f1")), 0);
      assert.equal(await release(at("f1")), false);

      // A blob: page the agent's code made, then the agent went on: Back into it is refused.
      const { label } = await env.call("pages.new", { space: page.space, url: at("m") });
      const M = page.page(label);
      await M.evaluate(`location.href = URL.createObjectURL(new Blob(["<title>blob</title>"], { type: "text/html" })); 1`);
      await until("the blob: page", async () => (await M.call("page.url")).startsWith("blob:"));
      await M.goto(at("n"));
      assert.equal(await hold(at("n")), true);
      await asPage(at("n"), `history.back(); window.__out = 1;`);
      await sleep(800);
      assert.ok(await docOf(at("n")), "H stays at N");
      assert.equal(await release(at("n")), false);

      assert.deepEqual((await read()).map(r => r.kind), ["history", "history", "history"], JSON.stringify(await read()));
    } finally {
      await stopHoldRefusals();
      await env.chrome(`const HOLD = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/hold.sys.mjs"); return HOLD.holdingAny();`).catch(() => {});
    }
  }));

/** The tab's pending history load, -1 for none. */
const requestedIndex = url => env.chrome(`${FIND} return find(arg).browsingContext.sessionHistory.requestedIndex;`, url);

test("the hold: after a refused Back, the history menu's pick of the agent's entry is refused too, and H's document stays (glue by the core)", () =>
  env.inSpace("handoff history index", async page => {
    const tag = Date.now();
    const at = name => `${cacheable.base}/${name}?${tag}`;
    const urls = [at("i1"), `data:text/html,<title>agent-index-${tag}</title>`, at("i2")];
    const B = urls[2];
    const { label } = await env.call("pages.new", { space: page.space, url: urls[0] });
    const P = page.page(label);
    for (const url of urls.slice(1)) {
      await P.goto(url);
    }
    await until("the history settled", () =>
      env.chrome(`${FIND} const sh = find(arg).browsingContext.sessionHistory; return sh.count === 3 && sh.index === 2 && sh.requestedIndex === -1;`, B)
    );
    const settled = () => until("no history load pending", async () => (await requestedIndex(B)) === -1, 3000);
    try {
      assert.equal(await hold(B), true);
      const doc = await docOf(B);
      await asPage(B, `history.back(); window.__out = 1;`);
      await sleep(800);
      await settled();
      // Counted from the refused entry, the menu's pick loaded H's first
      // entry afresh.
      await env.chrome(`${FIND} find(arg).gotoIndex(1); return true;`, B);
      await sleep(800);
      await settled();
      assert.equal(await docOf(B), doc, "H's document is the one the user had");
      assert.equal(await historyIndex(B), 2);
    } finally {
      await release(B).catch(() => {});
    }
  }));

test("the hold: in H, a frame of a site a window near it may hold the agent's code on is refused; the top asks the core for COOP", () =>
  env.inSpace("handoff agent site", async page => {
    const tag = Date.now();
    const T = `${vectors.crossBase}/plain?opener=${tag}`;
    const H = `${env.base}/nav-target?idp=${tag}`;
    const read = await holdRefusals();
    try {
      await page.goto(T);
      await page.evaluate(`window.__h = window.open(${js(H)}); 1`);
      await until("H", () => docOf(H));
      assert.equal(await hold(H), true);

      const coop = url =>
        env.chrome(
          `${FIND}
           const b = find(arg.H);
           return HOLD.holdNeedsCoop(ctx.resolvePage(arg.P).space, b, Services.io.newURI(arg.url));`,
          { H, P: page.P, url }
        );
      assert.equal(await coop(`${vectors.crossBase}/plain?back-to-agent=${tag}`), true, "the agent's site");
      assert.equal(await coop(`${env.base}/nav-target?next=${tag}`), false, "H's own site");

      const frames = () =>
        env.chrome(`${FIND} return find(arg).browsingContext.children.map(c => c.currentWindowGlobal?.documentURI?.spec ?? "");`, H);
      await asPage(H, `{ const f = document.createElement("iframe"); f.src = ${js(`${vectors.crossBase}/plain?agent-frame=${tag}`)}; document.body.append(f); } window.__out = 1;`);
      await asPage(H, `{ const f = document.createElement("iframe"); f.src = ${js(`${env.base}/nav-target?own-frame=${tag}`)}; document.body.append(f); } window.__out = 1;`);
      await until("H's own frame", async () => (await frames()).some(u => u.includes("own-frame=")));
      await sleep(500);
      assert.ok(!(await frames()).some(u => u.includes("agent-frame=")), js(await frames()));
      assert.deepEqual((await read()).map(r => r.kind), ["agentSite"]);
      assert.equal(await release(H), false);
    } finally {
      await stopHoldRefusals();
      await closeTabs([H]);
    }
  }));
