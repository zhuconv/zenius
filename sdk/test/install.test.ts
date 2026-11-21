// scripts/install-cli.sh, run against temporary directories, and how
// bin/zenius picks the bundle or the sources.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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

const REPO = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const SCRIPT = join(REPO, "scripts/install-cli.sh");
const LAUNCHER = join(REPO, "sdk/bin/zenius");

const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function install(home: string, args: string[] = [], options: { script?: string; build?: boolean; env?: Record<string, string> } = {}) {
  const result = spawnSync("bash", [options.script ?? SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ZENIUS_CLI_DIR: join(home, "cli"),
      ZENIUS_BIN_DIR: join(home, "bin"),
      ZENIUS_SKILL_DIRS: `${join(home, "claude")} ${join(home, "agents")}`,
      // The SDK suites run dist/; rebuilding it here would race them.
      ...(options.build ? {} : { ZENIUS_INSTALL_NO_BUILD: "1" }),
      ...options.env,
    },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** The CLI's part of this checkout, copied, with its node_modules linked in to build with. */
function checkoutCopy(): string {
  const root = scratch("zenius-checkout-");
  for (const path of [
    "scripts/install-cli.sh",
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

/** Node with its TypeScript support off, as Node 23.0-23.5 and 22.6-22.17 run by default. */
function withoutTypeScript(file: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["--no-experimental-strip-types", file, ...args], {
    encoding: "utf8",
    // zenius doctor reads only these, and finds nothing there.
    env: { ...process.env, ZENIUS_HOME: join(dirname(file), "zhome"), ZEN_BIN: "", ZENIUS_SOCKET: "" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

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
    assert.equal(again.out.match(/^ok /gm)?.length, 3);
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
    assert.match(failed.out, /^ {9}Error: the all-platform guide is \d+ characters; keep it under 25000$/m);
    assert.doesNotMatch(failed.out, /no sdk\/node_modules/);
    assert.ok(existsSync(join(home, "cli/install.json")), "the earlier copy stays");
  });
});

describe("scripts/install-cli.sh --sandbox", () => {
  const linux = process.platform === "linux";
  const supported = linux
    ? spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "true"]).status === 0
    : process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
  const skip = supported ? false : "needs bubblewrap that works here, or macOS's sandbox-exec";
  // The registry and the sandbox's temporary folder live in the scratch home too.
  const sandboxEnv = (home: string) => ({ ZENIUS_HOME: join(home, "zhome"), TMPDIR: home });

  it("a dry run prints the launcher with this machine's paths, and writes nothing", { skip }, () => {
    const home = scratch("zenius-install-");
    const real = realpathSync(home);
    const result = install(home, ["--sandbox", "--dry-run"], { env: sandboxEnv(home) });
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(readdirSync(home), [], result.out);
    assert.ok(result.out.includes(`\nwould write ${join(home, "bin/zenius")}: the sandboxed launcher\n    #!/bin/sh -p\n`), result.out);
    assert.match(result.out, /^ {4}# zenius, sandboxed \(zenius-sandbox-launcher 1\)\./m);
    for (const line of [`CLI='${join(real, "cli")}'`, `ZHOME='${join(real, "zhome")}'`, `BIN_DIR='${join(real, "bin")}'`, `OUT_ROOT='${join(real, "zhome/out")}'`]) {
      assert.ok(result.out.includes(`\n    ${line}\n`), `${line} in:\n${result.out}`);
    }
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

  it("puts runs' output folders where --output-dir says, keeps that, and never in the working folder", { skip }, () => {
    const home = scratch("zenius-install-");
    const real = realpathSync(home);
    const env = sandboxEnv(home);
    const bin = join(home, "bin/zenius");
    const outRoot = (text: string) => /^OUT_ROOT=(.*)$/m.exec(text)?.[1];
    assert.equal(install(home, ["--sandbox", "--output-dir", join(home, "outputs")], { env }).code, 0);
    assert.equal(outRoot(readFileSync(bin, "utf8")), `'${join(real, "outputs")}'`);
    const kept = install(home, [], { env });
    assert.equal(kept.code, 0, kept.out);
    assert.equal(outRoot(readFileSync(bin, "utf8")), `'${join(real, "outputs")}'`, "a later install keeps it");

    // Each start makes the run's folder: <root>/<working folder's name>-<cksum of its path>/run.XXXXXX.
    const work = join(home, "project");
    mkdirSync(work);
    const version = (cwd: string) => spawnSync(bin, ["--version"], { encoding: "utf8", cwd, env: { ...process.env, ...env } });
    assert.equal(version(work).status, 0);
    const sum = spawnSync("sh", ["-c", 'printf %s "$1" | cksum', "-", realpathSync(work)], { encoding: "utf8" }).stdout.split(" ")[0];
    const runs = readdirSync(join(home, "outputs", `project-${sum}`));
    assert.equal(runs.length, 1);
    assert.match(runs[0]!, /^run\.[A-Za-z0-9]{6}$/);

    // An output folder inside the working folder is refused outright.
    assert.equal(install(home, ["--sandbox", "--output-dir", join(work, "out")], { env }).code, 0);
    const inside = version(work);
    assert.equal(inside.status, 70);
    assert.match(inside.stderr, /^zenius \(sandboxed\): the output folder \(.*\/project\/out\) is inside the working folder, where a script must not write: /);
    // (install-cli.sh's own --version check, run elsewhere, made the root.)
    assert.ok(!existsSync(join(work, "out", `project-${sum}`)), "the refused run made no folder in the working folder");

    for (const [args, message, extra] of [
      [["--sandbox", "--output-dir", "outputs"], "install-cli.sh: --output-dir takes an absolute path\n", {}],
      [["--sandbox", "--output-dir"], "install-cli.sh: --output-dir takes an absolute path\n", {}],
      [["--no-sandbox", "--output-dir", join(home, "o")], "install-cli.sh: --output-dir goes with --sandbox\n", {}],
      [["--sandbox", "--output-dir", home], `error    --sandbox: --output-dir can't be your home folder or above it: ${real}\n`, { HOME: home }],
      [["--sandbox", "--output-dir", join(home, "cli/out")], `error    --sandbox: --output-dir can't be inside the CLI copy or ${join(home, "bin")}: ${join(real, "cli/out")}\n`, {}],
    ] as const) {
      const result = install(home, [...args], { env: { ...env, ...extra } });
      assert.equal(result.code, message.startsWith("error") ? 1 : 2, result.out);
      assert.ok(result.out.endsWith(message), result.out);
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
    const version = () => spawnSync(bin, ["--version"], { encoding: "utf8", cwd: home, env: { ...process.env, ...env } });

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
    spawnSync(process.execPath, [...(typescript ? [] : ["--no-experimental-strip-types"]), join(root, "sdk/bin/zenius")], { encoding: "utf8" });

  it("stops before the bundle when its node isn't the major the sandboxed launcher names", () => {
    const root = layout(false);
    const major = process.versions.node.split(".")[0]!;
    const other = String(Number(major) + 1);
    const start = (wanted: string) =>
      spawnSync(process.execPath, [join(root, "sdk/bin/zenius")], { encoding: "utf8", env: { ...process.env, ZENIUS_NODE_MAJOR: wanted } });
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
