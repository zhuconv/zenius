// Events from content: a content process is the untrusted side of the actor,
// so the parent takes only the names content modules send, only from an
// agent task's page (zen-snapshot's content-boundary audit, item 6).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h?.close();
});

/** What a compromised content process can do: send any event through the page's Zenius actor. */
const sendFromPage = (space, events) =>
  h.call("dev.evalContent", {
    space,
    page: "p1",
    privileged: true,
    arg: events,
    code: `for (const [name, params] of arg) actor.emit(name, params); return true;`,
  });

const NAMES = ["spaceChanged", "popup", "pageClosed", "spaceFinished", "observe.console", "observe.refused"];

test("content can send only its own event names, and the parent names the page", async () => {
  const space = await h.space("content events");
  const seen = [];
  const off = h.client.onEvent((event, params) => seen.push({ event, params }));
  try {
    await h.call("events.subscribe", { names: NAMES, space });
    await sendFromPage(space, [
      ["spaceChanged", { space, ownership: "user", source: "user" }],
      ["popup", { space, page: "p9", tab: "t999", opener: "p1" }],
      ["pageClosed", { space, page: "p1", tab: "t1" }],
      ["spaceFinished", { space, closedSpace: true }],
      ["observe.refused", { kind: "fullscreen", message: "real", url: "about:blank", space: 999, page: "p7" }],
    ]);
    await h.until(() => seen.length >= 1);
    // A later frame on the same connection: anything forged would be here by now.
    await h.call("spaces.list");
    assert.deepEqual(seen, [
      {
        event: "observe.refused",
        params: { kind: "fullscreen", message: "real", url: "about:blank", space, page: "p1" },
      },
    ]);
    assert.equal(await h.ownership(space), "agent", "the forged spaceChanged changed nothing");
  } finally {
    off();
  }
  await h.call("spaces.finish", { space, keep: [] });
});

test("a page whose task the user stopped sends nothing", async () => {
  const space = await h.space("content events stopped");
  const seen = [];
  const off = h.client.onEvent((event, params) => seen.push({ event, params }));
  try {
    await h.call("events.subscribe", { names: NAMES, space });
    await h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "user", { source: "user" }); return true`, space);
    seen.length = 0;
    await sendFromPage(space, [["observe.refused", { kind: "fullscreen", message: "after the Stop" }]]);
    await h.call("spaces.list");
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(seen, []);
  } finally {
    off();
  }
  await h.remove(space);
});
