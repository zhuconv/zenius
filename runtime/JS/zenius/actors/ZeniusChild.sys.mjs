// Child half of the "Zenius" JSWindowActor. It runs in the frame's process
// (any content process, or the parent for parent-process pages) and calls
// `export async function fn(actor, args)` in content/<module>.sys.mjs.

// A user's document loads this module and the leaf check alone (I4). The
// guards, and what a call needs, load with a task's first document.
import { guardActorNames, isAgentTaskPage, needsRefusals } from "chrome://userscripts/content/zenius/content/taskset.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  assessSignIn: "chrome://userscripts/content/zenius/content/signinguard.sys.mjs",
  watchReuse: "chrome://userscripts/content/zenius/content/signinguard.sys.mjs",
  installPageGuards: "chrome://userscripts/content/zenius/content/guards.sys.mjs",
  installRefusalGuards: "chrome://userscripts/content/zenius/content/refusals.sys.mjs",
  refuseSignIn: "chrome://userscripts/content/zenius/content/signinguard.sys.mjs",
  toWireError: "chrome://userscripts/content/zenius/modules/errors.sys.mjs",
  ZenError: "chrome://userscripts/content/zenius/modules/errors.sys.mjs",
});

const CONTENT_BASE = "chrome://userscripts/content/zenius/content/";
const MODULE_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

export class ZeniusChild extends JSWindowActorChild {
  // DOMWindowCreated arrives for every new document in a tab, before page
  // scripts run. It costs one Set lookup in tabs that aren't a task's. The
  // guards go into every page of an agent task, also one the user loads
  // while holding it, and check per call whether the agent drives the tab.
  handleEvent(event) {
    if (event.type !== "DOMWindowCreated") {
      return;
    }
    if (isAgentTaskPage(this.browsingContext)) {
      guard("page guards", () => lazy.installPageGuards(this));
      // The sign-in rules: is this document a sign-in page? Asked now,
      // while its URL is still its load's, and for the document an initial
      // about:blank's window is reused for.
      guard("sign-in pages", () => {
        lazy.assessSignIn(this, true);
        lazy.watchReuse(this);
      });
      // zen-ux's guard actors (ZeniusClipboard, ZeniusSystemUi) have no
      // DOMWindowCreated of their own: they're made here, in a task's
      // documents only, top and frames, before the page's scripts. An actor
      // without installGuards() still guards at its own DOMWindowCreated.
      for (const name of guardActorNames()) {
        guard(name, () => {
          const actor = this.manager.getActor(name);
          if (typeof actor.installGuards === "function") {
            actor.installGuards();
          }
        });
      }
    } else if (needsRefusals(this.browsingContext)) {
      // zen-observe: a popup a task's page opened, before the parent makes
      // it a page of the task, or a document of a tab whose page ran the
      // agent's code. Its documents get the storage refusals from the
      // first, frames too, so the opener can't take their natives.
      guard("refusals", () => lazy.installRefusalGuards(this));
      guard("sign-in pages", () => {
        lazy.assessSignIn(this, true);
        lazy.watchReuse(this);
      });
    }
  }

  async receiveMessage(msg) {
    // The parent asks for the guards in documents a tab already had when it
    // became a task's page (ZeniusService.installGuards).
    if (msg.name === "installGuards") {
      if (!isAgentTaskPage(this.browsingContext)) {
        return false;
      }
      guard("sign-in pages", () => lazy.assessSignIn(this));
      return lazy.installPageGuards(this);
    }
    if (msg.name !== "call") {
      return undefined;
    }
    const { module, fn, args, gate } = msg.data;
    try {
      if (!MODULE_RE.test(module)) {
        throw new lazy.ZenError("ZEN_INVALID_ARGUMENT", `bad content module name ${JSON.stringify(module)}`);
      }
      // An agent method's call (the parent says which kind): the sign-in
      // rules are checked here, at entry and before the result goes out.
      if (gate) {
        lazy.refuseSignIn(this, gate.kind, gate.method);
      }
      const mod = ChromeUtils.importESModule(`${CONTENT_BASE}${module}.sys.mjs`);
      const f = mod[fn];
      if (typeof f !== "function") {
        throw new lazy.ZenError("ZEN_INTERNAL", `content module ${module} has no exported function ${fn}`);
      }
      const value = await f(this, args);
      if (gate) {
        lazy.refuseSignIn(this, gate.kind, gate.method);
      }
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: lazy.toWireError(e) };
    }
  }

  /** Send an event to the parent; the service fans it out to subscribers. */
  emit(name, params) {
    try {
      this.sendAsyncMessage("event", { name, params });
    } catch {
      // The actor is being torn down with its document; nobody is listening.
    }
  }
}

/** One guard's install: a failure is logged and doesn't keep the others out. */
function guard(what, install) {
  try {
    install();
  } catch (e) {
    console.error(`[zenius] ${what} failed`, e);
  }
}
