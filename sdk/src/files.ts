// The CLI does all the file I/O an agent asks for (SPEC §3.9 I5). The browser
// runs with the user's full rights, outside any sandbox the agent's CLI runs
// in, so it never opens a path an agent names: uploads reach the runtime as
// bytes, and the CLI writes what comes back. A finished download moves into
// the working folder, which the install names, and the CLI copies it from
// there.

import { ZeniusError } from "./errors.ts";
import { zeniusHome } from "./instance.ts";
import { fs, inSandbox, path as nodePath, os } from "./node.ts";
import { noteWrittenFile } from "./output.ts";

/**
 * One file for page.setInputFiles or filechooser.setFiles (PROTOCOL "Uploads
 * carry bytes"). A folder upload's files also carry `relativePath`: the
 * folder's name, then the path inside it, joined by "/", which the page reads
 * as webkitRelativePath.
 */
export type FilePayload = { name: string; mimeType: string; lastModified: number; base64: string; relativePath?: string };

/** Playwright's limit for files sent to a remote browser; the runtime refuses more too. */
export const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
/** A folder upload's most files: the runtime writes each one to disk. */
export const UPLOAD_LIMIT_FILES = 1000;
// With the runtime's upload folder in front, these keep a path under the Mac's 1024 bytes.
const SEGMENT_LIMIT_BYTES = 255;
const RELATIVE_PATH_LIMIT_BYTES = 768;

/**
 * Reads the files an agent named for an upload, before anything is sent.
 * Errors name the method and the path, as the runtime's did when it read
 * them. `mimeType` stays empty: the runtime then uses the type Gecko gives the
 * name, which is what a real pick in the browser would give the page. A
 * folder's path makes a folder upload (readFolder), alone in its call.
 */
export async function readUploads(paths: readonly string[], method: string): Promise<FilePayload[]> {
  const found: Array<{ file: string; mtimeMs: number }> = [];
  let total = 0;
  for (const file of paths) {
    let info: import("node:fs").Stats;
    try {
      info = await fs.promises.stat(file);
    } catch (error) {
      throw unreadable(method, file, error);
    }
    if (info.isDirectory()) {
      if (paths.length !== 1) {
        throw new ZeniusError(
          "ZEN_INVALID_ARGUMENT",
          `${method}: ${file} is a folder, and a folder upload sends that one folder alone: pass only its path, with no other folder or file`,
          { path: file },
        );
      }
      // The walk follows no link, so every file it finds lies inside the folder's real path.
      await checkRealPath(method, file);
      return readWalked(await walkFolder(file, method), method);
    }
    // A FIFO or a device could block the read or never end.
    if (!info.isFile()) throw unreadable(method, file, "it is not a regular file");
    await checkRealPath(method, file);
    total += info.size;
    found.push({ file, mtimeMs: info.mtimeMs });
  }
  if (total > UPLOAD_LIMIT_BYTES) throw tooLarge(method, total);
  const payloads: FilePayload[] = [];
  let read = 0;
  for (const { file, mtimeMs } of found) {
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(file);
    } catch (error) {
      throw unreadable(method, file, error);
    }
    // A file that grew after stat() must not slip past the limit.
    read += bytes.length;
    if (read > UPLOAD_LIMIT_BYTES) throw tooLarge(method, read);
    payloads.push({
      name: nodePath.basename(file),
      mimeType: "",
      lastModified: Math.round(mtimeMs),
      base64: bytes.toString("base64"),
    });
  }
  return payloads;
}

/** A regular file a folder upload found, as lstat saw it. */
export type WalkedFile = {
  folder: string;
  file: string;
  relativePath: string;
  name: string;
  dev: bigint;
  ino: bigint;
  size: number;
};

const NAME_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * The regular files in a folder an agent named, sorted by relativePath. The
 * walk uses lstat and never follows a link: a link, socket, FIFO or device
 * inside fails the call, naming it, so the agent never sends less than it
 * asked for without knowing (in the sandboxed CLI, Node's permission model
 * follows links, so this is also what keeps an upload inside its grants).
 * The folder named may itself be a link, like any path an agent names. The
 * runtime's checks run here first, before any bytes are read: each name,
 * the path's length, and the caps.
 */
export async function walkFolder(folder: string, method: string): Promise<WalkedFile[]> {
  const top = nodePath.basename(folder);
  const files: WalkedFile[] = [];
  let bytes = 0;
  const pending: Array<{ dir: string; relative: string }> = [{ dir: folder, relative: checkName(method, folder, top, top) }];
  while (pending.length > 0) {
    const { dir, relative } = pending.pop()!;
    let entries: import("node:fs").Dirent<Buffer>[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true, encoding: "buffer" });
    } catch (error) {
      throw unreadable(method, dir, error);
    }
    for (const entry of entries) {
      let name: string;
      try {
        name = NAME_DECODER.decode(entry.name);
      } catch {
        throw cantSend(method, folder, `${relative}/${entry.name.toString("latin1")}`, "it isn't valid UTF-8");
      }
      const relativePath = checkName(method, folder, `${relative}/${name}`, name);
      const file = nodePath.join(dir, name);
      let info: import("node:fs").BigIntStats;
      try {
        info = await fs.promises.lstat(file, { bigint: true });
      } catch (error) {
        throw unreadable(method, file, error);
      }
      if (info.isDirectory()) {
        pending.push({ dir: file, relative: relativePath });
        continue;
      }
      if (!info.isFile()) {
        const kind = info.isSymbolicLink() ? "a symbolic link" : info.isSocket() ? "a socket" : info.isFIFO() ? "a FIFO" : "a device";
        throw new ZeniusError(
          "ZEN_INVALID_ARGUMENT",
          `${method} could not read ${folder}: it holds ${kind} (${relativePath}); a folder upload sends only regular files`,
          { path: folder, entry: relativePath },
        );
      }
      if (files.length === UPLOAD_LIMIT_FILES) {
        throw new ZeniusError(
          "ZEN_INVALID_ARGUMENT",
          `${method}: ${folder} holds more than ${UPLOAD_LIMIT_FILES} files, the limit for one folder upload`,
          { path: folder, limit: UPLOAD_LIMIT_FILES },
        );
      }
      bytes += Number(info.size);
      if (bytes > UPLOAD_LIMIT_BYTES) {
        throw new ZeniusError(
          "ZEN_INVALID_ARGUMENT",
          `${method}: the files in ${folder} total over ${UPLOAD_LIMIT_BYTES} bytes, the limit (50 MB)`,
          { path: folder, limit: UPLOAD_LIMIT_BYTES },
        );
      }
      files.push({ folder, file, relativePath, name, dev: info.dev, ino: info.ino, size: Number(info.size) });
    }
  }
  // An empty folder is refused, so [] keeps meaning clear the input, or cancel a chooser.
  if (files.length === 0) {
    throw new ZeniusError("ZEN_INVALID_ARGUMENT", `${method}: ${folder} holds no files, and a folder upload needs at least one`, { path: folder });
  }
  return files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

/**
 * Milliseconds rounded as a lone file's lastModified is: Node's number Stats
 * make mtimeMs sec * 1000 + nsec / 1e6, which BigIntStats' mtimeMs truncates
 * to whole milliseconds instead.
 */
function lastModifiedOf(mtimeNs: bigint): number {
  let sec = mtimeNs / 1_000_000_000n;
  let nsec = mtimeNs % 1_000_000_000n;
  if (nsec < 0n) {
    sec -= 1n;
    nsec += 1_000_000_000n;
  }
  return Math.round(Number(sec) * 1e3 + Number(nsec) / 1e6);
}

/**
 * Reads what walkFolder found. Each file opens with O_NOFOLLOW, and the open
 * file must be the one the walk saw (the same device and inode): O_NOFOLLOW
 * covers only the last name, so this is what catches a folder above it
 * swapped for a link after the walk. A file that changed size since fails
 * too, so the byte cap holds on what is sent.
 */
export async function readWalked(files: readonly WalkedFile[], method: string): Promise<FilePayload[]> {
  const payloads: FilePayload[] = [];
  let read = 0;
  for (const walked of files) {
    let handle: import("node:fs/promises").FileHandle;
    try {
      handle = await fs.promises.open(walked.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ELOOP") throw changed(method, walked);
      throw unreadable(method, walked.file, error);
    }
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.dev !== walked.dev || info.ino !== walked.ino) throw changed(method, walked);
      // One byte more than the walk saw, to tell a file that grew.
      const bytes = Buffer.alloc(walked.size + 1);
      let got = 0;
      for (;;) {
        const { bytesRead } = await handle.read(bytes, got, bytes.length - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
        if (got > walked.size) throw changed(method, walked);
      }
      if (got !== walked.size) throw changed(method, walked);
      read += got;
      if (read > UPLOAD_LIMIT_BYTES) throw tooLarge(method, read);
      payloads.push({
        name: walked.name,
        relativePath: walked.relativePath,
        mimeType: "",
        // The open file's time, as close as it gets to the bytes read.
        lastModified: lastModifiedOf(info.mtimeNs),
        base64: bytes.subarray(0, got).toString("base64"),
      });
    } catch (error) {
      if (error instanceof ZeniusError) throw error;
      throw unreadable(method, walked.file, error);
    } finally {
      await handle.close();
    }
  }
  return payloads;
}

/** A name in a folder upload: the runtime's checks, made before reading. Returns the path. */
function checkName(method: string, folder: string, relativePath: string, name: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw cantSend(method, folder, relativePath, "it holds a control character");
  if (name.includes("\\")) throw cantSend(method, folder, relativePath, "it holds a backslash");
  if (name === "" || name === "." || name === "..") throw cantSend(method, folder, relativePath, "it isn't a file or folder name");
  if (Buffer.byteLength(name, "utf8") > SEGMENT_LIMIT_BYTES) throw cantSend(method, folder, relativePath, `it is over ${SEGMENT_LIMIT_BYTES} bytes`);
  if (Buffer.byteLength(relativePath, "utf8") > RELATIVE_PATH_LIMIT_BYTES) {
    throw cantSend(method, folder, relativePath, `its path in the folder is over ${RELATIVE_PATH_LIMIT_BYTES} bytes`);
  }
  return relativePath;
}

function cantSend(method: string, folder: string, relativePath: string, why: string): ZeniusError {
  return new ZeniusError("ZEN_INVALID_ARGUMENT", `${method} can't send ${folder}: the name ${JSON.stringify(relativePath)} can't go in a folder upload, since ${why}`, {
    path: folder,
    entry: relativePath,
  });
}

function changed(method: string, walked: WalkedFile): ZeniusError {
  return new ZeniusError(
    "ZEN_INVALID_ARGUMENT",
    `${method} could not read ${walked.folder}: ${walked.relativePath} changed while the folder was read; try again once nothing is writing to it`,
    { path: walked.folder, entry: walked.relativePath },
  );
}

/**
 * In the sandboxed CLI, an upload's real path must be in the grants too.
 * Node's permission model checks the path an agent names but follows a link
 * in it anywhere (its docs' "Limitations"), and the OS sandbox lets the CLI
 * read more than the grants: /usr and /etc under bwrap, everything outside
 * the home and temporary folders under sandbox-exec. The launcher grants
 * real paths, so a file truly inside them passes.
 */
async function checkRealPath(method: string, file: string): Promise<void> {
  const permission = (process as { permission?: { has(scope: string, reference?: string): boolean } }).permission;
  if (!permission) return;
  let real: string;
  try {
    real = await fs.promises.realpath(file);
  } catch (error) {
    throw unreadable(method, file, error);
  }
  if (!permission.has("fs.read", real)) throw notAllowed(method, file, `${file} leads outside them, to ${real}`, { realPath: real });
}

// The fix is the user's: the grants exist so a script that read a hostile
// page can't upload the user's other files.
function notAllowed(method: string, file: string, where: string, data: Record<string, unknown> = {}): ZeniusError {
  const reads = sandboxReadDir();
  return new ZeniusError(
    "ZEN_PATH_NOT_ALLOWED",
    `${method}: a sandboxed script reads files only in ${readFolders(reads)}, and ${where}. ` +
      `If the task needs this file, ask the user to copy it into the working folder${reads ? ` or ${reads}` : ""}.`,
    { path: file, ...data },
  );
}

/**
 * The folders a sandboxed script reads files from, in the words its
 * messages use, as do the files docs (docs.ts). `reads` names the folder the
 * install lets scripts read (sandboxReadDir), if there is one.
 */
export function readFolders(reads: string | undefined): string {
  return reads
    ? `the working folder, the folder it started in, its temporary folder and ${reads}`
    : "the working folder, the folder it started in and its temporary folder";
}

/** The folders a sandboxed script writes, in the same words: `working` names the working folder. */
export function writeFolders(working: string): string {
  return `the working folder, ${working}, and its temporary folder, never the folder it started in`;
}

/**
 * The folder the install lets sandboxed scripts read besides the working
 * folder (install-cli.sh --sandbox --read-dir, such as ~/Downloads), which
 * the launcher names in ZENIUS_READ_DIR when it grants it. Node's permission
 * model holds the grant; this only names the folder in messages.
 */
export function sandboxReadDir(): string | undefined {
  const dir = process.env.ZENIUS_READ_DIR;
  return inSandbox() && typeof dir === "string" && nodePath.isAbsolute(dir) ? dir : undefined;
}

function unreadable(method: string, file: string, cause: unknown): ZeniusError {
  // Node's permission model, in the sandboxed CLI.
  if ((cause as { code?: unknown } | null)?.code === "ERR_ACCESS_DENIED") return notAllowed(method, file, `${file} is outside them`);
  return new ZeniusError("ZEN_INVALID_ARGUMENT", `${method} could not read ${file}: ${readFailure(cause)}`, {
    path: file,
  });
}

function readFailure(cause: unknown): string {
  if (typeof cause === "string") return cause;
  switch ((cause as { code?: unknown } | null)?.code) {
    case "ENOENT":
    case "ENOTDIR":
      return "no such file";
    case "EISDIR":
      return "it is a directory";
    case "EACCES":
    case "EPERM":
      return "permission denied";
    default:
      return cause instanceof Error ? cause.message : String(cause);
  }
}

function tooLarge(method: string, total: number): ZeniusError {
  return new ZeniusError(
    "ZEN_INVALID_ARGUMENT",
    `${method}: the files total ${total} bytes, over the limit of ${UPLOAD_LIMIT_BYTES} (50 MB)`,
    { total, limit: UPLOAD_LIMIT_BYTES },
  );
}

/**
 * The config file's workingFolder line, as scripts/working-folder.sh's
 * wf_saved, the launcher and the runtime read it: the key on a line of its
 * own, any spacing, a value with no double quote or backslash, and an
 * optional comma.
 */
const CONFIG_LINE = /^[ \t\v\f\r]*"workingFolder"[ \t\v\f\r]*:[ \t\v\f\r]*"([^"\\]*)"[ \t\v\f\r]*,?[ \t\v\f\r]*$/;

/**
 * The working folder (docs/SPI.md "The working folder"): where finished
 * downloads land, and where a relative path a script writes goes. The
 * sandboxed launcher names it in ZENIUS_WORKING_DIR, and so does a dev Zen
 * for what it starts. Otherwise the CLI reads it as the launcher does: the
 * one line in the install's
 * ~/.zenius/config.json, or ~/zenius-files without that file. A file that
 * line doesn't fit is refused with the reason, never read another way.
 * ~/zenius-files is the default only while zenius's home is ~/.zenius: a
 * ZENIUS_HOME elsewhere has none, so a test or runner that moves zenius's
 * home alone can't reach the user's own folder.
 */
export function workingDir(env: NodeJS.ProcessEnv = process.env): string {
  const given = env.ZENIUS_WORKING_DIR;
  if (inSandbox()) {
    if (typeof given === "string" && nodePath.isAbsolute(given)) return given;
    throw new ZeniusError("ZEN_INTERNAL", "the sandboxed launcher named no working folder (ZENIUS_WORKING_DIR): reinstall the zenius command");
  }
  // Set outside the sandbox too by a dev Zen (scripts/zen-dev.sh) for what
  // it starts, so their files land in its working folder, never the user's.
  if (given) {
    if (!nodePath.isAbsolute(given)) {
      throw new ZeniusError("ZEN_PATH_NOT_ALLOWED", `ZENIUS_WORKING_DIR must be an absolute path: ${given}`, { path: given });
    }
    return given.length > 1 ? given.replace(/\/+$/, "") : given;
  }
  const home = zeniusHome(env);
  const file = nodePath.join(home, "config.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (realPath(home) !== realPath(nodePath.join(os.homedir(), ".zenius"))) {
        throw new ZeniusError(
          "ZEN_PATH_NOT_ALLOWED",
          `there's no default working folder: ZENIUS_HOME is ${home}, not ~/.zenius, and it holds no config.json: ask the user to run the installer again with --working-dir <folder>`,
          { path: file },
        );
      }
      return nodePath.join(os.homedir(), "zenius-files");
    }
    throw new ZeniusError(
      "ZEN_PATH_NOT_ALLOWED",
      `zenius can't read ${file}, which names the working folder (${readFailure(error)}): ask the user to run the installer again with --working-dir <folder>`,
      { path: file },
    );
  }
  const found = text.split("\n").flatMap((line) => CONFIG_LINE.exec(line)?.[1] ?? []);
  const [dir] = found;
  if (found.length !== 1 || !dir?.startsWith("/") || /[\u0000-\u001f\u007f]/.test(dir)) {
    throw new ZeniusError(
      "ZEN_PATH_NOT_ALLOWED",
      `${file} doesn't name the working folder on a line of its own, as the installer writes it: ask the user to run the installer again with --working-dir <folder>`,
      { path: file },
    );
  }
  return dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
}

/** `path` with its existing part's links resolved, as scripts/working-folder.sh's wf_resolve compares paths. */
function realPath(path: string): string {
  let head = nodePath.resolve(path);
  let rest = "";
  for (;;) {
    try {
      return nodePath.join(fs.realpathSync(head), rest);
    } catch {
      const parent = nodePath.dirname(head);
      if (parent === head) return nodePath.join(head, rest);
      rest = nodePath.join(nodePath.basename(head), rest);
      head = parent;
    }
  }
}

/** The working folder, if it can be found: for listing what a run wrote there. */
function knownWorkingDir(): string | undefined {
  try {
    return workingDir();
  } catch {
    return undefined;
  }
}

/**
 * The file an output method writes: a screenshot's path, fetch's saveAs or
 * download.saveAs(). A relative path lands in the working folder, which is
 * made (readable only by the user) if it's missing. In the sandbox an
 * absolute one must be in the working folder or the temporary folder.
 */
export function outputPath(path: unknown, label: string): string {
  if (typeof path !== "string" || path.length === 0) throw new TypeError(`${label} must be a file path`);
  if (nodePath.isAbsolute(path) && !inSandbox()) return path;
  const dir = workingDir();
  const file = nodePath.resolve(dir, path);
  if (within(file, dir)) {
    makeWorkingDir(dir);
    return file;
  }
  if (!inSandbox() || within(file, os.tmpdir())) return file;
  throw new ZeniusError(
    "ZEN_PATH_NOT_ALLOWED",
    `${label}: a sandboxed script writes only to ${writeFolders(dir)}. ` + "Pass a relative path, which lands in the working folder.",
    { path: file, workingDir: dir },
  );
}

/** Make the working folder if it's missing, as the installer does: readable only by the user, and only when its parent is there. */
function makeWorkingDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new ZeniusError(
        "ZEN_PATH_NOT_ALLOWED",
        `zenius can't make the working folder, ${dir} (${readFailure(error)}): ask the user to make it, or to run the installer again with --working-dir <folder>`,
        { path: dir },
      );
    }
  }
}

function within(file: string, folder: string): boolean {
  const relative = nodePath.relative(folder, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative);
}

/**
 * Lists a file the SDK wrote after the script's output, when the agent may
 * not know where it is: in the sandbox, and in the working folder, where a
 * relative path lands.
 */
export function reportWritten(path: string): void {
  if (inSandbox()) {
    noteWrittenFile(path);
    return;
  }
  const dir = knownWorkingDir();
  if (dir && within(path, dir)) noteWrittenFile(path);
}

/**
 * Copies a finished download from the working folder to `path`, making its
 * folders, as download.saveAs() does in Ego. The copy is readable only by the
 * user; a file already at `path` is replaced.
 */
export async function copyDownload(source: string, path: string): Promise<void> {
  if (nodePath.resolve(source) === nodePath.resolve(path)) return;
  await fs.promises.mkdir(nodePath.dirname(path), { recursive: true });
  await fs.promises.copyFile(source, path);
  await fs.promises.chmod(path, OUTPUT_MODE);
}

/**
 * A new output file's mode: only the user can read it. A page's screenshot,
 * body or download can hold what the user sees signed in, and a screenshot
 * without a path goes in the system's temporary folder, which on Linux every
 * account shares. A file that's already there keeps its own mode.
 */
const OUTPUT_MODE = 0o600;

/**
 * Writes bytes the runtime sent back to a path the agent named, making its
 * folders first, as Ego does for screenshots and fetch's saveAs.
 */
export async function writeOutput(path: string, bytes: Uint8Array): Promise<void> {
  await fs.promises.mkdir(nodePath.dirname(path), { recursive: true });
  await fs.promises.writeFile(path, bytes, { mode: OUTPUT_MODE });
}

/** The bytes in a runtime answer's base64 field, or ZEN_INTERNAL naming what was missing. */
export function bytesFrom(answer: unknown, field: string, method: string): Buffer {
  const value = (answer as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string") throw new ZeniusError("ZEN_INTERNAL", `${method} got no ${field} from the runtime`);
  return Buffer.from(value, "base64");
}

/** A suggested file name as one safe path component. */
export function safeFileName(name: string): string {
  const base = nodePath.basename(name.replace(/[\\/\x00-\x1f]/g, "_"));
  return base === "" || base === "." || base === ".." ? "download" : base;
}
