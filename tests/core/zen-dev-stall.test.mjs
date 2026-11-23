// zen-dev.sh's start when the browser never gets to the runtime: a start that
// stalls before zenius's first line (the Mac's core run of 2026-11-22) is
// counted in the crash log with its threads' state, and retried once; one that
// stalls after it is zenius's own and fails as before. The startup watch
// (scripts/dev/startup-watch.uc.js), which logs where such a window stopped,
// reaches dev profiles through zen-dev.sh only. No Zen runs: a stand-in "zen"
// in a scratch install, under a ZENIUS_DEV_HOME and HOME of the test's own,
// prints what it's given and then waits forever.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repo, "scripts/zen-dev.sh");
const root = realpathSync(mkdtempSync(join(tmpdir(), "zenius-stall-")));
const app = join(root, "zen-9.9");
const home = join(root, "home");
const crashLog = join(root, "dev", "logs", "startup-crashes.log");
mkdirSync(home);
mkdirSync(app);
writeFileSync(join(app, "application.ini"), "[App]\nVendor=Mozilla\nName=Zen\nVersion=9.9\nBuildID=1\n");
// On the Mac, start looks for fx-autoconfig's config.js in the bundle's
// Resources folder, <app>/../Resources.
mkdirSync(join(root, "Resources"));
writeFileSync(join(root, "Resources", "config.js"), "");

after(async () => {
  for (const name of ["stall-check", "late-check", "watch-check"]) await zenDev(name, "stop");
  rmSync(root, { recursive: true, force: true });
});

/** The stand-in prints these lines, as Zen prints its log, and never gets ready. */
function standIn(lines) {
  // A shell that stays itself (no exec): its command line names the profile,
  // which is how zen-dev.sh knows it may stop it.
  writeFileSync(join(app, "zen"), `#!/bin/sh\n${lines.map(line => `echo '${line}'`).join("\n")}\nwhile :; do sleep 1; done\n`);
  chmodSync(join(app, "zen"), 0o755);
}

function zenDev(name, cmd) {
  return new Promise(resolve => {
    execFile(
      "bash",
      [script, name, cmd],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          ZEN_BIN: join(app, "zen"),
          ZENIUS_DEV_HOME: join(root, "dev"),
          ZENIUS_HOME: join(root, "zhome"),
          ZENIUS_START_WAIT_S: "2",
          ZENIUS_START_RETRIES: "3",
        },
        timeout: 120000,
      },
      (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr })
    );
  });
}

/** The crash log's records of this instance. */
const records = name =>
  existsSync(crashLog)
    ? readFileSync(crashLog, "utf8")
        .split("\n")
        .filter(line => line.includes(` ${name} profile=`))
    : [];

test("a start that stalls before the runtime's first line is retried once, and each try is counted with its threads", async () => {
  standIn(["*** You are running in headless mode.", 'console.debug: "ZenSessionManager:" "Restoring Zen session data into 1 windows"']);
  const r = await zenDev("stall-check", "start");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /stall-check: its start stalled before the runtime loaded \(logged in .*\); retrying in 2 s/);
  assert.match(r.stderr, /stall-check: its start stalled before the runtime loaded on 2 tries/);
  const [first, retry, ...more] = records("stall-check");
  assert.deepEqual(more, []);
  assert.match(first, / stall-check profile=fresh stalled=2s threads=\S+$/);
  assert.match(retry, / stall-check profile=fresh, retry 1 stalled=2s threads=\S+$/);
  // Linux reads each thread's state from /proc. The Mac's sample may not be
  // allowed to read a shell, which is a platform binary there.
  if (process.platform === "linux") {
    const threads = first.match(/threads=(\S+)$/)[1];
    assert.match(readFileSync(threads, "utf8"), /^\d+ \S+ [A-Z] /m);
  }
  assert.equal((await zenDev("stall-check", "status")).status, 1, "the stalled stand-in is stopped");
});

test("a start that stalls after the runtime's first line fails at once, and isn't counted as the browser's", async () => {
  standIn(["*** You are running in headless mode.", "[zenius] popup window guard: on"]);
  const r = await zenDev("late-check", "start");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /late-check: no '\[zenius\] window loaded, instance=late-check' in \S+ after 2 s; stopping it/);
  assert.doesNotMatch(r.stderr, /stalled|retrying/);
  assert.deepEqual(records("late-check"), []);
  assert.equal((await zenDev("late-check", "status")).status, 1, "the stand-in is stopped");
});

test("the startup watch reaches a dev profile through zen-dev.sh only: install.sh copies runtime/JS, and release.sh's package leaves scripts/dev out", async () => {
  const watch = "scripts/dev/startup-watch.uc.js";
  standIn(["[zenius] window loaded, instance=watch-check"]);
  const r = await zenDev("watch-check", "start");
  assert.equal(r.status, 0, r.stderr);
  const copied = join(root, "dev", "profiles", "watch-check", "chrome", "JS", "zen-dev-startup-watch.uc.js");
  assert.equal(readFileSync(copied, "utf8"), readFileSync(join(repo, watch), "utf8"));
  assert.equal((await zenDev("watch-check", "stop")).status, 0);
  // install.sh copies runtime/JS's files only, and never names the watch;
  // install.test.mjs checks the whole of chrome/JS after an install.
  assert.ok(!watch.startsWith("runtime/"));
  assert.doesNotMatch(readFileSync(join(repo, "scripts/install.sh"), "utf8"), /startup-watch|scripts\/dev/);
  // release.sh packs git's files under its list of paths and nothing else.
  const packaged = readFileSync(join(repo, "scripts/release.sh"), "utf8")
    .match(/^\s*packaged=\(([^)]*)\)\s*$/m)[1]
    .trim()
    .split(/\s+/);
  assert.ok(packaged.includes("runtime") && packaged.includes("scripts/install.sh"), `release.sh's list: ${packaged.join(" ")}`);
  assert.deepEqual(
    packaged.filter(path => watch === path || watch.startsWith(`${path}/`)),
    [],
    "no path in release.sh's list holds the watch"
  );
});
