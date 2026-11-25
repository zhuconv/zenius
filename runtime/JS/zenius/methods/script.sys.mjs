// script.* (zen-runtime): the step of a script that zenius mcp's script tool
// runs, on a connection of its own (docs/mcp.md, "script"). That connection
// begins the script's step in the task and ends it; each step its calls make
// in the task meanwhile carries `within`, the script step's id, so the
// sidebar shows them under it (input/steps.sys.mjs). A connection that
// closes without ending its step ends it as stopped. The sidebar's Stop
// (steps' stopScript) closes the connection, after telling its client why.

import { ErrorCodes, ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";

const STEPS_URL = "chrome://userscripts/content/zenius/input/steps.sys.mjs";
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  beginScript: STEPS_URL,
  endScript: STEPS_URL,
});

export const access = {
  // Never held at a takeover prompt: the step only shows what follows.
  "script.begin": "task",
  "script.end": "none",
};

export const i5 = {
  "script.begin": "none",
  "script.end": "none",
};

export const methods = {
  // `space`: the task the script works in; `purpose`: the tool's, the
  // agent's own words, which the step quotes. One script per connection.
  "script.begin": async (ctx, params) => {
    const rec = ctx.resolveSpace(params);
    const conn = ctx.conn;
    if (!conn) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "script.begin is a client's call: the script's connection is its own");
    }
    if (conn.state.script) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "this connection's script has begun already: a script has a connection of its own");
    }
    if (params.purpose !== undefined && typeof params.purpose !== "string") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "script.begin's purpose must be a string");
    }
    const script = lazy.beginScript({
      space: rec.id,
      purpose: params.purpose,
      stop: () => {
        // Its client hears why first: the user stopped the script, and Zen
        // didn't go away. end(), not close(): close() can drop a frame the
        // socket hasn't sent yet, this one included.
        conn.send({ event: "scriptStopped", params: { step: script.id } });
        conn.end();
      },
    });
    conn.state.script = script;
    (conn.state.onClose ??= []).push(() => lazy.endScript(script, { outcome: "stopped" }));
    return { step: script.id };
  },

  // `outcome`: "ok", or the code of the error the script ended with; any
  // other value reads "failed", so a step shows no words of the script's.
  "script.end": async (ctx, params) => {
    const script = ctx.conn?.state.script;
    if (!script) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "script.end: no script began on this connection");
    }
    const { outcome } = params;
    const shown = outcome === "ok" ? "ok" : typeof outcome === "string" && ErrorCodes[outcome] ? outcome : "failed";
    return { ended: lazy.endScript(script, { outcome: shown }) };
  },
};
