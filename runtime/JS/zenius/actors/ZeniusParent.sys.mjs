// Parent half of the "Zenius" JSWindowActor. Method handlers reach content
// through ctx.content(), which lands in call() below.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ZeniusService: "chrome://userscripts/content/zenius/modules/service.sys.mjs",
  noteSignInPage: "chrome://userscripts/content/zenius/observe/signin.sys.mjs",
});

export class ZeniusParent extends JSWindowActorParent {
  /**
   * Run `fn` from content/<module>.sys.mjs in this frame's process.
   *
   * @param {string} module
   * @param {string} fn
   * @param {any} args  structured-clonable
   * @param {{kind: "read"|"act", method: string}} [gate]  an agent method's call:
   *   the child checks the sign-in rules at its entry and before its result
   */
  async call(module, fn, args, gate) {
    let reply;
    try {
      reply = await this.sendQuery("call", gate ? { module, fn, args, gate } : { module, fn, args });
    } catch (e) {
      // The document went away (navigation, tab closed, process crash)
      // before it answered.
      throw new ZenError("ZEN_PAGE_UNRESPONSIVE", `content call ${module}#${fn} failed: ${e.message}`, {
        reason: "context_destroyed",
      });
    }
    if (reply?.ok) {
      return reply.value;
    }
    throw ZenError.fromWire(reply?.error);
  }

  /**
   * Events sent by content modules through actor.sendAsyncMessage("event", …),
   * and the child's report of a sign-in page (content/signinguard.sys.mjs).
   */
  receiveMessage(msg) {
    if (msg.name === "event") {
      lazy.ZeniusService.onContentEvent(this, msg.data);
    } else if (msg.name === "signIn") {
      lazy.noteSignInPage(this.manager, msg.data);
    }
  }
}
