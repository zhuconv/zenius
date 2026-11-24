// Content side of the I1 guards (zen-core). Runs in every new document of an
// agent task's tab, before the page's own scripts.

import { installRefusalGuards } from "chrome://userscripts/content/zenius/content/refusals.sys.mjs";
// The checks live in the leaf content/taskset.sys.mjs, which a user's
// document loads alone; this module loads with a task's first document.
import { isAgentCodeDocument, isAgentTaskPage } from "chrome://userscripts/content/zenius/content/taskset.sys.mjs";
export {
  AGENT_BROWSERS_KEY,
  TASK_BROWSERS_KEY,
  isAgentDriven,
  isAgentTaskPage,
} from "chrome://userscripts/content/zenius/content/taskset.sys.mjs";

// Loaded with a task's first guarded document, never in the user's own tabs (I4).
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  mirrorMethod: "chrome://userscripts/content/zenius/content/agentworld.sys.mjs",
});

/** Documents that have the page guards, so each gets them once. */
const guarded = new WeakSet();

/**
 * window.open() with size or position features opens a new top-level window,
 * which takes focus from the user. In a page of a task, the user's hold
 * included, and in a document that ran the agent's code after its task,
 * drop those features so the popup becomes a tab: the parent's tab hooks
 * join it to the task (closed groups, item 2) or refuse it (item 3). A
 * popup that still opens as a window, through a path this doesn't cover
 * (document.open with features), meets the parent's window creator
 * (modules/guards.sys.mjs). noopener and noreferrer keep their meaning. The
 * page sees a native-looking function (exportFunction), and the check runs
 * per call, so a page the user gets back after its task, in a document
 * where the agent's code never ran, has the normal behaviour.
 *
 * The actor calls this at DOMWindowCreated in every page of an agent task
 * (isAgentTaskPage), and the parent asks for it ("installGuards") in the
 * documents a tab already had when it became a task's page. Each document
 * gets the guards once. The actor hands the document to the agent's worlds
 * after this and every other page-side guard (adoptIntoWorlds).
 *
 * @param {JSWindowActorChild} actor
 * @returns {boolean} whether the guards went in now
 */
export function installPageGuards(actor) {
  const win = actor.contentWindow;
  const doc = actor.document;
  if (!win || !doc || guarded.has(doc)) {
    return false;
  }
  guarded.add(doc);
  // zen-observe's refusals: fullscreen, pointer lock, wake lock, speech, share.
  try {
    installRefusalGuards(actor);
  } catch (e) {
    console.error("[zenius] refusal guards failed", e);
  }
  const page = Cu.waiveXrays(win);
  const nativeOpen = page.open;
  if (typeof nativeOpen !== "function") {
    return true;
  }
  const bc = actor.browsingContext;
  // Reflect.apply is ours: the page's Function.prototype.apply can't read a
  // chrome array (and the page may have replaced it).
  const open = function open() {
    const args = Array.from(arguments);
    if (args.length >= 3 && (isAgentTaskPage(bc) || isAgentCodeDocument(bc))) {
      args[2] = keepOnlyLinkFeatures(args[2]);
    }
    return Reflect.apply(nativeOpen, page, args);
  };
  Cu.exportFunction(open, win, { defineAs: "open" });
  // zen-observe's glue: the agent's worlds see the native open through Xrays.
  lazy.mirrorMethod(win, "", "open", open);
  return true;
}

/** guards#installed: does this frame's document have the page guards? (tests) */
export function installed(actor) {
  return !!actor.document && guarded.has(actor.document);
}

function keepOnlyLinkFeatures(features) {
  if (features === undefined || features === null) {
    return features;
  }
  return String(features)
    .split(",")
    .map(f => f.trim())
    .filter(f => /^(noopener|noreferrer)(\s*=.*)?$/i.test(f))
    .join(",");
}
