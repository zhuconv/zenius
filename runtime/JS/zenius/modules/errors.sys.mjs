// Error type shared by the parent process and content processes. It has no
// parent-only imports, so content modules may import it too.

/** Codes from docs/PROTOCOL.md. They mirror Ego's EGO_* codes one for one. */
export const ErrorCodes = Object.freeze(
  Object.fromEntries(
    [
      "ZEN_INVALID_ARGUMENT",
      "ZEN_UNSUPPORTED",
      "ZEN_INTERNAL",
      "ZEN_BROWSER_UNAVAILABLE",
      "ZEN_TASK_SPACE_NOT_FOUND",
      "ZEN_TASK_SPACE_NOT_SELECTED",
      "ZEN_TASK_SPACE_INACTIVE",
      "ZEN_TASK_SPACE_UNAVAILABLE",
      "ZEN_TASK_SPACE_USER_IN_CONTROL",
      "ZEN_TASK_SPACE_NAME_IN_USE",
      // zen-core's claim approval (SPEC §3.4), which Ego doesn't have: the
      // user denied an agent's claim in the browser, or didn't answer.
      "ZEN_TASK_SPACE_CLAIM_DENIED",
      "ZEN_PROFILE_NOT_FOUND",
      "ZEN_PAGE_NOT_FOUND",
      "ZEN_PAGE_BUDGET_REACHED",
      "ZEN_PAGE_UNRESPONSIVE",
      "ZEN_PAGE_GROUP_SHARED",
      "ZEN_PAGE_EVALUATION_TIMED_OUT",
      "ZEN_NAVIGATION_FAILED",
      "ZEN_TIMEOUT",
      "ZEN_SNAPSHOT_FAILED",
      "ZEN_REF_STALE",
      "ZEN_REF_NOT_FOUND",
      "ZEN_SELECTOR_NOT_FOUND",
      "ZEN_SELECTOR_AMBIGUOUS",
      "ZEN_NOT_ACTIONABLE",
      "ZEN_DIALOG_NOT_FOUND",
      "ZEN_DOWNLOAD_FAILED",
      // zen-observe's methods. The first three mirror Ego's codes; Ego
      // throws the last two as plain Errors (the error's data.plain).
      "ZEN_NAVIGATION_TIMEOUT",
      "ZEN_PAGE_DIALOG_OPENED",
      "ZEN_URL_OPENED_IN_POPUP",
      "ZEN_EVALUATION_FAILED",
      "ZEN_FETCH_FAILED",
      // zen-observe's I5 checks (SPEC §3.9), which Ego doesn't have: a load
      // of a URL agents may not open; a method in a document that isn't
      // web content.
      "ZEN_URL_NOT_ALLOWED",
      "ZEN_PAGE_NOT_WEB_CONTENT",
      // The isolated world (zen-observe), which Ego doesn't have: the
      // agent's code read a page global its world can't see.
      "ZEN_PAGE_GLOBAL_HIDDEN",
      // Closed groups, which Ego doesn't have (zen-observe's methods that run
      // the agent's code, and zen-input's paste with html): the page shares a
      // window group with a window outside the task.
      "ZEN_AGENT_CODE_REFUSED",
      // zen-core's hand-off, which Ego doesn't have: spaces.handOff can't
      // make the page safe for the user's typing (data.reason).
      "ZEN_HANDOFF_REFUSED",
      // zen-input's methods, mirroring Ego's codes: an action opened a file
      // chooser nobody waited for; page.waitForFileChooser timed out.
      "ZEN_FILE_CHOOSER_OPENED",
      "ZEN_FILE_CHOOSER_TIMEOUT",
      // The user's setting for agents' page code (zen-observe), which Ego
      // doesn't have: it is "never", or "ask" and the site isn't allowed
      // (data.site, data.asked, data.declined).
      "ZEN_PAGE_CODE_OFF",
      "ZEN_PAGE_CODE_ASKED",
    ].map(c => [c, c])
  )
);

export class ZenError extends Error {
  /**
   * @param {string} code one of ErrorCodes
   * @param {string} message
   * @param {object} [data] extra machine-readable detail, sent as error.data
   */
  constructor(code, message, data) {
    super(message);
    this.name = "ZenError";
    this.code = ErrorCodes[code] ? code : "ZEN_INTERNAL";
    if (!ErrorCodes[code]) {
      this.message = `${message} (unknown error code ${code})`;
    }
    if (data !== undefined) {
      this.data = data;
    }
  }

  /** The `error` member of a response frame. */
  toWire() {
    const wire = { code: this.code, message: this.message };
    if (this.data !== undefined) {
      wire.data = this.data;
    }
    return wire;
  }

  /** Rebuild a ZenError from a wire object (actor replies, tests). */
  static fromWire(wire) {
    return new ZenError(wire?.code ?? "ZEN_INTERNAL", wire?.message ?? "unknown error", wire?.data);
  }
}

/**
 * Turn anything thrown into a wire error. Non-ZenErrors become ZEN_INTERNAL
 * and keep their message and the first stack frames, which is what a worker
 * debugging a handler needs.
 *
 * @param {any} e
 */
export function toWireError(e) {
  if (e instanceof ZenError || (e && typeof e.code === "string" && ErrorCodes[e.code])) {
    return ZenError.prototype.toWire.call(e);
  }
  const message = e?.message ?? String(e);
  const stack = typeof e?.stack === "string" ? e.stack.split("\n").slice(0, 6).join("\n") : undefined;
  return { code: "ZEN_INTERNAL", message, data: stack ? { name: e?.name, stack } : undefined };
}
