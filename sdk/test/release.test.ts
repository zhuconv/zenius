// scripts/release.sh, and the one-command installer it builds from
// scripts/release-install.sh, run offline: the package is built from HEAD,
// with a movie attached, then installed from a file:// URL into a fake HOME,
// with a fake Zen app folder and profile. Nothing reaches the network or the
// real ~/.zenius.
// The package holds HEAD's files (git archive), not the working tree's:
// commit a change to the scripts before running this.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const REPO = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const VENDOR = join(REPO, "runtime/vendor/fx-autoconfig");
// curl, tar, sha256sum and git from the system; node from this test's own.
const PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const MAC = process.platform === "darwin";

const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function run(command: string, args: string[], env: Record<string, string | undefined> = {}, cwd = REPO) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, PATH, ...env } });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const version = JSON.parse(readFileSync(join(REPO, "sdk/package.json"), "utf8")).version as string;
const name = `zenius-${version}`;
// What the installers record from RELEASE, as from a checkout: git's short hash.
const short = run("git", ["rev-parse", "--short", "HEAD"]).out.trim();
// Only the private repo this one was exported from has commits with docs/MANAGER.md; this repo has none.
const PRIVATE = existsSync(join(REPO, "docs/MANAGER.md"));

/** Where the sidebar reads its agents: AgentService's DEFAULT_CONFIG under the home folder. The installer's check must look in the same place, so the tests put config.json there. */
const sidebarConfig = (home: string) => {
  const parts = readFileSync(join(REPO, "runtime/JS/agent-sidebar/AgentService.sys.mjs"), "utf8").match(/^const DEFAULT_CONFIG = (\[.*\]);$/m)?.[1];
  assert.ok(parts, "AgentService.sys.mjs has no one-line DEFAULT_CONFIG");
  return join(home, ...(JSON.parse(parts) as string[]));
};

// A movie as ffmpeg writes it with -map_metadata -1 -fflags +bitexact, which
// scripts/media-check.pl passes: zero times and an empty udta/meta, built byte
// by byte as in tests/core/media-check.test.mjs. `t` sets its creation and
// modification times.
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const latin1 = (text: string) => Buffer.from(text, "latin1");
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), latin1(type), body]);
};
const full = (type: string, flags: number, ...parts: Buffer[]) => box(type, u32(flags), ...parts);
function movie(t = 0): Buffer {
  const times = Buffer.concat([u32(t), u32(t)]);
  return Buffer.concat([
    box("ftyp", latin1("isom"), u32(512), latin1("isomiso2avc1mp41")),
    box("free"),
    box("mdat", Buffer.from([1, 2, 3, 4])),
    box(
      "moov",
      full("mvhd", 0, times, u32(1000), u32(1000), Buffer.alloc(80)),
      box(
        "trak",
        full("tkhd", 3, times, u32(1), Buffer.alloc(72)),
        box("mdia", full("mdhd", 0, times, u32(1000), u32(1000), Buffer.alloc(4)), box("minf", box("dinf", full("dref", 0, u32(1), full("url ", 1))))),
      ),
      box("udta", full("meta", 0, full("hdlr", 0, u32(0), latin1("mdirappl"), Buffer.alloc(9)), box("ilst"))),
    ),
  ]);
}

let assets = "";
let demo = "";
let built = { code: 0 as number | null, out: "" };
before(() => {
  const dir = scratch("zenius-release-");
  assets = join(dir, "assets");
  demo = join(dir, "demo.mp4");
  writeFileSync(demo, movie());
  built = run("bash", [join(REPO, "scripts/release.sh"), "--out", assets, "--url", `file://${assets}`, "--attach", demo, "--test-build"]);
});

/**
 * A fake HOME holding Zen's app (with fx-autoconfig's two files unless
 * `app: false`) and the profile Zen opens, per profiles.ini (with
 * fx-autoconfig's loader unless `loader: false`), where this platform's
 * installers look: a Zen.app (ZEN_APP) and ~/Library/Application Support/zen
 * on macOS, an app folder (ZEN_BIN) and ~/.zen on Linux. ZENIUS_APP_BIN
 * points install.sh's look for other running Zens at that app, not the
 * machine's own. Its npm is a stand-in that logs its folder and arguments to
 * `npmLog` and makes the two adapters' folders, or fails with NPM_FAIL=1, so
 * no test reaches the registry.
 */
function machine(options: { app?: boolean; loader?: boolean } = {}) {
  const home = scratch("zenius-release-home-");
  const fakeBin = join(home, "fake-bin");
  const npmLog = join(home, "npm.log");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "npm"),
    `#!/bin/sh\n[ -z "$NPM_FAIL" ] || { echo "npm ERR! the stand-in fails" >&2; exit 1; }\nprintf '%s\\n%s\\n' "$PWD" "$*" >${JSON.stringify(npmLog)}\nmkdir -p node_modules/@agentclientprotocol/claude-agent-acp node_modules/@agentclientprotocol/codex-acp\n`,
  );
  chmodSync(join(fakeBin, "npm"), 0o755);
  // The app folder is where fx-autoconfig's two files go: Zen.app's Resources on macOS.
  const app = join(home, "Zen.app");
  const appdir = MAC ? join(app, "Contents/Resources") : join(home, "zen-app");
  const bin = MAC ? join(app, "Contents/MacOS/zen") : join(appdir, "zen");
  mkdirSync(join(appdir, "defaults/pref"), { recursive: true });
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(join(appdir, "application.ini"), "[App]\nName=Zen\n");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  if (options.app !== false) {
    copyFileSync(join(VENDOR, "program/config.js"), join(appdir, "config.js"));
    copyFileSync(join(VENDOR, "program/defaults/pref/config-prefs.js"), join(appdir, "defaults/pref/config-prefs.js"));
  }
  const zenData = MAC ? join(home, "Library/Application Support/zen") : join(home, ".zen");
  const profile = join(zenData, "Profiles/test.Default");
  mkdirSync(join(profile, "chrome/JS"), { recursive: true });
  if (options.loader !== false) cpSync(join(VENDOR, "profile/chrome/utils"), join(profile, "chrome/utils"), { recursive: true });
  writeFileSync(join(zenData, "profiles.ini"), "[Profile0]\nName=Default\nIsRelative=1\nPath=Profiles/test.Default\nDefault=1\n\n[General]\nStartWithLastProfile=1\nVersion=2\n");
  const env = { HOME: home, PATH: `${fakeBin}:${PATH}`, ZEN_APP: MAC ? app : undefined, ZEN_BIN: MAC ? undefined : bin, ZENIUS_APP_BIN: bin, ZENIUS_HOME: undefined, ZENIUS_CLI_DIR: undefined, ZENIUS_BIN_DIR: undefined, ZENIUS_SKILL_DIRS: undefined, ZENIUS_RELEASE_URL: undefined, ZENIUS_INSTALL_NO_BUILD: undefined, NPM_FAIL: undefined };
  const installer = (args: string[] = [], more: Record<string, string> = {}, script = join(assets, "install.sh")) =>
    run("bash", [script, ...args], { ...env, ...more }, home);
  return { home, appdir, profile, npmLog, installer, env };
}

/**
 * The release's installer for a package with the sidebar's agents: the
 * package itself when it holds runtime/agents, else a copy of it with two
 * stand-in files, and an installer with that copy's SHA-256.
 */
let agentsRelease: { script: string; url: string } | undefined;
function withAgents(): { script: string; url: string } {
  if (agentsRelease) return agentsRelease;
  const pkg = join(assets, `${name}.tar.gz`);
  if (run("tar", ["-tzf", pkg]).out.split("\n").includes(`${name}/runtime/agents/package-lock.json`)) {
    return (agentsRelease = { script: join(assets, "install.sh"), url: `file://${pkg}` });
  }
  const dir = scratch("zenius-release-agents-");
  assert.equal(run("tar", ["-xzf", pkg, "-C", dir]).code, 0);
  const agents = join(dir, name, "runtime/agents");
  mkdirSync(agents);
  writeFileSync(join(agents, "package.json"), '{ "private": true, "dependencies": { "@agentclientprotocol/claude-agent-acp": "0.107.0" } }\n');
  writeFileSync(join(agents, "package-lock.json"), '{ "lockfileVersion": 3, "packages": {} }\n');
  const copy = join(dir, `${name}.tar.gz`);
  assert.equal(run("tar", ["-czf", copy, name], {}, dir).code, 0);
  const script = join(dir, "install.sh");
  writeFileSync(script, readFileSync(join(assets, "install.sh"), "utf8").replace(/^SHA256='[0-9a-f]{64}'$/m, `SHA256='${sha256(copy)}'`));
  return (agentsRelease = { script, url: `file://${copy}` });
}

describe("scripts/release.sh", () => {
  it("builds the package from HEAD, its SHA-256 and the installer that checks it", () => {
    assert.equal(built.code, 0, built.out);
    const pkg = join(assets, `${name}.tar.gz`);
    const hash = sha256(pkg);
    assert.equal(readFileSync(`${pkg}.sha256`, "utf8"), `${hash}  ${name}.tar.gz\n`);
    assert.match(built.out, new RegExp(`SHA-256 for the release notes: ${hash}  ${name}\\.tar\\.gz`));
    assert.match(built.out, /a test build: never publish these assets/);

    const listing = run("tar", ["-tzf", pkg]).out.split("\n");
    for (const path of [
      "RELEASE",
      "LICENSE",
      "THIRD_PARTY.md",
      "runtime/JS/zenius.uc.js",
      "runtime/vendor/fx-autoconfig/program/config.js",
      "sdk/bin/zenius",
      "sdk/dist/zenius.mjs",
      "sdk/dist/guide.md",
      "sdk/sandbox/launcher.sh",
      "skill/zenius/SKILL.md",
      "scripts/install.sh",
      "scripts/install-cli.sh",
    ]) {
      assert.ok(listing.includes(`${name}/${path}`), `the package has no ${path}`);
    }
    assert.deepEqual(listing.filter((path) => /\/(node_modules|sdk\/test)\//.test(path)), [], "no build tools or tests");

    const release = run("tar", ["-xOzf", pkg, `${name}/RELEASE`]).out;
    assert.match(short, /^[0-9a-f]{7,}$/);
    assert.equal(release, `version=${version}\ncommit=${short}\n`);

    const installer = readFileSync(join(assets, "install.sh"), "utf8");
    assert.ok(installer.includes(`VERSION='${version}'`));
    assert.ok(installer.includes(`SHA256='${hash}'`));
    assert.ok(installer.includes(`'file://${assets}/${name}.tar.gz'`));
    assert.doesNotMatch(installer, /@[A-Z0-9]+@/);

    assert.deepEqual(readFileSync(join(assets, "demo.mp4")), readFileSync(demo), "the --attach file, as it was given");
    assert.ok(built.out.includes(`\n  ${assets}/install.sh\n  ${assets}/demo.mp4 (0 KiB)\n`), built.out);
  });

  it("names no one in the package, and a commit always builds the same bytes: uid and gid 0, the commit's time, modes 644 and 755 whatever the umask, sorted entries, no name or time in the gzip header", () => {
    assert.equal(built.code, 0, built.out);
    const pkg = readFileSync(join(assets, `${name}.tar.gz`));
    assert.equal(pkg[3] & 0x08, 0, "gzip -n: no file name");
    assert.equal(pkg.readUInt32LE(4), 0, "gzip -n: no time");

    const when = Number(run("git", ["show", "-s", "--format=%ct", "HEAD"]).out.trim());
    const tar = gunzipSync(pkg);
    const text = (header: Buffer, at: number, length: number) => header.subarray(at, at + length).toString("latin1").replace(/\0[\s\S]*$/, "");
    const number = (header: Buffer, at: number, length: number) => parseInt(text(header, at, length).trim() || "0", 8);
    const entries: { path: string; type: string; mode: number }[] = [];
    for (let at = 0; at + 512 <= tar.length; ) {
      const header = tar.subarray(at, at + 512);
      if (header.every((byte) => byte === 0)) break;
      const prefix = text(header, 345, 155);
      const path = `${prefix ? `${prefix}/` : ""}${text(header, 0, 100)}`;
      assert.equal(text(header, 257, 6), "ustar", `${path}: a plain ustar header, no pax or GNU one`);
      assert.equal(number(header, 108, 8), 0, `${path}: uid 0`);
      assert.equal(number(header, 116, 8), 0, `${path}: gid 0`);
      assert.match(text(header, 265, 32), /^(root)?$/, `${path}: no user's name`);
      assert.match(text(header, 297, 32), /^(root)?$/, `${path}: no group's name`);
      assert.equal(number(header, 136, 12), when, `${path}: the commit's time`);
      entries.push({ path, type: text(header, 156, 1) || "0", mode: number(header, 100, 8) });
      at += 512 + Math.ceil(number(header, 124, 12) / 512) * 512;
    }
    assert.ok(entries.length > 100, `${entries.length} entries`);
    for (const { path, type, mode } of entries) {
      if (type === "5") {
        assert.equal(mode, 0o755, `${path}: a folder, 755`);
      } else {
        assert.equal(type, "0", `${path}: a plain file`);
        assert.ok(mode === 0o644 || mode === 0o755, `${path}: 644 or 755, not ${mode.toString(8)}`);
      }
    }
    const mode = (path: string) => entries.find((entry) => entry.path === `${name}/${path}`)?.mode;
    assert.equal(mode("sdk/bin/zenius"), 0o755);
    assert.equal(mode("scripts/install.sh"), 0o755);
    assert.equal(mode("LICENSE"), 0o644);
    assert.equal(mode("sdk/dist/zenius.mjs"), 0o644);
    // A folder's entry ends in "/"; the order is by its name without it.
    const paths = entries.map((entry) => entry.path.replace(/\/$/, ""));
    assert.deepEqual(paths, [...paths].sort(), "entries in byte order");

    // Again under umask 077, which made 0600 and 0700 before.
    const again = join(scratch("zenius-release-again-"), "assets");
    const rebuilt = run("bash", ["-c", 'umask 077 && exec bash "$@"', "release", join(REPO, "scripts/release.sh"), "--out", again, "--url", `file://${assets}`, "--test-build"]);
    assert.equal(rebuilt.code, 0, rebuilt.out);
    assert.ok(readFileSync(join(again, `${name}.tar.gz`)).equals(pkg), "a second build of the commit makes the same package, byte for byte");
    assert.equal(readFileSync(join(again, "install.sh"), "utf8"), readFileSync(join(assets, "install.sh"), "utf8"));
  });

  it("runs the export's header check (scripts/package-check.pl) on its own package, and keeps no assets when it finds more than the files", () => {
    const dir = scratch("zenius-release-headers-");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // A perl whose package check always finds something, as with a tar that
    // ignores the owner options; every other script goes to the real perl.
    writeFileSync(join(bin, "perl"), '#!/bin/sh\ncase "$1" in */package-check.pl) echo "$2: an entry owned by uid 1000"; exit 1 ;; esac\nexec /usr/bin/perl "$@"\n');
    chmodSync(join(bin, "perl"), 0o755);
    const out = join(dir, "assets");
    const result = run("bash", [join(REPO, "scripts/release.sh"), "--out", out, "--test-build"], { PATH: `${bin}:${PATH}` });
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, new RegExp(`/${name}\\.tar\\.gz: an entry owned by uid 1000\\n`));
    assert.match(result.out, /the package's headers hold more than its files \(above\), so it's removed, and --out holds no assets/);
    assert.deepEqual(readdirSync(out), []);
  });

  it("packs only its list (git's files, the build's two outputs, RELEASE), and stops at any other file in the staged tree, by name, with no assets", () => {
    const dir = scratch("zenius-release-stray-");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // A node whose build leaves a stray file beside the bundle, as a
    // platform's own metadata would; every other run is the real node's.
    writeFileSync(join(bin, "node"), `#!/bin/sh\n${JSON.stringify(process.execPath)} "$@" || exit\ncase "$1" in build.mjs) : >dist/.DS_Store ;; esac\n`);
    chmodSync(join(bin, "node"), 0o755);
    const out = join(dir, "assets");
    const result = run("bash", [join(REPO, "scripts/release.sh"), "--out", out, "--test-build"], { PATH: `${bin}:${PATH}` });
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /the staged package holds files that aren't in its list/);
    assert.deepEqual(result.out.split("\n").filter((line) => line.startsWith("  ")), [`  ${name}/sdk/dist/.DS_Store`]);
    assert.match(result.out, /the staged package doesn't match its list \(above\), so no assets were made/);
    assert.ok(!existsSync(out), "no assets");
  });

  it("checks each file --attach names before building anything, and stops at one that holds more than its frames, isn't a picture or a movie, or can't be an asset's name", () => {
    const dir = scratch("zenius-release-attach-");
    const out = join(dir, "assets");
    const release = (...files: string[]) =>
      run("bash", [join(REPO, "scripts/release.sh"), "--out", out, "--test-build", ...files.flatMap((file) => ["--attach", file])]);
    writeFileSync(join(dir, "dated.mp4"), movie(1));
    writeFileSync(join(dir, "notes.txt"), "notes\n");
    writeFileSync(join(dir, "install.sh"), movie());
    writeFileSync(join(dir, "my demo.mp4"), movie());
    mkdirSync(join(dir, "other"));
    writeFileSync(join(dir, "other/demo.mp4"), movie());

    let result = release(demo, join(dir, "dated.mp4"));
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /^dated\.mp4: besides its pixels, it has a creation or modification time; save it without them$/m);
    assert.match(result.out, /an --attach file must hold only its pixels or frames/);
    assert.doesNotMatch(result.out, /^demo\.mp4:/m);
    result = release(join(dir, "notes.txt"));
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /^notes\.txt: a format this check can't read/m);

    assert.match(release(demo, join(dir, "other/demo.mp4")).out, /the release already has an asset named demo\.mp4/);
    assert.match(release(join(dir, "install.sh")).out, /the release already has an asset named install\.sh/);
    assert.match(release(join(dir, "my demo.mp4")).out, /an asset's name takes only letters, digits, dots, dashes and underscores/);
    assert.match(release(join(dir, "missing.mp4")).out, /--attach \S*missing\.mp4: no such file/);
    assert.ok(!existsSync(out), "nothing built");
  });

  it("refuses an output folder that isn't empty, and a version that isn't x.y.z", () => {
    const busy = scratch("zenius-release-busy-");
    writeFileSync(join(busy, "left"), "");
    assert.match(run("bash", [join(REPO, "scripts/release.sh"), "--out", busy, "--test-build"]).out, /must be an empty folder/);
    assert.match(run("bash", [join(REPO, "scripts/release.sh"), "--out", join(busy, "new"), "--version", "1.2", "--test-build"]).out, /must look like 1\.2\.3/);
  });

  it("builds nothing from a commit of the private repo without --test-build: a release comes from the public one", (t) => {
    if (!PRIVATE) {
      t.skip("a commit of the public repo: nothing private to refuse");
      return;
    }
    const out = join(scratch("zenius-release-private-"), "assets");
    const result = run("bash", [join(REPO, "scripts/release.sh"), "--out", out]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /has docs\/MANAGER\.md, so it's a commit of the private repo: build the release from a commit of the public one/);
    assert.ok(!existsSync(out), "no assets");
  });
});

describe("the release's install.sh", () => {
  it("installs zen(ius) into the profile Zen opens, the zenius command and its skill, from the checked package", () => {
    const m = machine();
    const result = m.installer();
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /SHA-256 matches/);
    assert.match(result.out, /is installed\. Open Zen/);
    // The fake HOME's ~/.local/bin isn't on this PATH: one note says so, with what to do.
    assert.deepEqual(
      result.out.split("\n").filter((line) => /is not on PATH|isn't on your PATH/.test(line)),
      [`note     ${join(m.home, ".local/bin")} is not on PATH: add it, so your shell and agents find the zenius command`],
    );
    assert.ok(existsSync(join(m.profile, "chrome/JS/zenius.uc.js")), "the runtime is in the profile");
    assert.ok(existsSync(join(m.home, ".zenius/release/RELEASE")), "the release stays for --uninstall");
    const cli = run(join(m.home, ".local/bin/zenius"), ["--version"], { HOME: m.home });
    assert.equal(cli.code, 0, cli.out);
    assert.ok(cli.out.includes(version), cli.out);
    // The package has no git, and the fake HOME sits in no repo: the commit is RELEASE's.
    for (const record of [join(m.home, ".zenius/cli/install.json"), join(m.profile, "chrome/JS/zenius/install.json")]) {
      assert.equal(JSON.parse(readFileSync(record, "utf8")).commit, short, record);
    }
    for (const dir of [".claude/skills", ".agents/skills"]) {
      assert.ok(lstatSync(join(m.home, dir, "zenius")).isSymbolicLink(), `${dir}/zenius links to the skill`);
    }
  });

  it("keeps a copy of the skill that npx skills put there, and links the other", () => {
    const m = machine();
    mkdirSync(join(m.home, ".claude/skills/zenius"), { recursive: true });
    writeFileSync(join(m.home, ".claude/skills/zenius/SKILL.md"), "---\nname: zenius\ndescription: npx's copy\n---\n");
    const result = m.installer();
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /keeping .*\.claude\/skills\/zenius, a copy of the skill installed another way/);
    assert.ok(lstatSync(join(m.home, ".claude/skills/zenius")).isDirectory());
    assert.match(readFileSync(join(m.home, ".claude/skills/zenius/SKILL.md"), "utf8"), /npx's copy/);
    assert.ok(lstatSync(join(m.home, ".agents/skills/zenius")).isSymbolicLink());
  });

  it("installs nothing from a package whose SHA-256 doesn't match", () => {
    const m = machine();
    const tampered = join(scratch("zenius-release-tampered-"), `${name}.tar.gz`);
    copyFileSync(join(assets, `${name}.tar.gz`), tampered);
    appendFileSync(tampered, "x");
    const result = m.installer([], { ZENIUS_RELEASE_URL: `file://${tampered}` });
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /SHA-256 is [0-9a-f]{64}, not the release's [0-9a-f]{64}: not installing it/);
    assert.ok(!existsSync(join(m.home, ".zenius/release")), "nothing unpacked");
    assert.ok(!existsSync(join(m.profile, "chrome/JS/zenius.uc.js")), "the profile is untouched");
  });

  it("leaves Zen's app to the user: without fx-autoconfig's two files there, it installs, prints the commands and exits 3", () => {
    const m = machine({ app: false });
    const result = m.installer();
    assert.equal(result.code, 3, result.out);
    assert.ok(existsSync(join(m.profile, "chrome/JS/zenius.uc.js")), "the profile part is installed");
    const vendor = join(m.home, ".zenius/release/runtime/vendor/fx-autoconfig/program");
    assert.ok(result.out.includes(`cp ${vendor}/config.js ${m.appdir}/`), result.out);
    assert.ok(result.out.includes(`cp ${vendor}/defaults/pref/config-prefs.js ${m.appdir}/defaults/pref/`), result.out);
    assert.match(result.out, /A Zen update replaces its app folder and drops these two files/);
    assert.ok(!existsSync(join(m.appdir, "config.js")), "it never copies them itself");
  });

  it("--uninstall takes it all out again and keeps the backups", () => {
    const m = machine();
    writeFileSync(join(m.profile, "chrome/JS/user.uc.js"), "// the user's own script\n");
    assert.equal(m.installer().code, 0);
    const result = m.installer(["--uninstall"]);
    assert.equal(result.code, 0, result.out);
    assert.ok(!existsSync(join(m.profile, "chrome/JS/zenius.uc.js")), "the runtime is out of the profile");
    assert.equal(readFileSync(join(m.profile, "chrome/JS/user.uc.js"), "utf8"), "// the user's own script\n", "the user's script stays");
    assert.ok(!existsSync(join(m.home, ".local/bin/zenius")), "the command is gone");
    assert.ok(!existsSync(join(m.home, ".claude/skills/zenius")), "the skill link is gone");
    assert.ok(!existsSync(join(m.home, ".zenius/release")), "the release is gone");
    assert.ok(existsSync(join(m.home, ".zenius/backups")), "the backups stay");
  });

  it("installs the sidebar's agents with npm ci from the release's lock, without install scripts or optional binaries, and links the node it found", () => {
    const m = machine();
    const release = withAgents();
    const result = m.installer([], { ZENIUS_RELEASE_URL: release.url }, release.script);
    assert.equal(result.code, 0, result.out);
    const agents = join(m.home, ".zenius/agents");
    assert.match(result.out, new RegExp(`installing the sidebar's agents \\(the ACP adapters for Claude Code and Codex\\) into ${agents}`));
    assert.equal(readFileSync(m.npmLog, "utf8"), `${agents}\nci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error\n`);
    for (const file of ["package.json", "package-lock.json"]) {
      assert.equal(readFileSync(join(agents, file), "utf8"), readFileSync(join(m.home, ".zenius/release/runtime/agents", file), "utf8"), file);
    }
    assert.equal(readlinkSync(join(agents, "node")), join(dirname(process.execPath), "node"));

    const uninstalled = m.installer(["--uninstall"], {}, release.script);
    assert.equal(uninstalled.code, 0, uninstalled.out);
    assert.ok(!existsSync(agents), "the agents are gone");
  });

  it("says what's left when npm ci fails for the sidebar's agents, and exits 1", () => {
    const m = machine();
    const release = withAgents();
    const result = m.installer([], { ZENIUS_RELEASE_URL: release.url, NPM_FAIL: "1" }, release.script);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /zen\(ius\) is installed, but not the sidebar's agents: npm ci failed in .*\.zenius\/agents \(above\)\. Run this again to retry/);
    assert.ok(existsSync(join(m.profile, "chrome/JS/zenius.uc.js")), "zen(ius) itself is installed");
  });

  // The launcher's line for the folder scripts may also read, as install-cli.sh
  // writes it: the folder as given, quoted for sh. The launcher resolves it at
  // each start and grants both forms, so on a Mac, where tmpdir() is under
  // /var (a link to /private/var), the resolved path isn't in the text.
  const readDirLine = (dir: string) => `READ_DIR='${dir.replace(/'/g, "'\\''")}'`;
  // The sandbox's Node major, as install-cli.sh has it.
  const sandboxNode = readFileSync(join(REPO, "scripts/install-cli.sh"), "utf8").match(/^SANDBOX_NODE_MAJOR=(\d+)$/m)?.[1];

  it("an update keeps the sandboxed launcher and the folder it may read, with no flag", (t) => {
    if (process.versions.node.split(".")[0] !== sandboxNode) return t.skip(`the sandbox runs on Node ${sandboxNode}, and this is ${process.versions.node}`);
    if (!MAC && !existsSync("/usr/bin/bwrap")) return t.skip("no bubblewrap here for the sandbox");
    const m = machine();
    assert.equal(m.installer().code, 0);
    // The user's choice, made once with the release's own install-cli.sh: the
    // launcher holds it from then on.
    const downloads = join(m.home, "Downloads");
    mkdirSync(downloads);
    const chosen = run(join(m.home, ".zenius/release/scripts/install-cli.sh"), ["--sandbox", "--read-dir", downloads], m.env, m.home);
    assert.equal(chosen.code, 0, chosen.out);
    const launcher = join(m.home, ".local/bin/zenius");
    assert.match(readFileSync(launcher, "utf8").split("\n")[1], /\(zenius-sandbox-launcher /);

    const update = m.installer();
    assert.equal(update.code, 0, update.out);
    assert.match(update.out, /is the sandboxed launcher, and this install keeps it/);
    const kept = readFileSync(launcher, "utf8");
    assert.match(kept.split("\n")[1], /\(zenius-sandbox-launcher /);
    assert.ok(kept.split("\n").includes(readDirLine(downloads)), "the launcher still lets scripts read ~/Downloads");
  });

  it("with a sandboxed launcher, stops before it changes anything when the sandbox's Node isn't first on PATH", () => {
    const m = machine();
    const launcher = join(m.home, ".local/bin/zenius");
    mkdirSync(dirname(launcher), { recursive: true });
    const text = "#!/bin/sh -p\n# zenius, sandboxed (zenius-sandbox-launcher 1). scripts/install-cli.sh wrote it.\nexit 0\n";
    writeFileSync(launcher, text, { mode: 0o755 });
    // A node that says it's 22, as a Mac's PATH gives without Homebrew's
    // node@24 in front; anything else goes to this test's own node.
    writeFileSync(
      join(m.home, "fake-bin/node"),
      `#!/bin/sh\nif [ "$1" = -p ] && [ "$2" = process.versions.node ]; then echo 22.12.0; exit 0; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    );
    const result = m.installer();
    assert.equal(result.code, 1, result.out);
    assert.ok(
      result.out.includes(`${launcher} is the sandboxed launcher, which this release keeps, and it needs Node ${sandboxNode} first on PATH; node is 22.12.0`),
      result.out,
    );
    assert.match(result.out, /then run this again: nothing has changed/);
    assert.ok(!existsSync(join(m.home, ".zenius/release")), "nothing unpacked into ~/.zenius");
    assert.ok(!existsSync(join(m.profile, "chrome/JS/zenius.uc.js")), "the profile is untouched");
    assert.equal(readFileSync(launcher, "utf8"), text, "the launcher is untouched");
  });

  it("with a plain linked CLI, Node 22 first stops nothing: the check is the sandbox's alone", () => {
    const m = machine();
    assert.equal(m.installer().code, 0);
    assert.ok(lstatSync(join(m.home, ".local/bin/zenius")).isSymbolicLink(), "the plain CLI is a link");
    writeFileSync(
      join(m.home, "fake-bin/node"),
      `#!/bin/sh\nif [ "$1" = -p ] && [ "$2" = process.versions.node ]; then echo 22.12.0; exit 0; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    );
    const update = m.installer();
    assert.equal(update.code, 0, update.out);
    assert.doesNotMatch(update.out, /is the sandboxed launcher/);
    assert.ok(lstatSync(join(m.home, ".local/bin/zenius")).isSymbolicLink(), "still the plain CLI");
  });

  const IPV6_OFF = 'user_pref("network.dns.disableIPv6", true);';

  it("a first install takes the user's three choices: --sandbox and --read-dir for the CLI, --disable-ipv6 for Zen, and an update keeps them", (t) => {
    if (process.versions.node.split(".")[0] !== sandboxNode) return t.skip(`the sandbox runs on Node ${sandboxNode}, and this is ${process.versions.node}`);
    if (!MAC && !existsSync("/usr/bin/bwrap")) return t.skip("no bubblewrap here for the sandbox");
    const m = machine();
    const downloads = join(m.home, "Downloads");
    mkdirSync(downloads);
    const result = m.installer(["--sandbox", "--read-dir", downloads, "--disable-ipv6"]);
    assert.equal(result.code, 0, result.out);
    const launcher = join(m.home, ".local/bin/zenius");
    const text = readFileSync(launcher, "utf8");
    assert.match(text.split("\n")[1], /\(zenius-sandbox-launcher /);
    assert.ok(text.split("\n").includes(readDirLine(downloads)), "the launcher lets scripts read the folder");
    assert.ok(readFileSync(join(m.profile, "user.js"), "utf8").split("\n").includes(IPV6_OFF), "user.js turns IPv6 lookups off");

    const update = m.installer();
    assert.equal(update.code, 0, update.out);
    assert.equal(readFileSync(launcher, "utf8"), text, "the update keeps the launcher and its folder");
    assert.ok(readFileSync(join(m.profile, "user.js"), "utf8").split("\n").includes(IPV6_OFF), "and the user.js line");
  });

  it("--disable-ipv6 reaches scripts/install.sh without the sandbox too", () => {
    const m = machine();
    const result = m.installer(["--disable-ipv6"]);
    assert.equal(result.code, 0, result.out);
    assert.ok(readFileSync(join(m.profile, "user.js"), "utf8").split("\n").includes(IPV6_OFF), "user.js turns IPv6 lookups off");
    assert.ok(lstatSync(join(m.home, ".local/bin/zenius")).isSymbolicLink(), "the CLI is the plain link");
  });

  it("checks the CLI's choices with install-cli.sh before anything changes: --sandbox without the sandbox's Node stops it", () => {
    const m = machine();
    writeFileSync(
      join(m.home, "fake-bin/node"),
      `#!/bin/sh\nif [ "$1" = -p ] && [ "$2" = process.versions.node ]; then echo 22.12.0; exit 0; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    );
    const result = m.installer(["--sandbox", "--disable-ipv6"]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /error {4}--sandbox: /, "install-cli.sh's own reason");
    assert.match(result.out, /nothing has changed/);
    assert.doesNotMatch(result.out, /would /, "none of the dry run's plan");
    assert.ok(!existsSync(join(m.home, ".zenius")), "nothing in ~/.zenius");
    assert.ok(!existsSync(join(m.profile, "chrome/JS/zenius.uc.js")), "the profile is untouched");
    assert.ok(!existsSync(join(m.profile, "user.js")), "no user.js");
    assert.ok(!existsSync(join(m.home, ".local/bin/zenius")), "no CLI");
  });

  it("a wrong choice is a wrong argument (exit 2), and nothing changes", () => {
    const m = machine();
    const cases: [string[], RegExp][] = [
      [["--uninstall", "--sandbox"], /go with an install, not --uninstall/],
      [["--disable-ipv6", "--uninstall"], /go with an install, not --uninstall/],
      [["--sandbox", "--read-dir"], /--read-dir takes a folder/],
      [["--sandbox", "--read-dir", "Downloads"], /--read-dir takes an absolute path/],
      [["--read-dir", join(m.home, "Downloads")], /--read-dir goes with --sandbox/],
    ];
    for (const [args, reason] of cases) {
      const result = m.installer(args);
      assert.equal(result.code, 2, `${args.join(" ")}: ${result.out}`);
      assert.match(result.out, reason, args.join(" "));
      assert.ok(!existsSync(join(m.home, ".zenius")), `${args.join(" ")}: nothing in ~/.zenius`);
      assert.ok(!existsSync(join(m.profile, "chrome/JS/zenius.uc.js")), `${args.join(" ")}: the profile is untouched`);
    }
  });

  // `curl … | bash` runs the script while bash is still reading it from the
  // pipe. Run as it came, a download cut short ran the part that arrived, and
  // a stop before the end left curl writing into a closed pipe ("curl: (23)
  // Failed writing body", the rehearsal of v0.1.1's --uninstall on the Linux server).
  it("piped into bash, runs nothing of a download cut short", () => {
    const m = machine();
    assert.equal(m.installer().code, 0);
    const text = readFileSync(join(assets, "install.sh"));
    for (const cut of [0.5, 0.75, 0.95]) {
      const part = text.subarray(0, Math.floor(text.length * cut));
      const result = spawnSync("bash", ["-s", "--", "--uninstall"], { cwd: m.home, input: part, encoding: "utf8", env: { ...process.env, ...m.env } });
      const at = `cut at ${cut * 100}% of ${text.length} bytes`;
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /^zen\(ius\): /m, `${at}: nothing ran`);
      assert.ok(existsSync(join(m.home, ".zenius/release/scripts/install.sh")), `${at}: the release is still there`);
      assert.ok(existsSync(join(m.profile, "chrome/JS/zenius.uc.js")), `${at}: zen(ius) is still in the profile`);
    }
  });

  it("adds no adapters for the sidebar's built-in agents when the user's own config.json names its agents, which win over them", () => {
    const m = machine();
    const config = sidebarConfig(m.home);
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, '{ "default": "codex", "agents": { "codex": { "command": "codex-acp" } } }\n');
    const release = withAgents();
    const result = m.installer([], { ZENIUS_RELEASE_URL: release.url }, release.script);
    assert.equal(result.code, 0, result.out);
    assert.ok(
      result.out.includes(`not installing the sidebar's built-in agents: ${config} names its agents, and they win over the built-in ones`),
      result.out,
    );
    assert.ok(!existsSync(m.npmLog), "npm never ran");
    assert.ok(!existsSync(join(m.home, ".zenius/agents")), "no adapters");
    assert.ok(existsSync(join(m.profile, "chrome/JS/zenius.uc.js")), "zen(ius) itself is installed");
  });

  it("still updates the adapters an earlier install put there, with or without config.json", () => {
    const m = machine();
    const release = withAgents();
    assert.equal(m.installer([], { ZENIUS_RELEASE_URL: release.url }, release.script).code, 0);
    rmSync(m.npmLog);
    const config = sidebarConfig(m.home);
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, '{ "default": "codex", "agents": { "codex": { "command": "codex-acp" } } }\n');
    const result = m.installer([], { ZENIUS_RELEASE_URL: release.url }, release.script);
    assert.equal(result.code, 0, result.out);
    assert.ok(existsSync(m.npmLog), "npm ci ran again in ~/.zenius/agents");
  });

  it("adds fx-autoconfig's loader to a profile that has none, and --uninstall takes it out again", () => {
    const m = machine({ loader: false });
    const result = m.installer();
    assert.equal(result.code, 0, result.out);
    assert.ok(existsSync(join(m.profile, "chrome/utils/boot.sys.mjs")), "the loader is in the profile");
    assert.ok(existsSync(join(m.profile, "chrome/JS/zenius.uc.js")));
    const uninstalled = m.installer(["--uninstall"]);
    assert.equal(uninstalled.code, 0, uninstalled.out);
    assert.ok(!existsSync(join(m.profile, "chrome/utils/boot.sys.mjs")), "the loader zen(ius) added is gone");
  });
});
