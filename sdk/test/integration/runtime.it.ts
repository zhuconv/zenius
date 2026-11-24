// The CLI and SDK against a real headless dev Zen: the core path. Run through
// sdk/scripts/test-integration.sh, which starts a fresh instance and sets
// ZENIUS_INSTANCE. Cases whose runtime methods have not landed yet are
// skipped and named, so this suite grows as the other workers merge.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runCli } from "../helpers.ts";
import { needs, unique, useContext, zenius } from "./context.ts";
import { noted } from "./fixtures.ts";

const context = useContext();
const run = (script: string) => zenius(context, script);

describe(`zenius against instance ${context.instance}`, () => {
  it("creates a task space with p1, navigates and evaluates", async (t) => {
    if (!needs(t, context, "spaces.list", "spaces.create", "page.goto", "page.evaluate")) return;
    const name = unique("it basics");
    const result = await run(`
const task = await taskSpace(${JSON.stringify(name)});
const page = task.page("p1");
const receipt = await page.goto(${JSON.stringify(`${context.base}/`)});
const url = await page.evaluate(() => location.href);
const state = await page.evaluate(() => ({ title: document.title, answer: ${noted("answer")} }));
const sum = await page.evaluate(({ a, b }) => a + b, { a: 20, b: 22 });
const text = await page.evaluate("document.querySelector('#greeting').textContent");
const again = await taskSpace(${JSON.stringify(name)});
console.log(JSON.stringify({ id: task.spaceId, same: again.spaceId === task.spaceId, receipt: typeof receipt, url, state, sum, text }));
`);
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.same, true);
    assert.equal(out.receipt, "object", "goto() returns Ego's action receipt");
    assert.equal(out.url, `${context.base}/`);
    assert.deepEqual(out.state, { title: "sdk fixture", answer: 42 });
    assert.equal(out.sum, 42);
    assert.equal(out.text, "hello from the fixture");
  });

  it("opens and lists Pages; labels persist across processes", async (t) => {
    if (!needs(t, context, "spaces.create", "pages.new", "pages.list", "page.goto", "page.evaluate")) return;
    const first = await run(`
const task = await taskSpace(${JSON.stringify(unique("it pages"))});
const p2 = await task.newPage();
await p2.goto(${JSON.stringify(`${context.base}/two`)});
console.log(task.spaceId, p2.label, p2.targetId);
`);
    assert.equal(first.code, 0, first.stderr);
    const [id, label, targetId] = first.stdout.trim().split(" ");
    assert.equal(label, "p2");
    assert.match(targetId!, /\S/);
    const second = await run(`
const task = await taskSpace(${id});
// Ego answers from its ledger before anything lists the Pages.
console.log(task.page("p2").targetId, task.page("p2").openedBy);
console.log(JSON.stringify((await task.pages()).map((page) => page.label)));
console.log(await task.page("p2").evaluate(() => document.title));
`);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, `${targetId} agent\n["p1","p2"]\nsdk fixture two\n`);
  });

  it("names a missing label in task terms", async (t) => {
    if (!needs(t, context, "spaces.create", "page.evaluate")) return;
    const result = await run(`const task = await taskSpace(${JSON.stringify(unique("it labels"))});
await task.page("p7").evaluate("1");`);
    assert.equal(result.code, 1);
    // What happened, then the task's own next step on a line of its own.
    assert.match(result.stderr, /ZEN_PAGE_NOT_FOUND\]: [^\n]*\ntask\.page\("p7"\) only refers to an existing Page/);
  });

  it("a failed navigation reaches the script with its line", async (t) => {
    if (!needs(t, context, "spaces.create", "page.goto")) return;
    const result = await run(`const task = await taskSpace(${JSON.stringify(unique("it nav"))});
await task.page("p1").goto("http://127.0.0.1:9/");`);
    assert.equal(result.code, 1);
    // Ego throws a plain "page.goto failed: …" Error; the skeleton's goto still sends a coded one.
    assert.match(result.stderr, /^(Error: page\.goto failed: |ZeniusError \[ZEN_NAVIGATION_FAILED\]: page\.goto: )/);
    assert.match(result.stderr, /at script\.js:2:/);
  });

  it("does not change what the user sees (I1)", async (t) => {
    if (!needs(t, context, "dev.viewState", "spaces.create", "pages.new", "page.goto")) return;
    const before = await context.rpc.call("dev.viewState");
    const result = await run(`const task = await taskSpace(${JSON.stringify(unique("it view"))});
await task.page("p1").goto(${JSON.stringify(`${context.base}/`)});
await (await task.newPage()).goto(${JSON.stringify(`${context.base}/two`)});`);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await context.rpc.call("dev.viewState"), before);
  });

  it("finish({ keep: [] }) closes the space", async (t) => {
    if (!needs(t, context, "spaces.create", "spaces.finish", "spaces.list")) return;
    const result = await run(`const task = await taskSpace(${JSON.stringify(unique("it finish"))});
const receipt = await task.finish({ keep: [] });
const listed = (await listTaskSpaces()).some((space) => space.id === task.spaceId);
console.log(JSON.stringify({ receipt, listed }));`);
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.receipt.closedSpace, true);
    assert.equal(out.listed, false);
  });

  // zen-core's page.flag: the SDK checks only that the reason is a string, so
  // the runtime's rules (one line, 1 to 200 characters) are the ones that hold.
  it("page.flag(reason) flags the loaded page and returns nothing; the runtime refuses an empty, multi-line or long reason", async (t) => {
    if (!needs(t, context, "spaces.create", "page.goto", "page.flag")) return;
    const result = await run(`const task = await taskSpace(${JSON.stringify(unique("it flag"))});
const page = task.page("p1");
await page.goto(${JSON.stringify(`${context.base}/`)});
const flagged = await page.flag("Asks for the user's bank password, which the task doesn't need");
const refused = [];
for (const reason of ["", "two\\nlines", "x".repeat(201)]) {
  try {
    await page.flag(reason);
    refused.push("accepted");
  } catch (error) {
    refused.push(error.code);
  }
}
await task.finish({ keep: [] });
console.log(JSON.stringify({ flagged: flagged ?? null, refused }));`);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { flagged: null, refused: ["ZEN_INVALID_ARGUMENT", "ZEN_INVALID_ARGUMENT", "ZEN_INVALID_ARGUMENT"] });
  });

  it("snapshot prints Ego's header and tree", async (t) => {
    if (!needs(t, context, "spaces.create", "page.goto", "page.snapshot")) return;
    const result = await run(`const task = await taskSpace(${JSON.stringify(unique("it snapshot"))});
await task.page("p1").goto(${JSON.stringify(`${context.base}/`)});
console.log(await task.page("p1").snapshot());`);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^\[p1 "sdk fixture" \| space /);
    assert.match(result.stdout, /hello from the fixture/);
  });

  it("zenius doctor passes the dev instance it checks", async (t) => {
    if (!needs(t, context, "browser.version", "browser.health", "browser.methods")) return;
    const result = await runCli(["doctor", "--json", "--instance", context.instance]);
    assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
    const report = JSON.parse(result.stdout) as { checks: { id: string; status: string; summary: string }[] };
    assert.deepEqual(Object.fromEntries(report.checks.map((check) => [check.id, check.status])), {
      cli: "ok",
      zen: "ok",
      autoconfig: "ok",
      profile: "ok",
      loader: "ok",
      runtime: "ok",
      instance: "ok",
      // zenius's sidebar and its MCP server are checked in the daily profile only.
      sidebar: "skip",
      mcp: "skip",
      daily: "skip",
      boundary: "ok",
      // A dev profile has no install.sh lines, so the user's DNS choice isn't checked.
      dns: "skip",
      pagecode: "ok",
    });
    assert.match(report.checks.find((check) => check.id === "zen")!.summary, /\(from the running instance, pid \d+\)$/);
    // I5, from the real runtime's browser.health.i5 (zen-observe's).
    assert.equal(
      report.checks.find((check) => check.id === "boundary")!.summary,
      "agents load only http:, https:, data:, blob: and about:blank; page gate on; self-tests refused about:config, file:/// and a browser document",
    );
    // I4's webdriver check reads browser.health: a Zen started without
    // Marionette or the Remote Agent reports false.
    const health = await context.rpc.call<{ webdriver?: boolean }>("browser.health");
    if (health && "webdriver" in health) assert.equal(health.webdriver, false);
  });

  it("feedback.compose's report names the failed call and its code, and nothing of the page", async (t) => {
    if (!needs(t, context, "feedback.compose", "browser.version", "spaces.create", "page.goto")) return;
    const name = unique("it feedback");
    const failed = await run(`const task = await taskSpace(${JSON.stringify(name)});
await task.page("p1").goto("http://127.0.0.1:9/feedback-secret-path?token=s3cret");`);
    assert.equal(failed.code, 1);
    const { zenVersion } = await context.rpc.call<{ zenVersion: string }>("browser.version");

    // Straight to the runtime, without propose: the report itself, with no
    // sidebar needed to show it.
    const params = { line: "page.goto to a closed port failed", cli: { version: "9.9.9", protocol: 1 }, node: process.versions.node };
    const report = await context.rpc.call<{ id: string; title: string; body: string }>("feedback.compose", params);
    assert.ok(report.id, "the report's id");
    const code = /^zenius 9\.9\.9: (ZEN_[A-Z_]+) in page\.goto$/.exec(report.title)?.[1];
    assert.ok(code, report.title);
    assert.ok(report.body.includes("\n    page.goto to a closed port failed\n"), report.body);
    assert.ok(report.body.includes(`\npage.goto: ${code} after `), report.body);
    assert.match(report.body, new RegExp(`\\n\\| page\\.goto \\| \\d+ \\| ${code} \\|\\n`));
    assert.ok(report.body.includes(`\n- Zen ${zenVersion}\n`), report.body);
    for (const text of ["feedback-secret", "s3cret", "127.0.0.1", context.base, name]) {
      assert.ok(!report.title.includes(text) && !report.body.includes(text), `the report holds ${text}`);
    }
  });

  it("click follows a link and waitForURL sees it", async (t) => {
    if (!needs(t, context, "spaces.create", "page.goto", "page.click", "page.waitForURL")) return;
    const result = await run(`const task = await taskSpace(${JSON.stringify(unique("it click"))});
const page = task.page("p1");
await page.goto(${JSON.stringify(`${context.base}/`)});
await page.click("#next", { label: "open page two" });
await page.waitForURL("**/two");
console.log(await page.evaluate(() => document.title));`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "sdk fixture two\n");
  });
});
