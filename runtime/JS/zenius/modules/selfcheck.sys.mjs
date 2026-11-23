// The post-install self-check's runs (zen-core; PROTOCOL.md, "Self-check").
//
// After an install, the relay or the user's own shell runs `zenius
// selfcheck` outside zenius's sandbox. That front connects to a socket of the
// self-check's own, ~/.zenius/selfcheck/<instance>.sock, which the service
// serves (modules/service.sys.mjs) with selfcheck.run and nothing else. The
// agents' socket doesn't have the method, and the sandbox can't reach this
// one: the launcher allows only run/<instance>.sock. This module loads at
// the socket's first call, so it holds nothing at startup.
//
// A run opens a window that isn't a browser window and hands it to the agent
// sidebar's scenarios (agent-sidebar/selfcheck.sys.mjs: prepare, run,
// cleanup). At each step it paints that window's own document into a PNG,
// and at the end it writes summary.json, both in
// ~/.zenius/selfcheck/<instance>/<time>/. A hard limit bounds the run, and a
// finally always cleans up, closes the window and writes the summary.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import {
  RUNTIME_VERSION,
  clearTimeout,
  ensurePrivateDir,
  log,
  plainInstance,
  readSettings,
  selfCheckDir,
  setTimeout,
  zenVersion,
  zeniusHome,
} from "chrome://userscripts/content/zenius/modules/util.sys.mjs";

export { plainInstance };

const SIDEBAR = "chrome://userscripts/content/agent-sidebar/selfcheck.sys.mjs";
export const WINDOW_URL = "chrome://userscripts/content/zenius/selfcheck/window.xhtml";
export const WINDOW_TYPE = "zenius:selfcheck";
const HTML_NS = "http://www.w3.org/1999/xhtml";

// The hard limit covers the window's opening, prepare and run. A test may
// lower it, never raise it.
export const LIMIT_MS = 120000;
// While Zen is the app in front, a run waits before its window opens, at
// most this long. A window opened then would take Zen's focus from the
// user's window for a moment (on the Mac: 1 deactivate and 3 blurs, under
// 20 ms): enough to close a dropdown, fire a form's onblur,
// or catch keys meant for the page. Step 6 starts the run from a terminal,
// so it rarely waits. The wait holds the call (PROTOCOL "Held calls"): the
// run's limit starts when it ends. A test may shorten it, never lengthen it.
export const WAIT_MS = 60000;
const WAIT_POLL_MS = 200;
// The finally's own bounds, so a run's done settles within its limit plus
// 10 s.
const CLEANUP_MS = 3000;
const CLOSE_MS = 5000;
// The window holds the panel (420 CSS px) and All tasks' drawer (264) beside
// it, as zen-sidebar measured them.
const WIDTH = 720;
const HEIGHT = 760;
const MARGIN = 16;
// How the window shows, in the order a spike on the Mac tried them: the
// unseen ones first. Each
// mode says where the window opens (a corner of the screen the user's
// window is on, or beyond the screens), and whether it:
//   float     is kept above others (alwaysontop, as Picture-in-Picture
//             opens), which Gecko shows without focusing it
//   popup     is a popup-type window, as Firefox opens its non-native alerts
//             (alert.xhtml)
//   minimize  is minimized once it has loaded
//   active    keeps its browsing context active, so requestAnimationFrame
//             runs where the window can't be seen
//   invisible is see-through and lets clicks pass through it, wherever it
//             is (seeThrough): on a second display it shows nothing. The
//             default on a headed Mac, since a check there
const MODES = {
  minimized: { place: "corner", minimize: true },
  "minimized-active": { place: "corner", minimize: true, active: true },
  offscreen: { place: "offscreen" },
  "offscreen-floating": { place: "offscreen", float: true },
  "offscreen-floating-active": { place: "offscreen", float: true, active: true },
  floating: { place: "corner", float: true },
  popup: { place: "corner", popup: true },
  corner: { place: "corner" },
  invisible: { place: "corner", invisible: true },
};
export const WINDOW_MODES = Object.freeze(Object.keys(MODES));

/**
 * The mode of a run that asks for none.
 * - On a Mac's display: invisible, after the wait (WAIT_MS). Checked on a
 *   Mac, on both displays: the window server's alpha 0 from
 *   the first on-screen moment through the close, clicks through, Gecko
 *   never throttled it (rAF 60.5 Hz, fresh shots), and nothing activated.
 *   offscreen, the spike's first pick, showed on the display without the
 *   front window, since the Mac ignores the -32000 and centres it. The wait
 *   and the hand-back stay: a see-through window can still take Zen's key
 *   focus.
 * - On another display: offscreen, after the wait. Only the Mac was checked.
 * - On a headless Zen: floating. There's no front app to wait for, and Zen's
 *   one window is always the active one. Only a floating window leaves it
 *   so, and there's no screen for it to float over.
 *
 * @param {boolean} [isHeadless]
 * @param {string} [platform]
 */
export function defaultWindow(isHeadless = headless(), platform = AppConstants.platform) {
  if (isHeadless) {
    return "floating";
  }
  return platform === "macosx" ? "invisible" : "offscreen";
}
// Retention: runs older than this go, and any beyond the newest few.
const KEEP_DAYS = 7;
const KEEP_RUNS = 10;
const MAX_SHOTS = 200;

// A run's folder: its start in UTC, plus -<n> when two start in one second.
const RUN_NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d{1,2}))?$/;
// The files a run writes. Retention removes these and nothing else.
const RUN_FILE = /^(?:summary\.json|\d{2,3}-[a-z0-9-]{1,81}\.png)$/;
const SHOT_NAME = /^([a-z0-9-]{1,40})\/([a-z0-9-]{1,40})$/;
const STOPPED_TEXT = { "timed-out": "timed out", "caller-left": "the caller left" };
// The reason a held call's progress frame gives while the run waits.
const HELD_REASON = "zen-in-front";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Where an instance's self-check lives: its socket, and its runs' folders. */
export function selfCheckPaths(instance, home = zeniusHome()) {
  const root = selfCheckDir(home);
  return { root, socket: PathUtils.join(root, `${instance}.sock`), runs: PathUtils.join(root, instance) };
}

// --- A run --------------------------------------------------------------------

/** @type {Run|null} */
let active = null;

export const SelfCheck = {
  /** The run going now, or null. */
  get active() {
    return active;
  },

  /**
   * Start a run, which goes on in the background: this returns at once.
   * Only chrome JS can pass options, so only tests on dev Zens do (through
   * dev.evalChrome). The socket's entry passes none.
   *
   * @param {object} [options]
   * @param {(win: Window) => any} [options.prepare]  the sidebar's by default; returns the run's scope
   * @param {(win: Window, ctx: object) => Promise<{checks: object[]}>} [options.run]  the sidebar's by default
   * @param {() => any} [options.cleanup]  the sidebar's by default; idempotent
   * @param {number} [options.timeoutMs]  a limit under LIMIT_MS
   * @param {string} [options.outDir]  a folder to write into, in place of the instance's runs
   * @param {string} [options.window]  how the window shows, one of WINDOW_MODES; defaultWindow() by default
   * @param {() => boolean} [options.zenInFront]  whether Zen is the app in front; zenInFront by default
   * @param {number} [options.waitMs]  how long to wait for Zen to be in the background, under WAIT_MS
   * @param {(held: boolean, reason?: string) => void} [options.onHeld]  told when the wait starts and ends (the socket's progress frames)
   * @returns {Run}
   */
  start(options = {}) {
    if (active) {
      throw new ZenError("ZEN_SELFCHECK_BUSY", "a self-check is running, and one runs at a time");
    }
    const run = new Run(stepsOf(options), options);
    active = run;
    run.done = run.go().finally(() => {
      if (active === run) {
        active = null;
      }
    });
    return run;
  },
};

/** prepare, run and cleanup: the options' own, else the agent sidebar's. */
function stepsOf(options) {
  const names = ["prepare", "run", "cleanup"];
  const steps = {};
  let sidebar;
  for (const name of names) {
    if (typeof options[name] === "function") {
      steps[name] = options[name];
      continue;
    }
    if (sidebar === undefined) {
      try {
        sidebar = ChromeUtils.importESModule(SIDEBAR);
      } catch {
        sidebar = null;
      }
    }
    if (typeof sidebar?.[name] !== "function") {
      throw new ZenError("ZEN_SELFCHECK_UNAVAILABLE", "this profile's agent sidebar has no self-check");
    }
    steps[name] = sidebar[name];
  }
  return steps;
}

class Stopped extends Error {}

/** The wait for Zen to be in the background ran out: nothing opened. */
class InFront extends Error {}

/** The self-check window has the focus: the user's most recent browser window gets it back. */
function giveFocusBack(win) {
  if (win.closed || Services.focus.activeWindow !== win) {
    return;
  }
  const user = Services.wm.getMostRecentWindow("navigator:browser");
  if (!user || user.closed) {
    log("self-check: its window got the focus, and there's no browser window to give it to");
    return;
  }
  user.focus();
  log("self-check: its window got the focus; the user's window has it back");
}

/**
 * Is Zen the app in front? Only then is one of its windows active. A
 * headless Zen has no front app to wait for.
 */
export function zenInFront() {
  if (headless()) {
    return false;
  }
  return Services.focus.activeWindow !== null;
}

function headless() {
  try {
    return Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo).isHeadless === true;
  } catch {
    return false;
  }
}

class Run {
  /** The self-check window, from the moment it's asked for. */
  window = null;
  /** What prepare returned. */
  scope = null;
  /** The run's folder. */
  dir = null;
  /** Settles after cleanup, the window's close and the summary; never rejects. */
  done = null;

  #steps;
  #options;
  #limitMs;
  #mode;
  #waitMs;
  #inFront;
  #onHeld;
  #held = false;
  #waitedMs = 0;
  /** The window that was active as the self-check window opened. */
  #before = null;
  #control = new AbortController();
  /** @type {null|"timed-out"|"caller-left"} */
  #stopped = null;
  #ended = false;
  #shots = 0;
  /** check id -> the files of its shots */
  #shotsOf = new Map();
  /** {check, step} of the last shot */
  #last = null;
  /** checks that run passed to checked() */
  #reported = [];

  constructor(steps, options) {
    this.#steps = steps;
    this.#options = options;
    const limit = options.timeoutMs;
    this.#limitMs = Number.isFinite(limit) && limit > 0 ? Math.min(limit, LIMIT_MS) : LIMIT_MS;
    this.#mode = options.window ?? defaultWindow();
    if (!WINDOW_MODES.includes(this.#mode)) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `window must be one of ${WINDOW_MODES.join(", ")}`);
    }
    const wait = options.waitMs;
    this.#waitMs = Number.isFinite(wait) && wait >= 0 ? Math.min(wait, WAIT_MS) : WAIT_MS;
    this.#inFront = typeof options.zenInFront === "function" ? options.zenInFront : zenInFront;
    this.#onHeld = typeof options.onHeld === "function" ? options.onHeld : null;
  }

  /** Stop the run: its caller left (the default), or its limit passed. */
  abort(reason = "caller-left") {
    if (this.#stopped || this.#ended) {
      return;
    }
    this.#stopped = reason === "timed-out" ? "timed-out" : "caller-left";
    this.#control.abort();
  }

  async go() {
    const t0 = Date.now();
    let timer = null;
    let returned = null;
    let failure = null;
    try {
      const { outDir } = this.#options;
      this.dir = await this.#until(outDir !== undefined ? ownFolder(outDir) : newRunFolder(readSettings().instance));
      const win = await this.#openInBackground();
      // The limit starts with the window, as a held call's timeouts start at
      // its release.
      timer = setTimeout(() => this.abort("timed-out"), this.#limitMs);
      await this.#until(this.#settle(win));
      this.scope = (await this.#until(Promise.resolve().then(() => this.#steps.prepare(win)))) ?? null;
      returned = await this.#until(Promise.resolve().then(() => this.#steps.run(win, this.#context())));
    } catch (e) {
      if (!(e instanceof Stopped)) {
        failure = e;
      }
    } finally {
      clearTimeout(timer);
      this.#ended = true;
    }
    // Each on its own, so one failure can't skip the next.
    await this.#cleanUp();
    await this.#closeWindow();
    const result = await this.#result(t0, returned, failure);
    await this.#writeSummary(result);
    log(`self-check: ${result.ok ? "passed" : "failed"} in ${result.ms} ms (${result.checks.length} checks)`);
    return result;
  }

  /** `promise`, unless the run stops first. */
  #until(promise) {
    const { signal } = this.#control;
    if (signal.aborted) {
      promise.catch(() => {});
      return Promise.reject(new Stopped());
    }
    return new Promise((resolve, reject) => {
      const stop = () => reject(new Stopped());
      signal.addEventListener("abort", stop, { once: true });
      promise.then(
        value => {
          signal.removeEventListener("abort", stop);
          resolve(value);
        },
        error => {
          signal.removeEventListener("abort", stop);
          reject(error);
        }
      );
    });
  }

  #context() {
    return {
      signal: this.#control.signal,
      shot: (name, rect) => this.#shot(name, rect),
      checked: check => {
        if (!this.#ended) {
          this.#reported.push(this.#checkOf(check));
        }
      },
    };
  }

  /**
   * Opens the window once Zen isn't the app in front, checking right before
   * it opens. Meanwhile the caller hears that its call is held. Throws
   * InFront if Zen stays in front past the wait.
   */
  async #openInBackground() {
    const deadline = Date.now() + this.#waitMs;
    let since = 0;
    try {
      for (;;) {
        if (!this.#inFront()) {
          // Nothing runs between that check and the window's opening.
          return this.#open();
        }
        if (!since) {
          since = Date.now();
          log("self-check: waiting for Zen to be in the background");
        }
        this.#hold(true);
        if (Date.now() >= deadline) {
          throw new InFront(
            `Zen stayed in front for ${Math.round(this.#waitMs / 1000)} s, and the self-check opens its window only while Zen is in the background`
          );
        }
        await this.#until(sleep(WAIT_POLL_MS));
      }
    } finally {
      if (since) {
        this.#waitedMs = Date.now() - since;
        log(`self-check: waited ${this.#waitedMs} ms for Zen to be in the background`);
      }
      this.#hold(false);
    }
  }

  /** Tells the caller, once per change, whether the call is held. */
  #hold(held) {
    if (held === this.#held) {
      return;
    }
    this.#held = held;
    try {
      this.#onHeld?.(held, held ? HELD_REASON : undefined);
    } catch (e) {
      log(`self-check: the caller couldn't be told the call is ${held ? "held" : "released"}: ${e?.message}`);
    }
  }

  #open() {
    this.#before = Services.focus.activeWindow;
    const anchor = Services.wm.getMostRecentWindow("navigator:browser");
    const win = Services.ww.openWindow(null, WINDOW_URL, "_blank", windowFeatures(this.#mode, anchor), null);
    this.window = win;
    // Before its document loads, which is when Gecko shows a chrome
    // window: it's never seen, not even for a frame.
    if (MODES[this.#mode].invisible) {
      const { ok, text } = seeThrough(win);
      log(`self-check: the invisible window: ${text}`);
      // Not see-through, it's a corner window, and the summary says so.
      if (!ok) {
        this.#mode = "corner";
      }
    }
    return win;
  }

  /** Waits for the window's document, then shows it as its mode says. */
  async #settle(win) {
    const before = this.#before;
    await loaded(win);
    // For the run's whole life, the window gives away any focus it gets.
    // Opened while Zen is in the background, it very likely becomes Zen's
    // key window. So a user who comes back to Zen mid-run with Cmd-Tab or
    // the Dock would find it over their window, with the focus: their keys
    // would land in the panel and a step's PNG. The same covers Zen active with none of its windows active,
    // which the wait reads as background.
    win.addEventListener("activate", () => Services.tm.dispatchToMainThread(() => giveFocusBack(win)), true);
    const mode = MODES[this.#mode];
    if (mode.minimize) {
      win.minimize();
    }
    if (mode.active) {
      try {
        win.browsingContext.isActive = true;
      } catch (e) {
        log(`self-check: the ${this.#mode} window can't be kept active: ${e?.message}`);
      }
    }
    // It must not keep the focus. Only a window that had it gets it back:
    // with none, Zen wasn't the app in front, which the wait makes the rule
    // outside a headless Zen and tests.
    if (before && !before.closed && Services.focus.activeWindow === win) {
      before.focus();
    }
  }

  /** A PNG of the window's own document, cropped to `rect`, at the window's device pixel ratio. */
  async #shot(name, rect) {
    const m = SHOT_NAME.exec(String(name));
    if (!m) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", 'a shot\'s name is "<check>/<step>", each of a-z, 0-9 and -, at most 40');
    }
    if (this.#control.signal.aborted) {
      return null;
    }
    const [, check, step] = m;
    this.#last = { check, step };
    if (this.#shots >= MAX_SHOTS) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `a run takes at most ${MAX_SHOTS} shots`);
    }
    const win = this.window;
    const area = rect ? new win.DOMRect(rect.x ?? rect.left ?? 0, rect.y ?? rect.top ?? 0, rect.width, rect.height) : null;
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(area, win.devicePixelRatio || 1, "white");
    let bytes;
    try {
      bytes = await pngOf(win, bitmap);
    } finally {
      bitmap.close();
    }
    if (this.#control.signal.aborted) {
      return null;
    }
    const file = `${String(++this.#shots).padStart(2, "0")}-${check}-${step}.png`;
    const path = PathUtils.join(this.dir, file);
    await IOUtils.write(path, bytes, { mode: "create" });
    await IOUtils.setPermissions(path, 0o600);
    const files = this.#shotsOf.get(check) ?? [];
    files.push(file);
    this.#shotsOf.set(check, files);
    return file;
  }

  async #cleanUp() {
    try {
      await bounded(
        Promise.resolve().then(() => this.#steps.cleanup()),
        CLEANUP_MS
      );
    } catch (e) {
      log(`self-check: cleanup failed: ${e?.message}`);
    }
  }

  async #closeWindow() {
    const win = this.window;
    if (!win || win.closed) {
      return;
    }
    try {
      win.close();
    } catch (e) {
      log(`self-check: closing the window failed: ${e?.message}`);
    }
    const end = Date.now() + CLOSE_MS;
    while (!win.closed && Date.now() < end) {
      await sleep(50);
    }
    if (!win.closed) {
      log(`self-check: the window didn't close within ${CLOSE_MS} ms`);
    }
  }

  /** A check as the summary holds it: plain ids, short text, no paths. */
  #checkOf(raw) {
    const id = idOf(raw?.id);
    const ok = raw?.ok === true;
    return {
      id,
      title: textOf(raw?.title, 200) ?? id,
      ok,
      failedStep: ok ? null : textOf(raw?.failedStep, 100),
      error: ok ? null : raw?.error instanceof Error ? errorText(raw.error) : textOf(raw?.error, 500),
      shots: [...(this.#shotsOf.get(id) ?? [])],
    };
  }

  async #result(t0, returned, failure) {
    let checks = [...this.#reported];
    if (returned && !this.#stopped && !failure) {
      if (Array.isArray(returned.checks)) {
        checks = returned.checks.map(check => this.#checkOf(check));
      } else {
        failure = new Error("the scenarios returned no checks");
      }
    }
    // A run cut short: the check in progress fails at its last shot's step.
    const last = this.#last;
    if ((this.#stopped || failure) && last && !checks.some(c => c.id === last.check)) {
      checks.push({
        id: last.check,
        title: last.check,
        ok: false,
        failedStep: last.step,
        error: this.#stopped ? STOPPED_TEXT[this.#stopped] : errorText(failure),
        shots: [...(this.#shotsOf.get(last.check) ?? [])],
      });
    }
    return {
      ok: !this.#stopped && !failure && checks.length > 0 && checks.every(c => c.ok),
      timedOut: this.#stopped === "timed-out",
      callerLeft: this.#stopped === "caller-left",
      ms: Date.now() - t0,
      waitedMs: this.#waitedMs,
      window: this.#mode,
      dir: this.dir,
      runtimeVersion: RUNTIME_VERSION,
      commit: await installedCommit(),
      zenVersion: zenVersion(),
      error: failure instanceof InFront ? failure.message : failure ? errorText(failure) : null,
      checks,
    };
  }

  /** summary.json: the result without dir, so it names files, never paths. */
  async #writeSummary(result) {
    if (!this.dir) {
      return;
    }
    const { dir, ...summary } = result;
    const path = PathUtils.join(dir, "summary.json");
    try {
      await IOUtils.writeUTF8(path, JSON.stringify(summary, null, 2) + "\n", { mode: "create" });
      await IOUtils.setPermissions(path, 0o600);
    } catch (e) {
      log(`self-check: the summary wasn't written: ${e?.message}`);
    }
  }
}

/**
 * Makes the window see-through (alpha 0) and lets clicks pass through it
 * (ignoresMouseEvents), on its own NSWindow through AppKit. Gecko sets a
 * window's opacity and click-through only for popup frames
 * (-moz-window-opacity, and pointer-events: none on a panel), never for a
 * top-level window like this one. Gecko still paints the window, so its shots
 * and requestAnimationFrame shouldn't depend on it being seen. On the Mac,
 * that was checked: occlusion, 60 Hz, fresh pixels, clicks through.
 * Returns whether the window is see-through, and what it did, for the log.
 *
 * @param {Window} win
 * @param {string} [platform]
 * @returns {{ok: boolean, text: string}}
 */
export function seeThrough(win, platform = AppConstants.platform) {
  const corner = why => ({ ok: false, text: `${why}, so it shows as a corner window` });
  if (platform !== "macosx") {
    return corner("not the Mac");
  }
  try {
    // The NSWindow, as "0x<hex>": a headless Zen's window has none (0x0).
    const handle = win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle;
    if (!/^0x[0-9a-f]+$/i.test(handle) || /^0x0+$/i.test(handle)) {
      return corner(`no native window (${handle})`);
    }
    const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    const objc = ctypes.open("/usr/lib/libobjc.A.dylib");
    try {
      const id = ctypes.voidptr_t;
      const sel = objc.declare("sel_registerName", ctypes.default_abi, id, ctypes.char.ptr);
      // Plain C, which can't raise. A message the object doesn't take would
      // raise an Objective-C exception: no JS error that try/catch sees, but
      // an abort of the user's Zen. So each selector
      // is checked before it's sent.
      const classOf = objc.declare("object_getClass", ctypes.default_abi, id, id);
      const takes = objc.declare("class_respondsToSelector", ctypes.default_abi, ctypes.bool, id, id);
      // objc_msgSend, declared once per signature: on arm64 it must be called
      // with the method's own types, never as a variadic function.
      // setAlphaValue: takes a CGFloat (a double), setIgnoresMouseEvents: a BOOL.
      const sendDouble = objc.declare("objc_msgSend", ctypes.default_abi, ctypes.void_t, id, id, ctypes.double);
      const sendBool = objc.declare("objc_msgSend", ctypes.default_abi, ctypes.void_t, id, id, ctypes.bool);
      const nsWindow = id(ctypes.UInt64(handle));
      const setAlpha = sel("setAlphaValue:");
      const setIgnores = sel("setIgnoresMouseEvents:");
      const cls = classOf(nsWindow);
      if (cls.isNull() || !takes(cls, setAlpha) || !takes(cls, setIgnores)) {
        return corner(`its native window (${handle}) takes no setAlphaValue: or setIgnoresMouseEvents:`);
      }
      sendDouble(nsWindow, setAlpha, 0);
      sendBool(nsWindow, setIgnores, true);
    } finally {
      objc.close();
    }
    return { ok: true, text: "see-through (alpha 0), and clicks pass through it (ignoresMouseEvents)" };
  } catch (e) {
    return corner(`failed (${e?.message ?? e})`);
  }
}

function windowFeatures(name, anchor) {
  const mode = MODES[name];
  // nsXULAlerts opens alert.xhtml with these.
  const kind = mode.popup ? ["dialog=yes", "titlebar=no", "popup=yes"] : ["dialog=no", "resizable", "minimizable"];
  const features = ["chrome", ...kind, `width=${WIDTH}`, `height=${HEIGHT}`];
  if (mode.float) {
    features.push("alwaysontop");
  }
  const screen = anchor?.screen;
  if (mode.place === "offscreen") {
    features.push("left=-32000", "top=-32000");
  } else if (screen) {
    features.push(
      `left=${Math.round(screen.availLeft + screen.availWidth - WIDTH - MARGIN)}`,
      `top=${Math.round(screen.availTop + screen.availHeight - HEIGHT - MARGIN)}`
    );
  }
  return features.join(",");
}

/** Resolves once the window's own document has loaded, or the window closed. */
function loaded(win) {
  return new Promise(resolve => {
    const poll = () => {
      if (win.closed || (win.document?.documentURI === WINDOW_URL && win.document.readyState === "complete")) {
        resolve();
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function pngOf(win, bitmap) {
  const canvas = win.document.createElementNS(HTML_NS, "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("the shot couldn't be encoded"))), "image/png")
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/** `promise`, or a rejection after `ms`. */
function bounded(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    }),
  ]);
}

async function installedCommit() {
  try {
    const path = PathUtils.join(PathUtils.profileDir, "chrome", "JS", "zenius", "install.json");
    const { commit } = await IOUtils.readJSON(path);
    return typeof commit === "string" ? commit : "";
  } catch {
    return "";
  }
}

function idOf(value) {
  const id = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return id || "check";
}

/** Text for the summary: the home folder written as ~, cut to `max`. */
function textOf(value, max) {
  if (value === undefined || value === null) {
    return null;
  }
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  return String(value).split(home).join("~").slice(0, max);
}

/** An exception's name and message, without its stack. */
function errorText(e) {
  if (!e) {
    return null;
  }
  return textOf(`${e.name || "Error"}: ${e.message ?? String(e)}`, 500);
}

// --- The folders ----------------------------------------------------------------

function isLink(path) {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file.isSymlink();
  } catch {
    return false;
  }
}

/** A test's folder: an absolute path to a folder, not a link. */
async function ownFolder(path) {
  if (typeof path !== "string" || !PathUtils.isAbsolute(path)) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "outDir must be an absolute path");
  }
  if (isLink(path) || (await IOUtils.stat(path)).type !== "directory") {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "outDir must be a folder, not a link");
  }
  return path;
}

/** 20261122T231500Z */
function stampOf(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** A run folder's start from its name, in ms, or null for any other name. */
function timeOfRun(name) {
  const m = RUN_NAME.exec(name);
  if (!m) {
    return null;
  }
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const at = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(at) ? { at, n: Number(m[7] ?? 0) } : null;
}

/**
 * A new run's folder in the instance's runs: retention first, so the run
 * that's starting never counts, then an exclusive mkdir, mode 0700.
 */
export async function newRunFolder(instance, date = new Date()) {
  if (!plainInstance(instance)) {
    throw new ZenError("ZEN_SELFCHECK_UNAVAILABLE", "this instance's name isn't a plain one");
  }
  const { root, runs } = selfCheckPaths(instance);
  await ensurePrivateDir(root);
  await ensurePrivateDir(runs);
  await retain(runs, date.getTime());
  const name = stampOf(date);
  for (let n = 0; n < 100; n++) {
    const dir = PathUtils.join(runs, n ? `${name}-${n}` : name);
    try {
      await IOUtils.makeDirectory(dir, { createAncestors: false, ignoreExisting: false, permissions: 0o700 });
    } catch (e) {
      if (isLink(dir) || (await IOUtils.exists(dir))) {
        continue;
      }
      throw e;
    }
    await IOUtils.setPermissions(dir, 0o700);
    return dir;
  }
  throw new ZenError("ZEN_INTERNAL", "no free name for the run's folder");
}

/**
 * Remove old runs from an instance's folder: those over KEEP_DAYS old by
 * their names (never by mtime), and any beyond the KEEP_RUNS newest. It's
 * literal: only the files a run writes go, by name, then the folder once
 * it's empty. Nothing goes recursively, and no link is followed: a folder
 * holding anything else stays.
 *
 * @param {string} runs  the instance's folder
 * @param {number} [at]  now, in ms
 * @returns {Promise<number>} how many runs it removed or emptied
 */
export async function retain(runs, at = Date.now()) {
  const found = [];
  for (const path of await IOUtils.getChildren(runs)) {
    const time = timeOfRun(PathUtils.filename(path));
    if (!time || isLink(path)) {
      continue;
    }
    try {
      if ((await IOUtils.stat(path)).type === "directory") {
        found.push({ path, ...time });
      }
    } catch {}
  }
  found.sort((a, b) => b.at - a.at || b.n - a.n);
  const cutoff = at - KEEP_DAYS * 86400000;
  let removed = 0;
  for (const [i, run] of found.entries()) {
    if (i < KEEP_RUNS && run.at >= cutoff) {
      continue;
    }
    await removeRun(run.path);
    removed++;
  }
  return removed;
}

async function removeRun(dir) {
  for (const path of await IOUtils.getChildren(dir)) {
    if (!RUN_FILE.test(PathUtils.filename(path)) || isLink(path)) {
      continue;
    }
    try {
      if ((await IOUtils.stat(path)).type === "regular") {
        await IOUtils.remove(path);
      }
    } catch (e) {
      log(`self-check: retention couldn't remove a run's file: ${e?.message}`);
    }
  }
  try {
    // Not recursive: a folder that still holds anything stays.
    await IOUtils.remove(dir);
  } catch {}
}
