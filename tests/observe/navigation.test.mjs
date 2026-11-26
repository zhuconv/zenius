// goto, reload, url, title, info and the page gate's pending-navigation
// wait, against the eval harness's fixture server (Ego's e2e routes). The cases
// follow Ego's page-pending-navigation and page-load-states e2e cases.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { setup, timed } from "./lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(() => env.close());

const sleep = ms => new Promise(r => setTimeout(r, ms));
let held = 0;
/** A URL that never answers within a test: navigations to it stay pending. */
const heldUrl = () => `${env.base}/hold-page?ms=120000&n=${++held}-${Date.now()}`;

test("goto returns Ego's receipt and waits for load", () =>
  env.inSpace("goto load", async page => {
    assert.deepEqual(await page.goto(`${env.base}/nav-target`), {});
    assert.equal(await page.call("page.url"), `${env.base}/nav-target`);
    assert.equal(await page.call("page.title"), "ego-lite nav target");
    assert.equal(await page.evaluate("document.readyState"), "complete");
    const info = await page.call("page.info");
    assert.deepEqual(Object.keys(info), ["url", "title", "w", "h", "sx", "sy", "pw", "ph"]);
    assert.equal(info.url, `${env.base}/nav-target`);
    assert.equal(info.title, "ego-lite nav target");
    assert.ok(info.w > 0 && info.h > 0 && info.pw >= info.w - 20 && info.ph > 0, JSON.stringify(info));
  }));

test("waitUntil commit and domcontentloaded return before load", () =>
  env.inSpace("goto states", async page => {
    // Ego's premise: the first chunk's inline script has run when commit
    // returns. Gecko parses a document whose charset isn't declared only
    // after 1024 bytes or its end, so the fixture declares it.
    const commit = await timed(() => page.goto(`${env.base}/streamed-page?ms=1500`, { waitUntil: "commit" }));
    assert.ok(commit.ms < 1000, `commit took ${commit.ms} ms`);
    assert.deepEqual(
      await page.evaluate(() => ({ marker: document.documentElement.dataset.committed, readyState: document.readyState })),
      { marker: "true", readyState: "loading" }
    );
    // Without a declared charset, commit still returns at once (before the
    // first chunk is parsed: at most 250 ms after the commit).
    const undeclared = await timed(() =>
      page.goto(`${env.base}/streamed-page?ms=1500&charset=none`, { waitUntil: "commit" })
    );
    assert.ok(undeclared.ms < 1000, `commit took ${undeclared.ms} ms`);
    assert.equal(await page.evaluate("document.readyState"), "loading");
    const dcl = await timed(() => page.goto(`${env.base}/domcontentloaded-page?ms=1500`, { waitUntil: "domcontentloaded" }));
    assert.ok(dcl.ms < 1000, `domcontentloaded took ${dcl.ms} ms`);
    assert.deepEqual(
      await page.evaluate(() => ({ marker: document.documentElement.dataset.domContentLoaded, readyState: document.readyState })),
      { marker: "true", readyState: "interactive" }
    );
    const load = await timed(() => page.goto(`${env.base}/domcontentloaded-page?ms=1200&load=1`));
    assert.ok(load.ms >= 1100, `load took ${load.ms} ms`);
    assert.equal(await page.evaluate("document.readyState"), "complete");
  }));

test("a committed document that misses its load state times out with Ego's text", () =>
  env.inSpace("goto committed timeout", async page => {
    const url = `${env.base}/streamed-page?ms=3000`;
    const e = await page.fail("page.goto", { url, options: { timeout: 500 } });
    assert.equal(e.code, "ZEN_NAVIGATION_TIMEOUT");
    assert.equal(
      e.message,
      `page.goto timed out after 500ms waiting for load; navigation committed at ${JSON.stringify(url)} with document.readyState="loading". Continue on this Page; call page.waitForLoadState("load") if that lifecycle state is still required.`
    );
    assert.equal(e.data.committed, true);
    assert.equal(e.data.stopped, false);
    assert.equal(e.data.url, url);
    assert.equal(e.data.readyState, "loading");
    assert.equal(e.data.waitUntil, "load");
    assert.equal(e.data.timeoutMs, 500);
  }));

test("goto to a held response stops its own navigation", () =>
  env.inSpace("goto held", async page => {
    await page.goto(`${env.base}/nav-target?pending=${Date.now()}`);
    const target = heldUrl();
    const { value: e, ms } = await timed(() => page.fail("page.goto", { url: target, options: { timeout: 1500 } }));
    assert.equal(e.code, "ZEN_NAVIGATION_TIMEOUT");
    assert.ok(ms < 4000, `took ${ms} ms`);
    assert.equal(e.data.committed, false);
    assert.equal(e.data.stopped, true);
    assert.equal(
      e.message,
      `page.goto timed out after 1500ms waiting for load; the navigation to ${JSON.stringify(target)} had not committed and was stopped, so the Page still shows its previous document. Retry page.goto(url, { timeout }) with a longer timeout, or continue on a new Page from task.newPage().`
    );
    const next = await timed(() => page.evaluate("document.title"));
    assert.equal(next.value, "ego-lite nav target");
    assert.ok(next.ms < 1000, `next call took ${next.ms} ms`);
  }));

test("a pending navigation holds the next call once, then is stopped", () =>
  env.inSpace("pending navigation", async page => {
    const home = `${env.base}/nav-target?pending-navigation=${Date.now()}`;
    await page.goto(home);
    const rt = 1500;
    // A navigation the page starts itself, as a click on a link would.
    await page.evaluate(`location.href = ${JSON.stringify(heldUrl())}`);
    await sleep(300);
    const shot = await timed(() => page.fail("page.screenshot", { responseTimeout: rt }));
    assert.equal(shot.value.code, "ZEN_PAGE_UNRESPONSIVE", shot.value.message);
    assert.equal(shot.value.data.stopped, true);
    assert.equal(shot.value.data.currentUrl, home);
    assert.equal(
      shot.value.message,
      `Page p1 (${home}) did not answer page.screenshot within ${rt}ms: a main-frame navigation had started but not committed. It was stopped once that wait ran out, so the Page answers again and shows ${home}. Retry the call to continue on that document; to load the pending one, call page.goto(url, { timeout }) with a longer timeout, or continue on a new Page from task.newPage().`
    );
    assert.ok(shot.ms >= rt && shot.ms < rt + 3500, `took ${shot.ms} ms`);
    const again = await timed(() => page.call("page.screenshot", { responseTimeout: rt }));
    assert.ok(again.ms < 1000, `the next call took ${again.ms} ms`);

    // evaluate reports it as an evaluation timeout, as Ego does.
    await page.evaluate(`location.href = ${JSON.stringify(heldUrl())}`);
    await sleep(300);
    const ev = await page.fail("page.evaluate", { fn: "document.title", isFunction: false, responseTimeout: rt });
    assert.equal(ev.code, "ZEN_PAGE_EVALUATION_TIMED_OUT");
    assert.equal(ev.data.stopped, true);
    assert.equal(ev.data.pageResponsive, true);
    assert.equal(ev.data.executionStopped, false);
    assert.equal(ev.data.mayHaveLateEffects, true);
    assert.match(ev.message, /^page\.evaluate on Page p1 timed out after 1500ms: a main-frame navigation had started but not committed/);
    assert.ok(ev.message.includes(`shows ${home}`), ev.message);
    assert.equal(await page.evaluate("document.title"), "ego-lite nav target");

    // url, title and info wait for it too, as Ego's renderer reads do, then
    // stop it; the SDK's waitForURL polling (poll) reads the URL at once.
    for (const method of ["page.url", "page.title", "page.info"]) {
      await page.evaluate(`location.href = ${JSON.stringify(heldUrl())}`);
      await sleep(300);
      const polled = await timed(() => page.call("page.url", { poll: true, responseTimeout: rt }));
      assert.equal(polled.value, home);
      assert.ok(polled.ms < 500, `a poll took ${polled.ms} ms`);
      const read = await timed(() => page.fail(method, { responseTimeout: rt }));
      assert.equal(read.value.code, "ZEN_PAGE_UNRESPONSIVE", read.value.message);
      assert.equal(read.value.data.stopped, true);
      assert.ok(read.value.message.startsWith(`Page p1 (${home}) did not answer ${method} within ${rt}ms`), read.value.message);
      assert.ok(read.ms >= rt && read.ms < rt + 3500, `${method} took ${read.ms} ms`);
      assert.equal(await page.call(method === "page.info" ? "page.url" : method), method === "page.title" ? "ego-lite nav target" : home);
    }
    // goto replaces the pending navigation and stops its own at its timeout.
    const second = await timed(() => page.fail("page.goto", { url: heldUrl(), options: { timeout: 1000 } }));
    assert.equal(second.value.code, "ZEN_NAVIGATION_TIMEOUT");
    assert.equal(second.value.data.stopped, true);
    assert.ok(second.ms < 3000, `goto took ${second.ms} ms`);
    assert.equal(await page.evaluate("document.title"), "ego-lite nav target");
  }));

// The eval harness's "page basic operations": a click returns before its link's
// navigation commits, and url() must still read the new URL.
// What the gate promises: these reads come after the click's navigation
// commits, so they read the new document, never the old one. Its <title>
// may not be parsed yet then, and in Ego too: Chromium holds Ego's reads
// until the commit, and both read "" from a page whose <title> comes after
// it (tests/observe/ego/title-after-click.mjs, 6 of 6 on each).
test("url, title and info right after a link click read the page it leads to", () =>
  env.inSpace("reads after a click", async page => {
    for (const method of ["page.url", "page.title", "page.info"]) {
      await page.goto(`${env.base}/nav-target`);
      const old = await page.call("page.title");
      const next = `${env.base}/slow-page?ms=300&m=${method}`;
      await page.evaluate(`(() => { const a = document.createElement("a"); a.id = "zo-slow"; a.href = ${JSON.stringify(next)}; a.textContent = "slow"; document.body.append(a); return 1 })()`);
      await page.call("page.click", { target: "#zo-slow" });
      const value = await page.call(method);
      if (method !== "page.title") {
        assert.equal(method === "page.url" ? value : value.url, next, method);
      }
      if (method !== "page.url") {
        const title = method === "page.info" ? value.title : value;
        assert.notEqual(title, old, `${method} read the old page`);
        assert.ok(title === "" || title === "slow page", `${method}: ${JSON.stringify(title)}`);
      }
    }
    // The parsed title, waited for.
    for (const end = Date.now() + 5000; (await page.call("page.title")) !== "slow page"; ) {
      assert.ok(Date.now() < end, "the new page's title came");
      await sleep(50);
    }
  }));

test("a pending navigation that commits in time lets the call run on the new document", () =>
  env.inSpace("pending commits", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.evaluate(`location.href = ${JSON.stringify(`${env.base}/slow-page?ms=700`)}`);
    await sleep(100);
    // The new document, right after its commit: under load its <title> may
    // not be parsed yet (in Ego too), so check where it is.
    assert.equal(await page.evaluate("location.pathname + location.search", undefined), "/slow-page?ms=700");
  }));

test("history.back to a page the back/forward cache restores after its replaceState: the next call runs at once", () =>
  env.inSpace("back to a replaced URL", async page => {
    // As a sign-in callback does, the page replaces its URL once loaded, so
    // its first request's URL is no longer its history entry's. The restore
    // reports both, and the next call used to wait out its 15 s for a commit
    // it had missed.
    const target = `${env.base}/nav-target`;
    // Firefox now and then keeps a page out of the cache, most often on a
    // loaded machine; going back then loads it afresh, which can't show the
    // bug, so the round goes again.
    let restored = false;
    for (let round = 1; round <= 3 && !restored; round++) {
      await page.goto(`${target}?code=${round}`);
      await page.evaluate(`history.replaceState(null, "", "/nav-target"); document.body.dataset.kept = "yes"`);
      await page.goto(`${env.base}/secondary`);
      await page.evaluate("history.back()");
      await page.call("page.waitForURL", { matcher: { type: "string", value: target } });
      const { value, ms } = await timed(() => page.call("page.url"));
      assert.equal(value, target);
      assert.ok(ms < 5000, `round ${round}: page.url took ${Math.round(ms)} ms`);
      restored = (await page.evaluate("document.body.dataset.kept")) === "yes";
    }
    assert.ok(restored, "the back/forward cache restored the document in one of three rounds");
  }));

test("goto to another fragment of the page is a same-document navigation: it returns at once, and the next call runs at once on that document (found on the Mac)", () =>
  env.inSpace("goto fragment", async page => {
    const tall = `data:text/html,<title>fragments</title><p id=a>a</p><div style="height:3000px"></div><p id=b>b</p>`;
    for (const url of [`${env.base}/nav-target`, tall]) {
      await page.goto(`${url}#a`);
      await page.evaluate("window.marker = 1");
      // A new fragment, the same one again (Chromium scrolls to it again),
      // and back.
      for (const hash of ["#b", "#b", "#a"]) {
        const go = await timed(() => page.goto(url + hash, { timeout: 5000 }));
        assert.deepEqual(go.value, {}, `${url}${hash}`);
        assert.ok(go.ms < 1000, `goto ${hash} took ${go.ms} ms`);
        // It once held the next call 15 s for a commit that never comes,
        // then failed it with ZEN_PAGE_EVALUATION_TIMED_OUT.
        const read = await timed(() => page.evaluate("[location.hash, window.marker ?? null]"));
        assert.deepEqual(read.value, [hash, 1], "the same document, at the new fragment");
        assert.ok(read.ms < 1000, `evaluate after goto ${hash} took ${read.ms} ms`);
        assert.equal(await page.call("page.url"), url + hash);
      }
      // Without a fragment, goto loads the page again.
      await page.goto(url);
      assert.equal(await page.evaluate("window.marker ?? null"), null);
    }
  }));

test("navigation failures are Ego's plain errors", () =>
  env.inSpace("goto failed", async page => {
    await page.goto(`${env.base}/nav-target`);
    const download = await page.fail("page.goto", { url: `${env.base}/api/download` });
    assert.equal(download.code, "ZEN_NAVIGATION_FAILED");
    assert.equal(download.data.plain, true);
    assert.equal(download.message, "page.goto failed: navigation started a download");
    // A download replaces no document.
    assert.equal(await page.call("page.title"), "ego-lite nav target");
    // A loopback port nothing listens on (Firefox blocks the well-known ones).
    const port = await new Promise(resolve => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const { port: p } = server.address();
        server.close(() => resolve(p));
      });
    });
    const refused = await page.fail("page.goto", { url: `http://127.0.0.1:${port}/` });
    assert.equal(refused.code, "ZEN_NAVIGATION_FAILED");
    assert.equal(refused.message, "page.goto failed: net::ERR_CONNECTION_REFUSED");
    const bad = await page.fail("page.goto", { url: "" });
    assert.equal(bad.code, "ZEN_INVALID_ARGUMENT");
  }));

test("reload returns a receipt and times out with Ego's plain text", () =>
  env.inSpace("reload", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.evaluate("window.marker = 1");
    assert.deepEqual(await page.call("page.reload"), {});
    assert.equal(await page.evaluate("window.marker ?? null"), null);
    await page.goto(`${env.base}/streamed-page?ms=4000`, { waitUntil: "commit" });
    const e = await page.fail("page.reload", { options: { timeout: 500 } });
    assert.equal(e.code, "ZEN_TIMEOUT");
    assert.equal(e.data.plain, true);
    assert.equal(e.message, "page.reload timed out after 500ms waiting for load");
  }));

test("a dialog opened while loading comes back as the receipt", () =>
  env.inSpace("goto dialog", async page => {
    await page.goto(`${env.base}/nav-target`);
    const url = `data:text/html,<title>alerting</title><script>alert("loading")</script>`;
    const receipt = await page.goto(url);
    assert.deepEqual(receipt, { dialog: { type: "alert", message: "loading", url } });
    const info = await page.call("page.info");
    assert.deepEqual(info, { dialog: { type: "alert", message: "loading", url } });
    // Calls that need the page fail fast with Ego's text.
    const { value: e, ms } = await timed(() => page.fail("page.screenshot"));
    assert.equal(e.code, "ZEN_PAGE_DIALOG_OPENED");
    assert.equal(
      e.message,
      'page.screenshot cannot run while a JavaScript alert dialog ("loading") is open; handle it with page.acceptDialog() or page.dismissDialog() before continuing'
    );
    assert.ok(ms < 2000);
    assert.equal(await page.call("page.acceptDialog"), true);
    assert.equal(await page.call("page.title"), "alerting");
  }));

test("goto right after pages.new isn't confused by the tab's initial about:blank", () =>
  env.inSpace("goto fresh tabs", async page => {
    await page.goto(`${env.base}/nav-target`);
    // A fresh tab may report its about:blank START after goto began; this
    // once left goto waiting for a commit it had already seen (1 in 4).
    for (let i = 0; i < 12; i++) {
      const { label } = await env.call("pages.new", { space: page.space });
      const fresh = page.page(label);
      assert.deepEqual(await fresh.goto(`${env.base}/?fresh=${i}`, { timeout: 5000 }), {}, `fresh tab ${i}`);
      await env.call("pages.close", { space: page.space, page: label });
    }
  }));
