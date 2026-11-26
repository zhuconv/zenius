// The input layer's Mac checks: the platform's editing shortcuts, the macOS
// pasteboard never touched, no native file
// picker for agent tabs, and pointer input at the right CSS pixel in a
// visible tab on a Retina display. The eval harness runs them on the Mac in a
// visible dev Zen:
//
//   ZENIUS_INPUT_HEADED=1 tests/input/run.sh tests/input/mac/mac.test.mjs
//
// They pass headless on Linux too (devicePixelRatio 1, Linux shortcuts),
// which keeps them working between Mac runs.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { openHarness } from "../harness.mjs";

const MAC = process.platform === "darwin";
const HEADED = process.env.ZENIUS_INPUT_HEADED === "1";

let h;
let task;
let userWorkspace;

before(async () => {
  h = await openHarness("mac");
  task = await h.taskSpace("zen-input mac checks");
  userWorkspace = (await h.call("dev.viewState")).windows?.[0]?.activeWorkspace ?? null;
});

after(async () => {
  try {
    await showUserSpace();
  } finally {
    await h?.finish();
  }
});

const opened = [];
const track = page => (opened.push(page), page);
afterEach(async () => {
  while (opened.length) {
    await opened.pop().close().catch(() => {});
  }
});

const chrome = (code, arg) => h.call("dev.evalChrome", { code, arg });
const until = async (fn, ms, message) => {
  for (const end = Date.now() + ms; !(await fn()); ) {
    if (Date.now() > end) {
      throw new Error(`timed out: ${message}`);
    }
    await new Promise(r => setTimeout(r, 25));
  }
};
const value = (page, selector) => page.evaluate(sel => document.querySelector(sel).value, selector);
const caret = (page, selector) =>
  page.evaluate(sel => {
    const el = document.querySelector(sel);
    return [el.selectionStart, el.selectionEnd];
  }, selector);
const setCaret = (page, selector, start, end = start) =>
  page.evaluate(([sel, s, e]) => document.querySelector(sel).setSelectionRange(s, e), [selector, start, end]);

/** Played by the user: show the agent's page in the dev window. */
async function showAgentPage(page) {
  const shown = await chrome(
    `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");
    const { tab, space } = ZeniusService.resolvePage(arg);
    await win.gZenWorkspaces.changeWorkspaceWithID(space.uuid);
    if (win.gBrowser.selectedTab !== tab) win.gBrowser.selectedTab = tab;
    const end = Date.now() + 3000;
    while (win.gBrowser.selectedTab !== tab && Date.now() < end) await new Promise(r => win.setTimeout(r, 25));
    return win.gBrowser.selectedTab === tab;`,
    { space: page.spaceId, page: page.label }
  );
  assert.equal(shown, true, "the agent's page is the selected tab");
}

async function showUserSpace() {
  if (userWorkspace) {
    await chrome(`if (win.gZenWorkspaces.activeWorkspace !== arg) await win.gZenWorkspaces.changeWorkspaceWithID(arg);`, userWorkspace);
  }
}

const chooserStats = () =>
  chrome(`return ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/filechooser.sys.mjs").chooserStats();`);

// The platform's caret and editing shortcuts (macOS text system bindings,
// GTK's on Linux), as a user would press them.
const KEYS = MAC
  ? {
      lineStart: "Meta+ArrowLeft",
      lineEnd: "Meta+ArrowRight",
      wordLeft: "Alt+ArrowLeft",
      selectToLineStart: "Meta+Shift+ArrowLeft",
      deleteWord: "Alt+Backspace",
      docStart: "Meta+ArrowUp",
      redo: "Meta+Shift+Z",
    }
  : {
      lineStart: "Home",
      lineEnd: "End",
      wordLeft: "Control+ArrowLeft",
      selectToLineStart: "Shift+Home",
      deleteWord: "Control+Backspace",
      docStart: "Control+Home",
      redo: "Control+Shift+Z",
    };

// Standards mode (a doctype): in quirks mode a bare :hover matches only links.
const EDITOR_PAGE =
  "data:text/html,<!doctype html><textarea id=t cols=40 rows=4></textarea><input id=i><div id=e contenteditable style=min-height:30px></div>";

test("K1, K2: the platform's editing shortcuts work, and no clipboard chord reaches the system clipboard", async t => {
  const page = track(await h.newPageAt(task, EDITOR_PAGE));
  // K2: the harness checks each copy and cut chord in its own short window
  // (on the Mac, the pasteboard's change count; system-clipboard.mjs).
  const checkedBefore = h.clipboardStats().checked;

  await page.fill("#t", "alpha beta gamma\nsecond line");
  await page.focus("#t");
  await setCaret(page, "#t", 16);
  await page.keyboard.press(KEYS.lineStart);
  assert.deepEqual(await caret(page, "#t"), [0, 0], `${KEYS.lineStart} goes to the line start`);
  await page.keyboard.press(KEYS.lineEnd);
  assert.deepEqual(await caret(page, "#t"), [16, 16], `${KEYS.lineEnd} goes to the line end`);
  await page.keyboard.press(KEYS.wordLeft);
  assert.deepEqual(await caret(page, "#t"), [11, 11], `${KEYS.wordLeft} goes back a word`);
  await setCaret(page, "#t", 16);
  await page.keyboard.press(KEYS.selectToLineStart);
  assert.deepEqual(await caret(page, "#t"), [0, 16], `${KEYS.selectToLineStart} selects to the line start`);
  await setCaret(page, "#t", 16);
  await page.keyboard.press(KEYS.deleteWord);
  assert.equal(await value(page, "#t"), "alpha beta \nsecond line", `${KEYS.deleteWord} deletes a word`);
  await setCaret(page, "#t", 20);
  await page.keyboard.press(KEYS.docStart);
  assert.deepEqual(await caret(page, "#t"), [0, 0], `${KEYS.docStart} goes to the start`);

  // Cmd (Ctrl) + A, C, V, X, Z and redo, across an input and the textarea.
  await page.fill("#i", "copied text");
  await page.press("#i", "ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+C");
  await page.focus("#t");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+V");
  assert.equal(await value(page, "#t"), "copied text", "select all, copy, paste");
  await page.keyboard.press("ControlOrMeta+Z");
  assert.equal(await value(page, "#t"), "alpha beta \nsecond line", "undo restores the text");
  await page.keyboard.press(KEYS.redo);
  assert.equal(await value(page, "#t"), "copied text", `${KEYS.redo} redoes`);
  await page.press("#i", "ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+X");
  assert.equal(await value(page, "#i"), "", "cut empties the input");
  await page.focus("#e");
  await page.keyboard.press("ControlOrMeta+V");
  assert.equal(await page.evaluate(() => document.querySelector("#e").textContent), "copied text", "paste into a contenteditable");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  assert.equal(await page.evaluate(() => document.querySelector("#e").textContent), "", "select all stays in the editing host");

  const { mode, checked } = h.clipboardStats();
  if (mode === "none") {
    t.diagnostic("K2 not checked: a visible Zen off the Mac shares the user's clipboard, so nothing may touch it");
  } else {
    assert.equal(checked - checkedBefore, 2, `K2: the copy and the cut were each checked (${mode})`);
  }
});

test("K3: an agent tab's file chooser never reaches the native picker, hidden or visible", async () => {
  const before = await chooserStats();
  const page = track(await h.newPageAt(task, `${h.baseUrl}/?mac=${Date.now()}`));
  await h.assertRejects(() => page.click("#dynamic-file-button"), "opened a file chooser", "unguarded chooser in a hidden tab");
  await showAgentPage(page);
  try {
    await h.assertRejects(() => page.click("#dynamic-file-button"), "opened a file chooser", "unguarded chooser in a visible tab");
    const waiting = page.waitForFileChooser({ timeout: 5000 });
    await page.click("#dynamic-file-button");
    const chooser = await waiting;
    await chooser.setFiles([await h.tempFile("mac-upload.txt")]);
    assert.equal(
      await page.evaluate(() => Array.from(document.querySelector("[data-dynamic-upload]").files, f => f.name).join()),
      "mac-upload.txt"
    );
  } finally {
    await showUserSpace();
  }
  const now = await chooserStats();
  assert.equal(now.native, before.native, "no native picker opened");
  assert.equal(now.agent, before.agent + 3, "all three choosers were intercepted");
});

// Small cells 8 CSS px apart, and a tall page for the wheel.
const GRID_PAGE =
  "data:text/html,<!doctype html><body style='margin:0;height:4000px'><div id=grid></div><script>" +
  "window.__hits=[];window.__downs=[];" +
  "for(let r=0;r<10;r++)for(let c=0;c<10;c++){const b=document.createElement('button');b.id='c'+r+c;" +
  "b.style.cssText='position:absolute;padding:0;border:0;width:6px;height:6px;left:'+(100+c*8)+'px;top:'+(100+r*8)+'px';" +
  "b.onclick=()=>__hits.push(b.id);b.onmousedown=e=>__downs.push([e.clientX,e.clientY,e.isTrusted]);grid.append(b)}" +
  "</script>";

test("K4, K5: in a visible tab, pointer input lands on the right CSS pixel, right after a load too", async () => {
  const page = track(await h.newPageAt(task, GRID_PAGE));
  await showAgentPage(page);
  try {
    const dpr = await page.evaluate(() => devicePixelRatio);
    if (MAC && HEADED) {
      assert.equal(dpr, 2, "run headed with the dev window on a Retina display");
    }
    const hits = () => page.evaluate(() => window.__hits.splice(0));

    await page.click("#c37");
    await page.click("#c99");
    assert.deepEqual(await hits(), ["c37", "c99"], "click by selector");

    // Cell c25 spans x 140-145, y 116-121.
    await page.mouse.click(143, 119);
    assert.deepEqual(await hits(), ["c25"], "mouse.click at CSS coordinates");
    assert.deepEqual(await page.evaluate(() => window.__downs.at(-1)), [143, 119, true], "clientX/Y are the CSS point");

    await page.hover("#c00");
    assert.equal(await page.evaluate(() => document.querySelector("#c00").matches(":hover")), true, "hover");

    await page.mouse.move(400, 300);
    const y0 = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 300);
    await until(async () => (await page.evaluate(() => scrollY)) - y0 >= 299, 2000, "the wheel scrolled");
    assert.ok(Math.abs((await page.evaluate(() => scrollY)) - y0 - 300) <= 1, "the wheel scrolled 300 CSS px");

    // A visible tab's refresh driver runs, so Gecko's input-event delay after
    // a load applies there: the click must still land.
    for (let i = 0; i < 3; i++) {
      await page.goto(`${GRID_PAGE}<!--${i}-->`);
      await page.click("#c11");
      assert.deepEqual(await hits(), ["c11"], `click right after load ${i}`);
    }
  } finally {
    await showUserSpace();
  }
});
