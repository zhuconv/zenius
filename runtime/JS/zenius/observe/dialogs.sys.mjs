// JavaScript dialogs in agent tabs (zen-observe).
//
// alert, confirm, prompt and beforeunload reach the parent as "Prompt:Open"
// in PromptParent, which would open the tab-modal SubDialog, fire
// DOMWillOpenModalDialog (which can select the tab) and move keyboard focus
// into the dialog. For a tab the agent drives we answer that message
// ourselves: no UI is created, and the page stays blocked in its dialog
// until the agent accepts or dismisses it.
//
// Firefox's own questions about what a page did come the same way, as a
// confirmEx no page can open: whether to send a form from a secure page over
// an insecure connection, or to send a form again on a reload. In a tab the
// agent drives, they're answered Cancel at once and the agent is told
// (`browserConfirmation`): an agent doesn't answer the browser's security
// questions, and left to Firefox the dialog would wait unseen in a hidden
// tab, holding the agent's action (zen-snapshot, 2026-11-20).
//
// Other owners: watchDialogs(browser) gives an action's receipt its `dialog`
// (docs/SPI.md, "Navigation and observation").

import { pushEvent } from "chrome://userscripts/content/zenius/observe/events.sys.mjs";
import { reportRefused } from "chrome://userscripts/content/zenius/observe/refusals.sys.mjs";
import { cut, STRING_TEXT } from "chrome://userscripts/content/zenius/observe/textcap.sys.mjs";
import { notWebContent } from "chrome://userscripts/content/zenius/observe/webcontent.sys.mjs";
import { isBrowserVisible } from "chrome://userscripts/content/zenius/ui/visibility.sys.mjs";

const { PromptParent } = ChromeUtils.importESModule("resource:///actors/PromptParent.sys.mjs");

/**
 * Ego's dialog object.
 *
 * @typedef {object} DialogInfo
 * @property {"alert"|"confirm"|"prompt"|"beforeunload"} type
 * @property {string} message
 * @property {string} [defaultPrompt]  prompt() only
 * @property {string} url              the document that opened it
 */

/**
 * @typedef {object} OpenDialog
 * @property {DialogInfo} info
 * @property {object} args       PromptParent's arguments; the reply is this object
 * @property {(args: object) => void} resolve
 * @property {object} manager    the opener's WindowGlobalParent
 * @property {object} actor      the PromptParent that received it
 * @property {object} message    its Prompt:Open message, to hand to Firefox's UI
 * @property {number} openedAt
 */

/** @type {Map<number, OpenDialog>} browserId → the dialog it shows */
const open = new Map();
/** @type {Set<{browserId: number, notify: (d: DialogInfo) => void}>} */
const watchers = new Set();
/** @type {Set<(browser: Element, info: DialogInfo) => void>} */
const openListeners = new Set();

const TYPES = {
  alert: "alert",
  alertCheck: "alert",
  confirm: "confirm",
  confirmCheck: "confirm",
  prompt: "prompt",
};

let intercepts = _browser => false;
let originalReceive = null;

function dialogType(args) {
  if (args.promptType === "confirmEx") {
    return args.inPermitUnload ? "beforeunload" : null;
  }
  return TYPES[args.promptType] ?? null;
}

/**
 * Take over content dialogs for browsers where `intercept(browser)` is true.
 * Idempotent.
 */
export function installDialogs({ intercept }) {
  intercepts = intercept;
  if (originalReceive) {
    return;
  }
  originalReceive = PromptParent.prototype.receiveMessage;
  PromptParent.prototype.receiveMessage = function (message) {
    if (message.name === "Prompt:Open") {
      const reply = takeOver(this, message);
      if (reply) {
        return reply;
      }
    }
    return originalReceive.call(this, message);
  };
}

/** Our answer to Prompt:Open, or null to let Firefox show the dialog. */
function takeOver(actor, message) {
  const args = message.data;
  let browser;
  try {
    browser = actor.browsingContext?.top?.embedderElement;
  } catch {
    return null;
  }
  if (browser && args?.promptType === "confirmEx" && !args.inPermitUnload && intercepts(browser)) {
    return Promise.resolve(cancelBrowserQuestion(browser, actor, args));
  }
  const type = args ? dialogType(args) : null;
  if (!browser || !type || !intercepts(browser)) {
    return null;
  }
  // I5: the dialog of a document that isn't web content (an add-on's frame,
  // such as a password manager's menu) is never the agent's: no event, no
  // answer. If the user is looking at the tab, Firefox shows it to them as
  // in any tab; otherwise it's dismissed unseen (confirm false, prompt null).
  let foreign = true;
  try {
    foreign = !actor.manager || !!notWebContent(actor.manager);
  } catch {}
  if (foreign) {
    return isBrowserVisible(browser) ? null : Promise.resolve(answerArgs(args, type, false));
  }
  const browserId = browser.browserId;
  if (open.has(browserId)) {
    // A second dialog while one is open (another frame): Chromium shows one
    // at a time too. Dismiss the newcomer.
    return Promise.resolve(answerArgs(args, type, false));
  }
  const info = {
    type,
    // Chromium reports no text for beforeunload; Gecko passes its own.
    message: type === "beforeunload" ? "" : String(args.text ?? ""),
    url: actor.manager?.documentURI?.spec ?? browser.currentURI?.spec ?? "",
  };
  if (type === "prompt") {
    info.defaultPrompt = String(args.value ?? "");
  }
  pushEvent(browserId, "Page.javascriptDialogOpening", {
    url: info.url,
    message: info.message,
    type: info.type,
    hasBrowserHandler: false,
    ...(type === "prompt" ? { defaultPrompt: info.defaultPrompt } : {}),
  });
  return new Promise(resolve => {
    open.set(browserId, { info, args, resolve, manager: actor.manager, actor, message, openedAt: Date.now() });
    for (const w of watchers) {
      if (w.browserId === browserId) {
        w.notify(info);
      }
    }
    for (const fn of openListeners) {
      try {
        fn(browser, info);
      } catch (e) {
        console.error("[zenius] dialog listener failed", e);
      }
    }
  });
}

/**
 * Firefox asks about something the page did (a confirmEx, which no page can
 * open): answer it as a closed dialog, Cancel, and tell the agent in
 * Firefox's own words, so it reads right in any language.
 */
function cancelBrowserQuestion(browser, actor, args) {
  const said = cut(String(args.text ?? "").replace(/\s+/g, " ").trim(), STRING_TEXT);
  const buttons = [args.button0Label, args.button1Label, args.button2Label].filter(b => typeof b === "string" && b).join(" / ");
  let url = "";
  try {
    url = actor.manager?.documentURI?.spec ?? "";
  } catch {}
  reportRefused(
    browser,
    "browserConfirmation",
    `Firefox asked to confirm what the page did: "${said}"${buttons ? ` (${buttons})` : ""}. An agent doesn't answer the browser's own questions, so zenius answered Cancel, and what the page tried didn't happen. If the task needs it, tell the user: they can do it in their own tab.`,
    url || undefined
  );
  args.ok = false;
  args.buttonNumClicked = 1;
  if ("checked" in args) {
    args.checked = false;
  }
  return args;
}

function answerArgs(args, type, accept, promptText) {
  args.ok = accept;
  if (type === "prompt" && accept && promptText !== undefined) {
    args.value = String(promptText);
  }
  if (type === "beforeunload") {
    // confirmEx: button 0 leaves the page, button 1 stays.
    args.buttonNumClicked = accept ? 0 : 1;
  }
  if ("checked" in args) {
    args.checked = false;
  }
  return args;
}

/** The dialog the tab shows, or null. */
export function currentDialog(browser) {
  const browserId = browser?.browserId;
  const d = browserId ? open.get(browserId) : null;
  if (!d) {
    return null;
  }
  // The opener's document went away (tab closed, process crashed).
  if (!d.manager || d.manager.isClosed) {
    open.delete(browserId);
    return null;
  }
  return d.info;
}

/**
 * Accept or dismiss the tab's dialog. Returns false when none is open.
 *
 * @param {Element} browser
 * @param {boolean} accept
 * @param {string} [promptText] prompt() only; omitted keeps its default value
 */
export function answerDialog(browser, accept, promptText) {
  if (!currentDialog(browser)) {
    return false;
  }
  const d = open.get(browser.browserId);
  open.delete(browser.browserId);
  const args = answerArgs(d.args, d.info.type, accept, promptText);
  pushEvent(browser.browserId, "Page.javascriptDialogClosed", {
    result: accept,
    userInput: d.info.type === "prompt" && accept ? String(args.value ?? "") : "",
  });
  d.resolve(args);
  return true;
}

/**
 * Watch a tab for a dialog that opens while an action runs.
 *
 *   const w = watchDialogs(browser);
 *   try {
 *     await Promise.race([doTheAction(), w.opened]);
 *   } finally {
 *     const dialog = w.stop(); // DialogInfo or null
 *   }
 *
 * `opened` resolves with the first dialog that opens after the call. An
 * action whose content call opened a dialog stays blocked in it until the
 * agent answers, so race the call against `opened` instead of awaiting it.
 */
export function watchDialogs(browser) {
  let seen = null;
  let resolveOpened;
  const opened = new Promise(resolve => (resolveOpened = resolve));
  const watcher = {
    browserId: browser.browserId,
    notify(info) {
      if (!seen) {
        seen = info;
        resolveOpened(info);
      }
    },
  };
  watchers.add(watcher);
  return {
    opened,
    stop() {
      watchers.delete(watcher);
      return seen;
    },
  };
}

/** `fn(browser, info)` whenever a dialog opens in a tab we intercept for. */
export function onDialogOpened(fn) {
  openListeners.add(fn);
  return () => openListeners.delete(fn);
}

/**
 * Hand the open dialog to Firefox's own prompt UI, for a user who takes over
 * the tab (zen-ux): they answer it there, and the agent no longer sees it.
 * Firefox flags the tab for attention; a beforeunload prompt also selects
 * its tab. Returns false when no dialog is open.
 */
export function releaseDialog(browser) {
  const d = open.get(browser.browserId);
  if (!d) {
    return false;
  }
  open.delete(browser.browserId);
  const dismiss = () => d.resolve(answerArgs(d.args, d.info.type, false));
  if (d.manager?.isClosed) {
    dismiss();
    return false;
  }
  let reply;
  try {
    reply = originalReceive.call(d.actor, d.message);
  } catch (e) {
    console.error("[zenius] releasing a dialog failed", e);
    dismiss();
    return false;
  }
  Promise.resolve(reply).then(
    args => {
      pushEvent(browser.browserId, "Page.javascriptDialogClosed", {
        result: !!args?.ok,
        userInput: d.info.type === "prompt" && args?.ok ? String(args.value ?? "") : "",
      });
      d.resolve(args);
    },
    () => dismiss()
  );
  return true;
}
