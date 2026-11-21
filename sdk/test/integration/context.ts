// Shared setup for the integration suites: the dev instance the runner
// started (ZENIUS_INSTANCE), a loopback fixture server, the runtime's method
// list, and a way to run scripts through the real CLI.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { after, before, type TestContext } from "node:test";

import { instanceName, socketPath } from "../../src/instance.ts";
import { RpcClient } from "../../src/rpc.ts";
import { runCli, type CliResult } from "../helpers.ts";
import { FIXTURE_PAGES, FIXTURE_PNG } from "./fixtures.ts";

export type Context = {
  instance: string;
  /** http://127.0.0.1:<port> of the fixture server. */
  base: string;
  rpc: RpcClient;
  methods: Set<string>;
};

/** Register before/after hooks for one suite file and return its context. */
export function useContext(): Context {
  const context = { instance: instanceName(undefined), base: "", methods: new Set<string>() } as Context;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => serveFixture(request, response));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    context.base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    context.rpc = new RpcClient({ socketPath: socketPath(context.instance), instance: context.instance });
    context.methods = new Set((await context.rpc.call<{ methods: string[] }>("browser.methods")).methods);
  });
  // Runs even when tests or before() failed, with a time limit, so a kept
  // profile (zen-eval's Mac instance, a --reuse run) never collects them.
  after(
    async () => {
      try {
        if (context.rpc) await sweepTestSpaces(context);
      } finally {
        context.rpc?.close();
        // /hang never answers; drop its sockets so close() returns.
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    { timeout: SWEEP_TIMEOUT_MS + 10_000 },
  );
  return context;
}

const SWEEP_TIMEOUT_MS = 120_000;

/** unique()'s names: "it <what> <pid> <ms> <random>". */
const TEST_SPACE = String.raw`^it .+ \d+ \d+ \d+$`;

// Ends every test task space, this run's and any an earlier run left, then
// lists what's still there. Handed-off and ended spaces are taken back
// first, and untracked tabs (popups never adopted, tabs the "user" opened)
// are adopted and closed, since finish() leaves them and so the space.
const SWEEP = `const pattern = new RegExp(${JSON.stringify(TEST_SPACE)});
const errors = [];
for (const space of await listTaskSpaces()) {
  if (!pattern.test(space.name)) continue;
  try {
    const task =
      space.ownership === "agent" ? await taskSpace(space.id)
      : space.ownership === "agentDelegatedToUser" ? await takeOverTaskSpace(space.id)
      : await claimTaskSpace(space.id);
    for (const tab of await task.tabs()) {
      if (!tab.label) await (await task.adopt(tab.page)).close();
    }
    await task.finish({ keep: [] });
  } catch (error) {
    errors.push(space.name + ": " + (error.code ?? "") + " " + String(error.message).split("\\n")[0]);
  }
}
const remaining = (await listTaskSpaces()).filter((space) => pattern.test(space.name)).map((space) => space.name + " (" + space.ownership + ")");
console.log(JSON.stringify({ errors, remaining }));`;

/**
 * Answer, as the user would, the prompt that a claim of each of these spaces
 * shows, while a script claims them: send it alongside the script.
 * dev.answerClaim waits for the ask, and answers {verdict: null} once the space
 * is no longer the user's (claimed with no ask, or gone). Without the dev
 * channel nothing answers, and a claim that asks waits for a real user.
 */
export async function answerClaims(context: Context, spaces: number[], timeout = 30_000): Promise<void> {
  if (!context.methods.has("dev.answerClaim")) return;
  await Promise.all(
    spaces.map((space) =>
      context.rpc.call("dev.answerClaim", { space, allow: true, timeout }, { safetyTimeoutMs: timeout + 10_000 }),
    ),
  );
}

/** Finish every test task space; fail the suite if any is left. */
async function sweepTestSpaces(context: Context): Promise<void> {
  // The sweep claims each test task that ended (ownership "user"), and such a
  // claim asks the user. Answers still pending when the sweep ends are for
  // claims it never made: context.rpc.close() ends them, unawaited.
  // If the listing fails, the sweep still runs and reports what it couldn't end.
  const listed = await context.rpc
    .call<{ taskSpaces?: { id: number; name: string; ownership: string }[] }>("spaces.list")
    .catch(() => undefined);
  const pattern = new RegExp(TEST_SPACE);
  const ended = (listed?.taskSpaces ?? []).filter((space) => pattern.test(space.name) && space.ownership === "user");
  answerClaims(context, ended.map((space) => space.id), SWEEP_TIMEOUT_MS).catch(() => undefined);
  const result = await runCli(["nodejs", "--instance", context.instance], { stdin: SWEEP, timeoutMs: SWEEP_TIMEOUT_MS });
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  let report: { errors: string[]; remaining: string[] };
  try {
    report = JSON.parse(last);
  } catch {
    throw new Error(`the test-space sweep failed (exit ${result.code}):\n${result.stderr}\n${result.stdout}`);
  }
  const problems = [...report.errors, ...report.remaining.map((name) => `still open: ${name}`)];
  if (problems.length > 0) throw new Error(`test task spaces left on instance ${context.instance}:\n${problems.join("\n")}`);
}

/** Skip the test, naming what is missing, unless the runtime registers every method. */
export function needs(t: TestContext, context: Context, ...required: string[]): boolean {
  const missing = required.filter((method) => !context.methods.has(method));
  if (missing.length > 0) t.skip(`runtime lacks ${missing.join(", ")}`);
  return missing.length === 0;
}

export function zenius(context: Context, script: string): Promise<CliResult> {
  return runCli(["nodejs", "--instance", context.instance], { stdin: script });
}

/** Run `script` and parse the JSON it prints last. */
export async function zeniusJson<T = any>(context: Context, script: string): Promise<T> {
  const result = await zenius(context, script);
  if (result.code !== 0) throw new Error(`script failed (exit ${result.code}):\n${result.stderr}\n--- stdout ---\n${result.stdout}`);
  // The last line that parses: end-of-run notices may follow the script's output.
  for (const line of result.stdout.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line) as T;
    } catch {
      // not the script's JSON
    }
  }
  throw new Error(`script printed no JSON:\n${result.stdout}`);
}

export const unique = (prefix: string) => `${prefix} ${process.pid} ${Date.now()} ${Math.floor(Math.random() * 1000)}`;

function serveFixture(request: IncomingMessage, response: ServerResponse): void {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/hang") return; // never answers: navigation timeouts
  if (path === "/file.txt") {
    response.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="report.txt"' });
    response.end("zenius download fixture\n");
    return;
  }
  if (path === "/auth") {
    // zenius refuses the sign-in prompt, so this 401 page loads.
    response.writeHead(401, { "content-type": "text/html; charset=utf-8", "www-authenticate": 'Basic realm="zenius sdk"' });
    response.end('<!doctype html><meta charset="utf-8"><title>sdk 401</title><h1>sign-in needed</h1>');
    return;
  }
  if (path === "/api/json") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ hello: "zen", method: request.method }));
    return;
  }
  // The guide's page.fetch() examples: a JSON POST, echoed, and an image.
  if (path === "/api/items") {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ method: request.method, type: request.headers["content-type"] ?? null, received: body }));
    });
    return;
  }
  if (path === "/image.png") {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(FIXTURE_PNG);
    return;
  }
  const page = FIXTURE_PAGES[path];
  if (page === undefined) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
}
