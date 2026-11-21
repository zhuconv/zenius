// The hand-off (the manager's rule of 2026-11-20): before the user holds a
// page, zenius makes it safe for their typing. zen-core's parts: the quiet
// load (a new GET entry, the form and the focus carried over), the remedy
// handOffCheck's answer picks (in place, or into a group of its own), the
// hold's refusals of the agent's code and of new windows, the discard of the
// agent's sandboxes (the user's decision (A)), and what the hand back tells
// the agent. zen-observe's guards (tests/observe) cover the rest.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

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
  for (const res of server.hanging) {
    res.destroy();
  }
  http1.close();
  http2.close();
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
/** The page's document, history length, group, and whether zen-observe holds it. */
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

/** The group switch waits on the user's decision about the isolated world: off unless a test turns it on. */
const groupSwitch = on =>
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

test("a hand-off loads afresh a page where the agent's code ran: its visible fields and focus come back, not the agent's hidden value or a secret", async () => {
  const space = await h.space("ho reload");
  await freshDiscards();
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=1") });
    await loaded(space, label, "ho=1");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
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
    const events = await heard();
    assert.equal(events.length, 1);
    assert.equal(events[0].ownership, "agentDelegatedToUser");
    assert.equal(events[0].reloaded, "reload");
    assert.equal(events[0].carried, true);
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

test("with the group switch paused (the default), a held popup on the agent's site keeps its group and opener: the agent's window there loads afresh in place", async () => {
  const space = await h.space("ho paused");
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=4T") });
    await loaded(space, T, "ho=4T");
    await h.call("page.evaluate", { space, page: T, isFunction: false, fn: `(window.__p = window.open(${JSON.stringify(site("/form?ho=4P"))}), 1)` });
    const P = await pageOf(space, "ho=4P");
    await loaded(space, P, "ho=4P");
    await front(space, P);
    const tBefore = (await info(space, T)).inner;
    const reply = await h.call("spaces.handOff", { space });
    assert.deepEqual([...reply.reloaded].sort(), [P, T].sort());
    assert.notEqual((await info(space, T)).inner, tBefore, "T loaded afresh, and its handle with it");
    assert.equal((await info(space, P)).tops, 2, "P keeps its group");
    assert.equal(await inPage(space, P, "return String(window.opener !== null);"), "true");
    await resume(space);
    const back = await h.call("spaces.waitForControl", { space, timeout: 5000 });
    assert.equal(back.openerCut, undefined);
  } finally {
    await cleanUp(space);
  }
});

test("with the group switch on, a popup on the agent's site goes into a group of its own: handles to it close, its own popups join it, and the hand back says openerCut", async () => {
  const space = await h.space("ho group");
  await groupSwitch(true);
  const off = await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     ctx.service.hoRefused = [];
     ctx.service.hoRefusedOff = W.onOpenRefused(info => ctx.service.hoRefused.push(!!info.hold));
     return true;`
  );
  assert.ok(off);
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=5T") });
    await loaded(space, T, "ho=5T");
    await h.call("page.evaluate", { space, page: T, isFunction: false, fn: `(window.__p = window.open(${JSON.stringify(site("/form?ho=5P"))}), 1)` });
    const P = await pageOf(space, "ho=5P");
    await loaded(space, P, "ho=5P");
    await front(space, P);
    assert.equal((await info(space, P)).tops, 2);
    const reply = await h.call("spaces.handOff", { space });
    assert.deepEqual(reply.reloaded, [P]);
    const now = await info(space, P);
    assert.equal(now.tops, 1, "alone in its group");
    // The agent's handle lived in its world, which the hand-off ended (zen-observe's glue).
    assert.deepEqual(await worldOf(space, T), { none: true }, "the agent's world and its handle are gone");
    assert.equal(await inPage(space, P, "return String(window.opener);"), "null");
    // While the user holds P: T, where the agent's code ran, opens nothing,
    // with an opener or without; P's own popup joins the task.
    assert.equal(await inPage(space, T, `return String(window.open(${JSON.stringify(site("/form?ho=5x"))}));`), "null");
    assert.equal(await inPage(space, T, `return String(window.open(${JSON.stringify(site("/form?ho=5y"))}, "_blank", "noopener"));`), "null");
    assert.deepEqual(await h.chrome(`return ctx.service.hoRefused;`), [true, true]);
    assert.equal(await inPage(space, P, `return String(!!window.open(${JSON.stringify(site("/form?ho=5Q"))}));`), "true");
    const Q = await pageOf(space, "ho=5Q");
    assert.ok(Q);
    await resume(space);
    const back = await h.call("spaces.waitForControl", { space, timeout: 5000 });
    assert.equal(back.openerCut, true);
    assert.deepEqual(back.reloaded, [P]);
  } finally {
    await h.chrome(`ctx.service.hoRefusedOff?.(); delete ctx.service.hoRefusedOff; delete ctx.service.hoRefused; return true;`).catch(() => {});
    await groupSwitch(false).catch(() => {});
    await cleanUp(space);
  }
});

test("a held popup whose opener is on another site keeps it: the agent's window on the popup's site loads afresh in place, and during the hold the group runs no agent code", async () => {
  const space = await h.space("ho other");
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
    await h.call("page.evaluate", { space, page: R, isFunction: false, fn: "1" });
    await front(space, P);
    const rBefore = (await info(space, R)).inner;
    const reply = await h.call("spaces.handOff", { space });
    assert.ok(reply.reloaded.includes(R), `reloaded ${reply.reloaded}`);
    assert.notEqual((await info(space, R)).inner, rBefore, "R loaded afresh");
    assert.equal((await info(space, P)).tops, 3, "P keeps its group");
    assert.equal(await inPage(space, P, "return String(window.opener !== null);"), "true");
    // P kept its window (its opener, above); the agent's handle lived in its
    // world, which the hand-off ended (zen-observe's glue).
    assert.deepEqual(await worldOf(space, T), { none: true }, "the agent's world and its handle are gone");
    const refusal = label =>
      h.chrome(`const s = ctx.spaces.get(arg.space); return ctx.pages.codeRefusal(s, ctx.pages.get(s, arg.label));`, { space, label });
    assert.deepEqual(await refusal(T), { reason: "hold", windows: 1 });
    assert.deepEqual(await refusal(R), { reason: "hold", windows: 1 });
    await resume(space);
    await h.call("spaces.waitForControl", { space, timeout: 5000 });
    assert.equal(await refusal(T), null, "not kept: it ended with the hold");
  } finally {
    await cleanUp(space);
  }
});

test("with the group switch on, the held page's load onto a site where the agent's code ran leaves the group (a sign-in's callback), and the hand back says openerCut", async () => {
  const space = await h.space("ho callback");
  await groupSwitch(true);
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=7T") });
    await loaded(space, T, "ho=7T");
    await h.call("page.evaluate", { space, page: T, isFunction: false, fn: `(window.__p = window.open(${JSON.stringify(other("/form?ho=7P"))}), 1)` });
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
    // The agent's handle lived in its world, which the hand-off ended (zen-observe's glue).
    assert.deepEqual(await worldOf(space, T), { none: true }, "the agent's world and its handle are gone");
    await resume(space);
    const back = await h.call("spaces.waitForControl", { space, timeout: 5000 });
    assert.equal(back.openerCut, true);
  } finally {
    await groupSwitch(false).catch(() => {});
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
    await listen();
    const result = await h.chrome(
      `const s = ctx.spaces.get(arg.space);
       const r = await ctx.service.userTakeOver(s, ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser);
       return r;`,
      { space, label }
    );
    assert.deepEqual(
      result,
      { agentPage: false, how: "reload", reloaded: [label], carried: true, openerCut: false },
      `the quiet load: ${await quietNote()}`
    );
    assert.deepEqual(await discards(), [await taskOf(space)]);
    const [event] = await heard();
    assert.equal(event.source, "user");
    assert.equal(event.reloaded, "reload");
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
    await front(space, P);
    // With this Gecko pref a leave prompt shows without an activation too,
    // and in an agent tab zen-observe holds it for the agent: H's load
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
      assert.deepEqual(data.reloaded, [T], "T loaded afresh before H's load failed");
      assert.equal(data.offSite, undefined, "a load that didn't come isn't one that left the site");
      assert.match(e.message, /didn't load afresh.*task\.handOff\(\) again/);
      return true;
    });
    assert.equal(await h.ownership(space), "agent");
    assert.equal((await info(space, P)).held, false);
    assert.equal((await info(space, P)).inner, pBefore, "the old document is there, and the task is still the agent's");
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

/** The site's own router puts its open redirect in the URL (zen-snapshot's siteRouterRedirect): the page's own code, which the native hook doesn't see. */
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

test("the hold mutes the channels and shared workers the held page opened before it: neither it nor the task's other page hears the other, and its own code doesn't throw", async () => {
  const space = await h.space("ho mute");
  try {
    const { label: T } = await h.call("pages.new", { space, url: site("/form?ho=15T") });
    await loaded(space, T, "ho=15T");
    const { label: H } = await h.call("pages.new", { space, url: site("/form?ho=15H") });
    await loaded(space, H, "ho=15H");
    await inPage(space, T, LISTEN);
    await inPage(space, H, LISTEN);
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
    assert.equal(now.inner, before.inner, "a page where the agent's code never ran is held as it is");
    assert.equal(await say(space, T, "t2"), "ok");
    assert.equal(await say(space, H, "h2"), "ok", "the site's own code in the held page keeps working");
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(await heardIn(space, H), heardH, "the held page hears nothing of the task's page");
    assert.equal(await heardIn(space, T), heardT, "the task's page hears nothing of the held page");
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

// Landing (2): zenius's clean loads under the isolated world. zen-observe's
// world flags what the agent's code wrote, and the URL it set in place;
// these tests flag through its hook (observe/agentworld.sys.mjs noteWritten)
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

test("landing (2): the reload on demand loads a written page afresh, its form carried over and the focus on the field the user went for; a page that isn't written has nothing to clean", async () => {
  const space = await h.space("ho demand");
  try {
    const { label } = await h.call("pages.new", { space, url: site("/form?ho=demand") });
    await loaded(space, label, "ho=demand");
    await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
    const clean = () => h.chrome(`${BROWSER} return ctx.service.cleanOnDemand(b);`, { space, label });
    const before = await info(space, label);
    assert.deepEqual(await clean(), { how: null, carried: false, focused: false });
    assert.equal((await info(space, label)).inner, before.inner, "nothing loaded");
    // The world wrote into it, and the user's press went for the textarea
    // (zen-input's guard notes it before the focus moves).
    assert.equal((await flagWritten(space, label)).written, true);
    await h.chrome(
      `${BROWSER}
       return ctx.content(b.browsingContext, "dev#evalContent", { privileged: true, code: "ChromeUtils.importESModule('chrome://userscripts/content/zenius/content/forms.sys.mjs').noteUserTarget(content.document.forms[0].ta); return 1;" });`,
      { space, label }
    );
    assert.deepEqual(await clean(), { how: "reload", carried: true, focused: true, urlBefore: null }, await quietNote());
    assert.notEqual((await info(space, label)).inner, before.inner, "a new document");
    assert.match(await inPage(space, label, READ), /^typed,orig,,true,b,area\|ta$/, await quietNote());
    assert.equal(await h.chrome(`${BROWSER} return ChromeUtils.importESModule(${JSON.stringify(AW_URL)}).isWritten(b);`, { space, label }), false, "the fresh document is clean");
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
      assert.equal((await flagWritten(space, label)).written, true);
      const inner = (await info(space, label)).inner;
      assert.equal((await clean()).how, "reload", `clean copy ${n}`);
      assert.notEqual((await info(space, label)).inner, inner, `clean copy ${n}: a new document`);
    }
    assert.equal((await flagWritten(space, label)).written, true);
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

test("landing (2): at the task's end, a written page that stays open loads afresh with its form; one whose load brings no new document stays written", async () => {
  const space = await h.space("ho end");
  const ids = [];
  try {
    for (const part of ["enda", "endb"]) {
      const { label } = await h.call("pages.new", { space, url: site(`/form?ho=${part}`) });
      await loaded(space, label, `ho=${part}`);
      await h.call("page.evaluate", { space, page: label, isFunction: false, fn: FILL });
      ids.push({ label, ...(await info(space, label)), id: await h.chrome(`${BROWSER} return b.browserId;`, { space, label }) });
    }
    const [a, b] = ids;
    await flagWritten(space, a.label);
    // B's clean load goes to a URL that never answers.
    await flagWritten(space, b.label, { before: site("/hang"), agentSet: b.url });
    // Long enough for A's load while test-all runs every suite at once.
    await h.chrome(`ctx.service.quietLoadTimeoutMs = 5000; return true;`);
    await h.call("spaces.finish", { space, keep: [a.label, b.label] });
    const finishedAt = Date.now();
    const byId = `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
      const t = [...W.allTabs()].find(t => t.linkedBrowser.browserId === arg.id);
      const bc = t.linkedBrowser.browsingContext;`;
    const state = id =>
      h.chrome(
        `${byId}
         const read = await ctx.content(bc, "dev#evalContent", { privileged: false, code: ${JSON.stringify(READ)} }).catch(e => "ERR " + e.message);
         return { inner: bc.currentWindowGlobal?.innerWindowId ?? 0, read, written: ChromeUtils.importESModule(${JSON.stringify(AW_URL)}).isWritten(t.linkedBrowser) };`,
        { id }
      );
    let sa = null;
    await h.until(async () => (sa = await state(a.id)).inner !== a.inner && /\|t$/.test(sa.read), 10000).catch(() => {});
    assert.notEqual(sa.inner, a.inner, `the written page loaded afresh (${JSON.stringify(sa)}, ${await quietNote()})`);
    assert.equal(sa.read, "typed,orig,,true,b,area|t", await quietNote());
    assert.equal(sa.written, false);
    await new Promise(r => setTimeout(r, Math.max(0, finishedAt + 6500 - Date.now())));
    const sb = await state(b.id);
    assert.equal(sb.inner, b.inner, "no new document came");
    assert.equal(sb.written, true, "so it stays written");
  } finally {
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

test("landing (2): onKeptRefused and onOpenRefused say whether the page is written", async () => {
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
       const offKept = W.onKeptRefused(i => i.browser === page && got.push("kept " + i.written));
       const offOpen = W.onOpenRefused(i => i.browser === page && got.push("open " + i.written));
       try {
         W.noteKeptRefused({ browser: page, kind: "deviceAccess", api: "", asked: "" });
         W.noteOpenRefused({ browser: page, url: "", reopened: false });
         AW.noteWritten(b.browsingContext, [b.browsingContext.currentWindowGlobal.innerWindowId]);
         W.noteKeptRefused({ browser: page, kind: "deviceAccess", api: "", asked: "" });
         W.noteOpenRefused({ browser: page, url: "", reopened: false });
       } finally {
         offKept();
         offOpen();
       }
       return got;`,
      { space, label }
    );
    // Not written: left out, so zen-ux's own rule decides.
    assert.deepEqual(got, ["kept undefined", "open undefined", "kept true", "open true"]);
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
