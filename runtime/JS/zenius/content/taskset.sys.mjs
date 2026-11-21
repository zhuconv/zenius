// Which documents are an agent task's (zen-core): the checks the Zenius
// actor makes at every new document of a web tab, and the sharedData keys
// the parent publishes for them. A leaf that imports nothing, so a user's
// document loads this and the actor's own module, nothing else of zenius
// (I4). The guards themselves (content/guards.sys.mjs, content/refusals.sys.mjs)
// and zen-ux's guard actors load in a task's documents only.
//
// The checks moved here from content/guards.sys.mjs and zen-observe's
// content/refusals.sys.mjs, which re-export them.

/** The tabs the agent drives right now (browserIds; modules/service.sys.mjs). */
export const AGENT_BROWSERS_KEY = "zenius:agentBrowserIds";
/** Every page of an agent task, also while the user holds it (zen-ux glue). */
export const TASK_BROWSERS_KEY = "zenius:taskBrowserIds";
/**
 * The top documents (innerWindowId) where the agent's code ran, in a task's
 * tab (observe/agentcode.sys.mjs).
 * The refusals that hold for a task's whole life stay on such a document
 * after the task, until it is replaced: code the agent left there still runs
 * (the manager's decision, 2026-11-20).
 */
export const AGENT_CODE_DOCS_KEY = "zenius:agentCodeDocIds";
/**
 * The pages the user holds (browserId → the hold's id, H's browserId),
 * published by observe/hold.sys.mjs: a hand-off's page and the popups it
 * opens during the hold.
 */
export const HELD_PAGES_KEY = "zenius:heldPages";
/**
 * The actors besides the Zenius actor whose children guard a task's
 * documents (ZeniusService.addGuardActor: zen-ux's ZeniusClipboard and
 * ZeniusSystemUi). The Zenius actor makes them in a task's new documents
 * and calls their installGuards(), so a user's document never makes them.
 */
export const GUARD_ACTORS_KEY = "zenius:guardActors";

/** Does the parent say the agent drives this tab right now? */
export function isAgentDriven(browsingContext) {
  try {
    return !!Services.cpmm.sharedData.get(AGENT_BROWSERS_KEY)?.has(browsingContext.browserId);
  } catch {
    return false;
  }
}

/**
 * Is this tab a page of an agent task, whoever holds it right now? Guards
 * that check isAgentDriven() per call install in these documents: a page
 * the user loads while holding the task needs them once they hand it back.
 */
export function isAgentTaskPage(browsingContext) {
  try {
    return !!Services.cpmm.sharedData.get(TASK_BROWSERS_KEY)?.has(browsingContext.browserId);
  } catch {
    return false;
  }
}

/** Is `bc` in a tab whose top document is one where the agent's code ran? */
export function isAgentCodeDocument(bc) {
  try {
    const id = bc?.top?.currentWindowContext?.innerWindowId;
    return !!id && !!Services.cpmm.sharedData.get(AGENT_CODE_DOCS_KEY)?.has(id);
  } catch {
    return false;
  }
}

/** Popups' top BrowsingContexts → what opened them, as it was at their first document. */
const popupOpeners = new WeakMap();

/**
 * Is `bc` in a popup that a page of an agent task opened, before the parent
 * makes it one of the task's pages (a popup of such a popup too)? Or one
 * that a document where the agent's code ran opened, task or not? The
 * opener is read at the popup's first document, when the actor's
 * DOMWindowCreated asks, and kept only if it was such a page then: a page
 * that then sets `opener = null` changes nothing, and a popup the user's tab
 * opened stays the user's when the agent later takes that tab. False once
 * the opener's task has ended and its document is replaced.
 *
 * zen-core's actor installs the refusals in such a popup's documents,
 * frames included, from its first document (actors/ZeniusChild.sys.mjs), so
 * the opener can't take a fresh popup's natives (own-tab.md, second round).
 *
 * @param {BrowsingContext} bc
 */
export function isTaskPopup(bc, depth = 0) {
  let top = null;
  try {
    top = bc?.top ?? null;
  } catch {}
  if (!top || depth > 8) {
    return false;
  }
  let opener = popupOpeners.get(top);
  if (opener === undefined) {
    let candidate = null;
    try {
      candidate = top.opener ?? null;
    } catch {}
    opener = candidate && openerCounts(candidate, depth) ? candidate : null;
    popupOpeners.set(top, opener);
  }
  return !!opener && openerCounts(opener, depth);
}

function openerCounts(opener, depth) {
  return isAgentTaskPage(opener) || isAgentCodeDocument(opener) || isTaskPopup(opener, depth + 1);
}

/**
 * Does a document that isn't a task's page need the refusals (zen-core's
 * actor asks at DOMWindowCreated)? A popup of a task's page, or any
 * document of a tab whose top document ran the agent's code: a frame or
 * popup the code left there makes after the task gets them from its first
 * document.
 */
export function needsRefusals(bc) {
  return isTaskPopup(bc) || isAgentCodeDocument(bc);
}

/** The guard actors to make in a task's documents (GUARD_ACTORS_KEY). */
export function guardActorNames() {
  try {
    return Services.cpmm.sharedData.get(GUARD_ACTORS_KEY) ?? [];
  } catch {
    return [];
  }
}
