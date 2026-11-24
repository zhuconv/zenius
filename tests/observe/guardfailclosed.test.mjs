// The constructor guards fail closed (content/refusals.sys.mjs, failClosed).
// Notification, RTCPeerConnection, SharedWorker and BroadcastChannel get their
// wrappers from a script in the page's sandbox. When that script can't run,
// the page gets a constructor that refuses, and so does the agent's world,
// and the parent is told. When even that can't go in, a frame is taken out of
// its page and a popup is closed; a tab's own document keeps the native, and
// that is logged and told. The preferences zenius.test.failPageGuard.<name>
// make guards fail on purpose; the last test makes the page's own stack do
// it, as a hostile page can.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setup } from "./lib.mjs";

let env;
let site;
before(async () => {
  env = await setup();
  site = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset=utf-8><title>guards</title><body><p>guards ${req.url}</p>`);
  });
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  await clear().catch(() => {});
  site?.close();
  await env?.close();
});

const js = v => JSON.stringify(v);
const url = path => `http://127.0.0.1:${site.address().port}${path}`;
const NAMES = ["Notification", "RTCPeerConnection", "SharedWorker", "BroadcastChannel"];

/**
 * Make guards fail, until clear(): {<constructor or "install">: how}, where
 * how is 1 (an error), 2 (Gecko stops the script) or 3 (too much recursion),
 * plus 8 when the refusing constructor can't go in either.
 */
const failing = how =>
  env.chrome(
    `for (const [name, n] of Object.entries(arg)) Services.prefs.setIntPref("zenius.test.failPageGuard." + name, n);
     return true;`,
    how
  );
const clear = () => env?.chrome(`Services.prefs.getBranch("zenius.test.failPageGuard.").deleteBranch(""); return true;`);
/** The parent's record of guards that failed, oldest first. */
const failures = () =>
  env.chrome(
    `const R = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/refusals.sys.mjs");
     return R.recentGuardFailures();`
  );

/** `code`, an expression, run as the page's own script; its value, as JSON. */
const asPage = (page, code) =>
  page.call("dev.evalContent", {
    privileged: false,
    code: `const s = document.createElement("script");
      s.textContent = "window.__zoOut = JSON.stringify(" + ${js(code)} + ");";
      document.documentElement.append(s);
      s.remove();
      return JSON.parse(window.__zoOut);`,
  });

/** What constructing each of the four gives: "made", or the error's name. */
const CONSTRUCT = `(() => {
  const make = {
    Notification: () => new Notification("zo"),
    RTCPeerConnection: () => new RTCPeerConnection(),
    SharedWorker: () => new SharedWorker("worker.js"),
    BroadcastChannel: () => new BroadcastChannel("zo"),
  };
  const out = {};
  for (const name of Object.keys(make)) {
    try {
      const made = make[name]();
      try { made.close?.(); made.port?.close(); } catch (e) {}
      out[name] = "made";
    } catch (e) {
      out[name] = e.name;
    }
  }
  return out;
})()`;

/** The same through each one's prototype.constructor, which a page can reach for the native. */
const THROUGH_PROTOTYPES = `(() => {
  const out = {};
  const args = { Notification: ["zo"], RTCPeerConnection: [], SharedWorker: ["worker.js"], BroadcastChannel: ["zo"] };
  for (const name of ${js(NAMES)}) {
    try {
      const made = new window[name].prototype.constructor(...args[name]);
      try { made.close?.(); made.port?.close(); } catch (e) {}
      out[name] = "made";
    } catch (e) {
      out[name] = e.name;
    }
  }
  return out;
})()`;

/** The four the page sees as the native one, in each window: the document's own, or each kept frame's. */
const NATIVES = `const Cu = Components.utils;
  const nativesOf = w => {
    const page = Cu.waiveXrays(w);
    return ${js(NAMES)}.filter(n => typeof w[n] === "function" && page[n] === Cu.waiveXrays(w[n]));
  };
  const frames = [...actor.document.querySelectorAll("iframe[data-zo-edge]")].filter(f => f.contentWindow);
  return {
    top: nativesOf(actor.contentWindow),
    frames: frames.length,
    native: frames.map(f => ({ depth: f.dataset.zoEdge, names: nativesOf(f.contentWindow) })).filter(f => f.names.length),
  };`;
const natives = page => page.call("dev.evalContent", { privileged: true, code: NATIVES });

const REFUSED = { Notification: "TypeError", RTCPeerConnection: "NotAllowedError", SharedWorker: "SecurityError", BroadcastChannel: "SecurityError" };

/** The Zen log's text, for the guards' own lines. */
const zenLog = () => readFileSync(join(homedir(), ".zenius-dev", "logs", `${process.env.ZENIUS_INSTANCE}.log`), "utf8");

test("a constructor guard that fails leaves one that refuses, in the page and the agent's world, and the parent hears why", async () => {
  await env.inSpace("zo failclosed", async page => {
    const before = (await failures()).length;
    await failing({ Notification: 1, RTCPeerConnection: 2, SharedWorker: 3, BroadcastChannel: 1 });
    try {
      await page.goto(url("/failed"));
    } finally {
      await clear();
    }
    assert.deepEqual(await asPage(page, CONSTRUCT), REFUSED, "the page's own script");
    assert.deepEqual(await asPage(page, THROUGH_PROTOTYPES), REFUSED, "through each prototype's constructor");
    assert.deepEqual(await page.evaluate(CONSTRUCT), REFUSED, "the agent's code");
    assert.deepEqual((await natives(page)).top, []);
    const heard = (await failures()).slice(before).filter(f => f.url.endsWith("/failed"));
    assert.deepEqual(
      heard.map(f => [f.guard, f.cause, f.outcome]),
      [
        ["Notification", "error", "refusing"],
        ["RTCPeerConnection", "stopped", "refusing"],
        ["SharedWorker", "stack", "refusing"],
        ["BroadcastChannel", "error", "refusing"],
      ]
    );
    // The log names the cause: Gecko stops a guard's script only when the
    // content process is shutting down.
    const line =
      "the WebRTC guard failed: Gecko stopped its script, as it does in a content process that is shutting down. The page's RTCPeerConnection refuses.";
    for (const end = Date.now() + 5000; !zenLog().includes(line); ) {
      assert.ok(Date.now() < end, `the log has no line: ${line}`);
      await new Promise(r => setTimeout(r, 100));
    }
    // The next document of the tab gets its guards as before.
    await page.goto(url("/after"));
    assert.deepEqual(await asPage(page, CONSTRUCT), { ...REFUSED, Notification: "made", SharedWorker: "made", BroadcastChannel: "made" });
  });
});

test("an install that stops before the constructor guards leaves all four refusing", async () => {
  await env.inSpace("zo failclosed install", async page => {
    const before = (await failures()).length;
    await failing({ install: 1 });
    try {
      await page.goto(url("/install"));
    } finally {
      await clear();
    }
    assert.deepEqual(await asPage(page, CONSTRUCT), REFUSED);
    assert.deepEqual((await natives(page)).top, []);
    const heard = (await failures()).slice(before).filter(f => f.url.endsWith("/install"));
    assert.deepEqual(
      heard.map(f => [f.guard, f.outcome]),
      NAMES.map(n => [n, "refusing"])
    );
  });
});

test("when not even the refusing constructor can go in, the frame leaves the page that made it", async () => {
  await env.inSpace("zo failclosed frame", async page => {
    await page.goto(url("/host"));
    const before = (await failures()).length;
    // Two of them: the frame is taken out once, after its whole install.
    await failing({ Notification: 1 + 8, SharedWorker: 1 + 8 });
    // What the page does with a new frame's window, as soon as it can.
    let frame;
    try {
      frame = await asPage(
        page,
        `(() => {
          const f = document.createElement("iframe");
          document.body.appendChild(f);
          const out = { connected: f.isConnected };
          const w = f.contentWindow;
          out.window = !!w;
          if (w) {
            try { new w.SharedWorker("worker.js"); out.worker = "made"; } catch (e) { out.worker = e.name; }
          }
          return out;
        })()`
      );
    } finally {
      await clear();
    }
    assert.deepEqual(frame, { connected: false, window: false });
    const heard = (await failures()).slice(before);
    assert.deepEqual(
      heard.map(f => [f.guard, f.outcome]),
      [
        ["Notification", "removed"],
        ["SharedWorker", "removed"],
      ]
    );
  });
});

test("a popup is closed when not even the refusing constructor can go in", async () => {
  await env.inSpace("zo failclosed popup", async page => {
    await page.goto(url("/opener"));
    await asPage(
      page,
      `(() => {
        const b = document.createElement("button");
        b.id = "zo-open";
        b.textContent = "open";
        b.onclick = () => { window.__pop = window.open("about:blank", "_blank"); };
        document.body.append(b);
        return true;
      })()`
    );
    const before = (await failures()).length;
    await failing({ SharedWorker: 1 + 8 });
    try {
      // The agent's click: the page's own handler opens the popup.
      await page.call("page.click", { target: "#zo-open" });
      for (const end = Date.now() + 5000; ; await new Promise(r => setTimeout(r, 100))) {
        const closed = await asPage(page, "window.__pop ? window.__pop.closed : null");
        if (closed === true) {
          break;
        }
        assert.ok(Date.now() < end, `the popup is still open (closed: ${closed})`);
      }
    } finally {
      await clear();
      await asPage(page, "(window.__pop && !window.__pop.closed && window.__pop.close(), true)").catch(() => {});
    }
    // The popup's first document, and the about:blank it then loads: each
    // fails, and each closes the popup.
    const heard = (await failures()).slice(before).map(f => [f.guard, f.outcome]);
    assert.ok(heard.length > 0 && heard.every(([guard, outcome]) => guard === "SharedWorker" && outcome === "closed"), js(heard));
  });
});

test("a tab's own document stays open when not even the refusing constructor can go in, and the parent hears so", async () => {
  await env.inSpace("zo failclosed tab", async page => {
    const before = (await failures()).length;
    await failing({ BroadcastChannel: 1 + 8 });
    try {
      await page.goto(url("/kept"));
    } finally {
      await clear();
    }
    const heard = (await failures()).slice(before).filter(f => f.url.endsWith("/kept"));
    assert.deepEqual(
      heard.map(f => [f.guard, f.outcome]),
      [["BroadcastChannel", "native"]]
    );
    assert.equal(await asPage(page, "location.pathname"), "/kept");
    assert.deepEqual((await natives(page)).top, ["BroadcastChannel"]);
  });
});

/**
 * A page spends its stack, then on the way back out appends same-origin
 * frames, keeping up to 40 that get a window: the deepest ones install their
 * guards with the least of the page's stack left. `levels` puts each frame at
 * the bottom of a subtree that deep.
 */
const EDGE = levels => `(() => {
  const kept = [];
  let depth = 0;
  let maxDepth = 0;
  const make = () => {
    const f = document.createElement("iframe");
    f.dataset.zoEdge = String(depth);
    let top = f;
    for (let i = 0; i < ${levels}; i++) {
      const d = document.createElement("div");
      d.append(top);
      top = d;
    }
    return { f, top };
  };
  function climb() {
    depth++;
    maxDepth = Math.max(maxDepth, depth);
    try {
      climb();
    } finally {
      if (kept.length < 40) {
        try {
          const { f, top } = make();
          document.body.append(top);
          if (f.contentWindow) {
            kept.push(depth);
          } else {
            top.remove();
          }
        } catch (e) {}
      }
      depth--;
    }
  }
  try {
    climb();
  } catch (e) {}
  return { maxDepth, kept: kept.length, deepest: kept[0] ?? null };
})()`;

/**
 * What the agent's code gets from `new RTCPeerConnection()` in each kept
 * frame: its world's own guard refuses while the agent drives, so "made"
 * would mean the world reached the frame's native.
 */
const WORLD_PEERS = `(() => {
  const out = [];
  for (const f of document.querySelectorAll("iframe[data-zo-edge]")) {
    const w = f.contentWindow;
    if (!w) continue;
    try {
      new w.RTCPeerConnection().close();
      out.push("made");
    } catch (e) {
      out.push(e.name);
    }
  }
  return out;
})()`;

test("frames a page makes at the edge of its stack get refusing constructors, never the native", async () => {
  await env.inSpace("zo failclosed edge", async page => {
    let ranOut = 0;
    for (const [run, levels] of [
      [0, 0],
      [1, 0],
      [2, 500],
    ]) {
      await page.goto(url(`/edge-${run}`));
      // The agent's world, there before the frames, as when its code runs.
      await page.evaluate("1");
      const before = (await failures()).length;
      const sweep = await asPage(page, EDGE(levels));
      const seen = await natives(page);
      assert.ok(seen.frames > 0, `run ${run} kept no frame: ${js(sweep)}`);
      assert.deepEqual(seen.native, [], `run ${run}: frames kept a native (${js(sweep)})`);
      const heard = (await failures()).slice(before);
      assert.ok(
        heard.every(f => f.outcome === "refusing"),
        `run ${run}: ${js(heard)}`
      );
      ranOut += heard.filter(f => f.cause === "stack").length;
      const world = await page.evaluate(WORLD_PEERS);
      assert.ok(
        world.length === seen.frames && world.every(r => r === "NotAllowedError"),
        `run ${run}: the agent's world in the frames: ${js(world)}`
      );
    }
    // Otherwise the page never reached the edge, and this test proves nothing.
    assert.ok(ranOut > 0, "no frame's guard ran out of the page's stack");
  });
});
