// The hand-off (SPI.md, "The hand-off"): before the user holds a page,
// zenius makes it safe for their typing, on evidence only since 2026-11-21.
// Only a page the agent's code left something hooked in, or one the agent
// made, gets the quiet load, the hold's COOP, the channel mute and the
// refusal of new windows: filling, clicking and reading are no evidence, nor
// is a flag or a list, which the UI warns of instead. The core's parts: the
// quiet load (a new GET entry, the form and the focus carried over), the
// two-step replacement of a site's marked windows, the hold's refusal of new
// windows, the discard of the agent's sandboxes,
// and what the hand back tells the agent. The observe layer's guards
// (tests/observe) cover the rest.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, before, test } from "node:test";
import { setup, sleep } from "./lib.mjs";

let h;
/** Two sites on one loopback server: 127.0.0.1 and localhost; a second server is another origin of 127.0.0.1. */
let port = 0;
let port2 = 0;
const server = { posts: 0, getsOfPost: 0, away: 0, hanging: [], served: new Set() };
const page = title => `<!doctype html><title>${title}</title>
<form method=post action=/post>
<input name=t><input type=hidden name=h value=orig><input type=password name=p><input type=checkbox name=c>
<select name=s><option value=a>a<option value=b>b</select><textarea name=ta></textarea><button>go</button>
</form>`;
const serve = (req, res) => {
  const url = new URL(req.url, "http://x");
  // No cache-control: a plain reload would restore form state here.
  const headers = { "content-type": "text/html" };
  // A shared worker that passes each message on to its other pages.
  if (url.pathname === "/worker.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(`const ports = [];
      onconnect = e => {
        const port = e.ports[0];
        ports.push(port);
        port.onmessage = m => { for (const other of ports) if (other !== port) other.postMessage(m.data); };
      };`);
    return;
  }
  // A page that never answers: a quiet load to it brings no new document.
  if (url.pathname === "/hang") {
    server.hanging.push(res);
    return;
  }
  // A site's page that sends itself on with its own script as it loads.
  if (url.pathname === "/jsnext") {
    res.writeHead(200, headers);
    res.end(`<!doctype html><title>jsnext</title><script>location.replace(new URLSearchParams(location.search).get("to"));</script>`);
    return;
  }
  // The site's open redirect, as sites' ?next= handlers are.
  if (url.pathname === "/redirect") {
    res.writeHead(302, { location: url.searchParams.get("to") ?? "/" });
    res.end();
    return;
  }
  // A page whose URL leads elsewhere once it has been loaded, as a site's
  // page does after its session ended (to the sign-in, on another site):
  // the first load gets the form, each later one a redirect to `to`.
  if (url.pathname === "/once") {
    if (server.served.has(url.search)) {
      res.writeHead(302, { location: url.searchParams.get("to") ?? "/" });
      res.end();
      return;
    }
    server.served.add(url.search);
  }
  // A page as most frameworks send it, kept for revalidation: the HTTP
  // cache holds it (a secret step's one-time page, a QR image).
  if (url.pathname === "/cached") {
    res.writeHead(200, { "content-type": "text/html", "cache-control": "private, max-age=0, must-revalidate" });
    res.end(`<!doctype html><title>cached</title><p id=m>${url.searchParams.get("m") ?? ""}</p>`);
    return;
  }
  if (url.searchParams.get("ho")?.endsWith("away")) {
    server.away++;
  }
  if (url.pathname === "/post") {
    if (req.method === "POST") {
      server.posts++;
    } else {
      server.getsOfPost++;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, headers);
      res.end(page("result"));
    });
    return;
  }
  res.writeHead(200, headers);
  res.end(page(url.searchParams.get("ho") ?? "form"));
};
const http1 = http.createServer(serve);
const http2 = http.createServer(serve);
const site = path => `http://127.0.0.1:${port}${path}`;
const other = path => `http://localhost:${port}${path}`;

before(async () => {
  await new Promise(resolve => http1.listen(0, "127.0.0.1", resolve));
  port = http1.address().port;
  await new Promise(resolve => http2.listen(0, "127.0.0.1", resolve));
  port2 = http2.address().port;
  h = await setup();
  // A page's own window.open with no click, kept in the background (I1).
  await h.chrome(
    `Services.prefs.setBoolPref("dom.disable_open_during_load", false);
     Services.prefs.setBoolPref("browser.tabs.loadDivertedInBackground", true);
     // Each discard zenius asks for is noted, then made (zen-observe's).
     ctx.service.hoDiscards = [];
     ctx.service.hoDiscardFail = null;
     const real = Object.getPrototypeOf(ctx.service).discardAgentCode;
     ctx.service.discardAgentCode = async function (target) {
       ctx.service.hoDiscards.push(target?.task !== undefined ? "task " + target.task : "page");
       if (ctx.service.hoDiscardFail) {
         throw new Error(ctx.service.hoDiscardFail);
       }
       return real.call(this, target);
     };
     return true;`
  );
});
after(async () => {
  try {
    await h
      ?.chrome(
        `Services.prefs.clearUserPref("dom.disable_open_during_load");
         Services.prefs.clearUserPref("browser.tabs.loadDivertedInBackground");
         delete ctx.service.discardAgentCode;
         delete ctx.service.hoDiscards;
         delete ctx.service.hoDiscardFail;
         return true;`
      )
      .catch(() => {});
    await h?.close();
  } finally {
    // Whatever close() found (its I1 check throws): open servers would keep
    // this file's process, and the whole run, waiting forever.
    for (const res of server.hanging) {
      res.destroy();
    }
    for (const server of [http1, http2]) {
      server.close();
      server.closeAllConnections();
    }
  }
});

/** The agent's world in the page (where its window handles live): {none: true} once a hand-off ended it. */
const worldOf = (space, label) =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     const tab = ctx.pages.tabFor(ctx.pages.get(s, arg.label));
     return ctx.content(tab.linkedBrowser.browsingContext, "agentworld#peek", { expr: "typeof window.__p" });`,
    { space, label }
  );
/** Run `code` (a function body) as the page's own script, gates aside. */
const inPage = (space, label, code) =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     const tab = ctx.pages.tabFor(ctx.pages.get(s, arg.label));
     return ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", { code: arg.code, privileged: false });`,
    { space, label, code }
  );
/** Give the page a user activation, as the user's click or the agent's would: Gecko then lets a beforeunload handler prompt. */
const activate = (space, label) =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     const tab = ctx.pages.tabFor(ctx.pages.get(s, arg.label));
     return ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", { privileged: true, code: "document.notifyUserGestureActivation(); return document.hasBeenUserGestureActivated;" });`,
    { space, label }
  );
const LEAVE_HANDLER = `window.onbeforeunload = e => { e.preventDefault(); e.returnValue = "stay"; }; return 1;`;
/** The page's document, history length, group, and whether the observe layer holds it. */
const info = (space, label) =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     const b = ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser;
     const hold = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/hold.sys.mjs");
     const bc = b.browsingContext;
     return { inner: bc.currentWindowGlobal?.innerWindowId ?? 0, history: bc.sessionHistory?.count ?? 0,
       tops: bc.group.getToplevels().length, held: hold.holdOf(b) !== undefined, url: b.currentURI.spec };`,
    { space, label }
  );
/** The task's front page, without moving any window (the page the hand-off holds). */
const front = (space, label) =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     ctx.pages.noteFront(ctx.pages.tabFor(ctx.pages.get(s, arg.label)));
     return true;`,
    { space, label }
  );
const loaded = (space, label, part) =>
  h.until(async () => {
    const i = await info(space, label).catch(() => null);
    return !!i?.url.includes(part) && (await inPage(space, label, "return document.readyState;").catch(() => "")) === "complete";
  }, 10000);
const pageOf = async (space, part) => {
  let found = null;
  await h.until(async () => (found = (await h.chrome(
    `return ctx.pages.list(arg.space).map(p => ({ label: p.label, url: ctx.pages.tabFor(p)?.linkedBrowser.currentURI.spec ?? "" }));`,
    { space }
  )).find(p => p.url.includes(part))), 10000);
  return found.label;
};
/** The spaceChanged events zenius emits, from now on. */
const listen = () =>
  h.chrome(
    `ctx.service.hoEvents = [];
     ctx.service.hoOff?.();
     ctx.service.hoOff = ctx.service.addEventListener((e, p) => e === "spaceChanged" && "ownership" in p && ctx.service.hoEvents.push(p));
     return true;`
  );
const heard = () => h.chrome(`return ctx.service.hoEvents ?? [];`);
/** What the last quiet load's carry-over saw (counts), for a failure's message. */
const quietNote = async () => JSON.stringify(await h.chrome(`return ctx.service.lastQuietLoad ?? null;`).catch(e => e.message));
/** The user's Resume agent. */
const resume = space =>
  h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "agent", { source: "user" }); return true;`, space);
const cleanUp = async space => {
  await h.chrome(`ctx.service.hoOff?.(); delete ctx.service.hoOff; delete ctx.service.hoEvents; return true;`).catch(() => {});
  await resume(space).catch(() => {});
  await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
};

/** The discards zenius asked for since freshDiscards ("task <id>"), and the entry a task's own would be. */
const discards = () => h.chrome(`return ctx.service.hoDiscards;`);
const freshDiscards = () => h.chrome(`ctx.service.hoDiscards.length = 0; ctx.service.hoDiscardFail = null; return true;`);
const taskOf = space => h.chrome(`return "task " + ctx.spaces.get(arg).id;`, space);

/** The group switch is gone, but a profile may still set its pref. */
const leftoverGroupSwitch = on =>
  h.chrome(
    on ? `Services.prefs.setBoolPref("zenius.handoff.groupSwitch", true); return true;` : `Services.prefs.clearUserPref("zenius.handoff.groupSwitch"); return true;`
  );

const FILL = `(() => {
  const f = document.forms[0];
  f.t.value = "typed"; f.h.value = "planted"; f.p.value = "secret";
  f.c.checked = true; f.s.value = "b"; f.ta.value = "area";
  f.t.focus();
  return 1;
})()`;
const READ = `const f = document.forms[0];
  return [f.t.value, f.h.value, f.p.value, f.c.checked, f.s.value, f.ta.value].join(",") + "|" + (document.activeElement?.name ?? "");`;

/**
 * Agent code that leaves something hooked in the page: a style sheet, which
 * outlives the discard of its world (the observe layer's evidence). Every document
 * of the page's site in its window group is marked with it.
 */
const HOOK = `(document.head.append(document.createElement("style")), 1)`;
const hook = (space, label) => h.call("page.evaluate", { space, page: label, isFunction: false, fn: HOOK });
const EV_URL = "chrome://userscripts/content/zenius/observe/evidence.sys.mjs";
/** The page's evidence, its top document and frames (the observe layer's evidenceOf). */
const evidenceIn = (space, label) =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     const b = ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser;
     return ChromeUtils.importESModule(${JSON.stringify(EV_URL)}).evidenceOf(b);`,
    { space, label }
  );
/** Mark the page's top document with `reason`, as the agent's world, Safe Browsing or page.flag would; its evidence after. */
const markPage = (space, label, reason = "hooked", detail = "a script element") =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     const b = ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser;
     const EV = ChromeUtils.importESModule(${JSON.stringify(EV_URL)});
     EV.markEvident(b, arg.reason, arg.detail);
     return EV.evidenceOf(b);`,
    { space, label, reason, detail }
  );

test("a hand-off loads afresh a page the agent's code left something hooked in: its visible fields and focus come back, not the agent's hidden value or a secret", async () => {
  const space = await h.space("ho reload");
  await freshDiscards();
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=1") });
    await loaded(space, label, "ho=1");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
    await hook(space, label);
    const before = await info(space, label);
    await listen();
    const reply = await h.call("spaces.handOff", { space });
    assert.equal(reply.ownership, "agentDelegatedToUser");
    assert.deepEqual(reply.reloaded, [label]);
    assert.deepEqual(await discards(), [await taskOf(space)], "the agent's sandboxes went first");
    const now = await info(space, label);
    assert.notEqual(now.inner, before.inner, "a new document");
    assert.equal(now.history, before.history, "in place of the old entry");
    assert.equal(now.held, true);
    assert.equal(await inPage(space, label, READ), "typed,orig,,true,b,area|t", `the quiet load: ${await quietNote()}`);
    assert.deepEqual(await evidenceIn(space, label), {}, "the fresh document has no evidence");
    const events = await heard();
    assert.equal(events.length, 1);
    assert.equal(events[0].ownership, "agentDelegatedToUser");
    assert.equal(events[0].reloaded, "reload");
    assert.equal(events[0].carried, true);
    assert.deepEqual(events[0].evidence, { [label]: { hooked: "a style sheet" } }, "zen-ux's card says why");
    await resume(space);
    const back = await h.call("spaces.waitForControl", { space, timeout: 5000 });
    assert.deepEqual(back.reloaded, [label]);
    assert.equal(back.openerCut, undefined);
    assert.equal((await info(space, label)).held, false, "the hold ends with it");
  } finally {
    await cleanUp(space);
  }
});

test("a POST result is loaded again by GET, never resubmitted", async () => {
  const space = await h.space("ho post");
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=2") });
    await loaded(space, label, "ho=2");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: "(document.forms[0].t.value = 'x', document.forms[0].submit(), 1)" });
    await loaded(space, label, "/post");
    await hook(space, label);
    const posts = server.posts;
    const gets = server.getsOfPost;
    await listen();
    const reply = await h.call("spaces.handOff", { space });
    assert.deepEqual(reply.reloaded, [label]);
    assert.equal(server.posts, posts, "nothing resubmitted");
    assert.equal(server.getsOfPost, gets + 1);
    assert.equal((await heard())[0].reloaded, "get");
  } finally {
    await cleanUp(space);
  }
});

test("a page where the agent's code never ran is held, not loaded again", async () => {
  const space = await h.space("ho clean");
  await freshDiscards();
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=3") });
    await loaded(space, label, "ho=3");
    const before = await info(space, label);
    await listen();
    const reply = await h.call("spaces.handOff", { space });
    assert.equal(reply.reloaded, undefined);
    assert.deepEqual(await discards(), [await taskOf(space)], "the agent's sandboxes go all the same");
    const now = await info(space, label);
    assert.equal(now.inner, before.inner);
    assert.equal(now.held, true);
    assert.equal((await heard())[0].reloaded, undefined);
    assert.equal((await heard())[0].evidence, undefined, "nothing loaded afresh, so no evidence");
  } finally {
    await cleanUp(space);
  }
});

test("a page the agent's code only filled and focused is held as it is, with what the agent typed: that's no evidence, and nor is a flag or a list", async () => {
  const space = await h.space("ho filled");
  await freshDiscards();
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=filled") });
    await loaded(space, label, "ho=filled");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
    await h.call("page.flag", { space, page: label, reason: "asks for more than the task needs" });
    assert.deepEqual(Object.keys(await markPage(space, label, "listed", "phishing: test-list")).sort(), ["flagged", "listed"]);
    const before = await info(space, label);
    const reply = await h.call("spaces.handOff", { space });
    assert.equal(reply.reloaded, undefined);
    assert.deepEqual(await discards(), [await taskOf(space)], "the agent's sandboxes go all the same");
    const now = await info(space, label);
    assert.equal(now.inner, before.inner, "the same document");
    assert.equal(now.held, true);
    assert.match(await inPage(space, label, READ), /^typed,planted,secret,true,b,area\|/, "the agent's values stay");
  } finally {
    await cleanUp(space);
  }
});

test("a hand-off of a page the agent made is refused before the agent's code is discarded, and the task stays the agent's", async () => {
  const space = await h.space("ho made");
  await freshDiscards();
  try {
    const { label } = await h.call("pages.new", { space, url: "about:blank" });
    await h.call("page.goto", { space, page: label, url: "data:text/html,<p>made by the agent</p>" });
    await assert.rejects(h.call("spaces.handOff", { space }), e => {
      assert.equal(e.code, "ZEN_HANDOFF_REFUSED");
      const data = e.details ?? e.data;
      assert.equal(data.reason, "agentPage");
      assert.equal(data.page, label);
      assert.match(e.message, /hand that off/);
      return true;
    });
    assert.equal(await h.ownership(space), "agent");
    assert.equal((await info(space, label)).held, false);
    assert.deepEqual(await discards(), [], "the agent keeps its code");
  } finally {
    await cleanUp(space);
  }
});

test("when the agent's code doesn't stop, the hand-off is refused (discardFailed): the hold is released and the task stays the agent's", async () => {
  const space = await h.space("ho discard");
  await freshDiscards();
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=10") });
    await loaded(space, label, "ho=10");
    await h.chrome(`ctx.service.hoDiscardFail = "a process didn't answer"; return true;`);
    await assert.rejects(h.call("spaces.handOff", { space }), e => {
      assert.equal(e.code, "ZEN_HANDOFF_REFUSED");
      assert.equal((e.details ?? e.data).reason, "discardFailed");
      assert.match(e.message, /a process didn't answer.*task\.handOff\(\) again/);
      return true;
    });
    assert.equal(await h.ownership(space), "agent");
    assert.equal((await info(space, label)).held, false);
  } finally {
    await h.chrome(`ctx.service.hoDiscardFail = null; return true;`).catch(() => {});
    await cleanUp(space);
  }
});

test("a held popup beside the agent's page on its site, which the agent's code hooked: that page loads afresh, and the popup, where the agent's code left nothing, is held as it is, with its group and opener", async () => {
  const space = await h.space("ho beside");
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=4bT") });
    await loaded(space, T, "ho=4bT");
    await h.call("page.evaluate", { space, page: T, isFunction: false, fn: `(window.__p = window.open(${JSON.stringify(site("/form?ho=4bP"))}), 1)` });
    const P = await pageOf(space, "ho=4bP");
    await loaded(space, P, "ho=4bP");
    await h.call("page.evaluate", { space, page: P, isFunction: false, fn: FILL });
    await hook(space, T);
    assert.deepEqual(await evidenceIn(space, P), {}, "being reachable from a hooked page is no evidence");
    await front(space, P);
    const [tBefore, pBefore] = [await info(space, T), await info(space, P)];
    const reply = await h.call("spaces.handOff", { space });
    assert.deepEqual(reply.reloaded, [T]);
    const [tNow, pNow] = [await info(space, T), await info(space, P)];
    assert.notEqual(tNow.inner, tBefore.inner, "T loaded afresh");
    assert.equal(pNow.inner, pBefore.inner, "P as it was");
    assert.deepEqual([await evidenceIn(space, T), await evidenceIn(space, P)], [{}, {}], "T's copy came in clean beside P");
    assert.equal(pNow.tops, 2, "P keeps its group");
    assert.equal(await inPage(space, P, "return String(window.opener !== null);"), "true");
  } finally {
    await cleanUp(space);
  }
});

test("a held popup and the agent's page beside it on its site, both of which the agent's code hooked: each loads afresh on its own, the page first, and both copies come in clean; the popup keeps its group and opener (a leftover zenius.handoff.groupSwitch true changes nothing)", async () => {
  const space = await h.space("ho paused");
  await leftoverGroupSwitch(true);
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=4T") });
    await loaded(space, T, "ho=4T");
    await h.call("page.evaluate", { space, page: T, isFunction: false, fn: `(window.__p = window.open(${JSON.stringify(site("/form?ho=4P"))}), 1)` });
    const P = await pageOf(space, "ho=4P");
    await loaded(space, P, "ho=4P");
    await h.call("page.evaluate", { space, page: P, isFunction: false, fn: FILL });
    await hook(space, P);
    await hook(space, T);
    await front(space, P);
    const [tBefore, pBefore] = [await info(space, T), await info(space, P)];
    const reply = await h.call("spaces.handOff", { space });
    assert.deepEqual(reply.reloaded, [T, P], "T, which could reach P, first");
    const [tNow, pNow] = [await info(space, T), await info(space, P)];
    assert.notEqual(tNow.inner, tBefore.inner, "T loaded afresh");
    assert.notEqual(pNow.inner, pBefore.inner, "P loaded afresh");
    assert.deepEqual([tNow.url, pNow.url], [site("/form?ho=4T"), site("/form?ho=4P")]);
    assert.deepEqual([tNow.history, pNow.history], [tBefore.history, pBefore.history], "each in place of its old entry");
    assert.deepEqual([await evidenceIn(space, T), await evidenceIn(space, P)], [{}, {}], "neither copy came in marked");
    assert.equal(await inPage(space, P, READ), "typed,orig,,true,b,area|t", `P's form came back: ${await quietNote()}`);
    assert.equal(pNow.tops, 2, "P keeps its group");
    assert.equal(await inPage(space, P, "return String(window.opener !== null);"), "true");
    await resume(space);
    const back = await h.call("spaces.waitForControl", { space, timeout: 5000 });
    assert.equal(back.openerCut, undefined);
  } finally {
    await leftoverGroupSwitch(false).catch(() => {});
    await cleanUp(space);
  }
});

test("a popup the agent's page opened, where its code left nothing hooked: neither loads afresh, since the discard ended the agent's handle, and during the hold that page opens windows as usual", async () => {
  const space = await h.space("ho popup plain");
  await freshDiscards();
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=pp-T") });
    await loaded(space, T, "ho=pp-T");
    await h.call("page.evaluate", { space, page: T, isFunction: false, fn: `(window.__p = window.open(${JSON.stringify(site("/form?ho=pp-P"))}), 1)` });
    const P = await pageOf(space, "ho=pp-P");
    await loaded(space, P, "ho=pp-P");
    await h.call("page.evaluate", { space, page: P, isFunction: false, fn: FILL });
    await front(space, P);
    const [tBefore, pBefore] = [await info(space, T), await info(space, P)];
    const reply = await h.call("spaces.handOff", { space });
    assert.equal(reply.reloaded, undefined);
    assert.equal((await info(space, T)).inner, tBefore.inner, "T as it was");
    assert.equal((await info(space, P)).inner, pBefore.inner, "P as it was");
    assert.equal((await info(space, P)).held, true);
    assert.deepEqual(await worldOf(space, T), { none: true }, "the agent's world and its handle are gone");
    assert.equal(await inPage(space, P, "return String(window.opener !== null);"), "true");
    assert.equal(await inPage(space, T, `return String(!!window.open(${JSON.stringify(site("/form?ho=pp-x"))}));`), "true", "no evidence, so no refusal");
    assert.ok(await pageOf(space, "ho=pp-x"));
  } finally {
    await cleanUp(space);
  }
});

test("a held popup whose opener is on another site keeps it: the agent's hooked window on the popup's site loads afresh in place, and during the hold the group runs no agent code and the opener, which the agent hooked, opens nothing", async () => {
  const space = await h.space("ho other");
  const off = await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     ctx.service.hoRefused = [];
     ctx.service.hoRefusedOff = W.onOpenRefused(info => ctx.service.hoRefused.push(!!info.hold));
     return true;`
  );
  assert.ok(off);
  try {
    const { label: T } = await h.call("pages.new", { space, url: other("/form?ho=6T") });
    await loaded(space, T, "ho=6T");
    await h.call("page.evaluate", {
      space,
      page: T,
      isFunction: false,
      fn: `(window.__p = window.open(${JSON.stringify(site("/form?ho=6P"))}), window.__r = window.open(${JSON.stringify(site("/form?ho=6R"))}), 1)`,
    });
    const P = await pageOf(space, "ho=6P");
    const R = await pageOf(space, "ho=6R");
    await loaded(space, P, "ho=6P");
    await loaded(space, R, "ho=6R");
    await hook(space, R);
    await hook(space, T);
    await front(space, P);
    const rBefore = (await info(space, R)).inner;
    const reply = await h.call("spaces.handOff", { space });
    assert.deepEqual(reply.reloaded, [R], "P, beside R, isn't hooked");
    assert.notEqual((await info(space, R)).inner, rBefore, "R loaded afresh");
    assert.equal((await info(space, P)).tops, 3, "P keeps its group");
    assert.equal(await inPage(space, P, "return String(window.opener !== null);"), "true");
    // P kept its window (its opener, above); the agent's handle lived in its
    // world, which the hand-off ended (the observe layer's glue).
    assert.deepEqual(await worldOf(space, T), { none: true }, "the agent's world and its handle are gone");
    const refusal = label =>
      h.chrome(`const s = ctx.spaces.get(arg.space); return ctx.pages.codeRefusal(s, ctx.pages.get(s, arg.label));`, { space, label });
    assert.deepEqual(await refusal(T), { reason: "hold", windows: 1 });
    assert.deepEqual(await refusal(R), { reason: "hold", windows: 1 });
    // While the user holds P: T, which the agent's code hooked, opens
    // nothing, with an opener or without; P's own popup joins the task.
    assert.equal(await inPage(space, T, `return String(window.open(${JSON.stringify(other("/form?ho=6x"))}));`), "null");
    assert.equal(await inPage(space, T, `return String(window.open(${JSON.stringify(other("/form?ho=6y"))}, "_blank", "noopener"));`), "null");
    assert.deepEqual(await h.chrome(`return ctx.service.hoRefused;`), [true, true]);
    assert.equal(await inPage(space, P, `return String(!!window.open(${JSON.stringify(site("/form?ho=6Q"))}));`), "true");
    assert.ok(await pageOf(space, "ho=6Q"));
    await resume(space);
    await h.call("spaces.waitForControl", { space, timeout: 5000 });
    assert.equal(await refusal(T), null, "not kept: it ended with the hold");
  } finally {
    await h.chrome(`ctx.service.hoRefusedOff?.(); delete ctx.service.hoRefusedOff; delete ctx.service.hoRefused; return true;`).catch(() => {});
    await cleanUp(space);
  }
});

test("the held page's load onto a site where the agent's code left something hooked leaves the group (a sign-in's callback), and the hand back says openerCut", async () => {
  const space = await h.space("ho callback");
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=7T") });
    await loaded(space, T, "ho=7T");
    await h.call("page.evaluate", { space, page: T, isFunction: false, fn: `(window.__p = window.open(${JSON.stringify(other("/form?ho=7P"))}), 1)` });
    // T now holds what the agent's code left hooked, which outlives its discard.
    await hook(space, T);
    const P = await pageOf(space, "ho=7P");
    await loaded(space, P, "ho=7P");
    await front(space, P);
    const reply = await h.call("spaces.handOff", { space });
    assert.equal(reply.reloaded, undefined, "the provider's page held no agent code");
    assert.equal((await info(space, P)).tops, 2);
    // The provider sends the user back to the agent's site, as the page's own load.
    await inPage(space, P, `location.href = ${JSON.stringify(site("/form?ho=7cb"))}; return 1;`);
    await loaded(space, P, "ho=7cb");
    assert.equal((await info(space, P)).tops, 1, "alone in its group");
    // The agent's handle lived in its world, which the hand-off ended (the observe layer's glue).
    assert.deepEqual(await worldOf(space, T), { none: true }, "the agent's world and its handle are gone");
    await resume(space);
    const back = await h.call("spaces.waitForControl", { space, timeout: 5000 });
    assert.equal(back.openerCut, true);
  } finally {
    await cleanUp(space);
  }
});

test("the held page's load onto the agent's site stays in its group when the agent's code there left nothing hooked: a written paragraph is no evidence", async () => {
  const space = await h.space("ho callback plain");
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=7bT") });
    await loaded(space, T, "ho=7bT");
    await h.call("page.evaluate", { space, page: T, isFunction: false, fn: `(window.__p = window.open(${JSON.stringify(other("/form?ho=7bP"))}), 1)` });
    await h.call("page.evaluate", { space, page: T, isFunction: false, fn: `(document.body.append(document.createElement("p")), 1)` });
    const P = await pageOf(space, "ho=7bP");
    await loaded(space, P, "ho=7bP");
    await front(space, P);
    await h.call("spaces.handOff", { space });
    await inPage(space, P, `location.href = ${JSON.stringify(site("/form?ho=7bcb"))}; return 1;`);
    await loaded(space, P, "ho=7bcb");
    assert.equal((await info(space, P)).tops, 2, "still beside T");
    assert.equal(await inPage(space, P, "return String(window.opener !== null);"), "true");
    await resume(space);
    const back = await h.call("spaces.waitForControl", { space, timeout: 5000 });
    assert.equal(back.openerCut, undefined);
  } finally {
    await cleanUp(space);
  }
});

test("the user's Take over does what a hand-off does, and its spaceChanged says it came from the user", async () => {
  const space = await h.space("ho take over");
  await freshDiscards();
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=8") });
    await loaded(space, label, "ho=8");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
    await hook(space, label);
    await listen();
    const result = await h.chrome(
      `const s = ctx.spaces.get(arg.space);
       const r = await ctx.service.userTakeOver(s, ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser);
       return r;`,
      { space, label }
    );
    assert.deepEqual(
      result,
      { agentPage: false, how: "reload", reloaded: [label], carried: true, openerCut: false, evidence: { [label]: { hooked: "a style sheet" } } },
      `the quiet load: ${await quietNote()}`
    );
    assert.deepEqual(await discards(), [await taskOf(space)]);
    const [event] = await heard();
    assert.equal(event.source, "user");
    assert.equal(event.reloaded, "reload");
    assert.deepEqual(event.evidence, { [label]: { hooked: "a style sheet" } });
    assert.equal(await inPage(space, label, READ), "typed,orig,,true,b,area|t");
  } finally {
    await cleanUp(space);
  }
});

test("the task's end discards the agent's code", async () => {
  const space = await h.space("ho end");
  await h.call("pages.new", { space, url: site("/form?ho=9") });
  const task = await taskOf(space);
  await freshDiscards();
  await h.call("spaces.finish", { space, keep: [] });
  assert.deepEqual(await discards(), [task]);
});

test("a page's leave prompt can't stop the hand-off: the agent's window, with a beforeunload handler and a user activation, loads afresh at once", async () => {
  const space = await h.space("ho leave prompt");
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=11T") });
    await loaded(space, T, "ho=11T");
    await h.call("page.evaluate", { space, page: T, isFunction: false, fn: `(window.__p = window.open(${JSON.stringify(site("/form?ho=11P"))}), 1)` });
    const P = await pageOf(space, "ho=11P");
    await loaded(space, P, "ho=11P");
    await hook(space, T);
    await front(space, P);
    // A handler the site's code or the agent's left, on an activated page:
    // Gecko would ask the user whether to leave.
    await inPage(space, T, LEAVE_HANDLER);
    assert.equal(await activate(space, T), true);
    const tBefore = (await info(space, T)).inner;
    const reply = await h.call("spaces.handOff", { space });
    assert.ok(reply.reloaded.includes(T), `reloaded ${reply.reloaded}`);
    assert.notEqual((await info(space, T)).inner, tBefore, "T loaded afresh, no prompt in the way");
  } finally {
    await cleanUp(space);
  }
});

test("a load that brings no new document refuses the hand-off, which names the pages it already loaded afresh: the user never holds the old document", async () => {
  const space = await h.space("ho fail closed");
  let P = null;
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=12T") });
    await loaded(space, T, "ho=12T");
    await h.call("page.evaluate", { space, page: T, isFunction: false, fn: `(window.__p = window.open(${JSON.stringify(site("/form?ho=12P"))}), 1)` });
    P = await pageOf(space, "ho=12P");
    await loaded(space, P, "ho=12P");
    await hook(space, P);
    await hook(space, T);
    await front(space, P);
    // With this Gecko pref a leave prompt shows without an activation too,
    // and in an agent tab the observe layer holds it for the agent: H's load
    // can't happen.
    await h.chrome(
      `Services.prefs.setBoolPref("dom.require_user_interaction_for_beforeunload", false);
       ctx.service.quietLoadTimeoutMs = 2000;
       return true;`
    );
    await inPage(space, P, LEAVE_HANDLER);
    const pBefore = (await info(space, P)).inner;
    await assert.rejects(h.call("spaces.handOff", { space }), e => {
      assert.equal(e.code, "ZEN_HANDOFF_REFUSED");
      const data = e.details ?? e.data;
      assert.equal(data.reason, "reloadFailed");
      assert.equal(data.page, P);
      assert.deepEqual(data.reloaded, [T], "T went first, and loaded afresh before P's load failed");
      assert.equal(data.offSite, undefined, "a load that didn't come isn't one that left the site");
      assert.match(e.message, /didn't load afresh.*task\.handOff\(\) again/);
      return true;
    });
    assert.equal(await h.ownership(space), "agent");
    assert.equal((await info(space, P)).held, false);
    assert.equal((await info(space, P)).inner, pBefore, "the old document is there, and the task is still the agent's");
    assert.equal((await info(space, T)).url, site("/form?ho=12T"), "T's copy shows its page");
  } finally {
    await h
      .chrome(
        `Services.prefs.clearUserPref("dom.require_user_interaction_for_beforeunload");
         delete ctx.service.quietLoadTimeoutMs;
         const D = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/dialogs.sys.mjs");
         if (arg.P) {
           const s = ctx.spaces.get(arg.space);
           const b = ctx.pages.tabFor(ctx.pages.get(s, arg.P))?.linkedBrowser;
           if (b && D.currentDialog(b)) D.answerDialog(b, false);
         }
         return true;`,
        { space, P }
      )
      .catch(() => {});
    if (P) {
      await inPage(space, P, "window.onbeforeunload = null; return 1;").catch(() => {});
    }
    await cleanUp(space);
  }
});

/** The site's own router puts its open redirect in the URL (the snapshot layer's siteRouterRedirect): the page's own code, which the native hook doesn't see. */
const routeTo = (space, label, to) =>
  inPage(space, label, `history.replaceState(null, "", "/redirect?to=" + encodeURIComponent(${JSON.stringify(to)})); return location.href;`);
const userTakeOver = (space, label) =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     return await ctx.service.userTakeOver(s, ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser);`,
    { space, label }
  );

test("the site's router shows its open redirect: the quiet load stops before anything of the other site loads, goes to the URL that brought the document instead, and the hand-off holds that, its fields back", async () => {
  const space = await h.space("ho off site");
  await freshDiscards();
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=13") });
    await loaded(space, label, "ho=13");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
    await hook(space, label);
    await routeTo(space, label, other("/form?ho=13away"));
    const before = await info(space, label);
    const away = server.away;
    const reply = await h.call("spaces.handOff", { space });
    assert.deepEqual(reply.reloaded, [label]);
    const now = await info(space, label);
    assert.notEqual(now.inner, before.inner, "a fresh document");
    assert.equal(now.url, site("/form?ho=13"));
    assert.equal(now.held, true);
    assert.equal(await h.ownership(space), "agentDelegatedToUser");
    assert.equal(await inPage(space, label, READ), "typed,orig,,true,b,area|t", await quietNote());
    assert.equal(server.away, away, "nothing of the other site loaded");
  } finally {
    await cleanUp(space);
  }
});

test("the same through the site's pushState, at the user's Take over: the page's own script sending it off the site as it loads afresh is stopped, and the URL that brought the document is held instead", async () => {
  const space = await h.space("ho js next");
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=16") });
    await loaded(space, label, "ho=16");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
    await hook(space, label);
    await inPage(space, label, `history.pushState(null, "", "/jsnext?to=" + encodeURIComponent(${JSON.stringify(other("/form?ho=16away"))})); return 1;`);
    const away = server.away;
    const result = await userTakeOver(space, label);
    assert.deepEqual(result.reloaded, [label]);
    const now = await info(space, label);
    assert.equal(now.held, true);
    assert.equal(now.url, site("/form?ho=16"));
    assert.equal(await h.ownership(space), "agentDelegatedToUser");
    assert.equal(await inPage(space, label, READ), "typed,orig,,true,b,area|t", await quietNote());
    assert.equal(server.away, away, "no request went to the other site");
  } finally {
    await cleanUp(space);
  }
});

test("a page whose own URL now leads off its site too is refused: the load to the URL that brought the document is stopped as well, and the hand-off and the Take over are refused with the old document still there", async () => {
  const space = await h.space("ho off site twice");
  await freshDiscards();
  try {
    const { label } = await h.call("pages.new", { space, url: site(`/once?ho=13b&to=${encodeURIComponent(other("/form?ho=13onceaway"))}`) });
    await loaded(space, label, "ho=13b");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
    await hook(space, label);
    await routeTo(space, label, other("/form?ho=13away"));
    const before = await info(space, label);
    const away = server.away;
    await assert.rejects(h.call("spaces.handOff", { space }), e => {
      assert.equal(e.code, "ZEN_HANDOFF_REFUSED");
      const data = e.details ?? e.data;
      assert.equal(data.reason, "reloadFailed");
      assert.equal(data.page, label);
      assert.match(e.message, /ho%3D13onceaway|ho=13onceaway/);
      assert.equal(data.offSite, other("/form?ho=13onceaway"), "zen-ux's card offers no Try again for it");
      assert.match(e.message, /another site/);
      return true;
    });
    let now = await info(space, label);
    assert.equal(now.inner, before.inner, "the old document is still there");
    assert.equal(now.held, false);
    assert.equal(await h.ownership(space), "agent");
    assert.match(await inPage(space, label, READ), /^typed,planted,secret,true,b,area\|/);
    // The user's Take over of the page they see: refused the same way.
    await assert.rejects(userTakeOver(space, label), e => {
      assert.match(e.message, /another site/);
      return true;
    });
    now = await info(space, label);
    assert.equal(now.inner, before.inner);
    assert.equal(now.held, false);
    assert.equal(await h.ownership(space), "agent");
    assert.equal(server.away, away, "nothing of the other site loaded");
  } finally {
    await cleanUp(space);
  }
});

test("a quiet load that ends on another origin of the page's site is handed off, and no field comes back into it", async () => {
  const space = await h.space("ho other origin");
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=14") });
    await loaded(space, label, "ho=14");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
    await hook(space, label);
    const there = `http://127.0.0.1:${port2}/form?ho=14there`;
    await routeTo(space, label, there);
    const reply = await h.call("spaces.handOff", { space });
    assert.deepEqual(reply.reloaded, [label]);
    const now = await info(space, label);
    assert.equal(now.url, there);
    assert.equal(now.held, true);
    assert.equal(await inPage(space, label, READ), ",orig,,false,a,|", "the user's typing stays with its origin");
  } finally {
    await cleanUp(space);
  }
});

/** The page's own channel and shared worker, as a site's cross-tab sync opens them, and what each hears. */
const LISTEN = `window.__heard = [];
  window.__ch = new BroadcastChannel("ho-mute");
  __ch.onmessage = e => __heard.push("c:" + e.data);
  window.__w = new SharedWorker("/worker.js");
  __w.port.onmessage = e => __heard.push("w:" + e.data);
  __w.port.start();
  return 1;`;
const say = (space, label, word) =>
  inPage(space, label, `try { __ch.postMessage(${JSON.stringify(word)}); __w.port.postMessage(${JSON.stringify(word)}); return "ok"; } catch (e) { return "threw " + e.name; }`);
const heardIn = (space, label) => inPage(space, label, "return __heard.slice().sort().join();");

test("the hold mutes the channels and shared workers the held page opened before it, beside a task page on its site that the agent's code hooked: neither hears the other, and its own code doesn't throw", async () => {
  const space = await h.space("ho mute");
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=15T") });
    await loaded(space, T, "ho=15T");
    const { label: H } = await h.call("pages.new", { space, url: site("/form?ho=15H") });
    await loaded(space, H, "ho=15H");
    await inPage(space, T, LISTEN);
    await inPage(space, H, LISTEN);
    await hook(space, T);
    // Both ways before the hold (the worker may still be connecting the
    // second page, so say it until it's heard).
    await h.until(async () => {
      await say(space, T, "t1");
      await say(space, H, "h1");
      return (await heardIn(space, H)).includes("w:t1") && (await heardIn(space, T)).includes("w:h1");
    }, 10000);
    assert.match(await heardIn(space, H), /^c:t1/);
    assert.match(await heardIn(space, T), /^c:h1/);
    const heardH = await heardIn(space, H);
    const heardT = await heardIn(space, T);
    await front(space, H);
    const before = await info(space, H);
    await h.call("spaces.handOff", { space });
    const now = await info(space, H);
    assert.equal(now.held, true);
    assert.equal(now.inner, before.inner, "a page with no evidence is held as it is: T's marks stay in T's own window group");
    assert.equal(await say(space, T, "t2"), "ok");
    assert.equal(await say(space, H, "h2"), "ok", "the site's own code in the held page keeps working");
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(await heardIn(space, H), heardH, "the held page hears nothing of the task's page");
    assert.equal(await heardIn(space, T), heardT, "the task's page hears nothing of the held page");
  } finally {
    await cleanUp(space);
  }
});

test("without evidence in the task's pages, the hold mutes nothing: the site's own channels and shared workers go on", async () => {
  const space = await h.space("ho no mute");
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=15bT") });
    await loaded(space, T, "ho=15bT");
    const { label: H } = await h.call("pages.new", { space, url: site("/form?ho=15bH") });
    await loaded(space, H, "ho=15bH");
    await inPage(space, T, LISTEN);
    await inPage(space, H, LISTEN);
    await h.call("page.evaluate", { space, page: T, isFunction: false, fn: FILL });
    await h.until(async () => {
      await say(space, T, "t1");
      await say(space, H, "h1");
      return (await heardIn(space, H)).includes("w:t1") && (await heardIn(space, T)).includes("w:h1");
    }, 10000);
    await front(space, H);
    const before = await info(space, H);
    await h.call("spaces.handOff", { space });
    const now = await info(space, H);
    assert.equal(now.held, true);
    assert.equal(now.inner, before.inner, "no evidence: H is held as it is");
    await h.until(async () => {
      await say(space, T, "t2");
      await say(space, H, "h2");
      return (await heardIn(space, H)).includes("c:t2") && (await heardIn(space, T)).includes("c:h2");
    }, 5000);
  } finally {
    await cleanUp(space);
  }
});

test("a page that sends itself to another site with its own script as it loads afresh, whose own URL leads off the site too: both loads are stopped, and the hand-off refused", async () => {
  const space = await h.space("ho js next twice");
  try {
    const { label } = await h.call("pages.new", { space, url: site(`/once?ho=16b&to=${encodeURIComponent(other("/form?ho=16onceaway"))}`) });
    await loaded(space, label, "ho=16b");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
    await hook(space, label);
    await inPage(space, label, `history.replaceState(null, "", "/jsnext?to=" + encodeURIComponent(${JSON.stringify(other("/form?ho=16away"))})); return 1;`);
    const away = server.away;
    await assert.rejects(h.call("spaces.handOff", { space }), e => {
      assert.equal(e.code, "ZEN_HANDOFF_REFUSED");
      assert.equal((e.details ?? e.data).reason, "reloadFailed");
      assert.equal((e.details ?? e.data).offSite, other("/form?ho=16onceaway"));
      assert.match(e.message, /ho%3D16onceaway|ho=16onceaway/);
      assert.match(e.message, /another site/);
      return true;
    });
    const now = await info(space, label);
    assert.equal(now.held, false);
    assert.match(now.url, /^http:\/\/127\.0\.0\.1:\d+\/jsnext/, "the page stayed on its site");
    assert.equal(await h.ownership(space), "agent");
    assert.equal(server.away, away, "no request went to the other site");
  } finally {
    await cleanUp(space);
  }
});

// Landing (2): zenius's clean loads under the isolated world, on evidence.
// The observe layer's world records the URL the
// agent's code set in place (observe/agentworld.sys.mjs noteWritten), and
// marks what its code left hooked; these tests set both through those hooks,
// as content would.

const AW_URL = "chrome://userscripts/content/zenius/observe/agentworld.sys.mjs";
/** The page's <browser>, in chrome code. */
const BROWSER = `const b = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), arg.label)).linkedBrowser;`;
/** The world wrote into the page's top document, and, with `urls`, changed its URL. */
const flagWritten = (space, label, urls = null) =>
  h.chrome(
    `${BROWSER}
     const AW = ChromeUtils.importESModule(${JSON.stringify(AW_URL)});
     const id = b.browsingContext.currentWindowGlobal.innerWindowId;
     AW.noteWritten(b.browsingContext, [id], arg.urls ? { [id]: arg.urls } : {});
     return { written: AW.isWritten(b), urlBefore: AW.urlBefore(b) };`,
    { space, label, urls }
  );
/** The agent's code moves the page's URL in place, as replaceState does; the world records it. */
const agentSetURL = async (space, label, to) => {
  const before = (await info(space, label)).url;
  await inPage(space, label, `history.replaceState(null, "", ${JSON.stringify(to)}); return location.href;`);
  const agentSet = (await info(space, label)).url;
  return { before, agentSet, ...(await flagWritten(space, label, { before, agentSet })) };
};

test("landing (2): the clean copy on demand loads a hooked page afresh, its form carried over and the focus on the field the user went for, and says what it acted on; a page with nothing hooked, written, listed or flagged, has nothing to clean", async () => {
  const space = await h.space("ho demand");
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=demand") });
    await loaded(space, label, "ho=demand");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
    const clean = () => h.chrome(`${BROWSER} return ctx.service.cleanOnDemand(b);`, { space, label });
    const before = await info(space, label);
    assert.deepEqual(await clean(), { how: null, carried: false, focused: false, evidence: {} });
    assert.equal((await flagWritten(space, label)).written, true);
    assert.deepEqual(await clean(), { how: null, carried: false, focused: false, evidence: {} }, "written is no evidence");
    await markPage(space, label, "listed", "phishing: test-list");
    const marks = await markPage(space, label, "flagged", "asks for a card number");
    assert.deepEqual(await clean(), { how: null, carried: false, focused: false, evidence: marks }, "a clean copy can't remove a list's or a flag's danger");
    assert.equal((await info(space, label)).inner, before.inner, "nothing loaded");
    // The agent's code left something hooked, and the user's press went for
    // the textarea (the input layer's guard notes it before the focus moves).
    const evidence = await markPage(space, label);
    await h.chrome(
      `${BROWSER}
       return ctx.content(b.browsingContext, "dev#evalContent", { privileged: true, code: "ChromeUtils.importESModule('chrome://userscripts/content/zenius/content/forms.sys.mjs').noteUserTarget(content.document.forms[0].ta); return 1;" });`,
      { space, label }
    );
    assert.deepEqual(evidence, { hooked: "a script element", listed: "phishing: test-list", flagged: "asks for a card number" });
    assert.deepEqual(await clean(), { how: "reload", carried: true, focused: true, urlBefore: null, evidence }, await quietNote());
    assert.notEqual((await info(space, label)).inner, before.inner, "a new document");
    assert.match(await inPage(space, label, READ), /^typed,orig,,true,b,area\|ta$/, await quietNote());
    assert.deepEqual(await evidenceIn(space, label), {}, "the fresh document has no evidence");
  } finally {
    await cleanUp(space);
  }
});

test("the clean copy on demand loads one tab afresh at most cleanCopyCap.max times in its window: past that it isn't loaded again, and the ask fails", async () => {
  const space = await h.space("ho cap");
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=cap") });
    await loaded(space, label, "ho=cap");
    await h.chrome(`ctx.service.cleanCopyCap = { max: 2, windowMs: 60000 }; return true;`);
    const clean = () => h.chrome(`${BROWSER} return ctx.service.cleanOnDemand(b);`, { space, label });
    for (let n = 1; n <= 2; n++) {
      assert.ok((await markPage(space, label)).hooked);
      const inner = (await info(space, label)).inner;
      assert.equal((await clean()).how, "reload", `clean copy ${n}`);
      assert.notEqual((await info(space, label)).inner, inner, `clean copy ${n}: a new document`);
    }
    assert.ok((await markPage(space, label)).hooked);
    const inner = (await info(space, label)).inner;
    await assert.rejects(clean(), /loaded afresh 2 times in 60 s/);
    assert.equal((await info(space, label)).inner, inner, "no third load");
  } finally {
    await h.chrome(`delete ctx.service.cleanCopyCap; return true;`).catch(() => {});
    await cleanUp(space);
  }
});

test("landing (2): the clean load goes to the URL from before the agent's change (urlBefore): the open redirect and /consent, under a hand-off and under Take over", async () => {
  for (const how of ["handOff", "takeOver"]) {
    for (const [name, to] of [
      ["redirect", `/redirect?to=${encodeURIComponent(other("/form?ho=urlaway"))}`],
      ["consent", "/consent?ho=consent"],
    ]) {
      const space = await h.space(`ho url ${how} ${name}`);
      try {
        const start = site(`/form?ho=url-${how}-${name}`);
        const { label } = await h.call("pages.new", { space, url: start });
        await loaded(space, label, `ho=url-${how}-${name}`);
        await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
        const set = await agentSetURL(space, label, to);
        assert.deepEqual([set.before, set.urlBefore], [start, start], JSON.stringify(set));
        await markPage(space, label);
        const before = await info(space, label);
        const away = server.away;
        if (how === "handOff") {
          await h.call("spaces.handOff", { space });
        } else {
          await userTakeOver(space, label);
        }
        const now = await info(space, label);
        assert.notEqual(now.inner, before.inner, `${how} ${name}: a new document`);
        assert.equal(now.url, start, `${how} ${name}: back to the URL before the agent's change`);
        assert.equal(server.away, away, `${how} ${name}: nothing of the other site loaded`);
        assert.match(await inPage(space, label, READ), /^typed,orig,,true,b,area\|t$/, await quietNote());
      } finally {
        await cleanUp(space);
      }
    }
  }
});

test("landing (2): at the task's end, a hooked page that stays open loads afresh with its form; one whose load brings no new document stays hooked; one the agent's code only wrote into stays as it is", async () => {
  const space = await h.space("ho end");
  const ids = [];
  try {
    for (const part of ["enda", "endb", "endc"]) {
      const { label } = await h.call("pages.new", { space, url: site(`/form?ho=${part}`) });
      await loaded(space, label, `ho=${part}`);
      await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
      ids.push({ label, ...(await info(space, label)), id: await h.chrome(`${BROWSER} return b.browserId;`, { space, label }) });
    }
    const [a, b, c] = ids;
    await markPage(space, a.label);
    // B's clean load goes to a URL that never answers.
    await flagWritten(space, b.label, { before: site("/hang"), agentSet: b.url });
    await markPage(space, b.label);
    await flagWritten(space, c.label);
    // Long enough for A's load while test-all runs every suite at once.
    await h.chrome(`ctx.service.quietLoadTimeoutMs = 5000; return true;`);
    // The sidebar's note: the in-process pagesReloaded, kept on the window
    // (evalChrome's calls share no globals).
    await h.chrome(
      `win.__zrReloaded = [];
       win.__zrReloadedOff = ctx.service.addEventListener((event, params) => {
         if (event === "pagesReloaded" && params.space === arg) win.__zrReloaded.push(params);
       });
       return true;`,
      space
    );
    await h.call("spaces.finish", { space, keep: [a.label, b.label, c.label] });
    const finishedAt = Date.now();
    const byId = `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
      const t = [...W.allTabs()].find(t => t.linkedBrowser.browserId === arg.id);
      const bc = t.linkedBrowser.browsingContext;`;
    const state = id =>
      h.chrome(
        `${byId}
         const read = await ctx.content(bc, "dev#evalContent", { privileged: false, code: ${JSON.stringify(READ)} }).catch(e => "ERR " + e.message);
         return { inner: bc.currentWindowGlobal?.innerWindowId ?? 0, read, evidence: ChromeUtils.importESModule(${JSON.stringify(EV_URL)}).evidenceOf(t.linkedBrowser) };`,
        { id }
      );
    let sa = null;
    await h.until(async () => (sa = await state(a.id)).inner !== a.inner && /\|t$/.test(sa.read), 10000).catch(() => {});
    assert.notEqual(sa.inner, a.inner, `the hooked page loaded afresh (${JSON.stringify(sa)}, ${await quietNote()})`);
    assert.equal(sa.read, "typed,orig,,true,b,area|t", await quietNote());
    assert.deepEqual(sa.evidence, {});
    await new Promise(r => setTimeout(r, Math.max(0, finishedAt + 6500 - Date.now())));
    const sb = await state(b.id);
    assert.equal(sb.inner, b.inner, "no new document came");
    assert.ok(sb.evidence.hooked, "so it stays hooked");
    const sc = await state(c.id);
    assert.equal(sc.inner, c.inner, "written is no evidence: no load");
    assert.match(sc.read, /^typed,planted,secret,true,b,area\|/);
    // Once B's load gave up: one note, naming the page that loaded afresh
    // (A) by its label and its address, and neither B nor C.
    let notes = [];
    await h.until(async () => (notes = await h.chrome(`return win.__zrReloaded;`)).length > 0, 5000).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    notes = await h.chrome(`return win.__zrReloaded;`);
    assert.deepEqual(notes, [{ space, pages: [{ page: a.label, url: a.url }] }]);
  } finally {
    await h.chrome(`win.__zrReloadedOff?.(); delete win.__zrReloadedOff; delete win.__zrReloaded; return true;`).catch(() => {});
    await h.chrome(`delete ctx.service.quietLoadTimeoutMs; return true;`).catch(() => {});
    await h
      .chrome(
        `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
         for (const t of [...W.allTabs()].filter(t => arg.includes(t.linkedBrowser.browserId))) t.ownerGlobal.gBrowser.removeTab(t);
         return true;`,
        ids.map(p => p.id)
      )
      .catch(() => {});
    await cleanUp(space);
  }
});

// Gecko lowers a process whose tabs are all background tabs at once, and on a
// busy Mac a background process can wait seconds for the CPU: a kept page's
// form record then missed its limit, and the typing wasn't carried over. On
// Linux a content process's priority shows in its oom_score_adj.
test(
  "landing (2): at the task's end, a kept page's process keeps a shown tab's priority from the finish through its clean load, and drops only after",
  { skip: process.platform !== "linux" && "the process priority is read from /proc" },
  async () => {
    const space = await h.space("ho prio");
    let id = null;
    try {
      const { label } = await h.call("pages.new", { space, url: site("/form?ho=prio") });
      await loaded(space, label, "ho=prio");
      await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
      const before = await info(space, label);
      const tab = await h.chrome(`${BROWSER} return { id: b.browserId, pid: b.frameLoader.remoteTab.osPid };`, { space, label });
      id = tab.id;
      await markPage(space, label);
      const priority = () => {
        try {
          return Number(readFileSync(`/proc/${tab.pid}/oom_score_adj`, "utf8"));
        } catch {
          return null;
        }
      };
      // The agent's page is kept alive, so its process is up as a shown tab's.
      const shown = priority();
      assert.equal(typeof shown, "number", `no priority for process ${tab.pid}`);
      const state = () =>
        h.chrome(
          `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
           const t = [...W.allTabs()].find(t => t.linkedBrowser.browserId === arg);
           const bc = t.linkedBrowser.browsingContext;
           const read = await ctx.content(bc, "dev#evalContent", { privileged: false, code: ${JSON.stringify(READ)} }).catch(e => "ERR " + e.message);
           return { inner: bc.currentWindowGlobal?.innerWindowId ?? 0, pid: t.linkedBrowser.frameLoader?.remoteTab?.osPid ?? 0, read };`,
          id
        );
      // Every 2 ms, from just before the finish until the fresh document has
      // the form back.
      const samples = [];
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          samples.push(priority());
          await new Promise(resolve => setTimeout(resolve, 2));
        }
      })();
      let now = null;
      try {
        await h.call("spaces.finish", { space, keep: [label] });
        await h.until(async () => (now = await state()).inner !== before.inner && /\|t$/.test(now.read), 10000).catch(() => {});
      } finally {
        sampling = false;
        await sampler;
      }
      assert.notEqual(now.inner, before.inner, `the page loaded afresh (${JSON.stringify(now)}, ${await quietNote()})`);
      assert.equal(now.read, "typed,orig,,true,b,area|t", await quietNote());
      assert.equal(now.pid, tab.pid, "the fresh document came in the page's process");
      assert.deepEqual([...new Set(samples)], [shown], `${samples.length} samples from the finish to the form's return`);
      // Then it is the user's background tab, and drops as any does.
      let after = shown;
      await h.until(async () => (after = priority()) !== shown, 5000).catch(() => {});
      assert.ok(after > shown, `after the clean load: ${after}; while kept alive: ${shown}`);
    } finally {
      if (id !== null) {
        await h
          .chrome(
            `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
             for (const t of [...W.allTabs()].filter(t => t.linkedBrowser.browserId === arg)) t.ownerDocument.defaultView.gBrowser.removeTab(t);
             return true;`,
            id
          )
          .catch(() => {});
      }
      await cleanUp(space);
    }
  }
);

test("landing (2): onKeptRefused and onOpenRefused say evident, with the page's evidence, when it has what a clean copy clears (hooked or made), and never written", async () => {
  const space = await h.space("ho flags");
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=flags") });
    await loaded(space, label, "ho=flags");
    const got = await h.chrome(
      `${BROWSER}
       const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
       const AW = ChromeUtils.importESModule(${JSON.stringify(AW_URL)});
       // A stand-in with the page's browsing context, so no listener's UI shows for it.
       const page = { browsingContext: b.browsingContext, browserId: b.browserId };
       const got = [];
       const EV = ChromeUtils.importESModule(${JSON.stringify(EV_URL)});
       const say = i => JSON.stringify([i.evident, i.evidence, "written" in i]);
       const offKept = W.onKeptRefused(i => i.browser === page && got.push("kept " + say(i)));
       const offOpen = W.onOpenRefused(i => i.browser === page && got.push("open " + say(i)));
       const both = () => {
         W.noteKeptRefused({ browser: page, kind: "deviceAccess", api: "", asked: "" });
         W.noteOpenRefused({ browser: page, url: "", reopened: false });
       };
       try {
         both();
         AW.noteWritten(b.browsingContext, [b.browsingContext.currentWindowGlobal.innerWindowId]);
         both();
         EV.markEvident(b, "listed", "phishing: test-list");
         both();
         EV.markEvident(b, "hooked", "a form");
         both();
       } finally {
         offKept();
         offOpen();
       }
       return got;`,
      { space, label }
    );
    // Without hooked or made, both are left out, so the UI reads the page.
    const none = JSON.stringify([null, null, false]);
    const yes = JSON.stringify([true, { hooked: "a form", listed: "phishing: test-list" }, false]);
    assert.deepEqual(got, [
      `kept ${none}`, `open ${none}`,
      `kept ${none}`, `open ${none}`,
      `kept ${none}`, `open ${none}`,
      `kept ${yes}`, `open ${yes}`,
    ]);
  } finally {
    await cleanUp(space);
  }
});

test("landing (2): finish({keep}) sends the discard to every tab of the task, the kept page too, while it is still the task's", async () => {
  const space = await h.space("ho kept discard");
  let keptId = null;
  try {
    const { label: kept } = await h.call("pages.new", { space, url: site("/form?ho=kd-kept") });
    const { label: gone } = await h.call("pages.new", { space, url: site("/form?ho=kd-gone") });
    await loaded(space, kept, "ho=kd-kept");
    await loaded(space, gone, "ho=kd-gone");
    keptId = await h.chrome(`${BROWSER} return b.browserId;`, { space, label: kept });
    await h.chrome(
      `const spy = ctx.service.discardAgentCode;
       ctx.service.hoKeptSpy = spy;
       ctx.service.hoKept = [];
       ctx.service.discardAgentCode = function (target) {
         if (target?.browserId !== undefined) {
           const listed = Services.ppmm.sharedData.get("zenius:taskSpaces")?.has(target.browserId) ?? false;
           ctx.service.hoKept.push({ id: target.browserId, listed });
         }
         return spy.call(this, target);
       };
       return true;`
    );
    await h.call("spaces.finish", { space, keep: [kept] });
    const seen = await h.chrome(`return ctx.service.hoKept;`);
    assert.deepEqual(seen.filter(s => s.id === keptId), [{ id: keptId, listed: true }], JSON.stringify(seen));
  } finally {
    await h
      .chrome(
        `if (ctx.service.hoKeptSpy) ctx.service.discardAgentCode = ctx.service.hoKeptSpy;
         delete ctx.service.hoKeptSpy;
         delete ctx.service.hoKept;
         const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
         for (const t of [...W.allTabs()].filter(t => t.linkedBrowser.browserId === arg)) t.ownerGlobal.gBrowser.removeTab(t);
         return true;`,
        keptId
      )
      .catch(() => {});
    await cleanUp(space);
  }
});

/** The user's Resume as the UI's button does it: the hand back's step before the agent runs (beforeHandBack), then the agent has the task. */
const resumeByUser = space =>
  h.chrome(
    `const s = ctx.spaces.get(arg);
     await ctx.service.beforeHandBack(s);
     ctx.spaces.setOwnership(s, "agent", { source: "user" });
     return true;`,
    space
  );
/** A load the user makes in the held tab, as their click on Create would. */
const userLoads = (space, label, url) =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     const b = ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser;
     b.loadURI(Services.io.newURI(arg.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
     return true;`,
    { space, label, url }
  );

test("a hand-off with secret: spaceChanged says secret, and at the user's Resume the tab shows about:blank with no history before the agent has control; the hand back says blanked", async () => {
  const space = await h.space("ho secret");
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=s1") });
    await loaded(space, label, "ho=s1");
    await assert.rejects(h.call("spaces.handOff", { space, secret: "yes" }), e => e.code === "ZEN_INVALID_ARGUMENT");
    await listen();
    await h.call("spaces.handOff", { space, secret: true });
    const [event] = await heard();
    assert.equal(event.secret, true);
    // The user's step: Create shows the new token on a page of its own.
    await userLoads(space, label, site("/form?ho=s1-token"));
    await loaded(space, label, "ho=s1-token");
    assert.ok((await info(space, label)).history >= 2);
    await resumeByUser(space);
    const now = await info(space, label);
    assert.equal(now.url, "about:blank");
    assert.equal(now.history, 1, "no entry to go back to, and so nothing in the back-forward cache");
    const back = await h.call("spaces.waitForControl", { space, timeout: 5000 });
    assert.deepEqual(back.blanked, [label]);
    // A hand-off without secret leaves the tab as it is at the next hand back.
    await h.call("page.goto", { space, page: label, url: site("/form?ho=s1-again") });
    await loaded(space, label, "ho=s1-again");
    await h.call("spaces.handOff", { space });
    await resumeByUser(space);
    assert.equal((await info(space, label)).url, site("/form?ho=s1-again"));
    assert.equal((await h.call("spaces.waitForControl", { space, timeout: 5000 })).blanked, undefined);
  } finally {
    await cleanUp(space);
  }
});

/** A tab's state by browserId, a page or not: gone, or its URL, history length, session value, page and whether its close waits. */
const tabState = id =>
  h.chrome(
    `const top = BrowsingContext.getCurrentTopByBrowserId(arg);
     const b = top?.embedderElement;
     const win = b?.ownerDocument?.defaultView;
     const tab = win?.gBrowser?.getTabForBrowser?.(b);
     if (!tab || tab.closing) return { gone: true };
     let value = null;
     try { value = win.SessionStore.getCustomTabValue(tab, "zenius") || null; } catch {}
     return { gone: false, url: b.currentURI.spec, history: top.sessionHistory?.count ?? 0, value, page: ctx.pages.forTab(tab)?.label ?? null, waits: ctx.pages.isDeferred(tab) };`,
    id
  );
/** The page's browserId and tab id, which outlast its label. */
const idsOf = (space, label) =>
  h.chrome(
    `const tab = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), arg.label));
     return { browserId: tab.linkedBrowser.browsingContext.browserId, tab: ctx.pages.tabId(tab) };`,
    { space, label }
  );
/** Close a tab that's no task's any more, by browserId, with no leave prompt. */
const closeTheirs = id =>
  h.chrome(
    `const b = BrowsingContext.getCurrentTopByBrowserId(arg)?.embedderElement;
     const g = b?.ownerDocument?.defaultView?.gBrowser;
     const tab = g?.getTabForBrowser?.(b);
     if (tab && !tab.closing) g.removeTab(tab, { skipPermitUnload: true, animate: false });
     return true;`,
    id
  );
/** The pageClosed events from now on, and those heard. */
const hearCloses = () =>
  h.chrome(
    `ctx.service.hoCloses = [];
     ctx.service.hoClosesOff?.();
     ctx.service.hoClosesOff = ctx.service.addEventListener((e, p) => e === "pageClosed" && ctx.service.hoCloses.push(p));
     return true;`
  );
const closesHeard = () => h.chrome(`return ctx.service.hoCloses ?? [];`);
const forgetCloses = () =>
  h.chrome(
    `ctx.service.hoClosesOff?.(); delete ctx.service.hoClosesOff; delete ctx.service.hoCloses;
     delete ctx.service.blankTimeoutMs; delete ctx.pages.closeTab;
     Services.prefs.clearUserPref("dom.max_script_run_time");
     return true;`
  );
/** The page's beforeunload listeners, as Gecko lists them. */
const leaveListeners = (space, label) =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     const tab = ctx.pages.tabFor(ctx.pages.get(s, arg.label));
     return ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", { privileged: true, code: "const els = Components.classes['@mozilla.org/eventlistenerservice;1'].getService(Components.interfaces.nsIEventListenerService); return els.getListenerInfoFor(window).filter(l => l.type === 'beforeunload').length;" });`,
    { space, label }
  );
/**
 * The page's own code keeps its process busy for BUSY_MS from its next
 * task, so a load zenius starts meanwhile waits that long: longer than any
 * blank waits (10 s), so the blank fails with or without the test's
 * shorter wait.
 * Gecko's slow-script warning stays off meanwhile (until forgetCloses).
 */
const BUSY_MS = 12000;
const busy = async (space, label) => {
  await h.chrome(`Services.prefs.setIntPref("dom.max_script_run_time", 0); return true;`);
  return inPage(space, label, `setTimeout(() => { const end = Date.now() + ${BUSY_MS}; while (Date.now() < end); }, 0); return 1;`);
};

test("a hand-off with secret: no leave prompt holds the blank, though the page has a beforeunload handler and the user's activation", async () => {
  const space = await h.space("ho secret prompt");
  let label = null;
  try {
    ({ label } = await h.call("pages.new", { space, url: site("/form?ho=s3") }));
    await loaded(space, label, "ho=s3");
    await h.call("spaces.handOff", { space, secret: true });
    // The user's step shows the secret in place, on a page that asks before
    // it's left once the user has used it.
    await inPage(space, label, LEAVE_HANDLER);
    assert.equal(await activate(space, label), true);
    await resumeByUser(space);
    const now = await info(space, label);
    assert.equal(now.url, "about:blank", "the blank came: no leave prompt held it");
    assert.equal(now.history, 1);
    assert.deepEqual((await h.call("spaces.waitForControl", { space, timeout: 5000 })).blanked, [label]);
  } finally {
    if (label) {
      await inPage(space, label, "window.onbeforeunload = null; return 1;").catch(() => {});
    }
    await cleanUp(space);
  }
});

test("a hand-off with secret: a beforeunload listener the agent's code left in the page can't hold the blank either", async t => {
  const space = await h.space("ho secret agent listener");
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=s4") });
    await loaded(space, label, "ho=s4");
    const own = await leaveListeners(space, label);
    // The agent's code adds a listener that would keep the page: a function
    // of its own world. addEventListener counts as safe, so the page isn't
    // hooked, and the hand-off doesn't load it afresh. (Its world has no
    // wrappedJSObject, so it can't make one of the page's own realm.)
    const added = await h
      .call("page.evaluate", {
        space,
        page: label,
        isFunction: false,
        fn: `(() => { addEventListener("beforeunload", e => { e.preventDefault(); e.returnValue = "stay"; }); return "added"; })()`,
      })
      .catch(e => `refused: ${e.code} ${e.message}`);
    const evidence = await h.chrome(
      `const s = ctx.spaces.get(arg.space);
       const b = ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser;
       return ChromeUtils.importESModule(arg.url).evidenceOf(b);`,
      { space, label, url: EV_URL }
    );
    await h.call("spaces.handOff", { space, secret: true });
    const lasting = (await leaveListeners(space, label)) - own;
    t.diagnostic(`probe: the agent's listener ${added}; the page's evidence ${JSON.stringify(evidence)}; after the hand-off, ${lasting} beforeunload listener(s) beyond the page's own`);
    assert.equal(await activate(space, label), true);
    await resumeByUser(space);
    const now = await info(space, label);
    assert.equal(now.url, "about:blank", "the blank came: no leave prompt held it");
    assert.equal(now.history, 1);
    assert.deepEqual((await h.call("spaces.waitForControl", { space, timeout: 5000 })).blanked, [label]);
  } finally {
    await cleanUp(space);
  }
});

test("a hand-off with secret: a tab whose blank doesn't come in time leaves the task for good and closes, and the hand back doesn't say blanked", async () => {
  const space = await h.space("ho secret slow");
  let ids = null;
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=s5") });
    await loaded(space, label, "ho=s5");
    ids = await idsOf(space, label);
    await h.call("spaces.handOff", { space, secret: true });
    await userLoads(space, label, site("/form?ho=s5-token"));
    await loaded(space, label, "ho=s5-token");
    await h.chrome(`ctx.service.blankTimeoutMs = 1000; return true;`);
    await hearCloses();
    // The token's page is busy when the blank comes: it comes after the wait.
    await busy(space, label);
    await resumeByUser(space);
    const back = await h.call("spaces.waitForControl", { space, timeout: 5000 });
    assert.equal(back.blanked, undefined, "a page that didn't blank isn't named");
    assert.deepEqual((await closesHeard()).map(p => p.page), [label], "its page ended for the agent");
    assert.ok(!(await h.chrome(`return ctx.pages.list(arg).map(p => p.label);`, space)).includes(label));
    assert.ok(!(await h.call("tabs.list", { space })).some(t => t.tab === ids.tab), "nor is its tab the task's");
    const state = await tabState(ids.browserId);
    assert.ok(state.gone || state.waits, `it closed, or closes once the user leaves it: ${JSON.stringify(state)}`);
  } finally {
    await forgetCloses().catch(() => {});
    if (ids) {
      await closeTheirs(ids.browserId).catch(() => {});
    }
    await cleanUp(space);
  }
});

test("a hand-off with secret: a tab that won't blank or close stays the user's, out of the task for good, and its history goes once the blank lands", async () => {
  const space = await h.space("ho secret stuck");
  let ids = null;
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=s6") });
    await loaded(space, label, "ho=s6");
    ids = await idsOf(space, label);
    await h.call("spaces.handOff", { space, secret: true });
    await userLoads(space, label, site("/form?ho=s6-token"));
    await loaded(space, label, "ho=s6-token");
    // The close fails too.
    await h.chrome(`ctx.service.blankTimeoutMs = 1000; ctx.pages.closeTab = () => { throw new Error("the test's close fails"); }; return true;`);
    await busy(space, label);
    await resumeByUser(space);
    const back = await h.call("spaces.waitForControl", { space, timeout: 5000 });
    assert.equal(back.blanked, undefined, "a page that didn't blank isn't named");
    assert.ok(!(await h.chrome(`return ctx.pages.list(arg).map(p => p.label);`, space)).includes(label));
    assert.ok(!(await h.call("tabs.list", { space })).some(t => t.tab === ids.tab), "nor is its tab the task's");
    await assert.rejects(h.call("pages.adopt", { space, tab: ids.tab }), e => e.code === "ZEN_PAGE_NOT_FOUND");
    const kept = await tabState(ids.browserId);
    assert.equal(kept.gone, false, "the tab is still there, the user's");
    assert.equal(kept.value, null, "with no task's value for a restart to find");
    assert.equal(kept.page, null);
    // The blank lands once the page lets go, late, and the history goes then.
    await h.until(async () => {
      const now = await tabState(ids.browserId);
      return now.url === "about:blank" && now.history === 1;
    }, BUSY_MS + 5000);
  } finally {
    await forgetCloses().catch(() => {});
    if (ids) {
      await closeTheirs(ids.browserId).catch(() => {});
    }
    await cleanUp(space);
  }
});

test("a hand-off with secret: a second hand back while the first one blanks waits for it: the agent's takeOver during the user's Resume", async () => {
  const space = await h.space("ho secret race");
  let ids = null;
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=s7") });
    await loaded(space, label, "ho=s7");
    ids = await idsOf(space, label);
    await h.call("spaces.handOff", { space, secret: true });
    await userLoads(space, label, site("/form?ho=s7-token"));
    await loaded(space, label, "ho=s7-token");
    await h.chrome(`ctx.service.blankTimeoutMs = 1000; return true;`);
    // The blank takes seconds: the page is busy when it comes.
    await busy(space, label);
    const resumed = resumeByUser(space).then(
      () => null,
      e => e
    );
    await sleep(300);
    const back = await h.call("spaces.takeOver", { space });
    assert.ok(
      !(await h.chrome(`return ctx.pages.list(arg).map(p => p.label);`, space)).includes(label),
      "the agent has control only once the tab that didn't blank is out of the task"
    );
    assert.equal(back.blanked, undefined);
    await resumed;
  } finally {
    await forgetCloses().catch(() => {});
    if (ids) {
      await closeTheirs(ids.browserId).catch(() => {});
    }
    await cleanUp(space);
  }
});

/** A tab by its tab id, as its live copy: gone, or its URL, history, browserId and whether its task holds it. */
const tabById = (space, tab) =>
  h.chrome(
    `const { uniqueTabs } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     const t = [...uniqueTabs()].find(x => !x.closing && ctx.pages.tabId(x) === arg.tab);
     if (!t) return { gone: true };
     const bc = t.linkedBrowser.browsingContext;
     return { gone: false, url: t.linkedBrowser.currentURI.spec, history: bc?.sessionHistory?.count ?? 0, browserId: bc?.browserId ?? 0,
       inTask: ctx.pages.tabsOf(ctx.spaces.get(arg.space)).some(x => ctx.pages.tabId(x) === arg.tab) };`,
    { space, tab }
  );

test("a hand-off with secret: the tabs the user's step opens blank at the hand back too, its popup and one opened with no opener", async () => {
  const space = await h.space("ho secret opened");
  let mid = null;
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=s8") });
    await loaded(space, label, "ho=s8");
    await h.call("spaces.handOff", { space, secret: true });
    await userLoads(space, label, site("/form?ho=s8-token"));
    await loaded(space, label, "ho=s8-token");
    // The site's sign-in popup, which joins the hold.
    assert.equal(await inPage(space, label, `return String(!!window.open(${JSON.stringify(site("/form?ho=s8-pop"))}));`), "true");
    const pop = await pageOf(space, "ho=s8-pop");
    await loaded(space, pop, "ho=s8-pop");
    // The user's middle click there: a tab with no opener, the task's, which never joins the hold.
    const midTab = await h.chrome(
      `const b = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), arg.label)).linkedBrowser;
       const tab = b.ownerDocument.defaultView.gBrowser.addTab(arg.url, { openerBrowser: b, inBackground: true, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       return ctx.pages.tabId(tab);`,
      { space, label, url: site("/form?ho=s8-mid") }
    );
    await h.until(async () => !!(mid = await tabById(space, midTab)).url?.includes("ho=s8-mid"), 10000);
    assert.equal(mid.inTask, true, "the tab the user opened is the task's");
    await resumeByUser(space);
    for (const page of [label, pop]) {
      const now = await info(space, page);
      assert.deepEqual([now.url, now.history], ["about:blank", 1], `${page}: blank, with no history`);
    }
    mid = await tabById(space, midTab);
    assert.ok(mid.gone || !mid.inTask || (mid.url === "about:blank" && mid.history === 1), `the tab opened with no opener: ${JSON.stringify(mid)}`);
    assert.deepEqual([...((await h.call("spaces.waitForControl", { space, timeout: 5000 })).blanked ?? [])].sort(), [label, pop].sort());
  } finally {
    if (mid?.browserId) {
      await closeTheirs(mid.browserId).catch(() => {});
    }
    await cleanUp(space);
  }
});

test("a hand-off with secret: spaces.list gives the step's tab no title while the user holds it", async () => {
  const space = await h.space("ho secret title");
  // The task's one page, so spaces.list has one title.
  const label = "p1";
  try {
    await h.call("page.goto", { space, page: label, url: site("/form?ho=s9") });
    await loaded(space, label, "ho=s9");
    await h.call("spaces.handOff", { space, secret: true });
    await userLoads(space, label, site("/form?ho=s9-secret-title"));
    await loaded(space, label, "ho=s9-secret-title");
    // The strip shows the page's title.
    await h.until(
      async () => (await h.chrome(`return ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), arg.label)).label;`, { space, label })) === "s9-secret-title",
      5000
    );
    const titles = (await h.call("spaces.list")).taskSpaces.find(s => s.id === space).recentTabTitles;
    assert.deepEqual(titles, [""], "no title of the step's page");
  } finally {
    await cleanUp(space);
  }
});

test("a hand-off with secret: after the hand back, the HTTP cache gives back nothing of what the step showed, in its tab or in a popup that closed itself", async () => {
  const space = await h.space("ho secret cache");
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=s10") });
    await loaded(space, label, "ho=s10");
    // Another of the task's pages on the same site, where the agent fetches later.
    const { label: fetcher } = await h.call("pages.new", { space, url: site("/form?ho=s10-other") });
    await loaded(space, fetcher, "ho=s10-other");
    await front(space, label);
    await h.call("spaces.handOff", { space, secret: true });
    const marker = `marker-${Date.now()}`;
    const shown = site(`/cached?m=${marker}`);
    await userLoads(space, label, shown);
    await loaded(space, label, "/cached");
    // A sign-in popup on another site, which closes itself before the hand back.
    const popped = other(`/cached?m=${marker}-pop`);
    assert.equal(await inPage(space, label, `return String(!!window.open(${JSON.stringify(popped)}));`), "true");
    const pop = await pageOf(space, `m=${marker}-pop`);
    await loaded(space, pop, "/cached");
    await inPage(space, pop, "setTimeout(() => window.close(), 50); return 1;");
    // In chrome: pages.list is a read, which the hold refuses.
    await h.until(async () => !(await h.chrome(`return ctx.pages.list(arg.space).some(p => p.label === arg.pop);`, { space, pop })), 10000);
    await resumeByUser(space);
    // Only what the cache kept could answer: no request goes out.
    const cached = url =>
      h.call("page.fetch", { space, page: fetcher, url, options: { cache: "only-if-cached", mode: "same-origin" } }).then(
        r => r,
        e => ({ failed: e.code })
      );
    const fetched = await cached(shown);
    assert.ok(fetched.failed || !String(fetched.body ?? "").includes(marker), `the cache gave the step's page back: ${JSON.stringify(fetched).slice(0, 300)}`);
    // The popup's site, from a page of the task there.
    await h.call("page.goto", { space, page: fetcher, url: other("/form?ho=s10-local") });
    const fromPopup = await cached(popped);
    assert.ok(fromPopup.failed || !String(fromPopup.body ?? "").includes(`${marker}-pop`), `the cache gave the closed popup's page back: ${JSON.stringify(fromPopup).slice(0, 300)}`);
  } finally {
    await cleanUp(space);
  }
});

test("a hand-off with secret: while the user holds the step, another task's page can't read what it loaded from the HTTP cache", async () => {
  const space = await h.space("ho secret hold cache");
  const another = await h.space("ho secret hold cache other");
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=s11") });
    await loaded(space, label, "ho=s11");
    // Another task's page on the same site: the agent still drives it during the hold.
    const { label: fetcher } = await h.call("pages.new", { space: another, url: site("/form?ho=s11-other") });
    await loaded(another, fetcher, "ho=s11-other");
    await h.call("spaces.handOff", { space, secret: true });
    const marker = `marker-${Date.now()}`;
    const shown = site(`/cached?m=${marker}`);
    await userLoads(space, label, shown);
    await loaded(space, label, "/cached");
    // Only what the cache kept could answer: no request goes out.
    const fetched = await h.call("page.fetch", { space: another, page: fetcher, url: shown, options: { cache: "only-if-cached", mode: "same-origin" } }).then(
      r => r,
      e => ({ failed: e.code })
    );
    assert.ok(fetched.failed || !String(fetched.body ?? "").includes(marker), `the cache gave the held step's page to another task: ${JSON.stringify(fetched).slice(0, 300)}`);
  } finally {
    await cleanUp(space);
    await h.call("spaces.finish", { space: another, keep: [] }).catch(() => {});
  }
});

test("a hand-off with secret: the agent's own takeOver blanks the tab first too, and so does the hand back after a Take over the user made before the agent's hand-off", async () => {
  const space = await h.space("ho secret take");
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=s2") });
    await loaded(space, label, "ho=s2");
    await h.call("spaces.handOff", { space, secret: true });
    await userLoads(space, label, site("/form?ho=s2-token"));
    await loaded(space, label, "ho=s2-token");
    const back = await h.call("spaces.takeOver", { space });
    assert.deepEqual(back.blanked, [label]);
    assert.equal((await info(space, label)).url, "about:blank");
    await h.call("page.goto", { space, page: label, url: site("/form?ho=s2-b") });
    await loaded(space, label, "ho=s2-b");
    await userTakeOver(space, label);
    await h.call("spaces.handOff", { space, secret: true });
    await resumeByUser(space);
    assert.equal((await info(space, label)).url, "about:blank");
  } finally {
    await cleanUp(space);
  }
});
