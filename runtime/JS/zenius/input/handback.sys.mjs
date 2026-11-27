// Password fields, card details and one-time codes the user filled while
// holding an agent tab are cleared before the agent gets the tab back
// (the input layer, hooked with the UI, which owns hand back). Card details are a card's number, security code and
// expiry; addresses stay, since the user fills them so the agent can go on. A tab the agent
// takes over with pages.adopt gets the same clear before its first call.
//
// The user holds a Space whenever the agent can't run it: the user took
// over, the agent handed off, or the Space is paused. The takeover prompt
// and the panel's Pause keep ownership "agent", but the user types freely.
// When a Space stops being runnable, every frame of its pages records its
// secret fields (content/secrets.sys.mjs). When the Space can run again
// (any return to ownership "agent" and not paused, an unpause included),
// every frame empties the secret fields that changed or appeared since.
// It doesn't matter whether the user typed them or the password manager or
// form autofill filled them. Fields the agent set itself stay. The agent
// hears how many were cleared (a Zenius.passwordsCleared event), never what
// they held. Both messages also reset the autocomplete controller's cached
// results, so the user's first ArrowDown searches afresh and the user's
// results don't outlast their turn.
//
// Ordering: the core's setOwnership and setPaused emit spaceChanged before
// they wake the agent's held calls, and this listener sends each frame its
// message right then (ZeniusService.content sends before it awaits). A
// frame handles its messages in order, so the clear runs before any agent
// call reaches it.
//
// The snapshot has one race. When the user's first key pauses the Space
// (the UI's takeover prompt), the key goes on to the page right after the
// snapshot is sent. Gecko runs input ahead of other messages in a busy
// content process (dom.input_event_queue), so that key can land first: a
// password pasted with Cmd+V would then be in the snapshot and survive. So
// after a key, the snapshot leaves out the focused field of each frame, the
// only field the key can reach. It is cleared on the way back unless it's
// empty, even if the agent had filled it.

import { pushEvent } from "chrome://userscripts/content/zenius/observe/events.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearCodeFlags: "chrome://userscripts/content/zenius/observe/signin.sys.mjs",
});

/** Space id → whether the agent could run it at the last event. */
const runnable = new Map();
let installed = false;
/** For tests: snapshots sent (and how many after a key), and fields cleared. */
const stats = { snapshots: 0, afterKey: 0, cleared: 0, passwords: 0, cards: 0, codes: 0 };

function canRun(rec) {
  return !!rec && !rec.gone && rec.ownership === "agent" && !rec.paused;
}

/** Every frame of each <browser>, with its browser. */
function framesIn(browsers) {
  const out = [];
  for (const browser of browsers) {
    const top = browser?.browsingContext;
    if (!top) {
      continue;
    }
    for (const bc of top.getAllBrowsingContextsInSubtree()) {
      out.push({ browser, bc });
    }
  }
  return out;
}

/** Every frame of every page of the Space, with its tab's browser. */
function framesOf(service, rec) {
  return framesIn(service.pages.list(rec.id).map(page => service.pages.tabFor(page)?.linkedBrowser));
}

/** <browser> → its last clear's total (fields emptied), once its frames answer. */
const lastClears = new WeakMap();

/** The user's key or drop opened the UI's takeover prompt, and so paused the Space. */
function pausedByUserKey(rec) {
  if (rec.ownership !== "agent" || !rec.paused) {
    return false;
  }
  try {
    const { ZeniusUI } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
    return !!ZeniusUI.takeover?.promptState(rec.id)?.typed;
  } catch {
    return true; // Can't tell: assume a key is on its way.
  }
}

function snapshot(service, rec) {
  const args = { skipFocused: pausedByUserKey(rec) };
  stats.snapshots++;
  stats.afterKey += args.skipFocused ? 1 : 0;
  for (const { bc } of framesOf(service, rec)) {
    service.content(bc, "secrets#snapshot", args).catch(() => {});
  }
}

function plural(n, what) {
  return `${n} ${what}${n === 1 ? "" : "s"}`;
}

/**
 * Send every frame its clear now, in this dispatch, and tell each tab's
 * agent what was cleared once the frames answer.
 *
 * @param {Array<{browser: Element, bc: BrowsingContext}>} frames
 * @param {string} why  ends the event's message
 */
function clearFrames(service, frames, why) {
  const byBrowser = new Map();
  // A page a code refusal left read-only (input/codes.sys.mjs) is the
  // agent's again: in the parent at once, and in each frame before the
  // agent's next call reaches it.
  lazy.clearCodeFlags(frames.map(f => f.bc));
  for (const { browser, bc } of frames) {
    service.content(bc, "signinguard#clearCodeMarks", {}).catch(() => {});
    const reply = service.content(bc, "secrets#clearChanged", {}).catch(() => null);
    byBrowser.set(browser, [...(byBrowser.get(browser) ?? []), reply]);
  }
  for (const [browser, replies] of byBrowser) {
    const total = Promise.all(replies).then(results => {
      const sum = kind => results.reduce((n, r) => n + (r?.[kind] ?? 0), 0);
      const passwords = sum("passwords");
      const cards = sum("cards");
      const codes = sum("codes");
      const count = passwords + cards + codes;
      stats.cleared += count;
      stats.passwords += passwords;
      stats.cards += cards;
      stats.codes += codes;
      if (count > 0) {
        const parts = [passwords && plural(passwords, "password field"), cards && plural(cards, "card field"), codes && plural(codes, "one-time code field")].filter(Boolean);
        const what = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
        pushEvent(browser.browserId, "Zenius.passwordsCleared", {
          count,
          passwords,
          cards,
          codes,
          message: `${what} ${why}`,
          url: browser.currentURI?.spec ?? "",
        });
      }
      return count;
    });
    lastClears.set(browser, total);
  }
}

function clear(service, rec) {
  clearFrames(service, framesOf(service, rec), "filled while the user held this tab, cleared before the agent got it back");
}

/** Install once, with the service (its spaceChanged events, pages and content calls). */
export function installHandBackGuard(service) {
  if (installed) {
    return;
  }
  installed = true;
  for (const rec of service.spaces.records()) {
    runnable.set(rec.id, canRun(rec));
  }
  service.addEventListener((event, params) => {
    const id = params?.space;
    if (typeof id !== "number" || (event !== "spaceChanged" && event !== "spaceCreated")) {
      return;
    }
    const rec = service.spaces.peek(id);
    if (!rec || rec.gone) {
      runnable.delete(id);
      return;
    }
    const now = canRun(rec);
    const was = runnable.get(id);
    runnable.set(id, now);
    if (was === undefined || was === now) {
      return;
    }
    try {
      if (now) {
        clear(service, rec);
      } else {
        snapshot(service, rec);
      }
    } catch (e) {
      console.error("[zenius] hand-back guard failed", e);
    }
  });
}

/**
 * The UI's Resume (the card, the panel, an unpause) asks before it hands
 * back: the <browser> of each page of the Space with a frame whose current
 * document holds secret fields the clear would empty, those that changed or
 * appeared since the snapshot. The UI reloads those (the core's cleanLoad),
 * so no page state keeps the secret, then hands back, and the clear runs as
 * usual on whatever is left. A document that came after the snapshot (a
 * two-step login's password page) counts with every secret field holding a
 * value. A page that moved on after the user typed (a submitted login) holds
 * nothing of it, and isn't named. Asking changes nothing, and never says
 * what a field holds.
 *
 * @param {object} service  ZeniusService
 * @param {object} rec  the Space's record
 * @returns {Promise<Element[]>}
 */
export function typedSecrets(service, rec) {
  return typedSecretsIn(service, service.pages.list(rec.id).map(page => service.pages.tabFor(page)?.linkedBrowser));
}

/**
 * A finished task's kept tabs, for a reply in its Work chat that may hand
 * them back (service.resumeFinishedTask): every frame records its secret
 * fields now, as at any hold's start. The finish's own snapshot finds no
 * pages: endTask has dropped them by its spaceChanged.
 *
 * @param {object} service  ZeniusService
 * @param {Element[]} browsers
 */
export function snapshotKept(service, browsers) {
  stats.snapshots++;
  for (const { bc } of framesIn(browsers)) {
    service.content(bc, "secrets#snapshot", { skipFocused: false }).catch(() => {});
  }
}

/**
 * typedSecrets for the given tabs: those with a frame whose secret fields
 * changed or appeared since the snapshot.
 *
 * @param {object} service  ZeniusService
 * @param {Element[]} browsers
 * @returns {Promise<Element[]>}
 */
export async function typedSecretsIn(service, browsers) {
  const pages = new Map();
  for (const { browser, bc } of framesIn(browsers)) {
    const reply = service.content(bc, "secrets#changedSince", {}).catch(() => null);
    pages.set(browser, [...(pages.get(browser) ?? []), reply]);
  }
  const named = [];
  for (const [browser, replies] of pages) {
    if ((await Promise.all(replies)).some(r => r?.changed > 0)) {
      named.push(browser);
    }
  }
  return named;
}

/**
 * How many secret fields the last clear in this tab emptied, once its
 * frames answer; 0 when none ran.
 *
 * @param {Element} browser
 * @returns {Promise<number>}
 */
export function lastClearOf(browser) {
  return lastClears.get(browser) ?? Promise.resolve(0);
}

/**
 * A tab the agent takes with pages.adopt (the core's glue): empty every
 * secret field holding a value the agent didn't set, before its first call.
 * The messages are sent before this returns, so they reach each frame
 * ahead of any call on the new page.
 *
 * @param {Element} browser
 */
export function clearAdopted(browser) {
  const top = browser?.browsingContext;
  if (!top) {
    return;
  }
  try {
    const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");
    const frames = top.getAllBrowsingContextsInSubtree().map(bc => ({ browser, bc }));
    clearFrames(ZeniusService, frames, "held values the agent didn't set, cleared when it took this tab");
  } catch (e) {
    console.error("[zenius] clearing an adopted tab failed", e);
  }
}

/** The UI's onSecretTyped hooks. */
const secretHooks = new Set();
/** Documents already reported, by their WindowGlobalParent. */
const secretTypedDocs = new WeakSet();

/**
 * The UI: `fn({browser})` when the user's own input first changes a secret
 * field (a password, a card's number, expiry or code, a one-time code: what
 * Resume clears) in a document of a task's tab, once per document, frames
 * included. Their typing, paste, drop and IME count, and so does their
 * autofill (the password manager, card autofill). zenius's own input and a
 * page's script never do. It fires whoever holds the Space: the UI keeps
 * what it needs for the hold card.
 *
 * @param {(e: {browser: Element}) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onSecretTyped(fn) {
  secretHooks.add(fn);
  return () => secretHooks.delete(fn);
}

/**
 * The typing watch's word (content/typing.sys.mjs, through the ZeniusInput
 * actor): the user's input changed a secret field of `wgp`'s document.
 *
 * @param {WindowGlobalParent} wgp
 */
export function noteSecretTyped(wgp) {
  if (!wgp || wgp.isClosed || secretTypedDocs.has(wgp)) {
    return;
  }
  const browser = wgp.browsingContext?.top?.embedderElement;
  if (!browser) {
    return;
  }
  secretTypedDocs.add(wgp);
  for (const fn of [...secretHooks]) {
    try {
      fn({ browser });
    } catch (e) {
      console.error("[zenius] an onSecretTyped hook failed", e);
    }
  }
}

/** For tests: snapshots sent (and how many after a key), and fields cleared. */
export function handBackStats() {
  return { ...stats };
}
