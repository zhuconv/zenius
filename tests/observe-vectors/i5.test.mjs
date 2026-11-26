// SPEC §3.9 I5: the browser is no way out of an agent's sandbox. Agent loads
// open only web URLs, never with the system principal, and agent methods act
// only in web-content documents, frames included (observe/webcontent.sys.mjs).
// The file-path half (bytes in place of paths) is in the screenshot, events
// and downloads suites.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setup } from "../observe/lib.mjs";
import { startHttpsFixture } from "../input/https-fixture.mjs";

let env;
before(async () => {
  env = await setup();
});
after(() => env.close());

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** page.screenshot's switch for painting over add-on frames (off: the shot is refused). */
const setPaintOver = on =>
  env.chrome(`ChromeUtils.importESModule("chrome://userscripts/content/zenius/methods/observe.sys.mjs").setAddonPaintOver(arg); return true;`, on);

/** page.screenshot's refusal of a page with an add-on's frame, with the switch off. */
async function assertAddonShotRefused(page, what, host) {
  const e = await page.call("page.screenshot").then(
    () => null,
    err => err
  );
  assert.equal(e?.code, "ZEN_PAGE_NOT_WEB_CONTENT", `${what}: ${e?.message ?? "the shot was taken"}`);
  assert.match(e.message, /page\.screenshot refused: an add-on's frame is in this page \(p1\)\. A screenshot would paint it.* page\.snapshot still works/, what);
  assert.ok(!e.message.includes(host), e.message);
  assert.deepEqual(e.data, { method: "page.screenshot", page: "p1", frame: true }, what);
}

/**
 * What a screenshot shows, counted in the browser: pure green (the test
 * add-on's frame), the gray zenius paints over add-on frames, and the
 * fixtures' red marks.
 */
const colors = shot =>
  env.chrome(
    `const img = new win.Image();
     img.src = "data:image/png;base64," + arg;
     await img.decode();
     const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
     c.width = img.naturalWidth;
     c.height = img.naturalHeight;
     const g = c.getContext("2d");
     g.drawImage(img, 0, 0);
     const d = g.getImageData(0, 0, c.width, c.height).data;
     let green = 0, gray = 0, red = 0;
     for (let i = 0; i < d.length; i += 4) {
       if (d[i] < 40 && d[i + 1] > 200 && d[i + 2] < 40) green++;
       else if (d[i] === 128 && d[i + 1] === 128 && d[i + 2] === 128) gray++;
       else if (d[i] > 200 && d[i + 1] < 40 && d[i + 2] < 40) red++;
     }
     return { green, gray, red, width: c.width, height: c.height };`,
    shot.base64
  );

/** The page's document as the parent sees it, and how its history entry was triggered. */
const docState = page =>
  env.chrome(
    `const { browser } = ctx.resolvePage(arg);
     const wgp = browser.browsingContext.currentWindowGlobal;
     const p = wgp.documentPrincipal;
     const sh = browser.browsingContext.sessionHistory;
     const entry = sh && sh.index >= 0 ? sh.getEntryAtIndex(sh.index) : null;
     return {
       url: browser.currentURI.spec,
       system: p.isSystemPrincipal,
       nullPrincipal: p.isNullPrincipal,
       origin: p.origin,
       remoteType: browser.remoteType,
       triggeredBySystem: entry ? entry.triggeringPrincipal.isSystemPrincipal : null,
     };`,
    page.P
  );

/**
 * What page JS run by the agent can reach: never chrome APIs. (Every web
 * page has a Components shim, without classes or utils.)
 */
const reach = page =>
  page.evaluate(`[typeof Services, typeof ChromeUtils, typeof globalThis.Components?.classes, typeof globalThis.Components?.utils].join(" ")`);
const NOTHING = "undefined undefined undefined undefined";

const FORBIDDEN = [
  ["file:///etc/hostname", "file"],
  ["about:config", "about"],
  ["about:preferences", "about"],
  ["about:logins", "about"],
  ["about:compat", "about"],
  ["about:blank-not", "about"],
  ["chrome://browser/content/browser.xhtml", "chrome"],
  ["resource://gre/modules/Timer.sys.mjs", "resource"],
  ["moz-src:///toolkit/actors/AudioPlaybackParent.sys.mjs", "moz-src"],
  ["jar:file:///tmp/x.zip!/a.html", "jar"],
  ["view-source:http://127.0.0.1/", "view-source"],
  ["moz-extension://00000000-0000-0000-0000-000000000000/page.html", "moz-extension"],
  ["javascript:document.title='agent'", "javascript"],
  ["ftp://127.0.0.1/", "ftp"],
];

// zenius doctor's check of the agent boundary (the SDK): browser.health
// reports I5 from what enforces it, and opens nothing.
test("browser.health reports the I5 status doctor checks, computed, with nothing opened", async () => {
  const tabs = () => env.chrome(`return [...Services.wm.getEnumerator("navigator:browser")].reduce((n, w) => n + w.gBrowser.tabs.length, 0);`);
  const before = await tabs();
  const { i5 } = await env.call("browser.health");
  assert.deepEqual(i5, {
    loads: ["about:blank", "blob:", "data:", "http:", "https:"],
    pageGate: true,
    contentGate: true,
    refuses: true,
  });
  assert.equal(await tabs(), before);
  // Not constants: without the service's gates, the flags say so.
  assert.deepEqual(
    await env.chrome(
      `const { i5Status } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/webcontent.sys.mjs");
       const s = await i5Status({ pageGates: [], content: async () => ({}) });
       return { pageGate: s.pageGate, contentGate: s.contentGate };`
    ),
    { pageGate: false, contentGate: false }
  );
});

test("goto and newPage open only http:, https:, data:, blob: and about:blank", () =>
  env.inSpace("i5 schemes", async page => {
    const home = `${env.base}/nav-target`;
    await page.goto(home);
    for (const [url, scheme] of FORBIDDEN) {
      const e = await page.fail("page.goto", { url });
      assert.equal(e.code, "ZEN_URL_NOT_ALLOWED", `${url}: ${e.code} ${e.message}`);
      assert.equal(e.data.scheme, scheme, url);
      assert.match(e.message, new RegExp(`^page\\.goto can't open .*, an? ${scheme}: URL: agents load only http:, https:, data:, blob: and about:blank URLs`));
      assert.equal(await page.call("page.url"), home, `${url}: the page stayed`);
    }
    const n = await env.fail("pages.new", { space: page.space, url: "about:config" });
    assert.equal(n.code, "ZEN_URL_NOT_ALLOWED");
    const s = await docState(page);
    assert.equal(s.system, false);
    assert.match(s.remoteType, /^web/);
  }));

test("no about:blank, data: or blob: document an agent gets has the system principal", () =>
  env.inSpace("i5 principals", async page => {
    // A new page's first document, before any load.
    const fresh = await docState(page);
    assert.equal(fresh.system, false, JSON.stringify(fresh));
    assert.equal(fresh.nullPrincipal, true, JSON.stringify(fresh));
    assert.match(fresh.remoteType, /^web/);
    assert.equal(await reach(page), NOTHING);
    const other = page.page((await env.call("pages.new", { space: page.space })).label);
    assert.equal((await docState(other)).nullPrincipal, true, "pages.new's about:blank");

    await page.goto(`${env.base}/nav-target`);
    assert.equal((await docState(page)).triggeredBySystem, false, "http: loads with a web principal");
    // about:blank and data: after a web page: a null origin, never the
    // system principal or the page's; then their reloads.
    for (const url of ["about:blank", "data:text/html,<title>data</title>"]) {
      await page.goto(url);
      for (const how of ["goto", "reload"]) {
        const s = await docState(page);
        assert.equal(s.url, url);
        assert.equal(s.system, false, `${how} ${url}: ${JSON.stringify(s)}`);
        assert.equal(s.nullPrincipal, true, `${how} ${url}: ${JSON.stringify(s)}`);
        assert.equal(s.triggeredBySystem, false, `${how} ${url}: ${JSON.stringify(s)}`);
        assert.match(s.remoteType, /^web/, `${how} ${url}`);
        assert.equal(await reach(page), NOTHING, `${how} ${url}`);
        if (how === "goto") {
          await page.call("page.reload");
        }
      }
    }
    // A blob: URL loads with its origin's principal, from the page that made it.
    await page.goto(`${env.base}/nav-target`);
    const blob = await page.evaluate(`URL.createObjectURL(new Blob(["<title>blob</title>"], { type: "text/html" }))`);
    await page.goto(blob);
    const b = await docState(page);
    assert.equal(b.url, blob);
    assert.equal(b.system, false);
    assert.equal(b.origin, env.base, JSON.stringify(b));
    assert.equal(b.triggeredBySystem, false);
    assert.equal(await page.evaluate("document.title"), "blob");
    assert.equal(await reach(page), NOTHING);
  }));

/**
 * The user opens `url` in the agent's tab while they hold the Space, as from
 * the URL bar, then hands it back. Returns the URL page.url() then reports.
 */
async function userOpens(page, url) {
  await page.call("spaces.handOff", { reason: "manual_takeover" });
  await env.chrome(
    `const { browser } = ctx.resolvePage(arg.P);
     const before = browser.browsingContext.currentWindowGlobal;
     browser.fixupAndLoadURIString(arg.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
     for (const end = Date.now() + 10000; ; ) {
       await new Promise(r => win.setTimeout(r, 50));
       const wgp = browser.browsingContext?.currentWindowGlobal;
       if (wgp && wgp !== before && !browser.webProgress?.isLoadingDocument) break;
       if (Date.now() > end) throw new Error("the user's page didn't load: " + browser.currentURI.spec);
     }
     return true;`,
    { P: page.P, url }
  );
  await page.call("spaces.takeOver");
  return page.call("page.url");
}

/** Every method that acts in or reads the document. The gate refuses them before their params matter. */
const DOCUMENT_METHODS = [
  ["page.evaluate", { fn: "document.title", isFunction: false }],
  ["page.waitForFunction", { fn: "() => true", options: { timeout: 1000 } }],
  ["page.waitForSelector", { target: "body", options: { timeout: 1000 } }],
  ["page.snapshot", {}],
  ["page.screenshot", {}],
  ["page.title", {}],
  ["page.fetch", { url: "/" }],
  ["page.click", { target: "body" }],
  ["page.dblclick", { target: "body" }],
  ["page.hover", { target: "body" }],
  ["page.focus", { target: "body" }],
  ["page.fill", { target: "body", value: "x" }],
  ["page.press", { target: "body", key: "a" }],
  ["page.selectOption", { target: "select", values: ["a"] }],
  ["page.setInputFiles", { target: "input", files: [] }],
  ["page.dragAndDrop", { source: "body", target: "body" }],
  ["page.keyboard", { action: "press", key: "a" }],
  ["page.mouse", { action: "click", x: 1, y: 1 }],
  ["page.acceptDialog", {}],
  ["page.dismissDialog", {}],
];

async function refusedIn(page, url) {
  for (const [method, params] of DOCUMENT_METHODS) {
    const e = await page.fail(method, params);
    assert.equal(e.code, "ZEN_PAGE_NOT_WEB_CONTENT", `${method} in ${url}: ${e.code} ${e.message}`);
    assert.equal(e.data.url, url);
    assert.equal(e.data.page, page.label);
    assert.equal(e.data.method, method);
    assert.match(e.message, new RegExp(`^${method.replace(".", "\\.")} refused: page ${page.label} shows .*, which isn't web content \\(`));
  }
  // What the parent answers alone still works, and the agent may leave:
  // page.info with the URL only, since the title and metrics are the
  // document's.
  assert.deepEqual(await page.call("page.info"), { url }, `page.info in ${url}`);
  await page.call("page.events");
}

/** A fresh folder under this suite's out/, for files a test writes. */
function scratchDir(prefix) {
  const out = join(import.meta.dirname, "out");
  mkdirSync(out, { recursive: true });
  return mkdtempSync(join(out, prefix));
}

/** The browsing contexts of the page's frames, as the parent sees them. */
const frameDocs = page =>
  env.chrome(
    `const { browser } = ctx.resolvePage(arg);
     return browser.browsingContext.getAllBrowsingContextsInSubtree().slice(1).map(bc => bc.currentWindowGlobal?.documentURI?.spec ?? "");`,
    page.P
  );

/** Wait until a frame of the page shows a document whose URL matches `re`. */
async function frameShows(page, re) {
  for (const end = Date.now() + 10000; ; await sleep(100)) {
    const docs = await frameDocs(page);
    if (docs.some(u => re.test(u))) {
      return;
    }
    assert.ok(Date.now() < end, `no frame shows ${re}: ${JSON.stringify(docs)}`);
  }
}

/**
 * Start the console watch in the process of the page's frame `index` (0 is
 * the page itself), as any runtime call into that process may: a document
 * the agent can't read must stay out of page.events even then.
 */
const watchConsoleIn = (page, index) =>
  env.chrome(
    `const { browser } = ctx.resolvePage(arg.P);
     const bc = browser.browsingContext.getAllBrowsingContextsInSubtree()[arg.index];
     try {
       await ctx.content(bc, "nav#metrics", {});
     } catch (e) {
       // The Zenius actor exists only in web content processes (zen-core's
       // remoteTypes): in a file or add-on process the watch can't start.
       if (e?.code === "ZEN_UNSUPPORTED") return false;
       throw e;
     }
     return true;`,
    { P: page.P, index }
  );

test("agent methods act only in web content, whoever opened the page", () =>
  env.inSpace("i5 documents", async page => {
    await page.goto(`${env.base}/nav-target`);
    const webcompat = await env.chrome(
      `return WebExtensionPolicy.getByID("webcompat@mozilla.org")?.getURL("about-compat/aboutCompat.html") ?? null;`
    );
    const urls = [
      "about:config", // the parent process, the system principal
      "chrome://browser/content/browser.xhtml",
      "file:///etc/hostname", // the file process
      "about:logins", // privilegedabout: Firefox sends it every saved login
      "about:compat", // an add-on's page under an about: URL
      ...(webcompat ? [webcompat] : []), // the extension process: browser.* APIs
    ];
    for (const url of urls) {
      const shown = await userOpens(page, url);
      assert.notEqual(shown, `${env.base}/nav-target`, `${url} didn't load`);
      await refusedIn(page, shown);
      const again = await page.fail("page.reload");
      assert.equal(again.code, "ZEN_URL_NOT_ALLOWED", `reload of ${shown}`);
      await page.goto(`${env.base}/nav-target`);
      assert.equal(await page.evaluate("location.pathname"), "/nav-target", `the agent left ${url}`);
    }
  }));

test("Firefox's error pages are privileged documents too", () =>
  env.inSpace("i5 error page", async page => {
    const refused = "http://127.0.0.1:1/";
    const e = await page.fail("page.goto", { url: refused });
    assert.equal(e.code, "ZEN_NAVIGATION_FAILED");
    assert.equal(await page.call("page.url"), refused);
    const s = await page.fail("page.evaluate", { fn: "typeof document.addCertException", isFunction: false });
    assert.equal(s.code, "ZEN_PAGE_NOT_WEB_CONTENT");
    assert.equal(s.data.url, refused);
    assert.match(s.message, /it is Firefox's error page for a load that failed/);
  }));

test("a goto that ends on a certificate warning fails clearly, and no agent method acts in the warning", () =>
  env.inSpace("i5 certificate warning", async page => {
    const out = join(import.meta.dirname, "out");
    mkdirSync(out, { recursive: true });
    const dir = mkdtempSync(join(out, "cert-"));
    // A self-signed certificate this test never trusts.
    const site = await startHttpsFixture(dir);
    const overrides = () =>
      env.chrome(
        `const s = Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService);
         return s.getOverrides().filter(o => o.port === arg).map(o => o.hostPort);`,
        site.port
      );
    try {
      const url = `${site.origin}/login`;
      const e = await page.fail("page.goto", { url });
      assert.equal(e.code, "ZEN_NAVIGATION_FAILED", e.message);
      assert.equal(e.data.certificateWarning, true, `${e.message} ${JSON.stringify(e.data)}`);
      assert.equal(e.data.plain, true);
      assert.match(
        e.message,
        /^page\.goto failed: net::ERR_CERT_AUTHORITY_INVALID\. Firefox showed a certificate warning for 127\.0\.0\.1:\d+ \([A-Z_]+\): it can't verify that the site is who it says\. An agent can't accept the risk or add an exception; ask the user to check the site\.$/
      );
      // The warning shows under the site's URL, but it is Firefox's page.
      assert.equal(await page.call("page.url"), url);
      // What goto reads when the warning commits before the load stops.
      // Under load goto can answer first, from the TLS error the load
      // stopped with, so wait for the warning to commit (a flake seen in a
      // parallel test-all).
      const warning = () =>
        env
          .chrome(`const { browser } = ctx.resolvePage(arg); return ctx.content(browser.browsingContext, "nav#certificateError", {});`, page.P)
          .catch(() => null);
      let nss = null;
      for (let i = 0; i < 100 && !(nss = await warning()); i++) {
        await sleep(50);
      }
      assert.equal(nss, "MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT");
      await refusedIn(page, url);
      // Gecko 160's warning: moz-buttons in a net-error-card's shadow DOM.
      for (const target of ["#advanced-button", "#exception-button", "#returnButton", "text=Accept the Risk and Continue"]) {
        const c = await page.fail("page.click", { target, options: { force: true } });
        assert.equal(c.code, "ZEN_PAGE_NOT_WEB_CONTENT", c.message);
        assert.match(c.message, /it is Firefox's error page for a load that failed/);
      }
      // A reload ends on the same warning.
      const r = await page.fail("page.reload");
      assert.equal(r.data.certificateWarning, true, r.message);

      // The same warning in a frame of a web page: out of reach.
      await page.goto(`data:text/html,<p>top text</p><iframe id="warn" src="${url}"></iframe>`);
      await sleep(1000);
      const snap = JSON.stringify(await page.call("page.snapshot"));
      assert.match(snap, /top text/);
      assert.doesNotMatch(snap, /risk|advanced|exception|security/i, snap.slice(0, 2000));
      const inFrame = await env.chrome(
        `const { checkContentCall } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/webcontent.sys.mjs");
         const { browser } = ctx.resolvePage(arg);
         const [, warn] = browser.browsingContext.getAllBrowsingContextsInSubtree();
         try { checkContentCall("page.click", warn); return { doc: warn.currentWindowGlobal?.documentURI?.spec }; }
         catch (e) { return { code: e.code, data: e.data, doc: warn.currentWindowGlobal?.documentURI?.spec }; }`,
        page.P
      );
      assert.equal(inFrame.code, "ZEN_PAGE_NOT_WEB_CONTENT", JSON.stringify(inFrame));
      assert.match(inFrame.data.url, /^about:(certerror|neterror)\?/);
      assert.equal(inFrame.data.frame, true);
      // Nothing added an exception for the site.
      assert.deepEqual(await overrides(), []);
    } finally {
      await site.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }));

test("frames: an error page or add-on page inside a web page is out of reach; web frames aren't", () =>
  env.inSpace("i5 frames", async page => {
    await page.goto(
      `data:text/html,<p>top text</p><iframe id="bad" src="http://127.0.0.1:1/"></iframe><iframe id="doc" srcdoc="<p>srcdoc text</p>"></iframe>`
    );
    await sleep(800);
    // Snapshot reads the srcdoc frame and prints the error page as an empty frame.
    const snap = JSON.stringify(await page.call("page.snapshot"));
    assert.match(snap, /top text/);
    assert.match(snap, /srcdoc text/);
    assert.doesNotMatch(snap, /network port|Firefox has canceled|restricted/i, snap.slice(0, 2000));
    // Every content call a document method makes checks the frame it reaches.
    const checks = await env.chrome(
      `const { checkContentCall } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/webcontent.sys.mjs");
       const { browser } = ctx.resolvePage(arg);
       const [, bad, doc] = browser.browsingContext.getAllBrowsingContextsInSubtree();
       const run = (method, bc) => { try { checkContentCall(method, bc); return "ok"; } catch (e) { return { code: e.code, data: e.data, message: e.message }; } };
       return { bad: run("page.click", bad), doc: run("page.click", doc), handOff: run("spaces.handOff", bad), url: run("page.url", bad) };`,
      page.P
    );
    assert.equal(checks.bad.code, "ZEN_PAGE_NOT_WEB_CONTENT", JSON.stringify(checks));
    assert.equal(checks.bad.data.frame, true);
    assert.match(checks.bad.data.url, /^about:neterror\?/);
    assert.match(checks.bad.message, /^page\.click refused: a frame in the page shows about:neterror/);
    assert.equal(checks.doc, "ok");
    assert.equal(checks.handOff, "ok", "the runtime's own calls aren't agent document methods");
    assert.equal(checks.url, "ok");
  }));

test("a local file's title, metrics and console never reach the agent: page.info has its URL only", () =>
  env.inSpace("i5 local file", async page => {
    const dir = scratchDir("local-");
    const file = join(dir, "local.html");
    writeFileSync(
      file,
      `<title>local file title</title><p>local file text</p><script>setInterval(() => console.log("local file console"), 100)</script>`
    );
    try {
      await page.goto(`${env.base}/nav-target`);
      const url = pathToFileURL(file).href;
      assert.equal(await userOpens(page, url), url);
      await watchConsoleIn(page, 0);
      await sleep(600);
      assert.deepEqual(await page.call("page.info"), { url });
      const events = JSON.stringify(await page.call("page.events"));
      assert.doesNotMatch(events, /local file (console|title|text)/, events.slice(0, 2000));
      assert.equal((await page.fail("page.title")).code, "ZEN_PAGE_NOT_WEB_CONTENT");
      await page.goto(`${env.base}/nav-target`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

/** Play the user opening the agent's tab. Returns a function that goes back. */
async function viewTab(page) {
  const userWs = await env.chrome(
    `const { tab, space: rec } = ctx.resolvePage(arg);
     const userWs = win.gZenWorkspaces.activeWorkspace;
     await win.gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
     // The Agents Space opens on its last tab, which can be another task's.
     win.gBrowser.selectedTab = tab;
     for (const end = Date.now() + 3000; win.gBrowser.selectedTab !== tab; ) {
       if (Date.now() > end) throw new Error("the agent's tab wasn't selected");
       await new Promise(r => win.setTimeout(r, 25));
     }
     return userWs;`,
    page.P
  );
  return () => env.chrome(`await win.gZenWorkspaces.changeWorkspaceWithID(arg);`, userWs);
}

// An add-on's dialog is the user's, never the agent's: no event, no answer.
// Hidden, it's dismissed unseen; with the user looking, Firefox shows it to
// them.
test("an add-on frame's dialog never reaches the agent: dismissed unseen while hidden, shown to the user who looks", () =>
  env.inSpace("i5 add-on dialog", async page => {
    const dir = scratchDir("addon-dialog-");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        manifest_version: 2,
        name: "zenius I5 dialog probe",
        version: "1.0",
        browser_specific_settings: { gecko: { id: "i5-dialog-probe@zenius.test" } },
        web_accessible_resources: ["frame.html"],
      })
    );
    writeFileSync(join(dir, "frame.html"), `<!doctype html><p>add-on menu</p><script src="frame.js"></script>`);
    writeFileSync(
      join(dir, "frame.js"),
      `addEventListener("message", e => {
         if (e.data === "ask") parent.postMessage({ answer: confirm("add-on asks the user") }, "*");
       });`
    );
    const shown = () =>
      env.chrome(
        `const { browser } = ctx.resolvePage(arg);
         const box = win.gBrowser.getTabDialogBox(browser);
         return !!(box._contentDialogManager?.hasDialogs || box._tabDialogManager?.hasDialogs);`,
        page.P
      );
    const ask = () =>
      page.evaluate(
        `window.__answer = "pending";
         addEventListener("message", e => (window.__answer = e.data.answer), { once: true });
         document.getElementById("menu").contentWindow.postMessage("ask", "*"); 1`
      );
    const answered = async () => {
      for (const end = Date.now() + 5000; ; await sleep(50)) {
        const a = await page.evaluate("window.__answer");
        if (a !== "pending") {
          return a;
        }
        assert.ok(Date.now() < end, "the add-on's confirm() returned");
      }
    };
    const agentHeard = async () => {
      const events = JSON.stringify(await page.call("page.events"));
      const info = await page.call("page.info");
      return /javascriptDialog|add-on asks/.test(events) || !!info.dialog;
    };
    let addon = null;
    let back = null;
    try {
      addon = await env.chrome(
        `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
         const d = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
         d.initWithPath(arg);
         const a = await AddonManager.installTemporaryAddon(d);
         return { id: a.id, host: WebExtensionPolicy.getByID(a.id).mozExtensionHostname };`,
        dir
      );
      await page.goto(`data:text/html,<p>top text</p><iframe id="menu" src="moz-extension://${addon.host}/frame.html"></iframe>`);
      await frameShows(page, /^moz-extension:/);
      await page.call("page.events");

      // Hidden: dismissed at once, with no UI.
      await ask();
      assert.equal(await answered(), false);
      assert.equal(await shown(), false);
      assert.equal(await agentHeard(), false);

      // With the user looking: Firefox shows it, and the agent can't answer it.
      back = await viewTab(page);
      await ask();
      for (const end = Date.now() + 5000; !(await shown()); await sleep(50)) {
        assert.ok(Date.now() < end, "Firefox showed the add-on's dialog");
      }
      // The agent has no dialog to answer: Ego's false.
      assert.equal(await page.call("page.acceptDialog"), false);
      assert.equal(await shown(), true);
      assert.equal(await agentHeard(), false);
      // The user cancels it.
      await env.chrome(`const { browser } = ctx.resolvePage(arg); win.gBrowser.getTabDialogBox(browser).abortAllDialogs(); return true;`, page.P);
      assert.equal(await answered(), false);
    } finally {
      await env
        .chrome(`const { browser } = ctx.resolvePage(arg); win.gBrowser.getTabDialogBox(browser).abortAllDialogs(); return true;`, page.P)
        .catch(() => {});
      if (back) {
        await back();
      }
      if (addon) {
        await env.chrome(
          `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
           await (await AddonManager.getAddonByID(arg))?.uninstall();
           return true;`,
          addon.id
        );
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }));

test("an add-on's frame in a web page: a screenshot is refused while it's there, shown or hidden; painting over it (switched off) covers it; none of its console or requests reach page.events", () =>
  env.inSpace("i5 add-on frame", async page => {
    // A frame as a password manager's inline menu is: a page of the add-on's
    // that web pages may frame (web_accessible_resources). It paints green,
    // logs, and loads an image.
    const dir = scratchDir("addon-");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        manifest_version: 2,
        name: "zenius I5 frame probe",
        version: "1.0",
        browser_specific_settings: { gecko: { id: "i5-frame-probe@zenius.test" } },
        web_accessible_resources: ["frame.html"],
      })
    );
    writeFileSync(
      join(dir, "frame.html"),
      `<!doctype html><body style="margin:0;background:#0f0"><p>add-on frame text</p><img src="${env.base}/i5-addon-frame-image.gif"><script src="frame.js"></script></body>`
    );
    writeFileSync(join(dir, "frame.js"), `setInterval(() => console.log("add-on frame console"), 100);`);
    let addon = null;
    try {
      addon = await env.chrome(
        `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
         const d = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
         d.initWithPath(arg);
         const a = await AddonManager.installTemporaryAddon(d);
         return { id: a.id, host: WebExtensionPolicy.getByID(a.id).mozExtensionHostname };`,
        dir
      );
      await page.goto(
        `data:text/html,<p>top text</p><div style="width:40px;height:40px;background:%23f00"></div><iframe id="menu" src="moz-extension://${addon.host}/frame.html"></iframe>`
      );
      await frameShows(page, /^moz-extension:/);
      await watchConsoleIn(page, 1);
      await sleep(600);

      // drawSnapshot paints the frame. The screenshot is refused while the
      // frame is in the page, even hidden: the page's script could show it
      // for the paint.
      for (const how of ["shown", "hidden", "shown again"]) {
        await page.evaluate(`document.getElementById("menu").style.display = ${JSON.stringify(how === "hidden" ? "none" : "")}`);
        await assertAddonShotRefused(page, how, addon.host);
      }
      // Painting over it, the switch the first update turns on: the page's
      // own pixels stay. Hidden, nothing of it shows and nothing is painted
      // over; shown again, it's covered again.
      await setPaintOver(true);
      try {
        for (const how of ["shown", "hidden", "shown again"]) {
          await page.evaluate(`document.getElementById("menu").style.display = ${JSON.stringify(how === "hidden" ? "none" : "")}`);
          const shot = await page.call("page.screenshot");
          const seen = await colors(shot);
          assert.equal(seen.green, 0, `${how}: the add-on frame's pixels showed`);
          assert.ok(seen.red > 0, `${how}: the page's own pixels went too`);
          assert.equal(shot.covered, how === "hidden" ? undefined : 1, how);
          assert.ok(how === "hidden" ? seen.gray === 0 : seen.gray > 0, `${how}: ${seen.gray} gray pixels`);
        }
      } finally {
        await setPaintOver(false);
      }
      // An agent call that would reach the frame is refused without its URL:
      // the host is the add-on's id in this profile.
      const reach = await env.chrome(
        `const { checkContentCall } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/webcontent.sys.mjs");
         const frame = ctx.resolvePage(arg).browser.browsingContext.children[0];
         try { checkContentCall("page.click", frame); return null; } catch (e) { return { code: e.code, data: e.data, message: e.message }; }`,
        page.P
      );
      assert.equal(reach?.code, "ZEN_PAGE_NOT_WEB_CONTENT", JSON.stringify(reach));
      assert.deepEqual(reach.data, { method: "page.click", frame: true });
      assert.match(reach.message, /^page\.click refused: a frame in the page is an add-on's/);
      assert.ok(!reach.message.includes(addon.host), reach.message);
      // The snapshot leaves the frame out, as before.
      const snap = JSON.stringify(await page.call("page.snapshot"));
      assert.match(snap, /top text/);
      assert.doesNotMatch(snap, /add-on frame text/);
      // Nothing of the frame's reached page.events: not its console, not its
      // image's request.
      const events = JSON.stringify(await page.call("page.events"));
      assert.doesNotMatch(events, /add-on frame console|i5-addon-frame-image|moz-extension:/, events.slice(0, 2000));

      // Once the frame is gone, nothing is painted over.
      await page.evaluate(`document.getElementById("menu").remove()`);
      const shot = await page.call("page.screenshot");
      assert.equal(shot.mimeType, "image/png");
      assert.equal(shot.covered, undefined);
    } finally {
      if (addon) {
        await env.chrome(
          `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
           await (await AddonManager.getAddonByID(arg))?.uninstall();
           return true;`,
          addon.id
        );
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }));

test("painting over an add-on's frame (switched off) covers it wherever it paints: in a cross-site frame, a scaled one, a scrolled page, a full page and a clip; a moving one is refused", () =>
  env.inSpace("i5 add-on cover", async page => {
    const dir = scratchDir("addon-");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        manifest_version: 2,
        name: "zenius I5 cover probe",
        version: "1.0",
        browser_specific_settings: { gecko: { id: "i5-cover-probe@zenius.test" } },
        web_accessible_resources: ["frame.html"],
      })
    );
    writeFileSync(join(dir, "frame.html"), `<!doctype html><body style="margin:0;background:#0f0"></body>`);
    let addon = null;
    try {
      addon = await env.chrome(
        `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
         const d = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
         d.initWithPath(arg);
         const a = await AddonManager.installTemporaryAddon(d);
         return { id: a.id, host: WebExtensionPolicy.getByID(a.id).mozExtensionHostname };`,
        dir
      );
      // Two cross-site frames: one with a border and padding, one scaled to
      // half. A tall page, and a red mark at its top left.
      const cross = env.base.replace("127.0.0.1", "localhost");
      assert.notEqual(cross, env.base);
      await page.goto(
        `data:text/html,<body style="margin:0"><div style="position:absolute;left:0;top:0;width:40px;height:40px;background:%23f00"></div>` +
          `<div style="height:3000px"></div>` +
          `<iframe id="mid" src="${cross}/nav-target?mid" style="position:absolute;left:60px;top:200px;width:400px;height:300px;border:7px solid %2300f;padding:5px"></iframe>` +
          `<iframe id="half" src="${cross}/nav-target?half" style="position:absolute;left:600px;top:100px;width:400px;height:300px;border:0;transform:scale(0.5);transform-origin:0 0"></iframe></body>`
      );
      // The add-on puts its frame in each, as a content script would.
      const placed = await env.chrome(
        `const top = ctx.resolvePage(arg.P).browser.browsingContext;
         const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
         const frames = () => top.children.filter(b => /nav-target\\?(mid|half)$/.test(b.currentWindowGlobal?.documentURI?.spec ?? ""));
         for (const end = Date.now() + 10000; frames().length < 2 && Date.now() < end; ) await new Promise(r => setTimeout(r, 50));
         for (const bc of frames()) {
           await ctx.content(bc, "dev#evalContent", {
             privileged: true,
             arg: arg.host,
             code: \`const f = actor.document.createElement("iframe");
               f.src = "moz-extension://" + arg + "/frame.html";
               f.style.cssText = "position:absolute;left:30px;top:40px;width:120px;height:90px;border:3px solid blue";
               actor.document.body.append(f);
               return true\`,
           });
         }
         const addonFrames = () =>
           top.getAllBrowsingContextsInSubtree().filter(b => b.currentWindowGlobal?.documentURI?.spec?.startsWith("moz-extension:"));
         for (const end = Date.now() + 10000; addonFrames().length < 2 && Date.now() < end; ) await new Promise(r => setTimeout(r, 50));
         return addonFrames().length;`,
        { P: page.P, host: addon.host }
      );
      assert.equal(placed, 2);
      await sleep(500);
      // Off, the frames in the page refuse the shot.
      await assertAddonShotRefused(page, "the frames in cross-site frames", addon.host);
      await setPaintOver(true);

      const check = async (what, options, { red = true } = {}) => {
        const shot = await page.call("page.screenshot", options ? { options } : {});
        const seen = await colors(shot);
        assert.equal(seen.green, 0, `${what}: ${seen.green} of the add-on frames' pixels showed`);
        assert.ok(seen.gray > 0, `${what}: nothing was painted over`);
        assert.equal(shot.covered, 2, what);
        if (red) {
          assert.ok(seen.red > 0, `${what}: the page's own pixels went too`);
        }
        return seen;
      };
      await check("the viewport");
      await check("the full page", { fullPage: true });
      // On screen around the bordered frame's add-on frame, and partly off it.
      await check("a clip on screen", { clip: { x: 50, y: 190, width: 300, height: 200 } }, { red: false });
      await check("a clip half below the viewport", { clip: { x: 50, y: 190, width: 300, height: 1000 } }, { red: false });
      // Scrolled: the frames move up in the viewport, and the mark with them.
      await page.evaluate("scrollTo(0, 120)");
      await check("the scrolled viewport", undefined, { red: false });
      await check("the scrolled full page", { fullPage: true });

      // A page that keeps moving the frame can leave it uncovered: the
      // three reads of where it sits can agree while the paint caught it
      // elsewhere (one run: 10800 of its pixels). So
      // the switch is off for the candidate, and the shot is refused,
      // moving or not. The first update holds the page still for the
      // paint, and checks a moving frame with the switch on.
      await setPaintOver(false);
      await page.evaluate(
        `const mid = document.getElementById("mid");
         let flip = false;
         const move = () => { flip = !flip; mid.style.left = flip ? "500px" : "60px"; window.__moving = setTimeout(move, 0); };
         move();`
      );
      for (let i = 0; i < 3; i++) {
        await assertAddonShotRefused(page, `a moving frame, shot ${i + 1}`, addon.host);
      }
      await page.evaluate("clearTimeout(window.__moving)");
    } finally {
      await setPaintOver(false).catch(() => {});
      if (addon) {
        await env.chrome(
          `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
           await (await AddonManager.getAddonByID(arg))?.uninstall();
           return true;`,
          addon.id
        );
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }));

test("an error page in a frame still paints: it shows what the page asked for, and the agent can't act in it", () =>
  env.inSpace("i5 error frame", async page => {
    await page.goto(`data:text/html,<p>top text</p><iframe src="http://127.0.0.1:1/"></iframe>`);
    await frameShows(page, /^about:neterror\?/);
    assert.equal((await page.call("page.screenshot")).mimeType, "image/png");
  }));

test("Firefox's PDF and JSON viewers stay web content", () =>
  env.inSpace("i5 viewers", async page => {
    await page.goto(`${env.base}/api/openai-gpt-4-system-card.pdf`);
    await page.call("page.waitForSelector", { target: "#downloadButton", options: { timeout: 10000 } });
    // The viewers' own JavaScript is the page's, out of the agent's world.
    assert.equal(await page.evaluate("typeof document.getElementById('viewerContainer')"), "object");
    assert.equal(await env.call("dev.evalContent", { ...page.P, code: "typeof PDFViewerApplication" }), "object");
    assert.equal(await reach(page), NOTHING);
    await page.goto(`${env.base}/api/json`);
    assert.equal(await page.evaluate("typeof document.body"), "object");
    assert.equal(await env.call("dev.evalContent", { ...page.P, code: "typeof JSONView" }), "object");
    assert.equal(await reach(page), NOTHING);
  }));

/**
 * A page with a button and a target=_blank link per URL: the buttons call
 * window.open and record what it did.
 */
const OPENERS = `(urls => {
  window.__opened = [];
  urls.forEach((url, i) => {
    const b = document.createElement("button");
    b.id = "open" + i;
    b.textContent = "open " + url;
    b.style.cssText = "display:block;font-size:20px";
    b.onclick = () => { try { window.__opened[i] = window.open(url) ? "a window" : "null"; } catch (e) { window.__opened[i] = "threw " + e.name; } };
    const a = document.createElement("a");
    a.id = "link" + i;
    a.href = url;
    a.target = "_blank";
    a.textContent = "link " + url;
    a.style.cssText = "display:block;font-size:20px";
    document.body.prepend(b, a);
  });
  return urls.length;
})`;

const PRIVILEGED_TARGETS = ["file:///etc/hostname", "about:config", "chrome://browser/content/browser.xhtml"];

/** Every tab's URL in every window, whatever its workspace. */
const allTabURLs = () =>
  env.chrome(
    `const out = [];
     for (const w of Services.wm.getEnumerator("navigator:browser")) {
       for (const b of w.document.querySelectorAll("browser")) out.push(b.currentURI?.spec ?? "");
     }
     return out;`
  );

test("window.open and target=_blank links from an agent's page fail for privileged URLs, as in a normal tab", () =>
  env.inSpace("i5 popups", async page => {
    const opener = `${env.base}/nav-target`;
    const control = `${env.base}/nav-target?i5-popup`;
    const urls = [...PRIVILEGED_TARGETS, control];
    const windows = () => env.chrome(`return [...Services.wm.getEnumerator(null)].length;`);
    const windowsBefore = await windows();

    // The agent's tab: its clicks carry user activation, so the popup
    // blocker lets every popup through and only Firefox's URL checks remain.
    await page.goto(opener);
    await page.evaluate(`${OPENERS}(${JSON.stringify(urls)})`);
    await env.chrome(
      `win.__i5Popups = [];
       win.__i5Off = service.addEventListener((event, p) => { if (event === "popup") win.__i5Popups.push(p.page); });
       return true;`
    );
    let agent;
    try {
      for (let i = 0; i < urls.length; i++) {
        // The agent's clicks: a user's press on a page the agent's code wrote
        // waits for a clean copy of it (the input layer's guard).
        await page.call("page.click", { target: `#open${i}` });
        await page.call("page.click", { target: `#link${i}` });
      }
      await sleep(1000);
      agent = {
        opened: await page.evaluate("window.__opened"),
        popups: await env.chrome(`return win.__i5Popups;`),
      };
    } finally {
      await env.chrome(`win.__i5Off?.(); return true;`);
    }
    // popupRoute adopted the two control popups, and nothing else.
    assert.equal(agent.popups.length, 2, JSON.stringify(agent));
    const pages = await env.call("pages.list", { space: page.space });
    for (const label of agent.popups) {
      const p = pages.find(x => x.label === label);
      assert.equal(p?.url, control, JSON.stringify(pages));
      assert.equal((await docState(page.page(label))).triggeredBySystem, false, "a popup loads with its opener's principal");
    }

    // The same page in a normal tab of the user's, the same calls with user activation.
    const normal = await env.chrome(
      `const tab = win.gBrowser.addTrustedTab(arg.opener, { inBackground: true, skipAnimation: true });
       const b = tab.linkedBrowser;
       for (const end = Date.now() + 10000; b.currentURI.spec !== arg.opener || b.webProgress?.isLoadingDocument; ) {
         if (Date.now() > end) throw new Error("the normal tab didn't load: " + b.currentURI.spec);
         await new Promise(r => win.setTimeout(r, 50));
       }
       const opened = [];
       const onOpen = e => opened.push(e.target);
       win.gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
       const run = async (code, privileged) => {
         const r = await b.browsingContext.currentWindowGlobal
           .getActor("Zenius")
           .sendQuery("call", { module: "dev", fn: "evalContent", args: { code, privileged } });
         if (!r?.ok) throw new Error("normal tab: " + JSON.stringify(r));
         return r.value;
       };
       try {
         await run(arg.openers + "(" + JSON.stringify(arg.urls) + ")", false);
         for (let i = 0; i < arg.urls.length; i++) {
           for (const id of ["open" + i, "link" + i]) {
             await run("document.notifyUserGestureActivation(); true", true);
             await run("document.getElementById(" + JSON.stringify(id) + ").click(); true", false);
           }
         }
         await new Promise(r => win.setTimeout(r, 1000));
         return { opened: await run("window.__opened", false), tabs: opened.map(t => t.linkedBrowser?.currentURI?.spec ?? "") };
       } finally {
         win.gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
         for (const t of opened) win.gBrowser.removeTab(t, { animate: false });
         win.gBrowser.removeTab(tab, { animate: false });
       }`,
      { opener, urls, openers: OPENERS }
    );
    // In both, the control opened and no privileged URL did.
    assert.deepEqual(normal.tabs, [control, control], JSON.stringify(normal));
    assert.deepEqual(agent.opened, normal.opened, `agent ${JSON.stringify(agent.opened)}, normal ${JSON.stringify(normal.opened)}`);
    assert.equal(agent.opened.at(-1), "a window");
    for (const url of await allTabURLs()) {
      assert.ok(!PRIVILEGED_TARGETS.some(t => url.startsWith(t)), `a tab shows ${url}`);
    }
    assert.equal(await windows(), windowsBefore, "no window opened");
  }));
