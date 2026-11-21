// The method registry behind dispatch (docs/SPI.md, "Dispatch"): each
// method's module, access and I5 class, and whether its module declared
// them. zen-input's registry test checks every module's declarations; this
// file checks the plumbing.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

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

// I5 by declared class, not by name (docs/research/method-boundary.md,
// "Enforcement"). A probe named dev.* is no page method by name, so what
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
