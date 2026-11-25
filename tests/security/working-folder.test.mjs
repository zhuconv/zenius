// The sandboxed launcher's half of the working folder's shared rules
// (tests/fixtures/working-folder.json, which the installers' suites read
// too), its reading of config.json, and its rule when there's none. Each case
// runs `--version` through a copy of the launcher run.sh installed, its
// zenius home rewritten to the case's own, as the installer writes it, with a
// config.json there naming the case's folder. An allowed folder runs, and a
// missing one is made, readable only by the user. A refused one stops every
// command (exit 70) with the category's reason, and nothing is made.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { guardHome } from "../lib/scratch-home.mjs";

const LAUNCHER = process.env.ZENIUS_SECURITY_LAUNCHER ?? "";
if (!LAUNCHER) throw new Error("run this part through tests/security/run.sh sandbox");
const TEXT = readFileSync(LAUNCHER, "utf8");
const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/working-folder.json", import.meta.url), "utf8"));

/** A value the launcher was written with, such as CLI or BIN_DIR. */
function launcherValue(name) {
  const line = TEXT.split("\n").find((text) => text.startsWith(`${name}='`));
  if (!line) throw new Error(`${LAUNCHER} has no ${name} line`);
  return line.slice(name.length + 2, -1).replaceAll("'\\''", "'");
}
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/** The launcher's words for each category of refusal. It names no kept folder, only the work tree's. */
const SAYS = {
  shared: () => /^zenius \(sandboxed\): the working folder, .*, holds more than a task's files/,
  kept: () => /^zenius \(sandboxed\): the working folder, .*, holds more than a task's files/,
  project: () => /^zenius \(sandboxed\): the working folder, .*, holds \.git or \.envrc/,
  worktree: (repo) => new RegExp(`^zenius \\(sandboxed\\): the working folder, .*, is inside a git work tree \\(${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`),
  "not-yours": () => /^zenius \(sandboxed\): the working folder, .*, isn't a folder of yours/,
  "not-a-folder": () => /^zenius \(sandboxed\): the working folder, .*, isn't a folder: /,
  "no-parent": () => /^zenius \(sandboxed\): can't make the working folder, /,
};

let work;
before(() => {
  // By real path, as the launcher compares paths: on macOS tmpdir() is a link.
  work = realpathSync(mkdtempSync(join(tmpdir(), "zwf-")));
});
after(() => {
  // rmSync can't remove a folder that can't be listed, even an empty one.
  for (const folder of unlistable) chmodSync(folder, 0o700);
  rmSync(work, { recursive: true, force: true });
});

let roots = 0;
/** A case's scratch root (~), and its tokens filled in. */
function caseRoot() {
  const root = join(work, String((roots += 1)));
  mkdirSync(root, { mode: 0o700 });
  const tokens = { "{cli}": launcherValue("CLI"), "{bin}": launcherValue("BIN_DIR"), "{PATH}": process.env.PATH ?? "" };
  const fill = (text) => {
    let out = text.startsWith("~") ? root + text.slice(1) : text;
    for (const [token, value] of Object.entries(tokens)) out = out.replaceAll(token, value);
    return out;
  };
  return { root, fill };
}

/** Folders made unlistable, for after() to give their mode back. */
const unlistable = [];

/** A case's folders that can't be listed (mode 000), made after its entries. */
function makeUnlistable(folders, fill) {
  for (const folder of folders ?? []) {
    mkdirSync(fill(folder), { recursive: true });
    chmodSync(fill(folder), 0);
    unlistable.push(fill(folder));
  }
}

/** Root reads any folder, so a case with one that can't be listed proves nothing then. */
const AS_ROOT = process.getuid?.() === 0;

/** Makes a case's entries: "x/" a folder, "x" an empty file, "x -> y" a link to y. */
function make(entries, fill) {
  for (const entry of entries ?? []) {
    const link = /^(.*) -> (.*)$/.exec(entry);
    if (link) {
      mkdirSync(dirname(fill(link[1])), { recursive: true });
      symlinkSync(fill(link[2]), fill(link[1]));
    } else if (entry.endsWith("/")) {
      mkdirSync(fill(entry), { recursive: true });
    } else {
      mkdirSync(dirname(fill(entry)), { recursive: true });
      writeFileSync(fill(entry), "");
    }
  }
}

/** A copy of the launcher whose zenius home is `zhome` (resolved, as the installer writes it). */
function launcherFor(zhome) {
  const file = join(work, `launcher-${(roots += 1)}`);
  writeFileSync(file, TEXT.replace(/^ZHOME='.*'$/m, `ZHOME=${quote(zhome)}`), { mode: 0o755 });
  return file;
}

/** `launcher --version`, or inside a bubblewrap sandbox of the test's own with `outer` (its options), as Codex's runs a command. */
function run(launcher, env, outer) {
  const [command, args] = outer ? ["bwrap", ["--dev-bind", "/", "/", ...outer, "--", launcher, "--version"]] : [launcher, ["--version"]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: work, env: guardHome({ ...process.env, ...env }, "working-folder.test"), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const config = (folder) => `{\n  "workingFolder": "${folder}"\n}\n`;
const present = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const RAN = /^zenius \d+\.\d+\.\d+ \(protocol 1, sandboxed\)\n$/;

/** One case: its root, its environment, the launcher for its zenius home with config.json written there. */
function setUp(c, text) {
  const { root, fill } = caseRoot();
  make(c.make, fill);
  makeUnlistable(c.unlistable, fill);
  const env = { ...FIXTURE.env, ...c.env };
  const zhome = fill(env.ZENIUS_HOME);
  mkdirSync(zhome, { recursive: true, mode: 0o700 });
  if (text !== undefined) writeFileSync(join(zhome, "config.json"), text, { mode: 0o600 });
  return {
    root,
    fill,
    launcher: launcherFor(realpathSync(zhome)),
    env: { HOME: fill(env.HOME), ZENIUS_HOME: realpathSync(zhome), TMPDIR: env.TMPDIR ? fill(env.TMPDIR) : (process.env.TMPDIR ?? tmpdir()), PATH: env.PATH ? fill(env.PATH) : process.env.PATH },
  };
}

test("the launcher agrees with tests/fixtures/working-folder.json: each refused folder stops it with its reason and is never made, each allowed one runs", async () => {
  const cases = FIXTURE.cases.filter((c) => (!c.by || c.by.includes("launcher")) && !(c.unlistable && AS_ROOT));
  assert.ok(cases.length > 30, `${cases.length} cases for the launcher`);
  const got = [];
  for (const c of cases) {
    const { fill, launcher, env } = setUp(c);
    const folder = fill(c.folder);
    writeFileSync(join(env.ZENIUS_HOME, "config.json"), config(folder), { mode: 0o600 });
    const before = present(folder);
    const result = await run(launcher, env);
    if (c.outcome === "allowed") {
      if (result.code !== 0 || !RAN.test(result.stdout)) got.push(`${c.name}: exit ${result.code}: ${result.stderr.trim()}`);
      else if (!before && (!statSync(folder).isDirectory() || (statSync(folder).mode & 0o777) !== 0o700)) got.push(`${c.name}: the folder wasn't made 0700`);
      continue;
    }
    const said = SAYS[c.outcome]?.(c.repo ? realpathSync(fill(c.repo)) : "");
    if (!said) got.push(`${c.name}: no launcher wording for ${c.outcome}`);
    else if (result.code !== 70 || result.stdout !== "" || !said.test(result.stderr)) got.push(`${c.name}: exit ${result.code}, expected ${c.outcome}: ${result.stderr.trim()}${result.stdout}`);
    if (!before && present(folder)) got.push(`${c.name}: the refused folder was made`);
  }
  assert.deepEqual(got, []);
});

test("the launcher reads config.json as the installers write it, and refuses a file that doesn't name the folder on a line of its own, never falling back to ~/zenius-files", async () => {
  const got = [];
  for (const { name, text } of FIXTURE.configs.readable) {
    const { fill, launcher, env } = setUp({}, undefined);
    const folder = fill("~/files");
    writeFileSync(join(env.ZENIUS_HOME, "config.json"), text.replaceAll("{folder}", folder), { mode: 0o600 });
    const result = await run(launcher, env);
    if (result.code !== 0 || !RAN.test(result.stdout)) got.push(`readable, ${name}: exit ${result.code}: ${result.stderr.trim()}`);
    else if (!existsSync(folder)) got.push(`readable, ${name}: ${folder} wasn't made`);
  }
  for (const { name, text } of FIXTURE.configs.unreadable) {
    const { fill, launcher, env } = setUp({}, undefined);
    const folder = fill("~/files");
    const file = join(env.ZENIUS_HOME, "config.json");
    writeFileSync(file, text.replaceAll("{folder}", folder), { mode: 0o600 });
    const result = await run(launcher, env);
    const said = `zenius (sandboxed): ${file} doesn't name the working folder on a line of its own, as the installer writes it: reinstall with scripts/install-cli.sh --working-dir`;
    if (result.code !== 70 || !result.stderr.startsWith(said)) got.push(`unreadable, ${name}: exit ${result.code}: ${result.stderr.trim()}`);
    for (const made of [folder, fill("~/zenius-files")]) if (existsSync(made)) got.push(`unreadable, ${name}: ${made} was made`);
  }
  assert.deepEqual(got, []);
});

test("without config.json the launcher takes ~/zenius-files only while its zenius home is ~/.zenius; another has no default, and the launcher makes nothing", async () => {
  // The install's zenius home is ~/.zenius: the default, made 0700.
  const plain = setUp({}, undefined);
  const result = await run(plain.launcher, plain.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(statSync(plain.fill("~/zenius-files")).mode & 0o777, 0o700);
  // Anywhere else: no default.
  const moved = setUp({ env: { ZENIUS_HOME: "~/elsewhere/zhome" } }, undefined);
  const refused = await run(moved.launcher, moved.env);
  assert.equal(refused.code, 70, refused.stdout);
  assert.equal(
    refused.stderr,
    `zenius (sandboxed): there's no default working folder: this install's zenius home, ${moved.env.ZENIUS_HOME}, isn't ~/.zenius, and it holds no config.json: reinstall with scripts/install-cli.sh --working-dir <a folder such as ~/zenius-files>\n`,
  );
  assert.equal(existsSync(moved.fill("~/zenius-files")), false, "the default was made");
});

// Codex's sandbox on Linux (0.169.0) mounts, in each folder its commands may
// write, an empty read-only tmpfs at .git where the disk has none, its mount
// point an empty .git folder on the disk while the command runs; and it binds
// a real .git read-only. A bubblewrap sandbox of the test's own stands in for
// Codex's here, around the launcher, which starts its own inside. Empty .git
// folders, whatever holds them, are no repository; a real .git still is.
test(
  "inside Codex's sandbox on Linux, its empty .git folders in or above the working folder, and another command's on the disk, are no project's; a real .git still is",
  { skip: process.platform !== "linux" && "Codex mounts these on Linux only" },
  async () => {
    const placeholder = (path) => ["--tmpfs", path, "--remount-ro", path];
    const bound = (path) => ["--ro-bind", path, path];
    const cases = [
      { name: "Codex's .git in the folder", make: ["~/files/"], folder: "~/files", outer: (f) => placeholder(f("~/files/.git")), outcome: "allowed" },
      { name: "Codex's .git above it", make: ["~/w/files/"], folder: "~/w/files", outer: (f) => placeholder(f("~/w/.git")), outcome: "allowed" },
      { name: "another command's empty .git on the disk, bound read-only", make: ["~/files/.git/"], folder: "~/files", outer: (f) => bound(f("~/files/.git")), outcome: "allowed" },
      { name: "a real .git, read-only", make: ["~/files/.git/HEAD"], folder: "~/files", outer: (f) => bound(f("~/files/.git")), outcome: "project" },
      { name: "a real .git above it, read-only", make: ["~/w/files/", "~/w/.git/HEAD"], folder: "~/w/files", outer: (f) => bound(f("~/w/.git")), outcome: "worktree", repo: "~/w" },
    ];
    const got = [];
    for (const c of cases) {
      const { fill, launcher, env } = setUp(c);
      writeFileSync(join(env.ZENIUS_HOME, "config.json"), config(fill(c.folder)), { mode: 0o600 });
      const result = await run(launcher, env, c.outer(fill));
      if (c.outcome === "allowed") {
        if (result.code !== 0 || !RAN.test(result.stdout)) got.push(`${c.name}: exit ${result.code}: ${result.stderr.trim()}`);
        continue;
      }
      const said = SAYS[c.outcome](c.repo ? realpathSync(fill(c.repo)) : "");
      if (result.code !== 70 || !said.test(result.stderr)) got.push(`${c.name}: exit ${result.code}, expected ${c.outcome}: ${result.stderr.trim()}${result.stdout}`);
    }
    assert.deepEqual(got, []);
  },
);
