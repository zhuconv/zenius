// The record of the agent's own code (observe/agentcode.sys.mjs), behind
// zen-ux's handOff warning: by site, per task, for the task's life.
// 127.0.0.1 (both fixture servers) and localhost are the two sites.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./lib.mjs";
import { startVectorServer } from "./vectors/fixture.mjs";

const MODULE = "chrome://userscripts/content/zenius/observe/agentcode.sys.mjs";
let env;
let vectors;
before(async () => {
  env = await setup();
  vectors = await startVectorServer();
});
after(async () => {
  vectors.server.close();
  await env.close();
});

/** agentCodeOnSite for `page`'s task, on its top document's site or on `url`'s. */
const onSite = (page, url) =>
  env.chrome(
    `const { agentCodeOnSite } = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
     const { space: rec, browser } = ctx.resolvePage(arg.P);
     const site = arg.url
       ? Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(arg.url), {})
       : browser.contentPrincipal;
     return agentCodeOnSite(rec, site);`,
    { P: page.P, url }
  );

/** agentCodeInPage for `page`'s task and tab: its top document or any frame. */
const inPage = page =>
  env.chrome(
    `const { agentCodeInPage } = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
     const { space: rec, browser } = ctx.resolvePage(arg);
     return agentCodeInPage(rec, browser);`,
    page.P
  );

/** agentMadePage for `page`'s task and tab: is its top document the agent's own? */
const madePage = page =>
  env.chrome(
    `const { agentMadePage } = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
     const { space: rec, browser } = ctx.resolvePage(arg);
     return agentMadePage(rec, browser);`,
    page.P
  );

const until = async (what, fn, ms = 5000) => {
  for (const end = Date.now() + ms; ; await new Promise(r => setTimeout(r, 50))) {
    const v = await fn();
    if (v) {
      return v;
    }
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
  }
};

test("the agent's code counts by site, for the rest of the task, whatever document shows it", () =>
  env.inSpace("agent code", async page => {
    await page.goto(`${env.base}/nav-target`);
    // zenius's own calls in the page aren't the agent's code.
    await page.call("page.title");
    await page.call("page.snapshot");
    assert.equal(await onSite(page), false);
    assert.equal(await inPage(page), false);

    await page.evaluate("1 + 1");
    assert.equal(await onSite(page), true);
    assert.equal(await inPage(page), true);
    assert.equal(await onSite(page, `${vectors.crossBase}/plain`), false, "another site");
    assert.equal(
      await env.chrome(
        `const { agentCodeOnSite } = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
         return agentCodeOnSite({ id: -1 }, ctx.resolvePage(arg).browser.contentPrincipal);`,
        page.P
      ),
      false,
      "another task"
    );
    // Any later document of the site counts: another page of the task that
    // the agent never ran code in, even after the first page is gone.
    const { label } = await env.call("pages.new", { space: page.space, url: `${vectors.base}/plain?other=1` });
    const other = page.page(label);
    assert.equal(await inPage(other), true);

    // A navigation to another site: that page shows no such site now. Back on
    // the first site, a new document counts again.
    await page.goto(`${vectors.crossBase}/plain`);
    assert.equal(await inPage(page), false);
    assert.equal(await onSite(page, `${env.base}/`), true, "the site keeps its record");
    await page.goto(`${env.base}/nav-target?again=1`);
    assert.equal(await inPage(page), true);

    await env.call("pages.close", { space: page.space, page: page.label });
    assert.equal(await inPage(other), true, "the page the code ran in is closed");

    // waitForFunction runs the agent's code too.
    await other.goto(`${vectors.crossBase}/plain?wait=1`);
    assert.equal(await inPage(other), false);
    await other.call("page.waitForFunction", { fn: "() => true", isFunction: true });
    assert.equal(await inPage(other), true);
  }));

test("a blob: page the agent's code navigated to counts under the site that made it", () =>
  env.inSpace("agent code blob", async page => {
    await page.goto(`${vectors.base}/plain`);
    await page.evaluate(`location.href = URL.createObjectURL(new Blob(["<p>all the agent's</p>"], { type: "text/html" })); 1`);
    await until("the blob: page", async () => (await page.call("page.url")).startsWith("blob:"));
    assert.equal(await onSite(page), true, "its principal's site");
    assert.equal(await inPage(page), true);
  }));

test("a frame on a site where the agent's code ran counts, in a page of another site", () =>
  env.inSpace("agent code in a frame", async page => {
    await page.goto(`${vectors.crossBase}/plain`);
    await page.evaluate("1");
    // The vectors page, on 127.0.0.1, has a frame from localhost.
    await page.goto(`${vectors.base}/vectors`);
    await until("the localhost frame", () =>
      env.chrome(
        `const { browser } = ctx.resolvePage(arg);
         return browser.browsingContext.children.some(bc => bc.currentWindowGlobal?.documentURI?.host === "localhost");`,
        page.P
      )
    );
    assert.equal(await onSite(page), false, "the top document's site");
    assert.equal(await inPage(page), true, "the frame's site");
  }));

test("an opaque document counts by the site that made it; one with no site behind it is the agent's", () =>
  env.inSpace("agent code opaque", async page => {
    // The agent's own data: page: no site, no precursor, and no evaluate.
    await page.goto(`data:text/html,<title>login</title><input type=password>`);
    assert.equal(await inPage(page), true, "a data: page the agent opened");
    assert.equal(await onSite(page), true);

    // A sandboxed frame of 127.0.0.1 in a page of the other site: a null
    // principal whose precursor is 127.0.0.1.
    await page.goto(`${vectors.crossBase}/sandboxed`);
    const frame = await until("the sandboxed frame", () =>
      env.chrome(
        `const { browser } = ctx.resolvePage(arg);
         const p = browser.browsingContext.children[0]?.currentWindowGlobal?.documentPrincipal;
         return p?.isNullPrincipal ? { precursor: p.precursorPrincipal?.siteOriginNoSuffix ?? null } : null;`,
        page.P
      )
    );
    assert.equal(frame.precursor, "http://127.0.0.1");
    assert.equal(await inPage(page), false, "the agent ran nothing on 127.0.0.1 yet");
    await page.goto(`${vectors.base}/plain`);
    await page.evaluate("1");
    await page.goto(`${vectors.crossBase}/sandboxed`);
    await until("the sandboxed frame again", () =>
      env.chrome(`return !!ctx.resolvePage(arg).browser.browsingContext.children[0]?.currentWindowGlobal?.documentPrincipal?.isNullPrincipal;`, page.P)
    );
    assert.equal(await onSite(page), false, "the top document's site");
    assert.equal(await inPage(page), true, "the opaque frame, by its precursor's site");
  }));

test("agentMadePage: the agent's own data: page, and an about:blank or blob: page on a site where its code ran; never a website's page", () =>
  env.inSpace("agent made page", async page => {
    // The site's own popups, on a site where the agent ran no code: the site's.
    await page.goto(`${vectors.crossBase}/writes-popup`);
    const popupOf = async button => {
      const receipt = await page.call("page.click", { target: button });
      assert.equal(receipt.popups?.length, 1, JSON.stringify(receipt));
      return page.page(receipt.popups[0].label);
    };
    const dom = await popupOf("#dom");
    const written = await popupOf("#write");
    assert.equal(await dom.call("page.url"), "about:blank");
    assert.equal(await written.call("page.url"), `${vectors.crossBase}/writes-popup`, "document.write gives it the writer's URL");
    assert.equal(await madePage(dom), false, "the site's own about:blank popup");
    assert.equal(await madePage(page), false, "a website's page");

    // Once the agent's code has run on the site, its about:blank page may be
    // the agent's. A website's page, or one that reads as it, still isn't:
    // agentCodeInPage answers for those.
    await page.evaluate("1");
    assert.equal(await madePage(dom), true, "about:blank on a site where the agent's code ran");
    assert.equal(await madePage(page), false, "a website's page the agent's code ran in");
    assert.equal(await madePage(written), false, "a written popup reads as its writer's page");
    assert.equal(await inPage(written), true);
    await page.evaluate(`location.href = URL.createObjectURL(new Blob(["<p>the agent's</p>"], { type: "text/html" })); 1`);
    await until("the blob: page", async () => (await page.call("page.url")).startsWith("blob:"));
    assert.equal(await madePage(page), true, "a blob: page");

    // The agent's own data: page, though it ran no code in it.
    await dom.goto(`data:text/html,<title>login</title><input type=password>`);
    assert.equal(await madePage(dom), true, "the agent's data: page");
  }));

/** agentCodeDocument for `page`'s tab: is its current top document marked? */
const marked = page =>
  env.chrome(
    `const { agentCodeDocument } = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
     return agentCodeDocument(ctx.resolvePage(arg).browser);`,
    page.P
  );

test("a task's untouched about:blank holds nothing and isn't the agent's page; one the agent's code wrote into is both", () =>
  env.inSpace("agent blank page", async page => {
    // The agent hands the user an empty tab to go to their bank themselves.
    assert.equal(await page.call("page.url"), "about:blank");
    assert.deepEqual({ marked: await marked(page), made: await madePage(page) }, { marked: false, made: false });
    // The agent's code draws a sign-in form into it: the agent's page.
    await page.evaluate(`document.body.innerHTML = "<form><input type=password name=pw></form>"; 1`);
    assert.deepEqual({ marked: await marked(page), made: await madePage(page) }, { marked: true, made: true });
  }));

test("a data: or blob: page that page.goto or pages.new loads is marked as the agent's code, and so is its reload; a website's page isn't", () =>
  env.inSpace("agent code loads", async page => {
    await page.goto(`${vectors.base}/plain?loads`);
    assert.equal(await marked(page), false, "a website's page");
    await page.goto("data:text/html,<title>mine</title><p>the agent's page");
    assert.equal(await marked(page), true, "the agent's data: page");
    await page.call("page.reload");
    assert.equal(await marked(page), true, "its reload");
    await page.goto(`${vectors.base}/plain?loads-again`);
    assert.equal(await marked(page), false, "the next website's page");
    // A blob: page, made in another page of the task, loaded here.
    const other = await env.call("pages.new", { space: page.space, url: `${vectors.base}/plain?blob-maker` });
    const blob = await env.call("page.evaluate", {
      space: page.space,
      page: other.label,
      fn: `URL.createObjectURL(new Blob(["<title>blob</title><p>made"], { type: "text/html" }))`,
      isFunction: false,
    });
    await page.goto(blob);
    assert.equal(await marked(page), true, "the blob: page");
    // pages.new with a data: url runs page.goto.
    const made = await env.call("pages.new", { space: page.space, url: "data:text/html,<title>new</title>" });
    assert.equal(await marked({ P: { space: page.space, page: made.label } }), true, "pages.new's data: page");
  }));

test("a finished task's record goes with it", async () => {
  let id;
  let site;
  await env.inSpace("agent code finished", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.evaluate("1");
    ({ id, site } = await env.chrome(
      `const { space: rec, browser } = ctx.resolvePage(arg);
       return { id: rec.id, site: browser.contentPrincipal.siteOriginNoSuffix };`,
      page.P
    ));
    assert.equal(
      await env.chrome(
        `const { agentCodeOnSite } = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
         return agentCodeOnSite({ id: arg.id }, arg.site);`,
        { id, site }
      ),
      true
    );
  });
  assert.equal(
    await env.chrome(
      `const { agentCodeOnSite } = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
       return agentCodeOnSite({ id: arg.id }, arg.site);`,
      { id, site }
    ),
    false
  );
});

test("zen-ux's handOff warning finds the record", async () => {
  assert.equal(
    await env.chrome(
      `const { ZeniusUI } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
       const { agentCodeOnSite } = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
       return ZeniusUI.agentCodeOnSite === agentCodeOnSite;`
    ),
    true
  );
});

const SERVICE = `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");`;

test("agentMadePage: a blank tab of the user's that the agent adopted is the user's, even after its code ran there; what the agent loads in it is the agent's", async () => {
  // A Space of the user's with one blank tab, as zen-input's adoption test makes it.
  const { space, uuid } = await env.chrome(
    `${SERVICE}
     const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     const ws = await win.gZenWorkspaces.createAndSaveWorkspace(arg, undefined, true);
     const tab = W.addBackgroundTab(win, ws.uuid);
     const before = tab.linkedBrowser.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0;
     tab.linkedBrowser.fixupAndLoadURIString("about:blank", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
     for (const end = Date.now() + 10000; Date.now() < end; await new Promise(r => win.setTimeout(r, 25))) {
       const wg = tab.linkedBrowser.browsingContext?.currentWindowGlobal;
       if (wg && wg.innerWindowId !== before && !tab.linkedBrowser.webProgress?.isLoadingDocument) break;
     }
     ZeniusService.spaces.refresh();
     return { space: ZeniusService.spaces.peekUuid(ws.uuid).id, uuid: ws.uuid };`,
    `zo adopted blank ${Date.now()}`
  );
  try {
    await Promise.all([env.call("spaces.claim", { space }), env.call("dev.answerClaim", { space })]);
    const [userTab] = await env.call("tabs.list", { space });
    assert.equal(userTab.url, "about:blank");
    const { label } = await env.call("pages.adopt", { space, tab: userTab.tab, as: "theirs" });
    const theirs = { P: { space, page: label } };
    await env.call("page.evaluate", { ...theirs.P, fn: "document.title = 'theirs'", isFunction: false });
    assert.equal(await onSite(theirs), true, "no site behind it: the agent's code counts there");
    assert.equal(await madePage(theirs), false, "the user's blank tab, though the agent's code ran in it");

    // The agent's own blank page in the same task is the agent's.
    const { label: own } = await env.call("pages.new", { space });
    const mine = { P: { space, page: own } };
    await env.call("page.evaluate", { ...mine.P, fn: "1", isFunction: false });
    assert.equal(await madePage(mine), true, "the agent's own blank page");

    // A document the agent loads in the user's tab is the agent's.
    await env.call("page.goto", { ...theirs.P, url: "data:text/html,<title>the agent's</title>" });
    assert.equal(await madePage(theirs), true, "the agent's data: page in the user's tab");
  } finally {
    await env.call("spaces.finish", { space, keep: [] }).catch(() => {});
    await env.chrome(`await win.gZenWorkspaces.removeWorkspace(arg); return true;`, uuid).catch(() => {});
  }
});
