// No suite and no dev Zen reaches the account's own zenius home, since no
// test or dev Zen may touch the user's config or files. A dev Zen keeps its
// socket, registry entry, state and self-check in the zenius home, which is
// ~/.zenius unless ZENIUS_HOME names another, and the suites' runners named
// none. scripts/test-all.sh now gives each suite one of its own, and
// scripts/zen-dev.sh refuses to start a dev Zen in the account's own. These
// tests start no Zen: zen-dev.sh refuses before it looks for one, and the
// runs that pass its check stop at a Zen that isn't there.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../lib/targets.mjs";

// The account's own, by its passwd entry, as zen-dev.sh and guardHome take it.
const OWN_HOME = userInfo().homedir;
const OWN_ZHOME = join(OWN_HOME, ".zenius");

/** This process's environment with `more` over it; an undefined value removes that variable. */
function envWith(more = {}) {
  const env = { ...process.env };
  // A child's node --test would report to this run instead of printing.
  delete env.NODE_TEST_CONTEXT;
  for (const [name, value] of Object.entries(more)) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}

/** Whether `path`, links resolved, is `dir` or inside it. */
function within(path, dir) {
  const real = realpathSync(path);
  const base = realpathSync(dir);
  return real === base || real.startsWith(`${base}/`);
}

// What a suite saw: the variables test-all gives it or takes away, and its
// zenius home's config and folder mode.
const RECORD = `import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const e = process.env;
const zhome = e.ZENIUS_HOME ?? null;
let config = null;
let mode = null;
if (zhome) {
  config = JSON.parse(readFileSync(join(zhome, "config.json"), "utf8"));
  mode = statSync(dirname(zhome)).mode & 0o777;
}
writeFileSync(process.argv[2], JSON.stringify({
  zhome,
  home: e.HOME ?? null,
  workingDir: e.ZENIUS_WORKING_DIR ?? null,
  devWorkingDir: e.ZENIUS_DEV_WORKING_DIR ?? null,
  socket: e.ZENIUS_SOCKET ?? null,
  instance: e.ZENIUS_INSTANCE ?? null,
  config,
  mode,
}));
`;

test("test-all gives each suite a zenius home of its own, never the account's, with a working folder inside it, drops the caller's working folder, socket and instance, and removes the home whatever the verdict", t => {
  const tree = mkdtempSync(join(tmpdir(), "zt-zh-"));
  // test-all's TMPDIR, which on Linux must fit in 40 bytes: a short name.
  const tmp = mkdtempSync(join(tmpdir(), "h"));
  try {
    if (platform() === "linux" && Buffer.byteLength(tmp) > 40) {
      t.skip(`${tmp} is ${Buffer.byteLength(tmp)} bytes, longer than test-all's TMPDIR may be`);
      return;
    }
    for (const dir of ["scripts/lib", "tests/lib"]) {
      mkdirSync(join(tree, dir), { recursive: true });
    }
    for (const file of ["scripts/test-all.sh", "scripts/lib/test-all-failures.mjs", "tests/lib/scratch-home.sh", "tests/lib/scratch-home.mjs"]) {
      copyFileSync(join(REPO_ROOT, file), join(tree, file));
    }
    writeFileSync(join(tree, "tests", "record.mjs"), RECORD);
    const out = join(tmp, "seen");
    mkdirSync(out);
    // Two suites, one passing and one failing, each recording what it saw.
    for (const [suite, status] of [["za", 0], ["zb", 1]]) {
      mkdirSync(join(tree, "tests", suite));
      writeFileSync(
        join(tree, "tests", suite, "run.sh"),
        `#!/usr/bin/env bash\nnode "$(dirname "\${BASH_SOURCE[0]}")/../record.mjs" "$ZT_SEEN/${suite}.json" || exit 2\nexit ${status}\n`
      );
      chmodSync(join(tree, "tests", suite, "run.sh"), 0o755);
    }

    const r = spawnSync("bash", [join(tree, "scripts", "test-all.sh"), "za", "zb"], {
      env: envWith({
        TMPDIR: tmp,
        ZT_SEEN: out,
        ZENIUS_HOME: undefined,
        // What a caller's shell may name: the user's working folder, for
        // the CLI or for every dev Zen, and the daily Zen's socket and
        // instance.
        ZENIUS_WORKING_DIR: join(OWN_HOME, "zenius-files"),
        ZENIUS_DEV_WORKING_DIR: join(OWN_HOME, "zenius-files"),
        ZENIUS_SOCKET: join(OWN_ZHOME, "run", "default.sock"),
        ZENIUS_INSTANCE: "default",
      }),
      encoding: "utf8",
      timeout: 120000,
    });
    const report = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 1, report);
    assert.match(r.stdout, /^PASS za /m, report);
    assert.match(r.stdout, /^FAIL zb, log /m, report);

    const seen = Object.fromEntries(["za", "zb"].map(suite => [suite, JSON.parse(readFileSync(join(out, `${suite}.json`), "utf8"))]));
    const parent = platform() === "darwin" ? "/tmp" : tmp;
    for (const [suite, s] of Object.entries(seen)) {
      const what = `${suite}: ${JSON.stringify(s)}`;
      assert.ok(s.zhome, what);
      assert.match(s.zhome, /\/zt-h-[A-Za-z0-9]{6}\/zhome$/, what);
      assert.ok(s.zhome.startsWith(`${parent}/zt-h-`), `right in ${parent}, short for its sockets: ${what}`);
      assert.equal(s.mode, 0o700, what);
      assert.equal(s.config.workingFolder, join(dirname(s.zhome), "files"), what);
      assert.equal(s.home, process.env.HOME, `HOME stays the account's: ${what}`);
      assert.deepEqual([s.workingDir, s.devWorkingDir, s.socket, s.instance], [null, null, null, null], what);
      assert.ok(!s.zhome.startsWith(`${OWN_ZHOME}/`) && s.zhome !== OWN_ZHOME, what);
      assert.ok(!existsSync(dirname(s.zhome)), `${suite}'s home is gone after the run: ${what}`);
    }
    assert.notEqual(seen.za.zhome, seen.zb.zhome, "a home for each suite");
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** zen-dev.sh <name> <command>, with a dev home and a Zen of its own: none, at a path that isn't there. */
function zenDev(t, command, more = {}) {
  const r = spawnSync("bash", [join(REPO_ROOT, "scripts", "zen-dev.sh"), "zzguard", command], {
    env: envWith({
      ZENIUS_DEV_HOME: join(t.dir, "dev"),
      ZEN_BIN: join(t.dir, "no-zen", "zen"),
      TMPDIR: t.dir,
      ZENIUS_DEV_WORKING_DIR: undefined,
      ZENIUS_HOME: undefined,
      ...more,
    }),
    encoding: "utf8",
    timeout: 60000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("zen-dev.sh refuses to start or restart a dev Zen whose zenius home is the account's own ~/.zenius, in it, its home folder, or a link to one of them, by its passwd home whatever HOME says, and says how to give it one", t => {
  t.dir = mkdtempSync(join(tmpdir(), "zt-zg-"));
  try {
    const refused = [
      ["ZENIUS_HOME unset, HOME the account's", { HOME: process.env.HOME }],
      ["the account's ~/.zenius", { ZENIUS_HOME: OWN_ZHOME }],
      ["~/.zenius with a trailing slash", { ZENIUS_HOME: `${OWN_ZHOME}/` }],
      // Not made, and never made here: the check only reads its path.
      ["a folder in ~/.zenius that doesn't exist yet", { ZENIUS_HOME: join(OWN_ZHOME, "zt-never-made", "x") }],
      ["the account's home folder", { ZENIUS_HOME: OWN_HOME }],
      ["~/.zenius with HOME pointed elsewhere", { ZENIUS_HOME: OWN_ZHOME, HOME: join(t.dir, "elsewhere") }],
    ];
    // A link resolves only to a ~/.zenius that exists; one to nothing leads
    // a Zen nowhere, as on a machine without zenius installed.
    if (existsSync(OWN_ZHOME)) {
      const link = join(t.dir, "link");
      symlinkSync(OWN_ZHOME, link);
      refused.push(["a link to ~/.zenius", { ZENIUS_HOME: link }]);
    } else {
      t.diagnostic(`no ${OWN_ZHOME} here: the link case is left out`);
    }
    for (const [what, env] of refused) {
      for (const command of ["start", "restart"]) {
        const r = zenDev(t, command, env);
        assert.equal(r.status, 1, `${what}, ${command}: ${r.out}`);
        assert.match(r.out, /zenius home, .+, is the account's own ~\/\.zenius or in it/, `${what}, ${command}: ${r.out}`);
        assert.match(r.out, /export ZENIUS_HOME=\$\(mktemp -d \/tmp\/zh-XXXXXX\)/, `${what}, ${command}: ${r.out}`);
        assert.doesNotMatch(r.out, /Zen not found/, `refused before it looks for Zen: ${what}, ${command}`);
      }
    }
    assert.ok(!existsSync(join(OWN_ZHOME, "zt-never-made")), "nothing made in ~/.zenius");
    assert.ok(!existsSync(join(t.dir, "dev", "profiles", "zzguard")), "no profile made");

    // A zenius home of its own passes the check, and the start goes on to
    // look for Zen.
    const scratchHome = join(t.dir, "home");
    mkdirSync(scratchHome);
    for (const [what, env] of [
      ["a scratch ZENIUS_HOME", { ZENIUS_HOME: join(t.dir, "zhome") }],
      ["ZENIUS_HOME unset with a scratch HOME", { HOME: scratchHome }],
    ]) {
      const r = zenDev(t, "start", env);
      assert.equal(r.status, 1, `${what}: ${r.out}`);
      assert.match(r.out, /Zen not found at /, `${what}: ${r.out}`);
      assert.doesNotMatch(r.out, /the account's own/, `${what}: ${r.out}`);
    }
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("zen-dev.sh's stop and reset tidy the instance's files in the zenius home it was given", t => {
  t.dir = mkdtempSync(join(tmpdir(), "zt-zt-"));
  try {
    const zhome = join(t.dir, "zhome");
    const profile = join(t.dir, "dev", "profiles", "zzguard");
    for (const dir of ["instances", "run", "state/zzguard"]) {
      mkdirSync(join(zhome, dir), { recursive: true });
    }
    writeFileSync(join(zhome, "instances", "zzguard.json"), `${JSON.stringify({ profileDir: profile })}\n`);
    // A file stands in for the socket: stop removes either.
    writeFileSync(join(zhome, "run", "zzguard.sock"), "");
    writeFileSync(join(zhome, "state", "zzguard", "spaces.json"), "{}\n");

    const stop = zenDev(t, "stop", { ZENIUS_HOME: zhome });
    assert.equal(stop.status, 0, stop.out);
    assert.match(stop.out, /zzguard not running/);
    assert.ok(!existsSync(join(zhome, "instances", "zzguard.json")), "its registry entry goes");
    assert.ok(!existsSync(join(zhome, "run", "zzguard.sock")), "its socket goes");

    const reset = zenDev(t, "reset", { ZENIUS_HOME: zhome });
    assert.equal(reset.status, 0, reset.out);
    assert.ok(!existsSync(join(zhome, "state", "zzguard")), "its state goes with the profile");
    assert.ok(statSync(zhome).isDirectory(), "the zenius home itself stays: it's the caller's");
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

// The live tools keep the account's HOME, where their dev profiles are, and
// take their dev Zen's zenius home from ZENIUS_HOME through guardZeniusHome
// (tests/lib/scratch-home.mjs). Anything but one of its own must stop them
// before they remove, plant or link anything: the probes' removals of their
// instance's state and socket, and the harness's links to its run/ and
// instances/. A bash first on PATH records any call, as a zen-dev.sh call
// would be one.
test("the live tools refuse a zenius home that isn't one of their own before they do anything, and go on with a scratch one", t => {
  t.dir = mkdtempSync(join(tmpdir(), "zt-zl-"));
  try {
    const bin = join(t.dir, "bin");
    const calls = join(t.dir, "bash-calls");
    const out = join(t.dir, "out");
    mkdirSync(bin);
    writeFileSync(join(bin, "bash"), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 1\n`);
    chmodSync(join(bin, "bash"), 0o700);
    // --node: the Mac's default, Homebrew's node@24, may be missing, and the
    // harness checks it first.
    const node = ["--node", process.execPath];
    const tools = [
      ["tests/live/probe-browser.mjs", ["--instance", "zzguard", ...node]],
      ["tests/live/run.mjs", ["--instance", "zzguard", "--smoke", "--claude", join(REPO_ROOT, "tests/live/stand-in-agent.mjs"), "--out", out, ...node]],
    ];
    const run = (tool, args, zhome) => {
      const r = spawnSync(process.execPath, [join(REPO_ROOT, tool), ...args], {
        env: envWith({ ZENIUS_HOME: zhome, PATH: `${bin}:${process.env.PATH}` }),
        encoding: "utf8",
        timeout: 60000,
      });
      return { status: r.status, said: `${r.stdout}${r.stderr}` };
    };
    const refusal = "needs its dev Zen in a zenius home of its own";
    const refused = [
      ["unset", undefined, "ZENIUS_HOME is unset"],
      ["~/.zenius", OWN_ZHOME, `ZENIUS_HOME is ${OWN_ZHOME}, in the account's own`],
      ["a folder in ~/.zenius", join(OWN_ZHOME, "zt-never-made"), "in the account's own"],
      ["the account's home folder", OWN_HOME, "the account's own home folder"],
    ];
    for (const [tool, args] of tools) {
      for (const [what, zhome, why] of refused) {
        const r = run(tool, args, zhome);
        assert.ok(r.status !== 0 && r.status !== null, `${tool} with ZENIUS_HOME ${what}: exit ${r.status}: ${r.said}`);
        assert.ok(r.said.includes(refusal) && r.said.includes(why), `${tool} with ZENIUS_HOME ${what}: ${r.said}`);
      }
    }
    assert.ok(!existsSync(calls), `a tool ran bash, as for zen-dev.sh, before its check: ${existsSync(calls) && readFileSync(calls, "utf8")}`);
    assert.ok(!existsSync(out), "run.mjs made its --out folder before its check");
    assert.ok(!existsSync(join(OWN_ZHOME, "zt-never-made")), "a folder was made in ~/.zenius");

    // With the same arguments, which reach the check above, a scratch zenius
    // home goes past it: the harness stops at its next check, the instance's
    // dev profile, which isn't there. (The probes would go on to plant their
    // dummies in ~/.zenius-dev/canary.)
    const zhome = join(t.dir, "zhome");
    mkdirSync(zhome, { mode: 0o700 });
    const r = run(tools[1][0], tools[1][1], zhome);
    assert.ok(r.status !== 0 && r.status !== null, `exit ${r.status}: ${r.said}`);
    assert.ok(!r.said.includes(refusal), `a scratch zenius home was refused: ${r.said}`);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
