// What a Take over notes of its task's sites (modules/spaces.sys.mjs
// takeoverSites and takeoverSiteOf), which the agent sidebar reads before a
// send in a Work chat counts as Resume agent (docs/SPI.md, "A send as Resume
// agent"), and the site rule they go by (modules/util.sys.mjs siteName).
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
let port = 0;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>${new URL(req.url, "http://x").searchParams.get("t") ?? "page"}</title><p>here`);
});
/** A page on `host`, served by the one loopback server: 127.0.0.1, localhost, and two names under example.test. */
const at = (host, part) => `http://${host}:${port}/?t=${part}`;

before(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  h = await setup();
  await h.chrome(`Services.prefs.setStringPref("network.dns.localDomains", "a.example.test,b.example.test"); return true;`);
});

after(async () => {
  await h?.chrome(`Services.prefs.clearUserPref("network.dns.localDomains"); return true;`).catch(() => {});
  await h?.close();
  server.close();
});

const BROWSER = `const s = ctx.spaces.get(arg.space);
  const b = ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser;`;

/** A load in the page's tab, as the user's own would be (the agent can't navigate a held task). */
const load = (space, label, url) =>
  h.chrome(`${BROWSER} b.loadURI(Services.io.newURI(arg.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true;`, {
    space,
    label,
    url,
  });
const shows = (space, label, part) =>
  h.until(async () => (await h.chrome(`${BROWSER} return b.browsingContext.currentWindowGlobal?.documentURI?.spec ?? "";`, { space, label })).includes(part), 10000);
const open = async (space, host, part) => {
  const { label } = await h.call("pages.new", { space, url: at(host, part) });
  await shows(space, label, part);
  return label;
};

/** The user's Take over on the page, as the hold card's button makes it. */
const takeOver = (space, label) => h.chrome(`${BROWSER} await ctx.service.userTakeOver(s, b); return true;`, { space, label });
/** The user's Resume agent, as the hold card's: the reload of typed secrets, then the agent's control. */
const resume = space =>
  h.chrome(
    `const s = ctx.spaces.get(arg);
     await ctx.service.beforeHandBack(s);
     ctx.spaces.setOwnership(s, "agent", { source: "user" });
     return true;`,
    space
  );
const sites = space => h.chrome(`return ctx.spaces.get(arg).takeoverSites ?? null;`, space);
/** takeoverSiteOf for task `space` and the browser of task `of`'s page `label`. */
const siteOf = (space, of, label) =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     const o = ctx.spaces.get(arg.of);
     return ctx.spaces.takeoverSiteOf(s, ctx.pages.tabFor(ctx.pages.get(o, arg.label)).linkedBrowser);`,
    { space, of, label }
  );
/**
 * End the task, whatever a case left it in, so the next file starts without
 * it. finish is refused while the user holds the task, so a hold goes back
 * to the agent first. After the user's Stop the tabs are theirs, and
 * closing them ends the task, as when the user closes them.
 */
const end = async space => {
  const ownership = await h.chrome(`return ctx.spaces.peek(arg)?.ownership ?? null;`, space);
  if (ownership === "agentDelegatedToUser") {
    await resume(space);
  }
  if (ownership === "user") {
    await h.chrome(`for (const tab of ctx.pages.tabsOf(ctx.spaces.peek(arg))) ctx.pages.closeTab(tab); return true;`, space);
  } else if (ownership) {
    await h.call("spaces.finish", { space, keep: [] });
  }
  await h.until(async () => !(await h.chrome(`const rec = ctx.spaces.peek(arg); return !!rec && !rec.gone;`, space)), 10000);
};

test("the user's Take over notes the sites its task's pages are on; a hand-off, a permission hold and Stop note none, and the hold's end forgets them", async () => {
  const space = await h.space("to sites");
  try {
    const one = await open(space, "127.0.0.1", "s1");
    await open(space, "localhost", "s2");
    assert.equal(await sites(space), null, "nothing before a Take over");

    await takeOver(space, one);
    assert.deepEqual((await sites(space)).sort(), ["127.0.0.1", "localhost"]);
    assert.ok(!JSON.stringify(await h.chrome(`return ctx.spaces.serialize();`)).includes("takeoverSites"), "kept in memory only");
    await resume(space);
    assert.equal(await sites(space), null, "Resume forgets them");

    await h.call("spaces.handOff", { space });
    assert.equal(await sites(space), null, "the agent's hand-off notes none");
    await resume(space);

    await takeOver(space, one);
    await h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "agentDelegatedToUser", { source: "permission", reason: "location" }); return true;`, space);
    assert.equal(await sites(space), null, "a permission prompt's hold, even after a Take over, notes none");
    await resume(space);

    await takeOver(space, one);
    assert.equal((await sites(space)).length, 2, "each Take over notes them afresh");
    await h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "user", { source: "user" }); return true;`, space);
    assert.equal(await sites(space), null, "Stop forgets them");
  } finally {
    await end(space);
  }
});

test("takeoverSiteOf answers for the task's own page on a site noted at the Take over, and nothing else", async () => {
  const space = await h.space("to site of");
  const other = await h.space("to other task");
  let userTab = false;
  try {
    const page = await open(space, "127.0.0.1", "q1");
    const theirs = await open(other, "127.0.0.1", "q2");
    assert.equal(await siteOf(space, space, page), null, "nothing while the agent has the task");

    await takeOver(space, page);
    assert.equal(await siteOf(space, space, page), "127.0.0.1");
    assert.equal(await siteOf(space, other, theirs), null, "another task's page, on the same site");
    // A tab the user opened outside the task, on the same site.
    userTab = await h.chrome(
      `const win = Services.wm.getMostRecentWindow("navigator:browser");
       const tab = win.gBrowser.addTab(arg, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       ctx.service.testUserTab = tab;
       return true;`,
      at("127.0.0.1", "q-user")
    );
    await h.until(
      async () => (await h.chrome(`return ctx.service.testUserTab.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI?.spec ?? "";`)).includes("q-user"),
      10000
    );
    assert.equal(await h.chrome(`return ctx.spaces.takeoverSiteOf(ctx.spaces.get(arg), ctx.service.testUserTab.linkedBrowser);`, space), null, "the user's own tab");

    await load(space, page, at("localhost", "q3"));
    await shows(space, page, "q3");
    assert.equal(await siteOf(space, space, page), null, "the held tab on another site keeps the hold");
    await load(space, page, at("127.0.0.1", "q4"));
    await shows(space, page, "q4");
    assert.equal(await siteOf(space, space, page), "127.0.0.1", "back on the task's site");

    await resume(space);
    assert.equal(await siteOf(space, space, page), null, "once the agent has the task back");
  } finally {
    if (userTab) {
      await h.chrome(`ctx.service.testUserTab?.ownerGlobal.gBrowser.removeTab(ctx.service.testUserTab); delete ctx.service.testUserTab; return true;`).catch(() => {});
    }
    await end(space);
    await end(other);
  }
});

test("a page on another name under the same registrable domain is on the same site", async () => {
  const space = await h.space("to subdomain");
  try {
    const page = await open(space, "127.0.0.1", "r0");
    await load(space, page, at("a.example.test", "r1"));
    await shows(space, page, "r1");
    await takeOver(space, page);
    assert.deepEqual(await sites(space), ["example.test"]);
    await load(space, page, at("b.example.test", "r2"));
    await shows(space, page, "r2");
    assert.equal(await siteOf(space, space, page), "example.test");
    await load(space, page, at("localhost", "r3"));
    await shows(space, page, "r3");
    assert.equal(await siteOf(space, space, page), null);
  } finally {
    await end(space);
  }
});

test("siteName: the registrable domain, an IP address or a one-label host as itself, and punycode for a name that could spoof another", async () => {
  const names = await h.chrome(
    `const { siteName } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/util.sys.mjs");
     return arg.map(url => siteName(Services.io.newURI(url)));`,
    ["https://accounts.google.com.evil.co/x", "https://a.shop.example.co.uk/", "http://127.0.0.1:8080/", "http://localhost/", "http://[::1]:9/", "https://xn--pple-43d.com/"]
  );
  assert.deepEqual(names, ["evil.co", "example.co.uk", "127.0.0.1", "localhost", "::1", "xn--pple-43d.com"]);
});
