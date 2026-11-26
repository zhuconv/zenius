// `zenius wait <task id> [--timeout <seconds>]`: the wait a terminal agent
// leaves in the background after a hand-off, or after a call that failed
// because the user holds the task (skill/guide.md, "User control"). It ends
// once the user hands the task back: exit 0, and the agent then takes the
// task over with takeOverTaskSpace(id) and goes on. Exit 3: the task ended,
// or is gone. Exit 4: --timeout passed.
//
// It takes none of the hand back's notes (spaces.waitForControl keepNotes),
// so the task's own takeOver still gets them. While it waits, the user's card
// says the agent goes on by itself at Resume (the runtime's agentWaiting).
// Across a restart of Zen it waits for the instance to answer again and goes
// on; a task that didn't come back with it gives 3.

import type { ZeniusError } from "./errors.ts";
import { instanceName, socketPath } from "./instance.ts";
import { writeStderr, writeStdout } from "./output.ts";
import { RpcClient } from "./rpc.ts";

/**
 * Each call's own limit, renewed until the hand back: the runtime keeps the
 * task waited on across the gap (its grace).
 */
const CALL_MS = 10 * 60_000;
/** The client's safety limit beyond the call's own. */
const CALL_MARGIN_MS = 30_000;
/** How often it looks for the instance while Zen is away. */
const RECONNECT_MS = 2000;
/** The longest --timeout: a week. */
export const MAX_TIMEOUT_S = 7 * 24 * 60 * 60;

const USAGE = "Usage: zenius wait <task id> [--timeout <seconds>]";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const codeOf = (error: unknown) => (error as ZeniusError | undefined)?.code;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** An error as `zenius sidebar` prints one: its code first, then the message, which already names the call (zenius wait). */
const errorLine = (error: unknown) => (codeOf(error) ? `${codeOf(error)}: ${messageOf(error)}` : `zenius wait: ${messageOf(error)}`);

function usage(message: string): number {
  writeStderr(`zenius wait: ${message}\n${USAGE}\n`);
  return 2;
}

export async function waitCommand(rest: string[], instanceFlag: string | undefined): Promise<number> {
  let id: number | undefined;
  let timeoutS: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const value = arg === "--timeout" ? rest[++i] : arg.slice("--timeout=".length);
      if (value === undefined || !/^\d{1,7}$/.test(value) || Number(value) < 1 || Number(value) > MAX_TIMEOUT_S) {
        return usage(`--timeout takes whole seconds, from 1 to ${MAX_TIMEOUT_S}`);
      }
      timeoutS = Number(value);
    } else if (id === undefined && /^[1-9]\d{0,8}$/.test(arg)) {
      id = Number(arg);
    } else {
      return usage(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }
  if (id === undefined) return usage("it needs the task's id, as handOff()'s task or listTaskSpaces() gives it");
  const instance = instanceName(instanceFlag);
  const deadline = timeoutS === undefined ? Infinity : Date.now() + timeoutS * 1000;
  const connect = () => new RpcClient({ socketPath: socketPath(instance), instance });
  let client = connect();
  try {
    // A wrong instance, or no Zen at all, says so at once: only a Zen that
    // answered once is waited for again.
    try {
      await client.call("browser.version", {}, { op: "zenius wait" });
    } catch (error) {
      writeStderr(`${errorLine(error)}\n`);
      return 1;
    }
    while (true) {
      const left = deadline - Date.now();
      if (left <= 0) {
        writeStderr(`zenius wait: task ${id} is still the user's after ${timeoutS} s. Run zenius wait ${id} again to go on waiting.\n`);
        return 4;
      }
      const ms = Math.min(CALL_MS, left);
      try {
        const result = await client.call<{ ownership?: string } | null>(
          "spaces.waitForControl",
          { space: id, timeout: ms, keepNotes: true },
          { op: "zenius wait", safetyTimeoutMs: ms + CALL_MARGIN_MS },
        );
        if (result?.ownership === "agent") {
          writeStdout(`Task ${id} is yours again: the user handed it back. Take it over with takeOverTaskSpace(${id}) and go on.\n`);
          return 0;
        }
        // The runtime answers only once the agent has control: anything else
        // is looked at again, after a moment.
        await sleep(Math.min(RECONNECT_MS, Math.max(0, deadline - Date.now())));
      } catch (error) {
        const code = codeOf(error);
        if (code === "ZEN_TIMEOUT") continue;
        if (code === "ZEN_TASK_SPACE_INACTIVE" || code === "ZEN_TASK_SPACE_NOT_FOUND") {
          writeStderr(`${errorLine(error)}\n`);
          return 3;
        }
        if (code !== "ZEN_BROWSER_UNAVAILABLE") {
          writeStderr(`${errorLine(error)}\n`);
          return 1;
        }
        // Zen quit or restarts: look again until it answers.
        client.close();
        client = connect();
        while (Date.now() < deadline) {
          try {
            await client.call("browser.version", {}, { op: "zenius wait" });
            break;
          } catch {
            client.close();
            client = connect();
            await sleep(Math.min(RECONNECT_MS, Math.max(0, deadline - Date.now())));
          }
        }
      }
    }
  } finally {
    client.close();
  }
}
