// The socket client: request frames, held-call progress frames and the
// client-side safety limit.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";

import { SANDBOX_BLOCKED_NEXT } from "../src/error-guide.ts";
import type { ZeniusError } from "../src/errors.ts";

import { RpcClient } from "../src/rpc.ts";
import { MockRuntime } from "./mock-runtime.ts";

async function withClient(body: (mock: MockRuntime, client: RpcClient, timings: { heldMs: number }[]) => Promise<void>) {
  const mock = await new MockRuntime().start();
  const timings: { heldMs: number }[] = [];
  const client = new RpcClient({ socketPath: mock.socketPath, instance: "mock", onTiming: (_method, _ms, _ok, heldMs) => timings.push({ heldMs }) });
  try {
    await body(mock, client, timings);
  } finally {
    client.close();
    await mock.stop();
  }
}

describe("RpcClient", () => {
  it("marks requests as understanding progress frames", async () => {
    await withClient(async (mock, client) => {
      let progressFlag: unknown;
      mock.handle("test.echo", (params, { frame }) => {
        progressFlag = frame.progress;
        return params;
      });
      assert.deepEqual(await client.call("test.echo", { a: 1 }), { a: 1 });
      assert.equal(progressFlag, true);
    });
  });

  it("a held call doesn't count the hold against its safety limit", async () => {
    await withClient(async (mock, client, timings) => {
      mock.handle("test.held", async (_params, { progress }) => {
        progress({ held: true, reason: "paused" });
        await sleep(300);
        progress({ held: false });
        await sleep(20);
        return "ran";
      });
      assert.equal(await client.call("test.held", {}, { op: "page.click", safetyTimeoutMs: 150 }), "ran");
      assert.ok(timings[0]!.heldMs >= 250, `held ${timings[0]!.heldMs}ms`);
    });
  });

  it("the safety limit starts afresh when a hold ends, and still fires", async () => {
    await withClient(async (mock, client) => {
      mock.handle("test.stuck", async (_params, { progress }) => {
        progress({ held: true, reason: "paused" });
        await sleep(100);
        progress({ held: false });
        return new Promise(() => {});
      });
      const started = performance.now();
      await assert.rejects(client.call("test.stuck", {}, { op: "page.click", safetyTimeoutMs: 150 }), (error: Error & { code?: string }) => {
        assert.equal(error.code, "ZEN_TIMEOUT");
        assert.match(error.message, /^page\.click: no response from the zenius runtime after 150ms, after the runtime held the call \d+ms while the user had the Space\nZen may be busy or hung: retry once, and if it still doesn't answer, run `zenius doctor`\.$/);
        return true;
      });
      assert.ok(performance.now() - started >= 240, "the limit restarted after the hold");
    });
  });

  it("without a hold, the safety limit fires as before", async () => {
    await withClient(async (mock, client) => {
      mock.handle("test.slow", () => new Promise(() => {}));
      await assert.rejects(client.call("test.slow", {}, { op: "page.goto", safetyTimeoutMs: 100 }), /^ZeniusError: page\.goto: no response from the zenius runtime after 100ms\nZen may be busy or hung: retry once, and if it still doesn't answer, run `zenius doctor`\.$|page\.goto: no response from the zenius runtime after 100ms\nZen may be busy or hung: retry once, and if it still doesn't answer, run `zenius doctor`\.$/);
    });
  });

  it("decodes the values JSON can't carry from the frame-level unserializable field", async () => {
    await withClient(async (mock, client) => {
      const values: Record<string, string> = { nan: "NaN", inf: "Infinity", ninf: "-Infinity", nzero: "-0", big: "123456789012345678901234567890n" };
      mock.handle("test.value", (params, { socket, frame }) => {
        socket.write(`${JSON.stringify({ id: frame.id, result: null, unserializable: values[params.name] })}\n`);
        return new Promise(() => {});
      });
      assert.ok(Number.isNaN(await client.call("test.value", { name: "nan" })));
      assert.equal(await client.call("test.value", { name: "inf" }), Infinity);
      assert.equal(await client.call("test.value", { name: "ninf" }), -Infinity);
      assert.ok(Object.is(await client.call("test.value", { name: "nzero" }), -0));
      assert.equal(await client.call("test.value", { name: "big" }), 123456789012345678901234567890n);
    });
  });

  it("reads frames split across chunks, several per chunk, and multi-megabyte ones", async () => {
    await withClient(async (mock, client) => {
      mock.handle("test.pieces", async (_params, { socket, frame }) => {
        const first = JSON.stringify({ id: frame.id, result: "split in three" });
        socket.write(first.slice(0, 7));
        await sleep(5);
        socket.write(first.slice(7, 20));
        await sleep(5);
        socket.write(`${first.slice(20)}\n\n`);
        return new Promise(() => {});
      });
      mock.handle("test.big", () => "x".repeat(12 * 1024 * 1024));
      assert.equal(await client.call("test.pieces"), "split in three");
      const [big, small] = await Promise.all([client.call<string>("test.big"), client.call("test.echo2", {}).catch(() => "unknown")]);
      assert.equal(big.length, 12 * 1024 * 1024);
      assert.ok(/^x+$/.test(big));
      assert.equal(small, "unknown");
    });
  });

  it("sends EGO_BROWSER_PAGE_BUDGET as the top-level pageBudget of every request, read at each call", async () => {
    const saved = process.env.EGO_BROWSER_PAGE_BUDGET;
    try {
      await withClient(async (mock, client) => {
        const sent: unknown[] = [];
        for (const value of ["3", " 12 ", "abc", "0", "2.5", "-1", undefined]) {
          if (value === undefined) delete process.env.EGO_BROWSER_PAGE_BUDGET;
          else process.env.EGO_BROWSER_PAGE_BUDGET = value;
          await client.call("browser.version");
          sent.push(mock.requests.at(-1)!.pageBudget);
        }
        // Ego's parse: a positive integer, else the runtime's default (no field).
        assert.deepEqual(sent, [3, 12, undefined, undefined, undefined, undefined, undefined]);
      });
    } finally {
      if (saved === undefined) delete process.env.EGO_BROWSER_PAGE_BUDGET;
      else process.env.EGO_BROWSER_PAGE_BUDGET = saved;
    }
  });

  it("ignores progress frames it doesn't know, and ends a call only on result or error", async () => {
    await withClient(async (mock, client) => {
      mock.handle("test.chatty", async (_params, { progress }) => {
        progress({ stage: "warming up" });
        progress({ held: false });
        await sleep(20);
        return null;
      });
      assert.equal(await client.call("test.chatty", {}, { safetyTimeoutMs: 1000 }), null);
    });
  });
});

describe("a socket the system refuses", () => {
  // Codex's sandbox refuses every connect with EPERM while its network access
  // is off; a socket of mode 000 gets the same answer as EACCES.
  it("says Zen may be running and what to do, not that it's closed", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root connects whatever the socket's mode");
    const dir = mkdtempSync(join(tmpdir(), "zenius-rpc-"));
    const socketPath = join(dir, "blocked.sock");
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    chmodSync(socketPath, 0o000);
    const client = new RpcClient({ socketPath, instance: "blocked" });
    try {
      const error = await client.call("browser.version").then(
        () => assert.fail("connected to a socket of mode 000"),
        (failure: unknown) => failure as ZeniusError,
      );
      assert.equal(error.code, "ZEN_BROWSER_UNAVAILABLE");
      assert.equal(error.data?.errno, "EACCES");
      assert.match(error.message, /^browser\.version: zenius instance "blocked" may be running, but this process may not connect to .*blocked\.sock \(EACCES\)/);
      assert.ok(error.message.endsWith(`\n${SANDBOX_BLOCKED_NEXT}`), error.message);
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
