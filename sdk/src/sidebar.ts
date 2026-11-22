// `zenius sidebar …`: remote tasks in the sidebar of the user's Zen, through
// zen-observe's sidebar.* methods (PROTOCOL.md, "Remote tasks: the sidebar").
// This command is for a person or an agent on the Mac, and for tests.
//
// It never starts Zen: with Zen closed, every verb fails with
// ZEN_BROWSER_UNAVAILABLE.

import { ZeniusError } from "./errors.ts";
import { instanceName, socketPath } from "./instance.ts";
import { fs } from "./node.ts";
import { writeStderr, writeStdout } from "./output.ts";
import { RpcClient } from "./rpc.ts";

export type SidebarState = "running" | "idle" | "needs_user" | "stopped" | "failed";

/** A remote task's status, as sidebar.status and sidebar.list give it. */
export type SidebarTask = {
  taskId: string;
  requestId?: string;
  state: SidebarState;
  source: { address: string; label?: string };
  title?: string;
  harness?: string;
  turn: number;
  answer?: string;
  answerTruncated?: boolean;
  needs?: { reason: string; message: string; kind: string };
  error?: { code: string; message: string };
  stopReason?: string;
  startedAt: number;
  updatedAt: number;
  endsAt?: number;
  endedAt?: number;
};

export const SIDEBAR_USAGE = `Usage:
  zenius sidebar start <text> [--from <address>] [--label <text>] [--harness <name>] [--wait <time>]
  zenius sidebar send <taskId> <text> [--wait <time>]
  zenius sidebar status <taskId> [--wait <time>]
  zenius sidebar list
  zenius sidebar stop <taskId>

Remote tasks in the sidebar of the user's Zen: start one in a new Work chat,
send it a follow-up, read its state and latest answer, list them, or stop one.
  <text> of - reads the text from stdin (8 KB at most).
  --from      who asks, shown on the task's card (default: $HC_TERMINAL_ID)
  --label     a short tag after the address on the card: ASCII letters, digits,
              spaces and - _ . / : @ #, 80 at most
  --harness   an agent from the sidebar's config.json (default: the sidebar's order)
  --wait 10m  wait until the turn ends (the state leaves running), then print the status
  --json      print the runtime's result as JSON
It never starts Zen. Options: --instance <name> picks the Zen instance.
`;

const VERBS = new Set(["start", "send", "status", "list", "stop"]);
/** How often --wait asks for the status. */
const WAIT_POLL_MS = 1000;
/** A runtime call that hasn't answered by then has failed; --wait asks again. */
const CALL_TIMEOUT_MS = 30_000;

type Options = { from?: string; label?: string; harness?: string; waitMs?: number; json: boolean; positional: string[] };

export async function sidebarCommand(rest: string[], instanceFlag: string | undefined): Promise<number> {
  const verb = rest[0];
  if (verb === undefined) return usage("zenius sidebar needs a verb");
  if (verb === "-h" || verb === "--help" || verb === "help") {
    writeStdout(SIDEBAR_USAGE);
    return 0;
  }
  if (!VERBS.has(verb)) return usage(`zenius sidebar: unknown verb ${verb}`);
  const parsed = parseOptions(verb, rest.slice(1));
  if (typeof parsed === "string") return usage(parsed);
  const shape = { start: 1, send: 2, status: 1, list: 0, stop: 1 }[verb]!;
  if (parsed.positional.length !== shape) {
    const wanted = { start: "<text>", send: "<taskId> <text>", status: "<taskId>", list: "nothing", stop: "<taskId>" }[verb];
    return usage(`zenius sidebar ${verb} takes ${wanted}`);
  }

  const instance = instanceName(instanceFlag);
  const client = new RpcClient({ socketPath: socketPath(instance), instance });
  const call = <T>(method: string, params: Record<string, unknown> = {}) =>
    client.call<T>(method, params, { op: `zenius sidebar ${verb}`, safetyTimeoutMs: CALL_TIMEOUT_MS });
  try {
    let result: unknown;
    let taskId: string | undefined;
    if (verb === "start") {
      const from = parsed.from ?? process.env.HC_TERMINAL_ID;
      if (!from) return usage("zenius sidebar start needs --from <address> outside an hc terminal");
      const text = readText(parsed.positional[0]!);
      const params: Record<string, unknown> = { text, source: { address: from, ...(parsed.label !== undefined ? { label: parsed.label } : {}) } };
      if (parsed.harness !== undefined) params.harness = parsed.harness;
      result = await call<{ taskId: string }>("sidebar.start", params);
      taskId = (result as { taskId?: string }).taskId;
    } else if (verb === "send") {
      taskId = parsed.positional[0]!;
      result = await call("sidebar.send", { taskId, text: readText(parsed.positional[1]!) });
    } else if (verb === "status") {
      taskId = parsed.positional[0]!;
      result = await call<SidebarTask>("sidebar.status", { taskId });
    } else if (verb === "list") {
      result = await call<{ tasks: SidebarTask[] }>("sidebar.list");
    } else {
      result = await call("sidebar.stop", { taskId: parsed.positional[0]! });
    }

    if (parsed.waitMs !== undefined && taskId !== undefined) {
      const waited = await waitForTurn(call, taskId, parsed.waitMs);
      print(waited.task, parsed.json, "status");
      if (waited.timedOut) {
        writeStderr(`zenius sidebar ${verb}: task ${taskId} is still running after ${formatDuration(parsed.waitMs)}\n`);
        return 1;
      }
      return 0;
    }
    print(result, parsed.json, verb);
    return 0;
  } catch (error) {
    if (error instanceof ZeniusError) {
      writeStderr(`${error.code}: ${error.message}\n`);
      return 1;
    }
    if (error instanceof TextError) return usage(error.message);
    throw error;
  } finally {
    client.close();
  }
}

/** Poll sidebar.status until the turn ends or the time is up. */
async function waitForTurn(
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  taskId: string,
  waitMs: number,
): Promise<{ task: SidebarTask; timedOut: boolean }> {
  const deadline = performance.now() + waitMs;
  for (;;) {
    const task = await call<SidebarTask>("sidebar.status", { taskId });
    if (task.state !== "running") return { task, timedOut: false };
    const left = deadline - performance.now();
    if (left <= 0) return { task, timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, left)));
  }
}

function parseOptions(verb: string, args: string[]): Options | string {
  const options: Options = { json: false, positional: [] };
  const valued: Record<string, "from" | "label" | "harness" | "wait"> = { "--from": "from", "--label": "label", "--harness": "harness", "--wait": "wait" };
  const allowed: Record<string, string[]> = { start: ["from", "label", "harness", "wait"], send: ["wait"], status: ["wait"], list: [], stop: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = arg.startsWith("--") && equals > 0 ? arg.slice(0, equals) : arg;
    const key = valued[flag];
    if (key) {
      if (!allowed[verb]!.includes(key)) return `zenius sidebar ${verb} has no ${flag}`;
      const value = flag === arg ? args[++index] : arg.slice(equals + 1);
      if (value === undefined || value === "") return `zenius sidebar ${verb}: ${flag} needs a value`;
      if (key === "wait") {
        const ms = parseDuration(value);
        if (ms === undefined) return `zenius sidebar ${verb}: --wait takes a time such as 90s, 10m or 1h, not ${value}`;
        options.waitMs = ms;
      } else {
        options[key] = value;
      }
    } else if (arg.startsWith("--") && arg !== "--") {
      return `zenius sidebar ${verb}: unknown option ${flag}`;
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

/** "90s", "10m", "1h", "200ms", or plain seconds, in ms. */
export function parseDuration(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) return undefined;
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? "s"]!;
  const ms = Number(match[1]) * scale;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined;
}

export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms % 1000 === 0) return `${ms / 1000} s`;
  return `${ms} ms`;
}

class TextError extends Error {}

/** The text argument, or stdin for "-". */
function readText(arg: string): string {
  if (arg !== "-") return arg;
  let text: string;
  try {
    text = fs.readFileSync(0, "utf8");
  } catch (error) {
    throw new TextError(`zenius sidebar: couldn't read the text from stdin (${(error as NodeJS.ErrnoException).code ?? error})`);
  }
  // A heredoc's last newline isn't part of the text.
  return text.replace(/\n$/, "");
}

function print(result: unknown, json: boolean, verb: string): void {
  if (json) {
    writeStdout(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (verb === "list") {
    const tasks = (result as { tasks?: SidebarTask[] }).tasks ?? [];
    writeStdout(tasks.length === 0 ? "No remote tasks.\n" : `${tasks.map(listLine).join("\n")}\n`);
  } else if (verb === "status") {
    writeStdout(statusText(result as SidebarTask));
  } else {
    const { taskId, state } = result as { taskId?: string; state?: string };
    writeStdout(`task ${taskId}: ${state}\n`);
  }
}

function listLine(task: SidebarTask): string {
  const parts = [task.taskId, stateWords(task), `turn ${task.turn}`, `from ${sourceWords(task.source)}`, `started ${clock(task.startedAt)}`];
  if (task.requestId) parts.push(`request ${task.requestId}`);
  return parts.join("  ");
}

export function statusText(task: SidebarTask): string {
  const lines = [`task ${task.taskId}: ${stateWords(task)}, turn ${task.turn}`, `from ${sourceWords(task.source)}${task.requestId ? `, request ${task.requestId}` : ""}`];
  if (task.needs) lines.push(`needs the user (${task.needs.reason}, ${task.needs.kind}): ${task.needs.message}`);
  if (task.error) lines.push(`error ${task.error.code}: ${task.error.message}`);
  const times = [`started ${clock(task.startedAt)}`, `updated ${clock(task.updatedAt)}`];
  if (task.endedAt) times.push(`ended ${clock(task.endedAt)}`);
  else if (task.endsAt) times.push(`stops by ${clock(task.endsAt)}`);
  lines.push(times.join(", "));
  let text = `${lines.join("\n")}\n`;
  if (task.answer !== undefined) {
    text += `\n${task.answer}\n`;
    if (task.answerTruncated) text += "(the answer was cut at 32 KB)\n";
  }
  return text;
}

function stateWords(task: SidebarTask): string {
  return task.state === "stopped" && task.stopReason ? `stopped (${task.stopReason})` : task.state;
}

function sourceWords(source: SidebarTask["source"] | undefined): string {
  if (!source) return "?";
  return source.label ? `${source.address} · ${source.label}` : source.address;
}

/** Local wall-clock time, HH:MM:SS. */
export function clock(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "?";
  const date = new Date(ms);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

function usage(message: string): number {
  writeStderr(`${message}\n\n${SIDEBAR_USAGE}`);
  return 2;
}
