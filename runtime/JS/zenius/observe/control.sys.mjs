// Agent JavaScript runs in a page only while the agent controls its Space
// (I3; zen-observe). The gate holds new calls while the Space is paused (a
// takeover prompt, the panel's Pause) and refuses them under user control.
// This module covers the calls already running when control goes: without
// it, a predicate polling a password field would read it as the user typed.
//
// page.waitForFunction is held: its poll stops while the Space is paused
// and goes on when the agent has it back. page.evaluate can't be held,
// because its async steps would go on running in the page, so it fails.

import { ZeniusService } from "chrome://userscripts/content/zenius/modules/service.sys.mjs";
import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { controlError } from "chrome://userscripts/content/zenius/modules/spaces.sys.mjs";

/**
 * Watch the Space `rec` while a call runs agent JavaScript. `lost` resolves
 * once the agent doesn't control it: `{paused: true}` while the user
 * decides, or `{error}` (the gate's error) when the Space is the user's or
 * gone.
 *
 * @param {object} rec  the call's SpaceRecord
 * @returns {{lost: Promise<{paused: true} | {error: Error}>, stop(): void}}
 */
export function watchControl(rec) {
  let settle;
  const lost = new Promise(resolve => (settle = resolve));
  let off = null;
  const check = () => {
    const state = lostState(rec);
    if (state) {
      off?.();
      off = null;
      settle(state);
    }
  };
  // A Space that goes away closes its pages, which ends their calls.
  off = ZeniusService.addEventListener((event, params) => {
    if (event === "spaceChanged" && params?.space === rec.id) {
      check();
    }
  });
  check();
  return {
    lost,
    stop() {
      off?.();
      off = null;
    },
  };
}

function lostState(rec) {
  if (rec.gone) {
    return { error: new ZenError("ZEN_TASK_SPACE_NOT_FOUND", `Task space not found: ${rec.id}`, { space: rec.id }) };
  }
  if (rec.ownership !== "agent") {
    return { error: controlError(rec) };
  }
  if (rec.paused) {
    return { paused: true };
  }
  return null;
}

/**
 * The error for a call stopped because the agent lost control: the gate's
 * code and data, with what was stopped. A pause reports the user in
 * control too, with reason "paused": task.waitForControl() resolves when
 * the user lets the agent go on.
 */
export function stoppedError(lost, rec, method) {
  if (lost.paused) {
    return new ZenError(
      "ZEN_TASK_SPACE_USER_IN_CONTROL",
      `The user paused task space ${rec.id} while ${method} was running JavaScript in the page, so zenius stopped it: agent code may not run while the user decides. Wait with task.waitForControl(), then run it again.`,
      { space: rec.id, reason: "paused", stopped: method }
    );
  }
  const { error } = lost;
  return new ZenError(error.code, `${method} was stopped: ${error.message}`, { ...(error.data ?? {}), stopped: method });
}
