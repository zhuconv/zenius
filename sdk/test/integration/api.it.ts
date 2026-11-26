// The rest of the agent API against a real dev Zen, one case per area, with
// Ego's documented results as the expectation. A case runs once the runtime
// registers its methods. Cases not yet seen passing are todo: a failure
// shows in the log without failing the run, so an expectation that was never
// checked against a real runtime can't block another worker's merge. Once a
// case passes, it moves from contract() to verified().

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, describe, it, type TestContext } from "node:test";

import { runCli } from "../helpers.ts";
import { answerClaims, CREDENTIALS, needs, unique, useContext, zenius, zeniusJson } from "./context.ts";
import { noted } from "./fixtures.ts";

const context = useContext();
const scratch = mkdtempSync(join(tmpdir(), "zenius-it-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The dev Zen's working folder (test-integration.sh), where finished downloads land. */
const WORKING = process.env.ZENIUS_IT_WORKING_DIR ?? "";

/** A finished download's file, which stays in the working folder, readable only by the user. */
function keptInWorkingFolder(path: string): void {
  assert.ok(path.startsWith(`${WORKING}/`), `download.path() is ${path}, not a file in the working folder ${WORKING}`);
  assert.equal(readFileSync(path, "utf8"), "zenius download fixture\n", "the finished file stays in the working folder after the script");
  assert.equal(statSync(path).mode & 0o777, 0o600);
}

function verified(name: string, methods: string[], body: (t: TestContext) => Promise<void>) {
  it(name, async (t) => {
    if (needs(t, context, ...methods)) await body(t);
  });
}

function contract(name: string, methods: string[], body: (t: TestContext) => Promise<void>) {
  it(name, { todo: "not yet seen passing" }, async (t) => {
    if (needs(t, context, ...methods)) await body(t);
  });
}

/** Script prelude: a fresh task space with p1 on `path`. */
const open = (path: string) => `const task = await taskSpace(${JSON.stringify(unique("it api"))});
const page = task.page("p1");
await page.goto(${JSON.stringify(`${context.base}${path}`)});
`;
const json = (value: string) => JSON.stringify(value);
const chrome = (code: string, arg: unknown) => context.rpc.call("dev.evalChrome", { code, arg });
/** The task's reason, and what Zen's strip and tasks panel read it as (ZeniusUI.tasks()). */
const waitsFor = (space: number) =>
  chrome(
    `const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
     return { reason: ctx.spaces.get(arg).reason ?? null, waitsFor: UI.tasks().find((row) => row.id === arg)?.waitsFor ?? null };`,
    space,
  );

describe("task spaces and profiles", () => {
  verified("a user Space's name is not a task space name", ["spaces.list"], async (t) => {
    const result = await zenius(
      context,
      `const user = (await listTaskSpaces()).find((space) => space.ownership === "user");
if (!user) { console.log("none"); return; }
await taskSpace(user.name);`,
    );
    if (result.stdout === "none\n") return t.skip("no user Space in this profile");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^ZeniusError \[ZEN_TASK_SPACE_NAME_IN_USE\]/);
  });

  verified("profiles() lists the default profile and Zen's containers", ["profiles.list"], async () => {
    const profiles = await zeniusJson(context, "console.log(JSON.stringify(await profiles()));");
    assert.ok(Array.isArray(profiles) && profiles.length >= 1);
    assert.equal(profiles.filter((profile: { isDefault: boolean }) => profile.isDefault).length, 1);
    for (const profile of profiles) {
      assert.equal(typeof profile.id, "string");
      assert.equal(typeof profile.name, "string");
    }
  });

  verified("tabs() lists every tab with label, id, opener and one active tab", ["spaces.create", "pages.new", "tabs.list"], async () => {
    const tabs = await zeniusJson(
      context,
      `const task = await taskSpace(${json(unique("it tabs"))});
await task.newPage();
const tabs = await task.tabs();
console.log(JSON.stringify(tabs.map((tab) => ({ label: tab.label, pageLabel: tab.page.label, targetId: tab.targetId, active: tab.active, openedBy: tab.openedBy }))));`,
    );
    // Tabs come in the Space's sidebar order, where Zen opens new tabs on
    // top; Ego promises no order either.
    assert.deepEqual(tabs.map((tab: { label: string }) => tab.label).sort(), ["p1", "p2"]);
    for (const tab of tabs) {
      assert.equal(tab.pageLabel, tab.label);
      assert.ok(typeof tab.targetId === "string" && tab.targetId.length > 0);
      assert.equal(typeof tab.active, "boolean");
      assert.equal(tab.openedBy, "agent");
    }
    assert.equal(tabs.filter((tab: { active: boolean }) => tab.active).length, 1);
  });

  verified("page.close() closes a Page and drops its label", ["spaces.create", "pages.new", "pages.close", "pages.list"], async () => {
    const labels = await zeniusJson(
      context,
      `const task = await taskSpace(${json(unique("it close"))});
const p2 = await task.newPage();
await p2.close();
console.log(JSON.stringify((await task.pages()).map((page) => page.label)));`,
    );
    assert.deepEqual(labels, ["p1"]);
  });

  verified(
    "handOff() stops the agent until takeOverTaskSpace()",
    ["spaces.create", "spaces.list", "spaces.handOff", "spaces.takeOver", "page.evaluate"],
    async () => {
      const id = Number(
        (await zeniusJson(context, `const task = await taskSpace(${json(unique("it handoff"))}); await task.handOff(); console.log(task.spaceId);`)) as number,
      );
      const stopped = await zenius(context, `await (await taskSpace(${id})).page("p1").evaluate("1");`);
      assert.equal(stopped.code, 1);
      assert.match(stopped.stderr, /ZEN_TASK_SPACE_USER_IN_CONTROL/);
      assert.equal(stopped.stderr.match(/Control of this task space is with the user/g)?.length, 1);
      const resumed = await zeniusJson(
        context,
        `const task = await takeOverTaskSpace(${id});
const userPage = task.userPage();
const value = await task.page("p1").evaluate("6 * 7");
const entry = (await listTaskSpaces()).find((space) => space.id === ${id});
console.log(JSON.stringify({ value, ownership: entry.ownership, userPage: userPage && (userPage.label ?? userPage.targetId) }));`,
      );
      assert.equal(resumed.value, 42);
      assert.equal(resumed.ownership, "agent");
      assert.ok(resumed.userPage, "takeOverTaskSpace() captures the tab the user left active");
    },
  );

  verified(
    "zenius wait ends at the user's Resume agent, marks the task waited on meanwhile, and leaves the hand back's notes to takeOverTaskSpace()",
    ["spaces.create", "spaces.list", "spaces.handOff", "spaces.waitForControl", "spaces.takeOver", "spaces.finish"],
    async () => {
      const id = Number((await zeniusJson(context, `${open("/form")}await task.handOff({ secret: true }); console.log(task.spaceId);`)) as number);
      const waitedOn = async () =>
        (await context.rpc.call<{ taskSpaces: { id: number; agentWaiting?: boolean }[] }>("spaces.list")).taskSpaces.find((entry) => entry.id === id)
          ?.agentWaiting === true;
      const waiting = runCli(["wait", "--instance", context.instance, String(id)], { timeoutMs: 60_000 });
      const end = Date.now() + 15_000;
      while (!(await waitedOn())) {
        assert.ok(Date.now() < end, "spaces.list never said the task was waited on");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Resume agent, as the UI's panel presses it: the secret step's tab is blanked first.
      await chrome(
        `const s = ctx.spaces.get(arg);
         await ctx.service.beforeHandBack(s);
         ctx.spaces.setOwnership(s, "agent", { source: "user" });
         return true;`,
        id,
      );
      const result = await waiting;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, `Task ${id} is yours again: the user handed it back. Take it over with takeOverTaskSpace(${id}) and go on.\n`);
      const back = await zeniusJson(
        context,
        `const task = await takeOverTaskSpace(${id});
const handBack = task.handBack ?? null;
await task.finish({ keep: [] });
console.log(JSON.stringify(handBack));`,
      );
      assert.deepEqual(back, { blanked: ["p1"] }, "the wait took none of the notes");
      assert.equal(await waitedOn(), false);
    },
  );

  verified(
    "handOff({ reason }) gives the task its reason, which Zen's strip reads, and one without keeps the default",
    ["spaces.create", "spaces.setState", "spaces.handOff", "spaces.takeOver", "spaces.finish"],
    async () => {
      const id = Number(
        (await zeniusJson(
          context,
          `const task = await taskSpace(${json(unique("it handoff reason"))}); await task.handOff({ message: "Sign in to Accounts", reason: "sign_in" }); console.log(task.spaceId);`,
        )) as number,
      );
      assert.deepEqual(await waitsFor(id), { reason: "sign_in", waitsFor: "sign_in" });
      await zenius(context, `const task = await takeOverTaskSpace(${id}); await task.handOff({ message: "Look at the total" });`);
      assert.deepEqual(await waitsFor(id), { reason: "manual_takeover", waitsFor: "handoff" });
      await zenius(context, `const task = await takeOverTaskSpace(${id}); await task.finish({ keep: [] });`);
    },
  );

  verified(
    "finish({ keep }) hands kept Pages to the user; claimTaskSpace() and adopt() resume them",
    ["spaces.create", "spaces.list", "spaces.finish", "spaces.claim", "tabs.list", "pages.adopt", "page.goto", "page.evaluate"],
    async () => {
      const finished = await zeniusJson(
        context,
        `const task = await taskSpace(${json(unique("it keep"))});
await task.page("p1").goto(${json(`${context.base}/two`)});
await task.newPage();
const receipt = await task.finish({ keep: ["p1"] });
const entry = (await listTaskSpaces()).find((space) => space.id === task.spaceId);
console.log(JSON.stringify({ id: task.spaceId, receipt, ownership: entry?.ownership }));`,
      );
      assert.deepEqual(finished.receipt, {
        spaceId: finished.id,
        closedSpace: false,
        keptManagedLabels: ["p1"],
        closedManagedLabels: ["p2"],
        preservedUnmanagedCount: 0,
      });
      assert.equal(finished.ownership, "user");
      // The claim of an ended task asks the user; the harness answers as the user would.
      const [claimed] = await Promise.all([
        zeniusJson(
          context,
          `const task = await claimTaskSpace(${finished.id});
const page = (await task.pages())[0] ?? (await task.adopt((await task.tabs())[0].page));
console.log(JSON.stringify({ label: page.label, url: await page.evaluate(() => location.href) }));`,
        ),
        answerClaims(context, [finished.id]),
      ]);
      assert.match(claimed.label, /^p\d+$/);
      assert.equal(claimed.url, `${context.base}/two`);
    },
  );
});

describe("navigation and observation", () => {
  verified("a goto that times out leaves the Page on its previous document", ["spaces.create", "page.goto", "page.evaluate"], async () => {
    const out = await zeniusJson(
      context,
      `${open("/")}let failure;
try { await page.goto(${json(`${context.base}/hang`)}, { timeout: 500 }); } catch (error) {
  failure = { code: error.code, committed: error.committed, stopped: error.stopped, message: error.message };
}
console.log(JSON.stringify({ failure, title: await page.evaluate(() => document.title) }));`,
    );
    // Ego's page-pending-navigation e2e: EGO_NAVIGATION_TIMEOUT with committed
    // and stopped on the error, and a message that says what to do.
    assert.equal(out.failure.code, "ZEN_NAVIGATION_TIMEOUT");
    assert.equal(out.failure.committed, false);
    assert.equal(out.failure.stopped, true);
    assert.match(out.failure.message, /had not committed and was stopped/);
    assert.ok(out.failure.message.includes("page.goto(url, { timeout })"), out.failure.message);
    assert.equal(out.title, "sdk fixture");
  });

  verified("url(), title() and info() describe the Page", ["spaces.create", "page.goto", "page.url", "page.title", "page.info"], async () => {
    const out = await zeniusJson(context, `${open("/")}console.log(JSON.stringify({ url: await page.url(), title: await page.title(), info: await page.info() }));`);
    assert.equal(out.url, `${context.base}/`);
    assert.equal(out.title, "sdk fixture");
    assert.equal(out.info.url, `${context.base}/`);
    assert.equal(out.info.title, "sdk fixture");
    for (const key of ["w", "h"]) assert.equal(typeof out.info[key], "number", `info.${key}`);
  });

  verified(
    "reload(), waitForLoadState() and waitForURL() with a glob, a RegExp and a predicate",
    ["spaces.create", "page.goto", "page.reload", "page.waitForLoadState", "page.waitForURL", "page.url"],
    async () => {
      const out = await zeniusJson(
        context,
        `${open("/two")}const reload = await page.reload();
await page.waitForLoadState();
await page.waitForLoadState("domcontentloaded");
await page.waitForURL("**/two");
await page.waitForURL(/\\/two$/);
await page.waitForURL((url) => url.pathname === "/two");
let timedOut;
try { await page.waitForURL("**/never", { timeout: 300 }); } catch (error) { timedOut = { code: error.code, message: error.message }; }
console.log(JSON.stringify({ reload, url: await page.url(), timedOut }));`,
      );
      assert.equal(typeof out.reload, "object", "reload() returns Ego's action receipt");
      assert.equal(out.url, `${context.base}/two`);
      // Ego throws a plain Error, without a code, when a wait times out.
      assert.equal(out.timedOut.code, undefined);
      assert.match(out.timedOut.message, /timeout|timed out/i);
    },
  );

  verified("screenshot() writes a PNG and returns its absolute path", ["spaces.create", "page.goto", "page.screenshot"], async () => {
    const chosen = join(scratch, "shots", "chosen.png");
    const out = await zeniusJson(
      context,
      `${open("/")}const auto = await page.screenshot();
const chosen = await page.screenshot({ path: ${json(chosen)} });
console.log(JSON.stringify({ auto, chosen }));`,
    );
    assert.ok(isAbsolute(out.auto), out.auto);
    assert.equal(out.chosen, chosen);
    for (const path of [out.auto, out.chosen]) {
      assert.deepEqual([...readFileSync(path).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${path} is a PNG`);
    }
    rmSync(out.auto, { force: true });
  });

  verified("events() returns the buffered events as an array", ["spaces.create", "page.goto", "page.events"], async () => {
    assert.ok(Array.isArray(await zeniusJson(context, `${open("/")}console.log(JSON.stringify(await page.events()));`)));
  });

  // EGO_BROWSER_PAGE_BUDGET, set inside the script before its first call, as
  // Ego's own e2e cases set it. The runtime applies the request's pageBudget.
  // Built per test: open() needs the fixture server's address, set in before().
  const budgetScript = () => `process.env.EGO_BROWSER_PAGE_BUDGET = "2";
${open("/")}await task.newPage();
let failure;
try { await task.newPage(); } catch (error) { failure = { code: error.code, budget: error.budget, first: error.message.split("\\n")[0] }; }
const header = (await page.snapshot()).split("\\n")[0];
console.log(JSON.stringify({ failure, header, pages: (await task.pages()).length }));`;

  verified("EGO_BROWSER_PAGE_BUDGET caps newPage() for this process", ["spaces.create", "page.goto", "pages.new", "page.snapshot"], async () => {
    const out = await zeniusJson(context, budgetScript());
    assert.equal(out.failure?.code, "ZEN_PAGE_BUDGET_REACHED", JSON.stringify(out));
    assert.match(out.failure.first, /^task\.newPage: Page budget reached \(2\/2\) in space /);
    assert.equal(out.pages, 2);
  });

  verified("the snapshot header shows the process's page budget", ["spaces.create", "page.goto", "pages.new", "page.snapshot"], async () => {
    const out = await zeniusJson(context, budgetScript());
    assert.match(out.header, /\| budget 2\/2\]$/, out.header);
  });

  // Ego's page-load-states e2e case: console calls show in events(), and a
  // wait doesn't consume them.
  verified(
    "events() records console calls as Runtime.consoleAPICalled, and waits don't consume them",
    ["spaces.create", "page.goto", "page.evaluate", "page.waitForLoadState", "page.events"],
    async () => {
      const out = await zeniusJson(
        context,
        `${open("/")}await page.evaluate(() => console.log("zenius console marker", 42));
await page.waitForLoadState("networkidle", { timeout: 3000 });
const logged = (await page.events()).filter((event) => event.method === "Runtime.consoleAPICalled");
const again = (await page.events()).filter((event) => event.method === "Runtime.consoleAPICalled");
console.log(JSON.stringify({ logged, again }));`,
      );
      const marked = out.logged.filter((event: any) => event.params?.args?.some((argument: any) => argument.value === "zenius console marker"));
      assert.equal(marked.length, 1, JSON.stringify(out.logged));
      assert.deepEqual(marked[0].params.args[1], { type: "number", value: 42 });
      assert.deepEqual(out.again, [], "events() returns each event once");
    },
  );

  // Refused surfaces (PROTOCOL.md): the observe layer's print, HTTP sign-in and app
  // links, and the input layer's pickers. A script sees each in the action's
  // receipt.refused and as a Zenius.refused event.
  verified(
    "a refused print dialog is in the click's receipt and in events(), and print() returns as after Cancel",
    ["spaces.create", "page.goto", "page.click", "page.events", "page.evaluate"],
    async () => {
      const out = await zeniusJson(
        context,
        `${open("/refusals")}await page.events();
const receipt = await page.click("#print");
const refused = (await page.events()).filter((event) => event.method === "Zenius.refused");
console.log(JSON.stringify({ receipt, refused, printed: await page.evaluate(() => ${noted("printed")}) }));`,
      );
      assert.deepEqual(out.receipt.refused?.map((refusal: any) => Object.keys(refusal).sort()), [["kind", "message"]], JSON.stringify(out.receipt));
      assert.equal(out.receipt.refused[0].kind, "print");
      assert.match(out.receipt.refused[0].message, /window\.print\(\)/);
      assert.deepEqual(
        out.refused.map((event: any) => [event.params.kind, event.params.url]),
        [["print", `${context.base}/refusals`]],
        JSON.stringify(out.refused),
      );
      assert.equal(out.printed, 1);
    },
  );

  verified("goto's receipt says an HTTP sign-in was refused, and the 401 page loads", ["spaces.create", "page.goto", "page.title"], async () => {
    const out = await zeniusJson(
      context,
      `${open("/")}const receipt = await page.goto(${json(`${context.base}/auth`)});
console.log(JSON.stringify({ refused: receipt.refused, title: await page.title() }));`,
    );
    assert.deepEqual(out.refused?.map((refusal: any) => refusal.kind), ["httpAuth"], JSON.stringify(out));
    assert.match(out.refused[0].message, /realm "zenius sdk"/);
    assert.equal(out.title, "sdk 401");
  });

  verified("a mailto: link opens no app, and events() says so with the link", ["spaces.create", "page.goto", "page.click", "page.events", "page.url"], async () => {
    const out = await zeniusJson(
      context,
      `${open("/refusals")}await page.events();
await page.click("#mail");
let refused = [];
for (let i = 0; i < 30 && refused.length === 0; i++) {
  refused = (await page.events()).filter((event) => event.method === "Zenius.refused");
  if (refused.length === 0) await page.waitForTimeout(100);
}
console.log(JSON.stringify({ refused, url: await page.url() }));`,
    );
    assert.deepEqual(
      out.refused.map((event: any) => [event.params.kind, event.params.url]),
      [["externalApp", "mailto:zenius@example.invalid"]],
      JSON.stringify(out),
    );
    assert.match(out.refused[0].params.message, /tell them the link/);
    assert.equal(out.url, `${context.base}/refusals`);
  });

  verified("date, select and color inputs open no picker, and each click's receipt names the method to use", ["spaces.create", "page.goto", "page.click"], async () => {
    const out = await zeniusJson(
      context,
      `${open("/refusals")}const refused = {};
for (const target of ["#pick", "#size", "#tint"]) refused[target] = (await page.click(target)).refused ?? [];
console.log(JSON.stringify(refused));`,
    );
    const kinds = Object.fromEntries(Object.entries(out).map(([target, list]: [string, any]) => [target, list.map((refusal: any) => refusal.kind)]));
    assert.deepEqual(kinds, { "#pick": ["datePicker"], "#size": ["selectDropdown"], "#tint": ["colorPicker"] }, JSON.stringify(out));
    assert.match(out["#pick"][0].message, /page\.fill/);
    assert.match(out["#size"][0].message, /page\.selectOption/);
    assert.match(out["#tint"][0].message, /page\.fill/);
  });

  verified("waitForSelector() finds an element that appears inside an iframe", ["spaces.create", "page.goto", "page.waitForSelector"], async () => {
    const out = await zeniusJson(
      context,
      `${open("/framed")}const started = Date.now();
await page.waitForSelector("#in-frame", { timeout: 5000 });
let missing;
try { await page.waitForSelector("#nowhere", { timeout: 300 }); } catch (error) { missing = error.code ?? error.name; }
console.log(JSON.stringify({ waited: Date.now() - started, missing }));`,
    );
    assert.ok(out.waited < 5000, JSON.stringify(out));
    assert.ok(out.missing, "a selector in no frame still times out");
  });

  verified(
    "waitForSelector() and waitForFunction() wait for late content",
    ["spaces.create", "page.goto", "page.waitForSelector", "page.waitForFunction"],
    async () => {
      const out = await zeniusJson(
        context,
        `${open("/late")}await page.waitForSelector("#late");
const ready = await page.waitForFunction(() => ${noted("ready")} === true);
let missing;
try { await page.waitForSelector("#never", { timeout: 300 }); } catch (error) { missing = { code: error.code, message: error.message }; }
console.log(JSON.stringify({ ready, missing }));`,
      );
      assert.equal(out.ready, true);
      // Ego throws a plain Error, without a code, when a wait times out.
      assert.equal(out.missing.code, undefined);
      assert.match(out.missing.message, /timeout|timed out/i);
    },
  );
});

describe("actions", () => {
  verified(
    "fill(), press(), selectOption() and focus() act on form controls",
    ["spaces.create", "page.goto", "page.fill", "page.press", "page.selectOption", "page.focus", "page.evaluate"],
    async () => {
      const out = await zeniusJson(
        context,
        `${open("/form")}await page.fill("#name", "Zen");
await page.fill("#bio", "line one");
const selected = await page.selectOption("#month", { label: "October" });
await page.focus("#bio");
const focused = await page.evaluate(() => document.activeElement.id);
await page.press("#name", "Enter");
const state = await page.evaluate(() => ({
  name: document.querySelector("#name").value,
  bio: document.querySelector("#bio").value,
  month: document.querySelector("#month").value,
  submitted: ${noted("submitted")} === true,
}));
console.log(JSON.stringify({ selected, focused, state }));`,
      );
      assert.deepEqual(out, { selected: ["m10"], focused: "bio", state: { name: "Zen", bio: "line one", month: "m10", submitted: true } });
    },
  );

  verified(
    "click(), dblclick(), hover() and dragAndDrop() reach their targets",
    ["spaces.create", "page.goto", "page.click", "page.dblclick", "page.hover", "page.dragAndDrop", "page.evaluate"],
    async () => {
      const out = await zeniusJson(
        context,
        `${open("/form")}const receipt = await page.click("#clicker", { label: "count a click" });
await page.click("text=Count clicks");
await page.dblclick("#doubler");
await page.hover("#hover", { label: "hover the box" });
await page.dragAndDrop("#source", "#target");
const state = await page.evaluate(() => ({
  clicks: ${noted("clicks")}, doubles: ${noted("doubles")}, hovered: ${noted("hovered")} === true, dragFrom: ${noted("dragFrom")}, dropOn: ${noted("dropOn")},
}));
console.log(JSON.stringify({ receipt, state }));`,
      );
      assert.equal(typeof out.receipt, "object");
      assert.deepEqual(out.state, { clicks: 2, doubles: 1, hovered: true, dragFrom: "source", dropOn: "target" });
    },
  );

  verified("page.mouse and page.keyboard drive raw input", ["spaces.create", "page.goto", "page.click", "page.mouse", "page.keyboard", "page.evaluate"], async () => {
    const out = await zeniusJson(
      context,
      `${open("/keys")}await page.mouse.click(60, 30, { label: "click the corner" });
await page.click("#keys");
await page.keyboard.type("hello");
await page.keyboard.press("Backspace");
await page.keyboard.insertText(" zen");
await page.mouse.move(200, 300);
await page.mouse.wheel(0, 400, { label: "scroll down" });
const state = await page.evaluate(() => ({
  corner: ${noted("cornerClicks")}, value: document.querySelector("#keys").value, keys: ${noted("keyLog")}, scrolled: window.scrollY > 0,
}));
console.log(JSON.stringify(state));`,
    );
    assert.equal(out.corner, 1);
    assert.equal(out.value, "hell zen");
    assert.deepEqual(out.keys.slice(0, 6), ["h", "e", "l", "l", "o", "Backspace"]);
    assert.equal(out.scrolled, true);
  });

  verified("keyboard.paste() pastes rich content through the task space's clipboard", ["spaces.create", "page.goto", "page.click", "page.keyboard", "page.evaluate"], async () => {
    const html = await zeniusJson(
      context,
      `${open("/keys")}await page.click("#editor");
await page.keyboard.paste({ text: "plain", html: "<b>bold</b>" });
console.log(JSON.stringify(await page.evaluate(() => document.querySelector("#editor").innerHTML)));`,
    );
    assert.match(html, /<b>bold<\/b>/);
  });
});

describe("popups, dialogs, files and requests", () => {
  verified(
    "waitForEvent('popup') returns the new Page, and click receipts list popups",
    ["spaces.create", "page.goto", "page.click", "page.waitForEvent", "page.waitForURL", "pages.list"],
    async () => {
      const out = await zeniusJson(
        context,
        `${open("/popup")}const popupPromise = page.waitForEvent("popup");
await page.click("#open");
const popup = await popupPromise;
await popup.waitForURL("**/two");
const receipt = await page.click("#open");
console.log(JSON.stringify({ label: popup.label, labels: (await task.pages()).map((p) => p.label), receipt }));`,
      );
      assert.equal(out.label, "p2");
      assert.deepEqual(out.labels, ["p1", "p2", "p3"]);
      assert.equal(out.receipt.popups?.[0]?.label, "p3");
    },
  );

  verified(
    "dialogs show in receipts and are accepted or dismissed",
    ["spaces.create", "page.goto", "page.click", "page.acceptDialog", "page.dismissDialog", "page.evaluate"],
    async () => {
      const out = await zeniusJson(
        context,
        `${open("/dialogs")}const alert = (await page.click("#alert")).dialog;
const accepted = await page.acceptDialog();
await page.click("#prompt");
await page.acceptDialog("zen");
await page.click("#confirm");
const dismissed = await page.dismissDialog();
const none = await page.dismissDialog();
const state = await page.evaluate(() => ({ answer: ${noted("answer")}, confirmed: ${noted("confirmed")} }));
console.log(JSON.stringify({ alert, accepted, dismissed, none, state }));`,
      );
      assert.deepEqual({ type: out.alert?.type, message: out.alert?.message }, { type: "alert", message: "hi from the fixture" });
      assert.deepEqual([out.accepted, out.dismissed, out.none], [true, true, false]);
      assert.deepEqual(out.state, { answer: "zen", confirmed: false });
    },
  );

  // The observe layer's dialog methods without the input layer's click: goto reports a
  // dialog the page opens while it loads (PROTOCOL: goto and reload receipts).
  verified(
    "a dialog that opens while the page loads shows in goto's receipt, and closes once",
    ["spaces.create", "page.goto", "page.acceptDialog", "page.dismissDialog", "page.evaluate"],
    async () => {
      const out = await zeniusJson(
        context,
        `const task = await taskSpace(${json(unique("it dialog on load"))});
const page = task.page("p1");
const prompt = (await page.goto(${json(`${context.base}/prompt-on-load`)})).dialog;
const accepted = await page.acceptDialog("zen");
const again = await page.acceptDialog();
const answer = await page.evaluate(() => ${noted("answer")});
const confirm = (await page.goto(${json(`${context.base}/confirm-on-load`)})).dialog;
const dismissed = await page.dismissDialog();
const none = await page.dismissDialog();
const confirmed = await page.evaluate(() => ${noted("confirmed")});
console.log(JSON.stringify({ prompt, accepted, again, answer, confirm, dismissed, none, confirmed }));`,
      );
      assert.deepEqual(
        { type: out.prompt?.type, message: out.prompt?.message, defaultPrompt: out.prompt?.defaultPrompt },
        { type: "prompt", message: "name?", defaultPrompt: "guest" },
      );
      assert.equal(out.confirm?.type, "confirm");
      assert.deepEqual([out.accepted, out.again, out.dismissed, out.none], [true, false, true, false]);
      assert.equal(out.answer, "zen");
      assert.equal(out.confirmed, false);
    },
  );

  verified(
    "waitForEvent('download') sees a download a navigation starts, and goto fails as Ego's does",
    ["spaces.create", "page.goto", "page.waitForEvent", "download.saveAs", "download.path", "download.failure"],
    async () => {
      const target = join(scratch, "downloads", "navigated.txt");
      const out = await zeniusJson(
        context,
        `${open("/")}const downloadPromise = page.waitForEvent("download");
let gotoError;
try { await page.goto(${json(`${context.base}/file.txt`)}); } catch (error) { gotoError = { code: error.code, message: error.message }; }
const download = await downloadPromise;
await download.saveAs(${json(target)});
console.log(JSON.stringify({ gotoError, url: download.url(), name: download.suggestedFilename(), failure: await download.failure(), path: await download.path() }));`,
      );
      // Ego: a plain Error, no code (page-waits.ts), with Ego's text first and then what to do next.
      assert.deepEqual(out.gotoError, {
        message:
          "page.goto failed: navigation started a download\n" +
          'This URL downloads a file instead of opening a page: start page.waitForEvent("download") before page.goto(), let the goto fail, and save the file with download.saveAs().',
      });
      assert.match(out.url, /\/file\.txt$/);
      assert.equal(out.name, "report.txt");
      assert.equal(out.failure, null);
      assert.equal(readFileSync(target, "utf8"), "zenius download fixture\n");
      keptInWorkingFolder(out.path);
    },
  );

  verified(
    "waitForEvent('download') returns a Download that saves where asked, and its file stays in the working folder",
    ["spaces.create", "page.goto", "page.click", "page.waitForEvent", "download.saveAs", "download.path", "download.failure"],
    async () => {
      const target = join(scratch, "downloads", "report.txt");
      const out = await zeniusJson(
        context,
        `${open("/files")}const downloadPromise = page.waitForEvent("download");
await page.click("#download");
const download = await downloadPromise;
await download.saveAs(${json(target)});
console.log(JSON.stringify({ url: download.url(), name: download.suggestedFilename(), failure: await download.failure(), path: await download.path() }));`,
      );
      assert.match(out.url, /\/file\.txt$/);
      assert.equal(out.name, "report.txt");
      assert.equal(out.failure, null);
      assert.equal(readFileSync(target, "utf8"), "zenius download fixture\n");
      keptInWorkingFolder(out.path);
    },
  );

  verified(
    "setInputFiles() and the file chooser set files on inputs",
    ["spaces.create", "page.goto", "page.setInputFiles", "page.click", "page.waitForEvent", "filechooser.setFiles", "page.evaluate"],
    async () => {
      const file = join(scratch, "upload.txt");
      writeFileSync(file, "upload fixture\n");
      const out = await zeniusJson(
        context,
        `${open("/files")}await page.setInputFiles("#file", [${json(file)}]);
const chooserPromise = page.waitForFileChooser();
await page.click("#pick");
const chooser = await chooserPromise;
const multiple = chooser.isMultiple();
await chooser.setFiles(${json(file)});
const seen = await page.evaluate(async () => {
  const [file, hidden] = ["#file", "#hidden"].map((selector) => document.querySelector(selector).files[0]);
  return {
    file: { name: file?.name, type: file?.type, text: await file?.text(), lastModified: file?.lastModified },
    hidden: { name: hidden?.name, type: hidden?.type, text: await hidden?.text() },
  };
});
console.log(JSON.stringify({ multiple, seen }));`,
      );
      // The CLI read the file and sent its contents (SPEC I5); the page sees
      // what a real pick gives it, with Gecko's type for the name.
      assert.deepEqual(out, {
        multiple: false,
        seen: {
          file: { name: "upload.txt", type: "text/plain", text: "upload fixture\n", lastModified: Math.round(statSync(file).mtimeMs) },
          hidden: { name: "upload.txt", type: "text/plain", text: "upload fixture\n" },
        },
      });
    },
  );

  verified(
    "setInputFiles() and the file chooser upload a folder to an input with webkitdirectory",
    ["spaces.create", "page.goto", "page.setInputFiles", "page.click", "page.waitForEvent", "filechooser.setFiles", "page.evaluate"],
    async () => {
      const album = join(scratch, "album");
      mkdirSync(join(album, "2024"), { recursive: true });
      writeFileSync(join(album, "2024", "a.txt"), "ay\n");
      writeFileSync(join(album, ".hidden"), "h\n");
      writeFileSync(join(album, "b.txt"), "bee\n");
      const out = await zeniusJson(
        context,
        `${open("/folders")}await page.setInputFiles("#dir", ${json(album)});
const chooserPromise = page.waitForFileChooser();
await page.click("#pickDir");
const chooser = await chooserPromise;
await chooser.setFiles(${json(album)});
const seen = await page.evaluate(async () => {
  const read = async (selector) => {
    const files = [...document.querySelector(selector).files];
    files.sort((a, b) => (a.webkitRelativePath < b.webkitRelativePath ? -1 : 1));
    return Promise.all(files.map(async (file) => ({ name: file.name, path: file.webkitRelativePath, type: file.type, text: await file.text(), lastModified: file.lastModified })));
  };
  return { dir: await read("#dir"), hidden: await read("#hiddenDir") };
});
console.log(JSON.stringify(seen));`,
      );
      // The CLI walked the folder and sent each file with its path in it; the
      // page reads that as webkitRelativePath, as from the user's own pick.
      const expected = [".hidden", "2024/a.txt", "b.txt"].map((path) => ({
        name: path.slice(path.lastIndexOf("/") + 1),
        path: `album/${path}`,
        type: path.endsWith(".txt") ? "text/plain" : "",
        text: readFileSync(join(album, path), "utf8"),
        lastModified: Math.round(statSync(join(album, path)).mtimeMs),
      }));
      assert.deepEqual(out, { dir: expected, hidden: expected });
    },
  );

  verified("page.fetch() runs in the Page and can save the body", ["spaces.create", "page.goto", "page.fetch"], async () => {
    const target = join(scratch, "fetched", "body.json");
    const out = await zeniusJson(
      context,
      `${open("/")}const response = await page.fetch("/api/json", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
await page.fetch("/api/json", { saveAs: ${json(target)} });
console.log(JSON.stringify(response));`,
    );
    assert.equal(out.ok, true);
    assert.equal(out.status, 200);
    assert.deepEqual(JSON.parse(out.body), { hello: "zen", method: "POST" });
    assert.equal(JSON.parse(readFileSync(target, "utf8")).hello, "zen");
  });

  verified(
    "page.events() and page.fetch() give a credential header's name and never its value: Cookie, Set-Cookie and Authorization, both ways",
    ["spaces.create", "page.goto", "page.fetch", "page.events"],
    async () => {
      const out = await zeniusJson(
        context,
        `${open("/creds")}const fetched = await page.fetch("/api/creds", { headers: { authorization: ${json(`Bearer ${CREDENTIALS.bearerSent}`)} } });
let events = [];
for (let i = 0; i < 40 && !events.some((e) => e.method === "Network.responseReceived" && e.params.response.url.endsWith("/api/creds")); i++) {
  events = events.concat(await page.events());
  await new Promise((r) => setTimeout(r, 50));
}
console.log(JSON.stringify({ fetched, events }));`,
      );
      assert.deepEqual(JSON.parse(out.fetched.body), { sawAuthorization: true, sawCookie: true }, "the request carried the header and the HttpOnly cookie");
      const text = JSON.stringify(out);
      for (const value of Object.values(CREDENTIALS)) assert.ok(!text.includes(value), `a credential's value reached the script: ${value}`);
      const sent = out.events.find((e: any) => e.method === "Network.requestWillBeSent" && e.params.request.url.endsWith("/api/creds"));
      const got = out.events.find((e: any) => e.method === "Network.responseReceived" && e.params.response.url.endsWith("/api/creds"));
      const shown = out.events.find((e: any) => e.method === "Network.responseReceived" && e.params.response.url.endsWith("/creds") && !e.params.response.url.endsWith("/api/creds"));
      assert.deepEqual([sent?.params.request.headers.authorization, sent?.params.request.headers.cookie], ["<redacted>", "<redacted>"]);
      assert.deepEqual(
        [got?.params.response.headers["set-cookie"], got?.params.response.headers.authorization, got?.params.response.headers.cookie],
        ["<redacted>", "<redacted>", "<redacted>"],
      );
      assert.equal(shown?.params.response.headers["set-cookie"], "<redacted>", "the page's own Set-Cookie");
      assert.deepEqual([out.fetched.headers.authorization, out.fetched.headers.cookie], ["<redacted>", "<redacted>"]);
    },
  );
});
