// Content side of the I1 guards (the core). Runs in every new document of an
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
  // The observe layer's refusals: fullscreen, pointer lock, wake lock, speech, share.
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
  // The observe layer's glue: the agent's worlds see the native open through Xrays.
  lazy.mirrorMethod(win, "", "open", open);
  return true;
}

/** guards#installed: does this frame's document have the page guards? (tests) */
export function installed(actor) {
  return !!actor.document && guarded.has(actor.document);
}

/** Inputs that show their value attribute until someone changes them, cleaned up for their type. */
const TEXT_LIKE = new Set(["text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "month", "week", "time", "file"]);

/**
 * guards#userInput: what of the user's this frame's document holds, for a
 * document Zen loaded before zenius started (service #userInputIn). Its
 * user activation, which only real input gives (a cross-origin frame's
 * gives the top too), and whether a form field shows other than the page's
 * markup makes it: the user's typing, or text the session put back. Read
 * through Xrays, as the actor sees the page: its own scripts ran there with
 * no guard, and could have shadowed navigator.userActivation or a field's
 * value getter in their own world.
 */
export function userInput(actor) {
  const win = actor.contentWindow;
  const doc = actor.document;
  if (!win || !doc) {
    return { active: false, changed: false };
  }
  const active = !!win.navigator.userActivation?.hasBeenActive;
  // A document in designMode is an editor whose whole body the session
  // saves and puts back, which no field shows.
  const changed =
    doc.designMode === "on" || Array.prototype.some.call(doc.querySelectorAll("input, textarea, select"), el => fieldChanged(doc, el));
  return { active, changed };
}

/** Does the field show other than its markup would? A change only the page's own script made counts too: zenius can't tell the two apart. */
function fieldChanged(doc, el) {
  if (el.localName === "textarea") {
    return el.value !== el.defaultValue;
  }
  if (el.localName === "select") {
    return selectChanged(el);
  }
  if (el.type === "checkbox" || el.type === "radio") {
    return el.checked !== el.defaultChecked;
  }
  if (!TEXT_LIKE.has(el.type)) {
    return false;
  }
  // The value attribute as an unchanged field of the type shows it: an
  // email's spaces trimmed, a number that doesn't parse dropped. Detached,
  // so the page never sees it.
  const fresh = doc.createElement("input");
  fresh.type = el.type;
  fresh.multiple = el.multiple;
  fresh.defaultValue = el.defaultValue;
  return el.value !== fresh.value;
}

/**
 * A select's choice against its markup's: the options marked selected (only
 * the last counts in one that takes a single choice), else, in a dropdown,
 * its first enabled option, which shows though nothing marks it.
 */
function selectChanged(el) {
  const options = el.options;
  if (el.multiple) {
    return Array.prototype.some.call(options, option => option.selected !== option.defaultSelected);
  }
  let index = -1;
  for (let i = 0; i < options.length; i++) {
    if (options[i].defaultSelected) {
      index = i;
    }
  }
  if (index < 0 && el.size <= 1) {
    index = Array.prototype.findIndex.call(
      options,
      option => !option.disabled && !(option.parentNode?.localName === "optgroup" && option.parentNode.disabled)
    );
  }
  return el.selectedIndex !== index;
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
