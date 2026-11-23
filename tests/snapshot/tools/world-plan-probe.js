// The isolated-world plan, modeled, to try
// escapes before zen-observe's code lands. The body of a privileged
// dev.evalContent call in the fixture's
// /sb page (sandbox-probe.mjs's "model" group runs it). It builds:
// - the world: zen-observe's sandbox, with window and self as its global, and
//   setTimeout and setInterval that refuse a string (typeof);
// - the count: our calls into the world, plus the world's callbacks, found by
//   a Debugger on the world whose onEnterFrame is set only while the count
//   is 0, and lowered at that frame's onPop;
// - the refusal: a Debugger on the page's windows (the page, its same-origin
//   frame, the site's popup) whose onNewScript refuses scripts compiled while
//   the count is above 0;
// - the written flag: a MutationObserver per document, whose records are
//   taken when the count rises from 0 (dropped: the site's own) and when it
//   returns to 0 (the world's writes).
// Each route's payload is page-world code that says so in window.__esc.
// Controls show what the model refuses or flags, as the plan says it does.
// It returns its results as JSON. No suite loads it.

const Cu = Components.utils;
const out = { routes: {} };
const page = window.wrappedJSObject;
const doc = window.document;
const sleep = ms => new Promise(r => window.setTimeout(r, ms));
const FILE = "zenius-agent-world";

let addDebuggerToGlobal = null;
for (const url of ["moz-src:///devtools/platform/jsdebugger.sys.mjs", "resource://devtools/platform/jsdebugger.sys.mjs", "resource://gre/modules/jsdebugger.sys.mjs"]) {
  try {
    ({ addDebuggerToGlobal } = ChromeUtils.importESModule(url));
    break;
  } catch {}
}
addDebuggerToGlobal(globalThis);

const S = Cu.Sandbox(window, {
  sandboxPrototype: window,
  wantXrays: true,
  allowWaivers: false,
  sameZoneAs: window,
  wantComponents: false,
  wantExportHelpers: false,
  sandboxName: "zenius agent world (model)",
});

let current = "setup";
let depth = 0;
const compiles = [];
const written = [];
const observers = new Map();
const watch = (w, label) => {
  const mo = new w.MutationObserver(() => {});
  mo.observe(w.document, { subtree: true, attributes: true, childList: true, characterData: true });
  observers.set(label, mo);
};
const takeAll = () => {
  const got = [];
  for (const [label, mo] of observers) if (mo.takeRecords().length) got.push(label);
  return got;
};
const rise = () => {
  if (depth++ === 0) {
    takeAll();
    dbgWorld.onEnterFrame = undefined;
  }
};
const fall = () => {
  if (--depth === 0) {
    const got = takeAll();
    if (got.length) written.push(current + "@" + got.join("+"));
    dbgWorld.onEnterFrame = onWorldEnter;
  }
};

// The count: the world's callbacks.
const dbgWorld = new Debugger();
dbgWorld.addDebuggee(S);
function onWorldEnter(frame) {
  rise();
  frame.onPop = () => fall();
}
dbgWorld.onEnterFrame = onWorldEnter;

// The refusal: scripts compiled in the page's windows while the count is above 0.
const dbgPage = new Debugger();
const refuse = new Set();
dbgPage.onNewScript = script => {
  compiles.push({ route: current, type: script.source.introductionType || "?", depth });
  if (depth > 0) refuse.add(script);
};
dbgPage.onEnterFrame = frame => {
  if (refuse.has(frame.script)) {
    refuse.delete(frame.script);
    return { throw: "zenius: refused" };
  }
  return undefined;
};
const track = (w, label) => {
  dbgPage.addDebuggee(w);
  watch(w, label);
};
track(window, "top");
track(window.frames[0], "frame");

const run = code => {
  rise();
  try {
    const v = Cu.evalInSandbox(code, S, "latest", FILE, 1);
    return v !== null && typeof v === "object" ? "[object]" : String(v);
  } catch (e) {
    return "THREW " + String(e).slice(0, 160);
  } finally {
    fall();
  }
};

// The world's own names, as the plan has them.
out.setup = run(`(() => {
  const W = Object.getPrototypeOf(globalThis);
  const st = W.setTimeout, si = W.setInterval;
  Object.defineProperty(globalThis, "window", { value: globalThis, enumerable: true });
  Object.defineProperty(globalThis, "self", { value: globalThis, enumerable: true });
  const guard = f => function (h, ...a) {
    if (typeof h === "string") throw new Error("zenius: refused (string timer)");
    return f.call(W, h, ...a);
  };
  globalThis.setTimeout = guard(st);
  globalThis.setInterval = guard(si);
  return "ok";
})()`);

// The site's popup, which the runner opened with the agent's click on #sitePop.
let popup = null;
for (let i = 0; i < 100 && !popup; i++) {
  await sleep(50);
  try {
    const w = page.open("", "zsSbSitePop");
    if (w?.document?.readyState === "complete" && String(w.location.pathname) === "/sb-frame") popup = w;
  } catch {}
}
if (popup) track(Cu.unwaiveXrays(popup), "popup");
out.popup = !!popup;

const P = n => `(window.__esc = window.__esc || []).push(${JSON.stringify(n)})`;
const FP = n => `(parent.__esc = parent.__esc || []).push(${JSON.stringify(n)})`;
const OP = n => `(opener.__esc = opener.__esc || []).push(${JSON.stringify(n)})`;
const attr = s => s.replace(/'/g, "&#39;");
const img = (n, src) => JSON.stringify(`<img src='data:,${src}' onerror='${attr(P(n))}'>`);
const ROUTES = [
  // Controls: what the plan refuses, flags or keeps.
  ["control: top.eval while the agent's code runs (refused)", n => `top.eval(${JSON.stringify(P(n))})`],
  ["control: the world's arrow calls top.eval from a timer (refused)", n => `setTimeout(() => { try { top.eval(${JSON.stringify(P(n))}); } catch (e) {} }, 0)`],
  ["control: a script element (refused, written)", n => `const s = document.createElement("script"); s.textContent = ${JSON.stringify(P(n))}; document.head.append(s)`],
  ["control: a string timer through window (refused)", n => `window.setTimeout(${JSON.stringify(P(n))}, 0)`],
  ["control: window.eval is the world's own (stays in the world)", n => `window.eval(${JSON.stringify(P(n))})`],
  ["control: an onclick the agent sets, clicked later (written)", n => `const b = document.createElement("button"); b.id = "mLater"; b.setAttribute("onclick", ${JSON.stringify(P(n))}); document.body.append(b)`, () => doc.getElementById("mLater").click()],
  // The page's own eval or Function, handed to a timer or a promise.
  ["timer with top.eval", n => `setTimeout(top.eval, 0, ${JSON.stringify(P(n))})`],
  ["promise with top.eval", n => `Promise.resolve(${JSON.stringify(P(n))}).then(top.eval)`],
  ["top.setTimeout with top.eval", n => `top.setTimeout(top.eval, 0, ${JSON.stringify(P(n))})`],
  ["timer with top's own bound eval", n => `setTimeout(top.Function.prototype.bind.call(top.eval, null, ${JSON.stringify(P(n))}), 0)`],
  // Writes made by built-ins after the call, with no world frame.
  ["timer with Reflect.apply writing an onerror", n => `setTimeout(Reflect.apply, 0, document.body.insertAdjacentHTML, document.body, ["beforeend", ${img(n, "x")}])`],
  ["microtask with a bound write", n => `queueMicrotask(document.body.insertAdjacentHTML.bind(document.body, "beforeend", ${img(n, "y")}))`],
  ["timer with Reflect.apply setting body's onkeydown, then a key", n => `setTimeout(Reflect.apply, 0, document.body.setAttribute, document.body, ["onkeydown", ${JSON.stringify(P(n))}])`, () => doc.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a", bubbles: true }))],
  // Writes no MutationObserver on the document sees.
  ["detached Image with onerror", n => `const i = new Image(); i.setAttribute("onerror", ${JSON.stringify(P(n))}); i.src = "data:,z"`],
  ["template content, rendered later by the site", n => `const i = document.createElement("img"); i.setAttribute("onerror", ${JSON.stringify(P(n))}); i.setAttribute("src", "data:,t"); document.getElementById("tpl").content.append(i)`, () => doc.getElementById("more").click()],
  // String timers and javascript: URLs through the page's own windows.
  ["string timer through top", n => `top.setTimeout(${JSON.stringify(P(n))}, 0)`],
  ["string timer as an object with toString", n => `setTimeout({ toString: () => ${JSON.stringify(P(n))} }, 0)`],
  ["javascript: URL on the page's own location", n => `location.href = "javascript:void(" + ${JSON.stringify(P(n))} + ")"`],
  ["javascript: URL on the frame's location", n => `frames[0].location = "javascript:void(" + ${JSON.stringify(FP(n))} + ")"`],
  // Another page of the group: the site's own popup, by name.
  ["the site's popup: its eval from its timer", n => `const w = window.open("", "zsSbSitePop"); w.setTimeout(w.eval, 0, ${JSON.stringify(OP(n))})`],
  // CSS, which the plan doesn't count as a write (the hold group shows it hearing keys).
  ["CSS: a rule in the site's sheet", () => `document.styleSheets[0].insertRule("#user[value$='a'] { background-image: url(data:,a) }", 0)`],
  ["CSS: an adopted sheet", () => `const sh = new CSSStyleSheet(); sh.replaceSync("#user { font-family: zsLeak, monospace }"); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh]; sh.cssRules.length`],
  // Not an escape: the site's own inline handler, first compiled when the agent's code clicks it.
  ["compat: the site's inline onclick, clicked by the agent's code", () => `document.getElementById("siteInline").click()`],
];

for (const [name, code, after] of ROUTES) {
  current = name;
  const result = run("{ " + code(name) + " }");
  await sleep(300);
  if (after) {
    after();
    await sleep(300);
  }
  const esc = [...(page.__esc ?? [])];
  out.routes[name] = {
    result,
    ranInPage: esc.includes(name),
    compiled: compiles.filter(c => c.route === name).map(c => `${c.type}@${c.depth}`).join(" "),
    written: written.filter(w => w.startsWith(name + "@")).map(w => w.slice(name.length + 1)).join(" ") || false,
  };
}
out.siteInline = page.__siteInline ?? 0;

// A discard (nukeSandbox) after timers the world set: one with the page's own
// bound eval, one with the world's arrow.
current = "after the discard";
const bomb = "after the discard: the page's bound eval";
run(`setTimeout(top.Function.prototype.bind.call(top.eval, null, ${JSON.stringify(P(bomb))}), 800)`);
run(`setTimeout(() => { document.body.dataset.worldTimer = "ran"; }, 800)`);
await sleep(100);
Cu.nukeSandbox(S);
await sleep(1300);
out.afterDiscard = {
  pageBoundEval: [...(page.__esc ?? [])].includes(bomb),
  worldArrow: doc.body.dataset.worldTimer ?? "dead",
};

// A lever: Debugger.onNativeCall on a world sees each built-in its frames
// call (devtools' eager evaluation vetoes side effects with it). Which calls
// does it see, with what reason, and can it refuse one?
{
  const S2 = Cu.Sandbox(window, { sandboxPrototype: window, wantXrays: true, allowWaivers: false, sameZoneAs: window, wantComponents: false, wantExportHelpers: false });
  const dbgNative = new Debugger();
  dbgNative.addDebuggee(S2);
  const calls = [];
  const REFUSE = new Set(["setTimeout", "bind"]);
  dbgNative.onNativeCall = (callee, reason) => {
    const name = callee?.name ?? "?";
    calls.push(name + ":" + reason);
    return REFUSE.has(name) ? { throw: "zenius: refused " + name } : undefined;
  };
  const tryRun = code => {
    try {
      return String(Cu.evalInSandbox(code, S2, "latest", FILE, 1));
    } catch (e) {
      return "THREW " + String(e).slice(0, 80);
    }
  };
  out.onNativeCall = {
    available: typeof dbgNative.onNativeCall === "function",
    setTimeout: tryRun(`setTimeout(top.eval, 0, "1")`),
    bind: tryRun(`top.Function.prototype.bind.call(top.eval, null, "1")`),
    writes: tryRun(`const i = new Image(); i.setAttribute("onerror", "1"); document.getElementById("tpl").content.append(document.createElement("b")); document.styleSheets[0].insertRule("b {}", 0); "ok"`),
    href: tryRun(`location.href.length`),
    calls: calls.join(" "),
  };
  // The page's own built-ins, reached through top: do they run, and does
  // the world's hook see them?
  const seen = code => {
    calls.length = 0;
    const result = tryRun(code);
    return { result, calls: calls.join(" ") };
  };
  out.onNativeCall.pageRealm = {
    reflectSetInnerHTML: seen(`top.Reflect.set(document.getElementById("ed"), "innerHTML", "<b id=pr1>x</b>"); document.getElementById("pr1") ? "written" : "not written"`),
    objectAssign: seen(`top.Object.assign(document.getElementById("ed"), { title: "pr2" }); document.getElementById("ed").title`),
    pageSetAttribute: seen(`top.Reflect.apply(top.Object.getOwnPropertyDescriptor(top.Element.prototype, "setAttribute").value, document.body, ["data-pr3", "1"]); document.body.getAttribute("data-pr3")`),
    pageStringTimer: seen(`String(top.Reflect.apply(top.setTimeout, top, ["document.body.dataset.pr4 = 'ran'", 0]))`),
    pageLocation: seen(`top.Reflect.set(top.location, "hash", "#pr5"); location.hash`),
  };
  await sleep(200);
  out.onNativeCall.pageRealm.pageStringTimer.ran = doc.body.dataset.pr4 ?? "no";
  dbgNative.onNativeCall = undefined;
  dbgNative.removeAllDebuggees();
  Cu.nukeSandbox(S2);
}

dbgWorld.onEnterFrame = undefined;
dbgWorld.removeAllDebuggees();
dbgPage.onNewScript = undefined;
dbgPage.onEnterFrame = undefined;
dbgPage.removeAllDebuggees();
for (const mo of observers.values()) mo.disconnect();
try {
  popup?.close();
} catch {}
return JSON.stringify(out, null, 1);
