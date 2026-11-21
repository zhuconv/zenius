#!/usr/bin/env node
// Rubric C: run live-site tasks (tests/live/tasks.mjs) with one fresh Claude
// Code agent per task, and score them (docs/eval/live-tasks.md).
//
//   node tests/live/run.mjs --instance <dev instance> --keys tests/live/keys-<date>.json \
//     --tasks T2,T8,T13 --out <scratch dir> [--judge]
//   node tests/live/run.mjs --instance <dev instance> --out <scratch dir> --canary
//   node tests/live/run.mjs --instance <dev instance> --out <scratch dir> --smoke
//
// --canary runs the containment canary under exactly the task runs'
// settings; run it before any round. It covers the CLI's sandbox and the hook
// (canary.mjs) and the browser (browser-probes.mjs). --smoke checks the wiring with one
// cheap agent. The instance must run without dev methods:
// ZENIUS_DEV_METHODS=0 scripts/zen-dev.sh <instance> restart.
// --node names the Node 24 the launcher runs (default: Homebrew's node@24 on
// the Mac, else this node). --claude tests/live/stand-in-agent.mjs checks the
// wiring with no model call; --local-control loads the canary's control page
// from the probes' loopback server instead of https://example.com/.
//
// The agents read untrusted pages, so a page could try to steer one. What
// limits it (zen-manager's decisions, 2026-11-20; docs/eval/live-pilot.md):
// - The agent's `zenius` is the sandboxed launcher the user chose
//   (scripts/install-cli.sh --sandbox; sdk/sandbox/), installed into each
//   run's own temp home. The process that runs the agent's scripts reads only
//   the CLI copy, the instance registry, the run's working folder and its own
//   temporary and output folders; writes only those two; starts no process;
//   and connects only to the instance's socket. The launcher's sandbox-exec
//   profile grew from the pilot's own cli-sandbox.sb, which it replaces.
// - A PreToolUse hook (allow-cli.mjs, passed in --settings) decides every tool
//   call: Bash only for the CLI, run as the run's own launcher by its path
//   (the Bash tool sources the user's shell snapshot, whose PATH could find
//   their own zenius first) and on the run's instance only; Read only in the
//   run's temp home and its own tool-results; Skill only for zenius;
//   everything else denied. --permission-mode dontAsk denies whatever the
//   hook doesn't decide.
// - The browser instance answers no dev.* methods.
// How a run is kept apart from the user's own Claude Code (checked on 2.1.329):
// - Each run has a fresh temp home in --out, removed afterwards: work/, its
//   working folder, holding only .claude/skills/zenius (the install's link to
//   its CLI copy's Skill); tmp/, its TMPDIR, beside work/ since the launcher
//   grants no working folder that holds a temp folder; and home/, with the
//   CLI copy, the launcher and the launcher's output folders. The run checks
//   that its skill came from there, not from the user's own install.
//   --setting-sources project loads that folder's skills and settings only:
//   none of the user's skills, plugins, hooks, settings or CLAUDE.md. Claude
//   Code's built-in skills stay listed, the same for every target.
// - Its environment is built from scratch. CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
//   stops the background skill sync and feature-flag cache writes, --settings
//   turns auto-memory off, and --no-session-persistence keeps the transcript
//   off disk. Claude Code still keeps per-folder state in ~/.claude/projects
//   (oversized tool outputs, during the run) and ~/.claude/session-env; the
//   harness removes the run's own folders afterwards.
// - The Claude Code binary is resolved once to its versioned file.
// The raw streams stay in --out; summary.json and summary.md hold scores,
// timings, tokens and the answers.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONTROL_TEXT, browserProbeScript, extensionPageFromPrefs, probeFixture, probesFrom, scoreProbes } from "./browser-probes.mjs";
import { PUBLIC_CONTROL, canaryPrompt, canaryScript, scoreCanary } from "./canary.mjs";
import { COMMON_TAIL, TASKS } from "./tasks.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const HOOK = join(ROOT, "tests", "live", "allow-cli.mjs");
const INSTALL = join(ROOT, "scripts", "install-cli.sh");
const DARWIN = process.platform === "darwin";
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const mode = argv.includes("--canary") ? "canary" : argv.includes("--smoke") ? "smoke" : "tasks";
const instance = arg("--instance");
const outDir = resolve(arg("--out", "live-out"));
const taskIds = arg("--tasks", "T2,T8,T13").split(",");
const judge = argv.includes("--judge");
const MODEL = arg("--model", mode === "smoke" ? "claude-haiku-5-5" : "claude-opus-5-5");
const EFFORT = arg("--effort", mode === "smoke" ? null : "xhigh");
const MAX_TURNS = Number(arg("--max-turns", mode === "smoke" ? 12 : 60));
const MAX_MINUTES = Number(arg("--max-minutes", mode === "smoke" ? 5 : 20));
const CLAUDE = realpathSync(arg("--claude", join(homedir(), ".local", "bin", "claude")));
/** Claude Code, or a stand-in for it (stand-in-agent.mjs), which runs on this node. */
const claude = (args) => (CLAUDE.endsWith(".mjs") ? [process.execPath, [CLAUDE, ...args]] : [CLAUDE, args]);
// The Node 24 the launcher runs, kept by the path given: install-cli.sh
// --sandbox keeps Homebrew's opt/node@24 link, so an upgrade within 24.x
// moves with it. The harness's own CLI calls use it too.
const NODE = arg("--node", DARWIN ? "/opt/homebrew/opt/node@24/bin/node" : process.execPath);
if (!existsSync(NODE)) {
  console.error(`run.mjs: no node at ${NODE}; the sandboxed launcher needs Node 24 (on the Mac: brew install node@24), or name one with --node`);
  process.exit(2);
}
const BASE_PATH = DARWIN ? "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/bin:/bin:/usr/sbin:/sbin";
const SOCKET = join(homedir(), ".zenius", "run", `${instance}.sock`);
const LOCAL_CONTROL = argv.includes("--local-control");
if (!instance || (mode === "tasks" && !argv.includes("--keys"))) {
  console.error("usage: run.mjs --instance <dev instance> --keys <file> [--tasks T2,T8] [--out dir] [--judge] | --canary | --smoke");
  process.exit(2);
}
const keys = mode === "tasks" ? JSON.parse(readFileSync(resolve(arg("--keys")), "utf8")) : {};
// The harness's own TMPDIR in the clean environment (its own zenius calls
// write temp files there).
const HARNESS_TMP = join(outDir, "tmp");
mkdirSync(HARNESS_TMP, { recursive: true });

/** A fresh environment: nothing from this process's Claude Code session. */
function cleanEnv(tmp, extra = {}) {
  return {
    HOME: homedir(),
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME ?? process.env.USER,
    LANG: "en_US.UTF-8",
    SHELL: DARWIN ? "/bin/zsh" : "/bin/bash",
    TERM: "xterm-256color",
    PATH: BASE_PATH,
    TMPDIR: tmp,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...extra,
  };
}

function q(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`;
}

const BASE_SETTINGS = { autoMemoryEnabled: false };
const isolation = (settings = BASE_SETTINGS) => [
  "--setting-sources", "project",
  "--settings", JSON.stringify(settings),
  "--strict-mcp-config",
  "--no-session-persistence",
];
const AGENT_SETTINGS = {
  ...BASE_SETTINGS,
  hooks: {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${q(process.execPath)} ${q(HOOK)} zenius zenius` }] }],
  },
};
const [claudeFile, claudeArgs] = claude(["--version"]);
const claudeVersion = execFileSync(claudeFile, claudeArgs, { encoding: "utf8", env: cleanEnv(HARNESS_TMP) }).trim();

/** Every run's temp home this process made; any a run didn't remove goes at the end. */
const runRoots = new Set();
let bundleBuilt = false;

/**
 * A run's own temp home in --out, with the zenius CLI as an agent gets it
 * (never ~/.zenius/cli, ~/.local/bin or the user's skill folders):
 * - work/: the agent's working folder. install-cli.sh --skill links
 *   work/.claude/skills/zenius to the copy's Skill, so the agent's skill is
 *   the one its CLI came with.
 * - tmp/: the agent's TMPDIR, beside work/: the launcher grants no working
 *   folder that holds a temp folder.
 * - home/: the CLI copy (cli/), the sandboxed launcher (bin/zenius) and its
 *   output folders (out/). ZENIUS_HOME keeps its default, ~/.zenius, which
 *   holds the dev instances' sockets; the hook keeps commands on --instance.
 */
function makeRun(id) {
  const root = realpathSync(mkdtempSync(join(outDir, `run-${id}-`)));
  runRoots.add(root);
  const home = join(root, "home");
  const run = { id, root, work: join(root, "work"), tmp: join(root, "tmp"), cli: join(home, "cli"), launcher: join(home, "bin", "zenius"), out: join(home, "out") };
  run.skills = join(run.work, ".claude", "skills");
  mkdirSync(run.skills, { recursive: true });
  mkdirSync(run.tmp);
  // The first install builds the bundle when the checkout can; the rest reuse it.
  const install = spawnSync(INSTALL, ["--sandbox", "--skill", "--output-dir", run.out], {
    cwd: root,
    env: {
      ...cleanEnv(run.tmp, { PATH: `${dirname(NODE)}:${BASE_PATH}` }),
      ZENIUS_CLI_DIR: run.cli,
      ZENIUS_BIN_DIR: dirname(run.launcher),
      ZENIUS_SKILL_DIRS: run.skills,
      ...(bundleBuilt && { ZENIUS_INSTALL_NO_BUILD: "1" }),
    },
    encoding: "utf8",
    timeout: 300_000,
  });
  const said = `${install.stdout ?? ""}${install.stderr ?? ""}`;
  if (install.status !== 0) throw new Error(`install-cli.sh --sandbox failed (${install.status ?? install.signal ?? install.error}):\n${said}`);
  bundleBuilt = true;
  run.installed = /^check\s+(.+)$/m.exec(said)?.[1] ?? null;
  checkRun(run);
  run.baseline = launcherRuns(run);
  return run;
}

function removeRun(run) {
  rmSync(run.root, { recursive: true, force: true });
  runRoots.delete(run.root);
}

/**
 * Before an agent starts: the skill is the copy's, through the install's link,
 * and nothing else is in the working folder; the launcher, started there,
 * grants that folder, keeps its output and temporary folders in the run's
 * temp home, and runs on the run's instance.
 */
function checkRun(run) {
  const problems = [];
  const link = join(run.skills, "zenius");
  if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) problems.push(`${link} isn't the install's link`);
  else if (realpathSync(link) !== realpathSync(join(run.cli, "skill", "zenius"))) problems.push(`${link} leads to ${realpathSync(link)}, not the run's CLI copy`);
  if (readdirSync(run.skills).join() !== "zenius") problems.push(`${run.skills} holds ${readdirSync(run.skills).join(", ")}`);
  if (readdirSync(run.work).join() !== ".claude") problems.push(`${run.work} holds ${readdirSync(run.work).join(", ")}`);
  if (!/\(zenius-sandbox-launcher /.test(readFileSync(run.launcher, "utf8").split("\n")[1] ?? "")) problems.push(`${run.launcher} isn't the sandboxed launcher`);
  if (!problems.length) {
    const probe = spawnSync(run.launcher, ["nodejs"], {
      cwd: run.work,
      env: cleanEnv(run.tmp, { ZENIUS_INSTANCE: instance }),
      input: `const fs = await import("node:fs");
console.log("WIRING " + JSON.stringify({ cwd: process.cwd(), entries: fs.readdirSync("."), out: process.env.ZENIUS_OUTPUT_DIR ?? null, tmp: process.env.TMPDIR ?? null, instance: process.env.ZENIUS_INSTANCE ?? null }));
`,
      encoding: "utf8",
      timeout: 60_000,
    });
    const line = /^WIRING (.+)$/m.exec(probe.stdout ?? "")?.[1];
    const seen = line ? JSON.parse(line) : null;
    if (!seen) problems.push(`the launcher's check printed nothing (${probe.status ?? probe.signal}): ${`${probe.stdout ?? ""}${probe.stderr ?? ""}`.slice(0, 600)}`);
    else {
      if (seen.cwd !== run.work || !seen.entries.includes(".claude")) {
        problems.push(`the launcher didn't grant the run's folder (it ran in ${seen.cwd}): --out must not be inside ~/.zenius, ~/.zenius-dev, ~/.config, ~/.local, ~/Library, a credentials folder or a folder above a temp folder`);
      }
      if (!String(seen.out).startsWith(run.out + "/")) problems.push(`the launcher's output folder is ${seen.out}, outside ${run.out}`);
      if (!String(seen.tmp).startsWith(run.tmp + "/")) problems.push(`the launcher's TMPDIR is ${seen.tmp}, outside ${run.tmp}`);
      if (seen.instance !== instance) problems.push(`the launcher ran on ${seen.instance}, not ${instance}`);
    }
  }
  if (problems.length) throw new Error(`run ${run.id}'s zenius isn't wired as an agent needs it:\n- ${problems.join("\n- ")}`);
}

/** How often the run's launcher started: each start makes one run.* output folder, kept for days. */
function launcherRuns(run) {
  let starts = 0;
  for (const dir of existsSync(run.out) ? readdirSync(run.out) : []) {
    try {
      starts += readdirSync(join(run.out, dir)).filter((f) => f.startsWith("run.")).length;
    } catch {
      // not a folder of runs
    }
  }
  return starts;
}

/** Whether every zenius command the hook allowed started the run's launcher, as the hook's rewrite says. */
function launcherCheck(run, hookLog) {
  const starts = launcherRuns(run) - run.baseline;
  const allowed = hookCounts(join(outDir, hookLog)).allowedBash;
  return { starts, allowed, pass: starts === allowed, outcome: `${starts} launcher start${starts === 1 ? "" : "s"} for ${allowed} allowed zenius command${allowed === 1 ? "" : "s"}` };
}

/** Every string in a JSON value. */
function* stringsIn(value) {
  if (typeof value === "string") yield value;
  else if (value && typeof value === "object") for (const v of Object.values(value)) yield* stringsIn(v);
}

const realOr = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
const shortPath = (path) => path.replaceAll(outDir, "<out>").replaceAll(homedir(), "~");

// Claude Code's own skills, which 2.1.329 lists in every run besides the
// run's zenius (init's skills with --setting-sources project, 2026-11-20). If
// a later version adds one named like a user folder, the check fails and
// names it; add it here.
const CLAUDE_CODE_SKILLS = new Set([
  "deep-research", "dataviz", "update-config", "verify", "debug", "code-review", "simplify", "batch",
  "fewer-permission-prompts", "doctor", "loop", "schedule", "claude-api", "workflow-authoring", "run",
  "run-skill-generator", "plugin-authoring",
]);

/**
 * The agent's zenius skill must be the run's own, its CLI copy's through the
 * install's link: never the user's (~/.claude/skills/zenius, once the daily
 * install made it) or another folder's.
 * - The init event lists zenius once, and none of the user's other skills, so
 *   user skills didn't load at all. A user folder named like one of Claude
 *   Code's own skills proves nothing: on the Mac, the user's code-review
 *   shares the name of Claude Code's /code-review.
 * - Each "Base directory for this skill" in the stream names the run's skill.
 */
function skillCheck(run, init, events) {
  const listed = init.skills ?? [];
  const link = join(run.skills, "zenius");
  const own = new Set([link, realOr(link)]);
  let userSkills = [];
  try {
    userSkills = readdirSync(join(homedir(), ".claude", "skills"));
  } catch {
    // no user skills
  }
  // A user folder named like one of Claude Code's own skills is listed either
  // way, so only the user's other names show whether their skills loaded.
  const shared = userSkills.filter((name) => CLAUDE_CODE_SKILLS.has(name) && listed.includes(name));
  const leaked = userSkills.filter((name) => name !== "zenius" && !CLAUDE_CODE_SKILLS.has(name) && listed.includes(name));
  const seen = [...new Set(events.flatMap((e) => [...stringsIn(e)].flatMap((text) => [...text.matchAll(/Base directory for this skill: ([^\n]*)/g)].map((m) => m[1].trim()))))];
  const count = listed.filter((name) => name === "zenius").length;
  const pass = count === 1 && leaked.length === 0 && seen.every((dir) => own.has(dir) || own.has(realOr(dir)));
  const outcome = [
    `zenius listed ${count === 1 ? "once" : `${count} times`}`,
    `user skills listed: ${leaked.length ? leaked.join(", ") : "none"}${shared.length ? ` (${shared.join(", ")}: Claude Code's own too)` : ""}`,
    `loaded from: ${seen.length ? seen.map(shortPath).join(", ") : "not shown in the stream"}`,
  ].join("; ");
  return { pass, outcome };
}

/** The agent's environment: the run's launcher first on PATH, and the hook's view of the run. */
const agentEnv = (run, log) =>
  cleanEnv(run.tmp, {
    PATH: `${dirname(run.launcher)}:${BASE_PATH}`,
    ZENIUS_INSTANCE: instance,
    ALLOW_CLI_WORKDIR: run.work,
    ALLOW_CLI_READ_ROOT: run.root,
    ALLOW_CLI_LAUNCHER: run.launcher,
    ALLOW_CLI_INSTANCE: instance,
    ALLOW_CLI_LOG: join(outDir, log),
  });
const SAMPLE_RUN = { root: "<run>", work: "<run>/work", tmp: "<run>/tmp", launcher: "<run>/home/bin/zenius" };
/** The harness's own scripts run the run's CLI copy directly: they are ours, not an agent's. */
const harnessCli = (run, script) =>
  execFileSync(NODE, [join(run.cli, "sdk", "bin", "zenius"), "nodejs"], {
    env: cleanEnv(HARNESS_TMP, { ZENIUS_INSTANCE: instance, ZENIUS_SOCKET: SOCKET }),
    input: script,
    encoding: "utf8",
    timeout: 60_000,
  });
const listSpaces = (run) =>
  JSON.parse(harnessCli(run, "console.log(JSON.stringify((await listTaskSpaces()).map((s) => ({ id: s.id, name: s.name, ownership: s.ownership }))))").trim());

/** Agent scripts reach the instance's socket, so it must not answer dev.* methods. */
function assertNoDevMethods() {
  let stderr = "";
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts", "zen-rpc.mjs"), "-i", instance, "-c", "dev.evalChrome", '{"code":"return 1"}'], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
  } catch (error) {
    stderr = String(error.stderr ?? "");
    if (/unknown method dev\.evalChrome/.test(stderr)) return;
    throw new Error(`could not check ${instance}'s dev methods: ${stderr.slice(0, 300)}`);
  }
  throw new Error(`${instance} answers dev.* methods. Restart it with: ZENIUS_DEV_METHODS=0 scripts/zen-dev.sh ${instance} restart`);
}

function summary() {
  return {
    claudeVersion,
    model: MODEL,
    effort: EFFORT,
    target: "zenius",
    instance,
    node: shortPath(NODE),
    cli: "the sandboxed launcher (install-cli.sh --sandbox --skill), installed into each run's temp home",
    limits: { turns: MAX_TURNS, minutes: MAX_MINUTES },
    flags: agentArgs("<prompt>").slice(2).map((f) => f.replaceAll(homedir(), "~").replaceAll(outDir, "<out>")),
    env: Object.keys(agentEnv(SAMPLE_RUN, "x")).sort(),
    runs: results,
  };
}
function writeSummary() {
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary(), null, 2) + "\n");
  writeFileSync(join(outDir, "summary.md"), markdown(summary()));
}

function agentArgs(prompt) {
  return [
    "-p", prompt,
    "--model", MODEL,
    ...(EFFORT ? ["--effort", EFFORT] : []),
    ...isolation(AGENT_SETTINGS),
    "--tools", "Bash,Read,Skill",
    "--disallowedTools", "WebFetch", "WebSearch",
    "--permission-mode", "dontAsk",
    "--max-turns", String(MAX_TURNS),
    "--output-format", "stream-json", "--verbose",
  ];
}

// The skill's usual calls, on a page of the script's own: the guide, a task
// space, a snapshot, a fill and a click, a screenshot to a relative path
// (which lands in the launcher's output folder), and a Read of it.
const SMOKE_SCRIPT = `const task = await taskSpace("zen-eval smoke " + Date.now());
try {
  const page = task.page("p1");
  await page.goto("data:text/html,<title>smoke</title><label>Name <input id=name></label><button onclick=\\"document.title='clicked '+document.getElementById('name').value\\">Go</button>");
  console.log(await page.snapshot());
  await page.fill("#name", "zen-eval");
  await page.click("text=Go");
  console.log("title: " + (await page.title()));
  await page.screenshot({ path: "smoke.png" });
} finally {
  await task.finish({ keep: [] });
}`;
const SMOKE_PROMPT = [
  "This is a wiring check, not a browser task. Run each numbered command below with the Bash tool, exactly as written and one call each, and report each one's output or error:",
  "1. zenius --version",
  "2. zenius skill",
  "3. zenius nodejs <<'EOF'",
  SMOKE_SCRIPT,
  "EOF",
  "4. ls /",
  `Then call the Read tool once on the screenshot that command 3 wrote: its path follows "Wrote " in that command's output.`,
  "Then use the Skill tool to load the zenius skill, and say whether it loaded. Do nothing else.",
].join("\n");

async function runSmoke() {
  const run = makeRun("smoke");
  const promptFile = arg("--smoke-prompt");
  const prompt = promptFile ? readFileSync(promptFile, "utf8") : SMOKE_PROMPT;
  const hookLog = "smoke.hook.jsonl";
  const before = listSpaces(run);
  const agent = await runClaude(agentArgs(prompt), run.work, join(outDir, "smoke.stream.jsonl"), agentEnv(run, hookLog));
  const leftover = endLeftoverSpaces(run, before);
  const init = agent.events.find((e) => e.type === "system" && e.subtype === "init") ?? {};
  const result = agent.events.findLast((e) => e.type === "result") ?? {};
  const skill = skillCheck(run, init, agent.events);
  const launcher = launcherCheck(run, hookLog);
  removeRun(run);
  console.log(`claude ${claudeVersion}; model ${init.model}; permission ${init.permissionMode}; tools ${init.tools?.join(",")}`);
  console.log(`zenius: ${run.installed}, the sandboxed launcher on ${shortPath(NODE)}`);
  console.log(`skills: ${init.skills?.join(", ")}`);
  console.log(`${skill.pass ? "PASS" : "FAIL"}  the zenius skill is the run's own: ${skill.outcome}`);
  console.log(`${launcher.pass ? "PASS" : "FAIL"}  every allowed zenius command ran the run's launcher: ${launcher.outcome}`);
  for (const s of trajectory(agent.events)) console.log(`- ${s.tool}: ${s.input.slice(0, 120).replace(/\n/g, "⏎")}\n    → ${s.output.slice(0, 200).replace(/\n/g, "⏎")}`);
  console.log(`denials: ${JSON.stringify((result.permission_denials ?? []).map((d) => d.tool_input?.command ?? d.tool_input?.file_path ?? d.tool_name))}`);
  console.log(`result (${result.subtype}, ${result.num_turns} turns, $${result.total_cost_usd}): ${String(result.result ?? "").slice(0, 400)}`);
  console.log(`left behind: ${leftover.length ? JSON.stringify(leftover) : "none"}; tidied: ${JSON.stringify(tidy(agent, init))}; hook: ${JSON.stringify(hookCounts(join(outDir, hookLog)))}`);
}

async function runCanary() {
  const run = makeRun("canary");
  const hookLog = "canary.hook.jsonl";
  // The browser probes' files and loopback pages live in a fresh
  // ~/.zenius-dev/canary/<run>/ (zen-manager's rules); the script itself sits
  // in the agent's folder, where the sandboxed CLI may read it. The instance
  // runs without dev methods, so the extension's page comes from its prefs.js.
  const fixture = await probeFixture();
  const profileDir = join(homedir(), ".zenius-dev", "profiles", instance);
  const probeFile = join(run.work, "browser-probes.mjs");
  writeFileSync(probeFile, browserProbeScript({ ...fixture, extensionPage: extensionPageFromPrefs(profileDir), login: null }));
  const before = listSpaces(run);
  const control = LOCAL_CONTROL ? { url: `${fixture.base}/control.html`, text: CONTROL_TEXT, label: "the probes' loopback page" } : PUBLIC_CONTROL;
  const prompt = canaryPrompt(canaryScript({ outside: outDir, outRoot: run.out, control }), homedir(), `zenius nodejs -e 'await import(${JSON.stringify(probeFile)})'`);
  let agent;
  let written = {};
  let strayProbeFiles = [];
  let downloads = [];
  try {
    agent = await runClaude(agentArgs(prompt), run.work, join(outDir, "canary.stream.jsonl"), agentEnv(run, hookLog));
    written = fixture.written();
    strayProbeFiles = fixture.stray();
  } finally {
    downloads = fixture.close(profileDir);
  }
  const leftover = endLeftoverSpaces(run, before);
  const init = agent.events.find((e) => e.type === "system" && e.subtype === "init") ?? {};
  const result = agent.events.findLast((e) => e.type === "result") ?? {};
  const deniedIds = new Set((result.permission_denials ?? []).map((d) => d.tool_use_id));
  // A hook's deny shows as a permission denial; its reason text is the fallback.
  const hookReason = /Only the \S+ (CLI|skill)|Read is limited to this run|is not available in this evaluation|its own browser instance|launcher is missing/;
  const steps = trajectory(agent.events).map((s) => ({ ...s, denied: deniedIds.has(s.id) || (s.isError && hookReason.test(s.output)) }));
  const rows = scoreCanary(steps, homedir());
  const skill = (name) => steps.find((s) => s.tool === "Skill" && s.input === name);
  rows.push({ probe: "Skill zenius loads", outcome: skill("zenius") ? (skill("zenius").denied ? "denied" : "loaded") : "not tried", pass: Boolean(skill("zenius") && !skill("zenius").denied) });
  rows.push({ probe: "Skill update-config (another skill) is denied", outcome: skill("update-config") ? (skill("update-config").denied ? "denied" : "LOADED") : "not tried", pass: Boolean(skill("update-config")?.denied) });
  const origin = skillCheck(run, init, agent.events);
  rows.push({ probe: "the zenius skill is the run's own, from its temp home", outcome: origin.outcome, pass: origin.pass });
  const launcher = launcherCheck(run, hookLog);
  rows.push({ probe: "every allowed zenius command ran the run's launcher", outcome: launcher.outcome, pass: launcher.pass });
  const stray = [homedir(), outDir, run.work].flatMap((d) => readdirSync(d).filter((f) => f.startsWith("zenius-canary-")).map((f) => join(d, f)));
  removeRun(run);
  rows.push({ probe: "no canary file left outside the run's folder", outcome: stray.length ? stray.join(", ") : "none", pass: stray.length === 0 });
  rows.push({ probe: "no task space left behind", outcome: leftover.length ? JSON.stringify(leftover) : "none", pass: leftover.length === 0 });
  const probes = probesFrom(steps.filter((s) => s.tool === "Bash").map((s) => s.output));
  if (!probes) rows.push({ probe: "browser: the probe script ran", outcome: "no PROBES line in any Bash output", pass: false });
  else for (const r of scoreProbes(probes, written)) rows.push({ probe: `browser: ${r.probe}`, outcome: r.outcome.split(homedir()).join("~"), pass: r.pass, scored: r.scored });
  rows.push({ probe: "browser: nothing else written in the canary folder", outcome: strayProbeFiles.length ? strayProbeFiles.join(", ") : "none", pass: strayProbeFiles.length === 0 });
  const report = { claudeVersion, zenius: run.installed, node: shortPath(NODE), model: init.model, at: new Date().toISOString(), turns: result.num_turns, costUsd: result.total_cost_usd, tidied: tidy(agent, init), downloads, rows };
  writeFileSync(join(outDir, "canary.json"), JSON.stringify(report, null, 2) + "\n");
  for (const r of rows) console.log(`${r.scored === false ? "INFO" : r.pass ? "PASS" : "FAIL"}  ${r.probe.padEnd(52)} ${r.outcome}`);
  console.log(`${rows.every((r) => r.pass) ? "CANARY PASSED" : "CANARY FAILED"} (${result.num_turns} turns, $${result.total_cost_usd?.toFixed(2)})`);
}

async function runTask(id, task) {
  const run = makeRun(id);
  const before = listSpaces(run);
  const configBefore = claudeJsonDigest();
  const hookLog = `${id}.hook.jsonl`;
  const started = Date.now();
  const agent = await runClaude(agentArgs(`${task.prompt} ${COMMON_TAIL}`), run.work, join(outDir, `${id}.stream.jsonl`), agentEnv(run, hookLog));
  const wallMs = Date.now() - started;
  const configAfter = claudeJsonDigest();
  const claudeJsonKeysChanged = [...new Set([...Object.keys(configBefore), ...Object.keys(configAfter)])].filter((k) => configBefore[k] !== configAfter[k]);
  const visited = visitedSince(started);
  const leftover = endLeftoverSpaces(run, before);

  const init = agent.events.find((e) => e.type === "system" && e.subtype === "init") ?? {};
  const result = agent.events.findLast((e) => e.type === "result") ?? {};
  const skill = skillCheck(run, init, agent.events);
  const launcher = launcherCheck(run, hookLog);
  removeRun(run);
  const steps = trajectory(agent.events);
  const answer = String(result.result ?? "");
  const visitedText = [...steps.map((s) => `${s.input}\n${s.output}`), ...visited].join("\n");
  const items = task.rubric.map((item) => {
    if (item.type === "fixed") return { id: item.id, type: item.type, pass: Boolean(item.check(answer, keys[id])) };
    if (item.type === "trajectory") return { id: item.id, type: item.type, pass: item.visited.test(visitedText) };
    return { id: item.id, type: item.type, pass: null };
  });
  let judgeCostUsd = null;
  if (judge && items.some((i) => i.type === "live")) {
    const verdict = await judgeRun(id, task, answer, steps, visited);
    judgeCostUsd = verdict.costUsd;
    for (const v of verdict.items) {
      const item = items.find((i) => i.id === v.id && i.type === "live");
      if (item) Object.assign(item, { pass: Boolean(v.pass), why: String(v.why ?? "").slice(0, 300) });
    }
  }
  const passed = items.filter((i) => i.pass === true).length;
  return {
    task: id,
    title: task.title,
    answer,
    success: items.every((i) => i.pass === true),
    rubricAverage: passed / items.length,
    items,
    turns: result.num_turns ?? null,
    wallMs,
    durationMs: result.duration_ms ?? null,
    costUsd: result.total_cost_usd ?? null,
    usage: result.usage ?? usageFromEvents(agent.events),
    usageSource: result.usage ? "result" : "summed from assistant events (no result event)",
    stopReason: agent.limit ?? result.subtype ?? `exit ${agent.exitCode}`,
    isError: result.is_error ?? null,
    permissionDenials: (result.permission_denials ?? []).map((d) => String(d.tool_input?.command ?? d.tool_input?.file_path ?? d.tool_name).slice(0, 200)),
    hookDecisions: hookCounts(join(outDir, hookLog)),
    // The run's own zenius: each allowed command started its launcher, and the skill was its copy's.
    wiring: { pass: launcher.pass && skill.pass, launcher: launcher.outcome, skill: skill.outcome },
    skillCalls: steps.filter((s) => s.tool === "Skill").map((s) => s.input),
    usesFetch: steps.some((s) => /\bfetch\s*\(/.test(s.input)),
    visitedHosts: hostCounts(visited),
    safety: safetyFlags(steps, visited),
    leftoverSpaces: leftover,
    judgeCostUsd,
    tidied: tidy(agent, init),
    claudeJsonKeysChanged,
    loaded: {
      claudeCode: init.claude_code_version ?? null,
      model: init.model ?? null,
      permissionMode: init.permissionMode ?? null,
      tools: init.tools ?? null,
      mcpServers: (init.mcp_servers ?? []).map((m) => m.name),
      skills: init.skills ?? null,
      plugins: (init.plugins ?? []).map((p) => p.name ?? p),
      memoryPaths: init.memory_paths ?? null,
    },
  };
}

/**
 * End the task spaces a run left (reported apart from the score), so the next run starts clean.
 * Only spaces the user doesn't own: a claim of those asks no one, while a claim of the user's
 * would wait for their Allow (SPEC §3.4), and with dev methods off nothing here could answer.
 */
function endLeftoverSpaces(run, before) {
  const leftover = listSpaces(run).filter((s) => !before.some((b) => b.id === s.id) && s.ownership !== "user");
  for (const s of leftover) harnessCli(run, `const t = await claimTaskSpace(${s.id}).catch(() => taskSpace(${s.id})); await t.finish({ keep: [] });`);
  return leftover.map((s) => ({ id: s.id, ownership: s.ownership }));
}

/** Run Claude Code, keep its stream on disk, and stop it at the turn or time limit. */
function runClaude(args, cwd, streamPath, env) {
  return new Promise((resolveRun) => {
    const [file, fullArgs] = claude(args);
    const child = spawn(file, fullArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const events = [];
    const messageIds = new Set();
    let raw = "";
    let buffer = "";
    let stderr = "";
    let limit = null;
    const stop = (why) => {
      if (limit) return;
      limit = why;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    };
    const timer = setTimeout(() => stop(`time limit (${MAX_MINUTES} min)`), MAX_MINUTES * 60_000);
    child.stdout.on("data", (chunk) => {
      raw += chunk;
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          events.push(event);
          // The CLI's --max-turns stops it first; this is the backstop.
          if (event.type === "assistant" && event.message?.id) {
            messageIds.add(event.message.id);
            if (messageIds.size > MAX_TURNS + 2) stop(`turn limit (${MAX_TURNS})`);
          }
        } catch {
          // A partial or non-JSON line; the raw stream keeps it.
        }
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(streamPath, raw);
      if (stderr) writeFileSync(streamPath.replace(/\.jsonl$/, ".stderr.txt"), stderr);
      resolveRun({ events, limit, exitCode: code, pid: child.pid, cwd });
    });
  });
}

/**
 * Remove what Claude Code kept under ~/.claude for this run: its session
 * entry if the run was killed, its empty session-env folder, and its folder
 * in ~/.claude/projects (oversized tool outputs, named after the run's own
 * temp folder).
 */
function tidy(run, init) {
  return {
    sessionFiles: removeStaleSessionFiles(run.pid, run.cwd),
    sessionEnv: removeEmptySessionEnv(init.session_id),
    projectDir: removeRunProjectDir(run.cwd),
  };
}

function removeStaleSessionFiles(pid, cwd) {
  const dir = join(homedir(), ".claude", "sessions");
  const file = join(dir, `${pid}.json`);
  if (!existsSync(file)) return 0;
  try {
    if (JSON.parse(readFileSync(file, "utf8")).cwd !== cwd) return 0;
    process.kill(pid, 0);
    return 0; // still running: not ours to touch
  } catch (error) {
    if (error.code !== "ESRCH") return 0;
  }
  const files = readdirSync(dir).filter((f) => f === `${pid}.json` || (f.startsWith(`${pid}.`) && f.endsWith(".key")));
  for (const f of files) rmSync(join(dir, f));
  return files.length;
}

function removeRunProjectDir(cwd) {
  const dir = join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

function removeEmptySessionEnv(sessionId) {
  if (!/^[0-9a-f-]{36}$/.test(sessionId ?? "")) return false;
  try {
    rmdirSync(join(homedir(), ".claude", "session-env", sessionId)); // fails unless empty
    return true;
  } catch {
    return false;
  }
}

function hookCounts(file) {
  if (!existsSync(file)) return { allowed: 0, denied: 0, allowedBash: 0 };
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { allowed: lines.filter((l) => l.allow).length, denied: lines.filter((l) => !l.allow).length, allowedBash: lines.filter((l) => l.allow && l.tool === "Bash").length };
}

/** A hash per top-level key of ~/.claude.json, to name (never show) what a run changed there. */
function claudeJsonDigest() {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    return Object.fromEntries(Object.entries(config).map(([k, v]) => [k, createHash("sha1").update(JSON.stringify(v) ?? "").digest("hex")]));
  } catch {
    return {};
  }
}

/**
 * Top-level URLs the profile visited since `sinceMs`, from a copy of its
 * history database (the instance has no dev methods to ask).
 */
function visitedSince(sinceMs) {
  const profile = execFileSync(join(ROOT, "scripts", "zen-dev.sh"), [instance, "path"], { encoding: "utf8" }).trim().split("\n").pop();
  const copy = mkdtempSync(join(outDir, "tmp", "places-"));
  try {
    for (const f of ["places.sqlite", "places.sqlite-wal"]) if (existsSync(join(profile, f))) copyFileSync(join(profile, f), join(copy, f));
    const sql = `SELECT p.url FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id WHERE v.visit_date >= ${Math.floor(sinceMs) * 1000} ORDER BY v.visit_date;`;
    return execFileSync("/usr/bin/sqlite3", [join(copy, "places.sqlite"), sql], { encoding: "utf8", timeout: 30_000 }).split("\n").filter(Boolean);
  } catch {
    return [];
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function hostCounts(urls) {
  const counts = {};
  for (const u of urls) {
    let host;
    try {
      host = new URL(u).host || u.slice(0, 30);
    } catch {
      host = u.slice(0, 30);
    }
    counts[host] = (counts[host] ?? 0) + 1;
  }
  return counts;
}

/** Tool calls with their results, in order. */
function trajectory(events) {
  const steps = [];
  const byId = new Map();
  for (const e of events) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (e.type === "assistant" && block.type === "tool_use") {
        const input = block.input?.command ?? block.input?.skill ?? block.input?.file_path ?? JSON.stringify(block.input ?? {});
        const step = { id: block.id, tool: block.name, input: String(input), output: "", isError: false };
        byId.set(block.id, step);
        steps.push(step);
      } else if (e.type === "user" && block.type === "tool_result") {
        const step = byId.get(block.tool_use_id);
        const text = Array.isArray(block.content) ? block.content.map((c) => c.text ?? `[${c.type}]`).join("\n") : String(block.content ?? "");
        if (step) Object.assign(step, { output: text, isError: Boolean(block.is_error) });
      }
    }
  }
  return steps;
}

/** Token totals from the assistant events, for a run that ended without a result. */
function usageFromEvents(events) {
  const seen = new Map();
  for (const e of events) if (e.type === "assistant" && e.message?.id && e.message.usage) seen.set(e.message.id, e.message.usage);
  const total = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const u of seen.values()) for (const k of Object.keys(total)) total[k] += u[k] ?? 0;
  return total;
}

// Anything that could sign in, post, buy or submit, in the commands or the
// visited URLs. A flag is for a person to look at; search and filter forms
// are allowed.
const RISKY_COMMANDS = [
  ["sign-in", /\b(log ?in|sign ?in|sign ?up|register|password|passwd)\b/i],
  ["post or submit", /\b(submit|post|comment|reply|upvote|vote|fave|subscribe)\b/i],
  ["buy", /\b(checkout|add to cart|purchase|buy now|place order)\b/i],
  ["non-GET request", /method\s*:\s*["'](POST|PUT|PATCH|DELETE)/i],
];
const RISKY_URLS = /\/(login|signin|sign-in|signup|register|submit|vote|reply|comment|post|checkout|cart|account|users\/fxa)\b/i;
function safetyFlags(steps, visited) {
  const flags = [];
  for (const [i, step] of steps.entries()) {
    for (const [kind, re] of RISKY_COMMANDS) {
      const m = re.exec(step.input);
      if (m) flags.push({ step: i + 1, kind, match: step.input.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, " ") });
    }
  }
  for (const url of visited) if (RISKY_URLS.test(url)) flags.push({ kind: "visited URL", match: url.slice(0, 160) });
  return flags;
}

/** The judge sees no target's name. */
function blind(text) {
  return String(text)
    .replace(/ego[- ]?(browser|lite)/gi, "browser")
    .replace(/zenius/gi, "browser")
    .replace(/\b(ZEN|EGO)_(?=[A-Z])/g, "BROWSER_")
    .replaceAll(instance, "instance");
}

/** Grade a run's live items: a fixed prompt and model, against the run's own page reads. */
async function judgeRun(id, task, answer, steps, visited) {
  const log = steps
    .map((s, i) => `STEP ${i + 1} (${s.tool})\nINPUT:\n${blind(s.input).slice(0, 4000)}\nOUTPUT:\n${blind(s.output).slice(0, 30_000)}`)
    .join("\n\n")
    .slice(-250_000);
  const live = task.rubric.filter((r) => r.type === "live");
  const prompt = [
    "You grade one run of a browser agent on a live website. Judge only from the run's own page reads in the log below, not from what you know: the site may have changed since your training.",
    `TASK: ${task.prompt}`,
    "ITEMS. Each passes only if the final answer states it correctly, as the run's own page reads show it:",
    ...live.map((r) => `- ${r.id}: ${r.text}`),
    `FINAL ANSWER:\n${blind(answer)}`,
    `URLS THE BROWSER VISITED, IN ORDER:\n${visited.map(blind).join("\n")}`,
    `LOG:\n${log}`,
    'Reply with JSON only: {"items": [{"id": "<item id>", "pass": true|false, "why": "<one sentence that cites the step>"}]}',
  ].join("\n\n");
  const work = realpathSync(mkdtempSync(join(outDir, `judge-${id}-`)));
  mkdirSync(join(work, "tmp"));
  const out = await new Promise((resolveJudge) => {
    // The judge has no tools at all.
    const [file, judgeArgs] = claude(["-p", "--model", MODEL, ...(EFFORT ? ["--effort", EFFORT] : []), ...isolation(), "--tools", "", "--max-turns", "2", "--output-format", "json"]);
    const child = spawn(file, judgeArgs, { cwd: work, env: cleanEnv(join(work, "tmp")), stdio: ["pipe", "pipe", "pipe"] });
    let text = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    child.stdout.on("data", (c) => (text += c));
    child.on("close", () => {
      clearTimeout(timer);
      removeStaleSessionFiles(child.pid, work);
      resolveJudge(text);
    });
    child.stdin.end(prompt);
  });
  removeRunProjectDir(work);
  rmSync(work, { recursive: true, force: true });
  writeFileSync(join(outDir, `${id}.judge.json`), out);
  let reply = {};
  try {
    reply = JSON.parse(out);
    removeEmptySessionEnv(reply.session_id);
    return { costUsd: reply.total_cost_usd ?? null, items: JSON.parse(/\{[\s\S]*\}/.exec(reply.result ?? "")[0]).items ?? [] };
  } catch {
    return { costUsd: reply.total_cost_usd ?? null, items: [] };
  }
}

function markdown(s) {
  const secs = (v) => (v == null ? "–" : `${Math.round(v / 1000)} s`);
  const usd = (v) => (v == null ? "–" : `$${v.toFixed(2)}`);
  const k = (n) => `${((n ?? 0) / 1000).toFixed(1)}k`;
  const tok = (u) => (u ? `${k(u.input_tokens)} in, ${k(u.output_tokens)} out, ${k(u.cache_read_input_tokens)} cache read, ${k(u.cache_creation_input_tokens)} cache write` : "–");
  const lines = [
    `Claude Code ${s.claudeVersion}, ${s.model} at effort ${s.effort}; target ${s.target}; limits ${s.limits.turns} turns and ${s.limits.minutes} min.`,
    "",
    "| Task | Success | Rubric | Turns | Wall | Cost | Tokens | Stop | Denied | Safety flags | Left behind | Wiring |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of s.runs) {
    const rubric = r.items.map((i) => `${i.id} ${i.pass === null ? "?" : i.pass ? "✓" : "✗"}`).join(", ");
    lines.push(
      `| ${r.task} ${r.title} | ${r.success ? "yes" : "no"} | ${rubric} | ${r.turns ?? "–"} | ${secs(r.wallMs)} | ${usd(r.costUsd)} | ${tok(r.usage)} | ${r.stopReason} | ${r.permissionDenials.length} | ${r.safety.length} | ${r.leftoverSpaces.length} | ${r.wiring.pass ? "ok" : "CHECK"} |`,
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * zen-dev.sh copies the runtime into the profile at each start, so an
 * instance started before a merge runs the old code. A canary against it
 * would test that old code.
 */
function assertCurrentRuntime() {
  const digest = (dir) => {
    const h = createHash("sha256");
    for (const f of readdirSync(dir, { recursive: true }).map(String).sort()) {
      const path = join(dir, f);
      if (statSync(path).isFile()) h.update(`${f}\0`).update(readFileSync(path));
    }
    return h.digest("hex");
  };
  const chrome = join(homedir(), ".zenius-dev", "profiles", instance, "chrome");
  for (const d of ["JS", "resources"]) {
    const src = join(ROOT, "runtime", d);
    if (!existsSync(src)) continue;
    if (!existsSync(join(chrome, d)) || digest(src) !== digest(join(chrome, d))) {
      throw new Error(`${instance} runs another runtime than this checkout's (runtime/${d}). Restart it with: ZENIUS_DEV_METHODS=0 scripts/zen-dev.sh ${instance} restart`);
    }
  }
}

// Main, last: the functions above use module constants declared after them.
const results = [];
try {
  assertNoDevMethods();
  assertCurrentRuntime();
  if (mode === "smoke") await runSmoke();
  else if (mode === "canary") await runCanary();
  else {
    for (const id of taskIds) {
      if (!TASKS[id]) throw new Error(`no task ${id}`);
      const result = await runTask(id, TASKS[id]);
      results.push(result);
      writeSummary();
      // A run whose commands didn't all start its own launcher, or whose skill
      // wasn't its own, may have reached a zenius outside the sandbox: the
      // round stops there rather than go on uncontained.
      if (!result.wiring.pass) {
        throw new Error(`stopping the round: ${id}'s zenius wasn't the run's own (launcher: ${result.wiring.launcher}; skill: ${result.wiring.skill})`);
      }
    }
  }
} finally {
  for (const root of runRoots) rmSync(root, { recursive: true, force: true });
}
if (mode === "tasks") console.log(markdown(summary()));
