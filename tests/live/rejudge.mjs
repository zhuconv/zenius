#!/usr/bin/env node
// Grade a saved run of rubric C again with the current judge (judge.mjs),
// without rerunning its agent: the run's transcript (<task>.stream.jsonl) and
// answer (summary.json) from a round's --out. It prints each live item's
// verdict then and now, to check a change to the judge against runs whose
// items were checked by hand (round 1's T10, docs/eval/live-round1.md). Its
// own output goes to <run>/rejudge-<UTC time>/; the run's files stay as they are.
//
//   node tests/live/rejudge.mjs --run <out>/<task>/<target> [--claude <path>] [--model <id>] [--effort <level>]
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runJudge, trajectory } from "./judge.mjs";
import { TASKS } from "./tasks.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const runDir = arg("--run") && resolve(arg("--run"));
if (!runDir || !existsSync(join(runDir, "summary.json"))) {
  console.error("usage: rejudge.mjs --run <out>/<task>/<target> [--claude <path>] [--model <id>] [--effort <level>]");
  process.exit(2);
}
const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
const run = summary.runs[0];
const task = TASKS[run.task];
const transcript = join(runDir, `${run.task}.stream.jsonl`);
if (!task || !existsSync(transcript)) {
  console.error(`rejudge.mjs: no task ${run.task} in tasks.mjs, or no ${transcript}`);
  process.exit(2);
}
const events = readFileSync(transcript, "utf8")
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const CLAUDE = realpathSync(arg("--claude", join(homedir(), ".local", "bin", "claude")));
const claude = (args) => (CLAUDE.endsWith(".mjs") ? [process.execPath, [CLAUDE, ...args]] : [CLAUDE, args]);
// As run.mjs's judge: its isolation, and an environment built from scratch.
const isolationArgs = ["--setting-sources", "project", "--settings", JSON.stringify({ autoMemoryEnabled: false }), "--strict-mcp-config", "--no-session-persistence"];
const env = (tmp) => ({
  HOME: homedir(),
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME ?? process.env.USER,
  LANG: "en_US.UTF-8",
  SHELL: process.platform === "darwin" ? "/bin/zsh" : "/bin/bash",
  TERM: "xterm-256color",
  PATH: process.platform === "darwin" ? "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/bin:/bin:/usr/sbin:/sbin",
  TMPDIR: tmp,
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});
const outDir = join(runDir, `rejudge-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`);
mkdirSync(outDir);
const verdict = await runJudge({
  claude,
  model: arg("--model", summary.model ?? "claude-opus-5-5"),
  effort: arg("--effort", summary.effort ?? "xhigh"),
  isolationArgs,
  env,
  outDir,
  id: run.task,
  task,
  answer: String(run.answer ?? ""),
  steps: trajectory(events),
  instance: summary.instance ?? null,
});
console.log(`${run.task} ${summary.target}: the judge saw ${verdict.images.shown} image(s), ${verdict.images.notShown} not shown; $${verdict.costUsd ?? "?"}`);
for (const item of run.items.filter((i) => i.type === "live")) {
  const now = verdict.items.find((v) => v.id === item.id);
  console.log(`- ${item.id}: then ${item.pass ? "pass" : "fail"}, now ${now ? (now.pass ? "pass" : "fail") : "no verdict"}`);
  if (now?.why) console.log(`    ${String(now.why).slice(0, 300)}`);
}
console.log(`judge's output: ${join(outDir, `${run.task}.judge.json`)}`);
