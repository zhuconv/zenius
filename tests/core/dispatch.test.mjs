// The method registry behind dispatch (docs/SPI.md, "Dispatch"): each
// method's module, access and I5 class, and whether its module declared
// them. The input layer's registry test checks every module's declarations; this
// file checks the plumbing.
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

/** Register a probe method as a module would; return its registry entry, and remove it. */
const probe = (name, access, i5) =>
  h.chrome(
    `ctx.service.registerMethod(arg.name, async () => true, "probe", arg.access, arg.i5);
     try {
       return (await ctx.call("dev.registry", {})).find(r => r.method === arg.name);
     } finally {
       ctx.service.unregisterMethod(arg.name);
     }`,
    { name, access, i5 }
  );

test("the registry says each method's module, access and I5 class, and which were declared", async () => {
  const registry = await h.call("dev.registry", {});
  const names = registry.map(r => r.method);
  assert.deepEqual(names, [...names].sort(), "sorted by name");
  assert.ok(names.includes("page.goto") && names.includes("spaces.list") && names.includes("dev.registry"));
  for (const r of registry) {
    assert.equal(typeof r.module, "string", r.method);
    assert.ok(["mutate", "read", "task", "none"].includes(r.access), `${r.method}: ${r.access}`);
    assert.equal(typeof r.accessDeclared, "boolean");
    assert.equal(r.i5Declared, r.i5 !== null, `${r.method}: i5 is null exactly when undeclared`);
  }

  assert.deepEqual(await probe("dev.probeDeclared", "read", "outside"), {
    method: "dev.probeDeclared",
    module: "probe",
    access: "read",
    accessDeclared: true,
    i5: "outside",
    i5Declared: true,
  });
  // Nothing declared: a dev method's access defaults to none, with no I5 class.
  assert.deepEqual(await probe("dev.probeBare"), {
    method: "dev.probeBare",
    module: "probe",
    access: "none",
    accessDeclared: false,
    i5: null,
    i5Declared: false,
  });
  // An unknown class counts as undeclared.
  assert.equal((await probe("dev.probeOdd", "none", "somewhere")).i5Declared, false);
  const left = (await h.call("dev.registry", {})).map(r => r.method);
  assert.ok(!left.some(m => m.startsWith("dev.probe")), "the probes are gone");
});

// I5 by declared class, not by name (SPI.md, "Dispatch"). A probe named
// dev.* is no page method by name, so what
// gates it below is its class alone.

/**
 * Register dev.probeI5 with class `i5` for each case, call it with `arg`
 * (space and page), remove it; each case's result or error code. A case
 * with `call` makes a content call in the page first.
 */
const probeI5 = (cases, arg) =>
  h.chrome(
    `const S = ctx.service;
     const bc = ctx.resolvePage(arg).browser.browsingContext;
     const out = {};
     for (const [key, i5, call] of arg.cases) {
       S.registerMethod("dev.probeI5", async c => {
         if (call) {
           await c.content(bc, "evaluate#ping", {});
         }
         return "ran";
       }, "probe", "none", i5);
       try {
         out[key] = await ctx.call("dev.probeI5", { space: arg.space, page: arg.page }).then(r => r, e => e.code);
       } finally {
         S.unregisterMethod("dev.probeI5");
       }
     }
     return out;`,
    { ...arg, cases }
  );

test("a method whose module declares no I5 class doesn't run", async () => {
  const out = await h.chrome(
    `let ran = false;
     ctx.service.registerMethod("dev.probeBare", async () => (ran = true), "probe", "none");
     try {
       const e = await ctx.call("dev.probeBare", {}).then(() => null, e => e);
       return { code: e?.code, message: e?.message, ran };
     } finally {
       ctx.service.unregisterMethod("dev.probeBare");
     }`
  );
  assert.equal(out.code, "ZEN_INTERNAL", out.message);
  assert.match(out.message, /^dev\.probeBare doesn't run: its module declares no I5 class for it/);
  assert.equal(out.ran, false);
});

test("a content call goes through for the classes that may make one; from a none method it fails closed", async () => {
  const space = await h.space("i5 web");
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/api/text?i5` });
  const classes = ["document", "outside", "frames", "dev", "none"];
  const out = await probeI5(
    classes.map(i5 => [i5, i5, true]),
    { space, page: "p1" }
  );
  assert.deepEqual(out, { document: "ran", outside: "ran", frames: "ran", dev: "ran", none: "ZEN_INTERNAL" });
  await h.call("spaces.finish", { space, keep: [] });
});

test("on a page that isn't web content, the page gate and the content check follow the class", async () => {
  const space = await h.space("i5 file");
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/api/text?i5-file` });
  const path = await h.chrome(
    `const path = PathUtils.join(PathUtils.tempDir, "zenius-i5-class-" + Date.now() + ".html");
     await IOUtils.writeUTF8(path, "<title>a file</title>file");
     return path;`
  );
  try {
    // The user opens a file: page in the agent's tab while they hold it, as
    // from the URL bar (agents can't load one).
    await h.call("spaces.handOff", { space, reason: "manual_takeover" });
    await h.chrome(
      `const { browser } = ctx.resolvePage(arg);
       const before = browser.browsingContext.currentWindowGlobal;
       browser.fixupAndLoadURIString(PathUtils.toFileURI(arg.path), {
         triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
       });
       for (const end = Date.now() + 10000; ; ) {
         await new Promise(r => win.setTimeout(r, 50));
         const wgp = browser.browsingContext?.currentWindowGlobal;
         if (wgp && wgp !== before && !browser.webProgress?.isLoadingDocument) break;
         if (Date.now() > end) throw new Error("the file didn't load: " + browser.currentURI.spec);
       }
       return true;`,
      { space, page: "p1", path }
    );
    await h.call("spaces.takeOver", { space });
    const out = await probeI5(
      [
        ["document", "document", false],
        ["outside", "outside", false],
        ["frames", "frames", false],
        ["frames, calling", "frames", true],
        ["none", "none", false],
        ["none, calling", "none", true],
      ],
      { space, page: "p1" }
    );
    assert.deepEqual(out, {
      // The page gate refuses before the handler runs.
      document: "ZEN_PAGE_NOT_WEB_CONTENT",
      // The page gates run, and their web-content check lets it by.
      outside: "ran",
      // No page gate: the handler runs, and its content call is checked.
      frames: "ran",
      "frames, calling": "ZEN_PAGE_NOT_WEB_CONTENT",
      none: "ran",
      "none, calling": "ZEN_INTERNAL",
    });
  } finally {
    await h.chrome(`await IOUtils.remove(arg, { ignoreAbsent: true }); return true`, path);
    await h.call("spaces.finish", { space, keep: [] });
  }
});

test("a dev result with more items than a result carries fails, naming where; it never comes back cut", async () => {
  assert.equal((await h.chrome(`return Array.from({ length: 1000 }, (_, i) => i);`)).length, 1000);
  await assert.rejects(h.chrome(`return { log: Array.from({ length: 1001 }, (_, i) => i) };`), e => {
    assert.equal(e.code, "ZEN_INTERNAL");
    assert.match(e.message, /result\.log is an array of 1001 items, more than the 1000 a result carries/);
    return true;
  });
  const space = await h.space("dev items");
  try {
    const { label } = await h.call("pages.new", { space, url: `${h.base}/api/text?dev-items` });
    const inPage = code => h.call("dev.evalContent", { space, page: label, code });
    assert.equal((await inPage(`return new Set(Array.from({ length: 1000 }, (_, i) => i));`)).length, 1000);
    await assert.rejects(inPage(`return new Set(Array.from({ length: 1001 }, (_, i) => i));`), e => {
      assert.equal(e.code, "ZEN_INTERNAL");
      assert.match(e.message, /result is a Set of 1001 items/);
      return true;
    });
  } finally {
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
  }
});

test("a method declared dev exists only in dev profiles, whatever its name", async () => {
  const out = await h.chrome(
    `const S = ctx.service;
     const probes = ["probe.devClass", "dev.probeNamed", "probe.plain"];
     const settings = S.settings;
     let registered;
     S.settings = { ...settings, dev: false };
     try {
       S.registerMethod("probe.devClass", async () => true, "probe", "none", "dev");
       S.registerMethod("dev.probeNamed", async () => true, "probe", "none", "none");
       S.registerMethod("probe.plain", async () => true, "probe", "none", "none");
       registered = S.methodNames.filter(m => probes.includes(m));
     } finally {
       S.settings = settings;
       probes.forEach(m => S.unregisterMethod(m));
     }
     return { registered, devAgain: S.dev };`
  );
  assert.deepEqual(out, { registered: ["probe.plain"], devAgain: true });
});

/** A connection of the test's own: requests by the ids it picks, and every frame that comes back. */
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
  await new Promise((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  return {
    send: (id, method, params) => sock.write(`${JSON.stringify({ id, method, params })}\n`),
    answer: id => frames.find(f => f.id === id && ("result" in f || "error" in f)),
    close: () => sock.destroy(),
  };
}

const STEPS = `const S = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/steps.sys.mjs");`;
/** The task's last step of `method`, as the sidebar reads it. */
const lastStep = async (space, method) => (await h.chrome(`${STEPS} return S.stepsOf(arg);`, space)).findLast(s => s.method === method);

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

/** The step once it has ended. */
const ended = (space, method) =>
  until(async () => {
    const step = await lastStep(space, method);
    return step && step.outcome !== "running" && step;
  }, `${method}'s step ends`);

test("a request its client cancels stops at once and gets no answer: a wait, page code and a call the gate holds; their steps read stopped", async () => {
  const space = await h.space("core cancel");
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/api/text?cancel` });
  const conn = await rawConnection();
  try {
    const P = { space, page: "p1" };
    conn.send(1, "page.waitForSelector", { ...P, target: "#never", options: { timeout: 60000 } });
    conn.send(2, "page.evaluate", { ...P, isFunction: false, fn: "new Promise(resolve => setTimeout(resolve, 60000))" });
    await until(async () => (await lastStep(space, "page.evaluate"))?.outcome === "running", "the page code runs");
    const canceled = Date.now();
    conn.send(3, "calls.cancel", { id: 1 });
    conn.send(4, "calls.cancel", { id: 2 });
    await until(() => conn.answer(3) && conn.answer(4), "the cancels answer");
    assert.deepEqual([conn.answer(3).result, conn.answer(4).result], [{ canceled: true }, { canceled: true }]);
    assert.equal((await ended(space, "page.waitForSelector")).outcome, "stopped");
    assert.equal((await ended(space, "page.evaluate")).outcome, "stopped");
    assert.ok(Date.now() - canceled < 3000, `they ended ${Date.now() - canceled} ms after the cancel`);

    // While the user decides at a takeover prompt, the gate holds the
    // click; a wait for the user waits. Canceled, both end there.
    await h.pause(space, true);
    conn.send(5, "spaces.waitForControl", { space, timeout: 60000 });
    conn.send(6, "page.click", { ...P, target: "body" });
    await until(async () => (await lastStep(space, "page.click"))?.outcome === "running", "the gate holds the click");
    conn.send(7, "calls.cancel", { id: 5 });
    conn.send(8, "calls.cancel", { id: 6 });
    assert.equal((await ended(space, "spaces.waitForControl")).outcome, "stopped");
    assert.equal((await ended(space, "page.click")).outcome, "stopped");
    await h.pause(space, false);

    // One that has answered is past stopping.
    conn.send(9, "page.title", P);
    await until(() => conn.answer(9), "page.title answers");
    conn.send(10, "calls.cancel", { id: 9 });
    await until(() => conn.answer(10), "the late cancel answers");
    assert.deepEqual(conn.answer(10).result, { canceled: false });
    await sleep(300);
    assert.deepEqual(
      [1, 2, 5, 6].filter(id => conn.answer(id)),
      [],
      "the canceled requests got no answer"
    );
  } finally {
    conn.close();
    await h.pause(space, false);
    await h.call("spaces.finish", { space, keep: [] });
  }
});

test("a connection that closes stops its running requests: a wait ends, and its step reads stopped", async () => {
  const space = await h.space("core closed");
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/api/text?closed` });
  const conn = await rawConnection();
  try {
    conn.send(1, "page.waitForSelector", { space, page: "p1", target: "#never", options: { timeout: 60000 } });
    await until(async () => (await lastStep(space, "page.waitForSelector"))?.outcome === "running", "the wait runs");
    const closed = Date.now();
    conn.close();
    assert.equal((await ended(space, "page.waitForSelector")).outcome, "stopped");
    assert.ok(Date.now() - closed < 3000, `it ended ${Date.now() - closed} ms after the close`);
  } finally {
    conn.close();
    await h.call("spaces.finish", { space, keep: [] });
  }
});

// The target is there but hidden, which a click retries until it shows. The
// test shows it only once the click has stopped, so a click that went on
// looking would land then.
const HIDDEN_BUTTON = `(() => {
  const b = document.createElement("button");
  b.id = "late";
  b.textContent = "late";
  b.style.visibility = "hidden";
  b.onclick = () => (window.__clicks = (window.__clicks || 0) + 1);
  document.body.append(b);
  return true;
})()`;

for (const how of ["canceled", "closed"]) {
  const which = how === "canceled" ? "that its client cancels" : "whose connection closes";
  test(`a click still looking for its target, ${which}, lands no click, and its step reads stopped`, async () => {
    const space = await h.space(`core click ${how}`);
    const P = { space, page: "p1" };
    await h.call("page.goto", { ...P, url: `${h.base}/api/text?click-${how}` });
    await h.call("page.evaluate", { ...P, isFunction: false, fn: HIDDEN_BUTTON });
    const conn = await rawConnection();
    try {
      conn.send(1, "page.click", { ...P, target: "#late", options: { timeout: 20000 } });
      await until(async () => (await lastStep(space, "page.click"))?.outcome === "running", "the click looks for its target");
      await sleep(200);
      const stoppedAt = Date.now();
      if (how === "canceled") {
        conn.send(2, "calls.cancel", { id: 1 });
        await until(() => conn.answer(2), "the cancel answers");
        assert.deepEqual(conn.answer(2).result, { canceled: true });
      } else {
        conn.close();
      }
      await sleep(300);
      // A click still looking would take the button at its next try, 50 ms on.
      await h.call("page.evaluate", { ...P, isFunction: false, fn: `document.getElementById("late").style.visibility = "visible"` });
      await sleep(1500);
      const step = await lastStep(space, "page.click");
      const clicks = await h.call("page.evaluate", { ...P, isFunction: false, fn: "window.__clicks || 0" });
      assert.deepEqual({ outcome: step.outcome, clicks }, { outcome: "stopped", clicks: 0 });
      assert.ok(step.at + step.ms - stoppedAt < 1500, `it ended ${step.at + step.ms - stoppedAt} ms after the stop`);
      assert.equal(conn.answer(1), undefined, "the stopped click got no answer");
    } finally {
      conn.close();
      await h.call("spaces.finish", { space, keep: [] });
    }
  });
}

test("a drag still looking for its source, that its client cancels, never presses, and its step reads stopped", async () => {
  const space = await h.space("core drag canceled");
  const P = { space, page: "p1" };
  await h.call("page.goto", { ...P, url: `${h.base}/api/text?drag-canceled` });
  await h.call("page.evaluate", {
    ...P,
    isFunction: false,
    fn: `(() => {
      const from = document.createElement("div");
      from.id = "from";
      from.textContent = "from";
      from.style.cssText = "visibility: hidden; width: 80px; height: 40px";
      from.onmousedown = () => (window.__presses = (window.__presses || 0) + 1);
      const to = document.createElement("div");
      to.id = "to";
      to.textContent = "to";
      to.style.cssText = "width: 80px; height: 40px";
      document.body.append(from, to);
      return true;
    })()`,
  });
  const conn = await rawConnection();
  try {
    conn.send(1, "page.dragAndDrop", { ...P, source: "#from", target: "#to", options: { timeout: 20000 } });
    await until(async () => (await lastStep(space, "page.dragAndDrop"))?.outcome === "running", "the drag looks for its source");
    await sleep(200);
    conn.send(2, "calls.cancel", { id: 1 });
    await until(() => conn.answer(2), "the cancel answers");
    assert.deepEqual(conn.answer(2).result, { canceled: true });
    await sleep(300);
    await h.call("page.evaluate", { ...P, isFunction: false, fn: `document.getElementById("from").style.visibility = "visible"` });
    await sleep(1500);
    const step = await lastStep(space, "page.dragAndDrop");
    const presses = await h.call("page.evaluate", { ...P, isFunction: false, fn: "window.__presses || 0" });
    assert.deepEqual({ outcome: step.outcome, presses }, { outcome: "stopped", presses: 0 });
    assert.equal(conn.answer(1), undefined, "the stopped drag got no answer");
  } finally {
    conn.close();
    await h.call("spaces.finish", { space, keep: [] });
  }
});
