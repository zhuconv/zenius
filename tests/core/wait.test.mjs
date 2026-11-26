// Waits on a task the user holds (modules/spaces.sys.mjs waitForControl,
// docs/PROTOCOL.md spaces.waitForControl). While one waits, whichever client
// calls it, the task reads as waited on: agentWaiting in spaces.list and in
// spaceChanged, which the user's card reads to say the agent goes on by
// itself at Resume. keepNotes, `zenius wait`'s, leaves the hand back's notes
// for the task's next takeOver.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(() => h?.close());

/** The user's Resume agent. */
const resume = space => h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "agent", { source: "user" }); return true;`, space);
/** The user's Resume agent as the UI's panel presses it: beforeHandBack first, where a secret step's tab is blanked. */
const resumeByUser = space =>
  h.chrome(
    `const s = ctx.spaces.get(arg);
     await ctx.service.beforeHandBack(s);
     ctx.spaces.setOwnership(s, "agent", { source: "user" });
     return true;`,
    space
  );
/** The user's Stop in the panel. */
const stop = space => h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "user", { source: "user" }); return true;`, space);
const waitedOn = async space => (await h.call("spaces.list")).taskSpaces.find(t => t.id === space)?.agentWaiting ?? false;
/** The agentWaiting values a subscribed client hears for `space`, from now on. */
async function listen(space) {
  const heard = [];
  const off = h.client.onEvent((event, params) => {
    if (event === "spaceChanged" && params.space === space && "agentWaiting" in params) {
      heard.push(params.agentWaiting);
    }
  });
  await h.call("events.subscribe", { names: ["spaceChanged"], space });
  return { heard, off };
}

test("a wait with keepNotes says only that the agent has the task again, and leaves the hand back's notes for its next takeOver", async () => {
  const space = await h.space("wait keep notes");
  try {
    await h.call("page.goto", { space, page: "p1", url: `${h.base}/zoo/forms.html` });
    await h.call("spaces.handOff", { space, secret: true });
    const waiting = h.call("spaces.waitForControl", { space, timeout: 30_000, keepNotes: true });
    // A failure before it's awaited shows as that failure, not as this wait's end at the clean-up.
    waiting.catch(() => {});
    await h.until(() => waitedOn(space), 5000);
    await resumeByUser(space);
    assert.deepEqual(await waiting, { space, ownership: "agent" });
    const taken = await h.call("spaces.takeOver", { space });
    assert.deepEqual(taken.blanked, ["p1"], "the notes stayed for the task's own agent");
    await assert.rejects(h.call("spaces.waitForControl", { space, keepNotes: "yes" }), { code: "ZEN_INVALID_ARGUMENT" });
  } finally {
    await h.remove(space);
  }
});

test("while a wait waits on a task the user holds, the task reads as waited on: spaces.list and spaceChanged say so, until the hand back", async () => {
  const space = await h.space("wait waited on");
  const { heard, off } = await listen(space);
  try {
    // With the agent in control a wait returns at once, and marks nothing.
    assert.deepEqual(await h.call("spaces.waitForControl", { space, keepNotes: true }), { space, ownership: "agent" });
    await h.call("spaces.handOff", { space });
    assert.equal(await waitedOn(space), false);
    const waiting = h.call("spaces.waitForControl", { space, timeout: 30_000 });
    // A failure before it's awaited shows as that failure, not as this wait's end at the clean-up.
    waiting.catch(() => {});
    await h.until(() => waitedOn(space), 5000);
    await resume(space);
    assert.equal((await waiting).ownership, "agent");
    await h.until(() => heard.length >= 2, 5000);
    assert.deepEqual(heard, [true, false]);
    assert.equal(await waitedOn(space), false);
  } finally {
    off();
    await h.remove(space);
  }
});

test("a wait that ends without the hand back leaves the task waited on for a grace, so the client's next wait doesn't flicker it", async () => {
  const space = await h.space("wait grace");
  await h.chrome(`ctx.spaces.agentWaitingGraceMs = 800; return true;`);
  const { heard, off } = await listen(space);
  try {
    await h.call("spaces.handOff", { space });
    await assert.rejects(h.call("spaces.waitForControl", { space, timeout: 200 }), { code: "ZEN_TIMEOUT" });
    assert.equal(await waitedOn(space), true, "within the grace");
    await assert.rejects(h.call("spaces.waitForControl", { space, timeout: 200 }), { code: "ZEN_TIMEOUT" });
    await h.until(async () => !(await waitedOn(space)), 5000);
    assert.deepEqual(heard, [true, false], "no change between the two waits");
  } finally {
    off();
    await h.chrome(`ctx.spaces.agentWaitingGraceMs = null; return true;`).catch(() => {});
    await resume(space).catch(() => {});
    await h.remove(space);
  }
});

test("a task the user stops ends its waits with INACTIVE, and reads as waited on no more", async () => {
  const space = await h.space("wait stopped");
  const { heard, off } = await listen(space);
  try {
    await h.call("spaces.handOff", { space });
    const waiting = h.call("spaces.waitForControl", { space, timeout: 30_000, keepNotes: true });
    // A failure before it's awaited shows as that failure, not as this wait's end at the clean-up.
    waiting.catch(() => {});
    await h.until(() => waitedOn(space), 5000);
    await stop(space);
    await assert.rejects(waiting, { code: "ZEN_TASK_SPACE_INACTIVE" });
    await h.until(() => heard.length >= 2, 5000);
    assert.deepEqual(heard, [true, false]);
    assert.equal(await waitedOn(space), false);
  } finally {
    off();
    await h.remove(space);
  }
});
