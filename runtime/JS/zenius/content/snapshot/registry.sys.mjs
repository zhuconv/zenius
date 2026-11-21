// The content half of the ref registry (docs/SPI.md, "Refs and locators"):
// resolves a ref to its node in the ref's own frame. The node tables live in
// the document's sandbox (walker.js), so they go away with the document.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { sandboxById, UA_LOCAL_ID_BASE, uaNode } from "chrome://userscripts/content/zenius/content/snapshot/sandbox.sys.mjs";

/**
 * @param {JSWindowActorChild} actor the actor of the ref's frame
 * @param {{refId: number, innerWindowId: number, localId: number}} ref from Refs.resolve
 * @param {{detached?: boolean}} [options] detached: also a node the page took
 *   out of its document, which may come back (an action retries it, as Ego's do)
 * @returns {Element} as chrome sees it, through Xrays
 * @throws {ZenError} ZEN_REF_STALE when the document changed or the node is gone
 */
export function resolveRef(actor, { refId, innerWindowId, localId }, { detached = false } = {}) {
  const stale = () => new ZenError("ZEN_REF_STALE", `Stale ref: @${refId}; take a new snapshot`, { ref: refId });
  if (actor.manager.innerWindowId !== innerWindowId) {
    throw stale();
  }
  const entry = sandboxById(innerWindowId);
  if (!entry?.loaded.has("walker")) {
    throw stale();
  }
  if (localId >= UA_LOCAL_ID_BASE) {
    // A datetimebox field, kept on this side (sandbox.sys.mjs).
    const node = uaNode(entry, localId);
    if (!node) {
      throw stale();
    }
    return node;
  }
  const node = Cu.waiveXrays(entry.sandbox).__zsWalker.resolve(localId, detached);
  if (!node) {
    throw stale();
  }
  return Cu.unwaiveXrays(node);
}
