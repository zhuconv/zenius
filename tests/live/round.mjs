#!/usr/bin/env node
// Rubric C's rounds (docs/eval/live-tasks.md, "Rounds and order"). Each task's two targets
// run back to back, so live answers come from about the same site state. Round 1 starts with
// Ego on odd tasks and with zenius on even ones; round 2 swaps. Each run is one run.mjs call
// with its own --out, <out>/<task>/<target>/; round.json and round.md merge them.
//
//   node tests/live/round.mjs --round 1 --instance <dev instance> --keys tests/live/keys-<date>.json \
//     --out <dir> [--tasks T1,T2] [--judge] [--resume] [--wait-while <command>]... [--check-site <task>]...
//     [-- <run.mjs flags>]
//
// --wait-while names a command that exits 0 while a run mustn't start, such as a check that
// the screen is locked or the user is in a call; before each run the round waits until every
// such command exits non-zero, and records the wait. --resume skips the runs whose summary
// is already in --out; a run without one is set aside as <target>.failed-<time> first. A
// run.mjs that fails stops the round, since a wiring failure must not be run past.
// --check-site <task> loads the task's sites just before its two runs. When one answers
// with HTTP 5xx or not at all, both targets record "site down" and the pair doesn't run; it
// waits for the next round (zen-manager, for T9, 2026-11-21). A refusal such as a 403
// isn't "down": the agents meet the same wall. --record-key <command> covers a site that
// comes back during the round while the task's key is still pending: at the task's turn the
// round runs `<command> <task> <keys file> <checkout>`, which records the key as it would
// have been recorded before the round, then reads the keys file again. Without it, or if the
// key is still pending after it, the round stops there as before.
// zenius's dev instance runs throughout (the caller starts it, without dev methods). Ego
// Lite must run already: run.mjs never starts it.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TASKS } from "./tasks.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const RUN = join(ROOT, "tests", "live", "run.mjs");
export const ALL_TASKS = Array.from({ length: 15 }, (_, i) => `T${i + 1}`);

/** The order of a task's two runs: round 1 starts with Ego on odd tasks, round 2 swaps. */
export function orderOf(taskId, round) {
  const odd = Number(taskId.replace(/^T/, "")) % 2 === 1;
  return odd === (round === 1) ? ["ego", "zenius"] : ["zenius", "ego"];
}

/**
 * Whether a task's sites answer: a GET of each one's front page. HTTP 5xx or no answer is
 * down; anything else, a refusal included, is up.
 */
export async function siteState(sites, fetcher = fetch) {
  for (const site of sites) {
    try {
      const r = await fetcher(`https://${site}/`, { headers: { "user-agent": "Mozilla/5.0" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      if (r.status >= 500) return { down: true, site, status: `HTTP ${r.status}` };
    } catch (error) {
      return { down: true, site, status: String(error.cause?.code ?? error.name ?? error) };
    }
  }
  return { down: false };
}

/** Whether a task has fixed items and no answer key to check them against yet. */
export function keyPending(task, key) {
  return task.rubric.some((item) => item.type === "fixed") && (!key || "pending" in key);
}

/**
 * --record-key: a pending key read now that its site answers. Runs the recorder, then
 * reloads keyData from the keys file in place, whatever the recorder's exit: the caller
 * checks keyPending again. Returns the record for round.json.
 */
export function recordPendingKey({ taskId, recorder, keysFile, root, keyData }) {
  const rec = spawnSync(recorder, [taskId, keysFile, root], { stdio: "inherit" });
  for (const id of Object.keys(keyData)) delete keyData[id];
  Object.assign(keyData, JSON.parse(readFileSync(keysFile, "utf8")));
  return { task: taskId, at: new Date().toISOString(), exit: rec.error ? String(rec.error.code ?? rec.error) : (rec.status ?? rec.signal) };
}

const rubricText = (r) => r.items.map((i) => `${i.id} ${i.pass === null ? "?" : i.pass ? "✓" : "✗"}`).join(", ");

/** The round's table, run by run, then pooled per target. */
export function markdown(s) {
  const secs = (v) => (v == null ? "–" : `${Math.round(v / 1000)} s`);
  const usd = (v) => (v == null ? "–" : `$${v.toFixed(2)}`);
  const k = (n) => `${((n ?? 0) / 1000).toFixed(1)}k`;
  const lines = [
    `Round ${s.round} at ${s.commit}${s.dirty.length ? ` (with local changes: ${s.dirty.join("; ")})` : ""}, started ${s.started}.`,
    "",
    "| Task | Target | Order | Success | Rubric | Turns | Wall | Cost | Tokens in/out | Denied | Safety flags | Left behind | Wiring |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of s.runs) {
    lines.push(
      `| ${r.task} | ${r.target} | ${r.order} | ${r.success ? "yes" : "no"} | ${rubricText(r)} | ${r.turns ?? "–"} | ${secs(r.wallMs)} | ${usd(r.costUsd)} | ${k(r.usage?.input_tokens)}/${k(r.usage?.output_tokens)} | ${r.permissionDenials.length} | ${r.safety.length} | ${r.leftoverSpaces.length} | ${r.wiring.pass ? "ok" : "CHECK"} |`,
    );
  }
  lines.push("", "| Target | Runs | Full success | Rubric average | Mean turns | Mean wall | Total cost |", "|---|---|---|---|---|---|---|");
  for (const target of ["ego", "zenius"]) {
    const runs = s.runs.filter((r) => r.target === target);
    if (!runs.length) continue;
    const mean = (f) => runs.reduce((a, r) => a + (f(r) ?? 0), 0) / runs.length;
    lines.push(
      `| ${target} | ${runs.length} | ${runs.filter((r) => r.success).length}/${runs.length} | ${(mean((r) => r.rubricAverage) * 100).toFixed(1)}% | ${mean((r) => r.turns).toFixed(1)} | ${secs(mean((r) => r.wallMs))} | ${usd(runs.reduce((a, r) => a + (r.costUsd ?? 0), 0))} |`,
    );
  }
  if (s.siteDown?.length) lines.push("", `Site down, not run (they wait for the next round): ${s.siteDown.map((d) => `${d.task} (${d.site}, ${d.status} at ${d.at})`).join("; ")}.`);
  if (s.keysRecorded?.length) lines.push("", `Keys recorded during the round, when their site came back: ${s.keysRecorded.map((k) => `${k.task} at ${k.at} (recorder exit ${k.exit})`).join("; ")}.`);
  if (s.waits.length) lines.push("", `Waits before runs: ${s.waits.map((w) => `${w.task}/${w.target} ${w.waitedS} s (${w.reasons.join(", ")})`).join("; ")}.`);
  return lines.join("\n") + "\n";
}

async function main(argv) {
  const dash = argv.indexOf("--");
  const own = dash >= 0 ? argv.slice(0, dash) : argv;
  const passThrough = dash >= 0 ? argv.slice(dash + 1) : [];
  const arg = (name, fallback) => {
    const i = own.indexOf(name);
    return i >= 0 ? own[i + 1] : fallback;
  };
  const round = Number(arg("--round"));
  const instance = arg("--instance");
  const keys = arg("--keys");
  if (![1, 2].includes(round) || !instance || !keys || !arg("--out")) {
    console.error("usage: round.mjs --round 1|2 --instance <dev instance> --keys <file> --out <dir> [--tasks T1,T2] [--judge] [--resume] [--wait-while <command>]... [--check-site <task>]... [--record-key <command>] [-- <run.mjs flags>]");
    process.exit(2);
  }
  const out = resolve(arg("--out"));
  const taskIds = arg("--tasks", ALL_TASKS.join(",")).split(",");
  const judge = own.includes("--judge");
  const resume = own.includes("--resume");
  const waitWhile = own.flatMap((a, i) => (a === "--wait-while" ? [own[i + 1]] : []));
  const checkSites = own.flatMap((a, i) => (a === "--check-site" ? [own[i + 1]] : []));
  const recorder = arg("--record-key");
  for (const id of [...taskIds, ...checkSites]) if (!TASKS[id]) throw new Error(`no task ${id}`);
  const keyData = JSON.parse(readFileSync(resolve(keys), "utf8"));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--", "runtime", "sdk", "scripts", "tests/live"], { encoding: "utf8" }).trim();
  const state = {
    round,
    commit: execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: dirty ? dirty.split("\n") : [],
    started: new Date().toISOString(),
    waits: [],
    siteDown: [],
    keysRecorded: [],
    runs: [],
  };
  const roundFile = join(out, "round.json");
  if (resume && existsSync(roundFile)) {
    const before = JSON.parse(readFileSync(roundFile, "utf8"));
    if (before.round === round) Object.assign(state, { started: before.started, waits: before.waits ?? [], siteDown: before.siteDown ?? [], keysRecorded: before.keysRecorded ?? [] });
  }

  /** Wait while any --wait-while command exits 0; how long, and why. */
  async function waitTurn() {
    const started = Date.now();
    const reasons = new Set();
    for (;;) {
      const holding = waitWhile.filter((command) => spawnSync("/bin/sh", ["-c", command], { stdio: "ignore" }).status === 0);
      if (!holding.length) break;
      for (const h of holding) if (!reasons.has(h)) console.log(`${new Date().toISOString()} waiting: ${h}`);
      for (const h of holding) reasons.add(h);
      await sleep(30_000);
    }
    return { waitedS: Math.round((Date.now() - started) / 1000), reasons: [...reasons] };
  }

  function runOne(taskId, target, dir) {
    const args = [RUN, "--target", target, ...(target === "zenius" ? ["--instance", instance] : []), "--keys", keys, "--tasks", taskId, "--out", dir, ...(judge ? ["--judge"] : []), ...passThrough];
    mkdirSync(dir, { recursive: true });
    const log = createWriteStream(`${dir}.log`);
    return new Promise((done) => {
      const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on("close", (code, signal) => {
        log.end();
        done(code ?? signal);
      });
    });
  }

  function collect() {
    state.runs = [];
    for (const taskId of taskIds) {
      orderOf(taskId, round).forEach((target, i) => {
        const file = join(out, taskId, target, "summary.json");
        if (!existsSync(file)) return;
        const s = JSON.parse(readFileSync(file, "utf8"));
        for (const r of s.runs) state.runs.push({ target, order: i + 1, ...r, meta: { claudeVersion: s.claudeVersion, model: s.model, effort: s.effort, contained: s.contained, instance: s.instance } });
      });
    }
    writeFileSync(roundFile, JSON.stringify(state, null, 2) + "\n");
    writeFileSync(join(out, "round.md"), markdown(state));
  }

  mkdirSync(out, { recursive: true });
  try {
    for (const taskId of taskIds) {
      const done = orderOf(taskId, round).every((target) => existsSync(join(out, taskId, target, "summary.json")));
      if (checkSites.includes(taskId) && !(resume && done)) {
        const site = await siteState(TASKS[taskId].sites);
        state.siteDown = state.siteDown.filter((d) => d.task !== taskId);
        if (site.down) {
          state.siteDown.push({ task: taskId, at: new Date().toISOString(), site: site.site, status: site.status });
          console.log(`${new Date().toISOString()} ${taskId}: site down (${site.site}, ${site.status}); both targets record it, and it waits for the next round`);
          collect();
          continue;
        }
        if (recorder && !done && keyPending(TASKS[taskId], keyData[taskId])) {
          console.log(`${new Date().toISOString()} ${taskId}: the site is up and its key pending; recording it: ${recorder} ${taskId}`);
          const record = recordPendingKey({ taskId, recorder, keysFile: resolve(keys), root: ROOT, keyData });
          state.keysRecorded.push(record);
          console.log(`${new Date().toISOString()} ${taskId}: recorder exit ${record.exit}; key ${keyPending(TASKS[taskId], keyData[taskId]) ? "still pending" : "recorded"}`);
          collect();
        }
      }
      if (!done && keyPending(TASKS[taskId], keyData[taskId])) {
        throw new Error(`stopping the round: ${taskId} has fixed items but no answer key yet (${keyData[taskId]?.pending ?? "none in the keys file"}). Record it, then rerun with --resume.`);
      }
      for (const target of orderOf(taskId, round)) {
        const dir = join(out, taskId, target);
        if (resume && existsSync(join(dir, "summary.json"))) {
          console.log(`${taskId} ${target}: done before, skipped`);
          continue;
        }
        const stamp = Date.now();
        if (existsSync(dir)) renameSync(dir, `${dir}.failed-${stamp}`);
        if (existsSync(`${dir}.log`)) renameSync(`${dir}.log`, `${dir}.failed-${stamp}.log`);
        const wait = await waitTurn();
        if (wait.waitedS > 0) state.waits.push({ task: taskId, target, ...wait });
        console.log(`${new Date().toISOString()} ${taskId} ${target}: start`);
        const status = await runOne(taskId, target, dir);
        collect();
        const run = state.runs.find((r) => r.task === taskId && r.target === target);
        console.log(`${new Date().toISOString()} ${taskId} ${target}: ${status === 0 && run ? `${run.success ? "success" : "no success"}; ${rubricText(run)}; ${run.turns} turns, ${Math.round(run.wallMs / 1000)} s` : `run.mjs exit ${status}`}`);
        if (status !== 0 || !run) throw new Error(`stopping the round: ${taskId} on ${target} failed (run.mjs exit ${status}); its log is ${dir}.log`);
      }
    }
  } finally {
    collect();
    console.log(markdown(state));
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await main(process.argv.slice(2));
