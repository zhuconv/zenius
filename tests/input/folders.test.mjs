// Folder uploads (input-gaps 24, docs/research/folder-uploads.md). A payload
// may carry the relativePath the page reads as webkitRelativePath. The
// runtime writes the folder under the profile, as it writes a chooser's files
// (tests/input/uploads.test.mjs), and refuses any path that could leave it
// (SPEC I5). A content process reads a folder only once Gecko's picker parent
// has granted it, so page.setInputFiles opens the input's own folder chooser
// and the runtime answers it.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { openHarness } from "./harness.mjs";

const MOD = `ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/filechooser.sys.mjs")`;
let h;
let task;
let profile;
/** Where a planted link points: nothing may land here. */
let outside;
let staged = 0;

before(async () => {
  h = await openHarness("folders");
  task = await h.taskSpace("zenius folders");
  profile = await h.call("dev.evalChrome", { code: "return PathUtils.profileDir;" });
  outside = mkdtempSync(join(tmpdir(), "zen-input-folders-outside-"));
  writeFileSync(join(outside, "keep.txt"), "the user's");
});

const opened = [];
afterEach(async () => {
  await h.call("dev.evalChrome", { code: `const m = ${MOD}; m.uploadTestHooks.making = m.uploadTestHooks.made = null;` });
  while (opened.length) {
    await opened.pop().close().catch(() => {});
  }
});

after(async () => {
  await h?.finish();
  rmSync(outside, { recursive: true, force: true });
});

const T0 = 1700000000000;
const file = (relativePath, text, lastModified = T0) => ({
  name: relativePath.split("/").at(-1),
  relativePath,
  mimeType: "",
  lastModified,
  base64: Buffer.from(text).toString("base64"),
});
/** A folder with a hidden file and two levels of subfolders. */
const TREE = [file("photos/a.txt", "A"), file("photos/2024/b.txt", "BB"), file("photos/2024/deep/c.md", "CCC", 1600000000000), file("photos/.hidden", "h")];
/** What the page should read from TREE, sorted by path. */
const TREE_READ = [
  { name: ".hidden", path: "photos/.hidden", text: "h", lastModified: T0 },
  { name: "b.txt", path: "photos/2024/b.txt", text: "BB", lastModified: T0 },
  { name: "c.md", path: "photos/2024/deep/c.md", text: "CCC", lastModified: 1600000000000 },
  { name: "a.txt", path: "photos/a.txt", text: "A", lastModified: T0 },
];

/** A page with a webkitdirectory input #dir and a plain one #plain, each logging its events in data-events. */
async function folderPage() {
  const page = await h.newPageAt(task, `${h.baseUrl}/frame.html?folders=${Date.now()}`);
  opened.push(page);
  await page.evaluate(() => {
    for (const [id, folder] of [
      ["dir", true],
      ["plain", false],
    ]) {
      const input = document.createElement("input");
      input.type = "file";
      input.id = id;
      if (folder) {
        input.setAttribute("webkitdirectory", "");
      }
      input.dataset.events = "";
      for (const type of ["input", "change", "cancel"]) {
        input.addEventListener(type, () => {
          input.dataset.events += (input.dataset.events ? "," : "") + type;
        });
      }
      document.body.append(input, document.createElement("br"));
    }
  });
  return page;
}

/** What input #id holds, as the page reads it, sorted by path, and the events it heard. */
const inputState = (page, id) =>
  page.evaluate(async id => {
    const input = document.getElementById(id);
    const files = [];
    for (const f of input.files) {
      files.push({ name: f.name, path: f.webkitRelativePath, text: await f.text(), lastModified: f.lastModified });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files, events: input.dataset.events };
  }, id);

/** Waits until input #id has `count` files and its change event ran. */
const filled = (page, id, count) =>
  h.until(async () => {
    const s = await inputState(page, id);
    return s.files.length === count && s.events.includes("change") ? s : null;
  }, `input #${id} to get ${count} files`);

const setInputFiles = (page, target, files) => h.call("page.setInputFiles", { space: page.spaceId, page: page.label, target, files });
const held = () => h.call("dev.evalChrome", { code: `return ${MOD}.uploadDirectories();` });

/** The newest upload folder's tree, as modes by relative path. */
const treeModes = () =>
  h.call("dev.evalChrome", {
    code: `const m = ${MOD};
      const dir = m.uploadDirectories().at(-1);
      const out = {};
      const walk = async at => {
        for (const p of await IOUtils.getChildren(at)) {
          const s = await IOUtils.stat(p);
          out[p.slice(dir.length + 1)] = s.permissions;
          if (s.type === "directory") await walk(p);
        }
      };
      await walk(dir);
      return { dir, root: m.uploadRoot(), modes: out };`,
  });

test("page.setInputFiles gives a webkitdirectory input a folder: names, relative paths, contents and times, then input and change", async () => {
  const page = await folderPage();
  await setInputFiles(page, "#dir", TREE);
  // Read at once: the call returns after Gecko's walk and the input's events.
  const got = await inputState(page, "dir");
  assert.deepEqual(got.files, TREE_READ);
  assert.equal(got.events, "input,change");
  const { dir, root, modes } = await treeModes();
  assert.ok(dir.startsWith(join(profile, "zenius-uploads") + "/") && dir.startsWith(root + "/"), `under the profile: ${dir}`);
  assert.deepEqual(modes, {
    photos: 0o700,
    "photos/a.txt": 0o600,
    "photos/.hidden": 0o600,
    "photos/2024": 0o700,
    "photos/2024/b.txt": 0o600,
    "photos/2024/deep": 0o700,
    "photos/2024/deep/c.md": 0o600,
  });
});

test("page.setInputFiles returns only once the input holds the whole folder: Gecko walks it after the answer", async () => {
  const page = await folderPage();
  const big = Array.from({ length: 400 }, (_, i) => file(`big/d${i % 20}/f${i}.txt`, String(i)));
  await setInputFiles(page, "#dir", big);
  const now = await page.evaluate(() => ({ count: document.getElementById("dir").files.length, events: document.getElementById("dir").dataset.events }));
  assert.deepEqual(now, { count: 400, events: "input,change" });
});

test("the runtime's own folder chooser never reaches page.waitForFileChooser, and the page keeps no transient activation", async () => {
  const page = await folderPage();
  const waiting = page.waitForFileChooser({ timeout: 1500 }).then(
    () => "a chooser",
    e => e.code
  );
  await setInputFiles(page, "#dir", TREE);
  await filled(page, "dir", TREE.length);
  assert.equal(await waiting, "ZEN_FILE_CHOOSER_TIMEOUT", "the agent's waiter saw nothing");
  assert.equal(await page.evaluate(() => navigator.userActivation.isActive), false, "the activation showPicker needed is spent");
});

test("a folder chooser takes a folder, and the page gets it as from the user's pick; plain files there are refused and it stays open", async () => {
  const page = await folderPage();
  const waiting = page.waitForFileChooser({ timeout: 5000 });
  await page.click("#dir");
  const c = await waiting;
  const before = await held();
  const failed = await h.assertRejects(() => c.setRaw([{ ...file("photos/a.txt", "A"), relativePath: undefined }]), "this chooser takes a folder", "plain files");
  assert.equal(failed.code, "ZEN_INVALID_ARGUMENT");
  assert.deepEqual(await held(), before, "nothing was written");
  assert.deepEqual(await c.setRaw(TREE), {});
  const got = await inputState(page, "dir");
  assert.deepEqual(got.files, TREE_READ, "the files are on the input when setFiles returns");
  assert.equal(got.events, "input,change");
});

test("a folder chooser that an input the page never attached opened: setFiles returns once that input holds the folder, without waiting out the walk's 10 s", async () => {
  // A common upload button: createElement, webkitdirectory, click(). The
  // input's events reach only the input, never the window.
  const page = await folderPage();
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.id = "pick";
    b.textContent = "Upload a folder";
    b.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.setAttribute("webkitdirectory", "");
      document.body.dataset.detached = "";
      for (const type of ["input", "change"]) {
        input.addEventListener(type, () => {
          document.body.dataset.detached += (document.body.dataset.detached ? "," : "") + `${type}:${input.files.length}`;
        });
      }
      input.click();
    });
    document.body.append(b);
  });
  const waiting = page.waitForFileChooser({ timeout: 5000 });
  await page.click("#pick");
  const c = await waiting;
  const t0 = Date.now();
  assert.deepEqual(await c.setRaw(TREE), {});
  const took = Date.now() - t0;
  assert.equal(await page.evaluate(() => document.body.dataset.detached), `input:${TREE.length},change:${TREE.length}`, "the input held the folder, and its handlers ran, when setFiles returned");
  assert.ok(took < 5000, `setFiles took ${took} ms: it waited out an event it couldn't hear`);
});

test("only Gecko's input event ends the wait for a chooser's files: a page's own doesn't", async () => {
  const page = await folderPage();
  // awaitFileInput as filechooser.setFiles runs it, with no chooser answered: it waits up to 2 s.
  const wait = () =>
    h.call("dev.evalContent", {
      space: page.spaceId,
      page: page.label,
      privileged: true,
      code: `const A = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/actions.sys.mjs");
        const t0 = Date.now();
        await A.awaitFileInput({ contentWindow: window, browsingContext: window.browsingContext }, { expectFiles: true });
        return Date.now() - t0;`,
    });
  const pause = () => new Promise(r => setTimeout(r, 300));
  const theirs = wait();
  await pause();
  await page.evaluate(() => document.getElementById("plain").dispatchEvent(new Event("input", { bubbles: true })));
  const tookTheirs = await theirs;
  assert.ok(tookTheirs >= 1500, `the page's own input event ended the wait after ${tookTheirs} ms`);
  // A trusted one (chrome's dispatch is) still does, so the wait listens at all.
  const gecko = wait();
  await pause();
  await h.call("dev.evalContent", {
    space: page.spaceId,
    page: page.label,
    privileged: true,
    code: `document.getElementById("plain").dispatchEvent(new window.Event("input", { bubbles: true })); return true;`,
  });
  const tookGecko = await gecko;
  assert.ok(tookGecko < 1500, `a trusted input event didn't end the wait (${tookGecko} ms)`);
});

test("a file chooser refuses a folder, and stays open", async () => {
  const page = await folderPage();
  const waiting = page.waitForFileChooser({ timeout: 5000 });
  await page.click("#plain");
  const c = await waiting;
  const failed = await h.assertRejects(() => c.setRaw(TREE), "this chooser takes files", "a folder");
  assert.equal(failed.code, "ZEN_INVALID_ARGUMENT");
  assert.deepEqual(await c.setRaw([file("photos/a.txt", "A")].map(({ relativePath, ...f }) => f)), {});
  assert.equal((await filled(page, "plain", 1)).files[0].name, "a.txt");
});

// Each refusal: the call fails with ZEN_INVALID_ARGUMENT naming why, nothing
// is written, and the input stays as it was.
const at = (relativePath, extra = {}) => ({ ...file("photos/a.txt", "A"), relativePath, ...extra });
const REFUSALS = [
  ["an empty relativePath", [at("")], "must be a non-empty string"],
  ["a relativePath that isn't a string", [at(7)], "must be a non-empty string"],
  ["an absolute path", [at("/photos/a.txt")], "is absolute"],
  ["an empty segment", [at("photos//a.txt")], `an empty, "." or ".." segment`],
  ["a trailing slash", [at("photos/a.txt/")], `an empty, "." or ".." segment`],
  ["a . segment", [at("photos/./a.txt")], `an empty, "." or ".." segment`],
  ["a .. segment", [at("photos/../a.txt")], `an empty, "." or ".." segment`],
  ["a NUL", [at("photos/a\u0000.txt", { name: "a\u0000.txt" })], "a NUL, a backslash or another control character"],
  ["a backslash", [at("photos\\a.txt", { name: "photos\\a.txt" })], "a NUL, a backslash or another control character"],
  ["a control character", [at("photos/a\u0007.txt", { name: "a\u0007.txt" })], "a NUL, a backslash or another control character"],
  ["no folder", [at("a.txt")], "names the folder, then the file"],
  ["a segment over 255 bytes", [at(`photos/${"é".repeat(128)}`, { name: "é".repeat(128) })], "too long"],
  ["a path over 768 bytes", [at(`photos/${`${"d".repeat(200)}/`.repeat(4)}a.txt`)], "too long"],
  ["a name that isn't the path's last segment", [at("photos/b.txt")], "must end with the file's name"],
  ["two folders", [at("photos/a.txt"), { ...file("music/a.txt", "M") }], "sends one folder"],
  ["files with and without a relativePath", [at("photos/a.txt"), { ...file("photos/b.txt", "B"), relativePath: undefined }], "some files here have none"],
  ["the same path twice", [at("photos/a.txt"), at("photos/a.txt")], "is sent twice"],
  ["a file that is another's folder", [{ ...file("photos/a", "A") }, { ...file("photos/a/b.txt", "B") }], "both as a file and as a folder"],
  ["over 1000 files", Array.from({ length: 1001 }, (_, i) => file(`photos/f${i}.txt`, "x")), "over the limit of 1000"],
];

test("page.setInputFiles refuses each bad folder before writing anything, and the input keeps what it had", async () => {
  const page = await folderPage();
  for (const [what, files, says] of REFUSALS) {
    const before = await held();
    const failed = await h.assertRejects(() => setInputFiles(page, "#dir", files), says, what);
    assert.equal(failed.code, "ZEN_INVALID_ARGUMENT", what);
    assert.deepEqual(await held(), before, `${what}: nothing was written`);
    assert.deepEqual(await inputState(page, "dir"), { files: [], events: "" }, `${what}: the input is as it was`);
  }
});

test("a folder over 50 MiB is refused before any byte is decoded", async () => {
  // Built in the browser: 70 MB of base64 needn't cross the socket.
  const said = await h.call("dev.evalChrome", {
    code: `const m = ${MOD};
      const files = [{ name: "big.bin", relativePath: "photos/big.bin", base64: "A".repeat(70 * 1024 * 1024) }];
      try { m.folderPlan(files, "page.setInputFiles"); m.filesFromPayloads(files, "page.setInputFiles"); return "taken"; }
      catch (e) { return e.code + " " + e.message; }`,
  });
  assert.match(said, /^ZEN_INVALID_ARGUMENT .*over the limit of 52428800/);
});

test("page.setInputFiles refuses a folder for an input without webkitdirectory, and removes what it wrote", async () => {
  const page = await folderPage();
  const before = await held();
  const failed = await h.assertRejects(() => setInputFiles(page, "#plain", TREE), "a folder needs an input with webkitdirectory", "a plain input");
  assert.equal(failed.code, "ZEN_INVALID_ARGUMENT");
  assert.deepEqual(await held(), before, "the folder written for it is gone");
  assert.deepEqual(await inputState(page, "plain"), { files: [], events: "" });
});

test("a link planted where a subfolder will go fails the folder, and nothing is written through it", async () => {
  const page = await folderPage();
  const link = join(profile, `zen-input-folders-stage-${process.pid}-${++staged}`);
  symlinkSync(outside, link);
  try {
    await h.call("dev.evalChrome", {
      arg: { stage: link },
      code: `const m = ${MOD}; m.uploadTestHooks.making = async path => { if (PathUtils.filename(path) === "2024") await IOUtils.move(arg.stage, path); };`,
    });
    const before = await held();
    const failed = await h.assertRejects(() => setInputFiles(page, "#dir", TREE), "the files weren't attached", "a planted link");
    assert.equal(failed.code, "ZEN_INTERNAL");
    assert.deepEqual(readdirSync(outside), ["keep.txt"], "nothing landed outside");
    assert.deepEqual(await held(), before, "the failed upload's folder isn't kept");
    assert.deepEqual(await inputState(page, "dir"), { files: [], events: "" });
  } finally {
    rmSync(link, { force: true });
  }
});

test("a folder upload's folder goes when its tab closes", async () => {
  const page = await folderPage();
  await setInputFiles(page, "#dir", TREE);
  await filled(page, "dir", TREE.length);
  const dir = (await held()).at(-1);
  await page.close();
  opened.splice(opened.indexOf(page), 1);
  await h.until(
    () => h.call("dev.evalChrome", { arg: dir, code: `return !(await IOUtils.exists(arg)) && !${MOD}.uploadDirectories().includes(arg);` }),
    "the folder to go"
  );
});

// APFS tells neither letter case nor Unicode forms apart; the Linux server's disk does.
test("two names that land on one file fail the folder", { skip: process.platform !== "darwin" && "the Mac's disk only" }, async () => {
  const page = await folderPage();
  for (const [what, a, b] of [
    ["letter case", "photos/A.txt", "photos/a.txt"],
    ["Unicode forms", "photos/café.txt", "photos/café.txt"],
    ["a folder's letter case", "photos/Sub/a.txt", "photos/sub/b.txt"],
  ]) {
    const failed = await h.assertRejects(() => setInputFiles(page, "#dir", [file(a, "1"), file(b, "2")]), "land on one file", what);
    assert.equal(failed.code, "ZEN_INVALID_ARGUMENT", what);
  }
});

// Firefox asks before any folder pick reaches a page (Bug 1338637), and in
// an agent tab zen-observe's handler answers Cancel. The runtime's own folder
// passes once, in its frame (content/filepicker.sys.mjs, expectOwnFolder);
// nothing else does, and a user's tab gets Firefox's question as before.
const ASK = `return Cc["@mozilla.org/embedcomp/prompt-collection;1"].getService(Ci.nsIPromptCollection).confirmFolderUpload(arg.bc ? BrowsingContext.get(arg.bc) : window.browsingContext, arg.name);`;
const ask = (page, name, bc = null) => h.call("dev.evalContent", { space: page.spaceId, page: page.label, privileged: true, code: ASK, arg: { name, bc } });

test("Firefox's folder question: the delivered folder passed once; a second ask in its frame, a folder zenius didn't deliver, and another frame all get Cancel", async () => {
  const page = await folderPage();
  await page.evaluate(() => {
    const f = document.createElement("iframe");
    f.id = "inner";
    f.src = "/frame.html?folders-inner";
    document.body.append(f);
  });
  await page.waitForFunction(() => document.getElementById("inner").contentDocument?.readyState === "complete");
  // The delivery passed: the folder is on the input.
  await setInputFiles(page, "#dir", TREE);
  await filled(page, "dir", TREE.length);
  assert.equal(await ask(page, "photos"), false, "a second ask in the frame, with no new delivery");
  assert.equal(await ask(page, "other"), false, "a folder zenius didn't deliver");
  // A token armed for the top frame, as the parent arms it: no delivery runs,
  // so neither the top frame nor the iframe passes.
  const inner = await h.call("dev.evalContent", {
    space: page.spaceId,
    page: page.label,
    privileged: true,
    code: `return document.getElementById("inner").browsingContext.id;`,
  });
  const verdicts = await h.call("dev.evalContent", {
    space: page.spaceId,
    page: page.label,
    privileged: true,
    arg: { inner },
    code: `const FP = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/filepicker.sys.mjs");
      const lapse = FP.expectOwnFolder(window.browsingContext, "/p/zenius-uploads/upload-9/photos");
      const prompts = Cc["@mozilla.org/embedcomp/prompt-collection;1"].getService(Ci.nsIPromptCollection);
      try {
        return { inner: prompts.confirmFolderUpload(BrowsingContext.get(arg.inner), "photos"), top: prompts.confirmFolderUpload(window.browsingContext, "photos") };
      } finally {
        lapse();
      }`,
  });
  assert.deepEqual(verdicts, { inner: false, top: false }, "another frame, and the token without its delivery");
});

test("a folder whose question zenius didn't answer yes fails the call: nothing attached, nothing kept, no activation left", async () => {
  const page = await folderPage();
  const hooks = `ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/filepicker.sys.mjs").ownFolderTestHooks`;
  const unarmed = on => h.call("dev.evalContent", { space: page.spaceId, page: page.label, privileged: true, code: `${hooks}.unarmed = ${on}; return true;` });
  const before = await held();
  await unarmed(true);
  try {
    const failed = await h.assertRejects(() => setInputFiles(page, "#dir", TREE), "Firefox's folder question was answered Cancel", "an unarmed folder");
    assert.equal(failed.code, "ZEN_INTERNAL");
  } finally {
    await unarmed(false);
  }
  assert.deepEqual(await inputState(page, "dir"), { files: [], events: "" }, "nothing attached");
  assert.deepEqual(await held(), before, "the staged folder is gone");
  assert.equal(await page.evaluate(() => navigator.userActivation.isActive), false, "Gecko's activation for the pick is spent");
  // And the next one, armed, goes through.
  await setInputFiles(page, "#dir", TREE);
  assert.deepEqual((await inputState(page, "dir")).files, TREE_READ);
});

test("Firefox's folder question in a user's tab in the same process is Firefox's own, as before", async () => {
  const page = await folderPage();
  const url = `${h.baseUrl}/frame.html?folders-user=${Date.now()}`;
  const out = await h.call("dev.evalChrome", {
    arg: { url, space: page.spaceId, page: page.label },
    code: `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");
      const agent = ZeniusService.resolvePage(arg).browser;
      const win = agent.ownerGlobal ?? agent.ownerDocument.defaultView;
      // A site has up to dom.ipc.processCount.webIsolated processes: open
      // user tabs until one lands in the agent page's.
      const tabs = [];
      let tab = null;
      for (let n = 0; n < 12 && !tab; n++) {
        const t = win.gBrowser.addTab(arg.url + "&n=" + n, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
        tabs.push(t);
        for (let i = 0; i < 100 && !t.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI?.spec.includes("&n=" + n); i++) {
          await new Promise(r => win.setTimeout(r, 100));
        }
        if (t.linkedBrowser.browsingContext.currentWindowGlobal.osPid === agent.browsingContext.currentWindowGlobal.osPid) {
          tab = t;
        }
      }
      const user = (tab ?? tabs.at(-1)).linkedBrowser;
      try {
        const samePid = !!tab;
        // The question Firefox shows is recorded, then cancelled.
        let shown = null;
        const seen = subject => {
          Services.obs.removeObserver(seen, "common-dialog-loaded");
          shown = subject.document.getElementById("infoBody")?.textContent ?? subject.document.documentElement.textContent;
          win.setTimeout(() => subject.document.querySelector("dialog")?.cancelDialog(), 0);
        };
        Services.obs.addObserver(seen, "common-dialog-loaded");
        let answer;
        try {
          answer = await ZeniusService.content(user.browsingContext, "dev#evalContent", {
            code: 'return Cc["@mozilla.org/embedcomp/prompt-collection;1"].getService(Ci.nsIPromptCollection).confirmFolderUpload(window.browsingContext, "photos");',
            privileged: true,
          });
        } finally {
          if (shown === null) {
            Services.obs.removeObserver(seen, "common-dialog-loaded");
          }
        }
        return { samePid, answer, shown };
      } finally {
        for (const t of tabs) {
          win.gBrowser.removeTab(t);
        }
      }`,
  });
  assert.equal(out.samePid, true, "the user's tab shares the agent page's content process");
  assert.match(String(out.shown), /upload all files from/, "Firefox asked the user");
  assert.equal(out.answer, false, "and the user's Cancel came back");
});
