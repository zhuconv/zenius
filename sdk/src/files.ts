// The CLI does all the file I/O an agent asks for (SPEC §3.9 I5). The browser
// runs with the user's full rights, outside any sandbox the agent's CLI runs
// in, so it never opens a path an agent names: uploads reach the runtime as
// bytes, and the CLI writes what comes back.

import { ZeniusError } from "./errors.ts";
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
/** A folder upload's most files: the runtime writes each one to disk (docs/research/folder-uploads.md). */
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
  return new ZeniusError(
    "ZEN_PATH_NOT_ALLOWED",
    `${method}: a sandboxed script reads files only in its working folder, its runs' output folders and its temporary folder, and ${where}. ` +
      "If the task needs this file, ask the user to copy it into the working folder.",
    { path: file, ...data },
  );
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
 * The run's output folder in the sandboxed CLI (install-cli.sh --sandbox),
 * which the launcher makes and names in ZENIUS_OUTPUT_DIR. A sandboxed
 * script writes only there and in its temporary folder: never in its working
 * folder, whose hooks, scripts and configs other programs run outside the
 * sandbox.
 */
export function sandboxOutputDir(): string | undefined {
  const dir = process.env.ZENIUS_OUTPUT_DIR;
  return inSandbox() && typeof dir === "string" && nodePath.isAbsolute(dir) ? dir : undefined;
}

/**
 * The file an output method writes: a screenshot's path, fetch's saveAs or
 * download.saveAs(). Outside the sandbox it must be absolute, as in Ego. In
 * the sandbox a relative path lands in the run's output folder, and an
 * absolute one must be in that or in the temporary folder.
 */
export function outputPath(path: unknown, label: string, notAbsolute = `${label} must be an absolute file path`): string {
  const out = sandboxOutputDir();
  if (typeof path !== "string" || path.length === 0 || (!out && !nodePath.isAbsolute(path))) throw new TypeError(notAbsolute);
  if (!out) return path;
  const file = nodePath.resolve(out, path);
  if (within(file, out) || within(file, os.tmpdir())) return file;
  throw new ZeniusError(
    "ZEN_PATH_NOT_ALLOWED",
    `${label}: a sandboxed script writes only to its output folder, ${out}, and its temporary folder, never its working folder. ` +
      "Pass a relative path, which lands in the output folder.",
    { path: file, outputDir: out },
  );
}

function within(file: string, folder: string): boolean {
  const relative = nodePath.relative(folder, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative);
}

/** In the sandbox, lists a file the SDK wrote after the script's output, since the agent didn't pick its folder. */
export function reportWritten(path: string): void {
  if (sandboxOutputDir()) noteWrittenFile(path);
}

/**
 * Writes bytes the runtime sent back to a path the agent named, making its
 * folders first, as Ego does for screenshots and fetch's saveAs.
 */
export async function writeOutput(path: string, bytes: Uint8Array): Promise<void> {
  await fs.promises.mkdir(nodePath.dirname(path), { recursive: true });
  await fs.promises.writeFile(path, bytes);
}

/** The bytes in a runtime answer's base64 field, or ZEN_INTERNAL naming what was missing. */
export function bytesFrom(answer: unknown, field: string, method: string): Buffer {
  const value = (answer as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string") throw new ZeniusError("ZEN_INTERNAL", `${method} got no ${field} from the runtime`);
  return Buffer.from(value, "base64");
}

/** The most download.read returns in one answer (PROTOCOL). */
export const DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

type DownloadChunk = { base64?: unknown; size?: unknown; eof?: unknown };

/**
 * Writes a download to `path` from download.read's chunks, making its folders.
 * The first chunk comes before the file is opened, so a failed download
 * leaves an existing file alone; a transfer that breaks off removes the part
 * it wrote.
 */
export async function writeDownload(read: (offset: number, length: number) => Promise<unknown>, path: string): Promise<void> {
  let chunk = (await read(0, DOWNLOAD_CHUNK_BYTES)) as DownloadChunk | null;
  await fs.promises.mkdir(nodePath.dirname(path), { recursive: true });
  const handle = await fs.promises.open(path, "w");
  let offset = 0;
  let complete = false;
  try {
    for (;;) {
      const bytes = bytesFrom(chunk, "base64", "download.read");
      for (let written = 0; written < bytes.length; ) {
        written += (await handle.write(bytes, written, bytes.length - written)).bytesWritten;
      }
      offset += bytes.length;
      if (chunk?.eof === true) break;
      if (bytes.length === 0) throw new ZeniusError("ZEN_INTERNAL", "download.read returned no bytes before the end of the download");
      chunk = (await read(offset, DOWNLOAD_CHUNK_BYTES)) as DownloadChunk | null;
    }
    if (typeof chunk?.size === "number" && chunk.size !== offset) {
      throw new ZeniusError("ZEN_INTERNAL", `download.read gave ${offset} bytes of a ${chunk.size}-byte download`);
    }
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await fs.promises.rm(path, { force: true });
  }
}

/** A suggested file name as one safe path component. */
export function safeFileName(name: string): string {
  const base = nodePath.basename(name.replace(/[\\/\x00-\x1f]/g, "_"));
  return base === "" || base === "." || base === ".." ? "download" : base;
}
