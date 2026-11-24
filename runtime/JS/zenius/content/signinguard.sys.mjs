// The sign-in rules in a page's process (content/signin.sys.mjs has the
// rules). Each document is assessed once: at DOMWindowCreated in a task's
// documents, before any script runs, or, for a document from before the task
// or one restored from the back-forward cache, at the first agent call or
// when the guards install. An agent call into a sign-in page is refused
// here, in the page's process, at its entry and again before its result
// goes out, so a call can't read a page that the check let through.
//
// Only a task's documents load this module: the Zenius actor imports it
// lazily (I4).

import {
  DEVICE_PAGES_KEY,
  SIGN_IN_DOCS_KEY,
  signInPageOf,
  signInRefusal,
} from "chrome://userscripts/content/zenius/content/signin.sys.mjs";
import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";

/**
 * The documents assessed in this process: Document to its flag
 * ({reason, page}) or null. A document the back-forward cache restores is
 * the same Document, so it keeps its flag.
 *
 * @type {WeakMap<Document, {reason: string, page: string}|null>}
 */
const assessed = new WeakMap();

/** The tests' extra device-login pages, which the parent publishes on dev profiles only. */
function extraDevicePages() {
  try {
    const pages = Services.cpmm.sharedData.get(DEVICE_PAGES_KEY);
    return Array.isArray(pages) ? pages : [];
  } catch {
    return [];
  }
}

/**
 * The sign-in flag of the actor's document, assessed once, from its URL at
 * load and its referrer. At DOMWindowCreated (`early`) no script has run, so
 * the document's URL is its load's. Later, history.replaceState may have
 * cut it, so the URL comes from the docShell's channel for the document,
 * which keeps the address it loaded from (redirects followed), a restore
 * from the back-forward cache included. A sign-in page is reported to the
 * parent, which needs it for its own checks.
 *
 * @param {JSWindowActorChild} actor
 * @param {boolean} [early]
 * @returns {{reason: string, page: string}|null}
 */
export function assessSignIn(actor, early = false) {
  let doc = null;
  try {
    doc = actor.document;
  } catch {}
  if (!doc) {
    return null;
  }
  if (assessed.has(doc)) {
    return assessed.get(doc);
  }
  let url = null;
  if (!early) {
    try {
      url = actor.docShell?.currentDocumentChannel?.URI ?? null;
    } catch {}
  }
  let flag = null;
  try {
    flag = signInPageOf(url ?? doc.documentURIObject, doc.referrer, extraDevicePages());
  } catch (e) {
    console.error("[zenius] assessing a document for the sign-in rules failed", e);
  }
  assessed.set(doc, flag);
  if (flag) {
    try {
      actor.sendAsyncMessage("signIn", flag);
    } catch {
      // The document is going away with its actor.
    }
  }
  return flag;
}

/**
 * A window's initial about:blank is reused for its first document when that
 * one has the same origin (a frame whose src is on its parent's site, a
 * popup opened on the opener's): that document gets no DOMWindowCreated of
 * its own. Assess it when it has been parsed. Its URL is read from the
 * docShell's channel then, which its scripts can't have changed.
 *
 * @param {JSWindowActorChild} actor  at the initial document's DOMWindowCreated
 */
export function watchReuse(actor) {
  let win = null;
  let blank = null;
  try {
    win = actor.contentWindow;
    blank = actor.document;
  } catch {}
  if (!win || !blank?.isInitialDocument) {
    return;
  }
  const onParsed = event => {
    let doc = null;
    try {
      doc = win.document;
    } catch {}
    if (!doc || doc === blank || event.target !== doc) {
      return;
    }
    win.removeEventListener("DOMContentLoaded", onParsed, { capture: true, mozSystemGroup: true });
    try {
      assessSignIn(actor);
    } catch (e) {
      console.error("[zenius] assessing a reused window's document failed", e);
    }
  };
  win.addEventListener("DOMContentLoaded", onParsed, { capture: true, mozSystemGroup: true });
}

/** For a screenshot, which paints every frame: assess this document, and say whether it's a sign-in result. */
export function assess(actor) {
  return assessSignIn(actor)?.reason === "authorization_response";
}

/** The flag of a document already assessed here, or null: for checks that mustn't assess. */
export function signInFlagOf(doc) {
  return (doc && assessed.get(doc)) ?? null;
}

/**
 * The flag of the actor's tab's top document, when the actor is in a frame:
 * assessed here when the top is in this process, else as the parent
 * published it.
 */
function topFlag(actor) {
  let bc = null;
  let top = null;
  try {
    bc = actor.browsingContext;
    top = bc?.top ?? null;
  } catch {}
  if (!top || top === bc) {
    return null;
  }
  try {
    const topActor = top.window?.windowGlobalChild?.getActor("Zenius");
    if (topActor) {
      return assessSignIn(topActor);
    }
  } catch {
    // The top document is in another process.
  }
  try {
    const id = top.currentWindowContext?.innerWindowId;
    return (id && Services.cpmm.sharedData.get(SIGN_IN_DOCS_KEY)?.get(id)) || null;
  } catch {
    return null;
  }
}

/**
 * Is the document of `wgc` (a WindowGlobalChild in this process), or its
 * tab's top document, a sign-in result? For what the page's process sends
 * the agent unasked, such as console messages: those are dropped.
 *
 * @param {WindowGlobalChild} wgc
 */
export function inSignInResult(wgc) {
  try {
    const actor = wgc.getActor("Zenius");
    return assessSignIn(actor)?.reason === "authorization_response" || topFlag(actor)?.reason === "authorization_response";
  } catch {
    return false;
  }
}

/** For a screenshot: the page's process assesses the document, and refuses a sign-in result, through the call's gate. */
export function check() {
  return true;
}

/**
 * Throw ZEN_SIGN_IN_PAGE unless agent method `method`, a call of kind
 * `gate`, may run in the actor's document. A sign-in result refuses reads
 * and acts, in its frames too; a device-login page refuses acts.
 *
 * @param {JSWindowActorChild} actor
 * @param {"read"|"act"} gate
 * @param {string} method
 */
export function refuseSignIn(actor, gate, method) {
  const own = assessSignIn(actor);
  const top = topFlag(actor);
  const refuse = (flag, frame) => {
    const { message, data } = signInRefusal(String(method || "this call"), flag, frame);
    throw new ZenError("ZEN_SIGN_IN_PAGE", message, data);
  };
  if (own?.reason === "authorization_response") {
    refuse(own, false);
  }
  if (top?.reason === "authorization_response") {
    refuse(top, true);
  }
  if (gate === "act") {
    if (own?.reason === "device_login") {
      refuse(own, false);
    }
    if (top?.reason === "device_login") {
      refuse(top, true);
    }
  }
}
