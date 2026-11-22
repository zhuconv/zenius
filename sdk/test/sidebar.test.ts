// `zenius sidebar …` against the mock runtime's fake sidebar.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { parseDuration } from "../src/sidebar.ts";
import { FakeSidebar } from "./fake-sidebar.ts";
import { runCli } from "./helpers.ts";
import { MockRuntime } from "./mock-runtime.ts";

let mock: MockRuntime;
let sidebar: FakeSidebar;
before(async () => {
  mock = await new MockRuntime().start();
  sidebar = new FakeSidebar(mock);
  // The limits are the bridge's tests' to check.
  sidebar.maxRunning = 100;
});
after(async () => {
  await mock.stop();
});

const run = (args: string[], options: { stdin?: string; env?: Record<string, string> } = {}) =>
  runCli(["sidebar", ...args], { socketPath: mock.socketPath, ...options, env: { HC_TERMINAL_ID: "", ...options.env } });
const lastParams = (method: string) => mock.requests.findLast((request) => request.method === method)!.params;

describe("zenius sidebar", () => {
  it("starts a task with its source and prints its id and state", async () => {
    const result = await run(["start", "Find the cheapest flight to Austin", "--from", "server/t5", "--label", "trip"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^task rt-\d+: running\n$/);
    assert.deepEqual(lastParams("sidebar.start"), { text: "Find the cheapest flight to Austin", source: { address: "server/t5", label: "trip" } });
  });

  it("passes a label outside the runtime's set as given, and prints the runtime's refusal", async () => {
    const started = sidebar.tasks.size;
    const result = await run(["start", "Find a flight", "--from", "server/t5", "--label", "café trip"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^ZEN_INVALID_ARGUMENT: zenius sidebar start: source\.label: at most 80 ASCII letters/);
    assert.equal(sidebar.tasks.size, started, "nothing started");
    assert.match((await run(["--help"])).stdout, /--label {5}a short tag after the address on the card: ASCII letters, digits,\n {14}spaces and - _ \. \/ : @ #, 80 at most\n/);
  });

  it("reads the text from stdin for -, names the hc terminal by default, and passes --harness", async () => {
    const result = await run(["start", "-", "--harness", "codex"], { stdin: "Line one\nline two\n", env: { HC_TERMINAL_ID: "t5c" } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(lastParams("sidebar.start"), { text: "Line one\nline two", source: { address: "t5c" }, harness: "codex" });
    const outside = await run(["start", "no source"]);
    assert.equal(outside.code, 2);
    assert.match(outside.stderr, /^zenius sidebar start needs --from <address> outside an hc terminal\n/);
  });

  it("waits until the turn ends, then prints the status with the answer", async () => {
    const started = await run(["start", "Read the page", "--from", "server/t5", "--json"]);
    const { taskId } = JSON.parse(started.stdout);
    const waiting = run(["status", taskId, "--wait", "20s"]);
    setTimeout(() => sidebar.answer(taskId, "The page says hello."), 300);
    const result = await waiting;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^task ${taskId}: idle, turn 1\nfrom server/t5\nstarted \\d\\d:\\d\\d:\\d\\d, updated \\d\\d:\\d\\d:\\d\\d, stops by \\d\\d:\\d\\d:\\d\\d\n\nThe page says hello.\n$`));

    // A follow-up starts a turn; one sent while it runs is refused with the runtime's code.
    const followUp = await run(["send", taskId, "And the title?"]);
    assert.equal(followUp.code, 0, followUp.stderr);
    assert.equal(followUp.stdout, `task ${taskId}: running\n`);
    const busy = await run(["send", taskId, "Too soon"]);
    assert.equal(busy.code, 1);
    assert.match(busy.stderr, /^ZEN_REMOTE_TASK_BUSY: zenius sidebar send: a turn is running\nWait for the turn to end/);
    const timedOut = await run(["status", taskId, "--wait", "1500ms"]);
    assert.equal(timedOut.code, 1);
    assert.match(timedOut.stdout, new RegExp(`^task ${taskId}: running, turn 1\n`));
    assert.match(timedOut.stderr, new RegExp(`task ${taskId} is still running after 1500 ms`));
  });

  it("lists the tasks, stops one, and prints the runtime's JSON with --json", async () => {
    const { taskId } = JSON.parse((await run(["start", "Stop me", "--from", "server2/t3", "--json"])).stdout);
    const stopped = await run(["stop", taskId]);
    assert.equal(stopped.stdout, `task ${taskId}: stopped\n`);
    const list = await run(["list"]);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, new RegExp(`^${taskId}  stopped \\(caller\\)  turn 0  from server2/t3  started \\d\\d:\\d\\d:\\d\\d$`, "m"));
    const json = JSON.parse((await run(["list", "--json"])).stdout);
    assert.equal(json.tasks.find((task: { taskId: string }) => task.taskId === taskId).stopReason, "caller");
  });

  it("refuses bad arguments with exit 2, and never starts Zen: with nothing listening it fails with ZEN_BROWSER_UNAVAILABLE", async () => {
    for (const [args, message] of [
      [[], /^zenius sidebar needs a verb\n/],
      [["pause", "1"], /^zenius sidebar: unknown verb pause\n/],
      [["status"], /^zenius sidebar status takes <taskId>\n/],
      [["send", "rt-1", "hi", "--label", "x"], /^zenius sidebar send has no --label\n/],
      [["status", "rt-1", "--wait", "soon"], /--wait takes a time such as 90s, 10m or 1h, not soon\n/],
    ] as const) {
      const result = await run([...args]);
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.stderr, message);
    }
    const dir = mkdtempSync(join(tmpdir(), "zenius-sidebar-"));
    try {
      const closed = await runCli(["sidebar", "list"], { socketPath: join(dir, "none.sock") });
      assert.equal(closed.code, 1);
      assert.match(closed.stderr, /^ZEN_BROWSER_UNAVAILABLE: zenius sidebar list: zenius instance .* is not running/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(parseDuration("10m"), 600_000);
    assert.equal(parseDuration("200ms"), 200);
    assert.equal(parseDuration("90"), 90_000);
    assert.equal(parseDuration("0s"), undefined);
  });
});
