// scripts/install.sh: copies, records, backups, uninstall, the running-Zen
// guard, the profile choice; then end to end in a dev Zen started the way the
// daily Zen starts (zen-dev.sh with ZENIUS_INSTALLED=1: the installed runtime,
// no cache purge).
//
// Every run gets a fake HOME and ZENIUS_HOME, so no test can reach the user's
// real profiles.ini or ~/.zenius.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { connect } from "../../scripts/lib/rpc.mjs";
import { guardHome, realPath } from "../lib/scratch-home.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNTIME = path.join(ROOT, "runtime/JS");
const USER_SCRIPT = "// the user's own script\n";
const util = fs.readFileSync(path.join(RUNTIME, "zenius/modules/util.sys.mjs"), "utf8");
const RUNTIME_VERSION = util.match(/^export const RUNTIME_VERSION = "(.*)";$/m)[1];
const PROTOCOL_VERSION = Number(util.match(/^export const PROTOCOL_VERSION = (\d+);$/m)[1]);
// The agent's scripts this checkout has beside the runtime (install.sh's
// COMPONENTS), which every install writes too: the top-level names in
// runtime/JS, and every file, each <name>.uc.js before its folder's.
const AGENT_SCRIPTS = ["agent-sidebar", "agent-urlbar"].filter(c => fs.existsSync(path.join(RUNTIME, `${c}.uc.js`)));
const AGENT_TOP = AGENT_SCRIPTS.flatMap(c => (fs.existsSync(path.join(RUNTIME, c)) ? [`${c}.uc.js`, c] : [`${c}.uc.js`]));
const AGENT_FILES = AGENT_SCRIPTS.flatMap(c => [
  `${c}.uc.js`,
  ...(fs.existsSync(path.join(RUNTIME, c))
    ? tree(path.join(RUNTIME, c))
        .filter(f => !f.endsWith("/"))
        .map(f => `${c}/${f}`)
    : []),
]);

let tmp;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zenius-install-")));
});
// Folders a case made unlistable (mode 000). rmSync can't remove one, even
// an empty one, so after() gives each its mode back first.
const unlistable = [];
after(() => {
  for (const folder of unlistable) {
    fs.chmodSync(folder, 0o700);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A fake HOME, ZENIUS_HOME and profile root for one test. */
function sandbox(name) {
  const dir = path.join(tmp, name);
  const s = { dir, home: path.join(dir, "home"), zhome: path.join(dir, "home", ".zenius") };
  fs.mkdirSync(s.home, { recursive: true });
  s.record = path.join(s.zhome, "install.json");
  s.profile = (pname = "profile") => {
    const p = path.join(dir, pname);
    fs.mkdirSync(path.join(p, "chrome/utils"), { recursive: true });
    fs.mkdirSync(path.join(p, "chrome/JS"), { recursive: true });
    fs.writeFileSync(path.join(p, "chrome/utils/boot.sys.mjs"), "");
    fs.writeFileSync(path.join(p, "chrome/JS/user.uc.js"), USER_SCRIPT);
    return p;
  };
  s.run = (args, { script = path.join(ROOT, "scripts/install.sh"), env = {} } = {}) => {
    const fullEnv = { ...process.env, HOME: s.home, ZENIUS_HOME: s.zhome, ...env };
    // ZEN_BIN only when a test names an app of its own.
    if (!("ZEN_BIN" in env)) {
      delete fullEnv.ZEN_BIN;
    }
    guardHome(fullEnv, "install.test.mjs");
    const r = spawnSync("bash", [script, ...args], { env: fullEnv, encoding: "utf8" });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  s.install = (p, ...more) => {
    const r = s.run(["--profile", p, ...more]);
    assert.equal(r.status, 0, r.err);
    return r;
  };
  return s;
}

/** Relative paths of every entry under dir, sorted; links are kept as links. */
function tree(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    out.push(entry.isDirectory() ? rel + "/" : rel);
    if (entry.isDirectory()) {
      out.push(...tree(path.join(dir, entry.name), rel + "/"));
    }
  }
  return out.sort();
}

const readJSON = file => JSON.parse(fs.readFileSync(file, "utf8"));
const mode = file => fs.statSync(file).mode & 0o777;
const backupFrom = out => out.match(/backed up .* to (\S+)$/m)?.[1];

/**
 * tests/fixtures/working-folder.json: the working folder's rules as cases
 * that every reader of them runs, install.sh here. Its "about" says how a
 * case runs.
 */
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/working-folder.json"), "utf8"));
/** config.json as the installers write it. */
const naming = folder => `{\n  "workingFolder": "${folder}"\n}\n`;
const lines = out => out.split("\n");

/** A case's folder, entry or env value in sandbox `s`, with ~ as its HOME and `tokens` filled in. */
function caseFiller(s, tokens) {
  return text =>
    text.replace(/^~(?=\/|$)/, s.home).replace(/\{(\w+)\}/g, (all, name) => {
      assert.ok(name in tokens, `install.sh's cases have no ${all}`);
      return tokens[name];
    });
}

/** Root reads any folder, so a case with one that can't be listed proves nothing then. */
const AS_ROOT = process.getuid?.() === 0;

/** Makes a case's folders that can't be listed (mode 000), after its entries. */
function makeUnlistable(folders, fill) {
  for (const folder of folders ?? []) {
    const p = fill(folder);
    fs.mkdirSync(p, { recursive: true });
    fs.chmodSync(p, 0);
    unlistable.push(p);
  }
}

/** A case's environment: the fixture's defaults, then the case's own, filled in. */
const caseEnv = (c, fill) => Object.fromEntries(Object.entries({ ...FIXTURE.env, ...c.env }).map(([name, value]) => [name, fill(value)]));

/** Makes a case's entries: 'x/' a folder, 'x' an empty file, 'x -> y' a link. One that's there stays. */
function makeEntries(entries, fill) {
  for (const entry of entries ?? []) {
    const [from, to] = entry.split(" -> ");
    const p = fill(from);
    const bare = p.replace(/\/$/, "");
    if (fs.lstatSync(bare, { throwIfNoEntry: false })) {
      continue;
    }
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    if (to !== undefined) {
      fs.symlinkSync(fill(to), bare);
    } else if (p.endsWith("/")) {
      fs.mkdirSync(bare);
    } else {
      fs.writeFileSync(bare, "");
    }
  }
}

const within = (p, folder) => p === folder || p.startsWith(`${folder}/`);

/**
 * install.sh's reason for refusing a case's folder, as it prints it:
 * `folder` as given, and the folder the reason names by its real path.
 */
function refusal(c, folder, fill) {
  const cant = `the working folder can't be ${folder}`;
  switch (c.outcome) {
    case "not-plain":
      return `the working folder must be an absolute path with no double quote, backslash or control character: ${folder}`;
    case "dotdot":
      return `the working folder must be named without a ".." part, which can lead elsewhere through a link: ${folder}`;
    case "not-a-folder":
    case "not-yours":
      return `the working folder must be a folder of yours: ${folder}`;
    case "no-parent":
      return `the working folder's parent folder must exist: ${folder}`;
    case "shared":
      return `${cant}: it's your home folder, a temporary folder, or a folder above one`;
    case "kept": {
      const kept = realPath(fill(c.kept));
      // A kept folder the folder is, or holds, comes first.
      return `${cant}: ${within(kept, realPath(folder)) ? "it holds" : "it's inside"} ${kept}, which the agent's scripts must not reach`;
    }
    case "project":
      return fs.lstatSync(path.join(realPath(folder), ".git"), { throwIfNoEntry: false })
        ? `${cant}: it holds .git, so it's a project's folder`
        : `${cant}: it holds .envrc, which direnv runs`;
    case "worktree":
      return `${cant}: it's inside a git work tree, ${realPath(fill(c.repo))}`;
    default:
      throw new Error(`${c.name}: no wording for the outcome ${c.outcome}`);
  }
}

/** Write a tree under dir: a string is a file's text, an object a folder. */
function writeTree(dir, spec) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(spec)) {
    if (typeof value === "string") {
      fs.writeFileSync(path.join(dir, name), value);
    } else {
      writeTree(path.join(dir, name), value);
    }
  }
}

/**
 * What's at `at`, recursively: each file's text, and with `times` its mtime
 * in whole seconds; each link's target; null when nothing is there.
 */
function snap(at, times = true) {
  const st = fs.lstatSync(at, { throwIfNoEntry: false });
  if (!st) {
    return null;
  }
  if (st.isSymbolicLink()) {
    return { link: fs.readlinkSync(at) };
  }
  if (st.isFile()) {
    const text = fs.readFileSync(at, "utf8");
    return times ? { text, mtime: Math.floor(st.mtimeMs / 1000) } : { text };
  }
  return Object.fromEntries(
    fs
      .readdirSync(at)
      .sort()
      .map(name => [name, snap(path.join(at, name), times)])
  );
}

test("install copies the runtime, never links, and records it twice", () => {
  const s = sandbox("copies");
  const p = s.profile();
  const r = s.install(p);
  assert.match(r.out, new RegExp(`Installing zenius ${RUNTIME_VERSION} \\(protocol ${PROTOCOL_VERSION}`));
  assert.match(r.out, /The next time Zen starts, it will load zenius/);

  const js = path.join(p, "chrome/JS");
  const installed = tree(path.join(js, "zenius"));
  assert.deepEqual(
    installed.filter(f => f !== "install.json"),
    tree(path.join(RUNTIME, "zenius"))
  );
  for (const f of installed.filter(f => !f.endsWith("/") && f !== "install.json")) {
    const at = path.join(js, "zenius", f);
    assert.ok(!fs.lstatSync(at).isSymbolicLink(), `${f} is a link`);
    assert.ok(fs.readFileSync(at).equals(fs.readFileSync(path.join(RUNTIME, "zenius", f))), `${f} differs`);
  }
  assert.ok(!fs.lstatSync(path.join(js, "zenius.uc.js")).isSymbolicLink());
  assert.ok(fs.readFileSync(path.join(js, "zenius.uc.js")).equals(fs.readFileSync(path.join(RUNTIME, "zenius.uc.js"))));
  assert.equal(fs.readFileSync(path.join(js, "user.uc.js"), "utf8"), USER_SCRIPT);
  assert.deepEqual(fs.readdirSync(js).sort(), ["user.uc.js", "zenius", "zenius.uc.js", ...AGENT_TOP].sort());

  const local = readJSON(path.join(js, "zenius/install.json"));
  assert.deepEqual(Object.keys(local).sort(), ["commit", "installedAt", "profile", "protocol", "runtimeVersion"]);
  assert.equal(local.runtimeVersion, RUNTIME_VERSION);
  assert.equal(local.protocol, PROTOCOL_VERSION);
  assert.equal(local.profile, p);
  assert.match(local.commit, /^[0-9a-f]{7,}(-dirty)?$/);
  assert.match(local.installedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

  const record = readJSON(s.record);
  assert.deepEqual(Object.keys(record).sort(), [
    "backup",
    "commit",
    "files",
    "installedAt",
    "profile",
    "protocol",
    "runtimeVersion",
  ]);
  assert.equal(record.profile, p);
  assert.equal(record.backup, null);
  assert.deepEqual(
    { runtimeVersion: record.runtimeVersion, protocol: record.protocol, commit: record.commit, installedAt: record.installedAt },
    { runtimeVersion: local.runtimeVersion, protocol: local.protocol, commit: local.commit, installedAt: local.installedAt }
  );
  assert.deepEqual(record.files, [
    path.join(js, "zenius.uc.js"),
    ...installed.filter(f => !f.endsWith("/")).map(f => path.join(js, "zenius", f)),
    ...AGENT_FILES.map(f => path.join(js, f)),
  ]);
  assert.equal(mode(s.record), 0o600);
  assert.equal(mode(s.zhome), 0o700);
});

test("a reinstall backs up the previous files and replaces the tree whole", () => {
  const s = sandbox("reinstall");
  const p = s.profile();
  s.install(p);
  const zenius = path.join(p, "chrome/JS/zenius");
  fs.appendFileSync(path.join(zenius, "modules/util.sys.mjs"), "// older\n");
  fs.writeFileSync(path.join(zenius, "stray.txt"), "left by an older version\n");
  const r = s.install(p);
  const record = readJSON(s.record);
  assert.equal(backupFrom(r.out), record.backup);
  const saved = path.join(record.backup, "chrome/JS");
  assert.match(fs.readFileSync(path.join(saved, "zenius/modules/util.sys.mjs"), "utf8"), /\/\/ older\n$/);
  assert.ok(fs.existsSync(path.join(saved, "zenius/stray.txt")));
  assert.ok(fs.existsSync(path.join(saved, "zenius.uc.js")));
  assert.ok(!fs.existsSync(path.join(zenius, "stray.txt")));
  assert.ok(
    fs.readFileSync(path.join(zenius, "modules/util.sys.mjs")).equals(fs.readFileSync(path.join(RUNTIME, "zenius/modules/util.sys.mjs")))
  );
  // Nothing of the swap is left behind.
  assert.deepEqual(fs.readdirSync(path.join(p, "chrome/JS")).sort(), ["user.uc.js", "zenius", "zenius.uc.js", ...AGENT_TOP].sort());
});

test("uninstall removes zenius and its record, and backs up what it removed", () => {
  const s = sandbox("uninstall");
  const p = s.profile();
  s.install(p);
  const r = s.run(["--uninstall", "--profile", p]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /it will run without zenius/);
  assert.deepEqual(fs.readdirSync(path.join(p, "chrome/JS")), ["user.uc.js"]);
  assert.equal(fs.readFileSync(path.join(p, "chrome/JS/user.uc.js"), "utf8"), USER_SCRIPT);
  assert.ok(fs.existsSync(path.join(p, "chrome/utils/boot.sys.mjs")));
  assert.ok(!fs.existsSync(s.record));
  const saved = path.join(backupFrom(r.out), "chrome/JS");
  assert.equal(readJSON(path.join(saved, "zenius/install.json")).profile, p);
  assert.ok(fs.existsSync(path.join(saved, "zenius.uc.js")));

  const again = s.run(["--uninstall", "--profile", p]);
  assert.equal(again.status, 1);
  assert.match(again.err, /zenius isn't installed in/);
});

test("uninstall leaves zenius files that install.sh didn't put there", () => {
  const s = sandbox("foreign");
  const p = s.profile();
  fs.writeFileSync(path.join(p, "chrome/JS/zenius.uc.js"), "// copied by hand\n");
  const r = s.run(["--uninstall", "--profile", p]);
  assert.equal(r.status, 1);
  assert.match(r.err, /weren't put there by install\.sh/);
  assert.ok(fs.existsSync(path.join(p, "chrome/JS/zenius.uc.js")));
});

// The one pref zenius sets, only with --disable-ipv6 (the user's choice for
// their own install, 2026-11-20; opt-in since 2026-11-21): no IPv6 lookups.
const DNS_LINE = 'user_pref("network.dns.disableIPv6", true);';
const dnsLines = file =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(line => line.includes('"network.dns.disableIPv6"')) : [];
/** What Zen does at its next start and quit: user.js's value lands in prefs.js too. */
function zenKeeps(p) {
  const prefs = path.join(p, "prefs.js");
  const kept = (fs.existsSync(prefs) ? fs.readFileSync(prefs, "utf8") : "")
    .split("\n")
    .filter(line => line && !line.includes('"network.dns.disableIPv6"'));
  fs.writeFileSync(prefs, [...kept, DNS_LINE, ""].join("\n"));
}

test("install --disable-ipv6 sets network.dns.disableIPv6 in user.js once; uninstall removes it and restores prefs.js", () => {
  const s = sandbox("dns");
  const p = s.profile();
  const PREFS = '// Mozilla User Preferences\nuser_pref("browser.startup.page", 3);\n';
  fs.writeFileSync(path.join(p, "prefs.js"), PREFS);
  const dry = s.install(p, "--dry-run", "--disable-ipv6");
  assert.match(dry.out, /would set network\.dns\.disableIPv6 to true in user\.js/);
  assert.ok(!fs.existsSync(path.join(p, "user.js")));

  const first = s.install(p, "--disable-ipv6").out;
  assert.match(first, /set network\.dns\.disableIPv6 to true in user\.js/);
  assert.doesNotMatch(first, /backed up user\.js/, "there was no user.js to back up");
  assert.equal(readJSON(s.record).backup, null);
  assert.deepEqual(dnsLines(path.join(p, "user.js")), [DNS_LINE]);
  assert.match(s.install(p, "--disable-ipv6").out, /network\.dns\.disableIPv6 is already true in user\.js/);
  assert.deepEqual(dnsLines(path.join(p, "user.js")), [DNS_LINE]);

  zenKeeps(p);
  const un = s.run(["--uninstall", "--profile", p]);
  assert.equal(un.status, 0, un.err);
  assert.ok(!fs.existsSync(path.join(p, "user.js")), "the user.js install.sh made is gone");
  assert.equal(fs.readFileSync(path.join(p, "prefs.js"), "utf8"), PREFS);
  assert.match(un.out, /restored network\.dns\.disableIPv6 in prefs\.js to no value of its own/);
  assert.ok(!fs.existsSync(path.join(s.zhome, "dns-pref.prior")));
});

test("install without --disable-ipv6 leaves user.js as it is, zenius's earlier line included, which uninstall still takes out", () => {
  // No user.js: none is made, and nothing is recorded for uninstall.
  const fresh = sandbox("dns-optin-fresh");
  const f = fresh.profile();
  // The dry run promises no pref (the SDK's rehearsal of the runbook).
  const dry = fresh.install(f, "--dry-run").out;
  assert.match(dry, /change nothing else there:$/m);
  assert.doesNotMatch(dry, /one pref|disableIPv6|user\.js/);
  assert.doesNotMatch(fresh.install(f).out, /disableIPv6|user\.js/);
  assert.ok(!fs.existsSync(path.join(f, "user.js")));
  assert.ok(!fs.existsSync(path.join(fresh.zhome, "dns-pref.prior")));
  // The user's own value stays, byte for byte, and isn't backed up.
  const own = sandbox("dns-optin-own");
  const o = own.profile();
  const USER = 'user_pref("network.dns.disableIPv6", false);';
  fs.writeFileSync(path.join(o, "user.js"), USER);
  assert.doesNotMatch(own.install(o).out, /user\.js/);
  assert.equal(fs.readFileSync(path.join(o, "user.js"), "utf8"), USER);
  // An earlier install's line stays too, and uninstall still restores the pref.
  const earlier = sandbox("dns-optin-earlier");
  const p = earlier.profile();
  earlier.install(p, "--disable-ipv6");
  zenKeeps(p);
  const before = fs.readFileSync(path.join(p, "user.js"), "utf8");
  assert.match(earlier.install(p).out, /network\.dns\.disableIPv6 stays true in user\.js, from an earlier install/);
  assert.equal(fs.readFileSync(path.join(p, "user.js"), "utf8"), before);
  const un = earlier.run(["--uninstall", "--profile", p]);
  assert.equal(un.status, 0, un.err);
  assert.ok(!fs.existsSync(path.join(p, "user.js")));
  assert.deepEqual(dnsLines(path.join(p, "prefs.js")), []);
});

test("uninstall takes zenius's own preferences out of prefs.js and user.js, and keeps them in the backup", () => {
  const s = sandbox("zenius-prefs");
  const p = s.profile();
  const OTHER = 'user_pref("browser.startup.page", 3);';
  // The allow list the runtime writes, and a test's leftover.
  const ALLOW = 'user_pref("zenius.agentTabs.allowPrivateNetworks", "printer.local");';
  const LEFT = 'user_pref("zenius.handoff.quietReload", false);';
  s.install(p, "--disable-ipv6");
  zenKeeps(p);
  fs.appendFileSync(path.join(p, "prefs.js"), [OTHER, ALLOW, ""].join("\n"));
  fs.appendFileSync(path.join(p, "user.js"), LEFT + "\n");
  const un = s.run(["--uninstall", "--profile", p]);
  assert.equal(un.status, 0, un.err);
  const prefs = fs.readFileSync(path.join(p, "prefs.js"), "utf8");
  assert.ok(prefs.includes(OTHER), prefs);
  assert.doesNotMatch(prefs, /"zenius\./);
  assert.ok(!fs.existsSync(path.join(p, "user.js")), "user.js held only zenius's lines, and install.sh made it");
  const kept = fs.readFileSync(path.join(backupFrom(un.out), "zenius-prefs.js"), "utf8");
  assert.ok(kept.includes(ALLOW) && kept.includes(LEFT), kept);
  assert.match(un.out, /removed zenius's 1 preference from prefs\.js/);
  // The backup's prefs.js is the file as it was, the allow list in it.
  assert.ok(fs.readFileSync(path.join(backupFrom(un.out), "prefs.js"), "utf8").includes(ALLOW));
});

test("uninstall's rewrites of prefs.js and user.js keep each file's mode: Zen keeps prefs.js 0600, and keeps whatever mode it finds", () => {
  const s = sandbox("pref-modes");
  const p = s.profile();
  const prefs = path.join(p, "prefs.js");
  const user = path.join(p, "user.js");
  const mode = file => fs.statSync(file).mode & 0o777;
  // The user's own user.js, which uninstall rewrites rather than removes,
  // with a mode of its own, so each file's is seen to stay as it was.
  fs.writeFileSync(user, 'user_pref("browser.tabs.warnOnClose", false);\n', { mode: 0o640 });
  fs.chmodSync(user, 0o640);
  fs.writeFileSync(prefs, '// Mozilla User Preferences\nuser_pref("browser.startup.page", 3);\n', { mode: 0o600 });
  fs.chmodSync(prefs, 0o600);
  s.install(p, "--disable-ipv6");
  zenKeeps(p);
  // A zenius pref in each, so drop_zenius_prefs rewrites both, before the
  // DNS restore rewrites them again.
  fs.appendFileSync(prefs, 'user_pref("zenius.agentTabs.allowPrivateNetworks", "printer.local");\n');
  fs.appendFileSync(user, 'user_pref("zenius.handoff.quietReload", false);\n');
  assert.equal(mode(prefs), 0o600);
  assert.equal(mode(user), 0o640);
  const un = s.run(["--uninstall", "--profile", p]);
  assert.equal(un.status, 0, un.err);
  assert.match(un.out, /removed zenius's 1 preference from prefs\.js/);
  assert.match(un.out, /took zenius's network\.dns\.disableIPv6 lines out of user\.js/);
  assert.equal(mode(prefs).toString(8), "600", "prefs.js stays 0600");
  assert.equal(mode(user).toString(8), "640", "user.js keeps its mode");
  assert.deepEqual(fs.readdirSync(p).filter(name => name.includes(".tmp-")), [], "no temporary file is left");
});

test("uninstall removes this profile's upload and download folders, in the profile and in the temp folder, and no other profile's", () => {
  const s = sandbox("staging");
  const p = s.profile();
  const tmpdir = path.join(s.dir, "tmp");
  fs.mkdirSync(tmpdir);
  // As input/filechooser.sys.mjs and observe/downloads.sys.mjs name them: FNV-1a over the profile's path.
  const fnv = str => {
    let h = 0x811c9dc5;
    for (const ch of str) {
      h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const mine = fnv(p);
  const theirs = fnv(`${p}-other`);
  const ours = [`zenius-upload-${mine}`, `zenius-upload-${mine}-1`, `zenius-downloads-${mine}`, `zenius-downloads-${mine}-2`];
  // downloads.sys.mjs's fixed folder drops the hash's leading zeros; with none, it's zenius-downloads-<hash>.
  const short = parseInt(mine, 16).toString(16);
  if (short !== mine) ours.push(`zenius-downloads-${short}`);
  const dirs = [...ours, `zenius-upload-${theirs}`, `notzenius-upload-${mine}`];
  for (const d of dirs) {
    fs.mkdirSync(path.join(tmpdir, d), { mode: 0o700 });
    fs.writeFileSync(path.join(tmpdir, d, "file"), "x");
  }
  s.install(p);
  // Since 2026-11-21 they live in the profile.
  const inProfile = ["zenius-uploads", "zenius-downloads"];
  for (const d of inProfile) {
    fs.mkdirSync(path.join(p, d, "d1"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(p, d, "d1", "file"), "x");
  }
  // The dry run lists each folder once and removes none.
  const dry = s.run(["--uninstall", "--dry-run", "--profile", p], { env: { TMPDIR: tmpdir } });
  assert.equal(dry.status, 0, dry.err);
  const listed = dry.out.split("\n").filter(line => line.includes("would remove "));
  for (const d of [...ours, ...inProfile]) {
    assert.equal(listed.filter(line => line.endsWith(`/${d}`)).length, 1, `${d} in:\n${dry.out}`);
  }
  assert.equal(fs.readdirSync(tmpdir).length, dirs.length);
  assert.ok(inProfile.every(d => fs.existsSync(path.join(p, d))));
  const un = s.run(["--uninstall", "--profile", p], { env: { TMPDIR: tmpdir } });
  assert.equal(un.status, 0, un.err);
  assert.deepEqual(fs.readdirSync(tmpdir).sort(), [`notzenius-upload-${mine}`, `zenius-upload-${theirs}`]);
  assert.ok(inProfile.every(d => !fs.existsSync(path.join(p, d))));
  assert.match(un.out, new RegExp(`removed ${ours.length + inProfile.length} zenius upload or download folders`));
});

test("it warns, without stopping, when another Zen from the same app runs: how to stop a dev Zen, and that any other is the user's to quit; never for a dev profile", async () => {
  const s = sandbox("other-zens");
  const p = s.profile();
  // A dev profile is one under ~/.zenius-dev/profiles/, as the runtime says.
  const devProfile = path.join(s.home, ".zenius-dev/profiles/try");
  fs.mkdirSync(devProfile, { recursive: true });
  // Stand-ins whose command lines read as the app's: a dev Zen with its own
  // profile, the user's own Zen as the Dock starts it (no profile named),
  // another account's dev profile, which isn't this one's to stop, and a
  // content process, which doesn't count.
  const bin = path.join(s.dir, "Zen.app/Contents/MacOS/zen");
  const fakeZen = (...args) =>
    spawn("bash", ["-c", 'exec -a "$0" "$@"', bin, process.execPath, "-e", "setTimeout(() => {}, 30000)", "--", ...args], { stdio: "ignore" });
  const dev = fakeZen("-profile", devProfile, "--headless");
  const own = fakeZen();
  const elsewhere = fakeZen("-profile", "/x/.zenius-dev/profiles/try");
  const content = fakeZen("-contentproc", "8", "tab");
  const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    for (const end = Date.now() + 5000; ; ) {
      const ps = spawnSync("ps", ["axo", "pid=,command="], { encoding: "utf8" }).stdout;
      if (ps.split(`${bin} -e`).length - 1 >= 4) break;
      assert.ok(Date.now() < end, "the stand-ins didn't start");
      await new Promise(r => setTimeout(r, 50));
    }
    const env = { ZENIUS_APP_BIN: bin };
    const r = s.run(["--profile", p], { env });
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^Done\. The next time Zen starts, it will load zenius .*\nWarning: another Zen from the same app is running\. /m);
    assert.match(r.out, new RegExp(`^  pid ${dev.pid}, profile ${literal(devProfile)}: a dev Zen; stop it with scripts/zen-dev\\.sh try stop$`, "m"));
    // Never an instruction to stop the user's own Zen: only the user quits it.
    assert.match(r.out, new RegExp(`^  pid ${own.pid}: not a dev Zen, so the user quits it themselves$`, "m"));
    assert.match(r.out, new RegExp(`^  pid ${elsewhere.pid}, profile /x/\\.zenius-dev/profiles/try: not a dev Zen, so the user quits it themselves$`, "m"));
    assert.doesNotMatch(r.out, /[Ss]top it before/);
    assert.doesNotMatch(r.out, new RegExp(`pid ${content.pid}\\b`));

    // A dev profile's Zen is started by scripts/zen-dev.sh, beside the
    // others, and the Dock never opens it: no warning there.
    // (Its own record, since one install record names one profile.)
    const devTarget = s.profile("home/.zenius-dev/profiles/target");
    // ZENIUS_HOME elsewhere has no default working folder, so it's named.
    const d = s.run(["--profile", devTarget, "--working-dir", path.join(s.home, "dev-files")], {
      env: { ...env, ZENIUS_HOME: path.join(s.dir, "zenius-dev-target") },
    });
    assert.equal(d.status, 0, d.err);
    assert.doesNotMatch(d.out, /another Zen/);

    // Without the app's binary named, a Linux run looks for nothing. A Mac
    // run looks at /Applications/Zen.app, where the user's own Zen and dev
    // Zens may well run, so only Linux can say none.
    const un = s.run(["--uninstall", "--profile", p]);
    assert.equal(un.status, 0, un.err);
    if (process.platform !== "darwin") {
      assert.doesNotMatch(un.out, /another Zen/);
    }
  } finally {
    for (const zen of [dev, own, elsewhere, content]) zen.kill();
  }
});

test("uninstall gives back the user's own user.js as it was, and the pref's earlier value in prefs.js", () => {
  const s = sandbox("dns-own");
  const p = s.profile();
  const OWN = 'user_pref("network.dns.disableIPv6", false);';
  // The user's own user.js, without a last newline.
  const USER = `// the user's own\n${OWN}\nuser_pref("ui.key.menuAccessKeyFocuses", false);`;
  fs.writeFileSync(path.join(p, "user.js"), USER);
  fs.writeFileSync(path.join(p, "prefs.js"), `user_pref("a.b", 1);\n${OWN}\n`);
  const installed = s.install(p, "--disable-ipv6").out;
  // The SDK's install rehearsal: a first install backs up user.js before
  // adding its line, and says so, in its output and in install.json.
  const folder = installed.match(/^  backed up user\.js to (\S+)$/m)?.[1];
  assert.ok(folder?.startsWith(path.join(s.zhome, "backups")), installed);
  assert.match(installed, /no zenius files to back up/);
  assert.equal(readJSON(s.record).backup, folder, "install.json names the folder user.js went to");
  assert.equal(fs.readFileSync(path.join(folder, "user.js"), "utf8"), USER, "the backup is the user's own user.js");
  // zenius's line comes last, so it wins over theirs.
  assert.deepEqual(dnsLines(path.join(p, "user.js")), [OWN, DNS_LINE]);
  zenKeeps(p);
  const un = s.run(["--uninstall", "--profile", p]);
  assert.equal(un.status, 0, un.err);
  assert.equal(fs.readFileSync(path.join(p, "user.js"), "utf8"), USER);
  assert.deepEqual(dnsLines(path.join(p, "prefs.js")), [OWN]);
  assert.match(un.out, /restored network\.dns\.disableIPv6 in prefs\.js to user_pref\("network\.dns\.disableIPv6", false\);/);
});

test("an uninstall while Zen runs restores prefs.js only at a second uninstall, once Zen has quit", () => {
  const s = sandbox("dns-running");
  const p = s.profile();
  s.install(p, "--disable-ipv6");
  zenKeeps(p);
  fs.symlinkSync(`127.0.0.1:+${process.pid}`, path.join(p, "lock"));
  const un = s.run(["--uninstall", "--profile", p, "--while-running"]);
  assert.equal(un.status, 0, un.err);
  assert.match(un.out, /Once it has quit, run install\.sh --uninstall again/);
  assert.ok(!fs.existsSync(path.join(p, "user.js")));
  assert.deepEqual(dnsLines(path.join(p, "prefs.js")), [DNS_LINE]);
  // Until then no other profile gets zenius: the restore would be lost.
  const other = s.profile("other");
  const elsewhere = s.run(["--profile", other, "--disable-ipv6"]);
  assert.equal(elsewhere.status, 1);
  assert.match(elsewhere.err, /network\.dns\.disableIPv6 still has to be restored in/);

  fs.unlinkSync(path.join(p, "lock"));
  const again = s.run(["--uninstall", "--profile", p]);
  assert.equal(again.status, 0, again.err);
  assert.deepEqual(dnsLines(path.join(p, "prefs.js")), []);
  assert.ok(!fs.existsSync(path.join(s.zhome, "dns-pref.prior")));
  assert.equal(s.run(["--uninstall", "--profile", p]).status, 1);
});

test("while Zen has the profile open, it changes zenius only with --while-running", () => {
  const s = sandbox("running");
  const p = s.profile();
  // Linux Zen's lock link names a live pid: ours.
  fs.symlinkSync(`127.0.0.1:+${process.pid}`, path.join(p, "lock"));
  // A first install is fine: nothing of zenius runs yet.
  assert.match(s.install(p).out, /Zen is running: quit it and reopen it to load zenius/);
  const { installedAt } = readJSON(s.record);

  for (const args of [["--profile", p], ["--uninstall", "--profile", p]]) {
    const r = s.run(args);
    assert.equal(r.status, 1);
    assert.match(r.err, new RegExp(`Zen \\(pid ${process.pid}\\) has this profile open, and zenius is installed in it`));
  }
  assert.equal(readJSON(s.record).installedAt, installedAt);
  assert.match(s.install(p, "--while-running").out, /Zen is running: quit it and reopen it/);

  // The Mac's Zen leaves no lock link and only holds .parentlock open.
  fs.unlinkSync(path.join(p, "lock"));
  if (process.platform === "darwin") {
    const fd = fs.openSync(path.join(p, ".parentlock"), "w");
    try {
      const r = s.run(["--profile", p]);
      assert.equal(r.status, 1);
      assert.match(r.err, /has this profile open/);
    } finally {
      fs.closeSync(fd);
    }
  }
  assert.equal(s.run(["--uninstall", "--profile", p]).status, 0);
});

test("without --profile it takes the profile Zen opens, from profiles.ini", () => {
  const s = sandbox("ini");
  const zenDir =
    process.platform === "darwin" ? path.join(s.home, "Library/Application Support/zen") : path.join(s.home, ".zen");
  fs.mkdirSync(zenDir, { recursive: true });
  for (const name of ["a", "b", "c"]) {
    const p = path.join(zenDir, "Profiles", name);
    fs.mkdirSync(path.join(p, "chrome/utils"), { recursive: true });
    fs.writeFileSync(path.join(p, "chrome/utils/boot.sys.mjs"), "");
  }
  const ini = (text) => fs.writeFileSync(path.join(zenDir, "profiles.ini"), text);
  const chosen = () => {
    const r = s.run(["--dry-run"]);
    assert.equal(r.status, 0, r.err);
    return [r.out.match(/ into (.*)$/m)[1], r.out.match(/profile chosen by: .*profiles\.ini, (.*)$/m)?.[1]];
  };
  const FROM_INSTALL = "the Default= of its [Install…] section (the profile Zen opens)";
  const FROM_PROFILE = "its [Profile…] section with Default=1";
  const profiles = "[Profile1]\nName=b\nIsRelative=1\nPath=Profiles/b\nDefault=1\n\n[Profile0]\nName=c\nIsRelative=1\nPath=Profiles/c\n\n";
  ini(`${profiles}[General]\nStartWithLastProfile=1\nVersion=2\n`);
  assert.deepEqual(chosen(), [path.join(zenDir, "Profiles/b"), FROM_PROFILE]);
  // Each installation's [Install…] default wins (CRLF line ends too).
  ini(`[InstallABCDEF]\r\nDefault=Profiles/a\r\nLocked=1\r\n\r\n${profiles}`);
  assert.deepEqual(chosen(), [path.join(zenDir, "Profiles/a"), FROM_INSTALL]);
  ini(`[InstallABCDEF]\nDefault=Profiles/a\n\n[Install123456]\nDefault=Profiles/a\n\n${profiles}`);
  assert.deepEqual(chosen(), [path.join(zenDir, "Profiles/a"), FROM_INSTALL]);
  // Installations that disagree: ask.
  ini(`[InstallABCDEF]\nDefault=Profiles/a\n\n[Install123456]\nDefault=Profiles/c\n\n${profiles}`);
  const r = s.run(["--dry-run"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /names a different default profile for each Zen installation[\s\S]*Profiles\/a[\s\S]*Profiles\/c[\s\S]*Pass --profile/);
});

/** fx-autoconfig's loader as runtime/vendor has it, which --loader copies in. */
const LOADER = path.join(ROOT, "runtime/vendor/fx-autoconfig/profile/chrome/utils");
const LOADER_FILES = fs.readdirSync(LOADER).sort();

test("--loader adds fx-autoconfig's loader from runtime/vendor to a profile with none, a fresh Zen's, and uninstall takes out exactly that, after a backup", () => {
  const s = sandbox("loader");
  const p = path.join(s.dir, "fresh");
  fs.mkdirSync(p);
  const refused = s.run(["--profile", p]);
  assert.equal(refused.status, 1);
  assert.match(refused.err, /has no fx-autoconfig .*With --loader, install\.sh adds the copy in runtime\/vendor\/fx-autoconfig/);
  const dry = s.run(["--profile", p, "--loader", "--dry-run"]);
  assert.equal(dry.status, 0, dry.err);
  assert.ok(dry.out.includes(`would add fx-autoconfig's loader from runtime/vendor/fx-autoconfig: ${LOADER_FILES.length} files in chrome/utils`), dry.out);
  assert.equal(fs.existsSync(path.join(p, "chrome")), false, "a dry run adds nothing");

  const r = s.install(p, "--loader");
  assert.ok(r.out.includes(`added fx-autoconfig's loader from runtime/vendor/fx-autoconfig: ${LOADER_FILES.length} files in chrome/utils`), r.out);
  assert.deepEqual(fs.readdirSync(path.join(p, "chrome/utils")).sort(), LOADER_FILES);
  for (const f of LOADER_FILES) {
    assert.ok(fs.readFileSync(path.join(p, "chrome/utils", f)).equals(fs.readFileSync(path.join(LOADER, f))), f);
  }
  assert.ok(fs.existsSync(path.join(p, "chrome/JS/zenius.uc.js")));
  // A reinstall finds the loader there and adds nothing.
  const again = s.install(p, "--loader");
  assert.match(again.out, /the profile has fx-autoconfig's loader already: --loader leaves it as it is/);

  // What the user puts in chrome/utils is theirs.
  fs.writeFileSync(path.join(p, "chrome/utils/mine.txt"), "mine\n");
  const un = s.run(["--uninstall", "--profile", p]);
  assert.equal(un.status, 0, un.err);
  assert.ok(un.out.includes(`removed fx-autoconfig's loader, which --loader added: ${LOADER_FILES.length} files`), un.out);
  assert.deepEqual(fs.readdirSync(path.join(p, "chrome/utils")), ["mine.txt"]);
  const backup = un.out.match(/backed up what it removed to (\S+)/)[1];
  assert.deepEqual(fs.readdirSync(path.join(backup, "chrome/utils")).sort(), LOADER_FILES, "the loader is in the backup");
  assert.equal(fs.existsSync(path.join(s.zhome, "loader.added")), false, "nothing noted any more");
  assert.equal(s.run(["--uninstall", "--profile", p]).status, 1, "nothing of zenius's is left to remove");
});

test("--loader leaves a profile's own loader as it is, and uninstall leaves the loader it added while other scripts in chrome/JS run on it", () => {
  const s = sandbox("loader-kept");
  const own = s.profile("own");
  const r = s.install(own, "--loader");
  assert.match(r.out, /the profile has fx-autoconfig's loader already: --loader leaves it as it is/);
  assert.equal(fs.existsSync(path.join(s.zhome, "loader.added")), false);
  assert.equal(s.run(["--uninstall", "--profile", own]).status, 0);
  assert.deepEqual(fs.readdirSync(path.join(own, "chrome/utils")), ["boot.sys.mjs"], "the user's loader stays");

  const fresh = path.join(s.dir, "fresh");
  fs.mkdirSync(fresh);
  s.install(fresh, "--loader");
  // The user adds a script of their own, which runs on the loader.
  fs.writeFileSync(path.join(fresh, "chrome/JS/mine.uc.js"), USER_SCRIPT);
  const un = s.run(["--uninstall", "--profile", fresh]);
  assert.equal(un.status, 0, un.err);
  assert.match(un.out, /left fx-autoconfig's loader, which --loader added, in place: other scripts in chrome\/JS run on it/);
  assert.ok(fs.existsSync(path.join(fresh, "chrome/utils/boot.sys.mjs")));
  assert.equal(fs.existsSync(path.join(fresh, "chrome/JS/zenius.uc.js")), false);
  // Once their script is gone, the next uninstall takes the loader out.
  fs.rmSync(path.join(fresh, "chrome/JS/mine.uc.js"));
  const later = s.run(["--uninstall", "--profile", fresh]);
  assert.equal(later.status, 0, later.err);
  assert.match(later.out, /zenius isn't in .* any more; removing fx-autoconfig's loader, which --loader added/);
  assert.equal(fs.existsSync(path.join(fresh, "chrome/utils")), false);
});

test("--dry-run changes nothing", () => {
  const s = sandbox("dry");
  const p = s.profile();
  const snapshot = () => [tree(s.dir), fs.readFileSync(path.join(p, "chrome/JS/user.uc.js"), "utf8")];
  let before = snapshot();
  const r = s.run(["--profile", p, "--dry-run"]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /would run: cp -R/);
  assert.match(r.out, /dry run: nothing changed/);
  assert.deepEqual(snapshot(), before);
  // It shows everything the install would write, relative to the profile,
  // so the user can check it before anything changes.
  assert.match(r.out, /profile chosen by: --profile/);
  assert.match(r.out, /no running Zen has this profile open/);
  const listed = [...r.out.matchAll(/^    (chrome\/JS\/\S.*)$/gm)].map(m => m[1]);
  const runtimeFiles = tree(path.join(ROOT, "runtime/JS/zenius"))
    .filter(f => !f.endsWith("/"))
    .map(f => `chrome/JS/zenius/${f}`);
  assert.deepEqual(
    listed,
    ["chrome/JS/zenius.uc.js", "chrome/JS/zenius/install.json", ...runtimeFiles, ...AGENT_FILES.map(f => `chrome/JS/${f}`)].sort()
  );
  assert.match(r.out, new RegExp(`would write these ${listed.length} files in the profile`));
  assert.ok(r.out.includes(`would record the install in ${s.record}`), r.out);
  assert.match(r.out, /no zenius files to back up: the profile has none yet/);

  s.install(p);
  before = snapshot();
  const again = s.run(["--profile", p, "--dry-run"]);
  assert.equal(again.status, 0);
  assert.match(again.out, /would back up the zenius files it replaces to /);
  const un = s.run(["--uninstall", "--profile", p, "--dry-run"]);
  assert.equal(un.status, 0);
  assert.match(un.out, /would back up what it removes to /);
  assert.match(un.out, /left in place: /);
  assert.deepEqual(snapshot(), before);
});

test("it refuses a profile without fx-autoconfig, and a second profile", () => {
  const s = sandbox("refuse");
  const bare = path.join(s.dir, "bare");
  fs.mkdirSync(bare);
  const r = s.run(["--profile", bare]);
  assert.equal(r.status, 1);
  assert.match(r.err, /has no fx-autoconfig/);

  // One install at a time: both would serve instance "default".
  const p1 = s.profile("one");
  const p2 = s.profile("two");
  s.install(p1);
  const second = s.run(["--profile", p2]);
  assert.equal(second.status, 1);
  assert.match(second.err, new RegExp(`zenius is installed in another profile, ${p1}`));
  assert.equal(s.run(["--uninstall", "--profile", p1]).status, 0);
  s.install(p2);
  assert.equal(readJSON(s.record).profile, p2);
});

test("Undo takes out the sidebar's agent workspace after a backup, and install never touches it", () => {
  const s = sandbox("workspace");
  const p = s.profile();
  s.install(p);
  // What zenius's sidebar writes there: Claude Code's limits, and Codex's folder.
  const ws = path.join(p, "agent-sidebar-workspace");
  writeTree(ws, { claude: { ".claude": { "settings.json": "{}\n" } }, codex: { "notes.txt": "left by Codex\n" } });
  const written = snap(ws);
  // And the user's chats with it, which stay theirs: its Work tasks, and
  // each tab's Chat (the sidebar's chat persistence).
  const chats = path.join(p, "agent-sidebar-tasks.json");
  const tabChats = path.join(p, "agent-sidebar-chats.json");
  fs.writeFileSync(chats, '{"tasks":[{"title":"a chat"}]}\n');
  fs.writeFileSync(tabChats, '{"chats":[{"title":"a tab\'s chat"}]}\n');
  s.install(p);
  assert.deepEqual(snap(ws), written);
  const dry = s.run(["--uninstall", "--profile", p, "--dry-run"]);
  assert.equal(dry.status, 0, dry.err);
  assert.ok(dry.out.includes(`would remove the sidebar's agent workspace, ${ws}, keeping it in the backup`), dry.out);
  assert.ok(dry.out.includes(`the sidebar's chats (${chats}, ${tabChats})`), dry.out);
  assert.deepEqual(snap(ws), written);
  const un = s.run(["--uninstall", "--profile", p]);
  assert.equal(un.status, 0, un.err);
  assert.ok(!fs.existsSync(ws));
  const left = un.out.split("\n").find(line => line.includes("left in place: "));
  assert.ok(left?.includes(`, the sidebar's chats (${chats}, ${tabChats}), and the Agents Space`), un.out);
  assert.equal(fs.readFileSync(chats, "utf8"), '{"tasks":[{"title":"a chat"}]}\n');
  assert.equal(fs.readFileSync(tabChats, "utf8"), '{"chats":[{"title":"a tab\'s chat"}]}\n');
  const kept = un.out.match(/removed the sidebar's agent workspace, .* \(kept in (\S+)\)$/m)?.[1];
  assert.ok(kept, un.out);
  assert.deepEqual(snap(path.join(kept, "agent-sidebar-workspace")), written);
  // One that an uninstall which didn't know it left behind goes too.
  writeTree(ws, { codex: { "notes.txt": "left by Codex\n" } });
  const again = s.run(["--uninstall", "--profile", p]);
  assert.equal(again.status, 0, again.err);
  assert.match(again.out, /zenius isn't in .* any more; removing the sidebar's agent workspace it left/);
  assert.ok(!fs.existsSync(ws));
  assert.equal(s.run(["--uninstall", "--profile", p]).status, 1);
  // With only the tabs' chats, the line names that file alone.
  fs.rmSync(chats);
  s.install(p);
  const only = s.run(["--uninstall", "--profile", p]);
  assert.equal(only.status, 0, only.err);
  const onlyLeft = only.out.split("\n").find(line => line.includes("left in place: "));
  assert.ok(onlyLeft?.includes(`, the sidebar's chats (${tabChats}), and the Agents Space`), only.out);
  assert.ok(fs.existsSync(tabChats));
});

// The agent's scripts beside the runtime (install.sh's COMPONENTS), as a
// checkout ships them, and an earlier sidebar as the profile holds it
// before zenius, with a link that must come back as a link.
const ZENIUS_AGENT = {
  "agent-sidebar.uc.js": "// zenius's agent sidebar\n",
  "agent-sidebar": { "panel.mjs": "// zenius's panel\n", "style.css": "/* zenius's */\n" },
  "agent-urlbar.uc.js": "// zenius's agent urlbar\n",
  "agent-urlbar": { "dispatch.mjs": "// zenius's dispatch\n" },
};
const USERS_SIDEBAR = {
  "agent-sidebar.uc.js": "// an earlier agent sidebar\n",
  "agent-sidebar": {
    "panel.mjs": "// its panel\n",
    "old.css": "/* its */\n",
    lib: { "util.mjs": "// its util\n" },
  },
};
const OWN_SIDEBAR = /backed up the profile's own agent-sidebar to (.+); zenius's takes its place, and uninstall puts it back$/m;
/**
 * install.sh's notes (components.prior) as [profile, name, backup folder],
 * after checking each line's fingerprint of zenius's copy: "<crc>-<size>".
 */
function notes(prior) {
  return fs
    .readFileSync(prior, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const fields = line.split("\t");
      assert.equal(fields.length, 4, line);
      assert.match(fields[3], /^\d+-\d+$/, line);
      return fields.slice(0, 3);
    });
}

/** A checkout with this one's runtime and install.sh, and `agent` as its agent's scripts. */
function checkoutWith(name, agent) {
  const dir = path.join(tmp, `checkout-${name}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "scripts/install.sh"), path.join(dir, "scripts/install.sh"));
    fs.copyFileSync(path.join(ROOT, "scripts/working-folder.sh"), path.join(dir, "scripts/working-folder.sh"));
    fs.mkdirSync(path.join(dir, "runtime/JS"), { recursive: true });
    fs.copyFileSync(path.join(RUNTIME, "zenius.uc.js"), path.join(dir, "runtime/JS/zenius.uc.js"));
    fs.cpSync(path.join(RUNTIME, "zenius"), path.join(dir, "runtime/JS/zenius"), { recursive: true });
    writeTree(path.join(dir, "runtime/JS"), agent);
  }
  return path.join(dir, "scripts/install.sh");
}

/**
 * A profile with an earlier sidebar and a script of the user's own, and
 * the sidebar's own data under the fake HOME. `others()` is what no run may
 * change; `users()` that earlier sidebar as it is now.
 */
function usersProfile(s) {
  const p = s.profile();
  const js = path.join(p, "chrome/JS");
  writeTree(js, USERS_SIDEBAR);
  fs.symlinkSync("panel.mjs", path.join(js, "agent-sidebar/alias.mjs"));
  fs.writeFileSync(path.join(js, "own-script.uc.js"), "// a script of the user's own\n");
  const data = path.join(s.home, "Library/Application Support/zenius-agent-sidebar");
  writeTree(data, { "config.json": "{}\n", adapters: { "claude.json": "{}\n" } });
  const others = () => ({
    autofill: snap(path.join(js, "own-script.uc.js")),
    user: snap(path.join(js, "user.uc.js")),
    data: snap(data),
  });
  const users = () => ({ script: snap(path.join(js, "agent-sidebar.uc.js")), folder: snap(path.join(js, "agent-sidebar")) });
  return { p, js, others, users, prior: path.join(s.zhome, "components.prior") };
}

test("install puts zenius's agent scripts in place of an earlier sidebar and keeps it; Undo gives it back as it was", () => {
  const s = sandbox("agent");
  const { p, js, others, users, prior } = usersProfile(s);
  const script = checkoutWith("agent", ZENIUS_AGENT);
  const shipped = path.join(path.dirname(script), "../runtime/JS");
  const theirs = users();
  const before = others();

  const r = s.run(["--profile", p], { script });
  assert.equal(r.status, 0, r.err);
  const kept = r.out.match(OWN_SIDEBAR)?.[1];
  assert.ok(kept, r.out);
  // zenius's copies, whole: nothing of the earlier sidebar lingers in the folder.
  for (const name of ["agent-sidebar.uc.js", "agent-sidebar", "agent-urlbar.uc.js", "agent-urlbar"]) {
    assert.deepEqual(snap(path.join(js, name), false), snap(path.join(shipped, name), false), name);
  }
  assert.deepEqual(
    { script: snap(path.join(kept, "chrome/JS/agent-sidebar.uc.js")), folder: snap(path.join(kept, "chrome/JS/agent-sidebar")) },
    theirs
  );
  assert.deepEqual(notes(prior), [
    [p, "agent-sidebar", kept],
    [p, "agent-urlbar", ""],
  ]);
  assert.equal(mode(prior), 0o600);
  assert.deepEqual(others(), before);
  const record = readJSON(s.record);
  assert.equal(record.backup, kept);
  assert.deepEqual(
    record.files.filter(f => !f.startsWith(path.join(js, "zenius"))),
    ["agent-sidebar.uc.js", "agent-sidebar/panel.mjs", "agent-sidebar/style.css", "agent-urlbar.uc.js", "agent-urlbar/dispatch.mjs"].map(f =>
      path.join(js, f)
    )
  );
  assert.deepEqual(Object.keys(readJSON(path.join(js, "zenius/install.json"))).sort(), [
    "commit",
    "installedAt",
    "profile",
    "protocol",
    "runtimeVersion",
  ]);

  // A reinstall replaces zenius's copy, and the note still names the earlier one.
  const again = s.run(["--profile", p], { script });
  assert.equal(again.status, 0, again.err);
  assert.doesNotMatch(again.out, /the profile's own/);
  const replaced = backupFrom(again.out);
  assert.notEqual(replaced, kept);
  assert.equal(fs.readFileSync(path.join(replaced, "chrome/JS/agent-sidebar.uc.js"), "utf8"), ZENIUS_AGENT["agent-sidebar.uc.js"]);
  assert.deepEqual(notes(prior), [
    [p, "agent-sidebar", kept],
    [p, "agent-urlbar", ""],
  ]);

  const un = s.run(["--uninstall", "--profile", p], { script });
  assert.equal(un.status, 0, un.err);
  assert.ok(un.out.includes(`put back the profile's own agent-sidebar from ${kept}`), un.out);
  assert.match(un.out, /removed agent-urlbar \(the profile had none before zenius\)/);
  assert.deepEqual(users(), theirs);
  assert.deepEqual(fs.readdirSync(js).sort(), ["agent-sidebar", "agent-sidebar.uc.js", "own-script.uc.js", "user.uc.js"]);
  assert.deepEqual(others(), before);
  assert.ok(!fs.existsSync(prior));
  const removed = backupFrom(un.out);
  assert.equal(fs.readFileSync(path.join(removed, "chrome/JS/agent-sidebar.uc.js"), "utf8"), ZENIUS_AGENT["agent-sidebar.uc.js"]);
  assert.ok(fs.existsSync(path.join(removed, "chrome/JS/agent-urlbar/dispatch.mjs")));
});

test("a dry run with the agent's scripts changes nothing, and says it would replace the earlier sidebar", () => {
  const s = sandbox("agent-dry");
  const { p } = usersProfile(s);
  const script = checkoutWith("agent", ZENIUS_AGENT);
  let before = snap(s.dir);
  const r = s.run(["--profile", p, "--dry-run"], { script });
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /would back up the profile's own agent-sidebar to \S+ and put zenius's in its place; uninstall puts it back/);
  const listed = [...r.out.matchAll(/^    (chrome\/JS\/\S.*)$/gm)].map(m => m[1]);
  for (const f of ["agent-sidebar.uc.js", "agent-sidebar/panel.mjs", "agent-sidebar/style.css", "agent-urlbar.uc.js", "agent-urlbar/dispatch.mjs"]) {
    assert.ok(listed.includes(`chrome/JS/${f}`), f);
  }
  assert.deepEqual(snap(s.dir), before);

  assert.equal(s.run(["--profile", p], { script }).status, 0);
  before = snap(s.dir);
  const un = s.run(["--uninstall", "--profile", p, "--dry-run"], { script });
  assert.equal(un.status, 0, un.err);
  assert.match(un.out, /would put back the profile's own agent-sidebar from /);
  assert.match(un.out, /would remove agent-urlbar \(the profile had none before zenius\)/);
  assert.deepEqual(snap(s.dir), before);
});

test("if the backup of the earlier sidebar is gone, Undo leaves zenius's in place", () => {
  const s = sandbox("agent-lost");
  const { p, js, prior } = usersProfile(s);
  const script = checkoutWith("agent", ZENIUS_AGENT);
  const kept = s.run(["--profile", p], { script }).out.match(OWN_SIDEBAR)?.[1];
  assert.ok(kept);
  fs.rmSync(kept, { recursive: true });
  const un = s.run(["--uninstall", "--profile", p], { script });
  assert.equal(un.status, 0, un.err);
  assert.ok(un.out.includes(`left zenius's agent-sidebar in place: the profile's own copy was kept in ${kept}, which is gone`), un.out);
  assert.equal(fs.readFileSync(path.join(js, "agent-sidebar.uc.js"), "utf8"), ZENIUS_AGENT["agent-sidebar.uc.js"]);
  assert.ok(!fs.existsSync(path.join(js, "agent-urlbar.uc.js")));
  assert.ok(!fs.existsSync(prior));
});

test("an install from a checkout without one of the agent's scripts gives back the earlier copy of it", () => {
  const s = sandbox("agent-gone");
  const { p, js, users, prior } = usersProfile(s);
  const theirs = users();
  const kept = s.run(["--profile", p], { script: checkoutWith("agent", ZENIUS_AGENT) }).out.match(OWN_SIDEBAR)?.[1];
  assert.ok(kept);
  const { "agent-urlbar.uc.js": urlbar, "agent-urlbar": folder } = ZENIUS_AGENT;
  const script = checkoutWith("urlbar-only", { "agent-urlbar.uc.js": urlbar, "agent-urlbar": folder });
  const r = s.run(["--profile", p], { script });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes(`put back the profile's own agent-sidebar from ${kept}`), r.out);
  assert.deepEqual(users(), theirs);
  assert.equal(fs.readFileSync(path.join(js, "agent-urlbar.uc.js"), "utf8"), urlbar);
  assert.deepEqual(notes(prior), [[p, "agent-urlbar", ""]]);
  assert.ok(!readJSON(s.record).files.some(f => f.includes("agent-sidebar")));

  assert.equal(s.run(["--uninstall", "--profile", p], { script }).status, 0);
  assert.deepEqual(users(), theirs);
  assert.ok(!fs.existsSync(path.join(js, "agent-urlbar.uc.js")));
  assert.ok(!fs.existsSync(prior));
});

test("while Zen runs an earlier sidebar, a first install replaces it only with --while-running", () => {
  const s = sandbox("agent-running");
  const { p, js, users, prior } = usersProfile(s);
  const script = checkoutWith("agent", ZENIUS_AGENT);
  const theirs = users();
  fs.symlinkSync(`127.0.0.1:+${process.pid}`, path.join(p, "lock"));
  const r = s.run(["--profile", p], { script });
  assert.equal(r.status, 1);
  assert.match(r.err, new RegExp(`Zen \\(pid ${process.pid}\\) has this profile open, and runs its agent-sidebar, which this would change`));
  assert.deepEqual(users(), theirs);
  assert.ok(!fs.existsSync(path.join(js, "zenius.uc.js")));
  assert.ok(!fs.existsSync(prior));
  assert.equal(s.run(["--profile", p, "--while-running"], { script }).status, 0);
  fs.unlinkSync(path.join(p, "lock"));
  assert.equal(s.run(["--uninstall", "--profile", p], { script }).status, 0);
  assert.deepEqual(users(), theirs);
});

test("a reinstall after another installer put its sidebar back keeps that copy for Undo", () => {
  const s = sandbox("agent-put-back");
  const { p, js, prior } = usersProfile(s);
  const script = checkoutWith("agent", ZENIUS_AGENT);
  const first = s.run(["--profile", p], { script }).out.match(OWN_SIDEBAR)?.[1];
  assert.ok(first);
  // Another installer links its working copy back in, over zenius's.
  const dev = path.join(s.dir, "dev");
  writeTree(dev, { "agent-sidebar.uc.js": "// a newer sidebar\n", "agent-sidebar": { "panel.mjs": "// newer\n" } });
  const devBefore = snap(dev);
  fs.rmSync(path.join(js, "agent-sidebar.uc.js"));
  fs.rmSync(path.join(js, "agent-sidebar"), { recursive: true });
  fs.symlinkSync(path.join(dev, "agent-sidebar.uc.js"), path.join(js, "agent-sidebar.uc.js"));
  fs.symlinkSync(path.join(dev, "agent-sidebar"), path.join(js, "agent-sidebar"));
  const theirs = { script: snap(path.join(js, "agent-sidebar.uc.js")), folder: snap(path.join(js, "agent-sidebar")) };

  const r = s.run(["--profile", p], { script });
  assert.equal(r.status, 0, r.err);
  const kept = r.out.match(
    /backed up the profile's own agent-sidebar \(changed since zenius installed it\) to (.+); zenius's takes its place, and uninstall puts it back$/m
  )?.[1];
  assert.ok(kept, r.out);
  // The backup holds the links as links, not what they lead to.
  assert.deepEqual(
    { script: snap(path.join(kept, "chrome/JS/agent-sidebar.uc.js")), folder: snap(path.join(kept, "chrome/JS/agent-sidebar")) },
    { script: { link: path.join(dev, "agent-sidebar.uc.js") }, folder: { link: path.join(dev, "agent-sidebar") } }
  );
  assert.deepEqual(notes(prior), [
    [p, "agent-sidebar", kept],
    [p, "agent-urlbar", ""],
  ]);
  assert.equal(fs.readFileSync(path.join(js, "agent-sidebar.uc.js"), "utf8"), ZENIUS_AGENT["agent-sidebar.uc.js"]);
  assert.ok(!fs.lstatSync(path.join(js, "agent-sidebar")).isSymbolicLink());
  // zenius never wrote through those links.
  assert.deepEqual(snap(dev), devBefore);

  const un = s.run(["--uninstall", "--profile", p], { script });
  assert.equal(un.status, 0, un.err);
  assert.ok(un.out.includes(`put back the profile's own agent-sidebar from ${kept}`), un.out);
  assert.deepEqual({ script: snap(path.join(js, "agent-sidebar.uc.js")), folder: snap(path.join(js, "agent-sidebar")) }, theirs);
  assert.deepEqual(snap(dev), devBefore);
  assert.ok(!fs.existsSync(prior));
});

test("Undo leaves a sidebar the user put there after zenius's", () => {
  const s = sandbox("agent-changed");
  const { p, js, prior } = usersProfile(s);
  const script = checkoutWith("agent", ZENIUS_AGENT);
  assert.equal(s.run(["--profile", p], { script }).status, 0);
  fs.writeFileSync(path.join(js, "agent-sidebar.uc.js"), "// a newer sidebar\n");
  const theirs = { script: snap(path.join(js, "agent-sidebar.uc.js")), folder: snap(path.join(js, "agent-sidebar")) };
  const dry = s.run(["--uninstall", "--profile", p, "--dry-run"], { script });
  assert.equal(dry.status, 0, dry.err);
  assert.match(dry.out, /would leave agent-sidebar in place: it changed since zenius installed it, so it's the user's own/);
  const un = s.run(["--uninstall", "--profile", p], { script });
  assert.equal(un.status, 0, un.err);
  assert.match(un.out, /left agent-sidebar in place: it changed since zenius installed it, so it's the user's own/);
  assert.deepEqual({ script: snap(path.join(js, "agent-sidebar.uc.js")), folder: snap(path.join(js, "agent-sidebar")) }, theirs);
  assert.ok(!fs.existsSync(path.join(js, "agent-urlbar.uc.js")));
  assert.ok(!fs.existsSync(prior));
});

// The working folder: where the agent's downloads land, named in
// ZENIUS_HOME's config.json (scripts/working-folder.sh).

test("install sets the working folder, ~/zenius-files unless --working-dir says, readable only by you; a reinstall keeps it, and uninstall leaves it with its files", () => {
  const s = sandbox("working");
  const p = s.profile();
  const config = path.join(s.zhome, "config.json");
  const files = path.join(s.home, "zenius-files");
  const first = s.install(p);
  assert.ok(lines(first.out).includes(`  set the working folder: ${files}, in ${config}`), first.out);
  assert.ok(lines(first.out).includes(`  made ${files}, readable only by you`), first.out);
  assert.equal(fs.readFileSync(config, "utf8"), naming(files), "byte for byte, as every reader reads it");
  assert.equal(mode(config), 0o600);
  assert.equal(mode(files), 0o700);
  fs.writeFileSync(path.join(files, "report.pdf"), "a download");

  const again = s.install(p);
  assert.ok(lines(again.out).includes(`  the working folder stays ${files} (${config})`), again.out);
  assert.doesNotMatch(again.out, /^ {2}(set|made) /m);

  // Another folder: set, and made. The files stay where they were.
  const work = path.join(s.home, "work");
  const moved = s.install(p, "--working-dir", work);
  assert.ok(lines(moved.out).includes(`  set the working folder: ${work}, in ${config}`), moved.out);
  assert.ok(lines(moved.out).includes(`  made ${work}, readable only by you`), moved.out);
  assert.equal(fs.readFileSync(config, "utf8"), naming(work));
  assert.equal(fs.readFileSync(path.join(files, "report.pdf"), "utf8"), "a download", "changing it moves no files");
  const kept = s.install(p);
  assert.ok(lines(kept.out).includes(`  the working folder stays ${work} (${config})`), kept.out);

  // A folder that's there keeps its mode and files: here one outside the
  // home folder, in the temporary folder. The option's = form, spelled
  // another way: config.json stores it resolved.
  const mine = path.join(s.dir, "mine");
  fs.mkdirSync(mine);
  fs.chmodSync(mine, 0o750);
  fs.writeFileSync(path.join(mine, "notes.txt"), "mine");
  const taken = s.install(p, `--working-dir=${s.dir}//./mine/`);
  assert.ok(lines(taken.out).includes(`  set the working folder: ${mine}, in ${config}`), taken.out);
  assert.doesNotMatch(taken.out, /^ {2}made /m);
  assert.equal(fs.readFileSync(config, "utf8"), naming(mine));
  assert.equal(mode(mine), 0o750);
  assert.deepEqual(fs.readdirSync(mine), ["notes.txt"]);
  // One an earlier installer stored another way is stored again, resolved.
  fs.writeFileSync(config, naming(`${s.dir}//mine/`));
  const respelled = s.install(p);
  assert.ok(lines(respelled.out).includes(`  set the working folder: ${mine}, in ${config}`), respelled.out);
  assert.equal(fs.readFileSync(config, "utf8"), naming(mine));

  // A dry run says what it would set and make, and does neither.
  const other = path.join(s.home, "other");
  const dry = s.run(["--profile", p, "--dry-run", "--working-dir", other]);
  assert.equal(dry.status, 0, dry.err);
  assert.ok(lines(dry.out).includes(`  would set the working folder: ${other}, in ${config}`), dry.out);
  assert.ok(lines(dry.out).includes(`  would make ${other}, readable only by you`), dry.out);
  assert.ok(!fs.existsSync(other));
  assert.equal(fs.readFileSync(config, "utf8"), naming(mine));

  // Uninstall leaves the setting, and each folder with its files, and says so.
  const un = s.run(["--uninstall", "--profile", p]);
  assert.equal(un.status, 0, un.err);
  assert.match(un.out, new RegExp(`^ {2}left in place: .*the working folder's setting\\), the working folder and its files \\(${mine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\), `, "m"));
  assert.equal(fs.readFileSync(config, "utf8"), naming(mine));
  for (const folder of [files, work, mine]) {
    assert.ok(fs.existsSync(folder), folder);
  }
  assert.equal(fs.readFileSync(path.join(files, "report.pdf"), "utf8"), "a download");
});

test("install refuses each folder tests/fixtures/working-folder.json refuses, with the reason, before anything changes, and takes each one it allows", () => {
  const s = sandbox("working-rules");
  // The profile sits in a folder of its own, which holds no home folder.
  const p = s.profile("profiles/p");
  const app = path.join(s.dir, "app");
  fs.mkdirSync(app);
  const tokens = { profile: p, profiles: path.join(s.dir, "profiles"), app };
  const fill = caseFiller(s, tokens);
  s.install(p);
  const config = path.join(s.zhome, "config.json");
  const before = fs.readFileSync(config, "utf8");
  const profile = snap(p, false);
  const failed = [];
  let ran = 0;
  for (const c of FIXTURE.cases) {
    if (c.outcome === "allowed" || (c.by && !c.by.includes("install.sh")) || (c.unlistable && AS_ROOT)) {
      continue;
    }
    // install.sh names Zen's app by ZEN_BIN on Linux; on a Mac it's /Applications/Zen.app.
    const inApp = c.folder.includes("{app}");
    if (inApp && process.platform === "darwin") {
      continue;
    }
    makeEntries(c.make, fill);
    makeUnlistable(c.unlistable, fill);
    const folder = fill(c.folder);
    const there = fs.lstatSync(folder, { throwIfNoEntry: false });
    const env = { ...caseEnv(c, fill), ...(inApp ? { ZEN_BIN: path.join(app, "zen") } : {}) };
    const r = s.run(["--profile", p, "--working-dir", folder], { env });
    const want = `install.sh: ${refusal(c, folder, fill)}\n`;
    const wrong = [];
    if (r.status !== 1 || !r.err.endsWith(want)) {
      wrong.push(`exit ${r.status}, not 1 and ${JSON.stringify(want)}, after:\n${r.out}${r.err}`);
    }
    if (fs.readFileSync(config, "utf8") !== before) {
      wrong.push("config.json changed");
      fs.writeFileSync(config, before);
    }
    if (!there && fs.lstatSync(folder, { throwIfNoEntry: false })) {
      wrong.push("the folder was made");
    }
    if (wrong.length) {
      failed.push(`${c.name}: ${wrong.join("; ")}`);
    }
    ran++;
  }
  assert.deepEqual(failed, []);
  assert.ok(ran >= 30, `${ran} cases`);
  assert.deepEqual(snap(p, false), profile, "the profile is as the first install left it");

  let n = 0;
  for (const c of FIXTURE.cases) {
    if (c.outcome !== "allowed" || (c.by && !c.by.includes("install.sh")) || (c.unlistable && AS_ROOT)) {
      continue;
    }
    const t = sandbox(`working-allowed-${n++}`);
    const tp = t.profile();
    const tfill = caseFiller(t, {});
    makeEntries(c.make, tfill);
    makeUnlistable(c.unlistable, tfill);
    const folder = tfill(c.folder);
    const env = caseEnv(c, tfill);
    const there = fs.lstatSync(folder, { throwIfNoEntry: false });
    const r = t.run(["--profile", tp, "--working-dir", folder], { env });
    assert.equal(r.status, 0, `${c.name}: ${r.out}${r.err}`);
    assert.equal(fs.readFileSync(path.join(env.ZENIUS_HOME, "config.json"), "utf8"), naming(folder), c.name);
    assert.ok(fs.existsSync(folder), c.name);
    if (!there) {
      assert.equal(mode(folder), 0o700, `${c.name}: made readable only by you`);
    }
  }
  assert.ok(n >= 5, `${n} allowed cases`);
});

test("a config.json edited so it doesn't name the folder as the installers write it stops install with the reason, never falling back to ~/zenius-files, and --working-dir writes it again", () => {
  const s = sandbox("working-configs");
  const p = s.profile();
  const work = path.join(s.home, "work");
  s.install(p, "--working-dir", work);
  const config = path.join(s.zhome, "config.json");
  const files = path.join(s.home, "zenius-files");
  const profile = snap(p, false);
  const reason = `install.sh: ${config} doesn't name the working folder on a line of its own, as the installer writes it: pass --working-dir <folder> to write it again\n`;
  const dotdot = `install.sh: ${config} names the working folder with a ".." part, which can lead elsewhere through a link: pass --working-dir <folder>, named without one, to write it again\n`;
  for (const c of FIXTURE.configs.unreadable) {
    const text = c.text.replaceAll("{folder}", work);
    const want = c.outcome === "dotdot" ? dotdot : reason;
    fs.writeFileSync(config, text);
    for (const more of [[], ["--dry-run"]]) {
      const r = s.run(["--profile", p, ...more]);
      assert.equal(r.status, 1, `${c.name}: ${r.out}${r.err}`);
      assert.ok(r.err.endsWith(want), `${c.name}: ${r.err}`);
    }
    assert.equal(fs.readFileSync(config, "utf8"), text, `${c.name}: config.json is as it was`);
    assert.ok(!fs.existsSync(files), `${c.name}: no ~/zenius-files`);
  }
  assert.deepEqual(snap(p, false), profile, "the profile is as it was");

  // Uninstall takes zenius out all the same, and leaves the file be.
  const un = s.run(["--uninstall", "--profile", p]);
  assert.equal(un.status, 0, un.err);
  assert.doesNotMatch(un.out, /the working folder and its files/);
  assert.equal(fs.readFileSync(config, "utf8"), FIXTURE.configs.unreadable.at(-1).text.replaceAll("{folder}", work));

  // A file that still names it on a line of its own is taken, and written whole again.
  for (const c of FIXTURE.configs.readable) {
    fs.writeFileSync(config, c.text.replaceAll("{folder}", work));
    s.install(p);
    assert.equal(fs.readFileSync(config, "utf8"), naming(work), `${c.name}: written whole again`);
  }

  // A folder no install would take stops it the same way.
  fs.writeFileSync(config, naming(s.home));
  const wide = s.run(["--profile", p]);
  assert.equal(wide.status, 1, wide.out);
  assert.ok(wide.err.endsWith(`install.sh: the working folder can't be ${s.home}: it's your home folder, a temporary folder, or a folder above one\n`), wide.err);

  // So does one an earlier installer stored with a ".." part, as it was
  // given, here after a link. The launcher and the runtime used to read it
  // as far/work, and path.resolve would make it ~/work, so it's left for the
  // user to name again.
  const far = path.join(s.home, "far");
  fs.mkdirSync(path.join(far, "deep"), { recursive: true });
  fs.mkdirSync(path.join(far, "work"));
  fs.symlinkSync(path.join(far, "deep"), path.join(s.home, "near"));
  const dotted = naming(`${s.home}/near/../work`);
  fs.writeFileSync(config, dotted);
  const stopped = s.run(["--profile", p]);
  assert.equal(stopped.status, 1, `${stopped.out}${stopped.err}`);
  assert.ok(stopped.err.endsWith(dotdot), stopped.err);
  assert.equal(fs.readFileSync(config, "utf8"), dotted, "config.json is as it was");
  const renamed = s.install(p, "--working-dir", path.join(far, "work"));
  assert.ok(lines(renamed.out).includes(`  set the working folder: ${path.join(far, "work")}, in ${config}`), renamed.out);
  assert.equal(fs.readFileSync(config, "utf8"), naming(path.join(far, "work")));

  // --working-dir writes it again, whatever it held.
  fs.writeFileSync(config, FIXTURE.configs.unreadable[0].text.replaceAll("{folder}", work));
  const fixed = s.install(p, "--working-dir", work);
  assert.ok(lines(fixed.out).includes(`  set the working folder: ${work}, in ${config}`), fixed.out);
  assert.equal(fs.readFileSync(config, "utf8"), naming(work));
  assert.ok(!fs.existsSync(files));
});

test("--working-dir takes an absolute path and goes with an install, not --uninstall; either mistake stops at once and changes nothing", () => {
  const s = sandbox("working-args");
  const p = s.profile();
  const before = snap(s.dir, false);
  const absolute = "install.sh: --working-dir takes an absolute path\n";
  for (const [args, message] of [
    [["--working-dir", "zenius-files"], absolute],
    [["--working-dir", "~/zenius-files"], absolute],
    [["--working-dir=zenius-files"], absolute],
    [["--working-dir"], absolute],
    [["--uninstall", "--working-dir", path.join(s.home, "work")], "install.sh: --working-dir goes with an install, not --uninstall\n"],
  ]) {
    const r = s.run(["--profile", p, ...args]);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.out}${r.err}`);
    assert.equal(r.err, message, args.join(" "));
    assert.equal(r.out, "", args.join(" "));
    assert.deepEqual(snap(s.dir, false), before, args.join(" "));
  }
});

test("with ZENIUS_HOME anywhere but ~/.zenius there's no default working folder: install stops without --working-dir and makes nothing, and installs with it", () => {
  const s = sandbox("working-elsewhere");
  const p = s.profile();
  const zhome = path.join(s.dir, "zhome");
  const env = { ZENIUS_HOME: zhome };
  const before = snap(s.dir, false);
  for (const more of [[], ["--dry-run"]]) {
    const r = s.run(["--profile", p, ...more], { env });
    assert.equal(r.status, 2, `${more.join(" ")}: ${r.out}${r.err}`);
    assert.equal(r.err, `install.sh: there's no default working folder: ZENIUS_HOME is ${zhome}, not ~/.zenius, and it holds no config.json: pass --working-dir <folder>\n`);
    assert.deepEqual(snap(s.dir, false), before, "nothing made");
  }
  const work = path.join(s.home, "work");
  const given = s.run(["--profile", p, "--working-dir", work], { env });
  assert.equal(given.status, 0, given.err);
  assert.equal(fs.readFileSync(path.join(zhome, "config.json"), "utf8"), naming(work));
  const again = s.run(["--profile", p], { env });
  assert.equal(again.status, 0, again.err);
  assert.ok(lines(again.out).includes(`  the working folder stays ${work} (${path.join(zhome, "config.json")})`), again.out);
  assert.ok(!fs.existsSync(path.join(s.home, "zenius-files")), "never ~/zenius-files");
});

test("in Zen: the installed runtime runs, and a reinstall loads at the next start without a cache purge", async t => {
  const dev = process.env.ZENIUS_DEV ?? path.join(ROOT, "scripts/zen-dev.sh");
  const name = `${process.env.ZENIUS_INSTANCE ?? "coretest"}-inst`;
  const zen = (...args) => {
    const r = spawnSync(dev, [name, ...args], {
      encoding: "utf8",
      env: { ...process.env, ZENIUS_INSTALLED: "1" },
    });
    assert.equal(r.status, 0, `zen-dev.sh ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const s = sandbox("e2e");
  // A tagged copy of this checkout's runtime, with install.sh beside it.
  const release = tag => {
    const dir = path.join(s.dir, tag);
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "scripts/install.sh"), path.join(dir, "scripts/install.sh"));
    fs.copyFileSync(path.join(ROOT, "scripts/working-folder.sh"), path.join(dir, "scripts/working-folder.sh"));
    fs.cpSync(RUNTIME, path.join(dir, "runtime/JS"), { recursive: true });
    const file = path.join(dir, "runtime/JS/zenius/modules/util.sys.mjs");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^(export const RUNTIME_VERSION = ").*(";)$/m, `$1${tag}$2`));
    return path.join(dir, "scripts/install.sh");
  };
  const version = async () => {
    const client = await connect(name);
    try {
      return await client.call("browser.version");
    } finally {
      client.close();
    }
  };

  zen("fresh");
  const profile = zen("path");
  t.after(() => {
    spawnSync(dev, [name, "stop"], { stdio: "ignore" });
    if (process.platform !== "darwin") {
      spawnSync(dev, [name, "reset"], { stdio: "ignore" });
    }
  });
  fs.mkdirSync(path.join(profile, "chrome"), { recursive: true });
  fs.cpSync(path.join(ROOT, "runtime/vendor/fx-autoconfig/profile/chrome/utils"), path.join(profile, "chrome/utils"), {
    recursive: true,
  });

  for (const tag of [`${RUNTIME_VERSION}-e2e1`, `${RUNTIME_VERSION}-e2e2`]) {
    const r = s.run(["--profile", profile], { script: release(tag) });
    assert.equal(r.status, 0, r.err);
    const { installedAt } = readJSON(path.join(profile, "chrome/JS/zenius/install.json"));
    zen("start");
    const v = await version();
    assert.equal(v.runtimeVersion, tag);
    assert.deepEqual(v.install, { commit: "unknown", installedAt });
    zen("quit");
    // installedAt counts seconds; keep the two installs apart.
    await new Promise(resolve => setTimeout(resolve, 1100));
  }
  assert.equal(s.run(["--uninstall", "--profile", profile]).status, 0);
  assert.ok(!fs.existsSync(path.join(profile, "chrome/JS/zenius.uc.js")));
});

test("on a dev profile, browser.version has no install", async () => {
  const instance = process.env.ZENIUS_INSTANCE;
  if (!instance) {
    return;
  }
  const client = await connect(instance);
  try {
    const v = await client.call("browser.version");
    assert.equal(v.install, null);
    assert.equal(v.runtimeVersion, RUNTIME_VERSION);
  } finally {
    client.close();
  }
});
