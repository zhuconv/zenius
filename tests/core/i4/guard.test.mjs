// I4's guard: with no agent connected,
// zenius holds nothing in the main process or in the user's tabs beyond
// ALLOWED. That day's growth (84 modules at startup, observers on every
// request, four actors in every user tab) came in unseen; anything new that is
// live before an agent connects fails here now. Before adding to ALLOWED,
// check whether it can wait for the first connection (SPI, "When method
// modules load").
//
// It runs the I4 tool (scripts/idle-cost/run.mjs guard): a Zen without
// zenius (arm a) and one with it (arm b), each with the user's own tabs and
// no client, and compares what their probes found once idle. That covers
// observers and chrome listeners and zenius's modules in the main process,
// and in each user tab's process the live zenius actors, the listeners on
// the tab's chrome event handler, window and document, and zenius's modules:
// for the documents from before zenius started, after a reload of each tab,
// and after a mouse move in each. tests/core/run.sh runs this file beside
// the others, since it starts Zens of its own. Linux only: the tool reads
// /proc.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

/** What zenius may hold with no agent connected, and whose it is. */
const ALLOWED = {
  // None: zenius's one, the service's state save at quit
  // (modules/service.sys.mjs), is a quit-application observer (QUIT_ONLY).
  observers: {},
  // zen-core, modules/service.sys.mjs and modules/guards.sys.mjs, in each
  // window: the tabs zenius follows, and the focus and keep-alive guards.
  window: {
    "EndSwapDocShells capture": 1,
    TabOpen: 1,
    TabSelect: 1,
    TabClose: 1,
    unload: 3,
    TabSwitchDone: 1,
    "MozLayerTreeCleared capture": 1,
    "framefocusrequested capture": 1,
  },
  document: {},
  tabContainer: {},
  // zen-core's Zenius actor: its DOMWindowCreated listener on every tab.
  tabListeners: { DOMWindowCreated: 1 },
  // Live in each new document of a web tab.
  tabActors: ["Zenius"],
  // Its child and the leaf check it imports (content/taskset.sys.mjs). The
  // guards and the call's modules load with a task's first document.
  tabModules: ["actors/ZeniusChild.sys.mjs", "content/taskset.sys.mjs"],
  // The runtime's own, at startup. Method modules load at the first connection.
  // The sharedData keys come from the leaf, not the content guards' modules.
  parentModules: [
    "content/taskset.sys.mjs",
    "modules/errors.sys.mjs",
    "modules/guards.sys.mjs",
    "modules/pages.sys.mjs",
    "modules/serialize.sys.mjs",
    "modules/server.sys.mjs",
    "modules/service.sys.mjs",
    "modules/spaces.sys.mjs",
    "modules/store.sys.mjs",
    "modules/util.sys.mjs",
    "modules/windows.sys.mjs",
    "observe/webcontent.sys.mjs",
    "ui/pages.sys.mjs",
  ],
};

const linux = process.platform === "linux";
const skip = !linux && "Linux only: the I4 tool reads /proc";
const root = fileURLToPath(new URL("../../..", import.meta.url));
// Profiles of its own, named after the checkout, as tests/core/run.sh names its instance.
const suffix =
  basename(root)
    .replace(/^zenius-?/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-") || "main";
const prefix = `i4guard-${suffix}`;
const dev = process.env.ZENIUS_DEV_HOME ?? join(homedir(), ".zenius-dev");
// The I4 tool's results: one folder per checkout, which each run empties
// first, so a failed run's stay for a look until the next run instead of
// piling up in the temporary folder.
const out = join(dev, "i4guard", suffix);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true, mode: 0o700 });
let a;
let b;
/** The tests that passed: unless all did, `out` stays for a look. */
let passed = 0;
const TESTS = 4;

before(
  async () => {
    if (!linux) {
      return;
    }
    await new Promise((resolve, reject) =>
      execFile(
        process.execPath,
        [join(root, "scripts/idle-cost/run.mjs"), "guard"],
        { env: { ...process.env, IDLE_COST_DIR: out, IDLE_COST_PREFIX: prefix }, timeout: 420000, maxBuffer: 16 << 20 },
        (error, stdout, stderr) => {
          // Which runs there were, for a failure's reader.
          for (const line of String(stdout).split("\n").filter(Boolean)) {
            console.log(`# run.mjs: ${line}`);
          }
          error ? reject(new Error(`run.mjs guard failed: ${error.message}\n${stderr}`)) : resolve();
        }
      )
    );
    // r2 when run.mjs ran both arms again, since r1 came back short.
    const round = existsSync(join(out, "results", "r2-b.json")) ? "r2" : "r1";
    const load = arm => JSON.parse(readFileSync(join(out, "results", `${round}-${arm}.json`), "utf8"));
    a = load("a");
    b = load("b");
    assert.ok(a.probe && b.probe, `a probe wrote nothing: see ${out}/results/r*-*.log`);
    assert.ok(
      a.probe.tabs?.afterMove && b.probe.tabs?.afterMove,
      `a probe has no tabs (${a.probe.tabs?.error ?? b.probe.tabs?.error ?? "missing"}): see ${out}/results/r*-*.log`
    );
    // Each arm's hooks come from a finished startup (the probe waits for
    // Zen's startup idle tasks): arm b minus arm a counts nothing else.
    for (const [arm, r] of [["a", a], ["b", b]]) {
      assert.ok(r.probe.hooks?.settled, `arm ${arm}'s startup hadn't ended by t2 (hooks at ${Math.round(r.probe.hooks?.at ?? 0)} ms): see ${out}/results`);
    }
  },
  // Room for an arm's second run (run.mjs), each up to t2 + 45 s.
  { timeout: 450000 }
);

after(() => {
  if (passed === TESTS || !linux) {
    rmSync(out, { recursive: true, force: true });
  } else {
    console.log(`# the I4 tool's results stay in ${out}`);
  }
  for (const arm of ["a", "b"]) {
    rmSync(join(dev, "profiles", `${prefix}-${arm}`), { recursive: true, force: true });
  }
});

/** What `x` has more of than `y`, as {key: how many more}. */
const more = (x = {}, y = {}) =>
  Object.fromEntries(
    Object.entries(x)
      .map(([k, n]) => [k, n - (y[k] ?? 0)])
      .filter(([, n]) => n > 0)
  );
/** The entries of `found` that `allowed` doesn't cover. */
const beyond = (found, allowed) => Object.fromEntries(Object.entries(found).filter(([k, n]) => n > (allowed[k] ?? 0)));
const zenius = u => u.includes("/zenius/");
const short = u => u.replace(/^.*\/zenius\//, "");

test("zenius ran in arm b and not in arm a", { skip }, () => {
  assert.ok(b.socketMs > 0, "arm b's zenius never listened");
  assert.ok(b.probe.hooks.allModules.some(u => u.endsWith("/zenius/modules/service.sys.mjs")));
  assert.ok(!a.probe.hooks.allModules.some(zenius));
  passed++;
});

// Topics that fire once, as Zen quits: they cost nothing while it idles.
// Gecko's own count of xpcom-shutdown observers differs by tens between two
// runs of the same profile (+38 and -37 here on 2026-11-20), with the
// services each run happened to start. One quit-application observer of
// Gecko's comes about 12 s after the startup in one arm or the other (no
// module of zenius's loads then; seen on the Linux server, 2026-11-20).
const QUIT_ONLY = ["xpcom-shutdown", "profile-before-change", "quit-application", "quit-application-granted"];

// Chrome listeners count by the file their code is in (the probe's
// zeniusListener): Zen's own number of them changes between two runs, with
// the Spaces it builds. Observers can't be placed that way (what
// enumerateObservers returns hides their code), so they're arm b's count
// over arm a's. Not seen: a zenius listener that's a bound function, which
// the platform can't place (none on 2026-11-20).
test("the main process: no zenius observer or chrome listener beyond ALLOWED", { skip }, () => {
  const observers = more(b.probe.hooks.observers, a.probe.hooks.observers);
  for (const topic of QUIT_ONLY) {
    delete observers[topic];
  }
  assert.deepEqual(beyond(observers, ALLOWED.observers), {}, "zenius adds these observers with no agent connected");
  // The placing works: zenius's own tab listeners are there to find.
  assert.equal(b.probe.hooks.zenius?.window?.TabOpen, 1, "the probe didn't place zenius's TabOpen listener");
  for (const where of ["window", "document", "tabContainer"]) {
    assert.deepEqual(
      beyond(b.probe.hooks.zenius[where], ALLOWED[where]),
      {},
      `zenius adds these ${where} listeners with no agent connected`
    );
  }
  passed++;
});

test("the main process: no zenius module beyond ALLOWED", { skip }, () => {
  const loaded = b.probe.hooks.allModules.filter(zenius).map(short);
  assert.deepEqual(loaded.filter(m => !ALLOWED.parentModules.includes(m)).sort(), [], "zenius modules loaded with no agent connected");
  passed++;
});

test("the user's tabs: no zenius actor, listener or module beyond ALLOWED", { skip }, () => {
  const portless = u => u.replace(/:\d+\//, "/");
  for (const when of ["before", "afterReload", "afterMove"]) {
    assert.ok(b.probe.tabs[when].length >= 3, `${when}: the probe saw ${b.probe.tabs[when].length} tabs`);
    for (const tab of b.probe.tabs[when]) {
      const at = `${when}, ${tab.url}`;
      const other = a.probe.tabs[when].find(t => portless(t.url) === portless(tab.url));
      assert.ok(other, `${at}: no such tab in arm a`);
      assert.deepEqual(tab.live.filter(n => !ALLOWED.tabActors.includes(n)), [], `${at}: live zenius actors`);
      assert.deepEqual(beyond(more(tab.chromeHandler, other.chromeHandler), ALLOWED.tabListeners), {}, `${at}: chrome event handler listeners`);
      for (const where of ["window", "document"]) {
        assert.deepEqual(more(tab[where], other[where]), {}, `${at}: ${where} listeners`);
      }
      const modules = (tab.modules ?? []).filter(zenius).map(short);
      assert.deepEqual(modules.filter(m => !ALLOWED.tabModules.includes(m)).sort(), [], `${at}: zenius modules in the tab's process`);
    }
  }
  assert.ok(b.probe.tabs.moves.every(m => m.moved === true), `a mouse move didn't reach a tab: ${JSON.stringify(b.probe.tabs.moves)}`);
  passed++;
});
