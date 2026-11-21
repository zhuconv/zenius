#!/usr/bin/env node
// A scripted stand-in for Claude Code, to check tests/live/run.mjs's wiring
// with no model call: run.mjs --smoke (or --canary) --claude
// tests/live/stand-in-agent.mjs. It follows the prompt's steps as an obedient
// agent would, through the same machinery Claude Code gives a run:
// - a system/init event that lists the working folder's skills, as
//   --setting-sources project does (.claude/skills only);
// - each step as one tool call, which the PreToolUse hooks from --settings
//   decide; under --permission-mode dontAsk, no decision is a denial. An
//   allowed Bash command runs in bash in the working folder, as the hook's
//   updatedInput has it (Claude Code 2.1.329 replaces the input with it);
// - every Bash command finds a decoy zenius first on PATH, as the user's shell
//   snapshot can put one there (~/.local/bin/zenius once the daily install
//   made it). Only a command the hook pointed at the run's launcher misses it;
// - a skill's load prints "Base directory for this skill: <folder>" and its
//   SKILL.md, as Claude Code 2.1.329 words it;
// - a result event with the denials, where run.mjs reads them.
// It reads these steps from the prompt, in order:
// - a command: a line (after any "N. ") that starts with `zenius` or `ls`,
//   with a heredoc's body up to its closing line;
// - "load the <name> skill", "with the skill <name>": a Skill call;
// - "Read tool once on /path": a Read; "Read tool once on the screenshot ...
//   wrote": a Read of the first path after "Wrote " in the latest output.
//
//   stand-in-agent.mjs --version
//   stand-in-agent.mjs -p <prompt> --settings <json> [run.mjs's other flags]
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STAND_IN_VERSION = "2.1.329 (zenius stand-in for Claude Code: no model)";
// No quote marks: the decoy echoes it in single quotes.
export const DECOY_TEXT = "stand-in: the decoy zenius first on PATH ran instead of the launcher";

/** The prompt's steps, in order. */
export function stepsOf(prompt) {
  const lines = prompt.split("\n");
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const body = line.replace(/^\d+\.\s+/, "");
    if (/^(zenius|ls)(\s|$)/.test(body)) {
      let command = body;
      const heredoc = /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*$/.exec(body);
      if (heredoc) {
        const end = lines.findIndex((l, j) => j > i && l === heredoc[2]);
        if (end < 0) throw new Error(`no closing ${heredoc[2]} line for: ${body}`);
        command = lines.slice(i, end + 1).join("\n").replace(/^\d+\.\s+/, "");
        i = end;
      }
      steps.push({ tool: "Bash", input: { command, description: "Run the prompt's command" } });
      continue;
    }
    for (const m of line.matchAll(/load the (\S+) skill|with the skill ([A-Za-z0-9:_-]+)/g)) steps.push({ tool: "Skill", input: { skill: m[1] ?? m[2] } });
    const read = /Read tool once on (\/\S+?)(?=[.,;]?(?:\s|$))/.exec(line);
    if (read) steps.push({ tool: "Read", input: { file_path: read[1] } });
    else if (/Read tool once on the (?:screenshot|file)\b.*\bwrote\b/i.test(line)) steps.push({ tool: "Read", written: true });
  }
  return steps;
}

/** The paths an output lists after "Wrote ", as the SDK reports the files a script wrote. */
export function writtenPaths(output) {
  return [...output.matchAll(/^Wrote (\/.+)$/gm)].map((m) => m[1]);
}

function main(argv) {
  if (argv.includes("--version")) {
    console.log(STAND_IN_VERSION);
    return;
  }
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const session = randomUUID();
  const emit = (event) => process.stdout.write(JSON.stringify({ ...event, session_id: session }) + "\n");
  // The judge (run.mjs --judge) sends its prompt on stdin and wants one JSON reply.
  if (flag("--output-format") === "json") {
    readFileSync(0, "utf8");
    console.log(JSON.stringify({ type: "result", result: '{"items": []}', total_cost_usd: 0, session_id: session }));
    return;
  }
  const prompt = flag("-p") ?? "";
  const settings = JSON.parse(flag("--settings") ?? "{}");
  const hooks = (settings.hooks?.PreToolUse ?? []).flatMap((m) => (m.hooks ?? []).map((h) => ({ matcher: m.matcher ?? "*", command: h.command })));
  const mode = flag("--permission-mode") ?? "default";
  const cwd = process.cwd();
  const tmp = process.env.TMPDIR;
  if (!tmp) throw new Error("the stand-in needs TMPDIR, as run.mjs sets it");
  const started = Date.now();

  const decoyDir = join(tmp, "stand-in-decoy");
  mkdirSync(decoyDir, { recursive: true });
  writeFileSync(join(decoyDir, "zenius"), `#!/bin/sh\necho '${DECOY_TEXT}' >&2\nexit 97\n`);
  chmodSync(join(decoyDir, "zenius"), 0o755);

  const skillsDir = join(cwd, ".claude", "skills");
  const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter((name) => existsSync(join(skillsDir, name, "SKILL.md"))) : [];
  emit({
    type: "system",
    subtype: "init",
    cwd,
    tools: (flag("--tools") ?? "").split(",").filter(Boolean),
    mcp_servers: [],
    model: flag("--model") ?? null,
    permissionMode: mode,
    slash_commands: skills,
    skills,
    plugins: [],
    claude_code_version: STAND_IN_VERSION,
  });

  /** The hooks' verdict, as Claude Code takes it: the first decision wins; none, under dontAsk, denies. */
  const decide = (tool_name, tool_input, tool_use_id) => {
    for (const hook of hooks) {
      if (hook.matcher !== "*" && !new RegExp(`^(?:${hook.matcher})$`).test(tool_name)) continue;
      const r = spawnSync("/bin/sh", ["-c", hook.command], {
        cwd,
        env: process.env,
        input: JSON.stringify({ session_id: session, transcript_path: null, cwd, permission_mode: mode, hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id }),
        encoding: "utf8",
        timeout: 60_000,
      });
      let out = {};
      try {
        out = JSON.parse(r.stdout || "{}");
      } catch {}
      const h = out.hookSpecificOutput ?? {};
      if (h.permissionDecision === "deny") return { allow: false, reason: h.permissionDecisionReason ?? "denied by a hook" };
      if (h.permissionDecision === "allow") return { allow: true, updatedInput: h.updatedInput };
      if (r.status === 2) return { allow: false, reason: (r.stderr ?? "").trim() || "a hook blocked it" };
    }
    return mode === "dontAsk" ? { allow: false, reason: `Permission to use ${tool_name} has been denied: no hook allowed it, and dontAsk asks no one.` } : { allow: true };
  };

  const denials = [];
  const outputs = [];
  let latestWritten = [];
  let turn = 0;
  for (const step of stepsOf(prompt)) {
    turn += 1;
    const id = `toolu_stand_in_${turn}`;
    const input = step.written ? { file_path: latestWritten[0] ?? "(no path after Wrote in any output)" } : step.input;
    emit({ type: "assistant", message: { id: `msg_stand_in_${turn}`, role: "assistant", content: [{ type: "tool_use", id, name: step.tool, input }] }, parent_tool_use_id: null });
    const result = (content, is_error = false) =>
      emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: content }], is_error }] }, parent_tool_use_id: null });
    const verdict = decide(step.tool, input, id);
    if (!verdict.allow) {
      denials.push({ tool_name: step.tool, tool_use_id: id, tool_input: input });
      result(verdict.reason, true);
      continue;
    }
    const ran = verdict.updatedInput ?? input;
    if (step.tool === "Bash") {
      const r = spawnSync("/bin/bash", ["-c", String(ran.command)], {
        cwd,
        env: { ...process.env, PATH: `${decoyDir}:${process.env.PATH ?? ""}`, CLAUDECODE: "1" },
        encoding: "utf8",
        timeout: Number(ran.timeout ?? 600_000),
        maxBuffer: 64 * 1024 * 1024,
      });
      const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd() + (r.status === 0 ? "" : `\n(exit ${r.status ?? r.signal})`);
      outputs.push(text);
      if (writtenPaths(text).length) latestWritten = writtenPaths(text);
      result(text, r.status !== 0);
    } else if (step.tool === "Read") {
      try {
        const file = String(ran.file_path);
        const bytes = readFileSync(file);
        result(bytes.includes(0) ? `[binary file, ${statSync(file).size} bytes]` : bytes.toString("utf8").slice(0, 100_000));
      } catch (error) {
        result(`could not read it: ${error.code ?? error.message}`, true);
      }
    } else if (step.tool === "Skill") {
      const dir = join(skillsDir, String(ran.skill));
      if (!existsSync(join(dir, "SKILL.md"))) {
        result(`Unknown skill: ${ran.skill}`, true);
        continue;
      }
      result(`Launching skill: ${ran.skill}`);
      emit({ type: "user", message: { role: "user", content: [{ type: "text", text: `Base directory for this skill: ${dir}\n\n${readFileSync(join(dir, "SKILL.md"), "utf8")}` }] }, isMeta: true, parent_tool_use_id: null });
    }
  }
  const lines = outputs.flatMap((text) => text.split("\n").filter((l) => /^(CANARY|PROBES) \{/.test(l)));
  const answer = [...lines, `Denied: ${denials.length ? denials.map((d) => d.tool_input.command ?? d.tool_input.file_path ?? d.tool_input.skill).join(" | ") : "none"}.`].join("\n");
  emit({ type: "assistant", message: { id: `msg_stand_in_${turn + 1}`, role: "assistant", content: [{ type: "text", text: answer }] }, parent_tool_use_id: null });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: turn + 1,
    duration_ms: Date.now() - started,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    permission_denials: denials,
    result: answer,
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main(process.argv.slice(2));
