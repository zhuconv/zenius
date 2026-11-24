// Console messages from agent tabs (zen-observe), forwarded to the parent as
// Runtime.consoleAPICalled for page.events(). One observer per content
// process; it costs a lookup per console call in tabs the agent doesn't drive.

import { isAgentDriven } from "chrome://userscripts/content/zenius/content/guards.sys.mjs";
import { inSignInResult } from "chrome://userscripts/content/zenius/content/signinguard.sys.mjs";
import { capText, cut, STRING_TEXT } from "chrome://userscripts/content/zenius/observe/textcap.sys.mjs";

const LEVELS = { warn: "warning", log: "log", info: "info", error: "error", debug: "debug", trace: "trace" };
// The arguments of one console call that are forwarded; the parent caps
// the text of each event too (observe/textcap.sys.mjs).
const MAX_ARGS = 32;

let installed = false;

/**
 * CDP's RemoteObject for a console argument: a value for primitives only.
 * A string longer than the cap is cut, and says `truncated: true`.
 */
function remoteObject(v) {
  switch (typeof v) {
    case "string":
      return v.length > STRING_TEXT ? { type: "string", value: cut(v, STRING_TEXT), truncated: true } : { type: "string", value: v };
    case "boolean":
      return { type: typeof v, value: v };
    case "number":
      return Number.isFinite(v) && !Object.is(v, -0)
        ? { type: "number", value: v }
        : { type: "number", unserializableValue: String(Object.is(v, -0) ? "-0" : v), description: String(v) };
    case "undefined":
      return { type: "undefined" };
    case "bigint": {
      const text = cut(`${v}n`, 64);
      return { type: "bigint", unserializableValue: text, description: text };
    }
    case "symbol":
      return { type: "symbol", description: cut(String(v), 256) };
    case "function":
      return { type: "function", className: "Function", description: "function" };
  }
  if (v === null) {
    return { type: "object", subtype: "null", value: null };
  }
  let className = "Object";
  try {
    className = ChromeUtils.getClassName(v, true) || "Object";
  } catch {}
  return { type: "object", className, description: className };
}

/** A ConsoleAPIStorage log event, for agent tabs only. */
function onLogEvent(message) {
  const innerID = Number(message?.innerID);
  if (!innerID) {
    return;
  }
  const wgc = WindowGlobalChild.getByInnerWindowId(innerID);
  if (!wgc || !isAgentDriven(wgc.browsingContext)) {
    return;
  }
  // A sign-in result's console is the user's: its text can hold the code.
  if (inSignInResult(wgc)) {
    return;
  }
  let args = [];
  let dropped = false;
  try {
    const all = message.arguments ?? [];
    dropped = all.length > MAX_ARGS;
    args = Array.from(dropped ? Array.prototype.slice.call(all, 0, MAX_ARGS) : all, remoteObject);
  } catch {}
  // The call's place first, so long arguments can't crowd it out of the
  // event's text.
  const event = {
    type: String(LEVELS[message.level] ?? message.level),
    stackTrace: message.filename
      ? {
          callFrames: [
            {
              url: String(message.filename),
              lineNumber: (message.lineNumber || 1) - 1,
              columnNumber: (message.columnNumber || 1) - 1,
              functionName: String(message.functionName || ""),
            },
          ],
        }
      : undefined,
    args,
    executionContextId: 0,
    timestamp: Number(message.timeStamp) || Date.now(),
  };
  const capped = capText(event);
  if (capped.truncated || dropped || args.some(a => a.truncated)) {
    capped.value.truncated = true;
  }
  try {
    wgc.getActor("Zenius").emit("observe.console", capped.value);
  } catch {}
}

/** Start forwarding this process's console messages from agent tabs. */
export function watchConsole() {
  if (installed) {
    return;
  }
  installed = true;
  // Gecko no longer notifies "console-api-log-event" observers; devtools
  // listens to the storage directly, and so do we.
  Cc["@mozilla.org/consoleAPI-storage;1"]
    .getService(Ci.nsIConsoleAPIStorage)
    .addLogEventListener(onLogEvent, Services.scriptSecurityManager.getSystemPrincipal());
}
