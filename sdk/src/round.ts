// State that lives for one script run: the connection, the Pages the script
// touched, and the spaces it worked in. Labels, refs and ledgers live in the
// runtime; this only remembers what the agent has seen, so the run can point
// out Pages that appeared without the agent noticing.
//
// A `zenius nodejs` run is one Node process with one round. `zenius mcp` runs
// each script tool call in its own round, on a connection of its own, inside
// the server's process (runInRound): whatever the script starts, its timers
// and promises included, keeps that round, so its calls go on its connection
// and fail once the call has ended: the script's signal aborts then
// (rpc.ts SCRIPT_CALL_OVER), and the connection closes.

import { isHardStopCode, ZeniusError } from "./errors.ts";
import { asyncHooks } from "./node.ts";
import { addNotice } from "./output.ts";
import { RpcClient, type CallOptions } from "./rpc.ts";

type SpaceState = {
  /** Labels the script used through a Page handle, created, or adopted. */
  observed: Set<string>;
  /** finish() succeeded or control left the agent: nothing to report. */
  ended: boolean;
  /** finish() succeeded: the task is over. */
  finished?: boolean;
};

export type RoundOptions = {
  client: RpcClient;
  /** Report per-request timings on stderr. */
  timing?: boolean;
};

export type TimingRecord = { method: string; ms: number; ok: boolean };

/** Files a script uploaded through one call: the paths it named, each file's name as the page got it, and the Page. */
export type UploadNote = { space: number; label: string; paths: string[]; names: string[] };

export class Round {
  readonly client: RpcClient;
  readonly startedAt = Date.now();
  readonly timings: TimingRecord[] = [];
  readonly #spaces = new Map<number, SpaceState>();
  /** The last Page a call of this round named, so the MCP server can go on there after a script. */
  lastPage: { space: number; label: string } | undefined;
  /** Hears each upload's files once the runtime took them (the MCP server lists them after a script). */
  onUploads: ((note: UploadNote) => void) | undefined;
  /** The last hard stop a call of this round met (the user has the task, or it ended). */
  lastHardStop: ZeniusError | undefined;

  constructor(options: RoundOptions) {
    this.client = options.client;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    const space = typeof params.space === "number" ? params.space : undefined;
    if (space !== undefined && typeof params.page === "string") this.lastPage = { space, label: params.page };
    try {
      const result = await this.client.call<T>(method, params, options);
      if (method === "spaces.finish" && space !== undefined) this.space(space).finished = true;
      return result;
    } catch (error) {
      if (space !== undefined && error instanceof ZeniusError && isHardStopCode(error.code, error.data)) {
        this.space(space).ended = true;
        this.lastHardStop = error;
      }
      throw error;
    }
  }

  /** Whether a call of this round finished the task. */
  finished(spaceId: number): boolean {
    return this.#spaces.get(spaceId)?.finished === true;
  }

  space(spaceId: number): SpaceState {
    let state = this.#spaces.get(spaceId);
    if (!state) {
      state = { observed: new Set(), ended: false };
      this.#spaces.set(spaceId, state);
    }
    return state;
  }


  /** An upload's files reached the runtime: page.setInputFiles or fileChooser.setFiles. */
  noteUploads(note: UploadNote): void {
    this.onUploads?.(note);
  }

  observe(spaceId: number, label: string): void {
    this.space(spaceId).observed.add(label);
  }

  endSpace(spaceId: number): void {
    this.space(spaceId).ended = true;
  }

  /** The user handed the space back after a hard stop: it's the agent's again. */
  resumeSpace(spaceId: number): void {
    this.space(spaceId).ended = false;
  }

  /**
   * Point out Pages that opened during this run (popups, target=_blank links)
   * that the script never used. It costs one request per space the script
   * worked in, and needs `createdAt` in the runtime's pages.list; without it
   * the check is skipped.
   */
  async reportUnhandledPages(): Promise<void> {
    const lines: string[] = [];
    for (const [spaceId, state] of this.#spaces) {
      if (state.ended || this.client.failed) continue;
      let pages: unknown;
      try {
        pages = await this.client.call("pages.list", { space: spaceId }, { op: "pages.list", safetyTimeoutMs: 5_000 });
      } catch {
        continue;
      }
      if (!Array.isArray(pages)) continue;
      for (const page of pages) {
        if (!page || typeof page !== "object") continue;
        const { label, createdAt, opener, openedBy, url } = page as Record<string, unknown>;
        if (typeof label !== "string" || typeof createdAt !== "number") continue;
        if (createdAt < this.startedAt || state.observed.has(label) || openedBy === "user") continue;
        const source = typeof opener === "string" && opener ? ` from ${opener}` : "";
        const where = typeof url === "string" && url ? url.replace(/\s+/g, " ").trim() : "about:blank";
        lines.push(`Unhandled page ${label}${source}: ${where}`);
      }
    }
    if (lines.length > 0) addNotice(`[zenius:pages]\n${lines.join("\n")}`);
  }
}

let current: Round | undefined;
/** The round of the script tool call that code runs for, inside zenius mcp. */
/** The script tool's rounds, made at zenius mcp's first script: a `zenius nodejs` run never needs one. */
let scoped: import("node:async_hooks").AsyncLocalStorage<Round> | undefined;

export function setRound(round: Round | undefined): void {
  current = round;
}

/** Run `fn` in `round`: every call it makes, now or later, goes there, whatever setRound says. */
export function runInRound<T>(round: Round, fn: () => T): T {
  scoped ??= new (asyncHooks().AsyncLocalStorage)<Round>();
  return scoped.run(round, fn);
}

export function round(): Round {
  const scopedRound = scoped?.getStore();
  if (scopedRound) return scopedRound;
  if (!current) {
    throw new ZeniusError(
      "ZEN_BROWSER_UNAVAILABLE",
      "no zenius connection is set up in this process; run scripts through `zenius nodejs`",
    );
  }
  return current;
}
