// Each task's recent steps (input/steps.sys.mjs; the user's ask of
// 2026-11-21): every zenius task shows in the sidebar,
// whoever drives it, and its view lists what the agent did. zen-core's
// dispatcher tells the ring of each call a client made; zen-ux reads it
// beside zen-core's task feed (stepsOf, onStep). A step is a line the user
// reads, and it lasts (zen-snapshot's points): never what the agent typed,
// pasted or chose, nor code or a value; a navigation shows its origin only;
// a name from the page is one line, without invisible characters, capped,
// and can't close its quotes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { openHarness } from "./harness.mjs";

let h;
let site;

const FORM = `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<form onsubmit="event.preventDefault()">
  <label for="email">Email</label> <input id="email" name="email">
  <label>Password <input id="pw" type="password"></label>
  <select id="country" aria-label="Country"><option>Canada</option><option>Peru</option></select>
  <button id="signin" type="button">Sign in</button>
  <input id="go" type="submit" value="Continue">
  <div id="draft" contenteditable="true">my private draft</div>
  <textarea id="notes">a note the page prefilled</textarea>
  <button id="forged" type="button"></button>
  <label>Resume <input id="resume" type="file"></label>
</form>
<script>
  // A name made to read as something else: quotes, a line break, bidi and
  // zero-width characters, and far too long.
  document.getElementById("forged").textContent =
    'Pay" · Needs you\\n\\u202Eevil\\u200B\\u2028 ' + "x".repeat(300);
</script>`;

before(async () => {
  h = await openHarness("steps");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(FORM);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  site = {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
});

after(async () => {
  await site?.close();
  await h?.finish();
});

const STEPS = `const S = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/steps.sys.mjs");`;
const chrome = (code, arg) => h.call("dev.evalChrome", { code, arg });
const stepsOf = space => chrome(`${STEPS} return S.stepsOf(arg);`, space);
const texts = async space => (await stepsOf(space)).map(s => s.text);
const describe = (method, params, target) => chrome(`${STEPS} return S.describeCall(arg.method, arg.params, arg.target);`, { method, params, target });

/** A new task with one page at the form, its URL carrying a token. */
async function formTask(name) {
  const task = await h.taskSpace(`${name} ${Date.now()}`);
  const page = await task.newPage();
  await page.goto(`${site.origin}/form?token=SECRET123#frag`);
  return { task, page, space: task.spaceId };
}

test("a task's steps are its calls as the user reads them, in order, with their time and outcome; queries aren't steps, and nothing typed, pasted, chosen or run shows", async () => {
  const started = Date.now();
  const { page, space } = await formTask("zen-input steps");
  const P = { space, page: page.label };
  await page.click("#signin");
  await page.fill("#email", "someone@example.com");
  await page.fill("#email", "");
  await page.fill("#pw", "hunter2");
  await page.press("#email", "Enter");
  await page.keyboard.type("typed-secret");
  await page.keyboard.press("a");
  await page.keyboard.press("Shift+B");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.paste({ text: "pasted-secret", html: "<b>pasted-secret</b>" });
  await page.selectOption("#country", "Peru");
  await page.click("#go");
  await page.click("#draft");
  await page.click("#notes");
  await h.call("page.snapshot", { ...P, options: {} });
  await h.call("page.evaluate", { ...P, isFunction: false, fn: "'code-secret'.length" });
  await h.call("page.url", P);
  await h.call("page.title", P);
  await h.call("pages.list", { space });
  const failed = await h.call("page.click", { ...P, target: "text=Nowhere to be found", options: { timeout: 300 } }).then(
    () => null,
    e => e
  );
  assert.ok(failed, "the click on nothing failed");

  const steps = await stepsOf(space);
  const accel = h.platform === "darwin" ? "Cmd" : "Control";
  assert.deepEqual(
    steps.map(s => s.text),
    [
      "Open a new tab",
      `Open ${site.origin}`,
      'Click "Sign in"',
      'Type into "Email"',
      'Clear "Email"',
      'Type into "Password"',
      'Press Enter on "Email"',
      "Type text",
      "Press a key",
      "Press a key",
      `Press ${accel}+A`,
      "Paste text",
      'Choose in "Country"',
      'Click "Continue"',
      "Click an editable area",
      "Click a field",
      "Read the page",
      "Run code in the page",
      'Click "Nowhere to be found"',
    ]
  );
  assert.deepEqual(
    steps.map(s => s.method),
    [
      "pages.new",
      "page.goto",
      "page.click",
      "page.fill",
      "page.fill",
      "page.fill",
      "page.press",
      "page.keyboard",
      "page.keyboard",
      "page.keyboard",
      "page.keyboard",
      "page.keyboard",
      "page.selectOption",
      "page.click",
      "page.click",
      "page.click",
      "page.snapshot",
      "page.evaluate",
      "page.click",
    ]
  );
  assert.deepEqual(steps.at(-1).outcome, failed.code, "a failed call's outcome is its error's code");
  assert.ok(steps.slice(0, -1).every(s => s.outcome === "ok"), "the rest went through");
  const ids = steps.map(s => s.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "ids grow");
  for (const s of steps) {
    assert.ok(s.at >= started - 1000 && s.at <= Date.now(), `${s.text}: its time`);
    assert.ok(Number.isFinite(s.ms) && s.ms >= 0, `${s.text}: its duration`);
    assert.equal(s.page, s.method === "pages.new" ? null : page.label, `${s.text}: its tab`);
  }
  const all = JSON.stringify(steps);
  for (const secret of [
    "SECRET123",
    "token",
    "frag",
    "/form",
    "someone@example.com",
    "hunter2",
    "typed-secret",
    "pasted-secret",
    "Peru",
    "Canada",
    "code-secret",
    "my private draft",
    "a note the page prefilled",
    '"b"',
    '"B"',
  ]) {
    assert.ok(!all.includes(secret), `no step shows ${JSON.stringify(secret)}`);
  }
});

test("a name from the page is one line, without invisible or control characters, capped, and can't close its quotes", async () => {
  const { page, space } = await formTask("zen-input steps names");
  await page.click("#forged");
  const text = (await texts(space)).at(-1);
  assert.match(text, /^Click "Pay' · Needs you evil x+…"$/, JSON.stringify(text));
  assert.ok(!/[\n\r\u2028\u2029\u202E\u200B]/.test(text), JSON.stringify(text));
  const name = text.slice('Click "'.length, -1);
  assert.equal(Array.from(name).length, 60, "the name is capped at 60 characters");
});

test("a file chooser's answer is a step of its page's task, though the call names only the chooser; no file name shows", async () => {
  const { page, space } = await formTask("zen-input steps chooser");
  const waiting = page.waitForFileChooser({ timeout: 5000 });
  await page.click("#resume");
  const chooser = await waiting;
  const file = h.join(h.artifactDir, "zen-input-steps-cv-secret.txt");
  await (await import("node:fs/promises")).writeFile(file, "cv");
  await chooser.setFiles([file]);
  const steps = await stepsOf(space);
  assert.deepEqual(
    steps.slice(-3).map(s => [s.method, s.text, s.page]),
    [
      ["page.waitForEvent", "Wait for a file chooser", page.label],
      ["page.click", 'Click "Resume"', page.label],
      ["filechooser.setFiles", "Attach 1 file", page.label],
    ]
  );
  assert.ok(!JSON.stringify(steps).includes("cv-secret"), "no file name shows");
});

test("a step shows while its call runs, and onStep tells of it as it begins and as it ends", async () => {
  const { page, space } = await formTask("zen-input steps events");
  await chrome(`${STEPS} win.__zenInputSteps = []; win.__zenInputStepsOff = S.onStep(e => win.__zenInputSteps.push(e)); return true;`);
  try {
    const P = { space, page: page.label };
    const waiting = h.call("page.waitForSelector", { ...P, target: "text=Later", options: { timeout: 10_000 } });
    await h.until(async () => (await stepsOf(space)).at(-1)?.method === "page.waitForSelector", "the wait's step");
    const running = (await stepsOf(space)).at(-1);
    assert.deepEqual([running.text, running.outcome, running.ms], ['Wait for "Later"', "running", null], "it shows while it runs");
    await h.asUser(page, `document.body.append(Object.assign(document.createElement("p"), { textContent: "Later" })); return true;`);
    await waiting;
    await page.click("#signin");
    const steps = (await stepsOf(space)).slice(-2);
    assert.deepEqual(
      steps.map(s => [s.id, s.text, s.outcome]),
      [
        [running.id, 'Wait for "Later"', "ok"],
        [steps[1].id, 'Click "Sign in"', "ok"],
      ],
      "the same step, settled; then the click's"
    );
    const seen = await chrome(`return win.__zenInputSteps.filter(e => e.space === arg);`, space);
    assert.deepEqual(
      seen.map(e => [e.step.id, e.step.outcome]),
      [
        [running.id, "running"],
        [running.id, "ok"],
        [steps[1].id, "running"],
        [steps[1].id, "ok"],
      ]
    );
    // The click's name came from the page as it ended: it began as the selector's.
    assert.deepEqual(seen.slice(2).map(e => e.step.text), ["Click an element", 'Click "Sign in"']);
    assert.deepEqual(seen.at(-1), { space, step: steps[1] });
  } finally {
    await chrome(`win.__zenInputStepsOff?.(); delete win.__zenInputSteps; return true;`);
  }
});

test("a task keeps its last 50 steps; tasks keep their own, and a finished task's stay readable", async () => {
  const a = await formTask("zen-input steps ring a");
  const b = await formTask("zen-input steps ring b");
  for (let i = 0; i < 55; i++) {
    await a.page.focus("#email");
  }
  await b.page.click("#signin");
  const stepsA = await stepsOf(a.space);
  assert.equal(stepsA.length, 50);
  assert.ok(stepsA.every(s => s.text === 'Focus "Email"'), "the oldest went first: the tab's opening and load are gone");
  const ids = stepsA.map(s => s.id);
  assert.deepEqual(ids, ids.map((_, i) => ids[0] + i), "the last 50, one after another");
  assert.deepEqual(await texts(b.space), ["Open a new tab", `Open ${site.origin}`, 'Click "Sign in"']);
  await h.call("spaces.finish", { space: b.space, keep: [] });
  assert.deepEqual((await texts(b.space)).slice(0, 3), ["Open a new tab", `Open ${site.origin}`, 'Click "Sign in"'], "readable after the finish");
  assert.equal((await texts(b.space)).at(-1), "Finish the task");
});

test("describeCall: origins only, keys only when they're no text, and what no target names", async () => {
  const cases = [
    ["page.goto", { url: "https://user:secret@example.com:8443/a/b?token=1#x" }, undefined, "Open https://example.com:8443"],
    ["page.goto", { url: "https://аpple.com/login" }, undefined, "Open https://xn--pple-43d.com"],
    ["page.goto", { url: "data:text/html,<p>secret</p>" }, undefined, "Open a data: page"],
    ["page.goto", { url: "about:blank" }, undefined, "Open a blank page"],
    ["page.goto", { url: "file:///home/user/secret.html" }, undefined, "Open a local file"],
    ["page.goto", { url: "not a url" }, undefined, "Open a page"],
    ["pages.new", { url: "https://example.com/x?y=1" }, undefined, "Open https://example.com in a new tab"],
    ["page.fetch", { url: "https://api.example.com/v1?key=abc" }, undefined, "Fetch from https://api.example.com"],
    ["page.click", { target: "text=Sign in" }, undefined, 'Click "Sign in"'],
    ["page.click", { target: 'loc=role:button[name="Save"]' }, undefined, 'Click "Save"'],
    ["page.click", { target: 'button:has-text("Pay now")' }, undefined, 'Click "Pay now"'],
    ["page.click", { target: 'role:link[name="Docs"]' }, undefined, 'Click "Docs"'],
    ["page.click", { target: "#login > .btn" }, undefined, "Click an element"],
    ["page.click", { target: "@12" }, undefined, "Click an element"],
    ["page.click", { target: "#x" }, "  Sign\n in  ", 'Click "Sign in"'],
    ["page.dblclick", { target: "#x" }, "Row 3", 'Double-click "Row 3"'],
    ["page.hover", { target: "#x" }, "Menu", 'Hover over "Menu"'],
    ["page.press", { target: "#x", chord: "Shift+A" }, "Name", 'Press a key on "Name"'],
    ["page.press", { target: "#x", chord: "Control+Enter" }, "Name", 'Press Control+Enter on "Name"'],
    ["page.setInputFiles", { target: "#f", files: [{}, {}] }, "Resume", 'Attach 2 files to "Resume"'],
    ["page.setInputFiles", { target: "#f", files: [] }, "Resume", 'Clear the files of "Resume"'],
    ["page.dragAndDrop", { source: "text=Card", target: "text=Done" }, undefined, 'Drag "Card" to "Done"'],
    ["page.keyboard", { action: "down", key: "Shift" }, undefined, "Hold Shift"],
    ["page.keyboard", { action: "up", key: "Shift" }, undefined, "Release Shift"],
    ["page.keyboard", { action: "down", key: "q" }, undefined, "Hold a key"],
    ["page.keyboard", { action: "insertText", text: "secret" }, undefined, "Type text"],
    ["page.mouse", { action: "click", x: 1, y: 2 }, undefined, "Click on the page"],
    ["page.mouse", { action: "wheel", dx: 0, dy: 100 }, undefined, "Scroll the page"],
    ["page.mouse", { action: "move", x: 1, y: 2 }, undefined, "Move the pointer"],
    ["page.snapshot", { options: { scope: "full_page" } }, undefined, "Read the whole page"],
    ["page.snapshot", { options: { scope: "subtree", root: "@3" } }, undefined, "Read part of the page"],
    ["page.waitForEvent", { event: "popup" }, undefined, "Wait for a new tab"],
    ["page.waitForSelector", { target: "text=Done" }, undefined, 'Wait for "Done"'],
    ["page.waitForLoadState", { state: "load" }, undefined, "Wait for the page to load"],
    ["page.acceptDialog", { promptText: "secret" }, undefined, "Accept the page's dialog"],
    ["spaces.handOff", { reason: "sign_in" }, undefined, "Hand the task to the user"],
    ["page.url", {}, undefined, null],
    ["spaces.list", {}, undefined, null],
    ["dev.evalChrome", { code: "1" }, undefined, null],
  ];
  const got = [];
  for (const [method, params, target] of cases) {
    got.push([method, params, target, await describe(method, params, target)]);
  }
  assert.deepEqual(got, cases);
});
