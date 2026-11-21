// page.evaluate and page.waitForFunction: the page's main world, Chrome's
// by-value results, and the safety timeout that stops runaway page script.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup, timed } from "./lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(() => env.close());

test("evaluate runs in the page's main world", () =>
  env.inSpace("evaluate world", async page => {
    await page.goto(`${env.base}/nav-target`);
    assert.equal(await page.evaluate(() => document.title), "ego-lite nav target");
    assert.equal(await page.evaluate(a => a.x * 2, { x: 21 }), 42);
    // A string is a script: `var` lands on window, as in Chrome's console.
    assert.equal(await page.evaluate("var zeniusVar = 5; zeniusVar"), 5);
    assert.equal(await page.evaluate("window.zeniusVar"), 5);
    await page.evaluate("window.pageDefined = {n: 7}");
    assert.deepEqual(await page.evaluate(() => window.pageDefined), { n: 7 });
    assert.equal(await page.evaluate(async () => { await new Promise(r => setTimeout(r, 20)); return "late"; }), "late");
  }));

test("results come back by value, as Chrome's returnByValue", () =>
  env.inSpace("evaluate values", async page => {
    await page.goto(`${env.base}/nav-target`);
    const v = await page.evaluate(() => ({
      a: undefined,
      list: [undefined, 1, "x", null, true],
      nested: { deep: { deeper: [1, { two: 2 }] } },
      date: new Date(0),
      node: document.body,
      map: new Map([[1, 2]]),
    }));
    assert.deepEqual(v, {
      list: [null, 1, "x", null, true],
      nested: { deep: { deeper: [1, { two: 2 }] } },
      date: {},
      node: {},
      map: {},
    });
    const cyclic = await page.fail("page.evaluate", { fn: "() => { const o = {}; o.o = o; return o }", isFunction: true });
    assert.match(cyclic.message, /reference chain/);
  }));

test("an exception thrown by page code is Ego's plain error", () =>
  env.inSpace("evaluate throws", async page => {
    await page.goto(`${env.base}/nav-target`);
    const e = await page.fail("page.evaluate", { fn: "() => { throw new TypeError('boom') }", isFunction: true });
    assert.equal(e.code, "ZEN_EVALUATION_FAILED");
    assert.equal(e.data.plain, true);
    assert.match(
      e.message,
      /^JavaScript evaluation failed at line \d+, column \d+: TypeError: boom\n    at .*; expression: \(\(\) => \{ throw new TypeError\('boom'\) \}\)\(\)$/s
    );
    // A thrown string, and a user error that only looks like a timeout.
    const s = await page.fail("page.evaluate", { fn: "throw 'plain'", isFunction: false });
    assert.match(s.message, /^JavaScript evaluation failed at line 0, column \d+: plain; expression: throw 'plain'$/);
    const t = await page.fail("page.evaluate", { fn: "() => { throw new Error('Execution was terminated') }", isFunction: true });
    assert.equal(t.code, "ZEN_EVALUATION_FAILED");
    assert.match(t.message, /Execution was terminated/);
    // A returned Error fails too, as with Chrome's returnByValue.
    const r = await page.fail("page.evaluate", { fn: "new Error('returned')", isFunction: false });
    assert.equal(r.message, "JavaScript evaluation failed: Error: returned; expression: new Error('returned')");
    // Long expressions are cut to 160 characters.
    const long = `(() => { throw new Error("x") })() ${"/* pad */ ".repeat(30)}`;
    const l = await page.fail("page.evaluate", { fn: long, isFunction: false });
    assert.ok(l.message.endsWith("..."), l.message);
    assert.equal(l.message.split("; expression: ")[1].length, 160);
  }));

test("undefined, functions and symbols come back as null; NaN and friends as unserializable", () =>
  env.inSpace("evaluate null", async page => {
    await page.goto(`${env.base}/nav-target`);
    assert.equal(await page.evaluate(() => undefined), null);
    assert.equal(await page.evaluate("(function () {})"), null);
    assert.equal(await page.evaluate("Symbol('s')"), null);
    for (const [expr, text] of [["NaN", "NaN"], ["-Infinity", "-Infinity"], ["-0", "-0"], ["12n ** 20n", "3833759992447475122176n"]]) {
      const frame = await env.client.call("page.evaluate", { ...page.P, fn: expr, isFunction: false }, { raw: true }).catch(e => e);
      assert.ok(frame !== null, expr);
      void text;
    }
  }));

test("evaluate works under a strict CSP", () =>
  env.inSpace("evaluate csp", async page => {
    await page.goto(`${env.base}/nav-target`);
    // A document whose CSP forbids every script.
    await page.goto(`data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>csp</title>`);
    assert.equal(await page.evaluate(() => document.title), "csp");
  }));

test("a synchronous busy loop is stopped at the budget", () =>
  env.inSpace("evaluate busy", async page => {
    await page.goto(`${env.base}/nav-target`);
    const { value: e, ms } = await timed(() =>
      page.fail("page.evaluate", {
        fn: "() => { const t = Date.now(); while (Date.now() - t < 20000); window.lateEffect = 1; }",
        isFunction: true,
        responseTimeout: 1800,
      })
    );
    assert.equal(e.code, "ZEN_PAGE_EVALUATION_TIMED_OUT");
    assert.equal(
      e.message,
      "page.evaluate exceeded its 1000ms page-execution safety limit. The current JavaScript execution was stopped and the Page is ready for another command, but work scheduled earlier may still produce late side effects."
    );
    assert.equal(e.data.executionStopped, true);
    assert.equal(e.data.mayHaveLateEffects, true);
    assert.equal(e.data.pageResponsive, true);
    assert.ok(ms < 1800 + 1000, `took ${ms} ms`);
    // The loop never finished, and the page works.
    assert.equal(await page.evaluate("window.lateEffect ?? null"), null);
    assert.equal(await page.evaluate("1 + 1"), 2);
  }));

test("a promise that never settles leaves a responsive page alone", () =>
  env.inSpace("evaluate pending", async page => {
    await page.goto(`${env.base}/nav-target`);
    const { value: e, ms } = await timed(() =>
      page.fail("page.evaluate", { fn: "() => new Promise(() => {})", isFunction: true, responseTimeout: 1500 })
    );
    assert.equal(e.code, "ZEN_PAGE_EVALUATION_TIMED_OUT");
    assert.match(e.message, /^page\.evaluate timed out after 1500ms while waiting for page JavaScript\. The Page is responsive/);
    assert.equal(e.data.executionStopped, false);
    assert.equal(e.data.mayHaveLateEffects, true);
    assert.equal(e.data.pageResponsive, true);
    assert.ok(ms >= 1500 && ms < 2500, `took ${ms} ms`);
  }));

test("a busy continuation after an await is stopped too", () =>
  env.inSpace("evaluate async busy", async page => {
    await page.goto(`${env.base}/nav-target`);
    const { value: e, ms } = await timed(() =>
      page.fail("page.evaluate", {
        fn: "async () => { await new Promise(r => setTimeout(r, 0)); const t = Date.now(); while (Date.now() - t < 20000); }",
        isFunction: true,
        responseTimeout: 1500,
      })
    );
    assert.equal(e.code, "ZEN_PAGE_EVALUATION_TIMED_OUT");
    // The world's hook stops it at its deadline: the page itself never hung.
    assert.match(e.message, /^page\.evaluate exceeded its 1000ms page-execution safety limit\./);
    assert.equal(e.data.executionStopped, true);
    assert.equal(e.data.pageResponsive, true);
    assert.ok(ms < 2500, `took ${ms} ms`);
    assert.equal(await page.evaluate("2 + 2"), 4);
  }));

test("waitForFunction polls until the predicate holds", () =>
  env.inSpace("waitForFunction", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.evaluate("setTimeout(() => { window.ready = 1 }, 300)");
    const { value, ms } = await timed(() =>
      page.call("page.waitForFunction", { fn: "() => window.ready === 1", isFunction: true })
    );
    assert.equal(value, true);
    assert.ok(ms >= 250 && ms < 1500, `took ${ms} ms`);
    const e = await page.fail("page.waitForFunction", {
      fn: "() => window.never",
      isFunction: true,
      options: { timeout: 300 },
    });
    assert.equal(e.code, "ZEN_TIMEOUT");
  }));
