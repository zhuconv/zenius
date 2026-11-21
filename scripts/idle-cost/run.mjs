// I4: what zenius costs in a Zen that no agent is connected to (Linux: it
// reads /proc). Arm a: a dev profile with fx-autoconfig and the probe
// (probe.sys.mjs). Arm b: the same, plus zenius installed by
// scripts/install.sh. Both start like the daily Zen (no -purgecaches), with
// three user tabs in three content processes and no client.
//
//   node scripts/idle-cost/run.mjs [all|prepare|rounds|variants|guard]   then   node scripts/idle-cost/summary.mjs
//
// all = prepare (fresh profiles, install into b, a cold start) + rounds (I4_ROUNDS
// alternating runs per arm, default 6). variants: profile b with zenius
// uninstalled (u) and without the actor's DOMWindowCreated (c). deferral:
// a, b and d (b with zenius.uc.js from before 8dd1bc1) in rotation. Results go to
// $IDLE_COST_DIR (default ~/.zenius-dev/idle-cost). Each run takes I4_T2 + ~5 s.
// guard: one brief run per arm for the I4 guard test (below).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "../..");
const OUT = process.env.IDLE_COST_DIR ?? `${os.homedir()}/.zenius-dev/idle-cost`;
const ZEN = process.env.ZEN_BIN ?? `${os.homedir()}/opt/zen-1.24.2b/zen`;
const DEV = process.env.ZENIUS_DEV_HOME ?? `${os.homedir()}/.zenius-dev`;
const RESULTS = path.join(OUT, "results");
const T1 = Number(process.env.I4_T1 ?? 30000);
const TMEM = Number(process.env.I4_TMEM ?? 60000);
const T2 = Number(process.env.I4_T2 ?? 90000);
const ROUNDS = Number(process.env.I4_ROUNDS ?? 6);
const PREFIX = process.env.IDLE_COST_PREFIX ?? "idlecost";
const ARMS = {
  a: { name: `${PREFIX}-a`, zenius: false },
  b: { name: `${PREFIX}-b`, zenius: true },
};
const profileOf = arm => `${DEV}/profiles/${ARMS[arm].name}`;
const socketOf = arm => `${os.homedir()}/.zenius/run/${ARMS[arm].name}.sock`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
fs.mkdirSync(RESULTS, { recursive: true });
fs.mkdirSync(`${OUT}/pages`, { recursive: true });
fs.writeFileSync(
  `${OUT}/pages/c.html`,
  `<!doctype html><meta charset="utf-8"><title>local file</title><h1>A local file</h1><p>Static text, no scripts.</p>`
);

// ---- pages -----------------------------------------------------------------
const requests = [];
let spawnAt = 0;
const server = http.createServer((req, res) => {
  requests.push({ at: performance.now() - spawnAt, url: req.url });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${req.url}</title><h1>Page ${req.url}</h1><p>Static text.</p>`);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const URLS = [`http://127.0.0.1:${port}/a.html`, `http://localhost:${port}/b.html`, `file://${OUT}/pages/c.html`];

// ---- profiles --------------------------------------------------------------
function userJS(arm, out, t1, t2) {
  const timeline = Number(process.env.IDLE_COST_TIMELINE ?? 0);
  const buildId = (fs.readFileSync(path.join(path.dirname(ZEN), "application.ini"), "utf8").match(/^BuildID=(.*)$/m) ?? [])[1] ?? "";
  const now = Math.floor(Date.now() / 1000);
  // zen-dev.sh's prefs, minus the dev-only logging and zenius.dev, so zenius
  // runs as in the daily Zen; plus the probe's.
  return `user_pref("zenius.instance", "${ARMS[arm].name}");
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("zen.welcome-screen.seen", true);
user_pref("userChromeJS.firstRunShown", true);
user_pref("zen.updates.show-update-notification", false);
user_pref("zen.updates.last-build-id", "${buildId}");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.page", 0);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("app.update.auto", false);
user_pref("app.update.interval", 86400);
user_pref("app.update.lastUpdateTime.background-update-timer", ${now});
user_pref("app.update.suppressPrompts", true);
user_pref("app.update.checkInstallTime", false);
user_pref("toolkit.startup.max_resumed_crashes", -1);
user_pref("toolkit.startup.recent_crashes", 0);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.newtabpage.enabled", false);
user_pref("extensions.autoDisableScopes", 15);
user_pref("zenius.i4.out", "${out}");
user_pref("zenius.i4.t1", ${t1});
user_pref("zenius.i4.t2", ${t2});
user_pref("zenius.i4.timeline", ${timeline});
`;
}

function freshProfile(arm) {
  const dir = profileOf(arm);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(`${dir}/chrome/JS`, { recursive: true });
  fs.cpSync(`${ROOT}/runtime/vendor/fx-autoconfig/profile/chrome/utils`, `${dir}/chrome/utils`, { recursive: true });
  fs.copyFileSync(`${HERE}/probe.sys.mjs`, `${dir}/chrome/JS/i4probe.sys.mjs`);
  // The inspection actor's modules, in a subfolder fx-autoconfig doesn't scan.
  fs.mkdirSync(`${dir}/chrome/JS/i4`, { recursive: true });
  fs.copyFileSync(`${HERE}/probe-parent.sys.mjs`, `${dir}/chrome/JS/i4/parent.sys.mjs`);
  fs.copyFileSync(`${HERE}/probe-child.sys.mjs`, `${dir}/chrome/JS/i4/child.sys.mjs`);
}

// ---- /proc -----------------------------------------------------------------
const read = p => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
function tree(root) {
  const kids = new Map();
  for (const pid of fs.readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
    const stat = read(`/proc/${pid}/stat`);
    if (!stat) continue;
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(Number(pid));
  }
  const out = [];
  const walk = pid => {
    out.push(pid);
    for (const k of kids.get(pid) ?? []) walk(k);
  };
  walk(root);
  return out;
}
const kv = text => Object.fromEntries([...(text ?? "").matchAll(/^(\w+):\s+(\d+)/gm)].map(m => [m[1], Number(m[2])]));
function threads(pid) {
  const out = [];
  let tids = [];
  try {
    tids = fs.readdirSync(`/proc/${pid}/task`);
  } catch {}
  for (const tid of tids) {
    const stat = read(`/proc/${pid}/task/${tid}/stat`);
    const status = kv(read(`/proc/${pid}/task/${tid}/status`));
    if (!stat) continue;
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    out.push({
      tid: Number(tid),
      name: (read(`/proc/${pid}/task/${tid}/comm`) ?? "").trim(),
      ticks: Number(f[11]) + Number(f[12]),
      vcs: status.voluntary_ctxt_switches ?? 0,
      ncs: status.nonvoluntary_ctxt_switches ?? 0,
    });
  }
  return out;
}
function sample(root, withMemory) {
  return tree(root).map(pid => {
    const p = { pid, comm: (read(`/proc/${pid}/comm`) ?? "").trim(), threads: threads(pid) };
    if (withMemory) {
      p.rollup = kv(read(`/proc/${pid}/smaps_rollup`));
      p.status = kv(read(`/proc/${pid}/status`));
    }
    return p;
  });
}

// ---- one run ---------------------------------------------------------------
async function run(arm, label, { t1 = T1, tmem = TMEM, t2 = T2 } = {}) {
  const dir = profileOf(arm);
  const out = `${RESULTS}/${label}.probe.json`;
  fs.rmSync(out, { force: true });
  fs.writeFileSync(`${dir}/user.js`, userJS(arm, out, t1, t2));
  const sock = socketOf(arm);
  fs.rmSync(sock, { force: true });
  const logFd = fs.openSync(`${RESULTS}/${label}.log`, "w");
  requests.length = 0;
  spawnAt = performance.now();
  const child = spawn(ZEN, ["--profile", dir, "--no-remote", "--headless", ...URLS], {
    env: { ...process.env, MOZ_HEADLESS: "1", MOZ_CRASHREPORTER_DISABLE: "1" },
    stdio: ["ignore", logFd, logFd],
  });
  let exited = false;
  child.on("exit", () => (exited = true));
  const result = { arm, label, pid: child.pid, t1, tmem, t2 };
  // zenius's socket: when the runtime started listening.
  while (!exited && performance.now() - spawnAt < 20000) {
    if (fs.existsSync(sock)) {
      result.socketMs = performance.now() - spawnAt;
      break;
    }
    if (!ARMS[arm].zenius && performance.now() - spawnAt > 3000) break;
    await sleep(10);
  }
  const at = async ms => {
    const wait = ms - (performance.now() - spawnAt);
    if (wait > 0) await sleep(wait);
  };
  await at(t1);
  result.p1 = sample(child.pid, false);
  result.p1At = performance.now() - spawnAt;
  const before = requests.length;
  await at(tmem);
  result.pmem = sample(child.pid, true);
  await at(t2);
  result.p2 = sample(child.pid, false);
  result.p2At = performance.now() - spawnAt;
  result.idleRequests = requests.slice(before);
  result.requests = requests.slice();
  while (!exited && performance.now() - spawnAt < t2 + 40000) await sleep(100);
  if (!exited) {
    log(`${label}: no quit; stopping pid ${child.pid}`);
    child.kill("SIGTERM");
    await sleep(5000);
    if (!exited) child.kill("SIGKILL");
  }
  fs.closeSync(logFd);
  result.probe = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
  fs.writeFileSync(`${RESULTS}/${label}.json`, JSON.stringify(result));
  log(`${label}: socket ${result.socketMs?.toFixed(0) ?? "-"} ms, delayedStartup ${result.probe?.marks?.delayedStartupFinished?.toFixed(0) ?? "?"} ms, idle requests ${result.idleRequests.length}`);
  return result;
}

// ---- plan ------------------------------------------------------------------
const plan = process.argv[2] ?? "all";
if (plan === "all" || plan === "prepare") {
  for (const arm of ["a", "b"]) {
    freshProfile(arm);
    await run(arm, `init-${arm}`, { t1: 4000, tmem: 6000, t2: 8000 });
  }
  execFileSync(`${ROOT}/scripts/install.sh`, ["--profile", profileOf("b")], {
    env: { ...process.env, ZENIUS_HOME: `${OUT}/zhome` },
    stdio: "inherit",
  });
  await run("b", "cold-b");
  await run("a", "warm-a", { t1: 4000, tmem: 6000, t2: 8000 });
}
// guard: for the I4 guard test (tests/core/i4/guard.test.mjs), which asks
// what each arm holds once idle, not what that costs. A short first run of
// each fresh profile, the install into b, then one run of each, past the
// runtime's restart rebuild (REBUILD_WAIT_MS, 30 s).
if (plan === "guard") {
  for (const arm of ["a", "b"]) {
    freshProfile(arm);
    await run(arm, `init-${arm}`, { t1: 2000, tmem: 3000, t2: 4000 });
  }
  execFileSync(`${ROOT}/scripts/install.sh`, ["--profile", profileOf("b")], {
    env: { ...process.env, ZENIUS_HOME: `${OUT}/zhome` },
    stdio: "inherit",
  });
  // Each profile as both runs start from it. Under a parallel test-all a
  // run can come back without the probe's tabs, and its Zen may have been
  // stopped: a second run of that profile alone would start differently
  // (crash recovery, a session to restore), and arm b minus arm a would
  // count that. So both arms run again, from these copies, as r2.
  for (const arm of ["a", "b"]) {
    fs.rmSync(`${OUT}/clean-${arm}`, { recursive: true, force: true });
    fs.cpSync(profileOf(arm), `${OUT}/clean-${arm}`, { recursive: true });
  }
  // IDLE_COST_GUARD_T1 moves t1, to test the probe's wait for the startup.
  const timing = { t1: Number(process.env.IDLE_COST_GUARD_T1 ?? 5000), tmem: 8000, t2: 36000 };
  const first = [];
  for (const arm of ["a", "b"]) {
    first.push(await run(arm, `r1-${arm}`, timing));
  }
  // Short: no tabs from the probe, or hooks taken before Zen's startup ended.
  const short = first.filter(result => !result.probe?.tabs?.afterMove || !result.probe?.hooks?.settled);
  // IDLE_COST_GUARD_RERUN=1 takes the second round anyway, to test it.
  if (short.length || process.env.IDLE_COST_GUARD_RERUN === "1") {
    const why = short
      .map(r => `${r.arm}: ${r.probe ? (r.probe.tabs?.afterMove ? "startup unfinished at t2" : (r.probe.tabs?.error ?? "no tabs")) : "no probe file"}`)
      .join("; ");
    log(`r1 came back short (${why}); running both arms again from their profiles before r1`);
    for (const arm of ["a", "b"]) {
      fs.rmSync(profileOf(arm), { recursive: true, force: true });
      fs.cpSync(`${OUT}/clean-${arm}`, profileOf(arm), { recursive: true });
      await run(arm, `r2-${arm}`, timing);
    }
  }
}
if (plan === "all" || plan === "rounds") {
  for (let i = 1; i <= ROUNDS; i++) {
    const order = i % 2 ? ["a", "b"] : ["b", "a"];
    for (const arm of order) await run(arm, `r${i}-${arm}`);
  }
}
if (plan === "variants") {
  // Two checks on profile b, 3 runs each. c: zenius without the actor's
  // DOMWindowCreated event (what the actor costs tab processes). u: zenius
  // uninstalled (what differs between the two profiles themselves).
  const n = Number(process.env.I4_VARIANT_RUNS ?? 3);
  const installer = args =>
    execFileSync(`${ROOT}/scripts/install.sh`, [...args, "--profile", profileOf("b")], {
      env: { ...process.env, ZENIUS_HOME: `${OUT}/zhome` },
      stdio: "inherit",
    });
  const svc = `${profileOf("b")}/chrome/JS/zenius/modules/service.sys.mjs`;
  const text = fs.readFileSync(svc, "utf8");
  const patched = text.replace("events: { DOMWindowCreated: {} },", "");
  if (patched === text) throw new Error("actor events not found");
  fs.writeFileSync(svc, patched);
  try {
    for (let i = 1; i <= n; i++) await run("b", `c${i}-c`);
  } finally {
    installer([]);
  }
  installer(["--uninstall"]);
  try {
    await run("b", "u0-u", { t1: 4000, tmem: 6000, t2: 8000 });
    for (let i = 1; i <= n; i++) await run("b", `u${i}-u`);
  } finally {
    installer([]);
  }
}
if (plan === "deferral") {
  // The deferral alone: rounds of a, b (zenius as installed) and d (the same
  // profile with zenius.uc.js as it was before the runtime waited for its
  // window's startup), in rotating order.
  const uc = `${profileOf("b")}/chrome/JS/zenius.uc.js`;
  const current = fs.readFileSync(uc, "utf8");
  const before = execFileSync("git", ["-C", ROOT, "show", "8dd1bc1~1:runtime/JS/zenius.uc.js"], { encoding: "utf8" });
  const orders = [["a", "b", "d"], ["b", "d", "a"], ["d", "a", "b"]];
  try {
    for (let i = 1; i <= ROUNDS; i++) {
      for (const arm of orders[(i - 1) % 3]) {
        fs.writeFileSync(uc, arm === "d" ? before : current);
        await run(arm === "d" ? "b" : arm, `r${i}-${arm}`);
      }
    }
  } finally {
    fs.writeFileSync(uc, current);
  }
}
server.close();
log("done");
