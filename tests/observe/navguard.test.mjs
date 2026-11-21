// The closed-groups plan's second layer (observe/navguard.sys.mjs;
// docs/research/user-tab-reach.md, "Fix: closed groups", item 4): a
// document where the agent's code ran doesn't navigate a tab outside the
// task, whatever the way or the scheme. Its own loads, its frames' and the
// loads of documents the agent ran nothing in still go.
//
// Items 1 to 3 keep such a document from holding a handle to the user's
// windows: the agent's code doesn't run in an adopted popup of the user's
// tab. This layer catches what gets through anyway, so the tests mark that
// popup's document from chrome, as if code had run there, and run each
// vector as the page's own script.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setup } from "./lib.mjs";

let env;
let site;
let base;
/** Every path and query the site saw, in order. */
const seen = [];

before(async () => {
  env = await setup();
  site = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push(req.url);
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    switch (u.pathname) {
      case "/user":
        return res.end(`<!doctype html><title>user</title><p>the user's page<iframe src="/frame?user"></iframe>`);
      case "/popup":
        return res.end(`<!doctype html><title>popup</title><iframe src="/frame?popup"></iframe>`);
      case "/oauth":
        // A sign-in popup's own code sends its opener on, a while after load.
        return res.end(
          `<!doctype html><title>oauth</title><script>setTimeout(() => { opener.location.href = new URLSearchParams(location.search).get("to"); }, 1500)</script>`
        );
      case "/opener":
        return res.end(`<!doctype html><title>opener</title><a id=open href="/popup?t2" target="zo-t2">open</a>`);
      default:
        return res.end(`<!doctype html><title>${u.pathname.slice(1)}</title>`);
    }
  });
  await new Promise(r => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${site.address().port}`;
  // A page's own window.open with no click, kept in the background (as
  // zen-core's closed-groups test does).
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
  site?.close();
  await env?.close();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = v => JSON.stringify(v);
const hit = key => `${base}/hit?${key}`;
/** How many loads of /hit named `key` reached the site. */
const reached = key => seen.filter(u => u.startsWith("/hit?") && u.includes(key)).length;
const SERVICE = `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");`;
const ALL_TABS = `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const tabOf = mark => [...W.allTabs()].find(t => t.hasAttribute(mark));`;

/** A Space of the user's, in the background, with one tab at `url` marked `mark` and named zo-user-tab. */
function userSpace(url, mark) {
  return env.chrome(
    `${SERVICE}
     ${ALL_TABS}
     const ws = await win.gZenWorkspaces.createAndSaveWorkspace(arg.name, undefined, true);
     const tab = W.addBackgroundTab(win, ws.uuid);
     tab.setAttribute(arg.mark, "1");
     const uri = Services.io.newURI(arg.url);
     tab.linkedBrowser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, {}) });
     for (const end = Date.now() + 10000; ; await new Promise(r => win.setTimeout(r, 50))) {
       const b = tab.linkedBrowser;
       if (b.currentURI?.spec === arg.url && !b.webProgress?.isLoadingDocument) break;
       if (Date.now() > end) throw new Error("the user's tab didn't load");
     }
     await ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", { privileged: true, code: "actor.contentWindow.name = 'zo-user-tab'; return true;" });
     ZeniusService.spaces.refresh();
     return { space: ZeniusService.spaces.peekUuid(ws.uuid).id, uuid: ws.uuid };`,
    { name: `zo navguard ${Date.now() % 100000}`, url, mark }
  );
}

/**
 * The user's tab opens a popup at `url` with its own window.open. Zen puts
 * it in the window's current Space; the user moves it next to its opener.
 */
const userOpens = (mark, url) =>
  env.chrome(
    `${ALL_TABS}
     const u = tabOf(arg.mark);
     await ctx.content(u.linkedBrowser.browsingContext, "dev#evalContent", { privileged: false, code: "window.open(" + JSON.stringify(arg.url) + "); return true;" });
     const find = () => [...W.allTabs()].find(t => t.linkedBrowser.currentURI?.spec === arg.url);
     for (const end = Date.now() + 10000; !(find() && !find().linkedBrowser.webProgress?.isLoadingDocument); await new Promise(r => win.setTimeout(r, 50))) {
       if (Date.now() > end) throw new Error("the user's popup didn't open");
     }
     win.gZenWorkspaces.moveTabToWorkspace(find(), u.getAttribute("zen-workspace-id"));
     return true;`,
    { mark, url }
  );

/** The URLs of the marked tab's top document and its first frame. */
const urlsOf = mark =>
  env.chrome(
    `${ALL_TABS}
     const bc = tabOf(arg)?.linkedBrowser.browsingContext;
     return { top: bc?.currentWindowGlobal?.documentURI?.spec ?? null, frame: bc?.children[0]?.currentWindowGlobal?.documentURI?.spec ?? null };`,
    mark
  );

/** Claim the user's Space, as the user allows it. */
const claim = space => Promise.all([env.call("spaces.claim", { space }), env.call("dev.answerClaim", { space })]);

/** Adopt the claimed Space's tab at `url`. */
async function adopt(space, url, as) {
  const tabs = await env.call("tabs.list", { space });
  const tab = tabs.find(t => t.url === url);
  assert.ok(tab, `no tab at ${url}: ${JSON.stringify(tabs)}`);
  const { label } = await env.call("pages.adopt", { space, tab: tab.tab, as });
  return { space, page: label };
}

/** Mark the page's document as one where the agent's code ran. */
const markAgentCode = P =>
  env.chrome(
    `const { noteAgentCode } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs");
     const t = ctx.resolvePage(arg);
     noteAgentCode(t.space, t.browsingContext);
     return true;`,
    P
  );

/** Run `code` as the page's own script: an inline <script> in its document. */
const asPage = (P, code) =>
  env.chrome(
    `const s = "const s = document.createElement('script'); s.textContent = " + JSON.stringify(arg.code) + "; document.documentElement.append(s); s.remove(); return true;";
     return ctx.content(ctx.resolvePage(arg.P).browsingContext, "dev#evalContent", { privileged: false, code: s });`,
    { P, code }
  );

/** Each way a document moves another window, as the popup's own script. */
const VECTORS = {
  href: url => `opener.location.href = ${js(url)};`,
  replace: url => `opener.location.replace(${js(url)});`,
  named: url => `window.open(${js(url)}, "zo-user-tab");`,
  link: url => `const a = document.createElement("a"); a.href = ${js(url)}; a.target = "zo-user-tab"; document.body.append(a); a.click();`,
  form: url => {
    const u = new URL(url);
    return `const f = document.createElement("form"); f.action = ${js(u.origin + u.pathname)}; f.method = "get"; f.target = "zo-user-tab";
      const i = document.createElement("input"); i.name = "k"; i.value = ${js(u.search.slice(1))}; f.append(i); document.body.append(f); f.submit();`;
  },
  frame: url => `opener.frames[0].location.href = ${js(url)};`,
  blob: () => `opener.location.href = URL.createObjectURL(new Blob(["<title>blob</title>planted"], { type: "text/html" }));`,
  aboutBlank: () => `opener.location.href = "about:blank";`,
};

test("a page where the agent's code ran can't navigate a tab outside the task: an adopted popup moving the user's tab by location, replace, a named window.open, a link or a form with its name, its frame, blob: and about:blank", async () => {
  const mark = `zo-nav-user-${Date.now()}`;
  const { space, uuid } = await userSpace(`${base}/user`, mark);
  try {
    await userOpens(mark, `${base}/popup`);
    await claim(space);
    const P = await adopt(space, `${base}/popup`, "pop");
    await markAgentCode(P);
    for (const [name, code] of Object.entries(VECTORS)) {
      const key = `vector-${name}`;
      await asPage(P, code(hit(key)));
      await sleep(700);
      assert.equal(reached(key), 0, `${name}: the load reached the server`);
      const urls = await urlsOf(mark);
      assert.equal(urls.top, `${base}/user`, `${name}: the user's tab moved`);
      assert.equal(urls.frame, `${base}/frame?user`, `${name}: the user's frame moved`);
    }
    const lines = (await env.call("page.events", P)).filter(e => e.method === "Zenius.refused" && e.params.kind === "userTabNavigation");
    assert.ok(lines.length >= Object.keys(VECTORS).length, `refused lines: ${JSON.stringify(lines.map(e => e.params.message))}`);
    assert.match(
      lines[0].params.message,
      /^The page tried to load http:\/\/127\.0\.0\.1:\d+\/hit\?vector-href in a tab outside the task\. A page where the agent's code ran doesn't navigate the user's tabs, so zenius stopped the load before it was sent, and the tab stayed as it was\.$/
    );
    assert.ok(lines.every(e => !e.params.message.includes("/user")), "a refusal named the user's page");
  } finally {
    await env.call("spaces.finish", { space, keep: [] }).catch(() => {});
    await env.chrome(`await win.gZenWorkspaces.removeWorkspace(arg); return true;`, uuid).catch(() => {});
  }
});

test("what stays allowed: an adopted popup the agent ran nothing in moving its opener (a sign-in's), a marked popup's own loads and its frame's, and a marked task page's new popups and noopener tabs", async () => {
  const mark = `zo-nav-allowed-${Date.now()}`;
  const { space, uuid } = await userSpace(`${base}/user`, mark);
  try {
    await userOpens(mark, `${base}/popup`);
    await claim(space);
    const P = await adopt(space, `${base}/popup`, "pop");

    // A sign-in popup the agent adopted but ran nothing in: its own code
    // moves its opener. First, while no document of the group holds the
    // agent's code: then the user's tab opens it with an opener (zen-core's
    // item 3 opens it without one).
    const oauth = `${base}/oauth?to=${encodeURIComponent(hit("signed-in"))}`;
    await userOpens(mark, oauth);
    await adopt(space, oauth, "signin");
    await sleep(2500);
    assert.equal(reached("signed-in"), 1, "the sign-in's own code couldn't move its opener");
    assert.equal((await urlsOf(mark)).top, hit("signed-in"));

    await markAgentCode(P);
    await asPage(P, `frames[0].location.href = ${js(hit("own-frame"))};`);
    await sleep(700);
    assert.equal(reached("own-frame"), 1, "the popup's own frame didn't load");
    await asPage(P, `location.href = ${js(hit("own-top"))};`);
    await sleep(700);
    assert.equal(reached("own-top"), 1, "the popup's own load didn't go");

    // A page of the task's own, where the agent's code runs, opens popups:
    // with a URL, and blank by name, then sent somewhere by that name (the
    // agent's world refuses another window's location setter).
    const { label: own } = await env.call("pages.new", { space, url: `${base}/own` });
    const O = { space, page: own };
    await env.call("page.evaluate", { ...O, fn: `window.open(${js(hit("new-popup"))}); 1`, isFunction: false });
    await env.call("page.evaluate", { ...O, fn: `window.open("", "zo-fresh"); 1`, isFunction: false });
    await sleep(300);
    await env.call("page.evaluate", { ...O, fn: `window.open(${js(hit("fresh-named"))}, "zo-fresh"); 1`, isFunction: false });
    await env.call("page.evaluate", { ...O, fn: `window.open(${js(hit("noopener-popup"))}, "_blank", "noopener"); 1`, isFunction: false });
    await sleep(1000);
    assert.equal(reached("new-popup"), 1, "the task page's new popup didn't load");
    assert.equal(reached("fresh-named"), 1, "the task page's blank popup didn't load");
    assert.equal(reached("noopener-popup"), 1, "the task page's noopener tab didn't load");
  } finally {
    await env.call("spaces.finish", { space, keep: [] }).catch(() => {});
    await env.chrome(`await win.gZenWorkspaces.removeWorkspace(arg); return true;`, uuid).catch(() => {});
  }
});

test("after the task, a kept page where the agent's code ran can't navigate another kept page", async () => {
  const { id: space } = await env.call("spaces.create", { name: `zo navguard kept ${Date.now() % 100000}` });
  const mark1 = `zo-nav-t1-${Date.now()}`;
  const mark2 = `zo-nav-t2-${Date.now()}`;
  let finished = false;
  try {
    const T1 = { space, page: "p1" };
    await env.call("page.goto", { ...T1, url: `${base}/opener` });
    await env.call("page.click", { ...T1, target: "#open" });
    let popups = [];
    for (const end = Date.now() + 10000; !popups.length && Date.now() < end; await sleep(100)) {
      popups = (await env.call("pages.list", { space })).filter(p => p.label !== "p1");
    }
    assert.equal(popups.length, 1, "the task popup didn't open");
    const T2 = { space, page: popups[0].label };
    // The agent's code in T1 keeps a handle to T2, and leaves a timer that
    // moves it after the task.
    await env.call("page.evaluate", {
      ...T1,
      fn: `window.__t2 = window.open("", "zo-t2"); setTimeout(() => { window.__t2.location.href = ${js(hit("kept"))}; }, 2500); String(window.__t2 !== null)`,
      isFunction: false,
    });
    await env.chrome(`ctx.resolvePage(arg.T1).tab.setAttribute(arg.mark1, "1"); ctx.resolvePage(arg.T2).tab.setAttribute(arg.mark2, "1"); return true;`, { T1, T2, mark1, mark2 });
    await env.call("spaces.finish", { space, keep: ["p1", T2.page] });
    finished = true;
    await sleep(3200);
    assert.equal(reached("kept"), 0, "the kept page moved the other");
    assert.equal((await urlsOf(mark2)).top, `${base}/popup?t2`);
  } finally {
    if (!finished) {
      await env.call("spaces.finish", { space, keep: [] }).catch(() => {});
    }
    await env
      .chrome(
        `${ALL_TABS}
         for (const m of arg) for (const t of [...W.allTabs()].filter(t => t.hasAttribute(m))) t.ownerGlobal.gBrowser.removeTab(t);
         return true;`,
        [mark1, mark2]
      )
      .catch(() => {});
  }
});
