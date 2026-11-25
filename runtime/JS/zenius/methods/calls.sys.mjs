// calls.* (zen-runtime): a client gives up on a request of its own, as
// zenius mcp does when its client cancels a tool call (MCP's
// notifications/cancelled). The request stops: its waits end at once, its
// page code stops as at a takeover, an action still looking for its target
// ends without acting, and it gets no answer; its step reads "stopped"
// (modules/service.sys.mjs, #stopRequest). A connection that closes stops
// its running requests the same way.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";

export const access = {
  "calls.cancel": "none",
};

export const i5 = {
  "calls.cancel": "none",
};

export const methods = {
  // `id`: a request this connection sent. `canceled` says whether it was
  // still running; one that has answered is past stopping.
  "calls.cancel": async (ctx, params) => {
    const { id } = params;
    if (!((typeof id === "number" && Number.isFinite(id)) || typeof id === "string")) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "calls.cancel needs the id of a request this connection sent");
    }
    return { canceled: ctx.service.cancelRequest(ctx.conn, id) };
  },
};
