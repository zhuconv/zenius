// `zenius wait` against the mock runtime: its exit codes, the keepNotes it
// asks with, and its wait across a restart of the runtime.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { runCli } from "./helpers.ts";
import { MockError, MockRuntime } from "./mock-runtime.ts";

let mock: MockRuntime;
before(async () => {
  mock = await new MockRuntime().start();
  realWaits(mock);
});
after(async () => {
  await mock.stop();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = (args: string[], socketPath = mock.socketPath) => runCli(["wait", ...args], { socketPath, timeoutMs: 30_000 });
const waitCalls = (runtime: MockRuntime) => runtime.requests.filter((request) => request.method === "spaces.waitForControl");

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
}

/** spaces.waitForControl as the runtime does it: until the space is the agent's, its task ends, or the call's timeout. */
function realWaits(runtime: MockRuntime): void {
  runtime.handle("spaces.waitForControl", async (params) => {
    const space = runtime.space(params);
    const end = Date.now() + Number(params.timeout ?? 30_000);
    while (true) {
      if (space.ownership === "agent") return { ownership: "agent" };
      if (space.ownership === "user") throw new MockError("ZEN_TASK_SPACE_INACTIVE", `Task space ${space.id}'s task ended`, { space: space.id });
      if (Date.now() >= end) throw new MockError("ZEN_TIMEOUT", `task.waitForControl timed out after ${params.timeout}ms`, { space: space.id });
      await sleep(20);
    }
  });
}

describe("zenius wait", () => {
  it("exits 0 once the user hands the task back, asking with keepNotes, and says how to go on", async () => {
    const space = mock.addSpace("wait back", "agentDelegatedToUser");
    setTimeout(() => (space.ownership = "agent"), 300);
    const result = await wait([String(space.id)]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `Task ${space.id} is yours again: the user handed it back. Take it over with takeOverTaskSpace(${space.id}) and go on.\n`);
    const asked = waitCalls(mock).at(-1)!;
    assert.equal(asked.params.space, space.id);
    assert.equal(asked.params.keepNotes, true, "it leaves the hand back's notes to the agent's takeOver");
  });

  it("exits 0 at once when the agent has the task already", async () => {
    const space = mock.addSpace("wait agent", "agent");
    const result = await wait([String(space.id)]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.ms < 5000, `took ${result.ms}ms`);
  });

  it("exits 3 when the task ends or is gone", async () => {
    const space = mock.addSpace("wait ends", "agentDelegatedToUser");
    setTimeout(() => (space.ownership = "user"), 300);
    const ended = await wait([String(space.id)]);
    assert.equal(ended.code, 3, ended.stderr);
    assert.match(ended.stderr, /^ZEN_TASK_SPACE_INACTIVE: zenius wait: .*task has ended/);
    const gone = await wait(["999"]);
    assert.equal(gone.code, 3, gone.stderr);
    assert.match(gone.stderr, /^ZEN_TASK_SPACE_NOT_FOUND: zenius wait: /);
  });

  it("exits 4 at --timeout, asking again as each call's own limit passes", async () => {
    const space = mock.addSpace("wait timeout", "agentDelegatedToUser");
    const before = waitCalls(mock).length;
    const result = await wait([String(space.id), "--timeout", "1"]);
    assert.equal(result.code, 4, result.stderr);
    assert.equal(result.stderr, `zenius wait: task ${space.id} is still the user's after 1 s. Run zenius wait ${space.id} again to go on waiting.\n`);
    assert.ok(waitCalls(mock).length > before);
    assert.ok(waitCalls(mock).at(-1)!.params.timeout <= 1000, "no call outlasts --timeout");
  });

  it("usage errors exit 2, and a Zen that never answered fails at once", async () => {
    for (const args of [[], ["x"], ["0"], ["1", "2"], ["1", "--timeout", "0"], ["1", "--timeout"], ["1", "--timeout=soon"]]) {
      const result = await wait(args);
      assert.equal(result.code, 2, `${JSON.stringify(args)}: ${result.stderr}`);
      assert.match(result.stderr, /Usage: zenius wait <task id> \[--timeout <seconds>\]/);
    }
    const unreachable = await wait(["1"], join(mock.dir, "nobody.sock"));
    assert.equal(unreachable.code, 1);
    assert.match(unreachable.stderr, /^ZEN_BROWSER_UNAVAILABLE: zenius wait: /);
  });

  it("waits across a restart of the runtime, and goes on with the same task", async () => {
    const home = mkdtempSync(join(tmpdir(), "zenius-wait-"));
    const restarting = await new MockRuntime({ socketPath: join(home, "zen.sock") }).start();
    realWaits(restarting);
    try {
      const space = restarting.addSpace("wait restart", "agentDelegatedToUser");
      const running = wait([String(space.id)], restarting.socketPath);
      await until(() => waitCalls(restarting).length > 0);
      // Zen quits, and starts again with the task.
      await restarting.stop();
      await sleep(1500);
      await restarting.start();
      await until(() => waitCalls(restarting).length > 1);
      space.ownership = "agent";
      const result = await running;
      assert.equal(result.code, 0, result.stderr);
    } finally {
      await restarting.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
