// The core: a script's step (methods/script.sys.mjs, input/steps.sys.mjs).
// zenius mcp's script tool runs each script on a connection of its own,
// which begins the script's step in the task and ends it; the steps of that
// connection's calls carry `within`, the script step's id. These cases speak
// the protocol on a connection of their own, as the SDK does.
import assert from "node:assert/strict";
import net from "node:net";
import { after, before, test } from "node:test";
import { socketPath } from "../../scripts/lib/rpc.mjs";
import { setup, sleep } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(() => h?.close());

/** A connection of the test's own: requests by the ids it picks, every frame back, and its close. */
async function rawConnection() {
  const sock = net.createConnection(socketPath(h.instance));
  sock.setEncoding("utf8");
  const frames = [];
  let buffer = "";
  sock.on("data", chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) {
        frames.push(JSON.parse(line));
      }
    }
  });
  const closed = new Promise(resolve => sock.once("close", resolve));
  await new Promise((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  let nextId = 1;
  const answer = id => frames.find(f => f.id === id && ("result" in f || "error" in f));
  return {
    frames,
    closed,
    send: (method, params) => {
      const id = nextId++;
      sock.write(`${JSON.stringify({ id, method, params })}\n`);
      return id;
    },
    answer,
    /** Stop reading, so what the runtime sends waits in the socket and its own output pipe; resume() reads on. */
    pause: () => sock.pause(),
    resume: () => sock.resume(),
    /** The answer to a request, once it comes. */
    call: async (method, params) => {
      const id = nextId++;
      sock.write(`${JSON.stringify({ id, method, params })}\n`);
      const frame = await until(() => answer(id), `${method} answers`);
      return frame;
    },
    close: () => sock.destroy(),
  };
}

/** `check()`'s first truthy value, within `ms`. */
async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > end) {
      throw new Error(`${what}: not so after ${ms} ms`);
    }
    await sleep(25);
  }
}

const STEPS = `const S = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/steps.sys.mjs");`;
const stepsOf = space => h.chrome(`${STEPS} return S.stepsOf(arg);`, space);
const stepById = async (space, id) => (await stepsOf(space)).find(s => s.id === id);

/** A task with one page loaded, and the cleanup that ends it. */
async function task(name) {
  const space = await h.space(name);
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/api/text?${encodeURIComponent(name)}` });
  return { space, P: { space, page: "p1" }, done: () => h.call("spaces.finish", { space, keep: [] }) };
}

test("a script's step quotes its purpose, its connection's steps carry within, and it ends with the outcome the script sends", async () => {
  const { space, P, done } = await task("zen-core script step");
  const conn = await rawConnection();
  try {
    const begun = await conn.call("script.begin", { space, purpose: 'Compare "the"\n  three\tprices' });
    const id = begun.result?.step;
    assert.ok(Number.isSafeInteger(id), JSON.stringify(begun));
    assert.deepEqual(
      (({ method, text, outcome, page }) => ({ method, text, outcome, page }))(await stepById(space, id)),
      { method: "script", text: "Run a script: \"Compare 'the' three prices\"", outcome: "running", page: null }
    );
    const again = await conn.call("script.begin", { space, purpose: "again" });
    assert.equal(again.error?.code, "ZEN_INVALID_ARGUMENT", "one script per connection");

    // The script's own call, and the harness's on the same task.
    assert.ok((await conn.call("page.waitForSelector", { ...P, target: "body" })).result !== undefined);
    await h.call("page.waitForSelector", { ...P, target: "body" });
    const waits = (await stepsOf(space)).filter(s => s.method === "page.waitForSelector");
    assert.deepEqual(
      waits.map(s => s.within),
      [id, undefined],
      "only the script's connection's step is within it"
    );

    const ended = await conn.call("script.end", { outcome: "ZEN_TIMEOUT" });
    assert.deepEqual(ended.result, { ended: true });
    const step = await stepById(space, id);
    assert.equal(step.outcome, "ZEN_TIMEOUT");
    assert.ok(step.ms >= 0);
    assert.deepEqual((await conn.call("script.end", { outcome: "ok" })).result, { ended: false }, "it ends once");

    // After its end, the connection's steps are its own again.
    await conn.call("page.waitForSelector", { ...P, target: "body" });
    assert.equal((await stepsOf(space)).findLast(s => s.method === "page.waitForSelector").within, undefined);
  } finally {
    conn.close();
    await done();
  }
});

test("a script's outcome is ok, a zenius code, or failed: no words of the script's own", async () => {
  const { space, done } = await task("zen-core script outcome");
  try {
    const outcomes = [];
    for (const outcome of ["ok", "ZEN_SELECTOR_NOT_FOUND", "all done, nothing failed", undefined]) {
      const conn = await rawConnection();
      try {
        const { result } = await conn.call("script.begin", { space, purpose: "p" });
        await conn.call("script.end", { outcome });
        outcomes.push((await stepById(space, result.step)).outcome);
      } finally {
        conn.close();
      }
    }
    assert.deepEqual(outcomes, ["ok", "ZEN_SELECTOR_NOT_FOUND", "failed", "failed"]);
  } finally {
    await done();
  }
});

test("a script whose connection closes before its end reads stopped", async () => {
  const { space, done } = await task("zen-core script closed");
  const conn = await rawConnection();
  try {
    const { result } = await conn.call("script.begin", { space, purpose: "p" });
    conn.close();
    await until(async () => (await stepById(space, result.step))?.outcome === "stopped", "the script's step reads stopped");
  } finally {
    conn.close();
    await done();
  }
});

test("a script's own step stays among its task's steps while it runs, however many calls it makes: past 50 the oldest steps that have ended go first", async () => {
  const { space, P, done } = await task("zen-core script long");
  const conn = await rawConnection();
  try {
    const { result } = await conn.call("script.begin", { space, purpose: "p" });
    const id = result.step;
    for (let i = 0; i < 60; i++) {
      await conn.call("page.waitForSelector", { ...P, target: "body" });
    }
    let steps = await stepsOf(space);
    assert.equal(steps.length, 50, "the ring keeps 50");
    assert.deepEqual([steps[0].id, steps[0].outcome], [id, "running"], "the script's step is still there, first");
    assert.ok(
      steps.slice(1).every(s => s.within === id),
      "the newest of its calls' steps under it"
    );
    assert.deepEqual((await conn.call("script.end", { outcome: "ok" })).result, { ended: true });
    steps = await stepsOf(space);
    assert.equal(steps.find(s => s.id === id)?.outcome, "ok", "its end shows");
  } finally {
    conn.close();
    await done();
  }
});

test("the sidebar's Stop (stopScript) tells the script's client, closes its connection, and stops its wait", async () => {
  const { space, P, done } = await task("zen-core script stop");
  const conn = await rawConnection();
  try {
    const { result } = await conn.call("script.begin", { space, purpose: "p" });
    const id = result.step;
    const wait = conn.send("page.waitForSelector", { ...P, target: "#never", options: { timeout: 60000 } });
    await until(async () => (await stepsOf(space)).some(s => s.method === "page.waitForSelector" && s.outcome === "running"), "the wait runs");
    assert.equal(await h.chrome(`${STEPS} return S.stopScript(arg);`, id), true);
    // This client never closes its side, as the SDK does on the event: the
    // runtime closes the socket 5 s on (the connection's end()).
    await Promise.race([conn.closed, sleep(10000).then(() => assert.fail("the connection stayed open"))]);
    assert.deepEqual(
      conn.frames.filter(f => f.event === "scriptStopped"),
      [{ event: "scriptStopped", params: { step: id } }],
      "its client heard why before the close"
    );
    assert.equal(conn.answer(wait), undefined, "the wait got no answer");
    const steps = await stepsOf(space);
    assert.equal(steps.find(s => s.id === id).outcome, "stopped");
    await until(async () => (await stepsOf(space)).findLast(s => s.method === "page.waitForSelector")?.outcome === "stopped", "the wait's step reads stopped");
    assert.equal((await stepsOf(space)).findLast(s => s.method === "page.waitForSelector").within, id);
    assert.equal(await h.chrome(`${STEPS} return S.stopScript(arg);`, id), false, "a stopped script stops once");
  } finally {
    conn.close();
    await done();
  }
});

test("the sidebar's Stop reaches a client that reads slowly: what was sent before it, then its event, all arrive before the close", async () => {
  const { space, P, done } = await task("zen-core script stop slow");
  const conn = await rawConnection();
  try {
    const { result } = await conn.call("script.begin", { space, purpose: "p" });
    // A result far past what the socket's buffers hold, while the client
    // reads nothing: most of it waits in the runtime's output pipe, which
    // closing the socket at once would drop, the event after it too.
    conn.pause();
    const big = conn.send("page.evaluate", { ...P, fn: "() => 'x'.repeat(4000000)", isFunction: true });
    await until(async () => (await stepsOf(space)).findLast(s => s.method === "page.evaluate")?.outcome === "ok", "the result goes out");
    await sleep(500);
    assert.equal(await h.chrome(`${STEPS} return S.stopScript(arg);`, result.step), true);
    conn.resume();
    await Promise.race([conn.closed, sleep(10000).then(() => assert.fail("the connection stayed open"))]);
    assert.equal(conn.answer(big)?.result?.length, 4000000, "the result arrived in full");
    const bigAt = conn.frames.findIndex(f => f.id === big);
    const stoppedAt = conn.frames.findIndex(f => f.event === "scriptStopped");
    assert.ok(stoppedAt > bigAt, `then the event (${bigAt}, ${stoppedAt})`);
  } finally {
    conn.close();
    await done();
  }
});
