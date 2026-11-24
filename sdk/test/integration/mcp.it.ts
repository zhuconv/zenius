// zenius mcp (zen-core's src/mcp.ts) driven over stdio as Claude Code or
// Codex would, against the suite's dev Zen: the tools, the steps they read
// as, the errors from the guide, and what the server never offers.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { unique, useContext } from "./context.ts";

const SDK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const context = useContext();

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** A minimal MCP client on a spawned `zenius mcp`. */
class Client {
  readonly child: ChildProcessWithoutNullStreams;
  #next = 1;
  #pending = new Map<number, (message: any) => void>();
  #buffer = "";
  stderr = "";

  constructor(instance: string, env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [path.join(SDK, "bin/zenius"), "mcp"], {
      env: { ...process.env, ZENIUS_INSTANCE: instance, ...env },
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
        this.#pending.get(message.id)?.(message);
        this.#pending.delete(message.id);
      }
    });
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk));
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.#next++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
    const response = await this.request("tools/call", { name, arguments: args });
    assert.ok(response.result, JSON.stringify(response));
    return response.result as Result;
  }

  /** A call that must succeed: its text, whose first line is the step. */
  async ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.call(name, args);
    const text = result.content[0]!.text;
    assert.ok(!result.isError, `${name}: ${text}`);
    return text;
  }

  close(): Promise<void> {
    this.child.stdin.end();
    return new Promise((resolve) => this.child.once("exit", () => resolve()));
  }
}

/** A server started and initialized as Claude Code starts it, with `env` over the suite's. */
async function started(env: Record<string, string> = {}): Promise<Client> {
  const started = new Client(context.instance, env);
  const init = await started.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "test" },
  });
  assert.equal(init.result.serverInfo.name, "zenius");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  started.notify("notifications/initialized");
  return started;
}

type Listed = { id: number; name: string; createdBy: string; ownership: string };
const spaces = async () => (await context.rpc.call<{ taskSpaces: Listed[] }>("spaces.list")).taskSpaces;
async function spaceNamed(name: string): Promise<Listed> {
  const space = (await spaces()).find((entry) => entry.name === name);
  assert.ok(space, `no space named ${name}`);
  return space;
}
const chrome = (code: string, arg: unknown) => context.rpc.call("dev.evalChrome", { code, arg });
/** zen-ux's Take over of the task's p1, as the user presses it (tests/core/handoff.test.mjs). */
const takeOver = (space: number) =>
  chrome(
    `const s = ctx.spaces.get(arg.space);
     await ctx.service.userTakeOver(s, ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser);
     return true;`,
    { space, label: "p1" },
  );
/** The user's Resume agent (tests/core/ownership.test.mjs gives a task back this way). */
const resumeAgent = (space: number) => chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "agent", { source: "user" }); return true;`, space);
/** The user's Resume agent as zen-ux's panel presses it: beforeHandBack first, where a secret step's tab is blanked (tests/core/handoff.test.mjs). */
const resumeByUser = (space: number) =>
  chrome(
    `const s = ctx.spaces.get(arg);
     await ctx.service.beforeHandBack(s);
     ctx.spaces.setOwnership(s, "agent", { source: "user" });
     return true;`,
    space,
  );
/** The panel's Stop. */
const stopTask = (space: number) => chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "user", { source: "user" }); return true;`, space);
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let client: Client;
before(async () => {
  client = await started();
});
after(() => client?.close());

test("mcp: the tools are the browser's steps and a problem report, each told in one sentence, and nothing else", async () => {
  const { result } = await client.request("tools/list");
  const names = result.tools.map((tool: { name: string }) => tool.name);
  assert.deepEqual(names, ["open", "goto", "read_page", "click", "fill", "press", "scroll", "select", "wait", "hand_off", "flag_page", "finish", "evaluate", "report_problem"]);
  for (const tool of result.tools) {
    assert.match(tool.description, /^[A-Z][^.]*\.$/, `${tool.name}: one sentence`);
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.title && tool.annotations.title === tool.title, tool.name);
  }
  // No dev.* method, setting, shell, file or upload tool.
  assert.ok(!names.some((name: string) => /dev|setting|shell|exec|file|upload|screenshot|fetch/i.test(name)));
});

test("mcp: report_problem has Zen compose the report, and with no sidebar here to show it says so plainly", async () => {
  // This lane's dev profile has no agent sidebar (zen-dev.sh leaves its scripts
  // out), so the runtime composes the report, with the server's source, and
  // refuses to propose it.
  const text = await client.ok("report_problem", { line: "page.click failed twice with ZEN_INTERNAL on a button in a shadow root", wait: 1 });
  assert.deepEqual(text.split("\n"), [
    'Report a problem with zenius: "page.click failed twice with ZEN_INTERNAL on a button in a shadow root"',
    "Zen has no agent sidebar to show the report in, so nothing was shown, saved or sent.",
    "Then finish the task with zenius's other tools if you can; otherwise stop and tell the user what failed.",
  ]);
});

test("mcp: open, type, select, press, read, click, wait, scroll and run code read as steps and work", async () => {
  const task = unique("it mcp");
  const form = `${context.base}/form`;
  const host = new URL(form).host;
  const opened = await client.ok("open", { url: form, task });
  assert.equal(opened.split("\n")[0], `Open ${host}/form`);
  assert.match(opened, new RegExp(`Started the task "${task}"\\. Opened p1: sdk form — ${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  // A password field the page's own name doesn't give away: after a fill on
  // its ref, the step names the kind from what the field shows, never the text.
  await client.ok("evaluate", { code: `document.querySelector("#form").insertAdjacentHTML("beforeend", '<input name="f2" type="password">')` });
  const fields = await client.ok("read_page");
  const refOf = (name: string) => new RegExp(`textbox \\[ref=(\\d+), loc=css:input\\[name="${name}"\\]\\]`).exec(fields)?.[1];
  assert.ok(refOf("f2") && refOf("name"), fields);
  const secret = await client.ok("fill", { element: "Field 2", target: `ref=${refOf("f2")}`, text: "hunter2-Secret" });
  assert.equal(secret.split("\n")[0], 'Type a password into "Field 2"');
  assert.doesNotMatch(secret, /hunter2/);
  // A field that shows its text, on its ref and by a selector.
  const typed = await client.ok("fill", { element: "Name", target: `ref=${refOf("name")}`, text: "Grace" });
  assert.equal(typed.split("\n")[0], 'Type "Grace" into "Name"');
  assert.equal((await client.ok("fill", { element: "Name", target: "#name", text: "Ada" })).split("\n")[0], 'Type "Ada" into "Name"');

  const selected = await client.ok("select", { element: "Month", target: "#month", options: ["March"] });
  assert.deepEqual(selected.split("\n"), ['Select "March" in "Month"', 'Selected "m3".']);
  assert.equal(
    await client.ok("evaluate", { code: "() => [document.querySelector('#name').value, document.querySelector('#month').value, document.querySelector('[name=f2]').value]" }),
    'Run code in the page\n[\n  "Ada",\n  "m3",\n  "hunter2-Secret"\n]',
  );
  const pressed = await client.ok("press", { key: "Enter", element: "Name", target: "#name" });
  assert.equal(pressed.split("\n")[0], 'Press Enter on "Name"');
  assert.equal(await client.ok("evaluate", { code: "document.documentElement.dataset.submitted" }), 'Run code in the page\n"true"');

  assert.equal((await client.ok("goto", { url: `${context.base}/` })).split("\n")[0], `Go to ${host}`);
  const read = await client.ok("read_page");
  assert.equal(read.split("\n")[0], "Read the page");
  // The link's ref, as read_page shows it: [ref=N, …] on its line, its text below.
  const ref = /\[ref=(\d+)[^\]]*\]\s*\n\s*text "two"/.exec(read)?.[1];
  assert.ok(ref, read);
  const clicked = await client.ok("click", { element: "two", target: `ref=${ref}` });
  assert.equal(clicked.split("\n")[0], 'Click "two"');
  assert.match(clicked, /The tab went to p1: sdk fixture two — .*\/two$/m);
  assert.equal((await client.ok("wait", { text: "page two" })).split("\n")[0], 'Wait for "page two"');
  assert.deepEqual((await client.ok("scroll")).split("\n"), ["Scroll down", "Done."]);

  // The user reads the kept tab by its title and host, the agent by its label.
  const finished = await client.ok("finish", { keep: ["p1"] });
  assert.equal(finished, `Finish, keeping 1 tab\n  "sdk fixture two" — ${host}\nThe task is finished: kept p1.`);
});

test("mcp: read_page reads what's in view, says what's beyond it in its own words, and reads the whole page with full", async () => {
  await client.ok("open", { url: `${context.base}/keys`, task: unique("it mcp read") });
  // /keys runs 3000 px below the fold.
  const inView = await client.ok("read_page");
  assert.match(inView, /\[more content below the viewport: [^\]]*; scroll, or read_page with full: true\]/);
  assert.doesNotMatch(inView, /snapshot\(/, "no SDK call the agent can't make");
  const whole = await client.ok("read_page", { full: true });
  assert.equal(whole.split("\n")[0], "Read the whole page");
  assert.doesNotMatch(whole, /more content/);
  assert.ok((await client.call("read_page", { full: true, root: "ref=1" })).isError, "a part or the whole, not both");
  await client.ok("finish", { keep: "none" });
});

test("mcp: after the user's Take over the agent waits for Resume agent, and after their Stop it hears the task ended", async () => {
  const name = unique("it mcp stops");
  await client.ok("open", { url: `${context.base}/`, task: name });
  const listed = await context.rpc.call<{ taskSpaces?: Array<{ id: number; name: string }> }>("spaces.list");
  const id = listed.taskSpaces?.find((space) => space.name === name)?.id;
  assert.ok(id, JSON.stringify(listed));
  const chrome = (code: string, arg: unknown) => context.rpc.call("dev.evalChrome", { code, arg });

  // zen-ux's Take over, as the user presses it (tests/core/handoff.test.mjs).
  await chrome(
    `const s = ctx.spaces.get(arg.space);
     await ctx.service.userTakeOver(s, ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser);
     return true;`,
    { space: id, label: "p1" },
  );
  const held = await client.call("click", { element: "two", target: "#next" });
  assert.ok(held.isError);
  assert.match(held.content[0]!.text, /^Click "two" failed\.\nZEN_TASK_SPACE_USER_IN_CONTROL: The user has the task now \(you handed it off, or they pressed Take over in Zen\)/);
  assert.doesNotMatch(held.content[0]!.text, /TaskSpace\(|const task/);
  // They press Resume agent (tests/core/ownership.test.mjs gives a task back this way).
  await chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "agent", { source: "user" }); return true;`, id);
  assert.equal(await client.ok("wait", { user: true, seconds: 5 }), "Wait for the user to resume the agent\nThe user resumed the agent.");
  assert.match(await client.ok("click", { element: "two", target: "#next" }), /^Click "two"\nDone\.\nThe tab went to p1: sdk fixture two/);

  // The panel's Stop: the task ends, and the agent hears so in its own tools' words.
  await chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "user", { source: "user" }); return true;`, id);
  const ended = await client.call("read_page");
  assert.ok(ended.isError);
  assert.equal(
    ended.content[0]!.text,
    "Read the page failed.\nZEN_TASK_SPACE_INACTIVE: The user stopped the task in Zen, and its tabs are theirs now. Don't retry. If the user asks for more, open starts a new task.",
  );
  assert.match((await client.call("click", { element: "two", target: "#next" })).content[0]!.text, /there is no task yet/);
  await client.ok("open", { url: `${context.base}/`, task: unique("it mcp after stop") });
  await client.ok("finish", { keep: "none" });
});

test("mcp: a failure comes back readable, from the error guide, and the server goes on", async () => {
  const blocked = await client.call("open", { url: "file:///etc/passwd" });
  assert.ok(blocked.isError);
  assert.equal(blocked.content[0]!.text, "Open file:///etc/passwd failed.\nonly http and https pages can be opened here, not file: URLs");

  assert.ok((await client.call("click", { element: "x", target: "#x" })).isError, "no task yet");
  await client.ok("open", { url: `${context.base}/`, task: unique("it mcp errors") });
  const missing = await client.call("wait", { target: "#not-there", seconds: 1 });
  assert.ok(missing.isError);
  const text = missing.content[0]!.text;
  assert.match(text, /^Wait for "#not-there" failed\.\n/);
  assert.doesNotMatch(text, /help\(/, "no pointer to a script's help()");

  const handed = await client.ok("hand_off", { message: "Sign in, then hand it back" });
  assert.equal(handed.split("\n")[0], 'Ask the user: "Sign in, then hand it back"');
  const held = await client.call("click", { element: "two", target: "#next" });
  assert.ok(held.isError);
  // The code for the agent, and what to do in its tools' words, never a script's takeOverTaskSpace().
  assert.match(held.content[0]!.text, /^Click "two" failed\.\nZEN_TASK_SPACE_USER_IN_CONTROL: The user has the task now .*press it, then call wait with user: true\.$/);
  assert.doesNotMatch(held.content[0]!.text, /TaskSpace\(|const task/);
  // The user hasn't pressed Resume agent yet: not a failure, the agent waits again.
  assert.equal(
    await client.ok("wait", { user: true, seconds: 1 }),
    "Wait for the user to resume the agent\nNot yet: the user hasn't resumed the agent in 1 second. Call wait with user: true again to go on waiting.",
  );
});

test("mcp: hand_off's reason is the task's, which Zen's strip reads", async () => {
  const name = unique("it mcp reason");
  const agent = await started();
  try {
    await agent.ok("open", { url: `${context.base}/form`, task: name });
    await agent.ok("hand_off", { message: "Sign in to Accounts", reason: "sign_in" });
    const space = await spaceNamed(name);
    assert.deepEqual(
      await chrome(
        `const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
         return { reason: ctx.spaces.get(arg).reason ?? null, waitsFor: UI.tasks().find((row) => row.id === arg)?.waitsFor ?? null };`,
        space.id,
      ),
      { reason: "sign_in", waitsFor: "sign_in" },
    );
    await resumeByUser(space.id);
    await agent.ok("wait", { user: true, seconds: 5 });
    await agent.ok("finish", { keep: "none" });
  } finally {
    await agent.close();
  }
});

test("mcp: hand_off with secret: true says zenius clears the tab at Resume, and wait says it did", async () => {
  const name = unique("it mcp secret");
  const agent = await started();
  try {
    await agent.ok("open", { url: `${context.base}/form`, task: name });
    assert.equal(
      await agent.ok("hand_off", { message: "Copy your new API token", secret: true }),
      'Ask the user: "Copy your new API token"\nZen shows the user your message, and the task is theirs until they press Resume agent. Call wait with user: true to wait for that. When they resume, zenius clears that tab first: ask the user for anything you need from what it showed.',
    );
    const space = await spaceNamed(name);
    await resumeByUser(space.id);
    assert.equal(
      await agent.ok("wait", { user: true, seconds: 5 }),
      "Wait for the user to resume the agent\nThe user resumed the agent.\nzenius cleared p1, which showed the user a secret: it shows about:blank now. Don't go back to that page; ask the user for anything you need from it.",
    );
    assert.equal(await chrome(`const s = ctx.spaces.get(arg); return ctx.pages.tabFor(ctx.pages.get(s, "p1")).linkedBrowser.currentURI.spec;`, space.id), "about:blank");
    await agent.ok("finish", { keep: "none" });
  } finally {
    await agent.close();
  }
});

test("mcp: flag_page flags the page with the agent's reason, which the runtime holds to one line", async () => {
  const agent = await started();
  try {
    const task = unique("it mcp flag");
    await agent.ok("open", { url: `${context.base}/form`, task });
    const reason = "Asks for a bank password the task doesn't need";
    const flagged = await agent.ok("flag_page", { reason });
    assert.equal(flagged.split("\n")[0], `Flag the page: "${reason}"`);
    assert.match(flagged, /Zen warns the user on p1 with your reason/);
    const { id } = await spaceNamed(task);
    const evidence = await chrome(
      `const s = ctx.spaces.get(arg);
       const b = ctx.pages.tabFor(ctx.pages.get(s, "p1")).linkedBrowser;
       return ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs").evidenceOf(b);`,
      id,
    );
    assert.deepEqual(evidence, { flagged: reason });
    const refused = await agent.call("flag_page", { reason: "two\nlines" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]!.text, /one line of 1 to 200 characters/);
    await agent.ok("finish", { keep: "none" });
  } finally {
    await agent.close();
  }
});

test("mcp: a task the MCP opens says who drives it: Claude Code, its hc terminal and the working folder's name, as spaces.list lists it", async () => {
  // ZENIUS_CLIENT blank: the client's own name at initialize decides, whatever runs the suite.
  const agent = await started({ HC_TERMINAL_ID: "t-mcp", ZENIUS_CLIENT: "" });
  try {
    const task = unique("it mcp source");
    await agent.ok("open", { url: `${context.base}/`, task });
    const listed = (await context.rpc.call<{ taskSpaces: Array<Listed & { source?: Record<string, string> }> }>("spaces.list")).taskSpaces.find((entry) => entry.name === task);
    assert.ok(listed, `no space named ${task}`);
    const { folder: shown, ...rest } = listed.source ?? {};
    assert.deepEqual(rest, { terminal: "t-mcp", agent: "Claude Code" });
    // The folder's base name, never a path; one outside the label set shows as something close to itself.
    const folder = path.basename(process.cwd());
    if (/^[A-Za-z0-9 _.\/:@#-]{1,80}$/.test(folder)) assert.equal(shown, folder);
    else assert.ok(shown === undefined || !shown.includes("/"), String(shown));
    await agent.ok("finish", { keep: "none" });
  } finally {
    await agent.close();
  }
});

// A task is its chat's, not its name's: the agent sidebar found two work
// chats whose agents named their tasks alike sharing one, so one chat's
// agent could act in the other's tabs.
test("mcp: two chats that name their tasks alike get a task each, also while the first is the user's", async () => {
  const name = unique("it mcp twins");
  const [one, other] = [await started(), await started()];
  try {
    await one.ok("open", { url: `${context.base}/`, task: name });
    const first = await spaceNamed(name);
    // zen-sidebar's case: the user has the first chat's task (Take over).
    await takeOver(first.id);
    const opened = await other.ok("open", { url: `${context.base}/form`, task: name });
    assert.match(opened, new RegExp(`Started the task "${escaped(name)} 2"\\. Opened p1: sdk form`));
    assert.notEqual((await spaceNamed(`${name} 2`)).id, first.id);
    assert.equal((await spaceNamed(name)).ownership, "agentDelegatedToUser");
    await other.ok("finish", { keep: "none" });
    await resumeAgent(first.id);
    await one.ok("finish", { keep: "none" });
  } finally {
    await one.close();
    await other.close();
  }
});

test("mcp: a long task name is cut before its number, so open's result shows each task's whole name", async () => {
  const long = `${unique("it mcp long")} ${"word ".repeat(20)}end`;
  const chats = [await started(), await started()];
  try {
    const names: string[] = [];
    for (const chat of chats) {
      const opened = await chat.ok("open", { url: `${context.base}/`, task: long });
      names.push(/Started the task "([^"]*)"\./.exec(opened)?.[1] ?? "");
    }
    const [first, second] = names as [string, string];
    assert.ok(first.startsWith("it mcp long") && !first.endsWith("…") && Array.from(first).length <= 80, first);
    assert.ok(second.endsWith(" word 2") && Array.from(second).length <= 80, second);
    const listed = (await spaces()).map((space) => space.name);
    assert.ok(listed.includes(first) && listed.includes(second), "the names shown are the tasks' own");
  } finally {
    for (const chat of chats) {
      await chat.call("finish", { keep: "none" });
      await chat.close();
    }
  }
});

test("mcp: a resumed chat goes on in its task (ZENIUS_TASK_SPACE), also while the user has it", async () => {
  const name = unique("it mcp resumed");
  const parked = await started();
  await parked.ok("open", { url: `${context.base}/`, task: name });
  // The sidebar parks the session: its server ends, and the task stays.
  await parked.close();
  const space = await spaceNamed(name);
  assert.equal(space.ownership, "agent");

  const resumed = await started({ ZENIUS_TASK_SPACE: String(space.id) });
  try {
    // Its one tab is the current one.
    assert.match(await resumed.ok("read_page"), /^Read the page\n/);
    // A later open adds a tab to that task, whatever name it gives.
    const opened = await resumed.ok("open", { url: `${context.base}/form`, task: unique("it mcp not started") });
    assert.doesNotMatch(opened, /Started the task/);
    assert.match(opened, /Opened p2: sdk form/);
    assert.ok(!(await spaces()).some((entry) => entry.name.startsWith("it mcp not started")));
    assert.doesNotMatch(resumed.stderr, /ZENIUS_TASK_SPACE/);
  } finally {
    await resumed.close();
  }

  // Parked again while the user has the task: the next server goes on in it, and hears whose it is.
  await takeOver(space.id);
  const held = await started({ ZENIUS_TASK_SPACE: String(space.id) });
  try {
    const refused = await held.call("click", { page: "p1", element: "two", target: "#next" });
    assert.ok(refused.isError);
    assert.match(refused.content[0]!.text, /^Click "two" failed\.\nZEN_TASK_SPACE_USER_IN_CONTROL: The user has the task now/);
    await resumeAgent(space.id);
    assert.equal(await held.ok("wait", { user: true, seconds: 5 }), "Wait for the user to resume the agent\nThe user resumed the agent.");
    assert.match(await held.ok("click", { element: "two", target: "#next" }), /^Click "two"\nDone\.\nThe tab went to p1: sdk fixture two/);
    await held.ok("finish", { keep: "none" });
  } finally {
    await held.close();
  }
});

test("mcp: a ZENIUS_TASK_SPACE that is the user's, a kept tab's, stopped, unknown or no id is ignored, and open starts a new task", async () => {
  const url = `${context.base}/`;
  const maker = await started();
  const keptName = unique("it mcp kept");
  const stoppedName = unique("it mcp stopped");
  let kept: Listed;
  let stopped: Listed;
  try {
    // Finished with a kept tab: the task stays listed, the user's, while that tab is open.
    await maker.ok("open", { url, task: keptName });
    await maker.ok("finish", { keep: ["p1"] });
    kept = await spaceNamed(keptName);
    await maker.ok("open", { url, task: stoppedName });
    stopped = await spaceNamed(stoppedName);
    await stopTask(stopped.id);
  } finally {
    await maker.close();
  }
  const userSpace = (await spaces()).find((entry) => entry.createdBy === "user" && entry.ownership === "user");
  assert.ok(userSpace, "the dev Zen has the user's own Space");
  const cases: Array<[string, string, RegExp]> = [
    [String(userSpace.id), "the user's own Space", /^zenius mcp: ignoring ZENIUS_TASK_SPACE="\d+": task \d+ ".*" is the user's now\. The agent's open starts a new task\.$/],
    [String(kept.id), "a task finished with a kept tab", new RegExp(`: task ${kept.id} "${escaped(keptName)}" is the user's now\\.`)],
    [String(stopped.id), "a task the user stopped", new RegExp(`: task ${stopped.id} "${escaped(stoppedName)}" is the user's now\\.`)],
    ["999999", "an id no task has", /^zenius mcp: ignoring ZENIUS_TASK_SPACE="999999": no task has that id in instance ".+"\. The agent's open starts a new task\.$/],
    ["p1", "a label, not an id", /^zenius mcp: ignoring ZENIUS_TASK_SPACE="p1": it isn't a task's id\. The agent's open starts a new task\.$/],
  ];
  for (const [value, what, why] of cases) {
    const named = (await spaces()).find((entry) => String(entry.id) === value);
    const chat = await started({ ZENIUS_TASK_SPACE: value });
    try {
      const name = unique("it mcp fresh");
      assert.match(await chat.ok("open", { url, task: name }), new RegExp(`Started the task "${escaped(name)}"\\. Opened p1:`), what);
      const lines = chat.stderr.split("\n").filter((line) => line.includes("ZENIUS_TASK_SPACE"));
      assert.equal(lines.length, 1, `${what}: ${chat.stderr}`);
      assert.match(lines[0]!, why, what);
      // The space it named is as it was: never adopted.
      if (named) assert.deepEqual((await spaces()).find((entry) => entry.id === named.id), named, what);
      await chat.ok("finish", { keep: "none" });
    } finally {
      await chat.close();
    }
  }
});
