// State that lives for one script run (one Node process): the connection, the
// Pages the script touched, and the spaces it worked in. Labels, refs and
// ledgers live in the runtime; this only remembers what the agent has seen, so
// the run can point out Pages that appeared without the agent noticing.

import { isHardStopCode, ZeniusError } from "./errors.ts";
import { addNotice } from "./output.ts";
import { RpcClient, type CallOptions } from "./rpc.ts";

type SpaceState = {
  /** Labels the script used through a Page handle, created, or adopted. */
  observed: Set<string>;
  /** finish() succeeded or control left the agent: nothing to report. */
  ended: boolean;
};

export type RoundOptions = {
  client: RpcClient;
  /** Report per-request timings on stderr. */
  timing?: boolean;
};

export type TimingRecord = { method: string; ms: number; ok: boolean };

export class Round {
  readonly client: RpcClient;
  readonly startedAt = Date.now();
  readonly timings: TimingRecord[] = [];
  readonly #spaces = new Map<number, SpaceState>();

  constructor(options: RoundOptions) {
    this.client = options.client;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    const space = typeof params.space === "number" ? params.space : undefined;
    try {
      return await this.client.call<T>(method, params, options);
    } catch (error) {
      if (space !== undefined && error instanceof ZeniusError && isHardStopCode(error.code, error.data)) {
        this.space(space).ended = true;
      }
      throw error;
    }
  }

  space(spaceId: number): SpaceState {
    let state = this.#spaces.get(spaceId);
    if (!state) {
      state = { observed: new Set(), ended: false };
      this.#spaces.set(spaceId, state);
    }
    return state;
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

export function setRound(round: Round | undefined): void {
  current = round;
}

export function round(): Round {
  if (!current) {
    throw new ZeniusError(
      "ZEN_BROWSER_UNAVAILABLE",
      "no zenius connection is set up in this process; run scripts through `zenius nodejs`",
    );
  }
  return current;
}
