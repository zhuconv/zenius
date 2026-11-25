// zenius mcp's script tool (docs/mcp.md, "script"): a `zenius nodejs`
// script, run as the CLI runs it but inside the server's own process and
// thread. A worker would need Node's --allow-worker, and with it any code in
// the process can start a worker outside the permission model; the launcher
// starts no programs. So each script gets a round and a connection of its
// own, which the end of its call closes: what it still runs after that is
// refused, and the runtime stops what that connection ran.
//
// The server lists the files a script touched, for the user: uploads as the
// SDK sent them, writes and deletes from a listing of the working folder
// before and after, and reads as node:fs saw them. All as far as the server
// saw: a script shares its process, and can tamper with what the server
// looks with. The server takes what it uses itself before any script runs,
// and puts its watch on node:fs back before each one, so one script's
// tampering ends with its call.

import { syncBuiltinESMExports } from "node:module";

import { ZeniusError } from "./errors.ts";
import { listTaskSpaces, profiles } from "./globals.ts";
import { helpText } from "./help.ts";
import { instanceName, socketPath } from "./instance.ts";
import { learnContext, runSiteBrowserTool, runSiteTool, siteSkills } from "./learning/index.ts";
import { fs, path, stream, url as nodeUrl } from "./node.ts";
import { bufferOutput, createRoundConsole, resetOutput, takeOutput } from "./output.ts";
import type { Page } from "./page.ts";
import { Round, runInRound, type UploadNote } from "./round.ts";
import { RpcClient, SCRIPT_CALL_OVER, withSignal } from "./rpc.ts";
import { runScript, ScriptExit, type ScriptGlobals } from "./run.ts";
import { formatScriptError } from "./script-errors.ts";
import { quotedName } from "./step-text.ts";
import type { TaskSpace } from "./task-space.ts";

/** How long a listing of the working folder may take, each way, in ms. */
export const LIST_MAX_MS = 200;
/** How long the script's step may take to begin or end before the script goes on without it. */
const STEP_CALL_MS = 2000;
/** How many entries a listing reads at most: past months of downloads, so the time is what binds. */
export const LIST_MAX_ENTRIES = 20_000;
/** Names a file line shows before "and N more". */
const NAMES_SHOWN = 5;
/** How long an upload's page may take to say its address at the script's end, in ms. */
const ORIGIN_WAIT_MS = 1000;

const apply = Reflect.apply;

/**
 * The server's own fs and built-ins, taken before any script runs (serveMcp
 * calls armScripts() first): a script shares the process and may replace
 * what it reaches. Taken on first use, so a `zenius nodejs` start pays
 * nothing for them.
 */
function takeRefs() {
  const watched = watchedReads();
  return {
    opendirSync: fs.opendirSync,
    lstatSync: fs.lstatSync,
    mkdtempSync: fs.mkdtempSync,
    rmSync: fs.rmSync,
    chmodSync: fs.chmodSync,
    dirRead: fs.Dir.prototype.readSync,
    dirClose: fs.Dir.prototype.closeSync,
    direntIsDirectory: fs.Dirent.prototype.isDirectory,
    join: path.join,
    resolve: path.resolve,
    relative: path.relative,
    isAbsolute: path.isAbsolute,
    sep: path.sep,
    basename: path.basename,
    fileURLToPath: nodeUrl.fileURLToPath,
    now: performance.now.bind(performance),
    abortAny: AbortSignal.any.bind(AbortSignal),
    setTimeout,
    clearTimeout,
    setImmediate,
    chdir: process.chdir.bind(process),
    cwd: process.cwd.bind(process),
    stderrWrite: process.stderr.write.bind(process.stderr),
    watched,
    originals: watched.map((w) => w.owner[w.name] as (...args: unknown[]) => unknown),
  };
}
let taken: ReturnType<typeof takeRefs> | undefined;
const refs = () => (taken ??= takeRefs());

/** zenius mcp, before its first script: take the server's own refs and route the process's writers. */
export function armScripts(): void {
  refs();
  routeStdio();
}

// ---------------------------------------------------------------- the listing

type FileState = { size: number; mtimeMs: number };

/** The working folder's files by path, the folders read to their end, and why it stopped early, if it did. */
export type Listing = {
  files: Record<string, FileState>;
  complete: Record<string, true>;
  stopped: "time" | "entries" | undefined;
};

/**
 * The files under `root`, breadth-first, so its top level, where downloads
 * land, comes first. Links aren't followed. It stops at `maxMs`, or at
 * `maxEntries` entries, and says so.
 */
export function listFolder(root: string, maxMs = LIST_MAX_MS, maxEntries = LIST_MAX_ENTRIES): Listing {
  const r = refs();
  const files: Record<string, FileState> = Object.create(null);
  const complete: Record<string, true> = Object.create(null);
  const started = r.now();
  let entries = 0;
  let stopped: Listing["stopped"];
  const queue: string[] = [""];
  for (let head = 0; head < queue.length && !stopped; head++) {
    if (r.now() - started > maxMs) {
      stopped = "time";
      break;
    }
    const rel = queue[head]!;
    let dir: import("node:fs").Dir;
    try {
      dir = r.opendirSync(rel ? r.join(root, rel) : root);
    } catch {
      continue;
    }
    let read = false;
    try {
      for (;;) {
        if (entries >= maxEntries) {
          stopped = "entries";
          break;
        }
        if (entries % 64 === 0 && r.now() - started > maxMs) {
          stopped = "time";
          break;
        }
        const entry = apply(r.dirRead, dir, []) as import("node:fs").Dirent | null;
        if (entry === null) {
          read = true;
          break;
        }
        entries++;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (apply(r.direntIsDirectory, entry, [])) {
          queue[queue.length] = child;
          continue;
        }
        try {
          const stat = r.lstatSync(r.join(root, child));
          files[child] = { size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {}
      }
    } finally {
      try {
        apply(r.dirClose, dir, []);
      } catch {}
    }
    if (read) complete[rel] = true;
  }
  return { files, complete, stopped };
}

/** The files a script wrote (new or changed) and deleted, between two listings, where both saw the folder whole. */
export function changedFiles(before: Listing, after: Listing): { wrote: string[]; deleted: string[] } {
  const folderOf = (rel: string) => {
    const slash = rel.lastIndexOf("/");
    return slash < 0 ? "" : rel.slice(0, slash);
  };
  // A folder counts when the listing read it whole, or read everything (so a
  // folder it lacks wasn't there).
  const seen = (listing: Listing, folder: string) => listing.complete[folder] === true || listing.stopped === undefined;
  const wrote: string[] = [];
  const deleted: string[] = [];
  for (const rel in after.files) {
    const was = before.files[rel];
    const now = after.files[rel]!;
    const changed = was ? was.size !== now.size || was.mtimeMs !== now.mtimeMs : seen(before, folderOf(rel)) && after.complete[folderOf(rel)] === true;
    if (changed) wrote[wrote.length] = rel;
  }
  for (const rel in before.files) {
    if (!(rel in after.files) && before.complete[folderOf(rel)] === true && seen(after, folderOf(rel))) deleted[deleted.length] = rel;
  }
  return { wrote, deleted };
}

// ---------------------------------------------------------------- reads

type ReadKind = "read" | "list";
/** Hears each path a running script reads or lists; none between scripts. */
let recorder: ((target: string, kind: ReadKind) => void) | undefined;

type Watched = { owner: Record<string, unknown>; name: string; kind: (args: unknown[]) => ReadKind | undefined };

const always = (kind: ReadKind) => () => kind;
/** open's flags read the file: r, rs, r+, or O_RDONLY and O_RDWR. */
const opensToRead = (args: unknown[]): ReadKind | undefined => {
  const flags = args[1];
  if (flags === undefined || flags === null || typeof flags === "function") return "read";
  if (typeof flags === "string") return flags.startsWith("r") ? "read" : undefined;
  if (typeof flags === "number") return (flags & 3) !== 1 ? "read" : undefined;
  return undefined;
};

/** node:fs's read entry points (docs/mcp.md, "The files a script touched"). */
function watchedReads(): Watched[] {
  const callbacks = fs as unknown as Record<string, unknown>;
  // fs.promises loads on first use: only zenius mcp's scripts get here.
  const promises = fs.promises as unknown as Record<string, unknown>;
  return [
    ...["readFile", "readFileSync", "createReadStream", "copyFile", "copyFileSync", "cp", "cpSync"].map((name) => ({ owner: callbacks, name, kind: always("read") })),
    ...["open", "openSync"].map((name) => ({ owner: callbacks, name, kind: opensToRead })),
    ...["readdir", "readdirSync", "opendir", "opendirSync"].map((name) => ({ owner: callbacks, name, kind: always("list") })),
    ...["readFile", "copyFile", "cp"].map((name) => ({ owner: promises, name, kind: always("read") })),
    { owner: promises, name: "open", kind: opensToRead },
    ...["readdir", "opendir"].map((name) => ({ owner: promises, name, kind: always("list") })),
  ];
}

/** The path a node:fs call names first: a string, a Buffer or a file: URL; not a descriptor. */
function pathOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  if (value instanceof URL && value.protocol === "file:") {
    try {
      return refs().fileURLToPath(value);
    } catch {}
  }
  return undefined;
}

/**
 * Put the server's watch on node:fs's read entry points, afresh before each
 * script: the originals, wrapped again, whatever the last script left there.
 */
export function watchReads(): void {
  const r = refs();
  r.watched.forEach((watched, i) => {
    const original = r.originals[i]!;
    watched.owner[watched.name] = function (this: unknown, ...args: unknown[]) {
      const kind = recorder && watched.kind(args);
      const target = kind && pathOf(args[0]);
      if (kind && target) recorder?.(r.resolve(target), kind);
      return apply(original, this, args);
    };
  });
  // So the named imports of node:fs and node:fs/promises get them too.
  syncBuiltinESMExports();
}

// ---------------------------------------------------------------- output

/** The running script's writer, while its call lasts. */
let liveWrite: ((chunk: string) => void) | undefined;

/**
 * stdout carries the protocol alone (serveMcp writes it through its own
 * reference). While a script's call lasts, what anything writes to
 * process.stdout or process.stderr, Node's console in an imported module
 * included, goes in the script's output, as a terminal would show it; at
 * other times, to stderr.
 */
function routeStdio(): void {
  const r = refs();
  const routed = function (this: unknown, ...args: unknown[]): boolean {
    const [chunk, encoding, callback] = args;
    if (!liveWrite) return apply(r.stderrWrite, undefined, args) as boolean;
    liveWrite(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString(typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8"));
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") r.setImmediate(() => done());
    return true;
  } as typeof process.stdout.write;
  process.stdout.write = routed;
  process.stderr.write = routed;
}

/**
 * An error no script caught, from a callback or a promise nobody awaited:
 * into the running script's output, as the CLI would print it. False when no
 * script's call lasts, so the server says it on stderr.
 */
export function strayError(error: unknown): boolean {
  if (!liveWrite) return false;
  liveWrite(`[error] Uncaught ${formatScriptError(error).replace(/^Uncaught /, "")}\n`);
  return true;
}

// ---------------------------------------------------------------- process

/**
 * The script's process: Node's own, but exit() ends the script, as a
 * `zenius nodejs` process would end, abort() is refused, and stdin is empty,
 * as a heredoc script's is: the server's stdin is the client's. The real
 * process, through globalThis, can only end the script's own server.
 */
export function processStandIn(): NodeJS.Process {
  let stdin: NodeJS.ReadableStream | undefined;
  return new Proxy(process, {
    get(target, name) {
      if (name === "exit") {
        return (code?: number | string | null) => {
          throw new ScriptExit(Number(code ?? target.exitCode ?? 0) || 0);
        };
      }
      if (name === "abort" || name === "reallyExit") {
        return () => {
          throw new Error("process.abort() would end zenius's server: return from the script, or throw, instead");
        };
      }
      if (name === "stdin") return (stdin ??= stream().Readable.from([]));
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, name, value) {
      return Reflect.set(target, name, value, target);
    },
  });
}

// ---------------------------------------------------------------- globals

/** What the script tool needs from the server's session. */
export type ScriptHost = {
  /** The server's task, before it has one undefined. */
  readonly ownTask: TaskSpace | undefined;
  /** Start the server's task as open does: never another task's, a taken name numbered. */
  startTask(name: string): Promise<TaskSpace>;
};

/** Only the user gives a task back here, as the server's own words say at a hard stop. */
const ONLY_THE_USER =
  "here only the user gives a task back, with Resume agent in Zen. If they tell you to go on, ask them to press it, then call wait with user: true. A script in zenius mcp never claims or takes over a task.";

/**
 * The task functions, kept to the server's own task (docs/mcp.md, "A task of
 * its own"). They guard against mistakes, not abuse: a script can open a
 * connection of its own and name any task, as a terminal's script can, and
 * the runtime's rules hold for it there.
 */
function taskFunctions(host: ScriptHost, started: { name?: string }, onStart: (task: TaskSpace) => Promise<void>): ScriptGlobals {
  return {
    taskSpace: async (nameOrId?: unknown, options?: unknown) => {
      if (options !== undefined && !(typeof options === "object" && options !== null && Object.keys(options).length === 0)) {
        throw new TypeError("taskSpace takes no options in zenius mcp: a script works in its server's own task");
      }
      const own = host.ownTask;
      if (own) {
        if (nameOrId === undefined || nameOrId === own.name || String(nameOrId) === String(own.id)) return own;
        throw new Error(
          `taskSpace(${JSON.stringify(nameOrId)}): a script in zenius mcp works in its server's own task, ${quotedName(own.name, 80)} (id ${own.id}). Use task, or taskSpace() with its name or id.`,
        );
      }
      if (typeof nameOrId !== "string" || !nameOrId.trim()) {
        throw new TypeError('this server has no task yet: taskSpace("<a name for the task>") starts it, as open does');
      }
      const task = await host.startTask(nameOrId);
      started.name = task.name;
      await onStart(task);
      return task;
    },
    listTaskSpaces: async () => {
      const own = host.ownTask;
      return own ? (await listTaskSpaces()).filter((space) => space.id === own.id) : [];
    },
    claimTaskSpace: async () => {
      throw new Error(`claimTaskSpace: ${ONLY_THE_USER}`);
    },
    takeOverTaskSpace: async () => {
      throw new Error(`takeOverTaskSpace: ${ONLY_THE_USER}`);
    },
  };
}

/**
 * Each async global, refusing once the script's call has ended, a macrotask
 * later, so a retry loop can't starve the server, as the closed
 * connection's refusals do (rpc.ts).
 */
function guarded(globals: ScriptGlobals, isLive: () => boolean): ScriptGlobals {
  const r = refs();
  const out: ScriptGlobals = {};
  for (const [name, value] of Object.entries(globals)) {
    if (typeof value !== "function") {
      out[name] = value;
      continue;
    }
    out[name] = async (...args: unknown[]) => {
      if (!isLive()) {
        await new Promise((resolve) => r.setImmediate(resolve));
        throw new Error(`${name}: this script's call has ended (its time limit, or the client stopped it), so zenius refuses its later calls`);
      }
      return apply(value as (...args: unknown[]) => unknown, undefined, args);
    };
  }
  return out;
}

// ---------------------------------------------------------------- the run

export type ScriptEnd =
  | { kind: "done"; value: unknown }
  | { kind: "failed"; error: unknown }
  | { kind: "limit" }
  | { kind: "canceled" }
  /** The user stopped it with the sidebar's Stop, which closed its connection. */
  | { kind: "stopped" };

export type ScriptOutcome = {
  end: ScriptEnd;
  /** What the script printed, and the SDK's own lines, in order. */
  output: string;
  /** A hard stop that still held at the end (the user has the task, or it ended): the CLI shows its guidance alone. */
  hardStop: { error: ZeniusError | undefined; guidance: string } | undefined;
  /** The server's lines at the end of a run, as the CLI's: pages left unhandled, time the user held the task. */
  notices: string[];
  /** The files it touched, a line each kind (docs/mcp.md, "The files a script touched"). */
  files: string[];
  /** The name of the server's task, when the script started it. */
  started: string | undefined;
  /** The last Page the script's calls named. */
  lastPage: { space: number; label: string } | undefined;
  /** The script finished the server's task. */
  finished: boolean;
};

export type ScriptCall = {
  code: string;
  /** The tool's purpose, the agent's one line, which the script's step in the task quotes. */
  purpose: string;
  /** The `page` global at the start: the server's current Page, or the one the call named. */
  page: Page | undefined;
  limitMs: number;
  /** Aborted when the client cancels the call. */
  signal: AbortSignal;
  /** The working folder, as given and by its real path; none when it can't be named. */
  working: string[];
  /** Where each script's own temporary folder goes: the launcher's run folder. */
  tmpRoot: string;
};

/**
 * `target`'s path inside `dir` ("" for `dir` itself), or undefined when it's
 * outside: "..notes.txt" is a file of `dir`, "../notes.txt" isn't.
 */
export function insideFolder(dir: string, target: string): string | undefined {
  const r = refs();
  const rel = r.relative(dir, target);
  if (rel === ".." || rel.startsWith(`..${r.sep}`) || r.isAbsolute(rel)) return undefined;
  return rel;
}

/** Run one script tool call: its output, how it ended, and what it touched. */
export async function runScriptCall(host: ScriptHost, call: ScriptCall): Promise<ScriptOutcome> {
  const r = refs();
  const working = call.working.filter((dir, i, all) => dir && all.indexOf(dir) === i);
  const listRoot = working.at(-1);
  const before = listRoot === undefined ? undefined : listFolder(listRoot);

  const reads = new Map<string, ReadKind>();
  const uploads: Array<UploadNote & { origin: Promise<string | undefined> }> = [];
  const inWorkingFolder = (target: string): string | undefined => {
    for (const dir of working) {
      const rel = insideFolder(dir, target);
      if (rel !== undefined) return rel;
    }
    return undefined;
  };
  watchReads();
  routeStdio();
  recorder = (target, kind) => {
    const rel = inWorkingFolder(target);
    if (rel !== undefined && reads.get(rel) !== "read") reads.set(rel, kind);
  };

  const tmp = r.mkdtempSync(r.join(call.tmpRoot, "script-"));
  r.chmodSync(tmp, 0o700);
  const saved = {
    cwd: r.cwd(),
    env: { ...process.env },
    exitCode: process.exitCode,
    globals: new Set(Reflect.ownKeys(globalThis)),
  };
  process.env.TMPDIR = tmp;
  resetOutput();

  const instance = instanceName(undefined);
  const client = new RpcClient({ socketPath: socketPath(instance), instance });
  const round = new Round({ client });
  // The script's step in its task, with the steps of this connection's
  // calls under it (the runtime's script.begin): as the script starts, or
  // as it starts the server's task. A runtime that has none (an older one)
  // costs only the step.
  let stepBegun = false;
  const beginStep = async (task: TaskSpace | undefined): Promise<void> => {
    if (!task || stepBegun) return;
    stepBegun = true;
    await client.call("script.begin", { space: task.id, purpose: call.purpose }, { op: "script", safetyTimeoutMs: STEP_CALL_MS, quiet: true }).catch(() => {});
  };
  // The sidebar's Stop closes this connection, after saying so.
  let onUserStop: (() => void) | undefined;
  client.onEvent((event) => {
    if (event === "scriptStopped") onUserStop?.();
  });
  round.onUploads = (note) => {
    // Asked now, on the script's connection, before the page goes elsewhere.
    // The server's own question: under the tool call's signal, not the
    // script's, which aborts as the call ends, before the answer is read.
    const own = host.ownTask;
    const origin = (own && note.space === own.id ? withSignal(call.signal, () => own.page(note.label).url()) : Promise.resolve(undefined))
      .then((address) => {
        const origin = address ? new URL(address).origin : undefined;
        return origin && origin !== "null" ? origin : undefined;
      })
      .catch(() => undefined);
    uploads.push({ ...note, origin });
  };

  let live = true;
  const write = (chunk: string) => {
    if (live) bufferOutput(chunk);
  };
  liveWrite = write;
  const console = createRoundConsole(write);
  const started: { name?: string } = {};
  const globals: ScriptGlobals = {
    ...guarded(
      {
        ...taskFunctions(host, started, beginStep),
        profiles,
        siteSkills,
        learnContext,
        runSiteTool,
        runSiteBrowserTool,
      },
      () => live,
    ),
    help: (...names: unknown[]) => {
      const text = helpText(...names);
      write(`${text}\n`);
      return text;
    },
  };
  const ambient: ScriptGlobals = { task: host.ownTask ?? null, page: call.page ?? null };

  await beginStep(host.ownTask);
  // The script's calls: canceled with the tool call, and as the call ends, so
  // what the script leaves running (a timer, a promise nobody awaited) gets
  // no more calls, and one still waiting stops in the runtime, while the
  // server's own calls below still use the connection.
  const over = new AbortController();
  const scriptSignal: AbortSignal = r.abortAny([call.signal, over.signal]);
  const run = withSignal(scriptSignal, () => runInRound(round, () => runScript(call.code, globals, { console, lexical: { process: processStandIn() }, ambient })));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const end = await new Promise<ScriptEnd>((resolve) => {
    timer = r.setTimeout(() => resolve({ kind: "limit" }), call.limitMs);
    onAbort = () => resolve({ kind: "canceled" });
    onUserStop = () => resolve({ kind: "stopped" });
    if (call.signal.aborted) onAbort();
    else call.signal.addEventListener("abort", onAbort, { once: true });
    run.then(
      (result) => resolve(result.exitCode === 0 ? { kind: "done", value: result.value } : { kind: "failed", error: result.error }),
      (error: unknown) => resolve({ kind: "failed", error }),
    );
  });
  r.clearTimeout(timer);
  if (onAbort) call.signal.removeEventListener("abort", onAbort);

  // The call is over: what the script still does is no longer its call's.
  live = false;
  over.abort(SCRIPT_CALL_OVER);
  liveWrite = undefined;
  recorder = undefined;
  const settled = end.kind === "done" || end.kind === "failed";
  // As the CLI does after a script that ended well: pages it opened and never used.
  if (end.kind === "done") await round.reportUnhandledPages().catch(() => {});
  // An upload's page said its address as the upload ended; a stopped call waits for none.
  const origins = await Promise.all(uploads.map((upload) => within(upload.origin, settled ? ORIGIN_WAIT_MS : 0)));
  const held = client.heldMsBySpace();
  // The step ends with the call. One the client canceled, or the user
  // stopped, ends as stopped as its connection closes.
  if (stepBegun && end.kind !== "canceled" && end.kind !== "stopped") {
    const outcome = end.kind === "done" ? "ok" : end.kind === "limit" ? "ZEN_TIMEOUT" : end.error instanceof ZeniusError ? end.error.code : "failed";
    await within(client.call("script.end", { outcome }, { op: "script", safetyTimeoutMs: STEP_CALL_MS, quiet: true }), STEP_CALL_MS);
  }
  client.close();
  const output = takeOutput();
  const after = listRoot === undefined ? undefined : listFolder(listRoot);

  try {
    r.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  // The globals the server gave the script stay: what it left running
  // reaches its calls' refusals through them (page.title() then fails after
  // a turn), where a missing name would throw at once and a retry loop
  // would spin and starve the server. The next script sets them afresh.
  restore(saved, new Set(Object.keys({ ...globals, ...ambient })));

  const hardStop = output.hardStop === undefined ? undefined : { error: round.lastHardStop, guidance: output.hardStop };
  const notices = output.notices
    .split("\n")
    .filter((line) => line && !line.startsWith("[zenius:"));
  if (!hardStop) {
    for (const ms of held.values()) {
      notices.push(`The user paused the task, and the script's actions waited ${(ms / 1000).toFixed(1)} s. The page may have changed: read it again before using its refs.`);
    }
  }
  const { wrote, deleted } = before && after ? changedFiles(before, after) : { wrote: [], deleted: [] };
  const uploaded = uploads.map((upload, i) => ({ names: upload.names, paths: upload.paths, origin: origins[i] }));
  const task = host.ownTask;
  return {
    end,
    output: output.text,
    hardStop,
    notices,
    files: fileLines({ reads, uploaded, wrote, deleted, stopped: before?.stopped ?? after?.stopped, inWorkingFolder }),
    started: started.name,
    lastPage: round.lastPage,
    finished: task !== undefined && round.finished(task.id),
  };
}

/** `promise`'s value, or undefined if it takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  const r = refs();
  return new Promise((resolve) => {
    const timer = r.setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        r.clearTimeout(timer);
        resolve(value);
      },
      () => {
        r.clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** Put back what a script may have changed in the server's process. */
function restore(saved: { cwd: string; env: NodeJS.ProcessEnv; exitCode: typeof process.exitCode; globals: Set<string | symbol> }, keep: Set<string>): void {
  const r = refs();
  try {
    if (r.cwd() !== saved.cwd) r.chdir(saved.cwd);
  } catch {}
  for (const name of Object.keys(process.env)) {
    if (!(name in saved.env)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(saved.env)) {
    if (value !== undefined && process.env[name] !== value) process.env[name] = value;
  }
  process.exitCode = saved.exitCode;
  for (const key of Reflect.ownKeys(globalThis)) {
    if (saved.globals.has(key) || (typeof key === "string" && keep.has(key))) continue;
    try {
      delete (globalThis as Record<string | symbol, unknown>)[key];
    } catch {}
  }
  // Between scripts too, so stdout stays the protocol's.
  routeStdio();
}

// ---------------------------------------------------------------- the lines

/** Names as one line shows them: the first few, then "and N more". */
function nameList(names: string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).map((name) => quotedName(name));
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
}

/**
 * The files a script touched, a line each kind, as the chat shows them under
 * the script's step, each file by its own name (docs/mcp.md).
 */
export function fileLines(seen: {
  reads: Map<string, ReadKind>;
  uploaded: Array<{ names: string[]; paths: string[]; origin: string | undefined }>;
  wrote: string[];
  deleted: string[];
  stopped: Listing["stopped"];
  inWorkingFolder: (target: string) => string | undefined;
}): string[] {
  const r = refs();
  const lines: string[] = [];
  // An uploaded file's own read isn't a line of its own.
  const sent = seen.uploaded
    .flatMap((upload) => upload.paths.map((p) => seen.inWorkingFolder(r.resolve(p))))
    .filter((rel): rel is string => rel !== undefined);
  const isSent = (rel: string) => sent.some((s) => rel === s || (s !== "" && rel.startsWith(`${s}/`)));
  const read: string[] = [];
  const folders: string[] = [];
  let listedTop = false;
  for (const [rel, kind] of seen.reads) {
    if (isSent(rel)) continue;
    if (kind === "read") read.push(r.basename(rel));
    else if (rel === "") listedTop = true;
    else folders.push(r.basename(rel));
  }
  if (read.length) lines.push(`Read ${nameList(read)}`);
  if (listedTop) lines.push(`Listed the working folder${folders.length ? ` and ${nameList(folders)}` : ""}`);
  else if (folders.length) lines.push(`Listed ${nameList(folders)}`);
  if (seen.wrote.length) lines.push(`Wrote ${nameList(seen.wrote.map((rel) => r.basename(rel)))}`);
  if (seen.deleted.length) lines.push(`Deleted ${nameList(seen.deleted.map((rel) => r.basename(rel)))}`);
  for (const upload of seen.uploaded) {
    if (!upload.names.length) continue;
    lines.push(`Uploaded ${nameList(upload.names.map((name) => name.split("/").at(-1) ?? name))} to ${upload.origin ?? "a page of the task"}`);
  }
  if (seen.stopped) {
    lines.push(
      `The working folder holds more than the server lists in ${seen.stopped === "time" ? `${LIST_MAX_MS} ms` : `${LIST_MAX_ENTRIES} entries`}, so a file written or deleted past that may be missing here.`,
    );
  }
  return lines;
}
