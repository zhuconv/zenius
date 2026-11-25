// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Page, its mouse and keyboard, Download and FileChooser. Each public call
// validates its arguments the way Ego does, then becomes one runtime request
// (PROTOCOL.md); the runtime resolves targets, waits, and synthesizes input.

import { apiEntry, validateOptions } from "./api-schema.ts";
import { CODE_GUIDE } from "./error-guide.ts";
import { unsupportedCdpError, ZeniusError } from "./errors.ts";
import { bytesFrom, copyDownload, type FilePayload, outputPath, readUploads, reportWritten, writeOutput } from "./files.ts";
import { CONSTRUCT, EXPLAIN_PAGE_ERROR, NOTE_ENTRY, REQUEST } from "./internal.ts";
import { fs, path as nodePath, os } from "./node.ts";
import { addNotice } from "./output.ts";
import { round } from "./round.ts";
import type { TaskSpace } from "./task-space.ts";
import { configuredResponseTimeout } from "./config.ts";

/** CDP calls that only switch console reporting, which zenius always has on. */
const CONSOLE_TOGGLES = new Set(["egoAutomated.disable", "egoAutomated.enable", "Runtime.enable", "Runtime.disable"]);

// The runtime bounds every operation by its own timeout, defaulting to Ego's
// values. The client limit only catches a runtime that stopped answering, so
// it trails the script's timeout, or a generous fixed limit when the script
// left the default to the runtime.
const GRACE_MS = 10_000;
const UNSPECIFIED_LIMIT_MS = 60_000;
const WAIT_TIMEOUT_MS = 10_000;
const URL_POLL_INTERVAL_MS = 100;

/**
 * Browser UI that zenius refused in a page the agent drives, because it
 * would open over the user's view, leave the browser or touch the OS
 * (PROTOCOL.md, "Refused surfaces"). More kinds come as the runtime guards
 * more surfaces, so a script should handle any string.
 */
export type RefusalKind =
  | "print"
  | "httpAuth"
  | "passkey"
  | "permissionPrompt"
  | "promptDenied"
  | "externalApp"
  | "addonInstall"
  | "popupBlocked"
  | "redirectBlocked"
  | "protocolHandler"
  | "fullscreen"
  | "pointerLock"
  | "wakeLock"
  | "speech"
  | "share"
  | "colorPicker"
  | "datePicker"
  | "selectDropdown"
  | "clipboardRead"
  | "download"
  | "audio"
  | "serviceWorker"
  | "cacheStorage"
  | "deviceAccess"
  | "notification"
  | "localNetwork"
  | "browserConfirmation"
  | (string & {});
/** One refusal: its kind, and a message that says what happened and what to do instead. */
export type Refusal = { kind: RefusalKind; message: string };
/** page.events()'s record of a refusal, with the URL involved (the page's, or the app link's). */
export type RefusedEvent = { method: "Zenius.refused"; params: Refusal & { url: string } };
/** A browser event buffered for a Page: CDP-named ones as in Ego, and zenius's own. */
export type PageEvent = RefusedEvent | { method: string; params?: Record<string, unknown> };

export type PageActionReceipt = {
  popups?: Array<{ label: string; targetId?: string }>;
  dialog?: Record<string, unknown>;
  /** What zenius refused while the action ran; absent when it refused nothing. */
  refused?: Refusal[];
  [key: string]: unknown;
};

type PageOptions = Record<string, unknown>;
type PageEntry = { targetId?: string; openedBy?: string };

/**
 * What the agent hears when `op`'s page code left `detail` in the page
 * `label`, which then loads afresh (the runtime's `hooked`, PROTOCOL
 * "Frames"; the docs' limits topic, "Pages that load afresh"). One line:
 * zenius mcp's results list notices by line.
 */
export function hookedNotice(op: string, label: string, detail: string): string {
  return (
    `${op} left something in ${label} that costs it a reload (${detail}): zenius loads ${label} afresh when it's handed to the user, ` +
    `before the user clicks or types there, and at the task's end, so what ${label} keeps only in its memory, such as a game's moves, ` +
    "is lost then. To keep that, leave nothing in the page, or reach the state's own address with page.goto first."
  );
}

export class Page {
  readonly label: string;
  readonly spaceId: number;
  readonly mouse: PageMouse;
  readonly keyboard: PageKeyboard;
  readonly #task: TaskSpace;
  #targetId?: string;
  #openedBy?: string;
  #waitingForFileChooser = false;
  #waitingForDownload = false;

  constructor(task: TaskSpace, label: string, entry: PageEntry | undefined, token: symbol) {
    if (token !== CONSTRUCT) {
      throw new TypeError("Page handles come from task.page(label), task.pages() or task.newPage()");
    }
    this.label = label;
    this.spaceId = task.id;
    this.#task = task;
    this.#targetId = entry?.targetId;
    this.#openedBy = entry?.openedBy;
    this.mouse = new PageMouse(this);
    this.keyboard = new PageKeyboard(this);
  }

  get targetId(): string | undefined {
    return this.#targetId;
  }

  get openedBy(): string | undefined {
    return this.#openedBy;
  }

  /** Record identity learned from a listing or receipt. */
  [NOTE_ENTRY](entry: PageEntry | undefined): void {
    if (typeof entry?.targetId === "string") this.#targetId = entry.targetId;
    if (typeof entry?.openedBy === "string") this.#openedBy = entry.openedBy;
  }

  /** One runtime request addressed to this Page. */
  [REQUEST]<T = unknown>(method: string, op: string, params: PageOptions = {}, safetyTimeoutMs?: number): Promise<T> {
    const current = round();
    current.observe(this.spaceId, this.label);
    const responseTimeout = configuredResponseTimeout();
    const request = { space: this.spaceId, page: this.label, ...params, ...(responseTimeout === undefined ? {} : { responseTimeout }) };
    // Page code that left something loading the page afresh: the script's
    // output, zenius mcp's script result and its evaluate tool say so.
    const onHooked = (detail: string) => addNotice(`[zenius:reload]\n${hookedNotice(op, this.label, detail)}`);
    return current
      .call<T>(method, request, { op, safetyTimeoutMs, onHooked })
      .catch((error) => {
        throw this.#task[EXPLAIN_PAGE_ERROR](this.label, error);
      });
  }

  async goto(url: string, options: PageOptions = {}): Promise<PageActionReceipt> {
    assertUrl(url);
    validateOptions("Page.goto", options);
    return receipt(await this[REQUEST]("page.goto", "page.goto", { url, options }, limit(options)));
  }

  async reload(options: PageOptions = {}): Promise<PageActionReceipt> {
    validateOptions("Page.reload", options);
    return receipt(await this[REQUEST]("page.reload", "page.reload", { options }, limit(options)));
  }

  async snapshot(options: PageOptions = {}): Promise<string> {
    validateOptions("Page.snapshot", options);
    if (options.scope === "subtree" && options.root === undefined) {
      throw snapshotOptionsError("page.snapshot subtree scope requires root to be a snapshot ref such as @21");
    }
    if (options.scope !== "subtree" && options.root !== undefined) {
      throw snapshotOptionsError("page.snapshot root is only supported when scope is subtree");
    }
    if (options.root !== undefined && !parseRef(options.root)) {
      throw snapshotOptionsError("page.snapshot root must be a snapshot ref such as @21");
    }
    const result = await this[REQUEST]<unknown>("page.snapshot", "page.snapshot", { options }, UNSPECIFIED_LIMIT_MS);
    if (typeof result === "string") return result;
    const text = (result as { text?: unknown } | null)?.text;
    return typeof text === "string" ? text : "";
  }

  async screenshot(options: PageOptions = {}): Promise<string> {
    validateOptions("Page.screenshot", options);
    // Ego names the file in the SDK, so it lands in the script's temporary
    // directory (or globalThis.EGO_BROWSER_OUTPUT_DIR), where the agent looks.
    const path = options.path !== undefined ? outputPath(options.path, "page.screenshot path") : defaultScreenshotPath();
    // The runtime sends the PNG and the CLI writes it (SPEC I5).
    const { path: _path, ...capture } = options;
    const result = await this[REQUEST]<unknown>("page.screenshot", "page.screenshot", { options: capture }, UNSPECIFIED_LIMIT_MS);
    await writeOutput(path, bytesFrom(result, "base64", "page.screenshot"));
    reportWritten(path);
    return path;
  }

  async url(): Promise<string> {
    return this[REQUEST]<string>("page.url", "page.url", {}, UNSPECIFIED_LIMIT_MS);
  }

  async title(): Promise<string> {
    return this[REQUEST]<string>("page.title", "page.title", {}, UNSPECIFIED_LIMIT_MS);
  }

  async info(): Promise<Record<string, unknown>> {
    return this[REQUEST]("page.info", "page.info", {}, UNSPECIFIED_LIMIT_MS);
  }

  // The agent's own evidence for zenius's defenses (zen-core's page.flag).
  // The reason's rules (one line, up to 200 characters) are the runtime's,
  // so they live in one place.
  async flag(reason: string): Promise<void> {
    if (typeof reason !== "string") throw new TypeError("page.flag reason must be a string");
    await this[REQUEST]("page.flag", "page.flag", { reason }, UNSPECIFIED_LIMIT_MS);
  }

  async waitForURL(expected: unknown, options: PageOptions = {}): Promise<void> {
    validateOptions("Page.waitForURL", options);
    if (typeof expected === "function") {
      const timeout = numberOr(options.timeout, WAIT_TIMEOUT_MS);
      return this.#waitForURLPredicate(expected as (url: URL) => unknown, timeout);
    }
    let matcher: Record<string, unknown>;
    if (typeof expected === "string" && expected.length > 0) {
      // The runtime matches a regex; compiling the glob here keeps Playwright's
      // glob rules in one place. `value` stays the agent's text for messages.
      const compiled = urlGlobToRegExp(expected);
      matcher = { type: "glob", value: expected, regex: compiled.source };
    } else if (expected instanceof RegExp) {
      matcher = { type: "regex", value: expected.source, flags: expected.flags };
    } else {
      throw new TypeError("page.waitForURL expected URL must be a non-empty string, RegExp, or function");
    }
    await this[REQUEST]("page.waitForURL", "page.waitForURL", { matcher, options }, limit(options));
  }

  async #waitForURLPredicate(predicate: (url: URL) => unknown, timeout: number): Promise<void> {
    const deadline = Date.now() + timeout;
    let lastUrl = "";
    while (true) {
      const remaining = deadline - Date.now();
      // poll: the runtime answers at once, without page.url's wait for a
      // pending navigation, which would stop a slow one this is waiting for.
      lastUrl = await this[REQUEST]<string>(
        "page.url",
        "page.waitForURL",
        { poll: true },
        Math.max(1, remaining) + GRACE_MS,
      );
      if (typeof lastUrl === "string" && matchesPredicate(predicate, lastUrl)) return;
      const waitMs = deadline - Date.now();
      if (waitMs <= 0) break;
      await sleep(Math.min(URL_POLL_INTERVAL_MS, waitMs));
    }
    throw new ZeniusError(
      "ZEN_TIMEOUT",
      `page.waitForURL timed out after ${timeout}ms: expected a URL predicate; last URL was ${JSON.stringify(lastUrl)}`,
      { lastUrl, timeoutMs: timeout },
    );
  }

  /** Wait for this Page's next popup or download; arm it before the action. */
  waitForEvent(event: "popup" | "download", options: PageOptions = {}): Promise<Page | Download> {
    if (event !== "popup" && event !== "download") {
      throw new TypeError("page.waitForEvent only supports the popup and download events");
    }
    validateOptions("Page.waitForEvent", options);
    if (event === "download") {
      if (this.#waitingForDownload) throw new Error("this Page already has an active download wait");
      this.#waitingForDownload = true;
    }
    // request() writes the frame synchronously, so the runtime arms this wait
    // before it sees the action the script sends next.
    const pending = this[REQUEST]<Record<string, unknown>>(
      "page.waitForEvent",
      "page.waitForEvent",
      { event, options },
      limit(options),
    );
    if (event === "popup") return pending.then((result) => this.#popup(result));
    return pending
      .then((result) => new Download(this, result ?? {}))
      .finally(() => {
        this.#waitingForDownload = false;
      });
  }

  #popup(result: Record<string, unknown> | null): Page {
    const label = result?.label;
    if (typeof label !== "string" || !label) {
      throw new ZeniusError("ZEN_INTERNAL", "page.waitForEvent(\"popup\") got no Page label from the runtime");
    }
    const popup = this.#task.page(label);
    popup[NOTE_ENTRY]({ targetId: tabId(result), openedBy: stringOr(result?.openedBy) });
    round().observe(this.spaceId, label);
    return popup;
  }

  async waitForTimeout(timeout: number): Promise<void> {
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0) {
      throw new TypeError("page.waitForTimeout requires a non-negative number of milliseconds");
    }
    await sleep(timeout);
  }

  async acceptDialog(promptText?: string): Promise<boolean> {
    if (promptText !== undefined && typeof promptText !== "string") {
      throw new TypeError("page.acceptDialog promptText must be a string");
    }
    return this.#handleDialog("page.acceptDialog", promptText === undefined ? {} : { promptText });
  }

  async dismissDialog(): Promise<boolean> {
    return this.#handleDialog("page.dismissDialog", {});
  }

  async #handleDialog(method: string, params: PageOptions): Promise<boolean> {
    try {
      const result = await this[REQUEST]<unknown>(method, method, params, UNSPECIFIED_LIMIT_MS);
      if (typeof result === "boolean") return result;
      return (result as { ok?: unknown } | null)?.ok !== false;
    } catch (error) {
      // Ego reports "no dialog open" as false, not as an error.
      if (error instanceof ZeniusError && error.code === "ZEN_DIALOG_NOT_FOUND") return false;
      throw error;
    }
  }

  async evaluate(expression: unknown, argument?: unknown): Promise<any> {
    const hasArgument = arguments.length >= 2;
    const serialized = validateEvaluateInput("page.evaluate", expression, hasArgument, argument);
    const params: PageOptions = evaluateParams(expression, hasArgument, serialized);
    try {
      return await this[REQUEST]("page.evaluate", "page.evaluate", params, UNSPECIFIED_LIMIT_MS);
    } catch (error) {
      throw typeof expression === "function" ? enrichCallbackReferenceError(error, "page.evaluate") : error;
    }
  }

  async waitForFunction(expression: unknown, argument?: unknown, options: PageOptions = {}): Promise<true> {
    if (
      arguments.length === 2 &&
      typeof expression === "function" &&
      expression.length === 0 &&
      looksLikeWaitForFunctionOptions(argument)
    ) {
      throw new TypeError(
        `page.waitForFunction options are the third argument; pass undefined when omitting the callback argument. Expected: ${apiEntry("Page.waitForFunction")?.signature}`,
      );
    }
    validateOptions("Page.waitForFunction", options);
    // `undefined` is how callers skip the argument while passing options.
    const hasArgument = arguments.length >= 2 && argument !== undefined;
    const serialized = validateEvaluateInput("page.waitForFunction", expression, hasArgument, argument);
    try {
      await this[REQUEST](
        "page.waitForFunction",
        "page.waitForFunction",
        { ...evaluateParams(expression, hasArgument, serialized), options },
        limit(options),
      );
    } catch (error) {
      throw typeof expression === "function" ? enrichCallbackReferenceError(error, "page.waitForFunction") : error;
    }
    return true;
  }

  async fetch(url: string, options: PageOptions = {}): Promise<Record<string, unknown>> {
    assertUrl(url);
    validateOptions("Page.fetch", options);
    const file = options.saveAs !== undefined ? outputPath(options.saveAs, "page.fetch saveAs") : undefined;
    // With saveAs the body comes back as bytes and the CLI writes it, as in
    // Ego; the runtime never sees the path (SPEC I5).
    const { saveAs, ...fetchOptions } = options;
    const requestOptions = serializeJsonValue(
      saveAs === undefined ? fetchOptions : { ...fetchOptions, binary: true },
      "page.fetch options must be JSON-serializable",
    );
    const response = await this[REQUEST]<Record<string, unknown>>("page.fetch", "page.fetch", { url, options: requestOptions }, limit(options));
    if (saveAs === undefined) return response;
    if (typeof response?.bodyBase64 !== "string") throw new Error("page.fetch received no binary response body");
    const { bodyBase64, ...metadata } = response;
    await writeOutput(file!, Buffer.from(bodyBase64, "base64"));
    reportWritten(file!);
    return { ...metadata, savedPath: file };
  }

  async cdp(method?: unknown, ..._rest: unknown[]): Promise<Record<string, never>> {
    // Ego hides console messages from page sessions until a script calls
    // egoAutomated.disable and Runtime.enable, and its skill tells agents
    // to. zenius always records them in events(), out of the page's sight,
    // so those toggles have nothing to do; failing them would stop an agent
    // that follows Ego's skill.
    if (typeof method === "string" && CONSOLE_TOGGLES.has(method)) return {};
    throw unsupportedCdpError("page.cdp");
  }

  async waitForSelector(selector: string, options: PageOptions = {}): Promise<true> {
    if (typeof selector !== "string" || selector.length === 0) {
      throw new TypeError("page.waitForSelector selector must be a non-empty string");
    }
    validateOptions("Page.waitForSelector", options);
    await this[REQUEST]("page.waitForSelector", "page.waitForSelector", { target: selector, options }, limit(options));
    return true;
  }

  async waitForLoadState(state: string = "load", options: PageOptions = {}): Promise<void> {
    validateOptions("Page.waitForLoadState", options);
    if (state !== "domcontentloaded" && state !== "load" && state !== "networkidle") {
      throw new TypeError('page.waitForLoadState supports only "domcontentloaded", "load", and "networkidle"');
    }
    await this[REQUEST]("page.waitForLoadState", "page.waitForLoadState", { state, options }, limit(options));
  }

  async events(): Promise<PageEvent[]> {
    const result = await this[REQUEST]<unknown>("page.events", "page.events", {}, UNSPECIFIED_LIMIT_MS);
    if (Array.isArray(result)) return result;
    const events = (result as { events?: unknown } | null)?.events;
    return Array.isArray(events) ? events : [];
  }

  async click(selector: string, options: PageOptions = {}): Promise<PageActionReceipt> {
    return this.#action("page.click", "Page.click", selector, options, 2 * numberOr(options?.clickCount, 1));
  }

  async dblclick(selector: string, options: PageOptions = {}): Promise<PageActionReceipt> {
    return this.#action("page.dblclick", "Page.dblclick", selector, options, 4);
  }

  async hover(selector: string, options: PageOptions = {}): Promise<PageActionReceipt> {
    return this.#action("page.hover", "Page.hover", selector, options);
  }

  async dragAndDrop(source: string, target: string, options: PageOptions = {}): Promise<PageActionReceipt> {
    validateOptions("Page.dragAndDrop", options);
    assertSelector(source);
    assertSelector(target);
    return receipt(
      await this[REQUEST](
        "page.dragAndDrop",
        "page.dragAndDrop",
        { source, target, options },
        limit(options),
      ),
    );
  }

  async fill(selector: string, value: string, options: PageOptions = {}): Promise<PageActionReceipt> {
    validateOptions("Page.fill", options);
    assertSelector(selector);
    if (typeof value !== "string") throw new TypeError("page.fill value must be a string");
    return receipt(
      await this[REQUEST]("page.fill", "page.fill", { target: selector, value, options }, limit(options)),
    );
  }

  async selectOption(selector: string, valueOrValues: unknown, options: PageOptions = {}): Promise<string[]> {
    validateOptions("Page.selectOption", options);
    assertSelector(selector);
    const choices = valueOrValues === null ? [] : Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues];
    choices.forEach(validateSelectOptionChoice);
    const result = await this[REQUEST]<unknown>(
      "page.selectOption",
      "page.selectOption",
      { target: selector, values: choices, options },
      limit(options),
    );
    if (Array.isArray(result)) return result;
    const selected = (result as { selected?: unknown } | null)?.selected;
    return Array.isArray(selected) ? selected : [];
  }

  async focus(selector: string, options: PageOptions = {}): Promise<PageActionReceipt> {
    return this.#action("page.focus", "Page.focus", selector, options);
  }

  async press(selector: string, chord: string, options: PageOptions = {}): Promise<PageActionReceipt> {
    validateOptions("Page.press", options);
    assertSelector(selector);
    // Ego focuses first and then fails on the chord in keyboard.press's words;
    // zenius fails the same way before any request.
    splitChord(chord);
    return receipt(
      await this[REQUEST]("page.press", "page.press", { target: selector, chord, options }, clientLimitMs(options, 1)),
    );
  }

  async setInputFiles(selector: string, path: string | string[]): Promise<PageActionReceipt> {
    assertSelector(selector);
    const paths = normalizeFilePaths(path, "page.setInputFiles");
    const files = await readUploads(paths, "page.setInputFiles");
    const result = receipt(await this[REQUEST]("page.setInputFiles", "page.setInputFiles", { target: selector, files }, limit({})));
    round().noteUploads({ space: this.spaceId, label: this.label, paths, names: uploadNames(files) });
    return result;
  }

  waitForFileChooser(options: PageOptions = {}): Promise<FileChooser> {
    validateOptions("Page.waitForFileChooser", options);
    if (this.#waitingForFileChooser) throw new Error("this Page is already waiting for a file chooser");
    this.#waitingForFileChooser = true;
    return this[REQUEST]<Record<string, unknown>>(
      "page.waitForEvent",
      "page.waitForFileChooser",
      { event: "filechooser", options },
      limit(options),
    )
      .then((result) => new FileChooser(this, result ?? {}))
      .finally(() => {
        this.#waitingForFileChooser = false;
      });
  }

  async close(): Promise<void> {
    await this[REQUEST]("pages.close", "page.close", {}, UNSPECIFIED_LIMIT_MS);
  }

  /** `pauses`: how often options.delay pauses the action, twice per click. */
  async #action(method: string, schemaName: string, selector: string, options: PageOptions, pauses = 0): Promise<PageActionReceipt> {
    // Options first, then the selector, as Ego checks them.
    validateOptions(schemaName, options);
    assertSelector(selector);
    return receipt(await this[REQUEST](method, method, { target: selector, options }, clientLimitMs(options, pauses)));
  }
}

/** Page-scoped pointer input. The runtime keeps the pointer state per Page. */
export class PageMouse {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  async click(x: number, y: number, options: PageOptions = {}): Promise<PageActionReceipt> {
    validateOptions("Page.mouse.click", options);
    assertPoint(x, y, "page.mouse.click");
    return receipt(await this.#send("page.mouse.click", { action: "click", x, y, options }, numberOr(options?.delay, 0) * 2 * numberOr(options?.clickCount, 1)));
  }

  async move(x: number, y: number, options: PageOptions = {}): Promise<void> {
    validateOptions("Page.mouse.move", options);
    assertPoint(x, y, "page.mouse.move");
    await this.#send("page.mouse.move", { action: "move", x, y, options });
  }

  async down(options: PageOptions = {}): Promise<void> {
    validateOptions("Page.mouse.down", options);
    await this.#send("page.mouse.down", { action: "down", options });
  }

  async up(options: PageOptions = {}): Promise<void> {
    validateOptions("Page.mouse.up", options);
    await this.#send("page.mouse.up", { action: "up", options });
  }

  async wheel(deltaX: number, deltaY: number, options: PageOptions = {}): Promise<void> {
    validateOptions("Page.mouse.wheel", options);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      throw new TypeError("page.mouse.wheel requires finite deltaX and deltaY");
    }
    await this.#send("page.mouse.wheel", { action: "wheel", dx: deltaX, dy: deltaY, options });
  }

  #send(op: string, params: PageOptions, extraMs = 0): Promise<unknown> {
    return this.#page[REQUEST]("page.mouse", op, params, limit(params.options as PageOptions) + extraMs);
  }
}

/** Page-scoped keyboard input with Playwright key names and chords. */
export class PageKeyboard {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  async down(key: string): Promise<void> {
    assertKey(key);
    await this.#send("page.keyboard.down", { action: "down", key });
  }

  async up(key: string): Promise<void> {
    assertKey(key);
    await this.#send("page.keyboard.up", { action: "up", key });
  }

  async press(chord: string, options: PageOptions = {}): Promise<PageActionReceipt> {
    validateOptions("Page.keyboard.press", options);
    splitChord(chord);
    // The key is held down for options.delay.
    return receipt(await this.#send("page.keyboard.press", { action: "press", key: chord, options }, numberOr(options?.delay, 0)));
  }

  async type(text: string, options: PageOptions = {}): Promise<void> {
    validateOptions("Page.keyboard.type", options);
    if (typeof text !== "string") throw new TypeError("page.keyboard.type text must be a string");
    // Typing is paced per key, so long text needs a longer client limit.
    const delay = numberOr(options.delay, 0);
    await this.#send("page.keyboard.type", { action: "type", text, options }, text.length * (delay + 20));
  }

  async insertText(text: string): Promise<void> {
    if (typeof text !== "string") throw new TypeError("page.keyboard.insertText text must be a string");
    await this.#send("page.keyboard.insertText", { action: "insertText", text });
  }

  async paste(content: unknown): Promise<PageActionReceipt> {
    assertClipboardContent(content);
    const params =
      typeof content === "string"
        ? { action: "paste", text: content }
        : { action: "paste", text: (content as { text: string }).text, ...pickHtml(content) };
    return receipt(await this.#send("page.keyboard.paste", params));
  }

  #send(op: string, params: PageOptions, extraMs = 0): Promise<unknown> {
    return this.#page[REQUEST]("page.keyboard", op, params, UNSPECIFIED_LIMIT_MS + extraMs);
  }
}

/** A download started by a Page. Once finished, the file is in the working folder. */
export class Download {
  readonly #page: Page;
  readonly #id: string;
  readonly #url: string;
  readonly #suggestedFilename: string;

  constructor(page: Page, result: Record<string, unknown>) {
    const id = result.download ?? result.id;
    if (typeof id !== "string" && typeof id !== "number") {
      throw new ZeniusError("ZEN_INTERNAL", 'page.waitForEvent("download") got no download id from the runtime');
    }
    this.#page = page;
    this.#id = String(id);
    this.#url = stringOr(result.url) ?? "";
    this.#suggestedFilename = stringOr(result.suggestedFilename) ?? "";
  }

  page(): Page {
    return this.#page;
  }

  url(): string {
    return this.#url;
  }

  suggestedFilename(): string {
    return this.#suggestedFilename;
  }

  // The runtime writes no path an agent names (SPEC I5): the CLI makes every
  // copy an agent asks for, from the file in the working folder.
  async saveAs(path: string): Promise<string> {
    const file = outputPath(path, "download.saveAs");
    const source = await this.path();
    await copyDownload(source, file);
    reportWritten(file);
    return file;
  }

  /** The finished file in the working folder, which stays there after the script ends. */
  async path(): Promise<string> {
    const result = await this.#request("download.path", {});
    const path = stringOr((result as { path?: unknown } | null)?.path);
    if (!path) throw new ZeniusError("ZEN_INTERNAL", "download.path got no path from the runtime");
    return path;
  }

  async failure(): Promise<string | null> {
    const result = await this.#request("download.failure", {});
    if (result === null || typeof result === "string") return result;
    const failure = (result as { failure?: unknown } | null)?.failure;
    return typeof failure === "string" ? failure : null;
  }

  async cancel(): Promise<void> {
    await this.#request("download.cancel", {});
  }

  /** Deletes the file from the working folder too. */
  async delete(): Promise<void> {
    await this.#request("download.delete", {});
  }

  // Completion can take as long as the transfer, so no client limit applies.
  #request(method: string, params: PageOptions): Promise<unknown> {
    return round().call(method, { download: this.#id, ...params }, { op: method });
  }
}

/** A file chooser the runtime intercepted before any native dialog opened. */
export class FileChooser {
  readonly #page: Page;
  readonly #id: string;
  readonly #multiple: boolean;
  #handled = false;

  constructor(page: Page, result: Record<string, unknown>) {
    const id = result.chooser ?? result.id;
    if (typeof id !== "string" && typeof id !== "number") {
      throw new ZeniusError("ZEN_INTERNAL", "page.waitForFileChooser got no chooser id from the runtime");
    }
    this.#page = page;
    this.#id = String(id);
    this.#multiple = result.multiple === true || result.mode === "selectMultiple";
  }

  isMultiple(): boolean {
    return this.#multiple;
  }

  async setFiles(path: string | string[]): Promise<PageActionReceipt> {
    if (this.#handled) throw new Error("this file chooser was already handled");
    // A file that can't be read leaves the chooser open for another call.
    const paths = normalizeFilePaths(path, "fileChooser.setFiles");
    const files = await readUploads(paths, "fileChooser.setFiles");
    if (this.#handled) throw new Error("this file chooser was already handled");
    this.#handled = true;
    round().observe(this.#page.spaceId, this.#page.label);
    const result = receipt(
      await round().call(
        "filechooser.setFiles",
        { chooser: this.#id, files },
        { op: "fileChooser.setFiles", safetyTimeoutMs: UNSPECIFIED_LIMIT_MS },
      ),
    );
    round().noteUploads({ space: this.#page.spaceId, label: this.#page.label, paths, names: uploadNames(files) });
    return result;
  }
}

/** Each uploaded file as the page gets it: a folder upload's by its path in the folder. */
function uploadNames(files: readonly FilePayload[]): string[] {
  return files.map((file) => file.relativePath ?? file.name);
}

/** @internal Pages are only created by TaskSpace. */
export function createPage(task: TaskSpace, label: string, entry?: PageEntry): Page {
  return new Page(task, label, entry, CONSTRUCT);
}

// ---------------------------------------------------------------------------
// Validation and helpers, matching Ego's messages.

export function parseRef(input: unknown): string | null {
  const trimmed = String(input || "").trim();
  for (const candidate of [
    trimmed.startsWith("@") ? trimmed.slice(1) : null,
    trimmed.startsWith("ref=") ? trimmed.slice(4) : null,
    trimmed,
  ]) {
    if (candidate && /^\d+$/.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Ego's EGO_BROWSER_RESPONSE_TIMEOUT_MS, read per call as Ego reads it: tests
 * shorten the runtime's response wait (pending navigations, evaluate) with it.
 */
/** Ego's default screenshot path, with a random six-digit suffix. */
function defaultScreenshotPath(): string {
  const outputDir = (globalThis as { EGO_BROWSER_OUTPUT_DIR?: unknown }).EGO_BROWSER_OUTPUT_DIR;
  let directory = os.tmpdir();
  if (outputDir !== undefined) {
    if (typeof outputDir !== "string" || outputDir.length === 0 || !nodePath.isAbsolute(outputDir)) {
      throw new TypeError("globalThis.EGO_BROWSER_OUTPUT_DIR must be an absolute directory path");
    }
    directory = outputDir;
  }
  const suffix = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return nodePath.join(directory, `zenius-shot-${suffix}.png`);
}

function receipt(result: unknown): PageActionReceipt {
  return result && typeof result === "object" && !Array.isArray(result) ? (result as PageActionReceipt) : {};
}

/** The client-side limit for a request whose runtime timeout comes from `options`. */
function limit(options: PageOptions | undefined): number {
  const timeout = options?.timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) ? timeout + GRACE_MS : UNSPECIFIED_LIMIT_MS;
}

/**
 * The client's limit for an action that options.delay pauses `pauses` times
 * (twice per click, once per key press): the runtime still acts after the
 * timeout's actionability wait, and Ego cuts nothing on the client.
 */
export function clientLimitMs(options: PageOptions | undefined, pauses = 0): number {
  return limit(options) + numberOr(options?.delay, 0) * pauses;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function tabId(result: Record<string, unknown> | null): string | undefined {
  const id = result?.targetId ?? result?.tab;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertUrl(url: unknown): void {
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError("page URL must be a non-empty string");
  }
}

function assertSelector(selector: unknown): void {
  if (typeof selector !== "string" || selector.trim().length === 0) {
    throw new TypeError("Page actions require a non-empty selector string");
  }
}

function assertPoint(x: unknown, y: unknown, operation: string): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(`${operation} requires finite x and y coordinates`);
  }
}

/** Ego looks each key up in its layout, so an empty or non-string one is just unknown, as a plain Error. */
function assertKey(key: unknown): void {
  if (typeof key !== "string" || key.length === 0) throw new Error(`Unknown key: ${JSON.stringify(key)}`);
}

/**
 * Split a chord without losing a literal `+` key, as Playwright does. The
 * messages name keyboard.press for page.press too, as Ego's do.
 */
export function splitChord(chord: unknown): string[] {
  if (typeof chord !== "string" || chord.length === 0) {
    throw new TypeError("page.keyboard.press requires a non-empty key");
  }
  const tokens: string[] = [];
  let building = "";
  for (const character of chord) {
    if (character === "+" && building) {
      tokens.push(building);
      building = "";
    } else {
      building += character;
    }
  }
  tokens.push(building);
  if (tokens.some((token) => token.length === 0)) {
    throw new TypeError(`page.keyboard.press received invalid chord: ${chord}`);
  }
  return tokens;
}

function normalizeFilePaths(path: unknown, methodName: string): string[] {
  const files = Array.isArray(path) ? path : [path];
  if (files.some((file) => typeof file !== "string" || file.length === 0 || !nodePath.isAbsolute(file))) {
    throw new TypeError(`${methodName} requires absolute file paths`);
  }
  return files as string[];
}

function snapshotOptionsError(message: string): TypeError {
  return new TypeError(`${message}. Expected: ${apiEntry("Page.snapshot")?.signature}`);
}

function describeArgument(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function assertClipboardContent(content: unknown): void {
  if (typeof content === "string") return;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new TypeError(`page.keyboard.paste requires a string or { text, html? }, received ${describeArgument(content)}`);
  }
  const value = content as Record<string, unknown>;
  const unknown = Object.keys(value).find((key) => key !== "text" && key !== "html");
  if (unknown) throw new TypeError(`page.keyboard.paste received unknown content field: ${unknown}`);
  if (typeof value.text !== "string") throw new TypeError("page.keyboard.paste content.text must be a string");
  if (value.html !== undefined && typeof value.html !== "string") {
    throw new TypeError("page.keyboard.paste content.html must be a string");
  }
}

function pickHtml(content: unknown): { html?: string } {
  const html = (content as { html?: unknown }).html;
  return typeof html === "string" ? { html } : {};
}

function validateSelectOptionChoice(choice: unknown, index: number): void {
  const path = `page.selectOption valueOrValues[${index}]`;
  if (typeof choice === "string") return;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    throw new TypeError(`${path} must be a string or an object with value, label, or index`);
  }
  const value = choice as Record<string, unknown>;
  const unknown = Object.keys(value).find((key) => key !== "value" && key !== "label" && key !== "index");
  if (unknown) throw new TypeError(`${path} has unknown field ${JSON.stringify(unknown)}`);
  if (value.value === undefined && value.label === undefined && value.index === undefined) {
    throw new TypeError(`${path} must specify value, label, or index`);
  }
  if (value.value !== undefined && typeof value.value !== "string") throw new TypeError(`${path}.value must be a string`);
  if (value.label !== undefined && typeof value.label !== "string") throw new TypeError(`${path}.label must be a string`);
  if (value.index !== undefined && (!Number.isInteger(value.index) || (value.index as number) < 0)) {
    throw new TypeError(`${path}.index must be a non-negative integer`);
  }
}

function looksLikeWaitForFunctionOptions(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === "timeout" || key === "polling");
}

function validateEvaluateInput(apiName: string, expression: unknown, hasArgument: boolean, argument: unknown): unknown {
  if (typeof expression !== "string" && typeof expression !== "function") {
    throw new TypeError(`${apiName} expects a function or string expression`);
  }
  if (typeof expression === "string") {
    if (expression.length === 0) throw new TypeError(`${apiName} expression must not be empty`);
    if (hasArgument) throw new TypeError(`${apiName} string expression does not accept an argument`);
    return undefined;
  }
  return hasArgument ? serializeJsonValue(argument, `${apiName} argument must be JSON-serializable`) : undefined;
}

/** `arg` is present exactly when the caller passed one, so the runtime can tell f() from f(undefined). */
function evaluateParams(expression: unknown, hasArgument: boolean, serialized: unknown): PageOptions {
  const isFunction = typeof expression === "function";
  const params: PageOptions = { fn: isFunction ? (expression as Function).toString() : expression, isFunction };
  if (hasArgument) params.arg = serialized;
  return params;
}

function serializeJsonValue(value: unknown, message: string): unknown {
  try {
    const json = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint" || (typeof item === "number" && !Number.isFinite(item))) {
        throw new TypeError("unsupported value");
      }
      return item;
    });
    if (json === undefined) throw new TypeError("unsupported value");
    return JSON.parse(json);
  } catch (error) {
    throw new TypeError(message, { cause: error });
  }
}

function enrichCallbackReferenceError(error: unknown, apiName: string): unknown {
  if (
    !(error instanceof Error) ||
    !/\bReferenceError\b.* is not defined/.test(error.message) ||
    error.message.includes("cannot access variables from the Node.js script")
  ) {
    return error;
  }
  const hint =
    `${apiName}() callbacks run inside the Page and cannot access variables ` +
    "from the Node.js script. Define the value inside the callback or pass " +
    "JSON data as the second argument.";
  // For a callback this is the next step, in place of the general one.
  const general = `\n${CODE_GUIDE.ZEN_EVALUATION_FAILED!.next}`;
  error.message = error.message.includes(general) ? error.message.replace(general, `\n${hint}`) : `${error.message}\n${hint}`;
  return error;
}

function matchesPredicate(predicate: (url: URL) => unknown, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  let result: unknown;
  try {
    result = predicate(parsed);
  } catch (error) {
    // Agents often treat the argument as a string (`url.includes(...)`).
    if (!(error instanceof TypeError)) throw error;
    throw new TypeError(
      `page.waitForURL predicate threw: ${error.message}. The predicate receives a URL object; use url.href, url.pathname, or url.searchParams.`,
      { cause: error },
    );
  }
  if (typeof result !== "boolean") {
    throw new TypeError("page.waitForURL predicate must return a boolean synchronously");
  }
  return result;
}

const URL_REGEX_SPECIAL_CHARS = new Set(["$", "^", "+", ".", "*", "(", ")", "|", "\\", "?", "{", "}", "[", "]"]);

/** Compile the URL-glob subset used by Playwright string matchers. */
export function urlGlobToRegExp(glob: string): RegExp {
  const tokens = ["^"];
  let inGroup = false;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "\\" && index + 1 < glob.length) {
      const escaped = glob[(index += 1)]!;
      tokens.push(URL_REGEX_SPECIAL_CHARS.has(escaped) ? `\\${escaped}` : escaped);
      continue;
    }
    if (char === "*") {
      const charBefore = glob[index - 1];
      let starCount = 1;
      while (glob[index + 1] === "*") {
        starCount += 1;
        index += 1;
      }
      if (starCount === 1) {
        tokens.push("[^/]*");
        continue;
      }
      const charAfter = glob[index + 1];
      if (charAfter === "/") {
        tokens.push(charBefore === "/" ? "(?:(?:.+)/)?" : "(?:.*/)");
        index += 1;
      } else {
        tokens.push(".*");
      }
      continue;
    }
    if (char === "{") {
      if (inGroup) throw invalidUrlGlob(glob, "nested '{' is not supported");
      inGroup = true;
      tokens.push("(");
      continue;
    }
    if (char === "}") {
      if (!inGroup) throw invalidUrlGlob(glob, "unmatched '}'");
      inGroup = false;
      tokens.push(")");
      continue;
    }
    if (char === "," && inGroup) {
      tokens.push("|");
      continue;
    }
    tokens.push(URL_REGEX_SPECIAL_CHARS.has(char) ? `\\${char}` : char);
  }
  if (inGroup) throw invalidUrlGlob(glob, "unmatched '{'");
  tokens.push("$");
  return new RegExp(tokens.join(""));
}

function invalidUrlGlob(glob: string, reason: string): TypeError {
  return new TypeError(`Invalid URL glob ${JSON.stringify(glob)}: ${reason}`);
}
