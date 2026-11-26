#!/usr/bin/env node
// Latency benchmarks, runnable on both targets with the same scripts.
//
//   node tests/bench/bench.mjs --target ego [--iterations 20] [--only goto-local,click]
//   node tests/bench/bench.mjs --target zenius --instance <name>
//
// Warm benchmarks run all iterations inside one script (one Node process), the
// way an agent chains actions in a round; the first WARMUP iterations are
// dropped. Cold benchmarks spawn one process per sample and time the first
// call in it, which is what an agent's first action of a round pays. Results
// go to tests/bench/out/bench-<target>-<time>.json; report.mjs renders them.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeFixtureServer, startFixtureServer } from "../fixtures/server.mjs";
import { parseTarget, REPO_ROOT, runScript, targetVersion } from "../lib/targets.mjs";

const argv = process.argv;
const opts = parseTarget(argv);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i > 0 ? argv[i + 1] : undefined;
};
const N = Number(argValue("--iterations") || 20);
const WARMUP = 2;
const only = argValue("--only") ? new Set(argValue("--only").split(",")) : null;
const outPath =
  argValue("--out") ||
  join(REPO_ROOT, "tests", "bench", "out", `bench-${opts.target}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

const REAL_SITE = "https://example.com/";

export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => {
    if (!s.length) return null;
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  };
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { n: s.length, p50: q(0.5), p95: q(0.95), mean, min: s[0] ?? null, max: s.at(-1) ?? null };
}

// Each warm bench: setup runs once (untimed), pre runs before each iteration
// (untimed), op is timed. `i` is the iteration index; negative while warming.
function warmBenches({ base, shotDir }) {
  const bench = `${base}/zoo/bench.html`;
  const github = `${base}/golden-replay/site-github-repo.html`;
  const wikiTable = `${base}/golden-replay/site-wikipedia-table.html`;
  // MDN's pages embed their live examples as cross-origin frames
  // (*.mdnplay.dev): 3 on the <iframe> page, 27 on the <input> page.
  const mdnIframe = `${base}/golden-replay/site-mdn-iframe.html`;
  const mdnInput = `${base}/golden-replay/site-mdn-input.html`;
  const replayRow = (name, label, url, scope) => ({
    name,
    group: "snapshot",
    label,
    setup: `await page.goto(${JSON.stringify(url)}); await page.waitForTimeout(500);`,
    op: `extra.bytes = (await page.snapshot(${scope === "full_page" ? `{ scope: "full_page" }` : ""})).length;`,
  });
  return [
    { name: "rpc-floor", group: "baseline", label: "page.url() round trip", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.url();` },
    { name: "goto-local", group: "navigation", label: "goto local fixture", op: `await page.goto(${JSON.stringify(bench)} + "?goto=" + i);` },
    { name: "goto-real", group: "navigation", label: `goto ${REAL_SITE}`, op: `await page.goto(${JSON.stringify(REAL_SITE)} + "?zen-eval=" + Date.now());` },
    { name: "snapshot-small", group: "snapshot", label: "snapshot, small (bench fixture, viewport)", setup: `await page.goto(${JSON.stringify(bench)});`, op: `extra.bytes = (await page.snapshot()).length;` },
    { name: "snapshot-typical", group: "snapshot", label: "snapshot, typical (GitHub repo replay, viewport)", setup: `await page.goto(${JSON.stringify(github)}); await page.waitForTimeout(500);`, op: `extra.bytes = (await page.snapshot()).length;` },
    { name: "snapshot-large", group: "snapshot", label: "snapshot, large (GitHub repo replay, full_page)", setup: `await page.goto(${JSON.stringify(github)}); await page.waitForTimeout(500);`, op: `extra.bytes = (await page.snapshot({ scope: "full_page" })).length;` },
    { name: "snapshot-huge", group: "snapshot", label: "snapshot, huge (Wikipedia table replay, full_page)", iterations: 10, setup: `await page.goto(${JSON.stringify(wikiTable)}); await page.waitForTimeout(1000);`, op: `extra.bytes = (await page.snapshot({ scope: "full_page" })).length;` },
    replayRow("snapshot-mdn-iframe", "snapshot, MDN <iframe> page replay, 3 example frames (viewport)", mdnIframe, "viewport"),
    replayRow("snapshot-mdn-iframe-full", "snapshot, MDN <iframe> page replay, 3 example frames (full_page)", mdnIframe, "full_page"),
    replayRow("snapshot-mdn-input", "snapshot, MDN <input> page replay, 27 example frames (viewport)", mdnInput, "viewport"),
    replayRow("snapshot-mdn-input-full", "snapshot, MDN <input> page replay, 27 example frames (full_page)", mdnInput, "full_page"),
    { name: "click", group: "actions", label: "click(selector)", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.click("#bench-button");` },
    { name: "fill", group: "actions", label: "fill(selector, text)", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.fill("#bench-input", "hello world " + i);` },
    { name: "press", group: "actions", label: "press(selector, Enter)", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.press("#bench-input", "Enter");` },
    { name: "type-50", group: "actions", label: "keyboard.type, 50 characters", setup: `await page.goto(${JSON.stringify(bench)}); await page.focus("#bench-textarea");`, pre: `await page.evaluate(() => { const t = document.querySelector("#bench-textarea"); t.value = ""; t.focus(); });`, op: `await page.keyboard.type("abcdefghij".repeat(5));`, check: `extra.value = await page.evaluate(() => document.querySelector("#bench-textarea").value.length);` },
    { name: "evaluate", group: "actions", label: "evaluate(() => document.title)", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.evaluate(() => document.title);` },
    { name: "screenshot-viewport", group: "screenshot", label: "screenshot, viewport", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.screenshot({ path: ${JSON.stringify(shotDir)} + "/vp-" + i + ".png" });` },
    { name: "screenshot-full", group: "screenshot", label: "screenshot, full page (about 2.8k px tall)", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.screenshot({ path: ${JSON.stringify(shotDir)} + "/full-" + i + ".png", fullPage: true });` },
    { name: "wait-present", group: "waits", label: "waitForSelector, element present", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.waitForSelector("#bench-button", { state: "visible" });` },
    { name: "wait-appears-200", group: "waits", label: "waitForSelector, element appears after 200 ms", setup: `await page.goto(${JSON.stringify(bench)});`, pre: `await page.evaluate(() => { document.querySelector("#slot").replaceChildren(); setTimeout(() => { const el = document.createElement("button"); el.id = "late"; el.textContent = "Late button"; document.querySelector("#slot").replaceChildren(el); }, 200); });`, op: `await page.waitForSelector("#late", { state: "visible" });` },
    // Cursor motion: does travel distance or a label change action latency?
    // Its timeline is read from the DOM, and wait-appears-200 adds its own
    // late element: the agent's code doesn't see page globals under zenius's
    // isolated world.
    { name: "motion-click-same", group: "motion", label: "click the same button repeatedly", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.click("#near");`, timeline: true },
    { name: "motion-click-alternate", group: "motion", label: "click alternating corners (about 1300 px travel)", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.click(i % 2 ? "#far" : "#near");`, timeline: true },
    { name: "motion-click-label", group: "motion", label: "click alternating corners, with label", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.click(i % 2 ? "#far" : "#near", { label: "bench corner click" });`, timeline: true },
    { name: "motion-mouse-alternate", group: "motion", label: "mouse.click alternating corners", setup: `await page.goto(${JSON.stringify(bench)}); const info = await page.info();`, op: `await page.mouse.click(i % 2 ? info.w - 76 : 76, i % 2 ? info.h - 36 : 36);`, timeline: true },
  ];
}

function warmScript(b, { spaceId, resultPath, iterations }) {
  return `
const { writeFile } = await import("node:fs/promises");
const task = await taskSpace(${spaceId});
const page = task.page("p1");
const extra = {};
${b.setup || ""}
const samples = [];
const calls = [];
for (let i = -${WARMUP}; i < ${iterations}; i++) {
  ${b.pre || ""}
  // Date.now() for anything compared across processes: Ego runs scripts in
  // a long-lived Node helper whose timeOrigin + now() drifts from wall time.
  const wall0 = Date.now();
  const t0 = performance.now();
  ${b.op}
  const t1 = performance.now();
  if (i >= 0) {
    samples.push(t1 - t0);
    calls.push([wall0, Date.now()]);
  }
}
${b.check || ""}
${b.timeline ? `extra.events = await page.evaluate(() => { document.dispatchEvent(new Event("bench-dump")); return JSON.parse(document.getElementById("bench-events").textContent); });` : ""}
await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ samples, calls, extra }));
`;
}

// Cold: the first call of a fresh process. Setup ran in an earlier script.
function coldBenches({ base }) {
  const bench = `${base}/zoo/bench.html`;
  const github = `${base}/golden-replay/site-github-repo.html`;
  return [
    { name: "cold-snapshot", label: "first snapshot in a new process (GitHub replay, viewport)", setup: `await page.goto(${JSON.stringify(github)}); await page.waitForTimeout(500);`, op: `await page.snapshot();` },
    { name: "cold-click", label: "first click in a new process", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.click("#bench-button");` },
    { name: "cold-evaluate", label: "first evaluate in a new process", setup: `await page.goto(${JSON.stringify(bench)});`, op: `await page.evaluate(() => 1 + 1);` },
  ];
}

function coldScript(b, { spaceId, resultPath }) {
  return `
const { writeFile } = await import("node:fs/promises");
const t0 = performance.now();
const task = await taskSpace(${spaceId});
const page = task.page("p1");
const t1 = performance.now();
${b.op}
const t2 = performance.now();
await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ resume: t1 - t0, op: t2 - t1 }));
`;
}

/** Match page-side input events to each timed call. */
function analyzeTimeline(calls, events) {
  const rows = calls.map(([start, end]) => {
    const inside = events.filter(([, t]) => t >= start - 1 && t <= end + 1);
    const moves = inside.filter(([type]) => type === "pointermove");
    const click = inside.find(([type]) => type === "click");
    const first = inside[0];
    return {
      total: end - start,
      // Both clocks tick in whole milliseconds; -1 means "at once".
      beforeInput: first ? Math.max(0, first[1] - start) : null,
      inputSpan: first && click ? click[1] - first[1] : null,
      afterClick: click ? end - click[1] : null,
      moves: moves.length,
      wheel: inside.filter(([type]) => type === "wheel").length,
      trusted: inside.every(([, , trusted]) => trusted),
    };
  });
  const pick = (key) => stats(rows.map((r) => r[key]).filter((v) => typeof v === "number"));
  return {
    beforeInput: pick("beforeInput"),
    inputSpan: pick("inputSpan"),
    afterClick: pick("afterClick"),
    moves: pick("moves"),
    allTrusted: rows.every((r) => r.trusted),
    // Per call, because the split is often bimodal and percentiles hide it.
    calls: rows,
  };
}

async function run(source, timeoutMs = 300_000) {
  const result = await runScript(source, { ...opts, timeoutMs });
  if (result.code !== 0) {
    throw new Error(`script exited ${result.code}: ${(result.stderr + result.stdout).trim().split("\n").slice(-6).join(" | ")}`);
  }
  return result;
}

/** The replay pages a row's setup loads (golden/ego/dom/, served at /golden-replay/). */
function replayUrls(b) {
  return [...new Set((b.setup ?? "").match(/https?:\/\/[^"'\s]+\/golden-replay\/[a-z0-9-]+\.html/g) ?? [])];
}

const WARMUP_ATTEMPTS = 5;

/**
 * Loads each replay page of a row until its load event fires, before the
 * row's own setup and timed runs, so a cold cache can't fail the setup. The
 * replays still fetch CSS, images and frames from the live sites.
 *
 * Zen needs more than one try on the GitHub replay: on a fresh profile, eight
 * of its header images stay incomplete in the first one to three documents
 * that load it, for minutes, though the network serves them in 0.1 s; the
 * next document gets them at once (tests/README.md, "bench"). Waiting longer
 * doesn't help, so each try gets 15 s and the next try is a new load.
 * Returns { ms, replays: [{ replay, tries, loaded, errors }] }, or null for a
 * row with no replay.
 */
async function warmReplays(b, spaceId) {
  const urls = replayUrls(b);
  if (!urls.length) return null;
  const t0 = Date.now();
  const result = await run(`
const task = await taskSpace(${spaceId});
const page = task.page("p1");
const replays = [];
for (const url of ${JSON.stringify(urls)}) {
  const r = { replay: url.slice(url.lastIndexOf("/") + 1), tries: 0, loaded: false, errors: [] };
  while (!r.loaded && r.tries < ${WARMUP_ATTEMPTS}) {
    r.tries++;
    try {
      await page.goto(url, { timeout: 15000 });
      r.loaded = true;
    } catch (error) {
      r.errors.push(String(error.code || error.name));
    }
  }
  replays.push(r);
}
console.log("WARMUP=" + JSON.stringify(replays));`);
  const replays = JSON.parse(/WARMUP=(\[.*\])/.exec(result.stdout + result.stderr)?.[1] ?? "[]");
  return { ms: Date.now() - t0, replays };
}

async function main() {
  const startedAt = new Date().toISOString();
  const version = await targetVersion(opts);
  const { server, baseUrl } = await startFixtureServer("bench");
  const tmp = await mkdtemp(join(tmpdir(), "zen-eval-bench-"));
  const shotDir = join(tmp, "shots");
  await mkdir(shotDir, { recursive: true });
  const results = [];
  const want = (name) => !only || only.has(name);
  let spaceId = null;
  const log = (r) =>
    console.log(
      `${r.name.padEnd(24)} ${r.error ? "ERROR " + r.error : `p50 ${r.p50?.toFixed(1).padStart(8)} ms  p95 ${r.p95?.toFixed(1).padStart(8)} ms  (n=${r.n})`}`,
    );

  try {
    // Spawn → first RPC, and spawn → exit for a script that does only that.
    if (want("spawn-first-rpc")) {
      const first = [];
      const exit = [];
      for (let i = -WARMUP; i < N; i++) {
        const resultPath = join(tmp, `spawn-${i}.json`);
        const spawnedAt = Date.now();
        const r = await run(`
const { writeFile } = await import("node:fs/promises");
await listTaskSpaces();
await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ at: Date.now() }));
`);
        const { at } = JSON.parse(await readFile(resultPath, "utf8"));
        if (i >= 0) {
          first.push(at - spawnedAt);
          exit.push(r.ms);
        }
      }
      for (const [name, label, samples] of [
        ["spawn-first-rpc", "spawn to first RPC (listTaskSpaces)", first],
        ["spawn-exit", "spawn to exit, script with one RPC", exit],
      ]) {
        const r = { name, group: "process", label, ...stats(samples), samples };
        results.push(r);
        log(r);
      }
    }

    // taskSpace create and finish, paired.
    if (want("taskspace-create") || want("finish")) {
      const resultPath = join(tmp, "spaces.json");
      await run(`
const { writeFile } = await import("node:fs/promises");
const create = [];
const finish = [];
for (let i = -${WARMUP}; i < ${N}; i++) {
  const t0 = performance.now();
  const task = await taskSpace("zen-eval bench create " + Date.now() + " " + i);
  const t1 = performance.now();
  await task.finish({ keep: [] });
  const t2 = performance.now();
  if (i >= 0) { create.push(t1 - t0); finish.push(t2 - t1); }
}
await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ create, finish }));
`);
      const { create, finish } = JSON.parse(await readFile(resultPath, "utf8"));
      for (const [name, label, samples] of [
        ["taskspace-create", "taskSpace(name), new space", create],
        ["finish", "finish({ keep: [] }), blank space", finish],
      ]) {
        const r = { name, group: "spaces", label, ...stats(samples), samples };
        results.push(r);
        log(r);
      }
    }

    const created = await run(`const task = await taskSpace("zen-eval bench ${Date.now()}"); console.log("SPACE=" + task.spaceId);`);
    spaceId = Number(/SPACE=(\d+)/.exec(created.stdout + created.stderr)?.[1]);
    if (!spaceId) throw new Error("could not create the bench space");

    for (const b of warmBenches({ base: baseUrl, shotDir })) {
      if (!want(b.name)) continue;
      const resultPath = join(tmp, `${b.name}.json`);
      const iterations = Math.min(b.iterations || N, N);
      let warmup = null;
      try {
        warmup = await warmReplays(b, spaceId);
        await run(warmScript(b, { spaceId, resultPath, iterations }));
        const out = JSON.parse(await readFile(resultPath, "utf8"));
        const r = { name: b.name, group: b.group, label: b.label, ...stats(out.samples), samples: out.samples };
        if (warmup) r.replayWarmup = warmup;
        if (out.extra.bytes) r.bytes = out.extra.bytes;
        if (out.extra.value !== undefined) r.check = out.extra.value;
        if (b.timeline) r.timeline = analyzeTimeline(out.calls, out.extra.events || []);
        results.push(r);
        log(r);
      } catch (error) {
        const r = { name: b.name, group: b.group, label: b.label, error: String(error.message).slice(0, 400) };
        if (warmup) r.replayWarmup = warmup;
        results.push(r);
        log(r);
      }
      await rm(shotDir, { recursive: true, force: true });
      await mkdir(shotDir, { recursive: true });
    }

    for (const b of coldBenches({ base: baseUrl })) {
      if (!want(b.name)) continue;
      let warmup = null;
      try {
        warmup = await warmReplays(b, spaceId);
        await run(`const task = await taskSpace(${spaceId}); const page = task.page("p1"); ${b.setup}`);
        const op = [];
        const resume = [];
        const wall = [];
        for (let i = 0; i < N; i++) {
          const resultPath = join(tmp, `${b.name}-${i}.json`);
          const r = await run(coldScript(b, { spaceId, resultPath }));
          const out = JSON.parse(await readFile(resultPath, "utf8"));
          op.push(out.op);
          resume.push(out.resume);
          wall.push(r.ms);
        }
        const r = { name: b.name, group: "cold", label: b.label, ...stats(op), samples: op, resume: stats(resume), wall: stats(wall) };
        if (warmup) r.replayWarmup = warmup;
        results.push(r);
        log(r);
      } catch (error) {
        const r = { name: b.name, group: "cold", label: b.label, error: String(error.message).slice(0, 400) };
        if (warmup) r.replayWarmup = warmup;
        results.push(r);
        log(r);
      }
    }
  } finally {
    if (spaceId) {
      await run(`const task = await taskSpace(${spaceId}); await task.finish({ keep: [] });`, 30_000).catch((error) =>
        console.error("FINISH FAILED for bench space", spaceId, error.message),
      );
    }
    await closeFixtureServer(server);
    await rm(tmp, { recursive: true, force: true });
  }

  await mkdir(join(REPO_ROOT, "tests", "bench", "out"), { recursive: true });
  const doc = {
    target: opts.target,
    version: version.version,
    versionDetail: version.detail,
    startedAt,
    finishedAt: new Date().toISOString(),
    iterations: N,
    warmup: WARMUP,
    machine: { platform: process.platform, arch: process.arch },
    results,
  };
  await writeFile(outPath, JSON.stringify(doc, null, 2) + "\n");
  console.log(`\nresults: ${outPath}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await main();
