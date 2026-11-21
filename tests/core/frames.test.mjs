// Frame-level behavior of the dispatcher (modules/service.sys.mjs):
// unserializable results, frame order, events.subscribe.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { connect } from "../../scripts/lib/rpc.mjs";
import { setup } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(() => h?.close());

test("NaN, ±Infinity, -0 and BigInt results survive as unserializable", async () => {
  const space = await h.space("frames values");
  const evaluate = fn => h.call("page.evaluate", { space, page: "p1", fn, isFunction: false });
  assert.ok(Number.isNaN(await evaluate("NaN")));
  assert.equal(await evaluate("-Infinity"), -Infinity);
  assert.ok(Object.is(await evaluate("-0"), -0));
  assert.equal(await evaluate("12345678901234567890n"), 12345678901234567890n);
  // Inside a value they follow JSON.
  assert.deepEqual(await evaluate("({ a: NaN, b: -0, c: 2n, d: [Infinity] })"), { a: null, b: 0, c: "2n", d: [null] });
  assert.ok(Object.is(await h.chrome("-0"), -0));
  await h.call("spaces.finish", { space, keep: [] });
});

test("a handler starts before the next frame on the connection is handled", async () => {
  // Two pipelined frames: the first handler's synchronous part runs first.
  const first = h.chrome("ctx.service.__order = ['a']; await new Promise(r => setTimeout(r, 50)); return ctx.service.__order");
  const second = h.chrome("ctx.service.__order.push('b'); return true");
  assert.equal(await second, true);
  assert.deepEqual(await first, ["a", "b"]);
});

test("events.subscribe sends matching events to this connection", async () => {
  const space = await h.space("frames events");
  const events = [];
  const off = h.client.onEvent((event, params) => events.push({ event, params }));
  try {
    assert.deepEqual(await h.call("events.subscribe", { names: ["spaceChanged", "pageClosed"], space }), { ok: true });
    await h.call("spaces.handOff", { space });
    await h.call("spaces.takeOver", { space });
    const p2 = await h.call("pages.new", { space });
    await h.call("pages.close", { space, page: "p2" });
    await h.until(() => events.length >= 3);
    assert.deepEqual(events, [
      { event: "spaceChanged", params: { space, ownership: "agentDelegatedToUser", reason: "manual_takeover", source: "agent" } },
      { event: "spaceChanged", params: { space, ownership: "agent", reason: null, source: "agent" } },
      { event: "pageClosed", params: { space, page: "p2", tab: p2.tab } },
    ]);
    await assert.rejects(h.call("events.subscribe", { names: "spaceChanged" }), { code: "ZEN_INVALID_ARGUMENT" });
  } finally {
    off();
  }
  await h.call("spaces.finish", { space, keep: [] });
});

test("frames of many MiB go both ways in linear time, and small ones share chunks", async () => {
  // About 28 MiB of UTF-8 each way. Framing that rescans its buffer on every
  // chunk took about 2 s for 16 MiB on the Linux server; joining pieces takes about 0.15 s.
  const text = "é😀x".repeat(4 * 1024 * 1024);
  const t0 = performance.now();
  assert.equal(await h.chrome("return arg.length", text), text.length);
  assert.equal(await h.chrome("return 'é😀x'.repeat(4 * 1024 * 1024)"), text);
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `two 28 MiB frames took ${Math.round(ms)} ms`);
  // Pipelined calls: several frames to a chunk, both ways.
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => h.chrome("return arg", i)));
  assert.deepEqual(results, Array.from({ length: 50 }, (_, i) => i));
});

test("unknown methods and bad params", async () => {
  await assert.rejects(h.call("spaces.nope"), { code: "ZEN_UNSUPPORTED" });
  await assert.rejects(h.call("spaces.claim", { space: "x" }), { code: "ZEN_INVALID_ARGUMENT" });
  await assert.rejects(h.call("spaces.claim", { space: 999999 }), { code: "ZEN_TASK_SPACE_NOT_FOUND" });
  await assert.rejects(h.call("pages.list", {}), { code: "ZEN_TASK_SPACE_NOT_SELECTED" });
  await assert.rejects(h.call("spaces.create", { name: "x", profileId: "container-9999" }), {
    code: "ZEN_PROFILE_NOT_FOUND",
  });
});

test("a request's pageBudget sets the page budget for that request only", async () => {
  const space = await h.space("frames budget");
  const small = await connect(h.instance, { pageBudget: 2 });
  try {
    assert.equal((await small.call("pages.new", { space })).label, "p2");
    await assert.rejects(small.call("pages.new", { space }), {
      code: "ZEN_PAGE_BUDGET_REACHED",
      message: /Page budget reached \(2\/2\)/,
    });
  } finally {
    small.close();
  }
  // Without the field: pref zenius.pageBudget, else Ego's 8.
  assert.equal((await h.call("pages.new", { space })).label, "p3");
  for (const bad of [0, -1, 1.5, "3", null]) {
    const client = await connect(h.instance, { pageBudget: bad });
    try {
      await assert.rejects(client.call("pages.list", { space }), {
        code: "ZEN_INVALID_ARGUMENT",
        message: /pageBudget must be a positive integer/,
      });
    } finally {
      client.close();
    }
  }
  await h.call("spaces.finish", { space, keep: [] });
});
