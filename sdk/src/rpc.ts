// NDJSON request/response client for the runtime's Unix socket (PROTOCOL.md).
//
// Requests are written synchronously in call order, so `const p =
// page.waitForEvent("popup"); await page.click(…)` reaches the runtime with the
// waiter first. Requests may run concurrently; responses carry the id.
//
// zenius mcp runs each tool call with an AbortSignal (withSignal): a call made
// for a tool call that its client cancels fails here at once, and the runtime
// stops it (calls.cancel), so a canceled wait ends there too.

import type { Socket } from "node:net";

import { fromWireError, ZeniusError } from "./errors.ts";
import { asyncHooks, net } from "./node.ts";
import { configuredPageBudget } from "./config.ts";

export type Hello = {
  protocol?: number;
  instance?: string;
  runtimeVersion?: string;
  zenVersion?: string;
};

export const PROTOCOL_VERSION = 1;

type Pending = {
  method: string;
  op: string;
  /** Where the script made the call; runtime errors otherwise carry only socket frames. */
  site: { stack?: string };
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  safetyTimeoutMs?: number;
  startedAt: number;
  /** When the runtime's gate started holding the call, while it holds it. */
  heldSince?: number;
  /** Total time the gate held the call. */
  heldMs: number;
  /** The task space the call addressed, for the end-of-run hold notice and its hard stop. */
  space?: number;
  /** An SDK-internal call whose failure the script never sees. */
  quiet?: boolean;
  /** Stops listening to the canceling signal (withSignal). */
  unlisten?: () => void;
};

export type CallOptions = {
  /** Public API name used in error messages, e.g. `page.click`. */
  op?: string;
  /** Client-side safety limit; the runtime bounds the operation itself. */
  safetyTimeoutMs?: number;
  /**
   * The SDK's own bookkeeping, not the script's call: a hard stop it meets is
   * not recorded, since the script didn't meet it and may never.
   */
  quiet?: boolean;
};

export type EventListener = (event: string, params: unknown) => void;

/** The tool call that code runs for in zenius mcp, made on its first one: a `zenius nodejs` run has none. */
let callSignals: import("node:async_hooks").AsyncLocalStorage<AbortSignal> | undefined;

/**
 * Run `fn` for a tool call that `signal` cancels: each call any RpcClient
 * makes in its context, its continuations included, is canceled with it.
 */
export function withSignal<T>(signal: AbortSignal, fn: () => T): T {
  callSignals ??= new (asyncHooks().AsyncLocalStorage)<AbortSignal>();
  return callSignals.run(signal, fn);
}

function canceledError(op: string): ZeniusError {
  return new ZeniusError("ZEN_CANCELED", `${op}: canceled, since the client canceled the tool call it was for`);
}

export type RpcClientOptions = {
  socketPath: string;
  instance: string;
  /** Called after every response, for timing logs; `heldMs` is time the runtime's gate held the call. */
  onTiming?: (method: string, ms: number, ok: boolean, heldMs: number) => void;
  /** Called when the runtime starts or stops holding a call ({held, reason} frames), such as the self-check's wait for Zen to be in the background. */
  onHeld?: (method: string, held: boolean, reason: string | undefined) => void;
};

export class RpcClient {
  readonly socketPath: string;
  readonly instance: string;
  hello: Hello | undefined;
  /** performance.now() when the socket connected and the hello arrived (for --timing). */
  connectedAt: number | undefined;
  helloAt: number | undefined;
  #socket: Socket | undefined;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  /** Pieces of the line still arriving; joined once its newline comes. */
  #parts: string[] = [];
  #failure: ZeniusError | undefined;
  #listeners = new Set<EventListener>();
  #onTiming: RpcClientOptions["onTiming"];
  #onHeld: RpcClientOptions["onHeld"];
  #closed = false;
  #heldBySpace = new Map<number, number>();

  constructor(options: RpcClientOptions) {
    this.socketPath = options.socketPath;
    this.instance = options.instance;
    this.#onTiming = options.onTiming;
    this.#onHeld = options.onHeld;
  }

  /** Open the socket early so the handshake overlaps script compilation. */
  connect(): void {
    if (this.#socket || this.#closed) return;
    // Outside any tool call's context (withSignal): the socket's events belong
    // to no call, and must never carry one that its client canceled.
    const open = () => net().createConnection(this.socketPath);
    const socket = callSignals ? callSignals.exit(open) : open();
    this.#socket = socket;
    socket.once("connect", () => (this.connectedAt = performance.now()));
    socket.setEncoding("utf8");
    socket.setNoDelay?.(true);
    socket.on("data", (chunk: string) => this.#onData(chunk));
    socket.on("error", (error: NodeJS.ErrnoException) => this.#fail(this.#connectionError(error)));
    socket.on("close", () =>
      this.#fail(
        new ZeniusError(
          "ZEN_BROWSER_UNAVAILABLE",
          `the zenius runtime closed the connection (instance ${JSON.stringify(this.instance)}); Zen may have quit or restarted`,
        ),
      ),
    );
    // An idle connection must not keep a finished script alive.
    socket.unref();
  }

  get failed(): ZeniusError | undefined {
    return this.#failure;
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    const op = options.op ?? method;
    const site: { stack?: string } = {};
    Error.captureStackTrace(site, this.call);
    if (this.#failure) return Promise.reject(atSite(this.#rebrand(this.#failure, op), site));
    if (this.#closed) {
      return Promise.reject(atSite(new ZeniusError("ZEN_BROWSER_UNAVAILABLE", `${op}: the connection was already closed`), site));
    }
    const signal = callSignals?.getStore();
    if (signal?.aborted) return Promise.reject(atSite(canceledError(op), site));
    this.connect();
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        method,
        op,
        site,
        resolve: resolve as (value: unknown) => void,
        reject,
        startedAt: performance.now(),
        heldMs: 0,
        ...(options.quiet ? { quiet: true } : {}),
        ...(typeof (params as { space?: unknown } | undefined)?.space === "number" ? { space: (params as { space: number }).space } : {}),
        ...(options.safetyTimeoutMs !== undefined && Number.isFinite(options.safetyTimeoutMs) ? { safetyTimeoutMs: options.safetyTimeoutMs } : {}),
      };
      this.#arm(id, pending);
      this.#pending.set(id, pending);
      this.#socket!.ref();
      // progress: this client understands {id, held} frames (see #onFrame).
      // pageBudget: the process's EGO_BROWSER_PAGE_BUDGET, which the runtime
      // applies wherever a space gains a Page; per process, as in Ego.
      const pageBudget = configuredPageBudget();
      this.#socket!.write(`${JSON.stringify({ id, method, params, progress: true, ...(pageBudget ? { pageBudget } : {}) })}\n`);
      if (signal) {
        const cancel = () => this.#cancel(id);
        signal.addEventListener("abort", cancel, { once: true });
        pending.unlisten = () => signal.removeEventListener("abort", cancel);
      }
    });
  }

  /**
   * The tool call this call was for was canceled: the runtime stops the call
   * (its wait ends, its page code stops) and sends no answer, and it fails
   * here at once.
   */
  #cancel(id: number): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#settle(id);
    if (this.#socket && !this.#closed && !this.#failure) {
      // Its own answer has no pending call, so it's dropped.
      this.#socket.write(`${JSON.stringify({ id: this.#nextId++, method: "calls.cancel", params: { id } })}\n`);
    }
    pending.reject(atSite(canceledError(pending.op), pending.site));
  }

  onEvent(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.removeAllListeners("close");
    socket?.on("error", () => {});
    socket?.destroy();
    for (const [id, pending] of this.#pending) {
      this.#settle(id);
      pending.reject(
        atSite(new ZeniusError("ZEN_BROWSER_UNAVAILABLE", `${pending.op}: the script ended before the runtime answered`), pending.site),
      );
    }
  }

  // Only the new chunk is searched, and a line is joined once: appending to
  // one string and searching it from the start made V8 flatten the whole
  // growing line on every 64 KB chunk, about 1.2 s for a 13 MiB snapshot.
  #onData(chunk: string): void {
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf("\n", start)) >= 0) {
      this.#parts.push(chunk.slice(start, newline));
      const line = this.#parts.length === 1 ? this.#parts[0]! : this.#parts.join("");
      this.#parts = [];
      start = newline + 1;
      if (line.trim()) this.#onFrame(line);
    }
    if (start < chunk.length) this.#parts.push(chunk.slice(start));
  }

  #onFrame(line: string): void {
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      this.#fail(new ZeniusError("ZEN_INTERNAL", `the zenius runtime sent a malformed frame: ${line.slice(0, 200)}`));
      return;
    }
    if (frame && typeof frame.event === "string" && frame.id === undefined) {
      if (frame.event === "hello") {
        this.helloAt = performance.now();
        this.hello = frame.params ?? {};
        const protocol = this.hello?.protocol;
        if (protocol !== undefined && protocol !== PROTOCOL_VERSION) {
          this.#fail(
            new ZeniusError(
              "ZEN_BROWSER_UNAVAILABLE",
              `the zenius runtime speaks protocol ${protocol}, but this SDK speaks ${PROTOCOL_VERSION}; update the CLI or the runtime so they match`,
            ),
          );
        }
        return;
      }
      for (const listener of [...this.#listeners]) listener(frame.event, frame.params);
      return;
    }
    const pending = this.#pending.get(frame?.id);
    if (!pending) return;
    // Only a frame with a result or an error ends a call. Anything else is
    // progress: {held: true} while the runtime's gate holds the call (the
    // user is using the Space), {held: false} when it lets the call start.
    // Held time doesn't count against the safety limit.
    if (!("result" in frame) && !("error" in frame)) {
      if (frame.held === true && pending.heldSince === undefined) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = undefined;
        pending.heldSince = performance.now();
        this.#onHeld?.(pending.method, true, typeof frame.reason === "string" ? frame.reason : undefined);
      } else if (frame.held === false && pending.heldSince !== undefined) {
        this.#release(pending);
        this.#arm(frame.id, pending);
        this.#onHeld?.(pending.method, false, undefined);
      }
      return;
    }
    this.#settle(frame.id);
    const ok = !frame.error;
    if (pending.heldSince !== undefined) this.#release(pending);
    this.#onTiming?.(pending.method, performance.now() - pending.startedAt, ok, pending.heldMs);
    if (ok) pending.resolve(typeof frame.unserializable === "string" ? decodeUnserializable(frame.unserializable) : frame.result);
    else pending.reject(atSite(fromWireError(frame.error, pending.op, !pending.quiet, pending.space), pending.site));
  }

  /** Time the runtime's gate held calls, per task space, so far. */
  heldMsBySpace(): ReadonlyMap<number, number> {
    return this.#heldBySpace;
  }

  #release(pending: Pending): void {
    const ms = performance.now() - pending.heldSince!;
    pending.heldSince = undefined;
    pending.heldMs += ms;
    if (pending.space !== undefined) this.#heldBySpace.set(pending.space, (this.#heldBySpace.get(pending.space) ?? 0) + ms);
  }

  /** Start (or restart, after a hold) the call's client-side safety limit. */
  #arm(id: number, pending: Pending): void {
    if (pending.safetyTimeoutMs === undefined) return;
    if (pending.timer) clearTimeout(pending.timer);
    const limit = pending.safetyTimeoutMs;
    pending.timer = setTimeout(() => {
      this.#settle(id);
      const held = pending.heldMs > 0 ? `, after the runtime held the call ${Math.round(pending.heldMs)}ms while the user had the Space` : "";
      pending.reject(
        atSite(new ZeniusError("ZEN_TIMEOUT", `${pending.op}: no response from the zenius runtime after ${Math.round(limit)}ms${held}`, { reason: "no_response" }), pending.site),
      );
    }, limit);
  }

  #settle(id: number): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.unlisten?.();
    this.#pending.delete(id);
    if (this.#pending.size === 0) this.#socket?.unref();
  }

  #fail(error: ZeniusError): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const [id, pending] of this.#pending) {
      this.#settle(id);
      pending.reject(atSite(this.#rebrand(error, pending.op), pending.site));
    }
    this.#socket?.destroy();
  }

  #rebrand(error: ZeniusError, op: string): ZeniusError {
    return new ZeniusError(error.code, `${op}: ${error.message}`, error.data);
  }

  #connectionError(error: NodeJS.ErrnoException): ZeniusError {
    const instance = JSON.stringify(this.instance);
    if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
      return new ZeniusError(
        "ZEN_BROWSER_UNAVAILABLE",
        `zenius instance ${instance} is not running (nothing is listening on ${this.socketPath}). ` +
          "Start Zen with the zenius runtime, or pick another instance with --instance <name> or ZENIUS_INSTANCE. " +
          "`zenius status` lists the known instances, and `zenius doctor` checks the install.",
        { socket: this.socketPath, errno: error.code },
      );
    }
    // The system refused the connection itself: Zen may well be running. Codex's
    // sandbox does this (EPERM) to every socket while its network access is off.
    if (error.code === "EPERM" || error.code === "EACCES") {
      return new ZeniusError(
        "ZEN_BROWSER_UNAVAILABLE",
        `zenius instance ${instance} may be running, but this process may not connect to ${this.socketPath} (${error.code}): ` +
          "a sandbox around it blocks the socket (Codex's does while its network access is off), or the socket's permissions do.",
        { socket: this.socketPath, errno: error.code },
      );
    }
    return new ZeniusError(
      "ZEN_BROWSER_UNAVAILABLE",
      `cannot reach zenius instance ${instance} at ${this.socketPath}: ${error.message}`,
      { socket: this.socketPath, errno: error.code },
    );
  }
}

/** Give an error the stack of the call that caused it, under its own headline. */
function atSite<E extends Error>(error: E, site: { stack?: string }): E {
  const frames = site.stack?.split("\n").slice(1).join("\n");
  if (frames) error.stack = `${error.name}: ${error.message}\n${frames}`;
  return error;
}

/**
 * Values JSON can't carry travel as a frame-level string, as Ego decodes
 * CDP's unserializableValue: NaN, Infinity, -Infinity, -0 and BigInt ("12n").
 */
export function decodeUnserializable(value: string): unknown {
  if (value === "NaN") return Number.NaN;
  if (value === "Infinity") return Number.POSITIVE_INFINITY;
  if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
  if (value === "-0") return -0;
  if (/^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  return value;
}
