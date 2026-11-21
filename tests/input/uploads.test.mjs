// A chooser's files are written by the runtime under the profile, never in
// the system temp folder, which a sandboxed CLI can write. Nothing an agent
// racing the write puts in the way is followed: a link where a folder or a
// file will go, or a folder swapped for a link right after it's made
// (input/filechooser.sys.mjs, SPEC I5). The races are played through the
// writer's test hooks, at the moments a racing agent would act: the links
// are made here, in the profile, and moved into place by the hook.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { openHarness } from "./harness.mjs";

const MOD = `ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/filechooser.sys.mjs")`;
let h;
let task;
let profile;
/** Where every planted link points: nothing may land here. */
let outside;
let staged = 0;

before(async () => {
  h = await openHarness("uploads");
  task = await h.taskSpace("zenius uploads");
  profile = await h.call("dev.evalChrome", { code: "return PathUtils.profileDir;" });
  outside = mkdtempSync(join(tmpdir(), "zen-input-outside-"));
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

const payload = (name, text) => ({ name, mimeType: "", lastModified: 1700000000000, base64: Buffer.from(text).toString("base64") });
/** What's outside now, besides the file that was there. */
const landed = () => readdirSync(outside).filter(n => n !== "keep.txt");

/** A chooser on a new page of the task, waited for. */
async function chooser() {
  const page = await h.newPageAt(task, `${h.baseUrl}/?uploads=${Date.now()}`);
  opened.push(page);
  const waiting = page.waitForFileChooser({ timeout: 5000 });
  await page.click("#dynamic-file-button");
  return { page, chooser: await waiting };
}

/** A link to `target`, made in the profile (the same disk as the uploads), for a hook to move into place. */
function stage(target = outside) {
  const path = join(profile, `zen-input-stage-${process.pid}-${++staged}`);
  symlinkSync(target, path);
  return path;
}

test("a chooser's files go under the profile, the folders 0700 and the files 0600", async () => {
  const { page, chooser: c } = await chooser();
  assert.deepEqual(await c.setRaw([payload("here.txt", "here")]), {});
  assert.equal(await page.evaluate(() => document.querySelector("[data-dynamic-upload]").files[0]?.name), "here.txt");
  const out = await h.call("dev.evalChrome", {
    code: `const m = ${MOD};
      const dir = m.uploadDirectories().at(-1);
      const file = PathUtils.join(dir, "0", "here.txt");
      const mode = async p => (await IOUtils.stat(p)).permissions;
      return { root: m.uploadRoot(), dir, modes: [await mode(m.uploadRoot()), await mode(dir), await mode(PathUtils.join(dir, "0")), await mode(file)] };`,
  });
  assert.equal(out.root, join(profile, "zenius-uploads"));
  assert.ok(out.dir.startsWith(out.root + "/"), `under the profile: ${out.dir}`);
  assert.deepEqual(out.modes, [0o700, 0o700, 0o700, 0o600]);
});

// Each race: when the hook acts, what it does, and that the answer then fails
// with nothing outside, nothing on the input, and the upload's folder gone.
const RACES = [
  {
    what: "a link already where the file's folder will go",
    hook: "making",
    act: `if (PathUtils.filename(path) === "0") await IOUtils.move(arg.stage, path);`,
  },
  {
    what: "a link already where the file will go",
    hook: "made",
    act: `if (PathUtils.filename(path) === "0") await IOUtils.move(arg.stage, PathUtils.join(path, "evil.txt"));`,
    target: () => join(outside, "evil-target.txt"),
  },
  {
    what: "the file's folder swapped for a link right after it's made",
    hook: "made",
    act: `if (PathUtils.filename(path) === "0") { await IOUtils.move(path, path + "-away"); await IOUtils.move(arg.stage, path); }`,
  },
  {
    what: "the upload's own folder swapped for a link right after it's made",
    hook: "made",
    act: `if (PathUtils.filename(path).startsWith("upload")) { await IOUtils.move(path, path + "-away"); await IOUtils.move(arg.stage, path); }`,
  },
];

for (const race of RACES) {
  test(`a chooser's answer fails, and nothing is written through the link: ${race.what}`, async () => {
    const link = stage(race.target?.() ?? outside);
    await h.call("dev.evalChrome", {
      arg: { stage: link },
      code: `const m = ${MOD}; m.uploadTestHooks.${race.hook} = async path => { ${race.act} };`,
    });
    const before = await h.call("dev.evalChrome", { code: `return ${MOD}.uploadDirectories();` });
    const { page, chooser: c } = await chooser();
    const failed = await h.assertRejects(() => c.setRaw([payload("evil.txt", "written outside")]), "the files weren't attached", race.what);
    assert.equal(failed.code, "ZEN_INTERNAL", race.what);
    assert.deepEqual(landed(), [], `${race.what}: nothing landed outside`);
    assert.equal(await page.evaluate(() => document.querySelector("[data-dynamic-upload]")?.files.length ?? 0), 0, `${race.what}: the input got nothing`);
    const after = await h.call("dev.evalChrome", { code: `return ${MOD}.uploadDirectories();` });
    assert.deepEqual(after, before, `${race.what}: the failed upload's folder isn't kept`);
    // The chooser stays open: bytes still go in, once nothing is in the way.
    await h.call("dev.evalChrome", { code: `const m = ${MOD}; m.uploadTestHooks.making = m.uploadTestHooks.made = null;` });
    assert.deepEqual(await c.setRaw([payload("after.txt", "fine")]), {}, `${race.what}: the chooser takes a clean answer`);
    assert.equal(await page.evaluate(() => document.querySelector("[data-dynamic-upload]").files[0]?.name), "after.txt");
    rmSync(link, { force: true });
  });
}

test("a link where the upload root should be fails every answer and is never written through", async () => {
  // Nothing of this run's is held there now (each test's page has closed).
  const root = await h.call("dev.evalChrome", {
    code: `const m = ${MOD}; const root = m.uploadRoot();
      if (m.uploadDirectories().length) throw new Error("uploads still held: " + m.uploadDirectories());
      await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
      return root;`,
  });
  symlinkSync(outside, root);
  try {
    const { page, chooser: c } = await chooser();
    const failed = await h.assertRejects(() => c.setRaw([payload("evil.txt", "written outside")]), "isn't a folder of zenius's own", "a link as the root");
    assert.equal(failed.code, "ZEN_INTERNAL");
    assert.deepEqual(landed(), [], "nothing landed outside");
    assert.equal(await page.evaluate(() => document.querySelector("[data-dynamic-upload]")?.files.length ?? 0), 0);
  } finally {
    rmSync(root, { force: true });
  }
  assert.ok(existsSync(join(outside, "keep.txt")), "the link's target is untouched");
});

test("nothing is removed through a link put in place of the upload root, when a page closes or at a start", async () => {
  const { page, chooser: c } = await chooser();
  assert.deepEqual(await c.setRaw([payload("mine.txt", "mine")]), {});
  const { root, dir } = await h.call("dev.evalChrome", { code: `const m = ${MOD}; return { root: m.uploadRoot(), dir: m.uploadDirectories().at(-1) };` });
  // Where the link leads: a folder named as the page's upload folder, and
  // one named as a leftover, each holding a file of the user's.
  const held = join(outside, basename(dir));
  const left = join(outside, "upload-979");
  for (const d of [held, left]) {
    mkdirSync(d);
    writeFileSync(join(d, "canary.txt"), "the user's");
  }
  const away = `${root}-away-${process.pid}`;
  renameSync(root, away);
  symlinkSync(outside, root);
  try {
    await page.close();
    await h.call("dev.evalChrome", { code: `await ${MOD}.sweepUploadLeftovers();` });
    // A page's folder goes on IOUtils.remove's own time: give it that.
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(readdirSync(outside).sort(), [basename(dir), "keep.txt", "upload-979"].sort(), "nothing was removed through the link");
    assert.ok(existsSync(join(held, "canary.txt")) && existsSync(join(left, "canary.txt")), "nor inside what it leads to");
  } finally {
    rmSync(root, { force: true });
    renameSync(away, root);
    rmSync(held, { recursive: true, force: true });
    rmSync(left, { recursive: true, force: true });
  }
});

test("a start removes the upload root's leftovers, following no link, and leaves earlier versions' folders in the temp folder alone", async () => {
  const { root, temp, legacy } = await h.call("dev.evalChrome", {
    code: `let x = 0x811c9dc5;
      for (const ch of PathUtils.profileDir) x = Math.imul(x ^ ch.charCodeAt(0), 0x01000193) >>> 0;
      return { root: ${MOD}.uploadRoot(), temp: PathUtils.tempDir, legacy: "zenius-upload-" + x.toString(16).padStart(8, "0") };`,
  });
  // In the root: a crash's folder, and a link.
  mkdirSync(join(root, "upload-977"), { recursive: true });
  writeFileSync(join(root, "upload-977", "left.txt"), "left by a crash");
  symlinkSync(outside, join(root, "upload-978"));
  // In the temp folder, as an earlier version left them: a folder holding a
  // link, and a link with an upload folder's name. An agent may still be
  // able to change them, so zenius neither moves nor removes them.
  const old = join(temp, `${legacy}-977`);
  mkdirSync(old);
  writeFileSync(join(old, "left.txt"), "an earlier run's");
  symlinkSync(outside, join(old, "0"));
  const oldLink = join(temp, `${legacy}-978`);
  symlinkSync(outside, oldLink);
  try {
    await h.call("dev.evalChrome", { code: `await ${MOD}.sweepUploadLeftovers();` });
    assert.deepEqual(readdirSync(root).filter(n => /^upload-97[78]$/.test(n)), [], "the root's leftovers went");
    assert.deepEqual(readdirSync(old).sort(), ["0", "left.txt"], "the earlier version's folder is as it was");
    assert.ok(lstatSync(oldLink).isSymbolicLink(), "and so is the link");
    assert.deepEqual(readdirSync(outside), ["keep.txt"], "nothing a link points to was touched");
  } finally {
    rmSync(old, { recursive: true, force: true });
    rmSync(oldLink, { force: true });
  }
});
