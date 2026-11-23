// Error texts for zen-observe's methods.
// Portions adapted from citrolabs/ego-lite (MIT License).
//
// The wording follows Ego (driver/page-waits.ts, page-model.ts,
// browser-runtime.ts) so agents get the same guidance and ported tests match.
// Where Ego throws a plain Error without a code, the error carries
// `data.plain: true` and the SDK throws it the same way; the runtime still
// sends a real code so other clients and logs can tell failures apart.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";

function plain(code, message, data = {}) {
  return new ZenError(code, message, { ...data, plain: true });
}

/**
 * ZEN_AGENT_CODE_REFUSED, for closed groups: the page shares a window group
 * with a window outside the task (zen-core's pages.codeRefusal), so the
 * agent's code doesn't run there, and page.goto loads neither the agent's
 * own page (`what` "agentPage") nor another site ("site"). It names no
 * window or URL of the user's.
 *
 * @param {string} method
 * @param {string} label
 * @param {{reason: string, windows: number}} refusal
 * @param {"code"|"agentPage"|"site"} [what]
 */
export function agentCodeRefused(method, label, refusal, what = "code") {
  const data = { method, page: label, reason: refusal.reason, windows: refusal.windows };
  const why = "it shares a window group with a window outside the task";
  if (what === "site") {
    return new ZenError(
      "ZEN_AGENT_CODE_REFUSED",
      `${method}: zenius doesn't load another site in this page: ${why}, which that site's code could reach. Pages of this site still load here. To open another site, use a new page of the task (pages.new).`,
      data
    );
  }
  return new ZenError(
    "ZEN_AGENT_CODE_REFUSED",
    `${method}: zenius doesn't run the agent's code in this page: ${why}, which code here could reach. page.click, page.fill, page.type, snapshots and screenshots still work here. To run code on this site, load it in a new page of the task (pages.new).${what === "agentPage" ? " A data: or blob: page is the agent's own code." : ""}`,
    data
  );
}

/**
 * The agent's code in its isolated world read a page global the world can't
 * see (`refusal.reason` "pageGlobal"). The call fails even when the code
 * caught the throw. Its routes into the page's
 * own JavaScript run and mark the page hooked instead (content/evidence.sys.mjs).
 */
export function agentWorldRefused(method, label, refusal) {
  return new ZenError(
    "ZEN_PAGE_GLOBAL_HIDDEN",
    `${method}: the agent's code read ${refusal.name}, which is the page's own JavaScript. zenius runs the agent's code in an isolated world that shares only the page's DOM, so it can't see the page's globals. Read what you need from the DOM: text, attributes, form values.`,
    { method, page: label, name: refusal.name }
  );
}

/** Ego's jsSnippet: one line, at most 160 characters. */
export function jsSnippet(source) {
  const text = String(source).trim().replace(/\n/g, "\\n");
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

// ---------------------------------------------------------------------------
// goto and reload (page-waits.ts:684-696, 904-954, 838-846)

export function pendingNavigationNote(what, outcome, retry) {
  if (outcome === "stopped") {
    return `; ${what} had not committed and was stopped, so the Page still shows its previous document. Retry ${retry} with a longer timeout, or continue on a new Page from task.newPage().`;
  }
  if (outcome === "committed") {
    return `; ${what} committed at the deadline but its loading was stopped. Call page.reload({ timeout }) if the rest of the document is required.`;
  }
  return `; ${what} has not committed and the Page did not answer even after Page.stopLoading, so its renderer is probably hung. Continue on a new Page from task.newPage(), or close this Page and open it again.`;
}

function navigationTimeoutNextStep(waitUntil) {
  if (waitUntil === "commit") {
    return "Continue on this Page; the requested document has committed.";
  }
  if (waitUntil === "networkidle") {
    return 'Continue when the needed DOM state is observable, or call page.waitForLoadState("networkidle") if network quiescence is required.';
  }
  return `Continue on this Page; call page.waitForLoadState(${JSON.stringify(waitUntil)}) if that lifecycle state is still required.`;
}

export function gotoTimeout({ timeoutMs, waitUntil, committed, stopped, url, readyState, requestedUrl }) {
  let state = "";
  const data = { committed, stopped, waitUntil, timeoutMs };
  if (committed) {
    const where = `${url ? ` at ${JSON.stringify(url)}` : ""}${readyState ? ` with document.readyState=${JSON.stringify(readyState)}` : ""}`;
    state = stopped
      ? `; navigation committed${where}, but its loading was stopped at the deadline. Call page.reload({ timeout }) if the rest of the document is required.`
      : `; navigation committed${where}. ${navigationTimeoutNextStep(waitUntil)}`;
    if (url) {
      data.url = url;
    }
    if (readyState) {
      data.readyState = readyState;
    }
  } else if (stopped) {
    state = pendingNavigationNote(
      `the navigation${requestedUrl ? ` to ${JSON.stringify(requestedUrl)}` : ""}`,
      "stopped",
      "page.goto(url, { timeout })"
    );
  }
  return new ZenError("ZEN_NAVIGATION_TIMEOUT", `page.goto timed out after ${timeoutMs}ms waiting for ${waitUntil}${state}`, data);
}

export function reloadTimeout({ timeoutMs, waitUntil, committed, stopped }) {
  const note = !committed && stopped ? pendingNavigationNote("the reload", "stopped", "page.reload({ timeout })") : "";
  return plain("ZEN_TIMEOUT", `page.reload timed out after ${timeoutMs}ms waiting for ${waitUntil}${note}`, {
    committed,
    stopped,
    waitUntil,
    timeoutMs,
  });
}

/** Ego's "page.goto failed: <Chromium's errorText>"; reload says page.reload. */
export function navigationFailed(method, text, data = {}) {
  return plain("ZEN_NAVIGATION_FAILED", `${method} failed: ${text}`, data);
}

// ---------------------------------------------------------------------------
// A call held by a pending navigation (page-model.ts:3543-3561, 3969-4114)

export function pageUnresponsive({ label, url, method, waitedMs }) {
  const head = `Page ${label}${url ? ` (${url})` : ""} did not answer ${method} within ${waitedMs}ms`;
  return new ZenError(
    "ZEN_PAGE_UNRESPONSIVE",
    `${head}: a main-frame navigation had started but not committed. ` +
      `It was stopped once that wait ran out, so the Page answers again${url ? ` and shows ${url}` : ""}. ` +
      "Retry the call to continue on that document; to load the pending one, call page.goto(url, { timeout }) with a longer timeout, or continue on a new Page from task.newPage().",
    { method, timeoutMs: waitedMs, waitedMs, stopped: true, currentUrl: url }
  );
}

function evaluationTimeout(message, fields) {
  return new ZenError("ZEN_PAGE_EVALUATION_TIMED_OUT", message, { stopped: false, ...fields });
}

/** The execution deadline stopped the evaluation's own script. */
export function evaluationDeadline({ apiName, timeoutMs }) {
  return evaluationTimeout(
    `${apiName} exceeded its ${timeoutMs}ms page-execution safety limit. The current JavaScript execution was stopped and the Page is ready for another command, but work scheduled earlier may still produce late side effects.`,
    { timeoutMs, executionStopped: true, mayHaveLateEffects: true, pageResponsive: true }
  );
}

/** A promise that hasn't settled, in a page that answers. */
export function evaluationPending({ apiName, timeoutMs }) {
  return evaluationTimeout(
    `${apiName} timed out after ${timeoutMs}ms while waiting for page JavaScript. The Page is responsive, but the evaluation is still pending and may produce late side effects. Reload or close the Page when that would be unsafe.`,
    { timeoutMs, executionStopped: false, mayHaveLateEffects: true, pageResponsive: true }
  );
}

/** The page was busy; its script was stopped and it answers again. */
export function evaluationStopped({ apiName, timeoutMs }) {
  return evaluationTimeout(
    `${apiName} timed out after ${timeoutMs}ms and the renderer stopped responding. The current execution was stopped and the Page recovered, but work scheduled earlier may still produce late side effects.`,
    { timeoutMs, executionStopped: true, mayHaveLateEffects: true, pageResponsive: true }
  );
}

export function evaluationPendingNavigation({ apiName, label, timeoutMs, url }) {
  return evaluationTimeout(
    `${apiName}${label ? ` on Page ${label}` : ""} timed out after ${timeoutMs}ms: a main-frame navigation had started but not committed, so the Page answered nothing. ` +
      `It was stopped once that wait ran out, so the Page answers again${url ? ` and shows ${url}` : ""}; the evaluation may still run late on that document. ` +
      "Retry the call to continue on that document; to load the pending one, call page.goto(url, { timeout }) with a longer timeout, or continue on a new Page from task.newPage().",
    { timeoutMs, executionStopped: false, mayHaveLateEffects: true, pageResponsive: true, stopped: true, currentUrl: url }
  );
}

export function evaluationHung({ apiName, label, timeoutMs }) {
  return evaluationTimeout(
    `${apiName}${label ? ` on Page ${label}` : ""} timed out after ${timeoutMs}ms and the Page is still unresponsive, even after Page.stopLoading, so its renderer is probably hung. Execution could not be confirmed stopped; continue on a new Page from task.newPage(), or close this Page and open it again.`,
    { timeoutMs, executionStopped: false, mayHaveLateEffects: true, pageResponsive: false }
  );
}

/** Page code threw (cdp-eval.ts runtimeValue). */
export function evaluationFailed({ line, column, description, expression }) {
  const loc = Number.isInteger(line) && Number.isInteger(column) ? ` at line ${line}, column ${column}` : "";
  return plain("ZEN_EVALUATION_FAILED", `JavaScript evaluation failed${loc}: ${description}; expression: ${jsSnippet(expression)}`);
}

// ---------------------------------------------------------------------------
// Dialogs (browser-runtime.ts:173-204)

export function dialogOpened({ method, dialog, alreadyOpen = true }) {
  const kind = dialog.type ? `JavaScript ${dialog.type} dialog` : "JavaScript dialog";
  const text = dialog.message ? ` (${JSON.stringify(dialog.message)})` : "";
  const situation = alreadyOpen
    ? `${method} cannot run while a ${kind}${text} is open`
    : `a ${kind}${text} opened while ${method} was running`;
  return new ZenError(
    "ZEN_PAGE_DIALOG_OPENED",
    `${situation}; handle it with page.acceptDialog() or page.dismissDialog() before continuing`,
    { method, dialog }
  );
}

// ---------------------------------------------------------------------------
// Waits (page-waits.ts, page-model.ts)

export function urlTimeout({ timeoutMs, description, lastUrl }) {
  return plain("ZEN_TIMEOUT", `page.waitForURL timed out after ${timeoutMs}ms: expected ${description}; last URL was ${JSON.stringify(lastUrl)}`);
}

export function urlOpenedInPopup({ opener, lastUrl, popup, popupUrl }) {
  return new ZenError(
    "ZEN_URL_OPENED_IN_POPUP",
    `page ${opener} did not navigate from ${JSON.stringify(lastUrl)}, ` +
      `but popup ${popup} opened from it at ${JSON.stringify(popupUrl)}. ` +
      `The triggering action already succeeded; do not repeat it. Continue with ` +
      `task.page(${JSON.stringify(popup)}).`,
    { page: opener, popup, url: lastUrl, popupUrl }
  );
}

export function loadStateTimeout({ state, timeoutMs, inflight }) {
  let suffix = "";
  if (state === "networkidle" && inflight?.length) {
    const shown = inflight.slice(0, 5).map(r => `${r.type || "Other"} ${r.url}`);
    suffix = ` (${inflight.length} requests still in flight: ${shown.join(", ")}${inflight.length > 5 ? ` and ${inflight.length - 5} more` : ""})`;
  }
  return plain("ZEN_TIMEOUT", `page.waitForLoadState(${state}) timed out after ${timeoutMs}ms${suffix}`);
}

export function selectorTimeout({ timeoutMs, selector }) {
  return plain("ZEN_TIMEOUT", `page.waitForSelector timed out after ${timeoutMs}ms: ${selector}`);
}

export function functionTimeout({ timeoutMs, label, lastUrl, lastTitle, popup }) {
  const title = lastTitle ? `; last title was ${JSON.stringify(lastTitle)}` : "";
  const popupHint = popup
    ? ` Popup ${popup.label} opened from ${label} at ${JSON.stringify(popup.url)}; inspect task.page(${JSON.stringify(popup.label)}) before retrying the preceding action.`
    : "";
  return plain(
    "ZEN_TIMEOUT",
    `page.waitForFunction timed out after ${timeoutMs}ms on page ${label}; last URL was ${JSON.stringify(lastUrl ?? "")}${title}.${popupHint}`
  );
}

export function eventTimeout({ event, timeoutMs }) {
  return plain("ZEN_TIMEOUT", `page.waitForEvent(${JSON.stringify(event)}) timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Files

export function fetchFailed(text) {
  return plain("ZEN_FETCH_FAILED", text);
}

export function downloadFailed(text, data = {}) {
  return plain("ZEN_DOWNLOAD_FAILED", text, data);
}
