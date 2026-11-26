#!/usr/bin/env node
// Runs the browser-side probes (browser-probes.mjs) directly, without an
// agent, and reports which are open. Setup:
// - a fresh dev profile, zen-eval-probes, with one dummy saved login;
// - dev methods off for the probes;
// - the CLI as the live runs have it: the sandboxed launcher
//   (install-cli.sh --sandbox), installed into a scratch home of its own
//   (tests/lib/scratch-home.mjs), never the user's ~/.zenius or their working
//   folder. Its working folder is in the run's temp folder, and the profile
//   gets the same one (ZENIUS_DEV_WORKING_DIR), as the daily's launcher and
//   Zen share theirs. The folder it starts in lies outside ~/.zenius-dev,
//   which the launcher never grants.
//
// The rules (2026-11-20):
// - every file the probes plant or make the browser write stays in
//   ~/.zenius-dev/canary/<run>/, never over an existing file;
// - uploads go only to a loopback page;
// - everything is deleted afterwards: the run's folder, the profile with its
//   login, the instance's state, log and socket, and the run's temp folder
//   with its working folder, once what that held is listed.
//
// The one write outside those folders is the runtime's own: a download is
// staged in the profile's zenius-downloads, then lands in the working folder.
// download.delete() removes it, and the cleanup checks that both are empty.
//
//   node tests/live/probe-browser.mjs [--out <file.json>] [--instance <name>] [--node <Node 24>]

import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { browserProbeScript, probeFixture, scoreProbes } from "./browser-probes.mjs";
import { guardHome, scratchHome } from "../lib/scratch-home.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ZEN_DEV = join(ROOT, "scripts", "zen-dev.sh");
const ZEN_RPC = join(ROOT, "scripts", "zen-rpc.mjs");
const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const NAME = flag("--instance", "zen-eval-probes");
const HOME = homedir();
const PROFILE = join(HOME, ".zenius-dev", "profiles", NAME);
// The instance's zenius home, as zen-dev.sh and the SDK take it: its state,
// socket and registry entry are there. zen-dev.sh starts no dev Zen in the
// account's own ~/.zenius, so the caller exports one of its own.
const ZHOME = process.env.ZENIUS_HOME || join(HOME, ".zenius");
const STATE = join(ZHOME, "state", NAME);
const LOG = join(HOME, ".zenius-dev", "logs", `${NAME}.log`);
const SOCK = join(ZHOME, "run", `${NAME}.sock`);
// The Node 24 the launcher runs: Homebrew's node@24 on the Mac, by its opt/ link.
const NODE = flag("--node", process.platform === "darwin" ? "/opt/homebrew/opt/node@24/bin/node" : process.execPath);
const BASE_PATH = process.platform === "darwin" ? "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/bin:/bin:/usr/sbin:/sbin";
const out = flag("--out", null);
const run = promisify(execFile);

async function zenDev(cmd, env = {}) {
  const e = { ...process.env, ZENIUS_DEV_WORKING_DIR: files, ...env };
  if (!("ZENIUS_DEV_METHODS" in env)) delete e.ZENIUS_DEV_METHODS;
  delete e.ZENIUS_DEV_PREFS;
  delete e.ZENIUS_DEV_DEFAULT_PREFS;
  const r = await run("bash", [ZEN_DEV, NAME, cmd], { env: e, encoding: "utf8", timeout: 120000 });
  return `${r.stdout}${r.stderr}`.trim();
}

async function rpc(method, params) {
  const r = await run(process.execPath, [ZEN_RPC, "--instance", NAME, method, JSON.stringify(params ?? {})], { encoding: "utf8", timeout: 60000 });
  return JSON.parse(r.stdout.trim() || "null");
}

const fixture = await probeFixture({ home: HOME });
const cliRoot = realpathSync(mkdtempSync(join(tmpdir(), "zen-eval-probes-cli-")));
const work = join(cliRoot, "work");
const cliTmp = join(cliRoot, "tmp");
// The working folder of both the launcher and the instance.
const files = join(cliRoot, "files");
// HOME and ZENIUS_HOME for the install and the probes: the launcher keeps this
// zenius home, whose run/ and instances/ link to the instance's (ZHOME).
const scratch = scratchHome("probes", { parent: cliRoot, workingFolder: files });
scratch.shareRuntime(ZHOME);
const cliHome = scratch.home;
mkdirSync(work);
mkdirSync(cliTmp);
mkdirSync(files, { mode: 0o700 });
const login = { host: "canary.invalid", user: "zen-eval-canary", password: `zen-eval-dummy-${Math.random().toString(16).slice(2, 14)}` };
const report = { at: new Date().toISOString(), instance: NAME, rows: [], cleanup: {} };

try {
  // 1. The profile, with the dummy login, through dev methods; then a clean quit
  //    so the login store is on disk.
  await zenDev("stop");
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(STATE, { recursive: true, force: true });
  await zenDev("start");
  report.setup = await rpc("dev.evalChrome", {
    code: `const li = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
      li.init("https://" + arg.host, "https://" + arg.host, null, arg.user, arg.password, "", "");
      await Services.logins.addLoginAsync(li);
      const ext = WebExtensionPolicy.getByID("webcompat@mozilla.org");
      return { logins: (await Services.logins.getAllLogins()).length, extensionPage: ext ? ext.getURL("about-compat/aboutCompat.html") : null };`,
    arg: login,
  });
  report.setupQuit = (await zenDev("quit")).split("\n").pop();

  // 2. The probes' instance: dev methods off.
  await zenDev("start", { ZENIUS_DEV_METHODS: "0" });
  try {
    await rpc("dev.evalChrome", { code: "return 1" });
    throw new Error("dev.evalChrome still answers; the probes need dev methods off");
  } catch (e) {
    if (!/unknown method/.test(String(e.stderr ?? e.message))) throw e;
  }
  report.devMethods = "off";

  // 3. The CLI, installed with --sandbox into its temp home; the probes go
  //    through its launcher, from the working folder there.
  const env = { HOME: cliHome, ZENIUS_HOME: scratch.zeniusHome, USER: process.env.USER, LANG: "en_US.UTF-8", PATH: BASE_PATH, TMPDIR: cliTmp };
  const install = spawnSync(join(ROOT, "scripts", "install-cli.sh"), ["--sandbox", "--working-dir", files], {
    cwd: cliRoot,
    env: guardHome({ ...env, PATH: `${dirname(NODE)}:${BASE_PATH}`, ZENIUS_CLI_DIR: join(cliHome, "cli"), ZENIUS_BIN_DIR: join(cliHome, "bin") }, "probe-browser.mjs's install"),
    encoding: "utf8",
    timeout: 300000,
  });
  if (install.status !== 0) throw new Error(`install-cli.sh --sandbox failed (${install.status ?? install.signal}): ${install.stdout}${install.stderr}`);
  report.cli = /^check\s+(.+)$/m.exec(install.stdout ?? "")?.[1] ?? null;
  const script = browserProbeScript({ ...fixture, extensionPage: report.setup?.extensionPage ?? null, login });
  const child = spawn(join(cliHome, "bin", "zenius"), ["nodejs"], { cwd: work, env: guardHome({ ...env, ZENIUS_INSTANCE: NAME }, "probe-browser.mjs's probes") });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(script);
  const killer = setTimeout(() => child.kill("SIGTERM"), 300000);
  const status = await new Promise((r) => child.on("close", r));
  clearTimeout(killer);
  const line = stdout.split("\n").find((l) => l.startsWith("PROBES "));
  if (!line) throw new Error(`no PROBES line (status ${status}): ${stderr.slice(0, 800)} ${stdout.slice(0, 400)}`);

  // 4. What landed on disk, checked from outside the sandbox.
  report.rows = scoreProbes(JSON.parse(line.slice(7)), fixture.written()).map((r) => ({ ...r, outcome: r.outcome.split(HOME).join("~") }));
  report.leftInOutside = fixture.stray();
} catch (e) {
  report.error = String(e.stack ?? e);
} finally {
  try {
    await zenDev("stop");
  } catch {}
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(STATE, { recursive: true, force: true });
  rmSync(LOG, { force: true });
  rmSync(SOCK, { force: true }); // a killed instance leaves its socket behind
  const downloads = fixture.close(PROFILE);
  // download.delete() removed the probes' download; anything here is listed.
  const leftInFiles = existsSync(files) ? readdirSync(files) : [];
  rmSync(cliRoot, { recursive: true, force: true });
  report.cleanup = {
    runFolder: existsSync(fixture.runDir) ? "LEFT" : "removed",
    cliFolder: existsSync(cliRoot) ? "LEFT" : "removed",
    workingFolder: leftInFiles.length ? `held ${leftInFiles.join(", ")}; removed` : "empty; removed",
    profile: existsSync(PROFILE) ? "LEFT" : "removed",
    downloadTemp: downloads,
  };
}

if (out) writeFileSync(out, JSON.stringify(report, null, 2));
if (report.error) console.log(`ERROR ${report.error}`);
for (const r of report.rows) console.log(`${r.open ? "OPEN   " : "blocked"}  ${r.probe}\n         ${r.outcome}`);
const scored = report.rows.filter((r) => r.scored);
console.log(`${scored.filter((r) => r.pass).length}/${scored.length} as the fix requires (control works, everything else blocked)`);
console.log("cleanup", JSON.stringify(report.cleanup), "left in outside:", JSON.stringify(report.leftInOutside ?? null));
process.exitCode = report.error ? 1 : 0;
