// Downloads from agent tabs: no panel, nothing in the user's Downloads folder
// or list, a temporary file whose bytes the agent reads (download.read; I5:
// the client writes saveAs and path copies) or deletes, removed when the
// script's connection closes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { connect } from "../../scripts/lib/rpc.mjs";
import { setup } from "./lib.mjs";

let env;
before(async () => {
  env = await setup();
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

/** All of a download's bytes, read in chunks of `length` as the SDK does. */
async function readAll(download, length, client = env) {
  const chunks = [];
  for (let offset = 0; ; ) {
    const { base64, size, eof } = await client.call("download.read", { download, offset, ...(length ? { length } : {}) });
    const chunk = Buffer.from(base64, "base64");
    chunks.push(chunk);
    offset += chunk.length;
    if (eof) {
      assert.equal(offset, size);
      return Buffer.concat(chunks);
    }
    assert.ok(chunk.length > 0, "a chunk before the end is never empty");
  }
}

/** Where the runtime keeps a download's temporary file (tests only; agents never see it). */
const tempFile = download =>
  env.chrome(
    `const { getDownload } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/downloads.sys.mjs");
     return getDownload(arg)?.download.target.path ?? null;`,
    download
  );

/** Start a download from the page the way a link click does. */
const startDownload = (page, query = "") =>
  page.evaluate(`(() => { const a = document.createElement("a"); a.href = "/api/download${query}"; document.body.append(a); a.click(); return 1 })()`);

test("a download lands in a temporary file, out of the user's view", () =>
  env.inSpace("download", async page => {
    await page.goto(`${env.base}/nav-target`);
    const before = await userDownloads();
    const waiting = page.call("page.waitForEvent", { event: "download", options: { timeout: 5000 } });
    await startDownload(page);
    const d = await waiting;
    assert.equal(d.suggestedFilename, "ego-download.txt");
    assert.equal(d.url, `${env.base}/api/download`);
    const path = await tempFile(d.download);
    const profileDir = await env.chrome(`return PathUtils.profileDir;`);
    assert.equal(dirname(dirname(path)), join(profileDir, "zenius-downloads"));
    assert.match(path, /\/zenius-downloads\/d[0-9a-z]+\/ego-download\.txt$/);
    const text = "ego-browser download fixture\n";
    assert.equal((await readAll(d.download)).toString("utf8"), text);
    // Chunks: offsets and lengths as the SDK sends them, past the end too.
    assert.equal((await readAll(d.download, 5)).toString("utf8"), text);
    assert.deepEqual(await env.call("download.read", { download: d.download, offset: 100, length: 4 }), { base64: "", size: text.length, eof: true });
    assert.equal(await env.call("download.failure", { download: d.download }), null);
    assert.deepEqual(await userDownloads(), before, "the download reached the user's folder, list or panel");

    await env.call("download.delete", { download: d.download });
    assert.equal(existsSync(path), false);
    const gone = await env.fail("download.read", { download: d.download });
    assert.equal(gone.code, "ZEN_DOWNLOAD_FAILED");
  }));

test("no Download method takes or returns a path (I5); read's chunks are bounded", () =>
  env.inSpace("download paths", async page => {
    await page.goto(`${env.base}/nav-target`);
    const waiting = page.call("page.waitForEvent", { event: "download", options: { timeout: 5000 } });
    await startDownload(page);
    const d = await waiting;
    for (const [method, params] of [
      ["download.saveAs", { path: "/tmp/zenius-i5-saved.txt" }],
      ["download.path", {}],
    ]) {
      const e = await env.fail(method, { download: d.download, ...params });
      assert.equal(e.code, "ZEN_INVALID_ARGUMENT");
      assert.match(e.message, new RegExp(`^${method.replace(".", "\\.")} takes and returns no path: read the file's bytes with download\\.read`));
    }
    assert.equal(existsSync("/tmp/zenius-i5-saved.txt"), false);
    for (const params of [{ length: 8 * 1024 * 1024 + 1 }, { length: 0 }, { offset: -1 }, { offset: 1.5 }]) {
      const e = await env.fail("download.read", { download: d.download, ...params });
      assert.equal(e.code, "ZEN_INVALID_ARGUMENT", JSON.stringify(params));
    }
    await env.call("download.delete", { download: d.download });
  }));

const DOWNLOADS = `const D = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/downloads.sys.mjs");`;
const downloadRoot = () => env.chrome(`${DOWNLOADS} return D.downloadRoot();`);
const FIXTURE_TEXT = "ego-browser download fixture\n";

/** Poll `check` until it gives true or `ms` pass; its last value. */
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v === true || Date.now() > end) {
      return v;
    }
    await new Promise(r => setTimeout(r, 50));
  }
}

/** A download from the page, waited for. */
async function downloadOn(page) {
  const waiting = page.call("page.waitForEvent", { event: "download", options: { timeout: 5000 } });
  await startDownload(page);
  return waiting;
}

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

const everything = dir => readdirSync(dir, { recursive: true }).sort();
const lstatOrNull = path => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

test("downloads land in the profile's own 0700 folder; a start makes it afresh, unlinking links there and following none", async () => {
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
    assert.equal(dirname(dirname(await tempFile(d.download))), root);
    assert.equal((await readAll(d.download)).toString("utf8"), FIXTURE_TEXT);
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

test("a link in the download folder's place before a task's download: refused, and the browser leaves nothing outside (I5)", () =>
  env.inSpace("download root link", async page => {
    await page.goto(`${env.base}/nav-target`);
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
  }));

test("a link in the download folder's place mid-task: the next download is refused, and an earlier one isn't read through it (I5)", () =>
  env.inSpace("download root swap", async page => {
    await page.goto(`${env.base}/nav-target`);
    const first = await downloadOn(page);
    assert.equal((await readAll(first.download)).toString("utf8"), FIXTURE_TEXT);
    const firstPath = await tempFile(first.download);
    await withRootSwapped(async (outside, root) => {
      // Outside, a file where the first download's is, seen through the link.
      const rel = relative(root, firstPath);
      mkdirSync(join(outside, dirname(rel)));
      writeFileSync(join(outside, rel), "SECRET from outside the folder\n");
      const read = await env.fail("download.read", { download: first.download });
      assert.equal(read.code, "ZEN_DOWNLOAD_FAILED");
      assert.match(read.message, /the folder it keeps downloads in had changed \(a link stood in its place\)/);
      const second = await downloadOn(page).then(
        d => ({ downloaded: d.suggestedFilename }),
        e => e
      );
      assert.equal(second.code, "ZEN_DOWNLOAD_FAILED", JSON.stringify(second));
      const planted = [dirname(rel), rel].sort();
      assert.equal(await until(() => everything(outside).join() === planted.join() || everything(outside).join(", ")), true);
      assert.equal(readFileSync(join(outside, rel), "utf8"), "SECRET from outside the folder\n");
    });
    // Once refused, it stays failed; the task's end removes its folder.
    assert.match(await env.call("download.failure", { download: first.download }), /had changed/);
  }));

test("a finished download's file, or its folder, swapped for a link: download.read refuses it rather than read outside (I5)", () =>
  env.inSpace("download file swap", async page => {
    await page.goto(`${env.base}/nav-target`);
    const secret = mkdtempSync(join(tmpdir(), "zenius-i5-secret-"));
    writeFileSync(join(secret, "ego-download.txt"), "SECRET from outside the folder\n");
    try {
      for (const swap of ["file", "folder"]) {
        const d = await downloadOn(page);
        const path = await tempFile(d.download);
        assert.equal((await readAll(d.download)).toString("utf8"), FIXTURE_TEXT);
        const [from, to] = swap === "file" ? [path, join(secret, "ego-download.txt")] : [dirname(path), secret];
        renameSync(from, `${from}.gone`);
        symlinkSync(to, from);
        try {
          const e = await env.fail("download.read", { download: d.download });
          assert.equal(e.code, "ZEN_DOWNLOAD_FAILED", swap);
          assert.match(e.message, /the folder it keeps downloads in had changed \(a link stood in (its|the file's) place\)/, swap);
          // The refusal removes the download's folder: the link in it, or in
          // its place, is unlinked, never followed.
          assert.equal(await until(() => !existsSync(dirname(path)) && !lstatOrNull(dirname(path))), true, `${swap}: the folder stayed`);
          assert.deepEqual(readdirSync(secret), ["ego-download.txt"], swap);
          assert.equal(readFileSync(join(secret, "ego-download.txt"), "utf8"), "SECRET from outside the folder\n", swap);
          assert.match(await env.call("download.failure", { download: d.download }), /had changed/);
        } finally {
          rmSync(from, { force: true });
          rmSync(`${from}.gone`, { recursive: true, force: true });
        }
        await env.call("download.delete", { download: d.download });
      }
    } finally {
      rmSync(secret, { recursive: true, force: true });
    }
  }));

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
          assert.equal((await readAll(d.download)).toString("utf8"), "cross-site download\n");
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

test("a canceled download reports canceled", () =>
  env.inSpace("download cancel", async page => {
    // The shared fixture has no download whose body stalls; serve one here
    // (loopback only): headers and a first chunk, then nothing.
    const stalled = createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="stalled.bin"',
        "content-length": "1000000",
      });
      res.write("x".repeat(1000));
    });
    await new Promise(resolve => stalled.listen(0, "127.0.0.1", resolve));
    try {
      await page.goto(`${env.base}/nav-target`);
      const waiting = page.call("page.waitForEvent", { event: "download", options: { timeout: 5000 } });
      await page.evaluate(`location.href = "http://127.0.0.1:${stalled.address().port}/stalled"`);
      const d = await waiting;
      assert.equal(d.suggestedFilename, "stalled.bin");
      await env.call("download.cancel", { download: d.download });
      assert.equal(await env.call("download.failure", { download: d.download }), "canceled");
      // Ego's path() throws for a failed download, as read does.
      const e = await env.fail("download.read", { download: d.download });
      assert.equal(e.code, "ZEN_DOWNLOAD_FAILED");
      assert.equal(e.data.plain, true);
      assert.equal(e.message, "download failed: canceled");
    } finally {
      stalled.closeAllConnections();
      stalled.close();
    }
  }));

test("cancel and delete change a download only while the agent controls its task (I3)", () =>
  env.inSpace("download control", async page => {
    await page.goto(`${env.base}/nav-target`);
    const waiting = page.call("page.waitForEvent", { event: "download", options: { timeout: 5000 } });
    await startDownload(page);
    const d = await waiting;
    assert.equal(await env.call("download.failure", { download: d.download }), null, "the download finished");
    const path = await tempFile(d.download);
    // They name a download, not a space: the handler gates on the task the
    // download came from.
    await page.call("spaces.handOff", { reason: "manual_takeover" });
    try {
      for (const method of ["download.cancel", "download.delete"]) {
        const e = await env.fail(method, { download: d.download });
        assert.equal(e.code, "ZEN_TASK_SPACE_USER_IN_CONTROL", `${method}: ${e.code} ${e.message}`);
      }
      assert.equal(existsSync(path), true, "the file stays while the user holds the task");
    } finally {
      await page.call("spaces.takeOver");
    }
    await env.call("download.delete", { download: d.download });
    assert.equal(existsSync(path), false);
  }));

test("temporary files go when the script's connection closes", () =>
  env.inSpace("download cleanup", async page => {
    await page.goto(`${env.base}/nav-target`);
    const other = await connect(process.env.ZENIUS_INSTANCE);
    const waiting = other.call("page.waitForEvent", { ...page.P, event: "download", options: { timeout: 5000 } });
    await startDownload(page);
    const d = await waiting;
    assert.equal((await readAll(d.download, undefined, other)).toString("utf8"), "ego-browser download fixture\n");
    const path = await tempFile(d.download);
    other.close();
    const end = Date.now() + 3000;
    while (existsSync(path)) {
      assert.ok(Date.now() < end, "the temporary file outlived its connection");
      await new Promise(r => setTimeout(r, 50));
    }
  }));

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
    assert.ok((await readAll(d.download)).equals(served), "the saved bytes are the PDF the server sent");
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
    assert.ok((await readAll(k.download)).equals(served));
    await env.call("download.delete", { download: k.download });
  }));
