// zen-dev.sh signals only its own Zen. A pid file can be stale, and its pid
// reused by any process, the user's daily Zen included (pids get recycled,
// on the Mac too): stop, quit and status leave a process alone unless its
// command line names the instance's dev profile. And once the instance's Zen
// is gone, stop and quit remove the socket and registry entry a Zen ended by
// a signal leaves, only the instance's own. No Zen runs here: the pid file
// names stand-in processes, under a ZENIUS_DEV_HOME and ZENIUS_HOME of the
// test's own.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const script = fileURLToPath(new URL("../../scripts/zen-dev.sh", import.meta.url));
// zen-dev.sh gets the profile's path through a symlink, as on the Mac, whose
// temp folders under /var/folders are /private/var/folders: an open file's
// path reads back with the link resolved (lsof there, /proc here).
const realHome = mkdtempSync(join(tmpdir(), "zenius-pidfile-"));
const home = `${realHome}-link`;
symlinkSync(realHome, home);
const name = "pidfile-check";
const profile = join(home, "profiles", name);
const zhome = join(home, "zenius");
const children = [];

after(() => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  rmSync(home, { force: true });
  rmSync(realHome, { recursive: true, force: true });
});

/**
 * A process that waits, with these arguments (after "--", so Node keeps them
 * for the script). With `lock`, it holds that file open, as Zen holds its
 * profile's .parentlock.
 */
async function standIn(...args) {
  return standInWith({}, ...args);
}

async function standInWith({ lock = null }, ...args) {
  const code = `${lock ? 'require("fs").openSync(process.env.STAND_IN_LOCK, "a");' : ""} setTimeout(() => {}, 300000)`;
  const env = lock ? { ...process.env, STAND_IN_LOCK: lock } : process.env;
  const child = spawn(process.execPath, ["-e", code, "--", ...args], { stdio: "ignore", env });
  children.push(child);
  // Until its command line is the one given.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(alive(child.pid), "the stand-in process didn't start");
  return child;
}

/** Run zen-dev.sh, async: this process reaps its stand-ins meanwhile, so a stopped one doesn't linger as a zombie. */
function zenDev(cmd) {
  return new Promise(resolve => {
    execFile(
      "bash",
      [script, name, cmd],
      { encoding: "utf8", env: { ...process.env, ZENIUS_DEV_HOME: home, ZENIUS_HOME: zhome }, timeout: 30000 },
      (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr })
    );
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The profile's lock symlink, as Zen writes it ("127.0.1.1:+<pid>"), or none. */
function lockNames(pid) {
  mkdirSync(profile, { recursive: true });
  rmSync(join(profile, "lock"), { force: true });
  if (pid) {
    symlinkSync(`127.0.1.1:+${pid}`, join(profile, "lock"));
  }
}

function pidFileNames(pid) {
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(join(home, "run", `${name}.pid`), `${pid}\n`);
}

/** The files a runtime ended by a signal leaves: its registry entry (compact, as IOUtils.writeJSON writes it) and socket. */
function leftovers(instance = name, profileDir = profile) {
  mkdirSync(join(zhome, "instances"), { recursive: true });
  mkdirSync(join(zhome, "run"), { recursive: true });
  const reg = join(zhome, "instances", `${instance}.json`);
  const sock = join(zhome, "run", `${instance}.sock`);
  writeFileSync(reg, JSON.stringify({ instance, pid: 4242, socket: sock, profileDir, startedAt: "2026-11-20T00:00:00.000Z" }));
  writeFileSync(sock, "");
  return { reg, sock };
}

test("stop, quit and status leave alone a process the pid file names that isn't the instance's Zen", async () => {
  // Say, the user's own Zen, with the pid a dev Zen once had.
  const other = await standIn();
  for (const cmd of ["stop", "quit", "status"]) {
    pidFileNames(other.pid);
    const out = await zenDev(cmd);
    assert.ok(alive(other.pid), `${cmd} signalled pid ${other.pid}, which isn't the instance's Zen`);
    assert.match(out.stderr, new RegExp(`names pid ${other.pid}, which is not ${name}'s Zen`), `${cmd}: ${out.stderr}`);
    assert.match(out.stdout, /not running/, `${cmd}: ${out.stdout}`);
  }
});

test("a profile's name never matches a longer one", async () => {
  const longer = await standIn("--profile", `${profile}-2`);
  pidFileNames(longer.pid);
  const out = await zenDev("stop");
  assert.ok(alive(longer.pid), "stop signalled the Zen of another profile");
  assert.match(out.stdout, /not running/, out.stderr);
});

test("stop still stops the process whose command line names the profile, then removes its socket and registry entry", async () => {
  const ours = await standIn("--profile", profile);
  const exited = new Promise(resolve => ours.once("exit", resolve));
  pidFileNames(ours.pid);
  const { reg, sock } = leftovers();
  const out = await zenDev("stop");
  assert.match(out.stdout, /stopped/, out.stderr);
  await exited;
  assert.deepEqual([existsSync(reg), existsSync(sock)], [false, false], "the instance's registry entry and socket are gone");
});

test("stop and quit remove what a Zen killed earlier left, once no Zen runs the profile", async () => {
  for (const cmd of ["stop", "quit"]) {
    rmSync(join(home, "run", `${name}.pid`), { force: true });
    const { reg, sock } = leftovers();
    const out = await zenDev(cmd);
    assert.match(out.stdout, /not running/, `${cmd}: ${out.stderr}`);
    assert.deepEqual([existsSync(reg), existsSync(sock)], [false, false], `${cmd} left the registry entry or socket`);
  }
});

test("another profile's registry entry under the same name stays, with its socket; other names' files are never touched", async () => {
  rmSync(join(home, "run", `${name}.pid`), { force: true });
  const mine = leftovers(name, join(tmpdir(), "another-dev-home", "profiles", name));
  const other = leftovers("pidfile-check-2", join(home, "profiles", "pidfile-check-2"));
  const out = await zenDev("stop");
  assert.match(out.stderr, /names profile .*another-dev-home.*leaving it/, out.stderr);
  assert.deepEqual(
    [mine.reg, mine.sock, other.reg, other.sock].map(f => existsSync(f)),
    [true, true, true, true],
    "a file that isn't this instance's was removed"
  );
});

test("the lock symlink a killed Zen left, naming a pid reused since, never makes that process the profile's Zen", async () => {
  // The symlink outlives a Zen ended by a signal, and its pid can be any
  // process's later: the user's daily Zen, on the Mac.
  rmSync(join(home, "run", `${name}.pid`), { force: true });
  const other = await standIn();
  lockNames(other.pid);
  try {
    for (const cmd of ["stop", "quit", "status"]) {
      const out = await zenDev(cmd);
      assert.ok(alive(other.pid), `${cmd} signalled pid ${other.pid}, which the stale lock symlink names`);
      assert.match(out.stdout, /not running/, `${cmd}: ${out.stdout} ${out.stderr}`);
    }
  } finally {
    lockNames(null);
  }
});

test("a Zen that relaunched itself, with no argv naming the profile, is found by the profile lock it holds", async () => {
  rmSync(join(home, "run", `${name}.pid`), { force: true });
  mkdirSync(profile, { recursive: true });
  const relaunched = await standInWith({ lock: join(profile, ".parentlock") });
  const exited = new Promise(resolve => relaunched.once("exit", resolve));
  lockNames(relaunched.pid);
  try {
    assert.match((await zenDev("status")).stdout, new RegExp(`running \\(pid ${relaunched.pid}\\)`));
    assert.match((await zenDev("stop")).stdout, /stopped/);
    await exited;
  } finally {
    lockNames(null);
  }
});

test("a zombie isn't the profile's Zen, whether the pid file or the lock symlink names it", async () => {
  // A Zen that has exited but isn't reaped yet: kill -0 still succeeds on it.
  // Its parent here is a perl that forks it and never waits. (A bash that
  // ran "sleep 0 &" and then exec'd a sleep reaped its child when the child
  // exited before the exec, as on a loaded Linux server.)
  const parent = spawn("perl", ["-e", '$| = 1; my $pid = fork() // die "fork: $!"; if (!$pid) { exit 0 } print "$pid\\n"; sleep 300'], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(parent);
  const zombie = Number((await new Promise(resolve => parent.stdout.once("data", resolve))).toString().trim());
  const stat = () => new Promise(resolve => execFile("ps", ["-o", "stat=", "-p", String(zombie)], (_e, out) => resolve(String(out).trim())));
  for (let i = 0; i < 200 && !(await stat()).includes("Z"); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(await stat(), /Z/, "the stand-in never became a zombie");
  try {
    pidFileNames(zombie);
    lockNames(zombie);
    const out = await zenDev("status");
    assert.match(out.stdout, /not running/, out.stderr);
    assert.doesNotMatch(out.stderr, /not signalling/, "a zombie is no process to warn about");
  } finally {
    lockNames(null);
    rmSync(join(home, "run", `${name}.pid`), { force: true });
  }
});
