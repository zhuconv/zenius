// The post-install self-check's entry (zen-core; PROTOCOL.md, "Self-check"):
// its socket, a run's window, output and cleanup, and retention. The agent
// sidebar's scenarios are zen-sidebar's, with their own tests; here a run
// gets stand-ins for prepare, run and cleanup through SelfCheck.start's
// options, which only chrome JS can pass (dev.evalChrome, on dev Zens).
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup, sleep } from "./lib.mjs";

const MODULE = "chrome://userscripts/content/zenius/modules/selfcheck.sys.mjs";
const SIDEBAR = "chrome://userscripts/content/agent-sidebar/selfcheck.sys.mjs";
const HOME = process.env.ZENIUS_HOME || join(homedir(), ".zenius");

let h;
let socket;
const scratch = [];
before(async () => {
  h = await setup();
  socket = join(HOME, "selfcheck", `${h.instance}.sock`);
  // The service opens it at idle after the agents' socket. Until then, a
  // file a killed run left may stand there with nobody listening: wait for
  // a hello, not for the file.
  const end = Date.now() + 20000;
  for (;;) {
    try {
      const c = await rawConnect(socket);
      try {
        await c.next(f => f.event === "hello", 2000);
        break;
      } finally {
        c.close();
      }
    } catch (e) {
      if (Date.now() > end) {
        throw new Error(`the self-check socket never answered: ${e.message}`);
      }
      await sleep(100);
    }
  }
});
after(async () => {
  await h?.chrome(`
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    if (M.SelfCheck.__original) {
      M.SelfCheck.start = M.SelfCheck.__original;
      delete M.SelfCheck.__original;
    }
  `);
  h?.close();
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A scratch folder of the test's own, 0700. */
function scratchDir(prefix = "zenius-selfcheck-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A raw NDJSON connection: send frames, wait for the ones that match. */
function rawConnect(path) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(path);
    const frames = [];
    let waiters = [];
    let buffer = "";
    sock.setEncoding("utf8");
    sock.on("data", chunk => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) {
          frames.push(JSON.parse(line));
          for (const w of waiters) {
            w();
          }
        }
      }
    });
    sock.once("error", reject);
    sock.once("connect", () =>
      resolve({
        frames,
        send: frame => sock.write(JSON.stringify(frame) + "\n"),
        next(match, ms = 15000) {
          return new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error(`no matching frame within ${ms} ms; got ${JSON.stringify(frames)}`)), ms);
            const look = () => {
              const found = frames.find(match);
              if (found) {
                clearTimeout(timer);
                waiters = waiters.filter(w => w !== look);
                done(found);
              }
            };
            waiters.push(look);
            look();
          });
        },
        close: () => sock.destroy(),
      })
    );
  });
}

/** Replace SelfCheck.start, for the socket's runs, with one that gets these stand-ins. */
async function standIns(code) {
  await h.chrome(`
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    M.SelfCheck.__original ??= M.SelfCheck.start;
    const original = M.SelfCheck.__original;
    const extra = (() => { ${code} })();
    M.SelfCheck.start = function (options = {}) {
      return original.call(this, { ...extra, ...options });
    };
  `);
}

async function restoreStart() {
  await h.chrome(`
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    if (M.SelfCheck.__original) {
      M.SelfCheck.start = M.SelfCheck.__original;
      delete M.SelfCheck.__original;
    }
  `);
}

async function untilIdle(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await h.chrome(`return !!ChromeUtils.importESModule(${JSON.stringify(MODULE)}).SelfCheck.active;`))) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`a self-check run was still going after ${ms} ms`);
}

const mode = path => statSync(path).mode & 0o777;

function pngSize(path) {
  const d = readFileSync(path);
  assert.equal(d.subarray(0, 8).toString("binary"), "\x89PNG\r\n\x1a\n", `${path} is a PNG`);
  return { width: d.readUInt32BE(16), height: d.readUInt32BE(20) };
}

/** Every string in a value, so a test can say none holds a path. */
function strings(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

test("the self-check socket is its own: 0600 in a 0700 folder, and it serves selfcheck.run alone", async () => {
  assert.ok(existsSync(socket), `the service opens ${socket} at idle`);
  assert.equal(mode(socket), 0o600);
  assert.equal(mode(join(HOME, "selfcheck")), 0o700);
  const c = await rawConnect(socket);
  try {
    const hello = await c.next(f => f.event === "hello");
    assert.equal(hello.params.instance, h.instance);
    assert.equal(typeof hello.params.runtimeVersion, "string");
    // Nothing else, on a dev Zen too: not the agents' methods, not dev.*.
    c.send({ id: 1, method: "browser.methods", params: {} });
    c.send({ id: 2, method: "dev.evalChrome", params: { code: "return 1" } });
    c.send({ id: 3, method: "selfcheck.run", params: { scenario: "x" } });
    c.send({ id: 4, method: "selfcheck.run", params: [] });
    c.send({ id: 5 });
    assert.equal((await c.next(f => f.id === 1)).error.code, "ZEN_UNSUPPORTED");
    assert.equal((await c.next(f => f.id === 2)).error.code, "ZEN_UNSUPPORTED");
    assert.equal((await c.next(f => f.id === 3)).error.code, "ZEN_INVALID_ARGUMENT");
    assert.equal((await c.next(f => f.id === 4)).error.code, "ZEN_INVALID_ARGUMENT");
    assert.equal((await c.next(f => f.id === 5)).error.code, "ZEN_INVALID_ARGUMENT");
  } finally {
    c.close();
  }
});

test("the agents' socket has no selfcheck method", async () => {
  const registry = await h.call("dev.registry", {});
  assert.deepEqual(
    registry.filter(r => r.method.startsWith("selfcheck.")).map(r => r.method),
    []
  );
  await assert.rejects(h.call("selfcheck.run", {}), e => e.code === "ZEN_UNSUPPORTED");
});

test("without the agent sidebar's self-check, selfcheck.run says it's unavailable", async t => {
  if (await h.chrome(`try { ChromeUtils.importESModule(${JSON.stringify(SIDEBAR)}); return true; } catch { return false; }`)) {
    t.skip("this runtime has the agent sidebar's self-check");
    return;
  }
  const c = await rawConnect(socket);
  try {
    c.send({ id: 1, method: "selfcheck.run", params: {}, progress: true });
    assert.equal((await c.next(f => f.id === 1)).error.code, "ZEN_SELFCHECK_UNAVAILABLE");
  } finally {
    c.close();
  }
});

test("a run: its window isn't a browser window and is gone after done, and its folder holds the summary and a PNG per step", async () => {
  const dir = scratchDir();
  const { result, seen } = await h.chrome(
    `
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
    const seen = { cleanups: 0 };
    const focusBefore = Services.focus.activeWindow;
    const browserBefore = Services.wm.getMostRecentWindow("navigator:browser");
    seen.userActive = focusBefore === browserBefore;
    seen.zenInFront = M.zenInFront();
    seen.headless = Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo).isHeadless;
    // The default for each kind of Zen, and for this one.
    const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
    seen.defaults = {
      headless: M.defaultWindow(true, "linux"),
      macHeadless: M.defaultWindow(true, "macosx"),
      mac: M.defaultWindow(false, "macosx"),
      elsewhere: M.defaultWindow(false, "linux"),
      thisOne: M.defaultWindow(),
      onMac: AppConstants.platform === "macosx",
    };
    // A window that takes activation, even for a moment,
    // gives the user's window a deactivate and blurs.
    seen.events = { deactivate: 0, blur: 0 };
    const count = e => seen.events[e.type]++;
    browserBefore.addEventListener("deactivate", count, true);
    browserBefore.addEventListener("blur", count, true);
    const run = M.SelfCheck.start({
      outDir: arg.dir,
      timeoutMs: 30000,
      prepare: w => {
        seen.type = w.document.documentElement.getAttribute("windowtype");
        seen.size = [w.innerWidth, w.innerHeight];
        seen.alwaysOnTop = w.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIAppWindow).chromeFlags & Ci.nsIWebBrowserChrome.CHROME_ALWAYS_ON_TOP ? true : false;
        seen.inTracker = BrowserWindowTracker.orderedWindows.includes(w);
        seen.mostRecentBrowser = Services.wm.getMostRecentWindow("navigator:browser") === w;
        const box = w.document.getElementById("zenius-selfcheck-host");
        const div = w.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
        div.textContent = "synthetic";
        div.style.cssText = "width: 200px; height: 100px; background: rgb(200, 30, 30)";
        box.append(div);
        return { scope: "synthetic" };
      },
      run: async (w, ctx) => {
        seen.focusDuring = Services.focus.activeWindow === focusBefore;
        await ctx.shot("menu/open", null);
        await ctx.shot("menu/tooltip", { x: 0, y: 0, width: 100, height: 50 });
        ctx.checked({ id: "menu", title: "The menu", ok: true });
        return { checks: [{ id: "menu", title: "The menu", ok: true }] };
      },
      cleanup: () => {
        seen.cleanups++;
      },
    });
    seen.windowAtStart = run.window;
    seen.donePromise = typeof run.done?.then === "function";
    let result;
    try {
      result = await run.done;
    } finally {
      browserBefore.removeEventListener("deactivate", count, true);
      browserBefore.removeEventListener("blur", count, true);
    }
    seen.scope = run.scope;
    seen.windowClosed = run.window.closed;
    seen.left = [...Services.wm.getEnumerator(M.WINDOW_TYPE)].length;
    seen.focusAfter = Services.focus.activeWindow === focusBefore;
    seen.browserAfter = Services.wm.getMostRecentWindow("navigator:browser") === browserBefore;
    return { result, seen };
    `,
    { dir }
  );
  assert.equal(seen.windowAtStart, null, "start() returns before the window opens");
  assert.ok(seen.donePromise);
  assert.equal(seen.type, "zenius:selfcheck");
  assert.deepEqual(seen.size, [720, 760], "room for the panel (420) and All tasks' drawer (264) beside it");
  assert.equal(seen.inTracker, false, "never in BrowserWindowTracker");
  assert.equal(seen.mostRecentBrowser, false, "never the most recent browser window");
  assert.ok(seen.userActive, "the user's window is the active one before the run");
  assert.ok(seen.focusDuring, "the window doesn't keep the focus");
  assert.ok(seen.focusAfter);
  assert.ok(seen.browserAfter);
  // On a display, a run waits while Zen is in front, then opens offscreen
  // (the next tests); a headless Zen has no front app, and its window floats.
  assert.equal(seen.headless, true);
  assert.equal(seen.zenInFront, false, "a headless Zen has no front app to wait for");
  // A headed Mac opens it invisible;
  // another display, offscreen; a headless Zen, floating.
  const { thisOne, onMac, ...byKind } = seen.defaults;
  assert.deepEqual(byKind, { headless: "floating", macHeadless: "floating", mac: "invisible", elsewhere: "offscreen" });
  assert.equal(thisOne, seen.headless ? "floating" : onMac ? "invisible" : "offscreen");
  assert.equal(seen.alwaysOnTop, true, "here the default window floats");
  assert.deepEqual(seen.events, { deactivate: 0, blur: 0 }, "the user's window never loses activation, even for a moment");
  assert.deepEqual(seen.scope, { scope: "synthetic" });
  assert.equal(seen.cleanups, 1);
  assert.equal(seen.windowClosed, true);
  assert.equal(seen.left, 0, "no self-check window is left");

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.timedOut, false);
  assert.equal(result.callerLeft, false);
  assert.equal(result.window, "floating");
  assert.equal(result.waitedMs, 0);
  assert.equal(result.dir, dir);
  assert.deepEqual(result.checks, [
    { id: "menu", title: "The menu", ok: true, failedStep: null, error: null, shots: ["01-menu-open.png", "02-menu-tooltip.png"] },
  ]);
  for (const key of ["runtimeVersion", "commit", "zenVersion"]) {
    assert.equal(typeof result[key], "string", key);
  }

  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  assert.equal(mode(join(dir, "summary.json")), 0o600);
  assert.equal("dir" in summary, false, "the summary names files, never paths");
  const { dir: _, ...rest } = result;
  assert.deepEqual(summary, { ...rest, ms: summary.ms });
  for (const s of strings(summary)) {
    assert.ok(!s.startsWith("/") && !s.includes(homedir()), `no path in the summary: ${s}`);
  }
  assert.deepEqual(readdirSync(dir).sort(), ["01-menu-open.png", "02-menu-tooltip.png", "summary.json"]);
  for (const file of ["01-menu-open.png", "02-menu-tooltip.png"]) {
    assert.equal(mode(join(dir, file)), 0o600);
  }
  const whole = pngSize(join(dir, "01-menu-open.png"));
  assert.ok(whole.width >= 200 && whole.height >= 100, `the window's own document: ${JSON.stringify(whole)}`);
  const cropped = pngSize(join(dir, "02-menu-tooltip.png"));
  const ratio = cropped.width / 100;
  assert.ok(ratio >= 1, `cropped to its rect: ${JSON.stringify(cropped)}`);
  assert.equal(cropped.height, Math.round(50 * ratio));
});

test("a failing check, an error in prepare and a hang past the limit: cleanup runs once, the window goes, and the summary says why", async () => {
  const dirs = { fail: scratchDir(), prepare: scratchDir(), hang: scratchDir() };
  const out = await h.chrome(
    `
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const go = async (dir, steps, timeoutMs = 30000) => {
      const counts = { cleanups: 0 };
      const t0 = Date.now();
      const run = M.SelfCheck.start({ outDir: dir, timeoutMs, cleanup: () => counts.cleanups++, ...steps });
      const result = await run.done;
      return { result, counts, ms: Date.now() - t0, left: [...Services.wm.getEnumerator(M.WINDOW_TYPE)].length };
    };
    return {
      fail: await go(arg.fail, {
        prepare: () => null,
        run: async (w, ctx) => {
          await ctx.shot("archive/open-menu", null);
          return { checks: [{ id: "archive", title: "Archive", ok: false, failedStep: "open-menu", error: new Error("no Archive item under " + home + "/x") }] };
        },
      }),
      prepare: await go(arg.prepare, {
        prepare: () => {
          throw new Error("prepare failed at " + home);
        },
        run: async () => ({ checks: [] }),
      }),
      hang: await go(
        arg.hang,
        {
          prepare: () => null,
          run: async (w, ctx) => {
            ctx.checked({ id: "menu", title: "The menu", ok: true });
            await ctx.shot("archive/step-1", null);
            return new Promise(() => {});
          },
        },
        1500
      ),
    };
    `,
    dirs
  );

  const fail = out.fail;
  assert.equal(fail.result.ok, false);
  assert.equal(fail.result.timedOut, false);
  assert.deepEqual(fail.result.checks[0].shots, ["01-archive-open-menu.png"]);
  assert.equal(fail.result.checks[0].failedStep, "open-menu");
  assert.match(fail.result.checks[0].error, /^Error: no Archive item under ~\/x$/);
  assert.equal(fail.counts.cleanups, 1);
  assert.equal(fail.left, 0);

  const prepare = out.prepare;
  assert.equal(prepare.result.ok, false);
  assert.match(prepare.result.error, /^Error: prepare failed at ~$/);
  assert.deepEqual(prepare.result.checks, []);
  assert.equal(prepare.counts.cleanups, 1);
  assert.equal(prepare.left, 0);

  const hang = out.hang;
  assert.equal(hang.result.ok, false);
  assert.equal(hang.result.timedOut, true);
  assert.equal(hang.result.callerLeft, false);
  assert.ok(hang.ms < 1500 + 10000, `done settled ${hang.ms} ms after the start`);
  assert.deepEqual(hang.result.checks, [
    { id: "menu", title: "The menu", ok: true, failedStep: null, error: null, shots: [] },
    { id: "archive", title: "archive", ok: false, failedStep: "step-1", error: "timed out", shots: ["01-archive-step-1.png"] },
  ]);
  assert.equal(hang.counts.cleanups, 1);
  assert.equal(hang.left, 0);
  for (const [name, dir] of Object.entries(dirs)) {
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    for (const s of strings(summary)) {
      assert.ok(!s.startsWith("/") && !s.includes(homedir()), `${name}: no path in the summary: ${s}`);
    }
  }
});

test("each window mode opens the window, hands the focus back before prepare, takes its shots and closes it; an unknown one is refused", async () => {
  // In the spike's order: the unseen ones first. Then invisible, the
  // follow-up's candidate.
  const expected = ["minimized", "minimized-active", "offscreen", "offscreen-floating", "offscreen-floating-active", "floating", "popup", "corner", "invisible"];
  const dirs = Object.fromEntries(expected.map(mode => [mode, scratchDir()]));
  const { modes, runs, refused, activeAfter } = await h.chrome(
    `
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    let refused = null;
    try {
      M.SelfCheck.start({ window: "fullscreen", prepare: () => null, run: async () => ({ checks: [] }), cleanup: () => {} });
    } catch (e) {
      refused = { code: e.code, message: e.message };
    }
    const activeAfter = M.SelfCheck.active;
    const user = Services.wm.getMostRecentWindow("navigator:browser");
    const runs = {};
    for (const mode of M.WINDOW_MODES) {
      if (!arg.dirs[mode]) {
        throw new Error("no folder for the mode " + mode);
      }
      const seen = { cleanups: 0, userActiveBefore: Services.focus.activeWindow === user };
      const run = M.SelfCheck.start({
        window: mode,
        outDir: arg.dirs[mode],
        timeoutMs: 30000,
        prepare: w => {
          // Whichever mode the spike picks, the user's window has the focus
          // back by now, if the self-check's window took it.
          seen.userActiveAtPrepare = Services.focus.activeWindow === user;
          const flags = w.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIAppWindow).chromeFlags;
          seen.alwaysOnTop = Boolean(flags & Ci.nsIWebBrowserChrome.CHROME_ALWAYS_ON_TOP);
          const box = w.document.getElementById("zenius-selfcheck-host");
          const div = w.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
          div.style.cssText = "width: 200px; height: 100px; background: rgb(30, 30, 200)";
          box.append(div);
          return null;
        },
        run: async (w, ctx) => {
          seen.minimized = w.windowState === w.STATE_MINIMIZED;
          seen.active = w.browsingContext.isActive;
          await ctx.shot("mode/window", null);
          return { checks: [{ id: "mode", title: mode, ok: true }] };
        },
        cleanup: () => {
          seen.cleanups++;
        },
      });
      const result = await run.done;
      runs[mode] = { ...seen, ok: result.ok, window: result.window, error: result.error, closed: run.window?.closed ?? null };
    }
    return { modes: [...M.WINDOW_MODES], runs, refused, activeAfter };
    `,
    { dirs }
  );
  assert.equal(refused?.code, "ZEN_INVALID_ARGUMENT", JSON.stringify(refused));
  assert.match(refused.message, /floating/);
  assert.equal(activeAfter, null, "a refused start leaves no run behind");
  assert.deepEqual(modes, expected);
  for (const mode of modes) {
    const run = runs[mode];
    assert.equal(run.ok, true, `${mode}: ${JSON.stringify(run)}`);
    // invisible can't be see-through here (off the Mac, or headless), so it
    // opened as a corner window, and the summary says so.
    assert.equal(run.window, mode === "invisible" ? "corner" : mode);
    assert.equal(run.closed, true, `${mode}: its window closed`);
    assert.equal(run.cleanups, 1, mode);
    assert.equal(run.minimized, mode.startsWith("minimized"), `${mode}: minimized only when asked`);
    assert.ok(run.userActiveBefore, `${mode}: the user's window is active before the run`);
    assert.ok(run.userActiveAtPrepare, `${mode}: the user's window is active again when prepare runs`);
    assert.equal(run.alwaysOnTop, mode.includes("floating"), `${mode}: kept above others only when floating`);
    if (mode.endsWith("-active")) {
      assert.equal(run.active, true, `${mode}: its browsing context is kept active`);
    }
  }
  // The invisible mode leaves the window as a corner one here, and its one
  // line says why: off the Mac there's no AppKit, and a headless Zen on the
  // Mac (the test's) has no native window.
  const why = process.platform === "darwin" ? "no native window (0x0)" : "not the Mac";
  assert.deepEqual(h.instanceLog(/self-check: the invisible window/), [
    `[zenius] self-check: the invisible window: ${why}, so it shows as a corner window`,
  ]);
});

test("the invisible mode's see-through step: on the Mac, AppKit on the window's own NSWindow; with no native window, or off the Mac, it says so and changes nothing", async () => {
  // A throwaway window, so a headed Mac run of this test makes only it
  // see-through. On a headless Zen its native handle is 0x0 on any platform,
  // which reaches the step's handle check without AppKit.
  const r = await h.chrome(
    `
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
    const user = Services.wm.getMostRecentWindow("navigator:browser");
    const w = Services.ww.openWindow(null, M.WINDOW_URL, "_blank", "chrome,dialog=no,width=200,height=200", null);
    try {
      const handle = w.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle;
      const onMac = AppConstants.platform === "macosx";
      return {
        handle,
        onMac,
        elsewhere: M.seeThrough(w, "linux"),
        mac: handle === "0x0" || onMac ? M.seeThrough(w, "macosx") : null,
      };
    } finally {
      w.close();
      user.focus();
    }
    `
  );
  assert.deepEqual(r.elsewhere, { ok: false, text: "not the Mac, so it shows as a corner window" });
  if (r.handle === "0x0") {
    assert.deepEqual(r.mac, { ok: false, text: "no native window (0x0), so it shows as a corner window" });
  } else if (r.onMac) {
    assert.deepEqual(r.mac, { ok: true, text: "see-through (alpha 0), and clicks pass through it (ignoresMouseEvents)" });
  }
});

test("while Zen is in front, a run waits with its window unopened and its call held, and runs once Zen is in the background", async () => {
  const dir = scratchDir();
  const { result, seen } = await h.chrome(
    `
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    const user = Services.wm.getMostRecentWindow("navigator:browser");
    const seen = { held: [], answers: [], events: { deactivate: 0, blur: 0 } };
    const count = e => seen.events[e.type]++;
    user.addEventListener("deactivate", count, true);
    user.addEventListener("blur", count, true);
    let t0 = 0;
    const run = M.SelfCheck.start({
      outDir: arg.dir,
      timeoutMs: 30000,
      // In front for the first 1.2 s of the run's checks.
      zenInFront: () => {
        t0 ||= Date.now();
        const front = Date.now() - t0 < 1200;
        const open = [...Services.wm.getEnumerator(M.WINDOW_TYPE)].length;
        seen.answers.push({ front, open, held: seen.held.length });
        if (!front) {
          // The last moment before the window opens.
          seen.eventsAtOpen = { ...seen.events };
          seen.windowAtOpen = run.window;
        }
        return front;
      },
      onHeld: (held, reason) => seen.held.push([held, reason ?? null]),
      prepare: w => {
        seen.windowAtPrepare = w === run.window;
        return null;
      },
      run: async (w, ctx) => {
        await ctx.shot("menu/open", null);
        return { checks: [{ id: "menu", title: "The menu", ok: true }] };
      },
      cleanup: () => {},
    });
    let result;
    try {
      result = await run.done;
    } finally {
      user.removeEventListener("deactivate", count, true);
      user.removeEventListener("blur", count, true);
    }
    return { result, seen };
    `,
    { dir }
  );
  const waiting = seen.answers.filter(a => a.front);
  assert.ok(waiting.length >= 3, `it checked again while it waited: ${JSON.stringify(seen.answers)}`);
  assert.ok(waiting.every(a => a.open === 0), "no self-check window while Zen is in front");
  assert.deepEqual(seen.answers.at(-1), { front: false, open: 0, held: 1 }, "the window opens right after a check that Zen is in the background");
  assert.equal(seen.answers.filter(a => !a.front).length, 1, "nothing asked again between that check and the window");
  assert.equal(seen.windowAtOpen, null);
  assert.deepEqual(seen.eventsAtOpen, { deactivate: 0, blur: 0 }, "the user's window kept the focus throughout the wait");
  assert.deepEqual(seen.events, { deactivate: 0, blur: 0 }, "and through the run, its window floating here");
  assert.deepEqual(seen.held, [[true, "zen-in-front"], [false, null]], "held once, released once");
  assert.equal(seen.windowAtPrepare, true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.waitedMs >= 1000 && result.waitedMs < 10000, `waitedMs ${result.waitedMs}`);
  assert.ok(result.ms >= result.waitedMs);
  assert.equal(result.window, "floating");
  assert.equal(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")).waitedMs, result.waitedMs);
});

test("a run whose wait runs out opens nothing and prepares nothing, and its summary says Zen stayed in front", async () => {
  const dir = scratchDir();
  const { result, seen } = await h.chrome(
    `
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    const seen = { held: [], prepared: 0, ran: 0, cleanups: 0 };
    const run = M.SelfCheck.start({
      outDir: arg.dir,
      waitMs: 1000,
      zenInFront: () => true,
      onHeld: (held, reason) => seen.held.push([held, reason ?? null]),
      prepare: () => {
        seen.prepared++;
      },
      run: async () => {
        seen.ran++;
        return { checks: [] };
      },
      cleanup: () => {
        seen.cleanups++;
      },
    });
    const result = await run.done;
    seen.window = run.window;
    seen.windows = [...Services.wm.getEnumerator(M.WINDOW_TYPE)].length;
    seen.active = M.SelfCheck.active;
    return { result, seen };
    `,
    { dir }
  );
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false, "the wait's end isn't the run's limit");
  assert.equal(result.callerLeft, false);
  assert.equal(result.error, "Zen stayed in front for 1 s, and the self-check opens its window only while Zen is in the background");
  assert.deepEqual(result.checks, []);
  assert.ok(result.waitedMs >= 1000, `waitedMs ${result.waitedMs}`);
  assert.equal(seen.window, null, "no window was asked for");
  assert.equal(seen.windows, 0);
  assert.equal(seen.prepared, 0);
  assert.equal(seen.ran, 0);
  assert.equal(seen.cleanups, 1, "cleanup still runs, as it's safe to call with nothing prepared");
  assert.deepEqual(seen.held, [[true, "zen-in-front"], [false, null]]);
  assert.equal(seen.active, null);
  assert.deepEqual(readdirSync(dir), ["summary.json"]);
  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  assert.equal(summary.error, result.error);
  assert.equal(summary.ok, false);
});

test("through the socket, a caller that asked for progress hears its call held while Zen is in front, and one that leaves during the wait stops the run", async () => {
  const heldDir = scratchDir();
  const quietDir = scratchDir();
  const leftDir = scratchDir();
  // In front for the first 800 ms of a run's checks.
  const inFrontFor = ms => `zenInFront: (() => { let t0 = 0; return () => { t0 ||= Date.now(); return Date.now() - t0 < ${ms}; }; })(),`;
  const passes = `prepare: () => null, run: async () => ({ checks: [{ id: "menu", title: "The menu", ok: true }] }), cleanup: () => {},`;
  try {
    await standIns(`return { outDir: ${JSON.stringify(heldDir)}, ${inFrontFor(800)} ${passes} };`);
    const a = await rawConnect(socket);
    try {
      a.send({ id: 1, method: "selfcheck.run", params: {}, progress: true });
      const answer = await a.next(f => f.id === 1 && ("result" in f || "error" in f), 30000);
      assert.equal(answer.error, undefined, JSON.stringify(answer.error));
      assert.equal(answer.result.ok, true);
      assert.ok(answer.result.waitedMs >= 700, `waitedMs ${answer.result.waitedMs}`);
      assert.deepEqual(
        a.frames.filter(f => f.id === 1).map(f => ("result" in f ? "result" : f)),
        [{ id: 1, held: true, reason: "zen-in-front" }, { id: 1, held: false }, "result"]
      );
    } finally {
      a.close();
    }

    // Without progress: the same wait, and only the answer.
    await standIns(`return { outDir: ${JSON.stringify(quietDir)}, ${inFrontFor(800)} ${passes} };`);
    const b = await rawConnect(socket);
    try {
      b.send({ id: 2, method: "selfcheck.run", params: {} });
      const answer = await b.next(f => f.id === 2, 30000);
      assert.equal(answer.result?.ok, true, JSON.stringify(answer));
      assert.ok(answer.result.waitedMs >= 700);
      assert.deepEqual(b.frames, [b.frames[0], answer].filter(f => f.event === "hello" || f === answer));
      assert.equal(b.frames.filter(f => "held" in f).length, 0);
    } finally {
      b.close();
    }

    // The caller leaves while the run waits: no window, and the summary says so.
    await standIns(`return { outDir: ${JSON.stringify(leftDir)}, zenInFront: () => true, ${passes} };`);
    const c = await rawConnect(socket);
    c.send({ id: 3, method: "selfcheck.run", params: {}, progress: true });
    await c.next(f => f.id === 3 && f.held === true);
    c.close();
    await untilIdle();
    assert.equal(await h.chrome(`return [...Services.wm.getEnumerator(${JSON.stringify("zenius:selfcheck")})].length;`), 0);
    assert.deepEqual(readdirSync(leftDir), ["summary.json"]);
    const summary = JSON.parse(readFileSync(join(leftDir, "summary.json"), "utf8"));
    assert.equal(summary.callerLeft, true);
    assert.equal(summary.ok, false);
    assert.equal(summary.error, null);
    assert.deepEqual(summary.checks, []);
    // A caller can leave within the millisecond its call was held.
    assert.equal(typeof summary.waitedMs, "number");
  } finally {
    await restoreStart();
    await untilIdle();
  }
});

test("a self-check window that gets the focus mid-run, as Cmd-Tab or the Dock can give it, hands it straight back to the user's window", async () => {
  const dir = scratchDir();
  const { result, seen } = await h.chrome(
    `
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    const user = Services.wm.getMostRecentWindow("navigator:browser");
    const seen = { activations: 0 };
    const run = M.SelfCheck.start({
      outDir: arg.dir,
      timeoutMs: 30000,
      prepare: () => null,
      run: async w => {
        seen.userActiveBefore = Services.focus.activeWindow === user;
        w.addEventListener("activate", () => seen.activations++, true);
        w.focus();
        const end = Date.now() + 5000;
        while (Date.now() < end && !(seen.activations > 0 && Services.focus.activeWindow === user)) {
          await new Promise(r => setTimeout(r, 20));
        }
        seen.userActiveAfter = Services.focus.activeWindow === user;
        seen.selfActiveAfter = Services.focus.activeWindow === w;
        return { checks: [{ id: "focus", title: "Focus", ok: true }] };
      },
      cleanup: () => {},
    });
    const result = await run.done;
    return { result, seen };
    `,
    { dir }
  );
  assert.equal(seen.userActiveBefore, true);
  assert.ok(seen.activations >= 1, "the self-check window did get the focus");
  assert.equal(seen.selfActiveAfter, false);
  assert.equal(seen.userActiveAfter, true, "the user's window has it back");
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("one run at a time: a second start is busy until the first ends", async () => {
  const dir = scratchDir();
  const second = await h.chrome(
    `
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    const first = M.SelfCheck.start({
      outDir: arg.dir,
      timeoutMs: 1000,
      prepare: () => null,
      run: () => new Promise(() => {}),
      cleanup: () => {},
    });
    let code = null;
    try {
      M.SelfCheck.start({ prepare: () => null, run: async () => ({ checks: [] }), cleanup: () => {} });
    } catch (e) {
      code = e.code;
    }
    await first.done;
    return { code, after: M.SelfCheck.active };
    `,
    { dir }
  );
  assert.equal(second.code, "ZEN_SELFCHECK_BUSY");
  assert.equal(second.after, null);
});

test("the front's own frame starts a run; only the connection that started it stops it, and the summary says the caller left", async () => {
  const passDir = scratchDir();
  const leftDir = scratchDir();
  try {
    // A run that passes, through the socket, with the SDK's frame as the
    // front sends it: params {}, progress and pageBudget.
    await standIns(`return {
      outDir: ${JSON.stringify(passDir)},
      prepare: () => null,
      run: async (w, ctx) => { await ctx.shot("menu/open", null); return { checks: [{ id: "menu", title: "The menu", ok: true }] }; },
      cleanup: () => {},
    };`);
    const a = await rawConnect(socket);
    try {
      a.send({ id: 1, method: "selfcheck.run", params: {}, progress: true, pageBudget: 7 });
      const answer = await a.next(f => f.id === 1, 30000);
      assert.equal(answer.error, undefined, JSON.stringify(answer.error));
      assert.equal(answer.result.ok, true);
      assert.equal(answer.result.dir, passDir);
    } finally {
      a.close();
    }

    // A run that waits for its signal: a second connection is refused and
    // its close changes nothing; the first one's close stops the run.
    await standIns(`return {
      outDir: ${JSON.stringify(leftDir)},
      prepare: () => null,
      run: (w, ctx) => new Promise(() => { ctx.shot("follow/scrolled-up", null); }),
      cleanup: () => {},
    };`);
    const owner = await rawConnect(socket);
    const other = await rawConnect(socket);
    owner.send({ id: 1, method: "selfcheck.run", params: {} });
    const end = Date.now() + 15000;
    while (!(await h.chrome(`return !!ChromeUtils.importESModule(${JSON.stringify(MODULE)}).SelfCheck.active;`)) && Date.now() < end) {
      await sleep(50);
    }
    other.send({ id: 1, method: "selfcheck.run", params: {} });
    assert.equal((await other.next(f => f.id === 1)).error.code, "ZEN_SELFCHECK_BUSY");
    other.close();
    await sleep(500);
    assert.ok(
      await h.chrome(`return !!ChromeUtils.importESModule(${JSON.stringify(MODULE)}).SelfCheck.active;`),
      "another connection's close changes nothing"
    );
    owner.close();
    await untilIdle();
    const summary = JSON.parse(readFileSync(join(leftDir, "summary.json"), "utf8"));
    assert.equal(summary.ok, false);
    assert.equal(summary.callerLeft, true);
    assert.equal(summary.timedOut, false);
  } finally {
    await restoreStart();
    await untilIdle();
  }
});

test("a run's folder: made exclusively, mode 0700, under the instance's own folder", async () => {
  const { first, second } = await h.chrome(
    `
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    const at = new Date(Date.UTC(2026, 10, 22, 23, 15, 0));
    const first = await M.newRunFolder(arg.instance, at);
    const second = await M.newRunFolder(arg.instance, at);
    return { first, second };
    `,
    { instance: h.instance }
  );
  try {
    const runs = join(HOME, "selfcheck", h.instance);
    assert.equal(first, join(runs, "20261122T231500Z"));
    assert.equal(second, join(runs, "20261122T231500Z-1"));
    assert.equal(mode(runs), 0o700);
    assert.equal(mode(first), 0o700);
    assert.equal(mode(second), 0o700);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
  assert.deepEqual(
    await h.chrome(
      `const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
       return ["default", "zen-core.2", "..", ".hidden", "a/b", "x".repeat(65), ""].map(n => M.plainInstance(n));`
    ),
    [true, true, false, false, false, false, false]
  );
});

test("retention removes only a run's own files, by name, then the empty folder; it keeps anything else, follows no link, and takes age from the name", async () => {
  const runs = scratchDir();
  const target = scratchDir();
  writeFileSync(join(target, "summary.json"), "{}");
  const run = (name, files) => {
    mkdirSync(join(runs, name));
    for (const file of files) {
      writeFileSync(join(runs, name, file), "x");
    }
  };
  // Now is 2026-11-22 12:00 UTC: anything named before 11-15 12:00 is over 7 days old.
  run("20261101T000000Z", ["summary.json", "01-menu-open.png"]);
  run("20261102T000000Z", ["summary.json", "notes.txt"]);
  symlinkSync(target, join(runs, "20261103T000000Z"));
  writeFileSync(join(runs, "20261104T000000Z"), "a file, not a run");
  run("not-a-run", ["summary.json"]);
  // Named a day ago, with an old mtime: its name decides.
  run("20261121T000000Z", ["summary.json"]);
  utimesSync(join(runs, "20261121T000000Z"), new Date("2020-01-01"), new Date("2020-01-01"));
  // Eleven more recent runs: with the one above, the two oldest of those twelve go.
  for (let i = 0; i <= 10; i++) {
    run(`20261122T0000${String(i).padStart(2, "0")}Z`, ["summary.json", "01-menu-open.png"]);
  }
  const removed = await h.chrome(
    `const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
     return M.retain(arg.runs, Date.UTC(2026, 10, 22, 12, 0, 0));`,
    { runs }
  );
  const left = readdirSync(runs).sort();
  assert.ok(!left.includes("20261101T000000Z"), "an old run goes");
  assert.deepEqual(readdirSync(join(runs, "20261102T000000Z")), ["notes.txt"], "a folder holding anything else stays, without the run's files");
  assert.ok(lstatSync(join(runs, "20261103T000000Z")).isSymbolicLink(), "a link stays");
  assert.ok(existsSync(join(target, "summary.json")), "and its target keeps its files");
  assert.ok(left.includes("20261104T000000Z") && left.includes("not-a-run"));
  assert.deepEqual(readdirSync(join(runs, "not-a-run")), ["summary.json"]);
  // Twelve within 7 days: the ten newest stay, the two oldest go.
  assert.ok(!left.includes("20261121T000000Z"));
  assert.ok(!left.includes("20261122T000000Z"));
  for (let i = 1; i <= 10; i++) {
    assert.ok(left.includes(`20261122T0000${String(i).padStart(2, "0")}Z`), `run ${i} stays`);
  }
  assert.equal(removed, 4);

  // Age by name alone: named 8 days ago with a fresh mtime goes; named a day
  // ago with an old mtime stays.
  const byName = scratchDir();
  mkdirSync(join(byName, "20261114T000000Z"));
  mkdirSync(join(byName, "20261121T120000Z"));
  utimesSync(join(byName, "20261121T120000Z"), new Date("2020-01-01"), new Date("2020-01-01"));
  await h.chrome(
    `const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
     return M.retain(arg.runs, Date.UTC(2026, 10, 22, 12, 0, 0));`,
    { runs: byName }
  );
  assert.deepEqual(readdirSync(byName), ["20261121T120000Z"]);
});

test("a run changes none of the user's prefs, keeps nothing in xulstore and leaves no closed window behind", async () => {
  const dir = scratchDir();
  const out = await h.chrome(
    `
    const M = ChromeUtils.importESModule(${JSON.stringify(MODULE)});
    const { SessionStore } = win;
    const prefs = () => {
      const out = {};
      for (const name of Services.prefs.getChildList("")) {
        if (!Services.prefs.prefHasUserValue(name)) continue;
        const type = Services.prefs.getPrefType(name);
        out[name] = type === Services.prefs.PREF_BOOL ? Services.prefs.getBoolPref(name)
          : type === Services.prefs.PREF_INT ? Services.prefs.getIntPref(name)
          : Services.prefs.getStringPref(name);
      }
      return out;
    };
    const before = prefs();
    const closedBefore = SessionStore.getClosedWindowCount();
    const run = M.SelfCheck.start({
      outDir: arg.dir,
      timeoutMs: 30000,
      prepare: () => null,
      run: async (w, ctx) => { await ctx.shot("menu/open", null); return { checks: [{ id: "menu", ok: true }] }; },
      cleanup: () => {},
    });
    const result = await run.done;
    const after = prefs();
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]);
    return {
      ok: result.ok,
      changed,
      closedBefore,
      closedAfter: SessionStore.getClosedWindowCount(),
      xul: [...Services.xulStore.getIDsEnumerator(M.WINDOW_URL)],
    };
    `,
    { dir }
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.changed, [], "no pref changed");
  assert.equal(out.closedAfter, out.closedBefore, "SessionStore keeps no closed window of it");
  assert.deepEqual(out.xul, [], "xulstore keeps nothing of it");
});
