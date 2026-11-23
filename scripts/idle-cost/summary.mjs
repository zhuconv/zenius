// Summarizes run.mjs's results: arm a (no zenius) vs arm b (zenius), then
// the variants if they ran.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(process.env.IDLE_COST_DIR ?? `${os.homedir()}/.zenius-dev/idle-cost`, "results");
const load = f => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
const runs = fs
  .readdirSync(DIR)
  .filter(f => /^r\d+-[ab]\.json$/.test(f))
  .map(load)
  .filter(r => r.probe);
const arms = { a: runs.filter(r => r.arm === "a"), b: runs.filter(r => r.arm === "b") };
const TICK_MS = 10;

const median = xs => {
  const s = xs.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const rows = [];
function metric(name, fn, d = 0, unit = "") {
  const va = arms.a.map(fn), vb = arms.b.map(fn);
  const ma = median(va), mb = median(vb);
  const range = v => `${fmt(Math.min(...v.filter(Number.isFinite)), d)}–${fmt(Math.max(...v.filter(Number.isFinite)), d)}`;
  rows.push([name, `${fmt(ma, d)} (${range(va)})`, `${fmt(mb, d)} (${range(vb)})`, `${mb - ma >= 0 ? "+" : ""}${fmt(mb - ma, d)}${unit}`]);
}

// Process types by pid, from the probe's process info.
function typeOf(r, pid) {
  if (pid === r.pid) return "parent";
  const c = [...(r.probe.t1?.children ?? []), ...(r.probe.t2?.children ?? [])].find(c => c.pid === pid);
  return c ? c.type + (c.origin ? `(${new URL(c.origin).hostname || c.origin})` : "") : "other";
}
const pss = (r, pred) => r.pmem.filter(p => pred(typeOf(r, p.pid))).reduce((s, p) => s + (p.rollup.Pss ?? 0), 0) / 1024;
const rss = (r, pred) => r.pmem.filter(p => pred(typeOf(r, p.pid))).reduce((s, p) => s + (p.rollup.Rss ?? 0), 0) / 1024;
function delta(r, pred, field) {
  let total = 0;
  for (const p2 of r.p2) {
    if (!pred(typeOf(r, p2.pid))) continue;
    const p1 = r.p1.find(p => p.pid === p2.pid);
    if (!p1) continue;
    for (const t2 of p2.threads) {
      const t1 = p1.threads.find(t => t.tid === t2.tid);
      if (t1) total += t2[field] - t1[field];
    }
  }
  return total;
}
function threadDelta(r, pred, name, field) {
  let total = 0;
  for (const p2 of r.p2) {
    if (!pred(typeOf(r, p2.pid))) continue;
    const p1 = r.p1.find(p => p.pid === p2.pid);
    for (const t2 of p2.threads.filter(t => (name === "main" ? t.tid === p2.pid : t.name === name))) {
      const t1 = p1?.threads.find(t => t.tid === t2.tid);
      if (t1) total += t2[field] - t1[field];
    }
  }
  return total;
}
const isParent = t => t === "parent";
const isTab = t => /^(webIsolated|file|web)/.test(t);
const any = () => true;
const idleS = r => (r.p2At - r.p1At) / 1000;

const m = r => r.probe.marks;
metric("first window: DOMContentLoaded (ms from process start)", r => m(r).windowDOMContentLoaded);
metric("first window: first paint", r => m(r).windowFirstPaint);
metric("first window: delayed startup finished", r => m(r).delayedStartupFinished);
metric("session restored", r => m(r).sessionstoreWindowsRestored);
metric("window opened → first paint (ms)", r => m(r).windowFirstPaint - m(r).domwindowopened);
metric("window opened → delayed startup finished", r => m(r).delayedStartupFinished - m(r).domwindowopened);
metric("DOMContentLoaded → load (zenius.uc.js runs here)", r => m(r).windowLoad - m(r).windowDOMContentLoaded);
metric("parent CPU used by 30 s (ms)", r => r.probe.t1.parent.cpuTime / 1e6);
metric("parent main thread CPU by 30 s (ms)", r => (r.p1.find(p => p.pid === r.pid).threads.find(t => t.tid === r.pid).ticks) * TICK_MS);
metric("PSS at 60 s, parent (MiB)", r => pss(r, isParent), 1);
metric("PSS at 60 s, 3 tab processes (MiB)", r => pss(r, isTab), 1);
metric("PSS at 60 s, all processes (MiB)", r => pss(r, any), 1);
metric("RSS at 60 s, parent (MiB)", r => rss(r, isParent), 1);
metric("parent memory after GC at 92 s (MiB, procinfo)", r => r.probe.afterGC.parent.memory / 1048576, 1);
metric("idle 30→90 s: parent CPU (ms)", r => delta(r, isParent, "ticks") * TICK_MS);
metric("idle 30→90 s: tab processes CPU (ms)", r => delta(r, isTab, "ticks") * TICK_MS);
metric("idle 30→90 s: all processes CPU (ms)", r => delta(r, any, "ticks") * TICK_MS);
metric("idle 30→90 s: parent wakeups (voluntary switches, all threads)", r => delta(r, isParent, "vcs"));
metric("idle 30→90 s: parent main thread wakeups", r => threadDelta(r, isParent, "main", "vcs"));
metric("idle 30→90 s: Socket Thread wakeups", r => threadDelta(r, isParent, "Socket Thread", "vcs"));
metric("idle 30→90 s: Timer thread wakeups", r => threadDelta(r, isParent, "Timer", "vcs"));
metric("idle 30→90 s: tab processes wakeups", r => delta(r, isTab, "vcs"));
metric("idle 30→90 s: all processes wakeups", r => delta(r, any, "vcs"));
metric("HTTP requests during the idle window", r => r.idleRequests.length);

console.log(`runs: a=${arms.a.length} b=${arms.b.length}; zenius socket ready (b): median ${fmt(median(arms.b.map(r => r.socketMs)))} ms`);
const w = [64, 22, 22, 10];
console.log(["metric", "a: no zenius, median (range)", "b: zenius", "b − a"].map((s, i) => s.padEnd(w[i])).join(" | "));
for (const r of rows) console.log(r.map((s, i) => String(s).padEnd(w[i])).join(" | "));

// Per-thread idle wakeups in the parent: which threads differ.
const names = new Set(runs.flatMap(r => r.p2.find(p => p.pid === r.pid).threads.map(t => (t.tid === r.pid ? "main" : t.name))));
const diffs = [];
for (const n of names) {
  const a = median(arms.a.map(r => threadDelta(r, isParent, n, "vcs")));
  const b = median(arms.b.map(r => threadDelta(r, isParent, n, "vcs")));
  if (Math.abs(b - a) >= 3) diffs.push(`${n}: ${a} → ${b}`);
}
console.log("\nparent threads whose idle wakeups differ by 3 or more (median a → b):", diffs.join("; ") || "none");
const tb = new Set(arms.b.flatMap(r => r.p2.find(p => p.pid === r.pid).threads.map(t => t.name)));
const ta = new Set(arms.a.flatMap(r => r.p2.find(p => p.pid === r.pid).threads.map(t => t.name)));
console.log("parent threads only in b:", [...tb].filter(n => !ta.has(n)).join(", ") || "none", "| only in a:", [...ta].filter(n => !tb.has(n)).join(", ") || "none");
const cnt = r => r.p2.find(p => p.pid === r.pid).threads.length;
console.log(`parent thread count: a ${median(arms.a.map(cnt))}, b ${median(arms.b.map(cnt))}`);

// What zenius adds: observers, listeners, modules (first run of each arm).
const [ra, rb] = [arms.a[0], arms.b[0]];
const diff = (x = {}, y = {}) => Object.fromEntries([...new Set([...Object.keys(x), ...Object.keys(y)])].filter(k => (x[k] ?? 0) !== (y[k] ?? 0)).map(k => [k, (y[k] ?? 0) - (x[k] ?? 0)]));
for (const k of ["observers", "window", "document", "tabContainer"]) console.log(`\n${k} added by zenius:`, JSON.stringify(diff(ra.probe.hooks[k], rb.probe.hooks[k])));
const ma = new Set(ra.probe.hooks.allModules), mb = rb.probe.hooks.allModules;
const extra = mb.filter(u => !ma.has(u));
console.log(`\nmodules in the parent: a ${ma.size}, b ${mb.length}; zenius's own ${extra.filter(u => u.includes("/zenius/")).length}; others zenius loads:`);
for (const u of extra.filter(u => !u.includes("/zenius/"))) console.log("  " + u);
const gone = [...ma].filter(u => !mb.includes(u));
if (gone.length) console.log("only in a:", gone.join(", "));

const cold = fs.existsSync(path.join(DIR, "cold-b.json")) ? load("cold-b.json") : null;
if (cold?.probe) {
  const c = cold.probe.marks;
  console.log(`\ncold start (first after install): socket ${fmt(cold.socketMs)} ms, window opened → delayed startup ${fmt(c.delayedStartupFinished - c.domwindowopened)} ms, parent CPU by 30 s ${fmt(cold.probe.t1.parent.cpuTime / 1e6)} ms`);
}

// PSS at 60 s by process type.
const types = new Set(runs.flatMap(r => r.pmem.map(p => typeOf(r, p.pid).replace(/\(.*\)/, "").replace(/^(preallocated)$/, "$1"))));
console.log("\nPSS at 60 s by process type, MiB (median a → b; count a/b):");
for (const t of [...types].sort()) {
  const per = arm => arms[arm].map(r => r.pmem.filter(p => typeOf(r, p.pid).replace(/\(.*\)/, "") === t));
  const sum = arm => median(per(arm).map(ps => ps.reduce((s, p) => s + (p.rollup.Pss ?? 0), 0) / 1024));
  const n = arm => median(per(arm).map(ps => ps.length));
  console.log(`  ${t.padEnd(14)} ${fmt(sum("a"), 1)} → ${fmt(sum("b"), 1)}  (${n("a")}/${n("b")})`);
}

// ---- variants ----------------------------------------------------------------
// a (profile a, no zenius), b (profile b, zenius), u (profile b, zenius
// uninstalled), c (profile b, zenius without the actor's DOMWindowCreated).
const loadV = f => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
if (fs.readdirSync(DIR).some(f => /^[cu]\d+-[cu]\.json$/.test(f))) {
  const group = re => fs.readdirSync(DIR).filter(f => re.test(f)).map(loadV).filter(r => r.probe);
  const sets = {
    a: group(/^r\d+-a\.json$/),
    b: group(/^r\d+-b\.json$/),
    u: group(/^u[1-9]\d*-u\.json$/),
    c: group(/^c\d+-c\.json$/),
  };
  const cols = Object.keys(sets).filter(k => sets[k].length);
  const medianV = xs => {
    const s = xs.filter(Number.isFinite).sort((x, y) => x - y);
    if (!s.length) return NaN;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  function typeOfV(r, pid) {
    if (pid === r.pid) return "parent";
    const c = [...(r.probe.t1?.children ?? []), ...(r.probe.t2?.children ?? [])].find(c => c.pid === pid);
    return c ? c.type : "other";
  }
  const pssV = (r, pred) => r.pmem.filter(p => pred(typeOfV(r, p.pid))).reduce((s, p) => s + (p.rollup.Pss ?? 0), 0) / 1024;
  // USS: pages only this process maps. PSS also splits shared pages (libxul)
  // with every other Zen on the machine, so it moves with what else runs.
  const ussV = (r, pred) =>
    r.pmem.filter(p => pred(typeOfV(r, p.pid))).reduce((s, p) => s + (p.rollup.Private_Clean ?? 0) + (p.rollup.Private_Dirty ?? 0), 0) / 1024;
  const tabs = t => /^(webIsolated|file|web)$/.test(t);
  const noJS = t => /^(rdd|socket|utility|forkServer)$/.test(t);
  const mV = r => r.probe.marks;
  const metrics = [
    ["window opened → delayed startup (ms)", r => mV(r).delayedStartupFinished - mV(r).domwindowopened, 0],
    ["DOMContentLoaded → load (ms)", r => mV(r).windowLoad - mV(r).windowDOMContentLoaded, 0],
    ["parent main thread CPU by 30 s (ms)", r => r.p1.find(p => p.pid === r.pid).threads.find(t => t.tid === r.pid).ticks * 10, 0],
    ["PSS parent (MiB)", r => pssV(r, t => t === "parent"), 1],
    ["PSS tab processes, 4 (MiB)", r => pssV(r, tabs), 1],
    ["PSS rdd+socket+utility+forkServer (MiB)", r => pssV(r, noJS), 1],
    ["PSS preallocated, 3 (MiB)", r => pssV(r, t => t === "preallocated"), 1],
    ["PSS all (MiB)", r => pssV(r, () => true), 1],
    ["USS parent (MiB)", r => ussV(r, t => t === "parent"), 1],
    ["USS tab processes, 4 (MiB)", r => ussV(r, tabs), 1],
    ["USS rdd+socket+utility+forkServer (MiB)", r => ussV(r, noJS), 1],
    ["USS preallocated, 3 (MiB)", r => ussV(r, t => t === "preallocated"), 1],
    ["USS all (MiB)", r => ussV(r, () => true), 1],
    ["parent memory after GC (MiB)", r => r.probe.afterGC.parent.memory / 1048576, 1],
  ];
  console.log("\nvariants (u: b uninstalled, c: no actor event):", "runs:", Object.entries(sets).map(([k, v]) => `${k}=${v.length}`).join(" "));
  const base = sets.u.length ? "u" : "a";
  const diffs = cols.filter(k => k !== "a" && k !== base);
  console.log("metric".padEnd(44), cols.map(k => k.padStart(8)).join(""), diffs.map(k => `${k}−${base}`.padStart(8)).join(""));
  for (const [name, fn, d] of metrics) {
    const v = Object.fromEntries(Object.entries(sets).map(([k, rs]) => [k, medianV(rs.map(fn))]));
    console.log(
      name.padEnd(44),
      cols.map(k => v[k].toFixed(d).padStart(8)).join(""),
      diffs.map(k => (v[k] - v[base]).toFixed(d).padStart(8)).join("")
    );
  }
}

// ---- the user's tabs' content processes ------------------------------------------
// What probe.sys.mjs's inspectTabs found after the idle samples, in each
// arm's last round: zenius's actors that exist for each user tab's document,
// the listeners b has there that a hasn't, and the zenius modules each tab's
// process loaded; then the same after one mouse move in each tab.
const last = arm => arms[arm].filter(r => r.probe?.tabs?.before).at(-1);
const la = last("a"), lb = last("b");
if (la && lb) {
  const diff = (b, a) =>
    Object.entries(b)
      .map(([k, n]) => [k, n - (a?.[k] ?? 0)])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
  const show = (title, key) => {
    console.log(`\nuser tabs, ${title} (${lb.label} against ${la.label}):`);
    lb.probe.tabs[key].forEach((t, i) => {
      const a = la.probe.tabs[key].find(x => x.url.replace(/:\d+\//, "/") === t.url.replace(/:\d+\//, "/")) ?? la.probe.tabs[key][i];
      console.log(`  ${t.url.replace(/^.*\//, "")} (pid ${t.osPid}): live actors: ${t.live?.join(", ") || "none"}`);
      for (const where of ["chromeHandler", "window", "document"]) {
        const extra = diff(t[where] ?? {}, a?.[where]);
        console.log(`    ${where} listeners b has, a hasn't: ${extra.join(", ") || "none"}`);
      }
      console.log(`    zenius modules in its process: ${(t.modules ?? []).map(u => u.replace("chrome://userscripts/content/zenius/", "")).join(", ") || "none"}`);
    });
  };
  show("after the idle minute, no input (documents from before zenius started)", "before");
  if (lb.probe.tabs.afterReload) show("after a reload of each (a document like any later one)", "afterReload");
  console.log(`  moves: ${JSON.stringify(lb.probe.tabs.moves.map(m => m.moved ?? m.error))}`);
  show("then after one mouse move in each", "afterMove");
}
