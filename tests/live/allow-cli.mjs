#!/usr/bin/env node
// PreToolUse hook for tests/live/run.mjs, passed in the run's --settings. It
// decides every tool call, so no rule of Claude Code's own decides for it:
// - Bash: allowed only when the command runs the target's CLI and nothing
//   else; every other command is denied. With ALLOW_CLI_LAUNCHER, an allowed
//   command runs that launcher by its path: the hook hands Claude Code the
//   command with its first word replaced (updatedInput, which Claude Code
//   2.1.329 reads). The Bash tool sources the user's shell snapshot, whose
//   PATH (from ~/.zshrc) can put another zenius first, such as the user's own
//   in ~/.local/bin once the daily install made it.
// - With ALLOW_CLI_INSTANCE, a command that names another instance with
//   --instance is denied. The sandboxed launcher reaches whichever instance a
//   command names, and ~/.zenius/run holds the user's own Zen's socket too.
// - Read: allowed only inside the run's folder (ALLOW_CLI_WORKDIR), the run's
//   temp home (ALLOW_CLI_READ_ROOT: the CLI copy and its Skill, the run's
//   TMPDIR and the launcher's output folders), or the folder where Claude
//   Code keeps this run's oversized tool outputs; denied elsewhere.
// - Skill: allowed only for the run's own skill.
// - Any other tool: denied.
// Why a hook: Claude Code's prefix rule Bash(zenius:*) approved some heredoc
// commands and not others with the same shape (2.1.329), and the agents read
// untrusted pages, so the policy must be exact (zen-manager, 2026-11-20).
// The CLI itself runs inside the sandboxed launcher (install-cli.sh --sandbox).
//
//   allow-cli.mjs <cli> <skill>    (the hook's JSON on stdin)
//
// The run's folder comes from ALLOW_CLI_WORKDIR. A Bash command passes when
// it is `<cli> ARG...`, or `<cli> ARG... <<'DELIM'` with the closing DELIM as
// its last line (a quoted delimiter keeps the body literal), where ARG is a
// bare word, a '...' string, or a "..." string with no $, backtick or
// backslash. ALLOW_CLI_LOG names a file that gets one JSON line per decision.
import { accessSync, appendFileSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ARG = String.raw`(?:[A-Za-z0-9_./:=@,+%-]+|'[^']*'|"[^"$\x60\\]*")`;

/**
 * The command's arguments, unquoted, when it runs only the CLI; otherwise
 * null. A heredoc's body is stdin, not arguments.
 * @param {string} cli @param {string} command
 * @returns {{ args: string[] } | null}
 */
export function parseCli(cli, command) {
  const name = cli.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const text = command.replace(/\s+$/, "");
  let head;
  const heredoc = new RegExp(String.raw`^${name}((?:[ \t]+${ARG})*)[ \t]+<<(-?)[ \t]*(['"])([A-Za-z_][A-Za-z0-9_]*)\3[ \t]*\n`).exec(text);
  if (heredoc) {
    const [, words, dash, , delim] = heredoc;
    const lines = text.slice(heredoc[0].length).split("\n");
    const ends = (line) => (dash ? line.replace(/^\t+/, "") : line) === delim;
    // The body is every line before the first closing line; that closing line must be the last.
    if (lines.findIndex(ends) !== lines.length - 1) return null;
    head = words;
  } else {
    const plain = new RegExp(String.raw`^${name}((?:[ \t]+${ARG})*)$`).exec(text);
    if (!plain) return null;
    head = plain[1];
  }
  // Each word is one ARG, whitespace apart: the grammar admits no other shape.
  const args = (head.match(new RegExp(ARG, "g")) ?? []).map((word) => (/^['"]/.test(word) ? word.slice(1, -1) : word));
  return { args };
}

/** @param {string} cli @param {string} command */
export function runsOnlyCli(cli, command) {
  return parseCli(cli, command) !== null;
}

/**
 * Every instance the arguments name, as the launcher reads them: `--instance
 * NAME` (the next argument, whatever it is) and `--instance=NAME`. A trailing
 * `--instance` names "".
 * @param {string[]} args
 */
export function instancesNamed(args) {
  const names = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--instance") names.push(args[++i] ?? "");
    else if (args[i].startsWith("--instance=")) names.push(args[i].slice("--instance=".length));
  }
  return names;
}

const shellQuote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

function isRunnable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The folder where Claude Code keeps a working folder's oversized tool outputs. */
export function toolResultsRoot(workdir, home = homedir()) {
  return join(home, ".claude", "projects", workdir.replace(/[^A-Za-z0-9]/g, "-"));
}

/** @param {string} path @param {string} workdir @param {string} [home] @param {string|null} [readRoot] */
export function readAllowed(path, workdir, home = homedir(), readRoot = null) {
  let real;
  try {
    real = realpathSync(path);
  } catch {
    return false; // nothing there to read, or not ours to look at
  }
  const inside = (root) => real === root || real.startsWith(root + "/");
  const insideReal = (root) => {
    try {
      return inside(realpathSync(root));
    } catch {
      return false; // a root that isn't there grants nothing
    }
  };
  const results = toolResultsRoot(workdir, home);
  return insideReal(workdir) || (readRoot !== null && insideReal(readRoot)) || (inside(results) && real.includes("/tool-results/"));
}

/**
 * @param {{ tool_name?: string, tool_input?: Record<string, unknown> }} input
 * @param {{ cli: string, skill: string, workdir: string, readRoot?: string|null, launcher?: string|null, instance?: string|null }} o
 * @returns {{ allow: boolean, reason: string, updatedInput?: Record<string, unknown> }}
 */
export function decide(input, { cli, skill, workdir, readRoot = null, launcher = null, instance = null }) {
  const tool = input.tool_name;
  const args = input.tool_input ?? {};
  if (tool === "Bash") {
    const command = String(args.command ?? "");
    const parsed = parseCli(cli, command);
    if (!parsed) return { allow: false, reason: `Only the ${cli} CLI may run in this evaluation, as one command (heredoc allowed); nothing else.` };
    if (instance && instancesNamed(parsed.args).some((name) => name !== instance)) {
      return { allow: false, reason: `This evaluation runs on its own browser instance: a command can't name another with --instance.` };
    }
    if (!launcher) return { allow: true, reason: `runs only ${cli}` };
    if (!isRunnable(launcher)) return { allow: false, reason: `The run's ${cli} launcher is missing, so nothing may run.` };
    // Only the first word changes: parseCli matched the command from its start.
    return { allow: true, reason: `runs only ${cli}, as the run's launcher`, updatedInput: { ...args, command: shellQuote(launcher) + command.slice(cli.length) } };
  }
  if (tool === "Read") {
    return readAllowed(String(args.file_path ?? ""), workdir, homedir(), readRoot)
      ? { allow: true, reason: "inside the run's folder" }
      : { allow: false, reason: "Read is limited to this run's working folder in this evaluation." };
  }
  if (tool === "Skill") {
    return String(args.skill ?? "") === skill
      ? { allow: true, reason: `the run's skill` }
      : { allow: false, reason: `Only the ${skill} skill is available in this evaluation.` };
  }
  return { allow: false, reason: `${tool} is not available in this evaluation.` };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [cli, skill] = process.argv.slice(2);
  const env = process.env;
  const workdir = env.ALLOW_CLI_WORKDIR;
  const input = JSON.parse(readFileSync(0, "utf8"));
  // Fail closed: without the run's folder, nothing is allowed.
  const verdict =
    workdir && cli && skill
      ? decide(input, { cli, skill, workdir, readRoot: env.ALLOW_CLI_READ_ROOT || null, launcher: env.ALLOW_CLI_LAUNCHER || null, instance: env.ALLOW_CLI_INSTANCE || null })
      : { allow: false, reason: "the harness did not set the run's folder" };
  if (env.ALLOW_CLI_LOG) {
    const detail = input.tool_input?.command ?? input.tool_input?.file_path ?? input.tool_input?.skill ?? "";
    appendFileSync(
      env.ALLOW_CLI_LOG,
      JSON.stringify({ at: new Date().toISOString(), tool: input.tool_name, allow: verdict.allow, ...(verdict.updatedInput && { as: "launcher" }), detail: String(detail).slice(0, 300) }) + "\n",
    );
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict.allow ? "allow" : "deny",
        permissionDecisionReason: verdict.reason,
        ...(verdict.updatedInput && { updatedInput: verdict.updatedInput }),
      },
    }),
  );
}
