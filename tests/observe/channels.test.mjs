// BroadcastChannel in a task's documents (content/refusals.sys.mjs
// guardBroadcastChannels; tests/snapshot/tools/channels-probe.mjs): a task
// shares the user's container, so a channel would join the user's open tabs
// on the site, both ways. In a task's documents a channel's name is scoped to
// the task: its pages, their frames and workers hear each other, and nothing
// of the user's tabs or of another task.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setup } from "./lib.mjs";

let env;
/** A page that opens its channel in its first script, as sites do. */
let early;
before(async () => {
  env = await setup();
  early = http.createServer((req, res) => {
    if (req.url.startsWith("/counter.js")) {
      // A shared worker that counts the pages connected to it.
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      return res.end("let n = 0; onconnect = e => { n++; e.ports[0].postMessage(n + ' ' + self.location.hash); };");
    }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(`<!doctype html><title>early</title><script>
      window.__early = [];
      window.__earlyCh = new BroadcastChannel("zo-early");
      window.__earlyCh.onmessage = e => window.__early.push(e.data);
    </script><p>early`);
  });
  await new Promise(r => early.listen(0, "127.0.0.1", r));
});
after(async () => {
  early?.close();
  await env?.close();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = v => JSON.stringify(v);
const ALL_TABS = `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const tabOf = mark => [...W.allTabs()].find(t => t.hasAttribute(mark));`;

/** A tab of the user's, in a Space of theirs, at `url`. */
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
  /** Run `code` as the page's own script; return what it leaves in window.__out. */
  run: (mark, code) =>
    env.chrome(
      `${ALL_TABS}
       const s = "const s = document.createElement('script'); s.textContent = " + JSON.stringify(arg.code) + "; document.documentElement.append(s); s.remove(); return JSON.stringify(window.__out ?? null);";
       return JSON.parse(await ctx.content(tabOf(arg.mark).linkedBrowser.browsingContext, "dev#evalContent", { privileged: false, code: s }));`,
      { mark, code }
    ),
  close: mark =>
    env.chrome(
      `${ALL_TABS}
       for (const t of [...W.allTabs()].filter(t => t.hasAttribute(arg))) t.ownerDocument.defaultView.gBrowser.removeTab(t);
       return true;`,
      mark
    ),
};

const LISTEN = `window.__got = []; window.__ch = new BroadcastChannel("zo-chan"); window.__ch.onmessage = e => window.__got.push(e.data); window.__out = window.__ch.name;`;
const post = text => `window.__ch.postMessage(${js(text)}); window.__out = true;`;
const GOT = `window.__out = window.__got;`;

test("a task's pages hear only each other on a BroadcastChannel: not the user's tab on the site, nor another task, both ways; frames and workers follow their page", async () => {
  const mark = `zo-chan-user-${Date.now()}`;
  const url = `${env.base}/nav-target`;
  const { id: other } = await env.call("spaces.create", { name: `zo channels other ${Date.now() % 100000}` });
  try {
    await userTab.open(url, mark);
    assert.equal(await userTab.run(mark, LISTEN), "zo-chan");
    await env.inSpace("channels", async page => {
      await page.goto(url);
      assert.equal(await page.evaluate(`${LISTEN} window.__out`), "zo-chan", "the page reads its own name");
      assert.equal(await page.evaluate("BroadcastChannel.prototype.constructor === BroadcastChannel"), true);
      // Its about:blank frame, and a dedicated worker it starts.
      await page.evaluate(`
        const f = document.createElement("iframe");
        document.body.append(f);
        window.__fgot = [];
        window.__fch = new f.contentWindow.BroadcastChannel("zo-chan");
        window.__fch.onmessage = e => window.__fgot.push(e.data);
        const src = "const c = new BroadcastChannel('zo-chan'); const got = []; c.onmessage = e => got.push(e.data);" +
          "onmessage = e => { if (e.data === 'post') c.postMessage('from-worker'); else postMessage(JSON.stringify({ got, name: c.name })); };";
        window.__w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
        1`);
      const worker = cmd =>
        page.evaluate(`new Promise(resolve => { window.__w.onmessage = e => resolve(JSON.parse(e.data)); window.__w.onerror = e => resolve({ error: e.message }); window.__w.postMessage(${js(cmd)}); setTimeout(() => resolve({ timeout: true }), 5000); })`);
      assert.equal((await worker("report")).name, "zo-chan", "the worker runs, and reads its own name");

      // A second page of the same task, and a page of another task, on the site.
      const { label: second } = await env.call("pages.new", { space: page.P.space, url });
      const T2 = { space: page.P.space, page: second };
      await env.call("page.evaluate", { ...T2, fn: LISTEN + " window.__out", isFunction: false });
      const { label: otherPage } = await env.call("pages.new", { space: other, url });
      const O = { space: other, page: otherPage };
      await env.call("page.evaluate", { ...O, fn: LISTEN + " window.__out", isFunction: false });

      await userTab.run(mark, post("from-user"));
      await page.evaluate(post("from-task"));
      await env.call("page.evaluate", { ...T2, fn: post("from-task-2"), isFunction: false });
      await worker("post");
      await env.call("page.evaluate", { ...O, fn: post("from-other-task"), isFunction: false });
      await sleep(600);

      const got = {
        user: await userTab.run(mark, GOT),
        task: await page.evaluate("window.__got"),
        frame: await page.evaluate("window.__fgot"),
        second: await env.call("page.evaluate", { ...T2, fn: "window.__got", isFunction: false }),
        worker: (await worker("report")).got,
        other: await env.call("page.evaluate", { ...O, fn: "window.__got", isFunction: false }),
      };
      const sorted = list => [...list].sort();
      assert.deepEqual(sorted(got.user), [], `the user's tab heard ${js(got.user)}`);
      assert.deepEqual(sorted(got.task), ["from-task-2", "from-worker"], js(got));
      assert.deepEqual(sorted(got.frame), ["from-task", "from-task-2", "from-worker"], js(got));
      assert.deepEqual(sorted(got.second), ["from-task", "from-worker"], js(got));
      assert.deepEqual(sorted(got.worker), ["from-task", "from-task-2"], js(got));
      assert.deepEqual(sorted(got.other), [], `another task heard ${js(got.other)}`);
    });
  } finally {
    await userTab.close(mark).catch(() => {});
    await env.call("spaces.finish", { space: other, keep: [] }).catch(() => {});
  }
});

test("after the task, a kept page where the agent's code ran still doesn't reach the user's tab, by its old channel or a new one", async () => {
  const mark = `zo-chan-user2-${Date.now()}`;
  const kept = `zo-chan-kept-${Date.now()}`;
  const url = `${env.base}/nav-target`;
  const { id: space } = await env.call("spaces.create", { name: `zo channels kept ${Date.now() % 100000}` });
  let finished = false;
  try {
    await userTab.open(url, mark);
    await userTab.run(mark, LISTEN);
    const P = { space, page: "p1" };
    await env.call("page.goto", { ...P, url });
    await env.call("page.evaluate", { ...P, fn: LISTEN + " 1", isFunction: false });
    await env.chrome(`ctx.resolvePage(arg.P).tab.setAttribute(arg.kept, "1"); return true;`, { P, kept });
    await env.call("spaces.finish", { space, keep: ["p1"] });
    finished = true;
    // The kept page's own script, as code the agent left there would run.
    await userTab.run(kept, `window.__ch.postMessage("from-kept-old"); const c = new BroadcastChannel("zo-chan"); c.postMessage("from-kept-new"); window.__out = c.name;`);
    await sleep(600);
    assert.deepEqual(await userTab.run(mark, GOT), [], "the user's tab heard the kept page");
  } finally {
    if (!finished) {
      await env.call("spaces.finish", { space, keep: [] }).catch(() => {});
    }
    await userTab.close(kept).catch(() => {});
    await userTab.close(mark).catch(() => {});
  }
});

test("a channel a page opens in its first script, as the task's new page loads, is already the task's", async () => {
  const mark = `zo-chan-user3-${Date.now()}`;
  const url = `http://127.0.0.1:${early.address().port}/early`;
  const { id: space } = await env.call("spaces.create", { name: `zo channels early ${Date.now() % 100000}` });
  try {
    await userTab.open(url, mark);
    const { label: one } = await env.call("pages.new", { space, url });
    const { label: two } = await env.call("pages.new", { space, url });
    // The page's own channel, from its first script: the page's JavaScript
    // posts and reads it, which the agent's isolated world can't see.
    const run = (page, code) => env.call("dev.evalContent", { space, page, code });
    await userTab.run(mark, `window.__earlyCh.postMessage("from-user"); window.__out = true;`);
    await run(two, `window.__earlyCh.postMessage("from-two"); 1`);
    await sleep(600);
    assert.deepEqual(await run(one, "window.__early"), ["from-two"]);
    assert.deepEqual(await userTab.run(mark, `window.__out = window.__early;`), []);
  } finally {
    await env.call("spaces.finish", { space, keep: [] }).catch(() => {});
    await userTab.close(mark).catch(() => {});
  }
});

test("a shared worker is its task's own: two pages of a task share one, a page of another task gets another (the snapshot layer's twoTasks)", async () => {
  const url = `http://127.0.0.1:${early.address().port}/early?shared`;
  const { id: a } = await env.call("spaces.create", { name: `zo shared a ${Date.now() % 100000}` });
  const { id: b } = await env.call("spaces.create", { name: `zo shared b ${Date.now() % 100000}` });
  try {
    const connect = (space, page) =>
      env.call("page.evaluate", {
        space,
        page,
        fn: `new Promise(resolve => { const w = new SharedWorker("/counter.js", "zo-count"); w.port.onmessage = e => resolve(e.data); w.port.start(); setTimeout(() => resolve("timeout"), 5000); })`,
        isFunction: false,
      });
    const { label: a1 } = await env.call("pages.new", { space: a, url });
    const { label: a2 } = await env.call("pages.new", { space: a, url });
    const { label: b1 } = await env.call("pages.new", { space: b, url });
    assert.match(await connect(a, a1), /^1 #zenius-task-\d+$/);
    assert.match(await connect(a, a2), /^2 #zenius-task-\d+$/, "the task's second page shares its worker");
    const other = await connect(b, b1);
    assert.match(other, /^1 #zenius-task-\d+$/, "another task's page gets a worker of its own");
    assert.notEqual(other.split(" ")[1], (await connect(a, a1)).split(" ")[1]);
  } finally {
    await env.call("spaces.finish", { space: a, keep: [] }).catch(() => {});
    await env.call("spaces.finish", { space: b, keep: [] }).catch(() => {});
  }
});
