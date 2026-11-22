// zenius doctor against fake installs in temporary directories, with the mock
// runtime as the running Zen. Nothing here reads or touches a real Zen or
// profile: every path doctor looks at is passed in or lives under the fixture.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultProfile, doctor, formatReport, gitHead, ordinal, type Check, type DoctorOptions, type DoctorReport } from "../src/doctor.ts";
import { SANDBOX_BLOCKED_NEXT } from "../src/error-guide.ts";
import { VERSION } from "../src/version.ts";
import { runCli } from "./helpers.ts";
import { MockRuntime } from "./mock-runtime.ts";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const VENDOR = join(ROOT, "runtime", "vendor", "fx-autoconfig");
const HEAD = gitHead(ROOT)!;
const DAILY = "q7mz2k4d.Default (release)";

type Platform = "linux" | "darwin";

type Fixture = {
  home: string;
  app: string;
  resources: string;
  profile: string;
  zhome: string;
  platform: Platform;
  mock?: MockRuntime;
  options(extra?: Partial<DoctorOptions>): DoctorOptions;
};

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/** install.sh's lines in the profile's user.js (DNS_NOTE and DNS_LINE): no IPv6 lookups, the user's choice. */
const USER_JS_DNS =
  "// zenius: no IPv6 lookups in Zen, the user's choice for their IPv4-only network. scripts/install.sh --uninstall restores the previous value.\n" +
  'user_pref("network.dns.disableIPv6", true);\n';

/** A daily install as scripts/install.sh leaves it, in a fresh fake home. */
function install(platform: Platform = "linux"): Fixture {
  // By its real path, as doctor names Zen's folder: on macOS the temp folder is a link.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "zenius-doctor-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));

  const app = platform === "darwin" ? join(home, "Applications", "Zen.app") : join(home, "opt", "zen-1.24.2b");
  const resources = platform === "darwin" ? join(app, "Contents", "Resources") : app;
  mkdirSync(join(resources, "defaults", "pref"), { recursive: true });
  writeFileSync(join(resources, "application.ini"), "[App]\nVendor=Mozilla\nName=Zen\nVersion=1.24.2b\nBuildID=20261111122308\n");
  writeFileSync(join(resources, "platform.ini"), "[Build]\nBuildID=20261111122308\nMilestone=160.0\n");
  cpSync(join(VENDOR, "program", "config.js"), join(resources, "config.js"));
  cpSync(join(VENDOR, "program", "defaults", "pref", "config-prefs.js"), join(resources, "defaults", "pref", "config-prefs.js"));
  if (platform === "darwin") {
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents", "MacOS", "zen"), "", { mode: 0o755 });
  } else {
    writeFileSync(join(app, "zen"), "", { mode: 0o755 });
  }

  // profiles.ini marks an older profile Default=1; the [Install…] default wins, as in Firefox.
  const root = platform === "darwin" ? join(home, "Library", "Application Support", "zen") : join(home, ".config", "zen");
  const profile = join(root, "Profiles", DAILY);
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(root, "profiles.ini"),
    `[Profile1]\nName=old\nIsRelative=1\nPath=Profiles/old.default\nDefault=1\n\n` +
      `[Profile0]\nName=Default (release)\nIsRelative=1\nPath=Profiles/${DAILY}\n\n` +
      `[Install6ED35B3CA1C7F4E5]\nDefault=Profiles/${DAILY}\nLocked=1\n\n[General]\nStartWithLastProfile=1\nVersion=2\n`,
  );
  cpSync(join(VENDOR, "profile", "chrome", "utils"), join(profile, "chrome", "utils"), { recursive: true });
  mkdirSync(join(profile, "chrome", "JS", "zenius", "modules"), { recursive: true });
  writeFileSync(join(profile, "chrome", "JS", "zenius.uc.js"), "// zenius\n");
  writeFileSync(join(profile, "chrome", "JS", "zenius", "modules", "util.sys.mjs"), `export const RUNTIME_VERSION = "${VERSION}";\n`);
  writeInstallJson(profile, {});
  writeFileSync(join(profile, "prefs.js"), 'user_pref("browser.startup.page", 3);\n');
  writeFileSync(join(profile, "user.js"), USER_JS_DNS);

  const zhome = join(home, ".zenius");
  const backup = join(zhome, "backups", "20261120T100000Z");
  mkdirSync(backup, { recursive: true });
  writeFileSync(
    join(zhome, "install.json"),
    JSON.stringify({
      profile,
      files: [join(profile, "chrome", "JS", "zenius.uc.js"), join(profile, "chrome", "JS", "zenius", "install.json")],
      backup,
      runtimeVersion: VERSION,
      protocol: 1,
      commit: "0123456789abcdef0123456789abcdef01234567",
      installedAt: "2026-11-20T10:00:00Z",
    }),
  );

  const fixture: Fixture = {
    home,
    app,
    resources,
    profile,
    zhome,
    platform,
    options: (extra = {}) => ({
      instance: "default",
      platform,
      home,
      // The fixture's own, so that on a Mac doctor never finds the user's /Applications/Zen.app.
      applications: join(home, "Applications"),
      env: { ZENIUS_HOME: zhome, PATH: "" },
      checkoutRoot: ROOT,
      executableOf: () => (fixture.mock ? join(app, platform === "darwin" ? "Contents/MacOS/zen" : "zen") : undefined),
      zenProcessFor: () => undefined,
      ...extra,
    }),
  };
  return fixture;
}

function writeInstallJson(profile: string, fields: Record<string, unknown>): void {
  writeFileSync(
    join(profile, "chrome", "JS", "zenius", "install.json"),
    JSON.stringify({
      runtimeVersion: VERSION,
      protocol: 1,
      commit: "0123456789abcdef0123456789abcdef01234567",
      installedAt: "2026-11-20T10:00:00Z",
      profile,
      ...fields,
    }),
  );
}

/** browser.health's i5 from a runtime that holds I5 (zen-observe's observe/webcontent.sys.mjs). */
const I5_OK = { loads: ["about:blank", "blob:", "data:", "http:", "https:"], pageGate: true, contentGate: true, refuses: true };
const I5_SUMMARY = "agents load only http:, https:, data:, blob: and about:blank; page gate on; self-tests refused about:config, file:/// and a browser document";
const DAILY_FIX = "Install the runtime from this CLI's checkout (scripts/install.sh, with the user's OK), then the user quits and reopens Zen.";

type Answers = {
  hello?: Record<string, unknown>;
  health?: Record<string, unknown>;
  methods?: string[];
  install?: Record<string, unknown> | null;
  /** ui.sidebarStatus's answer; the method is listed only with one. */
  sidebar?: Record<string, unknown>;
};

/** Zen running the install: the mock runtime, registered as the instance. */
async function run(fixture: Fixture, answers: Answers = {}, instance = "default", profile = fixture.profile): Promise<MockRuntime> {
  const mock = await new MockRuntime().start();
  cleanups.push(() => mock.stop());
  fixture.mock = mock;
  mock.hello = { protocol: 1, instance, runtimeVersion: VERSION, zenVersion: "1.24.2b", ...answers.hello };
  const loaded = "install" in answers ? answers.install : installRecordOf(profile);
  mock.handle("browser.version", () => ({ zenVersion: mock.hello.zenVersion, runtimeVersion: mock.hello.runtimeVersion, updateAvailable: false, install: loaded }));
  mock.handle("browser.health", () => ({ ok: true, windows: 1, spaces: 2, pid: process.pid, webdriver: false, i5: I5_OK, dnsDisableIPv6: true, ...answers.health }));
  const methods = ["browser.version", "browser.health", "browser.methods", "spaces.list", ...(answers.sidebar ? ["ui.sidebarStatus"] : [])];
  mock.handle("browser.methods", () => ({ methods: answers.methods ?? methods }));
  if (answers.sidebar) mock.handle("ui.sidebarStatus", () => answers.sidebar);
  chmodSync(mock.socketPath, 0o600);
  chmodSync(mock.dir, 0o700);
  mkdirSync(join(fixture.zhome, "instances"), { recursive: true });
  writeFileSync(
    join(fixture.zhome, "instances", `${instance}.json`),
    JSON.stringify({ instance, pid: process.pid, socket: mock.socketPath, profileDir: profile, zenVersion: "1.24.2b", runtimeVersion: VERSION }),
  );
  return mock;
}

/** What the runtime keeps from the profile's install.json when Zen starts. */
function installRecordOf(profile: string): { commit: string; installedAt: string } | null {
  try {
    const { commit, installedAt } = JSON.parse(readFileSync(join(profile, "chrome", "JS", "zenius", "install.json"), "utf8"));
    return { commit: String(commit ?? ""), installedAt: String(installedAt ?? "") };
  } catch {
    return null;
  }
}

function byId(report: DoctorReport): Record<Check["id"], Check> {
  return Object.fromEntries(report.checks.map((entry) => [entry.id, entry])) as Record<Check["id"], Check>;
}

function statuses(report: DoctorReport): Record<string, string> {
  return Object.fromEntries(report.checks.map((entry) => [entry.id, entry.status]));
}

/** Every path, mode, size and mtime under a directory: doctor must change none of them. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = lstatSync(full);
      out.push(`${full} ${stat.mode} ${stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

// The fixture's install has no sidebar (an install from before it), so that check is left out.
const ALL_OK = { cli: "ok", zen: "ok", autoconfig: "ok", profile: "ok", loader: "ok", runtime: "ok", instance: "ok", sidebar: "skip", mcp: "skip", daily: "ok", boundary: "ok", dns: "ok", pagecode: "ok" };

describe("zenius doctor", () => {
  it("passes a healthy daily install that is running, and changes nothing on disk", async () => {
    const fixture = install();
    await run(fixture);
    const before = snapshot(fixture.home);
    const report = await doctor(fixture.options());
    assert.deepEqual(snapshot(fixture.home), before);
    assert.deepEqual(statuses(report), ALL_OK, formatReport(report, fixture.home));
    assert.equal(report.ok, true);
    const checks = byId(report);
    assert.match(checks.zen.summary, /^1\.24\.2b, Gecko 160\.0, .*opt\/zen-1\.24\.2b \(from the running instance, pid \d+\)$/);
    assert.equal(checks.profile.summary, `${fixture.profile} (from the running instance)`);
    assert.match(checks.runtime.summary, new RegExp(`^${VERSION.replace(/\./g, "\\.")}, protocol 1, commit 0123456, installed 2026-11-20T10:00:00Z$`));
    assert.match(checks.instance.summary, /^running, pid \d+, Zen 1\.24\.2b, runtime .+, protocol 1, 4 methods, 2 Spaces besides the Agents Space$/);
    assert.equal(checks.daily.summary, "no zenius.dev pref, no links into a checkout, no dev.* methods, navigator.webdriver false");
    assert.deepEqual(checks.daily.details, []);
    assert.equal(checks.boundary.title, "agent boundary (I5)");
    assert.equal(checks.boundary.summary, I5_SUMMARY);
    assert.deepEqual(checks.boundary.details, []);
    assert.equal(checks.dns.summary, "network.dns.disableIPv6: true, set by install.sh at the user's request (no IPv6 lookups in Zen)");
    const text = formatReport(report, fixture.home);
    assert.match(text, /^zenius doctor, instance "default"\n\nok {4}zenius CLI /);
    assert.match(text, /\nok {4}profile +~\/\.config\/zen\/Profiles\/q7mz2k4d\.Default \(release\) \(from the running instance\)\n/);
    assert.match(text, /\n\nEverything zenius needs is in place\.\n$/);
  });

  it("finds the profile Zen launches when Zen isn't running, and says Zen is closed", async () => {
    const fixture = install();
    rmSync(join(fixture.zhome, "install.json"));
    const report = await doctor(fixture.options());
    assert.deepEqual(statuses(report), { ...ALL_OK, instance: "warn", boundary: "skip" });
    assert.equal(report.ok, true);
    const checks = byId(report);
    assert.equal(checks.zen.summary, `1.24.2b, Gecko 160.0, ${fixture.app} (found in ~/opt)`);
    assert.equal(checks.profile.summary, `${fixture.profile} (the default profile in ~/.config/zen/profiles.ini)`);
    assert.equal(checks.instance.summary, "not running");
    assert.deepEqual(checks.instance.details, ["Zen is closed. Ask the user to open it."]);
    assert.equal(checks.daily.summary, "no zenius.dev pref, no links into a checkout");
    assert.deepEqual(checks.daily.details, ["Not checked: dev.* methods (Zen isn't answering); navigator.webdriver (Zen isn't answering)."]);
  });

  it("warns when the backup folder that install.json names is gone, whichever kind it was", async () => {
    const fixture = install();
    rmSync(join(fixture.zhome, "backups"), { recursive: true });
    await run(fixture);
    const runtime = byId(await doctor(fixture.options())).runtime;
    assert.equal(runtime.status, "warn");
    assert.match(
      runtime.details.join("\n"),
      /^The backup folder .*20261120T100000Z is missing\. It held what this install backed up: an earlier version's zenius files and their commit, which going back to that version needs, or, after a first install, a copy of user\.js\.$/m,
    );
  });

  it("tells a stale registry from a Zen that runs without zenius", async () => {
    const fixture = install();
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    mkdirSync(join(fixture.zhome, "instances"), { recursive: true });
    writeFileSync(join(fixture.zhome, "instances", "default.json"), JSON.stringify({ instance: "default", pid: gone, socket: join(fixture.zhome, "run", "default.sock"), profileDir: fixture.profile }));
    const stale = byId(await doctor(fixture.options())).instance;
    assert.equal(stale.status, "warn");
    assert.equal(stale.summary, `not running (the registry still names pid ${gone}, which is gone)`);

    const blind = byId(await doctor(fixture.options({ zenProcessFor: () => 4242 }))).instance;
    assert.equal(blind.status, "fail");
    assert.equal(blind.summary, "Zen is running (pid 4242) but zenius didn't start in it");
  });

  it("explains a config.js that a Zen update deleted, and leaves putting it back to the user", async () => {
    const fixture = install();
    rmSync(join(fixture.resources, "config.js"));
    const report = await doctor(fixture.options());
    const autoconfig = byId(report).autoconfig;
    assert.equal(autoconfig.status, "fail");
    assert.equal(report.ok, false);
    assert.equal(autoconfig.summary, `config.js missing from ${fixture.resources}`);
    assert.deepEqual(autoconfig.details, [
      "A Zen update deletes config.js, and without it Zen loads no userscripts, zenius included.",
      "Putting it back changes Zen's directory, so it needs the user's OK; zenius never does it.",
      "With that OK, copy fx-autoconfig 0.10.16's program files:",
      `  cp ${join(VENDOR, "program", "config.js")} ${fixture.resources}/`,
      "Then quit and reopen Zen; zenius never restarts it.",
    ]);
    assert.equal(existsSync(join(fixture.resources, "config.js")), false, "doctor never writes it");
    // Zen isn't running in this fixture: that's the warning.
    assert.match(formatReport(report, fixture.home), /\n\n1 problem and 1 warning\. zenius can't work until the problems are fixed\.\n$/);
  });

  it("on the Mac, quotes Zen.app's paths and mentions App Management", async () => {
    const fixture = install("darwin");
    rmSync(join(fixture.resources, "defaults"), { recursive: true });
    const checks = byId(await doctor(fixture.options()));
    assert.equal(checks.zen.summary, `1.24.2b, Gecko 160.0, ${fixture.app} (the default location)`);
    assert.equal(checks.profile.summary, `${fixture.profile} (from ~/.zenius/install.json)`);
    const target = join(fixture.resources, "defaults", "pref");
    assert.deepEqual(checks.autoconfig.details.slice(1), [
      "Putting it back changes Zen.app, so it needs the user's OK; zenius never does it.",
      "With that OK, copy fx-autoconfig 0.10.16's program files:",
      `  mkdir -p ${target}`,
      `  cp ${join(VENDOR, "program", "defaults", "pref", "config-prefs.js")} ${target}/`,
      "If macOS says the terminal was prevented from modifying apps, allow it under System Settings > Privacy & Security > App Management, or copy the files in Finder (Show Package Contents on Zen.app).",
      "Then quit and reopen Zen; zenius never restarts it.",
    ]);
    // The daily profile's name has spaces: the loader's commands quote it.
    rmSync(join(fixture.profile, "chrome", "utils", "boot.sys.mjs"));
    const loader = byId(await doctor(fixture.options())).loader;
    assert.equal(loader.status, "fail");
    assert.ok(loader.details.includes(`  mkdir -p "${join(fixture.profile, "chrome", "utils")}"`), loader.details.join("\n"));
  });

  it("flags a runtime and a CLI that disagree", async () => {
    const fixture = install();
    writeInstallJson(fixture.profile, { runtimeVersion: "0.0.9" });
    const older = byId(await doctor(fixture.options())).runtime;
    assert.equal(older.status, "warn");
    assert.match(older.details[0]!, new RegExp(`^This CLI is ${VERSION.replace(/\./g, "\\.")}\\. Install the runtime and link the CLI from the same checkout`));

    writeInstallJson(fixture.profile, { protocol: 2 });
    const other = byId(await doctor(fixture.options())).runtime;
    assert.equal(other.status, "fail");
    assert.match(other.details[0]!, /^This CLI speaks protocol 1 and the runtime speaks 2, so every script fails\.$/);

    writeInstallJson(fixture.profile, { profile: "/elsewhere/profile" });
    const moved = byId(await doctor(fixture.options())).runtime;
    assert.equal(moved.status, "warn");
    assert.match(moved.details.join("\n"), /install\.json says it was installed into \/elsewhere\/profile, not this profile/);
  });

  it("flags a Zen still running an older install, or a newer Zen on disk", async () => {
    const fixture = install();
    await run(fixture, { hello: { runtimeVersion: "0.0.9", zenVersion: "1.24.1b" } });
    const instance = byId(await doctor(fixture.options())).instance;
    assert.equal(instance.status, "warn");
    assert.deepEqual(instance.details, [
      `Zen runs runtime 0.0.9, but ${VERSION} is installed: quit and reopen Zen to load it.`,
      "Zen 1.24.1b is running, but 1.24.2b is on disk: Zen updated itself, and a Zen update deletes config.js. Run zenius doctor again after Zen restarts.",
    ]);
  });

  it("flags a Zen that still runs an earlier install of the same version, as browser.version reports it", async () => {
    const fixture = install();
    writeInstallJson(fixture.profile, { commit: "84b6be7", installedAt: "2026-11-20T10:00:00Z" });
    await run(fixture);
    assert.equal(byId(await doctor(fixture.options())).instance.status, "ok");

    // install.sh --while-running replaced the files; Zen runs what it loaded.
    writeInstallJson(fixture.profile, { commit: "4201e0b-dirty", installedAt: "2026-11-20T12:30:00Z" });
    const reinstalled = byId(await doctor(fixture.options()));
    assert.equal(reinstalled.instance.status, "warn");
    assert.deepEqual(reinstalled.instance.details, [
      "Zen still runs an earlier install (commit 84b6be7, installed 2026-11-20T10:00:00Z), not the profile's (commit 4201e0b-dirty, installed 2026-11-20T12:30:00Z): quit and reopen Zen to load it.",
    ]);
    assert.match(reinstalled.runtime.summary, /, commit 4201e0b-dirty, installed 2026-11-20T12:30:00Z$/);

    // Zen started before any install.json: a runtime someone copied by hand.
    const early = install();
    await run(early, { install: null });
    assert.deepEqual(byId(await doctor(early.options())).instance.details, [
      "Zen started before this runtime was installed (commit 0123456, installed 2026-11-20T10:00:00Z), so it runs the files it found then: quit and reopen Zen to load it.",
    ]);
  });

  it("lists each earlier Agents Space that zenius left in Zen, as browser.health reports them", async () => {
    const fixture = install();
    await run(fixture, {
      health: {
        strayAgentsSpaces: [
          { uuid: "{a}", name: "Agents", tabs: 2 },
          { uuid: "{b}", name: "Bots", tabs: 0 },
        ],
      },
    });
    const instance = byId(await doctor(fixture.options())).instance;
    assert.equal(instance.status, "warn");
    assert.deepEqual(instance.details, [
      `An earlier Agents Space, "Agents", is still in Zen with 2 tabs: zenius doesn't remove one that holds tabs or that a window shows. The user can look at it, then remove the Space in Zen.`,
      `An earlier Agents Space, "Bots", is still in Zen with 0 tabs: zenius doesn't remove one that holds tabs or that a window shows. The user can look at it, then remove the Space in Zen.`,
    ]);

    // With the runtime's position, the place in Zen's Space switcher that tells it from zenius's own.
    const placed = install();
    // The start that left it renamed it, once, to "<name> (old)".
    await run(placed, { health: { strayAgentsSpaces: [{ uuid: "{c}", name: "Agents (old)", tabs: 1, position: 3 }] } });
    assert.deepEqual(byId(await doctor(placed.options())).instance.details, [
      `An earlier Agents Space, "Agents (old)", the 3rd Space in Zen's switcher, is still in Zen with 1 tab: zenius doesn't remove one that holds tabs or that a window shows. The user can look at it, then remove the Space in Zen.`,
    ]);
    assert.deepEqual(
      [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal),
      ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th", "112th"],
    );

    // None: nothing to say.
    const clean = install();
    await run(clean, { health: { strayAgentsSpaces: [] } });
    assert.equal(byId(await doctor(clean.options())).instance.status, "ok");
  });

  it("reads install.sh's commit notation as recorded: git's short hash of 7 or more characters, -dirty or unknown; only a full hash is cut to 7", async () => {
    const fixture = install();
    const ours = HEAD.slice(0, 7);
    // [recorded, shown in the summary, the mismatch line]: git's --short
    // takes an 8th character when 7 name more than one commit.
    const rows: [string, string | undefined, string | undefined][] = [
      ["unknown", undefined, undefined],
      [`${ours}-dirty`, `${ours}-dirty`, undefined],
      [HEAD.slice(0, 8), HEAD.slice(0, 8), undefined],
      ["0000000", "0000000", `Installed from commit 0000000; this CLI is from ${ours}.`],
      ["00000000-dirty", "00000000-dirty", `Installed from commit 00000000-dirty; this CLI is from ${ours}.`],
      ["0123456789abcdef0123456789abcdef01234567", "0123456", `Installed from commit 0123456; this CLI is from ${ours}.`],
    ];
    for (const [commit, shown, mismatch] of rows) {
      writeInstallJson(fixture.profile, { commit });
      const runtime = byId(await doctor(fixture.options())).runtime;
      if (shown) assert.match(runtime.summary, new RegExp(`, commit ${shown},`));
      else assert.doesNotMatch(runtime.summary, /commit/);
      assert.equal(runtime.details.find((line) => line.startsWith("Installed from commit")), mismatch, commit);
    }
  });

  it("fails a runtime that speaks another protocol", async () => {
    const fixture = install();
    await run(fixture, { hello: { protocol: 2 } });
    const instance = byId(await doctor(fixture.options())).instance;
    assert.equal(instance.status, "fail");
    assert.equal(instance.summary, "running, but its runtime speaks protocol 2 and this CLI speaks 1");
  });

  it("warns about a socket other users can reach", async () => {
    const fixture = install();
    const mock = await run(fixture);
    chmodSync(mock.socketPath, 0o666);
    chmodSync(mock.dir, 0o755);
    const instance = byId(await doctor(fixture.options())).instance;
    assert.equal(instance.status, "warn");
    assert.deepEqual(instance.details, [
      `${mock.socketPath} has mode 0666: other users can connect to it. The runtime creates it 0600.`,
      `${mock.dir} has mode 0755: the runtime keeps its socket directory 0700.`,
    ]);
  });

  it("fails I4 on a daily profile with zenius.dev, dev methods, webdriver or a link into a checkout", async () => {
    const fixture = install();
    writeFileSync(join(fixture.profile, "prefs.js"), 'user_pref("zenius.dev", true);\n');
    rmSync(join(fixture.profile, "chrome", "JS", "zenius.uc.js"));
    symlinkSync(join(ROOT, "runtime", "JS", "zenius.uc.js"), join(fixture.profile, "chrome", "JS", "zenius.uc.js"));
    await run(fixture, { health: { webdriver: true }, methods: ["browser.version", "dev.viewState", "dev.eval"] });
    const daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "fail");
    assert.equal(daily.summary, "4 problems");
    // The user quits and reopens Zen: zenius never restarts it.
    assert.match(daily.details[0]!, /^The profile's prefs\.js sets pref zenius\.dev, .* then the user quits and reopens Zen\.$/);
    assert.deepEqual(
      daily.details.map((line) => line.split(/[.:]/)[0]),
      [
        "The profile's prefs",
        `chrome/JS/zenius`,
        "The runtime registers 2 dev",
        "navigator",
      ],
    );
    assert.ok(daily.details[1]!.includes(`is a link to ${join(ROOT, "runtime", "JS", "zenius.uc.js")}`), daily.details[1]);
  });

  it("warns when the profile turns the hand-off's quiet reload off, in user.js or prefs.js", async () => {
    const fixture = install();
    await run(fixture);
    const userJs = join(fixture.profile, "user.js");
    const before = readFileSync(userJs, "utf8");
    writeFileSync(userJs, before + 'user_pref("zenius.handoff.quietReload", false);\n');
    let daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "warn");
    assert.equal(
      daily.summary,
      "no zenius.dev pref, no links into a checkout, no dev.* methods, navigator.webdriver false; zenius.handoff.quietReload false",
    );
    assert.match(daily.details[0]!, /^The profile's user\.js sets zenius\.handoff\.quietReload to false, so the hand-off's and Resume's quiet reloads are off: .*ask the user whether they did\./);

    writeFileSync(userJs, before);
    writeFileSync(join(fixture.profile, "prefs.js"), 'user_pref("zenius.handoff.quietReload", false);\n');
    daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "warn");
    assert.match(daily.details[0]!, /^The profile's prefs\.js sets zenius\.handoff\.quietReload to false/);

    writeFileSync(join(fixture.profile, "prefs.js"), 'user_pref("zenius.handoff.quietReload", true);\n');
    daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "ok");
    assert.equal(daily.summary, "no zenius.dev pref, no links into a checkout, no dev.* methods, navigator.webdriver false");
  });

  it("warns when the profile runs the agent's page code in the page's own JavaScript (zenius.test.pageWorldEvaluate)", async () => {
    const fixture = install();
    await run(fixture);
    const userJs = join(fixture.profile, "user.js");
    const before = readFileSync(userJs, "utf8");
    writeFileSync(userJs, before + 'user_pref("zenius.test.pageWorldEvaluate", true);\n');
    writeFileSync(join(fixture.profile, "prefs.js"), 'user_pref("zenius.handoff.quietReload", false);\n');
    let daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "warn");
    assert.equal(
      daily.summary,
      "no zenius.dev pref, no links into a checkout, no dev.* methods, navigator.webdriver false; zenius.handoff.quietReload false, zenius.test.pageWorldEvaluate true",
    );
    assert.match(daily.details[1]!, /^The profile's user\.js sets zenius\.test\.pageWorldEvaluate to true, so the agent's page code runs in the page's own JavaScript, not in its sandbox.*ask the user whether they did\./);

    // false is its default: nothing to say.
    writeFileSync(userJs, before + 'user_pref("zenius.test.pageWorldEvaluate", false);\n');
    writeFileSync(join(fixture.profile, "prefs.js"), "");
    daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "ok");
  });

  it("shows the user's setting for agents' page code and how many sites they allowed, as information", async () => {
    const fixture = install();
    const pagecode = async () => byId(await doctor(fixture.options())).pagecode;
    let line = await pagecode();
    assert.equal(line.status, "ok");
    assert.equal(line.summary, "always (the default); no allowed sites listed");

    const prefsJs = join(fixture.profile, "prefs.js");
    const prefs = readFileSync(prefsJs, "utf8");
    writeFileSync(prefsJs, prefs + 'user_pref("zenius.agentTabs.pageCode", "ask");\nuser_pref("zenius.agentTabs.pageCodeSites", "https://example.com, https://shop.example.org,");\n');
    line = await pagecode();
    assert.equal(line.status, "ok");
    assert.equal(line.summary, "ask; 2 allowed sites listed");

    // user.js wins, as at Zen's start; "never" ignores the list, which stays.
    const userJs = join(fixture.profile, "user.js");
    const before = readFileSync(userJs, "utf8");
    writeFileSync(userJs, before + 'user_pref("zenius.agentTabs.pageCode", " Never ");\n');
    line = await pagecode();
    assert.equal(line.status, "ok");
    assert.equal(line.summary, "never; 2 allowed sites listed");

    // Any other value acts as ask, so a typo runs nothing unasked.
    writeFileSync(userJs, before + 'user_pref("zenius.agentTabs.pageCode", "sometimes");\nuser_pref("zenius.agentTabs.pageCodeSites", "https://example.com");\n');
    line = await pagecode();
    assert.equal(line.status, "ok");
    assert.equal(line.summary, 'ask (zenius.agentTabs.pageCode is "sometimes", which acts as ask); 1 allowed site listed');
  });

  it("warns when the profile turns off the sandbox's loop counter (zenius.test.loopCounterOff)", async () => {
    const fixture = install();
    await run(fixture);
    const userJs = join(fixture.profile, "user.js");
    const before = readFileSync(userJs, "utf8");
    writeFileSync(userJs, before + 'user_pref("zenius.test.loopCounterOff", true);\n');
    let daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "warn");
    assert.equal(daily.summary, "no zenius.dev pref, no links into a checkout, no dev.* methods, navigator.webdriver false; zenius.test.loopCounterOff true");
    assert.match(daily.details[0]!, /^The profile's user\.js sets zenius\.test\.loopCounterOff to true, so the agent's page code runs without its sandbox's loop counter: a loop that calls no built-in isn't stopped at its time limit.*ask the user whether they did\./);

    // false is its default: nothing to say.
    writeFileSync(userJs, before + 'user_pref("zenius.test.loopCounterOff", false);\n');
    daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "ok");
  });

  it("warns when the profile lets the agent sidebar start agents zenius can't hold (zenius.agentSidebar.allowUnknownAgents)", async () => {
    const fixture = install();
    await run(fixture);
    const userJs = join(fixture.profile, "user.js");
    const before = readFileSync(userJs, "utf8");
    writeFileSync(userJs, before + 'user_pref("zenius.agentSidebar.allowUnknownAgents", true);\n');
    let daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "warn");
    assert.equal(daily.summary, "no zenius.dev pref, no links into a checkout, no dev.* methods, navigator.webdriver false; zenius.agentSidebar.allowUnknownAgents true");
    assert.match(
      daily.details[0]!,
      /^The profile's user\.js sets zenius\.agentSidebar\.allowUnknownAgents to true, so the agent sidebar starts agents other than Claude Code and Codex, such as the tests' mock agent, which zenius can't hold to the browser: they run with none of its limits\. Only tests set it.*ask the user whether they did\./,
    );

    // false is its default: nothing to say.
    writeFileSync(userJs, before + 'user_pref("zenius.agentSidebar.allowUnknownAgents", false);\n');
    daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "ok");
  });

  it("says nothing of a leftover zenius.handoff.groupSwitch: the user's pass dropped the switch, so the pref does nothing", async () => {
    const fixture = install();
    await run(fixture);
    writeFileSync(join(fixture.profile, "prefs.js"), 'user_pref("zenius.handoff.groupSwitch", true);\n');
    const daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "ok");
    assert.equal(daily.summary, "no zenius.dev pref, no links into a checkout, no dev.* methods, navigator.webdriver false");
    assert.deepEqual(daily.details, []);
  });

  it("fails I4 when the daily profile names another instance (zenius.instance), where agents don't look", async () => {
    const fixture = install();
    await run(fixture);
    const userJs = join(fixture.profile, "user.js");
    const before = readFileSync(userJs, "utf8");
    writeFileSync(join(fixture.profile, "prefs.js"), 'user_pref("zenius.instance", "zen-sdk");\n');
    let daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "fail");
    assert.equal(daily.summary, "1 problem");
    assert.match(daily.details[0]!, /^The profile's prefs\.js sets zenius\.instance to "zen-sdk", so zenius in this Zen answers as that instance, not "default", where agents and doctor look for the user's Zen\. Reset it in about:config \(and remove it from user\.js, if it's there\); then the user quits and reopens Zen\.$/);

    // "default", the runtime's own default, is fine wherever it's written.
    writeFileSync(join(fixture.profile, "prefs.js"), "");
    writeFileSync(userJs, before + 'user_pref("zenius.instance", "default");\n');
    daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "ok");
  });

  it("fails the runtime check when fx-autoconfig's userChromeJS.scriptsDisabled lists zenius.uc.js", async () => {
    const fixture = install();
    await run(fixture);
    writeFileSync(join(fixture.profile, "prefs.js"), 'user_pref("userChromeJS.scriptsDisabled", "mine.uc.js, zenius.uc.js");\n');
    let runtime = byId(await doctor(fixture.options())).runtime;
    assert.equal(runtime.status, "fail");
    assert.match(runtime.summary, new RegExp(`^${VERSION.replace(/\./g, "\\.")}, protocol 1, `));
    assert.match(runtime.details[0]!, /^The profile's prefs\.js lists zenius\.uc\.js in fx-autoconfig's userChromeJS\.scriptsDisabled, so Zen doesn't load zenius, and a reinstall doesn't change that\. Ask the user whether they turned it off\./);

    // Another script of the user's, turned off, is theirs.
    writeFileSync(join(fixture.profile, "prefs.js"), 'user_pref("userChromeJS.scriptsDisabled", "mine.uc.js");\n');
    runtime = byId(await doctor(fixture.options())).runtime;
    assert.equal(runtime.status, "ok");
  });

  it("says when the runtime doesn't report navigator.webdriver", async () => {
    const fixture = install();
    await run(fixture, { health: { webdriver: undefined } });
    const daily = byId(await doctor(fixture.options())).daily;
    assert.equal(daily.status, "ok");
    assert.deepEqual(daily.details, ["Not checked: navigator.webdriver (this runtime doesn't report it)."]);
  });

  it("fails I5 on a runtime that doesn't report it, with the fix for a daily or a dev install", async () => {
    const fixture = install();
    await run(fixture, { health: { i5: undefined } });
    const report = await doctor(fixture.options());
    assert.equal(report.ok, false);
    const boundary = byId(report).boundary;
    assert.equal(boundary.status, "fail");
    assert.equal(boundary.summary, "the runtime doesn't report it");
    const stale = "So the runtime predates the report: it comes from an older commit than this CLI, and its URL policy and page gate can't be trusted.";
    assert.deepEqual(boundary.details, [stale, DAILY_FIX]);

    const dev = join(fixture.home, ".zenius-dev", "profiles", "zen-x");
    cpSync(fixture.profile, dev, { recursive: true });
    await run(fixture, { health: { i5: [] } }, "zen-x", dev);
    const devBoundary = byId(await doctor(fixture.options({ instance: "zen-x" }))).boundary;
    assert.equal(devBoundary.status, "fail");
    assert.deepEqual(devBoundary.details, [stale, "Restart it with scripts/zen-dev.sh zen-x restart, so it loads the checkout's runtime."]);
  });

  it("fails I5 on a scheme too many or too few, a gate that's off, or a self-test that failed", async () => {
    const fixture = install();
    await run(fixture, { health: { i5: { loads: ["about:blank", "data:", "file:", "http:", "https:"], pageGate: false, contentGate: true, refuses: "yes" } } });
    const boundary = byId(await doctor(fixture.options())).boundary;
    assert.equal(boundary.status, "fail");
    assert.equal(boundary.summary, "4 problems");
    const after = [DAILY_FIX, "Until it passes, agents must not work in this Zen: if the fix doesn't help, send `zenius doctor --json` to whoever installed zenius."];
    assert.deepEqual(boundary.details, [
      "It lets agents load file: URLs, where only http:, https:, data:, blob: and about:blank are allowed.",
      "It refuses blob:, which this CLI's scripts expect to load.",
      "Its page gate isn't on, so page methods could act in browser, local and add-on pages.",
      "Its refusal self-test failed: it should refuse about:config, file:/// and the browser window's own document.",
      ...after,
    ]);

    await run(fixture, { health: { i5: { loads: "http:", pageGate: true, contentGate: false, refuses: true } } });
    const second = byId(await doctor(fixture.options())).boundary;
    assert.equal(second.summary, "2 problems");
    assert.deepEqual(second.details, [
      "It doesn't list what agents may load.",
      "Its content-call check failed its self-test: a content call could reach the browser window's own document.",
      ...after,
    ]);
  });

  it("reports the user's no-IPv6 setting: off in about:config, from user.js with Zen closed, and an install that didn't opt in", async () => {
    const DNS_OK = "network.dns.disableIPv6: true, set by install.sh at the user's request (no IPv6 lookups in Zen)";
    // Turned off in about:config: user.js turns it back on at the next start.
    const off = install();
    await run(off, { health: { dnsDisableIPv6: false } });
    const offReport = await doctor(off.options());
    assert.deepEqual(statuses(offReport), { ...ALL_OK, dns: "warn" });
    assert.equal(offReport.ok, true);
    assert.equal(byId(offReport).dns.summary, "network.dns.disableIPv6: false, so Zen looks up IPv6 addresses");
    assert.deepEqual(byId(offReport).dns.details, [
      "zenius's install sets it to true at the user's request, and someone turned it off in about:config: ask the user whether they did.",
      "Zen's next start sets it to true again, from the profile's user.js.",
    ]);
    assert.match(formatReport(offReport, off.home), /\nwarn {2}DNS +network\.dns\.disableIPv6: false, so Zen looks up IPv6 addresses\n[^]*\n\n1 warning\.\n$/);

    // Zen closed: user.js says what its next start sets.
    const closed = install();
    assert.equal(byId(await doctor(closed.options())).dns.summary, "network.dns.disableIPv6: true in the profile's user.js, set by install.sh at the user's request (no IPv6 lookups in Zen)");

    // A runtime from before the report: user.js again, with Zen running.
    const older = install();
    await run(older, { health: { dnsDisableIPv6: undefined } });
    assert.equal(byId(await doctor(older.options())).dns.status, "ok");

    // The user's own line, not install.sh's: true, but doctor doesn't say who set it.
    const own = install();
    writeFileSync(join(own.profile, "user.js"), 'user_pref("network.dns.disableIPv6", true);\n');
    await run(own);
    assert.equal(byId(await doctor(own.options())).dns.summary, "network.dns.disableIPv6: true (no IPv6 lookups in Zen)");

    // An install without --disable-ipv6 leaves user.js as it is: no line is fine, Zen closed or running.
    const optOut = install();
    rmSync(join(optOut.profile, "user.js"));
    const closedReport = await doctor(optOut.options());
    assert.equal(byId(closedReport).dns.status, "ok");
    assert.equal(byId(closedReport).dns.summary, "network.dns.disableIPv6 isn't true in the profile's user.js (Zen looks up IPv6 addresses; scripts/install.sh --disable-ipv6 turns them off)");
    assert.deepEqual(byId(closedReport).dns.details, []);
    await run(optOut, { health: { dnsDisableIPv6: false } });
    const runningReport = await doctor(optOut.options());
    assert.deepEqual(statuses(runningReport), ALL_OK);
    assert.equal(byId(runningReport).dns.summary, "network.dns.disableIPv6: false (Zen looks up IPv6 addresses; scripts/install.sh --disable-ipv6 turns them off)");

    // The user's own line after zenius's, setting it false: their choice, no warning.
    const theirs = install();
    writeFileSync(join(theirs.profile, "user.js"), USER_JS_DNS + 'user_pref("network.dns.disableIPv6", false);\n');
    await run(theirs, { health: { dnsDisableIPv6: false } });
    assert.equal(byId(await doctor(theirs.options())).dns.status, "ok");

    // No zenius in the profile: nothing to check.
    const none = install();
    rmSync(join(none.profile, "user.js"));
    rmSync(join(none.profile, "chrome", "JS", "zenius", "install.json"));
    assert.equal(byId(await doctor(none.options())).dns.summary, "not checked: zenius isn't installed in this profile");

    assert.equal(byId(await doctor((await (async () => { const f = install(); await run(f); return f; })()).options())).dns.summary, DNS_OK);
  });

  it("checks a dev instance without install.json or I4", async () => {
    const fixture = install();
    const dev = join(fixture.home, ".zenius-dev", "profiles", "zen-x");
    cpSync(fixture.profile, dev, { recursive: true });
    rmSync(join(dev, "chrome", "JS", "zenius", "install.json"));
    await run(fixture, {}, "zen-x", dev);
    const report = await doctor(fixture.options({ instance: "zen-x" }));
    assert.deepEqual(statuses(report), { ...ALL_OK, daily: "skip", dns: "skip" });
    const checks = byId(report);
    assert.equal(checks.profile.summary, `${dev} (from the running instance)`);
    assert.equal(checks.runtime.summary, "copied from a checkout by scripts/zen-dev.sh (dev profiles have no install.json)");
    assert.equal(checks.daily.summary, "not checked: zen-x is a dev instance");
  });

  it("names what it looked for when it finds no Zen or no profile", async () => {
    const home = mkdtempSync(join(tmpdir(), "zenius-doctor-empty-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const report = await doctor({ instance: "default", platform: "linux", home, env: { ZENIUS_HOME: join(home, ".zenius"), PATH: "" }, checkoutRoot: ROOT, zenProcessFor: () => undefined });
    assert.deepEqual(statuses(report), { cli: "ok", zen: "fail", autoconfig: "skip", profile: "fail", loader: "skip", runtime: "skip", instance: "warn", sidebar: "skip", mcp: "skip", daily: "skip", boundary: "skip", dns: "skip", pagecode: "skip" });
    assert.equal(byId(report).boundary.summary, "not checked: Zen isn't answering");
    assert.equal(byId(report).dns.summary, "not checked: Zen isn't answering, and there's no profile");
    const checks = byId(report);
    assert.deepEqual(checks.zen.details, ["Pass --app <Zen.app, or the directory of the zen binary>."]);
    assert.deepEqual(checks.profile.details, [
      `Looked for ${join(home, ".zen", "profiles.ini")} and ${join(home, ".config", "zen", "profiles.ini")}.`,
      "Pass --profile <profile directory>.",
    ]);
  });
});

describe("zenius doctor in the sandbox", () => {
  const SANDBOXED = { cli: "ok", zen: "skip", autoconfig: "skip", profile: "skip", loader: "skip", runtime: "skip", sidebar: "skip", mcp: "skip", instance: "ok", daily: "ok", boundary: "ok", dns: "ok", pagecode: "skip" };
  const noLooking = {
    executableOf: () => assert.fail("doctor looked at a process from the sandbox"),
    zenProcessFor: () => assert.fail("doctor looked for Zen's process from the sandbox"),
  };

  it("checks only the CLI and the instance's socket, and says where to check the rest", async () => {
    const fixture = install();
    await run(fixture);
    const report = await doctor(fixture.options({ sandboxed: true, ...noLooking }));
    assert.deepEqual(statuses(report), SANDBOXED, formatReport(report, fixture.home));
    assert.equal(report.ok, true);
    assert.equal(report.sandboxed, true);
    const checks = byId(report);
    assert.equal(checks.zen.summary, "not checked: the sandbox can't read Zen's files");
    assert.deepEqual(checks.zen.details, [`The user can check them with \`node ${join(ROOT, "sdk", "bin", "zenius")} doctor\`, which runs outside the sandbox.`]);
    assert.match(checks.instance.summary, /^running, pid \d+, Zen 1\.24\.2b, runtime .+, protocol 1, 4 methods, 2 Spaces besides the Agents Space$/);
    assert.equal(checks.daily.summary, "no dev.* methods, navigator.webdriver false");
    assert.deepEqual(checks.daily.details, ["Not checked: prefs and links (the sandbox can't read the profile)."]);
    // The sandbox can't read user.js, so it doesn't say who set it.
    assert.equal(checks.dns.summary, "network.dns.disableIPv6: true (no IPv6 lookups in Zen)");
    const text = formatReport(report, fixture.home);
    assert.match(text, /^zenius doctor, instance "default", in the sandbox\n/);
    assert.match(text, /\n\nzenius works from the sandbox\. The checks marked -- need doctor outside it\.\n$/);
  });

  it("says a closed Zen isn't answering, without guessing at its process", async () => {
    const fixture = install();
    mkdirSync(join(fixture.zhome, "instances"), { recursive: true });
    // A record whose pid is alive outside: the sandbox can't see it either way.
    writeFileSync(join(fixture.zhome, "instances", "default.json"), JSON.stringify({ instance: "default", pid: process.pid, socket: join(fixture.zhome, "run", "default.sock") }));
    const report = await doctor(fixture.options({ sandboxed: true, ...noLooking }));
    assert.deepEqual(statuses(report), { ...SANDBOXED, instance: "warn", daily: "skip", boundary: "skip", dns: "skip" });
    assert.equal(byId(report).dns.summary, "not checked: Zen isn't answering, and the sandbox can't read the profile");
    const checks = byId(report);
    assert.equal(checks.instance.summary, "not answering");
    assert.deepEqual(checks.instance.details, [
      `nothing at ${join(fixture.zhome, "run", "default.sock")}`,
      "From the sandbox doctor can't see Zen's process, so it can't tell whether Zen is closed or not answering.",
      "If Zen is closed, ask the user to open it.",
    ]);
  });

  it("turns on by itself under Node's permission model, with only the launcher's grants", async () => {
    const fixture = install();
    const mock = await run(fixture, {}, "sbx");
    const result = await runCli(["doctor", "--json", "--instance", "sbx"], {
      env: { HOME: fixture.home, ZENIUS_HOME: fixture.zhome, ZENIUS_SOCKET: mock.socketPath, ZEN_BIN: "" },
      nodeArgs: ["--permission", `--allow-fs-read=${ROOT}`, `--allow-fs-read=${join(fixture.zhome, "instances")}`, `--allow-fs-read=${mock.socketPath}`],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as DoctorReport;
    assert.equal(report.sandboxed, true);
    assert.deepEqual(statuses(report), { ...SANDBOXED, daily: "skip", dns: "skip" }, result.stdout);
    assert.deepEqual(byId(report).zen.details, [`The user can check them with \`node ${join(ROOT, "sdk", "bin", "zenius")} doctor --instance sbx\`, which runs outside the sandbox.`]);
  });
});

describe("zenius doctor's CLI line", () => {
  it("names an installed copy and its commit, and warns a checkout whose Node can't run TypeScript", async () => {
    const fixture = install();
    const copy = join(fixture.home, ".zenius", "cli");
    mkdirSync(copy, { recursive: true });
    cpSync(join(VENDOR), join(copy, "runtime", "vendor", "fx-autoconfig"), { recursive: true });
    writeFileSync(join(copy, "install.json"), JSON.stringify({ version: VERSION, commit: "abcdef01-dirty", installedAt: "2026-11-20T12:00:00Z", from: ROOT }));
    const installed = byId(await doctor(fixture.options({ checkoutRoot: copy, typescript: false }))).cli;
    assert.equal(installed.status, "ok", "a copy runs only its bundle, whatever the Node");
    assert.ok(installed.summary.endsWith(`, installed in ${copy} from commit abcdef01-dirty on 2026-11-20`), installed.summary);

    const checkout = byId(await doctor(fixture.options({ typescript: false }))).cli;
    assert.equal(checkout.status, "warn");
    assert.match(checkout.summary, /, checkout .+/);
    assert.match(checkout.details[0]!, /can't run TypeScript/);
    assert.equal(byId(await doctor(fixture.options({ typescript: true }))).cli.status, "ok");
  });
});

describe("defaultProfile", () => {
  it("follows Firefox: the [Install…] default, then Default=1, then a lone profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "zenius-ini-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ini = join(dir, "profiles.ini");
    writeFileSync(ini, "[Profile0]\nIsRelative=1\nPath=Profiles/a\nDefault=1\n\n[Profile1]\nIsRelative=0\nPath=/abs/b\n\n[InstallXYZ]\nDefault=/abs/b\n");
    assert.equal(defaultProfile(ini), "/abs/b");
    writeFileSync(ini, "[Profile0]\nIsRelative=1\nPath=Profiles/a\n\n[Profile1]\nIsRelative=1\nPath=Profiles/b\nDefault=1\n");
    assert.equal(defaultProfile(ini), join(dir, "Profiles", "b"));
    writeFileSync(ini, "[General]\nVersion=2\n\n[Profile0]\nIsRelative=1\nPath=Profiles/only\n");
    assert.equal(defaultProfile(ini), join(dir, "Profiles", "only"));
    writeFileSync(ini, "[Profile0]\nPath=Profiles/a\n\n[Profile1]\nPath=Profiles/b\n");
    assert.equal(defaultProfile(ini), undefined);
    assert.equal(defaultProfile(join(dir, "missing.ini")), undefined);
  });
});

describe("zenius doctor (CLI)", () => {
  it("prints JSON, exits 1 only on a problem, and rejects unknown arguments", async () => {
    const fixture = install();
    const env = { HOME: fixture.home, ZENIUS_HOME: fixture.zhome, XDG_CONFIG_HOME: join(fixture.home, ".config"), ZEN_BIN: "" };
    const args = ["doctor", "--json", "--app", fixture.app, `--profile=${fixture.profile}`];
    const healthy = await runCli(args, { env });
    assert.equal(healthy.code, 0, healthy.stderr);
    const report = JSON.parse(healthy.stdout) as DoctorReport;
    assert.equal(report.instance, "default");
    assert.deepEqual(statuses(report), { ...ALL_OK, instance: "warn", boundary: "skip" });
    assert.equal(byId(report).zen.summary, `1.24.2b, Gecko 160.0, ${fixture.app} (from --app)`);

    rmSync(join(fixture.resources, "config.js"));
    const broken = await runCli(["doctor", "--app", fixture.app, "--profile", fixture.profile], { env });
    assert.equal(broken.code, 1);
    assert.match(broken.stdout, /\nFAIL {2}fx-autoconfig +config\.js missing from /);

    const unknown = await runCli(["doctor", "--fix"], { env });
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /zenius doctor: unexpected argument: --fix/);
    const empty = await runCli(["doctor", "--profile"], { env });
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /zenius doctor --profile needs a path/);
  });
});

describe("doctor inside another sandbox", () => {
  // Codex's sandbox refuses the connect (EPERM) and hides Zen's process; a
  // socket of mode 000 gets the same answer as EACCES. Zen may well be
  // running, so "not running, start it" would send the agent the wrong way.
  it("says the socket is blocked, without guessing at Zen's process", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root connects whatever the socket's mode");
    const fixture = install();
    const socket = join(fixture.zhome, "run", "default.sock");
    mkdirSync(join(fixture.zhome, "run"), { recursive: true });
    mkdirSync(join(fixture.zhome, "instances"), { recursive: true });
    const server = createServer((connection) => connection.end());
    await new Promise<void>((done) => server.listen(socket, done));
    chmodSync(socket, 0o000);
    // A pid the sandbox can't see, as in Codex's own PID namespace.
    writeFileSync(join(fixture.zhome, "instances", "default.json"), JSON.stringify({ instance: "default", pid: 999_999_999, socket }));
    try {
      const report = await doctor(fixture.options({ zenProcessFor: () => assert.fail("doctor guessed at Zen's process") }));
      const checks = byId(report);
      assert.equal(checks.instance.status, "fail", formatReport(report, fixture.home));
      assert.equal(checks.instance.summary, `blocked: this process may not connect to ${socket} (EACCES)`);
      assert.deepEqual(checks.instance.details, [
        "A sandbox around it blocks the socket (Codex's does while its network access is off), or the socket's permissions do. Zen may well be running.",
        SANDBOX_BLOCKED_NEXT,
      ]);
      assert.equal(report.ok, false);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

/** zenius's sidebar as scripts/install.sh puts it in the profile, listed in ~/.zenius/install.json. */
function installSidebar(fixture: Fixture, { marked = true }: { marked?: boolean } = {}): string {
  const file = join(fixture.profile, "chrome", "JS", "agent-sidebar.uc.js");
  writeFileSync(file, `// ==UserScript==\n// @name           Agent Sidebar\n${marked ? "// zenius: agent-sidebar\n" : ""}// ==/UserScript==\n(function agentSidebar() {})();\n`);
  const recordPath = join(fixture.zhome, "install.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.files.push(file);
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  return file;
}

/**
 * A CLI at `file` as the sidebar starts it (`<cli> mcp`): "ok" lists five tools, the last named after the
 * ZENIUS_INSTANCE it got; "old" is a CLI from before `zenius mcp`; "hang" reads and never answers.
 */
function fakeCli(file: string, kind: "ok" | "old" | "hang"): string {
  mkdirSync(join(file, ".."), { recursive: true });
  const body = {
    ok: `let buf = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    if (process.argv[2] !== "mcp") process.exit(2);
    if (m.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "zenius" } });
    if (m.method === "tools/list") reply({ tools: ["open", "read_page", "click", "fill", "instance-" + process.env.ZENIUS_INSTANCE].map((name) => ({ name })) });
  }
});`,
    old: `process.stderr.write("zenius: unknown command: " + process.argv[2] + "\\n");\nprocess.exit(2);`,
    hang: `process.stdin.resume();`,
  }[kind];
  writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return file;
}

const SIDEBAR_OK = { loaded: true, windows: 2, config: "found", configPath: "/Users/u/Library/Application Support/zenius-agent-sidebar/config.json" };
/** The sidebar line's Codex part: Codex is on by default (the user's call, 2026-11-21). */
const CODEX_ON = "; Codex can run, within the limits below";
const CODEX_LIMITS = [
  "Codex runs read-only: no shell, no writes, and no network outside zenius and its hosted web search, live in Work and cached in Chat. Its sub-agents are off, and the sidebar refuses every approval it asks for.",
  "One read path is left: apply_patch's check can tell Codex whether a file exists, or whether it holds a given line, though not what the file says.",
  "Setting zenius.agentSidebar.allowCodex to false in about:config turns Codex off, with no restart.",
];

describe("zenius doctor's sidebar check", () => {
  it("leaves out an install without zenius's sidebar, such as the user's own sidebar before the update", async () => {
    const fixture = install();
    writeFileSync(join(fixture.profile, "chrome", "JS", "agent-sidebar.uc.js"), "// ==UserScript==\n// @name Agent Sidebar\n// ==/UserScript==\n");
    await run(fixture, { sidebar: SIDEBAR_OK });
    const sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "skip");
    assert.equal(sidebar.summary, "not installed: this profile's install has no zenius sidebar");
  });

  it("passes with zenius's sidebar on disk and loaded, and says where its config is", async () => {
    const fixture = install();
    installSidebar(fixture);
    await run(fixture, { sidebar: SIDEBAR_OK });
    const sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "ok", sidebar.details.join("\n"));
    assert.equal(sidebar.summary, `zenius's on disk; loaded in 2 windows, config ${SIDEBAR_OK.configPath}${CODEX_ON}`);
    assert.deepEqual(sidebar.details, CODEX_LIMITS);
  });

  it("states Codex's limits and its one read path, as Codex is on by default, and says when the user turned it off", async () => {
    const fixture = install();
    installSidebar(fixture);
    await run(fixture, { sidebar: SIDEBAR_OK });
    const prefsJs = join(fixture.profile, "prefs.js");
    const prefs = readFileSync(prefsJs, "utf8");
    // On by default, and the same with the pref set to true: information, not a warning.
    for (const extra of ["", 'user_pref("zenius.agentSidebar.allowCodex", true);\n']) {
      writeFileSync(prefsJs, prefs + extra);
      const sidebar = byId(await doctor(fixture.options())).sidebar;
      assert.equal(sidebar.status, "ok", sidebar.details.join("\n"));
      assert.equal(sidebar.summary, `zenius's on disk; loaded in 2 windows, config ${SIDEBAR_OK.configPath}${CODEX_ON}`);
      assert.deepEqual(sidebar.details, CODEX_LIMITS);
    }

    // With a problem too, the line still says so, and the limits follow the problem.
    writeFileSync(prefsJs, prefs + 'user_pref("userChromeJS.scriptsDisabled", "agent-sidebar.uc.js");\n');
    let sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "warn");
    assert.equal(sidebar.summary, `1 problem${CODEX_ON}`);
    assert.deepEqual(sidebar.details.slice(1), CODEX_LIMITS);

    // Off is the user's choice, and user.js wins, as at Zen's start.
    writeFileSync(prefsJs, prefs + 'user_pref("zenius.agentSidebar.allowCodex", true);\n');
    const userJs = join(fixture.profile, "user.js");
    writeFileSync(userJs, readFileSync(userJs, "utf8") + 'user_pref("zenius.agentSidebar.allowCodex", false);\n');
    sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "ok", sidebar.details.join("\n"));
    assert.equal(sidebar.summary, `zenius's on disk; loaded in 2 windows, config ${SIDEBAR_OK.configPath}; Codex is off (zenius.agentSidebar.allowCodex = false)`);
    assert.deepEqual(sidebar.details, []);
  });

  it("checks the file alone while Zen is closed, and a runtime from before ui.sidebarStatus", async () => {
    const fixture = install();
    installSidebar(fixture);
    assert.equal(byId(await doctor(fixture.options())).sidebar.summary, `zenius's on disk; Zen isn't running${CODEX_ON}`);
    await run(fixture);
    const sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "ok");
    assert.equal(sidebar.summary, `zenius's on disk; the running runtime doesn't report the sidebar${CODEX_ON}`);
  });

  it("warns when another install put its own sidebar back, and says how to restore zenius's", async () => {
    const fixture = install();
    installSidebar(fixture, { marked: false });
    await run(fixture, { sidebar: SIDEBAR_OK });
    const sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "warn");
    assert.equal(sidebar.summary, `1 problem${CODEX_ON}`);
    assert.match(
      sidebar.details[0]!,
      /^chrome\/JS\/agent-sidebar\.uc\.js isn't zenius's sidebar: another install, such as the user's own install\.sh, put its copy back, and Zen loads that one at its next start\. With the user's OK, reinstall with scripts\/install\.sh, which keeps the copy it replaces as the user's own for Undo; then the user quits and reopens Zen\.$/,
    );
    // The marker counts only among the first 20 lines.
    const file = installSidebar(fixture);
    writeFileSync(file, "//\n".repeat(20) + "// zenius: agent-sidebar\n");
    assert.equal(byId(await doctor(fixture.options())).sidebar.status, "warn");
  });

  it("warns when the sidebar is missing, or fx-autoconfig's scriptsDisabled lists it", async () => {
    const fixture = install();
    const file = installSidebar(fixture);
    writeFileSync(join(fixture.profile, "prefs.js"), 'user_pref("userChromeJS.scriptsDisabled", "my-script.uc.js,agent-sidebar.uc.js");\n');
    let sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "warn");
    assert.match(sidebar.details[0]!, /^The profile's prefs\.js lists agent-sidebar\.uc\.js in fx-autoconfig's userChromeJS\.scriptsDisabled, so Zen doesn't load the sidebar\./);
    writeFileSync(join(fixture.profile, "prefs.js"), "");
    rmSync(file);
    sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "warn");
    assert.match(sidebar.details[0]!, /^chrome\/JS\/agent-sidebar\.uc\.js is missing, so Zen starts without zenius's sidebar\. With the user's OK, reinstall/);
  });

  it("warns when the running Zen hasn't loaded the installed sidebar", async () => {
    const fixture = install();
    installSidebar(fixture);
    await run(fixture, { sidebar: { ...SIDEBAR_OK, loaded: false, windows: 0 } });
    const sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "warn");
    assert.deepEqual(sidebar.details, ["The running Zen hasn't loaded zenius's sidebar, which is installed: the user quits and reopens Zen to load it.", ...CODEX_LIMITS]);
  });

  it("says agents are off, without a warning, where uc.agent-sidebar.config is none", async () => {
    const fixture = install();
    installSidebar(fixture);
    await run(fixture, { sidebar: { loaded: true, windows: 1, config: "none" } });
    const sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "ok", sidebar.details.join("\n"));
    assert.equal(sidebar.summary, "zenius's on disk; loaded in 1 window, agents are off in this profile (uc.agent-sidebar.config = none)");
  });

  it("checks that the sidebar's zenius mcp lists its tools, on this Zen's instance", async () => {
    const fixture = install();
    installSidebar(fixture);
    const cli = fakeCli(join(fixture.home, ".local", "bin", "zenius"), "ok");
    const mcp = byId(await doctor(fixture.options())).mcp;
    assert.equal(mcp.status, "ok", mcp.details.join("\n"));
    assert.equal(mcp.summary, `${cli} mcp answers: 5 tools (open, read_page, click, fill, …)`);
    // uc.agent-sidebar.zenius-cli names another CLI, and user.js wins over prefs.js, as at Zen's start.
    const other = fakeCli(join(fixture.home, "bin", "zenius"), "old");
    const named = fakeCli(join(fixture.home, "named", "zenius"), "ok");
    writeFileSync(join(fixture.profile, "prefs.js"), `user_pref("uc.agent-sidebar.zenius-cli", ${JSON.stringify(other)});\n`);
    writeFileSync(join(fixture.profile, "user.js"), USER_JS_DNS + `user_pref("uc.agent-sidebar.zenius-cli", ${JSON.stringify(named)});\n`);
    assert.equal(byId(await doctor(fixture.options())).mcp.summary, `${named} mcp answers: 5 tools (open, read_page, click, fill, …)`);
  });

  it("warns when the sidebar's CLI is from before zenius mcp, missing, or never answers, and says how to fix it", async () => {
    const fixture = install();
    installSidebar(fixture);
    const cli = join(fixture.home, ".local", "bin", "zenius");
    const fix = "Reinstall the CLI from the checkout the runtime came from, with Node 24 in front: scripts/install-cli.sh --skill (Updating later, step 2).";
    let mcp = byId(await doctor(fixture.options())).mcp;
    assert.equal(mcp.status, "warn");
    assert.deepEqual(mcp.details, [`The sidebar starts its agents' browser tools with ${cli} mcp, and there's nothing at ${cli}, so its agents get no browser. ${fix}`]);
    fakeCli(cli, "old");
    mcp = byId(await doctor(fixture.options())).mcp;
    assert.equal(mcp.summary, "doesn't answer");
    assert.deepEqual(mcp.details, [`${cli} mcp ended (exit 2) before listing its tools: zenius: unknown command: mcp, so the sidebar's agents get no browser tools. ${fix}`]);
    fakeCli(cli, "hang");
    mcp = byId(await doctor(fixture.options({ mcpTimeoutMs: 300 }))).mcp;
    assert.deepEqual(mcp.details, [`${cli} mcp didn't list its tools within 0.3 s, so the sidebar's agents get no browser tools. ${fix}`]);
  });

  it("names the built-in agents the sidebar runs without a config file, and why it doesn't offer one", async () => {
    const fixture = install();
    installSidebar(fixture);
    const folder = join(fixture.home, ".zenius", "agents");
    const builtin = {
      agents: ["claude", "codex"],
      folder,
      node: join(folder, "node"),
      clis: { claude: "/opt/homebrew/bin/claude", codex: "/home/u/.local/bin/codex" },
      adapters: { claude: true, codex: true },
      missing: null,
    };
    const status = (more: Record<string, unknown>) => ({ loaded: true, windows: 1, config: "builtin", configPath: "/home/u/cfg.json", builtin: { ...builtin, ...more } });
    await run(fixture, { sidebar: status({}) });
    let sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "ok", sidebar.details.join("\n"));
    assert.equal(sidebar.summary, `zenius's on disk; loaded in 1 window, built-in agents (Claude Code, Codex)${CODEX_ON}`);
    assert.deepEqual(sidebar.details, [
      `With no config file at /home/u/cfg.json, the sidebar runs Claude Code (/opt/homebrew/bin/claude) and Codex (/home/u/.local/bin/codex), through the adapters in ${folder}.`,
      ...CODEX_LIMITS,
    ]);

    // Codex isn't installed: Claude Code alone, and no Codex limits to list.
    await run(fixture, { sidebar: status({ agents: ["claude"], clis: { ...builtin.clis, codex: null } }) });
    sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "ok", sidebar.details.join("\n"));
    assert.equal(sidebar.summary, "zenius's on disk; loaded in 1 window, built-in agents (Claude Code)");
    assert.deepEqual(sidebar.details, [
      `With no config file at /home/u/cfg.json, the sidebar runs Claude Code (/opt/homebrew/bin/claude), through the adapters in ${folder}.`,
      "It doesn't offer Codex, which isn't installed (no codex command found).",
    ]);

    // Codex is installed, but its adapter isn't in the folder.
    await run(fixture, { sidebar: status({ agents: ["claude"], adapters: { claude: true, codex: false } }) });
    sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "ok", sidebar.details.join("\n"));
    assert.deepEqual(sidebar.details.slice(1), [
      `It doesn't offer Codex (/home/u/.local/bin/codex): its adapter isn't in ${folder}. Running zenius's installer again puts it there.`,
    ]);
  });

  it("warns with the sidebar's own line when it has no agent to offer, and when it couldn't look for one", async () => {
    const fixture = install();
    installSidebar(fixture);
    const line = "No agent to offer: install Claude Code (claude) or Codex (codex); run zenius's installer again, for its agent adapters in ~/.zenius/agents.";
    const builtin = { agents: [], folder: "/home/u/.zenius/agents", node: null, clis: { claude: null, codex: null }, adapters: { claude: false, codex: false }, missing: line };
    await run(fixture, { sidebar: { loaded: true, windows: 1, config: "missing", configPath: "/home/u/cfg.json", builtin } });
    let sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "warn");
    assert.equal(sidebar.summary, "1 problem");
    assert.deepEqual(sidebar.details, [`The sidebar has no config file at /home/u/cfg.json and no built-in agent it can run, so it offers no agent. ${line}`]);

    await run(fixture, { sidebar: { loaded: true, windows: 1, config: "missing", configPath: "/home/u/cfg.json", builtin: { agents: [], error: "Error: EACCES" } } });
    sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.status, "warn");
    assert.deepEqual(sidebar.details, ["The sidebar has no config file at /home/u/cfg.json, and looking for its built-in agents failed: Error: EACCES"]);
  });

  it("shows the sidebar's startup error and a missing config", async () => {
    const fixture = install();
    installSidebar(fixture);
    await run(fixture, { sidebar: { loaded: false, windows: 0, config: "missing", configPath: "/home/u/cfg.json", error: "TypeError: x is undefined" } });
    const sidebar = byId(await doctor(fixture.options())).sidebar;
    assert.equal(sidebar.summary, "2 problems");
    assert.deepEqual(sidebar.details, [
      "zenius's sidebar failed to start in the running Zen: TypeError: x is undefined",
      "The sidebar has no config at /home/u/cfg.json, so it offers no agent. The user's own sidebar setup made that file; the pref uc.agent-sidebar.config can name another.",
    ]);
  });
});
