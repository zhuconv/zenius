// Evaluate source text in a sandbox and await its result. Works in both
// processes and for any sandbox principal: the result comes back through an
// exported callback, so we never await a promise from another compartment.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { toJSONSafe } from "chrome://userscripts/content/zenius/modules/serialize.sys.mjs";

/**
 * Compile `code` as an async arrow: first as an expression, and if that is a
 * syntax error, as a function body (so `return` works).
 *
 * @param {object} sandbox  from Cu.Sandbox
 * @param {string} code
 * @param {object} [opts]
 * @param {any} [opts.arg]  cloned into the sandbox and bound to `arg`
 * @param {string} [opts.filename]
 * @returns {Promise<any>} JSON-safe result
 */
export function evalAsync(sandbox, code, { arg, filename = "zenius-eval" } = {}) {
  const wrap = body =>
    `(function (__zeniusDone, arg) { (async () => ${body})().then(v => __zeniusDone(true, v), e => __zeniusDone(false, e)); })`;
  let runner;
  try {
    runner = Cu.evalInSandbox(wrap(`(${code}\n)`), sandbox, "latest", filename, 1);
  } catch (e) {
    if (!isSyntaxError(e)) {
      throw e;
    }
    runner = Cu.evalInSandbox(wrap(`{\n${code}\n}`), sandbox, "latest", filename, 0);
  }
  return callRunner(sandbox, runner, arg);
}

/**
 * Call `(${fn})(arg)`, or evaluate `fn` as an expression when isFunction is
 * false. Unlike evalAsync this never treats the text as a function body.
 */
export function evalFunction(sandbox, fn, { arg, isFunction = true, filename = "zenius-evaluate" } = {}) {
  const call = isFunction ? `(${fn}\n)(arg)` : `(${fn}\n)`;
  const runner = Cu.evalInSandbox(
    `(function (__zeniusDone, arg) { Promise.resolve().then(() => ${call}).then(v => __zeniusDone(true, v), e => __zeniusDone(false, e)); })`,
    sandbox,
    "latest",
    filename,
    1
  );
  return callRunner(sandbox, runner, arg);
}

function callRunner(sandbox, runner, arg) {
  return new Promise((resolve, reject) => {
    const done = (ok, value) => {
      if (ok) {
        // A throw here would land in the sandbox's promise chain, and the
        // call would never settle.
        try {
          resolve(toJSONSafe(value));
        } catch (e) {
          reject(new ZenError("ZEN_INTERNAL", `the evaluation's result can't be sent: ${e.message}`));
        }
      } else {
        const err = Cu.waiveXrays(value);
        reject(
          new ZenError("ZEN_INTERNAL", `evaluation threw ${errorText(err)}`, {
            thrown: { name: safeGet(err, "name"), message: safeGet(err, "message"), stack: safeGet(err, "stack") },
          })
        );
      }
    };
    const exported = Cu.exportFunction(done, sandbox);
    const clonedArg = arg === undefined ? undefined : Cu.cloneInto(arg, sandbox);
    Cu.waiveXrays(runner)(exported, clonedArg);
  });
}

function isSyntaxError(e) {
  try {
    return e?.name === "SyntaxError" || /SyntaxError/.test(String(e));
  } catch {
    return false;
  }
}

function safeGet(obj, key) {
  try {
    const v = obj?.[key];
    return v === undefined ? undefined : String(v);
  } catch {
    return undefined;
  }
}

function errorText(err) {
  const name = safeGet(err, "name");
  const message = safeGet(err, "message");
  if (name || message) {
    return `${name ?? "Error"}: ${message ?? ""}`;
  }
  try {
    return String(err);
  } catch {
    return "a value";
  }
}

/** A sandbox that sees the page's own globals, like page script does. */
export function pageWorldSandbox(win) {
  return Cu.Sandbox(win, {
    sandboxPrototype: win,
    wantXrays: false,
    sameZoneAs: win,
    sandboxName: "zenius page world",
  });
}

/** A chrome-privileged sandbox whose global falls back to `win` (Xrayed if content). */
export function systemSandbox(win, extras = {}) {
  const sb = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), {
    sandboxPrototype: win,
    wantComponents: true,
    wantGlobalProperties: ["ChromeUtils"],
    sandboxName: "zenius chrome eval",
  });
  Object.assign(sb, extras);
  return sb;
}
