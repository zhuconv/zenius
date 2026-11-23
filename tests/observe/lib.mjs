// Shared setup for zen-observe's runtime tests. tests/observe/run.sh starts a
// fresh headless dev Zen and sets ZENIUS_INSTANCE; tests drive it over RPC
// against zen-eval's fixture server (Ego's e2e routes).
//
// Every test runs inside `inSpace()`, which checks I1: what the user sees
// (dev.viewState: each window's selected tab, active workspace and focused
// element) must be the same after the test as before it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { isDeepStrictEqual, promisify } from "node:util";
import { connect } from "../../scripts/lib/rpc.mjs";
import { closeFixtureServer, startFixtureServer } from "../fixtures/server.mjs";

export async function setup() {
  const instance = process.env.ZENIUS_INSTANCE;
  if (!instance) {
    throw new Error("ZENIUS_INSTANCE is not set; run tests/observe/run.sh");
  }
  const client = await connect(instance);
  const fixture = await startFixtureServer("zen-observe");
  const env = {
    client,
    base: fixture.baseUrl,
    call: (method, params = {}) => client.call(method, params),
    /**
     * Resolve with the error instead of rejecting: {code, message, data},
     * where message is the runtime's text without the client's prefix.
     */
    fail: (method, params = {}) =>
      client.call(method, params).then(
        value => assert.fail(`${method} succeeded with ${JSON.stringify(value)}`),
        error => {
          const prefix = `${method}: ${error.code}: `;
          const message = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
          return { code: error.code, message, data: error.data ?? {} };
        }
      ),
    /** Chrome JS in the parent (a function body); see dev.evalChrome. */
    chrome: (code, arg) => client.call("dev.evalChrome", { code, arg }),
    /**
     * Run `fn(page)` in a new task space and check I1 around it. `page` holds
     * the space id and label plus helpers bound to them.
     */
    async inSpace(name, fn) {
      const before = await client.call("dev.viewState");
      const probe = await client.call("dev.evalChrome", { code: FOCUS_PROBE_START }).catch(() => null);
      // Each step's start and end, on the same clock as the probe's log.
      const steps = [];
      const { call, fail } = env;
      const traced = f => (method, params) => {
        const t = Date.now();
        return f(method, params).finally(() => steps.push({ t, end: Date.now(), step: method }));
      };
      env.call = traced(call);
      env.fail = traced(fail);
      const space = await client.call("spaces.create", { name: `${name} ${Date.now() % 100000}` });
      const page = pageHelpers(env, space.id, "p1");
      try {
        await fn(page);
      } finally {
        env.call = call;
        env.fail = fail;
        await client.call("spaces.finish", { space: space.id, keep: [] });
      }
      const after = await client.call("dev.viewState");
      const log = probe ? await client.call("dev.evalChrome", { code: FOCUS_PROBE_STOP }).catch(() => null) : null;
      await checkView(name, before, after, { probe, steps, log });
    },
    async close() {
      client.close();
      await closeFixtureServer(fixture.server);
    },
  };
  return env;
}

// ---------------------------------------------------------------------------
// I1 and OS focus
//
// viewState's activeWindow is the Zen window with OS focus, or null when
// another application has it. Focus that leaves Zen for another app (the
// user clicking elsewhere on the Mac) isn't preemption, but viewState alone
// can't tell the two apart. So each test records, in the parent, every
// window's activate and deactivate, windows opening and closing, and
// Services.focus.activeWindow every 50 ms; the client marks each step's
// start and end. A test whose only change is our window losing focus to
// null, with no Zen window opening or activating meanwhile, reports an
// external focus loss with that timeline instead of failing I1.

export const FOCUS_PROBE_START = `
  win.__zoFocus?.stop();
  const log = [];
  const id = w => { try { return w?.docShell?.outerWindowID ?? null; } catch { return null; } };
  const kind = w => {
    try {
      const el = w.document.documentElement;
      return el.getAttribute("windowtype") || el.id || w.location.href;
    } catch { return "?"; }
  };
  const record = (type, w) =>
    log.push({ t: Date.now(), type, window: id(w), kind: w ? kind(w) : null, active: id(Services.focus.activeWindow) });
  const onEvent = e => record(e.type, e.currentTarget);
  const attached = new Set();
  const attach = w => {
    if (attached.has(w)) return;
    attached.add(w);
    w.addEventListener("activate", onEvent, true);
    w.addEventListener("deactivate", onEvent, true);
  };
  for (const w of Services.wm.getEnumerator(null)) attach(w);
  const listener = {
    onOpenWindow(appWindow) {
      const w = appWindow.docShell.domWindow;
      record("open", w);
      w.addEventListener("load", () => { record("loaded", w); attach(w); }, { once: true });
    },
    onCloseWindow(appWindow) { record("close", appWindow.docShell?.domWindow); },
  };
  Services.wm.addListener(listener);
  let last = id(Services.focus.activeWindow);
  const timer = win.setInterval(() => {
    const now = id(Services.focus.activeWindow);
    if (now !== last) {
      log.push({ t: Date.now(), type: "activeWindow", from: last, to: now });
      last = now;
    }
  }, 50);
  win.__zoFocus = {
    log,
    stop() {
      win.clearInterval(timer);
      Services.wm.removeListener(listener);
      for (const w of attached) {
        try {
          w.removeEventListener("activate", onEvent, true);
          w.removeEventListener("deactivate", onEvent, true);
        } catch {}
      }
      delete win.__zoFocus;
    },
  };
  return { t: Date.now(), active: last };`;

export const FOCUS_PROBE_STOP = `
  const probe = win.__zoFocus;
  if (!probe) return null;
  probe.stop();
  return probe.log;`;

/** Focus left our window for another application: nothing in Zen took it. */
function externalFocusLoss(log, from) {
  if (!log) {
    return false; // no record: can't tell
  }
  const opened = log.some(e => e.type === "open" || e.type === "loaded");
  const otherActivated = log.some(e => e.type === "activate" && e.window !== from);
  const otherActive = log.some(e => e.type === "activeWindow" && e.to !== null && e.to !== from);
  return !opened && !otherActivated && !otherActive;
}

/** The steps and focus events in time order, with activeWindow around each step. */
function focusTimeline({ probe, steps, log }) {
  const changes = (log ?? []).filter(e => e.type === "activeWindow");
  const activeAt = t => {
    let v = probe?.active ?? "?";
    for (const c of changes) {
      if (c.t <= t) {
        v = c.to;
      }
    }
    return v;
  };
  const rows = [
    ...steps.map(s => ({ t: s.t, text: `step ${s.step} (${s.end - s.t} ms): activeWindow ${activeAt(s.t)} before, ${activeAt(s.end)} after` })),
    ...(log ?? []).map(e => ({
      t: e.t,
      text:
        e.type === "activeWindow"
          ? `activeWindow ${e.from} -> ${e.to}`
          : `${e.type} window ${e.window} (${e.kind}); activeWindow ${e.active}`,
    })),
  ].sort((a, b) => a.t - b.t);
  const t0 = probe?.t ?? rows[0]?.t ?? 0;
  return [
    `  focus timeline (probe ${log ? "on" : "unavailable"}; activeWindow ${probe?.active ?? "?"} at start):`,
    ...rows.map(r => `  +${String(r.t - t0).padStart(6)} ms  ${r.text}`),
  ].join("\n");
}

/** The application macOS has frontmost, by name (lsappinfo needs no permission). */
async function frontApp() {
  if (process.platform !== "darwin") {
    return null;
  }
  try {
    const run = promisify(execFile);
    const asn = (await run("/usr/bin/lsappinfo", ["front"])).stdout.trim();
    const info = (await run("/usr/bin/lsappinfo", ["info", "-only", "name", asn])).stdout.trim();
    return info || asn || null;
  } catch {
    return null;
  }
}

export async function checkView(name, before, after, trace) {
  if (isDeepStrictEqual(after, before)) {
    if (process.env.ZENIUS_FOCUS_LOG === "1") {
      console.log(`[focus] ${name}\n${focusTimeline(trace)}`);
    }
    return;
  }
  const { activeWindow: was, ...restBefore } = before;
  const { activeWindow: now, ...restAfter } = after;
  if (isDeepStrictEqual(restAfter, restBefore) && was !== null && now === null && externalFocusLoss(trace.log, was)) {
    const front = await frontApp();
    console.log(
      `[focus] ${name}: Zen lost OS focus to another application (activeWindow ${was} -> null); ` +
        `external, not an I1 failure.${front ? ` Frontmost app now: ${front}.` : ""}\n${focusTimeline(trace)}`
    );
    return;
  }
  assert.deepEqual(after, before, `${name} changed what the user sees (I1)\n${focusTimeline(trace)}`);
}

export function pageHelpers(env, space, label) {
  const P = { space, page: label };
  return {
    space,
    label,
    P,
    call: (method, params = {}) => env.call(method, { ...P, ...params }),
    fail: (method, params = {}) => env.fail(method, { ...P, ...params }),
    goto: (url, options) => env.call("page.goto", { ...P, url, ...(options ? { options } : {}) }),
    /** page.evaluate of a string expression or a function's source. */
    evaluate: (fn, ...arg) =>
      env.call("page.evaluate", {
        ...P,
        fn: typeof fn === "function" ? fn.toString() : fn,
        isFunction: typeof fn === "function",
        ...(arg.length ? { arg: arg[0] } : {}),
      }),
    /** Click an element the way a user would, with user activation. */
    click: selector =>
      env.call("dev.evalContent", {
        ...P,
        privileged: true,
        arg: selector,
        code: `const el = actor.document.querySelector(arg); el.scrollIntoView({block: "center"});
          const r = el.getBoundingClientRect(); const w = actor.contentWindow;
          w.synthesizeMouseEvent("mousedown", r.x + r.width / 2, r.y + r.height / 2, { button: 0, buttons: 1, clickCount: 1 }, {});
          w.synthesizeMouseEvent("mouseup", r.x + r.width / 2, r.y + r.height / 2, { button: 0, buttons: 0, clickCount: 1 }, {});
          return true`,
      }),
    page: other => pageHelpers(env, space, other),
  };
}

/** Milliseconds `fn` takes, with its result. */
export async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}

/** PIDs of the processes whose command line names `path` (Linux; none where there's no /proc). */
function processesNaming(path) {
  let pids;
  try {
    pids = readdirSync("/proc").filter(p => /^\d+$/.test(p));
  } catch {
    return [];
  }
  return pids.filter(pid => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "latin1").includes(path);
    } catch {
      return false;
    }
  });
}

/**
 * Remove a test's scratch folder once nothing writes there. The sidebar's
 * fake agents get their log paths in it and may still be ending after
 * A.stop: a log line written during the removal made rmSync fail with
 * ENOTEMPTY, and the after hook never reached env.close, so the file hung
 * until run.sh's limit. Waits up to 5 s for
 * them, then removes with retries.
 */
export async function removeScratch(dir) {
  if (!dir) {
    return;
  }
  for (let i = 0; i < 50 && processesNaming(dir).length; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
