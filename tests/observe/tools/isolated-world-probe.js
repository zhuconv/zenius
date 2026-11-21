// The isolated-world probe (docs/research/isolated-world.md), zen-observe, 2026-11-20.
// The body of a privileged dev.evalContent call in a task page: run it from a
// throwaway tests/observe test, e.g.
//   const code = fs.readFileSync("tests/observe/tools/isolated-world-probe.js", "utf8");
//   await env.chrome(`return await ctx.content(ctx.resolvePage(arg.P).browser.browsingContext, "dev#evalContent", { privileged: true, code: arg.code });`, { P: page.P, code });
// It returns its results as JSON. No suite loads it.

const Cu = Components.utils, Ci = Components.interfaces, Cc = Components.classes;
const out = {};
const page = window.wrappedJSObject;
const doc = window.document;
const sleep = ms => new Promise(r => window.setTimeout(r, ms));
page.ready = true;
{
  const host = doc.createElement("div"); host.id = "zo-host"; doc.body.append(host);
  host.attachShadow({ mode: "open" }).innerHTML = "<b>in shadow</b>";
  const form = doc.createElement("form"); form.innerHTML = '<input name="q">'; doc.body.append(form);
  form.elements[0].value = "typed";
  const tall = doc.createElement("div"); tall.style.height = "5000px"; doc.body.append(tall);
  const bottom = doc.createElement("p"); bottom.id = "zo-bottom"; bottom.textContent = "bottom"; doc.body.append(bottom);
}
const FILE = "zenius-agent-probe.js";
const S = Cu.Sandbox(window, {
  sandboxPrototype: window, wantXrays: true, allowWaivers: false, sameZoneAs: window,
  wantComponents: false, wantExportHelpers: false, sandboxName: "zenius agent probe",
});
const run = code => {
  try {
    const v = Cu.evalInSandbox(code, S, "latest", FILE, 1);
    return v !== null && typeof v === "object" ? "[object]" : String(v);
  } catch (e) {
    return "THREW " + String(e).slice(0, 200);
  }
};
const runFn = fn => run("(" + fn.toString() + ")()");
const pageHas = k => String(page[k]);

out.waivers = {
  wrappedJSObject: run("typeof window.wrappedJSObject"),
  docWrapped: run("typeof document.wrappedJSObject"),
  XPCNativeWrapper: run("typeof XPCNativeWrapper"),
  unwrap: run("typeof XPCNativeWrapper === 'function' ? String(XPCNativeWrapper.unwrap(window).ready) : 'n/a'"),
  Components: run("typeof Components"),
  helpers: run("typeof exportFunction + ' ' + typeof cloneInto + ' ' + typeof createObjectIn"),
  readyBare: run("typeof ready"),
  readyWindow: run("String(window.ready)"),
};
out.reads = {
  shadow: run("document.getElementById('zo-host').shadowRoot.querySelector('b').textContent"),
  formNamed: run("document.forms[0].q.value"),
  innerText: run("document.body.innerText.includes('bottom')"),
  scrollBefore: String(window.scrollY),
  scrollIntoView: runFn(function () { document.getElementById("zo-bottom").scrollIntoView(); return String(window.scrollY); }),
};

// Escapes, with nothing in the way.
runFn(function () { window.eval("window.__pe = 1"); });
runFn(function () { eval("window.__se = 1"); });
runFn(function () { window.Function("window.__pf = 1")(); });
runFn(function () { window.Object.constructor("window.__pf3 = 1")(); });
runFn(function () { window.setTimeout("window.__pt = 1", 0); });
runFn(function () { setTimeout("window.__pt2 = 1", 0); });
runFn(function () { document.defaultView.setTimeout("window.__pt3 = 1", 0); });
runFn(function () { const s = document.createElement("script"); s.textContent = "window.__ps = 1"; document.head.append(s); });
runFn(function () { const b = document.createElement("button"); b.setAttribute("onclick", "window.__ph = 1"); document.body.append(b); b.click(); });
runFn(function () { const a = document.createElement("a"); a.href = "javascript:window.__pj = 1; void 0"; document.body.append(a); a.click(); });
runFn(function () { const f = document.createElement("iframe"); f.srcdoc = "<script>parent.__psd = 1</script>"; document.body.append(f); });
runFn(function () { const f = document.createElement("iframe"); document.body.append(f); f.contentDocument.write("<script>parent.__pdw = 1</script>"); f.contentDocument.close(); });
runFn(function () { const d = document.createElement("div"); d.innerHTML = '<img src="data:," onerror="window.__pih = 1">'; document.body.append(d); });
await sleep(700);
out.escapes = {
  windowEval: pageHas("__pe"), sandboxEval: pageHas("__se"), windowFunction: pageHas("__pf"), ctorFunction: pageHas("__pf3"),
  windowTimer: pageHas("__pt"), bareTimer: pageHas("__pt2"), viewTimer: pageHas("__pt3"),
  script: pageHas("__ps"), handler: pageHas("__ph"), jsLink: pageHas("__pj"), srcdoc: pageHas("__psd"), docWrite: pageHas("__pdw"), innerHTMLHandler: pageHas("__pih"),
};
out.beforescriptexecute = { page: String("onbeforescriptexecute" in page.document), xray: String("onbeforescriptexecute" in doc) };

// A Debugger on the page's global: who compiles page code, and is the agent's sandbox on the stack?
let addDebuggerToGlobal = null;
out.debuggerModule = "none";
for (const url of ["moz-src:///devtools/platform/jsdebugger.sys.mjs", "resource://devtools/platform/jsdebugger.sys.mjs", "resource://gre/modules/jsdebugger.sys.mjs", "resource://devtools/shared/jsdebugger.sys.mjs"]) {
  try {
    ({ addDebuggerToGlobal } = ChromeUtils.importESModule(url));
    out.debuggerModule = url;
    break;
  } catch {}
}
addDebuggerToGlobal?.(globalThis);
const sOnStack = () => { for (let f = Components.stack; f; f = f.caller) { if (f.filename === FILE) return true; } return false; };
try {
  const dbg = new Debugger();
  dbg.addDebuggee(window);
  const seen = [];
  const refuse = new Set();
  dbg.onNewScript = script => {
    const s = sOnStack();
    seen.push((script.source.introductionType || "?") + (s ? ":S" : ""));
    if (s) {
      refuse.add(script);
      dbg.onEnterFrame = frame => {
        if (refuse.has(frame.script)) {
          refuse.delete(frame.script);
          if (!refuse.size) dbg.onEnterFrame = undefined;
          return { throw: "zenius: refused" };
        }
        return undefined;
      };
    }
  };
  out.debuggerEval = runFn(function () { try { window.eval("window.__pe2 = 1"); return "ran"; } catch (e) { return "caught " + e; } });
  runFn(function () { window.Function("window.__pf2 = 1")(); });
  runFn(function () { const s = document.createElement("script"); s.textContent = "window.__ps2 = 1"; document.head.append(s); });
  runFn(function () { const b = document.createElement("button"); b.setAttribute("onclick", "window.__ph2 = 1"); document.body.append(b); b.click(); });
  runFn(function () { const b = document.createElement("button"); b.setAttribute("onclick", "window.__ph3 = 1"); b.id = "zo-later"; document.body.append(b); });
  runFn(function () { window.setTimeout("window.__pt4 = 1", 0); });
  runFn(function () { const f = document.createElement("iframe"); document.body.append(f); f.contentDocument.write("<script>parent.__pdw2 = 1</script>"); f.contentDocument.close(); });
  doc.getElementById("zo-later").click();
  await sleep(300);
  out.debugger = {
    seen: seen.join(" "), eval2: pageHas("__pe2"), function2: pageHas("__pf2"), script2: pageHas("__ps2"), handlerClickedByAgent: pageHas("__ph2"),
    handlerClickedLater: pageHas("__ph3"), timer4: pageHas("__pt4"), docWriteInFrame: pageHas("__pdw2"),
  };
  dbg.onNewScript = undefined;
  dbg.onEnterFrame = undefined;
  dbg.removeAllDebuggees();
} catch (e) {
  out.debugger = "THREW " + e;
}

// A Debugger on the agent's sandbox: when its code runs (calls, callbacks), and what it costs.
try {
  const loop = "(() => { let x = 0; const f = i => { x += i; }; for (let i = 0; i < 200000; i++) f(i); return x; })()";
  let t0 = ChromeUtils.now(); run(loop); const plain = ChromeUtils.now() - t0;
  const dbg2 = new Debugger();
  dbg2.addDebuggee(S);
  let entries = 0, outer = 0;
  const outerNames = [];
  dbg2.onEnterFrame = frame => {
    entries++;
    if (!frame.older) { outer++; outerNames.push(frame.callee?.name || frame.type); }
  };
  t0 = ChromeUtils.now(); run(loop); const hooked = ChromeUtils.now() - t0;
  dbg2.onEnterFrame = frame => { if (!frame.older) { outer++; outerNames.push(frame.callee?.name || frame.type); } };
  t0 = ChromeUtils.now(); run(loop); const outerOnly = ChromeUtils.now() - t0;
  outer = 0; outerNames.length = 0;
  runFn(function () {
    setTimeout(function sTimer() {}, 10);
    document.body.addEventListener("zo-ev", function sListener() {});
    Promise.resolve().then(function sJob() {});
    (async function sAsync() { await new Promise(r => setTimeout(r, 20)); document.title = document.title; })();
  });
  doc.body.dispatchEvent(new window.Event("zo-ev"));
  await sleep(120);
  out.sandboxDebugger = { plainMs: plain.toFixed(1), everyFrameHookMs: hooked.toFixed(1), outerCheckMs: outerOnly.toFixed(1), entries, outerEntries: outerNames.join(",") };
  dbg2.onEnterFrame = undefined;
  dbg2.removeAllDebuggees();
} catch (e) {
  out.sandboxDebugger = "THREW " + e;
}

// A system listener sees the agent's frame on the stack while the agent dispatches.
try {
  let seen = "none";
  const onProbe = () => { seen = String(sOnStack()); };
  // A chrome listener in the system group, as content actors' are.
  window.windowRoot ? 0 : 0;
  doc.addEventListener("zoprobe", onProbe, { mozSystemGroup: true });
  runFn(function () { document.dispatchEvent(new Event("zoprobe")); });
  doc.removeEventListener("zoprobe", onProbe, { mozSystemGroup: true });
  out.stackInSystemListener = seen;
} catch (e) {
  out.stackInSystemListener = "THREW " + e;
}

// Mutations made while the agent's code runs, taken right after.
{
  const mo = new window.MutationObserver(() => {});
  mo.observe(doc, { subtree: true, attributes: true, childList: true, characterData: true, attributeOldValue: true });
  runFn(function () { document.forms[0].action = "https://elsewhere.example/"; const i = document.createElement("input"); i.name = "extra"; document.forms[0].append(i); });
  out.mutations = mo.takeRecords().map(r => r.type + ":" + (r.attributeName || r.addedNodes.length)).join(",");
  mo.disconnect();
}

// Loud misses: a proxy in the sandbox's prototype chain, and window/self as the sandbox's global.
{
  Cu.exportFunction(name => Object.prototype.hasOwnProperty.call(page, name) && !(name in window), S, { defineAs: "__zeniusPageOnly" });
  out.proxy = {
    install: runFn(function () {
      const proto = Object.getPrototypeOf(globalThis);
      const miss = k => typeof k === "string" && !Reflect.has(proto, k) && __zeniusPageOnly(k);
      Object.setPrototypeOf(globalThis, new Proxy(proto, {
        has(t, k) { return Reflect.has(t, k) || miss(k); },
        get(t, k, r) { if (miss(k)) { throw new ReferenceError(k + " is the page's own"); } return Reflect.get(t, k, r); },
      }));
      Object.defineProperty(globalThis, "window", { value: globalThis, enumerable: true });
      Object.defineProperty(globalThis, "self", { value: globalThis, enumerable: true });
      return "ok";
    }),
    bare: run("try { ready; 'silent' } catch (e) { 'loud: ' + e.message }"),
    viaWindow: run("try { String(window.ready) } catch (e) { 'loud: ' + e.message }"),
    typeofBare: run("try { typeof ready } catch (e) { 'loud: ' + e.message }"),
    title: run("typeof window.document.title"),
    listener: run("try { window.addEventListener('zo-x', () => {}); 'ok' } catch (e) { 'THREW ' + e }"),
    computed: run("window.getComputedStyle(document.body).display"),
    innerWidth: run("String(window.innerWidth > 0)"),
    location: run("String(window.location.href.includes('nav-target'))"),
    state: (run("window.__agent = 41"), run("String(window.__agent + 1)")),
    stateOnPage: pageHas("__agent"),
    defaultView: run("String(document.defaultView.ready)"),
    open: run("typeof window.open"),
    eventView: run("String(document.createEvent('UIEvent').view === null)"),
    componentsUtils: run("typeof Components.utils + ' ' + typeof Components.classes + ' ' + Object.keys(Components).join('|')"),
  };
}

// Script blocked for the sandbox's global during a hold, then back.
{
  run("setInterval(() => { document.documentElement.dataset.sTicks = (+document.documentElement.dataset.sTicks || 0) + 1; }, 20); 1");
  page.setInterval(page.Function("document.documentElement.dataset.pTicks = (+document.documentElement.dataset.pTicks || 0) + 1;"), 20);
  await sleep(200);
  const ticks = () => (doc.documentElement.dataset.sTicks || 0) + "/" + (doc.documentElement.dataset.pTicks || 0);
  const t1 = ticks();
  Cu.blockScriptForGlobal(S);
  const evalBlocked = run("1 + 1");
  await sleep(250);
  const t2 = ticks();
  await sleep(250);
  const t3 = ticks();
  Cu.unblockScriptForGlobal(S);
  await sleep(200);
  out.block = { before: t1, blockedA: t2, blockedB: t3, unblocked: ticks(), evalBlocked };
  Cu.nukeSandbox(S);
  await sleep(200);
  const n1 = ticks();
  await sleep(200);
  out.nuked = n1 + " -> " + ticks();
}
return JSON.stringify(out, null, 1);
