// Every tab an agent page opens becomes one of the agent's Pages as it opens,
// whatever path opened it. zenius never adopts a tab later by its opener:
// that could claim a tab the user
// opened from an agent page, which finish() would then close. So each path
// here must register its tab by itself.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { connect } from "../../scripts/lib/rpc.mjs";
import { setup, sleep } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(() => h?.close());

const url = path => `${h.base}${path}`;
const rows = async space =>
  (await h.call("pages.list", { space })).map(p => [p.label, p.opener ?? null, p.openedBy, p.url.replace(h.base, "")]);
const setBody = (client, space, page, body) =>
  client.call("page.evaluate", {
    space,
    page,
    isFunction: false,
    fn: `(document.body.innerHTML = ${JSON.stringify(body)}, true)`,
  });
const button = (id, onclick) =>
  `<button id="${id}" style="display:block;width:200px;height:30px" onclick="${onclick}">${id}</button>`;
/**
 * The agent's click, as tests/core/lib.mjs agentClick, through any client: its
 * own page.click. A synthesized click looks like the user's, whose press on a
 * page the agent wrote (setBody) waits for a clean copy (zen-observe's glue).
 */
const click = (client, space, page, selector) => client.call("page.click", { space, page, target: selector });
async function loaded(space, page, path) {
  await h.until(async () => (await rows(space)).some(([label, , , u]) => label === page && u === path));
  await h.call("page.waitForLoadState", { space, page, state: "load", options: {} });
}

test("a popup's own popup is an agent Page too", async () => {
  const space = await h.space("popups chain");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  await setBody(h, space, "p1", button("go", "window.open('/api/text?via=first')"));
  await click(h, space, "p1", "#go");
  await loaded(space, "p2", "/api/text?via=first");
  await setBody(h, space, "p2", button("go", "window.open('/api/text?via=second')"));
  await click(h, space, "p2", "#go");
  await loaded(space, "p3", "/api/text?via=second");
  assert.deepEqual(await rows(space), [
    ["p1", null, "agent", "/api/text"],
    ["p2", "p1", "agent", "/api/text?via=first"],
    ["p3", "p2", "agent", "/api/text?via=second"],
  ]);
  await h.call("spaces.finish", { space, keep: [] });
});

test("noopener popups are agent Pages, and the page gets no opener", async () => {
  const space = await h.space("popups noopener");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  await setBody(
    h,
    space,
    "p1",
    `<a id="link" href="/api/text?via=link" target="_blank" rel="noopener" style="display:block;height:30px">link</a>` +
      button("open", "window.open('/api/text?via=open', '_blank', 'noopener')")
  );
  await click(h, space, "p1", "#link");
  await loaded(space, "p2", "/api/text?via=link");
  await click(h, space, "p1", "#open");
  await loaded(space, "p3", "/api/text?via=open");
  assert.deepEqual(await rows(space), [
    ["p1", null, "agent", "/api/text"],
    ["p2", "p1", "agent", "/api/text?via=link"],
    ["p3", "p1", "agent", "/api/text?via=open"],
  ]);
  for (const page of ["p2", "p3"]) {
    assert.equal(await h.call("page.evaluate", { space, page, isFunction: false, fn: "window.opener === null" }), true);
  }
  await h.call("spaces.finish", { space, keep: [] });
});

test("window.open from a cross-site iframe makes an agent Page", async () => {
  const space = await h.space("popups oopif");
  const crossSite = h.base.replace("127.0.0.1", "localhost");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  await setBody(
    h,
    space,
    "p1",
    `<iframe src="${crossSite}/api/text?frame=1" style="position:absolute;left:0;top:0;width:300px;height:100px;border:0"></iframe>`
  );
  const frameReady = () =>
    h.chrome(
      `const top = ctx.resolvePage(arg).browsingContext;
       const frame = top.children[0];
       return !!frame?.currentWindowGlobal?.documentURI?.spec.includes("frame=1") &&
         frame.currentWindowGlobal.osPid !== top.currentWindowGlobal.osPid`,
      { space, page: "p1" }
    );
  await h.until(frameReady);
  // The frame is out of process (a different site), as in real pages with
  // ad or login frames. Put the button in it from its own process.
  await h.chrome(
    `const frame = ctx.resolvePage(arg).browsingContext.children[0];
     return ctx.content(frame, "dev#evalContent", { code: arg.code, privileged: false });`,
    {
      space,
      page: "p1",
      // The frame's document can exist before its body does.
      code: `if (document.readyState !== "complete") {
               await new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
             }
             document.body.innerHTML = ${JSON.stringify(button("go", `window.open('${url("/api/text?via=frame")}')`))};
             document.body.style.margin = "0";
             return true;`,
    }
  );
  // A real click at the button (top-left of the frame) through the input
  // path an agent uses, so the frame gets the user activation window.open
  // needs.
  const receipt = await h.call("page.mouse", { space, page: "p1", action: "click", x: 40, y: 15, options: {} });
  await loaded(space, "p2", "/api/text?via=frame");
  assert.deepEqual(await rows(space), [
    ["p1", null, "agent", "/api/text"],
    ["p2", "p1", "agent", "/api/text?via=frame"],
  ]);
  assert.deepEqual(
    receipt.popups?.map(p => p.label),
    ["p2"],
    `the click's receipt names the popup: ${JSON.stringify(receipt)}`
  );
  await h.call("spaces.finish", { space, keep: [] });
});

test("a popup that opens after the agent's client has gone is still its Page", async () => {
  const agent = await connect(h.instance, { callTimeout: 30000 });
  let space;
  try {
    space = (await agent.call("spaces.create", { name: h.unique("popups late") })).id;
    await agent.call("page.goto", { space, page: "p1", url: url("/api/text") });
    await setBody(agent, space, "p1", button("go", "setTimeout(() => window.open('/api/text?via=late'), 1000)"));
    await click(agent, space, "p1", "#go");
  } finally {
    agent.close();
  }
  await sleep(200);
  assert.deepEqual(await rows(space), [["p1", null, "agent", "/api/text"]], "the popup hasn't opened yet");
  await loaded(space, "p2", "/api/text?via=late");
  assert.deepEqual(await rows(space), [
    ["p1", null, "agent", "/api/text"],
    ["p2", "p1", "agent", "/api/text?via=late"],
  ]);
  await h.call("spaces.finish", { space, keep: [] });
});
