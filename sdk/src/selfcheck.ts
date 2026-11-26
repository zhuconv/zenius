// `zenius selfcheck [--instance <name>]`: the post-install self-check's
// front. The runtime runs its checks of the agent sidebar in a window of its
// own, with a mock agent, and answers with each check's result and the
// folder of its shots.
//
// The runtime serves it on a socket of its own,
// <ZENIUS_HOME or ~/.zenius>/selfcheck/<instance>.sock, which zenius's
// sandbox can't reach: only a caller outside it, the user's own shell or the
// relay, starts a run. So the path is worked out here and never taken from a
// variable that names a socket (ZENIUS_SOCKET is the agents' socket), and in
// the sandbox the connect fails by construction. This front is no gate: the
// runtime's socket is. It stays out of `zenius --help`, the Skill and the
// agents' guide, and no failure of it hands an agent a command to run.

import { ZeniusError } from "./errors.ts";
import { instanceName, instanceNameRule, isInstanceName, selfcheckSocket } from "./instance.ts";
import { inSandbox, os } from "./node.ts";
import { writeStderr, writeStdout } from "./output.ts";
import { RpcClient } from "./rpc.ts";

/** The client's limit: the runtime's own 120 s, then its cleanup's few seconds. A wait before the run doesn't count. */
export const SELFCHECK_TIMEOUT_MS = 150_000;

/**
 * How long the front lets the runtime hold a run before it starts. The
 * runtime releases the call within its 60 s wait for Zen to be in the
 * background; held past this, the front stops waiting and closes the
 * connection, which stops the run.
 */
export const SELFCHECK_HOLD_LIMIT_MS = 90_000;

export const SELFCHECK_USAGE = `Usage: zenius selfcheck [--instance <name>]

Runs the post-install self-check in Zen: the update's checks, in a window of
its own, with a mock agent, in up to about two minutes. While Zen is the app
in front, it first waits up to a minute for Zen to be in the background. It
prints a line per check and the folder of its shots, and exits 0 when every
check passes, 1 when one fails, and 2 when it couldn't run. It runs only
from the user's own shell, outside zenius's sandbox.
`;

export type SelfcheckCheck = { id?: unknown; title?: unknown; ok?: unknown; failedStep?: unknown; error?: unknown; shots?: unknown };

/** selfcheck.run's answer, as the runtime sends it. */
export type SelfcheckResult = {
  ok?: unknown;
  timedOut?: unknown;
  callerLeft?: unknown;
  /** A failure outside the checks, as the core's PROTOCOL section has it. */
  error?: unknown;
  /** How long the run waited for Zen to be in the background before it started, in ms. */
  waitedMs?: unknown;
  ms?: unknown;
  dir?: unknown;
  runtimeVersion?: unknown;
  commit?: unknown;
  zenVersion?: unknown;
  checks?: unknown;
};

export async function selfcheckCommand(rest: string[], flag: string | undefined): Promise<number> {
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    writeStdout(SELFCHECK_USAGE);
    return 0;
  }
  if (rest.length > 0) return fail(`unexpected argument: ${rest[0]}\n\n${SELFCHECK_USAGE}`);
  const instance = instanceName(flag);
  if (!isInstanceName(instance)) return fail(instanceNameRule(instance));
  const socket = selfcheckSocket(instance);
  // While the runtime holds the run, the caller sees why.
  const outcome = await runSelfcheck(socket, instance, { onWait: (reason) => writeStderr(`zenius selfcheck: ${waitText(reason)}\n`) });
  if ("error" in outcome) return fail(failureText(outcome.error, socket, instance));
  const report = formatResult(outcome.result, instance);
  writeStdout(report.text);
  return report.code;
}

export type RunOptions = {
  timeoutMs?: number;
  holdLimitMs?: number;
  /** Called once, when the runtime first holds the run, with its reason ("zen-in-front"). */
  onWait?: (reason: string | undefined) => void;
};

/** The line the caller reads while the runtime holds the run. */
export function waitText(reason: string | undefined): string {
  if (reason === "zen-in-front") return "waiting for Zen to be in the background (up to 60 s)";
  const why = clean(reason);
  return why ? `waiting (${why})` : "waiting";
}

/**
 * One run: connect, call selfcheck.run with no params, and close. A run that
 * outlasts the limit is stopped by the close itself: the runtime aborts a run
 * whose caller left, and cleans up as after its own timeout. While the
 * runtime holds the run before it starts ({held: true} frames), the client's
 * limit waits, and this front's own hold limit runs instead.
 */
export async function runSelfcheck(
  socket: string,
  instance: string,
  { timeoutMs = SELFCHECK_TIMEOUT_MS, holdLimitMs = SELFCHECK_HOLD_LIMIT_MS, onWait }: RunOptions = {},
): Promise<{ result: SelfcheckResult } | { error: ZeniusError }> {
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let heldTooLong = false;
  let heldFor: string | undefined;
  let told = false;
  const client: RpcClient = new RpcClient({
    socketPath: socket,
    instance,
    onHeld: (_method, held, reason) => {
      clearTimeout(holdTimer);
      holdTimer = undefined;
      if (!held) return;
      heldFor = reason;
      if (!told) {
        told = true;
        onWait?.(reason);
      }
      holdTimer = setTimeout(() => {
        heldTooLong = true;
        client.close();
      }, holdLimitMs);
    },
  });
  try {
    const result = await client.call<SelfcheckResult>("selfcheck.run", {}, { op: "selfcheck.run", safetyTimeoutMs: timeoutMs, quiet: true });
    return { result: result && typeof result === "object" ? result : {} };
  } catch (error) {
    if (heldTooLong) {
      return {
        error: new ZeniusError("ZEN_TIMEOUT", `the runtime held the run over ${Math.round(holdLimitMs / 1000)} s`, {
          socket,
          reason: "held",
          ...(heldFor === undefined ? {} : { heldFor }),
        }),
      };
    }
    if (error instanceof ZeniusError) return { error };
    // A connect refused before any socket event (Node's permission model
    // throws at once) keeps its code, so it reads as one refused by a sandbox.
    const code = (error as NodeJS.ErrnoException)?.code;
    const message = String((error as Error)?.message ?? error);
    return { error: new ZeniusError("ZEN_BROWSER_UNAVAILABLE", message, typeof code === "string" ? { socket, errno: code } : { socket }) };
  } finally {
    clearTimeout(holdTimer);
    client.close();
  }
}

/** What a run that couldn't happen says. Never a command: an agent may read it. */
export function failureText(
  error: ZeniusError,
  socket: string,
  instance: string,
  {
    sandboxed = inSandbox(),
    timeoutMs = SELFCHECK_TIMEOUT_MS,
    holdLimitMs = SELFCHECK_HOLD_LIMIT_MS,
  }: { sandboxed?: boolean; timeoutMs?: number; holdLimitMs?: number } = {},
): string {
  const where = tildify(socket);
  const errno = typeof error.data?.errno === "string" ? error.data.errno : undefined;
  if (errno !== undefined) {
    // No path here: no one who can use it reads this message, and it would
    // show an agent whose harness reaches Unix sockets what to try. A caller
    // outside the sandbox gets the path below.
    if (sandboxed || errno === "EPERM" || errno === "EACCES") {
      return (
        `this process can't reach the self-check (${errno}). ` +
        "The self-check runs only from the user's own shell, outside zenius's sandbox (install-daily.md, step 6)."
      );
    }
    if (errno === "ENOENT" || errno === "ECONNREFUSED") {
      return (
        `nothing answers on ${where} (${errno}). The self-check needs Zen running instance ${JSON.stringify(instance)} ` +
        "with a runtime that has it, which opens that socket shortly after Zen starts."
      );
    }
    return `can't reach the self-check at ${where} (${errno}).`;
  }
  const message = clean(error.message.replace(/^selfcheck\.run: /, ""));
  switch (error.code) {
    case "ZEN_TIMEOUT":
      if (error.data?.reason === "held") {
        const after = `still held after ${Math.round(holdLimitMs / 1000)} s`;
        const reason = clean(error.data.heldFor);
        const why =
          error.data.heldFor === "zen-in-front"
            ? `${after}, waiting for Zen to be in the background, though the runtime waits at most 60 s.`
            : `${after}${reason ? ` (${reason})` : ""}.`;
        return `${why} Closing the connection stopped the run, and the runtime cleans up after it.`;
      }
      return `no answer in ${Math.round(timeoutMs / 1000)} s. Closing the connection stopped the run, and the runtime cleans up after it.`;
    case "ZEN_SELFCHECK_BUSY":
      return `a self-check is already running in instance ${JSON.stringify(instance)}. Wait for it to end.`;
    default:
      return `${message} (${error.code})`;
  }
}

/** The lines the caller reads, and the exit code: 0 all passed, 1 a check failed, 2 nothing ran. */
export function formatResult(result: SelfcheckResult, instance: string, home = os.homedir()): { text: string; code: number } {
  const checks: SelfcheckCheck[] = Array.isArray(result.checks) ? result.checks.filter((check) => check && typeof check === "object") : [];
  const runtime = [clean(result.runtimeVersion) && `runtime ${clean(result.runtimeVersion)}`, clean(result.commit) && `at ${clean(result.commit)}`]
    .filter(Boolean)
    .join(" ");
  const about = [runtime, clean(result.zenVersion) && `Zen ${clean(result.zenVersion)}`].filter(Boolean).join(", ");
  const lines = [`zenius selfcheck, instance ${JSON.stringify(instance)}${about ? `: ${about}` : ""}`, ""];
  const title = (check: SelfcheckCheck) => clean(check.title) || clean(check.id) || "(unnamed check)";
  const width = Math.max(0, ...checks.map((check) => Array.from(title(check)).length));
  for (const check of checks) {
    if (check.ok === true) {
      lines.push(`ok    ${title(check)}`);
      continue;
    }
    const step = clean(check.failedStep);
    const error = clean(check.error);
    const detail = [step ? `at ${step}` : "", error].filter(Boolean).join(": ");
    lines.push(`FAIL  ${pad(title(check), width)}  ${detail || "failed"}`.trimEnd());
  }
  const failed = checks.filter((check) => check.ok !== true).length;
  const waited = typeof result.waitedMs === "number" && Number.isFinite(result.waitedMs) && result.waitedMs > 0 ? result.waitedMs : 0;
  // The runtime's ms counts the wait too; the summary's time is the run's own.
  const took = typeof result.ms === "number" && Number.isFinite(result.ms) ? ` in ${seconds(Math.max(0, result.ms - waited))} s` : "";
  // Why a run stopped early: the connection that started it closed
  // (callerLeft), else its time limit passed. A caller that left isn't a timeout.
  const stopped = result.callerLeft === true ? "the caller left" : result.timedOut === true ? "the run stopped at its time limit" : "";
  // A failure outside the checks: a window that didn't open, a prepare that
  // threw, a folder that couldn't be made. It's the only why the caller gets.
  const runError = clean(result.error);
  const why = [stopped, runError && `the run failed (${runError})`].filter(Boolean).join("; ");
  let summary: string;
  let code: number;
  if (checks.length === 0) {
    // After a wait, the wait's own line accounts for the time.
    summary = `The self-check ran no check${waited ? "" : took}${why ? `: ${why}` : ""}.`;
    code = 2;
  } else if (failed === 0 && result.ok === true && !why) {
    summary = `All ${checks.length} checks passed${took}.`;
    code = 0;
  } else if (failed === 0) {
    summary = `Every check passed${took}, but ${why || "the run itself failed"}.`;
    code = 1;
  } else {
    summary = `${failed} of ${checks.length} checks failed${took}${why ? `: ${why}` : ""}.`;
    code = 1;
  }
  lines.push("", ...(waited ? [`It waited ${seconds(waited)} s for Zen to be in the background.`] : []), summary);
  const dir = clean(result.dir);
  if (dir) lines.push(`The shots and summary.json are in ${tildify(dir, home)}`);
  return { text: `${lines.join("\n")}\n`, code };
}

function fail(message: string): number {
  writeStderr(`zenius selfcheck: ${message}${message.endsWith("\n") ? "" : "\n"}`);
  return 2;
}

/** Characters that change how a line reads without showing: bidi controls, zero-width and other format characters, controls. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** The runtime's text on one line, with nothing in it that could act on the terminal. */
function clean(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").replace(INVISIBLE, "").replace(/ {2,}/g, " ").trim();
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - Array.from(text).length));
}

function tildify(value: string, home = os.homedir()): string {
  return home && (value === home || value.startsWith(`${home}/`)) ? `~${value.slice(home.length)}` : value;
}
