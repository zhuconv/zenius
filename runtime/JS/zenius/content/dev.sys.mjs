// Content side of dev.evalContent (the core). Dev profiles only.

import { evalAsync, pageWorldSandbox, systemSandbox } from "chrome://userscripts/content/zenius/modules/sandbox.sys.mjs";

/**
 * @param {JSWindowActorChild} actor
 * @param {{code: string, privileged?: boolean, arg?: any}} args
 */
export async function evalContent(actor, { code, privileged, arg }) {
  const win = actor.contentWindow;
  const sb = privileged
    ? systemSandbox(win, { actor })
    : pageWorldSandbox(win);
  return evalAsync(sb, code, { arg, filename: privileged ? "zenius-dev-content-privileged" : "zenius-dev-content" });
}
