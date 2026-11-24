// The sign-in rules in a page's process (content/signin.sys.mjs has the
// rules). Each document is assessed once: at DOMWindowCreated in a task's
// documents, before any script runs, or, for a document from before the task
// or one restored from the back-forward cache, at the first agent call or
// when the guards install. An agent call into a sign-in page is refused
// here, in the page's process, at its entry and again before its result
// goes out, so a call can't read a page that the check let through.
// Microsoft's work and school consent prompt shares its addresses with the
// sign-in page, so a document on that host is checked again once it is
// parsed, from its own settings; an act waits for that check.
//
// Only a task's documents load this module: the Zenius actor imports it
// lazily (I4).

import {
  SIGN_IN_DOCS_KEY,
  TEST_PAGES_KEY,
  configShowsConsent,
  consentByConfig,
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

/**
 * The consent checks that wait for their document to be parsed: Document to
 * a promise that settles once the check has run.
 *
 * @type {WeakMap<Document, Promise<void>>}
 */
const configChecks = new WeakMap();

/** The tests' extra pages ({device, consent, consentConfig}), which the parent publishes on dev profiles only. */
function testPages() {
  try {
    const pages = Services.cpmm.sharedData.get(TEST_PAGES_KEY);
    const list = key => (Array.isArray(pages?.[key]) ? pages[key] : []);
    return { device: list("device"), consent: list("consent"), consentConfig: list("consentConfig") };
  } catch {
    return { device: [], consent: [], consentConfig: [] };
  }
}

function report(actor, flag) {
  try {
    actor.sendAsyncMessage("signIn", flag);
  } catch {
    // The document is going away with its actor.
  }
}

/** The inline script that sets a Microsoft sign-in page's settings, or "". */
function settingsOf(doc) {
  for (const script of doc.scripts) {
    if (!script.src && script.text.includes("$Config=")) {
      return script.text;
    }
  }
  return "";
}

/** Check a parsed document's own settings: a consent prompt gets its flag now. */
function checkConfig(actor, doc, label) {
  let consent = false;
  try {
    consent = configShowsConsent(settingsOf(doc));
  } catch (e) {
    console.error("[zenius] reading a sign-in page's settings failed", e);
  }
  if (consent && !assessed.get(doc)) {
    const flag = { reason: "consent", page: label };
    assessed.set(doc, flag);
    report(actor, flag);
  }
}

/**
 * Check `doc` (on a host whose consent prompt only its page tells apart)
 * once it is parsed: now if it is, else at its DOMContentLoaded, which an
 * act waits for (pendingSignIn).
 */
function watchConfig(actor, doc, label) {
  if (doc.readyState !== "loading") {
    checkConfig(actor, doc, label);
    return;
  }
  const win = doc.defaultView;
  if (!win) {
    return;
  }
  const opts = { capture: true, mozSystemGroup: true };
  configChecks.set(
    doc,
    new Promise(resolve => {
      const onParsed = event => {
        if (event.target !== doc) {
          return;
        }
        win.removeEventListener("DOMContentLoaded", onParsed, opts);
        configChecks.delete(doc);
        checkConfig(actor, doc, label);
        resolve();
      };
      win.addEventListener("DOMContentLoaded", onParsed, opts);
    })
  );
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
  let byConfig = null;
  try {
    const pages = testPages();
    flag = signInPageOf(url ?? doc.documentURIObject, doc.referrer, pages);
    byConfig = flag ? null : consentByConfig(url ?? doc.documentURIObject, pages.consentConfig);
  } catch (e) {
    console.error("[zenius] assessing a document for the sign-in rules failed", e);
  }
  assessed.set(doc, flag);
  if (flag) {
    report(actor, flag);
  } else if (byConfig) {
    watchConfig(actor, doc, byConfig);
  }
  return assessed.get(doc);
}

/**
 * A promise while the actor's document waits to be parsed for its consent
 * check, else undefined. An act on such a document waits for it, so the
 * agent's call can't land on the prompt before the check has seen it.
 *
 * @param {JSWindowActorChild} actor
 * @returns {Promise<void>|undefined}
 */
export function pendingSignIn(actor) {
  let doc = null;
  try {
    doc = actor.document;
  } catch {}
  if (!doc) {
    return undefined;
  }
  if (!assessed.has(doc)) {
    assessSignIn(actor);
  }
  return configChecks.get(doc);
}

/**
 * For the parent's page gate before an act on a page that only its
 * settings tell apart: wait for the document's check, then give its flag
 * and which document it is.
 *
 * @returns {Promise<{flag: {reason: string, page: string}|null, innerWindowId: number}>}
 */
export async function settle(actor) {
  const pending = pendingSignIn(actor);
  if (pending) {
    await pending;
  }
  let innerWindowId = 0;
  try {
    innerWindowId = actor.manager.innerWindowId;
  } catch {}
  return { flag: assessSignIn(actor), innerWindowId };
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
 * and acts, in its frames too; a device-login page and a consent screen
 * refuse acts.
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
    if (own?.reason === "device_login" || own?.reason === "consent") {
      refuse(own, false);
    }
    if (top?.reason === "device_login" || top?.reason === "consent") {
      refuse(top, true);
    }
  }
}
