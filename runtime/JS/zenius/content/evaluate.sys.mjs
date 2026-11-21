// Main-world evaluation (zen-observe), run in the page's process.
// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Debugger.executeInGlobal() runs source in the page's own global, as
// devtools' console and WebDriver BiDi do: page globals are visible, `var`
// lands on window, and the page's CSP doesn't block it. The window is never
// made a debuggee, so nothing is deoptimized. docs/research/observe.md §2.
//
// When the agent's code runs past its deadline, the world's hook
// (content/agentworld.sys.mjs) ends it: executeInGlobal returns a null
// completion, or the hook's signal ends a call whose code went async, and
// this module reports `terminated` instead of dying with the script. The
// parent's own stop (maybeCancelContentJSExecution) reaches only the page's
// global: the tests' page-world mode.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { watchConsole } from "chrome://userscripts/content/zenius/content/console.sys.mjs";
import { beginCall, endCall, instrumentLoops, remapPosition, takeReport, WORLD_URL, worldFor } from "chrome://userscripts/content/zenius/content/agentworld.sys.mjs";

const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

watchConsole();

const SOURCE_URL = "zenius://evaluate";
const MAX_DEPTH = 1000;

let dbg = null;
function debuggerInstance() {
  if (!dbg) {
    const { addDebuggerToGlobal } = ChromeUtils.importESModule("moz-src:///devtools/platform/jsdebugger.sys.mjs");
    addDebuggerToGlobal(globalThis);
    dbg = new globalThis.Debugger();
  }
  return dbg;
}

/**
 * Run `fn` in the window's main world and settle its result. A function is
 * called with `arg` when `hasArg`; a string runs as a script, like Chrome's
 * Runtime.evaluate. Promises are awaited.
 *
 * @returns {Promise<{ok: true, value: any} | {threw: true, error: any} | {terminated: true}>}
 *   `value` and `error` are the raw page values (Xray views).
 */
export function runInPage(win, args) {
  return runIn(win, win, SOURCE_URL, args);
}

/**
 * Tests only, while their suites move their reads of the page's own
 * JavaScript to dev.evalContent: the agent's code in the page's world, as
 * before the isolated world. zenius never sets this preference.
 */
function pageWorldForTests() {
  try {
    return Services.prefs.getBoolPref("zenius.test.pageWorldEvaluate", false);
  } catch {
    return false;
  }
}

/**
 * Tests only, for zen-sdk's corpus run both ways: the agent's code as
 * written, without the world's loop counter (instrumentLoops). zenius never
 * sets this preference.
 */
function loopCounterOff() {
  try {
    return Services.prefs.getBoolPref("zenius.test.loopCounterOff", false);
  } catch {
    return false;
  }
}

/**
 * Run the agent's `fn` for the document in `win`: in the agent's world for
 * it (content/agentworld.sys.mjs), never in the page's own JavaScript. The
 * outcome carries the world's report of the call: the page globals its code
 * couldn't see, and the routes into the page itself it was refused.
 */
export async function runInWorld(win, args) {
  if (pageWorldForTests()) {
    return runInPage(win, args);
  }
  const world = worldFor(win);
  takeReport(world);
  // The parent's cancel can't stop a script in a sandbox: the world's own
  // hook ends it at `budgetMs`. If that happens after the code went async,
  // the call can't settle by itself, so the hook's signal ends it.
  const call = beginCall(world, args.budgetMs ?? 0);
  try {
    const outcome = await Promise.race([runIn(win, world.sandbox, WORLD_URL, args, loopCounterOff() ? null : instrumentLoops), call.stopped]);
    return { ...outcome, report: takeReport(world) };
  } finally {
    endCall(world, call);
  }
}

/**
 * @param {Function} [rewrite]  source → {source, edits}: the world's loop
 *   counter (instrumentLoops); positions in errors are mapped back
 */
function runIn(win, target, url, { fn, isFunction, hasArg, arg }, rewrite = null) {
  const global = debuggerInstance().makeGlobalObjectReference(target);
  const bindings = {};
  let source = String(fn);
  if (isFunction) {
    source = `(${fn})()`;
    if (hasArg) {
      // A structured clone made in the target's compartment: page overrides
      // of JSON.parse can't see or change it.
      bindings.__zeniusArg = global.makeDebuggeeValue(Cu.cloneInto(arg, target));
      source = `(${fn})(__zeniusArg)`;
    }
  }
  let edits = null;
  if (rewrite) {
    ({ source, edits } = rewrite(source));
  }
  const completion = isFunction ? global.executeInGlobalWithBindings(source, bindings, { url }) : global.executeInGlobal(source, { url });
  if (completion === null) {
    return Promise.resolve({ terminated: true });
  }
  if ("throw" in completion) {
    // The completion's stack is where the throw happened, which Chrome's
    // exceptionDetails report; a thrown string has no other location.
    return Promise.resolve({ threw: true, error: rawValue(completion.throw), at: throwSite(completion.stack, edits), edits });
  }
  const value = completion.return;
  if (value && typeof value === "object" && value.class === "Promise") {
    const promise = value.unsafeDereference();
    return new Promise(resolve => {
      promise.then(
        v => resolve({ ok: true, value: v }),
        e => resolve({ threw: true, error: e, edits })
      );
    });
  }
  return Promise.resolve({ ok: true, value: rawValue(value) });
}

/**
 * The call fails when its code was refused a route into the page itself, or
 * read a page global it couldn't see, even when the code caught the throw:
 * a difference never passes silently.
 */
function worldRefusal(report) {
  if (report?.refused?.length) {
    return { worldRefused: { reason: "pageWorld", route: report.refused[0] } };
  }
  if (report?.missed?.length) {
    return { worldRefused: { reason: "pageGlobal", name: report.missed[0] } };
  }
  return null;
}

/** 0-based line and column of a SavedFrame (Gecko's are 1-based). */
function throwSite(frame, edits = null) {
  try {
    if (frame && Number.isInteger(frame.line) && Number.isInteger(frame.column)) {
      const column = edits && frame.source === WORLD_URL ? remapPosition(edits, frame.line, frame.column) : frame.column;
      return { line: Math.max(0, frame.line - 1), column: Math.max(0, column - 1) };
    }
  } catch {}
  return null;
}

function rawValue(debuggerValue) {
  return debuggerValue && typeof debuggerValue === "object" ? debuggerValue.unsafeDereference() : debuggerValue;
}

/** Error objects of every kind (TypeError's class is "TypeError"), and DOMExceptions. */
function isError(v) {
  try {
    if ((typeof v !== "object" && typeof v !== "function") || v === null) {
      return false;
    }
    const name = ChromeUtils.getClassName(v, true);
    return /Error$/.test(name) || name === "DOMException";
  } catch {
    return false;
  }
}

/**
 * Chrome DevTools' returnByValue, which Ego relies on: a JSON-like copy of
 * own enumerable properties (getters run), `undefined` dropped from objects
 * and null in arrays; DOM nodes, Maps, Sets and Dates have no own
 * enumerable properties, so they come back as {}. Cycles fail, as in Chrome.
 * At the top level, Ego turns undefined, functions and symbols into null and
 * decodes NaN, ±Infinity, -0 and BigInt, which travel as `unserializable`.
 *
 * @returns {{value: any} | {unserializable: string}}
 */
export function byValue(raw) {
  const top = unserializable(raw);
  if (top !== null) {
    return { unserializable: top };
  }
  if (raw === undefined || typeof raw === "function" || typeof raw === "symbol") {
    return { value: null };
  }
  return { value: copy(raw, 0, new Set()) };
}

function unserializable(v) {
  if (typeof v === "bigint") {
    return `${v}n`;
  }
  if (typeof v === "number") {
    if (Number.isNaN(v)) {
      return "NaN";
    }
    if (v === Infinity) {
      return "Infinity";
    }
    if (v === -Infinity) {
      return "-Infinity";
    }
    if (Object.is(v, -0)) {
      return "-0";
    }
  }
  return null;
}

function copy(v, depth, seen) {
  if (v === null || v === undefined) {
    return null;
  }
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      return Number.isFinite(v) ? v : null;
    case "bigint":
      // PROTOCOL "Frames": inside a value, a BigInt reads "123n".
      return `${v}n`;
    case "symbol":
      return null;
  }
  // Objects and functions: walk the page's own view of them.
  if (depth >= MAX_DEPTH || seen.has(v)) {
    // Chromium's returnByValue error, which Ego passes on as a plain Error.
    throw new ZenError("ZEN_EVALUATION_FAILED", "Object reference chain is too long", { plain: true });
  }
  seen.add(v);
  try {
    const w = Cu.waiveXrays(v);
    if (Array.isArray(w)) {
      const out = [];
      for (let i = 0; i < w.length; i++) {
        out.push(copy(Cu.unwaiveXrays(w[i]), depth + 1, seen));
      }
      return out;
    }
    const out = {};
    for (const key of Object.keys(w)) {
      const item = Cu.unwaiveXrays(w[key]);
      if (item !== undefined) {
        out[key] = copy(item, depth + 1, seen);
      }
    }
    return out;
  } finally {
    seen.delete(v);
  }
}

/** Gecko's "fn@url:line:col" stack lines in V8's "    at fn (url:line:col)" form. */
function v8Stack(stack, edits = null) {
  let text = String(stack);
  if (edits?.length) {
    // The world's frames, at the agent's own columns (instrumentLoops).
    text = text.replace(/zenius:\/\/agent-world:(\d+):(\d+)/g, (_, line, column) => `${WORLD_URL}:${line}:${remapPosition(edits, Number(line), Number(column))}`);
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const at = line.lastIndexOf("@");
      const name = at > 0 ? line.slice(0, at) : "";
      const where = (at >= 0 ? line.slice(at + 1) : line).replace(SOURCE_URL, "<anonymous>").replace(WORLD_URL, "<anonymous>");
      return name ? `    at ${name} (${where})` : `    at ${where}`;
    })
    .join("\n");
}

/**
 * An exception thrown by page code, as Ego reports it: CDP's description
 * ("Error: boom\n    at …") and the 0-based line and column of the throw.
 */
export function describeError(raw, at = null, edits = null) {
  if (isError(raw)) {
    const w = Cu.waiveXrays(raw);
    let description;
    let site = at;
    try {
      description = `${w.name ?? "Error"}: ${w.message ?? ""}`;
      const stack = typeof w.stack === "string" ? v8Stack(w.stack, edits) : "";
      if (stack) {
        description += `\n${stack}`;
      }
      if (!site && Number.isInteger(w.lineNumber) && Number.isInteger(w.columnNumber)) {
        const column = edits && w.fileName === WORLD_URL ? remapPosition(edits, w.lineNumber, w.columnNumber) : w.columnNumber;
        site = { line: Math.max(0, w.lineNumber - 1), column: Math.max(0, column - 1) };
      }
    } catch {}
    if (description) {
      return { description, ...site };
    }
  }
  let description;
  try {
    description = typeof raw === "object" && raw !== null ? ChromeUtils.getClassName(raw, true) || "Object" : String(raw);
  } catch {
    description = "Uncaught";
  }
  return { description, ...at };
}

/**
 * Resolves `{hidden: true}` once this document stops being its frame's
 * current one. A document left behind by a navigation may sit frozen in the
 * bfcache, its actor alive, so calls into it would never fail on their own.
 * stop() removes the listener.
 */
export function watchHidden(actor) {
  const win = actor.contentWindow;
  let onHide = null;
  const promise = new Promise(resolve => {
    if (!win || actor.manager?.isCurrentGlobal === false) {
      resolve({ hidden: true });
      return;
    }
    onHide = () => resolve({ hidden: true });
    win.addEventListener("pagehide", onHide, { mozSystemGroup: true, once: true });
  });
  return {
    promise,
    stop() {
      if (onHide) {
        try {
          win.removeEventListener("pagehide", onHide, { mozSystemGroup: true });
        } catch {}
      }
    },
  };
}

/** Is this actor's document gone, or no longer its frame's current one? */
export function isStale(actor) {
  return !actor.contentWindow || actor.manager?.isCurrentGlobal === false;
}

/** Health probe: answers at once unless the page's process is busy. */
export function ping() {
  return true;
}

/** The parent's view of an evaluation: value, unserializable or exception. */
export async function evaluate(actor, args) {
  const win = actor.contentWindow;
  if (isStale(actor)) {
    return { destroyed: true };
  }
  const hidden = watchHidden(actor);
  let outcome;
  try {
    outcome = await Promise.race([runInWorld(win, args), hidden.promise]);
  } finally {
    hidden.stop();
  }
  if (outcome.hidden) {
    // Chromium's "Execution context was destroyed."
    return { destroyed: true };
  }
  if (outcome.terminated) {
    return { terminated: true };
  }
  const refused = worldRefusal(outcome.report);
  if (refused) {
    return refused;
  }
  if (outcome.threw) {
    return { exception: describeError(outcome.error, outcome.at, outcome.edits) };
  }
  // Chrome reports a returned Error object as a failed evaluation too.
  if (isError(outcome.value)) {
    const { description } = describeError(outcome.value);
    return { exception: { description: description.split("\n")[0] } };
  }
  return byValue(outcome.value);
}

/**
 * Ego's waitForFunction poll: Boolean(await predicate) every `polling` ms
 * until it holds or `timeoutMs` passes. A predicate that throws ends the
 * wait at once. Returns {ok} | {timedOut, url, title} | {exception} |
 * {terminated}.
 */
export async function waitForFunction(actor, { id, polling = 100, timeoutMs = 10000, ...args }) {
  const win = actor.contentWindow;
  if (isStale(actor)) {
    return { navigated: true };
  }
  const deadline = ChromeUtils.now() + timeoutMs;
  // The parent polls the frame's next document when this one goes away.
  const hidden = watchHidden(actor);
  // The parent cancels the poll when the agent loses control (cancelWait).
  let cancel;
  const cancelled = new Promise(resolve => (cancel = () => resolve({ cancelled: true })));
  if (id !== undefined) {
    waits.set(id, cancel);
  }
  try {
    for (;;) {
      // A predicate that runs past the wait's end is stopped there.
      const budgetMs = Math.max(1, deadline - ChromeUtils.now());
      const outcome = await Promise.race([runInWorld(win, { ...args, budgetMs }), hidden.promise, cancelled]);
      if (outcome.cancelled) {
        return { cancelled: true };
      }
      if (outcome.hidden) {
        return { navigated: true };
      }
      if (outcome.terminated) {
        return { terminated: true };
      }
      const refused = worldRefusal(outcome.report);
      if (refused) {
        return refused;
      }
      if (outcome.threw) {
        return { exception: describeError(outcome.error, outcome.at, outcome.edits) };
      }
      if (outcome.value) {
        return { ok: true };
      }
      const left = deadline - ChromeUtils.now();
      if (left <= 0) {
        return { timedOut: true, url: win.location.href, title: win.document.title };
      }
      const slept = await Promise.race([
        new Promise(resolve => setTimeout(resolve, Math.min(polling, left))),
        hidden.promise,
        cancelled,
      ]);
      if (slept?.cancelled) {
        return { cancelled: true };
      }
      if (slept?.hidden) {
        return { navigated: true };
      }
    }
  } finally {
    hidden.stop();
    if (id !== undefined) {
      waits.delete(id);
    }
  }
}

/** waitForFunction polls in progress in this process, by the parent's id. */
const waits = new Map();

/**
 * Stop the poll `id` before its next run of the predicate: the agent lost
 * control of the Space (methods/observe.sys.mjs). A predicate run already
 * awaiting finishes in the page, and its result is dropped.
 */
export function cancelWait(_actor, { id }) {
  const cancel = waits.get(id);
  waits.delete(id);
  cancel?.();
  return !!cancel;
}

// Ego's fetchInPage (page-model.ts:4262-4317), TypeScript types removed. It
// runs in the page's main world, so the page's cookies, CORS and service
// workers apply, as with Ego.
const FETCH_IN_PAGE = `async function fetchInPage({
  url,
  options,
  timeoutMs,
  responseType,
}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await window.fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const metadata = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers,
    };
    if (responseType === "text") {
      return { ...metadata, body: await response.text() };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return { ...metadata, bodyBase64: btoa(binary) };
  } catch (error) {
    if (controller.signal.aborted) {
      return { fetchError: \`page.fetch timed out after \${timeoutMs}ms\` };
    }
    let requestUrl = url;
    try {
      requestUrl = new URL(url, window.location.href).href;
    } catch {
      // Keep the caller's URL when it cannot be resolved in the Page.
    }
    const detail =
      error instanceof Error
        ? \`\${error.name}: \${error.message}\`
        : String(error);
    return {
      fetchError:
        \`page.fetch uses window.fetch and obeys browser CORS. \` +
        \`Request \${JSON.stringify(requestUrl)} from \${JSON.stringify(window.location.origin)} failed: \${detail}\`,
    };
  } finally {
    window.clearTimeout(timer);
  }
}`;

/** page.fetch in the page: {ok, status, statusText, url, headers, body | bodyBase64} or {fetchError}. */
export async function fetch(actor, payload) {
  const outcome = await runInPage(actor.contentWindow, { fn: FETCH_IN_PAGE, isFunction: true, hasArg: true, arg: payload });
  if (outcome.terminated) {
    return { fetchError: `page.fetch timed out after ${payload.timeoutMs}ms` };
  }
  if (outcome.threw) {
    return { fetchError: describeError(outcome.error).description.split("\n")[0] };
  }
  const result = byValue(outcome.value).value;
  if (typeof result?.fetchError === "string") {
    // Chromium's text for a fetch the network or CORS refused.
    result.fetchError = result.fetchError.replace(
      /TypeError: NetworkError when attempting to fetch resource\.$/,
      "TypeError: Failed to fetch"
    );
  }
  return result;
}
