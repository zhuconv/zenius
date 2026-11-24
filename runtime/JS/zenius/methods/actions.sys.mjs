// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Page actions (zen-input): click, dblclick, hover, dragAndDrop, fill,
// selectOption, focus, press, setInputFiles, page.mouse, page.keyboard,
// filechooser.setFiles (and filechooser.wait for page.waitForEvent).
//
// The parent keeps what outlives one call: the per-connection input state
// (pointer position, pressed buttons, held keys), the Space's private
// clipboard, the retry loop with its deadline, the search across frames in
// other processes, the agent cursor, and the receipt (popups, dialog, file
// chooser). Content (content/actions.sys.mjs) resolves, checks, scrolls and
// dispatches in the target frame's own process, normally in one call.
// Semantics, defaults and messages follow Ego Lite. content/input.sys.mjs
// has the input mechanisms, and why each.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import {
  isModifier,
  keyDefinition,
  keyText,
  resolveKeyName,
  splitChord,
  hasKey,
} from "chrome://userscripts/content/zenius/content/keys.sys.mjs";
import { decide, parseTarget, subjectOf } from "chrome://userscripts/content/zenius/content/resolve.sys.mjs";
import {
  cancelChooser,
  cancelledChooserBrowser,
  cancelUndrivenChoosers,
  chooserInfo,
  guardChoosers,
  installFileChoosers,
  isWaiting,
  checkChooserFiles,
  claimFolderChooser,
  dropUploadFolder,
  filesFromPayloads,
  folderPlan,
  setChooserFiles,
  setChooserFolder,
  writeUploadFiles,
  writeUploadFolder,
} from "chrome://userscripts/content/zenius/input/filechooser.sys.mjs";
import { hostedOrigin, SpaceClipboard } from "chrome://userscripts/content/zenius/clipboard/store.sys.mjs";
import { installAutofillGuards } from "chrome://userscripts/content/zenius/input/autofill.sys.mjs";
import { installCaptureGuards } from "chrome://userscripts/content/zenius/input/capture.sys.mjs";
import { installHandBackGuard } from "chrome://userscripts/content/zenius/input/handback.sys.mjs";
import { installPickerGuards } from "chrome://userscripts/content/zenius/input/pickers.sys.mjs";
import { moveCursor } from "chrome://userscripts/content/zenius/ui/cursor.sys.mjs";
import { notePage } from "chrome://userscripts/content/zenius/ui/pages.sys.mjs";
import { isTabVisible } from "chrome://userscripts/content/zenius/ui/visibility.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  checkAgentLoad: "chrome://userscripts/content/zenius/observe/webcontent.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  URILoadingHelper: "resource:///modules/URILoadingHelper.sys.mjs",
  Refs: "chrome://userscripts/content/zenius/snapshot/refs.sys.mjs",
  currentDialog: "chrome://userscripts/content/zenius/observe/dialogs.sys.mjs",
  dialogOpened: "chrome://userscripts/content/zenius/observe/messages.sys.mjs",
  networkQuietMs: "chrome://userscripts/content/zenius/observe/network.sys.mjs",
  noteAgentCode: "chrome://userscripts/content/zenius/observe/agentcode.sys.mjs",
  noteWritten: "chrome://userscripts/content/zenius/observe/agentworld.sys.mjs",
  noteWrittenDocument: "chrome://userscripts/content/zenius/observe/agentworld.sys.mjs",
  watchDialogs: "chrome://userscripts/content/zenius/observe/dialogs.sys.mjs",
  watchRefusals: "chrome://userscripts/content/zenius/observe/refusals.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

// openLinkIn's referrer for a link that has none.
const ReferrerInfo = Components.Constructor("@mozilla.org/referrer-info;1", "nsIReferrerInfo", "init");

export const IS_MAC = Services.appinfo.OS === "Darwin";

// Ego's defaults and timings (page-model.ts:619-661).
const DEFAULT_ACTION_TIMEOUT_MS = 3000;
const RETRY_INTERVAL_MS = 50;
const MISSING_TARGET_IDLE_MS = 500;
const FILE_CHOOSER_OPEN_WAIT_MS = 1000;
const FILE_CHOOSER_SETTLE_MS = 50;
const MOUSE_BUTTONS = new Set(["left", "middle", "right"]);
// How long past its deadline a content call may stay in the page before the
// method stops waiting for it (contentCall). Generous: a page's own handler
// may still be running the input, and an error then invites a repeat.
const STUCK_PAST_DEADLINE_MS = 5000;
// What a key step may take in the page, for the keyboard's deadline.
const KEY_STEP_MS = 50;

const sleep = ms => new Promise(r => lazy.setTimeout(r, ms));

function invalid(message) {
  return new ZenError("ZEN_INVALID_ARGUMENT", message);
}

/** Key-name and chord errors come from keys.sys.mjs as TypeErrors. */
function asInvalid(e) {
  return e instanceof TypeError ? invalid(e.message) : e;
}

// ---------------------------------------------------------------------------
// Per-connection input state

class InputState {
  x = 0;
  y = 0;
  /** @type {Set<string>} pressed mouse buttons */
  buttons = new Set();
  /** @type {Set<string>} held modifiers: Alt, Control, Meta, Shift */
  mods = new Set();
  /** @type {Set<string>} held key codes */
  codes = new Set();
  /** Browsing context id that got the mousedown, while a button is held. */
  mouseFrame = null;
}

const internalStates = new Map();

/** Ego scopes input state to the script, so ours lives on the connection. */
export function inputState(ctx, rp) {
  const store = ctx.conn?.state ? (ctx.conn.state.zenInput ??= new Map()) : internalStates;
  const key = `${rp.space.id}/${rp.page.label}`;
  let st = store.get(key);
  if (!st) {
    st = new InputState();
    store.set(key, st);
  }
  return st;
}

// The Space's clipboard: agent copy, cut and paste never touch the system
// clipboard, which is the user's (manager decision 2026-11-19). zen-ux's
// store, shared with the page guards: a page's own "Copy" button and these
// chords use the same clipboard.
function clipboardOf(space) {
  return SpaceClipboard.read(space.id);
}

/**
 * The Space's clipboard for the agent's keys in `rp`'s page. Text only in a
 * page where zenius runs none of the agent's code (closed groups): html
 * pasted there can run as script, which is why page.keyboard.paste refuses
 * it there.
 */
function clipboardFor(ctx, rp) {
  const data = clipboardOf(rp.space);
  if (typeof data?.["text/html"] !== "string" || !ctx.pages.codeRefusal(rp.space, rp.page)) {
    return data;
  }
  const text = { ...data };
  delete text["text/html"];
  return text;
}

/**
 * The agent's input pasted html into `bc`'s document, page.keyboard's or the
 * Space clipboard's. The page got it sanitized (content/input.sys.mjs), and
 * it still counts as the agent's code there, as page.evaluate does, and as
 * written, as the agent's world's writes do (zen-observe's flags), until
 * written retires once every defense reads the evidence flag. Evidence comes
 * from content only when the markup carries something hooked
 * (content/actions.sys.mjs): the typing guard then holds the
 * user's first press there and has the page reloaded clean (zen-core's
 * cleanOnDemand).
 */
function markPastedHtml(rp, bc) {
  lazy.noteAgentCode(rp.space, bc);
  const id = bc.currentWindowGlobal?.innerWindowId;
  if (id) {
    lazy.noteWritten(bc, [id]);
  }
}

/** markPastedHtml for each document a key call pasted html into. */
function notePastedHtml(rp, result) {
  for (const id of new Set(result?.htmlPastedIn ?? [])) {
    const bc = BrowsingContext.get(id);
    if (bc) {
      markPastedHtml(rp, bc);
    }
  }
}

function noteClipboard(rp, result) {
  if (result?.clipboard) {
    // zen-ux's glue: pages read it only from the origin it was copied on,
    // as long as the call's process hosts that origin in the tab.
    const bc = (result.bcId && BrowsingContext.get(result.bcId)) || rp.browsingContext;
    SpaceClipboard.write(rp.space.id, result.clipboard, hostedOrigin(bc, result.clipboardOrigin));
  }
}

// ---------------------------------------------------------------------------
// Content calls

/**
 * Call content/actions.sys.mjs#fn in `bc`, following `forward` replies to the
 * out-of-process frame that should do the work.
 *
 * The content side ends its call by the deadline (`until`), unless the page
 * can't return. A busy script can hold it, and so can a browser prompt's
 * nested event loop that no watcher reports, such as Firefox's warning
 * before a secure page posts a form over http (zen-snapshot's find): the
 * click waited in it for good, whatever its timeout. So the method stops
 * waiting STUCK_PAST_DEADLINE_MS past the deadline.
 *
 * @param {{until?: number, method?: string}} [opts] the deadline (epoch ms;
 *   default `args.deadline`) and the method's name for the error
 */
export async function contentCall(ctx, bc, fn, args, { until = args?.deadline, method = args?.action ?? fn } = {}) {
  let target = bc;
  let callArgs = args;
  for (let hops = 0; hops < 16; hops++) {
    const r = await unlessStuck(ctx.content(target, `actions#${fn}`, callArgs), until, target, method);
    if (!r?.forward) {
      return r;
    }
    const next = BrowsingContext.get(r.forward.bcId);
    if (!next) {
      throw new ZenError("ZEN_PAGE_UNRESPONSIVE", "the frame went away", { reason: "context_destroyed" });
    }
    target = next;
    callArgs = { ...callArgs, ...r.forward.args };
  }
  throw new ZenError("ZEN_INTERNAL", "too many frame hops");
}

/** `call`'s result, unless it's still pending STUCK_PAST_DEADLINE_MS past `until`. */
async function unlessStuck(call, until, bc, method) {
  if (!Number.isFinite(until)) {
    return call;
  }
  const start = Date.now();
  let timer;
  const stuck = new Promise(resolve => {
    timer = lazy.setTimeout(resolve, Math.max(0, until + STUCK_PAST_DEADLINE_MS - start));
  });
  let settled;
  try {
    settled = await Promise.race([call.then(value => ({ value })), stuck.then(() => null)]);
  } finally {
    lazy.clearTimeout(timer);
  }
  if (settled) {
    return settled.value;
  }
  // It may still settle once the page is back; nobody waits for it then.
  call.catch(() => {});
  let prompt = false;
  try {
    // Only a box the tab already has: asking for one would create it.
    prompt = !!bc.top.embedderElement?.tabDialogBox?.getTabDialogManager().hasDialogs;
  } catch {}
  const why = prompt
    ? "a browser prompt is open in its tab, which the agent can't see or answer"
    : "its script may be busy, or a browser prompt may be open in its tab";
  return Promise.reject(
    new ZenError(
      "ZEN_PAGE_UNRESPONSIVE",
      `${method}: the page hasn't returned from the input after ${Date.now() - start}ms, past the call's deadline: ${why}. ` +
        "The input may still take effect, so look at the page before you repeat it, or hand the task to the user.",
      { reason: "input_stuck", prompt, mayHaveLateEffects: true }
    )
  );
}

/**
 * Bring every out-of-process frame owner between the page and `bc` into
 * view, outermost first; returns `bc`'s process-top offset in the page, or
 * null when a dialog cut the scrolling short (the action ends there).
 * `measure` only measures (NO_FRAME_VIEW): an offset it can't take is NaN,
 * so a point shifted by it shows no cursor (noteCursor).
 */
async function frameOffset(ctx, top, bc, action, deadline, measure = false) {
  const chain = [];
  for (let c = bc; c && c !== top && c.parent; c = c.parent) {
    const pid = c.currentWindowGlobal?.osPid;
    const ppid = c.parent.currentWindowGlobal?.osPid;
    if (pid !== ppid) {
      chain.unshift(c);
    }
  }
  let x = 0;
  let y = 0;
  for (const child of chain) {
    const r = await ctx.content(child.parent, "actions#frameOwnerIntoView", { childBcId: child.id, action, deadline, measure });
    if (r?.dialog) {
      return null;
    }
    if (!r?.origin) {
      return { x: NaN, y: NaN };
    }
    x += r.origin.x;
    y += r.origin.y;
  }
  return { x, y };
}

/** Add an out-of-process frame's offset to a point from its process. */
function shift(point, offset) {
  return point ? { x: point.x + offset.x, y: point.y + offset.y } : null;
}

// ---------------------------------------------------------------------------
// Receipts: popups, dialogs, file choosers

/**
 * Run `fn` as Ego's action boundary: collect popups the page opens, return
 * as soon as a JavaScript dialog opens (it blocks the page's script, and the
 * content call with it, until the agent answers), and for guarded actions
 * turn a file chooser nobody waited for into ZEN_FILE_CHOOSER_OPENED.
 *
 * Once a dialog opened the action is over, as Ego's is: `hints.ended` tells
 * fn's loops to start nothing more (no retry, no next phase), and content
 * sends none of the gesture's later steps (content/actions.sys.mjs,
 * "dialogs").
 *
 * @param {(hints: {fileInputClicked?: boolean, ended?: string}) => Promise<any>} fn
 * @returns {Promise<{receipt: object, value: any}>}
 */
export async function observed(ctx, rp, fn, { guardChooser = false } = {}) {
  const popups = ctx.watchPopups(rp.space.id, rp.page.label);
  const guard = guardChooser && !isWaiting(rp.browser) ? guardChoosers(rp.browser) : null;
  const dialogs = lazy.watchDialogs(rp.browser);
  // What zenius refused on the way (zen-observe's glue): print, HTTP sign-in.
  const refusals = lazy.watchRefusals(rp.browser);
  const hints = {};
  let value;
  let dialog = null;
  try {
    const run = fn(hints);
    // A call blocked behind a dialog settles when the agent answers it.
    run.catch(() => {});
    const raced = await Promise.race([run.then(v => ({ v })), dialogs.opened.then(() => ({ d: true }))]);
    if (!raced.d) {
      value = raced.v;
      await syncRoundTrip(ctx, rp, hints.bcId);
      if (guard && !guard.opened) {
        const wait = hints.fileInputClicked ? FILE_CHOOSER_OPEN_WAIT_MS : hints.fileInputClicked === false ? 0 : FILE_CHOOSER_SETTLE_MS;
        for (const end = Date.now() + wait; !guard.opened && Date.now() < end; ) {
          await sleep(10);
        }
      }
    }
  } catch (e) {
    if (!guard?.opened) {
      dialog = dialogs.stop();
      if (!dialog) {
        throw e;
      }
    }
  } finally {
    dialog ??= dialogs.stop();
    guard?.stop();
    refusals.stop();
  }
  if (dialog) {
    hints.ended = "dialog";
  }
  const opened = popups.stop();
  const refused = refusals.stop();
  if (dialog) {
    return { receipt: { dialog: dialogShape(dialog), ...(refused.length ? { refused } : {}) }, value };
  }
  if (guard?.opened) {
    throw new ZenError(
      "ZEN_FILE_CHOOSER_OPENED",
      "This action opened a file chooser, which was cancelled before the system dialog appeared. Use page.setInputFiles() for an existing file input, or call page.waitForFileChooser() before the action when the input is created dynamically."
    );
  }
  const receipt = {};
  if (opened.length) {
    receipt.popups = opened.map(({ label, targetId }) => ({ label, targetId }));
  }
  if (refused.length) {
    receipt.refused = refused;
  }
  return { receipt, value };
}

/**
 * Ego's sync round trip after an action: a popup it started (a link's
 * navigation runs as a task after the click) reaches the parent before the
 * reply, so the popup watcher has seen it.
 */
async function syncRoundTrip(ctx, rp, bcId) {
  const bcs = new Set([rp.browsingContext]);
  const bc = bcId && BrowsingContext.get(bcId);
  if (bc) {
    bcs.add(bc);
  }
  await Promise.all([...bcs].map(b => ctx.content(b, "actions#ping", {}, { timeout: 1000 }).catch(() => {})));
}

/** Ego's dialog object: {type, message, defaultPrompt?, url}. */
function dialogShape(d) {
  const out = { type: d.type, message: d.message ?? "" };
  if (d.defaultPrompt !== undefined && d.defaultPrompt !== null) {
    out.defaultPrompt = d.defaultPrompt;
  }
  if (d.url !== undefined) {
    out.url = d.url;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cursor

/**
 * Before a pointer action dispatches in a tab someone can see, fly the cursor
 * there, then pass zen-core's control gate (the user may have clicked during
 * the flight). Returns the ms the gate held, which don't count against the
 * action's timeout.
 */
async function cursorThenGate(ctx, rp, point, kind, options) {
  await moveCursor(rp.tab, point, { label: options?.label, kind });
  // zen-core's ctx.gate (SPI "Held calls"); absent in older runtimes.
  return (await ctx.gate?.()) ?? 0;
}

/** Record where an action ended for a tab nobody sees (about 6 µs). */
function noteCursor(rp, point, kind, options) {
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    moveCursor(rp.tab, point, { label: options?.label, kind }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Element actions

const LEVELS = {
  "page.click": o => (o.force === true ? "enabled" : "pointer-enabled"),
  "page.dblclick": o => (o.force === true ? "enabled" : "pointer-enabled"),
  "page.hover": o => (o.force === true ? "visible" : "pointer"),
  "page.fill": () => "enabled",
  "page.focus": () => "enabled",
  "page.press": () => "enabled",
  "page.selectOption": () => "enabled",
  "page.setInputFiles": () => null,
};
const CURSOR_KIND = {
  "page.click": "click",
  "page.dblclick": "dblclick",
  "page.hover": "hover",
  "page.fill": "type",
  "page.focus": "focus",
  "page.press": "type",
  "page.selectOption": "select",
  "page.setInputFiles": "select",
};
// Ego's label for a click or a dblclick that names none
// (driver/page-actions.ts:289). Other actions leave the label shown.
const CURSOR_LABEL = { "page.click": "Clicking element", "page.dblclick": "Clicking element" };
/** `options`, with the method's own label if it names none. */
function withLabel(method, options) {
  return options?.label === undefined && CURSOR_LABEL[method] ? { ...options, label: CURSOR_LABEL[method] } : options;
}
// Pointer actions fly the cursor before they dispatch when the tab is on screen.
const POINTER = new Set(["page.click", "page.dblclick", "page.hover"]);
/**
 * Actions Ego performs on the element as it is, wherever its frame sits:
 * no frame owner has to be visible, and none is scrolled to
 * (Ego's setInputFilesInPage and selectOptionInPage).
 * Their frames are still measured, for the cursor.
 */
const NO_FRAME_VIEW = new Set(["page.setInputFiles", "page.selectOption"]);
const GUARDED = new Set(["page.click", "page.dblclick", "page.press"]);

function isTransient(e) {
  return e?.data?.transient === true;
}

/** Where the target lives: a ref's own frame, or the page (main document first). */
function refLocation(rp, parsed) {
  if (!/^[1-9]\d*$/.test(parsed.id)) {
    throw new ZenError("ZEN_REF_NOT_FOUND", `Unknown ref: ${parsed.id}; take a new snapshot`);
  }
  // Throws ZEN_REF_STALE for a ref whose document is gone, bfcached or not.
  const r = lazy.Refs.resolve(rp.browser, Number(parsed.id));
  return {
    bc: r.browsingContext,
    args: { ref: { refId: r.refId, innerWindowId: r.innerWindowId, localId: r.localId } },
    refId: r.refId,
  };
}

/**
 * Counts in out-of-process frames, spliced into the page's context list in
 * frame-tree order, for Ego's main-first choice.
 */
async function expandFrames(ctx, list, target, level) {
  const out = [];
  for (const entry of list) {
    if (!entry.remote) {
      out.push(entry);
      continue;
    }
    const bc = BrowsingContext.get(entry.remote);
    if (!bc?.currentWindowGlobal) {
      continue;
    }
    try {
      const r = await ctx.content(bc, "actions#count", { target, level });
      out.push(...(await expandFrames(ctx, r.frames, target, level)));
    } catch (e) {
      if (e?.code === "ZEN_INVALID_ARGUMENT") {
        throw e;
      }
      // A frame that is gone or not ready counts as no match, this attempt.
    }
  }
  return out;
}

/**
 * One attempt: resolve, check, scroll and act. Returns the content result
 * with `point` in the page's top-level viewport px.
 */
async function attempt(ctx, rp, method, parsed, base, state) {
  let where = parsed.kind === "ref" ? refLocation(rp, parsed) : { bc: rp.browsingContext, args: { target: base.target } };
  let offset = { x: 0, y: 0 };
  if (where.bc !== rp.browsingContext) {
    offset = await frameOffset(ctx, rp.browsingContext, where.bc, method, base.deadline, NO_FRAME_VIEW.has(method));
    if (!offset) {
      return { dialog: true };
    }
  }
  const visible = POINTER.has(method) && isTabVisible(rp.tab);
  const call = async extra => {
    let r;
    try {
      r = await contentCall(ctx, where.bc, base.fn ?? "act", { ...base, ...where.args, ...extra });
    } catch (e) {
      if (e?.code === "ZEN_REF_STALE" && where.refId) {
        lazy.Refs.markStale(rp.browser, where.refId);
      }
      throw e;
    }
    if (!r?.frames) {
      return r;
    }
    const list = await expandFrames(ctx, r.frames, base.target, base.level);
    const { bcId } = decide(parseTarget(base.target), list, base.level);
    where = { bc: BrowsingContext.get(bcId), args: { target: base.target, only: true } };
    if (!where.bc) {
      throw new ZenError("ZEN_SELECTOR_NOT_FOUND", `${subjectOf(parsed)} matched 0 elements`, { matches: 0, transient: true });
    }
    offset = await frameOffset(ctx, rp.browsingContext, where.bc, method, base.deadline, NO_FRAME_VIEW.has(method));
    if (!offset || state.hints?.ended) {
      return { dialog: true };
    }
    return contentCall(ctx, where.bc, base.fn ?? "act", { ...base, ...where.args, ...extra });
  };
  if (!visible) {
    const r = await call({ phase: "all" });
    if (r?.dialog) {
      return r;
    }
    return { ...r, point: shift(r.point, offset), from: shift(r.from, offset), bcId: where.bc.id };
  }
  const token = `${Date.now()}-${Math.random()}`;
  const prepared = await call({ phase: "prepare", token });
  if (prepared?.dialog || state.hints?.ended) {
    return { dialog: true };
  }
  const point = shift(prepared.point, offset);
  state.held += await cursorThenGate(ctx, rp, point, CURSOR_KIND[method], withLabel(method, base.options));
  // A dialog (a page timer's) opened during the cursor's flight: perform nothing.
  if (state.hints?.ended) {
    return { dialog: true };
  }
  const r = await contentCall(ctx, where.bc, base.fn ?? "act", { ...base, ...where.args, phase: "perform", token });
  return { ...r, point, cursorShown: true, bcId: where.bc.id };
}

/**
 * Open the links an agent's middle click hit as new pages of its task,
 * in the background, with what Firefox's ClickHandlerParent gives a user's
 * (the frame's principals, the link's referrer and policy container). Its
 * openerBrowser makes the wrapped addTab adopt each tab into the task as a
 * popup, so the receipt lists it, as Ego's does (receipt.popups). Only what
 * page.goto may load opens: never a mail client or a local file.
 *
 * It does what openLinkIn does for a tab, but for one thing: openLinkIn
 * raises its window first (w.focus(), even for a background tab), which
 * brings Zen in front of the app the user is in (I1). So the
 * same window, the same principals and the same addTab, and no focus.
 *
 * @param {object} rp the resolved page
 * @param {{bcId?: number, openLinks?: {href: string, referrerInfo: string, policyContainer: string|null}[]}} r the content call's result
 */
function openMiddleClickedLinks(rp, r) {
  if (!r?.openLinks?.length) {
    return;
  }
  const wgp = BrowsingContext.get(r.bcId)?.currentWindowGlobal ?? rp.browser.browsingContext?.currentWindowGlobal;
  const from = rp.browser.ownerDocument?.defaultView;
  // openLinkIn's window for a tab: this one, unless it's a popup window.
  const win = from && lazy.URILoadingHelper.getTargetWindow(from, { skipPopups: true, skipTaskbarTabs: true });
  if (!wgp || !win?.gBrowser) {
    return;
  }
  const principal = wgp.documentPrincipal;
  const userContextId = principal?.originAttributes?.userContextId || undefined;
  // openLinkIn's updatePrincipals: the target window's private browsing and
  // container for a content principal.
  const withOA = p =>
    p?.isContentPrincipal
      ? Services.scriptSecurityManager.principalWithOA(p, {
          userContextId,
          privateBrowsingId: lazy.PrivateBrowsingUtils.isWindowPrivate(win) ? 1 : 0,
          firstPartyDomain: p.originAttributes.firstPartyDomain,
        })
      : p;
  for (const link of r.openLinks) {
    try {
      lazy.checkAgentLoad(Services.io.newURI(link.href), "page.click");
    } catch {
      continue;
    }
    win.gBrowser.addTab(link.href, {
      referrerInfo: lazy.E10SUtils.deserializeReferrerInfo(link.referrerInfo) ?? new ReferrerInfo(Ci.nsIReferrerInfo.EMPTY, true, null),
      charset: rp.browser.characterSet,
      // Never the user's view: the tab joins the task's Space, unselected.
      inBackground: true,
      userContextId,
      originPrincipal: withOA(principal),
      originStoragePrincipal: withOA(wgp.documentStoragePrincipal),
      triggeringPrincipal: withOA(principal),
      allowInheritPrincipal: true,
      triggeringRemoteType: wgp.domProcess?.remoteType,
      policyContainer: link.policyContainer ? lazy.E10SUtils.deserializePolicyContainer(link.policyContainer) : null,
      focusUrlBar: false,
      openerBrowser: rp.browser,
      hasValidUserGestureActivation: true,
    });
  }
}

/**
 * Ego's element-action runner: retry transient failures every 50 ms until
 * the deadline, fail fast when nothing matches on an idle page, then report
 * `<action> timed out after <n>ms: <last error>`.
 */
async function runElementAction(ctx, params, method, extra = {}) {
  const rp = ctx.resolvePage(params);
  const options = params.options ?? {};
  validateCommon(method, options);
  const parsed = parseTarget(params.target ?? extra.target);
  const level = LEVELS[method](options);
  const st = inputState(ctx, rp);
  const start = Date.now();
  const state = { held: 0 };
  const timeout = options.timeout ?? DEFAULT_ACTION_TIMEOUT_MS;
  const base = {
    action: method,
    target: params.target ?? extra.target,
    level,
    options,
    mods: [...st.mods],
    isMac: IS_MAC,
    guardChooser: GUARDED.has(method),
    ...extra,
  };
  const { receipt, value } = await observed(
    ctx,
    rp,
    async hints => {
      state.hints = hints;
      for (;;) {
        if (hints.ended) {
          return null;
        }
        base.deadline = start + timeout + state.held;
        try {
          const r = await attempt(ctx, rp, method, parsed, base, state);
          // What the action found, for the task's step (input/steps.sys.mjs).
          ctx.step = { target: r?.step };
          // Here, not after the receipt: a dialog may end that first.
          notePastedHtml(rp, r);
          hints.fileInputClicked = r?.fileInputClicked;
          hints.bcId = r?.bcId;
          openMiddleClickedLinks(rp, r);
          return r;
        } catch (e) {
          // The receipt went out at the dialog; nothing after it counts.
          if (hints.ended) {
            return null;
          }
          if (!isTransient(e)) {
            throw e;
          }
          const now = Date.now();
          if (/matched 0 elements/.test(e.message) && now - start >= MISSING_TARGET_IDLE_MS) {
            const idleMs = await idleFor(ctx, rp);
            if (idleMs >= MISSING_TARGET_IDLE_MS) {
              throw new ZenError(
                "ZEN_SELECTOR_NOT_FOUND",
                `${method} failed: ${e.message}. The page has been idle for ${idleMs}ms with no DOM changes and no network requests in flight, so the target is not about to appear. Check the selector against a fresh snapshot, or use page.waitForSelector() when the element is expected later.`,
                { matches: 0, idleMs }
              );
            }
          }
          if (now >= base.deadline) {
            throw new ZenError(e.code, `${method} timed out after ${now - start}ms: ${e.message}`, {
              ...e.data,
              transient: undefined,
              timeoutMs: timeout,
            });
          }
          await sleep(Math.min(RETRY_INTERVAL_MS, base.deadline - now));
        }
      }
    },
    { guardChooser: GUARDED.has(method) }
  );
  noteClipboard(rp, value);
  if (value?.save) {
    savePage(rp.browser);
  }
  if (value && !value.cursorShown) {
    noteCursor(rp, value.point, CURSOR_KIND[method], withLabel(method, options));
  }
  return { receipt, value };
}

/** How long the page has been idle (DOM and network), 0 if busy or unknown. */
async function idleFor(ctx, rp) {
  // The tab's whole network, cross-site frames included, as Ego counts it
  // (page-model.ts:3004-3010): a request in flight, or one that started or
  // ended within the idle time, holds the fail-fast off. The content probe
  // sees only the top document's requests in flight when it looks, which a
  // page polling every 300 ms almost never has.
  const netQuietMs = lazy.networkQuietMs(rp.browser.browserId);
  if (netQuietMs < MISSING_TARGET_IDLE_MS) {
    return 0;
  }
  try {
    const r = await ctx.content(rp.browsingContext, "actions#idleProbe", {}, { timeout: 1000 });
    return Math.min(r?.idleMs ?? 0, netQuietMs);
  } catch {
    return 0;
  }
}

function validateCommon(method, options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalid(`${method} options must be an object`);
  }
  if (options.timeout !== undefined && !(typeof options.timeout === "number" && Number.isFinite(options.timeout) && options.timeout > 0)) {
    throw invalid("timeout must be a positive number of milliseconds");
  }
  if (options.delay !== undefined && !(typeof options.delay === "number" && Number.isFinite(options.delay) && options.delay >= 0)) {
    throw invalid(`${method} delay must be non-negative`);
  }
  if (options.button !== undefined && !MOUSE_BUTTONS.has(options.button)) {
    throw invalid(`${method} button must be one of left, middle, right`);
  }
  if (options.clickCount !== undefined && !(Number.isInteger(options.clickCount) && options.clickCount > 0)) {
    throw invalid(`${method} clickCount must be a positive integer`);
  }
  if (options.force !== undefined && typeof options.force !== "boolean") {
    throw invalid(`${method} force must be boolean`);
  }
  if (options.label !== undefined && !(typeof options.label === "string" && options.label.length > 0)) {
    throw invalid(`${method} label must be a non-empty string`);
  }
  for (const key of ["position", "sourcePosition", "targetPosition"]) {
    const p = options[key];
    if (p !== undefined && !(p && typeof p === "object" && Object.keys(p).length === 2 && Number.isFinite(p.x) && Number.isFinite(p.y))) {
      throw invalid(`${method} ${key} must be point`);
    }
  }
}

function assertSelector(target) {
  if (typeof target !== "string" || target.trim().length === 0) {
    throw invalid("Page actions require a non-empty selector string");
  }
}

// ---------------------------------------------------------------------------
// Keyboard

function plainDef(def) {
  return { key: def.key, code: def.code, keyCode: def.keyCodeWithoutLocation, location: def.location };
}

/** A key down/up step; updates `st` the way Ego's #down/#up do. */
function keyStep(st, phase, input) {
  const name = resolveKeyName(input, IS_MAC);
  const def = keyDefinition(name, st.mods.has("Shift"));
  if (phase === "down") {
    const repeat = st.codes.has(def.code);
    st.codes.add(def.code);
    if (isModifier(def.key)) {
      st.mods.add(def.key);
    }
    return { k: "down", def: plainDef(def), mods: [...st.mods], text: keyText(def, st.mods), repeat };
  }
  if (isModifier(def.key)) {
    st.mods.delete(def.key);
  }
  st.codes.delete(def.code);
  return { k: "up", def: plainDef(def), mods: [...st.mods] };
}

/**
 * Steps for a chord: keys down in order, optional delay, keys up in reverse.
 * A bad token still releases what was pressed, then throws (as Ego does).
 */
function chordSteps(st, chord, delay, operation) {
  let tokens;
  try {
    tokens = splitChord(chord, operation);
  } catch (e) {
    throw asInvalid(e);
  }
  const steps = [];
  const pressed = [];
  let error;
  for (const token of tokens) {
    try {
      steps.push(keyStep(st, "down", token));
      pressed.push(token);
    } catch (e) {
      error = asInvalid(e);
      break;
    }
  }
  if (!error && delay > 0) {
    steps.push({ k: "sleep", ms: delay });
  }
  for (const token of pressed.reverse()) {
    steps.push(keyStep(st, "up", token));
  }
  return { steps, error };
}

function typeSteps(st, text, delay) {
  const steps = [];
  for (const character of text) {
    if (hasKey(character)) {
      steps.push(keyStep(st, "down", character));
      if (delay > 0) {
        steps.push({ k: "sleep", ms: delay });
      }
      steps.push(keyStep(st, "up", character));
    } else {
      if (delay > 0) {
        steps.push({ k: "sleep", ms: delay });
      }
      steps.push({ k: "insert", text: character });
    }
  }
  return steps;
}

function delayOf(options, operation) {
  const delay = options?.delay;
  if (delay === undefined || delay === null) {
    return 0;
  }
  if (!Number.isFinite(delay) || delay < 0) {
    throw invalid(`${operation} delay must be non-negative`);
  }
  return delay;
}

/** Run keyboard steps in the focused frame of the page. */
async function runKeys(ctx, rp, steps, extra = {}, method = "page.keyboard") {
  const sleeps = steps.reduce((ms, s) => ms + (s.k === "sleep" ? s.ms : 0), 0);
  const r = await contentCall(
    ctx,
    rp.browsingContext,
    "keyboard",
    {
      steps,
      isMac: IS_MAC,
      clipboard: clipboardFor(ctx, rp),
      ...extra,
    },
    { until: Date.now() + DEFAULT_ACTION_TIMEOUT_MS + sleeps + steps.length * KEY_STEP_MS, method }
  );
  notePastedHtml(rp, r);
  noteClipboard(rp, r);
  if (r?.save) {
    savePage(rp.browser);
  }
  // No cursor for keys: still make this the page the Space opens on.
  notePage(rp.tab);
  return r;
}

/**
 * What Firefox's chrome does for Accel+S that the page didn't cancel,
 * limited to pdf.js: it saves the PDF (contentAreaUtils' saveBrowser), and
 * zen-observe makes that an agent download. Other pages would get Save Page
 * As, which agents don't get.
 */
function savePage(browser) {
  if (browser.contentPrincipal?.spec === "resource://pdf.js/web/viewer.html") {
    browser.sendMessageToActor("PDFJS:Save", {}, "PdfJs");
  }
}

/** A copy of the keyboard state: press() releases what it pressed, so its net effect is nil. */
function scratchState(st) {
  const copy = new InputState();
  copy.mods = new Set(st.mods);
  copy.codes = new Set(st.codes);
  return copy;
}

// Ego's raw input that returns a receipt: these run as actions.
const OBSERVED_RAW_INPUT = new Set(["page.mouse.click", "page.keyboard.press", "page.keyboard.paste"]);

/**
 * While a JavaScript dialog is open, Ego's code drops raw input silently.
 * The raw input that runs as an action fails at once, as every action does
 * here, where Ego's actions wait for the answer. zen-observe's page gate
 * leaves both to us.
 *
 * @returns {boolean} whether to return without sending
 */
function dialogStopsRawInput(rp, method) {
  const dialog = lazy.currentDialog(rp.browser);
  if (dialog && OBSERVED_RAW_INPUT.has(method)) {
    throw lazy.dialogOpened({ method, dialog });
  }
  return !!dialog;
}

/**
 * Raw input ends at a dialog, as Ego's does (page-model.ts:3136-3147): the
 * call returns as soon as one opens, though the page stays blocked in it
 * until the agent answers, and content sends none of the later steps
 * (content/actions.sys.mjs, "dialogs").
 */
async function untilDialog(rp, fn) {
  const dialogs = lazy.watchDialogs(rp.browser);
  try {
    const run = fn();
    // A call blocked behind the dialog settles once the agent answers it.
    run.catch(() => {});
    return await Promise.race([run, dialogs.opened.then(() => ({ dialog: true }))]);
  } finally {
    dialogs.stop();
  }
}

async function keyboard(ctx, params) {
  const rp = ctx.resolvePage(params);
  if (dialogStopsRawInput(rp, `page.keyboard.${params.action}`)) {
    return {};
  }
  const st = inputState(ctx, rp);
  const options = params.options ?? {};
  switch (params.action) {
    case "down":
    case "up": {
      if (typeof params.key !== "string" || !params.key) {
        throw invalid(`page.keyboard.${params.action} requires a non-empty key`);
      }
      let step;
      try {
        step = keyStep(st, params.action, params.key);
      } catch (e) {
        throw asInvalid(e);
      }
      await untilDialog(rp, () => runKeys(ctx, rp, [step], {}, `page.keyboard.${params.action}`));
      return {};
    }
    case "press": {
      const { steps, error } = chordSteps(st, params.key, delayOf(options, "page.keyboard.press"), "page.keyboard.press");
      const { receipt } = await observed(
        ctx,
        rp,
        async hints => {
          const r = await runKeys(ctx, rp, steps, { guardChooser: true }, "page.keyboard.press");
          hints.fileInputClicked = r?.fileInputClicked;
          hints.bcId = r?.bcId;
        },
        { guardChooser: true }
      );
      if (error) {
        throw error;
      }
      return receipt;
    }
    case "type": {
      if (typeof params.text !== "string") {
        throw invalid("page.keyboard.type text must be a string");
      }
      const steps = typeSteps(st, params.text, delayOf(options, "page.keyboard.type"));
      await untilDialog(rp, () => runKeys(ctx, rp, steps, {}, "page.keyboard.type"));
      return {};
    }
    case "insertText": {
      if (typeof params.text !== "string") {
        throw invalid("page.keyboard.insertText text must be a string");
      }
      await untilDialog(rp, () => runKeys(ctx, rp, [{ k: "insert", text: params.text }], {}, "page.keyboard.insertText"));
      return {};
    }
    case "paste": {
      if (typeof params.text !== "string") {
        throw invalid("page.keyboard.paste content.text must be a string");
      }
      if (params.html !== undefined && params.html !== null && typeof params.html !== "string") {
        throw invalid("page.keyboard.paste content.html must be a string");
      }
      const content = { text: params.text, html: params.html ?? null };
      // The agent's html is the agent's code, as page.evaluate's is: a
      // page's paste handler may insert it with innerHTML, where it runs as
      // script. So the document gets zen-observe's mark first, as for
      // page.evaluate.
      if (content.html) {
        // So in a page that shares a window group with a window outside the
        // task, where zenius runs none of the agent's code (closed groups),
        // only text is pasted.
        const refusal = ctx.pages.codeRefusal(rp.space, rp.page);
        if (refusal) {
          // zen-observe's message and data for its methods, so one guide
          // entry covers both.
          throw new ZenError(
            "ZEN_AGENT_CODE_REFUSED",
            "page.keyboard.paste: zenius doesn't run the agent's code in this page: it shares a window group with a window outside the task, which code here could reach. A page's paste handler may run html as script. Paste the text without html instead.",
            { method: "page.keyboard.paste", page: rp.page.label, reason: refusal.reason, windows: refusal.windows }
          );
        }
        lazy.noteAgentCode(rp.space, rp.browsingContext);
        // And it counts as written, as the agent's world's writes do: the
        // page is cleaned before the user types there (zen-observe's glue).
        lazy.noteWrittenDocument(rp.browsingContext);
      }
      // Ego puts the content on the system clipboard around ControlOrMeta+V;
      // ours goes straight to the editor and leaves every clipboard alone.
      const { steps, error } = chordSteps(st, "ControlOrMeta+V", 0, "page.keyboard.paste");
      const { receipt } = await observed(
        ctx,
        rp,
        async hints => {
          const r = await runKeys(ctx, rp, steps, { pasteContent: content, guardChooser: true }, "page.keyboard.paste");
          hints.fileInputClicked = r?.fileInputClicked;
          hints.bcId = r?.bcId;
        },
        { guardChooser: true }
      );
      if (error) {
        throw error;
      }
      return receipt;
    }
    default:
      throw invalid("page.keyboard action must be one of down, up, press, type, insertText, paste");
  }
}

// ---------------------------------------------------------------------------
// Mouse

function buttonOf(options, operation) {
  const button = options?.button ?? "left";
  if (!MOUSE_BUTTONS.has(button)) {
    throw invalid(`${operation} button must be one of left, middle, right`);
  }
  return button;
}

function clickCountOf(options, operation) {
  const n = options?.clickCount ?? 1;
  if (!Number.isInteger(n) || n < 1) {
    throw invalid(`${operation} clickCount must be a positive integer`);
  }
  return n;
}

function pointOf(params, operation) {
  if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
    throw invalid(`${operation} requires finite x and y coordinates`);
  }
  return { x: params.x, y: params.y };
}

/** Mouse steps for a move from the current position, interpolated evenly. */
function moveSteps(st, to, steps) {
  const out = [];
  const from = { x: st.x, y: st.y };
  for (let i = 1; i <= steps; i++) {
    out.push({
      t: "move",
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
      buttons: [...st.buttons],
      mods: [...st.mods],
    });
  }
  st.x = to.x;
  st.y = to.y;
  return out;
}

function buttonStep(st, type, button, clickCount) {
  if (type === "down") {
    st.buttons.add(button);
  } else {
    st.buttons.delete(button);
  }
  return { t: type, x: st.x, y: st.y, button, clickCount, buttons: [...st.buttons], mods: [...st.mods] };
}

/**
 * Dispatch mouse steps at top-level coordinates. While a button is held the
 * frame that got the mousedown keeps getting the events, as with a real
 * pointer.
 */
async function runMouse(ctx, rp, st, steps, extra = {}, method = "page.mouse") {
  const sleeps = steps.reduce((ms, s) => ms + (s.t === "sleep" ? s.ms : 0), 0);
  const r = await contentCall(
    ctx,
    rp.browsingContext,
    "mouse",
    {
      steps,
      captureBcId: st.mouseFrame,
      // How long a press or release may wait for another tab: the user
      // composing text there, or holding the mouse (content/capture.sys.mjs).
      deadline: Date.now() + DEFAULT_ACTION_TIMEOUT_MS + sleeps,
      ...extra,
    },
    { method }
  );
  if (steps.some(s => s.t === "down")) {
    st.mouseFrame = r?.bcId ?? null;
  }
  if (!st.buttons.size) {
    st.mouseFrame = null;
  }
  return r;
}

/**
 * Carry a wheel's scroll on past an out-of-process frame that had nothing
 * left to scroll that way. Gecko's own wheel chains out
 * of such a frame through APZ, which zenius's synthesized one skips. The
 * frame's page heard the wheel; the rest scrolls from the frame's element
 * in the embedding document, and on past that one if it is another
 * process's frame too.
 */
async function chainWheel(ctx, chained) {
  for (let hops = 0; chained?.bcId && hops < 16; hops++) {
    const embedder = BrowsingContext.get(chained.bcId)?.parent;
    if (!embedder?.currentWindowGlobal) {
      return;
    }
    const r = await contentCall(
      ctx,
      embedder,
      "scrollFromFrame",
      { frameBcId: chained.bcId, dx: chained.dx, dy: chained.dy, deadline: Date.now() + DEFAULT_ACTION_TIMEOUT_MS },
      { method: "page.mouse.wheel" }
    );
    chained = r?.chained;
  }
}

/** Fly the cursor first only where someone can see it. */
async function pointerCursor(ctx, rp, point, kind, options) {
  if (isTabVisible(rp.tab)) {
    await cursorThenGate(ctx, rp, point, kind, options);
  } else {
    noteCursor(rp, point, kind, options);
  }
}

async function mouse(ctx, params) {
  const rp = ctx.resolvePage(params);
  if (dialogStopsRawInput(rp, `page.mouse.${params.action}`)) {
    return {};
  }
  const st = inputState(ctx, rp);
  const before = { buttons: [...st.buttons], x: st.x, y: st.y };
  const start = Date.now();
  try {
    return await mouseAction(ctx, rp, st, params);
  } catch (e) {
    const reason = e?.data?.reason;
    if (reason !== "user_composing" && reason !== "mouse_held_elsewhere" && reason !== "user_scrolling") {
      throw e;
    }
    // Another tab held the call back until its deadline: the page's press
    // and pointer are where they were before it, and so is the agent's.
    st.buttons.clear();
    for (const b of before.buttons) {
      st.buttons.add(b);
    }
    st.x = before.x;
    st.y = before.y;
    throw new ZenError(e.code, `page.mouse.${params.action} timed out after ${Date.now() - start}ms: ${e.message}`, {
      ...e.data,
      transient: undefined,
      timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    });
  }
}

async function mouseAction(ctx, rp, st, params) {
  const options = params.options ?? {};
  switch (params.action) {
    case "move": {
      const to = pointOf(params, "page.mouse.move");
      const n = options.steps ?? 1;
      if (!Number.isInteger(n) || n < 1) {
        throw invalid("page.mouse.move steps must be a positive integer");
      }
      await pointerCursor(ctx, rp, to, "move", options);
      const steps = moveSteps(st, to, n);
      await untilDialog(rp, () => runMouse(ctx, rp, st, steps, {}, "page.mouse.move"));
      return {};
    }
    case "down":
    case "up": {
      const op = `page.mouse.${params.action}`;
      const button = buttonOf(options, op);
      const clickCount = clickCountOf(options, op);
      await pointerCursor(ctx, rp, { x: st.x, y: st.y }, params.action, options);
      const step = buttonStep(st, params.action, button, clickCount);
      // A middle release on a link opens it in the task, with no receipt.
      openMiddleClickedLinks(rp, await untilDialog(rp, () => runMouse(ctx, rp, st, [step], {}, op)));
      return {};
    }
    case "click": {
      const op = "page.mouse.click";
      const to = pointOf(params, op);
      const button = buttonOf(options, op);
      const clickCount = clickCountOf(options, op);
      const delay = delayOf(options, op);
      await pointerCursor(ctx, rp, to, "click", options);
      const { receipt } = await observed(
        ctx,
        rp,
        async hints => {
          const steps = moveSteps(st, to, 1);
          // A button the agent already holds can't be pressed again: Ego
          // (Chromium) sends neither its press nor its release, so the page
          // hears only the move and the button stays held.
          const held = st.buttons.has(button);
          for (let cc = 1; !held && cc <= clickCount; cc++) {
            steps.push(buttonStep(st, "down", button, cc));
            if (delay) {
              steps.push({ t: "sleep", ms: delay });
            }
            steps.push(buttonStep(st, "up", button, cc));
            if (delay && cc < clickCount) {
              steps.push({ t: "sleep", ms: delay });
            }
          }
          const r = await runMouse(ctx, rp, st, steps, { guardChooser: true }, op);
          hints.fileInputClicked = r?.fileInputClicked;
          hints.bcId = r?.bcId;
          openMiddleClickedLinks(rp, r);
        },
        { guardChooser: true }
      );
      return receipt;
    }
    case "wheel": {
      const dx = params.dx ?? params.deltaX;
      const dy = params.dy ?? params.deltaY;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        throw invalid("page.mouse.wheel requires finite deltaX and deltaY");
      }
      await pointerCursor(ctx, rp, { x: st.x, y: st.y }, "wheel", options);
      const step = { t: "wheel", x: st.x, y: st.y, dx, dy, mods: [...st.mods] };
      await untilDialog(rp, async () => {
        const r = await runMouse(ctx, rp, st, [step], {}, "page.mouse.wheel");
        await chainWheel(ctx, r?.chained);
        return r;
      });
      return {};
    }
    default:
      throw invalid("page.mouse action must be one of move, down, up, click, wheel");
  }
}

// ---------------------------------------------------------------------------
// selectOption and setInputFiles arguments

function validateChoices(values) {
  const choices = values === null || values === undefined ? [] : Array.isArray(values) ? values : [values];
  choices.forEach((choice, i) => {
    const p = `page.selectOption valueOrValues[${i}]`;
    if (typeof choice === "string") {
      return;
    }
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
      throw invalid(`${p} must be a string or an object with value, label, or index`);
    }
    for (const key of Object.keys(choice)) {
      if (!["value", "label", "index"].includes(key)) {
        throw invalid(`${p} has unknown field "${key}"`);
      }
    }
    if (choice.value === undefined && choice.label === undefined && choice.index === undefined) {
      throw invalid(`${p} must specify value, label, or index`);
    }
    if (choice.value !== undefined && typeof choice.value !== "string") {
      throw invalid(`${p}.value must be a string`);
    }
    if (choice.label !== undefined && typeof choice.label !== "string") {
      throw invalid(`${p}.label must be a string`);
    }
    if (choice.index !== undefined && !(Number.isInteger(choice.index) && choice.index >= 0)) {
      throw invalid(`${p}.index must be a non-negative integer`);
    }
  });
  return choices;
}

// ---------------------------------------------------------------------------
// Methods

function elementMethod(method) {
  return async (ctx, params) => {
    assertSelector(params.target);
    const { receipt } = await runElementAction(ctx, params, method);
    return receipt;
  };
}

// Gate classes: access for the control gate (I3), i5 for the web-content
// gate (I5).
export const access = {
  "page.click": "mutate",
  "page.dblclick": "mutate",
  "page.hover": "mutate",
  "page.focus": "mutate",
  "page.fill": "mutate",
  "page.press": "mutate",
  "page.selectOption": "mutate",
  "page.setInputFiles": "mutate",
  "page.dragAndDrop": "mutate",
  "page.keyboard": "mutate",
  "page.mouse": "mutate",
  "filechooser.setFiles": "mutate",
};

export const i5 = {
  "page.click": "document",
  "page.dblclick": "document",
  "page.hover": "document",
  "page.focus": "document",
  "page.fill": "document",
  "page.press": "document",
  "page.selectOption": "document",
  "page.setInputFiles": "document",
  "page.dragAndDrop": "document",
  "page.keyboard": "document",
  "page.mouse": "document",
  "filechooser.setFiles": "frames",
};

export const methods = {
  "page.click": elementMethod("page.click"),
  "page.dblclick": elementMethod("page.dblclick"),
  "page.hover": elementMethod("page.hover"),
  "page.focus": elementMethod("page.focus"),

  "page.fill": async (ctx, params) => {
    assertSelector(params.target);
    if (typeof params.value !== "string") {
      throw invalid("page.fill value must be a string");
    }
    if (params.options?.clearFirst !== undefined && typeof params.options.clearFirst !== "boolean") {
      throw invalid("page.fill clearFirst must be boolean");
    }
    const { receipt } = await runElementAction(ctx, params, "page.fill", { value: params.value });
    return receipt;
  },

  "page.press": async (ctx, params) => {
    assertSelector(params.target);
    const rp = ctx.resolvePage(params);
    const st = scratchState(inputState(ctx, rp));
    const delay = delayOf(params.options, "page.press");
    const { steps, error } = chordSteps(st, params.chord ?? params.key, delay, "page.keyboard.press");
    const { receipt } = await runElementAction(ctx, params, "page.press", {
      steps,
      clipboard: clipboardFor(ctx, rp),
    });
    if (error) {
      throw error;
    }
    return receipt;
  },

  "page.selectOption": async (ctx, params) => {
    assertSelector(params.target);
    const choices = validateChoices(params.values);
    const { receipt, value } = await runElementAction(ctx, params, "page.selectOption", { choices });
    // Ego's selectOption returns the values, not a receipt, so a dialog its
    // events opened fails it (page-model.ts:2695, outside #runAction).
    if (receipt.dialog) {
      throw lazy.dialogOpened({ method: "page.selectOption", dialog: receipt.dialog, alreadyOpen: false });
    }
    return { selected: value?.selected ?? [] };
  },

  "page.setInputFiles": async (ctx, params) => {
    // Bytes from the client, never a path (SPEC I5). A folder's paths are
    // checked before anything is decoded or written.
    const plan = folderPlan(params.files, "page.setInputFiles");
    const files = filesFromPayloads(params.files, "page.setInputFiles");
    if (!plan) {
      const { receipt } = await runElementAction(ctx, { ...params, options: {} }, "page.setInputFiles", { files });
      return receipt;
    }
    // A folder reaches the page only through the input's own folder chooser,
    // which the content side opens and this answers with the folder written
    // here (claimFolderChooser).
    const { browser } = ctx.resolvePage(params);
    const folder = await writeUploadFolder(browser, files, plan);
    const claim = claimFolderChooser(browser, folder);
    try {
      const { receipt } = await runElementAction(ctx, { ...params, options: {} }, "page.setInputFiles", { folder: folder.path });
      if (!claim.answered) {
        throw new ZenError("ZEN_INTERNAL", "page.setInputFiles: the folder wasn't attached: the input's folder chooser never reached zenius");
      }
      return receipt;
    } catch (e) {
      // Nothing the input holds: it never got the folder, or Firefox's
      // question took it back.
      dropUploadFolder(folder);
      throw e;
    } finally {
      claim.release();
    }
  },

  "page.dragAndDrop": async (ctx, params) => {
    assertSelector(params.source);
    assertSelector(params.target);
    const rp = ctx.resolvePage(params);
    const options = params.options ?? {};
    validateCommon("page.dragAndDrop", options);
    const level = options.force === true ? "visible" : "pointer";
    const src = parseTarget(params.source);
    const dst = parseTarget(params.target);
    const st = inputState(ctx, rp);
    const start = Date.now();
    const timeout = options.timeout ?? DEFAULT_ACTION_TIMEOUT_MS;
    // The ms zen-core's control gate held the drag, which don't count against its timeout.
    let held = 0;
    const { receipt } = await observed(ctx, rp, async hints => {
      for (;;) {
        if (hints.ended) {
          return null;
        }
        const deadline = start + timeout + held;
        // On screen, the cursor flies to the source with the label before the
        // press, and on to the target before the release, as Ego's cursor
        // follows each of its events. Returns the gate's ms.
        const flyToSource = async point => {
          const ms = await cursorThenGate(ctx, rp, point, "drag", options);
          held += ms;
          return ms;
        };
        const flyToTarget = point => moveCursor(rp.tab, point, { label: options.label, kind: "drop" });
        try {
          const refArgs = {};
          let srcBc = null;
          if (src.kind === "ref") {
            const r = refLocation(rp, src);
            refArgs.sourceRef = r.args.ref;
            srcBc = r.bc;
          }
          let dstBc = null;
          if (dst.kind === "ref") {
            const r = refLocation(rp, dst);
            refArgs.targetRef = r.args.ref;
            dstBc = r.bc;
          }
          const mods = [...st.mods];
          // Ends in two frames: Ego's drag in page coordinates
          // (content/actions.sys.mjs's dragAim).
          const across = async (whereSrc, whereDst) => {
            if (!whereSrc || !whereDst) {
              throw new ZenError("ZEN_SELECTOR_NOT_FOUND", "page.dragAndDrop: an end's frame went away", { transient: true });
            }
            const top = rp.browsingContext;
            const aim = async (where, end) => {
              const offset = where === top ? { x: 0, y: 0 } : await frameOffset(ctx, top, where, "page.dragAndDrop", deadline);
              if (!offset || hints.ended) {
                return null;
              }
              const r = await ctx.content(where, "actions#dragAim", { source: params.source, target: params.target, ...refArgs, end, level, options, deadline });
              // `tab`: in the tab's top viewport, as Ego's page coordinates.
              return r.dialog ? null : { point: r.point, tab: shift(r.top, offset) };
            };
            const a = await aim(whereSrc, "source");
            const b = a && (await aim(whereDst, "target"));
            if (!b) {
              return null;
            }
            const visible = isTabVisible(rp.tab);
            const gated = visible ? await flyToSource(a.tab) : 0;
            if (hints.ended) {
              return null;
            }
            // The drop point in the source frame's own viewport.
            const toward = { x: b.tab.x - (a.tab.x - a.point.x), y: b.tab.y - (a.tab.y - a.point.y) };
            const pressed = await ctx.content(whereSrc, "actions#dragPress", { point: a.point, toward, options, mods, deadline: deadline + gated });
            if (pressed.dialog) {
              return null;
            }
            // The press ends in its own frame first, out of the page's sight:
            // while a button is held in a frame, Gecko hands it the mouse
            // events over the documents around it, the release included. As
            // in Ego's run, the release goes where it lands.
            await ctx.content(whereSrc, "actions#dragDone", { point: a.point, options, mods }).catch(e => console.error("[zenius] page.dragAndDrop couldn't release its press", e));
            if (visible) {
              await flyToTarget(b.tab);
            }
            const released = await ctx.content(whereDst, "actions#dragRelease", { point: b.point, options, mods, deadline: deadline + gated });
            if (released.dialog) {
              return null;
            }
            return { r: { from: a.tab, point: b.tab, wheel: false }, offset: { x: 0, y: 0 }, cursorShown: visible };
          };
          const drag = async (where, only) => {
            const offset = where === rp.browsingContext ? { x: 0, y: 0 } : await frameOffset(ctx, rp.browsingContext, where, "page.dragAndDrop", deadline);
            if (!offset || hints.ended) {
              return null;
            }
            const args = { source: params.source, target: params.target, ...refArgs, ...only, level, options, mods, deadline };
            if (!isTabVisible(rp.tab)) {
              return { r: await ctx.content(where, "actions#drag", args), offset };
            }
            // In three phases, for the cursor (content/actions.sys.mjs's drag).
            const token = `${Date.now()}-${Math.random()}`;
            const prepared = await ctx.content(where, "actions#drag", { ...args, phase: "prepare", token });
            if (!prepared?.prepared) {
              return { r: prepared, offset };
            }
            const gated = await flyToSource(shift(prepared.from, offset));
            if (hints.ended) {
              return null;
            }
            const phase = name => ctx.content(where, "actions#drag", { ...args, deadline: deadline + gated, phase: name, token });
            if ((await phase("press"))?.dialog || hints.ended) {
              return null;
            }
            await flyToTarget(shift(prepared.point, offset));
            const r = await phase("release");
            return r?.dialog ? null : { r, offset, cursorShown: true };
          };
          // Each end's frame known: one frame drags there, two drag across.
          const dragAt = async (whereSrc, whereDst, only) => {
            if (whereSrc !== whereDst) {
              return across(whereSrc, whereDst);
            }
            const done = await drag(whereSrc, only);
            if (done?.r.split) {
              return across(BrowsingContext.get(done.r.split.source), BrowsingContext.get(done.r.split.target));
            }
            if (done?.r.frames) {
              throw new ZenError("ZEN_SELECTOR_NOT_FOUND", "page.dragAndDrop: an end moved to another frame", { transient: true });
            }
            return done;
          };
          // A selector end's frame across processes, chosen as for a click.
          const frameOf = async (target, list) => {
            const { bcId } = decide(parseTarget(target), await expandFrames(ctx, list, target, level), level);
            const where = BrowsingContext.get(bcId);
            if (!where) {
              throw new ZenError("ZEN_SELECTOR_NOT_FOUND", `${subjectOf(parseTarget(target))} matched 0 elements`, { matches: 0, transient: true });
            }
            return where;
          };
          let done;
          if (srcBc && dstBc) {
            // Each ref names its own frame.
            done = await dragAt(srcBc, dstBc, {});
          } else if (srcBc || dstBc) {
            // A ref and a selector: the selector is the page's, main document
            // first, as Ego's is, wherever the ref's frame sits.
            const selector = srcBc ? params.target : params.source;
            const { frames } = await ctx.content(rp.browsingContext, "actions#count", { target: selector, level });
            const at = await frameOf(selector, frames);
            done = await dragAt(srcBc ?? at, dstBc ?? at, srcBc ? { onlyTarget: true } : { onlySource: true });
          } else {
            done = await drag(rp.browsingContext, {});
            if (done?.r.split) {
              // Both ends in this process, in two of its frames.
              done = await across(BrowsingContext.get(done.r.split.source), BrowsingContext.get(done.r.split.target));
            } else if (done?.r.frames) {
              // An end the page's process didn't hold: find its frame across
              // processes, as a click does. The other end's frame may be one
              // of this process's (`at`).
              const { frames, at } = done.r;
              const where = {};
              for (const [end, target] of [["source", params.source], ["target", params.target]]) {
                where[end] = frames[end] ? await frameOf(target, frames[end]) : (BrowsingContext.get(at?.[end]) ?? rp.browsingContext);
              }
              done = await dragAt(where.source, where.target, { onlySource: !!frames.source, onlyTarget: !!frames.target });
            }
          }
          if (!done) {
            return null;
          }
          if (!done.cursorShown) {
            noteCursor(rp, shift(done.r.point, done.offset), "drop", options);
          }
          return done.r;
        } catch (e) {
          if (hints.ended) {
            return null;
          }
          if (!isTransient(e)) {
            throw e;
          }
          const now = Date.now();
          if (now >= deadline) {
            throw new ZenError(e.code, `page.dragAndDrop timed out after ${now - start}ms: ${e.message}`, {
              ...e.data,
              transient: undefined,
              timeoutMs: timeout,
            });
          }
          await sleep(Math.min(RETRY_INTERVAL_MS, deadline - now));
        }
      }
    });
    return receipt;
  },

  "page.keyboard": keyboard,
  "page.mouse": mouse,

  "filechooser.setFiles": async (ctx, params) => {
    let browser;
    try {
      ({ browser } = chooserInfo(params.chooser));
    } catch (e) {
      // Cancelled as the user took control: while they hold it, say that.
      const tab = cancelledChooserBrowser(params.chooser);
      const was = tab && ctx.pages.forBrowser(tab);
      if (was) {
        await ctx.gate(was.spaceId);
      }
      throw e;
    }
    // I3: the call names a chooser, not a space, so the dispatcher's control
    // gate hasn't run. Run it for the chooser's page; a tab that isn't one
    // any more gets its chooser back, cancelled.
    const page = ctx.pages.forBrowser(browser);
    if (!page) {
      cancelChooser(params.chooser, "because its tab is no longer one of the agent's pages");
      throw new ZenError(
        "ZEN_PAGE_NOT_FOUND",
        "this file chooser's tab is no longer one of the agent's pages, so the chooser was cancelled",
        { chooser: String(params.chooser) }
      );
    }
    await ctx.gate(page.spaceId);
    // The call names a chooser: its task's step needs the page's (input/steps.sys.mjs).
    ctx.step = { space: page.spaceId, page: page.label };
    // Held through a takeover prompt that kept the agent in control?
    const { bc, multiple } = chooserInfo(params.chooser);
    // Before anything is armed: a refused payload leaves the chooser open
    // for another try. Bytes from the client, never a path (SPEC I5).
    const plan = folderPlan(params.files, "fileChooser.setFiles");
    const sent = filesFromPayloads(params.files, "fileChooser.setFiles");
    if (plan) {
      // A folder chooser's answer: Gecko walks the folder and fires the
      // input's events, as for the user's pick.
      checkChooserFiles(params.chooser, sent.length, true);
      const folder = await writeUploadFolder(browser, sent, plan);
      const rp = ctx.resolvePage({ space: page.spaceId, page: page.label });
      const { receipt } = await observed(ctx, rp, async () => {
        // Armed first: the content side then lets Firefox's folder question
        // through for this folder alone (content/filepicker.sys.mjs).
        const delivered = ctx.content(bc, "actions#awaitFileInput", { expectFiles: true, folder: folder.path });
        delivered.catch(() => {});
        try {
          setChooserFolder(params.chooser, folder, sent.length);
          await delivered;
        } catch (e) {
          dropUploadFolder(folder);
          throw e;
        }
      });
      return receipt.dialog ? { dialog: receipt.dialog } : {};
    }
    // A one-file chooser takes the first, as Chromium's does: Ego's agent
    // gets {} and the page one file.
    const files = multiple ? sent : sent.slice(0, 1);
    checkChooserFiles(params.chooser, files.length);
    const onDisk = await writeUploadFiles(browser, files);
    const rp = ctx.resolvePage({ space: page.spaceId, page: page.label });
    const { receipt } = await observed(ctx, rp, async () => {
      // Armed first: the files reach the page after the parent prepares them
      // on a background thread, behind this message on the same channel.
      const delivered = ctx.content(bc, "actions#awaitFileInput", { expectFiles: files.length > 0 });
      delivered.catch(() => {});
      setChooserFiles(params.chooser, files, onDisk);
      await delivered;
    });
    return receipt.dialog ? { dialog: receipt.dialog } : {};
  },
};

function service() {
  return ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs").ZeniusService;
}

/** True while the agent itself drives this tab (not the user). */
function agentDriven(browser) {
  try {
    return service().isAgentDriven(browser);
  } catch {
    return false;
  }
}

/** True while this tab belongs to an agent task, even one handed to the user. */
function agentTask(browser) {
  try {
    return service().wantsKeepAlive(browser);
  } catch {
    return false;
  }
}

installFileChoosers({ isAgentBrowser: agentDriven });
// A chooser the agent holds goes back when the agent stops driving its tab,
// at once: after a handoff the user's own click must find the input free.
service().addEventListener(event => {
  if (event === "spaceChanged" || event === "spaceFinished" || event === "pageClosed") {
    cancelUndrivenChoosers();
  }
});
installPickerGuards({ isAgentDriven: agentDriven });
installAutofillGuards({ isAgentTask: agentTask, isAgentDriven: agentDriven });
installCaptureGuards();
installHandBackGuard(service());
