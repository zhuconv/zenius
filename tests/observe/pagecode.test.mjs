// The user's setting for agents' page code (observe/pagecode.sys.mjs):
// zenius.agentTabs.pageCode "always" (the default), "ask" or "never", and
// the sites the user allowed under "ask". Every method that runs the agent's
// code is placed (the registry walk), "never" refuses it everywhere, "ask"
// asks once per task and site, and no agent can allow itself.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const repo = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const PC = `const PC = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/pagecode.sys.mjs");`;
const MODE = "zenius.agentTabs.pageCode";
const SITES = "zenius.agentTabs.pageCodeSites";

// Every other method, reviewed: none runs code the agent wrote in a page.
const NO_PAGE_CODE = [
  "browser.health", "browser.methods", "browser.version", "profiles.list",
  "spaces.claim", "spaces.create", "spaces.finish", "spaces.handOff", "spaces.list", "spaces.noteAccount", "spaces.open", "spaces.setState", "spaces.takeOver", "spaces.waitForControl",
  "pages.adopt", "pages.close", "pages.list", "pages.release", "pages.userPage", "tabs.list",
  // The core's evidence: page.flag marks the page's document and runs none of its code.
  "page.flag",
  "events.subscribe", "page.events", "page.waitForEvent",
  "page.url", "page.title", "page.info", "page.snapshot", "page.screenshot", "page.waitForSelector", "page.waitForURL", "page.waitForLoadState",
  "page.fetch", "page.acceptDialog", "page.dismissDialog",
  "download.cancel", "download.delete", "download.failure", "download.path", "download.read", "download.saveAs",
  "page.click", "page.dblclick", "page.hover", "page.focus", "page.fill", "page.press", "page.selectOption", "page.dragAndDrop",
  "page.keyboard", "page.mouse", "page.setInputFiles", "filechooser.setFiles",
  "ui.cursor", "ui.state", "ui.sidebarStatus",
  // Remote tasks: the sidebar's agent acts through the methods above.
  "sidebar.start", "sidebar.send", "sidebar.status", "sidebar.list", "sidebar.stop",
  // zenius feedback: a report of zenius's own data and the agent's line, shown in the sidebar's card.
  "feedback.compose", "feedback.propose",
  // A client gives up on a request of its own: it stops that request, and runs nothing.
  "calls.cancel",
  // A script tool call's step: its connection begins and ends it in the task's steps.
  "script.begin", "script.end",
];

let env;
const setMode = (mode, sites = "") =>
  env.chrome(
    `if (arg.mode === null) Services.prefs.clearUserPref(arg.MODE); else Services.prefs.setStringPref(arg.MODE, arg.mode);
     Services.prefs.setStringPref(arg.SITES, arg.sites);
     return true;`,
    { mode, sites, MODE, SITES }
  );

before(async () => {
  env = await setup();
});

after(async () => {
  await env
    .chrome(`Services.prefs.clearUserPref(arg.MODE); Services.prefs.clearUserPref(arg.SITES); delete win.__zeniusPageCodeAsks; win.__zeniusPageCodeOff?.(); return true;`, { MODE, SITES })
    .catch(() => {});
  await env.close();
});

/** Whether the page's top document has a world of the agent's, without making one. */
const hasWorld = P =>
  env.chrome(
    `const p = ctx.resolvePage(arg);
     const r = await ctx.content(p.browser.browsingContext, "agentworld#peek", { expr: "1" });
     return !r.none;`,
    P
  );
const marked = P =>
  env.chrome(
    `const { agentCodeTop } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs");
     return agentCodeTop(ctx.resolvePage(arg).browser);`,
    P
  );

test("every method in the registry is placed: it runs the agent's page code, loads the agent's own page, or runs none", async () => {
  const { methods } = await env.call("browser.methods");
  const placed = await env.chrome(`${PC} return { code: PC.PAGE_CODE_METHODS, loads: PC.OWN_PAGE_LOADS };`);
  const known = new Set([...placed.code, ...placed.loads, ...NO_PAGE_CODE]);
  const unplaced = methods.filter(m => !m.startsWith("dev.") && !known.has(m));
  assert.deepEqual(unplaced, [], "a new method: put it in PAGE_CODE_METHODS or OWN_PAGE_LOADS (and check it), or in this test's NO_PAGE_CODE");
  for (const name of [...placed.code, ...placed.loads]) {
    assert.ok(!NO_PAGE_CODE.includes(name), `${name} is in one list only`);
  }
  // And each one placed as page code is refused under "never".
  assert.deepEqual(placed.code.toSorted(), ["page.evaluate", "page.waitForFunction"]);
  assert.deepEqual(placed.loads.toSorted(), ["page.goto", "page.reload", "pages.new"]);
});

test("always, the default, runs the agent's page code; never refuses it everywhere, whatever the site list says, before any world or mark", () =>
  env.inSpace("page code never", async page => {
    await setMode(null);
    await page.goto(`${env.base}/nav-target?pagecode-always`);
    assert.equal(await env.call("page.evaluate", { ...page.P, fn: "() => 1 + 1" }), 2);
    // A fresh document, so no world from the call above.
    await page.goto(`${env.base}/nav-target?pagecode-never`);
    const site = await env.chrome(`${PC} return PC.siteOf(ctx.resolvePage(arg).browser.browsingContext.currentWindowGlobal.documentPrincipal);`, page.P);
    await setMode("never", site);
    for (const [method, params] of [
      ["page.evaluate", { fn: "() => 1" }],
      ["page.waitForFunction", { fn: "() => true", options: { timeout: 2000 } }],
    ]) {
      const e = await env.fail(method, { ...page.P, ...params });
      assert.equal(e.code, "ZEN_PAGE_CODE_OFF", method);
      assert.equal(e.data.setting, "never");
    }
    assert.equal(await hasWorld(page.P), false, "no world was made");
    assert.equal(await marked(page.P), false, "the page isn't marked as holding the agent's code");
    // The agent's own pages don't load either: never means never.
    const own = "data:text/html,<p>mine</p>";
    assert.equal((await env.fail("page.goto", { ...page.P, url: own })).code, "ZEN_PAGE_CODE_OFF");
    assert.equal((await env.fail("pages.new", { space: page.P.space, url: own })).code, "ZEN_PAGE_CODE_OFF");
    await setMode("always");
    await page.goto(own);
    await setMode("never");
    assert.equal((await env.fail("page.reload", page.P)).code, "ZEN_PAGE_CODE_OFF");
    assert.equal((await env.fail("page.evaluate", { ...page.P, fn: "() => 1" })).code, "ZEN_PAGE_CODE_OFF");
  }));

test("ask: a site runs page code once the user allows it; one ask per task and site; after Not now the agent hears it was declined; its own page runs unasked", () =>
  env.inSpace("page code ask", async page => {
    // What the card hears (the input layer's card listens the same way).
    await env.chrome(
      `${PC} win.__zeniusPageCodeAsks = [];
       win.__zeniusPageCodeOff = PC.onPageCodeAsk(a => win.__zeniusPageCodeAsks.push({ site: a.site, mine: a.browser === ctx.resolvePage(arg).browser }));
       return true;`,
      page.P
    );
    const asks = () => env.chrome(`return win.__zeniusPageCodeAsks;`);
    try {
      await setMode("ask");
      await page.goto(`${env.base}/nav-target?pagecode-ask`);
      const first = await env.fail("page.evaluate", { ...page.P, fn: "() => 1" });
      assert.equal(first.code, "ZEN_PAGE_CODE_ASKED");
      const site = first.data.site;
      assert.match(site, /^http:\/\/127\.0\.0\.1/);
      assert.equal(first.data.asked, true);
      const again = await env.fail("page.waitForFunction", { ...page.P, fn: "() => true", options: { timeout: 2000 } });
      assert.equal(again.code, "ZEN_PAGE_CODE_ASKED");
      assert.equal(again.data.asked, false, "asked once");
      assert.deepEqual(await asks(), [{ site, mine: true }]);
      assert.equal(await hasWorld(page.P), false, "no world while it waits");
      assert.equal(await marked(page.P), false, "nor a mark");

      // Not now: the agent hears it was declined for this task.
      await env.chrome(`${PC} PC.declinePageCode(ctx.resolvePage(arg.P).space, arg.site); return true;`, { P: page.P, site });
      const declined = await env.fail("page.evaluate", { ...page.P, fn: "() => 1" });
      assert.equal(declined.data.declined, true);
      assert.match(declined.message, /declined .* for this task/);

      // Allow, on the card's button: only a click's trusted event inside the card counts.
      const allowed = await env.chrome(
        `${PC}
         const card = win.document.createXULElement("hbox");
         const button = win.document.createElement("button");
         card.append(button);
         win.document.documentElement.append(card);
         try {
           const untrusted = PC.allowPageCodeSite(arg.site, { isTrusted: false, type: "click", target: button }, card);
           const outside = PC.allowPageCodeSite(arg.site, { isTrusted: true, type: "click", target: win.document.documentElement }, card);
           const before = Services.prefs.getStringPref(arg.SITES, "");
           let got = null;
           button.addEventListener("click", e => (got = { trusted: e.isTrusted, ok: PC.allowPageCodeSite(arg.site, e, card) }), { once: true });
           button.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
           return { untrusted, outside, before, got, after: Services.prefs.getStringPref(arg.SITES, "") };
         } finally {
           card.remove();
         }`,
        { site, SITES }
      );
      assert.equal(allowed.untrusted, false, "an untrusted click writes nothing");
      assert.equal(allowed.outside, false, "a click outside the card writes nothing");
      assert.equal(allowed.before, "");
      assert.deepEqual(allowed.got, { trusted: true, ok: true });
      assert.equal(allowed.after, site, "the exact site, alone");
      assert.equal(await env.call("page.evaluate", { ...page.P, fn: "() => 40 + 2" }), 42, "the next call runs");

      // Another site is asked about on its own.
      await page.goto(`${env.base.replace("127.0.0.1", "localhost")}/nav-target?pagecode-other`);
      const other = await env.fail("page.evaluate", { ...page.P, fn: "() => 1" });
      assert.equal(other.data.asked, true);
      assert.notEqual(other.data.site, site);

      // The agent's own page runs its code unasked; any other value reads as ask.
      await page.goto("data:text/html,<p>mine</p>");
      assert.equal(await env.call("page.evaluate", { ...page.P, fn: "() => 'own'" }), "own");
      await setMode("sometimes", site);
      await page.goto(`${env.base.replace("127.0.0.1", "localhost")}/nav-target?pagecode-typo`);
      assert.equal((await env.fail("page.evaluate", { ...page.P, fn: "() => 1" })).code, "ZEN_PAGE_CODE_ASKED");
      // So does a pref of another type: a Boolean false the user made
      // meaning off, or a number (getStringPref would read "always").
      for (const make of ["Services.prefs.setBoolPref(arg.MODE, false)", "Services.prefs.setIntPref(arg.MODE, 0)"]) {
        assert.equal(await env.chrome(`${PC} Services.prefs.clearUserPref(arg.MODE); ${make}; return PC.pageCodeMode();`, { MODE }), "ask", make);
      }
      await env.chrome(`Services.prefs.clearUserPref(arg.MODE); return true;`, { MODE });
      // A site list of another type holds no sites, and the user's Allow
      // replaces it with the one site.
      const mistyped = await env.chrome(
        `${PC}
         Services.prefs.clearUserPref(arg.SITES);
         Services.prefs.setBoolPref(arg.SITES, true);
         const card = win.document.createXULElement("hbox");
         const button = win.document.createElement("button");
         card.append(button);
         win.document.documentElement.append(card);
         try {
           const before = PC.siteAllowed(arg.site);
           let ok = null;
           button.addEventListener("click", e => (ok = PC.allowPageCodeSite(arg.site, e, card)), { once: true });
           button.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
           const string = Services.prefs.getPrefType(arg.SITES) === Services.prefs.PREF_STRING;
           return { before, ok, string, after: Services.prefs.getStringPref(arg.SITES, "") };
         } finally {
           card.remove();
         }`,
        { site, SITES }
      );
      assert.deepEqual(mistyped, { before: false, ok: true, string: true, after: site });
      // "never" wins over the list.
      await page.goto(`${env.base}/nav-target?pagecode-wins`);
      assert.equal(await env.call("page.evaluate", { ...page.P, fn: "() => 1" }), 1);
      await setMode("never", site);
      assert.equal((await env.fail("page.evaluate", { ...page.P, fn: "() => 1" })).code, "ZEN_PAGE_CODE_OFF");
    } finally {
      await env.chrome(`win.__zeniusPageCodeOff?.(); delete win.__zeniusPageCodeOff; delete win.__zeniusPageCodeAsks; return true;`);
      await setMode(null);
    }
  }));

test("no agent can allow itself: no method writes either pref, only the card's trusted click does, and an agent tab can't open about:config", async () => {
  // Every write of the two prefs in the runtime: only allowPageCodeSite's.
  const root = join(repo, "runtime/JS");
  const files = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "vendor") walk(path);
      } else if (/\.(m?js)$/.test(name)) {
        files.push(path);
      }
    }
  };
  walk(root);
  const writes = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/\b(set(String|Char|Bool|Int)Pref|clearUserPref|resetUserPref|lockPref|setComplexValue)\s*\(/.test(line) && /PAGE_CODE(_SITES)?_PREF|zenius\.agentTabs\.pageCode/.test(line)) {
        writes.push(`${relative(repo, file)}:${i + 1}`);
      }
    });
  }
  const pagecode = readFileSync(join(root, "zenius/observe/pagecode.sys.mjs"), "utf8");
  const allowAt = pagecode.split("\n").findIndex(l => l.startsWith("export function allowPageCodeSite("));
  const allowEnd = pagecode.split("\n").findIndex((l, i) => i > allowAt && l === "}");
  assert.deepEqual(
    writes.filter(w => {
      const [file, line] = w.split(":");
      return !(file.endsWith("observe/pagecode.sys.mjs") && Number(line) > allowAt && Number(line) <= allowEnd + 1);
    }),
    [],
    "nothing else writes the setting or the list"
  );
  assert.ok(writes.length >= 1, "allowPageCodeSite writes the list");
  // No method module reaches the card's write.
  for (const file of files.filter(f => f.includes("/zenius/methods/"))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /allowPageCodeSite/, relative(repo, file));
  }
  // And an agent tab can't open about:config.
  await env.inSpace("page code about:config", async page => {
    const e = await env.fail("page.goto", { ...page.P, url: "about:config" });
    assert.equal(e.code, "ZEN_URL_NOT_ALLOWED");
  });
});
