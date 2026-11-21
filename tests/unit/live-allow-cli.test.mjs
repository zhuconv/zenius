// tests/live/allow-cli.mjs decides every tool call of rubric C's live agents,
// which read untrusted pages: only the target's CLI may run, Read stays in the
// run's folder, and only the run's skill loads.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decide, runsOnlyCli, toolResultsRoot } from "../live/allow-cli.mjs";

test("Bash: only the CLI, plain or with a literal heredoc", () => {
  const allowed = [
    "zenius skill",
    "zenius --version",
    "zenius help page.click",
    "zenius nodejs <<'EOF'\nconsole.log(\"a\");\nEOF",
    'zenius nodejs <<"EOF"\nconst x = `${1}` + $(y);\nEOF\n',
    "zenius nodejs <<-'END'\n\tconsole.log(1)\n\tEND",
    "zenius nodejs -e 'console.log(\"x\")'",
    "zenius nodejs -e 'const t = await taskSpace(2);\nconsole.log(t.spaceId)'",
  ];
  const refused = [
    'zenius skill > "${TMPDIR:-/tmp}/zenius-skill.md"; wc -l x',
    "zenius x; ls",
    "zenius $(ls)",
    'zenius "a$b"',
    "zenius `id`",
    "zenius nodejs <<EOF\n$(rm -rf /tmp/x)\nEOF",
    "zenius nodejs <<'EOF'\nok\nEOF\nrm -rf /tmp/x",
    "zenius nodejs <<'EOF' | head\nok\nEOF",
    "cd /tmp && zenius skill",
    "zenius skill | head",
    "ego-browser nodejs",
    "zenius2 skill",
    "zenius nodejs -e 'a' && ls",
    "zenius nodejs <<'EOF'\nEOF\nls\nEOF",
    "zenius nodejs <<'EOF'\nconsole.log(1)\nEOF2",
    "zenius *",
    "zenius ~/x",
    "zenius a\nls",
    "FOO=1 zenius skill",
    "ls /",
    "grep -r x ~/.claude",
  ];
  for (const c of allowed) assert.ok(runsOnlyCli("zenius", c), `should allow: ${JSON.stringify(c)}`);
  for (const c of refused) assert.ok(!runsOnlyCli("zenius", c), `should refuse: ${JSON.stringify(c)}`);
  assert.ok(runsOnlyCli("ego-browser", "ego-browser nodejs <<'EOF'\n1\nEOF"));
});

test("decide: Bash outside the CLI, other tools and other skills are denied, never passed on", () => {
  const work = mkdtempSync(join(tmpdir(), "allow-cli-"));
  try {
    const o = { cli: "zenius", skill: "zenius", workdir: work };
    assert.equal(decide({ tool_name: "Bash", tool_input: { command: "zenius skill" } }, o).allow, true);
    assert.equal(decide({ tool_name: "Bash", tool_input: { command: "curl https://example.com" } }, o).allow, false);
    assert.equal(decide({ tool_name: "Skill", tool_input: { skill: "zenius" } }, o).allow, true);
    assert.equal(decide({ tool_name: "Skill", tool_input: { skill: "update-config" } }, o).allow, false);
    assert.equal(decide({ tool_name: "Write", tool_input: { file_path: join(work, "x") } }, o).allow, false);
    assert.equal(decide({ tool_name: "WebFetch", tool_input: { url: "https://example.com" } }, o).allow, false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("decide: Read stays in the run's folder and its own tool-results, symlinks resolved", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "allow-cli-")));
  const work = join(root, "work");
  const home = join(root, "home");
  const results = join(toolResultsRoot(work, home), "session", "tool-results");
  mkdirSync(join(work, "tmp"), { recursive: true });
  mkdirSync(results, { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(work, "tmp", "shot.png"), "x");
  writeFileSync(join(results, "out.txt"), "x");
  writeFileSync(join(toolResultsRoot(work, home), "other.txt"), "x");
  writeFileSync(join(home, ".ssh", "known_hosts"), "x");
  symlinkSync(join(home, ".ssh", "known_hosts"), join(work, "link"));
  try {
    const read = (file_path) => decide({ tool_name: "Read", tool_input: { file_path } }, { cli: "zenius", skill: "zenius", workdir: work });
    assert.equal(read(join(work, "tmp", "shot.png")).allow, true);
    assert.equal(read(join(home, ".ssh", "known_hosts")).allow, false);
    assert.equal(read(join(work, "link")).allow, false, "a symlink out of the run's folder");
    assert.equal(read(join(work, "..", "home", ".ssh", "known_hosts")).allow, false);
    assert.equal(read(join(work, "missing.txt")).allow, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readAllowed: the run's own tool-results folder, nothing else under it", async () => {
  const { readAllowed } = await import("../live/allow-cli.mjs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "allow-cli-")));
  const work = join(root, "work");
  const home = join(root, "home");
  const project = toolResultsRoot(work, home);
  mkdirSync(join(work), { recursive: true });
  mkdirSync(join(project, "s1", "tool-results"), { recursive: true });
  mkdirSync(join(toolResultsRoot(join(root, "other"), home), "s2", "tool-results"), { recursive: true });
  writeFileSync(join(project, "s1", "tool-results", "a.txt"), "x");
  writeFileSync(join(project, "s1", "transcript.jsonl"), "x");
  writeFileSync(join(toolResultsRoot(join(root, "other"), home), "s2", "tool-results", "b.txt"), "x");
  try {
    assert.equal(readAllowed(join(project, "s1", "tool-results", "a.txt"), work, home), true);
    assert.equal(readAllowed(join(project, "s1", "transcript.jsonl"), work, home), false);
    assert.equal(readAllowed(join(toolResultsRoot(join(root, "other"), home), "s2", "tool-results", "b.txt"), work, home), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decide: an allowed command runs the run's launcher by its path, the rest of it and the other fields kept", async () => {
  const { chmodSync } = await import("node:fs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "allow-cli-")));
  const launcher = join(root, "it's home", "bin", "zenius");
  mkdirSync(join(root, "it's home", "bin"), { recursive: true });
  writeFileSync(launcher, "#!/bin/sh\n");
  chmodSync(launcher, 0o755);
  const o = { cli: "zenius", skill: "zenius", workdir: root, launcher };
  const quoted = `'${launcher.replaceAll("'", `'\\''`)}'`;
  try {
    const bash = (command, extra = {}) => decide({ tool_name: "Bash", tool_input: { command, ...extra } }, o);
    const plain = bash("zenius skill", { description: "Read the guide", timeout: 60000 });
    assert.equal(plain.allow, true);
    assert.deepEqual(plain.updatedInput, { command: `${quoted} skill`, description: "Read the guide", timeout: 60000 });
    const heredoc = "zenius nodejs <<'EOF'\nconsole.log(\"zenius x\");\nEOF";
    assert.equal(bash(heredoc).updatedInput.command, `${quoted} nodejs <<'EOF'\nconsole.log("zenius x");\nEOF`);
    assert.equal(bash("ls /").updatedInput, undefined, "a denied command is passed on unchanged");
    rmSync(launcher);
    const gone = bash("zenius skill");
    assert.equal(gone.allow, false, "a missing launcher allows nothing");
    assert.match(gone.reason, /launcher is missing/);
    // Without a launcher (another target), allowed commands run as typed.
    assert.equal(decide({ tool_name: "Bash", tool_input: { command: "zenius skill" } }, { ...o, launcher: null }).updatedInput, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decide: --instance may name only the run's instance, in any of the launcher's spellings", () => {
  const work = mkdtempSync(join(tmpdir(), "allow-cli-"));
  try {
    const o = { cli: "zenius", skill: "zenius", workdir: work, instance: "zen-eval-live" };
    const allow = (command) => decide({ tool_name: "Bash", tool_input: { command } }, o).allow;
    assert.equal(allow("zenius --instance zen-eval-live nodejs <<'EOF'\n1\nEOF"), true);
    assert.equal(allow("zenius --instance=zen-eval-live skill"), true);
    assert.equal(allow("zenius nodejs -e 'console.log(\"--instance default\")'"), true, "a script's own text names no instance");
    for (const command of [
      "zenius --instance default nodejs <<'EOF'\n1\nEOF",
      "zenius --instance=default --version",
      "zenius '--instance' default skill",
      'zenius "--instance=default" skill',
      "zenius skill --instance default",
      "zenius --instance zen-eval-live --instance default skill",
      "zenius --instance",
      "zenius --instance --instance skill",
    ]) {
      const verdict = decide({ tool_name: "Bash", tool_input: { command } }, o);
      assert.equal(verdict.allow, false, `should deny: ${JSON.stringify(command)}`);
      assert.match(verdict.reason, /its own browser instance/);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("parseCli: the unquoted arguments before a heredoc, or null", async () => {
  const { parseCli, instancesNamed } = await import("../live/allow-cli.mjs");
  assert.deepEqual(parseCli("zenius", "zenius nodejs -e 'a b' \"c\" <<'EOF'\nzenius x\nEOF"), { args: ["nodejs", "-e", "a b", "c"] });
  assert.deepEqual(parseCli("zenius", "zenius"), { args: [] });
  assert.equal(parseCli("zenius", "zenius skill; ls"), null);
  assert.deepEqual(instancesNamed(["--instance", "a", "nodejs", "--instance=b", "--instance"]), ["a", "b", ""]);
});

test("decide: Read in the run's temp home too, through its Skill link, never out of it", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "allow-cli-")));
  const run = join(root, "run");
  const work = join(run, "work");
  const skillCopy = join(run, "home", "cli", "skill", "zenius");
  mkdirSync(join(work, ".claude", "skills"), { recursive: true });
  mkdirSync(join(skillCopy, "references"), { recursive: true });
  mkdirSync(join(run, "home", "out", "work-1", "run.a"), { recursive: true });
  mkdirSync(join(root, "elsewhere"));
  writeFileSync(join(skillCopy, "references", "install.md"), "x");
  writeFileSync(join(run, "home", "out", "work-1", "run.a", "shot.png"), "x");
  writeFileSync(join(root, "elsewhere", "secret.txt"), "x");
  symlinkSync(skillCopy, join(work, ".claude", "skills", "zenius"));
  symlinkSync(join(root, "elsewhere", "secret.txt"), join(run, "home", "out", "link.txt"));
  try {
    const read = (file_path, readRoot) => decide({ tool_name: "Read", tool_input: { file_path } }, { cli: "zenius", skill: "zenius", workdir: work, readRoot }).allow;
    assert.equal(read(join(work, ".claude", "skills", "zenius", "references", "install.md"), run), true);
    assert.equal(read(join(run, "home", "out", "work-1", "run.a", "shot.png"), run), true);
    assert.equal(read(join(run, "home", "out", "work-1", "run.a", "shot.png"), null), false, "without a read root, only the working folder");
    assert.equal(read(join(run, "home", "out", "link.txt"), run), false, "a symlink out of the temp home");
    assert.equal(read(join(root, "elsewhere", "secret.txt"), run), false);
    assert.equal(read(join(run, "home", "out", "work-1", "run.a", "shot.png"), join(root, "missing")), false, "a missing read root grants nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the hook, as Claude Code runs it: updatedInput for an allowed command, a plain deny for the rest", async () => {
  const { execFileSync } = await import("node:child_process");
  const { chmodSync, readFileSync } = await import("node:fs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "allow-cli-")));
  const launcher = join(root, "bin", "zenius");
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "work"));
  writeFileSync(launcher, "#!/bin/sh\n");
  chmodSync(launcher, 0o755);
  const hook = new URL("../live/allow-cli.mjs", import.meta.url).pathname;
  const env = { PATH: process.env.PATH, ALLOW_CLI_WORKDIR: join(root, "work"), ALLOW_CLI_LAUNCHER: launcher, ALLOW_CLI_INSTANCE: "zen-eval-live", ALLOW_CLI_LOG: join(root, "hook.jsonl") };
  const run = (tool_name, tool_input) =>
    JSON.parse(execFileSync(process.execPath, [hook, "zenius", "zenius"], { env, input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }), encoding: "utf8" })).hookSpecificOutput;
  try {
    const allowed = run("Bash", { command: "zenius --version", description: "x" });
    assert.deepEqual(allowed, {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "runs only zenius, as the run's launcher",
      updatedInput: { command: `'${launcher}' --version`, description: "x" },
    });
    const denied = run("Bash", { command: "zenius --instance default --version" });
    assert.equal(denied.permissionDecision, "deny");
    assert.equal("updatedInput" in denied, false);
    assert.deepEqual(
      readFileSync(join(root, "hook.jsonl"), "utf8").trim().split("\n").map((line) => { const { at, ...rest } = JSON.parse(line); return rest; }),
      [
        { tool: "Bash", allow: true, as: "launcher", detail: "zenius --version" },
        { tool: "Bash", allow: false, detail: "zenius --instance default --version" },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
