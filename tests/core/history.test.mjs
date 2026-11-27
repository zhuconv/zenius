// Task pages stay out of the user's history (modules/history.sys.mjs): a
// page writes no Places visit while its task is the agent's, through a
// process switch, a COOP load and a link it follows. A tab the task leaves
// the user writes history again, and one the agent takes back stops again.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
let base;
let control;
/**
 * Pages of the test's own, on 127.0.0.1 and on localhost (another site),
 * with COOP when asked. One with ?then answers its first request and sends
 * each one after it there, as a site whose session ended sends its sign-in
 * page; none of its answers is cached, so each load of it asks again.
 */
const asked = new Map();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  asked.set(req.url, (asked.get(req.url) ?? 0) + 1);
  const then = u.searchParams.get("then");
  if (then && asked.get(req.url) > 1) {
    res.writeHead(302, { location: then, "cache-control": "no-store" });
    res.end();
    return;
  }
  const headers = { "content-type": "text/html", ...(then ? { "cache-control": "no-store" } : {}) };
  if (u.searchParams.has("coop")) {
    headers["cross-origin-opener-policy"] = "same-origin";
  }
  const k = u.searchParams.get("n");
  res.writeHead(200, headers);
  res.end(
    `<!doctype html><title>history ${k}</title><a id="next" href="/p?next-${k}&n=${k}">next</a> <a id="pop" href="/p?pop-${k}&n=${k}" target="_blank">pop</a>`
  );
});
before(async () => {
  h = await setup();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // The user's own tab, whose visits order the checks (settled).
  control = await h.userSpace("history control");
});
after(async () => {
  server.close();
  await h?.close();
});

let n = 0;
/** A page no test visited before. */
const fresh = (host = "127.0.0.1", extra = "") => {
  const k = `${process.pid}-${++n}`;
  return `${base.replace("127.0.0.1", host)}/p?v${k}&n=${k}${extra}`;
};
const PU = `const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");`;
const hasVisit = url => h.chrome(`${PU} return await PlacesUtils.history.hasVisits(arg);`, url);
/** The user's own load in a tab, as the address bar makes it. */
const userLoad = (tabCode, arg) =>
  h.chrome(
    `${tabCode}
     tab.linkedBrowser.fixupAndLoadURIString(arg.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
     const end = Date.now() + 10000;
     while (tab.linkedBrowser.currentURI.spec !== arg.url && Date.now() < end) {
       await new Promise(r => win.setTimeout(r, 25));
     }
     return tab.linkedBrowser.currentURI.spec === arg.url;`,
    arg
  );
const CONTROL_TAB = `const tab = ctx.pages.tabsOf(ctx.spaces.get(arg.space))[0];`;
const PAGE_TAB = `const tab = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), arg.page));`;
/**
 * Every visit made before now is written: a load in the user's own tab
 * after them shows up. A page's visit goes to Places when its load ends,
 * so one that was coming is in by then.
 */
async function settled() {
  const url = fresh();
  assert.equal(await userLoad(CONTROL_TAB, { space: control, url }), true, "the user's load");
  await h.until(() => hasVisit(url), 10000);
}
const noVisit = async url => {
  await settled();
  return !(await hasVisit(url));
};
const visitedSoon = async url => {
  try {
    await h.until(() => hasVisit(url), 10000);
    return true;
  } catch {
    return false;
  }
};

test("a task page writes no history: a load, a link it follows, a process switch and a COOP load", async () => {
  const space = await h.space("history page");
  try {
    for (const url of [fresh(), fresh("localhost"), fresh("localhost", "&coop=1"), fresh()]) {
      await h.call("page.goto", { space, page: "p1", url });
      assert.equal(await noVisit(url), true, url);
    }
    const before = await h.call("page.url", { space, page: "p1" });
    const k = new URL(before).searchParams.get("n");
    await h.call("page.click", { space, page: "p1", target: "#next" });
    const next = `${base}/p?next-${k}&n=${k}`;
    await h.until(async () => (await h.call("page.url", { space, page: "p1" })) === next);
    assert.equal(await noVisit(next), true, "the link the page followed");
    // A popup the page opens is a page of the task too.
    await h.call("page.click", { space, page: "p1", target: "#pop" });
    const pop = `${base}/p?pop-${k}&n=${k}`;
    await h.until(async () => (await h.call("pages.list", { space })).some(p => p.url === pop));
    assert.equal(await noVisit(pop), true, "the popup's page");
    // The user's own load in a task page, while it's the agent's, writes none either.
    const typed = fresh();
    assert.equal(await userLoad(PAGE_TAB, { space, page: "p1", url: typed }), true);
    assert.equal(await noVisit(typed), true, "a load in the agent's page");
  } finally {
    await h.remove(space);
  }
});

test("a tab the task leaves the user writes history again, and one the agent takes back stops again", async () => {
  const space = await h.space("history kept");
  try {
    await h.call("page.goto", { space, page: "p1", url: fresh() });
    await h.call("spaces.finish", { space, keep: ["p1"] });
    const theirs = fresh();
    assert.equal(await userLoad(`const tab = ctx.pages.tabsOf(ctx.spaces.get(arg.space))[0];`, { space, url: theirs }), true);
    assert.equal(await visitedSoon(theirs), true, "the kept tab is the user's: their load is in their history");

    await h.claim(space);
    const [tab] = await h.call("tabs.list", { space });
    const { label } = await h.call("pages.adopt", { space, tab: tab.tab });
    const agents = fresh("localhost");
    await h.call("page.goto", { space, page: label, url: agents });
    assert.equal(await noVisit(agents), true, "claimed back, the page is the agent's again");

    // The user's Stop gives it back.
    await h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "user", { source: "user" }); return true;`, space);
    const again = fresh();
    assert.equal(await userLoad(`const tab = ctx.pages.tabsOf(ctx.spaces.get(arg.space))[0];`, { space, url: again }), true);
    assert.equal(await visitedSoon(again), true, "after the Stop");
  } finally {
    await h.remove(space);
  }
});

test("a tab of the user's in a task writes history until the agent adopts it, and again once released", async () => {
  const space = await h.space("history adopt");
  try {
    const tabId = await h.chrome(
      `const rec = ctx.spaces.get(arg);
       const tab = ctx.pages.addTab(rec, win);
       ctx.pages.addUnmanaged(rec, tab, "user");
       return ctx.pages.tabId(tab);`,
      space
    );
    const TAB = `const tab = ctx.pages.tabsOf(ctx.spaces.get(arg.space)).find(t => ctx.pages.tabId(t) === arg.tabId);`;
    const own = fresh();
    assert.equal(await userLoad(TAB, { space, tabId, url: own }), true);
    assert.equal(await visitedSoon(own), true, "the user's own tab in the task");
    const { label } = await h.call("pages.adopt", { space, tab: tabId });
    const agents = fresh("localhost");
    await h.call("page.goto", { space, page: label, url: agents });
    assert.equal(await noVisit(agents), true, "adopted, it's the agent's page");
    await h.call("pages.release", { space, page: label });
    const back = fresh();
    assert.equal(await userLoad(TAB, { space, tabId, url: back }), true);
    assert.equal(await visitedSoon(back), true, "released, it's the user's again");
  } finally {
    await h.remove(space);
  }
});

/**
 * A tab's current session-history entry loaded again, as Zen's session
 * restore loads a tab a window shows at a start (SessionStoreUtils
 * initializeRestore reloads the current entry); the URL of its new document.
 */
const historyLoad = (space, url) =>
  h.chrome(
    `const tab = ctx.pages.tabsOf(ctx.spaces.get(arg.space)).find(t => t.linkedBrowser.currentURI.spec === arg.url);
     const before = tab.linkedBrowser.browsingContext.currentWindowGlobal?.innerWindowId;
     tab.linkedBrowser.browsingContext.sessionHistory.reloadCurrentEntry();
     const end = Date.now() + 10000;
     for (;;) {
       const bc = tab.linkedBrowser.browsingContext;
       const wg = bc?.currentWindowGlobal;
       if (wg && wg.innerWindowId !== before && !bc.webProgress?.isLoadingDocument) {
         return wg.documentURI.spec;
       }
       if (Date.now() > end) {
         return null;
       }
       await new Promise(r => win.setTimeout(r, 25));
     }`,
    { space, url }
  );

test("a session-history load writes no visit, as Zen's own load of a tab a window shows at a start, but a redirect in it writes one for the address it left", async () => {
  const space = await h.space("history restore");
  try {
    const plain = fresh();
    const target = fresh();
    const left = fresh("127.0.0.1", `&then=${encodeURIComponent(target)}`);
    const { label } = await h.call("pages.new", { space });
    await h.call("page.goto", { space, page: "p1", url: plain });
    await h.call("page.goto", { space, page: label, url: left });
    // The user's tabs from here, with history on, as a task's tab a window
    // shows at a start is until the restart rebuild marks it.
    await h.call("spaces.finish", { space, keep: ["p1", label] });
    assert.equal(await historyLoad(space, plain), plain);
    assert.equal(await noVisit(plain), true, "the session-history load writes none");
    assert.equal(await historyLoad(space, left), target, "the second request is sent on");
    assert.equal(await visitedSoon(left), true, "the redirect writes one for the address it left");
    assert.equal(await noVisit(target), true, "and none for where it ends");
    // The tab whose load wrote none writes the user's own load.
    const theirs = fresh();
    assert.equal(await userLoad(`const tab = ctx.pages.tabsOf(ctx.spaces.get(arg.space)).find(t => t.linkedBrowser.currentURI.spec === arg.plain);`, { space, plain, url: theirs }), true);
    assert.equal(await visitedSoon(theirs), true, "its history was on");
  } finally {
    await h.remove(space);
  }
});

test("a task's page carries the mark only while its task is the agent's, and an attribute that isn't zenius's stays", async () => {
  const space = await h.space("history off");
  /** Each of the task's tabs, by tab id: [the attribute, zenius's mark, the live context's flag]. */
  const marks = () =>
    h.chrome(
      `return Object.fromEntries(
         ctx.pages.tabsOf(ctx.spaces.get(arg)).map(t => [
           ctx.pages.tabId(t),
           [t.linkedBrowser.getAttribute("disableglobalhistory"), t.linkedBrowser.getAttribute("zenius-history-off"), t.linkedBrowser.browsingContext?.useGlobalHistory ?? null],
         ])
       );`,
      space
    );
  const [page] = await h.call("tabs.list", { space });
  assert.deepEqual((await marks())[page.tab], ["true", "true", false], "kept out while the task has it");
  // A tab whose browser has the attribute already, as Zen's Glance previews
  // do: adopted, it gets no mark, and released, it keeps the attribute, its
  // page still out of history.
  const glance = await h.chrome(
    `const rec = ctx.spaces.get(arg);
     const tab = ctx.pages.addTab(rec, win);
     tab.linkedBrowser.setAttribute("disableglobalhistory", "true");
     ctx.pages.addUnmanaged(rec, tab, "user");
     return ctx.pages.tabId(tab);`,
    space
  );
  const { label } = await h.call("pages.adopt", { space, tab: glance });
  assert.deepEqual((await marks())[glance], ["true", null, false], "adopted");
  await h.call("pages.release", { space, page: label });
  assert.deepEqual((await marks())[glance], ["true", null, false], "released");
  await h.call("spaces.finish", { space, keep: ["p1"] });
  assert.deepEqual((await marks())[page.tab], [null, null, true], "the kept tab is the user's: both go");
  await h.remove(space);
});
