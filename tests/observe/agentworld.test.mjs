// The agent's code in an isolated world (docs/research/isolated-world.md):
// the hooks the others build on. content/agentworld.sys.mjs (discard,
// isWritten, pageFlag) and observe/agentworld.sys.mjs (isWritten, onWritten,
// discard, noteWritten, noteMade).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup, timed } from "./lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(async () => {
  await env?.close();
});

const PARENT = `const AW = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentworld.sys.mjs");
  const p = ctx.resolvePage(arg.P);`;
/** content/agentworld.sys.mjs's answer for the page's top document. */
const inContent = (P, call) =>
  env.chrome(
    `const p = ctx.resolvePage(arg.P);
     return await ctx.content(p.browser.browsingContext, "dev#evalContent", { privileged: true, code: arg.code });`,
    { P, code: `const AW = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/agentworld.sys.mjs"); return ${call};` }
  );

test("the page flags: none on a page the agent only loaded; written through noteWritten, in the parent and in content, and an event once; a new load starts clean", () =>
  env.inSpace("world flags", async page => {
    await page.goto(`${env.base}/nav-target?flags`);
    assert.equal(await env.chrome(`${PARENT} return AW.isWritten(p.browser);`, { P: page.P }), false);
    assert.equal(await inContent(page.P, "AW.pageFlag(window)"), null);
    const seen = await env.chrome(
      `${PARENT}
       const got = [];
       const off = AW.onWritten(e => got.push(e.browser === p.browser));
       const id = p.browser.browsingContext.currentWindowGlobal.innerWindowId;
       AW.noteWritten(p.browser.browsingContext, [id]);
       AW.noteWritten(p.browser.browsingContext, [id]);
       off();
       return { got, written: AW.isWritten(p.browser), viaFrame: AW.isWritten(p.browser.browsingContext.currentWindowGlobal) };`,
      { P: page.P }
    );
    assert.deepEqual(seen, { got: [true], written: true, viaFrame: true });
    assert.equal(await inContent(page.P, "AW.isWritten(window)"), true);
    assert.equal(await inContent(page.P, "AW.pageFlag(window.browsingContext)"), "clean");
    await page.goto(`${env.base}/nav-target?flags-2`);
    assert.equal(await env.chrome(`${PARENT} return AW.isWritten(p.browser);`, { P: page.P }), false);
    assert.equal(await inContent(page.P, "AW.pageFlag(window)"), null);
  }));

test("a page the agent made from data: is flagged 'drop' for zen-input's guard; discard with nothing to discard is a no-op, in content and from the parent", () =>
  env.inSpace("world made", async page => {
    await page.goto("data:text/html,<title>made</title><input>");
    assert.equal(await env.chrome(`${PARENT} return AW.isMade(p.browser);`, { P: page.P }), true);
    assert.equal(await inContent(page.P, "AW.pageFlag(window)"), "drop");
    assert.equal(await inContent(page.P, "AW.discard(window)"), 0);
    assert.equal(await env.chrome(`${PARENT} await AW.discard(p.browser); await AW.discard({ task: p.space.id }); return true;`, { P: page.P }), true);
  }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Wait until `fn()` holds, for at most `ms`. */
async function until(what, fn, ms = 5000) {
  for (const end = Date.now() + ms; ; await sleep(50)) {
    if (await fn()) {
      return true;
    }
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
  }
}
/** The page's hooked evidence, as the parent has it (observe/evidence.sys.mjs), or null. */
const hookedOf = P =>
  env.chrome(
    `const EV = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");
     return EV.evidenceOf(ctx.resolvePage(arg.P).browser).hooked ?? null;`,
    { P }
  );
/** Run `code` (a function body) in the page's own JavaScript, as the page's scripts would. */
const pageWorld = (P, code) =>
  env.chrome(
    `const p = ctx.resolvePage(arg.P);
     return await ctx.content(p.browser.browsingContext, "dev#evalContent", { privileged: false, code: arg.code });`,
    { P, code }
  );
/** The call's error, which must carry `code` and `data` (a subset). */
async function failsWith(call, code, data) {
  let error = null;
  try {
    await call;
  } catch (e) {
    error = e;
  }
  assert.ok(error, `no ${code}`);
  assert.equal(error.code, code, error.message);
  for (const [key, value] of Object.entries(data)) {
    assert.equal(error.data?.[key], value, `${key} in ${JSON.stringify(error.data)}`);
  }
  return error;
}

test("the agent's code runs in its world: window.__x kept across calls, unseen by the page, gone after a navigation", () =>
  env.inSpace("world state", async page => {
    await page.goto(`${env.base}/nav-target?world`);
    assert.equal(await page.evaluate("window.__x = 41; 1"), 1);
    assert.equal(await page.evaluate("window.__x + 1"), 42);
    assert.equal(await page.evaluate("globalThis.__x === window.__x && self === window"), true);
    assert.equal(await pageWorld(page.P, "return typeof window.__x;"), "undefined", "the page saw the agent's state");
    await page.goto(`${env.base}/nav-target?world-2`);
    assert.equal(await page.evaluate("typeof window.__x"), "undefined", "a new document's world is new");
  }));

test("a page global the world can't see fails the call loudly: bare, typeof, window., self., document.defaultView., and when caught", () =>
  env.inSpace("world globals", async page => {
    await page.goto(`${env.base}/nav-target?globals`);
    await pageWorld(page.P, "window.ready = true; return 1;");
    for (const code of ["ready", "typeof ready", "window.ready", "self.ready", "document.defaultView.ready", "try { ready; } catch (e) {} 1"]) {
      const e = await failsWith(page.evaluate(code), "ZEN_PAGE_GLOBAL_HIDDEN", { method: "page.evaluate", name: "ready" });
      assert.match(e.message, /page\.evaluate: the agent's code read ready, which is the page's own JavaScript\./, code);
    }
    await failsWith(page.call("page.waitForFunction", { fn: "() => window.ready", isFunction: true, options: { timeout: 2000 } }), "ZEN_PAGE_GLOBAL_HIDDEN", {
      method: "page.waitForFunction",
      name: "ready",
    });
    // The DOM's names are the world's own.
    assert.equal(await page.evaluate("typeof document.title + typeof getComputedStyle + typeof location.href + typeof addEventListener"), "stringfunctionstringfunction");
  }));

test("through the Xray, the agent's code reads an open shadow root, live form values, form.<name> and innerText, and scrollIntoView scrolls (zen-eval's pilot bodies)", () =>
  env.inSpace("world reads", async page => {
    await page.goto(`${env.base}/nav-target?reads`);
    await pageWorld(
      page.P,
      `document.body.insertAdjacentHTML("beforeend", '<div id="host"></div><form id="f"><input name="q"></form><div style="height:5000px"></div><p id="bottom">bottom</p>');
       document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<b>in shadow</b>";
       document.forms.f.q.value = "typed";
       return 1;`
    );
    assert.deepEqual(
      await page.evaluate(`({ shadow: document.getElementById("host").shadowRoot.querySelector("b").textContent, named: document.forms.f.q.value, text: document.body.innerText.includes("bottom") })`),
      { shadow: "in shadow", named: "typed", text: true }
    );
    assert.ok((await page.evaluate(`document.getElementById("bottom").scrollIntoView(); window.scrollY`)) > 0);
  }));

test("a string timer runs in the page itself and marks it hooked (the user's pass on the defenses brief, A9); function timers run in the world", () =>
  env.inSpace("world timers", async page => {
    await page.goto(`${env.base}/nav-target?timers`);
    assert.equal(await page.evaluate(`setTimeout("document.title = 'string'", 0); 1`), 1);
    await until("the page's own title", async () => (await pageWorld(page.P, "return document.title;")) === "string");
    await until("the mark", async () => (await hookedOf(page.P)) === "a string timer");
    assert.equal(await page.evaluate("new Promise(r => setTimeout(() => r(7), 10))"), 7);
  }));

test("discard ends the world, its timers and its state: in content, and from the parent", () =>
  env.inSpace("world discard", async page => {
    await page.goto(`${env.base}/nav-target?discard`);
    const ticks = async () => Number(await pageWorld(page.P, "return document.documentElement.dataset.ticks || 0;"));
    await page.evaluate("window.__ticks = 0; setInterval(() => { document.documentElement.dataset.ticks = ++window.__ticks; }, 20); 1");
    await sleep(150);
    assert.ok((await ticks()) > 0);
    assert.equal(await inContent(page.P, "AW.discard(window)"), 1);
    const a = await ticks();
    await sleep(150);
    assert.equal(await ticks(), a, "the world's interval stopped");
    assert.equal(await page.evaluate("typeof window.__ticks"), "undefined", "a fresh world");
    await page.evaluate("window.__y = 1; 1");
    await env.chrome(`${PARENT} await AW.discard(p.browser); return true;`, { P: page.P });
    assert.equal(await page.evaluate("typeof window.__y"), "undefined", "the parent's discard");
  }));

const ALL_TABS = `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const tabOf = mark => [...W.allTabs()].find(t => t.hasAttribute(mark));`;
/** A tab of the user's, in a Space of theirs, at `url`; `run` runs a page script there and returns window.__out. */
const userTab = {
  open: (url, mark) =>
    env.chrome(
      `${ALL_TABS}
       const ws = win.gZenWorkspaces.getWorkspaces().find(w => !ctx.spaces.isAgentsSpace(w.uuid))?.uuid;
       const t = W.addBackgroundTab(win, ws);
       t.setAttribute(arg.mark, "1");
       const uri = Services.io.newURI(arg.url);
       t.linkedBrowser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, {}) });
       for (const end = Date.now() + 10000; ; await new Promise(r => win.setTimeout(r, 50))) {
         const b = t.linkedBrowser;
         if (b.currentURI?.spec === arg.url && !b.webProgress?.isLoadingDocument) return true;
         if (Date.now() > end) throw new Error("the user's tab didn't load");
       }`,
      { url, mark }
    ),
  run: (mark, code) =>
    env.chrome(
      `${ALL_TABS}
       const s = "const s = document.createElement('script'); s.textContent = " + JSON.stringify(arg.code) + "; document.documentElement.append(s); s.remove(); return JSON.stringify(window.__out ?? null);";
       return JSON.parse(await ctx.content(tabOf(arg.mark).linkedBrowser.browsingContext, "dev#evalContent", { privileged: false, code: s }));`,
      { mark, code }
    ),
  close: mark =>
    env.chrome(`${ALL_TABS} for (const t of [...W.allTabs()].filter(t => t.hasAttribute(arg))) t.ownerDocument.defaultView.gBrowser.removeTab(t); return true;`, mark),
};

test("the world has our guards, against its own tampering too: deleted or redefined, through a fresh frame's window made by the world, by call on a native fetched another way", async () => {
  const mark = `zo-world-user-${Date.now()}`;
  const url = `${env.base}/nav-target`;
  try {
    await userTab.open(url, mark);
    await userTab.run(mark, `window.__got = []; window.__ch = new BroadcastChannel("zo-world"); window.__ch.onmessage = e => window.__got.push(e.data); window.__out = 1;`);
    await env.inSpace("world guards", async page => {
      await page.goto(url);
      await page.call("page.events");
      const out = await page.evaluate(`(async () => {
        const out = {};
        const attempt = async (label, fn) => { try { await fn(); out[label] = "ran"; } catch (e) { out[label] = String(e && e.name); } };
        await attempt("plain", () => document.body.requestFullscreen());
        out.deleted = String(delete Element.prototype.requestFullscreen);
        try { Object.defineProperty(Element.prototype, "requestFullscreen", { value: () => "mine" }); out.redefined = "yes"; } catch (e) { out.redefined = e.name; }
        try { Element.prototype.requestFullscreen = () => "mine"; } catch (e) {}
        await attempt("afterTamper", () => document.body.requestFullscreen());
        const f = document.createElement("iframe");
        document.body.append(f);
        const fw = f.contentWindow;
        await attempt("freshFrame", () => fw.Element.prototype.requestFullscreen.call(document.body));
        await attempt("callOnProto", () => Function.prototype.call.call(HTMLElement.prototype.requestFullscreen, document.body));
        out.deletedChannel = String(delete window.BroadcastChannel);
        for (const [label, make] of [["own", () => new BroadcastChannel("zo-world")], ["frame", () => new fw.BroadcastChannel("zo-world")], ["construct", () => Reflect.construct(fw.BroadcastChannel, ["zo-world"])], ["top", () => new top.BroadcastChannel("zo-world")]]) {
          const ch = make();
          out[label + "Name"] = ch.name;
          ch.postMessage("from-world-" + label);
        }
        return out;
      })()`);
      // Neither takes: the guard's property can't be deleted, and a redefinition doesn't replace it.
      assert.equal(out.deleted, "false", JSON.stringify(out));
      assert.notEqual(out.afterTamper, "ran", JSON.stringify(out));
      for (const label of ["own", "frame", "construct", "top"]) {
        assert.equal(out[label + "Name"], "zo-world", `${label}: the channel's name as given`);
      }
      const fullscreen = (await page.call("page.events")).filter(e => e.method === "Zenius.refused" && e.params.kind === "fullscreen");
      assert.equal(fullscreen.length, 4, `every route was refused by the guard: ${JSON.stringify(out)}`);
      await sleep(500);
      assert.deepEqual(await userTab.run(mark, "window.__out = window.__got;"), [], "the user's tab heard the world");
    });
  } finally {
    await userTab.close(mark).catch(() => {});
  }
});

/** Headless Zen's own clipboard (in memory): set or read its text. */
const SYSTEM_CLIPBOARD = `const flavor = "text/plain";
  const transferable = () => { const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable); t.init(null); t.addDataFlavor(flavor); return t; };
  const setSystem = text => { const t = transferable(); const s = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString); s.data = text; t.setTransferData(flavor, s); Services.clipboard.setData(t, null, Ci.nsIClipboard.kGlobalClipboard); };
  const getSystem = () => { const t = transferable(); try { Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard, null); const out = {}; t.getTransferData(flavor, out); return out.value.QueryInterface(Ci.nsISupportsString).data; } catch { return null; } };`;

test("the world gets the guards other modules put on the page's prototypes: zen-ux's clipboard wrappers, a no to passkeys, and, on evidence, a geolocation refusal it can read", { skip: process.platform !== "linux" && "the system clipboard is the user's here" }, () =>
  env.inSpace("world prototype guards", async page => {
    await page.goto(`${env.base}/nav-target?prototype-guards`);
    const sentinel = `zo-user-clipboard-${Date.now()}`;
    await env.chrome(`${SYSTEM_CLIPBOARD} setSystem(arg.sentinel); return true;`, { sentinel });
    await page.call("page.events");
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.id = "zo-copy";
      b.textContent = "copy";
      b.onclick = () => {
        window.__copied = navigator.clipboard
          .writeText("WORLD-WRITE")
          .then(() => navigator.clipboard.readText())
          .then(t => "read " + t, e => "ERR " + e.name);
      };
      document.body.append(b);
      return true;
    });
    await page.call("page.click", { target: "#zo-copy" });
    assert.equal(await page.evaluate(() => window.__copied), "read WORLD-WRITE", "the world's writeText and readText use the Space's clipboard");
    const clip = await env.chrome(
      `${SYSTEM_CLIPBOARD}
       const p = ctx.resolvePage(arg.P);
       const { SpaceClipboard } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/clipboard/store.sys.mjs");
       return { system: getSystem() === arg.sentinel, space: SpaceClipboard.read(p.space.id) };`,
      { P: page.P, sentinel }
    );
    assert.deepEqual(clip, { system: true, space: { "text/plain": "WORLD-WRITE" } });

    const passkeys = await page.evaluate(async () => {
      const out = [];
      for (const op of ["get", "create"]) {
        try {
          await navigator.credentials[op]({ publicKey: {} });
          out.push(`${op} ran`);
        } catch (e) {
          out.push(`${op} ${e.name}`);
        }
      }
      return out;
    });
    assert.deepEqual(passkeys, ["get NotAllowedError", "create NotAllowedError"]);

    // Location is refused only on evidence (A8): the code leaves a style sheet first.
    await page.evaluate(() => {
      document.head.append(Object.assign(document.createElement("style"), { textContent: "#zo-hooked {}" }));
      return true;
    });
    const geo = await page.evaluate(
      () =>
        new Promise(resolve =>
          navigator.geolocation.getCurrentPosition(
            () => resolve("a position"),
            e => resolve({ denied: e.code === e.PERMISSION_DENIED, code: e.code, message: e.message })
          )
        )
    );
    assert.deepEqual(geo, { denied: true, code: 1, message: "User denied geolocation prompt" });

    const refused = (await page.call("page.events"))
      .filter(e => e.method === "Zenius.refused" && e.params.kind === "deviceAccess")
      .map(e => e.params.api);
    assert.deepEqual(refused.sort(), ["credentials.create", "credentials.get", "geolocation.getCurrentPosition"]);
    const owner = await env.chrome(`const p = ctx.resolvePage(arg.P); return p.space.ownership;`, { P: page.P });
    assert.equal(owner, "agent", "no passkey hold: the Space stays the agent's");
  }));

// ---------------------------------------------------------------------------
// The native hook (zen-snapshot's red team; the manager's design, 2026-11-20)

/** Ran the page's own JavaScript? The marker the routes below try to set. */
const ranInPage = P => pageWorld(P, "return document.documentElement.dataset.ran ?? null;");
const isWrittenNow = P => env.chrome(`${PARENT} return AW.isWritten(p.browser);`, { P });
const evaluateFn = (P, fn, extra = {}) => env.call("page.evaluate", { ...P, fn, isFunction: true, ...extra });

test("the hook: reads, JavaScript's own built-ins and the agent's actions don't write; a DOM write flags the page, in content and the parent", () =>
  env.inSpace("world writes", async page => {
    await page.goto(`${env.base}/nav-target?writes`);
    const n = await evaluateFn(
      page.P,
      `async () => {
        const out = [];
        out.push([...document.querySelectorAll("*")].map(e => e.tagName).join(","), document.body.innerText, getComputedStyle(document.body).display);
        out.push(JSON.stringify({ a: [1, { ...{ b: 2 } }] }), [3, 1, 2].sort().concat([4]).map(x => x * 2), "a b".replace(/a/g, "c").split(" "));
        out.push(new Intl.Segmenter("en", { granularity: "word" }).segment("a b").containing(0)?.segment, new Intl.NumberFormat("en").format(1e3));
        const x = document.evaluate("//body", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        out.push(x.snapshotLength, x.snapshotItem(0)?.tagName, document.body.getBoundingClientRect().width);
        out.push(await new Promise(r => setTimeout(() => r(1), 5)), await (await fetch(location.href)).text().then(t => t.length > 0));
        const mo = new MutationObserver(() => {}); mo.observe(document.body, { childList: true }); mo.disconnect();
        document.body.scrollIntoView(); document.body.click(); document.body.focus();
        return out.length;
      }`
    );
    assert.ok(n > 5);
    assert.deepEqual(await inContent(page.P, "AW.writesOf(window)"), [], "built-ins counted as writes");
    assert.equal(await isWrittenNow(page.P), false);
    await page.evaluate("document.body.append(document.createElement('p')); 1");
    assert.equal(await isWrittenNow(page.P), true, "the parent heard of the write");
    assert.equal(await inContent(page.P, "AW.pageFlag(window)"), "clean");
    assert.deepEqual(await inContent(page.P, "AW.writesOf(window)"), ["append"]);
    // A new document starts clean; a setter writes too.
    await page.goto(`${env.base}/nav-target?writes-2`);
    assert.equal(await isWrittenNow(page.P), false);
    await page.evaluate("document.title = 'mine'; 1");
    assert.equal(await isWrittenNow(page.P), true);
    // A data attribute set through the map, which calls no built-in.
    await page.goto(`${env.base}/nav-target?writes-3`);
    assert.equal(await page.evaluate("JSON.stringify({ ...document.body.dataset }) + (document.body.dataset instanceof DOMStringMap)"), "{}true");
    assert.equal(await isWrittenNow(page.P), false, "reading the dataset wrote");
    await page.evaluate("document.body.dataset.hxOn = 'x'; 1");
    assert.equal(await isWrittenNow(page.P), true, "the dataset write wasn't seen");
    assert.equal(await pageWorld(page.P, "return document.body.getAttribute('data-hx-on');"), "x");
  }));

test("the routes into the page's own JavaScript run there and mark the page hooked (A9): another window's timer, a location set past window.location, javascript: URLs, the page's eval and Function, script elements", () =>
  env.inSpace("world routes", async page => {
    await page.goto(`${env.base}/nav-target?routes`);
    await page.evaluate(`(() => { const f = document.createElement("iframe"); f.id = "zo-frame"; document.body.append(f); return 1; })()`);
    // Each one runs the page's own JavaScript, which leaves its name in data-ran.
    const routes = [
      ["location", "() => { document.location = 'javascript:void(document.documentElement.dataset.ran = \"location\")'; }"],
      ["href", "() => { location.href = 'javascript:void(document.documentElement.dataset.ran = \"href\")'; }"],
      ["assign", "() => { location.assign('javascript:void(document.documentElement.dataset.ran = \"assign\")'); }"],
      ["set", "() => { window.location = 'javascript:void(document.documentElement.dataset.ran = \"set\")'; }"],
      ["open", "() => { window.open('javascript:void(opener.document.documentElement.dataset.ran = \"open\")'); }"],
      ["eval", "() => { top.eval('document.documentElement.dataset.ran = \"eval\"'); }"],
      ["Function", "() => { new top.Function('document.documentElement.dataset.ran = \"Function\"')(); }"],
      ["script", "() => { const s = document.createElement('script'); s.textContent = 'document.documentElement.dataset.ran = \"script\"'; document.head.append(s); }"],
      ["write", "() => { document.getElementById('zo-frame').contentDocument.write('<script>parent.document.documentElement.dataset.ran = \"write\"<\\/script>'); }"],
      ["string", "() => { setTimeout('document.documentElement.dataset.ran = \"string\"', 0); }"],
      ["timer", "() => { document.getElementById('zo-frame').contentWindow.setTimeout(() => { document.documentElement.dataset.ran = 'timer'; }, 0); }"],
    ];
    for (const [ran, fn] of routes) {
      await evaluateFn(page.P, fn);
      // window.open's javascript: page runs in the popup, which zenius may
      // leave without an opener: the call only has to go through.
      if (ran !== "open") {
        await until(`the page's ${ran}`, async () => (await ranInPage(page.P)) === ran);
      }
    }
    assert.notEqual(await hookedOf(page.P), null, "the page is hooked");
    // What the world may do: its own timers, window.location to an address, the hash.
    assert.equal(await evaluateFn(page.P, "() => new Promise(r => setTimeout(() => r('timer'), 5))"), "timer");
    await evaluateFn(page.P, "() => { location.hash = 'here'; return 1; }");
    assert.equal(await page.evaluate("location.hash"), "#here");
  }));

/** Run `code` as a script of the page's own, and return what it left in data-site. */
const siteScript = (P, code) =>
  pageWorld(
    P,
    `const s = document.createElement("script"); s.textContent = ${JSON.stringify(code)}; document.documentElement.append(s); s.remove(); return document.documentElement.dataset.site ?? null;`
  );

test("the page's eval kinds: the world's call through a built-in runs and marks the page too (self-hosted, native, a promise job); the site's own eval and Function mark nothing, also in a listener the agent's click fires", () =>
  env.inSpace("world eval kinds", async page => {
    await page.goto(`${env.base}/nav-target?eval-kinds`);
    assert.equal(await evaluateFn(page.P, "() => 1"), 1, "the world is made");
    // The site's own eval and Function, beside the world, mark nothing.
    assert.equal(await siteScript(page.P, "document.documentElement.dataset.site = String(eval('6 * 7') + new Function('return 1')());"), "43");
    await siteScript(
      page.P,
      "const b = document.createElement('button'); b.id = 'zo-ev'; b.textContent = 'ev'; b.onclick = () => { document.documentElement.dataset.site = String(eval('2 + 2')); }; document.body.append(b);"
    );
    await page.call("page.click", { target: "#zo-ev" });
    assert.equal(await pageWorld(page.P, "return document.documentElement.dataset.site ?? null;"), "4", "the site's listener ran its eval");
    assert.equal(await hookedOf(page.P), null, "the site's own eval marked the page");
    const routes = [
      ["map", "eval in the page", "() => { ['document.documentElement.dataset.ran = \"map\"'].map(top.eval); }"],
      ["apply", "eval in the page", "() => { Reflect.apply(top.eval, null, ['document.documentElement.dataset.ran = \"apply\"']); }"],
      ["construct", "Function in the page", "() => { Reflect.construct(top.Function, ['document.documentElement.dataset.ran = \"construct\"'])(); }"],
      // A job the world queues runs the page's eval with no frame of the world's on the stack.
      ["job", "eval in the page", "() => { Promise.resolve('document.documentElement.dataset.ran = \"job\"').then(top.eval); return 1; }"],
    ];
    for (const [ran, detail, fn] of routes) {
      await page.goto(`${env.base}/nav-target?eval-kinds-${ran}`);
      await evaluateFn(page.P, fn);
      await until(`the page's ${ran}`, async () => (await ranInPage(page.P)) === ran);
      await until(`${ran}'s mark`, async () => (await hookedOf(page.P)) === detail);
    }
  }));

test("the deadline stops the agent's code that runs past it: a loop that calls no built-in, a callback the call left, and one left after the call; later callbacks still run", () =>
  env.inSpace("world deadline", async page => {
    await page.goto(`${env.base}/nav-target?deadline`);
    for (const fn of ["() => { let i = 0; for (;;) { i++; } }", "() => { let i = 0; while (true) i++; }", "() => { let i = 0; do i++; while (i > 0 || true); }"]) {
      const { value: e, ms } = await timed(() => page.fail("page.evaluate", { fn, isFunction: true, responseTimeout: 1800 }));
      assert.equal(e.code, "ZEN_PAGE_EVALUATION_TIMED_OUT", fn);
      assert.match(e.message, /^page\.evaluate exceeded its 1000ms page-execution safety limit\./, fn);
      assert.equal(e.data.pageResponsive, true);
      assert.ok(ms < 1800 + 1000, `${fn} took ${ms} ms`);
      assert.equal(await page.evaluate("1 + 1"), 2);
    }
    // zen-eval's e2e case: a callback the call left blocks past the call's deadline.
    const { value: e, ms } = await timed(() =>
      page.fail("page.evaluate", {
        fn: `async () => {
          setTimeout(() => { window.__started = true; const end = Date.now() + 6000; while (Date.now() < end) {} window.__completed = true; }, 500);
          setTimeout(() => { window.__late = "finished"; }, 2500);
          await new Promise(r => setTimeout(r, 8000));
        }`,
        isFunction: true,
        responseTimeout: 2000,
      })
    );
    assert.equal(e.code, "ZEN_PAGE_EVALUATION_TIMED_OUT");
    assert.match(e.message, /^page\.evaluate exceeded its 1000ms page-execution safety limit\./);
    assert.equal(e.data.executionStopped, true);
    assert.ok(ms < 2000 + 1000, `took ${ms} ms`);
    assert.equal(await page.evaluate("window.__started ?? null"), true);
    assert.equal(await page.evaluate("window.__completed ?? null"), null);
    // A callback that starts after the deadline runs: Ego's late effects.
    await sleep(1800);
    assert.equal(await page.evaluate("window.__late ?? null"), "finished");
    // A continuation after an await may take the call's own time.
    assert.equal(
      await evaluateFn(page.P, "async () => { await new Promise(r => setTimeout(r, 20)); const end = Date.now() + 1300; let n = 0; while (Date.now() < end) n++; return n > 0; }", { responseTimeout: 4000 }),
      true
    );
    // Outside any call, a callback may run a second at once.
    await page.evaluate("setTimeout(() => { let i = 0; for (;;) i++; }, 50); 1");
    const { ms: quick } = await timed(async () => {
      await sleep(100);
      assert.equal(await page.evaluate("3 + 3"), 6);
    });
    assert.ok(quick < 2500, `the page waited ${quick} ms on the left-over loop`);
  }));

test("the loop counter changes nothing the agent's code sees: a function's text, its results, and where an error is", () =>
  env.inSpace("world counter", async page => {
    await page.goto(`${env.base}/nav-target?counter`);
    const source = "function f(n) { let s = 0; for (let i = 0; i < n; i++) s += i; while (n-- > 0) { s++; } return s; }";
    const fn = `() => { ${source} return [f(10), f.toString(), String(f), \`\${f}\`, Function.prototype.toString.toString()]; }`;
    const counted = await evaluateFn(page.P, fn);
    assert.deepEqual(counted.slice(0, 4), [55, source, source, source]);
    assert.equal(counted[4], "function toString() {\n    [native code]\n}");
    const failing = "() => { for (const x of [1]) { null.y; } }";
    const withCounter = await page.fail("page.evaluate", { fn: failing, isFunction: true });
    await env.chrome(`Services.prefs.setBoolPref("zenius.test.loopCounterOff", true); return true;`);
    try {
      assert.deepEqual(await evaluateFn(page.P, fn), counted, "the same with and without the counter");
      const without = await page.fail("page.evaluate", { fn: failing, isFunction: true });
      assert.equal(withCounter.message, without.message, "the error's position moved");
    } finally {
      await env.chrome(`Services.prefs.clearUserPref("zenius.test.loopCounterOff"); return true;`);
    }
  }));

test("the URL before the agent's code changed it in place: pushState, replaceState and the hash give urlBefore; the site's own routing since clears it", () =>
  env.inSpace("world url", async page => {
    const start = `${env.base}/nav-target?url`;
    await page.goto(start);
    const before = () => env.chrome(`${PARENT} return AW.urlBefore(p.browser);`, { P: page.P });
    assert.equal(await before(), null);
    // zen-snapshot's cases: an open redirect, and a consent page.
    await page.evaluate(`history.replaceState(null, "", "/redirect?to=https://example.invalid/"); 1`);
    await until("urlBefore", async () => (await before()) === start);
    assert.equal(await isWrittenNow(page.P), true);
    await page.evaluate(`history.pushState({}, "", "/consent?next=/grant"); 1`);
    await sleep(100);
    assert.equal(await before(), start, "the first URL stays the one before the agent's changes");
    // The site's own routing moves on: its URL is the one to load.
    await pageWorld(page.P, `history.pushState({}, "", "/site-route"); return 1;`);
    assert.equal(await before(), null);
    await page.evaluate(`location.hash = "agent"; 1`);
    await until("urlBefore after the hash", async () => (await before()) === `${env.base}/site-route`);
  }));

test("a page that leaves its task loses the agent's world at once: kept at the finish, its timer stops and its state is gone (zen-snapshot's kept group)", async () => {
  const mark = `zo-left-${Date.now()}`;
  const space = await env.call("spaces.create", { name: `world left ${Date.now() % 100000}` });
  const P = { space: space.id, page: "p1" };
  let finished = false;
  try {
    await env.call("page.goto", { ...P, url: `${env.base}/nav-target?left` });
    // A timer that writes no DOM: the page stays unwritten, so no clean load
    // replaces it at the finish, and only the discard can stop the timer.
    await env.call("page.evaluate", {
      ...P,
      fn: `() => { window.__left = 1; setInterval(() => sessionStorage.setItem("zo-ticks", String(Number(sessionStorage.getItem("zo-ticks") || 0) + 1)), 20); return 1; }`,
      isFunction: true,
    });
    await env.chrome(`ctx.resolvePage(arg.P).tab.setAttribute(arg.mark, "kept"); return true;`, { P, mark });
    await sleep(150);
    await env.call("spaces.finish", { space: space.id, keep: ["p1"] });
    finished = true;
    const inKept = (module, args) =>
      env.chrome(`${ALL_TABS} return await ctx.content(tabOf(arg.mark).linkedBrowser.browsingContext, arg.module, arg.args);`, { mark, module, args });
    const ticks = async () => Number(await inKept("dev#evalContent", { privileged: false, code: `return sessionStorage.getItem("zo-ticks") || 0;` }));
    await sleep(300);
    const a = await ticks();
    assert.ok(a > 0, "the world's timer ran during the task");
    // The kept tab is a background tab of the user's now, where timers fire
    // at most once a second.
    await sleep(1500);
    assert.equal(await ticks(), a, "the world's timer stopped with the finish");
    assert.deepEqual(await inKept("agentworld#peek", { expr: "window.__left" }), { none: true }, "no world is left in the kept page");
  } finally {
    if (!finished) {
      await env.call("spaces.finish", { space: space.id, keep: [] }).catch(() => {});
    }
    await userTab.close(mark).catch(() => {});
  }
});

test("an agent's html paste makes the page written, as its world's writes do; a plain paste doesn't (zen-snapshot's pasteHtml)", () =>
  env.inSpace("world paste", async page => {
    const written = () => env.chrome(`${PARENT} return AW.isWritten(p.browser);`, { P: page.P });
    // The page's own editor, made by the page's JavaScript: the agent's world wrote nothing.
    const editor = () =>
      env.call("dev.evalContent", { ...page.P, code: `document.body.innerHTML = "<div id=ed contenteditable>x</div>"; document.getElementById("ed").focus(); return 1;` });
    await page.goto(`${env.base}/nav-target?paste-plain`);
    await editor();
    await env.call("page.keyboard", { ...page.P, action: "paste", text: "plain" });
    assert.equal(await written(), false, "a plain paste");
    await page.goto(`${env.base}/nav-target?paste-html`);
    await editor();
    await env.call("page.keyboard", { ...page.P, action: "paste", text: "bold", html: "<b>bold</b>" });
    assert.equal(await written(), true, "an html paste");
  }));

test("an agent's html paste flags every document of its group in that process: the markup's handlers reach them as the page's own code", () =>
  env.inSpace("world paste group", async page => {
    const S = `${env.base}/nav-target?paste-group-popup`;
    await page.goto(`${env.base}/nav-target?paste-group`);
    // The page's own button opens a popup of its site; the agent only clicks it, and writes nothing.
    await env.call("dev.evalContent", {
      ...page.P,
      code: `document.body.innerHTML = "<button id=op style='display:block;width:200px;height:30px'>open</button><div id=ed contenteditable>x</div>";
             document.getElementById("op").onclick = () => window.open(${JSON.stringify(S)});
             return 1;`,
    });
    await env.call("page.click", { ...page.P, target: "#op" });
    let popup = null;
    for (let i = 0; i < 100 && !popup; i++) {
      popup = (await env.call("pages.list", { space: page.P.space })).find(p => p.url === S)?.label ?? null;
      if (!popup) {
        await sleep(50);
      }
    }
    assert.ok(popup, "the popup joined the task");
    const Q = { space: page.P.space, page: popup };
    const written = P => env.chrome(`${PARENT} return AW.isWritten(p.browser);`, { P });
    assert.deepEqual([await written(page.P), await written(Q)], [false, false], "nothing written yet");
    await env.call("dev.evalContent", { ...page.P, code: `document.getElementById("ed").focus(); return 1;` });
    await env.call("page.keyboard", { ...page.P, action: "paste", text: "bold", html: "<b>bold</b>" });
    for (let i = 0; i < 40 && !(await written(Q)); i++) {
      await sleep(50);
    }
    assert.deepEqual([await written(page.P), await written(Q)], [true, true], "the page pasted into, and its popup");
  }));

test("a document that comes in beside a written one of its group is flagged written too: the code left there reaches it; another site's isn't, nor one after the written one is gone", () =>
  env.inSpace("world exposed", async page => {
    const written = P => env.chrome(`${PARENT} return AW.isWritten(p.browser);`, { P });
    const openPopup = async (tag, url) => {
      // As in the popup tests: a listener of the world's opens it, at the agent's click.
      await page.evaluate(
        `(() => {
           const b = document.createElement("button"); b.id = "zo-x-${tag}"; b.textContent = "open"; b.style.cssText = "display:block;width:200px;height:30px";
           b.addEventListener("click", () => window.open(${JSON.stringify(url)}));
           document.body.prepend(b);
           return 1;
         })()`
      );
      await env.call("page.click", { ...page.P, target: `#zo-x-${tag}` });
      let label = null;
      for (let i = 0; i < 100 && !label; i++) {
        label = (await env.call("pages.list", { space: page.P.space })).find(p => p.url === url)?.label ?? null;
        if (!label) {
          await sleep(50);
        }
      }
      assert.ok(label, `the ${tag} popup joined the task`);
      return { space: page.P.space, page: label };
    };
    const until = async (what, fn) => {
      for (let i = 0; i < 40 && !(await fn()); i++) {
        await sleep(50);
      }
      assert.ok(await fn(), what);
    };
    await page.goto(`${env.base}/nav-target?exposed-opener`);
    // The agent's world writes into the opener (the button), so it's written.
    const same = await openPopup("same", `${env.base}/nav-target?exposed-same`);
    assert.equal(await written(page.P), true, "the opener the world wrote into");
    await until("the same-site popup, opened beside it", () => written(same));
    // Another site's popup, whose server answers late. Until it does, the
    // popup's document is its initial about:blank: it inherits the written
    // opener's origin, in the opener's process, so the code left there can
    // reach it, and it counts as written. pages.list already names the popup
    // by the URL it's loading (displayURL), so the check after this waits for
    // that site's own document (zen-core's flake on f6a56c9: it read the
    // about:blank under load).
    const crossUrl = `${env.base.replace("127.0.0.1", "localhost")}/api/slow?ms=1500&exposed-cross`;
    const cross = await openPopup("cross", crossUrl);
    const docUrl = P => env.chrome(`return ctx.resolvePage(arg).browser.browsingContext.currentWindowGlobal?.documentURI?.spec ?? "";`, P);
    assert.notEqual(await docUrl(cross), crossUrl, "the popup's own site hasn't answered yet");
    await until("the cross-site popup's initial about:blank, which the written opener can script", () => written(cross));
    for (let i = 0; i < 200 && (await docUrl(cross)) !== crossUrl; i++) {
      await sleep(50);
    }
    assert.equal(await docUrl(cross), crossUrl, "the popup's own site answered");
    await sleep(300);
    assert.equal(await written(cross), false, "a popup of another site: the written opener can't script it");
    // The popup loads afresh: the written opener is still there to reach it.
    const docOf = P => env.chrome(`return ctx.resolvePage(arg).browser.browsingContext.currentWindowGlobal?.innerWindowId ?? 0;`, P);
    const before = await docOf(same);
    await env.chrome(`ctx.resolvePage(arg).browser.reload(); return true;`, same);
    await until("the popup's fresh document", async () => (await docOf(same)) !== before && (await docOf(same)) !== 0);
    await until("the popup's fresh document, beside the written opener", () => written(same));
    // Once the popups are gone, the opener's own clean copy starts clean.
    await env.call("pages.close", same);
    await env.call("pages.close", cross);
    const opener = await docOf(page.P);
    await env.chrome(`ctx.resolvePage(arg).browser.reload(); return true;`, page.P);
    await until("the opener's clean copy", async () => (await docOf(page.P)) !== opener && (await docOf(page.P)) !== 0);
    await sleep(300);
    assert.equal(await written(page.P), false, "a written page's clean copy, nothing written beside it");
  }));

test("the agent's Ctrl/Cmd+V of the Space's clipboard with html flags the page written too (zen-input's point)", () =>
  env.inSpace("world shortcut paste", async page => {
    const written = () => env.chrome(`${PARENT} return AW.isWritten(p.browser);`, { P: page.P });
    await page.goto(`${env.base}/nav-target?paste-key`);
    await env.call("dev.evalContent", { ...page.P, code: `document.body.innerHTML = "<div id=ed contenteditable>x</div>"; document.getElementById("ed").focus(); return 1;` });
    // What the agent's own copy can leave there: html of its choosing.
    await env.chrome(
      `${PARENT} const { SpaceClipboard } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/clipboard/store.sys.mjs");
       SpaceClipboard.write(p.space.id, { "text/plain": "bold", "text/html": "<b>bold</b>" });
       return true;`,
      { P: page.P }
    );
    assert.equal(await written(), false);
    await env.call("page.keyboard", { ...page.P, action: "press", key: "ControlOrMeta+V" });
    for (let i = 0; i < 40 && !(await written()); i++) {
      await sleep(50);
    }
    assert.equal(await written(), true, "a shortcut paste with html");
    assert.match(await env.call("dev.evalContent", { ...page.P, code: `document.getElementById("ed").innerHTML` }), /<b>bold<\/b>/, "the html went in");
  }));

test("after the finish, a kept page holds the agent's code only while it's written: its own window.open works where the world only ran (zen-snapshot's keptPlanted)", async () => {
  /** A task whose p1 ran `code` in the world and was kept; whether it's written then, and whether its own window.open opens. */
  const keptOpen = async (tag, code) => {
    const mark = `zo-kept-open-${tag}-${Date.now()}`;
    const opened = `opened-${tag}-${Date.now()}`;
    const space = await env.call("spaces.create", { name: `kept open ${tag} ${Date.now() % 100000}` });
    const P = { space: space.id, page: "p1" };
    let finished = false;
    try {
      await env.call("page.goto", { ...P, url: `${env.base}/nav-target?kept-open-${tag}` });
      await env.call("page.evaluate", { ...P, fn: `() => { ${code}; return 1; }`, isFunction: true });
      await env.chrome(`ctx.resolvePage(arg.P).tab.setAttribute(arg.mark, "kept"); return true;`, { P, mark });
      await env.call("spaces.finish", { space: space.id, keep: ["p1"] });
      finished = true;
      // The discard as the tab leaves the task, and the marks it ends.
      await sleep(300);
      // The page's own window.open, from a user's click.
      const page = `window.__opened = (() => { const w = window.open(${JSON.stringify(`${env.base}/nav-target?${opened}`)}, "zo-kept-q"); const ok = !!w; try { w && w.close(); } catch {} return ok; })();`;
      return await env.chrome(
        `${ALL_TABS}
         const AW = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentworld.sys.mjs");
         const tab = tabOf(arg.mark);
         const written = AW.isWritten(tab.linkedBrowser);
         const opens = await ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", { privileged: true, code: \`
           window.document.notifyUserGestureActivation();
           const s = document.createElement("script");
           s.textContent = \${JSON.stringify(arg.page)};
           document.documentElement.append(s);
           s.remove();
           return window.wrappedJSObject.__opened;\` });
         return { written, opens };`,
        { mark, page }
      );
    } finally {
      if (!finished) {
        await env.call("spaces.finish", { space: space.id, keep: [] }).catch(() => {});
      }
      await env
        .chrome(
          `${ALL_TABS}
           for (const t of [...W.allTabs()].filter(t => t.hasAttribute(arg.mark) || (t.linkedBrowser?.currentURI?.spec ?? "").includes(arg.opened))) t.ownerDocument.defaultView.gBrowser.removeTab(t);
           return true;`,
          { mark, opened }
        )
        .catch(() => {});
    }
  };
  // The world only read and kept a value of its own: nothing of the agent's is left.
  assert.deepEqual(await keptOpen("read", "window.__kept = document.title"), { written: false, opens: true });
  // The world wrote into the page: while the page is written, it gets no window.
  const wrote = await keptOpen("wrote", `document.body.setAttribute("data-zo", "1")`);
  assert.equal(wrote.opens, !wrote.written, JSON.stringify(wrote));
});

test("a process flags only its own documents: a page naming another site's document (another process) flags nothing and steers no clean load; that page naming its own does (zen-core's review)", () =>
  env.inSpace("world sender", async page => {
    await page.goto(`${env.base}/nav-target?sender-a`);
    const { label } = await env.call("pages.new", { space: page.P.space, url: `${env.base.replace("127.0.0.1", "localhost")}/nav-target?sender-b` });
    const B = { space: page.P.space, page: label };
    await env.call("page.waitForLoadState", { ...B, state: "load", options: {} });
    const docs = await env.chrome(
      `const a = ctx.resolvePage(arg.A).browser.browsingContext.currentWindowGlobal;
       const b = ctx.resolvePage(arg.B).browser.browsingContext.currentWindowGlobal;
       return { a: a.domProcess.osPid, b: b.domProcess.osPid, id: b.innerWindowId, url: b.documentURI.spec };`,
      { A: page.P, B }
    );
    assert.notEqual(docs.a, docs.b, "the two sites are in two processes");
    const message = { ids: [docs.id], urls: { [docs.id]: { before: docs.url.replace("sender-b", "sender-b-before"), agentSet: docs.url } } };
    const send = from =>
      env.chrome(
        `return await ctx.content(ctx.resolvePage(arg.from).browser.browsingContext, "dev#evalContent", {
           privileged: true,
           code: "Services.cpmm.sendAsyncMessage('zenius:written', " + JSON.stringify(arg.message) + "); return true;",
         });`,
        { from, message }
      );
    const state = () => env.chrome(`${PARENT} return { written: AW.isWritten(p.browser), before: AW.urlBefore(p.browser) };`, { P: B });
    // The 127.0.0.1 page's process names the localhost page's document.
    await send(page.P);
    await sleep(500);
    assert.deepEqual(await state(), { written: false, before: null }, "another process's message counts for nothing");
    // The localhost page's own process: the control.
    await send(B);
    for (let i = 0; i < 40 && !(await state()).written; i++) {
      await sleep(50);
    }
    assert.deepEqual(await state(), { written: true, before: message.urls[docs.id].before });
  }));

test("closing a popup the task adopted keeps its opener's world: a tab that closes takes only its own worlds (zen-eval's e2e on 0a85e8d)", () =>
  env.inSpace("world popup close", async page => {
    await page.goto(`${env.base}/nav-target?opener`);
    // The agent's code writes into the opener and keeps a value in its world.
    await page.evaluate(`document.documentElement.dataset.zo = "1"; window.__probe = { made: true }; 1`);
    for (const [tag, base] of [["same", env.base], ["cross", env.base.replace("127.0.0.1", "localhost")]]) {
      const url = `${base}/nav-target?popup-${tag}`;
      // As in zen-eval's case: a listener of the world's opens it, at the agent's click.
      await page.evaluate(
        `(() => {
           const b = document.createElement("button"); b.id = "zo-open-${tag}"; b.textContent = "open"; b.style.cssText = "display:block;width:200px;height:30px";
           b.addEventListener("click", () => window.open(${JSON.stringify(url)}));
           document.body.prepend(b);
           return 1;
         })()`
      );
      await env.call("page.click", { ...page.P, target: `#zo-open-${tag}` });
      let popup = null;
      for (let i = 0; i < 100 && !popup; i++) {
        popup = (await env.call("pages.list", { space: page.P.space })).find(p => p.url === url)?.label ?? null;
        if (!popup) {
          await sleep(50);
        }
      }
      assert.ok(popup, `the ${tag}-site popup joined the task: ${JSON.stringify(await env.call("pages.list", { space: page.P.space }))}`);
      assert.equal(await page.evaluate("JSON.stringify(window.__probe)"), `{"made":true}`, `with the ${tag}-site popup open`);
      await env.call("pages.close", { space: page.P.space, page: popup });
      await sleep(300);
      assert.equal(await page.evaluate("JSON.stringify(window.__probe)"), `{"made":true}`, `after the agent closed its ${tag}-site popup`);
    }
  }));

test("the user closing a popup the task adopted keeps its opener's world: their close animates the tab out, marked closing, and the popup's world goes with its documents (zen-input's review)", () =>
  env.inSpace("world popup user close", async page => {
    await page.goto(`${env.base}/nav-target?opener-user`);
    await page.evaluate(`document.documentElement.dataset.zo = "1"; window.__probe = { made: true }; 1`);
    const worldIn = (id, expr) =>
      env.chrome(
        `const top = BrowsingContext.getCurrentTopByBrowserId(arg.id);
         return top ? await ctx.content(top, "agentworld#peek", { expr: arg.expr }) : { gone: true };`,
        { id, expr }
      );
    // As a sign-in popup would be: of the opener's site, or of another.
    for (const [tag, base] of [["same", env.base], ["cross", env.base.replace("127.0.0.1", "localhost")]]) {
      const url = `${base}/nav-target?popup-user-${tag}`;
      await page.evaluate(
        `(() => {
           const b = document.createElement("button"); b.id = "zo-user-${tag}"; b.textContent = "open"; b.style.cssText = "display:block;width:200px;height:30px";
           b.addEventListener("click", () => window.open(${JSON.stringify(url)}));
           document.body.prepend(b);
           return 1;
         })()`
      );
      await env.call("page.click", { ...page.P, target: `#zo-user-${tag}` });
      let popup = null;
      for (let i = 0; i < 100 && !popup; i++) {
        popup = (await env.call("pages.list", { space: page.P.space })).find(p => p.url === url)?.label ?? null;
        if (!popup) {
          await sleep(50);
        }
      }
      assert.ok(popup, `the ${tag}-site popup joined the task`);
      const Q = { space: page.P.space, page: popup };
      await env.call("page.evaluate", { ...Q, fn: "window.__mine = 1; 1", isFunction: false });
      const popupId = await env.chrome(`return ctx.resolvePage(arg).browser.browserId;`, Q);
      assert.deepEqual(await worldIn(popupId, "window.__mine"), { value: 1 }, `the ${tag}-site popup has its world`);
      const home = await env.chrome(`return win.gZenWorkspaces.activeWorkspace;`);
      try {
        // The user views the task's tabs and closes the popup's, as its close button does.
        const closing = await env.chrome(
          `await win.gZenWorkspaces.changeWorkspaceWithID(ctx.spaces.agentsSpace.uuid);
           win.gBrowser.selectedTab = ctx.resolvePage(arg.P).tab;
           const { tab, browser } = ctx.resolvePage(arg.Q);
           tab.getBoundingClientRect();
           win.gBrowser.removeTab(tab, { animate: true });
           return { closing: !!tab.closing, connected: browser.isConnected };`,
          { Q, P: page.P }
        );
        assert.deepEqual(closing, { closing: true, connected: true }, `the ${tag}-site popup's tab animates out`);
        for (let i = 0; i < 100 && !(await worldIn(popupId, "1")).gone; i++) {
          await sleep(50);
        }
        assert.deepEqual(await worldIn(popupId, "1"), { gone: true }, `the ${tag}-site popup's tab closed`);
      } finally {
        await env.chrome(`await win.gZenWorkspaces.changeWorkspaceWithID(arg); return true;`, home);
      }
      assert.equal(await page.evaluate("JSON.stringify(window.__probe)"), `{"made":true}`, `after the user closed the ${tag}-site popup`);
    }
    // The same-site popup shared the opener's process: its world went with
    // its document, and the opener's is the group's only one left there.
    assert.equal(await inContent(page.P, "AW.discard(window)"), 1);
  }));

test("the agent closing a popup the user is viewing ends its group's worlds, the opener's too: the popup waits open outside the task, where the opener's timers could reach it, and the opener's calls are refused", () =>
  env.inSpace("world popup waits", async page => {
    await page.goto(`${env.base}/nav-target?opener-waits`);
    await page.evaluate(`document.documentElement.dataset.zo = "1"; window.__probe = { made: true }; 1`);
    const url = `${env.base}/nav-target?popup-waits`;
    await page.evaluate(
      `(() => {
         const b = document.createElement("button"); b.id = "zo-open-waits"; b.textContent = "open"; b.style.cssText = "display:block;width:200px;height:30px";
         b.addEventListener("click", () => window.open(${JSON.stringify(url)}));
         document.body.prepend(b);
         return 1;
       })()`
    );
    await env.call("page.click", { ...page.P, target: "#zo-open-waits" });
    let popup = null;
    for (let i = 0; i < 100 && !popup; i++) {
      popup = (await env.call("pages.list", { space: page.P.space })).find(p => p.url === url)?.label ?? null;
      if (!popup) {
        await sleep(50);
      }
    }
    assert.ok(popup, "the popup joined the task");
    const Q = { space: page.P.space, page: popup };
    await env.call("page.evaluate", { ...Q, fn: "window.__mine = 1; 1", isFunction: false });
    const ids = await env.chrome(
      `return { popup: ctx.resolvePage(arg.Q).browser.browserId, opener: ctx.resolvePage(arg.P).browser.browserId };`,
      { Q, P: page.P }
    );
    const worldIn = (id, expr) =>
      env.chrome(
        `const top = BrowsingContext.getCurrentTopByBrowserId(arg.id);
         return top ? await ctx.content(top, "agentworld#peek", { expr: arg.expr }) : { gone: true };`,
        { id, expr }
      );
    assert.deepEqual(await worldIn(ids.popup, "window.__mine"), { value: 1 });
    const home = await env.chrome(`return win.gZenWorkspaces.activeWorkspace;`);
    try {
      // The user views the popup, so the agent's close waits for them to leave it.
      await env.chrome(
        `await win.gZenWorkspaces.changeWorkspaceWithID(ctx.spaces.agentsSpace.uuid);
         win.gBrowser.selectedTab = ctx.resolvePage(arg).tab;
         return true;`,
        Q
      );
      assert.deepEqual(await env.call("pages.close", Q), { ok: true, deferred: true });
      await sleep(300);
      assert.deepEqual(await worldIn(ids.popup, "window.__mine"), { none: true }, "the popup's world ended, its tab still open");
      assert.deepEqual(await worldIn(ids.opener, "window.__probe"), { none: true }, "the opener's world ended with its group's");
      const refused = await page.fail("page.evaluate", { fn: "1", isFunction: false });
      assert.equal(refused.code, "ZEN_AGENT_CODE_REFUSED", "the opener shares a group with a window outside the task");
      // The user leaves the popup, and it closes.
      await env.chrome(`await win.gZenWorkspaces.changeWorkspaceWithID(arg); return true;`, home);
      for (let i = 0; i < 60 && !(await worldIn(ids.popup, "1")).gone; i++) {
        await sleep(50);
      }
      assert.deepEqual(await worldIn(ids.popup, "1"), { gone: true }, "the popup closed once the user left it");
      // zen-core keeps the opener refused; were it to run the agent's code
      // again, that would be in a fresh world.
      const next = await env.call("page.evaluate", { ...page.P, fn: "typeof window.__probe", isFunction: false }).then(
        value => ({ value }),
        error => ({ code: error.code })
      );
      assert.ok(next.code === "ZEN_AGENT_CODE_REFUSED" || next.value === "undefined", JSON.stringify(next));
    } finally {
      await env.chrome(`await win.gZenWorkspaces.changeWorkspaceWithID(arg); return true;`, home);
      await env.chrome(`for (const t of [...win.gBrowser.tabs]) { if (ctx.pages.isDeferred(t)) { ctx.pages.closeDeferred(t); } } return true;`);
    }
  }));

test("a process that ran the agent's code watches nothing once the task's documents have left it: a user's tab on that site finds no observer; a new world turns it on again", async () => {
  const mark = `zo-world-idle-${Date.now()}`;
  // A site of its own, so no other test's page shares the process
  // (*.localhost is loopback in Gecko).
  const site = env.base.replace("127.0.0.1", "world-idle.localhost");
  const held = () =>
    env.chrome(
      `${ALL_TABS}
       return await ctx.content(tabOf(arg.mark).linkedBrowser.browsingContext, "dev#evalContent", { privileged: true, code: arg.code });`,
      { mark, code: `const AW = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/agentworld.sys.mjs"); return AW.held();` }
    );
  // Gecko keeps several processes per site; with one, the user's tab and the
  // task's page share it.
  const ONE = "dom.ipc.processCount.webIsolated";
  await env.chrome(`Services.prefs.setIntPref(arg, 1); return true;`, ONE);
  try {
    await userTab.open(`${site}/nav-target?idle-user`, mark);
    await env.inSpace("world idle", async page => {
      // A page of its own on the site, which the task closes: a page that
      // navigates away may stay alive in the back-forward cache, with what
      // the agent left there.
      const { label } = await env.call("pages.new", { space: page.space, url: `${site}/nav-target?idle` });
      const Q = { space: page.space, page: label };
      assert.equal(await env.call("page.evaluate", { ...Q, fn: "() => { document.body.dataset.agent = '1'; return 1; }", isFunction: true }), 1);
      // Read from the user's tab, in the same process (one per site here).
      const pids = await env.chrome(
        `${ALL_TABS}
         return [ctx.resolvePage(arg.P).browser, tabOf(arg.mark).linkedBrowser].map(b => b.browsingContext.currentWindowGlobal?.osPid);`,
        { P: Q, mark }
      );
      assert.equal(pids[0], pids[1], "the task's page and the user's tab share a process");
      const on = await held();
      assert.equal(on.watching, true, JSON.stringify(on));
      assert.equal(on.worlds, 1);
      assert.ok(on.written >= 1);
      // The task closes it, so its documents leave the process.
      assert.equal((await env.call("pages.close", Q)).ok, true);
      let last = null;
      await until("the process to hold nothing of the agent's", async () => {
        last = await held();
        return !last.watching && last.worlds + last.mirrors + last.urls + last.written === 0;
      }).catch(e => {
        throw new Error(`${e.message}: ${JSON.stringify(last)}`);
      });
      await page.goto(`${site}/nav-target?idle-again`);
      assert.equal(await page.call("page.evaluate", { fn: "() => 1", isFunction: true }), 1);
      assert.equal((await held()).watching, true);
    });
  } finally {
    await userTab.close(mark).catch(() => {});
    await env.chrome(`Services.prefs.clearUserPref(arg); return true;`, ONE);
  }
});

test("after a task ends, nothing of its worlds stays (zen-core's I4 idea): its process holds no world, compile hook or observer, and the parent listens only while a task has pages or a page keeps the agent's code", async () => {
  const mark = `zo-world-after-${Date.now()}`;
  const site = env.base.replace("127.0.0.1", "world-after.localhost");
  const held = () =>
    env.chrome(
      `${ALL_TABS}
       return await ctx.content(tabOf(arg.mark).linkedBrowser.browsingContext, "dev#evalContent", { privileged: true, code: arg.code });`,
      { mark, code: `const AW = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/agentworld.sys.mjs"); return AW.held();` }
    );
  const ears = () =>
    env.chrome(
      `const AW = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentworld.sys.mjs");
       const { TASK_BROWSERS_KEY } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/taskset.sys.mjs");
       const { hasAgentCodeMarks } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs");
       return { on: AW.agentWorldActive(), needed: (Services.ppmm.sharedData.get(TASK_BROWSERS_KEY)?.size ?? 0) > 0 || hasAgentCodeMarks() };`
    );
  const ONE = "dom.ipc.processCount.webIsolated";
  await env.chrome(`Services.prefs.setIntPref(arg, 1); return true;`, ONE);
  try {
    await userTab.open(`${site}/nav-target?after-user`, mark);
    await env.inSpace("world after", async () => {
      const task = await env.call("spaces.create", { name: `world after task ${Date.now() % 100000}` });
      const { label } = await env.call("pages.new", { space: task.id, url: `${site}/nav-target?after` });
      const Q = { space: task.id, page: label };
      assert.equal(await env.call("page.evaluate", { ...Q, fn: "() => { document.body.dataset.agent = '1'; return 1; }", isFunction: true }), 1);
      const pids = await env.chrome(
        `${ALL_TABS}
         return [ctx.resolvePage(arg.Q).browser, tabOf(arg.mark).linkedBrowser].map(b => b.browsingContext.currentWindowGlobal?.osPid);`,
        { Q, mark }
      );
      assert.equal(pids[0], pids[1], "the task's page and the user's tab share a process");
      const during = await held();
      assert.equal(during.worlds, 1, JSON.stringify(during));
      assert.ok(during.hooks >= 1, JSON.stringify(during));
      assert.deepEqual(await ears(), { on: true, needed: true });
      await env.call("spaces.finish", { space: task.id, keep: [] });
      let last = null;
      await until("the task's process to hold nothing of its worlds", async () => {
        last = await held();
        return !last.watching && last.worlds + last.hooks + last.mirrors + last.urls + last.written === 0;
      }).catch(e => {
        throw new Error(`${e.message}: ${JSON.stringify(last)}`);
      });
    });
    // With every task finished, the parent's ears are on only if a page an
    // earlier test kept still holds the agent's code.
    const now = await ears();
    assert.equal(now.on, now.needed, JSON.stringify(now));
  } finally {
    await userTab.close(mark).catch(() => {});
    await env.chrome(`Services.prefs.clearUserPref(arg); return true;`, ONE);
  }
});
