// Content side of navigation and observation (zen-observe): load states,
// page geometry and waitForSelector, in the page's process. Called through
// the Zenius actor.
// Portions adapted from citrolabs/ego-lite (MIT License).

import { watchConsole } from "chrome://userscripts/content/zenius/content/console.sys.mjs";
import { elementsIn, diagnostics } from "chrome://userscripts/content/zenius/content/resolve.sys.mjs";
import { resolveRef } from "chrome://userscripts/content/zenius/content/snapshot/registry.sys.mjs";
import { watchHidden, isStale } from "chrome://userscripts/content/zenius/content/evaluate.sys.mjs";
import { inSignInResult } from "chrome://userscripts/content/zenius/content/signinguard.sys.mjs";

/** A document's title for the agent: a sign-in result's is "", since a page that shows the code may show it there too. */
function titleOf(actor, doc) {
  return inSignInResult(actor.manager) ? "" : (doc?.title ?? "");
}

const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

// Every navigation calls into this module early, so console capture starts
// with the process's first agent page.
watchConsole();

/**
 * Has the document reached `state`?
 *
 * "load" is readyState "complete": Gecko sets it and dispatches the load
 * event in one task, so a call that sees "complete" runs after the page's
 * load handlers. DOMContentLoaded is different: readyState turns
 * "interactive" before deferred scripts run, and the event comes later, so
 * read the navigation timing instead, as Ego does.
 */
function reached(win, state) {
  const doc = win.document;
  if (doc.readyState === "complete") {
    return true;
  }
  if (state !== "domcontentloaded" || doc.readyState === "loading") {
    return false;
  }
  try {
    return win.performance.timing.domContentLoadedEventEnd > 0;
  } catch {
    return true;
  }
}

/**
 * Resolve once the document reaches `state` ("domcontentloaded" or "load"),
 * event-driven, or at `timeoutMs`. Returns `{reached, readyState}`.
 */
export function waitForReadyState(actor, { state = "load", timeoutMs = 10000 } = {}) {
  const win = actor.contentWindow;
  if (isStale(actor)) {
    return { reached: false, readyState: null, navigated: true };
  }
  if (reached(win, state)) {
    return { reached: true, readyState: win.document.readyState };
  }
  const doc = win.document;
  const hidden = watchHidden(actor);
  return new Promise(resolve => {
    const opts = { mozSystemGroup: true };
    const check = () => {
      if (reached(win, state)) {
        finish(true);
      }
    };
    const finish = (ok, navigated = false) => {
      clearTimeout(timer);
      hidden.stop();
      doc.removeEventListener("readystatechange", check, opts);
      doc.removeEventListener("DOMContentLoaded", check, opts);
      win.removeEventListener("load", check, opts);
      resolve({ reached: ok, readyState: doc.readyState, ...(navigated ? { navigated } : {}) });
    };
    // A document replaced before its load state (bfcache keeps it alive):
    // the parent waits on the frame's next document.
    hidden.promise.then(() => finish(false, true));
    doc.addEventListener("readystatechange", check, opts);
    // DOMContentLoaded's timing end is set after its listeners run.
    doc.addEventListener("DOMContentLoaded", () => setTimeout(check, 0), opts);
    win.addEventListener("load", check, opts);
    const timer = setTimeout(() => finish(reached(win, state)), Math.max(0, timeoutMs));
  });
}

/**
 * Resolve once the parser has made the document element and handled the
 * chunk it came in (one task later), or at `timeoutMs`. goto's "commit"
 * waits for this: see navigate() in methods/navigation.sys.mjs.
 */
export function firstChunk(actor, { timeoutMs = 1000 } = {}) {
  const doc = actor.document;
  const settle = resolve => setTimeout(() => resolve({ ok: true }), 0);
  if (!doc || doc.documentElement) {
    return new Promise(settle);
  }
  return new Promise(resolve => {
    const observer = {
      observe(subject) {
        if (subject === doc) {
          finish();
          settle(resolve);
        }
      },
    };
    const finish = () => {
      clearTimeout(timer);
      Services.obs.removeObserver(observer, "document-element-inserted");
    };
    const timer = setTimeout(() => {
      finish();
      resolve({ ok: false });
    }, Math.max(0, timeoutMs));
    Services.obs.addObserver(observer, "document-element-inserted");
  });
}

/** The document's readyState, URL and title, in one round trip. */
/**
 * The NSS error behind a certificate warning (about:certerror), such as
 * SEC_ERROR_UNKNOWN_ISSUER; null on any other page. Only page.goto asks, to
 * say why it failed: the agent never acts in this document (I5).
 */
export function certificateError(actor) {
  const doc = actor.contentWindow?.document;
  if (!doc?.documentURI?.startsWith("about:certerror")) {
    return null;
  }
  try {
    return doc.getFailedCertSecurityInfo()?.errorCodeString || null;
  } catch {
    return null;
  }
}

export function documentState(actor) {
  const doc = actor.document;
  return { readyState: doc?.readyState ?? null, url: doc?.URL ?? null, title: titleOf(actor, doc) };
}

/**
 * Ego's page.info() fields (innerWidth/Height, scroll offsets and the
 * documentElement's scroll size, in CSS pixels), plus what screenshots need.
 */
export function metrics(actor) {
  const win = actor.contentWindow;
  const doc = win.document;
  const root = doc.documentElement;
  return {
    url: win.location.href,
    title: titleOf(actor, doc),
    w: win.innerWidth,
    h: win.innerHeight,
    sx: win.scrollX,
    sy: win.scrollY,
    pw: root?.scrollWidth ?? 0,
    ph: root?.scrollHeight ?? 0,
    dpr: win.devicePixelRatio,
  };
}

/**
 * For page.screenshot, which paints over add-on frames (a password manager's
 * menu): where each child frame named by its BrowsingContext id sits in this
 * document's viewport, as the bounds of its "border" box (the add-on's frame
 * itself) or its "content" box (a frame on the way up to the top: where its
 * own viewport is). With this document's viewport size and scroll offsets,
 * which map a child's coordinates into its parent's.
 *
 * `aligned` is false when a transform rotates, skews or flips the box: the
 * parent then covers that frame's whole box.
 *
 * @param {object} actor
 * @param {{border?: number[], content?: number[]}} args
 */
export function frameBoxes(actor, { border = [], content = [] } = {}) {
  const win = actor.contentWindow;
  const doc = actor.document;
  const measure = (id, box) => {
    let el = null;
    try {
      el = BrowsingContext.get(id)?.embedderElement ?? null;
    } catch {}
    if (!el || el.ownerDocument !== doc) {
      return { id, box, missing: true };
    }
    const quads = el.getBoxQuads({ box });
    if (!quads.length) {
      return { id, box, hidden: true };
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let aligned = true;
    for (const q of quads) {
      for (const p of [q.p1, q.p2, q.p3, q.p4]) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      aligned &&=
        q.p1.y === q.p2.y && q.p2.x === q.p3.x && q.p3.y === q.p4.y && q.p4.x === q.p1.x && q.p1.x <= q.p2.x && q.p1.y <= q.p4.y;
    }
    return { id, box, x: x0, y: y0, w: x1 - x0, h: y1 - y0, aligned };
  };
  return {
    vw: win.innerWidth,
    vh: win.innerHeight,
    sx: win.scrollX,
    sy: win.scrollY,
    frames: [...border.map(id => measure(id, "border")), ...content.map(id => measure(id, "content"))],
  };
}

// ---------------------------------------------------------------------------
// waitForSelector

/** Ego's VISIBILITY_FUNCTION for waitForSelector states (Gecko has checkVisibility). */
function isVisible(el) {
  return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
}

function stateHolds(el, state) {
  switch (state) {
    case "attached":
      return !!el;
    case "detached":
      return !el;
    case "hidden":
      return !el || !isVisible(el);
    default:
      return !!el && isVisible(el);
  }
}

/**
 * One look for page.waitForSelector's target in this document; the parent
 * polls the page's frames with it, main frame first. `target` is zen-input's
 * parsed target (content/resolve.sys.mjs), so waits and actions read a
 * selector the same way. `count` is how many elements match here (0 or 1
 * for a ref); `holds` says whether `state` holds for the first match (with
 * none, it holds for "detached" and "hidden"). `diag` (Ego's ambiguity
 * diagnostics) comes with matches that could make a locator ambiguous.
 *
 * @returns {{count: number, holds: boolean, diag?: object} | {navigated: true}}
 */
export function probeSelector(actor, { target, ref, state = "visible", top = true }) {
  if (isStale(actor)) {
    return { navigated: true };
  }
  if (ref) {
    let el = null;
    try {
      el = resolveRef(actor, ref);
    } catch (e) {
      // A ref whose node went away counts as detached.
      if (e?.code !== "ZEN_REF_STALE") {
        throw e;
      }
    }
    return { count: el ? 1 : 0, holds: stateHolds(el, state) };
  }
  const elements = elementsIn(actor.document, target);
  const reply = { count: elements.length, holds: stateHolds(elements[0] ?? null, state) };
  // A locator is ambiguous with several matches here, or with matches in
  // more than one frame; the main frame's single match needs none.
  if (target.kind === "locator" && (elements.length > 1 || (!top && elements.length === 1))) {
    reply.diag = diagnostics(elements);
  }
  return reply;
}
