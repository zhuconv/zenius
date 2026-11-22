// The evidence flag (docs/research/hooked.md; docs/briefs/defenses-evidence.md,
// the user's pass of 2026-11-21): one flag per document, with its reasons
// (hooked, made, listed, flagged), which the defenses read instead of written.
// observe/evidence.sys.mjs (markEvident, isEvident, evidenceOf, onEvident) and
// content/evidence.sys.mjs (isEvident, evidenceOf, evidenceFlag, markHooked,
// hookedMarkup).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(async () => {
  await env?.close();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PARENT = `const EV = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");
  const p = ctx.resolvePage(arg.P);`;
/** content/evidence.sys.mjs's answer in the page's top document. */
const inContent = (P, call) =>
  env.chrome(
    `const p = ctx.resolvePage(arg.P);
     return await ctx.content(p.browser.browsingContext, "dev#evalContent", { privileged: true, code: arg.code });`,
    { P, code: `const EV = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/evidence.sys.mjs"); return ${call};` }
  );
const parentOf = P => env.chrome(`${PARENT} return { evident: EV.isEvident(p.browser), of: EV.evidenceOf(p.browser) };`, { P });
async function until(what, fn, ms = 4000) {
  for (const end = Date.now() + ms; ; await sleep(50)) {
    if (await fn()) {
      return;
    }
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
  }
}

test("a page the agent only loaded has no evidence; markEvident adds a reason with its detail, read in the parent and in content, once per document and reason; a new load starts clean", () =>
  env.inSpace("evidence marks", async page => {
    await page.goto(`${env.base}/nav-target?evidence`);
    assert.deepEqual(await parentOf(page.P), { evident: false, of: {} });
    assert.deepEqual(await inContent(page.P, "[EV.isEvident(window), EV.evidenceOf(window), EV.evidenceFlag(window)]"), [false, {}, null]);

    const seen = await env.chrome(
      `${PARENT}
       const got = [];
       const off = EV.onEvident(e => got.push([e.browser === p.browser, e.reason, e.detail, Number.isSafeInteger(e.innerWindowId)]));
       const bc = p.browser.browsingContext;
       const marks = [
         EV.markEvident(bc, "listed", "goog-phish-proto"),
         EV.markEvident(bc, "listed", "another list"),
         EV.markEvident(p.browser, "flagged", "it asks for the card's PIN"),
       ];
       off();
       return { marks, got, viaWgp: EV.isEvident(bc.currentWindowGlobal) };`,
      { P: page.P }
    );
    assert.deepEqual(seen.marks, [true, false, true], "a reason a document has already is no news");
    assert.deepEqual(seen.got, [
      [true, "listed", "goog-phish-proto", true],
      [true, "flagged", "it asks for the card's PIN", true],
    ]);
    assert.equal(seen.viaWgp, true);
    const expected = { listed: "goog-phish-proto", flagged: "it asks for the card's PIN" };
    assert.deepEqual(await parentOf(page.P), { evident: true, of: expected }, "the first detail stays");
    // Listed and flagged pages get a warning, not a clean copy (the manager's call): no "clean".
    assert.deepEqual(
      await inContent(page.P, "[EV.isEvident(window), EV.evidenceOf(window.browsingContext), EV.evidenceFlag(window)]"),
      [true, expected, null],
      "content reads it synchronously"
    );

    await page.goto(`${env.base}/nav-target?evidence-2`);
    assert.deepEqual(await parentOf(page.P), { evident: false, of: {} }, "a new document starts clean");
    assert.deepEqual(await inContent(page.P, "[EV.isEvident(window), EV.evidenceFlag(window)]"), [false, null]);
  }));

test("a detail is one line of at most 200 characters; an unknown reason throws, and a target with no document marks nothing", () =>
  env.inSpace("evidence detail", async page => {
    await page.goto(`${env.base}/nav-target?evidence-detail`);
    const out = await env.chrome(
      `${PARENT}
       let bad = null;
       try { EV.markEvident(p.browser, "written", "x"); } catch (e) { bad = e.name; }
       const none = EV.markEvident(null, "flagged", "x");
       EV.markEvident(p.browser, "flagged", "line one\\n\\tline two " + "x".repeat(400));
       return { bad, none, detail: EV.evidenceOf(p.browser).flagged };`,
      { P: page.P }
    );
    assert.equal(out.bad, "TypeError");
    assert.equal(out.none, false);
    assert.ok(out.detail.startsWith("line one line two x"), out.detail);
    assert.ok(out.detail.length <= 200, String(out.detail.length));
    assert.ok(!/\n|\t/.test(out.detail));
  }));

test("a page the agent made from data: has evidence 'made', and evidenceFlag says 'drop' there, as pageFlag did", () =>
  env.inSpace("evidence made", async page => {
    await page.goto("data:text/html,<title>made</title><input>");
    assert.deepEqual(await parentOf(page.P), { evident: true, of: { made: "a data: page" } });
    assert.deepEqual(await inContent(page.P, "[EV.isEvident(window), EV.evidenceFlag(window)]"), [true, "drop"]);
  }));

test("markHooked in content marks the page there at once and in the parent, and only that page: a popup of its site, which page code could reach, isn't hooked (rule 3 of the safety rubric)", () =>
  env.inSpace("evidence hooked group", async page => {
    const S = `${env.base}/nav-target?evidence-popup`;
    await page.goto(`${env.base}/nav-target?evidence-group`);
    // The page's own button opens a popup of its site; the agent only clicks it.
    await env.call("dev.evalContent", {
      ...page.P,
      code: `document.body.innerHTML = "<button id=op style='display:block;width:200px;height:30px'>open</button>";
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
    assert.deepEqual([(await parentOf(page.P)).evident, (await parentOf(Q)).evident], [false, false]);

    // Synchronous in content: before the parent's copy could come back.
    assert.deepEqual(
      await inContent(page.P, `(EV.markHooked(window, "a paste with a script element"), [EV.isEvident(window), EV.evidenceOf(window)])`),
      [true, { hooked: "a paste with a script element" }]
    );
    await until("the parent's copy", async () => (await parentOf(page.P)).evident);
    assert.deepEqual(await parentOf(page.P), { evident: true, of: { hooked: "a paste with a script element" } });
    await sleep(300);
    assert.deepEqual(await parentOf(Q), { evident: false, of: {} }, "not its popup");
    assert.equal(await inContent(Q, "EV.evidenceFlag(window)"), null);
  }));

test("a process marks only its own documents: a message naming another site's document (another process) marks nothing; that site's own process does, and only as hooked", () =>
  env.inSpace("evidence sender", async page => {
    await page.goto(`${env.base}/nav-target?evidence-sender-a`);
    const { label } = await env.call("pages.new", { space: page.P.space, url: `${env.base.replace("127.0.0.1", "localhost")}/nav-target?evidence-sender-b` });
    const B = { space: page.P.space, page: label };
    await env.call("page.waitForLoadState", { ...B, state: "load", options: {} });
    const docs = await env.chrome(
      `const a = ctx.resolvePage(arg.A).browser.browsingContext.currentWindowGlobal;
       const b = ctx.resolvePage(arg.B).browser.browsingContext.currentWindowGlobal;
       return { a: a.domProcess.osPid, b: b.domProcess.osPid, id: b.innerWindowId };`,
      { A: page.P, B }
    );
    assert.notEqual(docs.a, docs.b, "the two sites are in two processes");
    const send = (from, marks) =>
      env.chrome(
        `return await ctx.content(ctx.resolvePage(arg.from).browser.browsingContext, "dev#evalContent", {
           privileged: true,
           code: "Services.cpmm.sendAsyncMessage('zenius:evident', " + JSON.stringify({ marks: arg.marks }) + "); return true;",
         });`,
        { from, marks }
      );
    await send(page.P, [[docs.id, "forged"]]);
    await sleep(500);
    assert.deepEqual(await parentOf(B), { evident: false, of: {} }, "another process's message counts for nothing");
    // Its own process, the control. Content can't claim the parent's reasons.
    await send(B, [[docs.id, "a script element"], [docs.id, "x", "flagged"]]);
    await until("the parent's copy", async () => (await parentOf(B)).evident);
    assert.deepEqual(await parentOf(B), { evident: true, of: { hooked: "a script element" } });
  }));

test("hookedMarkup names the first thing in markup that counts as hooked, and nothing in plain markup", () =>
  env.inSpace("evidence markup", async page => {
    await page.goto(`${env.base}/nav-target?evidence-markup`);
    const cases = [
      ["<p>hello <b>world</b></p>", null],
      ["<a href='https://example.com/'>x</a><img src='/a.png' alt=x>", null],
      ["<div class=x style='color:red' data-onx=1 title='javascript: is a language'>t</div>", null],
      ["<button type=button>Go</button><label>Name</label>", null],
      ["<meta name=description content=x><link rel=icon href='/i.png'>", null],
      ["<template><script>1</script><form></form></template>", null],
      ["<script>1</script>", "a script element"],
      ["<p><img src=x onerror='alert(1)'></p>", "an inline handler (onerror)"],
      ["<a href=' java\tscript:alert(1)'>x</a>", "a javascript: URL (href)"],
      ["<svg><a href='JavaScript:alert(1)'><text>x</text></a></svg>", "a javascript: URL (href)"],
      ["<button formaction='javascript:alert(1)'>go</button>", "a javascript: URL (formaction)"],
      ["<iframe src='/nav-target'></iframe>", "a frame"],
      ["<embed src='/x'>", "an object or embed element"],
      ["<form action='/x'><input name=q></form>", "a form"],
      ["<div><input type=password name=p></div>", "a password field"],
      ["<input type=hidden name=next value=/x>", "a field (input)"],
      ["<textarea></textarea>", "a field (textarea)"],
      ["<select><option>1</option></select>", "a field (select)"],
      ["<div contenteditable=''>x</div>", "an editable area"],
      ["<base href='https://example.com/'>", "a base element"],
      ["<meta http-equiv='Refresh' content='0;url=/x'>", "a meta refresh"],
      ["<style>input[value$=a]{background:url(/a)}</style>", "a style sheet"],
      ["<link rel='alternate stylesheet' href='/x.css'>", "a style sheet"],
    ];
    const got = await inContent(
      page.P,
      `(${JSON.stringify(cases)}).map(([html]) => {
         const body = new window.DOMParser().parseFromString("<!doctype html><body>" + html, "text/html").body;
         return EV.hookedMarkup(body);
       })`
    );
    assert.deepEqual(
      got.map((detail, i) => [cases[i][0], detail]),
      cases.map(([html, detail]) => [html, detail])
    );
    // The node itself counts, and so does a fragment.
    assert.deepEqual(
      await inContent(
        page.P,
        `[EV.hookedMarkup(window.document.createElement("script")),
          EV.hookedMarkup(window.document.createRange().createContextualFragment("<i>x</i><input>")),
          EV.hookedMarkup(window.document.createElement("p"))]`
      ),
      ["a script element", "a field (input)", null]
    );
  }));

// ---------------------------------------------------------------------------
// Hooked: what the agent's world leaves that outlives the discard (commit B)

/** The page's own markup and code, which the agent's world then acts on. */
const SITE = `document.body.innerHTML = "<form id=f action='/x'><input id=i name=q><button id=b type=button>b</button></form><a id=l href='/x'>l</a><p id=t class=a>t</p><div id=host></div><iframe id=zo-frame></iframe>";
  document.head.insertAdjacentHTML("beforeend", "<style id=s>p{}</style>");
  document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<p id=sp>shadow</p>";
  document.getElementById("b").onclick = () => document.body.insertAdjacentHTML("beforeend", "<form id=pf><input type=password></form>");
  return 1;`;
const world = (P, fn) => env.call("page.evaluate", { ...P, fn, isFunction: true });
const hookedIn = P => inContent(P, "EV.evidenceOf(window).hooked ?? null");
const ranInPage = P => env.call("dev.evalContent", { ...P, code: "return document.documentElement.dataset.ran ?? null;" });
let fresh = 0;
/** A new document of the site, with its own markup. */
async function sitePage(page) {
  await page.goto(`${env.base}/nav-target?hooked-${++fresh}`);
  await env.call("dev.evalContent", { ...page.P, code: SITE });
}

test("the agent's code that leaves nothing past the discard marks nothing: values, events, clicks and what the page does about them, reading, text, class and style, listeners, timers and observers", () =>
  env.inSpace("hooked none", async page => {
    await sitePage(page);
    const n = await world(
      page.P,
      `async () => {
        const i = document.getElementById("i");
        i.value = "x"; i.dispatchEvent(new Event("input", { bubbles: true })); i.focus(); window.scrollBy(0, 10);
        // The page's own click handler adds a form with a password field: the page's doing.
        document.getElementById("b").click();
        const t = document.getElementById("t");
        t.textContent = "new text"; t.className = "b"; t.classList.add("c"); t.style.color = "red";
        t.setAttribute("data-x", "1"); t.setAttribute("title", "javascript: is a language"); t.setAttribute("aria-label", "x");
        document.getElementById("host").shadowRoot.getElementById("sp").textContent = "shadow text";
        document.addEventListener("keydown", () => {});
        setTimeout(() => {}, 100000);
        new MutationObserver(() => {}).observe(document.body, { childList: true });
        await new Promise(r => setTimeout(r, 20));
        return document.querySelectorAll("*").length;
      }`
    );
    assert.ok(n > 5);
    await sleep(200);
    assert.equal(await env.call("dev.evalContent", { ...page.P, code: "return !!document.getElementById('pf');" }), true, "the page's own handler ran");
    assert.equal(await hookedIn(page.P), null);
    assert.deepEqual(await parentOf(page.P), { evident: false, of: {} });
  }));

test("each route that outlives the discard marks the page hooked, with what it left: code in the page's realm (and it runs), and changes that redirect what the user types next", () =>
  env.inSpace("hooked routes", async page => {
    const routes = [
      ["a script element", `() => { const s = document.createElement("script"); s.textContent = 'document.documentElement.dataset.ran = "script"'; document.head.append(s); }`, "script"],
      ["an inline handler (onclick)", `() => { document.getElementById("t").setAttribute("onclick", "1"); }`],
      ["an inline handler (onerror)", `() => { document.body.insertAdjacentHTML("beforeend", "<img src=x onerror=1>"); }`],
      ["a javascript: URL (href)", `() => { const a = document.createElement("a"); a.href = "javascript:void 0"; document.body.append(a); }`],
      ["a javascript: URL (href)", `() => { document.getElementById("l").href = "javascript:void 0"; }`],
      ["a javascript: URL (location)", `() => { window.location = 'javascript:void(document.documentElement.dataset.ran = "set")'; }`, "set"],
      ["a location set past window.location", `() => { document.location = 'javascript:void(document.documentElement.dataset.ran = "location")'; }`, "location"],
      ["eval in the page", `() => { top.eval('document.documentElement.dataset.ran = "eval"'); }`, "eval"],
      ["Function in the page", `() => { new top.Function('document.documentElement.dataset.ran = "Function"')(); }`, "Function"],
      ["a string timer", `() => { setTimeout('document.documentElement.dataset.ran = "string"', 0); }`, "string"],
      ["another window's timer", `() => { document.getElementById("zo-frame").contentWindow.setTimeout(() => {}, 0); }`],
      ["a frame", `() => { const f = document.createElement("iframe"); f.srcdoc = "<p>x</p>"; document.body.append(f); }`],
      ["a frame", `() => { document.getElementById("zo-frame").src = "/nav-target?framed"; }`],
      ["a form", `() => { document.body.insertAdjacentHTML("beforeend", "<form action='/y'><input name=a></form>"); }`],
      ["a changed form (action)", `() => { document.getElementById("f").action = "https://example.com/"; }`],
      ["a changed form (target)", `() => { document.getElementById("f").target = "_blank"; }`],
      ["a password field", `() => { document.getElementById("i").type = "password"; }`],
      ["a field (input)", `() => { document.getElementById("f").append(document.createElement("input")); }`],
      ["a field (input)", `() => { document.getElementById("host").shadowRoot.getElementById("sp").insertAdjacentHTML("afterend", "<input>"); }`],
      ["an editable area", `() => { document.getElementById("t").contentEditable = "true"; }`],
      ["a base element", `() => { const b = document.createElement("base"); b.href = "/elsewhere/"; document.head.append(b); }`],
      ["a meta refresh", `() => { document.head.insertAdjacentHTML("beforeend", "<meta http-equiv=refresh content='100;url=/x'>"); }`],
      ["a style sheet", `() => { document.head.append(document.createElement("style")); }`],
      ["a style sheet", `() => { document.getElementById("s").append("input{}"); }`],
      ["a style rule", `() => { document.styleSheets[0].insertRule("input{}"); }`],
      ["a style rule", `() => { const s = new CSSStyleSheet(); s.replaceSync("input{}"); document.adoptedStyleSheets = [s]; }`],
      ["a shadow root", `() => { const h = document.createElement("div"); document.body.append(h); h.attachShadow({ mode: "open" }).innerHTML = "<input>"; }`],
      ["document.write", `() => { document.getElementById("zo-frame").contentDocument.write("<p>x</p>"); }`],
    ];
    const missed = [];
    for (const [detail, fn, ran] of routes) {
      await sitePage(page);
      await world(page.P, fn);
      let got = null;
      for (let i = 0; i < 20 && got === null; i++) {
        got = await hookedIn(page.P);
        if (got === null) {
          await sleep(50);
        }
      }
      if (got !== detail) {
        missed.push([fn, got]);
      }
      if (ran) {
        assert.equal(await ranInPage(page.P), ran, `${fn} ran in the page`);
      }
    }
    assert.deepEqual(missed, [], "routes with no mark or another detail");
    // The parent has it too.
    await until("the parent's copy", async () => (await parentOf(page.P)).evident);
    assert.deepEqual(await parentOf(page.P), { evident: true, of: { hooked: "document.write" } });
  }));

test("a callback the agent's code left counts when it runs: a timer that adds a script element marks the page then", () =>
  env.inSpace("hooked later", async page => {
    await sitePage(page);
    await world(page.P, `() => { setTimeout(() => { const s = document.createElement("script"); s.textContent = "1"; document.body.append(s); }, 150); }`);
    assert.equal(await hookedIn(page.P), null, "nothing yet");
    await until("the timer's mark", async () => (await hookedIn(page.P)) === "a script element");
  }));

test("a popup a hooked page opens after the agent left a script isn't hooked: only the agent's own writes hook a window (rule 3 of the safety rubric)", () =>
  env.inSpace("hooked beside", async page => {
    const S = `${env.base}/nav-target?hooked-beside-popup`;
    await sitePage(page);
    await env.call("dev.evalContent", {
      ...page.P,
      code: `document.getElementById("b").onclick = () => window.open(${JSON.stringify(S)}); return 1;`,
    });
    await world(page.P, `() => { const s = document.createElement("script"); s.textContent = "1"; document.head.append(s); }`);
    assert.equal(await hookedIn(page.P), "a script element");
    await env.call("page.click", { ...page.P, target: "#b" });
    let popup = null;
    for (let i = 0; i < 100 && !popup; i++) {
      popup = (await env.call("pages.list", { space: page.P.space })).find(p => p.url === S)?.label ?? null;
      if (!popup) {
        await sleep(50);
      }
    }
    assert.ok(popup, "the popup joined the task");
    const Q = { space: page.P.space, page: popup };
    await env.call("page.waitForLoadState", { ...Q, state: "load", options: {} });
    await sleep(300);
    assert.deepEqual(await parentOf(Q), { evident: false, of: {} });
    assert.equal(await hookedIn(page.P), "a script element", "the opener stays hooked");
  }));

test("the agent's code that writes into another window of its group hooks that window by its own write, after its page was hooked too (rule 3: each window the agent wrote into)", () =>
  env.inSpace("hooked second window", async page => {
    const S = `${env.base}/nav-target?hooked-second-popup`;
    await sitePage(page);
    // The page's own button opens a named popup; the agent only clicks it.
    await env.call("dev.evalContent", {
      ...page.P,
      code: `document.getElementById("b").onclick = () => window.open(${JSON.stringify(S)}, "zpop"); return 1;`,
    });
    await env.call("page.click", { ...page.P, target: "#b" });
    let popup = null;
    for (let i = 0; i < 100 && !popup; i++) {
      popup = (await env.call("pages.list", { space: page.P.space })).find(p => p.url === S)?.label ?? null;
      if (!popup) {
        await sleep(50);
      }
    }
    assert.ok(popup, "the popup joined the task");
    const Q = { space: page.P.space, page: popup };
    await env.call("page.waitForLoadState", { ...Q, state: "load", options: {} });
    assert.equal(await world(page.P, `() => { window.__w = window.open("", "zpop"); return window.__w.location.href; }`), S, "the world has the popup by its name");
    await sleep(300);
    assert.deepEqual(await parentOf(Q), { evident: false, of: {} });
    await world(page.P, `() => { const s = document.createElement("script"); s.textContent = "1"; document.head.append(s); return 1; }`);
    assert.ok(await hookedIn(page.P), "its page is hooked");
    // One run that writes into its own page, hooked already, and then into
    // the popup. A style sheet runs nothing, so only the watch of the
    // world's writes sees it (a script element would mark the popup as it
    // runs there).
    await world(page.P, `() => { for (const d of [document, window.__w.document]) d.head.append(d.createElement("style")); return 1; }`);
    await until("the popup's own mark", async () => (await parentOf(Q)).evident);
    assert.deepEqual(await parentOf(Q), { evident: true, of: { hooked: "a style sheet" } });
  }));

test("the agent's code can't register a service worker: a task page's registration is refused, the world's route too", () =>
  env.inSpace("hooked sw", async page => {
    await page.goto(`${env.base}/nav-target?hooked-sw`);
    const got = await world(page.P, `() => navigator.serviceWorker.register("/sw.js").then(r => r.unregister().then(() => "registered"), e => e.name)`);
    assert.equal(got, "SecurityError");
  }));
