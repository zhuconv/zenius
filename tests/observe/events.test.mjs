// page.events() records (dialogs, network, console) and page.fetch, after
// Ego's page-events and page-fetch behavior.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup, timed } from "./lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(() => env.close());

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Drain events until `pred` holds for one of them (they arrive asynchronously). */
async function eventsUntil(page, pred, ms = 2000) {
  const seen = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    seen.push(...(await page.call("page.events")));
    if (seen.some(pred)) {
      return seen;
    }
    await sleep(25);
  }
  assert.fail(`no matching event in ${JSON.stringify(seen.map(e => e.method))}`);
}

test("events: console calls as Runtime.consoleAPICalled, drained once", () =>
  env.inSpace("events console", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.call("page.events");
    await page.evaluate("console.log('hello', 7, true, null); console.warn('careful'); console.error('broken')");
    const events = await eventsUntil(page, e => e.params?.args?.[0]?.value === "broken");
    const calls = events.filter(e => e.method === "Runtime.consoleAPICalled").map(e => e.params);
    assert.deepEqual(
      calls.map(c => [c.type, c.args.map(a => a.value)]),
      [
        ["log", ["hello", 7, true, null]],
        ["warning", ["careful"]],
        ["error", ["broken"]],
      ]
    );
    assert.deepEqual(calls[0].args.map(a => a.type), ["string", "number", "boolean", "object"]);
    assert.equal(typeof calls[0].timestamp, "number");
    assert.deepEqual(await page.call("page.events"), [], "drained");
  }));

test("events: a request's Network records, a dialog's opening and closing", () =>
  env.inSpace("events network dialog", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.call("page.events");
    const url = `${env.base}/api/text?events=1`;
    await page.evaluate(u => fetch(u).then(r => r.text()), url);
    const events = await eventsUntil(page, e => e.method === "Network.loadingFinished");
    const sent = events.find(e => e.method === "Network.requestWillBeSent" && e.params.request.url === url);
    assert.ok(sent, JSON.stringify(events.map(e => e.method)));
    assert.equal(sent.params.request.method, "GET");
    assert.equal(sent.params.type, "Fetch");
    const response = events.find(e => e.method === "Network.responseReceived" && e.params.requestId === sent.params.requestId);
    assert.equal(response?.params.response.status, 200);
    assert.equal(response.params.response.url, url);

    await page.evaluate("setTimeout(() => { window.answer = confirm('sure?') }, 0)");
    const opened = await eventsUntil(page, e => e.method === "Page.javascriptDialogOpening");
    assert.deepEqual(opened.find(e => e.method === "Page.javascriptDialogOpening").params, {
      url: `${env.base}/nav-target`,
      message: "sure?",
      type: "confirm",
      hasBrowserHandler: false,
    });
    assert.equal(await page.call("page.acceptDialog"), true);
    const closed = await eventsUntil(page, e => e.method === "Page.javascriptDialogClosed");
    assert.deepEqual(closed.find(e => e.method === "Page.javascriptDialogClosed").params, { result: true, userInput: "" });
    assert.equal(await page.evaluate("window.answer"), true);
  }));

test("page.fetch: a text body, or the bytes for the client to save", () =>
  env.inSpace("fetch", async page => {
    await page.goto(`${env.base}/nav-target`);
    const r = await page.call("page.fetch", { url: "/api/text" });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.url, `${env.base}/api/text`);
    assert.equal(r.headers["content-type"], "text/plain");
    assert.equal(r.body, "server text fixture");

    // I5: the SDK's saveAs sends binary and writes bodyBase64 itself.
    const binary = await page.call("page.fetch", { url: `${env.base}/api/image.png`, options: { binary: true } });
    assert.equal(binary.status, 200);
    assert.equal(binary.body, undefined);
    assert.equal(binary.savedPath, undefined);
    const bytes = Buffer.from(binary.bodyBase64, "base64");
    assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47], "a PNG");

    const post = await page.call("page.fetch", {
      url: "/api/header",
      options: { method: "POST", headers: { "x-e2e": "zen" }, body: "x" },
    });
    assert.equal(post.status, 200);
    assert.equal(post.body, "zen", "the request's own headers reach the server");
  }));

test("page.fetch: Ego's texts for CORS, a timeout and bad options", () =>
  env.inSpace("fetch errors", async page => {
    await page.goto(`${env.base}/nav-target`);
    const cross = `${env.base.replace("127.0.0.1", "localhost")}/nav-target`;
    const cors = await page.fail("page.fetch", { url: cross });
    assert.equal(cors.code, "ZEN_FETCH_FAILED");
    assert.equal(
      cors.message,
      `page.fetch uses window.fetch and obeys browser CORS. Request ${JSON.stringify(cross)} from ${JSON.stringify(env.base)} failed: TypeError: Failed to fetch`
    );
    const { value: slow, ms } = await timed(() =>
      page.fail("page.fetch", { url: "/api/slow?ms=3000&case=fetch-timeout", options: { timeout: 300 } })
    );
    assert.equal(slow.message, "page.fetch timed out after 300ms");
    assert.ok(ms < 1500, `took ${ms} ms`);
    for (const saveAs of ["/tmp/zenius-i5-fetch.bin", "out.bin"]) {
      const path = await page.fail("page.fetch", { url: "/api/text", options: { saveAs } });
      assert.equal(path.code, "ZEN_INVALID_ARGUMENT");
      assert.equal(path.message, "page.fetch takes no saveAs path: send binary: true, and the client writes bodyBase64 to the file");
    }
    const notBool = await page.fail("page.fetch", { url: "/api/text", options: { binary: "yes" } });
    assert.equal(notBool.message, "page.fetch binary must be a boolean");
    const unknown = await page.fail("page.fetch", { url: "/api/text", options: { retries: 2 } });
    assert.equal(unknown.message, "page.fetch received unknown option: retries. Expected: await page.fetch(url, options?)");
  }));
