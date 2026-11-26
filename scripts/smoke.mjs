#!/usr/bin/env node
// Smoke test against a running dev instance (scripts/test-smoke.sh starts one).
// Exercises the walking skeleton end to end and checks that nothing the user
// sees changed (a first slice of invariant I1).
//
//   node scripts/smoke.mjs --instance <name>
import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { connect } from "./lib/rpc.mjs";

const argv = process.argv.slice(2);
const instance = argv[argv.indexOf("--instance") + 1] || process.env.ZENIUS_INSTANCE;
if (!instance || argv.indexOf("--instance") === -1) {
  console.error("usage: smoke.mjs --instance <name>");
  process.exit(2);
}

const PAGE = `<!doctype html><title>zenius smoke</title>
<h1 id="greeting">hello from the fixture</h1>
<script>document.getElementById("greeting").dataset.value = 6 * 7;</script>`;

const OPENER = `<!doctype html><title>opener</title>
<a id="link" href="/two?via=link" target="_blank" style="display:block;height:30px">link</a>
<button id="open" style="display:block;height:30px" onclick="window.ref1 = window.open('/two?via=open')">open</button>
<button id="features" style="display:block;height:30px" onclick="window.ref2 = window.open('/two?via=features', 'x', 'width=400,height=300')">features</button>
<button id="focus" style="display:block;height:30px" onclick="window.focus()">focus</button>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (req.url === "/opener") {
    res.end(OPENER);
  } else {
    res.end(req.url.startsWith("/two") ? PAGE.replace("zenius smoke", "zenius smoke two") : PAGE);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const timings = [];
async function step(name, fn) {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    timings.push([name, performance.now() - t0]);
  }
}

let client;
let failed = false;
try {
  // A dead actor or socket fails the step instead of hanging the run.
  client = await step("connect + hello", () => connect(instance, { callTimeout: 30000 }));
  assert.equal(client.hello.protocol, 1);
  assert.equal(client.hello.instance, instance);

  const version = await step("browser.version", () => client.call("browser.version"));
  assert.match(version.zenVersion, /^\d+\.\d+/);
  const health = await step("browser.health", () => client.call("browser.health"));
  assert.equal(health.ok, true);

  const viewBefore = await client.call("dev.viewState");

  const space = await step("spaces.create", () => client.call("spaces.create", { name: `zenius smoke ${process.pid}` }));
  assert.ok(Number.isInteger(space.id), "space id is numeric");
  assert.deepEqual(
    space.pages.map(p => [p.label, p.openedBy, /^t\d+$/.test(p.tab)]),
    [["p1", "agent", true]]
  );

  // First load in a fresh instance goes through pages.new, while p1's initial
  // about:blank load may still be reporting (a case that once timed out).
  const second = await step("pages.new + goto", () =>
    client.call("pages.new", { space: space.id, url: `${base}/two` })
  );
  assert.equal(second.label, "p2");

  const nav = await step("page.goto", () =>
    client.call("page.goto", { space: space.id, page: "p1", url: `${base}/`, options: {} })
  );
  // Ego's goto receipt has no URL; read it back.
  assert.deepEqual(nav, {});
  assert.equal(await client.call("page.url", { space: space.id, page: "p1" }), `${base}/`);

  const evaluated = await step("page.evaluate", () =>
    client.call("page.evaluate", {
      space: space.id,
      page: "p1",
      // The agent's code runs in its isolated world, which shares only the
      // page's DOM: the page's script leaves its value there (glue by the observe layer).
      fn: "() => [document.title, document.getElementById('greeting').textContent, Number(document.getElementById('greeting').dataset.value)]",
      isFunction: true,
    })
  );
  assert.deepEqual(evaluated, ["zenius smoke", "hello from the fixture", 42]);

  const title2 = await step("page.evaluate p2", () =>
    client.call("page.evaluate", { space: space.id, page: "p2", fn: "document.title", isFunction: false })
  );
  assert.equal(title2, "zenius smoke two");

  // goto straight after creating a space, on its brand-new p1.
  const other = await step("spaces.create 2", () => client.call("spaces.create", { name: `zenius smoke 2 ${process.pid}` }));
  await step("page.goto fresh p1", () =>
    client.call("page.goto", { space: other.id, page: "p1", url: `${base}/two`, options: {} })
  );

  const pages = await client.call("pages.list", { space: space.id });
  assert.deepEqual(
    pages.map(p => [p.label, p.openedBy]),
    [
      ["p1", "agent"],
      ["p2", "agent"],
    ]
  );
  // `active`: the page the user would see on opening the space (one per space).
  assert.equal(pages.filter(p => p.active).length, 1);

  const listed = await client.call("spaces.list");
  const mine = listed.taskSpaces.find(s => s.id === space.id);
  assert.equal(mine?.ownership, "agent");

  // Hidden agent tabs run like visible ones (keep-alive).
  const live = await step("keep-alive check", () =>
    client.call("dev.evalContent", {
      space: space.id,
      page: "p1",
      code: "const t = performance.now(); for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 10)); let f = 0; const t1 = performance.now(); await new Promise(r => { const tick = () => (++f, performance.now() - t1 < 200 ? requestAnimationFrame(tick) : r()); requestAnimationFrame(tick); }); return { hidden: document.hidden, timersMs: performance.now() - t, frames: f }",
    })
  );
  assert.equal(live.hidden, false, "agent tab reports itself visible");
  assert.ok(live.timersMs < 300, `five 10 ms timers took ${Math.round(live.timersMs)} ms (throttled?)`);
  assert.ok(live.frames >= 5, `only ${live.frames} animation frames in 200 ms`);

  // Popups from an agent page stay in its space, in the background, labelled;
  // focus requests from it are swallowed (I1).
  await client.call("page.goto", { space: other.id, page: "p1", url: `${base}/opener` });
  const viewBeforePopups = await client.call("dev.viewState");
  const countWindows = () => client.call("dev.evalChrome", { code: "[...Services.wm.getEnumerator(null)].length" });
  const windowsBefore = await countWindows();
  for (const id of ["link", "open", "features", "focus"]) {
    await client.call("dev.evalContent", {
      space: other.id,
      page: "p1",
      privileged: true,
      arg: id,
      code: `const r = document.getElementById(arg).getBoundingClientRect(); const w = actor.contentWindow;
        w.synthesizeMouseEvent("mousedown", r.x + 5, r.y + 5, { button: 0, buttons: 1, clickCount: 1 }, {});
        w.synthesizeMouseEvent("mouseup", r.x + 5, r.y + 5, { button: 0, buttons: 0, clickCount: 1 }, {});`,
    });
  }
  let popupPages = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    popupPages = await client.call("pages.list", { space: other.id });
    if (popupPages.length >= 4 && popupPages.every(p => p.url !== "about:blank")) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.deepEqual(
    popupPages.map(p => [p.label, p.url.replace(base, ""), p.opener]),
    [
      ["p1", "/opener", null],
      ["p2", "/two?via=link", "p1"],
      ["p3", "/two?via=open", "p1"],
      ["p4", "/two?via=features", "p1"],
    ]
  );
  const refs = await client.call("dev.evalContent", {
    space: other.id,
    page: "p1",
    code: "[window.ref1?.opener === window, window.ref2?.opener === window]",
  });
  assert.deepEqual(refs, [true, true], "window.open() returns the popup and keeps opener");
  assert.deepEqual(await client.call("dev.viewState"), viewBeforePopups, "a popup changed what the user sees (I1)");
  assert.equal(await countWindows(), windowsBefore, "a popup opened a window");

  const evalChrome = await step("dev.evalChrome", () =>
    client.call("dev.evalChrome", { code: "typeof gZenWorkspaces.createAndSaveWorkspace" })
  );
  assert.equal(evalChrome, "function");

  const viewAfter = await client.call("dev.viewState");
  assert.deepEqual(viewAfter, viewBefore, "agent work changed what the user sees (I1)");

  await assert.rejects(client.call("page.evaluate", { space: space.id, page: "p9", fn: "1" }), { code: "ZEN_PAGE_NOT_FOUND" });
  await assert.rejects(client.call("spaces.create", {}), { code: "ZEN_INVALID_ARGUMENT" });
  await assert.rejects(client.call("no.such.method"), { code: "ZEN_UNSUPPORTED" });
  // Leave a reused profile (the Mac's) as we found it.
  for (const id of [space.id, other.id]) {
    const receipt = await step(`spaces.finish ${id}`, () => client.call("spaces.finish", { space: id, keep: [] }));
    assert.equal(receipt.closedSpace, true);
  }
} catch (e) {
  failed = true;
  console.error("SMOKE FAILED:", e.message);
  if (e.data) console.error(JSON.stringify(e.data, null, 2));
} finally {
  client?.close();
  server.close();
}

for (const [name, ms] of timings) {
  console.log(`  ${name.padEnd(20)} ${ms.toFixed(1).padStart(8)} ms`);
}
console.log(failed ? "smoke: FAIL" : "smoke: ok");
process.exit(failed ? 1 : 0);
