// ==UserScript==
// @name           i4probe
// @description    zen-core's idle-cost probe: measurement profiles only
// ==/UserScript==

// Loaded by fx-autoconfig as a background module in both arms of the
// measurement (with and without zenius). Records the startup timeline, what
// listens where, and process info at two idle points; then, after the last
// sample, what zenius has in each user tab's content process (inspectTabs,
// through probe-child.sys.mjs). Writes it all to the file in pref
// zenius.i4.out, and quits.

const OUT = Services.prefs.getStringPref("zenius.i4.out", "");
const T1 = Services.prefs.getIntPref("zenius.i4.t1", 30000);
const T2 = Services.prefs.getIntPref("zenius.i4.t2", 90000);
const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

function sinceStart() {
  try {
    return Services.telemetry.msSinceProcessStart();
  } catch {
    return Date.now() - Services.startup.getStartupInfo().process.getTime();
  }
}

const marks = { probeLoaded: sinceStart() };
const mark = name => {
  if (!(name in marks)) {
    marks[name] = sinceStart();
  }
};

const TOPICS = [
  "http-on-opening-request",
  "http-on-modify-request",
  "http-on-stop-request",
  "http-on-failed-opening-request",
  "http-on-examine-response",
  "http-on-examine-cached-response",
  "http-on-examine-merged-response",
  "browser-delayed-startup-finished",
  "domwindowopened",
  "domwindowclosed",
  "quit-application",
  "quit-application-granted",
  "sessionstore-windows-restored",
  "document-element-inserted",
  "chrome-document-global-created",
  "content-document-global-created",
  "common-dialog-loaded",
  "tabmodal-dialog-loaded",
  "browser-window-before-show",
  "xpcom-shutdown",
  "profile-before-change",
  "browsing-context-attached",
  "window-global-created",
  "window-global-destroyed",
  "inner-window-destroyed",
  "blocked-automatic-download",
];

function observerCounts() {
  const counts = {};
  for (const topic of TOPICS) {
    let n = 0;
    for (const _ of Services.obs.enumerateObservers(topic)) {
      n++;
    }
    counts[topic] = n;
  }
  return counts;
}

/** Counts of `target`'s listeners by type and phase; only those `keep` accepts, if given. */
function listenerCounts(target, keep = null) {
  const counts = {};
  if (!target) {
    return counts;
  }
  for (const info of Services.els.getListenerInfoFor(target)) {
    if (keep && !keep(info)) {
      continue;
    }
    const key = `${info.type}${info.capturing ? " capture" : ""}${info.inSystemEventGroup ? " system" : ""}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// zenius's own listeners, told apart by the file their code is in. Zen's
// own number of listeners changes between two runs of the same profile
// (ZenSpace.mjs adds a TabSelect listener on the tab strip for each Space
// it builds), so arm b minus arm a isn't steady. The platform can't place a
// bound function or native code: those count as nobody's here.
const ZENIUS_FILE = /\/zenius(\/|\.uc\.js$)/;
function zeniusListener(info) {
  const l = info.listenerObject;
  const fn = typeof l === "function" ? l : typeof l?.handleEvent === "function" ? l.handleEvent : null;
  try {
    return !!fn && ZENIUS_FILE.test(Cu.getFunctionSourceLocation(fn)?.filename ?? "");
  } catch {
    return false;
  }
}

function windows() {
  return [...Services.wm.getEnumerator("navigator:browser")];
}

async function procInfo() {
  const info = await ChromeUtils.requestProcInfo();
  const proc = p => ({
    pid: p.pid,
    type: p.type ?? "browser",
    origin: p.origin ?? "",
    memory: p.memory,
    cpuTime: p.cpuTime,
    threads: p.threads.map(t => ({ tid: t.tid, name: t.name, cpuTime: t.cpuTime })),
  });
  return { at: sinceStart(), parent: proc(info), children: info.children.map(proc) };
}

function hooks() {
  const win = windows()[0];
  return {
    observers: observerCounts(),
    window: listenerCounts(win),
    document: listenerCounts(win?.document),
    tabContainer: listenerCounts(win?.gBrowser?.tabContainer),
    zenius: {
      window: listenerCounts(win, zeniusListener),
      document: listenerCounts(win?.document, zeniusListener),
      tabContainer: listenerCounts(win?.gBrowser?.tabContainer, zeniusListener),
    },
    modules: Cu.loadedESModules.length,
    zeniusModules: Cu.loadedESModules.filter(u => u.includes("/zenius/")),
    allModules: Cu.loadedESModules,
    tabs: win?.gBrowser?.tabs.length ?? 0,
    tabURLs: win?.gBrowser?.browsers.map(b => b.currentURI?.spec) ?? [],
  };
}

let idleTasksDone;
const idleTasks = new Promise(resolve => (idleTasksDone = resolve));
/** After Zen's startup idle tasks, the observers its startup adds are all there. */
const SETTLE_MS = 2000;

const observer = {
  observe(subject, topic) {
    if (topic === "domwindowopened" && !("domwindowopened" in marks)) {
      mark("domwindowopened");
      const win = subject;
      win.addEventListener(
        "DOMContentLoaded",
        e => e.target === win.document && mark("windowDOMContentLoaded"),
        { capture: true }
      );
      win.addEventListener("load", e => e.target === win.document && mark("windowLoad"), { capture: true });
      win.addEventListener("MozAfterPaint", () => mark("windowFirstPaint"), { once: true });
    } else if (topic === "browser-delayed-startup-finished") {
      mark("delayedStartupFinished");
    } else if (topic === "sessionstore-windows-restored") {
      mark("sessionstoreWindowsRestored");
    } else if (topic === "browser-idle-startup-tasks-finished") {
      mark("idleStartupTasksFinished");
      idleTasksDone();
    }
  },
};
for (const topic of [
  "domwindowopened",
  "browser-delayed-startup-finished",
  "sessionstore-windows-restored",
  "browser-idle-startup-tasks-finished",
]) {
  Services.obs.addObserver(observer, topic);
}

function startupInfo() {
  const info = Services.startup.getStartupInfo();
  const zero = info.process?.getTime();
  const out = {};
  for (const [key, value] of Object.entries(info)) {
    if (value instanceof Date && zero) {
      out[key] = value.getTime() - zero;
    }
  }
  return out;
}

function telemetryTimestamps() {
  try {
    const { TelemetryTimestamps } = ChromeUtils.importESModule("resource://gre/modules/TelemetryTimestamps.sys.mjs");
    return TelemetryTimestamps.get();
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * After the idle samples, so it can't touch them: in each user tab's content
 * process, which of zenius's window actors exist for the tab's document, the
 * listeners there, and the zenius modules the process loaded. Then the same
 * after a reload of each tab: the tabs above loaded before zenius registered
 * its actors (it starts after the window), and every later document is like
 * this one. Then after one mouse move in each tab, as the user's first.
 */
async function inspectTabs() {
  const names = ["Zenius", "ZeniusClipboard", "ZeniusSystemUi", "ZeniusInput"];
  ChromeUtils.registerWindowActor("I4Probe", {
    parent: { esModuleURI: "chrome://userscripts/content/i4/parent.sys.mjs" },
    child: { esModuleURI: "chrome://userscripts/content/i4/child.sys.mjs" },
    allFrames: true,
    // Gecko 160 refuses actors in web content processes without it.
    safeForUntrustedWebProcess: true,
  });
  const globals = () =>
    windows()
      .flatMap(w => w.gBrowser.browsers)
      .map(b => b.browsingContext?.currentWindowGlobal)
      .filter(Boolean);
  // A content process that never answers (one starting under load) mustn't
  // hold the probe's file back: the run stops this Zen 40 s after t2.
  const answer = query =>
    Promise.race([query, new Promise((_, reject) => setTimeout(() => reject(new Error("no answer in 10 s")), 10000))]);
  const ask = message =>
    Promise.all(
      globals().map(async wg => {
        try {
          return { osPid: wg.osPid, ...(await answer(wg.getActor("I4Probe").sendQuery(message, { names }))) };
        } catch (e) {
          return { osPid: wg.osPid, url: wg.documentURI?.spec ?? "", error: e.message };
        }
      })
    );
  const before = await ask("inspect");
  for (const win of windows()) {
    for (const b of win.gBrowser.browsers) {
      b.reload();
    }
  }
  await new Promise(r => setTimeout(r, 3000));
  const afterReload = await ask("inspect");
  const moves = await ask("move");
  await new Promise(r => setTimeout(r, 500));
  return { before, afterReload, moves, afterMove: await ask("inspect") };
}

const data = { marks, pid: Services.appinfo.processID };
const at = (ms, fn) => setTimeout(fn, Math.max(0, ms - sinceStart()));

// Diagnostics, off unless pref zenius.i4.timeline is a step in ms: the
// observer counts every step until T2, and Gecko's modules then, to see
// when Zen's own startup adds what.
const STEP = Services.prefs.getIntPref("zenius.i4.timeline", 0);
if (STEP > 0) {
  data.timeline = [];
  for (let ms = STEP; ms < T2; ms += STEP) {
    at(ms, () => data.timeline.push({ at: sinceStart(), observers: observerCounts(), modules: Cu.loadedESModules.length }));
  }
}

// The hooks wait for Zen's startup to end (its idle tasks, then SETTLE_MS),
// at most until T2. Each arm starts in its own time, and a loaded machine
// can stretch a startup past T1: an arm sampled in the middle of it lacks
// the observers of whole startup phases (I4 guard, 2026-11-20).
let hooksTaken;
const hooksDone = new Promise(resolve => (hooksTaken = resolve));
at(T1, async () => {
  data.t1 = await procInfo();
  await Promise.race([idleTasks, new Promise(resolve => setTimeout(resolve, Math.max(0, T2 - sinceStart())))]);
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
  data.hooks = hooks();
  data.hooks.at = sinceStart();
  data.hooks.settled = "idleStartupTasksFinished" in marks;
  hooksTaken();
});
at(T2, async () => {
  data.t2 = await procInfo();
});
at(T2 + 2000, async () => {
  // Memory once the parent's garbage is gone, so heap timing doesn't hide a
  // difference.
  Cu.forceGC();
  Cu.forceCC();
  Cu.forceShrinkingGC();
  data.afterGC = await procInfo();
  await hooksDone;
  if (STEP > 0) {
    data.hooksLate = hooks();
  }
  data.startupInfo = startupInfo();
  data.telemetryTimestamps = telemetryTimestamps();
  // What the main process holds is written first, so a run that stalls on
  // the tabs still says that much.
  if (OUT) {
    await IOUtils.writeJSON(OUT, data);
  }
  try {
    data.tabs = await inspectTabs();
  } catch (e) {
    data.tabs = { error: e.message };
  }
  if (OUT) {
    await IOUtils.writeJSON(OUT, data);
  }
  if (Services.prefs.getBoolPref("zenius.i4.quit", true)) {
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
  }
});
