// Downloads from agent tabs: no panel, nothing in the user's Downloads folder
// or list. Each is staged in a folder of its own under the profile's
// zenius-downloads, out of the agent's reach, and once finished it moves into
// the working folder (on a dev profile, zenius.dev.workingFolder, which
// zen-dev.sh sets), under a name of its own, readable only by the user.
// download.path names it there (I5: the runtime opens no path an agent
// names, and the client copies saveAs targets itself), and download.delete
// deletes it. A download that's forgotten (its script's connection closed,
// or its task finished) leaves its file there: the file is the user's.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { connect } from "../../scripts/lib/rpc.mjs";
import { setup } from "./lib.mjs";

const DOWNLOADS = `const D = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/downloads.sys.mjs");`;
const WORKING = `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/workingfolder.sys.mjs");`;
const FIXTURE_TEXT = "ego-browser download fixture\n";

let env;
/** This dev profile's working folder, as the runtime read it: {path, real, source}. */
let working;
before(async () => {
  env = await setup();
  working = await env.chrome(`${WORKING} return await W.loadWorkingFolder();`);
  assert.equal(working.source, "dev", JSON.stringify(working));
  assert.ok(working.path && !working.error, JSON.stringify(working));
});
after(() => env.close());

const userDownloads = () =>
  env.chrome(`
    const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
    const dir = await Downloads.getPreferredDownloadsDirectory();
    // The profile's own folder (zen-dev.sh), never the account's Downloads.
    if (!dir.startsWith(PathUtils.profileDir + "/")) throw new Error("the downloads folder isn't the profile's own: " + dir);
    const files = await IOUtils.getChildren(dir).catch(() => []);
    const list = await (await Downloads.getList(Downloads.ALL)).getAll();
    return { files: files.length, list: list.length, panel: !!win.DownloadsPanel?.isPanelShowing };
  `);

/** The finished file's path in the working folder, from download.path. */
const pathOf = async (download, client = env) => (await client.call("download.path", { download })).path;
/** The finished file's bytes, read where download.path names it, as the client reads them. */
const bytesOf = async (download, client = env) => readFileSync(await pathOf(download, client));
/** Where the runtime staged a download's file (tests only; agents never see it). */
const stagedFile = download => env.chrome(`${DOWNLOADS} return D.getDownload(arg)?.download.target.path ?? null;`, download);
/** Whether the runtime still knows a download. */
const known = download => env.chrome(`${DOWNLOADS} return !!D.getDownload(arg);`, download);
const downloadRoot = () => env.chrome(`${DOWNLOADS} return D.downloadRoot();`);

/** Start a download from the page the way a link click does. */
const startDownload = (page, query = "") =>
  page.evaluate(`(() => { const a = document.createElement("a"); a.href = "/api/download${query}"; document.body.append(a); a.click(); return 1 })()`);

/** A download from the page, waited for. */
async function downloadOn(page) {
  const waiting = page.call("page.waitForEvent", { event: "download", options: { timeout: 5000 } });
  await startDownload(page);
  return waiting;
}

/** Poll `check` (sync or async) until it gives true or `ms` pass; its last value. */
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v === true || Date.now() > end) {
      return v;
    }
    await new Promise(r => setTimeout(r, 50));
  }
}

const everything = dir => readdirSync(dir, { recursive: true }).sort();
const lstatOrNull = path => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/**
 * Put a link to a fresh folder outside in the download folder's place, as
 * something that could write the folder's parent would, for `fn(outside,
 * root)`; put the folder back after.
 */
async function withRootSwapped(fn) {
  const root = await downloadRoot();
  const outside = mkdtempSync(join(tmpdir(), "zenius-i5-outside-"));
  const kept = `${root}.kept`;
  renameSync(root, kept);
  symlinkSync(outside, root);
  try {
    return await fn(outside, root);
  } finally {
    rmSync(root, { force: true });
    renameSync(kept, root);
    rmSync(outside, { recursive: true, force: true });
  }
}

/**
 * For `fn(release)`: each finished download's move waits until `release()`
 * (or fn's end), so the test can change the download's files or folders
 * first.
 */
async function withMovesHeld(fn) {
  const release = () =>
    env.chrome(`${DOWNLOADS} D.holdMoves(null); win.zeniusTestReleaseMoves?.(); delete win.zeniusTestReleaseMoves; return true;`);
  await env.chrome(`${DOWNLOADS} let release; D.holdMoves(new Promise(r => (release = r))); win.zeniusTestReleaseMoves = release; return true;`);
  try {
    return await fn(release);
  } finally {
    await release();
  }
}

/** Point this dev profile at `folder` and read it again, as a new start would: its error, or null. */
async function useWorkingFolder(folder) {
  const found = await env.chrome(`${WORKING} Services.prefs.setStringPref(W.DEV_PREF, arg); return await W.reloadWorkingFolder();`, folder);
  return found.error ?? null;
}

test("a finished download moves into the working folder, readable only by the user, and nothing reaches the user's downloads", () =>
  env.inSpace("download", async page => {
    await page.goto(`${env.base}/nav-target`);
    const before = await userDownloads();
    const d = await downloadOn(page);
    assert.equal(d.suggestedFilename, "ego-download.txt");
    assert.equal(d.url, `${env.base}/api/download`);
    const path = await pathOf(d.download);
    assert.equal(dirname(path), working.path);
    assert.match(basename(path), /^ego-download(\(\d+\))?\.txt$/);
    assert.equal(readFileSync(path, "utf8"), FIXTURE_TEXT);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    // It was staged in a folder of its own under the profile's, gone now.
    const staged = await stagedFile(d.download);
    assert.equal(dirname(dirname(staged)), await downloadRoot());
    assert.equal(lstatOrNull(dirname(staged)), null, "the staging folder stayed");
    assert.equal(await env.call("download.failure", { download: d.download }), null);
    assert.deepEqual(await userDownloads(), before, "the download reached the user's folder, list or panel");

    await env.call("download.delete", { download: d.download });
    assert.equal(existsSync(path), false);
    const gone = await env.fail("download.path", { download: d.download });
    assert.equal(gone.code, "ZEN_DOWNLOAD_FAILED");
    assert.match(gone.message, /unknown download/);
  }));

test("download.read is gone and download.saveAs takes no path (I5): each names download.path", () =>
  env.inSpace("download paths", async page => {
    await page.goto(`${env.base}/nav-target`);
    const d = await downloadOn(page);
    const saved = join(tmpdir(), `zenius-i5-saved-${process.pid}.txt`);
    for (const [method, params] of [
      ["download.saveAs", { path: saved }],
      ["download.read", { offset: 0, length: 1024 }],
    ]) {
      const e = await env.fail(method, { download: d.download, ...params });
      assert.equal(e.code, "ZEN_INVALID_ARGUMENT", method);
      assert.match(e.message, /download\.path/, method);
    }
    assert.equal(existsSync(saved), false);
    await env.call("download.delete", { download: d.download });
  }));

test("a download never replaces what the working folder holds: each gets a name of its own", () =>
  env.inSpace("download names", async page => {
    await page.goto(`${env.base}/nav-target`);
    // A file of the user's, by the name the next downloads suggest.
    const mine = join(working.path, "ego-download.txt");
    const had = existsSync(mine);
    if (!had) {
      writeFileSync(mine, "the user's own\n", { mode: 0o600 });
    }
    const before = readFileSync(mine);
    try {
      const first = await downloadOn(page);
      const second = await downloadOn(page);
      const paths = [await pathOf(first.download), await pathOf(second.download)];
      assert.equal(new Set([mine, ...paths]).size, 3, paths.join(", "));
      for (const path of paths) {
        assert.equal(dirname(path), working.path);
        assert.match(basename(path), /^ego-download\(\d+\)\.txt$/);
        assert.equal(readFileSync(path, "utf8"), FIXTURE_TEXT);
      }
      assert.deepEqual(readFileSync(mine), before, "a download replaced the user's file");
      for (const d of [first, second]) {
        await env.call("download.delete", { download: d.download });
      }
      assert.deepEqual(readFileSync(mine), before, "download.delete took the user's file");
    } finally {
      if (!had) {
        rmSync(mine, { force: true });
      }
    }
  }));

test("downloads are staged in the profile's own 0700 folder; a start makes it afresh, unlinking links there and following none", async () => {
  const { profileDir, root, permissions } = await env.chrome(
    `${DOWNLOADS} const root = D.downloadRoot(); return { profileDir: PathUtils.profileDir, root, permissions: (await IOUtils.stat(root)).permissions };`
  );
  assert.equal(root, join(profileDir, "zenius-downloads"));
  assert.equal(permissions & 0o777, 0o700);
  assert.equal(lstatSync(root).isDirectory(), true);
  const remake = () => env.chrome(`${DOWNLOADS} return D.remakeDownloadRoot();`);
  const keep = mkdtempSync(join(tmpdir(), "zenius-i5-keep-"));
  writeFileSync(join(keep, "precious.txt"), "keep");
  const kept = `${root}.kept`;
  try {
    // An earlier run's leftovers: a folder holding a link to a folder that
    // must survive, and a link of its own.
    mkdirSync(join(root, "dold"), { mode: 0o700 });
    writeFileSync(join(root, "dold", "old.txt"), "stale");
    symlinkSync(keep, join(root, "dold", "inner"));
    symlinkSync(keep, join(root, "dlink"));
    assert.equal(await remake(), root);
    assert.deepEqual(readdirSync(root), []);
    // A link in the folder's own place.
    renameSync(root, kept);
    symlinkSync(keep, root);
    assert.equal(await remake(), root);
    assert.equal(lstatSync(root).isDirectory(), true, "the link stayed");
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(keep), ["precious.txt"], "the start followed a link");
    assert.equal(readFileSync(join(keep, "precious.txt"), "utf8"), "keep");
  } finally {
    rmSync(kept, { recursive: true, force: true });
    rmSync(keep, { recursive: true, force: true });
  }
  await env.inSpace("download after remake", async page => {
    await page.goto(`${env.base}/nav-target`);
    const d = await downloadOn(page);
    assert.equal(dirname(dirname(await stagedFile(d.download))), root);
    assert.equal((await bytesOf(d.download)).toString("utf8"), FIXTURE_TEXT);
    await env.call("download.delete", { download: d.download });
  });
});

test("a sweep touches only the download folder: earlier versions' folders in the temp folder, links included, stay as they were", async () => {
  const profileDir = await env.chrome(`return PathUtils.profileDir;`);
  const root = await downloadRoot();
  let h = 0x811c9dc5;
  for (const ch of profileDir) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  const prefix = `zenius-downloads-${h.toString(16).padStart(8, "0")}`;
  // An earlier sweep took the temp folder to clear as its argument; it moved
  // such folders into the root and removed them there.
  const sweep = dir => env.chrome(`${DOWNLOADS} await D.sweepDownloadLeftovers(arg); return true;`, dir);
  // On the profile's volume, as the Linux server's /tmp and a Mac's temp folder are.
  const temp = mkdtempSync(join(dirname(profileDir), "zenius-legacy-"));
  const keep = mkdtempSync(join(tmpdir(), "zenius-i5-keep-"));
  writeFileSync(join(keep, "precious.txt"), "keep");
  const stale = join(root, "dstale");
  try {
    // An earlier version's root holding a link, and a link with such a name.
    mkdirSync(join(temp, `${prefix}-3`, "d1"), { recursive: true, mode: 0o700 });
    writeFileSync(join(temp, `${prefix}-3`, "d1", "old.txt"), "stale");
    symlinkSync(keep, join(temp, `${prefix}-3`, "d2"));
    symlinkSync(keep, join(temp, `${prefix}-4`));
    // In the root, a folder no download holds, with a link inside.
    mkdirSync(stale, { mode: 0o700 });
    symlinkSync(keep, join(stale, "inner"));
    await sweep(temp);
    assert.equal(readFileSync(join(temp, `${prefix}-3`, "d1", "old.txt"), "utf8"), "stale", "an old folder in the temp folder was removed");
    assert.equal(lstatSync(join(temp, `${prefix}-3`, "d2")).isSymbolicLink(), true, "a link in an old folder went");
    assert.equal(lstatSync(join(temp, `${prefix}-4`)).isSymbolicLink(), true, "a link with an old folder's name went");
    assert.equal(lstatOrNull(stale), null, "the root's leftover stayed");
    assert.deepEqual(readdirSync(keep), ["precious.txt"], "the sweep followed a link");
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
    rmSync(keep, { recursive: true, force: true });
  }
});

test("a link in the download folder's place before a task's download: refused, and the browser leaves nothing outside or in the working folder (I5)", () =>
  env.inSpace("download root link", async page => {
    await page.goto(`${env.base}/nav-target`);
    const held = everything(working.path);
    await withRootSwapped(async outside => {
      const e = await downloadOn(page).then(
        d => ({ downloaded: d.suggestedFilename }),
        e => e
      );
      assert.equal(e.code, "ZEN_DOWNLOAD_FAILED", JSON.stringify(e));
      assert.match(e.message, /the folder it keeps downloads in had changed \(a link stood in its place\), so the file could have landed somewhere else/);
      // The browser's own temporary file goes with its cancel.
      assert.equal(await until(() => everything(outside).length === 0 || everything(outside).join(", ")), true);
    });
    assert.deepEqual(everything(working.path), held, "something landed in the working folder");
  }));

test("a link in the download folder's place mid-task: the next download is refused, and the one already in the working folder stays as it was (I5)", () =>
  env.inSpace("download root swap", async page => {
    await page.goto(`${env.base}/nav-target`);
    const first = await downloadOn(page);
    const firstPath = await pathOf(first.download);
    await withRootSwapped(async outside => {
      const second = await downloadOn(page).then(
        d => ({ downloaded: d.suggestedFilename }),
        e => e
      );
      assert.equal(second.code, "ZEN_DOWNLOAD_FAILED", JSON.stringify(second));
      assert.match(second.message, /the folder it keeps downloads in had changed \(a link stood in its place\)/);
      assert.equal(await until(() => everything(outside).length === 0 || everything(outside).join(", ")), true);
      // The first left the staging folder when it finished: the link changes nothing for it.
      assert.equal(await pathOf(first.download), firstPath);
      assert.equal(readFileSync(firstPath, "utf8"), FIXTURE_TEXT);
    });
    assert.equal(await env.call("download.failure", { download: first.download }), null);
    await env.call("download.delete", { download: first.download });
  }));

test("a staged file, or its folder, swapped for a link before the move: the download fails, and nothing outside is moved or followed (I5)", () =>
  env.inSpace("download file swap", async page => {
    await page.goto(`${env.base}/nav-target`);
    const secret = mkdtempSync(join(tmpdir(), "zenius-i5-secret-"));
    writeFileSync(join(secret, "ego-download.txt"), "SECRET from outside the folder\n");
    const held = everything(working.path);
    try {
      for (const swap of ["file", "folder"]) {
        await withMovesHeld(async release => {
          const d = await downloadOn(page);
          // Finished, its move held.
          assert.equal(await env.call("download.failure", { download: d.download }), null, swap);
          const path = await stagedFile(d.download);
          const [from, to] = swap === "file" ? [path, join(secret, "ego-download.txt")] : [dirname(path), secret];
          renameSync(from, `${from}.gone`);
          symlinkSync(to, from);
          try {
            await release();
            const e = await env.fail("download.path", { download: d.download });
            assert.equal(e.code, "ZEN_DOWNLOAD_FAILED", swap);
            assert.match(e.message, /the folder it keeps downloads in had changed \(a link stood in (its|the file's) place\)/, swap);
            // The refusal removes the download's folder: the link in it, or
            // in its place, is unlinked, never followed.
            assert.equal(await until(() => !lstatOrNull(swap === "file" ? dirname(path) : from)), true, `${swap}: the folder stayed`);
            assert.deepEqual(readdirSync(secret), ["ego-download.txt"], swap);
            assert.equal(readFileSync(join(secret, "ego-download.txt"), "utf8"), "SECRET from outside the folder\n", swap);
            assert.deepEqual(everything(working.path), held, `${swap}: something moved into the working folder`);
            assert.match(await env.call("download.failure", { download: d.download }), /had changed/);
          } finally {
            rmSync(from, { force: true });
            rmSync(`${from}.gone`, { recursive: true, force: true });
          }
          await env.call("download.delete", { download: d.download });
        });
      }
    } finally {
      rmSync(secret, { recursive: true, force: true });
    }
  }));

test("the working folder swapped for a link before the move: the download fails with the reason, and nothing lands where the link leads", () =>
  env.inSpace("download folder swap", async page => {
    await page.goto(`${env.base}/nav-target`);
    const outside = mkdtempSync(join(tmpdir(), "zenius-wf-outside-"));
    const kept = `${working.path}.kept`;
    try {
      await withMovesHeld(async release => {
        const d = await downloadOn(page);
        assert.equal(await env.call("download.failure", { download: d.download }), null);
        const staged = await stagedFile(d.download);
        renameSync(working.path, kept);
        try {
          symlinkSync(outside, working.path);
          await release();
          const e = await env.fail("download.path", { download: d.download });
          assert.equal(e.code, "ZEN_DOWNLOAD_FAILED");
          assert.match(
            e.message,
            /couldn't move the download from .* into the working folder \(the working folder, .*, has changed since Zen started: restart Zen to read it again\), so it removed the file/
          );
          assert.deepEqual(everything(outside), []);
          assert.equal(lstatOrNull(dirname(staged)), null, "the staged file stayed");
        } finally {
          rmSync(working.path, { force: true });
          renameSync(kept, working.path);
        }
        await env.call("download.delete", { download: d.download });
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

test("a working folder that's gone is made again, readable only by the user, when a download moves in", () =>
  env.inSpace("download folder made", async page => {
    await page.goto(`${env.base}/nav-target`);
    const kept = `${working.path}.kept`;
    renameSync(working.path, kept);
    try {
      const d = await downloadOn(page);
      const path = await pathOf(d.download);
      assert.equal(dirname(path), working.path);
      assert.equal(statSync(working.path).mode & 0o777, 0o700);
      assert.equal(readFileSync(path, "utf8"), FIXTURE_TEXT);
      await env.call("download.delete", { download: d.download });
    } finally {
      rmSync(working.path, { recursive: true, force: true });
      renameSync(kept, working.path);
    }
  }));

test("a working folder the rules refuse stops each download with the reason, and nothing is saved anywhere", () =>
  env.inSpace("download folder refused", async page => {
    await page.goto(`${env.base}/nav-target`);
    const project = mkdtempSync(join(tmpdir(), "zenius-wf-project-"));
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
    const root = await downloadRoot();
    const held = { working: everything(working.path), root: everything(root) };
    try {
      assert.match((await useWorkingFolder(project)) ?? "", /it holds \.git, so it's a project's folder/);
      const e = await downloadOn(page).then(
        d => ({ downloaded: d.suggestedFilename }),
        e => e
      );
      assert.equal(e.code, "ZEN_DOWNLOAD_FAILED", JSON.stringify(e));
      assert.match(e.message, /: the working folder can't be .*: it holds \.git, so it's a project's folder, so the file had nowhere to go\. Nothing was saved/);
      assert.deepEqual(readdirSync(project), [".git"]);
      assert.deepEqual(everything(working.path), held.working);
      assert.equal(await until(() => everything(root).join() === held.root.join() || everything(root).join(", ")), true);
    } finally {
      assert.equal(await useWorkingFolder(working.path), null);
      rmSync(project, { recursive: true, force: true });
    }
  }));

test(
  "a working folder on another volume gets a copy, readable only by the user, and the staged file goes",
  { skip: !existsSync("/dev/shm") && "no /dev/shm here" },
  async t => {
    const profileDir = await env.chrome(`return PathUtils.profileDir;`);
    const other = mkdtempSync("/dev/shm/zenius-wf-");
    try {
      if (statSync(other).dev === statSync(profileDir).dev) {
        t.skip("/dev/shm is on the profile's volume here");
        return;
      }
      assert.equal(await useWorkingFolder(other), null);
      await env.inSpace("download across volumes", async page => {
        await page.goto(`${env.base}/nav-target`);
        const d = await downloadOn(page);
        const path = await pathOf(d.download);
        assert.equal(dirname(path), other);
        assert.equal(readFileSync(path, "utf8"), FIXTURE_TEXT);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.equal(lstatOrNull(dirname(await stagedFile(d.download))), null, "the staged file stayed");
        await env.call("download.delete", { download: d.download });
        assert.equal(existsSync(path), false);
      });
    } finally {
      assert.equal(await useWorkingFolder(working.path), null);
      rmSync(other, { recursive: true, force: true });
    }
  }
);

// A site of its own for the tests below: loopback only, reached as
// localhost so that it is another site than the fixture's 127.0.0.1.
async function crossSite() {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const html = body => res.end(`<!doctype html><meta charset=utf-8><body>${body}</body>`);
    if (u.pathname === "/interstitial") {
      // "Your download starts in a moment": the page starts it by itself.
      return html(`<p>starting</p><script>setTimeout(() => { location.href = "/dl?n=interstitial.txt" }, 300)</script>`);
    }
    if (u.pathname === "/refresh") {
      return html(`<meta http-equiv="refresh" content="0;url=/dl?n=refresh.txt"><p>refreshing</p>`);
    }
    if (u.pathname === "/dl") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${u.searchParams.get("n") || "cross.txt"}"`,
        "cache-control": "no-store",
      });
      return res.end("cross-site download\n");
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://localhost:${server.address().port}`, close: () => (server.closeAllConnections(), server.close()) };
}

/**
 * For `fn(temps, scratch)`: Gecko's temporary file for each agent download
 * (the launcher's file when zenius's prompt runs), and a download folder of
 * the test's own as Gecko's default, so that a temporary file zenius didn't
 * place lands there rather than in ~/Downloads.
 */
async function withTempsSeen(fn) {
  const scratch = mkdtempSync(join(tmpdir(), "zenius-dl-default-"));
  await env.chrome(
    `const { nsUnknownContentTypeDialog } = ChromeUtils.importESModule("resource://gre/modules/HelperAppDlg.sys.mjs");
     const proto = nsUnknownContentTypeDialog.prototype;
     const zen = proto.promptForSaveToFileAsync;
     proto.zsTemps = [];
     proto.zsPrompt = zen;
     proto.promptForSaveToFileAsync = function (launcher, ...rest) {
       let temp = null;
       try { temp = launcher.targetFile?.path ?? null; } catch {}
       proto.zsTemps.push(temp);
       return zen.call(this, launcher, ...rest);
     };
     proto.zsPrefs = [Services.prefs.getIntPref("browser.download.folderList", 1), Services.prefs.prefHasUserValue("browser.download.dir") ? Services.prefs.getStringPref("browser.download.dir") : null];
     Services.prefs.setIntPref("browser.download.folderList", 2);
     Services.prefs.setStringPref("browser.download.dir", arg);
     return true;`,
    scratch
  );
  const temps = () =>
    env.chrome(`return ChromeUtils.importESModule("resource://gre/modules/HelperAppDlg.sys.mjs").nsUnknownContentTypeDialog.prototype.zsTemps;`);
  try {
    return await fn(temps, scratch);
  } finally {
    await env.chrome(
      `const proto = ChromeUtils.importESModule("resource://gre/modules/HelperAppDlg.sys.mjs").nsUnknownContentTypeDialog.prototype;
       proto.promptForSaveToFileAsync = proto.zsPrompt;
       const [list, dir] = proto.zsPrefs;
       Services.prefs.setIntPref("browser.download.folderList", list);
       if (dir === null) Services.prefs.clearUserPref("browser.download.dir"); else Services.prefs.setStringPref("browser.download.dir", dir);
       delete proto.zsPrompt; delete proto.zsTemps; delete proto.zsPrefs;
       return true;`
    );
    rmSync(scratch, { recursive: true, force: true });
  }
}

const contextOf = page =>
  env.chrome(`const bc = ctx.resolvePage(arg).browser.browsingContext; return { id: bc.id, override: bc.downloadFolderOverride };`, page.P);

for (const [kind, path, name] of [
  ["an interstitial", "/interstitial", "interstitial.txt"],
  ["a meta refresh", "/refresh", "refresh.txt"],
]) {
  test(`${kind} on another site starts a download by itself: Gecko's temporary file is in zenius's folder`, () =>
    env.inSpace(`download ${kind}`, async page => {
      const cross = await crossSite();
      try {
        await page.goto(`${env.base}/nav-target`);
        const root = await downloadRoot();
        await withTempsSeen(async (temps, scratch) => {
          const before = await contextOf(page);
          assert.equal(before.override, root);
          // The wait first, as the SDK sends it; then nothing of zenius's
          // touches the tab until the download comes.
          const waiting = page.call("page.waitForEvent", { event: "download", options: { timeout: 10000 } });
          await page.evaluate(`setTimeout(() => { location.href = ${JSON.stringify(`${cross.url}${path}`)} }, 50), 1`);
          const d = await waiting;
          assert.equal(d.suggestedFilename, name);
          const after = await contextOf(page);
          assert.notEqual(after.id, before.id, "the load to another site kept the tab's context, so this test proves nothing");
          assert.equal(after.override, root);
          const seen = await temps();
          assert.equal(seen.length, 1, JSON.stringify(seen));
          assert.equal(dirname(seen[0]), root, `Gecko's temporary file: ${seen[0]}`);
          assert.deepEqual(everything(scratch), []);
          assert.equal((await bytesOf(d.download)).toString("utf8"), "cross-site download\n");
          await env.call("download.delete", { download: d.download });
        });
      } finally {
        cross.close();
      }
    }));
}

test("a download Gecko began outside zenius's folder is refused before it's saved, and its temporary file goes (fail closed)", () =>
  env.inSpace("download outside", async page => {
    await page.goto(`${env.base}/nav-target`);
    const root = await downloadRoot();
    const held = everything(root);
    await withTempsSeen(async (temps, scratch) => {
      const waiting = page.call("page.waitForEvent", { event: "download", options: { timeout: 10000 } });
      // As a context zenius never set would: no override, and a download
      // that no call of zenius's starts.
      await env.chrome(
        `const bc = ctx.resolvePage(arg.P).browser.browsingContext;
         bc.downloadFolderOverride = "";
         const uri = Services.io.newURI(arg.url);
         bc.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, {}) });
         return true;`,
        { P: page.P, url: `${env.base}/api/download` }
      );
      const e = await waiting.then(
        d => ({ downloaded: d.suggestedFilename }),
        e => e
      );
      assert.equal(e.code, "ZEN_DOWNLOAD_FAILED", JSON.stringify(e));
      assert.match(e.message, /the browser began it outside the folder zenius keeps downloads in, so zenius canceled it before saving anything/);
      const seen = await temps();
      assert.equal(seen.length, 1, JSON.stringify(seen));
      assert.equal(dirname(seen[0]), scratch, `Gecko's temporary file: ${seen[0]}`);
      assert.equal(await until(() => everything(scratch).length === 0 || everything(scratch).join(", ")), true, "its temporary file stayed");
      assert.deepEqual(everything(root), held, "something landed in zenius's folder");
      // The tab has zenius's folder again.
      assert.equal((await contextOf(page)).override, root);
    });
  }));

/** A loopback server whose download sends headers and a first chunk, then nothing. */
async function stalledServer() {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="stalled.bin"',
      "content-length": "1000000",
    });
    res.write("x".repeat(1000));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/stalled`, close: () => (server.closeAllConnections(), server.close()) };
}

const stalledInWorking = () => everything(working.path).filter(name => name.startsWith("stalled"));

test("a canceled download reports canceled, and nothing of it reaches the working folder", () =>
  env.inSpace("download cancel", async page => {
    const stalled = await stalledServer();
    try {
      await page.goto(`${env.base}/nav-target`);
      const waiting = page.call("page.waitForEvent", { event: "download", options: { timeout: 5000 } });
      await page.evaluate(`location.href = ${JSON.stringify(stalled.url)}`);
      const d = await waiting;
      assert.equal(d.suggestedFilename, "stalled.bin");
      await env.call("download.cancel", { download: d.download });
      assert.equal(await env.call("download.failure", { download: d.download }), "canceled");
      // Ego's path() throws for a failed download.
      const e = await env.fail("download.path", { download: d.download });
      assert.equal(e.code, "ZEN_DOWNLOAD_FAILED");
      assert.equal(e.data.plain, true);
      assert.equal(e.message, "download failed: canceled");
      assert.deepEqual(stalledInWorking(), []);
    } finally {
      stalled.close();
    }
  }));

test("cancel and delete change a download only while the agent controls its task (I3)", () =>
  env.inSpace("download control", async page => {
    await page.goto(`${env.base}/nav-target`);
    const d = await downloadOn(page);
    assert.equal(await env.call("download.failure", { download: d.download }), null, "the download finished");
    const path = await pathOf(d.download);
    // They name a download, not a space: the handler gates on the task the
    // download came from.
    await page.call("spaces.handOff", { reason: "manual_takeover" });
    try {
      for (const method of ["download.cancel", "download.delete"]) {
        const e = await env.fail(method, { download: d.download });
        assert.equal(e.code, "ZEN_TASK_SPACE_USER_IN_CONTROL", `${method}: ${e.code} ${e.message}`);
      }
      assert.equal(existsSync(path), true, "the file goes only by a delete the agent may make");
    } finally {
      await page.call("spaces.takeOver");
    }
    await env.call("download.delete", { download: d.download });
    assert.equal(existsSync(path), false);
  }));

test("when its script's connection closes, a finished download is forgotten and its file stays in the working folder", () =>
  env.inSpace("download cleanup", async page => {
    await page.goto(`${env.base}/nav-target`);
    const other = await connect(process.env.ZENIUS_INSTANCE);
    const waiting = other.call("page.waitForEvent", { ...page.P, event: "download", options: { timeout: 5000 } });
    await startDownload(page);
    const d = await waiting;
    const path = await pathOf(d.download, other);
    assert.equal(readFileSync(path, "utf8"), FIXTURE_TEXT);
    other.close();
    try {
      assert.equal(await until(async () => !(await known(d.download))), true, "the download outlived its connection");
      assert.equal(readFileSync(path, "utf8"), FIXTURE_TEXT, "the file went with its connection");
    } finally {
      // The test's own cleanup: the user's file would stay.
      rmSync(path, { force: true });
    }
  }));

test("when its script's connection closes, a running download is canceled, and its staged files go", () =>
  env.inSpace("download cleanup running", async page => {
    const stalled = await stalledServer();
    try {
      await page.goto(`${env.base}/nav-target`);
      const other = await connect(process.env.ZENIUS_INSTANCE);
      const waiting = other.call("page.waitForEvent", { ...page.P, event: "download", options: { timeout: 5000 } });
      await page.evaluate(`location.href = ${JSON.stringify(stalled.url)}`);
      const d = await waiting;
      const staged = await stagedFile(d.download);
      assert.ok(lstatOrNull(dirname(staged)), "no staging folder while it runs");
      other.close();
      assert.equal(await until(async () => !(await known(d.download))), true, "the download outlived its connection");
      assert.equal(await until(() => !lstatOrNull(dirname(staged))), true, "its staging folder stayed");
      assert.deepEqual(stalledInWorking(), []);
    } finally {
      stalled.close();
    }
  }));

test("a finished task's downloads are forgotten, and their files stay in the working folder", async () => {
  let download;
  let path;
  await env.inSpace("download task end", async page => {
    await page.goto(`${env.base}/nav-target`);
    const d = await downloadOn(page);
    download = d.download;
    path = await pathOf(d.download);
  });
  try {
    // inSpace finished the task.
    assert.equal(await until(async () => !(await known(download))), true, "the download outlived its task");
    assert.equal(readFileSync(path, "utf8"), FIXTURE_TEXT, "the file went with its task");
  } finally {
    rmSync(path, { force: true });
  }
});

test("waitForEvent(download) times out", () =>
  env.inSpace("download timeout", async page => {
    await page.goto(`${env.base}/nav-target`);
    const e = await page.fail("page.waitForEvent", { event: "download", options: { timeout: 200 } });
    assert.equal(e.code, "ZEN_TIMEOUT");
  }));

test("pdf.js's download button gives an ordinary agent download, with no picker", () =>
  env.inSpace("pdfjs download", async page => {
    const before = await userDownloads();
    const pdf = `${env.base}/api/openai-gpt-4-system-card.pdf`;
    await page.goto(pdf);
    // pdf.js's toolbar, once the viewer is up.
    await page.call("page.waitForSelector", { target: "#downloadButton", options: { timeout: 10000 } });
    const waiting = page.call("page.waitForEvent", { event: "download", options: { timeout: 10000 } });
    await page.call("page.click", { target: "#downloadButton" });
    const d = await waiting;
    assert.equal(d.url, pdf);
    assert.equal(d.suggestedFilename, "openai-gpt-4-system-card.pdf");
    const served = Buffer.from(await (await fetch(pdf)).arrayBuffer());
    assert.ok((await bytesOf(d.download)).equals(served), "the saved bytes are the PDF the server sent");
    assert.equal(await env.call("download.failure", { download: d.download }), null);
    // No Save As picker, nothing in the user's downloads.
    const pickers = await env.chrome(
      `return [...Services.wm.getEnumerator(null)].filter(w => /filepicker|unknownContentType/i.test(w.document?.documentElement?.id ?? "")).length;`
    );
    assert.equal(pickers, 0);
    assert.deepEqual(await userDownloads(), before);
    const events = await page.call("page.events");
    assert.ok(events.some(e => e.method === "Page.downloadWillBegin" && e.params.url === pdf), JSON.stringify(events.map(e => e.method)));
    await env.call("download.delete", { download: d.download });

    // Firefox's Save Page (Cmd+S) on a pdf.js tab asks pdf.js to save: the
    // same path, the same download.
    const viaKey = page.call("page.waitForEvent", { event: "download", options: { timeout: 10000 } });
    await env.chrome(`ctx.resolvePage(arg).browser.sendMessageToActor("PDFJS:Save", {}, "PdfJs"); return true;`, page.P);
    const k = await viaKey;
    assert.equal(k.url, pdf);
    assert.ok((await bytesOf(k.download)).equals(served));
    await env.call("download.delete", { download: k.download });
  }));
