// Closed groups: in a page that shares a window group with a window
// outside its task (the core's pages.codeRefusal), the agent's code doesn't
// run. page.evaluate and page.waitForFunction are refused, and so is
// page.goto to the agent's own page (data:, blob:) or to another site.
// The page's own site still loads, and nothing is marked.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setup } from "./lib.mjs";

let env;
let site;
let base;
/** The same server under another site's name. */
let otherSite;

before(async () => {
  env = await setup();
  site = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(`<!doctype html><title>${u.pathname.slice(1)}</title><p>${u.pathname.slice(1)} page`);
  });
  await new Promise(r => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${site.address().port}`;
  otherSite = base.replace("127.0.0.1", "localhost");
  // A page's own window.open with no click, kept in the background (as
  // the core's closed-groups test does).
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

const SERVICE = `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");`;

/**
 * A Space of the user's with tab U, whose own script opened popup P (both
 * the user's), claimed by the agent, which adopts P.
 */
async function adoptedPopup(name) {
  const tag = `${name}-${Date.now() % 100000}`;
  const { space, uuid } = await env.chrome(
    `${SERVICE}
     const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     const ws = await win.gZenWorkspaces.createAndSaveWorkspace(arg.name, undefined, true);
     const u = W.addBackgroundTab(win, ws.uuid);
     const uri = Services.io.newURI(arg.u);
     u.linkedBrowser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, {}) });
     const wait = async (ok, what) => {
       for (const end = Date.now() + 10000; !ok(); await new Promise(r => win.setTimeout(r, 25))) {
         if (Date.now() > end) throw new Error(what);
       }
     };
     await wait(() => u.linkedBrowser.currentURI?.spec === arg.u && !u.linkedBrowser.webProgress?.isLoadingDocument, "the user's tab didn't load");
     await ctx.content(u.linkedBrowser.browsingContext, "dev#evalContent", { privileged: false, code: "window.open(" + JSON.stringify(arg.p) + "); return true;" });
     const find = () => [...W.allTabs()].find(t => t.linkedBrowser.currentURI?.spec === arg.p);
     await wait(() => find() && !find().linkedBrowser.webProgress?.isLoadingDocument, "the user's popup didn't open");
     // Zen puts a page's popup in the window's current Space: the user moves
     // it next to its opener. Its group stays.
     win.gZenWorkspaces.moveTabToWorkspace(find(), ws.uuid);
     ZeniusService.spaces.refresh();
     return { space: ZeniusService.spaces.peekUuid(ws.uuid).id, uuid: ws.uuid };`,
    { name: `zo closed groups ${tag}`, u: `${base}/user?${tag}`, p: `${base}/popup?${tag}` }
  );
  await Promise.all([env.call("spaces.claim", { space }), env.call("dev.answerClaim", { space })]);
  const tabs = await env.call("tabs.list", { space });
  const popup = tabs.find(t => t.url === `${base}/popup?${tag}`);
  assert.ok(popup, `the popup isn't in the claimed Space: ${JSON.stringify(tabs)}`);
  const { label } = await env.call("pages.adopt", { space, tab: popup.tab, as: "pop" });
  return { space, uuid, P: { space, page: label }, tag };
}

const drop = ({ space, uuid }) =>
  env
    .call("spaces.finish", { space, keep: [] })
    .catch(() => {})
    .then(() => env.chrome(`await win.gZenWorkspaces.removeWorkspace(arg); return true;`, uuid).catch(() => {}));

/** The call's error, which must be ZEN_AGENT_CODE_REFUSED for `method` on `page`, naming nothing of the user's. */
async function refused(call, method, page, tag) {
  const e = await call.then(
    v => assert.fail(`${method} ran: ${JSON.stringify(v)}`),
    err => err
  );
  assert.equal(e.code, "ZEN_AGENT_CODE_REFUSED", e.message);
  assert.deepEqual(e.data, { method, page, reason: "group", windows: 1 });
  assert.ok(!e.message.includes(`user?${tag}`) && !e.message.includes("127.0.0.1"), e.message);
  // The runtime's text, without the client's "method: code: " prefix.
  const prefix = `${e.method}: ${e.code}: `;
  assert.ok(e.message.startsWith(prefix), e.message);
  return e.message.slice(prefix.length);
}

const marked = P =>
  env.chrome(
    `const { agentCodeDocument } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs");
     return agentCodeDocument(ctx.resolvePage(arg).browser);`,
    P
  );

test("in an adopted popup of the user's tab, page.evaluate, page.waitForFunction and page.goto to data: or blob: are refused, and nothing is marked", async () => {
  const made = await adoptedPopup("code");
  const { P, tag } = made;
  try {
    const evaluate = await refused(
      env.call("page.evaluate", { ...P, fn: "document.title = 'ran'", isFunction: false }),
      "page.evaluate",
      P.page,
      tag
    );
    assert.equal(
      evaluate,
      "page.evaluate: zenius doesn't run the agent's code in this page: it shares a window group with a window outside the task, which code here could reach. page.click, page.fill, page.type, snapshots and screenshots still work here. To run code on this site, load it in a new page of the task (pages.new)."
    );
    await refused(
      env.call("page.waitForFunction", { ...P, fn: "() => (document.title = 'ran')", isFunction: true, options: { timeout: 2000 } }),
      "page.waitForFunction",
      P.page,
      tag
    );
    const data = await refused(env.call("page.goto", { ...P, url: "data:text/html,<title>ran</title>" }), "page.goto", P.page, tag);
    assert.match(data, / A data: or blob: page is the agent's own code\.$/);
    // A blob: page of the popup's site, made in a page of the task's own.
    const { label: own } = await env.call("pages.new", { space: P.space, url: `${base}/maker` });
    const blob = await env.call("page.evaluate", {
      space: P.space,
      page: own,
      fn: `URL.createObjectURL(new Blob(["<title>ran</title>"], { type: "text/html" }))`,
      isFunction: false,
    });
    await refused(env.call("page.goto", { ...P, url: blob }), "page.goto", P.page, tag);
    // Nothing ran, and the popup isn't marked.
    assert.equal(await env.call("page.title", P), "popup");
    assert.equal(await marked(P), false);
    // What doesn't run the agent's code still works.
    assert.match(JSON.stringify(await env.call("page.snapshot", P)), /popup page/);
  } finally {
    await drop(made);
  }
});

test("in a refused page, page.goto to another site is refused; the page's own site and a reload still load", async () => {
  const made = await adoptedPopup("site");
  const { P, tag } = made;
  try {
    const message = await refused(env.call("page.goto", { ...P, url: `${otherSite}/elsewhere` }), "page.goto", P.page, tag);
    assert.equal(
      message,
      "page.goto: zenius doesn't load another site in this page: it shares a window group with a window outside the task, which that site's code could reach. Pages of this site still load here. To open another site, use a new page of the task (pages.new)."
    );
    assert.equal(await env.call("page.title", P), "popup");
    await env.call("page.goto", { ...P, url: `${base}/same-site` });
    assert.equal(await env.call("page.title", P), "same-site");
    await env.call("page.reload", P);
    assert.equal(await env.call("page.title", P), "same-site");
  } finally {
    await drop(made);
  }
});

test("a page of the task's own runs the agent's code", () =>
  env.inSpace("closed groups own page", async page => {
    await page.goto(`${base}/own`);
    assert.equal(await page.evaluate("document.title"), "own");
    await page.goto(`${otherSite}/elsewhere`);
    await page.goto("data:text/html,<title>mine</title>");
    assert.equal(await page.evaluate("document.title"), "mine");
  }));
