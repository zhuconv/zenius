// zen-core's clean copy on demand beside a hooked window of its group, on
// evidence. A popup on the page's site
// that the agent's code opened shares the page's group. In an earlier
// version, each new document of the
// page came in marked for being beside such a popup, the clean copy's
// replay typed the user's keys into that copy, the guard took them for the
// user's next trigger, and the page loaded afresh again and again, without
// end. Now only what the agent's code left in a document marks it: the copy
// comes in clean, the user's keys come back into it once, and the page
// isn't loaded again. A copy that does come in with evidence fails
// (stillEvident). zen-core's test, here in zen-input's suite for its
// harness: the user's click and keys in a watched agent tab.
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
const EVIDENCE = `const EV = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");`;
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

/** Mark the current document of the tab at `url` hooked, as the agent's world marks what its code left. */
const flagByUrl = url =>
  chrome(
    `${EVIDENCE} ${BY_URL}
     const wg = b?.browsingContext?.currentWindowGlobal;
     if (!wg || wg.documentURI?.spec !== arg.url) return false;
     EV.markEvident(wg, "hooked", "a script element");
     return true;`,
    { url }
  );

/** The evidence of the tab at `url`, its top document and frames. */
const evidenceByUrl = url => chrome(`${EVIDENCE} ${BY_URL} return b ? EV.evidenceOf(b) : null;`, { url });

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

test("beside a popup of its site with what the agent's code left hooked in it, a hooked page's clean copy comes in clean: it loads once, the user's keys come back into it, and the page isn't loaded again", () =>
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
      await h.until(() => flagByUrl(url(popupPath)), "the popup, hooked").catch(async e => {
        throw new Error(`${e.message}; the agent's open gave ${JSON.stringify(opened)}; tabs: ${JSON.stringify(await allUrls())}`);
      });
      assert.equal(await flagByUrl(url(mainPath)), true, "the page, hooked");
      await h.until(
        () =>
          h.call("dev.evalChrome", {
            code: `${SERVICE} const { browser } = ZeniusService.resolvePage(arg);
              return ZeniusService.content(browser.browsingContext, "dev#evalContent", { privileged: true,
                code: "return ChromeUtils.importESModule('chrome://userscripts/content/zenius/content/evidence.sys.mjs').evidenceFlag(actor.contentWindow);" });`,
            arg: where(page),
          }).then(flag => flag === "clean"),
        "the page's process to see its evidence"
      );
      assert.equal(await chrome(COUNT), 0);

      // The user presses into the field and types while the clean copy loads.
      await h.userClick(page, "#user");
      await h.sleep(300);
      await h.userPress(page, "a", "b");
      await h.until(async () => (await cleanCalls()) >= 1, "the clean copy on demand", 10_000);
      await h.until(async () => (await fields(page)).load !== "1", "the clean copy's document", 15_000);
      // In an earlier version, the page loaded afresh every second or so
      // from here, for good.
      await h.sleep(6000);
      const calls = await cleanCalls();
      const loads = loadsOf(mainPath);
      assert.equal(calls, 1, `the clean copy on demand ran ${calls} times, and the page loaded ${loads} times`);
      const after = await fields(page);
      assert.deepEqual({ user: after.user, typed: after.typed }, { user: "ab", typed: "ab" }, "the user's keys came back once, into the copy");
      assert.deepEqual(await evidenceByUrl(url(mainPath)), {}, "the copy came in clean beside the hooked popup");
      const held = await chrome(
        `${SERVICE} ${TYPING} const { browser } = ZeniusService.resolvePage(arg);
         return T.typingHolds().docs.includes(browser.browsingContext.currentWindowGlobal.innerWindowId);`,
        where(page)
      );
      assert.equal(held, false, "nothing holds the copy's typing");

      // The user's next key goes into the page, and sets nothing off.
      await h.userPress(page, "c");
      await h.sleep(1500);
      assert.equal(await cleanCalls(), 1, "no clean copy of the clean copy");
      assert.equal(loadsOf(mainPath), loads, "the page didn't load again");
      assert.equal((await fields(page)).user, "abc", "the key reached the page");
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
