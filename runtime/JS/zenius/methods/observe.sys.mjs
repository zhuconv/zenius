// Observation (the observe layer): evaluate, waitForFunction, waitForSelector,
// screenshot, info, events and the JS dialog answers.
// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Semantics follow Ego (page-model.ts, driver/observe.ts).

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";
import { Unserializable } from "chrome://userscripts/content/zenius/modules/serialize.sys.mjs";
import { Refs } from "chrome://userscripts/content/zenius/snapshot/refs.sys.mjs";
import * as Resolve from "chrome://userscripts/content/zenius/content/resolve.sys.mjs";
import { setupObserve } from "chrome://userscripts/content/zenius/observe/setup.sys.mjs";
import { currentDialog, answerDialog, watchDialogs } from "chrome://userscripts/content/zenius/observe/dialogs.sys.mjs";
import { noteAgentCode } from "chrome://userscripts/content/zenius/observe/agentcode.sys.mjs";
import { checkPageCode } from "chrome://userscripts/content/zenius/observe/pagecode.sys.mjs";
import { stopWorldScripts } from "chrome://userscripts/content/zenius/observe/agentworld.sys.mjs";
import { drainEvents } from "chrome://userscripts/content/zenius/observe/events.sys.mjs";
import { trackerFor } from "chrome://userscripts/content/zenius/observe/navtracker.sys.mjs";
import * as msg from "chrome://userscripts/content/zenius/observe/messages.sys.mjs";
import { stoppedError, watchControl } from "chrome://userscripts/content/zenius/observe/control.sys.mjs";
import { checkPaintable, inWebProcess, notWebContent } from "chrome://userscripts/content/zenius/observe/webcontent.sys.mjs";
import { showsSignInResult, signInResultInTab } from "chrome://userscripts/content/zenius/observe/signin.sys.mjs";
import { signInRefusal } from "chrome://userscripts/content/zenius/content/signin.sys.mjs";
import {
  WAIT_TIMEOUT_MS,
  POLL_MS,
  TIMEOUT,
  sleep,
  beforeDeadline,
  timeoutOption,
  responseTimeout,
  unhandledPopups,
  toBase64,
} from "chrome://userscripts/content/zenius/observe/common.sys.mjs";

setupObserve();

// Ego's health probe answers within 250 ms of transport.
const PROBE_MS = 250;
const SELECTOR_STATES = new Set(["attached", "detached", "visible", "hidden"]);

// ---------------------------------------------------------------------------
// Stopping runaway page JavaScript

// The content side ignores a cancel whose epoch isn't newer than the last one
// it saw. The epoch is a WebIDL long (int32), so Date.now() would wrap; start
// far above the navigation epochs Gecko itself uses.
let cancelEpoch = 1_000_000;

// Gecko acts on a stop only when the interrupt it asks for finds the page's
// own code running. One that finds chrome code or a sandbox, such as
// zenius's guards, which a page making frames in a loop spends most of its
// time in, is passed over and left waiting, and no new interrupt is asked
// for. So the stop goes again every RESEND_MS until the page answers, for at
// most RESEND_LIMIT_MS.
const RESEND_MS = 1;
const RESEND_LIMIT_MS = 5000;

/** Per tab, the stops being sent again: whether its page answered. */
const resending = new WeakMap();

/**
 * Stop the script running in the tab's content process right now, through
 * the hang monitor's "navigating away" path. It terminates only script
 * running for this tab; other tabs in the process keep running, and so do
 * timers the page scheduled earlier.
 */
export function stopPageScript(browser) {
  // The agent's world, which Gecko's stop skips, stops at its next check.
  stopWorldScripts(browser);
  return sendStop(browser, ++cancelEpoch);
}

/** One stop for the tab, unless its process is gone. */
function sendStop(browser, epoch) {
  try {
    const remoteTab = browser.frameLoader?.remoteTab;
    if (!remoteTab) {
      return false;
    }
    remoteTab.maybeCancelContentJSExecution(Ci.nsIRemoteTab.NAVIGATE_URL, {
      uri: Services.io.newURI("about:blank"),
      epoch,
    });
    return true;
  } catch {
    // The tab is going away: no stop to send.
    return false;
  }
}

/**
 * stopPageScript, sent again until the tab's page answers (RESEND_MS,
 * RESEND_LIMIT_MS). Then one more stop with epoch 0, which takes the place
 * of any still waiting and is never acted on: a stop left waiting would end
 * whatever script of the page's an interrupt next finds, even on a page the
 * tab shows later, since zenius's epochs are above every navigation's.
 * Resolves to whether the page answered. A tab has one such run at a time.
 */
export function stopUntilAnswered(ctx, browser) {
  let run = resending.get(browser);
  if (!run) {
    run = resendStops(ctx, browser).finally(() => resending.delete(browser));
    resending.set(browser, run);
  }
  return run;
}

async function resendStops(ctx, browser) {
  if (!stopPageScript(browser)) {
    return false;
  }
  // Logged for a run the page never answers: few stops in the time allowed,
  // or a long gap between two, mean the machine was too busy to send them;
  // many mean they all went out and every one missed.
  const t0 = ChromeUtils.now();
  let stops = 1;
  let last = t0;
  let gap = 0;
  let answered = null;
  const asked = answers(ctx, browser.browsingContext, RESEND_LIMIT_MS).then(yes => (answered = yes));
  const end = t0 + RESEND_LIMIT_MS;
  while (answered === null && ChromeUtils.now() < end) {
    await Promise.race([sleep(RESEND_MS), asked]);
    if (answered !== null || !sendStop(browser, ++cancelEpoch)) {
      break;
    }
    const now = ChromeUtils.now();
    gap = Math.max(gap, now - last);
    last = now;
    stops++;
  }
  await asked;
  sendStop(browser, 0);
  const ms = (ChromeUtils.now() - t0).toFixed(1);
  log(`page stop: ${stops} stops in ${ms}ms, the longest gap ${gap.toFixed(1)}ms, ${answered ? "answered" : "no answer"}`);
  return answered;
}

/** Does the page's process answer within `ms`? Ego's Runtime.evaluate("1") probe. */
async function answers(ctx, bc, ms) {
  try {
    await ctx.content(bc, "evaluate#ping", {}, { timeout: ms });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Evaluation

/** The SDK's {fn, isFunction, arg?}, checked; `expression` is Ego's text for messages. */
function evaluateArgs(params, method) {
  if (typeof params.fn !== "string") {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `${method} expects a function or string expression`);
  }
  if (!params.fn.trim()) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `${method} expression must not be empty`);
  }
  const isFunction = params.isFunction !== false;
  const hasArg = Object.hasOwn(params, "arg");
  if (!isFunction && hasArg) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `${method} string expression does not accept an argument`);
  }
  let expression = params.fn;
  if (isFunction) {
    expression = hasArg ? `(${params.fn})(JSON.parse(${JSON.stringify(JSON.stringify(params.arg))}))` : `(${params.fn})()`;
  }
  return { fn: params.fn, isFunction, hasArg, arg: params.arg, expression };
}

/** A page exception as Ego reports it: a plain Error with no code. */
function pageException(exception, expression) {
  return msg.evaluationFailed({ ...exception, expression });
}

/** The reply of evaluate#evaluate as the call's result. */
function decode(reply, args) {
  if (reply.exception) {
    throw pageException(reply.exception, args.expression);
  }
  if ("unserializable" in reply) {
    return new Unserializable(reply.unserializable);
  }
  return reply.value ?? null;
}

/**
 * Chromium's message when a document goes away under an evaluation; Ego
 * passes it on as a plain Error.
 */
function contextDestroyed(e) {
  return e?.data?.reason === "context_destroyed" || e?.data?.reason === "no_window_global";
}

/**
 * Ego's evaluate: the page gets `responseTimeout` to answer and its script
 * is stopped 1 s earlier (Runtime.evaluate's `timeout`), at least 1 s. Past
 * the execution limit the page is probed: a busy page has its script
 * stopped; a page that answers is waiting on a promise and gets the rest of
 * the response timeout. The outcome classes are Ego's (§5.2).
 */
/**
 * Closed groups: the agent's code doesn't run in a page that shares
 * a window group with a window outside its task. The core's
 * pages.codeRefusal answers, and its answer sticks for the page's time in
 * the task. Checked before each run, and before the document is marked.
 * Not asked while the document runs outside a web content process, where
 * I5 refuses the call (inWebProcess): an answer there would stick.
 *
 * @throws {ZenError} ZEN_AGENT_CODE_REFUSED
 */
function refuseAgentCode(ctx, space, page, method, bc) {
  if (!inWebProcess(bc)) {
    return;
  }
  const refusal = ctx.pages.codeRefusal(space, page);
  if (refusal) {
    throw msg.agentCodeRefused(method, page.label, refusal);
  }
}

async function runEvaluation(ctx, target, args, params, apiName) {
  // The user's setting first, before anything makes a world or marks the
  // page (observe/pagecode.sys.mjs).
  checkPageCode({ method: apiName, space: target.space, page: target.page, browser: target.browser, bc: target.browsingContext });
  refuseAgentCode(ctx, target.space, target.page, apiName, target.browsingContext);
  const transportMs = responseTimeout(params);
  const executionMs = Math.max(1000, transportMs - 1000);
  const started = ChromeUtils.now();
  const dialogs = watchDialogs(target.browser);
  // I3: agent JavaScript runs only while the agent controls the Space. If
  // the user pauses or takes it mid-call, or the call's client cancels it,
  // the call fails, and its script is stopped if it is still running.
  const control = watchControl(target.space, ctx);
  let lost = null;
  control.lost.then(l => (lost = l));
  // The UI warns at a handOff on a site where the agent's code may linger.
  noteAgentCode(target.space, target.browsingContext, { world: true });
  // The world's own hook stops the agent's code just before the parent's
  // execution limit: the hang monitor's cancel doesn't reach a sandbox.
  const call = ctx.content(target.browsingContext, "evaluate#evaluate", { ...args, budgetMs: Math.max(100, executionMs - 50) });
  call.catch(() => {});
  // A dialog the evaluation opens holds it until someone answers; Ego
  // rejects the call at once and leaves the dialog for the agent.
  const outcome = Promise.race([call, dialogs.opened.then(dialog => ({ dialog })), control.lost.then(l => ({ lost: l }))]);
  try {
    let reply = await beforeDeadline(outcome, started + executionMs);
    if (reply === TIMEOUT) {
      reply = await recoverEvaluation(ctx, target, call, outcome, { apiName, executionMs, transportMs, started });
    }
    // What the agent's code left that loads the page afresh, whatever the
    // call ends with: its final frame says so (PROTOCOL "hooked").
    ctx.noteHooked(reply.hooked);
    if (reply.lost || lost) {
      await stopIfRunning(ctx, target);
      throw stoppedError(reply.lost ?? lost, target.space, apiName);
    }
    if (reply.dialog) {
      throw msg.dialogOpened({ method: apiName, dialog: reply.dialog, alreadyOpen: false });
    }
    if (reply.terminated) {
      // The world's hook stopped the agent's code at its deadline, in the
      // call or in a callback the call left: the page itself never hung.
      throw msg.evaluationDeadline({ apiName, timeoutMs: executionMs });
    }
    if (reply.destroyed) {
      throw new ZenError("ZEN_EVALUATION_FAILED", "Execution context was destroyed.", { plain: true });
    }
    if (reply.worldRefused) {
      throw msg.agentWorldRefused(apiName, target.page.label, reply.worldRefused);
    }
    return decode(reply, args);
  } catch (e) {
    if (contextDestroyed(e)) {
      throw new ZenError("ZEN_EVALUATION_FAILED", "Execution context was destroyed.", { plain: true });
    }
    throw e;
  } finally {
    dialogs.stop();
    control.stop();
  }
}

/**
 * The agent lost control while its script ran: a page whose process doesn't
 * answer at once is still running it, so stop it. Promise continuations and
 * callbacks it left in the page aren't calls zenius can stop.
 */
async function stopIfRunning(ctx, { browser }) {
  if (!(await answers(ctx, browser.browsingContext, 50))) {
    // The stops go on after the call fails, until the page answers.
    stopUntilAnswered(ctx, browser);
  }
}

/**
 * The evaluation outlived its execution limit. Returns the reply if it
 * still comes, `{terminated}` if our own script was stopped, or throws
 * Ego's timeout outcome.
 */
async function recoverEvaluation(ctx, { browser, page }, call, outcome, timing) {
  const { apiName, transportMs, started } = timing;
  // The tab's current context: a navigation that keeps the old page in the
  // bfcache gives the new one a new BrowsingContext.
  const bc = () => browser.browsingContext;
  if (await answers(ctx, bc(), PROBE_MS)) {
    // Our evaluation waits on a promise in a page that works.
    const reply = await beforeDeadline(outcome, started + transportMs);
    if (reply !== TIMEOUT) {
      return reply;
    }
    if (await answers(ctx, bc(), PROBE_MS)) {
      throw msg.evaluationPending({ apiName, timeoutMs: transportMs });
    }
  }
  // The page is busy: stop whatever script it runs, until it answers. The
  // stops go on past this wait, up to their own limit.
  const responsive = await Promise.race([stopUntilAnswered(ctx, browser), sleep(2 * PROBE_MS).then(() => false)]);
  // The process answers in order: once the probe answered, a stopped
  // evaluation's reply has arrived too.
  const settled = await beforeDeadline(
    call.catch(() => null),
    ChromeUtils.now() + (responsive ? 20 : 0)
  );
  if (settled !== TIMEOUT && settled) {
    return settled;
  }
  if (responsive) {
    throw msg.evaluationStopped({ apiName, timeoutMs: transportMs });
  }
  const nav = trackerFor(browser);
  if (nav.pending) {
    nav.stop();
    if (await answers(ctx, bc(), 1000)) {
      throw msg.evaluationPendingNavigation({ apiName, label: page.label, timeoutMs: transportMs, url: nav.currentURL });
    }
  }
  throw msg.evaluationHung({ apiName, label: page.label, timeoutMs: transportMs });
}

// ---------------------------------------------------------------------------
// waitForFunction

/**
 * Ego polls Boolean(await predicate) every `polling` ms. A predicate that
 * throws ends the wait at once; one whose document goes away is polled
 * again on the new one, `polling` ms later as Ego's is. A throw while a
 * navigation is under way, or while the document is still loading (the
 * content side), counts as not yet: a results page can have no body yet.
 * The content side loops, so a poll costs no round trip; the
 * parent bounds a predicate that never settles.
 */
async function waitForFunction(ctx, params) {
  const target = ctx.resolvePage(params);
  const { browser, page, space } = target;
  const args = evaluateArgs(params, "page.waitForFunction");
  const options = params.options ?? {};
  const timeoutMs = timeoutOption(options, WAIT_TIMEOUT_MS);
  const polling = timeoutOption(options, POLL_MS, "polling");
  const started = ChromeUtils.now();
  // Time the Space spends paused doesn't count against the timeout.
  let deadline = started + timeoutMs;
  const dialogs = watchDialogs(browser);
  // I3: the predicate runs only while the agent controls the Space. A pause
  // (a takeover prompt, the panel's Pause) stops the poll before its next
  // run and holds the wait; the user taking the Space ends it.
  let control = watchControl(space, ctx);
  // After a navigation, the next document's first poll waits `polling` ms.
  let delayMs = 0;
  const timedOut = (url, title) => {
    const popup = unhandledPopups(ctx, page)[0];
    return msg.functionTimeout({
      timeoutMs,
      label: page.label,
      lastUrl: url ?? browser.currentURI?.spec ?? "",
      // A sign-in result's title is the user's (content/signin.sys.mjs).
      lastTitle: title ?? (showsSignInResult(browser) ? "" : (browser.contentTitle ?? "")),
      popup,
    });
  };
  try {
    for (;;) {
      // The tab's current context each time: the predicate follows the page
      // to its next document (which may come with a new BrowsingContext).
      const id = ++waitIds;
      const bc = browser.browsingContext;
      // Each round: the page may have moved to a site the user's setting
      // doesn't run page code on.
      checkPageCode({ method: "page.waitForFunction", space, page, browser, bc });
      refuseAgentCode(ctx, space, page, "page.waitForFunction", bc);
      noteAgentCode(space, bc, { world: true });
      const call = ctx.content(bc, "evaluate#waitForFunction", {
        id,
        fn: args.fn,
        isFunction: args.isFunction,
        hasArg: args.hasArg,
        arg: args.arg,
        polling,
        delayMs,
        timeoutMs: Math.max(0, deadline - ChromeUtils.now()),
      });
      delayMs = 0;
      call.catch(() => {});
      const outcome = Promise.race([call, dialogs.opened.then(dialog => ({ dialog })), control.lost.then(lost => ({ lost }))]);
      let reply;
      try {
        // The content loop ends itself at the deadline unless a predicate
        // holds it; Ego's transport allows 250 ms more.
        reply = await beforeDeadline(outcome, deadline + PROBE_MS);
      } catch (e) {
        if (contextDestroyed(e) && ChromeUtils.now() < deadline) {
          delayMs = polling;
          continue;
        }
        if (contextDestroyed(e)) {
          throw timedOut();
        }
        throw e;
      }
      if (reply === TIMEOUT) {
        // A predicate that hasn't settled: Ego's evaluation timeout path.
        const r = await recoverEvaluation(ctx, target, call, outcome, {
          apiName: "page.waitForFunction",
          transportMs: timeoutMs,
          started: ChromeUtils.now() - timeoutMs,
        });
        ctx.noteHooked(r.hooked);
        if (r.terminated) {
          throw timedOut();
        }
        reply = r;
      }
      // A predicate that left something loading the page afresh, in this
      // round's document: the call's final frame says so.
      ctx.noteHooked(reply.hooked);
      if (reply.lost) {
        // The pause reached us before the user's input reached the page
        // (the UI pauses first, in the parent), and this message goes to the
        // page's process ahead of that input.
        await ctx.content(bc, "evaluate#cancelWait", { id }, { timeout: 1000 }).catch(() => {});
        control.stop();
        if (!reply.lost.paused) {
          throw stoppedError(reply.lost, space, "page.waitForFunction");
        }
        let held;
        try {
          held = await ctx.gate();
        } catch (e) {
          throw stoppedError({ error: e }, space, "page.waitForFunction");
        }
        deadline += held;
        control = watchControl(space, ctx);
        continue;
      }
      if (reply.dialog) {
        throw msg.dialogOpened({ method: "page.waitForFunction", dialog: reply.dialog, alreadyOpen: false });
      }
      if (reply.ok) {
        return true;
      }
      if (reply.navigated && ChromeUtils.now() < deadline) {
        // Poll the frame's next document, once the parent has it as current.
        await sleep(10);
        delayMs = polling;
        continue;
      }
      if (reply.worldRefused) {
        throw msg.agentWorldRefused("page.waitForFunction", page.label, reply.worldRefused);
      }
      if (reply.exception) {
        // The page that threw is on its way out: poll the next one.
        if (trackerFor(browser).pending && ChromeUtils.now() < deadline) {
          delayMs = polling;
          continue;
        }
        throw pageException(reply.exception, args.expression);
      }
      // The predicate's execution deadline (terminated) ends the loop as a timeout.
      throw timedOut(reply.url, reply.title);
    }
  } finally {
    dialogs.stop();
    control.stop();
  }
}

/** Ids for the content side's polls, so the parent can cancel one (cancelWait). */
let waitIds = 0;

// ---------------------------------------------------------------------------
// waitForSelector

/**
 * A parsed ref (@21, ref=21, 21) in its own frame. A stale ref throws
 * ZEN_REF_STALE whatever the state, before the wait and during it, as Ego's
 * waitForSelector does: its document is gone, and no state of it will come.
 */
function refTarget(browser, target) {
  const r = Refs.resolve(browser, Number(target.id));
  return { bc: r.browsingContext, ref: { refId: r.refId, innerWindowId: r.innerWindowId, localId: r.localId } };
}

/** Ego's waitForSelector throws the resolver's errors as they are. */
function plainError(e) {
  if (e instanceof ZenError && (e.code === "ZEN_SELECTOR_AMBIGUOUS" || e.code === "ZEN_INVALID_ARGUMENT")) {
    e.data = { ...e.data, plain: true };
  }
  return e;
}

async function waitForSelector(ctx, params) {
  const { browser } = ctx.resolvePage(params);
  const selector = params.target ?? params.selector;
  if (typeof selector !== "string" || !selector) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "page.waitForSelector selector must be a non-empty string");
  }
  const options = params.options ?? {};
  const state = options.state ?? "visible";
  if (!SELECTOR_STATES.has(state)) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", 'page.waitForSelector state must be one of attached, detached, visible, hidden');
  }
  const timeoutMs = timeoutOption(options, WAIT_TIMEOUT_MS);
  // The input layer's selector engine, shared with the actions; a malformed
  // locator fails here, before any page work.
  let target;
  try {
    target = Resolve.parseTarget(selector);
  } catch (e) {
    throw plainError(e);
  }
  const deadline = ChromeUtils.now() + timeoutMs;
  // Polled from here, as Ego's driver does, so one wait covers every frame.
  for (;;) {
    // A wait its client canceled, or whose connection closed, ends at its
    // next look.
    const stop = ctx.stopped();
    if (stop) {
      throw stop;
    }
    const ref = target.kind === "ref" ? refTarget(browser, target) : null;
    let holds = false;
    try {
      holds = ref
        ? await probeFrame(ctx, ref.bc, { ref: ref.ref, state }, deadline).then(r => !r.navigated && r.holds)
        : await lookAcrossFrames(ctx, browser, target, state, deadline);
    } catch (e) {
      if (e?.code === "ZEN_REF_STALE") {
        Refs.markStale(browser, ref.ref.refId);
        continue;
      }
      if (e === TIMEOUT || (e?.code === "ZEN_PAGE_UNRESPONSIVE" && !contextDestroyed(e))) {
        // A page too busy to answer before the deadline: this wait's own timeout.
        throw msg.selectorTimeout({ timeoutMs, selector });
      }
      if (!contextDestroyed(e)) {
        throw plainError(e);
      }
      // The document changed; look in the next one.
    }
    if (holds) {
      return true;
    }
    const left = deadline - ChromeUtils.now();
    if (left <= 0) {
      throw msg.selectorTimeout({ timeoutMs, selector });
    }
    await sleep(Math.min(POLL_MS, left));
  }
}

/** One content probe, bounded by the wait's deadline. */
function probeFrame(ctx, bc, args, deadline) {
  const left = deadline - ChromeUtils.now();
  if (left <= 0) {
    return Promise.reject(TIMEOUT);
  }
  return ctx.content(bc, "nav#probeSelector", args, { timeout: left + 50 });
}

/**
 * Ego's resolver for waitForSelector (element-resolver.ts, no actionability):
 * a raw CSS or XPath selector takes the first frame with a match, main frame
 * first, frames in tree order; a locator must match once in the main frame
 * or, failing that, once across the others (the input layer's decide()). Whether
 * `state` holds for the element found, or for none when nothing matches.
 */
async function lookAcrossFrames(ctx, browser, target, state, deadline) {
  const [top, ...frames] = browser.browsingContext.getAllBrowsingContextsInSubtree();
  const main = await probeFrame(ctx, top, { target, state }, deadline);
  if (main.navigated) {
    return false; // the next document isn't current yet
  }
  const locator = target.kind === "locator";
  if (main.count > 1 && locator) {
    throw Resolve.ambiguityError(target, main.count, main.diag);
  }
  if (main.count > 0) {
    return main.holds;
  }
  const list = [{ bcId: top.id, count: 0, actionable: 0, blocker: null }];
  const holds = new Map();
  for (const bc of frames) {
    let r;
    try {
      r = await probeFrame(ctx, bc, { target, state, top: false }, deadline);
    } catch (e) {
      // A frame that went away, or one we can't or mustn't script (a
      // privileged page; I5 refuses add-on frames and error pages).
      if (contextDestroyed(e) || e?.code === "ZEN_UNSUPPORTED" || e?.code === "ZEN_PAGE_NOT_WEB_CONTENT") {
        continue;
      }
      throw e;
    }
    if (r.navigated || !r.count) {
      continue;
    }
    if (!locator) {
      return r.holds;
    }
    list.push({ bcId: bc.id, count: r.count, actionable: r.count, blocker: null, diag: r.diag });
    holds.set(bc.id, r.holds);
  }
  if (list.length === 1) {
    return state === "detached" || state === "hidden";
  }
  return holds.get(Resolve.decide(target, list, null).bcId);
}

// ---------------------------------------------------------------------------
// Screenshots

const SCREENSHOT_OPTIONS = new Set(["fullPage", "clip", "scale", "raw"]);
const CLIP_KEYS = new Set(["x", "y", "width", "height", "scale"]);

function screenshotOptions(options) {
  // I5: the runtime writes no file an agent names; the client writes path.
  if (options.path !== undefined) {
    throw new ZenError(
      "ZEN_INVALID_ARGUMENT",
      "page.screenshot takes no path: it returns the image's bytes ({mimeType, base64}), and the client writes the file"
    );
  }
  for (const key of Object.keys(options)) {
    if (!SCREENSHOT_OPTIONS.has(key)) {
      throw new ZenError(
        "ZEN_INVALID_ARGUMENT",
        `page.screenshot received unknown option: ${key}. Expected: await page.screenshot({ path?, fullPage?, clip?, scale?, raw? })`
      );
    }
  }
  if (options.scale !== undefined && options.scale !== "css") {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "page.screenshot scale must be one of css");
  }
  const clip = options.clip;
  if (clip !== undefined) {
    const finite = n => typeof n === "number" && Number.isFinite(n);
    const ok =
      clip &&
      typeof clip === "object" &&
      Object.keys(clip).every(k => CLIP_KEYS.has(k)) &&
      finite(clip.x) &&
      finite(clip.y) &&
      finite(clip.width) &&
      clip.width > 0 &&
      finite(clip.height) &&
      clip.height > 0 &&
      (clip.scale === undefined || (finite(clip.scale) && clip.scale > 0));
    if (!ok) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "page.screenshot clip must be clip");
    }
  }
}

/**
 * PNG bytes of an ImageBitmap, or of its part `crop` ({sx, sy, sw, sh}),
 * encoded off the main thread. A part is copied through a 2d canvas: Gecko's
 * ImageBitmap crops lazily, and bitmaprenderer shows the whole source.
 */
async function encodePNG(doc, bitmap, crop = null, cover = []) {
  const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  if (crop || cover.length) {
    const c = crop ?? { sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height };
    canvas.width = c.sw;
    canvas.height = c.sh;
    const g = canvas.getContext("2d");
    try {
      g.drawImage(bitmap, c.sx, c.sy, c.sw, c.sh, 0, 0, c.sw, c.sh);
    } finally {
      bitmap.close();
    }
    g.fillStyle = COVER_COLOR;
    for (const r of cover) {
      g.fillRect(r.x - c.sx, r.y - c.sy, r.w, r.h);
    }
  } else {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("bitmaprenderer").transferFromImageBitmap(bitmap);
  }
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Add-on frames in a screenshot
//
// drawSnapshot paints every frame of the page, an add-on's too (a password
// manager's menu, which can show the user's saved logins). The screenshot
// paints over each add-on frame instead of refusing the whole shot. Each
// document that holds a frame on the way down says where that frame's box
// is in its own viewport; the parent maps the add-on frame's box up through
// them. The frames are placed before, during and after the paint, and the
// shot counts only when all three agree: a page that moves the frame
// meanwhile gets another try, then a refusal.

/** The gray an add-on frame's area is painted. */
const COVER_COLOR = "#808080";

/** Tries before a screenshot whose add-on frames keep moving is refused. */
const COVER_TRIES = 3;

/**
 * Whether page.screenshot paints over an add-on's frames instead of
 * refusing the shot. Off: painting over trusts three reads of where a frame
 * sits, and a page that moves the frame between them can leave it
 * uncovered, so for now the shot is refused. Turning this on needs the page
 * held still for the paint. Tests turn it on with setAddonPaintOver.
 */
let addonPaintOver = false;

/** Turn painting over add-on frames on or off (tests, and the first update). */
export function setAddonPaintOver(on) {
  addonPaintOver = on === true;
}

/**
 * A rect in a child frame's viewport, mapped into its parent's viewport: `cb`
 * is the child's content box there (its viewport), `vw`×`vh` the child's
 * viewport size. A rotated, skewed or flipped frame gives its whole box. Null
 * when nothing of `r` shows inside the frame.
 */
function mapUp(r, cb, vw, vh) {
  if (!cb.aligned) {
    return { x: cb.x, y: cb.y, w: cb.w, h: cb.h };
  }
  const sx = vw > 0 ? cb.w / vw : 1;
  const sy = vh > 0 ? cb.h / vh : 1;
  // The child paints only inside its frame.
  const x0 = Math.max(cb.x + r.x * sx, cb.x);
  const y0 = Math.max(cb.y + r.y * sy, cb.y);
  const x1 = Math.min(cb.x + (r.x + r.w) * sx, cb.x + cb.w);
  const y1 = Math.min(cb.y + (r.y + r.h) * sy, cb.y + cb.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * Where the add-on frames `frames` (checkPaintable's) paint, in the top
 * document's viewport, in CSS pixels, with its scroll offsets. Null when one
 * can't be placed: a document on the way didn't answer, or lost the frame.
 *
 * @returns {Promise<{areas: {x: number, y: number, w: number, h: number}[], sx: number, sy: number, key: string}|null>}
 */
async function addonAreas(ctx, top, frames) {
  if (!frames.length) {
    return { areas: [], sx: 0, sy: 0, key: "" };
  }
  // One call to each document that holds a frame on the way down.
  const asks = new Map();
  const ask = (holder, box, id) => {
    let a = asks.get(holder);
    if (!a) {
      asks.set(holder, (a = { border: [], content: [] }));
    }
    if (!a[box].includes(id)) {
      a[box].push(id);
    }
  };
  const chains = [];
  for (const frame of frames) {
    const chain = [];
    for (let b = frame; b !== top; b = b.parent) {
      if (!b?.parent) {
        return null;
      }
      chain.push(b);
      ask(b.parent, b === frame ? "border" : "content", b.id);
    }
    chains.push(chain);
  }
  const answers = new Map();
  try {
    await Promise.all(
      [...asks].map(async ([holder, a]) => answers.set(holder, await ctx.content(holder, "nav#frameBoxes", a, { timeout: 5000 })))
    );
  } catch {
    return null;
  }
  const boxOf = (holder, id, box) => answers.get(holder)?.frames?.find(f => f.id === id && f.box === box) ?? null;
  const areas = [];
  for (const chain of chains) {
    const own = boxOf(chain[0].parent, chain[0].id, "border");
    if (!own || own.missing) {
      return null;
    }
    let r = own.hidden ? null : { x: own.x, y: own.y, w: own.w, h: own.h };
    for (const b of chain.slice(1)) {
      if (!r) {
        break;
      }
      const cb = boxOf(b.parent, b.id, "content");
      const inner = answers.get(b);
      if (!cb || cb.missing || !inner) {
        return null;
      }
      r = cb.hidden ? null : mapUp(r, cb, inner.vw, inner.vh);
    }
    if (r) {
      areas.push(r);
    }
  }
  const { sx = 0, sy = 0 } = answers.get(top) ?? {};
  const round = v => Math.round(v * 2) / 2;
  const key = JSON.stringify([frames.map(f => f.id), sx, sy, areas.map(a => [round(a.x), round(a.y), round(a.w), round(a.h)])]);
  return { areas, sx, sy, key };
}

/**
 * The areas in the bitmap's pixels, a pixel wider all round. A shot of the
 * viewport has them where they are; one of the document has them at the
 * scroll offset, and a full page also where it draws fixed elements, at
 * scroll 0, since a frame's place in the page isn't known here.
 */
function coverRects(areas, { rect, scale, fullPage, sx, sy }) {
  const out = [];
  for (const a of areas) {
    const places = rect ? [{ x: a.x + sx - rect.x, y: a.y + sy - rect.y }] : [{ x: a.x, y: a.y }];
    if (rect && fullPage && (sx || sy)) {
      places.push({ x: a.x - rect.x, y: a.y - rect.y });
    }
    for (const p of places) {
      const x0 = Math.floor((p.x - 1) * scale);
      const y0 = Math.floor((p.y - 1) * scale);
      out.push({ x: x0, y: y0, w: Math.ceil((p.x + a.w + 1) * scale) - x0, h: Math.ceil((p.y + a.h + 1) * scale) - y0 });
    }
  }
  return out;
}

/** Is the clip (document coordinates) wholly inside the viewport the user would see? */
function onScreen(clip, m) {
  const slack = 0.01;
  return (
    clip.x >= m.sx - slack &&
    clip.y >= m.sy - slack &&
    clip.x + clip.width <= m.sx + m.w + slack &&
    clip.y + clip.height <= m.sy + m.h + slack
  );
}

/**
 * The part of a viewport snapshot (drawn at `scale`) that a clip on screen
 * covers, in its pixels; null when that is the whole snapshot.
 */
function cropOf(bitmap, cut, scale) {
  const sx = Math.min(Math.max(0, Math.round(cut.x * scale)), bitmap.width - 1);
  const sy = Math.min(Math.max(0, Math.round(cut.y * scale)), bitmap.height - 1);
  const sw = Math.min(Math.max(1, Math.round(cut.width * scale)), bitmap.width - sx);
  const sh = Math.min(Math.max(1, Math.round(cut.height * scale)), bitmap.height - sy);
  return sx === 0 && sy === 0 && sw === bitmap.width && sh === bitmap.height ? null : { sx, sy, sw, sh };
}

/**
 * Ask each frame of the page to assess its document for the sign-in rules
 * (content/signinguard.sys.mjs). A frame that can't answer (not web content,
 * or gone) is the web-content checks' to refuse.
 *
 * @param {object} service  ZeniusService
 * @param {BrowsingContext} top
 */
async function assessFrames(service, top) {
  let contexts = [];
  try {
    contexts = top.getAllBrowsingContextsInSubtree().filter(bc => bc !== top);
  } catch {}
  await Promise.all(contexts.map(bc => service.content(bc, "signinguard#assess", {}, { timeout: 2000 }).catch(() => false)));
}

/**
 * Ego's captureScreenshot: CSS pixels whatever the devicePixelRatio; the
 * viewport at its scroll offset, the whole document for fullPage, or a clip
 * in document coordinates (its `scale` multiplies device pixels, as CDP's).
 * The parent paints the page (drawSnapshot), so a busy page doesn't block it.
 *
 * As in Ego, a shot shows what's on screen: the viewport has its scrollbars,
 * and so does a clip wholly inside the viewport, which is cut from the
 * viewport's snapshot (fixed elements where the user sees them too). A clip
 * that leaves the viewport is drawn from the document, without scrollbars,
 * as Ego's Chromium draws beyond the viewport.
 */
async function screenshot(ctx, params) {
  const { browser, browsingContext, page } = ctx.resolvePage(params);
  const options = params.options ?? {};
  screenshotOptions(options);
  const win = browser.ownerDocument.defaultView;
  const fullPage = options.fullPage === true;
  const metrics = () => ctx.content(browsingContext, "nav#metrics", {});
  let rect = null;
  let scale = 1;
  /** A clip on screen, in viewport coordinates: cut from the viewport's snapshot. */
  let cut = null;
  if (options.clip) {
    const { x, y, width, height } = options.clip;
    const m = await metrics();
    if (options.clip.scale !== undefined) {
      scale = options.clip.scale * m.dpr;
    }
    if (onScreen(options.clip, m)) {
      cut = { x: x - m.sx, y: y - m.sy, width, height };
    } else {
      rect = new win.DOMRect(x, y, width, height);
    }
  } else if (fullPage) {
    const m = await metrics();
    rect = new win.DOMRect(0, 0, m.pw, m.ph);
  }
  // The sign-in rules: the page's process assesses the document and refuses
  // a sign-in result (the call's gate); a viewport shot makes no other call
  // before its paint. Every frame is asked to assess its own document too,
  // so the parent knows each sign-in result the paint would show.
  await ctx.content(browsingContext, "signinguard#check", {});
  await assessFrames(ctx.service, browsingContext);
  const wgp = browsingContext.currentWindowGlobal;
  if (!wgp) {
    throw new ZenError("ZEN_PAGE_UNRESPONSIVE", "the page has no document to capture", { reason: "no_window_global" });
  }
  // The paint covers every frame: a sign-in result in any of them refuses
  // the shot, checked before the paint and after it, and the paint must be
  // of the document that was checked.
  const signInChecked = () => {
    const found = signInResultInTab(browsingContext);
    if (found) {
      const { message, data } = signInRefusal("page.screenshot", found.flag, found.frame);
      throw new ZenError("ZEN_SIGN_IN_PAGE", message, data);
    }
    if (browsingContext.currentWindowGlobal !== wgp) {
      throw new ZenError("ZEN_PAGE_UNRESPONSIVE", "the page changed while the screenshot was painted: take it again", { reason: "context_destroyed" });
    }
  };
  // I5: drawSnapshot paints the page's frames too, and the metrics above
  // waited: check the document it paints and every frame, then again after.
  // An add-on's frames are painted over, placed before, during and after
  // the paint (addonAreas).
  const refused = why =>
    new ZenError(
      "ZEN_PAGE_NOT_WEB_CONTENT",
      `page.screenshot refused: an add-on's frame is in this page (${page.label}), and ${why}. Such a frame can show the user's own data, as a password manager's menu shows saved logins. page.snapshot still works: it leaves such frames out.`,
      { method: "page.screenshot", page: page.label, frame: true }
    );
  // With painting over off, an add-on's frame in the page refuses the shot,
  // shown or hidden: the page's script could show a hidden one for the
  // paint. Checked before and after the paint, so one that comes meanwhile
  // refuses it too.
  const paintable = () => {
    const frames = checkPaintable("page.screenshot", browser, page.label);
    if (frames.length && !addonPaintOver) {
      throw new ZenError(
        "ZEN_PAGE_NOT_WEB_CONTENT",
        `page.screenshot refused: an add-on's frame is in this page (${page.label}). A screenshot would paint it, and such a frame can show the user's own data, as a password manager's menu shows saved logins. It stays refused while the frame is in the page, even hidden. page.snapshot still works: it leaves such frames out.`,
        { method: "page.screenshot", page: page.label, frame: true }
      );
    }
    return frames;
  };
  for (let tries = 1; ; tries++) {
    const frames = paintable();
    signInChecked();
    const before = await addonAreas(ctx, browsingContext, frames);
    if (!before) {
      throw refused("zenius couldn't find where it paints, to paint over it");
    }
    // Full page draws position:fixed elements once, where they sit at
    // scroll 0.
    const painting = wgp.drawSnapshot(rect, scale, "white", { resetScrollPosition: fullPage });
    const during = addonAreas(ctx, browsingContext, frames);
    const bitmap = await painting;
    let still = false;
    try {
      signInChecked();
      const mid = await during;
      const after = await addonAreas(ctx, browsingContext, paintable());
      if (!mid || !after) {
        throw refused("zenius couldn't find where it paints, to paint over it");
      }
      still = mid.key === before.key && after.key === before.key;
    } catch (e) {
      bitmap.close();
      throw e;
    }
    if (still) {
      const cover = coverRects(before.areas, { rect, scale, fullPage, sx: before.sx, sy: before.sy });
      const bytes = await encodePNG(browser.ownerDocument, bitmap, cut && cropOf(bitmap, cut, scale), cover);
      return { mimeType: "image/png", base64: toBase64(bytes), ...(before.areas.length ? { covered: before.areas.length } : {}) };
    }
    bitmap.close();
    if (tries >= COVER_TRIES) {
      throw refused(`it moved while the screenshot was painted, ${COVER_TRIES} times, so zenius couldn't paint over it. Try again when the page is still`);
    }
  }
}

// ---------------------------------------------------------------------------
// Methods

// Gate classes: access for the control gate (I3), i5 for the web-content
// gate (I5).
export const access = {
  // Both run the agent's JavaScript in the page: mutate, so a takeover
  // prompt holds them.
  "page.evaluate": "mutate",
  "page.waitForFunction": "mutate",
  "page.waitForSelector": "read",
  "page.screenshot": "read",
  "page.info": "read",
  "page.events": "read",
  "page.acceptDialog": "mutate",
  "page.dismissDialog": "mutate",
};

export const i5 = {
  "page.evaluate": "document",
  "page.waitForFunction": "document",
  "page.waitForSelector": "document",
  "page.screenshot": "document",
  "page.info": "outside",
  "page.events": "outside",
  "page.acceptDialog": "document",
  "page.dismissDialog": "document",
};

export const methods = {
  "page.evaluate": (ctx, params) => {
    const target = ctx.resolvePage(params);
    return runEvaluation(ctx, target, evaluateArgs(params, "page.evaluate"), params, "page.evaluate");
  },

  "page.waitForFunction": waitForFunction,

  "page.waitForSelector": waitForSelector,

  "page.screenshot": screenshot,

  "page.info": async (ctx, params) => {
    const { browser, browsingContext } = ctx.resolvePage(params);
    const dialog = currentDialog(browser);
    if (dialog) {
      return { dialog };
    }
    // I5: page.info works whatever the page shows, so an agent can see where
    // it is. But the title and metrics are the document's: for one that isn't
    // web content (a local file, a browser or add-on page), the URL the parent
    // knows, as page.url gives it, and nothing read from the document.
    const wgp = browsingContext.currentWindowGlobal;
    if (wgp && !wgp.isClosed && notWebContent(wgp)) {
      return { url: browser.currentURI?.spec ?? "" };
    }
    const m = await ctx.content(browsingContext, "nav#metrics", {}, { timeout: responseTimeout(params) });
    return { url: m.url, title: m.title, w: m.w, h: m.h, sx: m.sx, sy: m.sy, pw: m.pw, ph: m.ph };
  },

  "page.events": (ctx, params) => {
    const { browser } = ctx.resolvePage(params);
    return drainEvents(browser.browserId);
  },

  "page.acceptDialog": (ctx, params) => {
    const { browser } = ctx.resolvePage(params);
    if (params.promptText !== undefined && typeof params.promptText !== "string") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "page.acceptDialog promptText must be a string");
    }
    return answerDialog(browser, true, params.promptText);
  },

  "page.dismissDialog": (ctx, params) => {
    const { browser } = ctx.resolvePage(params);
    return answerDialog(browser, false);
  },
};
