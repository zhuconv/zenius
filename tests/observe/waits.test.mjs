// The waits: waitForLoadState (network idle included), waitForURL,
// waitForSelector, waitForEvent("popup") and waitForFunction, after Ego's
// page-load-states, page-popup-waiter and page-evaluate-timeout e2e cases.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setup, timed } from "./lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(() => env.close());

const sleep = ms => new Promise(r => setTimeout(r, ms));
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The SDK's matcher for a glob of the form "**" + tail: anchored, as Playwright's. */
const globTail = tail => ({ type: "glob", value: `**${tail}`, regex: `^.*${escape(tail)}$` });

/** Console messages a page logged, from its drained events. */
const consoleValues = events =>
  events.filter(e => e.method === "Runtime.consoleAPICalled").flatMap(e => e.params.args.map(a => a.value));

test("waitForLoadState: load waits past DOMContentLoaded; Ego's timeout text", () =>
  env.inSpace("load state", async page => {
    await page.goto(`${env.base}/domcontentloaded-page?ms=1500`, { waitUntil: "domcontentloaded" });
    const { value: e, ms } = await timed(() => page.fail("page.waitForLoadState", { state: "load", options: { timeout: 100 } }));
    assert.equal(e.code, "ZEN_TIMEOUT");
    assert.equal(e.data.plain, true);
    assert.equal(e.message, "page.waitForLoadState(load) timed out after 100ms");
    assert.ok(ms < 500, `took ${ms} ms`);
    await page.call("page.waitForLoadState", { state: "load" });
    assert.equal(await page.evaluate("document.readyState"), "complete");
    await page.call("page.waitForLoadState", { state: "domcontentloaded" });
    const bad = await page.fail("page.waitForLoadState", { state: "commit" });
    assert.equal(bad.code, "ZEN_INVALID_ARGUMENT");
    assert.equal(bad.message, 'page.waitForLoadState supports only "domcontentloaded", "load", and "networkidle"');
  }));

test("networkidle covers a request already in flight, and doesn't consume events", () =>
  env.inSpace("networkidle inflight", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.call("page.events");
    const marker = "zen-networkidle-event-preserved";
    await page.evaluate(
      ({ url, marker }) => {
        window.finished = false;
        console.log(marker);
        void fetch(url).then(r => r.text()).then(() => {
          window.finished = true;
        });
      },
      { url: `${env.base}/api/slow?ms=800&case=networkidle`, marker }
    );
    await sleep(100);
    const { ms } = await timed(() => page.call("page.waitForLoadState", { state: "networkidle", options: { timeout: 3000, idleMs: 100 } }));
    assert.ok(ms >= 600, `took ${ms} ms`);
    assert.equal(await page.evaluate("window.finished"), true);
    assert.ok(consoleValues(await page.call("page.events")).includes(marker));
  }));

test("a networkidle timeout lists the requests still in flight", () =>
  env.inSpace("networkidle timeout", async page => {
    await page.goto(`${env.base}/nav-target`);
    const url = `${env.base}/api/slow?ms=3000&case=inflight`;
    await page.call("page.events");
    await page.evaluate(u => void fetch(u).catch(() => {}), url);
    // The wait counts what the parent has seen go out. Under test-all's
    // load the fetch got there after the wait's idle window had passed, as
    // it could in Chrome: start the wait once the request is out.
    for (const end = Date.now() + 5000; ; await sleep(50)) {
      const events = await page.call("page.events");
      if (events.some(ev => ev.method === "Network.requestWillBeSent" && ev.params?.request?.url === url)) break;
      assert.ok(Date.now() < end, "the fetch never went out");
    }
    const e = await page.fail("page.waitForLoadState", { state: "networkidle", options: { timeout: 300, idleMs: 100 } });
    assert.equal(e.message, `page.waitForLoadState(networkidle) timed out after 300ms (1 requests still in flight: Fetch ${url})`);
  }));

test("goto(networkidle) waits for a slow resource and the idle window", () =>
  env.inSpace("goto networkidle", async page => {
    const { ms } = await timed(() => page.goto(`${env.base}/domcontentloaded-page?ms=700`, { waitUntil: "networkidle" }));
    assert.ok(ms >= 1000, `took ${ms} ms`);
    assert.equal(await page.evaluate("document.readyState"), "complete");
    const reload = await timed(() => page.call("page.reload", { options: { waitUntil: "networkidle" } }));
    assert.ok(reload.ms >= 1000, `reload took ${reload.ms} ms`);
  }));

test("a redirected favicon shows in events but doesn't hold network idle", () =>
  env.inSpace("favicon idle", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.call("page.events");
    await page.goto(`${env.base}/favicon-redirect-page`, { waitUntil: "commit", timeout: 1000 });
    const urls = [];
    for (let i = 0; i < 40 && !urls.some(u => u.includes("case=favicon-redirect")); i++) {
      const events = await page.call("page.events");
      urls.push(...events.filter(e => e.method === "Network.requestWillBeSent").map(e => e.params.request.url));
      await sleep(25);
    }
    assert.ok(urls.some(u => u.endsWith("/redirect/favicon.ico")), JSON.stringify(urls));
    assert.ok(urls.some(u => u.includes("case=favicon-redirect")), JSON.stringify(urls));
    const { ms } = await timed(() => page.call("page.waitForLoadState", { state: "networkidle", options: { timeout: 1200, idleMs: 200 } }));
    assert.ok(ms < 1000, `took ${ms} ms`);
  }));

test("network idle and events are per page", () =>
  env.inSpace("networkidle isolation", async quiet => {
    await quiet.goto(`${env.base}/secondary?isolation=quiet`, { waitUntil: "domcontentloaded" });
    const { label } = await env.call("pages.new", { space: quiet.space, url: `${env.base}/?isolation=busy` });
    const busy = quiet.page(label);
    await busy.call("page.waitForLoadState", { state: "load" });
    await busy.call("page.events");
    await quiet.call("page.events");
    await busy.evaluate(
      ({ url, marker }) => {
        console.log(marker);
        const request = () => void fetch(url).catch(() => {});
        request();
        window.pulse = setInterval(request, 50);
      },
      { url: `${env.base}/api/slow?ms=2000&case=isolation`, marker: "busy-marker" }
    );
    await quiet.evaluate(marker => console.log(marker), "quiet-marker");
    await sleep(100);
    const { ms } = await timed(() => quiet.call("page.waitForLoadState", { state: "networkidle", options: { timeout: 1200, idleMs: 200 } }));
    assert.ok(ms < 1000, `took ${ms} ms`);
    const busyValues = consoleValues(await busy.call("page.events"));
    const quietValues = consoleValues(await quiet.call("page.events"));
    assert.ok(busyValues.includes("busy-marker") && !busyValues.includes("quiet-marker"), JSON.stringify(busyValues));
    assert.ok(quietValues.includes("quiet-marker") && !quietValues.includes("busy-marker"), JSON.stringify(quietValues));
    await busy.evaluate("clearInterval(window.pulse)");
  }));

test("network idle counts a cross-process iframe's requests", () =>
  env.inSpace("networkidle oopif", async page => {
    await page.goto(`${env.base}/oopif-network?ms=800`, { waitUntil: "commit", timeout: 1000 });
    const { ms } = await timed(() => page.call("page.waitForLoadState", { state: "networkidle", options: { timeout: 3000, idleMs: 100 } }));
    assert.ok(ms >= 650, `took ${ms} ms`);
    await page.goto(`${env.base}/oopif-network?ms=3000`, { waitUntil: "commit", timeout: 1000 });
    await sleep(100);
    const late = await timed(() =>
      page.fail("page.waitForLoadState", { state: "networkidle", options: { timeout: 250, idleMs: 100 } })
    );
    assert.match(late.value.message, /networkidle\) timed out/);
    assert.ok(late.ms < 1000, `took ${late.ms} ms`);
    await page.evaluate("document.querySelector('iframe')?.remove()");
    await page.call("page.waitForLoadState", { state: "networkidle", options: { timeout: 2000, idleMs: 100 } });
  }));

test("waitForURL follows the page's navigations; Ego's timeout text", () =>
  env.inSpace("wait url", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.evaluate(`setTimeout(() => { location.href = ${JSON.stringify(`${env.base}/secondary?wait-url=1`)} }, 100)`);
    await page.call("page.waitForURL", { matcher: globTail("/secondary?wait-url=1") });
    // As Ego's, it doesn't wait for a load state.
    assert.equal(await page.call("page.url"), `${env.base}/secondary?wait-url=1`);
    await page.call("page.waitForURL", { matcher: { type: "regex", value: "wait-url=\\d", flags: "" } });
    // A hash change is a URL change too.
    await page.evaluate("setTimeout(() => { location.hash = 'done' }, 50)");
    await page.call("page.waitForURL", { matcher: globTail("#done") });
    const e = await page.fail("page.waitForURL", { matcher: globTail("/never"), options: { timeout: 300 } });
    assert.equal(e.code, "ZEN_TIMEOUT");
    assert.equal(
      e.message,
      `page.waitForURL timed out after 300ms: expected "**/never"; last URL was ${JSON.stringify(`${env.base}/secondary?wait-url=1#done`)}`
    );
  }));

/** Add a link to the page and click it as a user would (user activation). */
async function clickNewLink(page, id, href, target = "_blank") {
  await page.evaluate(
    ({ id, href, target }) => {
      const a = document.createElement("a");
      a.id = id;
      a.href = href;
      a.target = target;
      a.textContent = id;
      a.style.cssText = "display:block;font-size:24px";
      document.body.prepend(a);
    },
    { id, href, target }
  );
  // The agent's own click: a user's press on a page the agent's code wrote
  // waits for a clean copy of it (the input layer's guard).
  await page.call("page.click", { target: `#${id}` });
}

test("popups: a waiter sees only popups opened after it; waitForURL points at the popup", () =>
  env.inSpace("popup waiter", async page => {
    await page.goto(`${env.base}/?page=popup-waiter`);
    // A popup nobody waits for, then a waiter for the next one.
    await clickNewLink(page, "old-popup-link", `${env.base}/secondary?popup-waiter=old`);
    await sleep(300);
    const next = page.call("page.waitForEvent", { event: "popup", options: { timeout: 3000 } });
    await clickNewLink(page, "next-popup-link", `${env.base}/secondary?popup-waiter=next`);
    const popup = await next;
    assert.equal(popup.openedBy, "p1");
    assert.ok(popup.label !== "p2", `the waiter returned the old popup ${popup.label}`);
    assert.equal(typeof popup.targetId, "string");
    const other = page.page(popup.label);
    await other.call("page.waitForURL", { matcher: globTail("popup-waiter=next"), options: { timeout: 3000 } });

    // Waiting on the opener for a URL that opened in a popup fails fast.
    await clickNewLink(page, "popup-waiter-link", `${env.base}/secondary?popup-waiter=wrong-page`);
    const { value: e, ms } = await timed(() =>
      page.fail("page.waitForURL", { matcher: globTail("/secondary?popup-waiter=wrong-page"), options: { timeout: 15000 } })
    );
    assert.equal(e.code, "ZEN_URL_OPENED_IN_POPUP", e.message);
    assert.ok(ms < 2000, `took ${ms} ms`);
    assert.match(e.message, /^page p1 did not navigate from ".*", but popup p\d+ opened from it at ".*popup-waiter=wrong-page"\. The triggering action already succeeded; do not repeat it\. Continue with task\.page\("p\d+"\)\.$/);

    const t = await page.fail("page.waitForEvent", { event: "popup", options: { timeout: 300 } });
    assert.equal(t.code, "ZEN_TIMEOUT");
    assert.equal(t.message, 'page.waitForEvent("popup") timed out after 300ms');
    const bad = await page.fail("page.waitForEvent", { event: "console" });
    assert.equal(bad.message, "page.waitForEvent only supports the popup and download events");
  }));

test("a popup's url() waits for its first navigation; the lists show where it is going", () =>
  env.inSpace("popup url", async page => {
    await page.goto(`${env.base}/?page=popup-url`);
    // Pages that answer after 1.5 s: the popups stay on about:blank meanwhile.
    const opened = `${env.base}/slow-page?ms=1500&popup-url=open`;
    const linked = `${env.base}/slow-page?ms=1500&popup-url=link`;
    await page.evaluate(
      ({ opened, linked }) => {
        const button = document.createElement("button");
        button.id = "open-slow";
        button.textContent = "open slow";
        button.style.cssText = "display:block;font-size:24px";
        button.onclick = () => window.open(opened, "_blank");
        const blank = document.createElement("button");
        blank.id = "open-blank";
        blank.textContent = "open blank";
        blank.style.cssText = "display:block;font-size:24px";
        blank.onclick = () => window.open("", "_blank");
        const a = document.createElement("a");
        a.id = "link-slow";
        a.href = linked;
        a.target = "_blank";
        a.textContent = "link slow";
        a.style.cssText = "display:block;font-size:24px";
        document.body.prepend(button, blank, a);
      },
      { opened, linked }
    );

    // waitForEvent("popup"), then url() at once (Ego's popup waiter case):
    // as in Ego, url() waits one bounded period for the popup's navigation
    // and reads the committed URL. pages.list shows where it is going.
    const waiting = page.call("page.waitForEvent", { event: "popup", options: { timeout: 3000 } });
    await page.call("page.click", { target: "#open-slow" });
    const popup = page.page((await waiting).label);
    const pages = await env.call("pages.list", { space: page.space });
    assert.equal(pages.find(p => p.label === popup.label)?.url, opened, JSON.stringify(pages));
    const { value: url, ms } = await timed(() => popup.call("page.url"));
    assert.equal(url, opened);
    assert.ok(ms >= 900 && ms < 4000, `url() took ${ms} ms`);
    // The SDK's waitForURL(predicate) polling reads what the tab shows now.
    assert.equal(await page.call("page.url", { poll: true }), `${env.base}/?page=popup-url`);

    // Waiting on the opener for the URL of a popup nobody has handled yet,
    // still loading, points at the popup at once.
    await clickNewLink(page, "link-diag", `${env.base}/slow-page?ms=1500&popup-url=diag`);
    const { value: e, ms: waited } = await timed(() =>
      page.fail("page.waitForURL", { matcher: globTail("popup-url=diag"), options: { timeout: 5000 } })
    );
    assert.equal(e.code, "ZEN_URL_OPENED_IN_POPUP", e.message);
    assert.ok(waited < 1000, `took ${waited} ms`);

    // A target=_blank link through page.click: its receipt's popup reads the same.
    const receipt = await page.call("page.click", { target: "#link-slow" });
    assert.equal(receipt.popups?.length, 1, JSON.stringify(receipt));
    assert.equal(await page.page(receipt.popups[0].label).call("page.url"), linked);

    // window.open() with no URL stays about:blank.
    const blank = page.call("page.waitForEvent", { event: "popup", options: { timeout: 3000 } });
    await page.call("page.click", { target: "#open-blank" });
    assert.equal(await page.page((await blank).label).call("page.url"), "about:blank");
  }));

test("waitForSelector: Ego's selector forms and states", () =>
  env.inSpace("wait selector", async page => {
    await page.goto(`${env.base}/`);
    // #delayed is hidden and shows after 350 ms.
    const shown = await timed(() => page.call("page.waitForSelector", { target: "#delayed" }));
    assert.equal(shown.value, true);
    for (const target of [
      "css=#click-button",
      "css:#click-button",
      "loc=css:#click-button",
      'loc=role:button[name="Increment counter"]',
      "xpath=//*[@id='click-button']",
      "text=Click counter",
      'button:has-text("Click counter")',
      ".duplicate-action >> nth=1",
    ]) {
      assert.equal(await page.call("page.waitForSelector", { target, options: { timeout: 1000 } }), true, target);
    }
    // (The home page's iframe has a #click-button of its own: Ego would find
    // that one once the main frame's is gone, so use an element of our own.)
    await page.evaluate("document.body.append(Object.assign(document.createElement('p'), { id: 'zo-temp', textContent: 'temp' }))");
    await page.evaluate("setTimeout(() => document.querySelector('#zo-temp').remove(), 100)");
    await page.call("page.waitForSelector", { target: "#zo-temp", options: { state: "detached" } });
    assert.equal(await page.call("page.waitForSelector", { target: "#nothing-here", options: { state: "hidden" } }), true);

    const e = await page.fail("page.waitForSelector", { target: "#never", options: { timeout: 200 } });
    assert.equal(e.code, "ZEN_TIMEOUT");
    assert.equal(e.message, "page.waitForSelector timed out after 200ms: #never");
    const invalid = await page.fail("page.waitForSelector", { target: "[" });
    assert.equal(invalid.code, "ZEN_INVALID_ARGUMENT");
    assert.match(invalid.message, /^Invalid selector: \[/);
    const twice = await page.fail("page.waitForSelector", { target: "loc=css:.duplicate-action" });
    assert.equal(twice.code, "ZEN_SELECTOR_AMBIGUOUS");
    assert.equal(
      twice.message,
      'Locator loc=css:.duplicate-action matched 2 elements (2 visible, 0 hidden). Candidates: 1. button "Duplicate action" (visible); 2. button "Duplicate action" (visible). Use a current snapshot ref or a more specific role, text, or CSS selector.'
    );
    // Role locators get no diagnostics, as in Ego.
    const roles = await page.fail("page.waitForSelector", { target: 'loc=role:button[name="Duplicate action"]' });
    assert.equal(
      roles.message,
      'Locator loc=role:button[name="Duplicate action"] matched 2 elements. Use a current snapshot ref or a more specific role, text, or CSS selector.'
    );
  }));

test("waitForSelector on a stale ref fails at once, whatever the state, as Ego's", () =>
  env.inSpace("wait stale ref", async page => {
    const refOf = async () => {
      const snap = await page.call("page.snapshot");
      const line = (typeof snap === "string" ? snap : snap.text).split("\n").find(l => l.includes('"Increment counter"') && /\[ref=\d+\]/.test(l));
      return /\[ref=(\d+)\]/.exec(line)[1];
    };
    await page.goto(`${env.base}/`);
    const ref = await refOf();
    assert.equal(await page.call("page.waitForSelector", { target: `@${ref}`, options: { timeout: 1000 } }), true);
    // The same URL again is a new document: the ref is stale.
    await page.goto(`${env.base}/`);
    for (const state of ["visible", "attached", "hidden", "detached"]) {
      const t = Date.now();
      const e = await page.fail("page.waitForSelector", { target: `@${ref}`, options: { state, timeout: 3000 } });
      assert.equal(e.code, "ZEN_REF_STALE", `${state}: ${e.code} ${e.message}`);
      assert.equal(e.message, `Stale ref: @${ref}; take a new snapshot`);
      assert.ok(Date.now() - t < 1500, `${state}: failed at once, not at the timeout (${Date.now() - t} ms)`);
    }
    // A document that goes during the wait: the waiting call fails then.
    const fresh = await refOf();
    const t = Date.now();
    const waiting = page.fail("page.waitForSelector", { target: `@${fresh}`, options: { state: "hidden", timeout: 5000 } });
    await page.evaluate(`setTimeout(() => location.reload(), 200); 1`);
    const e = await waiting;
    assert.equal(e.code, "ZEN_REF_STALE", `${e.code} ${e.message}`);
    assert.ok(Date.now() - t < 3000, `failed when the document went (${Date.now() - t} ms)`);
  }));

test("waitForSelector looks in every frame: OOPIF, same-origin, nested", () =>
  env.inSpace("wait selector frames", async page => {
    // Ego's "Page snapshot iframe" e2e cases start with these waits.
    for (const [query, label] of [
      ["mode=cross-origin", "Cross-origin OOPIF"],
      ["mode=same-origin", "Same-origin iframe"],
      ["mode=cross-origin&layout=nested", "Nested inner iframe"],
      ["mode=same-origin&layout=siblings", "Second sibling iframe"],
    ]) {
      await page.goto(`${env.base}/snapshot-subtree-frame-host?${query}`, { waitUntil: "domcontentloaded" });
      const target = `loc=role:button[name="Run ${label} subtree action"]`;
      assert.equal(await page.call("page.waitForSelector", { target, options: { state: "visible", timeout: 5000 } }), true, query);
    }
    // A raw selector takes the first frame that has a match; a strict
    // locator must match once across all of them.
    assert.equal(await page.call("page.waitForSelector", { target: "#subtree-action", options: { timeout: 2000 } }), true);
    const e = await page.fail("page.waitForSelector", { target: "loc=css:#subtree-action", options: { timeout: 2000 } });
    assert.equal(e.code, "ZEN_SELECTOR_AMBIGUOUS");
    assert.equal(
      e.message,
      'Locator loc=css:#subtree-action matched 2 elements (2 visible, 0 hidden). Candidates: 1. button "Run First sibling iframe subtree action" (visible); 2. button "Run Second sibling iframe subtree action" (visible). Use a current snapshot ref or a more specific role, text, or CSS selector.'
    );
    // The main frame's match wins over a frame's.
    assert.equal(await page.call("page.waitForSelector", { target: "loc=css:h1", options: { timeout: 1000 } }), true);
    // Detached once the frame holding it goes away.
    await page.evaluate("setTimeout(() => document.querySelectorAll('iframe').forEach(f => f.remove()), 100)");
    assert.equal(await page.call("page.waitForSelector", { target: "#subtree-action", options: { state: "detached", timeout: 2000 } }), true);
    // A frame whose document is replaced later (Ego's "replaced iframe").
    await page.goto(`${env.base}/snapshot-subtree-frame-host?mode=cross-origin`, { waitUntil: "load" });
    await page.evaluate(
      "setTimeout(() => { const f = document.querySelector('iframe'); const u = new URL(f.src); u.searchParams.set('frame', 'replacement'); f.src = u; }, 200)"
    );
    const replaced = 'loc=role:button[name="Run Replacement iframe subtree action"]';
    assert.equal(await page.call("page.waitForSelector", { target: replaced, options: { timeout: 3000 } }), true);
  }));

/**
 * A loopback server for the page loads waitForFunction polls across:
 * /late-body sends its head at once and its body 800 ms later (until then
 * document.body is null); /late-headers answers only after 600 ms, so the
 * navigation stays pending on the old page that long.
 */
async function lateServer() {
  const server = createServer((req, res) => {
    const timers = [];
    req.on("close", () => timers.forEach(clearTimeout));
    const head = "<!doctype html><html><head><title>late</title></head>";
    const body = `<body data-ready="1"><p id="results">ok</p></body></html>`;
    if (req.url.startsWith("/late-body")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.write(head);
      timers.push(setTimeout(() => res.end(body), 800));
    } else {
      timers.push(
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(head + body);
        }, 600)
      );
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function until(fn, ms = 4000) {
  for (const end = Date.now() + ms; !(await fn()); await sleep(50)) {
    if (Date.now() > end) {
      throw new Error("timed out");
    }
  }
}

test("waitForFunction: a throw while the page is still loading (no body yet) or while a navigation is under way counts as not yet, and the wait goes on; a loaded page's throw still ends it", () =>
  env.inSpace("wait function loading", async page => {
    const late = await lateServer();
    try {
      // The page has landed but has no body yet.
      await page.goto(`${late.base}/late-body?landed`, { waitUntil: "commit" });
      const landed = await timed(() =>
        page.call("page.waitForFunction", { fn: "() => document.body.dataset.ready === '1'", isFunction: true, options: { timeout: 5000 } })
      );
      assert.equal(landed.value, true);
      assert.ok(landed.ms >= 300, `${landed.ms} ms: it waited for the body`);

      // A navigation during the wait, to a page still loading.
      await page.goto(`${env.base}/nav-target`);
      await page.evaluate(`setTimeout(() => { location.href = ${JSON.stringify(`${late.base}/late-body`)} }, 300)`);
      const loading = await timed(() =>
        page.call("page.waitForFunction", { fn: "() => document.body.dataset.ready === '1'", isFunction: true, options: { timeout: 5000 } })
      );
      assert.equal(loading.value, true);
      assert.ok(loading.ms >= 900, `${loading.ms} ms: it waited for the body`);

      // The navigation is under way: the old page, where the predicate throws, stays 600 ms.
      await page.goto(`${env.base}/nav-target`);
      await page.evaluate(`location.href = ${JSON.stringify(`${late.base}/late-headers`)}`);
      await until(() =>
        env.chrome(
          `const { trackerFor } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/navtracker.sys.mjs");
           return !!trackerFor(ctx.resolvePage(arg).browser).pending;`,
          page.P
        )
      );
      assert.equal(
        await page.call("page.waitForFunction", { fn: "() => document.querySelector('#results').textContent === 'ok'", isFunction: true, options: { timeout: 5000 } }),
        true
      );

      // On a loaded page, a throw still ends the wait at once.
      const thrown = await timed(() =>
        page.fail("page.waitForFunction", { fn: "() => document.querySelector('#none').id", isFunction: true, options: { timeout: 5000 } })
      );
      assert.equal(thrown.value.code, "ZEN_EVALUATION_FAILED");
      assert.ok(thrown.ms < 1000, `${thrown.ms} ms`);
    } finally {
      late.close();
    }
  }));

test("waitForFunction: an async predicate gets the whole timeout; Ego's texts", () =>
  env.inSpace("wait function", async page => {
    await page.goto(`${env.base}/nav-target`);
    const slow = await page.call("page.waitForFunction", {
      fn: "async () => { await new Promise(r => setTimeout(r, 1200)); return true; }",
      isFunction: true,
      options: { timeout: 2500 },
    });
    assert.equal(slow, true);
    const e = await page.fail("page.waitForFunction", { fn: "() => window.never", isFunction: true, options: { timeout: 300 } });
    assert.equal(e.code, "ZEN_TIMEOUT");
    assert.equal(
      e.message,
      `page.waitForFunction timed out after 300ms on page p1; last URL was ${JSON.stringify(`${env.base}/nav-target`)}; last title was "ego-lite nav target".`
    );
    const thrown = await timed(() =>
      page.fail("page.waitForFunction", { fn: "() => { throw new Error('nope') }", isFunction: true, options: { timeout: 5000 } })
    );
    assert.equal(thrown.value.code, "ZEN_EVALUATION_FAILED");
    assert.ok(thrown.ms < 1000);
    // The predicate follows the page to its next document.
    await page.evaluate(`setTimeout(() => { location.href = ${JSON.stringify(`${env.base}/secondary`)} }, 100)`);
    assert.equal(
      await page.call("page.waitForFunction", { fn: "() => document.title === 'ego-lite secondary'", isFunction: true, options: { timeout: 3000 } }),
      true
    );
    // An argument reaches the predicate.
    assert.equal(
      await page.call("page.waitForFunction", { fn: "(t) => document.title === t", isFunction: true, arg: "ego-lite secondary" }),
      true
    );
  }));
