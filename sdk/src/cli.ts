// The `zenius` command.
//
//   zenius nodejs [-e <code>]   run a browser script from stdin (heredoc) or -e
//   zenius skill                print the usage guide for this version
//   zenius help [name]          API help, e.g. `zenius help page.click`
//   zenius status               list Zen instances and whether they answer
//   zenius doctor               check Zen, the zenius install and the instance
//   zenius sidebar <verb> …     remote tasks in the sidebar (sidebar.ts)
//   zenius feedback "<line>"    a problem report about zenius, which the user
//                               sends, copies or discards in the sidebar (feedback.ts)
//   zenius selfcheck            the post-install self-check, from the user's
//                               own shell only (selfcheck.ts); not in --help
//
// A build may add commands of its own (commands.ts, src/extensions/).
//
// --instance <name> (or ZENIUS_INSTANCE) picks the Zen instance.

import { API_SCHEMA } from "./api-schema.ts";
import { EXTRA_COMMANDS } from "./commands.ts";
import { claimTaskSpace, listTaskSpaces, profiles, takeOverTaskSpace, taskSpace } from "./globals.ts";
import { readGuide } from "./guide.ts";
import { defaultEntries, formatEntry, helpText } from "./help.ts";
import { instanceName, instanceNameRule, isInstanceName, socketPath } from "./instance.ts";
import { learnContext, runSiteBrowserTool, runSiteTool, siteSkills } from "./learning/index.ts";
import { fs, inSandbox, tty, url } from "./node.ts";
import { bufferOutput, flushOutput, hasHardStop, writeStderr, writeStdout } from "./output.ts";
import { Round, setRound } from "./round.ts";
import { RpcClient, PROTOCOL_VERSION } from "./rpc.ts";
import { finishRun, runScript, type ScriptGlobals } from "./run.ts";
import { statusText } from "./status.ts";
import { VERSION } from "./version.ts";

/** `zenius --help`: the built-in commands, then those a build added (commands.ts), known only once they load. */
export function usage(): string {
  const extra = [...EXTRA_COMMANDS.values()].map((command) => command.usage).join("");
  return `Usage:
  zenius nodejs <<'EOF'
  const task = await taskSpace("demo");
  const page = task.page("p1");
  await page.goto("https://example.com");
  console.log(await page.snapshot());
  EOF

  zenius nodejs -e '<code>'      run code given on the command line
  zenius skill                   print the usage guide (read it before scripting)
  zenius help [name]             API help: zenius help page.click, zenius help all
  zenius status                  list Zen instances and whether they answer
  zenius doctor [--json]         check Zen, the zenius install and the instance; changes nothing
                                 (--profile <dir> and --app <path> pick what to check)
  zenius mcp                     serve browser tools to Claude Code or Codex over MCP (stdio);
                                 see docs/mcp.md for registering it
  zenius sidebar start|send|status|list|stop
                                 remote tasks in the sidebar: zenius sidebar --help
  zenius feedback "<one line>"   when zenius itself fails: show the user a problem report in the
                                 sidebar, to send, copy or discard (zenius feedback --help)
${extra}  zenius --version

Options:
  --instance <name>   Zen instance to drive (default: $ZENIUS_INSTANCE or "default")
  --timing            print per-request timings on stderr
`;
}

type ParsedArgs = {
  command?: string;
  rest: string[];
  instance?: string;
  timing: boolean;
  error?: string;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { rest: [], timing: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--instance") {
      const value = argv[index + 1];
      if (!value) return { ...parsed, error: "--instance needs a name" };
      parsed.instance = value;
      index += 1;
    } else if (arg.startsWith("--instance=")) {
      parsed.instance = arg.slice("--instance=".length);
      if (!parsed.instance) return { ...parsed, error: "--instance needs a name" };
    } else if (arg === "--timing") {
      parsed.timing = true;
    } else if (parsed.command === undefined) {
      parsed.command = arg;
    } else {
      parsed.rest.push(arg);
    }
  }
  return parsed;
}

/** When the launcher started and finished loading this bundle, for --timing. */
export type LaunchTimes = { launcherAt?: number; loadedAt?: number };

/** The commands that reach an instance, and so take only a name the launcher would (instance.ts). */
const INSTANCE_COMMANDS = new Set(["nodejs", "status", "doctor", "mcp", "sidebar", "selfcheck", "feedback"]);

export async function main(argv: string[], launch: LaunchTimes = {}): Promise<number> {
  const args = parseArgs(argv);
  if (args.error) return usageError(args.error);
  if (args.command !== undefined && (INSTANCE_COMMANDS.has(args.command) || EXTRA_COMMANDS.has(args.command))) {
    const instance = instanceName(args.instance);
    if (!isInstanceName(instance)) {
      writeStderr(`zenius ${args.command}: ${instanceNameRule(instance)}\n`);
      return 2;
    }
  }
  switch (args.command) {
    case undefined:
    case "-h":
    case "--help":
      writeStdout(usage());
      return 0;
    case "-v":
    case "--version":
    case "version":
      writeStdout(`zenius ${VERSION} (protocol ${PROTOCOL_VERSION}${inSandbox() ? ", sandboxed" : ""})\n`);
      return 0;
    case "nodejs":
      return nodejs(args, launch);
    case "skill":
      return skill(args.rest);
    case "help":
      return help(args.rest);
    case "status":
      if (args.rest.length > 0) return usageError(`zenius status takes no arguments`);
      writeStdout(`${await statusText(args.instance)}\n`);
      return 0;
    case "doctor":
      return doctorCommand(args);
    case "mcp": {
      if (args.rest.length > 0) return usageError(`zenius mcp takes no arguments`);
      // zen-core's MCP server (src/mcp.ts), loaded on demand like doctor.
      if (args.instance) process.env.ZENIUS_INSTANCE = args.instance;
      const { serveMcp } = await import("./mcp.ts");
      return serveMcp();
    }
    case "sidebar": {
      // Loaded on demand, like doctor and mcp.
      const { sidebarCommand } = await import("./sidebar.ts");
      return sidebarCommand(args.rest, args.instance);
    }
    case "feedback": {
      // Loaded on demand, like doctor, which it runs.
      const { feedbackCommand } = await import("./feedback.ts");
      return feedbackCommand(args.rest, args.instance);
    }
    case "selfcheck": {
      // Loaded on demand. Left out of usage(), which agents read: the
      // self-check is the user's, and the sandbox can't reach it anyway.
      const { selfcheckCommand } = await import("./selfcheck.ts");
      return selfcheckCommand(args.rest, args.instance);
    }
    default: {
      const extra = EXTRA_COMMANDS.get(args.command!);
      if (extra) return extra.run(args.rest, args.instance);
      return usageError(`Unknown command: ${args.command}`);
    }
  }
}

async function doctorCommand(args: ParsedArgs): Promise<number> {
  const chosen: { profile?: string; app?: string } = {};
  let json = false;
  for (let index = 0; index < args.rest.length; index += 1) {
    const arg = args.rest[index]!;
    const equals = arg.indexOf("=");
    const flag = arg.startsWith("--") && equals > 0 ? arg.slice(0, equals) : arg;
    if (flag === "--json" && flag === arg) {
      json = true;
    } else if (flag === "--profile" || flag === "--app") {
      const value = flag === arg ? args.rest[++index] : arg.slice(equals + 1);
      if (!value) return usageError(`zenius doctor ${flag} needs a path`);
      chosen[flag === "--app" ? "app" : "profile"] = value;
    } else {
      return usageError(`zenius doctor: unexpected argument: ${arg}`);
    }
  }
  // Loaded on demand: no other command pays for it.
  const { doctor, formatReport } = await import("./doctor.ts");
  const report = await doctor({ instance: instanceName(args.instance), ...chosen });
  writeStdout(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return report.ok ? 0 : 1;
}

async function nodejs(args: ParsedArgs, launch: LaunchTimes): Promise<number> {
  let code: string | undefined;
  const rest = [...args.rest];
  if (rest[0] === "-e" || rest[0] === "--eval") {
    if (rest.length !== 2) return usageError(`zenius nodejs ${rest[0]} takes exactly one code argument`);
    code = rest[1]!;
  } else if (rest.length > 0) {
    return usageError(`zenius nodejs reads the script from stdin or -e; unexpected argument: ${rest[0]}`);
  }

  const instance = instanceName(args.instance);
  const timing = args.timing || process.env.ZENIUS_TIMING === "1";
  // The timing line's startup phases (see startupPhases()).
  const marks: Record<string, number | undefined> = { launcher: launch.launcherAt, loaded: launch.loadedAt };
  const spawnedAt = performance.timeOrigin;
  let firstRequestAt: number | undefined;
  const client = new RpcClient({
    socketPath: socketPath(instance),
    instance,
    onTiming: timing
      ? (method, ms, ok, heldMs) => {
          firstRequestAt ??= performance.now() - ms;
          const held = heldMs > 0 ? ` (held ${heldMs.toFixed(1)}ms)` : "";
          writeStderr(`[zenius:timing] ${method} ${ms.toFixed(1)}ms${held}${ok ? "" : " (error)"}\n`);
        }
      : undefined,
  });
  // The socket opens on the first request, so scripts that never reach the
  // browser (help(), plain Node work) skip loading node:net at all. Opening
  // it earlier measured no faster: the connect and hello take under 1 ms.
  const round = new Round({ client });
  setRound(round);
  // A script that calls process.exit() still gets its buffered output out,
  // and leaves no download copies behind.
  process.on("exit", () => {
    flushOutput(true);
    round.removeDownloadsFolder();
  });

  if (code === undefined) {
    if (tty().isatty(0)) return usageError("zenius nodejs expects the script on stdin (a heredoc) or -e '<code>'");
    code = await readStdin();
  }
  marks.read = performance.now();
  if (!code.trim()) return usageError("zenius nodejs got an empty script");

  const result = await runScript(code, scriptGlobals());
  if (result.exitCode === 0) await round.reportUnhandledPages();
  await round.disposeDownloads();
  const exitCode = finishRun(result);
  heldNotice(client);
  client.close();
  if (timing) {
    const now = performance.now();
    const startup = firstRequestAt === undefined ? "no requests" : `first request sent at ${firstRequestAt.toFixed(1)}ms`;
    writeStderr(`[zenius:timing] process ${now.toFixed(1)}ms since start (${startup}; timeOrigin ${Math.round(spawnedAt)})\n`);
    writeStderr(`[zenius:timing] startup ${startupPhases({ ...marks, request: firstRequestAt, connected: client.connectedAt, hello: client.helloAt })}\n`);
  }
  return exitCode;
}

/**
 * Where a process's start went, as times since Node started it. Node's own
 * bootstrap ends where the launcher begins; connected and hello may come
 * before or after the script's first request.
 */
function startupPhases(marks: Record<string, number | undefined>): string {
  const names: [string, string][] = [
    ["launcher", "launcher"],
    ["loaded", "bundle loaded"],
    ["read", "script read"],
    ["connected", "connected"],
    ["hello", "hello"],
    ["request", "first request"],
  ];
  return (
    names
      .filter(([key]) => marks[key] !== undefined)
      .sort(([a], [b]) => marks[a]! - marks[b]!)
      .map(([key, label]) => `${label} ${marks[key]!.toFixed(1)}`)
      .join(", ") + " ms"
  );
}

/** The names every script starts with. */
export function scriptGlobals(): ScriptGlobals {
  return {
    taskSpace,
    listTaskSpaces,
    claimTaskSpace,
    takeOverTaskSpace,
    profiles,
    siteSkills,
    learnContext,
    runSiteTool,
    runSiteBrowserTool,
    // help() prints by itself so `zenius nodejs -e 'help()'` shows the text,
    // and still returns it for scripts that inspect it.
    help: (...names: unknown[]) => {
      const text = helpText(...names);
      bufferOutput(`${text}\n`);
      return text;
    },
  };
}

/**
 * After a script whose actions waited while the user paused its task space
 * (the takeover prompt or the panel's Pause), say so once on stderr: the page
 * may have changed under the agent. A hard stop's guidance already says what
 * happened, so it gets no notice.
 */
function heldNotice(client: RpcClient): void {
  if (hasHardStop()) return;
  for (const [space, ms] of client.heldMsBySpace()) {
    writeStderr(
      `[zenius] The user paused task space ${space}; your actions waited ${(ms / 1000).toFixed(1)} s. The page may have changed: take a fresh snapshot.\n`,
    );
  }
}

function skill(rest: string[]): number {
  if (rest.length > 0) return usageError("zenius skill takes no arguments");
  const guide = readGuide();
  if (guide.text === undefined) {
    writeStderr(`zenius skill: no usage guide found; checked:\n${guide.checked.map((path) => `  ${path}`).join("\n")}\n`);
    return 1;
  }
  writeStdout(guide.text);
  return 0;
}

function help(rest: string[]): number {
  if (rest.length === 0) {
    const index = defaultEntries().map((entry) => `  ${entry.signature}`).join("\n");
    writeStdout(
      `${usage()}\nScript API (zenius help <name> for details, zenius help all for everything):\n${index}\n` +
        `Site learnings: zenius help learnings\n`,
    );
    return 0;
  }
  if (rest.length === 1 && rest[0] === "all") {
    writeStdout(`${API_SCHEMA.map(formatEntry).join("\n\n")}\n`);
    return 0;
  }
  const text = helpText(...rest);
  writeStdout(`${text}\n`);
  return text.split("\n\n").every((block) => block.startsWith("Unknown helper:")) ? 1 : 0;
}

function usageError(message: string): number {
  writeStderr(`${message}\n\n${usage()}`);
  return 2;
}

/**
 * Read the heredoc. A synchronous read of fd 0 avoids process.stdin, whose
 * stream setup loads node:net; a non-blocking pipe falls back to the stream.
 */
async function readStdin(): Promise<string> {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
  }
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// bin/zenius imports this module and calls main(). Run directly
// (`node dist/zenius.mjs …` or `node src/cli.ts …`), it runs the CLI itself.
if (process.argv[1] && url.pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  process.exit(await main(process.argv.slice(2)));
}
