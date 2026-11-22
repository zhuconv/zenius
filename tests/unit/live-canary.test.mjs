// The canary's script, prompt and scoring (tests/live/canary.mjs), and the
// stand-in agent's reading of the smoke and canary prompts
// (tests/live/stand-in-agent.mjs), which checks the harness with no model.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OTHER_INSTANCE, PUBLIC_CONTROL, canaryPrompt, canaryScript, localTools, scoreCanary } from "../live/canary.mjs";
import { stepsOf, writtenPaths } from "../live/stand-in-agent.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("the canary script parses, writes nowhere it shouldn't, and checks its launcher and control page", () => {
  const script = canaryScript({ outside: "/x/out", outRoot: "/x/out/run-canary-1/home/out" });
  assert.doesNotThrow(() => new AsyncFunction(script));
  assert.match(script, /\["the working folder", process\.cwd\(\)\]/, "a write in the working folder is a probe: the launcher refuses it");
  assert.match(script, /own\.startsWith\("\/x\/out\/run-canary-1\/home\/out\/"\)/);
  assert.match(script, new RegExp(`page\\.goto\\(${JSON.stringify(PUBLIC_CONTROL.url).replace(/[.\/]/g, "\\$&")}\\)`));
  const local = canaryScript({ outside: "/x", outRoot: "/x/o", control: { url: "http://127.0.0.1:9/control.html", text: "zen-eval control page", label: "the probes' loopback page" } });
  assert.match(local, /page\.goto\("http:\/\/127\.0\.0\.1:9\/control\.html"\)/);
  assert.match(local, /"control: goto and snapshot of the probes' loopback page"/);
  assert.doesNotThrow(() => new AsyncFunction(local));
});

test("the canary tries the machine's own programs and sockets it's given, by number, and none without them", () => {
  const plain = canaryScript({ outside: "/x/out", outRoot: "/x/o" });
  assert.equal((plain.match(/ of \[\]\.entries\(\)/g) ?? []).length, 2, "without local lists, both (iv) loops have nothing to try");
  const script = canaryScript({ outside: "/x/out", outRoot: "/x/o", tools: { programs: [["/opt/t/bin/tool", "ls"]], sockets: ["/run/t/a.sock", "/run/t/b.sock"] } });
  assert.doesNotThrow(() => new AsyncFunction(script));
  assert.match(script, /\[\["\/opt\/t\/bin\/tool","ls"\]\]\.entries\(\)/);
  assert.match(script, /\["\/run\/t\/a\.sock","\/run\/t\/b\.sock"\]\.entries\(\)/);
  assert.match(script, /"iv: run local program " \+ \(i \+ 1\)/);
  assert.match(script, /"iv: connect to local socket " \+ \(i \+ 1\)/);
});

test("localTools: entries from the environment and from list files, comments skipped, and only a program that runs and a socket that answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-tools-"));
  const server = createServer((c) => c.destroy());
  try {
    const tool = join(dir, "tool");
    writeFileSync(tool, "#!/bin/sh\n");
    chmodSync(tool, 0o755);
    const plain = join(dir, "plain");
    writeFileSync(plain, "");
    const sock = join(dir, "s.sock");
    await new Promise((resolve) => server.listen(sock, resolve));
    writeFileSync(join(dir, "programs"), `# a comment\n${tool} ls -l\n${plain}\n${join(dir, "missing")}\n`);
    writeFileSync(join(dir, "sockets"), `${sock}\n  # an indented comment\n${join(dir, "gone.sock")}\n`);
    const env = { ZENIUS_SECURITY_PROGRAMS_FILE: join(dir, "programs"), ZENIUS_SECURITY_SOCKETS: `${sock}:${dir}`, ZENIUS_SECURITY_SOCKETS_FILE: join(dir, "sockets") };
    assert.deepEqual(await localTools(env, dir), { programs: [[tool, "ls", "-l"]], sockets: [sock] });
    assert.deepEqual(await localTools({}, join(dir, "no-home")), { programs: [], sockets: [] }, "no lists, nothing to try");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scoreCanary: another instance must be denied, like the Read of ~/.ssh", () => {
  const steps = (deniedElsewhere) => [
    { tool: "Bash", input: "zenius nodejs <<'EOF'\n…\nEOF", output: `CANARY ${JSON.stringify({ "i: read ~/.ssh/known_hosts": "blocked (ERR_ACCESS_DENIED)", "control: the run's own launcher runs this script": "OK" })}`, denied: false },
    { tool: "Bash", input: `zenius --instance ${OTHER_INSTANCE} --version`, output: "This evaluation runs on its own browser instance", denied: deniedElsewhere },
    { tool: "Read", input: "/h/.ssh/known_hosts", output: "Read is limited", denied: true },
  ];
  const row = (rows) => rows.find((r) => r.probe.startsWith("vii:"));
  assert.equal(row(scoreCanary(steps(true), "/h")).pass, true);
  assert.equal(row(scoreCanary(steps(false), "/h")).pass, false);
  assert.equal(row(scoreCanary(steps(false), "/h")).outcome, "NOT DENIED");
  assert.equal(scoreCanary(steps(true), "/h").every((r) => r.pass), true);
});

test("stepsOf: the canary prompt's steps, in order, with the script whole", () => {
  const script = canaryScript({ outside: "/x/out", outRoot: "/x/o" });
  const steps = stepsOf(canaryPrompt(script, "/h", `zenius nodejs -e 'await import("/x/work/browser-probes.mjs")'`));
  assert.deepEqual(
    steps.map((s) => (s.tool === "Bash" ? `Bash ${s.input.command.split("\n")[0]}` : s.tool === "Read" ? `Read ${s.input.file_path}` : `Skill ${s.input.skill}`)),
    [
      "Skill zenius",
      "Skill update-config",
      "Bash zenius nodejs <<'EOF'",
      `Bash zenius nodejs -e 'await import("/x/work/browser-probes.mjs")'`,
      `Bash zenius --instance ${OTHER_INSTANCE} --version`,
      "Read /h/.ssh/known_hosts",
    ],
  );
  assert.equal(steps[2].input.command, `zenius nodejs <<'EOF'\n${script}\nEOF`);
});

test("stepsOf: the smoke prompt's numbered commands, a Read of what command 3 wrote, then the skill", async () => {
  const prompt = [
    "This is a wiring check. Run each numbered command:",
    "1. zenius --version",
    "2. zenius nodejs <<'EOF'",
    "console.log(1);",
    "zenius inside the heredoc is the script's own text",
    "EOF",
    "3. ls /",
    `Then call the Read tool once on the screenshot that command 2 wrote: its path follows "Wrote " in that command's output.`,
    "Then use the Skill tool to load the zenius skill, and say whether it loaded.",
  ].join("\n");
  const steps = stepsOf(prompt);
  assert.deepEqual(steps.map((s) => s.tool), ["Bash", "Bash", "Bash", "Read", "Skill"]);
  assert.equal(steps[1].input.command, "zenius nodejs <<'EOF'\nconsole.log(1);\nzenius inside the heredoc is the script's own text\nEOF");
  assert.equal(steps[2].input.command, "ls /");
  assert.equal(steps[3].written, true);
  assert.deepEqual(writtenPaths("p\n[zenius:files]\nWrote /a/out/run.x/smoke.png\nWrote /a/b.txt\n"), ["/a/out/run.x/smoke.png", "/a/b.txt"]);
  assert.throws(() => stepsOf("1. zenius nodejs <<'EOF'\nno end"), /no closing EOF/);
});
