// zen-core's clean copy on demand beside a written window of its group
// (zen-snapshot's Take over probes on 99cdc39). A popup on the page's site
// that the agent's code opened shares the page's group. While it holds the
// agent's writes, each new document of the page comes in written too
// (content/agentworld.sys.mjs, flagIfExposed). On 99cdc39 the clean copy's
// replay typed the user's keys into that written copy, the guard took them
// for the user's next trigger, and the page loaded afresh again and again,
// without end. Now a clean copy that comes in written fails: the user's
// typing there stays held, nothing is replayed, and the page isn't loaded
// again. zen-core's test, here in zen-input's suite for its harness: the
// user's click and keys in a watched agent tab.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { openHarness } from "./harness.mjs";

let h;
let task;

before(async () => {
  h = await openHarness("cleancopy-loop");
  task = await h.taskSpace("zen-core clean copy loop");
  // The agent's window.open with no click, kept in the background (as tests/core/handoff.test.mjs).
  await h.call("dev.evalChrome", {
    code: `Services.prefs.setBoolPref("dom.disable_open_during_load", false);
      Services.prefs.setBoolPref("browser.tabs.loadDivertedInBackground", true);
      return true;`,
  });
});

after(async () => {
  await h
    ?.call("dev.evalChrome", {
      code: `Services.prefs.clearUserPref("dom.disable_open_during_load");
        Services.prefs.clearUserPref("browser.tabs.loadDivertedInBackground");
        return true;`,
    })
    .catch(() => {});
  await h?.finish();
});

const chrome = (code, arg) => h.call("dev.evalChrome", { code, arg });
const SERVICE = `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");`;
const UI = `const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;`;
const TYPING = `const T = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/typing.sys.mjs");`;
const WORLD = `const AW = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentworld.sys.mjs");`;
const where = page => ({ space: page.spaceId, page: page.label });

const PAGE = n => `<!doctype html><meta charset="utf-8"><title>loop</title>
<body data-load="${n}"><input id="user" autocomplete="off">
<script>
  const u = document.getElementById("user");
  u.addEventListener("input", () => u.setAttribute("data-typed", u.value));
</script>`;

/** The site: each page's first load is quick, its later ones (the clean copies) take `slowMs`. */
async function withSite(fn, slowMs = 600) {
  const loads = new Map();
  const server = createServer((req, res) => {
    const n = (loads.get(req.url) ?? 0) + 1;
    loads.set(req.url, n);
    const send = () => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE(n));
    };
    if (n === 1) {
      send();
    } else {
      setTimeout(send, slowMs);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(path => `http://127.0.0.1:${port}${path}`, path => loads.get(path) ?? 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

/** The <browser> showing `url`, in chrome code. */
const BY_URL = `const b = [...Services.wm.getEnumerator("navigator:browser")].flatMap(w => w.gBrowser?.browsers ?? []).find(x => x.currentURI?.spec === arg.url);`;
/** Every tab's URL, for a failure's message. */
const allUrls = () => chrome(`return [...Services.wm.getEnumerator("navigator:browser")].flatMap(w => w.gBrowser?.browsers ?? []).map(x => x.currentURI?.spec);`);

/** Flag the current document of the tab at `url` written, as a write of the agent's world would. */
const flagByUrl = url =>
  chrome(
    `${WORLD} ${BY_URL}
     const wg = b?.browsingContext?.currentWindowGlobal;
     if (!wg || wg.documentURI?.spec !== arg.url) return false;
     AW.noteWritten(b.browsingContext, [wg.innerWindowId]);
     return true;`,
    { url }
  );

const fields = page =>
  h.asUser(
    page,
    `const u = document.getElementById("user");
     return { load: document.body?.dataset.load ?? null, user: u?.value ?? null, typed: u?.getAttribute("data-typed") ?? null };`
  );

/** zen-core's clean copies on demand since `count()` began counting. */
const COUNT = `${SERVICE}
  if (!Object.hasOwn(ZeniusService, "cleanOnDemand")) {
    const real = ZeniusService.cleanOnDemand;
    win.__loopCleanCalls = 0;
    ZeniusService.cleanOnDemand = function (browser) {
      win.__loopCleanCalls++;
      return real.call(this, browser);
    };
  }
  return win.__loopCleanCalls;`;
const UNCOUNT = `${SERVICE} if (Object.hasOwn(ZeniusService, "cleanOnDemand")) delete ZeniusService.cleanOnDemand; return true;`;
const cleanCalls = () => chrome(`return win.__loopCleanCalls ?? 0;`);

test("beside a popup of its site that holds the agent's writes, a written page's clean copy comes in written: it fails once, the user's typing stays held, nothing is typed again, and the page isn't loaded again", () =>
  withSite(async (url, loadsOf) => {
    const stamp = Date.now();
    const mainPath = `/form?loop-${stamp}`;
    const popupPath = `/popup?loop-${stamp}`;
    const page = await h.newPageAt(task, url(mainPath));
    const back = await h.watch(page);
    try {
      // The agent's code opens a popup on the page's site: the two share a group.
      await h.call("page.evaluate", { ...where(page), isFunction: false, fn: `(window.__p = window.open(${JSON.stringify(url(popupPath))}), 1)` });
      const opened = await h.call("page.evaluate", { ...where(page), isFunction: false, fn: "String(!!window.__p)" });
      await h.until(() => flagByUrl(url(popupPath)), "the popup, written").catch(async e => {
        throw new Error(`${e.message}; the agent's open gave ${JSON.stringify(opened)}; tabs: ${JSON.stringify(await allUrls())}`);
      });
      assert.equal(await flagByUrl(url(mainPath)), true, "the page, written");
      await h.until(
        () =>
          h.call("dev.evalChrome", {
            code: `${SERVICE} const { browser } = ZeniusService.resolvePage(arg);
              return ZeniusService.content(browser.browsingContext, "dev#evalContent", { privileged: true,
                code: "return ChromeUtils.importESModule('chrome://userscripts/content/zenius/content/agentworld.sys.mjs').pageFlag(actor.contentWindow);" });`,
            arg: where(page),
          }).then(flag => flag === "clean"),
        "the page's process to see it written"
      );
      assert.equal(await chrome(COUNT), 0);

      // The user presses into the field and types while the clean copy loads.
      await h.userClick(page, "#user");
      await h.sleep(300);
      await h.userPress(page, "a", "b");
      await h.until(async () => (await cleanCalls()) >= 1, "the clean copy on demand", 10_000);
      await h.until(async () => (await fields(page)).load !== "1", "the clean copy's document", 15_000);
      // On 99cdc39 the page loaded afresh every second or so from here, for good.
      await h.sleep(6000);
      const calls = await cleanCalls();
      const loads = loadsOf(mainPath);
      assert.equal(calls, 1, `the clean copy on demand ran ${calls} times, and the page loaded ${loads} times`);
      const after = await fields(page);
      assert.deepEqual({ user: after.user, typed: after.typed }, { user: "", typed: null }, "nothing typed again into the written copy");
      const held = await chrome(
        `${SERVICE} ${TYPING} const { browser } = ZeniusService.resolvePage(arg);
         return T.typingHolds().docs.includes(browser.browsingContext.currentWindowGlobal.innerWindowId);`,
        where(page)
      );
      assert.equal(held, true, "the written copy's typing is held");

      // The user's next key goes nowhere, and sets nothing off.
      await h.userPress(page, "c");
      await h.sleep(1500);
      assert.equal(await cleanCalls(), 1, "no clean copy for the held copy");
      assert.equal(loadsOf(mainPath), loads, "the page didn't load again");
      assert.equal((await fields(page)).user, "", "the key didn't reach the page");
    } finally {
      await chrome(UNCOUNT).catch(() => {});
      await chrome(`${BY_URL} if (b) b.ownerGlobal.gBrowser.removeTab(b.ownerGlobal.gBrowser.getTabForBrowser(b)); return true;`, { url: url(popupPath) }).catch(() => {});
      await chrome(
        `${SERVICE} ${UI}
         const rec = ZeniusService.spaces.peek(arg);
         if (UI.takeover.promptState(arg)) UI.takeover.resolve(arg, "continue");
         if (rec?.paused) UI.resumeByUser(rec);
         if (typeof rec?.lastUserInputAt === "number") rec.lastUserInputAt -= 10000;
         return true;`,
        page.spaceId
      ).catch(() => {});
      await h.call("spaces.takeOver", { space: page.spaceId }).catch(() => {});
      await back();
      await page.close().catch(() => {});
    }
  }));
