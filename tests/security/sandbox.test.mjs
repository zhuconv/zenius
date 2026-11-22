// The sandboxed launcher's canary: what a zenius script reaches when
// bin/zenius is the launcher scripts/install-cli.sh --sandbox writes. Every
// probe of a file, program, process, socket, network or variable outside the
// grants must fail, and so must every write in the working folder, while a
// pilot's real work still works: goto, snapshot, an upload from the cwd, and
// a screenshot and a download to the run's output folder. run.sh
// installs the launcher from a copy of this checkout into its own folder
// (never ~/.local/bin or ~/.zenius/cli) and names it in
// ZENIUS_SECURITY_LAUNCHER.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { CANARY, INSTANCE, REPORT, plant, startFixtures } from "./lib.mjs";

const LAUNCHER = process.env.ZENIUS_SECURITY_LAUNCHER ?? "";
if (!LAUNCHER) throw new Error("run this part through tests/security/run.sh sandbox");
const CLI_COPY = process.env.ZENIUS_SECURITY_LAUNCHER_CLI ?? "";

/** A path the launcher was written with, such as NODE or OUT_ROOT. */
function launcherValue(name) {
  const line = readFileSync(LAUNCHER, "utf8").split("\n").find((text) => text.startsWith(`${name}='`));
  if (!line) throw new Error(`${LAUNCHER} has no ${name} line`);
  return line.slice(name.length + 2, -1).replaceAll("'\\''", "'");
}
const launcherNode = () => launcherValue("NODE");
/** Where the launcher puts runs' output folders: run.sh's own folder, never ~/.zenius/out. */
const OUT_ROOT = launcherValue("OUT_ROOT");
/** A working folder's git config, which a plain git status reads (core.fsmonitor runs a program). */
const GIT_CONFIG = "[core]\n\trepositoryformatversion = 0\n";
const LINUX = process.platform === "linux";
const HOME = homedir();
const ZHOME = realpathSync(process.env.ZENIUS_HOME || join(HOME, ".zenius"));
const SOCKET = join(realpathSync(join(ZHOME, "run")), `${INSTANCE}.sock`);

/** The variables the launcher passes on; nothing else may reach a script. */
const PASSED = new Set([
  "HOME", "PATH", "PWD", "TMPDIR", "ZENIUS_HOME", "ZENIUS_INSTANCE", "ZENIUS_SOCKET", "ZENIUS_NODE_MAJOR", "ZENIUS_OUTPUT_DIR", "ZENIUS_CLIENT", "NODE_DISABLE_COMPILE_CACHE",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "COLUMNS", "NO_COLOR", "FORCE_COLOR", "ZENIUS_TIMING",
  "EGO_BROWSER_PAGE_BUDGET", "EGO_BROWSER_RESPONSE_TIMEOUT_MS", "ZENIUS_TASK_SPACE", "ZENIUS_READ_DIR", "HC_TERMINAL_ID", "ZENIUS_FOLDER", "ZENIUS_SIDEBAR_TASK",
]);
// On macOS, CoreFoundation sets this one inside node itself when it's missing
// (the uid and the text encoding): `env -i node` has it, `env -i env` doesn't.
if (process.platform === "darwin") PASSED.add("__CF_USER_TEXT_ENCODING");

let fixtures;
let planted;
let work;
let task;
let udpHits = 0;
const cleanups = [];
/** Sockets outside the sandbox that the harness itself reached, by name. */
const sockets = {};

before(async () => {
  fixtures = await startFixtures();
  cleanups.push(() => fixtures.close());
  planted = plant();
  cleanups.push(planted.cleanup);
  // By real path: on macOS tmpdir() is under /var, a link to /private/var,
  // and a script's process.cwd() in the sandbox gives the real path.
  work = realpathSync(mkdtempSync(join(tmpdir(), "zsb-")));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, "tmp"));
  // The task's folder, as a project has it: a git repository and agent settings.
  task = join(work, "task");
  mkdirSync(join(task, ".git", "hooks"), { recursive: true });
  writeFileSync(join(task, ".git", "config"), GIT_CONFIG);
  mkdirSync(join(task, ".venv", "bin"), { recursive: true });
  mkdirSync(join(task, ".claude"));
  writeFileSync(join(task, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(task, "mine.txt"), "the agent's own file\n");
  // A link out of the working folder to a file both OS sandboxes let the CLI read.
  symlinkSync("/etc/hosts", join(task, "hosts.txt"));
  // A --require that NODE_OPTIONS would run, where the sandbox could load it.
  writeFileSync(join(task, "evil.cjs"), "globalThis.EVIL_RAN = true;\n");

  const listen = async (name, path) => {
    const server = createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => server.once("error", reject).listen(path, resolve));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    sockets[name] = path;
  };
  await listen("an unrelated socket", join(work, "o.sock"));
  // In the instance's own folder, where only the instance's socket may be seen.
  const sibling = join(ZHOME, "run", `${INSTANCE}-canary.sock`);
  rmSync(sibling, { force: true });
  await listen("a socket beside the instance's", sibling);
  cleanups.push(() => rmSync(sibling, { force: true }));
  // Abstract sockets have no file, so no mount can hide them: only a network namespace does.
  if (LINUX) await listen("an abstract socket", `\0zenius-canary-${process.pid}`);
  const uid = process.getuid?.() ?? 0;
  const known = {
    docker: ["/var/run/docker.sock", "/run/docker.sock"],
    "ssh-agent": [process.env.SSH_AUTH_SOCK],
    "gpg-agent": [`/run/user/${uid}/gnupg/S.gpg-agent`],
    "the session bus": [`/run/user/${uid}/bus`],
  };
  // ZENIUS_SECURITY_SOCKETS adds a machine's own sockets, by path: run.sh
  // fills it from a list kept outside the repo (~/.zenius-dev/security-sockets).
  for (const extra of (process.env.ZENIUS_SECURITY_SOCKETS ?? "").split(":").filter(Boolean)) known[extra] = [extra];
  for (const [name, paths] of Object.entries(known)) {
    for (const path of paths) {
      // Only a socket that answers out here proves anything when it fails in there.
      if (path && (await reachable(path))) {
        sockets[name] = path;
        break;
      }
    }
  }

  const udp = createSocket("udp4");
  udp.on("message", () => (udpHits += 1));
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  sockets.udpPort = udp.address().port;
  cleanups.push(() => udp.close());
});

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function reachable(path) {
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Runs the launcher as an agent's shell would, with an environment full of
 * things that must not get in: the canary as tokens, NODE_OPTIONS, and
 * ZENIUS_SOCKET and ZENIUS_HOME pointing elsewhere.
 */
function launch(args, { cwd = task, env = {}, stdin = "", timeoutMs = 180_000, launcher = LAUNCHER } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, args, {
      cwd,
      env: {
        ...process.env,
        TMPDIR: join(work, "tmp"),
        ZENIUS_CANARY_TOKEN: CANARY,
        AWS_SECRET_ACCESS_KEY: CANARY,
        GITHUB_TOKEN: CANARY,
        NODE_OPTIONS: `--require ${join(task, "evil.cjs")}`,
        ZENIUS_SOCKET: sockets["an unrelated socket"],
        ZENIUS_HOME: join(work, "elsewhere"),
        SSH_AUTH_SOCK: sockets["an unrelated socket"],
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // A launcher that stops at once (a Codex sandbox it can't work in) may
    // close its stdin before this write: that EPIPE is no test failure.
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(stdin);
  });
}

/**
 * A script's last line, parsed, and where the canary showed in its output:
 * the probes it showed in, so one run names every way it got in.
 */
async function script(source, options) {
  const result = await launch(["nodejs", "--instance", INSTANCE], { ...options, stdin: source });
  const output = `${result.stdout}\n${result.stderr}`;
  // The script's last line, then the [zenius:files] block the SDK adds in the sandbox.
  const lines = result.stdout.trim().split("\n");
  const block = lines.indexOf("[zenius:files]");
  const files = block === -1 ? [] : lines.slice(block + 1).map((line) => line.replace(/^Wrote /, ""));
  let out;
  try {
    out = JSON.parse((block === -1 ? lines : lines.slice(0, block)).at(-1) ?? "");
  } catch {
    assert.fail(`the script printed no JSON (exit ${result.code}):\n${output.slice(0, 2000)}`);
  }
  const leaks = Object.entries(out).filter(([, value]) => JSON.stringify(value).includes(CANARY)).map(([name]) => name);
  if (output.includes(CANARY) && leaks.length === 0) leaks.push("the script's output");
  return { out, leaks, files };
}

const PRELUDE = `
const out = {};
const attempt = async (name, fn) => {
  try {
    const value = await fn();
    out[name] = { ok: true, value: typeof value === "string" ? value.slice(0, 300) : value ?? null };
  } catch (error) {
    out[name] = { ok: false, code: error?.code ?? error?.name ?? null, message: String(error?.message ?? error).slice(0, 300) };
  }
};
const fs = process.getBuiltinModule("node:fs");
const net = process.getBuiltinModule("node:net");
const os = process.getBuiltinModule("node:os");
const reach = (where) => new Promise((resolve, reject) => {
  const socket = typeof where === "number" ? net.connect(where, "127.0.0.1") : net.connect(where);
  const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error("no answer in 2 s"), { code: "ETIMEDOUT" })); }, 2000);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
  socket.once("error", (error) => { clearTimeout(timer); reject(error); });
});
`;

test("a script in the sandbox reaches nothing outside its grants, and a pilot's work still works", async (t) => {
  // A service listening inside the working folder, such as a dev server's socket.
  const inWork = createServer((socket) => socket.destroy());
  await new Promise((resolve) => inWork.listen(join(task, "app.sock"), resolve));
  cleanups.push(() => new Promise((resolve) => inWork.close(() => resolve())));
  // A process outside whose environment holds the canary, for the /proc probe.
  const holder = spawn("sleep", ["120"], { env: { ...process.env, ZENIUS_CANARY_TOKEN: CANARY }, stdio: "ignore" });
  cleanups.push(() => holder.kill());
  const C = {
    secret: planted.secret,
    outside: join(planted.dir, "written.txt"),
    home: HOME,
    homeFile: join(HOME, `zenius-canary-${process.pid}.txt`),
    launcher: LAUNCHER,
    cliFile: CLI_COPY && join(CLI_COPY, "sdk", "bin", "zenius"),
    record: join(ZHOME, "instances", `${INSTANCE}-canary.json`),
    profile: join(HOME, ".zenius-dev", "profiles", INSTANCE),
    environ: LINUX ? `/proc/${holder.pid}/environ` : "",
    gitHook: join(task, ".git", "hooks", "pre-commit"),
    gitConfig: join(task, ".git", "config"),
    venvGit: join(task, ".venv", "bin", "git"),
    workFile: join(task, "written.txt"),
    settings: join(task, ".claude", "settings.json"),
    newAgentConfig: join(task, ".codex", "config.toml"),
    harness: process.pid,
    sockets: Object.fromEntries(Object.entries(sockets).filter(([name]) => name !== "udpPort")),
    workSocket: join(task, "app.sock"),
    port: Number(new URL(fixtures.base).port),
    udpPort: sockets.udpPort,
    base: fixtures.base,
    linux: LINUX,
  };
  // What a broken sandbox would write outside goes, whatever the run does.
  cleanups.push(() => rmSync(C.homeFile, { force: true }), () => rmSync(C.record, { force: true }));
  const { out, leaks, files } = await script(`const C = ${JSON.stringify(C)};${PRELUDE}
await attempt("read a file outside the grants", () => fs.readFileSync(C.secret, "utf8"));
await attempt("list the home folder", () => fs.readdirSync(C.home).length + " entries");
await attempt("list ~/.ssh", () => fs.readdirSync(C.home + "/.ssh").length + " entries");
await attempt("list the instance's Zen profile", () => fs.readdirSync(C.profile).join(","));
if (C.environ) await attempt("read another process's environment", () => fs.readFileSync(C.environ, "utf8"));
await attempt("write outside the grants", () => { fs.writeFileSync(C.outside, "x"); return "wrote"; });
await attempt("write in the home folder", () => { fs.writeFileSync(C.homeFile, "x"); return "wrote"; });
await attempt("open the launcher to write", () => { fs.closeSync(fs.openSync(C.launcher, "r+")); return "opened"; });
if (C.cliFile) await attempt("open the CLI copy to write", () => { fs.closeSync(fs.openSync(C.cliFile, "r+")); return "opened"; });
await attempt("write an instance record", () => { fs.writeFileSync(C.record, "{}"); return "wrote"; });
await attempt("write a git hook in the working folder", () => { fs.writeFileSync(C.gitHook, "#!/bin/sh\\n"); return "wrote"; });
// A plain git status runs core.fsmonitor; an agent's shell runs .venv/bin's git.
await attempt("set core.fsmonitor in the working folder's .git/config", () => { fs.appendFileSync(C.gitConfig, "\\tfsmonitor = /tmp/planted\\n"); return "wrote"; });
await attempt("plant .venv/bin/git in the working folder", () => { fs.writeFileSync(C.venvGit, "#!/bin/sh\\n", { mode: 0o755 }); return "wrote"; });
await attempt("write a file in the working folder", () => { fs.writeFileSync(C.workFile, "x"); return "wrote"; });
out.outputDir = process.env.ZENIUS_OUTPUT_DIR;
await attempt("write the output folder", () => { const file = process.env.ZENIUS_OUTPUT_DIR + "/probe.txt"; fs.writeFileSync(file, "x"); return file; });
await attempt("write the folder of the project's runs", () => { fs.writeFileSync(process.env.ZENIUS_OUTPUT_DIR.replace(/\\/[^/]+$/, "/planted.txt"), "x"); return "wrote"; });
await attempt("rewrite the working folder's .claude/settings.json", () => { fs.writeFileSync(C.settings, "{}\\n"); return "wrote"; });
await attempt("create agent settings in the working folder", () => { fs.mkdirSync(C.newAgentConfig.replace(/\\/[^/]+$/, "")); fs.writeFileSync(C.newAgentConfig, ""); return "wrote"; });
await attempt("write the temporary folder", () => { const file = os.tmpdir() + "/probe.txt"; fs.writeFileSync(file, "x"); fs.rmSync(file); return os.tmpdir(); });
await attempt("run a program", () => process.getBuiltinModule("node:child_process").execFileSync("/bin/sh", ["-c", "id -un"]).toString().trim());
await attempt("start a worker", () => { new (process.getBuiltinModule("node:worker_threads").Worker)("0", { eval: true }); return "started"; });
await attempt("open the inspector", () => { process.getBuiltinModule("node:inspector").open(0); return "opened"; });
await attempt("load a native add-on", () => { process.dlopen({ exports: {} }, "/usr/lib/libc.so"); return "loaded"; });
await attempt("signal a process outside", () => { process.kill(C.harness, 0); return "signalled"; });
for (const [name, path] of Object.entries(C.sockets)) await attempt("connect to " + name, () => reach(path));
await attempt("connect to a socket in the working folder", () => reach(C.workSocket));
await attempt("connect to a loopback service", () => reach(C.port));
await attempt("send a UDP datagram to a loopback service", () => new Promise((resolve, reject) => {
  const udp = process.getBuiltinModule("node:dgram").createSocket("udp4");
  const close = () => { try { udp.close(); } catch {} };
  // macOS's sandbox refuses send's implicit bind, which Node reports as an
  // 'error' event, not to send's callback: unheard, it would end the script.
  udp.once("error", (error) => { close(); reject(error); });
  udp.send("zenius canary", C.udpPort, "127.0.0.1", (error) => { close(); error ? reject(error) : resolve("sent"); });
}));
await attempt("ask a DNS server", () => new Promise((resolve, reject) => {
  const resolver = new (process.getBuiltinModule("node:dns").Resolver)({ timeout: 1000, tries: 1 });
  resolver.setServers(["127.0.0.1:" + C.udpPort]);
  resolver.resolve4("zenius-canary.invalid", (error, addresses) => (error ? reject(error) : resolve(addresses)));
}));
await attempt("fetch a URL directly", () => fetch(C.base + "/").then((response) => "status " + response.status));
if (C.linux) out.interfaces = Object.keys(os.networkInterfaces());
out.env = Object.keys(process.env).sort();
out.envValues = { NODE_OPTIONS: process.env.NODE_OPTIONS ?? null, ZENIUS_SOCKET: process.env.ZENIUS_SOCKET ?? null, ZENIUS_HOME: process.env.ZENIUS_HOME ?? null, ZENIUS_TASK_SPACE: process.env.ZENIUS_TASK_SPACE ?? null };
out.evilRan = globalThis.EVIL_RAN === true;
out.tmpdir = os.tmpdir();

// The pilot's work, and the browser's half of the same probes (SPEC I5).
// The probes above print whatever happens here.
let task;
try {
  task = await taskSpace("it security sandbox " + process.pid + " " + Date.now());
  const page = task.page("p1");
  await attempt("goto", async () => { await page.goto(C.base + "/upload"); return page.url(); });
  await attempt("snapshot", async () => (await page.snapshot()).split("\\n").length);
  await attempt("upload from the cwd", async () => {
    await page.setInputFiles("#files", process.cwd() + "/mine.txt");
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.uploaded ?? "null") !== null);
    return page.evaluate(() => JSON.parse(document.documentElement.dataset.uploaded ?? "null").map(({ name, text }) => ({ name, text })));
  });
  await attempt("upload a file outside the grants", () => page.setInputFiles("#files", C.secret).then(() => "uploaded"));
  await attempt("upload a link in the cwd to a file outside the grants", () => page.setInputFiles("#files", process.cwd() + "/hosts.txt").then(() => "uploaded"));
  await attempt("open a file outside the grants in the browser", () => page.goto("file://" + C.secret).then(() => page.url()));
  await page.goto(C.base + "/");
  await attempt("screenshot to the cwd", () => page.screenshot({ path: process.cwd() + "/shot.png" }));
  await attempt("screenshot to a relative path", () => page.screenshot({ path: "shot.png" }));
  await page.goto(C.base + "/download");
  const waiting = page.waitForEvent("download");
  await page.click("#get");
  const download = await waiting;
  await attempt("download to the cwd", () => download.saveAs(process.cwd() + "/report.bin"));
  await attempt("download to a relative path", () => download.saveAs("report.bin"));
} catch (error) {
  out.browser = { ok: false, code: error?.code ?? error?.name ?? null, message: String(error?.message ?? error).slice(0, 300) };
} finally {
  await task?.finish({ keep: [] }).catch(() => {});
}
console.log(JSON.stringify(out));
`, { env: { ZENIUS_TASK_SPACE: "12" } });
  const got = leaks.map((name) => `the canary reached the script through ${name}`);
  if (out.browser) got.push(`the browser half stopped: ${out.browser.code}: ${out.browser.message}`);
  const failed = (name) => {
    const result = out[name];
    if (result === undefined) got.push(`${name}: the probe didn't run`);
    else if (result.ok) got.push(`${name}: ${JSON.stringify(result.value).slice(0, 200)}`);
  };
  for (const name of [
    "read a file outside the grants",
    "list the home folder",
    "list ~/.ssh",
    "list the instance's Zen profile",
    ...(LINUX ? ["read another process's environment"] : []),
    "write outside the grants",
    "write in the home folder",
    "open the launcher to write",
    ...(CLI_COPY ? ["open the CLI copy to write"] : []),
    "write an instance record",
    "write a git hook in the working folder",
    "set core.fsmonitor in the working folder's .git/config",
    "plant .venv/bin/git in the working folder",
    "write a file in the working folder",
    "create agent settings in the working folder",
    "rewrite the working folder's .claude/settings.json",
    "write the folder of the project's runs",
    "run a program",
    "start a worker",
    "open the inspector",
    "signal a process outside",
    ...Object.keys(C.sockets).map((name) => `connect to ${name}`),
    "connect to a loopback service",
    "ask a DNS server",
    "fetch a URL directly",
    "upload a file outside the grants",
    "upload a link in the cwd to a file outside the grants",
    "open a file outside the grants in the browser",
    "screenshot to the cwd",
    "download to the cwd",
  ]) {
    failed(name);
  }
  // Node's permission model follows the link and the OS sandbox lets /etc be read, so the CLI's own check refuses it.
  const viaLink = out["upload a link in the cwd to a file outside the grants"];
  if (viaLink && !viaLink.ok && viaLink.code !== "ZEN_PATH_NOT_ALLOWED") got.push(`upload a link in the cwd to a file outside the grants: ${viaLink.code}: ${viaLink.message}`);
  // Refused by Node's permission model, not merely failing to load.
  const addon = out["load a native add-on"];
  if (addon?.ok || !["ERR_DLOPEN_DISABLED", "ERR_ACCESS_DENIED"].includes(addon?.code)) got.push(`load a native add-on: ${JSON.stringify(addon)}`);
  // Whatever a probe said, nothing may have changed outside.
  for (const [what, path] of [
    ["a file outside the grants", C.outside],
    ["a file in the home folder", C.homeFile],
    ["an instance record", C.record],
    ["a git hook", C.gitHook],
    [".venv/bin/git", C.venvGit],
    ["a file in the working folder", C.workFile],
    ["agent settings in the working folder", C.newAgentConfig],
    ["a screenshot in the working folder", join(task, "shot.png")],
    ["a download in the working folder", join(task, "report.bin")],
  ]) {
    if (existsSync(path)) {
      got.push(`${what} was written: ${path}`);
      rmSync(path, { force: true });
    }
  }
  if (readFileSync(C.settings, "utf8") !== "{}\n") got.push("the working folder's .claude/settings.json changed");
  if (readFileSync(C.gitConfig, "utf8") !== GIT_CONFIG) got.push("the working folder's .git/config changed");
  // A datagram sent in a separate network namespace never arrives; out here it would.
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (udpHits > 0) got.push(`${udpHits} UDP datagram${udpHits === 1 ? "" : "s"} reached the harness`);
  if (LINUX && !(out.interfaces ?? []).every((name) => name === "lo")) got.push(`network interfaces in the sandbox: ${out.interfaces.join(", ")}`);
  const extra = out.env.filter((name) => !PASSED.has(name));
  if (extra.length) got.push(`variables that got in: ${extra.join(", ")}`);
  if (out.envValues.NODE_OPTIONS !== null || out.evilRan) got.push(`NODE_OPTIONS got in (${out.envValues.NODE_OPTIONS}; its --require ran: ${out.evilRan})`);
  if (out.envValues.ZENIUS_SOCKET !== SOCKET) got.push(`ZENIUS_SOCKET in the sandbox is ${out.envValues.ZENIUS_SOCKET}, not the instance's ${SOCKET}`);
  if (out.envValues.ZENIUS_HOME !== ZHOME) got.push(`ZENIUS_HOME in the sandbox is ${out.envValues.ZENIUS_HOME}, not ${ZHOME}`);
  // The agent sidebar's task id for a resumed chat's zenius mcp passes through as it is.
  if (out.envValues.ZENIUS_TASK_SPACE !== "12") got.push(`ZENIUS_TASK_SPACE in the sandbox is ${out.envValues.ZENIUS_TASK_SPACE}, not the "12" it was given`);

  // The pilot's work.
  const works = (name, check = () => true) => {
    const result = out[name];
    if (!result?.ok) got.push(`${name} failed: ${result ? `${result.code}: ${result.message}` : "didn't run"}`);
    else if (!check(result.value)) got.push(`${name} returned ${JSON.stringify(result.value).slice(0, 200)}`);
  };
  works("write the temporary folder", (dir) => dir.startsWith(realpathSync(join(work, "tmp"))));
  works("goto", (url) => url === `${fixtures.base}/upload`);
  works("snapshot", (lines) => lines > 0);
  works("upload from the cwd", (files) => JSON.stringify(files) === JSON.stringify([{ name: "mine.txt", text: "the agent's own file\n" }]));
  // What a relative path names lands in the run's output folder, outside the
  // working folder, and the output lists it by its absolute path.
  const outputDir = out.outputDir ?? "";
  if (!outputDir.startsWith(`${OUT_ROOT}/task-`) || outputDir.startsWith(`${task}/`)) got.push(`the output folder is ${outputDir}, not one in ${OUT_ROOT}`);
  works("write the output folder", (path) => path === `${outputDir}/probe.txt`);
  works("screenshot to a relative path", (path) => path === `${outputDir}/shot.png`);
  works("download to a relative path", (path) => path === `${outputDir}/report.bin`);
  const shot = `${outputDir}/shot.png`;
  if (!existsSync(shot) || !readFileSync(shot).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) got.push("shot.png in the output folder isn't a PNG");
  const report = `${outputDir}/report.bin`;
  if (!existsSync(report) || !readFileSync(report).equals(REPORT)) got.push("report.bin in the output folder isn't the download");
  if (JSON.stringify(files) !== JSON.stringify([shot, report])) got.push(`the output listed ${JSON.stringify(files)}, not the screenshot and the download`);

  // Only macOS's profile stops this: Node doesn't check a socket's path.
  const gaps = {
    "connect to a socket in the working folder": "a script can connect to a socket inside the working folder",
  };
  for (const [name, gap] of Object.entries(gaps)) {
    if (!out[name]?.ok) continue;
    if (LINUX) t.diagnostic(`known gap on Linux: ${gap}`);
    else got.push(`${name}: ${JSON.stringify(out[name].value)}`);
  }
  assert.deepEqual(got, [], `${got.length} problem${got.length === 1 ? "" : "s"} in the sandbox:\n- ${got.join("\n- ")}`);
});

test("zenius --version and zenius doctor say they run in the sandbox, and doctor reaches the instance", async () => {
  const version = await launch(["--version"]);
  assert.equal(version.code, 0, version.stderr);
  assert.match(version.stdout, /^zenius \d+\.\d+\.\d+ \(protocol 1, sandboxed\)\n$/);
  const doctor = await launch(["doctor", "--json", "--instance", INSTANCE]);
  assert.equal(doctor.code, 0, `${doctor.stdout}\n${doctor.stderr}`);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.sandboxed, true);
  const status = Object.fromEntries(report.checks.map((check) => [check.id, check.status]));
  assert.deepEqual(status, { cli: "ok", zen: "skip", autoconfig: "skip", profile: "skip", loader: "skip", runtime: "skip", sidebar: "skip", mcp: "skip", instance: "ok", daily: "skip", boundary: "ok", dns: "skip", pagecode: "skip" });
  // The real runtime's I5 report, read from inside the sandbox.
  assert.equal(
    report.checks.find((check) => check.id === "boundary").summary,
    "agents load only http:, https:, data:, blob: and about:blank; page gate on; self-tests refused about:config, file:/// and a browser document",
  );
  assert.match(report.checks.find((check) => check.id === "instance").summary, /^running, pid \d+, /);
});

test("the launcher grants no working folder that holds more than a task: home, temp, credentials, zenius, its node", async () => {
  // A home of the test's own, so the credentials cases never touch the real ones.
  const fake = join(work, "home");
  for (const dir of [".ssh/keys", ".config/app", "Library/Keychains"]) mkdirSync(join(fake, dir), { recursive: true });
  const cases = [
    { name: "the home folder", cwd: HOME },
    { name: "a temp folder", cwd: LINUX ? "/tmp" : "/private/tmp" },
    { name: "a folder in ~/.ssh", cwd: join(fake, ".ssh", "keys"), env: { HOME: fake } },
    { name: "a folder in ~/.config", cwd: join(fake, ".config", "app"), env: { HOME: fake } },
    { name: "a folder in ~/Library", cwd: join(fake, "Library", "Keychains"), env: { HOME: fake } },
    ...(CLI_COPY ? [{ name: "the CLI copy", cwd: join(CLI_COPY, "sdk") }] : []),
    // A script there could change the node the launcher (and the user) runs.
    { name: "the node's own folder", cwd: dirname(dirname(realpathSync(launcherNode()))) },
  ];
  const got = [];
  for (const { name, cwd, env } of cases) {
    const file = join(cwd, `zenius-canary-cwd-${process.pid}.txt`);
    cleanups.push(() => rmSync(file, { force: true }));
    const { out, leaks } = await script(`${PRELUDE}
out.cwd = process.cwd();
await attempt("write", () => { fs.writeFileSync(${JSON.stringify(file)}, "x"); return "wrote"; });
console.log(JSON.stringify(out));
`, { cwd, env });
    if (leaks.length) got.push(`${name}: the canary got in through ${leaks.join(", ")}`);
    if (out.cwd === realpathSync(cwd)) got.push(`${name}: the script ran in it`);
    if (out.write?.ok || existsSync(file)) got.push(`${name}: the script wrote in it`);
    rmSync(file, { force: true });
  }
  assert.deepEqual(got, []);
});

test("the launcher's own shell runs nothing the caller's environment names: SHELLOPTS and PS4, BASH_ENV, functions, PATH", async () => {
  // Whatever runs leaves a marker here.
  const dir = mkdtempSync(join(work, "caller-"));
  const touch = (name) => `/usr/bin/touch '${join(dir, `${name}.marker`)}'`;
  writeFileSync(join(dir, "hook.sh"), `${touch("bash-env")}\n`);
  // A folder on the caller's PATH that a script could write, such as a
  // project's .venv/bin, holding each command the launcher runs by name.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["mkdir", "chmod", "find", "mktemp", "readlink", "env", "cat", "sed", "id", "uname"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${touch(`path-${name}`)}\nexit 1\n`, { mode: 0o755 });
  }
  const { code, stdout, stderr } = await launch(["--version"], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      // bash 3.2, macOS's /bin/sh, reads both: xtrace expands PS4 before each command.
      SHELLOPTS: "xtrace",
      PS4: `$(${touch("shellopts-ps4")})`,
      BASH_ENV: join(dir, "hook.sh"),
      ENV: join(dir, "hook.sh"),
      "BASH_FUNC_mkdir%%": `() { ${touch("function-mkdir")}; }`,
      "BASH_FUNC_cd%%": `() { ${touch("function-cd")}; }`,
    },
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /\(protocol 1, sandboxed\)/);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".marker")), []);
});

test("each run writes an output folder of its own, and reads only its working folder's earlier ones", async () => {
  const first = await script(`${PRELUDE}
out.file = process.env.ZENIUS_OUTPUT_DIR + "/first.txt";
fs.writeFileSync(out.file, "the first run's");
console.log(JSON.stringify(out));
`);
  const file = first.out.file;
  const probe = (cwd) =>
    script(`${PRELUDE}
out.dir = process.env.ZENIUS_OUTPUT_DIR;
await attempt("read", () => fs.readFileSync(${JSON.stringify(file)}, "utf8"));
await attempt("change", () => { fs.writeFileSync(${JSON.stringify(file)}, "changed"); return "wrote"; });
await attempt("add", () => { fs.writeFileSync(${JSON.stringify(join(dirname(file), "added.txt"))}, "x"); return "wrote"; });
console.log(JSON.stringify(out));
`, { cwd });
  const other = join(work, "other");
  mkdirSync(other, { recursive: true });
  const [same, elsewhere] = [(await probe(task)).out, (await probe(other)).out];
  const got = [];
  if (dirname(same.dir) !== dirname(dirname(file)) || same.dir === dirname(file)) got.push(`a second run in the same folder got ${same.dir}, beside ${dirname(file)}`);
  if (!elsewhere.dir.startsWith(`${OUT_ROOT}/other-`)) got.push(`a run in another folder got ${elsewhere.dir}`);
  if (!same.read?.ok || same.read.value !== "the first run's") got.push(`a later run couldn't read an earlier one's output: ${JSON.stringify(same.read)}`);
  for (const [who, result] of [["a later run", same], ["another folder's run", elsewhere]]) {
    if (result.change?.ok !== false) got.push(`${who} changed an earlier run's output`);
    if (result.add?.ok !== false) got.push(`${who} added to an earlier run's output folder`);
  }
  if (elsewhere.read?.ok !== false) got.push("another folder's run read this folder's output");
  if (readFileSync(file, "utf8") !== "the first run's") got.push("the earlier run's output changed");
  if (existsSync(join(dirname(file), "added.txt"))) got.push("a file appeared in the earlier run's output folder");
  assert.deepEqual(got, []);
});

// install-cli.sh --sandbox --read-dir, the user's ~/Downloads (D4 in
// docs/briefs/defenses-evidence.md); run.sh installs with a folder of its own.
test("a script reads and uploads from the install's read folder, writes nothing there, and can't upload a link in it to a file outside", async () => {
  const reads = launcherValue("READ_DIR");
  assert.ok(reads, "run.sh installs the launcher with --read-dir");
  writeFileSync(join(reads, "report.txt"), "from the read folder\n");
  mkdirSync(join(reads, "sub"), { recursive: true });
  writeFileSync(join(reads, "sub", "deep.txt"), "deep\n");
  rmSync(join(reads, "hosts.txt"), { force: true });
  symlinkSync("/etc/hosts", join(reads, "hosts.txt"));
  const { out, leaks } = await script(`${PRELUDE}
const C = ${JSON.stringify({ reads, base: fixtures.base })};
out.readDir = process.env.ZENIUS_READ_DIR ?? null;
await attempt("read", () => fs.readFileSync(C.reads + "/report.txt", "utf8"));
await attempt("read a subfolder", () => fs.readFileSync(C.reads + "/sub/deep.txt", "utf8"));
await attempt("add", () => { fs.writeFileSync(C.reads + "/added.txt", "x"); return "wrote"; });
await attempt("change", () => { fs.writeFileSync(C.reads + "/report.txt", "changed"); return "wrote"; });
let task;
try {
  task = await taskSpace("it security read folder " + process.pid + " " + Date.now());
  const page = task.page("p1");
  await page.goto(C.base + "/upload");
  await attempt("upload", async () => {
    await page.setInputFiles("#files", C.reads + "/report.txt");
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.uploaded ?? "null") !== null);
    return page.evaluate(() => JSON.parse(document.documentElement.dataset.uploaded ?? "null").map(({ name, text }) => ({ name, text })));
  });
  await attempt("upload a link out", () => page.setInputFiles("#files", C.reads + "/hosts.txt").then(() => "uploaded"));
} finally {
  await task?.finish({ keep: [] });
}
console.log(JSON.stringify(out));
`);
  const got = [...leaks.map((name) => `the canary showed in ${name}`)];
  if (out.readDir !== reads) got.push(`ZENIUS_READ_DIR was ${out.readDir}, not ${reads}`);
  if (out.read?.value !== "from the read folder\n") got.push(`read: ${JSON.stringify(out.read)}`);
  if (out["read a subfolder"]?.value !== "deep\n") got.push(`read a subfolder: ${JSON.stringify(out["read a subfolder"])}`);
  if (out.add?.ok !== false || existsSync(join(reads, "added.txt"))) got.push("a script added a file to the read folder");
  if (out.change?.ok !== false || readFileSync(join(reads, "report.txt"), "utf8") !== "from the read folder\n") got.push("a script changed a file in the read folder");
  if (JSON.stringify(out.upload?.value) !== JSON.stringify([{ name: "report.txt", text: "from the read folder\n" }])) got.push(`upload: ${JSON.stringify(out.upload)}`);
  const viaLink = out["upload a link out"];
  if (viaLink?.code !== "ZEN_PATH_NOT_ALLOWED" || !viaLink.message.includes(`and ${reads}, and `)) got.push(`upload a link out: ${JSON.stringify(viaLink)}`);
  assert.deepEqual(got, []);
});

test("a read folder wider than a task's stops the launcher with the reason, and one that has gone is just not granted", async () => {
  const text = readFileSync(LAUNCHER, "utf8");
  let made = 0;
  const doctored = (dir) => {
    const file = join(work, `launcher-${(made += 1)}`);
    writeFileSync(file, text.replace(/^READ_DIR='.*'$/m, `READ_DIR='${dir.replaceAll("'", "'\\''")}'`), { mode: 0o755 });
    return file;
  };
  const got = [];
  for (const dir of [HOME, ZHOME, "/tmp", "/"]) {
    const result = await launch(["--version"], { launcher: doctored(dir) });
    const said = /^zenius \(sandboxed\): the folder this install lets scripts read, (.*), holds more than a task's files/.exec(result.stderr);
    if (result.code !== 70 || !said) got.push(`${dir}: exit ${result.code}, ${result.stderr.trim().slice(0, 300)}`);
  }
  const gone = await launch(["--version"], { launcher: doctored(join(work, "gone")) });
  if (gone.code !== 0 || !/\(protocol 1, sandboxed\)/.test(gone.stdout)) got.push(`a folder that has gone: exit ${gone.code}, ${gone.stderr.trim().slice(0, 300)}`);
  assert.deepEqual(got, []);
});

test("inside a Codex sandbox it can't work in, the launcher says why and stops before any step", async () => {
  // Linux: Codex sets CODEX_SANDBOX_NETWORK_DISABLED=1 while its seccomp
  // refuses every socket, Zen's and bubblewrap's loopback. macOS: Codex's
  // Seatbelt (CODEX_SANDBOX=seatbelt) lets no sandbox-exec start inside it.
  const [env, said] =
    process.platform === "darwin"
      ? [{ CODEX_SANDBOX: "seatbelt" }, /^zenius \(sandboxed\): this runs inside Codex's Seatbelt sandbox, and macOS lets no sandbox start inside another/]
      : [{ CODEX_SANDBOX_NETWORK_DISABLED: "1" }, /^zenius \(sandboxed\): Codex's sandbox has network access off, which blocks every socket, Zen's included/];
  const { code, stdout, stderr } = await launch(["--version"], { env });
  assert.equal(code, 70, stdout + stderr);
  assert.match(stderr, said);
  assert.match(stderr, /Rerun this zenius command outside Codex's sandbox \(sandbox_permissions "require_escalated"\)/);
  assert.equal(stdout, "");
});

test("a temporary folder the launcher can't make, or a link in its place, stops it with the reason", { skip: process.getuid?.() === 0 && "root may write any folder" }, async () => {
  const name = `zenius-sandbox-${process.getuid()}`;
  const locked = mkdtempSync(join(work, "locked-"));
  chmodSync(locked, 0o500);
  const dangling = mkdtempSync(join(work, "dangling-"));
  symlinkSync(join(dangling, "nowhere"), join(dangling, name));
  const linked = mkdtempSync(join(work, "linked-"));
  mkdirSync(join(linked, "real"), { mode: 0o700 });
  symlinkSync(join(linked, "real"), join(linked, name));
  const got = [];
  try {
    for (const [tmp, said] of [
      [locked, `can't make ${join(locked, name)}: set TMPDIR to a folder zenius may write; if this runs inside another sandbox, it must let zenius write ${locked}`],
      [dangling, `${join(dangling, name)} isn't a folder of yours`],
      [linked, `${join(linked, name)} isn't a folder of yours`],
    ]) {
      const { code, stdout, stderr } = await launch(["--version"], { env: { TMPDIR: tmp } });
      if (code !== 70 || stdout !== "" || !stderr.startsWith(`zenius (sandboxed): ${said}`)) got.push(`TMPDIR ${tmp}: exit ${code}: ${stderr}${stdout}`);
    }
  } finally {
    chmodSync(locked, 0o700);
  }
  assert.deepEqual(got, []);
  // Nothing was made in the link's place or through it.
  assert.deepEqual(readdirSync(join(linked, "real")), []);
});

test("the launcher passes the claim prompt's label for the agent, and none of the agent's own variables", async () => {
  const probe = `console.log(JSON.stringify({ client: process.env.ZENIUS_CLIENT ?? null, claude: process.env.CLAUDECODE ?? null, codex: process.env.CODEX_SANDBOX ?? null }));`;
  // spawn drops undefined values, so these start unset whatever the harness's shell has.
  const none = { ZENIUS_CLIENT: undefined, CLAUDECODE: undefined, CODEX_SANDBOX: undefined, CODEX_SANDBOX_NETWORK_DISABLED: undefined };
  const got = [];
  for (const [env, client] of [
    [{ ...none, CLAUDECODE: "1" }, "Claude Code"],
    // The variable that doesn't stop the launcher on this platform (the test above).
    [process.platform === "darwin" ? { ...none, CODEX_SANDBOX_NETWORK_DISABLED: "1" } : { ...none, CODEX_SANDBOX: "seatbelt" }, "Codex"],
    [{ ...none, ZENIUS_CLIENT: "Research bot", CLAUDECODE: "1" }, "Research bot"],
    [none, null],
  ]) {
    const { out } = await script(probe, { env });
    const want = { client, claude: null, codex: null };
    if (JSON.stringify(out) !== JSON.stringify(want)) got.push(`${JSON.stringify(env)}: ${JSON.stringify(out)}`);
  }
  assert.deepEqual(got, []);
});

// The task's source for the sidebar (docs/briefs/external-tasks.md): display
// text the runtime keeps only within its label set, and the sidebar's own
// conversation id (ZENIUS_SIDEBAR_TASK, which the sidebar's zenius mcp gets),
// passed exactly or not at all.
test("the launcher passes the task's source: a plain HC_TERMINAL_ID, a plain ZENIUS_SIDEBAR_TASK, and the working folder's name even when it isn't granted", async () => {
  const probe = `console.log(JSON.stringify({ terminal: process.env.HC_TERMINAL_ID ?? null, sidebar: process.env.ZENIUS_SIDEBAR_TASK ?? null, folder: process.env.ZENIUS_FOLDER ?? null, cwd: process.cwd() }));`;
  const uid = "3f2c9a10-7b4e-4c1d-9a2f-0e5d6c7b8a91";
  const got = [];
  for (const [env, terminal, sidebar] of [
    [{ HC_TERMINAL_ID: "t5x", ZENIUS_SIDEBAR_TASK: uid }, "t5x", uid],
    [{ HC_TERMINAL_ID: "t5x; touch /tmp/x", ZENIUS_SIDEBAR_TASK: `${uid}; touch /tmp/x` }, null, null],
    [{ HC_TERMINAL_ID: undefined, ZENIUS_SIDEBAR_TASK: "a".repeat(64) }, null, "a".repeat(64)],
    [{ HC_TERMINAL_ID: undefined, ZENIUS_SIDEBAR_TASK: "a".repeat(65) }, null, null],
    [{ HC_TERMINAL_ID: undefined, ZENIUS_SIDEBAR_TASK: "3f2c_9a10" }, null, null],
    [{ HC_TERMINAL_ID: undefined, ZENIUS_SIDEBAR_TASK: undefined }, null, null],
  ]) {
    const { out } = await script(probe, { env });
    if (out.terminal !== terminal || out.sidebar !== sidebar || out.folder !== "task") got.push(`${JSON.stringify(env)}: ${JSON.stringify(out)}`);
  }
  // The home folder isn't granted, so the script starts in its temporary
  // folder; the source still names the folder, by its name only.
  const home = (await script(probe, { cwd: HOME, env: { HC_TERMINAL_ID: "t5x" } })).out;
  if (home.folder !== basename(realpathSync(HOME)) || home.cwd === realpathSync(HOME)) got.push(`the home folder: ${JSON.stringify(home)}`);
  assert.deepEqual(got, []);
});

test("each run has a temporary folder of its own: no run reads what another left there", async () => {
  const first = await script(`${PRELUDE}
out.file = os.tmpdir() + "/left.txt";
fs.writeFileSync(out.file, "left by the first run");
console.log(JSON.stringify(out));
`);
  const file = first.out.file;
  const second = await script(`${PRELUDE}
out.tmpdir = os.tmpdir();
await attempt("read the first run's file", () => fs.readFileSync(${JSON.stringify(file)}, "utf8"));
await attempt("list the runs' folders", () => fs.readdirSync(${JSON.stringify(dirname(dirname(file)))}).join(","));
console.log(JSON.stringify(out));
`);
  assert.notEqual(second.out.tmpdir, dirname(file));
  for (const name of ["read the first run's file", "list the runs' folders"]) {
    assert.equal(second.out[name].ok, false, `${name}: ${JSON.stringify(second.out[name].value)}`);
  }
  // The file stays where the agent, outside the sandbox, can read it.
  assert.equal(readFileSync(file, "utf8"), "left by the first run");
});
