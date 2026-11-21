// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Ego's e2e harness surface (scripts/real-browser-e2e/ego-source.mjs) over
// zenius RPC, so Ego's Page API cases in tests/input/ego/ run with few edits.
// Each Page method sends the same RPC the SDK sends (sdk/src/page.ts).
// Methods other components haven't registered yet get a stand-in when one is
// cheap (waitForSelector, waitForFunction, waitForLoadState, screenshot,
// close), or skip the rest of the case (snapshot).
import nodeAssert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { connect } from "../../scripts/lib/rpc.mjs";
import { closeFixtureServer, startFixtureServer } from "../fixtures/server.mjs";
import { checkView, FOCUS_PROBE_START, FOCUS_PROBE_STOP } from "../observe/lib.mjs";
import { systemClipboard } from "./system-clipboard.mjs";

/** Thrown to end a case early: a method it needs isn't in this runtime yet. */
export class Skip extends Error {}

const RESOLVE = "chrome://userscripts/content/zenius/content/resolve.sys.mjs";

// A run that hangs must not keep a dev Zen (a visible window on the Mac)
// open: past this, the process closes up and exits, and run.sh stops the
// instance.
const WATCHDOG_MS = Number(process.env.ZENIUS_INPUT_WATCHDOG_MS) || 5 * 60_000;

/** A chord that copies or cuts on some platform: Accel+C or X, Ctrl+Insert, Shift+Delete, the Copy and Cut keys. */
function isCopyOrCut(chord) {
  const parts = String(chord).toLowerCase().split("+");
  const key = parts.pop();
  const accel = parts.some(m => ["control", "meta", "controlormeta", "ctrl", "cmd", "command"].includes(m));
  return (accel && ["c", "x", "insert"].includes(key)) || (parts.includes("shift") && key === "delete") || key === "copy" || key === "cut";
}

// Types by extension, as the SDK's table gives them; "" lets the runtime
// ask Gecko's MIME service.
const MIME_TYPES = { ".txt": "text/plain", ".html": "text/html", ".json": "application/json", ".png": "image/png", ".pdf": "application/pdf" };

/**
 * What the SDK sends for Ego's paths: the runtime never reads a path an agent
 * names (SPEC I5), so the client reads each file and sends its bytes.
 *
 * @param {string|string[]} files
 * @param {string} operation
 */
export async function filePayloads(files, operation) {
  const out = [];
  for (const path of Array.isArray(files) ? files : [files]) {
    let info;
    try {
      info = await stat(path);
    } catch (e) {
      throw new Error(`${operation} could not read ${path}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
    }
    if (info.isDirectory()) {
      throw new Error(`${operation} could not read ${path}: it is a directory`);
    }
    out.push({
      name: basename(path),
      mimeType: MIME_TYPES[extname(path).toLowerCase()] ?? "",
      lastModified: Math.round(info.mtimeMs),
      base64: (await readFile(path)).toString("base64"),
    });
  }
  return out;
}

export async function openHarness(suite) {
  const instance = process.env.ZENIUS_INSTANCE;
  if (!instance) {
    throw new Error("ZENIUS_INSTANCE is not set; run tests/input/run.sh");
  }
  let closeUp = async () => {};
  const watchdog = setTimeout(async () => {
    console.error(`zen-input ${suite}: still running after ${WATCHDOG_MS} ms; closing up and exiting so the dev Zen doesn't stay open`);
    await capped(closeUp(), 10_000);
    process.exit(2);
  }, WATCHDOG_MS);
  watchdog.unref();
  const client = await connect(instance);
  const fixture = await startFixtureServer(`zen-input-${suite}`);
  // Each RPC's start and end, for the focus timeline when I1 fails.
  const steps = [];
  const call = (method, params) => {
    const t = Date.now();
    return client.call(method, params).finally(() => {
      steps.push({ t, end: Date.now(), step: method });
      if (steps.length > 400) {
        steps.splice(0, 200);
      }
    });
  };
  const methods = new Set((await call("browser.methods")).methods);
  const userView = await call("dev.viewState");
  // zen-observe's focus probe: tells the OS giving focus to another app (the
  // user at the Mac) from I1 preemption.
  const focusProbe = await call("dev.evalChrome", { code: FOCUS_PROBE_START }).catch(() => null);
  let probeStopped = !focusProbe;
  const headless = await call("dev.evalChrome", { code: `return Services.env.get("MOZ_HEADLESS") === "1";` });
  const clipboard = systemClipboard({ headless, call, lifetimeMs: WATCHDOG_MS });
  /** Copy and cut chords are each checked against the system clipboard. */
  const chord = (key, label, fn) => (isCopyOrCut(key) ? clipboard.step(label, fn) : fn());
  const artifactDir = await mkdtemp(join(tmpdir(), "zen-input-"));
  const spaces = new Map();
  let assertions = 0;

  const has = method => methods.has(method);
  const need = method => {
    if (!has(method)) {
      throw new Skip(`${method} is not in this runtime yet`);
    }
  };

  class Page {
    constructor(task, label) {
      this.task = task;
      this.spaceId = task.spaceId;
      this.label = label;
      this.targetId = label;
      this.mouse = {
        move: (x, y, options = {}) => this.#rpc("page.mouse", { action: "move", x, y, options }),
        down: (options = {}) => this.#rpc("page.mouse", { action: "down", options }),
        up: (options = {}) => this.#rpc("page.mouse", { action: "up", options }),
        click: (x, y, options = {}) => this.#rpc("page.mouse", { action: "click", x, y, options }),
        wheel: (deltaX, deltaY, options = {}) => this.#rpc("page.mouse", { action: "wheel", dx: deltaX, dy: deltaY, options }),
      };
      this.keyboard = {
        down: key => this.#rpc("page.keyboard", { action: "down", key }),
        up: key => this.#rpc("page.keyboard", { action: "up", key }),
        press: (key, options = {}) => chord(key, `keyboard.press(${key})`, () => this.#rpc("page.keyboard", { action: "press", key, options })),
        type: (text, options = {}) => this.#rpc("page.keyboard", { action: "type", text, options }),
        insertText: text => this.#rpc("page.keyboard", { action: "insertText", text }),
        paste: content =>
          this.#rpc(
            "page.keyboard",
            typeof content === "string" ? { action: "paste", text: content } : { action: "paste", text: content.text, html: content.html }
          ),
      };
    }

    #rpc(method, params) {
      return call(method, { space: this.spaceId, page: this.label, ...params });
    }

    goto(url, options = {}) {
      return this.#rpc("page.goto", { url, options });
    }

    /** Stand-in for zen-observe's page.url: a new popup reads about:blank until its load commits. */
    async url() {
      const deadline = Date.now() + 2000;
      for (;;) {
        let href = "about:blank";
        try {
          href = await this.evaluate(() => location.href);
        } catch (e) {
          // The load committed during the read, and its first document went.
          if (e?.data?.reason !== "context_destroyed" || Date.now() >= deadline) {
            throw e;
          }
        }
        if (href !== "about:blank" || Date.now() >= deadline) {
          return href;
        }
        await sleep(50);
      }
    }

    /** Ego's evaluate(fn, arg) in the page's own world. */
    evaluate(fn, arg) {
      const code = typeof fn === "function" ? `return (${fn})(arg);` : `return (${fn});`;
      return this.#rpc("dev.evalContent", { code, arg });
    }

    /** Chrome JS in the page's content process (`actor` bound). */
    privileged(code, arg) {
      return this.#rpc("dev.evalContent", { code, arg, privileged: true });
    }

    click(target, options = {}) {
      return this.#rpc("page.click", { target, options });
    }
    dblclick(target, options = {}) {
      return this.#rpc("page.dblclick", { target, options });
    }
    hover(target, options = {}) {
      return this.#rpc("page.hover", { target, options });
    }
    focus(target, options = {}) {
      return this.#rpc("page.focus", { target, options });
    }
    fill(target, value, options = {}) {
      return this.#rpc("page.fill", { target, value, options });
    }
    press(target, key, options = {}) {
      return chord(key, `press(${target}, ${key})`, () => this.#rpc("page.press", { target, chord: key, options }));
    }
    dragAndDrop(source, target, options = {}) {
      return this.#rpc("page.dragAndDrop", { source, target, options });
    }
    async setInputFiles(target, files) {
      return this.#rpc("page.setInputFiles", { target, files: await filePayloads(files, "page.setInputFiles") });
    }
    async selectOption(target, valueOrValues, options = {}) {
      const values = valueOrValues === null ? [] : Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues];
      const result = await this.#rpc("page.selectOption", { target, values, options });
      return Array.isArray(result) ? result : (result?.selected ?? []);
    }

    async waitForFileChooser(options = {}) {
      // As the SDK does: zen-observe's page.waitForEvent hands it to zen-input.
      const result = await this.#rpc("page.waitForEvent", { event: "filechooser", options });
      return {
        isMultiple: () => result.multiple === true,
        setFiles: async files => call("filechooser.setFiles", { chooser: result.chooser, files: await filePayloads(files, "fileChooser.setFiles") }),
        /** The frame as given: for tests of what the runtime refuses. */
        setRaw: files => call("filechooser.setFiles", { chooser: result.chooser, files }),
      };
    }

    async snapshot(options = {}) {
      need("page.snapshot");
      return (await this.#rpc("page.snapshot", { options })).text;
    }

    async waitForSelector(target, options = {}) {
      if (has("page.waitForSelector")) {
        return this.#rpc("page.waitForSelector", { target, options });
      }
      // Stand-in: poll the resolver for a visible match.
      const timeout = options.timeout ?? 10000;
      const state = options.state ?? "visible";
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = await this.privileged(
          `const R = ChromeUtils.importESModule(${JSON.stringify(RESOLVE)});
           const els = R.elementsIn(actor.document, R.parseTarget(arg.target));
           const visible = els.some(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.ownerDocument.defaultView.getComputedStyle(el).visibility !== "hidden"; });
           return { attached: els.length > 0, visible };`,
          { target }
        );
        const ok = state === "attached" ? found.attached : state === "detached" ? !found.attached : state === "hidden" ? !found.visible : found.visible;
        if (ok) {
          return { state };
        }
        if (Date.now() >= deadline) {
          throw new Error(`page.waitForSelector timed out after ${timeout}ms`);
        }
        await sleep(50);
      }
    }

    async waitForFunction(fn, arg, options = {}) {
      if (has("page.waitForFunction")) {
        // The SDK's request shape (sdk/src/page.ts evaluateParams).
        const isFunction = typeof fn === "function";
        return this.#rpc("page.waitForFunction", {
          fn: isFunction ? String(fn) : fn,
          isFunction,
          ...(arg === undefined ? {} : { arg }),
          options,
        });
      }
      const timeout = options.timeout ?? 10000;
      const deadline = Date.now() + timeout;
      for (;;) {
        const value = await this.evaluate(fn, arg);
        if (value) {
          return value;
        }
        if (Date.now() >= deadline) {
          throw new Error(`page.waitForFunction timed out after ${timeout}ms`);
        }
        await sleep(50);
      }
    }

    async waitForLoadState(state = "load", options = {}) {
      if (has("page.waitForLoadState")) {
        return this.#rpc("page.waitForLoadState", { state, options });
      }
      await this.waitForFunction(() => document.readyState === "complete", undefined, options);
      if (state === "networkidle") {
        await sleep(600);
      }
    }

    async screenshot(options = {}) {
      if (has("page.screenshot")) {
        // I5 (zen-observe glue): the runtime returns the PNG's bytes and
        // writes no file; the client writes path, as the SDK does.
        const { path, ...rest } = options;
        const { base64 } = await this.#rpc("page.screenshot", { options: rest });
        if (path !== undefined) {
          await writeFile(path, Buffer.from(base64, "base64"));
        }
        return path ?? base64;
      }
      // Stand-in: the tab's own rendering, as a PNG.
      const png = await call("dev.evalChrome", {
        code: `
          const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");
          const { browsingContext } = ZeniusService.resolvePage(arg);
          const wgp = browsingContext.currentWindowGlobal;
          const bitmap = await wgp.drawSnapshot(null, 1, "white");
          const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d").drawImage(bitmap, 0, 0);
          bitmap.close();
          return canvas.toDataURL("image/png").split(",")[1];`,
        arg: { space: this.spaceId, page: this.label },
      });
      const bytes = Buffer.from(png, "base64");
      if (options.path) {
        await writeFile(options.path, bytes);
      }
      return bytes;
    }

    async close() {
      if (has("pages.close")) {
        await call("pages.close", { space: this.spaceId, page: this.label });
      } else {
        await this.goto("about:blank").catch(() => {});
      }
    }
  }

  class Task {
    constructor(spaceId, name) {
      this.spaceId = spaceId;
      this.name = name;
    }
    async newPage() {
      const { label } = await call("pages.new", { space: this.spaceId });
      return new Page(this, label);
    }
    page(label) {
      return new Page(this, label);
    }
    cdp() {
      throw new Skip("zenius has no CDP");
    }
  }

  const h = {
    call,
    has,
    need,
    baseUrl: fixture.baseUrl,
    /** Same server, other site: its iframes run out of process. */
    crossUrl: fixture.baseUrl.replace("127.0.0.1", "localhost"),
    taskName: `zen-input ${suite}`,
    platform: process.platform,
    scrollingActionTimeout: 10_000,
    artifactDir,
    join,
    readFile,
    sleep,
    wait: seconds => sleep(seconds * 1000),

    /** Ego's taskSpace(name): this harness's Space of that name. */
    async taskSpace(name) {
      let id = spaces.get(name);
      if (id === undefined) {
        ({ id } = await call("spaces.create", { name: `${name} ${Date.now()}` }));
        spaces.set(name, id);
      }
      return new Task(id, name);
    },
    async newPageAt(task, url, options = {}) {
      const page = await task.newPage();
      await page.goto(url, options);
      return page;
    },

    /** Page-world JS in the frame of `page` whose URL contains `urlPart`. */
    frameJs(page, urlPart, code) {
      return call("dev.evalChrome", {
        code: `
          const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");
          const { browsingContext } = ZeniusService.resolvePage(arg);
          const bc = browsingContext.getAllBrowsingContextsInSubtree().find(b => b !== browsingContext && b.currentURI?.spec.includes(arg.urlPart));
          if (!bc) return { missing: true };
          return { value: await ZeniusService.content(bc, "dev#evalContent", { code: arg.code, privileged: false }) };`,
        arg: { space: page.spaceId, page: page.label, urlPart, code },
      }).then(r => {
        if (r.missing) {
          throw new Error(`no frame with ${urlPart}`);
        }
        return r.value;
      });
    },

    assert(value, message) {
      assertions++;
      nodeAssert.ok(value, message);
    },
    assertEqual(actual, expected, message) {
      assertions++;
      nodeAssert.deepStrictEqual(actual, expected, message);
    },
    assertIncludes(haystack, needle, message) {
      assertions++;
      nodeAssert.ok(String(haystack).includes(needle), `${message}: expected ${JSON.stringify(String(haystack).slice(0, 400))} to include ${JSON.stringify(needle)}`);
    },
    async assertRejects(fn, expected, message) {
      assertions++;
      let error;
      try {
        await fn();
      } catch (e) {
        error = e;
      }
      nodeAssert.ok(error, `${message}: expected rejection`);
      nodeAssert.ok(String(error?.message).includes(expected), `${message}: ${JSON.stringify(error?.message)} should include ${JSON.stringify(expected)}`);
      return error;
    },
    async assertRejectsAny(fn, message) {
      assertions++;
      let rejected = false;
      try {
        await fn();
      } catch {
        rejected = true;
      }
      nodeAssert.ok(rejected, `${message}: expected rejection`);
    },
    get assertions() {
      return assertions;
    },

    /** Run one ported case; a Skip ends it early and is reported as a skip. */
    async run(t, fn) {
      try {
        await fn(h);
      } catch (e) {
        if (e instanceof Skip) {
          t.skip(e.message);
          return;
        }
        throw e;
      }
    },

    /** An absolute path to a new file with this content, removed by close(). */
    async tempFile(name, content = name) {
      const path = join(artifactDir, name);
      await writeFile(path, content);
      return path;
    },

    /**
     * Run a step that might write the system clipboard (a page's own copy,
     * say), and fail if it did. Copy and cut chords sent through Page get
     * this by themselves. See system-clipboard.mjs for what each platform
     * checks.
     */
    clipboardStep(label, fn) {
      return clipboard.step(label, fn);
    },
    /** {mode, checked, unchecked}: how the system clipboard was checked so far. */
    clipboardStats() {
      return { ...clipboard.stats };
    },
    /** Whether the system-clipboard check catches a write (null where no write is allowed). */
    clipboardSelfCheck() {
      return clipboard.selfCheck();
    },

    /**
     * Play the user: show `page` in the window (its Space, its tab).
     *
     * @returns {Promise<() => Promise<void>>} goes back to the user's Space
     */
    async watch(page) {
      const userWs = await call("dev.evalChrome", {
        arg: { space: page.spaceId, page: page.label },
        code: `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");
          const { landOn } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
          const { tab, space } = ZeniusService.resolvePage(arg);
          const userWs = win.gZenWorkspaces.activeWorkspace;
          // The switch lands on the page, as the user's from the tasks
          // panel does (zen-ux's openSpace), with no other tab shown first.
          landOn(tab);
          await win.gZenWorkspaces.changeWorkspaceWithID(space.uuid);
          if (win.gBrowser.selectedTab !== tab) win.gBrowser.selectedTab = tab;
          // Callers compare the view after an action with the view now, so
          // the tab switch must be over. On the first switch after Zen
          // starts, the window's focus keeps moving after the tab is
          // selected: a <browser> gets it, then loses it some 100 ms later.
          for (const end = Date.now() + 5000; win.gBrowser.selectedTab !== tab || win.gBrowser._switcher; ) {
            if (Date.now() > end) throw new Error(win.gBrowser.selectedTab !== tab ? "the agent's tab wasn't selected" : "the switch to the agent's tab didn't finish");
            await new Promise(r => win.setTimeout(r, 25));
          }
          await new Promise(r => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
          return userWs;`,
      });
      return () => call("dev.evalChrome", { arg: userWs, code: `if (win.gZenWorkspaces.activeWorkspace !== arg) await win.gZenWorkspaces.changeWorkspaceWithID(arg);` });
    },
    /**
     * Run fn(page, how) in a new page of `task` at `url`, hidden and then
     * watched by the user. Around each, the user's view must not change
     * (I1); while watched, the action must not change the watched view
     * either (focus moving into a panel, say).
     */
    async bothViews(task, url, fn) {
      for (const how of ["hidden", "watched"]) {
        const before = await call("dev.viewState");
        const page = await task.newPage();
        try {
          await page.goto(url);
          if (how === "hidden") {
            await fn(page, how);
          } else {
            const back = await this.watch(page);
            try {
              const shown = await call("dev.viewState");
              await fn(page, how);
              nodeAssert.deepEqual(await call("dev.viewState"), shown, `${how}: the action left the watched view as it was`);
            } finally {
              await back();
            }
          }
        } finally {
          await page.close().catch(() => {});
        }
        nodeAssert.deepEqual(await call("dev.viewState"), before, `${how}: the user's view is unchanged (I1)`);
      }
    },
    /** Panels and popups open in the window, by id (the agent's pickers would show here). */
    openPopups() {
      return call("dev.evalChrome", {
        code: `return [...win.document.querySelectorAll("panel, menupopup")].filter(p => p.state === "open" || p.state === "showing").map(p => p.id || p.localName);`,
      });
    },
    /**
     * Play the user: a click on `selector` in the shown page, entering
     * through the parent like OS input (zen-ux's takeover tests do the
     * same). The page must be the selected tab. With `frame`, `selector` is
     * in that same-origin iframe of the page. Headless Zen doesn't pass the
     * click on into an out-of-process iframe; it focuses the iframe only.
     */
    userClick(page, selector, { frame = null } = {}) {
      return call("dev.evalChrome", {
        arg: { space: page.spaceId, page: page.label, selector, frame },
        code: `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");
          const { browser } = ZeniusService.resolvePage(arg);
          const p = await ZeniusService.content(browser.browsingContext, "dev#evalContent", {
            code: "const f = " + JSON.stringify(arg.frame) + " && document.querySelector(" + JSON.stringify(arg.frame) + ");" +
              "const o = f ? f.getBoundingClientRect() : { x: 0, y: 0 };" +
              "const r = (f ? f.contentDocument : document).querySelector(" + JSON.stringify(arg.selector) + ").getBoundingClientRect();" +
              "return { x: o.x + (f ? f.clientLeft : 0) + r.x + r.width / 2, y: o.y + (f ? f.clientTop : 0) + r.y + r.height / 2 };",
            privileged: false,
          });
          const r = browser.getBoundingClientRect();
          const px = r.x + p.x;
          const py = r.y + p.y;
          if (win.document.elementFromPoint(px, py) !== browser) {
            // Say what's in the way: a popup left open, an overlay.
            const there = win.document.elementsFromPoint(px, py).slice(0, 3).map(e => e.localName + (e.id ? "#" + e.id : "")).join(" > ") || "nothing";
            const open = [...win.document.querySelectorAll("panel, menupopup")].filter(x => x.state === "open").map(x => x.id || x.localName);
            throw new Error("the page isn't under the click point: " + there + " is (open popups: " + (open.join(", ") || "none") +
              "; the page's pointer-events: " + win.getComputedStyle(browser).pointerEvents + ")");
          }
          for (const type of ["mousedown", "mouseup"]) {
            win.synthesizeMouseEvent(type, px, py, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
          }
          return true;`,
      });
    },

    /**
     * Play the user's keys in the shown page, entering through the parent
     * like OS input: key names ("ArrowDown", "Enter") or single characters.
     */
    userPress(page, ...keys) {
      return call("dev.evalChrome", {
        arg: { space: page.spaceId, page: page.label, keys },
        code: `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");
          const { browser } = ZeniusService.resolvePage(arg);
          if (win.gBrowser.selectedBrowser !== browser) throw new Error("the page isn't shown");
          browser.focus();
          const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
          if (!tip.beginInputTransactionForTests(win)) throw new Error("no input transaction");
          for (const key of arg.keys) {
            const ev = new win.KeyboardEvent("", { key });
            tip.keydown(ev);
            tip.keyup(ev);
          }
          return true;`,
      });
    },
    /** Page-world JS in `page`, run for the test as the user would see it: no gate, whoever holds the Space. */
    asUser(page, code) {
      return call("dev.evalChrome", {
        arg: { space: page.spaceId, page: page.label, code },
        code: `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");
          const { browser } = ZeniusService.resolvePage(arg);
          return ZeniusService.content(browser.browsingContext, "dev#evalContent", { code: arg.code, privileged: false });`,
      });
    },
    /** Poll `fn` until it returns something truthy, for at most `ms`. */
    async until(fn, what, ms = 10_000) {
      let last;
      for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
        last = await fn().catch(e => e);
        if (last && !(last instanceof Error)) {
          return last;
        }
      }
      throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
    },

    /** I1: nothing the agent did changed what the user sees (the OS moving focus to another app aside). */
    async assertUserViewUnchanged() {
      const after = await call("dev.viewState");
      const log = probeStopped ? null : await call("dev.evalChrome", { code: FOCUS_PROBE_STOP }).catch(() => null);
      probeStopped = true;
      await checkView(`zen-input ${suite}`, userView, after, { probe: focusProbe, steps, log });
    },
    /** zen-ux's takeover detector never saw agent input: every Space is still the agent's. */
    async assertAgentStillInControl() {
      const { taskSpaces } = await call("spaces.list");
      for (const id of spaces.values()) {
        const space = taskSpaces.find(s => s.id === id);
        if (space && "ownership" in space) {
          nodeAssert.equal(space.ownership, "agent", `space ${id} is still the agent's`);
        }
      }
    },
    /**
     * End of a test file: the I1 and control checks, then close() whatever
     * they find, so a failed check never leaves the run (and its window)
     * open.
     */
    async finish() {
      try {
        await this.assertUserViewUnchanged();
        await this.assertAgentStillInControl();
      } finally {
        await this.close();
      }
    },
    /**
     * Finish the Spaces this harness created (a kept profile keeps no test
     * Spaces), then close the client, the fixture server and the temp dir.
     * Each call is capped, so close() itself can't hang the run.
     */
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      clipboard.stop();
      if (!probeStopped) {
        probeStopped = true;
        await capped(call("dev.evalChrome", { code: FOCUS_PROBE_STOP }), 5000);
      }
      for (const id of spaces.values()) {
        await capped(call("spaces.finish", { space: id, keep: [] }), 10_000);
      }
      client.close();
      await capped(closeFixtureServer(fixture.server), 5000);
      await capped(rm(artifactDir, { recursive: true, force: true }), 5000);
      clearTimeout(watchdog);
    },
  };
  let closed = false;
  closeUp = () => h.close();
  return h;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Wait for `promise` (its failure ignored), but no longer than `ms`. */
function capped(promise, ms) {
  let timer;
  return Promise.race([Promise.resolve(promise).catch(() => {}), new Promise(resolve => (timer = setTimeout(resolve, ms)))]).finally(() =>
    clearTimeout(timer)
  );
}
