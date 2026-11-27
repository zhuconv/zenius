// Portions adapted from citrolabs/ego-lite (MIT License).
// Source: package/ego-browser/scripts/real-browser-e2e/ego-source.mjs at tag v2.2.1.
// Changes for zenius: a `target` in the context. On zenius the Page ledger
// lives in the runtime, not in SDK state files, so the per-case Page
// bookkeeping uses task.pages() and readPageLedger() reads the runtime's
// ledger; toZeniusSource() maps Ego's error codes, markers and file names to
// zenius names and adds test-only stand-ins for Ego's v1 tab helpers.
export function egoSource(body, context) {
  const {
    taskName,
    baseUrl,
    artifactDir,
    tempDir,
    uploadPath,
    uploadPathTwo,
    explicitScreenshotPath,
    environmentScreenshotPath,
    metadataPath,
    keepTaskSpace,
    target = "ego",
    sentinel = "",
    zeniusInstance = null,
    zeniusRpcModule = null,
  } = context;
  return `
    const { readFile, readdir, stat, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { inflateSync } = await import("node:zlib");
    const taskName = ${JSON.stringify(taskName)};
    const baseUrl = ${JSON.stringify(baseUrl)};
    const artifactDir = ${JSON.stringify(artifactDir)};
    const tempDir = ${JSON.stringify(tempDir)};
    const uploadPath = ${JSON.stringify(uploadPath)};
    const uploadPathTwo = ${JSON.stringify(uploadPathTwo)};
    const explicitScreenshotPath = ${JSON.stringify(explicitScreenshotPath)};
    const environmentScreenshotPath = ${JSON.stringify(environmentScreenshotPath)};
    const metadataPath = ${JSON.stringify(metadataPath)};
    const keepTaskSpace = ${JSON.stringify(keepTaskSpace)};
    const evalTarget = ${JSON.stringify(target)};
    const zeniusInstance = ${JSON.stringify(zeniusInstance)};
    const zeniusRpcModule = ${JSON.stringify(zeniusRpcModule)};

    // zenius only. Its Page ledger lives in the runtime, and a test that has
    // to act as the user (open or close a tab behind the agent's back) goes
    // through the dev runtime's dev.evalChrome, which only dev profiles have.
    async function __zenDev(code, arg) {
      const { connect } = await import(zeniusRpcModule);
      const client = await connect(zeniusInstance, { callTimeout: 30000 });
      try {
        return await client.call("dev.evalChrome", { code, arg });
      } finally {
        client.close();
      }
    }

    // Budget for a Page action that has to wheel-scroll its target into view
    // first. While the browser window is covered (for example by the terminal
    // running this suite), macOS slows its frames to about one per second,
    // and Chromium holds the next mouse event's acknowledgement for up to a
    // second until the wheel gesture ends. Such an action is still correct
    // but can take more than the 3 s default.
    const scrollingActionTimeout = 10_000;

    // The Ego Lite launcher does not forward arbitrary environment variables
    // to the SDK Node process. Set isolated test configuration before the first
    // taskSpace() call; page-model reads these values lazily.
    process.env.EGO_BROWSER_STATE_DIR = join(tempDir, "runtime-state");
    process.env.EGO_BROWSER_PAGE_BUDGET = "3";

    // Ledger files are scoped by browser instance (this isolated state
    // directory belongs to the one Ego Lite instance under test) and
    // versioned: every SDK write creates space-<id>@<instance>.<n>.json and
    // removes the versions before it. The current ledger is the highest
    // version that parses, and a path listed a moment ago may already be
    // gone, so read through readPageLedger instead of holding on to a path.
    async function pageLedgerVersions(spaceId) {
      const stateDir = process.env.EGO_BROWSER_STATE_DIR;
      const prefix = "space-" + spaceId + "@";
      const names = await readdir(stateDir).catch(() => []);
      return names
        .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
        .map((name) => ({
          name,
          seq: Number(/\\.(\\d+)\\.json$/.exec(name)?.[1] ?? 0),
        }))
        .sort((a, b) => b.seq - a.seq)
        .map((entry) => join(stateDir, entry.name));
    }

    async function pageLedgerPath(spaceId) {
      const [latest] = await pageLedgerVersions(spaceId);
      assert(Boolean(latest), "a page ledger exists for space " + spaceId);
      return latest;
    }

    async function readPageLedger(spaceId) {
      if (evalTarget === "zenius") {
        // Like reading Ego's file, this has no side effects on the Pages.
        return __zenDev(
          "const pages = {};" +
            " for (const page of ctx.pages.list(arg)) {" +
            " const tab = ctx.pages.tabFor(page);" +
            " pages[page.label] = { label: page.label, targetId: tab ? ctx.pages.tabId(tab) : null, openedBy: page.openedBy }; }" +
            " return { spaceId: arg, pages };",
          spaceId
        );
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        for (const path of await pageLedgerVersions(spaceId)) {
          try {
            return JSON.parse(await readFile(path, "utf8"));
          } catch {
            // Superseded between listing and reading, or still being written.
          }
        }
      }
      throw new Error("no readable page ledger for space " + spaceId);
    }

    let __assertionCount = 0;

    function assert(condition, message) {
      __assertionCount++;
      if (!condition) throw new Error(message);
    }

    function assertEqual(actual, expected, message) {
      __assertionCount++;
      if (actual !== expected) {
        throw new Error(
          message + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)
        );
      }
    }

    function assertIncludes(text, expected, message) {
      __assertionCount++;
      assert(
        String(text).includes(expected),
        message + ": expected " + JSON.stringify(String(text).slice(0, 500)) + " to include " + JSON.stringify(expected)
      );
    }

    function countColorfulPngSamples(png) {
      const signature = "89504e470d0a1a0a";
      assertEqual(png.subarray(0, 8).toString("hex"), signature, "artifact is a PNG");
      let width = 0;
      let height = 0;
      let bitDepth = 0;
      let colorType = 0;
      let interlace = 0;
      const imageData = [];
      for (let offset = 8; offset < png.length; ) {
        const length = png.readUInt32BE(offset);
        const type = png.subarray(offset + 4, offset + 8).toString("ascii");
        const data = png.subarray(offset + 8, offset + 8 + length);
        if (type === "IHDR") {
          width = data.readUInt32BE(0);
          height = data.readUInt32BE(4);
          bitDepth = data[8];
          colorType = data[9];
          interlace = data[12];
        } else if (type === "IDAT") {
          imageData.push(data);
        }
        offset += length + 12;
        if (type === "IEND") break;
      }
      assertEqual(bitDepth, 8, "PNG sampler supports 8-bit screenshots");
      assertEqual(interlace, 0, "PNG sampler supports non-interlaced screenshots");
      const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType];
      assert(channels, "PNG sampler supports the screenshot color type");
      const inflated = inflateSync(Buffer.concat(imageData));
      const stride = width * channels;
      const pixels = Buffer.alloc(stride * height);
      let sourceOffset = 0;
      for (let y = 0; y < height; y++) {
        const filter = inflated[sourceOffset++];
        const rowOffset = y * stride;
        const previousOffset = (y - 1) * stride;
        for (let x = 0; x < stride; x++) {
          const raw = inflated[sourceOffset++];
          const left = x >= channels ? pixels[rowOffset + x - channels] : 0;
          const up = y > 0 ? pixels[previousOffset + x] : 0;
          const upperLeft = y > 0 && x >= channels
            ? pixels[previousOffset + x - channels]
            : 0;
          let predictor = 0;
          if (filter === 1) predictor = left;
          else if (filter === 2) predictor = up;
          else if (filter === 3) predictor = Math.floor((left + up) / 2);
          else if (filter === 4) {
            const estimate = left + up - upperLeft;
            const leftDistance = Math.abs(estimate - left);
            const upDistance = Math.abs(estimate - up);
            const upperLeftDistance = Math.abs(estimate - upperLeft);
            predictor = leftDistance <= upDistance && leftDistance <= upperLeftDistance
              ? left
              : upDistance <= upperLeftDistance
                ? up
                : upperLeft;
          } else if (filter !== 0) {
            throw new Error("Unsupported PNG filter " + filter);
          }
          pixels[rowOffset + x] = (raw + predictor) & 255;
        }
      }

      let colorful = 0;
      let sampled = 0;
      for (let row = 1; row <= 5; row++) {
        for (let column = 1; column <= 5; column++) {
          const x = Math.floor((width * column) / 6);
          const y = Math.floor((height * row) / 6);
          const offset = y * stride + x * channels;
          const red = pixels[offset];
          const green = colorType === 0 || colorType === 4 ? red : pixels[offset + 1];
          const blue = colorType === 0 || colorType === 4 ? red : pixels[offset + 2];
          sampled++;
          if (Math.max(red, green, blue) - Math.min(red, green, blue) > 30) colorful++;
        }
      }
      return { colorful, sampled, width, height };
    }

    async function assertRejects(fn, expected, message) {
      __assertionCount++;
      try {
        await fn();
      } catch (error) {
        assertIncludes(error?.message || String(error), expected, message);
        return;
      }
      throw new Error(message + ": expected rejection");
    }

    async function assertRejectsAny(fn, message) {
      __assertionCount++;
      try {
        await fn();
      } catch {
        return;
      }
      throw new Error(message + ": expected rejection");
    }

    async function newPageAt(task, url, options = {}) {
      const page = await task.newPage();
      await page.goto(url, options);
      return page;
    }

    async function waitForJsValue(expression, expected, message, debugExpression = null) {
      const deadline = Date.now() + 2000;
      let last;
      while (Date.now() <= deadline) {
        last = await js(expression);
        if (last === expected) return last;
        await wait(0.05);
      }
      let detail = "";
      if (debugExpression) {
        detail = "; debug=" + JSON.stringify(await js(debugExpression));
      }
      throw new Error(
        message + detail + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(last)
      );
    }

    async function waitForJsCondition(expression, message, debugExpression = null) {
      const deadline = Date.now() + 2000;
      let last;
      while (Date.now() <= deadline) {
        last = await js(expression);
        if (last) return last;
        await wait(0.05);
      }
      let detail = "";
      if (debugExpression) {
        detail = "; debug=" + JSON.stringify(await js(debugExpression));
      }
      throw new Error(message + detail + ": condition stayed false, last value " + JSON.stringify(last));
    }

    async function setStableViewport() {
      await cdp("Page.bringToFront").catch(() => {});
      await cdp("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      }).catch(() => {});
      await wait(0.1);
    }

    async function hitTestClickButton() {
      return js(
        "const el = document.querySelector('#click-button');" +
          "if (!el) return '';" +
          "const r = el.getBoundingClientRect();" +
          "const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);" +
          "return hit?.closest?.('#click-button')?.id || hit?.id || '';"
      ).catch(() => "");
    }

    async function closeFixtureTabs() {
      const tabs = await listTabs({ includeChrome: false }).catch(() => []);
      for (const tab of tabs) {
        if (String(tab.url || "").startsWith(baseUrl)) {
          await closeTab(tab.targetId).catch(() => {});
        }
      }
    }

    async function resetHome() {
      await takeOverTaskSpace(taskName).catch(() => {});
      await waitForAgentControl(taskName, { interval: 0.1, timeout: 5 });
      await closeFixtureTabs();
      const tab = await openOrReuseTab(baseUrl + "/?e2e-reset=" + Date.now(), { wait: true, timeout: 10 });
      await switchTab(tab.targetId);
      await setStableViewport();
      const nav = await gotoAndWait(baseUrl + "/", { timeout: 10 });
      assert(nav.loaded, "home page loaded");
      await setStableViewport();
      assert(
        await waitForElement("#click-button", { timeout: 3, visible: true }),
        "home fixture click button is visible"
      );
      for (let i = 0; i < 10; i += 1) {
        const info = await pageInfo();
        if (info.w > 0 && info.h > 0 && await hitTestClickButton() === "click-button") return tab;
        await setStableViewport();
      }
      const info = await pageInfo();
      assert(info.w > 0 && info.h > 0, "viewport initialized with non-zero size");
      assertEqual(await hitTestClickButton(), "click-button", "viewport hit-testing reaches the click fixture");
      return tab;
    }

    // Page ledgers persist across cases and the budget is three Pages. Record
    // the Pages each space already had so a failed case can close only the
    // Pages it opened instead of exhausting the budget for every later case.
    // Read the ledger file: task.pages() can adopt the active tab as a Page.
    const __pagesBeforeCase = new Map();
    const __taskSpace = taskSpace;
    // The space the zenius stand-ins for Ego's v1 tab helpers act on, as
    // Ego's act on the process's current space.
    let __lastTaskSpace = null;
    taskSpace = async (...args) => {
      const task = await __taskSpace(...args);
      __lastTaskSpace = task;
      if (!__pagesBeforeCase.has(task.spaceId)) {
        __pagesBeforeCase.set(task.spaceId, {
          task,
          targetIds: await ledgerTargetIds(task.spaceId),
        });
      }
      return task;
    };

    async function ledgerTargetIds(spaceId) {
      if (evalTarget === "zenius") {
        const task = await __taskSpace(spaceId);
        const pages = await task.pages().catch(() => []);
        return new Set(pages.map((page) => page.targetId));
      }
      const ledger = await readPageLedger(spaceId).catch(() => ({}));
      return new Set(
        Object.values(ledger.pages || {}).map((page) => page.targetId)
      );
    }

    async function closePagesOpenedByCase() {
      for (const { task, targetIds } of __pagesBeforeCase.values()) {
        const pages = await task.pages().catch(() => []);
        for (const page of pages) {
          if (!targetIds.has(page.targetId)) await page.close().catch(() => {});
        }
      }
    }

    try {
      ${body}
      // zen-eval: the runner counts a pass only with exit code 0 and this
      // line, carrying the run's nonce, so a script that never ran can't pass.
      cliLog(JSON.stringify({ ok: true, assertions: __assertionCount, sentinel: ${JSON.stringify(sentinel)} }));
    } catch (error) {
      cliLog(JSON.stringify({ ok: false, assertions: __assertionCount, error: error.message }));
      await closePagesOpenedByCase().catch(() => {});
      error.message = ${JSON.stringify("real browser e2e")} + ": " + error.message;
      throw error;
    }
  `;
}

// Ego names that zenius spells differently: error codes (PROTOCOL.md
// "Errors"), CLI output markers and default file names. Configuration knobs
// (EGO_BROWSER_*) keep Ego's names: the zenius SDK reads them under those.
// cliLog is Ego's unbuffered CLI print; the zenius SDK may not define it.
export function zeniusNames(text) {
  return text
    .replace(/\bEGO_(?!BROWSER_)([A-Z][A-Z0-9_]*)/g, "ZEN_$1")
    .replaceAll("[ego-browser:", "[zenius:")
    .replaceAll("ego-browser-shot-", "zenius-shot-")
    .replace(/\bcliLog\(/g, "__zenEvalLog(");
}

// Ego's v1 tab helpers (driver/nav.ts) don't exist on zenius. The adapt cases
// use them only to set up or observe the browser around the v2 API under
// test, so zenius runs get test-only stand-ins with the same results: tab
// lists come from task.tabs(), and a tab is opened or closed the way a user
// would do it, through the dev runtime (__zenDev in egoSource). A tab opened
// here is one of the task's tabs with no recorded origin ("unknown"), like
// Ego's untracked tabs. Since tasks share the Agents Space, a tab belongs to
// a task only through its session value, so the stand-in marks it as the
// runtime marks the tabs already in a claimed workspace. Ego's
// openOrReuseTab also activates the tab; this one leaves it in the
// background, which no adapt case checks.
const ZENIUS_V1_STANDINS = `
async function __zenTask() {
  return __lastTaskSpace ?? (await taskSpace(taskName));
}
async function listTabs(options = {}) {
  const includeChrome = options.includeChrome ?? true;
  const tabs = await (await __zenTask()).tabs();
  return tabs
    .filter((tab) => includeChrome || !/^(about|chrome|resource|moz-extension):/.test(tab.url))
    .map((tab, index) => ({ targetId: tab.targetId, title: tab.title, url: tab.url, active: tab.active, index }));
}
async function currentTab() {
  const tabs = await listTabs();
  const active = tabs.find((tab) => tab.active) || tabs[0];
  if (!active) throw new Error("no active browser tab");
  return { targetId: active.targetId, url: active.url, title: active.title };
}
async function openOrReuseTab(url, options = {}) {
  const existing = (await listTabs({ includeChrome: false })).find((tab) => tab.url === url);
  if (existing) return { ...existing, reused: true };
  const task = await __zenTask();
  const targetId = await __zenDev(
    'const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");' +
      " const space = ctx.resolveSpace({ space: arg.space });" +
      " const tab = W.addBackgroundTab(win, space.uuid);" +
      " ctx.pages.addUnmanaged(space, tab, 'unknown');" +
      // addBackgroundTab only opens about:blank (I5); load the URL as the
      // URL bar does (the core's glue).
      " tab.linkedBrowser.fixupAndLoadURIString(arg.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });" +
      " const end = Date.now() + arg.timeoutMs;" +
      " while (arg.wait && Date.now() < end && (tab.linkedBrowser.currentURI.spec !== arg.url || tab.linkedBrowser.webProgress?.isLoadingDocument)) {" +
      " await new Promise((resolve) => win.setTimeout(resolve, 25)); }" +
      " return ctx.pages.tabId(tab);",
    { space: task.spaceId, url, wait: options.wait !== false, timeoutMs: (options.timeout ?? 20) * 1000 }
  );
  return { targetId, url, title: "", active: false, reused: false };
}
// A frame of a Page found by part of its URL: the stand-in for a CDP iframe
// target. oop says whether it runs in another process than the Page.
async function __zenFrame(page, urlPart) {
  return __zenDev(
    "const { browsingContext } = ctx.resolvePage({ space: arg.space, page: arg.page });" +
      " const all = (bc) => [bc, ...bc.children.flatMap(all)];" +
      " const frame = all(browsingContext).slice(1).find((bc) => (bc.currentWindowGlobal?.documentURI?.spec ?? '').includes(arg.urlPart));" +
      " if (!frame) return null;" +
      " return { space: arg.space, page: arg.page, urlPart: arg.urlPart, oop: frame.currentWindowGlobal.osPid !== browsingContext.currentWindowGlobal.osPid };",
    { space: page.spaceId, page: page.label, urlPart }
  );
}
// Ego's v1 js(code, target) for a frame from __zenFrame: runs code (a function
// body) in that frame's page world.
async function js(code, target) {
  if (!target || typeof target !== "object") throw new Error("js() on zenius takes a frame from __zenFrame()");
  return __zenDev(
    "const { browsingContext } = ctx.resolvePage({ space: arg.space, page: arg.page });" +
      " const all = (bc) => [bc, ...bc.children.flatMap(all)];" +
      " const frame = all(browsingContext).slice(1).find((bc) => (bc.currentWindowGlobal?.documentURI?.spec ?? '').includes(arg.urlPart));" +
      " if (!frame) throw new Error('no frame with ' + arg.urlPart);" +
      " return ctx.content(frame, 'dev#evalContent', { code: arg.code, privileged: false, arg: null }, { timeout: 30000 });",
    { ...target, code }
  );
}
// A fixture page's own JavaScript objects (tests/fixtures/server.mjs sets
// window.__fixtureState, __mediaWorkbench and the like): the cases read them
// only to observe the fixture. In an isolated world, page.evaluate can't see
// a page's own objects, as a WebExtension content script can't. So on zenius
// those reads run in the page's own world through the dev runtime, as js()
// does (ZENIUS_FIXTURE_READS in tests/e2e/zen-adapt.mjs). fn is a function
// called with arg, or an expression, as page.evaluate takes them.
async function __zenPageWorld(page, fn, arg) {
  const code = typeof fn === "function" ? "return (" + fn.toString() + ")(arg);" : "return (" + fn + ");";
  return __zenDev(
    "const { browsingContext } = ctx.resolvePage({ space: arg.space, page: arg.page });" +
      " return ctx.content(browsingContext, 'dev#evalContent', { code: arg.code, privileged: false, arg: arg.arg }, { timeout: 30000 });",
    { space: page.spaceId, page: page.label, code, arg: arg === undefined ? null : arg }
  );
}
// page.waitForFunction(fn, arg, { timeout }) for those reads: polls the page's
// own world until fn returns a truthy value, which it returns.
async function __zenWaitPageWorld(page, fn, arg, options = {}) {
  const timeout = options.timeout ?? 30000;
  const end = Date.now() + timeout;
  for (;;) {
    const value = await __zenPageWorld(page, fn, arg);
    if (value) return value;
    if (Date.now() >= end) throw new Error("timed out after " + timeout + " ms waiting in the page's world for " + String(fn).slice(0, 120));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function closeTab(target) {
  const targetId =
    target === undefined ? (await currentTab()).targetId : typeof target === "object" ? target.targetId : target;
  const task = await __zenTask();
  await __zenDev(
    "const tab = ctx.pages.findTab(ctx.spaces.get(arg.space), arg.targetId);" +
      ' if (!tab) throw new Error("no tab " + arg.targetId + " in space " + arg.space);' +
      " ctx.pages.closeTab(tab);",
    { space: task.spaceId, targetId }
  );
  return targetId;
}
`;

export function toZeniusSource(source) {
  const prelude =
    'const __zenEvalLog = typeof cliLog === "function" ? cliLog : (...args) => console.log(...args);\n';
  return prelude + ZENIUS_V1_STANDINS + zeniusNames(source);
}
