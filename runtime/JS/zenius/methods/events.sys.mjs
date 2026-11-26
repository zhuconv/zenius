// events.* methods (the core): event frames on this connection.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";

// Gate classes (SPI.md, "Dispatch"): access for the control gate (I3), i5
// for the web-content gate (I5).
export const access = {
  "events.subscribe": "none",
};

export const i5 = {
  "events.subscribe": "none",
};

export const methods = {
  // {names?: [..], space?, page?} → {ok}. Each call adds a filter; an event
  // goes out once if any filter matches. Closing the connection ends them.
  "events.subscribe": async (ctx, params) => {
    if (!ctx.conn) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "events.subscribe needs a client connection");
    }
    const { names, space, page } = params;
    if (names !== undefined && !(Array.isArray(names) && names.every(n => typeof n === "string"))) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "events.subscribe names must be a list of event names");
    }
    if (space !== undefined && !Number.isInteger(space)) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "events.subscribe space must be a numeric task-space id");
    }
    if (page !== undefined && typeof page !== "string") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "events.subscribe page must be a page label");
    }
    ctx.service.subscribe(ctx.conn, { names, space, page });
    return { ok: true };
  },
};
