// What a page can make the main process hold: running out of memory there
// takes every window the user has with it. Each event's text is capped, each
// page's event buffer too, and a page's buffer goes when its page or its
// task ends.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { checkView, pageHelpers, setup } from "../observe/lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(() => env.close());

const sleep = ms => new Promise(r => setTimeout(r, ms));
const EVENTS = "chrome://userscripts/content/zenius/observe/events.sys.mjs";
const MiB = 1024 * 1024;

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) {
      return v;
    }
    assert.ok(Date.now() < end, `timed out waiting for ${fn}`);
    await sleep(50);
  }
}

/** The main process's malloc heap in MiB, after full collections. */
const heapMiB = () =>
  env.chrome(
    `for (let i = 0; i < 3; i++) { Cu.forceGC(); Cu.forceCC(); await new Promise(r => win.setTimeout(r, 20)); }
     return Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager).heapAllocated / ${MiB};`
  );

/**
 * How far the main process's heap is above `start`, in MiB, read until it's
 * under `cap` or 10 s have passed. That is what the process keeps, not
 * garbage that a loaded machine's background threads haven't freed yet: a
 * parallel test-all once read 32.6 MiB at once where the heap went back
 * under the cap. Text the process kept would stay far above it.
 */
async function heapGrowth(start, cap = 16) {
  let grown = Infinity;
  for (const end = Date.now() + 10000; grown >= cap && Date.now() < end; ) {
    grown = (await heapMiB()) - start;
    if (grown >= cap) {
      await sleep(500);
    }
  }
  return grown;
}

/** A page's tab id and what its event buffer holds ({events, bytes} or null). */
const bufferOf = page =>
  env.chrome(
    `const { bufferedEvents } = ChromeUtils.importESModule(arg.EVENTS);
     const { browser } = ctx.resolvePage(arg.P);
     return { browserId: browser.browserId, buffered: bufferedEvents(browser.browserId) };`,
    { P: page.P, EVENTS }
  );
const bufferById = browserId =>
  env.chrome(`return ChromeUtils.importESModule(arg.EVENTS).bufferedEvents(arg.browserId);`, { browserId, EVENTS });

/** 100 MB of text, as a page's own script would log it. */
const LOG_100MB = "for (let i = 0; i < 20; i++) console.log('x'.repeat(5e6), i); true";

test("100 MB of console logs grows the main process by about the buffer's cap, and the task's end frees each page's buffer", async () => {
  const userView = await env.call("dev.viewState");
  const { id } = await env.call("spaces.create", { name: `caps console ${Date.now() % 100000}` });
  const p1 = pageHelpers(env, id, "p1");
  const p2 = p1.page("p2");
  const p3 = p1.page("p3");
  let finished = false;
  try {
    await p1.goto(`${env.base}/nav-target`);
    for (const label of ["p2", "p3"]) {
      const opened = await env.call("pages.new", { space: id, url: `${env.base}/nav-target` });
      assert.equal(opened.label, label);
    }
    for (const p of [p1, p2, p3]) {
      await p.call("page.events");
    }
    const start = await heapMiB();

    // Page script logs 100 MB in each of two pages.
    await p1.evaluate(LOG_100MB);
    await p2.evaluate(LOG_100MB);
    await until(async () => (await bufferOf(p1)).buffered?.events >= 20 && (await bufferOf(p2)).buffered?.events >= 20);
    const grown = await heapGrowth(start);
    assert.ok(grown < 16, `the main process is still ${grown.toFixed(1)} MiB up 10 s after 200 MB of console text`);
    const { buffered } = await bufferOf(p1);
    assert.ok(buffered.bytes < 200 * 1024, `p1's buffer holds ${buffered.bytes} bytes`);

    // Each call arrives, its text cut and marked.
    const logged = (await p1.call("page.events")).filter(e => e.method === "Runtime.consoleAPICalled");
    assert.equal(logged.length, 20);
    logged.forEach((e, i) => {
      assert.equal(e.params.truncated, true);
      assert.equal(e.params.args[0].type, "string");
      assert.equal(e.params.args[0].value, "x".repeat(4096));
      assert.equal(e.params.args[0].truncated, true);
      assert.deepEqual(e.params.args[1], { type: "number", value: i });
      assert.equal(e.params.type, "log");
    });

    // The page's buffer goes when the page closes mid-task, and the rest
    // when the task finishes: the tab it keeps for the user and the one it
    // closes alike.
    const ids = {};
    for (const p of [p1, p2, p3]) {
      await p.evaluate("console.log('still here'); true");
      ids[p.label] = (await until(async () => {
        const b = await bufferOf(p);
        return b.buffered ? b : null;
      })).browserId;
    }
    await env.call("pages.close", { space: id, page: "p3" });
    assert.equal(await bufferById(ids.p3), null, "a closed page's buffer outlived it");
    assert.notEqual(await bufferById(ids.p1), null);
    await env.call("spaces.finish", { space: id, keep: ["p1"] });
    finished = true;
    assert.equal(await bufferById(ids.p1), null, "the kept tab's buffer outlived its task");
    assert.equal(await bufferById(ids.p2), null, "the closed tab's buffer outlived its task");
    // The buffers are gone (above). The task's tabs come down asynchronously,
    // in seconds under a parallel test-all: measure until the heap is back.
    const left = await heapGrowth(start);
    assert.ok(left < 16, `the main process is still ${left.toFixed(1)} MiB up 10 s after the task`);
  } finally {
    if (finished) {
      // The tab the task kept: the agent claims it back and closes it. The
      // claim may ask the user: answer as they would.
      await Promise.all([env.call("spaces.claim", { space: id }), env.call("dev.answerClaim", { space: id })]).catch(() => {});
    }
    await env.call("spaces.finish", { space: id, keep: [] }).catch(() => {});
  }
  await checkView("caps console", userView, await env.call("dev.viewState"), {});
});

test("the main process caps what it buffers, whatever sent it: each event's text, and each page's bytes, oldest out first", () =>
  env.inSpace("caps backstop", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.call("page.events");
    const start = await heapMiB();
    // 100 MB pushed in the main process itself, as a notification's body
    // would come: the cut text must not keep the whole string alive.
    // The page's late requests (its default favicon, fetched after load) can
    // land after a drain, more so in a busy test-all: each script below drains
    // the buffer before it pushes, and runs to its end before another event
    // can come in.
    const big = await env.chrome(
      `const { pushEvent, bufferedEvents, drainEvents } = ChromeUtils.importESModule(arg.EVENTS);
       const { browser } = ctx.resolvePage(arg.P);
       drainEvents(browser.browserId);
       for (let i = 0; i < 20; i++) {
         pushEvent(browser.browserId, "Zenius.notification", { title: "t" + i, body: "y".repeat(5e6), tag: "", url: "" });
       }
       return bufferedEvents(browser.browserId);`,
      { P: page.P, EVENTS }
    );
    assert.equal(big.events, 20);
    const grown = await heapGrowth(start);
    assert.ok(grown < 16, `the main process is still ${grown.toFixed(1)} MiB up 10 s after 100 MB of event text`);
    const notes = (await page.call("page.events")).filter(e => e.method === "Zenius.notification");
    assert.equal(notes.length, 20);
    for (const [i, e] of notes.entries()) {
      assert.equal(e.method, "Zenius.notification");
      assert.equal(e.params.title, `t${i}`);
      assert.equal(e.params.body, "y".repeat(4096));
      assert.equal(e.params.truncated, true);
    }

    // 300 events of 8 KiB each: the buffer keeps the newest 1 MiB.
    const kept = await env.chrome(
      `const { pushEvent, bufferedEvents, drainEvents } = ChromeUtils.importESModule(arg.EVENTS);
       const { browser } = ctx.resolvePage(arg.P);
       drainEvents(browser.browserId);
       for (let i = 0; i < 300; i++) {
         pushEvent(browser.browserId, "Zenius.notification", { title: String(i), body: "z".repeat(4000), tag: "z".repeat(4000), url: "" });
       }
       const held = bufferedEvents(browser.browserId);
       return { held, titles: drainEvents(browser.browserId).map(e => Number(e.params.title)) };`,
      { P: page.P, EVENTS }
    );
    assert.ok(kept.held.bytes <= MiB, `${kept.held.bytes} bytes`);
    assert.ok(kept.held.bytes > MiB - 16 * 1024, `${kept.held.bytes} bytes`);
    assert.ok(kept.titles.length > 100 && kept.titles.length < 300, `${kept.titles.length} events`);
    assert.deepEqual(kept.titles, Array.from({ length: kept.titles.length }, (_, i) => 300 - kept.titles.length + i));

    // Deep or wide values are cut too, and an event without cuts is whole.
    const shapes = await env.chrome(
      `const { pushEvent, drainEvents } = ChromeUtils.importESModule(arg.EVENTS);
       const { browser } = ctx.resolvePage(arg.P);
       drainEvents(browser.browserId);
       let deep = { leaf: 1 };
       for (let i = 0; i < 50; i++) deep = { deep };
       const wide = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ["k" + i, i]));
       pushEvent(browser.browserId, "Test.deep", { deep });
       pushEvent(browser.browserId, "Test.wide", { wide, list: Array.from({ length: 1000 }, (_, i) => i) });
       pushEvent(browser.browserId, "Test.whole", { a: "\\u{1F600}".repeat(10), n: 1, list: [1, 2] });
       pushEvent(browser.browserId, "Test.pair", { s: "a" + "\\u{1F600}".repeat(5000) });
       return drainEvents(browser.browserId);`,
      { P: page.P, EVENTS }
    );
    const [deep, wide, whole, pair] = shapes;
    assert.equal(deep.params.truncated, true);
    assert.ok(JSON.stringify(deep.params).length < 200);
    assert.equal(wide.params.truncated, true);
    assert.equal(Object.keys(wide.params.wide).length, 64);
    assert.equal(wide.params.list.length, 64);
    assert.deepEqual(whole.params, { a: "\u{1F600}".repeat(10), n: 1, list: [1, 2] });
    // A cut never splits a surrogate pair.
    assert.equal(pair.params.s.length, 4095);
    assert.equal(pair.params.s, "a" + "\u{1F600}".repeat(2047));
  }));

const DOWNLOADS = "chrome://userscripts/content/zenius/observe/downloads.sys.mjs";

/** What the task's downloads hold, and the number of folders in this run's download root. */
const downloadState = space =>
  env.chrome(
    `const d = ChromeUtils.importESModule(arg.DOWNLOADS);
     const folders = (await IOUtils.getChildren(d.downloadRoot())).length;
     return { ...d.taskDownloads(arg.space), folders };`,
    { space, DOWNLOADS }
  );

/** Let the fixture site start downloads without a click, or forget that again. */
const automaticDownloads = allow =>
  env.chrome(
    `const principal = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(arg.base), {});
     if (arg.allow) Services.perms.addFromPrincipal(principal, "automatic-download", Services.perms.ALLOW_ACTION, Services.perms.EXPIRE_SESSION);
     else Services.perms.removeFromPrincipal(principal, "automatic-download");
     return true;`,
    { base: env.base, allow }
  );

/** Page script that starts `n` downloads at once, each in a frame of its own. */
const burst = (n, tag) =>
  `(() => { for (let i = 0; i < ${n}; i++) { const f = document.createElement("iframe"); f.src = "/api/download?${tag}=" + i; document.body.append(f); } return true; })()`;

const refusedDownloads = events => events.filter(e => e.method === "Zenius.refused" && e.params.kind === "download");

test("a page firing downloads in a loop stops at the task's cap of 50, and finishing the task deletes its files", async () => {
  const userView = await env.call("dev.viewState");
  const { id } = await env.call("spaces.create", { name: `caps downloads ${Date.now() % 100000}` });
  const page = pageHelpers(env, id, "p1");
  // A site the user let download many files: Firefox's own guard is off,
  // and zenius's cap is all that stops it.
  await automaticDownloads(true);
  try {
    await page.goto(`${env.base}/nav-target`);
    await page.call("page.events");
    const start = await downloadState(id);
    assert.equal(start.count, 0);
    await page.evaluate(burst(60, "burst"));
    const events = [];
    await until(async () => {
      events.push(...(await page.call("page.events")));
      return refusedDownloads(events).length >= 10 && (await downloadState(id)).count >= 50;
    }, 20000);
    await sleep(500);
    events.push(...(await page.call("page.events")));
    const now = await downloadState(id);
    assert.equal(now.count, 50);
    const refused = refusedDownloads(events);
    assert.equal(refused.length, 10, JSON.stringify(refused.slice(0, 2)));
    for (const r of refused) {
      assert.match(
        r.params.message,
        /^zenius refused a download from http:\/\/127\.0\.0\.1:\d+\/api\/download\?burst=\d+: the task holds 50 downloads, the most it may \(zenius\.observe\.downloads\.maxCount\)\. Save the downloads the task needs \(download\.saveAs\(\) or download\.path\(\)\), then delete them with download\.delete\(\) to make room, or ask the user to raise the limit\.$/
      );
    }
    assert.equal(events.filter(e => e.method === "Page.downloadWillBegin").length, 50);
    // A refused download leaves no folder behind.
    assert.equal(now.folders - start.folders, 50);

    // Deleting makes room again.
    const one = events.find(e => e.method === "Page.downloadWillBegin").params.guid;
    await env.call("download.delete", { download: one });
    assert.equal((await downloadState(id)).count, 49);

    await env.call("spaces.finish", { space: id, keep: [] });
    await until(async () => (await downloadState(id)).folders === start.folders, 5000);
    assert.equal((await downloadState(id)).count, 0);
  } finally {
    await automaticDownloads(false);
    await env.call("spaces.finish", { space: id, keep: [] }).catch(() => {});
  }
  await checkView("caps downloads", userView, await env.call("dev.viewState"), {});
});

test("a download that would take the task past its byte cap is canceled and its partial file deleted", () =>
  env.inSpace("caps download bytes", async page => {
    await automaticDownloads(true);
    await env.chrome(`Services.prefs.setIntPref("zenius.observe.downloads.maxMiB", 1); return true;`);
    try {
      await page.goto(`${env.base}/nav-target`);
      await page.call("page.events");
      const start = await downloadState(page.space);
      // 3 MiB, made in the page.
      const waited = page.call("page.waitForEvent", { event: "download", options: { timeout: 10000 } }).then(
        value => ({ value }),
        error => ({ error })
      );
      await page.evaluate(
        `(() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([new Uint8Array(3 << 20)])); a.download = "big.bin"; document.body.append(a); a.click(); return true; })()`
      );
      const events = [];
      await until(async () => {
        events.push(...(await page.call("page.events")));
        return refusedDownloads(events).length >= 1;
      });
      const [r] = refusedDownloads(events);
      assert.match(r.params.message, /: it would take the task's downloads past 1 MiB \(zenius\.observe\.downloads\.maxMiB\)\./);
      const w = await waited;
      if (w.value) {
        // Known to the agent before it grew too big: it failed, for that reason.
        assert.equal(await env.call("download.failure", { download: w.value.download }), r.params.message);
        const e = await env.fail("download.read", { download: w.value.download });
        assert.equal(e.code, "ZEN_DOWNLOAD_FAILED");
      } else {
        assert.equal(w.error.code, "ZEN_DOWNLOAD_FAILED", w.error.message);
      }
      await until(async () => {
        const s = await downloadState(page.space);
        return s.bytes === 0 && s.folders === start.folders;
      });
    } finally {
      await env.chrome(`Services.prefs.clearUserPref("zenius.observe.downloads.maxMiB"); return true;`);
      await automaticDownloads(false);
    }
  }));

test("Firefox's block of repeated downloads without a click shows nothing in the user's window, and the agent hears of it", () =>
  env.inSpace("caps download spam", async page => {
    await automaticDownloads(false);
    // Zen ships with Firefox's guard off (false by default); a user may turn it on.
    await env.chrome(`Services.prefs.setBoolPref("browser.download.enable_spam_prevention", true); return true;`);
    try {
      await page.goto(`${env.base}/nav-target`);
      await page.call("page.events");
      // No click: Firefox lets the site's first download through and blocks
      // the rest, showing them in the window's downloads panel.
      await page.evaluate(burst(3, "nogesture"));
      const events = [];
      await until(async () => {
        events.push(...(await page.call("page.events")));
        return refusedDownloads(events).length >= 2;
      });
      await sleep(300);
      events.push(...(await page.call("page.events")));
      const refused = refusedDownloads(events);
      assert.equal(refused.length, 2, JSON.stringify(refused));
      assert.match(refused[0].params.message, /^Firefox blocked another download from http:\/\/127\.0\.0\.1:\d+: a site may start only one download without a click\./);
      const shown = await env.chrome(
        `const { DownloadIntegration } = ChromeUtils.importESModule("resource://gre/modules/DownloadIntegration.sys.mjs");
         const list = DownloadIntegration.downloadSpamProtection?.getSpamListForWindow(win);
         return { panel: !!win.DownloadsPanel?.isPanelShowing, spam: list ? (await list.getAll()).length : 0 };`
      );
      assert.deepEqual(shown, { panel: false, spam: 0 });
    } finally {
      await env.chrome(`Services.prefs.clearUserPref("browser.download.enable_spam_prevention"); return true;`);
      // The block leaves the site's session permission at "ask"; later tests download from it.
      await automaticDownloads(false);
    }
  }));
