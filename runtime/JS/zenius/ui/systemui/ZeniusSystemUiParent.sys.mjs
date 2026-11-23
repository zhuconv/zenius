// Parent half of the "ZeniusSystemUi" actor (zen-ux); see the child for what
// it guards.
//
// - passkey (query): the page asked for a passkey while the agent drives the
//   tab. The Space goes to the user (permission_prompt, through ZeniusUI as
//   for a permission prompt), and the answer comes once the user holds the
//   Space and sees this tab ({go: true}), or once they hand back first or the
//   page goes away ({go: false}). ZeniusUI may refuse it at once
//   ({go: false}, no hold): a page can't pull the user in at will.
// - passkeyDone {id, outcome}: the request settled ("ok", "error" when the
//   user cancelled the OS sheet, "abort" when the page withdrew it). The
//   hold ends, and the Space returns to the agent as after a permission
//   prompt, unless the user took it. Withdrawn, or ended before the user
//   saw it, the request was left unanswered.
// - notification: the page's notification wasn't shown; the agent gets a
//   Zenius.notification event.
//
// Defence in depth: only an agent task's pages run the guards, so messages
// from other tabs are ignored, and each message's fields are checked, as a
// compromised content process could send anything. observe/events.sys.mjs
// caps an event's text.

import { pushEvent } from "chrome://userscripts/content/zenius/observe/events.sys.mjs";
import { ZeniusUI } from "chrome://userscripts/content/zenius/ui/index.sys.mjs";
import { isTabVisible } from "chrome://userscripts/content/zenius/ui/visibility.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});

/** How often a held passkey request checks whether the user is there. */
const POLL_MS = 150;

/** For tests: what the guards did. */
export const systemUiStats = { notifications: 0, passkeyHeld: 0, passkeyGo: 0, passkeyRefused: 0 };

export class ZeniusSystemUiParent extends JSWindowActorParent {
  /** @type {Map<string, (go: boolean) => void>} held passkey requests */
  #held = new Map();

  receiveMessage({ name, data }) {
    const browser = this.browsingContext.top?.embedderElement;
    if (!browser || !ZeniusUI.service?.controlOf(browser)) {
      // Not a task page's guard: a passkey request is then the page's own.
      return name === "passkey" ? { go: true } : null;
    }
    if (!data || typeof data !== "object" || (name.startsWith("passkey") && typeof data.id !== "string")) {
      return name === "passkey" ? { go: false } : null;
    }
    switch (name) {
      case "passkey":
        return this.#passkey(browser, data.id);
      case "passkeyDone": {
        // Still held: the page withdrew it before the user saw it.
        const before = this.#held.has(data.id);
        this.#held.get(data.id)?.(false);
        ZeniusUI.releaseForUser(browser, passkeyKey(data.id), !before && data.outcome !== "abort");
        return null;
      }
      case "notification":
        systemUiStats.notifications++;
        pushEvent(browser.browserId, "Zenius.notification", {
          title: text(data.title),
          body: text(data.body),
          tag: text(data.tag),
          // The parent's record of the document, not the message's.
          url: this.manager?.documentURI?.spec ?? "",
        });
        return null;
    }
    return null;
  }

  didDestroy() {
    for (const end of [...this.#held.values()]) {
      end(false);
    }
  }

  /** @returns {Promise<{go: boolean}>} */
  #passkey(browser, id) {
    const hit = ZeniusUI.service?.controlOf(browser);
    if (!hit || hit.space.ownership !== "agent") {
      // The user holds the task: their own request, as usual.
      return Promise.resolve({ go: true });
    }
    const spaceId = hit.space.id;
    const key = passkeyKey(id);
    // The parent's own record of the requesting document, not the child's.
    const origin = this.manager?.documentPrincipal?.originNoSuffix ?? "";
    if (!ZeniusUI.holdForUser(browser, "permission_prompt", key, "for a passkey", origin)) {
      systemUiStats.passkeyRefused++;
      return Promise.resolve({ go: false });
    }
    systemUiStats.passkeyHeld++;
    return new Promise(resolve => {
      let timer = 0;
      const end = go => {
        lazy.clearInterval(timer);
        if (!this.#held.delete(id)) {
          return;
        }
        if (go) {
          systemUiStats.passkeyGo++;
        } else {
          systemUiStats.passkeyRefused++;
          ZeniusUI.releaseForUser(browser, key, false);
        }
        resolve({ go });
      };
      const check = () => {
        const rec = ZeniusUI.service?.spaces.peek(spaceId);
        if (!rec || rec.gone || !browser.isConnected || rec.ownership === "agent" || rec.ownership === "user") {
          // Handed back (or the task ended) before the user looked.
          end(false);
          return;
        }
        // Not ownerGlobal: zenius's module scope doesn't see it.
        const tab = browser.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser);
        if (tab && isTabVisible(tab)) {
          end(true);
        }
      };
      this.#held.set(id, end);
      timer = lazy.setInterval(check, POLL_MS);
      check();
    });
  }
}

/** A message field as text: only strings count. */
function text(v) {
  return typeof v === "string" ? v : "";
}

/** The request's key among the Space's open prompts. */
function passkeyKey(id) {
  return `zenius-passkey-${id}`;
}
