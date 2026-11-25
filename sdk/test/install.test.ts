// scripts/install-cli.sh, run against temporary directories, and how
// bin/zenius picks the bundle or the sources.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { guardHome, realPath } from "../../tests/lib/scratch-home.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const SCRIPT = join(REPO, "scripts/install-cli.sh");
const LAUNCHER = join(REPO, "sdk/bin/zenius");

const temporary: string[] = [];
// Folders a case made unlistable (mode 000). rmSync can't remove one, even
// an empty one, so after() gives each its mode back first.
const unlistable: string[] = [];
after(() => {
  for (const folder of unlistable) chmodSync(folder, 0o700);
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}
// The copies here run from a new path each time, so Node's compile cache
// for them goes in a folder this file removes, not the CLI's own folder,
// where each run's entries would pile up.
process.env.NODE_COMPILE_CACHE = join(scratch("zenius-install-"), "compile-cache");

/**
 * The environment of a run of an installer, the launcher or the CLI: HOME
 * and ZENIUS_HOME in the scratch folder `home` (ZENIUS_HOME as HOME/.zenius,
 * where the installers' default working folder applies), unless `extra`
 * names others. guardHome fails the run before it starts if either is the
 * account's own.
 */
function scratchEnv(home: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return guardHome({ ...process.env, HOME: home, ZENIUS_HOME: join(home, ".zenius"), ...extra }, "install.test.ts");
}

function install(home: string, args: string[] = [], options: { script?: string; build?: boolean; env?: Record<string, string> } = {}) {
  const result = spawnSync("bash", [options.script ?? SCRIPT, ...args], {
    encoding: "utf8",
    // Each install sets the working folder, ~/zenius-files unless
    // --working-dir says, in ~/.zenius/config.json: both in the scratch home.
    env: scratchEnv(home, {
      ZENIUS_CLI_DIR: join(home, "cli"),
      ZENIUS_BIN_DIR: join(home, "bin"),
      ZENIUS_SKILL_DIRS: `${join(home, "claude")} ${join(home, "agents")}`,
      // The SDK suites run dist/; rebuilding it here would race them.
      ...(options.build ? {} : { ZENIUS_INSTALL_NO_BUILD: "1" }),
      ...options.env,
    }),
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** The CLI's part of this checkout, copied, with its node_modules linked in to build with. */
function checkoutCopy(): string {
  const root = scratch("zenius-checkout-");
  for (const path of [
    "scripts/install-cli.sh",
    "scripts/working-folder.sh",
    "sdk/bin",
    "sdk/src",
    "sdk/build.mjs",
    "sdk/package.json",
    "sdk/sandbox",
    "sdk/tsconfig.json",
    "skill/guide.md",
    "skill/zenius",
    "runtime/vendor/fx-autoconfig",
  ]) {
    cpSync(join(REPO, path), join(root, path), { recursive: true });
  }
  symlinkSync(join(REPO, "sdk/node_modules"), join(root, "sdk/node_modules"));
  return root;
}

/**
 * Node with its TypeScript support off, as Node 23.0-23.5 and 22.6-22.17 run
 * by default, running `file`, the zenius command in a scratch home's bin.
 */
function withoutTypeScript(file: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["--no-experimental-strip-types", file, ...args], {
    encoding: "utf8",
    // zenius doctor reads only these, and finds no Zen there.
    env: scratchEnv(dirname(dirname(file)), { ZEN_BIN: "", ZENIUS_SOCKET: "" }),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Where an install in the scratch home keeps the working folder's setting. */
const configOf = (home: string) => join(home, ".zenius/config.json");
/** config.json as the installers write it. */
const naming = (folder: string) => `{\n  "workingFolder": "${folder}"\n}\n`;
const modeOf = (path: string) => lstatSync(path).mode & 0o777;
const linesOf = (out: string) => out.split("\n");

/**
 * tests/fixtures/working-folder.json: the working folder's rules as cases
 * that every reader of them runs, these installers and the launcher
 * (tests/security) alike. Its "about" says how a case runs.
 */
type FolderCase = {
  name: string;
  folder: string;
  make?: string[];
  unlistable?: string[];
  env?: Record<string, string>;
  outcome: string;
  kept?: string;
  repo?: string;
  by?: string[];
};
type ConfigCase = { name: string; text: string };
const FIXTURE = JSON.parse(readFileSync(join(REPO, "tests/fixtures/working-folder.json"), "utf8")) as {
  env: Record<string, string>;
  cases: FolderCase[];
  configs: { unreadable: ConfigCase[]; readable: ConfigCase[] };
};
/** Root reads any folder, so a case with one that can't be listed proves nothing then. */
const AS_ROOT = process.getuid?.() === 0;
/** The fixture's cases that hold for install-cli.sh. */
const CASES = FIXTURE.cases.filter((c) => (!c.by || c.by.includes("install-cli.sh")) && !(c.unlistable && AS_ROOT));

/** A case's folder, entry or env value, with ~ as the scratch root `home` and its tokens filled in. */
function caseFiller(home: string): (text: string) => string {
  const tokens: Record<string, string> = { cli: join(home, "cli"), bin: join(home, "bin"), node: process.execPath, PATH: process.env.PATH ?? "" };
  return (text) =>
    text.replace(/^~(?=\/|$)/, home).replace(/\{(\w+)\}/g, (all, name: string) => {
      assert.ok(name in tokens, `install-cli.sh's cases have no ${all}`);
      return tokens[name]!;
    });
}

/** A case's environment: the fixture's defaults, then the case's own, filled in. */
const caseEnv = (c: { env?: Record<string, string> }, fill: (text: string) => string): Record<string, string> =>
  Object.fromEntries(Object.entries({ ...FIXTURE.env, ...c.env }).map(([name, value]) => [name, fill(value)]));

/** Makes a case's entries: 'x/' a folder, 'x' an empty file, 'x -> y' a link. One that's there stays. */
function makeEntries(entries: string[] | undefined, fill: (text: string) => string): void {
  for (const entry of entries ?? []) {
    const [from, to] = entry.split(" -> ");
    const path = fill(from!);
    const bare = path.replace(/\/$/, "");
    if (lstatSync(bare, { throwIfNoEntry: false })) continue;
    mkdirSync(dirname(bare), { recursive: true });
    if (to !== undefined) symlinkSync(fill(to), bare);
    else if (path.endsWith("/")) mkdirSync(bare);
    else writeFileSync(bare, "");
  }
}

/** Makes a case's folders that can't be listed (mode 000), after its entries. */
function makeUnlistable(folders: string[] | undefined, fill: (text: string) => string): void {
  for (const folder of folders ?? []) {
    const path = fill(folder);
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0);
    unlistable.push(path);
  }
}

/** Whether `path` is `folder` or inside it. */
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * The installers' reason for refusing a case's folder, as they print it:
 * `folder` as given, and the folder the reason names by its real path.
 */
function refusal(c: FolderCase, folder: string, fill: (text: string) => string): string {
  const cant = `the working folder can't be ${folder}`;
  switch (c.outcome) {
    case "not-plain":
      return `the working folder must be an absolute path with no double quote, backslash or control character: ${folder}`;
    case "not-a-folder":
    case "not-yours":
      return `the working folder must be a folder of yours: ${folder}`;
    case "no-parent":
      return `the working folder's parent folder must exist: ${folder}`;
    case "shared":
      return `${cant}: it's your home folder, a temporary folder, or a folder above one`;
    case "kept": {
      const kept = realPath(fill(c.kept!));
      // A kept folder the folder is, or holds, comes first.
      const how = within(kept, realPath(folder)) ? "it holds" : "it's inside";
      return `${cant}: ${how} ${kept}, which the agent's scripts must not reach`;
    }
    case "project":
      return lstatSync(join(realPath(folder), ".git"), { throwIfNoEntry: false })
        ? `${cant}: it holds .git, so it's a project's folder`
        : `${cant}: it holds .envrc, which direnv runs`;
    case "worktree":
      return `${cant}: it's inside a git work tree, ${realPath(fill(c.repo!))}`;
    default:
      throw new Error(`${c.name}: no wording for the outcome ${c.outcome}`);
  }
}

/** A fixture config.json naming `folder`. */
const configText = (c: ConfigCase, folder: string) => c.text.replaceAll("{folder}", folder);

describe("scripts/install-cli.sh", () => {
  it("installs a copy that always runs its bundle, links the CLI and the Skill to it, and uninstalls", () => {
    const home = scratch("zenius-install-");
    const copy = join(home, "cli");
    const first = install(home, ["--skill"]);
    assert.equal(first.code, 0, first.out);
    assert.equal(readlinkSync(join(home, "bin/zenius")), join(copy, "sdk/bin/zenius"));
    assert.equal(readlinkSync(join(home, "claude/zenius")), join(copy, "skill/zenius"));
    assert.equal(readlinkSync(join(home, "agents/zenius")), join(copy, "skill/zenius"));
    for (const file of [
      "sdk/bin/zenius",
      "sdk/dist/zenius.mjs",
      "sdk/dist/guide.md",
      "sdk/package.json",
      "skill/zenius/SKILL.md",
      "skill/zenius/learnings/github/manifest.json",
      "runtime/vendor/fx-autoconfig/program/config.js",
    ]) {
      assert.ok(existsSync(join(copy, file)), file);
    }
    assert.equal(existsSync(join(copy, "sdk/src")), false, "the copy has no sources to fall back to");
    const record = JSON.parse(readFileSync(join(copy, "install.json"), "utf8"));
    assert.equal(record.from, REPO);
    assert.match(record.commit, /^[0-9a-f]{7,}(-dirty)?$/);
    assert.match(record.installedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.match(first.out, /^installed .*\/cli: zenius \d+\.\d+\.\d+, commit [0-9a-f]{7}/m);
    assert.match(first.out, /^check {4}zenius \d+\.\d+\.\d+/m);

    // The Mac's Node 23.5 can't strip types: the copy never needs to.
    const version = withoutTypeScript(join(home, "bin/zenius"), "--version");
    assert.equal(version.code, 0, version.stderr);
    assert.match(version.stdout, /^zenius \d+\.\d+\.\d+ \(protocol \d+\)\n$/);
    const guide = withoutTypeScript(join(home, "bin/zenius"), "skill");
    assert.equal(guide.code, 0, guide.stderr);
    assert.match(guide.stdout, /^\[zenius:skill\] zenius usage guide v/);
    const learnings = withoutTypeScript(
      join(home, "bin/zenius"),
      "nodejs",
      "-e",
      'console.log((await siteSkills("https://github.com/x/y")).map((skill) => skill.id).join(","))',
    );
    assert.equal(learnings.stdout, "github\n", learnings.stderr);
    // zenius doctor names the copy, and finds fx-autoconfig's files in it.
    const report = JSON.parse(withoutTypeScript(join(home, "bin/zenius"), "doctor", "--json", "--instance", "install-test").stdout);
    const cli = report.checks.find((entry: { id: string }) => entry.id === "cli");
    assert.equal(cli.status, "ok", JSON.stringify(cli));
    // By its real path: Node runs the copy from there, and on macOS the temp folder is a link.
    assert.ok(cli.summary.includes(`, installed in ${realpathSync(copy)} from commit ${record.commit} on ${record.installedAt.slice(0, 10)}`), cli.summary);

    // A learning added to the installed Skill survives a reinstall.
    mkdirSync(join(copy, "skill/zenius/learnings/my-site"));
    writeFileSync(join(copy, "skill/zenius/learnings/my-site/manifest.json"), "{}\n");
    const again = install(home, ["--skill"]);
    assert.equal(again.code, 0, again.out);
    // The three links, and the working folder the first install set.
    assert.equal(again.out.match(/^ok /gm)?.length, 4);
    assert.ok(linesOf(again.out).includes(`ok       the working folder: ${join(home, "zenius-files")}`), again.out);
    assert.match(again.out, /^kept {5}learnings\/my-site, added to the previous copy$/m);
    assert.ok(existsSync(join(copy, "skill/zenius/learnings/my-site/manifest.json")));

    assert.equal(install(home, ["--uninstall"]).code, 0);
    for (const path of ["bin/zenius", "claude/zenius", "agents/zenius", "cli"]) assert.equal(existsSync(join(home, path)), false, path);
  });

  it("moves links an earlier install made into a checkout over to the copy", () => {
    const home = scratch("zenius-install-");
    mkdirSync(join(home, "bin"));
    mkdirSync(join(home, "claude"));
    symlinkSync(join(REPO, "sdk/bin/zenius"), join(home, "bin/zenius"));
    symlinkSync(join(REPO, "skill/zenius"), join(home, "claude/zenius"));
    const result = install(home, ["--skill"]);
    assert.equal(result.code, 0, result.out);
    assert.equal(readlinkSync(join(home, "bin/zenius")), join(home, "cli/sdk/bin/zenius"));
    assert.equal(readlinkSync(join(home, "claude/zenius")), join(home, "cli/skill/zenius"));
    assert.match(result.out, /^updated {2}.*\/bin\/zenius -> .*\/cli\/sdk\/bin\/zenius \(was .*\/sdk\/bin\/zenius\)$/m);
  });

  it("leaves files, other links and directories it didn't make alone, and a dry run changes nothing", () => {
    const home = scratch("zenius-install-");
    mkdirSync(join(home, "claude/zenius"), { recursive: true });
    mkdirSync(join(home, "agents"));
    symlinkSync("/opt/somebody-else", join(home, "agents/zenius"));
    const dry = install(home, ["--skill", "--dry-run"]);
    assert.equal(existsSync(join(home, "bin")), false, dry.out);
    assert.equal(existsSync(join(home, "cli")), false, dry.out);
    assert.match(dry.out, /^would install .*\/cli: zenius \d+\.\d+\.\d+/m);

    const result = install(home, ["--skill"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /claude\/zenius exists and isn't a symlink; left alone/);
    assert.match(result.out, /agents\/zenius links to \/opt\/somebody-else, which isn't a zenius CLI or Skill; left alone/);
    assert.equal(lstatSync(join(home, "claude/zenius")).isDirectory(), true);
    assert.equal(readlinkSync(join(home, "agents/zenius")), "/opt/somebody-else");
    assert.equal(readlinkSync(join(home, "bin/zenius")), join(home, "cli/sdk/bin/zenius"));
    install(home, ["--uninstall"]);
    assert.equal(lstatSync(join(home, "claude/zenius")).isDirectory(), true);
    assert.equal(readlinkSync(join(home, "agents/zenius")), "/opt/somebody-else");

    const other = scratch("zenius-install-");
    mkdirSync(join(other, "cli"));
    writeFileSync(join(other, "cli/notes.txt"), "mine\n");
    const refused = install(other);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /\/cli exists and isn't a zenius CLI copy; left alone/);
    install(other, ["--uninstall"]);
    assert.equal(readFileSync(join(other, "cli/notes.txt"), "utf8"), "mine\n");
  });

  it("won't install a bundle older than the sources when it can't build one", () => {
    // A checkout without sdk/node_modules whose bundle predates its sources.
    const root = scratch("zenius-checkout-");
    mkdirSync(join(root, "scripts"));
    cpSync(SCRIPT, join(root, "scripts/install-cli.sh"));
    cpSync(join(REPO, "scripts/working-folder.sh"), join(root, "scripts/working-folder.sh"));
    mkdirSync(join(root, "sdk/bin"), { recursive: true });
    cpSync(LAUNCHER, join(root, "sdk/bin/zenius"));
    mkdirSync(join(root, "sdk/dist"));
    writeFileSync(join(root, "sdk/dist/zenius.mjs"), "export async function main() { return 0; }\n");
    writeFileSync(join(root, "sdk/dist/guide.md"), "guide\n");
    writeFileSync(join(root, "sdk/package.json"), '{ "version": "9.9.9", "type": "module" }\n');
    mkdirSync(join(root, "sdk/src"));
    writeFileSync(join(root, "sdk/src/cli.ts"), "export {};\n");
    cpSync(join(REPO, "sdk/sandbox"), join(root, "sdk/sandbox"), { recursive: true });
    mkdirSync(join(root, "skill/zenius"), { recursive: true });
    writeFileSync(join(root, "skill/guide.md"), "guide\n");
    writeFileSync(join(root, "skill/zenius/SKILL.md"), "skill\n");
    mkdirSync(join(root, "runtime/vendor/fx-autoconfig"), { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, "sdk/dist/zenius.mjs"), old, old);

    const home = scratch("zenius-install-");
    const stale = install(home, [], { script: join(root, "scripts/install-cli.sh"), build: true });
    assert.equal(stale.code, 1, stale.out);
    assert.match(stale.out, /sdk\/dist\/zenius\.mjs is missing or older than the sources, and there is no sdk\/node_modules to build it/);
    assert.ok(stale.out.includes(`run npm ci in ${root}/sdk`), stale.out);
    assert.equal(existsSync(join(home, "cli")), false);

    const now = new Date();
    utimesSync(join(root, "sdk/dist/zenius.mjs"), now, now);
    const fresh = install(home, [], { script: join(root, "scripts/install-cli.sh"), build: true });
    assert.equal(fresh.code, 0, fresh.out);
    assert.match(fresh.out, /^installed .*\/cli: zenius 9\.9\.9$/m);
    assert.equal(JSON.parse(readFileSync(join(home, "cli/install.json"), "utf8")).commit, "unknown");
  });

  it("--help prints the whole header comment", () => {
    const help = install(scratch("zenius-install-"), ["--help"]);
    assert.equal(help.code, 0, help.out);
    assert.match(help.out, /^Install the zenius CLI from this checkout/);
    assert.match(help.out, /ZENIUS_SKILL_DIRS \(space-separated\) override the target directories\.\n$/);
  });

  it("a dry run puts each change it would make on a line starting with 'would', and makes none", () => {
    const home = scratch("zenius-install-");
    const copy = join(home, "cli");
    const changes = (out: string) => out.trimEnd().split("\n").filter((line) => !/^(ok|skip|note|warning) /.test(line));

    const fresh = install(home, ["--skill", "--dry-run"]);
    assert.equal(fresh.code, 0, fresh.out);
    assert.deepEqual(readdirSync(home), [], fresh.out);
    const lines = changes(fresh.out);
    assert.ok(lines.every((line) => line.startsWith("would ")), fresh.out);
    assert.ok(lines.some((line) => line.startsWith(`would install ${copy}: zenius `)), fresh.out);
    for (const [link, target] of [
      ["bin/zenius", "sdk/bin/zenius"],
      ["claude/zenius", "skill/zenius"],
      ["agents/zenius", "skill/zenius"],
    ]) {
      assert.ok(lines.includes(`would link ${join(home, link)} -> ${join(copy, target)}`), fresh.out);
    }

    // A link an earlier install made into a checkout, and a copy to remove.
    assert.equal(install(home, ["--skill"]).code, 0);
    rmSync(join(home, "bin/zenius"));
    symlinkSync(join(REPO, "sdk/bin/zenius"), join(home, "bin/zenius"));
    const update = install(home, ["--skill", "--dry-run"]);
    assert.equal(update.code, 0, update.out);
    assert.ok(changes(update.out).every((line) => line.startsWith("would ")), update.out);
    assert.ok(
      changes(update.out).includes(`would update ${join(home, "bin/zenius")} -> ${join(copy, "sdk/bin/zenius")} (was ${join(REPO, "sdk/bin/zenius")})`),
      update.out,
    );
    assert.equal(readlinkSync(join(home, "bin/zenius")), join(REPO, "sdk/bin/zenius"));

    const uninstall = install(home, ["--uninstall", "--dry-run"]);
    assert.equal(uninstall.code, 0, uninstall.out);
    assert.deepEqual(uninstall.out.trimEnd().split("\n"), [
      `would remove ${join(home, "bin/zenius")}`,
      `would remove ${join(home, "claude/zenius")}`,
      `would remove ${join(home, "agents/zenius")}`,
      `would remove ${copy}`,
    ]);
    for (const path of ["bin/zenius", "claude/zenius", "agents/zenius", "cli/install.json"]) assert.ok(existsSync(join(home, path)), path);
  });

  it("builds on a Node that can't strip types, and a failed build stops it with the cause and the Node", () => {
    const root = checkoutCopy();
    const script = join(root, "scripts/install-cli.sh");
    const home = scratch("zenius-install-");
    // Like the Mac's PATH node, 23.5, for every node the script starts.
    const env = { NODE_OPTIONS: "--no-experimental-strip-types" };
    const built = install(home, [], { script, build: true, env });
    assert.equal(built.code, 0, built.out);
    assert.match(built.out, /^built {4}sdk\/dist\/zenius\.mjs$/m);
    assert.match(built.out, /^check {4}zenius \d+\.\d+\.\d+/m);

    // A guide over the length limit fails the build, which stops the install
    // although the bundle on disk is current.
    const guide = join(root, "skill/guide.md");
    writeFileSync(guide, `${readFileSync(guide, "utf8")}\n${"Far too long. ".repeat(500)}\n`);
    const failed = install(home, [], { script, build: true, env });
    assert.equal(failed.code, 1, failed.out);
    assert.match(failed.out, /^error {4}building sdk\/dist\/zenius\.mjs failed under Node v\d+\.\d+\.\d+ \(\/.+\):$/m);
    assert.match(failed.out, /^ {9}Error: the all-platform guide is \d+ characters; keep it under 25500$/m);
    assert.doesNotMatch(failed.out, /no sdk\/node_modules/);
    assert.ok(existsSync(join(home, "cli/install.json")), "the earlier copy stays");
  });
});

describe("scripts/install-cli.sh --working-dir", () => {
  it("sets the working folder in config.json, ~/zenius-files unless --working-dir says, makes it readable only by you, and later installs keep it", () => {
    const home = scratch("zenius-install-");
    const config = configOf(home);
    const files = join(home, "zenius-files");
    const first = install(home);
    assert.equal(first.code, 0, first.out);
    assert.ok(
      first.out.includes(`\nset      the working folder: ${files} (${config})\nmade     ${files}, the working folder, readable only by you\n`),
      first.out,
    );
    assert.equal(readFileSync(config, "utf8"), naming(files), "byte for byte, as the launcher and the runtime read it");
    assert.equal(modeOf(config), 0o600);
    assert.equal(modeOf(files), 0o700);
    assert.doesNotMatch(first.out, /^note +a running Zen/m, "a first install changes no folder a Zen could be using");
    writeFileSync(join(files, "report.pdf"), "a download");

    const again = install(home);
    assert.equal(again.code, 0, again.out);
    assert.ok(linesOf(again.out).includes(`ok       the working folder: ${files}`), again.out);
    assert.doesNotMatch(again.out, /^(set|made) /m);
    assert.equal(readFileSync(config, "utf8"), naming(files));

    // Another folder: set, and made. The files stay where they were.
    const work = join(home, "work");
    const moved = install(home, ["--working-dir", work]);
    assert.equal(moved.code, 0, moved.out);
    assert.ok(moved.out.includes(`\nset      the working folder: ${work} (${config})\nmade     ${work}, the working folder, readable only by you\n`), moved.out);
    // A Zen that's running read the old one at its start, and keeps it.
    assert.ok(
      linesOf(moved.out).includes(
        `note     a running Zen keeps the working folder it started with, ${files}, until its next start, so its downloads land there until then`,
      ),
      moved.out,
    );
    assert.equal(readFileSync(config, "utf8"), naming(work));
    assert.equal(modeOf(work), 0o700);
    assert.deepEqual(readdirSync(work), []);
    assert.equal(readFileSync(join(files, "report.pdf"), "utf8"), "a download", "changing it moves no files");
    const kept = install(home);
    assert.equal(kept.code, 0, kept.out);
    assert.ok(linesOf(kept.out).includes(`ok       the working folder: ${work}`), kept.out);
    assert.doesNotMatch(kept.out, /^note +a running Zen/m, "the same folder again changes nothing");
    assert.equal(readFileSync(config, "utf8"), naming(work));

    // A folder that's there keeps its mode and its files. The option's =
    // form, and a slash at the end, which config.json leaves off.
    const mine = join(home, "mine");
    mkdirSync(mine);
    chmodSync(mine, 0o750);
    writeFileSync(join(mine, "notes.txt"), "mine");
    const taken = install(home, [`--working-dir=${mine}/`]);
    assert.equal(taken.code, 0, taken.out);
    assert.ok(linesOf(taken.out).includes(`set      the working folder: ${mine} (${config})`), taken.out);
    assert.doesNotMatch(taken.out, /^made /m);
    assert.equal(readFileSync(config, "utf8"), naming(mine));
    assert.equal(modeOf(mine), 0o750);
    assert.deepEqual(readdirSync(mine), ["notes.txt"]);

    // A dry run says what it would set and make, and does neither.
    const other = join(home, "other");
    const dry = install(home, ["--dry-run", "--working-dir", other]);
    assert.equal(dry.code, 0, dry.out);
    assert.ok(dry.out.includes(`\nwould set the working folder: ${other} (${config})\nwould make ${other}, the working folder, readable only by you\n`), dry.out);
    assert.ok(!existsSync(other));
    assert.equal(readFileSync(config, "utf8"), naming(mine));

    // The folder config.json names is made again if it has gone.
    rmSync(mine, { recursive: true });
    const remade = install(home);
    assert.equal(remade.code, 0, remade.out);
    assert.ok(linesOf(remade.out).includes(`made     ${mine}, the working folder, readable only by you`), remade.out);
    assert.equal(modeOf(mine), 0o700);

    // --uninstall leaves the setting, and each folder with its files.
    const removed = install(home, ["--uninstall"]);
    assert.equal(removed.code, 0, removed.out);
    assert.doesNotMatch(removed.out, /working folder|config\.json/);
    assert.equal(readFileSync(config, "utf8"), naming(mine));
    for (const folder of [files, work, mine]) assert.ok(existsSync(folder), folder);
    assert.equal(readFileSync(join(files, "report.pdf"), "utf8"), "a download");
  });

  it("refuses each folder tests/fixtures/working-folder.json refuses, with the reason, and changes nothing", () => {
    const home = scratch("zenius-install-");
    const fill = caseFiller(home);
    const first = install(home, [], { env: caseEnv({}, fill) });
    assert.equal(first.code, 0, first.out);
    const config = join(home, ".zenius/config.json");
    const before = readFileSync(config, "utf8");
    const failed: string[] = [];
    let ran = 0;
    for (const c of CASES.filter((c) => c.outcome !== "allowed")) {
      makeEntries(c.make, fill);
      makeUnlistable(c.unlistable, fill);
      const folder = fill(c.folder);
      const there = lstatSync(folder, { throwIfNoEntry: false });
      const result = install(home, ["--working-dir", folder], { env: caseEnv(c, fill) });
      const want = `error    ${refusal(c, folder, fill)}\n`;
      const wrong: string[] = [];
      if (result.code !== 1 || !result.out.endsWith(want)) wrong.push(`exit ${result.code}, not 1 and ${JSON.stringify(want)}, after:\n${result.out}`);
      if (readFileSync(config, "utf8") !== before) {
        wrong.push("config.json changed");
        writeFileSync(config, before);
      }
      if (!there && lstatSync(folder, { throwIfNoEntry: false })) wrong.push("the folder was made");
      if (wrong.length) failed.push(`${c.name}: ${wrong.join("; ")}`);
      ran++;
    }
    assert.deepEqual(failed, []);
    assert.ok(ran >= 30, `${ran} cases`);
  });

  it("takes each folder tests/fixtures/working-folder.json allows: in a temporary folder, below a stray repository at its root, in a home kept in git, through a link, with any other characters", () => {
    for (const c of CASES.filter((c) => c.outcome === "allowed")) {
      const home = scratch("zenius-install-");
      const fill = caseFiller(home);
      makeEntries(c.make, fill);
      makeUnlistable(c.unlistable, fill);
      const folder = fill(c.folder);
      const env = caseEnv(c, fill);
      const there = lstatSync(folder, { throwIfNoEntry: false });
      const result = install(home, ["--working-dir", folder], { env });
      assert.equal(result.code, 0, `${c.name}: ${result.out}`);
      assert.equal(readFileSync(join(env.ZENIUS_HOME!, "config.json"), "utf8"), naming(folder), c.name);
      assert.ok(existsSync(folder), c.name);
      if (!there) assert.equal(modeOf(folder), 0o700, `${c.name}: made readable only by you`);
    }
  });

  it("stops with the reason at a config.json edited so it doesn't name the folder as the installers write it, never falling back to ~/zenius-files, and --working-dir writes it again", () => {
    const home = scratch("zenius-install-");
    const work = join(home, "work");
    assert.equal(install(home, ["--working-dir", work]).code, 0);
    const config = configOf(home);
    const files = join(home, "zenius-files");
    const reason = `error    ${config} doesn't name the working folder on a line of its own, as the installer writes it: pass --working-dir <folder> to write it again\n`;
    for (const c of FIXTURE.configs.unreadable) {
      const text = configText(c, work);
      writeFileSync(config, text);
      for (const args of [[], ["--dry-run"]]) {
        const result = install(home, args);
        assert.equal(result.code, 1, `${c.name}: ${result.out}`);
        assert.ok(result.out.endsWith(reason), `${c.name}: ${result.out}`);
      }
      assert.equal(readFileSync(config, "utf8"), text, `${c.name}: config.json is as it was`);
      assert.ok(!existsSync(files), `${c.name}: no ~/zenius-files`);
    }
    for (const c of FIXTURE.configs.readable) {
      writeFileSync(config, configText(c, work));
      const result = install(home);
      assert.equal(result.code, 0, `${c.name}: ${result.out}`);
      assert.equal(readFileSync(config, "utf8"), naming(work), `${c.name}: written whole again, as the installers write it`);
    }

    // A folder no install would take stops it the same way.
    writeFileSync(config, naming(home));
    const wide = install(home);
    assert.equal(wide.code, 1, wide.out);
    assert.ok(wide.out.endsWith(`error    the working folder can't be ${home}: it's your home folder, a temporary folder, or a folder above one\n`), wide.out);
    assert.equal(readFileSync(config, "utf8"), naming(home));

    // --working-dir writes it again, whatever it held.
    writeFileSync(config, configText(FIXTURE.configs.unreadable[0]!, work));
    const fixed = install(home, ["--working-dir", work]);
    assert.equal(fixed.code, 0, fixed.out);
    assert.ok(linesOf(fixed.out).includes(`set      the working folder: ${work} (${config})`), fixed.out);
    assert.equal(readFileSync(config, "utf8"), naming(work));
    assert.ok(!existsSync(files));
  });

  it("with ZENIUS_HOME anywhere but ~/.zenius there's no default working folder: an install without --working-dir stops and makes nothing, and one with it installs", () => {
    const home = scratch("zenius-install-");
    const env = { ZENIUS_HOME: join(home, "zhome") };
    const none = `error    there's no default working folder: ZENIUS_HOME is ${env.ZENIUS_HOME}, not ~/.zenius, and it holds no config.json: pass --working-dir <folder>\n`;
    for (const args of [[], ["--dry-run"], ["--sandbox"]]) {
      const result = install(home, args, { env });
      assert.equal(result.code, 2, `${args.join(" ")}: ${result.out}`);
      assert.ok(result.out.endsWith(none), `${args.join(" ")}: ${result.out}`);
      assert.deepEqual(readdirSync(home), [], `${args.join(" ")}: no copy, no config.json, no ~/zenius-files`);
    }
    const work = join(home, "work");
    const given = install(home, ["--working-dir", work], { env });
    assert.equal(given.code, 0, given.out);
    assert.equal(readFileSync(join(home, "zhome/config.json"), "utf8"), naming(work));
    // Once config.json there names a folder, a later install keeps it.
    const kept = install(home, [], { env });
    assert.equal(kept.code, 0, kept.out);
    assert.ok(linesOf(kept.out).includes(`ok       the working folder: ${work}`), kept.out);
    assert.ok(!existsSync(join(home, "zenius-files")), "never ~/zenius-files");

    // A ZENIUS_HOME that is ~/.zenius through a link is ~/.zenius.
    const linked = scratch("zenius-install-");
    mkdirSync(join(linked, "elsewhere"));
    symlinkSync(join(linked, "elsewhere"), join(linked, ".zenius"));
    const same = install(linked, [], { env: { ZENIUS_HOME: join(linked, "elsewhere") } });
    assert.equal(same.code, 0, same.out);
    assert.equal(readFileSync(join(linked, "elsewhere/config.json"), "utf8"), naming(join(linked, "zenius-files")));
  });

  it("--working-dir takes an absolute path, and --output-dir is gone: either stops at once and changes nothing", () => {
    const home = scratch("zenius-install-");
    const absolute = "install-cli.sh: --working-dir takes an absolute path\n";
    const gone = "install-cli.sh: --output-dir is gone: scripts write their files in the working folder, which --working-dir sets (~/zenius-files by default)\n";
    for (const [args, message] of [
      [["--working-dir", "zenius-files"], absolute],
      [["--working-dir", "~/zenius-files"], absolute],
      [["--working-dir=zenius-files"], absolute],
      [["--working-dir"], absolute],
      [["--output-dir", join(home, "out")], gone],
      [[`--output-dir=${join(home, "out")}`], gone],
      [["--sandbox", "--output-dir", join(home, "out")], gone],
      [["--output-dir"], gone],
    ] as const) {
      const result = install(home, [...args]);
      assert.equal(result.code, 2, `${args.join(" ")}: ${result.out}`);
      assert.equal(result.out, message, args.join(" "));
      assert.deepEqual(readdirSync(home), [], args.join(" "));
    }
  });
});

describe("scripts/install-cli.sh --sandbox", () => {
  const linux = process.platform === "linux";
  const supported = linux
    ? spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "true"]).status === 0
    : process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
  const skip = supported ? false : "needs bubblewrap that works here, or macOS's sandbox-exec";
  // The registry, the working folder and the sandbox's temporary folder live
  // in the scratch home too, for the launcher's runs as for the installs.
  const sandboxEnv = (home: string) => ({ HOME: home, ZENIUS_HOME: join(home, ".zenius"), TMPDIR: home });

  it("a dry run prints the launcher with this machine's paths, and writes nothing", { skip }, () => {
    const home = scratch("zenius-install-");
    const real = realpathSync(home);
    const result = install(home, ["--sandbox", "--dry-run"], { env: sandboxEnv(home) });
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(readdirSync(home), [], result.out);
    assert.ok(result.out.includes(`\nwould write ${join(home, "bin/zenius")}: the sandboxed launcher\n    #!/bin/sh -p\n`), result.out);
    assert.match(result.out, /^ {4}# zenius, sandboxed \(zenius-sandbox-launcher 1\)\./m);
    for (const line of [`CLI='${join(real, "cli")}'`, `ZHOME='${join(real, ".zenius")}'`, `BIN_DIR='${join(real, "bin")}'`]) {
      assert.ok(result.out.includes(`\n    ${line}\n`), `${line} in:\n${result.out}`);
    }
    // The launcher reads the working folder from config.json at each start;
    // runs' output folders are gone.
    assert.doesNotMatch(result.out, /OUT_ROOT/);
    // The PATH's node as found, links kept, and the major each start checks.
    const found = spawnSync("bash", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim();
    assert.ok(result.out.includes(`\n    NODE='${found}'\n    NODE_MAJOR=24\n`), `NODE='${found}' in:\n${result.out}`);
    assert.doesNotMatch(result.out, /@[A-Z_]+@/, "every placeholder is filled in");
    if (!linux) assert.ok(result.out.includes(`\nwould install ${join(home, "cli")}/sdk/sandbox/zenius.sb, the launcher's sandbox-exec profile:\n    (version 1)\n`), result.out);
  });

  it("writes the launcher as bin/zenius itself; later installs keep it, --no-sandbox links it again, and --uninstall removes it", { skip }, () => {
    const home = scratch("zenius-install-");
    const env = sandboxEnv(home);
    const bin = join(home, "bin/zenius");
    const first = install(home, ["--sandbox"], { env });
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, new RegExp(`^wrote {4}${bin}: the sandboxed launcher$`, "m"));
    const stat = lstatSync(bin);
    assert.ok(stat.isFile(), "a file, not a link");
    assert.equal(stat.mode & 0o777, 0o755);
    assert.match(readFileSync(bin, "utf8").split("\n")[1]!, /\(zenius-sandbox-launcher 1\)/);
    assert.ok(existsSync(join(home, "cli/sdk/sandbox/zenius.sb")), "the copy carries the macOS profile");
    // install-cli.sh's own check runs the CLI through the launcher.
    assert.match(first.out, /^check {4}zenius \d+\.\d+\.\d+ \(protocol 1, sandboxed\)$/m);

    const again = install(home, ["--sandbox"], { env });
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, new RegExp(`^ok {7}${bin}: the sandboxed launcher$`, "m"));
    assert.doesNotMatch(again.out, /keeps it/, "--sandbox needs no note");

    // An update without --sandbox keeps the sandbox, and says so first.
    const keeps = `note     ${bin} is the sandboxed launcher, and this install keeps it (--no-sandbox makes it a link again)\n`;
    const plainDry = install(home, ["--dry-run"], { env });
    assert.equal(plainDry.code, 0, plainDry.out);
    assert.ok(plainDry.out.startsWith(keeps), plainDry.out);
    assert.match(plainDry.out, new RegExp(`^ok {7}${bin}: the sandboxed launcher$`, "m"));
    const plain = install(home, [], { env });
    assert.equal(plain.code, 0, plain.out);
    assert.ok(plain.out.startsWith(keeps), plain.out);
    assert.ok(lstatSync(bin).isFile(), "still the launcher");
    assert.match(plain.out, /^check {4}zenius \d+\.\d+\.\d+ \(protocol 1, sandboxed\)$/m);

    const unsandboxed = install(home, ["--no-sandbox"], { env });
    assert.equal(unsandboxed.code, 0, unsandboxed.out);
    assert.equal(readlinkSync(bin), join(home, "cli/sdk/bin/zenius"));
    assert.match(unsandboxed.out, new RegExp(`^updated  ${bin} -> ${join(home, "cli/sdk/bin/zenius")} \\(was the sandboxed launcher\\)$`, "m"));
    assert.match(unsandboxed.out, /^check {4}zenius \d+\.\d+\.\d+ \(protocol 1\)$/m);
    const linked = install(home, [], { env });
    assert.equal(linked.code, 0, linked.out);
    assert.equal(readlinkSync(bin), join(home, "cli/sdk/bin/zenius"), "a link stays a link");
    assert.doesNotMatch(linked.out, /sandboxed launcher/, linked.out);

    assert.equal(install(home, ["--sandbox"], { env }).code, 0);
    const dry = install(home, ["--uninstall", "--dry-run"], { env });
    assert.ok(dry.out.startsWith(`would remove ${bin} (the sandboxed launcher)\n`), dry.out);
    assert.ok(existsSync(bin));
    const removed = install(home, ["--uninstall"], { env });
    assert.equal(removed.code, 0, removed.out);
    assert.ok(removed.out.startsWith(`removed  ${bin} (the sandboxed launcher)\n`), removed.out);
    assert.ok(!existsSync(bin));
  });

  it("leaves a bin/zenius it didn't write alone, installing and uninstalling", { skip }, () => {
    const home = scratch("zenius-install-");
    const env = sandboxEnv(home);
    const bin = join(home, "bin/zenius");
    // The marker counts only on line 2, where the launcher has it.
    const MINE = "#!/bin/sh\n# mine\n# (zenius-sandbox-launcher 1)\necho mine\n";
    mkdirSync(join(home, "bin"));
    writeFileSync(bin, MINE, { mode: 0o755 });
    const result = install(home, ["--sandbox"], { env });
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, new RegExp(`^skip {5}${bin} exists and isn't a zenius link or launcher; left alone$`, "m"));
    const removed = install(home, ["--uninstall"], { env });
    assert.match(removed.out, new RegExp(`^skip {5}${bin} isn't a link to `, "m"));
    assert.equal(readFileSync(bin, "utf8"), MINE);
  });

  it("the launcher keeps no output folders: at each start it takes the working folder config.json names, and makes it if it has gone", { skip }, () => {
    const home = scratch("zenius-install-");
    const env = sandboxEnv(home);
    const bin = join(home, "bin/zenius");
    const files = join(home, "zenius-files");
    const first = install(home, ["--sandbox"], { env });
    assert.equal(first.code, 0, first.out);
    const text = readFileSync(bin, "utf8");
    assert.doesNotMatch(text, /^OUT_ROOT=/m);
    const version = () => spawnSync(bin, ["--version"], { encoding: "utf8", cwd: home, env: scratchEnv(home, env) });

    rmSync(files, { recursive: true });
    const remade = version();
    assert.equal(remade.status, 0, remade.stderr);
    assert.equal(modeOf(files), 0o700, "made again, readable only by you");

    // Another folder, set without --sandbox: the launcher stays as it was,
    // and takes the new folder at its next start.
    const work = join(home, "work");
    const moved = install(home, ["--working-dir", work], { env });
    assert.equal(moved.code, 0, moved.out);
    assert.ok(linesOf(moved.out).includes(`ok       ${bin}: the sandboxed launcher`), moved.out);
    assert.equal(readFileSync(bin, "utf8"), text);
    rmSync(work, { recursive: true });
    const next = version();
    assert.equal(next.status, 0, next.stderr);
    assert.equal(modeOf(work), 0o700, "the launcher made the folder config.json names now");
  });

  it("an update from a launcher with runs' output folders says once that scripts now write in the working folder, and leaves those folders alone", { skip }, () => {
    const home = scratch("zenius-install-");
    const env = sandboxEnv(home);
    const bin = join(home, "bin/zenius");
    assert.equal(install(home, ["--sandbox"], { env }).code, 0);
    const text = readFileSync(bin, "utf8");
    const outputs = join(home, "outputs");
    mkdirSync(join(outputs, "project-1/run.abcdef"), { recursive: true });
    writeFileSync(join(outputs, "project-1/run.abcdef/shot.png"), "an earlier run's");
    // An earlier launcher: this one with OUT_ROOT, as --output-dir set it.
    writeFileSync(bin, text.replace(/^READ_DIR=/m, `OUT_ROOT='${outputs}'\nREAD_DIR=`), { mode: 0o755 });
    const note = `note     scripts now write in the working folder, ${join(home, "zenius-files")}, not in runs' output folders: ${outputs} keeps earlier runs' files, which zenius no longer uses`;

    const update = install(home, [], { env });
    assert.equal(update.code, 0, update.out);
    assert.deepEqual(update.out.match(/^note .*output folders.*$/gm), [note], update.out);
    assert.equal(readFileSync(bin, "utf8"), text, "the launcher is written again, without them");
    assert.equal(readFileSync(join(outputs, "project-1/run.abcdef/shot.png"), "utf8"), "an earlier run's");
    const next = install(home, [], { env });
    assert.equal(next.code, 0, next.out);
    assert.doesNotMatch(next.out, /output folders/);
  });

  // --read-dir: one more folder scripts may read, such as ~/Downloads, for uploads.
  it("lets scripts read the folder --read-dir names, keeps it, drops it with none, and refuses one wider than a task's", { skip }, () => {
    const home = scratch("zenius-install-");
    const real = realpathSync(home);
    const env = sandboxEnv(home);
    const bin = join(home, "bin/zenius");
    const readDir = () => /^READ_DIR=(.*)$/m.exec(readFileSync(bin, "utf8"))?.[1];
    const downloads = join(home, "Downloads");
    mkdirSync(downloads);
    mkdirSync(join(home, ".ssh"));

    const fresh = install(home, ["--sandbox"], { env });
    assert.equal(fresh.code, 0, fresh.out);
    assert.equal(readDir(), "''", "none unless asked");
    mkdirSync(join(home, "zenius-files/uploads"));
    const first = install(home, ["--sandbox", "--read-dir", downloads], { env });
    assert.equal(first.code, 0, first.out);
    assert.equal(readDir(), `'${downloads}'`, "the path as given, which the launcher resolves at each start");
    assert.match(first.out, /^check {4}zenius \d+\.\d+\.\d+ \(protocol 1, sandboxed\)$/m);
    const kept = install(home, [], { env });
    assert.equal(kept.code, 0, kept.out);
    assert.equal(readDir(), `'${downloads}'`, "a later install keeps it");
    const dropped = install(home, ["--sandbox", "--read-dir", "none"], { env });
    assert.equal(dropped.code, 0, dropped.out);
    assert.equal(readDir(), "''");

    for (const [args, message, extra] of [
      [["--sandbox", "--read-dir", "Downloads"], "install-cli.sh: --read-dir takes an absolute path, or none\n", {}],
      [["--sandbox", "--read-dir"], "install-cli.sh: --read-dir takes an absolute path, or none\n", {}],
      [["--no-sandbox", "--read-dir", downloads], "install-cli.sh: --read-dir goes with --sandbox\n", {}],
      [["--sandbox", "--read-dir", join(home, "gone")], `error    --sandbox: --read-dir must be a folder that exists: ${join(home, "gone")}\n`, {}],
      [["--sandbox", "--read-dir", home], `error    --sandbox: --read-dir can't be your home folder, a temporary folder or above one: ${real}\n`, { HOME: home }],
      [["--sandbox", "--read-dir", "/tmp"], `error    --sandbox: --read-dir can't be your home folder, a temporary folder or above one: ${realpathSync("/tmp")}\n`, {}],
      [
        ["--sandbox", "--read-dir", join(home, ".ssh")],
        `error    --sandbox: --read-dir can't hold or be inside zenius, its node, Zen's profiles, or a folder of settings or credentials: ${join(real, ".ssh")}\n`,
        { HOME: home },
      ],
      [
        ["--sandbox", "--read-dir", join(home, ".zenius")],
        `error    --sandbox: --read-dir can't hold or be inside zenius, its node, Zen's profiles, or a folder of settings or credentials: ${join(real, ".zenius")}\n`,
        {},
      ],
      [
        ["--sandbox", "--read-dir", join(home, "zenius-files")],
        `error    --sandbox: --read-dir can't be the working folder or inside it, where scripts read and write already: ${join(real, "zenius-files")}\n`,
        {},
      ],
      [
        ["--sandbox", "--read-dir", join(home, "zenius-files/uploads")],
        `error    --sandbox: --read-dir can't be the working folder or inside it, where scripts read and write already: ${join(real, "zenius-files/uploads")}\n`,
        {},
      ],
    ] as const) {
      const result = install(home, [...args], { env: { ...env, ...extra } });
      assert.equal(result.code, message.startsWith("error") ? 1 : 2, result.out);
      assert.ok(result.out.endsWith(message), result.out);
      assert.equal(readDir(), "''", `${args.join(" ")}: the launcher is as it was`);
    }
  });

  it("refuses --sandbox with --no-sandbox", () => {
    const home = scratch("zenius-install-");
    const result = install(home, ["--sandbox", "--no-sandbox"]);
    assert.equal(result.code, 2, result.out);
    assert.equal(result.out, "install-cli.sh: --sandbox and --no-sandbox can't go together\n");
    assert.deepEqual(readdirSync(home), []);
  });

  it("an install without --sandbox fails rather than drop a sandbox it can't keep", { skip: linux ? skip : "Linux only" }, () => {
    const home = scratch("zenius-install-");
    const env = sandboxEnv(home);
    const bin = join(home, "bin/zenius");
    assert.equal(install(home, ["--sandbox"], { env }).code, 0);
    const launcher = readFileSync(bin, "utf8");
    const installed = readFileSync(join(home, "cli/install.json"), "utf8");
    const tools = join(home, "tools");
    mkdirSync(tools);
    writeFileSync(join(tools, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const result = install(home, [], { env: { ...env, PATH: `${tools}:${process.env.PATH}` } });
    assert.equal(result.code, 1, result.out);
    assert.ok(result.out.startsWith(`note     ${bin} is the sandboxed launcher, and this install keeps it`), result.out);
    assert.ok(result.out.includes(`error    --sandbox: ${join(tools, "bwrap")} can't make a sandbox here`), result.out);
    assert.equal(readFileSync(bin, "utf8"), launcher, "the launcher stays as it was");
    assert.equal(readFileSync(join(home, "cli/install.json"), "utf8"), installed, "so does the copy");
  });

  it("needs Node 24 first on PATH, and installs nothing on another", { skip }, () => {
    const home = scratch("zenius-install-");
    const tools = join(home, "tools");
    mkdirSync(tools);
    // A node that says it's 23.5, as Homebrew's default node on the Mac does.
    writeFileSync(join(tools, "node"), `#!/bin/sh\n[ "$*" = "-p process.versions.node" ] && { echo 23.5.0; exit 0; }\nexec ${process.execPath} "$@"\n`, { mode: 0o755 });
    const result = install(home, ["--sandbox"], { env: { ...sandboxEnv(home), PATH: `${tools}:${process.env.PATH}` } });
    assert.equal(result.code, 1, result.out);
    assert.ok(
      result.out.includes(`error    --sandbox: it needs Node 24 first on PATH, and found 23.5.0 (${join(tools, "node")}); Homebrew's Node 24 is in /opt/homebrew/opt/node@24/bin\n`),
      result.out,
    );
    assert.deepEqual(readdirSync(home), ["tools"]);
  });

  it("runs its node by the link it was found through, so an upgrade that moves the link keeps it working", { skip }, () => {
    const home = scratch("zenius-install-");
    const env = sandboxEnv(home);
    const real = realpathSync(process.execPath);
    // Homebrew's layout: opt/node@24 links to the version's folder in the Cellar.
    mkdirSync(join(home, "opt"));
    symlinkSync(dirname(dirname(real)), join(home, "opt/node@24"));
    const pinned = join(home, "opt/node@24/bin/node");
    const result = install(home, ["--sandbox"], { env: { ...env, PATH: `${dirname(pinned)}:${process.env.PATH}` } });
    assert.equal(result.code, 0, result.out);
    const bin = join(home, "bin/zenius");
    assert.ok(readFileSync(bin, "utf8").includes(`\nNODE='${pinned}'\n`), "pinned by the link");
    const version = () => spawnSync(bin, ["--version"], { encoding: "utf8", cwd: home, env: scratchEnv(home, env) });

    // The upgrade: the link moves to a new version's folder (here, one whose
    // bin/node links to the same node).
    mkdirSync(join(home, "Cellar/24.99.0/bin"), { recursive: true });
    symlinkSync(real, join(home, "Cellar/24.99.0/bin/node"));
    rmSync(join(home, "opt/node@24"));
    symlinkSync(join(home, "Cellar/24.99.0"), join(home, "opt/node@24"));
    const upgraded = version();
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.match(upgraded.stdout, /^zenius \d+\.\d+\.\d+ \(protocol 1, sandboxed\)$/m);

    rmSync(join(home, "opt/node@24"));
    const gone = version();
    assert.equal(gone.status, 70, gone.stderr);
    assert.equal(gone.stderr, `zenius (sandboxed): the node it was installed with is gone (${pinned}): reinstall with scripts/install-cli.sh --sandbox\n`);
  });

  it("installs nothing when bubblewrap can't make a sandbox", { skip: linux ? false : "Linux only" }, () => {
    const home = scratch("zenius-install-");
    const tools = join(home, "tools");
    mkdirSync(tools);
    // A bwrap that fails, as one does where unprivileged user namespaces are off.
    writeFileSync(join(tools, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const result = install(home, ["--sandbox"], { env: { ...sandboxEnv(home), PATH: `${tools}:${process.env.PATH}` } });
    assert.equal(result.code, 1, result.out);
    assert.ok(result.out.includes(`error    --sandbox: ${join(tools, "bwrap")} can't make a sandbox here (are unprivileged user namespaces off?)`), result.out);
    assert.deepEqual(readdirSync(home), ["tools"]);
  });
});

describe("bin/zenius", () => {
  /** A checkout (with sources) or an installed copy (without), with stub entry points. */
  function layout(withSources: boolean): string {
    const root = scratch("zenius-launcher-");
    mkdirSync(join(root, "sdk/bin"), { recursive: true });
    cpSync(LAUNCHER, join(root, "sdk/bin/zenius"));
    writeFileSync(join(root, "sdk/package.json"), '{ "type": "module" }\n');
    mkdirSync(join(root, "sdk/dist"));
    writeFileSync(join(root, "sdk/dist/zenius.mjs"), 'export async function main() { console.log("bundle"); return 0; }\n');
    if (withSources) {
      mkdirSync(join(root, "sdk/src/learning"), { recursive: true });
      writeFileSync(join(root, "sdk/src/cli.ts"), 'export async function main(_argv: string[]): Promise<number> { console.log("sources"); return 0; }\n');
      mkdirSync(join(root, "skill"));
      writeFileSync(join(root, "skill/guide.md"), "guide\n");
    }
    return root;
  }
  const age = (root: string, path: string, seconds: number) => {
    const time = new Date(Date.now() - seconds * 1000);
    utimesSync(join(root, path), time, time);
  };
  const sources = ["sdk/src/cli.ts", "sdk/src/learning", "sdk/src", "skill/guide.md"];
  const run = (root: string, typescript = true) =>
    spawnSync(process.execPath, [...(typescript ? [] : ["--no-experimental-strip-types"]), join(root, "sdk/bin/zenius")], {
      encoding: "utf8",
      env: scratchEnv(root),
    });

  it("stops before the bundle when its node isn't the major the sandboxed launcher names", () => {
    const root = layout(false);
    const major = process.versions.node.split(".")[0]!;
    const other = String(Number(major) + 1);
    const start = (wanted: string) =>
      spawnSync(process.execPath, [join(root, "sdk/bin/zenius")], { encoding: "utf8", env: scratchEnv(root, { ZENIUS_NODE_MAJOR: wanted }) });
    const refused = start(other);
    assert.equal(refused.status, 70);
    assert.equal(refused.stdout, "");
    assert.equal(
      refused.stderr,
      `zenius (sandboxed): the sandbox needs Node ${other}, and its node (${process.execPath}) is now Node ${process.versions.node}: ` +
        "reinstall with scripts/install-cli.sh --sandbox\n",
    );
    assert.equal(start(major).stdout, "bundle\n");
  });

  it("in a checkout runs the bundle while it's current, and the sources once they are newer", () => {
    const root = layout(true);
    for (const path of sources) age(root, path, 60);
    assert.equal(run(root).stdout, "bundle\n");
    age(root, "sdk/dist/zenius.mjs", 120);
    assert.equal(run(root).stdout, "sources\n");
  });

  it("in a checkout, on a Node that can't run TypeScript, says what to do instead of failing to load", () => {
    const root = layout(true);
    for (const path of sources) age(root, path, 60);
    age(root, "sdk/dist/zenius.mjs", 120);
    const result = run(root, false);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /bundle \(sdk\/dist\/zenius\.mjs\) is missing or older than its sources, and Node [\d.]+ can't run TypeScript sources/);
    // By its real path: Node runs the launcher from there, and on macOS the temp folder is a link.
    assert.ok(result.stderr.includes(`Run \`npm run build\` in ${realpathSync(root)}/sdk`), result.stderr);
    assert.doesNotMatch(result.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
  });

  it("an installed copy runs its bundle, however old, on any Node", () => {
    const root = layout(false);
    age(root, "sdk/dist/zenius.mjs", 3600);
    const result = run(root, false);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "bundle\n");
  });

  it("checks every source directory when deciding whether the bundle is current", () => {
    const launcher = readFileSync(LAUNCHER, "utf8");
    const src = join(REPO, "sdk/src");
    const dirs = ["", ...readdirSync(src, { recursive: true, encoding: "utf8" }).filter((entry) => lstatSync(join(src, entry)).isDirectory())];
    for (const dir of dirs) assert.ok(launcher.includes(`"../src/${dir ? `${dir}/` : ""}"`), `bin/zenius checks src/${dir}`);
    assert.ok(launcher.includes('"../../skill/guide.md"'));
  });
});
