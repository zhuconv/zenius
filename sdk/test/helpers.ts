// Shared test setup: an in-process SDK wired to a fresh mock runtime, and a
// way to run the real CLI against one.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { guardHome } from "../../tests/lib/scratch-home.mjs";
import { resetOutput } from "../src/output.ts";
import { Round, setRound } from "../src/round.ts";
import { RpcClient } from "../src/rpc.ts";
import { MockRuntime } from "./mock-runtime.ts";

export const CLI = fileURLToPath(new URL("../bin/zenius", import.meta.url));

export type MockContext = { mock: MockRuntime; client: RpcClient; round: Round };

/** Run `body` with the SDK's round pointed at a fresh mock runtime. */
export async function withMock(body: (context: MockContext) => Promise<void>): Promise<void> {
  const mock = await new MockRuntime().start();
  const client = new RpcClient({ socketPath: mock.socketPath, instance: "mock" });
  const round = new Round({ client });
  setRound(round);
  resetOutput();
  // The install's config names the mock's working folder, where a relative
  // path a script writes lands: never the user's own.
  const home = process.env.ZENIUS_HOME;
  process.env.ZENIUS_HOME = join(mock.dir, "zhome");
  mkdirSync(process.env.ZENIUS_HOME, { mode: 0o700 });
  writeFileSync(join(process.env.ZENIUS_HOME, "config.json"), `{\n  "workingFolder": "${mock.workingDir}"\n}\n`, { mode: 0o600 });
  try {
    await body({ mock, client, round });
  } finally {
    client.close();
    setRound(undefined);
    resetOutput();
    if (home === undefined) delete process.env.ZENIUS_HOME;
    else process.env.ZENIUS_HOME = home;
    await mock.stop();
  }
}

export type CliResult = { code: number | null; stdout: string; stderr: string; ms: number };

/** Run bin/zenius with `args`, feeding `stdin`, against `socketPath`. */
export function runCli(
  args: string[],
  options: { stdin?: string; socketPath?: string; env?: Record<string, string>; timeoutMs?: number; nodeArgs?: string[] } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The test process's HOME and ZENIUS_HOME are scratch ones (scratch-env.ts);
    // a test may pass others, never the account's own.
    const env = guardHome(
      {
        ...process.env,
        ZENIUS_INSTANCE: "",
        ZENIUS_TIMING: "",
        ...(options.socketPath ? { ZENIUS_SOCKET: options.socketPath } : {}),
        ...options.env,
      },
      "runCli",
    );
    const child = spawn(process.execPath, [...(options.nodeArgs ?? []), CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: performance.now() - started });
    });
    if (options.timeoutMs !== undefined) {
      // A wedged run must not hold its caller (or a hook) forever.
      timer = setTimeout(() => {
        stderr += `\n[runCli] killed after ${options.timeoutMs} ms\n`;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }
    child.stdin.end(options.stdin ?? "");
  });
}
