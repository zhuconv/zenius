// Red team of the runtime's staging folders (zen-input's find, 2026-11-21):
// a file chooser's upload, and an agent tab's download, are written by the
// browser, outside any agent sandbox. If the agent's own CLI can write the
// folder they go through (the system temp folder, $TMPDIR, which sandboxed
// CLIs may write), can it plant or swap links there so that the browser
// writes agent-chosen bytes elsewhere (~/Library/LaunchAgents, say), or
// deletes elsewhere when it sweeps its leftovers?
//
// This probe's own process plays that CLI: it watches the staging folder and
// plants links the moment the runtime's folders appear. "Outside" is a fresh
// folder of this run (ZS_OUTSIDE, else one under the system temp folder),
// never a real one. Start the Zen with TMPDIR pointing at a folder of yours,
// so every write stays there:
//
//   TMPDIR=<dir> scripts/zen-dev.sh <name> start
//   ZENIUS_INSTANCE=<name> node tests/snapshot/tools/staging-probe.mjs [case ...] > out.json
//
// Uploads go through the file chooser (page.waitForEvent, a click,
// filechooser.setFiles): its answer is what the runtime writes to disk.
//
// Cases: uploadSubLink (a link where the second file's folder goes, while a
// big first file is written), uploadSubLink0 (one file: the race for its
// folder), uploadLeafLink (a link where the file itself goes), uploadDirSwap
// (the upload's folder swapped for a link), uploadRootLink (the staging
// root replaced by a link, for a root of the runtime's own), uploadFile0 (a
// file where a folder goes), sweepLink (a leftover-named link, and a leftover
// holding a link, then the sweep), downloadDirSwap (a download's folder
// swapped for a link), downloadRootSwap (the run's download root swapped for
// a link: no race), downloadPartLink (a link where the download's .part
// file goes). Each says where the bytes landed. Headless on the Linux server only.
//
// Folder uploads (input-gaps 24; cases added by zen-input, as glue, at the
// manager's word): a folder chooser's answer is a tree,
// upload-<n>/<relativePath>, and Gecko walks it for the page afterwards.
// folderTopLink (a link where the folder itself goes, the race right after
// upload-<n> appears), folderSubLink (a link where a subfolder goes, while
// a big file is written before it), folderLeafLink (a link where a file of a
// subfolder goes), folderNestedSwap and folderTopSwap (a subfolder, or the
// folder itself, swapped for a link while a big file is written in it),
// folderClimb (relativePaths that try to climb out of the tree, then a tree
// of look-alike names that must stay inside), folderWalkLink (a link to a
// file outside, planted in the tree after the runtime's last write, at
// several delays: does Gecko's walk hand it to the page? Its walk skips
// every link, Bug 1813299).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

if (process.platform === "darwin") {
  console.error("staging-probe: headless on the Linux server only");
  process.exit(2);
}
const here = dirname(new URL(import.meta.url).pathname);
const instance = process.env.ZENIUS_INSTANCE;
if (!instance) {
  console.error("ZENIUS_INSTANCE is not set");
  process.exit(2);
}
const wanted = process.argv.slice(2);
const outside = process.env.ZS_OUTSIDE ? mkdtempSync(join(process.env.ZS_OUTSIDE, "outside-")) : mkdtempSync(join(tmpdir(), "zs-staging-outside-"));
const PORT = Number(process.env.ZS_PORT_STAGING) || 47457;
const A = `http://127.0.0.1:${PORT}`;
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const page = (title, body) => `<!doctype html><meta charset=utf-8><title>${title}</title><body>${body}</body>`;
const server = await new Promise((ok, fail) => {
  const s = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/files") return res.end(page("files", `<input type=file id=f multiple>`));
    if (u.pathname === "/one") return res.end(page("one", `<input type=file id=f>`));
    if (u.pathname === "/folder")
      return res.end(
        page(
          "folder",
          `<input type=file id=f webkitdirectory><script>
f.addEventListener("change", async () => {
  const got = [];
  for (const x of f.files) got.push({ path: x.webkitRelativePath, size: x.size, text: x.size < 256 ? await x.text() : null });
  document.body.dataset.got = JSON.stringify(got);
});
</script>`
        )
      );
    if (u.pathname === "/dl") {
      // A download of chosen bytes, its body after a pause: the time a
      // planted link has to be in place.
      const name = u.searchParams.get("n") || "zs-download.txt";
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" });
      setTimeout(() => res.end(`ZS_DOWNLOADED_BYTES ${u.searchParams.get("k") || ""}\n`), Number(u.searchParams.get("wait")) || 0);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  s.once("error", fail);
  s.listen(PORT, "127.0.0.1", () => ok(s));
});

const { connect } = await import(join(here, "../../../scripts/lib/rpc.mjs"));
const client = await connect(instance, { callTimeout: 120000 });
const chrome = (code, arg) => client.call("dev.evalChrome", { code, arg });
const err = e => `${e?.code ?? ""} ${String(e?.message ?? e).slice(0, 200)}`.trim();
const FC = `const FC = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/filechooser.sys.mjs");`;
const DL = `const DLM = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/downloads.sys.mjs");`;

/** A task on one of this probe's pages. */
async function task(name, path) {
  const { id: space } = await client.call("spaces.create", { name: `${name}-${Date.now().toString(36).slice(-5)}` });
  await client.call("page.goto", { space, page: "p1", url: `${A}${path}` });
  return space;
}
const b64 = s => Buffer.from(s).toString("base64");
// Through the file chooser, as a site's own upload button goes: its answer
// is the one written to disk (page.setInputFiles hands the input files in
// memory).
async function upload(space, files) {
  const chooser = client.call("page.waitForEvent", { space, page: "p1", event: "filechooser", options: { timeout: 10000 } });
  chooser.catch(() => {});
  await sleep(150);
  const clicked = await client.call("page.click", { space, page: "p1", target: "#f", options: {} }).then(() => null, err);
  const ev = await chooser.catch(e => ({ error: err(e) }));
  if (!ev?.chooser) return `no chooser: ${clicked ?? ""} ${JSON.stringify(ev).slice(0, 160)}`;
  return client.call("filechooser.setFiles", { chooser: ev.chooser, files }).then(() => "ok", err);
}

/**
 * The CLI: watch `root`, and for each new entry whose name `match`es, run
 * `plant(path)` at once (inotify, and a 1 ms poll behind it).
 */
function plantOn(root, match, plant) {
  const seen = new Set(existsSync(root) ? readdirSync(root) : []);
  const hits = [];
  const check = name => {
    if (seen.has(name)) return;
    seen.add(name);
    if (!match(name)) return;
    try {
      hits.push({ name, ...plant(join(root, name)) });
    } catch (e) {
      hits.push({ name, error: e.code || e.message });
    }
  };
  let w = null;
  try {
    w = watch(root, (_ev, name) => name && check(String(name)));
  } catch {}
  const poll = setInterval(() => {
    try {
      for (const n of readdirSync(root)) check(n);
    } catch {}
  }, 1);
  return { hits, stop: () => (w?.close(), clearInterval(poll)) };
}
const list = dir => {
  try {
    return readdirSync(dir, { recursive: true }).sort();
  } catch (e) {
    return e.code;
  }
};
const kind = p => {
  try {
    const s = lstatSync(p);
    return s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
};
const fresh = name => {
  const d = join(outside, name);
  mkdirSync(d);
  return d;
};

/** A folder upload's file, `text` its contents: `rel` is its relativePath. */
const ffile = (rel, text) => ({ name: basename(rel), relativePath: rel, base64: b64(text) });
/** The same, with BIG's 24 MiB: the time a racing CLI has while it's written. */
const fbig = rel => ({ name: basename(rel), relativePath: rel, base64: BIG });
/** What the folder page's input got: [{path, size, text}], or null before its change event. */
const pageGot = space =>
  client.call("page.evaluate", { space, page: "p1", fn: "() => document.body.dataset.got ?? null", isFunction: true }).then(
    r => {
      const v = r?.value ?? r?.result ?? r;
      return typeof v === "string" ? JSON.parse(v) : v;
    },
    e => ({ error: err(e) })
  );
/** Opens the page's chooser with a click on #f: the chooser's id, or a string saying why not. */
async function chooserOn(space) {
  const chooser = client.call("page.waitForEvent", { space, page: "p1", event: "filechooser", options: { timeout: 10000 } });
  chooser.catch(() => {});
  await sleep(150);
  const clicked = await client.call("page.click", { space, page: "p1", target: "#f", options: {} }).then(() => null, err);
  const ev = await chooser.catch(e => ({ error: err(e) }));
  return ev?.chooser ?? `no chooser: ${clicked ?? ""} ${JSON.stringify(ev).slice(0, 160)}`;
}

/**
 * The CLI, deeper in a folder upload: once an upload's folder appears, it
 * waits (a 1 ms poll) for `rel` inside it, a folder or file the runtime
 * makes, then runs `plant(dir)` at once.
 */
function plantInside(rel, plant, { after = 0 } = {}) {
  const hits = [];
  const polls = [];
  const outer = plantOn(where.uploadRoot, n => n.startsWith(where.uploadPrefix) && !n.includes("."), dir => {
    const target = join(dir, rel);
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (existsSync(target)) {
        clearInterval(iv);
        const saw = Date.now() - t0;
        const go = () => {
          const at = { dir: basename(dir), saw, planted_ms: Date.now() - t0 };
          try {
            hits.push({ ...at, ...plant(dir) });
          } catch (e) {
            hits.push({ ...at, error: e.code || e.message });
          }
        };
        after ? setTimeout(go, after) : go();
      } else if (Date.now() - t0 > 15000) {
        clearInterval(iv);
        hits.push({ dir: basename(dir), error: `never saw ${rel}` });
      }
    }, 1);
    polls.push(iv);
    return { watching: rel };
  });
  return { hits, seen: outer.hits, stop: () => (outer.stop(), polls.forEach(clearInterval)) };
}
/**
 * Where a climb out of <root>/upload-<n>/zsf could land: `name` directly in
 * each of `dirs`, and in each upload folder in the root. No recursive walk:
 * the profiles folder holds every dev profile.
 */
const climbedTo = (dirs, name) => {
  const ups = (() => {
    try {
      return readdirSync(where.uploadRoot).map(n => join(where.uploadRoot, n));
    } catch {
      return [];
    }
  })();
  return [...new Set([...dirs, ...ups, "/"])].map(d => join(d, name)).filter(p => kind(p));
};

// Where the runtime stages: found from a plain upload and a plain download.
let where = null;
async function discover() {
  const space = await task("zs-staging-find", "/one");
  const up = await upload(space, [{ name: "find.txt", base64: b64("find") }]);
  const held = await chrome(`${FC} return FC.uploadDirectories?.() ?? [];`);
  const dir = held.at(-1) ?? null;
  const dlRoot = await chrome(`${DL} return (await DLM.downloadRoot?.()) ?? null;`).catch(e => ({ error: err(e) }));
  const info = await chrome(`return { tempDir: PathUtils.tempDir, profileDir: PathUtils.profileDir };`);
  await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
  where = {
    ...info,
    up,
    uploadDir: dir,
    uploadRoot: dir ? dirname(dir) : null,
    uploadPrefix: dir ? basename(dir).replace(/-\d+$/, "") : null,
    downloadRoot: typeof dlRoot === "string" ? dlRoot : null,
    downloadRootError: typeof dlRoot === "string" ? null : dlRoot,
  };
  step("where", JSON.stringify(where));
  return where;
}

const BIG = Buffer.alloc(24 * 1024 * 1024, 0x61).toString("base64");
const PAYLOAD = "ZS_AGENT_CHOSEN_BYTES\n";

const CASES = {
  // zen-input's case: while the first, big file is written, the CLI puts a
  // link where the second file's folder goes.
  async uploadSubLink() {
    const target = fresh("uploadSubLink");
    const space = await task("zs-staging-sub", "/files");
    const p = plantOn(where.uploadRoot, n => n.startsWith(where.uploadPrefix), dir => (symlinkSync(target, join(dir, "1")), { planted: "1 -> outside" }));
    const res = await upload(space, [{ name: "big.bin", base64: BIG }, { name: "zs-planted.plist", base64: b64(PAYLOAD) }]);
    await sleep(500);
    p.stop();
    await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    return { res, planted: p.hits, outside: list(target), landed: existsSync(join(target, "zs-planted.plist")) };
  },
  // One small file: the race for its folder, right after the upload's folder appears.
  async uploadSubLink0() {
    const out = [];
    for (let i = 0; i < 5; i++) {
      const target = fresh(`uploadSubLink0-${i}`);
      const space = await task("zs-staging-sub0", "/one");
      const p = plantOn(where.uploadRoot, n => n.startsWith(where.uploadPrefix), dir => (symlinkSync(target, join(dir, "0")), { planted: "0 -> outside" }));
      const res = await upload(space, [{ name: "zs-planted.plist", base64: b64(PAYLOAD) }]);
      await sleep(300);
      p.stop();
      await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
      out.push({ res, planted: p.hits.length, landed: existsSync(join(target, "zs-planted.plist")) });
    }
    return { tries: out, landed: out.filter(t => t.landed).length };
  },
  // A link where the second file itself goes, inside a real folder the CLI makes.
  async uploadLeafLink() {
    const target = fresh("uploadLeafLink");
    writeFileSync(join(target, "victim.txt"), "ORIGINAL\n");
    const space = await task("zs-staging-leaf", "/files");
    const p = plantOn(where.uploadRoot, n => n.startsWith(where.uploadPrefix), dir => {
      mkdirSync(join(dir, "1"));
      symlinkSync(join(target, "victim.txt"), join(dir, "1", "zs-planted.plist"));
      return { planted: "1/zs-planted.plist -> outside/victim.txt" };
    });
    const res = await upload(space, [{ name: "big.bin", base64: BIG }, { name: "zs-planted.plist", base64: b64(PAYLOAD) }]);
    await sleep(500);
    p.stop();
    await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    return { res, planted: p.hits, victim: readFileSync(join(target, "victim.txt"), "utf8"), victimMode: (statSync(join(target, "victim.txt")).mode & 0o777).toString(8) };
  },
  // The upload's own folder, once made, swapped for a link to outside.
  async uploadDirSwap() {
    const target = fresh("uploadDirSwap");
    const space = await task("zs-staging-swap", "/files");
    const p = plantOn(where.uploadRoot, n => n.startsWith(where.uploadPrefix) && !n.endsWith(".gone"), dir => {
      renameSync(dir, dir + ".gone");
      symlinkSync(target, dir);
      return { swapped: "folder -> outside" };
    });
    const res = await upload(space, [{ name: "big.bin", base64: BIG }, { name: "zs-planted.plist", base64: b64(PAYLOAD) }]);
    await sleep(500);
    p.stop();
    await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    return { res, swapped: p.hits, outside: list(target), landed: list(target) instanceof Array && list(target).some(f => f.endsWith("zs-planted.plist")) };
  },
  // The staging root itself replaced by a link, when the root is the
  // runtime's own (under the profile); the system temp folder can't be.
  async uploadRootLink() {
    if (where.uploadRoot === where.tempDir) return { skipped: "the root is the system temp folder itself" };
    const target = fresh("uploadRootLink");
    const root = where.uploadRoot;
    const kept = root + ".kept";
    renameSync(root, kept);
    symlinkSync(target, root);
    try {
      const space = await task("zs-staging-root", "/one");
      const res = await upload(space, [{ name: "zs-planted.plist", base64: b64(PAYLOAD) }]);
      await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
      return { res, outside: list(target), landed: list(target) instanceof Array && list(target).some(f => f.endsWith("zs-planted.plist")) };
    } finally {
      rmSync(root, { force: true });
      renameSync(kept, root);
    }
  },
  // A file where a folder goes: does the upload fail cleanly?
  async uploadFile0() {
    const space = await task("zs-staging-file0", "/one");
    const p = plantOn(where.uploadRoot, n => n.startsWith(where.uploadPrefix), dir => (writeFileSync(join(dir, "0"), "x"), { planted: "file 0" }));
    const res = await upload(space, [{ name: "zs-planted.plist", base64: b64(PAYLOAD) }]);
    await sleep(300);
    p.stop();
    await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    return { res, planted: p.hits };
  },
  // Leftover-named entries the CLI plants: a link to a folder of files, and
  // a real folder holding a link to another. Then the sweep the runtime runs
  // at its first upload (called here directly). Do the files survive?
  async sweepLink() {
    const a = fresh("sweepLinkA");
    const b = fresh("sweepLinkB");
    writeFileSync(join(a, "canary.txt"), "A\n");
    writeFileSync(join(b, "canary.txt"), "B\n");
    const linkName = join(where.uploadRoot, `${where.uploadPrefix}-9077`);
    const dirName = join(where.uploadRoot, `${where.uploadPrefix}-9078`);
    symlinkSync(a, linkName);
    mkdirSync(dirName);
    symlinkSync(b, join(dirName, "inner"));
    const swept = await chrome(`${FC} await FC.sweepUploadLeftovers(); return true;`).catch(e => ({ error: err(e) }));
    const out = { swept, linkLeft: kind(linkName), dirLeft: kind(dirName), canaryA: existsSync(join(a, "canary.txt")), canaryB: existsSync(join(b, "canary.txt")) };
    rmSync(linkName, { force: true });
    rmSync(dirName, { recursive: true, force: true });
    // The download root's sweep, the same way.
    if (where.downloadRoot) {
      const c = fresh("sweepLinkC");
      writeFileSync(join(c, "canary.txt"), "C\n");
      const dPrefix = basename(where.downloadRoot).replace(/-\d+$/, "");
      const dLink = join(dirname(where.downloadRoot), `${dPrefix}-9079`);
      symlinkSync(c, dLink);
      out.downloadSwept = await chrome(`${DL} await DLM.sweepDownloadLeftovers(); return true;`).catch(e => ({ error: err(e) }));
      out.downloadLinkLeft = kind(dLink);
      out.canaryC = existsSync(join(c, "canary.txt"));
      rmSync(dLink, { force: true });
    }
    return out;
  },
  // A download's folder, once made, swapped for a link to outside; the body
  // comes 1.5 s later.
  async downloadDirSwap() {
    if (!where.downloadRoot) return { skipped: "no download root", where };
    const target = fresh("downloadDirSwap");
    const space = await task("zs-staging-dlswap", "/one");
    const p = plantOn(where.downloadRoot, n => /^d[0-9a-z]+$/.test(n), dir => {
      renameSync(dir, dir + ".gone");
      symlinkSync(target, dir);
      return { swapped: "folder -> outside" };
    });
    const nav = await client.call("page.goto", { space, page: "p1", url: `${A}/dl?n=zs-dl.plist&k=swap&wait=1500` }).then(() => "ok", err);
    await sleep(4000);
    p.stop();
    await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    return { nav, swapped: p.hits, outside: list(target), landed: list(target) instanceof Array && list(target).some(f => /zs-dl/.test(f)) };
  },
  // The run's download root, there all run, swapped for a link to outside:
  // no race. Put back after.
  async downloadRootSwap() {
    if (!where.downloadRoot) return { skipped: "no download root", where };
    const target = fresh("downloadRootSwap");
    const root = where.downloadRoot;
    const kept = root + ".kept";
    renameSync(root, kept);
    symlinkSync(target, root);
    try {
      const space = await task("zs-staging-dlroot", "/one");
      const nav = await client.call("page.goto", { space, page: "p1", url: `${A}/dl?n=zs-dl.plist&k=root` }).then(() => "ok", err);
      await sleep(3000);
      // Before the task's end, which deletes its downloads (through the link too).
      const before = list(target);
      await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
      return { nav, outsideBeforeFinish: before, outsideAfterFinish: list(target), landed: before instanceof Array && before.some(f => /zs-dl/.test(f)) };
    } finally {
      rmSync(root, { force: true });
      renameSync(kept, root);
    }
  },
  // A link where the download's .part file goes, to a file outside.
  async downloadPartLink() {
    if (!where.downloadRoot) return { skipped: "no download root", where };
    const target = fresh("downloadPartLink");
    writeFileSync(join(target, "victim.txt"), "ORIGINAL\n");
    const space = await task("zs-staging-dlpart", "/one");
    const p = plantOn(where.downloadRoot, n => /^d[0-9a-z]+$/.test(n), dir => {
      symlinkSync(join(target, "victim.txt"), join(dir, "zs-dl.plist.part"));
      symlinkSync(join(target, "victim.txt"), join(dir, "zs-dl.plist"));
      return { planted: ".part and the file -> outside/victim.txt" };
    });
    const nav = await client.call("page.goto", { space, page: "p1", url: `${A}/dl?n=zs-dl.plist&k=part&wait=1500` }).then(() => "ok", err);
    await sleep(4000);
    p.stop();
    await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    return { nav, planted: p.hits, victim: readFileSync(join(target, "victim.txt"), "utf8"), outside: list(target), staged: p.hits.map(h => ({ name: h.name, left: list(join(where.downloadRoot, h.name)) })) };
  },

  // Folder uploads. The race for the folder itself, right after upload-<n>
  // appears: a link to outside where the runtime makes the folder.
  async folderTopLink() {
    const out = [];
    for (let i = 0; i < 5; i++) {
      const target = fresh(`folderTopLink-${i}`);
      const space = await task("zs-staging-ftop", "/folder");
      const p = plantOn(where.uploadRoot, n => n.startsWith(where.uploadPrefix), dir => (symlinkSync(target, join(dir, "zsf")), { planted: "zsf -> outside" }));
      const res = await upload(space, [ffile("zsf/zs-planted.plist", PAYLOAD), ffile("zsf/sub/zs-planted2.plist", PAYLOAD)]);
      await sleep(300);
      p.stop();
      const got = await pageGot(space);
      await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
      out.push({ res, planted: p.hits, outside: list(target), pageGot: got?.length ?? got });
    }
    return { tries: out, landed: out.filter(t => t.outside instanceof Array && t.outside.length).length };
  },
  // A link where a subfolder goes, planted while the big file before it is written.
  async folderSubLink() {
    const target = fresh("folderSubLink");
    const space = await task("zs-staging-fsub", "/folder");
    const p = plantInside("zsf/big.bin", dir => (symlinkSync(target, join(dir, "zsf", "sub")), { planted: "zsf/sub -> outside" }));
    const res = await upload(space, [fbig("zsf/big.bin"), ffile("zsf/sub/zs-planted.plist", PAYLOAD)]);
    await sleep(500);
    p.stop();
    const got = await pageGot(space);
    await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    return { res, planted: p.hits, outside: list(target), landed: existsSync(join(target, "zs-planted.plist")), pageGot: got?.length ?? got };
  },
  // A link where a subfolder's file goes, to a file outside, planted while a big file is written in that subfolder.
  async folderLeafLink() {
    const target = fresh("folderLeafLink");
    writeFileSync(join(target, "victim.txt"), "ORIGINAL\n");
    const space = await task("zs-staging-fleaf", "/folder");
    const p = plantInside("zsf/sub/big.bin", dir => (symlinkSync(join(target, "victim.txt"), join(dir, "zsf", "sub", "zs-planted.plist")), { planted: "zsf/sub/zs-planted.plist -> outside/victim.txt" }));
    const res = await upload(space, [fbig("zsf/sub/big.bin"), ffile("zsf/sub/zs-planted.plist", PAYLOAD)]);
    await sleep(500);
    p.stop();
    const got = await pageGot(space);
    await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    return { res, planted: p.hits, victim: readFileSync(join(target, "victim.txt"), "utf8"), victimMode: (statSync(join(target, "victim.txt")).mode & 0o777).toString(8), pageGot: got?.length ?? got };
  },
  // A nested folder, made and being written in, swapped for a link to outside.
  async folderNestedSwap() {
    const target = fresh("folderNestedSwap");
    const space = await task("zs-staging-fswap", "/folder");
    const p = plantInside("zsf/sub/big.bin", dir => {
      renameSync(join(dir, "zsf", "sub"), join(dir, "zsf", "sub.gone"));
      symlinkSync(target, join(dir, "zsf", "sub"));
      return { swapped: "zsf/sub -> outside, mid-write" };
    });
    const res = await upload(space, [fbig("zsf/sub/big.bin"), ffile("zsf/sub/zs-planted.plist", PAYLOAD), ffile("zsf/sub/deeper/zs-planted3.plist", PAYLOAD)]);
    await sleep(500);
    p.stop();
    const got = await pageGot(space);
    await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    return { res, swapped: p.hits, outside: list(target), landed: list(target) instanceof Array && list(target).some(f => /zs-planted/.test(f)), pageGot: got?.length ?? got };
  },
  // The folder itself, being written in, swapped for a link to outside.
  async folderTopSwap() {
    const target = fresh("folderTopSwap");
    const space = await task("zs-staging-ftopswap", "/folder");
    const p = plantInside("zsf/big.bin", dir => {
      renameSync(join(dir, "zsf"), join(dir, "zsf.gone"));
      symlinkSync(target, join(dir, "zsf"));
      return { swapped: "zsf -> outside, mid-write" };
    });
    const res = await upload(space, [fbig("zsf/big.bin"), ffile("zsf/zs-planted.plist", PAYLOAD), ffile("zsf/sub/zs-planted2.plist", PAYLOAD)]);
    await sleep(500);
    p.stop();
    const got = await pageGot(space);
    await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    return { res, swapped: p.hits, outside: list(target), landed: list(target) instanceof Array && list(target).some(f => /zs-planted/.test(f)), pageGot: got?.length ?? got };
  },
  // relativePaths that try to climb out, on one chooser: each must be
  // refused before anything is written. Then look-alike names, which are
  // plain names, close the chooser: they must land inside the tree.
  async folderClimb() {
    const target = fresh("folderClimb");
    const space = await task("zs-staging-fclimb", "/folder");
    const chooser = await chooserOn(space);
    if (typeof chooser !== "number" && typeof chooser !== "string") return { chooser };
    if (String(chooser).startsWith("no chooser")) return { chooser };
    const N = "zs-climb.txt";
    const tries = [
      ["../" + N],
      ["zsf/../" + N],
      ["zsf/../../" + N],
      ["zsf/sub/../../../" + N],
      ["zsf/" + "../".repeat(20) + N],
      ["zsf/./" + N],
      ["zsf//" + N],
      ["./zsf/" + N],
      ["/" + N],
      [join(target, N)],
      ["zsf/..\\..\\" + N],
      ["zsf\\..\\..\\" + N],
      ["zsf/sub\u0000/../../" + N],
      ["zsf/\u001b/" + N],
      [".."],
      ["zsf/" + N + "/"],
      ["zsf/a.txt", "../" + N],
    ];
    const out = [];
    for (const [rel, name] of tries) {
      const before = list(where.uploadRoot);
      const f = { name: name ?? basename(rel.replaceAll("\\", "/")), relativePath: rel, base64: b64(PAYLOAD) };
      const res = await client.call("filechooser.setFiles", { chooser, files: [f, ffile("zsf/ok.txt", "ok")] }).then(() => "ok", err);
      out.push({ rel: JSON.stringify(rel), name, res, rootChanged: JSON.stringify(list(where.uploadRoot)) !== JSON.stringify(before) });
      if (res === "ok") break;
    }
    // Plain names that only look like a climb: they close the chooser.
    const look = ["zsf/\u2024\u2024/" + N, "zsf/\uff0e\uff0e/x-" + N, "zsf/%2e%2e/y-" + N, "zsf/...z/" + N, "zsf/.. /w-" + N];
    let lookRes = "not tried";
    if (out.every(t => t.res !== "ok")) {
      lookRes = await client.call("filechooser.setFiles", { chooser, files: look.map(r => ffile(r, PAYLOAD)) }).then(() => "ok", err);
    }
    await sleep(300);
    const got = await pageGot(space);
    const held = await chrome(`${FC} return FC.uploadDirectories?.() ?? [];`).catch(e => [String(e)]);
    const staged = held.at(-1) ?? null;
    const inside = staged ? list(staged) : null;
    await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    await sleep(300);
    const places = [target, where.uploadRoot, dirname(where.uploadRoot), dirname(dirname(where.uploadRoot)), where.tempDir, where.profileDir, dirname(where.profileDir)];
    const escaped = climbedTo(places, N).concat(look.map(r => basename(r)).flatMap(n => climbedTo(places, n)));
    return { tries: out, refused: out.filter(t => t.res !== "ok").length, lookAlikes: lookRes, pageGot: got, inside, escaped: [...new Set(escaped)] };
  },
  // A link to a file outside, planted in the tree once the last file is
  // written, after a delay: before the runtime's last check (refused), after
  // it and before Gecko's walk, or after the walk. Gecko's walk skips links
  // (GetFilesHelper, Bug 1813299), so none may reach the page.
  async folderWalkLink() {
    const target = fresh("folderWalkLink");
    writeFileSync(join(target, "secret.txt"), "ZS_OUTSIDE_SECRET\n");
    const out = [];
    for (const after of [0, 2, 5, 10, 20, 40, 80]) {
      const space = await task("zs-staging-fwalk", "/folder");
      const p = plantInside("zsf/sub/last.txt", dir => (symlinkSync(join(target, "secret.txt"), join(dir, "zsf", "stolen.txt")), { planted: `zsf/stolen.txt -> outside/secret.txt, ${after} ms after the last file appeared` }), { after });
      const res = await upload(space, [ffile("zsf/a.txt", "A"), ffile("zsf/sub/last.txt", "L")]);
      await sleep(500);
      p.stop();
      const got = await pageGot(space);
      await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
      out.push({ after, res, planted: p.hits, pageGot: got instanceof Array ? got.map(g => g.path) : got, leaked: got instanceof Array && got.some(g => /ZS_OUTSIDE_SECRET/.test(g.text ?? "")) });
    }
    return { tries: out, leaked: out.filter(t => t.leaked).length };
  },
};

const out = { outside };
try {
  out.where = await discover();
  for (const name of wanted.length ? wanted : Object.keys(CASES)) {
    step(name);
    try {
      out[name] = await CASES[name]();
    } catch (e) {
      out[name] = { error: err(e) };
    }
    step(name, JSON.stringify(out[name]).slice(0, 400));
  }
} finally {
  console.log(JSON.stringify(out, null, 1));
  client.close?.();
  server.closeAllConnections?.();
  server.close();
}
