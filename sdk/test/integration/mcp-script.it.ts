// zenius mcp's script tool (src/mcp.ts, src/mcp-script.ts), driven over
// stdio through the sandboxed launcher (scripts/install-cli.sh --sandbox),
// as the agent sidebar starts it (`mcp --sidebar`), against the suite's dev
// Zen: many steps in one call, the output and the value, an error's code,
// the time limit and a cancel, the task functions, the page-code setting,
// the files a script touched, and the script's step in the task with the
// steps of its calls under it. The launcher goes into a scratch folder with
// the scratch HOME of test/integration/scratch-env.ts, never ~/.local/bin.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { guardHome } from "../../../tests/lib/scratch-home.mjs";
import { unique, useContext } from "./context.ts";
import { noted } from "./fixtures.ts";

const SDK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT = path.dirname(SDK);
const context = useContext();

const SANDBOX =
  process.platform === "linux"
    ? spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "true"]).status === 0
    : process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const skip = SANDBOX ? false : "no OS sandbox here for the launcher";

/** The scratch folder: the launcher, its CLI copy, and its temporary folders. */
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zenius-mcp-script-")));
const launcher = path.join(root, "bin", "zenius");
/** The working folder, the dev Zen's own (test-integration.sh), as the launcher's config names it. */
const working = process.env.ZENIUS_IT_WORKING_DIR ?? "";

before(() => {
  if (!SANDBOX) return;
  assert.ok(working, "test-integration.sh names the working folder");
  const install = spawnSync("bash", [path.join(ROOT, "scripts/install-cli.sh"), "--sandbox"], {
    encoding: "utf8",
    env: guardHome(
      {
        ...process.env,
        ZENIUS_CLI_DIR: path.join(root, "cli"),
        ZENIUS_BIN_DIR: path.dirname(launcher),
        ZENIUS_SKILL_DIRS: `${path.join(root, "claude")} ${path.join(root, "agents")}`,
        // test-integration.sh built dist/ already; another build would race the suite.
        ZENIUS_INSTALL_NO_BUILD: "1",
      },
      "mcp-script.it",
    ),
  });
  assert.equal(install.status, 0, `${install.stdout}${install.stderr}`);
});

after(() => rmSync(root, { recursive: true, force: true }));

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** A minimal MCP client on the launcher's `zenius mcp`. */
class Client {
  readonly child: ChildProcessWithoutNullStreams;
  #next = 1;
  #pending = new Map<number, (message: any) => void>();
  #buffer = "";
  readonly answered: number[] = [];
  stderr = "";

  constructor(args: string[], env: Record<string, string> = {}) {
    this.child = spawn(launcher, ["mcp", ...args], {
      cwd: working,
      env: guardHome({ ...process.env, ZENIUS_INSTANCE: context.instance, TMPDIR: root, ...env }, "mcp-script.it"),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline: number;
      while ((newline = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        const message = JSON.parse(line);
        if (typeof message.id === "number") this.answered.push(message.id);
        this.#pending.get(message.id)?.(message);
        this.#pending.delete(message.id);
      }
    });
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk));
  }

  /** Sends a request; its answer, once it comes. `id` comes back at once for a cancel. */
  send(method: string, params: Record<string, unknown> = {}): { id: number; answer: Promise<any> } {
    const id = this.#next++;
    const answer = new Promise((resolve) => this.#pending.set(id, resolve));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return { id, answer };
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.send(method, params).answer;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
    const response = await this.request("tools/call", { name, arguments: args });
    assert.ok(response.result, JSON.stringify(response));
    return response.result as Result;
  }

  /** A call that must succeed: all its text, whose first line is the step. */
  async ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.call(name, args);
    const text = result.content.map((part) => part.text).join("\n");
    assert.ok(!result.isError, `${name}: ${text}\n${this.stderr}`);
    return text;
  }

  close(): Promise<void> {
    this.child.stdin.end();
    return new Promise((resolve) => (this.child.exitCode !== null ? resolve() : this.child.once("exit", () => resolve())));
  }
}

/** The sidebar's server through the launcher, initialized as Claude Code starts it. */
async function started(args = ["--sidebar"], env: Record<string, string> = {}): Promise<Client> {
  const client = new Client(args, { ZENIUS_TOOL_TIMEOUT: "120", ...env });
  const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "test" } });
  assert.equal(init.result?.serverInfo?.name, "zenius", JSON.stringify(init) + client.stderr);
  client.notify("notifications/initialized");
  return client;
}

const textOf = (result: Result) => result.content.map((part) => part.text).join("\n");

type Listed = { id: number; name: string };
async function spaceNamed(name: string): Promise<Listed> {
  const space = (await context.rpc.call<{ taskSpaces: Listed[] }>("spaces.list")).taskSpaces.find((entry) => entry.name === name);
  assert.ok(space, `no space named ${name}`);
  return space;
}
const chrome = (code: string, arg: unknown) => context.rpc.call("dev.evalChrome", { code, arg });
const STEPS = `const S = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/steps.sys.mjs");`;
type Step = { id: number; method: string; text: string; outcome: string; within?: number };
const stepsOf = async (space: number) => (await chrome(`${STEPS} return S.stepsOf(arg);`, space)) as Step[];
const evaluate = (space: number, fn: string) => context.rpc.call("page.evaluate", { space, page: "p1", fn, isFunction: false });

async function until<T>(check: () => Promise<T | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`${what}: not so after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("mcp script: many steps in one call, its output and value, and its step in the task with its calls' steps under it", { skip }, async () => {
  const client = await started();
  try {
    const tools = await client.request("tools/list");
    assert.ok(tools.result.tools.some((tool: { name: string }) => tool.name === "script"), "the sidebar's server offers it");
    const name = unique("it mcp script");
    await client.ok("open", { url: `${context.base}/form`, task: name });
    const space = (await spaceNamed(name)).id;
    const text = await client.ok("script", {
      purpose: 'Count "three" clicks',
      code: `for (let i = 0; i < 3; i++) await page.click("#clicker");
console.log("title:", await page.title());
return { clicks: await page.evaluate(${JSON.stringify(noted("clicks"))}) };`,
    });
    assert.match(text, /^Run a script: "Count 'three' clicks"\ntitle: sdk form\nReturned: \{\n  "clicks": 3\n\}/);
    const steps = await stepsOf(space);
    const script = steps.find((step) => step.method === "script");
    assert.ok(script, JSON.stringify(steps));
    assert.equal(script.text, `Run a script: "Count 'three' clicks"`);
    assert.equal(script.outcome, "ok");
    const clicks = steps.filter((step) => step.method === "page.click");
    assert.equal(clicks.length, 3);
    assert.ok(clicks.every((step) => step.within === script.id && step.outcome === "ok"), JSON.stringify(clicks));
    assert.ok(steps.filter((step) => step.method === "page.goto").every((step) => step.within === undefined), "open's own step is no script's");
  } finally {
    await client.close();
  }
});

test("mcp script: an error comes back with its code and the guide's words, and its step reads the code", { skip }, async () => {
  const client = await started();
  try {
    const name = unique("it mcp script error");
    await client.ok("open", { url: `${context.base}/form`, task: name });
    const space = (await spaceNamed(name)).id;
    const result = await client.call("script", { purpose: "Click what isn't there", code: `console.log("before"); await page.click("#nothing-here", { timeout: 1000 });` });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Run a script: "Click what isn't there" failed\.\nZEN_SELECTOR_NOT_FOUND: [^\n]+/);
    assert.match(textOf(result), /before/);
    const script = (await stepsOf(space)).find((step) => step.method === "script");
    assert.equal(script?.outcome, "ZEN_SELECTOR_NOT_FOUND");
  } finally {
    await client.close();
  }
});

test("mcp script: at its limit, and at a cancel, its call ends at once, its wait stops in Zen, and the next call starts", { skip }, async () => {
  const client = await started();
  try {
    const name = unique("it mcp script limit");
    await client.ok("open", { url: `${context.base}/form`, task: name });
    const space = (await spaceNamed(name)).id;
    const wait = `await page.waitForSelector("#never", { timeout: 60000 });`;

    const t0 = Date.now();
    const late = await client.call("script", { purpose: "Wait too long", code: wait, seconds: 2 });
    assert.ok(Date.now() - t0 < 8000, `it answered after ${Date.now() - t0} ms`);
    assert.match(textOf(late), /ran past its 2 s limit/);
    await until(async () => {
      const steps = await stepsOf(space);
      const script = steps.find((step) => step.method === "script");
      const waited = steps.find((step) => step.method === "page.waitForSelector");
      return script?.outcome === "ZEN_TIMEOUT" && waited?.outcome === "stopped";
    }, "the script's step reads ZEN_TIMEOUT and its wait stopped");

    const { id, answer } = client.send("tools/call", { name: "script", arguments: { purpose: "Wait for the user's word", code: wait } });
    await until(async () => (await stepsOf(space)).filter((step) => step.method === "script").length === 2, "the second script begins");
    client.notify("notifications/cancelled", { requestId: id, reason: "the user sent a message" });
    const canceled = Date.now();
    assert.match(await client.ok("read_page"), /^Read the page\n/);
    assert.ok(Date.now() - canceled < 5000, `the next call answered ${Date.now() - canceled} ms after the cancel`);
    await until(async () => {
      const steps = (await stepsOf(space)).filter((step) => step.method === "script" || step.method === "page.waitForSelector");
      return steps.length === 4 && steps.slice(2).every((step) => step.outcome === "stopped");
    }, "the canceled script's step and its wait read stopped");
    assert.ok(!client.answered.includes(id), "the canceled call got no answer");
    void answer;
  } finally {
    await client.close();
  }
});

test("mcp script: the user's Stop in the sidebar ends the call, says so, and stops its wait", { skip }, async () => {
  const client = await started();
  try {
    const name = unique("it mcp script stop");
    await client.ok("open", { url: `${context.base}/form`, task: name });
    const space = (await spaceNamed(name)).id;
    const call = client.call("script", { purpose: "Wait for the button", code: `await page.waitForSelector("#never", { timeout: 60000 });` });
    const script = await until(async () => (await stepsOf(space)).find((step) => step.method === "script" && step.outcome === "running"), "the script runs");
    await until(async () => (await stepsOf(space)).some((step) => step.method === "page.waitForSelector" && step.outcome === "running"), "its wait runs");
    assert.equal(await chrome(`${STEPS} return S.stopScript(arg);`, script.id), true);
    const result = await call;
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Run a script: "Wait for the button" stopped\.\nThe user stopped the script with Stop in Zen's sidebar/);
    await until(async () => (await stepsOf(space)).find((step) => step.method === "page.waitForSelector")?.outcome === "stopped", "its wait reads stopped");
    assert.equal((await stepsOf(space)).find((step) => step.id === script.id)?.outcome, "stopped");
    assert.match(await client.ok("read_page"), /^Read the page\n/, "the server goes on");
  } finally {
    await client.close();
  }
});

test("mcp script: the task functions keep to the server's task, and a script may start it", { skip }, async () => {
  const client = await started();
  try {
    const name = unique("it mcp script task");
    const text = await client.ok("script", {
      purpose: "Start the task",
      code: `const t = await taskSpace(${JSON.stringify(name)}); const p = await t.newPage(); await p.goto("${context.base}/"); return t.name;`,
    });
    assert.match(text, new RegExp(`Returned: "${name}"`));
    assert.match(text, new RegExp(`Started the task "${name}"\\.`));
    const space = (await spaceNamed(name)).id;
    const steps = await stepsOf(space);
    const script = steps.find((step) => step.method === "script");
    assert.equal(script?.outcome, "ok");
    assert.equal(steps.find((step) => step.method === "pages.new")?.within, script?.id, "the script's step began in the task it started");
    const other = await client.call("script", { purpose: "Name another task", code: `await taskSpace("not this server's")` });
    assert.equal(other.isError, true);
    assert.match(textOf(other), /works in its server's own task/);
    const claim = await client.call("script", { purpose: "Claim", code: "await claimTaskSpace()" });
    assert.match(textOf(claim), /only the user gives a task back/);
  } finally {
    await client.close();
  }
});

test("mcp script: page code follows the user's setting: never refuses it", { skip }, async () => {
  const MODE = "zenius.agentTabs.pageCode";
  const set = (mode: string | null) =>
    chrome(`if (arg.mode === null) Services.prefs.clearUserPref(arg.MODE); else Services.prefs.setStringPref(arg.MODE, arg.mode); return true;`, { MODE, mode });
  const client = await started();
  try {
    await client.ok("open", { url: `${context.base}/`, task: unique("it mcp script page code") });
    await set("never");
    const result = await client.call("script", { purpose: "Read the answer", code: `return await page.evaluate("6 * 7")` });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /ZEN_PAGE_CODE_OFF/);
  } finally {
    await set(null);
    await client.close();
  }
});

test("mcp script: it reads, writes and uploads in the working folder, and the result lists what it touched", { skip }, async () => {
  const client = await started();
  const input = `it-mcp-script-${process.pid}.txt`;
  const notes = `it-mcp-script-${process.pid}-notes.txt`;
  const output = `it-mcp-script-${process.pid}.csv`;
  writeFileSync(path.join(working, input), "zenius\n");
  writeFileSync(path.join(working, notes), "zenius\n");
  try {
    const name = unique("it mcp script files");
    await client.ok("open", { url: `${context.base}/ex-upload`, task: name });
    const space = (await spaceNamed(name)).id;
    const text = await client.ok("script", {
      purpose: "Upload the file and note it",
      code: `const fs = await import("node:fs");
const body = fs.readFileSync(${JSON.stringify(notes)}, "utf8");
// Uploads take absolute paths; the script starts in the working folder.
await page.setInputFiles("input[type=file]", process.cwd() + "/" + ${JSON.stringify(input)});
fs.writeFileSync(${JSON.stringify(output)}, "name\\n" + body);
return process.cwd();`,
    });
    assert.match(text, new RegExp(`Returned: "${working.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), "a script starts in the working folder");
    assert.match(text, new RegExp(`Read "${notes}"`));
    assert.doesNotMatch(text, new RegExp(`Read "${input}"`), "an uploaded file's own read isn't a line of its own");
    assert.match(text, new RegExp(`Wrote "${output}"`));
    assert.match(text, new RegExp(`Uploaded "${input}" to ${context.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.deepEqual(await evaluate(space, noted("picked")), [`${input}:7`]);
    assert.equal(readFileSync(path.join(working, output), "utf8"), "name\nzenius\n");
    const denied = await client.call("script", { purpose: "Read outside", code: `const fs = await import("node:fs"); return fs.readFileSync("/etc/hostname", "utf8");` });
    assert.equal(denied.isError, true, "outside the grants, a read fails");
  } finally {
    rmSync(path.join(working, input), { force: true });
    rmSync(path.join(working, notes), { force: true });
    rmSync(path.join(working, output), { force: true });
    await client.close();
  }
});
