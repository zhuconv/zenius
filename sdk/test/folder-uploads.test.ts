// Folder uploads, the SDK half (the runtime half is the input layer's): the CLI
// walks the folder with lstat, never follows a link, makes the runtime's
// checks before reading, and reads each file only if it is still the one the
// walk saw.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ZeniusError } from "../src/errors.ts";
import { readUploads, readWalked, UPLOAD_LIMIT_BYTES, UPLOAD_LIMIT_FILES, walkFolder } from "../src/files.ts";

const METHOD = "page.setInputFiles";
// A real path, as the sandboxed launcher grants them (the Mac's temporary folder is under a link).
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "zenius-folders-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

let made = 0;
/** A fresh folder named `name` holding `files` (path in the folder -> text), in a parent of its own. */
function folder(files: Record<string, string>, name = "photos"): string {
  const dir = join(scratch, `case-${++made}`, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** What a folder upload sends for one file. */
function expected(dir: string, path: string, relativePath: string): Record<string, unknown> {
  const file = join(dir, path);
  return {
    name: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    relativePath,
    mimeType: "",
    lastModified: Math.round(statSync(file).mtimeMs),
    base64: readFileSync(file).toString("base64"),
  };
}

async function refused(paths: string[], message: RegExp): Promise<void> {
  await assert.rejects(
    () => readUploads(paths, METHOD),
    // The first line: what happened. The next step follows on a line of its own.
    (error: unknown) => error instanceof ZeniusError && error.code === "ZEN_INVALID_ARGUMENT" && message.test(error.message.split("\n")[0]!),
  );
}

describe("a folder upload", () => {
  it("sends each regular file with its path in the folder, hidden ones too, sorted; empty folders send nothing", async () => {
    const dir = folder({ "b.txt": "bee", "a.txt": "ay", ".hidden": "h", "2024/x.jpg": "ÿ\u0000jpg", "2024/deep/y.txt": "why" });
    mkdirSync(join(dir, "empty"));
    assert.deepEqual(await readUploads([dir], METHOD), [
      expected(dir, ".hidden", "photos/.hidden"),
      expected(dir, "2024/deep/y.txt", "photos/2024/deep/y.txt"),
      expected(dir, "2024/x.jpg", "photos/2024/x.jpg"),
      expected(dir, "a.txt", "photos/a.txt"),
      expected(dir, "b.txt", "photos/b.txt"),
    ]);
  });

  it("may name the folder through a link, and its files then start with the link's name", async () => {
    const dir = folder({ "a.txt": "ay" });
    const link = join(dir, "..", "album");
    symlinkSync(dir, link);
    assert.deepEqual(await readUploads([link], METHOD), [expected(dir, "a.txt", "album/a.txt")]);
  });

  it("refuses a link, a FIFO or a socket inside, naming it, rather than leaving it out", async () => {
    const outside = folder({ "secret.txt": "secret" }, "outside");
    const fileLink = folder({ "a.txt": "ay" });
    symlinkSync(join(outside, "secret.txt"), join(fileLink, "note.txt"));
    await refused([fileLink], /^page\.setInputFiles could not read .*\/photos: it holds a symbolic link \(photos\/note\.txt\); a folder upload sends only regular files$/);
    const dirLink = folder({ "a.txt": "ay" });
    symlinkSync(outside, join(dirLink, "more"));
    await refused([dirLink], /it holds a symbolic link \(photos\/more\)/);
    const fifo = folder({ "a.txt": "ay" });
    if (spawnSync("mkfifo", [join(fifo, "pipe")]).status === 0) await refused([fifo], /it holds a FIFO \(photos\/pipe\)/);
    const socket = folder({ "a.txt": "ay" });
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(join(socket, "s.sock"), resolve));
    try {
      await refused([socket], /it holds a socket \(photos\/s\.sock\)/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("is one folder alone, with at least one file", async () => {
    const dir = folder({ "a.txt": "ay" });
    const other = folder({ "b.txt": "bee" }, "other");
    const file = join(other, "b.txt");
    await refused([dir, file], /^page\.setInputFiles: .*\/photos is a folder, and a folder upload sends that one folder alone: pass only its path, with no other folder or file$/);
    await refused([file, dir], /\/photos is a folder, and a folder upload sends that one folder alone/);
    await refused([dir, other], /\/photos is a folder, and a folder upload sends that one folder alone/);
    const empty = folder({});
    mkdirSync(join(empty, "nothing", "here"), { recursive: true });
    await refused([empty], /^page\.setInputFiles: .*\/photos holds no files, and a folder upload needs at least one$/);
  });

  it("refuses more than 1000 files, or more than 50 MB, before reading any", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= UPLOAD_LIMIT_FILES; i++) many[`f${i}.txt`] = "";
    await refused([folder(many)], /^page\.setInputFiles: .*\/photos holds more than 1000 files, the limit for one folder upload$/);
    // Sparse, so nothing is written: the cap holds on lstat's sizes, before any read.
    const large = folder({ "a.txt": "ay" });
    writeFileSync(join(large, "big.bin"), "");
    truncateSync(join(large, "big.bin"), UPLOAD_LIMIT_BYTES);
    await refused([large], /^page\.setInputFiles: the files in .*\/photos total over 52428800 bytes, the limit \(50 MB\)$/);
  });

  it("refuses a name the runtime would refuse, naming it", async () => {
    const cases: Array<[string, RegExp]> = [
      ["back\\slash.txt", /the name "photos\/back\\\\slash\.txt" can't go in a folder upload, since it holds a backslash$/],
      ["bell\u0007.txt", /the name "photos\/bell\\u0007\.txt" can't go in a folder upload, since it holds a control character$/],
    ];
    for (const [name, message] of cases) {
      const dir = folder({ "a.txt": "ay" });
      try {
        writeFileSync(join(dir, name), "x");
      } catch {
        continue; // a file system that refuses the name has nothing to send
      }
      await refused([dir], message);
    }
    // Four folders of 200 bytes put the last file's path in the folder over 768.
    const deep = folder({ [`${"d".repeat(200)}/${"e".repeat(200)}/${"f".repeat(200)}/${"g".repeat(200)}.txt`]: "x" });
    await refused([deep], /since its path in the folder is over 768 bytes$/);
    if (process.platform === "linux") {
      const bad = folder({ "a.txt": "ay" });
      writeFileSync(Buffer.concat([Buffer.from(`${bad}/`), Buffer.from([0x61, 0xff])]), "x");
      await refused([bad], /since it isn't valid UTF-8$/);
    }
  });
});

describe("a folder upload's read", () => {
  it("fails when a file changed after the walk: replaced, grown, shrunk, or swapped for a link", async () => {
    const changed = /^page\.setInputFiles could not read .*\/photos: photos\/a\.txt changed while the folder was read; try again once nothing is writing to it$/;
    const check = async (change: (dir: string) => void) => {
      const dir = folder({ "a.txt": "ay", "b.txt": "bee" });
      const walked = await walkFolder(dir, METHOD);
      change(dir);
      await assert.rejects(
        () => readWalked(walked, METHOD),
        // It says to try again, so no "Fix the call" follows.
        (error: unknown) => error instanceof ZeniusError && error.code === "ZEN_INVALID_ARGUMENT" && changed.test(error.message),
      );
    };
    // Renamed away rather than deleted, so its inode stays taken and the new file gets another.
    await check((dir) => {
      renameSync(join(dir, "a.txt"), join(dir, "..", "a.old"));
      writeFileSync(join(dir, "a.txt"), "ay");
    });
    await check((dir) => appendFileSync(join(dir, "a.txt"), "more"));
    await check((dir) => truncateSync(join(dir, "a.txt"), 1));
    await check((dir) => {
      unlinkSync(join(dir, "a.txt"));
      symlinkSync(join(dir, "b.txt"), join(dir, "a.txt"));
    });
  });

  // O_NOFOLLOW covers only the last name: a folder above it swapped for a link
  // is caught by the device and inode check.
  it("fails when a folder above a file was swapped for a link after the walk", async () => {
    const dir = folder({ "sub/a.txt": "ay" });
    // As long as the file the walk saw, so only the device and inode tell them apart.
    const outside = folder({ "a.txt": "se" }, "outside");
    const walked = await walkFolder(dir, METHOD);
    renameSync(join(dir, "sub"), join(dir, "..", "moved"));
    symlinkSync(outside, join(dir, "sub"));
    await assert.rejects(
      () => readWalked(walked, METHOD),
      (error: unknown) => error instanceof ZeniusError && /photos\/sub\/a\.txt changed while the folder was read/.test(error.message),
    );
  });
});

// In the sandboxed CLI, Node's permission model follows links even outside the
// grants, so not following them is what keeps a folder upload inside.
describe("a folder upload under node --permission", { skip: !process.allowedNodeEnvironmentFlags.has("--permission") }, () => {
  it("sends a granted folder, and refuses a link in it to a file outside the grants, or a link to a folder outside them", () => {
    const sdk = fileURLToPath(new URL("..", import.meta.url));
    const granted = folder({ "a.txt": "ay" }, "granted");
    const outside = folder({ "secret.txt": "secret" }, "outside");
    const run = (dir: string) => {
      const script = `const { readUploads } = await import(${JSON.stringify(pathToFileURL(join(sdk, "src", "files.ts")).href)});
try { console.log(JSON.stringify((await readUploads([${JSON.stringify(dir)}], "page.setInputFiles")).map((file) => file.relativePath))); } catch (error) { console.log(error.code, error.message); }`;
      const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${sdk}`, `--allow-fs-read=${join(dir, "..")}`, "--input-type=module", "-e", script], {
        encoding: "utf8",
      });
      return result.stdout.trim() || result.stderr;
    };
    assert.equal(run(granted), JSON.stringify(["granted/a.txt"]));
    symlinkSync(join(outside, "secret.txt"), join(granted, "secret.txt"));
    assert.match(run(granted), /^ZEN_INVALID_ARGUMENT page\.setInputFiles could not read .*\/granted: it holds a symbolic link \(granted\/secret\.txt\)/);
    // Named through a link, the folder's real path must be in the grants too.
    const elsewhere = join(granted, "..", "elsewhere");
    symlinkSync(outside, elsewhere);
    assert.ok(run(elsewhere).startsWith("ZEN_PATH_NOT_ALLOWED page.setInputFiles: a sandboxed script reads files only in"), run(elsewhere));
    assert.ok(run(elsewhere).includes(` and ${elsewhere} leads outside them, to ${outside}. `), run(elsewhere));
  });
});
