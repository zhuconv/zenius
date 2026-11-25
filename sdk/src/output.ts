// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Script output stays buffered until the script settles, because bytes written
// before a hard stop cannot be recalled: a hard stop discards business output
// and shows its guidance exactly once. Unlike Ego, a hard stop the user ends
// during the run, by handing the space back to a waitForControl() the script
// made after catching it, no longer holds, so the output shows. Each run is a
// fresh process, so this module-level state is per run; resetOutput() exists
// for in-process tests, and takeOutput() for zenius mcp's scripts, which run
// one at a time in the server's process.

import { fs, util } from "./node.ts";

export type Writer = (chunk: string) => void;

let buffer: string[] = [];
/** The run's hard stops that still hold, by the task space the call named (undefined: none). */
let hardStops = new Map<number | undefined, string>();
let notices: string[] = [];
let written: string[] = [];
let flushed = false;

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return util.inspect(value, { depth: 6, breakLength: Infinity, compact: true });
}

export function bufferOutput(chunk: string): void {
  buffer.push(chunk);
}

/** Record a space's first hard stop of the run; repeats are ignored until the user hands the space back. */
export function markHardStop(message: string, space?: number): void {
  if (!hardStops.has(space)) hardStops.set(space, message);
}

/**
 * The user handed `space` back (task.waitForControl() reported the agent's
 * control), so its hard stop no longer holds. A takeover the script makes
 * itself clears nothing: that is what the guidance warns against.
 */
export function clearHardStop(space: number): void {
  hardStops.delete(space);
}

export function hasHardStop(): boolean {
  return hardStops.size > 0;
}

/** A tagged block printed after the script's own output, e.g. unhandled Pages. */
export function addNotice(text: string): void {
  notices.push(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * zenius mcp's tools but script: the notices the SDK raised during the call,
 * as lines without their [zenius:...] tags, which then start afresh. A
 * script's are its own (takeOutput), taken before its call ends.
 */
export function takeNotices(): string[] {
  const lines = notices
    .join("")
    .split("\n")
    .filter((line) => line && !line.startsWith("[zenius:"));
  notices = [];
  return lines;
}

/** A file the SDK wrote, listed in a [zenius:files] block after the script's output. */
export function noteWrittenFile(path: string): void {
  written.push(path);
}

export type RoundConsole = Pick<Console, "log" | "info" | "debug" | "warn" | "error" | "dir" | "table" | "trace">;

/** The console injected into a script; it writes into the round buffer. */
export function createRoundConsole(write: Writer = bufferOutput): RoundConsole {
  const append = (prefix: string, args: unknown[]) => {
    write(`${prefix}${args.map(formatValue).join(" ")}\n`);
  };
  return Object.freeze({
    log: (...args: unknown[]) => append("", args),
    info: (...args: unknown[]) => append("", args),
    debug: (...args: unknown[]) => append("", args),
    dir: (value: unknown) => append("", [value]),
    table: (value: unknown) => append("", [value]),
    trace: (...args: unknown[]) => append("[trace] ", args),
    warn: (...args: unknown[]) => append("[warn] ", args),
    error: (...args: unknown[]) => append("[error] ", args),
  }) as RoundConsole;
}

/**
 * Emit the run's output once. `thrown` means the script ended on an uncaught
 * error: the CLI prints that error (which already carries any hard-stop
 * guidance), so the guidance is not repeated on stdout.
 */
export function flushOutput(thrown: boolean, write: Writer = writeStdout): void {
  if (flushed) return;
  flushed = true;
  const hardStop = hardStops.values().next().value;
  if (hardStop !== undefined) {
    if (!thrown) write(hardStop.endsWith("\n") ? hardStop : `${hardStop}\n`);
  } else {
    // One write keeps a piped reader from seeing interleaved partial output.
    const files = written.length > 0 ? `[zenius:files]\n${written.map((file) => `Wrote ${file}\n`).join("")}` : "";
    const text = buffer.join("") + notices.join("") + files;
    if (text) write(text);
  }
  buffer = [];
  notices = [];
  written = [];
}

/**
 * zenius mcp: what a script left in the run's state (its output, the SDK's
 * notices, the files it wrote, a hard stop that still holds), which then
 * starts afresh for the next script in the same process.
 */
export function takeOutput(): { text: string; notices: string; written: string[]; hardStop: string | undefined } {
  const taken = { text: buffer.join(""), notices: notices.join(""), written: [...written], hardStop: hardStops.values().next().value };
  resetOutput();
  return taken;
}

export function resetOutput(): void {
  buffer = [];
  notices = [];
  written = [];
  hardStops = new Map();
  flushed = false;
}

// Synchronous so the process can exit right after flushing without losing a
// tail that a piped stdout had not drained yet.
export function writeStdout(chunk: string): void {
  writeAll(1, chunk);
}

export function writeStderr(chunk: string): void {
  writeAll(2, chunk);
}

function writeAll(fd: number, chunk: string): void {
  const data = Buffer.from(chunk, "utf8");
  let offset = 0;
  while (offset < data.length) {
    try {
      offset += fs.writeSync(fd, data, offset);
    } catch (error) {
      // A non-blocking pipe can be momentarily full; spin until it drains.
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
      if ((error as NodeJS.ErrnoException).code === "EPIPE") return;
      throw error;
    }
  }
}
