// Portions adapted from citrolabs/ego-lite (MIT License).
//
// TaskSpace: one agent task, a set of tabs in the shared Agents Space (or, once
// claimed, in one of the user's Spaces). The runtime owns the Page
// ledger (labels, origins, budget); this class names requests and shapes
// results the way Ego's TaskSpace does.

import { validateOptions } from "./api-schema.ts";
import { CODE_GUIDE } from "./error-guide.ts";
import { unsupportedCdpError, ZeniusError } from "./errors.ts";
import { CONSTRUCT, EXPLAIN_PAGE_ERROR, NOTE_ENTRY, SEED_PAGES } from "./internal.ts";
import { bufferOutput, clearHardStop } from "./output.ts";
import { createPage, Page } from "./page.ts";
import { round } from "./round.ts";

const GRACE_MS = 10_000;
const SPACE_TIMEOUT_MS = 15_000;
const CONTROL_WAIT_TIMEOUT_MS = 600_000;

export type TaskSpaceDescriptor = {
  taskId?: string | number;
  id: number;
  name: string;
  createdBy?: string;
  ownership?: string;
  recentTabTitles?: string[];
  [key: string]: unknown;
};

/**
 * Puts back the space's state text that handOff({ message }) replaced, once
 * the agent has control again. The SDK sets that text nowhere else, so what
 * it replaced is always empty, and it may clear it without knowing whether
 * this hand-off had a message (another script may have handed off). Best
 * effort: the text is only shown, and the call already did its work.
 */
export async function clearHandOffMessage(space: number, op: string): Promise<void> {
  try {
    await round().call("spaces.setState", { space, text: "" }, { op, safetyTimeoutMs: SPACE_TIMEOUT_MS + GRACE_MS });
  } catch {
    // The user may have taken the task again at once; the text then waits for the next hand back.
  }
}

/**
 * How the user handed control back, as spaces.takeOver and
 * spaces.waitForControl report it (PROTOCOL), once per hand back.
 */
export type HandBack = { openerCut?: true; reloaded?: readonly string[] };

export type TabInventoryItem = {
  targetId: string;
  label?: string;
  page: Page | UnmanagedPage;
  title: string;
  url: string;
  active: boolean;
  openedBy: string;
};

export type TaskFinishReceipt = {
  spaceId: number;
  closedSpace: boolean;
  keptManagedLabels: string[];
  closedManagedLabels: string[];
  preservedUnmanagedCount: number;
};

export type UserPageEntry = { label?: unknown; tab?: unknown; targetId?: unknown; openedBy?: unknown } | null | undefined;

export class TaskSpace {
  readonly taskId?: string | number;
  readonly id: number;
  readonly name: string;
  readonly createdBy?: string;
  readonly ownership?: string;
  readonly recentTabTitles?: string[];
  #userPage?: Page | UnmanagedPage;
  #handBack?: Readonly<HandBack>;
  #finished = false;
  /**
   * What this process knows about each label. Ego reads page.targetId and
   * openedBy from its ledger the moment a handle is made; taskSpace() fills
   * this before it returns, and listings and receipts keep it current.
   */
  readonly #entries = new Map<string, { targetId?: string; openedBy?: string }>();

  constructor(descriptor: TaskSpaceDescriptor, token: symbol) {
    if (token !== CONSTRUCT) {
      throw new TypeError("TaskSpace handles come from taskSpace(), claimTaskSpace() or takeOverTaskSpace()");
    }
    if (!descriptor || !Number.isInteger(descriptor.id)) throw new TypeError("TaskSpace requires a numeric id");
    this.taskId = descriptor.taskId;
    this.id = descriptor.id;
    this.name = descriptor.name;
    this.createdBy = descriptor.createdBy;
    this.ownership = descriptor.ownership;
    this.recentTabTitles = descriptor.recentTabTitles;
    this.#noteHandBack(descriptor);
  }

  /**
   * How the user handed control back, when takeOverTaskSpace() or
   * waitForControl() reported it. The runtime reports each hand back once.
   * - `openerCut: true`: during the hold, the page they held moved to another
   *   browsing context group, so it lost its opener; a sign-in popup's report
   *   to the agent's Page never arrived.
   * - `reloaded`: the labels of the Pages zenius loaded afresh since the agent
   *   last had control, the hand-off's own reloads included.
   * The own tab, and its `via: "ownTab"`, went with zen-ux's safe holds.
   */
  get handBack(): Readonly<HandBack> | undefined {
    return this.#handBack;
  }

  #noteHandBack(report: Readonly<Record<string, unknown>> | null | undefined): void {
    // Only true is the flag: the runtime sends it present and true, or not at all.
    const openerCut = report?.openerCut === true;
    const reloaded =
      Array.isArray(report?.reloaded) && report.reloaded.length > 0 && report.reloaded.every((label) => typeof label === "string")
        ? Object.freeze([...(report.reloaded as string[])])
        : undefined;
    if (!openerCut && !reloaded) return;
    this.#handBack = Object.freeze({
      ...(openerCut ? { openerCut: true as const } : {}),
      ...(reloaded ? { reloaded } : {}),
    });
  }

  /** Stable task-space identifier; `id` stays as an alias. */
  get spaceId(): number {
    return this.id;
  }

  page(label: string): Page {
    return createPage(this, label, this.#entries.get(label));
  }

  userPage(): Page | UnmanagedPage | undefined {
    return this.#userPage;
  }

  async pages(): Promise<Page[]> {
    const result = await this.#call<unknown>("pages.list", "task.pages", {});
    const pages = Array.isArray(result) ? result : asArray((result as { pages?: unknown } | null)?.pages);
    return pages
      .filter((entry): entry is Record<string, unknown> => typeof (entry as { label?: unknown })?.label === "string")
      .map((entry) => this.#pageFrom(entry.label as string, { targetId: tabIdOf(entry), openedBy: stringOr(entry.openedBy) }));
  }

  async tabs(): Promise<TabInventoryItem[]> {
    const result = await this.#call<unknown>("tabs.list", "task.tabs", {});
    const tabs = Array.isArray(result) ? result : asArray((result as { tabs?: unknown } | null)?.tabs);
    return tabs.map((tab) => this.#inventoryItem(tab as Record<string, unknown>));
  }

  async waitForControl(options: Record<string, unknown> = {}): Promise<void> {
    validateOptions("TaskSpace.waitForControl", options);
    const timeout = typeof options.timeout === "number" ? options.timeout : CONTROL_WAIT_TIMEOUT_MS;
    const params: Record<string, unknown> = {};
    if (options.interval !== undefined) params.interval = options.interval;
    if (options.timeout !== undefined) params.timeout = options.timeout;
    const result = await this.#call<Record<string, unknown> | null>("spaces.waitForControl", "task.waitForControl", params, timeout + GRACE_MS);
    if (result?.ownership === "agent") {
      // The user's hand back ends a hard stop this space raised earlier in the
      // run, which the script caught: its output shows after all (output.ts).
      clearHardStop(this.id);
      round().resumeSpace(this.id);
    }
    this.#noteHandBack(result);
    await clearHandOffMessage(this.id, "task.waitForControl");
  }

  async handOff(options: { message?: string } = {}): Promise<void> {
    validateOptions("TaskSpace.handOff", options);
    const message = options.message?.trim();
    if (options.message !== undefined && !message) {
      throw new TypeError('task.handOff message must name the step, such as "Sign in at 10.0.0.1". Expected: await task.handOff({ message? })');
    }
    // The hold card in the agent's tab shows the space's state text as the
    // agent's words (zen-ux), so the message goes there before the hand-off.
    if (message) await this.#call("spaces.setState", "task.handOff", { text: message });
    try {
      await this.#call("spaces.handOff", "task.handOff", {});
    } catch (error) {
      // Refused, the task stays the agent's: the message mustn't linger as
      // its progress text in the panel.
      if (message) await clearHandOffMessage(this.id, "task.handOff");
      throw error;
    }
    round().endSpace(this.id);
  }

  async finish(options: { keep: "all" | string[] }): Promise<TaskFinishReceipt> {
    validateOptions("TaskSpace.finish", options);
    if (!Object.hasOwn(options, "keep") || options.keep === undefined) {
      throw new TypeError("task.finish requires the keep option. Expected: await task.finish({ keep })");
    }
    const result = await this.#call<Record<string, unknown>>("spaces.finish", "task.finish", { keep: options.keep });
    this.#finished = true;
    round().endSpace(this.id);
    const finished = finishReceipt(this.id, result ?? {});
    const keepsNothing = Array.isArray(options.keep) && options.keep.length === 0;
    if (keepsNothing && !finished.closedSpace) {
      const protectedCount =
        typeof result?.protectedTabCount === "number"
          ? result.protectedTabCount
          : Array.isArray(result?.protected)
            ? result.protected.length
            : finished.preservedUnmanagedCount;
      bufferOutput(
        `[zenius] finish({ keep: [] }) did not close task space ${this.id}: ` +
          `${protectedCount} tab(s) of user or unknown origin stayed open, ` +
          "and the space now belongs to the user.\n",
      );
    }
    return finished;
  }

  async cdp(..._args: unknown[]): Promise<never> {
    throw unsupportedCdpError("task.cdp");
  }

  async adopt(page: UnmanagedPage, options: { as?: string } = {}): Promise<Page> {
    validateOptions("TaskSpace.adopt", options);
    if (!(page instanceof UnmanagedPage)) {
      throw new TypeError("task.adopt requires an untracked page returned by task.tabs()");
    }
    if (page.spaceId !== this.id) {
      throw new Error(`untracked page ${page.targetId} belongs to space ${page.spaceId}, not space ${this.id}`);
    }
    const params: Record<string, unknown> = { tab: page.targetId };
    if (options.as !== undefined) params.as = options.as;
    const result = await this.#call<Record<string, unknown>>("pages.adopt", "task.adopt", params);
    const label = requireLabel(result, "task.adopt");
    round().observe(this.id, label);
    return this.#pageFrom(label, { targetId: page.targetId, openedBy: page.openedBy });
  }

  async release(label: string, options: { group?: boolean } = {}): Promise<UnmanagedPage> {
    if (typeof label !== "string" || label.length === 0) {
      throw new TypeError("task.release requires a Page label such as p2");
    }
    validateOptions("TaskSpace.release", options);
    // group: an opener and its popups share a window group, so the runtime
    // hands them to the user together or not at all (closed groups). The
    // reply's released lists them; the named Page comes first and is returned.
    const params: Record<string, unknown> = { page: label };
    if (options.group !== undefined) params.group = options.group;
    const result = await this.#call<Record<string, unknown>>("pages.release", "task.release", params);
    const targetId = tabIdOf(result);
    if (!targetId) throw new ZeniusError("ZEN_INTERNAL", "task.release got no tab id from the runtime");
    return createUnmanagedPage(this, targetId, stringOr(result?.openedBy) ?? "unknown");
  }

  async newPage(...args: unknown[]): Promise<Page> {
    if (args.length > 0) throw new TypeError("task.newPage does not accept arguments");
    const result = await this.#call<Record<string, unknown>>("pages.new", "task.newPage", {});
    const label = requireLabel(result, "task.newPage");
    round().observe(this.id, label);
    return this.#pageFrom(label, { targetId: tabIdOf(result), openedBy: "agent" });
  }

  /** Remember the tab that was active when control came back to the agent. */
  [NOTE_ENTRY](entry: UserPageEntry): void {
    if (!entry || typeof entry !== "object") {
      this.#userPage = undefined;
      return;
    }
    const label = stringOr(entry.label);
    const targetId = tabIdOf(entry as Record<string, unknown>);
    const openedBy = stringOr(entry.openedBy);
    if (label) {
      this.#userPage = this.#pageFrom(label, { targetId, openedBy });
    } else if (targetId) {
      this.#userPage = createUnmanagedPage(this, targetId, openedBy ?? "unknown");
    }
  }

  /** Explain a missing label in task terms, as Ego does. */
  [EXPLAIN_PAGE_ERROR](label: string, error: unknown): unknown {
    if (!(error instanceof ZeniusError) || error.code !== "ZEN_PAGE_NOT_FOUND") return error;
    // What this task knows says what to do better than the code's general
    // next step, so it takes that line's place.
    const general = `\n${CODE_GUIDE.ZEN_PAGE_NOT_FOUND!.next}`;
    const happened = error.message.replace(general, "");
    let next: string | undefined;
    if (this.#finished) {
      next = `Task space ${this.id} already finished, which ended its Page labels; do not use Pages after task.finish().`;
    } else if (this.ownership === "user") {
      next =
        `Task space ${this.id} is owned by the user, so labels from a finished Agent task no longer exist; ` +
        "stop operating it unless the user asks you to continue.";
    } else if (!/task\.newPage\(\)/.test(happened)) {
      next = `task.page(${JSON.stringify(label)}) only refers to an existing Page; list them with await task.pages() or create one with await task.newPage().`;
    }
    if (next) error.message = `${happened}\n${next}`;
    return error;
  }

  #call<T = unknown>(method: string, op: string, params: Record<string, unknown>, safetyTimeoutMs = SPACE_TIMEOUT_MS + GRACE_MS): Promise<T> {
    return round().call<T>(method, { space: this.id, ...params }, { op, safetyTimeoutMs });
  }

  #pageFrom(label: string, entry?: { targetId?: string; openedBy?: string }): Page {
    this.#remember(label, entry);
    return createPage(this, label, this.#entries.get(label) ?? entry);
  }

  #remember(label: string, entry?: { targetId?: string; openedBy?: string }): void {
    if (typeof entry?.targetId !== "string") return;
    this.#entries.set(label, { targetId: entry.targetId, ...(entry.openedBy ? { openedBy: entry.openedBy } : {}) });
  }

  /**
   * Learn the managed Pages from a runtime listing: label strings or
   * {label, tab, openedBy} entries. True when every entry named its tab, so
   * nothing more needs fetching.
   */
  [SEED_PAGES](pages: unknown): boolean {
    if (!Array.isArray(pages)) return false;
    let complete = true;
    for (const entry of pages) {
      const label = typeof entry === "string" ? entry : stringOr((entry as Record<string, unknown> | null)?.label);
      if (!label) continue;
      const targetId = typeof entry === "object" && entry ? tabIdOf(entry as Record<string, unknown>) : undefined;
      if (!targetId) {
        complete = false;
        continue;
      }
      this.#remember(label, { targetId, openedBy: stringOr((entry as Record<string, unknown>).openedBy) });
    }
    return complete;
  }

  #inventoryItem(tab: Record<string, unknown>): TabInventoryItem {
    const targetId = tabIdOf(tab) ?? "";
    const label = stringOr(tab.label);
    const openedBy = stringOr(tab.openedBy) ?? "unknown";
    // Ego lists `label` second, and only for managed tabs.
    return {
      targetId,
      ...(label ? { label } : {}),
      page: label ? this.#pageFrom(label, { targetId, openedBy }) : createUnmanagedPage(this, targetId, openedBy),
      title: stringOr(tab.title) ?? "",
      url: stringOr(tab.url) ?? "",
      active: Boolean(tab.active),
      openedBy,
    };
  }
}

/**
 * A read-only identity for a live tab the Page model does not manage. Get one
 * from task.tabs(), then task.adopt() it before operating the tab.
 */
export class UnmanagedPage {
  readonly spaceId: number;
  readonly targetId: string;
  readonly openedBy: string;

  constructor(task: TaskSpace, targetId: string, openedBy: string, token: symbol) {
    if (token !== CONSTRUCT) throw new TypeError("UnmanagedPage handles can only be obtained from task.tabs()");
    this.spaceId = task.id;
    this.targetId = targetId;
    this.openedBy = openedBy;
    Object.freeze(this);
  }
}

export function createTaskSpace(descriptor: TaskSpaceDescriptor): TaskSpace {
  return new TaskSpace(descriptor, CONSTRUCT);
}

function createUnmanagedPage(task: TaskSpace, targetId: string, openedBy: string): UnmanagedPage {
  return new UnmanagedPage(task, targetId, openedBy, CONSTRUCT);
}

/** Accept Ego's receipt shape, or PROTOCOL's {closed, kept, protected}. */
function finishReceipt(spaceId: number, result: Record<string, unknown>): TaskFinishReceipt {
  const closedSpace = typeof result.closedSpace === "boolean" ? result.closedSpace : Boolean(result.closed);
  const kept = asStrings(result.keptManagedLabels ?? result.kept);
  const closed = asStrings(result.closedManagedLabels ?? result.closedLabels);
  const preserved =
    typeof result.preservedUnmanagedCount === "number"
      ? result.preservedUnmanagedCount
      : Array.isArray(result.protected)
        ? result.protected.length
        : 0;
  return {
    spaceId,
    closedSpace,
    keptManagedLabels: closedSpace ? [] : kept,
    closedManagedLabels: closed,
    preservedUnmanagedCount: preserved,
  };
}

function requireLabel(result: Record<string, unknown> | null | undefined, op: string): string {
  const label = result?.label;
  if (typeof label !== "string" || !label) throw new ZeniusError("ZEN_INTERNAL", `${op} got no Page label from the runtime`);
  return label;
}

function tabIdOf(value: Record<string, unknown> | null | undefined): string | undefined {
  const id = value?.targetId ?? value?.tab;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
